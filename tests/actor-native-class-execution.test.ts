import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { resolveActorAbiProfile } from "../src/actor-class-execution.ts";
import {
  type ActorSqlValue,
  createActorNativeUpgradeHeaders,
  createNativeActorExecution,
  type NativeActorSqlFacade,
  type NativeActorStorage,
} from "../src/actor-native-class-execution.ts";
import { createActorNativeSocketPort } from "../src/actor-native-owner-worker.ts";
import { installActorResponseRuntime } from "../src/actor-upgrade-handoff.ts";

function storage(database: Database): NativeActorStorage {
  return {
    sql: {
      exec(sql, ...params) {
        const before = database.query("SELECT total_changes() AS n").get() as { n: number };
        const rows = database.query(sql).all(...params) as Record<string, unknown>[];
        const after = database.query("SELECT total_changes() AS n").get() as { n: number };
        return {
          rowsWritten: after.n - before.n,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync: (callback) => database.transaction(callback)(),
  };
}

test("forward native adapter delivers socketError separately and accepts a 16 KiB attachment", async () => {
  const db = new Database(":memory:");
  const calls: string[] = [];
  const profile = resolveActorAbiProfile({
    apiVersion: "interfaces.takoform.com/v1alpha1",
    name: "worker.actor",
    version: "2.0.0",
    schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
  });
  class Actor {
    fetch() {
      return new Response("ok");
    }
    alarm() {}
    async socketMessage(socket: {
      getAttachment(): Promise<Uint8Array | null>;
      setAttachment(value: Uint8Array): Promise<void>;
      send(value: Uint8Array): Promise<void>;
    }) {
      const attachment = await socket.getAttachment();
      expect(attachment?.byteLength).toBe(12_000);
      if (attachment) await socket.setAttachment(attachment);
      await socket.send(new Uint8Array(8_388_609));
      await expect(socket.send(new Uint8Array(33_554_433))).rejects.toMatchObject({
        code: "message_too_large",
      });
    }
    socketClose() {
      calls.push("close");
    }
    socketError(_socket: object, event: { code: string }) {
      calls.push(event.code);
    }
  }
  try {
    const actor = createNativeActorExecution({
      namespace: { Actor },
      exportName: "Actor",
      profile,
      id: "actor-v2",
      env: {},
      storage: storage(db),
      alarm: {
        async set() {},
        async get() {
          return null;
        },
        async clear() {},
      },
      socketPort: (nonce) =>
        createActorNativeSocketPort(
          {
            async fetch(request) {
              expect(request.headers.get("x-takoserver-private-actor-abi")).toBe(
                profile.schemaDigest,
              );
              const action = request.headers.get("x-takoserver-private-actor-socket-action");
              if (action === "get-attachment") return new Response(new Uint8Array(12_000));
              if (action === "set-attachment") {
                expect((await request.arrayBuffer()).byteLength).toBe(12_000);
                return new Response(null, { status: 204 });
              }
              if (action === "send") {
                expect((await request.arrayBuffer()).byteLength).toBe(8_388_609);
                return new Response(null, { status: 204 });
              }
              return new Response(null, { status: 204 });
            },
          },
          undefined,
          "actor-v2",
          nonce,
          profile,
        ),
    });
    await actor.socketError(
      "socket-1",
      { code: "transport_error" },
      new AbortController().signal,
      "nonce",
    );
    expect(calls).toEqual(["transport_error"]);
    // The existing native port must not apply the legacy 8 KiB cap in v2.
    await actor.socketMessage("socket-1", "message", new AbortController().signal, "nonce");
    const mismatched = createNativeActorExecution({
      namespace: { Actor },
      exportName: "Actor",
      profile,
      id: "actor-v2",
      env: {},
      storage: storage(db),
      alarm: {
        async set() {},
        async get() {
          return null;
        },
        async clear() {},
      },
      socketPort: (nonce) =>
        createActorNativeSocketPort(
          {
            async fetch() {
              throw new Error("mismatched port must not call owner");
            },
          },
          undefined,
          "actor-v2",
          nonce,
        ),
    });
    await expect(
      mismatched.socketError(
        "socket-1",
        { code: "transport_error" },
        new AbortController().signal,
        "nonce",
      ),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
  } finally {
    db.close();
  }
});

test("accept returns Response and transfers a reconstructed alias once with public headers", async () => {
  const NativeResponse = Response;
  installActorResponseRuntime();
  const db = new Database(":memory:");
  let accepted: Response | undefined;
  class Actor {
    constructor(
      readonly context: {
        sockets: {
          accept(
            request: Request,
            options: { protocol: string },
          ): Promise<{ response: Response; socket: object }>;
        };
      },
    ) {}
    async fetch(request: Request): Promise<Response> {
      const result = await this.context.sockets.accept(request, { protocol: "chat" });
      expect(Object.keys(result).sort()).toEqual(["response", "socket"]);
      accepted = result.response;
      expect(accepted.status).toBe(101);
      expect(accepted.body).toBeNull();
      expect(accepted).toBeInstanceOf(Response);
      const alias = new Response(accepted.body, accepted.clone());
      alias.headers.set("x-actor", "kept");
      return alias;
    }
    alarm() {}
    socketMessage() {}
    socketClose() {}
  }
  try {
    const actor = createNativeActorExecution({
      namespace: { Actor },
      exportName: "Actor",
      id: "actor-id",
      env: {},
      storage: storage(db),
      alarm: {
        async set() {},
        async get() {
          return null;
        },
        async clear() {},
      },
      socketPort: () => ({
        async accept() {
          return "socket-id";
        },
        async get() {
          return false;
        },
        async list() {
          return [];
        },
        async send() {},
        async close() {},
        async getAttachment() {
          return null;
        },
        async setAttachment() {},
      }),
    });
    const result = await actor.fetch(
      new Request("http://actor.invalid", { headers: { upgrade: "websocket" } }),
      "nonce",
    );
    expect(actor.takeUpgrade(result, "other-request")).toBeNull();
    expect(actor.takeUpgrade(result, "nonce")).toEqual({
      nonce: "nonce",
      socketId: "socket-id",
      protocol: "chat",
      headers: [
        ["sec-websocket-protocol", "chat"],
        ["x-actor", "kept"],
      ],
    });
    expect(actor.takeUpgrade(accepted, "nonce")).toBeNull();
    expect(actor.takeUpgrade(result.clone(), "nonce")).toBeNull();
  } finally {
    db.close();
    globalThis.Response = NativeResponse;
  }
});

test("accepted Actor upgrade cannot inject headers through a poisoned snapshot iterator", async () => {
  const NativeResponse = Response;
  const iterator = Array.prototype[Symbol.iterator];
  installActorResponseRuntime();
  const db = new Database(":memory:");
  class Actor {
    constructor(
      readonly context: { sockets: { accept(request: Request): Promise<{ response: Response }> } },
    ) {}
    async fetch(request: Request): Promise<Response> {
      const { response } = await this.context.sockets.accept(request);
      response.headers.append("set-cookie", "a=1");
      response.headers.append("set-cookie", "b=2");
      Array.prototype[Symbol.iterator] = function* () {
        const pair = ["sec-websocket-protocol", "forged"];
        Object.defineProperty(pair, Symbol.iterator, { value: iterator });
        yield pair;
        return undefined;
      };
      return response;
    }
    alarm() {}
    socketMessage() {}
    socketClose() {}
  }
  try {
    const actor = createNativeActorExecution({
      namespace: { Actor },
      exportName: "Actor",
      id: "actor-id",
      env: {},
      storage: storage(db),
      alarm: {
        async set() {},
        async get() {
          return null;
        },
        async clear() {},
      },
      socketPort: () => ({
        async accept() {
          return "socket-id";
        },
        async get() {
          return false;
        },
        async list() {
          return [];
        },
        async send() {},
        async close() {},
        async getAttachment() {
          return null;
        },
        async setAttachment() {},
      }),
    });
    const response = await actor.fetch(
      new Request("http://actor.invalid", { headers: { upgrade: "websocket" } }),
      "nonce",
    );
    const upgrade = actor.takeUpgrade(response, "nonce");
    if (!upgrade) throw new Error("accepted upgrade missing");
    const head = createActorNativeUpgradeHeaders(upgrade.headers);
    const decision = new NativeResponse(null, { status: 204, headers: head });
    Array.prototype[Symbol.iterator] = iterator;
    expect(head.get("sec-websocket-protocol")).toBeNull();
    expect(head.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(decision.headers.get("sec-websocket-protocol")).toBeNull();
    expect(decision.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  } finally {
    Array.prototype[Symbol.iterator] = iterator;
    db.close();
    globalThis.Response = NativeResponse;
  }
});

test("native adapter dispatches broker-created socket events with the exact facade and turn", async () => {
  const db = new Database(":memory:");
  const socket = Object.freeze({ id: "opaque-socket" });
  const sockets = Object.freeze({
    async get(id: string) {
      return id === socket.id ? socket : null;
    },
    async list() {
      return [socket];
    },
  });
  const received: unknown[] = [];
  class SocketActor {
    constructor(context: { sockets: typeof sockets }) {
      expect(context.sockets).toBe(sockets);
    }
    fetch() {
      return new Response();
    }
    alarm() {}
    socketMessage(given: object, data: string | Uint8Array, turn: { signal: AbortSignal }) {
      received.push(["message", given, data, turn.signal]);
    }
    socketClose(
      given: object,
      event: { code: number; reason: string; wasClean: boolean },
      turn: { signal: AbortSignal },
    ) {
      received.push(["close", given, event, turn.signal]);
    }
  }
  try {
    const actor = createNativeActorExecution({
      namespace: { SocketActor },
      exportName: "SocketActor",
      id: "actor-id",
      env: {},
      storage: storage(db),
      alarm: {
        async set() {},
        async get() {
          return null;
        },
        async clear() {},
      },
      sockets,
    });
    const signal = new AbortController().signal;
    const data = new Uint8Array([0, 1, 255]);
    const close = { code: 1006, reason: "transport_error", wasClean: false };
    await actor.socketMessage(socket, data, signal);
    await actor.socketClose(socket, close, signal);
    expect(received).toEqual([
      ["message", socket, data, signal],
      ["close", socket, close, signal],
    ]);
  } finally {
    db.close();
  }
});

test("native class adapter initializes once and exposes SQL and a host-owned alarm facade", async () => {
  const db = new Database(":memory:");
  const events: string[] = [];
  let context!: {
    storage: NativeActorSqlFacade;
    alarm: {
      set(at: number): Promise<void>;
      get(): Promise<number | null>;
      clear(): Promise<void>;
    };
    sockets: { list(): Promise<unknown> };
  };
  class Counter {
    constructor(ctx: typeof context) {
      events.push("constructor");
      context = ctx;
    }
    async start() {
      events.push("start");
      await context.storage.execute("CREATE TABLE counter (value INTEGER)");
      await Promise.resolve();
      events.push("ready");
    }
    async fetch() {
      events.push("fetch");
      await context.storage.execute("INSERT INTO counter VALUES (?)", [1]);
      return Response.json(await context.storage.query("SELECT count(*) AS n FROM counter"));
    }
    async alarm() {
      events.push("alarm");
      await context.alarm.set(200);
    }
    socketMessage() {}
    socketClose() {}
  }
  try {
    const actor = createNativeActorExecution({
      namespace: { Counter },
      exportName: "Counter",
      id: "one",
      env: {},
      storage: storage(db),
      alarm: {
        async set(at) {
          events.push(`set:${at}`);
        },
        async get() {
          return 200;
        },
        async clear() {
          events.push("clear");
        },
      },
    });
    expect(events).toEqual([]);
    expect((await (await actor.fetch(new Request("https://actor.test"))).json()).rows).toEqual([
      { n: 1 },
    ]);
    expect((await (await actor.fetch(new Request("https://actor.test"))).json()).rows).toEqual([
      { n: 2 },
    ]);
    expect(events).toEqual(["constructor", "start", "ready", "fetch", "fetch"]);
    expect(Object.keys(context).sort()).toEqual(["alarm", "id", "sockets", "storage"]);
    expect(Object.keys(context.storage).sort()).toEqual(["execute", "query", "transaction"]);
    expect(Object.isFrozen(context.storage)).toBe(true);
    await context.alarm.set(100);
    expect(await context.alarm.get()).toBe(200);
    await actor.alarm(new AbortController().signal);
    await context.alarm.clear();
    expect(events.slice(-4)).toEqual(["set:100", "alarm", "set:200", "clear"]);
    await expect(context.sockets.list()).rejects.toMatchObject({ code: "backend_unavailable" });
    await context.storage.query("INSERT INTO counter VALUES (999)");
    expect((await context.storage.query("SELECT count(*) AS n FROM counter")).rows).toEqual([
      { n: 2 },
    ]);
    await context.storage.execute("CREATE TABLE trigger_identifiers (begin INTEGER, end INTEGER)");
    await context.storage.execute(
      "CREATE TRIGGER tricky AFTER INSERT ON counter BEGIN INSERT INTO trigger_identifiers VALUES (1, 2); SELECT begin, end, CASE WHEN begin = 1 THEN end ELSE 0 END FROM trigger_identifiers; END; -- done",
    );
    await context.storage.execute("INSERT INTO counter VALUES (3)");
    expect((await context.storage.query("SELECT * FROM trigger_identifiers")).rows).toEqual([
      { begin: 1, end: 2 },
    ]);
    await expect(
      context.storage.execute(
        "CREATE TRIGGER forbidden AFTER INSERT ON counter BEGIN SELECT begin FROM trigger_identifiers; END; DELETE FROM counter;",
      ),
    ).rejects.toMatchObject({ code: "invalid_sql" });
    await context.storage.execute("DROP TRIGGER tricky");
    await context.storage.execute("DELETE FROM counter WHERE value = 3");
    await expect(
      context.storage.transaction([{ sql: "INSERT INTO counter VALUES (7)" }, { sql: "INVALID" }]),
    ).rejects.toMatchObject({ code: "invalid_sql" });
    expect((await context.storage.query("SELECT count(*) AS n FROM counter")).rows).toEqual([
      { n: 2 },
    ]);
    await context.storage.execute("CREATE TABLE blobs (value BLOB)");
    await context.storage.execute("INSERT INTO blobs VALUES (?)", [
      { encoding: "base64", data: "AAH/" },
    ]);
    expect((await context.storage.query("SELECT value FROM blobs")).rows).toEqual([
      { value: { encoding: "base64", data: "AAH/" } },
    ]);
    await expect(
      context.storage.execute("SELECT ?", [true as unknown as ActorSqlValue]),
    ).rejects.toMatchObject({
      code: "invalid_sql",
    });
    const invalid = await context.storage
      .execute("SELECT ?", [true as unknown as ActorSqlValue])
      .catch((error: Error) => error);
    expect(Reflect.set(invalid, "name", "forged")).toBe(false);
    expect(Reflect.set(invalid, "code", "forged")).toBe(false);
    for (const value of [1e20, -1e20, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        context.storage.execute("INSERT INTO counter VALUES (?)", [value]),
      ).rejects.toMatchObject({ code: "numeric_out_of_range" });
    }
    await expect(
      context.storage.execute("INSERT INTO counter VALUES (5) RETURNING 1e20 AS value"),
    ).rejects.toMatchObject({ code: "numeric_out_of_range" });
    expect((await context.storage.query("SELECT count(*) AS n FROM counter")).rows).toEqual([
      { n: 2 },
    ]);
    await expect(
      context.storage.transaction(Array.from({ length: 101 }, () => ({ sql: "SELECT 1" }))),
    ).rejects.toMatchObject({ code: "invalid_sql" });
    await expect(
      context.storage.query(
        "WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<10001) SELECT v FROM n",
      ),
    ).rejects.toMatchObject({ code: "result_too_large" });
    await expect(
      context.storage.execute("INSERT INTO counter VALUES (3); INSERT INTO counter VALUES (4)"),
    ).rejects.toMatchObject({ code: "invalid_sql" });
    await expect(
      context.storage.execute("SELECT ?", [
        { encoding: "base64", data: "AAH/", extra: 1 } as ActorSqlValue,
      ]),
    ).rejects.toMatchObject({ code: "invalid_sql" });
    expect(
      (
        await context.storage.execute(
          "SELECT ?100 AS value",
          Array.from({ length: 100 }, () => 1.5),
        )
      ).rows,
    ).toEqual([{ value: 1.5 }]);
    await expect(
      context.storage.execute(
        "SELECT ?",
        Array.from({ length: 101 }, () => 0),
      ),
    ).rejects.toMatchObject({ code: "invalid_sql" });
    expect(
      (await context.storage.transaction(Array.from({ length: 100 }, () => ({ sql: "SELECT 1" }))))
        .results,
    ).toHaveLength(100);
    expect(
      (
        await context.storage.query(
          "WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<10000) SELECT v FROM n",
        )
      ).rows,
    ).toHaveLength(10000);
    for (const sql of [
      `SELECT 1 AS "${"é".repeat(65)}"`,
      `SELECT ${Array.from({ length: 101 }, (_, index) => `1 AS c${index}`).join(",")}`,
      "SELECT printf('%.*c', 1000001, 'x') AS value",
    ])
      await expect(context.storage.query(sql)).rejects.toMatchObject({ code: "result_too_large" });
    await expect(context.storage.execute("SELECT ?", ["é".repeat(500001)])).rejects.toMatchObject({
      code: "invalid_sql",
    });
    await expect(
      context.storage.execute("SELECT ?", [{ encoding: "base64", data: "AB==" }]),
    ).rejects.toMatchObject({ code: "invalid_sql" });
    await expect(
      context.storage.execute(`SELECT 1 /*${"x".repeat(100000)}*/`),
    ).rejects.toMatchObject({ code: "invalid_sql" });
    const large =
      "WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<5) SELECT printf('%.*c', 1000000, 'x') AS value FROM n";
    await expect(
      context.storage.transaction([
        { sql: "INSERT INTO counter VALUES (7)" },
        { sql: large },
        { sql: large },
      ]),
    ).rejects.toMatchObject({ code: "result_too_large" });
    expect((await context.storage.query("SELECT count(*) AS n FROM counter")).rows).toEqual([
      { n: 2 },
    ]);
  } finally {
    db.close();
  }
});

test("adapter returns the original streaming Response without reading or buffering", async () => {
  const db = new Database(":memory:");
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }),
  );
  class Streaming {
    fetch() {
      return response;
    }
    alarm() {}
    socketMessage() {}
    socketClose() {}
  }
  try {
    const actor = createNativeActorExecution({
      namespace: { Streaming },
      exportName: "Streaming",
      id: "stream",
      env: {},
      storage: storage(db),
      alarm: {
        async set() {},
        async get() {
          return null;
        },
        async clear() {},
      },
    });
    const returned = await actor.fetch(new Request("https://actor.test"));
    expect(returned).toBe(response);
    expect(returned.bodyUsed).toBe(false);
    const reader = returned.body?.getReader();
    controller.enqueue(new TextEncoder().encode("head"));
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("head");
    controller.close();
    expect((await reader?.read())?.done).toBe(true);
  } finally {
    db.close();
  }
});
