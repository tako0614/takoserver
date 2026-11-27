import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { DockerHttpRevisionOptions } from "../src/providers/docker-http-revision.ts";
import { createSelfhostLinuxDockerContainerBackend } from "../src/selfhost-linux-docker-container-backend.ts";
import type { SelfhostLinuxDockerCoreSelection } from "../src/selfhost-linux-docker-core.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";
import { engineDouble } from "./helpers/docker-container-configured-owner-snapshot.ts";
import { SOURCE_SELECTION } from "./helpers/docker-container-configured-source-selection.ts";

type Engine = NonNullable<DockerHttpRevisionOptions["engine"]>;

// Raw IO only: the real transport still serializes requests and checks deadlines.
// A named-import identity guard prevents fallback to a real Docker socket.
function interceptRawHttp(engine: Engine) {
  const intercepted = spyOn(http, "request").mockImplementation(((
    options: http.RequestOptions,
    receive: (response: http.IncomingMessage) => void,
  ) => {
    class MemoryRequest extends EventEmitter {
      destroyed = false;
      destroy(error?: Error): this {
        if (!this.destroyed) {
          this.destroyed = true;
          if (error) this.emit("error", error);
          this.emit("close");
        }
        return this;
      }
      end(body?: string): this {
        void Promise.resolve()
          .then(async () => {
            const response = await engine(
              String(options.method),
              String(options.path).replace(/^\/v1\.51/u, ""),
              body === undefined ? undefined : JSON.parse(body),
            );
            if (this.destroyed) return;
            const incoming = Object.assign(new EventEmitter(), { statusCode: response.status });
            receive(incoming as unknown as http.IncomingMessage);
            incoming.emit("data", Buffer.from(response.body));
            incoming.emit("end");
            this.destroy();
          })
          .catch((error: unknown) =>
            this.destroy(error instanceof Error ? error : new Error("synthetic transport failure")),
          );
        return this;
      }
    }
    return new MemoryRequest() as unknown as http.ClientRequest;
  }) as typeof http.request);
  if (importedRequest !== intercepted) {
    intercepted.mockRestore();
    throw new Error("raw HTTP interception unavailable");
  }
  return () => intercepted.mockRestore();
}

