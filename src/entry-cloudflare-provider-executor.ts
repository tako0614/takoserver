import { WorkerEntrypoint } from "cloudflare:workers";
import { createCloudflareProviderSurface } from "./cloudflare-provider-surface.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { parseHostedEdgeSupplies } from "./hosted-edge-supplies.ts";
import { parseHostedObjectBucketSupplies } from "./hosted-object-bucket-supplies.ts";
import { createR2ObjectStore } from "./objects-r2.ts";
import { CloudflareProvider, type CloudflareZone } from "./providers/cloudflare.ts";
import { createCloudflareEdgeMeterSources } from "./providers/cloudflare-edge-meter.ts";
import type { ManagedWorkerDispatchNamespace } from "./providers/cloudflare-managed-worker-gateway.ts";
import {
  MANAGED_WORKER_LEGACY_READINESS_PATH,
  MANAGED_WORKER_LEGACY_READINESS_PROPS_SCHEMA,
  MANAGED_WORKER_LEGACY_READINESS_RESULT_SCHEMA,
  MANAGED_WORKER_LEGACY_RELEASE_PROTOCOL,
  MANAGED_WORKER_READINESS_PATH,
  MANAGED_WORKER_READINESS_PROPS_SCHEMA,
  MANAGED_WORKER_READINESS_RESULT_SCHEMA,
  type ManagedWorkerHandlerName,
} from "./providers/cloudflare-managed-worker-wrapper.ts";
import {
  type CloudflareProviderExecutorRpc,
  createCloudflareProviderExecutor,
} from "./providers/cloudflare-provider-executor-rpc.ts";
import { createCloudflareR2MeterSource } from "./providers/cloudflare-r2-meter.ts";
import {
  cloudflareExecutorDirectOwnsOffering,
  cloudflareWfpOwnsOffering,
} from "./providers/cloudflare-readback-descriptor.ts";
import type {
  CloudflareManagedObjectReceiptAuthority,
  CloudflareManagedReleaseInspection,
  CloudflareManagedReleaseInspectionInput,
  CloudflareManagedSqliteNamespace,
  CloudflareManagedWorkerGatewayAuthority,
} from "./providers/cloudflare-worker-backend.ts";
import { createRuntimeInputAuthority } from "./runtime-input-preparations.ts";
import { parseRuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
import { createD1Sql } from "./sql-d1.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { currentTakoformCandidates } from "./takoform/current-candidates.ts";

export type CloudflareProviderExecutorEnvironment = "integration" | "rehearsal" | "production";

/** Exact bindings of the route-less parent-provider authority Worker. */
export interface CloudflareProviderExecutorEnv {
  readonly STATE_DB: Parameters<typeof createD1Sql>[0];
  readonly OBJECTS: Parameters<typeof createR2ObjectStore>[0];
  readonly DISPATCHER: ManagedWorkerDispatchNamespace;
  readonly MANAGED_WORKER_AUTHORITY: CloudflareManagedWorkerGatewayAuthority;
  readonly SQLITE_DATABASES: CloudflareManagedSqliteNamespace;
  readonly MANAGED_OBJECT_RECEIPT_AUTHORITY: CloudflareManagedObjectReceiptAuthority;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly CLOUDFLARE_API_TOKEN: string;
  readonly TAKOSERVER_ENVIRONMENT: CloudflareProviderExecutorEnvironment;
  readonly TAKOSERVER_ZONES: string;
  readonly TAKOSERVER_OBJECT_BUCKET_SUPPLIES?: string;
  readonly TAKOSERVER_EDGE_SUPPLIES?: string;
  readonly TAKOSERVER_CLOUDFLARE_DISPATCH_NAMESPACE: string;
  readonly TAKOSERVER_MANAGED_WORKER_GATEWAY_NAME: string;
  readonly TAKOSERVER_MANAGED_BASE_DOMAIN: string;
  readonly TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID: string;
  readonly TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_NAME: string;
  readonly TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: string;
  readonly PUBLIC_ORIGIN: string;
}

/**
 * Named service-binding entrypoint only. No default `fetch` method exists, so
 * the executor cannot become an HTTP bearer bridge.
 */
export class CloudflareProviderExecutor
  extends WorkerEntrypoint<CloudflareProviderExecutorEnv>
  implements CloudflareProviderExecutorRpc
{
  #service: Promise<CloudflareProviderExecutorRpc> | undefined;

  apply(input: Parameters<CloudflareProviderExecutorRpc["apply"]>[0]) {
    return this.call("apply", input);
  }

  recoverApply(input: Parameters<CloudflareProviderExecutorRpc["recoverApply"]>[0]) {
    return this.call("recoverApply", input);
  }

  convergeApply(input: Parameters<CloudflareProviderExecutorRpc["convergeApply"]>[0]) {
    return this.call("convergeApply", input);
  }

  poll(input: Parameters<CloudflareProviderExecutorRpc["poll"]>[0]) {
    return this.call("poll", input);
  }

  observe(input: Parameters<CloudflareProviderExecutorRpc["observe"]>[0]) {
    return this.call("observe", input);
  }

  delete(input: Parameters<CloudflareProviderExecutorRpc["delete"]>[0]) {
    return this.call("delete", input);
  }

  recoverDelete(input: Parameters<CloudflareProviderExecutorRpc["recoverDelete"]>[0]) {
    return this.call("recoverDelete", input);
  }

  adopt(input: Parameters<CloudflareProviderExecutorRpc["adopt"]>[0]) {
    return this.call("adopt", input);
  }

  recoverAdopt(input: Parameters<CloudflareProviderExecutorRpc["recoverAdopt"]>[0]) {
    return this.call("recoverAdopt", input);
  }

  verifyNativeAbsence(input: Parameters<CloudflareProviderExecutorRpc["verifyNativeAbsence"]>[0]) {
    return this.call("verifyNativeAbsence", input);
  }

  verifyArtifactConsumption(
    input: Parameters<CloudflareProviderExecutorRpc["verifyArtifactConsumption"]>[0],
  ) {
    return this.call("verifyArtifactConsumption", input);
  }

  readSqliteMigrationLedger(
    input: Parameters<CloudflareProviderExecutorRpc["readSqliteMigrationLedger"]>[0],
  ) {
    return this.call("readSqliteMigrationLedger", input);
  }

  applySqliteMigrationSuffix(
    input: Parameters<CloudflareProviderExecutorRpc["applySqliteMigrationSuffix"]>[0],
  ) {
    return this.call("applySqliteMigrationSuffix", input);
  }

  readMeterUsage(input: Parameters<CloudflareProviderExecutorRpc["readMeterUsage"]>[0]) {
    return this.call("readMeterUsage", input);
  }

  private async call<Method extends keyof CloudflareProviderExecutorRpc>(
    method: Method,
    input: Parameters<CloudflareProviderExecutorRpc[Method]>[0],
  ): Promise<Awaited<ReturnType<CloudflareProviderExecutorRpc[Method]>>> {
    this.#service ??= createCloudflareProviderExecutorFromEnv(this.env);
    const service = await this.#service;
    // The methods deliberately all have one object parameter. Keeping the
    // dispatch table closed prevents an ambient string from selecting any
    // method outside CloudflareProviderExecutorRpc.
    return (await (service[method] as (value: typeof input) => Promise<unknown>)(input)) as Awaited<
      ReturnType<CloudflareProviderExecutorRpc[Method]>
    >;
  }
}

/** Testable composition; still returns only the narrow RPC interface. */
export async function createCloudflareProviderExecutorFromEnv(
  env: CloudflareProviderExecutorEnv,
): Promise<CloudflareProviderExecutorRpc> {
  assertExecutorEnv(env);
  const sql = createD1Sql(env.STATE_DB);
  const objects = createR2ObjectStore(env.OBJECTS);
  const edge = await buildEdgeForms();
  const current = currentTakoformCandidates();
  const edgeSupplies = env.TAKOSERVER_EDGE_SUPPLIES
    ? parseHostedEdgeSupplies(env.TAKOSERVER_EDGE_SUPPLIES)
    : null;
  const objectBucketSupplies = env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES
    ? parseHostedObjectBucketSupplies(env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES)
    : null;
  const surface = createCloudflareProviderSurface({
    forms: current.forms,
    retainedForms: edge.forms,
    objectBucketSupplies,
    edgeSupplies,
  });
  if (!surface) throw new TypeError("Cloudflare provider executor requires reviewed supplies");
  if (surface.providerInstallationId !== env.TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID) {
    throw new TypeError("Cloudflare provider executor installation identity conflicts");
  }
  if (
    [...surface.offerings, ...surface.recoveryOfferings].some(
      (offering) =>
        !cloudflareWfpOwnsOffering(offering) && !cloudflareExecutorDirectOwnsOffering(offering),
    )
  ) {
    throw new TypeError("Cloudflare provider executor ordinary backend offering is not allowed");
  }
  const clock = () => new Date();
  const artifacts = createTakoformArtifacts({
    sql,
    objects,
    clock,
    randomId: () => crypto.randomUUID(),
  });
  const runtimeInputs = createRuntimeInputAuthority({
    sql,
    sealKeys: await parseRuntimeInputSealKeyRing(env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING),
    canonicalPublicOrigin: env.PUBLIC_ORIGIN,
    clock,
  });
  const provider = new CloudflareProvider({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    offerings: surface.offerings,
    recoveryOfferings: surface.recoveryOfferings,
    authorize: () => `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    zones: parseZones(env.TAKOSERVER_ZONES),
    artifacts: {
      manifest: (tenantRef, digest) => artifacts.resolveManifest(tenantRef, digest),
      async blob(digest) {
        const stored = await objects.get(`art/${digest.slice("sha256:".length)}`);
        return stored ? new Uint8Array(await new Response(stored.body).arrayBuffer()) : null;
      },
    },
    runtimeInputs: runtimeInputs.leases,
    workerBackend: {
      kind: "workers-for-platforms",
      dispatchNamespace: env.TAKOSERVER_CLOUDFLARE_DISPATCH_NAMESPACE,
      gatewayWorkerName: env.TAKOSERVER_MANAGED_WORKER_GATEWAY_NAME,
      managedBaseDomain: env.TAKOSERVER_MANAGED_BASE_DOMAIN,
      providerInstallationId: env.TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID,
      sql,
      inspectRelease: (input) => inspectManagedRelease(env.DISPATCHER, input),
      deriveSqliteInstanceName: (input) =>
        env.MANAGED_WORKER_AUTHORITY.deriveSqliteInstanceName(input),
      sealSqliteAdminProof: (input) => env.MANAGED_WORKER_AUTHORITY.sealSqliteAdminProof(input),
      sqliteNamespace: env.SQLITE_DATABASES,
      objectReceiptWorkerName: env.TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_NAME,
      objectReceiptAuthority: env.MANAGED_OBJECT_RECEIPT_AUTHORITY,
    },
  });
  return createCloudflareProviderExecutor({
    provider: async () => provider,
    sql,
    providerInstallationId: surface.providerInstallationId,
    meterSources: [
      ...createCloudflareEdgeMeterSources({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
      }),
      createCloudflareR2MeterSource({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: env.CLOUDFLARE_API_TOKEN,
      }),
    ],
    migrationSql: (tenantId, digest) => artifacts.resolveBlob(tenantId, digest),
    clock,
  });
}

async function inspectManagedRelease(
  dispatcher: ManagedWorkerDispatchNamespace,
  input: CloudflareManagedReleaseInspectionInput,
): Promise<CloudflareManagedReleaseInspection> {
  const legacy = input.releaseProtocol === MANAGED_WORKER_LEGACY_RELEASE_PROTOCOL;
  const props = legacy
    ? {
        schema: MANAGED_WORKER_LEGACY_READINESS_PROPS_SCHEMA,
        operationId: input.operationId,
        descriptorDigest: input.descriptorDigest,
      }
    : {
        schema: MANAGED_WORKER_READINESS_PROPS_SCHEMA,
        operationId: input.operationId,
        descriptorDigest: input.descriptorDigest,
        challengeNonce: input.challengeNonce,
      };
  let response: Response;
  try {
    response = await dispatcher
      .get(input.scriptName, props)
      .fetch(
        new Request(
          `https://managed-worker.invalid${legacy ? MANAGED_WORKER_LEGACY_READINESS_PATH : MANAGED_WORKER_READINESS_PATH}`,
        ),
      );
  } catch {
    return { ok: false, retryable: true };
  }
  if (!response.ok) {
    return { ok: false, retryable: response.status === 429 || response.status >= 500 };
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 16_384) return { ok: false, retryable: false };
  let raw: unknown;
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 16_384) {
      return { ok: false, retryable: false };
    }
    raw = JSON.parse(text);
  } catch {
    return { ok: false, retryable: false };
  }
  if (
    !isRecord(raw) ||
    !exactKeys(
      raw,
      legacy
        ? ["schema", "operationId", "descriptorDigest", "handlers"]
        : ["schema", "operationId", "descriptorDigest", "challengeNonce", "handlers"],
    )
  ) {
    return { ok: false, retryable: false };
  }
  const handlers = managedHandlers(raw.handlers);
  if (
    raw.schema !==
      (legacy
        ? MANAGED_WORKER_LEGACY_READINESS_RESULT_SCHEMA
        : MANAGED_WORKER_READINESS_RESULT_SCHEMA) ||
    raw.operationId !== input.operationId ||
    raw.descriptorDigest !== input.descriptorDigest ||
    (!legacy && raw.challengeNonce !== input.challengeNonce) ||
    !handlers ||
    !sameStrings(handlers, input.declaredHandlers)
  ) {
    return { ok: false, retryable: false };
  }
  return {
    ok: true,
    scriptName: input.scriptName,
    operationId: input.operationId,
    descriptorDigest: input.descriptorDigest,
    ...(legacy ? {} : { challengeNonce: input.challengeNonce }),
    handlers,
  };
}

