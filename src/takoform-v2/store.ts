import type { Sql } from "../ports.ts";
import type { V2ConfiguredPrivateInputs } from "./configured-private-inputs.ts";
import type { V2SealedPrivateInputs } from "./private-inputs.ts";
import type { V2Action, V2Effect, V2Status } from "./types.ts";

export interface ResourceRow {
  uid: string;
  principal: string;
  form_url: string;
  space: string;
  name: string;
  backend_id: string;
  target_key: string;
  active_name: string | null;
  generation: number;
  observed_generation: number;
  observed_at: string | null;
  phase: "pending" | "idle" | "deleting" | "error";
  spec_json: string;
  observed_json: string;
  output_json: string;
  last_operation: string;
  busy_operation: string | null;
  deleted_at: string | null;
}

export interface OperationRow {
  id: string;
  resource_uid: string;
  principal: string;
  replay_key: string;
  request_fingerprint: string;
  action: V2Action;
  generation: number;
  status: V2Status;
  effect: V2Effect;
  created_at: string;
  updated_at: string;
  retain_until: string;
  backend_id: string;
  target_key: string;
  backend_key: string;
  accepted_spec_json: string;
  dispatch_possible: number;
  next_attempt_at_ms: number;
  lease_token: string | null;
  lease_until_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  result_observed_json: string | null;
  result_output_json: string | null;
  private_inputs_present: number;
  input_required_names_json: string | null;
  input_required_reason: "expired" | "unavailable" | null;
}

export interface PrivateInputRow {
  operation_id: string;
  names_json: string;
  comparison_key_id: string;
  comparison_tag: string;
  transfer_key_id: string | null;
  transfer_nonce: string | null;
  transfer_ciphertext: string | null;
  transfer_expires_at_ms: number | null;
}

export interface AcceptRecord {
  id: string;
  resourceUid: string;
  principal: string;
  key: string;
  fingerprint: string;
  action: V2Action;
  generation: number;
  at: string;
  retainUntil: string;
  backendId: string;
  targetKey: string;
  specJson: string;
  privateInputs?: V2SealedPrivateInputs;
  configuredPrivateInputs?: V2ConfiguredPrivateInputs;
  expectedConfiguredPrivateInputs?: V2ConfiguredPrivateInputs;
}

const opInsert = `INSERT INTO tf_v2_operations
  (id, resource_uid, principal, replay_key, request_fingerprint, action, generation,
   status, effect, created_at, updated_at, retain_until, backend_id, target_key,
   backend_key, accepted_spec_json, private_inputs_present)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'none', ?, ?, ?, ?, ?, ?, ?, ?)`;
const opInsertIfAccepted = `INSERT INTO tf_v2_operations
  (id, resource_uid, principal, replay_key, request_fingerprint, action, generation,
   status, effect, created_at, updated_at, retain_until, backend_id, target_key,
   backend_key, accepted_spec_json, private_inputs_present)
  SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', 'none', ?, ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (SELECT 1 FROM tf_v2_resources
    WHERE uid = ? AND last_operation = ? AND busy_operation = ? AND generation = ?)`;

// A current referrer publication must settle before its target starts a new
// observation. The accepted edge and busy Operation are checked inside the
// target's own UPDATE statement, not by a preflight read.
const pendingReferrersSql = `SELECT 1 FROM tf_v2_resource_references edge
  JOIN tf_v2_resources referrer ON referrer.uid = edge.referrer_uid
  JOIN tf_v2_operations op ON op.id = referrer.busy_operation
  WHERE edge.target_uid = ? AND referrer.deleted_at IS NULL
    AND referrer.last_operation = op.id AND referrer.generation = op.generation
    AND op.resource_uid = referrer.uid AND op.principal = referrer.principal
    AND op.status IN ('queued', 'running', 'waiting_input', 'reconciling') LIMIT 1`;

