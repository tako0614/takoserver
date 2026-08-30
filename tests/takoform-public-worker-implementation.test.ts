import { describe, expect, test } from "bun:test";
import { resolvePublicWorkerImplementationIdentity } from "../src/entry-worker.ts";
import {
  derivePublicFormImplementationIdentity,
  parseFormAuthorityCapabilityManifest,
  publicFormCapabilityManifest,
} from "../src/public-worker-implementation.ts";
import {
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";

const artifact = (hex: string) => `sha256:${hex.repeat(64)}` as const;

describe("public Worker semantic implementation identity", () => {
  test("ignores unrelated outer Worker bytes but changes for payload or capability bytes", async () => {
    const capabilities = publicFormCapabilityManifest();
    const base = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: artifact("1"),
      capabilities,
    });
    const unrelatedOuterWorkerChange = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: artifact("1"),
      capabilities,
    });
    const changedPayload = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: artifact("2"),
      capabilities,
    });
    const changedCapability = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: artifact("1"),
      capabilities: yurucommuLifecycleCapabilityManifest(YURUCOMMU_IDENTITY_CAPABILITY_KINDS, {
        ModuleWorker: ["read"],
      }),
    });

    // The outer Worker artifact is deliberately not an input. A route or UI-only
    // bundle change therefore cannot invalidate already-supported Forms.
    expect(unrelatedOuterWorkerChange).toEqual(base);
    expect(changedPayload.implementationPayloadDigest).not.toBe(base.implementationPayloadDigest);
    expect(changedPayload.implementationDigest).not.toBe(base.implementationDigest);
    expect(changedCapability.capabilityDigest).not.toBe(base.capabilityDigest);
    expect(changedCapability.implementationDigest).not.toBe(base.implementationDigest);
  });

  test("parses only the exact realized capability manifest", () => {
    const capabilities = publicFormCapabilityManifest();
    expect(parseFormAuthorityCapabilityManifest(JSON.stringify(capabilities))).toEqual(
      capabilities,
    );
    expect(() =>
      parseFormAuthorityCapabilityManifest(JSON.stringify({ ...capabilities, extra: true })),
    ).toThrow("capability manifest is invalid");
  });

  test("enables public identity only for a complete embedded semantic and outer artifact pair", () => {
    const embedded = {
      implementationPayloadDigest: artifact("2"),
      capabilityDigest: artifact("3"),
      implementationDigest: artifact("4"),
    } as const;
    expect(resolvePublicWorkerImplementationIdentity({}, undefined)).toBeUndefined();
    expect(() => resolvePublicWorkerImplementationIdentity({}, embedded)).toThrow(
      "implementation identity is incomplete",
    );
    expect(() =>
      resolvePublicWorkerImplementationIdentity(
        { TAKOSERVER_WORKER_ARTIFACT_DIGEST: artifact("1") },
        undefined,
      ),
    ).toThrow("implementation identity is incomplete");
    expect(
      resolvePublicWorkerImplementationIdentity(
        { TAKOSERVER_WORKER_ARTIFACT_DIGEST: artifact("1") },
        embedded,
      ),
    ).toEqual({ workerArtifactDigest: artifact("1"), ...embedded });
  });
});
