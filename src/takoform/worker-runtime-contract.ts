import type { TakoformArtifactManifest } from "./artifacts.ts";
import type { ArtifactResolver, WorkerModuleInspector } from "./engine.ts";
import type { TakoformStoredRelation } from "./relations.ts";
import type { TakoformStore } from "./store.ts";
import { type InstalledTakoformForm, TakoformHostError } from "./types.ts";

const EDGE_FORMS = "edge.forms.takoform.com/v1alpha1";

export async function validateWorkerBundleRuntime(input: {
  readonly tenantId: string;
  readonly form: InstalledTakoformForm;
  readonly spec: Record<string, unknown>;
  readonly artifacts: ArtifactResolver;
  readonly inspector?: WorkerModuleInspector;
}): Promise<void> {
  if (
    input.form.identity.formRef.apiVersion !== EDGE_FORMS ||
    input.form.identity.formRef.kind !== "WorkerBundle" ||
    input.form.role !== "identity"
  ) {
    return;
  }
  const manifestDigest = input.spec.manifestDigest;
  if (typeof manifestDigest !== "string") throw new TakoformHostError("artifact_missing", 404);
  const inspected = await inspectMainModule(
    input.tenantId,
    manifestDigest,
    input.artifacts,
    input.inspector,
  );
  if (!inspected.loadable) throw new TakoformHostError("artifact_invalid", 400);
}

export async function validateWorkerVersionRuntime(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly form: InstalledTakoformForm;
  readonly spec: Record<string, unknown>;
  readonly relations: readonly TakoformStoredRelation[];
  readonly store: Pick<TakoformStore, "readResource">;
  readonly artifacts: ArtifactResolver;
  readonly inspector?: WorkerModuleInspector;
}): Promise<void> {
  if (
    input.form.identity.formRef.apiVersion !== EDGE_FORMS ||
    input.form.identity.formRef.kind !== "WorkerVersion" ||
    input.form.role !== "revision" ||
    !declaresWorkerRuntime(input.form)
  ) {
    return;
  }
  const bundleRelation = input.relations.find((relation) => relation.relation === "/bundle");
  if (!bundleRelation) throw new TakoformHostError("invalid_argument", 400);
  const bundle = await input.store.readResource({
    tenantId: input.tenantId,
    space: input.space,
    apiVersion: bundleRelation.targetApiVersion,
    kind: bundleRelation.targetKind,
    name: bundleRelation.targetName,
  });
  const manifestDigest = bundle?.spec.manifestDigest;
  if (
    !bundle ||
    bundle.metadata.uid !== bundleRelation.targetUid ||
    typeof manifestDigest !== "string"
  ) {
    throw new TakoformHostError("resource_not_found", 404);
  }
  const inspected = await inspectMainModule(
    input.tenantId,
    manifestDigest,
    input.artifacts,
    input.inspector,
  );
  if (!inspected.loadable) throw new TakoformHostError("invalid_argument", 400);
  const declared = input.spec.handlers;
  if (
    !Array.isArray(declared) ||
    declared.some((handler) => typeof handler !== "string" || !inspected.handlers.includes(handler))
  ) {
    throw new TakoformHostError("invalid_argument", 400);
  }
}

function declaresWorkerRuntime(form: InstalledTakoformForm): boolean {
  const properties = form.desiredSchema.properties;
  return (
    typeof properties === "object" &&
    properties !== null &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, "bundle") &&
    Object.hasOwn(properties, "handlers")
  );
}

async function inspectMainModule(
  tenantId: string,
  manifestDigest: string,
  artifacts: ArtifactResolver,
  inspector: WorkerModuleInspector | undefined,
): Promise<{ readonly loadable: boolean; readonly handlers: readonly string[] }> {
  if (!inspector) throw new Error("worker_module_inspector_missing");
  const manifest = await artifacts.resolveManifest(tenantId, manifestDigest);
  const main = workerMainModule(manifest);
  if (!main) return { loadable: false, handlers: [] };
  const bytes = await artifacts.resolveBlob(tenantId, main.digest);
  if (!bytes || bytes.byteLength !== main.size) return { loadable: false, handlers: [] };
  return await inspector.inspect({ digest: main.digest, mediaType: main.mediaType, bytes });
}

function workerMainModule(manifest: TakoformArtifactManifest | null) {
  if (manifest?.kind !== "WorkerBundle" || !manifest.mainModule || !manifest.modules) return null;
  return manifest.modules.find((module) => module.name === manifest.mainModule) ?? null;
}
