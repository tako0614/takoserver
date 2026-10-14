import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";

// T-1 describes a candidate pure policy boundary, not the current Container runtime.
// Replace the next binding with one evaluator import when that implementation exists.
const evaluateContainerEgress: EgressEvaluator = mockEvaluateContainerEgress;

// Bandwidth means bytes admitted in a caller-supplied accounting window. There is no
// clock or window reset here. Each send is atomic: a refused send transmits/meters zero
// bytes; accepted sends meter raw outbound bytes without rounding or applying a tariff.
// Opening a connection consumes one slot and no bytes. Sending on an existing connection
// consumes no new slot. The latest kill switch and outboundInternet policy apply to
// every operation, including sends on connections admitted before a policy change.
// Only the requesting tenant's counters change. Unknown tenants fail closed. Limits
// include their endpoint: maxConnections=0 forbids opens; bandwidthLimitBytes=0 permits
// a zero-byte send. Omitted outboundInternet is false, matching the candidate Form.
type TenantPolicy = {
  readonly outboundInternet?: boolean;
  readonly maxConnections: number;
  readonly bandwidthLimitBytes: number;
};

type Policy = {
  readonly killSwitch: boolean;
  readonly tenants: Readonly<Record<string, TenantPolicy>>;
};

type TenantUsage = {
  readonly activeConnections: number;
  readonly bandwidthUsedBytes: number;
  readonly egressBytes: number;
};

type Usage = Readonly<Record<string, TenantUsage>>;

type EgressRequest = {
  readonly tenantId: string;
  readonly operation: "open" | "send";
  readonly destinationIp: string;
  readonly destinationPort: number;
  readonly transport: "tcp" | "udp";
  readonly bytes: number;
};

type VerdictReason =
  | "allowed"
  | "kill_switch"
  | "unknown_tenant"
  | "outbound_disabled"
  | "invalid_input"
  | "invalid_address"
  | "blocked_address"
  | "blocked_tcp_port"
  | "connection_limit"
  | "connection_not_open"
  | "bandwidth_limit"
  | "accounting_overflow";

type Evaluation = {
  readonly allowed: boolean;
  readonly reason: VerdictReason;
  readonly billableEgressBytes: number;
  readonly usage: Usage;
};

type EgressEvaluator = (input: {
  readonly policy: Policy;
  readonly usage: Usage;
  readonly request: EgressRequest;
}) => Evaluation;

type Fixture = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly description: string;
  readonly coverage: readonly string[];
  readonly initialUsage: Usage;
  readonly steps: readonly {
    readonly policy: Policy;
    readonly request: EgressRequest;
    readonly expected: Evaluation;
  }[];
};

const ZERO_USAGE: TenantUsage = {
  activeConnections: 0,
  bandwidthUsedBytes: 0,
  egressBytes: 0,
};

function isCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function ipv4Value(ip: string): bigint {
  return ip.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

// Syntax is checked before expansion; never parse a prefix of a malformed address.
// Scoped/bracketed addresses and hostnames are refused, avoiding DNS or zone bypasses.
// IPv4-mapped IPv6 receives exactly the embedded IPv4 policy, including metadata IPs.
function parseIp(ip: string): { family: 4 | 6; value: bigint } | null {
  if (ip.includes("%")) return null;
  const family = isIP(ip);
  if (family === 4) return { family, value: ipv4Value(ip) };
  if (family !== 6) return null;

  let normalized = ip;
  if (ip.includes(".")) {
    const separator = ip.lastIndexOf(":");
    const embedded = ipv4Value(ip.slice(separator + 1));
    normalized = `${ip.slice(0, separator + 1)}${(embedded >> 16n).toString(16)}:${(
      embedded & 0xffffn
    ).toString(16)}`;
  }
  const [left = "", right = ""] = normalized.split("::");
  const leftWords = left === "" ? [] : left.split(":");
  const rightWords = right === "" ? [] : right.split(":");
  const words = normalized.includes("::")
    ? [
        ...leftWords,
        ...Array<string>(8 - leftWords.length - rightWords.length).fill("0"),
        ...rightWords,
      ]
    : leftWords;
  const value = words.reduce((address, word) => (address << 16n) | BigInt(`0x${word}`), 0n);
  if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
  return { family: 6, value };
}

function blockedAddress(address: { family: 4 | 6; value: bigint }): boolean {
  const { family, value } = address;
  if (family === 4) {
    return (
      value >> 24n === 10n || // 10.0.0.0/8
      value >> 20n === 0xac1n || // 172.16.0.0/12
      value >> 16n === 0xc0a8n || // 192.168.0.0/16
      value >> 22n === 0x191n || // 100.64.0.0/10
      value >> 24n === 127n || // 127.0.0.0/8
      value >> 16n === 0xa9fen // 169.254.0.0/16, including metadata
    );
  }
  return value >> 121n === 0x7en || value >> 118n === 0x3fan || value === 1n;
}

function mockEvaluateContainerEgress({
  policy,
  usage,
  request,
}: Parameters<EgressEvaluator>[0]): Evaluation {
  const reject = (reason: VerdictReason): Evaluation => ({
    allowed: false,
    reason,
    billableEgressBytes: 0,
    usage,
  });

  if (policy.killSwitch) return reject("kill_switch");
  const tenantPolicy = Object.hasOwn(policy.tenants, request.tenantId)
    ? policy.tenants[request.tenantId]
    : undefined;
  if (!tenantPolicy) return reject("unknown_tenant");
  if (tenantPolicy.outboundInternet !== true) return reject("outbound_disabled");
  const current = Object.hasOwn(usage, request.tenantId) ? usage[request.tenantId] : ZERO_USAGE;
  if (
    !current ||
    !Object.values(current).every(isCounter) ||
    !isCounter(tenantPolicy.maxConnections) ||
    !isCounter(tenantPolicy.bandwidthLimitBytes) ||
    !isCounter(request.bytes) ||
    !Number.isSafeInteger(request.destinationPort) ||
    request.destinationPort < 1 ||
    request.destinationPort > 65535 ||
    (request.operation !== "open" && request.operation !== "send") ||
    (request.transport !== "tcp" && request.transport !== "udp") ||
    (request.operation === "open" && request.bytes !== 0)
  ) {
    return reject("invalid_input");
  }
  const address = parseIp(request.destinationIp);
  if (!address) return reject("invalid_address");
  if (blockedAddress(address)) return reject("blocked_address");
  if (request.transport === "tcp" && request.destinationPort === 25) {
    return reject("blocked_tcp_port");
  }
  if (request.operation === "open" && current.activeConnections >= tenantPolicy.maxConnections) {
    return reject("connection_limit");
  }
  if (request.operation === "send" && current.activeConnections === 0) {
    return reject("connection_not_open");
  }
  if (request.bytes > tenantPolicy.bandwidthLimitBytes - current.bandwidthUsedBytes) {
    return reject("bandwidth_limit");
  }
  if (request.bytes > Number.MAX_SAFE_INTEGER - current.egressBytes) {
    return reject("accounting_overflow");
  }
  return {
    allowed: true,
    reason: "allowed",
    billableEgressBytes: request.bytes,
    usage: {
      ...usage,
      [request.tenantId]: {
        activeConnections: current.activeConnections + (request.operation === "open" ? 1 : 0),
        bandwidthUsedBytes: current.bandwidthUsedBytes + request.bytes,
        egressBytes: current.egressBytes + request.bytes,
      },
    },
  };
}

const directory = new URL("./fixtures/container-egress/", import.meta.url);
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    name,
    fixture: JSON.parse(readFileSync(new URL(name, directory), "utf8")) as Fixture,
  }));

describe("Container egress policy candidate conformance", () => {
  test("keeps at least 40 independent JSON vectors and all required coverage groups", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    expect(new Set(fixtures.map(({ fixture }) => fixture.id)).size).toBe(fixtures.length);
    const coverage = new Set(fixtures.flatMap(({ fixture }) => fixture.coverage));
    for (const group of [
      "blocked-ipv4",
      "blocked-ipv6",
      "cidr-boundary",
      "tcp-25",
      "public-http",
      "outbound-disabled",
      "connection-limit",
      "bandwidth-limit",
      "egress-accounting",
      "tenant-isolation",
      "kill-switch",
      "address-validation",
    ]) {
      expect(coverage.has(group)).toBe(true);
    }
  });

  for (const { name, fixture } of fixtures) {
    test(`${fixture.id}: ${fixture.description}`, () => {
      expect(fixture.schemaVersion).toBe(1);
      expect(name).toBe(`${fixture.id}.json`);
      expect(fixture.steps.length).toBeGreaterThan(0);
      let usage = structuredClone(fixture.initialUsage);
      for (const step of fixture.steps) {
        const input = { policy: structuredClone(step.policy), usage, request: step.request };
        const snapshot = structuredClone(input);
        const actual = evaluateContainerEgress(input);
        // The oracle is persisted in JSON; it never invokes the mock or derives a
        // verdict from its rules. Full state snapshots also check tenant separation.
        expect(actual).toEqual(step.expected);
        expect(input).toEqual(snapshot);
        usage = actual.usage;
      }
    });
  }
});
