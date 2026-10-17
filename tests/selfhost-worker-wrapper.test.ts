import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import {
  SELFHOST_WORKER_DATA_PLANE_BINDING,
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
  selfhostDataServiceSource,
} from "../src/providers/selfhost-data-service.ts";
import {
  SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE,
  SELFHOST_V2_QUEUE_EVENT_PATH,
  SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_ENTRYPOINT,
  SELFHOST_WORKER_EVENT_HEADER,
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
  selfhostScheduleEvent,
  selfhostV2QueueEvent,
} from "../src/providers/selfhost-events.ts";
import { V2_QUEUE_SETTLEMENT_SERVICE_BINDING } from "../src/providers/selfhost-v2-queue-transport.ts";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
  SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
  SELFHOST_DATA_PLANE_ORIGIN,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
  SELFHOST_DATA_PLANE_VECTOR_PATH,
  SELFHOST_V2_OBJECT_BUCKET_BINDING_ORIGIN,
  SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH,
  SELFHOST_V2_OBJECT_MULTIPART_PARTS_CONTENT_TYPE,
  SELFHOST_WORKER_DATA_SERVICE_BINDING,
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
  SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
  SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND,
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  SELFHOST_WORKER_PROJECT_ENV_EXPORT,
  SELFHOST_WORKER_READINESS_HEADER,
  SELFHOST_WORKER_READINESS_PATH,
  SELFHOST_WORKER_READINESS_PROTOCOL,
  SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
  type SelfhostWorkerEntrypointSourceInput,
  selfhostReadinessAnswer,
  selfhostReadinessFailureMessage,
  selfhostWorkerEntrypointSource,
  selfhostWorkerForwardObjectBucketEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import {
  WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING,
  WORKERD_V2_PRIVATE_KV_BINDING,
  WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING,
} from "../src/providers/workerd-v2-private-binding-names.ts";
import { serveSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";
import {
  consumeSelfhostObjectBody,
  decodeSelfhostObjectBodyFrames,
  SelfhostObjectError,
} from "../src/selfhost-object-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
  OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
  type ObjectBucketBindingForm,
} from "../src/takoform-v2/forms/object-bucket-binding-profile.ts";

/**
 * The generated entrypoint is the only thing standing between a tenant's module
 * and this Host's data planes, so what it hands over — and what it refuses to —
 * is the contract under test here. It is exercised as a real module: written to
 * disk beside a tenant module and imported, because "does the import resolve"
 * and "does the tenant see the facade" are the two things a string comparison
 * would not answer.
 */

/** Where this Host's readiness probe reaches a published script. */
const PROBE_HOSTNAME = "sw-test.selfhost-internal.invalid";
const INTERNAL_READINESS_CAPABILITY_HEADER = "x-takoserver-selfhost-runtime-readiness";
const INTERNAL_READINESS_CAPABILITY_BINDING = "__TAKOSERVER_SELFHOST_RUNTIME_READINESS";
const INTERNAL_READINESS_CAPABILITY = "f".repeat(64);

const KV_ONLY: SelfhostWorkerEntrypointSourceInput = {
  originalMainModule: "index.js",
  publication: "sw1.v1",
  probeHostname: PROBE_HOSTNAME,
  declaredHandlers: ["fetch"],
  bindings: [{ kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "KV" }],
};

interface PlaneCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

function plane(answers: Record<string, unknown>[]): {
  readonly service: { fetch(url: string, init: RequestInit): Promise<Response> };
  readonly calls: PlaneCall[];
} {
  const calls: PlaneCall[] = [];
  let index = 0;
  return {
    calls,
    service: {
      async fetch(url, init) {
        const headers = init.headers as Record<string, string>;
        calls.push({
          url,
          authorization: headers.authorization ?? null,
          body: JSON.parse(await new Response(init.body).text()) as Record<string, unknown>,
        });
        const answer = answers[index] ?? { ok: false, error: { code: "backend_unavailable" } };
        index += 1;
        return new Response(JSON.stringify(answer), { status: 200 });
      },
    },
  };
}

async function loadGenerated(
  tenantSource: string,
  input: SelfhostWorkerEntrypointSourceInput = KV_ONLY,
  forwardBindings?: readonly ObjectBucketBindingForm[],
): Promise<{
  readonly worker: {
    fetch(request: Request, env: Record<string, unknown>, context: object): Promise<Response>;
    queue?: (event: unknown, env: Record<string, unknown>, context: object) => Promise<unknown>;
  };
  readonly eventEntrypoint?: {
    fetch(request: Request, env: Record<string, unknown>, context: object): Promise<Response>;
  };
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-selfhost-wrapper-"));
  const tenantPath = join(root, input.originalMainModule);
  await mkdir(dirname(tenantPath), { recursive: true });
  await Bun.write(tenantPath, tenantSource);
  await Bun.write(
    join(root, selfhostWorkerPreludeModuleName(input.originalMainModule)),
    selfhostWorkerPreludeSource(),
  );
  const wrapperPath = join(root, "wrapper.mjs");
  await Bun.write(
    wrapperPath,
    (forwardBindings === undefined
      ? selfhostWorkerEntrypointSource
      : (source: SelfhostWorkerEntrypointSourceInput, privateNames: boolean) =>
          selfhostWorkerForwardObjectBucketEntrypointSource(
            { source, objectBucketBindings: forwardBindings },
            privateNames,
          ))(
      input,
      input.bindings.some(
        (binding) =>
          "kind" in binding &&
          (binding.kind === SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND ||
            binding.kind === SELFHOST_WORKER_EDGE_KV_BINDING_KIND) &&
          "internalName" in binding,
      ),
    ),
  );
  const loaded = (await import(
    `${pathToFileURL(wrapperPath).href}?test=${crypto.randomUUID()}`
  )) as {
    readonly default: Awaited<ReturnType<typeof loadGenerated>>["worker"];
    readonly [SELFHOST_WORKER_EVENT_ENTRYPOINT]?: Awaited<
      ReturnType<typeof loadGenerated>
    >["eventEntrypoint"];
  };
  return {
    worker: loaded.default,
    ...(loaded[SELFHOST_WORKER_EVENT_ENTRYPOINT]
      ? { eventEntrypoint: loaded[SELFHOST_WORKER_EVENT_ENTRYPOINT] }
      : {}),
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function rawEnv(
  service: { fetch(url: string, init: RequestInit): Promise<Response> },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  // The data-plane credential remains on its facade service. The readiness
  // capability is different: workerd binds it to this Host-generated wrapper,
  // which consumes it from rawEnv and never projects it to tenant code.
  return {
    [SELFHOST_WORKER_DATA_SERVICE_BINDING]: service,
    ...extra,
    [INTERNAL_READINESS_CAPABILITY_BINDING]: INTERNAL_READINESS_CAPABILITY,
  };
}

function authenticatedReadinessHeaders(): Readonly<Record<string, string>> {
  return {
    [SELFHOST_WORKER_READINESS_HEADER]: SELFHOST_WORKER_READINESS_PROTOCOL,
    [INTERNAL_READINESS_CAPABILITY_HEADER]: INTERNAL_READINESS_CAPABILITY,
  };
}

const context = { waitUntil() {} };

function v2QueueRequest(messageIds = ["message-1", "message-2"]): Request {
  const event = selfhostV2QueueEvent({
    batchId: "batch-v2-1",
    script: "worker-001",
    publication: "version-001",
    workerUid: "worker-uid-001",
    consumerUid: "consumer-uid-001",
    queueUid: "queue-uid-001",
    queue: "task_queue",
    messages: messageIds.map((messageId, index) => ({
      messageId,
      timestampMillis: 1_700_000_000_000 + index,
      attempts: 1,
      leaseToken: `lease-${index}`,
      invocationCapability: String(index).repeat(64),
      body: { encoding: "base64" as const, data: Buffer.from(`body-${index}`).toString("base64") },
    })),
  });
  return new Request(`http://takoserver-selfhost-events.invalid${SELFHOST_V2_QUEUE_EVENT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE,
      [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
    },
    body: JSON.stringify(event),
  });
}

test("v2 QueueBatch acknowledgement awaits private durable receipt, then defaults only pending", async () => {
  const generated = await loadGenerated(
    `export default { async queue(batch) {
      if (!(batch.messages[0].body instanceof Uint8Array) ||
          new TextDecoder().decode(batch.messages[0].body) !== "body-0") throw new Error("v2 body is not bytes");
      await batch.acknowledge("message-1");
    } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["queue"],
      bindings: [],
      events: true,
      v2Queue: true,
    },
  );
  const calls: Array<Record<string, unknown>> = [];
  let release: (() => void) | undefined;
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = {
    async fetch(_url: string, init: RequestInit) {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (calls.length === 1) await receipt;
      return Response.json({ ok: true, value: null });
    },
  };
  try {
    let completed = false;
    const pending = generated.eventEntrypoint
      ?.fetch(v2QueueRequest(), { [V2_QUEUE_SETTLEMENT_SERVICE_BINDING]: service }, context)
      .then((response) => {
        completed = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(completed).toBe(false);
    expect(calls).toHaveLength(1);
    release?.();
    const response = await pending;
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      protocol: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
      kind: "queue",
      outcome: "resolved",
      completion: "handler_and_wait_until",
    });
    expect(calls.map((call) => [call.messageId, call.outcome])).toEqual([
      ["message-1", "ack"],
      ["message-2", "ack"],
    ]);
    expect(calls[0]?.invocationCapability).toBe("0".repeat(64));
    expect(calls[0]?.leaseToken).toBe("lease-0");
  } finally {
    release?.();
    await generated.dispose();
  }
});

test("v2 QueueBatch retries a lost ACK response with the same settlement token", async () => {
  const generated = await loadGenerated(
    `export default { async queue(batch) { await batch.acknowledge("message-1"); } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["queue"],
      bindings: [],
      events: true,
      v2Queue: true,
    },
  );
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    async fetch(_url: string, init: RequestInit) {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (calls.length === 1) throw new Error("response lost after SQL commit");
      return Response.json({ ok: true, value: null });
    },
  };
  try {
    const response = await generated.eventEntrypoint?.fetch(
      v2QueueRequest(["message-1"]),
      { [V2_QUEUE_SETTLEMENT_SERVICE_BINDING]: service },
      context,
    );
    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.settlementToken).toBe(calls[1]?.settlementToken);
    expect(calls[0]?.settlementToken).not.toBe("");
  } finally {
    await generated.dispose();
  }
});

test("v2 ACK never resolves from a 503 carrying a success-looking body", async () => {
  const key = `__v2_ack_error_${crypto.randomUUID().replaceAll("-", "")}`;
  const generated = await loadGenerated(
    `export default { async queue(batch) {
      try { await batch.acknowledge("message-1"); globalThis[${JSON.stringify(key)}] = "resolved"; }
      catch (error) { globalThis[${JSON.stringify(key)}] = error.name; }
    } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["queue"],
      bindings: [],
      events: true,
      v2Queue: true,
    },
  );
  const calls: Array<Record<string, unknown>> = [];
  try {
    const response = await generated.eventEntrypoint?.fetch(
      v2QueueRequest(["message-1"]),
      {
        [V2_QUEUE_SETTLEMENT_SERVICE_BINDING]: {
          async fetch(_url: string, init: RequestInit) {
            calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
            return Response.json({ ok: true, value: null }, { status: 503 });
          },
        },
      },
      context,
    );
    expect((globalThis as Record<string, unknown>)[key]).toBe("backend_unavailable");
    expect(response?.status).toBe(500);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.settlementToken).toBe(calls[1]?.settlementToken);
  } finally {
    delete (globalThis as Record<string, unknown>)[key];
    await generated.dispose();
  }
});

test("v2 All methods normalize missing registered message to backend_unavailable", async () => {
  for (const method of ["acknowledgeAll", "retryAll"] as const) {
    const key = `__v2_all_error_${crypto.randomUUID().replaceAll("-", "")}`;
    const generated = await loadGenerated(
      `export default { async queue(batch) {
        try { await batch.${method}(); }
        catch (error) { globalThis[${JSON.stringify(key)}] = error.name; }
      } };`,
      {
        originalMainModule: "index.js",
        publication: "sw1.v1",
        probeHostname: PROBE_HOSTNAME,
        declaredHandlers: ["queue"],
        bindings: [],
        events: true,
        v2Queue: true,
      },
    );
    try {
      const response = await generated.eventEntrypoint?.fetch(
        v2QueueRequest(["message-1"]),
        {
          [V2_QUEUE_SETTLEMENT_SERVICE_BINDING]: {
            async fetch() {
              return Response.json(
                { ok: false, error: { code: "unknown_message" } },
                { status: 409 },
              );
            },
          },
        },
        context,
      );
      expect((globalThis as Record<string, unknown>)[key]).toBe("backend_unavailable");
      expect(response?.status).toBe(500);
    } finally {
      delete (globalThis as Record<string, unknown>)[key];
      await generated.dispose();
    }
  }
});