async function fixture() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const selection: SelfhostLinuxDockerCoreSelection = {
    installationId: SOURCE_SELECTION.providerInstallationId,
    backendId: SOURCE_SELECTION.backendId,
    targetKey: SOURCE_SELECTION.targetKey,
    configuredInputs: {
      keyring: {
        current: { id: "synthetic-backend-key", key },
        keyForDecryption: (id) => (id === "synthetic-backend-key" ? key : undefined),
      },
      maxSecretBytes: 4096,
    },
    runtime: {
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
      dnsServers: ["192.0.2.53"],
      maxConnections: 4,
      packetLimitBytes: 4096,
    },
    docker: {
      network: "synthetic-docker-network",
      maxMemoryBytes: 256 * 1024 * 1024,
      maxNanoCpus: 500_000_000,
      pidsLimit: 128,
    },
  };
  const composition = createSelfhostLinuxDockerContainerBackend({
    sql,
    clock: () => new Date(),
    selection,
  });
  const docker = engineDouble();
  let rawRequests = 0;
  let createAttempts = 0;
  let helperAttempts = 0;
  let raw: Engine = async (method, path, body) => {
    const response = await docker.engine(method, path, body);
    if (path === `/networks/${selection.docker.network}`)
      return {
        ...response,
        body: JSON.stringify({ ...JSON.parse(response.body), Internal: false }),
      };
    if (method === "POST" && path.startsWith("/containers/create?")) {
      const id: unknown = JSON.parse(response.body).Id;
      // Linux CREATE uses quarantine NetworkMode none. Retain the actual raw
      // daemon body/labels/secret environment, changing only generic-double network metadata.
      for (const [name, current] of docker.containers)
        if (current.Id === id)
          docker.containers.set(name, { ...current, NetworkSettings: { Networks: { none: {} } } });
    }
    return response;
  };
  const standardRaw = raw;
  const restoreHttp = interceptRawHttp((...args) => {
    rawRequests++;
    if (args[0] === "POST" && args[1].startsWith("/containers/create?")) createAttempts++;
    return raw(...args);
  });
  const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
    helperAttempts++;
    throw new Error("synthetic raw helper open failure");
  });
  if (!Object.is(importedSpawn, spawn)) {
    spawn.mockRestore();
    restoreHttp();
    database.close();
    throw new Error("raw helper interception unavailable");
  }
  const executions: V2Execution[] = [];
  const results: V2BackendResult[] = [];
  const backend = composition.retainedForm.backend;
  // Only observe the genuine original backend call/result; do not manufacture a
  // result, replace its authority/validator/class or call a substitute factory.
  const observe = async (execution: V2Execution, reconcile: boolean) => {
    executions.push(execution);
    const result = await (reconcile ? backend.reconcile(execution) : backend.execute(execution));
    results.push(result);
    return result;
  };
  const engine = createTakoformV2Engine(
    {
      sql,
      authorize: async () => true,
      replayWindowSeconds: 3600,
      privateInputCustody: {
        transfer: { current: selection.configuredInputs.keyring.current },
        comparison: {
          current: {
            id: "synthetic-backend-comparison",
            key: await crypto.subtle.generateKey(
              { name: "HMAC", hash: "SHA-256", length: 256 },
              false,
              ["sign", "verify"],
            ),
          },
        },
        transferTtlSeconds: 300,
      },
      // Test-local acceptance only. No product public Form map is changed.
      forms: {
        [composition.formUrl]: {
          ...composition.retainedForm,
          backend: {
            ...backend,
            execute: (execution) => observe(execution, false),
            reconcile: (execution) => observe(execution, true),
          },
        },
      },
    },
    composition.acceptance,
  );
  const fields = CONTAINER_CONTRACT.fields;
  const spec = {
    [fields.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
    [fields.httpPort]: 8080,
    [fields.healthPath]: "/health",
    [fields.workloadRevision]: "1".repeat(64),
    [fields.environment]: { MODE: "synthetic-backend" },
    [fields.requiredSensitiveVars]: ["SECRET"],
    [fields.outboundInternet]: true,
  };
  return {
    database,
    sql,
    composition,
    docker,
    spec,
    engine,
    executions,
    results,
    standardRaw,
    raw(fn: Engine) {
      raw = fn;
    },
    rawRequests: () => rawRequests,
    createAttempts: () => createAttempts,
    helperAttempts: () => helperAttempts,
    async create() {
      return engine.acceptCreate({
        principal: "synthetic-backend-parent",
        key: crypto.randomUUID(),
        input: {
          form: composition.formUrl,
          space: "synthetic-space",
          name: "synthetic-backend",
          spec,
          privateInputs: { SECRET: "synthetic-transient-input" },
        },
      });
    },
    async retry() {
      await sql.run("UPDATE tf_v2_operations SET next_attempt_at_ms=0");
      return engine.runNext();
    },
    async close() {
      try {
        const cleanup = await composition.close().then(
          () => null,
          (error: unknown) => error,
        );
        // A refused raw helper open also remains a failed original runtime lifetime;
        // cleanup rejection is retained, never relabeled a successful native close.
        if (helperAttempts > 0)
          expect(cleanup).toMatchObject({
            message: "linux_docker_runtime_preparation_unavailable",
          });
        else expect(cleanup).toBeNull();
      } finally {
        spawn.mockRestore();
        restoreHttp();
        database.close();
      }
    },
  };
}

