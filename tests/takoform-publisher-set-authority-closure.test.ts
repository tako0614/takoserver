import { describe, expect, test } from "bun:test";
import { TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE } from "../src/generated/takoform-publisher-set-authority-closure.ts";
import {
  TAKOFORM_PUBLISHER_SET_RECEIPT,
  TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST,
} from "../src/generated/takoform-publisher-set-receipt.ts";
import { bytesDigest, canonicalDigest, canonicalJson } from "../src/json.ts";

const EXPECTED_REPOSITORY = "https://github.com/tako0614/takoform-forms.git";
const EXPECTED_REPOSITORY_COMMIT = "3231633605b737ce5279d7fc020b4780568e7091";
const EXPECTED_SET_ID = "e7f8a39311dd011b8467e97e7f300cabb9a6b06c";

describe("publisher-set authority closure", () => {
  test("binds one exact publisher repository set without a publisher class", async () => {
    const closure = TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE;
    expect(closure.kind).toBe("takoserver.takoform-publisher-set-authority-closure@v1");
    expect(closure.repository).toBe(EXPECTED_REPOSITORY);
    expect(closure.repositoryCommit).toBe(EXPECTED_REPOSITORY_COMMIT);
    expect(closure.setId).toBe(EXPECTED_SET_ID);
    expect(closure.setTag).toBe(`forms/sets/${EXPECTED_SET_ID}`);
    expect(closure.receiptDigest).toBe(TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST);
    expect(closure.core.protocol).toBe("takoserver.takoform-core-verifier@v1");
    expect(closure.core.expectedSourceCommit).toBe(EXPECTED_SET_ID);
    expect(JSON.parse(closure.core.publisherPolicy)).toEqual(
      TAKOFORM_PUBLISHER_SET_RECEIPT.publisherPolicy,
    );

    const serialized = canonicalJson(closure);
    expect(serialized).not.toContain('"official"');
    expect(serialized).not.toContain('"thirdParty"');
    expect(serialized).not.toContain('"publisherClass"');
  });

  test("contains the complete exact 17-package Core verification closure", async () => {
    const closure = TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE;
    expect(closure.packages).toHaveLength(17);
    expect(closure.core.packageBundles).toHaveLength(17);
    expect(new Set(closure.packages.map(({ packageDigest }) => packageDigest)).size).toBe(17);
    expect(
      new Set(closure.core.packageBundles.map(({ packageDigest }) => packageDigest)).size,
    ).toBe(17);

    const expected = new Map(
      TAKOFORM_PUBLISHER_SET_RECEIPT.packages.map((entry) => [entry.packageDigest, entry]),
    );
    expect(expected.size).toBe(17);
    for (const pkg of closure.packages) {
      const receipt = expected.get(pkg.packageDigest);
      if (!receipt) throw new Error("receipt package is missing");
      expect(canonicalJson(pkg.formRef)).toBe(canonicalJson(receipt.formRef));
      expect(await canonicalDigest(pkg.manifest)).toBe(pkg.packageDigest);
      expect(pkg.files).toHaveLength(pkg.manifest.files.length);
      for (const descriptor of pkg.manifest.files) {
        const files = pkg.files.filter((file) => file.path === descriptor.path);
        expect(files).toHaveLength(1);
        const file = files[0];
        if (!file) throw new Error("generated package file is missing");
        const bytes = Uint8Array.from(Buffer.from(file.base64, "base64"));
        expect(bytes.byteLength).toBe(descriptor.size);
        expect(await bytesDigest(bytes)).toBe(descriptor.digest);
        expect(file.digest).toBe(descriptor.digest);
        expect(file.mediaType).toBe(descriptor.mediaType);
      }
    }

    for (const bundle of closure.core.packageBundles) {
      const receipt = expected.get(bundle.packageDigest);
      if (!receipt) throw new Error("receipt package is missing");
      expect(await bytesDigest(new TextEncoder().encode(bundle.bundle))).toBe(receipt.bundleDigest);
    }
    expect(await bytesDigest(new TextEncoder().encode(closure.core.checkpointBundle))).toBe(
      TAKOFORM_PUBLISHER_SET_RECEIPT.checkpoint.bundleDigest,
    );
  });
});
