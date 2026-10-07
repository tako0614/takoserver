import { canonicalJson } from "../json.ts";
import type { JsonObject, Row, Sql, SqlParam } from "../ports.ts";
import type { WorkerModuleSemanticInspector } from "../worker-module-inspection-contract.ts";
import type { DurableWorkflowSpec } from "./forms/durable-workflow.ts";
import { WORKER_BUNDLE_FORM_URL } from "./forms/worker-bundle.ts";
import type { WorkerBundleCustody } from "./forms/worker-bundle-backend.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerVersion,
} from "./forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "./forms/worker-specs.ts";
import {
  TakoformV2Error,
  type V2AdmissionPredicate,
  type V2ReferenceRequirement,
} from "./types.ts";
import type { V2WorkflowClassAdmission } from "./workflow-backend.ts";

type Evidence = { readonly table: string; readonly key: readonly string[]; readonly rows: Row[] };
type Version = {
  readonly uid: string;
  readonly bundleUid: string | null;
  readonly bundleSpec: JsonObject | null;
  readonly bundleObserved: JsonObject | null;
};
type Capture = {
  readonly evidence: readonly Evidence[];
  readonly versions: readonly Version[];
  readonly activeVersionUids: ReadonlySet<string>;
  readonly vector: string;
};

const busy = () => new TakoformV2Error("resource_busy", 409);
const json = (value: unknown): JsonObject => {
  if (typeof value !== "string") throw busy();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw busy();
  return parsed as JsonObject;
};
const one = async (sql: Sql, query: string, params: readonly SqlParam[]): Promise<Row> => {
  const rows = await sql.query(query, params);
  if (rows.length !== 1 || !rows[0]) throw busy();
  return rows[0];
};
const settled = (resource: Row, operation: Row): boolean =>
  resource.deleted_at === null &&
  resource.phase === "idle" &&
  resource.busy_operation === null &&
  resource.generation === resource.observed_generation &&
  resource.last_operation === operation.id &&
  operation.resource_uid === resource.uid &&
  operation.principal === resource.principal &&
  operation.backend_id === resource.backend_id &&
  operation.target_key === resource.target_key &&
  operation.generation === resource.generation &&
  operation.action !== "delete" &&
  operation.status === "succeeded" &&
  operation.effect === "complete" &&
  operation.accepted_spec_json === resource.spec_json;

