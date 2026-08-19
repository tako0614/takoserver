import type { JsonObject } from "../ports.ts";
import { isEdgeFormsApiVersion } from "./edge-family.ts";
import type { TakoformStoredRelation } from "./relations.ts";
import type { TakoformStore } from "./store.ts";
import type { TakoformCondition, TakoformStoredResource } from "./types.ts";
import { type InstalledTakoformForm, TakoformHostError } from "./types.ts";

const MODULE_WORKER = "ModuleWorker";
const WORKER_DEPLOYMENT = "WorkerDeployment";
const WORKER_RELATION = "/worker";
const DEPLOYMENT_VERSION_RELATION = "/versions/*/workerVersion";
const SERVICE_BINDING_RELATION = "/serviceBindings/*/resource";
const QUEUE_RELATION = "/queue";
const ATTACHMENT_HANDLER: Readonly<Record<string, string>> = {
  WorkerCustomDomain: "fetch",
  WorkerEndpoint: "fetch",
  WorkerCronTrigger: "scheduled",
  QueueConsumer: "queue",
};

/** Refuses an inward activation unless the worker really serves its handler. */
export async function validateWorkerAggregate(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly resourceName: string;
  readonly form: InstalledTakoformForm;
  readonly spec: JsonObject;
  readonly relations: readonly TakoformStoredRelation[];
  readonly store: Pick<
    TakoformStore,
    "hostnameClaims" | "queuePathReaches" | "resourcesByRelation" | "readResource" | "readRelations"
  >;
}): Promise<void> {
  const edgeApiVersion = input.form.identity.formRef.apiVersion;
  if (!isEdgeFormsApiVersion(edgeApiVersion)) return;
  if (input.form.identity.formRef.kind === WORKER_DEPLOYMENT && input.form.role === "deployment") {
    const versions = input.spec.versions;
    if (
      !Array.isArray(versions) ||
      versions.length === 0 ||
      versions.reduce(
        (sum, entry) =>
          sum +
          (typeof entry === "object" && entry !== null && !Array.isArray(entry)
            ? Number(entry.weight)
            : Number.NaN),
        0,
      ) !== 10_000
    ) {
      throw new TakoformHostError("invalid_argument", 400);
    }
    const worker = input.relations.find((relation) => relation.relation === WORKER_RELATION);
    if (!worker) throw new TakoformHostError("invalid_argument", 400);
    const active = await input.store.resourcesByRelation({
      tenantId: input.tenantId,
      space: input.space,
      sourceApiVersion: edgeApiVersion,
      sourceKind: WORKER_DEPLOYMENT,
      relation: WORKER_RELATION,
      targetUid: worker.targetUid,
      limit: 2,
    });
    if (active.some((candidate) => candidate.resource.metadata.name !== input.resourceName)) {
      throw new TakoformHostError("invalid_argument", 400);
    }
    const weighted = input.relations.filter(
      (relation) => relation.relation === DEPLOYMENT_VERSION_RELATION,
    );
    const seen = new Set<string>();
    for (const relation of weighted) {
      if (seen.has(relation.targetUid)) throw new TakoformHostError("invalid_argument", 400);
      seen.add(relation.targetUid);
      const versionRelations = await input.store.readRelations({
        tenantId: input.tenantId,
        space: input.space,
        apiVersion: relation.targetApiVersion,
        kind: relation.targetKind,
        name: relation.targetName,
      });
      if (
        !versionRelations.some(
          (candidate) =>
            candidate.relation === WORKER_RELATION && candidate.targetUid === worker.targetUid,
        )
      ) {
        throw new TakoformHostError("invalid_argument", 400);
      }
    }
    const requiredHandlers = await dependentHandlers(input, worker.targetUid, edgeApiVersion);
    for (const handler of requiredHandlers) {
      if (!(await selectedVersionsServe(input, weighted, handler))) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
    }
    return;
  }
  if (input.form.identity.formRef.kind === "WorkerVersion" && input.form.role === "revision") {
    validateEnvironmentNamespace(input.spec);
    for (const relation of input.relations) {
      if (relation.relation !== SERVICE_BINDING_RELATION) continue;
      if (!(await workerServes(input, relation.targetUid, "fetch", edgeApiVersion))) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
    }
    return;
  }
  const handler = ATTACHMENT_HANDLER[input.form.identity.formRef.kind];
  if (!handler || input.form.role !== "attachment") return;
  if (input.form.identity.formRef.kind === "WorkerCustomDomain") {
    const hostname = input.spec.hostname;
    if (typeof hostname !== "string") throw new TakoformHostError("invalid_argument", 400);
    const claims = await input.store.hostnameClaims(input.tenantId, hostname, 2);
    const holder = claims.find(
      (candidate) => candidate.space !== input.space || candidate.name !== input.resourceName,
    );
    if (holder) {
      throw new TakoformHostError("invalid_argument", 400, { holder: holder.name });
    }
  }
  const worker = input.relations.find((relation) => relation.relation === WORKER_RELATION);
  if (!worker) throw new TakoformHostError("invalid_argument", 400);
  if (!(await workerServes(input, worker.targetUid, handler, edgeApiVersion))) {
    throw new TakoformHostError("unsupported_capability", 422);
  }
  if (input.form.identity.formRef.kind === "WorkerEndpoint") {
    const endpoints = await input.store.resourcesByRelation({
      tenantId: input.tenantId,
      space: input.space,
      sourceApiVersion: edgeApiVersion,
      sourceKind: "WorkerEndpoint",
      relation: WORKER_RELATION,
      targetUid: worker.targetUid,
      limit: 2,
    });
    if (endpoints.some((candidate) => candidate.resource.metadata.name !== input.resourceName)) {
      throw new TakoformHostError("invalid_argument", 400);
    }
  }
  if (input.form.identity.formRef.kind === "QueueConsumer") {
    const queue = input.relations.find((relation) => relation.relation === QUEUE_RELATION);
    if (!queue) throw new TakoformHostError("invalid_argument", 400);
    const deadLetter = input.relations.find((relation) => relation.relation === "/deadLetterQueue");
    if (
      deadLetter &&
      (await input.store.queuePathReaches({
        tenantId: input.tenantId,
        space: input.space,
        fromQueueUid: deadLetter.targetUid,
        toQueueUid: queue.targetUid,
      }))
    ) {
      throw new TakoformHostError("invalid_argument", 400);
    }
    const consumers = await input.store.resourcesByRelation({
      tenantId: input.tenantId,
      space: input.space,
      sourceApiVersion: edgeApiVersion,
      sourceKind: "QueueConsumer",
      relation: QUEUE_RELATION,
      targetUid: queue.targetUid,
      limit: 2,
    });
    if (consumers.some((candidate) => candidate.resource.metadata.name !== input.resourceName)) {
      throw new TakoformHostError("invalid_argument", 400);
    }
  }
}

