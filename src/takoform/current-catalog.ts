import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformBindingRef,
} from "./types.ts";

export interface TakoformCatalogInput {
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings: readonly InstalledTakoformBinding[];
}

/**
 * Selects only definitions that explicitly require the literal stable Host.
 *
 * Released v1beta1 provider bytes remain useful to the product/provider plane,
 * but absence of a released stable Form package is not permission to relabel
 * those identities. The current Host therefore starts empty and fail-closed
 * until an owning Takoform release supplies exact stable-v1 definitions.
 */
export function currentTakoformCatalog(input: TakoformCatalogInput): TakoformCatalogInput {
  const forms = input.forms.filter((form) => form.requiresHostApi === "forms.takoform.com/v1");
  for (const form of forms) {
    if (form.identity.formRef.kind === "ObjectBucket") {
      throw new TypeError("current_takoform_object_bucket_forbidden");
    }
    if ((form.providedInterfaces ?? []).some((provided) => provided.name === "edge.objects")) {
      throw new TypeError("current_takoform_edge_objects_forbidden");
    }
  }

  const accepted = new Set(forms.flatMap((form) => form.acceptedBindings ?? []).map(bindingRefKey));
  const bindings = input.bindings.filter((binding) =>
    accepted.has(bindingRefKey(binding.bindingRef)),
  );
  if (bindings.some((binding) => binding.targetInterface.name === "edge.objects")) {
    throw new TypeError("current_takoform_edge_objects_forbidden");
  }
  if (
    new Set(bindings.map((binding) => bindingRefKey(binding.bindingRef))).size !== accepted.size
  ) {
    throw new TypeError("current_takoform_binding_missing");
  }
  return { forms, bindings };
}

function bindingRefKey(ref: TakoformBindingRef): string {
  return `${ref.apiVersion}\0${ref.name}\0${ref.version}\0${ref.schemaDigest}`;
}
