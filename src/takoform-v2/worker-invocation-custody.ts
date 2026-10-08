import type { Clock, Sql } from "../ports.ts";

/** Host-only handle. The gateway never sends this to a customer Worker. */
export interface V2WorkerInvocationHandle {
  readonly invocationId: string;
  readonly custodyToken: string;
}

/** Fixed when the owning backend atomically admits against its live publication. */
export type V2WorkerInvocationIngress =
  | { readonly kind: "endpoint"; readonly endpointUid: string; readonly endpointGeneration: number }
  | {
      readonly kind: "service";
      readonly callerWorkerUid: string;
      readonly callerVersionUid: string;
      readonly callerVersionGeneration: number;
      readonly callerVersionOperationId: string;
      readonly bindingName: string;
      /** Nonsecret correlation only. Physical caller liveness is provider-owned. */
      readonly callerExecutionRef: string;
    };

export interface V2WorkerInvocationSelection {
  readonly workerUid: string;
  readonly deploymentUid: string;
  readonly deploymentGeneration: number;
  readonly sourceOperationId: string;
  readonly ingress: V2WorkerInvocationIngress;
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
  /** Trusted owner proved the native fetch was never invoked after beginSend. */
  readonly noNativeDispatchAtMs: number | null;
  /** Provider-origin terminal execution receipt, never inferred from body EOF. */
  readonly retirement: {
    readonly retiredAtMs: number;
    readonly receiptDigest: `sha256:${string}`;
  } | null;
}

export type V2WorkerInvocationRetirementIdentity = V2WorkerInvocationSelection &
  Pick<V2WorkerInvocationRecord, "backendId" | "targetKey" | "principal" | "space">;

export interface V2WorkerInvocationRetirementInput {
  readonly handle: V2WorkerInvocationHandle;
  /** Snapshot from the trusted native Tail receiver, not customer log fields. */
  readonly expected: V2WorkerInvocationRetirementIdentity;
  /** Stable fingerprint of the verified provider-origin terminal trace. */
  readonly receiptDigest: `sha256:${string}`;
}

/**
 * Portable custody of an already admitted invocation. Admission itself is a
 * backend-owned atomic comparison with its current native publication pointer;
 * this interface neither accepts route JSON nor promises a generic adapter.
 */
export interface V2WorkerInvocationCustody {
  read(handle: V2WorkerInvocationHandle): Promise<V2WorkerInvocationRecord | null>;
  /** One authorization to initiate the native dispatch; no retry after uncertainty. */
  beginSend(handle: V2WorkerInvocationHandle): Promise<boolean>;
  /** Only a proven pre-effect refusal may become terminal. */
  refuseBeforeSend(handle: V2WorkerInvocationHandle): Promise<boolean>;
  /** Trusted physical owner only, while it still proves no native fetch occurred. */
  confirmNoNativeDispatch(handle: V2WorkerInvocationHandle): Promise<boolean>;
  /** Gateway body observation, never a child-context or waitUntil retirement. */
  observeBody(handle: V2WorkerInvocationHandle, state: "finished" | "canceled"): Promise<boolean>;
  /** Trusted internal receipt only; this is not exposed through the Host HTTP API. */
  confirmNativeRetirement(input: V2WorkerInvocationRetirementInput): Promise<boolean>;
  /** Outstanding includes finished HTTP bodies until native context retirement is proved. */
  inspectDeployment(deploymentUid: string): Promise<{
    readonly outstanding: number;
    readonly bodyFinished: number;
  }>;
}

