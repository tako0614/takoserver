import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../generated/takoform-stable-v1-catalog.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./types.ts";

export interface StableProductionTakoformCatalog {
  readonly provenance: {
    readonly classification: "public-unsigned-package-corpus";
    readonly repository: string;
    readonly commit: string;
    readonly gitTags: "unsigned";
    readonly sigstoreBundle: null;
    readonly familyIndexSha256: `sha256:${string}`;
    readonly familyConformanceSha256: `sha256:${string}`;
    readonly interfaceCandidateSetSha256: `sha256:${string}`;
    readonly bindingCandidateSetSha256: `sha256:${string}`;
    readonly familyCount: number;
    readonly formCount: number;
    readonly interfaceCount: number;
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
    catalog.provenance.classification !== "public-unsigned-package-corpus" ||
    catalog.provenance.repository !== "https://github.com/tako0614/takoform-forms.git" ||
    catalog.provenance.commit !== "026f862975b9adb0e2bfd9c6214a5e6691dfb596" ||
    catalog.provenance.gitTags !== "unsigned" ||
    catalog.provenance.sigstoreBundle !== null ||
    catalog.provenance.familyIndexSha256 !==
      "sha256:c3c59a01fb90ab967c3765ff1dd15ca4af4062cba9b38c0a3b97a168822ffb32" ||
    catalog.provenance.familyConformanceSha256 !==
      "sha256:9c7288fe103584922fb481dc6af2f1d70e0fb7b48aa3389bf817bf5626f1c873" ||
    catalog.provenance.interfaceCandidateSetSha256 !==
      "sha256:9d15d44047369cf7866c4570293e4f40f346873eb646d82f676a3b411156ba2b" ||
    catalog.provenance.bindingCandidateSetSha256 !==
      "sha256:e3b4aa31d5f9f7b7f31ff70f5f805a9354abf3ccd5555cc457e2e7c395224143" ||
    catalog.provenance.familyCount !== 1 ||
    catalog.provenance.formCount !== 16 ||
    catalog.provenance.interfaceCount !== 7 ||
    catalog.provenance.bindingCount !== 6 ||
    catalog.forms.length !== catalog.provenance.formCount ||
    catalog.bindings.length !== catalog.provenance.bindingCount ||
    catalog.forms.some(
      (form) =>
        form.identity.formRef.apiVersion !== "edge.forms.takoform.com" ||
        form.requiresHostApi !== "forms.takoform.com/v1" ||
        form.identity.formRef.kind === "ObjectBucket" ||
        (form.providedInterfaces ?? []).some((provided) => provided.name === "edge.objects"),
    )
  ) {
    throw new TypeError("stable production catalog integrity failure");
  }
  return catalog;
}
