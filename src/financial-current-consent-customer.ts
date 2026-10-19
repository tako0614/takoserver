import { assertFinancial0104CustomerWriteShape } from "./financial-0104-customer-schema.ts";
import {
  assertFinancialAuthConsumerPort,
  type FinancialAuthConsumerContext,
  type FinancialAuthConsumerPort,
  financialAuthConsumerSourceCurrentness,
  readWorkerRequestFinancialAuthConsumerContext,
  readWorkerRequestFinancialAuthConsumerPort,
} from "./financial-auth-consumer.ts";
import { canonicalJson } from "./json.ts";
import { assertMoneyCutoverSqlOrigin } from "./money-cutover-sql.ts";
import type { Row, Sql, SqlParam, SqlStatement, SqlWrite } from "./ports.ts";
import { readSharedAuthFinancialConsentCurrentOriginalData } from "./shared-auth-financial-consent.ts";
import { parseSharedAuthFinancialActionConsentOriginal } from "./shared-auth-financial-consent-contract.ts";
import {
  type SharedAuthFinancialConsentPendingData,
  sharedAuthFinancialConsentLocalCurrentnessStatement,
} from "./shared-auth-financial-consent-store.ts";
import { guardCustomerConsentReceipt } from "./shared-financial-current-consent-cas.ts";
import type {
  CustomerPhaseInput,
  CustomerPhasePlan,
} from "./shared-financial-customer-dispatch.ts";
import { compileCustomerPhase } from "./shared-financial-customer-dispatch.ts";
import { completedCustomerReceiptReadStatement } from "./shared-financial-customer-journal.ts";
import {
  captureCustomerTrackedPhaseOriginal,
  createCustomerTrackedExecutionData,
  customerTrackedOriginalReadStatement,
} from "./shared-financial-customer-tracked-execution.ts";
import {
  type FinancialActionConsentR1Original,
  readFinancialActionConsentR1RequestCaptures,
} from "./shared-financial-retained-r1.ts";
import { createStripeCustomerOriginalDefinition } from "./stripe-customer-custody.ts";
import {
  batchWorkerRequestFinancialCurrentConsentOriginal,
  queryWorkerRequestFinancialCurrentConsentOriginal,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  readWorkerRequestRetainedRpCapture,
  type WorkerRequestFinancialInputs,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";

function unavailable(): never {
  throw new TypeError("financial current consent customer unavailable");
}

// Deny only. Unknown batch/ACK on one connection is GET-only, including a new factory.
const attempted = new WeakMap<WorkerRequestSql, Set<string>>();

declare const financialCurrentConsentCustomerOperationBrand: unique symbol;
export type FinancialCurrentConsentCustomerOperation = Readonly<{
  [financialCurrentConsentCustomerOperationBrand]: true;
}>;
export type FinancialCurrentConsentCustomerOperationOriginal =
  | Readonly<{
      kind: "completed-receipt-read" | "original-read";
      requestInputs: WorkerRequestFinancialInputs;
      phase: "L1" | "D";
      writerEpoch: string;
      original: CustomerPhaseInput;
      statement: SqlStatement;
    }>
  | Readonly<{
      kind: "phase-batch";
      requestInputs: WorkerRequestFinancialInputs;
      phase: "L1" | "D";
      writerEpoch: string;
      original: CustomerPhaseInput;
      plan: CustomerPhasePlan;
    }>;
export type FinancialCurrentConsentNativeOriginal =
  | Readonly<{
      kind: "query";
      operationKind: "completed-receipt-read" | "original-read";
      connection: WorkerRequestSql;
      inputs: WorkerRequestFinancialInputs;
      phase: "L1" | "D";
      writerEpoch: string;
      original: CustomerPhaseInput;
      statement: SqlStatement;
    }>
  | Readonly<{
      kind: "batch";
      connection: WorkerRequestSql;
      inputs: WorkerRequestFinancialInputs;
      phase: "L1" | "D";
      writerEpoch: string;
      original: CustomerPhaseInput;
      plan: CustomerPhasePlan;
    }>;
const operationOrigins = new WeakMap<
  FinancialCurrentConsentCustomerOperation,
  {
    readonly connection: WorkerRequestSql;
    readonly assertOrigin: () => void;
    readonly original: FinancialCurrentConsentCustomerOperationOriginal;
  }
>();

function cloneStatement(statement: SqlStatement): SqlStatement {
  return Object.freeze({
    sql: statement.sql,
    ...(statement.params === undefined
      ? {}
      : {
          params: Object.freeze(
            statement.params.map((value) =>
              value instanceof ArrayBuffer ? value.slice(0) : value,
            ),
          ),
        }),
  });
}

function sameStatement(left: SqlStatement, right: SqlStatement): boolean {
  if (left.sql !== right.sql) return false;
  const a = left.params ?? [];
  const b = right.params ?? [];
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const value = a[index];
    const expected = b[index];
    if (value instanceof ArrayBuffer || expected instanceof ArrayBuffer) {
      if (!(value instanceof ArrayBuffer) || !(expected instanceof ArrayBuffer)) return false;
      const x = new Uint8Array(value);
      const y = new Uint8Array(expected);
      if (x.length !== y.length || x.some((byte, offset) => byte !== y[offset])) return false;
    } else if (value !== expected) return false;
  }
  return true;
}

