import { canonicalJson } from "../json.ts";
import type { JsonObject, Sql } from "../ports.ts";
import type { V2SqliteBindingGrant } from "../providers/selfhost-v2-sqlite-binding-broker.ts";
import type { WorkerdRuntime } from "../workerd-runtime.ts";
import {
  OBJECT_BUCKET_FORM_URL,
  OBJECT_BUCKET_LIMITS,
  parseObjectBucketSpec,
} from "./forms/object-bucket.ts";
import { OBJECT_BUCKET_BACKEND_ID } from "./forms/object-bucket-backend.ts";
import type { ObjectBucketWorkerBindingClaim } from "./forms/object-bucket-worker-binding-authority.ts";
import { parseSQLiteDatabaseSpec, SQLITE_DATABASE_FORM_URL } from "./forms/sqlite-database.ts";
import type { SQLiteWorkerBindingClaim } from "./forms/sqlite-worker-binding-authority.ts";
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
  validateModuleWorkerUpdate,
  validateWorkerVersionUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
  WorkerFormValidationError,
  type WorkerVersionSpec,
} from "./forms/worker-specs.ts";
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "./types.ts";
import { snapshotV2WorkerPrivateInputs } from "./worker-code-eligibility.ts";
import {
  inspectV2WorkerCodeVersionEligibility,
  type V2ResolvedObjectBucketBinding,
  type V2ResolvedSqliteBinding,
} from "./worker-code-runtime.ts";
import type { V2WorkerVersionResolution } from "./worker-publication-state.ts";
import { projectV2ResolvedServiceBindings } from "./worker-service-resolution.ts";
import { projectV2StaticWorkerVersion } from "./worker-static-runtime.ts";
import type {
  createV2WorkerVersionConfiguredInputSealer,
  V2WorkerVersionSealedInputs,
} from "./worker-version-configured-inputs.ts";

export const MODULE_WORKER_LIFECYCLE_BACKEND_ID = "selfhost-v2-module-worker-identity-v1";
export const WORKER_VERSION_LIFECYCLE_BACKEND_ID = "selfhost-v2-static-worker-version-v1";
export const WORKER_CODE_VERSION_LIFECYCLE_BACKEND_ID = "selfhost-v2-code-worker-version-v1";
export const WORKER_VERSION_UNIFIED_BACKEND_ID = "selfhost-v2-worker-version-v1";

type VersionState = {
  resolveVersion(input: { execution: V2Execution }): Promise<V2WorkerVersionResolution>;
};

/** Exact runtime owner identity; a Deployment receipt for one incarnation is insufficient. */
export interface V2WorkerRetirementTarget {
  readonly kind: "worker" | "version";
  readonly workerUid: string;
  readonly versionUid: string | null;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly backendId: string;
  readonly backendKey: string;
  readonly generation: number;
}

export interface V2WorkerRetirementProof {
  readonly kind: "retired";
  readonly target: V2WorkerRetirementTarget;
  readonly scope: "all_incarnations_and_contexts";
  readonly receipt: string;
}

export interface V2WorkerRetirementReader {
  /** Read-only proof across every active/draining incarnation; never infer absence from timeout. */
  observeRetired(
    target: V2WorkerRetirementTarget,
  ): Promise<V2WorkerRetirementProof | { readonly kind: "unknown" }>;
}

/** SQL-derived identity used to compare the independent Host owner readback. */
interface V2WorkerServingTarget {
  readonly workerResourceUid: string;
  readonly deploymentUid: string;
  readonly deploymentGeneration: number;
  readonly latestPublisherAcceptanceOrder: number;
  readonly endpointUid: string | null;
  readonly hostnames: readonly string[];
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly versions: readonly { readonly workerVersionUid: string; readonly weight: number }[];
}

export interface V2WorkerServingReader {
  /** Return independent owner-held pointer, running graph and open admission. */
  observeServing(input: {
    readonly workerResourceUid: string;
    readonly targetKey: string;
  }): Promise<
    | {
        readonly kind: "serving";
        readonly workerResourceUid: string;
        readonly targetKey: string;
        readonly sourceOperationId: string;
        readonly generation: string;
        readonly hostnames: readonly string[];
        readonly versions: readonly {
          readonly workerVersionUid: string;
          readonly weight: number;
        }[];
      }
    | { readonly kind: "unknown" }
  >;
}

const unresolved = (): V2BackendResult => ({ kind: "unknown" });

const DB_LEASE_FENCE = "(CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000";

async function currentClaim(sql: Sql, execution: V2Execution): Promise<boolean> {
  const rows = await sql.query(
    `SELECT op.id FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
     WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ?
       AND op.action = ? AND op.generation = ? AND op.backend_key = ?
       AND op.backend_id = ? AND op.target_key = ? AND op.accepted_spec_json = ?
       AND op.status = 'reconciling' AND op.dispatch_possible = 1
       AND op.lease_token = ? AND op.lease_until_ms > ${DB_LEASE_FENCE}
       AND r.uid = ? AND r.principal = ? AND r.form_url = ? AND r.space = ?
       AND r.name = ? AND r.backend_id = ? AND r.target_key = ?
       AND r.generation = op.generation AND r.last_operation = op.id
       AND r.busy_operation = op.id AND r.deleted_at IS NULL
       AND r.spec_json = op.accepted_spec_json LIMIT 1`,
    [
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
      execution.resourceUid,
      execution.principal,
      execution.form,
      execution.space,
      execution.name,
      execution.backendId,
      execution.targetKey,
    ],
  );
  return rows.length === 1;
}

async function noInboundReferences(sql: Sql, uid: string): Promise<boolean> {
  return (
    (
      await sql.query(
        `SELECT target_uid FROM tf_v2_resource_references edge
         JOIN tf_v2_resources referrer ON referrer.uid = edge.referrer_uid
         WHERE edge.target_uid = ? AND referrer.deleted_at IS NULL LIMIT 1`,
        [uid],
      )
    ).length === 0
  );
}

type ModuleObservation = { readonly activeDeploymentUid: string | null; readonly ready: boolean };
type ModuleGraph = {
  readonly observed: ModuleObservation;
  readonly servingTarget: V2WorkerServingTarget | null;
};

