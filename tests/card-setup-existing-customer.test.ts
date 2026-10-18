/** Authored/UNRUN. Real frozen Customer9/8/8, R1/C0/A and local SQLite adapters; synthetic authority/processor DATA only. */
import { expect, test } from "bun:test";
import {
  type CardSetupExistingCustomerOriginal,
  createCardSetupExistingCustomerData,
} from "../src/card-setup-existing-customer.ts";
import { base64UrlDecode, bytesDigest, canonicalDigest, canonicalJson } from "../src/json.ts";
import type { SqlParam } from "../src/ports.ts";
import { buildFinancialR1MechanicalBatch } from "../src/shared-financial-retained-r1.ts";
import { cardSetupFixture, completeCustomer } from "./fixtures/card-setup-fixture.ts";
import { createFiveActionConsentDataAssembler } from "./fixtures/five-action-consent-data.ts";

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
  const f = await cardSetupFixture(rp);
  try {
    const customer = await completeCustomer(f);
    const action = {
      kind: "card-setup" as const,
      organizationId: f.customer.org,
      reference: "existing-customer-card-setup",
      setupDisclosureRevision: "disclosure:original",
    };
    const r1 = await f.command(action, "existing-card-setup", termsText);
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
      actionKind: "card-setup" as const,
      actionRef: action.reference,
      requestFingerprint: r1.original.c0.challenge.requestFingerprint,
      grantRef: "card-setup-fixture-grant",
      grantIncarnation: "card-setup-fixture-grant-inc",
      consentRef: "card-setup-fixture-consent-original",
      consentIncarnation: "card-setup-fixture-consent-inc",
      issuanceAttempt: "card-setup-fixture-consent-attempt",
      receiptRef: "card-setup-fixture-consent-receipt",
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
    if (selectionFault === "mediaType") selectedTerms.mediaType = "text/html";
    if (selectionFault === "locale") selectedTerms.locale = "ja-JP";
    if (selectionFault === "bodyByteLength")
      selectedTerms.bodyByteLength = terms.bodyByteLength + 1;
    if (selectionFault === "digestRecipe")
      selectedTerms.digestRecipe = "financial-terms-utf8-sha256-v2";
    if (selectionFault === "extra") selectedTerms.extraField = "not-in-original";
    if (selectionFault === "missing") delete selectedTerms.locale;
    if (selectionFault === "crossed") {
      const other = (
        await f.command(action, "crossed-card-setup", "different full original display")
      ).original.selectedTerms;
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
      action_kind: action.kind,
      action_ref: action.reference,
      request_fingerprint: consent.requestFingerprint,
      action_json: canonicalJson(action),
      challenge_json: JSON.stringify(r1.original.c0.challenge),
      created_at_ms: r1.original.c0.challenge.createdAt,
      expires_at_ms: r1.original.c0.challenge.expiresAt,
      selection_json: JSON.stringify({
        auth: { human: consent.auth.human, credential: consent.auth.credential },
        // Bounded exact A identity; full raw display is not duplicated in A.
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
      origin_ref: "card-setup-payer-origin:fixture",
      origin_incarnation: "card-setup-payer-origin-inc:fixture",
      grant_ref: consent.grantRef,
      challenge_ref: consent.challengeRef,
      organization_id: action.organizationId,
      action_kind: "card-setup",
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
    const original: CardSetupExistingCustomerOriginal = {
      customer,
      r1,
      consent,
      createdAt: f.customer.at,
      admissionRef: "card-setup-admission:fixture",
      acceptanceAttemptRef: "card-setup-accept-attempt:fixture",
      acceptanceReceiptRef: "card-setup-accept-receipt:fixture",
      dispatchAttemptRef: "card-setup-dispatch-attempt:fixture",
      dispatchReceiptRef: "card-setup-dispatch-receipt:fixture",
      command: {
        customerId: customer.nativeOriginal.customerId,
        accountId: r1.original.scopeRealm.accountId,
        mode: r1.original.scopeRealm.mode,
        financialRealm: r1.original.scopeRealm.financialRealm,
        billingAuthority: r1.original.scopeRealm.billingAuthority,
        organizationId: action.organizationId,
        reference: action.reference,
        // Deliberately independent from payer principal: no inferred authorization mapping.
        authorizedPrincipal: "authorized-principal:original",
        setupDisclosureRevision: action.setupDisclosureRevision,
        successUrl: "https://console.example.test/billing?setup={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://console.example.test/billing?setup=cancelled",
      },
    };
    const options = { ...f.options, rawSql: f.raw };
    const make = (input = original) => createCardSetupExistingCustomerData(options, input);
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
      command: await f.raw.query("SELECT * FROM stripe_billing_card_setup_commands"),
      admission: await f.raw.query("SELECT * FROM financial_card_setup_admissions"),
      history: await f.raw.query(
        "SELECT * FROM financial_card_setup_history_receipts ORDER BY phase",
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
  test(`${lane}: fixed actual card-setup acceptance/first-CAS own ACK plus typed H1 preserve existing Customer`, async () => {
    const x = await setup(rp);
    try {
      const executor = x.make(),
        start = x.f.batches.length,
        providerReads = x.f.providerRequests,
        clocks = x.f.clocks;
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
        "own-first-dispatch-ack-data",
      );
      const batches = x.f.batches.slice(start);
      expect(batches.map((b) => b.length)).toEqual([6, 4]);
      expect(batches.every((b) => b.every((s) => (s.params?.length ?? 0) <= 100))).toBe(true);
      const c = x.original.command;
      const originalIdentity = {
        organizationId: c.organizationId,
        reference: c.reference,
        authorizedPrincipal: c.authorizedPrincipal,
        setupDisclosureRevision: c.setupDisclosureRevision,
        accountId: c.accountId,
        mode: c.mode,
        financialRealm: c.financialRealm,
        billingAuthority: c.billingAuthority,
        flowKind: "checkout-setup",
        successUrl: c.successUrl,
        cancelUrl: c.cancelUrl,
      };
      const fingerprint = await canonicalDigest(originalIdentity);
      const metadata = {
        organizationId: c.organizationId,
        reference: c.reference,
        fingerprint,
        setupDisclosureRevision: c.setupDisclosureRevision,
        stripeAccountId: c.accountId,
        financialRealm: c.financialRealm,
        billingAuthority: c.billingAuthority,
      };
      const requestJson = canonicalJson({
        mode: "setup",
        success_url: c.successUrl,
        cancel_url: c.cancelUrl,
        payment_method_types: ["card"],
        metadata,
        setup_intent_data: { metadata },
      });
      expect(batches[0]?.[1]?.sql).toContain("INSERT INTO stripe_billing_card_setup_commands");
      expect(batches[0]?.[1]?.params).toEqual([
        c.organizationId,
        c.reference,
        c.authorizedPrincipal,
        fingerprint,
        c.setupDisclosureRevision,
        c.accountId,
        c.mode,
        c.financialRealm,
        c.billingAuthority,
        c.successUrl,
        c.cancelUrl,
        requestJson,
        `takos-card-setup-${fingerprint.slice(7)}`,
        x.original.createdAt,
      ]);
      expect(batches[0]?.[2]?.params?.slice(0, 3)).toEqual([
        c.customerId,
        c.organizationId,
        c.reference,
      ]);
      expect(batches[0]?.[2]?.sql).toContain("state='awaiting-customer' AND EXISTS");
      expect(batches[1]?.[1]?.params?.slice(1, 6)).toEqual([
        x.original.createdAt,
        c.organizationId,
        c.reference,
        c.organizationId,
        c.customerId,
      ]);
      expect(typeof batches[1]?.[1]?.params?.[0]).toBe("string");
      expect(String(batches[1]?.[1]?.params?.[0])).toMatch(/^[0-9a-f-]{36}$/u);
      expect(batches[1]?.[1]?.sql).toContain("current_card_setup_proof");
      const rows = await x.rows();
      expect(rows.command).toHaveLength(1);
      expect(rows.admission).toHaveLength(1);
      expect(rows.history.map((h) => h.phase)).toEqual([
        "card-setup-accepted",
        "card-setup-first-dispatch",
      ]);
      expect(rows.permit).toEqual([]);
      expect(rows.history[1]?.previous_receipt_ref).toBe(x.original.acceptanceReceiptRef);
      expect(await x.customerRows()).toEqual(x.before);
      expect(x.f.providerRequests).toBe(providerReads);
      expect(x.f.clocks).toBe(clocks); // No provider or Clock capability is called by this DATA executor.
      const count = x.f.batches.length;
      expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
        "held-original-get-only",
      );
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
        const phase = where === "dispatch" ? "card-setup-first-dispatch" : "card-setup-accepted";
        x.f.db.exec(`CREATE TRIGGER intended_card_setup_late_fault BEFORE INSERT ON financial_card_setup_history_receipts WHEN NEW.phase='${phase}' BEGIN
          SELECT CASE WHEN (SELECT count(*) FROM stripe_billing_card_setup_commands)=1 AND (SELECT count(*) FROM financial_card_setup_admissions)=1
          AND (SELECT state FROM stripe_billing_card_setup_commands)='${where === "dispatch" ? "dispatched" : "prepared"}'
          ${where === "dispatch" ? "AND (SELECT dispatched_at FROM stripe_billing_card_setup_commands) IS NOT NULL" : ""}
          THEN RAISE(ABORT,'constraint: intended card-setup H1 late fault after positive writes') ELSE RAISE(ABORT,'test: positive milestone missing') END; END`);
        expect(
          (
            await (where === "dispatch"
              ? executor.firstDispatch(x.original.createdAt)
              : executor.accept())
          ).status,
        ).toBe("held-original-get-only");
        expect(x.f.transport.lastError).toMatchObject({
          code: "constraint",
          message: expect.stringContaining(
            "intended card-setup H1 late fault after positive writes",
          ),
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
                  "UPDATE financial_source_registrations SET retired_at=?,retirement_ref='card-setup-test-retirement' WHERE registration_ref=?",
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
      const wrong = x.make({
        ...x.original,
        command: { ...x.original.command, setupDisclosureRevision: "disclosure:other" },
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
  for (const phase of ["acceptance", "dispatch"] as const) {
    test(`${lane}: zero-row ${phase} CAS cannot silently omit the unconditional mandatory H1`, async () => {
      const x = await setup(rp);
      try {
        const executor = x.make();
        if (phase === "dispatch")
          expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
        const before = await x.rows(),
          calls = x.f.batches.length;
        x.f.db.exec(`CREATE TRIGGER test_zero_card_cas BEFORE UPDATE ON stripe_billing_card_setup_commands
          WHEN OLD.state='${phase === "dispatch" ? "prepared" : "awaiting-customer"}'
          AND NEW.state='${phase === "dispatch" ? "dispatched" : "prepared"}' BEGIN SELECT RAISE(IGNORE); END`);
        expect(
          (
            await (phase === "dispatch"
              ? executor.firstDispatch(x.original.createdAt)
              : executor.accept())
          ).status,
        ).toBe("held-original-get-only");
        expect(x.f.batches.length).toBe(calls + 1);
        expect(x.f.transport.lastError).toMatchObject({ code: "constraint" });
        expect(await x.rows()).toEqual(before);
        expect(await x.customerRows()).toEqual(x.before);
      } finally {
        x.f.close();
      }
    });
  }
  test(`${lane}: full 32KiB selected terms remain in retained R1 and immutable card context`, async () => {
    const x = await setup(rp, "x".repeat(32768));
    try {
      const executor = x.make();
      expect(x.original.r1.original.selectedTerms.bodyByteLength).toBe(32768);
      const terms = x.original.r1.original.selectedTerms;
      const decoded = base64UrlDecode(terms.bodyUtf8Base64url);
      if (!decoded) throw Error("missing original raw terms");
      expect(decoded.byteLength).toBe(32768);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(decoded)).toBe("x".repeat(32768));
      expect(await bytesDigest(decoded)).toBe(terms.digest);
      const challenge = (
        await x.f.raw.query(
          "SELECT selection_json FROM shared_customer_challenges WHERE challenge_ref=?",
          [x.original.consent.challengeRef],
        )
      )[0];
      if (typeof challenge?.selection_json !== "string")
        throw Error("missing exact terms selection");
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
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      expect((await executor.firstDispatch(x.original.createdAt)).status).toBe(
        "own-first-dispatch-ack-data",
      );
      const rows = await x.rows();
      expect(rows.admission[0]?.context_json).toBe(JSON.stringify(x.original));
      expect(rows.history.every((h) => h.context_json === JSON.stringify(x.original))).toBe(true);
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
  ] as const) {
    test(`${lane}: compact terms ${field} mismatch cannot cross into the retained R1 body`, async () => {
      const x = await setup(rp, undefined, field);
      try {
        const before = await x.rows();
        expect((await x.make().accept()).status).toBe("held-original-get-only");
        expect(await x.rows()).toEqual(before);
        expect(await x.customerRows()).toEqual(x.before);
      } finally {
        x.f.close();
      }
    });
  }
  test(`${lane}: stringified canonical compact terms are rejected as a JSON string`, async () => {
    const x = await setup(rp, undefined, "stringified");
    try {
      const shape = (
        await x.f.raw.query(
          "SELECT json_type(selection_json,'$.selectedTerms') AS kind FROM shared_customer_challenges WHERE challenge_ref=?",
          [x.original.consent.challengeRef],
        )
      )[0];
      expect(shape?.kind).toBe("text");
      const before = await x.rows();
      expect((await x.make().accept()).status).toBe("held-original-get-only");
      expect(await x.rows()).toEqual(before);
      expect(await x.customerRows()).toEqual(x.before);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: changed raw R1 terms bytes with unchanged compact identity never execute`, async () => {
    const x = await setup(rp, "x".repeat(32768));
    try {
      const original = {
        ...x.original,
        r1: {
          ...x.original.r1,
          original: {
            ...x.original.r1.original,
            selectedTerms: { ...x.original.r1.original.selectedTerms, bodyUtf8Base64url: "eA" },
          },
        },
      };
      const before = await x.rows(),
        calls = x.f.batches.length;
      expect((await x.make(original).accept()).status).toBe("held-original-get-only");
      expect(x.f.batches.length).toBe(calls);
      expect(await x.rows()).toEqual(before);
      expect(await x.customerRows()).toEqual(x.before);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: actual typed current vector mismatch is GET-only without a new phase`, async () => {
    const x = await setup(rp);
    try {
      const current = x.original.consent.auth.current;
      const wrong =
        typeof current === "string"
          ? "revoked:old-observation"
          : { ...current, version: current.version + 1 };
      const original = {
        ...x.original,
        consent: { ...x.original.consent, auth: { ...x.original.consent.auth, current: wrong } },
      };
      expect((await x.make(original).accept()).status).toBe("held-original-get-only");
      expect((await x.rows()).command).toEqual([]);
      expect(await x.customerRows()).toEqual(x.before);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: nominal S requires its exact raw R, and caller mutation after construction cannot change captured original`, async () => {
    const x = await setup(rp);
    try {
      expect(() =>
        createCardSetupExistingCustomerData({ ...x.f.options, rawSql: { ...x.f.raw } }, x.original),
      ).toThrow();
      const mutable = { ...x.original, command: { ...x.original.command } },
        executor = x.make(mutable);
      mutable.command.authorizedPrincipal = "different-after-capture";
      mutable.command.successUrl = "https://different.example.test/changed";
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      const rows = await x.rows();
      expect(rows.command[0]?.authorized_principal).toBe(x.original.command.authorizedPrincipal);
      expect(rows.command[0]?.success_return_url).toBe(x.original.command.successUrl);
      expect(rows.admission[0]?.context_json).toBe(JSON.stringify(x.original));
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: inherited public card time-order CHECK remains intact while new H1 uses causal predecessor`, async () => {
    const x = await setup(rp);
    try {
      const executor = x.make();
      expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
      const before = await x.rows(),
        start = x.f.batches.length;
      const backwards = new Date(Date.parse(x.original.createdAt) - 1).toISOString();
      expect((await executor.firstDispatch(backwards)).status).toBe("held-original-get-only");
      expect(x.f.batches.length).toBe(start + 1);
      expect(x.f.batches[start]?.[1]?.params?.[1]).toBe(backwards);
      expect(await x.rows()).toEqual(before);
      expect(await x.customerRows()).toEqual(x.before);
    } finally {
      x.f.close();
    }
  });
  for (const clock of ["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"] as const) {
    test(`${lane}: full-range canonical Clock ${clock} reaches exact original INSERT without a new lexical filter`, async () => {
      const x = await setup(rp);
      try {
        expect(new Date(clock).toISOString()).toBe(clock);
        const original = { ...x.original, createdAt: clock },
          start = x.f.batches.length;
        expect((await x.make(original).accept()).status).toBe("held-original-get-only");
        // Original 0100 strftime constraint rejects expanded years. This is inherited,
        // not a new validator restriction or a success/native qualification claim.
        expect(x.f.batches.length).toBe(start + 1);
        expect(x.f.batches[start]?.[1]?.params?.[13]).toBe(clock);
        expect((await x.rows()).command).toEqual([]);
        expect((await x.rows()).permit).toEqual([]);
        expect(await x.customerRows()).toEqual(x.before);
      } finally {
        x.f.close();
      }
    });
    test(`${lane}: full-range dispatch Clock ${clock} reaches exact six-bind CAS and inherited schema rollback`, async () => {
      const x = await setup(rp);
      try {
        const executor = x.make();
        expect((await executor.accept()).status).toBe("own-acceptance-ack-data");
        const before = await x.rows(),
          start = x.f.batches.length;
        expect((await executor.firstDispatch(clock)).status).toBe("held-original-get-only");
        expect(x.f.batches.length).toBe(start + 1);
        expect(x.f.batches[start]?.[1]?.params?.[1]).toBe(clock);
        expect(await x.rows()).toEqual(before);
      } finally {
        x.f.close();
      }
    });
  }
}