/** A live attachment or inbound service binding keeps its serving deployment alive. */
export async function validateWorkerDeploymentRemoval(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly form: InstalledTakoformForm;
  readonly relations: readonly TakoformStoredRelation[];
  readonly store: Pick<TakoformStore, "resourcesByRelation">;
}): Promise<void> {
  if (
    !isEdgeFormsApiVersion(input.form.identity.formRef.apiVersion) ||
    input.form.identity.formRef.kind !== WORKER_DEPLOYMENT ||
    input.form.role !== "deployment"
  ) {
    return;
  }
  const worker = input.relations.find((relation) => relation.relation === WORKER_RELATION);
  if (!worker) throw new TakoformHostError("invalid_argument", 400);
  if (
    (await dependentHandlers(input, worker.targetUid, input.form.identity.formRef.apiVersion))
      .size > 0
  ) {
    throw new TakoformHostError("dependency_in_use", 409);
  }
}

async function dependentHandlers(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly store: Pick<TakoformStore, "resourcesByRelation">;
  },
  workerUid: string,
  edgeApiVersion: string,
): Promise<ReadonlySet<string>> {
  const required = new Set<string>();
  for (const [sourceKind, relation, handler] of [
    ["WorkerCustomDomain", WORKER_RELATION, "fetch"],
    ["WorkerEndpoint", WORKER_RELATION, "fetch"],
    ["WorkerCronTrigger", WORKER_RELATION, "scheduled"],
    ["QueueConsumer", WORKER_RELATION, "queue"],
    ["WorkerVersion", SERVICE_BINDING_RELATION, "fetch"],
  ] as const) {
    const dependents = await input.store.resourcesByRelation({
      tenantId: input.tenantId,
      space: input.space,
      sourceApiVersion: edgeApiVersion,
      sourceKind,
      relation,
      targetUid: workerUid,
      limit: 1,
    });
    if (dependents.length > 0) required.add(handler);
  }
  return required;
}

async function selectedVersionsServe(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly store: Pick<TakoformStore, "readResource">;
  },
  versions: readonly TakoformStoredRelation[],
  handler: string,
): Promise<boolean> {
  if (versions.length === 0) return false;
  for (const relation of versions) {
    const version = await input.store.readResource({
      tenantId: input.tenantId,
      space: input.space,
      apiVersion: relation.targetApiVersion,
      kind: relation.targetKind,
      name: relation.targetName,
    });
    if (
      !version ||
      version.metadata.uid !== relation.targetUid ||
      !Array.isArray(version.spec.handlers) ||
      !version.spec.handlers.includes(handler)
    ) {
      return false;
    }
  }
  return true;
}

