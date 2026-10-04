import { expect, test } from "bun:test";
import {
  ActorRuntimeError,
  createActorClassExecution,
  createActorContext,
  createActorTurn,
  prepareActorClassInspection,
  resolveActorAbiProfile,
} from "../src/actor-class-execution.ts";

const LEGACY_REF = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.actor",
  version: "1.0.0",
  schemaDigest: "sha256:f5428fb587de80261dd7363dc5b8a3f4aab7e469fa1b5fce8441ad9acbec8218",
} as const;
const V2_REF = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.actor",
  version: "2.0.0",
  schemaDigest: "sha256:f4d70bb6d63c436e43b2e6cc50069fa6ed68eca68aea2fbc10a77969738db156",
} as const;

test("superseded unsigned Actor source does not silently retain an ABI registration", () => {
  expect(() =>
    resolveActorAbiProfile({
      ...V2_REF,
      schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
    }),
  ).toThrow(ActorRuntimeError);
});

test("only an exact Actor InterfaceRef selects the forward ABI", () => {
  expect(resolveActorAbiProfile(LEGACY_REF)).toBe(resolveActorAbiProfile(LEGACY_REF));
  expect(resolveActorAbiProfile(V2_REF)).not.toBe(resolveActorAbiProfile(LEGACY_REF));
  for (const changed of [
    { ...V2_REF, schemaDigest: LEGACY_REF.schemaDigest },
    { ...V2_REF, name: "worker.workflow" },
    { ...V2_REF, version: "2.0.1" },
    { ...V2_REF, apiVersion: "interfaces.takoform.com/v2" },
  ]) {
    expect(() => resolveActorAbiProfile(changed)).toThrow(ActorRuntimeError);
  }
});

test("forward execution reuses one branded inspection and dispatches socketError with its receiver", async () => {
  const received: unknown[] = [];
  let constructed = 0;
  class Actor {
    constructor() {
      constructed += 1;
    }
    fetch() {
      return new Response("ok");
    }
    alarm() {}
    socketMessage() {}
    socketClose() {
      throw new Error("socketError must not be converted to close");
    }
    socketError(this: Actor, socket: object, event: object, turn: object) {
      received.push(this, socket, event, turn);
    }
  }
  const namespace = { Actor };
  const profile = resolveActorAbiProfile(V2_REF);
  const inspection = prepareActorClassInspection({ namespace, exportName: "Actor", profile });
  expect(constructed).toBe(0);
  const context = createActorContext({ id: "actor-1", storage: {}, alarm: {}, sockets: {} });
  const turn = createActorTurn(new AbortController().signal);
  const execution = createActorClassExecution({
    namespace,
    exportName: "Actor",
    profile,
    inspection,
    context,
    env: {},
  });
  const socket = {};
  const event = { code: "transport_error" as const };
  await execution.dispatch({ kind: "socketError", socket, event }, turn);
  expect(constructed).toBe(1);
  expect(received).toEqual([received[0], socket, event, turn]);
  expect(received[0]).toBeInstanceOf(Actor);
});

test("forward inspection cannot be forged, altered, or paired with another constructor/profile", () => {
  class Actor {
    fetch() {
      return new Response("ok");
    }
    alarm() {}
    socketMessage() {}
    socketClose() {}
    socketError() {}
  }
  class Other extends Actor {}
  const namespace = { Actor };
  const profile = resolveActorAbiProfile(V2_REF);
  const inspection = prepareActorClassInspection({ namespace, exportName: "Actor", profile });
  const context = createActorContext({ id: "actor-1", storage: {}, alarm: {}, sockets: {} });
  const options = { namespace, exportName: "Actor", profile, context, env: {} };
  expect(() => createActorClassExecution({ ...options, inspection: { ...inspection } })).toThrow(
    ActorRuntimeError,
  );
  expect(() =>
    createActorClassExecution({ ...options, namespace: { Actor: Other }, inspection }),
  ).toThrow(ActorRuntimeError);
  expect(() =>
    createActorClassExecution({
      ...options,
      profile: resolveActorAbiProfile(LEGACY_REF),
      inspection,
    }),
  ).toThrow(ActorRuntimeError);
  expect(() =>
    createActorClassExecution({ ...options, profile: { ...profile }, inspection }),
  ).toThrow(ActorRuntimeError);
});
