import { canonicalJson, isSha256Digest } from "../json.ts";
import type {
  WorkerClassInspectionInput,
  WorkerClassResourceIdentity,
  WorkerClassRuntime,
  WorkerClassRuntimeContract,
} from "../worker-class-runtime-port.ts";
import { sameFormRef } from "./forms.ts";
import type { TakoformStoredRelation } from "./relations.ts";
import type { ResourceWithRelations, TakoformStore } from "./store.ts";
import {
  type InstalledTakoformForm,
  type TakoformCondition,
  TakoformHostError,
  type TakoformStoredResource,
} from "./types.ts";

/**
 * Form-provided worker classes are not executable in the control process.
 * Their semantic loading belongs to the provider execution path. Only an
 * explicitly registered exact ABI may allocate an identity; allocation is not
 * class readiness and does not require a deployment that binds the identity.
 */
export function validateClassHolderRuntime(
  form: InstalledTakoformForm,
  runtime?: Pick<WorkerClassRuntime, "contracts">,
): void {
  if (!supportsClassHolderRuntime(form, runtime)) {
    throw new TakoformHostError("unsupported_capability", 422);
  }
}

export function supportsClassHolderRuntime(
  form: InstalledTakoformForm,
  runtime?: Pick<WorkerClassRuntime, "contracts">,
): boolean {
  return !form.workerClassRuntime || classContract(form, runtime) !== null;
}

function classContract(
  form: InstalledTakoformForm,
  runtime?: Pick<WorkerClassRuntime, "contracts">,
): WorkerClassRuntimeContract | null {
  const ref = form.workerClassRuntime?.runtimeClassRef;
  if (
    !ref ||
    !isSha256Digest(ref.schemaDigest) ||
    !isSha256Digest(form.identity.packageDigest) ||
    ref.name !== form.workerClassRuntime?.providedInterface ||
    !form.providedInterfaces?.some((provided) => canonicalJson(provided) === canonicalJson(ref))
  )
    return null;
  return (
    runtime?.contracts.find(
      (contract) =>
        sameFormRef(contract.formRef, form.identity.formRef) &&
        contract.packageDigest === form.identity.packageDigest &&
        canonicalJson(contract.runtimeClassRef) === canonicalJson(ref),
    ) ?? null
  );
}

type ClassGraphStore = Pick<TakoformStore, "resourceWithRelationsByUid" | "resourcesByRelation">;

/** Recomputed, value-free readiness. Stored Ready=True never substitutes for inspection. */
export async function workerClassCondition(input: {
  readonly tenantId: string;
  readonly resource: TakoformStoredResource;
  readonly form: InstalledTakoformForm;
  readonly store: ClassGraphStore;
  readonly runtime?: WorkerClassRuntime;
}): Promise<TakoformCondition | null> {
  if (!input.form.workerClassRuntime) return null;
  const contract = classContract(input.form, input.runtime);
  if (!contract || !input.runtime) return condition("False", "UnsupportedCapability");
  const before = await readGraph(input, contract);
  if (!before) return condition("False", "Provisioning");
  let verdict: unknown;
  try {
    verdict = await input.runtime.inspect(structuredClone(before));
  } catch {
    return condition("False", "Provisioning", "BackendUnavailable");
  }
  if (verdict !== "valid") {
    return verdict === "invalid"
      ? condition("False", "UnsupportedCapability")
      : condition("False", "Provisioning", "BackendUnavailable");
  }
  // Class inspection may take time. Never publish its answer for a changed
  // holder, active deployment, weight set, Version, or artifact identity.
  const after = await readGraph(input, contract);
  return after && canonicalJson(before) === canonicalJson(after)
    ? condition("True", "Available")
    : condition("False", "Provisioning");
}

