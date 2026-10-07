import { canonicalJson } from "../json.ts";
import type { Clock, Sql } from "../ports.ts";
import {
  parseWorkerCronTriggerSpec,
  validateWorkerCronTriggerUpdate,
  WORKER_CRON_TRIGGER_FORM_URL,
  WorkerCronTriggerValidationError,
  workerCronTriggerReferences,
} from "./forms/worker-cron-trigger.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerVersion,
} from "./forms/worker-references.ts";
import {
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "./forms/worker-specs.ts";
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "./types.ts";

export const WORKER_CRON_TRIGGER_BACKEND_ID = "selfhost-v2-worker-cron-trigger-sql-v1";
const UNKNOWN: V2BackendResult = {
  kind: "unknown",
  code: "schedule_unconfirmed",
  message: "The schedule operation is not yet confirmed",
};

export interface WorkerCronScheduledCapability {
  readonly kind: "confirmed";
  readonly servingSourceOperationId: string;
  readonly deploymentUid: string;
  readonly deploymentGeneration: number;
  readonly versions: readonly {
    readonly workerVersionUid: string;
    readonly generation: number;
    readonly weight: number;
  }[];
  stillCurrent(): Promise<boolean>;
}

export interface WorkerCronTriggerCapabilityReader {
  observeScheduledCapability(input: {
    readonly workerUid: string;
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
  }): Promise<WorkerCronScheduledCapability | { readonly kind: "unknown" }>;
}

export interface WorkerCronTriggerAdmissionInput {
  readonly workerUid: string;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly sourceOperationId: string;
  readonly leaseToken: string;
  readonly backendId: string;
  readonly backendKey: string;
}

export type WorkerCronTriggerAdmissionResolution =
  | {
      readonly kind: "ready";
      readonly required: boolean;
      readonly attachmentUids: readonly string[];
      stillCurrent(): Promise<boolean>;
    }
  | { readonly kind: "unknown" };

/**
 * Read the exact current CronTrigger referrer set for a leased WorkerDeployment
 * Operation. This is an internal required-handler admission seam, not an
 * application registry or an execution delivery port.
 */
export function createWorkerCronTriggerAdmissionReader(options: {
  readonly sql: Sql;
  readonly now?: Clock;
}) {
  const now = options.now ?? (() => new Date());

  async function capture(input: WorkerCronTriggerAdmissionInput) {
    const nowMs = now().getTime();
    const claimRows = (await options.sql.query(
      `SELECT op.id, op.accepted_spec_json, op.lease_token, op.lease_until_ms,
              op.backend_id, op.backend_key, op.target_key, op.principal,
              op.resource_uid, op.status, op.action, op.generation AS op_generation,
              op.dispatch_possible,
              resource.form_url, resource.space, resource.last_operation,
              resource.busy_operation, resource.deleted_at, resource.phase,
              resource.backend_id AS resource_backend_id,
              resource.target_key AS resource_target_key,
              resource.generation AS resource_generation, resource.spec_json
       FROM tf_v2_operations op
       JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
       WHERE op.id = ? LIMIT 2`,
      [input.sourceOperationId],
    )) as unknown as readonly Record<string, unknown>[];
    const claim = claimRows.length === 1 ? claimRows[0] : undefined;
    if (
      !claim ||
      claim.id !== input.sourceOperationId ||
      claim.id !== claim.last_operation ||
      claim.principal !== input.principal ||
      claim.space !== input.space ||
      claim.form_url !== WORKER_DEPLOYMENT_FORM_URL ||
      claim.backend_id !== input.backendId ||
      claim.backend_key !== input.backendKey ||
      claim.target_key !== input.targetKey ||
      claim.resource_backend_id !== input.backendId ||
      claim.resource_target_key !== input.targetKey ||
      (claim.action !== "create" && claim.action !== "update") ||
      claim.status !== "reconciling" ||
      claim.dispatch_possible !== 1 ||
      claim.lease_token !== input.leaseToken ||
      typeof claim.lease_until_ms !== "number" ||
      claim.lease_until_ms <= nowMs + 2 ||
      claim.busy_operation !== claim.id ||
      claim.deleted_at !== null ||
      (claim.phase !== "pending" && claim.phase !== "idle") ||
      claim.op_generation !== claim.resource_generation ||
      claim.spec_json !== claim.accepted_spec_json
    ) {
      return null;
    }
    let deploymentSpec: ReturnType<typeof parseWorkerDeploymentSpec>;
    try {
      deploymentSpec = parseWorkerDeploymentSpec(JSON.parse(String(claim.accepted_spec_json)));
    } catch {
      return null;
    }
    if (deploymentSpec.worker.resourceUid !== input.workerUid) return null;

    const attachmentRows = (await options.sql.query(
      `SELECT trigger.uid, trigger.generation, trigger.observed_generation,
              trigger.phase, trigger.spec_json, trigger.last_operation,
              trigger.busy_operation, trigger.deleted_at,
              operation.status, operation.action,
              operation.generation AS operation_generation,
              operation.accepted_spec_json,
              operation.principal AS operation_principal
       FROM tf_v2_resources trigger
       LEFT JOIN tf_v2_operations operation ON operation.id = trigger.last_operation
       WHERE trigger.form_url = ? AND trigger.principal = ? AND trigger.space = ?
         AND trigger.deleted_at IS NULL
       ORDER BY trigger.uid LIMIT 257`,
      [WORKER_CRON_TRIGGER_FORM_URL, input.principal, input.space],
    )) as unknown as readonly Record<string, unknown>[];
    if (attachmentRows.length > 256) return null;
    const attachmentSnapshot: Record<string, unknown>[] = [];
    for (const row of attachmentRows) {
      if (typeof row.spec_json !== "string") return null;
      let cronSpec: ReturnType<typeof parseWorkerCronTriggerSpec>;
      try {
        cronSpec = parseWorkerCronTriggerSpec(JSON.parse(row.spec_json));
      } catch {
        return null;
      }
      if (cronSpec.worker.resourceUid !== input.workerUid) continue;
      if (
        typeof row.uid !== "string" ||
        typeof row.generation !== "number" ||
        typeof row.observed_generation !== "number" ||
        typeof row.spec_json !== "string" ||
        typeof row.last_operation !== "string" ||
        row.operation_principal !== input.principal ||
        row.operation_generation !== row.generation ||
        row.accepted_spec_json !== row.spec_json
      ) {
        return null;
      }
      if (
        row.status === "succeeded" &&
        (row.phase !== "idle" ||
          row.busy_operation !== null ||
          row.observed_generation !== row.generation)
      )
        return null;
      if (
        row.status !== "succeeded" &&
        row.status !== "queued" &&
        row.status !== "running" &&
        row.status !== "waiting_input" &&
        row.status !== "reconciling"
      )
        return null;
      if (
        !(await referencesMatch(
          options.sql,
          String(row.last_operation),
          String(row.uid),
          workerCronTriggerReferences(cronSpec),
        ))
      )
        return null;
      attachmentSnapshot.push({
        uid: row.uid,
        generation: row.generation,
        phase: row.phase,
        spec: row.spec_json,
        operation: row.last_operation,
        busy: row.busy_operation,
        status: row.status,
        action: row.action,
        deleted: row.deleted_at,
      });
    }
    return { claim: claimRows[0], attachments: attachmentSnapshot };
  }

  return {
    async requiresScheduledHandler(
      input: WorkerCronTriggerAdmissionInput,
    ): Promise<WorkerCronTriggerAdmissionResolution> {
      const initial = await capture(input);
      if (!initial) return { kind: "unknown" };
      const snapshot = canonicalJson(initial);
      const stillCurrent = async () => {
        const current = await capture(input);
        return current !== null && canonicalJson(current) === snapshot;
      };
      return {
        kind: "ready",
        required: initial.attachments.length > 0,
        attachmentUids: initial.attachments.map((item) => String(item.uid)),
        stillCurrent,
      };
    },
  };
}

interface ResourceSnapshot {
  readonly uid: string;
  readonly principal: string;
  readonly space: string;
  readonly form_url: string;
  readonly backend_id: string;
  readonly target_key: string;
  readonly generation: number;
  readonly observed_generation: number;
  readonly phase: string;
  readonly spec_json: string;
  readonly observed_json: string;
  readonly last_operation: string;
  readonly busy_operation: string | null;
  readonly deleted_at: string | null;
}

interface OperationSnapshot {
  readonly id: string;
  readonly resource_uid: string;
  readonly principal: string;
  readonly action: string;
  readonly generation: number;
  readonly status: string;
  readonly effect: string;
  readonly backend_id: string;
  readonly target_key: string;
  readonly accepted_spec_json: string;
}

/** Internal backend; it is not added to the application Form map here. */
export function createWorkerCronTriggerForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly capability: WorkerCronTriggerCapabilityReader;
  readonly now?: Clock;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const now = options.now ?? (() => new Date());

  async function run(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== WORKER_CRON_TRIGGER_FORM_URL ||
      execution.backendId !== WORKER_CRON_TRIGGER_BACKEND_ID ||
      execution.targetKey !== options.targetKey
    ) {
      return UNKNOWN;
    }
    let spec: ReturnType<typeof parseWorkerCronTriggerSpec>;
    try {
      spec = parseWorkerCronTriggerSpec(execution.spec);
    } catch {
      return UNKNOWN;
    }
    if (!(await currentClaim(options.sql, execution, now().getTime()))) return UNKNOWN;

    if (execution.action === "delete") {
      const pending = (
        await options.sql.query(
          `SELECT 1 FROM tf_v2_worker_cron_matches
         WHERE trigger_uid = ? AND state NOT IN ('resolved', 'rejected') LIMIT 1`,
          [execution.resourceUid],
        )
      ).length;
      if (pending > 0 || !(await currentClaim(options.sql, execution, now().getTime()))) {
        return UNKNOWN;
      }
      return {
        kind: "complete",
        observed: { cron: spec.cron, timezone: "UTC", scheduleReady: false },
        output: {},
      };
    }

    const workerGraph = await readSettledScheduledWorker(
      options.sql,
      execution,
      spec.worker.resourceUid,
    );
    if (workerGraph.kind === "unsupported") {
      if (!(await currentClaim(options.sql, execution, now().getTime()))) return UNKNOWN;
      return {
        kind: "no_effect",
        code: "worker_scheduled_handler_unavailable",
        message: "The referenced Worker has no confirmed scheduled handler",
      };
    }
    if (workerGraph.kind !== "ready") return UNKNOWN;
    let capability: WorkerCronScheduledCapability | { readonly kind: "unknown" };
    try {
      capability = await options.capability.observeScheduledCapability({
        workerUid: spec.worker.resourceUid,
        principal: execution.principal,
        space: execution.space,
        targetKey: execution.targetKey,
      });
    } catch {
      return UNKNOWN;
    }
    if (
      capability.kind !== "confirmed" ||
      !matchesCapability(capability, workerGraph) ||
      !(await capability.stillCurrent())
    ) {
      return UNKNOWN;
    }
    if (!(await currentClaim(options.sql, execution, now().getTime()))) return UNKNOWN;
    const at = now().getTime();
    const next = spec.schedule.nextAfter(at);
    return {
      kind: "complete",
      observed: {
        cron: spec.cron,
        timezone: "UTC",
        scheduleReady: true,
        ...(next === null ? {} : { nextMatchAt: new Date(next).toISOString() }),
      },
      output: {},
    };
  }

  return {
    validateCreate(spec) {
      try {
        parseWorkerCronTriggerSpec(spec);
      } catch (error) {
        if (error instanceof WorkerCronTriggerValidationError) {
          throw new TakoformV2Error(error.code, 422);
        }
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateWorkerCronTriggerUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof WorkerCronTriggerValidationError) {
          throw new TakoformV2Error(error.code, 422);
        }
        throw error;
      }
    },
    references(spec) {
      try {
        return workerCronTriggerReferences(parseWorkerCronTriggerSpec(spec));
      } catch (error) {
        if (error instanceof WorkerCronTriggerValidationError) {
          throw new TakoformV2Error(error.code, 422);
        }
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: WORKER_CRON_TRIGGER_BACKEND_ID,
      targetKey: options.targetKey,
      execute: run,
      reconcile: run,
    },
  };
}

