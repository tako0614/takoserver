import { expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import {
  createSelfhostBunFetchHandler,
  createSelfhostHealthHandler,
} from "../src/selfhost-health.ts";
import { createWorkerdSupervisor, type WorkerdProcess } from "../src/workerd-supervisor.ts";

function healthBody(response: Response): Promise<{
  readonly status: string;
  readonly database: string;
  readonly workerRuntime: string;
  readonly supervisor: string;
}> {
  return response.json();
}

test("Bun HTTP dispatch serves local liveness and ready no-workload states before product routes", async () => {
  let queryCount = 0;
  let snapshotCount = 0;
  let provisionCalls = 0;
  let appCalls = 0;
  const health = createSelfhostHealthHandler({
    sql: {
      async query(statement) {
        queryCount++;
        expect(statement).toBe("SELECT 1 AS selfhost_health");
        return [{ selfhost_health: 1 }];
      },
    },
    startupRestore: "empty",
    supervisor: {
      snapshot() {
        snapshotCount++;
        return { state: "idle" as const };
      },
    },
  });
  const fetchHandler = createSelfhostBunFetchHandler({
    health,
    async provision(request) {
      provisionCalls++;
      return request.url.endsWith("/provisioned") ? new Response("provision") : undefined;
    },
    async appFetch() {
      appCalls++;
      return new Response("app");
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetchHandler });
  try {
    const live = await fetch(new URL("/_takoserver/health/live", server.url));
    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(await live.json()).toEqual({ status: "live" });
    expect(queryCount).toBe(0);
    expect(snapshotCount).toBe(0);
    expect(provisionCalls).toBe(0);
    expect(appCalls).toBe(0);

    const ready = await fetch(new URL("/_takoserver/health/ready", server.url));
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(await healthBody(ready)).toEqual({
      status: "ready",
      database: "readable",
      workerRuntime: "not-required",
      supervisor: "idle",
    });
    expect(queryCount).toBe(1);
    expect(snapshotCount).toBe(1);
    expect(provisionCalls).toBe(0);
    expect(appCalls).toBe(0);

    const ordinary = await fetch(new URL("/v1/forms", server.url));
    expect(await ordinary.text()).toBe("app");
    expect(provisionCalls).toBe(1);
    expect(appCalls).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("fresh HTTP readiness distinguishes a dead child from successful supervisor recovery", async () => {
  const children: Array<{
    readonly process: WorkerdProcess;
    exit(): void;
  }> = [];
  const restarts: Array<() => void> = [];
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    spawn: () => {
      let resolveExit!: (code: number) => void;
      const child = {
        process: {
          kill() {},
          exited: new Promise<number>((resolve) => {
            resolveExit = resolve;
          }),
        },
        exit() {
          resolveExit(1);
        },
      };
      children.push(child);
      return child.process;
    },
    readiness: async () => true,
    scheduleRestart: (run) => {
      restarts.push(run);
      return () => undefined;
    },
  });
  const health = createSelfhostHealthHandler({
    sql: {
      async query() {
        return [{ selfhost_health: 1 }];
      },
    },
    startupRestore: "empty",
    supervisor,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createSelfhostBunFetchHandler({
      health,
      async provision() {
        return undefined;
      },
      async appFetch() {
        return new Response("app");
      },
    }),
  });
  try {
    await supervisor.ensure("/operator-private/workerd.capnp");
    const firstReady = await fetch(new URL("/_takoserver/health/ready", server.url));
    expect(firstReady.status).toBe(200);
    expect((await healthBody(firstReady)).workerRuntime).toBe("serving");

    children[0]?.exit();
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    const recovering = await fetch(new URL("/_takoserver/health/ready", server.url));
    expect(recovering.status).toBe(503);
    expect((await healthBody(recovering)).workerRuntime).toBe("recovering");

    restarts[0]?.();
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    const recovered = await fetch(new URL("/_takoserver/health/ready", server.url));
    expect(recovered.status).toBe(200);
    expect((await healthBody(recovered)).workerRuntime).toBe("serving");
    expect(children).toHaveLength(2);

    supervisor.stop();
    const stopped = await fetch(new URL("/_takoserver/health/ready", server.url));
    expect(stopped.status).toBe(503);
    expect((await healthBody(stopped)).workerRuntime).toBe("unavailable");
  } finally {
    supervisor.stop();
    server.stop(true);
  }
});

test("a failed first required child start is unavailable while an untouched runtime is not required", async () => {
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    spawn: () => ({ kill() {} }),
    readiness: async () => false,
  });
  await expect(supervisor.ensure("/private/workerd.capnp")).rejects.toThrow("readiness");
  const health = createSelfhostHealthHandler({
    sql: {
      async query() {
        return [{ selfhost_health: 1 }];
      },
    },
    startupRestore: "empty",
    supervisor,
  });
  const response = await health(new Request("http://127.0.0.1/_takoserver/health/ready"));
  expect(response?.status).toBe(503);
  expect(await healthBody(response as Response)).toMatchObject({
    workerRuntime: "unavailable",
    supervisor: "unavailable",
  });
});

test("restore failure is not promoted by a later serving-child boolean", async () => {
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    spawn: () => ({ kill() {} }),
    readiness: async () => true,
  });
  await supervisor.ensure("/private/workerd.capnp");
  const health = createSelfhostHealthHandler({
    sql: {
      async query() {
        return [{ selfhost_health: 1 }];
      },
    },
    startupRestore: "failed",
    supervisor,
  });
  const response = await health(new Request("http://127.0.0.1/_takoserver/health/ready"));
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    status: "not_ready",
    database: "readable",
    workerRuntime: "restore-failed",
    supervisor: "serving",
  });
  supervisor.stop();
});

