import providerFormIdentities from "../../vendor/takoform/v2.1.1/provider-form-identities.json" with {
  type: "json",
};
import { canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import { RELEASED_BINDING_SOURCES, RELEASED_FORM_SOURCES } from "./released-provider-sources.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformBindingRef,
  TakoformInterfaceRef,
  TakoformOperation,
} from "./types.ts";

/** The retained provider version installed for historical Form drain only. */
export const TAKOFORM_PROVIDER_RELEASE = Object.freeze({
  version: "2.1.1",
  commit: "9810570d542434efcf177543de9d463bbfda0d09",
  objectBucketResourceType: "takoform_edge_object_bucket",
});

export interface ReleasedInstalledTakoformForm extends InstalledTakoformForm {
  readonly identity: {
    readonly formRef: InstalledTakoformForm["identity"]["formRef"];
    readonly packageDigest: `sha256:${string}`;
  };
}

const RELEASED_FORMS = buildReleasedForms();
const RELEASED_BINDINGS = buildReleasedBindings(RELEASED_FORMS);

/** Detached exact Forms carried by registry.terraform.io/tako0614/takoform v2.1.1 for drain. */
export function releasedTakoformProviderForms(): readonly [
  ReleasedInstalledTakoformForm,
  ...ReleasedInstalledTakoformForm[],
] {
  return structuredClone(RELEASED_FORMS);
}

/** Detached exact BindingDefinitions accepted by the released WorkerVersion. */
export function releasedTakoformProviderBindings(): readonly InstalledTakoformBinding[] {
  return structuredClone(RELEASED_BINDINGS);
}

/** Refuse an official identity paired with local or incomplete semantics. */
export function assertReleasedTakoformProviderForms(forms: readonly InstalledTakoformForm[]): void {
  assertReleasedMembers(
    forms,
    RELEASED_FORMS,
    formIdentityKey,
    "unreleased_takoform_form",
    "duplicate_released_takoform_form",
    "released_takoform_definition_mismatch",
  );
}

/** Refuse a BindingDefinition not carried by the same released catalog. */
export function assertReleasedTakoformProviderBindings(
  bindings: readonly InstalledTakoformBinding[],
): void {
  assertReleasedMembers(
    bindings,
    RELEASED_BINDINGS,
    (binding) => canonicalJson(binding.bindingRef),
    "unreleased_takoform_binding",
    "duplicate_released_takoform_binding",
    "released_takoform_binding_mismatch",
  );
}

function buildReleasedForms(): readonly [
  ReleasedInstalledTakoformForm,
  ...ReleasedInstalledTakoformForm[],
] {
  if (
    providerFormIdentities.format !== "takoform.provider-form-identities@v1" ||
    providerFormIdentities.releases.length !== 1
  ) {
    throw new Error("released_takoform_identity_ledger_invalid");
  }
  const release = providerFormIdentities.releases[0];
  if (
    release === undefined ||
    release.providerVersion !== TAKOFORM_PROVIDER_RELEASE.version ||
    release.forms.length !== RELEASED_FORM_SOURCES.length
  ) {
    throw new Error("released_takoform_provider_version_mismatch");
  }
  const identities = new Map(
    release.forms.map((identity) => [canonicalJson(identity.formRef), identity] as const),
  );
  const forms = RELEASED_FORM_SOURCES.map(
    ({ definition: rawDefinition, packageIndex: rawIndex }) => {
      if (!isJsonObject(rawDefinition) || !isJsonObject(rawIndex)) {
        throw new Error("released_takoform_package_invalid");
      }
      const definition = rawDefinition as unknown as JsonObject;
      const packageIndex = rawIndex as unknown as JsonObject;
      if (!isFormRef(packageIndex.formRef)) {
        throw new Error("released_takoform_package_identity_mismatch");
      }
      const identity = identities.get(canonicalJson(packageIndex.formRef));
      if (
        identity === undefined ||
        !isSha256Digest(identity.packageDigest) ||
        !isSha256Digest(identity.formRef.schemaDigest) ||
        packageIndex.apiVersion !== "packages.forms.takoform.com/v1alpha4" ||
        packageIndex.kind !== "FormPackage" ||
        packageIndex.definitionPath !== "definition.json" ||
        definition.apiVersion !== identity.formRef.apiVersion ||
        definition.kind !== identity.formRef.kind ||
        definition.definitionVersion !== identity.formRef.definitionVersion ||
        !isJsonObject(definition.desiredSchema)
      ) {
        throw new Error("released_takoform_package_identity_mismatch");
      }
      const operations = operationList(definition.lifecycleCapabilities);
      const providedInterfaces = interfaceList(definition.providedInterfaces);
      const acceptedBindings = bindingRefList(definition.acceptedBindings);
      const role = formRole(definition.role);
      const observedSchema = optionalSchema(definition.observedSchema);
      const outputSchema = optionalSchema(definition.outputSchema);
      const form: ReleasedInstalledTakoformForm = {
        identity: {
          formRef: {
            apiVersion: identity.formRef.apiVersion,
            kind: identity.formRef.kind,
            definitionVersion: identity.formRef.definitionVersion,
            schemaDigest: identity.formRef.schemaDigest,
          },
          packageDigest: identity.packageDigest,
        },
        ...(typeof definition.title === "string" ? { displayName: definition.title } : {}),
        ...(typeof definition.description === "string"
          ? { description: definition.description }
          : {}),
        ...(role ? { role } : {}),
        ...(providedInterfaces.length > 0 ? { providedInterfaces } : {}),
        ...(acceptedBindings.length > 0 ? { acceptedBindings } : {}),
        desiredSchema: definition.desiredSchema,
        ...(observedSchema ? { observedSchema } : {}),
        ...(outputSchema ? { outputSchema } : {}),
        operations,
        ...artifactRequirement(identity.formRef.kind),
      };
      return form;
    },
  );
  if (identities.size !== forms.length || forms[0] === undefined) {
    throw new Error("released_takoform_catalog_incomplete");
  }
  return forms as [ReleasedInstalledTakoformForm, ...ReleasedInstalledTakoformForm[]];
}

