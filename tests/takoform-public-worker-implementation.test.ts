import { describe, expect, test } from "bun:test";
import { resolvePublicWorkerImplementationIdentity } from "../src/entry-worker.ts";
import {
  derivePublicFormImplementationIdentity,
  deriveRuntimeImplementationCatalog,
  parseFormAuthorityCapabilityManifest,
  publicFormCapabilityManifest,
} from "../src/public-worker-implementation.ts";
import {
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";

const artifact = (hex: string) => `sha256:${hex.repeat(64)}` as const;

describe("public Worker semantic implementation identity", () => {
  test("derives support only from declared capabilities and concrete handlers", async () => {
    const catalog = await deriveRuntimeImplementationCatalog({
      implementationPayloadDigest: artifact("1"),
      capabilities: publicFormCapabilityManifest(),
    });
    const kinds = catalog.entries.map((entry) => entry.formRef.kind);
    expect(kinds).toHaveLength(14);
    expect(kinds).toContain("StaticAssetBundle");
    for (const kind of ["WorkerCustomDomain", "ActorNamespace", "DurableWorkflow"]) {
      expect(kinds).not.toContain(kind);
    }
    expect(
      catalog.entries.find((entry) => entry.formRef.kind === "StaticAssetBundle")?.operations,
    ).toEqual(["create", "read", "delete", "import", "observe"]);
    expect(
      catalog.entries.find((entry) => entry.formRef.kind === "WorkerCustomDomain")?.operations,
    ).toBeUndefined();
  });

  test("keeps intrinsic asset support independent of identity supply and domain configuration", async () => {
    const capabilities = yurucommuLifecycleCapabilityManifest([]);
    const catalog = await deriveRuntimeImplementationCatalog({
      implementationPayloadDigest: artifact("1"),
      capabilities,
    });
    expect(capabilities.forms.StaticAssetBundle).toEqual([
      "create",
      "read",
      "update",
      "delete",
      "import",
      "observe",
    ]);
    expect(
      catalog.entries.find((entry) => entry.formRef.kind === "StaticAssetBundle")?.operations,
    ).toEqual(["create", "read", "delete", "import", "observe"]);
    expect(
      catalog.entries.find((entry) => entry.formRef.kind === "WorkerCustomDomain")?.operations,
    ).toBeUndefined();
  });

  test("preserves an explicitly declared supported-empty identity", async () => {
    const base = publicFormCapabilityManifest();
    const catalog = await deriveRuntimeImplementationCatalog({
      implementationPayloadDigest: artifact("1"),
      capabilities: { ...base, forms: { ...base.forms, WorkerCustomDomain: [] } },
    });
    expect(catalog.entries).toHaveLength(15);
    expect(
      catalog.entries.find((entry) => entry.formRef.kind === "WorkerCustomDomain")?.operations,
    ).toEqual([]);
  });

  test("never derives support from an inherited capability declaration", async () => {
    const base = publicFormCapabilityManifest();
    const forms = Object.assign(Object.create({ WorkerCustomDomain: [] }), base.forms);
    const catalog = await deriveRuntimeImplementationCatalog({
      implementationPayloadDigest: artifact("1"),
      capabilities: { ...base, forms },
    });
    expect(catalog.entries.map((entry) => entry.formRef.kind)).not.toContain("WorkerCustomDomain");
  });

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
    expect(() =>
      parseFormAuthorityCapabilityManifest(
        JSON.stringify({
          ...capabilities,
          forms: { ...capabilities.forms, MadeUpForm: ["read"] },
        }),
      ),
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
    // An ordinary Worker/JIT artifact digest is not a Form declaration.
    expect(
      resolvePublicWorkerImplementationIdentity(
        { TAKOSERVER_WORKER_ARTIFACT_DIGEST: artifact("1") },
        undefined,
      ),
    ).toBeUndefined();
    for (const identity of [undefined, embedded]) {
      expect(() =>
        resolvePublicWorkerImplementationIdentity(
          { TAKOSERVER_WORKER_ARTIFACT_DIGEST: "malformed" },
          identity,
        ),
      ).toThrow("implementation identity is incomplete");
    }
    expect(
      resolvePublicWorkerImplementationIdentity(
        { TAKOSERVER_WORKER_ARTIFACT_DIGEST: artifact("1") },
        embedded,
      ),
    ).toEqual({ workerArtifactDigest: artifact("1"), ...embedded });
  });
});
