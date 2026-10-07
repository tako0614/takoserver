import { expect, test } from "bun:test";
import { parseSelfhostV2WorkerEndpointHttpsSelection } from "../src/entry-v2-worker-endpoint-boot.ts";

const BASE = {
  workerEndpointSuffix: "workers.example.test",
  tlsConfigured: true,
  containerEndpointHttpsConfigured: false,
  reservedPorts: [8787, 8788, 9001],
} as const;

test("v2 Worker Endpoint HTTPS is disabled unless explicitly selected", () => {
  expect(parseSelfhostV2WorkerEndpointHttpsSelection(undefined, BASE)).toBeUndefined();
});

test("explicit v2 Worker Endpoint HTTPS reuses the configured suffix and fixed port 443", () => {
  expect(parseSelfhostV2WorkerEndpointHttpsSelection("1", BASE)).toEqual({
    workerEndpointSuffix: "workers.example.test",
    port: 443,
  });
});

test("v2 Worker Endpoint HTTPS rejects incomplete authority and existing listener collisions", () => {
  for (const selection of ["true", "0", " 1", "1 ", "{}"] as const) {
    expect(() => parseSelfhostV2WorkerEndpointHttpsSelection(selection, BASE)).toThrow(
      "TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS must be exactly 1",
    );
  }
  expect(() =>
    parseSelfhostV2WorkerEndpointHttpsSelection("1", { ...BASE, tlsConfigured: false }),
  ).toThrow("requires the existing Worker TLS certificate and key");
  expect(() =>
    parseSelfhostV2WorkerEndpointHttpsSelection("1", {
      ...BASE,
      workerEndpointSuffix: undefined,
    }),
  ).toThrow("requires TAKOSERVER_WORKER_ENDPOINT_SUFFIX");
  expect(() =>
    parseSelfhostV2WorkerEndpointHttpsSelection("1", {
      ...BASE,
      containerEndpointHttpsConfigured: true,
    }),
  ).toThrow("conflicts with the existing Container Endpoint HTTPS listener");
  expect(() =>
    parseSelfhostV2WorkerEndpointHttpsSelection("1", {
      ...BASE,
      reservedPorts: [443],
    }),
  ).toThrow("TCP 443 is already assigned to another self-host listener");
});

test("v2 Worker Endpoint HTTPS requires the exact canonical one-label DNS suffix", () => {
  for (const workerEndpointSuffix of [
    "Workers.example.test",
    "workers.example.test.",
    "localhost",
    "127.0.0.1",
    "bad_suffix.example.test",
    "a..example.test",
  ]) {
    expect(() =>
      parseSelfhostV2WorkerEndpointHttpsSelection("1", { ...BASE, workerEndpointSuffix }),
    ).toThrow("TAKOSERVER_WORKER_ENDPOINT_SUFFIX must be a canonical DNS suffix");
  }
});
