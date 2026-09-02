import { expect, test } from "bun:test";
import worker, { requirePublicOrigin } from "../src/entry-worker.ts";

test("the official Worker requires an environment-owned public origin", () => {
  expect(requirePublicOrigin({ PUBLIC_ORIGIN: "https://api.takoserver.com" })).toBe(
    "https://api.takoserver.com",
  );
  expect(() => requirePublicOrigin({ PUBLIC_ORIGIN: undefined })).toThrow("PUBLIC_ORIGIN");
});

test("the official Worker does not derive identity from an incoming request host", async () => {
  const env = {} as Parameters<typeof worker.fetch>[1];
  // A startup refusal is answered rather than thrown, so the operator reads a
  // reason instead of a provider exception page. It is still a refusal: the
  // request host never becomes this deployment's identity.
  const response = await worker.fetch(
    new Request("https://alias.takoserver.com/openapi.json"),
    env,
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("PUBLIC_ORIGIN");
});
