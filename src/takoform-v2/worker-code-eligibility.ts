import { bytesDigest, canonicalJson } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import type {
  WorkerModuleInspectionInput,
  WorkerModuleInspectionResult,
} from "../worker-module-inspection-contract.ts";
import type { SqlArtifactCustodyRead } from "./forms/artifact-custody.ts";
import type { StaticAssetBundleManifest } from "./forms/static-asset-bundle.ts";
import {
  parseWorkerBundleManifest,
  WORKER_BUNDLE_LIMITS,
  type WorkerBundleManifest,
  type WorkerBundleMediaType,
} from "./forms/worker-bundle.ts";
import { parseWorkerVersionSpec } from "./forms/worker-specs.ts";
import {
  type V2VerifiedAssetMaterials,
  verifyV2AssetMaterials,
} from "./worker-material-validation.ts";
import {
  exactV2ResolvedServiceBindings,
  type V2ResolvedServiceBinding,
} from "./worker-service-resolution.ts";

export type V2WorkerModuleInspector = (
  input: WorkerModuleInspectionInput,
) => Promise<WorkerModuleInspectionResult>;

/** Exact accepted Core reference graph; it is not a request-side readiness assertion. */
export interface V2ResolvedSqliteBinding {
  readonly name: string;
  readonly resourceUid: string;
}

/** Exact accepted Core ObjectBucket references verified by the lifecycle backend. */
export interface V2ResolvedObjectBucketBinding {
  readonly name: string;
  readonly resourceUid: string;
}

/** Host-private native companion destination and selected-Version signed grant. */
export interface V2SqliteNativeBoot {
  readonly address: string;
  readonly token: string;
}

/** Private native ObjectBucket dispatcher and exact public binding names. */
export interface V2ObjectBucketNativeBoot {
  readonly address: string;
  readonly token: string;
  readonly bindings: readonly { readonly publicName: string }[];
}

export type V2WorkerCodeRuntimeErrorCode =
  | "worker_version_unavailable"
  | "worker_bundle_unavailable"
  | "worker_module_inspection_unavailable"
  | "worker_handler_mismatch"
  | "worker_binding_unavailable"
  | "worker_private_inputs_unavailable"
  | "worker_event_delivery_unavailable"
  | "worker_assets_unavailable";

/** Internal refusal; callers must not expose this projection as Form support. */
export class V2WorkerCodeRuntimeError extends Error {
  constructor(readonly code: V2WorkerCodeRuntimeErrorCode) {
    super(code);
    this.name = "V2WorkerCodeRuntimeError";
  }
}

export interface V2WorkerCodeEligibilityInput {
  readonly workerResourceUid: string;
  readonly bundleResourceUid?: string;
  readonly assetResourceUid?: string;
  readonly spec: unknown;
  readonly bundle: SqlArtifactCustodyRead<WorkerBundleManifest> | null;
  readonly assets?: SqlArtifactCustodyRead<StaticAssetBundleManifest> | null;
  readonly inspectModule: V2WorkerModuleInspector;
  readonly privateInputs?: unknown;
  /** Supplied only after the current accepted SQL reference graph was verified. */
  readonly resolvedServiceBindings?: readonly V2ResolvedServiceBinding[];
  readonly resolvedSqliteBindings?: readonly V2ResolvedSqliteBinding[];
  readonly resolvedObjectBucketBindings?: readonly V2ResolvedObjectBucketBinding[];
}

interface VerifiedV2WorkerCodeEligibility {
  readonly spec: ReturnType<typeof parseWorkerVersionSpec>;
  readonly manifest: WorkerBundleManifest;
  readonly files: readonly {
    readonly path: string;
    readonly mediaType: WorkerBundleMediaType;
    readonly bytes: Uint8Array;
  }[];
  readonly assets?: V2VerifiedAssetMaterials;
  readonly sqliteBoot?: V2SqliteNativeBoot;
}

/**
 * Check exact accepted held materials and semantic handlers without loading a
 * Workerd implementation. Scheduled eligibility never authorizes delivery.
 */
export async function inspectV2WorkerCodeVersionEligibility(
  input: V2WorkerCodeEligibilityInput,
): Promise<void> {
  await verifyV2WorkerCodeProjection(input, true);
}

