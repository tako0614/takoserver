import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { createOrgBilling, OrgBillingError, type UsageInput } from "../src/org-billing.ts";
import { createOrgLimitPolicy, type OrgLimitPolicy } from "../src/org-limit-policy.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";

const ORG = "workspace_org";
const OCT_START = "2026-10-01T00:00:00.000Z";
const OCT_END = "2026-11-01T00:00:00.000Z";
function fixture(sql = createEphemeralSql()) {
  let instant = "2026-10-15T00:00:00.000Z";
  const clock = () => new Date(instant);
  const tariff = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "workspace-r1",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86_400,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: { requests: { unit: "request", rate: { numeratorMicros: "1", denominator: "1" } } },
    }),
  );
  if (!tariff) throw new Error("fixture config missing");
  const ledger = createLedger(sql, clock, { hostedPaidFreeExclusion: true });
  const createBilling = (
    store: Sql = sql,
    limitPolicy?: OrgLimitPolicy,
    requireWorkspaceAttribution = false,
  ) =>
    createOrgBilling({
      sql: store,
      clock,
      ledger,
      config: tariff,
      hostedPaidFreeExclusion: true,
      requireWorkspaceAttribution,
      ...(limitPolicy === undefined ? {} : { limitPolicy }),
    });
  return {
    sql,
    ledger,
    billing: createBilling(),
    createBilling,
    time(value: string) {
      instant = value;
    },
    hold(reference: string, amountMicros = 100, workspaceRef?: string, organizationId = ORG) {
      return {
        organizationId,
        reference,
        amountMicros,
        pricingRevision: tariff.revision,
        measurementFingerprint: "estimate",
        ...(workspaceRef === undefined ? {} : { workspaceRef }),
      };
    },
    capture(reference: string, amountMicros: number) {
      return {
        organizationId: ORG,
        reference,
        amountMicros,
        actualMicros: String(amountMicros),
        measurementFingerprint: "actual",
      };
    },
    usage(reference: string, expectedMicros: number, workspaceRef?: string): UsageInput {
      return {
        organizationId: ORG,
        reference,
        meter: "requests",
        quantity: String(expectedMicros),
        quantityUnit: "request",
        periodStart: "2026-10-14T00:00:00.000Z",
        periodEnd: "2026-10-14T01:00:00.000Z",
        pricingRevision: tariff.revision,
        expectedMicros,
        measurementFingerprint: "closed",
        ...(workspaceRef === undefined ? {} : { workspaceRef }),
      };
    },
    async paid(start = "2026-10-10T00:00:00.000Z", end = "2026-10-20T00:00:00.000Z") {
      const store = createStripeBillingStore({ sql, clock });
      await store.grant({
        organizationId: ORG,
        fundingRef: "stripe:invoice:in_workspace",
        kind: "plan-included",
        amountMicros: 20_000_000,
        expiresAt: end,
        sourceType: "invoice",
        sourceId: "in_workspace",
        chargeId: "ch_workspace",
        customerId: "cus_workspace",
        subscriptionId: "sub_workspace",
        planKey: "starter",
        pricingRevision: tariff.revision,
        stripePriceId: "price_starter",
        periodStart: start,
        periodEnd: end,
        considerationMicros: 10_000_000,
      });
      return store;
    },
  };
}
async function errorCode(operation: Promise<unknown>, code: string, status: number) {
  try {
    await operation;
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(OrgBillingError);
    expect(error).toMatchObject({ code, status });
  }
}

test("explicit opaque attribution is inherited, fingerprinted and bound to one Organization", async () => {
  const f = fixture();
  const command = f.hold("arbitrary_reference", 100, "ws_random_a");
  const first = await f.billing.hold(command);
  expect(first).toMatchObject({
    workspaceRef: "ws_random_a",
    attributionPeriodStart: OCT_START,
    attributionPeriodEnd: OCT_END,
  });
  const receipt = await f.billing.capture(f.capture(command.reference, 30));
  expect(receipt.workspaceRef).toBe(first.workspaceRef);
  expect(await f.billing.hold(command)).toEqual(receipt);
  expect(await f.billing.capture(f.capture(command.reference, 30))).toEqual(receipt);
  await errorCode(
    f.billing.hold({ ...command, workspaceRef: "ws_random_b" }),
    "reference_conflict",
    409,
  );
  await errorCode(
    f.billing.hold(f.hold("another_org", 0, "ws_random_a", "foreign_org")),
    "workspace_ref_conflict",
    409,
  );
  await errorCode(
    f.billing.workspaceUsage("foreign_org", { workspaceRef: "ws_random_a" }),
    "workspace_not_found",
    404,
  );
  await errorCode(f.billing.hold(f.hold("invalid", 0, "has space")), "invalid_reference", 400);
  await f.billing.hold(f.hold("ws_random_a:looks_attributed", 20));
  await f.billing.capture(f.capture("ws_random_a:looks_attributed", 10));
  const page = await f.billing.workspaceUsage(ORG);
  expect(page.workspaces).toEqual([
    { workspaceRef: "ws_random_a", usedMicros: 30, heldMicros: 0, pendingMicros: 0 },
  ]);
  expect(page.unattributed.usedMicros).toBe(10);
});

