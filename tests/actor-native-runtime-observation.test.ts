import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createActorNativeIngress,
  createActorNativeOwner,
} from "../src/actor-native-owner-worker.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { fixture, scope } from "./helpers/actor-resource-fixture.ts";

test("native Actor observation reads the owner alarm and socket registry, never a caller header", async () => {
  const database = new Database(":memory:");
  const actorId = "counter/一";
  const encodedId = encodeURIComponent(actorId);
  const alarmSecret = "b".repeat(64);
  const sockets: { deserializeAttachment(): unknown; serializeAttachment(value: unknown): void }[] =
    [];
  const generationKey = "d".repeat(64);
  const epoch = "physical-epoch";
  const Owner = createActorNativeOwner(
    "a".repeat(64),
    "c".repeat(64),
    { generationKey, epoch, variantKeys: ["default"] },
    undefined,
    undefined,
    undefined,
    undefined,
    alarmSecret,
  );
  const owner = new Owner(
    {
      facets: {
        get: () => ({ fetch: async () => new Response("application") }),
        abort() {},
      },
      storage: {
        sql: {
          exec: (sql, ...params) => database.query(sql).all(...params) as Record<string, unknown>[],
        },
        setAlarm() {},
        deleteAlarm() {},
      },
      getWebSockets: () => sockets as never,
      waitUntil() {},
    },
    { CLASS: {}, CLASS_0: {} },
  );
  const ingress = createActorNativeIngress("ordinary-token", alarmSecret);
  const dispatch = (request: Request) =>
    ingress.fetch(request, {
      NAMESPACE: {
        idFromName: (name) => name,
        get: () => ({ fetch: (inner) => owner.fetch(inner) }),
      },
    });
  try {
    // The native SQL slot, not a Host alarm lease, is the source of this count.
    const first = await owner.fetch(
      new Request("http://actor.invalid/", {
        headers: {
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-variant": "default",
        },
      }),
    );
    await first.body?.cancel();
    database.query("UPDATE actor_alarm_state SET pending_at = ? WHERE id = 1").run(1000);
    const ordinary = await dispatch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-token": "ordinary-token",
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-variant": "default",
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
    );
    expect(await ordinary.text()).toBe("application");
    const foreign = await dispatch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-token": "foreign-control",
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
    );
    expect(foreign.status).toBe(404);
    const bearer = createHmac("sha256", alarmSecret).update(encodedId).digest("hex");
    const observed = await dispatch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-token": bearer,
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
    );
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({
      actorId,
      generationKey,
      epoch,
      activeActor: false,
      pendingAlarmCount: 1,
      openSocketCount: 0,
    });
    sockets.push({
      deserializeAttachment: () => ({ socketId: "socket-one", actorId, attachment: null }),
      serializeAttachment() {},
    });
    const withSocket = await dispatch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-token": bearer,
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
    );
    expect(await withSocket.json()).toMatchObject({
      openSocketCount: 1,
      socketIds: ["socket-one"],
    });
    sockets.push({
      deserializeAttachment: () => ({
        socketId: "foreign",
        actorId: "another-id",
        attachment: null,
      }),
      serializeAttachment() {},
    });
    const foreignSocket = await dispatch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-token": bearer,
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
    );
    expect(foreignSocket.status).toBe(503);
  } finally {
    database.close();
  }
});

test("an unindexed historical Actor namespace is unknown, not an invented zero snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-observe-old-"));
  const f = fixture();
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: root,
    storageRoot: join(root, "state"),
    binary: "/never-execute",
    graph: f.read,
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
  });
  try {
    await host.ready;
    expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(1_000))).toEqual({
      kind: "unknown",
    });
  } finally {
    await host.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("native Actor observation counts a held response producer as one active Actor ID", async () => {
  const database = new Database(":memory:");
  const actorId = "streaming-id";
  const secret = "b".repeat(64);
  const Owner = createActorNativeOwner(
    "a".repeat(64),
    "c".repeat(64),
    { generationKey: "d".repeat(64), epoch: "physical-epoch", variantKeys: ["default"] },
    undefined,
    undefined,
    undefined,
    undefined,
    secret,
  );
  const retained: Promise<unknown>[] = [];
  const owner = new Owner(
    {
      facets: {
        get: () => ({
          fetch: async () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
        }),
        abort() {},
      },
      storage: {
        sql: {
          exec: (sql, ...params) => database.query(sql).all(...params) as Record<string, unknown>[],
        },
        setAlarm() {},
        deleteAlarm() {},
      },
      getWebSockets: () => [],
      waitUntil: (promise) => retained.push(promise),
    },
    { CLASS: {}, CLASS_0: {} },
  );
  const encodedId = encodeURIComponent(actorId);
  const ingress = createActorNativeIngress("ordinary-token", secret);
  const observe = async () => {
    const response = await ingress.fetch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-token": createHmac("sha256", secret)
            .update(encodedId)
            .digest("hex"),
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
      {
        NAMESPACE: {
          idFromName: (name) => name,
          get: () => ({ fetch: (inner) => owner.fetch(inner) }),
        },
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { activeActor: boolean };
  };
  try {
    const response = await owner.fetch(
      new Request("http://actor.invalid/", {
        headers: {
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-variant": "default",
        },
      }),
    );
    expect((await observe()).activeActor).toBe(true);
    await response.body?.cancel();
    await Promise.all(retained);
    expect((await observe()).activeActor).toBe(false);
  } finally {
    database.close();
  }
});
