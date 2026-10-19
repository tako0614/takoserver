import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { canonicalJson, isJsonObject } from "../json.ts";
import type {
  DockerContainerNativeIdentity,
  DockerContainerRuntimePolicy,
} from "./docker-container-runtime-preparation.ts";
import type {
  LinuxContainerEgressPlan,
  LinuxContainerEgressPort,
  LinuxContainerHostHttpBridge,
} from "./linux-container-egress.ts";

const LIMIT = 1024 * 1024;
function fail(): never {
  throw new Error("docker_physical_session_unavailable");
}

/** Closed nonsecret metadata from the original pinned daemon, not authority or
 * an enforcement receipt. Env, mounts, logs and arbitrary labels never cross
 * the native-helper reply boundary. */
export interface DockerPhysicalContainerInspection {
  readonly id: string;
  readonly pid: number;
  readonly running: boolean;
  readonly paused: boolean;
  readonly restarting: boolean;
  readonly dead: boolean;
  readonly imageId: string;
  readonly identityLabel: string;
  readonly revisionLabel: string;
  readonly claimId: string;
  readonly networkMode: string;
  readonly sandboxId: string;
  readonly dns: readonly string[];
  /** Observed pinned-daemon config facts, not accepted authority or coverage. */
  readonly security: Readonly<
    Record<
      | "nonPrivileged"
      | "capDropAll"
      | "capAddEmpty"
      | "noNewPrivileges"
      | "noHostMounts"
      | "noDevices"
      | "privatePid"
      | "privateIpc"
      | "privateUts"
      | "privateCgroup"
      | "unpublishedPorts",
      boolean
    >
  >;
  readonly networks: readonly {
    readonly name: string;
    readonly networkId: string;
    readonly endpointId: string;
    readonly ipv4: string;
    readonly ipv6: string;
    readonly mac: string;
  }[];
}

export interface DockerPhysicalProcessOptions {
  readonly helper: string;
  readonly socketPath: string;
  /** Actual operator-owned Engine peer identity, never a tenant PID selector. */
  readonly peerPid: number;
  readonly peerUid: number;
  readonly networkId: string;
  readonly table: string;
  readonly signal: AbortSignal;
  /** Host-selected exact existing container, never a caller-supplied daemon path. */
  readonly nativeId?: string;
  /** Explicit native mode is only for a separately qualified selected namespace. */
  readonly native?: {
    readonly ipBinary: string;
    readonly nftBinary: string;
    /** Host code-owned Engine sandbox root. Opts into held guest namespace mode;
     * initial capture requires NetworkMode none and a separate NSFS sandbox.
     * This is an execution target, not admission or an enforcement receipt. */
    readonly guestNamespaceRoot?: string;
    /** Fixed selected-ID Docker mutations only; this mode never executes native
     * binaries or enters the daemon namespace. Original durable owner claim is
     * required by lifecycle before quarantineStart(). */
    readonly quarantineControl?: true;
    /** Resolves original network -> bridge -> actual rtnetlink binding. Only
     * the helper's closed anti-spoof bridge script can execute in this mode. */
    readonly hostBridge?: true;
    /** Retained original guest-FD deny watchdog. It is armed only on a filter
     * attempt or explicit post-readback arm, never by observed labels. */
    readonly guestFailClosed?: true;
  };
}

/** The process, not the emitted metadata, retains the original peer pidfd/netnsFD.
 * Capture-only is useful for a genuine own AF_UNIX fixture without setns/exec.
 */
