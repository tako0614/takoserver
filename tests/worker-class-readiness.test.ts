import { expect, test } from "bun:test";
import { createCatalog } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { edgeProviderOffering } from "../src/edge-forms.ts";
import { createLedger } from "../src/ledger.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import type { ResourceWithRelations, TakoformStore } from "../src/takoform/store.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { InstalledTakoformForm, TakoformStoredResource } from "../src/takoform/types.ts";
import {
  supportsClassHolderRuntime,
  validateClassHolderRuntime,
  workerClassCondition,
} from "../src/takoform/worker-runtime-contract.ts";
import type {
  WorkerClassInspectionInput,
  WorkerClassRuntime,
} from "../src/worker-class-runtime-port.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const published = stableProductionTakoformCatalog().forms.find(
  (form) => form.identity.formRef.kind === "ActorNamespace",
);
if (!published?.workerClassRuntime) throw new Error("published Actor fixture missing");
// Test-only forward identity. No current package/admission/profile is changed.
const runtimeClassRef = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.actor",
  version: "2.0.0",
  schemaDigest: `sha256:${"d".repeat(64)}`,
} as const;
const form: InstalledTakoformForm = {
  ...published,
  identity: {
    formRef: {
      ...published.identity.formRef,
      definitionVersion: "0.2.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    packageDigest: `sha256:${"b".repeat(64)}`,
    implementationDigest: `sha256:${"f".repeat(64)}`,
  },
  providedInterfaces: [runtimeClassRef],
  workerClassRuntime: { ...published.workerClassRuntime, runtimeClassRef },
};
const contract = {
  formRef: form.identity.formRef,
  packageDigest: form.identity.packageDigest as `sha256:${string}`,
  runtimeClassRef,
};

function fixture() {
  const rows = new Map<string, ResourceWithRelations>();
  const resource = (
    kind: string,
    uid: string,
    spec: TakoformStoredResource["spec"],
  ): TakoformStoredResource => ({
    apiVersion: "edge.forms.takoform.com",
    kind,
    form:
      kind === "ActorNamespace" ? form.identity : { formRef: { ...form.identity.formRef, kind } },
    metadata: { uid, name: uid, space: "main", generation: "1", revision: "1" },
    spec,
    status: { observedGeneration: "1", conditions: [] },
  });
  const holder = resource("ActorNamespace", "holder", {
    className: "Counter",
    worker: { apiVersion: "edge.forms.takoform.com", kind: "ModuleWorker", name: "worker" },
  });
  const worker = resource("ModuleWorker", "worker", {});
  const bundle = resource("WorkerBundle", "bundle", { manifestDigest: `sha256:${"c".repeat(64)}` });
  const versionA = resource("WorkerVersion", "version-a", {});
  const versionB = resource("WorkerVersion", "version-b", {});
  const deployment = resource("WorkerDeployment", "deployment", {
    versions: [{ weight: 5_000 }, { weight: 5_000 }],
  });
  const relation = (target: TakoformStoredResource, pointer: string, name = pointer) => ({
    pointer,
    relation: name,
    targetUid: target.metadata.uid,
    targetApiVersion: target.apiVersion,
    targetKind: target.kind,
    targetName: target.metadata.name,
    targetFormRef: target.form.formRef,
  });
  const add = (
    value: TakoformStoredResource,
    relations: ResourceWithRelations["relations"] = [],
  ) => {
    rows.set(value.metadata.uid, {
      listing: {
        ...value.metadata,
        apiVersion: value.apiVersion,
        kind: value.kind,
        updatedAt: "2026-09-27T00:00:00.000Z",
        resource: value,
      },
      relations,
    });
  };
  add(holder, [relation(worker, "/worker")]);
  add(worker);
  add(bundle);
  add(versionA, [relation(worker, "/worker"), relation(bundle, "/bundle")]);
  add(versionB, [relation(worker, "/worker"), relation(bundle, "/bundle")]);
  add(deployment, [
    relation(worker, "/worker"),
    relation(versionA, "/versions/0/workerVersion", "/versions/*/workerVersion"),
    relation(versionB, "/versions/1/workerVersion", "/versions/*/workerVersion"),
  ]);
  const store: Pick<TakoformStore, "resourceWithRelationsByUid" | "resourcesByRelation"> = {
    async resourceWithRelationsByUid(tenant, uid) {
      return tenant === "tenant" ? structuredClone(rows.get(uid) ?? null) : null;
    },
    async resourcesByRelation(input) {
      if (input.tenantId !== "tenant") return [];
      const found = rows.get("deployment");
      return found
        ? [
            {
              resource: structuredClone(found.listing.resource),
              relations: structuredClone(found.relations),
            },
          ]
        : [];
    },
  };
  const calls: WorkerClassInspectionInput[] = [];
  const runtime: WorkerClassRuntime = {
    contracts: [contract],
    async inspect(input) {
      calls.push(...input);
      return "valid";
    },
  };
  return {
    rows,
    holder,
    deployment,
    calls,
    runtime,
    input: { tenantId: "tenant", resource: holder, form, store, runtime },
  };
}

test("class allocation requires exact explicit ABI capability; existing inferred ABI stays denied", () => {
  const { runtime } = fixture();
  expect(() => validateClassHolderRuntime(form, runtime)).not.toThrow();
  expect(supportsClassHolderRuntime(form)).toBe(false);
  expect(
    supportsClassHolderRuntime(published, { contracts: [{ ...contract, ...published.identity }] }),
  ).toBe(false);
  for (const changed of [
    { ...contract, packageDigest: `sha256:${"e".repeat(64)}` as const },
    { ...contract, formRef: { ...contract.formRef, definitionVersion: "0.3.0" } },
    { ...contract, runtimeClassRef: { ...runtimeClassRef, version: "2.0.1" } },
  ])
    expect(supportsClassHolderRuntime(form, { contracts: [changed] })).toBe(false);
});

test("Host allocates the explicit class identity without a deployment and overrides an optimistic provider receipt", async () => {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-09-27T00:00:00.000Z");
  const store = createTakoformStore(sql, clock);
  const { runtime, calls } = fixture();
  const memory = new InMemoryTakoformResourceDriver();
  const apply = memory.apply.bind(memory);
  const driver = Object.assign(memory, {
    workerClassRuntime: runtime,
    async apply(input: Parameters<typeof apply>[0]) {
      return {
        ...(await apply(input)),
        conditions: [
          {
            type: "Ready" as const,
            status: "True" as const,
            reason: "Available" as const,
            lastTransitionTime: clock().toISOString(),
          },
        ],
      };
    },
  });
  const workerForm = stableProductionTakoformCatalog().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  if (!workerForm) throw new Error("worker fixture missing");
  const host = createStaticStableTestTakoformHost({
    sql,
    clock,
    objects: createMemoryObjectStore(),
    forms: [workerForm, form],
    driver,
    authenticate: async () => ({ tenantId: "tenant", principalId: "principal" }),
  });
  const lane = "/apis/forms.takoform.com/v1";
  for (const [selected, name, spec] of [
    [workerForm, "worker", {}],
    [
      form,
      "holder",
      {
        className: "Counter",
        worker: {
          apiVersion: workerForm.identity.formRef.apiVersion,
          kind: "ModuleWorker",
          name: "worker",
        },
      },
    ],
  ] as const) {
    const body = {
      apiVersion: selected.identity.formRef.apiVersion,
      kind: selected.identity.formRef.kind,
      form: { formRef: selected.identity.formRef },
      metadata: { name, space: "main" },
      spec,
    };
    const prepared = await host.handle(
      new Request(`https://host.test${lane}/resources/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(prepared?.status).toBe(200);
    const review = (await prepared?.json()) as { review: unknown };
    const response = await host.handle(
      new Request(`https://host.test${lane}/resources/${body.apiVersion}/${body.kind}/${name}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "if-none-match": "*",
          "idempotency-key": `create-${name}`,
        },
        body: JSON.stringify({ ...body, review: review.review }),
      }),
    );
    if (response?.status !== 201)
      throw new Error(`${name}: ${response?.status} ${await response?.text()}`);
    expect(response.status).toBe(201);
  }
  const holder = await store.readResource({
    tenantId: "tenant",
    space: "main",
    apiVersion: form.identity.formRef.apiVersion,
    kind: "ActorNamespace",
    name: "holder",
  });
  expect(holder?.status.conditions).toEqual([
    {
      type: "Ready",
      status: "False",
      reason: "Provisioning",
      lastTransitionTime: clock().toISOString(),
    },
  ]);
  expect(calls).toHaveLength(0);
});