/** Native projection requires actual Resource-owned configured values, not inspection-only input. */
export async function prepareV2WorkerCodeProjection(
  input: V2WorkerCodeEligibilityInput & {
    /** Exact Host-configured values; never a boolean presence assertion. */
    readonly configuredPrivateInputs?: unknown;
    readonly requireEventDelivery?: boolean;
    readonly eventDelivery?: { readonly token: string };
    /** Real boot-composed private settlement plane, never a handler flag. */
    readonly queueSettlement?: { readonly address: string; readonly token: string };
    readonly sqliteBoot?: V2SqliteNativeBoot;
    readonly objectBucketBoot?: V2ObjectBucketNativeBoot;
  },
): Promise<VerifiedV2WorkerCodeEligibility> {
  return await verifyV2WorkerCodeProjection(input, false);
}

async function verifyV2WorkerCodeProjection(
  input: V2WorkerCodeEligibilityInput & {
    readonly configuredPrivateInputs?: unknown;
    readonly requireEventDelivery?: boolean;
    readonly eventDelivery?: { readonly token: string };
    readonly queueSettlement?: { readonly address: string; readonly token: string };
    readonly sqliteBoot?: V2SqliteNativeBoot;
    readonly objectBucketBoot?: V2ObjectBucketNativeBoot;
  },
  inspectionOnly: boolean,
): Promise<VerifiedV2WorkerCodeEligibility> {
  const versionUnavailable = () => new V2WorkerCodeRuntimeError("worker_version_unavailable");
  const bundleUnavailable = () => new V2WorkerCodeRuntimeError("worker_bundle_unavailable");
  const inspectModule = input.inspectModule;
  if (typeof inspectModule !== "function") {
    throw new V2WorkerCodeRuntimeError("worker_module_inspection_unavailable");
  }
  let spec: ReturnType<typeof parseWorkerVersionSpec>;
  try {
    spec = parseWorkerVersionSpec(structuredClone(input.spec));
  } catch {
    throw versionUnavailable();
  }
  if (
    !spec.bundle ||
    spec.worker.resourceUid !== input.workerResourceUid ||
    spec.bundle.resourceUid !== input.bundleResourceUid
  ) {
    throw bundleUnavailable();
  }
  // Copy and validate all own values before the first material/inspector await.
  // Neither map is included in the verified projection.
  const configured = snapshotV2WorkerPrivateInputs(input.configuredPrivateInputs);
  const candidate = configured === undefined ? input.privateInputs : configured;
  if (
    configured === null ||
    (configured !== undefined && input.privateInputs !== undefined) ||
    !exactPrivateInputs(candidate, spec.requiredSensitiveVars) ||
    (!inspectionOnly && spec.requiredSensitiveVars.length > 0 && configured === undefined)
  ) {
    throw new V2WorkerCodeRuntimeError("worker_private_inputs_unavailable");
  }
  if (
    spec.kvBindings.length > 0 ||
    spec.queueProducerBindings.length > 0 ||
    spec.actorBindings.length > 0 ||
    spec.workflowBindings.length > 0
  ) {
    throw new V2WorkerCodeRuntimeError("worker_binding_unavailable");
  }
  // Snapshot the accepted graph and the private grant before any material or
  // inspector await. A declaration alone never authorizes native projection.
  const sqliteBindings = snapshotResolvedSqliteBindings(input.resolvedSqliteBindings);
  const sqliteBoot = snapshotSqliteBoot(input.sqliteBoot);
  const objectBucketBindings = snapshotResolvedObjectBucketBindings(
    input.resolvedObjectBucketBindings,
  );
  const objectBucketBoot = snapshotObjectBucketBoot(input.objectBucketBoot);
  if (
    sqliteBindings === null ||
    sqliteBoot === null ||
    spec.sqliteBindings.length !== (sqliteBindings?.length ?? 0) ||
    spec.sqliteBindings.some(
      (binding, index) =>
        binding.name !== sqliteBindings?.[index]?.name ||
        binding.resource.resourceUid !== sqliteBindings[index]?.resourceUid,
    ) ||
    (spec.sqliteBindings.length > 0 && !inspectionOnly && sqliteBoot === undefined) ||
    (spec.sqliteBindings.length === 0 && sqliteBoot !== undefined) ||
    objectBucketBindings === null ||
    objectBucketBoot === null ||
    spec.bucketBindings.length !== (objectBucketBindings?.length ?? 0) ||
    spec.bucketBindings.some(
      (binding, index) =>
        binding.name !== objectBucketBindings?.[index]?.name ||
        binding.resource.resourceUid !== objectBucketBindings[index]?.resourceUid,
    ) ||
    (spec.bucketBindings.length > 0 && !inspectionOnly && objectBucketBoot === undefined) ||
    (spec.bucketBindings.length === 0 && objectBucketBoot !== undefined) ||
    (objectBucketBoot !== undefined &&
      (objectBucketBoot.bindings.length !== spec.bucketBindings.length ||
        spec.bucketBindings.some(
          (binding, index) => objectBucketBoot.bindings[index]?.publicName !== binding.name,
        )))
  ) {
    throw new V2WorkerCodeRuntimeError("worker_binding_unavailable");
  }
  // The service target digest is asynchronous. Hold the accepted bytes before
  // that await so the caller cannot replace a Bundle during validation.
  if (!input.bundle) throw bundleUnavailable();
  const bundle = snapshotBundle(input.bundle);
  if (
    !(await exactV2ResolvedServiceBindings(spec.serviceBindings, input.resolvedServiceBindings))
  ) {
    throw new V2WorkerCodeRuntimeError("worker_binding_unavailable");
  }
  if (
    spec.handlers.some(
      (handler) => handler !== "fetch" && handler !== "scheduled" && handler !== "queue",
    ) ||
    (input.requireEventDelivery === true &&
      (spec.handlers.includes("scheduled") || spec.handlers.includes("queue")) &&
      (!input.eventDelivery || !/^[0-9a-f]{64}$/u.test(input.eventDelivery.token))) ||
    (!inspectionOnly &&
      spec.handlers.includes("queue") &&
      (!input.queueSettlement ||
        !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(input.queueSettlement.address) ||
        Number(
          input.queueSettlement.address.slice(input.queueSettlement.address.lastIndexOf(":") + 1),
        ) > 65_535 ||
        !/^[A-Za-z0-9_-]{43}$/u.test(input.queueSettlement.token)))
  ) {
    throw new V2WorkerCodeRuntimeError("worker_event_delivery_unavailable");
  }
  if (spec.assets?.bundle.resourceUid !== input.assetResourceUid) {
    throw new V2WorkerCodeRuntimeError("worker_assets_unavailable");
  }
  if (!spec.assets && input.assets) {
    throw new V2WorkerCodeRuntimeError("worker_assets_unavailable");
  }
  const manifest = await verifyBundle(bundle);
  let assets: V2VerifiedAssetMaterials | undefined;
  if (spec.assets) {
    if (!input.assets) throw new V2WorkerCodeRuntimeError("worker_assets_unavailable");
    try {
      assets = await verifyV2AssetMaterials(input.assets);
    } catch {
      throw new V2WorkerCodeRuntimeError("worker_assets_unavailable");
    }
    if (
      spec.assets.notFoundHandling === "single_page_application" &&
      !assets.bytes.has("index.html")
    ) {
      throw new V2WorkerCodeRuntimeError("worker_assets_unavailable");
    }
  }
  const inspection = await inspectModule(inspectionInputForBundle(bundle, manifest, spec.handlers));
  if (!isValidInspection(inspection)) {
    throw new V2WorkerCodeRuntimeError("worker_module_inspection_unavailable");
  }
  if (
    inspection.exportedHandlers.length !== spec.handlers.length ||
    spec.handlers.some((handler) => !inspection.exportedHandlers.includes(handler))
  ) {
    throw new V2WorkerCodeRuntimeError("worker_handler_mismatch");
  }
  return {
    spec,
    manifest,
    files: manifest.files.map((file, index) => {
      const bytes = bundle.files[index];
      if (!bytes) throw new V2WorkerCodeRuntimeError("worker_bundle_unavailable");
      return { path: file.path, mediaType: file.mediaType, bytes: new Uint8Array(bytes) };
    }),
    ...(assets ? { assets } : {}),
    ...(sqliteBoot ? { sqliteBoot } : {}),
  };
}