test("readiness database query is read-only, bounded, retryable, and sanitized", async () => {
  let releaseFirst!: (rows: readonly Record<string, unknown>[]) => void;
  let queryCount = 0;
  const sql = {
    async query(statement: string) {
      expect(statement).toBe("SELECT 1 AS selfhost_health");
      queryCount++;
      if (queryCount === 1) {
        return await new Promise<readonly Record<string, unknown>[]>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return [{ selfhost_health: 1 }];
    },
    async run() {
      throw new Error("health must not write SQL");
    },
  } as unknown as Sql;
  const health = createSelfhostHealthHandler({
    sql,
    startupRestore: "empty",
    supervisor: { snapshot: () => ({ state: "idle" }) },
    databaseCheckTimeoutMs: 5,
  });
  const request = new Request("http://127.0.0.1/_takoserver/health/ready");

  const timedOut = await health(request);
  expect(timedOut?.status).toBe(503);
  expect(await timedOut?.json()).toEqual({
    status: "not_ready",
    database: "unavailable",
    workerRuntime: "not-required",
    supervisor: "idle",
  });
  const retry = await health(request);
  expect(retry?.status).toBe(200);
  expect(await retry?.json()).toMatchObject({
    status: "ready",
    database: "readable",
    workerRuntime: "not-required",
  });
  expect(queryCount).toBe(2);
  releaseFirst?.([]);
});

test("database errors never put paths, secrets, or raw details in the public response", async () => {
  const health = createSelfhostHealthHandler({
    sql: {
      async query() {
        throw new Error("/secret/root operator-token=hidden raw database detail");
      },
    },
    startupRestore: "empty",
    supervisor: { snapshot: () => ({ state: "idle" }) },
  });

  const response = await health(new Request("http://127.0.0.1/_takoserver/health/ready"));
  expect(response?.status).toBe(503);
  const body = await response?.text();
  expect(body).not.toContain("/secret/root");
  expect(body).not.toContain("operator-token");
  expect(body).not.toContain("raw database detail");
});
