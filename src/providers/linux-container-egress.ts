import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { evaluateContainerEgress } from "../container-egress-policy.ts";
import type { DockerContainerRuntimePolicy } from "./docker-container-runtime-preparation.ts";

/** Host-only, partial native packet evidence. This does not grant runtime coverage. */
export interface LinuxContainerEgressInput {
  readonly namespace: { readonly parent: string; readonly selected: string };
  readonly table: string;
  readonly killSwitch: boolean;
  /** Host-only opt-in. Observed metadata is NOT proof of physical ownership or
   * Host placement. A real prepare/recover producer must hold that authority.
   * All local processes in the selected Engine-host netns must be trusted.
   */
  readonly hostHttp?: readonly LinuxContainerHostHttpBridge[];
  readonly tenants: readonly {
    readonly authority: DockerContainerRuntimePolicy;
    readonly interfaces: readonly string[];
    readonly maxConnections: number;
    /** Native skb bytes, deliberately distinct from Form send bytes and billing. */
    readonly packetLimitBytes: number;
  }[];
}

export interface LinuxContainerHostHttpBridge {
  readonly tenantRef: string;
  readonly generation: number;
  readonly networkId: string;
  readonly bridge: string;
  readonly ifindex: number;
  readonly hostMac: string;
  readonly hostAddresses: readonly string[];
  readonly tcpPorts: readonly number[];
  /** Host-reserved token, never reused while the previous conntrack is live. */
  readonly conntrackMark: number;
}

export interface LinuxContainerEgressPlan extends LinuxContainerEgressInput {
  readonly script: string;
  readonly ruleTags: readonly string[];
  readonly ruleExpressions: readonly (readonly unknown[])[];
  readonly fullRuntimeCoverage: false;
  readonly counterUnit: "kernel-skb-bytes-at-inet-forward";
  readonly bridgeRules?: {
    readonly table: string;
    readonly ruleTags: readonly string[];
    readonly ruleExpressions: readonly (readonly unknown[])[];
  };
}

export interface LinuxContainerEgressPort {
  namespace(): Promise<string>;
  execute(command: { readonly argv: readonly string[]; readonly stdin?: string }): Promise<string>;
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
  ...V4.map((prefix) => {
    const [address, bits] = prefix.split("/");
    return `::ffff:${address}/${96 + Number(bits)}`;
  }),
];
const SHA = /^sha256:[a-f0-9]{64}$/u;
const NETNS = /^net:\[[0-9]+\]$/u;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,14}$/u;
const BRIDGE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,14}$/u;
function fail(): never {
  throw new Error("linux_container_egress_unavailable");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function hostAddress(address: unknown): address is string {
  if (typeof address !== "string" || !isIP(address) || address.includes("%")) return false;
  if (isIP(address) === 4) {
    const first = Number(address.split(".")[0]);
    return first !== 0 && first !== 127 && first < 224;
  }
  return (
    address !== "::" &&
    address !== "::1" &&
    !address.startsWith("ff") &&
    !address.startsWith("::ffff:") &&
    new URL(`http://[${address}]/`).hostname === `[${address}]`
  );
}

function validateHostHttp(
  value: LinuxContainerEgressInput,
): readonly LinuxContainerHostHttpBridge[] | undefined {
  const bridges = value.hostHttp;
  if (bridges === undefined) return;
  if (!Array.isArray(bridges) || bridges.length < 1 || bridges.length > 64) fail();
  const interfaces = value.tenants.flatMap((tenant) => tenant.interfaces);
  const unique = [
    new Set<string>(),
    new Set<string>(),
    new Set<number>(),
    new Set<number>(),
  ] as const;
  for (const bridge of bridges as readonly LinuxContainerHostHttpBridge[]) {
    if (
      !record(bridge) ||
      Object.keys(bridge).length !== 9 ||
      Object.keys(bridge).some(
        (key) =>
          ![
            "tenantRef",
            "generation",
            "networkId",
            "bridge",
            "ifindex",
            "hostMac",
            "hostAddresses",
            "tcpPorts",
            "conntrackMark",
          ].includes(key),
      )
    )
      fail();
    const tenant = value.tenants.find((item) => item.authority.tenantRef === bridge.tenantRef);
    if (
      !tenant ||
      tenant.authority.generation !== bridge.generation ||
      !tenant.interfaces.includes(bridge.bridge) ||
      typeof bridge.networkId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(bridge.networkId) ||
      !Number.isSafeInteger(bridge.ifindex) ||
      bridge.ifindex < 1 ||
      bridge.ifindex > 0x7fffffff ||
      typeof bridge.hostMac !== "string" ||
      !/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/u.test(bridge.hostMac) ||
      bridge.hostMac === "00:00:00:00:00:00" ||
      (Number.parseInt(bridge.hostMac.slice(0, 2), 16) & 1) !== 0 ||
      !Number.isSafeInteger(bridge.conntrackMark) ||
      bridge.conntrackMark < 1 ||
      bridge.conntrackMark > 0xffffffff ||
      !Array.isArray(bridge.hostAddresses) ||
      bridge.hostAddresses.length < 1 ||
      bridge.hostAddresses.length > 8 ||
      new Set(bridge.hostAddresses).size !== bridge.hostAddresses.length ||
      bridge.hostAddresses.some((address) => !hostAddress(address)) ||
      !Array.isArray(bridge.tcpPorts) ||
      bridge.tcpPorts.length < 1 ||
      bridge.tcpPorts.length > 64 ||
      new Set(bridge.tcpPorts).size !== bridge.tcpPorts.length ||
      bridge.tcpPorts.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535) ||
      unique[0].has(bridge.bridge) ||
      unique[1].has(bridge.networkId) ||
      unique[2].has(bridge.ifindex) ||
      unique[3].has(bridge.conntrackMark)
    )
      fail();
    unique[0].add(bridge.bridge);
    unique[1].add(bridge.networkId);
    unique[2].add(bridge.ifindex);
    unique[3].add(bridge.conntrackMark);
  }
  if (interfaces.length !== bridges.length) fail();
  return bridges;
}

