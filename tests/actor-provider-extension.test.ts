import { expect, test } from "bun:test";
import * as root from "@takoserver/core";
import * as providerExtension from "@takoserver/core/provider-extension";

const ACTOR_EXTENSION_VALUES = [
  "ActorRuntimeError",
  "createActorClassExecution",
  "createActorContext",
  "createActorTurn",
  "inspectActorClass",
  "isActorRuntimeError",
] as const;

test("provider-extension exposes only the child-only Actor helper seam", () => {
  for (const name of ACTOR_EXTENSION_VALUES) {
    expect(name in providerExtension).toBe(true);
    expect(name in root).toBe(false);
  }

  expect("ActorExecutionError" in providerExtension).toBe(false);
  expect("ActorInstance" in providerExtension).toBe(false);
});
