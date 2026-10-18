import {
  type RpAuthorityRecord,
  sharedRpCredentialCurrentness,
} from "./credential-authority-class.ts";
import {
  assertFinancialAuthConsumerPort,
  assertWorkerRequestFinancialAuthConsumerPort,
  captureWorkerRequestFinancialAuthRpRequest,
  financialAuthConsumerSourceCurrentness,
  readWorkerRequestFinancialAuthConsumerContext,
  readWorkerRequestFinancialAuthConsumerPort,
  readWorkerRequestFinancialInputs,
  readWorkerRequestRetainedRpCapture,
} from "./financial-request-origin.ts";
import { bytesDigest, canonicalJson } from "./json.ts";
import type { Row, Sql, SqlParam, SqlStatement, SqlWrite } from "./ports.ts";
import { parseSharedAuthFinancialActionConsentOriginal } from "./shared-auth-financial-consent-contract.ts";
import {
  type ConsentLeafOriginalKey,
  type ConsentLeafSelectedScope,
  inspectSharedAuthFinancialConsentLeafSchema,
  requireSharedAuthFinancialConsentConsumePostimage,
  SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX,
} from "./shared-auth-financial-consent-schema-plan.ts";
import { readSharedAuthFinancialRequestNativeObservationData } from "./shared-auth-financial-source.ts";
import {
  authAuthorityDigest,
  authAuthorityInteger,
  authAuthorityText,
  authAuthorityTime,
  type SharedPrincipalBinding,
  sharedPrincipalCurrentness,
} from "./shared-principal-authority.ts";
import { readWorkerRequestConsumers, type WorkerRequestSql } from "./worker-request-composition.ts";

/** Private storage DATA ABI, not an external consent/receipt wire or authority. */
export interface SharedAuthFinancialConsentOriginalCommand {
  readonly key: ConsentLeafOriginalKey;
  readonly selectedScope: ConsentLeafSelectedScope;
  readonly family: "rp-explicit-action-consent";
  readonly commandBytes: Uint8Array;
  readonly commandCustodySHA256: string;
  readonly originalBytes: Uint8Array;
  readonly originalDigest: string;
  readonly originalCustodySHA256: string;
  readonly capturedAt: number;
}

/** Historical immutable custody only. This does not authorize a NEW command. */
export interface SharedAuthFinancialConsentOriginalData {
  readonly state: "receipted-original-data";
  readonly command: SharedAuthFinancialConsentOriginalCommand;
  readonly originalBytes: Uint8Array;
  readonly originalDigest: string;
  readonly originalCustodySHA256: string;
  readonly recordedAt: number;
  readonly receiptRef: string;
  readonly receiptRecordedAt: number;
}

export class SharedAuthFinancialConsentOriginalReadError extends Error {
  constructor(readonly code: "invalid_request" | "custody_conflict" | "unavailable") {
    super(code);
    this.name = "SharedAuthFinancialConsentOriginalReadError";
  }
}

type Code = SharedAuthFinancialConsentOriginalReadError["code"];
const fail = (code: Code): never => {
  throw new SharedAuthFinancialConsentOriginalReadError(code);
};
const FAMILY = "rp-explicit-action-consent";
const PENDING = `${SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX}pending`;
const COMMANDS = `${SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX}commands`;
const ORIGINALS = `${SHARED_AUTH_FINANCIAL_CONSENT_LEAF_PREFIX}originals`;
const keyNames = [
  "registrationRef",
  "incarnation",
  "transactionRef",
  "commandRef",
  "consentRef",
  "receiptRef",
];
const scopeNames = ["organizationId", "workspaceId", "workspaceRef"];
const commandNames = [
  "key",
  "selectedScope",
  "family",
  "commandBytes",
  "commandCustodySHA256",
  "originalBytes",
  "originalDigest",
  "originalCustodySHA256",
  "capturedAt",
];
const pendingColumns = [
  "transaction_ref",
  "registration_ref",
  "incarnation",
  "challenge_ref",
  "action_ref",
  "action_kind",
  "organization_id",
  "workspace_id",
  "workspace_ref",
  "request_fingerprint",
  "principal_id",
  "principal_incarnation",
  "principal_binding_ref",
  "authority_ref",
  "credential_incarnation",
  "credential_target_ref",
  "credential_organization_id",
  "credential_workspace_id",
  "credential_workspace_ref",
  "action_original_bytes",
  "action_custody_sha256",
  "terms_original_bytes",
  "terms_digest_original",
  "terms_custody_sha256",
  "disclosure_ref",
  "challenge_original_bytes",
  "challenge_custody_sha256",
  "created_at",
  "expires_at",
];
const commandColumns = [
  "command_ref",
  "transaction_ref",
  "registration_ref",
  "incarnation",
  "organization_id",
  "workspace_id",
  "workspace_ref",
  "family",
  "consent_ref",
  "receipt_ref",
  "command_bytes",
  "command_custody_sha256",
  "original_bytes",
  "original_digest",
  "original_custody_sha256",
  "captured_at",
];
const originalColumns = [
  "consent_ref",
  "command_ref",
  "transaction_ref",
  "receipt_ref",
  "registration_ref",
  "incarnation",
  "organization_id",
  "workspace_id",
  "workspace_ref",
  "original_bytes",
  "original_digest",
  "original_custody_sha256",
  "recorded_at",
  "receipt_recorded_at",
];

function exactOwn(value: unknown, names: readonly string[], code: Code): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(code);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== names.length) return fail(code);
  const result: Record<string, unknown> = Object.create(null);
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name !== "string" || !names.includes(name)) return fail(code);
    const property = descriptors[name];
    if (!property || !Object.hasOwn(property, "value") || property.enumerable !== true)
      return fail(code);
    result[name] = property.value;
  }
  return result;
}