function validateEnvironmentNamespace(spec: JsonObject): void {
  const names: string[] = [];
  const vars = spec.vars;
  if (typeof vars === "object" && vars !== null && !Array.isArray(vars)) {
    names.push(...Object.keys(vars));
  }
  const sensitive = spec.requiredSensitiveVars;
  if (Array.isArray(sensitive)) {
    for (const name of sensitive) if (typeof name === "string") names.push(name);
  }
  for (const field of [
    "sqliteBindings",
    "kvBindings",
    "bucketBindings",
    "queueProducerBindings",
    "serviceBindings",
  ]) {
    const bindings = spec[field];
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      if (
        typeof binding === "object" &&
        binding !== null &&
        !Array.isArray(binding) &&
        typeof binding.name === "string"
      ) {
        names.push(binding.name);
      }
    }
  }
  if (new Set(names).size !== names.length) {
    throw new TakoformHostError("invalid_argument", 400);
  }
}

/**
 * A ModuleWorker is a service identity, not merely a stored row. Its portable
 * readiness follows the one deployment that currently selects runnable
 * versions for that exact worker UID.
 */
export async function workerServiceCondition(input: {
  readonly tenantId: string;
  readonly resource: TakoformStoredResource;
  readonly store: Pick<TakoformStore, "resourcesByRelation" | "readResource">;
}): Promise<TakoformCondition | null> {
  if (!isEdgeFormsApiVersion(input.resource.apiVersion) || input.resource.kind !== MODULE_WORKER)
    return null;
  const deployments = await input.store.resourcesByRelation({
    tenantId: input.tenantId,
    space: input.resource.metadata.space,
    sourceApiVersion: input.resource.apiVersion,
    sourceKind: WORKER_DEPLOYMENT,
    relation: WORKER_RELATION,
    targetUid: input.resource.metadata.uid,
    limit: 2,
  });
  if (deployments.length === 0) {
    return condition(
      "False",
      "Provisioning",
      `ModuleWorker ${input.resource.metadata.name} has no active WorkerDeployment`,
    );
  }
  if (deployments.length !== 1) {
    return condition(
      "False",
      "UnsupportedCapability",
      `ModuleWorker ${input.resource.metadata.name} has multiple active WorkerDeployments`,
    );
  }
  const deployment = deployments[0];
  if (!deployment) throw new TypeError("missing WorkerDeployment row");
  const versions = deployment.relations.filter(
    (relation) => relation.relation === DEPLOYMENT_VERSION_RELATION,
  );
  if (versions.length === 0) {
    return condition(
      "False",
      "UnsupportedCapability",
      `WorkerDeployment ${deployment.resource.metadata.name} selects no WorkerVersion`,
    );
  }
  for (const relation of versions) {
    const version = await input.store.readResource({
      tenantId: input.tenantId,
      space: input.resource.metadata.space,
      apiVersion: relation.targetApiVersion,
      kind: relation.targetKind,
      name: relation.targetName,
    });
    const handlers = version?.spec.handlers;
    if (
      !version ||
      version.metadata.uid !== relation.targetUid ||
      !Array.isArray(handlers) ||
      !handlers.includes("fetch")
    ) {
      return condition(
        "False",
        "UnsupportedCapability",
        `WorkerDeployment ${deployment.resource.metadata.name} does not serve fetch`,
      );
    }
  }
  return condition("True", "Available");
}

async function workerServes(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly store: Pick<TakoformStore, "resourcesByRelation" | "readResource">;
  },
  workerUid: string,
  handler: string,
  edgeApiVersion: string,
): Promise<boolean> {
  const deployments = await input.store.resourcesByRelation({
    tenantId: input.tenantId,
    space: input.space,
    sourceApiVersion: edgeApiVersion,
    sourceKind: WORKER_DEPLOYMENT,
    relation: WORKER_RELATION,
    targetUid: workerUid,
    limit: 2,
  });
  if (deployments.length !== 1) return false;
  const deployment = deployments[0];
  if (!deployment) return false;
  const versions = deployment.relations.filter(
    (relation) => relation.relation === DEPLOYMENT_VERSION_RELATION,
  );
  if (versions.length === 0) return false;
  for (const relation of versions) {
    const version = await input.store.readResource({
      tenantId: input.tenantId,
      space: input.space,
      apiVersion: relation.targetApiVersion,
      kind: relation.targetKind,
      name: relation.targetName,
    });
    const handlers = version?.spec.handlers;
    if (
      !version ||
      version.metadata.uid !== relation.targetUid ||
      !Array.isArray(handlers) ||
      !handlers.includes(handler)
    ) {
      return false;
    }
  }
  return true;
}

function condition(
  status: "True" | "False",
  reason: TakoformCondition["reason"],
  hostReason?: string,
): TakoformCondition {
  if (hostReason !== undefined && hostReason.length > 256) {
    throw new TypeError("worker aggregate host reason is too long");
  }
  return {
    type: "Ready",
    status,
    reason,
    ...(hostReason ? { hostReason } : {}),
    lastTransitionTime: "",
  };
}
