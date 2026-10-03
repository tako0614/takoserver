import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolveActorAbiProfile } from "../src/actor-class-execution.ts";
import {
  createActorUpgradeHandoff,
  createActorUpgradeResponse,
  installActorResponseRuntime,
} from "../src/actor-upgrade-handoff.ts";

const NativeResponse = Response;
const v2Profile = resolveActorAbiProfile({
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.actor",
  version: "2.0.0",
  schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
});
beforeEach(() => installActorResponseRuntime());
afterEach(() => {
  globalThis.Response = NativeResponse;
});
test("v2 branded 101 cannot be cloned but constructor aliases preserve its source", () => {
  const response = createActorUpgradeResponse(new Headers(), v2Profile);
  expect(response.status).toBe(101);
  expect(() => response.clone()).toThrow(TypeError);
  const alias = new Response(null, response);
  expect(alias.status).toBe(101);
  expect(() => alias.clone()).toThrow(TypeError);
  const legacy = createActorUpgradeResponse(new Headers());
  expect(legacy.clone().status).toBe(101);
});

test("v2 handoff preserves 101 clone refusal through a real reservation", async () => {
  const handoff = createActorUpgradeHandoff(
    request(),
    {
      async open() {
        return {
          response: new NativeResponse(null, { status: 101 }),
          commit() {},
          abandon() {},
        };
      },
    },
    30_000,
    v2Profile,
  );
  try {
    const response = await handoff.actor.fetch(request());
    expect(() => response.clone()).toThrow(TypeError);
    const alias = new Response(null, response);
    expect((await handoff.finish(alias)).status).toBe(101);
  } finally {
    await handoff.abandon();
  }
});

test("handoffs do not commit a reserved response from a different ABI scope", async () => {
  const transport = {
    async open() {
      return {
        response: new NativeResponse(null, { status: 101 }),
        commit() {},
        abandon() {},
      };
    },
  };
  const forward = createActorUpgradeHandoff(request(), transport, 30_000, v2Profile);
  const legacy = createActorUpgradeHandoff(request(), transport);
  try {
    const response = await forward.actor.fetch(request());
    expect((await legacy.finish(response)).status).toBe(503);
    expect((await forward.finish(response)).status).toBe(101);
  } finally {
    await Promise.all([forward.abandon(), legacy.abandon()]);
  }
});
function request(): Request {
  return new Request("http://worker.invalid/socket", {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });
}

test("Hono CORS reconstruction preserves Actor Response and middleware headers", async () => {
  const original = request();
  let commits = 0;
  const handoff = createActorUpgradeHandoff(original, {
    async open() {
      return {
        response: new NativeResponse(null, { status: 101 }),
        commit() {
          commits += 1;
        },
        abandon() {},
      };
    },
  });
  const app = new Hono();
  app.use("*", cors());
  app.use("*", async (c, next) => {
    await next();
    c.header("x-middleware", "kept");
  });
  app.get("/socket", async () => await handoff.actor.fetch(request()));
  try {
    const result = await app.fetch(original);
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(101);
    const committed = await handoff.finish(result);
    expect(committed.status).toBe(101);
    expect(committed.headers.get("x-middleware")).toBe("kept");
    expect(committed.headers.get("access-control-allow-origin")).toBe("*");
    expect(commits).toBe(1);
  } finally {
    await handoff.abandon();
  }
});

function fixture(
  options: {
    original?: Request;
    headers?: HeadersInit;
    ms?: number;
    commit?: () => Promise<void>;
  } = {},
) {
  let commits = 0;
  let abandons = 0;
  const handoff = createActorUpgradeHandoff(
    options.original ?? request(),
    {
      async open() {
        return {
          response: new NativeResponse(null, {
            status: 101,
            ...(options.headers ? { headers: options.headers } : {}),
          }),
          async commit() {
            commits += 1;
            await options.commit?.();
          },
          abandon() {
            abandons += 1;
          },
        };
      },
    },
    options.ms,
  );
  return { handoff, counts: () => ({ commits, abandons }) };
}

