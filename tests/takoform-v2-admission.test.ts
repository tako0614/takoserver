import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Sql, SqlParam } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/unit/Admission/1.0.0/";

function fixture() {
  const db = new Database(":memory:");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const rawSql = createSqliteSql(db);
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hold = false;
  let batchGate: Promise<void> | null = null;
  let batchEntered: (() => void) | null = null;
  const sql: Sql = {
    query: rawSql.query,
    run: rawSql.run,
    async batch(statements) {
      if (batchGate && statements.some((statement) => statement.sql.includes("admission_target"))) {
        batchEntered?.();
        await batchGate;
      }
      return rawSql.batch(statements);
    },
  };
  let allowed = true;
  let admissionCalls = 0;
  let admissionPredicate: {
    sql: string;
    params: SqlParam[];
    conflictCode?: "dependency_conflict" | "resource_busy";
  } = {
    sql: "EXISTS (SELECT 1 FROM admission_target WHERE ready = 1)",
    params: [],
  };
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    async prepareAdmission() {
      admissionCalls += 1;
      if (hold) await gate;
      return admissionPredicate;
    },
    backend: {
      id: "admission-test-backend",
      targetKey: "fixture",
      async execute() {
        return { kind: "complete", observed: {}, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  db.exec("CREATE TABLE admission_target (ready INTEGER NOT NULL)");
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3600,
    authorize: async () => allowed,
    forms: { [FORM]: form },
  });
  return {
    db,
    engine,
    hold: () => {
      hold = true;
    },
    release: () => release?.(),
    setAllowed(value: boolean) {
      allowed = value;
    },
    admissionCalls: () => admissionCalls,
    setPredicate(value: typeof admissionPredicate) {
      admissionPredicate = value;
    },
    holdBatch() {
      let resume: (() => void) | null = null;
      const entered = new Promise<void>((resolve) => {
        batchEntered = resolve;
      });
      batchGate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return {
        entered,
        release() {
          batchGate = null;
          batchEntered = null;
          resume?.();
        },
      };
    },
  };
}

test("admission refusal leaves no Resource, Operation, or replay key", async () => {
  const { db, engine } = fixture();
  const request = {
    principal: "alice",
    key: "admission-create-key-0001",
    input: { form: FORM, space: "default", name: "consumer", spec: {} },
  };
  await expect(engine.acceptCreate(request)).rejects.toMatchObject({
    code: "dependency_conflict",
    status: 409,
  });
  expect(db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 0 });
  db.exec("INSERT INTO admission_target VALUES (1)");
  const accepted = await engine.acceptCreate(request);
  expect(accepted.status).toBe("queued");
  expect((await engine.acceptCreate(request)).id).toBe(accepted.id);
});

test("admission predicate is evaluated in the accepting write after asynchronous preparation", async () => {
  const { db, engine, hold, release } = fixture();
  db.exec("INSERT INTO admission_target VALUES (1)");
  hold();
  const pending = engine.acceptCreate({
    principal: "alice",
    key: "admission-create-key-0002",
    input: { form: FORM, space: "default", name: "consumer", spec: {} },
  });
  // The hook is suspended after authorization/replay and before acceptance.
  await Bun.sleep(0);
  db.exec("UPDATE admission_target SET ready = 0");
  release();
  await expect(pending).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
  expect(db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 0 });
});

test("transient CREATE admission races report busy without consuming the request", async () => {
  const f = fixture();
  f.db.exec("INSERT INTO admission_target VALUES (1)");
  const predicate = {
    sql: "EXISTS (SELECT 1 FROM admission_target WHERE ready = 1)",
    params: [] as SqlParam[],
    conflictCode: "resource_busy" as "resource_busy" | "dependency_conflict",
  };
  f.setPredicate(predicate);
  const request = {
    principal: "alice",
    key: "admission-transient-create-0001",
    input: { form: FORM, space: "default", name: "consumer", spec: {} },
  };
  const held = f.holdBatch();
  const pending = f.engine.acceptCreate(request);
  try {
    await held.entered;
    f.db.exec("UPDATE admission_target SET ready = 0");
    // The trusted hook's caller cannot change the captured failure classification.
    predicate.conflictCode = "dependency_conflict";
  } finally {
    held.release();
  }
  await expect(pending).rejects.toMatchObject({ code: "resource_busy", status: 409 });
  expect(
    await f.engine.listResources({ principal: "alice", space: "default", limit: 100 }),
  ).toEqual([]);
  f.db.exec("UPDATE admission_target SET ready = 1");
  const accepted = await f.engine.acceptCreate(request);
  expect(accepted.status).toBe("queued");
  expect((await f.engine.acceptCreate(request)).id).toBe(accepted.id);
});

