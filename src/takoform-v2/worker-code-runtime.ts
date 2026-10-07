import { bytesDigest, canonicalJson } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import type {
  WorkerModuleInspectionInput,
  WorkerModuleInspectionResult,
} from "../providers/worker-module-semantic-inspection.ts";
import type {
  WorkerdBinding,
  WorkerdDeploymentVariant,
  WorkerdModuleMediaType,
  WorkerdRuntime,
  WorkerdSite,
} from "../workerd-runtime.ts";
import type { SqlArtifactCustodyRead } from "./forms/artifact-custody.ts";
import type { StaticAssetBundleManifest } from "./forms/static-asset-bundle.ts";
import {
  parseWorkerBundleManifest,
  WORKER_BUNDLE_LIMITS,
  type WorkerBundleManifest,
} from "./forms/worker-bundle.ts";
import { parseWorkerVersionSpec } from "./forms/worker-specs.ts";
import { verifyV2AssetMaterials } from "./worker-static-runtime.ts";

export type V2WorkerCodeVersionIdentity = {
  readonly directory: string;
  readonly hostnames: readonly string[];
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly workerVersionUid: string;
  readonly versionId: string;
  readonly weight: number;
  readonly bundleResourceUid: string;
  readonly assetResourceUid?: string;
};

export type V2WorkerCodeDeploymentVariant = WorkerdDeploymentVariant<WorkerdSite>;

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

/**
 * Project an already-authorized immutable WorkerBundle and inspected code
 * snapshot into the existing Workerd application-module representation.
 * This is a pure runtime adapter: it performs no custody, SQL, network,
 * publication, or tenant-code evaluation.
 */
