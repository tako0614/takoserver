import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import {
  renderSelfhostActorForwardRuntimeModuleSource,
  selfhostActorForwardEntrypointSource,
} from "../src/selfhost-actor-forward-worker-wrapper.ts";
import {
  renderSelfhostWorkflowBindingRuntimeModuleSource,
  selfhostWorkflowBindingEntrypointSource,
} from "../src/selfhost-workflow-binding-worker-wrapper.ts";

const selectedBinding = {
  publicName: "ORDERS",
  serviceName: "__TAKOSERVER_WORKFLOW_BINDING_00000",
  token: "a".repeat(64),
};

type WorkflowInstance = {
  readonly id: string;
  status(): Promise<unknown>;
  sendEvent(input: { type: string; payload?: unknown }): Promise<void>;
  terminate(): Promise<void>;
};

type GeneratedRuntime = {
  readonly createSelfhostWorkflowBindingContext: (input: {
    readonly rawEnv: Record<string, unknown>;
    readonly bindings: readonly (typeof selectedBinding)[];
  }) => { readonly rawEnv: Record<string, unknown> };
};

async function loadGeneratedRuntime(cacheKey = ""): Promise<GeneratedRuntime> {
  const source = renderSelfhostWorkflowBindingRuntimeModuleSource();
  const encoded = Buffer.from(`${source}\n// ${cacheKey}`, "utf8").toString("base64");
  return (await import(`data:text/javascript;base64,${encoded}`)) as GeneratedRuntime;
}

