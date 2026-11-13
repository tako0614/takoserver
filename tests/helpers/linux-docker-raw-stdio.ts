import { EventEmitter } from "node:events";
import { isJsonObject } from "../../src/json.ts";
import type { JsonObject } from "../../src/ports.ts";

// Test-side raw helper/daemon state only. No owner, runtime, verification or
// accepted-execution object enters this model. Importing it registers nothing.
const NETWORK_ID = "b".repeat(64);
const NONE_ID = "c".repeat(64);
const BRIDGE = {
  name: "br-synthetic",
  ifindex: 7,
  mac: "02:42:ac:16:00:01",
  addresses: ["172.22.0.1"],
};
const match = (left: unknown, right: unknown, op = "==") => ({ match: { op, left, right } });
const meta = (key: string) => ({ meta: { key } });
const payload = (protocol: string, field: string) => ({ payload: { protocol, field } });

// A deliberately bounded nft-text -> raw nft JSON model, rather than a copy of
// a compiler's private expected objects. Unknown syntax fails the raw command.
function nftJson(script: string) {
  const objects: unknown[] = [];
  let table = "",
    chain = "";
  for (const line of script.trim().split("\n")) {
    const tokens = line.match(/"[^"]*"|[{},]|[^\s{},]+/gu) ?? [];
    const shift = () => {
      const next = tokens.shift();
      if (next === undefined) throw new Error("raw nft token missing");
      return next.replace(/^"|"$/gu, "");
    };
    const scalar = (): unknown => {
      const token = shift();
      if (/^[0-9]+$/u.test(token)) return Number(token);
      if (token.includes("/")) {
        const [addr, bits] = token.split("/");
        const len = Number(bits);
        return len === (addr?.includes(":") ? 128 : 32) ? addr : { prefix: { addr, len } };
      }
      return token;
    };
    const value = (): unknown => {
      if (tokens[0] !== "{") return scalar();
      shift();
      const set: unknown[] = [];
      while (tokens.at(0) !== "}") {
        set.push(scalar());
        if (tokens.at(0) === ",") shift();
      }
      shift();
      return { set };
    };
    if (tokens[0] === "create" || line === "}") continue;
    if (tokens[0] === "table") {
      shift();
      if (shift() !== "inet") throw new Error("raw nft family unavailable");
      table = shift();
      objects.push({ table: { family: "inet", name: table } });
      continue;
    }
    const common = { family: "inet", table };
    if (tokens[0] === "counter" && tokens[1] !== "name") {
      shift();
      objects.push({ counter: { ...common, name: shift(), packets: 0, bytes: 0 } });
      continue;
    }
    if (tokens[0] === "quota" && tokens[1] !== "name") {
      shift();
      const name = shift();
      shift(); // {
      if (shift() !== "over") throw new Error("raw nft quota unavailable");
      objects.push({ quota: { ...common, name, bytes: Number(shift()), inv: true, used: 0 } });
      continue;
    }
    if (tokens[0] === "chain") {
      shift();
      chain = shift();
      const hook = line.match(/type filter hook (\w+) priority (-?\d+); policy (\w+);/u);
      objects.push({
        chain: {
          ...common,
          name: chain,
          ...(hook
            ? { type: "filter", hook: hook[1], prio: Number(hook[2]), policy: hook[3] }
            : {}),
        },
      });
      continue;
    }
    const expr: unknown[] = [];
    while (tokens[0] !== "comment") {
      const token = shift();
      if (token === "meta") {
        const key = shift(),
          right = value();
        // nft removes the redundant TCP protocol dependency when a TCP payload
        // expression already selects it, as in these compiler-emitted rules.
        if (key !== "l4proto") expr.push(match(meta(key), right));
      } else if (token === "oifname" || token === "iifname") {
        expr.push(match(meta(token), value()));
      } else if (["ip", "ip6", "tcp", "ether"].includes(token)) {
        expr.push(match(payload(token, shift()), value()));
      } else if (token === "ct") {
        const key = shift();
        if (key === "count") {
          if (shift() !== "over") throw new Error("raw nft count unavailable");
          expr.push({ "ct count": { val: Number(shift()), inv: true } });
        } else if (tokens[0] === "set") {
          shift();
          expr.push({ mangle: { key: { ct: { key } }, value: value() } });
        } else expr.push(match({ ct: { key } }, value(), key === "state" ? "in" : "=="));
      } else if (token === "counter" || token === "quota") {
        if (shift() !== "name") throw new Error("raw nft named object unavailable");
        expr.push({ [token]: shift() });
      } else if (token === "accept" || token === "drop") expr.push({ [token]: null });
      else if (token === "jump") expr.push({ jump: { target: shift() } });
      else throw new Error(`raw nft syntax unavailable: ${token}`);
    }
    shift();
    const comment = shift();
    if (tokens.length) throw new Error("raw nft trailing syntax");
    objects.push({ rule: { ...common, chain, expr, comment } });
  }
  return { nftables: objects };
}

