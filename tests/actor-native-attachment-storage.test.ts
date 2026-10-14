import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import type {
  createActorNativeOwner,
  createActorNativeSocketPort,
} from "../src/actor-native-owner-worker.ts";
import { actorNativeBundleRealm } from "./helpers/actor-native-bundle-realm.ts";

const prefix = "__takoserver_actor_socket_attachment_v1:";
const actorId = "attachment-owner";
const socketId = "00000000-0000-4000-8000-000000000001";
const bytes = Uint8Array.from({ length: 16_384 }, (_, index) => index % 251);
type NativeSocket = Parameters<
  InstanceType<ReturnType<typeof createActorNativeOwner>>["webSocketMessage"]
>[0];

function fixture(options: {
  readonly legacy?: Uint8Array;
  readonly payload?: unknown;
  readonly disconnected?: boolean;
  readonly legacyProfile?: boolean;
  readonly completionStatus?: number;
  readonly complete?: () => Promise<number>;
  readonly rejectPut?: boolean;
  readonly pending?: "valid" | "expired";
  readonly callback?: (port: ReturnType<typeof createActorNativeSocketPort>) => Promise<void>;
}) {
  const db = new Database(":memory:");
  const kv = new Map<string, unknown>();
  if (options.payload !== undefined) kv.set(prefix + socketId, options.payload);
  const closes: (number | undefined)[] = [];
  const closeCalls: { code: number | undefined; reason: string | undefined }[] = [];
  const reads: (Uint8Array | null)[] = [];
  const lists: { prefix: string; limit: number }[] = [];
  let delivered = 0;
  let completions = 0;
  class NativeWebSocket {
    close(code?: number, reason?: string) {
      closes.push(code);
      closeCalls.push({ code, reason });
    }
  }
  const realm = actorNativeBundleRealm(NativeWebSocket);
  const selectedProfile = options.legacyProfile
    ? undefined
    : realm.resolveActorAbiProfile(ACTOR_ABI_INTERFACE_REFS.v2);
  let metadata: unknown = options.legacy
    ? { socketId, actorId, attachment: Buffer.from(options.legacy).toString("base64") }
    : { socketId, actorId, attachment: null, attachmentFormat: "owner-kv-v1" };
  if (options.pending) {
    const expiresAt = Date.now() + (options.pending === "valid" ? 30_000 : -1);
    metadata = {
      ...(metadata as Record<string, unknown>),
      reservationBearer: "b".repeat(64),
      reservationExpiresAt: expiresAt,
      reservationGenerationKey: "d".repeat(64),
      reservationEpoch: "epoch-1",
      reservationVariantKey: "one",
    };
    db.exec(
      "CREATE TABLE actor_socket_reservations (socket_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, bearer TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    );
    db.query("INSERT INTO actor_socket_reservations VALUES (?, ?, ?, ?)").run(
      socketId,
      actorId,
      "b".repeat(64),
      expiresAt,
    );
  }
  const socket = Object.assign(new NativeWebSocket(), {
    deserializeAttachment: () => structuredClone(metadata),
    serializeAttachment(value: unknown) {
      metadata = structuredClone(value);
    },
    send(_value: string | ArrayBuffer) {},
  }) as NativeSocket;
  const Owner = realm.createActorNativeOwner(
    "a".repeat(64),
    "c".repeat(64),
    { generationKey: "d".repeat(64), epoch: "epoch-1", variantKeys: ["one"] },
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
          get(key) {
            return structuredClone(kv.get(key));
          },
          put(key, value) {
            if (options.rejectPut) throw new Error("storage write failed");
            kv.set(key, structuredClone(value));
          },
          delete: (key) => kv.delete(key),
          list(options) {
            lists.push(options);
            return [...kv.entries()]
              .filter(([key]) => key.startsWith(options.prefix))
              .sort(([a], [b]) => a.localeCompare(b))
              .slice(0, options.limit);
          },
        },
        setAlarm() {},
        deleteAlarm() {},
      },
      getWebSockets: () => (options.disconnected ? [] : [socket]),
      waitUntil() {},
      facets: {
        get: () => ({
          async fetch(request) {
            delivered += 1;
            const nonce = request.headers.get("x-takoserver-private-actor-socket-nonce");
            if (!nonce) throw new Error("callback nonce missing");
            const port = realm.createActorNativeSocketPort(
              { fetch: (request) => owner.fetch(request) },
              "a".repeat(64),
              actorId,
              nonce,
              selectedProfile,
            );
            reads.push(await port.getAttachment(socketId));
            await options.callback?.(port);
            return new Response(null, { status: 204 });
          },
        }),
        abort() {},
      },
    },
    {
      CLASS: {},
      CLASS_0: {},
      ADMISSION: {
        async fetch(request) {
          const body = (await request.json()) as Record<string, unknown>;
          if (body.action === "socket-complete") {
            completions += 1;
            return new Response(null, {
              status: (await options.complete?.()) ?? options.completionStatus ?? 204,
            });
          }
          return Response.json({
            id: actorId,
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
  return {
    owner,
    socket,
    kv,
    closes,
    closeCalls,
    reads,
    lists,
    delivered: () => delivered,
    completions: () => completions,
    nativeWebSocket: NativeWebSocket,
    close: () => db.close(),
  };
}

test("cold native owner restores all 16 KiB from its private socket custody", async () => {
  const f = fixture({ payload: { actorId, bytes } });
  try {
    await f.owner.webSocketMessage(f.socket, "read");
    expect(f.reads).toEqual([bytes]);
    expect(f.delivered()).toBe(1);
    expect(f.closes).toEqual([]);
    expect(f.kv.has(prefix + socketId)).toBe(true);
    await expect(f.owner.retireSocketAttachments()).rejects.toThrow("retirement unavailable");
    expect(f.kv.has(prefix + socketId)).toBe(true);
  } finally {
    f.close();
  }
});

test("old base64 envelope remains readable on a disconnected terminal callback", async () => {
  const legacy = bytes.slice(0, 8_192);
  const f = fixture({ legacy, disconnected: true });
  try {
    await f.owner.webSocketClose(f.socket, 1000, "done", true);
    expect(f.reads).toEqual([legacy]);
    expect(f.delivered()).toBe(1);
  } finally {
    f.close();
  }
});

test("failed replacement retains the old cached and persisted attachment", async () => {
  const f = fixture({
    payload: { actorId, bytes },
    rejectPut: true,
    callback: async (port) => {
      await expect(port.setAttachment(socketId, new Uint8Array([9]))).rejects.toThrow(
        "storage write failed",
      );
      expect(await port.getAttachment(socketId)).toEqual(bytes);
    },
  });
  try {
    await f.owner.webSocketMessage(f.socket, "replace");
    expect(f.kv.get(prefix + socketId)).toEqual({ actorId, bytes });
    expect(f.closes).toEqual([]);
  } finally {
    f.close();
  }
});

for (const pending of ["valid", "expired"] as const)
  test(`uncommitted ${pending} reservation cleanup deletes its payload without an application callback`, async () => {
    const f = fixture({ payload: { actorId, bytes }, pending });
    try {
      if (pending === "valid") {
        const result = await f.owner.fetch(
          new Request("http://actor.invalid/", {
            method: "POST",
            headers: {
              "x-takoserver-private-actor-id": actorId,
              "x-takoserver-private-actor-reservation": "b".repeat(64),
              "x-takoserver-private-actor-reservation-action": "abandon",
            },
          }),
        );
        expect(result.status).toBe(204);
      } else await f.owner.webSocketClose(f.socket, 1008, "expired", false);
      expect(f.kv.has(prefix + socketId)).toBe(false);
      expect(f.closes).toEqual([1008]);
      expect(f.delivered()).toBe(0);
    } finally {
      f.close();
    }
  });

for (const [name, payload] of [
  ["missing", undefined],
  ["foreign actor", { actorId: "other-tenant", bytes }],
  ["oversized", { actorId, bytes: new Uint8Array(16_385) }],
  ["wrong type", { actorId, bytes: "copied" }],
] as const)
  test(`native owner refuses ${name} payload before callback admission`, async () => {
    const f = fixture({ ...(payload === undefined ? {} : { payload }) });
    try {
      await expect(f.owner.webSocketMessage(f.socket, "read")).rejects.toThrow(
        "Actor socket attachment unavailable",
      );
      expect(f.delivered()).toBe(0);
      expect(f.closes).toEqual([1011]);
      expect(f.kv.has(prefix + socketId)).toBe(false);
    } finally {
      f.close();
    }
  });

test("terminal custody survives a held callback and is reclaimed after proven settlement", async () => {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const f = fixture({
    payload: { actorId, bytes },
    disconnected: true,
    callback: async () => {
      entered.resolve();
      await released.promise;
    },
  });
  try {
    const terminal = f.owner.webSocketClose(f.socket, 1000, "done", true);
    await entered.promise;
    const retirement = f.owner.retireSocketAttachments();
    expect(f.kv.has(prefix + socketId)).toBe(true);
    expect(f.reads).toEqual([bytes]);
    released.resolve();
    await terminal;
    expect(await retirement).toEqual({ deleted: 0, complete: true });
    expect(f.kv.has(prefix + socketId)).toBe(false);
  } finally {
    released.resolve();
    f.close();
  }
});

test("unknown callback completion retains custody and blocks retirement", async () => {
  const f = fixture({ payload: { actorId, bytes }, disconnected: true, completionStatus: 503 });
  try {
    await expect(f.owner.webSocketClose(f.socket, 1000, "done", true)).rejects.toThrow(
      "Actor socket completion unavailable",
    );
    expect(f.reads).toEqual([bytes]);
    expect(f.kv.has(prefix + socketId)).toBe(true);
    expect(f.completions()).toBe(3);
    expect(f.closeCalls).toEqual([{ code: 1000, reason: "done" }]);
    await expect(f.owner.retireSocketAttachments()).rejects.toThrow("retirement unavailable");
    expect(f.kv.has(prefix + socketId)).toBe(true);
  } finally {
    f.close();
  }
});

test("v2 terminal close waits for callback and Host completion before native acknowledgement", async () => {
  const callbackEntered = Promise.withResolvers<void>();
  const callbackReleased = Promise.withResolvers<void>();
  const completionEntered = Promise.withResolvers<void>();
  const completionReleased = Promise.withResolvers<void>();
  const f = fixture({
    payload: { actorId, bytes },
    disconnected: true,
    callback: async () => {
      callbackEntered.resolve();
      await callbackReleased.promise;
    },
    complete: async () => {
      completionEntered.resolve();
      await completionReleased.promise;
      return 204;
    },
  });
  try {
    const terminal = f.owner.webSocketClose(f.socket, 1000, "done", true);
    await callbackEntered.promise;
    expect(f.closeCalls).toEqual([]);
    expect(f.kv.has(prefix + socketId)).toBe(true);
    callbackReleased.resolve();
    await completionEntered.promise;
    expect(f.closeCalls).toEqual([]);
    expect(f.kv.has(prefix + socketId)).toBe(true);
    completionReleased.resolve();
    await terminal;
    expect(f.completions()).toBe(1);
    expect(f.closeCalls).toEqual([{ code: 1000, reason: "done" }]);
    expect(f.kv.has(prefix + socketId)).toBe(false);
  } finally {
    callbackReleased.resolve();
    completionReleased.resolve();
    f.close();
  }
});

test("v2 no-status terminal close never emits reserved code 1005", async () => {
  const f = fixture({ payload: { actorId, bytes }, disconnected: true });
  try {
    await f.owner.webSocketClose(f.socket, 1005, "", true);
    expect(f.closeCalls).toEqual([{ code: undefined, reason: undefined }]);
    expect(f.kv.has(prefix + socketId)).toBe(false);
  } finally {
    f.close();
  }
});

test("v2 terminal acknowledgement ignores a close method replaced during callback", async () => {
  let replacementCalls = 0;
  const f = fixture({
    payload: { actorId, bytes },
    disconnected: true,
    callback: async () => {
      f.socket.close = () => {
        replacementCalls += 1;
      };
    },
  });
  try {
    await f.owner.webSocketClose(f.socket, 1000, "done", true);
    expect(replacementCalls).toBe(0);
    expect(f.closeCalls).toEqual([{ code: 1000, reason: "done" }]);
  } finally {
    f.close();
  }
});

test("v2 terminal acknowledgement survives native prototype replacement before entry", async () => {
  const f = fixture({ payload: { actorId, bytes }, disconnected: true });
  let replacementCalls = 0;
  try {
    f.nativeWebSocket.prototype.close = () => {
      replacementCalls += 1;
    };
    await f.owner.webSocketClose(f.socket, 1000, "done", true);
    expect(replacementCalls).toBe(0);
    expect(f.closeCalls).toEqual([{ code: 1000, reason: "done" }]);
  } finally {
    f.close();
  }
});

test("legacy terminal close keeps the released native acknowledgement behavior", async () => {
  const f = fixture({
    legacy: bytes.slice(0, 8_192),
    disconnected: true,
    legacyProfile: true,
  });
  try {
    await f.owner.webSocketClose(f.socket, 1000, "done", true);
    expect(f.reads).toEqual([bytes.slice(0, 8_192)]);
    expect(f.completions()).toBe(1);
    expect(f.closeCalls).toEqual([]);
  } finally {
    f.close();
  }
});

test("explicit quiescent retirement purges at most 32 owned keys and preserves unrelated storage", async () => {
  const f = fixture({ disconnected: true });
  try {
    for (let index = 0; index < 33; index += 1)
      f.kv.set(prefix + crypto.randomUUID(), { actorId, bytes });
    f.kv.set("tenant-unrelated", "kept");
    expect(await f.owner.retireSocketAttachments()).toEqual({ deleted: 32, complete: false });
    expect(f.kv.size).toBe(2);
    expect(await f.owner.retireSocketAttachments()).toEqual({ deleted: 1, complete: true });
    expect([...f.kv.entries()]).toEqual([["tenant-unrelated", "kept"]]);
    expect(f.lists).toEqual([
      { prefix, limit: 32 },
      { prefix, limit: 32 },
    ]);
  } finally {
    f.close();
  }
});
