import { canonicalJson } from "../json.ts";
import type { Clock, JsonObject, Row, Sql, SqlParam } from "../ports.ts";
import { EDGE_KV_NAMESPACE_FORM_URL, EDGE_KV_NAMESPACE_LIMITS } from "./forms/edge-kv-namespace.ts";
import type { V2Execution } from "./types.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DB_NOW = `CAST(strftime('%s', 'now') AS INTEGER) * 1000
  + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)`;
const DB_LEASE = `(CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000`;
const CLAIM = `op.id = ? AND op.resource_uid = ? AND op.principal = ?
  AND op.action = ? AND op.generation = ? AND op.backend_key = ?
  AND op.backend_id = ? AND op.target_key = ?
  AND op.accepted_spec_json = '{}' AND op.status = 'reconciling'
  AND op.dispatch_possible = 1 AND op.lease_token = ?
  AND op.lease_until_ms > ? AND op.lease_until_ms > ${DB_LEASE}
  AND resource.uid = op.resource_uid AND resource.principal = op.principal
  AND resource.form_url = ? AND resource.space = ? AND resource.name = ?
  AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
  AND resource.generation = op.generation AND resource.last_operation = op.id
  AND resource.busy_operation = op.id AND resource.deleted_at IS NULL
  AND resource.spec_json = '{}' AND
    (op.action <> 'delete' OR resource.phase = 'deleting')`;

export interface V2EdgeKvCreateIntent {
  readonly execution: V2Execution;
  /** Planned provider title is a collision guard, never proof of ownership. */
  readonly plannedTitle: string;
  readonly closureDigest: `sha256:${string}`;
}

export type V2EdgeKvCreateInspection =
  | { readonly kind: "never_granted" | "sent" | "conflict" }
  | {
      readonly kind: "acknowledged" | "confirmed";
      readonly nativeId: string;
      readonly receipt: string;
    };

export interface V2EdgeKvConfirmedIdentity {
  readonly nativeId: string;
  readonly plannedTitle: string;
  readonly closureDigest: `sha256:${string}`;
  readonly sourceOperationId: string;
  readonly sourceGeneration: number;
}

export interface V2EdgeKvSettledTargetInput {
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
  readonly generation: number;
  /** The current Resource.last_operation, not the original CREATE. */
  readonly sourceOperationId: string;
  readonly backendId: string;
}

export interface V2EdgeKvSettledTarget {
  readonly nativeId: string;
  readonly plannedTitle: string;
  readonly closureDigest: `sha256:${string}`;
  readonly sourceCreateOperationId: string;
  readonly sourceCreateGeneration: number;
  readonly confirmedReceipt: string;
}

export type V2EdgeKvDeleteGrant =
  | ({ readonly kind: "granted" | "already_granted" } & V2EdgeKvConfirmedIdentity)
  | { readonly kind: "conflict" };

export type V2EdgeKvDeleteInspection =
  | { readonly kind: "never_granted" | "sent" | "conflict" }
  | { readonly kind: "confirmed_absent"; readonly receipt: string };

interface CustodyRow {
  readonly operation_id: string;
  readonly resource_uid: string;
  readonly action: "create" | "delete";
  readonly principal: string;
  readonly space: string;
  readonly backend_key: string;
  readonly backend_id: string;
  readonly target_key: string;
  readonly generation: number;
  readonly accepted_spec_json: string;
  readonly planned_title: string;
  readonly closure_digest: string;
  readonly source_operation_id: string | null;
  readonly native_id: string | null;
  readonly acknowledged_receipt: string | null;
  readonly confirmed_receipt: string | null;
}

function custodyRow(value: Row | undefined): CustodyRow | null {
  if (!value) return null;
  if (
    typeof value.operation_id !== "string" ||
    typeof value.resource_uid !== "string" ||
    (value.action !== "create" && value.action !== "delete") ||
    typeof value.principal !== "string" ||
    typeof value.space !== "string" ||
    typeof value.backend_key !== "string" ||
    typeof value.backend_id !== "string" ||
    typeof value.target_key !== "string" ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.accepted_spec_json !== "string" ||
    typeof value.planned_title !== "string" ||
    typeof value.closure_digest !== "string" ||
    (value.source_operation_id !== null && typeof value.source_operation_id !== "string") ||
    (value.native_id !== null && typeof value.native_id !== "string") ||
    (value.acknowledged_receipt !== null && typeof value.acknowledged_receipt !== "string") ||
    (value.confirmed_receipt !== null && typeof value.confirmed_receipt !== "string")
  )
    throw new Error("edge_kv_native_custody_invalid_row");
  return {
    operation_id: value.operation_id,
    resource_uid: value.resource_uid,
    action: value.action,
    principal: value.principal,
    space: value.space,
    backend_key: value.backend_key,
    backend_id: value.backend_id,
    target_key: value.target_key,
    generation: value.generation,
    accepted_spec_json: value.accepted_spec_json,
    planned_title: value.planned_title,
    closure_digest: value.closure_digest,
    source_operation_id: value.source_operation_id,
    native_id: value.native_id,
    acknowledged_receipt: value.acknowledged_receipt,
    confirmed_receipt: value.confirmed_receipt,
  };
}

function capture(input: V2Execution): V2Execution | null {
  try {
    const spec = JSON.parse(canonicalJson(input.spec)) as JsonObject;
    if (
      input.form !== EDGE_KV_NAMESPACE_FORM_URL ||
      !["create", "update", "delete"].includes(input.action) ||
      canonicalJson(spec) !== "{}"
    )
      return null;
    return { ...input, spec };
  } catch {
    return null;
  }
}

function validText(value: string, max: number): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function validIntent(input: V2EdgeKvCreateIntent): boolean {
  return (
    validText(input.plannedTitle, 512) &&
    typeof input.closureDigest === "string" &&
    DIGEST.test(input.closureDigest)
  );
}

function params(e: V2Execution, nowMs: number): SqlParam[] {
  return [
    e.operationId,
    e.resourceUid,
    e.principal,
    e.action,
    e.generation,
    e.backendKey,
    e.backendId,
    e.targetKey,
    e.leaseToken,
    nowMs,
    e.form,
    e.space,
    e.name,
  ];
}

function same(row: CustodyRow, e: V2Execution): boolean {
  return (
    row.operation_id === e.operationId &&
    row.resource_uid === e.resourceUid &&
    row.action === e.action &&
    row.principal === e.principal &&
    row.space === e.space &&
    row.backend_key === e.backendKey &&
    row.backend_id === e.backendId &&
    row.target_key === e.targetKey &&
    row.generation === e.generation &&
    row.accepted_spec_json === canonicalJson(e.spec)
  );
}

function confirmed(row: CustodyRow): V2EdgeKvConfirmedIdentity | null {
  if (row.action !== "create" || !row.native_id || !row.confirmed_receipt) return null;
  return {
    nativeId: row.native_id,
    plannedTitle: row.planned_title,
    closureDigest: row.closure_digest as `sha256:${string}`,
    sourceOperationId: row.operation_id,
    sourceGeneration: row.generation,
  };
}

/**
 * Host-private native intent/receipt custody. A title match, timeout, or HTTP
 * ACK by itself never proves a namespace belongs to this accepted Resource.
 */
export function createV2EdgeKvNativeCustody(options: { readonly sql: Sql; readonly now?: Clock }) {
  const { sql } = options;
  const now = options.now ?? (() => new Date());
  const time = (): number | null => {
    const value = now().getTime();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const row = async (operationId: string): Promise<CustodyRow | null> =>
    custodyRow(
      (
        await sql.query(
          "SELECT * FROM tf_v2_edge_kv_native_custody WHERE operation_id = ? LIMIT 1",
          [operationId],
        )
      )[0],
    );
  const current = async (e: V2Execution): Promise<boolean> => {
    const at = time();
    if (at === null) return false;
    return (
      (
        await sql.query(
          `SELECT 1 FROM tf_v2_operations op
       JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
       WHERE ${CLAIM} LIMIT 1`,
          params(e, at),
        )
      ).length === 1
    );
  };
  const accepted = async (e: V2Execution): Promise<boolean> =>
    (
      await sql.query(
        `SELECT 1 FROM tf_v2_operations op
       JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
       WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ?
         AND op.action = ? AND op.generation = ? AND op.backend_key = ?
         AND op.backend_id = ? AND op.target_key = ?
         AND op.accepted_spec_json = '{}' AND resource.uid = op.resource_uid
         AND resource.principal = ? AND resource.space = ? AND resource.name = ?
         AND resource.form_url = ? AND resource.backend_id = op.backend_id
         AND resource.target_key = op.target_key LIMIT 1`,
        [
          e.operationId,
          e.resourceUid,
          e.principal,
          e.action,
          e.generation,
          e.backendKey,
          e.backendId,
          e.targetKey,
          e.principal,
          e.space,
          e.name,
          e.form,
        ],
      )
    ).length === 1;
  const receipt = (value: string): boolean => validText(value, 255);

  return Object.freeze({
    /** Read-only binding target; repeat after provider GET and compare all fields. */
    async readSettledTarget(
      input: V2EdgeKvSettledTargetInput,
    ): Promise<V2EdgeKvSettledTarget | null> {
      const identity = { ...input };
      if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) return null;
      const found = (
        await sql.query(
          `SELECT source.native_id, source.planned_title, source.closure_digest,
           source.operation_id AS source_create_operation_id,
           source.generation AS source_create_generation,
           source.confirmed_receipt
         FROM tf_v2_resources resource
         JOIN tf_v2_operations current_op ON current_op.id = resource.last_operation
         JOIN tf_v2_edge_kv_native_custody source
           ON source.resource_uid = resource.uid AND source.action = 'create'
         WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ?
           AND resource.target_key = ? AND resource.backend_id = ?
           AND resource.form_url = ? AND resource.generation = ?
           AND resource.observed_generation = resource.generation
           AND resource.phase = 'idle' AND resource.busy_operation IS NULL
           AND resource.deleted_at IS NULL AND resource.spec_json = '{}'
           AND resource.output_json = '{}'
           AND json_valid(resource.observed_json) = 1
           AND json_type(resource.observed_json) = 'object'
           AND (SELECT COUNT(*) FROM json_each(resource.observed_json)) = 5
           AND json_type(resource.observed_json, '$.namespaceExists') = 'true'
           AND json_type(resource.observed_json, '$.maxKeyBytes') = 'integer'
           AND json_type(resource.observed_json, '$.maxValueBytes') = 'integer'
           AND json_type(resource.observed_json, '$.maxMetadataBytes') = 'integer'
           AND json_type(resource.observed_json, '$.consistency') = 'text'
           AND json_extract(resource.observed_json, '$.namespaceExists') = 1
           AND json_extract(resource.observed_json, '$.maxKeyBytes') = ?
           AND json_extract(resource.observed_json, '$.maxValueBytes') = ?
           AND json_extract(resource.observed_json, '$.maxMetadataBytes') = ?
           AND json_extract(resource.observed_json, '$.consistency') = ?
           AND current_op.id = ? AND current_op.resource_uid = resource.uid
           AND current_op.principal = resource.principal
           AND current_op.backend_id = resource.backend_id
           AND current_op.target_key = resource.target_key
           AND current_op.generation = resource.generation
           AND current_op.action IN ('create','update')
           AND current_op.status = 'succeeded' AND current_op.effect = 'complete'
           AND current_op.accepted_spec_json = '{}'
           AND current_op.result_observed_json = resource.observed_json
           AND current_op.result_output_json = resource.output_json
           AND source.principal = resource.principal AND source.space = resource.space
           AND source.backend_id = resource.backend_id
           AND source.target_key = resource.target_key
           AND source.generation <= resource.generation
           AND source.native_id IS NOT NULL AND source.confirmed_receipt IS NOT NULL
         LIMIT 1`,
          [
            identity.resourceUid,
            identity.principal,
            identity.space,
            identity.targetKey,
            identity.backendId,
            EDGE_KV_NAMESPACE_FORM_URL,
            identity.generation,
            EDGE_KV_NAMESPACE_LIMITS.maxKeyBytes,
            EDGE_KV_NAMESPACE_LIMITS.maxValueBytes,
            EDGE_KV_NAMESPACE_LIMITS.maxMetadataBytes,
            EDGE_KV_NAMESPACE_LIMITS.consistency,
            identity.sourceOperationId,
          ],
        )
      )[0] as
        | {
            native_id: string;
            planned_title: string;
            closure_digest: string;
            source_create_operation_id: string;
            source_create_generation: number;
            confirmed_receipt: string;
          }
        | undefined;
      if (!found) return null;
      return {
        nativeId: found.native_id,
        plannedTitle: found.planned_title,
        closureDigest: found.closure_digest as `sha256:${string}`,
        sourceCreateOperationId: found.source_create_operation_id,
        sourceCreateGeneration: found.source_create_generation,
        confirmedReceipt: found.confirmed_receipt,
      };
    },
    async grantCreate(
      input: V2EdgeKvCreateIntent,
    ): Promise<"granted" | "already_granted" | "conflict"> {
      const e = capture(input.execution);
      const plannedTitle = input.plannedTitle;
      const closureDigest = input.closureDigest;
      if (e?.action !== "create" || !validIntent({ execution: e, plannedTitle, closureDigest }))
        return "conflict";
      const at = time();
      if (at === null) return "conflict";
      const inserted = await sql.run(
        `INSERT INTO tf_v2_edge_kv_native_custody (
           operation_id, resource_uid, action, principal, space, backend_key,
           backend_id, target_key, generation, accepted_spec_json,
           planned_title, closure_digest, source_operation_id, native_id,
           grant_lease_token, granted_at_ms
         ) SELECT op.id, resource.uid, op.action, op.principal, resource.space,
           op.backend_key, op.backend_id, op.target_key, op.generation,
           op.accepted_spec_json, ?, ?, NULL, NULL, op.lease_token, ${DB_NOW}
         FROM tf_v2_operations op JOIN tf_v2_resources resource
           ON resource.uid = op.resource_uid WHERE ${CLAIM}
         ON CONFLICT(operation_id) DO NOTHING`,
        [plannedTitle, closureDigest, ...params(e, at)],
      );
      if (inserted.changes === 1) return (await current(e)) ? "granted" : "conflict";
      if (!(await current(e))) return "conflict";
      const prior = await row(e.operationId);
      return prior &&
        same(prior, e) &&
        prior.action === "create" &&
        prior.planned_title === plannedTitle &&
        prior.closure_digest === closureDigest
        ? "already_granted"
        : "conflict";
    },
    async inspectCreate(input: V2EdgeKvCreateIntent): Promise<V2EdgeKvCreateInspection> {
      const e = capture(input.execution);
      if (e?.action !== "create" || !validIntent(input) || !(await accepted(e)))
        return { kind: "conflict" };
      const prior = await row(e.operationId);
      if (!prior) return { kind: "never_granted" };
      if (
        !same(prior, e) ||
        prior.planned_title !== input.plannedTitle ||
        prior.closure_digest !== input.closureDigest
      )
        return { kind: "conflict" };
      if (prior.native_id && prior.confirmed_receipt)
        return { kind: "confirmed", nativeId: prior.native_id, receipt: prior.confirmed_receipt };
      if (prior.native_id && prior.acknowledged_receipt)
        return {
          kind: "acknowledged",
          nativeId: prior.native_id,
          receipt: prior.acknowledged_receipt,
        };
      return { kind: "sent" };
    },
    async acknowledgeCreate(
      input: V2EdgeKvCreateIntent & {
        readonly nativeId: string;
        readonly receipt: string;
      },
    ): Promise<boolean> {
      const e = capture(input.execution);
      const nativeId = input.nativeId;
      const ack = input.receipt;
      if (
        e?.action !== "create" ||
        !validIntent(input) ||
        !validText(nativeId, 255) ||
        !receipt(ack) ||
        !(await accepted(e))
      )
        return false;
      const result = await sql.run(
        `UPDATE tf_v2_edge_kv_native_custody
         SET native_id = ?, acknowledged_receipt = ?
         WHERE operation_id = ? AND resource_uid = ? AND action = 'create'
           AND principal = ? AND space = ? AND backend_key = ? AND backend_id = ?
           AND target_key = ? AND generation = ? AND accepted_spec_json = '{}'
           AND planned_title = ? AND closure_digest = ?
           AND native_id IS NULL AND acknowledged_receipt IS NULL`,
        [
          nativeId,
          ack,
          e.operationId,
          e.resourceUid,
          e.principal,
          e.space,
          e.backendKey,
          e.backendId,
          e.targetKey,
          e.generation,
          input.plannedTitle,
          input.closureDigest,
        ],
      );
      if (result.changes === 1) return true;
      const prior = await row(e.operationId);
      return (
        !!prior &&
        same(prior, e) &&
        prior.planned_title === input.plannedTitle &&
        prior.closure_digest === input.closureDigest &&
        prior.native_id === nativeId &&
        prior.acknowledged_receipt === ack
      );
    },
    async confirmCreate(
      input: V2EdgeKvCreateIntent & {
        readonly nativeId: string;
        readonly receipt: string;
      },
    ): Promise<boolean> {
      const e = capture(input.execution);
      const nativeId = input.nativeId;
      const proof = input.receipt;
      if (
        e?.action !== "create" ||
        !validIntent(input) ||
        !validText(nativeId, 255) ||
        !receipt(proof) ||
        !(await current(e))
      )
        return false;
      const result = await sql.run(
        `UPDATE tf_v2_edge_kv_native_custody SET confirmed_receipt = ?
         WHERE operation_id = ? AND resource_uid = ? AND action = 'create'
           AND principal = ? AND space = ? AND backend_key = ? AND backend_id = ?
           AND target_key = ? AND generation = ? AND planned_title = ?
           AND closure_digest = ? AND native_id = ?
           AND acknowledged_receipt IS NOT NULL AND confirmed_receipt IS NULL
           AND EXISTS (SELECT 1 FROM tf_v2_operations op
             JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
             WHERE ${CLAIM})`,
        [
          proof,
          e.operationId,
          e.resourceUid,
          e.principal,
          e.space,
          e.backendKey,
          e.backendId,
          e.targetKey,
          e.generation,
          input.plannedTitle,
          input.closureDigest,
          nativeId,
          ...params(e, time() ?? 0),
        ],
      );
      if (result.changes === 1) return true;
      const prior = await row(e.operationId);
      return (
        !!prior &&
        same(prior, e) &&
        prior.planned_title === input.plannedTitle &&
        prior.closure_digest === input.closureDigest &&
        prior.native_id === nativeId &&
        prior.acknowledged_receipt !== null &&
        prior.confirmed_receipt === proof
      );
    },
    async confirmedForUpdate(input: V2Execution): Promise<V2EdgeKvConfirmedIdentity | null> {
      const e = capture(input);
      if (e?.action !== "update" || !(await current(e))) return null;
      const prior = custodyRow(
        (
          await sql.query(
            `SELECT * FROM tf_v2_edge_kv_native_custody
         WHERE resource_uid = ? AND action = 'create' AND principal = ?
           AND space = ? AND backend_id = ? AND target_key = ?
           AND generation < ? AND native_id IS NOT NULL
           AND confirmed_receipt IS NOT NULL LIMIT 1`,
            [e.resourceUid, e.principal, e.space, e.backendId, e.targetKey, e.generation],
          )
        )[0],
      );
      if (!prior || !(await current(e))) return null;
      return confirmed(prior);
    },
    /** Read-only source peek for an exact-ID/title pre-delete provider readback. */
    async prepareDelete(input: V2Execution): Promise<V2EdgeKvConfirmedIdentity | null> {
      const e = capture(input);
      if (e?.action !== "delete" || !(await current(e))) return null;
      const prior = custodyRow(
        (
          await sql.query(
            `SELECT source.* FROM tf_v2_edge_kv_native_custody source
         WHERE source.resource_uid = ? AND source.action = 'create'
           AND source.principal = ? AND source.space = ?
           AND source.backend_id = ? AND source.target_key = ?
           AND source.generation < ? AND source.native_id IS NOT NULL
           AND source.confirmed_receipt IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM tf_v2_resource_references ref
             JOIN tf_v2_resources referrer ON referrer.uid = ref.referrer_uid
             WHERE ref.target_uid = source.resource_uid AND referrer.deleted_at IS NULL)
         LIMIT 1`,
            [e.resourceUid, e.principal, e.space, e.backendId, e.targetKey, e.generation],
          )
        )[0],
      );
      if (!prior || !(await current(e))) return null;
      return confirmed(prior);
    },
    async grantDelete(
      input: V2Execution,
      prepared: V2EdgeKvConfirmedIdentity,
    ): Promise<V2EdgeKvDeleteGrant> {
      const e = capture(input);
      const expected = { ...prepared };
      if (
        e?.action !== "delete" ||
        !validText(expected.nativeId, 255) ||
        !validText(expected.plannedTitle, 512) ||
        !DIGEST.test(expected.closureDigest) ||
        !validText(expected.sourceOperationId, 128) ||
        !Number.isSafeInteger(expected.sourceGeneration) ||
        expected.sourceGeneration < 1
      )
        return { kind: "conflict" };
      const at = time();
      if (at === null) return { kind: "conflict" };
      const result = await sql.run(
        `INSERT INTO tf_v2_edge_kv_native_custody (
           operation_id, resource_uid, action, principal, space, backend_key,
           backend_id, target_key, generation, accepted_spec_json,
           planned_title, closure_digest, source_operation_id, native_id,
           grant_lease_token, granted_at_ms
         ) SELECT op.id, resource.uid, op.action, op.principal, resource.space,
           op.backend_key, op.backend_id, op.target_key, op.generation,
           op.accepted_spec_json, source.planned_title, source.closure_digest,
           source.operation_id, source.native_id, op.lease_token, ${DB_NOW}
         FROM tf_v2_operations op JOIN tf_v2_resources resource
           ON resource.uid = op.resource_uid
         JOIN tf_v2_edge_kv_native_custody source
           ON source.resource_uid = resource.uid AND source.action = 'create'
         WHERE ${CLAIM} AND source.principal = op.principal
           AND source.space = resource.space AND source.backend_id = op.backend_id
           AND source.target_key = op.target_key AND source.generation < op.generation
           AND source.native_id IS NOT NULL AND source.confirmed_receipt IS NOT NULL
           AND source.operation_id = ? AND source.generation = ?
           AND source.native_id = ?
           AND source.planned_title = ? AND source.closure_digest = ?
           AND NOT EXISTS (SELECT 1 FROM tf_v2_resource_references ref
             JOIN tf_v2_resources referrer ON referrer.uid = ref.referrer_uid
             WHERE ref.target_uid = resource.uid AND referrer.deleted_at IS NULL)
         ON CONFLICT(operation_id) DO NOTHING`,
        [
          ...params(e, at),
          expected.sourceOperationId,
          expected.sourceGeneration,
          expected.nativeId,
          expected.plannedTitle,
          expected.closureDigest,
        ],
      );
      if (!(await current(e))) return { kind: "conflict" };
      const prior = await row(e.operationId);
      if (!prior || !same(prior, e) || prior.action !== "delete") return { kind: "conflict" };
      const source = prior.source_operation_id ? await row(prior.source_operation_id) : null;
      const identity = source && confirmed(source);
      if (
        !identity ||
        !source ||
        source.resource_uid !== prior.resource_uid ||
        source.principal !== prior.principal ||
        source.space !== prior.space ||
        source.backend_id !== prior.backend_id ||
        source.target_key !== prior.target_key ||
        identity.nativeId !== prior.native_id ||
        identity.plannedTitle !== prior.planned_title ||
        identity.closureDigest !== prior.closure_digest
      )
        return { kind: "conflict" };
      if (
        identity.nativeId !== expected.nativeId ||
        identity.plannedTitle !== expected.plannedTitle ||
        identity.closureDigest !== expected.closureDigest ||
        identity.sourceOperationId !== expected.sourceOperationId ||
        identity.sourceGeneration !== expected.sourceGeneration
      )
        return { kind: "conflict" };
      return { kind: result.changes === 1 ? "granted" : "already_granted", ...identity };
    },
    async inspectDelete(input: V2Execution): Promise<V2EdgeKvDeleteInspection> {
      const e = capture(input);
      if (e?.action !== "delete" || !(await accepted(e))) return { kind: "conflict" };
      const prior = await row(e.operationId);
      if (!prior) return { kind: "never_granted" };
      if (!same(prior, e) || prior.action !== "delete") return { kind: "conflict" };
      return prior.confirmed_receipt
        ? { kind: "confirmed_absent", receipt: prior.confirmed_receipt }
        : { kind: "sent" };
    },
    async acknowledgeDelete(input: V2Execution, receiptValue: string): Promise<boolean> {
      const e = capture(input);
      const ack = receiptValue;
      if (e?.action !== "delete" || !receipt(ack) || !(await accepted(e))) return false;
      const result = await sql.run(
        `UPDATE tf_v2_edge_kv_native_custody SET acknowledged_receipt = ?
         WHERE operation_id = ? AND action = 'delete' AND resource_uid = ?
           AND principal = ? AND space = ? AND backend_key = ? AND backend_id = ?
           AND target_key = ? AND generation = ? AND acknowledged_receipt IS NULL`,
        [
          ack,
          e.operationId,
          e.resourceUid,
          e.principal,
          e.space,
          e.backendKey,
          e.backendId,
          e.targetKey,
          e.generation,
        ],
      );
      if (result.changes === 1) return true;
      const prior = await row(e.operationId);
      return !!prior && same(prior, e) && prior.acknowledged_receipt === ack;
    },
    async confirmAbsent(input: V2Execution, receiptValue: string): Promise<boolean> {
      const e = capture(input);
      const proof = receiptValue;
      if (e?.action !== "delete" || !receipt(proof) || !(await current(e))) return false;
      const result = await sql.run(
        `UPDATE tf_v2_edge_kv_native_custody SET confirmed_receipt = ?
         WHERE operation_id = ? AND action = 'delete' AND resource_uid = ?
           AND principal = ? AND space = ? AND backend_key = ? AND backend_id = ?
           AND target_key = ? AND generation = ? AND confirmed_receipt IS NULL
           AND NOT EXISTS (SELECT 1 FROM tf_v2_resource_references ref
             JOIN tf_v2_resources referrer ON referrer.uid = ref.referrer_uid
             WHERE ref.target_uid = tf_v2_edge_kv_native_custody.resource_uid
               AND referrer.deleted_at IS NULL)
           AND EXISTS (SELECT 1 FROM tf_v2_operations op
             JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
             WHERE ${CLAIM})`,
        [
          proof,
          e.operationId,
          e.resourceUid,
          e.principal,
          e.space,
          e.backendKey,
          e.backendId,
          e.targetKey,
          e.generation,
          ...params(e, time() ?? 0),
        ],
      );
      if (result.changes === 1) return true;
      const prior = await row(e.operationId);
      return !!prior && same(prior, e) && prior.confirmed_receipt === proof;
    },
  });
}
