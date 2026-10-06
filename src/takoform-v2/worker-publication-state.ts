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
import { referencesForWorkerVersion } from "./forms/worker-references.ts";
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
        | "incumbent_unresolved";
      readonly message: string;
    };

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
    op.generation === row.generation &&
    op.status === "succeeded" &&
    op.effect === "complete" &&
    op.accepted_spec_json === row.spec_json
  );
}

function outputHostname(row: ResourceRow): { hostname: string; url: string } | null {
  const output = parseObject(row.output_json);
  const hostname = output?.hostname;
  const url = output?.url;
  return typeof hostname === "string" &&
    hostnamePattern.test(hostname) &&
    typeof url === "string" &&
    url === `https://${hostname}/`
    ? { hostname, url }
    : null;
}

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
  ): Promise<ResourceRow[]> {
    return (await sql.query(
      `SELECT * FROM tf_v2_resources
       WHERE form_url = ? AND principal = ? AND space = ? AND deleted_at IS NULL
         AND json_extract(spec_json, '$.worker.resourceUid') = ? ORDER BY uid`,
      [form, principal, space, workerUid],
    )) as unknown as ResourceRow[];
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
        !settled(target, last) ||
        !edge
      ) {
        return versionUnresolved(
          "graph_unresolved",
          "A Version reference is not current in this owner and Space",
        );
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

  async function capture(input: {
    execution: V2Execution;
    incumbentSourceOperationId?: string;
  }): Promise<Capture> {
    const { execution } = input;
    if (
      execution.form !== WORKER_DEPLOYMENT_FORM_URL &&
      execution.form !== WORKER_ENDPOINT_FORM_URL
    )
      return unresolved("graph_unresolved", "This operation is not a Worker publication");
    const [op, own] = await Promise.all([
      operation(execution.operationId),
      resource(execution.resourceUid),
    ]);
    if (!op || !own || !isCurrentClaim(op, own, execution, now().getTime())) {
      return unresolved("stale_claim", "The accepted operation lease is no longer current");
    }
    const accepted = parseObject(op.accepted_spec_json);
    if (!accepted) return unresolved("graph_unresolved", "Accepted Worker spec is unavailable");
    let workerUid: string;
    try {
      workerUid =
        execution.form === WORKER_DEPLOYMENT_FORM_URL
          ? parseWorkerDeploymentSpec(accepted).worker.resourceUid
          : parseWorkerEndpointSpec(accepted).worker.resourceUid;
    } catch {
      return unresolved("graph_unresolved", "Accepted Worker spec is invalid");
    }
    if (!uidPattern.test(workerUid)) {
      return unresolved("graph_unresolved", "Accepted Worker UID is invalid");
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

    const incumbentId = input.incumbentSourceOperationId;
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

    const pending = await pendingPublication(workerUid);
    if (!pending.some((item) => item.id === op.id)) {
      return unresolved("stale_claim", "Publication operation is no longer pending");
    }
    if (pending[0]?.id !== op.id && incumbentId !== op.id) {
      return unresolved("publication_conflict", "An earlier Worker publication is still pending");
    }

    const [deploymentRows, endpointRows] = await Promise.all([
      matchingResources(WORKER_DEPLOYMENT_FORM_URL, workerUid, op.principal, own.space),
      matchingResources(WORKER_ENDPOINT_FORM_URL, workerUid, op.principal, own.space),
    ]);
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
          ((execution.form === WORKER_DEPLOYMENT_FORM_URL && rows === deploymentRows) ||
            (execution.form === WORKER_ENDPOINT_FORM_URL && rows === endpointRows)))
      ) {
        return unresolved(
          "publication_conflict",
          "A different active Worker attachment already exists",
        );
      }
    }

    async function chosen(
      rows: readonly ResourceRow[],
      form: string,
    ): Promise<{ row: ResourceRow; accepted: JsonObject; op: OperationRow } | null | Unresolved> {
      const isOwnForm = execution.form === form;
      if (isOwnForm && execution.action === "delete") return null;
      const row = isOwnForm ? own : rows.find((candidate) => candidate.observed_generation > 0);
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
      if (!chosenOp || (!isOwnForm && !settled(row, chosenOp) && !confirmedPrior)) {
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
      if (chosenDeployment.op.id !== op.id) {
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
      if (chosenEndpoint.op.id !== op.id) {
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
      evidence.push(refRows);
      referenceSetIds.push(chosenEndpoint.op.id);
      endpoint = {
        uid: chosenEndpoint.row.uid,
        generation: chosenEndpoint.op.generation,
        spec,
        output,
      };
    }
    if (endpoint && !deployment && execution.action !== "delete") {
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
    const snapshot = freezeDeep<V2WorkerPublicationSnapshot>({
      sourceOperationId: op.id,
      worker: {
        uid: worker.uid,
        principal: worker.principal,
        space: worker.space,
        generation: worker.generation,
      },
      deployment,
      endpoint,
    });
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
    const finalNow = now().getTime();
    if (!Number.isFinite(finalNow) || op.lease_until_ms === null || op.lease_until_ms <= finalNow) {
      return unresolved("stale_claim", "The accepted operation lease expired during graph read");
    }
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
