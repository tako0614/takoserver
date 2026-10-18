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
  createTopUpExistingCustomerData,
  type TopUpExistingCustomerOriginal,
} from "../src/topup-existing-customer.ts";
import { createFiveActionConsentDataAssembler } from "./fixtures/five-action-consent-data.ts";
import { completeCustomer, topupFixture } from "./fixtures/topup-fixture.ts";

function values(row: Record<string, unknown>): SqlParam[] {
  return Object.values(row).map((x) => {
    if (x === null || typeof x === "string" || typeof x === "number" || x instanceof ArrayBuffer)
      return x;
    throw Error("unexpected fixture SQL parameter type");
  });
}
type TermsSelectionFault =
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
async function setup(rp: boolean, termsText?: string, selectionFault?: TermsSelectionFault) {
  const f = await topupFixture(rp);
  try {
    const customer = await completeCustomer(f);
    const action = {
      kind: "topup" as const,
      organizationId: f.customer.org,
      reference: "existing-customer-topup",
      amountMinor: 500,
    };
    const r1 = await f.command(action, "existing-topup", termsText);
    await f.registerFixtureData();
    await f.c0.prepare(r1.original.c0);
    expect(
      (await f.sql.batch(await buildFinancialR1MechanicalBatch(f.options, r1))).map(
        (x) => x.changes,
      ),
    ).toEqual([1, 1]);
    const consent = {
      ...f.customer.input,
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
    const terms = r1.original.selectedTerms;
    const selectedTerms: Record<string, unknown> = {
      ref: terms.ref,
      digest: terms.digest,
      mediaType: terms.mediaType,
      locale: terms.locale,
      bodyByteLength: terms.bodyByteLength,
      digestRecipe: terms.digestRecipe,
    };
    if (selectionFault === "ref") selectedTerms.ref = "terms:crossed";
    if (selectionFault === "digest") selectedTerms.digest = `sha256:${"2".repeat(64)}`;
    if (selectionFault === "mediaType") selectedTerms.mediaType = "text/html; charset=utf-8";
    if (selectionFault === "locale") selectedTerms.locale = "ja-JP";
    if (selectionFault === "bodyByteLength")
      selectedTerms.bodyByteLength = terms.bodyByteLength + 1;
    if (selectionFault === "digestRecipe")
      selectedTerms.digestRecipe = "financial-terms-utf8-sha256-v0";
    if (selectionFault === "extra") selectedTerms.unexpectedMetadata = "not-in-original";
    if (selectionFault === "missing") delete selectedTerms.locale;
    if (selectionFault === "crossed") {
      const other = (await f.command(action, "crossed-topup", "different full original terms"))
        .original.selectedTerms;
      for (const key of Object.keys(selectedTerms)) delete selectedTerms[key];
      Object.assign(selectedTerms, {
        ref: other.ref,
        digest: other.digest,
        mediaType: other.mediaType,
        locale: other.locale,
        bodyByteLength: other.bodyByteLength,
        digestRecipe: other.digestRecipe,
      });
    }
    const challenge = {
      ...old,
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
          selectionFault === "stringified"
            ? canonicalJson(selectedTerms)
            : JSON.parse(canonicalJson(selectedTerms)),
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
      action_kind: "topup",
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
    const original: TopUpExistingCustomerOriginal = {
      customer,
      r1,
      consent,
      createdAt: f.customer.at,
      admissionRef: "topup-admission:fixture",
      acceptanceAttemptRef: "topup-accept-attempt:fixture",
      acceptanceReceiptRef: "topup-accept-receipt:fixture",
      dispatchAttemptRef: "topup-dispatch-attempt:fixture",
      dispatchReceiptRef: "topup-dispatch-receipt:fixture",
      command: {
        customerId: customer.nativeOriginal.customerId,
        accountId: r1.original.scopeRealm.accountId,
        livemode: false,
        financialRealm: r1.original.scopeRealm.financialRealm,
        pricingRevision: "pricing:test",
        purchaseCreditExpiry: { kind: "none" },
        organizationId: action.organizationId,
        reference: action.reference,
        amountMinor: 500,
        amountMicros: 5000000,
        currency: "USD",
        purpose: "wallet_funding",
        successUrl: "https://console.example.test/billing?checkout={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://console.example.test/billing?checkout=cancelled",
      },
    };
    const options = { ...f.options, rawSql: f.raw };
    const make = (input = original) => createTopUpExistingCustomerData(options, input);
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
      command: await f.raw.query("SELECT * FROM stripe_top_up_commands"),
      admission: await f.raw.query("SELECT * FROM financial_top_up_admissions"),
      history: await f.raw.query("SELECT * FROM financial_top_up_history_receipts ORDER BY phase"),
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
  test(`${lane}: fixed actual topup acceptance/first-CAS own ACK plus typed H1 preserve existing Customer`, async () => {
    const x = await setup(rp);
    try {
      const executor = x.make(),
        start = x.f.batches.length;
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      expect(
        (await executor.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
      ).toBe("own-first-dispatch-ack-data");
      const batches = x.f.batches.slice(start);
      expect(batches.map((b) => b.length)).toEqual([5, 4]);
      expect(batches.every((b) => b.every((s) => (s.params?.length ?? 0) <= 100))).toBe(true);
      expect(batches[0]?.[1]?.sql).toContain("INSERT OR IGNORE INTO stripe_top_up_commands");
      expect(batches[0]?.[1]?.params).toEqual([
        x.original.command.organizationId,
        x.original.command.reference,
        await canonicalDigest(x.original.command),
        canonicalJson(x.original.command),
        `takoserver_topup_${(await canonicalDigest([x.original.command.organizationId, x.original.command.reference])).slice(7)}`,
        x.original.createdAt,
        x.original.createdAt,
      ]);
      expect(batches[1]?.[1]?.params).toEqual([
        x.original.createdAt,
        x.original.createdAt,
        x.original.command.organizationId,
        x.original.command.reference,
      ]);
      const rows = await x.rows();
      expect(rows.command).toHaveLength(1);
      expect(rows.admission).toHaveLength(1);
      expect(rows.history.map((h) => h.phase)).toEqual(["topup-accepted", "topup-first-dispatch"]);
      expect(rows.permit).toEqual([]);
      expect(rows.history[1]?.previous_receipt_ref).toBe(x.original.acceptanceReceiptRef);
      expect(await x.customerRows()).toEqual(x.before);
      expect(x.f.providerRequests).toBeGreaterThan(0); // Explicit mocked owning GETs; no provider mutation path exists.
      const count = x.f.batches.length;
      expect(
        (await executor.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
      ).toBe("held-original-get-only");
      expect(x.f.batches.length).toBe(count);
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
        const phase = where === "dispatch" ? "topup-first-dispatch" : "topup-accepted";
        x.f.db.exec(`CREATE TRIGGER intended_topup_late_fault BEFORE INSERT ON financial_top_up_history_receipts WHEN NEW.phase='${phase}' BEGIN
          SELECT CASE WHEN (SELECT count(*) FROM stripe_top_up_commands)=1 AND (SELECT count(*) FROM financial_top_up_admissions)=1
          ${where === "dispatch" ? "AND (SELECT dispatched_at FROM stripe_top_up_commands) IS NOT NULL" : ""}
          THEN RAISE(ABORT,'constraint: intended topup H1 late fault after positive writes') ELSE RAISE(ABORT,'test: positive milestone missing') END; END`);
        expect(
          (
            await (where === "dispatch"
              ? executor.firstDispatch(x.original.createdAt, x.original.createdAt)
              : executor.accept())
          ).status,
        ).toBe("held-original-get-only");
        expect(x.f.transport.lastError).toMatchObject({
          code: "constraint",
          message: expect.stringContaining("intended topup H1 late fault after positive writes"),
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
                  "UPDATE financial_source_registrations SET retired_at=?,retirement_ref='topup-test-retirement' WHERE registration_ref=?",
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
                ? executor.firstDispatch(x.original.createdAt, x.original.createdAt)
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
        expect(
          (await executor.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
        ).toBe("held-original-get-only");
        expect((await executor.readOriginal()).original).toEqual(x.original);
        expect(x.f.batches.length).toBe(calls);
        if (fault !== "before-throw") {
          const fresh = x.make();
          expect((await fresh.accept()).status).toBe("held-original-get-only");
          expect(
            (await fresh.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
          ).toBe("held-original-get-only");
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
        expect(
          (await executor.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
        ).toBe("held-original-get-only");
        x.f.transport.fault = "none";
        const calls = x.f.batches.length;
        expect(
          (await executor.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
        ).toBe("held-original-get-only");
        const fresh = x.make();
        expect((await fresh.accept()).status).toBe("held-original-get-only");
        expect((await fresh.firstDispatch(x.original.createdAt, x.original.createdAt)).status).toBe(
          "held-original-get-only",
        );
        expect(x.f.batches.length).toBe(calls);
        const rows = await x.rows();
        expect(rows.command).toHaveLength(1);
        expect(rows.command[0]?.dispatched_at).toBe(
          fault === "before-throw" ? null : x.original.createdAt,
        );
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
      const wrong = x.make({ ...x.original, command: { ...x.original.command, amountMinor: 501 } });
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
        expect(
          (await executor.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
        ).toBe("held-original-get-only");
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
      expect((await executor.firstDispatch(backwards, x.original.createdAt)).status).toBe(
        "own-first-dispatch-ack-data",
      );
      expect((await x.rows()).history[1]?.previous_receipt_ref).toBe(
        x.original.acceptanceReceiptRef,
      );
    } finally {
      x.f.close();
    }
  });
  for (const [caseId, createdAt, dispatchedAt, updatedAt] of [
    [
      "positive-equal",
      "+010000-01-01T00:00:00.000Z",
      "+010000-01-01T00:00:00.000Z",
      "+010000-01-01T00:00:00.000Z",
    ],
    [
      "negative-equal",
      "-000001-01-01T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
    ],
    [
      "mixed-earlier-dispatch",
      "+010000-01-01T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      "+010001-01-01T00:00:00.000Z",
    ],
    [
      "mixed-backward-second-clock",
      "-000001-01-01T00:00:00.000Z",
      "+010000-01-01T00:00:00.000Z",
      "-000002-01-01T00:00:00.000Z",
    ],
  ] as const) {
    test(`${lane}: extended-year canonical Clock ${caseId} preserves actual INSERT7/CAS4 values`, async () => {
      const x = await setup(rp);
      try {
        for (const value of [createdAt, dispatchedAt, updatedAt])
          expect(new Date(value).toISOString()).toBe(value);
        const original = { ...x.original, createdAt };
        const executor = x.make(original),
          start = x.f.batches.length;
        expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
        expect((await executor.firstDispatch(dispatchedAt, updatedAt)).status).toBe(
          "own-first-dispatch-ack-data",
        );
        const batches = x.f.batches.slice(start);
        expect(batches.map((b) => b.length)).toEqual([5, 4]);
        expect(batches[0]?.[1]?.params).toEqual([
          original.command.organizationId,
          original.command.reference,
          await canonicalDigest(original.command),
          canonicalJson(original.command),
          `takoserver_topup_${(await canonicalDigest([original.command.organizationId, original.command.reference])).slice(7)}`,
          createdAt,
          createdAt,
        ]);
        expect(batches[1]?.[1]?.params).toEqual([
          dispatchedAt,
          updatedAt,
          original.command.organizationId,
          original.command.reference,
        ]);
        const rows = await x.rows();
        expect(rows.command).toHaveLength(1);
        expect(rows.command[0]).toMatchObject({
          created_at: createdAt,
          dispatched_at: dispatchedAt,
          updated_at: updatedAt,
        });
        expect(rows.history).toHaveLength(2);
        expect(rows.history[0]).toMatchObject({
          recorded_at: createdAt,
          command_updated_at: createdAt,
          dispatched_at: null,
        });
        expect(rows.history[1]).toMatchObject({
          recorded_at: dispatchedAt,
          command_updated_at: updatedAt,
          dispatched_at: dispatchedAt,
          previous_receipt_ref: original.acceptanceReceiptRef,
        });
        expect(rows.history.every((row) => row.context_json === JSON.stringify(original))).toBe(
          true,
        );
        expect(rows.permit).toEqual([]);
        expect(await x.customerRows()).toEqual(x.before);
      } finally {
        x.f.close();
      }
    });
  }
}

// New representation coverage is separate from the original56 case bodies above.
for (const rp of [false, true]) {
  const lane = rp ? "RP" : "broker";
  test(`${lane}: full32768-byte UTF8 terms stay whole in R1 and both typed topup receipts`, async () => {
    const text = "界".repeat(10922) + "ab";
    const x = await setup(rp, text);
    try {
      const terms = x.original.r1.original.selectedTerms;
      const bytes = base64UrlDecode(terms.bodyUtf8Base64url);
      if (bytes === null) throw Error("invalid retained topup terms encoding");
      expect(bytes.byteLength).toBe(32768);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(text);
      expect(await bytesDigest(bytes)).toBe(terms.digest);
      const challenge = (
        await x.f.raw.query(
          "SELECT selection_json,json_type(selection_json,'$.selectedTerms') AS kind FROM shared_customer_challenges WHERE challenge_ref=?",
          [x.original.consent.challengeRef],
        )
      )[0];
      if (typeof challenge?.selection_json !== "string")
        throw Error("missing bounded topup terms identity");
      expect(challenge.kind).toBe("object");
      expect(new TextEncoder().encode(challenge.selection_json).byteLength).toBeLessThanOrEqual(
        16384,
      );
      expect(JSON.parse(challenge.selection_json).selectedTerms).toEqual({
        ref: terms.ref,
        digest: terms.digest,
        mediaType: terms.mediaType,
        locale: terms.locale,
        bodyByteLength: terms.bodyByteLength,
        digestRecipe: terms.digestRecipe,
      });
      expect(
        Object.hasOwn(JSON.parse(challenge.selection_json).selectedTerms, "bodyUtf8Base64url"),
      ).toBe(false);
      const executor = x.make(),
        start = x.f.batches.length;
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      expect(
        (await executor.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
      ).toBe("own-first-dispatch-ack-data");
      const batches = x.f.batches.slice(start);
      expect(batches.map((batch) => batch.length)).toEqual([5, 4]);
      expect(
        batches.every((batch) =>
          batch.every((statement) => (statement.params?.length ?? 0) <= 100),
        ),
      ).toBe(true);
      const rows = await x.rows();
      expect(rows.admission[0]?.context_json).toBe(JSON.stringify(x.original));
      expect(rows.history).toHaveLength(2);
      for (const row of rows.history) {
        expect(row.context_json).toBe(JSON.stringify(x.original));
        if (typeof row.context_json !== "string")
          throw Error("missing full original topup H1 context");
        expect(JSON.parse(row.context_json).r1.original.selectedTerms).toEqual(terms);
      }
      const retained = (
        await x.f.raw.query(
          `SELECT ro.command_json,ro.terms_ref,ro.terms_digest,rr.command_json AS receipt_command_json
         FROM financial_retained_r1_originals ro JOIN financial_retained_r1_receipts rr
         ON rr.r1_ref=ro.r1_ref AND rr.receipt_ref=ro.receipt_ref WHERE ro.r1_ref=?`,
          [x.original.r1.key.r1Ref],
        )
      )[0];
      expect(retained?.command_json).toBe(canonicalJson(x.original.r1));
      expect(retained?.receipt_command_json).toBe(canonicalJson(x.original.r1));
      expect(retained?.terms_ref).toBe(terms.ref);
      expect(retained?.terms_digest).toBe(terms.digest);
      expect(await x.customerRows()).toEqual(x.before);
      expect(rows.permit).toEqual([]);
    } finally {
      x.f.close();
    }
  });
  for (const field of [
    "ref",
    "digest",
    "mediaType",
    "locale",
    "bodyByteLength",
    "digestRecipe",
    "extra",
    "missing",
    "crossed",
    "stringified",
  ] as const) {
    test(`${lane}: compact topup terms ${field} mismatch rolls back the original phase`, async () => {
      const x = await setup(rp, "界".repeat(10922) + "ab", field);
      try {
        const shape = (
          await x.f.raw.query(
            "SELECT json_type(selection_json,'$.selectedTerms') AS kind FROM shared_customer_challenges WHERE challenge_ref=?",
            [x.original.consent.challengeRef],
          )
        )[0];
        expect(shape?.kind).toBe(field === "stringified" ? "text" : "object");
        const before = await x.rows(),
          calls = x.f.batches.length;
        const executor = x.make();
        expect((await executor.accept()).status).toBe("held-original-get-only");
        const attempted = x.f.batches.slice(calls);
        expect(attempted.map((batch) => batch.length)).toEqual([5]);
        expect(attempted[0]?.[1]?.params).toEqual([
          x.original.command.organizationId,
          x.original.command.reference,
          await canonicalDigest(x.original.command),
          canonicalJson(x.original.command),
          `takoserver_topup_${(await canonicalDigest([x.original.command.organizationId, x.original.command.reference])).slice(7)}`,
          x.original.createdAt,
          x.original.createdAt,
        ]);
        expect(await x.rows()).toEqual(before);
        expect(
          (await executor.firstDispatch(x.original.createdAt, x.original.createdAt)).status,
        ).toBe("held-original-get-only");
        expect(x.f.batches.length).toBe(calls + 1);
        expect(await x.customerRows()).toEqual(x.before);
        expect((await x.rows()).permit).toEqual([]);
      } finally {
        x.f.close();
      }
    });
  }
  test(`${lane}: altered full raw R1 body with unchanged compact terms never reaches a phase batch`, async () => {
    const x = await setup(rp, "界".repeat(10922) + "ab");
    try {
      const original = {
        ...x.original,
        r1: {
          ...x.original.r1,
          original: {
            ...x.original.r1.original,
            selectedTerms: {
              ...x.original.r1.original.selectedTerms,
              bodyUtf8Base64url: base64UrlEncode(new TextEncoder().encode("x".repeat(32768))),
            },
          },
        },
      };
      const before = await x.rows(),
        calls = x.f.batches.length;
      expect((await x.make(original).accept()).status).toBe("held-original-get-only");
      expect(x.f.batches.length).toBe(calls);
      expect(await x.rows()).toEqual(before);
      expect(await x.customerRows()).toEqual(x.before);
      expect((await x.rows()).permit).toEqual([]);
    } finally {
      x.f.close();
    }
  });
}