function parseZones(raw: string): readonly CloudflareZone[] {
  let value: unknown;
  try {
    if (new TextEncoder().encode(raw).byteLength > 262_144) throw new Error();
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("invalid Cloudflare zones");
  }
  if (!Array.isArray(value) || value.length > 128 || !value.every(cloudflareZone)) {
    throw new TypeError("invalid Cloudflare zones");
  }
  return value;
}

function cloudflareZone(value: unknown): value is CloudflareZone {
  if (!isRecord(value)) return false;
  if (
    !exactKeys(value, ["suffix", "zoneId"], ["tenantRef", "reservedLabels", "singleLabel", "apex"])
  ) {
    return false;
  }
  return (
    typeof value.suffix === "string" &&
    value.suffix.length > 0 &&
    value.suffix.length <= 253 &&
    typeof value.zoneId === "string" &&
    value.zoneId.length > 0 &&
    value.zoneId.length <= 255 &&
    (value.tenantRef === undefined ||
      (typeof value.tenantRef === "string" &&
        value.tenantRef.length > 0 &&
        value.tenantRef.length <= 255)) &&
    (value.reservedLabels === undefined ||
      (Array.isArray(value.reservedLabels) &&
        value.reservedLabels.length <= 128 &&
        value.reservedLabels.every(
          (label) => typeof label === "string" && label.length > 0 && label.length <= 63,
        ))) &&
    (value.singleLabel === undefined || typeof value.singleLabel === "boolean") &&
    (value.apex === undefined || typeof value.apex === "boolean")
  );
}

