import { bytesDigest, canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import { DURABLE_WORKFLOW_FORM_URL, parseDurableWorkflowSpec } from "./forms/durable-workflow.ts";
import { referencesForWorkerVersion } from "./forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerVersionSpec,
  WORKER_VERSION_FORM_URL,
  type WorkerVersionSpec,
} from "./forms/worker-specs.ts";
import { isReadyWorkerVersionObservation } from "./forms/worker-version-observed.ts";
import { DURABLE_WORKFLOW_BACKEND_ID } from "./workflow-backend.ts";

/** Immutable native source plus the complete accepted Workflow Binding set. */
export interface V2WorkflowBindingClaim {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly nativeVersionId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

export interface V2WorkflowBindingTarget {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workflowResourceUid: string;
}

export interface V2WorkflowBindingResolution {
  readonly tenantId: string;
  readonly workflowResourceUid: string;
  readonly workerUid: string;
  readonly className: string;
  /** Semantic currentness; same-spec PUT does not rotate an admitted Binding. */
  readonly vector: string;
}

/** Accepted immutable source used by the Host's native publication identity. */
export interface V2WorkflowBindingVersionIdentitySource {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly workerVersionGeneration: number;
  readonly workflowBindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

type Row = Record<string, unknown>;
const current = (row: Row, op: Row): boolean =>
  op.resource_uid === row.uid &&
  op.principal === row.principal &&
  op.backend_id === row.backend_id &&
  op.target_key === row.target_key &&
  op.generation === row.generation &&
  op.accepted_spec_json === row.spec_json &&
  row.last_operation === op.id;

const succeeded = (row: Row, op: Row): boolean =>
  op.resource_uid === row.uid &&
  op.principal === row.principal &&
  op.backend_id === row.backend_id &&
  op.target_key === row.target_key &&
  op.generation === row.observed_generation &&
  op.accepted_spec_json === row.spec_json &&
  (op.action === "create" || op.action === "update") &&
  op.status === "succeeded" &&
  op.effect === "complete";

/** A pending same-spec PUT preserves the prior successful UID and its Binding authority. */
async function currentAndObserved(
  sql: Sql,
  row: Row,
): Promise<{ currentOp: Row; observedOp: Row } | null> {
  if (
    typeof row.uid !== "string" ||
    typeof row.last_operation !== "string" ||
    typeof row.generation !== "number" ||
    typeof row.observed_generation !== "number" ||
    row.observed_generation < 1 ||
    row.observed_generation > row.generation ||
    typeof row.spec_json !== "string"
  )
    return null;
  const latest = await sql.query("SELECT * FROM tf_v2_operations WHERE id = ?", [
    row.last_operation,
  ]);
  const currentOp = latest.length === 1 ? latest[0] : null;
  if (!currentOp || !current(row, currentOp)) return null;
  if (row.phase === "idle") {
    if (
      row.busy_operation !== null ||
      row.observed_generation !== row.generation ||
      !succeeded(row, currentOp)
    )
      return null;
    return { currentOp, observedOp: currentOp };
  }
  if (
    row.phase !== "pending" ||
    row.busy_operation !== row.last_operation ||
    row.generation <= row.observed_generation ||
    currentOp.action !== "update" ||
    !["queued", "running", "waiting_input", "reconciling"].includes(String(currentOp.status))
  )
    return null;
  const prior = await sql.query(
    `SELECT * FROM tf_v2_operations WHERE resource_uid = ? AND generation = ?
       AND action IN ('create','update') AND status = 'succeeded' AND effect = 'complete'`,
    [row.uid, row.observed_generation],
  );
  const observedOp = prior.length === 1 ? prior[0] : null;
  return observedOp && succeeded(row, observedOp) ? { currentOp, observedOp } : null;
}

async function exactReferences(
  sql: Sql,
  resourceUid: string,
  operationIds: readonly string[],
  expected: readonly {
    readonly resourceUid: string;
    readonly formUrl: string;
    readonly readiness: string;
    readonly targetSpecMatch?: { readonly path: readonly string[]; readonly equals: string };
  }[],
): Promise<boolean> {
  const expectedRows = expected.map((reference) => ({
    target_uid: reference.resourceUid,
    form_url: reference.formUrl,
    readiness: reference.readiness,
    target_spec_path: reference.targetSpecMatch
      ? `$.${reference.targetSpecMatch.path.join(".")}`
      : null,
    target_spec_equals: reference.targetSpecMatch?.equals ?? null,
  }));
  const uniqueIds = [...new Set(operationIds)];
  for (const id of uniqueIds) {
    const sets = await sql.query(
      "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
      [id],
    );
    if (sets.length !== 1 || sets[0]?.sealed !== 1) return false;
    const refs = await sql.query(
      `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
       FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid`,
      [id],
    );
    if (canonicalJson(refs) !== canonicalJson(expectedRows)) return false;
  }
  const edges = await sql.query(
    "SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ? ORDER BY target_uid",
    [resourceUid],
  );
  return (
    canonicalJson(edges) ===
    canonicalJson(expectedRows.map((reference) => ({ target_uid: reference.target_uid })))
  );
}

/** Reads only Core's accepted v2 ledger; instance data remains Workflow-owned. */
export function createV2WorkflowBindingAuthority(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  /** Host-owned identity derivation; native publication/readback is checked by the adapter. */
  readonly versionIdentity?: (source: V2WorkflowBindingVersionIdentitySource) => Promise<string>;
}) {
  if (!options?.sql || !options.targetKey)
    throw new TypeError("Workflow Binding authority is required");
  const { sql, targetKey } = options;
  const versionIdentity =
    options.versionIdentity ??
    (async (source: V2WorkflowBindingVersionIdentitySource) => {
      const digest = await bytesDigest(
        new TextEncoder().encode(
          `${source.workerVersionUid}\u0000${source.workerVersionGeneration}`,
        ),
      );
      return `v2-${digest.slice("sha256:".length)}`;
    });

  async function captureTarget(
    source: V2WorkflowBindingTarget,
  ): Promise<V2WorkflowBindingResolution | null> {
    if (source.targetKey !== targetKey) return null;
    const rows = await sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [
      source.workflowResourceUid,
    ]);
    const row = rows.length === 1 ? rows[0] : null;
    if (
      !row ||
      row.uid !== source.workflowResourceUid ||
      row.form_url !== DURABLE_WORKFLOW_FORM_URL ||
      row.principal !== source.principal ||
      row.space !== source.space ||
      row.target_key !== targetKey ||
      row.backend_id !== DURABLE_WORKFLOW_BACKEND_ID ||
      row.deleted_at !== null ||
      typeof row.spec_json !== "string"
    )
      return null;
    const state = await currentAndObserved(sql, row);
    if (!state) return null;
    const spec = parseDurableWorkflowSpec(JSON.parse(row.spec_json));
    if (
      !(await exactReferences(
        sql,
        source.workflowResourceUid,
        [String(state.currentOp.id), String(state.observedOp.id)],
        [
          {
            resourceUid: spec.worker.resourceUid,
            formUrl: MODULE_WORKER_FORM_URL,
            readiness: "observed",
          },
        ],
      ))
    )
      return null;
    const workers = await sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [
      spec.worker.resourceUid,
    ]);
    const worker = workers.length === 1 ? workers[0] : null;
    if (
      !worker ||
      worker.form_url !== MODULE_WORKER_FORM_URL ||
      worker.principal !== source.principal ||
      worker.space !== source.space ||
      worker.target_key !== targetKey ||
      worker.deleted_at !== null ||
      typeof worker.spec_json !== "string" ||
      !(await currentAndObserved(sql, worker))
    )
      return null;
    parseModuleWorkerSpec(JSON.parse(worker.spec_json));
    return {
      tenantId: source.principal,
      workflowResourceUid: source.workflowResourceUid,
      workerUid: spec.worker.resourceUid,
      className: spec.className,
      vector: canonicalJson([
        source.principal,
        source.space,
        targetKey,
        row.uid,
        row.spec_json,
        spec.worker.resourceUid,
        spec.className,
      ]),
    };
  }

  async function captureVersion(claim: V2WorkflowBindingClaim): Promise<string | null> {
    if (claim.targetKey !== targetKey) return null;
    const rows = await sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [
      claim.workerVersionUid,
    ]);
    const row = rows.length === 1 ? rows[0] : null;
    if (
      !row ||
      row.form_url !== WORKER_VERSION_FORM_URL ||
      row.principal !== claim.principal ||
      row.space !== claim.space ||
      row.target_key !== targetKey ||
      row.deleted_at !== null ||
      typeof row.backend_id !== "string" ||
      typeof row.spec_json !== "string" ||
      typeof row.observed_json !== "string"
    )
      return null;
    const state = await currentAndObserved(sql, row);
    if (!state) return null;
    const spec: WorkerVersionSpec = parseWorkerVersionSpec(JSON.parse(row.spec_json));
    if (
      !isReadyWorkerVersionObservation(JSON.parse(row.observed_json), spec.bundle !== undefined) ||
      spec.worker.resourceUid !== claim.workerUid ||
      canonicalJson(
        spec.workflowBindings.map((item) => ({
          name: item.name,
          resourceUid: item.resource.resourceUid,
        })),
      ) !== canonicalJson(claim.bindings)
    )
      return null;
    const sourceRows = await sql.query(
      `SELECT generation FROM tf_v2_operations WHERE id = ? AND resource_uid = ?
       AND principal = ? AND target_key = ? AND backend_id = ?
       AND action IN ('create','update') AND status = 'succeeded' AND effect = 'complete'
       AND accepted_spec_json = ?`,
      [
        claim.workerVersionOperationId,
        claim.workerVersionUid,
        claim.principal,
        targetKey,
        row.backend_id,
        row.spec_json,
      ],
    );
    const sourceGeneration = sourceRows.length === 1 ? sourceRows[0]?.generation : null;
    if (
      typeof sourceGeneration !== "number" ||
      !Number.isSafeInteger(sourceGeneration) ||
      sourceGeneration < 1 ||
      typeof row.observed_generation !== "number" ||
      sourceGeneration > row.observed_generation
    )
      return null;
    const expectedIdentity = await versionIdentity(
      Object.freeze({
        principal: claim.principal,
        space: claim.space,
        targetKey: claim.targetKey,
        workerUid: claim.workerUid,
        workerVersionUid: claim.workerVersionUid,
        workerVersionOperationId: claim.workerVersionOperationId,
        workerVersionGeneration: sourceGeneration,
        workflowBindings: Object.freeze(
          spec.workflowBindings.map((binding) =>
            Object.freeze({ name: binding.name, resourceUid: binding.resource.resourceUid }),
          ),
        ),
      }),
    );
    if (
      typeof expectedIdentity !== "string" ||
      !expectedIdentity ||
      claim.nativeVersionId !== expectedIdentity
    )
      return null;
    if (
      !(await exactReferences(
        sql,
        claim.workerVersionUid,
        [String(state.currentOp.id), String(state.observedOp.id), claim.workerVersionOperationId],
        referencesForWorkerVersion(spec),
      ))
    )
      return null;
    return canonicalJson([
      row.uid,
      row.spec_json,
      claim.workerVersionOperationId,
      claim.nativeVersionId,
    ]);
  }

  async function resolveTarget(
    input: V2WorkflowBindingTarget,
  ): Promise<V2WorkflowBindingResolution | null> {
    try {
      const source = { ...input };
      const before = await captureTarget(source);
      const after = before ? await captureTarget(source) : null;
      return before && after?.vector === before.vector ? after : null;
    } catch {
      return null;
    }
  }

  async function resolveCurrentBinding(
    input: V2WorkflowBindingClaim,
    bindingName: string,
  ): Promise<V2WorkflowBindingResolution | null> {
    try {
      const claim: V2WorkflowBindingClaim = {
        ...input,
        bindings: input.bindings.map((item) => ({
          name: item.name,
          resourceUid: item.resourceUid,
        })),
      };
      const chosen = claim.bindings.filter((item) => item.name === bindingName);
      if (chosen.length !== 1 || !chosen[0]) return null;
      const beforeVersion = await captureVersion(claim);
      if (!beforeVersion) return null;
      const target = await resolveTarget({
        principal: claim.principal,
        space: claim.space,
        targetKey: claim.targetKey,
        workflowResourceUid: chosen[0].resourceUid,
      });
      if (!target) return null;
      const afterVersion = await captureVersion(claim);
      const afterTarget = await resolveTarget({
        principal: claim.principal,
        space: claim.space,
        targetKey: claim.targetKey,
        workflowResourceUid: chosen[0].resourceUid,
      });
      return afterVersion === beforeVersion && afterTarget?.vector === target.vector
        ? afterTarget
        : null;
    } catch {
      return null;
    }
  }

  return Object.freeze({ resolveTarget, resolveCurrentBinding });
}
