import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createCloudflareManagedWorkerGateway,
  createD1ManagedWorkerGatewayState,
  MANAGED_WORKER_SCHEDULE_LEASE_TTL_MILLIS,
  type ManagedWorkerD1Database,
  type ManagedWorkerD1Session,
  type ManagedWorkerD1Statement,
  type ManagedWorkerDispatchNamespace,
  type ManagedWorkerGatewayState,
  type ManagedWorkerMessage,
  type ManagedWorkerRouteKind,
  type ManagedWorkerScheduleLease,
  managedWorkerEntrypointSource,
  managedWorkerGatewayProps,
  managedWorkerHostRouteKey,
  managedWorkerQueueRouteKey,
  managedWorkerReleaseRouteKey,
  managedWorkerScheduleRouteKey,
  parseManagedWorkerGatewayProps,
  parseManagedWorkerRouteTombstone,
  TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE,
  TAKOSERVER_MANAGED_WORKER_EVENT_PATH,
  TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
  TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP,
  TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS,
  TAKOSERVER_MANAGED_WORKER_ROUTE_TOMBSTONE_SCHEMA,
} from "../src/providers/cloudflare-managed-worker-gateway.ts";

class MemoryState implements ManagedWorkerGatewayState {
  readonly routes = new Map<string, Awaited<ReturnType<ManagedWorkerGatewayState["readRoute"]>>>();
  readonly scheduleLease: ManagedWorkerScheduleLease;
  failing = false;

  constructor(scheduleLease: ManagedWorkerScheduleLease = new TestScheduleLease()) {
    this.scheduleLease = scheduleLease;
  }

  async readRoute(kind: ManagedWorkerRouteKind, key: string) {
    if (this.failing) throw new Error("state unavailable");
    return this.routes.get(`${kind}:${key}`) ?? { kind: "missing" as const };
  }
}

class RecordingDispatcher implements ManagedWorkerDispatchNamespace {
  readonly calls: {
    scriptName: string;
    props: Readonly<Record<string, unknown>> | undefined;
    request: Request;
  }[] = [];
  readonly responses = new Map<string, Response | (() => Response)>();
  failing = false;

  get(scriptName: string, props?: Readonly<Record<string, unknown>>) {
    return {
      fetch: async (request: Request) => {
        if (this.failing) throw new Error("dispatcher unavailable");
        this.calls.push({ scriptName, props, request });
        const response = this.responses.get(scriptName);
        return typeof response === "function" ? response() : (response ?? new Response("ok"));
      },
    };
  }
}

class TestScheduleLease implements ManagedWorkerScheduleLease {
  readonly acquired: string[] = [];
  readonly released: string[] = [];
  readonly held = new Set<string>();
  failKeys = new Set<string>();

  async acquire(cron: string, logicalWorkerId: string): Promise<{ readonly token: string } | null> {
    const key = `${cron}:${logicalWorkerId}`;
    if (this.failKeys.has(key)) throw new Error(`lease failed: ${key}`);
    if (this.held.has(key)) return null;
    this.held.add(key);
    this.acquired.push(key);
    return { token: `token:${key}` };
  }

  async release(cron: string, logicalWorkerId: string, token: string): Promise<void> {
    const key = `${cron}:${logicalWorkerId}`;
    expect(token).toBe(`token:${key}`);
    this.held.delete(key);
    this.released.push(key);
  }
}

function put(state: MemoryState, kind: ManagedWorkerRouteKind, key: string, value: unknown): void {
  const route = value as { readonly generation?: unknown; readonly schema?: unknown };
  state.routes.set(
    `${kind}:${key}`,
    route.schema === TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.tombstone
      ? { kind: "tombstone", generation: route.generation as number }
      : { kind: "valid", value: value as never },
  );
}

function malformed(state: MemoryState, kind: ManagedWorkerRouteKind, key: string): void {
  state.routes.set(`${kind}:${key}`, { kind: "malformed" });
}

function gateway(state: MemoryState, dispatcher: RecordingDispatcher) {
  return createCloudflareManagedWorkerGateway({
    state,
    dispatcher,
    identity: { gatewayId: "gateway-test", environment: "integration" },
  });
}

