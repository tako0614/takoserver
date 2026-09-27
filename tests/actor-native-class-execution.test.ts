import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type ActorSqlValue,
  createNativeActorExecution,
  type NativeActorSqlFacade,
  type NativeActorStorage,
} from "../src/actor-native-class-execution.ts";
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
