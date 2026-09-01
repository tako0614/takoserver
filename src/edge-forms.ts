import type { ProviderOffering } from "./provider-port.ts";
import { currentTakoformCandidates } from "./takoform/current-candidates.ts";
import {
  assertReleasedTakoformProviderBindings,
  assertReleasedTakoformProviderForms,
  releasedTakoformProviderBindings,
  releasedTakoformProviderForms,
} from "./takoform/released-provider-catalog.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./takoform/types.ts";

/**
 * Immutable v2.1.1 provider Forms retained for readback and recovery only.
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
  readonly bindings: readonly InstalledTakoformBinding[];
}

export interface ObjectBucketProviderOfferingOptions {
  readonly id: string;
  readonly displayName: string;
  readonly regions?: readonly string[];
}

export interface EdgeProviderOfferingOptions {
  readonly id: string;
  readonly displayName?: string;
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
  const bindings = releasedTakoformProviderBindings();
  const bundle = {
    objectBucket,
    forms: releasedForms,
    bindings,
  };
  assertReleasedTakoformProviderForms(bundle.forms);
  assertReleasedTakoformProviderBindings(bundle.bindings);
  return bundle;
}

/**
 * Projects the exact current ObjectBucket Form into one provider-owned technical
 * offering. Commercial placement and price are supplied later by the Catalog
 * Compiler; this helper never marks anything available for sale.
 */
export function objectBucketProviderOffering(
  form: InstalledTakoformForm,
  options: ObjectBucketProviderOfferingOptions,
): ProviderOffering {
  const canonical = canonicalObjectBucket(form);
  if (!canonical) {
    throw new TypeError("released_provider_object_bucket_required");
  }
  return {
    id: options.id,
    kind: "object_bucket",
    displayName: options.displayName,
    form: structuredClone(canonical.identity.formRef),
    providedInterfaces: structuredClone(canonical.providedInterfaces ?? []),
    bindingRefs: structuredClone(canonical.acceptedBindings ?? []),
    ...(options.regions ? { regions: [...options.regions] } : {}),
    capabilities: canonical.operations.filter(
      (operation): operation is ProviderOffering["capabilities"][number] =>
        operation === "create" ||
        operation === "update" ||
        operation === "delete" ||
        operation === "import" ||
        operation === "observe",
    ),
  };
}

function canonicalObjectBucket(form: InstalledTakoformForm): InstalledTakoformForm | null {
  if (form.identity.formRef.kind !== "ObjectBucket") return null;
  const candidates = currentTakoformCandidates().forms.filter(
    (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
  );
  return (
    candidates.find(
      (candidate) =>
        candidate.identity.formRef.apiVersion === form.identity.formRef.apiVersion &&
        candidate.identity.formRef.definitionVersion === form.identity.formRef.definitionVersion &&
        candidate.identity.formRef.schemaDigest === form.identity.formRef.schemaDigest &&
        candidate.identity.packageDigest === form.identity.packageDigest,
    ) ?? null
  );
}

/**
 * Projects one released edge Form into a provider's technical capability.
 *
 * This is not a commercial Offering. Identity Forms may later be joined to a
 * price and supply contract; revision/deployment/attachment Forms inherit the
 * provider installation of their pinned identity relation.
 */
export function edgeProviderOffering(
  form: InstalledTakoformForm,
  options: EdgeProviderOfferingOptions,
): ProviderOffering {
  if (
    form.identity.formRef.apiVersion !== "edge.forms.takoform.com" &&
    form.identity.formRef.apiVersion !== "edge.forms.takoform.com/v1beta1"
  ) {
    throw new TypeError("released_provider_edge_form_required");
  }
  return {
    id: options.id,
    kind: `takoform.${form.identity.formRef.kind}`,
    displayName: options.displayName ?? form.displayName ?? form.identity.formRef.kind,
    form: structuredClone(form.identity.formRef),
    providedInterfaces: structuredClone(form.providedInterfaces ?? []),
    bindingRefs: structuredClone(form.acceptedBindings ?? []),
    ...(options.regions ? { regions: [...options.regions] } : {}),
    capabilities: form.operations.filter(
      (operation): operation is ProviderOffering["capabilities"][number] =>
        operation === "create" ||
        operation === "update" ||
        operation === "delete" ||
        operation === "import" ||
        operation === "observe",
    ),
  };
}
