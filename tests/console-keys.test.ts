import { expect, test } from "bun:test";
import { DEFAULT_KEY_SCOPES, keyScopeGroups } from "../console/src/pages/keys.ts";
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
