// Derived frozen fixture, synthetic/unmounted only. No old tests are registered; provider permits GET only.
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CancelExistingCustomerOriginal } from "../../src/cancel-existing-customer.ts";
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
  buildFinancialR1MechanicalBatch,
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
import { fixture as customerFixture } from "./financial-customer-five-action-fixture.ts";
import { createFiveActionConsentDataAssembler } from "./five-action-consent-data.ts";

const EPOCH = `sha256:${createHash("sha256").update("writer").digest("hex")}` as const;
const SCOPE: FinancialPreproofScope = {
  registrationRef: "source:registration",
  clientId: "client:synthetic",
  workspaceId: "workspace:synthetic",
  organizationId: "org:synthetic",
  workspaceRef: "workspace-ref:synthetic",
};
function economic(
  action: SharedFinancialAction,
  branch: "legacy" | "pending-plan-change",
): SelectedEconomicR1 {
  if (action.kind !== "cancel") throw Error("cancel-only fixture");
  return {
    kind: "cancel",
    expectedSubscriptionRef: action.expectedSubscriptionRef,
    targetSubscriptionId: "sub_CancelOriginal",
    targetGeneration: 1,
    branch,
    pendingReference: branch === "legacy" ? null : "old-plan-change",
    scheduleId: branch === "legacy" ? null : "sub_sched_CancelPending",
    cancelAtPeriodEnd: true,
  };
}
/** Derived actual R1 fixture on the actual completed Customer fixture DB. Synthetic only; no genuine proof. */
export async function cancelFixture(
  rp = false,
  branch: "legacy" | "pending-plan-change" = "legacy",
) {
  const customer = await customerFixture(rp);
  const AT = customer.at;
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
  db.exec(readFileSync(new URL("./cancel-history-schema.unnumbered.sql", import.meta.url), "utf8"));
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
        economic: economic(action, branch),
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
  f: Awaited<ReturnType<typeof cancelFixture>>,
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
      couplingAttemptRef: `cancel-fixture:${phase}`,
      entryRef: `cancel-fixture-entry:${phase}`,
      historyReceiptRef: `cancel-fixture-H1:${phase}`,
    };
    const dispatch = {
      claimRef: "cancel-fixture-claim",
      dispatchAttemptRef: "cancel-fixture-dispatch-attempt",
      dispatchReceiptRef: "cancel-fixture-dispatch-receipt",
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
              custodyReceiptRef: "cancel-fixture-custody",
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

function values(row: Record<string, unknown>) {
  return Object.values(row).map((x) => {
    if (x === null || typeof x === "string" || typeof x === "number" || x instanceof ArrayBuffer)
      return x;
    throw Error("unexpected fixture parameter");
  });
}
export type CancelTermsMetadataField =
  | "ref"
  | "digest"
  | "mediaType"
  | "locale"
  | "bodyByteLength"
  | "digestRecipe";
export async function cancelContext(
  rp = false,
  branch: "legacy" | "pending-plan-change" = "legacy",
  termsText?: string,
  termMismatch?: CancelTermsMetadataField | "json-string",
) {
  const f = await cancelFixture(rp, branch);
  try {
    const customer = await completeCustomer(f);
    const action = {
      kind: "cancel" as const,
      cancelAtPeriodEnd: true as const,
      organizationId: f.customer.org,
      reference: "cancel-existing-customer",
      expectedSubscriptionRef: `sra_${(await canonicalDigest(["takoserver-subscription-association-ref:v1", f.customer.org, "sub_CancelOriginal", customer.nativeOriginal.customerId, false])).slice(7)}`,
    };
    const r1 = await f.command(action, "existing-cancel", termsText);
    await f.registerFixtureData();
    await f.c0.prepare(r1.original.c0);
    expect(
      (await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, r1))).map(
        (x) => x.changes,
      ),
    ).toEqual([1, 1]);
    const consent = {
      ...f.customer.input,
      actionKind: "cancel",
      challengeRef: r1.key.challengeRef,
      actionRef: action.reference,
      requestFingerprint: r1.original.c0.challenge.requestFingerprint,
      grantRef: "topup-fixture-grant",
      grantIncarnation: "topup-fixture-grant-inc",
      consentRef: "topup-fixture-consent-original",
      consentIncarnation: "topup-fixture-consent-inc",
      issuanceAttempt: "topup-fixture-consent-attempt",
      receiptRef: "topup-fixture-consent-receipt",
    };
    const old = (
      await f.raw.query("SELECT * FROM shared_customer_challenges WHERE challenge_ref=?", [
        f.customer.input.challengeRef,
      ])
    )[0];
    if (!old) throw Error("missing original A challenge");
    const displayTerms = r1.original.selectedTerms;
    const termsMetadata: Record<string, unknown> = {
      ref: displayTerms.ref,
      digest: displayTerms.digest,
      mediaType: displayTerms.mediaType,
      locale: displayTerms.locale,
      bodyByteLength: displayTerms.bodyByteLength,
      digestRecipe: displayTerms.digestRecipe,
    };
    // Negative fixture data is chosen before immutable A INSERT; no retained guard is dropped.
    if (termMismatch)
      switch (termMismatch) {
        case "ref":
          termsMetadata.ref = "terms:other-original";
          break;
        case "digest":
          termsMetadata.digest = `sha256:${"0".repeat(64)}`;
          break;
        case "mediaType":
          termsMetadata.mediaType = "text/html";
          break;
        case "locale":
          termsMetadata.locale = "ja-JP";
          break;
        case "bodyByteLength":
          termsMetadata.bodyByteLength = displayTerms.bodyByteLength + 1;
          break;
        case "digestRecipe":
          termsMetadata.digestRecipe = "other-terms-recipe";
          break;
      }
    const challenge = {
      ...old,
      action_kind: "cancel",
      challenge_ref: consent.challengeRef,
      action_ref: action.reference,
      request_fingerprint: consent.requestFingerprint,
      action_json: canonicalJson(action),
      challenge_json: JSON.stringify(r1.original.c0.challenge),
      created_at_ms: r1.original.c0.challenge.createdAt,
      expires_at_ms: r1.original.c0.challenge.expiresAt,
      selection_json: JSON.stringify({
        auth: { human: consent.auth.human, credential: consent.auth.credential },
        selectedTerms:
          termMismatch === "json-string"
            ? canonicalJson(termsMetadata)
            : JSON.parse(canonicalJson(termsMetadata)),
        customer: f.customer.original,
      }),
    };
    await f.raw.run(
      `INSERT INTO shared_customer_challenges(${Object.keys(challenge).join(",")})VALUES(${Object.keys(
        challenge,
      )
        .map(() => "?")
        .join(",")})`,
      values(challenge),
    );
    for (const row of await f.raw.query(
      "SELECT * FROM financial_payer_challenge_sources WHERE challenge_ref=?",
      [f.customer.input.challengeRef],
    )) {
      const copy = { ...row, challenge_ref: consent.challengeRef };
      await f.raw.run(
        `INSERT INTO financial_payer_challenge_sources(${Object.keys(copy).join(",")})VALUES(${Object.keys(
          copy,
        )
          .map(() => "?")
          .join(",")})`,
        values(copy),
      );
    }
    const a = await createFiveActionConsentDataAssembler(f.options).prepare({
      consent,
      actionBody: action,
      original: r1,
    });
    expect((await f.raw.batch(a)).map((x) => x.changes)).toEqual([1, 1, 1]);
    // Exact existing A/payer-origin fixture recipe, synthetic rows only. The external
    // consentProofRef remains the original input value; it is not an identity-proof alias.
    const origin = {
      origin_ref: "topup-payer-origin:fixture",
      origin_incarnation: "topup-payer-origin-inc:fixture",
      grant_ref: consent.grantRef,
      challenge_ref: consent.challengeRef,
      organization_id: action.organizationId,
      action_kind: "cancel",
      action_ref: action.reference,
      request_fingerprint: consent.requestFingerprint,
      principal_id: consent.auth.human.principalId,
      principal_incarnation: consent.auth.human.principalIncarnation,
      principal_binding_ref: consent.auth.human.ref,
      authority_ref: consent.auth.credential.origin.ref,
      credential_incarnation: consent.auth.credential.origin.incarnation,
      account_id: r1.original.scopeRealm.accountId,
      mode: r1.original.scopeRealm.mode,
      billing_authority: r1.original.scopeRealm.billingAuthority,
      financial_realm: r1.original.scopeRealm.financialRealm,
      writer_epoch: f.options.writerEpoch,
      consent_registration_ref: consent.consentRegistrationRef,
      consent_incarnation: consent.consentIncarnation,
      consent_ref: consent.consentRef,
      consent_proof_ref: consent.consentProofRef,
      consent_digest: consent.consentDigest,
      qualification_kind: "genesis",
      qualification_ref: "qualification:synthetic-unmounted",
      qualification_digest: `sha256:${"1".repeat(64)}`,
      issued_at: consent.issuedAt,
      all_rows_match: 1,
    };
    await f.sql.run(
      `INSERT INTO financial_org_payer_origins(${Object.keys(origin).join(",")})VALUES(${Object.keys(
        origin,
      )
        .map(() => "?")
        .join(",")})`,
      values(origin),
    );

    const createdAt = f.customer.at,
      periodStart = new Date(Date.parse(createdAt) - 100000).toISOString(),
      periodEnd = new Date(Date.parse(createdAt) + 86400000).toISOString();
    const association = {
      organizationId: action.organizationId,
      subscriptionId: "sub_CancelOriginal",
      customerId: customer.nativeOriginal.customerId,
      livemode: false,
      planKey: "basic",
      pricingRevision: "pricing:test",
      priceId: "price_enrollment",
      priceAmountMinor: 1000,
      includedMinor: 1000,
      sessionId: "cs_CancelOriginal",
    };
    await f.sql.run(
      `INSERT INTO stripe_subscription_checkout_intents(id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,session_id,subscription_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'associated',?,?,?,?)`,
      [
        "sci_CancelOriginal",
        action.organizationId,
        "old-checkout-digest",
        "old-checkout-fingerprint",
        "basic",
        "pricing:test",
        "price_enrollment",
        1000,
        1000,
        0,
        association.customerId,
        association.sessionId,
        association.subscriptionId,
        createdAt,
        createdAt,
      ],
    );
    await f.sql.run(
      `INSERT INTO stripe_billing_associations(subscription_id,org_id,customer_id,livemode,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,session_id,association_generation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        association.subscriptionId,
        action.organizationId,
        association.customerId,
        0,
        "basic",
        "pricing:test",
        "price_enrollment",
        1000,
        1000,
        association.sessionId,
        1,
        createdAt,
      ],
    );
    await f.sql.run(
      `INSERT INTO stripe_billing_subscriptions(org_id,subscription_id,customer_id,plan_key,pricing_revision,status,cancel_at_period_end,period_start,period_end,paid_through,updated_at) VALUES(?,?,?,?,?,'active',0,?,?,?,?)`,
      [
        action.organizationId,
        association.subscriptionId,
        association.customerId,
        "basic",
        "pricing:test",
        periodStart,
        periodEnd,
        periodEnd,
        createdAt,
      ],
    );
    const terms = {
      organizationId: action.organizationId,
      subscriptionId: association.subscriptionId,
      customerId: association.customerId,
      planKey: "basic",
      pricingRevision: "pricing:test",
      priceId: "price_enrollment",
      priceAmountMinor: 1000,
      includedMinor: 1000,
    };
    const target = {
      subscriptionRef: action.expectedSubscriptionRef,
      generation: 1,
      terms,
      originalEffectiveAt: periodStart,
      periodStart,
      periodEnd,
      billingCycleAnchor: Math.floor(Date.parse(periodStart) / 1000),
      cancelAtPeriodEnd: false,
      unresolvedSettlement: false,
      scheduleId: branch === "legacy" ? null : "sub_sched_CancelPending",
    };
    if (branch !== "legacy") {
      const frozen = {
        target,
        plan: {
          planKey: "pro",
          pricingRevision: "pricing:next",
          priceId: "price_Pro",
          priceAmountMinor: 2000,
          includedMinor: 2000,
        },
        effectiveAt: periodEnd,
      };
      await f.sql.run(
        `INSERT INTO stripe_billing_plan_changes(org_id,reference,fingerprint,kind,expected_subscription_ref,subscription_id,expected_generation,desired_json,frozen_json,state,receipt_json,created_at) VALUES(?,?,?,'plan-change',?,?,?,?,?,'verified',?,?)`,
        [
          action.organizationId,
          "old-plan-change",
          "old-plan-fingerprint",
          action.expectedSubscriptionRef,
          association.subscriptionId,
          1,
          canonicalJson({
            organizationId: action.organizationId,
            reference: "old-plan-change",
            expectedSubscriptionRef: action.expectedSubscriptionRef,
            kind: "plan-change",
            planKey: "pro",
          }),
          canonicalJson(frozen),
          canonicalJson({
            state: "verified",
            subscriptionRef: action.expectedSubscriptionRef,
            pendingChange: {
              planKey: "pro",
              pricingRevision: "pricing:next",
              effectiveAt: periodEnd,
            },
          }),
          createdAt,
        ],
      );
      await f.sql.run(
        `INSERT INTO stripe_billing_subscription_terms(subscription_id,effective_at,org_id,terms_json,command_reference) VALUES(?,?,?,?,?)`,
        [
          association.subscriptionId,
          periodEnd,
          action.organizationId,
          canonicalJson({
            ...terms,
            planKey: "pro",
            pricingRevision: "pricing:next",
            priceId: "price_Pro",
            priceAmountMinor: 2000,
            includedMinor: 2000,
          }),
          "old-plan-change",
        ],
      );
      await f.sql.run(
        `INSERT INTO stripe_billing_plan_change_slots(org_id,reference,generation) VALUES(?,?,?)`,
        [action.organizationId, "old-plan-change", 3],
      );
      await f.sql.run(
        `INSERT INTO stripe_billing_plan_change_steps(org_id,reference,step,request_json,idempotency_key,state,remote_id,response_json,created_at,dispatched_at,verified_at) VALUES(?,?,'create','{}',?,'verified',?,'{}',?,?,?)`,
        [
          action.organizationId,
          "old-plan-change",
          "old-plan-create-key",
          "sub_sched_CancelPending",
          createdAt,
          createdAt,
          createdAt,
        ],
      );
    }
    function refs(stage: string) {
      return {
        admissionRef: `cancel-${stage}:admission`,
        acceptanceAttemptRef: `cancel-${stage}:accept-attempt`,
        acceptanceReceiptRef: `cancel-${stage}:accept-receipt`,
        preparationAttemptRef: stage === "release" ? "cancel-release:prepare-attempt" : null,
        preparationReceiptRef: stage === "release" ? "cancel-release:prepare-receipt" : null,
        dispatchAttemptRef: `cancel-${stage}:dispatch-attempt`,
        dispatchReceiptRef: `cancel-${stage}:dispatch-receipt`,
      };
    }
    const common = {
      customer,
      r1,
      consent,
      input: {
        organizationId: action.organizationId,
        reference: action.reference,
        expectedSubscriptionRef: action.expectedSubscriptionRef,
      },
    };
    const release: CancelExistingCustomerOriginal = {
      ...common,
      ...refs("release"),
      kind: "pending-release",
      original: {
        desired: {
          organizationId: action.organizationId,
          reference: action.reference,
          expectedSubscriptionRef: action.expectedSubscriptionRef,
          kind: "cancel",
          cancelAtPeriodEnd: true,
        },
        target,
        pendingReference: "old-plan-change",
        scheduleId: "sub_sched_CancelPending",
        effectiveAt: periodEnd,
        previousSlotGeneration: 3,
        createdAt,
        stepCreatedAt: createdAt,
      },
      parentRelease: null,
    };
    function native(
      parentRelease: { admissionRef: string; dispatchReceiptRef: string } | null = branch ===
      "legacy"
        ? null
        : { admissionRef: release.admissionRef, dispatchReceiptRef: release.dispatchReceiptRef },
    ): CancelExistingCustomerOriginal {
      return {
        ...common,
        ...refs("native"),
        kind: "native",
        original: {
          id: "smc_CancelOriginal",
          association,
          prePeriodEnd: periodEnd,
          createdAt,
          updatedAt: createdAt,
        },
        parentRelease,
      };
    }
    async function verifiedRelease(releasedAt = createdAt) {
      const response = {
        object: "subscription_schedule",
        id: "sub_sched_CancelPending",
        livemode: false,
        status: "released",
        released_subscription: association.subscriptionId,
        subscription: null,
        customer: association.customerId,
        released_at: Math.floor(Date.parse(releasedAt) / 1000),
      };
      const actualReleasedAt = new Date(Number(response.released_at) * 1000).toISOString();
      await f.sql.run(
        `UPDATE stripe_billing_plan_change_steps SET state='verified',remote_id=?,response_json=?,verified_at=? WHERE org_id=? AND reference=? AND step='release' AND state='dispatched'`,
        [response.id, canonicalJson(response), createdAt, action.organizationId, action.reference],
      );
      if (actualReleasedAt < periodEnd)
        await f.sql.run(
          `INSERT INTO stripe_billing_subscription_term_revocations(subscription_id,effective_at,org_id,reference,released_at,created_at) VALUES(?,?,?,?,?,?)`,
          [
            association.subscriptionId,
            periodEnd,
            action.organizationId,
            action.reference,
            actualReleasedAt,
            createdAt,
          ],
        );
    }
    return {
      f,
      customer,
      r1,
      consent,
      action,
      association,
      target,
      createdAt,
      periodEnd,
      release,
      native,
      verifiedRelease,
    };
  } catch (error) {
    f.close();
    throw error;
  }
}
