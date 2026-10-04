import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type ActorAbiProfile, resolveActorAbiProfile } from "../src/actor-class-execution.ts";
import {
  createActorNativeAlarmPort,
  createActorNativeIngress,
  createActorNativeOwner,
  createActorNativeSocketPort,
  signActorNativeUpgradeDecision,
} from "../src/actor-native-owner-worker.ts";

const v2Profile = resolveActorAbiProfile({
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.actor",
  version: "2.0.0",
  schemaDigest: "sha256:f4d70bb6d63c436e43b2e6cc50069fa6ed68eca68aea2fbc10a77969738db156",
});

function inboundFixture(
  callback?: (request: Request) => Promise<Response>,
  admissionFetch?: (request: Request) => Promise<Response>,
  profile?: ActorAbiProfile,
) {
  type Socket = Parameters<
    InstanceType<ReturnType<typeof createActorNativeOwner>>["webSocketMessage"]
  >[0];
  const sockets: Socket[] = [];
  const closes: [string, number | undefined][] = [];
  const delivered: string[] = [];
  const retained: Promise<unknown>[] = [];
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const Owner = createActorNativeOwner(
    "a".repeat(64),
    "c".repeat(64),
    {
      generationKey: "d".repeat(64),
      epoch: "epoch-1",
      variantKeys: ["default"],
    },
    undefined,
    undefined,
    undefined,
    profile,
  );
  const owner = new Owner(
    {
      facets: {
        get: () => ({
          async fetch(request) {
            if (!request.headers.has("x-takoserver-private-actor-socket-action"))
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    producer = controller;
                  },
                }),
              );
            delivered.push(
              request.headers.get("x-takoserver-private-actor-socket-id") ?? "missing",
            );
            return callback ? callback(request) : new Response(null, { status: 204 });
          },
        }),
        abort() {},
      },
      getWebSockets: () => sockets,
      waitUntil: (promise) => {
        retained.push(promise);
      },
    },
    {
      CLASS: {},
      CLASS_0: {},
      ADMISSION: {
        async fetch(request) {
          if (admissionFetch) return admissionFetch(request);
          const body = (await request.json()) as Record<string, unknown>;
          return body.action === "socket-complete"
            ? new Response(null, { status: 204 })
            : Response.json({
                id: "inbound-owner",
                attemptNonce: body.attemptNonce,
                generationKey: "d".repeat(64),
                epoch: "epoch-1",
                variantKey: "default",
                leaseId: "lease",
              });
        },
      },
    },
  );
  return {
    owner,
    closes,
    delivered,
    retained,
    forgetNativeSocket(socket: Socket) {
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    },
    cachedSocketIds() {
      return [...(owner as unknown as { sockets: Map<string, unknown> }).sockets.keys()];
    },
    accounting() {
      const state = owner as unknown as {
        inboundCount: number;
        inboundBytes: number;
        socketBatch?: Set<unknown>;
        inbound: Map<unknown, unknown>;
      };
      return {
        count: state.inboundCount,
        bytes: state.inboundBytes,
        queued: state.socketBatch?.size ?? 0,
        connections: state.inbound.size,
      };
    },
    socket(id: string) {
      const socket = {
        deserializeAttachment: () => ({ socketId: id, actorId: "inbound-owner", attachment: null }),
        serializeAttachment(_value: unknown) {},
        send(_value: string | ArrayBuffer) {},
        close(code?: number) {
          closes.push([id, code]);
        },
      } as Socket;
      sockets.push(socket);
      return socket;
    },
    async holdProducer() {
      const response = await owner.fetch(
        new Request("http://actor.invalid/", {
          headers: {
            "x-takoserver-private-actor-id": "inbound-owner",
            "x-takoserver-private-actor-variant": "default",
          },
        }),
      );
      return async () => {
        producer.close();
        await response.text();
      };
    },
  };
}

test("v2 socket error is a distinct terminal callback", async () => {
  const actions: string[] = [];
  const f = inboundFixture(
    async (request) => {
      actions.push(request.headers.get("x-takoserver-private-actor-socket-action") ?? "missing");
      expect(await request.json()).toEqual({ code: "transport_error" });
      return new Response(null, { status: 204 });
    },
    undefined,
    v2Profile,
  );
  const socket = f.socket("error-socket");
  await f.owner.webSocketError(socket);
  await f.owner.webSocketClose(socket, 1006, "late close", false);
  expect(actions).toEqual(["callback-error"]);
  expect(f.cachedSocketIds()).toEqual([]);
  expect(f.accounting().count).toBe(0);
});

for (const terminal of ["error", "close"] as const)
  for (const cache of ["warm", "cold"] as const)
    test(`v2 ${cache} ${terminal} callback hides connection but can read attachment until settlement`, async () => {
      const observations: unknown[] = [];
      let f!: ReturnType<typeof inboundFixture>;
      f = inboundFixture(
        async (request) => {
          const nonce = request.headers.get("x-takoserver-private-actor-socket-nonce") as string;
          const control = (action: string, socketId?: string, body?: Uint8Array) =>
            f.owner.fetch(
              new Request("http://actor.invalid/", {
                method: "POST",
                headers: {
                  "x-takoserver-private-actor-id": "inbound-owner",
                  "x-takoserver-private-actor-socket-action": action,
                  "x-takoserver-private-actor-abi": v2Profile.schemaDigest,
                  "x-takoserver-private-actor-socket-nonce": nonce,
                  ...(socketId ? { "x-takoserver-private-actor-socket-id": socketId } : {}),
                  ...(body ? { "x-takoserver-private-actor-socket-kind": "binary" } : {}),
                },
                ...(body ? { body: body.slice().buffer as ArrayBuffer } : {}),
              }),
            );
          observations.push(await (await control("list")).json());
          observations.push(await (await control("get", "terminal")).json());
          observations.push((await control("send", "terminal", new Uint8Array([1]))).status);
          observations.push((await control("close", "terminal")).status);
          observations.push(
            (await control("set-attachment", "terminal", new Uint8Array([2]))).status,
          );
          observations.push(
            new Uint8Array(await (await control("get-attachment", "terminal")).arrayBuffer()),
          );
          return new Response(null, { status: 204 });
        },
        undefined,
        v2Profile,
      );
      const socket = f.socket("terminal");
      if (cache === "warm") {
        const record = {
          socketId: "terminal",
          actorId: "inbound-owner",
          nonce: "",
          protocol: "",
          attachment: new Uint8Array([7]),
          queued: [],
          queuedBytes: 0,
          status: "live",
          socket,
        };
        (f.owner as unknown as { sockets: Map<string, unknown> }).sockets.set("terminal", record);
      } else f.forgetNativeSocket(socket);
      if (terminal === "error") await f.owner.webSocketError(socket);
      else await f.owner.webSocketClose(socket, 1000, "done", true);
      expect(observations).toEqual([
        [],
        { exists: false },
        404,
        404,
        404,
        new Uint8Array(cache === "warm" ? [7] : []),
      ]);
      expect(f.cachedSocketIds()).toEqual([]);
    });

