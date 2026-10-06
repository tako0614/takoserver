import { canonicalJson } from "../json.ts";
import type { Clock, Sql, SqlParam } from "../ports.ts";
import { WORKER_VERSION_FORM_URL } from "./forms/worker-specs.ts";
import type { V2Execution } from "./types.ts";

/** Native identity and byte-closure digest chosen before any external send. */
export interface V2NativeEffectIdentity {
  readonly execution: V2Execution;
  readonly nativeIdentity: string;
  readonly closureDigest: `sha256:${string}`;
}

export type V2NativeEffectInspection =
  | { readonly kind: "never_granted" }
  | { readonly kind: "sent"; readonly acknowledgedReceipt?: string }
  | { readonly kind: "confirmed"; readonly acknowledgedReceipt?: string; readonly receipt: string }
  | { readonly kind: "conflict" };

export interface V2NativeEffectCustody {
  /** Only `granted` permits the caller to initiate one native send. */
  grant(identity: V2NativeEffectIdentity): Promise<"granted" | "already_granted" | "conflict">;
  /** Read-only; an absent row means no grant was committed for this Operation. */
  inspect(identity: V2NativeEffectIdentity): Promise<V2NativeEffectInspection>;
  /** Records an exact native acknowledgement, not Form success. */
  acknowledge(identity: V2NativeEffectIdentity & { readonly receipt: string }): Promise<boolean>;
  /** Records a separately verified exact native observation, not Form success. */
  confirm(identity: V2NativeEffectIdentity & { readonly receipt: string }): Promise<boolean>;
}

type IntentRow = {
  operation_id: string;
  resource_uid: string;
  principal: string;
  space: string;
  backend_key: string;
  backend_id: string;
  target_key: string;
  generation: number;
  native_identity: string;
  closure_digest: string;
  acknowledged_receipt: string | null;
  confirmed_receipt: string | null;
};

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
// D1 and SQLite both evaluate this inside the actual SQL statement. Requiring
// validity through the end of the current second is deliberately conservative;
// a host-clock value captured before awaiting D1 is not a send-admission fence.
const DB_LEASE_FENCE = `(CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000`;
const DB_NOW_MS = `CAST(strftime('%s', 'now') AS INTEGER) * 1000
  + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)`;

// This predicate is deliberately duplicated in the 0074 INSERT trigger. The
// INSERT SELECT is the send-admission linearization point, not this read.
const CLAIM = `op.id = ? AND op.resource_uid = ? AND op.principal = ?
  AND op.action = ? AND op.action IN ('create', 'update')
  AND op.generation = ? AND op.backend_key = ?
  AND op.backend_id = ? AND op.target_key = ?
  AND op.accepted_spec_json = ?
  AND op.status = 'reconciling' AND op.dispatch_possible = 1
  AND op.lease_token = ? AND op.lease_until_ms > ?
  AND op.lease_until_ms > ${DB_LEASE_FENCE}
  AND r.uid = op.resource_uid AND r.principal = op.principal
  AND r.form_url = ? AND r.space = ? AND r.name = ?
  AND r.backend_id = op.backend_id AND r.target_key = op.target_key
  AND r.generation = op.generation AND r.last_operation = op.id
  AND r.busy_operation = op.id AND r.deleted_at IS NULL
  AND r.spec_json = op.accepted_spec_json`;

function validIdentity(value: V2NativeEffectIdentity): boolean {
  return (
    value.execution.form === WORKER_VERSION_FORM_URL &&
    (value.execution.action === "create" || value.execution.action === "update") &&
    typeof value.nativeIdentity === "string" &&
    value.nativeIdentity.length >= 1 &&
    value.nativeIdentity.length <= 255 &&
    DIGEST.test(value.closureDigest)
  );
}

function claimParams(execution: V2Execution, nowMs: number): SqlParam[] {
  return [
    execution.operationId,
    execution.resourceUid,
    execution.principal,
    execution.action,
    execution.generation,
    execution.backendKey,
    execution.backendId,
    execution.targetKey,
    canonicalJson(execution.spec),
    execution.leaseToken,
    nowMs,
    execution.form,
    execution.space,
    execution.name,
  ];
}

function sameIntent(row: IntentRow, identity: V2NativeEffectIdentity): boolean {
  const e = identity.execution;
  return (
    row.operation_id === e.operationId &&
    row.resource_uid === e.resourceUid &&
    row.principal === e.principal &&
    row.space === e.space &&
    row.backend_key === e.backendKey &&
    row.backend_id === e.backendId &&
    row.target_key === e.targetKey &&
    row.generation === e.generation &&
    row.native_identity === identity.nativeIdentity &&
    row.closure_digest === identity.closureDigest
  );
}

/**
 * One global, durable send grant for one accepted v2 WorkerVersion Operation.
 * The DB lease fences admission and receipt writes; it cannot retract a native
 * request already sent, so an adapter must inspect native state after an ACK
 * loss and must not infer absence from a timeout.
 */
