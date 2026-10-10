import { canonicalJson } from "../json.ts";
import type { Clock, JsonObject, Sql } from "../ports.ts";
import { SqlError } from "../ports.ts";
import type {
  SqlArtifactCustodyRead,
  SqlArtifactCustodyUnverified,
} from "./forms/artifact-custody.ts";
import {
  parseStaticAssetBundleSpec,
  STATIC_ASSET_BUNDLE_FORM_URL,
  type StaticAssetBundleManifest,
} from "./forms/static-asset-bundle.ts";
import type { StaticAssetBundleCustody } from "./forms/static-asset-bundle-backend.ts";
import {
  parseWorkerBundleSpec,
  WORKER_BUNDLE_FORM_URL,
  type WorkerBundleManifest,
} from "./forms/worker-bundle.ts";
import type { WorkerBundleCustody } from "./forms/worker-bundle-backend.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerVersion,
} from "./forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
  type WorkerDeploymentSpec,
  type WorkerEndpointSpec,
  type WorkerVersionSpec,
} from "./forms/worker-specs.ts";
import type { OperationRow, ResourceRow } from "./store.ts";
import type { V2Execution } from "./types.ts";
import {
  createWorkerPublicationSqlGuard,
  type V2WorkerPublicationSqlGuard,
} from "./worker-publication-sql-guard.ts";

export type { V2WorkerPublicationSqlGuard } from "./worker-publication-sql-guard.ts";

/** A read-only SQL authority for one fenced private Worker publication. */
export interface V2WorkerPublicationSnapshot {
  readonly sourceOperationId: string;
  /** Host-assigned, SQL-held address of this accepted Endpoint op, including DELETE. */
  readonly acceptedEndpointOutput?: { readonly hostname: string; readonly url: string };
  readonly worker: {
    readonly uid: string;
    readonly principal: string;
    readonly space: string;
    readonly generation: number;
  };
  readonly deployment: {
    readonly uid: string;
    readonly generation: number;
    readonly spec: WorkerDeploymentSpec;
    readonly versions: readonly {
      readonly uid: string;
      /** Exact settled WorkerVersion Operation used as the selected spec source. */
      readonly sourceOperationId: string;
      readonly generation: number;
      readonly weight: number;
      readonly spec: WorkerVersionSpec;
    }[];
  } | null;
  readonly endpoint: {
    readonly uid: string;
    readonly generation: number;
    readonly spec: WorkerEndpointSpec;
    readonly output: { readonly hostname: string; readonly url: string };
  } | null;
}

export type V2WorkerPublicationResolution =
  | {
      readonly kind: "ready";
      readonly snapshot: V2WorkerPublicationSnapshot;
      /** Embed this captured predicate in the same SQL statement as route CAS. */
      readonly sqlGuard: V2WorkerPublicationSqlGuard;
      /** Re-read the complete SQL vector after any await and before the native effect. */
      stillCurrent(): Promise<boolean>;
      /** Host-private, held-only bytes for one selected settled Version. */
      readVersionMaterials(versionUid: string): Promise<V2WorkerVersionMaterials>;
      /** Metadata and bounded pages only; file bytes still need full digest verification. */
      openVersionMaterialsUnverified?(versionUid: string): Promise<V2WorkerVersionMaterialScopes>;
    }
  | {
      readonly kind: "unresolved";
      readonly code:
        | "stale_claim"
        | "graph_unresolved"
        | "publication_conflict"
        | "incumbent_unresolved"
        | "source_unsettled";
      readonly message: string;
    };

/** A persisted runtime pointer supplied for comparison, never SQL authority. */
export interface V2WorkerCurrentServingIdentity {
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly hostnames: readonly string[];
  readonly versions: readonly { readonly workerVersionUid: string; readonly weight: number }[];
}

export type V2WorkerCurrentServingResolution =
  | {
      readonly kind: "ready";
      readonly snapshot: V2WorkerPublicationSnapshot;
      stillCurrent(): Promise<boolean>;
      readVersionMaterials(versionUid: string): Promise<V2WorkerVersionMaterials>;
    }
  | Extract<V2WorkerPublicationResolution, { kind: "unresolved" }>;

/** A leased Version operation's accepted execution snapshot, not publication readiness. */
export interface V2WorkerVersionSnapshot {
  readonly sourceOperationId: string;
  readonly worker: {
    readonly uid: string;
    readonly principal: string;
    readonly space: string;
    readonly generation: number;
  };
  readonly version: {
    readonly uid: string;
    readonly generation: number;
    readonly spec: WorkerVersionSpec;
  };
}

export type V2WorkerVersionResolution =
  | {
      readonly kind: "ready";
      readonly snapshot: V2WorkerVersionSnapshot;
      /** Re-read the full accepted SQL vector after awaits. */
      stillCurrent(): Promise<boolean>;
      /** Verified, caller-owned held bytes; never consults the source URL. */
      readMaterials(): Promise<V2WorkerVersionMaterials>;
    }
  | {
      readonly kind: "unresolved";
      readonly code: "stale_claim" | "graph_unresolved";
      readonly message: string;
    };

/** Graph-captured only: unlike resolveVersion().ready, this has not rehashed files. */
export type V2WorkerVersionMaterialScopeResolution =
  | {
      readonly kind: "unverified";
      readonly snapshot: V2WorkerVersionSnapshot;
      graphStillCurrent(): Promise<boolean>;
      openMaterialsUnverified(): Promise<V2WorkerVersionMaterialScopes>;
    }
  | Extract<V2WorkerVersionResolution, { kind: "unresolved" }>;

type Unresolved = Extract<V2WorkerPublicationResolution, { kind: "unresolved" }>;
type ReadyCapture = {
  readonly kind: "ready";
  readonly snapshot: V2WorkerPublicationSnapshot;
  readonly vector: string;
  readonly sqlGuard: V2WorkerPublicationSqlGuard;
  readonly materials: ReadonlyMap<string, VersionMaterialTargets>;
};
type Capture = ReadyCapture | Unresolved;
type CurrentReadyCapture = Omit<ReadyCapture, "sqlGuard"> & {
  readonly fence: {
    readonly sourceOwnerUid: string;
    readonly referenceSetIds: readonly string[];
    readonly inboundTargetIds: readonly string[];
  };
};
type CurrentCapture = CurrentReadyCapture | Unresolved;
type VersionReadyCapture = {
  readonly kind: "ready";
  readonly snapshot: V2WorkerVersionSnapshot;
  readonly vector: string;
  readonly materials: VersionMaterialTargets;
};
type VersionCapture =
  | VersionReadyCapture
  | Extract<V2WorkerVersionResolution, { kind: "unresolved" }>;

interface ArtifactTarget {
  readonly uid: string;
  readonly spec: JsonObject;
  readonly observed: JsonObject;
}
interface VersionMaterialTargets {
  readonly bundle: ArtifactTarget | null;
  readonly assets: ArtifactTarget | null;
}
export interface V2WorkerVersionMaterials {
  readonly bundle: SqlArtifactCustodyRead<WorkerBundleManifest> | null;
  readonly assets: SqlArtifactCustodyRead<StaticAssetBundleManifest> | null;
}

export interface V2WorkerVersionMaterialScopes {
  readonly bundle: SqlArtifactCustodyUnverified<WorkerBundleManifest> | null;
  readonly assets: SqlArtifactCustodyUnverified<StaticAssetBundleManifest> | null;
}

type ReferenceRow = {
  target_uid: string;
  form_url: string;
  readiness: "observed" | "ready";
  target_spec_path: string | null;
  target_spec_equals: string | null;
};

const pendingStatuses = new Set(["queued", "running", "waiting_input", "reconciling"]);
const uidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

function unresolved(code: Unresolved["code"], message: string): Unresolved {
  return { kind: "unresolved", code, message };
}

function versionUnresolved(
  code: Extract<V2WorkerVersionResolution, { kind: "unresolved" }>["code"],
  message: string,
): Extract<V2WorkerVersionResolution, { kind: "unresolved" }> {
  return { kind: "unresolved", code, message };
}

function parseObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function workerUidFromOperation(op: OperationRow): string | null {
  const spec = parseObject(op.accepted_spec_json);
  const worker = spec?.worker;
  if (worker === null || typeof worker !== "object" || Array.isArray(worker)) return null;
  const uid = (worker as { resourceUid?: unknown }).resourceUid;
  return typeof uid === "string" && uidPattern.test(uid) ? uid : null;
}

function isCurrentClaim(
  op: OperationRow,
  resource: ResourceRow,
  execution: V2Execution,
  now: number,
) {
  let executionSpec: string;
  try {
    executionSpec = canonicalJson(execution.spec);
  } catch {
    return false;
  }
  return (
    op.id === execution.operationId &&
    op.resource_uid === execution.resourceUid &&
    op.principal === execution.principal &&
    op.backend_key === execution.backendKey &&
    op.backend_id === execution.backendId &&
    op.target_key === execution.targetKey &&
    op.action === execution.action &&
    op.generation === execution.generation &&
    op.accepted_spec_json === executionSpec &&
    op.status === "reconciling" &&
    op.dispatch_possible === 1 &&
    op.lease_token === execution.leaseToken &&
    op.lease_until_ms !== null &&
    op.lease_until_ms > now &&
    resource.uid === op.resource_uid &&
    resource.principal === execution.principal &&
    resource.form_url === execution.form &&
    resource.space === execution.space &&
    resource.name === execution.name &&
    resource.backend_id === op.backend_id &&
    resource.target_key === op.target_key &&
    resource.generation === op.generation &&
    resource.last_operation === op.id &&
    resource.busy_operation === op.id &&
    resource.deleted_at === null &&
    resource.spec_json === op.accepted_spec_json
  );
}

function settled(row: ResourceRow, op: OperationRow | null): boolean {
  return (
    row.deleted_at === null &&
    row.busy_operation === null &&
    row.phase === "idle" &&
    row.observed_generation === row.generation &&
    op?.id === row.last_operation &&
    op.resource_uid === row.uid &&
    op.principal === row.principal &&
    op.backend_id === row.backend_id &&
    op.target_key === row.target_key &&
    op.generation === row.generation &&
    op.status === "succeeded" &&
    op.effect === "complete" &&
    op.accepted_spec_json === row.spec_json
  );
}

const unstartedStatuses = new Set(["queued", "running", "waiting_input"]);

/**
 * An accepted Operation that cannot have reached a backend. The schema gives
 * these statuses effect `none`, and `dispatch_possible` is recorded before any
 * native call; every Worker publication effect starts from a dispatched
 * `reconciling` claim (see isCurrentClaim). Such an Operation cannot have
 * changed what is natively serving, so boot recovery may adopt the previously
 * committed incarnation while it waits.
 */
function unstartedOperation(op: OperationRow, neverServed?: NeverServedOperation): boolean {
  if (unstartedStatuses.has(op.status) && op.effect === "none" && op.dispatch_possible === 0)
    return true;
  return dispatchedNeverServed(op.id, op.status, op.effect, op.dispatch_possible, neverServed);
}

