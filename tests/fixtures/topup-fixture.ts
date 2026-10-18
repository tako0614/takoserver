// Derived finite fixture prefix only; no old tests are registered. Mock provider permits GET only.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyHostedBillingFinancialRealm } from "../../src/hosted-billing-realm.ts";
import { base64UrlEncode, bytesDigest, canonicalDigest, canonicalJson } from "../../src/json.ts";
import {
  assertMoneyCutoverSqlBackingOrigin,
  assertMoneyCutoverSqlOrigin,
  createMoneyCutoverSql,
} from "../../src/money-cutover-sql.ts";
import { type Sql, SqlError } from "../../src/ports.ts";
import {
  createSharedFinancialActionIdentity,
  type SharedFinancialAction,
} from "../../src/shared-financial-action.ts";
import {
  type CustomerCustodyInput,
  type CustomerPhaseInput,
  compileCustomerPhase,
} from "../../src/shared-financial-customer-dispatch.ts";
import { readCustomerJournalSnapshot } from "../../src/shared-financial-customer-journal.ts";
import { createCustomerTrackedExecutionData } from "../../src/shared-financial-customer-tracked-execution.ts";
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
import { createStripeBillingClient } from "../../src/stripe-billing-client.ts";
import { fixture as customerFixture } from "./financial-customer-fixture.ts";

