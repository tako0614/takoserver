import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import type { TakoformBindingRef } from "../interface-ref.ts";
import { canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { ProviderOffering } from "../provider-port.ts";

/**
 * The immutable placement/adoption proof retained for an import operation.
 *
 * This is deliberately a separate envelope from apply selection. Import has
 * no commercial authority, pricing, or nested apply snapshot: it records only
 * the provider destination and the exact relation/deployment view used to
 * adopt the named native object.
 */
export const TAKOFORM_IMPORT_SELECTION_VERSION = "takoserver.takoform-import-selection@v1" as const;
export const MAX_TAKOFORM_IMPORT_SELECTION_BYTES = 131_072;

const MAX_SELECTION_RELATIONS = 128;
const MAX_SELECTION_ITEMS = 128;

export interface TakoformImportSelectionDeployment {
  readonly id: string;
  readonly resourceUid: string;
  readonly offeringId: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly nativeId: string;
  readonly state:
    | "provisioning"
    | "candidate"
    | "active"
    | "draining"
    | "retained"
    | "failed"
    | "deleted";
  /** Whether the deployment's native identity is an accepted import claim. */
  readonly nativeClaimed: boolean;
  /** Pins observed/output material without retaining those possibly sensitive values. */
  readonly projectionDigest: `sha256:${string}`;
}

export interface TakoformImportSelectionRelation {
  readonly pointer: string;
  readonly relation: string;
  readonly targetUid: string;
  readonly resource: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly formRef: TakoformV1Alpha3FormRef;
    readonly name: string;
    readonly space: string;
    readonly uid: string;
    readonly generation: string;
    readonly revision: string;
  };
  readonly bindingRef?: TakoformBindingRef;
  readonly deployment?: TakoformImportSelectionDeployment;
}

export type TakoformImportSelectionPlacement =
  | { readonly kind: "catalog"; readonly offeringId: string }
  | { readonly kind: "inherited" };

export type TakoformImportSelection =
  | {
      readonly version: typeof TAKOFORM_IMPORT_SELECTION_VERSION;
      readonly kind: "intrinsic";
      readonly nativeId: string;
    }
  | {
      readonly version: typeof TAKOFORM_IMPORT_SELECTION_VERSION;
      readonly kind: "sqlite-migration";
      readonly nativeId: string;
      /** Pins both declared inputs; `/database` must carry its exact Deployment. */
      readonly relations: readonly TakoformImportSelectionRelation[];
    }
  | {
      readonly version: typeof TAKOFORM_IMPORT_SELECTION_VERSION;
      readonly kind: "provider";
      readonly nativeId: string;
      readonly providerPackRef: string;
      readonly providerInstallationRef: string;
      readonly technicalOffering: ProviderOffering;
      readonly placement: TakoformImportSelectionPlacement;
      readonly incumbent?: TakoformImportSelectionDeployment;
      readonly relations: readonly TakoformImportSelectionRelation[];
    };

export function encodeTakoformImportSelection(selection: TakoformImportSelection): string {
  const encoded = canonicalJson(selection);
  // Round-trip through the durable parser so mutable caller aliases and
  // malformed optional fields cannot enter a saga row from an in-memory call.
  parseTakoformImportSelection(encoded);
  return encoded;
}

export function parseTakoformImportSelection(encoded: string): TakoformImportSelection {
  const encodedBytes = new TextEncoder().encode(encoded).byteLength;
  if (encodedBytes < 2 || encodedBytes > MAX_TAKOFORM_IMPORT_SELECTION_BYTES) invalid();
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    invalid();
  }
  validateSelection(value);
  if (canonicalJson(value) !== encoded) throw new TypeError("noncanonical import selection");
  return structuredClone(value);
}

export function sameTakoformImportSelection(
  left: TakoformImportSelection,
  right: TakoformImportSelection,
): boolean {
  return encodeTakoformImportSelection(left) === encodeTakoformImportSelection(right);
}

function validateSelection(value: unknown): asserts value is TakoformImportSelection {
  if (!isJsonObject(value) || value.version !== TAKOFORM_IMPORT_SELECTION_VERSION) invalid();
  if (value.kind === "intrinsic") {
    exactKeys(value, ["kind", "nativeId", "version"]);
    identifier(value.nativeId);
    return;
  }
  if (value.kind === "sqlite-migration") {
    exactKeys(value, ["kind", "nativeId", "relations", "version"]);
    identifier(value.nativeId);
    const relations = validateRelations(value.relations);
    const databases = relations.filter((relation) => relation.relation === "/database");
    if (databases.length !== 1 || databases[0]?.deployment === undefined) invalid();
    return;
  }
  if (value.kind !== "provider") invalid();
  exactKeys(value, [
    "incumbent",
    "kind",
    "nativeId",
    "placement",
    "providerInstallationRef",
    "providerPackRef",
    "relations",
    "technicalOffering",
    "version",
  ]);
  identifier(value.providerPackRef);
  identifier(value.providerInstallationRef);
  identifier(value.nativeId);
  validateTechnicalOffering(value.technicalOffering);
  validatePlacement(value.placement);
  if (value.incumbent !== undefined) validateDeployment(value.incumbent);
  validateRelations(value.relations);
}

