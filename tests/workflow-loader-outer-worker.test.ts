import { afterEach, expect, test } from "bun:test";
import {
  createWorkflowLoaderOuterWorker,
  WORKFLOW_COMPANION_BINDING,
  WORKFLOW_LOADER_BINDING,
  type WorkflowLoaderModule,
  type WorkflowLoaderWorkerCode,
} from "../src/workflow-loader-outer-worker.ts";

const token = "a".repeat(64);

const baseOptions = {
  token,
  mainModule: "__tenant.js",
  applicationMain: "index.js",
  modules: {
    "index.js": { js: "export const answer = 42;" },
  },
  hostPrivateModules: {
    "__tenant.js": { js: "export default class Tenant {}" },
  },
  childBindingNames: ["APP_VALUE", "SERVICE"],
} as const;

const contexts = new Set<object>();
afterEach(() => {
  contexts.clear();
});

function contextFor(worker: ReturnType<typeof createWorkflowLoaderOuterWorker>) {
  const context = {
    exports: {
      WorkflowHost(options: Record<string, unknown>) {
        // Native LoopbackServiceStub requires an Options dictionary even when
        // no props are supplied; a zero-argument fake hides that startup failure.
        if (!options || Object.keys(options).length !== 0) throw new TypeError("Options required");
        const host = {
          exchange(payload: string) {
            return worker.exchange(payload);
          },
        };
        contexts.add(host);
        return host;
      },
    },
  };
  return context;
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://workflow.invalid/${token}/${path}`, init);
}

test("readiness and wrong paths never load; one RUN loads and runs once", async () => {
  let loads = 0;
  let runs = 0;
  const worker = createWorkflowLoaderOuterWorker(baseOptions);
  const loader = {
    load() {
      loads += 1;
      return {
        getEntrypoint() {
          return {
            run() {
              runs += 1;
              return '{"kind":"complete"}';
            },
          };
        },
      };
    },
  };
  const env = {
    APP_VALUE: "app",
    SERVICE: { fetch() {} },
    [WORKFLOW_LOADER_BINDING]: loader,
    [WORKFLOW_COMPANION_BINDING]: { fetch() {} },
  };
  const context = contextFor(worker);

  expect((await worker.fetch(request("ready"), env, context)).status).toBe(200);
  expect((await worker.fetch(request("unknown"), env, context)).status).toBe(404);
  expect(loads).toBe(0);

  const run = await worker.fetch(request("run", { method: "POST" }), env, context);
  expect(run.status).toBe(200);
  expect(await run.text()).toBe('{"kind":"complete"}');
  expect(loads).toBe(1);
  expect(runs).toBe(1);
  expect((await worker.fetch(request("run", { method: "POST" }), env, context)).status).toBe(409);
  expect(loads).toBe(1);
});

test("concurrent RUN requests share the synchronous latch", async () => {
  let loads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = createWorkflowLoaderOuterWorker(baseOptions);
  const loader = {
    async load() {
      loads += 1;
      await held;
      return { getEntrypoint: () => ({ run: () => '{"kind":"complete"}' }) };
    },
  };
  const env = {
    [WORKFLOW_LOADER_BINDING]: loader,
    [WORKFLOW_COMPANION_BINDING]: { fetch() {} },
  };
  const context = contextFor(worker);
  const first = worker.fetch(request("run", { method: "POST" }), env, context);
  const second = await worker.fetch(request("run", { method: "POST" }), env, context);
  expect((await second).status).toBe(409);
  expect(loads).toBe(1);
  release();
  expect((await first).status).toBe(200);
});

