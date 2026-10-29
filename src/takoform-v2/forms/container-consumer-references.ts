import type { V2AdmissionPredicate, V2Form, V2ReferenceRequirement } from "../types.ts";
import {
  CONTAINER_CONSUMER_DEPLOYMENT_VERSION_FORM_URLS,
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  isContainerConsumerTargetFormUrl,
  parseContainerConsumerWorkerDeploymentSpec,
  parseContainerConsumerWorkerVersionSpec,
} from "./container-consumer-specs.ts";
import { selectObjectBucketBindingProfile } from "./object-bucket-binding-profile.ts";
import {
  fixedReferencesForForwardWorkerVersion,
  normalizeRequirements,
  observed,
  referencesForForwardWorkerVersion,
  referencesForWorkerVersion,
} from "./worker-references.ts";
import {
  FORWARD_WORKER_VERSION_FORM_URL,
  type ForwardWorkerVersionSpec,
  MODULE_WORKER_FORM_URL,
  type WorkerDeploymentSpec,
  WorkerFormValidationError,
} from "./worker-specs.ts";

type ConsumerAdmission = Parameters<NonNullable<V2Form["prepareAdmission"]>>[0];

/**
 * Bucket and Container bindings are variable: the target Form is chosen by the
 * accepted reference itself (ObjectBucket 0.2.0|0.3.0, Container 0.1.0|0.2.0) and
 * sealed per UID. Only the fixed vocabulary is declared statically.
 */
export function fixedReferencesForContainerConsumerWorkerVersion(
  spec: ForwardWorkerVersionSpec,
): readonly V2ReferenceRequirement[] {
  return referencesForWorkerVersion({ ...spec, bucketBindings: [] });
}

export function fixedReferencesForContainerConsumerWorkerDeployment(
  spec: WorkerDeploymentSpec,
): readonly V2ReferenceRequirement[] {
  return [observed(spec.worker.resourceUid, MODULE_WORKER_FORM_URL)];
}

/** Returns Core's issued predicate object directly; it is not transferable or copyable. */
export async function prepareContainerConsumerWorkerVersionReferences(
  input: ConsumerAdmission,
): Promise<V2AdmissionPredicate | null> {
  const prepare = input.prepareExactReferences;
  if (!prepare || input.form !== CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL) return null;
  const spec = parseContainerConsumerWorkerVersionSpec(input.spec);
  return prepare(async (lookup) => {
    const refs: V2ReferenceRequirement[] = [];
    for (const binding of spec.bucketBindings) {
      const target = await lookup(binding.resource.resourceUid);
      if (!target) return null;
      try {
        selectObjectBucketBindingProfile(target.formUrl);
      } catch {
        return null;
      }
      refs.push(observed(target.resourceUid, target.formUrl));
    }
    for (const binding of spec.containerBindings) {
      const target = await lookup(binding.resource.resourceUid);
      // Exact Form match only: no name, kind, "latest" or Form-version inference.
      if (!target || !isContainerConsumerTargetFormUrl(target.formUrl)) return null;
      refs.push(observed(target.resourceUid, target.formUrl));
    }
    return refs;
  });
}

export async function prepareContainerConsumerWorkerDeploymentReferences(
  input: ConsumerAdmission,
  admission: V2AdmissionPredicate,
): Promise<V2AdmissionPredicate | null> {
  const prepare = input.prepareExactReferences;
  if (!prepare || input.form !== CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL) return null;
  const spec = parseContainerConsumerWorkerDeploymentSpec(input.spec);
  return prepare(async (lookup) => {
    const refs: V2ReferenceRequirement[] = [];
    for (const { workerVersion } of spec.versions) {
      const target = await lookup(workerVersion.resourceUid);
      if (!target || !isConsumerDeploymentVersionForm(target.formUrl)) return null;
      refs.push({
        ...target,
        readiness: "ready",
        targetSpecMatch: { path: ["worker", "resourceUid"], equals: spec.worker.resourceUid },
      });
    }
    return refs;
  }, admission);
}