type Row = Record<string, unknown>;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const retirementIdentityKeys = [
  "backendId",
  "targetKey",
  "principal",
  "space",
  "workerUid",
  "deploymentUid",
  "deploymentGeneration",
  "sourceOperationId",
  "versionUid",
  "versionGeneration",
  "versionOperationId",
  "nativeIdentity",
  "closureDigest",
  "confirmedReceipt",
] as const;

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
    "version_uid",
    "version_operation_id",
    "native_identity",
    "closure_digest",
    "confirmed_receipt",
  ] as const;
  if (
    strings.some((key) => typeof row[key] !== "string") ||
    typeof row.deployment_generation !== "number" ||
    typeof row.version_generation !== "number" ||
    (row.phase !== "admitted" &&
      row.phase !== "send_authorized" &&
      row.phase !== "pre_effect_refused") ||
    (row.body_state !== null && row.body_state !== "finished" && row.body_state !== "canceled") ||
    (row.no_native_dispatch_at_ms !== null &&
      (typeof row.no_native_dispatch_at_ms !== "number" ||
        !Number.isSafeInteger(row.no_native_dispatch_at_ms) ||
        row.no_native_dispatch_at_ms < 0 ||
        row.phase !== "send_authorized" ||
        typeof row.send_authorized_at_ms !== "number" ||
        row.no_native_dispatch_at_ms < row.send_authorized_at_ms ||
        row.body_state !== null ||
        row.retired_at_ms !== null)) ||
    (row.retired_at_ms === null) !== (row.retirement_receipt_digest === null) ||
    (row.retired_at_ms !== null &&
      (typeof row.retired_at_ms !== "number" ||
        !Number.isSafeInteger(row.retired_at_ms) ||
        row.retired_at_ms < 0 ||
        typeof row.retirement_receipt_digest !== "string" ||
        !digestPattern.test(row.retirement_receipt_digest)))
  )
    return null;
  const ingress: V2WorkerInvocationIngress | null =
    (row.ingress_kind === "endpoint" || row.ingress_kind === undefined) &&
    typeof row.endpoint_uid === "string" &&
    row.endpoint_uid.length > 0 &&
    typeof row.endpoint_generation === "number" &&
    row.endpoint_generation > 0 &&
    [
      "service_caller_worker_uid",
      "service_caller_version_uid",
      "service_caller_version_generation",
      "service_caller_version_operation_id",
      "service_binding_name",
      "service_caller_execution_ref",
    ].every((key) => row[key] === null || row[key] === undefined)
      ? {
          kind: "endpoint",
          endpointUid: row.endpoint_uid,
          endpointGeneration: row.endpoint_generation,
        }
      : row.ingress_kind === "service" &&
          row.endpoint_uid === null &&
          row.endpoint_generation === null &&
          [
            "service_caller_worker_uid",
            "service_caller_version_uid",
            "service_caller_version_operation_id",
            "service_binding_name",
            "service_caller_execution_ref",
          ].every((key) => typeof row[key] === "string" && (row[key] as string).length > 0) &&
          typeof row.service_caller_version_generation === "number" &&
          row.service_caller_version_generation > 0
        ? {
            kind: "service",
            callerWorkerUid: row.service_caller_worker_uid as string,
            callerVersionUid: row.service_caller_version_uid as string,
            callerVersionGeneration: row.service_caller_version_generation,
            callerVersionOperationId: row.service_caller_version_operation_id as string,
            bindingName: row.service_binding_name as string,
            callerExecutionRef: row.service_caller_execution_ref as string,
          }
        : null;
  if (!ingress) return null;
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
    ingress: Object.freeze(ingress),
    versionUid: row.version_uid as string,
    versionGeneration: row.version_generation,
    versionOperationId: row.version_operation_id as string,
    nativeIdentity: row.native_identity as string,
    closureDigest: row.closure_digest as `sha256:${string}`,
    confirmedReceipt: row.confirmed_receipt as string,
    phase: row.phase,
    bodyState: row.body_state,
    noNativeDispatchAtMs: row.no_native_dispatch_at_ms as number | null,
    retirement:
      row.retired_at_ms === null
        ? null
        : Object.freeze({
            retiredAtMs: row.retired_at_ms as number,
            receiptDigest: row.retirement_receipt_digest as `sha256:${string}`,
          }),
  });
}