function releaseRoute(_logicalWorkerId = "worker_1", scriptName = "customer-script-a") {
  return {
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.worker,
    generation: 1,
    deploymentId: "deployment_1",
    releases: [{ scriptName, percentage: 100 }],
  };
}

function hostRoute(logicalWorkerId = "worker_1") {
  return {
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.host,
    generation: 1,
    logicalWorkerId,
  };
}

function queueRoute(logicalWorkerId = "worker_1") {
  return {
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.queue,
    generation: 1,
    logicalWorkerId,
  };
}

function fakeMessage(
  id: string,
  attempts: number,
  body: unknown = new Uint8Array([1, 2, 3]),
): ManagedWorkerMessage {
  let state: string | undefined;
  return {
    id,
    timestamp: new Date("2026-08-31T00:00:00.000Z"),
    attempts,
    body,
    ack() {
      state = "ack";
    },
    retry(options) {
      state = options?.delaySeconds === undefined ? "retry" : `retry:${options.delaySeconds}`;
    },
    get __state() {
      return state;
    },
  } as ManagedWorkerMessage & { readonly __state: string | undefined };
}

function messageState(message: ManagedWorkerMessage): string | undefined {
  return (message as ManagedWorkerMessage & { readonly __state?: string }).__state;
}

function putStandardHttp(state: MemoryState): void {
  put(state, "host", managedWorkerHostRouteKey("app.example.com"), hostRoute());
  put(state, "worker", managedWorkerReleaseRouteKey("worker_1"), releaseRoute());
}

function putStandardQueue(state: MemoryState): void {
  put(state, "queue", managedWorkerQueueRouteKey("events"), queueRoute());
  put(state, "worker", managedWorkerReleaseRouteKey("worker_1"), releaseRoute());
}

test("managed Worker key builders canonicalize only prescribed dimensions", () => {
  expect(managedWorkerHostRouteKey("App.Example.COM.")).toBe("host/v1/app.example.com");
  expect(managedWorkerReleaseRouteKey("worker_1")).toBe("worker/v1/worker_1");
  expect(managedWorkerQueueRouteKey("events.main")).toBe("queue/v1/events.main");
  expect(managedWorkerScheduleRouteKey("*/5 * * * *")).toBe("schedule/v1/*%2F5%20*%20*%20*%20*");
});

test("route documents require generation and exact release basis points", () => {
  const state = new MemoryState();
  const route = {
    ...releaseRoute(),
    releases: [
      { scriptName: "customer-script-a", percentage: 33.33 },
      { scriptName: "customer-script-b", percentage: 66.67 },
    ],
  };
  put(state, "worker", managedWorkerReleaseRouteKey("worker_1"), route);
  expect(state.routes.get(`worker:${managedWorkerReleaseRouteKey("worker_1")}`)).toMatchObject({
    kind: "valid",
  });
  malformed(state, "worker", managedWorkerReleaseRouteKey("worker_1"));
  expect(state.routes.get(`worker:${managedWorkerReleaseRouteKey("worker_1")}`)?.kind).toBe(
    "malformed",
  );
  expect(
    parseManagedWorkerRouteTombstone({
      schema: TAKOSERVER_MANAGED_WORKER_ROUTE_TOMBSTONE_SCHEMA,
      generation: 2,
    }).generation,
  ).toBe(2);
});

test("HTTP dispatch reads host then release routes and passes strict trusted props", async () => {
  const state = new MemoryState();
  const dispatcher = new RecordingDispatcher();
  putStandardHttp(state);
  const worker = gateway(state, dispatcher);
  const first = await worker.fetch(new Request("https://APP.EXAMPLE.COM/hello?x=1"));
  const second = await worker.fetch(new Request("https://app.example.com/hello?x=1"));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(dispatcher.calls).toHaveLength(2);
  expect(dispatcher.calls[0]?.request.url).toBe("https://app.example.com/hello?x=1");
  expect(dispatcher.calls[0]?.props).toEqual({
    [TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP]: managedWorkerGatewayProps({
      identity: { gatewayId: "gateway-test", environment: "integration" },
      logicalWorkerId: "worker_1",
      deploymentId: "deployment_1",
      entrypoint: "fetch",
    }),
  });
  expect(
    parseManagedWorkerGatewayProps(
      dispatcher.calls[0]?.props?.[TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP],
    ).deploymentId,
  ).toBe("deployment_1");
});

