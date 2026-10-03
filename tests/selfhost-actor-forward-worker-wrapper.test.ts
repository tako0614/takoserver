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

test("forward Actor wrapper admits the published 64-binding bound but not 65", () => {
  const bindings = Array.from({ length: 64 }, (_, index) => ({
    ...binding,
    publicName: `ROOM_${index}`,
    httpService: `__TAKOSERVER_ACTOR_HTTP_${index.toString().padStart(5, "0")}`,
    upgradeService: `__TAKOSERVER_ACTOR_UPGRADE_${index.toString().padStart(5, "0")}`,
  }));
  const options = { runtimeModule: "runtime.mjs", innerModule: "inner.mjs", bindings };
  const source = selfhostActorForwardEntrypointSource(options);
  expect(source).toContain('"publicName":"ROOM_63"');
  expect(() =>
    selfhostActorForwardEntrypointSource({
      ...options,
      bindings: [...bindings, { ...binding, publicName: "ROOM_64" }],
    }),
  ).toThrow("Actor forward wrapper configuration invalid");
});
