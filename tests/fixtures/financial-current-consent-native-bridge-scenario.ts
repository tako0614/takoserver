import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { moneyFenceInstallSql } from "../../scripts/deploy/schema-money-unit-cutover.ts";
import { verifyHostedBillingFinancialRealm } from "../../src/hosted-billing-realm.ts";
import { canonicalJson } from "../../src/json.ts";
import { moneyCutoverStripeCustomerGuardDefinitions } from "../../src/money-cutover-sql.ts";
import type { Row, SqlParam, SqlStatement, SqlWrite } from "../../src/ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../../src/shared-auth-oidc-client.ts";
import { customerAdmissionCandidate } from "../../src/shared-financial-admission.ts";
import { prepareConsentBatch } from "../../src/shared-financial-consent-data.ts";
import type { CustomerPhaseInput } from "../../src/shared-financial-customer-dispatch.ts";
import {
  completedCustomerReceiptReadStatement,
  readCustomerJournalSnapshot,
} from "../../src/shared-financial-customer-journal.ts";
import { customerTrackedOriginalReadStatement } from "../../src/shared-financial-customer-tracked-execution.ts";
import type { D1DatabaseLike, D1ResultLike, D1StatementLike } from "../../src/sql-d1.ts";
import { createStripeBillingClient } from "../../src/stripe-billing-client.ts";
import {
  assertWorkerRequestFinancialSqlOrigin,
  batchWorkerRequestFinancialCurrentConsentOriginal,
  captureWorkerSharedAuthStaging,
  createWorkerRequestConsumers,
  createWorkerRequestSql,
  queryWorkerRequestFinancialCurrentConsentOriginal,
  readWorkerRequestFinancialInputs,
  type WorkerRequestDatabase,
} from "../../src/worker-request-composition.ts";
import { fixture as customerFixture } from "./financial-customer-five-action-fixture.ts";

// Real Worker requestOrigins, Money wrapper, raw D1 adapter, Financial inputs,
// and native receiver over one local SQLite primary. The RP/R1 source is not
// mounted here; this file cannot qualify a selected positive Customer action.
const writerEpoch = `sha256:${createHash("sha256").update("writer").digest("hex")}`;
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const issuerRef = "shared-financial-action-consent-rp";
const issuerDigest = digest("synthetic-issuer");
const issuerJson = canonicalJson({
  version: "takoserver-shared-financial-action-consent-issuer-v1",
  registrationRef: issuerRef,
  incarnation: "1",
  purpose: "rp-explicit-action-consent",
});
let synthetic: {
  connection: unknown;
  current: unknown;
  consent: unknown;
  retained: unknown;
  port: unknown;
  context: unknown;
  captures: unknown;
  rp: SqlStatement;
  root: SqlStatement;
} | null = null;