export async function openDockerPhysicalProcess(options: DockerPhysicalProcessOptions) {
  if (
    ![options.helper, options.socketPath].every(
      (value) => value.startsWith("/") && !/[\0\r\n]/u.test(value),
    ) ||
    !Number.isSafeInteger(options.peerPid) ||
    options.peerPid < 1 ||
    !Number.isSafeInteger(options.peerUid) ||
    options.peerUid < 0 ||
    !/^[a-f0-9]{64}$/u.test(options.networkId) ||
    (options.nativeId !== undefined && !/^[a-f0-9]{64}$/u.test(options.nativeId)) ||
    !/^takos_cx_[a-z0-9_]{1,40}$/u.test(options.table) ||
    options.signal.aborted ||
    (options.native?.guestNamespaceRoot !== undefined &&
      (options.nativeId === undefined ||
        typeof options.native.guestNamespaceRoot !== "string" ||
        !options.native.guestNamespaceRoot.startsWith("/") ||
        options.native.guestNamespaceRoot.length < 2 ||
        options.native.guestNamespaceRoot.length > 384 ||
        options.native.guestNamespaceRoot.endsWith("/") ||
        options.native.guestNamespaceRoot.includes("..") ||
        options.native.guestNamespaceRoot.includes("//") ||
        /[^\x21-\x7e]|\\/u.test(options.native.guestNamespaceRoot))) ||
    (options.native?.quarantineControl !== undefined &&
      (options.native.quarantineControl !== true ||
        options.nativeId === undefined ||
        options.native.guestNamespaceRoot !== undefined)) ||
    (options.native?.hostBridge !== undefined &&
      (options.native.hostBridge !== true ||
        options.nativeId !== undefined ||
        options.native.quarantineControl !== undefined ||
        options.native.guestNamespaceRoot !== undefined ||
        options.table !== `takos_cx_${options.networkId.slice(0, 32)}`)) ||
    (options.native?.guestFailClosed !== undefined &&
      (options.native.guestFailClosed !== true ||
        options.native.guestNamespaceRoot === undefined ||
        options.nativeId === undefined ||
        options.table !== `takos_cx_${options.nativeId.slice(0, 32)}`)) ||
    (options.native &&
      ![options.native.ipBinary, options.native.nftBinary].every(
        (value) => value.startsWith("/") && !/[\0\r\n]/u.test(value),
      ))
  )
    fail();
  const args = [
    options.socketPath,
    String(options.peerPid),
    String(options.peerUid),
    options.networkId,
    options.table,
    ...(options.native ? ["--native", options.native.ipBinary, options.native.nftBinary] : []),
    ...(options.nativeId === undefined ? [] : ["--container", options.nativeId]),
    ...(options.native?.hostBridge ? ["--host-bridge"] : []),
    ...(options.native?.quarantineControl ? ["--quarantine-control"] : []),
    ...(options.native?.guestNamespaceRoot === undefined
      ? []
      : ["--guest-netns-root", options.native.guestNamespaceRoot]),
    ...(options.native?.guestFailClosed ? ["--guest-failclosed"] : []),
  ];
  const child = spawn(options.helper, args, {
    stdio: ["pipe", "pipe", "ignore"],
    env: { LANG: "C", LC_ALL: "C" },
  });
  let ended = false,
    cleanExit = false;
  let buffered = Buffer.alloc(0);
  let waiter: { resolve(value: Buffer): void; reject(): void } | undefined;
  let terminal = false;
  const exited = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      cleanExit = code === 0 && signal === null;
      ended = true;
      terminal = true;
      waiter?.reject();
      resolve();
    });
  });
  const stop = () => {
    terminal = true;
    waiter?.reject();
    child.stdin.destroy();
    // The retained native watchdog joins monotonic deny on EOF. Killing this
    // controller here would hide its cleanup result and bypass normal custody.
    if (!ended && !options.native?.guestFailClosed) child.kill("SIGKILL");
  };
  child.once("error", stop);
  const consume = () => {
    if (!waiter || buffered.length < 4) return;
    const size = buffered.readUInt32BE(0);
    if (size < 1 || size > LIMIT) {
      stop();
      return;
    }
    if (buffered.length < size + 4) return;
    const frame = buffered.subarray(4, size + 4);
    buffered = buffered.subarray(size + 4);
    const pending = waiter;
    waiter = undefined;
    if (frame[0] !== 0) {
      terminal = true;
      pending.reject();
    } else pending.resolve(frame.subarray(1));
  };
  child.stdout.on("data", (data: Buffer) => {
    if (buffered.length + data.length > LIMIT + 4) {
      stop();
      return;
    }
    buffered = Buffer.concat([buffered, data]);
    consume();
  });
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  async function receive(): Promise<Buffer> {
    if (terminal || waiter) fail();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        waiter = {
          resolve,
          reject: () => reject(new Error("docker_physical_session_unavailable")),
        };
        timer = setTimeout(stop, 4000);
        consume();
      });
    } finally {
      clearTimeout(timer);
      waiter = undefined;
    }
  }
  let queue: Promise<unknown> = Promise.resolve();
  function request(command: string) {
    const next = queue.then(async () => {
      if (terminal || options.signal.aborted) fail();
      const bytes = Buffer.from(command);
      if (bytes.length < 1 || bytes.length > 65536 + 128 || bytes.includes(0)) fail();
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      const reply = receive();
      child.stdin.write(Buffer.concat([length, bytes]), (error) => {
        if (error) stop();
      });
      return reply;
    });
    queue = next.catch(() => {
      terminal = true;
    });
    return next;
  }
  try {
    const hello: unknown = JSON.parse((await receive()).toString("utf8"));
    if (
      !isJsonObject(hello) ||
      hello.kind !== "docker-physical-session@1" ||
      hello.peerPid !== options.peerPid ||
      hello.peerUid !== options.peerUid ||
      hello.captureOnly !== !options.native ||
      hello.nativeId !== options.nativeId ||
      hello.namespaceKind !==
        (options.native?.hostBridge
          ? "bridge"
          : options.native?.quarantineControl
            ? "control"
            : options.native?.guestNamespaceRoot === undefined
              ? undefined
              : "container") ||
      ![hello.namespaceDevice, hello.namespaceInode, hello.parentDevice, hello.parentInode].every(
        (value) => typeof value === "string" && /^[0-9]+$/u.test(value),
      )
    )
      fail();
    const metadata = Object.freeze({ ...hello });
    return Object.freeze({
      metadata,
      closed: exited,
      async current() {
        await request("CURRENT");
      },
      async network() {
        return parseNetworkHttp(await request("NETWORK"));
      },
      async inspect(): Promise<DockerPhysicalContainerInspection> {
        if (options.nativeId === undefined) return fail();
        const snapshot = parseContainerInspection(await request("INSPECT"), options.nativeId);
        await request("CURRENT");
        if (terminal || options.signal.aborted) return fail();
        return snapshot;
      },
      async bridgeBinding(): Promise<{
        readonly name: string;
        readonly ifindex: number;
        readonly mac: string;
        readonly addresses: readonly string[];
      }> {
        if (!options.native?.hostBridge) return fail();
        const value: unknown = JSON.parse((await request("BRIDGEBINDING")).toString("utf8"));
        if (
          !isJsonObject(value) ||
          Object.keys(value).sort().join() !==
            ["name", "ifindex", "mac", "addresses"].sort().join() ||
          typeof value.name !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,14}$/u.test(value.name) ||
          typeof value.ifindex !== "number" ||
          !Number.isSafeInteger(value.ifindex) ||
          value.ifindex < 1 ||
          typeof value.mac !== "string" ||
          !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/u.test(value.mac) ||
          !Array.isArray(value.addresses) ||
          value.addresses.length < 1 ||
          value.addresses.length > 8 ||
          value.addresses.some((x) => typeof x !== "string" || x.includes("%") || !isIP(x)) ||
          new Set(value.addresses).size !== value.addresses.length
        )
          return fail();
        const addresses: string[] = [];
        for (const x of value.addresses) {
          if (typeof x !== "string") return fail();
          addresses.push(x);
        }
        await request("CURRENT");
        return Object.freeze({
          name: value.name,
          ifindex: value.ifindex,
          mac: value.mac,
          addresses: Object.freeze(addresses),
        });
      },
      bridgePort(
        plan: Pick<LinuxContainerEgressPlan, "table" | "script">,
      ): LinuxContainerEgressPort {
        if (!options.native?.hostBridge || plan.table !== options.table) return fail();
        return Object.freeze({
          async namespace() {
            await request("CURRENT");
            return `net:[${String(metadata.namespaceInode)}]`;
          },
          async execute(command: Parameters<LinuxContainerEgressPort["execute"]>[0]) {
            const argv = canonicalJson(command.argv);
            if (
              argv === canonicalJson(["nft", "--check", "-f", "-"]) ||
              argv === canonicalJson(["nft", "-f", "-"])
            ) {
              if (command.stdin !== plan.script) return fail();
              return (
                await request(command.argv[1] === "--check" ? "BRIDGECHECK" : "BRIDGEINSTALL")
              ).toString("utf8");
            }
            if (
              command.stdin === undefined &&
              argv ===
                canonicalJson(["nft", "-j", "list", "table", "bridge", `${options.table}_bridge`])
            )
              return (await request("BRIDGEREAD")).toString("utf8");
            return fail();
          },
        });
      },
      /** Each command's attempt is consumed natively before its socket write.
       * A lost ACK rejects; neither this helper nor recovery re-sends it. */
      async resumeGuestLifetime() {
        if (!options.native?.guestFailClosed) return fail();
        await request("RESUMEGUEST");
      },
      async hostInventory(): Promise<{
        readonly addresses: readonly string[];
        readonly networks: readonly string[];
      }> {
        if (!options.native?.guestFailClosed) return fail();
        const value: unknown = JSON.parse((await request("HOSTINVENTORY")).toString("utf8"));
        if (
          !isJsonObject(value) ||
          Object.keys(value).sort().join() !== ["addresses", "networks"].sort().join() ||
          !Array.isArray(value.addresses) ||
          value.addresses.length < 1 ||
          value.addresses.length > 1024 ||
          !Array.isArray(value.networks) ||
          value.networks.length > 256 ||
          new Set(value.addresses).size !== value.addresses.length ||
          new Set(value.networks).size !== value.networks.length
        )
          return fail();
        const addresses: string[] = [],
          networks: string[] = [];
        for (const address of value.addresses) {
          if (typeof address !== "string" || address.includes("%") || !isIP(address)) return fail();
          addresses.push(address);
        }
        for (const network of value.networks) {
          if (typeof network !== "string") return fail();
          const parts = network.split("/"),
            ip = parts[0],
            bits = parts[1];
          if (
            parts.length !== 2 ||
            !ip ||
            !isIP(ip) ||
            ip.includes("%") ||
            !bits ||
            !/^[0-9]{1,3}$/u.test(bits) ||
            Number(bits) > (isIP(ip) === 4 ? 32 : 128)
          )
            return fail();
          networks.push(network);
        }
        await request("CURRENT");
        return Object.freeze({
          addresses: Object.freeze(addresses),
          networks: Object.freeze(networks),
        });
      },
      async keepGuestLifetime() {
        if (!options.native?.guestFailClosed) return fail();
        await request("KEEPGUEST");
      },
      async armGuestLifetime() {
        if (!options.native?.guestFailClosed) return fail();
        await request("ARMGUEST");
      },
      async quarantineStart() {
        if (!options.native?.quarantineControl) return fail();
        await request("QUARANTINESTART");
      },
      async disconnectNone() {
        if (!options.native?.quarantineControl) return fail();
        await request("DISCONNECTNONE");
      },
      async connectOwned() {
        if (!options.native?.quarantineControl) return fail();
        await request("CONNECTOWNED");
      },
      async link(name: string) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,14}$/u.test(name)) fail();
        return JSON.parse((await request(`LINK ${name}`)).toString("utf8")) as unknown;
      },
      async addresses(name: string) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,14}$/u.test(name)) fail();
        return JSON.parse((await request(`ADDR ${name}`)).toString("utf8")) as unknown;
      },
      /** Script transport only. The plan shape is not accepted authority or proof;
       * actual preparation retains the original owner and verifies readback. */
      port(plan: Pick<LinuxContainerEgressPlan, "table" | "script">): LinuxContainerEgressPort {
        if (plan.table !== options.table) fail();
        const script = plan.script;
        return Object.freeze({
          async namespace() {
            await request("CURRENT");
            return `net:[${String(metadata.namespaceInode)}]`;
          },
          async execute(command: Parameters<LinuxContainerEgressPort["execute"]>[0]) {
            const argv = canonicalJson(command.argv);
            if (
              argv === canonicalJson(["nft", "--check", "-f", "-"]) ||
              argv === canonicalJson(["nft", "-f", "-"])
            ) {
              if (command.stdin !== script) fail();
              return (
                await request(
                  `${command.argv[1] === "--check" ? "NFTCHECK" : "NFTAPPLY"}\n${script}`,
                )
              ).toString("utf8");
            }
            if (command.stdin !== undefined) fail();
            for (const family of ["inet", "bridge"] as const) {
              const name = family === "inet" ? options.table : `${options.table}_bridge`;
              if (argv === canonicalJson(["nft", "-j", "list", "table", family, name]))
                return (await request(`NFTREAD ${family}`)).toString("utf8");
            }
            return fail();
          },
        });
      },
      async close() {
        try {
          if (!terminal) await request("CLOSE");
        } catch {
          /* original terminal remains */
        } finally {
          stop();
          await exited;
          options.signal.removeEventListener("abort", stop);
        }
        if (options.native?.guestFailClosed && !cleanExit) return fail();
      },
    });
  } catch {
    stop();
    await exited;
    options.signal.removeEventListener("abort", stop);
    return fail();
  }
}