function bridgeJson(table: string) {
  const common = { family: "bridge", table: `${table}_bridge` };
  const objects: unknown[] = [
    { table: { family: "bridge", name: common.table } },
    { set: { ...common, name: "disabled", type: "ifname", elem: [] } },
    ...["killed", "bridge_denied"].map((name) => ({
      counter: { ...common, name, packets: 0, bytes: 0 },
    })),
    ...["prerouting", "input", "forward", "output"].map((hook) => ({
      chain: { ...common, name: hook, type: "filter", hook, prio: -210, policy: "accept" },
    })),
  ];
  let number = 0;
  for (const chain of ["prerouting", "input", "forward", "output"]) {
    const rule = (expr: unknown[]) =>
      objects.push({ rule: { ...common, chain, expr, comment: `cxb_${number++}` } });
    const drop = (counter = "bridge_denied") => [{ counter }, { drop: null }];
    rule([match(meta(chain === "output" ? "obrname" : "ibrname"), "@disabled"), ...drop("killed")]);
    const incoming = match(meta("ibrname"), BRIDGE.name);
    if (chain === "prerouting") {
      rule([incoming, match(payload("ether", "saddr"), BRIDGE.mac), ...drop()]);
      rule([incoming, match(payload("ip", "saddr"), BRIDGE.addresses[0]), ...drop()]);
      rule([incoming, match(payload("arp", "saddr ip"), BRIDGE.addresses[0]), ...drop()]);
      rule([
        incoming,
        match(payload("ether", "type"), { set: ["ip", "ip6", "arp"] }, "!="),
        ...drop(),
      ]);
    } else if (chain === "input") {
      rule([
        incoming,
        match(payload("arp", "operation"), { set: ["request", "reply"] }),
        match(payload("arp", "daddr ip"), BRIDGE.addresses[0]),
        { accept: null },
      ]);
      rule([
        incoming,
        match(payload("ether", "daddr"), BRIDGE.mac),
        match(payload("ether", "type"), { set: ["ip", "ip6"] }),
        { accept: null },
      ]);
      rule([incoming, ...drop()]);
    } else if (chain === "forward") rule([incoming, ...drop()]);
  }
  return { nftables: objects };
}

