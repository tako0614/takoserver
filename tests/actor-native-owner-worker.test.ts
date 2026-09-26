import { expect, test } from "bun:test";
import {
  createActorNativeIngress,
  createActorNativeOwner,
} from "../src/actor-native-owner-worker.ts";

function fixture(fetch: (request: Request) => Promise<Response>) {
  const retained: Promise<unknown>[] = [];
  const Owner = createActorNativeOwner();
  const owner = new Owner(
    {
      facets: {
        get: (_name, create) => {
          expect(create().id).toBe("id/日本語");
          return { fetch };
        },
      },
      waitUntil: (promise) => {
        retained.push(promise);
      },
    },
    { CLASS: {} },
  );
  const request = () =>
    new Request("http://actor.invalid/", {
      headers: { "x-takoserver-private-actor-id": encodeURIComponent("id/日本語") },
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
        get: () => f.owner,
      },
    },
  );
  expect(await response.json()).toEqual({ body: "payload", headers: [] });
  await Promise.all(f.retained);
});