function parseContainerInspection(
  bytes: Buffer,
  expectedId: string,
): DockerPhysicalContainerInspection {
  if (bytes.byteLength > 16384) return fail();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail();
  }
  const closed = (input: unknown, keys: readonly string[]): input is Record<string, unknown> =>
    isJsonObject(input) &&
    Object.keys(input).length === keys.length &&
    keys.every((key) => Object.hasOwn(input, key));
  const id = (input: unknown): input is string =>
    typeof input === "string" && /^[a-f0-9]{64}$/u.test(input);
  const digest = (input: unknown): input is string =>
    typeof input === "string" && /^sha256:[a-f0-9]{64}$/u.test(input);
  const text = (input: unknown, max: number): input is string =>
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= max &&
    !/[^\x20-\x7e]/u.test(input);
  if (
    !closed(value, [
      "id",
      "pid",
      "running",
      "paused",
      "restarting",
      "dead",
      "imageId",
      "identityLabel",
      "revisionLabel",
      "claimId",
      "networkMode",
      "sandboxId",
      "dns",
      "security",
      "networks",
    ]) ||
    value.id !== expectedId ||
    !id(value.id) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 0 ||
    value.pid > 2147483647 ||
    typeof value.running !== "boolean" ||
    typeof value.paused !== "boolean" ||
    typeof value.restarting !== "boolean" ||
    typeof value.dead !== "boolean" ||
    (value.running ? value.pid < 1 : value.pid !== 0) ||
    (value.dead && value.running) ||
    !digest(value.imageId) ||
    !digest(value.identityLabel) ||
    !digest(value.revisionLabel) ||
    !id(value.claimId) ||
    !text(value.networkMode, 256) ||
    (value.sandboxId !== "" && !id(value.sandboxId)) ||
    !Array.isArray(value.dns) ||
    value.dns.length > 3 ||
    !Array.isArray(value.networks) ||
    value.networks.length > 2
  )
    return fail();
  if (
    !closed(value.security, [
      "nonPrivileged",
      "capDropAll",
      "capAddEmpty",
      "noNewPrivileges",
      "noHostMounts",
      "noDevices",
      "privatePid",
      "privateIpc",
      "privateUts",
      "privateCgroup",
      "unpublishedPorts",
    ]) ||
    Object.values(value.security).some((x) => typeof x !== "boolean")
  )
    return fail();
  const security = value.security;
  const dns: string[] = [];
  for (const address of value.dns) {
    if (typeof address !== "string" || address.includes("%") || !isIP(address)) return fail();
    dns.push(address);
  }
  const networks: DockerPhysicalContainerInspection["networks"][number][] = [];
  const names = new Set<string>();
  for (const network of value.networks) {
    if (
      !closed(network, ["name", "networkId", "endpointId", "ipv4", "ipv6", "mac"]) ||
      typeof network.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(network.name) ||
      names.has(network.name) ||
      (network.networkId !== "" && !id(network.networkId)) ||
      (value.running && network.networkId === "") ||
      (network.endpointId !== "" && !id(network.endpointId)) ||
      typeof network.ipv4 !== "string" ||
      (network.ipv4 !== "" && isIP(network.ipv4) !== 4) ||
      typeof network.ipv6 !== "string" ||
      network.ipv6.includes("%") ||
      (network.ipv6 !== "" && isIP(network.ipv6) !== 6) ||
      typeof network.mac !== "string" ||
      (network.mac !== "" && !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(network.mac))
    )
      return fail();
    names.add(network.name);
    networks.push(
      Object.freeze({
        name: network.name,
        networkId: network.networkId,
        endpointId: network.endpointId,
        ipv4: network.ipv4,
        ipv6: network.ipv6,
        mac: network.mac,
      }),
    );
  }
  return Object.freeze({
    id: value.id,
    pid: value.pid,
    running: value.running,
    paused: value.paused,
    restarting: value.restarting,
    dead: value.dead,
    imageId: value.imageId,
    identityLabel: value.identityLabel,
    revisionLabel: value.revisionLabel,
    claimId: value.claimId,
    networkMode: value.networkMode,
    sandboxId: value.sandboxId,
    dns: Object.freeze(dns),
    networks: Object.freeze(networks),
    security: Object.freeze({
      nonPrivileged: security.nonPrivileged === true,
      capDropAll: security.capDropAll === true,
      capAddEmpty: security.capAddEmpty === true,
      noNewPrivileges: security.noNewPrivileges === true,
      noHostMounts: security.noHostMounts === true,
      noDevices: security.noDevices === true,
      privatePid: security.privatePid === true,
      privateIpc: security.privateIpc === true,
      privateUts: security.privateUts === true,
      privateCgroup: security.privateCgroup === true,
      unpublishedPorts: security.unpublishedPorts === true,
    }),
  });
}

