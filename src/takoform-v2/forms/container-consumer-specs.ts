import {
  type ForwardWorkerVersionSpec,
  parseForwardWorkerDeploymentSpec,
  parseForwardWorkerVersionSpec,
  validateForwardWorkerDeploymentUpdate,
  validateForwardWorkerVersionUpdate,
  type WorkerDeploymentSpec,
} from "./worker-specs.ts";

export {
  CONTAINER_0_1_FORM_URL,
  CONTAINER_0_2_FORM_URL,
  CONTAINER_CONSUMER_DEPLOYMENT_VERSION_FORM_URLS,
  CONTAINER_CONSUMER_TARGET_FORM_URLS,
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
  type ContainerConsumerTargetFormUrl,
  FORWARD_FAMILY_WORKER_DEPLOYMENT_FORM_URLS,
  FORWARD_FAMILY_WORKER_VERSION_FORM_URLS,
  type ForwardFamilyWorkerDeploymentFormUrl,
  type ForwardFamilyWorkerVersionFormUrl,
  isContainerConsumerTargetFormUrl,
  isForwardFamilyWorkerDeploymentForm,
  isForwardFamilyWorkerVersionForm,
  selectableWorkerVersionForms,
  WORKER_DEPLOYMENT_SLOT_FORM_URLS,
} from "../worker-form-contract.ts";

/** Version 0.8.0 keeps the 0.7.0 spec grammar; only the per-binding target Form set widens. */
export function parseContainerConsumerWorkerVersionSpec(input: unknown): ForwardWorkerVersionSpec {
  return parseForwardWorkerVersionSpec(input);
}

export function validateContainerConsumerWorkerVersionUpdate(
  previous: unknown,
  next: unknown,
): ForwardWorkerVersionSpec {
  return validateForwardWorkerVersionUpdate(previous, next);
}

/** Deployment 0.7.0 keeps the 0.6.0 spec grammar; the accepted Version Form set widens. */
export function parseContainerConsumerWorkerDeploymentSpec(input: unknown): WorkerDeploymentSpec {
  return parseForwardWorkerDeploymentSpec(input);
}

export function validateContainerConsumerWorkerDeploymentUpdate(
  previous: unknown,
  next: unknown,
): WorkerDeploymentSpec {
  return validateForwardWorkerDeploymentUpdate(previous, next);
}
