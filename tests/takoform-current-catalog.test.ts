import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { currentTakoformCatalog } from "../src/takoform/current-catalog.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";

const stableForm = (overrides: Partial<InstalledTakoformForm> = {}): InstalledTakoformForm => ({
  identity: {
    formRef: {
      apiVersion: "example.forms.example.com",
      kind: "Example",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"1".repeat(64)}`,
    },
  },
  requiresHostApi: "forms.takoform.com/v1",
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "read", "delete"],
  ...overrides,
});

describe("current staging adoption-candidate Takoform catalog", () => {
  test("does not relabel immutable v1beta1 provider Forms as a current candidate", async () => {
    const historical = await buildEdgeForms();
    const current = currentTakoformCatalog(historical);

    expect(current.forms).toEqual([]);
    expect(current.bindings).toEqual([]);
    expect(historical.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(
      true,
    );
  });

  test("admits only literal Host API v1 candidate Forms and their exact accepted bindings", async () => {
    const historical = await buildEdgeForms();
    const accepted = historical.bindings[0];
    if (!accepted) throw new Error("historical binding fixture missing");
    const form = stableForm({ acceptedBindings: [accepted.bindingRef] });
    const current = currentTakoformCatalog({
      forms: [form, ...historical.forms],
      bindings: historical.bindings,
    });

    expect(current.forms).toEqual([form]);
    expect(current.bindings).toEqual([accepted]);
  });

  test("fails closed on ObjectBucket or edge.objects in the adoption-candidate catalog", () => {
    expect(() =>
      currentTakoformCatalog({
        forms: [
          stableForm({
            identity: {
              formRef: {
                apiVersion: "edge.forms.takoform.com",
                kind: "ObjectBucket",
                definitionVersion: "1.0.0",
                schemaDigest: `sha256:${"2".repeat(64)}`,
              },
            },
          }),
        ],
        bindings: [],
      }),
    ).toThrow("current_takoform_object_bucket_forbidden");

    expect(() =>
      currentTakoformCatalog({
        forms: [
          stableForm({
            providedInterfaces: [
              {
                apiVersion: "interfaces.takoform.com/v1alpha1",
                name: "edge.objects",
                version: "1.0.0",
                schemaDigest: `sha256:${"3".repeat(64)}`,
              },
            ],
          }),
        ],
        bindings: [],
      }),
    ).toThrow("current_takoform_edge_objects_forbidden");
  });
});
