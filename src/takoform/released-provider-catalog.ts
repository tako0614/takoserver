import objectBucketDefinition from "../../vendor/takoform/v2.1.1/object-bucket.definition.json" with {
  type: "json",
};
import objectBucketPackageIndex from "../../vendor/takoform/v2.1.1/object-bucket.package-index.json" with {
  type: "json",
};
import providerFormIdentities from "../../vendor/takoform/v2.1.1/provider-form-identities.json" with {
  type: "json",
};
import { canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { InstalledTakoformForm, TakoformInterfaceRef, TakoformOperation } from "./types.ts";

/** The released provider version whose exact Form catalog Takoserver implements. */
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
  readonly providedInterfaces: readonly [TakoformInterfaceRef, ...TakoformInterfaceRef[]];
}

const RELEASED_FORMS = buildReleasedForms();

/**
 * Return a detached copy so callers cannot mutate the release authority held
 * by this module. Supporting a second Form requires adding its released
 * definition/package data here; a Takoserver-local identity is never enough.
 */
export function releasedTakoformProviderForms(): readonly [ReleasedInstalledTakoformForm] {
  return structuredClone(RELEASED_FORMS);
}

/**
 * Fail closed if a shipped Form is not an exact member of the released
 * provider catalog. This checks both identity and the complete installed
 * definition, closing the "official identity, local semantics" loophole.
 */
export function assertReleasedTakoformProviderForms(forms: readonly InstalledTakoformForm[]): void {
  const releasedByIdentity = new Map(
    RELEASED_FORMS.map((form) => [formIdentityKey(form), canonicalJson(form)] as const),
  );
  const seen = new Set<string>();

  for (const form of forms) {
    const identity = formIdentityKey(form);
    const released = releasedByIdentity.get(identity);
    if (released === undefined) throw new Error("unreleased_takoform_form");
    if (seen.has(identity)) throw new Error("duplicate_released_takoform_form");
    if (canonicalJson(form) !== released) {
      throw new Error("released_takoform_definition_mismatch");
    }
    seen.add(identity);
  }
}

function buildReleasedForms(): readonly [ReleasedInstalledTakoformForm] {
  if (
    providerFormIdentities.format !== "takoform.provider-form-identities@v1" ||
    providerFormIdentities.releases.length !== 1
  ) {
    throw new Error("released_takoform_identity_ledger_invalid");
  }
  const release = providerFormIdentities.releases[0];
  if (release === undefined || release.providerVersion !== TAKOFORM_PROVIDER_RELEASE.version) {
    throw new Error("released_takoform_provider_version_mismatch");
  }
  const identities = release.forms.filter(
    (candidate) => candidate.resourceType === TAKOFORM_PROVIDER_RELEASE.objectBucketResourceType,
  );
  if (identities.length !== 1) throw new Error("released_takoform_identity_ambiguous");
  const identity = identities[0];
  if (identity === undefined || !isSha256Digest(identity.packageDigest)) {
    throw new Error("released_takoform_package_digest_invalid");
  }

  const definition = objectBucketDefinition;
  const packageIndex = objectBucketPackageIndex;
  if (
    packageIndex.apiVersion !== "packages.forms.takoform.com/v1alpha4" ||
    packageIndex.kind !== "FormPackage" ||
    packageIndex.definitionPath !== "definition.json" ||
    canonicalJson(packageIndex.formRef) !== canonicalJson(identity.formRef) ||
    definition.apiVersion !== identity.formRef.apiVersion ||
    definition.kind !== identity.formRef.kind ||
    definition.definitionVersion !== identity.formRef.definitionVersion ||
    !isSha256Digest(identity.formRef.schemaDigest)
  ) {
    throw new Error("released_takoform_package_identity_mismatch");
  }

  if (!isJsonObject(definition.desiredSchema)) {
    throw new Error("released_takoform_desired_schema_invalid");
  }
  const operations = definition.lifecycleCapabilities;
  if (!operations.every(isTakoformOperation)) {
    throw new Error("released_takoform_operations_invalid");
  }
  const providedInterfaces = definition.providedInterfaces;
  if (!providedInterfaces.every(isTakoformInterfaceRef)) {
    throw new Error("released_takoform_interfaces_invalid");
  }
  if (definition.role !== "identity") {
    throw new Error("released_takoform_role_invalid");
  }

  const firstInterface = providedInterfaces[0];
  if (firstInterface === undefined) {
    throw new Error("released_takoform_interfaces_missing");
  }
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
    displayName: definition.title,
    description: definition.description,
    role: definition.role,
    providedInterfaces: [firstInterface, ...providedInterfaces.slice(1)],
    desiredSchema: definition.desiredSchema,
    operations,
  };

  return [structuredClone(form)];
}

function formIdentityKey(form: InstalledTakoformForm): string {
  return canonicalJson(form.identity);
}

function isTakoformOperation(value: string): value is TakoformOperation {
  return ["create", "read", "update", "delete", "import", "observe"].includes(value);
}

function isTakoformInterfaceRef(value: unknown): value is TakoformInterfaceRef {
  if (!isJsonObject(value)) return false;
  return (
    value.apiVersion === "interfaces.takoform.com/v1alpha1" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    isSha256Digest(value.schemaDigest)
  );
}
