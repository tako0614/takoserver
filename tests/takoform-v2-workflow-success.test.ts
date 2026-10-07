import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  DURABLE_WORKFLOW_FORM_URL,
  DurableWorkflowValidationError,
  durableWorkflowReferences,
  parseDurableWorkflowSpec,
  validateDurableWorkflowUpdate,
} from "../src/takoform-v2/forms/durable-workflow.ts";
import { MODULE_WORKER_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import { createTakoformV2Host } from "../src/takoform-v2/host.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";
import { createDurableWorkflowForm } from "../src/takoform-v2/workflow-backend.ts";
import { executeWorkflowClass, type WorkflowClassStep } from "../src/workflow-class-execution.ts";
import { createWorkflowRuntime } from "../src/workflow-execution.ts";
import { createV2WorkflowResourceAuthority } from "../src/workflow-v2-resource-authority.ts";

const TARGET = "selfhost-workflow-test";
const START = Date.UTC(2026, 9, 7);
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

test("exact v2 Workflow spec is immutable and references only its accepted Worker UID", () => {
  const spec = { worker: { resourceUid: "worker-uid" }, className: "ReportWorkflow" };
  expect(DURABLE_WORKFLOW_FORM_URL).toBe(
    "https://edge.forms.takoform.com/forms/DurableWorkflow/0.3.0/",
  );
  expect(parseDurableWorkflowSpec(spec)).toEqual(spec);
  expect(
    validateDurableWorkflowUpdate(spec, { className: "ReportWorkflow", worker: spec.worker }),
  ).toEqual(spec);
  expect(durableWorkflowReferences(spec)).toEqual([
    {
      resourceUid: "worker-uid",
      formUrl: MODULE_WORKER_FORM_URL,
      readiness: "observed",
    },
  ]);
  for (const invalid of [
    null,
    [],
    { ...spec, extra: true },
    { ...spec, className: "1Bad" },
    { ...spec, worker: { resourceUid: "worker-uid", name: "alias" } },
    { ...spec, worker: null },
  ])
    expect(() => parseDurableWorkflowSpec(invalid)).toThrow(DurableWorkflowValidationError);
  expect(() => validateDurableWorkflowUpdate(spec, { ...spec, className: "Other" })).toThrow(
    DurableWorkflowValidationError,
  );
});

function setup(sql: Sql, time: { now: number }, effects: { count: number; stops?: number }) {
  const clock = () => new Date(time.now);
  let id = 0;
  const authority = createV2WorkflowResourceAuthority(sql);
  const runtime = createWorkflowRuntime({
    sql,
    clock,
    randomId: () => `workflow-private-${++id}`,
    waitUntil: (_at, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    v2ResourceAuthority: authority,
    // Synthetic isolated-class port. This test proves SQL/contract plumbing,
    // not a real workerd class or physical-stop qualification.
    host: {
      async openPaused(identity, params) {
        return {
          run: (driver) =>
            executeWorkflowClass({
              namespace: {
                ReportWorkflow: class {
                  async run(_event: unknown, step: WorkflowClassStep): Promise<JsonObject> {
                    const result = await step.do("result", async () => {
                      effects.count += 1;
                      return { value: 7 };
                    });
                    await step.sleep("pause", 2);
                    return result ?? {};
                  }
                },
              },
              className: "ReportWorkflow",
              env: {},
              instanceId: identity.instanceId,
              ...(params === undefined ? {} : { params }),
              driver,
            }),
          async extendDeadline() {},
        };
      },
      async stop() {
        if (typeof effects.stops === "number") effects.stops += 1;
        return "stopped" as const;
      },
    },
  });
  const worker: V2Form = {
    validateCreate(spec) {
      if (Object.keys(spec).length) throw new Error("invalid Worker fixture");
    },
    validateUpdate(_previous, spec) {
      if (Object.keys(spec).length) throw new Error("invalid Worker fixture");
    },
    backend: {
      id: "fixture-v2-worker",
      targetKey: TARGET,
      async execute() {
        return { kind: "complete", observed: { ready: true }, output: {} };
      },
      async reconcile() {
        return { kind: "complete", observed: { ready: true }, output: {} };
      },
    },
  };
  const workflow = createDurableWorkflowForm({
    sql,
    clock,
    targetKey: TARGET,
    runtime,
    classAdmission: {
      async prepare() {
        return { kind: "qualified", predicate: { sql: "1 = 1", params: [] } };
      },
      async observe() {
        return "ready";
      },
    },
  });
  const engine = createTakoformV2Engine({
    sql,
    now: clock,
    replayWindowSeconds: 3_600,
    authorize: async (principal, space) => principal === "alice" && space === "default",
    forms: { [MODULE_WORKER_FORM_URL]: worker, [DURABLE_WORKFLOW_FORM_URL]: workflow },
  });
  return {
    engine,
    runtime,
    authority,
    forms: { [MODULE_WORKER_FORM_URL]: worker, [DURABLE_WORKFLOW_FORM_URL]: workflow },
  };
}

test("synthetic accepted Workflow CRUD traverses the v2 HTTP Resource and Operation routes", async () => {
  const db = new Database(":memory:");
  dbs.push(db);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const time = { now: START };
  const { forms } = setup(sql, time, { count: 0 });
  const host = createTakoformV2Host({
    sql,
    now: () => new Date(time.now),
    replayWindowSeconds: 3_600,
    authorize: async (principal, space) => principal === "alice" && space === "default",
    forms,
    baseUrl: "https://host.example/takoform/v2",
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/v2/auth",
    authenticationSchemes: ["Bearer"],
    maxRequestBytes: 4_096,
    maxPageSize: 10,
    cursorSigningKey: new Uint8Array(32).fill(0x5a),
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer alice"
        ? { principal: "alice", access: "write" }
        : null,
  });
  const fetch = async (path: string, init: RequestInit = {}) => {
    const response = await host.fetch(
      new Request(`https://host.example/takoform/v2${path}`, {
        ...init,
        headers: {
          authorization: "Bearer alice",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
      }),
    );
    if (!response) throw new Error("v2 route did not handle request");
    return response;
  };
  const create = async (name: string, form: string, spec: JsonObject, key: string) => {
    const response = await fetch("/resources", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: JSON.stringify({ form, space: "default", name, spec }),
    });
    expect(response.status).toBe(202);
    return (await response.json()) as { id: string; resourceUid: string };
  };
  const worker = await create("worker", MODULE_WORKER_FORM_URL, {}, "http-worker-create");
  expect(await host.runNext()).toMatchObject({ id: worker.id, status: "succeeded" });
  const workflow = await create(
    "workflow",
    DURABLE_WORKFLOW_FORM_URL,
    { worker: { resourceUid: worker.resourceUid }, className: "ReportWorkflow" },
    "http-workflow-create",
  );
  expect(await host.runNext()).toMatchObject({ id: workflow.id, status: "succeeded" });
  expect((await fetch(`/resources/${workflow.resourceUid}`)).status).toBe(200);
  const deleted = await fetch(`/resources/${workflow.resourceUid}`, {
    method: "DELETE",
    headers: { "idempotency-key": "http-workflow-delete", "takoform-expected-generation": "1" },
  });
  expect(deleted.status).toBe(202);
  expect(await host.runNext()).toMatchObject({ status: "succeeded", action: "delete" });
  expect((await fetch(`/resources/${workflow.resourceUid}`)).status).toBe(410);
});

test("synthetic v2 accepted CRUD, step/replay, stop and explicit DELETE survive SQL reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-workflow-"));
  const path = join(root, "host.sqlite");
  let db: Database | undefined;
  try {
    db = new Database(path);
    migrateSqlite(db);
    const time = { now: START };
    const effects = { count: 0 };
    let { engine, runtime, authority } = setup(createSqliteSql(db), time, effects);
    const worker = await engine.acceptCreate({
      principal: "alice",
      key: "workflow-worker-key",
      input: {
        form: MODULE_WORKER_FORM_URL,
        space: "default",
        name: "worker",
        spec: {},
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: worker.id, status: "succeeded" });
    const workflow = await engine.acceptCreate({
      principal: "alice",
      key: "workflow-create-key",
      input: {
        form: DURABLE_WORKFLOW_FORM_URL,
        space: "default",
        name: "reports",
        spec: { worker: { resourceUid: worker.resourceUid }, className: "ReportWorkflow" },
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: workflow.id, status: "succeeded" });
    const sibling = await engine.acceptCreate({
      principal: "alice",
      key: "workflow-duplicate-class-key",
      input: {
        form: DURABLE_WORKFLOW_FORM_URL,
        space: "default",
        name: "duplicate-class",
        spec: { worker: { resourceUid: worker.resourceUid }, className: "ReportWorkflow" },
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: sibling.id, status: "succeeded" });
    const siblingScope = { tenantId: "alice", workflowResourceUid: sibling.resourceUid };
    await runtime.instances.create(siblingScope, { id: "run-one" });
    expect(await runtime.instances.status(siblingScope, "run-one")).toEqual({ status: "queued" });
    expect(
      (await engine.getResource({ principal: "alice", uid: workflow.resourceUid })).observed,
    ).toMatchObject({ ready: true, instanceCounts: { queued: 0 } });
    const scope = { tenantId: "alice", workflowResourceUid: workflow.resourceUid };
    await runtime.instances.create(scope, { id: "run-one", params: { request: true } });
    expect(await runtime.runOne(scope, "run-one")).toMatchObject({ kind: "parked" });
    expect(await runtime.instances.status(scope, "run-one")).toEqual({ status: "sleeping" });
    expect(effects.count).toBe(1);
    // A reopened engine is bound to a newly boot-selected authority and SQL;
    // no in-memory Resource or instance ledger is needed for read/replay.
    db.close();
    db = undefined;
    db = new Database(path);
    ({ engine, runtime, authority } = setup(createSqliteSql(db), time, effects));
    expect(authority.kind).toBe("takoserver.v2-workflow-resource-authority");
    time.now += 2_001;
    expect(await runtime.runOne(scope, "run-one")).toMatchObject({ kind: "complete" });
    expect(await runtime.instances.status(scope, "run-one")).toEqual({
      status: "complete",
      output: { value: 7 },
    });
    expect(effects.count).toBe(1);
    await runtime.instances.create(scope, { id: "queued-for-delete" });
    const deleted = await engine.acceptDelete({
      principal: "alice",
      key: "workflow-delete-key",
      uid: workflow.resourceUid,
      expectedGeneration: 1,
    });
    await expect(runtime.instances.create(scope, { id: "late" })).rejects.toMatchObject({
      code: "unknown_instance",
    });
    await expect(
      runtime.instances.sendEvent(scope, "queued-for-delete", { type: "late" }),
    ).rejects.toBeDefined();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const operation = await engine.runNext();
      if (operation?.id === deleted.id && operation.status === "succeeded") break;
      time.now += 1_001;
    }
    expect(await engine.getOperation({ principal: "alice", id: deleted.id })).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    await expect(runtime.instances.create(scope, { id: "late" })).rejects.toMatchObject({
      code: "unknown_instance",
    });
    const rows = await createSqliteSql(db).query(
      "SELECT 1 FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = ?",
      [scope.tenantId, scope.workflowResourceUid],
    );
    expect(rows).toHaveLength(0);
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 instance INSERT loses atomically to accepted Resource DELETE without orphan history", async () => {
  const db = new Database(":memory:");
  dbs.push(db);
  migrateSqlite(db);
  const base = createSqliteSql(db);
  let beforeInstanceBatch: (() => Promise<void>) | undefined;
  const sql: Sql = {
    query: (statement, params) => base.query(statement, params),
    run: (statement, params) => base.run(statement, params),
    batch: async (statements) => {
      if (
        beforeInstanceBatch &&
        statements.some((item) => item.sql.includes("INSERT INTO tf_workflow_instances"))
      ) {
        const hook = beforeInstanceBatch;
        beforeInstanceBatch = undefined;
        await hook();
      }
      return base.batch(statements);
    },
  };
  const time = { now: START };
  const { engine, runtime } = setup(sql, time, { count: 0 });
  const worker = await engine.acceptCreate({
    principal: "alice",
    key: "race-worker-create-key",
    input: {
      form: MODULE_WORKER_FORM_URL,
      space: "default",
      name: "worker",
      spec: {},
    },
  });
  await engine.runNext();
  const workflow = await engine.acceptCreate({
    principal: "alice",
    key: "race-workflow-create-key",
    input: {
      form: DURABLE_WORKFLOW_FORM_URL,
      space: "default",
      name: "workflow",
      spec: { worker: { resourceUid: worker.resourceUid }, className: "ReportWorkflow" },
    },
  });
  await engine.runNext();
  beforeInstanceBatch = async () => {
    await engine.acceptDelete({
      principal: "alice",
      key: "race-workflow-delete-key",
      uid: workflow.resourceUid,
      expectedGeneration: 1,
    });
  };
  await expect(
    runtime.instances.create(
      {
        tenantId: "alice",
        workflowResourceUid: workflow.resourceUid,
      },
      { id: "racing" },
    ),
  ).rejects.toMatchObject({ code: "unknown_instance" });
  expect(
    await sql.query("SELECT 1 FROM tf_workflow_instances WHERE workflow_resource_uid = ?", [
      workflow.resourceUid,
    ]),
  ).toHaveLength(0);
});

test("v2 DELETE purges unswept expired terminal rows only after retained owners stop", async () => {
  const db = new Database(":memory:");
  dbs.push(db);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const time = { now: START };
  const effects = { count: 0, stops: 0 };
  const { engine, runtime } = setup(sql, time, effects);
  const worker = await engine.acceptCreate({
    principal: "alice",
    key: "expired-worker-create",
    input: { form: MODULE_WORKER_FORM_URL, space: "default", name: "worker", spec: {} },
  });
  await engine.runNext();
  const workflow = await engine.acceptCreate({
    principal: "alice",
    key: "expired-workflow-create",
    input: {
      form: DURABLE_WORKFLOW_FORM_URL,
      space: "default",
      name: "workflow",
      spec: { worker: { resourceUid: worker.resourceUid }, className: "ReportWorkflow" },
    },
  });
  await engine.runNext();
  const scope = { tenantId: "alice", workflowResourceUid: workflow.resourceUid };
  await runtime.instances.create(scope, { id: "expired-terminal" });
  await runtime.instances.terminate(scope, "expired-terminal");
  await runtime.instances.create(scope, { id: "expired-with-owner" });
  await runtime.instances.terminate(scope, "expired-with-owner");
  time.now += 2_592_001_000;
  await sql.run(
    `UPDATE tf_workflow_instances
      SET run_owner = 'retained-owner', run_lease_until = ?, run_epoch = 1
      WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?`,
    [time.now + 10_000, scope.tenantId, scope.workflowResourceUid, "expired-with-owner"],
  );
  await expect(runtime.instances.status(scope, "expired-terminal")).rejects.toMatchObject({
    code: "unknown_instance",
  });
  expect(
    await sql.query("SELECT 1 FROM tf_workflow_instances WHERE instance_id = ?", [
      "expired-terminal",
    ]),
  ).toHaveLength(1);
  const deleted = await engine.acceptDelete({
    principal: "alice",
    key: "expired-workflow-delete",
    uid: workflow.resourceUid,
    expectedGeneration: 1,
  });
  await engine.runNext();
  time.now += 1_001;
  expect(await engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
  expect(effects.stops).toBe(1);
  expect(
    await sql.query("SELECT 1 FROM tf_workflow_instances WHERE instance_id = ?", [
      "expired-terminal",
    ]),
  ).toHaveLength(0);
  expect(
    await sql.query("SELECT 1 FROM tf_workflow_instances WHERE instance_id = ?", [
      "expired-with-owner",
    ]),
  ).toHaveLength(0);
});
