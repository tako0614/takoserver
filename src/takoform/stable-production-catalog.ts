import { currentTakoformCandidates } from "./current-candidates.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./types.ts";

export interface StableProductionTakoformCatalog {
  readonly provenance: {
    readonly classification: "public-publisher-set-projection";
    readonly repository: string;
    readonly repositoryCommit: string;
    readonly setId: string;
    readonly setTag: string;
    readonly sourceCommit: string;
    readonly coreVersion: "v1.1.0";
    readonly verificationReceiptDigest: `sha256:${string}`;
    readonly publicationStatus: "published";
    readonly candidateTreeDigest: `sha256:${string}`;
    readonly familyIndexSha256: `sha256:${string}`;
    readonly familyCandidateSetSha256: `sha256:${string}`;
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

/** Exact source-pinned catalog available to this Takoserver build. */
export function stableProductionTakoformCatalog(): StableProductionTakoformCatalog {
  return currentTakoformCandidates();
}
