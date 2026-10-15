import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { canonicalJson } from "../src/json.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createStripeBillingClient,
  type StripeBillingObject,
} from "../src/stripe-billing-client.ts";
import {
  createSubscriptionPlanChanges,
  type QualifiedSubscriptionPlan,
  type SubscriptionPeriodTerms,
  type SubscriptionPlanCustody,
  type SubscriptionPlanTarget,
} from "../src/stripe-subscription-plan-change.ts";

const START = "2026-10-01T00:00:00.000Z";
const NEXT = "2026-11-01T00:00:00.000Z";
const AFTER = "2026-12-01T00:00:00.000Z";
const NOW = "2026-10-15T00:00:00.000Z";
const REF = `sra_${"a".repeat(64)}`;
const OLD: SubscriptionPeriodTerms = {
  organizationId: "org_plan",
  subscriptionId: "sub_plan",
  customerId: "cus_plan",
  planKey: "paid-10",
  pricingRevision: "old-revision",
  priceId: "price_old",
  priceAmountMinor: 1000,
  includedMinor: 2000,
};
const PLAN: QualifiedSubscriptionPlan = {
  planKey: "paid-50",
  pricingRevision: "new-revision",
  priceId: "price_new",
  priceAmountMinor: 5000,
  includedMinor: 10000,
};
const NEW = { ...OLD, ...PLAN };
const request = {
  organizationId: OLD.organizationId,
  reference: "upgrade-1",
  expectedSubscriptionRef: REF,
  planKey: PLAN.planKey,
};
const metadata = (terms: SubscriptionPeriodTerms) => ({
  takoserverPurpose: "hosted_subscription",
  organizationId: terms.organizationId,
  planKey: terms.planKey,
  pricingRevision: terms.pricingRevision,
  retained: "value",
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function fixture(
  input: {
    readonly lostAck?: "create" | "schedule" | "release";
    readonly corrupt?: "metadata" | "anchor" | "settings" | "future-settings";
    readonly lostBatch?: boolean;
    readonly qualifiedRecovery?: boolean;
    readonly afterPrepare?: "period" | "generation";
    readonly calendar?: {
      readonly start: string;
      readonly end: string;
      readonly next: string;
      readonly now: string;
    };
  } = {},
) {
  const calendar = input.calendar ?? { start: START, end: NEXT, next: AFTER, now: NOW };
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  // The forward schema is deliberately required. An operator-private draft can
  // be injected while the reserved #342 prefix is awaiting owner integration.
  const schema =
    process.env.TAKOSERVER_BILLING_EXTENSION_TEST_SCHEMA ??
    new URL("../migrations/0099_hosted_billing_extensions.sql", import.meta.url).pathname;
  if (!db.query("SELECT name FROM sqlite_schema WHERE name='stripe_billing_plan_changes'").get())
    db.exec(await Bun.file(schema).text());
  const base = createSqliteSql(db);
  db.exec(
    "CREATE TABLE custody_test_target(org_id TEXT PRIMARY KEY,subscription_id TEXT,generation INTEGER,ref TEXT)",
  );
  await base.run("INSERT INTO custody_test_target VALUES(?,?,1,?)", [
    OLD.organizationId,
    OLD.subscriptionId,
    REF,
  ]);
  let loseBatch = input.lostBatch === true;
  let afterPrepare = input.afterPrepare;
  let at = calendar.now;
  const sql: Sql = {
    query: (statement, params) => base.query(statement, params),
    run: (statement, params) => base.run(statement, params),
    async batch(statements) {
      const result = await base.batch(statements);
      if (
        afterPrepare &&
        statements.some((item) => item.sql.includes("INSERT INTO stripe_billing_plan_changes"))
      ) {
        if (afterPrepare === "period") at = calendar.end;
        else
          await base.run("UPDATE custody_test_target SET generation=2 WHERE org_id=?", [
            OLD.organizationId,
          ]);
        afterPrepare = undefined;
      }
      if (
        loseBatch &&
        statements.some((item) => item.sql.includes("INSERT INTO stripe_billing_plan_changes"))
      ) {
        loseBatch = false;
        throw new SqlError("unavailable", "lost local commit acknowledgement");
      }
      return result;
    },
  };
  let schedule: StripeBillingObject | null = null;
  const subscription: StripeBillingObject = {
    id: OLD.subscriptionId,
    livemode: false,
    customer: OLD.customerId,
    current_period_start: Date.parse(calendar.start) / 1000,
    current_period_end: Date.parse(calendar.end) / 1000,
    billing_cycle_anchor: Date.parse(calendar.start) / 1000,
    metadata: metadata(OLD),
    items: { has_more: false, data: [{ price: OLD.priceId, quantity: 1 }] },
    schedule: null,
    status: "active",
    cancel_at_period_end: false,
  };
  const calls: {
    method: string;
    path: string;
    key: string | null;
    form: Record<string, string>;
  }[] = [];
  const client = createStripeBillingClient({
    secretKey: "sk_test_fixture_never_a_credential",
    async fetch(http) {
      const path = new URL(http.url).pathname;
      const form = Object.fromEntries(new URLSearchParams(await http.text()));
      calls.push({ method: http.method, path, key: http.headers.get("idempotency-key"), form });
      if (http.method === "GET") {
        if (path === `/v1/subscriptions/${OLD.subscriptionId}`) return Response.json(subscription);
        if (path === "/v1/subscription_schedules/sub_sched_plan" && schedule)
          return Response.json(schedule);
        return new Response("", { status: 404 });
      }
      if (path === "/v1/subscription_schedules") {
        expect(form).toEqual({ from_subscription: OLD.subscriptionId });
        schedule = {
          id: "sub_sched_plan",
          livemode: false,
          customer: OLD.customerId,
          subscription: OLD.subscriptionId,
          status: "active",
          end_behavior: "release",
          metadata: {},
          default_settings: {
            collection_method: "charge_automatically",
            default_payment_method: "pm_fixture",
            automatic_tax: { enabled: false, liability: null },
            billing_cycle_anchor: "automatic",
            billing_thresholds: null,
            application_fee_percent: null,
            on_behalf_of: null,
            transfer_data: null,
            invoice_settings: {
              account_tax_ids: null,
              days_until_due: null,
              issuer: { type: "self" },
            },
          },
          phases: [
            {
              start_date: subscription.current_period_start,
              end_date: subscription.current_period_end,
              currency: "usd",
              add_invoice_items: [],
              application_fee_percent: null,
              automatic_tax: { enabled: false, liability: null },
              billing_cycle_anchor: null,
              billing_thresholds: null,
              coupon: null,
              default_tax_rates: [],
              discounts: [],
              on_behalf_of: null,
              transfer_data: null,
              trial_end: null,
              collection_method: "charge_automatically",
              default_payment_method: "pm_fixture",
              description: "keep-description",
              invoice_settings: { days_until_due: null, account_tax_ids: null, issuer: null },
              metadata: {},
              proration_behavior: "create_prorations",
              items: [
                {
                  price: (subscription.items as { data: { price: string }[] }).data[0]?.price,
                  plan: (subscription.items as { data: { price: string }[] }).data[0]?.price,
                  quantity: 1,
                  metadata: { retainedItem: "item" },
                  tax_rates: [],
                  discounts: [],
                  billing_thresholds: null,
                },
              ],
            },
          ],
        };
        subscription.schedule = schedule.id;
        if (input.lostAck === "create") throw new Error("lost create acknowledgement");
        return Response.json(schedule);
      }
      if (path.endsWith("/release")) {
        if (!schedule) throw new Error("missing schedule");
        schedule.status = "released";
        schedule.subscription = null;
        schedule.released_subscription = OLD.subscriptionId;
        schedule.released_at = Date.parse(at) / 1000;
        subscription.schedule = null;
        if (input.lostAck === "release") throw new Error("lost release acknowledgement");
        return Response.json(schedule);
      }
      if (path === "/v1/subscription_schedules/sub_sched_plan") {
        if (!schedule) throw new Error("missing schedule");
        const phase = (index: number) => ({
          start_date: Number(form[`phases[${index}][start_date]`]),
          end_date: Number(form[`phases[${index}][end_date]`]),
          currency: "usd",
          add_invoice_items: [],
          application_fee_percent: null,
          automatic_tax: { enabled: false, liability: null },
          billing_cycle_anchor: null,
          billing_thresholds: null,
          coupon: null,
          default_tax_rates: [],
          discounts: [],
          on_behalf_of: null,
          transfer_data: null,
          trial_end: null,
          collection_method: form[`phases[${index}][collection_method]`],
          default_payment_method: form[`phases[${index}][default_payment_method]`],
          description: form[`phases[${index}][description]`],
          invoice_settings: { days_until_due: null, account_tax_ids: null, issuer: null },
          proration_behavior: form[`phases[${index}][proration_behavior]`],
          metadata: Object.fromEntries(
            Object.entries(form)
              .filter(([key]) => key.startsWith(`phases[${index}][metadata][`))
              .map(([key, value]) => [key.slice(`phases[${index}][metadata][`.length, -1), value]),
          ),
          items: [
            {
              price: form[`phases[${index}][items][0][price]`],
              quantity: Number(form[`phases[${index}][items][0][quantity]`]),
              metadata: { retainedItem: "item" },
              tax_rates: [],
              discounts: [],
              billing_thresholds: null,
            },
          ],
        });
        schedule.phases = [phase(0), phase(1)];
        schedule.end_behavior = form.end_behavior;
        schedule.metadata = { takoserverPlanCommand: form["metadata[takoserverPlanCommand]"] };
        if (input.corrupt === "metadata")
          (
            (schedule.phases as Record<string, unknown>[])[1]?.metadata as Record<string, unknown>
          ).pricingRevision = OLD.pricingRevision;
        if (input.corrupt === "settings")
          schedule.default_settings = { collection_method: "send_invoice" };
        if (input.corrupt === "future-settings") {
          const future = (schedule.phases as Record<string, unknown>[])[1];
          if (!future) throw new Error("missing future fixture phase");
          future.description = "unexpected-description";
        }
        if (input.corrupt === "anchor") subscription.billing_cycle_anchor = Date.parse(NEXT) / 1000;
        if (input.lostAck === "schedule") throw new Error("lost update acknowledgement");
        return Response.json(schedule);
      }
      throw new Error(`unexpected Stripe route ${path}`);
    },
  });
  const cancelCalls: unknown[] = [];
  const custody: SubscriptionPlanCustody = {
    async originalTerms(subscriptionId) {
      expect(subscriptionId).toBe(OLD.subscriptionId);
      return { terms: OLD, effectiveAt: calendar.start };
    },
    async readTarget(org, ref) {
      if (org !== OLD.organizationId || ref !== REF) throw new Error("wrong custody target");
      const target: SubscriptionPlanTarget = {
        subscriptionRef: REF,
        generation: 1,
        terms:
          (subscription.metadata as Record<string, unknown>).planKey === PLAN.planKey ? NEW : OLD,
        originalEffectiveAt: calendar.start,
        periodStart: new Date(Number(subscription.current_period_start) * 1000).toISOString(),
        periodEnd: new Date(Number(subscription.current_period_end) * 1000).toISOString(),
        billingCycleAnchor: Date.parse(calendar.start) / 1000,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        unresolvedSettlement: false,
        scheduleId: subscription.schedule == null ? null : String(subscription.schedule),
      };
      return target;
    },
    fence(target) {
      return {
        condition:
          "EXISTS(SELECT 1 FROM custody_test_target WHERE org_id=? AND subscription_id=? AND generation=? AND ref=?)",
        params: [
          target.terms.organizationId,
          target.terms.subscriptionId,
          target.generation,
          target.subscriptionRef,
        ],
      };
    },
    async cancel(cancelInput) {
      expect(subscription.schedule).toBeNull();
      expect(cancelInput.cancelAtPeriodEnd).toBe(true);
      expect(cancelInput.expectedSubscriptionRef).toBe(REF);
      cancelCalls.push(cancelInput);
      subscription.cancel_at_period_end = true;
      return {
        state: "verified",
        subscriptionRef: REF,
        effectiveAt: new Date(Number(subscription.current_period_end) * 1000).toISOString(),
      };
    },
    async recoverCreatedSchedule() {
      return input.qualifiedRecovery ? clone(schedule) : null;
    },
  };
  const make = (qualifyPlan?: (planKey: string) => Promise<QualifiedSubscriptionPlan>) =>
    createSubscriptionPlanChanges({
      sql,
      clock: () => new Date(at),
      client,
      custody,
      realm: {
        accountId: "acct_test_fixture",
        livemode: false,
        billingAuthority: "authority_fixture",
      },
      qualifyPlan:
        qualifyPlan ??
        (async (planKey) => {
          expect(planKey).toBe(PLAN.planKey);
          return PLAN;
        }),
    });
  return {
    db,
    base,
    sql,
    make,
    client,
    subscription,
    calls,
    cancelCalls,
    custody,
    schedule: () => schedule,
    activate() {
      at = new Date(Date.parse(calendar.end) + 86400000).toISOString();
      subscription.current_period_start = Date.parse(calendar.end) / 1000;
      subscription.current_period_end = Date.parse(calendar.next) / 1000;
      subscription.metadata = metadata(NEW);
      subscription.items = { has_more: false, data: [{ price: NEW.priceId, quantity: 1 }] };
    },
  };
}

function retainedReader(h: Awaited<ReturnType<typeof fixture>>) {
  const forbidden: string[] = [];
  const refuse = (port: string): never => {
    forbidden.push(port);
    throw new Error(`historical read used ${port}`);
  };
  const service = createSubscriptionPlanChanges({
    sql: {
      query: (statement, params) => h.base.query(statement, params),
      run: async () => refuse("sql.run"),
      batch: async () => refuse("sql.batch"),
    },
    clock: () => refuse("clock"),
    client: {
      get: async () => refuse("client.get"),
      post: async () => refuse("client.post"),
      list: async () => refuse("client.list"),
    },
    custody: {
      readTarget: async () => refuse("custody.readTarget"),
      verifyTarget: async () => refuse("custody.verifyTarget"),
      originalTerms: async () => refuse("custody.originalTerms"),
      fence: () => refuse("custody.fence"),
      cancel: async () => refuse("custody.cancel"),
      recoverCreatedSchedule: async () => refuse("custody.recoverCreatedSchedule"),
    },
    realm: {
      accountId: "acct_test_fixture",
      livemode: false,
      billingAuthority: "authority_fixture",
    },
    qualifyPlan: async () => refuse("qualifyPlan"),
  });
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "stripe_billing_plan_changes",
          "stripe_billing_plan_change_steps",
          "stripe_billing_plan_change_slots",
          "stripe_billing_subscription_terms",
          "stripe_billing_subscription_term_revocations",
          "stripe_billing_grants",
        ].map(async (table) => [table, await h.base.query(`SELECT * FROM ${table}`)]),
      ),
    );
  return { read: service.readCommand, forbidden, snapshot };
}