test("v2 QueueBatch preserves confirmed ACK and retries only pending on handler rejection", async () => {
  const generated = await loadGenerated(
    `export default { async queue(batch) {
      await batch.acknowledge("message-1");
      throw new Error("tenant-private");
    } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["queue"],
      bindings: [],
      events: true,
      v2Queue: true,
    },
  );
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    async fetch(_url: string, init: RequestInit) {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true, value: null });
    },
  };
  try {
    const response = await generated.eventEntrypoint?.fetch(
      v2QueueRequest(),
      { [V2_QUEUE_SETTLEMENT_SERVICE_BINDING]: service },
      context,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      protocol: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
      kind: "queue",
      outcome: "rejected",
      completion: "handler_and_wait_until",
    });
    expect(calls.map((call) => [call.messageId, call.outcome])).toEqual([
      ["message-1", "ack"],
      ["message-2", "retry"],
    ]);
  } finally {
    await generated.dispose();
  }
});

test("v2 completion waits for early ACK, handler, waitUntil, and nested waitUntil", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const handlerKey = `__v2_handler_${suffix}`;
  const workKey = `__v2_work_${suffix}`;
  const nestedKey = `__v2_nested_${suffix}`;
  const generated = await loadGenerated(
    `export default { async queue(batch, _env, ctx) {
      await batch.acknowledgeAll();
      await new Promise((resolve) => { globalThis[${JSON.stringify(handlerKey)}] = resolve; });
      ctx.waitUntil(new Promise((resolve) => { globalThis[${JSON.stringify(workKey)}] = resolve; })
        .then(() => { ctx.waitUntil(new Promise((resolve) => { globalThis[${JSON.stringify(nestedKey)}] = resolve; })); }));
    } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["queue"],
      bindings: [],
      events: true,
      v2Queue: true,
    },
  );
  const calls: Array<Record<string, unknown>> = [];
  const nativeWaitUntil: Promise<unknown>[] = [];
  const service = {
    async fetch(_url: string, init: RequestInit) {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true, value: null });
    },
  };
  const resolver = async (key: string): Promise<() => void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = (globalThis as Record<string, unknown>)[key];
      if (typeof value === "function") return value as () => void;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("tenant work was not registered");
  };
  try {
    let finished = false;
    const response = generated.eventEntrypoint
      ?.fetch(
        v2QueueRequest(),
        { [V2_QUEUE_SETTLEMENT_SERVICE_BINDING]: service },
        {
          waitUntil(value: Promise<unknown>) {
            nativeWaitUntil.push(value);
          },
        },
      )
      .then((value) => {
        finished = true;
        return value;
      });
    const releaseHandler = await resolver(handlerKey);
    expect(calls).toHaveLength(2);
    expect(finished).toBe(false);
    releaseHandler();
    (await resolver(workKey))();
    const releaseNested = await resolver(nestedKey);
    expect(finished).toBe(false);
    releaseNested();
    const completed = await response;
    expect(completed?.status).toBe(200);
    expect(await completed?.json()).toEqual({
      protocol: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
      kind: "queue",
      outcome: "resolved",
      completion: "handler_and_wait_until",
    });
    expect(nativeWaitUntil).toHaveLength(2);
  } finally {
    delete (globalThis as Record<string, unknown>)[handlerKey];
    delete (globalThis as Record<string, unknown>)[workKey];
    delete (globalThis as Record<string, unknown>)[nestedKey];
    await generated.dispose();
  }
});