test("Response ABI has no socket and constructor/clone aliases share one commitment", async () => {
  const { handoff, counts } = fixture();
  const response: Response = await handoff.actor.fetch(request());
  expect(response).toBeInstanceOf(Response);
  expect(response).toBeInstanceOf(NativeResponse);
  expect(response.status).toBe(101);
  expect(response.statusText).toBe("Switching Protocols");
  expect(response.ok).toBe(false);
  expect(response.body).toBeNull();
  expect(response.bodyUsed).toBe(false);
  expect(await response.text()).toBe("");
  expect((response as Response & { webSocket?: unknown }).webSocket ?? null).toBeNull();
  expect(
    Object.getOwnPropertyNames(response).some((name) => /token|reservation|socket/i.test(name)),
  ).toBe(false);
  const clone = response.clone();
  clone.headers.append("set-cookie", "a=1");
  clone.headers.append("set-cookie", "b=2");
  const alias = new Response(clone.body, clone);
  clone.headers.set("x-clone", "private-copy");
  expect(response.headers.has("x-clone")).toBe(false);
  expect(alias.headers.has("x-clone")).toBe(false);
  const committed = await handoff.finish(alias);
  expect(committed.status).toBe(101);
  expect(committed.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  expect((await handoff.finish(response)).status).toBe(503);
  expect((await handoff.finish(clone)).status).toBe(503);
  expect(counts()).toEqual({ commits: 1, abandons: 0 });
});

test("plain, copied, inherited and serialized init cannot mint reservation", async () => {
  const { handoff, counts } = fixture();
  const response = await handoff.actor.fetch(request());
  expect(() => new Response(null, { status: 101 })).toThrow();
  expect(() => new Response(null, { status: "101" } as unknown as ResponseInit)).toThrow();
  expect(
    () => new Response(null, { status: response.status, headers: response.headers }),
  ).toThrow();
  expect(() => new Response("body", response)).toThrow();
  expect(() => new Response(null, Object.create(response))).toThrow();
  expect(() => new Response(null, JSON.parse('{"status":101}'))).toThrow();
  const spread = new Response(null, { ...response });
  expect((await handoff.finish(spread)).status).toBe(200);
  expect(counts()).toEqual({ commits: 0, abandons: 1 });
});

test("subclass, prototype impersonation and borrowed clone cannot mint authority", async () => {
  const { handoff, counts } = fixture();
  const response = await handoff.actor.fetch(request());
  class ForgedResponse extends Response {
    override get status() {
      return 101;
    }
  }
  const forged = new ForgedResponse();
  expect(() => new Response(null, forged)).toThrow();
  expect(() => Response.prototype.clone.call(Object.create(Response.prototype))).toThrow();
  const nativeClone = NativeResponse.prototype.clone.call(response);
  expect((await handoff.finish(nativeClone)).status).toBe(200);
  expect(counts()).toEqual({ commits: 0, abandons: 1 });
});

test("cross-request aliases are rejected without consuming rightful reservation", async () => {
  const a = fixture();
  const b = fixture();
  const response = await a.handoff.actor.fetch(request());
  expect((await b.handoff.finish(response.clone())).status).toBe(503);
  expect(a.counts().commits).toBe(0);
  expect((await a.handoff.finish(new Response(null, response))).status).toBe(101);
  expect(a.counts().commits).toBe(1);
});

test("prototype tampering cannot hide reserved changes or forge the private brand", async () => {
  const { handoff, counts } = fixture();
  const response = await handoff.actor.fetch(request());
  response.headers.set("sec-websocket-protocol", "forged");
  const get = WeakMap.prototype.get;
  const headersGet = Headers.prototype.get;
  const iterator = Array.prototype[Symbol.iterator];
  let result: Response;
  try {
    WeakMap.prototype.get = () => response;
    Headers.prototype.get = () => null;
    // biome-ignore lint/correctness/useYield: deliberately sabotages iteration to test captured guards
    Array.prototype[Symbol.iterator] = function* () {
      return undefined;
    };
    result = await handoff.finish(response);
  } finally {
    WeakMap.prototype.get = get;
    Headers.prototype.get = headersGet;
    Array.prototype[Symbol.iterator] = iterator;
  }
  expect(result.status).toBe(503);
  expect(counts()).toEqual({ commits: 0, abandons: 1 });
});

for (const [name, value] of [
  ["sec-websocket-protocol", "unoffered"],
  ["upgrade", "other"],
  ["connection", "close"],
  ["sec-websocket-accept", "forged"],
  ["sec-websocket-extensions", "permessage-deflate"],
  ["content-length", "1"],
  ["transfer-encoding", "chunked"],
  ["x-takoserver-private-broker-token", "forged"],
] as const) {
  test(`commit rejects mutation of reserved header ${name}`, async () => {
    const { handoff, counts } = fixture();
    const response = await handoff.actor.fetch(request());
    response.headers.set(name, value);
    expect((await handoff.finish(response)).status).toBe(503);
    expect(counts()).toEqual({ commits: 0, abandons: 1 });
  });
}

test("ordinary headers may be deleted and changed; commit snapshots before yielding", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { handoff } = fixture({ headers: { "x-delete": "remove" }, commit: () => pending });
  const response = await handoff.actor.fetch(request());
  response.headers.delete("x-delete");
  response.headers.set("x-keep", "before");
  const finished = handoff.finish(response);
  response.headers.set("x-keep", "after");
  release();
  const result = await finished;
  expect(result.headers.has("x-delete")).toBe(false);
  expect(result.headers.get("x-keep")).toBe("before");
});