test("v2 provisional queues are per connection, and live backlog is bounded", async () => {
  const f = inboundFixture(undefined, undefined, v2Profile);
  const state = f.owner as unknown as {
    activeSocketInvocation?: { actorId: string; nonce: string; kind: "fetch"; accepting: boolean };
    sockets: Map<
      string,
      {
        socketId?: string;
        actorId: string;
        nonce: string;
        status: string;
        queued: Uint8Array[];
        queuedBytes: number;
        socket?: { send(value: Uint8Array): void };
      }
    >;
  };
  state.activeSocketInvocation = {
    actorId: "inbound-owner",
    nonce: "n",
    kind: "fetch",
    accepting: true,
  };
  const send = (id: string, bytes: number, digest = v2Profile.schemaDigest) =>
    f.owner.fetch(
      new Request("http://actor.invalid/", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-id": "inbound-owner",
          "x-takoserver-private-actor-socket-action": "send",
          "x-takoserver-private-actor-abi": digest,
          "x-takoserver-private-actor-socket-nonce": "n",
          "x-takoserver-private-actor-socket-id": id,
          "x-takoserver-private-actor-socket-kind": "binary",
        },
        body: new Uint8Array(bytes).buffer as ArrayBuffer,
      }),
    );
  for (const id of ["a", "b", "c"])
    state.sockets.set(id, {
      actorId: "inbound-owner",
      nonce: "n",
      status: "provisional",
      queued: [],
      queuedBytes: 30 * 1024 * 1024,
    });
  expect((await send("c", 1)).status).toBe(204);
  expect(
    (await send("c", 1, "sha256:f5428fb587de80261dd7363dc5b8a3f4aab7e469fa1b5fce8441ad9acbec8218"))
      .status,
  ).toBe(409);
  expect(state.sockets.get("c")?.queuedBytes).toBe(30 * 1024 * 1024 + 1);
  expect((await send("c", 2 * 1024 * 1024 + 1)).status).toBe(429);
  expect(state.sockets.get("c")?.queuedBytes).toBe(30 * 1024 * 1024 + 1);
  const sent: number[] = [];
  state.sockets.set("live", {
    socketId: "live",
    actorId: "inbound-owner",
    nonce: "n",
    status: "live",
    queued: [],
    queuedBytes: 33_554_431,
    socket: {
      send(value) {
        sent.push(value.byteLength);
        expect(state.sockets.get("live")?.queuedBytes).toBe(2);
      },
    },
  });
  expect((await send("live", 2)).status).toBe(429);
  expect(sent).toEqual([]);
  const live = state.sockets.get("live");
  if (!live) throw new Error("live socket missing");
  live.queuedBytes = 0;
  expect((await send("live", 2)).status).toBe(204);
  expect(sent).toEqual([2]);
  expect(state.sockets.get("live")?.queuedBytes).toBe(0);
  live.socket = {
    send() {
      throw new Error("transport failed");
    },
  };
  await expect(send("live", 3)).rejects.toThrow("transport failed");
  expect(state.sockets.get("live")?.queuedBytes).toBe(0);
  for (const id of ["z", "d"])
    state.sockets.set(id, {
      socketId: id,
      actorId: "inbound-owner",
      nonce: "n",
      status: "live",
      queued: [],
      queuedBytes: 0,
      socket: { send() {} },
    });
  const port = createActorNativeSocketPort(
    { fetch: (request) => f.owner.fetch(request) },
    undefined,
    "inbound-owner",
    "n",
    v2Profile,
  );
  expect(await port.list()).toEqual(["d", "live", "z"]);
  const legacy = inboundFixture();
  (legacy.owner as unknown as { activeSocketInvocation: unknown }).activeSocketInvocation = {
    actorId: "inbound-owner",
    nonce: "n",
    kind: "fetch",
    accepting: true,
  };
  expect(
    (
      await legacy.owner.fetch(
        new Request("http://actor.invalid/", {
          method: "POST",
          headers: {
            "x-takoserver-private-actor-id": "inbound-owner",
            "x-takoserver-private-actor-socket-action": "get",
            "x-takoserver-private-actor-socket-nonce": "n",
            "x-takoserver-private-actor-abi": v2Profile.schemaDigest,
          },
        }),
      )
    ).status,
  ).toBe(409);
});

function hostSocketGrants() {
  const active = new Set<string>();
  const completed: string[] = [];
  const grants = new Map<string, string>();
  const settled = new Set<string>();
  return {
    active,
    completed,
    grant(nonce: string, leaseId: string) {
      if (settled.has(nonce)) {
        completed.push(leaseId); // a late Host grant observes the completed attempt
        return;
      }
      grants.set(nonce, leaseId);
      active.add(leaseId);
    },
    complete(nonce: string) {
      if (settled.has(nonce)) return;
      settled.add(nonce);
      const leaseId = grants.get(nonce);
      if (!leaseId) return;
      grants.delete(nonce);
      active.delete(leaseId);
      completed.push(leaseId);
    },
  };
}

for (const failure of ["lost", "malformed", "stale", "late"] as const) {
  test(`native socket admission completes a Host grant after a ${failure} reply`, async () => {
    const host = hostSocketGrants();
    const otherNonce = crypto.randomUUID();
    host.grant(otherNonce, "other-lease");
    let attemptedNonce = "";
    let callbacks = 0;
    let lateGrant: (() => void) | undefined;
    const f = inboundFixture(
      async () => {
        callbacks += 1;
        return new Response(null, { status: 204 });
      },
      async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.action === "socket-complete") {
          host.complete(body.attemptNonce as string);
          return new Response(null, { status: 204 });
        }
        attemptedNonce = body.attemptNonce as string;
        if (failure === "late") lateGrant = () => host.grant(attemptedNonce, "attempt-lease");
        else host.grant(attemptedNonce, "attempt-lease");
        if (failure === "lost") throw new Error("reply lost after grant");
        if (failure === "late") throw new Error("reply lost before Host grant settles");
        if (failure === "malformed") return Response.json({ invalid: true });
        return Response.json({
          id: body.id,
          attemptNonce: body.attemptNonce,
          generationKey: "d".repeat(64),
          epoch: "stale-epoch",
          variantKey: "default",
          leaseId: "attempt-lease",
        });
      },
    );
    await f.owner.webSocketMessage(f.socket("failed-admission"), "event");
    lateGrant?.();
    expect(attemptedNonce).toMatch(/^[0-9a-f-]{36}$/u);
    expect(callbacks).toBe(0);
    expect(host.completed).toEqual(["attempt-lease"]);
    expect(host.active).toEqual(new Set(["other-lease"]));
    expect(f.closes).toEqual([["failed-admission", 1011]]);
    host.complete(attemptedNonce); // replay is inert
    expect(host.active).toEqual(new Set(["other-lease"]));
    host.complete(otherNonce);
    expect(host.active.size).toBe(0); // retirement can drain after exact completion
    await Promise.all(f.retained);
  });
}

test("native socket grant stays active until its admitted callback settles", async () => {
  const host = hostSocketGrants();
  let release!: () => void;
  let started!: () => void;
  const callbackStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const callbackDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = inboundFixture(
    async () => {
      started();
      await callbackDone;
      return new Response(null, { status: 204 });
    },
    async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.action === "socket-complete") {
        host.complete(body.attemptNonce as string);
        return new Response(null, { status: 204 });
      }
      host.grant(body.attemptNonce as string, "callback-lease");
      return Response.json({
        id: body.id,
        attemptNonce: body.attemptNonce,
        generationKey: "d".repeat(64),
        epoch: "epoch-1",
        variantKey: "default",
        leaseId: "callback-lease",
      });
    },
  );
  const event = f.owner.webSocketMessage(f.socket("in-flight"), "event");
  await callbackStarted;
  expect(host.active).toEqual(new Set(["callback-lease"]));
  release();
  await event;
  expect(host.active.size).toBe(0);
  await Promise.all(f.retained);
});

