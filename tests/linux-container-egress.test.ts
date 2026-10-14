import { describe, expect, test } from "bun:test";
import {
  applyLinuxContainerEgress,
  compileLinuxContainerEgress,
  type LinuxContainerEgressPlan,
  linuxContainerEgressAllows,
  verifyLinuxContainerEgressReadback,
} from "../src/providers/linux-container-egress.ts";

function input() {
  return {
    namespace: { parent: "net:[1]", selected: "net:[2]" },
    table: "takos_cx_unit",
    killSwitch: false,
    tenants: [
      {
        authority: {
          tenantRef: "tenant-a",
          generation: 1,
          policyDigest: `sha256:${"a".repeat(64)}`,
          outboundInternet: true,
        },
        interfaces: ["cx_a", "cx_a2"],
        maxConnections: 2,
        packetLimitBytes: 65536,
      },
    ],
  };
}

function readback(plan: LinuxContainerEgressPlan) {
  const objects: Record<string, unknown>[] = [
    { table: { family: "inet", name: plan.table } },
    { set: { family: "inet", table: plan.table, name: "disabled", type: "ifname" } },
  ];
  for (const hook of ["input", "forward"])
    objects.push({
      chain: {
        family: "inet",
        table: plan.table,
        name: hook,
        type: "filter",
        hook,
        prio: -10,
        policy: "accept",
      },
    });
  for (const [index, tenant] of plan.tenants.entries()) {
    objects.push({ chain: { family: "inet", table: plan.table, name: `t${index}` } });
    objects.push({
      quota: {
        family: "inet",
        table: plan.table,
        name: `q${index}`,
        bytes: tenant.packetLimitBytes,
        inv: true,
      },
    });
  }
  for (const name of [
    "killed",
    "host_denied",
    ...plan.tenants.flatMap((_, index) => [
      `accepted${index}`,
      `denied${index}`,
      `cap_denied${index}`,
    ]),
  ]) {
    objects.push({ counter: { family: "inet", table: plan.table, name, bytes: 0, packets: 0 } });
  }
  for (const [index, key] of plan.ruleTags.entries()) {
    const [chain, comment] = key.split(":");
    objects.push({
      rule: {
        family: "inet",
        table: plan.table,
        chain,
        comment,
        expr: structuredClone(plan.ruleExpressions[index]),
      },
    });
  }
  return { nftables: objects };
}

