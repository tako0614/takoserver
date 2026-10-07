import type { Clock, Sql } from "../ports.ts";

/** Host-only handle. The gateway never sends this to a customer Worker. */
export interface V2WorkerInvocationHandle {
  readonly invocationId: string;
  readonly custodyToken: string;
}

/** Fixed when the owning backend atomically admits against its live publication. */
export interface V2WorkerInvocationSelection {
  readonly workerUid: string;
  readonly deploymentUid: string;
  readonly deploymentGeneration: number;
  readonly sourceOperationId: string;
  readonly endpointUid: string;
  readonly endpointGeneration: number;
  readonly versionUid: string;
  readonly versionGeneration: number;
  readonly versionOperationId: string;
  readonly nativeIdentity: string;
  readonly closureDigest: `sha256:${string}`;
  readonly confirmedReceipt: string;
}

export type V2WorkerInvocationAdmission =
  | {
      readonly kind: "granted";
      readonly handle: V2WorkerInvocationHandle;
      readonly selected: V2WorkerInvocationSelection;
    }
  | {
      readonly kind: "already_admitted";
      readonly handle: V2WorkerInvocationHandle;
      readonly selected: V2WorkerInvocationSelection;
    }
  | { readonly kind: "unavailable" };

export interface V2WorkerInvocationRecord extends V2WorkerInvocationSelection {
  readonly handle: V2WorkerInvocationHandle;
  readonly backendId: string;
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly phase: "admitted" | "send_authorized" | "pre_effect_refused";
  readonly bodyState: "finished" | "canceled" | null;
}

/**
 * The backend implements admit with one INSERT ... SELECT against its current
 * native publication pointer and the public accepted graph. No caller-supplied
 * SQL guard, route JSON or tenant input is accepted by this portable port.
 */
export interface V2WorkerInvocationCustody {
  admit(
    input: V2WorkerInvocationHandle & {
      readonly hostname: string;
      readonly workerUid: string;
      readonly versionUid: string;
      readonly nativeIdentity: string;
    },
  ): Promise<V2WorkerInvocationAdmission>;
  read(handle: V2WorkerInvocationHandle): Promise<V2WorkerInvocationRecord | null>;
  /** One authorization to initiate the native dispatch; no retry after uncertainty. */
  beginSend(handle: V2WorkerInvocationHandle): Promise<boolean>;
  /** Only a proven pre-effect refusal may become terminal. */
  refuseBeforeSend(handle: V2WorkerInvocationHandle): Promise<boolean>;
  /** Gateway body observation, never a child-context or waitUntil retirement. */
  observeBody(handle: V2WorkerInvocationHandle, state: "finished" | "canceled"): Promise<boolean>;
  /** Outstanding includes finished HTTP bodies until native context retirement is proved. */
  inspectDeployment(deploymentUid: string): Promise<{
    readonly outstanding: number;
    readonly bodyFinished: number;
  }>;
}

type Row = Record<string, unknown>;

function ownHandle(handle: V2WorkerInvocationHandle): V2WorkerInvocationHandle {
  return Object.freeze({ invocationId: handle.invocationId, custodyToken: handle.custodyToken });
}

function record(
  row: Row | undefined,
  handle: V2WorkerInvocationHandle,
): V2WorkerInvocationRecord | null {
  if (
    !row ||
    row.invocation_id !== handle.invocationId ||
    row.custody_token !== handle.custodyToken
  )
    return null;
  const strings = [
    "backend_id",
    "target_key",
    "principal",
    "space",
    "worker_uid",
    "deployment_uid",
    "source_operation_id",
    "endpoint_uid",
    "version_uid",
    "version_operation_id",
    "native_identity",
    "closure_digest",
    "confirmed_receipt",
  ] as const;
  if (
    strings.some((key) => typeof row[key] !== "string") ||
    typeof row.deployment_generation !== "number" ||
    typeof row.endpoint_generation !== "number" ||
    typeof row.version_generation !== "number" ||
    (row.phase !== "admitted" &&
      row.phase !== "send_authorized" &&
      row.phase !== "pre_effect_refused") ||
    (row.body_state !== null && row.body_state !== "finished" && row.body_state !== "canceled")
  )
    return null;
  return Object.freeze({
    handle: Object.freeze({ invocationId: handle.invocationId, custodyToken: handle.custodyToken }),
    backendId: row.backend_id as string,
    targetKey: row.target_key as string,
    principal: row.principal as string,
    space: row.space as string,
    workerUid: row.worker_uid as string,
    deploymentUid: row.deployment_uid as string,
    deploymentGeneration: row.deployment_generation,
    sourceOperationId: row.source_operation_id as string,
    endpointUid: row.endpoint_uid as string,
    endpointGeneration: row.endpoint_generation,
    versionUid: row.version_uid as string,
    versionGeneration: row.version_generation,
    versionOperationId: row.version_operation_id as string,
    nativeIdentity: row.native_identity as string,
    closureDigest: row.closure_digest as `sha256:${string}`,
    confirmedReceipt: row.confirmed_receipt as string,
    phase: row.phase,
    bodyState: row.body_state,
  });
}