async function readGraph(
  input: {
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
    readonly form: InstalledTakoformForm;
    readonly store: ClassGraphStore;
  },
  contract: WorkerClassRuntimeContract,
): Promise<readonly WorkerClassInspectionInput[] | null> {
  const vocabulary = input.form.workerClassRuntime;
  if (!vocabulary) return null;
  const holder = await input.store.resourceWithRelationsByUid(
    input.tenantId,
    input.resource.metadata.uid,
  );
  if (
    !holder ||
    holder.listing.resource.form.packageDigest !== contract.packageDigest ||
    holder.listing.resource.metadata.generation !== input.resource.metadata.generation ||
    !sameFormRef(holder.listing.resource.form.formRef, input.resource.form.formRef) ||
    canonicalJson(holder.listing.resource.spec) !== canonicalJson(input.resource.spec)
  )
    return null;
  const resource = holder.listing.resource;
  const className = pointer(resource.spec, vocabulary.className);
  if (typeof className !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(className)) return null;
  const workerRelation = soleRelation(holder.relations, vocabulary.workerRelation);
  const worker = workerRelation && (await readTarget(input, workerRelation));
  if (!worker) return null;
  const deployments = await input.store.resourcesByRelation({
    tenantId: input.tenantId,
    space: resource.metadata.space,
    sourceApiVersion: vocabulary.deploymentForm.apiVersion,
    sourceKind: vocabulary.deploymentForm.kind,
    relation: vocabulary.deploymentWorkerRelation,
    targetUid: worker.listing.uid,
    limit: 2,
  });
  const deployment = deployments[0];
  if (
    deployments.length !== 1 ||
    !deployment ||
    deployment.resource.metadata.space !== resource.metadata.space ||
    deployment.resource.apiVersion !== vocabulary.deploymentForm.apiVersion ||
    deployment.resource.kind !== vocabulary.deploymentForm.kind
  )
    return null;
  const deploymentWorker = soleRelation(deployment.relations, vocabulary.deploymentWorkerRelation);
  if (deploymentWorker?.targetUid !== worker.listing.uid) return null;
  // This software adapter implements the existing weighted WorkerDeployment
  // vocabulary, not an interpreter for arbitrary provider-defined graphs.
  if (vocabulary.deploymentVersionRelation !== "/versions/*/workerVersion") return null;
  const weights = deployment.resource.spec.versions;
  if (!Array.isArray(weights) || weights.length === 0 || weights.length > 100) return null;
  const selected = deployment.relations.filter(
    (relation) => relation.relation === vocabulary.deploymentVersionRelation,
  );
  if (
    selected.length !== weights.length ||
    new Set(selected.map((relation) => relation.targetUid)).size !== selected.length
  )
    return null;
  let total = 0;
  const result: WorkerClassInspectionInput[] = [];
  for (let index = 0; index < weights.length; index += 1) {
    const entry = weights[index];
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !Number.isSafeInteger(entry.weight) ||
      typeof entry.weight !== "number" ||
      entry.weight < 0
    )
      return null;
    total += entry.weight;
    const relation = selected.find(
      (candidate) => candidate.pointer === `/versions/${index}/workerVersion`,
    );
    const version = relation && (await readTarget(input, relation));
    if (!version) return null;
    const owner = soleRelation(version.relations, vocabulary.deploymentWorkerRelation);
    if (owner?.targetUid !== worker.listing.uid) return null;
    if (entry.weight === 0) continue;
    const bundleRelation = soleRelation(version.relations, vocabulary.versionBundleRelation);
    const bundle = bundleRelation && (await readTarget(input, bundleRelation));
    const manifestDigest = bundle?.listing.resource.spec.manifestDigest;
    if (!bundle || !isSha256Digest(manifestDigest)) return null;
    result.push({
      contract,
      tenantId: input.tenantId,
      space: resource.metadata.space,
      className,
      holder: facts(resource),
      worker: facts(worker.listing.resource),
      deployment: facts(deployment.resource),
      version: facts(version.listing.resource),
      weight: entry.weight,
      bundle: { ...facts(bundle.listing.resource), manifestDigest },
    });
  }
  if (total !== 10_000 || result.length === 0) return null;
  return result;
}

async function readTarget(
  input: {
    readonly tenantId: string;
    readonly resource: TakoformStoredResource;
    readonly store: ClassGraphStore;
  },
  relation: TakoformStoredRelation,
): Promise<ResourceWithRelations | null> {
  const target = await input.store.resourceWithRelationsByUid(input.tenantId, relation.targetUid);
  if (!target) return null;
  const resource = target.listing.resource;
  return resource.metadata.uid === relation.targetUid &&
    resource.metadata.space === input.resource.metadata.space &&
    resource.metadata.name === relation.targetName &&
    resource.apiVersion === relation.targetApiVersion &&
    resource.kind === relation.targetKind &&
    sameFormRef(resource.form.formRef, relation.targetFormRef)
    ? target
    : null;
}

function soleRelation(
  relations: readonly TakoformStoredRelation[],
  name: string,
): TakoformStoredRelation | null {
  const matches = relations.filter((relation) => relation.relation === name);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function facts(resource: TakoformStoredResource): WorkerClassResourceIdentity {
  return {
    uid: resource.metadata.uid,
    generation: resource.metadata.generation,
    revision: resource.metadata.revision,
    formRef: resource.form.formRef,
  };
}

function pointer(value: unknown, path: string): unknown {
  for (const part of path.slice(1).split("/")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return value;
}

function condition(
  status: "True" | "False",
  reason: NonNullable<TakoformCondition["reason"]>,
  hostReason?: string,
): TakoformCondition {
  // The engine stamps the transition only when the derived condition changes.
  return {
    type: "Ready",
    status,
    reason,
    ...(hostReason ? { hostReason } : {}),
    lastTransitionTime: "",
  };
}