test("pages freeze Org totals, pending-to-paid once, held state and included summary across concurrent settlement", async () => {
  const f = fixture();
  await f.billing.hold(f.hold("a", 100, "ws_a"));
  await f.billing.capture(f.capture("a", 30));
  await f.billing.hold(f.hold("b", 200, "ws_b"));
  await f.billing.hold(f.hold("c", 300, "ws_c"));
  await f.billing.capture(f.capture("c", 300));
  await f.billing.hold(f.hold("historical", 30));
  await f.billing.capture(f.capture("historical", 5));
  await f.billing.usage(f.usage("measured_paid", 7, "ws_b"));
  const pending = f.usage("measured_pending", 1_500_001, "ws_c");
  expect((await f.billing.usage(pending)).status).toBe("pending");
  const first = await f.billing.workspaceUsage(ORG, { limit: 1 });
  expect(first.totals).toEqual({ usedMicros: 342, heldMicros: 200, pendingMicros: 1_500_001 });
  expect(first.totalsScope).toBe("organization");
  expect(first.cursor).not.toBeNull();
  await f.billing.capture(f.capture("b", 70));
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "purchase",
    amountMicros: 2_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  expect((await f.billing.usage(pending)).status).toBe("paid");
  const second = await f.billing.workspaceUsage(ORG, { limit: 1, cursor: first.cursor ?? "" });
  expect(second.totals).toEqual(first.totals);
  expect(second.usageSummary).toEqual(first.usageSummary);
  expect(second.unattributed).toEqual(first.unattributed);
  expect(second.workspaces).toEqual([
    { workspaceRef: "ws_b", usedMicros: 7, heldMicros: 200, pendingMicros: 0 },
  ]);
  const third = await f.billing.workspaceUsage(ORG, { limit: 1, cursor: second.cursor ?? "" });
  const rows = [...first.workspaces, ...second.workspaces, ...third.workspaces];
  for (const field of ["usedMicros", "heldMicros", "pendingMicros"] as const)
    expect(rows.reduce((total, r) => total + r[field], first.unattributed[field])).toBe(
      first.totals[field],
    );
  expect(third.cursor).toBeNull();
  const current = await f.billing.workspaceUsage(ORG, { workspaceRef: "ws_b" });
  expect(current.workspaces).toEqual([
    { workspaceRef: "ws_b", usedMicros: 77, heldMicros: 0, pendingMicros: 0 },
  ]);
  expect(current.totals).toEqual({ usedMicros: 1_500_413, heldMicros: 0, pendingMicros: 0 });
  // Purchased consumption is part of the Org breakdown, never another included allowance.
  expect(current.totals.usedMicros).toBeGreaterThan(current.usageSummary.usedMicros);
});

test("capture and late closed usage retain their original interval across monthly reset", async () => {
  const f = fixture();
  f.time("2026-10-31T23:59:30.000Z");
  await f.billing.hold(f.hold("cross_reset", 100, "ws_october"));
  f.time(OCT_END);
  const receipt = await f.billing.capture(f.capture("cross_reset", 70));
  expect(receipt).toMatchObject({
    attributionPeriodStart: OCT_START,
    attributionPeriodEnd: OCT_END,
    capturedMicros: 70,
  });
  const late = await f.billing.usage({
    ...f.usage("late", 11, "ws_october"),
    periodStart: "2026-10-31T22:00:00.000Z",
    periodEnd: "2026-10-31T23:00:00.000Z",
  });
  expect(late).toMatchObject({ attributionPeriodStart: OCT_START, attributionPeriodEnd: OCT_END });
  const current = await f.billing.workspaceUsage(ORG);
  expect(current.periodStart).toBe(OCT_END);
  expect(current.totals).toEqual({ usedMicros: 0, heldMicros: 0, pendingMicros: 0 });
  await errorCode(
    f.billing.usage({
      ...f.usage("cross_boundary", 1, "ws_october"),
      periodStart: "2026-10-31T23:59:59.000Z",
      periodEnd: "2026-11-01T00:00:00.001Z",
    }),
    "invalid_usage_period",
    400,
  );
  f.time("2026-11-01T01:00:00.000Z");
  await errorCode(
    f.billing.usage({
      ...f.usage("cross_boundary", 1, "ws_october"),
      periodStart: "2026-10-31T23:59:59.000Z",
      periodEnd: "2026-11-01T00:00:00.001Z",
    }),
    "usage_period_crosses_entitlement",
    409,
  );
});

