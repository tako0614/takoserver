import type { JsonObject } from "../ports.ts";
import { isEdgeFormsApiVersion } from "./edge-family.ts";
import { exclusiveRelationClaimKey, type TakoformStoredRelation } from "./relations.ts";
import type { TakoformStore } from "./store.ts";
import type { TakoformCondition, TakoformStoredResource } from "./types.ts";
import {
  crossResourcePrecondition,
  type InstalledTakoformForm,
  TakoformHostError,
} from "./types.ts";

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
const DEPENDENT_SOURCES: readonly (readonly [string, string, string])[] = [
  ["WorkerCustomDomain", WORKER_RELATION, "fetch"],
  ["WorkerEndpoint", WORKER_RELATION, "fetch"],
  ["WorkerCronTrigger", WORKER_RELATION, "scheduled"],
  ["QueueConsumer", WORKER_RELATION, "queue"],
  ["WorkerVersion", SERVICE_BINDING_RELATION, "fetch"],
];

/**
 * How long this Host waits for a neighbour the same apply wave is still
 * creating or deleting.
 *
 * One `tofu apply` sends the resources of a wave in parallel and orders only
 * what the graph declares an edge for. A `WorkerEndpoint` and the
 * `WorkerDeployment` that makes its Worker serve carry no such edge — both
 * point at the ModuleWorker — so the endpoint routinely asks "does this Worker
 * serve fetch" a few hundred milliseconds before the answer becomes yes, and
 * the deployment's delete routinely asks "is anything still attached" a few
 * hundred milliseconds before the endpoint's own delete has landed. Neither is
 * a defect in the declaration; both are ordering inside one wave.
 *
 * The budget is shaped like the runtime's own readiness probe: it is spent
 * while nothing is provably in flight, and a sighting of the neighbour starts
 * it again under a ceiling, so a wave that really is working is waited for and
 * a graph that declared nothing is refused promptly rather than held open.
 */
export interface TakoformWaveSettlement {
  /** Wall clock, never a logical one: this budget is real elapsed time. */
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pollMilliseconds: number;
  readonly idleMilliseconds: number;
  readonly ceilingMilliseconds: number;
}

export const DEFAULT_WAVE_SETTLEMENT: TakoformWaveSettlement = Object.freeze({
  now: () => Date.now(),
  sleep: (milliseconds: number) =>
    new Promise<void>((wake) => {
      setTimeout(wake, milliseconds);
    }),
  pollMilliseconds: 25,
  idleMilliseconds: 1_000,
  ceilingMilliseconds: 10_000,
});

/**
 * Waits for one question to settle while somebody else in the wave answers it.
 *
 * `settled` is the question; `progressing` is the evidence that another command
 * in this wave is still working on it. Returns whether it settled.
 */
async function awaitWave(
  wave: TakoformWaveSettlement,
  settled: () => Promise<boolean>,
  progressing: () => Promise<boolean>,
): Promise<boolean> {
  if (await settled()) return true;
  const ceiling = wave.now() + wave.ceilingMilliseconds;
  let idle = wave.now() + wave.idleMilliseconds;
  for (;;) {
    if (await progressing()) idle = wave.now() + wave.idleMilliseconds;
    if (wave.now() >= idle || wave.now() >= ceiling) return false;
    await wave.sleep(wave.pollMilliseconds);
    if (await settled()) return true;
  }
}

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
    | "hostnameClaims"
    | "queuePathReaches"
    | "resourcesByRelation"
    | "readResource"
    | "readRelations"
    | "resourceClaimHolder"
    | "committedResourceClaimHolder"
  >;
  readonly wave?: TakoformWaveSettlement;
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
      throw crossResourcePrecondition({
        message: `another WorkerDeployment already serves the ModuleWorker ${worker.targetName}; delete it first, then apply again`,
      });
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
        throw crossResourcePrecondition({
          message: `the WorkerVersion ${relation.targetName} this WorkerDeployment selects belongs to a different ModuleWorker than ${worker.targetName}; point it at this ModuleWorker, then apply again`,
        });
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
      await requireServingWorker(input, relation, "fetch", edgeApiVersion);
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
      throw crossResourcePrecondition({
        details: { holder: holder.name },
        message: `the hostname this WorkerCustomDomain claims is already claimed by ${holder.name}; release it there, then apply again`,
      });
    }
  }
  const worker = input.relations.find((relation) => relation.relation === WORKER_RELATION);
  if (!worker) throw new TakoformHostError("invalid_argument", 400);
  await requireServingWorker(input, worker, handler, edgeApiVersion);
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
      throw crossResourcePrecondition({
        message: `another WorkerEndpoint already activates the ModuleWorker ${worker.targetName}; delete it first, then apply again`,
      });
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
      throw crossResourcePrecondition({
        message: `the dead-letter queue this QueueConsumer names already reaches its own queue through other QueueConsumers; break that cycle, then apply again`,
      });
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
      throw crossResourcePrecondition({
        message: `another QueueConsumer already consumes the Queue ${queue.targetName}; delete it first, then apply again`,
      });
    }
  }
}

