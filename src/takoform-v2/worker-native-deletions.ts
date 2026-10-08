import { canonicalJson } from "../json.ts";
import type { Clock, JsonObject, Sql, SqlParam } from "../ports.ts";
import { WORKER_VERSION_FORM_URL } from "./forms/worker-specs.ts";
import type { V2Execution } from "./types.ts";
import {
  inspectV2WorkerInvocationSchema,
  v2WorkerInvocationDrainSchemaReady,
  v2WorkerInvocationLegacySchemaReady,
} from "./worker-invocation-schema.ts";

/** An immutable prior upload, copied under an accepted Version DELETE claim. */
export interface V2NativeDeletionItem {
  readonly execution: V2Execution;
  readonly sourceOperationId: string;
  readonly sourceGeneration: number;
  readonly nativeIdentity: string;
  readonly closureDigest: `sha256:${string}`;
  readonly uploadReceipt: string | null;
  readonly qualifiedSourceReceipt: string | null;
}

export type V2NativeDeletionInspection =
  | { readonly kind: "planned" }
  | { readonly kind: "sent"; readonly acknowledgedReceipt: string | null }
  | { readonly kind: "confirmed_absent"; readonly receipt: string }
  | { readonly kind: "unknown" };

export interface V2NativeDeletionCustody {
  /** One bounded history page. Reinvoke until ready; unknown is never absence. */
  stageNext(execution: V2Execution): Promise<"more" | "ready" | "unknown">;
  /** One unfinished immutable source; no unbounded history is materialized. */
  next(execution: V2Execution): Promise<V2NativeDeletionItem | null>;
  /** Only after exact old owned bytes, metadata, and identity were read back. */
  qualifySource(item: V2NativeDeletionItem, receipt: string): Promise<boolean>;
  /** Fresh exact owned source readback receipt, then one native DELETE attempt. */
  grant(
    item: V2NativeDeletionItem,
    currentSourceReceipt: string,
  ): Promise<"granted" | "already_granted" | "unknown">;
  inspect(item: V2NativeDeletionItem): Promise<V2NativeDeletionInspection>;
  acknowledge(item: V2NativeDeletionItem, receipt: string): Promise<boolean>;
  /** Exact native absence readback; an ACK or timeout alone is insufficient. */
  confirmAbsent(item: V2NativeDeletionItem, receipt: string): Promise<boolean>;
  /** Recheck full history, references, invocations and receipts before settlement. */
  allAbsent(execution: V2Execution): Promise<boolean>;
}

type ItemRow = {
  delete_operation_id: string;
  source_operation_id: string;
  resource_uid: string;
  principal: string;
  space: string;
  backend_id: string;
  target_key: string;
  delete_generation: number;
  source_generation: number;
  native_identity: string;
  closure_digest: string;
  upload_receipt: string | null;
  qualified_source_receipt: string | null;
  grant_lease_token: string | null;
  acknowledged_receipt: string | null;
  confirmed_absence_receipt: string | null;
};

const DB_LEASE = `(CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000`;
const DB_NOW = `CAST(strftime('%s', 'now') AS INTEGER) * 1000
  + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)`;
const CLAIM = `op.id = ? AND op.resource_uid = ? AND op.principal = ?
  AND op.action = 'delete' AND op.generation = ?
  AND op.backend_key = ? AND op.backend_id = ? AND op.target_key = ?
  AND op.accepted_spec_json = ? AND op.status = 'reconciling'
  AND op.dispatch_possible = 1 AND op.lease_token = ?
  AND op.lease_until_ms > ? AND op.lease_until_ms > ${DB_LEASE}
  AND r.uid = op.resource_uid AND r.principal = op.principal
  AND r.form_url = ? AND r.space = ? AND r.name = ?
  AND r.backend_id = op.backend_id AND r.target_key = op.target_key
  AND r.generation = op.generation AND r.last_operation = op.id
  AND r.busy_operation = op.id AND r.phase = 'deleting'
  AND r.deleted_at IS NULL AND r.spec_json = op.accepted_spec_json`;

