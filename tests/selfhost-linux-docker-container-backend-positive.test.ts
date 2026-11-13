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
import { engineDouble } from "./helpers/docker-container-configured-owner-snapshot.ts";
import { SOURCE_SELECTION } from "./helpers/docker-container-configured-source-selection.ts";
import { createRawLinuxDockerStdio } from "./helpers/linux-docker-raw-stdio.ts";

type Engine = NonNullable<DockerHttpRevisionOptions["engine"]>;

// Raw Node HTTP transport only: original request encoding, deadlines, status and
// body parsing stay in production. No Docker engine option/factory is replaced.
function interceptHttp(raw: Engine) {
  const installed = spyOn(http, "request").mockImplementation(((
    options: http.RequestOptions,
    receive: (response: http.IncomingMessage) => void,
  ) => {
    class MemoryRequest extends EventEmitter {
      destroyed = false;
      destroy(error?: Error): this {
        if (this.destroyed) return this;
        this.destroyed = true;
        if (error) this.emit("error", error);
        this.emit("close");
        return this;
      }
      end(body?: string): this {
        void Promise.resolve()
          .then(async () => {
            const response = await raw(
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
            this.destroy(error instanceof Error ? error : new Error("raw HTTP failure")),
          );
        return this;
      }
    }
    return new MemoryRequest() as unknown as http.ClientRequest;
  }) as typeof http.request);
  if (!Object.is(importedRequest, installed)) {
    installed.mockRestore();
    throw new Error("raw HTTP interception unavailable");
  }
  return () => installed.mockRestore();
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
        current: { id: "synthetic-positive-transfer", key },
        keyForDecryption: (id) => (id === "synthetic-positive-transfer" ? key : undefined),
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
  const physical = createRawLinuxDockerStdio({
    containers: docker.containers,
    networkName: selection.docker.network,
    installationId: selection.installationId,
  });
  const restoreHttp = interceptHttp(async (method, path, body) => {
    if (method === "GET" && path === `/networks/${selection.docker.network}`)
      return { status: 200, body: JSON.stringify(physical.network()) };
    const response = await docker.engine(method, path, body);
    if (method === "POST" && path.startsWith("/containers/create?")) {
      const id: unknown = JSON.parse(response.body).Id;
      for (const [name, current] of docker.containers)
        if (current.Id === id)
          docker.containers.set(name, { ...current, NetworkSettings: { Networks: { none: {} } } });
    }
    return response;
  });
  // Child object casts stop at the raw child_process transport boundary. The
  // production physical process/session/class and all authority remain original.
  const spawn = spyOn(childProcess, "spawn").mockImplementation(
    physical.spawn as unknown as typeof childProcess.spawn,
  );
  if (!Object.is(importedSpawn, spawn)) {
    spawn.mockRestore();
    restoreHttp();
    database.close();
    throw new Error("raw stdio interception unavailable");
  }
  let healthRequests = 0;
  let corruptAtHealth = false;
  // Default production healthFetch still creates and evaluates its own Request,
  // Response.ok and post-response guard. This intercepts only global HTTP IO;
  // it is not an injected healthFetch/ready/verify callback.
  const originalFetch = globalThis.fetch;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (request: Parameters<typeof originalFetch>[0]) => {
        if (
          !(request instanceof Request) ||
          request.url !== "http://172.22.0.2:8080/health" ||
          request.redirect !== "manual" ||
          request.signal.aborted
        )
          throw new Error("unexpected raw HTTP destination");
        healthRequests++;
        if (corruptAtHealth) physical.corruptGuestRead();
        return new Response("", { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const engine = createTakoformV2Engine(
    {
      sql,
      authorize: async () => true,
      replayWindowSeconds: 3600,
      privateInputCustody: {
        transfer: { current: selection.configuredInputs.keyring.current },
        comparison: {
          current: {
            id: "synthetic-positive-comparison",
            key: await crypto.subtle.generateKey(
              { name: "HMAC", hash: "SHA-256", length: 256 },
              false,
              ["sign", "verify"],
            ),
          },
        },
        transferTtlSeconds: 300,
      },
      // Local registration of the actual Form object only. Public support and the
      // entry's undefined operator selection are untouched.
      forms: { [composition.formUrl]: composition.retainedForm },
    },
    composition.acceptance,
  );
  const fields = CONTAINER_CONTRACT.fields;
  return {
    sql,
    docker,
    physical,
    engine,
    healthRequests: () => healthRequests,
    corruptAtHealth() {
      corruptAtHealth = true;
    },
    async create() {
      return engine.acceptCreate({
        principal: "synthetic-positive-parent",
        key: crypto.randomUUID(),
        input: {
          form: composition.formUrl,
          space: "synthetic-space",
          name: "synthetic-positive",
          spec: {
            [fields.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
            [fields.httpPort]: 8080,
            [fields.healthPath]: "/health",
            [fields.workloadRevision]: "1".repeat(64),
            [fields.environment]: { MODE: "synthetic-positive" },
            [fields.requiredSensitiveVars]: ["SECRET"],
            [fields.outboundInternet]: true,
          },
          privateInputs: { SECRET: "synthetic-transient-input" },
        },
      });
    },
    async remove(uid: string) {
      return engine.acceptDelete({
        principal: "synthetic-positive-parent",
        key: crypto.randomUUID(),
        uid,
        expectedGeneration: 1,
      });
    },
    async close() {
      try {
        await composition.close();
      } finally {
        fetch.mockRestore();
        spawn.mockRestore();
        restoreHttp();
        database.close();
      }
      expect(physical.liveChildren()).toBe(0);
    },
  };
}

test("raw stdio reaches original START, fresh same-Sql completion and retained DELETE", async () => {
  const f = await fixture();
  try {
    const accepted = await f.create();
    const operation = await f.engine.runNext();
    expect(operation).toMatchObject({ id: accepted.id, status: "succeeded", effect: "complete" });
    expect(f.physical.starts()).toBe(1);
    expect(f.docker.starts()).toHaveLength(0); // START is the quarantined original physical path.
    expect(f.healthRequests()).toBe(1);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 1 },
    ]);
    expect(await f.sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "bound", native_id: "1".padStart(64, "0") },
    ]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 1 },
    ]);
    expect(f.physical.commands).toContain("container:ARMGUEST");
    expect(f.physical.commands).toContain("control:CONNECTOWNED");
    expect(f.docker.creates()).toHaveLength(1);
    const deletion = await f.remove(accepted.resourceUid);
    expect(await f.engine.runNext()).toMatchObject({
      id: deletion.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(await f.sql.query("SELECT state FROM tf_v2_container_create_claims")).toEqual([
      { state: "removed" },
    ]);
    expect(f.docker.containers.size).toBe(0);
    expect(f.physical.starts()).toBe(1);
    expect(f.docker.creates()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("raw HTTP 200 cannot publish after the original guest readback stops matching", async () => {
  const f = await fixture();
  try {
    f.corruptAtHealth();
    await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(f.physical.starts()).toBe(1);
    expect(f.healthRequests()).toBe(1);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    expect(f.docker.creates()).toHaveLength(1);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 1 },
    ]);
  } finally {
    await f.close();
  }
});