function snapshotResolvedObjectBucketBindings(
  input: readonly V2ResolvedObjectBucketBinding[] | undefined,
): readonly V2ResolvedObjectBucketBinding[] | null | undefined {
  if (input === undefined) return undefined;
  try {
    if (!Array.isArray(input) || input.length > 64) return null;
    const copied = input.map((binding) => ({
      name: binding.name,
      resourceUid: binding.resourceUid,
    }));
    if (
      copied.some(
        (binding) =>
          typeof binding.name !== "string" ||
          typeof binding.resourceUid !== "string" ||
          !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(binding.name) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(binding.resourceUid),
      ) ||
      copied.some((binding, index) => index > 0 && (copied[index - 1]?.name ?? "") >= binding.name)
    )
      return null;
    return copied;
  } catch {
    return null;
  }
}

function snapshotObjectBucketBoot(
  input: V2ObjectBucketNativeBoot | undefined,
): V2ObjectBucketNativeBoot | null | undefined {
  if (input === undefined) return undefined;
  try {
    const address = input.address;
    const token = input.token;
    const port = Number(address.slice(address.lastIndexOf(":") + 1));
    const bindings = input.bindings.map(({ publicName }) => ({ publicName }));
    if (
      typeof address !== "string" ||
      !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(address) ||
      port > 65_535 ||
      typeof token !== "string" ||
      token.length > 32_768 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token) ||
      !Array.isArray(input.bindings) ||
      bindings.length > 64 ||
      bindings.some((binding) => !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(binding.publicName)) ||
      bindings.some(
        (binding, index) =>
          index > 0 && (bindings[index - 1]?.publicName ?? "") >= binding.publicName,
      )
    )
      return null;
    return { address, token, bindings };
  } catch {
    return null;
  }
}