test("paid period proofs pin measured attribution and crossing either service boundary requires splitting", async () => {
  const f = fixture();
  f.time("2026-10-09T23:59:30.000Z");
  await f.billing.hold(f.hold("old_free", 100, "ws_a"));
  f.time("2026-10-10T00:00:00.000Z");
  await f.paid();
  await f.billing.capture(f.capture("old_free", 50));
  f.time("2026-10-15T00:00:00.000Z");
  expect((await f.billing.workspaceUsage(ORG)).totals.usedMicros).toBe(0);
  const paid = await f.billing.usage(f.usage("paid_interval", 13, "ws_a"));
  expect(paid).toMatchObject({
    attributionPeriodStart: "2026-10-10T00:00:00.000Z",
    attributionPeriodEnd: "2026-10-20T00:00:00.000Z",
  });
  await errorCode(
    f.billing.usage({
      ...f.usage("cross_start", 1, "ws_a"),
      periodStart: "2026-10-09T23:59:59.000Z",
      periodEnd: "2026-10-10T00:00:01.000Z",
    }),
    "usage_period_crosses_entitlement",
    409,
  );
  f.time("2026-10-21T00:00:00.000Z");
  await errorCode(
    f.billing.usage({
      ...f.usage("cross_end", 1, "ws_a"),
      periodStart: "2026-10-19T23:59:59.000Z",
      periodEnd: "2026-10-20T00:00:01.000Z",
    }),
    "usage_period_crosses_entitlement",
    409,
  );
  expect(await f.billing.usage(f.usage("paid_interval", 13, "ws_a"))).toEqual(paid);
  expect((await f.billing.workspaceUsage(ORG)).totals.usedMicros).toBe(50);
});

test("exact TTL and cleanup both refuse old continuations with fresh-page-required 409; cross-Org and changed filters refuse", async () => {
  const f = fixture();
  await f.billing.hold(f.hold("a", 1, "ws_a"));
  await f.billing.hold(f.hold("b", 1, "ws_b"));
  const first = await f.billing.workspaceUsage(ORG, { limit: 1 });
  expect(first.cursor).not.toBeNull();
  await errorCode(
    f.billing.workspaceUsage("foreign_org", { cursor: first.cursor ?? "" }),
    "invalid_cursor",
    400,
  );
  await errorCode(
    f.billing.workspaceUsage(ORG, { cursor: first.cursor ?? "", workspaceRef: "ws_a" }),
    "invalid_cursor",
    400,
  );
  f.time("2026-10-15T00:09:59.999Z");
  expect((await f.billing.workspaceUsage(ORG, { cursor: first.cursor ?? "" })).snapshotAt).toBe(
    first.snapshotAt,
  );
  f.time("2026-10-15T00:10:00.000Z");
  await errorCode(
    f.billing.workspaceUsage(ORG, { cursor: first.cursor ?? "" }),
    "workspace_snapshot_expired",
    409,
  );
  await f.billing.workspaceUsage(ORG);
  expect(
    (
      await f.sql.query("SELECT * FROM org_wallet_workspace_snapshots WHERE snapshot_at = ?", [
        first.snapshotAt,
      ])
    ).length,
  ).toBe(0);
  await errorCode(
    f.billing.workspaceUsage(ORG, { cursor: first.cursor ?? "" }),
    "workspace_snapshot_expired",
    409,
  );
});

test("expired live holds and release tombstones contribute no current usage", async () => {
  const f = fixture();
  await f.billing.release(ORG, "cancelled_before_admission");
  await errorCode(
    f.billing.hold(f.hold("cancelled_before_admission", 0, "ws_a")),
    "reference_conflict",
    409,
  );
  await f.billing.hold(f.hold("expires", 100, "ws_a"));
  f.time("2026-10-16T00:00:00.000Z");
  const page = await f.billing.workspaceUsage(ORG);
  expect(page.totals).toEqual({ usedMicros: 0, heldMicros: 0, pendingMicros: 0 });
  expect(await f.billing.readHold(ORG, "expires")).toMatchObject({
    status: "expired",
    workspaceRef: "ws_a",
  });
});

test("legacy unattributed hold replay and generic ledger debits are counted once without parsing references", async () => {
  const f = fixture();
  await f.billing.wallet(ORG);
  const old = f.hold("ws_legacy:opaque", 20);
  await f.ledger.hold({
    organizationId: ORG,
    reference: `org-hold:${old.reference}`,
    amountMicros: 20,
  });
  await f.sql.run(
    `INSERT INTO org_wallet_holds
    (org_id,ref,ledger_ref,amount_micros,fingerprint,pricing_revision,created_at,expires_at,state,money_policy)
    VALUES (?,?,?,?,?,?,?,?,'live','usd-micros-v2')`,
    [
      ORG,
      old.reference,
      `org-hold:${old.reference}`,
      20,
      JSON.stringify([20, "workspace-r1", "estimate"]),
      "workspace-r1",
      "2026-10-15T00:00:00.000Z",
      "2026-10-16T00:00:00.000Z",
    ],
  );
  expect((await f.billing.hold(old)).workspaceRef).toBeNull();
  await f.billing.capture(f.capture(old.reference, 8));
  await f.ledger.debitUsage({
    organizationId: ORG,
    reference: "unstructured_debit",
    amountMicros: 3,
  });
  const page = await f.billing.workspaceUsage(ORG);
  expect(page.workspaces).toEqual([]);
  expect(page.unattributed).toEqual({ usedMicros: 11, heldMicros: 0, pendingMicros: 0 });
  expect(page.totals).toEqual(page.unattributed);
});

