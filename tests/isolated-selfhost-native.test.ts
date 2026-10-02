import { expect, test } from "bun:test";
import {
  assertIsolatedSelfhostNativeObservation,
  type IsolatedSelfhostNativeObservation,
  parseIsolatedSelfhostNativeLinkObservation,
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

test("isolated self-host native link observation reads current-netns ip-link output, not sysfs", () => {
  expect(
    parseIsolatedSelfhostNativeLinkObservation(
      // An isolated netns returns only lo here even if its inherited sysfs mount exposes host links.
      "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\n",
    ),
  ).toEqual({ interfaces: ["lo"], loopbackIsUp: true });
  const extraInterface = parseIsolatedSelfhostNativeLinkObservation(
    "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n2: eth0@if5: <BROADCAST,UP,LOWER_UP> mtu 1500\n",
  );
  expect(extraInterface).toEqual({ interfaces: ["eth0", "lo"], loopbackIsUp: true });
  expect(() =>
    assertIsolatedSelfhostNativeObservation({
      ...safeObservation,
      ...extraInterface,
      occupiedPorts: [],
    }),
  ).toThrow("isolated_selfhost_native_loopback_only_required");

  const loopbackDown = parseIsolatedSelfhostNativeLinkObservation(
    "1: lo: <LOOPBACK,LOWER_UP> mtu 65536\n",
  );
  expect(loopbackDown).toEqual({ interfaces: ["lo"], loopbackIsUp: false });
  expect(() =>
    assertIsolatedSelfhostNativeObservation({
      ...safeObservation,
      ...loopbackDown,
      occupiedPorts: [],
    }),
  ).toThrow("isolated_selfhost_native_loopback_only_required");
  expect(() => parseIsolatedSelfhostNativeLinkObservation("broken output\n")).toThrow(
    "isolated_selfhost_native_network_observation_malformed",
  );
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