test("v2 caught waitUntil registration failure cannot certify handler completion", async () => {
  const generated = await loadGenerated(
    `export default { async queue(batch, _env, ctx) {
      try { ctx.waitUntil(Promise.resolve()); } catch {}
      await batch.acknowledgeAll();
    } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["queue"],
      bindings: [],
      events: true,
      v2Queue: true,
    },
  );
  const calls: Array<Record<string, unknown>> = [];
  try {
    const response = await generated.eventEntrypoint?.fetch(
      v2QueueRequest(),
      {
        [V2_QUEUE_SETTLEMENT_SERVICE_BINDING]: {
          async fetch(_url: string, init: RequestInit) {
            calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
            return Response.json({ ok: true, value: null });
          },
        },
      },
      {},
    );
    expect(response?.status).toBe(500);
    expect(calls).toHaveLength(2);
  } finally {
    await generated.dispose();
  }
});

test("v2 rejected waitUntil records a bounded Host diagnostic without tenant error text", async () => {
  const lines: unknown[][] = [];
  const originalConsole = console;
  const originalError = originalConsole.error;
  let generated: Awaited<ReturnType<typeof loadGenerated>> | undefined;
  try {
    originalConsole.error = (...values: unknown[]) => {
      lines.push(values);
    };
    generated = await loadGenerated(
      `globalThis.console = null;
      export default { async queue(_batch, _env, ctx) {
        ctx.waitUntil(Promise.reject(new Error("tenant-private-error-text")));
      } };`,
      {
        originalMainModule: "index.js",
        publication: "sw1.v1",
        probeHostname: PROBE_HOSTNAME,
        declaredHandlers: ["queue"],
        bindings: [],
        events: true,
        v2Queue: true,
      },
    );
    const response = await generated.eventEntrypoint?.fetch(
      v2QueueRequest(["message-1"]),
      {
        [V2_QUEUE_SETTLEMENT_SERVICE_BINDING]: {
          async fetch() {
            return Response.json({ ok: true, value: null });
          },
        },
      },
      {
        waitUntil(value: Promise<unknown>) {
          void value.catch(() => undefined);
        },
      },
    );
    (globalThis as { console: Console }).console = originalConsole;
    expect(response?.status).toBe(200);
    expect(lines).toEqual([["self-host v2 Queue waitUntil rejected", 0]]);
    expect(JSON.stringify(lines)).not.toContain("tenant-private-error-text");
  } finally {
    (globalThis as { console: Console }).console = originalConsole;
    originalConsole.error = originalError;
    await generated?.dispose();
  }
});

test("projects the declared facades and nothing else onto the tenant environment", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const names = Object.keys(env).sort();
       const shapes = names.map((name) => typeof env[name]);
       return Response.json({ names, shapes, kv: Object.keys(env.KV).sort() });
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [
        { kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "KV" },
        { kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" },
        { name: "LANE", type: "plain_text" },
        { name: "RETRIES", type: "json" },
        { name: "ENCRYPTION_KEY", type: "secret_text" },
      ],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service, { LANE: "takoform-v1", RETRIES: 3, ENCRYPTION_KEY: "s3cret" }),
      context,
    );
    const body = (await response.json()) as {
      names: string[];
      shapes: string[];
      kv: string[];
    };
    // The service binding and the plane token are read from the raw
    // environment and left out of the one the tenant is handed.
    expect(body.names).toEqual(["DB", "ENCRYPTION_KEY", "KV", "LANE", "RETRIES"]);
    expect(body.shapes).toEqual(["object", "string", "object", "string", "number"]);
    expect(body.kv).toEqual(["delete", "get", "getWithMetadata", "list", "put"]);
  } finally {
    await generated.dispose();
  }
});

test("the edge.sql facade offers exactly execute, query, and transaction", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       return Response.json(Object.keys(env.DB).sort());
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual(["execute", "query", "transaction"]);
  } finally {
    await generated.dispose();
  }
});

test("the edge.vector facade exposes four one-argument methods and exact outputs", async () => {
  const { service, calls } = plane([
    { ok: true, value: { ids: ["one"], count: 1 } },
    {
      ok: true,
      value: {
        vectors: [{ id: "one", namespace: "docs", values: [1, 0, 0], metadata: { kind: "a" } }],
      },
    },
    { ok: true, value: { ids: ["one"], count: 1 } },
    {
      ok: true,
      value: { matches: [{ id: "one", namespace: "docs", score: 1 }], count: 1 },
    },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const upsert = await env.SEARCH.upsert({
         namespace: "docs",
         vectors: [{ id: "one", values: [1, 0, 0], metadata: { kind: "a" } }],
       });
       const get = await env.SEARCH.get({ namespace: "docs", ids: ["one"] });
       const deleted = await env.SEARCH.delete({ namespace: "docs", ids: ["one"] });
       const query = await env.SEARCH.query({
         namespace: "docs",
         values: [1, 0, 0],
         topK: 1,
       });
       return Response.json({
         methods: Object.keys(env.SEARCH).sort(),
         arities: [env.SEARCH.upsert.length, env.SEARCH.get.length, env.SEARCH.delete.length, env.SEARCH.query.length],
         outputs: { upsert, get, deleted, query },
       });
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw-vector.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND, publicName: "SEARCH" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      methods: ["delete", "get", "query", "upsert"],
      arities: [1, 1, 1, 1],
      outputs: {
        upsert: { ids: ["one"], count: 1 },
        get: {
          vectors: [{ id: "one", namespace: "docs", values: [1, 0, 0], metadata: { kind: "a" } }],
        },
        deleted: { ids: ["one"], count: 1 },
        query: { matches: [{ id: "one", namespace: "docs", score: 1 }], count: 1 },
      },
    });
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.url)).toEqual([
      `${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_VECTOR_PATH}`,
      `${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_VECTOR_PATH}`,
      `${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_VECTOR_PATH}`,
      `${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_VECTOR_PATH}`,
    ]);
    expect(calls.map((call) => call.body.op)).toEqual(["upsert", "get", "delete", "query"]);
    expect(calls[0]?.body).toEqual({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "SEARCH",
      op: "upsert",
      input: {
        namespace: "docs",
        vectors: [{ id: "one", values: [1, 0, 0], metadata: { kind: "a" } }],
      },
    });
    // The generated entrypoint never receives a plane bearer token.
    expect(calls.every((call) => call.authorization === null)).toBe(true);
  } finally {
    await generated.dispose();
  }
});

test("edge.vector methods reject extra positional arguments as invalid_spec", async () => {
  const { service, calls } = plane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const input = { values: [1, 0, 0], topK: 1 };
       const errors = [];
       for (const method of [env.SEARCH.upsert, env.SEARCH.get, env.SEARCH.delete, env.SEARCH.query]) {
         try {
           await method.call(env.SEARCH, input, "extra");
         } catch (error) {
           errors.push(error.name);
         }
       }
       return Response.json({ errors });
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw-vector-arity.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND, publicName: "SEARCH" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      errors: ["invalid_spec", "invalid_spec", "invalid_spec", "invalid_spec"],
    });
    expect(calls).toEqual([]);
  } finally {
    await generated.dispose();
  }
});

test("edge.vector rejects outputs that violate the request context and canonical shape", async () => {
  const { service, calls } = plane([
    { ok: true, value: { ids: ["other"], count: 1 } },
    {
      ok: true,
      value: {
        vectors: [{ id: "one", namespace: "other", values: [1, 0, 0], metadata: {} }],
      },
    },
    {
      ok: true,
      value: {
        matches: [
          { id: "one", namespace: "docs", score: 0.2, metadata: {} },
          { id: "two", namespace: "docs", score: 0.8 },
        ],
        count: 2,
      },
    },
    {
      ok: true,
      value: {
        matches: [{ id: "one", namespace: "docs", score: 0.8, values: [1, 0] }],
        count: 1,
      },
    },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const errors = [];
       try { await env.SEARCH.upsert({ vectors: [{ id: "one", values: [1, 0, 0] }] }); }
       catch (error) { errors.push(error.name); }
       try { await env.SEARCH.get({ namespace: "docs", ids: ["one"] }); }
       catch (error) { errors.push(error.name); }
       try { await env.SEARCH.query({ namespace: "docs", values: [1, 0, 0], topK: 1 }); }
       catch (error) { errors.push(error.name); }
       try {
         await env.SEARCH.query({
           namespace: "docs",
           values: [1, 0, 0],
           topK: 1,
           returnValues: true,
         });
       } catch (error) { errors.push(error.name); }
       return Response.json({ errors });
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw-vector-output.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND, publicName: "SEARCH" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      errors: ["unavailable", "unavailable", "unavailable", "unavailable"],
    });
    expect(calls).toHaveLength(4);
  } finally {
    await generated.dispose();
  }
});

test("edge.vector keeps construction and error names safe under poisoned tenant prototypes", async () => {
  let callCount = 0;
  const service = {
    async fetch() {
      callCount += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          value: {
            vectors: [{ id: "one", namespace: "docs", values: [1, 0, 0], metadata: {} }],
          },
        }),
      );
    },
  };
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const arrayZero = Object.getOwnPropertyDescriptor(Array.prototype, "0");
       const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
       const errorName = Object.getOwnPropertyDescriptor(Error.prototype, "name");
       Object.defineProperty(Array.prototype, "0", { configurable: true, get() { throw new Error("poison"); }, set() { throw new Error("poison"); } });
       Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, get() { throw new Error("poison"); } });
       Object.defineProperty(Error.prototype, "name", { configurable: true, get() { throw new Error("poison"); }, set() { throw new Error("poison"); } });
       try {
         const result = await env.SEARCH.get({ namespace: "docs", ids: ["one"] });
         return Response.json({ id: result.vectors[0].id, namespace: result.vectors[0].namespace, values: [result.vectors[0].values[0], result.vectors[0].values[1], result.vectors[0].values[2]] });
       } catch (error) {
         return Response.json({ error: error.name });
       } finally {
         if (arrayZero) Object.defineProperty(Array.prototype, "0", arrayZero); else delete Array.prototype["0"];
         if (iterator) Object.defineProperty(Array.prototype, Symbol.iterator, iterator); else delete Array.prototype[Symbol.iterator];
         if (errorName) Object.defineProperty(Error.prototype, "name", errorName); else delete Error.prototype.name;
       }
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw-vector-poison.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND, publicName: "SEARCH" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({ id: "one", namespace: "docs", values: [1, 0, 0] });
    expect(callCount).toBe(1);
  } finally {
    await generated.dispose();
  }
});

test("edge.vector rejects non-scalar strings and non-canonical binary32 outputs", async () => {
  const { service, calls } = plane([
    {
      ok: true,
      value: {
        vectors: [{ id: "one", namespace: "docs", values: [1.337, 0, 0], metadata: {} }],
      },
    },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const errors = [];
       try { await env.SEARCH.get({ namespace: String.fromCharCode(0xd800), ids: ["one"] }); }
       catch (error) { errors.push(error.name); }
       try { await env.SEARCH.get({ namespace: "docs", ids: ["one"] }); }
       catch (error) { errors.push(error.name); }
       return Response.json({ errors });
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw-vector-f32.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND, publicName: "SEARCH" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({ errors: ["invalid_spec", "unavailable"] });
    expect(calls).toHaveLength(1);
  } finally {
    await generated.dispose();
  }
});

test("edge.vector validates a plane answer before async thenable assimilation", async () => {
  const { service } = plane([
    {
      ok: true,
      value: {
        vectors: [{ id: "one", namespace: "docs", values: [1, 0, 0], metadata: {} }],
      },
    },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const original = Object.getOwnPropertyDescriptor(Object.prototype, "then");
       let touched = false;
       Object.defineProperty(Object.prototype, "then", {
         configurable: true,
         get() {
           if (this instanceof Response) return undefined;
           touched = true;
           throw new Error("thenable must not be observed");
         },
       });
       try {
         const result = await env.SEARCH.get({ namespace: "docs", ids: ["one"] });
         return Response.json({ id: result.vectors[0].id, touched });
       } finally {
         if (original) Object.defineProperty(Object.prototype, "then", original);
         else delete Object.prototype.then;
       }
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw-vector-thenable.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND, publicName: "SEARCH" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({ id: "one", touched: false });
  } finally {
    await generated.dispose();
  }
});

test("edge.vector does not read inherited envelope fields from a malformed answer", async () => {
  const { service } = plane([{}]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const original = Object.getOwnPropertyDescriptor(Object.prototype, "ok");
       let touched = false;
       Object.defineProperty(Object.prototype, "ok", {
         configurable: true,
         get() {
           touched = true;
           throw new Error("inherited envelope field must not be read");
         },
       });
       try {
         await env.SEARCH.get({ namespace: "docs", ids: ["one"] });
         return Response.json({ error: null, touched });
       } catch (error) {
         return Response.json({ error: error.name, touched });
       } finally {
         if (original) Object.defineProperty(Object.prototype, "ok", original);
         else delete Object.prototype.ok;
       }
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw-vector-envelope.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND, publicName: "SEARCH" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({ error: "unavailable", touched: false });
  } finally {
    await generated.dispose();
  }
});

test("a KV put and get travel as one authenticated request each", async () => {
  const { service, calls } = plane([
    { ok: true, value: {} },
    { ok: true, value: { found: true, value: btoa("stored"), metadata: { kind: "session" } } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       await env.KV.put("k", "stored", { expirationTtlSeconds: 120, metadata: { kind: "session" } });
       const found = await env.KV.getWithMetadata("k");
       return Response.json({
         value: new TextDecoder().decode(found.value),
         metadata: found.metadata,
       });
     } };`,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({ value: "stored", metadata: { kind: "session" } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toEndWith(SELFHOST_DATA_PLANE_KV_PATH);
    // The entrypoint has no credential to present and does not invent one.
    expect(calls[0]?.authorization).toBeNull();
    expect(calls[0]?.body).toEqual({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "KV",
      op: "put",
      key: "k",
      value: btoa("stored"),
      expirationTtlSeconds: 120,
      metadata: { kind: "session" },
    });
    expect(calls[1]?.body).toMatchObject({ op: "getWithMetadata", binding: "KV" });
  } finally {
    await generated.dispose();
  }
});

test("a SQL statement travels to the SQL plane and its rows come back projected", async () => {
  const { service, calls } = plane([
    { ok: true, value: { rows: [{ id: 1, name: "a" }], rowsWritten: 0 } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       return Response.json(await env.DB.query("SELECT id, name FROM t WHERE id = ?", [1]));
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({ rows: [{ id: 1, name: "a" }], rowsWritten: 0 });
    expect(calls[0]?.url).toEndWith(SELFHOST_DATA_PLANE_SQL_PATH);
    expect(calls[0]?.body).toEqual({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "query",
      statement: { sql: "SELECT id, name FROM t WHERE id = ?", params: [1] },
    });
  } finally {
    await generated.dispose();
  }
});

test("a SQL transaction returns the closed results envelope through the generated facade", async () => {
  const { service, calls } = plane([
    { ok: true, value: { results: [{ rows: [{ value: 1 }], rowsWritten: 0 }] } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       return Response.json(await env.DB.transaction([{ sql: "SELECT 1" }]));
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      results: [{ rows: [{ value: 1 }], rowsWritten: 0 }],
    });
    expect(calls[0]?.url).toEndWith(SELFHOST_DATA_PLANE_SQL_PATH);
    expect(calls[0]?.body).toEqual({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "transaction",
      statements: [{ sql: "SELECT 1" }],
    });
  } finally {
    await generated.dispose();
  }
});

test("SQL request serialization streams bounded chunks with exact JSON and captured inputs", async () => {
  const input = `${"a".repeat(4095)}😀\ud800\u0000\n${"b".repeat(900_000)}`;
  const second = "c".repeat(400_000);
  let body = "";
  let chunkCount = 0;
  let maximumChunk = 0;
  const service = {
    async fetch(url: string, init: RequestInit): Promise<Response> {
      expect(url).toEndWith(SELFHOST_DATA_PLANE_SQL_PATH);
      expect(init.method).toBe("POST");
      expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
      expect(init.body).toBeInstanceOf(ReadableStream);
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunkCount += 1;
        maximumChunk = Math.max(maximumChunk, next.value.byteLength);
        body += decoder.decode(next.value, { stream: true });
      }
      body += decoder.decode();
      return Response.json({
        ok: true,
        value: {
          results: [
            { rows: [], rowsWritten: 0 },
            { rows: [], rowsWritten: 0 },
          ],
        },
      });
    },
  };
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const first = ${JSON.stringify(input)};
       const second = ${JSON.stringify(second)};
       const statements = [
         { sql: "SELECT ?1 AS value", params: [first] },
         { sql: "SELECT ?1 AS value", params: [second, null, -0, { encoding: "base64", data: "AAE=" }] },
       ];
       const pending = env.DB.transaction(statements);
       statements[0].params[0] = "mutated after call";
       statements[1].params[0] = "mutated after call";
       return Response.json(await pending);
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(response.status).toBe(200);
    expect(chunkCount).toBeGreaterThan(10);
    expect(maximumChunk).toBeLessThan(32_768);
    expect(body).toBe(
      JSON.stringify({
        protocol: SELFHOST_DATA_PLANE_PROTOCOL,
        binding: "DB",
        op: "transaction",
        statements: [
          { sql: "SELECT ?1 AS value", params: [input] },
          {
            sql: "SELECT ?1 AS value",
            params: [second, null, -0, { encoding: "base64", data: "AAE=" }],
          },
        ],
      }),
    );
  } finally {
    await generated.dispose();
  }
});

test("the streamed SQL facade reaches a real Bun data plane through the generated data service", async () => {
  // The three Host-generated halves together, over a real loopback socket for
  // the last hop: the wrapper streams its envelope, the data service forwards
  // that stream, and Bun's fetch therefore sends it chunked with no declared
  // length. A plane that still required Content-Length refused every call.
  const root = await mkdtemp(join(tmpdir(), "takoserver-selfhost-sql-chain-"));
  const databaseRoot = join(root, "databases");
  await mkdir(databaseRoot);
  // Schema belongs to the administrative migration path; the facade refuses DDL.
  const seeded = new Database(join(databaseRoot, "chain-db.sqlite"));
  seeded.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  seeded.close();
  const control = new Database(":memory:");
  const planes = serveSelfhostDataPlanes({
    sql: createSqliteSql(control),
    grant: async (script, versionId) =>
      script === "worker" && versionId === "v1"
        ? {
            secret: "selfhost-chain-secret-0000",
            kv: {},
            sql: { DB: "chain-db" },
            queue: {},
            objects: {},
          }
        : null,
    databasePath: (name) => join(databaseRoot, `${name}.sqlite`),
    objectRoot: join(root, "objects"),
  });
  let generated: Awaited<ReturnType<typeof loadGenerated>> | undefined;
  const forwardedContentLengths: (string | null)[] = [];
  try {
    await Bun.write(join(root, SELFHOST_WORKER_DATA_SERVICE_MODULE), selfhostDataServiceSource());
    const dataService = (await import(
      `${pathToFileURL(join(root, SELFHOST_WORKER_DATA_SERVICE_MODULE)).href}?test=${crypto.randomUUID()}`
    )) as {
      readonly default: {
        fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
      };
    };
    const dataServiceEnv = {
      [SELFHOST_WORKER_DATA_TOKEN_BINDING]: "worker.v1.selfhost-chain-secret-0000",
      [SELFHOST_WORKER_DATA_PLANE_BINDING]: {
        async fetch(url: string, init: RequestInit): Promise<Response> {
          return await fetch(`http://127.0.0.1:${planes.port}${new URL(url).pathname}`, init);
        },
      },
    };
    const service = {
      async fetch(url: string, init: RequestInit): Promise<Response> {
        const request = new Request(url, init);
        forwardedContentLengths.push(request.headers.get("content-length"));
        return await dataService.default.fetch(request, dataServiceEnv);
      },
    };
    generated = await loadGenerated(
      `export default { async fetch(request, env) {
         const cleared = await env.DB.execute("DELETE FROM notes WHERE id > ?", [0]);
         const written = await env.DB.transaction([
           { sql: "INSERT INTO notes (id, body) VALUES (?, ?)", params: [1, "first 😀"] },
           { sql: "INSERT INTO notes (id, body) VALUES (?, ?)", params: [2, "x".repeat(70000)] },
         ]);
         const read = await env.DB.query("SELECT id, length(body) AS size FROM notes ORDER BY id");
         return Response.json({ cleared, written, read });
       } };`,
      {
        originalMainModule: "index.js",
        publication: "sw1.v1",
        probeHostname: PROBE_HOSTNAME,
        declaredHandlers: ["fetch"],
        bindings: [{ kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" }],
      },
    );
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cleared: { rows: [], rowsWritten: 0 },
      written: {
        results: [
          { rows: [], rowsWritten: 1 },
          { rows: [], rowsWritten: 1 },
        ],
      },
      read: {
        rows: [
          { id: 1, size: 7 },
          { id: 2, size: 70000 },
        ],
        rowsWritten: 0,
      },
    });
    // The wrapper's body really was an unknown-length stream on every call.
    expect(forwardedContentLengths).toEqual([null, null, null]);
  } finally {
    await generated?.dispose();
    await planes.stop(true);
    control.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a plane refusal reaches the tenant under the closed error vocabulary", async () => {
  const { service } = plane([{ ok: false, error: { code: "sql_error" } }]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       try { await env.DB.execute("NOT SQL"); }
       catch (error) { return Response.json({ name: error.name }); }
       return Response.json({ name: "no error" });
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({ name: "sql_error" });
  } finally {
    await generated.dispose();
  }
});

test("a code the plane is not allowed to return becomes backend_unavailable", async () => {
  const { service } = plane([{ ok: false, error: { code: "invalid_key" } }]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       try { await env.DB.execute("SELECT 1"); }
       catch (error) { return Response.json({ name: error.name }); }
       return Response.json({ name: "no error" });
     } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["fetch"],
      bindings: [{ kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" }],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({ name: "backend_unavailable" });
  } finally {
    await generated.dispose();
  }
});

test("only the declared handlers are exported, and fetch always is", async () => {
  const generated = await loadGenerated(
    `export default { async fetch() { return new Response("ok"); },
       async queue() {}, async scheduled() {} };`,
    { ...KV_ONLY, declaredHandlers: ["fetch", "queue"] },
  );
  try {
    expect(Object.keys(generated.worker).sort()).toEqual(["fetch", "queue"]);
  } finally {
    await generated.dispose();
  }
});

test("a version that declares no fetch handler answers an HTTP request with 404", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(`export default { async queue() {} };`, {
    ...KV_ONLY,
    declaredHandlers: ["queue"],
  });
  try {
    // Exactly what the managed wrapper answers, and for the same reason: the
    // event that arrived is not one this Version said it handles.
    expect(Object.keys(generated.worker).sort()).toEqual(["fetch", "queue"]);
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(response.status).toBe(404);
  } finally {
    await generated.dispose();
  }
});

test("keeps scalar readiness private while public and service requests reach the tenant once", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `let calls = 0;
export default { async fetch(request) {
  calls += 1;
  return new Response("tenant:" + calls + ":" + await request.text());
} };`,
  );
  const env = rawEnv(service);
  const magicHeaders = {
    [SELFHOST_WORKER_READINESS_HEADER]: SELFHOST_WORKER_READINESS_PROTOCOL,
  };
  try {
    const publicAnswer = await generated.worker.fetch(
      new Request(`https://worker.example${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: magicHeaders,
        body: "public",
      }),
      env,
      context,
    );
    expect(await publicAnswer.text()).toBe("tenant:1:public");

    // A service binding can choose the request URL and headers but cannot read
    // this Host's private raw binding. Spoofing the internal hostname is still
    // one ordinary tenant invocation.
    const serviceAnswer = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: magicHeaders,
        body: "service",
      }),
      env,
      context,
    );
    expect(await serviceAnswer.text()).toBe("tenant:2:service");

    const guessed = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: {
          ...magicHeaders,
          [INTERNAL_READINESS_CAPABILITY_HEADER]: "not-the-capability",
        },
      }),
      env,
      context,
    );
    expect(guessed.status).toBe(404);

    const answered = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: {
          ...magicHeaders,
          [INTERNAL_READINESS_CAPABILITY_HEADER]: INTERNAL_READINESS_CAPABILITY,
        },
      }),
      env,
      context,
    );
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      schema: SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
      publication: "sw1.v1",
      handlers: ["fetch"],
    });
  } finally {
    await generated.dispose();
  }
});

test("the readiness route reports a declared handler the tenant module lacks", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `export default { async fetch() { return new Response("ok"); } };`,
    { ...KV_ONLY, declaredHandlers: ["fetch", "scheduled"] },
  );
  try {
    const answered = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: authenticatedReadinessHeaders(),
      }),
      rawEnv(service),
      context,
    );
    expect(answered.status).toBe(500);
    // The publication is named even on the refusal, so a prober can tell this
    // answer from a stale configuration's, and the reason names the Version's
    // own declaration rather than anything the tenant's module said.
    expect(await answered.json()).toEqual({
      schema: SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
      publication: "sw1.v1",
      handlers: ["fetch", "scheduled"],
      failure: { reason: "declaration", message: "declared handler scheduled is not exported" },
    });
  } finally {
    await generated.dispose();
  }
});

/**
 * A tenant getter that throws while the Host validates its declared handler
 * and a module missing that handler are different defects. Import-time
 * failures are refused by the semantic inspector before this entrypoint is
 * published; this route reports failures that can only occur while consuming
 * the already-imported namespace.
 */
test("the readiness route distinguishes a validation failure from a missing export", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `const worker = Object.create(null);
Object.defineProperty(worker, "fetch", {
  get() { throw new TypeError('No such module "node:path".\\n  imported from "tenant.js"'); },
});
export default worker;`,
    KV_ONLY,
  );
  try {
    const answered = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: authenticatedReadinessHeaders(),
      }),
      rawEnv(service),
      context,
    );
    expect(answered.status).toBe(500);
    const body = (await answered.json()) as {
      readonly failure: {
        readonly reason: string;
        readonly name: string;
        readonly message: string;
      };
    };
    expect(body.failure.reason).toBe("module");
    expect(body.failure.name).toBe("TypeError");
    expect(body.failure.message).toContain("node:path");
    // Sanitized and bounded: no control characters, no unbounded tenant text.
    expect(body.failure.message.length).toBeLessThanOrEqual(400);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: proving none survive
    expect(body.failure.message).not.toMatch(/[\u0000-\u001f\u007f]/u);
  } finally {
    await generated.dispose();
  }
});

test("a callable own getter is evaluated once across readiness and requests", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `let getterCalls = 0;
let handlerCalls = 0;
const worker = Object.create(null);
Object.defineProperty(worker, "fetch", {
  configurable: true,
  get() {
    getterCalls += 1;
    return function () {
      handlerCalls += 1;
      return Response.json({ getterCalls, handlerCalls });
    };
  },
});
export default worker;`,
  );
  try {
    const readiness = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: authenticatedReadinessHeaders(),
      }),
      rawEnv(service),
      context,
    );
    expect(readiness.status).toBe(200);

    const first = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await first.json()).toEqual({ getterCalls: 1, handlerCalls: 1 });

    const second = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await second.json()).toEqual({ getterCalls: 1, handlerCalls: 2 });
  } finally {
    await generated.dispose();
  }
});

test("a captured getter handler keeps its original target after tenant mutation", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `let invocations = 0;
const worker = Object.create(null);
function captured() {
  invocations += 1;
  Object.defineProperty(this, "fetch", {
    configurable: true,
    value: () => new Response("replaced"),
  });
  return new Response(this === worker ? "original:" + invocations : "wrong-target");
}
Object.defineProperty(worker, "fetch", {
  configurable: true,
  get() { return captured; },
});
export default worker;`,
  );
  try {
    const first = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await first.text()).toBe("original:1");

    const second = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await second.text()).toBe("original:2");
  } finally {
    await generated.dispose();
  }
});

test("a noncallable own getter refuses the declared handler", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `const worker = Object.create(null);
Object.defineProperty(worker, "fetch", {
  get() { return 42; },
});
export default worker;`,
  );
  try {
    await expect(
      generated.worker.fetch(new Request("https://worker.example/"), rawEnv(service), context),
    ).rejects.toThrow("declared handler fetch is not a function");
  } finally {
    await generated.dispose();
  }
});

test("a throwing own getter refuses the publication as a module failure", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `const worker = Object.create(null);
Object.defineProperty(worker, "fetch", {
  get() { throw new Error("getter exploded"); },
});
export default worker;`,
  );
  try {
    const answered = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: authenticatedReadinessHeaders(),
      }),
      rawEnv(service),
      context,
    );
    expect(answered.status).toBe(500);
    expect(await answered.json()).toMatchObject({
      failure: { reason: "module", message: "getter exploded" },
    });
  } finally {
    await generated.dispose();
  }
});

test("inherited and class-prototype defaults remain refused", async () => {
  const { service } = plane([]);
  for (const source of [
    `const inherited = { fetch() {} };
export default Object.create(inherited);`,
    `class Worker { fetch() {} }
export default new Worker();`,
    `const worker = Object.create(null);
Object.defineProperty(worker, "fetch", {
  get() {
    Object.setPrototypeOf(worker, { changed: true });
    return () => {};
  },
});
export default worker;`,
  ]) {
    const generated = await loadGenerated(source);
    try {
      await expect(
        generated.worker.fetch(new Request("https://worker.example/"), rawEnv(service), context),
      ).rejects.toThrow("the default export is not a plain object");
    } finally {
      await generated.dispose();
    }
  }
});

test("the generated wrapper export is immutable", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `export default { fetch() { return new Response("original"); } };`,
  );
  try {
    expect(Object.isFrozen(generated.worker)).toBe(true);
    expect(Reflect.set(generated.worker, "fetch", () => new Response("replaced"))).toBe(false);
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.text()).toBe("original");
  } finally {
    await generated.dispose();
  }
});

test("a declared handler the tenant module does not export refuses the publication", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `export default { async fetch() { return new Response("ok"); } };`,
    { ...KV_ONLY, declaredHandlers: ["fetch", "scheduled"] },
  );
  try {
    await expect(
      generated.worker.fetch(new Request("https://worker.example/"), rawEnv(service), context),
    ).rejects.toThrow("declared handler scheduled is not exported");
  } finally {
    await generated.dispose();
  }
});

test("a module with no default export refuses the publication", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(`export const handler = {};`);
  try {
    await expect(
      generated.worker.fetch(new Request("https://worker.example/"), rawEnv(service), context),
    ).rejects.toThrow("the module has no default export");
  } finally {
    await generated.dispose();
  }
});

test("a handler outside the worker.runtime vocabulary is refused at generation", () => {
  expect(() =>
    selfhostWorkerEntrypointSource({
      ...KV_ONLY,
      declaredHandlers: ["email"] as never,
    }),
  ).toThrow("declaredHandlers is invalid");
});

test("a binding name reserved for this Host is refused at generation", () => {
  expect(() =>
    selfhostWorkerEntrypointSource({
      ...KV_ONLY,
      bindings: [
        ...KV_ONLY.bindings,
        { name: SELFHOST_WORKER_DATA_TOKEN_BINDING, type: "plain_text" },
      ],
    }),
  ).toThrow("bindings is invalid");
});

test("two bindings under one name are refused at generation", () => {
  expect(() =>
    selfhostWorkerEntrypointSource({
      ...KV_ONLY,
      bindings: [
        { kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "STORE" },
        { kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "STORE" },
      ],
    }),
  ).toThrow("bindings is invalid");
});

/**
 * A version with no facade still gets an entrypoint, because the entrypoint is
 * the load probe.
 *
 * It used to be refused here, on the reasoning that a wrapper exists to carry a
 * facade or to receive an event. That left the simplest kind of Worker — no
 * bindings, no events — published unwrapped and therefore never asked whether
 * its module loads: an unloadable one deployed, reported `Ready=True`, and
 * failed with a 500 on the first real request.
 */
test("a version with no facade still generates the entrypoint that probes it", () => {
  const source = selfhostWorkerEntrypointSource({
    originalMainModule: "index.js",
    publication: "sw1.v1",
    probeHostname: PROBE_HOSTNAME,
    declaredHandlers: ["fetch"],
    bindings: [{ name: "LANE", type: "plain_text" }],
  });
  expect(source).toContain('import * as TenantWorkerModule from "./index.js"');
  expect(source).toContain(`from "./${SELFHOST_WORKER_PRELUDE_MODULE}"`);
  expect(source).toContain(SELFHOST_WORKER_READINESS_PATH);
  expect(source).toContain('"LANE"');
});

test("event and non-event wrappers expose the same private env projection", () => {
  const alias = `export { projectEnv as ${SELFHOST_WORKER_PROJECT_ENV_EXPORT} };`;
  for (const input of [KV_ONLY, { ...KV_ONLY, events: true }]) {
    const source = selfhostWorkerEntrypointSource(input);
    expect(source).toContain(alias);
    expect(source.split(alias).length - 1).toBe(1);
    // The class loader consumes the ordinary factory; no second raw-env
    // constructor may diverge in binding shape or adapter behavior.
    expect(source.match(/function\s+\w*Env\(rawEnv\)/gu)).toEqual(["function projectEnv(rawEnv)"]);
  }
});

test("a tenant main may use the Host entrypoint's logical spelling", () => {
  const source = selfhostWorkerEntrypointSource({
    ...KV_ONLY,
    originalMainModule: SELFHOST_WORKER_ENTRYPOINT_MODULE,
  });
  expect(source).toContain(
    `import * as TenantWorkerModule from "./${SELFHOST_WORKER_ENTRYPOINT_MODULE}"`,
  );
});

test("a main module that escapes its own directory is refused at generation", () => {
  expect(() =>
    selfhostWorkerEntrypointSource({ ...KV_ONLY, originalMainModule: "../secrets.js" }),
  ).toThrow("originalMainModule is invalid");
});

/**
 * The object facade is the one that streams, so it has a caller of its own:
 * the operation travels base64url in a header and the bytes travel as the body.
 * What is worth proving from the tenant's side is that the surface is the exact
 * one the managed wrapper projects — nine methods, the same option names, the
 * same closed error names — and that the wire underneath is the one this Host's
 * own plane parses.
 */
function objectPlane(
  answers: readonly (
    | Record<string, unknown>
    | Uint8Array
    | { readonly bytes: Uint8Array; readonly metadata: Record<string, unknown> }
  )[],
): {
  readonly service: { fetch(url: string, init: RequestInit): Promise<Response> };
  readonly calls: { url: string; document: Record<string, unknown>; body: string }[];
} {
  const calls: { url: string; document: Record<string, unknown>; body: string }[] = [];
  let index = 0;
  return {
    calls,
    service: {
      async fetch(url, init) {
        const headers = init.headers as Record<string, string>;
        const raw = headers[SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER] as string;
        const document = JSON.parse(
          new TextDecoder().decode(
            Buffer.from(raw.replaceAll("-", "+").replaceAll("_", "/"), "base64"),
          ),
        ) as Record<string, unknown>;
        const payload =
          document.bodyFormat === SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT
            ? decodeSelfhostObjectBodyFrames(init.body as ReadableStream<Uint8Array>)
            : init.body;
        const body = payload === undefined ? "" : await new Response(payload).text();
        calls.push({ url, document, body });
        const answer = answers[index] ?? { ok: false, error: { code: "backend_unavailable" } };
        index += 1;
        const streamed =
          answer instanceof Uint8Array
            ? {
                bytes: answer,
                metadata: { etag: "etag-1", size: answer.byteLength, partial: false },
              }
            : (answer as { bytes?: Uint8Array; metadata?: Record<string, unknown> }).bytes
              ? (answer as { bytes: Uint8Array; metadata: Record<string, unknown> })
              : null;
        if (streamed) {
          const metadata = Buffer.from(new TextEncoder().encode(JSON.stringify(streamed.metadata)))
            .toString("base64")
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/u, "");
          return new Response(streamed.bytes as unknown as BodyInit, {
            status: 200,
            headers: {
              "content-type": SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
              [SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER]: metadata,
            },
          });
        }
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}

const OBJECTS_ONLY: SelfhostWorkerEntrypointSourceInput = {
  originalMainModule: "index.js",
  publication: "sw1.v1",
  probeHostname: PROBE_HOSTNAME,
  declaredHandlers: ["fetch"],
  bindings: [{ kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND, publicName: "MEDIA" }],
};

const FORWARD_OBJECT_INPUT: SelfhostWorkerEntrypointSourceInput = {
  ...OBJECTS_ONLY,
  bindings: [
    { kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND, publicName: "OLD" },
    { kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND, publicName: "NEW" },
  ],
};
const FORWARD_OBJECT_FORMS: readonly ObjectBucketBindingForm[] = [
  { publicName: "OLD", resourceUid: "old-bucket", formUrl: OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL },
  { publicName: "NEW", resourceUid: "new-bucket", formUrl: OBJECT_BUCKET_EOF_COUNTED_FORM_URL },
];

test("forward ObjectBucket renderer requires exact complete named Form projections", () => {
  const first = FORWARD_OBJECT_FORMS[0];
  if (!first) throw new Error("missing forward Form fixture");
  const incomplete: readonly (readonly ObjectBucketBindingForm[])[] = [
    [],
    [first],
    [
      ...FORWARD_OBJECT_FORMS,
      {
        publicName: "EXTRA",
        resourceUid: "extra-bucket",
        formUrl: OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
      },
    ],
  ];
  for (const forms of incomplete)
    expect(() =>
      selfhostWorkerForwardObjectBucketEntrypointSource({
        source: FORWARD_OBJECT_INPUT,
        objectBucketBindings: forms,
      }),
    ).toThrow(TypeError);
  const before = selfhostWorkerEntrypointSource(FORWARD_OBJECT_INPUT);
  const forward = selfhostWorkerForwardObjectBucketEntrypointSource({
    source: FORWARD_OBJECT_INPUT,
    objectBucketBindings: FORWARD_OBJECT_FORMS,
  });
  expect(forward).toContain(OBJECT_BUCKET_EOF_COUNTED_FORM_URL);
  expect(forward).toContain("old-bucket");
  expect(before).not.toContain("FORWARD_OBJECT_FORMS");
  expect(selfhostWorkerEntrypointSource(FORWARD_OBJECT_INPUT)).toBe(before);
});

test("forward ObjectBucket renderer selects strict old streams and counted new streams together", async () => {
  const { service, calls } = objectPlane([
    { ok: true, value: { etag: "new-put", size: 3 } },
    { ok: true, value: { etag: "old-put", size: 3 } },
    { ok: true, value: { etag: "new-part", partNumber: 1, size: 3 } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
      let oldPulls = 0;
      const bytes = () => new ReadableStream({pull(c){c.enqueue(new Uint8Array([97,98,99]));c.close()}}, {highWaterMark:0});
      const result = {};
      try { await env.OLD.put("key", new ReadableStream({pull(c){oldPulls++;c.close()}}, {highWaterMark:0})); }
      catch(e){result.oldError=e.name}
      try { await env.OLD.uploadPart("key","upload",1,bytes()); }
      catch(e){result.oldPartError=e.name}
      result.oldPulls=oldPulls;
      result.newPut=await env.NEW.put("key",bytes());
      result.oldPut=await env.OLD.put("key",bytes(),{contentLength:3});
      result.newPart=await env.NEW.uploadPart("key","upload",1,bytes());
      return Response.json(result);
    } }`,
    FORWARD_OBJECT_INPUT,
    FORWARD_OBJECT_FORMS,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://example.com"),
      rawEnv(service),
      {},
    );
    expect(await response.json()).toEqual({
      oldError: "invalid_body",
      oldPartError: "invalid_body",
      oldPulls: 0,
      newPut: { etag: "new-put", size: 3 },
      oldPut: { etag: "old-put", size: 3 },
      newPart: { etag: "new-part", partNumber: 1 },
    });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.body)).toEqual(["abc", "abc", "abc"]);
    expect(calls.map((call) => Object.hasOwn(call.document, "contentLength"))).toEqual([
      false,
      true,
      false,
    ]);
    for (const call of calls)
      expect(call.document.bodyFormat).toBe(SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT);
  } finally {
    await generated.dispose();
  }
});

