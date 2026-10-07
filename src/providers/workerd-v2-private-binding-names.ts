/**
 * The v2 Host-private native names live outside WorkerVersion 0.5.0's public
 * 64-character name grammar. The persisted entrypoint selects this profile;
 * older publications keep their original native names during recovery.
 */
export const WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE =
  "__takoserver-selfhost-entrypoint-v2-private-names.js" as const;

export function hasWorkerdV2PrivateBindingProfile(site: {
  readonly hostEntrypoint?: string;
  readonly hostModules?: readonly string[];
}): boolean {
  return (
    site.hostEntrypoint === WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE ||
    site.hostModules?.includes(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE) === true
  );
}

export const WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING =
  "__TAKOSERVER_V2_PRIVATE_SELFHOST_DATA_SERVICE_BINDING_000000000000000000000" as const;

export const WORKERD_V2_PRIVATE_KV_BINDING =
  "__TAKOSERVER_V2_PRIVATE_KV_SERVICE_000000000000000000000" as const;

export const WORKERD_V2_PRIVATE_READINESS_BINDING =
  "__TAKOSERVER_V2_PRIVATE_RUNTIME_READINESS_CAPABILITY_000000000000000000000" as const;

export const WORKERD_V2_PRIVATE_QUEUE_SETTLEMENT_BINDING =
  "__TAKOSERVER_V2_PRIVATE_QUEUE_SETTLEMENT_SERVICE_000000000000000000000" as const;

export const WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING =
  "__TAKOSERVER_V2_PRIVATE_OBJECT_BUCKET_SERVICE_000000000000000000000" as const;
export const WORKERD_V2_PRIVATE_OBJECT_BUCKET_ORIGIN_BINDING =
  "__TAKOSERVER_V2_PRIVATE_OBJECT_BUCKET_ORIGIN_000000000000000000000" as const;
export const WORKERD_V2_PRIVATE_OBJECT_BUCKET_TOKEN_BINDING =
  "__TAKOSERVER_V2_PRIVATE_OBJECT_BUCKET_TOKEN_000000000000000000000" as const;

const SERVICE_BINDING_PREFIX =
  "__TAKOSERVER_V2_PRIVATE_SELFHOST_SERVICE_BINDING_000000000000000000000_" as const;
const ACTOR_HTTP_BINDING_PREFIX =
  "__TAKOSERVER_V2_PRIVATE_ACTOR_HTTP_SERVICE_BINDING_000000000000000000000_" as const;
const ACTOR_UPGRADE_BINDING_PREFIX =
  "__TAKOSERVER_V2_PRIVATE_ACTOR_UPGRADE_SERVICE_BINDING_000000000000000000000_" as const;
const WORKFLOW_BINDING_PREFIX =
  "__TAKOSERVER_V2_PRIVATE_WORKFLOW_SERVICE_BINDING_000000000000000000000_" as const;

export function workerdV2PrivateServiceBindingName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 99_999) {
    throw new TypeError("invalid private service binding index");
  }
  return `${SERVICE_BINDING_PREFIX}${index.toString(10).padStart(5, "0")}`;
}

export function isWorkerdV2PrivateServiceBindingName(name: string): boolean {
  return (
    name.startsWith(SERVICE_BINDING_PREFIX) &&
    /^[0-9]{5}$/u.test(name.slice(SERVICE_BINDING_PREFIX.length))
  );
}

export function workerdV2PrivateActorBindingName(kind: "HTTP" | "UPGRADE", index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 99_999) {
    throw new TypeError("invalid private Actor binding index");
  }
  const prefix = kind === "HTTP" ? ACTOR_HTTP_BINDING_PREFIX : ACTOR_UPGRADE_BINDING_PREFIX;
  return `${prefix}${index.toString(10).padStart(5, "0")}`;
}

export function workerdV2PrivateWorkflowBindingName(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 99_999) {
    throw new TypeError("invalid private Workflow binding index");
  }
  return `${WORKFLOW_BINDING_PREFIX}${index.toString(10).padStart(5, "0")}`;
}

export function isWorkerdV2PrivateWorkflowBindingName(name: string): boolean {
  return (
    name.startsWith(WORKFLOW_BINDING_PREFIX) &&
    /^[0-9]{5}$/u.test(name.slice(WORKFLOW_BINDING_PREFIX.length))
  );
}

export function workerdV2PrivateWorkflowBindingIndex(name: string): number | null {
  return isWorkerdV2PrivateWorkflowBindingName(name)
    ? Number.parseInt(name.slice(WORKFLOW_BINDING_PREFIX.length), 10)
    : null;
}
