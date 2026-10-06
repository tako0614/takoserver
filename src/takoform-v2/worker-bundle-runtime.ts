import type { WorkerModuleInspectionInput } from "../providers/worker-module-semantic-inspection.ts";
import type { WorkerdModuleMediaType, WorkerdRuntime } from "../workerd-runtime.ts";
import type { WorkerBundleCustody } from "./forms/worker-bundle-backend.ts";
import { parseWorkerVersionSpec, WORKER_VERSION_FORM_URL } from "./forms/worker-specs.ts";
import type { V2Execution } from "./types.ts";

export interface V2WorkerBundleModuleProjection {
  /** Exact entrypoint and module fields accepted by compileWorkerdVersionGraph. */
  readonly graphInputs: {
    readonly mainModule: string;
    readonly modules: ReadonlyMap<string, Uint8Array>;
    readonly moduleMediaTypes: Readonly<Record<string, WorkerdModuleMediaType>>;
  };
  /** Exact copied module fields passed to WorkerdRuntime.inspectModule. */
  readonly inspectionInput: WorkerModuleInspectionInput;
  readonly inspection: Awaited<ReturnType<WorkerdRuntime["inspectModule"]>>;
}

export class V2WorkerBundleRuntimeError extends Error {
  constructor(readonly code: "worker_version_unavailable" | "bundle_reference_unavailable") {
    super(code);
    this.name = "V2WorkerBundleRuntimeError";
  }
}

/**
 * Reads only custody authorized by the exact accepted WorkerVersion operation,
 * then projects owned module copies to the existing inspector/graph seams.
 */
export function createV2WorkerBundleRuntime(options: {
  readonly custody: WorkerBundleCustody;
  readonly inspectModule: WorkerdRuntime["inspectModule"];
}) {
  return {
    async inspectVersion(execution: V2Execution): Promise<V2WorkerBundleModuleProjection> {
      if (execution.form !== WORKER_VERSION_FORM_URL || execution.action === "delete") {
        throw new V2WorkerBundleRuntimeError("worker_version_unavailable");
      }
      let spec: ReturnType<typeof parseWorkerVersionSpec>;
      try {
        spec = parseWorkerVersionSpec(execution.spec);
      } catch {
        throw new V2WorkerBundleRuntimeError("worker_version_unavailable");
      }
      if (!spec.bundle) throw new V2WorkerBundleRuntimeError("bundle_reference_unavailable");

      const held = await options.custody.readVerified({
        execution,
        targetResourceUid: spec.bundle.resourceUid,
      });
      const inspectionModules: WorkerModuleInspectionInput["modules"][number][] = [];
      const workerdModules = new Map<string, Uint8Array>();
      const moduleMediaTypes: Record<string, WorkerdModuleMediaType> = {};
      for (let index = 0; index < held.manifest.files.length; index += 1) {
        const file = held.manifest.files[index];
        const heldBytes = held.files[index];
        if (!file || !heldBytes) {
          throw new V2WorkerBundleRuntimeError("bundle_reference_unavailable");
        }
        // Source maps remain in exact Host custody and publication materials,
        // but they are auxiliary bytes rather than importable Worker modules.
        if (file.mediaType === "application/source-map+json") continue;
        const bytes = new Uint8Array(heldBytes);
        const digest = `sha256:${file.sha256}` as const;
        inspectionModules.push({
          name: file.path,
          digest,
          mediaType: file.mediaType,
          bytes: new Uint8Array(bytes),
        });
        workerdModules.set(file.path, bytes);
        moduleMediaTypes[file.path] = file.mediaType;
      }
      const graphInputs = {
        mainModule: held.manifest.entrypoint,
        modules: workerdModules,
        moduleMediaTypes,
      };
      const inspectionInput: WorkerModuleInspectionInput = {
        mainModule: graphInputs.mainModule,
        modules: inspectionModules,
        declaredHandlers: [...spec.handlers],
      };
      const inspection = await options.inspectModule(inspectionInput);
      return { graphInputs, inspectionInput, inspection };
    },
  };
}