// Only the unmounted credential, R1 and RP provenance boundaries are synthetic.
// The request constructors, private Financial mint/static reader, Root's literal
// receiver and raw request-origin backing remain the actual production functions.
const originalWorker = await import("../../src/worker-request-composition.ts");
const actualRootQuery = originalWorker.queryWorkerRequestFinancialCurrentConsentOriginal;
const actualRootBatch = originalWorker.batchWorkerRequestFinancialCurrentConsentOriginal;
const originalAuth = await import("../../src/financial-auth-consumer.ts");
const originalR1 = await import("../../src/shared-financial-retained-r1.ts");
const originalConsent = await import("../../src/shared-auth-financial-consent.ts");
const originalContract = await import("../../src/shared-auth-financial-consent-contract.ts");
const originalStore = await import("../../src/shared-auth-financial-consent-store.ts");
interface NativeTrace {
  readonly reads: {
    readonly statement: SqlStatement;
    readonly underlying: SqlWrite;
    readonly result: D1ResultLike;
  }[];
  readonly batches: {
    readonly statements: readonly SqlStatement[];
    readonly underlying: readonly SqlWrite[];
    readonly results: readonly D1ResultLike[];
  }[];
}
const nativeTraces = new WeakMap<object, NativeTrace>();
const receiverOperations: (
  | {
      readonly connection: unknown;
      readonly operation: Parameters<typeof actualRootQuery>[1];
      readonly kind: "query";
      readonly result: readonly Row[];
      readonly nativeReads: NativeTrace["reads"];
    }
  | {
      readonly connection: unknown;
      readonly operation: Parameters<typeof actualRootBatch>[1];
      readonly kind: "batch";
      readonly result: readonly SqlWrite[];
      readonly nativeBatches: NativeTrace["batches"];
    }
)[] = [];
function selected() {
  if (!synthetic) throw new Error("synthetic boundary not selected");
  return synthetic;
}
mock.module("../../src/worker-request-composition.ts", () => ({
  ...originalWorker,
  async queryWorkerRequestFinancialCurrentConsentOriginal(
    ...args: Parameters<typeof originalWorker.queryWorkerRequestFinancialCurrentConsentOriginal>
  ) {
    const trace = nativeTraces.get(args[0]);
    const before = trace?.reads.length ?? 0;
    const result = await actualRootQuery(...args);
    receiverOperations.push({
      connection: args[0],
      operation: args[1],
      kind: "query",
      result,
      nativeReads: trace?.reads.slice(before) ?? [],
    });
    return result;
  },
  async batchWorkerRequestFinancialCurrentConsentOriginal(
    ...args: Parameters<typeof originalWorker.batchWorkerRequestFinancialCurrentConsentOriginal>
  ) {
    const trace = nativeTraces.get(args[0]);
    const before = trace?.batches.length ?? 0;
    const result = await actualRootBatch(...args);
    receiverOperations.push({
      connection: args[0],
      operation: args[1],
      kind: "batch",
      result,
      nativeBatches: trace?.batches.slice(before) ?? [],
    });
    return result;
  },
  readWorkerRequestRetainedRpCapture: (connection: unknown) => {
    if (connection !== selected().connection) throw new Error("foreign credential connection");
    return selected().retained;
  },
}));
mock.module("../../src/financial-auth-consumer.ts", () => ({
  ...originalAuth,
  readWorkerRequestFinancialAuthConsumerPort: (connection: unknown) =>
    connection === selected().connection ? selected().port : null,
  readWorkerRequestFinancialAuthConsumerContext: (connection: unknown) =>
    connection === selected().connection ? selected().context : null,
  assertFinancialAuthConsumerPort: () => undefined,
  financialAuthConsumerSourceCurrentness: () => selected().root,
}));
mock.module("../../src/shared-financial-retained-r1.ts", () => ({
  ...originalR1,
  readFinancialActionConsentR1RequestCaptures: () => selected().captures,
}));
mock.module("../../src/shared-auth-financial-consent.ts", () => ({
  ...originalConsent,
  readSharedAuthFinancialConsentCurrentOriginalData: () => selected().current,
}));
mock.module("../../src/shared-auth-financial-consent-contract.ts", () => ({
  ...originalContract,
  parseSharedAuthFinancialActionConsentOriginal: async () => selected().consent,
}));
mock.module("../../src/shared-auth-financial-consent-store.ts", () => ({
  ...originalStore,
  sharedAuthFinancialConsentLocalCurrentnessStatement: async () => selected().rp,
}));
const {
  createFinancialCurrentConsentCustomerExecutor,
  readFinancialCurrentConsentCustomerOperationOriginal,
} = await import("../../src/financial-current-consent-customer.ts");

function mechanicalRp(): SqlStatement {
  const params = Array.from({ length: 81 }, (_, index) =>
    [2, 17, 24, 39, 43].includes(index)
      ? new Uint8Array([index, 0, 255]).buffer
      : index === 80
        ? 1
        : `retained:${index}`,
  );
  const terms = params.map((_, index) => (index === 80 ? "?=1" : "? IS NOT NULL"));
  function balance(items: readonly string[]): string {
    if (items.length === 1) return items[0] ?? "0";
    const middle = Math.floor(items.length / 2);
    return `(${balance(items.slice(0, middle))} AND ${balance(items.slice(middle))})`;
  }
  return { sql: `SELECT 1 AS original WHERE ${balance(terms)}`, params };
}