function buildReleasedBindings(
  forms: readonly InstalledTakoformForm[],
): readonly InstalledTakoformBinding[] {
  const accepted = forms.flatMap((form) => form.acceptedBindings ?? []);
  const bindings = RELEASED_BINDING_SOURCES.map((raw) => {
    if (!isJsonObject(raw)) throw new Error("released_takoform_binding_invalid");
    const bindingRef = accepted.find(
      (candidate) => candidate.name === raw.name && candidate.version === raw.version,
    );
    const sourceRole = formRole(raw.sourceRole);
    if (
      raw.apiVersion !== "bindings.takoform.com/v1alpha1" ||
      raw.kind !== "BindingDefinition" ||
      !bindingRef ||
      !sourceRole ||
      !isTakoformInterfaceRef(raw.targetInterface) ||
      !Array.isArray(raw.allowedTargetForms) ||
      !raw.allowedTargetForms.every(isAllowedTargetForm)
    ) {
      throw new Error("released_takoform_binding_invalid");
    }
    return {
      bindingRef: structuredClone(bindingRef),
      sourceRole,
      targetInterface: structuredClone(raw.targetInterface),
      allowedTargetForms: structuredClone(raw.allowedTargetForms),
    } satisfies InstalledTakoformBinding;
  });
  if (bindings.length !== accepted.length) {
    throw new Error("released_takoform_binding_catalog_incomplete");
  }
  return bindings;
}

function artifactRequirement(
  kind: string,
): Pick<InstalledTakoformForm, "artifactRequirement"> | object {
  if (kind === "WorkerBundle") {
    return { artifactRequirement: { specField: "manifestDigest", kind: "WorkerBundle" } };
  }
  if (kind === "StaticAssetBundle") {
    return { artifactRequirement: { specField: "manifestDigest", kind: "StaticAssetBundle" } };
  }
  if (kind === "SQLiteMigrationSet") {
    return { artifactRequirement: { specField: "manifestDigest", kind: "MigrationBundle" } };
  }
  return {};
}

function assertReleasedMembers<T>(
  values: readonly T[],
  releasedValues: readonly T[],
  key: (value: T) => string,
  unknownCode: string,
  duplicateCode: string,
  mismatchCode: string,
): void {
  const released = new Map(
    releasedValues.map((value) => [key(value), canonicalJson(value as never)] as const),
  );
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    const expected = released.get(identity);
    if (expected === undefined) throw new Error(unknownCode);
    if (seen.has(identity)) throw new Error(duplicateCode);
    if (canonicalJson(value as never) !== expected) throw new Error(mismatchCode);
    seen.add(identity);
  }
}

function formIdentityKey(form: InstalledTakoformForm): string {
  return canonicalJson(form.identity);
}

function isFormRef(value: unknown): value is InstalledTakoformForm["identity"]["formRef"] {
  return (
    isJsonObject(value) &&
    typeof value.apiVersion === "string" &&
    typeof value.kind === "string" &&
    typeof value.definitionVersion === "string" &&
    isSha256Digest(value.schemaDigest)
  );
}

function operationList(value: unknown): readonly TakoformOperation[] {
  if (!Array.isArray(value) || !value.every(isTakoformOperation)) {
    throw new Error("released_takoform_operations_invalid");
  }
  return [...value];
}

function interfaceList(value: unknown): readonly TakoformInterfaceRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isTakoformInterfaceRef)) {
    throw new Error("released_takoform_interfaces_invalid");
  }
  return structuredClone(value);
}

function bindingRefList(value: unknown): readonly TakoformBindingRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isTakoformBindingRef)) {
    throw new Error("released_takoform_binding_refs_invalid");
  }
  return structuredClone(value);
}

function optionalSchema(value: unknown) {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw new Error("released_takoform_schema_invalid");
  return value;
}

function formRole(value: unknown): InstalledTakoformForm["role"] | undefined {
  return ["identity", "revision", "deployment", "attachment", "policy"].includes(String(value))
    ? (value as NonNullable<InstalledTakoformForm["role"]>)
    : undefined;
}

function isTakoformOperation(value: unknown): value is TakoformOperation {
  return ["create", "read", "update", "delete", "import", "observe"].includes(String(value));
}

function isTakoformInterfaceRef(value: unknown): value is TakoformInterfaceRef {
  return (
    isJsonObject(value) &&
    value.apiVersion === "interfaces.takoform.com/v1alpha1" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    isSha256Digest(value.schemaDigest)
  );
}

function isTakoformBindingRef(value: unknown): value is TakoformBindingRef {
  return (
    isJsonObject(value) &&
    value.apiVersion === "bindings.takoform.com/v1alpha1" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    isSha256Digest(value.schemaDigest)
  );
}

function isAllowedTargetForm(value: unknown): value is {
  readonly apiVersion: string;
  readonly kind: string;
} {
  return (
    isJsonObject(value) && typeof value.apiVersion === "string" && typeof value.kind === "string"
  );
}