test("readiness requires isolated inspection of every weighted exact Version and artifact", async () => {
  const { input, calls } = fixture();
  expect(await workerClassCondition(input)).toMatchObject({ status: "True", reason: "Available" });
  expect(calls.map((call) => [call.version.uid, call.weight])).toEqual([
    ["version-a", 5_000],
    ["version-b", 5_000],
  ]);
  expect(
    calls.every(
      (call) =>
        call.bundle.manifestDigest === `sha256:${"c".repeat(64)}` &&
        call.className === "Counter" &&
        call.contract.runtimeClassRef.schemaDigest === runtimeClassRef.schemaDigest,
    ),
  ).toBe(true);
});

test("provider inspection binds holder and Version to the same actual installation", async () => {
  for (const installation of ["same", "foreign"] as const) {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-09-27T00:00:00.000Z");
    const deployments = createResourceDeploymentStore(sql, clock);
    const { input, calls } = fixture();
    await workerClassCondition(input);
    const inspection = calls[0];
    if (!inspection) throw new Error("inspection missing");
    const actorOffering = edgeProviderOffering(form, { id: "actor-test" });
    const versionOffering = {
      ...actorOffering,
      id: "version-test",
      form: inspection.version.formRef,
    };
    let inspected = 0;
    const provider = Object.assign(
      new FakeProvider({ id: "fake", offerings: [actorOffering, versionOffering] }),
      {
        workerClassRuntime: {
          contracts: [contract],
          async inspect(
            value: import("../src/worker-class-runtime-port.ts").WorkerClassInspectionInput & {
              holderNativeId: string;
              versionNativeId: string;
            },
          ) {
            inspected += 1;
            expect(value.holderNativeId).toBe("actor-native");
            expect(value.versionNativeId).toBe("version-native");
            return "valid" as const;
          },
        },
      },
    );
    for (const [uid, offeringId, nativeId, providerInstallationRef] of [
      [inspection.holder.uid, actorOffering.id, "actor-native", "same"],
      [inspection.version.uid, versionOffering.id, "version-native", installation],
    ]) {
      if (!uid || !offeringId || !nativeId || !providerInstallationRef)
        throw new Error("deployment fixture missing");
      await deployments.create({
        tenantId: "tenant",
        id: `deployment-${uid}`,
        resourceUid: uid,
        offeringId,
        providerPackRef: "fake",
        providerInstallationRef,
        nativeId,
        state: "active",
        observed: {},
        outputs: {},
      });
    }
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([]),
      ledger: createLedger(sql, clock),
      deployments,
    });
    expect(await driver.workerClassRuntime?.inspect([inspection])).toBe(
      installation === "same" ? "valid" : "unavailable",
    );
    expect(inspected).toBe(installation === "same" ? 1 : 0);
  }
});