async function requestFixture() {
  const f = await customerFixture(true);
  f.db.exec(moneyFenceInstallSql("0094"));
  // Root's guarded 0104 chain installs the Money guard's Stripe customer generation.
  for (const [, sql] of moneyCutoverStripeCustomerGuardDefinitions()) f.db.exec(sql);
  const observed = { primary: 0, root: 0, reads: 0, batches: 0 };
  const batchSizes: number[] = [];
  const nativeTrace: NativeTrace = { reads: [], batches: [] };
  let loseNextAcknowledgement = false;
  const statements = new WeakMap<D1StatementLike, SqlStatement>();
  function statement(sql: string, params: readonly SqlParam[] = []): D1StatementLike {
    const selected: SqlStatement = Object.freeze({ sql, params: Object.freeze([...params]) });
    const prepared: D1StatementLike = Object.freeze({
      bind(...values: readonly SqlParam[]) {
        return statement(sql, values);
      },
      async all(): Promise<D1ResultLike> {
        observed.reads++;
        const underlying = await f.sql.run(selected.sql, selected.params);
        const result = {
          success: true,
          results: underlying.rows,
          meta: { changes: underlying.changes },
        };
        nativeTrace.reads.push({ statement: selected, underlying, result });
        return result;
      },
    });
    statements.set(prepared, selected);
    return prepared;
  }
  const session: D1DatabaseLike = Object.freeze({
    prepare: statement,
    async batch(prepared: readonly D1StatementLike[]): Promise<readonly D1ResultLike[]> {
      observed.batches++;
      batchSizes.push(prepared.length);
      const selected = prepared.map((item) => {
        const original = statements.get(item);
        if (!original) throw new Error("statement left its primary session");
        return original;
      });
      const underlying = await f.sql.batch(selected);
      if (loseNextAcknowledgement) {
        loseNextAcknowledgement = false;
        throw new Error("synthetic ACK lost after committed primary batch");
      }
      const results = underlying.map((item) => ({
        success: true,
        results: item.rows,
        meta: { changes: item.changes },
      }));
      nativeTrace.batches.push({ statements: selected, underlying, results });
      return results;
    },
  });
  const database: WorkerRequestDatabase = Object.freeze({
    prepare(): never {
      observed.root++;
      throw new Error("root binding used");
    },
    async batch(): Promise<never> {
      observed.root++;
      throw new Error("root binding used");
    },
    withSession(constraint: "first-primary") {
      expect(constraint).toBe("first-primary");
      observed.primary++;
      return session;
    },
  });
  try {
    const connection = await createWorkerRequestSql({
      database,
      writerEpoch,
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    });
    nativeTraces.set(connection, nativeTrace);
    const client = createStripeBillingClient({
      secretKey: "sk_test_native_bridge_fixture",
      mode: "test",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method !== "GET") throw new Error("processor mutation forbidden");
        if (path === "/v1/account")
          return Response.json({ id: "acct_synthetic", object: "account" });
        if (path === "/v1/prices/price_synthetic")
          return Response.json({
            id: "price_synthetic",
            object: "price",
            livemode: false,
            currency: "usd",
            type: "recurring",
            billing_scheme: "per_unit",
            unit_amount: 1000,
            recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
          });
        throw new Error("unexpected processor read");
      },
    });
    const realm = await verifyHostedBillingFinancialRealm({
      sql: connection.sql,
      reader: { client },
      expected: {
        accountId: "acct_synthetic",
        mode: "test",
        billingAuthority: "authority.synthetic",
      },
      prices: [{ priceId: "price_synthetic", monthlyAmountMinor: 1000 }],
    });
    const sharedAuth = captureWorkerSharedAuthStaging({
      kind: "shared-auth-staging-v1",
      clientSecret: "unused-native-bridge-fixture",
      encryptionKey: new Uint8Array(32).fill(8),
      principals: {
        async resolve(): Promise<never> {
          throw new Error("synthetic RP boundary not mounted");
        },
      },
    });
    createWorkerRequestConsumers({
      connection,
      sql: connection.sql,
      client,
      realm,
      sharedAuth,
      identity: {
        async verify(): Promise<never> {
          throw new Error("synthetic identity boundary not mounted");
        },
      },
      clock: () => new Date(),
      randomId: () => crypto.randomUUID(),
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    });
    return {
      f,
      connection,
      observed,
      batchSizes,
      nativeTrace,
      loseAck() {
        loseNextAcknowledgement = true;
      },
      inputs: readWorkerRequestFinancialInputs(connection),
    };
  } catch (error) {
    f.close();
    throw error;
  }
}

test("actual request primary rejects fabricated Financial tokens without SQL effects", async () => {
  const { f, connection, observed, inputs } = await requestFixture();
  try {
    expect(inputs.sql).toBe(connection.sql);
    expect(inputs.writerEpoch).toBe(writerEpoch);
    expect(observed.primary).toBe(1);
    const before = { ...observed };
    const admissionsBefore = await f.sql.query("SELECT * FROM financial_customer_admissions");
    await expect(
      queryWorkerRequestFinancialCurrentConsentOriginal(connection, Object.freeze({}) as never),
    ).rejects.toThrow();
    await expect(
      batchWorkerRequestFinancialCurrentConsentOriginal(connection, Object.freeze({}) as never),
    ).rejects.toThrow();
    let accessed = 0;
    const forged = Object.defineProperty(Object.create(null), "kind", {
      get() {
        accessed++;
        throw new Error("forged getter inspected");
      },
    });
    await expect(
      queryWorkerRequestFinancialCurrentConsentOriginal(connection, forged as never),
    ).rejects.toThrow();
    await expect(
      batchWorkerRequestFinancialCurrentConsentOriginal(
        connection,
        Object.freeze({ kind: "phase-batch", phase: "L1" }) as never,
      ),
    ).rejects.toThrow();
    expect(accessed).toBe(0);
    expect(observed).toEqual(before);
    expect(await f.sql.query("SELECT * FROM financial_customer_admissions")).toEqual(
      admissionsBefore,
    );
    expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
  } finally {
    f.close();
  }
});

