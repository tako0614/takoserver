/** Authored/UNRUN. Real frozen Customer9/8/8, R1/C0/A and local SQLite adapters; synthetic authority/processor DATA only. */
import { expect, test } from "bun:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesDigest,
  canonicalDigest,
  canonicalJson,
} from "../src/json.ts";
import type { SqlParam } from "../src/ports.ts";
import { buildFinancialR1MechanicalBatch } from "../src/shared-financial-retained-r1.ts";
import {
  createStartExistingCustomerData,
  type StartExistingCustomerOriginal,
} from "../src/subscription-start-existing-customer.ts";
import { createFiveActionConsentDataAssembler } from "./fixtures/five-action-consent-data.ts";
import { completeCustomer, startFixture } from "./fixtures/start-fixture.ts";

function values(row: Record<string, unknown>): SqlParam[] {
  return Object.values(row).map((x) => {
    if (x === null || typeof x === "string" || typeof x === "number" || x instanceof ArrayBuffer)
      return x;
    throw Error("unexpected fixture SQL parameter type");
  });
}
async function setup(
  rp: boolean,
  termsText = "START exact historical terms",
  termsMutation?:
    | { readonly key: string; readonly value: string | number }
    | { readonly remove: string }
    | { readonly stringified: true },
) {
  const f = await startFixture(rp);
  try {
    const customer = await completeCustomer(f);
    const action = {
      kind: "subscription-start" as const,
      organizationId: f.customer.org,
      reference: "existing-customer-start",
      planKey: "basic",
    };
    const r1 = await f.command(action, "existing-start", termsText);
    await f.registerFixtureData();
    await f.c0.prepare(r1.original.c0);
    expect(
      (await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, r1))).map(
        (x) => x.changes,
      ),
    ).toEqual([1, 1]);
    const consent = {
      ...f.customer.input,
      actionKind: "subscription-start",
      challengeRef: r1.key.challengeRef,
      actionRef: action.reference,
      requestFingerprint: r1.original.c0.challenge.requestFingerprint,
      grantRef: "start-fixture-grant",
      grantIncarnation: "start-fixture-grant-inc",
      consentRef: "start-fixture-consent-original",
      consentIncarnation: "start-fixture-consent-inc",
      issuanceAttempt: "start-fixture-consent-attempt",
      receiptRef: "start-fixture-consent-receipt",
    };
    const old = (
      await f.raw.query("SELECT * FROM shared_customer_challenges WHERE challenge_ref=?", [
        f.customer.input.challengeRef,
      ])
    )[0];
    if (!old) throw Error("missing original A challenge");
    const terms = r1.original.selectedTerms;
    const termsSelection: Record<string, unknown> = {
      ref: terms.ref,
      digest: terms.digest,
      mediaType: terms.mediaType,
      locale: terms.locale,
      bodyByteLength: terms.bodyByteLength,
      digestRecipe: terms.digestRecipe,
    };
    if (termsMutation) {
      if ("remove" in termsMutation) delete termsSelection[termsMutation.remove];
      else if ("key" in termsMutation) termsSelection[termsMutation.key] = termsMutation.value;
    }
    const challenge = {
      ...old,
      challenge_ref: consent.challengeRef,
      action_kind: "subscription-start",
      action_ref: action.reference,
      request_fingerprint: consent.requestFingerprint,
      action_json: canonicalJson(action),
      challenge_json: JSON.stringify(r1.original.c0.challenge),
      created_at_ms: r1.original.c0.challenge.createdAt,
      expires_at_ms: r1.original.c0.challenge.expiresAt,
      selection_json: JSON.stringify({
        auth: { human: consent.auth.human, credential: consent.auth.credential },
        selectedTerms:
          termsMutation && "stringified" in termsMutation
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
      origin_ref: "start-payer-origin:fixture",
      origin_incarnation: "start-payer-origin-inc:fixture",
      grant_ref: consent.grantRef,
      challenge_ref: consent.challengeRef,
      organization_id: action.organizationId,
      action_kind: "subscription-start",
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
    const original: StartExistingCustomerOriginal = {
      customer,
      r1,
      consent,
      createdAt: f.customer.at,
      updatedAt: f.customer.at,
      admissionRef: "start-admission:fixture",
      acceptanceAttemptRef: "start-accept-attempt:fixture",
      acceptanceReceiptRef: "start-accept-receipt:fixture",
      dispatchAttemptRef: "start-dispatch-attempt:fixture",
      dispatchReceiptRef: "start-dispatch-receipt:fixture",
      command: {
        organizationId: action.organizationId,
        reference: action.reference,
        intentId: "sci_11111111-1111-4111-8111-111111111111",
        planKey: "basic",
        pricingRevision: "pricing:test",
        priceId: "price_enrollment",
        priceAmountMinor: 1000,
        includedMinor: 1000,
        customerId: customer.nativeOriginal.customerId,
        livemode: false,
        consoleOrigin: "https://console.example.test",
        effectiveAt: new Date(r1.original.c0.challenge.createdAt - 1).toISOString(),
      },
    };
    const options = {
      ...f.options,
      rawSql: f.raw,
      startCatalog: {
        pricingRevision: "pricing:test",
        effectiveAt: original.command.effectiveAt,
        plans: [
          {
            planId: "basic",
            stripePriceId: "price_enrollment",
            monthlyAmountMinor: 1000,
            includedCreditMinor: 1000,
          },
        ],
      },
    };
    const make = (input = original) => createStartExistingCustomerData(options, input);
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
      command: await f.raw.query("SELECT * FROM stripe_subscription_checkout_intents"),
      admission: await f.raw.query("SELECT * FROM financial_subscription_start_admissions"),
      history: await f.raw.query(
        "SELECT * FROM financial_subscription_start_history_receipts ORDER BY phase",
      ),
      permit: await f.raw.query("SELECT * FROM money_cutover_writer_permit"),
    });
    return { f, original, make, rows, customerRows, before };
  } catch (error) {
    f.close();
    throw error;
  }
}
for (const rp of [false, true]) {
  const lane = rp ? "RP" : "broker";
  test(`${lane}: START exact original acceptance20/CAS16 bind segments and typed predecessor preserve Customer`, async () => {
    const x = await setup(rp);
    try {
      const calls = x.f.batches.length,
        provider = x.f.providerRequests,
        executor = x.make(),
        c = x.original.command;
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
        "own-first-dispatch-ack-data",
      );
      const batches = x.f.batches.slice(calls),
        key = (await canonicalDigest([c.organizationId, c.reference])).slice(7);
      const fingerprint = (
        await canonicalDigest([
          c.organizationId,
          c.planKey,
          c.pricingRevision,
          c.priceId,
          c.priceAmountMinor,
          c.includedMinor,
          c.livemode,
          "subscription",
        ])
      ).slice(7);
      expect(batches.map((b) => b.length)).toEqual([5, 4]);
      expect(batches.every((b) => b.every((s) => (s.params?.length ?? 0) <= 100))).toBe(true);
      expect(batches[0]?.[1]?.sql).toContain(
        "INSERT OR IGNORE INTO stripe_subscription_checkout_intents",
      );
      expect(batches[0]?.[1]?.params?.slice(-20)).toEqual([
        c.intentId,
        c.organizationId,
        key,
        fingerprint,
        c.planKey,
        c.pricingRevision,
        c.priceId,
        c.priceAmountMinor,
        c.includedMinor,
        0,
        c.customerId,
        x.original.createdAt,
        x.original.updatedAt,
        c.organizationId,
        c.organizationId,
        c.organizationId,
        c.organizationId,
        c.organizationId,
        c.organizationId,
        c.organizationId,
      ]);
      expect(batches[1]?.[1]?.params?.slice(-16)).toEqual([
        x.original.createdAt,
        c.intentId,
        c.organizationId,
        c.pricingRevision,
        c.priceId,
        c.priceAmountMinor,
        c.includedMinor,
        c.customerId,
        c.organizationId,
        c.customerId,
        c.organizationId,
        c.organizationId,
        c.organizationId,
        c.organizationId,
        c.organizationId,
        c.organizationId,
      ]);
      const rows = await x.rows();
      expect(rows.command).toHaveLength(1);
      expect(rows.admission).toHaveLength(1);
      expect(rows.command[0]).toMatchObject({
        id: c.intentId,
        request_key_digest: key,
        fingerprint,
        state: "dispatched",
        customer_id: c.customerId,
        plan_key: c.planKey,
        pricing_revision: c.pricingRevision,
        price_id: c.priceId,
        price_amount_minor: c.priceAmountMinor,
        included_minor: c.includedMinor,
        session_id: null,
        session_url: null,
        subscription_id: null,
      });
      expect(rows.history.map((h) => h.phase)).toEqual([
        "subscription-start-accepted",
        "subscription-start-first-dispatch",
      ]);
      expect(rows.admission[0]?.stripe_key).toBe(`takoserver-subscription-checkout:${c.intentId}`);
      expect(rows.history[1]?.previous_receipt_ref).toBe(x.original.acceptanceReceiptRef);
      expect(rows.permit).toEqual([]);
      expect(await x.customerRows()).toEqual(x.before);
      expect(x.f.providerRequests).toBe(provider);
      const writes = x.f.batches.length;
      expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
        "held-original-get-only",
      );
      expect(x.f.batches.length).toBe(writes);
    } finally {
      x.f.close();
    }
  });
  for (const dates of [
    ["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"],
    ["-000001-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z"],
  ] as const)
    test(`${lane}: full ISO year range and independent acceptance clocks ${dates[0]}`, async () => {
      const x = await setup(rp);
      try {
        const original = { ...x.original, createdAt: dates[0], updatedAt: dates[1] },
          executor = x.make(original);
        expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
        expect((await executor.firstDispatch(dates[0])).status).toBe("own-first-dispatch-ack-data");
        const rows = await x.rows();
        expect(rows.command[0]?.created_at).toBe(dates[0]);
        expect(rows.history[0]?.command_updated_at).toBe(dates[1]);
        expect(rows.history[1]?.previous_receipt_ref).toBe(original.acceptanceReceiptRef);
      } finally {
        x.f.close();
      }
    });
  for (const where of ["acceptance", "dispatch"] as const) {
    test(`${lane}: late ${where} mandatory H1 fault observes positive writes then rolls the entire batch back`, async () => {
      const x = await setup(rp);
      try {
        const executor = x.make();
        if (where === "dispatch")
          expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
        const before = await x.rows();
        const phase =
          where === "dispatch"
            ? "subscription-start-first-dispatch"
            : "subscription-start-accepted";
        x.f.db.exec(`CREATE TRIGGER intended_START_late_fault BEFORE INSERT ON financial_subscription_start_history_receipts WHEN NEW.phase='${phase}' BEGIN
          SELECT CASE WHEN (SELECT count(*) FROM stripe_subscription_checkout_intents)=1 AND (SELECT count(*) FROM financial_subscription_start_admissions)=1
          ${where === "dispatch" ? "AND (SELECT state FROM stripe_subscription_checkout_intents) IS 'dispatched'" : ""}
          THEN RAISE(ABORT,'constraint: intended START H1 late fault after positive writes') ELSE RAISE(ABORT,'test: positive milestone missing') END; END`);
        expect(
          (
            await (where === "dispatch"
              ? executor.firstDispatch(x.original.createdAt)
              : executor.accept())
          ).status,
        ).toBe("held-original-get-only");
        expect(x.f.transport.lastError).toMatchObject({
          code: "constraint",
          message: expect.stringContaining("intended START H1 late fault after positive writes"),
        });
        expect(await x.rows()).toEqual(before);
        expect(await x.customerRows()).toEqual(x.before);
      } finally {
        x.f.close();
      }
    });
  }
  for (const boundary of ["acceptance", "dispatch"] as const)
    for (const change of [
      "grant-revoked",
      "payer-closed",
      "source-retired",
      "credential-terminal",
    ] as const) {
      test(`${lane}: ${boundary} rechecks ${change} and produces no phase effect`, async () => {
        const x = await setup(rp);
        try {
          const executor = x.make();
          if (boundary === "dispatch")
            expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
          const before = await x.rows();
          if (change === "grant-revoked")
            expect(
              (
                await x.f.raw.run(
                  "INSERT INTO financial_payer_grant_revocations VALUES(?,?,?,?,?)",
                  [
                    x.original.consent.grantRef,
                    "test:revoked",
                    "test payer closed",
                    "test:source",
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
                  [x.original.command.organizationId],
                )
              ).changes,
            ).toBe(1);
          if (change === "source-retired")
            expect(
              (
                await x.f.raw.run(
                  "UPDATE financial_source_registrations SET retired_at=?,retirement_ref='START-test-retirement' WHERE registration_ref=?",
                  [x.original.createdAt, x.f.customer.registration.registrationRef],
                )
              ).changes,
            ).toBe(1);
          if (change === "credential-terminal") {
            const credential = x.original.consent.auth.credential;
            const changed =
              credential.backend === "auth-token"
                ? await x.f.raw.run("UPDATE auth_tokens SET revoked_at=? WHERE id=?", [
                    x.original.createdAt,
                    credential.token.id,
                  ])
                : await x.f.raw.run(
                    "UPDATE shared_auth_sessions SET version=version+1 WHERE digest=?",
                    [credential.rp.sessionDigest],
                  );
            expect(changed.changes).toBe(1);
          }
          expect(
            (
              await (boundary === "dispatch"
                ? executor.firstDispatch(x.original.createdAt)
                : executor.accept())
            ).status,
          ).toBe("held-original-get-only");
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
  ] as const) {
    test(`${lane}: ${fault} acceptance remains original GET-only and never permits first dispatch`, async () => {
      const x = await setup(rp);
      try {
        const executor = x.make();
        x.f.transport.fault = fault;
        x.f.transport.committed = false;
        expect((await executor.accept()).status).toBe("held-original-get-only");
        x.f.transport.fault = "none";
        const calls = x.f.batches.length;
        expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
          "held-original-get-only",
        );
        expect((await executor.readOriginal()).original).toEqual(x.original);
        expect(x.f.batches.length).toBe(calls);
        if (fault !== "before-throw") {
          const fresh = x.make();
          expect((await fresh.accept()).status).toBe("held-original-get-only");
          expect((await fresh.firstDispatch(x.original.createdAt)).status).toBe(
            "held-original-get-only",
          );
          expect(x.f.batches.length).toBe(calls);
        }
        // Unknown FIRST batch before durable commit has no DB row: a fresh constructor
        // cannot prove prior attempt absence. Pre-API Root original custody remains required.
        expect((await x.rows()).command).toHaveLength(fault === "before-throw" ? 0 : 1);
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
  ] as const) {
    test(`${lane}: ${fault} first-dispatch is never replayed by this invocation or a fresh factory`, async () => {
      const x = await setup(rp);
      try {
        const executor = x.make();
        expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
        x.f.transport.fault = fault;
        x.f.transport.committed = false;
        expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
          "held-original-get-only",
        );
        x.f.transport.fault = "none";
        const calls = x.f.batches.length;
        expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
          "held-original-get-only",
        );
        const fresh = x.make();
        expect((await fresh.accept()).status).toBe("held-original-get-only");
        expect((await fresh.firstDispatch(x.original.createdAt)).status).toBe(
          "held-original-get-only",
        );
        expect(x.f.batches.length).toBe(calls);
        const rows = await x.rows();
        expect(rows.command).toHaveLength(1);
        expect(rows.command[0]?.state).toBe(fault === "before-throw" ? "prepared" : "dispatched");
        expect(rows.history).toHaveLength(fault === "before-throw" ? 1 : 2);
        expect(rows.permit).toEqual([]);
      } finally {
        x.f.close();
      }
    });
  }
  test(`${lane}: read first, mismatched R1/command and method drift never execute`, async () => {
    const x = await setup(rp);
    try {
      let calls = x.f.batches.length;
      const read = x.make();
      await read.readOriginal();
      expect((await read.accept()).status).toBe("held-original-get-only");
      expect(x.f.batches.length).toBe(calls);
      const wrong = x.make({
        ...x.original,
        command: { ...x.original.command, priceAmountMinor: 1001 },
      });
      expect((await wrong.accept()).status).toBe("held-original-get-only");
      expect(x.f.batches.length).toBe(calls);
      const missing = x.make({
        ...x.original,
        consent: { ...x.original.consent, grantRef: "absent-retained-grant" },
      });
      expect((await missing.accept()).status).toBe("held-original-get-only");
      expect((await x.rows()).command).toEqual([]);
      const executor = x.make();
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      calls = x.f.batches.length;
      const original = x.f.raw.query;
      x.f.raw.query = async () => [];
      try {
        expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
          "held-original-get-only",
        );
        expect(x.f.batches.length).toBe(calls);
      } finally {
        x.f.raw.query = original;
      }
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: two factory contenders elect one persisted original without claiming overlapping engine transactions`, async () => {
    const x = await setup(rp);
    try {
      const results = await Promise.all([x.make().accept(), x.make().accept()]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "held-original-get-only",
        "own-acceptance-ack-data",
      ]);
      const rows = await x.rows();
      expect(rows.command).toHaveLength(1);
      expect(rows.admission).toHaveLength(1);
      expect(rows.history).toHaveLength(1);
      expect(rows.permit).toEqual([]);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: valid backward wall clock keeps causal ordering in actual predecessor, not timestamp order`, async () => {
    const x = await setup(rp);
    try {
      const executor = x.make();
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      const backwards = new Date(Date.parse(x.original.createdAt) - 1).toISOString();
      expect((await executor.firstDispatch(backwards)).status).toBe("own-first-dispatch-ack-data");
      expect((await x.rows()).history[1]?.previous_receipt_ref).toBe(
        x.original.acceptanceReceiptRef,
      );
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: active Checkout slot is preserved and cannot be replaced by shared START`, async () => {
    const x = await setup(rp);
    try {
      const c = x.original.command;
      expect(
        (
          await x.f.sql.run(
            `INSERT INTO stripe_subscription_checkout_intents
        (id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`,
            [
              "sci_22222222-2222-4222-8222-222222222222",
              c.organizationId,
              "other-native-key",
              "other-fingerprint",
              c.planKey,
              c.pricingRevision,
              c.priceId,
              c.priceAmountMinor,
              c.includedMinor,
              0,
              c.customerId,
              x.original.createdAt,
              x.original.updatedAt,
            ],
          )
        ).changes,
      ).toBe(1);
      const before = await x.rows();
      expect((await x.make().accept()).status).toBe("held-original-get-only");
      expect(await x.rows()).toEqual(before);
      expect(await x.customerRows()).toEqual(x.before);
    } finally {
      x.f.close();
    }
  });
  for (const blocker of ["plan-slot", "pending-cancellation"] as const)
    test(`${lane}: native begin management fails closed on even orphan ${blocker}`, async () => {
      const x = await setup(rp);
      try {
        // Intentionally orphan administrative rows: only the original EXISTS predicate is at issue.
        x.f.db.exec("PRAGMA foreign_keys=OFF");
        if (blocker === "plan-slot")
          expect(
            (
              await x.f.sql.run(
                "INSERT INTO stripe_billing_plan_change_slots(org_id,reference,generation) VALUES(?,?,?)",
                [x.original.command.organizationId, "orphan-plan", 1],
              )
            ).changes,
          ).toBe(1);
        else
          expect(
            (
              await x.f.sql.run(
                `INSERT INTO stripe_subscription_cancellation_intents
          (id,org_id,request_key_digest,fingerprint,subscription_id,customer_id,livemode,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,pre_period_end,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`,
                [
                  "smc_orphan",
                  x.original.command.organizationId,
                  "cancel-key",
                  "cancel-fingerprint",
                  "sub_orphan",
                  x.original.command.customerId,
                  0,
                  x.original.command.planKey,
                  x.original.command.pricingRevision,
                  x.original.command.priceId,
                  x.original.command.priceAmountMinor,
                  x.original.command.includedMinor,
                  x.original.createdAt,
                  x.original.createdAt,
                  x.original.createdAt,
                ],
              )
            ).changes,
          ).toBe(1);
        x.f.db.exec("PRAGMA foreign_keys=ON");
        expect((await x.make().accept()).status).toBe("held-original-get-only");
        const rows = await x.rows();
        expect(rows.command).toEqual([]);
        expect(rows.admission).toEqual([]);
        expect(rows.history).toEqual([]);
        expect(rows.permit).toEqual([]);
      } finally {
        x.f.close();
      }
    });
  test(`${lane}: a missing immutable acceptance receipt cannot be healed by dispatch or a fresh factory`, async () => {
    const x = await setup(rp);
    try {
      const executor = x.make();
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      x.f.db.exec("DROP TRIGGER financial_subscription_start_history_receipts_no_delete");
      expect(
        (
          await x.f.sql.run(
            "DELETE FROM financial_subscription_start_history_receipts WHERE receipt_ref=?",
            [x.original.acceptanceReceiptRef],
          )
        ).changes,
      ).toBe(1);
      const before = await x.rows();
      expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
        "held-original-get-only",
      );
      expect(await x.rows()).toEqual(before);
      expect((await x.make().accept()).status).toBe("held-original-get-only");
      expect(await x.rows()).toEqual(before);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: full32768-byte historical UTF8 terms remain in the original receipt context`, async () => {
    const text = "界".repeat(10922) + "ab",
      x = await setup(rp, text);
    try {
      const terms = x.original.r1.original.selectedTerms;
      const bytes = base64UrlDecode(terms.bodyUtf8Base64url);
      if (bytes === null) throw Error("invalid retained START terms encoding");
      expect(bytes.byteLength).toBe(32768);
      expect(new TextDecoder("utf8", { fatal: true }).decode(bytes)).toBe(text);
      expect(await bytesDigest(bytes)).toBe(terms.digest);
      const challenge = (
        await x.f.raw.query(
          "SELECT selection_json FROM shared_customer_challenges WHERE challenge_ref=?",
          [x.original.consent.challengeRef],
        )
      )[0];
      const selectionJson = challenge?.selection_json;
      if (typeof selectionJson !== "string") throw Error("missing compact START terms metadata");
      expect(new TextEncoder().encode(selectionJson).byteLength).toBeLessThanOrEqual(16384);
      expect(JSON.parse(selectionJson).selectedTerms).toEqual({
        ref: terms.ref,
        digest: terms.digest,
        mediaType: terms.mediaType,
        locale: terms.locale,
        bodyByteLength: terms.bodyByteLength,
        digestRecipe: terms.digestRecipe,
      });
      expect(Object.hasOwn(JSON.parse(selectionJson).selectedTerms, "bodyUtf8Base64url")).toBe(
        false,
      );
      const before = await x.rows(),
        calls = x.f.batches.length;
      const altered = {
        ...x.original,
        r1: {
          ...x.original.r1,
          original: {
            ...x.original.r1.original,
            selectedTerms: {
              ...terms,
              bodyUtf8Base64url: base64UrlEncode(new TextEncoder().encode("x".repeat(32768))),
            },
          },
        },
      };
      expect((await x.make(altered).accept()).status).toBe("held-original-get-only");
      expect(await x.rows()).toEqual(before);
      expect(x.f.batches.length).toBe(calls);
      expect((await x.make().accept()).status).toBe("own-acceptance-ack-data");
      const rows = await x.rows(),
        context = rows.admission[0]?.context_json;
      if (typeof context !== "string") throw Error("missing full retained START context");
      expect(JSON.parse(context).r1.original.selectedTerms).toEqual(
        x.original.r1.original.selectedTerms,
      );
      expect(x.original.r1.original.selectedTerms.bodyByteLength).toBe(32768);
      const retained = (
        await x.f.raw.query(
          `SELECT ro.command_json,rr.command_json AS receipt_command_json
        FROM financial_retained_r1_originals ro JOIN financial_retained_r1_receipts rr
        ON rr.r1_ref=ro.r1_ref AND rr.receipt_ref=ro.receipt_ref WHERE ro.r1_ref=?`,
          [x.original.r1.key.r1Ref],
        )
      )[0];
      expect(retained?.command_json).toBe(canonicalJson(x.original.r1));
      expect(retained?.receipt_command_json).toBe(canonicalJson(x.original.r1));
    } finally {
      x.f.close();
    }
    // Same62 registered cases: finite metadata variants run inside this original wide-terms case.
    for (const mutation of [
      { key: "ref", value: "terms:crossed-original" },
      { key: "digest", value: `sha256:${"0".repeat(64)}` },
      { key: "mediaType", value: "text/html; charset=utf-8" },
      { key: "locale", value: "ja-JP" },
      { key: "bodyByteLength", value: 32767 },
      { key: "digestRecipe", value: "financial-terms-utf8-sha256-v0" },
      { key: "bodyUtf8Base64url", value: "unexpected-duplicate-body" },
      { remove: "digest" },
      { stringified: true },
    ] as const) {
      const bad = await setup(rp, text, mutation);
      try {
        const before = await bad.rows();
        expect((await bad.make().accept()).status).toBe("held-original-get-only");
        expect(await bad.rows()).toEqual(before);
        expect(await bad.customerRows()).toEqual(bad.before);
        expect((await bad.rows()).permit).toEqual([]);
      } finally {
        bad.f.close();
      }
    }
  });
}
