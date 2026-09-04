import { isEdgeFormsApiVersion } from "../form-ref.ts";
import type { JsonObject } from "../ports.ts";
import {
  PROVIDER_READBACK_API_VERSION,
  type ProviderNativeReadbackDescriptor,
  type ProviderNativeReadbackInput,
  type ProviderOffering,
  ProviderReadbackDescriptorError,
} from "../provider-port.ts";

/** Placement is configuration, never an untrusted descriptor hint. */
export type CloudflareReadbackPlacement = "ordinary-workers" | "workers-for-platforms";

export type CloudflareNativeReadbackAddress =
  | {
      readonly kind: "r2" | "d1" | "kv" | "queue" | "worker" | "endpoint" | "domain";
      readonly name: string;
    }
  | {
      readonly kind: "version" | "deployment" | "cron" | "consumer";
      readonly parent: string;
      readonly name: string;
    };

type CloudflareManagedNativeReadbackAddress =
  | { readonly kind: "worker" | "endpoint" | "sqlite"; readonly name: string }
  | {
      readonly kind: "version" | "deployment" | "cron" | "consumer";
      readonly parent: string;
      readonly name: string;
    };

export type ValidatedCloudflareReadback =
  | {
      readonly placement: "ordinary-workers";
      readonly native: CloudflareNativeReadbackAddress;
    }
  | {
      readonly placement: "workers-for-platforms";
      readonly native: CloudflareManagedNativeReadbackAddress;
      readonly resourceUid: string;
    };

const MANAGED_FORM_NATIVE_KINDS = {
  ModuleWorker: "worker",
  WorkerVersion: "version",
  WorkerDeployment: "deployment",
  WorkerEndpoint: "endpoint",
  WorkerCronTrigger: "cron",
  QueueConsumer: "consumer",
  SQLiteDatabase: "sqlite",
} as const satisfies Readonly<Record<string, CloudflareManagedNativeReadbackAddress["kind"]>>;

/** Provider kind projection shared by construction and readback validation. */
export function cloudflareProviderKind(offering: ProviderOffering): string {
  return offering.kind.startsWith("takoform.") && isEdgeFormsApiVersion(offering.form.apiVersion)
    ? offering.form.kind
    : offering.kind;
}

/** Mirrors the WfP backend's fail-closed ownership boundary without credentials. */
export function cloudflareWfpOwnsOffering(offering: ProviderOffering): boolean {
  return (
    offering.kind === "worker_script" ||
    Object.hasOwn(MANAGED_FORM_NATIVE_KINDS, offering.form.kind) ||
    offering.form.kind === "WorkerCustomDomain"
  );
}

/**
 * The exhaustive non-Worker set the credential-bearing executor may send to
 * Cloudflare's account APIs. Worker-shaped Forms are deliberately absent: they
 * must be captured by the WfP backend and can never fall through to ordinary
 * `/workers/scripts` or workers.dev operations.
 */
export function cloudflareExecutorDirectOwnsOffering(offering: ProviderOffering): boolean {
  if (!isEdgeFormsApiVersion(offering.form.apiVersion)) return false;
  const kind = cloudflareProviderKind(offering);
  return (
    (offering.form.kind === "ObjectBucket" &&
      (kind === "ObjectBucket" || kind === "object_bucket")) ||
    (offering.form.kind === "EdgeKVNamespace" && kind === "EdgeKVNamespace") ||
    (offering.form.kind === "AtLeastOnceQueue" && kind === "AtLeastOnceQueue")
  );
}

/**
 * Pure, synchronous descriptor construction used in both isolates.
 *
 * The placement comes from the configured provider installation. It is never
 * accepted from a caller or encoded as mutable provider data.
 */