function parseNetworkHttp(bytes: Buffer): unknown {
  const boundary = bytes.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary > 16384) fail();
  const lines = bytes.subarray(0, boundary).toString("ascii").split("\r\n");
  if (!/^HTTP\/1\.[01] 200 /u.test(lines.shift() ?? "")) fail();
  const headers = new Map<string, string>();
  for (const line of lines) {
    const split = line.indexOf(":");
    if (split < 1 || /^[ \t]/u.test(line)) fail();
    const name = line.slice(0, split).toLowerCase();
    if (headers.has(name)) fail();
    headers.set(name, line.slice(split + 1).trim());
  }
  const wire = bytes.subarray(boundary + 4);
  let body = wire;
  if (headers.get("transfer-encoding") === "chunked") {
    if (headers.has("content-length")) fail();
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const end = wire.indexOf("\r\n", offset);
      if (end < 0) fail();
      const text = wire.subarray(offset, end).toString("ascii");
      if (!/^[a-fA-F0-9]{1,8}$/u.test(text)) fail();
      const size = Number.parseInt(text, 16);
      offset = end + 2;
      if (size === 0) {
        if (wire.subarray(offset).toString("ascii") !== "\r\n") fail();
        break;
      }
      if (
        size > LIMIT ||
        offset + size + 2 > wire.length ||
        wire.subarray(offset + size, offset + size + 2).toString("ascii") !== "\r\n"
      )
        fail();
      chunks.push(wire.subarray(offset, offset + size));
      offset += size + 2;
    }
    body = Buffer.concat(chunks);
  } else {
    const length = headers.get("content-length");
    if (
      headers.has("transfer-encoding") ||
      length === undefined ||
      !/^[0-9]+$/u.test(length) ||
      Number(length) !== body.length
    )
      fail();
  }
  return JSON.parse(body.toString("utf8")) as unknown;
}