test("native inbound count overflow discards zero-length backlog while HTTP producer holds the ID", async () => {
  const f = inboundFixture();
  const offender = f.socket("offender");
  const survivor = f.socket("survivor");
  const drain = await f.holdProducer();
  const pending = Array.from({ length: 65 }, () => f.owner.webSocketMessage(offender, ""));
  const next = f.owner.webSocketMessage(survivor, "next");
  const observedClose = [...f.closes];
  expect(f.delivered).toEqual([]);
  await drain();
  await Promise.all([...pending, next, ...f.retained]);
  expect(observedClose).toEqual([["offender", 1013]]);
  expect(f.delivered).toEqual(["survivor"]);
});

test("native inbound byte overflow counts UTF-8 and releases discarded bytes before drain", async () => {
  const f = inboundFixture();
  const offender = f.socket("offender");
  const survivor = f.socket("survivor");
  const drain = await f.holdProducer();
  const pending = [
    f.owner.webSocketMessage(offender, "あ".repeat(2 * 1024 * 1024)),
    f.owner.webSocketMessage(offender, new ArrayBuffer(3 * 1024 * 1024)),
  ];
  const next = f.owner.webSocketMessage(survivor, new ArrayBuffer(8 * 1024 * 1024));
  const observedClose = [...f.closes];
  await drain();
  await Promise.all([...pending, next, ...f.retained]);
  expect(observedClose).toEqual([["offender", 1013]]);
  expect(f.delivered).toEqual(["survivor"]);
  expect(f.accounting()).toEqual({ count: 0, bytes: 0, queued: 0, connections: 0 });
});

test("native inbound actor count ceiling spans connections and repeated overflow retains no tombstones", async () => {
  const f = inboundFixture();
  const drain = await f.holdProducer();
  const pending: Promise<void>[] = [];
  for (let connection = 0; connection < 4; connection++) {
    const socket = f.socket(`survivor-${connection}`);
    for (let message = 0; message < 64; message++)
      pending.push(f.owner.webSocketMessage(socket, ""));
  }
  for (let connection = 0; connection < 100; connection++) {
    const socket = f.socket(`offender-${connection}`);
    pending.push(f.owner.webSocketMessage(socket, ""));
  }
  expect(f.accounting()).toEqual({ count: 256, bytes: 0, queued: 256, connections: 4 });
  expect(f.closes).toHaveLength(100);
  expect(f.closes.every(([, code]) => code === 1013)).toBe(true);
  expect(f.retained).toHaveLength(2); // Held HTTP turn and one removable socket batch.
  await drain();
  await Promise.all(pending);
  expect(f.delivered).toHaveLength(256);
  expect(f.accounting()).toEqual({ count: 0, bytes: 0, queued: 0, connections: 0 });
});

test("native inbound actor bytes ceiling spans connections without failing already queued peers", async () => {
  const f = inboundFixture();
  const drain = await f.holdProducer();
  const pending = ["first", "second"].map((id) =>
    f.owner.webSocketMessage(f.socket(id), new ArrayBuffer(8 * 1024 * 1024)),
  );
  const offender = f.socket("offender");
  pending.push(f.owner.webSocketMessage(offender, "x"));
  expect(f.closes).toEqual([["offender", 1013]]);
  expect(f.accounting().bytes).toBe(16 * 1024 * 1024);
  await drain();
  await Promise.all(pending);
  expect(f.delivered).toEqual(["first", "second"]);
  expect(f.accounting().bytes).toBe(0);
});

test("native inbound overloaded close retires a warm socket cache without dropping peer events", async () => {
  const f = inboundFixture();
  const warm = f.socket("warm");
  await f.owner.webSocketMessage(warm, "warm cache");
  expect(f.cachedSocketIds()).toContain("warm");
  const drain = await f.holdProducer();
  const pending: Promise<void>[] = [];
  for (let connection = 0; connection < 4; connection++) {
    const peer = f.socket(`peer-${connection}`);
    for (let message = 0; message < 64; message++) pending.push(f.owner.webSocketMessage(peer, ""));
  }
  f.forgetNativeSocket(warm);
  await f.owner.webSocketClose(warm, 1000, "done", true);
  await drain();
  await Promise.all(pending);
  await f.owner.webSocketClose(warm, 1000, "duplicate", true);
  expect(f.cachedSocketIds()).not.toContain("warm");
  expect(f.delivered.filter((id) => id === "warm")).toHaveLength(1);
  expect(f.delivered).toHaveLength(257);
  expect(f.accounting()).toEqual({ count: 0, bytes: 0, queued: 0, connections: 0 });
});

test("native inbound terminal overload retires the cache but retains an active callback charge", async () => {
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = inboundFixture(async () => {
    started();
    await held;
    return new Response(null, { status: 204 });
  });
  const socket = f.socket("active");
  const active = f.owner.webSocketMessage(socket, new ArrayBuffer(8 * 1024 * 1024));
  await entered;
  expect(f.cachedSocketIds()).toContain("active");
  f.forgetNativeSocket(socket);
  await f.owner.webSocketClose(socket, 1000, "done", true);
  expect(f.cachedSocketIds()).not.toContain("active");
  expect(f.accounting()).toEqual({ count: 1, bytes: 8 * 1024 * 1024, queued: 0, connections: 1 });
  release();
  await active;
  expect(f.accounting()).toEqual({ count: 0, bytes: 0, queued: 0, connections: 0 });
});

test("native inbound active callback remains charged and failure drops its queued messages", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = inboundFixture(async (request) => {
    if (request.headers.get("x-takoserver-private-actor-socket-id") === "offender") {
      started();
      await held;
      throw new Error("callback failed");
    }
    return new Response(null, { status: 204 });
  });
  const offender = f.socket("offender");
  const active = f.owner.webSocketMessage(offender, new ArrayBuffer(8 * 1024 * 1024));
  await entered;
  await f.owner.webSocketMessage(offender, "overflow");
  expect(f.closes).toEqual([["offender", 1013]]);
  expect(f.accounting()).toEqual({ count: 1, bytes: 8 * 1024 * 1024, queued: 0, connections: 1 });
  const survivor = f.owner.webSocketMessage(f.socket("survivor"), "next");
  release();
  await Promise.all([active, survivor]);
  expect(f.delivered).toEqual(["offender", "survivor"]);
  expect(f.closes).toEqual([["offender", 1013]]);
  expect(f.accounting()).toEqual({ count: 0, bytes: 0, queued: 0, connections: 0 });
});

test("native inbound callback failure discards undelivered payloads and admits a healthy connection", async () => {
  const f = inboundFixture(async (request) => {
    if (request.headers.get("x-takoserver-private-actor-socket-id") === "offender")
      throw new Error("failed");
    return new Response(null, { status: 204 });
  });
  const offender = f.socket("offender");
  const pending = [
    f.owner.webSocketMessage(offender, "first"),
    f.owner.webSocketMessage(offender, "discarded"),
    f.owner.webSocketMessage(f.socket("survivor"), "next"),
  ];
  await Promise.all(pending);
  expect(f.delivered).toEqual(["offender", "survivor"]);
  expect(f.closes).toEqual([["offender", 1011]]);
  expect(f.accounting()).toEqual({ count: 0, bytes: 0, queued: 0, connections: 0 });
});

test("native inbound close preserves preceding messages, deduplicates callbacks and releases counters", async () => {
  const f = inboundFixture();
  const socket = f.socket("socket");
  const drain = await f.holdProducer();
  const pending = [
    f.owner.webSocketMessage(socket, "before"),
    f.owner.webSocketClose(socket, 1000, "done", true),
    f.owner.webSocketClose(socket, 1000, "duplicate", true),
    f.owner.webSocketMessage(socket, "after"),
  ];
  await drain();
  await Promise.all(pending);
  expect(f.delivered).toEqual(["socket", "socket"]);
  expect(f.accounting()).toEqual({ count: 0, bytes: 0, queued: 0, connections: 0 });
});