test("forward ObjectBucket renderer distinguishes own undefined, zero and malformed bodies before consumption", async () => {
  const { service, calls } = objectPlane([
    { ok: true, value: { etag: "empty", size: 0 } },
    { ok: true, value: { etag: "unknown-empty", size: 0 } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
      const result = {}; let pulls=0;
      const untouched=()=>new ReadableStream({pull(c){pulls++;c.close()}},{highWaterMark:0});
      const record=async(name,run)=>{try{result[name]=await run()}catch(e){result[name]=e.name}};
      await record("ownUndefined",()=>env.NEW.put("key",untouched(),{contentLength:undefined}));
      await record("ownNull",()=>env.NEW.put("key",untouched(),{contentLength:null}));
      await record("partUndefined",()=>env.NEW.uploadPart("key","upload",1,untouched(),{contentLength:undefined}));
      await record("negative",()=>env.NEW.put("key",untouched(),{contentLength:-1}));
      await record("tooLarge",()=>env.NEW.put("key",untouched(),{contentLength:314572801}));
      await record("unknownOption",()=>env.NEW.put("key",untouched(),{profile:"eof-counted"}));
      result.untouchedPulls=pulls;
      let zeroEof=false;
      result.zero=await env.NEW.put("key",new ReadableStream({pull(c){zeroEof=true;c.close()}},{highWaterMark:0}),{contentLength:0});
      result.zeroEof=zeroEof;
      result.unknownEmpty=await env.NEW.put("key",new ReadableStream({pull(c){c.close()}},{highWaterMark:0}));
      return Response.json(result);
    } }`,
    FORWARD_OBJECT_INPUT,
    FORWARD_OBJECT_FORMS,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://example.com"),
      rawEnv(service),
      {},
    );
    expect(await response.json()).toEqual({
      ownUndefined: "TypeError",
      ownNull: "TypeError",
      partUndefined: "TypeError",
      negative: "invalid_body",
      tooLarge: "value_too_large",
      unknownOption: "TypeError",
      untouchedPulls: 0,
      zero: { etag: "empty", size: 0 },
      zeroEof: true,
      unknownEmpty: { etag: "unknown-empty", size: 0 },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.document.contentLength).toBe(0);
    expect(Object.hasOwn(calls[1]?.document ?? {}, "contentLength")).toBe(false);
    expect(calls.map((call) => call.body)).toEqual(["", ""]);
  } finally {
    await generated.dispose();
  }
});

test("forward ObjectBucket renderer owns ArrayBuffer and options before the first asynchronous call", async () => {
  const { service, calls } = objectPlane([{ ok: true, value: { etag: "original", size: 3 } }]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
      const bytes=new Uint8Array([97,98,99]);
      const options={contentLength:3,contentType:"text/original",ifMatch:"original-etag"};
      const pending=env.NEW.put("original-key",bytes.buffer,options);
      bytes.fill(120);options.contentLength=0;options.contentType="text/replacement";
      options.ifMatch="replacement-etag";
      return Response.json(await pending);
    } }`,
    FORWARD_OBJECT_INPUT,
    FORWARD_OBJECT_FORMS,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://example.com"),
      rawEnv(service),
      {},
    );
    expect(await response.json()).toEqual({ etag: "original", size: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe("abc");
    expect(calls[0]?.document).toMatchObject({
      key: "original-key",
      contentLength: 3,
      contentType: "text/original",
      ifMatch: "original-etag",
    });
  } finally {
    await generated.dispose();
  }
});

test("forward ObjectBucket renderer rejects completion JS shape and order before transport", async () => {
  const { service, calls } = objectPlane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
      const results={};
      const cases=()=>[
        [{partNumber:1,etag:"a"},{partNumber:1,etag:"b"}],
        [{partNumber:2,etag:"b"},{partNumber:1,etag:"a"}],
        null, [], new Array(10001), new Array(1),
        [null], [{partNumber:1}], [{etag:"a"}],
        [{partNumber:"1",etag:"a"}], [{partNumber:1,etag:1}],
        [{partNumber:1,etag:"a",extra:true}],
      ];
      for(const name of ["OLD","NEW"]){
        results[name]=[];
        for(const parts of cases()){
          try{await env[name].completeMultipartUpload("key","upload",parts);results[name].push("unexpected success")}
          catch(e){results[name].push(e.name)}
        }
      }
      return Response.json(results);
    } }`,
    FORWARD_OBJECT_INPUT,
    FORWARD_OBJECT_FORMS,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://example.com"),
      rawEnv(service),
      {},
    );
    expect(await response.json()).toEqual({
      OLD: Array(12).fill("TypeError"),
      NEW: Array(12).fill("TypeError"),
    });
    expect(calls).toHaveLength(0);
  } finally {
    await generated.dispose();
  }
});

test("forward ObjectBucket renderer retains invalid_part for well-shaped stored part mismatches", async () => {
  const { service, calls } = objectPlane([
    { ok: true, value: { uploadId: "owned-upload" } },
    { ok: true, value: { etag: "stored-part", partNumber: 1, size: 1 } },
    { ok: false, error: { code: "invalid_part" } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
      const upload=await env.NEW.createMultipartUpload("key");
      await env.NEW.uploadPart("key",upload.uploadId,1,"x");
      const result={};
      try{await env.NEW.completeMultipartUpload("key",upload.uploadId,[{partNumber:1,etag:"wrong-etag"}])}
      catch(e){result.knownEtagMismatch=e.name}
      try{await env.NEW.completeMultipartUpload("key","untracked-upload",[{partNumber:1,etag:"not-stored"}])}
      catch(e){result.backendPartMismatch=e.name}
      return Response.json(result);
    } }`,
    FORWARD_OBJECT_INPUT,
    FORWARD_OBJECT_FORMS,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://example.com"),
      rawEnv(service),
      {},
    );
    expect(await response.json()).toEqual({
      knownEtagMismatch: "invalid_part",
      backendPartMismatch: "invalid_part",
    });
    expect(calls.map((call) => call.document.op)).toEqual([
      "createMultipartUpload",
      "uploadPart",
      "completeMultipartUpload",
    ]);
    expect(calls[2]?.document.uploadId).toBe("untracked-upload");
  } finally {
    await generated.dispose();
  }
});