function result(value: unknown): Response {
  return new Response(
    JSON.stringify({ schema: "takoserver.selfhost-workflow-binding-result@v1", value }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("generated Workflow binding captures inherited native Response getters before tenant poisoning", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Response");
  const NativeResponse = Response;
  class InheritedResponse extends NativeResponse {}
  expect(Object.getOwnPropertyDescriptor(InheritedResponse.prototype, "body")).toBeUndefined();
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    writable: true,
    value: InheritedResponse,
  });
  try {
    const runtime = await loadGeneratedRuntime("inherited-response-getters");
    Object.defineProperty(InheritedResponse.prototype, "body", {
      configurable: true,
      get() {
        throw new Error("tenant-poisoned body getter must not be used");
      },
    });
    const service = {
      async fetch(): Promise<Response> {
        return new InheritedResponse(
          JSON.stringify({
            schema: "takoserver.selfhost-workflow-binding-result@v1",
            value: { id: "inherited-run", status: "queued" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    };
    const env = runtime.createSelfhostWorkflowBindingContext({
      rawEnv: { [selectedBinding.serviceName]: service },
      bindings: [selectedBinding],
    }).rawEnv;
    const binding = env.ORDERS as { create(input: unknown): Promise<WorkflowInstance> };
    expect((await binding.create({ id: "inherited-run" })).id).toBe("inherited-run");
  } finally {
    if (original) Object.defineProperty(globalThis, "Response", original);
  }
});

test("generated Workflow binding refuses a cyclic Response prototype without unbounded lookup", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Response");
  let cyclicPrototype: object;
  cyclicPrototype = new Proxy({}, { getPrototypeOf: () => cyclicPrototype });
  class CyclicResponse {}
  Object.setPrototypeOf(CyclicResponse.prototype, cyclicPrototype);
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    writable: true,
    value: CyclicResponse,
  });
  try {
    const runtime = await loadGeneratedRuntime("cyclic-response-prototype");
    const service = {
      async fetch(): Promise<Response> {
        return result({ id: "run-1" });
      },
    };
    const env = runtime.createSelfhostWorkflowBindingContext({
      rawEnv: { [selectedBinding.serviceName]: service },
      bindings: [selectedBinding],
    }).rawEnv;
    const binding = env.ORDERS as { create(input: unknown): Promise<WorkflowInstance> };
    await expect(binding.create({ id: "run-1" })).rejects.toMatchObject({
      name: "backend_unavailable",
    });
  } finally {
    if (original) Object.defineProperty(globalThis, "Response", original);
  }
});

test("generated Workflow binding exposes nested immutable instances over bounded private POSTs", async () => {
  const calls: Array<{ path: string; token: string | null; body: string }> = [];
  const actor = Object.freeze({ marker: "inherited Actor facade" });
  const service = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        token: request.headers.get("x-takoserver-private-workflow-binding-token"),
        body: await request.text(),
      });
      if (url.pathname.endsWith("/create")) return result({ id: "run-1", status: "queued" });
      if (url.pathname.endsWith("/get")) return result({ id: "run-1" });
      if (url.pathname.endsWith("/status"))
        return result({ status: "complete", output: { ok: true } });
      return result({});
    },
  };
  const runtime = await loadGeneratedRuntime();
  const context = runtime.createSelfhostWorkflowBindingContext({
    rawEnv: Object.assign(Object.create({ ACTOR: actor }), {
      [selectedBinding.serviceName]: service,
      KEEP: "visible",
    }) as Record<string, unknown>,
    bindings: [selectedBinding],
  });

  const projected = context.rawEnv as Record<string, unknown>;
  const binding = projected.ORDERS as {
    create(input: { id?: string; params?: unknown }): Promise<WorkflowInstance>;
    get(id: string): Promise<WorkflowInstance>;
  };
  const instance = await binding.create({ id: "run-1", params: { hello: "world" } });
  expect(instance.id).toBe("run-1");
  expect(Object.isFrozen(instance)).toBe(true);
  expect(Reflect.set(instance, "id", "changed")).toBe(false);
  expect(await instance.status()).toEqual({ status: "complete", output: { ok: true } });
  await instance.sendEvent({ type: "refresh", payload: { count: 1 } });
  await instance.terminate();
  expect((await binding.get("run-1")).id).toBe("run-1");

  expect(Object.keys(binding).sort()).toEqual(["create", "get"]);
  expect(projected.KEEP).toBe("visible");
  expect((projected.ACTOR as typeof actor).marker).toBe("inherited Actor facade");
  expect(selectedBinding.serviceName in projected).toBe(false);
  expect(calls.map(({ path }) => path)).toEqual([
    "/__takoserver/workflow-binding/v1/create",
    "/__takoserver/workflow-binding/v1/status",
    "/__takoserver/workflow-binding/v1/sendEvent",
    "/__takoserver/workflow-binding/v1/terminate",
    "/__takoserver/workflow-binding/v1/get",
  ]);
  expect(calls.map(({ body }) => body)).toEqual([
    '{"id":"run-1","params":{"hello":"world"}}',
    '{"id":"run-1"}',
    '{"id":"run-1","type":"refresh","payload":{"count":1}}',
    '{"id":"run-1"}',
    '{"id":"run-1"}',
  ]);
  expect(calls.every(({ token }) => token === selectedBinding.token)).toBe(true);
});

test("generated wrapper preserves declared handlers and rejects binding alias ambiguity", () => {
  const source = selfhostWorkflowBindingEntrypointSource({
    runtimeModule: "runtime.mjs",
    innerModule: "inner.mjs",
    bindings: [selectedBinding],
    queue: true,
    scheduled: true,
    events: true,
  });
  expect(source.indexOf('from "./runtime.mjs"')).toBeLessThan(source.indexOf('from "./inner.mjs"'));
  expect(source).toContain("async fetch(");
  expect(source).toContain("async queue(");
  expect(source).toContain("async scheduled(");
  expect(source).toContain("takoserverSelfhostEvents");
  expect(source).toContain("__takoserverSelfhostProjectEnv");
  expect(source).toContain('"publicName":"ORDERS"');
  expect(() =>
    selfhostWorkflowBindingEntrypointSource({
      runtimeModule: "runtime.mjs",
      innerModule: "inner.mjs",
      bindings: [selectedBinding, { ...selectedBinding }],
    }),
  ).toThrow();
});

