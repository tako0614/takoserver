import { canonicalJson } from "../json.ts";
import type { Sql, SqlParam, SqlStatement, SqlWrite } from "../ports.ts";

const SAGAS = "tf_provider_mutation_sagas_selection_v1";
const ATTESTATIONS = "tf_resource_deletion_attestations";
const EFFECTS = "tf_resource_provider_effects";
const GUARDS = "tf_operation_commit_guards";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SUBEFFECT = /^[a-z][a-z0-9-]{0,63}$/u;
// Use the database clock at the guarded statement's execution point. A Worker
// can queue a D1 batch after sampling its JS clock and outlive the lease.
const SQL_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";

/** An internal Host-ledger ticket, not a native-effect receipt or public Host API. */
export interface TakoformDeleteSubeffectInput {
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly leaseToken: string;
  readonly operationMode: "initial" | "recovery";
  readonly expectedAddress: {
    readonly space: string;
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
  };
  readonly subeffectName: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly nativeId: string;
  /** Digest of a provider-verified, value-free exact native identity. */
  readonly identityDigest: `sha256:${string}`;
}

export interface TakoformDeleteSubeffectIssueInput extends TakoformDeleteSubeffectInput {
  /** An earlier subeffect of this same Delete must have concluded first. */
  readonly requiresSucceededSubeffect?: {
    readonly name: string;
    readonly identityDigest: `sha256:${string}`;
  };
}

export type TakoformDeleteSubeffectRead = "absent" | "issued" | "succeeded" | "conflict";
export type TakoformDeleteSubeffectIssue = "claimed" | "already-issued" | "succeeded" | "conflict";
export type TakoformDeleteSubeffectConclusion = "recorded" | "existing" | "conflict";
type GuardedLedgerBatchResult =
  | { readonly state: "acknowledged"; readonly writes: readonly SqlWrite[] }
  | { readonly state: "unconfirmed" };

/**
 * Host-owned first-issuer custody for one provider Delete subeffect. The
 * provider must independently prove native identity and exact readback. This
 * store authorizes only the D1/SQLite ledger transition; an issued ticket is
 * deliberately never replayed after an unknown native acknowledgement.
 */
