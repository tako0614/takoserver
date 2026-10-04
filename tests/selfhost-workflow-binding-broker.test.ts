import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { openSelfhostWorkflowBindingBroker } from "../src/selfhost-workflow-binding-broker.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { WorkflowRuntimeError } from "../src/workflow-driver.ts";
import { createWorkflowInstances } from "../src/workflow-instances.ts";

const ROUTE = "http://workflow.invalid/__takoserver/workflow-binding/v1/";
const TOKEN_HEADER = "x-takoserver-private-workflow-binding-token";
const TOKEN = "a".repeat(64);
const SCHEMA = "takoserver.selfhost-workflow-binding-result@v1";
const SCOPE = { tenantId: "tenant-fixed", workflowResourceUid: "workflow-fixed" };

async function fixture(wrapSql?: (base: Sql) => Sql) {
  const directory = await mkdtemp(join(tmpdir(), "takoserver-workflow-binding-broker-"));
  await chmod(directory, 0o700);
  const db = new Database(":memory:");
  migrateSqlite(db);
  const base = createSqliteSql(db);
  const sql = wrapSql?.(base) ?? base;
  let nextId = 0;
  const instances = createWorkflowInstances({
    sql,
    clock: () => new Date(Date.UTC(2026, 9, 4)),
    randomId: () => `private-${++nextId}`,
  });
  const broker = await openSelfhostWorkflowBindingBroker({
    socketPath: join(directory, "binding.sock"),
    token: TOKEN,
    scope: SCOPE,
    instances,
  });
  const call = (operation: string, body: unknown) =>
    fetch(`${ROUTE}${operation}`, {
      method: "POST",
      unix: broker.socketPath,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    broker,
    instances,
    sql,
    call,
    async close() {
      await broker.close();
      db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("authenticated Unix binding create and get use only the fixed Workflow incarnation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takoserver-workflow-binding-broker-"));
  await chmod(directory, 0o700);
  const db = new Database(":memory:");
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let nextId = 0;
  const instances = createWorkflowInstances({
    sql,
    clock: () => new Date(Date.UTC(2026, 9, 4)),
    randomId: () => `private-${++nextId}`,
  });
  const broker = await openSelfhostWorkflowBindingBroker({
    socketPath: join(directory, "binding.sock"),
    token: TOKEN,
    scope: SCOPE,
    instances,
  });
  const call = (operation: string, body: unknown) =>
    fetch(`${ROUTE}${operation}`, {
      method: "POST",
      unix: broker.socketPath,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const created = await call("create", { id: "order-1", params: { order: 7 } });
    expect(created.ok).toBe(true);
    expect(await created.json()).toEqual({
      schema: SCHEMA,
      value: { id: "order-1", status: "queued" },
    });
    const got = await call("get", { id: "order-1" });
    expect(got.ok).toBe(true);
    expect(await got.json()).toEqual({ schema: SCHEMA, value: { id: "order-1" } });
    const queued = await call("status", { id: "order-1" });
    expect(await queued.json()).toEqual({ schema: SCHEMA, value: { status: "queued" } });
    const sent = await call("sendEvent", {
      id: "order-1",
      type: "approved",
      payload: { by: "owner" },
    });
    expect(await sent.json()).toEqual({ schema: SCHEMA, value: {} });
    const ended = await call("terminate", { id: "order-1" });
    expect(await ended.json()).toEqual({ schema: SCHEMA, value: {} });
    const terminal = await call("status", { id: "order-1" });
    expect(await terminal.json()).toEqual({ schema: SCHEMA, value: { status: "terminated" } });
    expect(await instances.get(SCOPE, "order-1")).toEqual({ id: "order-1" });
    await expect(
      instances.get({ tenantId: "tenant-other", workflowResourceUid: "workflow-fixed" }, "order-1"),
    ).rejects.toMatchObject({ code: "unknown_instance" });
  } finally {
    await broker.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retire joins a committed create after its caller disconnects without retrying", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let createBatches = 0;
  const f = await fixture((base) => ({
    ...base,
    async batch(statements) {
      if (
        statements.some((statement) => statement.sql.includes("INSERT INTO tf_workflow_instances"))
      ) {
        createBatches += 1;
        entered.resolve();
        await release.promise;
      }
      return base.batch(statements);
    },
  }));
  const abort = new AbortController();
  try {
    const lostReply = fetch(`${ROUTE}create`, {
      method: "POST",
      unix: f.broker.socketPath,
      signal: abort.signal,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ id: "lost-reply" }),
    });
    await entered.promise;
    abort.abort();
    await expect(lostReply).rejects.toBeDefined();
    let drained = false;
    const retiring = f.broker.retire().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drained).toBe(false);
    release.resolve();
    await retiring;
    expect(createBatches).toBe(1);
    expect(await f.instances.get(SCOPE, "lost-reply")).toEqual({ id: "lost-reply" });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("a lost sendEvent reply retains one event and never retries delivery", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let eventBatches = 0;
  const f = await fixture((base) => ({
    ...base,
    async batch(statements) {
      if (
        statements.some((statement) => statement.sql.includes("INSERT INTO tf_workflow_events"))
      ) {
        eventBatches += 1;
        entered.resolve();
        await release.promise;
      }
      return base.batch(statements);
    },
  }));
  const abort = new AbortController();
  try {
    expect((await f.call("create", { id: "event-owner" })).status).toBe(200);
    const lostReply = fetch(`${ROUTE}sendEvent`, {
      method: "POST",
      unix: f.broker.socketPath,
      signal: abort.signal,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ id: "event-owner", type: "approved", payload: { by: "owner" } }),
    });
    await entered.promise;
    abort.abort();
    await expect(lostReply).rejects.toBeDefined();
    const retiring = f.broker.retire();
    release.resolve();
    await retiring;
    expect(eventBatches).toBe(1);
    expect(await f.sql.query("SELECT type, payload_json FROM tf_workflow_events")).toEqual([
      { type: "approved", payload_json: '{"by":"owner"}' },
    ]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("private binding rejects unauthenticated and scope-bearing requests before mutation", async () => {
  const f = await fixture();
  try {
    const missingToken = await fetch(`${ROUTE}create`, {
      method: "POST",
      unix: f.broker.socketPath,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "unreachable" }),
    });
    expect(missingToken.status).toBe(404);
    const wrongToken = await fetch(`${ROUTE}create`, {
      method: "POST",
      unix: f.broker.socketPath,
      headers: { [TOKEN_HEADER]: "b".repeat(64), "content-type": "application/json" },
      body: JSON.stringify({ id: "unreachable" }),
    });
    expect(wrongToken.status).toBe(404);
    const duplicateToken = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          socketPath: f.broker.socketPath,
          path: "/__takoserver/workflow-binding/v1/create",
          method: "POST",
          headers: {
            [TOKEN_HEADER]: [TOKEN, TOKEN],
            "content-type": "application/json",
          },
        },
        (incoming) => {
          incoming.resume();
          resolve(incoming.statusCode ?? 0);
        },
      );
      outgoing.once("error", reject);
      outgoing.end(JSON.stringify({ id: "unreachable" }));
    });
    expect(duplicateToken).toBe(404);
    const scopeInjection = await f.call("create", {
      id: "unreachable",
      tenantId: "tenant-other",
      workflowResourceUid: "workflow-other",
    });
    expect(scopeInjection.status).toBe(400);
    const query = await fetch(`${ROUTE}create?tenantId=tenant-other`, {
      method: "POST",
      unix: f.broker.socketPath,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ id: "unreachable" }),
    });
    expect(query.status).toBe(400);
    await expect(f.instances.get(SCOPE, "unreachable")).rejects.toMatchObject({
      code: "unknown_instance",
    });
  } finally {
    await f.close();
  }
});

