import { canonicalJson } from "../json.ts";
import type {
  WorkerdBinding,
  WorkerdDeploymentVariant,
  WorkerdModuleMediaType,
  WorkerdRuntime,
  WorkerdSite,
} from "../workerd-runtime.ts";
import type { SqlArtifactCustodyRead } from "./forms/artifact-custody.ts";
import type { StaticAssetBundleManifest } from "./forms/static-asset-bundle.ts";
import type { WorkerBundleManifest } from "./forms/worker-bundle.ts";
import {
  prepareV2WorkerCodeProjection,
  snapshotV2WorkerPrivateInputs,
  V2WorkerCodeRuntimeError,
} from "./worker-code-eligibility.ts";
import type { V2ResolvedServiceBinding } from "./worker-service-resolution.ts";

export {
  inspectV2WorkerCodeVersionEligibility,
  V2WorkerCodeRuntimeError,
  type V2WorkerCodeRuntimeErrorCode,
  type V2WorkerModuleInspector,
} from "./worker-code-eligibility.ts";

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
  /** Actual configured values from the trusted Resource-owned custody reader. */
  readonly configuredPrivateInputs?: unknown;
  readonly resolvedServiceBindings?: readonly V2ResolvedServiceBinding[];
  /** Non-optional private event gate capability composed by the owning Host. */
  readonly eventDelivery?: { readonly token: string };
  /** Exact private settlement binding selected before tenant materialization. */
  readonly queueSettlement?: { readonly address: string; readonly token: string };
}): Promise<V2WorkerCodeDeploymentVariant> {
  const bundleUnavailable = () => new V2WorkerCodeRuntimeError("worker_bundle_unavailable");
  const inspectModule = input.inspectModule;
  if (typeof inspectModule !== "function") {
    throw new V2WorkerCodeRuntimeError("worker_module_inspection_unavailable");
  }

  const identity = snapshotIdentity(input.identity);
  const configuredPrivateInputs = snapshotV2WorkerPrivateInputs(input.configuredPrivateInputs);
  if (configuredPrivateInputs === null) {
    throw new V2WorkerCodeRuntimeError("worker_private_inputs_unavailable");
  }
  let resolvedServiceBindings: readonly V2ResolvedServiceBinding[] | undefined;
  try {
    resolvedServiceBindings = input.resolvedServiceBindings?.map((binding) => ({ ...binding }));
  } catch {
    throw new V2WorkerCodeRuntimeError("worker_binding_unavailable");
  }
  const verified = await prepareV2WorkerCodeProjection({
    workerResourceUid: identity.workerResourceUid,
    bundleResourceUid: identity.bundleResourceUid,
    ...(identity.assetResourceUid === undefined
      ? {}
      : { assetResourceUid: identity.assetResourceUid }),
    spec: input.spec,
    bundle: input.bundle,
    ...(input.assets === undefined ? {} : { assets: input.assets }),
    inspectModule,
    privateInputs: input.privateInputs,
    ...(configuredPrivateInputs === undefined ? {} : { configuredPrivateInputs }),
    ...(resolvedServiceBindings === undefined ? {} : { resolvedServiceBindings }),
    requireEventDelivery: true,
    ...(input.eventDelivery === undefined ? {} : { eventDelivery: input.eventDelivery }),
    ...(input.queueSettlement === undefined ? {} : { queueSettlement: input.queueSettlement }),
  });
  const { spec, manifest, files, assets } = verified;
  // The portable inspection-only map cannot authorize native env projection.
  if (spec.requiredSensitiveVars.length > 0 && configuredPrivateInputs === undefined) {
    throw new V2WorkerCodeRuntimeError("worker_private_inputs_unavailable");
  }

  const entrypoint = manifest.entrypoint;
  const modules = new Map<string, Uint8Array>();
  const moduleMediaTypes = Object.create(null) as Record<string, WorkerdModuleMediaType>;
  for (const file of files) {
    if (!file.bytes) throw bundleUnavailable();
    modules.set(file.path, new Uint8Array(file.bytes));
    moduleMediaTypes[file.path] = file.mediaType;
  }

  const vars: WorkerdBinding[] = [
    ...Object.entries(spec.vars).map(([name, value]) => ({
      name,
      value: canonicalJson(value),
      kind: "json" as const,
    })),
    ...Object.entries(configuredPrivateInputs ?? {}).map(([name, value]) => ({
      name,
      value,
      kind: "text" as const,
    })),
  ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const site: WorkerdSite = {
    directory: identity.directory,
    mainModule: entrypoint,
    modules: files.filter((file) => file.path !== entrypoint).map((file) => file.path),
    moduleMediaTypes,
    hostnames: [...identity.hostnames],
    generation: identity.generation,
    workerResourceUid: identity.workerResourceUid,
    fetchHandler: spec.handlers.includes("fetch"),
    ...(resolvedServiceBindings?.length
      ? { serviceBindings: resolvedServiceBindings.map((binding) => ({ ...binding })) }
      : {}),
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
