import type { Sql } from "../ports.ts";
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
}

const opInsert = `INSERT INTO tf_v2_operations
  (id, resource_uid, principal, replay_key, request_fingerprint, action, generation,
   status, effect, created_at, updated_at, retain_until, backend_id, target_key,
   backend_key, accepted_spec_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'none', ?, ?, ?, ?, ?, ?, ?)`;
const opInsertIfAccepted = `INSERT INTO tf_v2_operations
  (id, resource_uid, principal, replay_key, request_fingerprint, action, generation,
   status, effect, created_at, updated_at, retain_until, backend_id, target_key,
   backend_key, accepted_spec_json)
  SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', 'none', ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (SELECT 1 FROM tf_v2_resources
    WHERE uid = ? AND last_operation = ? AND busy_operation = ? AND generation = ?)`;

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
  ] as const;
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
    ): Promise<void> {
      await sql.batch([
        {
          sql: `INSERT INTO tf_v2_resources
            (uid, principal, form_url, space, name, backend_id, target_key,
             active_name, generation, phase,
             spec_json, last_operation, busy_operation)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, ?)`,
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
            record.id,
            record.id,
          ],
        },
        { sql: opInsert, params: opParams(record) },
      ]);
    },
    async insertChange(record: AcceptRecord, forbidReferences = false): Promise<boolean> {
      const writes = await sql.batch([
        {
          sql: `UPDATE tf_v2_resources SET generation = ?, spec_json = ?,
              phase = ?, last_operation = ?, busy_operation = ?
            WHERE uid = ? AND principal = ? AND deleted_at IS NULL
              AND generation = ? AND busy_operation IS NULL
              ${
                forbidReferences
                  ? `AND NOT EXISTS (
                      SELECT 1 FROM tf_v2_resource_references edge
                      JOIN tf_v2_resources referrer ON referrer.uid = edge.referrer_uid
                      WHERE edge.target_uid = ? AND referrer.deleted_at IS NULL)`
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
            ...(forbidReferences ? [record.resourceUid] : []),
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
      ]);
      return writes[0]?.changes === 1 && writes[1]?.changes === 1;
    },
    async nextCandidate(nowMs: number): Promise<OperationRow | null> {
      return ((
        await sql.query(
          `SELECT * FROM tf_v2_operations WHERE next_attempt_at_ms <= ? AND
          (status = 'queued' OR
            (status IN ('running', 'reconciling') AND
              (lease_until_ms IS NULL OR lease_until_ms <= ?)))
         ORDER BY created_at, id LIMIT 1`,
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