test("native inbound oversize remains 1009 and unknown native close still receives one callback", async () => {
  const f = inboundFixture();
  const socket = f.socket("oversize");
  await f.owner.webSocketMessage(socket, new ArrayBuffer(8 * 1024 * 1024 + 1));
  await f.owner.webSocketMessage(socket, "ignored");
  expect(f.closes).toEqual([["oversize", 1009]]);
  expect(f.delivered).toEqual([]);
  const unknown = {
    deserializeAttachment: () => ({
      socketId: "unknown",
      actorId: "inbound-owner",
      attachment: null,
    }),
    close() {},
  } as Parameters<typeof f.owner.webSocketClose>[0];
  await f.owner.webSocketClose(unknown, 1000, "native closed", true);
  await f.owner.webSocketClose(unknown, 1000, "duplicate", true);
  expect(f.delivered).toEqual(["unknown"]);
});

test("v2 native inbound accepts beyond legacy frame size and enforces 32 MiB", async () => {
  const f = inboundFixture(undefined, undefined, v2Profile);
  const drain = await f.holdProducer();
  const accepted = f.owner.webSocketMessage(f.socket("accepted"), new ArrayBuffer(8_388_609));
  expect(f.accounting().bytes).toBe(8_388_609);
  const oversize = f.socket("oversize");
  await f.owner.webSocketMessage(oversize, new ArrayBuffer(33_554_433));
  expect(f.closes).toEqual([["oversize", 1009]]);
  await drain();
  await accepted;
  expect(f.accounting().bytes).toBe(0);
});

test("native inbound batches do not overtake an intervening whole HTTP producer turn", async () => {
  const f = inboundFixture();
  const drain = await f.holdProducer();
  const first = f.owner.webSocketMessage(f.socket("first"), "one");
  const secondProducer = f.holdProducer();
  const second = f.owner.webSocketMessage(f.socket("second"), "two");
  await drain();
  const drainSecond = await secondProducer;
  await first;
  expect(f.delivered).toEqual(["first"]);
  await drainSecond();
  await second;
  expect(f.delivered).toEqual(["first", "second"]);
});

function fixture(fetch: (request: Request) => Promise<Response>) {
  const retained: Promise<unknown>[] = [];
  const Owner = createActorNativeOwner("a".repeat(64), "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["default"],
  });
  const owner = new Owner(
    {
      facets: {
        get: (_name, create) => {
          expect(create().id).toBe("id/日本語");
          return { fetch };
        },
        abort() {},
      },
      waitUntil: (promise) => {
        retained.push(promise);
      },
    },
    { CLASS: {}, CLASS_0: {} },
  );
  const request = () =>
    new Request("http://actor.invalid/", {
      headers: {
        "x-takoserver-private-actor-id": encodeURIComponent("id/日本語"),
        "x-takoserver-private-actor-variant": "default",
      },
    });
  return { owner, request, retained };
}

test("native per-ID owner releases failed head and strips private identity before application dispatch", async () => {
  let calls = 0;
  const f = fixture(async (request) => {
    expect(request.headers.has("x-takoserver-private-actor-id")).toBe(false);
    if (calls++ === 0) throw new Error("application failed");
    return new Response("next");
  });
  await expect(f.owner.fetch(f.request())).rejects.toThrow("application failed");
  expect(await (await f.owner.fetch(f.request())).text()).toBe("next");
  await Promise.all(f.retained);
});

test("native owner loads an exact selected class through a Host-only async loader", async () => {
  const seen: string[] = [];
  const selected = Object.freeze({ marker: "selected-class" });
  const Owner = createActorNativeOwner(
    "a".repeat(64),
    "c".repeat(64),
    { generationKey: "d".repeat(64), epoch: "epoch-1", variantKeys: ["selected"] },
    undefined,
    async (_env, variantKey) => {
      seen.push(variantKey);
      return selected;
    },
  );
  const owner = new Owner(
    {
      facets: {
        get: (_name, create) => {
          expect(create().class).toBe(selected);
          return { fetch: async () => new Response("loaded") };
        },
        abort() {},
      },
      waitUntil() {},
    },
    { CLASS: {} },
  );
  const response = await owner.fetch(
    new Request("http://actor.invalid/", {
      headers: {
        "x-takoserver-private-actor-id": "loaded-id",
        "x-takoserver-private-actor-variant": "selected",
      },
    }),
  );
  expect(await response.text()).toBe("loaded");
  expect(seen).toEqual(["selected"]);
});

test("structural facet lane overwrites a forged event secret before child dispatch", async () => {
  let captured = "";
  const Owner = createActorNativeOwner(undefined, "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["selected"],
  });
  const owner = new Owner(
    {
      facets: {
        get: () => ({
          async fetch(request) {
            captured = request.headers.get("x-takoserver-private-actor-event-secret") ?? "";
            return new Response("ordinary");
          },
        }),
        abort() {},
      },
      waitUntil() {},
    },
    { CLASS: {}, CLASS_0: {} },
  );
  const response = await owner.fetch(
    new Request("http://actor.invalid/", {
      headers: {
        "x-takoserver-private-actor-id": "loaded-id",
        "x-takoserver-private-actor-variant": "selected",
        "x-takoserver-private-actor-event-secret": "attacker-chosen",
      },
    }),
  );
  expect(await response.text()).toBe("ordinary");
  expect(captured).toMatch(/^[a-f0-9]{64}$/u);
  expect(captured).not.toBe("attacker-chosen");
});

test("dynamic owner graph rejects a rollout between selection and child dispatch", async () => {
  let epoch = "epoch-1";
  let rollOnLoad = true;
  let childCalls = 0;
  const selections: unknown[] = [];
  const Owner = createActorNativeOwner(
    undefined,
    "c".repeat(64),
    undefined,
    undefined,
    async (_env, key, selection) => {
      selections.push({ key, selection });
      if (rollOnLoad) {
        epoch = "epoch-2";
        rollOnLoad = false;
      }
      return {};
    },
    async () => ({
      generationKey: "d".repeat(64),
      epoch,
      variantKeys: ["selected"],
    }),
  );
  const owner = new Owner(
    {
      facets: {
        get: () => ({
          async fetch() {
            childCalls += 1;
            return new Response("selected");
          },
        }),
        abort() {},
      },
      waitUntil() {},
    },
    { CLASS: {} },
  );
  const request = () =>
    new Request("http://actor.invalid/", {
      headers: {
        "x-takoserver-private-actor-id": "loaded-id",
        "x-takoserver-private-actor-variant": "selected",
      },
    });
  await expect(owner.fetch(request())).rejects.toThrow("Actor graph changed before dispatch");
  expect(childCalls).toBe(0);
  expect(await (await owner.fetch(request())).text()).toBe("selected");
  expect(childCalls).toBe(1);
  expect(selections).toEqual([
    {
      key: "selected",
      selection: {
        actorId: "loaded-id",
        generationKey: "d".repeat(64),
        epoch: "epoch-1",
      },
    },
    {
      key: "selected",
      selection: {
        actorId: "loaded-id",
        generationKey: "d".repeat(64),
        epoch: "epoch-2",
      },
    },
  ]);
  expect(Object.isFrozen((selections[0] as { selection: object }).selection)).toBe(true);
});

