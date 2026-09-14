import { isJsonObject, isSha256Digest } from "./json.ts";
import type { JsonObject } from "./ports.ts";
import { sameFormRef, validateFormRef } from "./takoform/forms.ts";
import type { TakoformStoredRelation } from "./takoform/relations.ts";
import { validateRelationSchema } from "./takoform/relations.ts";
import { validateDesired } from "./takoform/schema.ts";
import type {
  ResourceListing,
  ResourceRelationTargetSnapshot,
  TakoformStore,
} from "./takoform/store.ts";
import type {
  InstalledTakoformForm,
  TakoformStoredResource,
  TakoformV1Alpha3FormRef,
} from "./takoform/types.ts";

/** The address facts needed by a private Workflow caller. */
export interface WorkflowResourceAddress {
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
}

/** One persisted Resource incarnation, without status or execution authority. */
export interface WorkflowResourceFacts {
  readonly address: WorkflowResourceAddress;
  readonly uid: string;
  readonly generation: string;
  readonly revision: string;
  readonly formRef: TakoformV1Alpha3FormRef;
}

/** Factual graph for one DurableWorkflow Resource and its ModuleWorker target. */
export interface WorkflowResourceGraph {
  readonly tenantId: string;
  readonly workflow: WorkflowResourceFacts & { readonly className: string };
  readonly worker: WorkflowResourceFacts;
}

export type WorkflowResourceGraphReader = (
  scope: { readonly tenantId: string; readonly workflowResourceUid: string },
  signal: AbortSignal,
) => Promise<WorkflowResourceGraph | null>;

export interface WorkflowResourceGraphReaderOptions {
  readonly store: Pick<TakoformStore, "resourceWithRelationTargetByUid">;
  /** An exact installed Definition used only to parse persisted desired state. */
  readonly form: InstalledTakoformForm;
}

/**
 * Builds a read-only graph resolver for the private Workflow seam.
 *
 * The returned graph is deliberately not a preparation target: it has no
 * script, executable flag, readiness claim, or runtime handle. The supplied
 * Form is a parser vocabulary only; no support/admission or provider check is
 * consulted here.
 */
export function createWorkflowResourceGraphReader(
  options: WorkflowResourceGraphReaderOptions,
): WorkflowResourceGraphReader {
  if (!isRecord(options) || !isRecord(options.store)) {
    throw new TypeError("invalid Workflow graph reader options");
  }
  if (typeof options.store.resourceWithRelationTargetByUid !== "function") {
    throw new TypeError("Workflow graph reader requires relation-target storage");
  }

  const form = snapshotWorkflowForm(options.form);
  const definition = validateWorkflowForm(form);
  const { runtime, workerTarget } = definition;
  const store = options.store;

  return async (scope, signal): Promise<WorkflowResourceGraph | null> => {
    if (!validScope(scope)) return null;
    const capturedScope = {
      tenantId: scope.tenantId,
      workflowResourceUid: scope.workflowResourceUid,
    };
    signal.throwIfAborted();
    // The store method is the one atomic read of source, relation, target, and
    // live attestations. Do not catch its rejection: storage failures are not
    // an absent graph.
    const raw = await store.resourceWithRelationTargetByUid(
      capturedScope.tenantId,
      capturedScope.workflowResourceUid,
      runtime.workerRelation,
    );
    signal.throwIfAborted();
    if (raw === null || raw === undefined) return null;

    let snapshot: ResourceRelationTargetSnapshot;
    try {
      // Store adapters own their rows. Clone before inspecting and projecting
      // so a mutable adapter result can never become graph configuration.
      snapshot = structuredClone(raw) as ResourceRelationTargetSnapshot;
    } catch {
      return null;
    }
    const graph = resolveSnapshot(snapshot, capturedScope, form, runtime, workerTarget);
    signal.throwIfAborted();
    return graph;
  };
}

