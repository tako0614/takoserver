import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { resolveActorAbiProfile } from "../src/actor-class-execution.ts";
import { ACTOR_NATIVE_BOOTSTRAP_SOURCE } from "../src/actor-native-bootstrap-source.ts";
import type {
  createActorNativeOwner,
  createActorNativeSocketPort,
  signActorNativeUpgradeDecision,
} from "../src/actor-native-owner-worker.ts";

type Frame = string | Uint8Array;

/** Portable model: formal bundle factories and signed upgrade are real; transport is not workerd. */
function pendingFixture(
  frames: readonly Frame[],
  fault?: "partial-write" | "descriptor-write" | "ambiguous-send",
  selectedKind: "v2" | "legacy" = "v2",
  clock?: () => number,
) {
  class Socket {
    attachment: unknown;
    peer!: Socket;
    readonly received: Frame[] = [];
    closed = false;
    send(value: Frame) {
      this.peer.received.push(typeof value === "string" ? value : value.slice());
      if (fault === "ambiguous-send") throw new Error("native send outcome unknown");
    }
    close() {
      this.closed = true;
      this.peer.closed = true;
    }
    serializeAttachment(value: unknown) {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 16_384)
        throw new Error("native attachment envelope exceeded");
      this.attachment = structuredClone(value);
    }
    deserializeAttachment() {
      return structuredClone(this.attachment);
    }
  }
  const pairs: Pair[] = [];
  class Pair {
    readonly 0 = new Socket();
    readonly 1 = new Socket();
    constructor() {
      this[0].peer = this[1];
      this[1].peer = this[0];
      pairs.push(this);
    }
  }
  class NativeResponse extends Response {
    readonly webSocket: Socket | undefined;
    readonly nativeStatus: number | undefined;
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: Socket }) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      this.nativeStatus = init?.status === 101 ? 101 : undefined;
      this.webSocket = init?.webSocket;
    }
    override get status() {
      return this.nativeStatus ?? super.status;
    }
    override get headers() {
      return super.headers;
    }
    override get ok() {
      return this.status >= 200 && this.status < 300;
    }
  }
  const exports = /\nexport \{\n(?: {2}[A-Za-z][A-Za-z0-9]*,?\n)+\};\n?$/u.exec(
    ACTOR_NATIVE_BOOTSTRAP_SOURCE,
  );
  if (!exports || exports.index === undefined)
    throw new Error("unexpected native bootstrap export syntax");
  // Remove only ESM's export statement. Implementation and profile brands come
  // from the closed artifact consumed by the normal native bootstrap source.
  const realm = runInNewContext(
    `${ACTOR_NATIVE_BOOTSTRAP_SOURCE.slice(0, exports.index)}\n({ createActorNativeOwner, createActorNativeSocketPort, signActorNativeUpgradeDecision, resolveActorAbiProfile });`,
    {
      WebSocket: Socket,
      WebSocketPair: Pair,
      Response: NativeResponse,
      Headers,
      Request,
      ReadableStream,
      crypto,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      AbortController,
      AbortSignal,
      DOMException,
      setTimeout,
      clearTimeout,
      atob,
      btoa,
      ...(clock
        ? {
            Date: class extends Date {
              static override now() {
                return clock();
              }
            },
          }
        : {}),
    },
    { timeout: 1_000 },
  ) as {
    createActorNativeOwner: typeof createActorNativeOwner;
    createActorNativeSocketPort: typeof createActorNativeSocketPort;
    signActorNativeUpgradeDecision: typeof signActorNativeUpgradeDecision;
    resolveActorAbiProfile: typeof resolveActorAbiProfile;
  };
  const selectedProfile = realm.resolveActorAbiProfile({
    apiVersion: "interfaces.takoform.com/v1alpha1",
    name: "worker.actor",
    version: selectedKind === "v2" ? "2.0.0" : "1.0.0",
    schemaDigest:
      selectedKind === "v2"
        ? "sha256:f4d70bb6d63c436e43b2e6cc50069fa6ed68eca68aea2fbc10a77969738db156"
        : "sha256:f5428fb587de80261dd7363dc5b8a3f4aab7e469fa1b5fce8441ad9acbec8218",
  });
  const db = new Database(":memory:");
  const sql = {
    exec(statement: string, ...params: (string | number | null)[]) {
      if (statement.startsWith("SELECT"))
        return db.query(statement).all(...params) as Record<string, unknown>[];
      db.query(statement).run(...params);
      return [];
    },
  };
  const values = new Map<string, unknown>();
  const kv = {
    get(key: string) {
      return structuredClone(values.get(key));
    },
    put(key: string, value: unknown) {
      if (value instanceof Uint8Array && value.byteLength > 131_072)
        throw new Error("KV value exceeded");
      if (fault === "partial-write" && key.endsWith(":pending:1"))
        throw new Error("KV write failed");
      if (fault === "descriptor-write" && !key.includes(":pending:"))
        throw new Error("KV descriptor write failed");
      values.set(key, structuredClone(value));
    },
    delete(key: string) {
      return values.delete(key);
    },
    list({ prefix, limit }: { prefix: string; limit: number }) {
      return [...values]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit);
    },
  };
  const actorId = "pending-original-actor";
  const offer = "e".repeat(64);
  const delivery = "a".repeat(64);
  const retained: Promise<unknown>[] = [];
  const sockets: Socket[] = [];
  const attachment = new Uint8Array(selectedProfile.socketAttachmentBytes).fill(73);
  let owner!: InstanceType<ReturnType<typeof realm.createActorNativeOwner>>;
  const service = { fetch: (request: Request) => owner.fetch(request) };
  let facetCalls = 0;
  const state = {
    facets: {
      get: () => ({
        async fetch(request: Request) {
          facetCalls++;
          const nonce = request.headers.get("x-takoserver-private-actor-upgrade-nonce");
          if (!nonce) throw new Error("missing trusted original nonce");
          const port = realm.createActorNativeSocketPort(
            service,
            "c".repeat(64),
            actorId,
            nonce,
            selectedProfile,
          );
          const socketId = await port.accept("pending-v1", attachment);
          for (const frame of frames) await port.send(socketId, frame);
          const decision = await realm.signActorNativeUpgradeDecision(
            delivery,
            nonce,
            encodeURIComponent(actorId),
            socketId,
            "pending-v1",
          );
          return new NativeResponse(null, {
            status: 204,
            headers: {
              "x-takoserver-private-actor-upgrade-decision": decision,
              "x-takoserver-private-actor-upgrade-socket-id": socketId,
              "sec-websocket-protocol": "pending-v1",
            },
          });
        },
      }),
      abort() {},
    },
    storage: { sql, kv, setAlarm() {}, deleteAlarm() {} },
    getWebSockets: () => sockets.filter((socket) => !socket.closed) as never[],
    acceptWebSocket(socket: unknown) {
      sockets.push(socket as Socket);
    },
    waitUntil(promise: Promise<unknown>) {
      retained.push(promise);
    },
  };
  const construct = (epoch = "epoch-1") => {
    const Owner = realm.createActorNativeOwner(
      delivery,
      "c".repeat(64),
      {
        generationKey: "d".repeat(64),
        epoch,
        variantKeys: ["default"],
      },
      undefined,
      undefined,
      undefined,
      selectedProfile,
    );
    owner = new Owner(state, {
      CLASS: {},
      CLASS_0: {},
      SOCKET_ADMISSION: {
        async fetch() {
          return new NativeResponse(null, { status: 204 });
        },
      },
    });
    return owner;
  };
  construct();
  return {
    values,
    pairs,
    attachment,
    sql,
    async open() {
      const response = await owner.fetch(
        new Request("http://actor.invalid/socket", {
          headers: {
            "x-takoserver-private-actor-id": encodeURIComponent(actorId),
            "x-takoserver-private-actor-variant": "default",
            "x-takoserver-private-actor-reservation-offer": offer,
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
            "sec-websocket-protocol": "pending-v1",
          },
        }),
      );
      await Promise.all(retained);
      expect(response.status).toBe(101);
      expect((response as NativeResponse).webSocket).toBe(pairs[0]?.[0]);
      expect(pairs[0]?.[0].received).toEqual([]);
      expect(sql.exec("SELECT COUNT(*) AS n FROM actor_socket_reservations")).toEqual([{ n: 1 }]);
      return response;
    },
    reconstruct(epoch?: string) {
      const before = owner;
      construct(epoch);
      expect(owner).not.toBe(before);
    },
    holdNextGraphRead() {
      const heldOwner = owner;
      const read = Reflect.get(heldOwner, "currentGraph");
      if (typeof read !== "function" || Object.hasOwn(heldOwner, "currentGraph"))
        throw new Error("original graph reader unavailable");
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Delay only the actual reader's result. Its graph and receiver stay
      // unchanged; the original signed reservation and queued socket are real.
      Reflect.set(heldOwner, "currentGraph", async (...args: unknown[]) => {
        Reflect.deleteProperty(heldOwner, "currentGraph");
        const graph = await Reflect.apply(read, heldOwner, args);
        enter();
        await gate;
        return graph;
      });
      return { entered, release };
    },
    async settle(action: "commit" | "abandon", bearer = offer) {
      return owner.fetch(
        new Request("http://actor.invalid/", {
          method: "POST",
          headers: {
            "x-takoserver-private-actor-id": encodeURIComponent(actorId),
            "x-takoserver-private-actor-reservation": bearer,
            "x-takoserver-private-actor-reservation-action": action,
          },
        }),
      );
    },
    get facetCalls() {
      return facetCalls;
    },
    async expire() {
      const expiry = Date.now() - 1;
      sql.exec("UPDATE actor_socket_reservations SET expires_at=?", expiry);
      const socket = sockets[0];
      if (!socket) throw new Error("original socket unavailable");
      const metadata = socket.deserializeAttachment() as Record<string, unknown>;
      socket.serializeAttachment({ ...metadata, reservationExpiresAt: expiry });
    },
    async retire() {
      for (const socket of sockets) socket.close();
      return owner.retireSocketAttachments();
    },
    async close() {
      await Promise.all(retained);
      db.close();
    },
  };
}

