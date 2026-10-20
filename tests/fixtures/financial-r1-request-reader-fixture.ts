import { readFileSync } from "node:fs";
import { verifyHostedBillingFinancialRealm } from "../../src/hosted-billing-realm.ts";
import { base64UrlEncode, bytesDigest, canonicalDigest, canonicalJson } from "../../src/json.ts";
import {
  assertMoneyCutoverSqlOrigin,
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../../src/money-cutover-sql.ts";
import { type Sql, SqlError } from "../../src/ports.ts";
import {
  createSharedFinancialActionIdentity,
  type SharedFinancialAction,
} from "../../src/shared-financial-action.ts";
import {
  createFinancialRetainedR1Store,
  type FinancialR1WriteCommand,
  type SelectedEconomicR1,
} from "../../src/shared-financial-retained-r1.ts";
import {
  createFinancialPreproofChallengeStore,
  FINANCIAL_SOURCE_ENROLLMENT_DDL,
  type FinancialEnrollmentComponentOptions,
  type FinancialPreproofScope,
} from "../../src/shared-financial-source-enrollment.ts";
import { FINANCIAL_SOURCE_GENESIS_DDL } from "../../src/shared-financial-source-genesis-admission.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { createStripeBillingClient } from "../../src/stripe-billing-client.ts";
import { installFinancial0104Fences } from "../helpers/financial-0104-fenced.ts";
import { migratedDatabase } from "../helpers/migrated-database.ts";

// Copied isolated Financial custody fixture. Synthetic external Root bindings in
// the dedicated test do not qualify genuine Auth origin, D1, or a mounted route.
export const AT = "2026-10-15T00:00:00.000Z";
export const EPOCH = `sha256:${"c".repeat(64)}` as const;
export const SCOPE: FinancialPreproofScope = {
  registrationRef: "identity-registration:test",
  clientId: "client:test",
  workspaceId: "workspace:test",
  organizationId: "org:test",
  workspaceRef: "workspace-ref:test",
};
export const ACTIONS: readonly SharedFinancialAction[] = [
  {
    kind: "topup",
    organizationId: SCOPE.organizationId,
    reference: "topup:test",
    amountMinor: 500,
  },
  {
    kind: "subscription-start",
    organizationId: SCOPE.organizationId,
    reference: "start:test",
    planKey: "starter",
  },
  {
    kind: "card-setup",
    organizationId: SCOPE.organizationId,
    reference: "card:test",
    setupDisclosureRevision: "disclosure:test",
  },
  {
    kind: "plan-change",
    organizationId: SCOPE.organizationId,
    reference: "change:test",
    planKey: "pro",
    expectedSubscriptionRef: `sra_${"a".repeat(64)}`,
  },
  {
    kind: "cancel",
    organizationId: SCOPE.organizationId,
    reference: "cancel:test",
    cancelAtPeriodEnd: true,
    expectedSubscriptionRef: `sra_${"a".repeat(64)}`,
  },
];
function economic(action: SharedFinancialAction): SelectedEconomicR1 {
  switch (action.kind) {
    case "topup":
      return {
        kind: "topup",
        amountMinor: action.amountMinor,
        currency: "USD",
        pricingRevision: "pricing:test",
        purchaseCreditExpiry: { kind: "none" },
        minimumMinor: 50,
        maximumMinor: 10000,
      };
    case "subscription-start":
      return {
        kind: "subscription-start",
        planKey: action.planKey,
        pricingRevision: "pricing:test",
        priceId: "price_enrollment",
        priceAmountMinor: 1000,
        includedMinor: 100,
        currency: "USD",
        periodMonths: 1,
      };
    case "card-setup":
      return {
        kind: "card-setup",
        setupDisclosureRevision: action.setupDisclosureRevision,
        onDemandTermsRevision: "on-demand:test",
      };
    case "plan-change":
      return {
        kind: "plan-change",
        expectedSubscriptionRef: action.expectedSubscriptionRef,
        targetSubscriptionId: "sub:test",
        targetGeneration: 1,
        targetPeriodStart: AT,
        targetPeriodEnd: "2026-11-15T00:00:00.000Z",
        planKey: action.planKey,
        pricingRevision: "pricing:test",
        priceId: "price_enrollment",
        priceAmountMinor: 1000,
        includedMinor: 100,
        currency: "USD",
      };
    case "cancel":
      return {
        kind: "cancel",
        expectedSubscriptionRef: action.expectedSubscriptionRef,
        targetSubscriptionId: "sub:test",
        targetGeneration: 1,
        branch: "legacy",
        pendingReference: null,
        scheduleId: null,
        cancelAtPeriodEnd: true,
      };
  }
}
export async function fixture() {
  const db = migratedDatabase();
  db.exec(
    readFileSync(
      new URL("./shared-financial-source-component-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
  db.exec(MONEY_CUTOVER_FREEZE_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
  db.exec(FINANCIAL_SOURCE_ENROLLMENT_DDL);
  db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
  db.exec(
    readFileSync(
      new URL("./shared-financial-retained-r1-component-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  // New C0/R1 writes require the exact fenced 0104 shape.
  installFinancial0104Fences(db, { receiver: true, c0: true });
  const base = createSqliteSql(db);
  let writes = 0,
    providerRequests = 0,
    clocks = 0,
    unknownQuery = false;
  const raw: Sql = {
    query: (query, params) => {
      if (unknownQuery) {
        unknownQuery = false;
        throw new SqlError("unavailable", "unknown GET");
      }
      return base.query(query, params);
    },
    run: (query, params) => {
      writes++;
      return base.run(query, params);
    },
    batch: (statements) => {
      writes++;
      return base.batch(statements);
    },
  };
  const sql = createMoneyCutoverSql(raw, EPOCH);
  assertMoneyCutoverSqlOrigin(sql, { writerEpoch: EPOCH });
  await base.run("INSERT INTO stripe_mode_realm VALUES(1,'test',?)", [AT]);
  await base.run(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_enrollment','test','enrollment',?)",
    [AT],
  );
  await base.run("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)", [EPOCH]);
  const client = createStripeBillingClient({
    secretKey: "sk_test_component_fixture",
    async fetch(request) {
      providerRequests++;
      const url = new URL(request.url);
      if (request.method !== "GET") throw Error("provider command forbidden");
      if (url.pathname === "/v1/account")
        return Response.json({ object: "account", id: "acct_enrollment" });
      if (url.pathname === "/v1/prices/price_enrollment")
        return Response.json({
          object: "price",
          id: "price_enrollment",
          livemode: false,
          currency: "usd",
          type: "recurring",
          billing_scheme: "per_unit",
          unit_amount: 1000,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      throw Error("unexpected provider read");
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: "acct_enrollment", mode: "test", billingAuthority: "enrollment" },
    prices: [{ priceId: "price_enrollment", monthlyAmountMinor: 1000 }],
  });
  const options: FinancialEnrollmentComponentOptions & { scope: FinancialPreproofScope } = {
    sql,
    client,
    realm,
    writerEpoch: EPOCH,
    receiverRef: "receiver:test",
    targetRef: "target:test",
    scope: SCOPE,
    clock: () => {
      clocks++;
      return new Date(AT);
    },
  };
  const store = createFinancialRetainedR1Store(options);
  // C0 SQL no longer names money_cutover_* tables and passes Root S unchanged;
  // this fixture installs the exact fenced 0104 C0/M/G and receiver shape, so
  // C0 prepare runs through the actual S wrapper like every R1 write. The raw
  // realm stays only for raw-R negative tests.
  const c0FixtureRealm = await verifyHostedBillingFinancialRealm({
    sql: raw,
    reader: { client },
    expected: { accountId: "acct_enrollment", mode: "test", billingAuthority: "enrollment" },
    prices: [{ priceId: "price_enrollment", monthlyAmountMinor: 1000 }],
  });
  const c0 = createFinancialPreproofChallengeStore(options);
  const sourceBody = {
    version: "financial-action-registration-canonical-v1",
    registrationRef: "action-registration:test",
    incarnation: "incarnation:test",
    sourceRef: "action-source:test",
    originRef: "origin:test",
    financialRealm: realm.financialRealm,
    organizationId: SCOPE.organizationId,
    workspaceId: SCOPE.workspaceId,
    workspaceRef: SCOPE.workspaceRef,
  };
  const registrationDigest = await canonicalDigest([
    "financial-action-registration-canonical-v1",
    sourceBody,
  ]);
  const registerFixtureData = async () => {
    await sql.run(
      `INSERT INTO financial_action_source_registrations
      (registration_ref,incarnation,registration_digest,digest_recipe,registration_json,created_at)
      VALUES(?,?,?,?,?,?)`,
      [
        sourceBody.registrationRef,
        sourceBody.incarnation,
        registrationDigest,
        "financial-action-registration-canonical-v1",
        canonicalJson(sourceBody),
        AT,
      ],
    );
  };
  async function command(
    action: SharedFinancialAction,
    suffix: string = action.kind,
    termsText = `Terms for ${action.kind}: exact historical display.`,
  ): Promise<FinancialR1WriteCommand> {
    const identity = await createSharedFinancialActionIdentity(action);
    const bytes = new TextEncoder().encode(termsText);
    const termsDigest = await bytesDigest(bytes);
    const selectedAt = Date.parse(AT) - 1;
    const sourceImage = {
      version: "financial-selected-action-source-canonical-v1",
      ref: sourceBody.sourceRef,
      registrationRef: sourceBody.registrationRef,
      registrationDigest,
      incarnation: sourceBody.incarnation,
      originRef: sourceBody.originRef,
      financialRealm: realm.financialRealm,
      organizationId: SCOPE.organizationId,
      workspaceId: SCOPE.workspaceId,
      workspaceRef: SCOPE.workspaceRef,
      selectedAt,
    };
    const sourceDigest = await canonicalDigest([
      "financial-selected-action-source-canonical-v1",
      sourceImage,
    ]);
    const c0Input = {
      preparationRef: `preparation:${suffix}`,
      receiptRef: `c0-receipt:${suffix}`,
      challenge: {
        v: 1 as const,
        challengeRef: `challenge:${suffix}`,
        ...SCOPE,
        requestFingerprint: identity.requestFingerprint,
        createdAt: Date.parse(AT),
        expiresAt: Date.parse(AT) + 300_000,
      },
      selection: {
        action: {
          kind: action.kind,
          ref: action.reference,
          body: action,
          requestFingerprint: identity.requestFingerprint,
        },
        customer: {
          requestRef: `customer:${suffix}`,
          idempotencyKey: `customer-key:${suffix}`,
          requestFingerprint: identity.requestFingerprint,
          financialRealm: realm.financialRealm,
        },
        business: { ref: `business:${suffix}`, requestFingerprint: identity.requestFingerprint },
        terms: { ref: `terms:${suffix}`, digest: termsDigest },
        carrier: {
          issuerRef: "issuer:test",
          requestRef: `request:${suffix}`,
          carrierRef: "carrier:test",
          contextRef: "context:test",
          createdAt: AT,
        },
        billingBinding: {
          bindingRef: "binding:test",
          organizationId: SCOPE.organizationId,
          workspaceId: SCOPE.workspaceId,
          workspaceRef: SCOPE.workspaceRef,
        },
      },
    };
    const scopeRealm = {
      ...SCOPE,
      accountId: realm.accountId,
      mode: realm.mode,
      billingAuthority: realm.billingAuthority,
      financialRealm: realm.financialRealm,
      writerEpoch: EPOCH,
      receiverRef: options.receiverRef,
      targetRef: options.targetRef,
    };
    const r1Ref = `r1:${suffix}`,
      r1ReceiptRef = `r1-receipt:${suffix}`;
    return {
      key: {
        challengeRef: c0Input.challenge.challengeRef,
        preparationRef: c0Input.preparationRef,
        r1Ref,
      },
      r1ReceiptRef,
      original: {
        version: "takoserver-financial-retained-r1-v1",
        r1Ref,
        challengeRef: c0Input.challenge.challengeRef,
        preparationRef: c0Input.preparationRef,
        c0ReceiptRef: c0Input.receiptRef,
        c0: c0Input,
        scopeRealm,
        economic: economic(action),
        selectedTerms: {
          ref: c0Input.selection.terms.ref,
          digest: termsDigest,
          mediaType: "text/plain; charset=utf-8",
          locale: "en-US",
          bodyUtf8Base64url: base64UrlEncode(bytes),
          bodyByteLength: bytes.length,
          digestRecipe: "financial-terms-utf8-sha256-v1",
        },
        actionSource: {
          ref: sourceBody.sourceRef,
          digest: sourceDigest,
          registrationRef: sourceBody.registrationRef,
          registrationDigest,
          incarnation: sourceBody.incarnation,
          originRef: sourceBody.originRef,
          financialRealm: realm.financialRealm,
          organizationId: SCOPE.organizationId,
          workspaceId: SCOPE.workspaceId,
          workspaceRef: SCOPE.workspaceRef,
          selectedAt,
        },
      },
    };
  }
  return {
    db,
    base,
    raw,
    sql,
    options,
    store,
    c0,
    c0FixtureRealm,
    client,
    command,
    registerFixtureData,
    unknownQuery: () => {
      unknownQuery = true;
    },
    get writes() {
      return writes;
    },
    get providerRequests() {
      return providerRequests;
    },
    get clocks() {
      return clocks;
    },
    close: () => db.close(),
  };
}
