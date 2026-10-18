/** Authored/UNRUN. Real frozen Customer9/8/8, R1/C0/A and local SQLite adapters; synthetic authority/processor DATA only. */
import { expect, test } from "bun:test";
import { base64UrlDecode, bytesDigest, canonicalDigest, canonicalJson } from "../src/json.ts";
import {
  createPlanChangeExistingCustomerData,
  type PlanChangeExistingCustomerOriginal,
} from "../src/plan-change-existing-customer.ts";
import type { SqlParam } from "../src/ports.ts";
import { buildFinancialR1MechanicalBatch } from "../src/shared-financial-retained-r1.ts";
import { createFiveActionConsentDataAssembler } from "./fixtures/five-action-consent-data.ts";
import { completeCustomer, NEXT_PLAN, planFixture } from "./fixtures/plan-change-fixture.ts";

function values(row: Record<string, unknown>): SqlParam[] {
  return Object.values(row).map((x) => {
    if (x === null || typeof x === "string" || typeof x === "number" || x instanceof ArrayBuffer)
      return x;
    throw Error("unexpected fixture SQL parameter type");
  });
}
type TermsMetadataFault =
  | "ref"
  | "digest"
  | "mediaType"
  | "locale"
  | "bodyByteLength"
  | "digestRecipe"
  | "extra"
  | "missing"
  | "crossed"
  | "stringified";
