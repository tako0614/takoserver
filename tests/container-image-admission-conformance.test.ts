import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { evaluateContainerImageAdmission as evaluateImageAdmission } from "../src/container-image-admission.ts";

type Platform = {
  os: string;
  architecture: string;
  variant?: string;
};

type ImageManifest = {
  kind: "image";
  digest: string;
  platform: Platform;
  sizeBytes: number | null;
};

type AdmissionInput = {
  imageRef: string;
  platform: Platform;
  maxImageSizeBytes?: number;
  registry: {
    visibility: "public" | "private";
    // Registry responses are synthetic metadata; these vectors contain no credentials.
    auth?: { present: boolean; authorized: boolean };
  };
  manifest: ImageManifest | { kind: "list"; digest: string; manifests: ImageManifest[] };
};

type RejectionReason =
  | "digest_pin_required"
  | "registry_auth_required"
  | "registry_auth_failed"
  | "manifest_digest_invalid"
  | "manifest_digest_mismatch"
  | "platform_mismatch"
  | "platform_ambiguous"
  | "image_size_limit_invalid"
  | "image_size_unknown"
  | "image_size_invalid"
  | "image_size_exceeded";

type AdmissionResult =
  | { decision: "reject"; reason: RejectionReason }
  | { decision: "accept"; digest: string; sizeBytes: number; platform: Platform };

type AdmissionFixture = {
  id: string;
  category: "reference" | "size" | "platform" | "manifest-list" | "registry-auth";
  description: string;
  input: AdmissionInput;
  expected: AdmissionResult;
};

// Imported from PR #360 head 2d7010ddc99f034b11f2d1eceb7e0e0d6fce049a.
// The original 85 vectors are preserved outside Git in operator-runs:
// container-parallel-20261014/evidence-pr360-image-admission/receipt.json.
// Only 017 was corrected: OCI SHA-256 descriptor hex must be lowercase, so its
// uppercase manifest.digest rejects. Caller reference canonicalization is separate.
// https://github.com/opencontainers/image-spec/blob/main/descriptor.md#sha-256
// 086-088 cover that distinction, selected descriptor validation, and exact variants.

const fixtureDirectory = new URL("./fixtures/container-image-admission/", import.meta.url);
const fixtureFiles = (await readdir(fixtureDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort();
const fixtures = await Promise.all(
  fixtureFiles.map(async (file) => ({
    file,
    fixture: JSON.parse(
      await readFile(new URL(file, fixtureDirectory), "utf8"),
    ) as AdmissionFixture,
  })),
);

describe("container image admission conformance", () => {
  test("contains at least 40 independent JSON vectors across every required category", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    expect(new Set(fixtures.map(({ fixture }) => fixture.id)).size).toBe(fixtures.length);
    expect(new Set(fixtures.map(({ fixture }) => fixture.category))).toEqual(
      new Set(["reference", "size", "platform", "manifest-list", "registry-auth"]),
    );
    for (const { file, fixture } of fixtures) {
      expect(file).toBe(`${fixture.id}.json`);
      expect(fixture.description.length).toBeGreaterThan(0);
      expect(fixture.expected.decision === "accept" || fixture.expected.decision === "reject").toBe(
        true,
      );
    }
  });

  for (const { fixture } of fixtures) {
    test(`${fixture.id}: ${fixture.description}`, async () => {
      const input = structuredClone(fixture.input);
      expect(await evaluateImageAdmission(input)).toEqual(fixture.expected);
      expect(await evaluateImageAdmission(input)).toEqual(fixture.expected);
      expect(input).toEqual(fixture.input);
    });
  }
});
