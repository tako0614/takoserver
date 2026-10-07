import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSelfhostV2KvStore } from "../src/providers/selfhost-v2-kv-store.ts";
import {
  runSelfhostKvOperation,
  selfhostKvOperationErrorCode,
} from "../src/selfhost-data-planes.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  createEdgeKVNamespaceForm,
  EDGE_KV_NAMESPACE_BACKEND_ID,
  EDGE_KV_NAMESPACE_FORM_URL,
  EDGE_KV_NAMESPACE_LIMITS,
  type EdgeKVNamespaceIdentity,
  type EdgeKVNamespaceStore,
  EdgeKVNamespaceValidationError,
  parseEdgeKVNamespaceSpec,
  validateEdgeKVNamespaceUpdate,
} from "../src/takoform-v2/index.ts";
import type { V2Backend, V2Execution } from "../src/takoform-v2/types.ts";

function fixture() {
  const rootPromise = mkdtemp(join(tmpdir(), "takoserver-v2-edge-kv-"));
  return rootPromise;
}

async function createBindingFixture() {
  const root = await fixture();
  const database = new Database(join(root, "control.sqlite"));
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const identity: EdgeKVNamespaceIdentity = {
    targetKey: "selfhost-target",
    principal: "alice",
    space: "default",
    resourceUid: "resource-edge-kv-fixture",
  };
  const store = createSelfhostV2KvStore({
    sql,
    root: join(root, "data"),
    runOperation: runSelfhostKvOperation,
    operationErrorCode: selfhostKvOperationErrorCode,
  });
  const created = await store.create({ identity, operationId: "edge-kv-fixture-create" });
  if (created !== "ready") throw new Error("fixture namespace failed to create");
  const binding = await store.openNamespace(identity);
  if (!binding) throw new Error("fixture namespace failed to open");
  return { root, database, binding, identity, store };
}

test("EdgeKVNamespace accepts only the canonical URL's empty immutable spec", () => {
  expect(EDGE_KV_NAMESPACE_FORM_URL).toBe(
    "https://edge.forms.takoform.com/forms/EdgeKVNamespace/0.2.0/",
  );
  expect(parseEdgeKVNamespaceSpec({})).toEqual({});
  expect(EDGE_KV_NAMESPACE_LIMITS.maxKeyBytes).toBe(467);
  expect(validateEdgeKVNamespaceUpdate({}, {})).toEqual({});
  for (const value of [null, [], "{}", { region: "local" }, Object.create(null)]) {
    expect(() => parseEdgeKVNamespaceSpec(value)).toThrow(EdgeKVNamespaceValidationError);
  }
  expect(() => validateEdgeKVNamespaceUpdate({}, { replication: "strong" })).toThrow(
    EdgeKVNamespaceValidationError,
  );
});