const payload = (protocol: string, field: string) => ({ payload: { protocol, field } });
const meta = (key: string) => ({ meta: { key } });
const ct = (key: string, dir?: "original" | "reply", family?: "ip" | "ip6") => ({
  // libnftables JSON includes the address family in the CT key token.
  ct: { key: family ? `${family} ${key}` : key, ...(dir ? { dir } : {}) },
});
const match = (left: unknown, right: unknown, op = "==") => ({ match: { op, left, right } });
const setValue = (values: readonly unknown[]) =>
  values.length === 1 ? values[0] : { set: values };
const setText = (values: readonly (string | number)[]) =>
  values.length === 1 ? String(values[0]) : `{ ${values.join(", ")} }`;

export function compileLinuxContainerEgress(
  input: LinuxContainerEgressInput,
): LinuxContainerEgressPlan {
  const value = structuredClone(input);
  if (
    !NETNS.test(value.namespace.parent) ||
    !NETNS.test(value.namespace.selected) ||
    value.namespace.parent === value.namespace.selected ||
    !/^takos_cx_[a-z0-9_]{1,40}$/u.test(value.table) ||
    typeof value.killSwitch !== "boolean" ||
    !Array.isArray(value.tenants) ||
    value.tenants.length < 1 ||
    value.tenants.length > 64
  )
    fail();
  const interfaces = new Set<string>();
  const tenants = new Set<string>();
  for (const tenant of value.tenants) {
    const policy = tenant.authority;
    if (
      !policy ||
      typeof policy.tenantRef !== "string" ||
      policy.tenantRef.length < 1 ||
      policy.tenantRef.length > 256 ||
      tenants.has(policy.tenantRef) ||
      !Number.isSafeInteger(policy.generation) ||
      policy.generation < 1 ||
      !SHA.test(policy.policyDigest) ||
      typeof policy.outboundInternet !== "boolean" ||
      !integer(tenant.maxConnections) ||
      tenant.maxConnections > 65535 ||
      !integer(tenant.packetLimitBytes) ||
      !Array.isArray(tenant.interfaces) ||
      tenant.interfaces.length < 1 ||
      tenant.interfaces.length > 64
    )
      fail();
    tenants.add(policy.tenantRef);
    for (const name of tenant.interfaces) {
      if (
        !(value.hostHttp === undefined ? NAME : BRIDGE_NAME).test(name) ||
        name === "lo" ||
        interfaces.has(name)
      )
        fail();
      interfaces.add(name);
    }
  }
  const hostHttp = validateHostHttp(value);
  // CREATE is exclusive; nft expands nested table bodies only for ADD.
  const lines = [
    `create table inet ${value.table}`,
    ...(hostHttp ? [`create table bridge ${value.table}_bridge`] : []),
    `table inet ${value.table} {`,
    "set disabled { type ifname; }",
    "counter killed { }",
    "counter host_denied { }",
  ];
  const tags: string[] = [];
  const expressions: unknown[][] = [];
  if (hostHttp) lines.push("set outbound_denied { type ifname; }", "counter host_replies { }");
  function rule(chain: string, expression: string, ast: unknown[]): void {
    const tag = `cx_${tags.length}`;
    tags.push(`${chain}:${tag}`);
    expressions.push(ast);
    lines.push(`${expression} comment "${tag}"`);
  }
  const drop = (counter: string) => [{ counter }, { drop: null }];
  const prefixes = (values: readonly string[]) => ({
    set: values.map((value) => {
      const [addr, length] = value.split("/");
      const len = Number(length);
      return len === 128 ? addr : { prefix: { addr, len } };
    }),
  });
  for (const [index, tenant] of value.tenants.entries()) {
    for (const name of ["accepted", "denied", "cap_denied"])
      lines.push(`counter ${name}${index} { }`);
    lines.push(`quota q${index} { over ${tenant.packetLimitBytes} bytes; }`);
    lines.push(`chain t${index} {`);
    rule(`t${index}`, `ip daddr { ${V4.join(", ")} } counter name denied${index} drop`, [
      match(payload("ip", "daddr"), prefixes(V4)),
      ...drop(`denied${index}`),
    ]);
    rule(`t${index}`, `ip6 daddr { ${V6.join(", ")} } counter name denied${index} drop`, [
      match(payload("ip6", "daddr"), prefixes(V6)),
      ...drop(`denied${index}`),
    ]);
    rule(`t${index}`, `meta l4proto tcp tcp dport 25 counter name denied${index} drop`, [
      match(payload("tcp", "dport"), 25),
      ...drop(`denied${index}`),
    ]);
    rule(`t${index}`, `meta l4proto != { tcp, udp } counter name denied${index} drop`, [
      match(meta("l4proto"), { set: ["tcp", "udp"] }, "!="),
      ...drop(`denied${index}`),
    ]);
    rule(
      `t${index}`,
      `ct count over ${tenant.maxConnections} counter name cap_denied${index} drop`,
      [{ "ct count": { val: tenant.maxConnections, inv: true } }, ...drop(`cap_denied${index}`)],
    );
    rule(`t${index}`, `quota name q${index} counter name cap_denied${index} drop`, [
      { quota: `q${index}` },
      ...drop(`cap_denied${index}`),
    ]);
    rule(`t${index}`, `counter name accepted${index} accept`, [
      { counter: `accepted${index}` },
      { accept: null },
    ]);
    lines.push("}");
  }
  for (const chain of ["input", "forward"]) {
    lines.push(`chain ${chain} { type filter hook ${chain} priority -10; policy accept;`);
    rule(chain, "iifname @disabled counter name killed drop", [
      match(meta("iifname"), "@disabled"),
      ...drop("killed"),
    ]);
    for (const [index, tenant] of value.tenants.entries())
      for (const name of tenant.interfaces) {
        if (chain === "input") {
          const bridge = hostHttp?.find((item) => item.bridge === name);
          if (bridge)
            for (const family of ["ip", "ip6"] as const) {
              const addresses = bridge.hostAddresses.filter(
                (address) => isIP(address) === (family === "ip" ? 4 : 6),
              );
              if (!addresses.length) continue;
              rule(
                chain,
                `iifname "${name}" iif ${bridge.ifindex} ct state established ct direction reply ct mark ${bridge.conntrackMark} ct original protocol tcp ct original ${family} saddr ${setText(addresses)} ct original proto-dst ${setText(bridge.tcpPorts)} counter name host_replies accept`,
                [
                  match(meta("iifname"), name),
                  match(meta("iif"), bridge.ifindex),
                  match(ct("state"), "established", "in"),
                  match(ct("direction"), "reply"),
                  match(ct("mark"), bridge.conntrackMark),
                  match(ct("protocol"), "tcp"),
                  match(ct("saddr", "original", family), setValue(addresses)),
                  match(ct("proto-dst", "original"), setValue(bridge.tcpPorts)),
                  { counter: "host_replies" },
                  { accept: null },
                ],
              );
            }
          // Necessary native neighbor discovery is not workload TCP/UDP egress.
          rule(
            chain,
            `iifname "${name}" meta l4proto ipv6-icmp icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept`,
            [
              match(meta("iifname"), name),
              match(payload("icmpv6", "type"), {
                set: ["nd-neighbor-solicit", "nd-neighbor-advert"],
              }),
              match(payload("ip6", "hoplimit"), 255),
              { accept: null },
            ],
          );
          rule(chain, `iifname "${name}" counter name host_denied drop`, [
            match(meta("iifname"), name),
            ...drop("host_denied"),
          ]);
        } else {
          if (hostHttp)
            rule(
              chain,
              `iifname "${name}" iifname @outbound_denied counter name denied${index} drop`,
              [
                match(meta("iifname"), name),
                match(meta("iifname"), "@outbound_denied"),
                ...drop(`denied${index}`),
              ],
            );
          rule(chain, `iifname "${name}" jump t${index}`, [
            match(meta("iifname"), name),
            { jump: { target: `t${index}` } },
          ]);
        }
      }
    lines.push("}");
  }
  if (hostHttp) {
    lines.push("chain output { type filter hook output priority -10; policy accept;");
    rule("output", "oifname @disabled counter name killed drop", [
      match(meta("oifname"), "@disabled"),
      ...drop("killed"),
    ]);
    for (const bridge of hostHttp)
      for (const family of ["ip", "ip6"] as const) {
        const addresses = bridge.hostAddresses.filter(
          (address) => isIP(address) === (family === "ip" ? 4 : 6),
        );
        if (!addresses.length) continue;
        rule(
          "output",
          `oifname "${bridge.bridge}" oif ${bridge.ifindex} ct state new ct direction original ct original protocol tcp ${family} saddr ${setText(addresses)} ct original ${family} saddr ${setText(addresses)} tcp dport ${setText(bridge.tcpPorts)} ct original proto-dst ${setText(bridge.tcpPorts)} ct mark set ${bridge.conntrackMark}`,
          [
            match(meta("oifname"), bridge.bridge),
            match(meta("oif"), bridge.ifindex),
            match(ct("state"), "new", "in"),
            match(ct("direction"), "original"),
            match(ct("protocol"), "tcp"),
            match(payload(family, "saddr"), setValue(addresses)),
            match(ct("saddr", "original", family), setValue(addresses)),
            match(payload("tcp", "dport"), setValue(bridge.tcpPorts)),
            match(ct("proto-dst", "original"), setValue(bridge.tcpPorts)),
            { mangle: { key: ct("mark"), value: bridge.conntrackMark } },
          ],
        );
      }
    lines.push("}");
  }
  lines.push("}");
  const disabled = value.tenants
    .filter((tenant) => value.killSwitch || (!hostHttp && !tenant.authority.outboundInternet))
    .flatMap((tenant) => tenant.interfaces);
  if (disabled.length)
    lines.push(
      `add element inet ${value.table} disabled { ${disabled.map((name) => `"${name}"`).join(", ")} }`,
    );
  if (hostHttp) {
    const denied = value.tenants
      .filter((tenant) => !tenant.authority.outboundInternet)
      .flatMap((tenant) => tenant.interfaces);
    if (denied.length)
      lines.push(
        `add element inet ${value.table} outbound_denied { ${denied.map((name) => `"${name}"`).join(", ")} }`,
      );
  }
  const bridgeRules = hostHttp
    ? compileBridgeGuard(value.table, hostHttp, disabled, lines)
    : undefined;
  const plan: LinuxContainerEgressPlan = {
    ...value,
    script: `${lines.join("\n")}\n`,
    ruleTags: tags,
    ruleExpressions: expressions,
    fullRuntimeCoverage: false,
    counterUnit: "kernel-skb-bytes-at-inet-forward",
    ...(bridgeRules ? { bridgeRules } : {}),
  };
  return freeze(plan);
}

