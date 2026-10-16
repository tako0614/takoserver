import { expect, test } from "bun:test";
import { DEFAULT_KEY_SCOPES, keyScopeGroups } from "../console/src/key-scopes.ts";
import { API_KEY_SCOPES, grants } from "../src/auth.ts";

const offered = (aiAvailable: boolean) =>
  keyScopeGroups(aiAvailable).flatMap((group) => group.scopes.map((scope) => scope.id));

test("offers only scopes the Host accepts, each saying what it opens", () => {
  for (const id of offered(true)) expect(API_KEY_SCOPES).toContain(id as never);
  for (const group of keyScopeGroups(true)) {
    expect(group.label().length).toBeGreaterThan(0);
    for (const scope of group.scopes) expect(scope.blurb().length).toBeGreaterThan(10);
  }
  expect(offered(true)[0]).toBe("resources:write");
});

test("offers ai:invoke only where the Host serves /v1/ai", () => {
  expect(offered(true)).toContain("ai:invoke");
  expect(offered(false)).not.toContain("ai:invoke");
});

test("a new key can manage Resources and nothing else by default", () => {
  expect(DEFAULT_KEY_SCOPES).toEqual(["resources:write"]);
  expect(grants(["resources:write"], "resources:read")).toBe(true);
});

test("reads AI availability from the Host's own discovery document", async () => {
  const { createApi } = await import("../console/src/api.ts");
  const original = globalThis.fetch;
  const api = createApi({
    origin: "https://api.example.test",
    token: () => null,
    onSessionLost: () => undefined,
  });
  const answer = async (body: unknown, status = 200) => {
    globalThis.fetch = Object.assign(async () => Response.json(body, { status }), {
      preconnect: original.preconnect,
    });
    return await api.aiAvailable();
  };
  try {
    expect(await answer({ endpoints: { ai: "https://api.example.test/v1/ai" } })).toBe(true);
    expect(await answer({ endpoints: { api: "https://api.example.test" } })).toBe(false);
    expect(await answer({ endpoints: { ai: true } })).toBe(false);
    expect(await answer({ endpoints: { ai: "https://api.example.test/v1/ai" } }, 503)).toBe(false);
  } finally {
    globalThis.fetch = original;
  }
});
