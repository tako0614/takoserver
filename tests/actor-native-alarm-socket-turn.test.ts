import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import { resolveActorAbiProfile } from "../src/actor-class-execution.ts";
import {
  createNativeActorExecution,
  type NativeActorExecutionOptions,
} from "../src/actor-native-class-execution.ts";
import {
  createActorNativeAlarmPort,
  createActorNativeOwner,
  createActorNativeSocketPort,
} from "../src/actor-native-owner-worker.ts";

const profile = resolveActorAbiProfile(ACTOR_ABI_INTERFACE_REFS.v2);
const legacyProfile = resolveActorAbiProfile(ACTOR_ABI_INTERFACE_REFS.legacy);
type Socket = {
  readonly id: string;
  send(value: string): Promise<void>;
  getAttachment(): Promise<Uint8Array | null>;
  setAttachment(value: Uint8Array | null): Promise<void>;
};
type Context = {
  readonly sockets: {
    list(): Promise<readonly Socket[]>;
    get(id: string): Promise<Socket | null>;
    accept(request: Request): Promise<unknown>;
  };
};

function actorStorage(database: Database): NativeActorExecutionOptions["storage"] {
  return {
    sql: {
      exec(sql, ...params) {
        const rows = database.query(sql).all(...params) as Record<string, unknown>[];
        return Object.assign(rows, { rowsWritten: 0 });
      },
    },
    transactionSync: (callback) => database.transaction(callback)(),
  };
}

test("late private port creation never passes authority to an ambient freeze override", () => {
  const nativeFreeze = Object.freeze;
  let observed = 0;
  Object.freeze = ((value: unknown) => {
    observed += 1;
    return nativeFreeze(value);
  }) as typeof Object.freeze;
  try {
    const service = {
      async fetch() {
        return new Response(null, { status: 204 });
      },
    };
    const alarm = createActorNativeAlarmPort(service, "a".repeat(64), "owner-one");
    const sockets = createActorNativeSocketPort(
      service,
      "a".repeat(64),
      "owner-one",
      "nonce",
      profile,
    );
    expect(observed).toBe(0);
    expect(Object.isFrozen(alarm)).toBe(true);
    expect(Object.isFrozen(sockets)).toBe(true);
  } finally {
    Object.freeze = nativeFreeze;
  }
});

test("v2 alarm gets one exact-profile socket turn and leaves no usable detached handle", async () => {
  const db = new Database(":memory:");
  const calls: string[] = [];
  const attachment = new Uint8Array(16_384).fill(7);
  let held: Socket | undefined;
  class Actor {
    constructor(readonly context: Context) {}
    fetch() {
      return new Response();
    }
    async alarm() {
      const sockets = await this.context.sockets.list();
      const socket = sockets[0];
      if (!socket) throw new Error("alarm socket missing");
      held = socket;
      expect(socket.id).toBe("socket-one");
      expect((await this.context.sockets.get(socket.id))?.id).toBe(socket.id);
      await socket.send("from admitted alarm");
      await socket.setAttachment(attachment);
      expect(await socket.getAttachment()).toEqual(attachment);
      await expect(
        this.context.sockets.accept(
          new Request("http://actor.invalid/", { headers: { upgrade: "websocket" } }),
        ),
      ).rejects.toMatchObject({ code: "invalid_upgrade" });
    }
    socketMessage() {}
    socketClose() {}
    socketError() {}
  }
  const execution = createNativeActorExecution({
    namespace: { Actor },
    exportName: "Actor",
    id: "owner-one",
    env: {},
    storage: actorStorage(db),
    alarm: {
      async set() {},
      async get() {
        return null;
      },
      async clear() {},
    },
    profile,
    socketPort: (nonce) =>
      createActorNativeSocketPort(
        {
          async fetch(request) {
            expect(request.headers.get("x-takoserver-private-actor-socket-nonce")).toBe(
              "alarm-nonce",
            );
            expect(request.headers.get("x-takoserver-private-actor-abi")).toBe(
              profile.schemaDigest,
            );
            const action = request.headers.get("x-takoserver-private-actor-socket-action");
            if (!action) throw new Error("socket action missing");
            calls.push(action);
            if (action === "list") return Response.json(["socket-one"]);
            if (action === "get") return Response.json({ exists: true });
            if (action === "get-attachment") return new Response(attachment);
            if (action === "send") expect(await request.text()).toBe("from admitted alarm");
            if (action === "set-attachment")
              expect(new Uint8Array(await request.arrayBuffer())).toEqual(attachment);
            if (action === "accept") throw new Error("alarm cannot create a client upgrade");
            return new Response(null, { status: 204 });
          },
        },
        "a".repeat(64),
        "owner-one",
        nonce,
        profile,
      ),
  });
  try {
    await execution.alarm(new AbortController().signal, "alarm-nonce");
    expect(calls).toEqual(["list", "get", "send", "set-attachment", "get-attachment"]);
    if (!held) throw new Error("alarm handle not captured");
    await expect(held.send("after alarm")).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(calls).toHaveLength(5);
  } finally {
    db.close();
  }
});

