import type { ExactFormRef } from "./contracts.ts";
import type { InstalledTakoformForm, TakoformInterfaceRef } from "./takoform/types.ts";

/** Exact public identities carried by registry.terraform.io/tako0614/takoform v2.1.1. */
export const TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM = Object.freeze({
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
  packageDigest: "sha256:553675391d888c6fd4e336cb9f05bf6a988a14f743327f6ff968914326ea8a21",
}) satisfies ExactFormRef;

export const TAKOFORM_EDGE_OBJECTS_INTERFACE = Object.freeze({
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "edge.objects",
  version: "1.0.0",
  schemaDigest: "sha256:fad47fa63409a05fb0b5886d23300e7ecd32fd64b11aaef5a200247872d19e00",
}) satisfies TakoformInterfaceRef;

/**
 * The complete installed Form declaration needed by the first released
 * Takoserver/Takoform provider seam. Backend placement and price stay outside
 * this portable definition.
 */
export const TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM = {
  identity: {
    formRef: {
      apiVersion: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.apiVersion,
      kind: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.kind,
      definitionVersion: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.definitionVersion,
      schemaDigest: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.schemaDigest,
    },
    packageDigest: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.packageDigest,
  },
  displayName: "Object Bucket",
  description: "Portable strongly consistent object storage identity.",
  role: "identity",
  providedInterfaces: [TAKOFORM_EDGE_OBJECTS_INTERFACE],
  desiredSchema: { type: "object", properties: {}, additionalProperties: false },
  operations: ["create", "read", "delete", "import", "observe"],
} as const satisfies InstalledTakoformForm;
