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
    expect(
      await host.observeNamespaceRuntimeForAcceptedOperation(
        scope,
        {
          workerUid: "unopened-worker",
          className: "Counter",
          sourceOperationId: "unopened-source",
          incarnationId: "unopened-incarnation",
          generationKey: "unopened-generation",
          versions: [],
        },
        AbortSignal.timeout(1_000),
      ),
    ).toEqual({ kind: "unknown" });
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

test("Host-authorized native observation rechecks a held guard and keeps the snapshot private", async () => {
  const database = new Database(":memory:");
  const actorId = "held/actor";
  const encodedId = encodeURIComponent(actorId);
  let current = true;
  let revokeAfterFirst = false;
  let calls = 0;
  let graphReads = 0;
  let mutateOnSecondRead = false;
  let mutate: (() => Promise<void>) | undefined;
  const Owner = createActorNativeOwner(
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({}),
    async () => ({ generationKey: "d".repeat(64), epoch: "native", variantKeys: ["default"] }),
    undefined,
    undefined,
    async ({ request, actorId: authorizedId, encodedActorId, env }) => {
      if (
        authorizedId !== actorId ||
        encodedActorId !== encodedId ||
        request.headers.get("x-held-operation") !== "exact-lease" ||
        env.CLASS === undefined
      )
        return null;
      return {
        guard: async () => {
          calls += 1;
          return current && (!revokeAfterFirst || calls % 2 === 1);
        },
        readGraph: async () => {
          graphReads += 1;
          if (mutateOnSecondRead && graphReads === 2) await mutate?.();
          return {
            generationKey: "e".repeat(64),
            epoch: "held-native",
            variantKeys: ["held-default"],
          };
        },
      };
    },
  );
  const owner = new Owner(
    {
      facets: { get: () => ({ fetch: async () => new Response("application") }), abort() {} },
      storage: {
        sql: {
          exec: (sql, ...params) => database.query(sql).all(...params) as Record<string, unknown>[],
        },
        setAlarm() {},
        deleteAlarm() {},
      },
      getWebSockets: () => [],
      waitUntil() {},
    },
    { CLASS: {} },
  );
  mutate = async () => {
    const response = await owner.fetch(
      new Request("http://actor.invalid/", {
        headers: {
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-variant": "default",
        },
      }),
    );
    await response.body?.cancel();
  };
  const observe = (lease?: string) =>
    owner.fetch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-observation": "snapshot-v1",
          ...(lease ? { "x-held-operation": lease } : {}),
        },
      }),
    );
  try {
    expect((await observe()).status).toBe(404);
    expect((await observe("wrong-lease")).status).toBe(404);
    const confirmed = await observe("exact-lease");
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      actorId,
      generationKey: "e".repeat(64),
      epoch: "held-native",
    });
    expect(calls).toBe(2);
    revokeAfterFirst = true;
    expect((await observe("exact-lease")).status).toBe(503);
    expect(calls).toBe(4);
    revokeAfterFirst = false;
    current = false;
    expect((await observe("exact-lease")).status).toBe(404);
    expect(calls).toBe(5);
    current = true;
    graphReads = 0;
    mutateOnSecondRead = true;
    expect((await observe("exact-lease")).status).toBe(503);
  } finally {
    database.close();
  }
});

test("native observation refuses simultaneous bearer and Host callback authorities", () => {
  expect(() =>
    createActorNativeOwner(
      "a".repeat(64),
      "b".repeat(64),
      { generationKey: "g", epoch: "e", variantKeys: ["default"] },
      undefined,
      undefined,
      undefined,
      undefined,
      "c".repeat(64),
      async () => async () => true,
    ),
  ).toThrow("Actor observation authority is ambiguous");
});

