import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { createProviderDriver, createProviderFormAvailability } from "../src/provider-driver.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import { createSelfhostComposition } from "../src/selfhost-composition.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * Released provider Forms remain installed behind the Provider Pack only to
 * drain already-recorded Deployments. They are not a current product catalog:
 * this standalone composition has no current managed ObjectBucket supply, and
 * the retained identity may not regain sale/provision authority here.
 */

const runtime: WorkerdRuntime = {
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return false;
  },
};

const leases: ProviderRuntimeInputLeasePort = {
  async acquire(): Promise<never> {
    throw new Error("the capability probe must not acquire");
  },
  async recover(): Promise<never> {
    throw new Error("the capability probe must not recover");
  },
  async abandon() {},
};

async function compose(edgeForms: boolean, runtimeInputs?: ProviderRuntimeInputLeasePort) {
  return createSelfhostComposition({
    edge: await buildEdgeForms(),
    stableForms: stableProductionTakoformCatalog().forms,
    dataRoot: "/tmp/unused",
    runtime,
    artifacts: {
      async manifest() {
        return null;
      },
      async blob() {
        return null;
      },
    },
    edgeForms,
    ...(runtimeInputs ? { runtimeInputs } : {}),
    now: new Date("2026-06-01T00:00:00.000Z"),
  });
}

describe("the self-host catalog", () => {
  test("offers stable Edge identities while keeping released beta identities drain-only", async () => {
    const composition = await compose(true);
    expect(composition.offerings.map((offering) => offering.form.kind).sort()).toEqual([
      "AtLeastOnceQueue",
      "EdgeKVNamespace",
      "ModuleWorker",
      "SQLiteDatabase",
    ]);
    expect(
      composition.offerings.every(
        (offering) => offering.form.apiVersion === "edge.forms.takoform.com",
      ),
    ).toBe(true);
    expect(
      composition.provider.offerings.some(
        (offering) => offering.form.apiVersion === "edge.forms.takoform.com/v1beta1",
      ),
    ).toBe(true);
    expect(JSON.stringify(composition.offerings)).not.toContain("ObjectBucket");
    expect(JSON.stringify(composition.offerings)).not.toContain("edge.objects");
  });

  test("projects exactly one technical offering per relation Form", async () => {
    const composition = await compose(true);
    const edge = await buildEdgeForms();
    const relationForms = edge.forms.filter(
      (form) =>
        form.role !== "identity" &&
        ![
          "WorkerBundle",
          "StaticAssetBundle",
          "SQLiteMigrationSet",
          "SQLiteMigrationApplication",
        ].includes(form.identity.formRef.kind),
    );
    for (const form of relationForms) {
      const matches = composition.provider.offerings.filter(
        (offering) =>
          offering.form.kind === form.identity.formRef.kind &&
          offering.form.schemaDigest === form.identity.formRef.schemaDigest,
      );
      expect(matches).toHaveLength(1);
    }
  });

  test("executes a stable ModuleWorker through the ordinary self-host provider", async () => {
    const composition = await compose(true);
    const offering = composition.provider.offerings.find(
      (candidate) =>
        candidate.form.apiVersion === "edge.forms.takoform.com" &&
        candidate.form.kind === "ModuleWorker",
    );
    if (!offering) throw new Error("stable ModuleWorker offering missing");
    expect(
      await composition.provider.apply({
        operationId: "op_stable_module_worker",
        offering,
        identity: { tenantRef: "tenant-a", space: "main", name: "worker" },
        spec: {},
      }),
    ).toMatchObject({ phase: "succeeded" });
  });

  test("advertises only the exact stable Forms the local composition executes", async () => {
    const composition = await compose(true);
    const catalog = stableProductionTakoformCatalog();
    const availability = createProviderFormAvailability([composition.provider]);
    const executable: string[] = [];
    for (const form of catalog.forms) {
      const state = await availability.resolve({
        tenantId: "tenant-a",
        principalId: "principal-a",
        form,
      });
      if (state.executable) executable.push(form.identity.formRef.kind);
      expect(state.activated).toBe(state.executable);
      expect(state.availableToPrincipal).toBe(state.executable);
    }
    expect(executable.sort()).toEqual([
      "AtLeastOnceQueue",
      "EdgeKVNamespace",
      "ModuleWorker",
      "QueueConsumer",
      "SQLiteDatabase",
      "SQLiteMigrationApplication",
      "SQLiteMigrationSet",
      "StaticAssetBundle",
      "WorkerBundle",
      "WorkerCronTrigger",
      "WorkerCustomDomain",
      "WorkerDeployment",
      "WorkerEndpoint",
      "WorkerVersion",
    ]);
  });

  test("advertises a runtime-input ceiling only when a sealed lease port exists", async () => {
    const unconfigured = await compose(true);
    expect(unconfigured.provider.runtimeInputCapabilities).toBeUndefined();

    const configured = await compose(true, leases);
    expect(configured.provider.runtimeInputCapabilities).toEqual({ maximumBindings: 64 });
  });

  test("projects that ceiling into the WorkerVersion support profile the provider reads", async () => {
    const workerVersion = stableProductionTakoformCatalog().forms.find(
      (form) =>
        form.identity.formRef.apiVersion === "edge.forms.takoform.com" &&
        form.identity.formRef.kind === "WorkerVersion",
    );
    if (!workerVersion) throw new Error("the stable WorkerVersion Form is missing");

    for (const [runtimeInputs, expected] of [
      [undefined, 0],
      [leases, 64],
    ] as const) {
      const composition = await compose(true, runtimeInputs);
      const driver = createProviderDriver({
        providers: [composition.provider],
        catalog: {
          list: () => composition.offerings,
          async digest() {
            return `sha256:${"a".repeat(64)}` as const;
          },
          findOffering: () => undefined,
          offeringsFor: () => [],
        } as never,
        deployments: {} as never,
        ledger: {} as never,
      });
      expect(driver.runtimeInputPolicy?.guaranteedMaximum(workerVersion)).toBe(expected);
    }
  });

  test("keeps the legacy storage-only variant drain-only too", async () => {
    const composition = await compose(false);
    expect(composition.offerings).toEqual([]);
    expect(composition.provider.offerings.map((offering) => offering.id)).toEqual([
      "storage.object.standard",
    ]);
  });
});