test("a later Version inspection cannot bless an earlier changed placement", async () => {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-09-27T00:00:00.000Z");
  const deployments = createResourceDeploymentStore(sql, clock);
  const { input, calls } = fixture();
  await workerClassCondition(input);
  const first = calls[0];
  if (!first) throw new Error("inspection missing");
  const actorOffering = edgeProviderOffering(form, { id: "actor-test" });
  const versionOffering = { ...actorOffering, id: "version-test", form: first.version.formRef };
  for (const [uid, offeringId] of [
    [first.holder.uid, actorOffering.id],
    ...calls.map((call) => [call.version.uid, versionOffering.id]),
  ]) {
    if (!uid || !offeringId) throw new Error("deployment fixture missing");
    await deployments.create({
      tenantId: "tenant",
      id: `deployment-${uid}`,
      resourceUid: uid,
      offeringId,
      providerPackRef: "fake",
      providerInstallationRef: "same",
      nativeId: `native-${uid}`,
      state: "active",
      observed: {},
      outputs: {},
    });
  }
  let inspected = 0;
  const provider = Object.assign(
    new FakeProvider({ id: "fake", offerings: [actorOffering, versionOffering] }),
    {
      workerClassRuntime: {
        contracts: [contract],
        async inspect(value: WorkerClassInspectionInput) {
          inspected += 1;
          if (value.version.uid === "version-b") {
            expect(
              await deployments.replaceNative({
                tenantId: "tenant",
                deploymentId: "deployment-version-a",
                expectedNativeId: "native-version-a",
                nativeId: "replacement-version-a",
                observed: {},
                outputs: {},
              }),
            ).toBe(true);
          }
          return "valid" as const;
        },
      },
    },
  );
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog([]),
    ledger: createLedger(sql, clock),
    deployments,
  });
  expect(await driver.workerClassRuntime?.inspect(calls)).toBe("unavailable");
  expect(inspected).toBe(2);
});