function sameStatements(left: readonly SqlStatement[], right: readonly SqlStatement[]): boolean {
  return (
    left.length === right.length &&
    left.every((statement, index) => {
      const selected = right[index];
      return selected !== undefined && sameStatement(statement, selected);
    })
  );
}

function cloneOperationOriginal(
  original: FinancialCurrentConsentCustomerOperationOriginal,
): FinancialCurrentConsentCustomerOperationOriginal {
  if (original.kind === "phase-batch")
    return Object.freeze({
      ...original,
      plan: Object.freeze({
        ...original.plan,
        statements: Object.freeze(original.plan.statements.map(cloneStatement)),
      }),
    });
  return Object.freeze({ ...original, statement: cloneStatement(original.statement) });
}

function mintOperation(
  connection: WorkerRequestSql,
  assertOrigin: () => void,
  original: FinancialCurrentConsentCustomerOperationOriginal,
): FinancialCurrentConsentCustomerOperation {
  assertOrigin();
  const operation = Object.freeze(Object.create(null)) as FinancialCurrentConsentCustomerOperation;
  operationOrigins.set(operation, {
    connection,
    assertOrigin,
    original: cloneOperationOriginal(original),
  });
  return operation;
}

/** Exact-connection static read of this module's privately minted operation.
 * SQL/DTO shape alone has no origin; the only mint remains module-private. */
export function readFinancialCurrentConsentCustomerOperationOriginal(
  connection: WorkerRequestSql,
  operation: unknown,
): FinancialCurrentConsentCustomerOperationOriginal | null {
  try {
    const entry =
      operation !== null && typeof operation === "object"
        ? operationOrigins.get(operation as FinancialCurrentConsentCustomerOperation)
        : undefined;
    if (!entry || entry.connection !== connection) return null;
    entry.assertOrigin();
    if (readWorkerRequestFinancialInputs(connection) !== entry.original.requestInputs) return null;
    return cloneOperationOriginal(entry.original);
  } catch {
    return null;
  }
}

/** Root's fixed query/batch view of the same privately held operation original. */
export function readFinancialCurrentConsentNativeOriginal(
  operation: unknown,
  expectedKind: "query" | "batch",
): FinancialCurrentConsentNativeOriginal | null {
  try {
    const entry =
      operation !== null && typeof operation === "object"
        ? operationOrigins.get(operation as FinancialCurrentConsentCustomerOperation)
        : undefined;
    if (!entry) return null;
    const copy = readFinancialCurrentConsentCustomerOperationOriginal(entry.connection, operation);
    if (!copy) return null;
    if (copy.kind === "phase-batch")
      return expectedKind === "batch"
        ? Object.freeze({
            kind: "batch",
            connection: entry.connection,
            inputs: copy.requestInputs,
            phase: copy.phase,
            writerEpoch: copy.writerEpoch,
            original: copy.original,
            plan: copy.plan,
          })
        : null;
    return expectedKind === "query"
      ? Object.freeze({
          kind: "query",
          operationKind: copy.kind,
          connection: entry.connection,
          inputs: copy.requestInputs,
          phase: copy.phase,
          writerEpoch: copy.writerEpoch,
          original: copy.original,
          statement: copy.statement,
        })
      : null;
  } catch {
    return null;
  }
}

/** Connect an already verified RP witness and an already read, request-bound R1
 * original to Financial's existing Customer L1/first-D tracked executor. It
 * does not observe RP, reread R1, sample Clock, issue a grant, or call Stripe. */