test("forward ObjectBucket renderer correction leaves legacy completion behavior intact", async () => {
  const { service, calls } = objectPlane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
      const result=[];
      for(const parts of [
        [{partNumber:1,etag:"a"},{partNumber:1,etag:"b"}],
        [{partNumber:2,etag:"b"},{partNumber:1,etag:"a"}],
      ]){
        try{await env.MEDIA.completeMultipartUpload("key","upload",parts);result.push("unexpected success")}
        catch(e){result.push(e.name)}
      }
      return Response.json(result);
    } }`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://example.com"),
      rawEnv(service),
      {},
    );
    expect(await response.json()).toEqual(["invalid_part", "invalid_part"]);
    expect(calls).toHaveLength(0);
  } finally {
    await generated.dispose();
  }
});

test("forward ObjectBucket renderer preserves validated nonbyte and late-producer failures", async () => {
  const { service, calls } = objectPlane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
      const result={};
      const record=async(name,stream,options)=>{try{await env.NEW.put("key",stream,options)}catch(e){result[name]=e.name}};
      await record("nonbyte",new ReadableStream({start(c){c.enqueue(new Uint8Array([97]));c.enqueue("not bytes");c.close()}}));
      let count=0;
      await record("producer",new ReadableStream({pull(c){if(count++===0)c.enqueue(new Uint8Array([97]));else throw Object.assign(new Error("producer-private-diagnostic"),{name:"invalid_body"})}}, {highWaterMark:0}));
      await record("count",new ReadableStream({pull(c){c.enqueue(new Uint8Array([97]));c.close()}},{highWaterMark:0}),{contentLength:2});
      return Response.json(result);
    } }`,
    FORWARD_OBJECT_INPUT,
    FORWARD_OBJECT_FORMS,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://example.com"),
      rawEnv(service),
      {},
    );
    expect(await response.json()).toEqual({
      nonbyte: "invalid_body",
      producer: "backend_unavailable",
      count: "invalid_body",
    });
    // No source failure produces a complete decoded request in this fixture.
    expect(calls).toHaveLength(0);
  } finally {
    await generated.dispose();
  }
});