function validExecution(e: V2Execution): boolean {
  return e.form === WORKER_VERSION_FORM_URL && e.action === "delete";
}

function validReceipt(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

// Capture caller-owned objects before the first asynchronous database read.
// Only accepted spec enters SQL; prior observations are never authority here.
function captureExecution(input: V2Execution): V2Execution {
  return { ...input, spec: JSON.parse(canonicalJson(input.spec)) as JsonObject };
}

function captureItem(input: V2NativeDeletionItem): V2NativeDeletionItem {
  return { ...input, execution: captureExecution(input.execution) };
}

function claimParams(e: V2Execution, nowMs: number): SqlParam[] {
  return [
    e.operationId,
    e.resourceUid,
    e.principal,
    e.generation,
    e.backendKey,
    e.backendId,
    e.targetKey,
    canonicalJson(e.spec),
    e.leaseToken,
    nowMs,
    e.form,
    e.space,
    e.name,
  ];
}

function sameRow(row: ItemRow, item: V2NativeDeletionItem): boolean {
  const e = item.execution;
  return (
    row.delete_operation_id === e.operationId &&
    row.source_operation_id === item.sourceOperationId &&
    row.resource_uid === e.resourceUid &&
    row.principal === e.principal &&
    row.space === e.space &&
    row.backend_id === e.backendId &&
    row.target_key === e.targetKey &&
    row.delete_generation === e.generation &&
    row.source_generation === item.sourceGeneration &&
    row.native_identity === item.nativeIdentity &&
    row.closure_digest === item.closureDigest &&
    row.upload_receipt === item.uploadReceipt
  );
}

const MISSING = `EXISTS (
  SELECT 1 FROM tf_v2_worker_native_effects effect
  WHERE effect.resource_uid = op.resource_uid AND effect.generation < op.generation
    AND NOT EXISTS (SELECT 1 FROM tf_v2_worker_native_deletions item
      WHERE item.delete_operation_id = op.id AND item.source_operation_id = effect.operation_id
        AND item.native_identity = effect.native_identity
        AND item.closure_digest = effect.closure_digest
        AND (item.upload_receipt IS effect.confirmed_receipt OR
          item.qualified_source_receipt = effect.confirmed_receipt))
)`;
function unsafePredicate(serviceAware: boolean, drainAware: boolean): string {
  const invocationVersion = serviceAware
    ? `(invocation.version_uid = op.resource_uid OR
      (invocation.ingress_kind = 'service' AND
        invocation.service_caller_version_uid = op.resource_uid))`
    : "invocation.version_uid = op.resource_uid";
  return `EXISTS (SELECT 1 FROM tf_v2_resource_references ref
    JOIN tf_v2_resources referrer ON referrer.uid = ref.referrer_uid
    WHERE ref.target_uid = op.resource_uid AND referrer.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM tf_v2_worker_invocations invocation
    WHERE ${invocationVersion}
      AND invocation.phase <> 'pre_effect_refused'
      AND invocation.no_native_dispatch_at_ms IS NULL
      AND (invocation.retired_at_ms IS NULL OR invocation.retirement_receipt_digest IS NULL${drainAware ? " OR invocation.sqlite_drain_state = 'pending'" : ""}))
  OR EXISTS (SELECT 1 FROM tf_v2_operations source
    WHERE source.resource_uid = op.resource_uid AND source.action IN ('create','update')
      AND source.status = 'succeeded' AND source.effect = 'complete'
      AND NOT EXISTS (SELECT 1 FROM tf_v2_worker_native_effects effect
        WHERE effect.operation_id = source.id))`;
}

/** Custody is not a provider CAS and never converts an absent old upload into no effect. */
export function createV2NativeDeletionCustody(options: {
  readonly sql: Sql;
  readonly now?: Clock;
}): V2NativeDeletionCustody {
  const { sql } = options;
  const now = options.now ?? (() => new Date());

  async function currentUnsafePredicate(): Promise<{
    readonly unsafe: string;
    readonly ready: string;
  } | null> {
    const kind = await inspectV2WorkerInvocationSchema(sql);
    if (kind === null) return null;
    const drainAware =
      kind === "cron" &&
      (await sql.query(`SELECT 1 WHERE ${v2WorkerInvocationDrainSchemaReady()}`)).length === 1;
    return {
      unsafe: unsafePredicate(kind !== "endpoint", drainAware),
      ready: drainAware
        ? v2WorkerInvocationDrainSchemaReady()
        : v2WorkerInvocationLegacySchemaReady(kind),
    };
  }

  function time(): number | null {
    const value = now().getTime();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async function current(e: V2Execution): Promise<boolean> {
    const nowMs = time();
    if (!validExecution(e) || nowMs === null) return false;
    return (
      (
        await sql.query(
          `SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r
      ON r.uid = op.resource_uid WHERE ${CLAIM} LIMIT 1`,
          claimParams(e, nowMs),
        )
      ).length === 1
    );
  }

  async function row(item: V2NativeDeletionItem): Promise<ItemRow | null> {
    const found = await sql.query(
      `SELECT * FROM tf_v2_worker_native_deletions
      WHERE delete_operation_id = ? AND source_operation_id = ? LIMIT 1`,
      [item.execution.operationId, item.sourceOperationId],
    );
    return (found[0] ?? null) as ItemRow | null;
  }

  async function accepted(item: V2NativeDeletionItem, ready?: string): Promise<boolean> {
    const e = item.execution;
    return (
      (
        await sql.query(
          `SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r
      ON r.uid = op.resource_uid WHERE op.id = ? AND op.action = 'delete'
        AND op.resource_uid = ? AND op.principal = ? AND op.generation = ?
        AND op.backend_key = ? AND op.backend_id = ? AND op.target_key = ?
        AND op.accepted_spec_json = ? AND r.principal = ? AND r.space = ?
        AND r.name = ? AND r.form_url = ? AND r.backend_id = op.backend_id
        AND r.target_key = op.target_key
        ${ready ? `AND (${ready})` : ""} LIMIT 1`,
          [
            e.operationId,
            e.resourceUid,
            e.principal,
            e.generation,
            e.backendKey,
            e.backendId,
            e.targetKey,
            canonicalJson(e.spec),
            e.principal,
            e.space,
            e.name,
            e.form,
          ],
        )
      ).length === 1
    );
  }

  return {
    async stageNext(input) {
      const e = captureExecution(input);
      const nowMs = time();
      if (!validExecution(e) || nowMs === null) return "unknown";
      try {
        const result = await sql.run(
          `INSERT INTO tf_v2_worker_native_deletions (
          delete_operation_id, source_operation_id, resource_uid, principal, space,
          backend_id, target_key, delete_generation, source_generation,
          native_identity, closure_digest, upload_receipt, stage_lease_token, staged_at_ms
        ) SELECT op.id, effect.operation_id, r.uid, op.principal, r.space,
          op.backend_id, op.target_key, op.generation, effect.generation,
          effect.native_identity, effect.closure_digest, effect.confirmed_receipt,
          op.lease_token, ${DB_NOW}
        FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
        JOIN tf_v2_worker_native_effects effect ON effect.resource_uid = r.uid
        WHERE ${CLAIM} AND effect.generation < op.generation
          AND NOT EXISTS (SELECT 1 FROM tf_v2_worker_native_deletions item
            WHERE item.delete_operation_id = op.id AND item.source_operation_id = effect.operation_id)
        ORDER BY effect.generation, effect.operation_id LIMIT 32`,
          claimParams(e, nowMs),
        );
        if (result.changes > 0) return "more";
      } catch {
        return "unknown";
      }
      if (!(await current(e))) return "unknown";
      const missing = await sql.query(
        `SELECT 1 FROM tf_v2_operations op WHERE op.id = ?
        AND ${MISSING} LIMIT 1`,
        [e.operationId],
      );
      return missing.length === 0 ? "ready" : "unknown";
    },
    async next(input) {
      const e = captureExecution(input);
      if (!(await current(e))) return null;
      const found = await sql.query(
        `SELECT * FROM tf_v2_worker_native_deletions
        WHERE delete_operation_id = ? AND confirmed_absence_receipt IS NULL
        ORDER BY source_generation DESC, source_operation_id LIMIT 1`,
        [e.operationId],
      );
      const record = (found[0] ?? null) as ItemRow | null;
      if (
        !record ||
        record.resource_uid !== e.resourceUid ||
        record.principal !== e.principal ||
        record.space !== e.space ||
        record.backend_id !== e.backendId ||
        record.target_key !== e.targetKey ||
        record.delete_generation !== e.generation
      )
        return null;
      return {
        execution: e,
        sourceOperationId: record.source_operation_id,
        sourceGeneration: record.source_generation,
        nativeIdentity: record.native_identity,
        closureDigest: record.closure_digest as `sha256:${string}`,
        uploadReceipt: record.upload_receipt,
        qualifiedSourceReceipt: record.qualified_source_receipt,
      };
    },
    async qualifySource(input, receipt) {
      const item = captureItem(input);
      if (!validReceipt(receipt) || !(await current(item.execution))) return false;
      const existing = await row(item);
      if (!existing || !sameRow(existing, item)) return false;
      if (existing.upload_receipt !== null) return false;
      if (existing.qualified_source_receipt === receipt) return true;
      if (existing.qualified_source_receipt !== null) return false;
      try {
        const changed = await sql.run(
          `UPDATE tf_v2_worker_native_deletions
          SET qualified_source_receipt = ?, qualification_lease_token = ?
          WHERE delete_operation_id = ? AND source_operation_id = ?
            AND qualified_source_receipt IS NULL AND grant_lease_token IS NULL`,
          [receipt, item.execution.leaseToken, item.execution.operationId, item.sourceOperationId],
        );
        return changed.changes === 1;
      } catch {
        return false;
      }
    },
    async grant(input, currentSourceReceipt) {
      const item = captureItem(input);
      const e = item.execution;
      const nowMs = time();
      if (!validExecution(e) || nowMs === null || !validReceipt(currentSourceReceipt))
        return "unknown";
      const existing = await row(item);
      if (!existing || !sameRow(existing, item)) return "unknown";
      const predicate = await currentUnsafePredicate();
      if (predicate === null) return "unknown";
      if (existing.grant_lease_token !== null)
        return (await accepted(item, predicate.ready)) ? "already_granted" : "unknown";
      try {
        const changed = await sql.run(
          `UPDATE tf_v2_worker_native_deletions
          SET grant_lease_token = ?, granted_at_ms = ${DB_NOW},
            predelete_source_receipt = ?
          WHERE delete_operation_id = ? AND source_operation_id = ?
            AND grant_lease_token IS NULL AND confirmed_absence_receipt IS NULL
            AND (upload_receipt = ? OR qualified_source_receipt = ?)
            AND NOT EXISTS (SELECT 1 FROM tf_v2_worker_native_deletions later
              WHERE later.delete_operation_id = tf_v2_worker_native_deletions.delete_operation_id
                AND later.native_identity = tf_v2_worker_native_deletions.native_identity
                AND later.source_generation > tf_v2_worker_native_deletions.source_generation)
            AND (${predicate.ready})
            AND EXISTS (SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r
              ON r.uid = op.resource_uid WHERE ${CLAIM}
                AND NOT (${predicate.unsafe}) AND NOT (${MISSING}))`,
          [
            e.leaseToken,
            currentSourceReceipt,
            e.operationId,
            item.sourceOperationId,
            currentSourceReceipt,
            currentSourceReceipt,
            ...claimParams(e, nowMs),
          ],
        );
        if (changed.changes === 1) return "granted";
      } catch {
        return "unknown";
      }
      return "unknown";
    },
    async inspect(input) {
      const item = captureItem(input);
      if (!validExecution(item.execution)) return { kind: "unknown" };
      const existing = await row(item);
      const predicate = await currentUnsafePredicate();
      if (
        !existing ||
        !sameRow(existing, item) ||
        predicate === null ||
        !(await accepted(item, predicate.ready))
      )
        return { kind: "unknown" };
      if (existing.confirmed_absence_receipt !== null)
        return {
          kind: "confirmed_absent",
          receipt: existing.confirmed_absence_receipt,
        };
      if (existing.grant_lease_token !== null)
        return {
          kind: "sent",
          acknowledgedReceipt: existing.acknowledged_receipt,
        };
      return { kind: "planned" };
    },
    async acknowledge(input, receipt) {
      const item = captureItem(input);
      if (!validReceipt(receipt)) return false;
      const existing = await row(item);
      if (!existing || !sameRow(existing, item) || !(await accepted(item))) return false;
      if (existing.acknowledged_receipt === receipt) return true;
      if (existing.acknowledged_receipt !== null) return false;
      try {
        return (
          (
            await sql.run(
              `UPDATE tf_v2_worker_native_deletions
        SET acknowledged_receipt = ? WHERE delete_operation_id = ? AND source_operation_id = ?
          AND acknowledged_receipt IS NULL AND grant_lease_token IS NOT NULL`,
              [receipt, item.execution.operationId, item.sourceOperationId],
            )
          ).changes === 1
        );
      } catch {
        return false;
      }
    },
    async confirmAbsent(input, receipt) {
      const item = captureItem(input);
      if (!validReceipt(receipt)) return false;
      const existing = await row(item);
      if (!existing || !sameRow(existing, item) || !(await accepted(item))) return false;
      const predicate = await currentUnsafePredicate();
      if (predicate === null) return false;
      if (existing.confirmed_absence_receipt === receipt) return accepted(item, predicate.ready);
      if (existing.confirmed_absence_receipt !== null) return false;
      const nowMs = time();
      if (nowMs === null) return false;
      try {
        return (
          (
            await sql.run(
              `UPDATE tf_v2_worker_native_deletions
        SET confirmed_absence_receipt = ?,
          absence_lease_token = CASE WHEN grant_lease_token IS NULL THEN ? ELSE absence_lease_token END
        WHERE delete_operation_id = ? AND source_operation_id = ?
          AND confirmed_absence_receipt IS NULL
          AND (${predicate.ready})
          AND (upload_receipt IS NOT NULL OR qualified_source_receipt IS NOT NULL)
          AND (grant_lease_token IS NOT NULL OR
            (upload_receipt IS NOT NULL AND EXISTS (
              SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r
              ON r.uid = op.resource_uid WHERE ${CLAIM}
                AND NOT (${predicate.unsafe}) AND NOT (${MISSING}))))`,
              [
                receipt,
                item.execution.leaseToken,
                item.execution.operationId,
                item.sourceOperationId,
                ...claimParams(item.execution, nowMs),
              ],
            )
          ).changes === 1
        );
      } catch {
        return false;
      }
    },
    async allAbsent(input) {
      const e = captureExecution(input);
      const nowMs = time();
      if (!validExecution(e) || nowMs === null) return false;
      const predicate = await currentUnsafePredicate();
      if (predicate === null) return false;
      const rows = await sql.query(
        `SELECT 1 FROM tf_v2_operations op
        JOIN tf_v2_resources r ON r.uid = op.resource_uid WHERE ${CLAIM}
          AND (${predicate.ready})
          AND NOT (${predicate.unsafe}) AND NOT (${MISSING})
          AND NOT EXISTS (SELECT 1 FROM tf_v2_worker_native_deletions item
            WHERE item.delete_operation_id = op.id
              AND item.confirmed_absence_receipt IS NULL) LIMIT 1`,
        claimParams(e, nowMs),
      );
      return rows.length === 1;
    },
  };
}
