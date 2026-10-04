import { TAKOFORM_FORWARD_CANDIDATE_CATALOG } from "../generated/takoform-forward-candidate-catalog.ts";
import { canonicalJson } from "../json.ts";
import { currentTakoformCandidates } from "./current-candidates.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./types.ts";

const SOURCE_COMMIT = "32dd4f177685e9da28d54369cfa196ba5ed67da6";

export interface ForwardTakoformCandidates {
  readonly provenance: {
    readonly classification: "unpublished-source-candidate";
    readonly repository: string;
    readonly repositoryCommit: string;
    readonly sourceCommit: string;
    readonly publicationStatus: "unpublished";
    readonly sourceTreeDigest: `sha256:${string}`;
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

export interface SelectedTakoformCandidates {
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings: readonly InstalledTakoformBinding[];
  readonly retainedForms: readonly InstalledTakoformForm[];
  readonly retainedBindings: readonly InstalledTakoformBinding[];
}

/** Exact source projection for the forward-only candidate lane; not publication evidence. */
export function forwardTakoformCandidates(): ForwardTakoformCandidates {
  const catalog = structuredClone(
    TAKOFORM_FORWARD_CANDIDATE_CATALOG,
  ) as unknown as ForwardTakoformCandidates;
  if (
    catalog.provenance.classification !== "unpublished-source-candidate" ||
    catalog.provenance.repository !== "https://github.com/tako0614/takoform-forms.git" ||
    catalog.provenance.repositoryCommit !== SOURCE_COMMIT ||
    catalog.provenance.sourceCommit !== SOURCE_COMMIT ||
    catalog.provenance.publicationStatus !== "unpublished" ||
    catalog.forms.length !== catalog.provenance.formCount ||
    catalog.bindings.length !== catalog.provenance.bindingCount
  ) {
    throw new TypeError("forward Takoform candidate corpus integrity failure");
  }
  return catalog;
}

/**
 * Selects the unchanged published closure by default. The forward lane adds
 * exact source candidates while keeping displaced published refs available
 * as a separate, non-selected retained closure.
 */
export function selectTakoformCandidates(
  selection: "published" | "actor-forward" = "published",
): SelectedTakoformCandidates {
  if (selection === "published") {
    const published = currentTakoformCandidates();
    return {
      forms: published.forms,
      bindings: published.bindings,
      retainedForms: [],
      retainedBindings: [],
    };
  }
  if (selection !== "actor-forward") {
    throw new TypeError("unsupported Takoform candidate selection");
  }

  const current = currentTakoformCandidates();
  const forward = forwardTakoformCandidates();
  const candidateForms = new Map(forward.forms.map((form) => [formKey(form), form]));
  for (const form of current.forms) {
    const candidate = candidateForms.get(formKey(form));
    if (candidate && candidate.identity.packageDigest !== form.identity.packageDigest) {
      throw new TypeError(
        `forward Takoform candidate changed package bytes without changing FormRef: ${form.identity.formRef.kind}`,
      );
    }
  }
  const selectedKinds = new Set(forward.forms.map((form) => form.identity.formRef.kind));
  const retainedForms = current.forms.filter(
    (form) => selectedKinds.has(form.identity.formRef.kind) && !candidateForms.has(formKey(form)),
  );
  const candidateBindings = new Map(
    forward.bindings.map((binding) => [bindingKey(binding), binding]),
  );
  for (const binding of current.bindings) {
    const candidate = candidateBindings.get(bindingKey(binding));
    if (candidate && canonicalJson(candidate) !== canonicalJson(binding)) {
      throw new TypeError(
        `forward Takoform candidate changed Binding data without changing BindingRef: ${binding.bindingRef.name}`,
      );
    }
  }
  const retainedFormBindingKeys = new Set(
    retainedForms.flatMap((form) =>
      (form.acceptedBindings ?? []).map((binding) => canonicalJson(binding)),
    ),
  );
  const retainedBindings = current.bindings.filter(
    (binding) =>
      retainedFormBindingKeys.has(canonicalJson(binding.bindingRef)) &&
      !candidateBindings.has(bindingKey(binding)),
  );
  return {
    forms: forward.forms,
    bindings: forward.bindings,
    retainedForms,
    retainedBindings,
  };
}

function formKey(form: InstalledTakoformForm): string {
  return canonicalJson(form.identity.formRef);
}

function bindingKey(binding: InstalledTakoformBinding): string {
  return canonicalJson(binding.bindingRef);
}