export function createTakoformDeleteSubeffectStore(sql: Sql, now: () => number = Date.now) {
  const readExact = async (
    input: TakoformDeleteSubeffectInput,
  ): Promise<TakoformDeleteSubeffectRead> => {
    const expected = normalize(input);
    if (!expected) return "conflict";
    try {
      if (!(await currentAuthority(sql, input, now()))) return "conflict";
      const snapshot = await sql.query(
        `SELECT attestation.effects_json,
                effect.event_id, effect.effect_id, effect.effect_kind, effect.phase,
                effect.operation_mode, effect.provider_pack_ref,
                effect.provider_installation_ref, effect.native_id, effect.target_json
         FROM ${ATTESTATIONS} AS attestation
         LEFT JOIN ${EFFECTS} AS effect
           ON effect.tenant_id = attestation.tenant_id
          AND effect.resource_uid = attestation.resource_uid AND effect.effect_id = ?
         WHERE attestation.tenant_id = ? AND attestation.resource_uid = ?
           AND attestation.state = 'pending'`,
        [expected.effectId, input.tenantId, input.resourceUid],
      );
      if (snapshot.length === 0 || snapshot.length > 3) return "conflict";
      const rows = snapshot.filter((row) => row.effect_id !== null);
      const phases = new Map<Phase, "initial" | "recovery">();
      for (const row of rows) {
        const phase = row.phase;
        if (
          (phase !== "planned" && phase !== "dispatched" && phase !== "succeeded") ||
          row.event_id !== `${expected.effectId}:${phase}` ||
          row.effect_id !== expected.effectId ||
          row.effect_kind !== "delete" ||
          (row.operation_mode !== "initial" && row.operation_mode !== "recovery") ||
          row.provider_pack_ref !== input.providerPackRef ||
          row.provider_installation_ref !== input.providerInstallationRef ||
          row.native_id !== input.nativeId ||
          row.target_json !== expected.targetJson ||
          phases.has(phase)
        )
          return "conflict";
        phases.set(phase, row.operation_mode);
      }
      if (!mirrorsMatch(snapshot[0]?.effects_json, input, expected, phases)) return "conflict";
      if (rows.length === 0) return "absent";
      if (
        !phases.has("planned") ||
        (phases.has("dispatched") && phases.get("planned") !== phases.get("dispatched")) ||
        (phases.has("succeeded") && !phases.has("dispatched"))
      )
        return "conflict";
      // The supported issuer writes both rows and mirrors atomically. Do not
      // reinterpret a partial historical row as a fresh ticket.
      if (!phases.has("dispatched")) return "conflict";
      return phases.has("succeeded") ? "succeeded" : "issued";
    } catch {
      return "conflict";
    }
  };

  const issue = async (
    input: TakoformDeleteSubeffectIssueInput,
  ): Promise<TakoformDeleteSubeffectIssue> => {
    const expected = normalize(input);
    if (!expected || !validPredecessor(input)) return "conflict";
    const before = await readExact(input);
    if (before === "conflict") return "conflict";
    if (before === "issued") return "already-issued";
    if (before === "succeeded") return "succeeded";
    const timestamp = now();
    const firstGuard = guardToken();
    const finalGuard = guardToken();
    const planned = event(input, expected, "planned");
    const dispatched = event(input, expected, "dispatched");
    try {
      const statements: SqlStatement[] = [
        authorityGuard(input, timestamp, firstGuard, input.requiresSucceededSubeffect),
        insertEvent(input, expected, "planned", timestamp),
        insertEvent(input, expected, "dispatched", timestamp),
        mirrorEvent(input, expected, "planned", planned, timestamp),
        mirrorEvent(input, expected, "dispatched", dispatched, timestamp),
        exactPairGuard(input, expected, planned, dispatched, input.operationMode, finalGuard),
        { sql: `DELETE FROM ${GUARDS} WHERE token IN (?, ?)`, params: [firstGuard, finalGuard] },
      ];
      const results = await sql.batch(statements);
      if (results[2]?.changes === 1) return "claimed";
      if (results[2]?.changes !== 0) return "conflict";
      const after = await readExact(input);
      return after === "issued"
        ? "already-issued"
        : after === "succeeded"
          ? "succeeded"
          : "conflict";
    } catch {
      // Even if the D1 acknowledgement was lost, no caller gets the grant.
      return "conflict";
    }
  };

  const concludeExact = async (
    input: TakoformDeleteSubeffectInput,
  ): Promise<TakoformDeleteSubeffectConclusion> => {
    const expected = normalize(input);
    if (!expected) return "conflict";
    const before = await readExact(input);
    if (before === "succeeded") return "existing";
    if (before !== "issued") return "conflict";
    try {
      // The issuer mode is durable and need not match this recovery caller's
      // mode. Carry it into the batch's exact row-and-mirror guard.
      const issued = await sql.query(
        `SELECT phase, operation_mode FROM ${EFFECTS}
         WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
           AND phase IN ('planned', 'dispatched')`,
        [input.tenantId, input.resourceUid, expected.effectId],
      );
      if (
        issued.length !== 2 ||
        !issued.some((row) => row.phase === "planned") ||
        !issued.some((row) => row.phase === "dispatched") ||
        (issued[0]?.operation_mode !== "initial" && issued[0]?.operation_mode !== "recovery") ||
        issued[1]?.operation_mode !== issued[0]?.operation_mode
      )
        return "conflict";
      const issuerMode = issued[0].operation_mode as "initial" | "recovery";
      const issuer = { ...input, operationMode: issuerMode };
      const timestamp = now();
      const firstGuard = guardToken();
      const finalGuard = guardToken();
      const succeeded = event(input, expected, "succeeded");
      const terminalGuard = guardToken();
      const results = await sql.batch([
        authorityGuard(input, timestamp, firstGuard),
        exactPairGuard(
          input,
          expected,
          event(issuer, expected, "planned"),
          event(issuer, expected, "dispatched"),
          issuerMode,
          finalGuard,
        ),
        insertEvent(input, expected, "succeeded", timestamp),
        mirrorEvent(input, expected, "succeeded", succeeded, timestamp),
        exactTerminalGuard(input, expected, succeeded, terminalGuard),
        {
          sql: `DELETE FROM ${GUARDS} WHERE token IN (?, ?, ?)`,
          params: [firstGuard, finalGuard, terminalGuard],
        },
      ]);
      if (results[2]?.changes === 1) return "recorded";
      if (results[2]?.changes !== 0) return "conflict";
      return (await readExact(input)) === "succeeded" ? "existing" : "conflict";
    } catch {
      return "conflict";
    }
  };

  // Internal ledger composition only: this batch never issues a native-effect ticket.
  const runGuardedLedgerBatch = async (
    input: TakoformDeleteSubeffectInput,
    privateStatements: readonly SqlStatement[],
  ): Promise<GuardedLedgerBatchResult> => {
    try {
      if (!normalize(input)) return { state: "unconfirmed" };
      const statements = copyPrivateStatements(privateStatements);
      if (!statements) return { state: "unconfirmed" };
      const timestamp = now();
      const firstGuard = guardToken();
      const finalGuard = guardToken();
      const results = await sql.batch([
        authorityGuard(input, timestamp, firstGuard),
        ...statements,
        authorityGuard(input, timestamp, finalGuard),
        { sql: `DELETE FROM ${GUARDS} WHERE token IN (?, ?)`, params: [firstGuard, finalGuard] },
      ]);
      if (
        !isSqlWrites(results) ||
        results.length !== statements.length + 3 ||
        results[0]?.changes !== 1 ||
        results[statements.length + 1]?.changes !== 1 ||
        results[statements.length + 2]?.changes !== 2
      )
        return { state: "unconfirmed" };
      return {
        state: "acknowledged",
        writes: results.slice(1, statements.length + 1),
      };
    } catch {
      // A thrown batch acknowledgement is unknown: the batch may have committed.
      return { state: "unconfirmed" };
    }
  };

  return { readExact, issue, concludeExact, runGuardedLedgerBatch };
}

