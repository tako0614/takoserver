import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createActorResourceGraphReader } from "../src/actor-resource-graph.ts";
import { selectTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import type { InstalledTakoformForm, TakoformStoredResource } from "../src/takoform/types.ts";
import {
  actorForm,
  fixture as createFixture,
  insert,
  resource,
  scope,
  workerForm,
} from "./helpers/actor-resource-fixture.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function fixture(
  change?: (source: TakoformStoredResource, target: TakoformStoredResource) => void,
) {
  const result = createFixture(change);
  databases.push(result.database);
  return result;
}
const signal = () => new AbortController().signal;

test("current published ActorNamespace resolves factual graph in one read without readiness or writes", async () => {
  const f = fixture();
  const before = f.database.query("SELECT total_changes() AS changes").get();
  const graph = await f.read(scope, signal());
  expect(graph).toEqual({
    tenantId: scope.tenantId,
    namespace: {
      address: {
        space: "default",
        apiVersion: actorForm.identity.formRef.apiVersion,
        kind: "ActorNamespace",
        name: "counter",
      },
      uid: scope.namespaceResourceUid,
      generation: "3",
      revision: "7",
      formRef: actorForm.identity.formRef,
      className: "Counter",
    },
    worker: {
      address: {
        space: "default",
        apiVersion: workerForm.identity.formRef.apiVersion,
        kind: "ModuleWorker",
        name: "worker",
      },
      uid: "worker-uid",
      generation: "3",
      revision: "7",
      formRef: workerForm.identity.formRef,
    },
  });
  expect(f.queryCount()).toBe(1);
  expect(f.database.query("SELECT total_changes() AS changes").get()).toEqual(before);
});

test("rejects cross-tenant scope and a target moved to another tenant or space", async () => {
  const f = fixture();
  expect(await f.read({ ...scope, tenantId: "other" }, signal())).toBeNull();
  f.database.query("UPDATE tf_resources SET tenant_id = 'other' WHERE uid = 'worker-uid'").run();
  expect(await f.read(scope, signal())).toBeNull();
  const otherSpace = fixture((_source, target) => {
    Object.assign(target.metadata, { space: "other" });
  });
  expect(await otherSpace.read(scope, signal())).toBeNull();
});

test("requires live deletion fences for both resource incarnations", async () => {
  for (const uid of [scope.namespaceResourceUid, "worker-uid"]) {
    const f = fixture();
    f.database
      .query(
        "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE resource_uid = ?",
      )
      .run(uid);
    expect(await f.read(scope, signal())).toBeNull();
    f.database
      .query("DELETE FROM tf_resource_deletion_attestations WHERE resource_uid = ?")
      .run(uid);
    expect(await f.read(scope, signal())).toBeNull();
  }
});

test("same-address Worker recreation does not retarget the persisted old UID relation", async () => {
  const f = fixture();
  f.database.query("DELETE FROM tf_resources WHERE uid = 'worker-uid'").run();
  const replacement = resource(workerForm, "worker", "replacement-worker-uid");
  insert(f.database, replacement, []);
  expect(await f.read(scope, signal())).toBeNull();
});

test("same-address Namespace recreation cannot answer for an old UID", async () => {
  const f = fixture();
  f.database.query("DELETE FROM tf_resources WHERE uid = ?").run(scope.namespaceResourceUid);
  const replacement = resource(actorForm, "counter", "replacement-namespace-uid");
  insert(f.database, replacement, [f.relation]);
  expect(await f.read(scope, signal())).toBeNull();
  expect(
    (await f.read({ ...scope, namespaceResourceUid: replacement.metadata.uid }, signal()))
      ?.namespace.uid,
  ).toBe(replacement.metadata.uid);
});

test("rejects malformed class, desired worker address, exact Form/package, relation and listing", async () => {
  const mutations: ((source: TakoformStoredResource) => void)[] = [
    (source) => {
      Object.assign(source.spec, { className: "bad class!" });
    },
    (source) => {
      Object.assign(source.spec.worker as object, { name: "other" });
    },
    (source) => {
      Object.assign(source.spec.worker as object, { extra: true });
    },
    (source) => {
      Object.assign(source.form, { packageDigest: `sha256:${"f".repeat(64)}` });
    },
    (source) => {
      Object.assign(source.form.formRef, { definitionVersion: "99.0.0" });
    },
  ];
  for (const mutation of mutations) {
    const f = fixture(mutation);
    expect(await f.read(scope, signal())).toBeNull();
  }
  for (const badRelation of [
    { targetUid: "missing" },
    { relation: "/other" },
    { targetKind: "Other" },
  ]) {
    const f = fixture();
    f.database
      .query("UPDATE tf_resources SET relations_json = ? WHERE uid = ?")
      .run(JSON.stringify([{ ...f.relation, ...badRelation }]), scope.namespaceResourceUid);
    expect(await f.read(scope, signal())).toBeNull();
  }
  const f = fixture();
  f.database
    .query("UPDATE tf_resources SET generation = '99' WHERE uid = ?")
    .run(scope.namespaceResourceUid);
  expect(await f.read(scope, signal())).toBeNull();
});

