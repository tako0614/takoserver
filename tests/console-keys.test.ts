import { expect, test } from "bun:test";
import { DEFAULT_KEY_SCOPES, keyScopeGroups, keyUsage } from "../console/src/key-scopes.ts";
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

test("reads AI availability and the v2 base from the Host's own discovery document", async () => {
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
    return await api.hostDiscovery();
  };
  const v2 = "https://api.example.test/apis/forms.takoform.com/v2";
  try {
    expect(
      await answer({ endpoints: { ai: "https://api.example.test/v1/ai", takoform: v2 } }),
    ).toEqual({ ai: true, takoform: v2 });
    expect(await answer({ endpoints: { api: "https://api.example.test" } })).toEqual({
      ai: false,
      takoform: null,
    });
    expect(await answer({ endpoints: { ai: true, takoform: 2 } })).toEqual({
      ai: false,
      takoform: null,
    });
    expect(
      await answer({ endpoints: { ai: "https://api.example.test/v1/ai", takoform: v2 } }, 503),
    ).toEqual({ ai: false, takoform: null });
  } finally {
    globalThis.fetch = original;
  }
});

test("shows a first request in the install guide's names, only to a key that can read Resources", () => {
  const v2 = "https://api.example.com:8443/apis/forms.takoform.com/v2";
  const usage = [
    `V2=${v2}`,
    "ORG=org_1b17",
    "printf 'API key: '; read -rs KEY; echo",
    'curl -sS -G "$V2/resources" --data-urlencode "space=$ORG" \\',
    '  -H "authorization: Bearer $KEY"',
  ].join("\n");
  expect(keyUsage(v2, "org_1b17", ["resources:read"])).toBe(usage);
  expect(keyUsage(v2, "org_1b17", ["resources:write", "wallet:read"])).toBe(usage);
  // No comment after a command: an interactive zsh would pass "#" to read.
  expect(usage).not.toContain("#");
  for (const scopes of [["wallet:read"], ["usage:read", "catalog:read"], ["ai:invoke"], []]) {
    expect(keyUsage(v2, "org_1b17", scopes)).toBeNull();
  }
});