test("ObjectBucket byte guards retain pre-tenant reader and Uint8Array brand captures", async () => {
  // The production data plane is in another authority/realm. Keep this local
  // backend reader independent of the deliberately poisoned tenant prototypes.
  const getReader = ReadableStream.prototype.getReader;
  const read = ReadableStreamDefaultReader.prototype.read;
  const release = ReadableStreamDefaultReader.prototype.releaseLock;
  const calls: { key: unknown; body: number[] }[] = [];
  const service = {
    async fetch(_url: string, init: RequestInit) {
      const headers = init.headers as Record<string, string>;
      const document = JSON.parse(
        Buffer.from(headers[SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER] ?? "", "base64url").toString(
          "utf8",
        ),
      ) as Record<string, unknown>;
      const reader = Reflect.apply(
        getReader,
        init.body,
        [],
      ) as ReadableStreamDefaultReader<Uint8Array>;
      const body: number[] = [];
      try {
        for (;;) {
          const next = await Reflect.apply(read, reader, []);
          if (next.done) break;
          body.push(...next.value);
        }
      } finally {
        Reflect.apply(release, reader, []);
      }
      calls.push({ key: document.key, body });
      return Response.json({ ok: true, value: { etag: "good", size: 3 } });
    },
  };
  const generated = await loadGenerated(
    `const methods = {
       getReader: ReadableStream.prototype.getReader,
       read: ReadableStreamDefaultReader.prototype.read,
       cancel: ReadableStreamDefaultReader.prototype.cancel,
       releaseLock: ReadableStreamDefaultReader.prototype.releaseLock,
       hasInstance: Object.getOwnPropertyDescriptor(Uint8Array, Symbol.hasInstance),
     };
     const poison = () => { throw new Error("tenant reader override must not run"); };
     ReadableStream.prototype.getReader = poison;
     ReadableStreamDefaultReader.prototype.read = poison;
     ReadableStreamDefaultReader.prototype.cancel = poison;
     ReadableStreamDefaultReader.prototype.releaseLock = poison;
     Object.defineProperty(Uint8Array, Symbol.hasInstance, { configurable: true, value: () => true });
     export default { async fetch(request, env) {
       try {
         let sent = false;
         const good = new ReadableStream({ pull(controller) {
           if (sent) controller.close();
           else { sent = true; controller.enqueue(new Uint8Array([97, 98, 99])); }
         } }, { highWaterMark: 0 });
         const written = await env.MEDIA.put("good", good);
         let cancelled = false;
         const bad = new ReadableStream({
           pull(controller) { controller.enqueue("not bytes"); },
           cancel() { cancelled = true; },
         }, { highWaterMark: 0 });
         let error;
         try { await env.MEDIA.put("bad", bad); }
         catch (caught) { error = { name: caught.name, message: caught.message }; }
         return Response.json({ written, error, cancelled, goodLocked: good.locked, badLocked: bad.locked });
       } finally {
         ReadableStream.prototype.getReader = methods.getReader;
         ReadableStreamDefaultReader.prototype.read = methods.read;
         ReadableStreamDefaultReader.prototype.cancel = methods.cancel;
         ReadableStreamDefaultReader.prototype.releaseLock = methods.releaseLock;
         if (methods.hasInstance) Object.defineProperty(Uint8Array, Symbol.hasInstance, methods.hasInstance);
         else delete Uint8Array[Symbol.hasInstance];
       }
     } };`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      written: { etag: "good", size: 3 },
      error: { name: "invalid_body", message: "invalid_body" },
      cancelled: true,
      goodLocked: false,
      badLocked: false,
    });
    expect(calls).toEqual([{ key: "good", body: [0, 0, 0, 3, 97, 98, 99, 255, 255, 255, 255] }]);
  } finally {
    await generated.dispose();
  }
});

test("generated ObjectBucket guards enforce actual byte ceilings before a discard backend ACK", async () => {
  // Exercise the real generated facade and production stage consumer at their
  // actual ceilings without creating 300 MiB/5 GiB files or buffering a body.
  let acknowledged = 0;
  const service = {
    async fetch(_url: string, init: RequestInit) {
      const headers = init.headers as Record<string, string>;
      const document = JSON.parse(
        Buffer.from(headers[SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER] ?? "", "base64url").toString(
          "utf8",
        ),
      ) as { op: string; contentLength?: number; partNumber?: number; bodyFormat?: string };
      if (document.op === "createMultipartUpload") {
        return Response.json({ ok: true, value: { uploadId: "discard-upload" } });
      }
      expect(Object.hasOwn(document, "contentLength")).toBe(false);
      const put = document.op === "put";
      try {
        const size = await consumeSelfhostObjectBody(
          document.bodyFormat === SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT
            ? decodeSelfhostObjectBodyFrames(init.body as ReadableStream<Uint8Array>)
            : (init.body as ReadableStream<Uint8Array>),
          {
            maximum: put ? 314_572_800 : 5_368_709_120,
            overflow: put ? "value_too_large" : "invalid_body",
          },
          async () => {},
        );
        acknowledged += 1;
        return Response.json({
          ok: true,
          value: put
            ? { etag: "discarded-put", size }
            : { etag: "discarded-part", partNumber: document.partNumber, size },
        });
      } catch (error) {
        return Response.json({
          ok: false,
          error: {
            code: error instanceof SelfhostObjectError ? error.code : "backend_unavailable",
          },
        });
      }
    },
  };
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const params = new URL(request.url).searchParams;
       const put = params.get("op") === "put";
       const maximum = put ? 314572800 : 5368709120;
       const total = maximum + (params.get("overflow") === "yes" ? 1 : 0);
       const block = new Uint8Array(65536);
       let emitted = 0, cancelled = false;
       const body = new ReadableStream({
         pull(controller) {
           if (emitted === total) { controller.close(); return; }
           const size = Math.min(block.byteLength, total - emitted);
           emitted += size;
           controller.enqueue(block.subarray(0, size));
         },
         cancel() { cancelled = true; },
       }, { highWaterMark: 0 });
       let receipt, error;
       try {
         if (put) receipt = await env.MEDIA.put("limit", body);
         else {
           const upload = await env.MEDIA.createMultipartUpload("limit");
           receipt = await env.MEDIA.uploadPart("limit", upload.uploadId, 1, body);
         }
       } catch (caught) { error = { name: caught.name, message: caught.message }; }
       return Response.json({ receipt, error, emitted, cancelled, locked: body.locked });
     } };`,
    OBJECTS_ONLY,
  );
  try {
    for (const op of ["put", "part"] as const) {
      const maximum = op === "put" ? 314_572_800 : 5_368_709_120;
      for (const overflow of [false, true]) {
        const before = acknowledged;
        const response = await generated.worker.fetch(
          new Request(`https://worker.example/?op=${op}&overflow=${overflow ? "yes" : "no"}`),
          rawEnv(service),
          context,
        );
        if (overflow) {
          const code = op === "put" ? "value_too_large" : "invalid_body";
          expect(await response.json()).toEqual({
            error: { name: code, message: code },
            emitted: maximum + 1,
            cancelled: true,
            locked: false,
          });
          expect(acknowledged).toBe(before);
        } else {
          expect(await response.json()).toEqual({
            receipt:
              op === "put"
                ? { etag: "discarded-put", size: maximum }
                : { etag: "discarded-part", partNumber: 1 },
            emitted: maximum,
            cancelled: false,
            locked: false,
          });
          expect(acknowledged).toBe(before + 1);
        }
      }
    }
  } finally {
    await generated.dispose();
  }
});

test("generic ObjectBucket unknown-length HTTP streams reach the filesystem through the generated data service", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-selfhost-object-chain-"));
  const control = new Database(":memory:");
  migrateSqlite(control);
  const planes = serveSelfhostDataPlanes({
    sql: createSqliteSql(control),
    grant: async (script, versionId) =>
      script === "worker" && versionId === "v1"
        ? {
            secret: "selfhost-object-chain-secret-0000",
            kv: {},
            sql: {},
            queue: {},
            objects: { MEDIA: `tsb-${"a".repeat(40)}` },
          }
        : null,
    databasePath: (name) => join(root, `${name}.sqlite`),
    objectRoot: join(root, "objects"),
  });
  let generated: Awaited<ReturnType<typeof loadGenerated>> | undefined;
  let observer:
    | { readonly port: number | undefined; stop(closeActive?: boolean): unknown }
    | undefined;
  const receivedWrites: {
    document: Record<string, unknown>;
    contentLength: string | null;
    transferEncoding: string | null;
  }[] = [];
  try {
    // Observe real incoming HTTP framing, then forward with the same body and
    // disconnect signal to the product-owned loopback listener. Never record auth.
    observer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const encoded = request.headers.get(SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER);
        if (!encoded) return new Response(null, { status: 400 });
        const document = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
          string,
          unknown
        >;
        if (document.op === "put" || document.op === "uploadPart") {
          receivedWrites.push({
            document,
            contentLength: request.headers.get("content-length"),
            transferEncoding: request.headers.get("transfer-encoding"),
          });
        }
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("transfer-encoding");
        return await fetch(`http://127.0.0.1:${planes.port}${new URL(request.url).pathname}`, {
          method: request.method,
          headers,
          signal: request.signal,
          ...(request.body ? { body: request.body, duplex: "half" as const } : {}),
        });
      },
    });
    const observerPort = observer.port;
    if (observerPort === undefined) throw new Error("loopback HTTP observer did not bind a port");
    await Bun.write(join(root, SELFHOST_WORKER_DATA_SERVICE_MODULE), selfhostDataServiceSource());
    const dataService = (await import(
      `${pathToFileURL(join(root, SELFHOST_WORKER_DATA_SERVICE_MODULE)).href}?test=${crypto.randomUUID()}`
    )) as {
      readonly default: {
        fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
      };
    };
    const dataServiceEnv = {
      [SELFHOST_WORKER_DATA_TOKEN_BINDING]: "worker.v1.selfhost-object-chain-secret-0000",
      [SELFHOST_WORKER_DATA_PLANE_BINDING]: {
        async fetch(url: string, init: RequestInit): Promise<Response> {
          return await fetch(`http://127.0.0.1:${observerPort}${new URL(url).pathname}`, init);
        },
      },
    };
    const service = {
      async fetch(url: string, init: RequestInit): Promise<Response> {
        return await dataService.default.fetch(new Request(url, init), dataServiceEnv);
      },
    };
    generated = await loadGenerated(
      `function chunks(values) {
         let index = 0;
         return new ReadableStream({ async pull(controller) {
           await new Promise(resolve => setTimeout(resolve, 1));
           if (index === values.length) controller.close();
           else controller.enqueue(new Uint8Array(values[index++]));
         } }, { highWaterMark: 0 });
       }
       async function failure(operation) {
         try { await operation(); return null; }
         catch (error) { return { name: error.name, message: error.message }; }
       }
       function failedSource(malformed) {
         let sent = 0;
         return new ReadableStream({ pull(controller) {
           if (sent++ === 0) controller.enqueue(new Uint8Array([65]));
           else if (malformed && sent === 2) controller.enqueue("not bytes");
           else if (malformed) controller.close();
           else controller.error(new Error("private producer diagnostic"));
         } }, { highWaterMark: 0 });
       }
       export default { async fetch(request, env) {
         const hello = await env.MEDIA.put("hello", chunks([[], [104, 101], [], [108, 108, 111]]));
         const empty = await env.MEDIA.put("empty", chunks([[], []]));
         await env.MEDIA.put("previous", "stable");
         const exact = await env.MEDIA.put("exact", chunks([[], [65], [66], []]), { contentLength: 2 });
         const errors = [];
         errors.push(await failure(() => env.MEDIA.put("previous", chunks([[65]]), { contentLength: 2 })));
         errors.push(await failure(() => env.MEDIA.put("previous", chunks([[65], [66]]), { contentLength: 1 })));
         errors.push(await failure(() => env.MEDIA.put("previous", failedSource(true))));
         errors.push(await failure(() => env.MEDIA.put("previous", failedSource(false))));
         const upload = await env.MEDIA.createMultipartUpload("small-part");
         const part = await env.MEDIA.uploadPart("small-part", upload.uploadId, 1, chunks([[], [104, 101], [108, 108, 111]]));
         errors.push(await failure(() => env.MEDIA.uploadPart("small-part", upload.uploadId, 1, chunks([[65]]), { contentLength: 2 })));
         const done = await env.MEDIA.completeMultipartUpload("small-part", upload.uploadId, [part]);
         const zeroUpload = await env.MEDIA.createMultipartUpload("zero-part");
         const zeroPart = await env.MEDIA.uploadPart("zero-part", zeroUpload.uploadId, 1, chunks([[], []]));
         const zeroDone = await env.MEDIA.completeMultipartUpload("zero-part", zeroUpload.uploadId, [zeroPart]);
         const previous = await env.MEDIA.get("previous");
         const small = await env.MEDIA.get("small-part");
         const zero = await env.MEDIA.get("zero-part");
         return Response.json({ hello, empty, exact, part, done, zeroPart, zeroDone, errors,
           previous: await new Response(previous.body).text(),
           small: await new Response(small.body).text(), zero: await new Response(zero.body).text() });
       } };`,
      OBJECTS_ONLY,
    );
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(response.status).toBe(200);
    const helloEtag = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const emptyEtag = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(await response.json()).toEqual({
      hello: { etag: helloEtag, size: 5 },
      empty: { etag: emptyEtag, size: 0 },
      exact: {
        etag: "38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
        size: 2,
      },
      part: { etag: helloEtag, partNumber: 1 },
      done: { etag: expect.stringMatching(/^[0-9a-f]{64}-1$/u), size: 5 },
      zeroPart: { etag: emptyEtag, partNumber: 1 },
      zeroDone: { etag: expect.stringMatching(/^[0-9a-f]{64}-1$/u), size: 0 },
      errors: [
        { name: "invalid_body", message: "invalid_body" },
        { name: "invalid_body", message: "invalid_body" },
        { name: "invalid_body", message: "invalid_body" },
        { name: "backend_unavailable", message: "backend_unavailable" },
        { name: "invalid_body", message: "invalid_body" },
      ],
      previous: "stable",
      small: "hello",
      zero: "",
    });
    const unknownWrites = receivedWrites.filter(
      ({ document }) => !Object.hasOwn(document, "contentLength") && document.key !== "previous",
    );
    expect(unknownWrites.map(({ document }) => [document.op, document.key])).toEqual([
      ["put", "hello"],
      ["put", "empty"],
      ["uploadPart", "small-part"],
      ["uploadPart", "zero-part"],
    ]);
    for (const write of unknownWrites) {
      expect(write.contentLength).toBeNull();
      expect(write.transferEncoding).toBe("chunked");
    }
  } finally {
    await generated?.dispose();
    await observer?.stop(true);
    await planes.stop(true);
    control.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled event reports exact handler settlement without leaking thrown details", async () => {
  const generated = await loadGenerated(
    `export default { async scheduled(event, env, ctx) {
      if (event.cron === "0 * * * *") throw new Error("private tenant secret");
      ctx.waitUntil(Promise.reject(new Error("background secret")));
    } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["scheduled"],
      bindings: [],
      events: true,
    },
  );
  try {
    const eventEntrypoint = generated.eventEntrypoint;
    expect(eventEntrypoint).toBeDefined();
    const invoke = async (cron: string) =>
      await eventEntrypoint?.fetch(
        new Request(`http://takoserver-selfhost-events.invalid${SELFHOST_WORKER_EVENT_PATH}`, {
          method: "POST",
          headers: {
            "content-type": SELFHOST_WORKER_EVENT_CONTENT_TYPE,
            [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_WORKER_EVENT_PROTOCOL,
          },
          body: JSON.stringify(
            selfhostScheduleEvent({
              script: "worker-001",
              publication: "v2-selected",
              cron,
              scheduledTime: 1_700_000_000_000,
            }),
          ),
        }),
        {},
        {
          waitUntil(promise: Promise<unknown>) {
            void promise.catch(() => undefined);
          },
        },
      );
    const rejected = await invoke("0 * * * *");
    expect(rejected?.status).toBe(500);
    expect(await rejected?.json()).toEqual({
      protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
      kind: "schedule",
      outcome: "rejected",
    });
    const resolved = await invoke("1 * * * *");
    expect(resolved?.status).toBe(200);
    expect(await resolved?.json()).toEqual({
      protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
      kind: "schedule",
      outcome: "ack",
    });
  } finally {
    await generated.dispose();
  }
});