for (const [cause, epoch, variantKeys] of [
  ["deployment replacement", "replacement-epoch", ["selected"]],
  ["selected target revocation", "original-epoch", ["other"]],
] as const)
  test(`pending socket commit is abandoned after ${cause}`, async () => {
    const database = new Database(":memory:");
    const sql = {
      exec(statement: string, ...params: (string | number | null)[]) {
        if (statement.startsWith("SELECT"))
          return database.query(statement).all(...params) as Record<string, unknown>[];
        database.query(statement).run(...params);
        return [];
      },
    };
    const Owner = createActorNativeOwner(
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({}),
      async () => ({
        generationKey: "d".repeat(64),
        epoch,
        variantKeys,
      }),
    );
    let closed = false;
    const owner = new Owner(
      {
        facets: { get: () => ({ fetch: async () => new Response() }), abort() {} },
        storage: { sql, setAlarm() {}, deleteAlarm() {} },
        waitUntil() {},
      },
      { CLASS: {} },
    );
    const actorId = "pending-actor";
    const socketId = "pending-socket";
    const bearer = "b".repeat(64);
    const expiresAt = Date.now() + 30_000;
    sql.exec(
      "INSERT INTO actor_socket_reservations (socket_id, actor_id, bearer, expires_at) VALUES (?, ?, ?, ?)",
      socketId,
      actorId,
      bearer,
      expiresAt,
    );
    const sockets = (owner as unknown as { sockets: Map<string, unknown> }).sockets;
    sockets.set(socketId, {
      socketId,
      actorId,
      nonce: "",
      protocol: "",
      attachment: null,
      queued: [],
      queuedBytes: 0,
      status: "transport-pending",
      reservationBearer: bearer,
      reservationExpiresAt: expiresAt,
      reservationGenerationKey: "d".repeat(64),
      reservationEpoch: "original-epoch",
      reservationVariantKey: "selected",
      socket: {
        close() {
          closed = true;
        },
      },
    });
    const response = await owner.fetch(
      new Request("http://actor.invalid/", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-id": encodeURIComponent(actorId),
          "x-takoserver-private-actor-reservation": bearer,
          "x-takoserver-private-actor-reservation-action": "commit",
        },
      }),
    );
    expect(response.status).toBe(404);
    expect(closed).toBe(true);
    expect(sockets.has(socketId)).toBe(false);
    expect(sql.exec("SELECT socket_id FROM actor_socket_reservations")).toEqual([]);
    database.close();
  });

test("structural WfP owner omits admission and control bearers only in dynamic mode", async () => {
  const graph = { generationKey: "d".repeat(64), epoch: "epoch-1", variantKeys: ["selected"] };
  expect(() => createActorNativeOwner("a".repeat(64), undefined, graph)).toThrow();
  const controlRequests: Request[] = [];
  const controlService = {
    async fetch(request: Request): Promise<Response> {
      controlRequests.push(request);
      expect(request.headers.has("x-takoserver-private-actor-token")).toBe(false);
      if (request.headers.has("x-takoserver-private-alarm-action"))
        return Response.json({ at: null });
      return new Response(null, { status: 204 });
    },
  };
  expect(await createActorNativeAlarmPort(controlService, undefined, "id").get()).toBeNull();
  await createActorNativeSocketPort(controlService, undefined, "id", crypto.randomUUID()).send(
    "socket-1",
    "message",
  );
  expect(controlRequests).toHaveLength(2);

  const actorId = "structural-id";
  const socket = {
    deserializeAttachment: () => ({ socketId: "socket-1", actorId, attachment: null }),
    serializeAttachment() {},
    send() {},
    close() {},
  } as unknown as Parameters<
    InstanceType<ReturnType<typeof createActorNativeOwner>>["webSocketMessage"]
  >[0];
  const selectedClass = {};
  const Owner = createActorNativeOwner(
    undefined,
    undefined,
    undefined,
    undefined,
    async (_env, key, selection) => {
      expect(key).toBe("selected");
      expect(selection).toEqual({
        actorId,
        generationKey: graph.generationKey,
        epoch: graph.epoch,
      });
      return selectedClass;
    },
    async () => graph,
  );
  const owner = new Owner(
    {
      facets: {
        get(_name, create) {
          expect(create().class).toBe(selectedClass);
          return { fetch: async () => new Response(null, { status: 204 }) };
        },
        abort() {},
      },
      getWebSockets: () => [socket],
      waitUntil() {},
    },
    {
      CLASS: {},
      ADMISSION: {
        async fetch(request) {
          expect(request.headers.has("x-takoserver-private-alarm-admission")).toBe(false);
          const body = (await request.json()) as Record<string, unknown>;
          if (body.action === "socket-complete") return new Response(null, { status: 204 });
          return Response.json({
            id: actorId,
            attemptNonce: body.attemptNonce,
            generationKey: graph.generationKey,
            epoch: graph.epoch,
            variantKey: "selected",
            leaseId: "lease",
          });
        },
      },
    },
  );
  await owner.webSocketMessage(socket, "event");
});

test("native owner refuses an unreserved WebSocket 101 and still admits the next turn", async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (calls++ === 0) return { status: 101, body: null } as Response;
    return new Response("ordinary");
  });
  await expect(f.owner.fetch(f.request())).rejects.toThrow("Actor socket reservation unavailable");
  expect(await (await f.owner.fetch(f.request())).text()).toBe("ordinary");
  await Promise.all(f.retained);
});

test("native socket decision is invocation-bound and retires the child before attempting transport", async () => {
  const deliveryToken = "a".repeat(64);
  const secret = "b".repeat(64);
  const actorId = "socket/日本語";
  const encodedId = encodeURIComponent(actorId);
  const retained: Promise<unknown>[] = [];
  const order: string[] = [];
  const ingress = createActorNativeIngress("ordinary-token", secret);
  let owner!: InstanceType<ReturnType<typeof createActorNativeOwner>>;
  const service = {
    fetch(request: Request) {
      return ingress.fetch(request, {
        NAMESPACE: {
          idFromName: (name) => name,
          get: () => ({ fetch: (inner) => owner.fetch(inner) }),
        },
      });
    },
  };
  const Owner = createActorNativeOwner(deliveryToken, "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["default"],
  });
  owner = new Owner(
    {
      facets: {
        get: () => ({
          async fetch(request) {
            order.push("child");
            expect(request.headers.has("x-takoserver-private-actor-id")).toBe(false);
            const nonce = request.headers.get("x-takoserver-private-actor-upgrade-nonce");
            expect(nonce).toBeTruthy();
            const port = createActorNativeSocketPort(service, secret, actorId, nonce as string);
            const socketId = await port.accept("chat", new Uint8Array([1, 2]));
            expect(await port.get(socketId)).toBe(false);
            expect(await port.list()).toEqual([]);
            await port.send(socketId, "hello");
            await port.setAttachment(socketId, new Uint8Array([3, 4]));
            expect(await port.getAttachment(socketId)).toEqual(new Uint8Array([3, 4]));
            const decision = await signActorNativeUpgradeDecision(
              deliveryToken,
              nonce as string,
              encodedId,
              socketId,
              "chat",
            );
            return new Response(null, {
              status: 204,
              headers: {
                "x-takoserver-private-actor-upgrade-decision": decision,
                "x-takoserver-private-actor-upgrade-socket-id": socketId,
                "sec-websocket-protocol": "chat",
              },
            });
          },
        }),
        abort() {
          order.push("retire");
        },
      },
      waitUntil(promise) {
        retained.push(promise);
      },
    },
    { CLASS: {}, CLASS_0: {} },
  );
  await expect(
    owner.fetch(
      new Request("http://actor.invalid/", {
        headers: {
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-variant": "default",
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "sec-websocket-protocol": "chat",
        },
      }),
    ),
  ).rejects.toThrow("Actor socket transport unavailable");
  expect(order).toEqual(["child", "retire"]);
  await Promise.all(retained);
});