test("HTTP release weights use per-request entropy for the same URL", async () => {
  const state = new MemoryState();
  const dispatcher = new RecordingDispatcher();
  put(state, "host", managedWorkerHostRouteKey("app.example.com"), hostRoute());
  put(state, "worker", managedWorkerReleaseRouteKey("worker_1"), {
    ...releaseRoute(),
    releases: [
      { scriptName: "customer-script-a", percentage: 50 },
      { scriptName: "customer-script-b", percentage: 50 },
    ],
  });
  const worker = gateway(state, dispatcher);
  for (let index = 0; index < 64; index += 1)
    expect((await worker.fetch(new Request("https://app.example.com/hot"))).status).toBe(200);
  expect(new Set(dispatcher.calls.map(({ scriptName }) => scriptName))).toEqual(
    new Set(["customer-script-a", "customer-script-b"]),
  );
});

test("missing routes are 404, present malformed routes are 503, and tombstones are unclaimed", async () => {
  const state = new MemoryState();
  const dispatcher = new RecordingDispatcher();
  const worker = gateway(state, dispatcher);
  expect((await worker.fetch(new Request("https://missing.example/"))).status).toBe(404);
  malformed(state, "host", managedWorkerHostRouteKey("missing.example"));
  expect((await worker.fetch(new Request("https://missing.example/"))).status).toBe(503);
  put(state, "host", managedWorkerHostRouteKey("tombstone.example"), {
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.tombstone,
    generation: 2,
  });
  expect((await worker.fetch(new Request("https://tombstone.example/"))).status).toBe(404);
});

test("Queue dispatch uses exact encoded-bytes ABI and settles decisions", async () => {
  const state = new MemoryState();
  const dispatcher = new RecordingDispatcher();
  putStandardQueue(state);
  dispatcher.responses.set("customer-script-a", () =>
    Response.json({
      protocol: TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      decisions: [
        { messageId: "m1", outcome: "ack" },
        { messageId: "m2", outcome: "retry", delaySeconds: 30 },
        { messageId: "m3", outcome: "ack" },
      ],
    }),
  );
  const body = new Uint8Array([9, 8, 7, 6]);
  const view = new Uint8Array(body.buffer, 1, 2);
  const messages = [
    fakeMessage("m1", 1, "hello"),
    fakeMessage("m2", 2, body.buffer),
    fakeMessage("m3", 3, view),
  ];
  await gateway(state, dispatcher).queue({ batchId: "batch-1", queue: "events", messages });
  expect(messages.map(messageState)).toEqual(["ack", "retry:30", "ack"]);
  const event = (await dispatcher.calls[0]?.request.json()) as {
    readonly batchId: string;
    readonly messages: readonly {
      readonly messageId: string;
      readonly timestampMillis: number;
      readonly attempts: number;
      readonly body: unknown;
    }[];
  };
  expect(event.batchId).toBe("batch-1");
  expect(event.messages).toEqual([
    {
      messageId: "m1",
      timestampMillis: 1788134400000,
      attempts: 1,
      body: { encoding: "base64", data: "aGVsbG8=" },
    },
    {
      messageId: "m2",
      timestampMillis: 1788134400000,
      attempts: 2,
      body: { encoding: "base64", data: "CQgHBg==" },
    },
    {
      messageId: "m3",
      timestampMillis: 1788134400000,
      attempts: 3,
      body: { encoding: "base64", data: "CAc=" },
    },
  ]);
});

