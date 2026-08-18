import type { Offering } from "./catalog.ts";
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
  readonly providerOffering: ProviderOffering;
  readonly offering: Offering;
  readonly forms: readonly InstalledTakoformForm[];
  readonly providerOfferings: readonly ProviderOffering[];
  readonly offerings: readonly Offering[];
}

export interface EdgeFormBundle {
  readonly objectBucket: EdgeForm;
  readonly forms: readonly InstalledTakoformForm[];
  readonly providerOfferings: readonly ProviderOffering[];
  readonly offerings: readonly Offering[];
}

export interface EdgeFormPrices {
  readonly objectBucketMinor?: number;
}

export async function buildEdgeForms(prices: EdgeFormPrices = {}): Promise<EdgeFormBundle> {
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
  const formRef = form.identity.formRef;
  const providerOffering: ProviderOffering = {
    id: "storage.object.standard",
    kind: "object_bucket",
    displayName: "Object bucket",
    form: formRef,
    providedInterfaces: form.providedInterfaces ?? [],
    bindingRefs: form.acceptedBindings ?? [],
    capabilities: ["create", "delete", "import", "observe"],
  };
  const offering: Offering = {
    id: providerOffering.id,
    providerPackRef: "cloudflare",
    providerInstallationRef: "cloudflare.primary",
    supplyContractRef: "cloudflare.operator-contract",
    pricePlanRef: "storage.object.standard.price-v1",
    resourceClass: "storage.object",
    deliveryMode: "embedded-binding",
    supportPolicyRef: "support:operator:standard",
    abusePolicyRef: "abuse:operator:standard",
    kind: providerOffering.kind,
    displayName: providerOffering.displayName,
    form: formRef,
    pricePlan: {
      id: "storage.object.standard.price-v1",
      currency: "USD",
      recurring: { meter: "bucket-month", amountMinor: prices.objectBucketMinor ?? 500 },
      meters: [],
    },
    providedInterfaces: providerOffering.providedInterfaces,
    bindingRefs: providerOffering.bindingRefs,
    regions: ["global"],
    portability: {
      api: "portable",
      exportFormats: ["s3.object-set.takoform.com/v1"],
      importFormats: ["s3.object-set.takoform.com/v1"],
      migrationModes: ["offline", "online"],
    },
    isolation: "dedicated-resource",
    available: true,
  };
  const objectBucket: EdgeForm = {
    form,
    providerOffering,
    offering,
    forms: [form],
    providerOfferings: [providerOffering],
    offerings: [offering],
  };

  const bundle = {
    objectBucket,
    forms: objectBucket.forms,
    providerOfferings: objectBucket.providerOfferings,
    offerings: objectBucket.offerings,
  };
  assertReleasedTakoformProviderForms(bundle.forms);
  return bundle;
}
