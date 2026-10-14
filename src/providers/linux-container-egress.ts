import { createHash } from "node:crypto";
import { evaluateContainerEgress } from "../container-egress-policy.ts";
import type { DockerContainerRuntimePolicy } from "./docker-container-runtime-preparation.ts";

/** Host-only, partial native packet evidence. This does not grant runtime coverage. */
export interface LinuxContainerEgressInput {
  readonly namespace: { readonly parent: string; readonly selected: string };
  readonly table: string;
  readonly killSwitch: boolean;
  readonly tenants: readonly {
    readonly authority: DockerContainerRuntimePolicy;
    readonly interfaces: readonly string[];
    readonly maxConnections: number;
    /** Native skb bytes, deliberately distinct from Form send bytes and billing. */
    readonly packetLimitBytes: number;
  }[];
}

export interface LinuxContainerEgressPlan extends LinuxContainerEgressInput {
  readonly script: string;
  readonly ruleTags: readonly string[];
  readonly ruleExpressions: readonly (readonly unknown[])[];
  readonly fullRuntimeCoverage: false;
  readonly counterUnit: "kernel-skb-bytes-at-inet-forward";
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
      if (!NAME.test(name) || name === "lo" || interfaces.has(name)) fail();
      interfaces.add(name);
    }
  }
  const lines = [
    `create table inet ${value.table} {`,
    "set disabled { type ifname; }",
    "counter killed { }",
    "counter host_denied { }",
  ];
  const tags: string[] = [];
  const expressions: unknown[][] = [];
  function rule(chain: string, expression: string, ast: unknown[]): void {
    const tag = `cx_${tags.length}`;
    tags.push(`${chain}:${tag}`);
    expressions.push(ast);
    lines.push(`${expression} comment "${tag}"`);
  }
  const payload = (protocol: string, field: string) => ({ payload: { protocol, field } });
  const meta = (key: string) => ({ meta: { key } });
  const match = (left: unknown, right: unknown, op = "==") => ({ match: { op, left, right } });
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
        } else
          rule(chain, `iifname "${name}" jump t${index}`, [
            match(meta("iifname"), name),
            { jump: { target: `t${index}` } },
          ]);
      }
    lines.push("}");
  }
  lines.push("}");
  const disabled = value.tenants
    .filter((tenant) => value.killSwitch || !tenant.authority.outboundInternet)
    .flatMap((tenant) => tenant.interfaces);
  if (disabled.length)
    lines.push(
      `add element inet ${value.table} disabled { ${disabled.map((name) => `"${name}"`).join(", ")} }`,
    );
  const plan: LinuxContainerEgressPlan = {
    ...value,
    script: `${lines.join("\n")}\n`,
    ruleTags: tags,
    ruleExpressions: expressions,
    fullRuntimeCoverage: false,
    counterUnit: "kernel-skb-bytes-at-inet-forward",
  };
  return freeze(plan);
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
  return `add element inet ${plan.table} disabled { ${tenant.interfaces.map((name) => `"${name}"`).join(", ")} }\n`;
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
  const readback: unknown = JSON.parse(
    await port.execute({ argv: ["nft", "-j", "list", "table", "inet", plan.table] }),
  );
  await guard();
  return verifyLinuxContainerEgressReadback(plan, readback);
}
