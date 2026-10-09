import { expect, test } from "bun:test";
import { createWorkflowHttpBootstrap } from "../src/workflow-http-bootstrap-entry.ts";
import { createWorkflowHttpWorker } from "../src/workflow-http-worker.ts";

const token = "a".repeat(64);

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function fixture(emitMarker: ((sequence: number) => Promise<void>) | undefined) {
  const sends: string[] = [];
  const payloadStarted = latch<void>();
  const worker = createWorkflowHttpWorker({
    token,
    className: "Application",
    instanceId: "instance",
    ...(emitMarker === undefined ? {} : { emitMarker }),
    async load() {
      return {
        namespace: {
          Application: class {
            async run(_event: unknown, step: { do: (name: string) => Promise<unknown> }) {
              await step.do("memo");
              return { complete: true };
            }
          },
        },
        projectEnv: () => ({}),
      };
    },
  });
  const rawEnv = {
    __TAKOSERVER_WORKFLOW_COMPANION: {
      async fetch(_url: string, init: RequestInit) {
        sends.push(String(init.body));
        payloadStarted.resolve();
        return new Response(
          sends.length === 1 ? '{"kind":"need_name"}' : '{"kind":"settled","present":false}',
        );
      },
    },
  };
  const run = () =>
    worker.fetch(new Request(`http://workflow.internal/${token}/run`, { method: "POST" }), rawEnv);
  return { sends, payloadStarted: payloadStarted.promise, run };
}

test("selected marker acknowledgement precedes every companion payload", async () => {
  const entered = latch<number>();
  const release = latch<void>();
  const f = fixture(async (sequence) => {
    entered.resolve(sequence);
    await release.promise;
  });
  const run = f.run();
  const first = await Promise.race([
    entered.promise.then(() => "marker"),
    f.payloadStarted.then(() => "payload"),
  ]);
  expect(first).toBe("marker");
  expect(await entered.promise).toBe(1);
  expect(f.sends).toEqual([]);
  release.resolve();
  expect((await run).status).toBe(200);
  expect(f.sends).toHaveLength(2);
});

function consoleMode(mode: "default" | "selected"): string {
  const script = `
const events = [];
let consoleCalls = 0;
console.error = (value) => {
  consoleCalls += 1;
  events.push(String(value).startsWith("TAKOSERVER_WORKFLOW_JOURNAL:") ? "marker" : "warmup");
};
const { createWorkflowHttpWorker } = await import("./src/workflow-http-worker.ts");
const token = "a".repeat(64);
const selected = ${mode === "selected"};
let sends = 0;
const worker = createWorkflowHttpWorker({
  token,
  className: "Application",
  instanceId: "instance",
  ...(selected ? { async emitMarker() { events.push("marker"); } } : {}),
  async load() {
    return {
      namespace: {
        Application: class {
          async run(_event, step) {
            await step.do("memo");
            return { complete: true };
          }
        }
      },
      projectEnv: () => ({})
    };
  }
});
const response = await worker.fetch(
  new Request("http://workflow.internal/" + token + "/run", { method: "POST" }),
  { __TAKOSERVER_WORKFLOW_COMPANION: {
    async fetch() {
      events.push("payload");
      sends += 1;
      return new Response(sends === 1
        ? '{"kind":"need_name"}'
        : '{"kind":"settled","present":false}');
    }
  } }
);
const expected = selected
  ? ["marker", "payload", "marker", "payload"]
  : ["warmup", "marker", "payload", "marker", "payload"];
process.stdout.write(response.status === 200 &&
  JSON.stringify(events) === JSON.stringify(expected) &&
  consoleCalls === (selected ? 0 : 3) ? "ok" : "wrong");
`;
  const child = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd: process.cwd() });
  expect(child.exitCode).toBe(0);
  return new TextDecoder().decode(child.stdout);
}

test("default self-host marker remains synchronous before each payload", () => {
  expect(consoleMode("default")).toBe("ok");
});

test("failed selected marker refuses the payload", async () => {
  const f = fixture(async () => {
    throw new Error("marker acknowledgement unavailable");
  });
  await expect(f.run()).rejects.toMatchObject({ code: "host_unavailable" });
  expect(f.sends).toEqual([]);
});

test("a selected marker returning void cannot be adopted as an acknowledgement", async () => {
  const f = fixture((() => undefined) as unknown as (sequence: number) => Promise<void>);
  await expect(f.run()).rejects.toMatchObject({ code: "host_unavailable" });
  expect(f.sends).toEqual([]);
});