export function createCloudflareNativeReadbackDescriptor(input: {
  readonly providerId: string;
  readonly placement: CloudflareReadbackPlacement;
  readonly readback: ProviderNativeReadbackInput;
}): ProviderNativeReadbackDescriptor {
  const kind = cloudflareProviderKind(input.readback.offering);
  if (input.placement === "workers-for-platforms") {
    const native = parseManagedNativeId(input.readback.nativeId);
    const expectedNativeKind = managedNativeKind(input.readback.offering);
    if (
      !cloudflareWfpOwnsOffering(input.readback.offering) ||
      !input.readback.identity.uid ||
      !native ||
      expectedNativeKind === null ||
      native.kind !== expectedNativeKind
    ) {
      throw new ProviderReadbackDescriptorError();
    }
    return {
      apiVersion: PROVIDER_READBACK_API_VERSION,
      provider: input.providerId,
      kind,
      nativeId: input.readback.nativeId,
      data: { resourceUid: input.readback.identity.uid },
    };
  }

  const native = parseCloudflareNativeId(input.readback.nativeId);
  if (!native || !cloudflareKindMatches(kind, native.kind)) {
    throw new ProviderReadbackDescriptorError();
  }
  const data = ordinaryReadbackData(native, input.readback.spec);
  if (!data) throw new ProviderReadbackDescriptorError();
  return {
    apiVersion: PROVIDER_READBACK_API_VERSION,
    provider: input.providerId,
    kind,
    nativeId: input.readback.nativeId,
    data,
  };
}

/** Closed validation before any provider read is attempted. */
export function validateCloudflareNativeReadbackDescriptor(input: {
  readonly providerId: string;
  readonly placement: CloudflareReadbackPlacement;
  readonly offering: ProviderOffering;
  readonly descriptor: ProviderNativeReadbackDescriptor;
}): ValidatedCloudflareReadback | null {
  const raw = record(input.descriptor);
  if (
    !raw ||
    raw.apiVersion !== PROVIDER_READBACK_API_VERSION ||
    raw.provider !== input.providerId ||
    raw.kind !== cloudflareProviderKind(input.offering) ||
    typeof raw.nativeId !== "string" ||
    raw.nativeId.length < 1 ||
    raw.nativeId.length > 4_096
  ) {
    return null;
  }

  const data = record(raw.data);
  if (!data) return null;
  if (input.placement === "workers-for-platforms") {
    const native = parseManagedNativeId(raw.nativeId);
    const expectedNativeKind = managedNativeKind(input.offering);
    if (
      !cloudflareWfpOwnsOffering(input.offering) ||
      !native ||
      expectedNativeKind === null ||
      native.kind !== expectedNativeKind ||
      !exactKeys(data, ["resourceUid"]) ||
      typeof data.resourceUid !== "string" ||
      data.resourceUid.length < 1 ||
      data.resourceUid.length > 128
    ) {
      return null;
    }
    return { placement: input.placement, native, resourceUid: data.resourceUid };
  }

  const native = parseCloudflareNativeId(raw.nativeId);
  if (
    !native ||
    !cloudflareKindMatches(cloudflareProviderKind(input.offering), native.kind) ||
    !ordinaryReadbackDataMatches(native, data)
  ) {
    return null;
  }
  return { placement: input.placement, native };
}

export function parseCloudflareNativeId(value: string): CloudflareNativeReadbackAddress | null {
  const parts = value.split(":");
  const kind = parts[0];
  if (
    (kind === "r2" ||
      kind === "d1" ||
      kind === "kv" ||
      kind === "queue" ||
      kind === "worker" ||
      kind === "endpoint" ||
      kind === "domain") &&
    parts.length === 2 &&
    nativeSegment(parts[1])
  ) {
    return { kind, name: parts[1] };
  }
  if (
    (kind === "version" || kind === "deployment" || kind === "cron" || kind === "consumer") &&
    parts.length === 3 &&
    nativeSegment(parts[1]) &&
    nativeSegment(parts[2])
  ) {
    return { kind, parent: parts[1], name: parts[2] };
  }
  return null;
}

