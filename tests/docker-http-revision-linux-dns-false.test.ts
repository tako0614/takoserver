import { expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import {
  createDockerHttpRevisionRuntime,
  type DockerHttpRevisionOptions,
} from "../src/providers/docker-http-revision.ts";
import { createLinuxDockerCoreRuntime } from "../src/providers/linux-docker-core-runtime.ts";
import { LinuxDockerRuntimePreparation } from "../src/providers/linux-docker-runtime-preparation.ts";
import { CONTAINER_DOCKER_BACKEND_ID } from "../src/takoform-v2/forms/container-backend.ts";

function fixture(outboundInternet: boolean, dnsServers: readonly string[]) {
  const io: string[] = [];
  const refuse = (kind: string): never => {
    io.push(kind);
    throw new Error("dns_configuration_only_raw_io_refused");
  };
  const sql: Sql = {
    query: async () => refuse("sql.query"),
    run: async () => refuse("sql.run"),
    batch: async () => refuse("sql.batch"),
  };
  // Genuine original composition; no caller owner port or accepted/ready DTO.
  // Its raw IO refuses every operation. Construction grants no accepted scope.
  const core = createLinuxDockerCoreRuntime({
    sql,
    clock: () => new Date(0),
    installationId: "synthetic-linux-dns",
    backendId: CONTAINER_DOCKER_BACKEND_ID,
    targetKey: "synthetic-linux-dns-target",
  });
  const runtimePreparation = core.createRuntime({
    policy: {
      tenantRef: "synthetic-linux-dns-tenant",
      generation: 1,
      policyDigest: `sha256:${"a".repeat(64)}`,
      outboundInternet,
    },
    requiredSecretNames: [],
    process: {
      helper: "/synthetic/not-executed/helper",
      socketPath: "/synthetic/not-opened/docker.sock",
      peerPid: 1,
      peerUid: 0,
      ipBinary: "/synthetic/not-executed/ip",
      nftBinary: "/synthetic/not-executed/nft",
      guestNamespaceRoot: "/synthetic/not-opened/namespaces",
    },
    host: { tcpPorts: [8080], conntrackMark: 1, deniedDestinations: [] },
    dnsServers,
    maxConnections: 1,
    packetLimitBytes: 1,
  });
  const options: DockerHttpRevisionOptions = {
    socketPath: "/synthetic/not-opened/docker.sock",
    installationId: "synthetic-linux-dns",
    network: "synthetic-linux-dns-net",
    maxMemoryBytes: 1024,
    maxNanoCpus: 1_000_000,
    pidsLimit: 8,
    runtimePreparation,
    dnsServers: runtimePreparation.dnsServers,
    engine: async () => refuse("engine"),
    healthFetch: async () => refuse("health"),
  };
  return { runtimePreparation, options, io };
}

test("Linux outbound-false binds its genuine preparation's explicit empty DNS list without IO", () => {
  const sample = fixture(false, []);
  expect(sample.runtimePreparation).toBeInstanceOf(LinuxDockerRuntimePreparation);
  expect(sample.runtimePreparation.policy.outboundInternet).toBe(false);
  expect(sample.runtimePreparation.dnsServers).toEqual([]);
  expect(Object.isFrozen(sample.runtimePreparation.dnsServers)).toBe(true);
  expect(() => createDockerHttpRevisionRuntime(sample.options)).not.toThrow();
  expect(sample.io).toEqual([]);
});

test("Empty DNS still refuses unprepared, mismatched and malformed configurations before IO", () => {
  const empty = fixture(false, []);
  const selected = fixture(false, ["192.0.2.53"]);
  const { runtimePreparation: _preparation, ...unprepared } = empty.options;
  expect(() => createDockerHttpRevisionRuntime(unprepared)).toThrow("invalid_request");
  expect(() => createDockerHttpRevisionRuntime({ ...selected.options, dnsServers: [] })).toThrow(
    "invalid_request",
  );
  expect(() =>
    createDockerHttpRevisionRuntime({ ...empty.options, dnsServers: ["192.0.2.53"] }),
  ).toThrow("invalid_request");
  const malformed = { ...empty.options };
  Reflect.set(malformed, "dnsServers", "");
  expect(() => createDockerHttpRevisionRuntime(malformed)).toThrow("invalid_request");
  expect(empty.io).toEqual([]);
  expect(selected.io).toEqual([]);
});

test("Linux Internet preparation retains explicit numeric DNS and rejects absent or empty DNS", () => {
  const sample = fixture(true, ["192.0.2.53"]);
  expect(() => createDockerHttpRevisionRuntime(sample.options)).not.toThrow();
  expect(() => createDockerHttpRevisionRuntime({ ...sample.options, dnsServers: [] })).toThrow(
    "invalid_request",
  );
  const { dnsServers: _dnsServers, ...withoutDns } = sample.options;
  expect(() => createDockerHttpRevisionRuntime(withoutDns)).toThrow("invalid_request");
  expect(sample.io).toEqual([]);
});

test("Linux empty DNS binding rejects prototype-shaped preparations while genuine construction remains accepted", () => {
  const sample = fixture(false, []);
  const shaped: object = Object.create(LinuxDockerRuntimePreparation.prototype);
  Object.defineProperties(shaped, {
    policy: { value: sample.runtimePreparation.policy },
    dnsServers: { value: sample.runtimePreparation.dnsServers },
  });
  Object.freeze(shaped);
  expect(shaped).toBeInstanceOf(LinuxDockerRuntimePreparation);
  expect(Object.isFrozen(shaped)).toBe(true);
  const options = { ...sample.options };
  Reflect.set(options, "runtimePreparation", shaped);
  expect(() => createDockerHttpRevisionRuntime(options)).toThrow("invalid_request");
  expect(() => createDockerHttpRevisionRuntime(sample.options)).not.toThrow();
  expect(sample.io).toEqual([]);
});