test("same-snapshot read and first-write Org binding survive adversarial transaction interleaving", async () => {
  const f = fixture();
  let delivered = false;
  const interleaved: Sql = {
    query: (s, p) => f.sql.query(s, p),
    run: (s, p) => f.sql.run(s, p),
    async batch(statements) {
      if (!delivered && statements.some((s) => s.sql.includes("INSERT INTO org_wallet_holds"))) {
        delivered = true;
        await f.paid();
      }
      return f.sql.batch(statements);
    },
  };
  const admitted = await f.createBilling(interleaved).hold(f.hold("admission_race", 0, "ws_race"));
  expect(admitted.attributionPeriodStart).toBe("2026-10-10T00:00:00.000Z");
  const competing = await Promise.allSettled([
    f.billing.hold(f.hold("org_binding_a", 0, "ws_shared", ORG)),
    f.billing.hold(f.hold("org_binding_b", 0, "ws_shared", "another_org")),
  ]);
  expect(competing.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(competing.filter((r) => r.status === "rejected")).toHaveLength(1);
  const rejected = competing.find((r) => r.status === "rejected");
  if (rejected?.status === "rejected")
    expect(rejected.reason).toMatchObject({ code: "workspace_ref_conflict", status: 409 });
});

test("snapshot capacity is bounded and expired snapshots are reclaimed with bounded D1-safe statements", async () => {
  const f = fixture();
  let maxParams = 0;
  const checked: Sql = {
    query(s, p) {
      maxParams = Math.max(maxParams, p?.length ?? 0);
      return f.sql.query(s, p);
    },
    run(s, p) {
      maxParams = Math.max(maxParams, p?.length ?? 0);
      return f.sql.run(s, p);
    },
    batch(statements) {
      for (const statement of statements)
        maxParams = Math.max(maxParams, statement.params?.length ?? 0);
      return f.sql.batch(statements);
    },
  };
  const billing = f.createBilling(checked);
  await billing.hold(f.hold("parameter_hold", 10, "ws_parameters"));
  await billing.usage(f.usage("parameter_usage", 11, "ws_parameters"));
  for (let i = 0; i < 8; i++) await billing.workspaceUsage(ORG);
  await errorCode(billing.workspaceUsage(ORG), "billing_unavailable", 503);
  f.time("2026-10-15T00:10:00.000Z");
  await billing.workspaceUsage(ORG);
  expect(
    (await f.sql.query("SELECT * FROM org_wallet_workspace_snapshots WHERE org_id = ?", [ORG]))
      .length,
  ).toBe(1);
  expect(maxParams).toBeLessThanOrEqual(100);
});

test("unsafe aggregate and failed atomic snapshot publication expose no partial ready totals", async () => {
  const f = fixture();
  await f.billing.wallet(ORG);
  const broken: Sql = {
    query: (s, p) => f.sql.query(s, p),
    run: (s, p) => f.sql.run(s, p),
    batch(statements) {
      const failing = [...statements];
      failing.splice(3, 0, {
        sql: "INSERT INTO wallet_allocation_guards (id,valid) VALUES ('forced_snapshot_failure',0)",
      });
      return f.sql.batch(failing);
    },
  };
  await errorCode(f.createBilling(broken).workspaceUsage(ORG), "billing_unavailable", 503);
  expect((await f.sql.query("SELECT * FROM org_wallet_workspace_snapshots")).length).toBe(0);
  await f.sql.run(
    "INSERT INTO ledger (id,org_id,type,ref,settled_delta_micros,held_delta_micros,created_at) VALUES (?,?, 'usage_debit',?, ?,0,?)",
    ["unsafe_a", ORG, "legacy_a", -Number.MAX_SAFE_INTEGER, "2026-10-15T00:00:00.000Z"],
  );
  await f.sql.run(
    "INSERT INTO ledger (id,org_id,type,ref,settled_delta_micros,held_delta_micros,created_at) VALUES (?,?, 'usage_debit',?, -1,0,?)",
    ["unsafe_b", ORG, "legacy_b", "2026-10-15T00:00:00.000Z"],
  );
  await errorCode(f.billing.workspaceUsage(ORG), "billing_unavailable", 503);
  expect((await f.sql.query("SELECT * FROM org_wallet_workspace_snapshots")).length).toBe(0);
});

test("pending usage settles under original stop/prepaid consent and hold replays ignore later policy", async () => {
  const f = fixture();
  const clock = () => new Date("2026-10-15T00:00:00.000Z");
  const policy = createOrgLimitPolicy({ sql: f.sql, clock });
  const billing = f.createBilling(f.sql, policy);
  const stopped = f.usage("stop_pending", 1_500_001, "ws_a");
  expect((await billing.usage(stopped)).status).toBe("pending");
  await policy.change({
    organizationId: ORG,
    reference: "prepaid_consent",
    authorizedPrincipal: "session:owner",
    onLimit: "prepaid",
  });
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "cash",
    amountMicros: 2_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  expect((await billing.usage(stopped)).status).toBe("pending");
  await f.paid();
  expect((await billing.usage(stopped)).status).toBe("paid");
  const input = f.hold("pinned_hold", 10, "ws_a");
  const admitted = await billing.hold(input);
  await policy.change({
    organizationId: ORG,
    reference: "stop_again",
    authorizedPrincipal: "session:owner",
    onLimit: "stop",
  });
  expect(await billing.hold(input)).toEqual(admitted);
  expect((await billing.capture(f.capture(input.reference, 7))).status).toBe("captured");
  const record = (
    await f.sql.query(
      "SELECT admission_policy_json FROM org_wallet_usage_records WHERE org_id = ? AND ref = ?",
      [ORG, stopped.reference],
    )
  )[0];
  expect(JSON.parse(String(record?.admission_policy_json))).toMatchObject({
    onLimit: "stop",
    policyVersion: 0,
    allowPurchasedCredit: false,
  });
});

test("a changed consent between policy read and new hold batch rolls back admission and Workspace binding", async () => {
  const f = fixture();
  const policy = createOrgLimitPolicy({
    sql: f.sql,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
  });
  let changed = false;
  const interleaved: Sql = {
    query: (s, p) => f.sql.query(s, p),
    run: (s, p) => f.sql.run(s, p),
    async batch(statements) {
      if (!changed && statements.some((s) => s.sql.includes("INSERT INTO org_wallet_holds"))) {
        changed = true;
        await policy.change({
          organizationId: ORG,
          reference: "race_prepaid",
          authorizedPrincipal: "session:owner",
          onLimit: "prepaid",
        });
      }
      return f.sql.batch(statements);
    },
  };
  await errorCode(
    f.createBilling(interleaved, policy).hold(f.hold("stale_policy", 0, "ws_stale")),
    "conflict",
    409,
  );
  expect(
    (
      await f.sql.query("SELECT * FROM org_wallet_holds WHERE org_id = ? AND ref = ?", [
        ORG,
        "stale_policy",
      ])
    ).length,
  ).toBe(0);
  expect(
    (
      await f.sql.query("SELECT * FROM org_wallet_workspace_bindings WHERE workspace_ref = ?", [
        "ws_stale",
      ])
    ).length,
  ).toBe(0);
});

test("new Hosted summary exposes only proved purchased availability while preserving unknown direct credit", async () => {
  const f = fixture();
  const policy = createOrgLimitPolicy({
    sql: f.sql,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
  });
  const billing = f.createBilling(f.sql, policy);
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "unknown_direct",
    amountMicros: 30,
    consumptionClass: "purchased",
  });
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "stripe:cs_proven",
    amountMicros: 70,
    consumptionClass: "purchased",
  });
  await createStripeBillingStore({
    sql: f.sql,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
  }).grant({
    organizationId: ORG,
    fundingRef: "stripe:cs_proven",
    kind: "purchased",
    amountMicros: 70,
    expiresAt: null,
    sourceType: "checkout",
    sourceId: "cs_proven",
    chargeId: "ch_proven",
    customerId: null,
    subscriptionId: null,
    planKey: null,
    pricingRevision: null,
    stripePriceId: null,
    periodStart: null,
    periodEnd: null,
    considerationMicros: 70,
  });
  expect(await billing.usageSummary(ORG)).toMatchObject({
    purchasedAvailableMicros: 70,
    directAvailableMicros: 30,
  });
  // Legacy/self-host projection retains its original classification contract.
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    purchasedAvailableMicros: 100,
    directAvailableMicros: 0,
  });
  expect((await billing.workspaceUsage(ORG)).usageSummary).toMatchObject({
    purchasedAvailableMicros: 70,
    directAvailableMicros: 30,
  });
});

