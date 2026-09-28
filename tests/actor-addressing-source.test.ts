import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renderActorAddressingModuleSource } from "../src/actor-addressing-source.ts";
import { ACTOR_ADDRESSING_DIGEST } from "../src/generated/actor-addressing-source.ts";

test("Actor addressing projection bundles the pinned synchronous hash implementation", () => {
  const source = renderActorAddressingModuleSource();
  expect(source).not.toMatch(/^\s*import\s/mu);
  expect(source).toContain("createActorAddressing");
  expect(source).toContain("sha256");
  expect(`sha256:${createHash("sha256").update(source).digest("hex")}`).toBe(
    ACTOR_ADDRESSING_DIGEST,
  );
});