async function selectedCustomerCase(request: Awaited<ReturnType<typeof requestFixture>>) {
  const { f, connection, inputs } = request;
  const record = f.input.auth.credential;
  if (record.backend !== "shared-rp-session") throw new Error("RP fixture expected");
  const terms = {
    ref: "terms:native-bridge",
    digest: digest("terms:native-bridge"),
    mediaType: "text/plain",
    locale: "ja",
    bodyByteLength: 6,
    digestRecipe: "financial-terms-utf8-sha256-v1",
  };
  const input = {
    ...f.input,
    challengeRef: "challenge:native-bridge",
    grantRef: "grant:native-bridge",
    grantIncarnation: "grant-inc:native-bridge",
    consentRegistrationRef: issuerRef,
    consentIncarnation: "1",
    consentRef: "consent-original:native-bridge",
    consentProofRef: "consent-proof:native-bridge",
    consentDigest: digest("consent-proof:native-bridge"),
    issuanceAttempt: "attempt:native-bridge",
    receiptRef: "consent-receipt:native-bridge",
  };
  await f.challenge(input);
  // The shared Customer fixture fixes its old selectedTerms vector. Replace
  // only this synthetic seed before testing, then restore the exact trigger.
  const trigger = f.db
    .query(
      "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='shared_customer_challenges_no_update'",
    )
    .get() as { sql: string } | null;
  if (!trigger) throw new Error("challenge immutability trigger missing");
  f.db.exec("DROP TRIGGER shared_customer_challenges_no_update");
  try {
    await f.sql.run(
      "UPDATE shared_customer_challenges SET selection_json=json_set(selection_json,'$.selectedTerms',json(?)) WHERE challenge_ref=?",
      [canonicalJson(terms), input.challengeRef],
    );
  } finally {
    f.db.exec(trigger.sql);
  }
  await f.consentWriter.batch(prepareConsentBatch(input, f.org));
  const admission = await customerAdmissionCandidate(
    { action: f.action, consent: input, selectedTerms: terms },
    f.identity,
    f.original,
    f.at,
  );
  const challengeRow = (
    await f.sql.query(
      "SELECT challenge_json FROM shared_customer_challenges WHERE challenge_ref=?",
      [input.challengeRef],
    )
  )[0];
  if (!challengeRow || typeof challengeRow.challenge_json !== "string")
    throw new Error("seeded challenge missing");
  const challenge = JSON.parse(challengeRow.challenge_json) as Record<string, unknown>;
  const source = {
    ref: "action-source:native-bridge",
    digest: digest("action-source:native-bridge"),
    registrationRef: f.registration.registrationRef,
    incarnation: f.registration.incarnation,
  };
  const r1 = {
    original: {
      challengeRef: input.challengeRef,
      c0: {
        challenge,
        selection: {
          customer: {
            idempotencyKey: f.original.key,
            requestFingerprint: f.original.fingerprint,
            financialRealm: inputs.realm.financialRealm,
          },
        },
      },
    },
    actionIdentity: f.identity,
    selectedTerms: terms,
    actionSource: source,
    scopeRealm: {
      writerEpoch,
      financialRealm: inputs.realm.financialRealm,
      organizationId: f.org,
      workspaceId: "workspace:synthetic",
      workspaceRef: "workspace-ref:synthetic",
    },
  };
  const now = Date.now();
  const retained = {
    record,
    current: f.input.auth.current,
    finalSession: record.rp,
  };
  const principal = { binding: f.input.auth.human };
  const credentialCapture = Object.freeze({});
  const userBindingCapture = Object.freeze({});
  const port = Object.freeze({
    readValidatedCredential: () => ({
      backend: "shared-rp-session",
      record,
      current: f.input.auth.current,
    }),
    readValidatedPrincipalBinding: () => principal,
  });
  const consent = {
    consentRef: input.consentProofRef,
    consentDigest: input.consentDigest,
    consentIssuer: {
      registrationRef: issuerRef,
      registrationDigest: issuerDigest,
      incarnation: "1",
    },
    challenge,
    actionRequestFingerprint: input.requestFingerprint,
    identityEvidence: { kind: "financial-proof", proofRef: input.identityProofRef },
    action: f.action,
    selectedTerms: terms,
    source,
    path: {
      organizationId: f.org,
      workspaceId: "workspace:synthetic",
      workspaceRef: "workspace-ref:synthetic",
    },
    financialRealmRef: inputs.realm.financialRealm,
    rpSession: {
      sessionDigest: record.rp.sessionDigest,
      accountId: record.rp.accountId,
      observedPrincipalId: f.input.auth.human.principalId,
    },
    principalBinding: {
      ref: f.input.auth.human.ref,
      digest: f.input.auth.human.evidence.digest,
      incarnation: f.input.auth.human.controllerIncarnation,
    },
    credentialClass: {
      ref: record.origin.ref,
      digest: record.origin.issuanceDigest,
      incarnation: record.origin.incarnation,
    },
    acceptedAt: now - 60_000,
    expiresAt: now + 300_000,
  };
  await f.sql.run(
    "CREATE TABLE shared_auth_financial_consent_issuer_registrations (registration_ref TEXT PRIMARY KEY,incarnation TEXT,registration_digest TEXT,original_json TEXT)",
  );
  await f.sql.run(
    "INSERT INTO shared_auth_financial_consent_issuer_registrations VALUES(?,?,?,?)",
    [issuerRef, "1", issuerDigest, issuerJson],
  );
  await f.sql.run(
    "CREATE TABLE shared_auth_financial_consent_pending (transaction_ref TEXT PRIMARY KEY,challenge_ref TEXT,action_kind TEXT,action_ref TEXT,request_fingerprint TEXT,organization_id TEXT,workspace_id TEXT,workspace_ref TEXT)",
  );
  await f.sql.run("INSERT INTO shared_auth_financial_consent_pending VALUES(?,?,?,?,?,?,?,?)", [
    "transaction:native-bridge",
    input.challengeRef,
    f.action.kind,
    f.action.reference,
    input.requestFingerprint,
    f.org,
    "workspace:synthetic",
    "workspace-ref:synthetic",
  ]);
  synthetic = {
    connection,
    current: {
      sampledAt: now,
      original: {
        originalBytes: new Uint8Array(0),
        recordedAt: now - 1_000,
        receiptRef: "rp-receipt:native-bridge",
        command: {
          key: { consentRef: input.consentProofRef, transactionRef: "transaction:native-bridge" },
        },
      },
    },
    consent,
    retained,
    port,
    context: { sql: inputs.sql, realm: inputs.realm, writerEpoch },
    captures: { credential: credentialCapture, userBinding: userBindingCapture },
    rp: mechanicalRp(),
    root: {
      // Synthetic Root currentness; like the actual Auth103 predicate it names no
      // money_cutover_* table, so Root's Money writer can send the guarded receipt.
      sql: `EXISTS(SELECT 1 FROM shared_customer_challenges WHERE writer_epoch=?)${" AND ? IS NOT NULL".repeat(9)}`,
      params: [writerEpoch, ...Array(9).fill("synthetic-root")],
    },
  };
  const handler = {};
  const actionRequest = new Request("https://fixture.invalid/native-customer");
  const witness = {};
  const r1Reader = {};
  const createExecutor = () =>
    createFinancialCurrentConsentCustomerExecutor(
      connection,
      handler,
      actionRequest,
      "workspace:synthetic",
      witness,
      r1Reader,
      r1 as never,
    );
  const executor = createExecutor();
  const l1: CustomerPhaseInput = {
    phase: "L1",
    admission,
    history: f.journal,
    writerEpoch,
    couplingAttemptRef: "native-bridge:L1",
    entryRef: "native-bridge-entry:L1",
    historyReceiptRef: "native-bridge-history:L1",
  };
  return { executor, createExecutor, l1, admission, input };
}

