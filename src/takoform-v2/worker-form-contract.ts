import { CONTAINER_CONTRACT, V2_CONTAINER_F2_FORM } from "../container-contract.ts";

/** Neutral Worker Form identities and closed selection data; no parser, state or native imports. */
export const MODULE_WORKER_FORM_URL =
  "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/" as const;
export const WORKER_VERSION_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/" as const;
export const WORKER_DEPLOYMENT_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/" as const;
export const WORKER_ENDPOINT_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/" as const;
export const FORWARD_WORKER_VERSION_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerVersion/0.7.0/" as const;
export const FORWARD_WORKER_DEPLOYMENT_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerDeployment/0.6.0/" as const;
/** Accepted reference vocabulary only; Container runtime remains separately owned. */
export const CONTAINER_WORKER_VERSION_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerVersion/0.6.0/" as const;
export const CONTAINER_WORKER_DEPLOYMENT_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerDeployment/0.5.0/" as const;

/**
 * WorkerVersion 0.8.0 / WorkerDeployment 0.7.0: the 0.7.0 / 0.6.0 execution ABI with
 * `containerBindings` allowed to reference Container 0.1.0 or Container 0.2.0 per
 * binding. These are NEW identities. The 0.7.0 / 0.6.0 constants and their sealed
 * references are deliberately untouched, so an existing accepted snapshot is never
 * reinterpreted as a Container 0.2.0 consumer.
 */
export const CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerVersion/0.8.0/" as const;
export const CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerDeployment/0.7.0/" as const;
export const CONTAINER_0_1_FORM_URL = CONTAINER_CONTRACT.formUrl;
export const CONTAINER_0_2_FORM_URL = V2_CONTAINER_F2_FORM;

/** The only exact target Forms a WorkerVersion 0.8.0 containerBinding may be sealed against. */
export const CONTAINER_CONSUMER_TARGET_FORM_URLS = Object.freeze([
  CONTAINER_0_1_FORM_URL,
  CONTAINER_0_2_FORM_URL,
] as const);
export type ContainerConsumerTargetFormUrl = (typeof CONTAINER_CONSUMER_TARGET_FORM_URLS)[number];

export function isContainerConsumerTargetFormUrl(
  value: unknown,
): value is ContainerConsumerTargetFormUrl {
  return (
    typeof value === "string" &&
    (CONTAINER_CONSUMER_TARGET_FORM_URLS as readonly string[]).includes(value)
  );
}

/** Every WorkerVersion Form a WorkerDeployment 0.7.0 weight may name; never converted. */
export const CONTAINER_CONSUMER_DEPLOYMENT_VERSION_FORM_URLS = Object.freeze([
  WORKER_VERSION_FORM_URL,
  CONTAINER_WORKER_VERSION_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
] as const);

/**
 * The closed forward family: both WorkerVersion Forms that use the 0.7.0 spec grammar and
 * execution ABI, and both WorkerDeployment Forms that select them. Membership is by exact
 * URL; nothing here is a prefix, version-range or caller-supplied match.
 */
export const FORWARD_FAMILY_WORKER_VERSION_FORM_URLS = Object.freeze([
  FORWARD_WORKER_VERSION_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
] as const);
export const FORWARD_FAMILY_WORKER_DEPLOYMENT_FORM_URLS = Object.freeze([
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
] as const);
export type ForwardFamilyWorkerVersionFormUrl =
  (typeof FORWARD_FAMILY_WORKER_VERSION_FORM_URLS)[number];
export type ForwardFamilyWorkerDeploymentFormUrl =
  (typeof FORWARD_FAMILY_WORKER_DEPLOYMENT_FORM_URLS)[number];

export function isForwardFamilyWorkerVersionForm(
  value: unknown,
): value is ForwardFamilyWorkerVersionFormUrl {
  return (
    typeof value === "string" &&
    (FORWARD_FAMILY_WORKER_VERSION_FORM_URLS as readonly string[]).includes(value)
  );
}

export function isForwardFamilyWorkerDeploymentForm(
  value: unknown,
): value is ForwardFamilyWorkerDeploymentFormUrl {
  return (
    typeof value === "string" &&
    (FORWARD_FAMILY_WORKER_DEPLOYMENT_FORM_URLS as readonly string[]).includes(value)
  );
}

/**
 * Every WorkerDeployment Form that can occupy a Worker's single self-host publication slot.
 * The single-active fence and every publication reader share this one list, so a new
 * Deployment Form cannot be fenced in one place and invisible in another.
 */
export const WORKER_DEPLOYMENT_SLOT_FORM_URLS = Object.freeze([
  WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
] as const);

/** The WorkerVersion Forms a Deployment Form may select. A Deployment never converts one. */
export function selectableWorkerVersionForms(deploymentForm: string): readonly string[] | null {
  switch (deploymentForm) {
    case WORKER_DEPLOYMENT_FORM_URL:
      return [WORKER_VERSION_FORM_URL];
    case FORWARD_WORKER_DEPLOYMENT_FORM_URL:
      return [WORKER_VERSION_FORM_URL, FORWARD_WORKER_VERSION_FORM_URL];
    case CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL:
      return [
        WORKER_VERSION_FORM_URL,
        FORWARD_WORKER_VERSION_FORM_URL,
        CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      ];
    default:
      return null;
  }
}