describe("retained subscription command descriptors", () => {
  test("pending plan and lost-release cancellation are local reads without recovery or dispatch", async () => {
    const pending = await fixture({ lostAck: "create" });
    const cancel = await fixture({ lostAck: "release" });
    try {
      await pending.make().change(request);
      await cancel.make().change(request);
      await cancel.make().cancelPendingChange({
        organizationId: OLD.organizationId,
        reference: "cancel-read",
        expectedSubscriptionRef: REF,
      });
      for (const [h, reference, kind] of [
        [pending, request.reference, "plan-change"],
        [cancel, "cancel-read", "cancel"],
      ] as const) {
        const reader = retainedReader(h),
          before = await reader.snapshot(),
          calls = h.calls.length,
          native = h.cancelCalls.length;
        expect(await reader.read(OLD.organizationId, reference, kind)).toMatchObject({
          organizationId: OLD.organizationId,
          reference,
          kind,
          state: "pending",
          lifecycle: "pending",
          subscriptionRef: REF,
          ...(kind === "plan-change" ? { pendingChange: null } : {}),
        });
        expect(await reader.snapshot()).toEqual(before);
        expect(reader.forbidden).toEqual([]);
        expect(h.calls).toHaveLength(calls);
        expect(h.cancelCalls).toHaveLength(native);
      }
    } finally {
      pending.db.close();
      cancel.db.close();
    }
  });

  test("schedule acknowledgement and changed time, projection or slot do not prove activation", async () => {
    const h = await fixture();
    try {
      await h.make().change(request);
      h.activate();
      await h.base.run("DELETE FROM stripe_billing_plan_change_slots");
      await h.base.run(
        "UPDATE custody_test_target SET subscription_id='sub_replacement',generation=2,ref=?",
        [`sra_${"b".repeat(64)}`],
      );
      const reader = retainedReader(h),
        before = await reader.snapshot(),
        calls = h.calls.length;
      expect(await reader.read(OLD.organizationId, request.reference, "plan-change")).toEqual({
        organizationId: OLD.organizationId,
        reference: request.reference,
        kind: "plan-change",
        state: "verified",
        lifecycle: "scheduled",
        subscriptionRef: REF,
        planKey: PLAN.planKey,
        pricingRevision: PLAN.pricingRevision,
        effectiveAt: NEXT,
        pendingChange: {
          planKey: PLAN.planKey,
          pricingRevision: PLAN.pricingRevision,
          effectiveAt: NEXT,
        },
      });
      expect(await reader.snapshot()).toEqual(before);
      expect(reader.forbidden).toEqual([]);
      expect(h.calls).toHaveLength(calls);
    } finally {
      h.db.close();
    }
  });

  test("an unverified activation-release and a late cancellation release do not establish activation", async () => {
    const lost = await fixture({ lostAck: "release" });
    const late = await fixture();
    try {
      await lost.make().change(request);
      lost.activate();
      expect(await lost.make().reconcileActivation(OLD.organizationId, REF)).toEqual({
        completed: false,
      });
      await late.make().change(request);
      late.activate();
      await late.make().cancelPendingChange({
        organizationId: OLD.organizationId,
        reference: "late-cancel",
        expectedSubscriptionRef: REF,
      });
      for (const h of [lost, late]) {
        const reader = retainedReader(h),
          before = await reader.snapshot(),
          calls = h.calls.length;
        expect(
          await reader.read(OLD.organizationId, request.reference, "plan-change"),
        ).toMatchObject({
          lifecycle: "scheduled",
          pendingChange: {
            planKey: PLAN.planKey,
            pricingRevision: PLAN.pricingRevision,
            effectiveAt: NEXT,
          },
        });
        expect(await reader.snapshot()).toEqual(before);
        expect(reader.forbidden).toEqual([]);
        expect(h.calls).toHaveLength(calls);
      }
    } finally {
      lost.db.close();
      late.db.close();
    }
  });

  test("verified activation workflow and repeated plan transitions retain the first command's exact original terms", async () => {
    const h = await fixture();
    try {
      await h.make().change(request);
      h.activate();
      expect(await h.make().reconcileActivation(OLD.organizationId, REF)).toEqual({
        completed: true,
      });
      const reader = retainedReader(h);
      const original = await reader.read(OLD.organizationId, request.reference, "plan-change");
      expect(original).toMatchObject({
        state: "verified",
        lifecycle: "activated",
        effectiveAt: NEXT,
        planKey: PLAN.planKey,
        pendingChange: {
          planKey: PLAN.planKey,
          pricingRevision: PLAN.pricingRevision,
          effectiveAt: NEXT,
        },
      });
      const olderPlan = {
        planKey: OLD.planKey,
        pricingRevision: OLD.pricingRevision,
        priceId: OLD.priceId,
        priceAmountMinor: OLD.priceAmountMinor,
        includedMinor: OLD.includedMinor,
      };
      expect(
        await h
          .make(async () => olderPlan)
          .change({ ...request, reference: "second-transition", planKey: olderPlan.planKey }),
      ).toMatchObject({
        state: "verified",
        pendingChange: { planKey: OLD.planKey, effectiveAt: AFTER },
      });
      await h.base.run(
        "UPDATE custody_test_target SET subscription_id='sub_replacement',generation=2,ref=?",
        [`sra_${"b".repeat(64)}`],
      );
      const before = await reader.snapshot(),
        calls = h.calls.length;
      expect(await reader.read(OLD.organizationId, request.reference, "plan-change")).toEqual(
        original,
      );
      expect(
        await reader.read(OLD.organizationId, "second-transition", "plan-change"),
      ).toMatchObject({
        lifecycle: "scheduled",
        effectiveAt: AFTER,
        subscriptionRef: REF,
        planKey: OLD.planKey,
      });
      expect(await reader.snapshot()).toEqual(before);
      expect(reader.forbidden).toEqual([]);
      expect(h.calls).toHaveLength(calls);
    } finally {
      h.db.close();
    }
  });

  test("matching verified release revokes the original plan while the old cancellation receipt stays scheduled after replacement", async () => {
    const h = await fixture();
    try {
      await h.make().change(request);
      await h.make().cancelPendingChange({
        organizationId: OLD.organizationId,
        reference: "cancel-read",
        expectedSubscriptionRef: REF,
      });
      h.subscription.status = "canceled";
      await h.make().reconcilePending();
      await h.base.run(
        "UPDATE custody_test_target SET subscription_id='sub_replacement',generation=2,ref=?",
        [`sra_${"b".repeat(64)}`],
      );
      const reader = retainedReader(h),
        before = await reader.snapshot(),
        calls = h.calls.length,
        native = h.cancelCalls.length;
      expect(await reader.read(OLD.organizationId, request.reference, "plan-change")).toMatchObject(
        {
          lifecycle: "revoked",
          pendingChange: {
            planKey: PLAN.planKey,
            pricingRevision: PLAN.pricingRevision,
            effectiveAt: NEXT,
          },
        },
      );
      expect(await reader.read(OLD.organizationId, "cancel-read", "cancel")).toEqual({
        organizationId: OLD.organizationId,
        reference: "cancel-read",
        kind: "cancel",
        state: "verified",
        lifecycle: "scheduled",
        subscriptionRef: REF,
        planKey: OLD.planKey,
        pricingRevision: OLD.pricingRevision,
        effectiveAt: NEXT,
      });
      expect(await reader.snapshot()).toEqual(before);
      expect(reader.forbidden).toEqual([]);
      expect(h.calls).toHaveLength(calls);
      expect(h.cancelCalls).toHaveLength(native);
    } finally {
      h.db.close();
    }
  });

  test("wrong kind or Organization cannot retrieve a command; malformed and corrupt pins refuse without effects", async () => {
    const h = await fixture();
    try {
      await h.make().change(request);
      const reader = retainedReader(h),
        before = await reader.snapshot(),
        calls = h.calls.length;
      expect(await reader.read(OLD.organizationId, request.reference, "cancel")).toBeNull();
      expect(await reader.read("org_foreign", request.reference, "plan-change")).toBeNull();
      expect(await reader.read(OLD.organizationId, "missing", "plan-change")).toBeNull();
      for (const reference of ["", "../private", "x".repeat(129)])
        await expect(
          reader.read(OLD.organizationId, reference, "plan-change"),
        ).rejects.toMatchObject({ status: 400 });
      expect(await reader.snapshot()).toEqual(before);
      expect(reader.forbidden).toEqual([]);
      expect(h.calls).toHaveLength(calls);
      const query = h.base.query;
      for (const contradiction of [
        { fingerprint: "sha256:contradictory" },
        { expected_subscription_ref: `sra_${"b".repeat(64)}` },
        { subscription_id: "sub_replacement" },
        { expected_generation: 2 },
      ]) {
        const corrupt: Sql = {
          query: async (statement, params) =>
            (await query(statement, params)).map((row) =>
              statement.startsWith("SELECT * FROM stripe_billing_plan_changes")
                ? { ...row, ...contradiction }
                : row,
            ),
          run: async () => {
            throw new Error("write forbidden");
          },
          batch: async () => {
            throw new Error("write forbidden");
          },
        };
        const service = createSubscriptionPlanChanges({
          sql: corrupt,
          client: h.client,
          clock: () => {
            throw new Error("clock forbidden");
          },
          custody: h.custody,
          realm: {
            accountId: "acct_test_fixture",
            livemode: false,
            billingAuthority: "authority_fixture",
          },
          qualifyPlan: async () => PLAN,
        });
        await expect(
          service.readCommand(OLD.organizationId, request.reference, "plan-change"),
        ).rejects.toMatchObject({ status: 503 });
      }
      expect(await reader.snapshot()).toEqual(before);
      expect(h.calls).toHaveLength(calls);
    } finally {
      h.db.close();
    }
  });
});

