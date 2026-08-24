import type {
  InstalledTakoformBinding,
  TakoformBindingRef,
  TakoformInterfaceRef,
} from "./types.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CONTRACT_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const FORM_GROUP =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?)?$/u;
const RESERVED_FORM_GROUPS = new Set([
  "forms.takoform.com",
  "packages.forms.takoform.com",
  "trust.forms.takoform.com",
]);
const KIND = /^[A-Z][A-Za-z0-9]{0,63}$/u;

export type BindingRegistry = ReadonlyMap<string, InstalledTakoformBinding>;

/** Builds an exact, ambiguity-free registry of portable BindingDefinitions. */
export function installedBindings(input: readonly InstalledTakoformBinding[]): BindingRegistry {
  const result = new Map<string, InstalledTakoformBinding>();
  const versions = new Map<string, string>();
  for (const binding of input) {
    validateBindingRef(binding.bindingRef);
    validateInterfaceRef(binding.targetInterface);
    if (binding.allowedTargetForms.length === 0) {
      throw new TypeError("binding must allow at least one target Form");
    }
    for (const target of binding.allowedTargetForms) {
      const group = target.apiVersion.split("/", 1)[0];
      if (
        target.apiVersion.length > 320 ||
        !FORM_GROUP.test(target.apiVersion) ||
        group === undefined ||
        RESERVED_FORM_GROUPS.has(group) ||
        !KIND.test(target.kind)
      ) {
        throw new TypeError("invalid binding target Form kind");
      }
    }
    const versionKey = `${binding.bindingRef.name}\0${binding.bindingRef.version}`;
    const digest = versions.get(versionKey);
    if (digest !== undefined && digest !== binding.bindingRef.schemaDigest) {
      throw new TypeError("ambiguous installed Binding definition");
    }
    versions.set(versionKey, binding.bindingRef.schemaDigest);
    const key = bindingKey(binding.bindingRef);
    if (result.has(key)) throw new TypeError("duplicate installed Binding identity");
    result.set(key, structuredClone(binding));
  }
  return result;
}

export function bindingKey(ref: TakoformBindingRef): string {
  return `${ref.name}\0${ref.version}\0${ref.schemaDigest}`;
}

export function sameInterface(left: TakoformInterfaceRef, right: TakoformInterfaceRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}

function validateBindingRef(ref: TakoformBindingRef): void {
  if (
    (ref.apiVersion !== "bindings.takoform.com/v1alpha1" &&
      ref.apiVersion !== "bindings.takoform.com/v1alpha2") ||
    !CONTRACT_NAME.test(ref.name) ||
    !VERSION.test(ref.version) ||
    !DIGEST.test(ref.schemaDigest)
  ) {
    throw new TypeError("invalid Binding reference");
  }
}

function validateInterfaceRef(ref: TakoformInterfaceRef): void {
  if (
    ref.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
    !CONTRACT_NAME.test(ref.name) ||
    !VERSION.test(ref.version) ||
    !DIGEST.test(ref.schemaDigest)
  ) {
    throw new TypeError("invalid Interface reference");
  }
}