function snapshotWorkflowForm(input: InstalledTakoformForm): InstalledTakoformForm {
  if (!isRecord(input)) throw new TypeError("invalid Workflow Form");
  try {
    const validator = input.validateDesired;
    if (validator !== undefined && typeof validator !== "function") {
      throw new TypeError("invalid Workflow Form validator");
    }
    const source = { ...input } as Record<string, unknown>;
    delete source.validateDesired;
    const snapshot = structuredClone(source) as unknown as InstalledTakoformForm;
    if (validator !== undefined) {
      // Functions are not structured-cloneable. Preserve only this parser
      // callback; all mutable Definition data above is an independent clone.
      Object.defineProperty(snapshot, "validateDesired", {
        value: validator,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return snapshot;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("invalid Workflow Form");
  }
}

function validateWorkflowForm(form: InstalledTakoformForm): {
  readonly runtime: NonNullable<InstalledTakoformForm["workerClassRuntime"]>;
  readonly workerTarget: { readonly apiVersion: string; readonly kind: string };
} {
  const identity = form.identity;
  if (!isRecord(identity) || !isRecord(identity.formRef)) {
    throw new TypeError("Workflow Form identity is invalid");
  }
  validateFormRef(identity.formRef);
  if (identity.packageDigest !== undefined && !isSha256Digest(identity.packageDigest)) {
    throw new TypeError("Workflow Form package digest is invalid");
  }
  if (
    identity.implementationDigest !== undefined &&
    !isSha256Digest(identity.implementationDigest)
  ) {
    throw new TypeError("Workflow Form implementation digest is invalid");
  }
  if (!isJsonObject(form.desiredSchema)) {
    throw new TypeError("Workflow Form desired schema is invalid");
  }

  const runtime = form.workerClassRuntime;
  if (!isRecord(runtime) || runtime.providedInterface !== "worker.workflow") {
    throw new TypeError("Workflow Form class runtime is not worker.workflow");
  }
  if (
    !pointer(runtime.className) ||
    hasWildcard(runtime.className) ||
    !pointer(runtime.workerRelation) ||
    hasWildcard(runtime.workerRelation) ||
    runtime.className === runtime.workerRelation
  ) {
    throw new TypeError("Workflow Form class runtime pointers are invalid");
  }
  if (
    !isRecord(runtime.deploymentForm) ||
    typeof runtime.deploymentForm.apiVersion !== "string" ||
    runtime.deploymentForm.apiVersion.length === 0 ||
    typeof runtime.deploymentForm.kind !== "string" ||
    runtime.deploymentForm.kind.length === 0 ||
    !pointer(runtime.deploymentWorkerRelation) ||
    !pointer(runtime.deploymentVersionRelation) ||
    !pointer(runtime.versionBundleRelation)
  ) {
    throw new TypeError("Workflow Form class runtime deployment contract is invalid");
  }

  const provided = form.providedInterfaces;
  if (!Array.isArray(provided)) throw new TypeError("Workflow Form interfaces are missing");
  const matching = provided.filter(
    (candidate) => isRecord(candidate) && candidate.name === runtime.providedInterface,
  );
  if (matching.length !== 1 || !isInterface(matching[0])) {
    throw new TypeError("Workflow Form does not declare the exact worker.workflow interface");
  }

  // This validates every relation declaration once at construction. It does
  // not resolve a target or consult Host support.
  validateRelationSchema(form);
  const classSchema = schemaAtPointer(form.desiredSchema, runtime.className);
  const workerSchema = schemaAtPointer(form.desiredSchema, runtime.workerRelation);
  if (!isRecord(classSchema) || !isRecord(workerSchema)) {
    throw new TypeError("Workflow Form runtime pointers are not in desired schema");
  }
  const workerTarget = referenceShape(workerSchema);
  if (!workerTarget) throw new TypeError("Workflow Form worker relation is not a reference");
  return { runtime, workerTarget };
}

function resolveSnapshot(
  snapshot: ResourceRelationTargetSnapshot,
  scope: { readonly tenantId: string; readonly workflowResourceUid: string },
  form: InstalledTakoformForm,
  runtime: NonNullable<InstalledTakoformForm["workerClassRuntime"]>,
  workerTarget: { readonly apiVersion: string; readonly kind: string },
): WorkflowResourceGraph | null {
  if (!isRecord(snapshot)) return null;
  const source = snapshot.source;
  const target = snapshot.target;
  const relation = snapshot.relation;
  if (!validListing(source) || !validListing(target) || !validRelation(relation)) return null;
  if (
    source.uid !== scope.workflowResourceUid ||
    !sameListingMetadata(source) ||
    !sameListingMetadata(target) ||
    source.resource.apiVersion !== form.identity.formRef.apiVersion ||
    source.resource.kind !== form.identity.formRef.kind ||
    !sameFormRef(source.resource.form.formRef, form.identity.formRef) ||
    (form.identity.packageDigest !== undefined &&
      source.resource.form.packageDigest !== form.identity.packageDigest) ||
    source.space !== target.space
  ) {
    return null;
  }
  if (!sameFormRef(target.resource.form.formRef, relation.targetFormRef)) return null;
  if (
    target.apiVersion !== workerTarget.apiVersion ||
    target.kind !== workerTarget.kind ||
    relation.targetApiVersion !== workerTarget.apiVersion ||
    relation.targetKind !== workerTarget.kind
  ) {
    return null;
  }
  if (
    relation.pointer !== runtime.workerRelation ||
    relation.relation !== runtime.workerRelation ||
    relation.targetApiVersion !== target.apiVersion ||
    relation.targetKind !== target.kind ||
    relation.targetName !== target.name ||
    relation.targetUid !== target.uid ||
    relation.bindingRef !== undefined
  ) {
    return null;
  }

  const spec = source.resource.spec;
  if (!isJsonObject(spec)) return null;
  let diagnostics: readonly { readonly severity: string }[];
  try {
    diagnostics = validateDesired(form, spec);
  } catch {
    return null;
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return null;

  const classValue = pointerValue(spec, runtime.className);
  const workerValue = pointerValue(spec, runtime.workerRelation);
  if (
    typeof classValue !== "string" ||
    !isRecord(workerValue) ||
    !exactReference(workerValue) ||
    workerValue.apiVersion !== relation.targetApiVersion ||
    workerValue.kind !== relation.targetKind ||
    workerValue.name !== relation.targetName
  ) {
    return null;
  }
  if (!sameFormRef(relation.targetFormRef, target.resource.form.formRef)) return null;

  return {
    tenantId: scope.tenantId,
    workflow: {
      address: addressOf(source),
      uid: source.uid,
      generation: source.generation,
      revision: source.revision,
      formRef: structuredClone(source.resource.form.formRef),
      className: classValue,
    },
    worker: {
      address: addressOf(target),
      uid: target.uid,
      generation: target.generation,
      revision: target.revision,
      formRef: structuredClone(target.resource.form.formRef),
    },
  };
}

function validScope(value: unknown): value is { tenantId: string; workflowResourceUid: string } {
  return (
    isRecord(value) && nonEmptyString(value.tenantId) && nonEmptyString(value.workflowResourceUid)
  );
}

function validListing(value: unknown): value is ResourceListing {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.space) ||
    !nonEmptyString(value.apiVersion) ||
    !nonEmptyString(value.kind) ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.uid) ||
    !nonEmptyString(value.generation) ||
    !nonEmptyString(value.revision) ||
    typeof value.updatedAt !== "string" ||
    !isStoredResource(value.resource)
  ) {
    return false;
  }
  return true;
}

function isStoredResource(value: unknown): value is TakoformStoredResource {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.apiVersion) ||
    !nonEmptyString(value.kind) ||
    !isRecord(value.form) ||
    !isFormRef(value.form.formRef) ||
    !isRecord(value.metadata) ||
    !nonEmptyString(value.metadata.name) ||
    !nonEmptyString(value.metadata.space) ||
    !nonEmptyString(value.metadata.uid) ||
    !nonEmptyString(value.metadata.generation) ||
    !nonEmptyString(value.metadata.revision)
  ) {
    return false;
  }
  if (value.form.packageDigest !== undefined && !isSha256Digest(value.form.packageDigest)) {
    return false;
  }
  if (
    value.form.implementationDigest !== undefined &&
    !isSha256Digest(value.form.implementationDigest)
  ) {
    return false;
  }
  return true;
}