test("selected marker never writes its token to the captured native console", () => {
  expect(consoleMode("selected")).toBe("ok");
});

test("bootstrap captures the selected marker before tenant module load", async () => {
  const marker = latch<number>();
  const release = latch<void>();
  const sends: string[] = [];
  const wrapperModule = `data:text/javascript;base64,${Buffer.from(
    "export const __takoserverSelfhostProjectEnv = () => ({});",
  ).toString("base64")}`;
  const applicationModule = `data:text/javascript;base64,${Buffer.from(
    'export class Application { async run(_event, step) { await step.do("memo"); return { complete: true }; } }',
  ).toString("base64")}`;
  const options = {
    token,
    className: "Application",
    instanceId: "instance",
    wrapperModule,
    applicationModule,
    async emitMarker(sequence: number) {
      marker.resolve(sequence);
      await release.promise;
    },
  };
  const worker = createWorkflowHttpBootstrap(options);
  let switchedCalls = 0;
  options.emitMarker = async () => {
    switchedCalls += 1;
  };
  const run = worker.fetch(
    new Request(`http://workflow.internal/${token}/run`, { method: "POST" }),
    {
      __TAKOSERVER_WORKFLOW_COMPANION: {
        async fetch(_url: string, init: RequestInit) {
          sends.push(String(init.body));
          return new Response(
            sends.length === 1 ? '{"kind":"need_name"}' : '{"kind":"settled","present":false}',
          );
        },
      },
    },
  );
  const first = await Promise.race([
    marker.promise.then((sequence) => ({ kind: "marker" as const, sequence })),
    run.then(
      async (response) => ({ kind: "run_completed" as const, body: await response.text() }),
      (error: unknown) => ({ kind: "run_failed" as const, error }),
    ),
  ]);
  expect(first).toEqual({ kind: "marker", sequence: 1 });
  expect(sends).toEqual([]);
  release.resolve();
  expect((await run).status).toBe(200);
  expect(sends).toHaveLength(2);
  expect(switchedCalls).toBe(0);
});

test("an explicitly selected but missing marker hook refuses before tenant load", () => {
  expect(() =>
    createWorkflowHttpBootstrap({
      token,
      className: "Application",
      instanceId: "instance",
      wrapperModule: "./wrapper.js",
      applicationModule: "./application.js",
      emitMarker: undefined,
    } as unknown as Parameters<typeof createWorkflowHttpBootstrap>[0]),
  ).toThrow();
});

test("a poisoned Promise prototype cannot turn a pending marker into an early payload", () => {
  // Isolate mutation of the process-wide Promise prototype from the test
  // runner. Only fixed status words cross the child boundary, never a token.
  const script = `
import { createWorkflowHttpWorker } from "./src/workflow-http-worker.ts";
const token = "a".repeat(64);
let sends = 0;
let markers = 0;
let early = false;
const worker = createWorkflowHttpWorker({
  token,
  className: "Application",
  instanceId: "instance",
  emitMarker() {
    markers += 1;
    let release;
    const ack = new Promise((resolve) => { release = resolve; });
    const original = Promise.prototype.then;
    Promise.prototype.then = function (onFulfilled) {
      return Promise.resolve(onFulfilled?.(undefined));
    };
    setTimeout(() => {
      if (sends > markers - 1) early = true;
      Promise.prototype.then = original;
      release();
    }, 0);
    return ack;
  },
  async load() {
    return {
      namespace: {
        Application: class {
          async run(_event, step) {
            await step.do("memo");
            return { complete: true };
          }
        }
      },
      projectEnv: () => ({})
    };
  }
});
const response = await worker.fetch(
  new Request("http://workflow.internal/" + token + "/run", { method: "POST" }),
  { __TAKOSERVER_WORKFLOW_COMPANION: {
    async fetch() {
      sends += 1;
      return new Response(sends === 1
        ? '{"kind":"need_name"}'
        : '{"kind":"settled","present":false}');
    }
  } }
);
const body = await response.text();
process.stdout.write(!early && markers === 2 && sends === 2 &&
  body === '{"kind":"complete","present":true,"value":{"complete":true}}'
  ? "ok" : "wrong");
`;
  const child = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd: process.cwd() });
  expect(child.exitCode).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toBe("ok");
});