test("synthetic RP/R1 selection reaches actual Financial mint and Root native L1 batch", async () => {
  const request = await requestFixture();
  const foreign = await requestFixture();
  try {
    const before = { ...request.observed };
    expect(() =>
      assertWorkerRequestFinancialSqlOrigin(request.connection, request.inputs.sql),
    ).not.toThrow();
    expect(() =>
      assertWorkerRequestFinancialSqlOrigin(request.connection, foreign.inputs.sql),
    ).toThrow();
    expect(() =>
      assertWorkerRequestFinancialSqlOrigin(request.connection, { ...request.inputs.sql }),
    ).toThrow();
    expect(() =>
      assertWorkerRequestFinancialSqlOrigin({ ...request.connection }, request.inputs.sql),
    ).toThrow();
    expect(request.observed).toEqual(before);
    const { executor, l1, input } = await selectedCustomerCase(request);
    const readsBefore = request.observed.reads;
    const outcome = await executor.executePhase(l1);
    expect(outcome.status).toBe("acknowledged-own-phase-data");
    if (outcome.status !== "acknowledged-own-phase-data") throw new Error("L1 not acknowledged");
    // Seven Customer results; the native batch is Root's permit frame around them.
    expect(outcome.acknowledgement.physicalResults).toHaveLength(7);
    expect(request.batchSizes).toEqual([9]);
    expect(request.observed.reads).toBeGreaterThan(readsBefore);
    expect(request.observed.root).toBe(0);
    const rpReceiptRef = (selected().current as { original: { receiptRef: string } }).original
      .receiptRef;
    expect(input.receiptRef).not.toBe(rpReceiptRef);
    const l1Receipt = await request.f.sql.query(
      "SELECT receipt_ref FROM financial_customer_admission_receipts WHERE receipt_ref=?",
      [l1.admission.receiptRef],
    );
    expect(l1Receipt).toHaveLength(1);
    expect(l1Receipt[0]?.receipt_ref).not.toBe(rpReceiptRef);
    const history = await readCustomerJournalSnapshot(request.f.sql, {
      organizationId: request.f.org,
      realmRegistration: request.f.journal.realmRegistration,
      realmIncarnation: request.f.journal.realmIncarnation,
    });
    if (!history) throw new Error("completed L1 history missing");
    const d: CustomerPhaseInput = {
      phase: "D",
      admission: l1.admission,
      history,
      writerEpoch,
      couplingAttemptRef: "native-bridge:D",
      entryRef: "native-bridge-entry:D",
      historyReceiptRef: "native-bridge-history:D",
      claimRef: "native-bridge-claim:D",
      dispatchAttemptRef: "native-bridge-attempt:D",
      dispatchReceiptRef: "native-bridge-receipt:D",
      dispatchedAt: request.f.at,
    };
    const dispatched = await executor.executePhase(d);
    expect(dispatched.status).toBe("acknowledged-own-phase-data");
    if (dispatched.status !== "acknowledged-own-phase-data") throw new Error("D not acknowledged");
    expect(dispatched.acknowledgement.physicalResults).toHaveLength(6);
    expect(dispatched.acknowledgement.dispatchCasChanges).toBe(1);
    expect(dispatched.acknowledgement.physicalResults[1]).toEqual({
      index: 1,
      changes: 1,
      returnedRows: 0,
    });
    expect(request.batchSizes).toEqual([9, 8]);
    expect(request.observed.primary).toBe(1);
    expect(request.observed.root).toBe(0);
    expect((selected().current as { original: { receiptRef: string } }).original.receiptRef).toBe(
      rpReceiptRef,
    );
    expect(
      await request.f.sql.query(
        "SELECT receipt_ref FROM financial_customer_dispatch_receipts WHERE receipt_ref=?",
        [d.dispatchReceiptRef],
      ),
    ).toHaveLength(1);
    expect(await request.f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
    const captured = receiverOperations.filter((item) => item.connection === request.connection);
    expect(
      [
        ...new Set(
          captured
            .filter((item) => item.kind === "query")
            .map((item) => {
              const original = readFinancialCurrentConsentCustomerOperationOriginal(
                request.connection,
                item.operation,
              );
              return original?.kind;
            }),
        ),
      ].sort(),
    ).toEqual(["completed-receipt-read", "original-read"]);
    expect(captured.filter((item) => item.kind === "batch")).toHaveLength(2);
    const receivedBatches: (readonly SqlWrite[])[] = [];
    for (const { kind, operation } of captured) {
      const first = readFinancialCurrentConsentCustomerOperationOriginal(
        request.connection,
        operation,
      );
      const repeated = readFinancialCurrentConsentCustomerOperationOriginal(
        request.connection,
        operation,
      );
      if (!first || !repeated) throw new Error("valid private operation was not retained");
      if (kind === "batch") expect(first.kind).toBe("phase-batch");
      else expect(["completed-receipt-read", "original-read"]).toContain(first.kind);
      expect(repeated).toEqual(first);
      expect(repeated).not.toBe(first);
      expect(first.requestInputs).toBe(request.inputs);
      expect(first.writerEpoch).toBe(writerEpoch);
      expect(first.original.writerEpoch).toBe(writerEpoch);
      expect(first.original.phase).toBe(first.phase);
      if (first?.kind === "phase-batch" && repeated?.kind === "phase-batch") {
        const receiptIndex = first.phase === "L1" ? 3 : 2;
        const firstBlobs = first.plan.statements[receiptIndex]?.params?.filter(
          (value) => value instanceof ArrayBuffer,
        );
        const repeatBlobs = repeated.plan.statements[receiptIndex]?.params?.filter(
          (value) => value instanceof ArrayBuffer,
        );
        expect(firstBlobs).toHaveLength(5);
        expect(repeatBlobs).toEqual(firstBlobs);
        expect(repeatBlobs?.[0]).not.toBe(firstBlobs?.[0]);
      }
      expect(
        readFinancialCurrentConsentCustomerOperationOriginal(foreign.connection, operation),
      ).toBeNull();
      expect(
        readFinancialCurrentConsentCustomerOperationOriginal(request.connection, {
          ...(operation as object),
        }),
      ).toBeNull();
    }
    for (const item of captured) {
      const original = readFinancialCurrentConsentCustomerOperationOriginal(
        request.connection,
        item.operation,
      );
      if (!original) throw new Error("captured operation lost its original");
      expect(item.connection).toBe(request.connection);
      if (item.kind === "query") {
        if (original.kind === "phase-batch") throw new Error("read operation became batch");
        expect(item.nativeReads).toHaveLength(1);
        const native = item.nativeReads[0];
        if (!native) throw new Error("Root read did not use the native session");
        const phaseOriginal = original.original;
        if (phaseOriginal.phase !== "L1" && phaseOriginal.phase !== "D")
          throw new Error("unexpected Financial phase original");
        const coreReceiptRef =
          phaseOriginal.phase === "L1"
            ? phaseOriginal.admission.receiptRef
            : phaseOriginal.dispatchReceiptRef;
        const expected =
          original.kind === "completed-receipt-read"
            ? completedCustomerReceiptReadStatement(coreReceiptRef)
            : customerTrackedOriginalReadStatement(
                coreReceiptRef,
                original.original.historyReceiptRef,
              );
        expect(original.statement).toEqual(expected);
        expect(native.statement).toEqual(expected);
        expect(native.result.results).toBe(native.underlying.rows);
        expect(item.result).toBe(native.underlying.rows);
      } else {
        if (original.kind !== "phase-batch") throw new Error("batch operation became read");
        expect(item.nativeBatches).toHaveLength(1);
        const native = item.nativeBatches[0];
        if (!native) throw new Error("Root batch did not use the native session");
        // Root's Money writer frames the exact Financial plan with its permit.
        expect(original.plan.statements).toHaveLength(original.phase === "L1" ? 7 : 6);
        for (const statement of original.plan.statements)
          expect(statement.sql).not.toContain("money_cutover_");
        expect(native.statements).toHaveLength(original.plan.statements.length + 2);
        expect(native.statements.slice(1, -1)).toEqual([...original.plan.statements]);
        expect(native.statements[0]?.sql).toStartWith("INSERT INTO money_cutover_writer_permit");
        expect(native.statements.at(-1)?.sql).toStartWith(
          "DELETE FROM money_cutover_writer_permit",
        );
        expect(native.statements[0]?.params).toEqual([writerEpoch]);
        expect(native.statements.at(-1)?.params).toEqual([writerEpoch]);
        expect(native.underlying[0]?.changes).toBe(1);
        expect(native.underlying.at(-1)?.changes).toBe(1);
        if (original.phase === "D") expect(native.underlying[2]?.changes).toBe(1);
        expect(item.result).toHaveLength(native.results.length - 2);
        for (let index = 0; index < native.results.length; index++) {
          expect(native.results[index]?.results).toBe(native.underlying[index]?.rows);
          expect(native.results[index]?.meta?.changes).toBe(native.underlying[index]?.changes);
        }
        for (let index = 0; index < item.result.length; index++) {
          expect(item.result[index]?.rows).toBe(native.underlying[index + 1]?.rows);
          expect(item.result[index]?.changes).toBe(native.underlying[index + 1]?.changes);
        }
        receivedBatches.push(item.result);
      }
    }
    expect(receivedBatches).toHaveLength(2);
    for (const [index, acknowledgement] of [
      outcome.acknowledgement,
      dispatched.acknowledgement,
    ].entries()) {
      const batch = receivedBatches[index];
      if (!batch) throw new Error("Root batch acknowledgement missing");
      expect(
        batch.map((result, statementIndex) => ({
          index: statementIndex,
          changes: result.changes,
          returnedRows: result.rows.length,
        })),
      ).toEqual([...acknowledgement.physicalResults]);
    }
    const completedToken = captured.find(
      (item) =>
        item.kind === "query" &&
        readFinancialCurrentConsentCustomerOperationOriginal(request.connection, item.operation)
          ?.kind === "completed-receipt-read",
    );
    if (!completedToken) throw new Error("completed fixed-read token missing");
    const completedOriginal = readFinancialCurrentConsentCustomerOperationOriginal(
      request.connection,
      completedToken.operation,
    );
    if (completedOriginal?.kind !== "completed-receipt-read")
      throw new Error("completed fixed-read original missing");
    const readsBeforeRepeat = request.nativeTrace.reads.length;
    const batchesBeforeRepeat = request.observed.batches;
    const firstRepeat = await actualRootQuery(request.connection, completedToken.operation);
    expect(request.nativeTrace.reads).toHaveLength(readsBeforeRepeat + 1);
    const secondRepeat = await actualRootQuery(request.connection, completedToken.operation);
    expect(request.nativeTrace.reads).toHaveLength(readsBeforeRepeat + 2);
    const firstNative = request.nativeTrace.reads[readsBeforeRepeat];
    const secondNative = request.nativeTrace.reads[readsBeforeRepeat + 1];
    if (!firstNative || !secondNative) throw new Error("repeated native reads missing");
    expect(firstNative.statement).toEqual(completedOriginal.statement);
    expect(secondNative.statement).toEqual(completedOriginal.statement);
    expect(firstRepeat).toBe(firstNative.underlying.rows);
    expect(secondRepeat).toBe(secondNative.underlying.rows);
    expect(secondRepeat).toEqual(firstRepeat);
    expect(request.observed.batches).toBe(batchesBeforeRepeat);
    expect(request.batchSizes).toEqual([9, 8]);
    const guardedBatches = captured
      .filter((item) => item.kind === "batch")
      .map((item) =>
        readFinancialCurrentConsentCustomerOperationOriginal(request.connection, item.operation),
      );
    expect(
      guardedBatches.map((item) =>
        item?.kind === "phase-batch" ? item.plan.statements.length : -1,
      ),
    ).toEqual([7, 6]);
    expect(
      guardedBatches.map((item) =>
        item?.kind === "phase-batch"
          ? item.plan.statements[item.phase === "L1" ? 3 : 2]?.params?.length
          : -1,
      ),
    ).toEqual([97, 99]);
  } finally {
    synthetic = null;
    request.f.close();
    foreign.f.close();
  }
});

test("committed L1 with lost ACK recovers its original by GET without another batch", async () => {
  const request = await requestFixture();
  try {
    const { executor, createExecutor, l1 } = await selectedCustomerCase(request);
    request.loseAck();
    const unknown = await executor.executePhase(l1);
    expect(unknown.status).toBe("get-only");
    if (unknown.status !== "get-only") throw new Error("ACK unexpectedly accepted");
    expect(unknown.reason).toBe("batch-outcome-unknown");
    expect(request.batchSizes).toEqual([9]);
    expect(
      await request.f.sql.query(
        "SELECT receipt_ref FROM financial_customer_admission_receipts WHERE receipt_ref=?",
        [l1.admission.receiptRef],
      ),
    ).toHaveLength(1);
    const recovered = await executor.readOriginal(l1);
    expect(recovered.status).toBe("get-only");
    expect(recovered.observation.status).toBe("matching-original");
    expect(canonicalJson(recovered.original)).toBe(canonicalJson(l1));
    expect(request.batchSizes).toEqual([9]);
    const replacement = createExecutor();
    const denied = await replacement.executePhase(l1);
    expect(denied.status).toBe("get-only");
    expect(denied.observation.status).toBe("matching-original");
    expect(request.batchSizes).toEqual([9]);
    expect(request.observed.primary).toBe(1);
    expect(request.observed.root).toBe(0);
  } finally {
    synthetic = null;
    request.f.close();
  }
});

test("an unfenced Customer shape refuses the L1 write before Root's receiver sends a batch", async () => {
  const request = await requestFixture();
  try {
    const { executor, l1 } = await selectedCustomerCase(request);
    // One missing Customer fence is not the exact fenced 0104 shape.
    request.f.db.exec("DROP TRIGGER financial_customer_history_entries_money_fence");
    const outcome = await executor.executePhase(l1);
    expect(outcome.status).toBe("get-only");
    expect(request.batchSizes).toEqual([]);
    expect(
      receiverOperations.filter(
        (item) => item.connection === request.connection && item.kind === "batch",
      ),
    ).toEqual([]);
    expect(await request.f.sql.query("SELECT * FROM financial_customer_admissions")).toEqual([]);
    expect(await request.f.sql.query("SELECT * FROM stripe_billing_customer_commands")).toEqual([]);
    expect(await request.f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
  } finally {
    synthetic = null;
    request.f.close();
  }
});