function text(value: unknown, code: Code, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  )
    return fail(code);
  return value;
}
function stamp(value: unknown, code: Code): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail(code);
  return value;
}
function custodyDigest(value: unknown, code: Code): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return fail(code);
  return value;
}
function bytes(value: unknown, maximum: number, code: Code): Uint8Array<ArrayBuffer> {
  const selected = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(selected instanceof Uint8Array) || selected.byteLength < 1 || selected.byteLength > maximum)
    return fail(code);
  return new Uint8Array(selected);
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}
async function requireCustody(value: Uint8Array, expected: string, code: Code): Promise<void> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));
  const digest = `sha256:${Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  if (digest !== expected) return fail(code);
}

function snapshotCommand(input: unknown): SharedAuthFinancialConsentOriginalCommand {
  const value = exactOwn(input, commandNames, "invalid_request");
  const rawKey = exactOwn(value.key, keyNames, "invalid_request");
  const key = Object.freeze({
    registrationRef: text(rawKey.registrationRef, "invalid_request"),
    incarnation: text(rawKey.incarnation, "invalid_request"),
    transactionRef: text(rawKey.transactionRef, "invalid_request"),
    commandRef: text(rawKey.commandRef, "invalid_request"),
    consentRef: text(rawKey.consentRef, "invalid_request"),
    receiptRef: text(rawKey.receiptRef, "invalid_request"),
  });
  if (!/^rpfc_[A-Za-z0-9_-]{43}$/u.test(key.transactionRef) || value.family !== FAMILY)
    return fail("invalid_request");
  const rawScope = exactOwn(value.selectedScope, scopeNames, "invalid_request");
  const selectedScope = Object.freeze({
    organizationId: text(rawScope.organizationId, "invalid_request"),
    workspaceId: text(rawScope.workspaceId, "invalid_request"),
    workspaceRef: text(rawScope.workspaceRef, "invalid_request"),
  });
  // All values/BLOBs are detached synchronously, before hashing or any SQL await.
  return Object.freeze({
    key,
    selectedScope,
    family: FAMILY,
    commandBytes: bytes(value.commandBytes, 65536, "invalid_request"),
    commandCustodySHA256: custodyDigest(value.commandCustodySHA256, "invalid_request"),
    originalBytes: bytes(value.originalBytes, 16384, "invalid_request"),
    originalDigest: text(value.originalDigest, "invalid_request"),
    originalCustodySHA256: custodyDigest(value.originalCustodySHA256, "invalid_request"),
    capturedAt: stamp(value.capturedAt, "invalid_request"),
  });
}

function ownedRows(value: unknown, columns: readonly string[]): readonly Row[] {
  if (!Array.isArray(value)) return fail("unavailable");
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length: unknown = descriptors.length?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 2 ||
    Reflect.ownKeys(descriptors).length !== length + 1
  )
    return fail("unavailable");
  const result: Row[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)
      return fail("unavailable");
    const row = exactOwn(descriptor.value, columns, "unavailable");
    const copy: Row = Object.create(null);
    for (const name of columns) {
      const item: unknown = row[name];
      if (item instanceof Uint8Array || item instanceof ArrayBuffer)
        copy[name] = bytes(item, 65536, "unavailable");
      else if (item === null || typeof item === "string" || typeof item === "number")
        copy[name] = item;
      else return fail("unavailable");
    }
    result.push(Object.freeze(copy));
  }
  return Object.freeze(result);
}

function matchesKey(row: Row, key: ConsentLeafOriginalKey): boolean {
  return (
    row.registration_ref === key.registrationRef &&
    row.incarnation === key.incarnation &&
    row.transaction_ref === key.transactionRef &&
    row.command_ref === key.commandRef &&
    row.consent_ref === key.consentRef &&
    row.receipt_ref === key.receiptRef
  );
}
function matchesScope(row: Row, scope: ConsentLeafSelectedScope): boolean {
  return (
    row.organization_id === scope.organizationId &&
    row.workspace_id === scope.workspaceId &&
    row.workspace_ref === scope.workspaceRef
  );
}

/**
 * Query-only mechanical loader. An ordinary Sql-shaped query port is NOT a
 * genuine Root/realm/primary/source qualification. The existing leaf readiness
 * diagnostic is reused; this adds actual BLOB loading and full-command matching
 * that its key-only state diagnostic does not supply. No consume/write API.
 */
export function createSharedAuthFinancialConsentOriginalReader(sql: Pick<Sql, "query">) {
  let method: Sql["query"];
  try {
    const descriptor = Object.getOwnPropertyDescriptor(sql, "query");
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      return fail("unavailable");
    method = descriptor.value;
  } catch {
    return fail("unavailable");
  }
  const receiver = sql;
  // Capture the original receiver/method at factory construction, never reload
  // a replaceable method after awaits. This wrapper adds no origin/ready flag.
  const selectedPort: Pick<Sql, "query"> = Object.freeze({
    query(statement, params) {
      return Reflect.apply(method, receiver, [statement, params]);
    },
  });
  async function query(
    statement: string,
    params: readonly string[],
    columns: readonly string[],
  ): Promise<readonly Row[]> {
    try {
      return ownedRows(await selectedPort.query(statement, params), columns);
    } catch {
      // External query/row-decoder rejection is SQL unknown even if it borrows
      // this exported error class. Only our comparisons outside this boundary
      // can classify an occupied original/full-command as custody_conflict.
      return fail("unavailable");
    }
  }

  async function readOriginal(
    input: SharedAuthFinancialConsentOriginalCommand,
  ): Promise<SharedAuthFinancialConsentOriginalData | undefined> {
    let command: SharedAuthFinancialConsentOriginalCommand;
    try {
      command = snapshotCommand(input);
    } catch {
      return fail("invalid_request");
    }
    try {
      await requireCustody(command.commandBytes, command.commandCustodySHA256, "invalid_request");
      await requireCustody(command.originalBytes, command.originalCustodySHA256, "invalid_request");
      // An invalid supplied original/key never becomes positive three-row
      // absence. This validates historical DATA, not now/current permission.
      await requireOriginalRecipe(command, "invalid_request");
      if ((await inspectSharedAuthFinancialConsentLeafSchema(selectedPort)) !== "leaf-present")
        return fail("unavailable");
      const key = command.key;
      const params = [key.transactionRef, key.commandRef, key.consentRef, key.receiptRef];
      const pendingRows = await query(
        `SELECT ${pendingColumns.join(",")} FROM ${PENDING} WHERE transaction_ref=? LIMIT 2`,
        [key.transactionRef],
        pendingColumns,
      );
      const commandRows = await query(
        `SELECT ${commandColumns.join(",")} FROM ${COMMANDS} WHERE transaction_ref=? OR command_ref=? OR consent_ref=? OR receipt_ref=? LIMIT 2`,
        params,
        commandColumns,
      );
      const originalRows = await query(
        `SELECT ${originalColumns.join(",")} FROM ${ORIGINALS} WHERE transaction_ref=? OR command_ref=? OR consent_ref=? OR receipt_ref=? LIMIT 2`,
        params,
        originalColumns,
      );
      if (pendingRows.length > 1 || commandRows.length > 1 || originalRows.length > 1)
        return fail("custody_conflict");
      for (const row of [commandRows[0], originalRows[0]]) {
        if (!row) continue;
        for (const name of [
          "registration_ref",
          "incarnation",
          "transaction_ref",
          "command_ref",
          "consent_ref",
          "receipt_ref",
        ])
          text(row[name], "unavailable");
        // A row reached through another occupied ref is a different original,
        // not the positive absence of the caller's changed transaction/key.
        if (!matchesKey(row, key)) return fail("custody_conflict");
      }
      if (pendingRows.length === 0) {
        if (commandRows.length || originalRows.length) return fail("unavailable");
        // Complete positive absence of this exact vector only. This authorizes
        // no install/resend, NEW ref, family fallback or current permission.
        return undefined;
      }
      const pending = pendingRows[0]!;
      for (const name of pendingColumns) {
        if (name.endsWith("_bytes") || name === "created_at" || name === "expires_at") continue;
        text(pending[name], "unavailable");
      }
      if (
        pending.transaction_ref !== key.transactionRef ||
        pending.registration_ref !== key.registrationRef ||
        pending.incarnation !== key.incarnation ||
        !matchesScope(pending, command.selectedScope)
      )
        return fail("custody_conflict");
      if (
        !/^rpfc_[A-Za-z0-9_-]{43}$/u.test(String(pending.transaction_ref)) ||
        !["topup", "subscription-start", "card-setup", "plan-change", "cancel"].includes(
          String(pending.action_kind),
        )
      )
        return fail("unavailable");
      custodyDigest(pending.request_fingerprint, "unavailable");
      const createdAt = stamp(pending.created_at, "unavailable");
      const expiresAt = stamp(pending.expires_at, "unavailable");
      if (expiresAt <= createdAt || expiresAt - createdAt > 300000) return fail("unavailable");
      for (const part of ["action", "terms", "challenge"]) {
        await requireCustody(
          bytes(pending[`${part}_original_bytes`], 16384, "unavailable"),
          custodyDigest(pending[`${part}_custody_sha256`], "unavailable"),
          "unavailable",
        );
      }
      if (commandRows.length === 0) return fail("unavailable"); // Pending/orphan is not absence.
      const stored = commandRows[0]!;
      for (const name of commandColumns) {
        if (!name.endsWith("_bytes") && name !== "captured_at") text(stored[name], "unavailable");
      }
      const storedCommandBytes = bytes(stored.command_bytes, 65536, "unavailable");
      const storedOriginalBytes = bytes(stored.original_bytes, 16384, "unavailable");
      const commandHash = custodyDigest(stored.command_custody_sha256, "unavailable");
      const originalHash = custodyDigest(stored.original_custody_sha256, "unavailable");
      await requireCustody(storedCommandBytes, commandHash, "unavailable");
      await requireCustody(storedOriginalBytes, originalHash, "unavailable");
      const capturedAt = stamp(stored.captured_at, "unavailable");
      text(stored.original_digest, "unavailable");
      if (
        !matchesKey(stored, key) ||
        !matchesScope(stored, command.selectedScope) ||
        stored.family !== FAMILY ||
        !sameBytes(storedCommandBytes, command.commandBytes) ||
        commandHash !== command.commandCustodySHA256 ||
        !sameBytes(storedOriginalBytes, command.originalBytes) ||
        stored.original_digest !== command.originalDigest ||
        originalHash !== command.originalCustodySHA256 ||
        capturedAt !== command.capturedAt
      )
        return fail("custody_conflict");
      if (capturedAt < createdAt || capturedAt >= expiresAt) return fail("unavailable");
      if (originalRows.length === 0) return fail("unavailable"); // Committed command/unknown ACK: GET only, never resend.
      const original = originalRows[0]!;
      for (const name of originalColumns) {
        if (!name.endsWith("_bytes") && name !== "recorded_at" && name !== "receipt_recorded_at")
          text(original[name], "unavailable");
      }
      if (!matchesKey(original, key) || !matchesScope(original, command.selectedScope))
        return fail("custody_conflict");
      const originalBytes = bytes(original.original_bytes, 16384, "unavailable");
      const originalDigest = text(original.original_digest, "unavailable");
      const originalCustodySHA256 = custodyDigest(original.original_custody_sha256, "unavailable");
      await requireCustody(originalBytes, originalCustodySHA256, "unavailable");
      const recordedAt = stamp(original.recorded_at, "unavailable");
      const receiptRecordedAt = stamp(original.receipt_recorded_at, "unavailable");
      if (
        !sameBytes(originalBytes, storedOriginalBytes) ||
        originalDigest !== command.originalDigest ||
        originalCustodySHA256 !== originalHash ||
        recordedAt < capturedAt ||
        recordedAt >= expiresAt ||
        receiptRecordedAt !== recordedAt
      )
        return fail("unavailable");
      try {
        const storedCapture = snapshotRequestCapture({
          pending,
          command: {
            key,
            selectedScope: command.selectedScope,
            family: stored.family,
            commandBytes: storedCommandBytes,
            commandCustodySHA256: commandHash,
            originalBytes,
            originalDigest,
            originalCustodySHA256,
            capturedAt,
          },
        });
        // Decode the actual persisted bytes as well as the supplied original.
        // Corruption is unavailable; never an absence or a new replay key.
        await requireCaptureRecipe(storedCapture, "unavailable");
      } catch {
        return fail("unavailable");
      }
      return Object.freeze({
        state: "receipted-original-data",
        command,
        originalBytes,
        originalDigest,
        originalCustodySHA256,
        recordedAt,
        receiptRef: key.receiptRef,
        receiptRecordedAt,
      });
    } catch (error) {
      if (error instanceof SharedAuthFinancialConsentOriginalReadError) throw error;
      // Missing/partial/conflicting schema, SQL rejection and unknown results
      // are not a positive absence. No repair or alternate family is selected.
      return fail("unavailable");
    }
  }
  return Object.freeze({ readOriginal });
}

/** PRIVATE retained storage DATA, not a public consent/action/challenge wire.
 * Each property is one existing pending column; opaque external digests and
 * original BLOBs remain verbatim. Credential scope A and selected scope B are
 * distinct. Their presence never establishes current admission to B.
 */
export interface SharedAuthFinancialConsentPendingData {
  readonly transaction_ref: string;
  readonly registration_ref: string;
  readonly incarnation: string;
  readonly challenge_ref: string;
  readonly action_ref: string;
  readonly action_kind: "topup" | "subscription-start" | "card-setup" | "plan-change" | "cancel";
  readonly organization_id: string;
  readonly workspace_id: string;
  readonly workspace_ref: string;
  readonly request_fingerprint: string;
  readonly principal_id: string;
  readonly principal_incarnation: string;
  readonly principal_binding_ref: string;
  readonly authority_ref: string;
  readonly credential_incarnation: string;
  readonly credential_target_ref: string;
  readonly credential_organization_id: string;
  readonly credential_workspace_id: string;
  readonly credential_workspace_ref: string;
  readonly action_original_bytes: Uint8Array;
  readonly action_custody_sha256: string;
  readonly terms_original_bytes: Uint8Array;
  readonly terms_digest_original: string;
  readonly terms_custody_sha256: string;
  readonly disclosure_ref: string;
  readonly challenge_original_bytes: Uint8Array;
  readonly challenge_custody_sha256: string;
  readonly created_at: number;
  readonly expires_at: number;
}

export interface SharedAuthFinancialConsentCaptureData {
  readonly pending: SharedAuthFinancialConsentPendingData;
  readonly command: SharedAuthFinancialConsentOriginalCommand;
}

/** Ordinary structural DATA for mechanical SQL constraints ONLY. These types
 * cannot establish genuine Root origin, a qualified Clock, same-primary realm,
 * current admission, actual human consent or Financial retained R1 terms.
 */
export interface SharedAuthFinancialConsentGuardedStatementData
  extends SharedAuthFinancialConsentCaptureData {
  readonly recordedAt: number;
  readonly credential: RpAuthorityRecord;
  readonly human: SharedPrincipalBinding;
  readonly currentSession: Readonly<{
    version: number;
    absoluteExpiresAt: number;
    lastUsedAt: number;
  }>;
}

function snapshotPending(input: unknown): SharedAuthFinancialConsentPendingData {
  const value = exactOwn(input, pendingColumns, "invalid_request");
  const selected: Record<string, string | number | Uint8Array<ArrayBuffer>> = Object.create(null);
  for (const name of pendingColumns) {
    selected[name] = name.endsWith("_bytes")
      ? bytes(value[name], 16384, "invalid_request")
      : name === "created_at" || name === "expires_at"
        ? stamp(value[name], "invalid_request")
        : name.endsWith("_sha256") || name === "request_fingerprint"
          ? custodyDigest(value[name], "invalid_request")
          : text(value[name], "invalid_request");
  }
  if (
    !/^rpfc_[A-Za-z0-9_-]{43}$/u.test(String(selected.transaction_ref)) ||
    !["topup", "subscription-start", "card-setup", "plan-change", "cancel"].includes(
      String(selected.action_kind),
    ) ||
    Number(selected.expires_at) <= Number(selected.created_at) ||
    Number(selected.expires_at) - Number(selected.created_at) > 300000
  )
    return fail("invalid_request");
  // Names/types were checked above; no parsing or rehashing of external digests.
  return Object.freeze(selected) as unknown as SharedAuthFinancialConsentPendingData;
}

function snapshotCapture(input: unknown): SharedAuthFinancialConsentCaptureData {
  const value = exactOwn(input, ["pending", "command"], "invalid_request");
  return Object.freeze({
    pending: snapshotPending(value.pending),
    command: snapshotCommand(value.command),
  });
}

function snapshotCredential(input: unknown): RpAuthorityRecord {
  const value = exactOwn(
    input,
    ["state", "terminal", "origin", "class", "backend", "organizationId", "rp"],
    "invalid_request",
  );
  if (
    value.state !== "active" ||
    value.terminal !== null ||
    value.class !== "official-shared-rp-session" ||
    value.backend !== "shared-rp-session"
  )
    return fail("invalid_request");
  const origin = exactOwn(
    value.origin,
    [
      "ref",
      "incarnation",
      "targetRef",
      "principalId",
      "principalIncarnation",
      "issuanceRef",
      "issuanceDigest",
      "issuedAt",
    ],
    "invalid_request",
  );
  const rp = exactOwn(
    value.rp,
    [
      "principalBindingRef",
      "registrationRef",
      "registrationDigest",
      "sessionDigest",
      "sessionCreatedAt",
      "enrolledSessionVersion",
      "issuer",
      "clientId",
      "subject",
      "issuerSessionId",
      "authTime",
      "accountId",
      "workspaceId",
      "workspaceRef",
    ],
    "invalid_request",
  );
  return Object.freeze({
    state: "active",
    terminal: null,
    class: "official-shared-rp-session",
    backend: "shared-rp-session",
    organizationId: authAuthorityText(value.organizationId),
    origin: Object.freeze({
      ref: authAuthorityText(origin.ref, 256),
      incarnation: authAuthorityText(origin.incarnation, 256),
      targetRef: authAuthorityText(origin.targetRef),
      principalId: authAuthorityText(origin.principalId),
      principalIncarnation: authAuthorityText(origin.principalIncarnation, 256),
      issuanceRef: authAuthorityText(origin.issuanceRef),
      issuanceDigest: authAuthorityDigest(origin.issuanceDigest),
      issuedAt: authAuthorityTime(origin.issuedAt),
    }),
    rp: Object.freeze({
      principalBindingRef: authAuthorityText(rp.principalBindingRef, 256),
      registrationRef: authAuthorityText(rp.registrationRef),
      registrationDigest: authAuthorityDigest(rp.registrationDigest),
      sessionDigest: authAuthorityDigest(rp.sessionDigest),
      sessionCreatedAt: authAuthorityInteger(rp.sessionCreatedAt),
      enrolledSessionVersion: authAuthorityInteger(rp.enrolledSessionVersion),
      issuer: authAuthorityText(rp.issuer, 2048),
      clientId: authAuthorityText(rp.clientId),
      subject: authAuthorityText(rp.subject),
      issuerSessionId: authAuthorityText(rp.issuerSessionId),
      authTime: authAuthorityInteger(rp.authTime),
      accountId: authAuthorityText(rp.accountId),
      workspaceId: authAuthorityText(rp.workspaceId),
      workspaceRef: authAuthorityText(rp.workspaceRef),
    }),
  });
}

function snapshotHuman(input: unknown): SharedPrincipalBinding {
  const value = exactOwn(
    input,
    [
      "ref",
      "issuer",
      "subject",
      "controllerIncarnation",
      "principalId",
      "principalIncarnation",
      "targetRef",
      "kind",
      "evidence",
      "previousRef",
      "enrolledAt",
      "state",
      "terminal",
    ],
    "invalid_request",
  );
  const evidence = exactOwn(value.evidence, ["ref", "digest"], "invalid_request");
  if (
    (value.kind !== "fresh-shared" && value.kind !== "proved-legacy") ||
    value.state !== "active" ||
    value.terminal !== null
  )
    return fail("invalid_request");
  return Object.freeze({
    ref: authAuthorityText(value.ref, 256),
    issuer: authAuthorityText(value.issuer, 2048),
    subject: authAuthorityText(value.subject),
    controllerIncarnation: authAuthorityText(value.controllerIncarnation, 256),
    principalId: authAuthorityText(value.principalId),
    principalIncarnation: authAuthorityText(value.principalIncarnation, 256),
    targetRef: authAuthorityText(value.targetRef),
    kind: value.kind,
    evidence: Object.freeze({
      ref: authAuthorityText(evidence.ref),
      digest: authAuthorityDigest(evidence.digest),
    }),
    previousRef: value.previousRef === null ? null : authAuthorityText(value.previousRef, 256),
    enrolledAt: authAuthorityTime(value.enrolledAt),
    state: "active",
    terminal: null,
  });
}

function snapshotGuarded(input: unknown) {
  const value = exactOwn(
    input,
    ["pending", "command", "recordedAt", "credential", "human", "currentSession"],
    "invalid_request",
  );
  const pending = snapshotPending(value.pending);
  const command = snapshotCommand(value.command);
  const credential = snapshotCredential(value.credential);
  const human = snapshotHuman(value.human);
  const rawCurrent = exactOwn(
    value.currentSession,
    ["version", "absoluteExpiresAt", "lastUsedAt"],
    "invalid_request",
  );
  const currentSession = Object.freeze({
    version: stamp(rawCurrent.version, "invalid_request"),
    absoluteExpiresAt: stamp(rawCurrent.absoluteExpiresAt, "invalid_request"),
    lastUsedAt: stamp(rawCurrent.lastUsedAt, "invalid_request"),
  });
  const recordedAt = stamp(value.recordedAt, "invalid_request");
  // Bind both actual Root constraints to THIS pending's retained credential A.
  // Consent registration and selected Financial scope B remain separate facts.
  if (
    pending.authority_ref !== credential.origin.ref ||
    pending.credential_incarnation !== credential.origin.incarnation ||
    pending.credential_target_ref !== credential.origin.targetRef ||
    pending.principal_id !== credential.origin.principalId ||
    pending.principal_incarnation !== credential.origin.principalIncarnation ||
    pending.credential_organization_id !== credential.organizationId ||
    pending.credential_workspace_id !== credential.rp.workspaceId ||
    pending.credential_workspace_ref !== credential.rp.workspaceRef ||
    pending.principal_binding_ref !== credential.rp.principalBindingRef ||
    human.ref !== pending.principal_binding_ref ||
    human.principalId !== pending.principal_id ||
    human.principalIncarnation !== pending.principal_incarnation ||
    human.targetRef !== pending.credential_target_ref ||
    human.issuer !== credential.rp.issuer ||
    human.subject !== credential.rp.subject ||
    credential.rp.subject !== credential.rp.accountId
  )
    return fail("invalid_request");
  // Fixed owning builders only; no predicate callback/raw SQL/boolean input.
  // Capture all authority DATA and expressions before the first hash await.
  const rpConstraint = sharedRpCredentialCurrentness(
    credential,
    currentSession,
    credential.organizationId,
  );
  const humanConstraint = sharedPrincipalCurrentness(human);
  return Object.freeze({ pending, command, recordedAt, rpConstraint, humanConstraint });
}

async function validateCaptureHashes(input: SharedAuthFinancialConsentCaptureData): Promise<void> {
  const { pending, command } = input;
  await requireCustody(
    pending.action_original_bytes,
    pending.action_custody_sha256,
    "invalid_request",
  );
  await requireCustody(
    pending.terms_original_bytes,
    pending.terms_custody_sha256,
    "invalid_request",
  );
  await requireCustody(
    pending.challenge_original_bytes,
    pending.challenge_custody_sha256,
    "invalid_request",
  );
  await requireCustody(command.commandBytes, command.commandCustodySHA256, "invalid_request");
  await requireCustody(command.originalBytes, command.originalCustodySHA256, "invalid_request");
}

function commandValues(command: SharedAuthFinancialConsentOriginalCommand): readonly SqlParam[] {
  const { key, selectedScope: scope } = command;
  return [
    key.commandRef,
    key.transactionRef,
    key.registrationRef,
    key.incarnation,
    scope.organizationId,
    scope.workspaceId,
    scope.workspaceRef,
    command.family,
    key.consentRef,
    key.receiptRef,
    new Uint8Array(command.commandBytes).buffer,
    command.commandCustodySHA256,
    new Uint8Array(command.originalBytes).buffer,
    command.originalDigest,
    command.originalCustodySHA256,
    command.capturedAt,
  ];
}
function expectedCapture(input: SharedAuthFinancialConsentCaptureData, recordedAt?: number) {
  const columns = [
    ...pendingColumns.map((name) => `p_${name}`),
    ...commandColumns.map((name) => `c_${name}`),
  ];
  const params: SqlParam[] = pendingColumns.map((name) => {
    const value = input.pending[name as keyof SharedAuthFinancialConsentPendingData];
    return value instanceof Uint8Array ? new Uint8Array(value).buffer : value;
  });
  params.push(...commandValues(input.command));
  if (recordedAt !== undefined) {
    columns.push("recorded_at");
    params.push(recordedAt);
  }
  return {
    cte: `WITH expected(${columns.join(",")}) AS (VALUES (${params.map(() => "?").join(",")}))`,
    params,
  };
}
const pendingMatch = pendingColumns.map((name) => `p.${name} IS e.p_${name}`).join(" AND ");
const commandMatch = commandColumns.map((name) => `c.${name} IS e.c_${name}`).join(" AND ");
const commandPendingMatch = `p.transaction_ref IS e.c_transaction_ref AND p.registration_ref IS e.c_registration_ref AND p.incarnation IS e.c_incarnation
 AND p.organization_id IS e.c_organization_id AND p.workspace_id IS e.c_workspace_id AND p.workspace_ref IS e.c_workspace_ref
 AND e.c_family='${FAMILY}' AND p.created_at<=e.c_captured_at AND e.c_captured_at<p.expires_at`;
const sqlNow =
  "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
const collision = (table: string) =>
  `EXISTS(SELECT 1 FROM ${table} occupied WHERE occupied.command_ref=e.c_command_ref OR occupied.transaction_ref=e.c_transaction_ref OR occupied.consent_ref=e.c_consent_ref OR occupied.receipt_ref=e.c_receipt_ref)`;
function closedStatement(sql: string, params: readonly SqlParam[]): SqlStatement {
  // D1 hard ceiling. Do not split the guard into independently checked writes.
  if (params.length > 100 || (sql.match(/\?/gu)?.length ?? 0) !== params.length)
    return fail("invalid_request");
  return Object.freeze({ sql, params: Object.freeze([...params]) });
}

/** NEW private builder, not an executor. Its ACK must be checked by the future
 * original request owner BEFORE any first consume dispatch. A command-only row
 * cannot distinguish not-yet-dispatched from ACK-unknown, and never permits a
 * consume retry. Any unknown/zero/error remains original-fullcommand GET only.
 */
export async function sharedAuthFinancialConsentCommandCaptureStatement(
  input: SharedAuthFinancialConsentCaptureData,
): Promise<SqlStatement> {
  let captured: SharedAuthFinancialConsentCaptureData;
  try {
    captured = snapshotCapture(input);
  } catch {
    return fail("invalid_request");
  }
  await validateCaptureHashes(captured);
  const { cte, params } = expectedCapture(captured);
  return closedStatement(
    `${cte}