test("native owner abandons a provisional socket when the facet returns an ordinary response", async () => {
  const secret = "b".repeat(64);
  const actorId = "abandoned";
  const ingress = createActorNativeIngress("ordinary-token", secret);
  let owner!: InstanceType<ReturnType<typeof createActorNativeOwner>>;
  let socketId = "";
  const service = {
    fetch(request: Request) {
      return ingress.fetch(request, {
        NAMESPACE: {
          idFromName: (name) => name,
          get: () => ({ fetch: (inner) => owner.fetch(inner) }),
        },
      });
    },
  };
  const Owner = createActorNativeOwner("a".repeat(64), "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["default"],
  });
  owner = new Owner(
    {
      facets: {
        get: () => ({
          async fetch(request) {
            const nonce = request.headers.get("x-takoserver-private-actor-upgrade-nonce");
            expect(nonce).toBeTruthy();
            const port = createActorNativeSocketPort(service, secret, actorId, nonce as string);
            socketId = await port.accept();
            await port.send(socketId, "not delivered");
            return new Response("ordinary", { status: 409 });
          },
        }),
        abort() {},
      },
      waitUntil() {},
    },
    { CLASS: {}, CLASS_0: {} },
  );
  const result = await owner.fetch(
    new Request("http://actor.invalid/", {
      headers: {
        "x-takoserver-private-actor-id": encodeURIComponent(actorId),
        "x-takoserver-private-actor-variant": "default",
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    }),
  );
  expect(result.status).toBe(409);
  expect(await result.text()).toBe("ordinary");
  expect(socketId).not.toBe("");
  expect((owner as unknown as { sockets: Map<string, unknown> }).sockets.size).toBe(0);
});

test("native owner rejects a copied or forged socket decision", async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (calls++ === 0)
      return new Response(null, {
        status: 204,
        headers: {
          "x-takoserver-private-actor-upgrade-decision": "0".repeat(64),
          "x-takoserver-private-actor-upgrade-socket-id": crypto.randomUUID(),
        },
      });
    return new Response("still available");
  });
  await expect(f.owner.fetch(f.request())).rejects.toThrow("Actor socket reservation unavailable");
  expect(await (await f.owner.fetch(f.request())).text()).toBe("still available");
  await Promise.all(f.retained);
});

test("private socket port preserves closed application error names", async () => {
  let status = 400;
  const port = createActorNativeSocketPort(
    {
      async fetch() {
        return new Response(null, { status });
      },
    },
    "b".repeat(64),
    "id",
    crypto.randomUUID(),
  );
  await expect(port.accept()).rejects.toMatchObject({
    name: "invalid_upgrade",
    code: "invalid_upgrade",
  });
  status = 429;
  await expect(port.accept()).rejects.toMatchObject({
    name: "socket_limit_exceeded",
    code: "socket_limit_exceeded",
  });
  await expect(port.send("socket", "message")).rejects.toMatchObject({
    name: "socket_overloaded",
    code: "socket_overloaded",
  });
  status = 413;
  await expect(port.send("socket", "message")).rejects.toMatchObject({
    name: "message_too_large",
    code: "message_too_large",
  });
  await expect(port.setAttachment("socket", new Uint8Array([1]))).rejects.toMatchObject({
    name: "attachment_too_large",
    code: "attachment_too_large",
  });
  status = 404;
  await expect(port.send("socket", "message")).rejects.toMatchObject({
    name: "socket_closed",
    code: "socket_closed",
  });
  await expect(port.accept(undefined, new Uint8Array(8_193))).rejects.toMatchObject({
    name: "attachment_too_large",
    code: "attachment_too_large",
  });
});

test("v2 socket port maps congestion errors and admits 16 KiB attachments", async () => {
  let status = 429;
  const port = createActorNativeSocketPort(
    {
      async fetch() {
        return status === 200
          ? Response.json({ socketId: "socket" })
          : new Response(null, { status });
      },
    },
    "b".repeat(64),
    "id",
    crypto.randomUUID(),
    v2Profile,
  );
  await expect(port.accept()).rejects.toMatchObject({
    name: "connection_limit_exceeded",
    code: "connection_limit_exceeded",
  });
  await expect(port.send("socket", "message")).rejects.toMatchObject({
    name: "transport_overloaded",
    code: "transport_overloaded",
  });
  status = 200;
  expect(await port.accept(undefined, new Uint8Array(16_384))).toBe("socket");
  await expect(port.accept(undefined, new Uint8Array(16_385))).rejects.toMatchObject({
    code: "attachment_too_large",
  });
});

test("native socket callbacks independently re-admit weighted variants and retire each child", async () => {
  const actorId = "socket-owner";
  const socketId = "socket-1";
  const classes = [{ label: "version-zero" }, { label: "version-one" }];
  const selected: unknown[] = [];
  const completions: string[] = [];
  const callbacks: string[] = [];
  const retained: Promise<unknown>[] = [];
  let retired = 0;
  let metadata = { socketId, actorId, attachment: null as string | null };
  const sent: (string | ArrayBuffer)[] = [];
  const socket = {
    deserializeAttachment: () => metadata,
    serializeAttachment: (value: typeof metadata) => {
      metadata = value;
    },
    send: (value: string | ArrayBuffer) => {
      sent.push(value);
    },
    close: () => {},
  } as Parameters<InstanceType<ReturnType<typeof createActorNativeOwner>>["webSocketMessage"]>[0];
  const ingress = createActorNativeIngress("ordinary-token", "b".repeat(64));
  let owner!: InstanceType<ReturnType<typeof createActorNativeOwner>>;
  const service = {
    fetch(request: Request) {
      return ingress.fetch(request, {
        NAMESPACE: {
          idFromName: (name) => name,
          get: () => ({ fetch: (inner) => owner.fetch(inner) }),
        },
      });
    },
  };
  const Owner = createActorNativeOwner("a".repeat(64), "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["zero", "one"],
  });
  let nextVariant = 0;
  owner = new Owner(
    {
      facets: {
        get(_name, create) {
          selected.push(create().class);
          return {
            async fetch(request) {
              const action = request.headers.get("x-takoserver-private-actor-socket-action");
              callbacks.push(action ?? "missing");
              const nonce = request.headers.get("x-takoserver-private-actor-socket-nonce");
              const port = createActorNativeSocketPort(
                service,
                "b".repeat(64),
                actorId,
                nonce as string,
              );
              expect(await port.get(socketId)).toBe(true);
              if (action === "callback-message") {
                expect(await request.text()).toBe("incoming");
                await port.setAttachment(socketId, new Uint8Array([7, 8]));
                await port.send(socketId, "outgoing");
              } else {
                expect(await port.getAttachment(socketId)).toEqual(new Uint8Array([7, 8]));
              }
              return new Response(null, { status: 204 });
            },
          };
        },
        abort() {
          retired += 1;
        },
      },
      getWebSockets: () => [socket],
      waitUntil(promise) {
        retained.push(promise);
      },
    },
    {
      CLASS: {},
      CLASS_0: classes[0],
      CLASS_1: classes[1],
      ADMISSION: {
        async fetch(request) {
          const body = (await request.json()) as Record<string, unknown>;
          if (body.action === "socket-complete") {
            completions.push(body.attemptNonce as string);
            return new Response(null, { status: 204 });
          }
          expect(body.action).toBe("socket");
          return Response.json({
            id: actorId,
            attemptNonce: body.attemptNonce,
            generationKey: "d".repeat(64),
            epoch: "epoch-1",
            variantKey: nextVariant++ === 0 ? "zero" : "one",
            leaseId: "lease",
          });
        },
      },
    },
  );
  await owner.webSocketMessage(socket, "incoming");
  await owner.webSocketClose(socket, 1000, "done", true);
  await owner.webSocketClose(socket, 1000, "duplicate", true);
  expect(selected).toEqual(classes);
  expect(callbacks).toEqual(["callback-message", "callback-close"]);
  expect(sent).toEqual(["outgoing"]);
  expect(retired).toBe(2);
  expect(completions).toHaveLength(2);
  await Promise.all(retained);
});