function snapshotResolvedSqliteBindings(
  input: readonly V2ResolvedSqliteBinding[] | undefined,
): readonly V2ResolvedSqliteBinding[] | null | undefined {
  if (input === undefined) return undefined;
  try {
    if (!Array.isArray(input) || input.length > 64) return null;
    const copied = input.map((binding) => ({
      name: binding.name,
      resourceUid: binding.resourceUid,
    }));
    if (
      copied.some(
        (binding) =>
          typeof binding.name !== "string" ||
          typeof binding.resourceUid !== "string" ||
          !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(binding.name) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(binding.resourceUid),
      ) ||
      copied.some((binding, index) => index > 0 && (copied[index - 1]?.name ?? "") >= binding.name)
    )
      return null;
    return copied;
  } catch {
    return null;
  }
}

function snapshotSqliteBoot(
  input: V2SqliteNativeBoot | undefined,
): V2SqliteNativeBoot | null | undefined {
  if (input === undefined) return undefined;
  try {
    const address = input.address;
    const token = input.token;
    const port = Number(address.slice(address.lastIndexOf(":") + 1));
    if (
      typeof address !== "string" ||
      !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(address) ||
      port > 65_535 ||
      typeof token !== "string" ||
      token.length > 32_768 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)
    )
      return null;
    return { address, token };
  } catch {
    return null;
  }
}

interface BundleSnapshot {
  readonly manifest: WorkerBundleManifest;
  readonly manifestBytes: Uint8Array;
  readonly files: readonly Uint8Array[];
  readonly observed: JsonObject;
}

function snapshotBundle(input: SqlArtifactCustodyRead<WorkerBundleManifest>): BundleSnapshot {
  try {
    if (
      !(input.manifestBytes instanceof Uint8Array) ||
      !Array.isArray(input.files) ||
      input.files.length > WORKER_BUNDLE_LIMITS.fileCount
    ) {
      throw new Error();
    }
    return {
      manifest: structuredClone(input.manifest),
      manifestBytes: new Uint8Array(input.manifestBytes),
      files: input.files.map((file) => {
        if (!(file instanceof Uint8Array)) throw new Error();
        return new Uint8Array(file);
      }),
      observed: structuredClone(input.observed),
    };
  } catch {
    throw new V2WorkerCodeRuntimeError("worker_bundle_unavailable");
  }
}