describe("custodied next-period subscription changes", () => {
  test("freezes future Price and metadata together; exact retry preserves its receipt and no credit is granted", async () => {
    const h = await fixture();
    const first = await h.make().change(request);
    expect(first).toEqual({
      state: "verified",
      subscriptionRef: REF,
      pendingChange: {
        planKey: PLAN.planKey,
        pricingRevision: PLAN.pricingRevision,
        effectiveAt: NEXT,
      },
    });
    expect(await h.make().change(request)).toEqual(first);
    expect(await h.make().pending(OLD.organizationId)).toEqual({
      planKey: PLAN.planKey,
      pricingRevision: PLAN.pricingRevision,
      effectiveAt: NEXT,
    });
    const posts = h.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.form).toMatchObject({
      proration_behavior: "none",
      "phases[0][proration_behavior]": "none",
      "phases[1][proration_behavior]": "none",
      "phases[0][items][0][price]": OLD.priceId,
      "phases[1][items][0][price]": PLAN.priceId,
      "phases[1][metadata][planKey]": PLAN.planKey,
      "phases[1][metadata][pricingRevision]": PLAN.pricingRevision,
      "phases[1][description]": "keep-description",
      "phases[1][items][0][metadata][retainedItem]": "item",
      "phases[1][end_date]": String(Date.parse(AFTER) / 1000),
    });
    expect(
      posts.every(
        (call) => !Object.keys(call.form).some((key) => key.includes("billing_cycle_anchor")),
      ),
    ).toBe(true);
    expect(posts[0]?.key).not.toBe(posts[1]?.key);
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_grants").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT count(*) AS n FROM wallet_credit_lots").get()).toEqual({ n: 0 });
  });

  test("real SQL elects one command for concurrent distinct references and preserves first immutable receipt", async () => {
    const h = await fixture({ lostBatch: true });
    const results = await Promise.allSettled([
      h.make().change(request),
      h.make().change({ ...request, reference: "upgrade-other" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_plan_changes").get()).toEqual({
      n: 1,
    });
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    const winner = h.db.query("SELECT reference FROM stripe_billing_plan_changes").get() as {
      reference: string;
    };
    expect(await h.make().change({ ...request, reference: winner.reference })).toMatchObject({
      state: "verified",
    });
    await expect(
      h.make().change({ ...request, reference: winner.reference, planKey: OLD.planKey }),
    ).rejects.toMatchObject({
      code: "payment_command_conflict",
      status: 409,
    });
  });

  test("lost update acknowledgement recovers GET-only across restart with the same frozen step keys", async () => {
    const h = await fixture({ lostAck: "schedule" });
    expect(await h.make().change(request)).toEqual({ state: "pending", subscriptionRef: REF });
    const keyRows = h.db
      .query(
        "SELECT step,idempotency_key,request_json FROM stripe_billing_plan_change_steps ORDER BY step",
      )
      .all();
    expect(await h.make().change(request)).toMatchObject({ state: "verified" });
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    expect(
      h.db
        .query(
          "SELECT step,idempotency_key,request_json FROM stripe_billing_plan_change_steps ORDER BY step",
        )
        .all(),
    ).toEqual(keyRows);
  });

  test("unattributable lost create acknowledgement stays pending without adopting an attached schedule or another POST", async () => {
    const h = await fixture({ lostAck: "create" });
    expect(await h.make().change(request)).toMatchObject({ state: "pending" });
    expect(await h.make().change(request)).toMatchObject({ state: "pending" });
    expect(h.subscription.schedule).toBe("sub_sched_plan");
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_subscription_terms").get()).toEqual(
      { n: 1 },
    );
  });

  test("qualified exact-create recovery can resume lost create ACK without a second create", async () => {
    const h = await fixture({ lostAck: "create", qualifiedRecovery: true });
    expect(await h.make().change(request)).toMatchObject({ state: "pending" });
    expect(await h.make().change(request)).toMatchObject({ state: "verified" });
    expect(
      h.calls.filter(
        (call) => call.path === "/v1/subscription_schedules" && call.method === "POST",
      ),
    ).toHaveLength(1);
  });

  test.each(["metadata", "anchor", "settings", "future-settings"] as const)(
    "refuses a misleading processor acknowledgement with changed %s",
    async (corrupt) => {
      const h = await fixture({ corrupt });
      await expect(h.make().change(request)).rejects.toMatchObject({ status: 503 });
      expect(await h.make().lookup(OLD.organizationId, request.reference)).toMatchObject({
        state: "pending",
      });
      expect(
        h.db.query("SELECT count(*) AS n FROM stripe_billing_subscription_terms").get(),
      ).toEqual({ n: 1 });
    },
  );

  test("fenced expected target generation prevents a dispatch after custody changed", async () => {
    const h = await fixture();
    const qualify = h.custody.readTarget;
    h.custody.readTarget = async (...args) => {
      const target = await qualify(...args);
      await h.base.run("UPDATE custody_test_target SET generation=2 WHERE org_id=?", [
        OLD.organizationId,
      ]);
      return target;
    };
    await expect(h.make().change(request)).rejects.toBeInstanceOf(SqlError);
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_plan_changes").get()).toEqual({
      n: 0,
    });
  });

  test("a persisted plan command cannot dispatch against a replacement custody generation", async () => {
    const h = await fixture({ afterPrepare: "generation" });
    await expect(h.make().change(request)).rejects.toBeInstanceOf(SqlError);
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(await h.make().lookup(OLD.organizationId, request.reference)).toMatchObject({
      state: "pending",
    });
    expect(h.db.query("SELECT state FROM stripe_billing_plan_change_steps").get()).toEqual({
      state: "prepared",
    });
  });

  test("a prepared command does not issue a fresh processor mutation at its frozen renewal boundary", async () => {
    const h = await fixture({ afterPrepare: "period" });
    await expect(h.make().change(request)).rejects.toMatchObject({
      code: "subscription_period_changed",
      status: 409,
    });
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(await h.make().lookup(OLD.organizationId, request.reference)).toMatchObject({
      state: "pending",
    });
    expect(h.db.query("SELECT state FROM stripe_billing_plan_change_steps").get()).toEqual({
      state: "prepared",
    });
  });

  test("historical invoices resolve exactly the old or selected new term and reject crossing or repriced tuples", async () => {
    const h = await fixture();
    const service = h.make();
    await service.change(request);
    expect(
      await service.verifyPeriodTerms({ terms: OLD, periodStart: START, periodEnd: NEXT }),
    ).toEqual(OLD);
    expect(
      await service.verifyPeriodTerms({ terms: NEW, periodStart: NEXT, periodEnd: AFTER }),
    ).toEqual(NEW);
    await expect(
      service.verifyPeriodTerms({ terms: OLD, periodStart: NEXT, periodEnd: AFTER }),
    ).rejects.toMatchObject({ code: "subscription_terms_mismatch" });
    await expect(
      service.verifyPeriodTerms({ terms: NEW, periodStart: START, periodEnd: AFTER }),
    ).rejects.toMatchObject({ code: "subscription_terms_mismatch" });
    await expect(
      h.base.run("UPDATE stripe_billing_subscription_terms SET terms_json=?", [canonicalJson(NEW)]),
    ).rejects.toBeInstanceOf(SqlError);
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_grants").get()).toEqual({ n: 0 });
  });

  test("lost schedule-release ACK recovers before delegating period-end cancellation; it never cancels a schedule", async () => {
    const h = await fixture({ lostAck: "release" });
    await h.make().change(request);
    const cancel = {
      organizationId: OLD.organizationId,
      reference: "cancel-1",
      expectedSubscriptionRef: REF,
    };
    expect(await h.make().cancelPendingChange(cancel)).toMatchObject({ state: "pending" });
    expect(h.cancelCalls).toHaveLength(0);
    expect(await h.make().cancelPendingChange(cancel)).toEqual({
      state: "verified",
      subscriptionRef: REF,
      effectiveAt: NEXT,
    });
    expect(await h.make().cancelPendingChange(cancel)).toEqual({
      state: "verified",
      subscriptionRef: REF,
      effectiveAt: NEXT,
    });
    expect(
      h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/release")),
    ).toHaveLength(1);
    expect(h.calls.some((call) => call.path.endsWith("/cancel"))).toBe(false);
    expect(h.cancelCalls).toHaveLength(1);
    expect(
      await h.make().verifyPeriodTerms({ terms: OLD, periodStart: NEXT, periodEnd: AFTER }),
    ).toEqual(OLD);
    await expect(
      h.make().verifyPeriodTerms({ terms: NEW, periodStart: NEXT, periodEnd: AFTER }),
    ).rejects.toMatchObject({ code: "subscription_terms_mismatch" });
    await expect(h.make().change({ ...request, reference: "after-cancel" })).rejects.toMatchObject({
      code: "subscription_cancellation_scheduled",
    });
  });

  test("actual renewal activation releases the exhausted plan schedule, frees its slot, and preserves all historical terms without a grant", async () => {
    const h = await fixture();
    const original = await h.make().change(request);
    expect(await h.make().reconcileActivation(OLD.organizationId, REF)).toEqual({
      completed: false,
    });
    h.activate();
    expect(await h.make().pending(OLD.organizationId)).toBeNull();
    expect(await h.make().reconcileActivation(OLD.organizationId, REF)).toEqual({
      completed: true,
    });
    expect(await h.make().reconcileActivation(OLD.organizationId, REF)).toEqual({
      completed: true,
    });
    expect(h.subscription.schedule).toBeNull();
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_plan_change_slots").get()).toEqual({
      n: 0,
    });
    expect(
      h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/release")),
    ).toHaveLength(1);
    expect(await h.make().change(request)).toEqual(original);
    expect(
      await h.make().verifyPeriodTerms({ terms: NEW, periodStart: NEXT, periodEnd: AFTER }),
    ).toEqual(NEW);
    expect(
      await h.make().verifyPeriodTerms({ terms: OLD, periodStart: START, periodEnd: NEXT }),
    ).toEqual(OLD);
    expect(
      h.db.query("SELECT count(*) AS n FROM stripe_billing_subscription_term_revocations").get(),
    ).toEqual({ n: 0 });
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_grants").get()).toEqual({ n: 0 });
  });

  test("lost activation-release ACK stays on the same step and recovers by readback after renewal", async () => {
    const h = await fixture({ lostAck: "release" });
    await h.make().change(request);
    h.activate();
    expect(await h.make().reconcileActivation(OLD.organizationId, REF)).toEqual({
      completed: false,
    });
    expect(await h.make().reconcileActivation(OLD.organizationId, REF)).toEqual({
      completed: true,
    });
    expect(
      h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/release")),
    ).toHaveLength(1);
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_grants").get()).toEqual({ n: 0 });
  });

  test("schedule client exposes release only at the schedule object action endpoint", async () => {
    const h = await fixture();
    await expect(
      h.client.post("customers", {
        id: OLD.customerId,
        action: "release",
        form: {},
        idempotencyKey: "key_wrong_kind",
      }),
    ).rejects.toMatchObject({ code: "invalid_object" });
    await expect(
      h.client.post("subscription_schedules", {
        action: "release",
        form: {},
        idempotencyKey: "key_missing_id",
      }),
    ).rejects.toMatchObject({ code: "invalid_object" });
    await expect(
      h.client.post("subscription_schedules", {
        id: "sub_sched_plan",
        action: "cancel" as "release",
        form: {},
        idempotencyKey: "key_cancel_disallowed",
      }),
    ).rejects.toMatchObject({ code: "invalid_object" });
    expect(h.calls).toHaveLength(0);
  });

  test("cancellation release after the new phase began preserves that term's invoice history", async () => {
    const h = await fixture();
    await h.make().change(request);
    h.activate();
    await h.make().cancelPendingChange({
      organizationId: OLD.organizationId,
      reference: "cancel-after-renewal",
      expectedSubscriptionRef: REF,
    });
    expect(
      h.db.query("SELECT count(*) AS n FROM stripe_billing_subscription_term_revocations").get(),
    ).toEqual({ n: 0 });
    expect(
      await h.make().verifyPeriodTerms({ terms: NEW, periodStart: NEXT, periodEnd: AFTER }),
    ).toEqual(NEW);
    expect(await h.make().pending(OLD.organizationId)).toBeNull();
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_grants").get()).toEqual({ n: 0 });
  });

  test("durable bounded reconciliation recovers lost steps after restart without another effect", async () => {
    const h = await fixture({ lostAck: "schedule" });
    await h.make().change(request);
    expect(await h.make().reconcilePending(1)).toEqual({
      examined: 1,
      applied: 1,
      unresolved: 0,
      truncated: false,
    });
    expect(await h.make().lookup(OLD.organizationId, request.reference)).toMatchObject({
      state: "verified",
    });
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    h.activate();
    expect(await h.make().reconcilePending(1)).toEqual({
      examined: 1,
      applied: 1,
      unresolved: 0,
      truncated: false,
    });
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_plan_change_slots").get()).toEqual({
      n: 0,
    });
    await expect(h.make().reconcilePending(26)).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
    });
  });

  test("lost scheduling ACK recovered after renewal uses the original future terms and never repeats its POST", async () => {
    const h = await fixture({ lostAck: "schedule" });
    expect(await h.make().change(request)).toMatchObject({ state: "pending" });
    h.activate();
    expect(await h.make().change(request)).toMatchObject({
      state: "verified",
      pendingChange: { effectiveAt: NEXT, pricingRevision: PLAN.pricingRevision },
    });
    expect(await h.make().pending(OLD.organizationId)).toBeNull();
    expect(
      await h.make().verifyPeriodTerms({ terms: NEW, periodStart: NEXT, periodEnd: AFTER }),
    ).toEqual(NEW);
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_grants").get()).toEqual({ n: 0 });
  });

  test("terminal cancellation reconciliation frees only its completed slot and keeps original command and term proof", async () => {
    const h = await fixture();
    await h.make().change(request);
    await h.make().cancelPendingChange({
      organizationId: OLD.organizationId,
      reference: "cancel-terminal",
      expectedSubscriptionRef: REF,
    });
    h.subscription.status = "canceled";
    expect(await h.make().reconcilePending(1)).toEqual({
      examined: 1,
      applied: 1,
      unresolved: 0,
      truncated: false,
    });
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_plan_change_slots").get()).toEqual({
      n: 0,
    });
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_plan_changes").get()).toEqual({
      n: 2,
    });
    expect(h.db.query("SELECT count(*) AS n FROM stripe_billing_subscription_terms").get()).toEqual(
      { n: 2 },
    );
    expect(await h.make().lookup(OLD.organizationId, "cancel-terminal")).toMatchObject({
      state: "verified",
    });
  });

  test("an unsupported future withdrawal command is quarantined without running period-end cancellation", async () => {
    const h = await fixture();
    await h.make().change(request);
    await h.base.batch([
      {
        sql: `INSERT INTO stripe_billing_plan_changes(org_id,reference,fingerprint,kind,expected_subscription_ref,subscription_id,expected_generation,desired_json,frozen_json,state,receipt_json,created_at)
        SELECT org_id,'future-withdraw',fingerprint,'withdraw',expected_subscription_ref,subscription_id,expected_generation,desired_json,frozen_json,'pending',NULL,created_at
        FROM stripe_billing_plan_changes WHERE org_id=? AND reference=?`,
        params: [OLD.organizationId, request.reference],
      },
      {
        sql: "UPDATE stripe_billing_plan_change_slots SET reference='future-withdraw',generation=generation+1 WHERE org_id=?",
        params: [OLD.organizationId],
      },
    ]);
    expect(await h.make().reconcilePending(1)).toEqual({
      examined: 1,
      applied: 0,
      unresolved: 1,
      truncated: false,
    });
    expect(h.cancelCalls).toHaveLength(0);
    expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(2);
    await expect(h.make().lookup(OLD.organizationId, "future-withdraw")).rejects.toMatchObject({
      code: "unsupported_subscription_command",
      status: 503,
    });
  });

  test.each([
    {
      start: "2027-01-31T00:00:00.000Z",
      end: "2027-02-28T00:00:00.000Z",
      next: "2027-03-31T00:00:00.000Z",
      now: "2027-02-15T00:00:00.000Z",
    },
    {
      start: "2028-01-31T00:00:00.000Z",
      end: "2028-02-29T00:00:00.000Z",
      next: "2028-03-31T00:00:00.000Z",
      now: "2028-02-15T00:00:00.000Z",
    },
  ])(
    "preserves the original month-end anchor through shortened February ($end)",
    async (calendar) => {
      const h = await fixture({ calendar });
      expect(await h.make().change(request)).toMatchObject({
        state: "verified",
        pendingChange: { effectiveAt: calendar.end },
      });
      const update = h.calls.find(
        (call) =>
          call.method === "POST" && call.path === "/v1/subscription_schedules/sub_sched_plan",
      );
      expect(update?.form["phases[1][end_date]"]).toBe(String(Date.parse(calendar.next) / 1000));
      expect(update?.form["phases[1][iterations]"]).toBeUndefined();
      expect(h.subscription.billing_cycle_anchor).toBe(Date.parse(calendar.start) / 1000);
    },
  );
});