/** Reconstruct expectations from sealed rows, never from caller-selected profiles. */
export function referencesForContainerConsumerWorkerVersion(
  spec: ForwardWorkerVersionSpec,
  sealedTargets: readonly Readonly<{ resourceUid: string; formUrl: string }>[],
): readonly V2ReferenceRequirement[] {
  const refs = [...fixedReferencesForContainerConsumerWorkerVersion(spec)];
  const sealed = (resourceUid: string) => {
    const selected = sealedTargets.filter((row) => row.resourceUid === resourceUid);
    if (selected.length !== 1 || !selected[0]) throw new WorkerFormValidationError();
    return selected[0];
  };
  for (const binding of spec.bucketBindings) {
    const target = sealed(binding.resource.resourceUid);
    selectObjectBucketBindingProfile(target.formUrl);
    refs.push(observed(binding.resource.resourceUid, target.formUrl));
  }
  for (const binding of spec.containerBindings) {
    const target = sealed(binding.resource.resourceUid);
    if (!isContainerConsumerTargetFormUrl(target.formUrl)) throw new WorkerFormValidationError();
    refs.push(observed(binding.resource.resourceUid, target.formUrl));
  }
  return normalizeRequirements(refs);
}

export function referencesForContainerConsumerWorkerDeployment(
  spec: WorkerDeploymentSpec,
  sealedTargets: readonly Readonly<{ resourceUid: string; formUrl: string }>[],
): readonly V2ReferenceRequirement[] {
  return normalizeRequirements([
    ...fixedReferencesForContainerConsumerWorkerDeployment(spec),
    ...spec.versions.map(({ workerVersion }): V2ReferenceRequirement => {
      const matches = sealedTargets.filter((row) => row.resourceUid === workerVersion.resourceUid);
      const selected = matches.length === 1 ? matches[0] : undefined;
      if (!selected || !isConsumerDeploymentVersionForm(selected.formUrl))
        throw new WorkerFormValidationError();
      return {
        ...selected,
        readiness: "ready",
        targetSpecMatch: { path: ["worker", "resourceUid"], equals: spec.worker.resourceUid },
      };
    }),
  ]);
}

function isConsumerDeploymentVersionForm(value: string): boolean {
  return (CONTAINER_CONSUMER_DEPLOYMENT_VERSION_FORM_URLS as readonly string[]).includes(value);
}

/**
 * Sealed-row reconstruction for one forward-family WorkerVersion Form. The Form is the
 * accepted Resource's own, so a 0.7.0 Version can never be re-read under 0.8.0's wider
 * Container target set (and a Container 0.2.0 seal under 0.7.0 fails reconstruction).
 */
export function referencesForForwardFamilyWorkerVersion(
  versionForm: string,
  spec: ForwardWorkerVersionSpec,
  sealedTargets: readonly Readonly<{ resourceUid: string; formUrl: string }>[],
): readonly V2ReferenceRequirement[] {
  if (versionForm === FORWARD_WORKER_VERSION_FORM_URL)
    return referencesForForwardWorkerVersion(spec, sealedTargets);
  if (versionForm === CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL)
    return referencesForContainerConsumerWorkerVersion(spec, sealedTargets);
  throw new WorkerFormValidationError();
}

/** Fixed (non-variable) vocabulary for one forward-family WorkerVersion Form. */
export function fixedReferencesForForwardFamilyWorkerVersion(
  versionForm: string,
  spec: ForwardWorkerVersionSpec,
): readonly V2ReferenceRequirement[] {
  if (versionForm === FORWARD_WORKER_VERSION_FORM_URL)
    return fixedReferencesForForwardWorkerVersion(spec);
  if (versionForm === CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL)
    return fixedReferencesForContainerConsumerWorkerVersion(spec);
  throw new WorkerFormValidationError();
}
