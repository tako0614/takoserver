import { describe, expect, test } from "bun:test";
import { isPublicHostIdentity, publicHostIdentity } from "../src/public-host-identity.ts";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}` as const;
const IMPLEMENTATION_PAYLOAD_DIGEST = `sha256:${"c".repeat(64)}` as const;
const CAPABILITY_DIGEST = `sha256:${"d".repeat(64)}` as const;
const IMPLEMENTATION_DIGEST = `sha256:${"b".repeat(64)}` as const;

describe("public Host identity RPC value", () => {
  test("returns the exact realized public Worker identity", () => {
    expect(
      publicHostIdentity({
        hostId: "https://api.integration.example.test",
        workerVersionId: VERSION_ID,
        workerArtifactDigest: ARTIFACT_DIGEST,
        implementationPayloadDigest: IMPLEMENTATION_PAYLOAD_DIGEST,
        capabilityDigest: CAPABILITY_DIGEST,
        implementationDigest: IMPLEMENTATION_DIGEST,
      }),
    ).toEqual({
      kind: "takoserver.public-host-identity@v2",
      hostId: "https://api.integration.example.test",
      workerVersionId: VERSION_ID,
      workerArtifactDigest: ARTIFACT_DIGEST,
      implementationPayloadDigest: IMPLEMENTATION_PAYLOAD_DIGEST,
      capabilityDigest: CAPABILITY_DIGEST,
      implementationDigest: IMPLEMENTATION_DIGEST,
    });
  });

  test("rejects missing, malformed, and extra identity members", () => {
    const exact = {
      kind: "takoserver.public-host-identity@v2",
      hostId: "https://api.integration.example.test",
      workerVersionId: VERSION_ID,
      workerArtifactDigest: ARTIFACT_DIGEST,
      implementationPayloadDigest: IMPLEMENTATION_PAYLOAD_DIGEST,
      capabilityDigest: CAPABILITY_DIGEST,
      implementationDigest: IMPLEMENTATION_DIGEST,
    } as const;

    expect(isPublicHostIdentity(exact)).toBe(true);
    expect(isPublicHostIdentity({ ...exact, kind: "takoserver.public-host-identity@v1" })).toBe(
      false,
    );
    expect(isPublicHostIdentity({ ...exact, workerArtifactDigest: "sha256:bad" })).toBe(false);
    expect(isPublicHostIdentity({ ...exact, implementationPayloadDigest: "sha256:bad" })).toBe(
      false,
    );
    expect(isPublicHostIdentity({ ...exact, capabilityDigest: "sha256:bad" })).toBe(false);
    expect(isPublicHostIdentity({ ...exact, implementationDigest: "sha256:bad" })).toBe(false);
    expect(isPublicHostIdentity({ ...exact, unexpected: true })).toBe(false);
    const { implementationDigest: _missing, ...missing } = exact;
    expect(isPublicHostIdentity(missing)).toBe(false);
  });
});
