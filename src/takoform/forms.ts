import type { JsonObject } from "../ports.ts";
import { isEdgeFormsApiVersion } from "./edge-family.ts";
import {
  TAKOFORM_MAXIMUM_FILE_BUNDLE_FILES,
  TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES,
  TAKOFORM_MAXIMUM_WORKER_BUNDLE_MODULES,
} from "./limits.ts";
import { validateRelationSchema } from "./relations.ts";
import { standardServiceDeclarations } from "./standard-services.ts";
import {
  type InstalledTakoformForm,
  TakoformHostError,
  type TakoformV1Alpha3FormRef,
} from "./types.ts";

/**
 * The installed Form registry: which exact Form identities this deployment can
 * execute, and the identity rules that decide whether a request names one.
 *
 * Identity is the whole quad — group, kind, definition version, and schema
 * digest. Retained families may carry a group version, but current families do
 * not. A request that gets any part wrong names a Form that does not exist
 * here, which is why every lookup failure is `form_unknown` rather than a
 * validation error: the Host will not guess which Form a caller meant.
 */

export const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FORM_GROUP =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const FORM_VERSION = /^v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/u;
const RESERVED_FORM_GROUPS = new Set([
  "forms.takoform.com",
  "packages.forms.takoform.com",
  "trust.forms.takoform.com",
]);
const KIND = /^[A-Z][A-Za-z0-9]{0,63}$/u;
const SPEC_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const DEFINITION_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

