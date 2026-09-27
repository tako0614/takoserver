import { expect, test } from "bun:test";
import type { RequestLifetime } from "../src/request-lifetime.ts";
import { createRouter } from "../src/router.ts";

test("the router passes only the current request's lifetime to its Host", async () => {
  const seen: Array<RequestLifetime | undefined> = [];
  const router = createRouter({
    publicOrigin: "https://host.example.test",
    control: async () => null,
    takoformHost: {
      async handle(_request, lifetime) {
        seen.push(lifetime);
        return new Response("host");
      },
    },
  });
  const retained: Promise<void>[] = [];
  const first: RequestLifetime = {
    waitUntil: (work) => {
      retained.push(work);
    },
  };
  expect((await router(new Request("https://host.example.test/one"), first)).status).toBe(200);
  expect((await router(new Request("https://host.example.test/two"))).status).toBe(200);
  expect(seen).toEqual([first, undefined]);
  expect(retained).toEqual([]);
});