test("Queue object bodies fail closed and retry settlement attempts every message", async () => {
  const state = new MemoryState();
  const dispatcher = new RecordingDispatcher();
  putStandardQueue(state);
  const objectMessage = fakeMessage("object", 1, { unsafe: true });
  await gateway(state, dispatcher).queue({
    batchId: "batch-1",
    queue: "events",
    messages: [objectMessage],
  });
  expect(messageState(objectMessage)).toBe("retry");
  const attempted: string[] = [];
  const messages = [
    {
      ...fakeMessage("retry-a", 1),
      retry() {
        attempted.push("retry-a");
        throw new Error("settlement failed");
      },
    },
    {
      ...fakeMessage("retry-b", 1),
      retry() {
        attempted.push("retry-b");
      },
    },
  ] as readonly ManagedWorkerMessage[];
  let failure: unknown;
  try {
    await gateway(new MemoryState(), dispatcher).queue({
      batchId: "batch-2",
      queue: "events",
      messages,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("retry settlement failed");
  expect(attempted).toEqual(["retry-a", "retry-b"]);
});

test("Schedule fanout continues after one customer failure and fences leases", async () => {
  const scheduleLease = new TestScheduleLease();
  const state = new MemoryState(scheduleLease);
  const dispatcher = new RecordingDispatcher();
  const cron = "*/5 * * * *";
  put(state, "schedule", managedWorkerScheduleRouteKey(cron), {
    schema: TAKOSERVER_MANAGED_WORKER_ROUTE_SCHEMAS.schedule,
    generation: 1,
    logicalWorkerIds: ["worker_a", "worker_b"],
  });
  put(
    state,
    "worker",
    managedWorkerReleaseRouteKey("worker_a"),
    releaseRoute("worker_a", "customer-a"),
  );
  put(
    state,
    "worker",
    managedWorkerReleaseRouteKey("worker_b"),
    releaseRoute("worker_b", "customer-b"),
  );
  dispatcher.responses.set("customer-a", new Response("failure", { status: 500 }));
  dispatcher.responses.set("customer-b", new Response("ok"));
  let failure: unknown;
  try {
    await gateway(state, dispatcher).scheduled({ cron, scheduledTime: 1_725_000_000_000 });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(dispatcher.calls.map(({ scriptName }) => scriptName)).toEqual([
    "customer-a",
    "customer-b",
  ]);
  expect(scheduleLease.acquired).toHaveLength(2);
  expect(scheduleLease.released).toHaveLength(2);
});

test("D1 state uses first-primary, validates embedded generation, and fail-closes tombstones", async () => {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  let row: Record<string, unknown> | null = {
    owner_native_id: "native-1",
    generation: 2,
    operation_id: "operation-2",
    state: "active",
    value_json: JSON.stringify({ ...hostRoute(), generation: 2 }),
  };
  const database: ManagedWorkerD1Database = {
    withSession(constraint) {
      expect(constraint).toBe("first-primary");
      return {
        prepare(sql) {
          return {
            bind(...values) {
              queries.push({ sql, values });
              return this;
            },
            async first() {
              return row;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          } as ManagedWorkerD1Statement;
        },
      } as ManagedWorkerD1Session;
    },
  };
  const state = createD1ManagedWorkerGatewayState({ database, providerId: "provider-1" });
  expect(await state.readRoute("host", managedWorkerHostRouteKey("app.example.com"))).toMatchObject(
    { kind: "valid" },
  );
  expect(queries[0]?.sql).toContain("FROM cloudflare_managed_worker_routes");
  row = { ...row, value_json: JSON.stringify({ ...hostRoute(), generation: 1 }) };
  expect(await state.readRoute("host", managedWorkerHostRouteKey("app.example.com"))).toEqual({
    kind: "malformed",
  });
  row = {
    ...row,
    generation: 3,
    state: "tombstone",
    value_json: JSON.stringify({
      schema: TAKOSERVER_MANAGED_WORKER_ROUTE_TOMBSTONE_SCHEMA,
      generation: 3,
    }),
  };
  expect(await state.readRoute("host", managedWorkerHostRouteKey("app.example.com"))).toEqual({
    kind: "tombstone",
    generation: 3,
  });
});

test("D1 cron leases fence the full 15-minute window with a 20-minute TTL", async () => {
  expect(MANAGED_WORKER_SCHEDULE_LEASE_TTL_MILLIS).toBe(1_200_000);
  let leaseToken: string | null = null;
  let leaseExpiry = -1;
  const database: ManagedWorkerD1Database = {
    withSession(constraint) {
      expect(constraint).toBe("first-primary");
      return {
        prepare(sql) {
          let values: readonly unknown[] = [];
          return {
            bind(...bound) {
              values = bound;
              return this;
            },
            async first() {
              if (!sql.includes("INSERT INTO cloudflare_managed_worker_cron_leases")) return null;
              const token = values[3];
              const expiresAt = values[4];
              const now = values[5];
              if (
                typeof token !== "string" ||
                typeof expiresAt !== "number" ||
                typeof now !== "number" ||
                (leaseToken !== null && leaseExpiry > now)
              ) {
                return null;
              }
              leaseToken = token;
              leaseExpiry = expiresAt;
              return { lease_token: token };
            },
            async run() {
              if (sql.includes("DELETE FROM cloudflare_managed_worker_cron_leases")) {
                if (values[3] === leaseToken) {
                  leaseToken = null;
                  leaseExpiry = -1;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 0 } };
            },
          } as ManagedWorkerD1Statement;
        },
      } as ManagedWorkerD1Session;
    },
  };
  const state = createD1ManagedWorkerGatewayState({ database, providerId: "provider-1" });
  const first = await state.scheduleLease.acquire("*/5 * * * *", "worker_1", 0);
  expect(first).not.toBeNull();
  expect(await state.scheduleLease.acquire("*/5 * * * *", "worker_1", 899_999)).toBeNull();
  const afterExpiry = await state.scheduleLease.acquire("*/5 * * * *", "worker_1", 1_200_000);
  expect(afterExpiry).not.toBeNull();
  expect(afterExpiry?.token).not.toBe(first?.token);
  await state.scheduleLease.release("*/5 * * * *", "worker_1", afterExpiry?.token ?? "");
  expect(leaseToken).toBeNull();
});

test("wrapper exposes exact Queue ABI and survives customer intrinsic tampering", async () => {
  const suffix = crypto.randomUUID();
  const customerModule = `takoserver-managed-customer-${suffix}.mjs`;
  const customerPath = join("/tmp", customerModule);
  const wrapperPath = join("/tmp", `takoserver-managed-wrapper-${suffix}.mjs`);
  await Bun.write(
    customerPath,
    `let calls = 0;
const originals = {
  arrayMap: Array.prototype.map, arraySort: Array.prototype.sort, arrayJoin: Array.prototype.join,
  mapGet: Map.prototype.get, mapSet: Map.prototype.set, jsonParse: JSON.parse,
  responseJson: Response.json, numberSafe: Number.isSafeInteger, promiseResolve: Promise.resolve,
  arrayIterator: Array.prototype[Symbol.iterator], textDecoderDecode: TextDecoder.prototype.decode,
};
export function restore() {
  Array.prototype.map = originals.arrayMap; Array.prototype.sort = originals.arraySort; Array.prototype.join = originals.arrayJoin;
  Map.prototype.get = originals.mapGet; Map.prototype.set = originals.mapSet; JSON.parse = originals.jsonParse;
  Response.json = originals.responseJson; Number.isSafeInteger = originals.numberSafe; Promise.resolve = originals.promiseResolve;
  Array.prototype[Symbol.iterator] = originals.arrayIterator; TextDecoder.prototype.decode = originals.textDecoderDecode;
}
export default {
  queue(batch, env, ctx) {
    if (calls === 0) {
      const keys = Object.keys(ctx);
      if (keys.length !== 1 || keys[0] !== "waitUntil" || Object.getPrototypeOf(env) !== null || Object.keys(env).length !== 0) throw new Error("shape");
    }
    calls += 1;
    if (calls === 1) {
      Array.prototype.map = () => { throw new Error("map tampered"); };
      Array.prototype.sort = () => { throw new Error("sort tampered"); };
      Array.prototype.join = () => { throw new Error("join tampered"); };
      Map.prototype.get = () => { throw new Error("get tampered"); };
      Map.prototype.set = () => { throw new Error("set tampered"); };
      JSON.parse = () => { throw new Error("parse tampered"); };
      Response.json = () => { throw new Error("response tampered"); };
      Number.isSafeInteger = () => false;
      Promise.resolve = () => { throw new Error("promise tampered"); };
      Array.prototype[Symbol.iterator] = () => { throw new Error("iterator tampered"); };
      TextDecoder.prototype.decode = () => { throw new Error("decoder tampered"); };
    }
    if (batch.messages[0].body.data !== "aGVsbG8=") throw new Error("body");
    if (calls === 1) batch.messages[0].acknowledge();
    if (calls === 3) { batch.messages[0].acknowledge(); throw new Error("handler failed"); }
  },
};
`,
  );
  await Bun.write(
    wrapperPath,
    managedWorkerEntrypointSource({
      originalMainModule: customerModule,
      declaredHandlers: ["queue"],
      bindings: [],
    }),
  );
  try {
    const wrapper = await import(`${wrapperPath}?${suffix}`);
    const props = {
      [TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP]: managedWorkerGatewayProps({
        identity: { gatewayId: "gateway-test", environment: "integration" },
        logicalWorkerId: "worker_1",
        deploymentId: "deployment_1",
        entrypoint: "queue",
      }),
    };
    const event = {
      protocol: TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      batchId: "batch-1",
      logicalWorkerId: "worker_1",
      deploymentId: "deployment_1",
      queue: "events",
      messages: [
        {
          messageId: "m1",
          timestampMillis: 1788134400000,
          attempts: 1,
          body: { encoding: "base64", data: "aGVsbG8=" },
        },
        {
          messageId: "m2",
          timestampMillis: 1788134400000,
          attempts: 1,
          body: { encoding: "base64", data: "aGVsbG8=" },
        },
      ],
    };
    const request = () =>
      new Request(`https://worker.internal${TAKOSERVER_MANAGED_WORKER_EVENT_PATH}`, {
        method: "POST",
        headers: {
          "content-type": TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE,
          "x-takoserver-managed-worker-event": TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
        },
        body: JSON.stringify(event),
      });
    const first = await wrapper.default.fetch(request(), { declared: true }, { props });
    const second = await wrapper.default.fetch(request(), { declared: true }, { props });
    const third = await wrapper.default.fetch(request(), { declared: true }, { props });
    const customer = (await import(customerPath)) as { restore(): void };
    customer.restore();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(await first.json()).toMatchObject({
      decisions: [
        { messageId: "m1", outcome: "ack" },
        { messageId: "m2", outcome: "ack" },
      ],
    });
    expect(await second.json()).toMatchObject({
      decisions: [
        { messageId: "m1", outcome: "ack" },
        { messageId: "m2", outcome: "ack" },
      ],
    });
    expect(await third.json()).toMatchObject({
      decisions: [
        { messageId: "m1", outcome: "ack" },
        { messageId: "m2", outcome: "retry" },
      ],
    });
  } finally {
    await rm(customerPath, { force: true });
    await rm(wrapperPath, { force: true });
  }
});

test("wrapper waitUntil rejection is diagnostics-only and successful queue return acknowledges", async () => {
  const suffix = crypto.randomUUID();
  const customerModule = `takoserver-managed-waituntil-${suffix}.mjs`;
  const customerPath = join("/tmp", customerModule);
  const wrapperPath = join("/tmp", `takoserver-managed-waituntil-wrapper-${suffix}.mjs`);
  await Bun.write(
    customerPath,
    `export default { queue(batch, env, ctx) { ctx.waitUntil(Promise.reject(new Error("background failed"))); } };\n`,
  );
  await Bun.write(
    wrapperPath,
    managedWorkerEntrypointSource({
      originalMainModule: customerModule,
      declaredHandlers: ["queue"],
      bindings: [],
    }),
  );
  try {
    const wrapper = await import(`${wrapperPath}?${suffix}`);
    const props = {
      [TAKOSERVER_MANAGED_WORKER_GATEWAY_PROP]: managedWorkerGatewayProps({
        identity: { gatewayId: "gateway-test", environment: "integration" },
        logicalWorkerId: "worker_1",
        deploymentId: "deployment_1",
        entrypoint: "queue",
      }),
    };
    const event = {
      protocol: TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
      kind: "queue",
      batchId: "batch-1",
      logicalWorkerId: "worker_1",
      deploymentId: "deployment_1",
      queue: "events",
      messages: [
        {
          messageId: "m1",
          timestampMillis: 1788134400000,
          attempts: 1,
          body: { encoding: "base64", data: "aGVsbG8=" },
        },
      ],
    };
    const response = await wrapper.default.fetch(
      new Request(`https://worker.internal${TAKOSERVER_MANAGED_WORKER_EVENT_PATH}`, {
        method: "POST",
        headers: {
          "content-type": TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE,
          "x-takoserver-managed-worker-event": TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
        },
        body: JSON.stringify(event),
      }),
      {},
      { props },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      decisions: [{ messageId: "m1", outcome: "ack" }],
    });
  } finally {
    await rm(customerPath, { force: true });
    await rm(wrapperPath, { force: true });
  }
});