/** Common, provider-neutral lifecycle over the single invocation table. */
export function createV2WorkerInvocationLifecycle(options: {
  readonly sql: Sql;
  readonly now?: Clock;
}) {
  const { sql } = options;
  const now = options.now ?? (() => new Date());
  function instant(): number {
    const value = now().getTime();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid invocation clock");
    return value;
  }
  async function read(handle: V2WorkerInvocationHandle): Promise<V2WorkerInvocationRecord | null> {
    const ownedHandle = ownHandle(handle);
    const rows = await sql.query(
      "SELECT * FROM tf_v2_worker_invocations WHERE invocation_id = ? AND custody_token = ? LIMIT 2",
      [ownedHandle.invocationId, ownedHandle.custodyToken],
    );
    return rows.length === 1 ? record(rows[0], ownedHandle) : null;
  }
  return {
    read,
    async beginSend(handle: V2WorkerInvocationHandle): Promise<boolean> {
      const ownedHandle = ownHandle(handle);
      const result = await sql.run(
        `UPDATE tf_v2_worker_invocations SET phase = 'send_authorized', send_authorized_at_ms = ?
         WHERE invocation_id = ? AND custody_token = ? AND phase = 'admitted'`,
        [instant(), ownedHandle.invocationId, ownedHandle.custodyToken],
      );
      return result.changes === 1;
    },
    async refuseBeforeSend(handle: V2WorkerInvocationHandle): Promise<boolean> {
      const ownedHandle = ownHandle(handle);
      const result = await sql.run(
        `UPDATE tf_v2_worker_invocations SET phase = 'pre_effect_refused', refused_at_ms = ?
         WHERE invocation_id = ? AND custody_token = ? AND phase = 'admitted'`,
        [instant(), ownedHandle.invocationId, ownedHandle.custodyToken],
      );
      return result.changes === 1;
    },
    async observeBody(
      handle: V2WorkerInvocationHandle,
      state: "finished" | "canceled",
    ): Promise<boolean> {
      const ownedHandle = ownHandle(handle);
      const result = await sql.run(
        `UPDATE tf_v2_worker_invocations SET body_state = ?, body_observed_at_ms = ?
         WHERE invocation_id = ? AND custody_token = ? AND phase = 'send_authorized'
           AND body_state IS NULL`,
        [state, instant(), ownedHandle.invocationId, ownedHandle.custodyToken],
      );
      if (result.changes === 1) return true;
      return (await read(ownedHandle))?.bodyState === state;
    },
    async inspectDeployment(
      deploymentUid: string,
    ): Promise<{ readonly outstanding: number; readonly bodyFinished: number }> {
      const rows = await sql.query(
        `SELECT count(*) AS outstanding,
           coalesce(sum(CASE WHEN body_state = 'finished' THEN 1 ELSE 0 END), 0) AS body_finished
         FROM tf_v2_worker_invocations
         WHERE deployment_uid = ? AND phase <> 'pre_effect_refused'`,
        [deploymentUid],
      );
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        typeof row.outstanding !== "number" ||
        typeof row.body_finished !== "number"
      )
        throw new TypeError("invocation inventory unavailable");
      return { outstanding: row.outstanding, bodyFinished: row.body_finished };
    },
  };
}
