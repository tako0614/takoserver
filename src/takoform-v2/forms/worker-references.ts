import type { V2ReferenceRequirement } from "../types.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "./static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "./worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  type ModuleWorkerSpec,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
  type WorkerDeploymentSpec,
  type WorkerEndpointSpec,
  WorkerFormValidationError,
  type WorkerVersionBinding,
  type WorkerVersionSpec,
} from "./worker-specs.ts";

const BINDING_FORMS = {
  kvBindings: "https://edge.forms.takoform.com/forms/EdgeKVNamespace/0.2.0/",
  sqliteBindings: "https://edge.forms.takoform.com/forms/SQLiteDatabase/0.2.0/",
  bucketBindings: "https://edge.forms.takoform.com/forms/ObjectBucket/0.2.0/",
  queueProducerBindings: "https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/",
  serviceBindings: MODULE_WORKER_FORM_URL,
  actorBindings: "https://edge.forms.takoform.com/forms/ActorNamespace/0.3.0/",
  workflowBindings: "https://edge.forms.takoform.com/forms/DurableWorkflow/0.3.0/",
} as const;

/** ModuleWorker is an owner identity only; it declares no outbound references. */
export function referencesForModuleWorker(
  _spec: ModuleWorkerSpec,
): readonly V2ReferenceRequirement[] {
  return [];
}

/**
 * Return every direct WorkerVersion reference as exact UID/Form requirements.
 * `observed` is intentionally used for artifacts and bindings: declaration does
 * not claim ready state or capability, which belongs to later resolution.
 */
export function referencesForWorkerVersion(
  spec: WorkerVersionSpec,
): readonly V2ReferenceRequirement[] {
  const requirements: V2ReferenceRequirement[] = [
    observed(spec.worker.resourceUid, MODULE_WORKER_FORM_URL),
  ];

  if (spec.bundle) {
    requirements.push(observed(spec.bundle.resourceUid, WORKER_BUNDLE_FORM_URL));
  }
  if (spec.assets) {
    requirements.push(observed(spec.assets.bundle.resourceUid, STATIC_ASSET_BUNDLE_FORM_URL));
  }

  for (const key of Object.keys(BINDING_FORMS) as (keyof typeof BINDING_FORMS)[]) {
    const formUrl = BINDING_FORMS[key];
    for (const binding of spec[key] as readonly WorkerVersionBinding[]) {
      requirements.push(observed(binding.resource.resourceUid, formUrl));
    }
  }

  return normalizeRequirements(requirements);
}

/**
 * A Deployment binds exact WorkerVersion UIDs and their observed worker owner.
 * The target spec match prevents a deployment from crossing ModuleWorker owners.
 */
export function referencesForWorkerDeployment(
  spec: WorkerDeploymentSpec,
): readonly V2ReferenceRequirement[] {
  const requirements: V2ReferenceRequirement[] = [
    observed(spec.worker.resourceUid, MODULE_WORKER_FORM_URL),
    ...spec.versions.map(
      ({ workerVersion }): V2ReferenceRequirement => ({
        resourceUid: workerVersion.resourceUid,
        formUrl: WORKER_VERSION_FORM_URL,
        readiness: "ready",
        targetSpecMatch: {
          path: ["worker", "resourceUid"],
          equals: spec.worker.resourceUid,
        },
      }),
    ),
  ];
  return normalizeRequirements(requirements);
}

/** Endpoint targets an exact observed ModuleWorker; routing is a separate concern. */
export function referencesForWorkerEndpoint(
  spec: WorkerEndpointSpec,
): readonly V2ReferenceRequirement[] {
  return [observed(spec.worker.resourceUid, MODULE_WORKER_FORM_URL)];
}

/**
 * Parse and declare the complete direct reference set for one exact Worker Form.
 * This is a pure helper, not a Form registry or a resource resolver.
 */
export function referencesForWorkerForm(
  formUrl: string,
  input: unknown,
): readonly V2ReferenceRequirement[] {
  switch (formUrl) {
    case MODULE_WORKER_FORM_URL:
      return referencesForModuleWorker(parseModuleWorkerSpec(input));
    case WORKER_VERSION_FORM_URL:
      return referencesForWorkerVersion(parseWorkerVersionSpec(input));
    case WORKER_DEPLOYMENT_FORM_URL:
      return referencesForWorkerDeployment(parseWorkerDeploymentSpec(input));
    case WORKER_ENDPOINT_FORM_URL:
      return referencesForWorkerEndpoint(parseWorkerEndpointSpec(input));
    default:
      throw new WorkerFormValidationError();
  }
}

function observed(resourceUid: string, formUrl: string): V2ReferenceRequirement {
  return { resourceUid, formUrl, readiness: "observed" };
}

function normalizeRequirements(
  requirements: readonly V2ReferenceRequirement[],
): readonly V2ReferenceRequirement[] {
  const byUid = new Map<string, V2ReferenceRequirement>();
  for (const requirement of requirements) {
    const previous = byUid.get(requirement.resourceUid);
    if (!previous) {
      byUid.set(requirement.resourceUid, requirement);
      continue;
    }

    if (previous.formUrl !== requirement.formUrl) {
      throw new WorkerFormValidationError();
    }
    const targetSpecMatch = mergeTargetSpecMatch(
      previous.targetSpecMatch,
      requirement.targetSpecMatch,
    );
    byUid.set(requirement.resourceUid, {
      resourceUid: requirement.resourceUid,
      formUrl: requirement.formUrl,
      readiness:
        previous.readiness === "ready" || requirement.readiness === "ready" ? "ready" : "observed",
      ...(targetSpecMatch ? { targetSpecMatch } : {}),
    });
  }
  return [...byUid.values()].sort((left, right) =>
    left.resourceUid < right.resourceUid ? -1 : left.resourceUid > right.resourceUid ? 1 : 0,
  );
}

function mergeTargetSpecMatch(
  left: V2ReferenceRequirement["targetSpecMatch"],
  right: V2ReferenceRequirement["targetSpecMatch"],
): V2ReferenceRequirement["targetSpecMatch"] {
  if (!left) return right;
  if (!right) return left;
  const samePath =
    left.path.length === right.path.length &&
    left.path.every((part, index) => part === right.path[index]);
  if (!samePath || left.equals !== right.equals) {
    throw new WorkerFormValidationError();
  }
  return left;
}