/** Queries actual namespace-bound link/IPAM data; labels only corroborate the
 * original allocation owner. No prefix-derived bridge or guessed stopped veth.
 */
export interface DockerPhysicalBridgeBinding {
  readonly bridge: LinuxContainerHostHttpBridge;
  readonly ipam: readonly { readonly subnet: string; readonly gateway: string }[];
}

export async function readDockerPhysicalBridge(
  process: Awaited<ReturnType<typeof openDockerPhysicalProcess>>,
  native: DockerContainerNativeIdentity,
  policy: DockerContainerRuntimePolicy,
  host: { readonly tcpPorts: readonly number[]; readonly conntrackMark: number },
): Promise<LinuxContainerHostHttpBridge> {
  return (await readDockerPhysicalBridgeBinding(process, native, policy, host)).bridge;
}

/** The original full allocation projection, held separately from compiler input.
 * Never discard the subnet/prefix when pinning pre/post native readback identity.
 */
export async function readDockerPhysicalBridgeBinding(
  process: Awaited<ReturnType<typeof openDockerPhysicalProcess>>,
  native: DockerContainerNativeIdentity,
  policy: DockerContainerRuntimePolicy,
  host: { readonly tcpPorts: readonly number[]; readonly conntrackMark: number },
): Promise<DockerPhysicalBridgeBinding> {
  await process.current();
  const network = await process.network();
  if (
    !isJsonObject(network) ||
    network.Id !== native.networkId ||
    network.Name !== native.network ||
    network.Driver !== "bridge" ||
    network.Scope !== "local" ||
    network.Internal !== !policy.outboundInternet ||
    network.Ingress !== false ||
    network.Attachable !== false ||
    !isJsonObject(network.Labels) ||
    network.Labels["takoserver.installation"] !== native.installationId ||
    !isJsonObject(network.Options) ||
    !isJsonObject(network.IPAM) ||
    !Array.isArray(network.IPAM.Config) ||
    !isJsonObject(network.Containers) ||
    Object.keys(network.Containers).some((id) => id !== native.nativeId)
  )
    fail();
  const name = network.Options["com.docker.network.bridge.name"];
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,14}$/u.test(name)) fail();
  const links = await process.link(name),
    addresses = await process.addresses(name);
  if (
    !Array.isArray(links) ||
    links.length !== 1 ||
    !Array.isArray(addresses) ||
    addresses.length !== 1
  )
    fail();
  const link = links[0],
    address = addresses[0];
  if (
    !isJsonObject(link) ||
    !isJsonObject(address) ||
    link.ifname !== name ||
    address.ifname !== name ||
    !Number.isSafeInteger(link.ifindex) ||
    (link.ifindex as number) < 1 ||
    address.ifindex !== link.ifindex ||
    !isJsonObject(link.linkinfo) ||
    link.linkinfo.info_kind !== "bridge" ||
    typeof link.address !== "string" ||
    !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/u.test(link.address) ||
    !Array.isArray(address.addr_info)
  )
    fail();
  const configured: string[] = [];
  const ipam: { subnet: string; gateway: string }[] = [];
  for (const config of network.IPAM.Config) {
    if (
      !isJsonObject(config) ||
      typeof config.Gateway !== "string" ||
      typeof config.Subnet !== "string"
    )
      fail();
    const prefix = config.Subnet.split("/");
    if (
      prefix.length !== 2 ||
      !/^[0-9]{1,3}$/u.test(prefix[1] ?? "") ||
      isIP(config.Gateway) !== isIP(prefix[0] ?? "") ||
      !isIP(config.Gateway)
    )
      fail();
    const bits = Number(prefix[1]);
    if (
      bits > (isIP(config.Gateway) === 4 ? 32 : 128) ||
      !insideSubnet(config.Gateway, prefix[0] ?? "", bits)
    )
      fail();
    configured.push(`${normalizedIp(config.Gateway)}/${bits}`);
    ipam.push({
      subnet: `${normalizedIp(prefix[0] ?? "")}/${bits}`,
      gateway: normalizedIp(config.Gateway),
    });
  }
  const actual: string[] = [];
  for (const item of address.addr_info) {
    if (
      !isJsonObject(item) ||
      typeof item.local !== "string" ||
      !isIP(item.local) ||
      !Number.isSafeInteger(item.prefixlen)
    )
      fail();
    if (item.scope === "global")
      actual.push(`${normalizedIp(item.local)}/${String(item.prefixlen)}`);
    else if (
      item.scope !== "link" ||
      isIP(item.local) !== 6 ||
      !item.local.toLowerCase().startsWith("fe80:")
    )
      fail();
  }
  if (
    configured.length === 0 ||
    new Set(configured).size !== configured.length ||
    canonicalJson([...actual].sort()) !== canonicalJson([...configured].sort())
  )
    fail();
  await process.current();
  return Object.freeze({
    bridge: Object.freeze({
      tenantRef: policy.tenantRef,
      generation: policy.generation,
      networkId: native.networkId,
      bridge: name,
      ifindex: link.ifindex as number,
      hostMac: link.address,
      hostAddresses: Object.freeze(configured.map((value) => value.split("/")[0] ?? "")),
      tcpPorts: Object.freeze([...host.tcpPorts]),
      conntrackMark: host.conntrackMark,
    }),
    ipam: Object.freeze(
      ipam
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
        .map((value) => Object.freeze(value)),
    ),
  });
}
function normalizedIp(value: string) {
  if (isIP(value) === 4) return value;
  if (value.includes("%")) return fail();
  return new URL(`http://[${value}]/`).hostname.slice(1, -1);
}
function insideSubnet(address: string, subnet: string, bits: number) {
  const width = isIP(address) === 4 ? 32 : 128;
  const number = (value: string): bigint => {
    if (width === 32) return value.split(".").reduce((n, item) => (n << 8n) | BigInt(item), 0n);
    const text = normalizedIp(value);
    const parts = text.split("::");
    const left = (parts[0] ?? "").split(":").filter(Boolean);
    const right = (parts[1] ?? "").split(":").filter(Boolean);
    const groups =
      parts.length === 1
        ? left
        : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
    if (groups.length !== 8 || groups.some((part) => !/^[a-f0-9]{1,4}$/u.test(part))) return fail();
    return groups.reduce((n, item) => (n << 16n) | BigInt(`0x${item}`), 0n);
  };
  const shift = BigInt(width - bits),
    network = number(subnet);
  return network === (network >> shift) << shift && number(address) >> shift === network >> shift;
}
