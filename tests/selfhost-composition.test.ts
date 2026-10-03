import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalog } from "../src/catalog.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { createProviderDriver, createProviderFormAvailability } from "../src/provider-driver.ts";
import type { Provider, ProviderRelation } from "../src/provider-port.ts";
import { resolveRuntimeBindingMaterialRoute } from "../src/provider-runtime-bindings.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import { derivedProviderResourceName } from "../src/provider-worker-endpoint-origin.ts";
import { EDGE_OBJECTS_BINDING_REF } from "../src/providers/cloudflare-runtime-bindings.ts";
import {
  SELFHOST_ACTOR_BINDING_REF,
  type SelfhostProviderOptions,
  selfhostScriptStateRoot,
} from "../src/providers/selfhost.ts";
import type { SelfhostContainerCapability } from "../src/providers/selfhost-container-lifecycle.ts";
import { SELFHOST_EDGE_OBJECTS_MATERIAL_KIND } from "../src/providers/selfhost-runtime-bindings.ts";
import { createSelfhostScriptStateStore } from "../src/providers/selfhost-script-state.ts";
import { openSelfhostActorPublicRuntime } from "../src/selfhost-actor-public-runtime.ts";
import { createSelfhostComposition } from "../src/selfhost-composition.ts";
import { SELFHOST_ACTOR_MATERIAL_KIND } from "../src/selfhost-runtime-binding-materializer.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";
import { loadVerifiedLocalContainerCandidate } from "./fixtures/selfhost-container-host-authority.ts";

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
  async inspectModule(input) {
    return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
  },
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