function exactRows(evidence: Evidence): V2AdmissionPredicate {
  const columns = Object.keys(evidence.rows[0] ?? {});
  if (
    !/^[a-z_][a-z_0-9]*$/u.test(evidence.table) ||
    evidence.key.some((column) => !columns.includes(column)) ||
    columns.some((column) => !/^[a-z_][a-z_0-9]*$/u.test(column))
  )
    throw busy();
  if (evidence.rows.length === 0) return { sql: "1", params: [] };
  const compare = columns
    .map((column) => `actual."${column}" IS json_extract(expected.value, '$."${column}"')`)
    .join(" AND ");
  const keys = evidence.key
    .map((column) => `actual."${column}" = json_extract(expected.value, '$."${column}"')`)
    .join(" AND ");
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS
      (SELECT 1 FROM ${evidence.table} actual WHERE ${keys} AND ${compare}))`,
    params: [JSON.stringify(evidence.rows)],
  };
}

/** One short-lived accepted SQL vector, never a second Resource ledger. */
async function capture(input: {
  readonly sql: Sql;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
}): Promise<Capture> {
  const { sql } = input;
  const evidence = new Map<string, Evidence>();
  const add = (table: string, key: readonly string[], row: Row) => {
    const current = evidence.get(table) ?? { table, key, rows: [] };
    const id = key.map((column) => String(row[column])).join("\0");
    const existing = current.rows.find(
      (item) => key.map((column) => String(item[column])).join("\0") === id,
    );
    if (existing && canonicalJson(existing as JsonObject) !== canonicalJson(row as JsonObject))
      throw busy();
    if (!existing) current.rows.push(row);
    evidence.set(table, current);
  };
  const resource = async (uid: string, form: string): Promise<Row> => {
    const row = await one(sql, "SELECT * FROM tf_v2_resources WHERE uid = ?", [uid]);
    if (
      row.form_url !== form ||
      row.principal !== input.principal ||
      row.space !== input.space ||
      row.target_key !== input.targetKey ||
      row.deleted_at !== null
    )
      throw busy();
    add("tf_v2_resources", ["uid"], row);
    return row;
  };
  const operation = async (id: string): Promise<Row> => {
    const row = await one(sql, "SELECT * FROM tf_v2_operations WHERE id = ?", [id]);
    add("tf_v2_operations", ["id"], row);
    return row;
  };
  const references = async (
    operationId: string,
    referrerUid: string,
    expected: readonly V2ReferenceRequirement[],
  ): Promise<void> => {
    const set = await one(
      sql,
      "SELECT * FROM tf_v2_operation_reference_sets WHERE operation_id = ?",
      [operationId],
    );
    if (set.sealed !== 1) throw busy();
    add("tf_v2_operation_reference_sets", ["operation_id"], set);
    const actual = await sql.query(
      "SELECT * FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
      [operationId],
    );
    if (actual.length !== expected.length) throw busy();
    for (const requirement of expected) {
      const row = actual.find((candidate) => candidate.target_uid === requirement.resourceUid);
      const path = requirement.targetSpecMatch
        ? `$.${requirement.targetSpecMatch.path.join(".")}`
        : null;
      if (
        !row ||
        row.form_url !== requirement.formUrl ||
        row.readiness !== requirement.readiness ||
        row.target_spec_path !== path ||
        row.target_spec_equals !== (requirement.targetSpecMatch?.equals ?? null)
      )
        throw busy();
      add("tf_v2_operation_references", ["operation_id", "target_uid"], row);
      const edge = await one(
        sql,
        "SELECT * FROM tf_v2_resource_references WHERE target_uid = ? AND referrer_uid = ?",
        [requirement.resourceUid, referrerUid],
      );
      add("tf_v2_resource_references", ["target_uid", "referrer_uid"], edge);
    }
  };

  const worker = await resource(input.workerUid, MODULE_WORKER_FORM_URL);
  if (!settled(worker, await operation(String(worker.last_operation)))) throw busy();

  // Capture even unrelated Deployment identities so a new pending allocation
  // cannot appear between inspection and the Resource acceptance statement.
  const deployments = await sql.query(
    `SELECT * FROM tf_v2_resources WHERE form_url = ? AND principal = ?
       AND space = ? AND target_key = ? AND deleted_at IS NULL ORDER BY uid`,
    [WORKER_DEPLOYMENT_FORM_URL, input.principal, input.space, input.targetKey],
  );
  for (const row of deployments) add("tf_v2_resources", ["uid"], row);
  const versionUids = new Set<string>();
  const activeVersionUids = new Set<string>();
  for (const deployment of deployments) {
    const currentRows = await sql.query("SELECT * FROM tf_v2_operations WHERE id = ?", [
      String(deployment.last_operation),
    ]);
    const priorRows =
      typeof deployment.observed_generation === "number" && deployment.observed_generation > 0
        ? await sql.query(
            `SELECT * FROM tf_v2_operations WHERE resource_uid = ? AND generation = ?
             AND action IN ('create','update') AND status = 'succeeded' AND effect = 'complete'`,
            [String(deployment.uid), deployment.observed_generation],
          )
        : [];
    const namesWorker = (accepted: unknown): boolean => {
      const candidate = json(accepted).worker;
      return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>).resourceUid === input.workerUid
        : false;
    };
    if (
      !namesWorker(deployment.spec_json) &&
      !currentRows.some((row) => namesWorker(row.accepted_spec_json)) &&
      !priorRows.some((row) => namesWorker(row.accepted_spec_json))
    )
      continue;
    if (currentRows.length !== 1 || !currentRows[0]) throw busy();
    const current = currentRows[0];
    add("tf_v2_operations", ["id"], current);
    if (
      current.resource_uid !== deployment.uid ||
      current.principal !== deployment.principal ||
      current.backend_id !== deployment.backend_id ||
      current.target_key !== deployment.target_key ||
      current.generation !== deployment.generation ||
      current.accepted_spec_json !== deployment.spec_json
    )
      throw busy();
    if (typeof deployment.observed_generation !== "number") throw busy();
    const allocations: Row[] = [];
    if (deployment.observed_generation > 0) {
      if (priorRows.length > 1) throw busy();
      const observed = json(deployment.observed_json);
      if (observed.active === true) {
        if (!priorRows[0] || observed.ready !== true) throw busy();
        allocations.push(priorRows[0]);
      }
    }
    if (deployment.busy_operation !== null) {
      if (
        deployment.busy_operation !== current.id ||
        !["queued", "running", "waiting_input", "reconciling"].includes(String(current.status))
      )
        throw busy();
      if (
        (current.action === "create" || current.action === "update") &&
        (current.effect === "none" || current.effect === "unknown")
      )
        allocations.push(current);
      else if (current.effect !== "none") throw busy();
    } else if (
      (deployment.phase !== "idle" && deployment.phase !== "error") ||
      ["queued", "running", "waiting_input", "reconciling"].includes(String(current.status)) ||
      current.effect === "partial" ||
      current.effect === "unknown" ||
      (current.status === "succeeded" && current.generation !== deployment.observed_generation)
    )
      throw busy();

    for (const allocation of allocations) {
      let spec: ReturnType<typeof parseWorkerDeploymentSpec>;
      try {
        spec = parseWorkerDeploymentSpec(json(allocation.accepted_spec_json));
      } catch {
        throw busy();
      }
      if (spec.worker.resourceUid !== input.workerUid) continue;
      if (
        allocation.resource_uid !== deployment.uid ||
        allocation.principal !== input.principal ||
        allocation.backend_id !== deployment.backend_id ||
        allocation.target_key !== input.targetKey
      )
        throw busy();
      if (allocation.generation === deployment.observed_generation) {
        const selected = json(deployment.observed_json).selectedVersions;
        if (
          !Array.isArray(selected) ||
          selected.length !== spec.versions.length ||
          spec.versions.some(
            (weighted) =>
              !selected.some(
                (item) =>
                  item !== null &&
                  typeof item === "object" &&
                  !Array.isArray(item) &&
                  item.resourceUid === weighted.workerVersion.resourceUid &&
                  item.weight === weighted.weight,
              ),
          )
        )
          throw busy();
      }
      add("tf_v2_operations", ["id"], allocation);
      await references(
        String(allocation.id),
        String(deployment.uid),
        referencesForWorkerDeployment(spec),
      );
      for (const weighted of spec.versions) {
        versionUids.add(weighted.workerVersion.resourceUid);
        if (allocation.generation === deployment.observed_generation)
          activeVersionUids.add(weighted.workerVersion.resourceUid);
      }
    }
  }

  const versions: Version[] = [];
  for (const uid of [...versionUids].sort()) {
    const version = await resource(uid, WORKER_VERSION_FORM_URL);
    const versionOp = await operation(String(version.last_operation));
    const observed = json(version.observed_json);
    if (
      !settled(version, versionOp) ||
      observed.ready !== true ||
      observed.resolvedBindings !== true
    )
      throw busy();
    let spec: ReturnType<typeof parseWorkerVersionSpec>;
    try {
      spec = parseWorkerVersionSpec(json(version.spec_json));
    } catch {
      throw busy();
    }
    if (spec.worker.resourceUid !== input.workerUid) throw busy();
    await references(String(versionOp.id), uid, referencesForWorkerVersion(spec));
    if (!spec.bundle) {
      versions.push({ uid, bundleUid: null, bundleSpec: null, bundleObserved: null });
      continue;
    }
    if (observed.bundleVerified !== true) throw busy();
    const bundle = await resource(spec.bundle.resourceUid, WORKER_BUNDLE_FORM_URL);
    if (!settled(bundle, await operation(String(bundle.last_operation)))) throw busy();
    const owner = await one(
      sql,
      `SELECT resource_uid, form_url, manifest_sha256, state, observation_json,
        verified_operation_id FROM tf_v2_artifact_owners WHERE resource_uid = ?`,
      [spec.bundle.resourceUid],
    );
    if (
      owner.form_url !== WORKER_BUNDLE_FORM_URL ||
      owner.state !== "verified" ||
      owner.observation_json !== bundle.observed_json
    )
      throw busy();
    add("tf_v2_artifact_owners", ["resource_uid"], owner);
    versions.push({
      uid,
      bundleUid: spec.bundle.resourceUid,
      bundleSpec: json(bundle.spec_json),
      bundleObserved: json(bundle.observed_json),
    });
  }
  const ordered = [...evidence.values()].map((item) => ({
    ...item,
    rows: [...item.rows].sort((a, b) =>
      item.key
        .map((column) => String(a[column]))
        .join("\0")
        .localeCompare(item.key.map((column) => String(b[column])).join("\0")),
    ),
  }));
  return {
    evidence: ordered,
    versions,
    activeVersionUids,
    vector: canonicalJson(ordered as unknown as JsonObject),
  };
}

function predicateFor(input: {
  readonly captured: Capture;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
}): V2AdmissionPredicate {
  const predicates = input.captured.evidence.map(exactRows);
  const deployments =
    input.captured.evidence
      .find((item) => item.table === "tf_v2_resources")
      ?.rows.filter((row) => row.form_url === WORKER_DEPLOYMENT_FORM_URL) ?? [];
  predicates.push({
    sql: `(SELECT COUNT(*) FROM tf_v2_resources WHERE form_url = ? AND principal = ?
      AND space = ? AND target_key = ? AND deleted_at IS NULL) = ?`,
    params: [
      WORKER_DEPLOYMENT_FORM_URL,
      input.principal,
      input.space,
      input.targetKey,
      deployments.length,
    ],
  });
  // The Core d961 admission path recognizes this exact transient CAS outcome.
  // Older Core versions ignore the field and are not a mounting target.
  return {
    sql: predicates.map((predicate) => `(${predicate.sql})`).join(" AND "),
    params: predicates.flatMap((predicate) => predicate.params),
    conflictCode: "resource_busy",
  } as V2AdmissionPredicate;
}

/** Accepted active+pending weighted class qualification, with no v1 FormRef. */
export function createV2WorkflowClassAdmission(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly bundleCustody: Pick<WorkerBundleCustody, "readHeldVerified">;
  readonly inspector: Pick<WorkerModuleSemanticInspector, "inspectWorkflowClass">;
}): V2WorkflowClassAdmission {
  if (
    !options.sql ||
    !options.targetKey ||
    typeof options.bundleCustody?.readHeldVerified !== "function" ||
    typeof options.inspector?.inspectWorkflowClass !== "function"
  )
    throw new TypeError("v2 Workflow class admission needs accepted SQL and held-byte inspector");

  async function inspect(input: {
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
    readonly spec: DurableWorkflowSpec;
  }): Promise<{
    readonly captured: Capture | null;
    readonly invalid: boolean;
    readonly unavailable: boolean;
  }> {
    if (input.targetKey !== options.targetKey)
      return { captured: null, invalid: false, unavailable: true };
    const captureInput = {
      sql: options.sql,
      principal: input.principal,
      space: input.space,
      targetKey: options.targetKey,
      workerUid: input.spec.worker.resourceUid,
    };
    const captured = await capture(captureInput).catch(() => null);
    if (!captured) return { captured: null, invalid: false, unavailable: true };
    const stillCurrent = async (): Promise<boolean> => {
      try {
        return (await capture(captureInput)).vector === captured.vector;
      } catch {
        return false;
      }
    };
    let invalid = false;
    let unavailable = false;
    for (const version of captured.versions) {
      if (!version.bundleUid || !version.bundleSpec || !version.bundleObserved) {
        invalid = true;
        continue;
      }
      let held: Awaited<ReturnType<WorkerBundleCustody["readHeldVerified"]>>;
      try {
        held = await options.bundleCustody.readHeldVerified({
          targetResourceUid: version.bundleUid,
          principal: input.principal,
          space: input.space,
          expectedSpec: version.bundleSpec,
          expectedObserved: version.bundleObserved,
          stillAuthorized: stillCurrent,
        });
      } catch {
        unavailable = true;
        continue;
      }
      try {
        const verdict = await options.inspector.inspectWorkflowClass({
          mainModule: held.manifest.entrypoint,
          modules: held.manifest.files.map((file, index) => ({
            name: file.path,
            digest: `sha256:${file.sha256}` as const,
            mediaType: file.mediaType,
            bytes: new Uint8Array(held.files[index] ?? []),
          })),
          className: input.spec.className,
        });
        if (verdict.outcome === "invalid") invalid = true;
        if (verdict.outcome === "unavailable") unavailable = true;
      } catch {
        unavailable = true;
      }
      if (!(await stillCurrent())) return { captured: null, invalid: false, unavailable: true };
    }
    if (!(await stillCurrent())) return { captured: null, invalid: false, unavailable: true };
    return { captured, invalid, unavailable };
  }

  return {
    async prepare(input) {
      const result = await inspect(input);
      if (result.invalid) return { kind: "incompatible" };
      if (result.unavailable || !result.captured) return { kind: "unavailable" };
      return {
        kind: "qualified",
        predicate: predicateFor({
          captured: result.captured,
          principal: input.principal,
          space: input.space,
          targetKey: input.targetKey,
        }),
      };
    },
    async observe(input) {
      const result = await inspect(input);
      if (result.unavailable || !result.captured) return "unavailable";
      if (result.invalid || result.captured.activeVersionUids.size === 0) return "not_ready";
      return "ready";
    },
  };
}