function sameListingMetadata(listing: ResourceListing): boolean {
  const resource = listing.resource;
  return (
    resource.apiVersion === listing.apiVersion &&
    resource.kind === listing.kind &&
    resource.metadata.name === listing.name &&
    resource.metadata.space === listing.space &&
    resource.metadata.uid === listing.uid &&
    resource.metadata.generation === listing.generation &&
    resource.metadata.revision === listing.revision &&
    resource.form.formRef.apiVersion === listing.apiVersion &&
    resource.form.formRef.kind === listing.kind
  );
}

function validRelation(value: unknown): value is TakoformStoredRelation {
  if (
    !isRecord(value) ||
    !pointer(value.pointer) ||
    !pointer(value.relation) ||
    !nonEmptyString(value.targetApiVersion) ||
    !nonEmptyString(value.targetKind) ||
    !nonEmptyString(value.targetName) ||
    !nonEmptyString(value.targetUid) ||
    !isFormRef(value.targetFormRef)
  ) {
    return false;
  }
  if (value.targetRevision !== undefined && !nonEmptyString(value.targetRevision)) {
    return false;
  }
  return value.bindingRef === undefined || isBindingRef(value.bindingRef);
}

function isFormRef(value: unknown): value is TakoformV1Alpha3FormRef {
  if (
    !isRecord(value) ||
    typeof value.apiVersion !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.definitionVersion !== "string" ||
    !isSha256Digest(value.schemaDigest)
  ) {
    return false;
  }
  try {
    validateFormRef({
      apiVersion: value.apiVersion,
      kind: value.kind,
      definitionVersion: value.definitionVersion,
      schemaDigest: value.schemaDigest,
    });
  } catch {
    return false;
  }
  return (
    Object.keys(value).sort().join("\0") === "apiVersion\0definitionVersion\0kind\0schemaDigest"
  );
}