test("more than ten thousand Workspace rows refuses the entire snapshot instead of returning truncated totals", async () => {
  const f = fixture();
  await f.billing.wallet(ORG);
  await f.sql.run(
    `WITH RECURSIVE refs(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM refs WHERE n < 10001)
    INSERT INTO org_wallet_workspace_bindings (workspace_ref,org_id,created_at)
    SELECT 'ws_capacity_' || n, ?, ? FROM refs`,
    [ORG, "2026-10-15T00:00:00.000Z"],
  );
  await f.sql.run(
    `INSERT INTO org_wallet_holds
    (org_id,ref,ledger_ref,amount_micros,fingerprint,pricing_revision,created_at,expires_at,state,money_policy,
     workspace_ref,attribution_period_start,attribution_period_end)
    SELECT org_id, workspace_ref, 'org-hold:' || workspace_ref, 0, ?, 'workspace-r1', ?, ?, 'live', 'usd-micros-v2',
      workspace_ref, ?, ? FROM org_wallet_workspace_bindings WHERE org_id = ?`,
    [
      JSON.stringify([0, "workspace-r1", "estimate"]),
      "2026-10-15T00:00:00.000Z",
      "2026-10-16T00:00:00.000Z",
      OCT_START,
      OCT_END,
      ORG,
    ],
  );
  await errorCode(f.billing.workspaceUsage(ORG), "billing_unavailable", 503);
  expect(
    (await f.sql.query("SELECT * FROM org_wallet_workspace_snapshots WHERE org_id = ?", [ORG]))
      .length,
  ).toBe(0);
  expect(
    (await f.sql.query("SELECT * FROM org_wallet_workspace_snapshot_rows LIMIT 1")).length,
  ).toBe(0);
}, 30000);

