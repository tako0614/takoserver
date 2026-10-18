import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { canonicalJson, isJsonObject } from "../json.ts";
import type { DockerContainerRuntimePolicy } from "./docker-container-runtime-preparation.ts";
import type { LinuxContainerEgressPort } from "./linux-container-egress.ts";

/** A guest namespace kernel plan, never accepted authority or a runtime receipt.
 * The physical lifecycle must hold original custody and verify attachment before
 * and after these operations. Raw skb counters are not Form billing bytes. */
export interface LinuxDockerGuestEgressInput {
  readonly namespace: { readonly parent: string; readonly selected: string };
  readonly table: string;
  readonly policy: DockerContainerRuntimePolicy;
  readonly killSwitch: boolean;
  readonly maxConnections: number;
  readonly packetLimitBytes: number;
  /** Original owned bridge readback, not tenant-selected ingress exceptions. */
  readonly host: {
    readonly addresses: readonly string[];
    readonly mac: string;
    readonly tcpPorts: readonly number[];
    readonly conntrackMark: number;
    /** Original Host local/control address facts, plus optional operator
     * restrictions. The lifecycle obtains the mandatory facts from its pinned
     * native helper and retains their actual currentness. */
    readonly deniedDestinations: readonly string[];
    /** Connected Host bridge prefixes, read from that same native namespace.
     * Optional only for this low-level compiler's existing callers. */
    readonly deniedNetworks?: readonly string[];
  };
}
export interface LinuxDockerGuestEgressPlan {
  readonly namespace: Readonly<LinuxDockerGuestEgressInput["namespace"]>;
  readonly table: string;
  readonly script: string;
  readonly policyDigest: string;
}
export interface LinuxDockerGuestEgressReadback {
  readonly table: string;
  readonly namespace: string;
  readonly structuralDigest: string;
  readonly counters: Readonly<Record<string, { readonly packets: number; readonly bytes: number }>>;
  readonly quotaUsedBytes: number | null;
  readonly counterUnit: "kernel-skb-bytes-at-inet-output";
}
const V4 = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
];
const V6 = [
  "fc00::/7",
  "fe80::/10",
  "::1/128",
  ...V4.map((p) => {
    const [address, bits] = p.split("/");
    return `::ffff:${address}/${96 + Number(bits)}`;
  }),
];
const compiled = new WeakMap<LinuxDockerGuestEgressPlan, readonly unknown[]>();
const fail = (): never => {
  throw new Error("linux_docker_guest_egress_unavailable");
};
const integer = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const payload = (protocol: string, field: string) => ({ payload: { protocol, field } });
const meta = (key: string) => ({ meta: { key } });
const ct = (key: string) => ({ ct: { key } });
const match = (left: unknown, right: unknown, op = "==") => ({ match: { op, left, right } });
const set = (items: readonly unknown[]) => (items.length === 1 ? items[0] : { set: items });
const words = (items: readonly (string | number)[]) =>
  items.length === 1 ? String(items[0]) : `{ ${items.join(", ")} }`;
const prefixes = (items: readonly string[]) =>
  set(
    items.map((text) => {
      const [addr, bits] = text.split("/");
      return Number(bits) === (isIP(addr ?? "") === 4 ? 32 : 128)
        ? addr
        : { prefix: { addr, len: Number(bits) } };
    }),
  );
function normalizedSets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedSets);
  if (!isJsonObject(value)) return value;
  if (Object.keys(value).length === 1 && Array.isArray(value.set)) {
    return {
      set: value.set
        .map(normalizedSets)
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizedSets(child)]),
  );
}
function canonicalObjects(items: readonly unknown[]): string {
  const regular: unknown[] = [],
    rules: unknown[] = [];
  for (const item of items)
    (isJsonObject(item) && Object.hasOwn(item, "rule") ? rules : regular).push(item);
  regular.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return canonicalJson(normalizedSets([...regular, ...rules]));
}
function validHostAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("%")) return false;
  if (isIP(value) === 4) {
    const first = Number(value.split(".")[0]);
    return first !== 0 && first !== 127 && first < 224;
  }
  return (
    isIP(value) === 6 &&
    value !== "::" &&
    value !== "::1" &&
    !value.startsWith("ff") &&
    !value.startsWith("::ffff:") &&
    new URL(`http://[${value}]/`).hostname === `[${value}]`
  );
}