function isInterface(value: unknown): value is {
  readonly apiVersion: "interfaces.takoform.com/v1alpha1";
  readonly name: string;
  readonly version: string;
  readonly schemaDigest: `sha256:${string}`;
} {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("\0") === "apiVersion\0name\0schemaDigest\0version" &&
    value.apiVersion === "interfaces.takoform.com/v1alpha1" &&
    nonEmptyString(value.name) &&
    nonEmptyString(value.version) &&
    isSha256Digest(value.schemaDigest)
  );
}

function isBindingRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).sort().join("\0") === "apiVersion\0name\0schemaDigest\0version" &&
    (value.apiVersion === "bindings.takoform.com/v1alpha1" ||
      value.apiVersion === "bindings.takoform.com/v1alpha2") &&
    nonEmptyString(value.name) &&
    nonEmptyString(value.version) &&
    isSha256Digest(value.schemaDigest)
  );
}

function exactReference(value: Record<string, unknown>): value is {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
} {
  return (
    Object.keys(value).sort().join("\0") === "apiVersion\0kind\0name" &&
    typeof value.apiVersion === "string" &&
    typeof value.kind === "string" &&
    typeof value.name === "string" &&
    value.apiVersion.length > 0 &&
    value.kind.length > 0 &&
    value.name.length > 0
  );
}

function referenceShape(
  value: Record<string, unknown>,
): { readonly apiVersion: string; readonly kind: string } | null {
  if (
    value.type !== "object" ||
    value.additionalProperties !== false ||
    !isRecord(value.properties)
  ) {
    return null;
  }
  const properties = value.properties;
  if (
    Object.keys(properties).sort().join("\0") !== "apiVersion\0kind\0name" ||
    !Array.isArray(value.required) ||
    [...value.required].sort().join("\0") !== "apiVersion\0kind\0name"
  ) {
    return null;
  }
  const apiVersion = properties.apiVersion;
  const kind = properties.kind;
  if (!isRecord(apiVersion) || !isRecord(kind)) return null;
  return typeof apiVersion.const === "string" && typeof kind.const === "string"
    ? { apiVersion: apiVersion.const, kind: kind.const }
    : null;
}

function schemaAtPointer(root: JsonObject, value: string): unknown {
  let current: unknown = root;
  for (const token of value
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!isRecord(current) || !isRecord(current.properties)) return undefined;
    current = current.properties[token];
  }
  return current;
}

function pointerValue(root: JsonObject, value: string): unknown {
  let current: unknown = root;
  for (const token of value
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!isRecord(current)) return undefined;
    current = current[token];
  }
  return current;
}

function pointer(value: unknown): value is `/${string}` {
  return typeof value === "string" && /^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/u.test(value);
}

function hasWildcard(value: string): boolean {
  return value.split("/").some((segment) => segment === "*");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addressOf(listing: ResourceListing): WorkflowResourceAddress {
  return {
    space: listing.space,
    apiVersion: listing.apiVersion,
    kind: listing.kind,
    name: listing.name,
  };
}
