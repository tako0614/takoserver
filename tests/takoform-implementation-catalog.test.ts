import { describe, expect, test } from "bun:test";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import {
  deriveImplementationCatalog,
  YURUCOMMU_FORM_VERSIONS,
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuFormCandidates,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";

describe("Form authority implementation catalog", () => {
  test("selects exactly the 12 Yurucommu package identities from the verified corpus", () => {
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

  test("seals operator narrowing into the target capability manifest", () => {
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