test("UPDATE admission refusal leaves prior Resource generation and replay key intact", async () => {
  const { db, engine } = fixture();
  db.exec("INSERT INTO admission_target VALUES (1)");
  const created = await engine.acceptCreate({
    principal: "alice",
    key: "admission-create-key-0003",
    input: { form: FORM, space: "default", name: "consumer", spec: { value: 1 } },
  });
  expect((await engine.runNext())?.status).toBe("succeeded");
  db.exec("UPDATE admission_target SET ready = 0");
  const request = {
    principal: "alice",
    key: "admission-update-key-0003",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: { value: 2 },
  };
  await expect(engine.acceptUpdate(request)).rejects.toMatchObject({
    code: "dependency_conflict",
    status: 409,
  });
  expect(await engine.getResource({ principal: "alice", uid: created.resourceUid })).toMatchObject({
    generation: 1,
    spec: { value: 1 },
  });
  expect(db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 1 });
  db.exec("UPDATE admission_target SET ready = 1");
  const accepted = await engine.acceptUpdate(request);
  expect(accepted.generation).toBe(2);
  expect((await engine.acceptUpdate(request)).id).toBe(accepted.id);
});

test("transient UPDATE admission races keep the prior generation and allow exact retry", async () => {
  const f = fixture();
  f.db.exec("INSERT INTO admission_target VALUES (1)");
  const created = await f.engine.acceptCreate({
    principal: "alice",
    key: "admission-transient-base-0001",
    input: { form: FORM, space: "default", name: "consumer", spec: { value: 1 } },
  });
  expect((await f.engine.runNext())?.status).toBe("succeeded");
  f.setPredicate({
    sql: "EXISTS (SELECT 1 FROM admission_target WHERE ready = 1)",
    params: [],
    conflictCode: "resource_busy",
  });
  const request = {
    principal: "alice",
    key: "admission-transient-update-0001",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: { value: 2 },
  };
  const held = f.holdBatch();
  const pending = f.engine.acceptUpdate(request);
  try {
    await held.entered;
    f.db.exec("UPDATE admission_target SET ready = 0");
  } finally {
    held.release();
  }
  await expect(pending).rejects.toMatchObject({ code: "resource_busy", status: 409 });
  expect(
    await f.engine.getResource({ principal: "alice", uid: created.resourceUid }),
  ).toMatchObject({
    generation: 1,
    spec: { value: 1 },
    phase: "idle",
  });
  f.db.exec("UPDATE admission_target SET ready = 1");
  const accepted = await f.engine.acceptUpdate(request);
  expect(accepted.generation).toBe(2);
  expect((await f.engine.acceptUpdate(request)).id).toBe(accepted.id);
});

test("invalid trusted admission classifications cannot write a Resource", async () => {
  const f = fixture();
  f.db.exec("INSERT INTO admission_target VALUES (1)");
  f.setPredicate({
    sql: "EXISTS (SELECT 1 FROM admission_target WHERE ready = 1)",
    params: [],
    conflictCode: "other" as "resource_busy",
  });
  await expect(
    f.engine.acceptCreate({
      principal: "alice",
      key: "admission-invalid-code-0001",
      input: { form: FORM, space: "default", name: "consumer", spec: {} },
    }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(
    await f.engine.listResources({ principal: "alice", space: "default", limit: 100 }),
  ).toEqual([]);
});

test("authorization, exact replay and unknown Form lookup precede trusted admission preparation", async () => {
  const f = fixture();
  f.db.exec("INSERT INTO admission_target VALUES (1)");
  const request = {
    principal: "alice",
    key: "admission-order-key-0001",
    input: { form: FORM, space: "default", name: "consumer", spec: {} },
  };
  f.setAllowed(false);
  await expect(f.engine.acceptCreate(request)).rejects.toMatchObject({ status: 403 });
  expect(f.admissionCalls()).toBe(0);
  f.setAllowed(true);
  const accepted = await f.engine.acceptCreate(request);
  expect(f.admissionCalls()).toBe(1);
  expect((await f.engine.acceptCreate(request)).id).toBe(accepted.id);
  expect(f.admissionCalls()).toBe(1);
  await expect(
    f.engine.acceptCreate({
      ...request,
      key: "unknown-form-order-key-0001",
      input: { ...request.input, form: "https://forms.example.test/unit/Unknown/1.0.0/" },
    }),
  ).rejects.toMatchObject({ status: 422 });
  expect(f.admissionCalls()).toBe(1);
});

test("mutable Form predicate parameters cannot retarget an awaited SQL acceptance batch", async () => {
  const f = fixture();
  f.db.exec("INSERT INTO admission_target VALUES (1)");
  const params: SqlParam[] = ["safe"];
  f.setPredicate({
    sql: "EXISTS (SELECT 1 FROM admission_target WHERE ready = 1) AND ? = 'safe'",
    params,
  });
  const held = f.holdBatch();
  const pending = f.engine.acceptCreate({
    principal: "alice",
    key: "admission-param-snapshot-0001",
    input: { form: FORM, space: "default", name: "consumer", spec: {} },
  });
  try {
    await held.entered;
    params[0] = "wrong";
  } finally {
    held.release();
  }
  const accepted = await pending;
  expect(accepted.status).toBe("queued");
  expect(f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 1 });
  expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 1 });
});
