import type { TakoformArtifactManifest } from "./artifacts.ts";
import { isEdgeFormsApiVersion } from "./edge-family.ts";
import type { ArtifactResolver, WorkerModuleInspector } from "./engine.ts";
import type { TakoformStoredRelation } from "./relations.ts";
import type { TakoformStore } from "./store.ts";
import { type InstalledTakoformForm, TakoformHostError } from "./types.ts";

export async function validateWorkerBundleRuntime(input: {
  readonly tenantId: string;
  readonly form: InstalledTakoformForm;
  readonly spec: Record<string, unknown>;
  readonly artifacts: ArtifactResolver;
  readonly inspector?: WorkerModuleInspector;
}): Promise<void> {
  if (
    !isEdgeFormsApiVersion(input.form.identity.formRef.apiVersion) ||
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
    !isEdgeFormsApiVersion(input.form.identity.formRef.apiVersion) ||
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

/**
 * A Form with an explicit worker-class family adapter may be stored before the
 * worker is deployed. Once a deployment exists, every selected WorkerVersion
 * must actually export that class. Generic keyed exclusivity is deliberately
 * unrelated to this ABI rule.
 */
export async function validateClassHolderRuntime(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly form: InstalledTakoformForm;
  readonly spec: Record<string, unknown>;
  readonly relations: readonly TakoformStoredRelation[];
  readonly store: Pick<TakoformStore, "readRelations" | "readResource" | "resourcesByRelation">;
  readonly artifacts: ArtifactResolver;
  readonly inspector?: WorkerModuleInspector;
}): Promise<void> {
  const contract = input.form.workerClassRuntime;
  if (!contract) return;
  if (
    !(input.form.providedInterfaces ?? []).some((item) => item.name === contract.providedInterface)
  ) {
    throw new TakoformHostError("unsupported_capability", 422);
  }
  const className = pointerValue(input.spec, contract.className);
  const worker = input.relations.find((relation) => relation.relation === contract.workerRelation);
  if (typeof className !== "string" || !worker) {
    throw new TakoformHostError("invalid_argument", 400);
  }
  const deployments = await input.store.resourcesByRelation({
    tenantId: input.tenantId,
    space: input.space,
    sourceApiVersion: contract.deploymentForm.apiVersion,
    sourceKind: contract.deploymentForm.kind,
    relation: contract.deploymentWorkerRelation,
    targetUid: worker.targetUid,
    limit: 2,
  });
  if (deployments.length === 0) return;
  for (const deployment of deployments) {
    const deploymentRelations = await input.store.readRelations({
      tenantId: input.tenantId,
      space: deployment.resource.metadata.space,
      apiVersion: deployment.resource.apiVersion,
      kind: deployment.resource.kind,
      name: deployment.resource.metadata.name,
    });
    const versions = deploymentRelations.filter(
      (relation) => relation.relation === contract.deploymentVersionRelation,
    );
    if (versions.length === 0) throw new TakoformHostError("unsupported_capability", 422);
    for (const relation of versions) {
      const version = await input.store.readResource({
        tenantId: input.tenantId,
        space: input.space,
        apiVersion: relation.targetApiVersion,
        kind: relation.targetKind,
        name: relation.targetName,
      });
      const versionRelations = version
        ? await input.store.readRelations({
            tenantId: input.tenantId,
            space: version.metadata.space,
            apiVersion: version.apiVersion,
            kind: version.kind,
            name: version.metadata.name,
          })
        : [];
      const bundleRelation = versionRelations.find(
        (candidate) => candidate.relation === contract.versionBundleRelation,
      );
      const bundle = bundleRelation
        ? await input.store.readResource({
            tenantId: input.tenantId,
            space: input.space,
            apiVersion: bundleRelation.targetApiVersion,
            kind: bundleRelation.targetKind,
            name: bundleRelation.targetName,
          })
        : null;
      const manifestDigest = bundle?.spec.manifestDigest;
      if (
        !version ||
        version.metadata.uid !== relation.targetUid ||
        !bundleRelation ||
        !bundle ||
        bundle.metadata.uid !== bundleRelation.targetUid ||
        typeof manifestDigest !== "string"
      ) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
      const inspected = await inspectMainModule(
        input.tenantId,
        manifestDigest,
        input.artifacts,
        input.inspector,
      );
      if (!inspected.loadable || !inspected.classes?.includes(className)) {
        throw new TakoformHostError("unsupported_capability", 422);
      }
    }
  }
}

function pointerValue(root: unknown, pointer: string): unknown {
  let value = root;
  for (const token of pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[token];
  }
  return value;
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
): Promise<{
  readonly loadable: boolean;
  readonly handlers: readonly string[];
  readonly classes?: readonly string[];
}> {
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