function validatePlacement(value: unknown): asserts value is TakoformImportSelectionPlacement {
  if (!isJsonObject(value)) invalid();
  if (value.kind === "catalog") {
    exactKeys(value, ["kind", "offeringId"]);
    identifier(value.offeringId);
    return;
  }
  if (value.kind === "inherited") {
    exactKeys(value, ["kind"]);
    return;
  }
  invalid();
}

function validateTechnicalOffering(value: unknown): asserts value is ProviderOffering {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, [
    "bindingRefs",
    "capabilities",
    "displayName",
    "form",
    "id",
    "kind",
    "providedInterfaces",
    "regions",
  ]);
  identifier(value.id);
  boundedString(value.kind, 1, 128);
  boundedString(value.displayName, 1, 512);
  validateFormRef(value.form);
  stringArray(value.capabilities, ["create", "update", "delete", "import", "observe"]);
  if (value.regions !== undefined) stringArray(value.regions);
  if (
    !Array.isArray(value.providedInterfaces) ||
    value.providedInterfaces.length > MAX_SELECTION_ITEMS
  )
    invalid();
  for (const item of value.providedInterfaces) validateInterfaceRef(item);
  if (!Array.isArray(value.bindingRefs) || value.bindingRefs.length > MAX_SELECTION_ITEMS)
    invalid();
  for (const item of value.bindingRefs) validateBindingRef(item);
}

function validateRelations(value: unknown): TakoformImportSelectionRelation[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTION_RELATIONS) invalid();
  for (const relation of value) validateRelation(relation);
  return value as TakoformImportSelectionRelation[];
}

function validateRelation(value: unknown): asserts value is TakoformImportSelectionRelation {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, ["bindingRef", "deployment", "pointer", "relation", "resource", "targetUid"]);
  boundedString(value.pointer, 1, 1024);
  boundedString(value.relation, 1, 1024);
  identifier(value.targetUid);
  if (!isJsonObject(value.resource)) invalid();
  exactKeys(value.resource, [
    "apiVersion",
    "formRef",
    "generation",
    "kind",
    "name",
    "revision",
    "space",
    "uid",
  ]);
  boundedString(value.resource.apiVersion, 1, 320);
  boundedString(value.resource.kind, 1, 128);
  validateFormRef(value.resource.formRef);
  boundedString(value.resource.name, 1, 128);
  boundedString(value.resource.space, 1, 255);
  identifier(value.resource.uid);
  boundedString(value.resource.generation, 1, 128);
  boundedString(value.resource.revision, 1, 128);
  if (value.bindingRef !== undefined) validateBindingRef(value.bindingRef);
  if (value.deployment !== undefined) validateDeployment(value.deployment);
}

function validateDeployment(value: unknown): asserts value is TakoformImportSelectionDeployment {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, [
    "id",
    "nativeClaimed",
    "nativeId",
    "offeringId",
    "projectionDigest",
    "providerInstallationRef",
    "providerPackRef",
    "resourceUid",
    "state",
  ]);
  identifier(value.id);
  identifier(value.nativeId);
  identifier(value.offeringId);
  if (typeof value.nativeClaimed !== "boolean") invalid();
  if (!isSha256Digest(value.projectionDigest)) invalid();
  identifier(value.providerInstallationRef);
  identifier(value.providerPackRef);
  identifier(value.resourceUid);
  if (
    !["provisioning", "candidate", "active", "draining", "retained", "failed", "deleted"].includes(
      String(value.state),
    )
  )
    invalid();
}

function validateFormRef(value: unknown): asserts value is TakoformV1Alpha3FormRef {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, ["apiVersion", "definitionVersion", "kind", "schemaDigest"]);
  boundedString(value.apiVersion, 1, 320);
  boundedString(value.definitionVersion, 1, 128);
  boundedString(value.kind, 1, 128);
  if (!isSha256Digest(value.schemaDigest)) invalid();
}

function validateInterfaceRef(value: unknown): void {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, ["apiVersion", "name", "schemaDigest", "version"]);
  if (value.apiVersion !== "interfaces.takoform.com/v1alpha1") invalid();
  boundedString(value.name, 1, 255);
  boundedString(value.version, 1, 128);
  if (!isSha256Digest(value.schemaDigest)) invalid();
}

function validateBindingRef(value: unknown): asserts value is TakoformBindingRef {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, ["apiVersion", "name", "schemaDigest", "version"]);
  if (
    value.apiVersion !== "bindings.takoform.com/v1alpha1" &&
    value.apiVersion !== "bindings.takoform.com/v1alpha2"
  )
    invalid();
  boundedString(value.name, 1, 255);
  boundedString(value.version, 1, 128);
  if (!isSha256Digest(value.schemaDigest)) invalid();
}

function stringArray(value: unknown, allowed?: readonly string[]): void {
  if (!Array.isArray(value) || value.length > MAX_SELECTION_ITEMS) invalid();
  for (const item of value) {
    boundedString(item, 1, 255);
    if (allowed && !allowed.includes(item)) invalid();
  }
}

function identifier(value: unknown): asserts value is string {
  boundedString(value, 1, 4096);
}

function boundedString(value: unknown, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) invalid();
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const expected = keys.filter((key) => value[key] !== undefined).sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid();
  }
}

function invalid(): never {
  throw new TypeError("invalid import selection");
}