/**
 * Refuses an inward activation whose target Worker is not serving the handler.
 *
 * The refusal is about *what is missing*, which is two different facts and was
 * one wrong answer. A Worker for which nothing declares a `WorkerDeployment` is
 * a precondition the operator has to fix in the configuration; a Worker whose
 * deployment has simply not landed yet is ordering inside one apply wave, cured
 * by the wave itself and, failing that, by asking again. Neither is a Host
 * capability that does not exist, which is what this used to say — sending an
 * operator to "apply against a host whose Host Support Profile declares it"
 * while the only thing missing was a deployment their own graph creates.
 *
 * The definitive half is still definitive — `invalid_argument` 400, not
 * retryable, surfaced to the operator now — but it is a
 * `crossResourcePrecondition`, because what makes it true is a *neighbour*.
 * Adding the missing `WorkerDeployment` changes nothing in this endpoint's
 * plan, so the cured `tofu apply` arrives under the identical plan-derived
 * idempotency key, and a Host that replayed the stored refusal would hand back
 * an answer that stopped being true the moment the deployment landed.
 */
async function requireServingWorker(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly store: Pick<
      TakoformStore,
      | "resourcesByRelation"
      | "readResource"
      | "resourceClaimHolder"
      | "committedResourceClaimHolder"
    >;
    readonly wave?: TakoformWaveSettlement;
  },
  worker: TakoformStoredRelation,
  handler: string,
  edgeApiVersion: string,
): Promise<void> {
  const settled = await awaitWave(
    input.wave ?? DEFAULT_WAVE_SETTLEMENT,
    () => workerServes(input, worker.targetUid, handler, edgeApiVersion),
    () => workerDeploymentInFlight(input, worker.targetUid, edgeApiVersion),
  );
  if (settled) return;
  const deployments = await input.store.resourcesByRelation({
    tenantId: input.tenantId,
    space: input.space,
    sourceApiVersion: edgeApiVersion,
    sourceKind: WORKER_DEPLOYMENT,
    relation: WORKER_RELATION,
    targetUid: worker.targetUid,
    limit: 2,
  });
  if (deployments.length === 0) {
    throw crossResourcePrecondition({
      message: `the ModuleWorker ${worker.targetName} has no WorkerDeployment, so nothing serves its ${handler} handler; declare a WorkerDeployment that selects a WorkerVersion serving ${handler}, then apply again`,
    });
  }
  throw new TakoformHostError(
    "resource_busy",
    409,
    undefined,
    `the ModuleWorker ${worker.targetName} has no serving deployment yet: no WorkerDeployment of it currently selects a WorkerVersion that serves ${handler}; apply again once that deployment is Ready`,
  );
}

/**
 * Whether another command is creating this Worker's `WorkerDeployment` now.
 *
 * The deployment Form declares `exclusive` on `/worker`, so a create reserves
 * that canonical claim before it awaits its provider and commits it with the
 * Resource. A reserved-but-uncommitted holder is therefore exactly "somebody in
 * this wave is making this Worker serve"; a committed one is a deployment that
 * already exists, which `workerServes` answers on its own.
 */
async function workerDeploymentInFlight(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly store: Pick<TakoformStore, "resourceClaimHolder" | "committedResourceClaimHolder">;
  },
  workerUid: string,
  edgeApiVersion: string,
): Promise<boolean> {
  const key = await exclusiveRelationClaimKey({
    tenantId: input.tenantId,
    space: input.space,
    apiVersion: edgeApiVersion,
    kind: WORKER_DEPLOYMENT,
    reference: WORKER_RELATION,
    targetUid: workerUid,
  });
  if ((await input.store.resourceClaimHolder(key)) === null) return false;
  return (await input.store.committedResourceClaimHolder(key)) === null;
}