test("Workflow outer wrapper composes Actor projection, class projectEnv, and all declared handlers", async () => {
  const actorBinding = {
    publicName: "ROOM",
    httpService: "__TAKOSERVER_ACTOR_HTTP",
    upgradeService: "__TAKOSERVER_ACTOR_UPGRADE",
    token: "b".repeat(64),
  };
  const actorSource = selfhostActorForwardEntrypointSource({
    runtimeModule: "actor-runtime.mjs",
    innerModule: "base.mjs",
    bindings: [actorBinding],
    queue: true,
    scheduled: true,
    events: true,
    projectEnvironment: true,
  });
  const workflowSource = selfhostWorkflowBindingEntrypointSource({
    runtimeModule: "workflow-runtime.mjs",
    innerModule: "actor-wrapper.mjs",
    bindings: [selectedBinding],
    queue: true,
    scheduled: true,
    events: true,
  });
  const baseSource = `
const describe = (env) => JSON.stringify({
  hasActor: typeof env.ROOM?.newUniqueId === "function",
  hasWorkflow: typeof env.ORDERS?.create === "function",
  privateWorkflowService: Object.hasOwn(env, "${selectedBinding.serviceName}") || env["${selectedBinding.serviceName}"] !== undefined,
});
export default {
  async fetch(_request, env) {
    const instance = await env.ORDERS.create({ id: "journey" });
    return new Response(JSON.stringify({ id: instance.id, env: JSON.parse(describe(env)) }));
  },
};
export async function queue(_event, env) { return new Response(describe(env)); }
export async function scheduled(_event, env) { return new Response(describe(env)); }
export function __takoserverSelfhostProjectEnv(rawEnv) { return rawEnv; }
export const takoserverSelfhostEvents = { async fetch(_request, env) { return new Response(describe(env)); } };
`;
  const directory = mkdtempSync(join(tmpdir(), "workflow-binding-wrapper-"));
  const responseDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Response");
  try {
    writeFileSync(
      join(directory, "actor-runtime.mjs"),
      renderSelfhostActorForwardRuntimeModuleSource(),
    );
    writeFileSync(
      join(directory, "workflow-runtime.mjs"),
      renderSelfhostWorkflowBindingRuntimeModuleSource(),
    );
    writeFileSync(join(directory, "base.mjs"), baseSource);
    writeFileSync(join(directory, "actor-wrapper.mjs"), actorSource);
    writeFileSync(join(directory, "workflow-wrapper.mjs"), workflowSource);
    const wrapper = (await import(pathToFileURL(join(directory, "workflow-wrapper.mjs")).href)) as {
      readonly default: {
        fetch(request: Request, env: Record<string, unknown>, context: object): Promise<Response>;
        queue(event: unknown, env: Record<string, unknown>, context: object): Promise<Response>;
        scheduled(event: unknown, env: Record<string, unknown>, context: object): Promise<Response>;
      };
      readonly takoserverSelfhostEvents: {
        fetch(request: Request, env: Record<string, unknown>, context: object): Promise<Response>;
      };
      readonly __takoserverSelfhostProjectEnv: (
        env: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const rawEnv = {
      [selectedBinding.serviceName]: {
        async fetch(): Promise<Response> {
          return result({ id: "journey", status: "queued" });
        },
      },
      [actorBinding.httpService]: {
        async fetch(): Promise<Response> {
          return new Response("actor transport");
        },
      },
      [actorBinding.upgradeService]: {
        async fetch(): Promise<Response> {
          return new Response("actor upgrade");
        },
      },
      BASE: "visible",
    };
    const request = new Request("https://worker.example/");
    const context = {};
    const fetchResponse = await wrapper.default.fetch(request, rawEnv, context);
    expect(await fetchResponse.json()).toEqual({
      id: "journey",
      env: { hasActor: true, hasWorkflow: true, privateWorkflowService: false },
    });
    for (const response of [
      await wrapper.default.queue({}, rawEnv, context),
      await wrapper.default.scheduled({}, rawEnv, context),
      await wrapper.takoserverSelfhostEvents.fetch(request, rawEnv, context),
    ]) {
      expect(await response.json()).toEqual({
        hasActor: true,
        hasWorkflow: true,
        privateWorkflowService: false,
      });
    }
    const projectEnv = wrapper.__takoserverSelfhostProjectEnv(rawEnv);
    expect(typeof (projectEnv.ROOM as { newUniqueId?: unknown }).newUniqueId).toBe("function");
    expect(typeof (projectEnv.ORDERS as { create?: unknown }).create).toBe("function");
    expect(projectEnv[selectedBinding.serviceName]).toBeUndefined();
    expect(JSON.stringify(projectEnv)).not.toContain(selectedBinding.token);
  } finally {
    if (responseDescriptor) {
      Object.defineProperty(globalThis, "Response", responseDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "Response");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Workflow project env composes with the actual standard self-host wrapper", async () => {
  const standardSource = selfhostWorkerEntrypointSource({
    originalMainModule: "tenant.js",
    declaredHandlers: ["fetch"],
    bindings: [
      { name: "ORDERS", type: "plain_text" },
      { name: "VISIBLE", type: "plain_text" },
    ],
    publication: "wrapper-test-v1",
    probeHostname: "wrapper-test.internal.invalid",
  });
  const workflowSource = selfhostWorkflowBindingEntrypointSource({
    runtimeModule: "workflow-runtime.mjs",
    innerModule: "standard-wrapper.mjs",
    bindings: [selectedBinding],
  });
  const directory = mkdtempSync(join(tmpdir(), "workflow-standard-wrapper-"));
  try {
    writeFileSync(
      join(directory, "workflow-runtime.mjs"),
      renderSelfhostWorkflowBindingRuntimeModuleSource(),
    );
    writeFileSync(join(directory, "standard-wrapper.mjs"), standardSource);
    writeFileSync(
      join(directory, "tenant.js"),
      "export default { async fetch() { return new Response('ok'); } };\n",
    );
    writeFileSync(
      join(directory, selfhostWorkerPreludeModuleName("tenant.js")),
      selfhostWorkerPreludeSource(),
    );
    writeFileSync(join(directory, "workflow-wrapper.mjs"), workflowSource);
    const wrapper = (await import(pathToFileURL(join(directory, "workflow-wrapper.mjs")).href)) as {
      readonly __takoserverSelfhostProjectEnv: (
        rawEnv: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const service = {
      async fetch(): Promise<Response> {
        return result({ id: "run-1", status: "queued" });
      },
    };
    const env = wrapper.__takoserverSelfhostProjectEnv({
      [selectedBinding.serviceName]: service,
      VISIBLE: "ordinary binding",
    });
    const workflow = env.ORDERS as {
      create(input: { id: string }): Promise<WorkflowInstance>;
    };
    expect(env.VISIBLE).toBe("ordinary binding");
    expect(typeof workflow.create).toBe("function");
    expect(Object.isFrozen(workflow)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Actor-only wrapper output remains byte-identical unless project env composition is opted in", () => {
  const source = selfhostActorForwardEntrypointSource({
    runtimeModule: "runtime.mjs",
    innerModule: "inner.mjs",
    bindings: [
      {
        publicName: "ROOM",
        httpService: "__TAKOSERVER_ACTOR_HTTP",
        upgradeService: "__TAKOSERVER_ACTOR_UPGRADE",
        token: "a".repeat(64),
      },
    ],
    queue: true,
    scheduled: true,
    events: true,
  });
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "04cb9297c5418c4e2c4c40024a31d0a95e289f551bf00b544cb038fd0592703d",
  );
});

test("generated facade snapshots data before transport and maps only the closed operation errors", async () => {
  const calls: string[] = [];
  const service = {
    async fetch(request: Request): Promise<Response> {
      calls.push(new URL(request.url).pathname);
      const code = new URL(request.url).pathname.endsWith("/create")
        ? "instance_exists"
        : "unknown_instance";
      return new Response(
        JSON.stringify({ schema: "takoserver.selfhost-workflow-binding-result@v1", error: code }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
  const runtime = await loadGeneratedRuntime();
  const env = runtime.createSelfhostWorkflowBindingContext({
    rawEnv: { [selectedBinding.serviceName]: service },
    bindings: [selectedBinding],
  }).rawEnv;
  const binding = env.ORDERS as {
    create(input: unknown): Promise<WorkflowInstance>;
    get(id: string): Promise<WorkflowInstance>;
  };

  let getterReads = 0;
  const accessorParams = Object.defineProperty({ id: "run-1" }, "params", {
    enumerable: true,
    get() {
      getterReads += 1;
      return { secret: true };
    },
  });
  await expect(binding.create(accessorParams)).rejects.toMatchObject({ name: "TypeError" });
  expect(getterReads).toBe(0);
  await expect(
    binding.create({ id: "run-1", params: { nested: undefined } }),
  ).rejects.toMatchObject({
    name: "invalid_params",
  });
  await expect(
    binding.create({ id: "run-1", params: { large: "x".repeat(1_048_577) } }),
  ).rejects.toMatchObject({
    name: "document_too_large",
  });
  await expect(
    (binding.create as (...args: unknown[]) => Promise<WorkflowInstance>)(),
  ).rejects.toMatchObject({
    name: "TypeError",
  });
  await expect(binding.create({ id: "run-1" })).rejects.toMatchObject({ name: "instance_exists" });
  await expect(binding.get("missing")).rejects.toMatchObject({ name: "unknown_instance" });
  expect(calls).toEqual([
    "/__takoserver/workflow-binding/v1/create",
    "/__takoserver/workflow-binding/v1/get",
  ]);
});

test("generated facade does not retry an operation whose acknowledgement is lost", async () => {
  let calls = 0;
  const service = {
    async fetch(): Promise<Response> {
      calls += 1;
      throw new Error("private transport diagnostics must not escape");
    },
  };
  const runtime = await loadGeneratedRuntime();
  const env = runtime.createSelfhostWorkflowBindingContext({
    rawEnv: { [selectedBinding.serviceName]: service },
    bindings: [selectedBinding],
  }).rawEnv;
  const binding = env.ORDERS as { create(input: unknown): Promise<WorkflowInstance> };
  await expect(binding.create({ id: "run-1" })).rejects.toMatchObject({
    name: "backend_unavailable",
  });
  expect(calls).toBe(1);
});

test("generated facade accepts a workflow error message at the Unicode scalar limit", async () => {
  const message = "界".repeat(8_192);
  const service = {
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname.endsWith("/get")) return result({ id: "run-1" });
      return result({
        status: "errored",
        error: { reason: "run_threw", message },
      });
    },
  };
  const runtime = await loadGeneratedRuntime();
  const env = runtime.createSelfhostWorkflowBindingContext({
    rawEnv: { [selectedBinding.serviceName]: service },
    bindings: [selectedBinding],
  }).rawEnv;
  const binding = env.ORDERS as { get(id: string): Promise<WorkflowInstance> };
  const instance = await binding.get("run-1");

  expect(await instance.status()).toEqual({
    status: "errored",
    error: { reason: "run_threw", message },
  });
});

test("generated facade omits explicitly undefined optional params and event payloads", async () => {
  const bodies: string[] = [];
  const service = {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      bodies.push(await request.text());
      return path.endsWith("/create") ? result({ id: "run-1", status: "queued" }) : result({});
    },
  };
  const runtime = await loadGeneratedRuntime();
  const env = runtime.createSelfhostWorkflowBindingContext({
    rawEnv: { [selectedBinding.serviceName]: service },
    bindings: [selectedBinding],
  }).rawEnv;
  const binding = env.ORDERS as {
    create(input: { id?: string; params?: unknown }): Promise<WorkflowInstance>;
  };
  const instance = await binding.create({ id: "run-1", params: undefined });
  await instance.sendEvent({ type: "refresh", payload: undefined });

  expect(bodies).toEqual(['{"id":"run-1"}', '{"id":"run-1","type":"refresh"}']);
});
