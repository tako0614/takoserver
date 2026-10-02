import { expect, test } from "bun:test";
import {
  assertIsolatedSelfhostNativeObservation,
  type IsolatedSelfhostNativeObservation,
} from "./helpers/isolated-selfhost-native.ts";

const safeObservation: IsolatedSelfhostNativeObservation = {
  selfNetworkNamespace: 42,
  initNetworkNamespace: 7,
  interfaces: ["lo"],
  loopbackIsUp: true,
  occupiedPorts: [],
};

test("isolated self-host native precondition accepts loopback-only namespace separation", () => {
  expect(() => assertIsolatedSelfhostNativeObservation(safeObservation)).not.toThrow();
});

test("isolated self-host native precondition rejects the caller network namespace", () => {
  expect(() =>
    assertIsolatedSelfhostNativeObservation({
      ...safeObservation,
      initNetworkNamespace: safeObservation.selfNetworkNamespace,
    }),
  ).toThrow("isolated_selfhost_native_network_namespace_required");
});

test("isolated self-host native precondition rejects a non-loopback interface", () => {
  expect(() =>
    assertIsolatedSelfhostNativeObservation({
      ...safeObservation,
      interfaces: ["eth0", "lo"],
    }),
  ).toThrow("isolated_selfhost_native_loopback_only_required");
});

test("isolated self-host native precondition rejects an occupied fixed port", () => {
  expect(() =>
    assertIsolatedSelfhostNativeObservation({
      ...safeObservation,
      occupiedPorts: [8787],
    }),
  ).toThrow("isolated_selfhost_native_fixed_port_occupied");
});

test("isolated self-host native precondition rejects an exited owned child", () => {
  expect(() =>
    assertIsolatedSelfhostNativeObservation({
      ...safeObservation,
      ownedChildExitCode: 1,
    }),
  ).toThrow("isolated_selfhost_native_owned_child_exited");
});
