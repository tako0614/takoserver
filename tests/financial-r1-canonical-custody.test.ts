import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createCanonicalFinancialR1SelectionSource } from "../src/financial-r1-selection-source.ts";
import { createCanonicalHostedBillingComposition } from "../src/hosted-billing-composition.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { base64UrlDecode, base64UrlEncode, bytesDigest, canonicalDigest } from "../src/json.ts";
import {
  assertMoneyCutoverSqlBackingOrigin,
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { PaymentEventContext } from "../src/payment-events.ts";
import type { Sql } from "../src/ports.ts";
import type { SharedFinancialAction } from "../src/shared-financial-action.ts";
import {
  buildFinancialR1CoPreparationBatch,
  createFinancialRetainedR1Store,
  type FinancialR1WriteCommand,
} from "../src/shared-financial-retained-r1.ts";
import {
  createFinancialPreproofChallengeStore,
  FINANCIAL_SOURCE_ENROLLMENT_DDL,
  type FinancialEnrollmentComponentOptions,
  type FinancialPreproofScope,
} from "../src/shared-financial-source-enrollment.ts";
import {
  fixture,
  NEXT,
  ORG,
  operatorConfiguration,
  START,
} from "./helpers/financial-displayed-canonical-fixture.ts";

// One existing canonical fixture database. HTTP and the closed C0/source refs below
// are synthetic fixture DATA; they do not qualify an issuer, Root R, NEW or consent.
const EPOCH = `sha256:${"e".repeat(64)}` as const;
const SCOPE: FinancialPreproofScope = {
  registrationRef: "identity-registration:canonical-custody-fixture",
  clientId: "client:canonical-custody-fixture",
  workspaceId: "workspace:canonical-custody-fixture",
  organizationId: ORG,
  workspaceRef: "workspace-ref:canonical-custody-fixture",
};
const ROW_TABLES = [
  "financial_action_source_registrations",
  "financial_preproof_challenges",
  "financial_preproof_challenge_receipts",
  "financial_retained_r1_originals",
  "financial_retained_r1_receipts",
] as const;

async function setup() {
  const native = await fixture();
  try {
    // Existing owning DDL only; no replacement/IF NOT EXISTS or altered guards.
    native.db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
    native.db.exec(MONEY_CUTOVER_FREEZE_DDL);
    native.db.exec(MONEY_CUTOVER_PERMIT_DDL);
    native.db.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
    native.db.exec(FINANCIAL_SOURCE_ENROLLMENT_DDL);
    native.db.exec(
      readFileSync(
        new URL("./fixtures/shared-financial-retained-r1-component-schema.sql", import.meta.url),
        "utf8",
      ),
    );
    await native.sql.run("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)", [EPOCH]);
    const sql = createMoneyCutoverSql(native.sql, EPOCH);
    const assertBacking = () =>
      assertMoneyCutoverSqlBackingOrigin(sql, { rawSql: native.sql, writerEpoch: EPOCH });
    assertBacking();
    // The helper's original realm belongs to R. Verify the actual S once, rather
    // than copying that realm's shape or combining contexts from two fixtures.
    const realm = await verifyHostedBillingFinancialRealm({
      sql,
      reader: { client: native.client },
      expected: {
        accountId: native.realm.accountId,
        mode: native.realm.mode,
        billingAuthority: native.realm.billingAuthority,
      },
      prices: native.pricing.hostedPlanTable.plans
        .filter((plan) => plan.tier === "subscription")
        .map((plan) => ({
          priceId: plan.stripePriceId,
          monthlyAmountMinor: plan.monthlyAmountMinor,
        })),
    });
    const billingConfig = parseBillingConfig(native.pricing.environment.TAKOSERVER_BILLING_CONFIG);
    if (!billingConfig) throw Error("original canonical tariff missing");
    let clockReads = 0,
      fundingCalls = 0;
    // One observing Clock delegates to the helper's actual mutable clock. This
    // exact function is shared by composition, selection and both custody stores.
    const clock = () => {
      clockReads++;
      return native.clock();
    };
    // These funding sentinels are the selection-only fixture seam used by the
    // existing canonical-source tests. They are never funding/SQL provenance.
    const context: PaymentEventContext = {
      sql,
      clock,
      async credit() {
        fundingCalls++;
        throw Error("canonical custody test must not fund");
      },
      async creditedFunding() {
        fundingCalls++;
        throw Error("canonical custody test must not read funding");
      },
    };
    const configuration = operatorConfiguration();
    const composition = await createCanonicalHostedBillingComposition({
      sql,
      clock,
      billingConfig,
      pricing: native.pricing,
      client: native.client,
      realm,
      consoleOrigin: "https://console.example.test",
      warnings: { state: "unavailable", reason: "transport-not-composed" },
      webhookSecret: "whsec_canonical_custody_synthetic_fixture",
      onDemand: configuration,
    });
    if (!composition.paymentActivation) throw Error("actual canonical composition missing");
    const source = createCanonicalFinancialR1SelectionSource({
      composition,
      context,
      billingConfig,
    });
    const options: FinancialEnrollmentComponentOptions & {
      readonly scope: FinancialPreproofScope;
    } = {
      sql,
      clock,
      client: native.client,
      realm,
      writerEpoch: EPOCH,
      receiverRef: "receiver:canonical-custody-fixture",
      targetRef: "target:canonical-custody-fixture",
      scope: SCOPE,
    };
    const store = createFinancialRetainedR1Store(options);
    const c0 = createFinancialPreproofChallengeStore(options);
    assertBacking();
    return {
      native,
      composition,
      context,
      configuration,
      source,
      options,
      store,
      c0,
      assertBacking,
      get clockReads() {
        return clockReads;
      },
      get fundingCalls() {
        return fundingCalls;
      },
    };
  } catch (error) {
    native.db.close();
    throw error;
  }
}
type F = Awaited<ReturnType<typeof setup>>;
type Choice = SharedFinancialAction["kind"] | "cancel-pending-plan";

async function action(f: F, choice: Choice): Promise<SharedFinancialAction> {
  const common = { organizationId: ORG, reference: `canonical-custody-${choice}` };
  switch (choice) {
    case "topup":
      return { ...common, kind: choice, amountMinor: 500 };
    case "subscription-start":
      await f.composition.createPayments(f.context).subscriptionCustody.read(ORG);
      return { ...common, kind: choice, planKey: "hosted-10" };
    case "card-setup":
      return {
        ...common,
        kind: choice,
        setupDisclosureRevision: f.configuration.setupDisclosureRevision,
      };
    case "plan-change":
      return {
        ...common,
        kind: choice,
        expectedSubscriptionRef: await f.native.begin(),
        planKey: "hosted-50",
      };
    case "cancel":
    case "cancel-pending-plan": {
      const expectedSubscriptionRef = await f.native.begin();
      if (choice === "cancel-pending-plan") await f.native.change(expectedSubscriptionRef);
      return { ...common, kind: "cancel", expectedSubscriptionRef, cancelAtPeriodEnd: true };
    }
  }
}

// Only refs/carrier/challenge/source registration recipes are fixture DATA.
// Action identity, full economics, exact terms and selectedAt come directly from
// the one real canonical source; this function never reconstructs those images.
async function command(f: F, input: SharedFinancialAction) {
  const selected = await f.source.selectNewActionData(input);
  f.source.assertData(selected);
  const identity = selected.actionIdentity,
    terms = selected.displayed.selectedTerms,
    at = new Date(selected.selectedAt).toISOString(),
    suffix = input.reference;
  const registration = {
    version: "financial-action-registration-canonical-v1",
    registrationRef: `action-registration:${suffix}`,
    incarnation: `incarnation:${suffix}`,
    sourceRef: `action-source:${suffix}`,
    originRef: `origin:${suffix}`,
    financialRealm: f.options.realm.financialRealm,
    organizationId: SCOPE.organizationId,
    workspaceId: SCOPE.workspaceId,
    workspaceRef: SCOPE.workspaceRef,
  };
  const registrationDigest = await canonicalDigest([registration.version, registration]);
  const sourceImage = {
    version: "financial-selected-action-source-canonical-v1",
    ref: registration.sourceRef,
    registrationRef: registration.registrationRef,
    registrationDigest,
    incarnation: registration.incarnation,
    originRef: registration.originRef,
    financialRealm: registration.financialRealm,
    organizationId: registration.organizationId,
    workspaceId: registration.workspaceId,
    workspaceRef: registration.workspaceRef,
    selectedAt: selected.selectedAt,
  };
  const sourceDigest = await canonicalDigest([sourceImage.version, sourceImage]);
  const challengeRef = `challenge:${suffix}`,
    preparationRef = `preparation:${suffix}`,
    r1Ref = `r1:${suffix}`,
    c0ReceiptRef = `c0-receipt:${suffix}`;
  const value: FinancialR1WriteCommand = {
    key: { challengeRef, preparationRef, r1Ref },
    r1ReceiptRef: `r1-receipt:${suffix}`,
    original: {
      version: "takoserver-financial-retained-r1-v1",
      r1Ref,
      challengeRef,
      preparationRef,
      c0ReceiptRef,
      c0: {
        preparationRef,
        receiptRef: c0ReceiptRef,
        challenge: {
          v: 1,
          challengeRef,
          ...SCOPE,
          requestFingerprint: identity.requestFingerprint,
          createdAt: selected.selectedAt,
          expiresAt: selected.selectedAt + 300_000,
        },
        selection: {
          action: {
            kind: identity.action.kind,
            ref: identity.action.reference,
            body: identity.action,
            requestFingerprint: identity.requestFingerprint,
          },
          customer: {
            requestRef: `customer:${suffix}`,
            idempotencyKey: `customer-key:${suffix}`,
            requestFingerprint: identity.requestFingerprint,
            financialRealm: f.options.realm.financialRealm,
          },
          business: { ref: `business:${suffix}`, requestFingerprint: identity.requestFingerprint },
          terms: { ref: terms.ref, digest: terms.digest },
          carrier: {
            issuerRef: "issuer:synthetic-canonical-custody-fixture",
            requestRef: `request:${suffix}`,
            carrierRef: "carrier:synthetic-canonical-custody-fixture",
            contextRef: "context:synthetic-canonical-custody-fixture",
            createdAt: at,
          },
          billingBinding: {
            bindingRef: "binding:synthetic-canonical-custody-fixture",
            organizationId: SCOPE.organizationId,
            workspaceId: SCOPE.workspaceId,
            workspaceRef: SCOPE.workspaceRef,
          },
        },
      },
      scopeRealm: {
        ...SCOPE,
        accountId: f.options.realm.accountId,
        mode: f.options.realm.mode,
        billingAuthority: f.options.realm.billingAuthority,
        financialRealm: f.options.realm.financialRealm,
        writerEpoch: EPOCH,
        receiverRef: f.options.receiverRef,
        targetRef: f.options.targetRef,
      },
      economic: selected.displayed.economic,
      selectedTerms: terms,
      actionSource: {
        ref: sourceImage.ref,
        digest: sourceDigest,
        registrationRef: sourceImage.registrationRef,
        registrationDigest,
        incarnation: sourceImage.incarnation,
        originRef: sourceImage.originRef,
        financialRealm: sourceImage.financialRealm,
        organizationId: sourceImage.organizationId,
        workspaceId: sourceImage.workspaceId,
        workspaceRef: sourceImage.workspaceRef,
        selectedAt: sourceImage.selectedAt,
      },
    },
  };
  return { value, selected, at };
}

async function changes(sql: Sql) {
  const rows = await sql.query("SELECT total_changes() AS value");
  const value = rows[0]?.value;
  if (rows.length !== 1 || typeof value !== "number") throw Error("SQLite change count missing");
  return value;
}
async function rowCounts(sql: Sql) {
  return await Promise.all(
    ROW_TABLES.map(async (table) => {
      const rows = await sql.query(`SELECT count(*) AS value FROM ${table}`);
      return rows[0]?.value;
    }),
  );
}
function changedBody(input: SharedFinancialAction): SharedFinancialAction {
  switch (input.kind) {
    case "topup":
      return { ...input, amountMinor: 501 };
    case "subscription-start":
      return { ...input, planKey: "hosted-50" };
    case "card-setup":
      return { ...input, setupDisclosureRevision: "other-disclosure" };
    case "plan-change":
      return { ...input, planKey: "hosted-10" };
    case "cancel":
      return { ...input, expectedSubscriptionRef: `sra_${"f".repeat(64)}` };
  }
}

for (const choice of [
  "topup",
  "subscription-start",
  "card-setup",
  "plan-change",
  "cancel",
  "cancel-pending-plan",
] as const) {
  test(`${choice}: canonical C0/R1 batch retains exact display and business history`, async () => {
    const f = await setup();
    try {
      const input = await action(f, choice),
        calls = f.native.calls.length,
        prepared = await command(f, input),
        original = prepared.value.original,
        selected = prepared.selected;
      expect(selected.actionIdentity.action).toEqual(input);
      expect(selected.selectedAt).toBe(f.native.clock().getTime());
      const raw = base64UrlDecode(selected.displayed.selectedTerms.bodyUtf8Base64url);
      if (!raw) throw Error("canonical UTF8 original absent");
      expect(raw).toEqual(new TextEncoder().encode(selected.displayed.displayText));
      expect(await bytesDigest(raw)).toBe(original.selectedTerms.digest);
      expect(original.selectedTerms.ref).toBe(`terms:${original.selectedTerms.digest.slice(7)}`);
      expect(original.selectedTerms.bodyByteLength).toBe(raw.length);
      switch (input.kind) {
        case "topup":
          expect(original.economic).toMatchObject({ kind: input.kind, amountMinor: 500 });
          expect(selected.displayed.displayText).toContain("USD 5.00");
          break;
        case "subscription-start":
          expect(original.economic).toMatchObject({
            kind: input.kind,
            planKey: "hosted-10",
            priceId: "price_actual10",
            priceAmountMinor: 1000,
            periodMonths: 1,
          });
          break;
        case "card-setup":
          expect(original.economic).toMatchObject({
            kind: input.kind,
            setupDisclosureRevision: "save-card-composition-v1",
            onDemandTermsRevision: "on-demand-composition-terms-v1",
          });
          break;
        case "plan-change":
          expect(original.economic).toMatchObject({
            kind: input.kind,
            expectedSubscriptionRef: input.expectedSubscriptionRef,
            targetSubscriptionId: "sub_actual_phase",
            targetPeriodStart: START,
            targetPeriodEnd: NEXT,
            planKey: "hosted-50",
            priceId: "price_actual50",
            priceAmountMinor: 5000,
          });
          break;
        case "cancel":
          expect(original.economic).toMatchObject({
            kind: input.kind,
            expectedSubscriptionRef: input.expectedSubscriptionRef,
            cancelAtPeriodEnd: true,
            branch: choice === "cancel-pending-plan" ? "pending-plan-change" : "legacy",
            pendingReference: choice === "cancel-pending-plan" ? "actual-upgrade" : null,
            scheduleId: choice === "cancel-pending-plan" ? "sub_sched_actual" : null,
          });
          break;
      }
      const beforeCompile = [f.clockReads, await changes(f.native.sql), f.native.calls.length];
      const batch = await buildFinancialR1CoPreparationBatch(
        f.options,
        prepared.value,
        prepared.at,
      );
      expect(batch).toHaveLength(5);
      expect([f.clockReads, await changes(f.native.sql), f.native.calls.length]).toEqual(
        beforeCompile,
      );
      f.assertBacking();
      // Generic SQLite fixture transaction only. Neither S.batch (which refuses
      // C0 reserved-table SQL) nor a genuine Root owning R/permit is fabricated.
      const written = await f.native.sql.batch([
        {
          sql: "INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)",
          params: [EPOCH],
        },
        ...batch,
        { sql: "DELETE FROM money_cutover_writer_permit WHERE singleton=1" },
      ]);
      f.assertBacking();
      expect(written.map((row) => row.changes)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(await rowCounts(f.native.sql)).toEqual([1, 1, 1, 1, 1]);
      expect(await f.native.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
      expect(f.native.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);

      // Invalid current time and missing native current objects cannot erase a
      // completed historical original. No selector is supplied to either reader.
      f.native.now("not-a-date");
      f.native.subscriptions.clear();
      const beforeHistory = [f.clockReads, await changes(f.native.sql), f.native.calls.length];
      const retained = await f.store.readBusinessRetainedR1Data(input);
      expect(retained.status).toBe("found");
      if (retained.status !== "found") throw Error("canonical retained business original missing");
      expect(retained.original).toEqual(original);
      expect(retained.original.economic).toEqual(selected.displayed.economic);
      expect(retained.original.actionSource.selectedAt).toBe(selected.selectedAt);
      expect(retained.actionIdentity).toEqual(selected.actionIdentity);
      expect(retained.r1ReceiptRef).toBe(prepared.value.r1ReceiptRef);
      expect(retained.c0ReceiptRef).toBe(original.c0ReceiptRef);
      expect(await f.store.readJoinedRetainedR1Data(original.challengeRef)).toEqual(retained);
      expect(await f.c0.readActionSelectionOriginal(original.challengeRef)).toEqual({
        preparationRef: original.preparationRef,
        receiptRef: original.c0ReceiptRef,
        challenge: original.c0.challenge,
        actionIdentity: selected.actionIdentity,
        terms: original.c0.selection.terms,
        selection: original.c0.selection,
        scopeRealm: original.scopeRealm,
      });
      const keptRaw = base64UrlDecode(retained.original.selectedTerms.bodyUtf8Base64url);
      expect(keptRaw).toEqual(raw);
      expect(retained.original.selectedTerms).toEqual(selected.displayed.selectedTerms);
      await expect(f.store.readBusinessRetainedR1Data(changedBody(input))).rejects.toMatchObject({
        name: "FinancialRetainedR1Error",
        code: "conflict",
      });
      expect(await f.store.readBusinessRetainedR1Data(input)).toEqual(retained);
      expect([f.clockReads, await changes(f.native.sql), f.native.calls.length]).toEqual(
        beforeHistory,
      );
      expect(f.fundingCalls).toBe(0);
      f.assertBacking();
    } finally {
      f.native.db.close();
    }
  });
}

test("canonical display body mutation is refused before C0/R1 co-batch custody", async () => {
  const f = await setup();
  try {
    const prepared = await command(f, await action(f, "card-setup"));
    expect(
      await buildFinancialR1CoPreparationBatch(f.options, prepared.value, prepared.at),
    ).toHaveLength(5);
    const altered: FinancialR1WriteCommand = {
      ...prepared.value,
      original: {
        ...prepared.value.original,
        selectedTerms: {
          ...prepared.value.original.selectedTerms,
          bodyUtf8Base64url: base64UrlEncode(new TextEncoder().encode("replaced canonical body")),
          bodyByteLength: new TextEncoder().encode("replaced canonical body").length,
        },
      },
    };
    const before = [f.clockReads, await changes(f.native.sql), f.native.calls.length];
    await expect(
      buildFinancialR1CoPreparationBatch(f.options, altered, prepared.at),
    ).rejects.toMatchObject({ name: "FinancialRetainedR1Error", code: "invalid_request" });
    expect([f.clockReads, await changes(f.native.sql), f.native.calls.length]).toEqual(before);
    expect(await rowCounts(f.native.sql)).toEqual([0, 0, 0, 0, 0]);
    expect(await f.native.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
    expect(f.fundingCalls).toBe(0);
    f.assertBacking();
  } finally {
    f.native.db.close();
  }
});