test("private binding refuses malformed JSON and an oversized streamed frame before dispatch", async () => {
  const f = await fixture();
  try {
    const malformed = await fetch(`${ROUTE}create`, {
      method: "POST",
      unix: f.broker.socketPath,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: "{not-json}",
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(`${ROUTE}create`, {
      method: "POST",
      unix: f.broker.socketPath,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ id: "unreachable", padding: "x".repeat(1_064_960) }),
    });
    expect(oversized.status).toBe(413);
    await expect(f.instances.get(SCOPE, "unreachable")).rejects.toMatchObject({
      code: "unknown_instance",
    });
  } finally {
    await f.close();
  }
});

test("duplicate explicit create is a named error and explicit get recovers it", async () => {
  const f = await fixture();
  try {
    expect((await f.call("create", { id: "same" })).status).toBe(200);
    const duplicate = await f.call("create", { id: "same" });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ schema: SCHEMA, error: "instance_exists" });
    const recovered = await f.call("get", { id: "same" });
    expect(await recovered.json()).toEqual({ schema: SCHEMA, value: { id: "same" } });
    const unknown = await f.call("status", { id: "missing" });
    expect(await unknown.json()).toEqual({ schema: SCHEMA, error: "unknown_instance" });
  } finally {
    await f.close();
  }
});

test("malformed event payload is a protocol refusal and oversized canonical payload is a named error", async () => {
  const f = await fixture();
  try {
    expect((await f.call("create", { id: "event-target" })).status).toBe(200);
    const invalid = await f.call("sendEvent", { id: "event-target", type: "kind", payload: [1] });
    expect(invalid.status).toBe(400);
    const oversized = await f.call("sendEvent", {
      id: "event-target",
      type: "kind",
      payload: { content: "x".repeat(1_048_570) },
    });
    expect(oversized.status).toBe(200);
    expect(await oversized.json()).toEqual({ schema: SCHEMA, error: "document_too_large" });
    expect(await f.sql.query("SELECT COUNT(*) AS count FROM tf_workflow_events")).toEqual([
      { count: 0 },
    ]);
  } finally {
    await f.close();
  }
});