function validNetwork(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const pieces = value.split("/"),
    address = pieces[0],
    length = pieces[1];
  if (pieces.length !== 2 || !address || !length || !/^(?:0|[1-9][0-9]{0,2})$/u.test(length))
    return false;
  const family = isIP(address),
    bits = Number(length),
    width = family === 4 ? 32 : 128;
  if (!family || bits > width || address.includes("%")) return false;
  let encoded = 0n;
  if (family === 4) {
    for (const part of address.split(".")) encoded = (encoded << 8n) | BigInt(part);
  } else {
    if (address.includes(".") || new URL(`http://[${address}]/`).hostname !== `[${address}]`)
      return false;
    const halves = address.split("::"),
      left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const groups =
      halves.length === 1
        ? left
        : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
    if (groups.length !== 8) return false;
    for (const part of groups) encoded = (encoded << 16n) | BigInt(`0x${part}`);
  }
  const hostBits = BigInt(width - bits);
  return (encoded & ((1n << hostBits) - 1n)) === 0n;
}

export function compileLinuxDockerGuestEgress(
  input: LinuxDockerGuestEgressInput,
): LinuxDockerGuestEgressPlan {
  if (!input || !input.namespace || !input.policy || !input.host) return fail();
  const value = structuredClone(input),
    p = value.policy,
    host = value.host;
  if (
    !/^net:\[[0-9]{1,20}\]$/u.test(value.namespace.parent) ||
    !/^net:\[[0-9]{1,20}\]$/u.test(value.namespace.selected) ||
    value.namespace.parent === value.namespace.selected ||
    !/^takos_cx_[a-z0-9_]{1,40}$/u.test(value.table) ||
    typeof value.killSwitch !== "boolean" ||
    !p ||
    Object.keys(p).sort().join() !==
      ["tenantRef", "generation", "policyDigest", "outboundInternet"].sort().join() ||
    typeof p.tenantRef !== "string" ||
    p.tenantRef.length < 1 ||
    p.tenantRef.length > 256 ||
    !integer(p.generation) ||
    p.generation < 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(p.policyDigest) ||
    typeof p.outboundInternet !== "boolean" ||
    !integer(value.maxConnections) ||
    value.maxConnections > 65535 ||
    !integer(value.packetLimitBytes) ||
    !host ||
    !Array.isArray(host.addresses) ||
    host.addresses.length < 1 ||
    host.addresses.length > 8 ||
    host.addresses.some((x) => !validHostAddress(x)) ||
    new Set(host.addresses).size !== host.addresses.length ||
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(host.mac) ||
    host.mac === "00:00:00:00:00:00" ||
    (Number.parseInt(host.mac.slice(0, 2), 16) & 1) !== 0 ||
    !Array.isArray(host.tcpPorts) ||
    host.tcpPorts.length < 1 ||
    host.tcpPorts.length > 64 ||
    new Set(host.tcpPorts).size !== host.tcpPorts.length ||
    host.tcpPorts.some((n) => !integer(n) || n < 1 || n > 65535) ||
    !integer(host.conntrackMark) ||
    host.conntrackMark < 1 ||
    host.conntrackMark > 0xffffffff ||
    !Array.isArray(host.deniedDestinations) ||
    host.deniedDestinations.length > 1024 ||
    new Set(host.deniedDestinations).size !== host.deniedDestinations.length ||
    host.deniedDestinations.some(
      (x) =>
        typeof x !== "string" ||
        x.includes("%") ||
        !isIP(x) ||
        (isIP(x) === 6 &&
          (x.startsWith("::ffff:") || new URL(`http://[${x}]/`).hostname !== `[${x}]`)),
    )
  )
    return fail();
  const deniedNetworks = host.deniedNetworks === undefined ? [] : host.deniedNetworks;
  if (
    !Array.isArray(deniedNetworks) ||
    deniedNetworks.length > 256 ||
    new Set(deniedNetworks).size !== deniedNetworks.length ||
    deniedNetworks.some((x) => !validNetwork(x))
  )
    return fail();
  const common = { family: "inet", table: value.table };
  const expected: unknown[] = [{ table: { family: "inet", name: value.table } }];
  const counters = [
    "dns_denied",
    "private_denied",
    "killed",
    "host_replies",
    "raw_accepted",
    "cap_denied",
    "forward_denied",
    "input_denied",
  ];
  const lines = [`create table inet ${value.table}`, `table inet ${value.table} {`];
  for (const name of counters) {
    lines.push(`counter ${name} { }`);
    expected.push({ counter: { ...common, name } });
  }
  lines.push(`quota budget { over ${value.packetLimitBytes} bytes; }`);
  expected.push({ quota: { ...common, name: "budget", bytes: value.packetLimitBytes, inv: true } });
  let number = 0;
  const chain = (name: string, hook?: string, priority = 0, policy = "drop") => {
    lines.push(
      `chain ${name} {${hook ? ` type filter hook ${hook} priority ${priority}; policy ${policy};` : ""}`,
    );
    expected.push({
      chain: { ...common, name, ...(hook ? { type: "filter", hook, prio: priority, policy } : {}) },
    });
  };
  const rule = (chain: string, text: string, expr: readonly unknown[]) => {
    const comment = `guest_${number++}`;
    lines.push(`${text} comment "${comment}"`);
    expected.push({ rule: { ...common, chain, expr, comment } });
  };
  const drop = (name: string) => [{ counter: name }, { drop: null }];
  // This hook precedes Docker's output DNAT; the later hook repeats the deny.
  chain("dns_guard", "output", -310, "accept");
  rule("dns_guard", "ip daddr 127.0.0.11 counter name dns_denied drop", [
    match(payload("ip", "daddr"), "127.0.0.11"),
    ...drop("dns_denied"),
  ]);
  rule("dns_guard", "ip6 daddr ::ffff:127.0.0.11 counter name dns_denied drop", [
    match(payload("ip6", "daddr"), "::ffff:127.0.0.11"),
    ...drop("dns_denied"),
  ]);
  lines.push("}");
  chain("budgeted");
  rule("budgeted", "quota name budget counter name cap_denied drop", [
    { quota: "budget" },
    ...drop("cap_denied"),
  ]);
  rule("budgeted", "counter name raw_accepted accept", [
    { counter: "raw_accepted" },
    { accept: null },
  ]);
  lines.push("}");
  chain("output", "output");
  rule("output", "ip daddr 127.0.0.11 counter name dns_denied drop", [
    match(payload("ip", "daddr"), "127.0.0.11"),
    ...drop("dns_denied"),
  ]);
  rule("output", "ip6 daddr ::ffff:127.0.0.11 counter name dns_denied drop", [
    match(payload("ip6", "daddr"), "::ffff:127.0.0.11"),
    ...drop("dns_denied"),
  ]);
  rule("output", "oifname lo ip daddr 127.0.0.0/8 accept", [
    match(meta("oifname"), "lo"),
    match(payload("ip", "daddr"), { prefix: { addr: "127.0.0.0", len: 8 } }),
    { accept: null },
  ]);
  rule("output", "oifname lo ip6 daddr ::1 accept", [
    match(meta("oifname"), "lo"),
    match(payload("ip6", "daddr"), "::1"),
    { accept: null },
  ]);
  if (value.killSwitch) rule("output", "counter name killed drop", drop("killed"));
  rule("output", "meta l4proto tcp tcp dport 25 counter name private_denied drop", [
    match(payload("tcp", "dport"), 25),
    ...drop("private_denied"),
  ]);
  for (const family of ["ip", "ip6"] as const) {
    const addresses = host.addresses.filter((x) => isIP(x) === (family === "ip" ? 4 : 6));
    if (addresses.length)
      rule(
        "output",
        `ct state established ct direction reply ct mark ${host.conntrackMark} meta l4proto tcp ${family} daddr ${words(addresses)} tcp sport ${words(host.tcpPorts)} counter name host_replies jump budgeted`,
        [
          match(ct("state"), "established", "in"),
          match(ct("direction"), "reply"),
          match(ct("mark"), host.conntrackMark),
          match(payload(family, "daddr"), set(addresses)),
          match(payload("tcp", "sport"), set(host.tcpPorts)),
          { counter: "host_replies" },
          { jump: { target: "budgeted" } },
        ],
      );
  }
  const controlV4 = host.deniedDestinations.filter((x) => isIP(x) === 4);
  const controlV6 = [
    ...host.deniedDestinations.filter((x) => isIP(x) === 6),
    ...controlV4.map((x) => `::ffff:${x}`),
  ];
  for (const [family, addresses] of [
    ["ip", controlV4],
    ["ip6", controlV6],
  ] as const) {
    if (addresses.length)
      rule("output", `${family} daddr ${words(addresses)} counter name private_denied drop`, [
        match(payload(family, "daddr"), set(addresses)),
        ...drop("private_denied"),
      ]);
  }
  const networkV4 = deniedNetworks.filter((x) => isIP(x.split("/")[0] ?? "") === 4);
  const networkV6 = [
    ...deniedNetworks.filter((x) => isIP(x.split("/")[0] ?? "") === 6),
    ...networkV4.map((x) => {
      const [address, bits] = x.split("/");
      return `::ffff:${address}/${96 + Number(bits)}`;
    }),
  ];
  for (const [family, networks] of [
    ["ip", networkV4],
    ["ip6", networkV6],
  ] as const) {
    if (networks.length)
      rule("output", `${family} daddr ${words(networks)} counter name private_denied drop`, [
        match(payload(family, "daddr"), prefixes(networks)),
        ...drop("private_denied"),
      ]);
  }
  rule("output", "ip daddr { 0.0.0.0/8, 224.0.0.0/3 } counter name private_denied drop", [
    match(payload("ip", "daddr"), prefixes(["0.0.0.0/8", "224.0.0.0/3"])),
    ...drop("private_denied"),
  ]);
  rule(
    "output",
    "ip6 daddr { ::/128, ff00::/8, ::ffff:0.0.0.0/104, ::ffff:224.0.0.0/99 } counter name private_denied drop",
    [
      match(
        payload("ip6", "daddr"),
        prefixes(["::/128", "ff00::/8", "::ffff:0.0.0.0/104", "::ffff:224.0.0.0/99"]),
      ),
      ...drop("private_denied"),
    ],
  );
  rule("output", `ip daddr { ${V4.join(", ")} } counter name private_denied drop`, [
    match(payload("ip", "daddr"), prefixes(V4)),
    ...drop("private_denied"),
  ]);
  rule("output", `ip6 daddr { ${V6.join(", ")} } counter name private_denied drop`, [
    match(payload("ip6", "daddr"), prefixes(V6)),
    ...drop("private_denied"),
  ]);
  if (!p.outboundInternet) rule("output", "counter name killed drop", drop("killed"));
  rule("output", `ct count over ${value.maxConnections} counter name cap_denied drop`, [
    { "ct count": { val: value.maxConnections, inv: true } },
    ...drop("cap_denied"),
  ]);
  rule("output", "jump budgeted", [{ jump: { target: "budgeted" } }]);
  lines.push("}");
  chain("input", "input");
  rule("input", "iifname lo accept", [match(meta("iifname"), "lo"), { accept: null }]);
  if (value.killSwitch) rule("input", "counter name killed drop", drop("killed"));
  for (const family of ["ip", "ip6"] as const) {
    const addresses = host.addresses.filter((x) => isIP(x) === (family === "ip" ? 4 : 6));
    if (addresses.length)
      rule(
        "input",
        `ether saddr ${host.mac} ${family} saddr ${words(addresses)} meta l4proto tcp tcp dport ${words(host.tcpPorts)} ct state { new, established } ct mark set ${host.conntrackMark} accept`,
        [
          match(payload("ether", "saddr"), host.mac),
          match(payload(family, "saddr"), set(addresses)),
          match(payload("tcp", "dport"), set(host.tcpPorts)),
          match(ct("state"), { set: ["new", "established"] }, "in"),
          { mangle: { key: ct("mark"), value: host.conntrackMark } },
          { accept: null },
        ],
      );
  }
  rule("input", `ip saddr { ${V4.join(", ")} } counter name private_denied drop`, [
    match(payload("ip", "saddr"), prefixes(V4)),
    ...drop("private_denied"),
  ]);
  rule("input", `ip6 saddr { ${V6.join(", ")} } counter name private_denied drop`, [
    match(payload("ip6", "saddr"), prefixes(V6)),
    ...drop("private_denied"),
  ]);
  rule("input", "ct state { established, related } ct direction reply accept", [
    match(ct("state"), { set: ["established", "related"] }, "in"),
    match(ct("direction"), "reply"),
    { accept: null },
  ]);
  rule("input", "counter name input_denied drop", drop("input_denied"));
  lines.push("}");
  chain("forward", "forward", -310);
  rule("forward", "counter name forward_denied drop", drop("forward_denied"));
  lines.push("}", "}");
  const plan = Object.freeze({
    namespace: Object.freeze({ ...value.namespace }),
    table: value.table,
    script: `${lines.join("\n")}\n`,
    policyDigest: p.policyDigest,
  });
  compiled.set(plan, structuredClone(expected));
  return plan;
}

