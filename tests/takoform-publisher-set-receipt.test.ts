import { expect, test } from "bun:test";
import {
  TAKOFORM_PUBLISHER_SET_RECEIPT,
  TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST,
} from "../src/generated/takoform-publisher-set-receipt.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";

test("the current catalog is an exact projection of one verified public publisher set", async () => {
  const receipt = TAKOFORM_PUBLISHER_SET_RECEIPT;
  const catalog = currentTakoformCandidates();

  expect(await canonicalDigest(receipt)).toBe(TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST);
  expect(receipt).toMatchObject({
    kind: "takoserver.publisher-set-verification@v1",
    coreVersion: "v1.1.0",
    repository: "https://github.com/tako0614/takoform-forms.git",
    repositoryCommit: "3231633605b737ce5279d7fc020b4780568e7091",
    setId: "e7f8a39311dd011b8467e97e7f300cabb9a6b06c",
    setTag: "forms/sets/e7f8a39311dd011b8467e97e7f300cabb9a6b06c",
    sourceCommit: "e7f8a39311dd011b8467e97e7f300cabb9a6b06c",
    workflowCommit: "e7f8a39311dd011b8467e97e7f300cabb9a6b06c",
    buildConfigCommit: "e7f8a39311dd011b8467e97e7f300cabb9a6b06c",
  });
  expect(receipt.packages).toHaveLength(17);

  const exact = new Map(
    receipt.packages.map((entry) => [
      canonicalJson(entry.formRef),
      { packageDigest: entry.packageDigest, bundleDigest: entry.bundleDigest },
    ]),
  );
  expect(exact.size).toBe(receipt.packages.length);
  expect(new Set(receipt.packages.map((entry) => entry.packageDigest)).size).toBe(17);
  expect(new Set(receipt.packages.map((entry) => entry.bundleDigest)).size).toBe(17);
  expect(
    catalog.forms.every(
      (form) =>
        exact.get(canonicalJson(form.identity.formRef))?.packageDigest ===
        form.identity.packageDigest,
    ),
  ).toBe(true);

  expect(receipt.packages.find((entry) => entry.formRef.kind === "ObjectBucket")).toMatchObject({
    formRef: {
      apiVersion: "edge.forms.takoform.com",
      kind: "ObjectBucket",
      definitionVersion: "0.1.0",
      schemaDigest: "sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557",
    },
    packageDigest: "sha256:46cd435d838d89de641d38180680e99c8bc7be1a3ae9c123494440d3e6e202ec",
    bundleDigest: "sha256:382051b888892576e658a6299bf6729907cfb05c507c072ce6407037b4061777",
  });

  const serialized = canonicalJson(receipt);
  expect(serialized).not.toContain('"official"');
  expect(serialized).not.toContain('"thirdParty"');
  expect(serialized).not.toContain('"lane"');
});