test("native observation is unavailable without durable storage even when facet fetch works", async () => {
  const secret = "b".repeat(64);
  const actorId = "storage-less";
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
  const owner = new Owner(
    {
      facets: { get: () => ({ fetch: async () => new Response("ok") }), abort() {} },
      getWebSockets: () => [],
      waitUntil() {},
    },
    { CLASS: {}, CLASS_0: {} },
  );
  const ordinary = await owner.fetch(
    new Request("http://actor.invalid/", {
      headers: {
        "x-takoserver-private-actor-id": actorId,
        "x-takoserver-private-actor-variant": "default",
      },
    }),
  );
  expect(await ordinary.text()).toBe("ok");
  const observed = await owner.fetch(
    new Request("http://actor.invalid/__actor_observe__", {
      method: "POST",
      headers: {
        "x-takoserver-private-actor-id": actorId,
        "x-takoserver-private-actor-token": createHmac("sha256", secret)
          .update(actorId)
          .digest("hex"),
        "x-takoserver-private-actor-observation": "snapshot-v1",
      },
    }),
  );
  expect(observed.status).toBe(503);
});

test("native observation identity survives a clean owner constructor on the same durable SQL", async () => {
  const database = new Database(":memory:");
  const actorId = "stable-owner";
  const encodedId = encodeURIComponent(actorId);
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
  const state = () => ({
    facets: { get: () => ({ fetch: async () => new Response("ok") }), abort() {} },
    storage: {
      sql: {
        exec: (sql: string, ...params: (string | number | null)[]) =>
          database.query(sql).all(...params) as Record<string, unknown>[],
      },
      setAlarm() {},
      deleteAlarm() {},
    },
    getWebSockets: () => [],
    waitUntil() {},
  });
  const observationRequest = () =>
    new Request("http://actor.invalid/__actor_observe__", {
      method: "POST",
      headers: {
        "x-takoserver-private-actor-id": encodedId,
        "x-takoserver-private-actor-token": createHmac("sha256", secret)
          .update(encodedId)
          .digest("hex"),
        "x-takoserver-private-actor-observation": "snapshot-v1",
      },
    });
  const observe = async (owner: InstanceType<typeof Owner>) => {
    const response = await owner.fetch(observationRequest());
    expect(response.status).toBe(200);
    return (await response.json()) as { instance: string; revision: number; activeActor: boolean };
  };
  try {
    const first = await observe(new Owner(state(), { CLASS: {}, CLASS_0: {} }));
    const second = await observe(new Owner(state(), { CLASS: {}, CLASS_0: {} }));
    expect(second).toEqual(first);
    expect(first.instance).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.revision).toBe(0);
    database.query("UPDATE actor_observation_state SET instance = 'corrupt' WHERE id = 1").run();
    expect(
      (await new Owner(state(), { CLASS: {}, CLASS_0: {} }).fetch(observationRequest())).status,
    ).toBe(503);
    database.query("DELETE FROM actor_observation_state WHERE id = 1").run();
    const reset = await observe(new Owner(state(), { CLASS: {}, CLASS_0: {} }));
    expect(reset.instance).not.toBe(first.instance);
  } finally {
    database.close();
  }
});