export async function projectV2WorkerCodeVersion(input: {
  readonly identity: V2WorkerCodeVersionIdentity;
  readonly spec: unknown;
  readonly bundle: SqlArtifactCustodyRead<WorkerBundleManifest> | null;
  readonly assets?: SqlArtifactCustodyRead<StaticAssetBundleManifest> | null;
  readonly inspectModule: WorkerdRuntime["inspectModule"];
  readonly privateInputs?: unknown;
}): Promise<V2WorkerCodeDeploymentVariant> {
  const versionUnavailable = () => new V2WorkerCodeRuntimeError("worker_version_unavailable");
  const bundleUnavailable = () => new V2WorkerCodeRuntimeError("worker_bundle_unavailable");
  const inspectModule = input.inspectModule;
  if (typeof inspectModule !== "function") {
    throw new V2WorkerCodeRuntimeError("worker_module_inspection_unavailable");
  }

  const identity = snapshotIdentity(input.identity);
  let spec: ReturnType<typeof parseWorkerVersionSpec>;
  try {
    spec = parseWorkerVersionSpec(structuredClone(input.spec));
  } catch {
    throw versionUnavailable();
  }
  if (
    !spec.bundle ||
    spec.worker.resourceUid !== identity.workerResourceUid ||
    spec.bundle.resourceUid !== identity.bundleResourceUid
  ) {
    throw bundleUnavailable();
  }
  if (spec.requiredSensitiveVars.length > 0 || hasPrivateInputs(input.privateInputs)) {
    throw new V2WorkerCodeRuntimeError("worker_private_inputs_unavailable");
  }
  if (
    spec.kvBindings.length > 0 ||
    spec.sqliteBindings.length > 0 ||
    spec.bucketBindings.length > 0 ||
    spec.queueProducerBindings.length > 0 ||
    spec.serviceBindings.length > 0 ||
    spec.actorBindings.length > 0 ||
    spec.workflowBindings.length > 0
  ) {
    throw new V2WorkerCodeRuntimeError("worker_binding_unavailable");
  }
  if (spec.handlers.some((handler) => handler !== "fetch")) {
    throw new V2WorkerCodeRuntimeError("worker_event_delivery_unavailable");
  }
  if (spec.assets?.bundle.resourceUid !== identity.assetResourceUid) {
    throw new V2WorkerCodeRuntimeError("worker_assets_unavailable");
  }
  if (!spec.assets && input.assets) {
    throw new V2WorkerCodeRuntimeError("worker_assets_unavailable");
  }
  if (!input.bundle) throw bundleUnavailable();

  const held = snapshotBundle(input.bundle);
  const observed = await verifyBundle(held);
  let assets: Awaited<ReturnType<typeof verifyV2AssetMaterials>> | undefined;
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
  const inspectionInput = inspectionInputForBundle(held, observed.manifest, spec.handlers);
  const inspection = await inspectModule(inspectionInput);
  if (!isValidInspection(inspection)) {
    throw new V2WorkerCodeRuntimeError("worker_module_inspection_unavailable");
  }
  if (spec.handlers.some((handler) => !inspection.exportedHandlers.includes(handler))) {
    throw new V2WorkerCodeRuntimeError("worker_handler_mismatch");
  }

  const entrypoint = observed.manifest.entrypoint;
  const modules = new Map<string, Uint8Array>();
  const moduleMediaTypes = Object.create(null) as Record<string, WorkerdModuleMediaType>;
  for (let index = 0; index < observed.manifest.files.length; index += 1) {
    const file = observed.manifest.files[index];
    const bytes = held.files[index];
    if (!file || !bytes) throw bundleUnavailable();
    modules.set(file.path, new Uint8Array(bytes));
    moduleMediaTypes[file.path] = file.mediaType;
  }

  const vars: WorkerdBinding[] = Object.entries(spec.vars)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => ({ name, value: canonicalJson(value), kind: "json" }));
  const site: WorkerdSite = {
    directory: identity.directory,
    mainModule: entrypoint,
    modules: observed.manifest.files
      .filter((file) => file.path !== entrypoint)
      .map((file) => file.path),
    moduleMediaTypes,
    hostnames: [...identity.hostnames],
    generation: identity.generation,
    workerResourceUid: identity.workerResourceUid,
    fetchHandler: spec.handlers.includes("fetch"),
    ...(assets && spec.assets
      ? {
          assets: {
            notFoundHandling:
              spec.assets.notFoundHandling === "single_page_application"
                ? ("single-page-application" as const)
                : ("none" as const),
            runWorkerFirst: spec.assets.runWorkerFirst,
            strictPaths: true as const,
            mediaTypes: assets.mediaTypes,
          },
        }
      : {}),
    ...(vars.length === 0 ? {} : { vars }),
  };
  return {
    versionId: identity.versionId,
    workerVersionUid: identity.workerVersionUid,
    weight: identity.weight,
    site,
    modules,
    ...(assets ? { assets: assets.bytes } : {}),
  };
}

function snapshotIdentity(input: V2WorkerCodeVersionIdentity): V2WorkerCodeVersionIdentity {
  try {
    return {
      directory: input.directory,
      hostnames: [...input.hostnames],
      generation: input.generation,
      workerResourceUid: input.workerResourceUid,
      workerVersionUid: input.workerVersionUid,
      versionId: input.versionId,
      weight: input.weight,
      bundleResourceUid: input.bundleResourceUid,
      ...(input.assetResourceUid === undefined ? {} : { assetResourceUid: input.assetResourceUid }),
    };
  } catch {
    throw new V2WorkerCodeRuntimeError("worker_version_unavailable");
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

async function verifyBundle(snapshot: BundleSnapshot): Promise<{
  readonly manifest: WorkerBundleManifest;
}> {
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
  return { manifest };
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

function hasPrivateInputs(input: unknown): boolean {
  if (input === undefined) return false;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return true;
  try {
    const prototype = Object.getPrototypeOf(input);
    return (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.keys(input).length > 0 ||
      Object.getOwnPropertySymbols(input).length > 0
    );
  } catch {
    return true;
  }
}
