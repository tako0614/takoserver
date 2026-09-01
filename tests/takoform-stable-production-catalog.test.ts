import { expect, test } from "bun:test";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";

test("production installs the exact source-pinned stable Takoform catalog", () => {
  const catalog = stableProductionTakoformCatalog();

  expect(catalog.provenance).toEqual({
    classification: "public-publisher-set-projection",
    repository: "https://github.com/tako0614/takoform-forms.git",
    repositoryCommit: "3231633605b737ce5279d7fc020b4780568e7091",
    setId: "e7f8a39311dd011b8467e97e7f300cabb9a6b06c",
    setTag: "forms/sets/e7f8a39311dd011b8467e97e7f300cabb9a6b06c",
    sourceCommit: "e7f8a39311dd011b8467e97e7f300cabb9a6b06c",
    coreVersion: "v1.1.0",
    verificationReceiptDigest:
      "sha256:41c5d640813cf8f4aaaaa0e2c6ea7323100c2f7054fe4f02a2127837551d3055",
    publicationStatus: "published",
    candidateTreeDigest: "sha256:1b471fd96099c1bcdceb63f6f577946c9d6090dc2aee2a02447ced79cb5449e1",
    familyIndexSha256: "sha256:9eecc0732fbb8595bd1c84827f256ed7f68258f5d4658799fb3ae049607976ea",
    familyCandidateSetSha256:
      "sha256:02dcede7086df8fdf1513c3f47bb4ee011eed8f0812d601d38d942b2d6da5ccf",
    interfaceCandidateSetSha256:
      "sha256:2a66a036d0393c4acd37541bdd3ebaa879b897c5bdbe325f02ee2aa69ae4a402",
    bindingCandidateSetSha256:
      "sha256:ed725f798c2079c074a5a19e22d3494d920e5b46f85f11eea6c1e3c098a065fd",
    familyCount: 1,
    formCount: 17,
    interfaceCount: 8,
    bindingCount: 7,
  });
  expect(catalog.forms).toHaveLength(17);
  expect(catalog.bindings).toHaveLength(7);
  expect(
    [...new Set(catalog.forms.map((form) => form.identity.formRef.apiVersion))].sort(),
  ).toEqual(["edge.forms.takoform.com"]);
  expect(catalog.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(true);
  expect(
    catalog.forms.some((form) =>
      (form.providedInterfaces ?? []).some((provided) => provided.name === "edge.objects"),
    ),
  ).toBe(true);
  expect(
    catalog.forms.some((form) => form.identity.formRef.apiVersion !== "edge.forms.takoform.com"),
  ).toBe(false);
  expect(catalog.forms.every((form) => form.requiresHostApi === "forms.takoform.com/v1")).toBe(
    true,
  );

  const bucket = catalog.forms.find((form) => form.identity.formRef.kind === "ObjectBucket");
  const workerVersion = catalog.forms.find(
    (form) => form.identity.formRef.kind === "WorkerVersion",
  );
  expect(bucket?.desiredSchema).toMatchObject({ additionalProperties: false, properties: {} });
  expect(bucket?.observedSchema).toBeUndefined();
  expect(bucket?.outputSchema).toBeUndefined();
  for (const form of [bucket, workerVersion]) {
    expect(
      JSON.stringify({
        desired: form?.desiredSchema,
        observed: form?.observedSchema,
        output: form?.outputSchema,
      }),
    ).not.toMatch(
      /"(?:endpoint|region|bucket|bucketName|accessKey|accessKeyId|secretAccessKey|providerSupply)"/u,
    );
  }
  const bucketBindings = (
    workerVersion?.desiredSchema as { properties?: { bucketBindings?: unknown } } | undefined
  )?.properties?.bucketBindings;
  expect(bucketBindings).toBeDefined();
  expect(JSON.stringify(bucketBindings)).not.toMatch(
    /"(?:endpoint|region|bucketName|accessKeyId|secretAccessKey|providerSupply)"/u,
  );
});
