import { currentTakoformCandidates } from "./current-candidates.ts";
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
  return currentTakoformCandidates();
}
