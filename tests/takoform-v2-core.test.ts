import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Backend, V2BackendResult, V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/unit/1.0.0";
const KEY = "created-operation-key-00000001";

function fixture(backend?: Partial<V2Backend>) {
  const db = new Database(":memory:");
  for (const name of ["0070_takoform_v2.sql", "0071_v2_sqlite_migration_set_custody.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  let time = Date.parse("2026-10-06T00:00:00Z");
  const calls: string[] = [];
  const actualBackend: V2Backend = {
    id: "fixture-implementation-v1",
    targetKey: "fixture-target",
    async execute(input) {
      calls.push(`execute:${input.backendKey}:${input.action}`);
      return { kind: "complete", observed: { exists: input.action !== "delete" }, output: {} };
    },
    async reconcile(input) {
      calls.push(`reconcile:${input.backendKey}:${input.action}`);
      return { kind: "unknown" };
    },
    ...backend,
  };
  const form: V2Form = {
    validateCreate(spec) {
      if (typeof spec.value !== "string") throw new Error("invalid fixture spec");
    },
    validateUpdate(_previous, spec) {
      if (typeof spec.value !== "string") throw new Error("invalid fixture spec");
    },
    backend: actualBackend,
  };
  const engine = () =>
    createTakoformV2Engine({
      sql: createSqliteSql(db),
      now: () => new Date(time),
      replayWindowSeconds: 120,
      leaseMilliseconds: 1_000,
      async authorize(principal, space) {
        return principal === "alice" && space === "default";
      },
      forms: { [FORM]: form },
    });
  return {
    db,
    engine,
    calls,
    advance(ms: number) {
      time += ms;
    },
  };
}

async function acceptCreate(engine: ReturnType<ReturnType<typeof fixture>["engine"]>, key = KEY) {
  return engine.acceptCreate({
    principal: "alice",
    key,
    input: { form: FORM, space: "default", name: "demo", spec: { value: "one" } },
  });
}

test("one atomic create wins concurrent replay and name claim", async () => {
  const { db, engine, calls } = fixture();
  const first = engine();
  const second = engine();
  const [a, b] = await Promise.all([acceptCreate(first), acceptCreate(second)]);
  expect(a.id).toBe(b.id);
  expect(a.resourceUid).toBe(b.resourceUid);
  expect(a.status).toBe("queued");
  expect(calls).toEqual([]);
  expect((db.query("SELECT count(*) AS n FROM tf_v2_resources").get() as { n: number }).n).toBe(1);
  expect((db.query("SELECT count(*) AS n FROM tf_v2_operations").get() as { n: number }).n).toBe(1);
  await expect(
    first.acceptCreate({
      principal: "alice",
      key: "another-operation-key-000001",
      input: { form: FORM, space: "default", name: "demo", spec: { value: "two" } },
    }),
  ).rejects.toMatchObject({ code: "name_conflict", status: 409 });
  await expect(
    first.acceptCreate({
      principal: "alice",
      key: KEY,
      input: { form: FORM, space: "default", name: "demo", spec: { value: "two" } },
    }),
  ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  await expect(first.getOperation({ principal: "bob", id: a.id })).rejects.toMatchObject({
    code: "not_found",
  });
});

test("replay precedes generation checks; failed resource retains UID/name for recovery", async () => {
  let count = 0;
  const { engine, calls } = fixture({
    async execute(input): Promise<V2BackendResult> {
      calls.push(input.action);
      count += 1;
      if (count === 1) return { kind: "partial", code: "incomplete", message: "repair required" };
      return { kind: "complete", observed: { exists: input.action !== "delete" }, output: {} };
    },
  });
  const core = engine();
  const created = await acceptCreate(core);
  const failed = await core.runNext();
  expect(failed).toMatchObject({ id: created.id, status: "failed", effect: "partial" });
  const resource = await core.getResource({ principal: "alice", uid: created.resourceUid });
  expect(resource).toMatchObject({ phase: "error", generation: 1, observedGeneration: 0 });
  expect((await acceptCreate(core)).id).toBe(created.id);
  const updated = await core.acceptUpdate({
    principal: "alice",
    key: "updated-operation-key-0000001",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: { value: "two" },
  });
  expect(updated.generation).toBe(2);
  await expect(
    core.acceptUpdate({
      principal: "alice",
      key: "updated-operation-key-0000002",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { value: "three" },
    }),
  ).rejects.toMatchObject({ code: "resource_busy" });
  expect((await core.runNext())?.status).toBe("succeeded");
  expect(
    (await core.getResource({ principal: "alice", uid: created.resourceUid })).observedGeneration,
  ).toBe(2);
  expect(
    (
      await core.acceptUpdate({
        principal: "alice",
        key: "updated-operation-key-0000001",
        uid: created.resourceUid,
        expectedGeneration: 1,
        spec: { value: "two" },
      })
    ).id,
  ).toBe(updated.id);
  expect(calls).toEqual(["create", "update"]);
});

test("dispatched uncertainty reconciles same key and old claimed worker cannot settle", async () => {
  let release!: (result: V2BackendResult) => void;
  const { db, engine, advance, calls } = fixture({
    async execute(input): Promise<V2BackendResult> {
      calls.push(`execute:${input.backendKey}`);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    async reconcile(input): Promise<V2BackendResult> {
      calls.push(`reconcile:${input.backendKey}`);
      return { kind: "complete", observed: { exists: true }, output: { id: input.backendKey } };
    },
  });
  const original = engine();
  const admitted = await acceptCreate(original);
  const oldWorker = original.runNext();
  while (!release) await Bun.sleep(1);
  const inFlight = await original.getOperation({ principal: "alice", id: admitted.id });
  expect(inFlight).toMatchObject({ status: "reconciling", effect: "unknown" });
  advance(1_001);
  const restarted = engine();
  expect((await restarted.runNext())?.status).toBe("succeeded");
  release({ kind: "no_effect", code: "stale", message: "stale" });
  expect((await oldWorker)?.status).toBe("succeeded");
  expect(calls).toEqual([`execute:${admitted.id}`, `reconcile:${admitted.id}`]);
  const row = db
    .query("SELECT status, effect FROM tf_v2_operations WHERE id = ?")
    .get(admitted.id) as {
    status: string;
    effect: string;
  };
  expect(row).toEqual({ status: "succeeded", effect: "complete" });
});

test("delete holds name until confirmed then releases it, retaining terminal replay", async () => {
  const { engine, advance } = fixture();
  const core = engine();
  const created = await acceptCreate(core);
  await core.runNext();
  const deletion = await core.acceptDelete({
    principal: "alice",
    key: "deleted-operation-key-0000001",
    uid: created.resourceUid,
    expectedGeneration: 1,
  });
  await expect(
    core.acceptCreate({
      principal: "alice",
      key: "second-create-key-00000001",
      input: { form: FORM, space: "default", name: "demo", spec: { value: "new" } },
    }),
  ).rejects.toMatchObject({ code: "name_conflict" });
  advance(130_000);
  const completed = await core.runNext();
  expect(completed?.status).toBe("succeeded");
  expect(Date.parse(completed?.retainUntil ?? "")).toBeGreaterThan(
    Date.parse(deletion.retainUntil),
  );
  await expect(
    core.getResource({ principal: "alice", uid: created.resourceUid }),
  ).rejects.toMatchObject({
    code: "gone",
  });
  const replacement = await core.acceptCreate({
    principal: "alice",
    key: "second-create-key-00000001",
    input: { form: FORM, space: "default", name: "demo", spec: { value: "new" } },
  });
  expect(replacement.resourceUid).not.toBe(created.resourceUid);
  expect(
    (
      await core.acceptDelete({
        principal: "alice",
        key: "deleted-operation-key-0000001",
        uid: created.resourceUid,
        expectedGeneration: 1,
      })
    ).id,
  ).toBe(deletion.id);
});

test("unknown backend result never becomes none; confirmed no-effect reconciles without another send", async () => {
  const calls: string[] = [];
  const { engine, db, advance } = fixture({
    async execute(input) {
      calls.push(`execute:${input.backendKey}`);
      return { kind: "unknown" };
    },
    async reconcile(input) {
      calls.push(`reconcile:${input.backendKey}`);
      return { kind: "no_effect", code: "not_sent", message: "confirmed not sent" };
    },
  });
  const core = engine();
  const admitted = await acceptCreate(core);
  expect(await core.runNext()).toMatchObject({
    status: "reconciling",
    effect: "unknown",
    error: { code: "outcome_unconfirmed" },
  });
  expect(await core.runNext()).toBeNull();
  advance(1_000);
  expect(await core.runNext()).toMatchObject({ status: "failed", effect: "none" });
  expect(calls).toEqual([`execute:${admitted.id}`, `reconcile:${admitted.id}`]);
  const row = db
    .query("SELECT phase, active_name FROM tf_v2_resources WHERE uid = ?")
    .get(admitted.resourceUid) as { phase: string; active_name: string };
  expect(row).toEqual({ phase: "error", active_name: "demo" });
});

test("uncertain oldest operation is backed off so a newer queued resource can run", async () => {
  const calls: string[] = [];
  const { engine, advance, db } = fixture({
    async execute(input) {
      calls.push(`execute:${input.name}`);
      if (input.name === "demo") {
        return { kind: "unknown", code: "awaiting_receipt", message: "Awaiting receipt" };
      }
      return { kind: "complete", observed: { exists: true }, output: {} };
    },
    async reconcile(input) {
      calls.push(`reconcile:${input.name}`);
      return { kind: "unknown", code: "awaiting_receipt", message: "Awaiting receipt" };
    },
  });
  const core = engine();
  const a = await acceptCreate(core);
  expect(await core.runNext()).toMatchObject({
    id: a.id,
    status: "reconciling",
    effect: "unknown",
    error: { code: "awaiting_receipt" },
  });
  const b = await core.acceptCreate({
    principal: "alice",
    key: "younger-queued-key-00000001",
    input: { form: FORM, space: "default", name: "other", spec: { value: "two" } },
  });
  expect(await core.runNext()).toMatchObject({ id: b.id, status: "succeeded" });
  expect(calls).toEqual(["execute:demo", "execute:other"]);
  const persisted = db
    .query("SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id = ?")
    .get(a.id) as { next_attempt_at_ms: number };
  expect(persisted.next_attempt_at_ms).toBeGreaterThan(Date.parse("2026-10-06T00:00:00Z"));
  advance(1_000);
  expect(await core.runNext()).toMatchObject({ id: a.id, status: "reconciling" });
  expect(calls).toEqual(["execute:demo", "execute:other", "reconcile:demo"]);
});

test("accepted backend selection survives config changes and refuses execution elsewhere", async () => {
  const { db, engine, advance } = fixture();
  const core = engine();
  const admitted = await acceptCreate(core);
  const changed = createTakoformV2Engine({
    sql: createSqliteSql(db),
    now: () => new Date("2026-10-06T00:00:00Z"),
    replayWindowSeconds: 120,
    leaseMilliseconds: 1_000,
    async authorize() {
      return true;
    },
    forms: {
      [FORM]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "different-implementation",
          targetKey: "different-target",
          async execute() {
            throw new Error("must not execute");
          },
          async reconcile() {
            throw new Error("must not reconcile");
          },
        },
      },
    },
  });
  await expect(changed.runNext()).rejects.toMatchObject({
    code: "temporarily_unavailable",
    status: 503,
  });
  expect(await core.getOperation({ principal: "alice", id: admitted.id })).toMatchObject({
    status: "queued",
    effect: "none",
  });
  advance(1_000);
  await core.runNext();
  await expect(
    changed.acceptUpdate({
      principal: "alice",
      key: "retarget-update-key-00000001",
      uid: admitted.resourceUid,
      expectedGeneration: 1,
      spec: { value: "moved" },
    }),
  ).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
  await expect(
    changed.acceptDelete({
      principal: "alice",
      key: "retarget-delete-key-00000001",
      uid: admitted.resourceUid,
      expectedGeneration: 1,
    }),
  ).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
  expect(
    (await core.getResource({ principal: "alice", uid: admitted.resourceUid })).generation,
  ).toBe(1);
});

test("missing original target is deferred instead of starving another Form's queued work", async () => {
  const { db, engine, advance } = fixture();
  const first = await acceptCreate(engine());
  advance(1);
  const secondForm = "https://forms.example.test/other/1.0.0";
  const calls: string[] = [];
  const changed = createTakoformV2Engine({
    sql: createSqliteSql(db),
    now: () => new Date("2026-10-06T00:00:00.001Z"),
    replayWindowSeconds: 120,
    leaseMilliseconds: 1_000,
    async authorize() {
      return true;
    },
    forms: {
      [FORM]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "changed",
          targetKey: "changed",
          async execute() {
            throw new Error("must not retarget");
          },
          async reconcile() {
            throw new Error("must not retarget");
          },
        },
      },
      [secondForm]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "second",
          targetKey: "second",
          async execute(input) {
            calls.push(input.name);
            return { kind: "complete", observed: {}, output: {} };
          },
          async reconcile() {
            return { kind: "unknown" };
          },
        },
      },
    },
  });
  const second = await changed.acceptCreate({
    principal: "alice",
    key: "other-form-queued-00000001",
    input: { form: secondForm, space: "default", name: "other", spec: {} },
  });
  expect(await changed.runNext()).toMatchObject({ id: second.id, status: "succeeded" });
  expect(calls).toEqual(["other"]);
  expect(await changed.getOperation({ principal: "alice", id: first.id })).toMatchObject({
    status: "queued",
    effect: "none",
  });
  const deferred = db
    .query("SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id = ?")
    .get(first.id) as { next_attempt_at_ms: number };
  expect(deferred.next_attempt_at_ms).toBeGreaterThan(Date.parse("2026-10-06T00:00:00Z"));
});