for (const nonce of [undefined, "mismatched-port"])
  test(`v2 alarm refuses ${nonce ?? "missing nonce"} before tenant dispatch`, async () => {
    const db = new Database(":memory:");
    let calls = 0;
    class Actor {
      fetch() {
        return new Response();
      }
      alarm() {
        calls += 1;
      }
      socketMessage() {}
      socketClose() {}
      socketError() {}
    }
    const execution = createNativeActorExecution({
      namespace: { Actor },
      exportName: "Actor",
      id: "one",
      env: {},
      storage: actorStorage(db),
      alarm: {
        async set() {},
        async get() {
          return null;
        },
        async clear() {},
      },
      profile,
      socketPort: (nonce) =>
        createActorNativeSocketPort(
          {
            async fetch() {
              throw new Error("no socket call may leave the adapter");
            },
          },
          "a".repeat(64),
          "one",
          nonce,
          resolveActorAbiProfile(ACTOR_ABI_INTERFACE_REFS.legacy),
        ),
    });
    try {
      await expect(execution.alarm(new AbortController().signal, nonce)).rejects.toMatchObject({
        code: "backend_unavailable",
      });
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

for (const selectedProfile of [profile, legacyProfile])
  test(`${selectedProfile.kind} admitted native alarm carries a fresh nonce and preserves its accept error contract`, async () => {
    const db = new Database(":memory:");
    const id = "alarm-owner";
    const socketId = "00000000-0000-4000-8000-000000000001";
    type NativeSocket = Parameters<
      InstanceType<ReturnType<typeof createActorNativeOwner>>["webSocketMessage"]
    >[0];
    let metadata = { socketId, actorId: id, attachment: btoa("original") };
    const sent: (string | ArrayBuffer)[] = [];
    const socket = {
      deserializeAttachment: () => metadata,
      serializeAttachment(value: typeof metadata) {
        metadata = value;
      },
      send(value: string | ArrayBuffer) {
        sent.push(value);
      },
      close() {},
    } as NativeSocket;
    const kv = new Map<string, unknown>();
    const nonces: string[] = [];
    const admissions: string[] = [];
    const completions: string[] = [];
    let retired = 0;
    const Owner = createActorNativeOwner(
      "a".repeat(64),
      "c".repeat(64),
      {
        generationKey: "d".repeat(64),
        epoch: "epoch-1",
        variantKeys: ["one"],
      },
      undefined,
      undefined,
      undefined,
      selectedProfile,
    );
    const owner = new Owner(
      {
        storage: {
          sql: {
            exec(sql, ...params) {
              return db.query(sql).all(...params) as Record<string, unknown>[];
            },
          },
          kv: {
            get: (key) => kv.get(key),
            put: (key, value) => {
              kv.set(key, structuredClone(value));
            },
            delete: (key) => kv.delete(key),
            list: () => kv.entries(),
          },
          setAlarm() {},
          deleteAlarm() {},
        },
        getWebSockets: () => [socket],
        waitUntil() {},
        facets: {
          get: () => ({
            async fetch(request) {
              const nonce = request.headers.get("x-takoserver-private-actor-socket-nonce");
              if (!nonce) throw new Error("admitted alarm nonce missing");
              nonces.push(nonce);
              const port = createActorNativeSocketPort(
                { fetch: (request) => owner.fetch(request) },
                "a".repeat(64),
                id,
                nonce,
                selectedProfile,
              );
              expect(await port.list()).toEqual([socketId]);
              expect(await port.get(socketId)).toBe(true);
              await port.send(socketId, "from alarm");
              const attachment = new Uint8Array(selectedProfile.socketAttachmentBytes).fill(8);
              await port.setAttachment(socketId, attachment);
              expect(await port.getAttachment(socketId)).toEqual(attachment);
              await expect(port.accept()).rejects.toMatchObject({
                code: selectedProfile.kind === "v2" ? "invalid_upgrade" : "backend_unavailable",
              });
              return new Response(null, { status: 204 });
            },
          }),
          abort() {
            retired += 1;
          },
        },
      },
      {
        CLASS: {},
        CLASS_0: {},
        ADMISSION: {
          async fetch(request) {
            const body = (await request.json()) as Record<string, unknown>;
            if (body.action === "complete") {
              completions.push(body.attemptNonce as string);
              return new Response(null, { status: 204 });
            }
            admissions.push(body.attemptNonce as string);
            return Response.json({
              id,
              attemptNonce: body.attemptNonce,
              generationKey: "d".repeat(64),
              epoch: "epoch-1",
              variantKey: "one",
              leaseId: "lease-one",
            });
          },
        },
      },
    );
    try {
      for (let index = 0; index < 2; index += 1) {
        db.query("UPDATE actor_alarm_state SET actor_id = ?, pending_at = ? WHERE id = 1").run(
          id,
          Date.now() - 1,
        );
        await owner.alarm();
      }
      expect(nonces).toHaveLength(2);
      expect(nonces[0]).not.toBe(nonces[1]);
      expect(sent).toEqual(["from alarm", "from alarm"]);
      expect(retired).toBe(2);
      expect(completions).toEqual(admissions);
      expect(db.query("SELECT obligation FROM actor_alarm_state WHERE id = 1").get()).toEqual({
        obligation: 0,
      });
      const stale = createActorNativeSocketPort(
        { fetch: (request) => owner.fetch(request) },
        "a".repeat(64),
        id,
        nonces[0] as string,
        selectedProfile,
      );
      await expect(stale.list()).rejects.toMatchObject({ code: "socket_closed" });
    } finally {
      db.close();
    }
  });