test("loader receives separate role dictionaries and only projected child bindings", async () => {
  let received: WorkflowLoaderWorkerCode | undefined;
  const worker = createWorkflowLoaderOuterWorker({
    ...baseOptions,
    modules: {
      "same.js": { text: "application" },
    },
    applicationMain: "same.js",
    hostPrivateModules: {
      "__tenant.js": { js: "export default {};" },
      "same.js": { js: "export const host = true;" },
    },
    childBindingNames: ["APP_VALUE", "__proto__"],
  });
  const env = {
    APP_VALUE: "visible",
    ["__proto__"]: "literal-binding",
    SECRET: "hidden",
    [WORKFLOW_LOADER_BINDING]: {
      load(code: WorkflowLoaderWorkerCode) {
        // Native WorkerLoader serializes env as a plain record, unlike its
        // module dictionaries. Null-prototype env records are not serializable.
        if (Object.getPrototypeOf(code.env) !== Object.prototype)
          throw new Error("unserializable env");
        received = code;
        return {
          getEntrypoint: () => ({
            run: (...args: unknown[]) => {
              expect(args).toEqual([null]);
              // RpcPromise is a thenable, not a native Promise instance.
              return {
                // biome-ignore lint/suspicious/noThenProperty: models native RpcPromise thenable adoption
                then(resolve: (value: string) => void) {
                  resolve("ok");
                },
              };
            },
          }),
        };
      },
    },
    [WORKFLOW_COMPANION_BINDING]: { fetch() {} },
  };
  const response = await worker.fetch(request("run", { method: "POST" }), env, contextFor(worker));
  expect(response.status).toBe(200);
  if (!received) throw new Error("loader input was not captured");
  expect(Object.getPrototypeOf(received.modules)).toBeNull();
  expect(Object.getPrototypeOf(received.hostPrivateModules)).toBeNull();
  expect(Object.getPrototypeOf(received.env)).toBe(Object.prototype);
  expect(Object.hasOwn(received.env, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(received.env, "__proto__")?.value).toBe("literal-binding");
  expect(Object.keys(received.modules)).toEqual(["same.js"]);
  expect(Object.keys(received.hostPrivateModules)).toEqual(["__tenant.js", "same.js"]);
  expect(received.mainModuleRole).toBe("hostPrivate");
  expect(received.modulePolicy.applicationMain).toBe("same.js");
  expect(received.globalOutbound).toBeNull();
  expect(Object.keys(received.env)).toEqual([
    "APP_VALUE",
    "__proto__",
    "__TAKOSERVER_WORKFLOW_HOST",
  ]);
  expect(received.env.SECRET).toBeUndefined();
});

test("rejects role metadata instead of widening the WorkerLoader module union", () => {
  expect(() =>
    createWorkflowLoaderOuterWorker({
      ...baseOptions,
      modules: {
        "index.js": { js: "export {}", role: "application" } as unknown as WorkflowLoaderModule,
      },
    }),
  ).toThrow();
});

test("journal authority is scoped to a live RUN and marker precedes companion fetch", async () => {
  const order: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("TAKOSERVER_WORKFLOW_JOURNAL:")) {
      order.push("marker");
    }
  };
  try {
    const worker = createWorkflowLoaderOuterWorker(baseOptions);
    await expect(worker.exchange('{"kind":"call"}')).rejects.toMatchObject({
      code: "host_unavailable",
    });
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const env = {
      [WORKFLOW_LOADER_BINDING]: {
        load() {
          return {
            getEntrypoint: () => ({
              async run() {
                await worker.exchange('{"kind":"call"}');
                return '{"kind":"complete"}';
              },
            }),
          };
        },
      },
      [WORKFLOW_COMPANION_BINDING]: {
        fetch() {
          order.push("fetch");
          return held;
        },
      },
    };
    const run = worker.fetch(request("run", { method: "POST" }), env, contextFor(worker));
    for (let attempt = 0; attempt < 10 && order.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(order).toEqual(["marker", "fetch"]);
    release(new Response('{"kind":"settled","present":false}'));
    expect((await run).status).toBe(200);
    await expect(worker.exchange('{"kind":"call"}')).rejects.toMatchObject({
      code: "host_unavailable",
    });
    expect(order).toEqual(["marker", "fetch"]);
  } finally {
    console.error = original;
  }
});

test("loader and tenant failures are redacted as HTTP 500", async () => {
  const worker = createWorkflowLoaderOuterWorker(baseOptions);
  const env = {
    [WORKFLOW_LOADER_BINDING]: {
      load() {
        throw new Error("tenant secret details");
      },
    },
    [WORKFLOW_COMPANION_BINDING]: { fetch() {} },
  };
  const response = await worker.fetch(request("run", { method: "POST" }), env, contextFor(worker));
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("");
});