function verify(plan: LinuxDockerGuestEgressPlan, text: string): LinuxDockerGuestEgressReadback {
  const expected = compiled.get(plan);
  if (!expected || Buffer.byteLength(text) > 1024 * 1024) return fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail();
  }
  if (!isJsonObject(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.nftables))
    return fail();
  const objects: unknown[] = [],
    counters: Record<string, { packets: number; bytes: number }> = Object.create(null);
  const keys: Record<string, readonly string[]> = {
    table: ["family", "name", "flags", "handle"],
    chain: ["family", "table", "name", "type", "hook", "prio", "policy", "handle"],
    rule: ["family", "table", "chain", "expr", "comment", "handle"],
    counter: ["family", "table", "name", "packets", "bytes", "handle"],
    quota: ["family", "table", "name", "bytes", "inv", "used", "handle"],
  };
  let quotaUsedBytes: number | null = null;
  let metadata = 0;
  for (const item of parsed.nftables) {
    if (!isJsonObject(item) || Object.keys(item).length !== 1) return fail();
    if (Object.hasOwn(item, "metainfo")) {
      if (++metadata > 1 || !isJsonObject(item.metainfo)) return fail();
      continue;
    }
    const [kind, body] = Object.entries(item)[0] ?? [];
    if (
      !kind ||
      !isJsonObject(body) ||
      !keys[kind] ||
      Object.keys(body).some((key) => !keys[kind]?.includes(key))
    )
      return fail();
    const { handle, ...normalized }: Record<string, unknown> = body;
    if (handle !== undefined && (!integer(handle) || handle < 1)) return fail();
    if (kind === "table" && Object.hasOwn(normalized, "flags")) {
      if (!Array.isArray(normalized.flags) || normalized.flags.length) return fail();
      delete normalized.flags;
    }
    if (kind === "counter") {
      if (
        typeof normalized.name !== "string" ||
        !integer(normalized.packets) ||
        !integer(normalized.bytes) ||
        Object.hasOwn(counters, normalized.name)
      )
        return fail();
      counters[normalized.name] = Object.freeze({
        packets: normalized.packets,
        bytes: normalized.bytes,
      });
      delete normalized.packets;
      delete normalized.bytes;
    }
    if (kind === "quota" && Object.hasOwn(normalized, "used")) {
      if (!integer(normalized.used)) return fail();
      quotaUsedBytes = normalized.used;
      delete normalized.used;
    }
    objects.push({ [kind]: normalized });
  }
  if (canonicalObjects(objects) !== canonicalObjects(expected)) return fail();
  return Object.freeze({
    table: plan.table,
    namespace: plan.namespace.selected,
    structuralDigest: hash(JSON.parse(canonicalObjects(objects))),
    counters: Object.freeze(counters),
    quotaUsedBytes,
    counterUnit: "kernel-skb-bytes-at-inet-output",
  });
}
async function current(
  plan: LinuxDockerGuestEgressPlan,
  port: LinuxContainerEgressPort,
): Promise<void> {
  if (!compiled.has(plan) || (await port.namespace()) !== plan.namespace.selected) return fail();
}
/** Called only inside the original owner-held physical lifecycle. A transport
 * callback returning data is not physical qualification or accepted authority. */
