import type { ProviderOffering } from "./provider-port.ts";
import {
  assertReleasedTakoformProviderForms,
  releasedTakoformProviderForms,
} from "./takoform/released-provider-catalog.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";

/**
 * The official Takoform Forms this Host can execute today.
 *
 * Takoserver never authors identities in `*.forms.takoform.com`. An entry may
 * appear here only when its exact FormRef and complete installed definition
 * are carried by a released Takoform provider. Backend placement, price and
 * commercial offering IDs remain Takoserver-owned facts outside that Form.
 */

export interface EdgeForm {
  readonly form: InstalledTakoformForm;
}

export interface EdgeFormBundle {
  readonly objectBucket: EdgeForm;
  readonly forms: readonly InstalledTakoformForm[];
}

export interface ObjectBucketProviderOfferingOptions {
  readonly id: string;
  readonly displayName: string;
  readonly regions?: readonly string[];
}

export async function buildEdgeForms(): Promise<EdgeFormBundle> {
  const releasedForms = releasedTakoformProviderForms();
  const objectBuckets = releasedForms.filter(
    (candidate) =>
      candidate.identity.formRef.apiVersion === "edge.forms.takoform.com/v1beta1" &&
      candidate.identity.formRef.kind === "ObjectBucket",
  );
  if (objectBuckets.length !== 1 || objectBuckets[0] === undefined) {
    throw new Error("released_takoform_object_bucket_missing");
  }
  const form: InstalledTakoformForm = objectBuckets[0];
  const objectBucket: EdgeForm = { form };
  const bundle = {
    objectBucket,
    forms: [form],
  };
  assertReleasedTakoformProviderForms(bundle.forms);
  return bundle;
}

/**
 * Projects the official ObjectBucket Form into one provider-owned technical
 * offering. Commercial placement and price are supplied later by the Catalog
 * Compiler; this helper never marks anything available for sale.
 */
export function objectBucketProviderOffering(
  form: InstalledTakoformForm,
  options: ObjectBucketProviderOfferingOptions,
): ProviderOffering {
  if (
    form.identity.formRef.apiVersion !== "edge.forms.takoform.com/v1beta1" ||
    form.identity.formRef.kind !== "ObjectBucket"
  ) {
    throw new TypeError("official_takoform_object_bucket_required");
  }
  return {
    id: options.id,
    kind: "object_bucket",
    displayName: options.displayName,
    form: form.identity.formRef,
    providedInterfaces: form.providedInterfaces ?? [],
    bindingRefs: form.acceptedBindings ?? [],
    ...(options.regions ? { regions: [...options.regions] } : {}),
    capabilities: ["create", "delete", "import", "observe"],
  };
}
