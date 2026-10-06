import { canonicalJson } from "../json.ts";
import type { JsonObject, SqlParam } from "../ports.ts";
import { WORKER_DEPLOYMENT_FORM_URL, WORKER_ENDPOINT_FORM_URL } from "./forms/worker-specs.ts";
import type { V2Execution } from "./types.ts";

/** A captured predicate, to be embedded in the private route's single CAS statement. */
export interface V2WorkerPublicationSqlGuard {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

type SqlRow = Record<string, unknown>;
type Rows = Map<string, SqlRow>;

function isRow(value: unknown): value is SqlRow {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addRow(rows: Rows, key: string, row: SqlRow): void {
  const previous = rows.get(key);
  if (previous && canonicalJson(previous as JsonObject) !== canonicalJson(row as JsonObject)) {
    // A graph that changed while it was read cannot be a write authority.
    throw new Error("Worker publication graph changed during capture");
  }
  rows.set(key, row);
}

function scanEvidence(
  value: unknown,
  resources: Rows,
  operations: Rows,
  owners: Rows,
  edges: Rows,
): void {
  if (Array.isArray(value)) {
    for (const item of value) scanEvidence(item, resources, operations, owners, edges);
    return;
  }
  if (!isRow(value)) return;
  if (typeof value.uid === "string" && typeof value.spec_json === "string") {
    addRow(resources, value.uid, value);
    return;
  }
  if (typeof value.id === "string" && typeof value.accepted_spec_json === "string") {
    addRow(operations, value.id, value);
    return;
  }
  if (typeof value.resource_uid === "string" && typeof value.manifest_sha256 === "string") {
    addRow(owners, value.resource_uid, value);
    return;
  }
  if (typeof value.target_uid === "string" && typeof value.referrer_uid === "string") {
    addRow(edges, `${value.target_uid}\0${value.referrer_uid}`, value);
    return;
  }
  for (const child of Object.values(value))
    scanEvidence(child, resources, operations, owners, edges);
}

function exactRows(
  table: string,
  keyColumns: readonly string[],
  rows: Rows,
): V2WorkerPublicationSqlGuard {
  if (rows.size === 0) return { sql: "1", params: [] };
  const values = [...rows.values()];
  const columns = Object.keys(values[0] ?? {});
  if (columns.length === 0 || columns.some((name) => !/^[a-z_][a-z_0-9]*$/u.test(name))) {
    throw new Error("Invalid Worker publication SQL evidence columns");
  }
  const comparisons = columns
    .map((name) => `actual."${name}" IS json_extract(expected.value, '$."${name}"')`)
    .join(" AND ");
  const keys = keyColumns
    .map((name) => `actual."${name}" = json_extract(expected.value, '$."${name}"')`)
    .join(" AND ");
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
      SELECT 1 FROM ${table} actual WHERE ${keys} AND ${comparisons}))`,
    params: [JSON.stringify(values)],
  };
}

function exactIdSet(
  sql: string,
  idColumn: string,
  ids: readonly string[],
  scopeParams: readonly SqlParam[],
): V2WorkerPublicationSqlGuard {
  const expected = JSON.stringify(ids);
  return {
    sql: `(SELECT COUNT(*) FROM ${sql}) = json_array_length(?) AND
      NOT EXISTS (SELECT 1 FROM ${sql} AND NOT EXISTS (
        SELECT 1 FROM json_each(?) expected WHERE expected.value = ${idColumn}))`,
    params: [...scopeParams, expected, ...scopeParams, expected],
  };
}

/** Internal builder: all evidence comes from the resolver's own SQL reads. */
export function createWorkerPublicationSqlGuard(input: {
  readonly execution: V2Execution;
  readonly workerUid: string;
  readonly principal: string;
  readonly space: string;
  readonly pendingIds: readonly string[];
  readonly deploymentIds: readonly string[];
  readonly endpointIds: readonly string[];
  readonly inboundTargetIds: readonly string[];
  readonly inboundEdges: readonly SqlRow[];
  readonly referenceSetIds: readonly string[];
  readonly evidence: unknown;
}): V2WorkerPublicationSqlGuard {
  const resources: Rows = new Map();
  const operations: Rows = new Map();
  const owners: Rows = new Map();
  const edges: Rows = new Map();
  scanEvidence(input.evidence, resources, operations, owners, edges);

  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const add = (guard: V2WorkerPublicationSqlGuard) => {
    clauses.push(`(${guard.sql})`);
    params.push(...guard.params);
  };
  let acceptedSpec: string;
  try {
    acceptedSpec = canonicalJson(input.execution.spec);
  } catch {
    throw new Error("Invalid Worker publication execution spec");
  }
  add({
    sql: `EXISTS (SELECT 1 FROM tf_v2_operations op
      JOIN tf_v2_resources r ON r.uid = op.resource_uid
      WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ?
        AND op.backend_key = ? AND op.backend_id = ? AND op.target_key = ?
        AND op.action = ? AND op.generation = ? AND op.accepted_spec_json = ?
        AND op.status = 'reconciling' AND op.dispatch_possible = 1
        AND op.lease_token = ?
        AND op.lease_until_ms > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 2
        AND r.uid = op.resource_uid AND r.principal = ? AND r.form_url = ?
        AND r.space = ? AND r.name = ? AND r.backend_id = op.backend_id
        AND r.target_key = op.target_key AND r.generation = op.generation
        AND r.last_operation = op.id AND r.busy_operation = op.id
        AND r.deleted_at IS NULL AND r.spec_json = op.accepted_spec_json)`,
    params: [
      input.execution.operationId,
      input.execution.resourceUid,
      input.execution.principal,
      input.execution.backendKey,
      input.execution.backendId,
      input.execution.targetKey,
      input.execution.action,
      input.execution.generation,
      acceptedSpec,
      input.execution.leaseToken,
      input.execution.principal,
      input.execution.form,
      input.execution.space,
      input.execution.name,
    ],
  });
  add(exactRows("tf_v2_resources", ["uid"], resources));
  add(exactRows("tf_v2_operations", ["id"], operations));
  add(exactRows("tf_v2_artifact_owners", ["resource_uid"], owners));
  add(exactRows("tf_v2_resource_references", ["target_uid", "referrer_uid"], edges));
  add({
    sql: `(SELECT COUNT(*) FROM tf_v2_resource_references edge
      WHERE edge.target_uid IN (SELECT value FROM json_each(?))) = json_array_length(?)
      AND NOT EXISTS (SELECT 1 FROM tf_v2_resource_references edge
      WHERE edge.target_uid IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) expected
          WHERE edge.target_uid = json_extract(expected.value, '$.target_uid')
            AND edge.referrer_uid = json_extract(expected.value, '$.referrer_uid')))`,
    params: [
      JSON.stringify(input.inboundTargetIds),
      JSON.stringify(input.inboundEdges),
      JSON.stringify(input.inboundTargetIds),
      JSON.stringify(input.inboundEdges),
    ],
  });

  for (const [form, ids] of [
    [WORKER_DEPLOYMENT_FORM_URL, input.deploymentIds],
    [WORKER_ENDPOINT_FORM_URL, input.endpointIds],
  ] as const) {
    add(
      exactIdSet(
        `tf_v2_resources r WHERE r.form_url = ? AND r.principal = ?
          AND r.space = ? AND r.deleted_at IS NULL
          AND json_extract(r.spec_json, '$.worker.resourceUid') = ?`,
        "r.uid",
        ids,
        [form, input.principal, input.space, input.workerUid],
      ),
    );
  }
  add(
    exactIdSet(
      `tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
        WHERE r.form_url IN (?, ?) AND r.deleted_at IS NULL
          AND op.status IN ('queued', 'running', 'waiting_input', 'reconciling')
          AND json_extract(op.accepted_spec_json, '$.worker.resourceUid') = ?`,
      "op.id",
      input.pendingIds,
      [WORKER_DEPLOYMENT_FORM_URL, WORKER_ENDPOINT_FORM_URL, input.workerUid],
    ),
  );
  for (const id of input.referenceSetIds) {
    add({
      sql: "EXISTS (SELECT 1 FROM tf_v2_operation_reference_sets WHERE operation_id = ? AND sealed = 1)",
      params: [id],
    });
  }
  if (params.length > 100) throw new Error("Worker publication SQL guard exceeds D1 bind limit");
  return Object.freeze({ sql: clauses.join(" AND "), params: Object.freeze(params) });
}