export function createFinancialCurrentConsentCustomerExecutor(
  connection: WorkerRequestSql,
  handler: object,
  request: Request,
  workspaceId: string,
  witness: unknown,
  r1Reader: unknown,
  r1Original: FinancialActionConsentR1Original,
) {
  const graph = readWorkerRequestConsumers(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  const port = readWorkerRequestFinancialAuthConsumerPort(connection);
  if (!port) unavailable();
  if (graph.sql !== inputs.sql || graph.realm !== inputs.realm) unavailable();
  const context = readWorkerRequestFinancialAuthConsumerContext(connection, port);
  if (!context) unavailable();
  if (context.sql !== inputs.sql || context.realm !== inputs.realm) unavailable();
  const selectedPort: FinancialAuthConsumerPort = port;
  const selectedContext: FinancialAuthConsumerContext = context;
  const query = Object.getOwnPropertyDescriptor(inputs.sql, "query")?.value;
  const batch = Object.getOwnPropertyDescriptor(inputs.sql, "batch")?.value;
  const run = Object.getOwnPropertyDescriptor(inputs.sql, "run")?.value;
  if (typeof query !== "function" || typeof batch !== "function" || typeof run !== "function")
    unavailable();
  const captures = readFinancialActionConsentR1RequestCaptures(
    connection,
    request,
    workspaceId,
    r1Reader,
    r1Original,
  );
  function assertOrigin() {
    if (
      readWorkerRequestConsumers(connection) !== graph ||
      readWorkerRequestFinancialInputs(connection) !== inputs ||
      Object.getOwnPropertyDescriptor(inputs.sql, "query")?.value !== query ||
      Object.getOwnPropertyDescriptor(inputs.sql, "batch")?.value !== batch ||
      Object.getOwnPropertyDescriptor(inputs.sql, "run")?.value !== run ||
      readWorkerRequestFinancialAuthConsumerPort(connection) !== selectedPort ||
      readWorkerRequestFinancialAuthConsumerContext(connection, selectedPort) !== selectedContext ||
      readFinancialActionConsentR1RequestCaptures(
        connection,
        request,
        workspaceId,
        r1Reader,
        r1Original,
      ) !== captures
    )
      unavailable();
    assertFinancialAuthConsumerPort(selectedPort, selectedContext);
    readSharedAuthFinancialConsentCurrentOriginalData(
      handler,
      connection,
      request,
      workspaceId,
      witness,
    );
  }
  assertOrigin();

  /** Bind historical reads to the selected command without renewing consent. */
  async function selectedPhase(phase: CustomerPhaseInput) {
    assertOrigin();
    if (phase.phase !== "L1" && phase.phase !== "D") unavailable();
    const current = readSharedAuthFinancialConsentCurrentOriginalData(
      handler,
      connection,
      request,
      workspaceId,
      witness,
    );
    const consent = await parseSharedAuthFinancialActionConsentOriginal(
      current.original.originalBytes,
    );
    assertOrigin();
    const retained = readWorkerRequestRetainedRpCapture(connection, captures.credential);
    const credential = selectedPort.readValidatedCredential(captures.credential);
    const principal = selectedPort.readValidatedPrincipalBinding(captures.userBinding);
    if (
      !retained ||
      credential.backend !== "shared-rp-session" ||
      retained.record !== credential.record ||
      retained.current !== credential.current
    )
      unavailable();
    const c = phase.admission.input.consent;
    const action = phase.admission.identity.action;
    const terms = r1Original.selectedTerms;
    const termsIdentity = {
      ref: terms.ref,
      digest: terms.digest,
      mediaType: terms.mediaType,
      locale: terms.locale,
      bodyByteLength: terms.bodyByteLength,
      digestRecipe: terms.digestRecipe,
    };
    const actualCustomer = await createStripeCustomerOriginalDefinition(
      inputs.realm,
      action.organizationId,
    );
    assertOrigin();
    const originalCustomer = r1Original.original.c0.selection.customer;
    if (
      current.original.command.key.consentRef !== consent.consentRef ||
      c.consentProofRef !== consent.consentRef ||
      c.consentDigest !== consent.consentDigest ||
      c.consentRegistrationRef !== consent.consentIssuer.registrationRef ||
      c.consentIncarnation !== consent.consentIssuer.incarnation ||
      c.challengeRef !== consent.challenge.challengeRef ||
      c.actionKind !== action.kind ||
      c.actionRef !== action.reference ||
      c.requestFingerprint !== consent.actionRequestFingerprint ||
      c.requestFingerprint !== phase.admission.identity.requestFingerprint ||
      consent.identityEvidence.kind !== "financial-proof" ||
      c.identityProofRef !== consent.identityEvidence.proofRef ||
      canonicalJson(action) !== canonicalJson(consent.action) ||
      canonicalJson(action) !== canonicalJson(r1Original.actionIdentity.action) ||
      canonicalJson(consent.challenge) !== canonicalJson(r1Original.original.c0.challenge) ||
      phase.admission.termsJson !== canonicalJson(termsIdentity) ||
      consent.selectedTerms.ref !== terms.ref ||
      consent.selectedTerms.digest !== terms.digest ||
      phase.admission.original.key !== originalCustomer.idempotencyKey ||
      phase.admission.original.fingerprint !== originalCustomer.requestFingerprint ||
      phase.admission.original.key !== actualCustomer.key ||
      phase.admission.original.fingerprint !== actualCustomer.fingerprint ||
      phase.admission.original.realmJson !== actualCustomer.realmJson ||
      phase.admission.original.requestJson !== actualCustomer.requestJson ||
      originalCustomer.financialRealm !== inputs.realm.financialRealm ||
      phase.writerEpoch !== inputs.writerEpoch ||
      r1Original.scopeRealm.writerEpoch !== inputs.writerEpoch ||
      consent.source.ref !== r1Original.actionSource.ref ||
      consent.source.digest !== r1Original.actionSource.digest ||
      consent.source.registrationRef !== r1Original.actionSource.registrationRef ||
      consent.source.incarnation !== r1Original.actionSource.incarnation ||
      consent.path.organizationId !== action.organizationId ||
      consent.path.workspaceId !== workspaceId ||
      consent.financialRealmRef !== inputs.realm.financialRealm ||
      consent.financialRealmRef !== r1Original.scopeRealm.financialRealm ||
      consent.path.workspaceRef !== r1Original.scopeRealm.workspaceRef ||
      consent.path.organizationId !== r1Original.scopeRealm.organizationId ||
      consent.path.workspaceId !== r1Original.scopeRealm.workspaceId ||
      canonicalJson(c.auth.credential) !== canonicalJson(retained.record) ||
      canonicalJson(c.auth.human) !== canonicalJson(principal.binding) ||
      canonicalJson(c.auth.current) !== canonicalJson(retained.current) ||
      consent.rpSession.sessionDigest !== retained.finalSession.sessionDigest ||
      consent.rpSession.accountId !== retained.finalSession.accountId ||
      consent.rpSession.observedPrincipalId !== principal.binding.principalId ||
      consent.principalBinding.ref !== principal.binding.ref ||
      consent.principalBinding.digest !== principal.binding.evidence.digest ||
      consent.principalBinding.incarnation !== principal.binding.controllerIncarnation ||
      consent.credentialClass.ref !== retained.record.origin.ref ||
      consent.credentialClass.digest !== retained.record.origin.issuanceDigest ||
      consent.credentialClass.incarnation !== retained.record.origin.incarnation
    )
      unavailable();
    return { current, consent, retained, principal, action };
  }

  async function guardedPlan(phase: CustomerPhaseInput, statements: readonly SqlStatement[]) {
    const { current, consent, retained, principal, action } = await selectedPhase(phase);
    assertOrigin();
    const plan = compileCustomerPhase(phase);
    if (!sameStatements(plan.statements, statements)) unavailable();
    // The request Sql must be Root's Money writer for this phase's own epoch, and
    // a write requires the exact fenced 0104 Customer shape; recovery reads do not.
    try {
      assertMoneyCutoverSqlOrigin(inputs.sql, { writerEpoch: phase.writerEpoch });
      await assertFinancial0104CustomerWriteShape(inputs.sql);
    } catch {
      unavailable();
    }
    assertOrigin();
    if (consent.acceptedAt > current.sampledAt || current.sampledAt >= consent.expiresAt)
      unavailable();
    const rows: unknown = await Reflect.apply(query, inputs.sql, [
      "SELECT * FROM shared_auth_financial_consent_pending WHERE transaction_ref=? LIMIT 2",
      [current.original.command.key.transactionRef],
    ]);
    assertOrigin();
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]) unavailable();
    const pending = rows[0] as SharedAuthFinancialConsentPendingData;
    if (
      pending.transaction_ref !== current.original.command.key.transactionRef ||
      pending.challenge_ref !== consent.challenge.challengeRef ||
      pending.action_kind !== action.kind ||
      pending.action_ref !== action.reference ||
      pending.request_fingerprint !== consent.actionRequestFingerprint ||
      pending.organization_id !== action.organizationId ||
      pending.workspace_id !== workspaceId ||
      pending.workspace_ref !== consent.path.workspaceRef
    )
      unavailable();
    const rp = await sharedAuthFinancialConsentLocalCurrentnessStatement({
      pending,
      command: current.original.command,
      recordedAt: current.original.recordedAt,
      credential: retained.record,
      human: principal.binding,
      currentSession: retained.current,
    });
    assertOrigin();
    const root = financialAuthConsumerSourceCurrentness(selectedPort, selectedContext);
    assertOrigin();
    return guardCustomerConsentReceipt(plan, {
      rp,
      root,
      issuer: consent.consentIssuer,
      acceptedAt: consent.acceptedAt,
      expiresAt: consent.expiresAt,
    });
  }

  function scopedTracker(phase: CustomerPhaseInput) {
    const coreReceiptRef =
      phase.phase === "L1" ? phase.admission.receiptRef : phase.dispatchReceiptRef;
    const completed = completedCustomerReceiptReadStatement(coreReceiptRef);
    const originalRead = customerTrackedOriginalReadStatement(
      coreReceiptRef,
      phase.historyReceiptRef,
    );
    const wrapped: Sql = Object.freeze({
      async query(sql: string, params?: readonly SqlParam[]): Promise<readonly Row[]> {
        assertOrigin();
        const selected = { sql, ...(params === undefined ? {} : { params }) };
        const kind = sameStatement(selected, completed)
          ? "completed-receipt-read"
          : sameStatement(selected, originalRead)
            ? "original-read"
            : unavailable();
        await selectedPhase(phase);
        assertOrigin();
        const operation = mintOperation(connection, assertOrigin, {
          kind,
          requestInputs: inputs,
          phase: phase.phase as "L1" | "D",
          writerEpoch: phase.writerEpoch,
          original: phase,
          statement: kind === "completed-receipt-read" ? completed : originalRead,
        });
        const fixed = readFinancialCurrentConsentCustomerOperationOriginal(connection, operation);
        if (!fixed || fixed.kind !== kind || fixed.requestInputs !== inputs) unavailable();
        const result = await queryWorkerRequestFinancialCurrentConsentOriginal(
          connection,
          operation,
        );
        assertOrigin();
        return result;
      },
      async run(): Promise<SqlWrite> {
        return unavailable();
      },
      async batch(statements: readonly SqlStatement[]): Promise<readonly SqlWrite[]> {
        assertOrigin();
        const guarded = await guardedPlan(phase, statements);
        assertOrigin();
        const operation = mintOperation(connection, assertOrigin, {
          kind: "phase-batch",
          requestInputs: inputs,
          phase: phase.phase as "L1" | "D",
          writerEpoch: phase.writerEpoch,
          original: phase,
          plan: guarded,
        });
        const fixed = readFinancialCurrentConsentCustomerOperationOriginal(connection, operation);
        if (fixed?.kind !== "phase-batch" || fixed.requestInputs !== inputs) unavailable();
        const result = await batchWorkerRequestFinancialCurrentConsentOriginal(
          connection,
          operation,
        );
        assertOrigin();
        return result;
      },
    });
    return createCustomerTrackedExecutionData(wrapped);
  }
  const prior = attempted.get(connection) ?? new Set<string>();
  attempted.set(connection, prior);
  return Object.freeze({
    async readOriginal(input: CustomerPhaseInput) {
      assertOrigin();
      const phase = captureCustomerTrackedPhaseOriginal(input);
      if (phase.phase !== "L1" && phase.phase !== "D") unavailable();
      prior.add(`${phase.phase}:${r1Original.original.challengeRef}`);
      return scopedTracker(phase).readOriginal(phase);
    },
    async executePhase(input: CustomerPhaseInput) {
      assertOrigin();
      const phase = captureCustomerTrackedPhaseOriginal(input);
      if (phase.phase !== "L1" && phase.phase !== "D") unavailable();
      const key = `${phase.phase}:${r1Original.original.challengeRef}`;
      if (prior.has(key)) return scopedTracker(phase).readOriginal(phase);
      prior.add(key);
      return scopedTracker(phase).executePhase(phase);
    },
  });
}
