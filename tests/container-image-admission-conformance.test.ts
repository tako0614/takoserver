import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

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

// This corpus interprets the requested default 2 GB as decimal 2,000,000,000 bytes,
// not 2 GiB (2,147,483,648 bytes). The limit is inclusive. sizeBytes is the selected
// image's total payload size reported by the synthetic registry, not the index's
// JSON size or the sum of all platforms in a manifest list. A list must resolve
// exactly one os/architecture/variant entry; an omitted variant matches only an
// omitted variant. Unknown or invalid sizes fail closed. This is a test contract
// for Container review, with no production registry access or admission changes.
const DEFAULT_MAX_IMAGE_SIZE_BYTES = 2_000_000_000;
const SHA256_DIGEST = /^sha256:[0-9a-fA-F]{64}$/;
const PINNED_REFERENCE = /^[^@\s]+@(sha256:[0-9a-fA-F]{64})$/;

function samePlatform(left: Platform, right: Platform): boolean {
  return (
    left.os === right.os &&
    left.architecture === right.architecture &&
    (left.variant ?? "") === (right.variant ?? "")
  );
}

function reject(reason: RejectionReason): AdmissionResult {
  return { decision: "reject", reason };
}

function validDigest(digest: string): boolean {
  // JavaScript's $ also matches before a final newline; require the exact length.
  return digest.length === 71 && SHA256_DIGEST.test(digest);
}

function mockEvaluateImageAdmission(input: AdmissionInput): AdmissionResult {
  const referenceMatch = PINNED_REFERENCE.exec(input.imageRef);
  const pinnedDigest = referenceMatch?.[1];
  if (!pinnedDigest || referenceMatch?.[0] !== input.imageRef) return reject("digest_pin_required");

  const auth = input.registry.auth;
  if (input.registry.visibility === "private" && !auth?.present) {
    return reject("registry_auth_required");
  }
  if (auth?.present && !auth.authorized) return reject("registry_auth_failed");

  if (!validDigest(input.manifest.digest)) return reject("manifest_digest_invalid");
  if (input.manifest.digest !== pinnedDigest) return reject("manifest_digest_mismatch");

  let selected: ImageManifest;
  if (input.manifest.kind === "list") {
    const candidates = input.manifest.manifests.filter((manifest) =>
      samePlatform(manifest.platform, input.platform),
    );
    const candidate = candidates[0];
    if (!candidate) return reject("platform_mismatch");
    if (candidates.length !== 1) return reject("platform_ambiguous");
    selected = candidate;
  } else {
    selected = input.manifest;
    if (!samePlatform(selected.platform, input.platform)) return reject("platform_mismatch");
  }
  if (!validDigest(selected.digest)) return reject("manifest_digest_invalid");

  const limit = input.maxImageSizeBytes ?? DEFAULT_MAX_IMAGE_SIZE_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) return reject("image_size_limit_invalid");
  if (selected.sizeBytes === null) return reject("image_size_unknown");
  if (!Number.isSafeInteger(selected.sizeBytes) || selected.sizeBytes < 0) {
    return reject("image_size_invalid");
  }
  if (selected.sizeBytes > limit) return reject("image_size_exceeded");

  return {
    decision: "accept",
    digest: selected.digest,
    sizeBytes: selected.sizeBytes,
    platform: { ...selected.platform },
  };
}

// Implementation handoff: replace ONLY the following alias with one import:
// import { evaluateContainerImageAdmission as evaluateImageAdmission } from "../src/...";
// The fixture input/result contract and literal expected JSON remain unchanged.
const evaluateImageAdmission = mockEvaluateImageAdmission;

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