function copyPrivateStatements(statements: readonly SqlStatement[]): SqlStatement[] | null {
  if (!Array.isArray(statements) || statements.length < 1) return null;
  const copied: SqlStatement[] = [];
  for (const statement of statements) {
    if (
      !statement ||
      typeof statement.sql !== "string" ||
      statement.sql.trim().length === 0 ||
      !Array.isArray(statement.params) ||
      statement.params.length < 1
    )
      return null;
    const params: SqlParam[] = [];
    for (const value of statement.params) {
      if (typeof value === "string") params.push(value);
      else if (typeof value === "number" && Number.isFinite(value)) params.push(value);
      else if (value === null) params.push(value);
      else if (value instanceof ArrayBuffer) params.push(value.slice(0));
      else return null;
    }
    copied.push({ sql: statement.sql, params });
  }
  return copied;
}

function isSqlWrites(value: unknown): value is readonly SqlWrite[] {
  return Array.isArray(value) && value.every(isSqlWrite);
}

function isSqlWrite(value: unknown): value is SqlWrite {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const write = value as Record<string, unknown>;
  return (
    Array.isArray(write.rows) &&
    Number.isSafeInteger(write.changes) &&
    typeof write.changes === "number" &&
    write.changes >= 0 &&
    write.rows.every((row: unknown) => !!row && typeof row === "object" && !Array.isArray(row))
  );
}

type Expected = { readonly effectId: string; readonly targetJson: string };
type Phase = "planned" | "dispatched" | "succeeded";

