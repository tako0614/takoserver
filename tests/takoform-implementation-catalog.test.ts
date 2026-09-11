import { describe, expect, test } from "bun:test";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import {
  derivePublicFormImplementationIdentity,
  publicFormCapabilityManifest,
} from "../src/public-worker-implementation.ts";
import { SELFHOST_IDENTITY_CAPABILITY_KINDS } from "../src/selfhost-composition.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import {
  deriveImplementationCatalog,
  exactPublisherFormCandidates,
  YURUCOMMU_FORM_VERSIONS,
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuFormCandidates,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";

const HISTORICAL_PUBLIC_CAPABILITY_DIGESTS = [
  // Capability identity before StaticAssetBundle was admitted as intrinsic.
  "sha256:a5bc1508638fb1c47182d4ee68be5eedb7acc050394bd3507b532a78daacc024",
  // Capability identity before ADR 0007's ObjectBucket admission.
  "sha256:630899ce5e482e7e274c87dab17d74edd904620852a71c2b021aade236a1ea73",
] as const;
const HISTORICAL_SELFHOST_IMPLEMENTATION_PAYLOAD_DIGEST =
  "sha256:b7ea4f2da3f5dca05827442cb9a9f2419bf2063e3a9457cf6f97b7409da9f2c4";
const HISTORICAL_SELFHOST_IMPLEMENTATION_DIGESTS = [
  // Self-host identity after ADR 0007 but before StaticAssetBundle admission.
  "sha256:d5721ffce4cd3167d2f2a00aff8a0fd63e656a1d06b23b804b5c756b608ae15e",
  // The two older identities this host had already moved away from.
  "sha256:3788374901bbbb413a8be78d56d1220a3b82d352c12f03d2ce32b0a10454d756",
  "sha256:6e566932ddad3ef48360d8f3ee643c2ccdf2eb3a05307c483e225f6d6f622459",
] as const;