/**
 * A live attachment or inbound service binding keeps its serving deployment
 * alive — but one that is itself being deleted in this wave is not live.
 *
 * `tofu destroy` orders only what the graph declares an edge for, and a
 * `WorkerEndpoint` names the ModuleWorker rather than the deployment, so the
 * two deletes run at once. Answering that as `dependency_in_use` said "the
 * resource gained a blocking dependency" about a holder that was in the act of
 * going away and had gone by the time the operator read the sentence, and the
 * code is not retryable, so the destroy stopped on a condition that had already
 * cured itself. A holder whose own deletion is under way is waited for; a
 * holder nobody is deleting is still the blocking dependency it always was.
 */
export async function validateWorkerDeploymentRemoval(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly form: InstalledTakoformForm;
  readonly relations: readonly TakoformStoredRelation[];
  readonly store: Pick<TakoformStore, "resourcesByRelation" | "readResourceDeletion">;
  readonly wave?: TakoformWaveSettlement;
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
  const edgeApiVersion = input.form.identity.formRef.apiVersion;
  const holders = (): Promise<readonly WorkerDependent[]> =>
    workerDependents(input, worker.targetUid, edgeApiVersion);
  const settled = await awaitWave(
    input.wave ?? DEFAULT_WAVE_SETTLEMENT,
    async () => (await holders()).length === 0,
    async () => (await departing(input, await holders())).departing !== undefined,
  );
  if (settled) return;
  const remaining = await departing(input, await holders());
  if (remaining.blocking) {
    throw new TakoformHostError(
      "dependency_in_use",
      409,
      undefined,
      `${remaining.blocking.kind} ${remaining.blocking.name} still activates the ModuleWorker this WorkerDeployment serves and is not being deleted; remove it first, then delete this WorkerDeployment`,
    );
  }
  if (!remaining.departing) return;
  throw new TakoformHostError(
    "resource_busy",
    409,
    undefined,
    `${remaining.departing.kind} ${remaining.departing.name} still activates the ModuleWorker this WorkerDeployment serves and its own deletion has not settled yet; delete this WorkerDeployment again once that one is gone`,
  );
}

interface WorkerDependent {
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  readonly handler: string;
}

/**
 * Splits the holders into the one that blocks and the one that is leaving.
 *
 * A holder whose deletion attestation is `pending` has had its delete accepted
 * and its provider effect planned; it is a command in flight, not a relation
 * somebody intends to keep.
 */
async function departing(
  input: {
    readonly tenantId: string;
    readonly store: Pick<TakoformStore, "readResourceDeletion">;
  },
  holders: readonly WorkerDependent[],
): Promise<{
  readonly blocking?: WorkerDependent;
  readonly departing?: WorkerDependent;
}> {
  let blocking: WorkerDependent | undefined;
  let leaving: WorkerDependent | undefined;
  for (const holder of holders) {
    const attestation = await input.store.readResourceDeletion(input.tenantId, holder.uid);
    if (attestation?.state === "pending") leaving ??= holder;
    else blocking ??= holder;
  }
  return {
    ...(blocking ? { blocking } : {}),
    ...(leaving ? { departing: leaving } : {}),
  };
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
  return new Set(
    (await workerDependents(input, workerUid, edgeApiVersion)).map((entry) => entry.handler),
  );
}

/** Every resource whose inward activation this Worker's deployment must serve. */
async function workerDependents(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly store: Pick<TakoformStore, "resourcesByRelation">;
  },
  workerUid: string,
  edgeApiVersion: string,
): Promise<readonly WorkerDependent[]> {
  const found: WorkerDependent[] = [];
  for (const [sourceKind, relation, handler] of DEPENDENT_SOURCES) {
    const dependents = await input.store.resourcesByRelation({
      tenantId: input.tenantId,
      space: input.space,
      sourceApiVersion: edgeApiVersion,
      sourceKind,
      relation,
      targetUid: workerUid,
      limit: 2,
    });
    for (const dependent of dependents) {
      found.push({
        kind: sourceKind,
        name: dependent.resource.metadata.name,
        uid: dependent.resource.metadata.uid,
        handler,
      });
    }
  }
  return found;
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
