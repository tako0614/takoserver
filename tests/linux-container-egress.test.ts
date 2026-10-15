import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyLinuxContainerEgress,
  compileLinuxContainerEgress,
  type LinuxContainerEgressPlan,
  linuxContainerEgressAllows,
  linuxContainerEgressKillScript,
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

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("fixture item absent");
  return value;
}

function hostInput() {
  const value = input();
  required(value.tenants[0]).authority.outboundInternet = false;
  return {
    ...value,
    hostHttp: required(value.tenants[0]).interfaces.map((bridge, index) => ({
      tenantRef: "tenant-a",
      generation: 1,
      networkId: String(index + 1).repeat(64),
      bridge,
      ifindex: 11 + index,
      hostMac: `02:00:00:00:00:0${index + 1}`,
      hostAddresses: [`172.20.${index}.1`, `fd00:${index + 1}::1`],
      tcpPorts: [8080],
      conntrackMark: 1001 + index,
    })),
  };
}

function readback(plan: LinuxContainerEgressPlan) {
  const objects: Record<string, unknown>[] = [
    { table: { family: "inet", name: plan.table } },
    { set: { family: "inet", table: plan.table, name: "disabled", type: "ifname" } },
  ];
  if (plan.hostHttp) {
    objects.push({
      set: {
        family: "inet",
        table: plan.table,
        name: "outbound_denied",
        type: "ifname",
        elem: plan.tenants
          .filter((tenant) => !tenant.authority.outboundInternet)
          .flatMap((tenant) => tenant.interfaces),
      },
    });
  }
  const disabled = plan.tenants
    .filter((tenant) => plan.killSwitch || (!plan.hostHttp && !tenant.authority.outboundInternet))
    .flatMap((tenant) => tenant.interfaces);
  if (disabled.length) (required(objects[1]).set as Record<string, unknown>).elem = disabled;
  for (const hook of plan.hostHttp ? ["input", "forward", "output"] : ["input", "forward"])
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
    ...(plan.hostHttp ? ["host_replies"] : []),
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
  if (plan.bridgeRules) {
    const common = { family: "bridge", table: plan.bridgeRules.table };
    objects.push({ table: { family: "bridge", name: common.table } });
    objects.push({ set: { ...common, name: "disabled", type: "ifname", elem: disabled } });
    for (const name of ["killed", "bridge_denied"])
      objects.push({ counter: { ...common, name, bytes: 0, packets: 0 } });
    for (const hook of ["prerouting", "input", "forward", "output"])
      objects.push({
        chain: { ...common, name: hook, type: "filter", hook, prio: -210, policy: "accept" },
      });
    for (const [index, tag] of plan.bridgeRules.ruleTags.entries()) {
      const [chain, comment] = tag.split(":");
      objects.push({
        rule: {
          ...common,
          chain,
          comment,
          expr: structuredClone(plan.bridgeRules.ruleExpressions[index]),
        },
      });
    }
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

test("preserves the c1 legacy script exactly when the Host reply opt-in is absent", () => {
  const plan = compileLinuxContainerEgress(input());
  expect(createHash("sha256").update(plan.script).digest("hex")).toBe(
    "8c75505e3cd2783c6bedc23cf71a7f84b8a51266a6348aaa42322f9aaf27fd04",
  );
  expect(plan.fullRuntimeCoverage).toBe(false);
});

test("the explicit Host opt-in separates Internet denial from killed HTTP replies", () => {
  const plan = compileLinuxContainerEgress(hostInput());
  expect(plan.script).toContain("hook output");
  expect(plan.script).toContain("ct direction original");
  expect(plan.script).toContain("ct direction reply");
  expect(plan.script).toContain("create table bridge takos_cx_unit_bridge");
  expect(plan.script).toContain(
    'add element inet takos_cx_unit outbound_denied { "cx_a", "cx_a2" }',
  );
  expect(plan.script).not.toContain('add element inet takos_cx_unit disabled { "cx_a", "cx_a2" }');
  expect(linuxContainerEgressKillScript(plan, "tenant-a")).toContain(
    "bridge takos_cx_unit_bridge disabled",
  );
});

// A deliberately small interpreter for the compiler's emitted boundary rules,
// not a native packet/conntrack implementation or a second egress policy.
type Packet = {
  meta: Record<string, unknown>;
  payload: Record<string, unknown>;
  ct: Record<string, unknown>;
  sets: Record<string, string[]>;
};
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("unsupported test expression");
  return value as Record<string, unknown>;
}
function evaluateRules(
  plan: LinuxContainerEgressPlan,
  family: "inet" | "bridge",
  chain: string,
  packet: Packet,
) {
  function value(expression: unknown): unknown {
    if (typeof expression === "string")
      return expression.startsWith("@") ? packet.sets[expression.slice(1)] : expression;
    if (expression === null || typeof expression !== "object") return expression;
    const expr = object(expression);
    if (expr.set) return expr.set;
    if (expr.meta) return packet.meta[String(object(expr.meta).key)];
    if (expr.payload) {
      const body = object(expr.payload);
      return packet.payload[`${body.protocol}.${body.field}`];
    }
    if (expr.ct) {
      const body = object(expr.ct);
      return packet.ct[[body.dir, body.family, body.key].filter(Boolean).join(".")];
    }
    throw new Error("unsupported test value");
  }
  const rules = family === "inet" ? plan : plan.bridgeRules;
  if (!rules) throw new Error("bridge plan absent");
  for (const [index, tag] of rules.ruleTags.entries()) {
    if (!tag.startsWith(`${chain}:`)) continue;
    const statements = rules.ruleExpressions[index];
    if (!statements) throw new Error("rule absent");
    for (const expression of statements) {
      const expr = object(expression);
      if (expr.match) {
        const predicate = object(expr.match);
        const left = value(predicate.left);
        const right = value(predicate.right);
        const equal = Array.isArray(right) ? right.includes(left) : left === right;
        if (predicate.op !== "==" && predicate.op !== "!=")
          throw new Error("unsupported test predicate");
        if (predicate.op === "==" ? !equal : equal) break;
      } else if (expr.mangle) {
        const assignment = object(expr.mangle);
        expect(assignment.key).toEqual({ ct: { key: "mark" } });
        packet.ct.mark = value(assignment.value);
      } else if (Object.hasOwn(expr, "accept")) return "accept";
      else if (Object.hasOwn(expr, "drop")) return "drop";
      else if (expr.jump) return "jump";
      else if (!expr.counter) throw new Error("unsupported test statement");
    }
  }
  return "none";
}
function httpPacket(): Packet {
  return {
    meta: { iifname: "cx_a", iif: 11, oifname: "cx_a", oif: 11, ibrname: "cx_a", obrname: "cx_a" },
    payload: {
      "ip.saddr": "172.20.0.1",
      "tcp.dport": 8080,
      "ether.saddr": "02:00:00:00:00:11",
      "ether.daddr": "02:00:00:00:00:01",
      "ether.type": "ip",
    },
    ct: {
      state: "new",
      direction: "original",
      mark: 0,
      "original.protocol": "tcp",
      "original.ip.saddr": "172.20.0.1",
      "original.proto-dst": 8080,
    },
    sets: { disabled: [], outbound_denied: ["cx_a", "cx_a2"] },
  };
}

test("only trusted local OUTPUT can mint a reply token, and kill wins over an already admitted reply", () => {
  const plan = compileLinuxContainerEgress(hostInput());
  const packet = httpPacket();
  expect(evaluateRules(plan, "inet", "output", packet)).toBe("none");
  expect(packet.ct.mark).toBe(1001);
  packet.ct.state = "established";
  packet.ct.direction = "reply";
  packet.payload["ip.saddr"] = "172.20.0.2";
  expect(evaluateRules(plan, "inet", "input", packet)).toBe("accept");
  packet.sets.disabled = ["cx_a"];
  expect(evaluateRules(plan, "inet", "input", packet)).toBe("drop");
  expect(evaluateRules(plan, "inet", "output", packet)).toBe("drop");
  expect(evaluateRules(plan, "bridge", "prerouting", packet)).toBe("drop");
  const untrusted = httpPacket();
  expect(evaluateRules(plan, "inet", "input", untrusted)).toBe("drop");
  expect(evaluateRules(plan, "inet", "forward", untrusted)).toBe("drop");
  expect(untrusted.ct.mark).toBe(0);
});

test("unmarked, wrong direction, bridge, index, service, generation and RELATED traffic cannot borrow the reply exception", () => {
  const plan = compileLinuxContainerEgress(hostInput());
  for (const patch of [
    { mark: 0 },
    { direction: "original" },
    { state: "related" },
    { state: "invalid" },
    { state: "untracked" },
    { "original.proto-dst": 8081 },
    { "original.protocol": "udp" },
    { "original.ip.saddr": "169.254.169.254" },
    { mark: 2001 },
  ]) {
    const packet = httpPacket();
    packet.ct = { ...packet.ct, state: "established", direction: "reply", mark: 1001, ...patch };
    expect(evaluateRules(plan, "inet", "input", packet)).toBe("drop");
  }
  for (const patch of [{ iifname: "cx_a2", iif: 12 }, { iif: 99 }]) {
    const packet = httpPacket();
    packet.ct = { ...packet.ct, state: "established", direction: "reply", mark: 1001 };
    Object.assign(packet.meta, patch);
    expect(evaluateRules(plan, "inet", "input", packet)).toBe("drop");
  }
  const fresh = hostInput();
  required(fresh.tenants[0]).authority.generation = 2;
  for (const bridge of fresh.hostHttp) {
    bridge.generation = 2;
    bridge.conntrackMark += 1000;
  }
  const packet = httpPacket();
  packet.ct = { ...packet.ct, state: "established", direction: "reply", mark: 1001 };
  expect(evaluateRules(compileLinuxContainerEgress(fresh), "inet", "input", packet)).toBe("drop");
});

test("future bridge members cannot forward at L2 or spoof Host identity before an endpoint exists", () => {
  const plan = compileLinuxContainerEgress(hostInput());
  const packet = httpPacket();
  packet.payload["ip.saddr"] = "172.20.0.2";
  expect(evaluateRules(plan, "bridge", "prerouting", packet)).toBe("none");
  expect(evaluateRules(plan, "bridge", "input", packet)).toBe("accept");
  expect(evaluateRules(plan, "bridge", "forward", packet)).toBe("drop");
  packet.payload["ether.type"] = "vlan";
  expect(evaluateRules(plan, "bridge", "prerouting", packet)).toBe("drop");
  packet.payload["ether.type"] = "ip";
  packet.payload["ip.saddr"] = "172.20.0.1";
  expect(evaluateRules(plan, "bridge", "prerouting", packet)).toBe("drop");
  packet.payload["ip.saddr"] = "172.20.0.2";
  packet.payload["ether.saddr"] = "02:00:00:00:00:01";
  expect(evaluateRules(plan, "bridge", "prerouting", packet)).toBe("drop");
});

test("the opt-in rejects partial or colliding bridge scope before any command", () => {
  for (const change of [
    "missing",
    "foreign",
    "generation",
    "network",
    "index",
    "mark",
    "port",
    "address",
  ] as const) {
    const value = hostInput();
    const first = required(value.hostHttp[0]);
    const second = required(value.hostHttp[1]);
    if (change === "missing") value.hostHttp.pop();
    if (change === "foreign") first.tenantRef = "tenant-b";
    if (change === "generation") first.generation = 2;
    if (change === "network") second.networkId = first.networkId;
    if (change === "index") second.ifindex = first.ifindex;
    if (change === "mark") second.conntrackMark = first.conntrackMark;
    if (change === "port") first.tcpPorts = [0];
    if (change === "address") first.hostAddresses = ["fe80::1%eth0"];
    expect(() => compileLinuxContainerEgress(value)).toThrow("linux_container_egress_unavailable");
  }
});

test("both families are closed on the initial readback, including reply direction, kill order and bridge hooks", () => {
  const plan = compileLinuxContainerEgress(hostInput());
  const initial = verifyLinuxContainerEgressReadback(plan, readback(plan));
  expect([initial.fullRuntimeCoverage, initial.billingQualified]).toEqual([false, false]);
  for (const change of [
    "missing-bridge",
    "extra-table",
    "dormant",
    "hook",
    "reply",
    "mint",
    "kill-order",
    "quota",
    "unknown-field",
    "policy-set",
  ] as const) {
    const native = readback(plan);
    const bridgeTable = required(
      native.nftables.find(
        (entry) => (entry.table as Record<string, unknown>)?.family === "bridge",
      ),
    ).table as Record<string, unknown>;
    if (change === "missing-bridge")
      native.nftables = native.nftables.filter((entry) =>
        Object.values(entry).every(
          (value) => (value as Record<string, unknown>).family !== "bridge",
        ),
      );
    if (change === "extra-table")
      native.nftables.push({ table: { family: "inet", name: "foreign" } });
    if (change === "dormant") bridgeTable.flags = ["dormant"];
    if (change === "hook")
      (
        required(
          native.nftables.find(
            (entry) => (entry.chain as Record<string, unknown>)?.family === "bridge",
          ),
        ).chain as Record<string, unknown>
      ).prio = 0;
    if (change === "reply" || change === "mint") {
      const rule = required(
        native.nftables.find((entry) => {
          const rule = entry.rule as Record<string, unknown>;
          return (
            rule && JSON.stringify(rule.expr).includes(change === "reply" ? '"reply"' : '"mangle"')
          );
        }),
      ).rule as Record<string, unknown>;
      rule.expr = [{ accept: null }];
    }
    if (change === "kill-order") {
      const indexes = native.nftables.flatMap((entry, index) =>
        (entry.rule as Record<string, unknown>)?.chain === "input" ? [index] : [],
      );
      const a = required(indexes[0]);
      const b = required(indexes[1]);
      [native.nftables[a], native.nftables[b]] = [
        required(native.nftables[b]),
        required(native.nftables[a]),
      ];
    }
    if (change === "quota")
      (
        required(native.nftables.find((entry) => entry.quota)).quota as Record<string, unknown>
      ).bytes = 999999;
    if (change === "unknown-field") bridgeTable.owner = true;
    if (change === "policy-set")
      (
        required(
          native.nftables.find(
            (entry) => (entry.set as Record<string, unknown>)?.name === "outbound_denied",
          ),
        ).set as Record<string, unknown>
      ).elem = [];
    expect(() => verifyLinuxContainerEgressReadback(plan, native)).toThrow(
      "linux_container_egress_unavailable",
    );
  }
});

test("the opt-in accepts actual Docker bridge names while refusing incomplete or un-emittable Host metadata", () => {
  const value = hostInput();
  required(value.tenants[0]).interfaces[0] = "br-123456789abc";
  required(value.hostHttp[0]).bridge = "br-123456789abc";
  expect(() => compileLinuxContainerEgress(value)).not.toThrow();
  const legacy = input();
  required(legacy.tenants[0]).interfaces[0] = "br-123456789abc";
  expect(() => compileLinuxContainerEgress(legacy)).toThrow();
  for (const fields of [
    { hostAddresses: ["0.0.0.0"] },
    { hostAddresses: ["::"] },
    { hostAddresses: ["ff02::1"] },
    { hostAddresses: ["127.0.0.1"] },
    { operatorApproved: true },
  ]) {
    const invalid = hostInput();
    Object.assign(required(invalid.hostHttp[0]), fields);
    expect(() => compileLinuxContainerEgress(invalid)).toThrow(
      "linux_container_egress_unavailable",
    );
  }
});

test("IPv6 Host replies use the same bounded exception and a killed A scope cannot disable B", () => {
  const value = hostInput();
  value.tenants.push({
    authority: {
      tenantRef: "tenant-b",
      generation: 7,
      policyDigest: `sha256:${"b".repeat(64)}`,
      outboundInternet: true,
    },
    interfaces: ["cx_b"],
    maxConnections: 2,
    packetLimitBytes: 65536,
  });
  value.hostHttp.push({
    tenantRef: "tenant-b",
    generation: 7,
    networkId: "b".repeat(64),
    bridge: "cx_b",
    ifindex: 21,
    hostMac: "02:00:00:00:00:21",
    hostAddresses: ["172.30.0.1", "fd00:7::1"],
    tcpPorts: [8080],
    conntrackMark: 2001,
  });
  const plan = compileLinuxContainerEgress(value);
  const packet = httpPacket();
  delete packet.payload["ip.saddr"];
  delete packet.ct["original.ip.saddr"];
  packet.payload["ip6.saddr"] = "fd00:1::1";
  packet.ct["original.ip6.saddr"] = "fd00:1::1";
  expect(evaluateRules(plan, "inet", "output", packet)).toBe("none");
  expect(packet.ct.mark).toBe(1001);
  packet.ct.state = "established";
  packet.ct.direction = "reply";
  packet.payload["ip6.saddr"] = "fd00:1::2";
  expect(evaluateRules(plan, "inet", "input", packet)).toBe("accept");
  packet.sets.disabled = ["cx_a", "cx_a2"];
  expect(evaluateRules(plan, "inet", "input", packet)).toBe("drop");
  packet.meta.iifname = "cx_b";
  packet.meta.iif = 21;
  packet.ct.mark = 2001;
  packet.ct["original.ip6.saddr"] = "fd00:7::1";
  expect(evaluateRules(plan, "inet", "input", packet)).toBe("accept");
  expect(linuxContainerEgressKillScript(plan, "tenant-a")).not.toContain('"cx_b"');
  expect(plan.script).toContain("ff02::1:ff00:1");
});

test("opt-in apply reads both owned tables and never accepts a missing family or namespace drift", async () => {
  const plan = compileLinuxContainerEgress(hostInput());
  const commands: string[][] = [];
  const evidence = await applyLinuxContainerEgress(plan, {
    namespace: async () => plan.namespace.selected,
    execute: async (command) => {
      commands.push([...command.argv]);
      if (!command.argv.includes("list")) return "";
      const family = command.argv[4];
      return JSON.stringify({
        nftables: readback(plan).nftables.filter((entry) =>
          Object.values(entry).some((body) => (body as Record<string, unknown>).family === family),
        ),
      });
    },
  });
  expect(commands).toEqual([
    ["nft", "--check", "-f", "-"],
    ["nft", "-f", "-"],
    ["nft", "-j", "list", "table", "inet", plan.table],
    ["nft", "-j", "list", "table", "bridge", "takos_cx_unit_bridge"],
  ]);
  expect([evidence.fullRuntimeCoverage, evidence.billingQualified]).toEqual([false, false]);
  let namespace = plan.namespace.selected;
  await expect(
    applyLinuxContainerEgress(plan, {
      namespace: async () => namespace,
      execute: async (command) => {
        if (command.argv[4] === "bridge") namespace = plan.namespace.parent;
        return command.argv.includes("list") ? JSON.stringify(readback(plan)) : "";
      },
    }),
  ).rejects.toThrow("linux_container_egress_unavailable");
  await expect(
    applyLinuxContainerEgress(plan, {
      namespace: async () => plan.namespace.selected,
      execute: async (command) =>
        command.argv.includes("list") ? JSON.stringify({ nftables: [] }) : "",
    }),
  ).rejects.toThrow("linux_container_egress_unavailable");
  await expect(
    applyLinuxContainerEgress(plan, {
      namespace: async () => plan.namespace.selected,
      execute: async (command) =>
        command.argv.includes("list")
          ? JSON.stringify({ ...readback(plan), uncompiled: true })
          : "",
    }),
  ).rejects.toThrow("linux_container_egress_unavailable");
});

for (const misplacedIn of ["inet", "bridge"] as const) {
  test(`apply rejects both tables returned by ${misplacedIn} with an empty other query`, async () => {
    const plan = compileLinuxContainerEgress(hostInput());
    const seen: string[][] = [];
    await expect(
      applyLinuxContainerEgress(plan, {
        namespace: async () => plan.namespace.selected,
        execute: async ({ argv }) => {
          if (!argv.includes("list")) return "";
          seen.push([...argv]);
          return JSON.stringify({
            nftables: argv[4] === misplacedIn ? readback(plan).nftables : [],
          });
        },
      }),
    ).rejects.toThrow("linux_container_egress_unavailable");
    expect(seen.map((argv) => argv.slice(4))).toEqual([
      ["inet", plan.table],
      ["bridge", "takos_cx_unit_bridge"],
    ]);
  });
}

test("apply accepts independently scoped native-shaped table responses with handles and metainfo", async () => {
  const plan = compileLinuxContainerEgress(hostInput());
  const evidence = await applyLinuxContainerEgress(plan, {
    namespace: async () => plan.namespace.selected,
    execute: async ({ argv }) => {
      if (!argv.includes("list")) return "";
      const objects = readback(plan).nftables.filter((entry) =>
        Object.values(entry).some((body) => (body as Record<string, unknown>).family === argv[4]),
      );
      return JSON.stringify({
        nftables: [
          { metainfo: { version: "1.1.3", json_schema_version: 1 } },
          ...objects.map((entry, index) =>
            Object.fromEntries(
              Object.entries(entry).map(([kind, value]) => [
                kind,
                { ...(value as Record<string, unknown>), handle: index + 1 },
              ]),
            ),
          ),
        ],
      });
    },
  });
  expect([evidence.fullRuntimeCoverage, evidence.billingQualified]).toEqual([false, false]);
});

test("legacy false/kill bytes and the copied Host input cannot be weakened by caller mutation", () => {
  const legacy = input();
  required(legacy.tenants[0]).authority.outboundInternet = false;
  const old = compileLinuxContainerEgress(legacy);
  expect(old.script.endsWith('add element inet takos_cx_unit disabled { "cx_a", "cx_a2" }\n')).toBe(
    true,
  );
  expect(linuxContainerEgressKillScript(old, "tenant-a")).toBe(
    'add element inet takos_cx_unit disabled { "cx_a", "cx_a2" }\n',
  );
  const value = hostInput();
  const plan = compileLinuxContainerEgress(value);
  required(value.hostHttp[0]).conntrackMark = 9999;
  required(value.hostHttp[0]).hostAddresses[0] = "169.254.169.254";
  expect(plan.hostHttp?.[0]?.conntrackMark).toBe(1001);
  expect(Object.isFrozen(plan.hostHttp?.[0]?.hostAddresses)).toBe(true);
  expect(verifyLinuxContainerEgressReadback(plan, readback(plan)).fullRuntimeCoverage).toBe(false);
});
