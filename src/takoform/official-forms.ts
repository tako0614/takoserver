import {
  type ReleasedInstalledTakoformForm,
  releasedTakoformProviderForms,
  TAKOFORM_PROVIDER_RELEASE,
} from "./released-provider-catalog.ts";
import type { InstalledTakoformForm, TakoformInterfaceRef } from "./types.ts";

/** Exact public identities carried by registry.terraform.io/tako0614/takoform v2.1.1. */
const RELEASED_OBJECT_BUCKET = releasedObjectBucket();

export const TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM = Object.freeze({
  ...RELEASED_OBJECT_BUCKET.identity.formRef,
  packageDigest: RELEASED_OBJECT_BUCKET.identity.packageDigest,
});

export const TAKOFORM_EDGE_OBJECTS_INTERFACE = Object.freeze(
  releasedObjectBucketInterface(RELEASED_OBJECT_BUCKET),
) satisfies TakoformInterfaceRef;

/**
 * The complete installed Form declaration needed by the first released
 * Takoserver/Takoform provider seam. Backend placement and price stay outside
 * this portable definition.
 */
export const TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM = Object.freeze(
  structuredClone(RELEASED_OBJECT_BUCKET),
) satisfies InstalledTakoformForm;

function releasedObjectBucket(): ReleasedInstalledTakoformForm {
  const forms = releasedTakoformProviderForms();
  const matches = forms.filter(
    (form) =>
      form.identity.formRef.kind === "ObjectBucket" &&
      form.identity.formRef.apiVersion === "edge.forms.takoform.com/v1beta1",
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`released_takoform_object_bucket_missing:${TAKOFORM_PROVIDER_RELEASE.version}`);
  }
  return matches[0];
}

function releasedObjectBucketInterface(form: ReleasedInstalledTakoformForm): TakoformInterfaceRef {
  const interfaceRef = form.providedInterfaces?.[0];
  if (!interfaceRef) {
    throw new Error(
      `released_takoform_object_bucket_interface_missing:${TAKOFORM_PROVIDER_RELEASE.version}`,
    );
  }
  return structuredClone(interfaceRef);
}