INSERT INTO ${COMMANDS} (${commandColumns.join(",")})
SELECT ${commandColumns.map((name) => `e.c_${name}`).join(",")} FROM ${PENDING} p CROSS JOIN expected e
WHERE ${pendingMatch} AND ${commandPendingMatch}
 AND e.c_captured_at<=${sqlNow} AND ${sqlNow}<p.expires_at
 AND NOT ${collision(COMMANDS)} AND NOT ${collision(ORIGINALS)}
RETURNING ${commandColumns.join(",")}`,
    params,
  );
}

function guardedSQL(captured: ReturnType<typeof snapshotGuarded>) {
  const expected = expectedCapture(captured, captured.recordedAt);
  const where = `${pendingMatch} AND ${commandMatch} AND ${commandPendingMatch}
 AND c.captured_at<=e.recorded_at AND e.recorded_at<p.expires_at AND e.recorded_at<=${sqlNow} AND ${sqlNow}<p.expires_at
 AND (${captured.rpConstraint.sql}) AND (${captured.humanConstraint.sql})`;
  return {
    cte: expected.cte,
    where,
    params: [
      ...expected.params,
      ...captured.rpConstraint.params,
      ...captured.humanConstraint.params,
    ],
  };
}

/** Only fixed same-primary mechanical predicates. No SQL is executed here.
 * A future genuine request-owned executor must bind qualified Root/Clock and
 * Financial original/R1/current-admission inputs and require actual changes=1
 * plus the exact acknowledged postimage. This builder does not supply them.
 */
export async function sharedAuthFinancialConsentOriginalConsumeStatement(
  input: SharedAuthFinancialConsentGuardedStatementData,
): Promise<SqlStatement> {
  let captured: ReturnType<typeof snapshotGuarded>;
  try {
    captured = snapshotGuarded(input);
  } catch {
    return fail("invalid_request");
  }
  await validateCaptureHashes(captured);
  const { cte, where, params } = guardedSQL(captured);
  return closedStatement(
    `${cte}
INSERT INTO ${ORIGINALS} (${originalColumns.join(",")})
SELECT c.consent_ref,c.command_ref,c.transaction_ref,c.receipt_ref,c.registration_ref,c.incarnation,
 c.organization_id,c.workspace_id,c.workspace_ref,c.original_bytes,c.original_digest,c.original_custody_sha256,e.recorded_at,e.recorded_at