test("protocol refusals do not dispatch, while a typed owner outage stays a closed operation error", async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "takoserver-workflow-binding-broker-"));
  await chmod(directory, 0o700);
  const broker = await openSelfhostWorkflowBindingBroker({
    socketPath: join(directory, "binding.sock"),
    token: TOKEN,
    scope: SCOPE,
    instances: {
      ...f.instances,
      async create() {
        throw new WorkflowRuntimeError("host_unavailable");
      },
    },
  });
  try {
    const wrongMethod = await fetch(`${ROUTE}create`, {
      method: "GET",
      unix: broker.socketPath,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
    });
    expect(wrongMethod.status).toBe(400);
    const wrongType = await fetch(`${ROUTE}create`, {
      method: "POST",
      unix: broker.socketPath,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json; charset=utf-8" },
      body: "{}",
    });
    expect(wrongType.status).toBe(400);
    const outage = await fetch(`${ROUTE}create`, {
      method: "POST",
      unix: broker.socketPath,
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ id: "blocked" }),
    });
    expect(outage.status).toBe(200);
    expect(outage.headers.get("content-type")).toBe("application/json");
    expect(await outage.json()).toEqual({ schema: SCHEMA, error: "backend_unavailable" });
    await expect(f.instances.get(SCOPE, "blocked")).rejects.toMatchObject({
      code: "unknown_instance",
    });
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
    await f.close();
  }
});

test("retire closes an authenticated incomplete body without starting a domain operation", async () => {
  const f = await fixture();
  const outgoing = httpRequest(
    {
      socketPath: f.broker.socketPath,
      path: "/__takoserver/workflow-binding/v1/create",
      method: "POST",
      headers: {
        [TOKEN_HEADER]: TOKEN,
        "content-type": "application/json",
        "content-length": "1024",
      },
    },
    (incoming) => incoming.resume(),
  );
  outgoing.on("error", () => {});
  try {
    outgoing.flushHeaders();
    outgoing.write("{");
    await new Promise((resolve) => setTimeout(resolve, 20));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        f.broker.retire(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("retire held by incomplete body")), 1_000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    expect(await f.sql.query("SELECT COUNT(*) AS count FROM tf_workflow_instances")).toEqual([
      { count: 0 },
    ]);
  } finally {
    outgoing.destroy();
    await f.close();
  }
});

test("status returns a persisted error message bounded by Unicode scalars, not UTF-16 units", async () => {
  const f = await fixture();
  try {
    expect((await f.call("create", { id: "unicode-error" })).status).toBe(200);
    const message = "😀".repeat(4_097);
    await f.sql.run(
      "UPDATE tf_workflow_instances SET status = 'errored', error_json = ? WHERE instance_id = ?",
      [JSON.stringify({ reason: "run_threw", message }), "unicode-error"],
    );
    const response = await f.call("status", { id: "unicode-error" });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(Buffer.byteLength(responseText)).toBeLessThanOrEqual(1_064_960);
    expect(JSON.parse(responseText)).toEqual({
      schema: SCHEMA,
      value: { status: "errored", error: { reason: "run_threw", message } },
    });
    const maximum = "😀".repeat(8_192);
    await f.sql.run("UPDATE tf_workflow_instances SET error_json = ? WHERE instance_id = ?", [
      JSON.stringify({ reason: "run_threw", message: maximum }),
      "unicode-error",
    ]);
    const boundary = await f.call("status", { id: "unicode-error" });
    expect(boundary.status).toBe(200);
    expect(await boundary.json()).toEqual({
      schema: SCHEMA,
      value: { status: "errored", error: { reason: "run_threw", message: maximum } },
    });
    await f.sql.run("UPDATE tf_workflow_instances SET error_json = ? WHERE instance_id = ?", [
      JSON.stringify({ reason: "run_threw", message: "" }),
      "unicode-error",
    ]);
    const empty = await f.call("status", { id: "unicode-error" });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      schema: SCHEMA,
      value: { status: "errored", error: { reason: "run_threw", message: "" } },
    });
    for (const invalid of ["😀".repeat(8_193), "\ud800"]) {
      await f.sql.run("UPDATE tf_workflow_instances SET error_json = ? WHERE instance_id = ?", [
        JSON.stringify({ reason: "run_threw", message: invalid }),
        "unicode-error",
      ]);
      const rejected = await f.call("status", { id: "unicode-error" });
      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toEqual({ schema: SCHEMA, error: "backend_unavailable" });
    }
  } finally {
    await f.close();
  }
});
