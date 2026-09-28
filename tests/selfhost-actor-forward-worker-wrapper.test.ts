import { expect, test } from "bun:test";
import {
  renderSelfhostActorForwardRuntimeModuleSource,
  selfhostActorForwardEntrypointSource,
} from "../src/selfhost-actor-forward-worker-wrapper.ts";

const binding = {
  publicName: "ROOM",
  httpService: "__TAKOSERVER_ACTOR_HTTP",
  upgradeService: "__TAKOSERVER_ACTOR_UPGRADE",
  token: "a".repeat(64),
};

test("forward Actor wrapper imports Host runtime before ordinary tenant wrapper", () => {
  const source = selfhostActorForwardEntrypointSource({
    runtimeModule: "runtime.mjs",
    innerModule: "inner.mjs",
    bindings: [binding],
    queue: true,
    scheduled: true,
    events: true,
  });
  expect(source.indexOf('from "./runtime.mjs"')).toBeLessThan(source.indexOf('from "./inner.mjs"'));
  expect(source).toContain("async queue(");
  expect(source).toContain("async scheduled(");
  expect(source).toContain("export const takoserverSelfhostEvents");
  expect(source).toContain('"publicName":"ROOM"');
  expect(renderSelfhostActorForwardRuntimeModuleSource()).toContain(
    "createSelfhostActorForwardContext",
  );
});

test("forward Actor wrapper rejects token, service, module and binding alias ambiguity", () => {
  const base = { runtimeModule: "runtime.mjs", innerModule: "inner.mjs", bindings: [binding] };
  expect(() =>
    selfhostActorForwardEntrypointSource({ ...base, runtimeModule: "../escape" }),
  ).toThrow();
  expect(() =>
    selfhostActorForwardEntrypointSource({ ...base, innerModule: "runtime.mjs" }),
  ).toThrow();
  expect(() =>
    selfhostActorForwardEntrypointSource({
      ...base,
      bindings: [binding, { ...binding }],
    }),
  ).toThrow();
  expect(() =>
    selfhostActorForwardEntrypointSource({
      ...base,
      bindings: [{ ...binding, token: "predictable" }],
    }),
  ).toThrow();
  expect(() =>
    selfhostActorForwardEntrypointSource({
      ...base,
      bindings: [{ ...binding, upgradeService: binding.httpService }],
    }),
  ).toThrow();
});