function parseManagedNativeId(value: string): CloudflareManagedNativeReadbackAddress | null {
  const parts = value.split(":");
  const kind = parts[0];
  if (
    (kind === "worker" || kind === "endpoint" || kind === "sqlite") &&
    parts.length === 2 &&
    nativeSegment(parts[1])
  ) {
    return { kind, name: parts[1] };
  }
  if (
    (kind === "version" || kind === "deployment" || kind === "cron" || kind === "consumer") &&
    parts.length === 3 &&
    nativeSegment(parts[1]) &&
    nativeSegment(parts[2])
  ) {
    return { kind, parent: parts[1], name: parts[2] };
  }
  return null;
}

function managedNativeKind(
  offering: ProviderOffering,
): CloudflareManagedNativeReadbackAddress["kind"] | null {
  if (offering.kind === "worker_script") return "worker";
  return (
    MANAGED_FORM_NATIVE_KINDS[offering.form.kind as keyof typeof MANAGED_FORM_NATIVE_KINDS] ?? null
  );
}

function cloudflareKindMatches(
  kind: string,
  nativeKind: CloudflareNativeReadbackAddress["kind"],
): boolean {
  switch (nativeKind) {
    case "r2":
      return kind === "ObjectBucket" || kind === "object_bucket";
    case "d1":
      return kind === "SQLiteDatabase" || kind === "sql_database";
    case "kv":
      return kind === "EdgeKVNamespace";
    case "queue":
      return kind === "AtLeastOnceQueue";
    case "worker":
      return kind === "ModuleWorker" || kind === "worker_script";
    case "version":
      return kind === "WorkerVersion";
    case "deployment":
      return kind === "WorkerDeployment";
    case "endpoint":
      return kind === "WorkerEndpoint";
    case "domain":
      return kind === "WorkerCustomDomain";
    case "cron":
      return kind === "WorkerCronTrigger";
    case "consumer":
      return kind === "QueueConsumer";
  }
}

function ordinaryReadbackData(
  native: CloudflareNativeReadbackAddress,
  spec?: JsonObject,
): JsonObject | null {
  switch (native.kind) {
    case "r2":
      return { bucketName: native.name };
    case "d1":
      return { databaseId: native.name };
    case "kv":
      return { namespaceId: native.name };
    case "queue":
      return { queueId: native.name };
    case "worker":
      return { scriptName: native.name };
    case "version":
      return { scriptName: native.parent, versionId: native.name };
    case "deployment":
      return { scriptName: native.parent, deploymentId: native.name };
    case "endpoint":
      return { scriptName: native.name };
    case "domain":
      return { domainId: native.name };
    case "cron": {
      const cron = typeof spec?.cron === "string" ? spec.cron : null;
      return cron && cron.length <= 4_096 ? { scriptName: native.parent, cron } : null;
    }
    case "consumer":
      return { queueId: native.parent, consumerId: native.name };
  }
}

function ordinaryReadbackDataMatches(
  native: CloudflareNativeReadbackAddress,
  data: Record<string, unknown>,
): boolean {
  switch (native.kind) {
    case "r2":
      return exactData(data, { bucketName: native.name });
    case "d1":
      return exactData(data, { databaseId: native.name });
    case "kv":
      return exactData(data, { namespaceId: native.name });
    case "queue":
      return exactData(data, { queueId: native.name });
    case "worker":
      return exactData(data, { scriptName: native.name });
    case "version":
      return exactData(data, { scriptName: native.parent, versionId: native.name });
    case "deployment":
      return exactData(data, { scriptName: native.parent, deploymentId: native.name });
    case "endpoint":
      return exactData(data, { scriptName: native.name });
    case "domain":
      return exactData(data, { domainId: native.name });
    case "cron":
      return (
        exactKeys(data, ["scriptName", "cron"]) &&
        data.scriptName === native.parent &&
        typeof data.cron === "string" &&
        data.cron.length > 0 &&
        data.cron.length <= 4_096
      );
    case "consumer":
      return exactData(data, { queueId: native.parent, consumerId: native.name });
  }
}

function exactData(data: Record<string, unknown>, expected: Record<string, string>): boolean {
  return (
    exactKeys(data, Object.keys(expected)) &&
    Object.entries(expected).every(([key, value]) => data[key] === value)
  );
}

function exactKeys(data: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(data).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nativeSegment(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