function assertExecutorEnv(env: CloudflareProviderExecutorEnv): void {
  if (
    env.TAKOSERVER_ENVIRONMENT !== "integration" &&
    env.TAKOSERVER_ENVIRONMENT !== "rehearsal" &&
    env.TAKOSERVER_ENVIRONMENT !== "production"
  ) {
    throw new TypeError("Cloudflare provider executor environment is invalid");
  }
  for (const value of [
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_API_TOKEN,
    env.TAKOSERVER_ENVIRONMENT,
    env.TAKOSERVER_CLOUDFLARE_DISPATCH_NAMESPACE,
    env.TAKOSERVER_MANAGED_WORKER_GATEWAY_NAME,
    env.TAKOSERVER_MANAGED_BASE_DOMAIN,
    env.TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID,
    env.TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_NAME,
    env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING,
    env.PUBLIC_ORIGIN,
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("Cloudflare provider executor configuration is incomplete");
    }
  }
  if (!env.TAKOSERVER_EDGE_SUPPLIES && !env.TAKOSERVER_OBJECT_BUCKET_SUPPLIES) {
    throw new TypeError("Cloudflare provider executor requires reviewed supplies");
  }
}

function managedHandlers(value: unknown): readonly ManagedWorkerHandlerName[] | null {
  if (!Array.isArray(value) || new Set(value).size !== value.length) return null;
  return value.every((item) => item === "fetch" || item === "queue" || item === "scheduled")
    ? value
    : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const accepted = new Set([...required, ...optional]);
  return (
    keys.length >= required.length &&
    keys.every((key) => accepted.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wrangler needs a default export to select module-worker format. This empty
 * marker has neither `fetch` nor RPC methods; all usable methods remain on the
 * explicitly named `CloudflareProviderExecutor` service entrypoint.
 */
export default {};