async function currentClaim(sql: Sql, execution: V2Execution, nowMs: number): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 FROM tf_v2_operations op
     JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
     WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ?
       AND op.backend_key = ? AND op.backend_id = ? AND op.target_key = ?
       AND op.action = ? AND op.generation = ? AND op.accepted_spec_json = ?
       AND op.status = 'reconciling' AND op.dispatch_possible = 1
       AND op.lease_token = ? AND op.lease_until_ms > ?
       AND resource.uid = op.resource_uid AND resource.principal = ?
       AND resource.form_url = ? AND resource.space = ? AND resource.name = ?
       AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
       AND resource.generation = op.generation AND resource.last_operation = op.id
       AND resource.busy_operation = op.id AND resource.deleted_at IS NULL
       AND resource.spec_json = op.accepted_spec_json`,
    [
      execution.operationId,
      execution.resourceUid,
      execution.principal,
      execution.backendKey,
      execution.backendId,
      execution.targetKey,
      execution.action,
      execution.generation,
      canonicalJson(execution.spec),
      execution.leaseToken,
      nowMs + 2,
      execution.principal,
      execution.form,
      execution.space,
      execution.name,
    ],
  );
  return rows.length === 1;
}

interface SettledScheduledWorkerGraph {
  readonly deploymentUid: string;
  readonly deploymentGeneration: number;
  readonly versions: readonly {
    readonly workerVersionUid: string;
    readonly generation: number;
    readonly weight: number;
  }[];
}

type ScheduledWorkerGraphResolution =
  | { readonly kind: "ready"; readonly graph: SettledScheduledWorkerGraph }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unknown" };

async function readSettledScheduledWorker(
  sql: Sql,
  execution: V2Execution,
  workerUid: string,
): Promise<ScheduledWorkerGraphResolution> {
  const worker = await oneResource(sql, workerUid);
  if (
    !worker ||
    worker.principal !== execution.principal ||
    worker.space !== execution.space ||
    worker.form_url !== "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/" ||
    !settled(worker)
  ) {
    return { kind: "unknown" };
  }
  if (!(await currentOperation(sql, worker))) return { kind: "unknown" };
  const workerObserved = parseObject(worker.observed_json);
  const deploymentUid = workerObserved?.activeDeploymentUid;
  if (workerObserved?.ready !== true || typeof deploymentUid !== "string") {
    return { kind: "unknown" };
  }

  const deployment = await oneResource(sql, deploymentUid);
  if (
    !deployment ||
    deployment.principal !== worker.principal ||
    deployment.space !== worker.space ||
    deployment.form_url !== WORKER_DEPLOYMENT_FORM_URL ||
    !settled(deployment)
  ) {
    return { kind: "unknown" };
  }
  let deploymentSpec: ReturnType<typeof parseWorkerDeploymentSpec>;
  const deploymentObserved = parseObject(deployment.observed_json);
  try {
    deploymentSpec = parseWorkerDeploymentSpec(JSON.parse(deployment.spec_json));
  } catch {
    return { kind: "unknown" };
  }
  if (
    deploymentSpec.worker.resourceUid !== workerUid ||
    deploymentObserved?.ready !== true ||
    deploymentObserved.active !== true ||
    !selectedVersionsMatch(deploymentObserved.selectedVersions, deploymentSpec.versions)
  ) {
    return { kind: "unknown" };
  }

  const deploymentOperation = await currentOperation(sql, deployment);
  if (
    !deploymentOperation ||
    !(await referencesMatch(
      sql,
      deploymentOperation.id,
      deployment.uid,
      referencesForWorkerDeployment(deploymentSpec),
    ))
  ) {
    return { kind: "unknown" };
  }

  const versions: SettledScheduledWorkerGraph["versions"][number][] = [];
  for (const selected of deploymentSpec.versions) {
    const version = await oneResource(sql, selected.workerVersion.resourceUid);
    if (
      !version ||
      version.principal !== worker.principal ||
      version.space !== worker.space ||
      version.form_url !== WORKER_VERSION_FORM_URL ||
      !settled(version)
    ) {
      return { kind: "unknown" };
    }
    let versionSpec: ReturnType<typeof parseWorkerVersionSpec>;
    const versionObserved = parseObject(version.observed_json);
    try {
      versionSpec = parseWorkerVersionSpec(JSON.parse(version.spec_json));
    } catch {
      return { kind: "unknown" };
    }
    if (
      versionSpec.worker.resourceUid !== workerUid ||
      !versionSpec.handlers.includes("scheduled") ||
      versionObserved?.ready !== true
    ) {
      return { kind: "unsupported" };
    }
    const versionOperation = await currentOperation(sql, version);
    if (
      !versionOperation ||
      !(await referencesMatch(
        sql,
        versionOperation.id,
        version.uid,
        referencesForWorkerVersion(versionSpec),
      ))
    ) {
      return { kind: "unknown" };
    }
    versions.push({
      workerVersionUid: version.uid,
      generation: version.generation,
      weight: selected.weight,
    });
  }
  return {
    kind: "ready",
    graph: {
      deploymentUid: deployment.uid,
      deploymentGeneration: deployment.generation,
      versions,
    },
  };
}

function matchesCapability(
  capability: WorkerCronScheduledCapability,
  graph: Extract<ScheduledWorkerGraphResolution, { kind: "ready" }>,
): boolean {
  return (
    capability.servingSourceOperationId.length > 0 &&
    capability.deploymentUid === graph.graph.deploymentUid &&
    capability.deploymentGeneration === graph.graph.deploymentGeneration &&
    capability.versions.length === graph.graph.versions.length &&
    capability.versions.every((version, index) => {
      const expected = graph.graph.versions[index];
      return (
        expected !== undefined &&
        version.workerVersionUid === expected.workerVersionUid &&
        version.generation === expected.generation &&
        version.weight === expected.weight
      );
    })
  );
}

function settled(resource: ResourceSnapshot): boolean {
  return (
    resource.deleted_at === null &&
    resource.phase === "idle" &&
    resource.busy_operation === null &&
    resource.generation === resource.observed_generation
  );
}

async function oneResource(sql: Sql, uid: string): Promise<ResourceSnapshot | null> {
  const rows = (await sql.query("SELECT * FROM tf_v2_resources WHERE uid = ? LIMIT 2", [
    uid,
  ])) as unknown as readonly ResourceSnapshot[];
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

async function currentOperation(
  sql: Sql,
  resource: ResourceSnapshot,
): Promise<OperationSnapshot | null> {
  const rows = (await sql.query("SELECT * FROM tf_v2_operations WHERE id = ? LIMIT 2", [
    resource.last_operation,
  ])) as unknown as readonly OperationSnapshot[];
  const operation = rows.length === 1 ? rows[0] : null;
  return operation &&
    operation.resource_uid === resource.uid &&
    operation.principal === resource.principal &&
    (operation.action === "create" || operation.action === "update") &&
    operation.generation === resource.generation &&
    operation.status === "succeeded" &&
    operation.effect === "complete" &&
    operation.backend_id === resource.backend_id &&
    operation.target_key === resource.target_key &&
    operation.accepted_spec_json === resource.spec_json
    ? operation
    : null;
}

async function referencesMatch(
  sql: Sql,
  operationId: string,
  referrerUid: string,
  expected: ReturnType<typeof referencesForWorkerDeployment>,
): Promise<boolean> {
  const [set, actual, edges] = await Promise.all([
    sql.query("SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?", [
      operationId,
    ]),
    sql.query(
      `SELECT target_uid, form_url, readiness, target_spec_path, target_spec_equals
       FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid LIMIT 32`,
      [operationId],
    ),
    sql.query(
      `SELECT target_uid FROM tf_v2_resource_references
       WHERE referrer_uid = ? ORDER BY target_uid LIMIT 32`,
      [referrerUid],
    ),
  ]);
  if (
    set.length !== 1 ||
    set[0]?.sealed !== 1 ||
    actual.length !== expected.length ||
    edges.length !== expected.length
  ) {
    return false;
  }
  return expected.every((reference, index) => {
    const row = actual[index] as Record<string, unknown> | undefined;
    return (
      row?.target_uid === reference.resourceUid &&
      row.form_url === reference.formUrl &&
      row.readiness === reference.readiness &&
      row.target_spec_path ===
        (reference.targetSpecMatch ? `$.${reference.targetSpecMatch.path.join(".")}` : null) &&
      row.target_spec_equals === (reference.targetSpecMatch?.equals ?? null) &&
      edges[index]?.target_uid === reference.resourceUid
    );
  });
}

function selectedVersionsMatch(
  observed: unknown,
  expected: ReturnType<typeof parseWorkerDeploymentSpec>["versions"],
): boolean {
  if (!Array.isArray(observed) || observed.length !== expected.length) return false;
  const actual = [...observed].sort((left, right) =>
    String((left as Record<string, unknown> | null)?.resourceUid).localeCompare(
      String((right as Record<string, unknown> | null)?.resourceUid),
    ),
  );
  return expected.every((version, index) => {
    const row = actual[index];
    return (
      !!row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      Object.keys(row).length === 2 &&
      (row as Record<string, unknown>).resourceUid === version.workerVersion.resourceUid &&
      (row as Record<string, unknown>).weight === version.weight
    );
  });
}

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