function normalize(input: TakoformDeleteSubeffectInput): Expected | null {
  const address = input.expectedAddress;
  if (
    input.operationId.length < 3 ||
    input.operationId.length > 128 ||
    !SUBEFFECT.test(input.subeffectName) ||
    input.tenantId.length < 1 ||
    input.tenantId.length > 255 ||
    input.resourceUid.length < 3 ||
    input.resourceUid.length > 128 ||
    input.fingerprint.length < 2 ||
    input.fingerprint.length > 8192 ||
    input.leaseToken.length < 3 ||
    input.leaseToken.length > 128 ||
    (input.operationMode !== "initial" && input.operationMode !== "recovery") ||
    !address.space ||
    !address.apiVersion ||
    !address.kind ||
    !address.name ||
    !input.providerPackRef ||
    input.providerPackRef.length > 255 ||
    !input.providerInstallationRef ||
    input.providerInstallationRef.length > 255 ||
    !input.nativeId ||
    input.nativeId.length > 4096 ||
    !DIGEST.test(input.identityDigest)
  )
    return null;
  const effectId = `${input.operationId}:${input.subeffectName}`;
  if (effectId.length > 255) return null;
  return {
    effectId,
    targetJson: canonicalJson({
      schema: "takoserver.provider-delete-subeffect@v1",
      subeffectName: input.subeffectName,
      identityDigest: input.identityDigest,
    }),
  };
}

function validPredecessor(input: TakoformDeleteSubeffectIssueInput): boolean {
  const predecessor = input.requiresSucceededSubeffect;
  return (
    predecessor === undefined ||
    (SUBEFFECT.test(predecessor.name) &&
      predecessor.name !== input.subeffectName &&
      `${input.operationId}:${predecessor.name}`.length <= 255 &&
      DIGEST.test(predecessor.identityDigest))
  );
}

function authorityPredicate(input: TakoformDeleteSubeffectInput, timestamp: number) {
  return {
    sql: `EXISTS (
      SELECT 1 FROM ${SAGAS} AS saga
      JOIN ${ATTESTATIONS} AS attestation
        ON attestation.tenant_id = saga.tenant_id
       AND attestation.resource_uid = saga.resource_uid
      WHERE saga.operation_id = ? AND saga.tenant_id = ? AND saga.resource_uid = ?
        AND saga.protocol_generation = 1 AND saga.operation_kind = 'delete'
        AND saga.fingerprint = ? AND saga.phase = 'planned'
        AND saga.receipt_json IS NULL AND saga.execution_started_at IS NOT NULL
        AND saga.execution_lease_token = ? AND saga.execution_lease_until > ?
        AND saga.execution_lease_until > ${SQL_NOW_MS}
        AND saga.accepted_uid = saga.resource_uid
        AND saga.accepted_generation IS NOT NULL AND saga.accepted_revision IS NOT NULL
        AND saga.target_space = ? AND saga.target_api_version = ?
        AND saga.target_kind = ? AND saga.target_name = ?
        AND attestation.space = saga.target_space
        AND attestation.api_version = saga.target_api_version
        AND attestation.kind = saga.target_kind
        AND attestation.name = saga.target_name
        AND attestation.state = 'pending'
        AND EXISTS (
          SELECT 1 FROM ${EFFECTS} AS parent
          WHERE parent.tenant_id = saga.tenant_id AND parent.resource_uid = saga.resource_uid
            AND parent.effect_id = saga.operation_id
            AND parent.event_id = saga.operation_id || ':planned'
            AND parent.effect_kind = 'delete' AND parent.phase = 'planned'
            AND parent.operation_mode = 'initial'
        )
        AND EXISTS (
          SELECT 1 FROM ${EFFECTS} AS parent
          WHERE parent.tenant_id = saga.tenant_id AND parent.resource_uid = saga.resource_uid
            AND parent.effect_id = saga.operation_id
            AND parent.event_id = saga.operation_id || ':dispatched'
            AND parent.effect_kind = 'delete' AND parent.phase = 'dispatched'
            AND parent.operation_mode = 'initial'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${EFFECTS} AS parent
          WHERE parent.tenant_id = saga.tenant_id AND parent.resource_uid = saga.resource_uid
            AND parent.effect_id = saga.operation_id AND parent.phase IN ('succeeded', 'cancelled')
        )
    )`,
    params: [
      input.operationId,
      input.tenantId,
      input.resourceUid,
      input.fingerprint,
      input.leaseToken,
      timestamp,
      input.expectedAddress.space,
      input.expectedAddress.apiVersion,
      input.expectedAddress.kind,
      input.expectedAddress.name,
    ] satisfies SqlParam[],
  };
}