export interface FormRefLike {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

export type FormRegistry = ReadonlyMap<string, InstalledTakoformForm>;

/**
 * Builds the registry, refusing configurations that would make an exact lookup
 * ambiguous: two Forms with the same identity, or one definition presented
 * under two schema digests.
 */
export function installedForms(
  input: readonly InstalledTakoformForm[],
  hostApiVersion?: string,
): FormRegistry {
  const result = new Map<string, InstalledTakoformForm>();
  const definitionDigests = new Map<string, string>();
  for (const form of input) {
    validateFormRef(form.identity.formRef);
    if (form.requiresHostApi !== undefined) {
      if (
        hostApiVersion === undefined ||
        compareHostApiVersions(hostApiVersion, form.requiresHostApi) < 0
      ) {
        throw new TypeError(
          `Form ${form.identity.formRef.kind} requires ${form.requiresHostApi} but host implements ${hostApiVersion ?? "no Host API"}`,
        );
      }
    }
    if (form.identity.packageDigest && !DIGEST.test(form.identity.packageDigest)) {
      throw new TypeError("invalid package digest");
    }
    if (
      form.artifactRequirement !== undefined &&
      !SPEC_FIELD.test(form.artifactRequirement.specField)
    ) {
      throw new TypeError("invalid artifact manifest spec field");
    }
    if (form.role === "revision" && form.operations.includes("update")) {
      throw new TypeError("revision Form cannot declare update");
    }
    if (form.workerClassRuntime) {
      const contract = form.workerClassRuntime;
      const explicitInterface = (form.providedInterfaces ?? []).some(
        (candidate) => candidate.name === contract.providedInterface,
      );
      const explicitConstraint = (form.constraints ?? []).some(
        (constraint) =>
          constraint.kind === "exclusive" &&
          constraint.reference === contract.workerRelation &&
          constraint.keyedBy === contract.className,
      );
      if (!explicitInterface || !explicitConstraint) {
        throw new TypeError("worker class runtime must be declared by the Form");
      }
    }
    validateRelationSchema(form);
    standardServiceDeclarations(form);
    const definitionKey = `${form.identity.formRef.apiVersion}\0${form.identity.formRef.kind}\0${form.identity.formRef.definitionVersion}`;
    const installedDigest = definitionDigests.get(definitionKey);
    if (installedDigest !== undefined && installedDigest !== form.identity.formRef.schemaDigest) {
      throw new TypeError("ambiguous installed Form definition");
    }
    definitionDigests.set(definitionKey, form.identity.formRef.schemaDigest);
    const key = formKey(form.identity.formRef);
    if (result.has(key)) throw new TypeError("duplicate installed Form identity");
    result.set(key, structuredClone(form));
  }
  return result;
}

export function exactInstalledForm(
  input: FormRefLike,
  forms: FormRegistry,
): InstalledTakoformForm | undefined {
  try {
    validateFormRef(input);
    return forms.get(formKey(input));
  } catch {
    return undefined;
  }
}

export function formKey(input: FormRefLike): string {
  return `${input.apiVersion}\0${input.kind}\0${input.definitionVersion}\0${input.schemaDigest}`;
}

export function sameFormRef(
  left: TakoformV1Alpha3FormRef,
  right: TakoformV1Alpha3FormRef,
): boolean {
  return formKey(left) === formKey(right);
}

/**
 * Whether two references name the same Form, whatever definition of it.
 *
 * A Form's identity includes the digest of its schema, which is what stops a
 * caller from being handed different semantics than the ones they reviewed. It
 * is not meant to freeze a resource on the definition it was born under: a
 * declaration that names a newer definition *and* its exact digest is being as
 * explicit as the protocol allows. Same group and kind is the whole test —
 * a different kind at the same address is a different resource, not a newer
 * version of this one.
 */
export function sameFormLineage(
  left: TakoformV1Alpha3FormRef,
  right: TakoformV1Alpha3FormRef,
): boolean {
  return left.apiVersion === right.apiVersion && left.kind === right.kind;
}

/**
 * The retired `forms.takoform.com` alpha versions are blocklisted by name: they
 * were withdrawn, and accepting them would let a stale client believe it is
 * talking to a lane this Host still serves.
 */
export function validateFormRef(input: FormRefLike): void {
  const [group, version, ...rest] = input.apiVersion.split("/");
  if (
    rest.length !== 0 ||
    !group ||
    !isFormGroup(group) ||
    (version !== undefined && !FORM_VERSION.test(version)) ||
    input.apiVersion === "forms.takoform.com/v1alpha1" ||
    input.apiVersion === "forms.takoform.com/v1alpha2" ||
    !KIND.test(input.kind) ||
    !DEFINITION_VERSION.test(input.definitionVersion) ||
    !DIGEST.test(input.schemaDigest)
  ) {
    throw new TypeError("invalid Form identity");
  }
}

/** Compares Host API lanes so `requiresHostApi` remains a lower bound. */
export function compareHostApiVersions(current: string, required: string): number {
  const parse = (value: string): readonly [number, number, number] => {
    const match = /^forms\.takoform\.com\/v([0-9]+)(?:(alpha|beta)([0-9]+))?$/u.exec(value);
    if (!match) throw new TypeError(`invalid Host API version ${value}`);
    return [
      Number(match[1]),
      match[2] === "alpha" ? 0 : match[2] === "beta" ? 1 : 2,
      Number(match[3] ?? 0),
    ];
  };
  const left = parse(current);
  const right = parse(required);
  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart !== undefined && rightPart !== undefined && leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

export function isFormGroup(value: string): boolean {
  return value.length <= 320 && FORM_GROUP.test(value) && !RESERVED_FORM_GROUPS.has(value);
}

export function isFormVersion(value: string): boolean {
  return FORM_VERSION.test(value);
}

export function isKind(value: string): boolean {
  return KIND.test(value);
}

export function isDefinitionVersion(value: string): boolean {
  return DEFINITION_VERSION.test(value);
}

export function isFormApiVersion(value: string): boolean {
  const [group, version, ...rest] = value.split("/");
  return (
    rest.length === 0 &&
    group !== undefined &&
    isFormGroup(group) &&
    (version === undefined || FORM_VERSION.test(version)) &&
    value.length <= 320
  );
}

/**
 * Extracts the Form family group from a stable or retained Form apiVersion.
 *
 * Stable v1 families are versionless (`forms.example.com`), while retained
 * predecessor families may carry one API version (`forms.example.com/v1beta1`).
 * Parse the complete value before extracting the group so an invalid ref can
 * never be turned into a seemingly valid namespace by truncation.
 */
export function formGroupFromApiVersion(apiVersion: string): string | null {
  if (typeof apiVersion !== "string") return null;
  const [group, version, ...rest] = apiVersion.split("/");
  if (
    rest.length !== 0 ||
    group === undefined ||
    !isFormGroup(group) ||
    (version !== undefined && !isFormVersion(version))
  ) {
    return null;
  }
  return group;
}

/** What a caller may rely on before attempting an operation on this Form. */
export function formSupportProfile(
  form: InstalledTakoformForm,
  apiVersion:
    | "support.takoform.com/v1alpha1"
    | "support.takoform.com/v1alpha2"
    | "support.takoform.com/v1" = "support.takoform.com/v1alpha1",
): JsonObject {
  const supportedEnums = topLevelSupportedEnums(form.desiredSchema);
  const stableProfile = apiVersion === "support.takoform.com/v1";
  const renderedSupportedEnums = stableProfile
    ? Object.fromEntries(
        Object.entries(supportedEnums).map(([name, values]) => [jsonPointer(name), values]),
      )
    : supportedEnums;
  const edgeForm = isEdgeFormsApiVersion(form.identity.formRef.apiVersion);
  const workerVersion = edgeForm && form.identity.formRef.kind === "WorkerVersion";
  const artifactFileLimit = edgeForm
    ? form.identity.formRef.kind === "WorkerBundle"
      ? TAKOFORM_MAXIMUM_WORKER_BUNDLE_MODULES
      : form.identity.formRef.kind === "StaticAssetBundle" ||
          form.identity.formRef.kind === "SQLiteMigrationSet"
        ? TAKOFORM_MAXIMUM_FILE_BUNDLE_FILES
        : undefined
    : undefined;
  const configuredArtifactFileLimit =
    artifactFileLimit ??
    (form.artifactRequirement?.kind === "WorkerBundle"
      ? TAKOFORM_MAXIMUM_WORKER_BUNDLE_MODULES
      : form.artifactRequirement !== undefined
        ? TAKOFORM_MAXIMUM_FILE_BUNDLE_FILES
        : undefined);
  const limits: Record<string, number> = {};
  if (configuredArtifactFileLimit !== undefined || workerVersion) {
    limits[stableProfile ? "/maximumBundleBytes" : "maximumBundleBytes"] =
      TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES;
  }
  if (configuredArtifactFileLimit !== undefined) {
    limits[stableProfile ? "/maximumBundleFiles" : "maximumBundleFiles"] =
      configuredArtifactFileLimit;
  }
  if (workerVersion) {
    limits[stableProfile ? "/requiredSensitiveVars" : "requiredSensitiveVars"] = 0;
  }
  return {
    apiVersion,
    kind: "FormSupport",
    formRef: structuredClone(form.identity.formRef) as unknown as JsonObject,
    operations: [...form.operations],
    ...(Object.keys(renderedSupportedEnums).length > 0
      ? { supportedEnums: renderedSupportedEnums }
      : {}),
    ...(form.acceptedBindings && form.acceptedBindings.length > 0
      ? {
          supportedBindings: form.acceptedBindings.map(
            (binding) => `${binding.name}@${binding.version}`,
          ),
        }
      : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

function jsonPointer(member: string): string {
  return `/${member.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function topLevelSupportedEnums(schema: JsonObject): JsonObject {
  const result: Record<string, string[]> = {};
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return result;
  }
  for (const [name, raw] of Object.entries(properties)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const property = raw as JsonObject;
    const direct = Array.isArray(property.enum) ? property.enum : undefined;
    const items =
      typeof property.items === "object" &&
      property.items !== null &&
      !Array.isArray(property.items)
        ? (property.items as JsonObject)
        : undefined;
    const values = direct ?? (Array.isArray(items?.enum) ? items.enum : undefined);
    if (values?.length && values.every((value) => typeof value === "string")) {
      result[name] = values as string[];
    }
  }
  return result;
}

export function requireInstalledOperation(
  form: InstalledTakoformForm,
  operation: InstalledTakoformForm["operations"][number],
): void {
  if (!form.operations.includes(operation)) {
    throw new TakoformHostError("unsupported_capability", 422);
  }
}