async function compose(
  edgeForms: boolean,
  runtimeInputs?: ProviderRuntimeInputLeasePort,
  workerRuntimeAvailable?: boolean,
  stableForms = stableProductionTakoformCatalog().forms,
  runtimeOverride?: WorkerdRuntime,
  container?: SelfhostContainerCapability,
  dataRoot = "/tmp/unused",
  listCronOwners?: SelfhostProviderOptions["listCronOwners"],
) {
  return createSelfhostComposition({
    edge: await buildEdgeForms(),
    stableForms,
    dataRoot,
    runtime: runtimeOverride ?? runtime,
    artifacts: {
      async manifest() {
        return null;
      },
      async blob() {
        return null;
      },
    },
    edgeForms,
    ...(container ? { container } : {}),
    ...(listCronOwners ? { listCronOwners } : {}),
    ...(runtimeInputs ? { runtimeInputs } : {}),
    ...(workerRuntimeAvailable === undefined ? {} : { workerRuntimeAvailable }),
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
  test("adds local Actor only with an owned runtime and exact released closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-composition-"));
    const released = stableProductionTakoformCatalog();
    const actorRuntime = await openSelfhostActorPublicRuntime({
      dataRoot: root,
      runtimeRoot: root,
      socketParent: join(root, "sockets"),
      binary: "/never-execute",
      graph: async () => null,
      deployments: { active: async () => null },
      providerPackRef: "local",
      providerInstallationRef: "local.primary",
    });
    const options = {
      edge: await buildEdgeForms(),
      stableForms: released.forms,
      stableBindings: released.bindings,
      dataRoot: root,
      runtime,
      artifacts: { manifest: async () => null, blob: async () => null },
      edgeForms: true,
      now: new Date("2026-10-03T00:00:00.000Z"),
    };
    try {
      expect(
        createSelfhostComposition(options).offerings.some(
          (item) => item.form.kind === "ActorNamespace",
        ),
      ).toBe(false);
      const composed = createSelfhostComposition({ ...options, actorRuntime });
      const actor = composed.offerings.find((item) => item.form.kind === "ActorNamespace");
      expect(actor).toMatchObject({
        id: "compute.actor.stable-v1.standard",
        resourceClass: "compute.actor",
        providerPackRef: "local",
        providerInstallationRef: "local.primary",
        pricePlan: {
          currency: "USD",
          provisioning: { meter: "resource.create", amountMinor: 0 },
          meters: [],
        },
      });
      expect(actor?.pricePlan?.meters).toEqual([]);
      expect(
        resolveRuntimeBindingMaterialRoute({
          bindingRef: SELFHOST_ACTOR_BINDING_REF,
          consumer: composed.providerPacks[0]?.runtimeBindingMaterializer,
          target: composed.providerPacks[0]?.runtimeBindingMaterializer,
        }),
      ).toEqual({
        bindingRef: SELFHOST_ACTOR_BINDING_REF,
        materialKind: SELFHOST_ACTOR_MATERIAL_KIND,
      });
      const tampered = released.forms.map((item) =>
        item.identity.formRef.kind === "ActorNamespace"
          ? {
              ...item,
              identity: { ...item.identity, packageDigest: `sha256:${"0".repeat(64)}` as const },
            }
          : item,
      );
      expect(() =>
        createSelfhostComposition({ ...options, stableForms: tampered, actorRuntime }),
      ).toThrow("Actor closure");
    } finally {
      await actorRuntime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test("does not advertise Worker execution when the pinned runtime is unavailable", async () => {
    const composition = await compose(true, undefined, false);
    expect(composition.offerings.map((offering) => offering.form.kind).sort()).toEqual([
      "AtLeastOnceQueue",
      "EdgeKVNamespace",
      "SQLiteDatabase",
    ]);
    const workerKinds = new Set([
      "ModuleWorker",
      "WorkerVersion",
      "WorkerDeployment",
      "WorkerCustomDomain",
      "WorkerEndpoint",
      "WorkerCronTrigger",
      "QueueConsumer",
    ]);
    expect(
      composition.provider.offerings.some((offering) => workerKinds.has(offering.form.kind)),
    ).toBe(false);
  });

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

  test("composes readback authority only for relation Forms with sellable anchors", async () => {
    const composition = await compose(true);
    const authorities = composition.provider.nativeReadbackAuthorities ?? [];
    expect(authorities.map((authority) => authority.offeringId).sort()).toEqual([
      "selfhost.edge.queueconsumer",
      "selfhost.edge.stable-v1.queueconsumer",
      "selfhost.edge.stable-v1.workercrontrigger",
      "selfhost.edge.stable-v1.workercustomdomain",
      "selfhost.edge.stable-v1.workerdeployment",
      "selfhost.edge.stable-v1.workerendpoint",
      "selfhost.edge.stable-v1.workerversion",
      "selfhost.edge.workercrontrigger",
      "selfhost.edge.workercustomdomain",
      "selfhost.edge.workerdeployment",
      "selfhost.edge.workerendpoint",
      "selfhost.edge.workerversion",
    ]);
    const tuples = authorities.map((authority) =>
      [
        authority.offeringId,
        authority.providerInstallationRef,
        authority.form.apiVersion,
        authority.form.kind,
        authority.form.definitionVersion,
        authority.form.schemaDigest,
      ].join("\u0000"),
    );
    expect(new Set(tuples).size).toBe(authorities.length);
    for (const authority of authorities) {
      expect(authority.providerInstallationRef).toBe("local.primary");
      expect(
        composition.provider.offerings.find((offering) => offering.id === authority.offeringId)
          ?.form,
      ).toEqual(authority.form);
    }

    const stableForms = stableProductionTakoformCatalog().forms;
    const withoutWorker = await compose(
      true,
      undefined,
      undefined,
      stableForms.filter((form) => form.identity.formRef.kind !== "ModuleWorker"),
    );
    expect(withoutWorker.provider.nativeReadbackAuthorities).toEqual([]);

    const withoutQueue = await compose(
      true,
      undefined,
      undefined,
      stableForms.filter((form) => form.identity.formRef.kind !== "AtLeastOnceQueue"),
    );
    expect(
      withoutQueue.provider.nativeReadbackAuthorities?.some(
        (authority) => authority.form.kind === "QueueConsumer",
      ),
    ).toBe(false);
    expect(
      withoutQueue.provider.nativeReadbackAuthorities?.some(
        (authority) => authority.form.kind === "WorkerVersion",
      ),
    ).toBe(true);

    const runtimeUnavailable = await compose(true, undefined, false);
    expect(runtimeUnavailable.provider.nativeReadbackAuthorities).toEqual([]);
  });

  test("lets the driver invoke a technical relation readback through its authority", async () => {
    const servingGraph = new Map([["worker", new Set(["v2"])]]);
    const publicationReadbacks: {
      name: string;
      subject: Parameters<NonNullable<WorkerdRuntime["observePublication"]>>[1];
    }[] = [];
    const readbackRuntime: WorkerdRuntime = {
      ...runtime,
      async observePublication(name, subject) {
        publicationReadbacks.push({ name, subject });
        const versions = servingGraph.get(name);
        if (!versions || subject?.kind !== "version") return "unknown";
        return versions.has(subject.versionId) ? "present" : "absent";
      },
    };
    const composition = await compose(true, undefined, undefined, undefined, readbackRuntime);
    const version = composition.provider.offerings.find(
      (offering) => offering.id === "selfhost.edge.stable-v1.workerversion",
    );
    if (!version) throw new Error("stable WorkerVersion offering missing");
    const nativeId = "selfhost-version:worker:v1";
    const resourceUid = "uid-version-v1";
    const deployment = {
      tenantId: "org_demo",
      id: "dep-version-v1",
      resourceUid,
      offeringId: version.id,
      providerPackRef: composition.provider.id,
      providerInstallationRef: "local.primary",
      nativeId,
      nativeClaimed: false,
      state: "deleted" as const,
      observed: {},
      outputs: {
        __takoserver: {
          resourceUid,
          space: "default",
          name: "version-v1",
          generation: "1",
        },
      },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    const tombstone = {
      tenantId: "org_demo",
      resourceUid,
      address: {
        tenantId: "org_demo",
        space: "default",
        apiVersion: version.form.apiVersion,
        kind: version.form.kind,
        name: "version-v1",
      },
      formRef: version.form,
      state: "closed" as const,
      closureFence: 1,
      effects: [
        {
          operationId: "op-version-delete",
          kind: "delete" as const,
          phase: "succeeded" as const,
          operationMode: "initial" as const,
          providerPackRef: composition.provider.id,
          providerInstallationRef: "local.primary",
          nativeId,
        },
      ],
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    let readbacks = 0;
    const provider: Provider = {
      ...composition.provider,
      async verifyNativeAbsence(input) {
        readbacks += 1;
        if (!composition.provider.verifyNativeAbsence) {
          throw new Error("self-host provider readback is unavailable");
        }
        return await composition.provider.verifyNativeAbsence(input);
      },
    };
    const driver = createProviderDriver({
      providers: [provider],
      providerPacks: composition.providerPacks,
      catalog: createCatalog(composition.offerings),
      ledger: {} as never,
      deployments: {
        async forResource() {
          return [deployment];
        },
      } as never,
      deletions: {
        async readResourceDeletion() {
          return tombstone;
        },
        async cacheResourceDeletionEvidence() {
          return true;
        },
      } as never,
    });
    if (!driver.verifyNativeAbsence) throw new Error("provider driver readback is unavailable");
    const evidence = await driver.verifyNativeAbsence({
      tenantId: "org_demo",
      resourceUid,
      space: "default",
      name: "version-v1",
    });
    expect(readbacks).toBe(1);
    expect(publicationReadbacks).toEqual([
      { name: "worker", subject: { kind: "version", versionId: "v1" } },
    ]);
    expect(evidence).toMatchObject({
      status: "absent",
      source: "provider",
      effectCount: 1,
      deploymentCount: 1,
    });
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

  test("forwards legacy Cron rehydration through the self-host composition", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "selfhost-cron-composition-"));
    try {
      const tenantRef = "tenant-cron-composition";
      const space = "main";
      const workerName = "worker";
      const workerUid = "uid-worker-composition";
      const legacyOwner = { resourceUid: "uid-legacy-cron", cron: "0 * * * *" } as const;
      const script = await derivedProviderResourceName("sw", {
        tenantRef,
        space,
        name: workerName,
      });
      const stateStore = createSelfhostScriptStateStore({
        root: selfhostScriptStateRoot(dataRoot),
      });
      await stateStore.write(script, null, { domains: [], crons: [legacyOwner.cron] });

      const lookups: Parameters<NonNullable<SelfhostProviderOptions["listCronOwners"]>>[0][] = [];
      const composition = await compose(
        true,
        undefined,
        undefined,
        stableProductionTakoformCatalog().forms,
        undefined,
        undefined,
        dataRoot,
        async (input) => {
          lookups.push(input);
          return { complete: true, owners: [legacyOwner] };
        },
      );
      const edge = await buildEdgeForms();
      const offering = composition.provider.offerings.find(
        (candidate) =>
          candidate.form.apiVersion === "edge.forms.takoform.com/v1beta1" &&
          candidate.form.kind === "WorkerCronTrigger",
      );
      const workerForm = edge.forms.find((form) => form.identity.formRef.kind === "ModuleWorker");
      if (!offering || !workerForm)
        throw new Error("released self-host Cron capability is required");

      const result = await composition.provider.apply({
        operationId: "op_composed_legacy_cron_rehydrate",
        offering,
        identity: {
          tenantRef,
          space,
          name: "cron-new",
          uid: "uid-new-cron",
        },
        spec: { cron: "15 * * * *" },
        relations: [
          {
            pointer: "/worker",
            relation: "/worker",
            targetUid: workerUid,
            resource: {
              apiVersion: workerForm.identity.formRef.apiVersion,
              kind: workerForm.identity.formRef.kind,
              form: { formRef: workerForm.identity.formRef },
              metadata: {
                name: workerName,
                space,
                uid: workerUid,
                generation: "1",
                revision: "1",
              },
              spec: {},
            },
          },
        ],
      });

      // The fixture has no event-capable Deployment, so provider mutation is
      // refused after the read-only rehydration lookup and the legacy bytes stay.
      expect(result).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
      expect(lookups).toEqual([
        {
          tenantRef,
          space,
          workerResourceUid: workerUid,
          form: offering.form,
          limit: 65,
        },
      ]);
      expect((await stateStore.read(script)).state).toEqual({
        domains: [],
        crons: [legacyOwner.cron],
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
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

  test("self-host Cron technical offerings do not advertise native import", async () => {
    const composition = await compose(true);
    const cronOfferings = composition.provider.offerings.filter(
      (offering) => offering.form.kind === "WorkerCronTrigger",
    );

    expect(cronOfferings).toHaveLength(2);
    expect(cronOfferings.map((offering) => offering.form.apiVersion).sort()).toEqual([
      "edge.forms.takoform.com",
      "edge.forms.takoform.com/v1beta1",
    ]);
    for (const offering of cronOfferings) {
      expect(offering.capabilities).not.toContain("import");
    }
  });

  test("advertises a runtime-input ceiling only when a sealed lease port exists", async () => {
    const unconfigured = await compose(true);
    expect(unconfigured.provider.runtimeInputCapabilities).toBeUndefined();

    const configured = await compose(true, leases);
    expect(configured.provider.runtimeInputCapabilities).toEqual({
      maximumBindings: 64,
      forms: configured.provider.offerings
        .filter((offering) => offering.form.kind === "WorkerVersion")
        .map((offering) => offering.form),
    });
  });

  test("offers only the exact reviewed local unpublished ContainerService package", async () => {
    const candidate = await loadVerifiedLocalContainerCandidate(
      join(import.meta.dir, "fixtures/selfhost-container-service-candidate.json"),
    );
    const form = candidate.form;
    const nativeCalls: string[] = [];
    const container: SelfhostContainerCapability = {
      capacityProfile: {
        id: "selfhost.container.http.standard",
        memoryBytes: 256 * 1024 * 1024,
        nanoCpus: 500_000_000,
        pidsLimit: 128,
      },
      runtime: {
        async reconcile() {
          nativeCalls.push("reconcile");
          throw new Error("composition must not reach native runtime");
        },
        async observe() {
          nativeCalls.push("observe");
          throw new Error("composition must not reach native runtime");
        },
        async fetch() {
          nativeCalls.push("fetch");
          throw new Error("composition must not reach native runtime");
        },
        async remove() {
          nativeCalls.push("remove");
          throw new Error("composition must not reach native runtime");
        },
        async close() {},
      },
    };
    const forms = [...stableProductionTakoformCatalog().forms, form];
    const exact = await compose(true, undefined, true, forms, undefined, container);
    expect(
      exact.offerings.filter((offering) => offering.form.kind === "ContainerService"),
    ).toHaveLength(1);
    expect(
      (await compose(true, undefined, true, forms)).offerings.some(
        (offering) => offering.form.kind === "ContainerService",
      ),
    ).toBe(false);
    expect(
      (await compose(true, undefined, true, undefined, undefined, container)).offerings.some(
        (offering) => offering.form.kind === "ContainerService",
      ),
    ).toBe(false);

    const changedSchema = {
      ...form,
      identity: {
        ...form.identity,
        formRef: {
          ...form.identity.formRef,
          schemaDigest: `sha256:${"f".repeat(64)}` as const,
        },
      },
    };
    const changedPackage = {
      ...form,
      identity: {
        ...form.identity,
        packageDigest: `sha256:${"e".repeat(64)}` as const,
      },
    };
    await expect(
      compose(
        true,
        undefined,
        true,
        [...stableProductionTakoformCatalog().forms, changedSchema],
        undefined,
        container,
      ),
    ).rejects.toThrow();
    await expect(
      compose(
        true,
        undefined,
        true,
        [...stableProductionTakoformCatalog().forms, changedPackage],
        undefined,
        container,
      ),
    ).rejects.toThrow();
    expect(nativeCalls).toEqual([]);
  });

  test("projects that ceiling into the WorkerVersion support profile the provider reads", async () => {
    const workerVersion = stableProductionTakoformCatalog().forms.find(
      (form) =>
        form.identity.formRef.apiVersion === "edge.forms.takoform.com" &&
        form.identity.formRef.kind === "WorkerVersion",
    );
    if (!workerVersion) throw new Error("the stable WorkerVersion Form is missing");
    const objectBucket = stableProductionTakoformCatalog().forms.find(
      (form) =>
        form.identity.formRef.apiVersion === "edge.forms.takoform.com" &&
        form.identity.formRef.kind === "ObjectBucket",
    );
    if (!objectBucket) throw new Error("the stable ObjectBucket Form is missing");

    const policyFor = (provider: Provider) =>
      createProviderDriver({
        providers: [provider],
        catalog: {
          list: () => provider.offerings,
          async digest() {
            return `sha256:${"a".repeat(64)}` as const;
          },
          findOffering: () => undefined,
          offeringsFor: () => [],
        } as never,
        deployments: {} as never,
        ledger: {} as never,
      }).runtimeInputPolicy;

    for (const [runtimeInputs, expected] of [
      [undefined, 0],
      [leases, 64],
    ] as const) {
      const composition = await compose(true, runtimeInputs);
      const policy = policyFor(composition.provider);
      expect(policy?.guaranteedMaximum(workerVersion)).toBe(expected);
      expect(policy?.guaranteedMaximum(objectBucket)).toBe(0);
    }

    const configured = await compose(true, leases);
    const legacyProvider: Provider = {
      ...configured.provider,
      runtimeInputCapabilities: { maximumBindings: 64 },
    };
    expect(policyFor(legacyProvider)?.guaranteedMaximum(objectBucket)).toBe(64);
    const wrongSchemaProvider: Provider = {
      ...configured.provider,
      runtimeInputCapabilities: {
        maximumBindings: 64,
        forms: [
          {
            ...workerVersion.identity.formRef,
            schemaDigest: `sha256:${"0".repeat(64)}`,
          },
        ],
      },
    };
    expect(policyFor(wrongSchemaProvider)?.guaranteedMaximum(workerVersion)).toBe(0);
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