async function currentAuthority(sql: Sql, input: TakoformDeleteSubeffectInput, timestamp: number) {
  const predicate = authorityPredicate(input, timestamp);
  const rows = await sql.query(`SELECT 1 AS valid WHERE ${predicate.sql}`, predicate.params);
  return rows.length === 1;
}

function authorityGuard(
  input: TakoformDeleteSubeffectInput,
  timestamp: number,
  token: string,
  predecessor?: TakoformDeleteSubeffectIssueInput["requiresSucceededSubeffect"],
): SqlStatement {
  const predicate = authorityPredicate(input, timestamp);
  const prior = predecessor
    ? `AND EXISTS (
        SELECT 1 FROM ${EFFECTS} AS terminal
        WHERE terminal.tenant_id = ? AND terminal.resource_uid = ?
          AND terminal.effect_id = ? AND terminal.event_id = ?
          AND terminal.effect_kind = 'delete' AND terminal.phase = 'succeeded'
          AND terminal.provider_pack_ref = ? AND terminal.provider_installation_ref = ?
          AND terminal.native_id = ? AND terminal.target_json = ?
          AND EXISTS (
            SELECT 1 FROM ${EFFECTS} AS issued
            WHERE issued.tenant_id = terminal.tenant_id
              AND issued.resource_uid = terminal.resource_uid
              AND issued.effect_id = terminal.effect_id
              AND issued.event_id = terminal.effect_id || ':dispatched'
              AND issued.effect_kind = 'delete' AND issued.phase = 'dispatched'
              AND issued.provider_pack_ref = terminal.provider_pack_ref
              AND issued.provider_installation_ref = terminal.provider_installation_ref
              AND issued.native_id = terminal.native_id
              AND issued.target_json = terminal.target_json
          )
      )`
    : "";
  const effectId = `${input.operationId}:${predecessor?.name}`;
  const targetJson = predecessor
    ? canonicalJson({
        schema: "takoserver.provider-delete-subeffect@v1",
        subeffectName: predecessor.name,
        identityDigest: predecessor.identityDigest,
      })
    : "";
  return {
    sql: `INSERT INTO ${GUARDS} (token, valid)
          SELECT ?, CASE WHEN ${predicate.sql} ${prior} THEN 1 ELSE 0 END`,
    params: [
      token,
      ...predicate.params,
      ...(predecessor
        ? [
            input.tenantId,
            input.resourceUid,
            effectId,
            `${effectId}:succeeded`,
            input.providerPackRef,
            input.providerInstallationRef,
            input.nativeId,
            targetJson,
          ]
        : []),
    ],
  };
}

function insertEvent(
  input: TakoformDeleteSubeffectInput,
  expected: Expected,
  phase: Phase,
  timestamp: number,
): SqlStatement {
  const authority = authorityPredicate(input, timestamp);
  return {
    sql: `INSERT OR IGNORE INTO ${EFFECTS}
      (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
       operation_mode, provider_pack_ref, provider_installation_ref,
       native_id, target_json, created_at)
      SELECT ?, ?, ?, ?, 'delete', ?, ?, ?, ?, ?, ?, ?
      WHERE ${authority.sql}`,
    params: [
      input.tenantId,
      input.resourceUid,
      `${expected.effectId}:${phase}`,
      expected.effectId,
      phase,
      input.operationMode,
      input.providerPackRef,
      input.providerInstallationRef,
      input.nativeId,
      expected.targetJson,
      timestamp,
      ...authority.params,
    ],
  };
}

