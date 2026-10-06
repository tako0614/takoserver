import { expect, test } from "bun:test";
import type { RequestLifetime } from "../src/request-lifetime.ts";
import { createRouter } from "../src/router.ts";

test("the normal router serves only v2 Host HTTP and never passes a request lifetime into it", async () => {
  const seen: Request[] = [];
  const router = createRouter({
    publicOrigin: "https://host.example.test",
    control: async () => null,
    takoformV2Host: {
      async fetch(request) {
        seen.push(request);
        return new URL(request.url).pathname === "/.well-known/takoform/v2"
          ? Response.json({ api: "forms.takoform.com/v2" })
          : null;
      },
    },
  });
  const retained: Promise<void>[] = [];
  const lifetime: RequestLifetime = {
    waitUntil: (work) => {
      retained.push(work);
    },
  };
  const v2Request = new Request("https://host.example.test/.well-known/takoform/v2");
  expect((await router(v2Request, lifetime)).status).toBe(200);
  expect(seen).toEqual([v2Request]);
  expect(retained).toEqual([]);
  expect(
    (await router(new Request("https://host.example.test/.well-known/takoform/v1"))).status,
  ).toBe(404);
});