function opParams(record: AcceptRecord) {
  return [
    record.id,
    record.resourceUid,
    record.principal,
    record.key,
    record.fingerprint,
    record.action,
    record.generation,
    record.at,
    record.at,
    record.retainUntil,
    record.backendId,
    record.targetKey,
    record.id,
    record.specJson,
    record.privateInputs ? 1 : 0,
  ] as const;
}

function privateWrites(record: AcceptRecord) {
  const sealed = record.privateInputs;
  if (!sealed) return [];
  return [
    {
      sql: `INSERT INTO tf_v2_private_inputs
        (operation_id, names_json, comparison_key_id, comparison_tag, transfer_key_id,
         transfer_nonce, transfer_ciphertext, transfer_expires_at_ms)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM tf_v2_operations WHERE id = ? AND private_inputs_present = 1)`,
      params: [
        record.id,
        sealed.namesJson,
        sealed.comparisonKeyId,
        sealed.comparisonTag,
        sealed.transferKeyId,
        sealed.transferNonce,
        sealed.transferCiphertext,
        sealed.transferExpiresAtMs,
        record.id,
      ],
    },
  ];
}

function configuredPrivateWrites(record: AcceptRecord) {
  const sealed = record.configuredPrivateInputs;
  if (!sealed) return [];
  return [
    {
      sql: `INSERT INTO tf_v2_configured_private_inputs
      (resource_uid, key_id, nonce, ciphertext)
      SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM tf_v2_operations WHERE id = ? AND resource_uid = ?
          AND action = 'create' AND status = 'queued')`,
      params: [
        record.resourceUid,
        sealed.keyId,
        sealed.nonce,
        sealed.ciphertext,
        record.id,
        record.resourceUid,
      ],
    },
  ];
}

function referenceWrites(record: AcceptRecord, referencesJson: string | null) {
  if (referencesJson === null) return [];
  return [
    {
      sql: `INSERT INTO tf_v2_operation_reference_sets (operation_id)
        SELECT ? WHERE EXISTS (SELECT 1 FROM tf_v2_operations
          WHERE id = ? AND status = 'queued')`,
      params: [record.id, record.id],
    },
    {
      sql: `INSERT INTO tf_v2_operation_references
          (operation_id, target_uid, form_url, readiness, target_spec_path, target_spec_equals)
        SELECT ?, json_extract(value, '$.resourceUid'), json_extract(value, '$.formUrl'),
          json_extract(value, '$.readiness'), json_extract(value, '$.targetSpecPath'),
          json_extract(value, '$.targetSpecEquals')
        FROM json_each(?)
        WHERE EXISTS (SELECT 1 FROM tf_v2_operation_reference_sets WHERE operation_id = ?)`,
      params: [record.id, referencesJson, record.id],
    },
    {
      sql: `UPDATE tf_v2_operation_reference_sets SET sealed = 1
        WHERE operation_id = ? AND sealed = 0`,
      params: [record.id],
    },
  ];
}