test("allocation without a deployment is not Ready and does not inspect", async () => {
  const { input, rows, calls } = fixture();
  rows.delete("deployment");
  expect(await workerClassCondition(input)).toMatchObject({
    status: "False",
    reason: "Provisioning",
  });
  expect(calls).toHaveLength(0);
});

test("one invalid or unavailable class refuses the entire weighted set", async () => {
  for (const verdict of ["invalid", "unavailable"] as const) {
    const { input, runtime } = fixture();
    const result = await workerClassCondition({
      ...input,
      runtime: {
        ...runtime,
        async inspect(value) {
          return value.some((version) => version.version.uid === "version-b") ? verdict : "valid";
        },
      },
    });
    expect(result?.status).toBe("False");
  }
  const { input, runtime } = fixture();
  expect(
    await workerClassCondition({
      ...input,
      runtime: {
        ...runtime,
        async inspect() {
          throw new Error("secret diagnostic must not leak");
        },
      },
    }),
  ).toMatchObject({
    type: "Ready",
    status: "False",
    reason: "Provisioning",
    hostReason: "BackendUnavailable",
  });
});

test("stale graph, removed holder, foreign target and invalid weights never become Ready", async () => {
  for (const change of ["version", "bundle", "holder", "foreign", "weight"] as const) {
    const { input, rows, runtime } = fixture();
    let mutated = false;
    const result = await workerClassCondition({
      ...input,
      runtime: {
        ...runtime,
        async inspect() {
          if (!mutated) {
            mutated = true;
            if (change === "holder") rows.delete("holder");
            else {
              const row = rows.get(
                change === "version" ? "version-b" : change === "weight" ? "deployment" : "bundle",
              );
              if (!row) throw new Error("row missing");
              const current = row.listing.resource;
              const changed = {
                ...current,
                metadata: {
                  ...current.metadata,
                  ...(change === "foreign" ? { space: "foreign" } : { revision: "2" }),
                },
                ...(change === "weight"
                  ? { spec: { versions: [{ weight: 10_000 }, { weight: 0 }] } }
                  : {}),
              };
              rows.set(current.metadata.uid, {
                ...row,
                listing: { ...row.listing, resource: changed },
              });
            }
          }
          return "valid";
        },
      },
    });
    expect(result?.status).toBe("False");
  }
});