test("pending original socket flushes queued mixed frames once after owner reconstruction", async () => {
  const frames = ["connected:日本語", Uint8Array.of(0, 255, 17), ""];
  const f = pendingFixture(frames);
  try {
    const original = await f.open();
    f.reconstruct();
    expect((await f.settle("commit", "f".repeat(64))).status).toBe(404);
    expect(f.pairs[0]?.[0].received).toEqual([]);
    expect((await f.settle("commit")).status).toBe(204);
    expect(f.pairs[0]?.[0].received).toEqual(frames);
    f.reconstruct();
    expect((await f.settle("commit")).status).toBe(404);
    expect(f.pairs[0]?.[0].received).toEqual(frames);
    expect(f.facetCalls).toBe(1);
    expect(original.headers.get("sec-websocket-protocol")).toBe("pending-v1");
    expect(f.sql.exec("SELECT COUNT(*) AS n FROM actor_socket_reservations")).toEqual([{ n: 0 }]);
    const payload = [...f.values.values()][0] as { bytes: Uint8Array };
    expect(payload.bytes).toEqual(f.attachment);
    expect(f.values.size).toBe(1);
    expect(await f.retire()).toEqual({ deleted: 1, complete: true });
    expect(f.values.size).toBe(0);
  } finally {
    await f.close();
  }
});

