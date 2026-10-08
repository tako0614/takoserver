import type { Clock, Sql } from "../ports.ts";
import {
  inspectV2WorkerInvocationSchema,
  v2WorkerInvocationSchemaReady,
} from "./worker-invocation-schema.ts";

/** Host-only handle. The gateway never sends this to a customer Worker. */
export interface V2WorkerInvocationHandle {
  readonly invocationId: string;
  readonly custodyToken: string;
}

/** Fixed when the owning backend atomically admits against its live publication. */
export type V2WorkerInvocationIngress =
  | { readonly kind: "endpoint"; readonly endpointUid: string; readonly endpointGeneration: number }
  | {
      readonly kind: "cron";
      readonly matchId: string;
      readonly triggerOperationId: string;
      readonly leaseToken: string;
      readonly attempt: number;
    }
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

export interface V2WorkerCronRouteRelease {
  readonly versionUid: string;
  readonly versionGeneration: number;
  readonly scriptName: string;
  readonly weight: number;
  readonly descriptorDigest: `sha256:${string}`;
  readonly providerEtag: string;
}

/** Host-private witness. SQL, not these fields, resolves the accepted authority. */
export interface V2WorkerCronInvocationClaim {
  readonly handle: V2WorkerInvocationHandle;
  readonly match: {
    readonly matchId: string;
    readonly leaseToken: string;
    readonly attempt: number;
  };
  readonly route: {
    readonly targetKey: string;
    readonly workerUid: string;
    readonly deploymentUid: string;
    readonly deploymentGeneration: number;
    readonly sourceOperationId: string;
    readonly releases: readonly V2WorkerCronRouteRelease[];
  };
  readonly selected: V2WorkerCronRouteRelease;
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
  /** One physical Cron attempt for one durable match lease, atomically resolved from SQL. */
  admitCron(claim: V2WorkerCronInvocationClaim): Promise<V2WorkerInvocationAdmission>;
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
const SQL_LEASE_NOW = `(CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000`;
const CRON_FORM = "https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/";
const WORKER_FORM = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
const DEPLOYMENT_FORM = "https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/";
const VERSION_FORM = "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/";
function boundedText(value: unknown, maximum = 255, minimum = 1): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

// One statement is the Cron admission linearization point. No pre-await graph
// observation or route JSON is itself authority; each is compared with current
// accepted SQL rows and the exact confirmed native Version receipt here.
const ADMIT_CRON_SQL = `INSERT INTO tf_v2_worker_invocations
  (invocation_id,custody_token,backend_id,target_key,principal,space,
   worker_uid,deployment_uid,deployment_generation,source_operation_id,
   ingress_kind,cron_match_id,cron_trigger_operation_id,cron_lease_token,cron_attempt,
   version_uid,version_generation,version_operation_id,native_identity,closure_digest,
   confirmed_receipt,admitted_at_ms)
  SELECT ?,?,d.backend_id,m.target_key,m.principal,m.space,
    m.worker_uid,d.uid,d.generation,dop.id,
    'cron',m.match_id,m.trigger_operation_id,m.lease_token,m.attempts,
    v.uid,v.generation,vop.id,n.native_identity,n.closure_digest,n.confirmed_receipt,?
  FROM tf_v2_worker_cron_matches m
  JOIN tf_v2_resources trigger_resource ON trigger_resource.uid=m.trigger_uid
  JOIN tf_v2_operations trigger_op ON trigger_op.id=m.trigger_operation_id
  JOIN tf_v2_resources worker ON worker.uid=m.worker_uid
  JOIN tf_v2_operations worker_op ON worker_op.id=worker.last_operation
  JOIN tf_v2_resources d ON d.uid=json_extract(worker.observed_json,'$.activeDeploymentUid')
  JOIN tf_v2_operations dop ON dop.id=d.last_operation
  JOIN tf_v2_resources v ON v.uid=?
  JOIN tf_v2_operations vop ON vop.id=v.last_operation
  JOIN tf_v2_worker_native_effects n ON n.operation_id=vop.id
  JOIN tf_v2_operation_reference_sets deployment_refs ON deployment_refs.operation_id=dop.id
  JOIN tf_v2_operation_reference_sets version_refs ON version_refs.operation_id=vop.id
  WHERE m.match_id=? AND m.lease_token=? AND m.attempts=?
    AND m.target_key=? AND m.state='dispatching' AND m.lease_until_ms > ${SQL_LEASE_NOW}
    AND trigger_resource.form_url='${CRON_FORM}'
    AND trigger_resource.principal=m.principal AND trigger_resource.space=m.space
    AND trigger_resource.target_key=m.target_key AND trigger_resource.deleted_at IS NULL
    AND trigger_resource.generation>=m.trigger_generation
    AND trigger_op.resource_uid=trigger_resource.uid AND trigger_op.principal=m.principal
    AND trigger_op.target_key=m.target_key AND trigger_op.generation=m.trigger_generation
    AND trigger_op.action IN ('create','update') AND trigger_op.status='succeeded'
    AND trigger_op.effect='complete' AND trigger_op.updated_at=m.trigger_settled_at
    AND json_extract(trigger_op.accepted_spec_json,'$.worker.resourceUid')=m.worker_uid
    AND json_extract(trigger_op.accepted_spec_json,'$.cron')=m.cron
    AND worker.uid=? AND worker.form_url='${WORKER_FORM}'
    AND worker.principal=m.principal AND worker.space=m.space AND worker.target_key=m.target_key
    AND worker.deleted_at IS NULL AND worker.phase='idle' AND worker.busy_operation IS NULL
    AND worker.generation=worker.observed_generation
    AND json_type(worker.observed_json,'$.ready')='true'
    AND worker_op.resource_uid=worker.uid AND worker_op.principal=m.principal
    AND worker_op.target_key=m.target_key AND worker_op.generation=worker.generation
    AND worker_op.action IN ('create','update') AND worker_op.status='succeeded'
    AND worker_op.effect='complete' AND worker_op.accepted_spec_json=worker.spec_json
    AND d.uid=? AND d.form_url='${DEPLOYMENT_FORM}'
    AND d.principal=m.principal AND d.space=m.space AND d.target_key=m.target_key
    AND d.deleted_at IS NULL AND d.phase='idle' AND d.busy_operation IS NULL
    AND d.generation=? AND d.observed_generation=d.generation
    AND json_type(d.observed_json,'$.ready')='true'
    AND json_extract(d.observed_json,'$.active')=1
    AND json_extract(d.spec_json,'$.worker.resourceUid')=worker.uid
    AND dop.id=? AND dop.resource_uid=d.uid AND dop.principal=m.principal
    AND dop.target_key=m.target_key AND dop.generation=d.generation
    AND dop.action IN ('create','update') AND dop.status='succeeded'
    AND dop.effect='complete' AND dop.accepted_spec_json=d.spec_json
    AND deployment_refs.sealed=1
    AND EXISTS (SELECT 1 FROM tf_v2_operation_references ref
      WHERE ref.operation_id=dop.id AND ref.target_uid=worker.uid
        AND ref.form_url='${WORKER_FORM}' AND ref.readiness='observed')
    AND EXISTS (SELECT 1 FROM tf_v2_resource_references edge
      WHERE edge.referrer_uid=d.uid AND edge.target_uid=worker.uid)
    AND v.form_url='${VERSION_FORM}' AND v.principal=m.principal AND v.space=m.space
    AND v.target_key=m.target_key AND v.deleted_at IS NULL
    AND v.phase='idle' AND v.busy_operation IS NULL
    AND v.generation=? AND v.observed_generation=v.generation
    AND json_type(v.observed_json,'$.ready')='true'
    AND json_extract(v.spec_json,'$.worker.resourceUid')=worker.uid
    AND EXISTS (SELECT 1 FROM json_each(v.spec_json,'$.handlers') handler
      WHERE handler.value='scheduled')
    AND vop.resource_uid=v.uid AND vop.principal=m.principal
    AND vop.target_key=m.target_key AND vop.generation=v.generation
    AND vop.action IN ('create','update') AND vop.status='succeeded'
    AND vop.effect='complete' AND vop.accepted_spec_json=v.spec_json
    AND version_refs.sealed=1
    AND EXISTS (SELECT 1 FROM tf_v2_operation_references ref
      WHERE ref.operation_id=vop.id AND ref.target_uid=worker.uid
        AND ref.form_url='${WORKER_FORM}' AND ref.readiness='observed')
    AND EXISTS (SELECT 1 FROM tf_v2_resource_references edge
      WHERE edge.referrer_uid=v.uid AND edge.target_uid=worker.uid)
    AND EXISTS (SELECT 1 FROM tf_v2_operation_references ref
      WHERE ref.operation_id=dop.id AND ref.target_uid=v.uid
        AND ref.form_url='${VERSION_FORM}' AND ref.readiness='ready')
    AND EXISTS (SELECT 1 FROM tf_v2_resource_references edge
      WHERE edge.referrer_uid=d.uid AND edge.target_uid=v.uid)
    AND n.resource_uid=v.uid AND n.principal=m.principal AND n.space=m.space
    AND n.backend_id=v.backend_id AND n.target_key=m.target_key
    AND n.generation=v.generation AND n.confirmed_receipt IS NOT NULL
    AND n.native_identity=? AND n.closure_digest=? AND n.confirmed_receipt=?
    AND json_array_length(json_extract(d.spec_json,'$.versions')) =
      json_array_length(json_extract(?,'$.releases'))
    AND json_array_length(json_extract(d.observed_json,'$.selectedVersions')) =
      json_array_length(json_extract(?,'$.releases'))
    AND EXISTS (SELECT 1 FROM json_each(?,'$.releases') release
      WHERE json_extract(release.value,'$.versionUid')=v.uid
        AND json_extract(release.value,'$.versionGeneration')=v.generation
        AND json_extract(release.value,'$.scriptName')=n.native_identity
        AND json_extract(release.value,'$.descriptorDigest')=n.closure_digest
        AND json_extract(release.value,'$.providerEtag')=n.confirmed_receipt
        AND json_extract(release.value,'$.weight')=?)
    AND NOT EXISTS (SELECT 1 FROM json_each(?,'$.releases') release
      LEFT JOIN tf_v2_resources rv ON rv.uid=json_extract(release.value,'$.versionUid')
      LEFT JOIN tf_v2_operations rop ON rop.id=rv.last_operation
      LEFT JOIN tf_v2_worker_native_effects rn ON rn.operation_id=rop.id
      WHERE rv.uid IS NULL OR rv.principal IS NOT m.principal OR rv.space IS NOT m.space
        OR rv.target_key IS NOT m.target_key OR rv.form_url IS NOT '${VERSION_FORM}'
        OR rv.deleted_at IS NOT NULL OR rv.phase IS NOT 'idle' OR rv.busy_operation IS NOT NULL
        OR rv.generation IS NOT rv.observed_generation
        OR rv.generation IS NOT json_extract(release.value,'$.versionGeneration')
        OR json_type(rv.observed_json,'$.ready') IS NOT 'true'
        OR json_extract(rv.spec_json,'$.worker.resourceUid') IS NOT worker.uid
        OR NOT EXISTS (SELECT 1 FROM json_each(rv.spec_json,'$.handlers') handler
          WHERE handler.value='scheduled')
        OR rop.status IS NOT 'succeeded' OR rop.effect IS NOT 'complete'
        OR rop.resource_uid IS NOT rv.uid OR rop.principal IS NOT m.principal
        OR rop.target_key IS NOT m.target_key
        OR rop.generation IS NOT rv.generation OR rop.accepted_spec_json IS NOT rv.spec_json
        OR rn.resource_uid IS NOT rv.uid OR rn.principal IS NOT m.principal
        OR rn.space IS NOT m.space OR rn.backend_id IS NOT rv.backend_id
        OR rn.target_key IS NOT m.target_key OR rn.generation IS NOT rv.generation
        OR rn.native_identity IS NOT json_extract(release.value,'$.scriptName')
        OR rn.closure_digest IS NOT json_extract(release.value,'$.descriptorDigest')
        OR rn.confirmed_receipt IS NOT json_extract(release.value,'$.providerEtag')
        OR rn.confirmed_receipt IS NULL)
    AND NOT EXISTS (SELECT 1 FROM json_each(d.spec_json,'$.versions') desired
      WHERE NOT EXISTS (SELECT 1 FROM json_each(?,'$.releases') release
        WHERE json_extract(release.value,'$.versionUid')=
          json_extract(desired.value,'$.workerVersion.resourceUid')
          AND json_extract(release.value,'$.weight')=json_extract(desired.value,'$.weight')))
    AND NOT EXISTS (SELECT 1 FROM json_each(d.observed_json,'$.selectedVersions') observed
      WHERE NOT EXISTS (SELECT 1 FROM json_each(?,'$.releases') release
        WHERE json_extract(release.value,'$.versionUid')=json_extract(observed.value,'$.resourceUid')
          AND json_extract(release.value,'$.weight')=json_extract(observed.value,'$.weight')))
    AND (${v2WorkerInvocationSchemaReady("cron")})
  ON CONFLICT DO NOTHING`;
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
      : row.ingress_kind === "cron" &&
          row.endpoint_uid === null &&
          row.endpoint_generation === null &&
          [
            "service_caller_worker_uid",
            "service_caller_version_uid",
            "service_caller_version_generation",
            "service_caller_version_operation_id",
            "service_binding_name",
            "service_caller_execution_ref",
          ].every((key) => row[key] === null) &&
          typeof row.cron_match_id === "string" &&
          digestPattern.test(row.cron_match_id) &&
          typeof row.cron_trigger_operation_id === "string" &&
          typeof row.cron_lease_token === "string" &&
          typeof row.cron_attempt === "number" &&
          Number.isSafeInteger(row.cron_attempt) &&
          row.cron_attempt > 0
        ? {
            kind: "cron",
            matchId: row.cron_match_id,
            triggerOperationId: row.cron_trigger_operation_id,
            leaseToken: row.cron_lease_token,
            attempt: row.cron_attempt,
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
  const anyReady = `(${v2WorkerInvocationSchemaReady("endpoint")}) OR (${v2WorkerInvocationSchemaReady("service")}) OR (${v2WorkerInvocationSchemaReady("cron")})`;
  function instant(): number {
    const value = now().getTime();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid invocation clock");
    return value;
  }
  async function read(handle: V2WorkerInvocationHandle): Promise<V2WorkerInvocationRecord | null> {
    const ownedHandle = ownHandle(handle);
    const rows = await sql.query(
      `SELECT * FROM tf_v2_worker_invocations WHERE invocation_id = ? AND custody_token = ?
        AND (${anyReady}) LIMIT 2`,
      [ownedHandle.invocationId, ownedHandle.custodyToken],
    );
    return rows.length === 1 ? record(rows[0], ownedHandle) : null;
  }
  return {
    async admitCron(raw: V2WorkerCronInvocationClaim): Promise<V2WorkerInvocationAdmission> {
      const unavailable = { kind: "unavailable" } as const;
      const handle = raw?.handle;
      const match = raw?.match;
      const route = raw?.route;
      const chosen = raw?.selected;
      if (
        !boundedText(handle?.invocationId) ||
        !boundedText(handle?.custodyToken, 255, 16) ||
        !boundedText(match?.matchId, 71, 71) ||
        !digestPattern.test(match.matchId) ||
        !boundedText(match?.leaseToken, 255, 16) ||
        !Number.isSafeInteger(match?.attempt) ||
        match.attempt < 1 ||
        !boundedText(route?.targetKey) ||
        !boundedText(route?.workerUid) ||
        !boundedText(route?.deploymentUid) ||
        !Number.isSafeInteger(route?.deploymentGeneration) ||
        route.deploymentGeneration < 1 ||
        !boundedText(route?.sourceOperationId) ||
        !Array.isArray(route?.releases) ||
        route.releases.length < 1 ||
        route.releases.length > 100
      )
        return unavailable;
      const releases: V2WorkerCronRouteRelease[] = [];
      const uids = new Set<string>();
      let weight = 0;
      for (const item of route.releases) {
        if (
          !boundedText(item?.versionUid) ||
          uids.has(item.versionUid) ||
          !Number.isSafeInteger(item.versionGeneration) ||
          item.versionGeneration < 1 ||
          !boundedText(item.scriptName) ||
          !Number.isSafeInteger(item.weight) ||
          item.weight < 1 ||
          item.weight > 10_000 ||
          !digestPattern.test(item.descriptorDigest) ||
          !boundedText(item.providerEtag)
        )
          return unavailable;
        uids.add(item.versionUid);
        weight += item.weight;
        releases.push({
          versionUid: item.versionUid,
          versionGeneration: item.versionGeneration,
          scriptName: item.scriptName,
          weight: item.weight,
          descriptorDigest: item.descriptorDigest,
          providerEtag: item.providerEtag,
        });
      }
      if (
        weight !== 10_000 ||
        !chosen ||
        !releases.some(
          (item) =>
            item.versionUid === chosen.versionUid &&
            item.versionGeneration === chosen.versionGeneration &&
            item.scriptName === chosen.scriptName &&
            item.weight === chosen.weight &&
            item.descriptorDigest === chosen.descriptorDigest &&
            item.providerEtag === chosen.providerEtag,
        )
      )
        return unavailable;
      const ownedHandle = ownHandle(handle);
      const ownedMatch = Object.freeze({
        matchId: match.matchId,
        leaseToken: match.leaseToken,
        attempt: match.attempt,
      });
      const ownedRoute = Object.freeze({
        targetKey: route.targetKey,
        workerUid: route.workerUid,
        deploymentUid: route.deploymentUid,
        deploymentGeneration: route.deploymentGeneration,
        sourceOperationId: route.sourceOperationId,
        releases,
      });
      const selected = { ...chosen };
      const routeJson = JSON.stringify(ownedRoute);
      let changed = 0;
      try {
        changed = (
          await sql.run(ADMIT_CRON_SQL, [
            ownedHandle.invocationId,
            ownedHandle.custodyToken,
            instant(),
            selected.versionUid,
            ownedMatch.matchId,
            ownedMatch.leaseToken,
            ownedMatch.attempt,
            ownedRoute.targetKey,
            ownedRoute.workerUid,
            ownedRoute.deploymentUid,
            ownedRoute.deploymentGeneration,
            ownedRoute.sourceOperationId,
            selected.versionGeneration,
            selected.scriptName,
            selected.descriptorDigest,
            selected.providerEtag,
            routeJson,
            routeJson,
            routeJson,
            selected.weight,
            routeJson,
            routeJson,
            routeJson,
          ])
        ).changes;
      } catch {
        // An unknown INSERT acknowledgement is resolved by one exact row read.
      }
      try {
        const rows = await sql.query(
          `SELECT * FROM tf_v2_worker_invocations
           WHERE cron_match_id=? AND cron_attempt=? AND cron_lease_token=?
             AND (${v2WorkerInvocationSchemaReady("cron")}) LIMIT 2`,
          [ownedMatch.matchId, ownedMatch.attempt, ownedMatch.leaseToken],
        );
        const row = rows.length === 1 ? rows[0] : undefined;
        if (!row || typeof row.invocation_id !== "string" || typeof row.custody_token !== "string")
          return unavailable;
        const found = record(row, {
          invocationId: row.invocation_id,
          custodyToken: row.custody_token,
        });
        if (
          found?.ingress.kind !== "cron" ||
          found.ingress.matchId !== ownedMatch.matchId ||
          found.ingress.leaseToken !== ownedMatch.leaseToken ||
          found.ingress.attempt !== ownedMatch.attempt ||
          found.targetKey !== ownedRoute.targetKey ||
          found.workerUid !== ownedRoute.workerUid ||
          found.deploymentUid !== ownedRoute.deploymentUid ||
          found.deploymentGeneration !== ownedRoute.deploymentGeneration ||
          found.sourceOperationId !== ownedRoute.sourceOperationId ||
          found.versionUid !== selected.versionUid ||
          found.versionGeneration !== selected.versionGeneration ||
          found.nativeIdentity !== selected.scriptName ||
          found.closureDigest !== selected.descriptorDigest ||
          found.confirmedReceipt !== selected.providerEtag ||
          (changed === 1 &&
            (found.handle.invocationId !== ownedHandle.invocationId ||
              found.handle.custodyToken !== ownedHandle.custodyToken))
        )
          return unavailable;
        return {
          kind: changed === 1 ? "granted" : "already_admitted",
          handle: found.handle,
          selected: {
            workerUid: found.workerUid,
            deploymentUid: found.deploymentUid,
            deploymentGeneration: found.deploymentGeneration,
            sourceOperationId: found.sourceOperationId,
            ingress: found.ingress,
            versionUid: found.versionUid,
            versionGeneration: found.versionGeneration,
            versionOperationId: found.versionOperationId,
            nativeIdentity: found.nativeIdentity,
            closureDigest: found.closureDigest,
            confirmedReceipt: found.confirmedReceipt,
          },
        };
      } catch {
        return unavailable;
      }
    },
    read,
    async beginSend(handle: V2WorkerInvocationHandle): Promise<boolean> {
      const ownedHandle = ownHandle(handle);
      // The pre-await schema probe only selects a compatible SQL shape. For
      // Cron, the UPDATE itself is the authorization linearization point: its
      // match/lease/current-publication predicates use SQLite's clock after
      // any adapter delay, never the earlier host timestamp passed to SET.
      const schema = await inspectV2WorkerInvocationSchema(sql);
      if (!schema) return false;
      // Keep the Cron predicates in bounded conjunctions. SQLite parses a
      // long left-associated AND chain as a deep expression tree even when an
      // Endpoint or Service row makes the Cron branch false at execution time.
      const cronGate =
        schema === "cron"
          ? `AND (ingress_kind <> 'cron' OR EXISTS (
             SELECT 1 FROM tf_v2_worker_cron_matches m
             JOIN tf_v2_resources trigger_resource ON trigger_resource.uid=m.trigger_uid
             JOIN tf_v2_resources worker ON worker.uid=m.worker_uid
             JOIN tf_v2_resources deployment ON deployment.uid=tf_v2_worker_invocations.deployment_uid
             JOIN tf_v2_resources version ON version.uid=tf_v2_worker_invocations.version_uid
             JOIN tf_v2_worker_native_effects publication
               ON publication.operation_id=tf_v2_worker_invocations.version_operation_id
             WHERE (m.match_id=tf_v2_worker_invocations.cron_match_id
               AND m.trigger_operation_id=tf_v2_worker_invocations.cron_trigger_operation_id
               AND m.lease_token=tf_v2_worker_invocations.cron_lease_token
               AND m.attempts=tf_v2_worker_invocations.cron_attempt
               AND m.state='dispatching' AND m.lease_until_ms > ${SQL_LEASE_NOW}
               AND m.principal=tf_v2_worker_invocations.principal
               AND m.space=tf_v2_worker_invocations.space
               AND m.target_key=tf_v2_worker_invocations.target_key)
               AND (trigger_resource.principal=m.principal AND trigger_resource.space=m.space
               AND trigger_resource.target_key=m.target_key
               AND trigger_resource.form_url='${CRON_FORM}'
               AND trigger_resource.deleted_at IS NULL
               AND trigger_resource.generation>=m.trigger_generation)
               AND (worker.principal=m.principal AND worker.space=m.space
               AND worker.target_key=m.target_key AND worker.form_url='${WORKER_FORM}'
               AND worker.deleted_at IS NULL AND worker.phase='idle'
               AND worker.busy_operation IS NULL AND worker.generation=worker.observed_generation
               AND json_type(worker.observed_json,'$.ready')='true'
               AND json_extract(worker.observed_json,'$.activeDeploymentUid')=deployment.uid)
               AND (deployment.principal=m.principal AND deployment.space=m.space
               AND deployment.target_key=m.target_key AND deployment.form_url='${DEPLOYMENT_FORM}'
               AND deployment.deleted_at IS NULL AND deployment.phase='idle'
               AND deployment.busy_operation IS NULL
               AND deployment.generation=tf_v2_worker_invocations.deployment_generation
               AND deployment.observed_generation=deployment.generation
               AND deployment.last_operation=tf_v2_worker_invocations.source_operation_id
               AND json_type(deployment.observed_json,'$.ready')='true'
               AND json_extract(deployment.observed_json,'$.active')=1
               AND json_array_length(json_extract(deployment.spec_json,'$.versions'))=
                 json_array_length(json_extract(deployment.observed_json,'$.selectedVersions')))
               AND (NOT EXISTS (SELECT 1 FROM json_each(deployment.spec_json,'$.versions') desired
                 WHERE NOT EXISTS (SELECT 1 FROM json_each(deployment.observed_json,'$.selectedVersions') observed
                   WHERE json_extract(observed.value,'$.resourceUid')=
                     json_extract(desired.value,'$.workerVersion.resourceUid')
                     AND json_extract(observed.value,'$.weight')=json_extract(desired.value,'$.weight')))
               AND NOT EXISTS (SELECT 1 FROM json_each(deployment.observed_json,'$.selectedVersions') observed
                 WHERE NOT EXISTS (SELECT 1 FROM json_each(deployment.spec_json,'$.versions') desired
                   WHERE json_extract(desired.value,'$.workerVersion.resourceUid')=
                     json_extract(observed.value,'$.resourceUid')
                     AND json_extract(desired.value,'$.weight')=json_extract(observed.value,'$.weight')))
               AND EXISTS (SELECT 1 FROM json_each(deployment.spec_json,'$.versions') desired
                 JOIN json_each(deployment.observed_json,'$.selectedVersions') observed
                   ON json_extract(observed.value,'$.resourceUid')=
                     json_extract(desired.value,'$.workerVersion.resourceUid')
                   AND json_extract(observed.value,'$.weight')=json_extract(desired.value,'$.weight')
                 WHERE json_extract(desired.value,'$.workerVersion.resourceUid')=version.uid))
               AND (version.principal=m.principal AND version.space=m.space
               AND version.target_key=m.target_key AND version.form_url='${VERSION_FORM}'
               AND version.deleted_at IS NULL AND version.phase='idle'
               AND version.busy_operation IS NULL
               AND version.generation=tf_v2_worker_invocations.version_generation
               AND version.observed_generation=version.generation
               AND version.last_operation=tf_v2_worker_invocations.version_operation_id
               AND json_type(version.observed_json,'$.ready')='true'
               AND EXISTS (SELECT 1 FROM json_each(version.spec_json,'$.handlers') handler
                 WHERE handler.value='scheduled'))
               AND (publication.native_identity=tf_v2_worker_invocations.native_identity
               AND publication.closure_digest=tf_v2_worker_invocations.closure_digest
               AND publication.confirmed_receipt=tf_v2_worker_invocations.confirmed_receipt)
           ))`
          : "";
      try {
        const result = await sql.run(
          `UPDATE tf_v2_worker_invocations SET phase = 'send_authorized', send_authorized_at_ms = ?
         WHERE invocation_id = ? AND custody_token = ? AND phase = 'admitted'
           AND (${v2WorkerInvocationSchemaReady(schema)}) ${cronGate}`,
          [instant(), ownedHandle.invocationId, ownedHandle.custodyToken],
        );
        return result.changes === 1;
      } catch {
        // Ambiguous authorization ACK is never permission to retry the fetch.
        return false;
      }
    },
    async refuseBeforeSend(handle: V2WorkerInvocationHandle): Promise<boolean> {
      const ownedHandle = ownHandle(handle);
      const result = await sql.run(
        `UPDATE tf_v2_worker_invocations SET phase = 'pre_effect_refused', refused_at_ms = ?
         WHERE invocation_id = ? AND custody_token = ? AND phase = 'admitted'
           AND (${anyReady})`,
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
             AND retirement_receipt_digest IS NULL AND (${anyReady})`,
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
           AND body_state IS NULL AND no_native_dispatch_at_ms IS NULL
           AND (${anyReady})`,
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
            : rawIngress?.kind === "cron" &&
                digestPattern.test(rawIngress.matchId) &&
                boundedText(rawIngress.triggerOperationId) &&
                boundedText(rawIngress.leaseToken, 255, 16) &&
                Number.isSafeInteger(rawIngress.attempt) &&
                rawIngress.attempt > 0
              ? Object.freeze({
                  kind: "cron",
                  matchId: rawIngress.matchId,
                  triggerOperationId: rawIngress.triggerOperationId,
                  leaseToken: rawIngress.leaseToken,
                  attempt: rawIngress.attempt,
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
      // 0086 is source-only for protected D1 until an owning apply wave is
      // authorized. Continue exact Endpoint retirement on an 0084/0085 DB;
      // never offer this legacy path to a Service or a partial schema.
      const schema = await inspectV2WorkerInvocationSchema(sql);
      if (schema === null || (schema === "endpoint" && expected.ingress.kind !== "endpoint"))
        return false;
      const serviceSchema = schema !== "endpoint";
      const cronSchema = schema === "cron";
      try {
        const result = await sql.run(
          serviceSchema
            ? `UPDATE tf_v2_worker_invocations
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
             ${cronSchema ? "AND cron_match_id IS ? AND cron_trigger_operation_id IS ? AND cron_lease_token IS ? AND cron_attempt IS ?" : ""}
             AND version_uid = ? AND version_generation = ? AND version_operation_id = ?
             AND native_identity = ? AND closure_digest = ? AND confirmed_receipt = ?
             AND phase = 'send_authorized' AND retired_at_ms IS NULL
             AND retirement_receipt_digest IS NULL AND no_native_dispatch_at_ms IS NULL
             AND (${v2WorkerInvocationSchemaReady(schema)})`
            : `UPDATE tf_v2_worker_invocations
           SET retired_at_ms = max(?, send_authorized_at_ms),
               retirement_receipt_digest = ?
           WHERE invocation_id = ? AND custody_token = ?
             AND backend_id = ? AND target_key = ? AND principal = ? AND space = ?
             AND worker_uid = ? AND deployment_uid = ? AND deployment_generation = ?
             AND source_operation_id = ? AND endpoint_uid = ? AND endpoint_generation = ?
             AND version_uid = ? AND version_generation = ? AND version_operation_id = ?
             AND native_identity = ? AND closure_digest = ? AND confirmed_receipt = ?
             AND phase = 'send_authorized' AND retired_at_ms IS NULL
             AND retirement_receipt_digest IS NULL AND no_native_dispatch_at_ms IS NULL
             AND (${v2WorkerInvocationSchemaReady("endpoint")})`,
          serviceSchema
            ? [
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
                expected.ingress.kind === "service"
                  ? expected.ingress.callerVersionGeneration
                  : null,
                expected.ingress.kind === "service"
                  ? expected.ingress.callerVersionOperationId
                  : null,
                expected.ingress.kind === "service" ? expected.ingress.bindingName : null,
                expected.ingress.kind === "service" ? expected.ingress.callerExecutionRef : null,
                ...(cronSchema
                  ? [
                      expected.ingress.kind === "cron" ? expected.ingress.matchId : null,
                      expected.ingress.kind === "cron" ? expected.ingress.triggerOperationId : null,
                      expected.ingress.kind === "cron" ? expected.ingress.leaseToken : null,
                      expected.ingress.kind === "cron" ? expected.ingress.attempt : null,
                    ]
                  : []),
                expected.versionUid,
                expected.versionGeneration,
                expected.versionOperationId,
                expected.nativeIdentity,
                expected.closureDigest,
                expected.confirmedReceipt,
              ]
            : [
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
                expected.ingress.kind === "endpoint" ? expected.ingress.endpointUid : null,
                expected.ingress.kind === "endpoint" ? expected.ingress.endpointGeneration : null,
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
        `SELECT * FROM (SELECT count(*) AS outstanding,
           coalesce(sum(CASE WHEN body_state = 'finished' THEN 1 ELSE 0 END), 0) AS body_finished
         FROM tf_v2_worker_invocations
         WHERE deployment_uid = ? AND phase <> 'pre_effect_refused'
           AND retired_at_ms IS NULL AND no_native_dispatch_at_ms IS NULL)
         WHERE (${anyReady})`,
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