test("native observation revision survives active and alarm ABA across owner reopens", async () => {
  const database = new Database(":memory:");
  const actorId = "aba-owner";
  const encodedId = encodeURIComponent(actorId);
  const secret = "b".repeat(64);
  const retained: Promise<unknown>[] = [];
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
  const state = () => ({
    facets: { get: () => ({ fetch: async () => new Response("ok") }), abort() {} },
    storage: {
      sql: {
        exec: (sql: string, ...params: (string | number | null)[]) =>
          database.query(sql).all(...params) as Record<string, unknown>[],
      },
      setAlarm() {},
      deleteAlarm() {},
    },
    getWebSockets: () => [],
    waitUntil: (promise: Promise<unknown>) => retained.push(promise),
  });
  const request = (headers: Record<string, string> = {}) =>
    new Request("http://actor.invalid/", {
      headers: { "x-takoserver-private-actor-id": encodedId, ...headers },
    });
  const observe = async (owner: InstanceType<typeof Owner>) => {
    const response = await owner.fetch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-token": createHmac("sha256", secret)
            .update(encodedId)
            .digest("hex"),
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      instance: string;
      revision: number;
      activeActor: boolean;
      pendingAlarmCount: number;
    };
  };
  try {
    const firstOwner = new Owner(state(), { CLASS: {}, CLASS_0: {} });
    const baseline = await observe(firstOwner);
    const response = await firstOwner.fetch(
      request({
        "x-takoserver-private-actor-variant": "default",
      }),
    );
    await response.body?.cancel();
    await Promise.all(retained);
    const reopened = new Owner(state(), { CLASS: {}, CLASS_0: {} });
    const afterActive = await observe(reopened);
    expect(afterActive.instance).toBe(baseline.instance);
    expect(afterActive.activeActor).toBe(false);
    expect(afterActive.revision).toBeGreaterThan(baseline.revision);
    const set = await reopened.fetch(
      request({
        "x-takoserver-private-alarm-action": "set",
        "x-takoserver-private-alarm-at": "1000",
        "x-takoserver-private-actor-token": createHmac("sha256", "c".repeat(64))
          .update(encodedId)
          .digest("hex"),
      }),
    );
    expect(set.status).toBe(200);
    const clear = await reopened.fetch(
      request({
        "x-takoserver-private-alarm-action": "clear",
        "x-takoserver-private-actor-token": createHmac("sha256", "c".repeat(64))
          .update(encodedId)
          .digest("hex"),
      }),
    );
    expect(clear.status).toBe(200);
    const final = await observe(new Owner(state(), { CLASS: {}, CLASS_0: {} }));
    expect(final.pendingAlarmCount).toBe(baseline.pendingAlarmCount);
    expect(final.revision).toBeGreaterThan(afterActive.revision);
    expect(final.instance).toBe(baseline.instance);
    database
      .query("UPDATE actor_observation_state SET revision = ? WHERE id = 1")
      .run(Number.MAX_SAFE_INTEGER - 1);
    const exhausted = new Owner(state(), { CLASS: {}, CLASS_0: {} });
    await expect(
      exhausted.fetch(request({ "x-takoserver-private-actor-variant": "default" })),
    ).rejects.toThrow("Actor observation revision exhausted");
    const unavailable = await exhausted.fetch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-token": createHmac("sha256", secret)
            .update(encodedId)
            .digest("hex"),
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
    );
    expect(unavailable.status).toBe(503);
  } finally {
    database.close();
  }
});

test("native observation revision detects a socket close and replacement with the same visible ID", async () => {
  const database = new Database(":memory:");
  const actorId = "socket-aba-owner";
  const encodedId = encodeURIComponent(actorId);
  const secret = "b".repeat(64);
  const sockets: {
    deserializeAttachment(): unknown;
    serializeAttachment(value: unknown): void;
    close(code?: number, reason?: string): void;
  }[] = [];
  const socket = () => ({
    deserializeAttachment: () => ({ socketId: "same-visible-id", actorId, attachment: null }),
    serializeAttachment() {},
    close() {},
  });
  sockets.push(socket());
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
  const state = () => ({
    facets: { get: () => ({ fetch: async () => new Response(null, { status: 204 }) }), abort() {} },
    storage: {
      sql: {
        exec: (sql: string, ...params: (string | number | null)[]) =>
          database.query(sql).all(...params) as Record<string, unknown>[],
      },
      setAlarm() {},
      deleteAlarm() {},
    },
    getWebSockets: () => sockets as never,
    waitUntil() {},
  });
  const observe = async (owner: InstanceType<typeof Owner>) => {
    const response = await owner.fetch(
      new Request("http://actor.invalid/__actor_observe__", {
        method: "POST",
        headers: {
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-token": createHmac("sha256", secret)
            .update(encodedId)
            .digest("hex"),
          "x-takoserver-private-actor-observation": "snapshot-v1",
        },
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      instance: string;
      revision: number;
      openSocketCount: number;
      socketIds: string[];
    };
  };
  try {
    const env = {
      CLASS: {},
      CLASS_0: {},
      ADMISSION: { fetch: async () => new Response(null, { status: 204 }) },
    };
    const owner = new Owner(state(), env);
    const before = await observe(owner);
    await owner.webSocketClose(sockets[0] as never, 1000, "done", true);
    sockets.splice(0, 1, socket());
    const after = await observe(new Owner(state(), env));
    expect(after.instance).toBe(before.instance);
    expect(after.openSocketCount).toBe(1);
    expect(after.socketIds).toEqual(before.socketIds);
    expect(after.revision).toBeGreaterThan(before.revision);
  } finally {
    database.close();
  }
});
