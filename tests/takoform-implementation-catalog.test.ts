import { describe, expect, test } from "bun:test";
import { canonicalDigest } from "../src/json.ts";
import {
  derivePublicFormImplementationIdentity,
  publicFormCapabilityManifest,
} from "../src/public-worker-implementation.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import {
  deriveImplementationCatalog,
  YURUCOMMU_FORM_VERSIONS,
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuFormCandidates,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";

describe("Form authority implementation catalog", () => {
  test("selects exactly the 13 Yurucommu package identities from the verified corpus", () => {
    const forms = yurucommuFormCandidates(currentTakoformCandidates().forms);
    expect(
      forms.map((form) => [form.identity.formRef.kind, form.identity.formRef.definitionVersion]),
    ).toEqual(
      Object.entries(YURUCOMMU_FORM_VERSIONS).sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(forms.every((form) => form.identity.packageDigest?.startsWith("sha256:"))).toBe(true);
    expect(forms.map((form) => form.identity.formRef.kind)).not.toContain("ActorNamespace");
    expect(forms.map((form) => form.identity.formRef.kind)).not.toContain("DurableWorkflow");
    expect(forms.map((form) => form.identity.formRef.kind)).not.toContain("StaticAssetBundle");
    expect(forms.map((form) => form.identity.formRef.kind)).not.toContain("WorkerCustomDomain");
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

  /**
   * ADR 0007 rotates both digests. They are pinned here so a later edit of the
   * capability manifest or the admitted operation set cannot slip through as an
   * accident: changing these values is an explicit reconvergence obligation,
   * never a refresh of a stale expectation.
   */
  test("pins the capability and self-host implementation digests ADR 0007 rotates", async () => {
    const capabilities = publicFormCapabilityManifest();
    expect(capabilities.implementation).toBe(
      "takoserver.public-worker-target@v1:AtLeastOnceQueue,EdgeKVNamespace,ModuleWorker,ObjectBucket,SQLiteDatabase",
    );
    const implementationPayloadDigest = await canonicalDigest({
      kind: "takoserver.selfhost-form-implementation@v1",
      capabilities,
    });
    const semantic = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest,
      capabilities,
    });
    expect(semantic.capabilityDigest).toBe(
      "sha256:a5bc1508638fb1c47182d4ee68be5eedb7acc050394bd3507b532a78daacc024",
    );
    expect(semantic.implementationPayloadDigest).toBe(
      "sha256:b7ea4f2da3f5dca05827442cb9a9f2419bf2063e3a9457cf6f97b7409da9f2c4",
    );
    expect(semantic.implementationDigest).toBe(
      "sha256:8c9c862558356c41c487e8a18a020fedb0a5eb970046bfbac3664376420f1962",
    );
    // The predecessor identity, kept so the reconvergence obligation names the
    // exact pair an operator must move away from.
    expect(semantic.capabilityDigest).not.toBe(
      "sha256:630899ce5e482e7e274c87dab17d74edd904620852a71c2b021aade236a1ea73",
    );
    expect(semantic.implementationDigest).not.toBe(
      "sha256:3788374901bbbb413a8be78d56d1220a3b82d352c12f03d2ce32b0a10454d756",
    );
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