describe("Linux native Container egress plan", () => {
  test("refuses the parent namespace and command injection before effects", () => {
    expect(() =>
      compileLinuxContainerEgress({
        ...input(),
        namespace: { parent: "net:[1]", selected: "net:[1]" },
      }),
    ).toThrow();
    expect(() =>
      compileLinuxContainerEgress({ ...input(), table: "takos_cx_x;flush ruleset" }),
    ).toThrow();
    const bad = input();
    bad.tenants[0]?.interfaces.splice(0, 2, 'x"; accept');
    expect(() => compileLinuxContainerEgress(bad)).toThrow();
  });

  test("uses existing policy semantics and shares one cap across tenant interfaces", () => {
    const plan = compileLinuxContainerEgress(input());
    expect(linuxContainerEgressAllows(plan, "tenant-a", "8.8.8.8", 24, "tcp")).toBe(true);
    expect(linuxContainerEgressAllows(plan, "tenant-a", "8.8.8.8", 25, "udp")).toBe(true);
    expect(linuxContainerEgressAllows(plan, "tenant-a", "8.8.8.8", 25, "tcp")).toBe(false);
    expect(linuxContainerEgressAllows(plan, "tenant-a", "169.254.169.254", 80, "tcp")).toBe(false);
    expect(linuxContainerEgressAllows(plan, "tenant-a", "::ffff:10.1.1.1", 80, "tcp")).toBe(false);
    expect(linuxContainerEgressAllows(plan, "tenant-a", "2606:4700:4700::1111", 26, "tcp")).toBe(
      true,
    );
    expect(plan.script.match(/ct count over 2/g)).toHaveLength(1);
    expect(plan.script.match(/quota q0/g)).toHaveLength(1);
    expect(plan.script).toContain('iifname "cx_a" jump t0');
    expect(plan.script).toContain('iifname "cx_a2" jump t0');
    expect(plan.script.indexOf("iifname @disabled")).toBeLessThan(plan.script.indexOf("jump t0"));
    expect(plan.fullRuntimeCoverage).toBe(false);
    expect(plan.counterUnit).toBe("kernel-skb-bytes-at-inet-forward");
  });

  test("copies authority, rejects duplicate endpoints, and refuses incomplete kernel readback", () => {
    const original = input();
    const plan = compileLinuxContainerEgress(original);
    const tenant = original.tenants[0];
    if (!tenant) throw new Error("fixture tenant absent");
    tenant.authority.outboundInternet = false;
    expect(linuxContainerEgressAllows(plan, "tenant-a", "8.8.8.8", 24, "tcp")).toBe(true);
    const duplicate = input();
    duplicate.tenants[0]?.interfaces.push("cx_a");
    expect(() => compileLinuxContainerEgress(duplicate)).toThrow();
    expect(() =>
      verifyLinuxContainerEgressReadback(plan, {
        nftables: [{ table: { family: "inet", name: plan.table } }],
      }),
    ).toThrow();
  });

  test("namespace drift prevents native apply", async () => {
    const plan = compileLinuxContainerEgress(input());
    const commands: unknown[] = [];
    await expect(
      applyLinuxContainerEgress(plan, {
        async namespace() {
          return "net:[1]";
        },
        async execute(command) {
          commands.push(command);
          return "{}";
        },
      }),
    ).rejects.toThrow();
    expect(commands).toHaveLength(0);
  });

  test("compares kernel expressions and order rather than trusting rule comments", () => {
    const plan = compileLinuxContainerEgress(input());
    const native = readback(plan);
    expect(verifyLinuxContainerEgressReadback(plan, native).fullRuntimeCoverage).toBe(false);
    const rule = native.nftables.find((value) => "rule" in value)?.rule as Record<string, unknown>;
    rule.expr = [{ accept: null }];
    expect(() => verifyLinuxContainerEgressReadback(plan, native)).toThrow();
    const reordered = readback(plan);
    const first = reordered.nftables.findIndex((value) => "rule" in value);
    const left = reordered.nftables[first];
    const right = reordered.nftables[first + 1];
    if (!left || !right) throw new Error("native fixture rules absent");
    reordered.nftables[first] = right;
    reordered.nftables[first + 1] = left;
    expect(() => verifyLinuxContainerEgressReadback(plan, reordered)).toThrow();
  });

  test("native apply executes only checked owned commands and yields partial evidence", async () => {
    const plan = compileLinuxContainerEgress(input());
    const commands: string[][] = [];
    const evidence = await applyLinuxContainerEgress(plan, {
      async namespace() {
        return plan.namespace.selected;
      },
      async execute(command) {
        commands.push([...command.argv]);
        return command.argv.includes("list") ? JSON.stringify(readback(plan)) : "";
      },
    });
    expect(commands).toEqual([
      ["nft", "--check", "-f", "-"],
      ["nft", "-f", "-"],
      ["nft", "-j", "list", "table", "inet", plan.table],
    ]);
    expect(evidence.fullRuntimeCoverage).toBe(false);
    expect(evidence.billingQualified).toBe(false);
  });

  test("initial kernel readback permits absent or empty flags and rejects uncompiled table attributes", () => {
    const plan = compileLinuxContainerEgress(input());
    expect(verifyLinuxContainerEgressReadback(plan, readback(plan)).fullRuntimeCoverage).toBe(
      false,
    );
    const active = readback(plan);
    const activeTable = active.nftables[0]?.table as Record<string, unknown>;
    activeTable.flags = [];
    activeTable.handle = 1;
    expect(verifyLinuxContainerEgressReadback(plan, active).fullRuntimeCoverage).toBe(false);
    for (const attributes of [
      { flags: ["dormant"] },
      { flags: ["owner"] },
      { flags: ["persist"] },
      { flags: "dormant" },
      { flags: null },
      { dormant: true },
      { comment: "not emitted by compiler" },
    ]) {
      const native = readback(plan);
      Object.assign(native.nftables[0]?.table as Record<string, unknown>, attributes);
      // No known-good digest is supplied: initial anchoring must refuse it.
      expect(() => verifyLinuxContainerEgressReadback(plan, native)).toThrow();
    }
  });

  test("native apply refuses to anchor a dormant table on its initial readback", async () => {
    const plan = compileLinuxContainerEgress(input());
    const native = readback(plan);
    Object.assign(native.nftables[0]?.table as Record<string, unknown>, { flags: ["dormant"] });
    await expect(
      applyLinuxContainerEgress(plan, {
        async namespace() {
          return plan.namespace.selected;
        },
        async execute(command) {
          return command.argv.includes("list") ? JSON.stringify(native) : "";
        },
      }),
    ).rejects.toThrow();
  });
});
