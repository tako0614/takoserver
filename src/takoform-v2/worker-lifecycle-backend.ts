import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type { WorkerdRuntime } from "../workerd-runtime.ts";
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
import { inspectV2WorkerCodeVersionEligibility } from "./worker-code-runtime.ts";
import type { V2WorkerVersionResolution } from "./worker-publication-state.ts";
import { projectV2StaticWorkerVersion } from "./worker-static-runtime.ts";

export const MODULE_WORKER_LIFECYCLE_BACKEND_ID = "selfhost-v2-module-worker-identity-v1";
export const WORKER_VERSION_LIFECYCLE_BACKEND_ID = "selfhost-v2-static-worker-version-v1";
export const WORKER_CODE_VERSION_LIFECYCLE_BACKEND_ID = "selfhost-v2-code-worker-version-v1";

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

function codeOnly(spec: WorkerVersionSpec): WorkerVersionSpec {
  if (
    !spec.bundle ||
    spec.handlers.some((handler) => handler !== "fetch" && handler !== "scheduled") ||
    spec.requiredSensitiveVars.length > 0 ||
    spec.kvBindings.length > 0 ||
    spec.sqliteBindings.length > 0 ||
    spec.bucketBindings.length > 0 ||
    spec.queueProducerBindings.length > 0 ||
    spec.serviceBindings.length > 0 ||
    spec.actorBindings.length > 0 ||
    spec.workflowBindings.length > 0
  ) {
    throw new TakoformV2Error("capability_required", 422);
  }
  return spec;
}

/**
 * Internal held-code eligibility for WorkerVersion. This checks whether the
 * exact accepted bundle can support the currently inspected handlers; it does
 * not publish a Deployment or authorize scheduled event delivery.
 */
export function createInternalV2CodeWorkerVersionForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicationState: VersionState;
  readonly retirement: V2WorkerRetirementReader;
  readonly inspectModule: WorkerdRuntime["inspectModule"];
}): V2Form {
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
  const { sql, targetKey } = options;
  const resolveVersion = options.publicationState.resolveVersion.bind(options.publicationState);
  const observeRetired = options.retirement.observeRetired.bind(options.retirement);
  const inspectModule = options.inspectModule;

  async function manage(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_VERSION_FORM_URL ||
      execution.targetKey !== targetKey ||
      execution.backendId !== WORKER_CODE_VERSION_LIFECYCLE_BACKEND_ID
    ) {
      return unresolved();
    }
    if (execution.action === "delete") {
      try {
        const spec = codeOnly(parseWorkerVersionSpec(execution.spec));
        return (await retired(sql, observeRetired, execution, spec.worker.resourceUid, "version"))
          ? { kind: "complete", observed: {}, output: {} }
          : unresolved();
      } catch {
        return unresolved();
      }
    }
    try {
      const spec = codeOnly(parseWorkerVersionSpec(execution.spec));
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
      await inspectV2WorkerCodeVersionEligibility({
        workerResourceUid: snapshot.worker.uid,
        ...(spec.bundle ? { bundleResourceUid: spec.bundle.resourceUid } : {}),
        ...(spec.assets ? { assetResourceUid: spec.assets.bundle.resourceUid } : {}),
        spec: snapshot.version.spec,
        bundle: materials.bundle,
        assets: materials.assets,
        inspectModule,
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
      codeOnly(validated(() => parseWorkerVersionSpec(spec)));
    },
    validateUpdate(previous, spec) {
      codeOnly(validated(() => validateWorkerVersionUpdate(previous, spec)));
    },
    references(spec) {
      return referencesForWorkerVersion(codeOnly(validated(() => parseWorkerVersionSpec(spec))));
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: WORKER_CODE_VERSION_LIFECYCLE_BACKEND_ID,
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
export function createInternalV2StaticWorkerVersionForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly publicationState: VersionState;
  readonly retirement: V2WorkerRetirementReader;
}): V2Form {
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
      execution.backendId !== WORKER_VERSION_LIFECYCLE_BACKEND_ID
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
      id: WORKER_VERSION_LIFECYCLE_BACKEND_ID,
      targetKey,
      execute: manage,
      reconcile: manage,
    },
  };
}