FROM ${PENDING} p JOIN ${COMMANDS} c ON c.transaction_ref=p.transaction_ref CROSS JOIN expected e
WHERE ${where} AND NOT ${collision(ORIGINALS)}
RETURNING ${originalColumns.join(",")}`,
    params,
  );
}

/** Query DATA statement only: same original/fullcommand/local constraints in
 * one SELECT. No genuine current verdict/NEW permission/absence-to-resend API.
 * Historical GET recovery is the separate original reader above and continues
 * to work after expiry/retirement; this query intentionally fails those guards.
 */
export async function sharedAuthFinancialConsentLocalCurrentnessStatement(
  input: SharedAuthFinancialConsentGuardedStatementData,
): Promise<SqlStatement> {
  let captured: ReturnType<typeof snapshotGuarded>;
  try {
    captured = snapshotGuarded(input);
  } catch {
    return fail("invalid_request");
  }
  await validateCaptureHashes(captured);
  return localCurrentnessStatement(captured);
}

function localCurrentnessStatement(captured: ReturnType<typeof snapshotGuarded>): SqlStatement {
  const { cte, where, params } = guardedSQL(captured);
  const originalMatch = `o.consent_ref IS c.consent_ref AND o.command_ref IS c.command_ref AND o.transaction_ref IS c.transaction_ref
 AND o.receipt_ref IS c.receipt_ref AND o.registration_ref IS c.registration_ref AND o.incarnation IS c.incarnation
 AND o.organization_id IS c.organization_id AND o.workspace_id IS c.workspace_id AND o.workspace_ref IS c.workspace_ref
 AND o.original_bytes IS c.original_bytes AND o.original_digest IS c.original_digest AND o.original_custody_sha256 IS c.original_custody_sha256
 AND o.recorded_at IS e.recorded_at AND o.receipt_recorded_at IS o.recorded_at`;
  // The actual request Money wrapper routes a leading WITH through a permit
  // batch. Keep the existing bounded expression inside an explicit SELECT so
  // this DATA query takes its audited raw.query route without unwrapping Sql.
  return closedStatement(
    `SELECT ${originalColumns.map((name) => `local_original.${name}`).join(",")} FROM (${cte}
SELECT ${originalColumns.map((name) => `o.${name}`).join(",")} FROM ${ORIGINALS} o
JOIN ${COMMANDS} c ON c.command_ref=o.command_ref JOIN ${PENDING} p ON p.transaction_ref=c.transaction_ref CROSS JOIN expected e
WHERE ${where} AND ${originalMatch} LIMIT 2) AS local_original`,
    params,
  );
}

/** Only the exact metadata forms issued by the immutable leaf are translated.
 * SQLite documents side-effect-free result PRAGMAs as table-valued SELECTs.
 * This is a local reader implementation detail, not a public arbitrary SQL
 * adapter. Leaf FK-on/unique/exact-schema/FK-check predicates remain unchanged.
 * Table-valued forms for the actual D1 target remain UNRUN/unqualified.
 */
function localReadStatement(statement: string, params?: readonly SqlParam[]): SqlStatement {
  if (!/^PRAGMA\b/iu.test(statement.trimStart()))
    return Object.freeze({ sql: statement, ...(params === undefined ? {} : { params }) });
  if (params !== undefined && params.length !== 0) return fail("unavailable");
  if (statement === "PRAGMA foreign_keys")
    return Object.freeze({ sql: "SELECT foreign_keys FROM pragma_foreign_keys" });
  const table =
    /^PRAGMA (table_info|index_list)\((auth_principal_incarnations|shared_principal_bindings|credential_authority_classes)\)$/u.exec(
      statement,
    );
  if (table)
    return table[1] === "table_info"
      ? Object.freeze({ sql: statement })
      : Object.freeze({
          sql: 'SELECT seq,name,"unique",origin,partial FROM pragma_index_list(?) ORDER BY seq',
          params: Object.freeze([table[2]!]),
        });
  const index = /^PRAGMA index_info\((sqlite_autoindex_[A-Za-z0-9_]+)\)$/u.exec(statement);
  if (index && index[1]!.length <= 512)
    return Object.freeze({
      sql: "SELECT seqno,cid,name FROM pragma_index_info(?) ORDER BY seqno",
      params: Object.freeze([index[1]!]),
    });
  const foreignKey =
    /^PRAGMA foreign_key_check\((shared_auth_financial_consent_pending|shared_auth_financial_consent_commands|shared_auth_financial_consent_originals)\)$/u.exec(
      statement,
    );
  if (foreignKey)
    return Object.freeze({
      sql: 'SELECT "table",rowid,parent,fkid FROM pragma_foreign_key_check(?)',
      params: Object.freeze([foreignKey[1]!]),
    });
  // Unknown names/assignment/multi-SQL/alternate syntax have no fallback path.
  return fail("unavailable");
}

/** Request-origin-bound, query-only local row DATA. NOT current permission,
 * accepted explicit consent, an executor or firstdispatch/resend authority.
 * The local closed metadata translation preserves the existing readiness
 * checks while using only this same Money-wrapped Sql.query. No raw accessor.
 */
export function createSharedAuthFinancialConsentLocalCurrentnessReader(
  connection: WorkerRequestSql,
) {
  let graph: ReturnType<typeof readWorkerRequestConsumers>;
  let method: Sql["query"];
  try {
    graph = readWorkerRequestConsumers(connection);
    const descriptor = Object.getOwnPropertyDescriptor(graph.sql, "query");
    if (
      graph.sql !== connection.sql ||
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      return fail("unavailable");
    method = descriptor.value;
  } catch {
    return fail("unavailable");
  }
  const receiver = graph.sql;
  const client = graph.client;
  const realm = graph.realm;
  function sameOrigin(): void {
    try {
      const current = readWorkerRequestConsumers(connection);
      const descriptor = Object.getOwnPropertyDescriptor(current.sql, "query");
      if (
        current !== graph ||
        current.sql !== receiver ||
        current.client !== client ||
        current.realm !== realm ||
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.value !== method
      )
        fail("unavailable");
    } catch {
      fail("unavailable");
    }
  }
  const selectedPort: Pick<Sql, "query"> = Object.freeze({
    async query(statement, params) {
      try {
        sameOrigin();
        const selected = localReadStatement(statement, params);
        const result: readonly Row[] = await Reflect.apply(method, receiver, [
          selected.sql,
          selected.params,
        ]);
        sameOrigin();
        return result;
      } catch {
        // External query/origin rejection is unknown, including a borrowed
        // exported invalid_request/custody_conflict Error. Never absence.
        return fail("unavailable");
      }
    },
  });
  const originals = createSharedAuthFinancialConsentOriginalReader(selectedPort);

  async function readLocalCurrentnessData(
    input: SharedAuthFinancialConsentGuardedStatementData,
  ): Promise<SharedAuthFinancialConsentOriginalData | undefined> {
    sameOrigin();
    let captured: ReturnType<typeof snapshotGuarded>;
    try {
      captured = snapshotGuarded(input);
    } catch {
      return fail("invalid_request");
    }
    // Input/fullcommand/Root expressions are detached before the first await.
    // Historical GET comes first and retains its strict fullcommand custody.
    const historical = await originals.readOriginal(captured.command);
    sameOrigin();
    if (
      historical === undefined ||
      historical.recordedAt !== captured.recordedAt ||
      historical.receiptRecordedAt !== captured.recordedAt ||
      historical.receiptRef !== captured.command.key.receiptRef
    )
      return fail("unavailable");
    await validateCaptureHashes(captured);
    sameOrigin();
    const statement = localCurrentnessStatement(captured);
    let selected: readonly Row[];
    try {
      selected = ownedRows(
        await selectedPort.query(statement.sql, statement.params),
        originalColumns,
      );
    } catch {
      return fail("unavailable");
    }
    sameOrigin();
    if (selected.length === 0) return undefined; // Local nonmatch DATA only.
    if (selected.length !== 1) return fail("unavailable");
    try {
      const row = selected[0]!;
      const original = bytes(row.original_bytes, 16384, "unavailable");
      if (
        !matchesKey(row, captured.command.key) ||
        !matchesScope(row, captured.command.selectedScope) ||
        !sameBytes(original, historical.originalBytes) ||
        text(row.original_digest, "unavailable") !== historical.originalDigest ||
        custodyDigest(row.original_custody_sha256, "unavailable") !==
          historical.originalCustodySHA256 ||
        stamp(row.recorded_at, "unavailable") !== historical.recordedAt ||
        stamp(row.receipt_recorded_at, "unavailable") !== historical.receiptRecordedAt
      )
        return fail("unavailable");
    } catch {
      return fail("unavailable");
    }
    sameOrigin();
    // No SqlWrite/changes1 fabrication and no ACK14 validator reuse for SELECT.
    // This historical detached DATA does not become NEW/current authority.
    return historical;
  }
  return Object.freeze({ readLocalCurrentnessData });
}

/** Mechanical command-capture postimage DATA only. Even a caller-constructed
 * matching SqlWrite can pass this check: it has no Sql/native/request origin,
 * current consent, NEW/consume permission or firstdispatch capability. A future
 * genuine request owner must bind its same guarded Sql's original write result
 * and phase custody separately. Unknown ACK never permits a resend/new key.
 */
export interface SharedAuthFinancialConsentCommandCapturePostimageData {
  readonly state: "command-capture-postimage-data";
  readonly command: SharedAuthFinancialConsentOriginalCommand;
}

function capturePostimageBytes(
  value: unknown,
  maximum: number,
  code: Code,
): Uint8Array<ArrayBuffer> {
  try {
    const arrayBufferLength = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    )?.get;
    const typedPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
    const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer")?.get;
    const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset")?.get;
    const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength")?.get;
    if (!arrayBufferLength || !typedBuffer || !typedOffset || !typedLength) return fail(code);
    let buffer: ArrayBuffer;
    let offset: unknown = 0;
    let length: unknown;
    if (value instanceof ArrayBuffer) {
      buffer = value;
      length = Reflect.apply(arrayBufferLength, value, []);
    } else if (value instanceof Uint8Array) {
      const selected: unknown = Reflect.apply(typedBuffer, value, []);
      if (!(selected instanceof ArrayBuffer)) return fail(code); // No shared backing store.
      buffer = selected;
      offset = Reflect.apply(typedOffset, value, []);
      length = Reflect.apply(typedLength, value, []);
    } else return fail(code);
    const capacity: unknown = Reflect.apply(arrayBufferLength, buffer, []);
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > maximum ||
      typeof capacity !== "number" ||
      offset + length > capacity
    )
      return fail(code);
    // Native internal-slot reads bypass caller accessors, Proxy get traps and
    // species/constructor getters. The standard view and copy are unaliased.
    return new Uint8Array(new Uint8Array(buffer, offset, length));
  } catch {
    return fail(code);
  }
}

/** Validate the existing capture45 INSERT RETURNING's actual16 column DATA.
 * This executes no SQL, read/retry, Clock/key operation or dispatch. Both full
 * expected command and supplied result are detached before the first await.
 */
export async function requireSharedAuthFinancialConsentCommandCapturePostimage(
  result: SqlWrite,
  expected: SharedAuthFinancialConsentOriginalCommand,
): Promise<SharedAuthFinancialConsentCommandCapturePostimageData> {
  let command: SharedAuthFinancialConsentOriginalCommand;
  try {
    const raw = exactOwn(expected, commandNames, "invalid_request");
    command = snapshotCommand({
      ...raw,
      commandBytes: capturePostimageBytes(raw.commandBytes, 65536, "invalid_request"),
      originalBytes: capturePostimageBytes(raw.originalBytes, 16384, "invalid_request"),
    });
  } catch {
    return fail("invalid_request");
  }
  try {
    const write = exactOwn(result, ["changes", "rows"], "unavailable");
    if (write.changes !== 1 || !Array.isArray(write.rows)) return fail("unavailable");
    const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(
      write.rows,
    );
    const length = descriptors.length;
    const first = descriptors["0"];
    if (
      !length ||
      !Object.hasOwn(length, "value") ||
      length.value !== 1 ||
      Reflect.ownKeys(descriptors).length !== 2 ||
      !first ||
      !Object.hasOwn(first, "value") ||
      first.enumerable !== true
    )
      return fail("unavailable");
    const row = exactOwn(first.value, commandColumns, "unavailable");
    const commandBytes = capturePostimageBytes(row.command_bytes, 65536, "unavailable");
    const originalBytes = capturePostimageBytes(row.original_bytes, 16384, "unavailable");
    if (
      !matchesKey(row, command.key) ||
      !matchesScope(row, command.selectedScope) ||
      row.family !== command.family ||
      !sameBytes(commandBytes, command.commandBytes) ||
      row.command_custody_sha256 !== command.commandCustodySHA256 ||
      !sameBytes(originalBytes, command.originalBytes) ||
      row.original_digest !== command.originalDigest ||
      row.original_custody_sha256 !== command.originalCustodySHA256 ||
      stamp(row.captured_at, "unavailable") !== command.capturedAt
    )
      return fail("unavailable");
  } catch {
    return fail("unavailable");
  }
  // Exact equality above binds the detached returned bytes/digests to these
  // snapshots. Any hash/crypto failure is unavailable, never a positive ACK.
  try {
    await requireCustody(command.commandBytes, command.commandCustodySHA256, "unavailable");
    await requireCustody(command.originalBytes, command.originalCustodySHA256, "unavailable");
  } catch {
    return fail("unavailable");
  }
  return Object.freeze({ state: "command-capture-postimage-data", command });
}

function snapshotRequestCommand(input: unknown): SharedAuthFinancialConsentOriginalCommand {
  const raw = exactOwn(input, commandNames, "invalid_request");
  return snapshotCommand({
    ...raw,
    commandBytes: capturePostimageBytes(raw.commandBytes, 65536, "invalid_request"),
    originalBytes: capturePostimageBytes(raw.originalBytes, 16384, "invalid_request"),
  });
}

function snapshotRequestCapture(input: unknown): SharedAuthFinancialConsentCaptureData {
  const raw = exactOwn(input, ["pending", "command"], "invalid_request");
  const pending = exactOwn(raw.pending, pendingColumns, "invalid_request");
  return snapshotCapture({
    pending: {
      ...pending,
      action_original_bytes: capturePostimageBytes(
        pending.action_original_bytes,
        16384,
        "invalid_request",
      ),
      terms_original_bytes: capturePostimageBytes(
        pending.terms_original_bytes,
        16384,
        "invalid_request",
      ),
      challenge_original_bytes: capturePostimageBytes(
        pending.challenge_original_bytes,
        16384,
        "invalid_request",
      ),
    },
    command: snapshotRequestCommand(raw.command),
  });
}

/** Accepted literal v4 codec, with only same-namespace storage mappings.
 * This never supplies genuine issuer/credential/Clock/currentness provenance.
 */
async function requireOriginalRecipe(
  command: SharedAuthFinancialConsentOriginalCommand,
  code: Code,
) {
  let original: Awaited<ReturnType<typeof parseSharedAuthFinancialActionConsentOriginal>>;
  try {
    original = await parseSharedAuthFinancialActionConsentOriginal(command.originalBytes);
  } catch (error) {
    if (error instanceof TypeError) return fail(code);
    throw error;
  }
  const scope = command.selectedScope;
  if (
    original.consentRef !== command.key.consentRef ||
    original.consentDigest !== command.originalDigest ||
    original.consentIssuer.registrationRef !== command.key.registrationRef ||
    original.consentIssuer.incarnation !== command.key.incarnation ||
    original.path.organizationId !== scope.organizationId ||
    original.path.workspaceId !== scope.workspaceId ||
    original.path.workspaceRef !== scope.workspaceRef ||
    original.acceptedAt > command.capturedAt ||
    command.capturedAt >= original.expiresAt
  )
    return fail(code);
  return original;
}

async function requireCaptureRecipe(
  input: SharedAuthFinancialConsentCaptureData,
  code: Code,
): Promise<void> {
  const { pending, command } = input;
  const original = await requireOriginalRecipe(command, code);
  const canonicalBytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
  // Private pending representation is exact canonical action/challenge JSON,
  // not another external wire or a hash-only assertion of original equality.
  if (
    pending.registration_ref !== original.consentIssuer.registrationRef ||
    pending.incarnation !== original.consentIssuer.incarnation ||
    pending.organization_id !== original.path.organizationId ||
    pending.workspace_id !== original.path.workspaceId ||
    pending.workspace_ref !== original.path.workspaceRef ||
    pending.action_kind !== original.action.kind ||
    pending.action_ref !== original.action.reference ||
    pending.request_fingerprint !== original.actionRequestFingerprint ||
    pending.challenge_ref !== original.challenge.challengeRef ||
    !sameBytes(pending.action_original_bytes, canonicalBytes(original.action)) ||
    !sameBytes(pending.challenge_original_bytes, canonicalBytes(original.challenge)) ||
    pending.principal_id !== original.rpSession.observedPrincipalId ||
    pending.principal_binding_ref !== original.principalBinding.ref ||
    pending.authority_ref !== original.credentialClass.ref ||
    pending.credential_incarnation !== original.credentialClass.incarnation ||
    pending.created_at > original.acceptedAt ||
    original.expiresAt > pending.expires_at ||
    pending.terms_digest_original !== original.selectedTerms.digest
  )
    return fail(code);
  let terms: string;
  try {
    terms = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      pending.terms_original_bytes,
    );
  } catch {
    return fail(code);
  }
  if (
    terms.length < 1 ||
    terms.length > 8192 ||
    !sameBytes(new TextEncoder().encode(terms), pending.terms_original_bytes)
  )
    return fail(code);
  // Financial's original raw-byte terms digest is kept verbatim. It is not
  // the consent-domain digest nor a reconstructed disclosure/ref alias.
  if ((await bytesDigest(pending.terms_original_bytes)) !== original.selectedTerms.digest)
    return fail(code);
  await requireCustody(pending.action_original_bytes, pending.action_custody_sha256, code);
  await requireCustody(pending.terms_original_bytes, pending.terms_custody_sha256, code);
  await requireCustody(pending.challenge_original_bytes, pending.challenge_custody_sha256, code);
  // principalBinding.incarnation/proofRef/issuer origin and selectedTerms.ref
  // have no extra mapped leaf column. Preserve them in the original BLOB;
  // genuine owning readers must bind them, never infer from another namespace.
}

/** Existing module-origin construction only, not human/credential/currentness
 * or durable phase authority. No arbitrary Sql/callback/brand is accepted.
 */
function captureRequestCommandSql(connection: WorkerRequestSql) {
  let graph: ReturnType<typeof readWorkerRequestConsumers>;
  let run: Sql["run"];
  let query: Sql["query"];
  try {
    graph = readWorkerRequestConsumers(connection);
    const runDescriptor = Object.getOwnPropertyDescriptor(graph.sql, "run");
    const queryDescriptor = Object.getOwnPropertyDescriptor(graph.sql, "query");
    if (
      graph.sql !== connection.sql ||
      !runDescriptor ||
      !Object.hasOwn(runDescriptor, "value") ||
      typeof runDescriptor.value !== "function" ||
      !queryDescriptor ||
      !Object.hasOwn(queryDescriptor, "value") ||
      typeof queryDescriptor.value !== "function"
    )
      return fail("unavailable");
    run = runDescriptor.value;
    query = queryDescriptor.value;
  } catch {
    return fail("unavailable");
  }
  const receiver = graph.sql;
  const client = graph.client;
  const realm = graph.realm;
  function sameOrigin(): void {
    try {
      const current = readWorkerRequestConsumers(connection);
      const runDescriptor = Object.getOwnPropertyDescriptor(current.sql, "run");
      const queryDescriptor = Object.getOwnPropertyDescriptor(current.sql, "query");
      if (
        current !== graph ||
        current.sql !== receiver ||
        current.client !== client ||
        current.realm !== realm ||
        !runDescriptor ||
        !Object.hasOwn(runDescriptor, "value") ||
        runDescriptor.value !== run ||
        !queryDescriptor ||
        !Object.hasOwn(queryDescriptor, "value") ||
        queryDescriptor.value !== query
      )
        fail("unavailable");
    } catch {
      fail("unavailable");
    }
  }
  const queryPort: Pick<Sql, "query"> = Object.freeze({
    async query(statement, params) {
      sameOrigin();
      try {
        const selected = localReadStatement(statement, params);
        const rows: readonly Row[] = await Reflect.apply(query, receiver, [
          selected.sql,
          selected.params,
        ]);
        sameOrigin();
        return rows;
      } catch {
        sameOrigin();
        return fail("unavailable");
      }
    },
  });
  return Object.freeze({
    sameOrigin,
    queryPort,
    async runCapture(statement: SqlStatement): Promise<SqlWrite> {
      sameOrigin();
      try {
        const result: SqlWrite = await Reflect.apply(run, receiver, [
          statement.sql,
          statement.params,
        ]);
        sameOrigin();
        return result;
      } catch {
        sameOrigin();
        return fail("unavailable");
      }
    },
  });
}

/** UNMOUNTED low-level effect: one explicit call, one original Sql.run only.
 * The call itself is NOT first-attempt/NEW/resend admission. No durable phase,
 * genuine credential/human/Clock or Financial R1 is supplied here, so this must
 * not be mounted as a request route. Recalling this function or constructing a
 * new facade does not authorize another dispatch. On any unknown/zero/error,
 * the caller must retain its original custody and use GET-only recovery.
 */
export async function captureSharedAuthFinancialConsentRequestCommandData(
  connection: WorkerRequestSql,
  input: SharedAuthFinancialConsentCaptureData,
): Promise<SharedAuthFinancialConsentCommandCapturePostimageData> {
  const port = captureRequestCommandSql(connection);
  let captured: SharedAuthFinancialConsentCaptureData;
  try {
    captured = snapshotRequestCapture(input);
  } catch {
    return fail("invalid_request");
  }
  port.sameOrigin();
  try {
    // Enforce the actual accepted recipe at the real write callsite. Invalid
    // canonical original/action/terms/key is rejected with zero Sql.run calls.
    await requireCaptureRecipe(captured, "invalid_request");
    port.sameOrigin();
  } catch (error) {
    port.sameOrigin();
    if (error instanceof SharedAuthFinancialConsentOriginalReadError) throw error;
    return fail("unavailable");
  }
  try {
    port.sameOrigin();
    const statement = await sharedAuthFinancialConsentCommandCaptureStatement(captured);
    port.sameOrigin();
    const result = await port.runCapture(statement);
    port.sameOrigin();
    // Only the actual captured receiver's return is accepted here. Expected
    // is the same detached original used by the unchanged capture45 builder.
    const data = await requireSharedAuthFinancialConsentCommandCapturePostimage(
      result,
      captured.command,
    );
    port.sameOrigin();
    return data;
  } catch {
    port.sameOrigin();
    return fail("unavailable");
  }
}

/** Query-only, fixed original fullcommand. Create while holding that original
 * custody, before any effect/unknown. It has no capture/retry/new-key/consume
 * method, and recreating it grants no write or durable phase permission.
 */
export function createSharedAuthFinancialConsentRequestCommandRecovery(
  connection: WorkerRequestSql,
  originalCommand: SharedAuthFinancialConsentOriginalCommand,
) {
  const port = captureRequestCommandSql(connection);
  let command: SharedAuthFinancialConsentOriginalCommand;
  try {
    command = snapshotRequestCommand(originalCommand);
  } catch {
    return fail("invalid_request");
  }
  const originals = createSharedAuthFinancialConsentOriginalReader(port.queryPort);
  async function readOriginalData(): Promise<SharedAuthFinancialConsentOriginalData> {
    port.sameOrigin();
    try {
      const original = await originals.readOriginal(command);
      port.sameOrigin();
      if (original === undefined) return fail("unavailable");
      return original;
    } catch (error) {
      port.sameOrigin();
      // The captured query boundary and original reader already normalize
      // external query/row failures. Preserve only that reader's own occupied
      // fullcommand conflict; absence/unknown is never recovery permission.
      if (
        error instanceof SharedAuthFinancialConsentOriginalReadError &&
        error.code === "custody_conflict"
      )
        throw error;
      return fail("unavailable");
    }
  }
  return Object.freeze({ readOriginalData });
}

function snapshotRequestGuarded(input: unknown): SharedAuthFinancialConsentGuardedStatementData {
  const raw = exactOwn(
    input,
    ["pending", "command", "recordedAt", "credential", "human", "currentSession"],
    "invalid_request",
  );
  const capture = snapshotRequestCapture({ pending: raw.pending, command: raw.command });
  const current = exactOwn(
    raw.currentSession,
    ["version", "absoluteExpiresAt", "lastUsedAt"],
    "invalid_request",
  );
  const captured = Object.freeze({
    ...capture,
    recordedAt: stamp(raw.recordedAt, "invalid_request"),
    credential: snapshotCredential(raw.credential),
    human: snapshotHuman(raw.human),
    currentSession: Object.freeze({
      version: stamp(current.version, "invalid_request"),
      absoluteExpiresAt: stamp(current.absoluteExpiresAt, "invalid_request"),
      lastUsedAt: stamp(current.lastUsedAt, "invalid_request"),
    }),
  });
  // Run the existing closed tuple/Root-expression validation synchronously too.
  // No authority is created: the detached inputs remain caller-supplied DATA.
  snapshotGuarded(captured);
  // The same immutable timestamp ordering already required by consume SQL can
  // reject a contradictory input before capture. No fresh/current Clock is
  // read here; elapsed time and revocation stay guarded by actual consume SQL.
  if (
    captured.recordedAt < captured.command.capturedAt ||
    captured.recordedAt >= captured.pending.expires_at
  )
    return fail("invalid_request");
  return captured;
}

/** UNMOUNTED ordered DATA effect, not NEW/first-attempt/permission admission.
 * The same captured request-origin Sql performs capture45 and then consume81
 * only when THIS invocation receives its actual strict ACK16. The two writes
 * are separate Money transactions, not an atomic operation across both writes
 * or a durable proof that consume has never been attempted. Command-only after
 * a crash/unknown remains unavailable; re-entry never grants a resend lease.
 * Genuine pending/human/Clock/R1/current admission and durable resume protocols
 * are still missing, so this must not be exposed as a request route.
 */
export async function captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(
  connection: WorkerRequestSql,
  input: SharedAuthFinancialConsentGuardedStatementData,
): Promise<SharedAuthFinancialConsentOriginalData> {
  const port = captureRequestCommandSql(connection);
  let captured: SharedAuthFinancialConsentGuardedStatementData;
  try {
    captured = snapshotRequestGuarded(input);
  } catch {
    return fail("invalid_request");
  }
  const capture = Object.freeze({ pending: captured.pending, command: captured.command });
  const expected = Object.freeze({
    key: captured.command.key,
    selectedScope: captured.command.selectedScope,
    originalBytes: new Uint8Array(captured.command.originalBytes),
    originalDigest: captured.command.originalDigest,
    originalCustodySHA256: captured.command.originalCustodySHA256,
    recordedAt: captured.recordedAt,
  });
  const originals = createSharedAuthFinancialConsentOriginalReader(port.queryPort);
  let captureStatement: SqlStatement;
  let consumeStatement: SqlStatement;
  // Finish canonical/hash/guard-input and both statement construction checks
  // before the first write. SQL currentness is still checked at consume itself;
  // a preflight is not after-await genuine time or current permission.
  port.sameOrigin();
  try {
    await requireCaptureRecipe(capture, "invalid_request");
    port.sameOrigin();
    captureStatement = await sharedAuthFinancialConsentCommandCaptureStatement(capture);
    port.sameOrigin();
    consumeStatement = await sharedAuthFinancialConsentOriginalConsumeStatement(captured);
    port.sameOrigin();
  } catch (error) {
    port.sameOrigin();
    if (
      error instanceof SharedAuthFinancialConsentOriginalReadError &&
      error.code === "invalid_request"
    )
      throw error;
    return fail("unavailable");
  }
  try {
    port.sameOrigin();
    const capturedWrite = await port.runCapture(captureStatement);
    port.sameOrigin();
    // No caller-supplied ACK/boolean/once flag is accepted. Only this actual
    // return, against the same detached original, reaches the second write.
    await requireSharedAuthFinancialConsentCommandCapturePostimage(capturedWrite, captured.command);
    port.sameOrigin();
    const consumedWrite = await port.runCapture(consumeStatement);
    port.sameOrigin();
    // The leaf ACK14 helper compares all values but permits extra scalar keys.
    // Strictly snapshot the actual SqlWrite/closed14 rows before its first
    // await; preserve actual changes and never synthesize rows or changes=1.
    const actual = exactOwn(consumedWrite, ["changes", "rows"], "unavailable");
    const strictWrite: SqlWrite = Object.freeze({
      changes: actual.changes === 1 ? actual.changes : fail("unavailable"),
      rows: ownedRows(actual.rows, originalColumns),
    });
    await requireSharedAuthFinancialConsentConsumePostimage(strictWrite, expected);
    port.sameOrigin();
    const original = await originals.readOriginal(captured.command);
    port.sameOrigin();
    if (
      original === undefined ||
      original.recordedAt !== captured.recordedAt ||
      original.receiptRecordedAt !== captured.recordedAt
    )
      return fail("unavailable");
    return original;
  } catch {
    port.sameOrigin();
    // No automatic capture/consume retry or new key/family. Even an acknowledged
    // command can have committed consume with lost ACK. The caller must keep
    // the original fullcommand and use the separate query-only recovery port.
    // This effect reports post-write failures as unavailable; the unchanged
    // recovery reader retains its own genuine occupied-custody conflict code.
    return fail("unavailable");
  }
}

/** Actual pending-row DATA only: no command/consent/receipt echo is returned.
 * This is not durable fullcommand custody or first-attempt/NEW admission.
 */
export interface SharedAuthFinancialConsentPendingPersistenceData {
  readonly state: "pending-persistence-postimage-data";
  readonly pending: SharedAuthFinancialConsentPendingData;
}

function snapshotPendingBoundary(
  input: unknown,
  code: Code,
): SharedAuthFinancialConsentPendingData {
  try {
    const row = exactOwn(input, pendingColumns, code);
    return snapshotPending({
      ...row,
      action_original_bytes: capturePostimageBytes(row.action_original_bytes, 16384, code),
      terms_original_bytes: capturePostimageBytes(row.terms_original_bytes, 16384, code),
      challenge_original_bytes: capturePostimageBytes(row.challenge_original_bytes, 16384, code),
    });
  } catch {
    return fail(code);
  }
}

function samePending(
  a: SharedAuthFinancialConsentPendingData,
  b: SharedAuthFinancialConsentPendingData,
): boolean {
  return pendingColumns.every((column) => {
    const name = column as keyof SharedAuthFinancialConsentPendingData;
    const left = a[name];
    const right = b[name];
    return left instanceof Uint8Array && right instanceof Uint8Array
      ? sameBytes(left, right)
      : left === right;
  });
}

function pendingRows(input: unknown): readonly SharedAuthFinancialConsentPendingData[] {
  if (!Array.isArray(input)) return fail("unavailable");
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(input);
  const length: unknown = descriptors.length?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 2 ||
    Reflect.ownKeys(descriptors).length !== length + 1
  )
    return fail("unavailable");
  const rows: SharedAuthFinancialConsentPendingData[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)
      return fail("unavailable");
    rows.push(snapshotPendingBoundary(descriptor.value, "unavailable"));
  }
  return Object.freeze(rows);
}

async function pendingCustody(
  pending: SharedAuthFinancialConsentPendingData,
  code: Code,
): Promise<void> {
  await requireCustody(pending.action_original_bytes, pending.action_custody_sha256, code);
  await requireCustody(pending.terms_original_bytes, pending.terms_custody_sha256, code);
  await requireCustody(pending.challenge_original_bytes, pending.challenge_custody_sha256, code);
  let terms: string;
  try {
    terms = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      pending.terms_original_bytes,
    );
  } catch {
    return fail(code);
  }
  if (
    terms.length < 1 ||
    terms.length > 8192 ||
    !sameBytes(new TextEncoder().encode(terms), pending.terms_original_bytes) ||
    (await bytesDigest(pending.terms_original_bytes)) !== pending.terms_digest_original
  )
    return fail(code);
}

function pendingPersistenceStatement(captured: ReturnType<typeof snapshotGuarded>): SqlStatement {
  // Reuse the closed 29+16+time DATA vector and the actual owning Root25+10
  // expressions, not guardedSQL.where (which assumes pre-existing p/c rows).
  // Command fields are constraints ONLY and are NOT persisted by this INSERT.
  const expected = expectedCapture(captured, captured.recordedAt);
  const sameVector =
    "occupied.registration_ref=e.p_registration_ref AND occupied.incarnation=e.p_incarnation AND occupied.challenge_ref=e.p_challenge_ref AND occupied.action_ref=e.p_action_ref";
  const where = `e.p_transaction_ref IS e.c_transaction_ref AND e.p_registration_ref IS e.c_registration_ref AND e.p_incarnation IS e.c_incarnation
 AND e.p_organization_id IS e.c_organization_id AND e.p_workspace_id IS e.c_workspace_id AND e.p_workspace_ref IS e.c_workspace_ref
 AND e.c_family='${FAMILY}' AND e.p_created_at<=e.c_captured_at AND e.c_captured_at<=e.recorded_at
 AND e.recorded_at<e.p_expires_at AND e.recorded_at<=${sqlNow} AND ${sqlNow}<e.p_expires_at
 AND (${captured.rpConstraint.sql}) AND (${captured.humanConstraint.sql})
 AND NOT EXISTS(SELECT 1 FROM ${PENDING} occupied WHERE occupied.transaction_ref=e.p_transaction_ref OR (${sameVector}))
 AND NOT ${collision(COMMANDS)} AND NOT ${collision(ORIGINALS)}`;
  return closedStatement(
    `${expected.cte}
