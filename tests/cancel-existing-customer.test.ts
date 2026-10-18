/** Authored / UNRUN. Actual SQLite adapters and frozen Root/Customer DATA fixtures; no genuine producer or provider execution. */
import { expect, test } from "bun:test";
import {
  type CancelExistingCustomerOriginal,
  createCancelExistingCustomerData,
} from "../src/cancel-existing-customer.ts";
import { base64UrlDecode, canonicalDigest, canonicalJson } from "../src/json.ts";
import { cancelContext } from "./fixtures/cancel-fixture.ts";

async function setup(
  rp = false,
  branch: "legacy" | "pending-plan-change" = "legacy",
  termsText?: string,
  termMismatch?: Parameters<typeof cancelContext>[3],
) {
  const x = await cancelContext(rp, branch, termsText, termMismatch);
  const make = (q: CancelExistingCustomerOriginal = branch === "legacy" ? x.native() : x.release) =>
    createCancelExistingCustomerData({ ...x.f.options, rawSql: x.f.raw }, q);
  const snapshot = async () => ({
    native: await x.f.raw.query(
      "SELECT * FROM stripe_subscription_cancellation_intents ORDER BY id",
    ),
    commands: await x.f.raw.query("SELECT * FROM stripe_billing_plan_changes ORDER BY reference"),
    slots: await x.f.raw.query("SELECT * FROM stripe_billing_plan_change_slots ORDER BY org_id"),
    steps: await x.f.raw.query(
      "SELECT * FROM stripe_billing_plan_change_steps ORDER BY reference,step",
    ),
    admissions: await x.f.raw.query(
      "SELECT * FROM financial_cancel_admissions ORDER BY admission_ref",
    ),
    history: await x.f.raw.query(
      "SELECT * FROM financial_cancel_history_receipts ORDER BY receipt_ref",
    ),
    guards: await x.f.raw.query("SELECT * FROM wallet_allocation_guards"),
    permits: await x.f.raw.query("SELECT * FROM money_cutover_writer_permit"),
  });
  const originalCustomer = await x.f.raw.query(
    "SELECT * FROM financial_customer_history_receipts ORDER BY receipt_ref",
  );
  return { ...x, make, snapshot, originalCustomer };
}
async function releaseAll(x: Awaited<ReturnType<typeof setup>>) {
  const e = x.make(x.release);
  expect((await e.accept()).status).toBe("own-phase-ack-data");
  expect((await e.prepareRelease()).status).toBe("own-phase-ack-data");
  expect((await e.firstDispatch(x.createdAt)).status).toBe("own-phase-ack-data");
  return e;
}
for (const [lane, rp] of [
  ["broker", false],
  ["RP", true],
] as const) {
  test(`${lane}: native acceptance and first dispatch retain the actual smc original and key without a provider call`, async () => {
    const x = await setup(rp);
    try {
      const e = x.make(),
        clocks = x.f.clocks,
        provider = x.f.providerRequests;
      expect((await e.accept()).phase).toBe("cancel-native-accepted");
      const accepted = await x.snapshot();
      expect(accepted.native[0]?.state).toBe("prepared");
      expect((await e.firstDispatch(x.createdAt)).phase).toBe("cancel-native-first-dispatch");
      const rows = await x.snapshot();
      expect(rows.native).toHaveLength(1);
      expect(rows.history).toHaveLength(2);
      expect(rows.admissions[0]?.stripe_key).toBe(
        "takoserver-subscription-cancel:smc_CancelOriginal",
      );
      expect(rows.native[0]?.request_key_digest).toBe(accepted.native[0]?.request_key_digest);
      expect(rows.native[0]?.fingerprint).toBe(accepted.native[0]?.fingerprint);
      expect(rows.guards).toEqual([]);
      expect(rows.permits).toEqual([]);
      expect(x.f.clocks).toBe(clocks);
      expect(x.f.providerRequests).toBe(provider);
      expect(
        await x.f.raw.query(
          "SELECT * FROM financial_customer_history_receipts ORDER BY receipt_ref",
        ),
      ).toEqual(x.originalCustomer);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: release command, step and native delegation remain five separate causal H1 transitions`, async () => {
    const x = await setup(rp, "pending-plan-change");
    try {
      await releaseAll(x);
      let r = await x.snapshot();
      expect(r.native).toEqual([]);
      expect(r.history).toHaveLength(3);
      expect(r.steps.find((row) => row.reference === x.action.reference)?.request_json).toBe(
        '{"preserve_cancel_date":"true"}',
      );
      const releaseKey = r.admissions.find((row) => row.stage === "pending-release")?.stripe_key;
      if (x.release.kind !== "pending-release") throw Error("wrong release fixture");
      expect(r.admissions[0]?.fingerprint).toBe(
        await canonicalDigest([x.f.options.realm, x.release.original.desired]),
      );
      expect(releaseKey).toBe(
        `takos-plan-${await canonicalDigest([x.f.options.realm, { org: x.action.organizationId, reference: x.action.reference, step: "release" }])}`,
      );
      expect((await x.make(x.native()).accept()).status).toBe("held-original-get-only");
      await x.verifiedRelease();
      const native = x.make(x.native());
      expect((await native.accept()).status).toBe("own-phase-ack-data");
      expect((await native.firstDispatch(x.createdAt)).status).toBe("own-phase-ack-data");
      r = await x.snapshot();
      expect(r.admissions).toHaveLength(2);
      expect(r.history).toHaveLength(5);
      expect(r.native).toHaveLength(1);
      expect(r.native[0]?.state).toBe("dispatched");
      expect(releaseKey).not.toBe(r.admissions.find((row) => row.stage === "native")?.stripe_key);
      expect(r.admissions.find((row) => row.stage === "native")?.parent_release_ref).toBe(
        x.release.admissionRef,
      );
      expect(r.permits).toEqual([]);
      expect(r.guards).toEqual([]);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: direct plan cancellation retains its four-field desired input without inventing the adapter fifth field`, async () => {
    const x = await setup(rp, "pending-plan-change");
    try {
      const base = x.release;
      if (base.kind !== "pending-release") throw Error("wrong fixture");
      const desired = {
        organizationId: x.action.organizationId,
        reference: x.action.reference,
        expectedSubscriptionRef: x.action.expectedSubscriptionRef,
        kind: "cancel" as const,
      };
      const q = { ...base, original: { ...base.original, desired } },
        e = x.make(q);
      expect((await e.accept()).status).toBe("own-phase-ack-data");
      const rows = await x.snapshot(),
        command = rows.commands.find((row) => row.reference === x.action.reference);
      expect(JSON.parse(String(command?.desired_json))).toEqual(desired);
      expect(command?.fingerprint).toBe(await canonicalDigest([x.f.options.realm, desired]));
      expect((await e.prepareRelease()).status).toBe("own-phase-ack-data");
      expect((await e.firstDispatch(x.createdAt)).status).toBe("own-phase-ack-data");
    } finally {
      x.f.close();
    }
  });
  for (const kind of ["native", "release"] as const)
    for (const fault of [
      "before-throw",
      "commit-throw",
      "truncated",
      "cas-zero",
      "post-read-throw",
    ] as const) {
      test(`${lane}: ${kind} acceptance ${fault} is held and never resumes a NEW dispatch`, async () => {
        const x = await setup(rp, kind === "native" ? "legacy" : "pending-plan-change");
        try {
          const q = kind === "native" ? x.native() : x.release,
            e = x.make(q);
          x.f.transport.fault = fault;
          x.f.transport.committed = false;
          expect((await e.accept()).status).toBe("held-original-get-only");
          x.f.transport.fault = "none";
          const batches = x.f.batches.length;
          expect((await e.firstDispatch(x.createdAt)).status).toBe("held-original-get-only");
          expect((await e.readOriginal()).original).toEqual(q);
          expect(x.f.batches.length).toBe(batches);
          if (fault !== "before-throw") {
            const fresh = x.make(q);
            expect((await fresh.accept()).status).toBe("held-original-get-only");
            expect(x.f.batches.length).toBe(batches);
          }
        } finally {
          x.f.close();
        }
      });
    }
  for (const kind of ["native", "release"] as const)
    for (const change of ["grant", "payer", "credential", "source"] as const) {
      test(`${lane}: ${kind} first dispatch rechecks actual ${change} currentness in the same batch`, async () => {
        const x = await setup(rp, kind === "native" ? "legacy" : "pending-plan-change");
        try {
          const q = kind === "native" ? x.native() : x.release,
            e = x.make(q);
          expect((await e.accept()).status).toBe("own-phase-ack-data");
          if (kind === "release")
            expect((await e.prepareRelease()).status).toBe("own-phase-ack-data");
          if (change === "grant")
            await x.f.raw.run("INSERT INTO financial_payer_grant_revocations VALUES(?,?,?,?,?)", [
              q.consent.grantRef,
              "cancel-revoked",
              "synthetic test",
              "cancel-source",
              x.createdAt,
            ]);
          if (change === "payer")
            await x.f.raw.run(
              "UPDATE org_memberships SET role='member' WHERE org_id=? AND role='owner'",
              [x.action.organizationId],
            );
          if (change === "source")
            await x.f.raw.run(
              "UPDATE financial_source_registrations SET retired_at=?,retirement_ref='cancel-retired' WHERE registration_ref=?",
              [x.createdAt, x.f.customer.registration.registrationRef],
            );
          if (change === "credential") {
            const c = q.consent.auth.credential;
            if (c.backend === "auth-token")
              await x.f.raw.run("UPDATE auth_tokens SET revoked_at=? WHERE id=?", [
                x.createdAt,
                c.token.id,
              ]);
            else
              await x.f.raw.run(
                "UPDATE shared_auth_sessions SET version=version+1 WHERE digest=?",
                [c.rp.sessionDigest],
              );
          }
          const before = await x.snapshot();
          expect((await e.firstDispatch(x.createdAt)).status).toBe("held-original-get-only");
          expect(await x.snapshot()).toEqual(before);
        } finally {
          x.f.close();
        }
      });
    }
  for (const phase of [
    "native-accept",
    "native-dispatch",
    "release-accept",
    "release-prepare",
    "release-dispatch",
  ] as const) {
    test(`${lane}: actual ${phase} late H1 failure rolls back every original command, slot and step write`, async () => {
      const release = phase.startsWith("release"),
        x = await setup(rp, release ? "pending-plan-change" : "legacy");
      try {
        const q = release ? x.release : x.native(),
          e = x.make(q);
        if (phase.endsWith("dispatch") || phase === "release-prepare")
          expect((await e.accept()).status).toBe("own-phase-ack-data");
        if (phase === "release-dispatch")
          expect((await e.prepareRelease()).status).toBe("own-phase-ack-data");
        const selected = {
          "native-accept": "cancel-native-accepted",
          "native-dispatch": "cancel-native-first-dispatch",
          "release-accept": "cancel-release-accepted",
          "release-prepare": "cancel-release-step-prepared",
          "release-dispatch": "cancel-release-first-dispatch",
        }[phase];
        // Only the original positive predecessor writes may reach the intended late fault.
        // A zero CAS/proof or wrong phase emits a different error and fails the old oracle.
        const lit = (value: unknown) => {
          if (typeof value !== "string") throw Error("missing cancel milestone string");
          return "'" + value.replaceAll("'", "''") + "'";
        };
        const accepted = phase.endsWith("accept"),
          prepared = phase === "release-prepare";
        const previous = accepted
          ? null
          : prepared || q.kind === "native"
            ? q.acceptanceReceiptRef
            : q.preparationReceiptRef;
        const receipt = accepted
          ? q.acceptanceReceiptRef
          : prepared
            ? q.preparationReceiptRef
            : q.dispatchReceiptRef;
        const attempt = accepted
          ? q.acceptanceAttemptRef
          : prepared
            ? q.preparationAttemptRef
            : q.dispatchAttemptRef;
        const recordedAt = accepted
          ? q.original.createdAt
          : prepared && q.kind === "pending-release"
            ? q.original.stepCreatedAt
            : x.createdAt;
        const updatedAt = accepted && q.kind === "native" ? q.original.updatedAt : recordedAt;
        const common = `NEW.all_rows_match IS 1 AND NEW.phase IS ${lit(selected)}
      AND NEW.receipt_ref IS ${lit(receipt)} AND NEW.attempt_ref IS ${lit(attempt)}
      AND NEW.org_id IS ${lit(q.input.organizationId)} AND NEW.reference IS ${lit(q.input.reference)}
      AND NEW.context_json IS ${lit(JSON.stringify(q))} AND NEW.original_json IS ${lit(JSON.stringify(q.original))}
      AND NEW.recorded_at IS ${lit(recordedAt)} AND NEW.command_updated_at IS ${lit(updatedAt)}
      AND ${previous === null ? "NEW.previous_receipt_ref IS NULL" : `NEW.previous_receipt_ref IS ${lit(previous)}`}
      AND EXISTS(SELECT 1 FROM financial_cancel_admissions a WHERE a.admission_ref IS ${lit(q.admissionRef)}
        AND a.admission_ref IS NEW.admission_ref AND a.org_id IS NEW.org_id AND a.reference IS NEW.reference AND a.stage IS ${lit(q.kind)}
        AND a.context_json IS NEW.context_json AND a.original_json IS NEW.original_json AND a.fingerprint IS NEW.fingerprint AND a.stripe_key IS NEW.stripe_key
        AND a.writer_epoch IS ${lit(x.f.options.writerEpoch)})`;
        let milestone: string;
        if (q.kind === "native") {
          const n = q.original;
          milestone = `EXISTS(SELECT 1 FROM stripe_subscription_cancellation_intents k
        JOIN financial_cancel_admissions a ON a.native_intent_id=k.id
        WHERE a.admission_ref IS NEW.admission_ref AND k.id IS ${lit(n.id)} AND k.org_id IS NEW.org_id
        AND k.subscription_id IS ${lit(n.association.subscriptionId)} AND k.customer_id IS ${lit(n.association.customerId)}
        AND k.fingerprint IS NEW.fingerprint AND k.request_key_digest IS a.request_key_digest
        AND k.state IS ${lit(accepted ? "prepared" : "dispatched")} AND k.created_at IS ${lit(n.createdAt)}
        AND k.updated_at IS ${lit(updatedAt)} AND k.pre_period_end IS ${lit(n.prePeriodEnd)})`;
        } else {
          const n = q.original;
          milestone = `EXISTS(SELECT 1 FROM stripe_billing_plan_changes c
        JOIN stripe_billing_plan_change_slots slot ON slot.org_id=c.org_id AND slot.reference=c.reference
        JOIN financial_cancel_admissions a ON a.plan_org_id=c.org_id AND a.plan_reference=c.reference
        WHERE a.admission_ref IS NEW.admission_ref AND c.org_id IS NEW.org_id AND c.reference IS NEW.reference
        AND c.kind='cancel' AND c.state='pending' AND c.expected_subscription_ref IS ${lit(q.input.expectedSubscriptionRef)}
        AND c.subscription_id IS ${lit(n.target.terms.subscriptionId)} AND c.expected_generation=${n.target.generation}
        AND c.created_at IS ${lit(n.createdAt)} AND c.fingerprint IS NEW.fingerprint
        AND c.desired_json IS a.desired_json AND c.frozen_json IS a.frozen_json AND slot.generation=${n.previousSlotGeneration + 1})`;
          if (!accepted)
            milestone += ` AND EXISTS(SELECT 1 FROM stripe_billing_plan_change_steps step
        WHERE step.org_id IS NEW.org_id AND step.reference IS NEW.reference AND step.step='release'
        AND step.state IS ${lit(prepared ? "prepared" : "dispatched")} AND step.idempotency_key IS NEW.stripe_key
        AND step.request_json IS '{"preserve_cancel_date":"true"}' AND step.created_at IS ${lit(n.stepCreatedAt)}
        AND ${prepared ? "step.dispatched_at IS NULL" : `step.dispatched_at IS ${lit(x.createdAt)}`}
        AND step.remote_id IS NULL AND step.response_json IS NULL AND step.verified_at IS NULL)`;
        }
        if (previous !== null)
          milestone += ` AND EXISTS(SELECT 1 FROM financial_cancel_history_receipts prior
      WHERE prior.receipt_ref IS NEW.previous_receipt_ref AND prior.admission_ref IS NEW.admission_ref
      AND prior.phase IS ${lit(prepared ? "cancel-release-accepted" : q.kind === "native" ? "cancel-native-accepted" : "cancel-release-step-prepared")}
      AND prior.context_json IS NEW.context_json AND prior.original_json IS NEW.original_json AND prior.all_rows_match IS 1)`;
        x.f.db.exec(`CREATE TRIGGER cancel_late_fault BEFORE INSERT ON financial_cancel_history_receipts WHEN NEW.phase='${selected}'
      BEGIN SELECT CASE WHEN (${common}) AND (${milestone})
        THEN RAISE(ABORT,'constraint: intended cancel H1 late failure')
        ELSE RAISE(ABORT,'constraint: cancel positive predecessor milestone not reached') END; END;`);
        const before = await x.snapshot();
        const r = phase.endsWith("accept")
          ? await e.accept()
          : phase === "release-prepare"
            ? await e.prepareRelease()
            : await e.firstDispatch(x.createdAt);
        expect(r.status).toBe("held-original-get-only");
        expect(x.f.transport.lastError).toMatchObject({
          code: "constraint",
          message: expect.stringContaining("intended cancel H1 late failure"),
        });
        expect(await x.snapshot()).toEqual(before);
      } finally {
        x.f.close();
      }
    });
  }
  for (const kind of ["native", "release"] as const)
    for (const fault of ["commit-throw", "truncated"] as const) {
      test(`${lane}: ${kind} first dispatch ${fault} retains its dispatched original without a second batch`, async () => {
        const x = await setup(rp, kind === "native" ? "legacy" : "pending-plan-change");
        try {
          const q = kind === "native" ? x.native() : x.release,
            e = x.make(q);
          expect((await e.accept()).status).toBe("own-phase-ack-data");
          if (kind === "release")
            expect((await e.prepareRelease()).status).toBe("own-phase-ack-data");
          x.f.transport.fault = fault;
          x.f.transport.committed = false;
          expect((await e.firstDispatch(x.createdAt)).status).toBe("held-original-get-only");
          x.f.transport.fault = "none";
          const before = await x.snapshot(),
            batches = x.f.batches.length;
          expect(
            kind === "native"
              ? before.native[0]?.state
              : before.steps.find((row) => row.reference === x.action.reference)?.state,
          ).toBe("dispatched");
          expect((await e.firstDispatch(x.createdAt)).status).toBe("held-original-get-only");
          expect((await x.make(q).firstDispatch(x.createdAt)).status).toBe(
            "held-original-get-only",
          );
          expect((await x.make(q).accept()).status).toBe("held-original-get-only");
          expect(await x.snapshot()).toEqual(before);
          expect(x.f.batches.length).toBe(batches);
        } finally {
          x.f.close();
        }
      });
    }
  test(`${lane}: closed typed admission and H1 reject replacement through each UNIQUE victim`, async () => {
    const x = await setup(rp, "pending-plan-change");
    try {
      await releaseAll(x);
      const before = await x.snapshot(),
        a = before.admissions[0],
        h = before.history[0];
      if (!a || !h) throw Error("missing retained fixture");
      const attempt = async (table: string, row: Record<string, unknown>) => {
        const keys = Object.keys(row),
          params = keys.map((key) => {
            const v = row[key];
            if (v === null || typeof v === "string" || typeof v === "number") return v;
            throw Error("unexpected SQL fixture value");
          });
        await expect(
          x.f.sql.run(
            `INSERT OR REPLACE INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
            params,
          ),
        ).rejects.toMatchObject({
          code: "constraint",
          message: expect.stringContaining("replacement"),
        });
        expect(await x.snapshot()).toEqual(before);
      };
      const fresh = {
        ...a,
        admission_ref: "other-admission",
        reference: "other-reference",
        acceptance_receipt_ref: "other-accepted",
        preparation_receipt_ref: "other-prepared",
        dispatch_receipt_ref: "other-dispatched",
      };
      await attempt("financial_cancel_admissions", { ...fresh, admission_ref: a.admission_ref });
      await attempt("financial_cancel_admissions", { ...fresh, reference: a.reference });
      for (const key of [
        "acceptance_receipt_ref",
        "preparation_receipt_ref",
        "dispatch_receipt_ref",
      ] as const)
        await attempt("financial_cancel_admissions", { ...fresh, [key]: a[key] });
      const other = {
        ...h,
        receipt_ref: "other-history",
        attempt_ref: "other-attempt",
        phase: "cancel-native-accepted",
      };
      await attempt("financial_cancel_history_receipts", { ...other, receipt_ref: h.receipt_ref });
      await attempt("financial_cancel_history_receipts", { ...other, attempt_ref: h.attempt_ref });
      await attempt("financial_cancel_history_receipts", { ...other, phase: h.phase });
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: original is detached before the first await and descriptor getters are never consumed`, async () => {
    const x = await setup(rp);
    try {
      const q = x.native(),
        e = x.make(q);
      const pending = e.accept();
      Object.defineProperty(q.original, "id", {
        value: "smc_CallerMutation",
        enumerable: true,
        configurable: true,
      });
      expect((await pending).original.original).toMatchObject({ id: "smc_CancelOriginal" });
      expect((await x.snapshot()).native[0]?.id).toBe("smc_CancelOriginal");
      const bad = x.native();
      let read = 0;
      Object.defineProperty(bad, "admissionRef", {
        get() {
          read++;
          throw Error("getter forbidden");
        },
        enumerable: true,
      });
      expect(() => x.make(bad)).toThrow();
      expect(read).toBe(0);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: stale target generation cannot accept or dispatch the old cancellation`, async () => {
    const x = await setup(rp);
    try {
      const e = x.make();
      expect((await e.accept()).status).toBe("own-phase-ack-data");
      await x.f.sql.run(
        `INSERT INTO stripe_subscription_checkout_intents(id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,session_id,subscription_id,created_at,updated_at) SELECT 'sci_CancelLater',org_id,'later-digest','later-fingerprint',plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,'associated','cs_CancelLater','sub_CancelLater',created_at,updated_at FROM stripe_subscription_checkout_intents WHERE id='sci_CancelOriginal'`,
      );
      await x.f.sql.run(
        `INSERT INTO stripe_billing_associations(subscription_id,org_id,customer_id,livemode,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,session_id,association_generation,created_at) SELECT 'sub_CancelLater',org_id,customer_id,livemode,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,'cs_CancelLater',2,created_at FROM stripe_billing_associations WHERE subscription_id=?`,
        [x.association.subscriptionId],
      );
      const before = await x.snapshot();
      expect((await e.firstDispatch(x.createdAt)).status).toBe("held-original-get-only");
      expect(await x.snapshot()).toEqual(before);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: pending release slot generation is an actual acceptance guard`, async () => {
    const x = await setup(rp, "pending-plan-change");
    try {
      await x.f.sql.run("UPDATE stripe_billing_plan_change_slots SET generation=4 WHERE org_id=?", [
        x.action.organizationId,
      ]);
      const before = await x.snapshot();
      expect((await x.make(x.release).accept()).status).toBe("held-original-get-only");
      expect(await x.snapshot()).toEqual(before);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: verified release without its required original term revocation cannot open native acceptance`, async () => {
    const x = await setup(rp, "pending-plan-change");
    try {
      await releaseAll(x);
      await x.verifiedRelease();
      x.f.db.exec("DROP TRIGGER stripe_billing_subscription_term_revocations_no_delete");
      await x.f.sql.run(
        "DELETE FROM stripe_billing_subscription_term_revocations WHERE reference=?",
        [x.action.reference],
      );
      const before = await x.snapshot();
      expect((await x.make(x.native()).accept()).status).toBe("held-original-get-only");
      expect(await x.snapshot()).toEqual(before);
    } finally {
      x.f.close();
    }
  });
  test(`${lane}: read-first and mutable-port replacement cannot dispatch`, async () => {
    const x = await setup(rp);
    try {
      const e = x.make();
      await e.readOriginal();
      const calls = x.f.batches.length;
      expect((await e.accept()).status).toBe("held-original-get-only");
      expect(x.f.batches.length).toBe(calls);
      const next = x.make();
      expect((await next.accept()).status).toBe("own-phase-ack-data");
      const batches = x.f.batches.length,
        old = x.f.raw.query;
      x.f.raw.query = async () => [];
      try {
        expect((await next.firstDispatch(x.createdAt)).status).toBe("held-original-get-only");
        expect(x.f.batches.length).toBe(batches);
      } finally {
        x.f.raw.query = old;
      }
    } finally {
      x.f.close();
    }
  });
  for (const at of ["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"]) {
    test(`${lane}: native canonical extended-year Clock ${at} remains original metadata`, async () => {
      const x = await setup(rp);
      try {
        const base = x.native();
        if (base.kind !== "native") throw Error("wrong fixture");
        const q = { ...base, original: { ...base.original, createdAt: at, updatedAt: at } },
          e = x.make(q);
        expect((await e.accept()).status).toBe("own-phase-ack-data");
        const back = at.startsWith("+")
          ? "-000001-01-01T00:00:00.000Z"
          : "+010000-01-01T00:00:00.000Z";
        expect((await e.firstDispatch(back)).status).toBe("own-phase-ack-data");
        const rows = await x.snapshot();
        expect(rows.native[0]?.created_at).toBe(at);
        expect(rows.native[0]?.updated_at).toBe(back);
        expect(
          rows.history.find((r) => r.phase === "cancel-native-first-dispatch")
            ?.previous_receipt_ref,
        ).toBe(q.acceptanceReceiptRef);
      } finally {
        x.f.close();
      }
    });
  }
  for (const branch of ["legacy", "pending-plan-change"] as const) {
    test(`${lane}: ${branch} 32768-byte R1 body stays original while A keeps only six metadata fields`, async () => {
      const text = "あ".repeat(10922) + "ab",
        x = await setup(rp, branch, text);
      try {
        const joined = await x.f.store.readJoinedRetainedR1Data(x.consent.challengeRef);
        if (joined.status !== "found") throw Error("missing full R1 original");
        expect(new TextEncoder().encode(text).byteLength).toBe(32768);
        expect(joined.original.selectedTerms).toEqual(x.r1.original.selectedTerms);
        expect(joined.original.selectedTerms.bodyByteLength).toBe(32768);
        const body = base64UrlDecode(joined.original.selectedTerms.bodyUtf8Base64url);
        expect(body?.byteLength).toBe(32768);
        if (!body) throw Error("missing original body");
        expect(new TextDecoder("utf-8", { fatal: true }).decode(body)).toBe(text);
        const raw = await x.f.raw.query(
          "SELECT ro.command_json,rr.command_json AS receipt_command,ro.terms_ref,ro.terms_digest FROM financial_retained_r1_originals ro JOIN financial_retained_r1_receipts rr ON rr.r1_ref=ro.r1_ref WHERE ro.r1_ref=?",
          [x.r1.key.r1Ref],
        );
        expect(raw).toHaveLength(1);
        expect(raw[0]?.command_json).toBe(raw[0]?.receipt_command);
        expect(JSON.parse(String(raw[0]?.command_json)).original.selectedTerms).toEqual(
          x.r1.original.selectedTerms,
        );
        expect(raw[0]?.terms_ref).toBe(joined.original.selectedTerms.ref);
        expect(raw[0]?.terms_digest).toBe(joined.original.selectedTerms.digest);
        const a = (
          await x.f.raw.query(
            "SELECT selection_json,length(CAST(selection_json AS BLOB)) AS bytes FROM shared_customer_challenges WHERE challenge_ref=?",
            [x.consent.challengeRef],
          )
        )[0];
        const selected = JSON.parse(String(a?.selection_json)).selectedTerms;
        expect(Object.keys(selected).sort()).toEqual([
          "bodyByteLength",
          "digest",
          "digestRecipe",
          "locale",
          "mediaType",
          "ref",
        ]);
        expect(selected.bodyUtf8Base64url).toBeUndefined();
        expect(a?.bytes).toBeLessThanOrEqual(16384);
        const provider = x.f.providerRequests,
          clocks = x.f.clocks;
        if (branch === "pending-plan-change") {
          await releaseAll(x);
          await x.verifiedRelease();
          const native = x.make(x.native());
          expect((await native.accept()).status).toBe("own-phase-ack-data");
          expect((await native.firstDispatch(x.createdAt)).status).toBe("own-phase-ack-data");
        } else {
          const e = x.make();
          expect((await e.accept()).status).toBe("own-phase-ack-data");
          expect((await e.firstDispatch(x.createdAt)).status).toBe("own-phase-ack-data");
        }
        expect(x.f.providerRequests).toBe(provider);
        expect(x.f.clocks).toBe(clocks);
      } finally {
        x.f.close();
      }
    });
    test(`${lane}: ${branch} JSON-string metadata alias cannot stand for the retained selection object`, async () => {
      const x = await setup(rp, branch, undefined, "json-string");
      try {
        const a = (
          await x.f.raw.query(
            "SELECT selection_json FROM shared_customer_challenges WHERE challenge_ref=?",
            [x.consent.challengeRef],
          )
        )[0];
        const selected = JSON.parse(String(a?.selection_json)).selectedTerms;
        expect(typeof selected).toBe("string");
        expect(canonicalJson(JSON.parse(selected))).toBe(selected);
        const terms = x.r1.original.selectedTerms;
        expect(selected).toBe(
          canonicalJson({
            ref: terms.ref,
            digest: terms.digest,
            mediaType: terms.mediaType,
            locale: terms.locale,
            bodyByteLength: terms.bodyByteLength,
            digestRecipe: terms.digestRecipe,
          }),
        );
        const before = await x.snapshot(),
          provider = x.f.providerRequests,
          clocks = x.f.clocks;
        expect((await x.make().accept()).status).toBe("held-original-get-only");
        expect(await x.snapshot()).toEqual(before);
        expect(x.f.providerRequests).toBe(provider);
        expect(x.f.clocks).toBe(clocks);
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
    ] as const) {
      test(`${lane}: ${branch} A metadata ${field} from another retained selection cannot admit cancel`, async () => {
        const x = await setup(rp, branch, undefined, field);
        try {
          const original = await x.f.store.readJoinedRetainedR1Data(x.consent.challengeRef);
          expect(original.status).toBe("found");
          const before = await x.snapshot(),
            provider = x.f.providerRequests,
            clocks = x.f.clocks;
          expect((await x.make().accept()).status).toBe("held-original-get-only");
          expect(await x.snapshot()).toEqual(before);
          expect(x.f.providerRequests).toBe(provider);
          expect(x.f.clocks).toBe(clocks);
        } finally {
          x.f.close();
        }
      });
    }
  }
}