describe("Form authority implementation catalog", () => {
  test("feeds every exact publisher identity into generic admission", () => {
    const source = currentTakoformCandidates().forms;
    const forms = exactPublisherFormCandidates(source);
    expect(forms).toHaveLength(17);
    expect(
      forms.map((form) => [
        form.identity.formRef.kind,
        form.identity.formRef.definitionVersion,
        form.identity.formRef.schemaDigest,
        form.identity.packageDigest,
      ]),
    ).toEqual(
      [...source]
        .sort((left, right) =>
          canonicalJson(left.identity.formRef).localeCompare(canonicalJson(right.identity.formRef)),
        )
        .map((form) => [
          form.identity.formRef.kind,
          form.identity.formRef.definitionVersion,
          form.identity.formRef.schemaDigest,
          form.identity.packageDigest,
        ]),
    );
    expect(forms.map((form) => form.identity.formRef.kind)).toEqual(
      expect.arrayContaining([
        "ActorNamespace",
        "DurableWorkflow",
        "StaticAssetBundle",
        "WorkerCustomDomain",
      ]),
    );

    const wrongDigest = source.map((form, index) =>
      index === 0
        ? {
            ...form,
            identity: {
              ...form.identity,
              packageDigest: "sha256:not-a-valid-package-digest" as `sha256:${string}`,
            },
          }
        : structuredClone(form),
    );
    expect(() => exactPublisherFormCandidates(wrongDigest)).toThrow(
      "verified publisher Form candidate identity is invalid",
    );
  });

  test("keeps all installed identities in the semantic digest while omitting forms without handlers", async () => {
    const forms = exactPublisherFormCandidates(currentTakoformCandidates().forms);
    const capabilities = {
      apiVersion: "takoserver.form-lifecycle-capabilities@v1" as const,
      implementation: "test-target-v1",
      forms: {},
    };
    const handlers = {
      apiVersion: "takoserver.form-handlers@v1" as const,
      artifact: "test-artifact-v1",
      forms: {
        StaticAssetBundle: ["create", "read", "delete", "import", "observe"] as const,
        WorkerCustomDomain: ["create", "read", "delete", "import", "observe"] as const,
      },
    };
    const catalog = await deriveImplementationCatalog({ forms, capabilities, handlers });
    expect(catalog.entries.map((entry) => entry.formRef.kind)).toEqual([
      "StaticAssetBundle",
      "WorkerCustomDomain",
    ]);
    expect(catalog.entries.every((entry) => entry.operations.length === 0)).toBe(true);

    const withoutUnsupported = await deriveImplementationCatalog({
      forms: forms.filter(
        (form) =>
          form.identity.formRef.kind !== "ActorNamespace" &&
          form.identity.formRef.kind !== "DurableWorkflow",
      ),
      capabilities,
      handlers,
    });
    expect(withoutUnsupported.implementationDigest).not.toBe(catalog.implementationDigest);
    expect(withoutUnsupported.entries).toEqual(catalog.entries);
  });

  test("selects the exact current Yurucommu package identities from the verified corpus", () => {
    const source = currentTakoformCandidates().forms;
    const forms = yurucommuFormCandidates(source);
    expect(forms).toHaveLength(Object.keys(YURUCOMMU_FORM_VERSIONS).length);
    expect(
      forms.map((form) => [form.identity.formRef.kind, form.identity.formRef.definitionVersion]),
    ).toEqual(
      Object.entries(YURUCOMMU_FORM_VERSIONS).sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(forms.every((form) => form.identity.packageDigest?.startsWith("sha256:"))).toBe(true);
    expect(forms.map((form) => form.identity.formRef.kind)).not.toContain("ActorNamespace");
    expect(forms.map((form) => form.identity.formRef.kind)).not.toContain("DurableWorkflow");
    expect(forms.map((form) => form.identity.formRef.kind)).not.toContain("WorkerCustomDomain");
    const staticAsset = forms.find((form) => form.identity.formRef.kind === "StaticAssetBundle");
    const publishedStaticAsset = source.find(
      (form) => form.identity.formRef.kind === "StaticAssetBundle",
    );
    expect(staticAsset).toEqual(publishedStaticAsset);
    expect(staticAsset?.operations).toEqual(["create", "read", "delete", "import", "observe"]);
    // ADR 0007 admitted the exact current ObjectBucket package; the identity is
    // the whole quad, so it is pinned here rather than matched by kind alone.
    expect(forms.find((form) => form.identity.formRef.kind === "ObjectBucket")?.identity).toEqual({
      formRef: {
        apiVersion: "edge.forms.takoform.com",
        kind: "ObjectBucket",
        definitionVersion: "0.1.0",
        schemaDigest: "sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557",
      },
      packageDigest: "sha256:46cd435d838d89de641d38180680e99c8bc7be1a3ae9c123494440d3e6e202ec",
    });
  });

  test("keeps intrinsic assets available without identity supply or custom-domain prerequisites", async () => {
    const capabilities = yurucommuLifecycleCapabilityManifest([]);
    expect(capabilities.forms.StaticAssetBundle).toEqual([
      "create",
      "read",
      "update",
      "delete",
      "import",
      "observe",
    ]);
    expect(capabilities.forms.WorkerBundle).toEqual(capabilities.forms.StaticAssetBundle);
    expect(capabilities.forms.SQLiteMigrationSet).toEqual(capabilities.forms.StaticAssetBundle);
    expect(capabilities.forms.WorkerCustomDomain).toBeUndefined();

    const forms = exactPublisherFormCandidates(currentTakoformCandidates().forms);
    const staticAsset = forms.find((form) => form.identity.formRef.kind === "StaticAssetBundle");
    const customDomain = forms.find((form) => form.identity.formRef.kind === "WorkerCustomDomain");
    if (!staticAsset || !customDomain) throw new Error("intrinsic test Forms are missing");
    const catalog = await deriveImplementationCatalog({
      forms: [staticAsset, customDomain],
      capabilities,
      handlers: {
        apiVersion: "takoserver.form-handlers@v1",
        artifact: "worker-artifact-v1",
        forms: {
          StaticAssetBundle: ["create", "read", "delete", "import", "observe"],
          WorkerCustomDomain: ["create", "read", "delete", "import", "observe"],
        },
      },
    });
    expect(catalog.entries).toEqual([
      expect.objectContaining({
        formRef: staticAsset.identity.formRef,
        packageDigest: staticAsset.identity.packageDigest,
        operations: ["create", "read", "delete", "import", "observe"],
      }),
      expect.objectContaining({
        formRef: customDomain.identity.formRef,
        packageDigest: customDomain.identity.packageDigest,
        operations: [],
      }),
    ]);
  });

  test("rotates the public Worker identity when intrinsic asset support is admitted", async () => {
    const capabilities = publicFormCapabilityManifest();
    expect(capabilities.implementation).toBe(
      "takoserver.public-worker-target@v1:AtLeastOnceQueue,EdgeKVNamespace,ModuleWorker,ObjectBucket,SQLiteDatabase",
    );
    expect(capabilities.forms.StaticAssetBundle).toEqual([
      "create",
      "read",
      "update",
      "delete",
      "import",
      "observe",
    ]);
    const semantic = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: `sha256:${"0".repeat(64)}`,
      capabilities,
    });
    expect(semantic.capabilityDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const predecessorCapabilities = withoutStaticAssetCapability(capabilities);
    const predecessor = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: `sha256:${"0".repeat(64)}`,
      capabilities: predecessorCapabilities,
    });
    expect(predecessor.capabilityDigest).toBe(HISTORICAL_PUBLIC_CAPABILITY_DIGESTS[0]);
    expect(semantic.capabilityDigest).not.toBe(predecessor.capabilityDigest);
    expect(semantic.capabilityDigest).not.toBe(HISTORICAL_PUBLIC_CAPABILITY_DIGESTS[1]);
    expect(semantic.implementationDigest).not.toBe(predecessor.implementationDigest);
  });

  test("keeps self-host and public capability parity while rotating implementation identity", async () => {
    const capabilities = yurucommuLifecycleCapabilityManifest(SELFHOST_IDENTITY_CAPABILITY_KINDS);
    // A self-host realizes the ObjectBucket supply now, so it names one. Both
    // Hosts share the intrinsic-aware capability manifest, while their
    // implementation identities differ because one binds a local payload and
    // the other binds a sealed Worker artifact.
    expect(capabilities.implementation).toBe(
      "takoserver.public-worker-target@v1:AtLeastOnceQueue,EdgeKVNamespace,ModuleWorker,ObjectBucket,SQLiteDatabase",
    );
    expect(capabilities.forms.StaticAssetBundle).toEqual([
      "create",
      "read",
      "update",
      "delete",
      "import",
      "observe",
    ]);
    const publicSemantic = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: `sha256:${"0".repeat(64)}`,
      capabilities: publicFormCapabilityManifest(),
    });
    const implementationPayloadDigest = await canonicalDigest({
      kind: "takoserver.selfhost-form-implementation@v1",
      capabilities,
    });
    const semantic = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest,
      capabilities,
    });
    expect(semantic.capabilityDigest).toBe(publicSemantic.capabilityDigest);
    expect(semantic.capabilityDigest).not.toBe(HISTORICAL_PUBLIC_CAPABILITY_DIGESTS[0]);
    expect(semantic.implementationPayloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(semantic.implementationPayloadDigest).not.toBe(
      HISTORICAL_SELFHOST_IMPLEMENTATION_PAYLOAD_DIGEST,
    );
    expect(semantic.implementationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    for (const predecessor of HISTORICAL_SELFHOST_IMPLEMENTATION_DIGESTS) {
      expect(semantic.implementationDigest).not.toBe(predecessor);
    }
    expect(semantic.implementationDigest).not.toBe(publicSemantic.implementationDigest);
  });

  test("keeps ObjectBucket unsupported on a Host with no realized bucket supply", async () => {
    const withoutBucket = yurucommuLifecycleCapabilityManifest(
      YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter((kind) => kind !== "ObjectBucket"),
    );
    expect(withoutBucket.forms.ObjectBucket).toEqual([]);
    const form = yurucommuFormCandidates(currentTakoformCandidates().forms).find(
      (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
    );
    if (!form) throw new Error("ObjectBucket candidate missing");
    const catalog = await deriveImplementationCatalog({
      forms: [form],
      capabilities: withoutBucket,
      handlers: {
        apiVersion: "takoserver.form-handlers@v1",
        artifact: "worker-artifact-v1",
        forms: { ObjectBucket: ["create", "read", "delete", "import", "observe"] },
      },
    });
    expect(catalog.entries[0]?.operations).toEqual([]);
  });

  test("never admits update for ObjectBucket, which its Form does not declare", async () => {
    const form = yurucommuFormCandidates(currentTakoformCandidates().forms).find(
      (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
    );
    if (!form) throw new Error("ObjectBucket candidate missing");
    const catalog = await deriveImplementationCatalog({
      forms: [form],
      capabilities: publicFormCapabilityManifest(),
      handlers: {
        apiVersion: "takoserver.form-handlers@v1",
        artifact: "worker-artifact-v1",
        forms: { ObjectBucket: ["create", "read", "update", "delete", "import", "observe"] },
      },
    });
    expect(catalog.entries[0]?.operations).toEqual([
      "create",
      "read",
      "delete",
      "import",
      "observe",
    ]);
  });

  test("intersects Form lifecycle, capability, and actual-handler operations", async () => {
    const form = yurucommuFormCandidates(currentTakoformCandidates().forms).find(
      (candidate) => candidate.identity.formRef.kind === "WorkerDeployment",
    );
    if (!form) throw new Error("WorkerDeployment candidate missing");
    const catalog = await deriveImplementationCatalog({
      forms: [form],
      capabilities: {
        apiVersion: "takoserver.form-lifecycle-capabilities@v1",
        implementation: "cloudflare-provider-v1",
        forms: {
          WorkerDeployment: ["create", "read", "update", "delete", "observe"],
        },
      },
      handlers: {
        apiVersion: "takoserver.form-handlers@v1",
        artifact: "worker-artifact-v1",
        forms: { WorkerDeployment: ["create", "read", "delete", "import"] },
      },
    });
    expect(catalog.entries[0]?.operations).toEqual(["create", "read", "delete"]);
  });

  test("rotates semantic identity for exact Form package or admitted operation changes", async () => {
    const form = yurucommuFormCandidates(currentTakoformCandidates().forms).find(
      (candidate) => candidate.identity.formRef.kind === "WorkerDeployment",
    );
    if (!form) throw new Error("WorkerDeployment candidate missing");
    const capabilities = {
      apiVersion: "takoserver.form-lifecycle-capabilities@v1" as const,
      implementation: "cloudflare-provider-v1",
      forms: { WorkerDeployment: ["create", "read", "delete"] as const },
    };
    const handlers = {
      apiVersion: "takoserver.form-handlers@v1" as const,
      artifact: "sha256:payload-v1",
      forms: { WorkerDeployment: ["create", "read", "delete"] as const },
    };
    const base = await deriveImplementationCatalog({ forms: [form], capabilities, handlers });
    const changedPackage = await deriveImplementationCatalog({
      forms: [
        {
          ...form,
          identity: { ...form.identity, packageDigest: `sha256:${"f".repeat(64)}` as const },
        },
      ],
      capabilities,
      handlers,
    });
    const changedOperations = await deriveImplementationCatalog({
      forms: [form],
      capabilities,
      handlers: {
        ...handlers,
        forms: { WorkerDeployment: ["read", "delete"] as const },
      },
    });

    expect(changedPackage.implementationDigest).not.toBe(base.implementationDigest);
    expect(changedOperations.entries[0]?.operations).toEqual(["read", "delete"]);
    expect(changedOperations.implementationDigest).not.toBe(base.implementationDigest);
  });

  test("lets an operator narrow but rejects every widening request", async () => {
    const form = yurucommuFormCandidates(currentTakoformCandidates().forms).find(
      (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
    );
    if (!form) throw new Error("ModuleWorker candidate missing");
    const input = {
      forms: [form],
      capabilities: {
        apiVersion: "takoserver.form-lifecycle-capabilities@v1" as const,
        implementation: "cloudflare-provider-v1",
        forms: { ModuleWorker: ["create", "read", "delete"] as const },
      },
      handlers: {
        apiVersion: "takoserver.form-handlers@v1" as const,
        artifact: "worker-artifact-v1",
        forms: { ModuleWorker: ["create", "read", "delete"] as const },
      },
    };
    const narrowed = await deriveImplementationCatalog({
      ...input,
      operatorOperations: { ModuleWorker: ["read"] },
    });
    expect(narrowed.entries[0]?.operations).toEqual(["read"]);
    await expect(
      deriveImplementationCatalog({
        ...input,
        operatorOperations: { ModuleWorker: ["read", "import"] },
      }),
    ).rejects.toThrow("widen");
  });

  test("can derive a separately narrowed policy manifest without widening support", () => {
    const narrowed = yurucommuLifecycleCapabilityManifest(YURUCOMMU_IDENTITY_CAPABILITY_KINDS, {
      ModuleWorker: ["read"],
    });
    expect(narrowed.forms.ModuleWorker).toEqual(["read"]);
    expect(() =>
      yurucommuLifecycleCapabilityManifest(
        YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter((kind) => kind !== "ModuleWorker"),
        { ModuleWorker: ["read"] },
      ),
    ).toThrow("widen");
  });
});

function withoutStaticAssetCapability(
  capabilities: ReturnType<typeof publicFormCapabilityManifest>,
): ReturnType<typeof publicFormCapabilityManifest> {
  return {
    ...capabilities,
    forms: Object.fromEntries(
      Object.entries(capabilities.forms).filter(([kind]) => kind !== "StaticAssetBundle"),
    ),
  };
}
