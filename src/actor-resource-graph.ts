import { isJsonObject, isSha256Digest } from "./json.ts";
import { sameFormRef, validateFormRef } from "./takoform/forms.ts";
import { validateRelationSchema } from "./takoform/relations.ts";
import { validateDesired } from "./takoform/schema.ts";
import type { ResourceListing, TakoformStore } from "./takoform/store.ts";
import type { InstalledTakoformForm, TakoformV1Alpha3FormRef } from "./takoform/types.ts";

export interface ActorResourceFacts {
  readonly address: {
    readonly space: string;
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
  };
  readonly uid: string;
  readonly generation: string;
  readonly revision: string;
  readonly formRef: TakoformV1Alpha3FormRef;
}

/** Persisted facts only: no admission, readiness, executable, or runtime authority. */
export interface ActorResourceGraph {
  readonly tenantId: string;
  readonly namespace: ActorResourceFacts & { readonly className: string };
  readonly worker: ActorResourceFacts;
}

export type ActorResourceGraphReader = (
  scope: { readonly tenantId: string; readonly namespaceResourceUid: string },
  signal: AbortSignal,
) => Promise<ActorResourceGraph | null>;

export interface ActorResourceGraphReaderOptions {
  readonly store: Pick<TakoformStore, "resourceWithRelationTargetByUid">;
  /** Exact installed parser vocabulary, not Host support or execution permission. */
  readonly form: InstalledTakoformForm;
}

export function createActorResourceGraphReader(
  options: ActorResourceGraphReaderOptions,
): ActorResourceGraphReader {
  if (
    !record(options) ||
    !record(options.store) ||
    typeof options.store.resourceWithRelationTargetByUid !== "function"
  ) {
    throw new TypeError("Actor graph reader requires relation-target storage");
  }
  const form = snapshotForm(options.form);
  const workerApiVersion = validateActorForm(form);
  const store = options.store;
  return async (scope, signal) => {
    if (!record(scope) || !text(scope.tenantId) || !text(scope.namespaceResourceUid)) return null;
    const { tenantId, namespaceResourceUid } = scope;
    signal.throwIfAborted();
    // One atomic, tenant-scoped read owns the live source/target UID fences.
    // Storage failures propagate; they are not evidence of an absent graph.
    const raw = await store.resourceWithRelationTargetByUid(
      tenantId,
      namespaceResourceUid,
      "/worker",
    );
    signal.throwIfAborted();
    let snapshot: unknown;
    try {
      snapshot = structuredClone(raw);
    } catch {
      return null;
    }
    if (!record(snapshot)) return null;
    const { source, target, relation } = snapshot;
    if (!validListing(source) || !validListing(target) || !record(relation)) return null;
    if (
      source.uid !== namespaceResourceUid ||
      !sameFormRef(source.resource.form.formRef, form.identity.formRef) ||
      (form.identity.packageDigest !== undefined &&
        source.resource.form.packageDigest !== form.identity.packageDigest) ||
      source.space !== target.space ||
      target.apiVersion !== workerApiVersion ||
      target.kind !== "ModuleWorker" ||
      relation.pointer !== "/worker" ||
      relation.relation !== "/worker" ||
      relation.targetApiVersion !== target.apiVersion ||
      relation.targetKind !== target.kind ||
      relation.targetName !== target.name ||
      relation.targetUid !== target.uid ||
      !formRef(relation.targetFormRef) ||
      !sameFormRef(relation.targetFormRef, target.resource.form.formRef) ||
      relation.bindingRef !== undefined ||
      (relation.targetRevision !== undefined && !text(relation.targetRevision))
    )
      return null;
    // targetRevision is historical evidence, not a lock on the current Worker.
    const spec = source.resource.spec;
    if (!isJsonObject(spec)) return null;
    try {
      if (validateDesired(form, spec).some((diagnostic) => diagnostic.severity === "error")) {
        return null;
      }
    } catch {
      return null;
    }
    const worker = spec.worker;
    if (
      !text(spec.className) ||
      !record(worker) ||
      !keys(worker, "apiVersion", "kind", "name") ||
      worker.apiVersion !== target.apiVersion ||
      worker.kind !== target.kind ||
      worker.name !== target.name
    )
      return null;
    signal.throwIfAborted();
    return {
      tenantId,
      namespace: { ...facts(source), className: spec.className },
      worker: facts(target),
    };
  };
}