/** An Endpoint can republish the same Deployment, so its Operation may own the pointer. */
async function confirmedPublicationSource(
  sql: Sql,
  execution: V2Execution,
): Promise<{
  latestPublisherAcceptanceOrder: number;
  endpointUid: string | null;
  hostnames: readonly string[];
} | null> {
  const pending = await sql.query(
    `SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
     WHERE r.form_url IN (?, ?) AND r.principal = ? AND r.space = ?
       AND r.target_key = ? AND op.status IN ('queued', 'running', 'waiting_input', 'reconciling')
       AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ? LIMIT 1`,
    [
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      execution.principal,
      execution.space,
      execution.targetKey,
      execution.resourceUid,
    ],
  );
  if (pending.length !== 0) return null;
  // Current Resource rows collapse arbitrarily many same-UID PUTs to one
  // last Operation. Include soft-deleted Endpoint rows: a confirmed DELETE
  // may own the current publication marker after its active edge is removed.
  const latest = await sql.query(
    `SELECT MAX(op.acceptance_order) AS acceptance_order
     FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
     WHERE r.form_url IN (?, ?) AND r.principal = ? AND r.space = ?
       AND r.target_key = ? AND op.status = 'succeeded' AND op.effect = 'complete'
       AND json_extract(r.spec_json, '$.worker.resourceUid') = ?`,
    [
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
      execution.principal,
      execution.space,
      execution.targetKey,
      execution.resourceUid,
    ],
  );
  const latestPublisherAcceptanceOrder = latest[0]?.acceptance_order;
  if (
    typeof latestPublisherAcceptanceOrder !== "number" ||
    !Number.isSafeInteger(latestPublisherAcceptanceOrder) ||
    latestPublisherAcceptanceOrder <= 0
  )
    return null;
  const endpointRows = await sql.query(
    `SELECT r.uid, r.principal, r.space, r.target_key, r.generation,
       r.observed_generation, r.phase, r.busy_operation, r.last_operation,
       r.spec_json, r.observed_json, r.output_json,
       op.id AS operation_id, op.status AS operation_status,
       op.effect AS operation_effect, op.action AS operation_action,
       op.accepted_spec_json
     FROM tf_v2_resources r
     LEFT JOIN tf_v2_operations op ON op.id = r.last_operation
     WHERE r.form_url = ? AND r.deleted_at IS NULL
       AND json_extract(r.spec_json, '$.worker.resourceUid') = ? LIMIT 2`,
    [WORKER_ENDPOINT_FORM_URL, execution.resourceUid],
  );
  if (endpointRows.length > 1) return null;
  let hostname: string | null = null;
  const endpoint = endpointRows[0];
  if (endpoint) {
    if (
      endpoint.principal !== execution.principal ||
      endpoint.space !== execution.space ||
      endpoint.target_key !== execution.targetKey ||
      endpoint.generation !== endpoint.observed_generation ||
      endpoint.phase !== "idle" ||
      endpoint.busy_operation !== null ||
      endpoint.operation_id !== endpoint.last_operation ||
      endpoint.operation_status !== "succeeded" ||
      endpoint.operation_effect !== "complete" ||
      (endpoint.operation_action !== "create" && endpoint.operation_action !== "update") ||
      endpoint.spec_json !== endpoint.accepted_spec_json ||
      typeof endpoint.spec_json !== "string" ||
      typeof endpoint.observed_json !== "string" ||
      typeof endpoint.output_json !== "string"
    ) {
      return null;
    }
    const spec = parseWorkerEndpointSpec(JSON.parse(endpoint.spec_json));
    const observed: unknown = JSON.parse(endpoint.observed_json);
    const output: unknown = JSON.parse(endpoint.output_json);
    if (
      spec.worker.resourceUid !== execution.resourceUid ||
      !observed ||
      typeof observed !== "object" ||
      Array.isArray(observed) ||
      (observed as Record<string, unknown>).tlsReady !== true ||
      (observed as Record<string, unknown>).activeDeploymentRouteReady !== true ||
      !output ||
      typeof output !== "object" ||
      Array.isArray(output)
    ) {
      return null;
    }
    const address = output as Record<string, unknown>;
    if (
      typeof address.hostname !== "string" ||
      address.hostname.length === 0 ||
      address.url !== `https://${address.hostname}/`
    ) {
      return null;
    }
    const [edge, sealed] = await Promise.all([
      sql.query(
        `SELECT 1 FROM tf_v2_resource_references
         WHERE target_uid = ? AND referrer_uid = ? LIMIT 1`,
        [execution.resourceUid, endpoint.uid as string],
      ),
      sql.query(
        `SELECT refs.target_uid, refs.form_url, refs.readiness,
           refs.target_spec_path, refs.target_spec_equals
         FROM tf_v2_operation_reference_sets set_row
         JOIN tf_v2_operation_references refs ON refs.operation_id = set_row.operation_id
         WHERE set_row.operation_id = ? AND set_row.sealed = 1 LIMIT 2`,
        [endpoint.operation_id as string],
      ),
    ]);
    if (
      edge.length !== 1 ||
      sealed.length !== 1 ||
      sealed[0]?.target_uid !== execution.resourceUid ||
      sealed[0]?.form_url !== MODULE_WORKER_FORM_URL ||
      sealed[0]?.readiness !== "observed" ||
      sealed[0]?.target_spec_path !== null ||
      sealed[0]?.target_spec_equals !== null
    ) {
      return null;
    }
    hostname = address.hostname;
  }
  return {
    latestPublisherAcceptanceOrder,
    endpointUid: typeof endpoint?.uid === "string" ? endpoint.uid : null,
    hostnames: hostname ? [hostname] : [],
  };
}