/** Common, provider-neutral lifecycle over the single invocation table. */
export function createV2WorkerInvocationLifecycle(options: {
  readonly sql: Sql;
  readonly now?: Clock;
}): V2WorkerInvocationCustody {
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
    async confirmNoNativeDispatch(handle: V2WorkerInvocationHandle): Promise<boolean> {
      const ownedHandle = ownHandle(handle);
      try {
        const result = await sql.run(
          `UPDATE tf_v2_worker_invocations
           SET no_native_dispatch_at_ms = max(?, send_authorized_at_ms)
           WHERE invocation_id = ? AND custody_token = ?
             AND phase = 'send_authorized' AND send_authorized_at_ms IS NOT NULL
             AND no_native_dispatch_at_ms IS NULL AND body_state IS NULL
             AND body_observed_at_ms IS NULL AND retired_at_ms IS NULL
             AND retirement_receipt_digest IS NULL`,
          [instant(), ownedHandle.invocationId, ownedHandle.custodyToken],
        );
        if (result.changes === 1) return true;
      } catch {
        // The exact row read resolves a lost acknowledgement without a new send.
      }
      return typeof (await read(ownedHandle))?.noNativeDispatchAtMs === "number";
    },
    async observeBody(
      handle: V2WorkerInvocationHandle,
      state: "finished" | "canceled",
    ): Promise<boolean> {
      const ownedHandle = ownHandle(handle);
      const result = await sql.run(
        `UPDATE tf_v2_worker_invocations SET body_state = ?, body_observed_at_ms = ?
         WHERE invocation_id = ? AND custody_token = ? AND phase = 'send_authorized'
           AND body_state IS NULL AND no_native_dispatch_at_ms IS NULL`,
        [state, instant(), ownedHandle.invocationId, ownedHandle.custodyToken],
      );
      if (result.changes === 1) return true;
      return (await read(ownedHandle))?.bodyState === state;
    },
    async confirmNativeRetirement(input: V2WorkerInvocationRetirementInput): Promise<boolean> {
      const handle = ownHandle(input.handle);
      const receiptDigest = input.receiptDigest;
      const raw = input.expected;
      const rawIngress = raw.ingress;
      const ingress: V2WorkerInvocationIngress | null =
        rawIngress?.kind === "endpoint" &&
        typeof rawIngress.endpointUid === "string" &&
        rawIngress.endpointUid.length > 0 &&
        Number.isSafeInteger(rawIngress.endpointGeneration) &&
        rawIngress.endpointGeneration > 0
          ? Object.freeze({
              kind: "endpoint",
              endpointUid: rawIngress.endpointUid,
              endpointGeneration: rawIngress.endpointGeneration,
            })
          : rawIngress?.kind === "service" &&
              [
                rawIngress.callerWorkerUid,
                rawIngress.callerVersionUid,
                rawIngress.callerVersionOperationId,
                rawIngress.bindingName,
                rawIngress.callerExecutionRef,
              ].every((value) => typeof value === "string" && value.length > 0) &&
              Number.isSafeInteger(rawIngress.callerVersionGeneration) &&
              rawIngress.callerVersionGeneration > 0
            ? Object.freeze({
                kind: "service",
                callerWorkerUid: rawIngress.callerWorkerUid,
                callerVersionUid: rawIngress.callerVersionUid,
                callerVersionGeneration: rawIngress.callerVersionGeneration,
                callerVersionOperationId: rawIngress.callerVersionOperationId,
                bindingName: rawIngress.bindingName,
                callerExecutionRef: rawIngress.callerExecutionRef,
              })
            : null;
      if (!ingress) return false;
      const expected: V2WorkerInvocationRetirementIdentity = Object.freeze({
        backendId: raw.backendId,
        targetKey: raw.targetKey,
        principal: raw.principal,
        space: raw.space,
        workerUid: raw.workerUid,
        deploymentUid: raw.deploymentUid,
        deploymentGeneration: raw.deploymentGeneration,
        sourceOperationId: raw.sourceOperationId,
        ingress,
        versionUid: raw.versionUid,
        versionGeneration: raw.versionGeneration,
        versionOperationId: raw.versionOperationId,
        nativeIdentity: raw.nativeIdentity,
        closureDigest: raw.closureDigest,
        confirmedReceipt: raw.confirmedReceipt,
      });
      if (
        !digestPattern.test(receiptDigest) ||
        !digestPattern.test(expected.closureDigest) ||
        retirementIdentityKeys.some((key) =>
          typeof expected[key] === "string"
            ? expected[key].length === 0
            : !Number.isSafeInteger(expected[key]) || expected[key] <= 0,
        )
      )
        return false;
      try {
        const result = await sql.run(
          `UPDATE tf_v2_worker_invocations
           SET retired_at_ms = max(?, send_authorized_at_ms),
               retirement_receipt_digest = ?
           WHERE invocation_id = ? AND custody_token = ?
             AND backend_id = ? AND target_key = ? AND principal = ? AND space = ?
             AND worker_uid = ? AND deployment_uid = ? AND deployment_generation = ?
             AND source_operation_id = ? AND ingress_kind = ?
             AND endpoint_uid IS ? AND endpoint_generation IS ?
             AND service_caller_worker_uid IS ? AND service_caller_version_uid IS ?
             AND service_caller_version_generation IS ? AND service_caller_version_operation_id IS ?
             AND service_binding_name IS ? AND service_caller_execution_ref IS ?
             AND version_uid = ? AND version_generation = ? AND version_operation_id = ?
             AND native_identity = ? AND closure_digest = ? AND confirmed_receipt = ?
             AND phase = 'send_authorized' AND retired_at_ms IS NULL
             AND retirement_receipt_digest IS NULL AND no_native_dispatch_at_ms IS NULL`,
          [
            instant(),
            receiptDigest,
            handle.invocationId,
            handle.custodyToken,
            expected.backendId,
            expected.targetKey,
            expected.principal,
            expected.space,
            expected.workerUid,
            expected.deploymentUid,
            expected.deploymentGeneration,
            expected.sourceOperationId,
            expected.ingress.kind,
            expected.ingress.kind === "endpoint" ? expected.ingress.endpointUid : null,
            expected.ingress.kind === "endpoint" ? expected.ingress.endpointGeneration : null,
            expected.ingress.kind === "service" ? expected.ingress.callerWorkerUid : null,
            expected.ingress.kind === "service" ? expected.ingress.callerVersionUid : null,
            expected.ingress.kind === "service" ? expected.ingress.callerVersionGeneration : null,
            expected.ingress.kind === "service" ? expected.ingress.callerVersionOperationId : null,
            expected.ingress.kind === "service" ? expected.ingress.bindingName : null,
            expected.ingress.kind === "service" ? expected.ingress.callerExecutionRef : null,
            expected.versionUid,
            expected.versionGeneration,
            expected.versionOperationId,
            expected.nativeIdentity,
            expected.closureDigest,
            expected.confirmedReceipt,
          ],
        );
        if (result.changes === 1) return true;
      } catch {
        // A lost ACK is resolved by the exact row, never by another native send.
      }
      const current = await read(handle);
      return (
        current?.retirement?.receiptDigest === receiptDigest &&
        retirementIdentityKeys.every((key) => current[key] === expected[key]) &&
        Object.keys(expected.ingress).every(
          (key) =>
            current.ingress[key as keyof V2WorkerInvocationIngress] ===
            expected.ingress[key as keyof V2WorkerInvocationIngress],
        )
      );
    },
    async inspectDeployment(
      deploymentUid: string,
    ): Promise<{ readonly outstanding: number; readonly bodyFinished: number }> {
      const rows = await sql.query(
        `SELECT count(*) AS outstanding,
           coalesce(sum(CASE WHEN body_state = 'finished' THEN 1 ELSE 0 END), 0) AS body_finished
         FROM tf_v2_worker_invocations
         WHERE deployment_uid = ? AND phase <> 'pre_effect_refused'
           AND retired_at_ms IS NULL AND no_native_dispatch_at_ms IS NULL`,
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
