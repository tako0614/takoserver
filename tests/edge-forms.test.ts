import { describe, expect, test } from "bun:test";
import { buildEdgeForms, objectBucketProviderOffering } from "../src/edge-forms.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM } from "../src/takoform/released-provider-object-bucket.ts";

describe("retained Takoform Provider catalog", () => {
  test("exposes only exact Forms carried by the released Takoform provider", async () => {
    const edge = await buildEdgeForms();

    expect(edge.forms).toHaveLength(15);
    expect(edge.bindings).toHaveLength(5);
    expect(edge.objectBucket.form.identity).toEqual({
      formRef: {
        apiVersion: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.apiVersion,
        kind: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.kind,
        definitionVersion: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.definitionVersion,
        schemaDigest: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.schemaDigest,
      },
      packageDigest: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM.packageDigest,
    });
    expect(edge.objectBucket.form.desiredSchema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      description:
        "Flat-namespace object store with strong read-after-write consistency, streaming bodies, ranged and conditional reads, and multipart upload, exactly as fixed by the edge.objects Interface. An object body is a byte stream, never a JSON string: the contract's 5 GiB ceiling is only meaningful because bodies never travel inside an operation document (decision 0020). Operating rules such as CORS, lifecycle, and lock are separate policy resources, never desired fields of the bucket identity.",
      properties: {},
      title: "Object Bucket desired state",
      type: "object",
    });
  });

  test("does not mint Takoserver definitions in the publisher namespace", async () => {
    const edge = await buildEdgeForms();

    expect(edge.forms.some((form) => form.identity.formRef.kind === "WorkerScript")).toBe(false);
    expect(edge.forms.some((form) => form.identity.formRef.kind === "SqlDatabase")).toBe(false);
    expect(edge.forms.some((form) => form.identity.formRef.definitionVersion !== "0.1.0")).toBe(
      false,
    );
  });

  test("keeps price, supply authority, and availability outside the portable Form", async () => {
    const edge = await buildEdgeForms();
    const currentObjectBucket = currentTakoformCandidates().forms.find(
      (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
    );
    if (!currentObjectBucket) throw new Error("current ObjectBucket fixture missing");
    const technical = objectBucketProviderOffering(currentObjectBucket, {
      id: "storage.object.standard",
      displayName: "Object bucket",
      regions: ["global"],
    });

    for (const value of [...edge.forms, ...edge.bindings, technical]) {
      expect(value).not.toHaveProperty("pricePlan");
      expect(value).not.toHaveProperty("supplyContract");
      expect(value).not.toHaveProperty("available");
    }
  });
});
