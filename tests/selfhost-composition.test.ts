import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { createProviderDriver, createProviderFormAvailability } from "../src/provider-driver.ts";
import type { ProviderRelation } from "../src/provider-port.ts";
import { resolveRuntimeBindingMaterialRoute } from "../src/provider-runtime-bindings.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import { EDGE_OBJECTS_BINDING_REF } from "../src/providers/cloudflare-runtime-bindings.ts";
import { SELFHOST_EDGE_OBJECTS_MATERIAL_KIND } from "../src/providers/selfhost-runtime-bindings.ts";
import { createSelfhostComposition } from "../src/selfhost-composition.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * Released beta provider Forms remain installed behind the Provider Pack only
 * to drain already-recorded Deployments. They are not a current product
 * catalog and the retained identity may not regain sale/provision authority.
 *
 * The current ObjectBucket is the one that moved: this machine realizes the
 * supply now, so it is a candidate rather than a refusal, and the Provider Pack
 * owns both halves of the `module-worker.object-bucket` materialization that
 * makes it consumable (ADR 0007).
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

/** One realized bucket Deployment, exactly as the driver hands one over. */
function bucketRelation(
  providerPackRef: string,
  bucketId: string,
): ProviderRelation & { readonly deployment: NonNullable<ProviderRelation["deployment"]> } {
  return {
    pointer: "/bucketBindings/0/resource",
    relation: "/bucketBindings/*/resource",
    targetUid: "uid-bucket-media",
    bindingRef: EDGE_OBJECTS_BINDING_REF,
    resource: {
      apiVersion: "edge.forms.takoform.com",
      kind: "ObjectBucket",
      form: {
        formRef: {
          apiVersion: "edge.forms.takoform.com",
          kind: "ObjectBucket",
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      metadata: {
        name: "media",
        space: "default",
        uid: "uid-bucket-media",
        generation: "1",
        revision: "1",
      },
      spec: {},
    },
    deployment: {
      tenantId: "org_demo",
      id: "dep-media",
      resourceUid: "uid-bucket-media",
      offeringId: "storage.object.stable-v1.standard",
      providerPackRef,
      providerInstallationRef: "local.primary",
      nativeId: `selfhost-bucket:${bucketId}`,
      state: "active",
      observed: {},
      outputs: { bucketName: bucketId },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    },
  };
}

describe("the self-host catalog", () => {
  test("offers stable Edge identities while keeping released beta identities drain-only", async () => {
    const composition = await compose(true);
    expect(composition.offerings.map((offering) => offering.form.kind).sort()).toEqual([
      "AtLeastOnceQueue",
      "EdgeKVNamespace",
      "ModuleWorker",
      "ObjectBucket",
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
    // The current bucket is sold under its own offering id; the retained beta
    // identity keeps the drain-only one and never becomes a catalog item.
    const buckets = composition.offerings.filter(
      (offering) => offering.form.kind === "ObjectBucket",
    );
    expect(buckets.map((offering) => offering.id)).toEqual(["storage.object.stable-v1.standard"]);
    expect(
      composition.provider.offerings
        .filter((offering) => offering.form.kind === "ObjectBucket")
        .map((offering) => `${offering.id}:${offering.form.apiVersion}`)
        .sort(),
    ).toEqual([
      "storage.object.stable-v1.standard:edge.forms.takoform.com",
      "storage.object.standard:edge.forms.takoform.com/v1beta1",
    ]);
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
      "ObjectBucket",
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

  test("owns both halves of the object Binding, and fences the export", async () => {
    const composition = await compose(true);
    const pack = composition.providerPacks[0];
    const materializer = pack?.runtimeBindingMaterializer;
    if (!materializer?.exporter || !materializer.importer) {
      throw new Error("the self-host pack must own both halves of the object Binding");
    }
    // Both routes name the same Binding and the same material kind, which is
    // what makes a route resolvable at all.
    const route = resolveRuntimeBindingMaterialRoute({
      bindingRef: EDGE_OBJECTS_BINDING_REF,
      consumer: materializer,
      target: materializer,
    });
    expect(route).toEqual({
      bindingRef: EDGE_OBJECTS_BINDING_REF,
      materialKind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND,
    });
    if (!route) throw new Error("the object Binding route is missing");

    const bucketId = `tsb-${"c".repeat(40)}`;
    const relation = bucketRelation(pack?.id as string, bucketId);
    const exported = await materializer.exporter.exportTarget({
      tenantId: "org_demo",
      relation: relation as never,
      route,
    });
    expect(exported).not.toBeNull();
    const material = await materializer.importer.importBinding({
      tenantId: "org_demo",
      source: { tenantRef: "org_demo", space: "default", name: "hello-v1" },
      sourceSpec: {},
      name: "MEDIA",
      relation: relation as never,
      route,
      exported: {
        providerPackRef: pack?.id as string,
        materialKind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND,
        material: exported,
      },
    });
    expect(material).toEqual({ kind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND, bucketId });

    // A Deployment whose native id does not name the bucket its output claims
    // is not one this pack exports.
    expect(
      await materializer.exporter.exportTarget({
        tenantId: "org_demo",
        relation: {
          ...relation,
          deployment: { ...relation.deployment, nativeId: `local-bucket:${bucketId}` },
        } as never,
        route,
      }),
    ).toBeNull();

    // And a capability this pack did not export cannot be imported, whatever it
    // looks like: the fence is a private symbol, not a shape.
    expect(
      await materializer.importer.importBinding({
        tenantId: "org_demo",
        source: { tenantRef: "org_demo", space: "default", name: "hello-v1" },
        sourceSpec: {},
        name: "MEDIA",
        relation: relation as never,
        route,
        exported: {
          providerPackRef: pack?.id as string,
          materialKind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND,
          material: { providerPackRef: pack?.id, bucketId },
        },
      }),
    ).toBeNull();
  });

  test("keeps the legacy storage-only variant drain-only too", async () => {
    const composition = await compose(false);
    expect(composition.offerings).toEqual([]);
    expect(composition.provider.offerings.map((offering) => offering.id)).toEqual([
      "storage.object.standard",
    ]);
  });
});