function event(input: TakoformDeleteSubeffectInput, expected: Expected, phase: Phase) {
  return canonicalJson({
    eventId: `${expected.effectId}:${phase}`,
    operationId: expected.effectId,
    kind: "delete",
    phase,
    operationMode: input.operationMode,
    providerPackRef: input.providerPackRef,
    providerInstallationRef: input.providerInstallationRef,
    nativeId: input.nativeId,
    target: JSON.parse(expected.targetJson) as Record<string, string>,
  });
}

function mirrorsMatch(
  raw: unknown,
  input: TakoformDeleteSubeffectInput,
  expected: Expected,
  phases: ReadonlyMap<Phase, "initial" | "recovery">,
): boolean {
  if (typeof raw !== "string") return false;
  const events = JSON.parse(raw) as unknown;
  if (!Array.isArray(events)) return false;
  let matched = 0;
  for (const value of events) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.operationId !== expected.effectId &&
      !(
        typeof candidate.eventId === "string" &&
        candidate.eventId.startsWith(`${expected.effectId}:`)
      )
    )
      continue;
    const phase = candidate.phase;
    if (phase !== "planned" && phase !== "dispatched" && phase !== "succeeded") return false;
    const mode = phases.get(phase);
    if (!mode || canonicalJson(value) !== event({ ...input, operationMode: mode }, expected, phase))
      return false;
    matched += 1;
  }
  return matched === phases.size;
}

function mirrorEvent(
  input: TakoformDeleteSubeffectInput,
  expected: Expected,
  phase: Phase,
  eventJson: string,
  timestamp: number,
): SqlStatement {
  const eventId = `${expected.effectId}:${phase}`;
  return {
    sql: `UPDATE ${ATTESTATIONS}
      SET closure_fence = closure_fence + 1,
          effects_json = json_insert(effects_json, '$[#]', json(?)),
          evidence_json = NULL, evidence_ref = NULL,
          evidence_effect_digest = NULL, evidence_checked_at = NULL,
          evidence_status = NULL, updated_at = ?
      WHERE tenant_id = ? AND resource_uid = ? AND state = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${ATTESTATIONS}.effects_json) AS item
          WHERE json_extract(item.value, '$.eventId') = ?
        )
        AND EXISTS (
          SELECT 1 FROM ${EFFECTS} AS effect
          WHERE effect.tenant_id = ${ATTESTATIONS}.tenant_id
            AND effect.resource_uid = ${ATTESTATIONS}.resource_uid
            AND effect.event_id = ? AND effect.effect_id = ?
            AND effect.phase = ? AND effect.target_json = ?
        )`,
    params: [
      eventJson,
      timestamp,
      input.tenantId,
      input.resourceUid,
      eventId,
      eventId,
      expected.effectId,
      phase,
      expected.targetJson,
    ],
  };
}

function exactEffect(
  input: TakoformDeleteSubeffectInput,
  expected: Expected,
  phase: Phase,
  requiredMode?: "initial" | "recovery",
) {
  return {
    sql: `EXISTS (
      SELECT 1 FROM ${EFFECTS}
      WHERE tenant_id = ? AND resource_uid = ? AND event_id = ? AND effect_id = ?
        AND effect_kind = 'delete' AND phase = ?
        AND provider_pack_ref = ? AND provider_installation_ref = ?
        AND native_id = ? AND target_json = ?
        AND operation_mode ${requiredMode ? "= ?" : "IN ('initial', 'recovery')"}
    )`,
    params: [
      input.tenantId,
      input.resourceUid,
      `${expected.effectId}:${phase}`,
      expected.effectId,
      phase,
      input.providerPackRef,
      input.providerInstallationRef,
      input.nativeId,
      expected.targetJson,
      ...(requiredMode ? [requiredMode] : []),
    ] satisfies SqlParam[],
  };
}