function compileBridgeGuard(
  table: string,
  bridges: readonly LinuxContainerHostHttpBridge[],
  disabled: readonly string[],
  lines: string[],
) {
  const name = `${table}_bridge`;
  const ruleTags: string[] = [];
  const ruleExpressions: unknown[][] = [];
  lines.push(
    `table bridge ${name} {`,
    "set disabled { type ifname; }",
    "counter killed { }",
    "counter bridge_denied { }",
  );
  for (const hook of ["prerouting", "input", "forward", "output"]) {
    lines.push(`chain ${hook} { type filter hook ${hook} priority -210; policy accept;`);
    const rule = (text: string, ast: unknown[]) => {
      const tag = `cxb_${ruleTags.length}`;
      ruleTags.push(`${hook}:${tag}`);
      ruleExpressions.push(ast);
      lines.push(`${text} comment "${tag}"`);
    };
    const drop = (counter = "bridge_denied") => [{ counter }, { drop: null }];
    const direction = hook === "output" ? "obrname" : "ibrname";
    rule(`${direction} @disabled counter name killed drop`, [
      match(meta(direction), "@disabled"),
      ...drop("killed"),
    ]);
    if (hook !== "output")
      for (const bridge of bridges) {
        const incoming = match(meta("ibrname"), bridge.bridge);
        const prefix = `ibrname "${bridge.bridge}"`;
        if (hook === "prerouting") {
          rule(`${prefix} ether saddr ${bridge.hostMac} counter name bridge_denied drop`, [
            incoming,
            match(payload("ether", "saddr"), bridge.hostMac),
            ...drop(),
          ]);
          for (const family of ["ip", "ip6"] as const) {
            const addresses = bridge.hostAddresses.filter(
              (address) => isIP(address) === (family === "ip" ? 4 : 6),
            );
            if (addresses.length)
              rule(
                `${prefix} ${family} saddr ${setText(addresses)} counter name bridge_denied drop`,
                [incoming, match(payload(family, "saddr"), setValue(addresses)), ...drop()],
              );
            if (family === "ip" && addresses.length)
              rule(`${prefix} arp saddr ip ${setText(addresses)} counter name bridge_denied drop`, [
                incoming,
                match(payload("arp", "saddr ip"), setValue(addresses)),
                ...drop(),
              ]);
          }
          rule(`${prefix} ether type != { ip, ip6, arp } counter name bridge_denied drop`, [
            incoming,
            match(payload("ether", "type"), { set: ["ip", "ip6", "arp"] }, "!="),
            ...drop(),
          ]);
        } else if (hook === "input") {
          const v4 = bridge.hostAddresses.filter((address) => isIP(address) === 4);
          if (v4.length)
            rule(`${prefix} arp operation { request, reply } arp daddr ip ${setText(v4)} accept`, [
              incoming,
              match(payload("arp", "operation"), { set: ["request", "reply"] }),
              match(payload("arp", "daddr ip"), setValue(v4)),
              { accept: null },
            ]);
          const v6 = bridge.hostAddresses.filter((address) => isIP(address) === 6);
          if (v6.length) {
            const destinations = [
              ...new Set(v6.flatMap((address) => [address, solicitedNode(address)])),
            ];
            rule(
              `${prefix} meta l4proto ipv6-icmp icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 ip6 daddr ${setText(destinations)} accept`,
              [
                incoming,
                match(payload("icmpv6", "type"), {
                  set: ["nd-neighbor-solicit", "nd-neighbor-advert"],
                }),
                match(payload("ip6", "hoplimit"), 255),
                match(payload("ip6", "daddr"), setValue(destinations)),
                { accept: null },
              ],
            );
          }
          // Routed IP still traverses inet INPUT/FORWARD. This is not an L3 grant.
          rule(`${prefix} ether daddr ${bridge.hostMac} ether type { ip, ip6 } accept`, [
            incoming,
            match(payload("ether", "daddr"), bridge.hostMac),
            match(payload("ether", "type"), { set: ["ip", "ip6"] }),
            { accept: null },
          ]);
          rule(`${prefix} counter name bridge_denied drop`, [incoming, ...drop()]);
        } else {
          // Future members cannot bypass routed policy by forwarding at L2.
          rule(`${prefix} counter name bridge_denied drop`, [incoming, ...drop()]);
        }
      }
    lines.push("}");
  }
  lines.push("}");
  if (disabled.length)
    lines.push(
      `add element bridge ${name} disabled { ${disabled.map((item) => `"${item}"`).join(", ")} }`,
    );
  return { table: name, ruleTags, ruleExpressions };
}

