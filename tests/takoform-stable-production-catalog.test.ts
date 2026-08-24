import { expect, test } from "bun:test";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";

test("production installs the exact source-pinned stable Takoform catalog", () => {
  const catalog = stableProductionTakoformCatalog();

  expect(catalog.provenance).toEqual({
    repository: "https://github.com/tako0614/terraform-provider-takoform.git",
    commit: "7e71515d0dd2899f9884e031ce63008b8597e8da",
    familyIndexSha256: "sha256:337a138c8d2561ade5b5ff44570c0d6a5543922f98d265c961874b06ef7ba703",
    familyCount: 8,
    formCount: 31,
    bindingCount: 6,
  });
  expect(catalog.forms).toHaveLength(31);
  expect(catalog.bindings).toHaveLength(6);
  expect(
    [...new Set(catalog.forms.map((form) => form.identity.formRef.apiVersion))].sort(),
  ).toEqual([
    "container.forms.takoform.com",
    "edge.forms.takoform.com",
    "function.forms.takoform.com",
    "queue.forms.takoform.com",
    "schedule.forms.takoform.com",
    "table.forms.takoform.com",
    "topic.forms.takoform.com",
    "vector.forms.takoform.com",
  ]);
  expect(catalog.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(false);
  expect(
    catalog.forms.some((form) =>
      (form.providedInterfaces ?? []).some((provided) => provided.name === "edge.objects"),
    ),
  ).toBe(false);
  expect(catalog.forms.every((form) => form.requiresHostApi === "forms.takoform.com/v1")).toBe(
    true,
  );
});