/** A point lookup binds the owner marker to the durable accepted Operation order. */
async function isCurrentPublisher(
  sql: Sql,
  execution: V2Execution,
  target: V2WorkerServingTarget,
  sourceOperationId: string,
): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
     WHERE op.id = ? AND op.acceptance_order = ? AND op.status = 'succeeded'
       AND op.effect = 'complete' AND op.principal = ? AND op.target_key = ?
       AND r.last_operation = op.id AND r.principal = ? AND r.space = ?
       AND r.target_key = ?
       AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?
       AND ((r.form_url = ? AND r.uid = ? AND op.action IN ('create', 'update'))
         OR (r.form_url = ? AND
           ((? IS NULL AND op.action = 'delete') OR
            (r.uid = ? AND r.deleted_at IS NULL AND op.action IN ('create', 'update')))))
     LIMIT 1`,
    [
      sourceOperationId,
      target.latestPublisherAcceptanceOrder,
      execution.principal,
      execution.targetKey,
      execution.principal,
      execution.space,
      execution.targetKey,
      execution.resourceUid,
      WORKER_DEPLOYMENT_FORM_URL,
      target.deploymentUid,
      WORKER_ENDPOINT_FORM_URL,
      target.endpointUid,
      target.endpointUid,
    ],
  );
  return rows.length === 1;
}

/** SQL establishes the confirmed graph; live Host admission is checked later. */
async function confirmedModuleObservation(
  sql: Sql,
  execution: V2Execution,
): Promise<ModuleGraph | null> {
  const rows = await sql.query(
    `SELECT d.uid, d.principal, d.space, d.backend_id, d.target_key, d.generation,
       d.observed_generation, d.phase, d.busy_operation, d.deleted_at,
       d.spec_json, d.observed_json, d.last_operation,
       op.id AS operation_id, op.principal AS operation_principal,
       op.backend_id AS operation_backend_id, op.target_key AS operation_target_key,
       op.generation AS operation_generation, op.action AS operation_action,
       op.status AS operation_status, op.effect AS operation_effect,
       op.accepted_spec_json
     FROM tf_v2_resource_references edge
     JOIN tf_v2_resources d ON d.uid = edge.referrer_uid
     LEFT JOIN tf_v2_operations op ON op.id = d.last_operation
     WHERE edge.target_uid = ? AND d.form_url = ? ORDER BY d.uid LIMIT 2`,
    [execution.resourceUid, WORKER_DEPLOYMENT_FORM_URL],
  );
  if (rows.length > 1) return null;
  let activeDeploymentUid: string | null = null;
  let servingTarget: V2WorkerServingTarget | null = null;
  for (const row of rows) {
    if (
      typeof row.uid !== "string" ||
      row.principal !== execution.principal ||
      row.space !== execution.space ||
      row.target_key !== execution.targetKey ||
      row.deleted_at !== null ||
      row.phase !== "idle" ||
      row.busy_operation !== null ||
      row.generation !== row.observed_generation ||
      row.operation_id !== row.last_operation ||
      row.operation_principal !== execution.principal ||
      row.operation_backend_id !== row.backend_id ||
      row.operation_target_key !== execution.targetKey ||
      row.operation_generation !== row.generation ||
      (row.operation_action !== "create" && row.operation_action !== "update") ||
      row.operation_status !== "succeeded" ||
      row.operation_effect !== "complete" ||
      row.spec_json !== row.accepted_spec_json ||
      typeof row.spec_json !== "string" ||
      typeof row.observed_json !== "string"
    ) {
      return null;
    }
    const spec = parseWorkerDeploymentSpec(JSON.parse(row.spec_json));
    const observed: unknown = JSON.parse(row.observed_json);
    if (
      spec.worker.resourceUid !== execution.resourceUid ||
      !observed ||
      typeof observed !== "object" ||
      Array.isArray(observed)
    ) {
      return null;
    }
    const state = observed as Record<string, unknown>;
    if (
      typeof state.ready !== "boolean" ||
      typeof state.active !== "boolean" ||
      !Array.isArray(state.selectedVersions) ||
      state.selectedVersions.length !== spec.versions.length
    ) {
      return null;
    }
    const selected = [...state.selectedVersions].sort((a, b) =>
      String(a?.resourceUid).localeCompare(String(b?.resourceUid)),
    );
    if (
      selected.some((version, index) => {
        if (!version || typeof version !== "object" || Array.isArray(version)) return true;
        const expected = spec.versions[index];
        return (
          Object.keys(version).length !== 2 ||
          version.resourceUid !== expected?.workerVersion.resourceUid ||
          version.weight !== expected?.weight
        );
      })
    ) {
      return null;
    }
    const declared = referencesForWorkerDeployment(spec);
    const [sealed, activeEdges] = await Promise.all([
      sql.query(
        `SELECT refs.target_uid, refs.form_url, refs.readiness,
           refs.target_spec_path, refs.target_spec_equals
         FROM tf_v2_operation_reference_sets set_row
         JOIN tf_v2_operation_references refs ON refs.operation_id = set_row.operation_id
         WHERE set_row.operation_id = ? AND set_row.sealed = 1 ORDER BY refs.target_uid LIMIT 10`,
        [row.operation_id as string],
      ),
      sql.query(
        `SELECT target_uid FROM tf_v2_resource_references
         WHERE referrer_uid = ? ORDER BY target_uid LIMIT 10`,
        [row.uid],
      ),
    ]);
    if (sealed.length !== declared.length || activeEdges.length !== declared.length) return null;
    for (let index = 0; index < declared.length; index += 1) {
      const expected = declared[index];
      const actual = sealed[index];
      if (
        !expected ||
        !actual ||
        actual.target_uid !== expected.resourceUid ||
        actual.form_url !== expected.formUrl ||
        actual.readiness !== expected.readiness ||
        actual.target_spec_path !==
          (expected.targetSpecMatch ? `$.${expected.targetSpecMatch.path.join(".")}` : null) ||
        actual.target_spec_equals !== (expected.targetSpecMatch?.equals ?? null) ||
        activeEdges[index]?.target_uid !== expected.resourceUid
      ) {
        return null;
      }
    }
    if (state.active) {
      if (!state.ready || activeDeploymentUid !== null) return null;
      activeDeploymentUid = row.uid;
      servingTarget = {
        workerResourceUid: execution.resourceUid,
        deploymentUid: row.uid,
        deploymentGeneration: row.generation as number,
        latestPublisherAcceptanceOrder: 0,
        endpointUid: null,
        hostnames: [],
        principal: execution.principal,
        space: execution.space,
        targetKey: execution.targetKey,
        versions: spec.versions.map((version) => ({
          workerVersionUid: version.workerVersion.resourceUid,
          weight: version.weight,
        })),
      };
    }
  }
  if (activeDeploymentUid !== null) {
    const publication = await confirmedPublicationSource(sql, execution);
    if (!publication || !servingTarget) return null;
    servingTarget = { ...servingTarget, ...publication };
  }
  return {
    observed: { activeDeploymentUid, ready: activeDeploymentUid !== null },
    servingTarget,
  };
}

async function retired(
  sql: Sql,
  observeRetired: V2WorkerRetirementReader["observeRetired"],
  execution: V2Execution,
  workerUid: string,
  kind: V2WorkerRetirementTarget["kind"],
): Promise<boolean> {
  if (
    !(await currentClaim(sql, execution)) ||
    !(await noInboundReferences(sql, execution.resourceUid))
  ) {
    return false;
  }
  const target: V2WorkerRetirementTarget = Object.freeze({
    kind,
    workerUid,
    versionUid: kind === "version" ? execution.resourceUid : null,
    operationId: execution.operationId,
    resourceUid: execution.resourceUid,
    principal: execution.principal,
    space: execution.space,
    targetKey: execution.targetKey,
    backendId: execution.backendId,
    backendKey: execution.backendKey,
    generation: execution.generation,
  });
  const expectedTarget = canonicalJson(target);
  const proof = await observeRetired(target);
  return (
    proof.kind === "retired" &&
    proof.scope === "all_incarnations_and_contexts" &&
    typeof proof.receipt === "string" &&
    proof.receipt.length > 0 &&
    canonicalJson(proof.target) === expectedTarget &&
    (await noInboundReferences(sql, execution.resourceUid)) &&
    (await currentClaim(sql, execution))
  );
}

function validated<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof WorkerFormValidationError) {
      throw new TakoformV2Error(error.code, 422);
    }
    throw error;
  }
}

/**
 * Internal identity-only management backend. No runtime is allocated by a
 * ModuleWorker CREATE. Once other Resources refer to it, this backend cannot
 * re-derive active serving state from a bare Worker Operation and stays unknown
 * instead of refreshing a previous observation as if it were current.
 */
export function createInternalV2ModuleWorkerForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly retirement: V2WorkerRetirementReader;
  readonly serving: V2WorkerServingReader;
}): V2Form {
  if (
    !options.targetKey ||
    !options.retirement?.observeRetired ||
    !options.serving?.observeServing
  ) {
    throw new TypeError("ModuleWorker requires targetKey, retirement and serving readers");
  }
  const { sql, targetKey } = options;
  const observeRetired = options.retirement.observeRetired.bind(options.retirement);
  const observeServing = options.serving.observeServing.bind(options.serving);

  async function manage(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== MODULE_WORKER_FORM_URL ||
      execution.targetKey !== targetKey ||
      execution.backendId !== MODULE_WORKER_LIFECYCLE_BACKEND_ID
    ) {
      return unresolved();
    }
    if (execution.action === "delete") {
      try {
        return (await retired(sql, observeRetired, execution, execution.resourceUid, "worker"))
          ? { kind: "complete", observed: {}, output: {} }
          : unresolved();
      } catch {
        return unresolved();
      }
    }
    try {
      parseModuleWorkerSpec(execution.spec);
      if (!(await currentClaim(sql, execution))) return unresolved();
      const before = await confirmedModuleObservation(sql, execution);
      if (!before) return unresolved();
      let sourceOperationId: string | null = null;
      if (before.servingTarget) {
        const target = before.servingTarget;
        const proof = await observeServing(
          Object.freeze({
            workerResourceUid: target.workerResourceUid,
            targetKey: target.targetKey,
          }),
        );
        if (
          proof.kind !== "serving" ||
          proof.workerResourceUid !== target.workerResourceUid ||
          proof.targetKey !== target.targetKey ||
          proof.generation !== `takoserver-v2-operation:${proof.sourceOperationId}` ||
          canonicalJson(proof.hostnames) !== canonicalJson(target.hostnames) ||
          canonicalJson(proof.versions) !== canonicalJson(target.versions)
        ) {
          return unresolved();
        }
        sourceOperationId = proof.sourceOperationId;
      }
      const after = await confirmedModuleObservation(sql, execution);
      if (!after || canonicalJson(after) !== canonicalJson(before)) return unresolved();
      if (
        before.servingTarget &&
        (!sourceOperationId ||
          !(await isCurrentPublisher(sql, execution, before.servingTarget, sourceOperationId)))
      ) {
        return unresolved();
      }
      if (!(await currentClaim(sql, execution))) return unresolved();
      return {
        kind: "complete",
        observed: after.observed,
        output: {},
      };
    } catch {
      return unresolved();
    }
  }

  return {
    validateCreate(spec) {
      validated(() => parseModuleWorkerSpec(spec));
    },
    validateUpdate(previous, spec) {
      validated(() => validateModuleWorkerUpdate(previous, spec));
    },
    serializeUpdatesWithPendingReferrers: true,
    rejectDeleteWhileReferenced: true,
    backend: {
      id: MODULE_WORKER_LIFECYCLE_BACKEND_ID,
      targetKey,
      execute: manage,
      reconcile: manage,
    },
  };
}

function staticOnly(spec: WorkerVersionSpec): WorkerVersionSpec {
  // Keep the existing backend explicitly static-only. Code eligibility has a
  // separate internal constructor and backend identity.
  if (spec.bundle !== undefined) throw new TakoformV2Error("capability_required", 422);
  return spec;
}

function codeOnly(
  spec: WorkerVersionSpec,
  configuredInputs: boolean,
  queueSettlement: V2CodeQueueSettlementBoot | undefined,
  sqliteBinding: V2CodeSqliteBindingBoot | undefined,
  objectBucketBinding: V2CodeObjectBucketBindingBoot | undefined,
): WorkerVersionSpec {
  if (
    !spec.bundle ||
    spec.handlers.some(
      (handler) => handler !== "fetch" && handler !== "scheduled" && handler !== "queue",
    ) ||
    (spec.handlers.includes("queue") && !queueSettlement) ||
    (spec.requiredSensitiveVars.length > 0 && !configuredInputs) ||
    spec.kvBindings.length > 0 ||
    (spec.sqliteBindings.length > 0 && !sqliteBinding) ||
    (spec.bucketBindings.length > 0 && !objectBucketBinding) ||
    spec.queueProducerBindings.length > 0 ||
    spec.actorBindings.length > 0 ||
    spec.workflowBindings.length > 0
  ) {
    throw new TakoformV2Error("capability_required", 422);
  }
  return spec;
}

type ConfiguredInputSealer = ReturnType<typeof createV2WorkerVersionConfiguredInputSealer>;

/** The initialized Host-private Queue plane shared with the native owner. */
export interface V2CodeQueueSettlementBoot {
  readonly address: string;
  queueIdForUid(queueUid: string): string;
  bindingToken(input: {
    readonly workerUid: string;
    readonly versionId: string;
    readonly incarnationId: string;
  }): string;
}

/** The initialized Host-private SQLite broker and current-binding authority. */
export interface V2CodeSqliteBindingBoot {
  readonly address: string;
  issueGrant(grant: V2SqliteBindingGrant): string;
  resolveCurrentBinding(
    claim: SQLiteWorkerBindingClaim,
    binding: string,
  ): Promise<{ readonly resourceUid: string; readonly vector: string } | null>;
}

/**
 * Exact Host-private ObjectBucket broker and Core reader shared with publication.
 * A declaration alone cannot pass WorkerVersion validation without this port.
 */
export interface V2CodeObjectBucketBindingBoot {
  readonly address: string;
  issueGrant(grant: ObjectBucketWorkerBindingClaim): string;
  resolveCurrentBucketBinding(
    claim: ObjectBucketWorkerBindingClaim,
    binding: string,
  ): Promise<{
    readonly identity: {
      readonly targetKey: string;
      readonly principal: string;
      readonly space: string;
      readonly resourceUid: string;
    };
    readonly vector: string;
  } | null>;
}

function validQueueSettlementBoot(value: V2CodeQueueSettlementBoot): boolean {
  if (!value || typeof value.address !== "string") return false;
  const port = value.address.slice(value.address.lastIndexOf(":") + 1);
  return (
    /^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(value.address) &&
    Number(port) <= 65_535 &&
    typeof value.queueIdForUid === "function" &&
    typeof value.bindingToken === "function"
  );
}

function validSqliteBindingBoot(value: V2CodeSqliteBindingBoot): boolean {
  if (!value || typeof value.address !== "string") return false;
  const port = value.address.slice(value.address.lastIndexOf(":") + 1);
  return (
    /^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(value.address) &&
    Number(port) <= 65_535 &&
    typeof value.issueGrant === "function" &&
    typeof value.resolveCurrentBinding === "function"
  );
}

function validObjectBucketBindingBoot(value: V2CodeObjectBucketBindingBoot): boolean {
  if (!value || typeof value.address !== "string") return false;
  const port = value.address.slice(value.address.lastIndexOf(":") + 1);
  return (
    /^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(value.address) &&
    Number(port) <= 65_535 &&
    typeof value.issueGrant === "function" &&
    typeof value.resolveCurrentBucketBinding === "function"
  );
}

async function resolvedSqliteBindings(
  sql: Sql,
  spec: WorkerVersionSpec,
  identity: { readonly principal: string; readonly space: string; readonly targetKey: string },
): Promise<readonly V2ResolvedSqliteBinding[] | null> {
  const resolved: V2ResolvedSqliteBinding[] = [];
  for (const binding of spec.sqliteBindings) {
    const rows = await sql.query(
      `SELECT r.spec_json, r.observed_json FROM tf_v2_resources r
       JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.accepted_spec_json = r.spec_json`,
      [
        binding.resource.resourceUid,
        SQLITE_DATABASE_FORM_URL,
        identity.principal,
        identity.space,
        identity.targetKey,
      ],
    );
    const row = rows.length === 1 ? rows[0] : null;
    if (typeof row?.spec_json !== "string" || typeof row.observed_json !== "string") return null;
    try {
      parseSQLiteDatabaseSpec(JSON.parse(row.spec_json));
      if (JSON.parse(row.observed_json)?.databaseExists !== true) return null;
    } catch {
      return null;
    }
    resolved.push({ name: binding.name, resourceUid: binding.resource.resourceUid });
  }
  return resolved;
}

/**
 * A Bucket declaration is usable only after the exact same-target UID is
 * durably observed by the ObjectBucket Form. The sealed Version references
 * and this observation are then fenced by publicationState.stillCurrent().
 */
async function resolvedObjectBucketBindings(
  sql: Sql,
  spec: WorkerVersionSpec,
  identity: { readonly principal: string; readonly space: string; readonly targetKey: string },
): Promise<readonly V2ResolvedObjectBucketBinding[] | null> {
  const resolved: V2ResolvedObjectBucketBinding[] = [];
  for (const binding of spec.bucketBindings) {
    const rows = await sql.query(
      `SELECT r.spec_json, r.observed_json, r.output_json, r.backend_id
       FROM tf_v2_resources r JOIN tf_v2_operations op ON op.id = r.last_operation
       WHERE r.uid = ? AND r.form_url = ? AND r.principal = ? AND r.space = ?
         AND r.target_key = ? AND r.deleted_at IS NULL AND r.busy_operation IS NULL
         AND r.phase = 'idle' AND r.observed_generation = r.generation
         AND r.backend_id = ? AND op.resource_uid = r.uid AND op.principal = r.principal
         AND op.backend_id = r.backend_id AND op.target_key = r.target_key
         AND op.generation = r.generation AND op.status = 'succeeded'
         AND op.effect = 'complete' AND op.action IN ('create', 'update')
         AND op.accepted_spec_json = r.spec_json`,
      [
        binding.resource.resourceUid,
        OBJECT_BUCKET_FORM_URL,
        identity.principal,
        identity.space,
        identity.targetKey,
        OBJECT_BUCKET_BACKEND_ID,
      ],
    );
    const row = rows.length === 1 ? rows[0] : null;
    if (
      typeof row?.spec_json !== "string" ||
      typeof row.observed_json !== "string" ||
      typeof row.output_json !== "string" ||
      row.backend_id !== OBJECT_BUCKET_BACKEND_ID
    ) {
      return null;
    }
    try {
      parseObjectBucketSpec(JSON.parse(row.spec_json));
      if (
        canonicalJson(JSON.parse(row.observed_json)) !==
          canonicalJson({ bucketExists: true, ...OBJECT_BUCKET_LIMITS }) ||
        canonicalJson(JSON.parse(row.output_json)) !== "{}"
      ) {
        return null;
      }
    } catch {
      return null;
    }
    resolved.push({ name: binding.name, resourceUid: binding.resource.resourceUid });
  }
  return resolved;
}

/** Existing Core UID custody is injected; this runtime never reinterprets its row authority. */
export interface V2CodeConfiguredInputCustody {
  read(identity: {
    readonly principal: string;
    readonly space: string;
    readonly name: string;
    readonly form: string;
    readonly resourceUid: string;
  }): Promise<V2WorkerVersionSealedInputs | null>;
}

/** Resource-owned ciphertext read. A publication SQL vector must fence every await. */
export interface V2CodeConfiguredInputReader {
  read(input: {
    readonly resourceUid: string;
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
    readonly spec: WorkerVersionSpec;
    stillCurrent(): Promise<boolean>;
  }): Promise<Readonly<Record<string, string>> | null>;
}

export function createV2CodeConfiguredInputReader(options: {
  readonly sql: Sql;
  readonly sealer: ConfiguredInputSealer;
  readonly custody: V2CodeConfiguredInputCustody;
}): V2CodeConfiguredInputReader {
  if (!options.sealer?.open || !options.custody?.read)
    throw new TypeError("configured input sealer and custody reader are required");
  const { sql } = options;
  const open = options.sealer.open.bind(options.sealer);
  const readConfigured = options.custody.read.bind(options.custody);
  return {
    async read(input) {
      let expected: WorkerVersionSpec;
      const resourceUid = input.resourceUid;
      const principal = input.principal;
      const space = input.space;
      const targetKey = input.targetKey;
      const stillCurrent = input.stillCurrent;
      try {
        expected = parseWorkerVersionSpec(structuredClone(input.spec));
      } catch {
        return null;
      }
      if (expected.requiredSensitiveVars.length === 0 || !(await stillCurrent())) return null;
      const row = (
        await sql.query(
          `SELECT name, spec_json FROM tf_v2_resources
           WHERE uid = ? AND principal = ? AND space = ? AND target_key = ?
             AND form_url = ? AND deleted_at IS NULL`,
          [resourceUid, principal, space, targetKey, WORKER_VERSION_FORM_URL],
        )
      )[0];
      if (typeof row?.name !== "string" || typeof row.spec_json !== "string") return null;
      try {
        if (
          canonicalJson(parseWorkerVersionSpec(JSON.parse(row.spec_json))) !==
          canonicalJson(expected)
        )
          return null;
      } catch {
        return null;
      }
      const identity = {
        principal,
        space,
        name: row.name,
        form: WORKER_VERSION_FORM_URL,
        resourceUid,
        spec: expected,
      };
      const sealed = await readConfigured(identity);
      if (!sealed) return null;
      const opened = await open(identity, sealed);
      const owned = snapshotV2WorkerPrivateInputs(opened);
      if (
        !owned ||
        Object.keys(owned).length !== expected.requiredSensitiveVars.length ||
        !expected.requiredSensitiveVars.every((name) => Object.hasOwn(owned, name))
      )
        return null;
      if (!(await stillCurrent())) return null;
      return owned;
    },
  };
}

/**
 * Internal held-code eligibility for WorkerVersion. This checks whether the
 * exact accepted bundle can support the currently inspected handlers; it does
 * not publish a Deployment or authorize scheduled event delivery.
 */
type CodeWorkerVersionOptions = {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicationState: VersionState;
  readonly retirement: V2WorkerRetirementReader;
  readonly inspectModule: WorkerdRuntime["inspectModule"];
  /** Actual initialized private Queue settlement plane, also given to the native owner. */
  readonly queueSettlement?: V2CodeQueueSettlementBoot;
  /** Same initialized broker and authority given to the native owner/publication path. */
  readonly v2SqliteBinding?: V2CodeSqliteBindingBoot;
  /** Same private ObjectBucket broker and Core reader used by native publication. */
  readonly v2ObjectBucketBinding?: V2CodeObjectBucketBindingBoot;
  readonly configuredInputSealer?: ConfiguredInputSealer;
  readonly configuredInputCustody?: V2CodeConfiguredInputCustody;
};

export function createInternalV2CodeWorkerVersionForm(options: CodeWorkerVersionOptions): V2Form {
  return codeWorkerVersionForm(options, WORKER_CODE_VERSION_LIFECYCLE_BACKEND_ID);
}

function codeWorkerVersionForm(options: CodeWorkerVersionOptions, backendId: string): V2Form {
  if (
    !options.targetKey ||
    !options.publicationState?.resolveVersion ||
    !options.retirement?.observeRetired ||
    typeof options.inspectModule !== "function"
  ) {
    throw new TypeError(
      "Code WorkerVersion requires targetKey, publication state, exact retirement reader and module inspector",
    );
  }
  if (options.queueSettlement && !validQueueSettlementBoot(options.queueSettlement)) {
    throw new TypeError("Code WorkerVersion requires a valid private Queue settlement boot");
  }
  if (options.v2SqliteBinding && !validSqliteBindingBoot(options.v2SqliteBinding)) {
    throw new TypeError("Code WorkerVersion requires a valid private SQLite binding boot");
  }
  if (
    options.v2ObjectBucketBinding &&
    !validObjectBucketBindingBoot(options.v2ObjectBucketBinding)
  ) {
    throw new TypeError("Code WorkerVersion requires a valid private ObjectBucket binding boot");
  }
  const { sql, targetKey } = options;
  const queueSettlement = options.queueSettlement;
  const sqliteBinding = options.v2SqliteBinding;
  const objectBucketBinding = options.v2ObjectBucketBinding;
  const resolveVersion = options.publicationState.resolveVersion.bind(options.publicationState);
  const observeRetired = options.retirement.observeRetired.bind(options.retirement);
  const inspectModule = options.inspectModule;
  const configuredInputSealer = options.configuredInputSealer;
  if (configuredInputSealer && !options.configuredInputCustody) {
    throw new TypeError("configured input custody reader is required");
  }
  const configuredInputReader = configuredInputSealer
    ? createV2CodeConfiguredInputReader({
        sql,
        sealer: configuredInputSealer,
        custody: options.configuredInputCustody as V2CodeConfiguredInputCustody,
      })
    : null;
  const sealConfigured = configuredInputSealer?.seal.bind(configuredInputSealer);
  const openConfigured = configuredInputSealer?.open.bind(configuredInputSealer);
  const compareConfigured = configuredInputSealer?.compare.bind(configuredInputSealer);

  async function manage(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_VERSION_FORM_URL ||
      execution.targetKey !== targetKey ||
      execution.backendId !== backendId
    ) {
      return unresolved();
    }
    if (execution.action === "delete") {
      try {
        const spec = codeOnly(
          parseWorkerVersionSpec(execution.spec),
          configuredInputSealer !== undefined,
          queueSettlement,
          sqliteBinding,
          objectBucketBinding,
        );
        return (await retired(sql, observeRetired, execution, spec.worker.resourceUid, "version"))
          ? { kind: "complete", observed: {}, output: {} }
          : unresolved();
      } catch {
        return unresolved();
      }
    }
    try {
      const spec = codeOnly(
        parseWorkerVersionSpec(execution.spec),
        configuredInputSealer !== undefined,
        queueSettlement,
        sqliteBinding,
        objectBucketBinding,
      );
      if (!(await currentClaim(sql, execution))) return unresolved();
      const resolution = await resolveVersion({ execution });
      if (resolution.kind !== "ready") return unresolved();
      const { snapshot } = resolution;
      if (
        snapshot.sourceOperationId !== execution.operationId ||
        snapshot.worker.uid !== spec.worker.resourceUid ||
        snapshot.worker.principal !== execution.principal ||
        snapshot.worker.space !== execution.space ||
        snapshot.version.uid !== execution.resourceUid ||
        snapshot.version.generation !== execution.generation ||
        canonicalJson(snapshot.version.spec) !== canonicalJson(spec)
      ) {
        return unresolved();
      }
      const materials = await resolution.readMaterials();
      const configuredPrivateInputs =
        spec.requiredSensitiveVars.length > 0
          ? await configuredInputReader?.read({
              resourceUid: snapshot.version.uid,
              principal: snapshot.worker.principal,
              space: snapshot.worker.space,
              targetKey: execution.targetKey,
              spec: snapshot.version.spec,
              stillCurrent: resolution.stillCurrent,
            })
          : undefined;
      if (spec.requiredSensitiveVars.length > 0 && !configuredPrivateInputs) return unresolved();
      const resolvedServiceBindings = await projectV2ResolvedServiceBindings(
        snapshot.version.spec.serviceBindings,
      );
      const resolvedSQLite =
        spec.sqliteBindings.length > 0
          ? await resolvedSqliteBindings(sql, snapshot.version.spec, {
              principal: execution.principal,
              space: execution.space,
              targetKey: execution.targetKey,
            })
          : [];
      if (resolvedSQLite === null) return unresolved();
      const resolvedBuckets =
        spec.bucketBindings.length > 0
          ? await resolvedObjectBucketBindings(sql, snapshot.version.spec, {
              principal: execution.principal,
              space: execution.space,
              targetKey: execution.targetKey,
            })
          : [];
      if (resolvedBuckets === null) return unresolved();
      await inspectV2WorkerCodeVersionEligibility({
        workerResourceUid: snapshot.worker.uid,
        ...(spec.bundle ? { bundleResourceUid: spec.bundle.resourceUid } : {}),
        ...(spec.assets ? { assetResourceUid: spec.assets.bundle.resourceUid } : {}),
        spec: snapshot.version.spec,
        bundle: materials.bundle,
        assets: materials.assets,
        inspectModule,
        ...(configuredPrivateInputs ? { privateInputs: configuredPrivateInputs } : {}),
        ...(resolvedServiceBindings.length > 0 ? { resolvedServiceBindings } : {}),
        ...(resolvedSQLite.length > 0 ? { resolvedSqliteBindings: resolvedSQLite } : {}),
        ...(resolvedBuckets.length > 0 ? { resolvedObjectBucketBindings: resolvedBuckets } : {}),
      });
      if (!(await resolution.stillCurrent()) || !(await currentClaim(sql, execution))) {
        return unresolved();
      }
      return {
        kind: "complete",
        observed: { ready: true, resolvedBindings: true, bundleVerified: true },
        output: {},
      };
    } catch {
      return unresolved();
    }
  }

  return {
    validateCreate(spec) {
      codeOnly(
        validated(() => parseWorkerVersionSpec(spec)),
        configuredInputSealer !== undefined,
        queueSettlement,
        sqliteBinding,
        objectBucketBinding,
      );
    },
    validateUpdate(previous, spec) {
      codeOnly(
        validated(() => validateWorkerVersionUpdate(previous, spec)),
        configuredInputSealer !== undefined,
        queueSettlement,
        sqliteBinding,
        objectBucketBinding,
      );
    },
    references(spec) {
      return referencesForWorkerVersion(
        codeOnly(
          validated(() => parseWorkerVersionSpec(spec)),
          configuredInputSealer !== undefined,
          queueSettlement,
          sqliteBinding,
          objectBucketBinding,
        ),
      );
    },
    ...(configuredInputSealer
      ? {
          privateInputs: {
            validateCreate(spec: JsonObject, inputs: Readonly<Record<string, string>> | undefined) {
              const names = parseWorkerVersionSpec(spec).requiredSensitiveVars;
              const owned = snapshotV2WorkerPrivateInputs(inputs);
              if (
                owned === null ||
                (names.length > 0 && !owned) ||
                (owned !== undefined &&
                  (Object.keys(owned).length !== names.length ||
                    !names.every((name) => Object.hasOwn(owned, name))))
              ) {
                throw new TakoformV2Error("invalid_spec", 422);
              }
            },
            validateUpdate(
              _previousSpec: JsonObject,
              spec: JsonObject,
              inputs: Readonly<Record<string, string>> | undefined,
            ) {
              if (inputs === undefined) return;
              const names = parseWorkerVersionSpec(spec).requiredSensitiveVars;
              const owned = snapshotV2WorkerPrivateInputs(inputs);
              if (
                !owned ||
                Object.keys(owned).length !== names.length ||
                !names.every((name) => Object.hasOwn(owned, name))
              ) {
                throw new TakoformV2Error("invalid_spec", 422);
              }
            },
            async prepareCreate(input: {
              readonly principal: string;
              readonly space: string;
              readonly name: string;
              readonly form: string;
              readonly resourceUid: string;
              readonly spec: JsonObject;
              readonly privateInputs: Readonly<Record<string, string>> | undefined;
            }) {
              const spec = parseWorkerVersionSpec(input.spec);
              if (spec.requiredSensitiveVars.length === 0) return null;
              if (!sealConfigured) throw new TypeError("configured input sealer is unavailable");
              return await sealConfigured(
                {
                  principal: input.principal,
                  space: input.space,
                  name: input.name,
                  form: input.form,
                  resourceUid: input.resourceUid,
                  spec,
                },
                input.privateInputs,
              );
            },
            async prepareUpdate(input: {
              readonly principal: string;
              readonly space: string;
              readonly name: string;
              readonly form: string;
              readonly resourceUid: string;
              readonly spec: JsonObject;
              readonly privateInputs: Readonly<Record<string, string>> | undefined;
              readonly configured: {
                readonly keyId: string;
                readonly nonce: string;
                readonly ciphertext: string;
              } | null;
            }) {
              const spec = parseWorkerVersionSpec(input.spec);
              if (spec.requiredSensitiveVars.length === 0) {
                const emptyInputs = snapshotV2WorkerPrivateInputs(input.privateInputs);
                if (
                  input.configured ||
                  emptyInputs === null ||
                  (emptyInputs !== undefined && Object.keys(emptyInputs).length > 0)
                )
                  throw new TakoformV2Error("invalid_spec", 422);
                return;
              }
              if (!input.configured) throw new TakoformV2Error("private_inputs_unverifiable", 409);
              const identity = {
                principal: input.principal,
                space: input.space,
                name: input.name,
                form: input.form,
                resourceUid: input.resourceUid,
                spec,
              };
              if (input.privateInputs === undefined) {
                if (!(await openConfigured?.(identity, input.configured))) {
                  throw new TakoformV2Error("private_inputs_unverifiable", 409);
                }
                return;
              }
              const comparison = await compareConfigured?.(
                identity,
                input.configured,
                input.privateInputs,
              );
              if (comparison === "unavailable")
                throw new TakoformV2Error("private_inputs_unverifiable", 409);
              if (comparison === "mismatched") throw new TakoformV2Error("invalid_spec", 422);
            },
          },
        }
      : {}),
    rejectDeleteWhileReferenced: true,
    backend: {
      id: backendId,
      targetKey,
      execute: manage,
      reconcile: manage,
    },
  };
}

/**
 * Internal static-only Version eligibility. This does not publish a Deployment
 * or make a Form support claim. The resolver owns accepted SQL references and
 * held-byte custody; the projection checks the asset serving snapshot.
 */
type StaticWorkerVersionOptions = {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicationState: VersionState;
  readonly retirement: V2WorkerRetirementReader;
};

export function createInternalV2StaticWorkerVersionForm(
  options: StaticWorkerVersionOptions,
): V2Form {
  return staticWorkerVersionForm(options, WORKER_VERSION_LIFECYCLE_BACKEND_ID);
}

function staticWorkerVersionForm(options: StaticWorkerVersionOptions, backendId: string): V2Form {
  if (
    !options.targetKey ||
    !options.publicationState?.resolveVersion ||
    !options.retirement?.observeRetired
  ) {
    throw new TypeError(
      "WorkerVersion requires targetKey, publication state and exact retirement reader",
    );
  }
  const { sql, targetKey } = options;
  const resolveVersion = options.publicationState.resolveVersion.bind(options.publicationState);
  const observeRetired = options.retirement.observeRetired.bind(options.retirement);

  async function manage(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_VERSION_FORM_URL ||
      execution.targetKey !== targetKey ||
      execution.backendId !== backendId
    ) {
      return unresolved();
    }
    if (execution.action === "delete") {
      try {
        const spec = parseWorkerVersionSpec(execution.spec);
        return (await retired(sql, observeRetired, execution, spec.worker.resourceUid, "version"))
          ? { kind: "complete", observed: {}, output: {} }
          : unresolved();
      } catch {
        return unresolved();
      }
    }
    try {
      const spec = staticOnly(parseWorkerVersionSpec(execution.spec));
      const resolution = await resolveVersion({ execution });
      if (resolution.kind !== "ready") return unresolved();
      const { snapshot } = resolution;
      if (
        snapshot.sourceOperationId !== execution.operationId ||
        snapshot.worker.uid !== spec.worker.resourceUid ||
        snapshot.worker.principal !== execution.principal ||
        snapshot.worker.space !== execution.space ||
        snapshot.version.uid !== execution.resourceUid ||
        snapshot.version.generation !== execution.generation ||
        canonicalJson(snapshot.version.spec) !== canonicalJson(spec)
      ) {
        return unresolved();
      }
      const readMaterials = resolution.readMaterials.bind(resolution);
      const stillCurrent = resolution.stillCurrent.bind(resolution);
      const materials = await readMaterials();
      await projectV2StaticWorkerVersion({
        identity: {
          directory: snapshot.worker.uid,
          hostnames: [],
          generation: execution.operationId,
          workerResourceUid: snapshot.worker.uid,
          workerVersionUid: snapshot.version.uid,
          versionId: snapshot.version.uid,
          weight: 10_000,
        },
        spec: snapshot.version.spec,
        materials,
      });
      if (!(await stillCurrent())) return unresolved();
      return {
        kind: "complete",
        observed: { ready: true, resolvedBindings: true },
        output: {},
      };
    } catch {
      return unresolved();
    }
  }

  return {
    validateCreate(spec) {
      staticOnly(validated(() => parseWorkerVersionSpec(spec)));
    },
    validateUpdate(previous, spec) {
      staticOnly(validated(() => validateWorkerVersionUpdate(previous, spec)));
    },
    references(spec) {
      return referencesForWorkerVersion(staticOnly(validated(() => parseWorkerVersionSpec(spec))));
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: backendId,
      targetKey,
      execute: manage,
      reconcile: manage,
    },
  };
}

/** One internal Form identity for static, code, and code-plus-assets Versions. */
export function createInternalV2WorkerVersionForm(options: CodeWorkerVersionOptions): V2Form {
  const staticForm = staticWorkerVersionForm(options, WORKER_VERSION_UNIFIED_BACKEND_ID);
  const codeForm = codeWorkerVersionForm(options, WORKER_VERSION_UNIFIED_BACKEND_ID);
  const selected = (spec: JsonObject): V2Form =>
    Object.hasOwn(spec, "bundle") ? codeForm : staticForm;
  return {
    validateCreate(spec) {
      selected(spec).validateCreate(spec);
    },
    validateUpdate(previous, spec) {
      selected(spec).validateUpdate(previous, spec);
    },
    references(spec) {
      const form = selected(spec);
      if (!form.references) throw new TypeError("WorkerVersion references are required");
      return form.references(spec);
    },
    ...(codeForm.privateInputs ? { privateInputs: codeForm.privateInputs } : {}),
    rejectDeleteWhileReferenced: true,
    backend: {
      id: WORKER_VERSION_UNIFIED_BACKEND_ID,
      targetKey: options.targetKey,
      async execute(execution) {
        return await selected(execution.spec).backend.execute(execution);
      },
      async reconcile(execution) {
        return await selected(execution.spec).backend.reconcile(execution);
      },
    },
  };
}
