import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
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

describe("current stable Takoform catalog", () => {
  test("does not relabel immutable v1beta1 provider Forms as stable", async () => {
    const historical = await buildEdgeForms();
    const current = currentTakoformCatalog(historical);

    expect(current.forms).toEqual([]);
    expect(current.bindings).toEqual([]);
    expect(historical.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(
      true,
    );
  });

  test("admits only literal stable-v1 Forms and their exact accepted bindings", async () => {
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

  test("admits the owning current ObjectBucket and its exact edge.objects Binding", () => {
    const source = currentTakoformCandidates();
    const current = currentTakoformCatalog(source);
    const bucket = current.forms.find((form) => form.identity.formRef.kind === "ObjectBucket");
    const binding = current.bindings.find(
      (candidate) => candidate.bindingRef.name === "module-worker.object-bucket",
    );

    expect(bucket?.identity).toEqual({
      formRef: {
        apiVersion: "edge.forms.takoform.com",
        kind: "ObjectBucket",
        definitionVersion: "0.1.0",
        schemaDigest: "sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557",
      },
      packageDigest: "sha256:46cd435d838d89de641d38180680e99c8bc7be1a3ae9c123494440d3e6e202ec",
    });
    expect(binding?.bindingRef).toEqual({
      apiVersion: "bindings.takoform.com/v1alpha2",
      name: "module-worker.object-bucket",
      version: "1.1.0",
      schemaDigest: "sha256:ff8661459b73a8d229e0915c698afad2aa297b5db90fe5e1693d346a7ae3adfb",
    });

    const workerVersion = current.forms.find(
      (form) => form.identity.formRef.kind === "WorkerVersion",
    );
    const publicState = JSON.stringify(
      [bucket, workerVersion].map((form) => ({
        desiredSchema: form?.desiredSchema,
        observedSchema: form?.observedSchema,
        outputSchema: form?.outputSchema,
      })),
    );
    expect(publicState).not.toMatch(
      /"(?:endpoint|region|bucket|bucketName|accessKey|accessKeyId|secretAccessKey|sessionToken|providerSupply)"\s*:/u,
    );
    expect(bucket?.observedSchema).toBeUndefined();
    expect(bucket?.outputSchema).toBeUndefined();
  });
});
