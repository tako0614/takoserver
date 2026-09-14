import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkflowHttpExecution } from "../src/selfhost-workflow-http-transport.ts";
import { type WorkflowDriver, WorkflowRuntimeError } from "../src/workflow-driver.ts";

const token = "a".repeat(64);

function noOpDriver(): WorkflowDriver {
  return {
    do: async () => undefined,
    sleep: async () => undefined,
    waitForEvent: async () => undefined,
    definitionMismatch: () => new Promise<never>(() => undefined),
  };
}

interface FixtureOptions {
  readonly runStatus: number;
  readonly runBody: string;
  readonly recordFailure?: Error;
  readonly runAction?: (companionOrigin: string) => Promise<void>;
  readonly runHeaders?: Readonly<Record<string, string>>;
  readonly runSocketPath?: string;
}

interface TransportFixture {
  readonly prepared: Awaited<ReturnType<typeof prepareWorkflowHttpExecution>>;
  readonly companionOrigin: string;
  readonly runRequests: string[];
  readonly records: Array<{ sequence: number; payload: string }>;
  readonly disposeCount: () => number;
  readonly drain: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

async function fixture(options: FixtureOptions): Promise<TransportFixture> {
  const socketRoot = mkdtempSync(join(tmpdir(), "takoserver-workflow-http-socket-"));
  chmodSync(socketRoot, 0o700);
  const socketPath = join(socketRoot, "workerd.sock");
  let companionOrigin = "";
  let child: ReturnType<typeof Bun.serve> | undefined;
  let childStopped = false;
  let prepared: Awaited<ReturnType<typeof prepareWorkflowHttpExecution>> | undefined;
  let disposed = 0;
  let drainAttempted = false;
  let disposeAttempted = false;
  const records: Array<{ sequence: number; payload: string }> = [];
  const runRequests: string[] = [];

  const stopChild = async () => {
    if (!child || childStopped) return;
    await child.stop(true);
    childStopped = true;
  };

  try {
    prepared = await prepareWorkflowHttpExecution({
      channel: {
        journalToken: token,
        recordPayload(sequence, payload) {
          if (options.recordFailure) throw options.recordFailure;
          records.push({ sequence, payload });
          prepared?.acceptFrame(sequence, payload);
        },
      },
      signal: new AbortController().signal,
      async configure(address) {
        companionOrigin = `http://${address}`;
        child = Bun.serve({
          unix: socketPath,
          async fetch(request) {
            const pathname = new URL(request.url).pathname;
            if (request.method === "GET" && pathname === `/${token}/ready`) {
              return new Response("ready");
            }
            if (request.method === "POST" && pathname === `/${token}/run`) {
              runRequests.push(request.url);
              await options.runAction?.(companionOrigin);
              return new Response(options.runBody, {
                status: options.runStatus,
                ...(options.runHeaders === undefined ? {} : { headers: options.runHeaders }),
              });
            }
            return new Response(null, { status: 404 });
          },
        });
        return {
          configPath: "/tmp/workflow-http-test.capnp",
          runSocketPath: options.runSocketPath ?? socketPath,
          async dispose() {
            disposed += 1;
            await stopChild();
          },
        };
      },
    });
  } catch (error) {
    await stopChild();
    rmSync(socketRoot, { recursive: true, force: true });
    throw error;
  }

  const actual = prepared;
  return {
    prepared: actual,
    companionOrigin,
    runRequests,
    records,
    disposeCount: () => disposed,
    async drain() {
      // This fixture simulates the already-stopped sender precondition;
      // only the separate guarded native test can prove physical reap.
      await stopChild();
      expect(childStopped).toBe(true);
      drainAttempted = true;
      return actual.drainAfterStop();
    },
    async dispose() {
      disposeAttempted = true;
      return actual.dispose();
    },
    async cleanup() {
      try {
        await stopChild();
        if (!drainAttempted) {
          drainAttempted = true;
          try {
            await actual.drainAfterStop();
          } catch {
            // A negative barrier test has already proved the retained failure.
          }
        }
        if (!disposeAttempted) {
          disposeAttempted = true;
          try {
            await actual.dispose();
          } catch {
            // Failed ingress intentionally refuses artifact disposal.
          }
        }
      } finally {
        rmSync(socketRoot, { recursive: true, force: true });
      }
    },
  };
}

async function postFrame(origin: string, sequence: number, payload: string) {
  const response = await fetch(`${origin}/${token}/${sequence}`, {
    method: "POST",
    body: payload,
  });
  return { status: response.status, body: await response.text() };
}

test("a non-200 RUN rejects but clean ingress after sender stop still permits disposal", async () => {
  const f = await fixture({ runStatus: 500, runBody: "child failed" });
  try {
    await expect(f.prepared.run(noOpDriver())).rejects.toMatchObject({
      code: "host_unavailable",
    });
    await expect(f.drain()).resolves.toBeUndefined();
    await expect(f.dispose()).resolves.toBeUndefined();
    expect(f.records).toEqual([]);
    expect(f.runRequests).toEqual([`http://workflow.internal/${token}/run`]);
    expect(f.disposeCount()).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("a malformed successful RUN outcome is infrastructure failure after a clean barrier", async () => {
  const f = await fixture({ runStatus: 200, runBody: "not-json" });
  try {
    await expect(f.prepared.run(noOpDriver())).rejects.toBeInstanceOf(WorkflowRuntimeError);
    await expect(f.drain()).resolves.toBeUndefined();
    await expect(f.dispose()).resolves.toBeUndefined();
    expect(f.records).toEqual([]);
    expect(f.disposeCount()).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("an oversized companion body is rejected before journal recording and blocks the barrier", async () => {
  const f = await fixture({ runStatus: 200, runBody: '{"kind":"complete","present":false}' });
  try {
    const response = await postFrame(f.companionOrigin, 1, "x".repeat(2 * 1024 * 1024 + 1));
    expect(response.status).toBe(503);
    expect(f.records).toEqual([]);
    await expect(f.drain()).rejects.toMatchObject({ code: "host_unavailable" });
    await expect(f.dispose()).rejects.toMatchObject({ code: "host_unavailable" });
    expect(f.disposeCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("a journal recording failure still refuses drain and disposal", async () => {
  let finishFrame!: (status: number) => void;
  const frameFinished = new Promise<number>((resolve) => {
    finishFrame = resolve;
  });
  const f = await fixture({
    runStatus: 200,
    runBody: '{"kind":"complete","present":false}',
    recordFailure: new Error("journal unavailable"),
    async runAction(origin) {
      const response = await postFrame(origin, 1, '{"kind":"call","call":1,"operation":"do"}');
      finishFrame(response.status);
    },
  });
  try {
    await expect(f.prepared.run(noOpDriver())).rejects.toMatchObject({ code: "host_unavailable" });
    expect(await frameFinished).toBe(503);
    expect(f.records).toEqual([]);
    await expect(f.drain()).rejects.toMatchObject({ code: "host_unavailable" });
    await expect(f.dispose()).rejects.toMatchObject({ code: "host_unavailable" });
    expect(f.disposeCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("a paired response that later rejects does not poison a clean ingress barrier", async () => {
  const frames: Array<{ status: number; body: string }> = [];
  let finishFrames!: () => void;
  const framesFinished = new Promise<void>((resolve) => {
    finishFrames = resolve;
  });
  const backendFailure = new WorkflowRuntimeError("backend_unavailable");
  const f = await fixture({
    runStatus: 200,
    runBody: '{"kind":"complete","present":false}',
    async runAction(origin) {
      frames.push(await postFrame(origin, 1, '{"kind":"call","call":1,"operation":"do"}'));
      frames.push(await postFrame(origin, 2, '{"kind":"name","call":1,"name":"backend"}'));
      finishFrames();
    },
  });
  try {
    const driver: WorkflowDriver = {
      async do(prepareName) {
        await prepareName();
        throw backendFailure;
      },
      async sleep() {},
      async waitForEvent() {
        return undefined;
      },
      definitionMismatch: () => new Promise<never>(() => undefined),
    };
    await expect(f.prepared.run(driver)).rejects.toBe(backendFailure);
    await framesFinished;
    expect(frames).toEqual([
      { status: 200, body: '{"kind":"need_name"}' },
      { status: 503, body: "" },
    ]);
    expect(f.records).toHaveLength(2);
    await expect(f.drain()).resolves.toBeUndefined();
    await expect(f.dispose()).resolves.toBeUndefined();
    expect(f.disposeCount()).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("rejects a non-filesystem run socket path during configuration", async () => {
  await expect(
    fixture({
      runStatus: 200,
      runBody: '{"kind":"complete","present":false}',
      runSocketPath: "relative.sock",
    }),
  ).rejects.toMatchObject({ code: "invalid_runtime_input" });
});

test("refuses redirects on the private Unix-socket RUN request", async () => {
  const f = await fixture({
    runStatus: 302,
    runBody: "redirected",
    runHeaders: { location: "http://workflow.redirect.invalid/elsewhere" },
  });
  try {
    await expect(f.prepared.run(noOpDriver())).rejects.toBeDefined();
    // `redirect: error` rejects before issuing a second request, and the
    // fixed private URL remains the only request observed by this socket.
    expect(f.runRequests).toEqual([`http://workflow.internal/${token}/run`]);
    await expect(f.drain()).resolves.toBeUndefined();
    await expect(f.dispose()).resolves.toBeUndefined();
  } finally {
    await f.cleanup();
  }
});