async function setup(rp: boolean, termsText?: string, termsMetadataFault?: TermsMetadataFault) {
  const f = await planFixture(rp);
  try {
    const customer = await completeCustomer(f);
    await f.seedTarget();
    const action = {
      kind: "plan-change" as const,
      organizationId: f.customer.org,
      reference: "existing-customer-plan",
      expectedSubscriptionRef: f.target.subscriptionRef,
      planKey: NEXT_PLAN.planKey,
    };
    const r1 = await f.command(action, "existing-plan", termsText);
    await f.registerFixtureData();
    await f.c0.prepare(r1.original.c0);
    expect(
      (await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, r1))).map(
        (x) => x.changes,
      ),
    ).toEqual([1, 1]);
    const consent = {
      ...f.customer.input,
      actionKind: "plan-change" as const,
      challengeRef: r1.key.challengeRef,
      actionRef: action.reference,
      requestFingerprint: r1.original.c0.challenge.requestFingerprint,
      grantRef: "plan-fixture-grant",
      grantIncarnation: "plan-fixture-grant-inc",
      consentRef: "plan-fixture-consent-original",
      consentIncarnation: "plan-fixture-consent-inc",
      issuanceAttempt: "plan-fixture-consent-attempt",
      receiptRef: "plan-fixture-consent-receipt",
    };
    const old = (
      await f.raw.query("SELECT * FROM shared_customer_challenges WHERE challenge_ref=?", [
        f.customer.input.challengeRef,
      ])
    )[0];
    if (!old) throw Error("missing original A challenge");
    const terms = r1.original.selectedTerms;
    const termsSelection: Record<string, unknown> = JSON.parse(
      canonicalJson({
        ref: terms.ref,
        digest: terms.digest,
        mediaType: terms.mediaType,
        locale: terms.locale,
        bodyByteLength: terms.bodyByteLength,
        digestRecipe: terms.digestRecipe,
      }),
    );
    if (termsMetadataFault === "ref") termsSelection.ref = "terms:foreign";
    if (termsMetadataFault === "digest") termsSelection.digest = `sha256:${"0".repeat(64)}`;
    if (termsMetadataFault === "mediaType") termsSelection.mediaType = "text/html";
    if (termsMetadataFault === "locale") termsSelection.locale = "ja-JP";
    if (termsMetadataFault === "bodyByteLength") termsSelection.bodyByteLength = 32767;
    if (termsMetadataFault === "digestRecipe") termsSelection.digestRecipe = "foreign-terms-recipe";
    if (termsMetadataFault === "extra") termsSelection.extra = true;
    if (termsMetadataFault === "missing") delete termsSelection.locale;
    if (termsMetadataFault === "crossed") {
      termsSelection.ref = "terms:other-retained-original";
      termsSelection.digest = `sha256:${"1".repeat(64)}`;
    }
    const challenge = {
      ...old,
      challenge_ref: consent.challengeRef,
      action_kind: action.kind,
      action_ref: action.reference,
      request_fingerprint: consent.requestFingerprint,
      action_json: canonicalJson(action),
      challenge_json: JSON.stringify(r1.original.c0.challenge),
      created_at_ms: r1.original.c0.challenge.createdAt,
      expires_at_ms: r1.original.c0.challenge.expiresAt,
      selection_json: JSON.stringify({
        auth: { human: consent.auth.human, credential: consent.auth.credential },
        selectedTerms:
          termsMetadataFault === "stringified"
            ? canonicalJson(termsSelection)
            : JSON.parse(canonicalJson(termsSelection)),
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
      origin_ref: "plan-payer-origin:fixture",
      origin_incarnation: "plan-payer-origin-inc:fixture",
      grant_ref: consent.grantRef,
      challenge_ref: consent.challengeRef,
      organization_id: action.organizationId,
      action_kind: "plan-change",
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
    const original: PlanChangeExistingCustomerOriginal = {
      customer,
      r1,
      consent,
      desired: action,
      frozen: { target: f.target, plan: NEXT_PLAN, effectiveAt: f.target.periodEnd },
      selectionObservedAt: f.customer.at,
      createdAt: f.customer.at,
      admissionRef: "plan-admission:fixture",
      acceptanceAttemptRef: "plan-accept-attempt:fixture",
      acceptanceReceiptRef: "plan-accept-receipt:fixture",
      createAttemptRef: "plan-create-attempt:fixture",
      createReceiptRef: "plan-create-receipt:fixture",
      scheduleAttemptRef: "plan-schedule-attempt:fixture",
      scheduleReceiptRef: "plan-schedule-receipt:fixture",
    };
    const options = { ...f.options, rawSql: f.raw };
    const make = (input = original) => createPlanChangeExistingCustomerData(options, input);
    const protectedTables = [
      "stripe_billing_customer_commands",
      "stripe_billing_customers",
      "financial_customer_custody_receipts",
      "financial_customer_history_entries",
      "financial_customer_history_receipts",
      "financial_customer_history_heads",
    ];
    const customerRows = () =>
      Promise.all(protectedTables.map((table) => f.raw.query(`SELECT * FROM ${table} ORDER BY 1`)));
    const before = await customerRows();
    const rows = async () => ({
      command: await f.raw.query("SELECT * FROM stripe_billing_plan_changes"),
      slot: await f.raw.query("SELECT * FROM stripe_billing_plan_change_slots"),
      step: await f.raw.query("SELECT * FROM stripe_billing_plan_change_steps ORDER BY step"),
      admission: await f.raw.query("SELECT * FROM financial_plan_change_admissions"),
      history: await f.raw.query(
        "SELECT * FROM financial_plan_change_history_receipts ORDER BY sequence",
      ),
      guards: await f.raw.query("SELECT * FROM wallet_allocation_guards"),
      permit: await f.raw.query("SELECT * FROM money_cutover_writer_permit"),
    });
    const clock = {
      createdAt: f.customer.at,
      observedAt: f.customer.at,
      dispatchedAt: f.customer.at,
    };
    const businessBatches = () =>
      f.batches.filter((batch) =>
        batch.some((s) => s.sql.includes("INSERT INTO financial_plan_change_history_receipts(")),
      );
    return { f, original, make, rows, customerRows, before, clock, businessBatches };
  } catch (error) {
    f.close();
    throw error;
  }
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Boundary = "acceptance" | "create" | "schedule";
async function reach(x: Setup, boundary: Boundary) {
  const executor = x.make();
  if (boundary !== "acceptance")
    expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
  if (boundary === "schedule") {
    expect((await executor.firstCreateDispatch(x.clock)).status).toBe(
      "own-create-first-dispatch-ack-data",
    );
    await x.f.recordCreated(x.original.desired.reference);
  }
  return executor;
}
async function invoke(
  executor: ReturnType<Setup["make"]>,
  boundary: Boundary,
  clock: Setup["clock"],
) {
  return boundary === "acceptance"
    ? executor.accept()
    : boundary === "create"
      ? executor.firstCreateDispatch(clock)
      : executor.firstScheduleDispatch(clock);
}
for (const rp of [false, true]) {
  const lane = rp ? "RP" : "broker";
  test(`${lane}: exact acceptance/create/schedule SQL and distinct H1 originals preserve every schedule setting`, async () => {
    const x = await setup(rp);
    try {
      const providerBefore = x.f.providerRequests,
        clocksBefore = x.f.clocks;
      const executor = x.make();
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      expect((await executor.firstCreateDispatch(x.clock)).status).toBe(
        "own-create-first-dispatch-ack-data",
      );
      await x.f.recordCreated(x.original.desired.reference);
      expect((await executor.firstScheduleDispatch(x.clock)).status).toBe(
        "own-schedule-first-dispatch-ack-data",
      );
      const batches = x.businessBatches();
      expect(batches.map((b) => b.length)).toEqual([9, 10, 10]);
      const realm = x.f.options.realm,
        pin = await canonicalDigest([realm, x.original.desired]);
      expect(batches[0]?.[3]?.params).toEqual([
        x.original.desired.organizationId,
        x.original.desired.reference,
        pin,
        "plan-change",
        x.original.desired.expectedSubscriptionRef,
        x.original.frozen.target.terms.subscriptionId,
        1,
        canonicalJson(x.original.desired),
        canonicalJson(x.original.frozen),
        x.original.createdAt,
      ]);
      expect(batches[0]?.[4]?.params).toEqual([
        x.original.desired.organizationId,
        x.original.desired.reference,
        1,
      ]);
      for (const [i, name] of [
        [1, "create"],
        [2, "schedule"],
      ] as const) {
        const step = batches[i]?.[3],
          cas = batches[i]?.[5];
        expect(step?.params?.slice(0, 3)).toEqual([
          x.original.desired.organizationId,
          x.original.desired.reference,
          name,
        ]);
        expect(step?.params?.[4]).toBe(
          `takos-plan-${await canonicalDigest([realm, { org: x.original.desired.organizationId, reference: x.original.desired.reference, step: name }])}`,
        );
        expect(cas?.params).toEqual([
          x.clock.dispatchedAt,
          x.original.desired.organizationId,
          x.original.desired.reference,
          name,
        ]);
      }
      const rows = await x.rows();
      expect(rows.command).toHaveLength(1);
      expect(rows.slot).toHaveLength(1);
      expect(rows.step).toHaveLength(2);
      expect(rows.history.map((r) => r.phase)).toEqual([
        "plan-accepted",
        "plan-create-dispatched",
        "plan-schedule-dispatched",
      ]);
      expect(rows.history[1]?.previous_receipt_ref).toBe(x.original.acceptanceReceiptRef);
      expect(rows.history[2]?.previous_receipt_ref).toBe(x.original.createReceiptRef);
      const scheduled = rows.step.find((s) => s.step === "schedule");
      if (typeof scheduled?.request_json !== "string") throw Error("schedule request missing");
      const form = JSON.parse(scheduled.request_json) as Record<string, string>;
      expect(form["end_behavior"]).toBe("release");
      expect(form["proration_behavior"]).toBe("none");
      expect(form["metadata[takoserverPlanCommand]"]).toBe(pin);
      for (const i of [0, 1]) {
        expect(form[`phases[${i}][collection_method]`]).toBe("send_invoice");
        expect(form[`phases[${i}][default_payment_method]`]).toBe("pm_existing");
        expect(form[`phases[${i}][description]`]).toBe("preserved description");
        expect(form[`phases[${i}][invoice_settings][issuer][type]`]).toBe("self");
        expect(form[`phases[${i}][invoice_settings][days_until_due]`]).toBe("7");
        expect(form[`phases[${i}][metadata][retainedTag]`]).toBe("original");
        expect(form[`phases[${i}][items][0][metadata][retainedItem]`]).toBe("original");
        expect(form[`phases[${i}][discounts]`]).toBe("");
        expect(form[`phases[${i}][default_tax_rates]`]).toBe("");
        expect(form[`phases[${i}][automatic_tax][enabled]`]).toBe("false");
      }
      expect(form["phases[0][items][0][price]"]).toBe(x.original.frozen.target.terms.priceId);
      expect(form["phases[1][items][0][price]"]).toBe(NEXT_PLAN.priceId);
      expect(form["phases[0][end_date]"]).toBe(
        String(Date.parse(x.original.frozen.target.periodEnd) / 1000),
      );
      expect(form["phases[1][start_date]"]).toBe(form["phases[0][end_date]"]);
      expect(rows.permit).toEqual([]);
      expect(rows.guards).toEqual([]);
      expect(await x.customerRows()).toEqual(x.before);
      expect(x.f.providerRequests).toBe(providerBefore);
      expect(x.f.clocks).toBe(clocksBefore);
      const count = x.f.batches.length;
      expect((await executor.firstScheduleDispatch(x.clock)).status).toBe("held-original-get-only");
      expect(x.f.batches.length).toBe(count);
    } finally {
      x.f.close();
    }
  });
  for (const boundary of ["acceptance", "create", "schedule"] as const) {
    test(`${lane}: ${boundary} late H1 fault observes actual positive SQL then rolls whole batch back`, async () => {
      const x = await setup(rp);
      try {
        const executor = await reach(x, boundary),
          before = await x.rows(),
          phase =
            boundary === "acceptance"
              ? "plan-accepted"
              : boundary === "create"
                ? "plan-create-dispatched"
                : "plan-schedule-dispatched";
        const step =
          boundary === "acceptance"
            ? ""
            : ` AND EXISTS(SELECT 1 FROM stripe_billing_plan_change_steps WHERE step='${boundary}' AND state='dispatched')`;
        x.f.db.exec(
          `CREATE TRIGGER intended_plan_late_fault BEFORE INSERT ON financial_plan_change_history_receipts WHEN NEW.phase='${phase}' BEGIN SELECT CASE WHEN (SELECT count(*) FROM stripe_billing_plan_changes)=1 AND (SELECT count(*) FROM stripe_billing_plan_change_slots)=1 AND (SELECT count(*) FROM financial_plan_change_admissions)=1${step} THEN RAISE(ABORT,'constraint: intended plan H1 late fault after positive writes') ELSE RAISE(ABORT,'test: positive plan milestone missing') END;END`,
        );
        expect((await invoke(executor, boundary, x.clock)).status).toBe("held-original-get-only");
        expect(x.f.transport.lastError).toMatchObject({
          code: "constraint",
          message: expect.stringContaining("intended plan H1 late fault after positive writes"),
        });
        expect(await x.rows()).toEqual(before);
        expect(await x.customerRows()).toEqual(x.before);
      } finally {
        x.f.close();
      }
    });
    for (const change of [
      "grant-revoked",
      "payer-closed",
      "source-retired",
      "credential-terminal",
    ] as const) {
      test(`${lane}: ${boundary} SQL rechecks ${change} before its typed phase can commit`, async () => {
        const x = await setup(rp);
        try {
          const executor = await reach(x, boundary),
            before = await x.rows();
          if (change === "grant-revoked")
            expect(
              (
                await x.f.raw.run(
                  "INSERT INTO financial_payer_grant_revocations VALUES(?,?,?,?,?)",
                  [
                    x.original.consent.grantRef,
                    "plan:revoked",
                    "test closure",
                    "plan:source",
                    x.original.createdAt,
                  ],
                )
              ).changes,
            ).toBe(1);
          if (change === "payer-closed")
            expect(
              (
                await x.f.raw.run(
                  "UPDATE org_memberships SET role='member' WHERE org_id=? AND role='owner'",
                  [x.original.desired.organizationId],
                )
              ).changes,
            ).toBe(1);
          if (change === "source-retired")
            expect(
              (
                await x.f.raw.run(
                  "UPDATE financial_source_registrations SET retired_at=?,retirement_ref='plan:test-retirement' WHERE registration_ref=?",
                  [x.original.createdAt, x.f.customer.registration.registrationRef],
                )
              ).changes,
            ).toBe(1);
          if (change === "credential-terminal") {
            const credential = x.original.consent.auth.credential;
            const r =
              credential.backend === "auth-token"
                ? await x.f.raw.run("UPDATE auth_tokens SET revoked_at=? WHERE id=?", [
                    x.original.createdAt,
                    credential.token.id,
                  ])
                : await x.f.raw.run(
                    "UPDATE shared_auth_sessions SET version=version+1 WHERE digest=?",
                    [credential.rp.sessionDigest],
                  );
            expect(r.changes).toBe(1);
          }
          expect((await invoke(executor, boundary, x.clock)).status).toBe("held-original-get-only");
          expect(await x.rows()).toEqual(before);
        } finally {
          x.f.close();
        }
      });
    }
    for (const fault of [
      "before-throw",
      "commit-throw",
      "truncated",
      "cas-zero",
      "post-read-throw",
      "typed-readback",
    ] as const) {
      test(`${lane}: ${boundary}/${fault} original unknown is never resent or adopted`, async () => {
        const x = await setup(rp);
        try {
          const executor = await reach(x, boundary);
          x.f.transport.fault = fault;
          x.f.transport.committed = false;
          expect((await invoke(executor, boundary, x.clock)).status).toBe("held-original-get-only");
          x.f.transport.fault = "none";
          const count = x.f.batches.length;
          expect((await invoke(executor, boundary, x.clock)).status).toBe("held-original-get-only");
          expect((await executor.readOriginal()).original).toEqual(x.original);
          expect(x.f.batches.length).toBe(count);
          if (!(boundary === "acceptance" && fault === "before-throw")) {
            const fresh = x.make();
            expect((await fresh.accept()).status).toBe("held-original-get-only");
            expect((await fresh.firstCreateDispatch(x.clock)).status).toBe(
              "held-original-get-only",
            );
            expect((await fresh.firstScheduleDispatch(x.clock)).status).toBe(
              "held-original-get-only",
            );
            expect(x.f.batches.length).toBe(count);
          }
          expect((await x.rows()).permit).toEqual([]);
          expect((await x.rows()).guards).toEqual([]);
        } finally {
          x.f.close();
        }
      });
    }
  }
  for (const reason of [
    "no-verified-create",
    "wrong-phase-price",
    "unsupported-setting",
    "connect-default",
  ] as const) {
    test(`${lane}: schedule ${reason} holds original without a new step or external call`, async () => {
      const x = await setup(rp);
      try {
        const executor = x.make();
        expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
        expect((await executor.firstCreateDispatch(x.clock)).status).toBe(
          "own-create-first-dispatch-ack-data",
        );
        if (reason !== "no-verified-create") {
          const original = x.f.nativeSchedule();
          const response =
            reason === "wrong-phase-price"
              ? {
                  ...original,
                  phases: original.phases.map((p) => ({
                    ...p,
                    items: p.items.map((i) => ({ ...i, price: "price_foreign" })),
                  })),
                }
              : reason === "unsupported-setting"
                ? {
                    ...original,
                    phases: original.phases.map((p) => ({ ...p, coupon: "coupon_foreign" })),
                  }
                : {
                    ...original,
                    default_settings: {
                      ...original.default_settings,
                      transfer_data: { destination: "acct_foreign" },
                    },
                  };
          await x.f.recordCreated(x.original.desired.reference, response);
        }
        const before = await x.rows(),
          count = x.f.batches.length;
        expect((await executor.firstScheduleDispatch(x.clock)).status).toBe(
          "held-original-get-only",
        );
        expect(x.f.batches.length).toBe(count);
        expect(await x.rows()).toEqual(before);
      } finally {
        x.f.close();
      }
    });
  }
  for (const change of ["generation", "period", "target-customer", "slot"] as const) {
    test(`${lane}: acceptance rejects changed ${change} with no command effect`, async () => {
      const x = await setup(rp);
      try {
        const executor = x.make();
        if (change === "generation")
          await x.f.sql.run("UPDATE stripe_billing_associations SET association_generation=2");
        if (change === "period")
          await x.f.sql.run(
            "UPDATE stripe_billing_subscriptions SET period_end='2020-01-01T00:00:00.000Z'",
          );
        if (change === "target-customer")
          await x.f.sql.run("UPDATE stripe_billing_subscriptions SET customer_id='cus_Foreign'");
        if (change === "slot") {
          const d = { ...x.original.desired, reference: "other-plan" };
          await x.f.sql.run(
            "INSERT INTO stripe_billing_plan_changes(org_id,reference,fingerprint,kind,expected_subscription_ref,subscription_id,expected_generation,desired_json,frozen_json,state,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,?)",
            [
              d.organizationId,
              d.reference,
              await canonicalDigest([x.f.options.realm, d]),
              d.kind,
              d.expectedSubscriptionRef,
              x.original.frozen.target.terms.subscriptionId,
              1,
              canonicalJson(d),
              canonicalJson(x.original.frozen),
              x.original.createdAt,
            ],
          );
          await x.f.sql.run(
            "INSERT INTO stripe_billing_plan_change_slots(org_id,reference,generation) VALUES(?,?,?)",
            [d.organizationId, d.reference, 1],
          );
        }
        const before = await x.rows();
        expect((await executor.accept()).status).toBe("held-original-get-only");
        expect(await x.rows()).toEqual(before);
      } finally {
        x.f.close();
      }
    });
  }
  test(`${lane}: two factories elect one persisted original, without claiming overlapping native transactions`, async () => {
    const x = await setup(rp);
    try {
      const results = await Promise.all([x.make().accept(), x.make().accept()]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "held-original-get-only",
        "own-acceptance-ack-data",
      ]);
      expect((await x.rows()).history).toHaveLength(1);
      expect((await x.rows()).guards).toEqual([]);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: original own-data getter is refused without invoking it`, async () => {
    const x = await setup(rp);
    try {
      let calls = 0;
      const input = { ...x.original };
      Object.defineProperty(input, "desired", {
        enumerable: true,
        get() {
          calls++;
          return x.original.desired;
        },
      });
      expect(() => x.make(input)).toThrow();
      expect(calls).toBe(0);
      expect((await x.rows()).command).toEqual([]);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: input aliases and a replaced raw method never replace original dispatch custody`, async () => {
    const x = await setup(rp);
    try {
      const original = { ...x.original, desired: { ...x.original.desired } };
      const executor = x.make(original);
      original.desired.planKey = "tampered";
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      const before = await x.rows();
      const query = x.f.raw.query;
      x.f.raw.query = async () => [];
      try {
        expect((await executor.firstCreateDispatch(x.clock)).status).toBe("held-original-get-only");
        expect(x.businessBatches()).toHaveLength(1);
      } finally {
        x.f.raw.query = query;
      }
      expect(await x.rows()).toEqual(before);
    } finally {
      x.f.close();
    }
  });
  for (const [createdAt, dispatchedAt] of [
    ["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"],
    ["-000001-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z"],
  ] as const) {
    test(`${lane}: full canonical Date values ${createdAt} are preserved independently in step INSERT/CAS`, async () => {
      const x = await setup(rp);
      try {
        const executor = x.make({ ...x.original, createdAt });
        expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
        expect(
          (
            await executor.firstCreateDispatch({
              createdAt,
              observedAt: x.clock.observedAt,
              dispatchedAt,
            })
          ).status,
        ).toBe("own-create-first-dispatch-ack-data");
        const batch = x.businessBatches()[1];
        expect(batch?.[3]?.params?.[5]).toBe(createdAt);
        expect(batch?.[5]?.params?.[0]).toBe(dispatchedAt);
        expect((await x.rows()).history[1]?.recorded_at).toBe(dispatchedAt);
      } finally {
        x.f.close();
      }
    });
  }

  // V2 representation regression: full R1 body is retained, A selection carries only six metadata fields.
  test(`${lane}: 32KiB raw terms keep full R1 original and all three plan transitions with compact A metadata`, async () => {
    const x = await setup(rp, "T".repeat(32768));
    try {
      const terms = x.original.r1.original.selectedTerms;
      const decoded = base64UrlDecode(terms.bodyUtf8Base64url);
      if (decoded === null) throw Error("valid retained terms did not decode");
      expect(terms.bodyByteLength).toBe(32768);
      expect(decoded).toHaveLength(32768);
      expect(await bytesDigest(decoded)).toBe(terms.digest);
      const before = await x.f.raw.query(
        "SELECT * FROM financial_retained_r1_originals WHERE r1_ref=?",
        [x.original.r1.key.r1Ref],
      );
      const receipts = await x.f.raw.query(
        "SELECT * FROM financial_retained_r1_receipts WHERE r1_ref=?",
        [x.original.r1.key.r1Ref],
      );
      const challenge = (
        await x.f.raw.query(
          "SELECT selection_json FROM shared_customer_challenges WHERE challenge_ref=?",
          [x.original.consent.challengeRef],
        )
      )[0];
      if (typeof challenge?.selection_json !== "string") throw Error("missing actual A selection");
      expect(new TextEncoder().encode(challenge.selection_json).length).toBeLessThanOrEqual(16384);
      const selection = JSON.parse(challenge.selection_json).selectedTerms as Record<
        string,
        unknown
      >;
      expect(Object.keys(selection).sort()).toEqual([
        "bodyByteLength",
        "digest",
        "digestRecipe",
        "locale",
        "mediaType",
        "ref",
      ]);
      expect(selection).toEqual({
        ref: terms.ref,
        digest: terms.digest,
        mediaType: terms.mediaType,
        locale: terms.locale,
        bodyByteLength: terms.bodyByteLength,
        digestRecipe: terms.digestRecipe,
      });
      expect(Object.hasOwn(selection, "bodyUtf8Base64url")).toBe(false);
      const executor = x.make();
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      expect((await executor.firstCreateDispatch(x.clock)).status).toBe(
        "own-create-first-dispatch-ack-data",
      );
      await x.f.recordCreated(x.original.desired.reference);
      expect((await executor.firstScheduleDispatch(x.clock)).status).toBe(
        "own-schedule-first-dispatch-ack-data",
      );
      expect(x.businessBatches().map((batch) => batch.length)).toEqual([9, 10, 10]);
      expect((await x.rows()).history).toHaveLength(3);
      expect(
        await x.f.raw.query("SELECT * FROM financial_retained_r1_originals WHERE r1_ref=?", [
          x.original.r1.key.r1Ref,
        ]),
      ).toEqual(before);
      expect(
        await x.f.raw.query("SELECT * FROM financial_retained_r1_receipts WHERE r1_ref=?", [
          x.original.r1.key.r1Ref,
        ]),
      ).toEqual(receipts);
      if (typeof before[0]?.command_json !== "string") throw Error("missing retained R1 original");
      expect(JSON.parse(before[0].command_json).original.selectedTerms).toEqual(terms);
      expect(await x.customerRows()).toEqual(x.before);
    } finally {
      x.f.close();
    }
  });
  for (const mismatch of [
    "ref",
    "digest",
    "mediaType",
    "locale",
    "bodyByteLength",
    "digestRecipe",
    "extra",
    "missing",
    "crossed",
  ] as const) {
    test(`${lane}: compact A terms ${mismatch} cannot cross or weaken the exact full R1 binding`, async () => {
      const x = await setup(rp, "T".repeat(32768), mismatch);
      try {
        const before = await x.rows(),
          retained = await x.f.raw.query(
            "SELECT * FROM financial_retained_r1_originals WHERE r1_ref=?",
            [x.original.r1.key.r1Ref],
          );
        expect((await x.make().accept()).status).toBe("held-original-get-only");
        expect(await x.rows()).toEqual(before);
        expect(await x.customerRows()).toEqual(x.before);
        expect(
          await x.f.raw.query("SELECT * FROM financial_retained_r1_originals WHERE r1_ref=?", [
            x.original.r1.key.r1Ref,
          ]),
        ).toEqual(retained);
      } finally {
        x.f.close();
      }
    });
  }
  test(`${lane}: compact A metadata never substitutes for a changed full R1 raw body`, async () => {
    const x = await setup(rp, "T".repeat(32768));
    try {
      const r1 = x.original.r1,
        input = {
          ...x.original,
          r1: {
            ...r1,
            original: {
              ...r1.original,
              selectedTerms: { ...r1.original.selectedTerms, bodyUtf8Base64url: "QQ" },
            },
          },
        };
      const before = await x.rows(),
        count = x.f.batches.length;
      expect((await x.make(input).accept()).status).toBe("held-original-get-only");
      expect(await x.rows()).toEqual(before);
      expect(x.f.batches.length).toBe(count);
      expect(await x.customerRows()).toEqual(x.before);
    } finally {
      x.f.close();
    }
  });

  // V3: json_extract returns TEXT for both a JSON object and the same JSON-encoded string.
  test(`${lane}: JSON-string A terms with exact metadata text cannot masquerade as an object`, async () => {
    const x = await setup(rp, "T".repeat(32768), "stringified");
    try {
      const terms = x.original.r1.original.selectedTerms,
        metadata = canonicalJson({
          ref: terms.ref,
          digest: terms.digest,
          mediaType: terms.mediaType,
          locale: terms.locale,
          bodyByteLength: terms.bodyByteLength,
          digestRecipe: terms.digestRecipe,
        });
      const selected = (
        await x.f.raw.query(
          "SELECT json_type(selection_json,'$.selectedTerms') AS selected_type,json_extract(selection_json,'$.selectedTerms') AS selected_value FROM shared_customer_challenges WHERE challenge_ref=?",
          [x.original.consent.challengeRef],
        )
      )[0];
      expect(selected).toEqual({ selected_type: "text", selected_value: metadata });
      const before = await x.rows();
      expect((await x.make().accept()).status).toBe("held-original-get-only");
      expect(await x.rows()).toEqual(before);
      expect(await x.customerRows()).toEqual(x.before);
    } finally {
      x.f.close();
    }
  });
}