const installations = new WeakMap<
  LinuxDockerGuestEgressPlan,
  {
    readonly port: LinuxContainerEgressPort;
    readonly pending: Promise<LinuxDockerGuestEgressReadback>;
  }
>();
export function installLinuxDockerGuestEgress(
  plan: LinuxDockerGuestEgressPlan,
  port: LinuxContainerEgressPort,
): Promise<LinuxDockerGuestEgressReadback> {
  const previous = installations.get(plan);
  if (previous)
    return previous.port === port
      ? previous.pending
      : Promise.reject(new Error("linux_docker_guest_egress_unavailable"));
  // Register before any awaited work. A rejected/unknown apply stays terminal
  // for this plan; durable cross-process attempts belong to the lifecycle owner.
  const pending = Promise.resolve().then(async () => {
    await current(plan, port);
    await port.execute({ argv: ["nft", "--check", "-f", "-"], stdin: plan.script });
    await current(plan, port);
    await port.execute({ argv: ["nft", "-f", "-"], stdin: plan.script });
    return readLinuxDockerGuestEgress(plan, port);
  });
  installations.set(plan, { port, pending });
  return pending;
}

export async function readLinuxDockerGuestEgress(
  plan: LinuxDockerGuestEgressPlan,
  port: LinuxContainerEgressPort,
): Promise<LinuxDockerGuestEgressReadback> {
  await current(plan, port);
  const text = await port.execute({ argv: ["nft", "-j", "list", "table", "inet", plan.table] });
  const result = verify(plan, text);
  await current(plan, port);
  return result;
}