test("pending frame boundaries preserve Unicode and binary across storage chunks", async () => {
  const frames = [`${"x".repeat(65_535)}日本語`, new Uint8Array(131_073).fill(37), ""];
  const f = pendingFixture(frames);
  try {
    await f.open();
    f.reconstruct();
    expect((await f.settle("commit")).status).toBe(204);
    expect(f.pairs[0]?.[0].received).toEqual(frames);
    expect(f.values.size).toBe(1);
  } finally {
    await f.close();
  }
});

test("pending reconstruction preserves the full existing 32 MiB byte ceiling", async () => {
  const frame = new Uint8Array(33_554_432).fill(19);
  const f = pendingFixture([frame]);
  try {
    await f.open();
    f.reconstruct();
    expect((await f.settle("commit")).status).toBe(204);
    const received = f.pairs[0]?.[0].received;
    expect(received?.length).toBe(1);
    expect(received?.[0]).toEqual(frame);
  } finally {
    await f.close();
  }
});

test("pending empty frames are bounded without changing the byte ceiling", async () => {
  const f = pendingFixture(Array.from({ length: 257 }, () => ""));
  try {
    await expect(f.open()).rejects.toThrow("transport_overloaded");
    expect(f.values.size).toBe(0);
    expect(f.pairs).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const terminal of ["abandon", "expire", "changed-graph"] as const)
  test(`pending ${terminal} closes the original socket and removes queued custody`, async () => {
    const f = pendingFixture(["greeting"]);
    try {
      await f.open();
      if (terminal === "expire") await f.expire();
      f.reconstruct(terminal === "changed-graph" ? "other-epoch" : undefined);
      expect((await f.settle(terminal === "abandon" ? "abandon" : "commit")).status).toBe(
        terminal === "abandon" ? 204 : 404,
      );
      expect(f.pairs[0]?.[0].received).toEqual([]);
      expect(f.pairs[0]?.[0].closed).toBe(true);
      expect(f.values.size).toBe(0);
      expect(f.sql.exec("SELECT COUNT(*) AS n FROM actor_socket_reservations")).toEqual([{ n: 0 }]);
    } finally {
      await f.close();
    }
  });

for (const corruption of [
  "missing-chunk",
  "short-chunk",
  "missing-descriptor",
  "wrong-bearer",
  "byte-count",
  "frame-kind",
  "invalid-text",
] as const)
  test(`pending ${corruption} refuses before sending and cleans original custody`, async () => {
    const f = pendingFixture(["greeting"]);
    try {
      await f.open();
      const chunk = [...f.values.keys()].find((key) => key.includes(":pending:"));
      const payloadKey = [...f.values.keys()].find((key) => !key.includes(":pending:"));
      if (!chunk || !payloadKey) throw new Error("owned pending records unavailable");
      const payload = f.values.get(payloadKey) as { pending?: Record<string, unknown> };
      if (corruption === "missing-chunk") f.values.delete(chunk);
      if (corruption === "short-chunk") f.values.set(chunk, new Uint8Array(1));
      if (corruption === "missing-descriptor") delete payload.pending;
      if (corruption === "wrong-bearer" && payload.pending) payload.pending.bearer = "f".repeat(64);
      if (corruption === "byte-count" && payload.pending) payload.pending.queuedBytes = 0;
      if (corruption === "frame-kind" && payload.pending)
        payload.pending.frames = [{ kind: "other", length: 8 }];
      if (corruption === "invalid-text") f.values.set(chunk, new Uint8Array(8).fill(255));
      f.reconstruct();
      await expect(f.settle("commit")).rejects.toThrow();
      expect(f.pairs[0]?.[0].received).toEqual([]);
      expect(f.pairs[0]?.[0].closed).toBe(true);
      expect(f.values.size).toBe(0);
      expect(f.sql.exec("SELECT COUNT(*) AS n FROM actor_socket_reservations")).toEqual([{ n: 0 }]);
    } finally {
      await f.close();
    }
  });

test("partial pending write returns no native head and removes every written chunk", async () => {
  const f = pendingFixture([new Uint8Array(131_073)], "partial-write");
  try {
    await expect(f.open()).rejects.toThrow("KV write failed");
    expect(f.pairs[0]?.[0].received).toEqual([]);
    expect(f.pairs[0]?.[0].closed).toBe(true);
    expect(f.values.size).toBe(0);
    expect(f.sql.exec("SELECT COUNT(*) AS n FROM actor_socket_reservations")).toEqual([{ n: 0 }]);
  } finally {
    await f.close();
  }
});

test("ambiguous native send cannot replay a queued frame after reconstruction", async () => {
  const f = pendingFixture(["possibly-delivered", "never-sent"], "ambiguous-send");
  try {
    await f.open();
    f.reconstruct();
    expect((await f.settle("commit")).status).toBe(503);
    expect(f.pairs[0]?.[0].received).toEqual(["possibly-delivered"]);
    expect(f.values.size).toBe(0);
    f.reconstruct();
    expect((await f.settle("commit")).status).toBe(404);
    expect(f.pairs[0]?.[0].received).toEqual(["possibly-delivered"]);
    expect(f.facetCalls).toBe(1);
  } finally {
    await f.close();
  }
});

test("pending text preserves leading BOM codepoints and original UTF8 byte accounting", async () => {
  const frames = ["\uFEFFhello", "\uFEFF", "middle\uFEFFtext"];
  const f = pendingFixture(frames);
  try {
    await f.open();
    f.reconstruct();
    expect((await f.settle("commit")).status).toBe(204);
    expect(f.pairs[0]?.[0].received).toEqual(frames);
  } finally {
    await f.close();
  }
});

test("legacy text keeps prior leading BOM handling on the original owner", async () => {
  const f = pendingFixture(["\uFEFFhello"], undefined, "legacy");
  try {
    await f.open();
    expect((await f.settle("commit")).status).toBe(204);
    expect(f.pairs[0]?.[0].received).toEqual(["hello"]);
  } finally {
    await f.close();
  }
});

test("pending boundary accepts 256 empty frames in original order after reconstruction", async () => {
  const frames = Array.from({ length: 256 }, () => "");
  const f = pendingFixture(frames);
  try {
    await f.open();
    f.reconstruct();
    expect((await f.settle("commit")).status).toBe(204);
    expect(f.pairs[0]?.[0].received).toEqual(frames);
  } finally {
    await f.close();
  }
});

test("pending boundary refuses bytes above the existing 32 MiB queue limit", async () => {
  const f = pendingFixture([new Uint8Array(33_554_432), Uint8Array.of(1)]);
  try {
    await expect(f.open()).rejects.toThrow("transport_overloaded");
    expect(f.values.size).toBe(0);
    expect(f.pairs).toEqual([]);
  } finally {
    await f.close();
  }
});

test("pending boundary partial descriptor write cleans chunks before any native head escapes", async () => {
  const f = pendingFixture([new Uint8Array(131_073)], "descriptor-write");
  try {
    await expect(f.open()).rejects.toThrow("KV descriptor write failed");
    expect(f.pairs[0]?.[0].received).toEqual([]);
    expect(f.pairs[0]?.[0].closed).toBe(true);
    expect(f.values.size).toBe(0);
    expect(f.sql.exec("SELECT COUNT(*) AS n FROM actor_socket_reservations")).toEqual([{ n: 0 }]);
  } finally {
    await f.close();
  }
});

test("pending boundary orphan chunks stay within existing paged attachment retirement", async () => {
  const f = pendingFixture(["greeting"]);
  try {
    await f.open();
    expect((await f.settle("commit")).status).toBe(204);
    const originalKey = [...f.values.keys()][0];
    if (!originalKey) throw new Error("original attachment custody unavailable");
    // Interrupted cleanup can leave private prefix members, but no live
    // reservation or native socket may be inferred from these orphan bytes.
    for (let index = 0; index < 33; index++)
      f.values.set(`${originalKey}:pending:${index}`, Uint8Array.of(index));
    expect(await f.retire()).toEqual({ deleted: 32, complete: false });
    expect(await f.retire()).toEqual({ deleted: 2, complete: true });
    expect(f.values.size).toBe(0);
  } finally {
    await f.close();
  }
});

for (const remaining of [0, 1] as const)
  test(`pending graph-read expiry boundary with ${remaining}ms remaining`, async () => {
    let now = Date.now();
    const f = pendingFixture(["original-greeting"], undefined, "v2", () => now);
    let release: (() => void) | undefined;
    try {
      await f.open();
      const row = f.sql.exec("SELECT expires_at AS expiresAt FROM actor_socket_reservations")[0];
      if (typeof row?.expiresAt !== "number") throw new Error("original reservation unavailable");
      expect(row.expiresAt - now).toBe(30_000);
      f.reconstruct();
      const held = f.holdNextGraphRead();
      release = held.release;
      const commit = f.settle("commit");
      await held.entered;
      expect(f.pairs[0]?.[0].received).toEqual([]);
      now = row.expiresAt - remaining;
      held.release();
      expect((await commit).status).toBe(remaining === 0 ? 404 : 204);
      expect(f.pairs[0]?.[0].received).toEqual(remaining === 0 ? [] : ["original-greeting"]);
      expect(f.pairs[0]?.[0].closed).toBe(remaining === 0);
      expect(f.values.size).toBe(remaining === 0 ? 0 : 1);
      expect(f.sql.exec("SELECT COUNT(*) AS n FROM actor_socket_reservations")).toEqual([{ n: 0 }]);
      f.reconstruct();
      expect((await f.settle("commit")).status).toBe(404);
      expect(f.pairs[0]?.[0].received).toEqual(remaining === 0 ? [] : ["original-greeting"]);
      expect(f.facetCalls).toBe(1);
    } finally {
      release?.();
      await f.close();
    }
  });