test("native per-ID owner holds next turn until body cancellation reaches the application stream", async () => {
  let calls = 0;
  let cancelled = false;
  const f = fixture(async () => {
    calls += 1;
    if (calls === 1)
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    return new Response("next");
  });
  const first = await f.owner.fetch(f.request());
  const second = f.owner.fetch(f.request());
  await Promise.resolve();
  expect(calls).toBe(1);
  await first.body?.cancel("caller cancelled");
  expect(await (await second).text()).toBe("next");
  expect(cancelled).toBe(true);
  await Promise.all(f.retained);
});

test("native per-ID owner releases errored body without poisoning following turns", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls += 1;
    if (calls === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body failed"));
          },
        }),
      );
    return new Response("next");
  });
  const first = await f.owner.fetch(f.request());
  await expect(first.text()).rejects.toThrow("body failed");
  expect(await (await f.owner.fetch(f.request())).text()).toBe("next");
  await Promise.all(f.retained);
});

test("native per-ID owner retires the stable facet before the next HTTP variant is selected", async () => {
  const retained: Promise<unknown>[] = [];
  const classes = [{ name: "class zero" }, { name: "class one" }];
  const constructed: unknown[] = [];
  let activeClass: unknown;
  const facets = {
    get(_name: string, create: () => { readonly class: unknown; readonly id: string }) {
      if (activeClass === undefined) {
        activeClass = create().class;
        constructed.push(activeClass);
      }
      return {
        fetch: async () => Response.json({ name: (activeClass as { name: string }).name }),
      };
    },
    abort() {
      expect(this).toBe(facets);
      activeClass = undefined;
    },
  };
  const Owner = createActorNativeOwner("a".repeat(64), "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["variant-zero", "variant-one"],
  });
  const owner = new Owner(
    {
      facets,
      waitUntil(promise) {
        retained.push(promise);
      },
    },
    { CLASS: {}, CLASS_0: classes[0], CLASS_1: classes[1] },
  );
  const send = (variant: string) =>
    owner.fetch(
      new Request("http://actor.invalid/", {
        headers: {
          "x-takoserver-private-actor-id": encodeURIComponent("same-id"),
          "x-takoserver-private-actor-variant": variant,
        },
      }),
    );

  expect(await (await send("variant-zero")).json()).toEqual({ name: "class zero" });
  expect(await (await send("variant-one")).json()).toEqual({ name: "class one" });
  expect(constructed).toEqual(classes);
  await Promise.all(retained);
});

test("private ingress and owner remove hop headers while retaining a streamed request body", async () => {
  const f = fixture(async (request) =>
    Response.json({
      body: await request.text(),
      // The Host-private child shim consumes this nonce before app dispatch.
      privateNoncePresent: request.headers.has("x-takoserver-private-actor-upgrade-nonce"),
      headers: [...request.headers].filter(
        ([name]) => name !== "x-takoserver-private-actor-upgrade-nonce",
      ),
    }),
  );
  const ingress = createActorNativeIngress("private-token");
  const response = await ingress.fetch(
    new Request("http://actor.invalid/", {
      method: "POST",
      headers: {
        "x-takoserver-private-actor-id": encodeURIComponent("id/日本語"),
        "x-takoserver-private-actor-token": "private-token",
        "x-takoserver-private-actor-variant": "default",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("payload"));
          controller.close();
        },
      }),
    }),
    {
      NAMESPACE: {
        idFromName: (id) => id,
        get: () => ({
          fetch(request) {
            expect(request.headers.get("x-takoserver-private-actor-variant")).toBe("default");
            return f.owner.fetch(request);
          },
        }),
      },
    },
  );
  expect(await response.json()).toEqual({
    body: "payload",
    privateNoncePresent: true,
    headers: [],
  });
  await Promise.all(f.retained);
});

test("alarm control cannot be reached with a missing, wrong, or ordinary ingress token", async () => {
  const f = fixture(async (request) =>
    Response.json({
      leaked: request.headers.has("x-takoserver-private-alarm-action"),
    }),
  );
  const ingress = createActorNativeIngress("ordinary-token", "b".repeat(64));
  const env = {
    NAMESPACE: {
      idFromName: (id: string) => id,
      get: () => ({
        async fetch(request: Request) {
          return Response.json({
            leaked: request.headers.has("x-takoserver-private-alarm-action"),
          });
        },
      }),
    },
  };
  const send = (token?: string) =>
    ingress.fetch(
      new Request("http://actor.invalid/", {
        headers: {
          "x-takoserver-private-actor-id": encodeURIComponent("id/日本語"),
          "x-takoserver-private-alarm-action": "clear",
          ...(token ? { "x-takoserver-private-actor-token": token } : {}),
        },
      }),
      env,
    );
  expect((await send()).status).toBe(404);
  expect((await send("wrong-token")).status).toBe(404);
  expect(await (await send("ordinary-token")).json()).toEqual({ leaked: false });
  await Promise.all(f.retained);
});

test("a valid alarm bearer cannot be retargeted to another actor ID", async () => {
  let captured: Request | undefined;
  const port = createActorNativeAlarmPort(
    {
      async fetch(request) {
        captured = request;
        return Response.json({ at: null });
      },
    },
    "b".repeat(64),
    "id/日本語",
  );
  expect(await port.get()).toBeNull();
  expect(captured).toBeDefined();
  const headers = new Headers(captured?.headers);
  headers.set("x-takoserver-private-actor-id", encodeURIComponent("another-id"));
  const ingress = createActorNativeIngress("ordinary-token", "b".repeat(64));
  let routed = false;
  const response = await ingress.fetch(new Request("http://actor.invalid/", { headers }), {
    NAMESPACE: {
      idFromName: (id) => id,
      get: () => ({
        async fetch() {
          routed = true;
          return new Response();
        },
      }),
    },
  });
  expect(response.status).toBe(404);
  expect(routed).toBe(false);
});

test("native alarm defaults to deny before facet construction and retains its durable obligation", async () => {
  const database = new Database(":memory:");
  let nativeWake: number | null = null;
  let facetGets = 0;
  let facetAborts = 0;
  const Owner = createActorNativeOwner("a".repeat(64), "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["default"],
  });
  const state = {
    facets: {
      get() {
        facetGets += 1;
        return { fetch: async () => new Response(null, { status: 204 }) };
      },
      abort() {
        facetAborts += 1;
      },
    },
    storage: {
      sql: {
        exec(sql: string, ...params: (string | number | null)[]) {
          const statement = database.query(sql);
          if (sql.startsWith("SELECT"))
            return statement.all(...params) as Record<string, unknown>[];
          statement.run(...params);
          return [];
        },
      },
      setAlarm(at: number) {
        nativeWake = at;
      },
      deleteAlarm() {
        nativeWake = null;
      },
    },
    waitUntil() {},
  };
  try {
    const owner = new Owner(state, {
      CLASS: {},
      CLASS_0: {},
      ADMISSION: {
        async fetch(request) {
          const body = (await request.json()) as {
            action?: string;
            id: string;
            attemptNonce: string;
          };
          if (body.action === "complete") return new Response(null, { status: 204 });
          return Response.json({
            variantKey: "default",
            generationKey: "e".repeat(64),
            epoch: "epoch-1",
            leaseId: "lease-stale",
            id: body.id,
            attemptNonce: body.attemptNonce,
          });
        },
      },
    });
    database
      .query("UPDATE actor_alarm_state SET actor_id = ?, pending_at = ? WHERE id = 1")
      .run("id", Date.now() - 1);
    await owner.alarm();
    expect(facetGets).toBe(0);
    expect(facetAborts).toBe(1);
    expect(
      database
        .query(
          "SELECT obligation, pending_at AS pending, retry_at AS retryAt FROM actor_alarm_state",
        )
        .get(),
    ).toEqual({ obligation: 1, pending: null, retryAt: expect.any(Number) });
    expect(nativeWake).toBeGreaterThan(Date.now());
  } finally {
    database.close();
  }
});