INSERT INTO ${PENDING} (${pendingColumns.join(",")})
SELECT ${pendingColumns.map((name) => `e.p_${name}`).join(",")} FROM expected e
WHERE ${where}
RETURNING ${pendingColumns.join(",")}`,
    [...expected.params, ...captured.rpConstraint.params, ...captured.humanConstraint.params],
  );
}

/** Parameterized DATA builder; no SQL is executed and no authority is minted.
 * Existing original recipe/hash/Root inputs detach before the first await.
 * The INSERT is one guarded CAS; it does not capture or consume a command.
 */
export async function sharedAuthFinancialConsentPendingPersistenceStatement(
  input: SharedAuthFinancialConsentGuardedStatementData,
): Promise<SqlStatement> {
  let captured: SharedAuthFinancialConsentGuardedStatementData;
  try {
    captured = snapshotRequestGuarded(input);
  } catch {
    return fail("invalid_request");
  }
  await requireCaptureRecipe(captured, "invalid_request");
  await validateCaptureHashes(captured);
  return pendingPersistenceStatement(snapshotGuarded(captured));
}

/** UNMOUNTED one-write DATA effect. The actual captured guarded Sql.run result
 * must have changes1 and exactly one closed29 row with every original value.
 * A successful pending ACK does not persist the command/opaque consent/proof
 * or selectedTerms.ref, and never grants capture/consume/NEW/resume permission.
 * Unknown/zero/malformed ACK: retain the original29 input and use GET-only;
 * no automatic retry/new key/family or subsequent capture/consume is called.
 */
export async function persistSharedAuthFinancialConsentRequestPendingData(
  connection: WorkerRequestSql,
  input: SharedAuthFinancialConsentGuardedStatementData,
): Promise<SharedAuthFinancialConsentPendingPersistenceData> {
  const port = captureRequestCommandSql(connection);
  let captured: SharedAuthFinancialConsentGuardedStatementData;
  let guarded: ReturnType<typeof snapshotGuarded>;
  try {
    captured = snapshotRequestGuarded(input);
    guarded = snapshotGuarded(captured);
  } catch {
    return fail("invalid_request");
  }
  port.sameOrigin();
  let statement: SqlStatement;
  try {
    await requireCaptureRecipe(captured, "invalid_request");
    port.sameOrigin();
    await validateCaptureHashes(captured);
    port.sameOrigin();
    statement = pendingPersistenceStatement(guarded);
  } catch (error) {
    port.sameOrigin();
    if (
      error instanceof SharedAuthFinancialConsentOriginalReadError &&
      error.code === "invalid_request"
    )
      throw error;
    return fail("unavailable");
  }
  try {
    if ((await inspectSharedAuthFinancialConsentLeafSchema(port.queryPort)) !== "leaf-present")
      return fail("unavailable");
    port.sameOrigin();
    const result = await port.runCapture(statement);
    port.sameOrigin();
    // Snapshot actual native bytes/descriptors before the first hash await.
    const actual = exactOwn(result, ["changes", "rows"], "unavailable");
    if (actual.changes !== 1) return fail("unavailable");
    const rows = pendingRows(actual.rows);
    if (rows.length !== 1 || !samePending(rows[0]!, captured.pending)) return fail("unavailable");
    const pending = rows[0]!;
    await pendingCustody(pending, "unavailable");
    port.sameOrigin();
    return Object.freeze({ state: "pending-persistence-postimage-data", pending });
  } catch {
    port.sameOrigin();
    return fail("unavailable");
  }
}

/** Query-only historical29 recovery, captured before dispatch/unknown.
 * No command parameter is echoed or treated as stored custody. A complete
 * positive absence returns undefined DATA only, never permission to resend.
 * A pending row alone (even after a positive ACK) does not enable continuation.
 */
export function createSharedAuthFinancialConsentPendingRecovery(
  connection: WorkerRequestSql,
  originalPending: SharedAuthFinancialConsentPendingData,
) {
  const port = captureRequestCommandSql(connection);
  let pending: SharedAuthFinancialConsentPendingData;
  try {
    pending = snapshotPendingBoundary(originalPending, "invalid_request");
  } catch {
    return fail("invalid_request");
  }
  async function readOriginalPendingData(): Promise<
    SharedAuthFinancialConsentPendingData | undefined
  > {
    port.sameOrigin();
    try {
      await pendingCustody(pending, "invalid_request");
    } catch (error) {
      port.sameOrigin();
      if (
        error instanceof SharedAuthFinancialConsentOriginalReadError &&
        error.code === "invalid_request"
      )
        throw error;
      return fail("unavailable");
    }
    port.sameOrigin();
    try {
      if ((await inspectSharedAuthFinancialConsentLeafSchema(port.queryPort)) !== "leaf-present")
        return fail("unavailable");
      port.sameOrigin();
    } catch {
      port.sameOrigin();
      return fail("unavailable");
    }
    let selected: readonly SharedAuthFinancialConsentPendingData[];
    try {
      selected = pendingRows(
        await port.queryPort.query(
          `SELECT ${pendingColumns.join(",")} FROM ${PENDING}
