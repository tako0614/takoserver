import type { PricePlan } from "../catalog.ts";
import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import type { TakoformBindingRef } from "../interface-ref.ts";
import { canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { ProviderOffering } from "../provider-port.ts";

export const TAKOFORM_APPLY_SELECTION_VERSION = "takoserver.takoform-apply-selection@v1" as const;
export const MAX_TAKOFORM_APPLY_SELECTION_BYTES = 131_072;
const MAX_SELECTION_RELATIONS = 128;
const MAX_SELECTION_ITEMS = 128;

export interface TakoformApplySelectionDeployment {
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
  /** Pins observed/output material without retaining those possibly sensitive values. */
  readonly projectionDigest: `sha256:${string}`;
}

export interface TakoformApplySelectionRelation {
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
  readonly deployment?: TakoformApplySelectionDeployment;
}

export type TakoformApplySelection =
  | {
      readonly version: typeof TAKOFORM_APPLY_SELECTION_VERSION;
      readonly kind: "intrinsic";
    }
  | {
      readonly version: typeof TAKOFORM_APPLY_SELECTION_VERSION;
      readonly kind: "sqlite-migration";
      /** Pins both declared inputs; `/database` must carry its exact Deployment. */
      readonly relations: readonly TakoformApplySelectionRelation[];
    }
  | {
      readonly version: typeof TAKOFORM_APPLY_SELECTION_VERSION;
      readonly kind: "provider";
      readonly providerPackRef: string;
      readonly providerInstallationRef: string;
      readonly technicalOffering: ProviderOffering;
      readonly sold?: {
        readonly offeringId: string;
        readonly offeringDigest: `sha256:${string}`;
        readonly pricePlanRef: string;
        readonly pricePlan: PricePlan;
      };
      readonly incumbent?: TakoformApplySelectionDeployment;
      readonly relations: readonly TakoformApplySelectionRelation[];
    };

export function encodeTakoformApplySelection(selection: TakoformApplySelection): string {
  const encoded = canonicalJson(selection);
  // Round-trip through the same parser used for durable rows. This both strips
  // mutable caller aliases and keeps construction and recovery on one contract.
  parseTakoformApplySelection(encoded);
  return encoded;
}

export function parseTakoformApplySelection(encoded: string): TakoformApplySelection {
  const encodedBytes = new TextEncoder().encode(encoded).byteLength;
  if (encodedBytes < 2 || encodedBytes > MAX_TAKOFORM_APPLY_SELECTION_BYTES) {
    throw new TypeError("invalid apply selection");
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new TypeError("invalid apply selection");
  }
  validateSelection(value);
  if (canonicalJson(value) !== encoded) throw new TypeError("noncanonical apply selection");
  return structuredClone(value);
}

export function sameTakoformApplySelection(
  left: TakoformApplySelection,
  right: TakoformApplySelection,
): boolean {
  return encodeTakoformApplySelection(left) === encodeTakoformApplySelection(right);
}

function validateSelection(value: unknown): asserts value is TakoformApplySelection {
  if (!isJsonObject(value) || value.version !== TAKOFORM_APPLY_SELECTION_VERSION) invalid();
  if (value.kind === "intrinsic") {
    exactKeys(value, ["kind", "version"]);
    return;
  }
  if (value.kind === "sqlite-migration") {
    exactKeys(value, ["kind", "relations", "version"]);
    if (!Array.isArray(value.relations) || value.relations.length > MAX_SELECTION_RELATIONS) {
      invalid();
    }
    for (const relation of value.relations) validateRelation(relation);
    const databases = value.relations.filter(
      (relation) => isJsonObject(relation) && relation.relation === "/database",
    );
    if (databases.length !== 1 || !isJsonObject(databases[0]?.deployment)) invalid();
    return;
  }
  if (value.kind !== "provider") invalid();
  exactKeys(value, [
    "incumbent",
    "kind",
    "providerInstallationRef",
    "providerPackRef",
    "relations",
    "sold",
    "technicalOffering",
    "version",
  ]);
  identifier(value.providerPackRef);
  identifier(value.providerInstallationRef);
  validateTechnicalOffering(value.technicalOffering);
  if (value.sold !== undefined) validateSold(value.sold);
  if (value.incumbent !== undefined) validateDeployment(value.incumbent);
  if (!Array.isArray(value.relations) || value.relations.length > MAX_SELECTION_RELATIONS)
    invalid();
  for (const relation of value.relations) validateRelation(relation);
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

function validateSold(value: unknown): void {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, ["offeringDigest", "offeringId", "pricePlan", "pricePlanRef"]);
  identifier(value.offeringId);
  if (!isSha256Digest(value.offeringDigest)) invalid();
  identifier(value.pricePlanRef);
  validatePricePlan(value.pricePlan);
}

function validatePricePlan(value: unknown): asserts value is PricePlan {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, ["currency", "id", "meters", "provisioning"]);
  identifier(value.id);
  if (value.currency !== "USD") invalid();
  validateCharge(value.provisioning);
  if (!Array.isArray(value.meters) || value.meters.length > MAX_SELECTION_ITEMS) invalid();
  for (const meter of value.meters) validateCharge(meter);
}

function validateCharge(value: unknown): void {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, ["amountMinor", "meter", "quantity"]);
  boundedString(value.meter, 1, 255);
  if (!Number.isSafeInteger(value.amountMinor) || Number(value.amountMinor) < 0) invalid();
  if (
    value.quantity !== undefined &&
    (!Number.isSafeInteger(value.quantity) || Number(value.quantity) <= 0)
  )
    invalid();
}

function validateRelation(value: unknown): void {
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

function validateDeployment(value: unknown): asserts value is TakoformApplySelectionDeployment {
  if (!isJsonObject(value)) invalid();
  exactKeys(value, [
    "id",
    "nativeId",
    "offeringId",
    "projectionDigest",
    "providerInstallationRef",
    "providerPackRef",
    "resourceUid",
    "state",
  ]);
  identifier(value.id);
  boundedString(value.nativeId, 1, 4096);
  identifier(value.offeringId);
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
  throw new TypeError("invalid apply selection");
}