test("native alarm selects the admitted variant independently for each attempt on one actor ID", async () => {
  const database = new Database(":memory:");
  const selectedClasses: unknown[] = [];
  const admissionRequests: Array<{ id: string; attemptNonce: string }> = [];
  const completions: string[] = [];
  let nextVariant = 0;
  const variants = [{ label: "class zero" }, { label: "class one" }];
  const Owner = createActorNativeOwner("a".repeat(64), "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["variant-zero", "variant-one"],
  });
  const owner = new Owner(
    {
      facets: {
        get(_name, create) {
          selectedClasses.push(create().class);
          return { fetch: async () => new Response(null, { status: 204 }) };
        },
        abort() {},
      },
      storage: {
        sql: {
          exec(sql: string, ...params: (string | number | null)[]) {
            const statement = database.query(sql);
            if (sql.startsWith("SELECT"))
              return statement.all(...params) as Record<string, unknown>[];
            statement.run(...params);
            return [];
          },
        },
        setAlarm() {},
        deleteAlarm() {},
      },
      waitUntil() {},
    },
    {
      CLASS: {},
      CLASS_0: variants[0],
      CLASS_1: variants[1],
      ADMISSION: {
        async fetch(request) {
          const body = (await request.json()) as Record<string, unknown>;
          if (body.action === "complete") {
            completions.push(body.attemptNonce as string);
            return new Response(null, { status: 204 });
          }
          admissionRequests.push({
            id: body.id as string,
            attemptNonce: body.attemptNonce as string,
          });
          const variantIndex = nextVariant++;
          return Response.json({
            variantKey: variantIndex === 0 ? "variant-zero" : "variant-one",
            generationKey: "d".repeat(64),
            epoch: "epoch-1",
            leaseId: `lease-${variantIndex}`,
            id: body.id,
            attemptNonce: body.attemptNonce,
          });
        },
      },
    },
  );
  try {
    database
      .query("UPDATE actor_alarm_state SET actor_id = ?, pending_at = ? WHERE id = 1")
      .run("same-id", Date.now() - 1);
    await owner.alarm();
    database.query("UPDATE actor_alarm_state SET pending_at = ? WHERE id = 1").run(Date.now() - 1);
    await owner.alarm();

    expect(selectedClasses).toEqual(variants);
    expect(admissionRequests).toHaveLength(2);
    expect(admissionRequests.map(({ id }) => id)).toEqual(["same-id", "same-id"]);
    expect(admissionRequests[0]?.attemptNonce).not.toBe(admissionRequests[1]?.attemptNonce);
    expect(completions).toEqual(admissionRequests.map(({ attemptNonce }) => attemptNonce));
  } finally {
    database.close();
  }
});

test("lost grant response still completes the known attempt without constructing a facet", async () => {
  const database = new Database(":memory:");
  const attempts: string[] = [];
  const completions: string[] = [];
  let facetGets = 0;
  const Owner = createActorNativeOwner("a".repeat(64), "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["default"],
  });
  const owner = new Owner(
    {
      facets: {
        get() {
          facetGets += 1;
          throw new Error("facet must not be constructed");
        },
        abort() {},
      },
      storage: {
        sql: {
          exec(sql: string, ...params: (string | number | null)[]) {
            const statement = database.query(sql);
            if (sql.startsWith("SELECT"))
              return statement.all(...params) as Record<string, unknown>[];
            statement.run(...params);
            return [];
          },
        },
        setAlarm() {},
        deleteAlarm() {},
      },
      waitUntil() {},
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
          attempts.push(body.attemptNonce as string);
          throw new Error("grant response lost after Host lease allocation");
        },
      },
    },
  );
  try {
    database
      .query("UPDATE actor_alarm_state SET actor_id = ?, pending_at = ? WHERE id = 1")
      .run("same-id", Date.now() - 1);
    await owner.alarm();
    expect(facetGets).toBe(0);
    expect(attempts).toHaveLength(1);
    expect(completions).toEqual(attempts);
    expect(database.query("SELECT obligation FROM actor_alarm_state WHERE id = 1").get()).toEqual({
      obligation: 1,
    });
  } finally {
    database.close();
  }
});

test("native alarm retirement failure retains its obligation and poisons later dispatch", async () => {
  const database = new Database(":memory:");
  let admissionRequests = 0;
  let facetGets = 0;
  let facets: {
    get(
      name: string,
      create: () => { readonly class: unknown; readonly id: string },
    ): { fetch(request: Request): Promise<Response> };
    abort(name: string, reason: string): void;
  };
  facets = {
    get(_name, _create) {
      facetGets += 1;
      return { fetch: async () => new Response(null, { status: 204 }) };
    },
    abort() {
      expect(this).toBe(facets);
      throw new Error("facet abort failed");
    },
  };
  const Owner = createActorNativeOwner("a".repeat(64), "c".repeat(64), {
    generationKey: "d".repeat(64),
    epoch: "epoch-1",
    variantKeys: ["default"],
  });
  const owner = new Owner(
    {
      facets,
      storage: {
        sql: {
          exec(sql: string, ...params: (string | number | null)[]) {
            const statement = database.query(sql);
            if (sql.startsWith("SELECT"))
              return statement.all(...params) as Record<string, unknown>[];
            statement.run(...params);
            return [];
          },
        },
        setAlarm() {},
        deleteAlarm() {},
      },
      waitUntil() {},
    },
    {
      CLASS: {},
      CLASS_0: {},
      ADMISSION: {
        async fetch(request) {
          const body = (await request.json()) as {
            action?: string;
            id?: string;
            attemptNonce?: string;
          };
          if (body.action === "complete") return new Response(null, { status: 204 });
          admissionRequests += 1;
          return Response.json({
            id: body.id,
            attemptNonce: body.attemptNonce,
            variantKey: "default",
            generationKey: "d".repeat(64),
            epoch: "epoch-1",
            leaseId: "lease-retirement-failure",
          });
        },
      },
    },
  );
  try {
    database
      .query("UPDATE actor_alarm_state SET actor_id = ?, pending_at = ? WHERE id = 1")
      .run("same-id", Date.now() - 1);
    await owner.alarm();

    expect(database.query("SELECT obligation FROM actor_alarm_state WHERE id = 1").get()).toEqual({
      obligation: 1,
    });
    database.query("UPDATE actor_alarm_state SET retry_at = ? WHERE id = 1").run(Date.now() - 1);
    await expect(owner.alarm()).rejects.toThrow("Actor facet retirement failed");
    expect(admissionRequests).toBe(1);
    expect(facetGets).toBe(1);
    expect(database.query("SELECT obligation FROM actor_alarm_state WHERE id = 1").get()).toEqual({
      obligation: 1,
    });
  } finally {
    database.close();
  }
});