test("EdgeKVNamespace binding uses the shared KV engine and preserves bytes", async () => {
  const root = await fixture();
  const databasePath = join(root, "control.sqlite");
  let database: Database | undefined = new Database(databasePath);
  const dataRoot = join(root, "data");
  const identity: EdgeKVNamespaceIdentity = {
    targetKey: "selfhost-target",
    principal: "alice",
    space: "default",
    resourceUid: "resource-edge-kv-001",
  };
  try {
    migrateSqlite(database);
    let sql = createSqliteSql(database);
    let store = createSelfhostV2KvStore({
      sql,
      root: dataRoot,
      runOperation: runSelfhostKvOperation,
      operationErrorCode: selfhostKvOperationErrorCode,
    });
    const createOperationId = "edge-kv-create-op-001";
    expect(await store.reconcileCreate({ identity, operationId: createOperationId })).toBe(
      "absent",
    );
    expect(await store.create({ identity, operationId: createOperationId })).toBe("ready");
    expect(await store.create({ identity, operationId: createOperationId })).toBe("ready");
    expect(await store.create({ identity, operationId: "different-create-op" })).toBe("conflict");
    expect(await store.openNamespace({ ...identity, targetKey: "other-target" })).toBeNull();
    const binding = await store.openNamespace(identity);
    expect(binding).not.toBeNull();
    if (!binding) throw new Error("created EdgeKV namespace did not open");

    const source = new Uint8Array([99, 10, 11, 12, 88]);
    await binding.put("bytes", source.subarray(1, 4), { metadata: { label: "ok" } });
    source.fill(0);
    const found = await binding.get("bytes");
    expect(found && [...new Uint8Array(found)]).toEqual([10, 11, 12]);
    const withMetadata = await binding.getWithMetadata("bytes");
    expect(withMetadata && [...new Uint8Array(withMetadata.value)]).toEqual([10, 11, 12]);
    expect(withMetadata?.metadata).toEqual({ label: "ok" });
    const specialKeys = JSON.parse(
      '{"__proto__":"proto-value","constructor":"ctor-value","toString":"string-value"}',
    ) as Record<string, string>;
    expect(canonicalJson(specialKeys)).toBe(
      '{"__proto__":"proto-value","constructor":"ctor-value","toString":"string-value"}',
    );
    await binding.put("special-metadata-keys", "value", { metadata: specialKeys });
    const specialKeysRoundTrip = await binding.getWithMetadata("special-metadata-keys");
    expect(specialKeysRoundTrip?.metadata).toEqual(specialKeys);
    expect(Object.hasOwn(specialKeysRoundTrip?.metadata ?? {}, "__proto__")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(specialKeysRoundTrip?.metadata ?? {}, "constructor")?.value,
    ).toBe("ctor-value");
    expect(
      Object.getOwnPropertyDescriptor(specialKeysRoundTrip?.metadata ?? {}, "toString")?.value,
    ).toBe("string-value");
    expect(Object.getPrototypeOf(specialKeysRoundTrip?.metadata)).toBe(Object.prototype);
    expect(await binding.get("missing")).toBeNull();
    await expect(
      binding.put("metadata-key-bytes", "x", {
        metadata: { ["😀".repeat(65)]: "value" },
      }),
    ).rejects.toMatchObject({ name: "metadata_too_large" });

    await binding.put("prefix:a", "a");
    await binding.put("prefix:b", "b");
    const first = await binding.list({ prefix: "prefix:", limit: 1 });
    expect(first).toMatchObject({ keys: [{ name: "prefix:a" }], listComplete: false });
    expect(first.cursor).toBeString();
    if (!first.cursor) throw new Error("incomplete list did not return a cursor");
    const second = await binding.list({ prefix: "prefix:", limit: 1, cursor: first.cursor });
    expect(second).toEqual({ keys: [{ name: "prefix:b" }], listComplete: true });
    await expect(binding.list({ cursor: "forged.cursor" })).rejects.toMatchObject({
      name: "invalid_cursor",
    });
    const anotherIdentity: EdgeKVNamespaceIdentity = { ...identity, resourceUid: "other-resource" };
    expect(await store.create({ identity: anotherIdentity, operationId: "other-create-op" })).toBe(
      "ready",
    );
    const otherBinding = await store.openNamespace(anotherIdentity);
    if (!otherBinding) throw new Error("second created namespace did not open");
    await expect(otherBinding.list({ cursor: first.cursor })).rejects.toMatchObject({
      name: "invalid_cursor",
    });

    // Ordinary owner state and its exact file-store receipt survive a SQLite reopen.
    database.close();
    database = undefined;
    database = new Database(databasePath);
    migrateSqlite(database);
    sql = createSqliteSql(database);
    store = createSelfhostV2KvStore({
      sql,
      root: dataRoot,
      runOperation: runSelfhostKvOperation,
      operationErrorCode: selfhostKvOperationErrorCode,
    });
    const reopenedBinding = await store.openNamespace(identity);
    expect(
      reopenedBinding && [
        ...new Uint8Array((await reopenedBinding.get("bytes")) ?? new ArrayBuffer(0)),
      ],
    ).toEqual([10, 11, 12]);

    const deleteOperationId = "edge-kv-delete-op-001";
    expect(await store.delete({ identity, operationId: deleteOperationId })).toBe("deleted");
    expect(await store.delete({ identity, operationId: deleteOperationId })).toBe("deleted");
    await expect(binding.get("bytes")).rejects.toMatchObject({ name: "backend_unavailable" });
    expect(await store.openNamespace(identity)).toBeNull();
    expect(await sql.query("SELECT namespace_id FROM selfhost_kv_entries")).toEqual([]);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("EdgeKVNamespace range-error gaps reject safely but remain unqualified", async () => {
  const { root, database, binding } = await createBindingFixture();
  try {
    // Form 0.2 §5 names no error for an integer TTL outside 60..315,360,000,
    // list limit outside 1..1,000, or an overlong list prefix. The shared engine
    // rejects these as invalid_value / invalid_argument / invalid_key, but these
    // names remain UNQUALIFIED for 0.2. A next version should add precisely:
    // invalid_ttl for TTL range, invalid_argument for limit range, and invalid_key
    // for prefix byte length. These assertions do not claim 0.2 conformance.
    await expect(binding.put("bad-ttl", "x", { expirationTtlSeconds: 59 })).rejects.toMatchObject({
      name: "invalid_value",
    });
    await expect(binding.list({ prefix: "x".repeat(468) })).rejects.toMatchObject({
      name: "invalid_key",
    });
    await expect(binding.list({ limit: 1_001 })).rejects.toMatchObject({
      name: "invalid_argument",
    });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("EdgeKVNamespace malformed options and argument types reject at the Binding", async () => {
  const { root, database, binding } = await createBindingFixture();
  try {
    await expect(
      binding.put("unknown-put-option", "x", { unknown: true } as never),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(binding.list({ unknown: true } as never)).rejects.toBeInstanceOf(TypeError);
    await expect(binding.get(4 as never)).rejects.toBeInstanceOf(TypeError);
    await expect(binding.put("wrong-value-type", true as never)).rejects.toBeInstanceOf(TypeError);
    await expect(
      binding.put("wrong-metadata-type", "x", { metadata: { count: 1 } } as never),
    ).rejects.toBeInstanceOf(TypeError);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("EdgeKVNamespace Form create/update/delete observes its exact fixed contract", async () => {
  const root = await fixture();
  const database: Database | undefined = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const targetKey = "selfhost-target";
    const store = createSelfhostV2KvStore({
      sql,
      root: join(root, "data"),
      runOperation: runSelfhostKvOperation,
      operationErrorCode: selfhostKvOperationErrorCode,
    });
    const form = createEdgeKVNamespaceForm({ store, targetKey });
    expect(form.backend.id).toBe(EDGE_KV_NAMESPACE_BACKEND_ID);
    const host = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3_600,
      authorize: async (principal, space) => principal === "alice" && space === "default",
      forms: { [EDGE_KV_NAMESPACE_FORM_URL]: form },
    });
    const accepted = await host.acceptCreate({
      principal: "alice",
      key: "edge-kv-create-key-00001",
      input: { form: EDGE_KV_NAMESPACE_FORM_URL, space: "default", name: "cache", spec: {} },
    });
    expect(await host.runNext()).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    let resource = await host.getResource({ principal: "alice", uid: accepted.resourceUid });
    expect(resource).toMatchObject({
      observed: {
        namespaceExists: true,
        maxKeyBytes: 467,
        maxValueBytes: 26_214_400,
        maxMetadataBytes: 1_024,
        consistency: "eventual",
      },
      output: {},
    });
    const updated = await host.acceptUpdate({
      principal: "alice",
      key: "edge-kv-update-key-00001",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await host.runNext()).toMatchObject({
      id: updated.id,
      status: "succeeded",
      effect: "complete",
    });
    resource = await host.getResource({ principal: "alice", uid: accepted.resourceUid });
    expect(resource.observedGeneration).toBe(2);
    const deletion = await host.acceptDelete({
      principal: "alice",
      key: "edge-kv-delete-key-00001",
      uid: accepted.resourceUid,
      expectedGeneration: 2,
    });
    expect(await host.runNext()).toMatchObject({
      id: deletion.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await store.openNamespace({
        targetKey,
        principal: "alice",
        space: "default",
        resourceUid: accepted.resourceUid,
      }),
    ).toBeNull();
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("EdgeKVNamespace uses an operator-selected backend ID for normal Host operations", async () => {
  const root = await fixture();
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const store: EdgeKVNamespaceStore = createSelfhostV2KvStore({
      sql,
      root: join(root, "data"),
      runOperation: runSelfhostKvOperation,
      operationErrorCode: selfhostKvOperationErrorCode,
    });
    const backendId = "private-v2-wfp-edge-kv-namespace-v1";
    const form = createEdgeKVNamespaceForm({ store, targetKey: "selfhost-target", backendId });
    expect(form.backend.id).toBe(backendId);
    const host = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3_600,
      authorize: async (principal, space) => principal === "alice" && space === "default",
      forms: { [EDGE_KV_NAMESPACE_FORM_URL]: form },
    });
    const accepted = await host.acceptCreate({
      principal: "alice",
      key: "custom-edge-kv-create-key",
      input: { form: EDGE_KV_NAMESPACE_FORM_URL, space: "default", name: "cache", spec: {} },
    });
    expect(await host.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    expect(await host.getResource({ principal: "alice", uid: accepted.resourceUid })).toMatchObject(
      {
        observed: { namespaceExists: true, maxKeyBytes: 467, consistency: "eventual" },
        output: {},
      },
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("EdgeKVNamespace refuses foreign executions before touching its store", async () => {
  const { root, database, identity, store } = await createBindingFixture();
  try {
    const backendId = "private-v2-wfp-edge-kv-namespace-v1";
    const form = createEdgeKVNamespaceForm({ store, targetKey: identity.targetKey, backendId });
    const execution: V2Execution = {
      operationId: "foreign-create-op",
      leaseToken: "foreign-lease",
      backendKey: "foreign-backend-key",
      backendId: "another-backend",
      targetKey: identity.targetKey,
      resourceUid: "foreign-resource",
      principal: identity.principal,
      action: "create",
      generation: 1,
      form: EDGE_KV_NAMESPACE_FORM_URL,
      space: identity.space,
      name: "foreign",
      spec: {},
      previousObserved: {},
      previousOutput: {},
    };
    const refused = {
      kind: "unknown",
      code: "ownership_uncertain",
      message: "ownership_uncertain",
    } as const;
    expect(await form.backend.execute(execution)).toEqual(refused);
    expect(await form.backend.reconcile(execution)).toEqual(refused);
    expect(await store.observe({ ...identity, resourceUid: execution.resourceUid })).toBe("absent");
    const deletion = { ...execution, action: "delete" as const, resourceUid: identity.resourceUid };
    expect(await form.backend.execute(deletion)).toEqual(refused);
    expect(await form.backend.reconcile(deletion)).toEqual(refused);
    expect(await store.observe(identity)).toBe("ready");
    expect(
      await form.backend.execute({ ...execution, backendId, targetKey: "foreign-target" }),
    ).toEqual(refused);
    expect(await form.backend.reconcile({ ...execution, backendId, form: "foreign-form" })).toEqual(
      refused,
    );
    for (const invalid of ["", " ", null, false, 7]) {
      expect(() =>
        createEdgeKVNamespaceForm({
          store,
          targetKey: identity.targetKey,
          backendId: invalid as never,
        }),
      ).toThrow(TypeError);
    }
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("EdgeKVNamespace native backend receives the full fenced execution and refuses mutation", async () => {
  const delivered: V2Execution[] = [];
  const backend: V2Backend = {
    id: "private-v2-wfp-edge-kv-namespace-v1",
    targetKey: "private-target",
    async execute(input) {
      delivered.push(input);
      return { kind: "complete", observed: { namespaceExists: true }, output: {} };
    },
    async reconcile(input) {
      delivered.push(input);
      return { kind: "unknown", code: "native_pending" };
    },
  };
  const form = createEdgeKVNamespaceForm({ backend, targetKey: "private-target" });
  const execution: V2Execution = {
    operationId: "native-create-op",
    leaseToken: "native-lease",
    backendKey: "native-backend-key",
    backendId: backend.id,
    targetKey: backend.targetKey,
    resourceUid: "native-kv-uid",
    principal: "alice",
    action: "create",
    generation: 3,
    form: EDGE_KV_NAMESPACE_FORM_URL,
    space: "default",
    name: "cache",
    spec: {},
    previousObserved: {},
    previousOutput: {},
  };
  expect(form.backend.id).toBe(backend.id);
  expect(await form.backend.execute(execution)).toMatchObject({ kind: "complete" });
  expect(await form.backend.reconcile(execution)).toMatchObject({
    kind: "unknown",
    code: "native_pending",
  });
  expect(delivered).toEqual([execution, execution]);
  const refused = {
    kind: "unknown",
    code: "ownership_uncertain",
    message: "ownership_uncertain",
  } as const;
  expect(
    await form.backend.execute({ ...execution, backendId: EDGE_KV_NAMESPACE_BACKEND_ID }),
  ).toEqual(refused);
  expect(await form.backend.reconcile({ ...execution, targetKey: "other-target" })).toEqual(
    refused,
  );
  expect(delivered).toHaveLength(2);
  backend.id = "mutated-native-backend";
  expect(await form.backend.execute(execution)).toEqual(refused);
  expect(delivered).toHaveLength(2);
  backend.id = execution.backendId;
  backend.execute = async () => {
    throw new Error("mutated backend method must not execute");
  };
  expect(await form.backend.execute(execution)).toEqual(refused);
  expect(delivered).toHaveLength(2);
});

test("EdgeKVNamespace rejects mixed or malformed native backend composition", async () => {
  const { root, database, store } = await createBindingFixture();
  try {
    const backend: V2Backend = {
      id: "private-v2-wfp-edge-kv-namespace-v1",
      targetKey: "private-target",
      async execute() {
        return { kind: "unknown" };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    };
    expect(() =>
      createEdgeKVNamespaceForm({ store, backend, targetKey: "private-target" } as never),
    ).toThrow(TypeError);
    expect(() => createEdgeKVNamespaceForm({ backend, targetKey: "other-target" })).toThrow(
      TypeError,
    );
    for (const invalid of ["", " ", null, 7]) {
      expect(() =>
        createEdgeKVNamespaceForm({
          backend: { ...backend, id: invalid as never },
          targetKey: "private-target",
        }),
      ).toThrow(TypeError);
    }
    expect(() =>
      createEdgeKVNamespaceForm({
        backend: { ...backend, execute: null as never },
        targetKey: "private-target",
      }),
    ).toThrow(TypeError);
    expect(() =>
      createEdgeKVNamespaceForm({
        backend: { ...backend, reconcile: null as never },
        targetKey: "private-target",
      }),
    ).toThrow(TypeError);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
