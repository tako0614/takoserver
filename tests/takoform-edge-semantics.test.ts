import { expect, test } from "bun:test";
import { canonicalizeEdgeSpec, validateEdgeSemantics } from "../src/takoform/edge-semantics.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";

const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "edge.forms.takoform.com/v1alpha1",
      kind: "WorkerCronTrigger",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"1".repeat(64)}`,
    },
  },
  desiredSchema: {},
  operations: ["create", "read", "delete"],
};

test("portable cron semantics reject impossible schedules and accept sub-hourly schedules", () => {
  for (const cron of ["0 24 * * *", "5-1 * * * *", "*/0 * * * *", "0 0 32 * *"]) {
    expect(validateEdgeSemantics(form, { cron })).toHaveLength(1);
  }
  for (const cron of ["*/5 * * * *", "0 * * * *"]) {
    expect(validateEdgeSemantics(form, { cron })).toEqual([]);
  }
});

test("custom domain hostnames have one spelling before hashing and storage", () => {
  expect(
    canonicalizeEdgeSpec(
      {
        ...form,
        identity: { formRef: { ...form.identity.formRef, kind: "WorkerCustomDomain" } },
      },
      { hostname: "Claim.Portable-Conformance.INVALID." },
    ),
  ).toEqual({ hostname: "claim.portable-conformance.invalid" });
});