test("Form identity is exact and unsupported URL never creates an authority row", async () => {
  const { db, engine } = fixture();
  await expect(
    engine().acceptCreate({
      principal: "alice",
      key: "unknown-form-key-0000000001",
      input: {
        form: "https://FORMS.example.test/unit/1.0.0",
        space: "default",
        name: "demo",
        spec: { value: "one" },
      },
    }),
  ).rejects.toMatchObject({ code: "unsupported_form", status: 422 });
  expect((db.query("SELECT count(*) AS n FROM tf_v2_resources").get() as { n: number }).n).toBe(0);
});

test("resource list applies exact SQL filters and UID keyset pages", async () => {
  const { engine } = fixture();
  const core = engine();
  await acceptCreate(core);
  await core.acceptCreate({
    principal: "alice",
    key: "second-list-key-0000000001",
    input: { form: FORM, space: "default", name: "other", spec: { value: "two" } },
  });
  const first = await core.listResources({ principal: "alice", limit: 1 });
  const cursor = first[0]?.uid;
  if (!cursor) throw new Error("expected first page cursor");
  const second = await core.listResources({
    principal: "alice",
    limit: 1,
    afterUid: cursor,
  });
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0]?.uid).not.toBe(second[0]?.uid);
  expect(await core.listResources({ principal: "alice", limit: 10, name: "other" })).toMatchObject([
    { name: "other" },
  ]);
  expect(
    await core.listResources({ principal: "alice", limit: 10, form: "https://other.example/f/1" }),
  ).toEqual([]);
});
