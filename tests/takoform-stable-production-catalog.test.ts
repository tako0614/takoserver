import { expect, test } from "bun:test";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";

test("production installs the exact source-pinned stable Takoform catalog", () => {
  const catalog = stableProductionTakoformCatalog();

  expect(catalog.provenance).toEqual({
    classification: "public-unsigned-package-corpus",
    repository: "https://github.com/tako0614/takoform-forms.git",
    commit: "026f862975b9adb0e2bfd9c6214a5e6691dfb596",
    gitTags: "unsigned",
    sigstoreBundle: null,
    familyIndexSha256: "sha256:c3c59a01fb90ab967c3765ff1dd15ca4af4062cba9b38c0a3b97a168822ffb32",
    familyConformanceSha256:
      "sha256:9c7288fe103584922fb481dc6af2f1d70e0fb7b48aa3389bf817bf5626f1c873",
    interfaceCandidateSetSha256:
      "sha256:9d15d44047369cf7866c4570293e4f40f346873eb646d82f676a3b411156ba2b",
    bindingCandidateSetSha256:
      "sha256:e3b4aa31d5f9f7b7f31ff70f5f805a9354abf3ccd5555cc457e2e7c395224143",
    familyCount: 1,
    formCount: 16,
    interfaceCount: 7,
    bindingCount: 6,
  });
  expect(catalog.forms).toHaveLength(16);
  expect(catalog.bindings).toHaveLength(6);
  expect(
    [...new Set(catalog.forms.map((form) => form.identity.formRef.apiVersion))].sort(),
  ).toEqual(["edge.forms.takoform.com"]);
  expect(catalog.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(false);
  expect(
    catalog.forms.some((form) =>
      (form.providedInterfaces ?? []).some((provided) => provided.name === "edge.objects"),
    ),
  ).toBe(false);
  expect(
    catalog.forms.some((form) => form.identity.formRef.apiVersion !== "edge.forms.takoform.com"),
  ).toBe(false);
  expect(catalog.forms.every((form) => form.requiresHostApi === "forms.takoform.com/v1")).toBe(
    true,
  );
});