test("rejects duplicate relation evidence and mismatching target Form attestation", async () => {
  const f = fixture();
  f.database
    .query("UPDATE tf_resources SET relations_json = ? WHERE uid = ?")
    .run(JSON.stringify([f.relation, f.relation]), scope.namespaceResourceUid);
  expect(await f.read(scope, signal())).toBeNull();
  const g = fixture();
  g.database
    .query(
      "UPDATE tf_resource_deletion_attestations SET form_ref_json = '{}' WHERE resource_uid = 'worker-uid'",
    )
    .run();
  expect(await g.read(scope, signal())).toBeNull();
});

test("validates and snapshots supplied Actor vocabulary, without implicit catalog pin", async () => {
  const f = fixture();
  const form = structuredClone(actorForm);
  const read = createActorResourceGraphReader({ store: f.store, form });
  Object.assign(form.desiredSchema, { type: "number" });
  expect((await read(scope, signal()))?.namespace.className).toBe("Counter");
  for (const patch of [
    {
      workerClassRuntime: { ...actorForm.workerClassRuntime, providedInterface: "worker.workflow" },
    },
    { workerClassRuntime: { ...actorForm.workerClassRuntime, className: "/other" } },
    { providedInterfaces: [...(actorForm.providedInterfaces ?? []), { name: "worker.actor" }] },
    { desiredSchema: {} },
  ]) {
    expect(() =>
      createActorResourceGraphReader({
        store: f.store,
        form: { ...actorForm, ...patch } as InstalledTakoformForm,
      }),
    ).toThrow();
  }
  const newer = structuredClone(actorForm);
  Object.assign(newer.identity.formRef, { definitionVersion: "99.0.0" });
  Object.assign(f.source.form.formRef, newer.identity.formRef);
  f.database
    .query("UPDATE tf_resources SET resource_json = ? WHERE uid = ?")
    .run(JSON.stringify(f.source), scope.namespaceResourceUid);
  f.database
    .query("UPDATE tf_resource_deletion_attestations SET form_ref_json = ? WHERE resource_uid = ?")
    .run(JSON.stringify(newer.identity.formRef), scope.namespaceResourceUid);
  expect(
    (await createActorResourceGraphReader({ store: f.store, form: newer })(scope, signal()))
      ?.namespace.formRef.definitionVersion,
  ).toBe("99.0.0");
});

test("projects only the installed forward Actor Form's exact runtime InterfaceRef", async () => {
  const selected = selectTakoformCandidates("actor-forward").forms.find(
    (form) => form.identity.formRef.kind === "ActorNamespace",
  );
  if (!selected?.workerClassRuntime?.runtimeClassRef)
    throw new Error("forward Actor Form missing runtime InterfaceRef");
  const f = fixture();
  Object.assign(f.source.form, structuredClone(selected.identity));
  f.database
    .query("UPDATE tf_resources SET resource_json = ? WHERE uid = ?")
    .run(JSON.stringify(f.source), scope.namespaceResourceUid);
  f.database
    .query("UPDATE tf_resource_deletion_attestations SET form_ref_json = ? WHERE resource_uid = ?")
    .run(JSON.stringify(selected.identity.formRef), scope.namespaceResourceUid);
  const read = createActorResourceGraphReader({ store: f.store, form: selected });
  expect((await read(scope, signal()))?.runtimeClassRef).toEqual(
    selected.workerClassRuntime.runtimeClassRef,
  );

  for (const form of [
    {
      ...selected,
      workerClassRuntime: {
        ...selected.workerClassRuntime,
        runtimeClassRef: {
          ...selected.workerClassRuntime.runtimeClassRef,
          schemaDigest: `sha256:${"f".repeat(64)}`,
        },
      },
    },
    {
      ...selected,
      providedInterfaces: [
        {
          ...selected.workerClassRuntime.runtimeClassRef,
          version: "1.0.0",
        },
      ],
    },
  ]) {
    expect(() =>
      createActorResourceGraphReader({ store: f.store, form: form as InstalledTakoformForm }),
    ).toThrow();
  }
});

test("captures scope, detaches returned facts, propagates failures, and honors cancellation", async () => {
  const f = fixture();
  const snapshot = await f.store.resourceWithRelationTargetByUid(
    scope.tenantId,
    scope.namespaceResourceUid,
    "/worker",
  );
  if (!snapshot) throw new Error("missing fixture graph");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = createActorResourceGraphReader({
    form: actorForm,
    store: {
      async resourceWithRelationTargetByUid() {
        await pending;
        return snapshot;
      },
    },
  });
  const mutableScope = { ...scope };
  const result = read(mutableScope, signal());
  mutableScope.tenantId = "attacker";
  mutableScope.namespaceResourceUid = "other";
  release();
  const graph = await result;
  expect(graph?.tenantId).toBe(scope.tenantId);
  expect(graph?.namespace.uid).toBe(scope.namespaceResourceUid);
  if (graph) Object.assign(graph.namespace.formRef, { schemaDigest: "changed" });
  expect(snapshot.source.resource.form.formRef.schemaDigest).toBe(
    actorForm.identity.formRef.schemaDigest,
  );
  const controller = new AbortController();
  controller.abort("before");
  await expect(f.read(scope, controller.signal)).rejects.toBe("before");
  const late = new AbortController();
  const cancelled = read(scope, late.signal);
  late.abort("after");
  await expect(cancelled).rejects.toBe("after");
  const failure = new Error("storage unavailable");
  const failed = createActorResourceGraphReader({
    form: actorForm,
    store: {
      async resourceWithRelationTargetByUid() {
        throw failure;
      },
    },
  });
  await expect(failed(scope, signal())).rejects.toBe(failure);
});