test("abort, expiry, abandonment and failed commit settle every alias", async () => {
  const abort = new AbortController();
  const cases = [
    fixture({ original: new Request(request(), { signal: abort.signal }) }),
    fixture({ ms: 1 }),
    fixture(),
    fixture({
      commit: async () => {
        throw new Error("transport");
      },
    }),
  ];
  for (const [index, { handoff, counts }] of cases.entries()) {
    const response = await handoff.actor.fetch(request());
    const alias = response.clone();
    if (index === 0) abort.abort();
    if (index === 1) await Bun.sleep(5);
    if (index === 2) await handoff.abandon();
    expect((await handoff.finish(alias)).status).toBe(503);
    expect((await handoff.finish(response)).status).toBe(503);
    expect(counts().abandons).toBe(1);
  }
});

test("ordinary native fetch and Response static/streaming behavior survive installation", async () => {
  let statusReads = 0;
  const initializer = Object.create({
    get status() {
      statusReads += 1;
      return 201;
    },
  }) as ResponseInit;
  expect(new Response("ordinary", initializer).status).toBe(201);
  expect(statusReads).toBe(1);
  const native = await fetch("data:application/json,%7B%22ok%22%3Atrue%7D");
  expect(native).toBeInstanceOf(Response);
  expect(native.ok).toBe(true);
  expect(await native.clone().json()).toEqual({ ok: true });
  expect(await fixture().handoff.finish(native)).toBe(native);
  const json = Response.json({ yes: true }, { status: 201 });
  expect(json).toBeInstanceOf(Response);
  expect(await json.json()).toEqual({ yes: true });
  expect(Response.error().status).toBe(0);
  expect(Response.error().ok).toBe(false);
  expect(Response.redirect("https://example.com/", 307).headers.get("location")).toBe(
    "https://example.com/",
  );
  const ordinary = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("body"));
        c.close();
      },
    }),
    { status: 202 },
  );
  expect(ordinary.status).toBe(202);
  expect(ordinary.ok).toBe(true);
  expect(await ordinary.clone().text()).toBe("body");
  expect(await ordinary.text()).toBe("body");
});