export function createV2Store(sql: Sql) {
  return {
    async resource(uid: string): Promise<ResourceRow | null> {
      return ((await sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [uid]))[0] ??
        null) as ResourceRow | null;
    },
    async operation(id: string): Promise<OperationRow | null> {
      return ((await sql.query("SELECT * FROM tf_v2_operations WHERE id = ?", [id]))[0] ??
        null) as OperationRow | null;
    },
    async privateInputs(id: string): Promise<PrivateInputRow | null> {
      return ((
        await sql.query("SELECT * FROM tf_v2_private_inputs WHERE operation_id = ?", [id])
      )[0] ?? null) as PrivateInputRow | null;
    },
    async replay(principal: string, key: string): Promise<OperationRow | null> {
      return ((
        await sql.query("SELECT * FROM tf_v2_operations WHERE principal = ? AND replay_key = ?", [
          principal,
          key,
        ])
      )[0] ?? null) as OperationRow | null;
    },
    async activeName(space: string, name: string): Promise<boolean> {
      return (
        (
          await sql.query(
            "SELECT 1 FROM tf_v2_resources WHERE space = ? AND active_name = ? LIMIT 1",
            [space, name],
          )
        ).length > 0
      );
    },
    async hasReferences(uid: string): Promise<boolean> {
      return (
        (
          await sql.query(
            `SELECT 1 FROM tf_v2_resource_references edge
             JOIN tf_v2_resources referrer ON referrer.uid = edge.referrer_uid
             WHERE edge.target_uid = ? AND referrer.deleted_at IS NULL LIMIT 1`,
            [uid],
          )
        ).length > 0
      );
    },
    async list(input: {
      principal: string;
      afterUid?: string;
      space?: string;
      name?: string;
      form?: string;
      limit: number;
    }): Promise<readonly ResourceRow[]> {
      const where = ["principal = ?", "deleted_at IS NULL", "uid > ?"];
      const params: (string | number)[] = [input.principal, input.afterUid ?? ""];
      if (input.space !== undefined) {
        where.push("space = ?");
        params.push(input.space);
      }
      if (input.name !== undefined) {
        where.push("name = ?");
        params.push(input.name);
      }
      if (input.form !== undefined) {
        where.push("form_url = ?");
        params.push(input.form);
      }
      params.push(input.limit);
      return (await sql.query(
        `SELECT * FROM tf_v2_resources WHERE ${where.join(" AND ")}
         ORDER BY uid COLLATE BINARY LIMIT ?`,
        params,
      )) as unknown as ResourceRow[];
    },
    async insertCreate(
      record: AcceptRecord,
      resource: { form: string; space: string; name: string },
      referencesJson: string | null = null,
      initialOutputJson = "{}",
    ): Promise<void> {
      await sql.batch([
        {
          sql: `INSERT INTO tf_v2_resources
            (uid, principal, form_url, space, name, backend_id, target_key,
             active_name, generation, phase,
             spec_json, output_json, last_operation, busy_operation)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?, ?)`,
          params: [
            record.resourceUid,
            record.principal,
            resource.form,
            resource.space,
            resource.name,
            record.backendId,
            record.targetKey,
            resource.name,
            record.specJson,
            initialOutputJson,
            record.id,
            record.id,
          ],
        },
        { sql: opInsert, params: opParams(record) },
        ...privateWrites(record),
        ...configuredPrivateWrites(record),
        ...referenceWrites(record, referencesJson),
      ]);
    },
    async insertChange(
      record: AcceptRecord,
      referencesJson: string | null = null,
      serializeUpdatesWithPendingReferrers = false,
    ): Promise<"accepted" | "dependency_conflict" | "conflict"> {
      const serialize = record.action === "update" && serializeUpdatesWithPendingReferrers;
      const writes = await sql.batch([
        {
          sql: `UPDATE tf_v2_resources SET generation = ?, spec_json = ?,
              phase = ?, last_operation = ?, busy_operation = ?
            WHERE uid = ? AND principal = ? AND deleted_at IS NULL
              AND generation = ? AND busy_operation IS NULL
              ${
                record.action === "delete"
                  ? `AND NOT EXISTS (
                      SELECT 1 FROM tf_v2_resource_references edge
                      JOIN tf_v2_resources referrer ON referrer.uid = edge.referrer_uid
                      WHERE edge.target_uid = ? AND referrer.deleted_at IS NULL)`
                  : ""
              }
              ${serialize ? `AND NOT EXISTS (${pendingReferrersSql})` : ""}
              ${
                record.expectedConfiguredPrivateInputs
                  ? `AND EXISTS (
                SELECT 1 FROM tf_v2_configured_private_inputs
                WHERE resource_uid = ? AND key_id = ? AND nonce = ? AND ciphertext = ?)`
                  : ""
              }`,
          params: [
            record.generation,
            record.specJson,
            record.action === "delete" ? "deleting" : "pending",
            record.id,
            record.id,
            record.resourceUid,
            record.principal,
            record.generation - 1,
            ...(record.action === "delete" ? [record.resourceUid] : []),
            ...(serialize ? [record.resourceUid] : []),
            ...(record.expectedConfiguredPrivateInputs
              ? [
                  record.resourceUid,
                  record.expectedConfiguredPrivateInputs.keyId,
                  record.expectedConfiguredPrivateInputs.nonce,
                  record.expectedConfiguredPrivateInputs.ciphertext,
                ]
              : []),
          ],
        },
        {
          sql: opInsertIfAccepted,
          params: [
            ...opParams(record),
            record.resourceUid,
            record.id,
            record.id,
            record.generation,
          ],
        },
        ...privateWrites(record),
        ...referenceWrites(record, referencesJson),
        ...(serialize
          ? [
              {
                sql: `SELECT 1 FROM tf_v2_resources target
                  WHERE target.uid = ? AND target.principal = ?
                    AND target.deleted_at IS NULL AND target.generation = ?
                    AND target.busy_operation IS NULL
                    AND EXISTS (${pendingReferrersSql}) LIMIT 1`,
                params: [
                  record.resourceUid,
                  record.principal,
                  record.generation - 1,
                  record.resourceUid,
                ],
              },
            ]
          : []),
      ]);
      if (writes[0]?.changes === 1 && writes[1]?.changes === 1) return "accepted";
      if (serialize && writes.at(-1)?.rows.length) return "dependency_conflict";
      return "conflict";
    },
    async nextCandidate(nowMs: number): Promise<OperationRow | null> {
      return ((
        await sql.query(
          `SELECT * FROM tf_v2_operations WHERE next_attempt_at_ms <= ? AND
          (status = 'queued' OR
            (status IN ('running', 'reconciling') AND
              (lease_until_ms IS NULL OR lease_until_ms <= ?)))
         ORDER BY updated_at, created_at, id LIMIT 1`,
          [nowMs, nowMs],
        )
      )[0] ?? null) as OperationRow | null;
    },
    async defer(id: string, nowMs: number, nextMs: number): Promise<boolean> {
      const write = await sql.run(
        `UPDATE tf_v2_operations SET next_attempt_at_ms = ?
         WHERE id = ? AND next_attempt_at_ms <= ?
           AND status IN ('queued', 'running', 'reconciling')`,
        [nextMs, id, nowMs],
      );
      return write.changes === 1;
    },
    async claim(id: string, token: string, nowMs: number, untilMs: number): Promise<boolean> {
      const write = await sql.run(
        `UPDATE tf_v2_operations SET
          status = CASE WHEN dispatch_possible = 1 THEN 'reconciling' ELSE 'running' END,
          effect = CASE WHEN dispatch_possible = 1 THEN 'unknown' ELSE 'none' END,
          lease_token = ?, lease_until_ms = ?
         WHERE id = ? AND next_attempt_at_ms <= ? AND (status = 'queued' OR
           (status IN ('running', 'reconciling') AND
             (lease_until_ms IS NULL OR lease_until_ms <= ?)))`,
        [token, untilMs, id, nowMs, nowMs],
      );
      return write.changes === 1;
    },
    async markDispatch(id: string, token: string, at: string): Promise<boolean> {
      const write = await sql.run(
        `UPDATE tf_v2_operations SET status = 'reconciling', effect = 'unknown',
          dispatch_possible = 1, updated_at = ?
         WHERE id = ? AND lease_token = ? AND status = 'running'`,
        [at, id, token],
      );
      return write.changes === 1;
    },
    async ownsClaim(id: string, token: string): Promise<boolean> {
      return (
        (
          await sql.query(
            "SELECT 1 FROM tf_v2_operations WHERE id = ? AND lease_token = ? LIMIT 1",
            [id, token],
          )
        ).length === 1
      );
    },
    async waitForInputs(
      id: string,
      token: string,
      at: string,
      namesJson: string,
      reason: "expired" | "unavailable",
    ): Promise<boolean> {
      const write = await sql.run(
        `UPDATE tf_v2_operations SET status = 'waiting_input', updated_at = ?,
          input_required_names_json = ?, input_required_reason = ?,
          lease_token = NULL, lease_until_ms = NULL
         WHERE id = ? AND lease_token = ? AND status = 'running'
           AND dispatch_possible = 0 AND private_inputs_present = 1
           AND EXISTS (SELECT 1 FROM tf_v2_private_inputs WHERE operation_id = ?)`,
        [at, namesJson, reason, id, token, id],
      );
      return write.changes === 1;
    },
    async failUnverifiable(
      id: string,
      token: string,
      at: string,
      retainUntil: string,
    ): Promise<boolean> {
      const write = await sql.run(
        `UPDATE tf_v2_operations SET status = 'failed', effect = 'none', updated_at = ?,
          retain_until = CASE WHEN retain_until > ? THEN retain_until ELSE ? END,
          error_code = 'private_inputs_unverifiable',
          error_message = 'Private input comparison material is unavailable',
          lease_token = NULL, lease_until_ms = NULL
         WHERE id = ? AND lease_token = ? AND status = 'running' AND dispatch_possible = 0`,
        [at, retainUntil, retainUntil, id, token],
      );
      return write.changes === 1;
    },
    async replenish(id: string, sealed: V2SealedPrivateInputs, at: string): Promise<boolean> {
      const writes = await sql.batch([
        {
          sql: `UPDATE tf_v2_private_inputs SET transfer_key_id = ?, transfer_nonce = ?,
            transfer_ciphertext = ?, transfer_expires_at_ms = ?
           WHERE operation_id = ? AND EXISTS (
             SELECT 1 FROM tf_v2_operations WHERE id = ? AND status = 'waiting_input'
               AND dispatch_possible = 0 AND lease_token IS NULL)`,
          params: [
            sealed.transferKeyId,
            sealed.transferNonce,
            sealed.transferCiphertext,
            sealed.transferExpiresAtMs,
            id,
            id,
          ],
        },
        {
          sql: `UPDATE tf_v2_operations SET status = 'queued', updated_at = ?,
            next_attempt_at_ms = 0, input_required_names_json = NULL,
            input_required_reason = NULL
           WHERE id = ? AND status = 'waiting_input' AND dispatch_possible = 0
             AND lease_token IS NULL AND EXISTS (
               SELECT 1 FROM tf_v2_private_inputs WHERE operation_id = ?
                 AND transfer_ciphertext = ?)`,
          params: [at, id, id, sealed.transferCiphertext],
        },
      ]);
      return writes[0]?.changes === 1 && writes[1]?.changes === 1;
    },
    async settle(input: {
      id: string;
      token: string;
      status: "succeeded" | "failed" | "reconciling";
      effect: "complete" | "none" | "partial" | "unknown";
      at: string;
      retainUntil: string;
      nextAttemptAtMs?: number;
      error?: { code: string; message: string };
      observedJson?: string;
      outputJson?: string;
    }): Promise<boolean> {
      const write = await sql.run(
        `UPDATE tf_v2_operations SET status = ?, effect = ?, updated_at = ?,
          retain_until = CASE WHEN retain_until > ? THEN retain_until ELSE ? END,
          next_attempt_at_ms = COALESCE(?, next_attempt_at_ms),
          error_code = ?, error_message = ?, result_observed_json = ?,
          result_output_json = ?, lease_token = NULL, lease_until_ms = NULL
         WHERE id = ? AND lease_token = ? AND status = 'reconciling'`,
        [
          input.status,
          input.effect,
          input.at,
          input.retainUntil,
          input.retainUntil,
          input.nextAttemptAtMs ?? null,
          input.error?.code ?? null,
          input.error?.message ?? null,
          input.observedJson ?? null,
          input.outputJson ?? null,
          input.id,
          input.token,
        ],
      );
      return write.changes === 1;
    },
  };
}