export function createRawLinuxDockerStdio(input: {
  readonly containers: Map<string, JsonObject>;
  readonly networkName: string;
  readonly installationId: string;
}) {
  const commands: string[] = [];
  const nativeCommands: { kind: string; nativeId: string | undefined; operation: string }[] = [];
  const errors: string[] = [];
  const children = new Set<EventEmitter>();
  const guestTables = new Map<string, string>();
  let bridgeInstalled = false;
  let attached = false;
  let starts = 0;
  let corruptGuestRead = false;
  const container = (id?: string) => {
    const entry = [...input.containers.entries()].find(([, value]) => value.Id === id);
    if (!entry) throw new Error("raw container unavailable");
    return entry;
  };
  const network = () => ({
    Id: NETWORK_ID,
    Name: input.networkName,
    Driver: "bridge",
    Scope: "local",
    Internal: false,
    Ingress: false,
    Attachable: false,
    Labels: { "takoserver.installation": input.installationId },
    Options: { "com.docker.network.bridge.name": BRIDGE.name },
    IPAM: { Config: [{ Gateway: BRIDGE.addresses[0], Subnet: "172.22.0.0/16" }] },
    Containers: attached
      ? Object.fromEntries([...input.containers.values()].map((c) => [String(c.Id), {}]))
      : {},
  });
  const spawn = (_file: string, args: readonly string[]) => {
    const nativeIndex = args.indexOf("--container");
    const nativeId = nativeIndex < 0 ? undefined : args[nativeIndex + 1];
    const identityPrefix = Number.parseInt(nativeId?.slice(0, 8) ?? "0", 16);
    const host = 2 + (Number.parseInt(nativeId?.slice(0, 2) ?? "0", 16) % 250);
    const ipv4 = `172.22.0.${host}`;
    const guestFailClosed = args.includes("--guest-failclosed");
    const kind = args.includes("--host-bridge")
      ? "bridge"
      : args.includes("--quarantine-control")
        ? "control"
        : "container";
    const table = args[4];
    if (!table) throw new Error("raw table missing");
    const child = new EventEmitter();
    children.add(child);
    const stdout = new EventEmitter();
    let ended = false;
    let armed = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      let status = 0;
      if (armed && guestFailClosed) {
        try {
          const wire = guestTables.get(table);
          const parsed: unknown = wire === undefined ? null : JSON.parse(wire);
          if (!isJsonObject(parsed) || !Array.isArray(parsed.nftables))
            throw new Error("raw lifetime table unavailable");
          // The native watchdog inserts this exact unconditional output prefix
          // on EOF. Keep all original rules, counters and quota data intact.
          const handle = 10_000 + parsed.nftables.length;
          const deny = {
            rule: {
              family: "inet",
              table,
              chain: "output",
              expr: [{ counter: "killed" }, { drop: null }],
              comment: "guest_lifetime_closed",
              handle,
            },
          };
          guestTables.set(table, JSON.stringify({ nftables: [deny, ...parsed.nftables] }));
        } catch {
          status = 1;
          errors.push("raw lifetime close unavailable");
        }
      }
      children.delete(child);
      child.emit("close", status, null);
    };
    const reply = (body: string, status = 0) => {
      const bytes = Buffer.concat([Buffer.from([status]), Buffer.from(body)]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      // Fragment both the prefix and payload to exercise the original framing.
      const frame = Buffer.concat([length, bytes]);
      stdout.emit("data", frame.subarray(0, 2));
      stdout.emit("data", frame.subarray(2));
    };
    const command = (text: string): string => {
      const operation = text.split("\n")[0] ?? "";
      commands.push(`${kind}:${operation}`);
      nativeCommands.push({ kind, nativeId, operation });
      if (["CURRENT", "CLOSE"].includes(operation)) return "";
      if (operation === "ARMGUEST") {
        armed = true;
        return "";
      }
      if (operation === "KEEPGUEST") {
        if (!armed) throw new Error("raw guest lifetime unarmed");
        return "";
      }
      if (operation === "RESUMEGUEST") {
        const parsed: unknown = JSON.parse(guestTables.get(table) ?? "null");
        if (!isJsonObject(parsed) || !Array.isArray(parsed.nftables))
          throw new Error("raw lifetime absent");
        const kept = parsed.nftables.filter(
          (item) =>
            !(
              isJsonObject(item) &&
              isJsonObject(item.rule) &&
              item.rule.comment === "guest_lifetime_closed"
            ),
        );
        if (kept.length === parsed.nftables.length) throw new Error("raw lifetime deny absent");
        armed = true;
        guestTables.set(table, JSON.stringify({ nftables: kept }));
        return "";
      }
      if (operation === "NETWORK") {
        const body = JSON.stringify(network());
        return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      }
      if (operation === "BRIDGEBINDING") return JSON.stringify(BRIDGE);
      if (operation === "HOSTINVENTORY")
        return JSON.stringify({ addresses: ["192.0.2.1"], networks: ["172.22.0.0/16"] });
      if (operation === "BRIDGECHECK") return "";
      if (operation === "BRIDGEINSTALL") {
        bridgeInstalled = true;
        return "";
      }
      if (operation === "BRIDGEREAD") {
        if (!bridgeInstalled) throw new Error("raw bridge table absent");
        return JSON.stringify(bridgeJson(table));
      }
      if (operation === "NFTCHECK") {
        nftJson(text.slice(operation.length + 1));
        return "";
      }
      if (operation === "NFTAPPLY") {
        const script = text.slice(operation.length + 1);
        guestTables.set(table, JSON.stringify(nftJson(script)));
        if (guestFailClosed) armed = true;
        return "";
      }
      if (operation === "NFTREAD inet") {
        const wire = guestTables.get(table);
        if (!wire) throw new Error("raw guest table absent");
        return corruptGuestRead ? '{"nftables":[]}' : wire;
      }
      const [name, current] = container(nativeId);
      if (operation === "QUARANTINESTART") {
        starts++;
        input.containers.set(name, { ...current, State: { Running: true } });
        return "";
      }
      if (operation === "DISCONNECTNONE") {
        input.containers.set(name, { ...current, NetworkSettings: { Networks: {} } });
        return "";
      }
      if (operation === "CONNECTOWNED") {
        attached = true;
        input.containers.set(name, {
          ...current,
          NetworkSettings: {
            Networks: { [input.networkName]: { NetworkID: NETWORK_ID, IPAddress: ipv4 } },
          },
        });
        return "";
      }
      if (operation !== "INSPECT") throw new Error(`raw command unavailable: ${operation}`);
      const config = current.Config,
        host = current.HostConfig,
        state = current.State;
      if (
        !isJsonObject(config) ||
        !isJsonObject(host) ||
        !isJsonObject(state) ||
        !isJsonObject(config.Labels)
      )
        throw new Error("raw inspect unavailable");
      const labels = config.Labels;
      const running = state.Running === true;
      const settings = current.NetworkSettings;
      const networks =
        isJsonObject(settings) && isJsonObject(settings.Networks) ? settings.Networks : {};
      return JSON.stringify({
        id: current.Id,
        pid: running ? 123 + (identityPrefix % 65536) : 0,
        running,
        paused: false,
        restarting: false,
        dead: false,
        imageId: current.Image,
        identityLabel: labels["takoserver.identity"],
        revisionLabel: labels["takoserver.revision"],
        claimId: labels["takoserver.create-claim"],
        networkMode: host.NetworkMode,
        sandboxId: running ? "d".repeat(64) : "",
        dns: host.Dns,
        security: {
          nonPrivileged: host.Privileged === false,
          capDropAll: Array.isArray(host.CapDrop) && host.CapDrop.includes("ALL"),
          capAddEmpty: host.CapAdd === undefined,
          noNewPrivileges:
            Array.isArray(host.SecurityOpt) && host.SecurityOpt.includes("no-new-privileges:true"),
          noHostMounts: Array.isArray(current.Mounts) && current.Mounts.length === 0,
          noDevices: host.Devices === undefined,
          privatePid: host.PidMode === undefined,
          privateIpc: host.IpcMode === undefined,
          privateUts: host.UTSMode === undefined,
          privateCgroup: host.CgroupnsMode === undefined,
          unpublishedPorts: host.PublishAllPorts === false,
        },
        networks: Object.keys(networks).map((name) => ({
          name,
          networkId: name === "none" ? NONE_ID : NETWORK_ID,
          endpointId: "e".repeat(64),
          ipv4: name === "none" ? "" : ipv4,
          ipv6: "",
          mac: "02:42:ac:16:00:02",
        })),
      });
    };
    Object.assign(child, {
      stdout,
      stdin: {
        write(frame: Buffer, callback: (error?: Error) => void) {
          queueMicrotask(() => {
            try {
              if (frame.readUInt32BE(0) !== frame.length - 4) throw new Error("raw frame mismatch");
              reply(command(frame.subarray(4).toString("utf8")));
              callback();
            } catch (error) {
              errors.push(error instanceof Error ? error.message : "raw error");
              reply("", 1);
              callback();
            }
          });
          return true;
        },
        destroy() {
          queueMicrotask(finish);
        },
      },
      kill() {
        queueMicrotask(finish);
        return true;
      },
    });
    queueMicrotask(() =>
      reply(
        JSON.stringify({
          kind: "docker-physical-session@1",
          peerPid: Number(args[1]),
          peerUid: Number(args[2]),
          captureOnly: false,
          ...(nativeId === undefined ? {} : { nativeId }),
          namespaceKind: kind,
          namespaceDevice: "4",
          namespaceInode: kind === "container" ? String(200 + identityPrefix) : "100",
          parentDevice: "4",
          parentInode: "100",
        }),
      ),
    );
    return child;
  };
  return {
    spawn,
    network,
    commands,
    nativeCommands,
    errors,
    starts: () => starts,
    liveChildren: () => children.size,
    guestReadback(nativeId: string) {
      return guestTables.get(`takos_cx_${nativeId.slice(0, 32)}`);
    },
    corruptGuestRead() {
      corruptGuestRead = true;
    },
  };
}