/**
 * Owner-side proof that an Operation never reached native serving. A dispatched
 * Operation (`reconciling`, dispatch recorded) may have been sent to the owner,
 * so it is tolerated only when the owner vouches from its own durable state that
 * no incarnation of that Operation ever served (no record at all, or a candidate
 * it proved dead and retired without activation).
 */
export type NeverServedOperation = (operationId: string) => boolean;

function dispatchedNeverServed(
  id: unknown,
  status: unknown,
  effect: unknown,
  dispatchPossible: unknown,
  neverServed: NeverServedOperation | undefined,
): boolean {
  return (
    neverServed !== undefined &&
    typeof id === "string" &&
    status === "reconciling" &&
    effect === "unknown" &&
    dispatchPossible === 1 &&
    neverServed(id) === true
  );
}

/** A queued update/delete accepted over a committed generation of `row`. */
function unstartedSuccessor(
  op: OperationRow | null,
  row: ResourceRow,
  neverServed?: NeverServedOperation,
): op is OperationRow {
  return (
    op !== null &&
    unstartedOperation(op, neverServed) &&
    op.id === row.last_operation &&
    op.id === row.busy_operation &&
    op.resource_uid === row.uid &&
    op.principal === row.principal &&
    op.backend_id === row.backend_id &&
    op.target_key === row.target_key &&
    op.generation === row.generation &&
    row.generation === row.observed_generation + 1 &&
    row.observed_generation > 0 &&
    op.accepted_spec_json === row.spec_json &&
    row.deleted_at === null &&
    ((op.action === "update" && row.phase === "pending") ||
      (op.action === "delete" && row.phase === "deleting"))
  );
}

/** A queued first publication: nothing was ever committed for this Resource. */
function unstartedCreate(
  op: OperationRow | null,
  row: ResourceRow,
  neverServed?: NeverServedOperation,
): op is OperationRow {
  return (
    op !== null &&
    unstartedOperation(op, neverServed) &&
    op.action === "create" &&
    op.id === row.last_operation &&
    op.id === row.busy_operation &&
    op.resource_uid === row.uid &&
    op.principal === row.principal &&
    op.backend_id === row.backend_id &&
    op.target_key === row.target_key &&
    op.generation === 1 &&
    row.generation === 1 &&
    row.observed_generation === 0 &&
    row.phase === "pending" &&
    op.accepted_spec_json === row.spec_json &&
    row.deleted_at === null
  );
}

/** Fence-side recheck of the same predicate from the reported pending rows. */
function unstartedPendingRows(
  rows: readonly unknown[],
  sourceOperationId: string,
  neverServed?: NeverServedOperation,
): boolean {
  return (
    rows.length <= MAX_UNSTARTED_SUCCESSORS &&
    rows.every(
      (row) =>
        Array.isArray(row) &&
        typeof row[0] === "string" &&
        row[0] !== sourceOperationId &&
        typeof row[4] === "string" &&
        ((unstartedStatuses.has(row[4]) && row[5] === "none" && row[6] === 0) ||
          dispatchedNeverServed(row[0], row[4], row[5], row[6], neverServed)),
    )
  );
}

function outputHostname(row: ResourceRow): { hostname: string; url: string } | null {
  const output = parseObject(row.output_json);
  const hostname = output?.hostname;
  const url = output?.url;
  return output !== null &&
    typeof hostname === "string" &&
    Object.keys(output).sort().join(",") === "hostname,url" &&
    hostnamePattern.test(hostname) &&
    typeof url === "string" &&
    url === `https://${hostname}/`
    ? { hostname, url }
    : null;
}

function confirmedServingSource(op: OperationRow, row: ResourceRow, targetKey: string): boolean {
  return (
    (row.form_url === WORKER_DEPLOYMENT_FORM_URL || row.form_url === WORKER_ENDPOINT_FORM_URL) &&
    op.resource_uid === row.uid &&
    op.principal === row.principal &&
    op.backend_id === row.backend_id &&
    op.target_key === row.target_key &&
    op.target_key === targetKey &&
    op.generation === row.generation &&
    row.observed_generation === op.generation &&
    row.last_operation === op.id &&
    row.busy_operation === null &&
    row.phase === "idle" &&
    row.spec_json === op.accepted_spec_json &&
    op.status === "succeeded" &&
    op.effect === "complete" &&
    ((op.action === "delete" &&
      row.form_url === WORKER_ENDPOINT_FORM_URL &&
      row.deleted_at !== null) ||
      ((op.action === "create" || op.action === "update") && row.deleted_at === null))
  );
}

function exactServingIdentity(
  snapshot: V2WorkerPublicationSnapshot,
  expected: V2WorkerCurrentServingIdentity,
): boolean {
  const deployment = snapshot.deployment;
  if (
    !deployment ||
    expected.workerResourceUid !== snapshot.worker.uid ||
    expected.generation !== `takoserver-v2-operation:${snapshot.sourceOperationId}` ||
    !Array.isArray(expected.hostnames) ||
    !Array.isArray(expected.versions)
  )
    return false;
  const hostnames = snapshot.endpoint ? [snapshot.endpoint.output.hostname] : [];
  if (
    expected.hostnames.length !== hostnames.length ||
    expected.hostnames.some((hostname, index) => hostname !== hostnames[index]) ||
    expected.versions.length !== deployment.versions.length
  )
    return false;
  const versions = expected.versions.map((version) => ({
    uid: version.workerVersionUid,
    weight: version.weight,
  }));
  if (
    versions.some(
      (version) =>
        !uidPattern.test(version.uid) || !Number.isInteger(version.weight) || version.weight <= 0,
    ) ||
    new Set(versions.map((version) => version.uid)).size !== versions.length
  )
    return false;
  const selected = deployment.versions.map((version) => ({
    uid: version.uid,
    weight: version.weight,
  }));
  versions.sort((left, right) => left.uid.localeCompare(right.uid));
  selected.sort((left, right) => left.uid.localeCompare(right.uid));
  return (
    canonicalJson(versions as unknown as JsonObject) ===
    canonicalJson(selected as unknown as JsonObject)
  );
}

// The current-serving caller can cross several native awaits in one Worker
// invocation. Re-running capture() at every custody fence multiplies the full
// graph walk by every held-file page. This projection is deliberately broader
// than the successful capture: it includes the selected rows and the negative
// sets whose *new* members would make a new capture fail. Each fence uses one
// fresh row-per-fact query, never a cross-request or cross-await cache. The
// inner compounds stay below D1's term limit and avoid one giant JSON row.
const resourceColumns = [
  "uid",
  "principal",
  "form_url",
  "space",
  "name",
  "backend_id",
  "target_key",
  "active_name",
  "generation",
  "observed_generation",
  "observed_at",
  "phase",
  "last_operation",
  "busy_operation",
  "deleted_at",
] as const;
const operationColumns = [
  "id",
  "resource_uid",
  "principal",
  "replay_key",
  "action",
  "generation",
  "status",
  "effect",
  "created_at",
  "updated_at",
  "retain_until",
  "backend_id",
  "target_key",
  "backend_key",
  "dispatch_possible",
  "next_attempt_at_ms",
  "lease_token",
  "lease_until_ms",
  "error_code",
  "private_inputs_present",
  "input_required_names_json",
  "input_required_reason",
  "acceptance_order",
] as const;
function rowJson(alias: string, columns: readonly string[]): string {
  // D1 permits at most 32 arguments to one SQL function. Large JSON/text
  // fields are emitted separately as raw scalar rows, not re-escaped here.
  return `json_array(${columns.map((column) => `${alias}.${column}`).join(", ")})`;
}

const currentServingFenceGraphSql = `
WITH selected(uid) AS (SELECT value FROM json_each(?)),
     set_ids(id) AS (SELECT value FROM json_each(?)),
     resource_fields(field) AS (VALUES ('meta'), ('spec_json'), ('observed_json'), ('output_json')),
     operation_fields(field) AS (VALUES ('meta'), ('request_fingerprint'), ('accepted_spec_json'),
                               ('result_observed_json'), ('result_output_json'), ('error_message')),
     relevant_resources AS (
       SELECT r.* FROM tf_v2_resources r
       WHERE r.uid IN (SELECT uid FROM selected)
          OR r.uid IN (SELECT target_uid FROM tf_v2_operation_references
                       WHERE operation_id IN (SELECT id FROM set_ids))
          OR (r.form_url IN (?, ?) AND r.principal = ? AND r.space = ?
              AND r.deleted_at IS NULL
              AND json_extract(r.spec_json, '$.worker.resourceUid') = ?)
     )
SELECT 'resource:' || f.field AS kind, r.uid AS key,
  CASE f.field
    WHEN 'meta' THEN ${rowJson("r", resourceColumns)}
    WHEN 'spec_json' THEN r.spec_json
    WHEN 'observed_json' THEN r.observed_json
    ELSE r.output_json END AS body
  FROM relevant_resources r CROSS JOIN resource_fields f
UNION ALL
SELECT 'operation:' || f.field, op.id,
  CASE f.field
    WHEN 'meta' THEN ${rowJson("op", operationColumns)}
    WHEN 'request_fingerprint' THEN op.request_fingerprint
    WHEN 'accepted_spec_json' THEN op.accepted_spec_json
    WHEN 'result_observed_json' THEN op.result_observed_json
    WHEN 'result_output_json' THEN op.result_output_json
    ELSE op.error_message END
  FROM tf_v2_operations op CROSS JOIN operation_fields f
  WHERE op.id = ? OR op.id IN (SELECT last_operation FROM relevant_resources)
     OR op.id IN (SELECT busy_operation FROM relevant_resources)
     OR op.id IN (SELECT id FROM set_ids)
     OR EXISTS (SELECT 1 FROM relevant_resources r
                WHERE r.uid = op.resource_uid AND r.form_url IN (?, ?)
                  AND r.observed_generation < op.generation
                  AND op.generation < r.generation AND op.effect IN ('partial', 'unknown'))
UNION ALL
SELECT 'reference_set', s.operation_id,
  json_object('operation_id', s.operation_id, 'sealed', s.sealed)
  FROM tf_v2_operation_reference_sets s WHERE s.operation_id IN (SELECT id FROM set_ids)
UNION ALL
SELECT 'reference', ref.operation_id || ':' || ref.target_uid,
  json_object('operation_id', ref.operation_id,
  'target_uid', ref.target_uid, 'form_url', ref.form_url, 'readiness', ref.readiness,
  'target_spec_path', ref.target_spec_path, 'target_spec_equals', ref.target_spec_equals)
  FROM tf_v2_operation_references ref WHERE ref.operation_id IN (SELECT id FROM set_ids)
ORDER BY kind, key`;

/**
 * `tolerateUnstartedSuccessors` is only for boot recovery of an already active
 * incarnation. The strict form requires that no Deployment/Endpoint Operation
 * for the Worker is pending. The tolerant form instead reports each pending
 * Operation (the caller accepts only ones that cannot have reached a backend)
 * and derives publishers from the committed generation of a busy Resource.
 */