/** Kernel facts only. An owned deny is never an authority/ready flag. The
 * original full ruleset, quota and counters must still verify byte-for-semantics
 * after removing only a bounded unconditional lifetime-deny prefix. */
export async function readLinuxDockerGuestEgressLifetime(
  plan: LinuxDockerGuestEgressPlan,
  port: LinuxContainerEgressPort,
) {
  await current(plan, port);
  const text = await port.execute({ argv: ["nft", "-j", "list", "table", "inet", plan.table] });
  if (Buffer.byteLength(text) > 1024 * 1024) return fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail();
  }
  if (!isJsonObject(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.nftables))
    return fail();
  const kept: unknown[] = [],
    handles: number[] = [];
  let normalOutput = false;
  for (const item of parsed.nftables) {
    const rule = isJsonObject(item) ? item.rule : undefined;
    if (isJsonObject(item) && isJsonObject(rule) && rule.comment === "guest_lifetime_closed") {
      if (
        normalOutput ||
        Object.keys(item).length !== 1 ||
        Object.keys(rule).sort().join() !==
          ["family", "table", "chain", "expr", "comment", "handle"].sort().join() ||
        rule.family !== "inet" ||
        rule.table !== plan.table ||
        rule.chain !== "output" ||
        !integer(rule.handle) ||
        rule.handle < 1 ||
        handles.includes(rule.handle) ||
        handles.length >= 8 ||
        canonicalJson(rule.expr) !== canonicalJson([{ counter: "killed" }, { drop: null }])
      )
        return fail();
      handles.push(rule.handle);
      continue;
    }
    if (
      isJsonObject(rule) &&
      rule.family === "inet" &&
      rule.table === plan.table &&
      rule.chain === "output"
    )
      normalOutput = true;
    kept.push(item);
  }
  const readback = verify(plan, JSON.stringify({ nftables: kept }));
  await current(plan, port);
  return Object.freeze({ readback, denyHandles: Object.freeze(handles) });
}