test("candidate reuses the full F2 validator and original same-Sql acceptance", async () => {
  const f = await fixture();
  try {
    const form = f.composition.retainedForm;
    expect(() => form.validateCreate(f.spec)).not.toThrow();
    expect(() =>
      form.validateCreate({ ...f.spec, image: "registry.example/app:latest" }),
    ).toThrow();
    expect(() => form.validateCreate({ ...f.spec, outboundInternet: "true" })).toThrow();
    expect(() =>
      form.validateCreate({ ...f.spec, environment: { SECRET: "public collision" } }),
    ).toThrow();
    expect(() => form.privateInputs?.validateCreate(f.spec, undefined)).toThrow();
    expect(() => form.privateInputs?.validateCreate(f.spec, { OTHER: "synthetic" })).toThrow();
    expect(() => form.privateInputs?.validateCreate(f.spec, { SECRET: "synthetic" })).not.toThrow();
    f.composition.acceptance.assertSql(f.sql);
    expect(() => f.composition.acceptance.assertSql({ ...f.sql })).toThrow();
    expect(f.rawRequests()).toBe(0);
    expect(f.helperAttempts()).toBe(0);
  } finally {
    await f.close();
  }
});

test("normal accepted dispatch binds known CREATE but raw helper failure never publishes or replays START", async () => {
  const f = await fixture();
  try {
    const operation = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: operation.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.results).toEqual([{ kind: "unknown" }]);
    expect(f.createAttempts()).toBe(1);
    expect(f.docker.creates()).toHaveLength(1);
    expect(f.helperAttempts()).toBe(1);
    expect(
      await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims"),
    ).toMatchObject([{ state: "bound", native_id: "1".padStart(64, "0") }]);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    expect(await f.sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual([]);
    expect(await f.retry()).toMatchObject({
      id: operation.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.results).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
    expect(f.createAttempts()).toBe(1);
    expect(f.docker.starts()).toHaveLength(0);
    expect(f.executions[0]?.backendKey).toBe(f.executions[1]?.backendKey);
    expect(f.executions[0]?.leaseToken).not.toBe(f.executions[1]?.leaseToken);
  } finally {
    await f.close();
  }
});

test("unknown CREATE dispatch remains the original pending claim without a second send", async () => {
  const f = await fixture();
  try {
    f.raw(async (method, path, body) => {
      if (method === "POST" && path.startsWith("/containers/create?"))
        throw new Error("synthetic lost CREATE response");
      return f.standardRaw(method, path, body);
    });
    const operation = await f.create();
    await f.engine.runNext();
    await f.retry();
    expect(f.results).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
    expect(f.createAttempts()).toBe(1);
    expect(await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "pending", native_id: null },
    ]);
    expect(f.docker.creates()).toHaveLength(0);
    expect(f.docker.starts()).toHaveLength(0);
    expect(f.helperAttempts()).toBe(0);
    expect(f.executions.map((execution) => execution.operationId)).toEqual([
      operation.id,
      operation.id,
    ]);
  } finally {
    await f.close();
  }
});

test("original lease revocation during native read refuses effect and stale or forged deletion", async () => {
  const f = await fixture();
  try {
    let revoked = false;
    f.raw(async (method, path, body) => {
      if (!revoked) {
        revoked = true;
        await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms=0");
      }
      return f.standardRaw(method, path, body);
    });
    await f.create();
    await f.engine.runNext();
    expect(revoked).toBe(true);
    expect(f.results).toEqual([{ kind: "unknown" }]);
    expect(f.createAttempts()).toBe(0);
    expect(f.helperAttempts()).toBe(0);
    const execution = f.executions[0];
    if (!execution) throw new Error("original dispatch missing");
    const before = f.rawRequests();
    expect(await f.composition.retainedForm.backend.execute(execution)).toEqual({
      kind: "unknown",
    });
    expect(
      await f.composition.retainedForm.backend.execute({ ...execution, action: "delete" }),
    ).toEqual({ kind: "unknown" });
    expect(
      await f.composition.retainedForm.backend.reconcile({
        ...execution,
        principal: "synthetic-other-parent",
      }),
    ).toEqual({ kind: "unknown" });
    expect(f.rawRequests()).toBe(before);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(f.docker.starts()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
