import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TakoformInterfaceRef } from "../src/interface-ref.ts";
import {
  createSelfhostVersionBindingStore,
  deriveSelfhostActorForwardToken,
  deriveSelfhostWorkflowBindingToken,
  normalizeSelfhostVersionBindingSet,
  type SelfhostVersionBindingSet,
  type SelfhostVersionBindingStore,
} from "../src/providers/selfhost-version-bindings.ts";

/**
 * The environment of one immutable Worker Version, kept outside the version
 * directory whose digest means "the bytes the tenant committed". A sensitive
 * value can live here, so the file's permissions and the shape of its digest
 * are part of the contract, not an implementation detail.
 */

let root: string;
let store: SelfhostVersionBindingStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-version-bindings-"));
  store = createSelfhostVersionBindingStore({ root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SET = {
  workerResourceUid: "uid-ModuleWorker-hello",
  handlers: ["fetch" as const],
  vars: [{ name: "LANE", value: "takoform-v1", kind: "text" as const }],
  sensitiveVars: [{ name: "ENCRYPTION_KEY", value: "placeholder-secret", kind: "text" as const }],
  serviceBindings: [],
};

const MARKER = {
  tenantId: "tenant-a",
  operationId: "operation-a",
  operationKey: "operation-key-a",
  resourceUid: "uid-WorkerVersion-hello",
  workerResourceUid: "uid-ModuleWorker-hello",
  space: "default",
  workerName: "hello",
  bundleName: "bundle",
  generation: "abcdefghijklmnop",
} as const;

test("Actor token derivation preserves the exact immutable Version credential bytes", () => {
  expect(
    deriveSelfhostActorForwardToken({
      eventToken: Buffer.alloc(32, 1).toString("base64url"),
      workerVersionResourceUid: "uid-version-caller",
      binding: {
        name: "ROOMS",
        tenantId: "tenant-one",
        namespaceResourceUid: "uid-namespace-one",
        workerResourceUid: "uid-worker-holder",
        className: "Counter",
      },
    }),
  ).toBe("129b7349e463ec89882fb19658998f79bfcf2d4252bb6f48a319ccbb70c5e5a2");
});

test("Actor metadata is a strict new private Version record and cannot adopt an older token", async () => {
  const actor = {
    ...SET,
    sensitiveVars: [],
    workerVersionResourceUid: "uid-WorkerVersion-actor",
    actorBindings: [
      {
        name: "COUNTER",
        tenantId: "tenant-a",
        namespaceResourceUid: "uid-ActorNamespace-counter",
        workerResourceUid: "uid-ModuleWorker-counter",
        className: "Counter",
      },
    ],
  };
  const stored = await store.write("sw-actor", "v-actor", actor);
  expect(stored.actorBindings).toEqual(actor.actorBindings);
  expect(stored.workerVersionResourceUid).toBe(actor.workerVersionResourceUid);
  const path = join(root, "sw-actor", "v-actor.json");
  const bytes = await readFile(path, "utf8");
  expect(JSON.parse(bytes).format).toBe("takoserver.selfhost-version-bindings@v8");
  expect((await store.write("sw-actor", "v-actor", actor)).eventToken).toBe(stored.eventToken);
  await store.write("sw-old", "v-old", SET);
  const oldBytes = await readFile(join(root, "sw-old", "v-old.json"), "utf8");
  expect((await store.read("sw-old", "v-old"))?.actorBindings).toBeUndefined();
  await expect(store.write("sw-old", "v-old", actor)).rejects.toThrow();
  expect(await readFile(join(root, "sw-old", "v-old.json"), "utf8")).toBe(oldBytes);
  expect(() =>
    normalizeSelfhostVersionBindingSet({
      ...actor,
      actorBindings: actor.actorBindings.map((binding) => ({ ...binding, name: "LANE" })),
    }),
  ).toThrow();
  await expect(
    store.write("sw-unreadable", "v-unreadable", {
      ...actor,
      sensitiveVars: SET.sensitiveVars,
    }),
  ).rejects.toThrow();
  expect(existsSync(join(root, "sw-unreadable", "v-unreadable.json"))).toBe(false);
});

test("Actor runtime InterfaceRefs are retained only in a new immutable V9 binding snapshot", async () => {
  const runtimeClassRef = {
    apiVersion: "interfaces.takoform.com/v1alpha1" as const,
    name: "worker.actor",
    version: "2.0.0",
    schemaDigest:
      "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51" as const,
  };
  const legacy = {
    ...SET,
    sensitiveVars: [],
    workerVersionResourceUid: "uid-WorkerVersion-legacy-actor",
    actorBindings: [
      {
        name: "LEGACY",
        tenantId: "tenant-a",
        namespaceResourceUid: "uid-ActorNamespace-legacy",
        workerResourceUid: "uid-ModuleWorker-legacy",
        className: "LegacyActor",
      },
    ],
  };
  const legacyStored = await store.write("sw-legacy-actor", "v-1", legacy);
  const legacyPath = join(root, "sw-legacy-actor", "v-1.json");
  const legacyBytes = await readFile(legacyPath, "utf8");
  expect(JSON.parse(legacyBytes).format).toBe("takoserver.selfhost-version-bindings@v8");
  expect(legacyStored.actorBindings?.[0]).not.toHaveProperty("runtimeClassRef");
  expect(await store.read("sw-legacy-actor", "v-1")).toEqual(legacyStored);
  expect(await store.write("sw-legacy-actor", "v-1", legacy)).toEqual(legacyStored);
  expect(await readFile(legacyPath, "utf8")).toBe(legacyBytes);

  const candidate = {
    ...SET,
    sensitiveVars: [],
    workerVersionResourceUid: "uid-WorkerVersion-v2-actor",
    actorBindings: [
      ...legacy.actorBindings,
      {
        name: "V2",
        tenantId: "tenant-a",
        namespaceResourceUid: "uid-ActorNamespace-v2",
        workerResourceUid: "uid-ModuleWorker-v2",
        className: "V2Actor",
        runtimeClassRef,
      },
    ],
  };
  const stored = await store.write("sw-v2-actor", "v-1", candidate);
  const path = join(root, "sw-v2-actor", "v-1.json");
  const bytes = await readFile(path, "utf8");
  expect(JSON.parse(bytes).format).toBe("takoserver.selfhost-version-bindings@v9");
  expect(stored.actorBindings?.[0]).not.toHaveProperty("runtimeClassRef");
  expect(stored.actorBindings?.[1]?.runtimeClassRef).toEqual({
    apiVersion: "interfaces.takoform.com/v1alpha1",
    name: "worker.actor",
    version: "2.0.0",
    schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
  });
  expect(Object.isFrozen(stored.actorBindings?.[1]?.runtimeClassRef)).toBe(true);

  runtimeClassRef.version = "changed-after-write";
  expect(
    (await store.read("sw-v2-actor", "v-1"))?.actorBindings?.[1]?.runtimeClassRef?.version,
  ).toBe("2.0.0");
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test("Actor runtime InterfaceRefs reject unknown tuples, extra fields, and accessors before writing", async () => {
  const validRef: TakoformInterfaceRef = {
    apiVersion: "interfaces.takoform.com/v1alpha1" as const,
    name: "worker.actor",
    version: "2.0.0",
    schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
  };
  const candidates = [
    { ...validRef, schemaDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}` },
    { ...validRef, version: "2.0.1" },
    { ...validRef, extra: true },
  ];
  for (const [index, runtimeClassRef] of candidates.entries()) {
    const path = join(root, `sw-invalid-ref-${index}`, "v-1.json");
    await expect(
      store.write(`sw-invalid-ref-${index}`, "v-1", {
        ...SET,
        sensitiveVars: [],
        workerVersionResourceUid: `uid-WorkerVersion-invalid-${index}`,
        actorBindings: [
          {
            name: "ACTOR",
            tenantId: "tenant-a",
            namespaceResourceUid: "uid-ActorNamespace-a",
            workerResourceUid: "uid-ModuleWorker-a",
            className: "Actor",
            runtimeClassRef,
          },
        ],
      } as unknown as SelfhostVersionBindingSet),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(existsSync(path)).toBe(false);
  }

  let getterCalls = 0;
  const accessorRef = Object.defineProperties(
    {},
    {
      apiVersion: { enumerable: true, value: validRef.apiVersion },
      name: { enumerable: true, value: validRef.name },
      version: { enumerable: true, value: validRef.version },
      schemaDigest: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return validRef.schemaDigest;
        },
      },
    },
  ) as unknown as TakoformInterfaceRef;
  await expect(
    store.write("sw-accessor-ref", "v-1", {
      ...SET,
      sensitiveVars: [],
      workerVersionResourceUid: "uid-WorkerVersion-accessor",
      actorBindings: [
        {
          name: "ACTOR",
          tenantId: "tenant-a",
          namespaceResourceUid: "uid-ActorNamespace-a",
          workerResourceUid: "uid-ModuleWorker-a",
          className: "Actor",
          runtimeClassRef: accessorRef,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
  expect(getterCalls).toBe(0);
  expect(existsSync(join(root, "sw-accessor-ref", "v-1.json"))).toBe(false);
});

test("V8 refuses nested runtime InterfaceRefs and an unknown future format stays untouched", async () => {
  const actor = {
    ...SET,
    sensitiveVars: [],
    workerVersionResourceUid: "uid-WorkerVersion-v8-closed",
    actorBindings: [
      {
        name: "ACTOR",
        tenantId: "tenant-a",
        namespaceResourceUid: "uid-ActorNamespace-a",
        workerResourceUid: "uid-ModuleWorker-a",
        className: "Actor",
      },
    ],
  };
  await store.write("sw-v8-closed", "v-1", actor);
  const v8Path = join(root, "sw-v8-closed", "v-1.json");
  const v8 = JSON.parse(await readFile(v8Path, "utf8")) as {
    actorBindings: Array<Record<string, unknown>>;
  };
  v8.actorBindings[0] = {
    ...v8.actorBindings[0],
    runtimeClassRef: {
      apiVersion: "interfaces.takoform.com/v1alpha1",
      name: "worker.actor",
      version: "2.0.0",
      schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
    },
  };
  await writeFile(v8Path, JSON.stringify(v8), "utf8");
  await expect(store.read("sw-v8-closed", "v-1")).rejects.toMatchObject({ code: "corrupt" });

  const futurePath = join(root, "sw-future-format", "v-1.json");
  await store.write("sw-future-format", "v-1", actor);
  const future = JSON.parse(await readFile(futurePath, "utf8")) as Record<string, unknown>;
  future.format = "takoserver.selfhost-version-bindings@v10";
  await writeFile(futurePath, JSON.stringify(future), "utf8");
  const before = await readFile(futurePath, "utf8");
  await expect(store.write("sw-future-format", "v-1", actor)).rejects.toMatchObject({
    code: "corrupt",
  });
  expect(await readFile(futurePath, "utf8")).toBe(before);
});

test("private v8 Actor metadata preserves the published 64-binding bound exactly", async () => {
  const bindings = Array.from({ length: 64 }, (_, index) => ({
    name: `ACTOR_${index}`,
    tenantId: "tenant-a",
    namespaceResourceUid: "uid-ActorNamespace-counter",
    workerResourceUid: "uid-ModuleWorker-counter",
    className: "Counter",
  }));
  const candidate = {
    ...SET,
    vars: [],
    sensitiveVars: [],
    workerVersionResourceUid: "uid-WorkerVersion-sixty-four",
    actorBindings: bindings,
  };
  expect(
    (await store.write("sw-sixty-four", "v-sixty-four", candidate)).actorBindings,
  ).toHaveLength(64);
  expect((await store.read("sw-sixty-four", "v-sixty-four"))?.actorBindings).toHaveLength(64);
  const first = bindings[0];
  if (!first) throw new Error("Actor binding fixture unavailable");
  await expect(
    store.write("sw-sixty-five", "v-sixty-five", {
      ...candidate,
      actorBindings: [...bindings, { ...first, name: "ACTOR_64" }],
    }),
  ).rejects.toThrow();
  expect(existsSync(join(root, "sw-sixty-five", "v-sixty-five.json"))).toBe(false);
});

test("complete external binding envelope is bounded before a runtime write", () => {
  const value = JSON.stringify({ value: "a".repeat(3 * 1024 * 1024) });
  expect(() =>
    normalizeSelfhostVersionBindingSet({
      ...SET,
      externalServices: ["A", "B"].map((name) => ({
        name,
        required: true,
        service: { apiVersion: "standards.takoform.com/v1", protocol: "org.example.service" },
        binding: { kind: "json", value },
      })),
    }),
  ).toThrow();
});

const EXTERNAL_SERVICES = [
  {
    name: "ARCHIVE",
    required: true,
    service: {
      apiVersion: "standards.takoform.com/v1" as const,
      protocol: "com.example.archive",
    },
    binding: {
      kind: "json" as const,
      value: '{"endpoint":"https://archive.example.invalid","token":"secret"}',
    },
  },
  {
    name: "OPTIONAL_CACHE",
    required: false,
    service: {
      apiVersion: "standards.takoform.com/v1" as const,
      protocol: "com.example.cache",
    },
  },
] as const;

const VECTOR_SET = {
  ...SET,
  dataPlane: {
    bindings: [
      {
        kind: "edge.vector" as const,
        name: "EMBEDDINGS",
        scope: { tenantId: "tenant-a", resourceUid: "resource-a" },
      },
    ],
  },
};

const WORKFLOW_BINDING = {
  name: "FULFILLMENT",
  tenantId: "tenant-a",
  workflowResourceUid: "uid-DurableWorkflow-orders",
  workflowFormRef: {
    apiVersion: "edge.forms.takoform.com",
    kind: "DurableWorkflow",
    definitionVersion: "0.2.0",
    schemaDigest: "sha256:a58c885bed4431fbdc6b923059fe3b3bf98f7727578914d2d212552ae97fdc65",
  },
  bindingRef: {
    apiVersion: "bindings.takoform.com/v1alpha2",
    name: "module-worker.workflow",
    version: "3.0.0",
    schemaDigest: "sha256:2b8df3ba036b2781ee3ea8af6603b3de5f09226f4eb1f3385565211cdacc854b",
  },
  runtimeClassRef: {
    apiVersion: "interfaces.takoform.com/v1alpha1",
    name: "worker.workflow",
    version: "3.0.0",
    schemaDigest: "sha256:2584721b4bc9f5feef94b272337c348fb67130de57317afaf84aa7ca55246f69",
  },
} as const;

const WORKFLOW_SET = {
  ...SET,
  sensitiveVars: [],
  workerVersionResourceUid: "uid-WorkerVersion-workflows",
  workflowBindings: [WORKFLOW_BINDING],
};

test("stores an immutable V10 Workflow scope with the exact selected refs", async () => {
  const written = await store.write("sw-workflow", "v-workflow", WORKFLOW_SET);
  const path = join(root, "sw-workflow", "v-workflow.json");
  const before = await readFile(path, "utf8");
  expect(JSON.parse(before).format).toBe("takoserver.selfhost-version-bindings@v10");
  expect(written.workflowBindings).toEqual([WORKFLOW_BINDING]);
  expect(written.workerVersionResourceUid).toBe(WORKFLOW_SET.workerVersionResourceUid);
  expect(Object.isFrozen(written.workflowBindings?.[0]?.workflowFormRef)).toBe(true);
  expect(Object.isFrozen(written.workflowBindings?.[0]?.bindingRef)).toBe(true);
  expect(Object.isFrozen(written.workflowBindings?.[0]?.runtimeClassRef)).toBe(true);
  expect(await store.read("sw-workflow", "v-workflow")).toEqual(written);
  expect(await store.write("sw-workflow", "v-workflow", WORKFLOW_SET)).toEqual(written);
  expect(await readFile(path, "utf8")).toBe(before);

  const mutableInput = structuredClone(WORKFLOW_SET);
  const pending = store.write("sw-workflow-clone", "v-1", mutableInput);
  const inputBinding = mutableInput.workflowBindings[0];
  if (!inputBinding) throw new Error("Workflow fixture is missing");
  Reflect.set(inputBinding, "tenantId", "mutated-after-call");
  expect((await pending).workflowBindings?.[0]?.tenantId).toBe("tenant-a");
});

test("V10 retains existing Actor, Vector, service, and external service projections", async () => {
  const combined = {
    ...WORKFLOW_SET,
    serviceBindings: [
      {
        name: "WORKER",
        target: "worker-target",
        targetResourceUid: "uid-ModuleWorker-target",
      },
    ],
    actorBindings: [
      {
        name: "COUNTER",
        tenantId: "tenant-a",
        namespaceResourceUid: "uid-ActorNamespace-counter",
        workerResourceUid: "uid-ModuleWorker-counter",
        className: "Counter",
        runtimeClassRef: {
          apiVersion: "interfaces.takoform.com/v1alpha1" as const,
          name: "worker.actor",
          version: "2.0.0",
          schemaDigest:
            "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51" as const,
        },
      },
    ],
    externalServices: EXTERNAL_SERVICES,
    dataPlane: VECTOR_SET.dataPlane,
  };
  const written = await store.write("sw-workflow-combined", "v-1", combined);
  const raw = JSON.parse(
    await readFile(join(root, "sw-workflow-combined", "v-1.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(raw.format).toBe("takoserver.selfhost-version-bindings@v10");
  expect(raw).toHaveProperty("actorBindings");
  expect(raw).toHaveProperty("dataPlane");
  expect(raw).toHaveProperty("serviceBindings");
  expect(raw).toHaveProperty("externalServices");
  expect(await store.read("sw-workflow-combined", "v-1")).toEqual(written);
});

test("Workflow token derivation pins every selected scope and reference tuple field", () => {
  expect(
    deriveSelfhostWorkflowBindingToken({
      eventToken: Buffer.alloc(32, 1).toString("base64url"),
      workerVersionResourceUid: "uid-WorkerVersion-workflows",
      binding: WORKFLOW_BINDING,
    }),
  ).toBe("7cc744a236659c6e1470358c1f47c0b2c797ffbaf815dcc7f6d0cca6ec9c4099");
});

test("Workflow names are unique across all immutable binding kinds and remain bounded", async () => {
  const collisionSets = [
    { ...WORKFLOW_SET, vars: [{ name: "FULFILLMENT", value: "x", kind: "text" as const }] },
    {
      ...WORKFLOW_SET,
      serviceBindings: [{ name: "FULFILLMENT", target: "worker", targetResourceUid: "uid-worker" }],
    },
    {
      ...WORKFLOW_SET,
      actorBindings: [
        {
          name: "FULFILLMENT",
          tenantId: "tenant-a",
          namespaceResourceUid: "uid-ActorNamespace-a",
          workerResourceUid: "uid-ModuleWorker-a",
          className: "Counter",
        },
      ],
    },
    {
      ...WORKFLOW_SET,
      dataPlane: { bindings: [{ kind: "edge.kv" as const, name: "FULFILLMENT", target: "ns" }] },
    },
    {
      ...WORKFLOW_SET,
      workflowBindings: [{ ...WORKFLOW_BINDING, name: "ARCHIVE" }],
      externalServices: EXTERNAL_SERVICES,
    },
  ];
  for (const [index, candidate] of collisionSets.entries()) {
    await expect(
      store.write(`sw-workflow-collision-${index}`, "v-1", candidate),
    ).rejects.toMatchObject({
      code: "corrupt",
    });
  }
  await expect(
    store.write("sw-workflow-name-bound", "v-1", {
      ...WORKFLOW_SET,
      workflowBindings: [{ ...WORKFLOW_BINDING, name: "1invalid" }],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
  await expect(
    store.write("sw-workflow-tenant-bound", "v-1", {
      ...WORKFLOW_SET,
      workflowBindings: [{ ...WORKFLOW_BINDING, tenantId: "t".repeat(256) }],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
  await expect(
    store.write("sw-workflow-uid-bound", "v-1", {
      ...WORKFLOW_SET,
      workflowBindings: [{ ...WORKFLOW_BINDING, workflowResourceUid: "ab" }],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
  await expect(
    store.write("sw-workflow-count-bound", "v-1", {
      ...WORKFLOW_SET,
      workflowBindings: Array.from({ length: 65 }, (_, index) => ({
        ...WORKFLOW_BINDING,
        name: `WORKFLOW_${index}`,
      })),
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
});

test("Workflow snapshots refuse unselected and non-plain reference tuples before writing", async () => {
  const candidates = [
    {
      ...WORKFLOW_BINDING,
      workflowFormRef: { ...WORKFLOW_BINDING.workflowFormRef, kind: "Worker" },
    },
    {
      ...WORKFLOW_BINDING,
      bindingRef: { ...WORKFLOW_BINDING.bindingRef, schemaDigest: `sha256:${"a".repeat(64)}` },
    },
    {
      ...WORKFLOW_BINDING,
      runtimeClassRef: { ...WORKFLOW_BINDING.runtimeClassRef, version: "2.0.0" },
    },
    { ...WORKFLOW_BINDING, bindingRef: { ...WORKFLOW_BINDING.bindingRef, extra: true } },
  ];
  for (const [index, workflowBinding] of candidates.entries()) {
    await expect(
      store.write(`sw-workflow-invalid-${index}`, "v-1", {
        ...WORKFLOW_SET,
        workflowBindings: [workflowBinding],
      } as unknown as SelfhostVersionBindingSet),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(existsSync(join(root, `sw-workflow-invalid-${index}`, "v-1.json"))).toBe(false);
  }
  const missingVersionUid = { ...WORKFLOW_SET } as Record<string, unknown>;
  delete missingVersionUid.workerVersionResourceUid;
  await expect(
    store.write(
      "sw-workflow-no-version-uid",
      "v-1",
      missingVersionUid as unknown as SelfhostVersionBindingSet,
    ),
  ).rejects.toMatchObject({ code: "corrupt" });
});

test("a stored Workflow record with an unselected reference is corrupt", async () => {
  await store.write("sw-workflow-tampered-ref", "v-1", WORKFLOW_SET);
  const path = join(root, "sw-workflow-tampered-ref", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    workflowBindings: Array<{ runtimeClassRef: { version: string } }>;
  };
  const workflowBinding = raw.workflowBindings[0];
  if (!workflowBinding) throw new Error("stored Workflow binding is missing");
  workflowBinding.runtimeClassRef.version = "2.0.0";
  await writeFile(path, JSON.stringify(raw), "utf8");
  await expect(store.read("sw-workflow-tampered-ref", "v-1")).rejects.toMatchObject({
    code: "corrupt",
  });
});

test("refuses any Workflow authority rewrite on an immutable Version", async () => {
  const first = await store.write("sw-workflow", "v-workflow", WORKFLOW_SET);
  const path = join(root, "sw-workflow", "v-workflow.json");
  const before = await readFile(path, "utf8");
  for (const workflowBindings of [
    [],
    [{ ...WORKFLOW_BINDING, workflowResourceUid: "uid-DurableWorkflow-replacement" }],
    [{ ...WORKFLOW_BINDING, bindingRef: { ...WORKFLOW_BINDING.bindingRef, version: "3.0.1" } }],
  ]) {
    await expect(
      store.write("sw-workflow", "v-workflow", { ...WORKFLOW_SET, workflowBindings }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(await readFile(path, "utf8")).toBe(before);
  }
  expect(await store.read("sw-workflow", "v-workflow")).toEqual(first);

  const legacyPath = join(root, "sw-add-workflow", "v-old.json");
  await store.write("sw-add-workflow", "v-old", SET);
  const legacyBytes = await readFile(legacyPath, "utf8");
  await expect(store.write("sw-add-workflow", "v-old", WORKFLOW_SET)).rejects.toMatchObject({
    code: "corrupt",
  });
  expect(await readFile(legacyPath, "utf8")).toBe(legacyBytes);
});

test("a canonical Workflow scope substitution reads with a new commitment but cannot be rewritten", async () => {
  const first = await store.write("sw-workflow", "v-workflow", WORKFLOW_SET);
  const path = join(root, "sw-workflow", "v-workflow.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    workflowBindings: Array<{ workflowResourceUid: string }>;
  };
  const substitutedBinding = raw.workflowBindings[0];
  if (!substitutedBinding) throw new Error("stored Workflow binding is missing");
  substitutedBinding.workflowResourceUid = "uid-DurableWorkflow-substituted";
  await writeFile(path, JSON.stringify(raw), "utf8");
  const substituted = await store.read("sw-workflow", "v-workflow");
  expect(substituted?.digest).not.toBe(first.digest);
  expect(substituted?.eventToken).toBe(first.eventToken);
  const eventToken = first.eventToken;
  if (!eventToken) throw new Error("stored event token is missing");
  const oldWorkflowToken = deriveSelfhostWorkflowBindingToken({
    eventToken,
    workerVersionResourceUid: WORKFLOW_SET.workerVersionResourceUid,
    binding: WORKFLOW_BINDING,
  });
  const substitutedWorkflowToken = deriveSelfhostWorkflowBindingToken({
    eventToken,
    workerVersionResourceUid: WORKFLOW_SET.workerVersionResourceUid,
    binding: { ...WORKFLOW_BINDING, workflowResourceUid: "uid-DurableWorkflow-substituted" },
  });
  expect(substitutedWorkflowToken).not.toBe(oldWorkflowToken);
  await expect(store.write("sw-workflow", "v-workflow", WORKFLOW_SET)).rejects.toMatchObject({
    code: "corrupt",
  });
});

test("stores and returns one version's bindings", async () => {
  expect(await store.read("sw-a", "v-1")).toBeNull();
  const written = await store.write("sw-a", "v-1", SET);
  expect(written.vars).toEqual(SET.vars);
  expect(written.sensitiveVars).toEqual(SET.sensitiveVars);
  expect(written.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(await store.read("sw-a", "v-1")).toEqual(written);
});

test("pins the original sensitive lease generation in the private native record", async () => {
  const generation = "abcdefghijklmnop";
  const set = { ...SET, runtimeInputGeneration: generation };
  await store.pinRuntimeInput("sw-a", "v-1", MARKER);
  const written = await store.write("sw-a", "v-1", set, MARKER);
  const path = join(root, "sw-a", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(raw.format).toBe("takoserver.selfhost-version-bindings@v7");
  expect(raw.runtimeInputGeneration).toBe(generation);
  expect((await store.read("sw-a", "v-1"))?.runtimeInputGeneration).toBe(generation);
  expect(await store.write("sw-a", "v-1", set, MARKER)).toEqual(written);
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(raw));
  await expect(
    store.write(
      "sw-a",
      "v-1",
      { ...set, runtimeInputGeneration: "qrstuvwxyzABCDEF" },
      { ...MARKER, generation: "qrstuvwxyzABCDEF" },
    ),
  ).rejects.toMatchObject({ code: "corrupt" });
  expect((await store.read("sw-a", "v-1"))?.runtimeInputGeneration).toBe(generation);
});

test("does not backfill a historical sensitive record with a later lease generation", async () => {
  const old = await store.write("sw-a", "v-1", SET);
  expect(old.runtimeInputGeneration).toBeUndefined();
  await expect(
    store.write("sw-a", "v-1", { ...SET, runtimeInputGeneration: "abcdefghijklmnop" }),
  ).rejects.toMatchObject({ code: "corrupt" });
  expect(await store.read("sw-a", "v-1")).toEqual(old);
});

test("closes a pre-dispatch marker before an absent native binding can be abandoned", async () => {
  const set = { ...SET, runtimeInputGeneration: MARKER.generation };
  await store.pinRuntimeInput("sw-a", "v-1", MARKER);
  expect(await store.readRuntimeInput("sw-a", "v-1", MARKER)).toEqual({
    generation: MARKER.generation,
    state: "active",
  });
  expect(await store.closeAbsentRuntimeInput("sw-a", "v-1", MARKER)).toBe(true);
  expect(await store.closeAbsentRuntimeInput("sw-a", "v-1", MARKER)).toBe(true);
  await expect(store.write("sw-a", "v-1", set, MARKER)).rejects.toMatchObject({ code: "corrupt" });
  expect(await store.read("sw-a", "v-1")).toBeNull();
  expect(await store.readRuntimeInput("sw-a", "v-1", MARKER)).toEqual({
    generation: MARKER.generation,
    state: "closed",
  });
  await expect(
    store.pinRuntimeInput("sw-a", "v-1", { ...MARKER, generation: "qrstuvwxyzABCDEF" }),
  ).rejects.toMatchObject({ code: "corrupt" });
  await expect(
    store.pinRuntimeInput("sw-a", "v-1", {
      ...MARKER,
      operationKey: "different-key-same-operation",
      generation: "qrstuvwxyzABCDEF",
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
  expect(await store.readRuntimeInput("sw-a", "v-1", MARKER)).toEqual({
    generation: MARKER.generation,
    state: "closed",
  });
  const replacement = {
    ...MARKER,
    operationId: "operation-b",
    generation: "qrstuvwxyzABCDEF",
  };
  await store.pinRuntimeInput("sw-a", "v-1", replacement);
  await expect(store.write("sw-a", "v-1", set, MARKER)).rejects.toMatchObject({ code: "corrupt" });
  expect(await store.readRuntimeInput("sw-a", "v-1", replacement)).toEqual({
    generation: replacement.generation,
    state: "active",
  });
});

test("does not close a marker after its exact native binding reached disk", async () => {
  await store.pinRuntimeInput("sw-a", "v-1", MARKER);
  await store.write("sw-a", "v-1", { ...SET, runtimeInputGeneration: MARKER.generation }, MARKER);
  expect(await store.readRuntimeInput("sw-a", "v-1", MARKER)).toEqual({
    generation: MARKER.generation,
    state: "written",
  });
  expect(await store.closeAbsentRuntimeInput("sw-a", "v-1", MARKER)).toBe(false);
  await expect(
    store.pinRuntimeInput("sw-a", "v-1", { ...MARKER, generation: "qrstuvwxyzABCDEF" }),
  ).rejects.toMatchObject({ code: "corrupt" });
  await rm(join(root, "sw-a", "v-1.json"));
  await expect(store.closeAbsentRuntimeInput("sw-a", "v-1", MARKER)).rejects.toMatchObject({
    code: "corrupt",
  });
});

test("a different process cannot land an old native binding after the marker closes", async () => {
  await store.pinRuntimeInput("sw-a", "v-1", MARKER);
  expect(await store.closeAbsentRuntimeInput("sw-a", "v-1", MARKER)).toBe(true);
  const source = `
    import { createSelfhostVersionBindingStore } from ${JSON.stringify(new URL("../src/providers/selfhost-version-bindings.ts", import.meta.url).href)};
    const store = createSelfhostVersionBindingStore({ root: ${JSON.stringify(root)} });
    try {
      await store.write("sw-a", "v-1", ${JSON.stringify({ ...SET, runtimeInputGeneration: MARKER.generation })}, ${JSON.stringify(MARKER)});
      process.exit(2);
    } catch (error) {
      process.exit(error?.code === "corrupt" ? 0 : 3);
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(await store.read("sw-a", "v-1")).toBeNull();
});

test("a killed writer after native fsync cannot be mistaken for no effect", async () => {
  await store.pinRuntimeInput("sw-a", "v-1", MARKER);
  const signal = join(root, "native-written.signal");
  const source = `
    import { writeFile } from "node:fs/promises";
    import { createSelfhostVersionBindingStore } from ${JSON.stringify(new URL("../src/providers/selfhost-version-bindings.ts", import.meta.url).href)};
    const store = createSelfhostVersionBindingStore({
      root: ${JSON.stringify(root)},
      async afterNativeWriteBeforeCommit() {
        await writeFile(${JSON.stringify(signal)}, "ready");
        await Bun.sleep(60_000);
      },
    });
    await store.write("sw-a", "v-1", ${JSON.stringify({ ...SET, runtimeInputGeneration: MARKER.generation })}, ${JSON.stringify(MARKER)});
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(signal); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(signal)).toBe(true);
    await expect(store.closeAbsentRuntimeInput("sw-a", "v-1", MARKER)).rejects.toMatchObject({
      code: "unavailable",
    });
  } finally {
    child.kill();
    await child.exited;
  }
  expect((await store.read("sw-a", "v-1"))?.runtimeInputGeneration).toBe(MARKER.generation);
  expect(await store.closeAbsentRuntimeInput("sw-a", "v-1", MARKER)).toBe(false);
});

test("stores v5 external declarations, optional omission, and JSON runtime values privately", async () => {
  const written = await store.write("sw-a", "v-1", {
    ...SET,
    externalServices: EXTERNAL_SERVICES,
  });
  expect(written.externalServices).toEqual(EXTERNAL_SERVICES);
  expect(JSON.parse(EXTERNAL_SERVICES[0].binding.value)).toEqual({
    endpoint: "https://archive.example.invalid",
    token: "secret",
  });
  expect(written.externalServices?.[1]?.binding).toBeUndefined();
  expect(JSON.parse(await readFile(join(root, "sw-a", "v-1.json"), "utf8")).format).toBe(
    "takoserver.selfhost-version-bindings@v5",
  );
  expect((await stat(join(root, "sw-a", "v-1.json"))).mode & 0o777).toBe(0o600);
  expect(await store.read("sw-a", "v-1")).toEqual(written);
});

test("stores a scoped Vector binding in v6 and round-trips its digest", async () => {
  const written = await store.write("sw-a", "v-1", VECTOR_SET);
  const path = join(root, "sw-a", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    format: string;
    externalServices: unknown;
    dataPlane: { bindings: Array<Record<string, unknown>> };
  };
  expect(raw.format).toBe("takoserver.selfhost-version-bindings@v6");
  expect(raw.externalServices).toEqual([]);
  expect(raw.dataPlane.bindings).toEqual([
    {
      kind: "edge.vector",
      name: "EMBEDDINGS",
      scope: VECTOR_SET.dataPlane.bindings[0]?.scope,
    },
  ]);
  expect(raw.dataPlane.bindings[0]).not.toHaveProperty("target");
  expect(raw.dataPlane.bindings[0]).not.toHaveProperty("nativeId");
  expect(written.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(await store.read("sw-a", "v-1")).toEqual(written);
});

test("changes the v6 digest when a Vector scope changes", async () => {
  const first = await store.write("sw-a", "v-1", VECTOR_SET);
  const changed = await store.write("sw-a", "v-1", {
    ...VECTOR_SET,
    dataPlane: {
      bindings: [
        {
          kind: "edge.vector",
          name: "EMBEDDINGS",
          scope: { tenantId: "tenant-b", resourceUid: "resource-a" },
        },
      ],
    },
  });
  expect(changed.digest).not.toBe(first.digest);
  expect(changed.dataPlane?.bindings[0]).toEqual({
    kind: "edge.vector",
    name: "EMBEDDINGS",
    scope: { tenantId: "tenant-b", resourceUid: "resource-a" },
  });
});

test("rejects a v6 record with a missing Vector scope", async () => {
  await store.write("sw-a", "v-1", VECTOR_SET);
  const path = join(root, "sw-a", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    dataPlane: { bindings: Array<Record<string, unknown>> };
  };
  const binding = raw.dataPlane.bindings[0];
  if (!binding) throw new Error("stored Vector binding is missing");
  delete binding.scope;
  await writeFile(path, JSON.stringify(raw), "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
});

test("rejects unknown fields on a v6 Vector binding", async () => {
  await store.write("sw-a", "v-1", VECTOR_SET);
  const path = join(root, "sw-a", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    dataPlane: { bindings: Array<Record<string, unknown>> };
  };
  const binding = raw.dataPlane.bindings[0];
  if (!binding) throw new Error("stored Vector binding is missing");
  binding.nativeId = "provider-private-id";
  await writeFile(path, JSON.stringify(raw), "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
});

test("rejects a v6 record that omits its Vector binding", async () => {
  const path = join(root, "sw-a", "v-1.json");
  await store.write("sw-a", "v-1", SET);
  const raw = {
    format: "takoserver.selfhost-version-bindings@v6",
    salt: "A".repeat(43),
    workerResourceUid: SET.workerResourceUid,
    handlers: SET.handlers,
    vars: SET.vars,
    sensitiveVars: SET.sensitiveVars,
    serviceBindings: [],
    externalServices: [],
    planeToken: "B".repeat(43),
    eventToken: "C".repeat(43),
  };
  await writeFile(path, JSON.stringify(raw), "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
});

test("rejects a Vector entry when an older format claims it", async () => {
  await store.write("sw-a", "v-1", VECTOR_SET);
  const path = join(root, "sw-a", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  raw.format = "takoserver.selfhost-version-bindings@v5";
  await writeFile(path, JSON.stringify(raw), "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
});

test("rejects forged or out-of-bounds Vector scopes", async () => {
  const invalidScopes = [
    { tenantId: "", resourceUid: "resource-a" },
    { tenantId: "tenant\u0000a", resourceUid: "resource-a" },
    { tenantId: "tenant-a", resourceUid: "ab" },
    { tenantId: "tenant-a", resourceUid: "resource\u0000a" },
    { tenantId: "t".repeat(256), resourceUid: "resource-a" },
    { tenantId: "tenant-a", resourceUid: "r".repeat(129) },
  ];
  for (const scope of invalidScopes) {
    await expect(
      store.write("sw-a", "v-1", {
        ...VECTOR_SET,
        dataPlane: {
          bindings: [{ kind: "edge.vector", name: "EMBEDDINGS", scope }],
        },
      }),
    ).rejects.toMatchObject({ code: "corrupt" });
  }
});

test("replays a v5 record byte-for-byte without minting new secrets", async () => {
  const first = await store.write("sw-a", "v-1", {
    ...SET,
    externalServices: EXTERNAL_SERVICES,
  });
  const before = await readFile(join(root, "sw-a", "v-1.json"));
  const replay = await store.write("sw-a", "v-1", {
    ...SET,
    externalServices: [...EXTERNAL_SERVICES].reverse(),
  });
  const after = await readFile(join(root, "sw-a", "v-1.json"));
  expect(replay).toEqual(first);
  expect(after).toEqual(before);
});

test("changes the v5 digest when external declaration metadata or JSON changes", async () => {
  const first = await store.write("sw-a", "v-1", {
    ...SET,
    externalServices: EXTERNAL_SERVICES,
  });
  const changed = await store.write("sw-a", "v-1", {
    ...SET,
    externalServices: [
      {
        ...EXTERNAL_SERVICES[0],
        required: false,
        binding: { kind: "json" as const, value: '{"endpoint":"https://changed.invalid"}' },
      },
      EXTERNAL_SERVICES[1],
    ],
  });
  expect(changed.digest).not.toBe(first.digest);
  expect(changed.externalServices?.[0]?.required).toBe(false);
});

test("keeps one salt for one version so a retry does not move its digest", async () => {
  const first = await store.write("sw-a", "v-1", SET);
  const second = await store.write("sw-a", "v-1", {
    workerResourceUid: SET.workerResourceUid,
    // Order is normalized, so presenting the same set differently is the same set.
    handlers: ["fetch"],
    vars: [...SET.vars],
    sensitiveVars: [...SET.sensitiveVars],
    serviceBindings: [],
  });
  expect(second.digest).toBe(first.digest);
});

test("commits to the values with a salt rather than a guessable hash of them", async () => {
  const other = createSelfhostVersionBindingStore({ root: join(root, "other") });
  const first = await store.write("sw-a", "v-1", SET);
  const second = await other.write("sw-a", "v-1", SET);
  expect(second.digest).not.toBe(first.digest);
  // The digest is not the SHA-256 of the value, so a short secret cannot be
  // recovered from the generation string that carries it.
  const naive = new Bun.CryptoHasher("sha256").update("placeholder-secret").digest("hex");
  expect(first.digest).not.toContain(naive);
});

test("changing a value changes the digest", async () => {
  const first = await store.write("sw-a", "v-1", SET);
  const changed = await store.write("sw-a", "v-1", {
    workerResourceUid: SET.workerResourceUid,
    handlers: ["fetch"],
    vars: SET.vars,
    sensitiveVars: [{ name: "ENCRYPTION_KEY", value: "rotated", kind: "text" }],
    serviceBindings: [],
  });
  expect(changed.digest).not.toBe(first.digest);
});

test("writes the record so only the operator can read it", async () => {
  await store.write("sw-a", "v-1", SET);
  expect((await stat(join(root, "sw-a", "v-1.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "sw-a"))).mode & 0o777).toBe(0o700);
});

test("refuses a name that is not a script or a version", async () => {
  await expect(store.write("../escape", "v-1", SET)).rejects.toMatchObject({ code: "corrupt" });
  await expect(store.write("sw-a", "../escape", SET)).rejects.toMatchObject({ code: "corrupt" });
  await expect(store.read("sw-a", "v 1")).rejects.toMatchObject({ code: "corrupt" });
});

test("refuses a set that names the same binding twice", async () => {
  await expect(
    store.write("sw-a", "v-1", {
      workerResourceUid: SET.workerResourceUid,
      handlers: ["fetch"],
      vars: [{ name: "SAME", value: "a", kind: "text" }],
      sensitiveVars: [{ name: "SAME", value: "b", kind: "text" }],
      serviceBindings: [],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
});

test("refuses invalid external declarations and any binding-name collision", async () => {
  await expect(
    store.write("sw-a", "v-1", {
      ...SET,
      externalServices: [
        {
          name: "LANE",
          required: false,
          service: { apiVersion: "standards.takoform.com/v1", protocol: "com.example.archive" },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
  await expect(
    store.write("sw-a", "v-1", {
      ...SET,
      externalServices: [
        {
          name: "bad-name",
          required: true,
          service: { apiVersion: "standards.takoform.com/v1", protocol: "com.example.archive" },
          binding: { kind: "json", value: "null" },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
  await expect(
    store.write("sw-a", "v-1", {
      ...SET,
      externalServices: [
        {
          name: "ARCHIVE",
          required: true,
          service: { apiVersion: "standards.takoform.com/v1", protocol: "not-a-protocol" },
          binding: { kind: "json", value: "[]" },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "corrupt" });
});

test("reports a tampered record as corrupt instead of serving it", async () => {
  await store.write("sw-a", "v-1", SET);
  const path = join(root, "sw-a", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...raw, extra: true }), "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
  await writeFile(path, "{not json", "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
});

test("rejects unknown v5 external metadata instead of serving it", async () => {
  await store.write("sw-a", "v-1", {
    ...SET,
    externalServices: EXTERNAL_SERVICES,
  });
  const path = join(root, "sw-a", "v-1.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as {
    externalServices: Array<Record<string, unknown>>;
  };
  raw.externalServices[0] = { ...raw.externalServices[0], extra: true };
  await writeFile(path, JSON.stringify(raw), "utf8");
  await expect(store.read("sw-a", "v-1")).rejects.toMatchObject({ code: "corrupt" });
});

test("preserves historical v4 bytes when external services are absent or empty", async () => {
  const first = await store.write("sw-a", "v-1", SET);
  const before = await readFile(join(root, "sw-a", "v-1.json"));
  expect(JSON.parse(before.toString()).format).toBe("takoserver.selfhost-version-bindings@v4");
  const replay = await store.write("sw-a", "v-1", { ...SET, externalServices: [] });
  const after = await readFile(join(root, "sw-a", "v-1.json"));
  expect(replay).toEqual(first);
  expect(after).toEqual(before);
});

test("reads every historical v1-v5 record with its original bytes and digest", async () => {
  // Seed the directory so these hand-authored historical records can be read
  // without exercising the current writer for their format.
  await store.write("legacy", "seed", SET);
  const salt = "A".repeat(43);
  const planeToken = "B".repeat(43);
  const eventToken = "C".repeat(43);
  const dataPlane = {
    bindings: [{ kind: "edge.kv", name: "KV", target: "kv-target" }],
  };
  const records = [
    [
      "v1",
      JSON.stringify({
        format: "takoserver.selfhost-version-bindings@v1",
        salt,
        vars: SET.vars,
        sensitiveVars: SET.sensitiveVars,
      }),
    ],
    [
      "v2",
      JSON.stringify({
        format: "takoserver.selfhost-version-bindings@v2",
        salt,
        vars: SET.vars,
        sensitiveVars: SET.sensitiveVars,
        dataPlane: { handlers: SET.handlers, bindings: dataPlane.bindings },
        planeToken,
      }),
    ],
    [
      "v3",
      JSON.stringify({
        format: "takoserver.selfhost-version-bindings@v3",
        salt,
        handlers: SET.handlers,
        vars: SET.vars,
        sensitiveVars: SET.sensitiveVars,
        dataPlane,
        planeToken,
        eventToken,
      }),
    ],
    [
      "v4",
      JSON.stringify({
        format: "takoserver.selfhost-version-bindings@v4",
        salt,
        workerResourceUid: SET.workerResourceUid,
        handlers: SET.handlers,
        vars: SET.vars,
        sensitiveVars: SET.sensitiveVars,
        serviceBindings: [],
        dataPlane,
        planeToken,
        eventToken,
      }),
    ],
    [
      "v5",
      JSON.stringify({
        format: "takoserver.selfhost-version-bindings@v5",
        salt,
        workerResourceUid: SET.workerResourceUid,
        handlers: SET.handlers,
        vars: SET.vars,
        sensitiveVars: SET.sensitiveVars,
        serviceBindings: [],
        externalServices: EXTERNAL_SERVICES,
        dataPlane,
        planeToken,
        eventToken,
      }),
    ],
  ] as const;
  for (const [versionId, raw] of records) {
    const path = join(root, "legacy", `${versionId}.json`);
    await writeFile(path, raw, "utf8");
    const read = await store.read("legacy", versionId);
    expect(read).not.toBeNull();
    const digest = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    expect(read?.digest).toBe(`sha256:${digest}`);
    expect(await readFile(path, "utf8")).toBe(raw);
  }
});

test("a record an earlier build wrote is still read, and carries no handlers", async () => {
  // `@v1` predates event delivery on this Host: it has no handler list and no
  // event token, so a Version published under it keeps serving and simply
  // cannot be wrapped.
  const path = join(root, "sw-a", "v-1.json");
  await store.write("sw-a", "v-1", SET);
  const legacy = JSON.stringify({
    format: "takoserver.selfhost-version-bindings@v1",
    salt: "A".repeat(43),
    vars: SET.vars,
    sensitiveVars: SET.sensitiveVars,
  });
  await writeFile(path, legacy, "utf8");
  const read = await store.read("sw-a", "v-1");
  expect(read?.handlers).toBeUndefined();
  expect(read?.eventToken).toBeUndefined();
  expect(read?.vars).toEqual(SET.vars);
});

test("mints an event token the caller never chose, once per version", async () => {
  const first = await store.write("sw-a", "v-1", SET);
  expect(first.eventToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const again = await store.write("sw-a", "v-1", SET);
  expect(again.eventToken).toBe(first.eventToken);
  const other = await store.write("sw-a", "v-2", SET);
  expect(other.eventToken).not.toBe(first.eventToken);
});

test("forgets one version, and every version of a deleted script", async () => {
  await store.write("sw-a", "v-1", SET);
  await store.write("sw-a", "v-2", SET);
  expect(await store.remove("sw-a", "v-1")).toBe(true);
  expect(await store.remove("sw-a", "v-1")).toBe(false);
  expect(await store.read("sw-a", "v-2")).not.toBeNull();
  await store.removeScript("sw-a");
  expect(await store.read("sw-a", "v-2")).toBeNull();
});