test("scheduled waitUntil registration refusal is unknown even when the handler catches context_expired", async () => {
  const generated = await loadGenerated(
    `export default { async scheduled(event, env, ctx) {
      try { ctx.waitUntil(Promise.resolve()); }
      catch (error) {
        if (error.name !== "context_expired") throw error;
      }
    } };`,
    {
      originalMainModule: "index.js",
      publication: "sw1.v1",
      probeHostname: PROBE_HOSTNAME,
      declaredHandlers: ["scheduled"],
      bindings: [],
      events: true,
    },
  );
  try {
    const response = await generated.eventEntrypoint?.fetch(
      new Request(`http://takoserver-selfhost-events.invalid${SELFHOST_WORKER_EVENT_PATH}`, {
        method: "POST",
        headers: {
          "content-type": SELFHOST_WORKER_EVENT_CONTENT_TYPE,
          [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_WORKER_EVENT_PROTOCOL,
        },
        body: JSON.stringify(
          selfhostScheduleEvent({
            script: "worker-001",
            publication: "v2-selected",
            cron: "0 * * * *",
            scheduledTime: 1_700_000_000_000,
          }),
        ),
      }),
      {},
      {
        waitUntil() {
          throw new Error("private native context detail");
        },
      },
    );
    expect(response?.status).toBe(500);
    expect(await response?.text()).toBe("");
  } finally {
    await generated.dispose();
  }
});

test("the edge.objects facade offers exactly the nine methods the Binding fixes", async () => {
  const { service } = objectPlane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       return Response.json(Object.keys(env.MEDIA).sort());
     } };`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual([
      "abortMultipartUpload",
      "completeMultipartUpload",
      "createMultipartUpload",
      "delete",
      "get",
      "head",
      "list",
      "put",
      "uploadPart",
    ]);
  } finally {
    await generated.dispose();
  }
});

test("a put sends the bytes as the body and the operation as one header", async () => {
  const { service, calls } = objectPlane([
    { ok: true, value: { etag: "etag-1", size: 5 } },
    new TextEncoder().encode("bytes"),
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const written = await env.MEDIA.put("poster.png", "bytes", { contentType: "image/png" });
       const got = await env.MEDIA.get("poster.png");
       return Response.json({
         written,
         etag: got.etag,
         partial: got.partial,
         body: await new Response(got.body).text(),
       });
     } };`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      written: { etag: "etag-1", size: 5 },
      etag: "etag-1",
      partial: false,
      body: "bytes",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toEndWith(SELFHOST_DATA_PLANE_OBJECTS_PATH);
    expect(calls[0]?.document).toEqual({
      protocol: SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
      binding: "MEDIA",
      op: "put",
      key: "poster.png",
      contentLength: 5,
      contentType: "image/png",
    });
    // The bytes are the body, not a base64 field of the document.
    expect(calls[0]?.body).toBe("bytes");
    expect(calls[1]?.document).toEqual({
      protocol: SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
      binding: "MEDIA",
      op: "get",
      key: "poster.png",
    });
  } finally {
    await generated.dispose();
  }
});

test("the facade holds the exact edge.objects ceilings and error vocabulary", async () => {
  const { service } = objectPlane([
    { ok: false, error: { code: "precondition_failed" } },
    { ok: true, value: { found: false } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const attempts = {};
       const record = async (name, run) => {
         try { attempts[name] = await run(); }
         catch (error) { attempts[name] = error.name; }
       };
       await record("longKey", () => env.MEDIA.head("k".repeat(980)));
       // A stream declares its length rather than carrying it, so this is the
       // one shape where a body can be too large without being wrong.
       const empty = () => new ReadableStream({ start(controller) { controller.close(); } });
       await record("hugePut", () => env.MEDIA.put("k", empty(), { contentLength: 314572801 }));
       await record("wrongPutLength", () => env.MEDIA.put("k", "x", { contentLength: 314572801 }));
       await record("wrongLength", () => env.MEDIA.put("k", "abc", { contentLength: 4 }));
       await record("badOption", () => env.MEDIA.put("k", "x", { nope: 1 }));
       await record("bothConditions", () =>
         env.MEDIA.put("k", "x", { ifMatch: "a", ifNoneMatch: "*" }));
       await record("badPartNumber", () => env.MEDIA.uploadPart("k", "u", 0, "x"));
       await record("unorderedParts", () =>
         env.MEDIA.completeMultipartUpload("k", "u", [
           { etag: "b", partNumber: 2 },
           { etag: "a", partNumber: 1 },
         ]));
       await record("refused", () => env.MEDIA.put("k", "x", { ifNoneMatch: "*" }));
       await record("absent", () => env.MEDIA.head("gone"));
       return Response.json(attempts);
     } };`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      longKey: "invalid_key",
      hugePut: "value_too_large",
      wrongPutLength: "invalid_body",
      wrongLength: "invalid_body",
      badOption: "TypeError",
      bothConditions: "TypeError",
      badPartNumber: "TypeError",
      unorderedParts: "invalid_part",
      refused: "precondition_failed",
      absent: null,
    });
  } finally {
    await generated.dispose();
  }
});

/**
 * "invalid arguments" on a five-argument facade sends the caller to read the
 * whole call. A `Uint8Array` is the shape a caller reaches for first, and R2
 * accepts one; this Binding declares three body shapes (ADR 0005) and does not,
 * so the refusal has to say which argument and which three.
 */
test("a body the Binding does not accept names the argument and what it accepts", async () => {
  const { service } = objectPlane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const said = {};
       const record = async (name, run) => {
         try { await run(); said[name] = null; }
         catch (error) { said[name] = error.message; }
       };
       await record("view", () => env.MEDIA.put("k", new Uint8Array([1, 2, 3])));
       await record("number", () => env.MEDIA.put("k", 7));
       return Response.json(said);
     } };`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    const said = (await response.json()) as Record<string, string>;
    expect(said.view).toBe(
      "invalid module-worker.object-bucket arguments: body must be a string, an ArrayBuffer, " +
        "or a byte ReadableStream; pass the view's own buffer slice",
    );
    expect(said.number).toBe(
      "invalid module-worker.object-bucket arguments: body must be a string, an ArrayBuffer, " +
        "or a byte ReadableStream",
    );
  } finally {
    await generated.dispose();
  }
});

test("a multipart complete is refused against the receipts this isolate holds", async () => {
  const { service } = objectPlane([
    { ok: true, value: { uploadId: "upload-1" } },
    { ok: true, value: { etag: "part-1", partNumber: 1 } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const created = await env.MEDIA.createMultipartUpload("film");
       const part = await env.MEDIA.uploadPart("film", created.uploadId, 1, "small");
       let refused = null;
       try {
         await env.MEDIA.completeMultipartUpload("film", created.uploadId, [
           { etag: part.etag, partNumber: 1 },
           { etag: "unknown", partNumber: 2 },
         ]);
       } catch (error) { refused = error.name; }
       return Response.json({ uploadId: created.uploadId, part, refused });
     } };`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      uploadId: "upload-1",
      part: { etag: "part-1", partNumber: 1 },
      refused: "invalid_part",
    });
  } finally {
    await generated.dispose();
  }
});

test("v2 ObjectBucket uses its private service and streams a 10,000-part manifest as a body", async () => {
  const documents: Record<string, unknown>[] = [];
  let complete:
    | { readonly document: Record<string, unknown>; readonly parts: unknown[] }
    | undefined;
  const v2Service = {
    async fetch(url: string, init: RequestInit) {
      const headers = init.headers as Record<string, string>;
      const document = JSON.parse(
        Buffer.from(headers[SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER] ?? "", "base64url").toString(
          "utf8",
        ),
      ) as Record<string, unknown>;
      documents.push(document);
      if (document.op === "completeMultipartUpload") {
        expect(url).toBe(
          `${SELFHOST_V2_OBJECT_BUCKET_BINDING_ORIGIN}${SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH}`,
        );
        expect(headers["content-type"]).toBe(SELFHOST_V2_OBJECT_MULTIPART_PARTS_CONTENT_TYPE);
        const body = JSON.parse(await new Response(init.body).text()) as { parts: unknown[] };
        complete = { document, parts: body.parts };
        return Response.json({ ok: true, value: { etag: "whole", size: 1 } });
      }
      if (document.op === "createMultipartUpload") {
        return Response.json({ ok: true, value: { uploadId: "upload-v2" } });
      }
      if (document.op === "uploadPart") {
        return Response.json({
          ok: true,
          value: { etag: `etag-${document.partNumber}`, partNumber: document.partNumber },
        });
      }
      return Response.json({ ok: false, error: { code: "backend_unavailable" } });
    },
  };
  const legacyService = {
    async fetch() {
      throw new Error("v2 object binding must not use the legacy data service");
    },
  };
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const parts = Array.from({ length: 10000 }, (_, index) => ({
         etag: "etag-" + (index + 1), partNumber: index + 1
       }));
       const done = await env.MEDIA.completeMultipartUpload("large", "upload-v2", parts);
       return Response.json(done);
     } };`,
    {
      ...OBJECTS_ONLY,
      publication: "v2-private-publication",
      bindings: [
        {
          kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
          publicName: "MEDIA",
          internalName: WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING,
        },
      ],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(legacyService, { [WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING]: v2Service }),
      context,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({ etag: "whole", size: 1 });
    expect(documents).toHaveLength(1);
    const recorded = complete;
    expect(recorded).toBeDefined();
    if (!recorded) throw new Error("expected multipart body capture");
    expect(recorded.document).not.toHaveProperty("parts");
    expect(recorded.parts).toHaveLength(10_000);
    expect((recorded.parts[0] as { partNumber: number }).partNumber).toBe(1);
    expect((recorded.parts[9_999] as { partNumber: number }).partNumber).toBe(10_000);
  } finally {
    await generated.dispose();
  }
});

test("generic and private ObjectBucket bindings use their own services in one Worker", async () => {
  const genericRequests: string[] = [];
  const privateRequests: string[] = [];
  const genericService = {
    async fetch(url: string) {
      genericRequests.push(url);
      return Response.json({ ok: true, value: { found: false } });
    },
  };
  const privateService = {
    async fetch(url: string) {
      privateRequests.push(url);
      return Response.json({ ok: true, value: { found: false } });
    },
  };
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const legacy = await env.LEGACY.head("legacy-key");
       const bucket = await env.MEDIA.head("bucket-key");
       return Response.json({ legacy, bucket });
     } };`,
    {
      ...OBJECTS_ONLY,
      publication: "mixed-object-services",
      bindings: [
        { kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND, publicName: "LEGACY" },
        {
          kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
          publicName: "MEDIA",
          internalName: WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING,
        },
      ],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(genericService, {
        [WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING]: genericService,
        [WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING]: privateService,
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ legacy: null, bucket: null });
    expect(genericRequests).toHaveLength(1);
    expect(privateRequests).toHaveLength(1);
    expect(genericRequests[0]).toBe(
      `${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_OBJECTS_PATH}`,
    );
    expect(privateRequests[0]).toBe(
      `${SELFHOST_V2_OBJECT_BUCKET_BINDING_ORIGIN}${SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH}`,
    );
  } finally {
    await generated.dispose();
  }
});

test("generic and private KV bindings use their own services in one Worker", async () => {
  const genericRequests: string[] = [];
  const privateRequests: string[] = [];
  const response = () => Response.json({ ok: true, value: {} });
  const genericService = {
    async fetch(url: string) {
      genericRequests.push(url);
      return response();
    },
  };
  const privateService = {
    async fetch(url: string) {
      privateRequests.push(url);
      return response();
    },
  };
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       await env.LEGACY.put("legacy-key", "legacy");
       await env.CACHE.put("v2-key", "private");
       return Response.json({ ok: true });
     } };`,
    {
      ...KV_ONLY,
      publication: "mixed-kv-services",
      bindings: [
        { kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "LEGACY" },
        {
          kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
          publicName: "CACHE",
          internalName: WORKERD_V2_PRIVATE_KV_BINDING,
        },
      ],
    },
  );
  try {
    const result = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(genericService, {
        [WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING]: genericService,
        [WORKERD_V2_PRIVATE_KV_BINDING]: privateService,
      }),
      context,
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(genericRequests).toHaveLength(1);
    expect(privateRequests).toHaveLength(1);
    expect(genericRequests[0]).toEndWith(SELFHOST_DATA_PLANE_KV_PATH);
    expect(privateRequests[0]).toEndWith(SELFHOST_DATA_PLANE_KV_PATH);
  } finally {
    await generated.dispose();
  }
});