function snapshotForm(input: InstalledTakoformForm): InstalledTakoformForm {
  if (!record(input)) throw new TypeError("invalid Actor Form");
  const { validateDesired: validator, ...data } = input;
  if (validator !== undefined && typeof validator !== "function") {
    throw new TypeError("invalid Actor Form validator");
  }
  try {
    return { ...structuredClone(data), ...(validator ? { validateDesired: validator } : {}) };
  } catch {
    throw new TypeError("invalid Actor Form");
  }
}

function validateActorForm(form: InstalledTakoformForm): string {
  const runtime = form.workerClassRuntime;
  if (
    !record(form.identity) ||
    !formRef(form.identity.formRef) ||
    form.identity.formRef.kind !== "ActorNamespace" ||
    !validDigests(form.identity) ||
    !record(runtime) ||
    runtime.providedInterface !== "worker.actor" ||
    runtime.className !== "/className" ||
    runtime.workerRelation !== "/worker"
  )
    throw new TypeError("invalid Actor Form identity or runtime vocabulary");
  const provided = form.providedInterfaces;
  const interfaces = Array.isArray(provided)
    ? provided.filter((candidate) => record(candidate) && candidate.name === "worker.actor")
    : [];
  const actor = interfaces[0];
  if (
    interfaces.length !== 1 ||
    !record(actor) ||
    !keys(actor, "apiVersion", "name", "version", "schemaDigest") ||
    actor.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
    !text(actor.version) ||
    !isSha256Digest(actor.schemaDigest)
  )
    throw new TypeError("Actor Form must declare the exact worker.actor interface");
  // This deliberately supports the installed ActorNamespace shape rather than
  // introducing another generic Form-pointer interpreter.
  const schema = form.desiredSchema;
  if (!record(schema) || !record(schema.properties)) {
    throw new TypeError("invalid Actor Form desired schema");
  }
  const { className, worker } = schema.properties;
  if (
    schema.type !== "object" ||
    !Array.isArray(schema.required) ||
    !schema.required.includes("className") ||
    !schema.required.includes("worker") ||
    !record(className) ||
    className.type !== "string" ||
    !record(worker) ||
    worker.type !== "object" ||
    worker.additionalProperties !== false ||
    !record(worker.properties) ||
    !keys(worker.properties, "apiVersion", "kind", "name") ||
    !Array.isArray(worker.required) ||
    [...worker.required].sort().join("\0") !== "apiVersion\0kind\0name" ||
    !record(worker.properties.apiVersion) ||
    !text(worker.properties.apiVersion.const) ||
    !record(worker.properties.kind) ||
    worker.properties.kind.const !== "ModuleWorker"
  )
    throw new TypeError("invalid Actor Form class or worker schema");
  validateRelationSchema(form);
  return worker.properties.apiVersion.const;
}

function validListing(value: unknown): value is ResourceListing {
  if (!record(value) || !record(value.resource)) return false;
  const resource = value.resource;
  if (
    !record(resource.metadata) ||
    !record(resource.form) ||
    !formRef(resource.form.formRef) ||
    !validDigests(resource.form)
  )
    return false;
  for (const key of ["space", "name", "uid", "generation", "revision"]) {
    if (!text(value[key]) || value[key] !== resource.metadata[key]) return false;
  }
  for (const key of ["apiVersion", "kind"] as const) {
    if (
      !text(value[key]) ||
      value[key] !== resource[key] ||
      value[key] !== resource.form.formRef[key]
    )
      return false;
  }
  return typeof value.updatedAt === "string";
}

function formRef(value: unknown): value is TakoformV1Alpha3FormRef {
  if (
    !record(value) ||
    !keys(value, "apiVersion", "kind", "definitionVersion", "schemaDigest") ||
    !text(value.apiVersion) ||
    !text(value.kind) ||
    !text(value.definitionVersion) ||
    !isSha256Digest(value.schemaDigest)
  )
    return false;
  try {
    validateFormRef({
      apiVersion: value.apiVersion,
      kind: value.kind,
      definitionVersion: value.definitionVersion,
      schemaDigest: value.schemaDigest,
    });
    return true;
  } catch {
    return false;
  }
}

function validDigests(value: Record<string, unknown>): boolean {
  return ["packageDigest", "implementationDigest"].every(
    (key) => value[key] === undefined || isSha256Digest(value[key]),
  );
}

function facts(value: ResourceListing): ActorResourceFacts {
  return {
    address: {
      space: value.space,
      apiVersion: value.apiVersion,
      kind: value.kind,
      name: value.name,
    },
    uid: value.uid,
    generation: value.generation,
    revision: value.revision,
    formRef: structuredClone(value.resource.form.formRef),
  };
}

function keys(value: Record<string, unknown>, ...expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === expected.sort().join("\0");
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
