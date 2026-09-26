import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import { canonicalDigest, canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { AdmissionDigest } from "./admission.ts";
import { validateFormRef } from "./forms.ts";
import type {
  TakoformImplementationCatalog,
  TakoformImplementationCatalogEntry,
} from "./implementation-catalog.ts";

/** The exact wire kind for one organization's space Form admission policy. */
export const SPACE_ADMISSION_POLICY_KIND = "takoserver.space-form-admission-policy@v1" as const;
const ORGANIZATION_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,254}$/u;

/** Current names used by the generic policy contract. */
export type TakoFormRef = TakoformV1Alpha3FormRef;
export type Sha256Digest = AdmissionDigest;

export interface SpaceAdmissionPolicyFormV1 {
  readonly formRef: TakoFormRef;
  readonly packageDigest: Sha256Digest;
}

export interface SpaceAdmissionPolicyV1 {
  readonly kind: typeof SPACE_ADMISSION_POLICY_KIND;
  readonly organizationId: string;
  readonly forms: readonly SpaceAdmissionPolicyFormV1[];
}

/** A package identity accepted by the publisher closure or implementation catalog. */
export type SpaceAdmissionPolicyIdentity = SpaceAdmissionPolicyFormV1;

export interface SpaceAdmissionPolicyValidationBounds {
  /** The complete verified publisher closure; this is never narrowed by validation. */
  readonly publisherPackageSet: readonly SpaceAdmissionPolicyIdentity[];
  /** The realized Worker implementation catalog for this Host. */
  readonly implementationCatalog: TakoformImplementationCatalog;
}

export interface ValidatedSpaceAdmissionPolicyV1 {
  readonly policy: SpaceAdmissionPolicyV1;
  readonly canonicalJson: string;
  readonly digest: AdmissionDigest;
  /** Exactly the selected identities, in canonical FormRef order. */
  readonly selectedIdentities: readonly SpaceAdmissionPolicyIdentity[];
}

export type SpaceAdmissionPolicyErrorCode =
  | "invalid_policy"
  | "noncanonical_policy"
  | "empty_policy"
  | "duplicate_form"
  | "unknown_form"
  | "unimplemented_form"
  | "package_mismatch";

export class SpaceAdmissionPolicyError extends TypeError {
  constructor(
    readonly code: SpaceAdmissionPolicyErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "SpaceAdmissionPolicyError";
  }
}

/**
 * Parses and canonicalizes a policy without consulting publisher or runtime
 * state. Object input may arrive in any property/list order; string input is
 * a stored canonical JSON representation and must already be canonical.
 */
export function parseSpaceAdmissionPolicy(input: unknown): SpaceAdmissionPolicyV1 {
  let value: unknown = input;
  const encoded = typeof input === "string" ? input : undefined;
  if (encoded !== undefined) {
    try {
      value = JSON.parse(encoded);
    } catch {
      throw invalid("policy is not valid JSON");
    }
  }
  const normalized = normalizePolicy(value);
  if (encoded !== undefined && canonicalJson(normalized) !== encoded) {
    throw new SpaceAdmissionPolicyError(
      "noncanonical_policy",
      "space admission policy JSON is not canonical",
    );
  }
  return deepFreeze(normalized);
}

/** Computes the canonical digest without mutating or trusting caller aliases. */
export async function spaceAdmissionPolicyDigest(
  policy: SpaceAdmissionPolicyV1,
): Promise<AdmissionDigest> {
  return await canonicalDigest(parseSpaceAdmissionPolicy(policy));
}

/**
 * Validates a policy as a subset of both authorities: every selected identity
 * must be present in the complete publisher closure and as the same exact
 * package identity in the realized implementation catalog.
 */
export async function validateSpaceAdmissionPolicy(
  input: unknown,
  bounds: SpaceAdmissionPolicyValidationBounds,
): Promise<ValidatedSpaceAdmissionPolicyV1> {
  const policy = parseSpaceAdmissionPolicy(input);
  const publisher = indexIdentities(bounds.publisherPackageSet, "publisher package set");
  const catalog = indexIdentities(bounds.implementationCatalog.entries, "implementation catalog");

  for (const selected of policy.forms) {
    const formKey = canonicalJson(selected.formRef);
    const publisherDigest = publisher.byForm.get(formKey);
    if (publisherDigest === undefined) {
      throw new SpaceAdmissionPolicyError(
        "unknown_form",
        `Form identity is not in the verified publisher package set: ${formKey}`,
      );
    }
    if (publisherDigest !== selected.packageDigest) {
      throw new SpaceAdmissionPolicyError(
        "package_mismatch",
        `Form package digest differs from the verified publisher package set: ${formKey}`,
      );
    }

    const implementationDigest = catalog.byForm.get(formKey);
    if (implementationDigest === undefined) {
      throw new SpaceAdmissionPolicyError(
        "unimplemented_form",
        `Form identity has no realized implementation catalog entry: ${formKey}`,
      );
    }
    if (implementationDigest !== selected.packageDigest) {
      throw new SpaceAdmissionPolicyError(
        "package_mismatch",
        `Form package digest differs from the realized implementation catalog: ${formKey}`,
      );
    }
  }

  const canonical = canonicalJson(policy);
  const selectedIdentities = policy.forms.map((entry) => ({
    formRef: structuredClone(entry.formRef),
    packageDigest: entry.packageDigest,
  }));
  const result: ValidatedSpaceAdmissionPolicyV1 = {
    policy,
    canonicalJson: canonical,
    digest: await canonicalDigest(policy),
    selectedIdentities: deepFreeze(selectedIdentities),
  };
  return deepFreeze(result);
}

