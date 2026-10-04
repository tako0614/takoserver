import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import {
  forwardTakoformCandidates,
  selectTakoformCandidates,
} from "../src/takoform/forward-candidates.ts";

describe("forward Takoform source candidate projection", () => {
  test("is deterministic, source-classified, and contains nine changed FormRefs", () => {
    const first = forwardTakoformCandidates();
    const second = forwardTakoformCandidates();
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.provenance.classification).toBe("unpublished-source-candidate");
    expect(first.provenance.publicationStatus).toBe("unpublished");
    expect(first.provenance.repositoryCommit).toBe("0d8e5b7aaf9e07652eb6c895709efed8ad03e721");
    expect(first.provenance.repositoryCommit).toBe(first.provenance.sourceCommit);
    expect(first.forms).toHaveLength(17);

    const published = currentTakoformCandidates();
    const oldByKind = new Map(
      published.forms.map((form) => [form.identity.formRef.kind, form.identity.formRef]),
    );
    const changed = first.forms.filter((form) => {
      const old = oldByKind.get(form.identity.formRef.kind);
      return old !== undefined && canonicalJson(old) !== canonicalJson(form.identity.formRef);
    });
    expect(changed).toHaveLength(9);
  });

  test("keeps the published closure unchanged and exposes displaced refs separately", () => {
    const publishedBefore = currentTakoformCandidates();
    const defaultSelection = selectTakoformCandidates();
    expect(defaultSelection.forms).toEqual(publishedBefore.forms);
    expect(defaultSelection.bindings).toEqual(publishedBefore.bindings);
    expect(defaultSelection.retainedForms).toEqual([]);
    expect(defaultSelection.retainedBindings).toEqual([]);

    const selected = selectTakoformCandidates("actor-forward");
    const oldRefs = publishedBefore.forms.map((form) => form.identity.formRef);
    const representedOldRefs = [...selected.forms, ...selected.retainedForms]
      .map((form) => canonicalJson(form.identity.formRef))
      .filter((ref) => oldRefs.some((old) => canonicalJson(old) === ref))
      .sort();
    expect(representedOldRefs).toEqual(oldRefs.map(canonicalJson).sort());
    expect(selected.retainedForms).toHaveLength(9);
    for (const oldForm of publishedBefore.forms) {
      const sameRef = selected.forms.find(
        (form) => canonicalJson(form.identity.formRef) === canonicalJson(oldForm.identity.formRef),
      );
      if (sameRef) {
        expect(sameRef.identity.packageDigest).toBe(oldForm.identity.packageDigest);
      } else {
        expect(selected.retainedForms).toContainEqual(oldForm);
      }
    }
    expect(currentTakoformCandidates()).toEqual(publishedBefore);
  });

  test("returns caller-owned clones", () => {
    const first = forwardTakoformCandidates();
    const originalDescription = first.forms[0]?.description;
    if (first.forms[0]) Object.assign(first.forms[0], { description: "caller mutation" });
    expect(forwardTakoformCandidates().forms[0]?.description).toBe(originalDescription);

    const selected = selectTakoformCandidates("actor-forward");
    if (selected.forms[0]) {
      Object.assign(selected.forms[0].identity.formRef, { kind: "caller mutation" });
    }
    expect(selectTakoformCandidates("actor-forward").forms[0]?.identity.formRef.kind).not.toBe(
      "caller mutation",
    );
  });

  test("projects the exact Actor runtime class ref from its source Interface", () => {
    const actor = forwardTakoformCandidates().forms.find(
      (form) => form.identity.formRef.kind === "ActorNamespace",
    );
    const runtimeClassRef = actor?.workerClassRuntime?.runtimeClassRef;
    expect(runtimeClassRef).toBeDefined();
    expect(runtimeClassRef).toEqual(
      actor?.providedInterfaces?.find((ref) => ref.name === "worker.actor"),
    );
    expect(runtimeClassRef?.version).toBe("2.0.0");
    expect(runtimeClassRef?.schemaDigest).toBe(
      actor?.providedInterfaces?.find((ref) => ref.name === "worker.actor")?.schemaDigest,
    );
  });

  test("rejects an unrecognized runtime selection", () => {
    expect(() => selectTakoformCandidates("unknown" as "published")).toThrow(
      "unsupported Takoform candidate selection",
    );
  });
});