function currentServingFenceRelationsSql(tolerateUnstartedSuccessors: boolean): string {
  const pending = tolerateUnstartedSuccessors
    ? `SELECT 'pending', pending.id, json_array(pending.id, pending.resource_uid,
    pending.action, pending.generation, pending.status, pending.effect,
    pending.dispatch_possible, pending.lease_token, pending.lease_until_ms,
    pending.acceptance_order)
  FROM (SELECT op.id, op.resource_uid, op.action, op.generation, op.status, op.effect,
      op.dispatch_possible, op.lease_token, op.lease_until_ms, op.acceptance_order
    FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
    WHERE r.form_url IN (?, ?) AND r.deleted_at IS NULL
      AND op.status IN ('queued', 'running', 'waiting_input', 'reconciling')
      AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?
    ORDER BY op.id LIMIT ${MAX_UNSTARTED_SUCCESSORS + 1}) pending`
    : `SELECT 'pending', '', json_object('present', EXISTS (
  SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
    WHERE r.form_url IN (?, ?) AND r.deleted_at IS NULL
      AND op.status IN ('queued', 'running', 'waiting_input', 'reconciling')
      AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ? LIMIT 1))`;
  const publisher = tolerateUnstartedSuccessors
    ? `SELECT 'publisher', publisher.id, json_object('id', publisher.id,
  'acceptance_order', publisher.acceptance_order)
  FROM (SELECT op.id, op.acceptance_order FROM tf_v2_resources r
    JOIN tf_v2_operations op ON op.resource_uid = r.uid AND op.generation = r.observed_generation
    WHERE r.form_url IN (?, ?) AND r.principal = ? AND r.space = ?
      AND op.principal = r.principal AND op.backend_id = r.backend_id
      AND op.target_key = r.target_key AND op.status = 'succeeded'
      AND op.effect = 'complete' AND r.observed_generation > 0
      AND ((r.busy_operation IS NULL AND op.id = r.last_operation)
        OR (r.busy_operation IS NOT NULL AND op.id <> r.busy_operation))
      AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?
    ORDER BY op.acceptance_order DESC, op.id DESC LIMIT 2) publisher`
    : `SELECT 'publisher', publisher.id, json_object('id', publisher.id,
  'acceptance_order', publisher.acceptance_order)
  FROM (SELECT op.id, op.acceptance_order FROM tf_v2_resources r
    JOIN tf_v2_operations op ON op.id = r.last_operation
    WHERE r.form_url IN (?, ?) AND r.principal = ? AND r.space = ?
      AND op.principal = r.principal AND op.backend_id = r.backend_id
      AND op.target_key = r.target_key AND op.status = 'succeeded'
      AND op.effect = 'complete' AND r.observed_generation = op.generation
      AND r.busy_operation IS NULL
      AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?
    ORDER BY op.acceptance_order DESC, op.id DESC LIMIT 2) publisher`;
  return `
WITH selected(uid) AS (SELECT value FROM json_each(?)),
     inbound(uid) AS (SELECT value FROM json_each(?)),
     artifacts(uid) AS (SELECT value FROM json_each(?)),
     owner_fields(field) AS (VALUES ('meta'), ('observation_json'))
SELECT 'edge' AS kind, e.target_uid || ':' || e.referrer_uid AS key,
  json_object('target_uid', e.target_uid, 'referrer_uid', e.referrer_uid) AS body
  FROM tf_v2_resource_references e
  WHERE e.target_uid IN (SELECT uid FROM inbound)
     OR e.referrer_uid IN (SELECT uid FROM selected)
UNION ALL
SELECT 'owner:' || f.field, a.resource_uid,
  CASE f.field WHEN 'meta' THEN
    json_object('resource_uid', a.resource_uid, 'form_url', a.form_url,
      'manifest_sha256', a.manifest_sha256, 'state', a.state,
      'verified_operation_id', a.verified_operation_id)
    ELSE a.observation_json END
  FROM tf_v2_artifact_owners a CROSS JOIN owner_fields f
  WHERE a.resource_uid IN (SELECT uid FROM artifacts)
UNION ALL
${pending}
UNION ALL
${publisher}
ORDER BY kind, key`;
}

const MAX_UNSTARTED_SUCCESSORS = 4;
const currentServingFenceSql = `
SELECT kind, key, body FROM (${currentServingFenceGraphSql})
UNION ALL
SELECT kind, key, body FROM (${currentServingFenceRelationsSql(false)})
ORDER BY kind, key`;
const tolerantCurrentServingFenceSql = `
SELECT kind, key, body FROM (${currentServingFenceGraphSql})
UNION ALL
SELECT kind, key, body FROM (${currentServingFenceRelationsSql(true)})
ORDER BY kind, key`;

