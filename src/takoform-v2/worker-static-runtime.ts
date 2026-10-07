import type { WorkerdDeploymentVariant, WorkerdStaticSite } from "../workerd-runtime.ts";
import { parseWorkerVersionSpec } from "./forms/worker-specs.ts";
import {
  V2WorkerStaticRuntimeError,
  verifyV2AssetMaterials,
} from "./worker-material-validation.ts";
import type { V2WorkerVersionMaterials } from "./worker-publication-state.ts";

export {
  V2WorkerStaticRuntimeError,
  verifyV2AssetMaterials,
} from "./worker-material-validation.ts";

/**
 * Pure projection input from the caller's already-selected publication graph.
 * Identity values are preserved; they are not authorization evidence.
 */
export type V2StaticWorkerVersionIdentity = Omit<
  Pick<WorkerdStaticSite, "directory" | "hostnames" | "generation" | "workerResourceUid">,
  "generation"
> & {
  readonly generation: string;
  readonly versionId: string;
  readonly workerVersionUid: string;
  readonly weight: number;
};

export type V2StaticWorkerDeploymentVariant = WorkerdDeploymentVariant<WorkerdStaticSite> & {
  readonly assets: ReadonlyMap<string, Uint8Array>;
};

/**
 * Project a static-only WorkerVersion plus bytes returned by the publication
 * authority's `readVersionMaterials`. This function validates and copies its
 * input but does not authorize the read or perform source/network/SQL access.
 */
export async function projectV2StaticWorkerVersion(input: {
  readonly identity: V2StaticWorkerVersionIdentity;
  readonly spec: unknown;
  readonly materials: V2WorkerVersionMaterials | null;
}): Promise<V2StaticWorkerDeploymentVariant> {
  const unavailable = () => new V2WorkerStaticRuntimeError("worker_version_unavailable");
  let spec: ReturnType<typeof parseWorkerVersionSpec>;
  try {
    spec = parseWorkerVersionSpec(input.spec);
  } catch {
    throw unavailable();
  }

  if (
    spec.bundle ||
    spec.handlers.length !== 0 ||
    Object.keys(spec.vars).length !== 0 ||
    spec.requiredSensitiveVars.length !== 0 ||
    spec.kvBindings.length !== 0 ||
    spec.sqliteBindings.length !== 0 ||
    spec.bucketBindings.length !== 0 ||
    spec.queueProducerBindings.length !== 0 ||
    spec.serviceBindings.length !== 0 ||
    spec.actorBindings.length !== 0 ||
    spec.workflowBindings.length !== 0 ||
    !spec.assets ||
    spec.assets.runWorkerFirst ||
    spec.worker.resourceUid !== input.identity.workerResourceUid
  ) {
    throw unavailable();
  }

  if (!input.materials || input.materials.bundle !== null || !input.materials.assets) {
    throw new V2WorkerStaticRuntimeError("asset_bundle_unavailable");
  }
  const assets = await verifyV2AssetMaterials(input.materials.assets);
  if (
    spec.assets.notFoundHandling === "single_page_application" &&
    !assets.bytes.has("index.html")
  ) {
    throw new V2WorkerStaticRuntimeError("asset_bundle_unavailable");
  }

  const site: WorkerdStaticSite = {
    kind: "static",
    directory: input.identity.directory,
    hostnames: [...input.identity.hostnames],
    generation: input.identity.generation,
    workerResourceUid: input.identity.workerResourceUid,
    fetchHandler: false,
    assets: {
      notFoundHandling:
        spec.assets.notFoundHandling === "single_page_application"
          ? "single-page-application"
          : "none",
      runWorkerFirst: false,
      mediaTypes: assets.mediaTypes,
    },
  };
  return {
    versionId: input.identity.versionId,
    workerVersionUid: input.identity.workerVersionUid,
    weight: input.identity.weight,
    site,
    modules: new Map(),
    assets: assets.bytes,
  };
}
