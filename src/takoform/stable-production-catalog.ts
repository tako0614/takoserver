import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../generated/takoform-stable-v1-catalog.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./types.ts";

export interface StableProductionTakoformCatalog {
  readonly provenance: {
    readonly repository: string;
    readonly commit: string;
    readonly familyIndexSha256: `sha256:${string}`;
    readonly familyCount: number;
    readonly formCount: number;
    readonly bindingCount: number;
  };
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings: readonly InstalledTakoformBinding[];
}

/** Exact source-pinned stable catalog installed by the official service. */
export function stableProductionTakoformCatalog(): StableProductionTakoformCatalog {
  const catalog = structuredClone(
    STABLE_PRODUCTION_TAKOFORM_CATALOG,
  ) as unknown as StableProductionTakoformCatalog;
  if (
    catalog.provenance.familyCount !== 8 ||
    catalog.provenance.formCount !== 31 ||
    catalog.provenance.bindingCount !== 6 ||
    catalog.forms.length !== catalog.provenance.formCount ||
    catalog.bindings.length !== catalog.provenance.bindingCount ||
    catalog.forms.some(
      (form) =>
        form.requiresHostApi !== "forms.takoform.com/v1" ||
        form.identity.formRef.kind === "ObjectBucket" ||
        (form.providedInterfaces ?? []).some((provided) => provided.name === "edge.objects"),
    )
  ) {
    throw new TypeError("stable production catalog integrity failure");
  }
  return catalog;
}