test("private v2 KV preserves EdgeKV argument TypeErrors without changing legacy KV behavior", async () => {
  const genericService = {
    async fetch(_url: string, init: RequestInit) {
      const request = JSON.parse(String(init.body)) as { op: string };
      return Response.json({
        ok: true,
        value:
          request.op === "get"
            ? { found: false }
            : request.op === "list"
              ? { keys: [], listComplete: true }
              : {},
      });
    },
  };
  const privateService = {
    async fetch(_url: string, init: RequestInit) {
      const request = JSON.parse(String(init.body)) as { op: string };
      return Response.json({
        ok: true,
        value:
          request.op === "get"
            ? { found: false }
            : request.op === "list"
              ? { keys: [], listComplete: true }
              : {},
      });
    },
  };
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const errors = {};
       const record = async (name, run) => {
         try { await run(); errors[name] = "resolved"; }
         catch (error) { errors[name] = error.name; }
       };
       await record("privateMetadataType", () => env.CACHE.put("k", "v", { metadata: "no" }));
       await record("privateListLimitType", () => env.CACHE.list({ limit: "10" }));
       await record("privateExtraGetArgument", () => env.CACHE.get("k", "ignored"));
       await record("legacyMetadataType", () => env.LEGACY.put("k", "v", { metadata: "no" }));
       await record("legacyExtraGetArgument", () => env.LEGACY.get("k", "ignored"));
       return Response.json(errors);
     } };`,
    {
      ...KV_ONLY,
      publication: "private-kv-types",
      bindings: [
        { kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "LEGACY" },
        {
          kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
          publicName: "CACHE",
          internalName: WORKERD_V2_PRIVATE_KV_BINDING,
        },
      ],
    },
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(genericService, {
        [WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING]: genericService,
        [WORKERD_V2_PRIVATE_KV_BINDING]: privateService,
      }),
      context,
    );
    expect(await response.json()).toEqual({
      privateMetadataType: "TypeError",
      privateListLimitType: "TypeError",
      privateExtraGetArgument: "TypeError",
      legacyMetadataType: "invalid_value",
      legacyExtraGetArgument: "resolved",
    });
  } finally {
    await generated.dispose();
  }
});

test("a partial answer the plane could not have written is a backend failure", async () => {
  // The managed adapter refuses these three, and so does this one: a
  // zero-length window is not a range anything asked for, a suffix is a field
  // this facade never sends, and a window past the object is a backend that
  // answered a different question.
  const bytes = new TextEncoder().encode("abcd");
  const { service } = objectPlane([
    { bytes, metadata: { etag: "e", size: 4, partial: true, range: { offset: 1, length: 0 } } },
    {
      bytes,
      metadata: { etag: "e", size: 4, partial: true, range: { offset: 0, length: 2, suffix: 2 } },
    },
    { bytes, metadata: { etag: "e", size: 4, partial: true, range: { offset: 3, length: 4 } } },
    { bytes, metadata: { etag: "e", size: 4, partial: true, range: { offset: 1, length: 3 } } },
  ]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const attempts = {};
       const record = async (name, run) => {
         try { attempts[name] = await run(); }
         catch (error) { attempts[name] = error.name; }
       };
       await record("zeroLength", async () =>
         (await env.MEDIA.get("k", { range: { offset: 1, length: 1 } })).range);
       await record("suffix", async () =>
         (await env.MEDIA.get("k", { range: { offset: 0, length: 2 } })).range);
       await record("pastEnd", async () =>
         (await env.MEDIA.get("k", { range: { offset: 3, length: 1 } })).range);
       await record("honest", async () =>
         (await env.MEDIA.get("k", { range: { offset: 1, length: 3 } })).range);
       return Response.json(attempts);
     } };`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      zeroLength: "backend_unavailable",
      suffix: "backend_unavailable",
      pastEnd: "backend_unavailable",
      honest: { offset: 1, length: 3 },
    });
  } finally {
    await generated.dispose();
  }
});

test("a tenant that forges Symbol.hasInstance cannot move what counts as a stream", async () => {
  // The tenant's top-level code runs before its first put, on an ordinary
  // extensible global. `instanceof` would therefore be the tenant's answer;
  // taking a reader and releasing it is nobody's.
  const { service, calls } = objectPlane([
    { ok: true, value: { etag: "etag-2", size: 2 } },
    { ok: true, value: { etag: "etag-8", size: 8 } },
  ]);
  const generated = await loadGenerated(
    `Object.defineProperty(ReadableStream, Symbol.hasInstance, {
       value: () => true,
       configurable: true,
     });

     export default { async fetch(request, env) {
       const attempts = {};
       const record = async (name, run) => {
         try { attempts[name] = await run(); }
         catch (error) { attempts[name] = error.name; }
       };
       attempts.instanceofLies = ({}) instanceof ReadableStream;
       // Forged to true: a value that is not a BodyInit must still be a type
       // error rather than something handed to fetch and coerced to a string.
       await record("plainObject", () => env.MEDIA.put("k", { nope: true }, { contentLength: 4 }));
       await record("string", () => env.MEDIA.put("k", "ok"));
       // Forged the other way: a real stream must still be one.
       Object.defineProperty(ReadableStream, Symbol.hasInstance, {
         value: () => false,
         configurable: true,
       });
       const body = new Blob(["streamed"]).stream();
       await record("stream", () => env.MEDIA.put("k", body, { contentLength: 8 }));
       // A tenant's isolate is its own; this one shares a realm with the rest
       // of the suite, so it puts the global back.
       delete ReadableStream[Symbol.hasInstance];
       return Response.json(attempts);
     } };`,
    OBJECTS_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      instanceofLies: true,
      plainObject: "TypeError",
      string: { etag: "etag-2", size: 2 },
      stream: { etag: "etag-8", size: 8 },
    });
    // Nothing but the two legitimate bodies ever left the isolate.
    expect(calls.map((call) => call.body)).toEqual(["ok", "streamed"]);
    expect(new Blob([]).stream() instanceof ReadableStream).toBe(true);
  } finally {
    delete (ReadableStream as unknown as Record<symbol, unknown>)[Symbol.hasInstance];
    await generated.dispose();
  }
});

test("the Host reports a namespace-consumption failure and a missing export distinctly", async () => {
  const envelope = (failure?: Record<string, unknown>) =>
    JSON.stringify({
      schema: SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
      publication: "sw1.v1",
      handlers: ["fetch"],
      ...(failure ? { failure } : {}),
    });

  expect(selfhostReadinessAnswer(envelope())).toEqual({ publication: "sw1.v1" });
  expect(selfhostReadinessFailureMessage(undefined)).toBe(
    "the Worker Version's module does not export every handler it declares",
  );

  const declaration = selfhostReadinessAnswer(
    envelope({ reason: "declaration", message: "declared handler queue is not exported" }),
  );
  expect(selfhostReadinessFailureMessage(declaration?.failure)).toBe(
    "the Worker Version's module is not what it declares: declared handler queue is not exported",
  );
  // Only a declaration refusal with nothing to add falls back to the general
  // sentence, so the other three defects never wear the handler list's words.
  expect(selfhostReadinessFailureMessage({ reason: "declaration" })).toBe(
    "the Worker Version's module does not export every handler it declares",
  );

  const module = selfhostReadinessAnswer(
    envelope({ reason: "module", name: "TypeError", message: 'No such module "node:path".' }),
  );
  expect(selfhostReadinessFailureMessage(module?.failure)).toBe(
    'the Worker Version\'s module failed to load: TypeError: No such module "node:path".',
  );

  // An envelope whose failure is not one of the two shapes is read as no
  // failure at all rather than as a third meaning.
  expect(selfhostReadinessAnswer(envelope({ reason: "whatever" }))?.failure).toBeUndefined();
  expect(selfhostReadinessAnswer('{"schema":"other"}')).toBeNull();
});

test("answers namespace-consumption detail only to the authenticated Host probe", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `const worker = Object.create(null);
Object.defineProperty(worker, "fetch", {
  get() {
    throw new TypeError('No such module "node:path". imported from "/srv/app/index.js"');
  },
});
export default worker;`,
    KV_ONLY,
  );
  try {
    const probed = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: authenticatedReadinessHeaders(),
      }),
      rawEnv(service),
      context,
    );
    expect(((await probed.json()) as { failure: { message: string } }).failure.message).toContain(
      "node:path",
    );
  } finally {
    await generated.dispose();
  }
});

/**
 * Everything the failure report touches came out of the tenant's module, so a
 * Proxy trap or a getter can throw while it is being read. A refusal this Host
 * cannot describe is still a refusal: it must not become "the runtime did not
 * answer at all", which the Host waits out and reports as retryable, burning
 * the whole probe deadline on every attempt.
 */
test("a tenant cannot make the readiness route reject", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `const failure = new Proxy({}, {
  getOwnPropertyDescriptor() { throw new RangeError("trap"); },
  get() { throw new RangeError("trap"); },
});
const worker = Object.create(null);
Object.defineProperty(worker, "fetch", { get() { throw failure; } });
export default worker;`,
    KV_ONLY,
  );
  try {
    const answered = await generated.worker.fetch(
      new Request(`https://${PROBE_HOSTNAME}${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: authenticatedReadinessHeaders(),
      }),
      rawEnv(service),
      context,
    );
    expect(answered.status).toBe(500);
    expect(await answered.json()).toEqual({
      schema: SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
      publication: "sw1.v1",
      handlers: ["fetch"],
      // Reported as the module's, undescribed — never as a declaration defect,
      // which the tenant has no way to claim.
      failure: { reason: "module", name: "Error", message: "" },
    });
  } finally {
    await generated.dispose();
  }
});

/**
 * A metadata member that is not a string is the wrong kind of thing, not too
 * much of it. The facade is where a Worker meets this rule, so the facade is
 * where the code has to be right — the plane behind it never sees the call.
 */
test("the KV facade refuses metadata by kind and by size, each as itself", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `export default { async fetch(request, env) {
       const said = {};
       const record = async (name, run) => {
         try { await run(); said[name] = null; }
         catch (error) { said[name] = error.name; }
       };
       await record("number", () => env.KV.put("k", "v", { metadata: { m: 1 } }));
       await record("nested", () => env.KV.put("k", "v", { metadata: { m: { deep: true } } }));
       await record("notARecord", () => env.KV.put("k", "v", { metadata: "no" }));
       await record("longValue", () =>
         env.KV.put("k", "v", { metadata: { m: "x".repeat(8193) } }));
       return Response.json(said);
     } };`,
    KV_ONLY,
  );
  try {
    const response = await generated.worker.fetch(
      new Request("https://worker.example/"),
      rawEnv(service),
      context,
    );
    expect(await response.json()).toEqual({
      number: "invalid_value",
      nested: "invalid_value",
      notARecord: "invalid_value",
      longValue: "metadata_too_large",
    });
  } finally {
    await generated.dispose();
  }
});