const AT = new Date(Date.now() - 1000).toISOString();
const EPOCH = `sha256:${createHash("sha256").update("writer").digest("hex")}` as const;
const SCOPE: FinancialPreproofScope = {
  registrationRef: "source:registration",
  clientId: "client:synthetic",
  workspaceId: "workspace:synthetic",
  organizationId: "org:synthetic",
  workspaceRef: "workspace-ref:synthetic",
};
function economic(action: SharedFinancialAction): SelectedEconomicR1 {
  if (action.kind !== "topup") throw Error("this fixture is topup only");
  return {
    kind: "topup",
    amountMinor: action.amountMinor,
    currency: "USD",
    pricingRevision: "pricing:test",
    purchaseCreditExpiry: { kind: "none" },
    minimumMinor: 50,
    maximumMinor: 10000,
  };
}
/** Derived actual R1 fixture on the actual completed Customer fixture DB. Synthetic only; no genuine proof. */
export async function topupFixture(rp = false) {
  const customer = await customerFixture(rp);
  const db = customer.db,
    base = customer.sql;
  db.exec(FINANCIAL_SOURCE_ENROLLMENT_DDL);
  db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
  db.exec(
    readFileSync(
      new URL("./shared-financial-retained-r1-component-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(readFileSync(new URL("./payer-origin-schema.unnumbered.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("./topup-history-schema.unnumbered.sql", import.meta.url), "utf8"));
  const batches: (readonly import("../../src/ports.ts").SqlStatement[])[] = [];
  const transport: {
    fault: "none" | "before-throw" | "commit-throw" | "truncated" | "cas-zero" | "post-read-throw";
    committed: boolean;
    lastError: unknown;
  } = { fault: "none", committed: false, lastError: null };
  let writes = 0,
    providerRequests = 0,
    clocks = 0,
    unknownQuery = false;
  const raw: Sql = {
    query: (query, params) => {
      if (transport.fault === "post-read-throw" && transport.committed)
        throw new SqlError("unavailable", "test: post-ACK read unknown");
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
    async batch(statements) {
      writes++;
      batches.push(statements);
      if (transport.fault === "before-throw")
        throw new SqlError("unavailable", "test: batch unknown before commit");
      try {
        const actual = await base.batch(statements);
        transport.committed = true;
        if (transport.fault === "commit-throw")
          throw new SqlError("unavailable", "test: committed but ACK unknown");
        if (transport.fault === "truncated") return actual.slice(0, -1);
        if (transport.fault === "cas-zero")
          return actual.map((x, i) => (i === 1 ? { ...x, changes: 0 } : x));
        return actual;
      } catch (error) {
        transport.lastError = error;
        throw error;
      }
    },
  };
  const sql = createMoneyCutoverSql(raw, EPOCH);
  assertMoneyCutoverSqlOrigin(sql, { writerEpoch: EPOCH });
  assertMoneyCutoverSqlBackingOrigin(sql, { rawSql: raw, writerEpoch: EPOCH });
  // Customer fixture already owns these rows; verify its retained facts without a second write.
  const modes = await base.query("SELECT * FROM stripe_mode_realm");
  const accounts = await base.query("SELECT * FROM stripe_billing_account_realms");
  const epochs = await base.query("SELECT * FROM money_cutover_authorized_epoch");
  if (
    modes.length !== 1 ||
    modes[0]?.singleton !== 1 ||
    modes[0]?.mode !== "test" ||
    accounts.length !== 1 ||
    accounts[0]?.singleton !== 1 ||
    accounts[0]?.account_id !== "acct_synthetic" ||
    accounts[0]?.mode !== "test" ||
    accounts[0]?.billing_authority !== "authority.synthetic" ||
    epochs.length !== 1 ||
    epochs[0]?.singleton !== 1 ||
    epochs[0]?.writer_epoch !== EPOCH
  )
    throw Error("original Customer realm/epoch fixture mismatch");
  const client = createStripeBillingClient({
    secretKey: "sk_test_component_fixture",
    async fetch(request) {
      providerRequests++;
      const url = new URL(request.url);
      if (request.method !== "GET") throw Error("provider command forbidden");
      if (url.pathname === "/v1/account")
        return Response.json({ object: "account", id: "acct_synthetic" });
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
    expected: {
      accountId: "acct_synthetic",
      mode: "test",
      billingAuthority: "authority.synthetic",
    },
    prices: [{ priceId: "price_enrollment", monthlyAmountMinor: 1000 }],
  });
  const options: FinancialEnrollmentComponentOptions & { scope: FinancialPreproofScope } = {
    sql,
    client,
    realm,
    writerEpoch: EPOCH,
    receiverRef: "receiver:financial",
    targetRef: "target:financial",
    scope: SCOPE,
    clock: () => {
      clocks++;
      return new Date(AT);
    },
  };
  const store = createFinancialRetainedR1Store(options);
  // Frozen C0 v3 embeds reserved-table SQL that Root S rejects. Keep that older
  // C0 prepare as an explicitly mechanical generic-R fixture on this same primary;
  // R1 registration/original/receipt writes below use the actual S wrapper only.
  const c0FixtureRealm = await verifyHostedBillingFinancialRealm({
    sql: raw,
    reader: { client },
    expected: {
      accountId: "acct_synthetic",
      mode: "test",
      billingAuthority: "authority.synthetic",
    },
    prices: [{ priceId: "price_enrollment", monthlyAmountMinor: 1000 }],
  });
  const c0 = createFinancialPreproofChallengeStore({ ...options, sql: raw, realm: c0FixtureRealm });
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
          requestRef: customer.admission.admissionRef,
          idempotencyKey: customer.original.key,
          requestFingerprint: customer.original.fingerprint,
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
  assertMoneyCutoverSqlBackingOrigin(sql, { rawSql: raw, writerEpoch: EPOCH });
  return {
    customer,
    batches,
    transport,
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
    close: () => customer.close(),
  };
}

export async function completeCustomer(
  f: Awaited<ReturnType<typeof topupFixture>>,
): Promise<CustomerCustodyInput> {
  const c = f.customer,
    executor = createCustomerTrackedExecutionData(f.raw);
  let history = c.journal;
  let n: CustomerCustodyInput | undefined;
  for (const phase of ["L1", "D", "N"] as const) {
    const common = {
      admission: c.admission,
      history,
      writerEpoch: EPOCH,
      couplingAttemptRef: `topup-fixture:${phase}`,
      entryRef: `topup-fixture-entry:${phase}`,
      historyReceiptRef: `topup-fixture-H1:${phase}`,
    };
    const dispatch = {
      claimRef: "topup-fixture-claim",
      dispatchAttemptRef: "topup-fixture-dispatch-attempt",
      dispatchReceiptRef: "topup-fixture-dispatch-receipt",
      dispatchedAt: c.at,
    };
    const q: CustomerPhaseInput =
      phase === "L1"
        ? { phase, ...common }
        : phase === "D"
          ? { phase, ...common, ...dispatch }
          : {
              phase,
              ...common,
              ...dispatch,
              custodyReceiptRef: "topup-fixture-custody",
              verifiedAt: c.at,
              nativeOriginal: {
                organizationId: c.org,
                commandKey: c.original.key,
                fingerprint: c.original.fingerprint,
                realmJson: c.original.realmJson,
                requestJson: c.original.requestJson,
                customerId: "cus_Synthetic",
              },
            };
    if (compileCustomerPhase(q).statements.length !== (phase === "L1" ? 9 : 8))
      throw Error("wrong original physical phase");
    const actual = await executor.executePhase(q);
    if (actual.status !== "acknowledged-own-phase-data")
      throw Error("Customer original phase did not complete");
    const next = await readCustomerJournalSnapshot(f.raw, {
      organizationId: c.org,
      realmRegistration: history.realmRegistration,
      realmIncarnation: history.realmIncarnation,
    });
    if (!next) throw Error("Customer chain missing");
    history = next;
    if (q.phase === "N") n = q;
  }
  if (!n) throw Error("missing N original");
  return n;
}