test("native D1 preserves the atomic Workspace snapshot and expires it with FK cascade", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "hosted-workspace-usage",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "hosted-workspace-usage" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    // Copy the final empty portable schema as single native statements, rather than
    // pretending D1 supports an interactive migration transaction in this fixture.
    const source = createEphemeralSql();
    const definitions = await source.query(`SELECT type, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND substr(name,1,7) <> 'sqlite_'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`);
    for (const definition of definitions) {
      if (definition.type === "trigger") continue;
      await database.prepare(String(definition.sql)).run();
    }
    const unit = (await source.query("SELECT * FROM money_unit_policy WHERE singleton = 1"))[0];
    if (!unit) throw new Error("money unit fixture missing");
    const columns = Object.keys(unit);
    await database
      .prepare(
        `INSERT INTO money_unit_policy (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .bind(...columns.map((key) => unit[key]))
      .run();
    for (const definition of definitions) {
      if (definition.type === "trigger") await database.prepare(String(definition.sql)).run();
    }
    const f = fixture(createD1Sql(database));
    const policy = createOrgLimitPolicy({
      sql: f.sql,
      clock: () => new Date("2026-10-15T00:00:00.000Z"),
    });
    const billing = f.createBilling(f.sql, policy);
    await billing.hold(f.hold("native_a", 100, "ws_a"));
    await billing.hold(f.hold("native_b", 200, "ws_b"));
    const first = await billing.workspaceUsage(ORG, { limit: 1 });
    expect(first.totals).toEqual({ usedMicros: 0, heldMicros: 300, pendingMicros: 0 });
    await billing.capture(f.capture("native_b", 70));
    const second = await billing.workspaceUsage(ORG, { cursor: first.cursor ?? "" });
    expect(second.totals).toEqual(first.totals);
    expect(second.workspaces).toEqual([
      { workspaceRef: "ws_b", usedMicros: 0, heldMicros: 200, pendingMicros: 0 },
    ]);
    f.time("2026-10-15T00:10:00.000Z");
    await billing.workspaceUsage(ORG);
    await errorCode(
      billing.workspaceUsage(ORG, { cursor: first.cursor ?? "" }),
      "workspace_snapshot_expired",
      409,
    );
    const dangling =
      await f.sql.query(`SELECT COUNT(*) AS count FROM org_wallet_workspace_snapshot_rows r
      WHERE NOT EXISTS (SELECT 1 FROM org_wallet_workspace_snapshots s WHERE s.snapshot_ref = r.snapshot_ref)`);
    expect(dangling[0]?.count).toBe(0);
  } finally {
    await runtime.dispose();
  }
}, 60000);

test("transient held utilization queues80and95 in the same financial batch and never duplicates on release/replay", async () => {
  const f = fixture();
  const policy = createOrgLimitPolicy({
    sql: f.sql,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
  });
  const billing = f.createBilling(f.sql, policy);
  await billing.hold(f.hold("warning_eighty", 1_200_000, "ws_alert"));
  await billing.release(ORG, "warning_eighty");
  // No summary GET occurred before the hold was released.
  expect(
    await f.sql.query(
      "SELECT threshold_basis_points FROM org_wallet_usage_warnings ORDER BY threshold_basis_points",
    ),
  ).toEqual([{ threshold_basis_points: 8000 }]);
  const command = f.hold("warning_ninety_five", 1_425_000, "ws_alert");
  await billing.hold(command);
  await billing.capture(f.capture(command.reference, 1_425_000));
  await billing.hold(command);
  const rows = await f.sql.query(
    "SELECT threshold_basis_points,payload_json,state FROM org_wallet_usage_warnings ORDER BY threshold_basis_points",
  );
  expect(rows.map((r) => r.threshold_basis_points)).toEqual([8000, 9500]);
  expect(rows.map((r) => r.state)).toEqual(["pending", "pending"]);
  expect(JSON.parse(String(rows[0]?.payload_json))).toMatchObject({
    organizationId: ORG,
    heldMicros: "1200000",
    usedMicros: "0",
    thresholdBasisPoints: 8000,
  });
  expect(JSON.parse(String(rows[1]?.payload_json))).toMatchObject({
    heldMicros: "1425000",
    usedMicros: "0",
    thresholdBasisPoints: 9500,
  });
});

test("failure writing an atomic warning outbox rolls back the new hold, allocation and Workspace binding", async () => {
  const f = fixture();
  const policy = createOrgLimitPolicy({
    sql: f.sql,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
  });
  const broken: Sql = {
    query: (s, p) => f.sql.query(s, p),
    run: (s, p) => f.sql.run(s, p),
    batch(statements) {
      const outbox = statements.findIndex((statement) =>
        statement.sql.includes("INSERT INTO org_wallet_usage_warnings"),
      );
      if (outbox < 0) return f.sql.batch(statements);
      const failing = [...statements];
      failing.splice(outbox + 1, 0, {
        sql: "INSERT INTO wallet_allocation_guards (id,valid) VALUES ('outbox_failed',0)",
      });
      return f.sql.batch(failing);
    },
  };
  await errorCode(
    f.createBilling(broken, policy).hold(f.hold("unpublished_alert", 1_200_000, "ws_alert")),
    "billing_unavailable",
    503,
  );
  expect((await f.sql.query("SELECT * FROM org_wallet_holds WHERE org_id = ?", [ORG])).length).toBe(
    0,
  );
  expect(
    (await f.sql.query("SELECT * FROM org_wallet_usage_warnings WHERE org_id = ?", [ORG])).length,
  ).toBe(0);
  expect(
    (
      await f.sql.query("SELECT * FROM org_wallet_workspace_bindings WHERE workspace_ref = ?", [
        "ws_alert",
      ])
    ).length,
  ).toBe(0);
  expect((await f.ledger.wallet(ORG)).heldMicros).toBe(0);
});

test("a late paid proof cannot reinterpret an unattributed historical Free hold admission", async () => {
  const f = fixture();
  f.time("2026-10-12T00:00:00.000Z");
  await f.billing.wallet(ORG);
  await f.ledger.hold({
    organizationId: ORG,
    reference: "org-hold:legacy_before_invoice",
    amountMicros: 20,
  });
  await f.sql.run(
    `INSERT INTO org_wallet_holds
    (org_id,ref,ledger_ref,amount_micros,fingerprint,pricing_revision,created_at,expires_at,state,money_policy)
    VALUES (?, 'legacy_before_invoice','org-hold:legacy_before_invoice',20,?,'workspace-r1',?,?,'live','usd-micros-v2')`,
    [
      ORG,
      JSON.stringify([20, "workspace-r1", "estimate"]),
      "2026-10-12T00:00:00.000Z",
      "2026-10-13T00:00:00.000Z",
    ],
  );
  await f.billing.capture(f.capture("legacy_before_invoice", 8));
  f.time("2026-10-15T00:00:00.000Z");
  await f.paid();
  const paid = await f.billing.workspaceUsage(ORG);
  expect(paid.periodStart).toBe("2026-10-10T00:00:00.000Z");
  expect(paid.unattributed.usedMicros).toBe(0);
  f.time("2026-10-21T00:00:00.000Z");
  const free = await f.billing.workspaceUsage(ORG);
  expect(free.periodStart).toBe(OCT_START);
  expect(free.unattributed.usedMicros).toBe(8);
});

test("explicit Hosted admission requires Workspace metadata and never trusts origin or client identity claims", async () => {
  const f = fixture();
  const hosted = f.createBilling(f.sql, undefined, true);
  for (const workspaceRef of [undefined, "", "contains space"])
    await errorCode(
      hosted.hold(f.hold("required_hold", 0, workspaceRef)),
      "invalid_reference",
      400,
    );
  for (const workspaceRef of [undefined, "", "contains space"])
    await errorCode(
      hosted.usage(f.usage("required_usage", 0, workspaceRef)),
      "invalid_reference",
      400,
    );
  await errorCode(
    hosted.hold({
      ...f.hold("origin_hold", 0),
      ...{ origin: "takosumi", clientId: "asserted_client", workspaceId: "asserted_workspace" },
    }),
    "invalid_reference",
    400,
  );
  await errorCode(
    hosted.usage({
      ...f.usage("origin_usage", 0),
      ...{ origin: "takosumi", clientId: "asserted_client", workspaceId: "asserted_workspace" },
    }),
    "invalid_reference",
    400,
  );
  expect((await f.sql.query("SELECT * FROM org_wallet_holds WHERE org_id = ?", [ORG])).length).toBe(
    0,
  );
  expect(
    (await f.sql.query("SELECT * FROM org_wallet_usage_records WHERE org_id = ?", [ORG])).length,
  ).toBe(0);
  expect(
    (await f.sql.query("SELECT * FROM org_wallet_workspace_bindings WHERE org_id = ?", [ORG]))
      .length,
  ).toBe(0);
  expect(
    (
      await f.sql.query(
        "SELECT * FROM ledger WHERE org_id = ? AND type IN ('hold','capture','usage_debit')",
        [ORG],
      )
    ).length,
  ).toBe(0);
  expect((await hosted.hold(f.hold("explicit_hold", 1, "ws_required"))).workspaceRef).toBe(
    "ws_required",
  );
  expect((await hosted.usage(f.usage("explicit_usage", 1, "ws_required"))).workspaceRef).toBe(
    "ws_required",
  );
});

test("Hosted requires only new admissions while legacy unattributed hold, paid/pending usage and tombstone replays keep their semantics", async () => {
  const f = fixture();
  const oldHold = f.hold("legacy_optional_hold", 20);
  const legacyHoldReceipt = await f.billing.hold(oldHold);
  const paidCommand = f.usage("legacy_paid", 7);
  const paidReceipt = await f.billing.usage(paidCommand);
  const pendingCommand = f.usage("legacy_pending", 2_000_000);
  const pendingReceipt = await f.billing.usage(pendingCommand);
  expect(pendingReceipt.status).toBe("pending");
  const hosted = f.createBilling(f.sql, undefined, true);
  expect(await hosted.hold(oldHold)).toEqual(legacyHoldReceipt);
  expect(await hosted.usage(paidCommand)).toEqual(paidReceipt);
  expect(await hosted.usage(pendingCommand)).toEqual(pendingReceipt);
  await errorCode(
    hosted.hold({ ...oldHold, measurementFingerprint: "changed" }),
    "reference_conflict",
    409,
  );
  await errorCode(
    hosted.usage({ ...paidCommand, measurementFingerprint: "changed" }),
    "reference_conflict",
    409,
  );
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "legacy_recovery_cash",
    amountMicros: 2_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  const recovered = await hosted.usage(pendingCommand);
  expect(recovered).toMatchObject({ status: "paid", workspaceRef: null });
  expect(await hosted.usage(pendingCommand)).toEqual(recovered);
  const settled = await hosted.capture(f.capture(oldHold.reference, 8));
  expect(settled).toMatchObject({ status: "captured", workspaceRef: null, capturedMicros: 8 });
  expect(await hosted.hold(oldHold)).toEqual(settled);
  await hosted.release(ORG, "legacy_tombstone");
  await errorCode(hosted.hold(f.hold("legacy_tombstone", 0)), "reference_conflict", 409);
  await errorCode(hosted.hold(f.hold("genuinely_new", 0)), "invalid_reference", 400);
});

test("attributed replays remain exact under Hosted enforcement and standalone admission stays optional", async () => {
  const f = fixture();
  const hosted = f.createBilling(f.sql, undefined, true);
  const command = f.hold("owned_hold", 10, "ws_owned");
  const receipt = await hosted.hold(command);
  expect(await hosted.hold(command)).toEqual(receipt);
  await errorCode(hosted.hold(f.hold(command.reference, 10)), "reference_conflict", 409);
  await errorCode(hosted.hold({ ...command, workspaceRef: "ws_other" }), "reference_conflict", 409);
  const usage = f.usage("owned_usage", 1, "ws_owned");
  const paid = await hosted.usage(usage);
  expect(await hosted.usage(usage)).toEqual(paid);
  await errorCode(hosted.usage(f.usage(usage.reference, 1)), "reference_conflict", 409);
  await errorCode(hosted.usage({ ...usage, workspaceRef: "ws_other" }), "reference_conflict", 409);
  expect((await f.billing.hold(f.hold("independent_optional", 0))).workspaceRef).toBeNull();
  expect((await f.billing.usage(f.usage("independent_optional_usage", 0))).workspaceRef).toBeNull();
});

test("Hosted legacy pending rows without a consent witness refuse purchased/direct funding even after prepaid consent", async () => {
  const f = fixture();
  const command = f.usage("unproven_legacy_pending", 2_000_000);
  const pending = await f.billing.usage(command);
  expect(pending).toMatchObject({ status: "pending", workspaceRef: null });
  const policy = createOrgLimitPolicy({
    sql: f.sql,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
  });
  await policy.change({
    organizationId: ORG,
    reference: "current_prepaid",
    authorizedPrincipal: "session:owner",
    onLimit: "prepaid",
  });
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "purchase_after_consumption",
    amountMicros: 3_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "direct_after_consumption",
    amountMicros: 3_000_000,
    consumptionClass: "purchased",
  });
  const hosted = f.createBilling(f.sql, policy, true);
  expect(await hosted.usage(command)).toEqual(pending);
  expect(
    (await f.sql.query("SELECT * FROM ledger WHERE org_id = ? AND type = 'usage_debit'", [ORG]))
      .length,
  ).toBe(0);
  expect(
    (
      await f.sql.query(
        "SELECT * FROM wallet_credit_allocations WHERE org_id = ? AND debit_type = 'usage_debit'",
        [ORG],
      )
    ).length,
  ).toBe(0);
  expect(
    (
      await f.sql.query(
        "SELECT admission_policy_json FROM org_wallet_usage_records WHERE org_id = ? AND ref = ?",
        [ORG, command.reference],
      )
    )[0]?.admission_policy_json,
  ).toBeNull();
  // A verified included grant can settle the same pending record; it is not
  // re-admitted, assigned to another Workspace, or rewritten with new consent.
  await f.paid();
  const paid = await hosted.usage(command);
  expect(paid).toMatchObject({ status: "paid", workspaceRef: null, amountMicros: 2_000_000 });
  expect(await hosted.usage(command)).toEqual(paid);
  const allocations = await f.sql.query(
    `SELECT l.consumption_class FROM wallet_credit_allocations a
    JOIN wallet_credit_lots l ON l.org_id = a.org_id AND l.ref = a.lot_ref
    WHERE a.org_id = ? AND a.debit_type = 'usage_debit'`,
    [ORG],
  );
  expect(allocations).toEqual([{ consumption_class: "subscription" }]);
});

test("Hosted preserves already-funded legacy purchase holds and paid usage without inventing new consent", async () => {
  const f = fixture();
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "original_purchase",
    amountMicros: 2_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  const command = f.hold("legacy_purchase_hold", 2_000_000);
  const admitted = await f.billing.hold(command);
  const paidCommand = f.usage("legacy_purchase_paid", 7);
  const oldPaid = await f.billing.usage(paidCommand);
  const policy = createOrgLimitPolicy({
    sql: f.sql,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
  });
  const hosted = f.createBilling(f.sql, policy, true);
  expect(await hosted.hold(command)).toEqual(admitted);
  expect(await hosted.usage(paidCommand)).toEqual(oldPaid);
  const captured = await hosted.capture(f.capture(command.reference, 2_000_000));
  expect(captured).toMatchObject({
    status: "captured",
    capturedMicros: 2_000_000,
    workspaceRef: null,
  });
  expect(await hosted.hold(command)).toEqual(captured);
  expect(
    (
      await f.sql.query(
        "SELECT admission_policy_json FROM org_wallet_holds WHERE org_id = ? AND ref = ?",
        [ORG, command.reference],
      )
    )[0]?.admission_policy_json,
  ).toBeNull();
});