function inspectionInputForBundle(
  snapshot: BundleSnapshot,
  manifest: WorkerBundleManifest,
  declaredHandlers: readonly string[],
): WorkerModuleInspectionInput {
  return {
    mainModule: manifest.entrypoint,
    modules: manifest.files.map((file, index) => {
      const bytes = snapshot.files[index];
      if (!bytes) throw new V2WorkerCodeRuntimeError("worker_bundle_unavailable");
      return {
        name: file.path,
        digest: `sha256:${file.sha256}`,
        mediaType: file.mediaType,
        bytes: new Uint8Array(bytes),
      };
    }),
    declaredHandlers: [...declaredHandlers] as WorkerModuleInspectionInput["declaredHandlers"],
  };
}

async function verifyBundle(snapshot: BundleSnapshot): Promise<WorkerBundleManifest> {
  const unavailable = () => new V2WorkerCodeRuntimeError("worker_bundle_unavailable");
  let manifest: WorkerBundleManifest;
  try {
    manifest = parseWorkerBundleManifest(snapshot.manifestBytes);
  } catch {
    throw unavailable();
  }
  if (
    canonicalJson(manifest) !== canonicalJson(snapshot.manifest) ||
    snapshot.files.length !== manifest.files.length
  ) {
    throw unavailable();
  }

  const manifestSha256 = (await bytesDigest(snapshot.manifestBytes)).slice("sha256:".length);
  let totalBytes = 0;
  const observedFiles: { path: string; sha256: string; mediaType: string; byteSize: number }[] = [];
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    const bytes = snapshot.files[index];
    if (!entry || !bytes || bytes.byteLength > WORKER_BUNDLE_LIMITS.fileBytes) {
      throw unavailable();
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > WORKER_BUNDLE_LIMITS.aggregateBytes) throw unavailable();
    const digest = (await bytesDigest(bytes)).slice("sha256:".length);
    if (digest !== entry.sha256) throw unavailable();
    observedFiles.push({
      path: entry.path,
      sha256: digest,
      mediaType: entry.mediaType,
      byteSize: bytes.byteLength,
    });
  }
  const expectedObserved = {
    manifestSha256,
    fileCount: manifest.files.length,
    totalBytes,
    entrypoint: manifest.entrypoint,
    files: observedFiles,
  };
  if (
    canonicalJson(snapshot.observed) !== canonicalJson(expectedObserved) ||
    manifest.files.find((file) => file.path === manifest.entrypoint)?.mediaType !==
      "application/javascript+module"
  ) {
    throw unavailable();
  }
  return manifest;
}

function isValidInspection(
  input: WorkerModuleInspectionResult,
): input is Extract<WorkerModuleInspectionResult, { outcome: "valid" }> {
  return (
    input !== null &&
    typeof input === "object" &&
    input.outcome === "valid" &&
    Array.isArray(input.exportedHandlers) &&
    new Set(input.exportedHandlers).size === input.exportedHandlers.length &&
    input.exportedHandlers.every(
      (handler) => handler === "fetch" || handler === "scheduled" || handler === "queue",
    )
  );
}

/** Snapshot only own data-property strings; no getters, proxies or caller references survive an await. */
export function snapshotV2WorkerPrivateInputs(
  input: unknown,
): Readonly<Record<string, string>> | undefined | null {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(input).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.keys(descriptors);
    if (keys.length !== Reflect.ownKeys(descriptors).length) return null;
    const snapshot = Object.create(null) as Record<string, string>;
    for (const name of keys) {
      const descriptor = descriptors[name];
      if (!descriptor?.enumerable) return null;
      if (
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length === 0
      ) {
        return null;
      }
      snapshot[name] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function exactPrivateInputs(input: unknown, names: readonly string[]): boolean {
  const snapshot = snapshotV2WorkerPrivateInputs(input);
  return (
    snapshot !== null &&
    (snapshot === undefined
      ? names.length === 0
      : Object.keys(snapshot).length === names.length &&
        names.every((name) => Object.hasOwn(snapshot, name)))
  );
}
