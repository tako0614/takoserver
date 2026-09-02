import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
  SELFHOST_WORKER_DATA_SERVICE_BINDING,
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
  SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
  SELFHOST_WORKER_READINESS_HEADER,
  SELFHOST_WORKER_READINESS_PATH,
  SELFHOST_WORKER_READINESS_PROTOCOL,
  SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
  type SelfhostWorkerEntrypointSourceInput,
  selfhostReadinessAnswer,
  selfhostReadinessFailureMessage,
  selfhostWorkerEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";

/**
 * The generated entrypoint is the only thing standing between a tenant's module
 * and this Host's data planes, so what it hands over — and what it refuses to —
 * is the contract under test here. It is exercised as a real module: written to
 * disk beside a tenant module and imported, because "does the import resolve"
 * and "does the tenant see the facade" are the two things a string comparison
 * would not answer.
 */

const KV_ONLY: SelfhostWorkerEntrypointSourceInput = {
  originalMainModule: "index.js",
  publication: "sw1.v1",
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
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
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
): Promise<{
  readonly worker: {
    fetch(request: Request, env: Record<string, unknown>, context: object): Promise<Response>;
    queue?: (event: unknown, env: Record<string, unknown>, context: object) => Promise<unknown>;
  };
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-selfhost-wrapper-"));
  const tenantPath = join(root, input.originalMainModule);
  await mkdir(dirname(tenantPath), { recursive: true });
  await Bun.write(tenantPath, tenantSource);
  const wrapperPath = join(root, "wrapper.mjs");
  await Bun.write(wrapperPath, selfhostWorkerEntrypointSource(input));
  const loaded = (await import(
    `${pathToFileURL(wrapperPath).href}?test=${crypto.randomUUID()}`
  )) as { readonly default: Awaited<ReturnType<typeof loadGenerated>>["worker"] };
  return {
    worker: loaded.default,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function rawEnv(
  service: { fetch(url: string, init: RequestInit): Promise<Response> },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  // No token: the generated entrypoint's service binding addresses this Host's
  // own facade service, and the facade is what holds the credential. A raw
  // environment carrying one here would be testing a topology that no longer
  // exists.
  return { [SELFHOST_WORKER_DATA_SERVICE_BINDING]: service, ...extra };
}

const context = { waitUntil() {} };

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

test("the readiness route loads the tenant module and names its own publication", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `export default { async fetch() { return new Response("tenant"); } };`,
  );
  try {
    const answered = await generated.worker.fetch(
      new Request(`https://worker.example${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: { [SELFHOST_WORKER_READINESS_HEADER]: SELFHOST_WORKER_READINESS_PROTOCOL },
      }),
      rawEnv(service),
      context,
    );
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      schema: SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
      publication: "sw1.v1",
      handlers: ["fetch"],
    });
    // Without the protocol header the same path is an ordinary tenant request.
    const tenant = await generated.worker.fetch(
      new Request(`https://worker.example${SELFHOST_WORKER_READINESS_PATH}`, { method: "POST" }),
      rawEnv(service),
      context,
    );
    expect(await tenant.text()).toBe("tenant");
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
      new Request(`https://worker.example${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: { [SELFHOST_WORKER_READINESS_HEADER]: SELFHOST_WORKER_READINESS_PROTOCOL },
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
      failure: { reason: "declaration", message: "self-host Worker declared handler is missing" },
    });
  } finally {
    await generated.dispose();
  }
});

/**
 * A module that throws at import time and a module missing a declared handler
 * are different defects in different files. Reporting both as the second sent
 * the self-host end-to-end run's operator to read a complete export list: the
 * real cause was a dead `import path from "node:path"` in a dependency, and it
 * was visible only by running the runtime by hand.
 */
test("the readiness route distinguishes an import-time failure from a missing export", async () => {
  const { service } = plane([]);
  // Bun resolves `node:path`, so the module that would fail on workerd is
  // simulated by the same thing that failure is: a throw during import.
  const generated = await loadGenerated(
    `throw new TypeError('No such module "node:path".\\n  imported from "tenant.js"');\n` +
      `export default { async fetch() { return new Response("ok"); } };`,
    KV_ONLY,
  );
  try {
    const answered = await generated.worker.fetch(
      new Request(`https://worker.example${SELFHOST_WORKER_READINESS_PATH}`, {
        method: "POST",
        headers: { [SELFHOST_WORKER_READINESS_HEADER]: SELFHOST_WORKER_READINESS_PROTOCOL },
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

test("a declared handler the tenant module does not export refuses the publication", async () => {
  const { service } = plane([]);
  const generated = await loadGenerated(
    `export default { async fetch() { return new Response("ok"); } };`,
    { ...KV_ONLY, declaredHandlers: ["fetch", "scheduled"] },
  );
  try {
    await expect(
      generated.worker.fetch(new Request("https://worker.example/"), rawEnv(service), context),
    ).rejects.toThrow("declared handler is missing");
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
    ).rejects.toThrow("must have a default export");
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

test("a version with no facade generates no entrypoint at all", () => {
  expect(() =>
    selfhostWorkerEntrypointSource({
      originalMainModule: "index.js",
      publication: "sw1.v1",
      declaredHandlers: ["fetch"],
      bindings: [{ name: "LANE", type: "plain_text" }],
    }),
  ).toThrow("bindings is invalid");
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
        const body = init.body === undefined ? "" : await new Response(init.body).text();
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
  declaredHandlers: ["fetch"],
  bindings: [{ kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND, publicName: "MEDIA" }],
};

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

test("the Host reports an import-time failure as one, and a missing export as one", async () => {
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
    envelope({ reason: "declaration", message: "self-host Worker declared handler is missing" }),
  );
  expect(selfhostReadinessFailureMessage(declaration?.failure)).toBe(
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