function solicitedNode(address: string): string {
  const words = address.split(":").filter(Boolean);
  const halves = address.split("::");
  const left = halves[0]?.split(":").filter(Boolean) ?? [];
  const right = halves[1]?.split(":").filter(Boolean) ?? [];
  const full =
    halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
      : words;
  const suffix = `${(0xff00 | (Number.parseInt(full[6] ?? "0", 16) & 0xff)).toString(16)}:${Number.parseInt(full[7] ?? "0", 16).toString(16)}`;
  return new URL(`http://[ff02::1:${suffix}]/`).hostname.slice(1, -1);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Reuse the actual policy evaluator; no separate policy verdict implementation. */
export function linuxContainerEgressAllows(
  plan: LinuxContainerEgressPlan,
  tenantRef: string,
  destinationIp: string,
  destinationPort: number,
  transport: "tcp" | "udp",
): boolean {
  const tenant = plan.tenants.find((candidate) => candidate.authority.tenantRef === tenantRef);
  if (!tenant) return false;
  return evaluateContainerEgress({
    policy: {
      killSwitch: plan.killSwitch,
      tenants: {
        [tenantRef]: {
          outboundInternet: tenant.authority.outboundInternet,
          maxConnections: tenant.maxConnections,
          bandwidthLimitBytes: tenant.packetLimitBytes,
        },
      },
    },
    usage: {},
    request: {
      tenantId: tenantRef,
      operation: "open",
      destinationIp,
      destinationPort,
      transport,
      bytes: 0,
    },
  }).allowed;
}

/** Only the selected owned table can be mutated by this generated transaction. */
export function linuxContainerEgressKillScript(
  plan: LinuxContainerEgressPlan,
  tenantRef: string,
): string {
  const tenant = plan.tenants.find((value) => value.authority.tenantRef === tenantRef);
  if (!tenant) fail();
  const elements = tenant.interfaces.map((name) => `"${name}"`).join(", ");
  return `add element inet ${plan.table} disabled { ${elements} }\n${plan.bridgeRules ? `add element bridge ${plan.bridgeRules.table} disabled { ${elements} }\n` : ""}`;
}

/** Normalize native kernel AST for later drift detection; counter values are not topology. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!record(value)) return value;
  if (Object.keys(value).length === 1 && Array.isArray(value.set)) {
    return {
      set: value.set
        .map(stable)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    };
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["handle", "packets", "bytes", "used"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

export function verifyLinuxContainerEgressReadback(
  plan: LinuxContainerEgressPlan,
  readback: unknown,
  expectedStructureDigest?: string,
  killedTenants: readonly string[] = [],
) {
  if (plan.hostHttp)
    return verifyHostReadback(plan, readback, expectedStructureDigest, killedTenants);
  if (!record(readback) || !Array.isArray(readback.nftables)) fail();
  const objects = readback.nftables.filter(
    (entry): entry is Record<string, unknown> => record(entry) && !("metainfo" in entry),
  );
  const tables = objects.filter((entry) => record(entry.table));
  const table = tables[0]?.table;
  if (tables.length !== 1 || !record(table) || table.name !== plan.table || table.family !== "inet")
    fail();
  // A dormant table retains its complete rule AST while unregistering its hooks.
  // Refuse compiler-unemitted attributes before accepting an initial baseline.
  if (
    Object.keys(table).some((key) => !["family", "name", "handle", "flags"].includes(key)) ||
    (Object.hasOwn(table, "flags") && (!Array.isArray(table.flags) || table.flags.length !== 0)) ||
    (Object.hasOwn(table, "handle") &&
      (!Number.isSafeInteger(table.handle) || (table.handle as number) < 1))
  )
    fail();
  for (const entry of objects)
    for (const [kind, body] of Object.entries(entry)) {
      if (
        !record(body) ||
        !["table", "chain", "set", "counter", "quota", "rule"].includes(kind) ||
        body.family !== "inet" ||
        (kind !== "table" && body.table !== plan.table)
      )
        fail();
    }
  const chains = objects.flatMap((entry) => (record(entry.chain) ? [entry.chain] : []));
  if (chains.length !== plan.tenants.length + 2) fail();
  for (const hook of ["input", "forward"]) {
    const chain = chains.find((value) => value.name === hook);
    if (
      chain?.type !== "filter" ||
      chain.hook !== hook ||
      chain.prio !== -10 ||
      chain.policy !== "accept"
    )
      fail();
  }
  const rules = objects.flatMap((entry) => (record(entry.rule) ? [entry.rule] : []));
  const tags = rules.map((rule) => `${String(rule.chain)}:${String(rule.comment)}`);
  if (
    tags.length !== plan.ruleTags.length ||
    new Set(tags).size !== tags.length ||
    JSON.stringify(tags) !== JSON.stringify(plan.ruleTags) ||
    rules.some(
      (rule, index) =>
        JSON.stringify(stable(rule.expr)) !== JSON.stringify(stable(plan.ruleExpressions[index])),
    )
  )
    fail();
  const quotas = objects.flatMap((entry) => (record(entry.quota) ? [entry.quota] : []));
  if (quotas.length !== plan.tenants.length) fail();
  for (const [index, tenant] of plan.tenants.entries()) {
    const quota = quotas.find((value) => value.name === `q${index}`);
    if (!quota || quota.bytes !== tenant.packetLimitBytes || quota.inv !== true) fail();
  }
  const sets = objects.flatMap((entry) => (record(entry.set) ? [entry.set] : []));
  const disabled = sets[0];
  if (sets.length !== 1 || !disabled || disabled.name !== "disabled" || disabled.type !== "ifname")
    fail();
  const expectedDisabled = plan.tenants
    .filter(
      (value) =>
        plan.killSwitch ||
        !value.authority.outboundInternet ||
        killedTenants.includes(value.authority.tenantRef),
    )
    .flatMap((value) => value.interfaces)
    .sort();
  const actualDisabled = disabled.elem === undefined ? [] : disabled.elem;
  if (
    !Array.isArray(actualDisabled) ||
    JSON.stringify([...actualDisabled].sort()) !== JSON.stringify(expectedDisabled)
  )
    fail();
  const normalized = objects.map((entry) => {
    if (!record(entry.set)) return stable(entry);
    const { elem: _elements, ...rest } = entry.set;
    return stable({ set: rest });
  });
  const structuralDigest = hash(normalized);
  if (expectedStructureDigest !== undefined && structuralDigest !== expectedStructureDigest) fail();
  const counters = objects.flatMap((entry) => (record(entry.counter) ? [entry.counter] : []));
  if (
    counters.length !== plan.tenants.length * 3 + 2 ||
    counters.some(
      (counter) => !integer(counter.bytes as number) || !integer(counter.packets as number),
    )
  )
    fail();
  return {
    table: plan.table,
    namespace: plan.namespace.selected,
    structuralDigest,
    counters,
    fullRuntimeCoverage: false as const,
    billingQualified: false as const,
    counterUnit: plan.counterUnit,
  };
}

/** Strict opt-in schema; legacy readback/bytes remain unchanged. */
function hostObjects(plan: LinuxContainerEgressPlan, killed: readonly string[]) {
  const bridge = plan.bridgeRules;
  if (
    !bridge ||
    !plan.hostHttp ||
    new Set(killed).size !== killed.length ||
    killed.some((ref) => !plan.tenants.some((tenant) => tenant.authority.tenantRef === ref))
  )
    fail();
  const objects: Record<string, unknown>[] = [];
  const disabled = plan.tenants
    .filter((tenant) => plan.killSwitch || killed.includes(tenant.authority.tenantRef))
    .flatMap((tenant) => tenant.interfaces);
  for (const [family, table] of [
    ["inet", plan.table],
    ["bridge", bridge.table],
  ] as const) {
    const common = { family, table };
    objects.push({ table: { family, name: table } });
    objects.push({ set: { ...common, name: "disabled", type: "ifname", elem: disabled } });
    if (family === "inet") {
      objects.push({
        set: {
          ...common,
          name: "outbound_denied",
          type: "ifname",
          elem: plan.tenants
            .filter((tenant) => !tenant.authority.outboundInternet)
            .flatMap((tenant) => tenant.interfaces),
        },
      });
      for (const name of [
        "killed",
        "host_denied",
        "host_replies",
        ...plan.tenants.flatMap((_, index) => [
          `accepted${index}`,
          `denied${index}`,
          `cap_denied${index}`,
        ]),
      ])
        objects.push({ counter: { ...common, name } });
      for (const [index, tenant] of plan.tenants.entries()) {
        objects.push({ chain: { ...common, name: `t${index}` } });
        objects.push({
          quota: { ...common, name: `q${index}`, bytes: tenant.packetLimitBytes, inv: true },
        });
      }
    } else
      for (const name of ["killed", "bridge_denied"])
        objects.push({ counter: { ...common, name } });
    for (const hook of family === "inet"
      ? ["input", "forward", "output"]
      : ["prerouting", "input", "forward", "output"])
      objects.push({
        chain: {
          ...common,
          name: hook,
          type: "filter",
          hook,
          prio: family === "inet" ? -10 : -210,
          policy: "accept",
        },
      });
    const rules = family === "inet" ? plan : bridge;
    for (const [index, tag] of rules.ruleTags.entries()) {
      const [chain, comment] = tag.split(":");
      objects.push({ rule: { ...common, chain, comment, expr: rules.ruleExpressions[index] } });
    }
  }
  return objects;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  if (Object.keys(value).length === 1 && Array.isArray(value.set))
    return {
      set: value.set
        .map(canonical)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function sortedObjects(objects: readonly Record<string, unknown>[], omitElements = false) {
  const values = objects
    .map((entry) => {
      if (record(entry.set)) {
        const { elem, ...rest } = entry.set;
        return {
          set: {
            ...rest,
            ...(omitElements ? {} : { elem: Array.isArray(elem) ? [...elem].sort() : elem }),
          },
        };
      }
      return entry;
    })
    .map(canonical);
  // Object declaration order is immaterial; actual rule order is not.
  return [
    ...values
      .filter((entry) => record(entry) && !("rule" in entry))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ...values.filter((entry) => record(entry) && "rule" in entry),
  ];
}

function verifyHostReadback(
  plan: LinuxContainerEgressPlan,
  readback: unknown,
  expectedDigest: string | undefined,
  killed: readonly string[],
) {
  if (!record(readback) || Object.keys(readback).length !== 1 || !Array.isArray(readback.nftables))
    fail();
  const objects: Record<string, unknown>[] = [];
  const counters: Record<string, unknown>[] = [];
  const keys: Record<string, readonly string[]> = {
    table: ["family", "name", "flags", "handle"],
    chain: ["family", "table", "name", "type", "hook", "prio", "policy", "handle"],
    set: ["family", "table", "name", "type", "elem", "handle"],
    rule: ["family", "table", "chain", "expr", "comment", "handle"],
    counter: ["family", "table", "name", "packets", "bytes", "handle"],
    quota: ["family", "table", "name", "bytes", "inv", "used", "handle"],
  };
  for (const entry of readback.nftables) {
    if (!record(entry) || Object.keys(entry).length !== 1) fail();
    if (record(entry.metainfo)) continue;
    const [kind, body] = Object.entries(entry)[0] ?? [];
    if (
      !kind ||
      !record(body) ||
      !keys[kind] ||
      Object.keys(body).some((key) => !keys[kind]?.includes(key))
    )
      fail();
    const { handle, ...normalized } = body;
    if (handle !== undefined && (!Number.isSafeInteger(handle) || (handle as number) < 1)) fail();
    if (kind === "table" && Object.hasOwn(normalized, "flags")) {
      if (!Array.isArray(normalized.flags) || normalized.flags.length) fail();
      delete normalized.flags;
    }
    if (kind === "counter") {
      if (!integer(normalized.bytes as number) || !integer(normalized.packets as number)) fail();
      counters.push({ ...body });
      delete normalized.bytes;
      delete normalized.packets;
    }
    if (kind === "quota" && Object.hasOwn(normalized, "used")) {
      if (!integer(normalized.used as number)) fail();
      delete normalized.used;
    }
    if (kind === "set") {
      if (normalized.elem === undefined) normalized.elem = [];
      if (
        !Array.isArray(normalized.elem) ||
        new Set(normalized.elem).size !== normalized.elem.length ||
        normalized.elem.some((value) => typeof value !== "string")
      )
        fail();
    }
    objects.push({ [kind]: normalized });
  }
  if (
    JSON.stringify(sortedObjects(objects)) !==
    JSON.stringify(sortedObjects(hostObjects(plan, killed)))
  )
    fail();
  const structuralDigest = hash(sortedObjects(objects, true));
  if (expectedDigest !== undefined && structuralDigest !== expectedDigest) fail();
  return {
    table: plan.table,
    namespace: plan.namespace.selected,
    structuralDigest,
    counters,
    fullRuntimeCoverage: false as const,
    billingQualified: false as const,
    counterUnit: plan.counterUnit,
  };
}

/** Representation adapter only; callers must hold the original physical
 * session and validate its actual complete bridge binding before AND after
 * acquiring the JSON. A plan/label/echoed DTO is not that authority. The strict
 * verifier itself deliberately continues refusing symbolic ifindex JSON.
 */
export function normalizeLinuxContainerEgressInterfaceReadback(
  readback: unknown,
  observedBridges: readonly LinuxContainerHostHttpBridge[],
): unknown {
  if (!Array.isArray(observedBridges) || observedBridges.length < 1 || observedBridges.length > 64)
    fail();
  const indices = new Map<string, number>();
  const uniqueIndices = new Set<number>();
  for (const bridge of observedBridges) {
    if (
      !record(bridge) ||
      typeof bridge.bridge !== "string" ||
      !BRIDGE_NAME.test(bridge.bridge) ||
      typeof bridge.ifindex !== "number" ||
      !Number.isSafeInteger(bridge.ifindex) ||
      bridge.ifindex < 1 ||
      bridge.ifindex > 0x7fffffff ||
      indices.has(bridge.bridge) ||
      uniqueIndices.has(bridge.ifindex)
    )
      fail();
    indices.set(bridge.bridge, bridge.ifindex);
    uniqueIndices.add(bridge.ifindex);
  }
  const value: unknown = structuredClone(readback);
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.nftables)) fail();
  for (const entry of value.nftables) {
    if (!record(entry) || Object.keys(entry).length !== 1) fail();
    if (!Object.hasOwn(entry, "rule")) continue;
    if (!record(entry.rule) || !Array.isArray(entry.rule.expr)) fail();
    for (const node of entry.rule.expr) {
      if (!record(node) || !record(node.match)) continue;
      const comparison = node.match;
      if (!record(comparison.left) || !record(comparison.left.meta)) continue;
      const key = comparison.left.meta.key;
      if (key !== "iif" && key !== "oif") continue;
      if (
        Object.keys(node).length !== 1 ||
        Object.keys(comparison).sort().join() !== "left,op,right" ||
        comparison.op !== "==" ||
        Object.keys(comparison.left).length !== 1 ||
        Object.keys(comparison.left.meta).length !== 1
      )
        fail();
      if (typeof comparison.right === "string") {
        const index = indices.get(comparison.right);
        if (index === undefined) fail();
        comparison.right = index;
      } else if (!Number.isSafeInteger(comparison.right) || (comparison.right as number) < 1)
        fail();
    }
  }
  return value;
}

/** Bind each query to its requested table before full aggregate schema checks. */
function ownedTableObjects(readback: unknown, family: "inet" | "bridge", table: string) {
  if (!record(readback) || Object.keys(readback).length !== 1 || !Array.isArray(readback.nftables))
    fail();
  let tables = 0;
  for (const entry of readback.nftables) {
    if (!record(entry) || Object.keys(entry).length !== 1) fail();
    if (record(entry.metainfo)) continue;
    const [kind, body] = Object.entries(entry)[0] ?? [];
    if (
      !kind ||
      !["table", "chain", "set", "counter", "quota", "rule"].includes(kind) ||
      !record(body) ||
      body.family !== family
    )
      fail();
    if (kind === "table") {
      if (body.name !== table) fail();
      tables++;
    } else if (body.table !== table) fail();
  }
  if (tables !== 1) fail();
  return readback.nftables;
}

export async function readLinuxContainerEgress(
  plan: LinuxContainerEgressPlan,
  port: LinuxContainerEgressPort,
  expectedStructureDigest?: string,
) {
  async function guard() {
    if (
      (await port.namespace()) !== plan.namespace.selected ||
      plan.namespace.selected === plan.namespace.parent
    )
      fail();
  }
  await guard();
  const readback: unknown = JSON.parse(
    await port.execute({ argv: ["nft", "-j", "list", "table", "inet", plan.table] }),
  );
  await guard();
  if (plan.bridgeRules) {
    const bridge: unknown = JSON.parse(
      await port.execute({
        argv: ["nft", "-j", "list", "table", "bridge", plan.bridgeRules.table],
      }),
    );
    await guard();
    const inetObjects = ownedTableObjects(readback, "inet", plan.table);
    const bridgeObjects = ownedTableObjects(bridge, "bridge", plan.bridgeRules.table);
    return verifyLinuxContainerEgressReadback(
      plan,
      {
        nftables: [...inetObjects, ...bridgeObjects],
      },
      expectedStructureDigest,
    );
  }
  return verifyLinuxContainerEgressReadback(plan, readback, expectedStructureDigest);
}

export async function applyLinuxContainerEgress(
  plan: LinuxContainerEgressPlan,
  port: LinuxContainerEgressPort,
) {
  async function guard() {
    if (
      (await port.namespace()) !== plan.namespace.selected ||
      plan.namespace.selected === plan.namespace.parent
    )
      fail();
  }
  await guard();
  await port.execute({ argv: ["nft", "--check", "-f", "-"], stdin: plan.script });
  await guard();
  await port.execute({ argv: ["nft", "-f", "-"], stdin: plan.script });
  await guard();
  return readLinuxContainerEgress(plan, port);
}

/** Shared bridge anti-spoof only. Guest namespaces retain their own policy and
 * quota. This plan is kernel syntax, never accepted owner authority. */
export interface LinuxContainerSharedBridgeGuardPlan {
  readonly namespace: string;
  readonly table: string;
  readonly script: string;
  readonly bridge: LinuxContainerHostHttpBridge;
}
const sharedBridgeObjects = new WeakMap<
  LinuxContainerSharedBridgeGuardPlan,
  readonly Record<string, unknown>[]
>();
export function compileLinuxContainerSharedBridgeGuard(input: {
  readonly namespace: string;
  readonly table: string;
  readonly bridge: LinuxContainerHostHttpBridge;
  readonly policy: LinuxContainerEgressInput["tenants"][number]["authority"];
}): LinuxContainerSharedBridgeGuardPlan {
  const value = structuredClone(input),
    b = value.bridge,
    policy = value.policy;
  if (
    !NETNS.test(value.namespace) ||
    !b ||
    !policy ||
    !BRIDGE_NAME.test(b.bridge) ||
    value.table !== `takos_cx_${b.networkId.slice(0, 32)}` ||
    typeof policy.tenantRef !== "string" ||
    !policy.tenantRef ||
    !integer(policy.generation) ||
    policy.generation < 1 ||
    !SHA.test(policy.policyDigest) ||
    typeof policy.outboundInternet !== "boolean"
  )
    fail();
  validateHostHttp({
    namespace: { parent: value.namespace, selected: value.namespace },
    table: value.table,
    killSwitch: false,
    tenants: [
      { authority: policy, interfaces: [b.bridge], maxConnections: 0, packetLimitBytes: 0 },
    ],
    hostHttp: [b],
  });
  const lines = [`create table bridge ${value.table}_bridge`];
  const rules = compileBridgeGuard(value.table, [b], [], lines);
  const common = { family: "bridge", table: rules.table };
  const expected: Record<string, unknown>[] = [
    { table: { family: "bridge", name: rules.table } },
    { set: { ...common, name: "disabled", type: "ifname", elem: [] } },
    ...["killed", "bridge_denied"].map((name) => ({ counter: { ...common, name } })),
    ...["prerouting", "input", "forward", "output"].map((hook) => ({
      chain: { ...common, name: hook, type: "filter", hook, prio: -210, policy: "accept" },
    })),
    ...rules.ruleTags.map((tag, index) => {
      const [chain, comment] = tag.split(":");
      return { rule: { ...common, chain, comment, expr: rules.ruleExpressions[index] } };
    }),
  ];
  const plan = freeze({
    namespace: value.namespace,
    table: value.table,
    script: `${lines.join("\n")}\n`,
    bridge: b,
  });
  sharedBridgeObjects.set(plan, expected);
  return plan;
}
export async function readLinuxContainerSharedBridgeGuard(
  plan: LinuxContainerSharedBridgeGuardPlan,
  port: LinuxContainerEgressPort,
) {
  const expected = sharedBridgeObjects.get(plan);
  if (!expected || (await port.namespace()) !== plan.namespace) fail();
  let wire: unknown;
  try {
    wire = JSON.parse(
      await port.execute({
        argv: ["nft", "-j", "list", "table", "bridge", `${plan.table}_bridge`],
      }),
    );
  } catch {
    return fail();
  }
  const value = normalizeLinuxContainerEgressInterfaceReadback(wire, [plan.bridge]);
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.nftables)) fail();
  const objects: Record<string, unknown>[] = [];
  const keys: Record<string, readonly string[]> = {
    table: ["family", "name", "flags", "handle"],
    chain: ["family", "table", "name", "type", "hook", "prio", "policy", "handle"],
    set: ["family", "table", "name", "type", "elem", "handle"],
    rule: ["family", "table", "chain", "expr", "comment", "handle"],
    counter: ["family", "table", "name", "bytes", "packets", "handle"],
  };
  for (const entry of value.nftables) {
    if (!record(entry) || Object.keys(entry).length !== 1) fail();
    if (record(entry.metainfo)) continue;
    const [kind, body] = Object.entries(entry)[0] ?? [];
    if (
      !kind ||
      !record(body) ||
      !keys[kind] ||
      Object.keys(body).some((key) => !keys[kind]?.includes(key))
    )
      fail();
    const { handle, ...normalized } = body;
    if (handle !== undefined && (!Number.isSafeInteger(handle) || Number(handle) < 1)) fail();
    if (kind === "table" && "flags" in normalized) {
      if (!Array.isArray(normalized.flags) || normalized.flags.length) fail();
      delete normalized.flags;
    }
    if (kind === "counter") {
      if (
        typeof normalized.bytes !== "number" ||
        !integer(normalized.bytes) ||
        typeof normalized.packets !== "number" ||
        !integer(normalized.packets)
      )
        fail();
      delete normalized.bytes;
      delete normalized.packets;
    }
    if (kind === "set" && normalized.elem === undefined) normalized.elem = [];
    objects.push({ [kind]: normalized });
  }
  if (
    JSON.stringify(sortedObjects(objects)) !== JSON.stringify(sortedObjects(expected)) ||
    (await port.namespace()) !== plan.namespace
  )
    fail();
  return Object.freeze({
    namespace: plan.namespace,
    table: `${plan.table}_bridge`,
    structuralDigest: hash(sortedObjects(objects)),
  });
}
/** Exclusive table creation only. An unknown result is never re-applied here;
 * callers retain their durable pipeline claim and recover by read-only lookup. */
export async function applyLinuxContainerSharedBridgeGuard(
  plan: LinuxContainerSharedBridgeGuardPlan,
  port: LinuxContainerEgressPort,
) {
  if (!sharedBridgeObjects.has(plan) || (await port.namespace()) !== plan.namespace) fail();
  await port.execute({ argv: ["nft", "--check", "-f", "-"], stdin: plan.script });
  if ((await port.namespace()) !== plan.namespace) fail();
  await port.execute({ argv: ["nft", "-f", "-"], stdin: plan.script });
  return readLinuxContainerSharedBridgeGuard(plan, port);
}