WHERE transaction_ref=? OR (registration_ref=? AND incarnation=? AND challenge_ref=? AND action_ref=?) LIMIT 2`,
          [
            pending.transaction_ref,
            pending.registration_ref,
            pending.incarnation,
            pending.challenge_ref,
            pending.action_ref,
          ],
        ),
      );
    } catch {
      port.sameOrigin();
      return fail("unavailable");
    }
    port.sameOrigin();
    if (selected.length > 1) return fail("custody_conflict");
    if (selected.length === 1) {
      try {
        await pendingCustody(selected[0]!, "unavailable");
      } catch {
        port.sameOrigin();
        return fail("unavailable");
      }
      port.sameOrigin();
      if (!samePending(selected[0]!, pending)) return fail("custody_conflict");
      return selected[0]!;
    }
    // Missing pending with an occupied downstream transaction is not absence.
    // No C/O contents are returned or reconstructed as pending/fullcommand.
    for (const table of [COMMANDS, ORIGINALS]) {
      let rows: readonly Row[];
      try {
        rows = ownedRows(
          await port.queryPort.query(
            `SELECT transaction_ref FROM ${table} WHERE transaction_ref=? LIMIT 2`,
            [pending.transaction_ref],
          ),
          ["transaction_ref"],
        );
      } catch {
        port.sameOrigin();
        return fail("unavailable");
      }
      port.sameOrigin();
      if (rows.length !== 0) return fail("unavailable");
    }
    return undefined;
  }
  return Object.freeze({ readOriginalPendingData });
}

/** Required-row batch builders are DATA only. Each VALUES expected relation has
 * exactly one row; unique LEFT JOINs preserve it. A false/NULL guard deliberately
 * selects NULL into an existing NOT NULL key, causing a SQL constraint error.
 * No WHERE-zero is allowed to silently commit a prefix of the batch.
 */
function requiredPendingPersistenceStatement(
  captured: ReturnType<typeof snapshotGuarded>,
): SqlStatement {
  // Reuse the closed 29+16+time DATA vector and the actual owning Root25+10
  // expressions, not guardedSQL.where (which assumes pre-existing p/c rows).
  // Command fields are constraints ONLY and are NOT persisted by this INSERT.
  const expected = expectedCapture(captured, captured.recordedAt);
  const sameVector =
    "occupied.registration_ref=e.p_registration_ref AND occupied.incarnation=e.p_incarnation AND occupied.challenge_ref=e.p_challenge_ref AND occupied.action_ref=e.p_action_ref";
  const where = `e.p_transaction_ref IS e.c_transaction_ref AND e.p_registration_ref IS e.c_registration_ref AND e.p_incarnation IS e.c_incarnation
 AND e.p_organization_id IS e.c_organization_id AND e.p_workspace_id IS e.c_workspace_id AND e.p_workspace_ref IS e.c_workspace_ref
 AND e.c_family='${FAMILY}' AND e.p_created_at<=e.c_captured_at AND e.c_captured_at<=e.recorded_at
 AND e.recorded_at<e.p_expires_at AND e.recorded_at<=${sqlNow} AND ${sqlNow}<e.p_expires_at
 AND (${captured.rpConstraint.sql}) AND (${captured.humanConstraint.sql})
 AND NOT EXISTS(SELECT 1 FROM ${PENDING} occupied WHERE occupied.transaction_ref=e.p_transaction_ref OR (${sameVector}))
 AND NOT ${collision(COMMANDS)} AND NOT ${collision(ORIGINALS)}`;
  return closedStatement(
    `${expected.cte}
INSERT INTO ${PENDING} (${pendingColumns.join(",")})
SELECT CASE WHEN (${where}) THEN e.p_transaction_ref ELSE NULL END,${pendingColumns
      .slice(1)
      .map((name) => `e.p_${name}`)
      .join(",")} FROM expected e
RETURNING ${pendingColumns.join(",")}`,
    [...expected.params, ...captured.rpConstraint.params, ...captured.humanConstraint.params],
  );
}

function requiredCommandCaptureStatement(
  captured: ReturnType<typeof snapshotGuarded>,
): SqlStatement {
  const { cte, params } = expectedCapture(captured);
  const where = `${pendingMatch} AND ${commandPendingMatch}
 AND e.c_captured_at<=${sqlNow} AND ${sqlNow}<p.expires_at
 AND NOT ${collision(COMMANDS)} AND NOT ${collision(ORIGINALS)}`;
  return closedStatement(
    `${cte}
INSERT INTO ${COMMANDS} (${commandColumns.join(",")})
SELECT CASE WHEN (${where}) THEN e.c_command_ref ELSE NULL END,${commandColumns
      .slice(1)
      .map((name) => `e.c_${name}`)
      .join(",")}
FROM expected e LEFT JOIN ${PENDING} p ON p.transaction_ref=e.p_transaction_ref
RETURNING ${commandColumns.join(",")}`,
    params,
  );
}

function requiredOriginalConsumeStatement(
  captured: ReturnType<typeof snapshotGuarded>,
): SqlStatement {
  const { cte, where, params } = guardedSQL(captured);
  return closedStatement(
    `${cte}
INSERT INTO ${ORIGINALS} (${originalColumns.join(",")})
SELECT CASE WHEN (${where} AND NOT ${collision(ORIGINALS)}) THEN c.consent_ref ELSE NULL END,
 c.command_ref,c.transaction_ref,c.receipt_ref,c.registration_ref,c.incarnation,
 c.organization_id,c.workspace_id,c.workspace_ref,c.original_bytes,c.original_digest,c.original_custody_sha256,e.recorded_at,e.recorded_at
FROM expected e LEFT JOIN ${PENDING} p ON p.transaction_ref=e.p_transaction_ref
 LEFT JOIN ${COMMANDS} c ON c.transaction_ref=p.transaction_ref AND c.command_ref=e.c_command_ref
RETURNING ${originalColumns.join(",")}`,
    params,
  );
}

/** Root's ten-bound-parameter condition is used only by this private,
 * request-owned final statement. The public structural DATA builder above
 * cannot receive or manufacture it. A false condition writes NULL to the
 * original key, so the existing NOT NULL constraint aborts the batch prefix.
 */
function requiredNativeOriginalConsumeStatement(
  captured: ReturnType<typeof snapshotGuarded>,
  nativeCurrentness: ReturnType<typeof financialAuthConsumerSourceCurrentness>,
): SqlStatement {
  if (nativeCurrentness.params.length !== 10) return fail("unavailable");
  const { cte, where, params } = guardedSQL(captured);
  return closedStatement(
    `${cte}
INSERT INTO ${ORIGINALS} (${originalColumns.join(",")})
SELECT CASE WHEN (${where} AND (${nativeCurrentness.sql}) AND NOT ${collision(ORIGINALS)}) THEN c.consent_ref ELSE NULL END,
 c.command_ref,c.transaction_ref,c.receipt_ref,c.registration_ref,c.incarnation,
 c.organization_id,c.workspace_id,c.workspace_ref,c.original_bytes,c.original_digest,c.original_custody_sha256,e.recorded_at,e.recorded_at
FROM expected e LEFT JOIN ${PENDING} p ON p.transaction_ref=e.p_transaction_ref
 LEFT JOIN ${COMMANDS} c ON c.transaction_ref=p.transaction_ref AND c.command_ref=e.c_command_ref