function normalizePolicy(value: unknown): SpaceAdmissionPolicyV1 {
  if (!isJsonObject(value)) invalid("policy must be an object");
  exactKeys(value, ["forms", "kind", "organizationId"]);
  if (value.kind !== SPACE_ADMISSION_POLICY_KIND) invalid("policy kind is invalid");
  if (
    typeof value.organizationId !== "string" ||
    !ORGANIZATION_REFERENCE.test(value.organizationId)
  ) {
    invalid("organizationId is invalid");
  }
  if (!Array.isArray(value.forms) || value.forms.length === 0) {
    throw new SpaceAdmissionPolicyError("empty_policy", "policy forms must be nonempty");
  }

  const forms: SpaceAdmissionPolicyFormV1[] = [];
  const seen = new Set<string>();
  for (const item of value.forms) {
    if (!isJsonObject(item)) invalid("policy form must be an object");
    exactKeys(item, ["formRef", "packageDigest"]);
    const formRef = parseFormRef(item.formRef);
    if (!isSha256Digest(item.packageDigest)) invalid("policy package digest is invalid");
    const formKey = canonicalJson(formRef);
    if (seen.has(formKey)) {
      throw new SpaceAdmissionPolicyError(
        "duplicate_form",
        "policy contains a duplicate or conflicting package identity for one FormRef",
      );
    }
    seen.add(formKey);
    forms.push({ formRef, packageDigest: item.packageDigest });
  }
  forms.sort(compareIdentities);
  return {
    kind: SPACE_ADMISSION_POLICY_KIND,
    organizationId: value.organizationId,
    forms,
  };
}

function parseFormRef(value: unknown): TakoFormRef {
  if (!isJsonObject(value)) invalid("policy FormRef must be an object");
  exactKeys(value, ["apiVersion", "definitionVersion", "kind", "schemaDigest"]);
  if (
    typeof value.apiVersion !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.definitionVersion !== "string" ||
    !isSha256Digest(value.schemaDigest)
  ) {
    invalid("policy FormRef is invalid");
  }
  const formRef: TakoFormRef = {
    apiVersion: value.apiVersion,
    kind: value.kind,
    definitionVersion: value.definitionVersion,
    schemaDigest: value.schemaDigest,
  };
  try {
    validateFormRef(formRef);
  } catch {
    invalid("policy FormRef is invalid");
  }
  return formRef;
}

function indexIdentities(
  identities:
    | readonly SpaceAdmissionPolicyIdentity[]
    | readonly TakoformImplementationCatalogEntry[],
  label: string,
): { readonly byForm: ReadonlyMap<string, Sha256Digest> } {
  const byForm = new Map<string, Sha256Digest>();
  for (const identity of identities) {
    const formRef = parseFormRef(identity?.formRef);
    if (!isSha256Digest(identity?.packageDigest)) {
      throw new SpaceAdmissionPolicyError(
        "invalid_policy",
        `${label} contains an invalid package digest`,
      );
    }
    const key = canonicalJson(formRef);
    const existing = byForm.get(key);
    if (existing !== undefined && existing !== identity.packageDigest) {
      throw new SpaceAdmissionPolicyError(
        "package_mismatch",
        `${label} contains conflicting package identities for one FormRef`,
      );
    }
    byForm.set(key, identity.packageDigest);
  }
  return { byForm };
}

function compareIdentities(
  left: SpaceAdmissionPolicyIdentity,
  right: SpaceAdmissionPolicyIdentity,
): number {
  return `${canonicalJson(left.formRef)}\0${left.packageDigest}`.localeCompare(
    `${canonicalJson(right.formRef)}\0${right.packageDigest}`,
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    invalid("policy contains unexpected fields");
  }
}

function invalid(message: string): never {
  throw new SpaceAdmissionPolicyError("invalid_policy", message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