export function createV2NativeEffectCustody(options: {
  readonly sql: Sql;
  readonly now?: Clock;
}): V2NativeEffectCustody {
  const { sql } = options;
  const now = options.now ?? (() => new Date());

  function currentTime(): number | null {
    const value = now().getTime();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async function currentClaim(identity: V2NativeEffectIdentity): Promise<boolean> {
    if (!validIdentity(identity)) return false;
    const nowMs = currentTime();
    if (nowMs === null) return false;
    return (
      (
        await sql.query(
          `SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
         WHERE ${CLAIM} LIMIT 1`,
          claimParams(identity.execution, nowMs),
        )
      ).length === 1
    );
  }

  async function intent(operationId: string): Promise<IntentRow | null> {
    return ((
      await sql.query("SELECT * FROM tf_v2_worker_native_effects WHERE operation_id = ?", [
        operationId,
      ])
    )[0] ?? null) as IntentRow | null;
  }

  async function acceptedIdentity(identity: V2NativeEffectIdentity): Promise<boolean> {
    const e = identity.execution;
    return (
      (
        await sql.query(
          `SELECT 1 FROM tf_v2_operations op
         JOIN tf_v2_resources r ON r.uid = op.resource_uid
         WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ?
           AND op.action = ? AND op.generation = ?
           AND op.backend_key = ? AND op.backend_id = ? AND op.target_key = ?
           AND op.accepted_spec_json = ?
           AND r.principal = ? AND r.space = ? AND r.name = ?
           AND r.form_url = ? AND r.backend_id = ? AND r.target_key = ?
         LIMIT 1`,
          [
            e.operationId,
            e.resourceUid,
            e.principal,
            e.action,
            e.generation,
            e.backendKey,
            e.backendId,
            e.targetKey,
            canonicalJson(e.spec),
            e.principal,
            e.space,
            e.name,
            e.form,
            e.backendId,
            e.targetKey,
          ],
        )
      ).length === 1
    );
  }

  async function recorded(
    identity: V2NativeEffectIdentity & { readonly receipt: string },
    column: "acknowledged_receipt" | "confirmed_receipt",
  ): Promise<boolean> {
    if (!validIdentity(identity) || typeof identity.receipt !== "string") return false;
    if (identity.receipt.length < 1 || identity.receipt.length > 255) return false;
    const other = column === "acknowledged_receipt" ? "confirmed_receipt" : "acknowledged_receipt";
    const e = identity.execution;
    const result = await sql.run(
      `UPDATE tf_v2_worker_native_effects SET ${column} = ?
       WHERE operation_id = ? AND resource_uid = ? AND principal = ? AND space = ?
         AND backend_key = ? AND backend_id = ? AND target_key = ?
         AND generation = ? AND native_identity = ? AND closure_digest = ?
         AND ${column} IS NULL AND (${other} IS NULL OR ${other} = ?)
         AND EXISTS (
           SELECT 1 FROM tf_v2_operations op
           WHERE op.id = tf_v2_worker_native_effects.operation_id
             AND op.accepted_spec_json = ? AND op.action = ?
         )`,
      [
        identity.receipt,
        e.operationId,
        e.resourceUid,
        e.principal,
        e.space,
        e.backendKey,
        e.backendId,
        e.targetKey,
        e.generation,
        identity.nativeIdentity,
        identity.closureDigest,
        identity.receipt,
        canonicalJson(e.spec),
        e.action,
      ],
    );
    if (result.changes === 1) return true;
    const existing = await intent(e.operationId);
    return (
      existing !== null &&
      sameIntent(existing, identity) &&
      existing[column] === identity.receipt &&
      (await acceptedIdentity(identity))
    );
  }

  return {
    async grant(identity) {
      if (!validIdentity(identity)) return "conflict";
      const nowMs = currentTime();
      if (nowMs === null) return "conflict";
      const e = identity.execution;
      const inserted = await sql.run(
        `INSERT INTO tf_v2_worker_native_effects (
           operation_id, resource_uid, principal, space, backend_key, backend_id,
           target_key, generation, native_identity, closure_digest,
           grant_lease_token, granted_at_ms
         )
         SELECT op.id, r.uid, op.principal, r.space, op.backend_key, op.backend_id,
           op.target_key, op.generation, ?, ?, op.lease_token, ${DB_NOW_MS}
         FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
         WHERE ${CLAIM}
         ON CONFLICT(operation_id) DO NOTHING`,
        [identity.nativeIdentity, identity.closureDigest, ...claimParams(e, nowMs)],
      );
      if (inserted.changes === 1) return "granted";
      if (!(await currentClaim(identity))) return "conflict";
      const existing = await intent(e.operationId);
      return existing && sameIntent(existing, identity) ? "already_granted" : "conflict";
    },
    async inspect(identity) {
      if (!(await currentClaim(identity))) return { kind: "conflict" };
      const existing = await intent(identity.execution.operationId);
      if (!existing) return { kind: "never_granted" };
      if (!sameIntent(existing, identity)) return { kind: "conflict" };
      if (existing.confirmed_receipt !== null) {
        return {
          kind: "confirmed",
          receipt: existing.confirmed_receipt,
          ...(existing.acknowledged_receipt === null
            ? {}
            : { acknowledgedReceipt: existing.acknowledged_receipt }),
        };
      }
      return {
        kind: "sent",
        ...(existing.acknowledged_receipt === null
          ? {}
          : { acknowledgedReceipt: existing.acknowledged_receipt }),
      };
    },
    async acknowledge(identity) {
      return await recorded(identity, "acknowledged_receipt");
    },
    async confirm(identity) {
      return await recorded(identity, "confirmed_receipt");
    },
  };
}