function exactMirror(input: TakoformDeleteSubeffectInput, eventJson: string, eventId: string) {
  return {
    sql: `(SELECT COUNT(*) FROM ${ATTESTATIONS} AS attestation,
      json_each(attestation.effects_json) AS item
      WHERE attestation.tenant_id = ? AND attestation.resource_uid = ?
        AND json_extract(item.value, '$.eventId') = ?
        AND item.value = ?) = 1
      AND (SELECT COUNT(*) FROM ${ATTESTATIONS} AS attestation,
      json_each(attestation.effects_json) AS item
      WHERE attestation.tenant_id = ? AND attestation.resource_uid = ?
        AND json_extract(item.value, '$.eventId') = ?) = 1`,
    params: [
      input.tenantId,
      input.resourceUid,
      eventId,
      eventJson,
      input.tenantId,
      input.resourceUid,
      eventId,
    ] satisfies SqlParam[],
  };
}

function exactPairGuard(
  input: TakoformDeleteSubeffectInput,
  expected: Expected,
  plannedJson: string,
  dispatchedJson: string,
  issuedMode: "initial" | "recovery",
  token: string,
): SqlStatement {
  const planned = exactEffect(input, expected, "planned", issuedMode);
  const dispatched = exactEffect(input, expected, "dispatched", issuedMode);
  const plannedMirror = exactMirror(input, plannedJson, `${expected.effectId}:planned`);
  const dispatchedMirror = exactMirror(input, dispatchedJson, `${expected.effectId}:dispatched`);
  const terminalAbsent = {
    sql: `NOT EXISTS (
      SELECT 1 FROM ${EFFECTS}
      WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
        AND phase IN ('succeeded', 'cancelled')
    )`,
    params: [input.tenantId, input.resourceUid, expected.effectId] satisfies SqlParam[],
  };
  const ownMirrorCount = {
    sql: `(SELECT COUNT(*) FROM ${ATTESTATIONS} AS attestation,
      json_each(attestation.effects_json) AS item
      WHERE attestation.tenant_id = ? AND attestation.resource_uid = ?
        AND (json_extract(item.value, '$.operationId') = ?
          OR substr(json_extract(item.value, '$.eventId'), 1, length(?)) = ?)) = 2`,
    params: [
      input.tenantId,
      input.resourceUid,
      expected.effectId,
      `${expected.effectId}:`,
      `${expected.effectId}:`,
    ] satisfies SqlParam[],
  };
  return {
    sql: `INSERT INTO ${GUARDS} (token, valid)
      SELECT ?, CASE WHEN ${planned.sql} AND ${dispatched.sql}
        AND ${plannedMirror.sql} AND ${dispatchedMirror.sql}
        AND ${ownMirrorCount.sql} AND ${terminalAbsent.sql}
        THEN 1 ELSE 0 END`,
    params: [
      token,
      ...planned.params,
      ...dispatched.params,
      ...plannedMirror.params,
      ...dispatchedMirror.params,
      ...ownMirrorCount.params,
      ...terminalAbsent.params,
    ],
  };
}

function exactTerminalGuard(
  input: TakoformDeleteSubeffectInput,
  expected: Expected,
  succeededJson: string,
  token: string,
): SqlStatement {
  const succeeded = exactEffect(input, expected, "succeeded", input.operationMode);
  const mirror = exactMirror(input, succeededJson, `${expected.effectId}:succeeded`);
  return {
    sql: `INSERT INTO ${GUARDS} (token, valid)
      SELECT ?, CASE WHEN ${succeeded.sql} AND ${mirror.sql} THEN 1 ELSE 0 END`,
    params: [token, ...succeeded.params, ...mirror.params],
  };
}

function guardToken(): string {
  return `subeffect_${crypto.randomUUID()}`;
}