/** No separate desired-state ledger: every read starts from the accepted v2 Operation. */
export function createV2WorkerPublicationState(options: {
  sql: Sql;
  now?: Clock;
  bundleCustody?: Pick<WorkerBundleCustody, "readHeldVerified"> &
    Partial<Pick<WorkerBundleCustody, "openHeldUnverified">>;
  assetCustody?: Pick<StaticAssetBundleCustody, "readHeldVerified"> &
    Partial<Pick<StaticAssetBundleCustody, "openHeldUnverified">>;
}) {
  const { sql } = options;
  const now = options.now ?? (() => new Date());

  async function resource(uid: string): Promise<ResourceRow | null> {
    return ((await sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [uid]))[0] ??
      null) as ResourceRow | null;
  }
  async function operation(id: string): Promise<OperationRow | null> {
    return ((await sql.query("SELECT * FROM tf_v2_operations WHERE id = ?", [id]))[0] ??
      null) as OperationRow | null;
  }
  async function currentServingFence(
    captured: CurrentServingCaptureInput,
    initial: CurrentReadyCapture,
  ): Promise<string> {
    const snapshot = initial.snapshot;
    const versions = snapshot.deployment?.versions ?? [];
    const artifactIds = [...initial.materials.values()].flatMap((targets) =>
      [targets.bundle?.uid, targets.assets?.uid].filter((uid): uid is string => uid !== undefined),
    );
    const selected = [
      initial.fence.sourceOwnerUid,
      snapshot.worker.uid,
      ...(snapshot.deployment ? [snapshot.deployment.uid] : []),
      ...(snapshot.endpoint ? [snapshot.endpoint.uid] : []),
      ...versions.map((version) => version.uid),
      ...artifactIds,
    ];
    const current = captured.currentServing;
    const rows = await sql.query(
      current.tolerateUnstartedSuccessors ? tolerantCurrentServingFenceSql : currentServingFenceSql,
      [
        JSON.stringify(selected),
        JSON.stringify(initial.fence.referenceSetIds),
        WORKER_DEPLOYMENT_FORM_URL,
        WORKER_ENDPOINT_FORM_URL,
        snapshot.worker.principal,
        snapshot.worker.space,
        current.workerUid,
        current.sourceOperationId,
        WORKER_DEPLOYMENT_FORM_URL,
        WORKER_ENDPOINT_FORM_URL,
        JSON.stringify(selected),
        JSON.stringify(initial.fence.inboundTargetIds),
        JSON.stringify(artifactIds),
        WORKER_DEPLOYMENT_FORM_URL,
        WORKER_ENDPOINT_FORM_URL,
        current.workerUid,
        WORKER_DEPLOYMENT_FORM_URL,
        WORKER_ENDPOINT_FORM_URL,
        snapshot.worker.principal,
        snapshot.worker.space,
        current.workerUid,
      ],
    );
    const graph = rows.filter(
      (row) =>
        (typeof row.kind === "string" && row.kind.startsWith("resource:")) ||
        (typeof row.kind === "string" && row.kind.startsWith("operation:")) ||
        row.kind === "reference_set" ||
        row.kind === "reference",
    );
    const relations = rows.filter(
      (row) =>
        row.kind === "edge" ||
        (typeof row.kind === "string" && row.kind.startsWith("owner:")) ||
        row.kind === "pending" ||
        row.kind === "publisher",
    );
    const values = (rows: readonly Record<string, unknown>[], kind: string): unknown[] =>
      rows
        .filter((row) => row.kind === kind)
        .map((row) => {
          if (typeof row.body !== "string")
            throw new SqlError("unavailable", "Serving fence is malformed");
          return JSON.parse(row.body) as unknown;
        });
    const hasFirst = (rows: readonly unknown[], ids: readonly string[]): boolean => {
      const found = new Set(rows.map((row) => (Array.isArray(row) ? row[0] : null)));
      return ids.every((id) => found.has(id));
    };
    const hasCompleteRows = (
      source: readonly Record<string, unknown>[],
      noun: string,
      rawFields: readonly string[],
    ): boolean => {
      const cells = new Map<string, unknown>();
      for (const row of source) {
        if (
          typeof row.kind !== "string" ||
          typeof row.key !== "string" ||
          !Object.hasOwn(row, "body")
        )
          return false;
        const identity = `${row.kind}\0${row.key}`;
        if (cells.has(identity)) return false;
        cells.set(identity, row.body);
      }
      const ids = source.filter((row) => row.kind === `${noun}:meta`).map((row) => row.key);
      return ids.every(
        (id) =>
          typeof id === "string" &&
          rawFields.every((field) => {
            const identity = `${noun}:${field}\0${id}`;
            const body = cells.get(identity);
            return cells.has(identity) && (typeof body === "string" || body === null);
          }),
      );
    };
    const referenceSets = values(graph, "reference_set");
    const owners = values(relations, "owner:meta");
    const pending = values(relations, "pending");
    const publishers = values(relations, "publisher");
    if (
      rows.length !== graph.length + relations.length ||
      !hasFirst(values(graph, "resource:meta"), selected) ||
      !hasFirst(values(graph, "operation:meta"), [
        current.sourceOperationId,
        ...initial.fence.referenceSetIds,
      ]) ||
      !hasCompleteRows(graph, "resource", ["spec_json", "observed_json", "output_json"]) ||
      !hasCompleteRows(graph, "operation", [
        "request_fingerprint",
        "accepted_spec_json",
        "result_observed_json",
        "result_output_json",
        "error_message",
      ]) ||
      !hasCompleteRows(relations, "owner", ["observation_json"]) ||
      !initial.fence.referenceSetIds.every((id) =>
        referenceSets.some(
          (row) =>
            row !== null &&
            typeof row === "object" &&
            !Array.isArray(row) &&
            (row as { operation_id?: unknown }).operation_id === id,
        ),
      ) ||
      !artifactIds.every((id) =>
        owners.some(
          (row) =>
            row !== null &&
            typeof row === "object" &&
            !Array.isArray(row) &&
            (row as { resource_uid?: unknown }).resource_uid === id,
        ),
      ) ||
      !(current.tolerateUnstartedSuccessors
        ? unstartedPendingRows(pending, current.sourceOperationId, current.neverServedOperation)
        : pending.length === 1 &&
          pending[0] !== null &&
          typeof pending[0] === "object" &&
          (pending[0] as { present?: unknown }).present === 0) ||
      !publishers.some(
        (row) =>
          row !== null &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          (row as { id?: unknown }).id === current.sourceOperationId,
      )
    )
      throw new SqlError("unavailable", "Serving fence evidence is incomplete");
    return canonicalJson({ graph, relations } as unknown as JsonObject);
  }
  async function hasUnresolvedPriorEffect(row: ResourceRow): Promise<boolean> {
    if (row.observed_generation >= row.generation) return false;
    return (
      (
        await sql.query(
          `SELECT 1 FROM tf_v2_operations WHERE resource_uid = ?
       AND generation > ? AND generation < ? AND effect IN ('partial', 'unknown')
       LIMIT 1`,
          [row.uid, row.observed_generation, row.generation],
        )
      ).length > 0
    );
  }
  async function references(id: string): Promise<ReferenceRow[] | null> {
    const set = await sql.query(
      "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
      [id],
    );
    if (set.length !== 1 || set[0]?.sealed !== 1) return null;
    return (await sql.query(
      `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
       FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
      [id],
    )) as ReferenceRow[];
  }
  async function exactVersionReferences(
    operationId: string,
    spec: WorkerVersionSpec,
  ): Promise<ReferenceRow[] | null> {
    const rows = await references(operationId);
    let expected: ReturnType<typeof referencesForWorkerVersion>;
    try {
      expected = referencesForWorkerVersion(spec);
    } catch {
      return null;
    }
    if (
      !rows ||
      rows.length !== expected.length ||
      expected.some((requirement, index) => {
        const actual = rows[index];
        const path = requirement.targetSpecMatch
          ? `$.${requirement.targetSpecMatch.path.join(".")}`
          : null;
        return (
          !actual ||
          actual.target_uid !== requirement.resourceUid ||
          actual.form_url !== requirement.formUrl ||
          actual.readiness !== requirement.readiness ||
          actual.target_spec_path !== path ||
          actual.target_spec_equals !== (requirement.targetSpecMatch?.equals ?? null)
        );
      })
    )
      return null;
    return rows;
  }
  function hasReference(
    rows: readonly ReferenceRow[],
    uid: string,
    form: string,
    readiness: "observed" | "ready",
    workerUid?: string,
  ): boolean {
    return rows.some(
      (row) =>
        row.target_uid === uid &&
        row.form_url === form &&
        row.readiness === readiness &&
        (workerUid === undefined ||
          (row.target_spec_path === "$.worker.resourceUid" &&
            row.target_spec_equals === workerUid)),
    );
  }
  async function matchingResources(
    form: string,
    workerUid: string,
    principal: string,
    space: string,
    bounded = false,
  ): Promise<ResourceRow[]> {
    return (await sql.query(
      `SELECT * FROM tf_v2_resources
       WHERE form_url = ? AND principal = ? AND space = ? AND deleted_at IS NULL
         AND json_extract(spec_json, '$.worker.resourceUid') = ? ORDER BY uid
         ${bounded ? "LIMIT 2" : ""}`,
      [form, principal, space, workerUid],
    )) as unknown as ResourceRow[];
  }
  async function hasPendingPublication(workerUid: string): Promise<boolean> {
    return (
      (
        await sql.query(
          `SELECT 1 FROM tf_v2_operations op
         JOIN tf_v2_resources r ON r.uid = op.resource_uid
         WHERE r.form_url IN (?, ?) AND r.deleted_at IS NULL
           AND op.status IN ('queued', 'running', 'waiting_input', 'reconciling')
           AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ? LIMIT 1`,
          [WORKER_DEPLOYMENT_FORM_URL, WORKER_ENDPOINT_FORM_URL, workerUid],
        )
      ).length !== 0
    );
  }
  async function pendingPublication(workerUid: string): Promise<OperationRow[]> {
    return (await sql.query(
      `SELECT op.* FROM tf_v2_operations op
       JOIN tf_v2_resources r ON r.uid = op.resource_uid
       WHERE r.form_url IN (?, ?) AND r.deleted_at IS NULL
         AND op.status IN ('queued', 'running', 'waiting_input', 'reconciling')
         AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?
       ORDER BY op.created_at, op.id`,
      [WORKER_DEPLOYMENT_FORM_URL, WORKER_ENDPOINT_FORM_URL, workerUid],
    )) as unknown as OperationRow[];
  }

  async function activeReferences(
    referrerUid: string,
    expected: readonly ReferenceRow[],
    // Targets reserved by a queued successor. Acceptance inserts them as extra
    // active edges before the committed set is replaced at success.
    queuedTargets?: ReadonlySet<string>,
  ): Promise<readonly unknown[] | null> {
    const edges = await sql.query(
      `SELECT target_uid, referrer_uid FROM tf_v2_resource_references
       WHERE referrer_uid = ? ORDER BY target_uid`,
      [referrerUid],
    );
    if (queuedTargets === undefined) {
      if (
        edges.length !== expected.length ||
        expected.some((reference, index) => edges[index]?.target_uid !== reference.target_uid)
      )
        return null;
      return edges;
    }
    const wanted = new Set(expected.map((reference) => reference.target_uid));
    const present = new Set(edges.map((edge) => edge.target_uid));
    if (
      present.size !== edges.length ||
      [...wanted].some((uid) => !present.has(uid)) ||
      [...present].some((uid) => !wanted.has(String(uid)) && !queuedTargets.has(String(uid)))
    )
      return null;
    return edges;
  }

  async function settledReferenceTargets(
    rows: readonly ReferenceRow[],
    principal: string,
    space: string,
    serviceTargets: ReadonlySet<string>,
    targetKey: string,
  ): Promise<readonly unknown[] | null> {
    const evidence: unknown[] = [];
    for (const reference of rows) {
      const target = await resource(reference.target_uid);
      const last = target ? await operation(target.last_operation) : null;
      const observed = target ? parseObject(target.observed_json) : null;
      if (
        !target ||
        target.form_url !== reference.form_url ||
        target.principal !== principal ||
        target.space !== space ||
        (serviceTargets.has(reference.target_uid) && target.target_key !== targetKey) ||
        !settled(target, last) ||
        (reference.readiness === "ready" && observed?.ready !== true)
      )
        return null;
      if (serviceTargets.has(reference.target_uid)) {
        try {
          parseModuleWorkerSpec(parseObject(target.spec_json));
        } catch {
          return null;
        }
      }
      if (reference.target_spec_path !== null) {
        if (
          reference.target_spec_equals === null ||
          (
            await sql.query(
              `SELECT 1 FROM tf_v2_resources WHERE uid = ?
             AND json_type(spec_json, ?) = 'text'
             AND json_extract(spec_json, ?) = ? LIMIT 1`,
              [
                target.uid,
                reference.target_spec_path,
                reference.target_spec_path,
                reference.target_spec_equals,
              ],
            )
          ).length !== 1
        )
          return null;
      }
      evidence.push({ target, last });
    }
    return evidence;
  }

  async function currentPublisherRows(input: {
    workerUid: string;
    principal: string;
    space: string;
    tolerateUnstartedSuccessors: boolean;
  }): Promise<readonly { readonly id: unknown; readonly acceptance_order: unknown }[]> {
    return (await sql.query(
      input.tolerateUnstartedSuccessors
        ? `SELECT op.id, op.acceptance_order FROM tf_v2_resources r
       JOIN tf_v2_operations op ON op.resource_uid = r.uid AND op.generation = r.observed_generation
       WHERE r.form_url IN (?, ?) AND r.principal = ? AND r.space = ?
         AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.status = 'succeeded' AND op.effect = 'complete'
         AND r.observed_generation > 0
         AND ((r.busy_operation IS NULL AND op.id = r.last_operation)
           OR (r.busy_operation IS NOT NULL AND op.id <> r.busy_operation))
         AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?
       ORDER BY op.acceptance_order DESC, op.id DESC LIMIT 2`
        : `SELECT op.id, op.acceptance_order FROM tf_v2_resources r
       JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.form_url IN (?, ?) AND r.principal = ? AND r.space = ?
         AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.status = 'succeeded' AND op.effect = 'complete'
         AND r.observed_generation = op.generation AND r.busy_operation IS NULL
         AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?
       ORDER BY op.acceptance_order DESC, op.id DESC LIMIT 2`,
      [
        WORKER_DEPLOYMENT_FORM_URL,
        WORKER_ENDPOINT_FORM_URL,
        input.principal,
        input.space,
        input.workerUid,
      ],
    )) as readonly { readonly id: unknown; readonly acceptance_order: unknown }[];
  }

  async function artifactTarget(input: {
    versionUid: string;
    targetUid: string;
    formUrl: typeof WORKER_BUNDLE_FORM_URL | typeof STATIC_ASSET_BUNDLE_FORM_URL;
    principal: string;
    space: string;
  }): Promise<{ target: ArtifactTarget; evidence: unknown } | null> {
    const target = await resource(input.targetUid);
    const last = target ? await operation(target.last_operation) : null;
    const spec = target ? parseObject(target.spec_json) : null;
    const observed = target ? parseObject(target.observed_json) : null;
    if (
      !target ||
      !last ||
      !spec ||
      !observed ||
      target.form_url !== input.formUrl ||
      target.principal !== input.principal ||
      target.space !== input.space ||
      !settled(target, last)
    )
      return null;
    let expectedDigest: string;
    try {
      expectedDigest =
        input.formUrl === WORKER_BUNDLE_FORM_URL
          ? parseWorkerBundleSpec(spec).artifact.sha256
          : parseStaticAssetBundleSpec(spec).artifact.sha256;
    } catch {
      return null;
    }
    const edge = await sql.query(
      `SELECT target_uid, referrer_uid FROM tf_v2_resource_references
       WHERE target_uid = ? AND referrer_uid = ?`,
      [input.targetUid, input.versionUid],
    );
    const owner = (
      await sql.query(
        `SELECT resource_uid, form_url, manifest_sha256, state, observation_json,
              verified_operation_id FROM tf_v2_artifact_owners WHERE resource_uid = ?`,
        [input.targetUid],
      )
    )[0];
    if (
      edge.length !== 1 ||
      !owner ||
      owner.form_url !== input.formUrl ||
      owner.state !== "verified" ||
      owner.manifest_sha256 !== expectedDigest ||
      owner.observation_json !== target.observed_json
    )
      return null;
    return {
      target: { uid: input.targetUid, spec, observed },
      evidence: { target, last, edge, owner },
    };
  }

  async function captureVersion(execution: V2Execution): Promise<VersionCapture> {
    if (
      execution.form !== WORKER_VERSION_FORM_URL ||
      (execution.action !== "create" && execution.action !== "update")
    ) {
      return versionUnresolved(
        "graph_unresolved",
        "This operation is not a Worker Version materialization",
      );
    }
    const [op, own] = await Promise.all([
      operation(execution.operationId),
      resource(execution.resourceUid),
    ]);
    if (!op || !own || !isCurrentClaim(op, own, execution, now().getTime())) {
      return versionUnresolved("stale_claim", "The accepted Version lease is no longer current");
    }
    let spec: WorkerVersionSpec;
    try {
      spec = parseWorkerVersionSpec(parseObject(op.accepted_spec_json));
    } catch {
      return versionUnresolved("graph_unresolved", "Accepted Worker Version spec is invalid");
    }
    const worker = await resource(spec.worker.resourceUid);
    const workerOp = worker ? await operation(worker.last_operation) : null;
    if (
      !worker ||
      worker.form_url !== MODULE_WORKER_FORM_URL ||
      worker.principal !== op.principal ||
      worker.space !== own.space ||
      !settled(worker, workerOp)
    ) {
      return versionUnresolved(
        "graph_unresolved",
        "Worker identity is not settled in this owner and Space",
      );
    }
    try {
      parseModuleWorkerSpec(parseObject(worker.spec_json));
    } catch {
      return versionUnresolved("graph_unresolved", "Worker identity spec is invalid");
    }
    const refRows = await exactVersionReferences(op.id, spec);
    if (!refRows) {
      return versionUnresolved(
        "graph_unresolved",
        "Version accepted references are not sealed and exact",
      );
    }
    const referenceEvidence: unknown[] = [];
    const serviceTargets = new Set(spec.serviceBindings.map((item) => item.resource.resourceUid));
    for (const ref of refRows) {
      const target = await resource(ref.target_uid);
      const last = target ? await operation(target.last_operation) : null;
      const edge = (
        await sql.query(
          `SELECT target_uid, referrer_uid FROM tf_v2_resource_references
         WHERE target_uid = ? AND referrer_uid = ?`,
          [ref.target_uid, own.uid],
        )
      )[0];
      if (
        !target ||
        target.form_url !== ref.form_url ||
        target.principal !== own.principal ||
        target.space !== own.space ||
        (serviceTargets.has(ref.target_uid) && target.target_key !== op.target_key) ||
        !settled(target, last) ||
        !edge
      ) {
        return versionUnresolved(
          "graph_unresolved",
          "A Version reference is not current in this owner and Space",
        );
      }
      if (serviceTargets.has(ref.target_uid)) {
        try {
          parseModuleWorkerSpec(parseObject(target.spec_json));
        } catch {
          return versionUnresolved("graph_unresolved", "A service Worker identity spec is invalid");
        }
      }
      referenceEvidence.push({ target, last, edge });
    }
    const bundle = spec.bundle
      ? await artifactTarget({
          versionUid: own.uid,
          targetUid: spec.bundle.resourceUid,
          formUrl: WORKER_BUNDLE_FORM_URL,
          principal: own.principal,
          space: own.space,
        })
      : null;
    const assets = spec.assets
      ? await artifactTarget({
          versionUid: own.uid,
          targetUid: spec.assets.bundle.resourceUid,
          formUrl: STATIC_ASSET_BUNDLE_FORM_URL,
          principal: own.principal,
          space: own.space,
        })
      : null;
    if ((spec.bundle && !bundle) || (spec.assets && !assets)) {
      return versionUnresolved("graph_unresolved", "Version held artifact is unavailable");
    }
    const snapshot = freezeDeep<V2WorkerVersionSnapshot>({
      sourceOperationId: op.id,
      worker: {
        uid: worker.uid,
        principal: worker.principal,
        space: worker.space,
        generation: worker.generation,
      },
      version: { uid: own.uid, generation: op.generation, spec },
    });
    const vector = canonicalJson({
      op,
      own,
      worker,
      workerOp,
      refRows,
      referenceEvidence,
      bundle: bundle?.evidence ?? null,
      assets: assets?.evidence ?? null,
      snapshot,
    } as unknown as JsonObject);
    const finalNow = now().getTime();
    if (!Number.isFinite(finalNow) || op.lease_until_ms === null || op.lease_until_ms <= finalNow) {
      return versionUnresolved(
        "stale_claim",
        "The accepted Version lease expired during graph read",
      );
    }
    return {
      kind: "ready",
      snapshot,
      vector,
      materials: { bundle: bundle?.target ?? null, assets: assets?.target ?? null },
    };
  }

  type LivePublicationCaptureInput = {
    execution: V2Execution;
    incumbentSourceOperationId?: string;
  };
  type CurrentServingCaptureInput = {
    currentServing: {
      workerUid: string;
      targetKey: string;
      sourceOperationId: string;
      expectedIdentity: V2WorkerCurrentServingIdentity;
      tolerateUnstartedSuccessors: boolean;
      neverServedOperation?: NeverServedOperation;
    };
  };
  async function capture(input: LivePublicationCaptureInput): Promise<Capture>;
  async function capture(input: CurrentServingCaptureInput): Promise<CurrentCapture>;
  async function capture(
    input: LivePublicationCaptureInput | CurrentServingCaptureInput,
  ): Promise<Capture | CurrentCapture> {
    const current = "currentServing" in input ? input.currentServing : null;
    const execution = "execution" in input ? input.execution : null;
    if (
      execution !== null &&
      execution.form !== WORKER_DEPLOYMENT_FORM_URL &&
      execution.form !== WORKER_ENDPOINT_FORM_URL
    )
      return unresolved("graph_unresolved", "This operation is not a Worker publication");
    const [op, initialOwn] = await Promise.all([
      operation(execution?.operationId ?? current?.sourceOperationId ?? ""),
      execution ? resource(execution.resourceUid) : null,
    ]);
    const own = initialOwn ?? (op ? await resource(op.resource_uid) : null);
    if (!op || !own) {
      return unresolved("graph_unresolved", "The accepted publication source is unavailable");
    }
    if (current && pendingStatuses.has(op.status)) {
      return unresolved("source_unsettled", "The serving source Operation is not terminal");
    }
    // Boot recovery only. The Resource may already carry a queued successor of
    // the committed source generation. The committed view is the Resource as
    // of `op`, which is immutable history; the successor is validated below.
    let servingRow = own;
    if (
      current?.tolerateUnstartedSuccessors &&
      own.busy_operation !== null &&
      own.busy_operation !== op.id
    ) {
      const successor = await operation(own.busy_operation);
      if (
        unstartedSuccessor(successor, own, current.neverServedOperation) &&
        op.status === "succeeded" &&
        op.generation === own.observed_generation &&
        successor.generation === op.generation + 1
      ) {
        servingRow = {
          ...own,
          generation: op.generation,
          last_operation: op.id,
          busy_operation: null,
          phase: "idle",
          spec_json: op.accepted_spec_json,
        };
      } else {
        return unresolved("source_unsettled", "A later Worker publication has started");
      }
    }
    if (
      current
        ? !confirmedServingSource(op, servingRow, current.targetKey)
        : !execution || !isCurrentClaim(op, own, execution, now().getTime())
    ) {
      return unresolved("stale_claim", "The accepted operation lease is no longer current");
    }
    const form = own.form_url;
    const action = op.action;
    const accepted = parseObject(op.accepted_spec_json);
    if (!accepted) return unresolved("graph_unresolved", "Accepted Worker spec is unavailable");
    let workerUid: string;
    try {
      workerUid =
        form === WORKER_DEPLOYMENT_FORM_URL
          ? parseWorkerDeploymentSpec(accepted).worker.resourceUid
          : parseWorkerEndpointSpec(accepted).worker.resourceUid;
    } catch {
      return unresolved("graph_unresolved", "Accepted Worker spec is invalid");
    }
    if (!uidPattern.test(workerUid)) {
      return unresolved("graph_unresolved", "Accepted Worker UID is invalid");
    }
    if (
      current &&
      (current.workerUid !== workerUid || current.expectedIdentity.workerResourceUid !== workerUid)
    ) {
      return unresolved("graph_unresolved", "Serving identity has a different Worker UID");
    }
    const worker = await resource(workerUid);
    const workerOp = worker ? await operation(worker.last_operation) : null;
    if (
      !worker ||
      worker.form_url !== MODULE_WORKER_FORM_URL ||
      worker.principal !== op.principal ||
      worker.space !== own.space ||
      !settled(worker, workerOp)
    )
      return unresolved(
        "graph_unresolved",
        "Worker identity is not settled in this owner and Space",
      );
    try {
      parseModuleWorkerSpec(parseObject(worker.spec_json));
    } catch {
      return unresolved("graph_unresolved", "Worker identity spec is invalid");
    }

    const incumbentId =
      "incumbentSourceOperationId" in input ? input.incumbentSourceOperationId : undefined;
    let incumbent: OperationRow | null = null;
    let incumbentResource: ResourceRow | null = null;
    if (incumbentId !== undefined) {
      incumbent = await operation(incumbentId);
      incumbentResource = incumbent ? await resource(incumbent.resource_uid) : null;
      if (
        !incumbent ||
        !incumbentResource ||
        incumbentResource.principal !== op.principal ||
        incumbentResource.space !== own.space ||
        (incumbentResource.form_url !== WORKER_DEPLOYMENT_FORM_URL &&
          incumbentResource.form_url !== WORKER_ENDPOINT_FORM_URL) ||
        workerUidFromOperation(incumbent) !== workerUid ||
        (incumbentResource.deleted_at !== null &&
          !(incumbent.status === "succeeded" && incumbent.action === "delete")) ||
        incumbent.status === "failed"
      )
        return unresolved("incumbent_unresolved", "Published incumbent has no confirmed SQL owner");
      if (incumbent.id !== op.id && pendingStatuses.has(incumbent.status)) {
        return unresolved("incumbent_unresolved", "Published incumbent has not settled");
      }
    }

    let pending: OperationRow[] = current ? [] : await pendingPublication(workerUid);
    // Resources whose queued successors were validated, with those Operations'
    // sealed reference targets (reserved as extra active edges at acceptance).
    const unstartedTargets = new Map<string, Set<string>>();
    if (current) {
      if (current.tolerateUnstartedSuccessors) {
        pending = await pendingPublication(workerUid);
        if (pending.length > MAX_UNSTARTED_SUCCESSORS) {
          return unresolved("source_unsettled", "Too many later Worker publications are queued");
        }
        for (const queued of pending) {
          const queuedResource = await resource(queued.resource_uid);
          if (
            !queuedResource ||
            queued.id === op.id ||
            queuedResource.principal !== op.principal ||
            queuedResource.space !== own.space ||
            workerUidFromOperation(queued) !== workerUid ||
            !(
              unstartedSuccessor(queued, queuedResource, current.neverServedOperation) ||
              unstartedCreate(queued, queuedResource, current.neverServedOperation)
            )
          ) {
            return unresolved("source_unsettled", "A later Worker publication has started");
          }
          // A DELETE reserves no references; CREATE/UPDATE seal a set at acceptance.
          const queuedReferences = queued.action === "delete" ? [] : await references(queued.id);
          if (!queuedReferences) {
            return unresolved("source_unsettled", "A later Worker publication is not sealed");
          }
          unstartedTargets.set(
            queuedResource.uid,
            new Set(queuedReferences.map((reference) => reference.target_uid)),
          );
        }
      } else if (await hasPendingPublication(workerUid)) {
        return unresolved("source_unsettled", "A later Worker publication is unresolved");
      }
    } else {
      if (!pending.some((item) => item.id === op.id)) {
        return unresolved("stale_claim", "Publication operation is no longer pending");
      }
      if (pending[0]?.id !== op.id && incumbentId !== op.id) {
        return unresolved("publication_conflict", "An earlier Worker publication is still pending");
      }
    }

    const [deploymentRows, endpointRows] = await Promise.all([
      matchingResources(WORKER_DEPLOYMENT_FORM_URL, workerUid, op.principal, own.space, !!current),
      matchingResources(WORKER_ENDPOINT_FORM_URL, workerUid, op.principal, own.space, !!current),
    ]);
    if (current && (deploymentRows.length > 1 || endpointRows.length > 1)) {
      return unresolved("publication_conflict", "More than one Worker attachment is present");
    }
    for (const row of [...deploymentRows, ...endpointRows]) {
      if (await hasUnresolvedPriorEffect(row)) {
        return unresolved(
          "graph_unresolved",
          "A prior Worker attachment effect remains unresolved",
        );
      }
    }
    // A second UID is not an update. Never replace an already-active attachment.
    for (const rows of [deploymentRows, endpointRows]) {
      const confirmed = rows.filter((row) => row.observed_generation > 0);
      const confirmedOthers = confirmed.filter((row) => row.uid !== own.uid);
      if (
        confirmed.length > 1 ||
        (rows.some((row) => row.uid === own.uid) &&
          confirmedOthers.length > 0 &&
          ((form === WORKER_DEPLOYMENT_FORM_URL && rows === deploymentRows) ||
            (form === WORKER_ENDPOINT_FORM_URL && rows === endpointRows)))
      ) {
        return unresolved(
          "publication_conflict",
          "A different active Worker attachment already exists",
        );
      }
    }

    async function chosen(
      rows: readonly ResourceRow[],
      chosenForm: string,
    ): Promise<{ row: ResourceRow; accepted: JsonObject; op: OperationRow } | null | Unresolved> {
      const isOwnForm = form === chosenForm;
      if (isOwnForm && action === "delete") return null;
      const row = isOwnForm
        ? servingRow
        : rows.find((candidate) => candidate.observed_generation > 0);
      if (!row) return null;
      const chosenOp = isOwnForm
        ? op
        : row.busy_operation === null
          ? await operation(row.last_operation)
          : (((
              await sql.query(
                `SELECT * FROM tf_v2_operations WHERE resource_uid = ?
             AND generation = ? AND status = 'succeeded' AND effect = 'complete' LIMIT 1`,
                [row.uid, row.observed_generation],
              )
            )[0] ?? null) as OperationRow | null);
      const confirmedPrior =
        !isOwnForm &&
        row.busy_operation !== null &&
        chosenOp !== null &&
        row.deleted_at === null &&
        chosenOp.resource_uid === row.uid &&
        chosenOp.principal === row.principal &&
        chosenOp.generation === row.observed_generation &&
        chosenOp.action !== "delete" &&
        chosenOp.status === "succeeded" &&
        chosenOp.effect === "complete";
      if (!chosenOp || ((current || !isOwnForm) && !settled(row, chosenOp) && !confirmedPrior)) {
        return unresolved("graph_unresolved", "A Worker attachment has unconfirmed effects");
      }
      const chosenSpec = parseObject(chosenOp.accepted_spec_json);
      if (!chosenSpec) return unresolved("graph_unresolved", "A Worker attachment spec is invalid");
      return { row, accepted: chosenSpec, op: chosenOp };
    }

    const chosenDeployment = await chosen(deploymentRows, WORKER_DEPLOYMENT_FORM_URL);
    const chosenEndpoint = await chosen(endpointRows, WORKER_ENDPOINT_FORM_URL);
    if (chosenDeployment && "kind" in chosenDeployment) return chosenDeployment;
    if (chosenEndpoint && "kind" in chosenEndpoint) return chosenEndpoint;
    if (
      endpointRows.some((row) => row.uid !== own.uid && row.phase === "error") ||
      deploymentRows.some((row) => row.uid !== own.uid && row.phase === "error")
    ) {
      return unresolved("graph_unresolved", "A Worker attachment has failed or partial effects");
    }

    const evidence: unknown[] = [];
    const referenceSetIds: string[] = [];
    const materials = new Map<string, VersionMaterialTargets>();
    let deployment: V2WorkerPublicationSnapshot["deployment"] = null;
    if (chosenDeployment) {
      let spec: WorkerDeploymentSpec;
      try {
        spec = parseWorkerDeploymentSpec(chosenDeployment.accepted);
      } catch {
        return unresolved("graph_unresolved", "Deployment spec is invalid");
      }
      if (current || chosenDeployment.op.id !== op.id) {
        const observed = parseObject(chosenDeployment.row.observed_json);
        if (observed?.ready !== true || observed.active !== true) {
          return unresolved("graph_unresolved", "Deployment is not confirmed active and ready");
        }
      }
      const refRows = await references(chosenDeployment.op.id);
      if (
        !refRows ||
        refRows.length !== spec.versions.length + 1 ||
        !hasReference(refRows, workerUid, MODULE_WORKER_FORM_URL, "observed") ||
        spec.versions.some(
          (item) =>
            !hasReference(
              refRows,
              item.workerVersion.resourceUid,
              WORKER_VERSION_FORM_URL,
              "ready",
              workerUid,
            ),
        )
      ) {
        return unresolved(
          "graph_unresolved",
          "Deployment accepted references are not sealed and exact",
        );
      }
      if (current) {
        const active = await activeReferences(
          chosenDeployment.row.uid,
          refRows,
          unstartedTargets.get(chosenDeployment.row.uid),
        );
        if (!active) {
          return unresolved("graph_unresolved", "Deployment active references changed");
        }
        evidence.push(active);
      }
      evidence.push(refRows);
      referenceSetIds.push(chosenDeployment.op.id);
      const versions: NonNullable<V2WorkerPublicationSnapshot["deployment"]>["versions"][number][] =
        [];
      const versionEvidence: unknown[] = [];
      for (const weighted of spec.versions) {
        const uid = weighted.workerVersion.resourceUid;
        const row = await resource(uid);
        const last = row ? await operation(row.last_operation) : null;
        const observed = row ? parseObject(row.observed_json) : null;
        if (
          !row ||
          row.form_url !== WORKER_VERSION_FORM_URL ||
          row.principal !== op.principal ||
          row.space !== own.space ||
          !last ||
          !settled(row, last) ||
          observed?.ready !== true ||
          observed.resolvedBindings !== true
        ) {
          return unresolved("graph_unresolved", "A weighted Worker Version is not ready");
        }
        let versionSpec: WorkerVersionSpec;
        try {
          versionSpec = parseWorkerVersionSpec(parseObject(row.spec_json));
        } catch {
          return unresolved("graph_unresolved", "A weighted Worker Version spec is invalid");
        }
        if (
          versionSpec.worker.resourceUid !== workerUid ||
          (versionSpec.bundle && observed.bundleVerified !== true)
        ) {
          return unresolved(
            "graph_unresolved",
            "A weighted Worker Version does not match this Worker",
          );
        }
        const versionReferences = last ? await exactVersionReferences(last.id, versionSpec) : null;
        if (!versionReferences) {
          return unresolved(
            "graph_unresolved",
            "A weighted Worker Version references are not sealed and exact",
          );
        }
        const active = await activeReferences(uid, versionReferences);
        const targets = await settledReferenceTargets(
          versionReferences,
          op.principal,
          own.space,
          new Set(versionSpec.serviceBindings.map((item) => item.resource.resourceUid)),
          op.target_key,
        );
        if (!active || !targets) {
          return unresolved("graph_unresolved", "Version active references changed");
        }
        versionEvidence.push(active, targets);
        if (last) referenceSetIds.push(last.id);
        const bundle = versionSpec.bundle
          ? await artifactTarget({
              versionUid: uid,
              targetUid: versionSpec.bundle.resourceUid,
              formUrl: WORKER_BUNDLE_FORM_URL,
              principal: op.principal,
              space: own.space,
            })
          : null;
        const assets = versionSpec.assets
          ? await artifactTarget({
              versionUid: uid,
              targetUid: versionSpec.assets.bundle.resourceUid,
              formUrl: STATIC_ASSET_BUNDLE_FORM_URL,
              principal: op.principal,
              space: own.space,
            })
          : null;
        if ((versionSpec.bundle && !bundle) || (versionSpec.assets && !assets)) {
          return unresolved(
            "graph_unresolved",
            "A weighted Worker Version artifact is unavailable",
          );
        }
        if (bundle) evidence.push(bundle.evidence);
        if (assets) evidence.push(assets.evidence);
        materials.set(uid, { bundle: bundle?.target ?? null, assets: assets?.target ?? null });
        versionEvidence.push({ row, last, versionReferences });
        versions.push({
          uid,
          sourceOperationId: last.id,
          generation: row.generation,
          weight: weighted.weight,
          spec: versionSpec,
        });
      }
      deployment = {
        uid: chosenDeployment.row.uid,
        generation: chosenDeployment.op.generation,
        spec,
        versions,
      };
      // Keep every dependency row in the readback vector, not just its public
      // projection. A readiness/output change must invalidate stillCurrent.
      evidence.push(...versionEvidence);
    }
    let endpoint: V2WorkerPublicationSnapshot["endpoint"] = null;
    if (chosenEndpoint) {
      let spec: WorkerEndpointSpec;
      try {
        spec = parseWorkerEndpointSpec(chosenEndpoint.accepted);
      } catch {
        return unresolved("graph_unresolved", "Endpoint spec is invalid");
      }
      const refRows = await references(chosenEndpoint.op.id);
      const output = outputHostname(chosenEndpoint.row);
      if (current || chosenEndpoint.op.id !== op.id) {
        const observed = parseObject(chosenEndpoint.row.observed_json);
        if (observed?.tlsReady !== true || observed.activeDeploymentRouteReady !== true) {
          return unresolved("graph_unresolved", "Endpoint route is not confirmed ready");
        }
      }
      if (
        refRows?.length !== 1 ||
        !hasReference(refRows, workerUid, MODULE_WORKER_FORM_URL, "observed") ||
        !output
      ) {
        return unresolved("graph_unresolved", "Endpoint accepted owner or address is unavailable");
      }
      if (current) {
        const active = await activeReferences(
          chosenEndpoint.row.uid,
          refRows,
          unstartedTargets.get(chosenEndpoint.row.uid),
        );
        if (!active) {
          return unresolved("graph_unresolved", "Endpoint active references changed");
        }
        evidence.push(active);
      }
      evidence.push(refRows);
      referenceSetIds.push(chosenEndpoint.op.id);
      endpoint = {
        uid: chosenEndpoint.row.uid,
        generation: chosenEndpoint.op.generation,
        spec,
        output,
      };
    }
    if (endpoint && !deployment && action !== "delete") {
      return unresolved("graph_unresolved", "Endpoint has no active Deployment");
    }
    if (
      endpoint &&
      deployment?.versions.some(
        (version) => !version.spec.handlers.includes("fetch") && !version.spec.assets,
      )
    ) {
      return unresolved("graph_unresolved", "Endpoint requires HTTP-capable weighted Versions");
    }
    const acceptedEndpointOutput = form === WORKER_ENDPOINT_FORM_URL ? outputHostname(own) : null;
    if (form === WORKER_ENDPOINT_FORM_URL && !acceptedEndpointOutput) {
      return unresolved("graph_unresolved", "Accepted Endpoint address is unavailable");
    }
    const snapshot = freezeDeep<V2WorkerPublicationSnapshot>({
      sourceOperationId: op.id,
      ...(acceptedEndpointOutput ? { acceptedEndpointOutput } : {}),
      worker: {
        uid: worker.uid,
        principal: worker.principal,
        space: worker.space,
        generation: worker.generation,
      },
      deployment,
      endpoint,
    });
    if (current && !exactServingIdentity(snapshot, current.expectedIdentity)) {
      return unresolved("graph_unresolved", "Persisted serving identity differs from SQL graph");
    }
    // An accepted attachment or Binding can add an incoming edge without
    // altering a selected Resource row. Capture the complete inbound set, not
    // only the explicit Deployment/Endpoint rows projected above.
    const inboundTargetIds = [
      workerUid,
      ...(deployment?.versions.map((version) => version.uid) ?? []),
      ...(deployment ? [deployment.uid] : []),
      ...(endpoint ? [endpoint.uid] : []),
      ...[...materials.values()].flatMap((target) =>
        [target.bundle?.uid, target.assets?.uid].filter((uid): uid is string => uid !== undefined),
      ),
    ];
    const inboundEdges = await sql.query(
      `SELECT target_uid, referrer_uid FROM tf_v2_resource_references
       WHERE target_uid IN (SELECT value FROM json_each(?))
       ORDER BY target_uid, referrer_uid`,
      [JSON.stringify(inboundTargetIds)],
    );
    const publisherRows = current
      ? await currentPublisherRows({
          workerUid,
          principal: op.principal,
          space: own.space,
          tolerateUnstartedSuccessors: current.tolerateUnstartedSuccessors,
        })
      : null;
    if (
      current &&
      (publisherRows?.[0]?.id !== op.id ||
        typeof publisherRows[0]?.acceptance_order !== "number" ||
        !Number.isSafeInteger(publisherRows[0].acceptance_order) ||
        publisherRows[0].acceptance_order <= 0 ||
        (publisherRows.length > 1 &&
          publisherRows[0].acceptance_order === publisherRows[1]?.acceptance_order))
    ) {
      return unresolved("graph_unresolved", "Serving source is not the unique latest publisher");
    }
    // The vector includes every row read above, including the incumbent and
    // pending queue. A later acceptance, settlement, deletion, or lease change
    // invalidates the snapshot even when its projected public fields look equal.
    const graphEvidence = {
      op,
      own,
      worker,
      workerOp,
      incumbent,
      incumbentResource,
      pending,
      deploymentRows,
      endpointRows,
      deployment: chosenDeployment,
      endpoint: chosenEndpoint,
      evidence,
      inboundEdges,
      publisherRows,
      snapshot,
    };
    const guardEvidence = {
      op,
      own,
      worker,
      workerOp,
      incumbent,
      incumbentResource,
      pending,
      deploymentRows,
      endpointRows,
      deployment: chosenDeployment && { row: chosenDeployment.row, op: chosenDeployment.op },
      endpoint: chosenEndpoint && { row: chosenEndpoint.row, op: chosenEndpoint.op },
      evidence,
      inboundEdges,
    };
    const vector = canonicalJson(graphEvidence as unknown as JsonObject);
    // SQL graph reads above may await after the first lease check. Do not
    // return a once-valid claim as ready after its known deadline elapsed.
    if (current) {
      return {
        kind: "ready",
        snapshot,
        vector,
        materials,
        fence: { sourceOwnerUid: own.uid, referenceSetIds, inboundTargetIds },
      };
    }
    const finalNow = now().getTime();
    if (!Number.isFinite(finalNow) || op.lease_until_ms === null || op.lease_until_ms <= finalNow) {
      return unresolved("stale_claim", "The accepted operation lease expired during graph read");
    }
    if (!execution) return unresolved("stale_claim", "The accepted operation is unavailable");
    let sqlGuard: V2WorkerPublicationSqlGuard;
    try {
      sqlGuard = createWorkerPublicationSqlGuard({
        execution,
        workerUid,
        principal: op.principal,
        space: own.space,
        pendingIds: pending.map((item) => item.id),
        deploymentIds: deploymentRows.map((item) => item.uid),
        endpointIds: endpointRows.map((item) => item.uid),
        inboundTargetIds,
        inboundEdges,
        referenceSetIds,
        evidence: guardEvidence,
      });
    } catch {
      return unresolved("graph_unresolved", "Worker publication SQL guard is unavailable");
    }
    return { kind: "ready", snapshot, vector, materials, sqlGuard };
  }

  async function readMaterialsTargets(
    target: VersionMaterialTargets,
    principal: string,
    space: string,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<V2WorkerVersionMaterials> {
    const denied = () => new SqlError("unavailable", "Worker Version materials are not authorized");
    if (!(await stillAuthorized())) throw denied();
    const bundleCustody = options.bundleCustody;
    const assetCustody = options.assetCustody;
    if (target.bundle && !bundleCustody) throw denied();
    if (target.assets && !assetCustody) throw denied();
    const bundle =
      target.bundle && bundleCustody
        ? await bundleCustody.readHeldVerified({
            targetResourceUid: target.bundle.uid,
            principal,
            space,
            expectedSpec: target.bundle.spec,
            expectedObserved: target.bundle.observed,
            stillAuthorized,
          })
        : null;
    const assets =
      target.assets && assetCustody
        ? await assetCustody.readHeldVerified({
            targetResourceUid: target.assets.uid,
            principal,
            space,
            expectedSpec: target.assets.spec,
            expectedObserved: target.assets.observed,
            stillAuthorized,
          })
        : null;
    if (!(await stillAuthorized())) throw denied();
    const cloneRead = <M>(
      read: SqlArtifactCustodyRead<M> | null,
    ): SqlArtifactCustodyRead<M> | null =>
      read && {
        manifest: structuredClone(read.manifest),
        manifestBytes: new Uint8Array(read.manifestBytes),
        files: read.files.map((file) => new Uint8Array(file)),
        observed: structuredClone(read.observed),
      };
    return { bundle: cloneRead(bundle), assets: cloneRead(assets) };
  }

  async function openMaterialsTargetsUnverified(
    target: VersionMaterialTargets,
    principal: string,
    space: string,
    stillAuthorized: () => Promise<boolean>,
  ): Promise<V2WorkerVersionMaterialScopes> {
    const denied = () => new SqlError("unavailable", "Worker Version materials are not authorized");
    if (!(await stillAuthorized())) throw denied();
    const bundleCustody = options.bundleCustody;
    const assetCustody = options.assetCustody;
    if (
      (target.bundle && !bundleCustody?.openHeldUnverified) ||
      (target.assets && !assetCustody?.openHeldUnverified)
    )
      throw denied();
    const bundle =
      target.bundle && bundleCustody?.openHeldUnverified
        ? await bundleCustody.openHeldUnverified({
            targetResourceUid: target.bundle.uid,
            principal,
            space,
            expectedSpec: target.bundle.spec,
            expectedObserved: target.bundle.observed,
            stillAuthorized,
          })
        : null;
    const assets =
      target.assets && assetCustody?.openHeldUnverified
        ? await assetCustody.openHeldUnverified({
            targetResourceUid: target.assets.uid,
            principal,
            space,
            expectedSpec: target.assets.spec,
            expectedObserved: target.assets.observed,
            stillAuthorized,
          })
        : null;
    if (!(await stillAuthorized())) throw denied();
    return { bundle, assets };
  }

  return {
    /** A bounded positive proof that this settled Worker currently has no serving Deployment. */
    async observeNoCurrentServing(input: {
      workerUid: string;
      principal: string;
      space: string;
      targetKey: string;
    }): Promise<{ readonly kind: "confirmed" } | { readonly kind: "unknown" }> {
      const { workerUid, principal, space, targetKey } = input;
      if (!workerUid || !principal || !space || !targetKey) return { kind: "unknown" };
      try {
        const worker = await resource(workerUid);
        const workerOp = worker ? await operation(worker.last_operation) : null;
        if (
          !worker ||
          worker.principal !== principal ||
          worker.space !== space ||
          worker.target_key !== targetKey ||
          worker.form_url !== MODULE_WORKER_FORM_URL ||
          !workerOp ||
          !settled(worker, workerOp) ||
          (workerOp.action !== "create" && workerOp.action !== "update")
        ) {
          return { kind: "unknown" };
        }
        const workerSpec = parseObject(worker.spec_json);
        if (!workerSpec) return { kind: "unknown" };
        parseModuleWorkerSpec(workerSpec);
        if (await hasPendingPublication(workerUid)) return { kind: "unknown" };

        const deployments = await matchingResources(
          WORKER_DEPLOYMENT_FORM_URL,
          workerUid,
          principal,
          space,
          true,
        );
        if (deployments.length > 1) return { kind: "unknown" };
        const deploymentEdges = await sql.query(
          `SELECT d.uid, d.principal, d.space, d.target_key, d.deleted_at
           FROM tf_v2_resource_references edge
           JOIN tf_v2_resources d ON d.uid = edge.referrer_uid
           WHERE edge.target_uid = ? AND d.form_url = ? ORDER BY d.uid LIMIT 3`,
          [workerUid, WORKER_DEPLOYMENT_FORM_URL],
        );
        if (
          deploymentEdges.length !== deployments.length ||
          deploymentEdges.some((edge, index) => {
            const deployment = deployments[index];
            return (
              !deployment ||
              edge.uid !== deployment.uid ||
              edge.principal !== principal ||
              edge.space !== space ||
              edge.target_key !== targetKey ||
              edge.deleted_at !== null
            );
          })
        ) {
          return { kind: "unknown" };
        }
        for (const deployment of deployments) {
          const deploymentOp = await operation(deployment.last_operation);
          if (
            !deploymentOp ||
            !settled(deployment, deploymentOp) ||
            (deploymentOp.action !== "create" && deploymentOp.action !== "update")
          ) {
            return { kind: "unknown" };
          }
          const specValue = parseObject(deployment.spec_json);
          if (!specValue) return { kind: "unknown" };
          const spec = parseWorkerDeploymentSpec(specValue);
          if (spec.worker.resourceUid !== workerUid) return { kind: "unknown" };
          const required = referencesForWorkerDeployment(spec);
          const referencesForOp = await references(deploymentOp.id);
          if (
            !referencesForOp ||
            referencesForOp.length !== required.length ||
            required.some((item, index) => {
              const actual = referencesForOp[index];
              const path = item.targetSpecMatch ? `$.${item.targetSpecMatch.path.join(".")}` : null;
              return (
                !actual ||
                actual.target_uid !== item.resourceUid ||
                actual.form_url !== item.formUrl ||
                actual.readiness !== item.readiness ||
                actual.target_spec_path !== path ||
                actual.target_spec_equals !== (item.targetSpecMatch?.equals ?? null)
              );
            })
          ) {
            return { kind: "unknown" };
          }
          const observed = parseObject(deployment.observed_json);
          const selected = observed?.selectedVersions;
          if (
            observed?.ready !== true ||
            observed.active !== false ||
            !Array.isArray(selected) ||
            selected.length !== spec.versions.length
          ) {
            return { kind: "unknown" };
          }
          const expectedSelected = spec.versions
            .map(({ workerVersion, weight }) => ({
              resourceUid: workerVersion.resourceUid,
              weight,
            }))
            .sort((left, right) => left.resourceUid.localeCompare(right.resourceUid));
          const actualSelected = selected.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null;
            const value = item as Record<string, unknown>;
            return typeof value.resourceUid === "string" && typeof value.weight === "number"
              ? { resourceUid: value.resourceUid, weight: value.weight }
              : null;
          });
          if (canonicalJson(actualSelected) !== canonicalJson(expectedSelected)) {
            return { kind: "unknown" };
          }
          if (await hasUnresolvedPriorEffect(deployment)) return { kind: "unknown" };
        }

        // No intervening Worker, Deployment, or Endpoint acceptance may have
        // changed this conclusion while the sealed references were inspected.
        const [latestWorker, latestDeployments, latestDeploymentEdges, pending] = await Promise.all(
          [
            resource(workerUid),
            matchingResources(WORKER_DEPLOYMENT_FORM_URL, workerUid, principal, space, true),
            sql.query(
              `SELECT d.uid, d.principal, d.space, d.target_key, d.deleted_at
             FROM tf_v2_resource_references edge
             JOIN tf_v2_resources d ON d.uid = edge.referrer_uid
             WHERE edge.target_uid = ? AND d.form_url = ? ORDER BY d.uid LIMIT 3`,
              [workerUid, WORKER_DEPLOYMENT_FORM_URL],
            ),
            hasPendingPublication(workerUid),
          ],
        );
        if (
          pending ||
          !latestWorker ||
          !settled(latestWorker, await operation(latestWorker.last_operation)) ||
          latestWorker.last_operation !== worker.last_operation ||
          latestWorker.generation !== worker.generation ||
          latestDeployments.length !== deployments.length ||
          latestDeploymentEdges.length !== deploymentEdges.length ||
          latestDeploymentEdges.some(
            (edge, index) =>
              edge.uid !== deploymentEdges[index]?.uid ||
              edge.principal !== deploymentEdges[index]?.principal ||
              edge.space !== deploymentEdges[index]?.space ||
              edge.target_key !== deploymentEdges[index]?.target_key ||
              edge.deleted_at !== deploymentEdges[index]?.deleted_at,
          ) ||
          latestDeployments.some(
            (latest, index) =>
              latest.uid !== deployments[index]?.uid ||
              latest.last_operation !== deployments[index]?.last_operation ||
              latest.generation !== deployments[index]?.generation ||
              latest.observed_json !== deployments[index]?.observed_json,
          )
        ) {
          return { kind: "unknown" };
        }
        return { kind: "confirmed" };
      } catch {
        return { kind: "unknown" };
      }
    },
    async resolveVersionUnverified(input: {
      execution: V2Execution;
    }): Promise<V2WorkerVersionMaterialScopeResolution> {
      const initial = await captureVersion(input.execution);
      if (initial.kind === "unresolved") return initial;
      const stillAuthorized = async () => {
        const latest = await captureVersion(input.execution);
        return latest.kind === "ready" && latest.vector === initial.vector;
      };
      if (!(await stillAuthorized())) {
        return versionUnresolved(
          "stale_claim",
          "The accepted Version graph changed during capture",
        );
      }
      return {
        kind: "unverified",
        snapshot: initial.snapshot,
        graphStillCurrent: stillAuthorized,
        openMaterialsUnverified: () =>
          openMaterialsTargetsUnverified(
            initial.materials,
            initial.snapshot.worker.principal,
            initial.snapshot.worker.space,
            stillAuthorized,
          ),
      };
    },
    async resolveVersion(input: { execution: V2Execution }): Promise<V2WorkerVersionResolution> {
      const initial = await captureVersion(input.execution);
      if (initial.kind === "unresolved") return initial;
      const stillAuthorized = async () => {
        const latest = await captureVersion(input.execution);
        return latest.kind === "ready" && latest.vector === initial.vector;
      };
      try {
        // "ready" must mean the held bytes themselves were verified, not only
        // that their SQL owner claimed verification in an earlier operation.
        await readMaterialsTargets(
          initial.materials,
          initial.snapshot.worker.principal,
          initial.snapshot.worker.space,
          stillAuthorized,
        );
      } catch {
        return (await stillAuthorized())
          ? versionUnresolved("graph_unresolved", "Version held artifact bytes are unavailable")
          : versionUnresolved("stale_claim", "The accepted Version graph changed during byte read");
      }
      if (!(await stillAuthorized())) {
        return versionUnresolved(
          "stale_claim",
          "The accepted Version graph changed during byte read",
        );
      }
      const stillCurrent = async (): Promise<boolean> => {
        try {
          // SQL identity alone cannot detect damaged held chunks. The last
          // pre-effect fence also rehashes the exact accepted byte targets.
          await readMaterialsTargets(
            initial.materials,
            initial.snapshot.worker.principal,
            initial.snapshot.worker.space,
            stillAuthorized,
          );
          return await stillAuthorized();
        } catch {
          return false;
        }
      };
      return {
        kind: "ready",
        snapshot: initial.snapshot,
        stillCurrent,
        readMaterials: () =>
          readMaterialsTargets(
            initial.materials,
            initial.snapshot.worker.principal,
            initial.snapshot.worker.space,
            stillAuthorized,
          ),
      };
    },
    /** Read-only SQL and held-material proof; native serving needs separate owner readback. */
    async resolveCurrentServing(input: {
      workerUid: string;
      targetKey: string;
      sourceOperationId: string;
      expectedIdentity: V2WorkerCurrentServingIdentity;
      /**
       * Boot recovery of an already active incarnation only. Accept queued
       * Deployment/Endpoint Operations that have no possible backend effect,
       * and prove the committed generation they sit on. Every other caller
       * keeps the strict fence that refuses while any publication is pending.
       */
      tolerateUnstartedSuccessors?: boolean;
      /**
       * With `tolerateUnstartedSuccessors` only: the owner's proof that an
       * Operation which already recorded a dispatch never reached native
       * serving. Without it a dispatched Operation is refused.
       */
      neverServedOperation?: NeverServedOperation;
    }): Promise<V2WorkerCurrentServingResolution> {
      // The owner can await while reading SQL. Sample its persisted marker once,
      // before any await, so caller mutation cannot retarget this readback.
      let captured: CurrentServingCaptureInput;
      try {
        captured = {
          currentServing: freezeDeep({
            workerUid: input.workerUid,
            targetKey: input.targetKey,
            sourceOperationId: input.sourceOperationId,
            tolerateUnstartedSuccessors: input.tolerateUnstartedSuccessors === true,
            ...(input.tolerateUnstartedSuccessors === true &&
            input.neverServedOperation !== undefined
              ? { neverServedOperation: input.neverServedOperation }
              : {}),
            expectedIdentity: {
              generation: input.expectedIdentity.generation,
              workerResourceUid: input.expectedIdentity.workerResourceUid,
              hostnames: [...input.expectedIdentity.hostnames],
              versions: input.expectedIdentity.versions.map((version) => ({
                workerVersionUid: version.workerVersionUid,
                weight: version.weight,
              })),
            },
          }),
        };
      } catch {
        return unresolved("graph_unresolved", "Persisted serving identity is invalid");
      }
      let initial: CurrentCapture;
      try {
        initial = await capture(captured);
      } catch {
        return unresolved("graph_unresolved", "Current serving SQL graph is unavailable");
      }
      if (initial.kind === "unresolved") return initial;
      let initialFence: string;
      try {
        initialFence = await currentServingFence(captured, initial);
        const confirmed = await capture(captured);
        if (confirmed.kind !== "ready" || confirmed.vector !== initial.vector) {
          return unresolved("graph_unresolved", "Current serving graph changed during capture");
        }
      } catch {
        return unresolved("graph_unresolved", "Current serving SQL fence is unavailable");
      }
      const stillAuthorized = async (): Promise<boolean> => {
        try {
          return (await currentServingFence(captured, initial)) === initialFence;
        } catch {
          return false;
        }
      };
      const readVersionMaterials = async (
        versionUid: string,
      ): Promise<V2WorkerVersionMaterials> => {
        const target = initial.materials.get(versionUid);
        if (!target) {
          throw new SqlError("unavailable", "Worker Version materials are not authorized");
        }
        return readMaterialsTargets(
          target,
          initial.snapshot.worker.principal,
          initial.snapshot.worker.space,
          stillAuthorized,
        );
      };
      const verifyAllMaterials = async (): Promise<boolean> => {
        try {
          for (const version of initial.snapshot.deployment?.versions ?? []) {
            await readVersionMaterials(version.uid);
          }
          return await stillAuthorized();
        } catch {
          return false;
        }
      };
      if (!(await verifyAllMaterials())) {
        return unresolved(
          "graph_unresolved",
          "Current serving graph or held bytes are unavailable",
        );
      }
      return {
        kind: "ready",
        snapshot: initial.snapshot,
        stillCurrent: verifyAllMaterials,
        readVersionMaterials,
      };
    },
    async resolve(input: {
      execution: V2Execution;
      incumbentSourceOperationId?: string;
    }): Promise<V2WorkerPublicationResolution> {
      const initial = await capture(input);
      if (initial.kind === "unresolved") return initial;
      return {
        kind: "ready",
        snapshot: initial.snapshot,
        sqlGuard: initial.sqlGuard,
        async stillCurrent(): Promise<boolean> {
          const latest = await capture(input);
          return latest.kind === "ready" && latest.vector === initial.vector;
        },
        async readVersionMaterials(versionUid: string): Promise<V2WorkerVersionMaterials> {
          const target = initial.materials.get(versionUid);
          const stillAuthorized = async () => {
            const latest = await capture(input);
            return latest.kind === "ready" && latest.vector === initial.vector;
          };
          if (!target)
            throw new SqlError("unavailable", "Worker Version materials are not authorized");
          return readMaterialsTargets(
            target,
            initial.snapshot.worker.principal,
            initial.snapshot.worker.space,
            stillAuthorized,
          );
        },
        async openVersionMaterialsUnverified(
          versionUid: string,
        ): Promise<V2WorkerVersionMaterialScopes> {
          const target = initial.materials.get(versionUid);
          const stillAuthorized = async () => {
            const latest = await capture(input);
            return latest.kind === "ready" && latest.vector === initial.vector;
          };
          if (!target)
            throw new SqlError("unavailable", "Worker Version materials are not authorized");
          return openMaterialsTargetsUnverified(
            target,
            initial.snapshot.worker.principal,
            initial.snapshot.worker.space,
            stillAuthorized,
          );
        },
      };
    },
  };
}