RETURNING ${originalColumns.join(",")}`,
    [...params, ...nativeCurrentness.params],
  );
}

function requiredNativePendingCaptureConsumeStatements(
  captured: ReturnType<typeof snapshotGuarded>,
  nativeCurrentness: ReturnType<typeof financialAuthConsumerSourceCurrentness>,
): readonly SqlStatement[] {
  return Object.freeze([
    requiredPendingPersistenceStatement(captured),
    requiredCommandCaptureStatement(captured),
    requiredNativeOriginalConsumeStatement(captured, nativeCurrentness),
  ]);
}

function requiredPendingCaptureConsumeStatements(
  captured: ReturnType<typeof snapshotGuarded>,
): readonly SqlStatement[] {
  return Object.freeze([
    requiredPendingPersistenceStatement(captured),
    requiredCommandCaptureStatement(captured),
    requiredOriginalConsumeStatement(captured),
  ]);
}

/** Source-only required-row statements, not a caller's NEW/resume admission.
 * Expected binding counts remain81/45/81. SQL/constraint semantics must be
 * qualified on the actual same-primary adapter; this builder performs no SQL.
 */
export async function sharedAuthFinancialConsentPendingCaptureConsumeStatements(
  input: SharedAuthFinancialConsentGuardedStatementData,
): Promise<readonly SqlStatement[]> {
  let captured: SharedAuthFinancialConsentGuardedStatementData;
  try {
    captured = snapshotRequestGuarded(input);
  } catch {
    return fail("invalid_request");
  }
  const guarded = snapshotGuarded(captured);
  await requireCaptureRecipe(captured, "invalid_request");
  await validateCaptureHashes(captured);
  return requiredPendingCaptureConsumeStatements(guarded);
}

function captureRequiredRequestBatchSql(connection: WorkerRequestSql) {
  const selected = captureRequestCommandSql(connection);
  let graph: ReturnType<typeof readWorkerRequestConsumers>;
  let batch: Sql["batch"];
  try {
    graph = readWorkerRequestConsumers(connection);
    const descriptor = Object.getOwnPropertyDescriptor(graph.sql, "batch");
    if (
      graph.sql !== connection.sql ||
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      return fail("unavailable");
    batch = descriptor.value;
  } catch {
    return fail("unavailable");
  }
  const receiver = graph.sql;
  const client = graph.client;
  const realm = graph.realm;
  function sameOrigin(): void {
    selected.sameOrigin();
    try {
      const current = readWorkerRequestConsumers(connection);
      const descriptor = Object.getOwnPropertyDescriptor(current.sql, "batch");
      if (
        current !== graph ||
        current.sql !== receiver ||
        current.client !== client ||
        current.realm !== realm ||
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.value !== batch
      )
        fail("unavailable");
    } catch {
      fail("unavailable");
    }
  }
  const queryPort: Pick<Sql, "query"> = Object.freeze({
    async query(statement, params) {
      sameOrigin();
      try {
        const rows = await selected.queryPort.query(statement, params);
        sameOrigin();
        return rows;
      } catch {
        sameOrigin();
        return fail("unavailable");
      }
    },
  });
  return Object.freeze({
    sameOrigin,
    queryPort,
    async runRequiredBatch(statements: readonly SqlStatement[]): Promise<readonly SqlWrite[]> {
      sameOrigin();
      try {
        // Original Money wrapper receiver/method: one permit INSERT, these
        // three statements, one permit DELETE in its same captured raw batch.
        const result: readonly SqlWrite[] = await Reflect.apply(batch, receiver, [statements]);
        sameOrigin();
        return result;
      } catch {
        sameOrigin();
        return fail("unavailable");
      }
    },
  });
}

function requiredDenseValues(value: unknown, count: number): readonly unknown[] {
  if (!Array.isArray(value)) return fail("unavailable");
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length;
  if (
    !length ||
    !Object.hasOwn(length, "value") ||
    length.value !== count ||
    Reflect.ownKeys(descriptors).length !== count + 1
  )
    return fail("unavailable");
  const rows: unknown[] = [];
  for (let index = 0; index < count; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)
      return fail("unavailable");
    rows.push(descriptor.value);
  }
  return Object.freeze(rows);
}

function snapshotRequiredBatchWrite(value: unknown, columns: readonly string[]): SqlWrite {
  const actual = exactOwn(value, ["changes", "rows"], "unavailable");
  if (actual.changes !== 1) return fail("unavailable");
  const row = exactOwn(requiredDenseValues(actual.rows, 1)[0], columns, "unavailable");
  const detached: Row = Object.create(null);
  for (const column of columns) {
    const value = row[column];
    if (column.endsWith("_bytes"))
      detached[column] = capturePostimageBytes(
        value,
        column === "command_bytes" ? 65536 : 16384,
        "unavailable",
      );
    else if (typeof value === "string" || typeof value === "number") detached[column] = value;
    else return fail("unavailable");
  }
  return Object.freeze({ changes: actual.changes, rows: Object.freeze([Object.freeze(detached)]) });
}

/** UNMOUNTED one-batch DATA effect, not request admission or durable resume.
 * No caller ACK, phase flag, predicate callback or alternate Sql is accepted.
 * Every guard must insert its one exact row or fail at an existing SQL
 * constraint. Only the actual same-primary batch contract can roll back its
 * entire prefix on that failure; JS ACK checks after commit cannot do so.
 * All three statements are submitted together: no JS ACK16 is available
 * between them. Consume instead checks the exact stored command in its SQL.
 *
 * Success retains fullcommand16 plus original14/mandatory receipt beside29.
 * It does not prove that an absent record was never attempted. No invocation,
 * reconstruction, positive absence or command-only state permits a retry/NEW
 * key/family/resume. Unknown is original-fullcommand query-only recovery using
 * the existing port; genuine request/Clock/R1/current admission remain absent.
 */
export async function persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(
  connection: WorkerRequestSql,
  input: SharedAuthFinancialConsentGuardedStatementData,
): Promise<SharedAuthFinancialConsentOriginalData> {
  const port = captureRequiredRequestBatchSql(connection);
  let captured: SharedAuthFinancialConsentGuardedStatementData;
  let guarded: ReturnType<typeof snapshotGuarded>;
  try {
    captured = snapshotRequestGuarded(input);
    guarded = snapshotGuarded(captured);
  } catch {
    return fail("invalid_request");
  }
  const expected = Object.freeze({
    key: captured.command.key,
    selectedScope: captured.command.selectedScope,
    originalBytes: new Uint8Array(captured.command.originalBytes),
    originalDigest: captured.command.originalDigest,
    originalCustodySHA256: captured.command.originalCustodySHA256,
    recordedAt: captured.recordedAt,
  });
  const originals = createSharedAuthFinancialConsentOriginalReader(port.queryPort);
  let statements: readonly SqlStatement[];
  port.sameOrigin();
  try {
    await requireCaptureRecipe(captured, "invalid_request");
    port.sameOrigin();
    await validateCaptureHashes(captured);
    port.sameOrigin();
    statements = requiredPendingCaptureConsumeStatements(guarded);
  } catch (error) {
    port.sameOrigin();
    if (
      error instanceof SharedAuthFinancialConsentOriginalReadError &&
      error.code === "invalid_request"
    )
      throw error;
    return fail("unavailable");
  }
  try {
    if ((await inspectSharedAuthFinancialConsentLeafSchema(port.queryPort)) !== "leaf-present")
      return fail("unavailable");
    port.sameOrigin();
    const results = requiredDenseValues(await port.runRequiredBatch(statements), 3);
    port.sameOrigin();
    // Capture ALL actual closed rows/native bytes before the first hash await.
    // Malformed ACK can follow a commit: it remains unknown, never a rollback
    // assertion or authority to resubmit this batch.
    const pendingWrite = snapshotRequiredBatchWrite(results[0], pendingColumns);
    const commandWrite = snapshotRequiredBatchWrite(results[1], commandColumns);
    const originalWrite = snapshotRequiredBatchWrite(results[2], originalColumns);
    const pending = snapshotPendingBoundary(pendingWrite.rows[0], "unavailable");
    if (!samePending(pending, captured.pending)) return fail("unavailable");
    await pendingCustody(pending, "unavailable");
    port.sameOrigin();
    await requireSharedAuthFinancialConsentCommandCapturePostimage(commandWrite, captured.command);
    port.sameOrigin();
    await requireSharedAuthFinancialConsentConsumePostimage(originalWrite, expected);
    port.sameOrigin();
    const original = await originals.readOriginal(captured.command);
    port.sameOrigin();
    if (
      original === undefined ||
      original.recordedAt !== captured.recordedAt ||
      original.receiptRecordedAt !== captured.recordedAt
    )
      return fail("unavailable");
    return original;
  } catch {
    port.sameOrigin();
    return fail("unavailable");
  }
}

/** Pending/command/recordedAt remain unqualified RP DATA. The credential,
 * current retained session, and separate human binding are never caller fields.
 */
export interface SharedAuthFinancialConsentNativeRequestData
  extends SharedAuthFinancialConsentCaptureData {
  readonly recordedAt: number;
}

/** UNMOUNTED, request-owned DATA effect with Root native currentness inside the
 * final required-row statement of the same captured Sql batch. This does not
 * originate explicit action consent or verify its currentness, and does not
 * supply Financial R1/terms/current NEW admission or first-dispatch CAS.
 * Unknown/failed batch never permits resend; historical GET stays separate.
 */
export async function persistCaptureAndConsumeSharedAuthFinancialConsentNativeRequestData(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  input: SharedAuthFinancialConsentNativeRequestData,
): Promise<SharedAuthFinancialConsentOriginalData> {
  const batch = captureRequiredRequestBatchSql(connection);
  let captured: SharedAuthFinancialConsentNativeRequestData;
  try {
    const raw = exactOwn(input, ["pending", "command", "recordedAt"], "invalid_request");
    const capture = snapshotRequestCapture({ pending: raw.pending, command: raw.command });
    captured = Object.freeze({ ...capture, recordedAt: stamp(raw.recordedAt, "invalid_request") });
    if (
      !(request instanceof Request) ||
      typeof workspaceId !== "string" ||
      workspaceId.length === 0
    )
      return fail("invalid_request");
  } catch {
    return fail("invalid_request");
  }

  let rootPort: NonNullable<ReturnType<typeof readWorkerRequestFinancialAuthConsumerPort>>;
  let rootContext: NonNullable<ReturnType<typeof readWorkerRequestFinancialAuthConsumerContext>>;
  let inputs: ReturnType<typeof readWorkerRequestFinancialInputs>;
  let guarded: ReturnType<typeof snapshotGuarded>;
  const assertRoot = () => {
    batch.sameOrigin();
    try {
      if (
        readWorkerRequestFinancialInputs(connection) !== inputs ||
        readWorkerRequestFinancialAuthConsumerPort(connection) !== rootPort ||
        readWorkerRequestFinancialAuthConsumerContext(connection, rootPort) !== rootContext ||
        rootContext.sql !== inputs.sql ||
        rootContext.realm !== inputs.realm ||
        rootContext.writerEpoch !== inputs.writerEpoch
      )
        return fail("unavailable");
      assertWorkerRequestFinancialAuthConsumerPort(connection, rootPort);
      assertFinancialAuthConsumerPort(rootPort, rootContext);
    } catch {
      return fail("unavailable");
    }
  };
  try {
    batch.sameOrigin();
    inputs = readWorkerRequestFinancialInputs(connection);
    rootPort = readWorkerRequestFinancialAuthConsumerPort(connection) ?? fail("unavailable");
    rootContext =
      readWorkerRequestFinancialAuthConsumerContext(connection, rootPort) ?? fail("unavailable");
    assertRoot();
    const originals = await captureWorkerRequestFinancialAuthRpRequest(
      rootPort,
      request,
      workspaceId,
    );
    assertRoot();
    if (!originals) return fail("unavailable");
    const credential = rootPort.readValidatedCredential(originals.credential);
    assertRoot();
    if (credential.backend !== "shared-rp-session") return fail("unavailable");
    const principal = rootPort.readValidatedPrincipalBinding(originals.userBinding);
    assertRoot();
    const retained = readWorkerRequestRetainedRpCapture(connection, originals.credential);
    assertRoot();
    if (
      !retained ||
      retained.record !== credential.record ||
      retained.current !== credential.current ||
      retained.selectedScope.workspaceId !== workspaceId
    )
      return fail("unavailable");
    guarded = snapshotGuarded(
      snapshotRequestGuarded({
        pending: captured.pending,
        command: captured.command,
        recordedAt: captured.recordedAt,
        credential: retained.record,
        human: principal.binding,
        currentSession: retained.current,
      }),
    );
    assertRoot();
  } catch {
    batch.sameOrigin();
    return fail("unavailable");
  }

  const expected = Object.freeze({
    key: guarded.command.key,
    selectedScope: guarded.command.selectedScope,
    originalBytes: new Uint8Array(guarded.command.originalBytes),
    originalDigest: guarded.command.originalDigest,
    originalCustodySHA256: guarded.command.originalCustodySHA256,
    recordedAt: guarded.recordedAt,
  });
  const originals = createSharedAuthFinancialConsentOriginalReader(batch.queryPort);
  let statements: readonly SqlStatement[];
  try {
    await requireCaptureRecipe(guarded, "invalid_request");
    assertRoot();
    await validateCaptureHashes(guarded);
    assertRoot();
    if ((await inspectSharedAuthFinancialConsentLeafSchema(batch.queryPort)) !== "leaf-present")
      return fail("unavailable");
    assertRoot();
    const nativeCurrentness = financialAuthConsumerSourceCurrentness(rootPort, rootContext);
    assertRoot();
    statements = requiredNativePendingCaptureConsumeStatements(guarded, nativeCurrentness);
    if (statements.length !== 3 || statements[2]?.params?.length !== 91) return fail("unavailable");
    assertRoot();
  } catch {
    assertRoot();
    return fail("unavailable");
  }
  try {
    const results = requiredDenseValues(await batch.runRequiredBatch(statements), 3);
    assertRoot();
    const pendingWrite = snapshotRequiredBatchWrite(results[0], pendingColumns);
    const commandWrite = snapshotRequiredBatchWrite(results[1], commandColumns);
    const originalWrite = snapshotRequiredBatchWrite(results[2], originalColumns);
    const pending = snapshotPendingBoundary(pendingWrite.rows[0], "unavailable");
    if (!samePending(pending, guarded.pending)) return fail("unavailable");
    await pendingCustody(pending, "unavailable");
    assertRoot();
    await requireSharedAuthFinancialConsentCommandCapturePostimage(commandWrite, guarded.command);
    assertRoot();
    await requireSharedAuthFinancialConsentConsumePostimage(originalWrite, expected);
    assertRoot();
    const original = await originals.readOriginal(guarded.command);
    assertRoot();
    if (
      original === undefined ||
      original.recordedAt !== guarded.recordedAt ||
      original.receiptRecordedAt !== guarded.recordedAt
    )
      return fail("unavailable");
    return original;
  } catch {
    assertRoot();
    return fail("unavailable");
  }
}

/**
 * UNMOUNTED DATA effect using the one already captured RP final observation.
 * The original Request/connection/Workspace and Root source Clock are
 * reasserted through the static observation reader across every await. No
 * second final observer, RP touch, reload or capture fallback occurs here.
 * This is not affirmative/current consent or Financial NEW admission.
 */
export async function persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  observation: unknown,
  input: SharedAuthFinancialConsentCaptureData,
): Promise<SharedAuthFinancialConsentOriginalData> {
  const batch = captureRequiredRequestBatchSql(connection);
  let captured: SharedAuthFinancialConsentCaptureData;
  try {
    captured = snapshotRequestCapture(input);
    if (
      !(request instanceof Request) ||
      typeof workspaceId !== "string" ||
      workspaceId.length === 0
    )
      return fail("invalid_request");
  } catch {
    return fail("invalid_request");
  }

  let observed: ReturnType<typeof readSharedAuthFinancialRequestNativeObservationData>;
  let rootPort: NonNullable<ReturnType<typeof readWorkerRequestFinancialAuthConsumerPort>>;
  let rootContext: NonNullable<ReturnType<typeof readWorkerRequestFinancialAuthConsumerContext>>;
  let inputs: ReturnType<typeof readWorkerRequestFinancialInputs>;
  let guarded: ReturnType<typeof snapshotGuarded>;
  const assertBridge = (): void => {
    batch.sameOrigin();
    try {
      const current = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      if (
        readWorkerRequestFinancialInputs(connection) !== inputs ||
        readWorkerRequestFinancialAuthConsumerPort(connection) !== rootPort ||
        readWorkerRequestFinancialAuthConsumerContext(connection, rootPort) !== rootContext ||
        rootContext.sql !== inputs.sql ||
        rootContext.realm !== inputs.realm ||
        rootContext.writerEpoch !== inputs.writerEpoch ||
        current.selectedScope !== observed.selectedScope ||
        current.sampledAt !== observed.sampledAt ||
        current.credential !== observed.credential ||
        current.human !== observed.human ||
        current.currentSession !== observed.currentSession
      )
        fail("unavailable");
      assertWorkerRequestFinancialAuthConsumerPort(connection, rootPort);
      assertFinancialAuthConsumerPort(rootPort, rootContext);
    } catch {
      fail("unavailable");
    }
  };
  try {
    batch.sameOrigin();
    observed = readSharedAuthFinancialRequestNativeObservationData(
      connection,
      request,
      workspaceId,
      observation,
    );
    inputs = readWorkerRequestFinancialInputs(connection);
    rootPort = readWorkerRequestFinancialAuthConsumerPort(connection) ?? fail("unavailable");
    rootContext =
      readWorkerRequestFinancialAuthConsumerContext(connection, rootPort) ?? fail("unavailable");
    assertBridge();
    const selected = observed.selectedScope;
    if (
      selected.workspaceId !== workspaceId ||
      captured.pending.workspace_id !== selected.workspaceId ||
      captured.pending.workspace_ref !== selected.workspaceRef ||
      captured.pending.organization_id !== selected.organizationId ||
      captured.command.selectedScope.workspaceId !== selected.workspaceId ||
      captured.command.selectedScope.workspaceRef !== selected.workspaceRef ||
      captured.command.selectedScope.organizationId !== selected.organizationId
    )
      return fail("invalid_request");
    guarded = snapshotGuarded(
      snapshotRequestGuarded({
        pending: captured.pending,
        command: captured.command,
        recordedAt: observed.sampledAt,
        credential: observed.credential,
        human: observed.human,
        currentSession: observed.currentSession,
      }),
    );
    assertBridge();
  } catch {
    batch.sameOrigin();
    return fail("unavailable");
  }

  const expected = Object.freeze({
    key: guarded.command.key,
    selectedScope: guarded.command.selectedScope,
    originalBytes: new Uint8Array(guarded.command.originalBytes),
    originalDigest: guarded.command.originalDigest,
    originalCustodySHA256: guarded.command.originalCustodySHA256,
    recordedAt: guarded.recordedAt,
  });
  const originals = createSharedAuthFinancialConsentOriginalReader(batch.queryPort);
  let statements: readonly SqlStatement[];
  try {
    await requireCaptureRecipe(guarded, "invalid_request");
    assertBridge();
    await validateCaptureHashes(guarded);
    assertBridge();
    if ((await inspectSharedAuthFinancialConsentLeafSchema(batch.queryPort)) !== "leaf-present")
      return fail("unavailable");
    assertBridge();
    const nativeCurrentness = financialAuthConsumerSourceCurrentness(rootPort, rootContext);
    assertBridge();
    statements = requiredNativePendingCaptureConsumeStatements(guarded, nativeCurrentness);
    if (statements.length !== 3 || statements[2]?.params?.length !== 91) return fail("unavailable");
    assertBridge();
  } catch {
    assertBridge();
    return fail("unavailable");
  }
  try {
    const results = requiredDenseValues(await batch.runRequiredBatch(statements), 3);
    assertBridge();
    const pendingWrite = snapshotRequiredBatchWrite(results[0], pendingColumns);
    const commandWrite = snapshotRequiredBatchWrite(results[1], commandColumns);
    const originalWrite = snapshotRequiredBatchWrite(results[2], originalColumns);
    const pending = snapshotPendingBoundary(pendingWrite.rows[0], "unavailable");
    if (!samePending(pending, guarded.pending)) return fail("unavailable");
    await pendingCustody(pending, "unavailable");
    assertBridge();
    await requireSharedAuthFinancialConsentCommandCapturePostimage(commandWrite, guarded.command);
    assertBridge();
    await requireSharedAuthFinancialConsentConsumePostimage(originalWrite, expected);
    assertBridge();
    const original = await originals.readOriginal(guarded.command);
    assertBridge();
    if (
      original === undefined ||
      original.recordedAt !== guarded.recordedAt ||
      original.receiptRecordedAt !== guarded.recordedAt
    )
      return fail("unavailable");
    return original;
  } catch {
    assertBridge();
    return fail("unavailable");
  }
}

/** Historical external reference DATA. consentProofRef is exactly the already
 * stored canonical consentRef, not a new identifier, digest, prefix or the
 * identityEvidence.proofRef. No NEW/current-consent authority is returned.
 */
export interface SharedAuthFinancialConsentProofReferenceData {
  readonly state: "consent-proof-reference-original-data";
  readonly consentProofRef: string;
  readonly original: SharedAuthFinancialConsentOriginalData;
}

/** Same-request query-only immutable-original lookup. This is unmounted DATA,
 * not a producer/current verifier or a complete request admission port. A ref
 * cannot prove absence of pending29 (which has no consentRef column), so zero
 * command rows are unavailable, never positive absence or permission to write.
 * The original-fullcommand GET recovery API and all write APIs are unchanged.
 */
export function createSharedAuthFinancialConsentProofReferenceReader(connection: WorkerRequestSql) {
  return proofReferenceReaderFromCapturedPort(captureRequestCommandSql(connection));
}

function proofReferenceReaderFromCapturedPort(port: ReturnType<typeof captureRequestCommandSql>) {
  const originals = createSharedAuthFinancialConsentOriginalReader(port.queryPort);

  async function readProofOriginalData(
    input: unknown,
  ): Promise<SharedAuthFinancialConsentProofReferenceData> {
    port.sameOrigin();
    let consentProofRef: string;
    try {
      // Primitive original bytes/code units: no trim, normalization or ref mint.
      consentProofRef = text(input, "invalid_request");
    } catch {
      return fail("invalid_request");
    }
    let command: SharedAuthFinancialConsentOriginalCommand;
    try {
      if ((await inspectSharedAuthFinancialConsentLeafSchema(port.queryPort)) !== "leaf-present")
        return fail("unavailable");
      port.sameOrigin();
      const rows = await port.queryPort.query(
        `SELECT ${commandColumns.join(",")} FROM ${COMMANDS} WHERE consent_ref=? LIMIT 2`,
        [consentProofRef],
      );
      port.sameOrigin();
      // No fabricated SqlWrite/changes value for a SELECT. The exact one row
      // and all16 own data fields are required, then native BLOB copies are
      // taken before the next await by the existing snapshotRequestCommand.
      const row = exactOwn(requiredDenseValues(rows, 1)[0], commandColumns, "unavailable");
      command = snapshotRequestCommand({
        key: {
          registrationRef: row.registration_ref,
          incarnation: row.incarnation,
          transactionRef: row.transaction_ref,
          commandRef: row.command_ref,
          consentRef: row.consent_ref,
          receiptRef: row.receipt_ref,
        },
        selectedScope: {
          organizationId: row.organization_id,
          workspaceId: row.workspace_id,
          workspaceRef: row.workspace_ref,
        },
        family: row.family,
        commandBytes: row.command_bytes,
        commandCustodySHA256: row.command_custody_sha256,
        originalBytes: row.original_bytes,
        originalDigest: row.original_digest,
        originalCustodySHA256: row.original_custody_sha256,
        capturedAt: row.captured_at,
      });
      if (command.key.consentRef !== consentProofRef) return fail("unavailable");
    } catch {
      // SQL/row decoding or stored shape failure, including a borrowed exported
      // error, is unknown. It is not caller-invalid, absence or another family.
      port.sameOrigin();
      return fail("unavailable");
    }

    try {
      // Reuse actual pending29/command16/original14 custody, raw byte hashes,
      // accepted canonical recipe and mandatory same-row receipt validation.
      // Its historical checks do not consult now, retirement or current rows.
      const original = await originals.readOriginal(command);
      port.sameOrigin();
      if (original === undefined || original.command.key.consentRef !== consentProofRef)
        return fail("unavailable");
      return Object.freeze({
        state: "consent-proof-reference-original-data",
        consentProofRef: original.command.key.consentRef,
        original,
      });
    } catch (error) {
      port.sameOrigin();
      if (
        error instanceof SharedAuthFinancialConsentOriginalReadError &&
        error.code === "custody_conflict"
      )
        throw error;
      // Invalid stored canonical bytes/hashes are unavailable here: only the
      // primitive input boundary above may classify an invalid_request.
      return fail("unavailable");
    }
  }
  return Object.freeze({ readProofOriginalData });
}

/** Structural metadata DATA only. Its source/qualification is not established
 * by this interface; no Root credential, distinct human or policyClock is minted.
 * Original pending/fullcommand/recordedAt are deliberately not caller inputs.
 */
export interface SharedAuthFinancialConsentLocalProofInputData {
  readonly consentProofRef: string;
  readonly credential: RpAuthorityRecord;
  readonly human: SharedPrincipalBinding;
  readonly currentSession: SharedAuthFinancialConsentGuardedStatementData["currentSession"];
}

export interface SharedAuthFinancialConsentLocalProofData {
  readonly state: "consent-proof-reference-local-data";
  readonly consentProofRef: string;
  readonly original: SharedAuthFinancialConsentOriginalData;
}

/** Query-only stored-original -> local predicate DATA bridge. This is not a
 * current consent verifier, permission or NEW/resume/first-dispatch authority.
 * Caller metadata is copied DATA, not a genuine Root/Financial source assertion.
 * Historical lookup stays available separately after expiry/retirement. A known
 * historical original with zero local matches is nonmatch DATA only; missing
 * historical custody/byref-zero/SQL unknown never becomes positive absence.
 */
export function createSharedAuthFinancialConsentLocalProofDataReader(connection: WorkerRequestSql) {
  const port = captureRequestCommandSql(connection);
  const historicals = proofReferenceReaderFromCapturedPort(port);

  async function readLocalProofOriginalData(
    input: SharedAuthFinancialConsentLocalProofInputData,
  ): Promise<SharedAuthFinancialConsentLocalProofData | undefined> {
    port.sameOrigin();
    let metadata: SharedAuthFinancialConsentLocalProofInputData;
    try {
      const raw = exactOwn(
        input,
        ["consentProofRef", "credential", "human", "currentSession"],
        "invalid_request",
      );
      const session = exactOwn(
        raw.currentSession,
        ["version", "absoluteExpiresAt", "lastUsedAt"],
        "invalid_request",
      );
      // Fully detach before the first original/hash/query await. Root-owned
      // producers still must qualify these values; structural equality cannot.
      metadata = Object.freeze({
        consentProofRef: text(raw.consentProofRef, "invalid_request"),
        credential: snapshotCredential(raw.credential),
        human: snapshotHuman(raw.human),
        currentSession: Object.freeze({
          version: stamp(session.version, "invalid_request"),
          absoluteExpiresAt: stamp(session.absoluteExpiresAt, "invalid_request"),
          lastUsedAt: stamp(session.lastUsedAt, "invalid_request"),
        }),
      });
    } catch {
      return fail("invalid_request");
    }

    let historical: SharedAuthFinancialConsentProofReferenceData;
    try {
      historical = await historicals.readProofOriginalData(metadata.consentProofRef);
      port.sameOrigin();
    } catch (error) {
      port.sameOrigin();
      if (
        error instanceof SharedAuthFinancialConsentOriginalReadError &&
        error.code === "custody_conflict"
      )
        throw error;
      return fail("unavailable");
    }
    const original = historical.original;
    let pending: SharedAuthFinancialConsentPendingData;
    try {
      const selected = await port.queryPort.query(
        `SELECT ${pendingColumns.join(",")} FROM ${PENDING} WHERE transaction_ref=? LIMIT 2`,
        [original.command.key.transactionRef],
      );
      port.sameOrigin();
      // No caller echo, fake SqlWrite or changes1: this is one actual closed29
      // row with native byte snapshots before subsequent hashing awaits.
      pending = snapshotPendingBoundary(requiredDenseValues(selected, 1)[0], "unavailable");
      if (
        pending.transaction_ref !== original.command.key.transactionRef ||
        pending.registration_ref !== original.command.key.registrationRef ||
        pending.incarnation !== original.command.key.incarnation ||
        pending.organization_id !== original.command.selectedScope.organizationId ||
        pending.workspace_id !== original.command.selectedScope.workspaceId ||
        pending.workspace_ref !== original.command.selectedScope.workspaceRef
      )
        return fail("unavailable");
      await pendingCustody(pending, "unavailable");
      port.sameOrigin();
      await requireCaptureRecipe({ pending, command: original.command }, "unavailable");
      port.sameOrigin();
    } catch {
      port.sameOrigin();
      return fail("unavailable");
    }

    let guarded: ReturnType<typeof snapshotGuarded>;
    try {
      // The only recordedAt is the original, receipt-validated stored timestamp.
      // No now/current clock or mutable later payment scope is inferred here.
      guarded = snapshotGuarded({
        pending,
        command: original.command,
        recordedAt: original.recordedAt,
        credential: metadata.credential,
        human: metadata.human,
        currentSession: metadata.currentSession,
      });
    } catch {
      return fail("invalid_request");
    }
    try {
      const statement = localCurrentnessStatement(guarded);
      const result = await port.queryPort.query(statement.sql, statement.params);
      port.sameOrigin();
      if (Array.isArray(result) && Object.getOwnPropertyDescriptor(result, "length")?.value === 0) {
        requiredDenseValues(result, 0);
        return undefined; // Known historical original, local nonmatch DATA only.
      }
      const row = exactOwn(requiredDenseValues(result, 1)[0], originalColumns, "unavailable");
      const originalBytes = capturePostimageBytes(row.original_bytes, 16384, "unavailable");
      if (
        !matchesKey(row, original.command.key) ||
        !matchesScope(row, original.command.selectedScope) ||
        !sameBytes(originalBytes, original.originalBytes) ||
        text(row.original_digest, "unavailable") !== original.originalDigest ||
        custodyDigest(row.original_custody_sha256, "unavailable") !==
          original.originalCustodySHA256 ||
        stamp(row.recorded_at, "unavailable") !== original.recordedAt ||
        stamp(row.receipt_recorded_at, "unavailable") !== original.receiptRecordedAt
      )
        return fail("unavailable");
      port.sameOrigin();
      return Object.freeze({
        state: "consent-proof-reference-local-data",
        consentProofRef: historical.consentProofRef,
        original,
      });
    } catch {
      port.sameOrigin();
      return fail("unavailable");
    }
  }
  return Object.freeze({ readLocalProofOriginalData });
}
