import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  createActorNativeAlarmPort,
  createActorNativeIngress,
  createActorNativeOwner,
} from "../src/actor-native-owner-worker.ts";

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
      headers: [...request.headers],
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
  expect(await response.json()).toEqual({ body: "payload", headers: [] });
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
            completions.push(body.leaseId as string);
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
    expect(completions).toEqual(["lease-0", "lease-1"]);
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
