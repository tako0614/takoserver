import type { JsonObject } from "../ports.ts";
import { TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES } from "./limits.ts";
import {
  type InstalledTakoformForm,
  TakoformHostError,
  type TakoformV1Alpha3FormRef,
} from "./types.ts";

/**
 * The installed Form registry: which exact Form identities this deployment can
 * execute, and the identity rules that decide whether a request names one.
 *
 * Identity is the whole quad — group/version, kind, definition version, and
 * schema digest. A request that gets any part wrong names a Form that does not
 * exist here, which is why every lookup failure is `form_unknown` rather than a
 * validation error: the Host will not guess which Form a caller meant.
 */

export const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FORM_GROUP =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const FORM_VERSION = /^v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/u;
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
export function installedForms(input: readonly InstalledTakoformForm[]): FormRegistry {
  const result = new Map<string, InstalledTakoformForm>();
  const definitionDigests = new Map<string, string>();
  for (const form of input) {
    validateFormRef(form.identity.formRef);
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
 * The retired `forms.takoform.com` alpha versions are blocklisted by name: they
 * were withdrawn, and accepting them would let a stale client believe it is
 * talking to a lane this Host still serves.
 */
export function validateFormRef(input: FormRefLike): void {
  const [group, version, ...rest] = input.apiVersion.split("/");
  if (
    rest.length !== 0 ||
    !group ||
    !version ||
    !FORM_GROUP.test(group) ||
    !FORM_VERSION.test(version) ||
    input.apiVersion === "forms.takoform.com/v1alpha1" ||
    input.apiVersion === "forms.takoform.com/v1alpha2" ||
    !KIND.test(input.kind) ||
    !DEFINITION_VERSION.test(input.definitionVersion) ||
    !DIGEST.test(input.schemaDigest)
  ) {
    throw new TypeError("invalid Form identity");
  }
}

export function isFormGroup(value: string): boolean {
  return FORM_GROUP.test(value);
}

export function isFormVersion(value: string): boolean {
  return FORM_VERSION.test(value);
}

export function isKind(value: string): boolean {
  return KIND.test(value);
}

/** What a caller may rely on before attempting an operation on this Form. */
export function formSupportProfile(form: InstalledTakoformForm): JsonObject {
  return {
    apiVersion: "support.takoform.com/v1alpha1",
    kind: "FormSupport",
    formRef: structuredClone(form.identity.formRef) as unknown as JsonObject,
    operations: [...form.operations],
    ...(form.acceptedBindings && form.acceptedBindings.length > 0
      ? {
          supportedBindings: form.acceptedBindings.map(
            (binding) => `${binding.name}@${binding.version}`,
          ),
        }
      : {}),
    ...(form.artifactRequirement?.kind === "WorkerBundle"
      ? { limits: { maximumBundleBytes: TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES } }
      : {}),
  };
}

export function requireInstalledOperation(
  form: InstalledTakoformForm,
  operation: InstalledTakoformForm["operations"][number],
): void {
  if (!form.operations.includes(operation)) {
    throw new TakoformHostError("unsupported_capability", 422);
  }
}
