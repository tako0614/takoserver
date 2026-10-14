import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { evaluateContainerEgress as evaluatePolicy } from "../src/container-egress-policy.ts";

// PR359 fixtures define this pure policy seam; native enforcement is qualified separately.
const evaluateContainerEgress: EgressEvaluator = evaluatePolicy;

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

const directory = new URL("./fixtures/container-egress/", import.meta.url);
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    name,
    fixture: JSON.parse(readFileSync(new URL(name, directory), "utf8")) as Fixture,
  }));

describe("Container egress policy candidate conformance", () => {
  test("keeps the exact 114 independent JSON vectors and all required coverage groups", () => {
    expect(fixtures.length).toBe(114);
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
