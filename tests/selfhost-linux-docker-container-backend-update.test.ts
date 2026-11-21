import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT } from "../src/container-contract.ts";
import { isJsonObject } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { DockerHttpRevisionOptions } from "../src/providers/docker-http-revision.ts";
import { createSelfhostLinuxDockerContainerBackend } from "../src/selfhost-linux-docker-container-backend.ts";
import type { SelfhostLinuxDockerCoreSelection } from "../src/selfhost-linux-docker-core.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
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
        current: { id: "synthetic-update-transfer", key },
        keyForDecryption: (id) => (id === "synthetic-update-transfer" ? key : undefined),
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
  // A raw daemon network inventory contains attached endpoints, not a newly
  // created/stopped quarantine object. The existing single-container stdio model
  // remains unchanged; this view only projects its raw NETWORK response.
  const inventory = new Proxy(docker.containers, {
    get(target, key) {
      if (key === "values")
        return () =>
          [...target.values()]
            .filter((container) => {
              const settings = container.NetworkSettings;
              return (
                isJsonObject(settings) &&
                isJsonObject(settings.Networks) &&
                Object.hasOwn(settings.Networks, selection.docker.network)
              );
            })
            .values();
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const physical = createRawLinuxDockerStdio({
    containers: inventory,
    networkName: selection.docker.network,
    installationId: selection.installationId,
  });
  let expireNextUpdateRead = false;
  let loseNextCreateAck = false;
  let rawRequests = 0;
  const restoreHttp = interceptHttp(async (method, path, body) => {
    rawRequests++;
    if (expireNextUpdateRead && method === "GET") {
      expireNextUpdateRead = false;
      // Fault injection into the original live lease only, never accepted owner,
      // retained/drain rows or native identity. The actual engine owns reclamation.
      await sql.run(
        "UPDATE tf_v2_operations SET lease_until_ms=0 WHERE action='update' AND status IN ('running','reconciling')",
      );
    }
    if (method === "GET" && path === `/networks/${selection.docker.network}`)
      return { status: 200, body: JSON.stringify(physical.network()) };
    const response = await docker.engine(method, path, body);
    if (method === "POST" && path.startsWith("/containers/create?")) {
      const id: unknown = JSON.parse(response.body).Id;
      for (const [name, current] of docker.containers)
        if (current.Id === id)
          docker.containers.set(name, { ...current, NetworkSettings: { Networks: { none: {} } } });
      if (loseNextCreateAck) {
        loseNextCreateAck = false;
        // The original request really reached the raw daemon model. Lose only
        // its response; original lookup/claim binding must recover its identity.
        throw new Error("synthetic lost generation-two CREATE response");
      }
    }
    return response;
  });
  // Child object casts stop at the raw child_process transport boundary. The
  // production physical process/session/class and all authority remain original.
  let refusedUpdateOpens = 0;
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((
    file: string,
    args: readonly string[],
  ) => {
    const selected = args.indexOf("--container");
    if (selected >= 0 && args[selected + 1] !== "1".padStart(64, "0")) {
      refusedUpdateOpens++;
      throw new Error("synthetic generation-two raw helper open failure");
    }
    return physical.spawn(file, args);
  }) as unknown as typeof childProcess.spawn);
  if (!Object.is(importedSpawn, spawn)) {
    spawn.mockRestore();
    restoreHttp();
    database.close();
    throw new Error("raw stdio interception unavailable");
  }
  let healthRequests = 0;
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
        return new Response("", { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const executions: V2Execution[] = [];
  const backend = composition.retainedForm.backend;
  const observedForm = {
    ...composition.retainedForm,
    backend: {
      ...backend,
      execute(execution: V2Execution) {
        executions.push(execution);
        return backend.execute(execution);
      },
      reconcile(execution: V2Execution) {
        executions.push(execution);
        return backend.reconcile(execution);
      },
    },
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
            id: "synthetic-update-comparison",
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
      forms: { [composition.formUrl]: observedForm },
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
    executions,
    backend,
    rawRequests: () => rawRequests,
    refusedUpdateOpens: () => refusedUpdateOpens,
    expireNextUpdateRead() {
      expireNextUpdateRead = true;
    },
    loseNextCreateAck() {
      loseNextCreateAck = true;
    },
    async retry(id: string) {
      await sql.run("UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=?", [id]);
      return engine.runNext();
    },
    async create() {
      return engine.acceptCreate({
        principal: "synthetic-update-parent",
        key: crypto.randomUUID(),
        input: {
          form: composition.formUrl,
          space: "synthetic-space",
          name: "synthetic-update",
          spec: {
            [fields.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
            [fields.httpPort]: 8080,
            [fields.healthPath]: "/health",
            [fields.workloadRevision]: "1".repeat(64),
            [fields.environment]: { MODE: "synthetic-update" },
            [fields.requiredSensitiveVars]: ["SECRET"],
            [fields.outboundInternet]: true,
          },
          privateInputs: { SECRET: "synthetic-transient-input" },
        },
      });
    },
    async update(uid: string) {
      return engine.acceptUpdate({
        principal: "synthetic-update-parent",
        key: crypto.randomUUID(),
        uid,
        expectedGeneration: 1,
        spec: {
          [fields.image]: `registry.example/app@sha256:${"2".repeat(64)}`,
          [fields.httpPort]: 8080,
          [fields.healthPath]: "/health",
          [fields.workloadRevision]: "2".repeat(64),
          [fields.environment]: { MODE: "synthetic-update-generation-two" },
          [fields.requiredSensitiveVars]: ["SECRET"],
          [fields.outboundInternet]: true,
        },
        privateInputs: { SECRET: "synthetic-generation-two-transient" },
      });
    },
    async close() {
      try {
        const cleanup = await composition.close().then(
          () => null,
          (error: unknown) => error,
        );
        if (refusedUpdateOpens)
          expect(cleanup).toMatchObject({
            message: "linux_docker_runtime_preparation_unavailable",
          });
        else expect(cleanup).toBeNull();
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

// These are new UPDATE scenarios. Their genuine successful generation-one
// setup is necessary input, not a rerun/import of the frozen positive cohort.
async function serving(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.create();
  expect(await f.engine.runNext()).toMatchObject({
    id: created.id,
    status: "succeeded",
    effect: "complete",
  });
  expect(
    await f.sql.query(
      "SELECT desired_generation,serving_generation FROM tf_v2_container_instances",
    ),
  ).toEqual([{ desired_generation: 1, serving_generation: 1 }]);
  return created;
}

async function retainedOriginal(f: Awaited<ReturnType<typeof fixture>>) {
  expect(
    await f.sql.query(
      "SELECT desired_generation,serving_generation FROM tf_v2_container_instances",
    ),
  ).toEqual([{ desired_generation: 2, serving_generation: 1 }]);
  expect(
    await f.sql.query(
      "SELECT generation,retention FROM tf_v2_container_revisions ORDER BY generation",
    ),
  ).toEqual([
    { generation: 1, retention: "serving" },
    { generation: 2, retention: "accepted" },
  ]);
  expect(
    await f.sql.query(
      "SELECT generation,native_id,state FROM tf_v2_container_create_claims ORDER BY generation",
    ),
  ).toEqual([
    { generation: 1, native_id: "1".padStart(64, "0"), state: "bound" },
    { generation: 2, native_id: "2".padStart(64, "0"), state: "bound" },
  ]);
  expect(await f.sql.query("SELECT generation,state FROM tf_v2_container_start_attempts")).toEqual([
    { generation: 1, state: "running" },
  ]);
  expect(f.physical.starts()).toBe(1);
  expect(f.docker.creates()).toHaveLength(2);
  expect(f.docker.starts()).toHaveLength(0);
  expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  expect(f.docker.containers.size).toBe(2);
  expect(f.healthRequests()).toBe(1);
}

async function pendingOriginal(f: Awaited<ReturnType<typeof fixture>>) {
  expect(
    await f.sql.query(
      "SELECT desired_generation,serving_generation FROM tf_v2_container_instances",
    ),
  ).toEqual([{ desired_generation: 2, serving_generation: 1 }]);
  expect(
    await f.sql.query(
      "SELECT generation,retention FROM tf_v2_container_revisions ORDER BY generation",
    ),
  ).toEqual([
    { generation: 1, retention: "serving" },
    { generation: 2, retention: "accepted" },
  ]);
  expect(
    await f.sql.query(
      "SELECT generation,native_id,state FROM tf_v2_container_create_claims ORDER BY generation",
    ),
  ).toEqual([
    { generation: 1, native_id: "1".padStart(64, "0"), state: "bound" },
    { generation: 2, native_id: null, state: "pending" },
  ]);
  expect(await f.sql.query("SELECT generation,state FROM tf_v2_container_start_attempts")).toEqual([
    { generation: 1, state: "running" },
  ]);
  expect(f.physical.starts()).toBe(1);
  expect(f.docker.creates()).toHaveLength(1);
  expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  expect(f.docker.containers.size).toBe(1);
  expect(f.healthRequests()).toBe(1);
}

test("serving UPDATE helper uncertainty retains old native and reconciles without CREATE or START replay", async () => {
  const f = await fixture();
  try {
    const created = await serving(f);
    const updated = await f.update(created.resourceUid);
    expect(await f.engine.runNext()).toMatchObject({
      id: updated.id,
      generation: 2,
      status: "reconciling",
      effect: "unknown",
    });
    await retainedOriginal(f);
    const first = f.executions.find((execution) => execution.action === "update");
    if (!first) throw new Error("original UPDATE execution missing");
    expect(first.privateInputs).toEqual({ SECRET: "synthetic-generation-two-transient" });
    expect(await f.retry(updated.id)).toMatchObject({
      id: updated.id,
      status: "reconciling",
      effect: "unknown",
    });
    await retainedOriginal(f);
    const second = f.executions.filter((execution) => execution.action === "update")[1];
    if (!second) throw new Error("original reconcile execution missing");
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.backendKey).toBe(first.backendKey);
    expect(second.privateInputs).toBeUndefined();
    expect(f.refusedUpdateOpens()).toBe(1); // Original failed lifetime stays uncertain.
    const before = f.rawRequests();
    expect(await f.backend.reconcile(first)).toEqual({ kind: "unknown" });
    expect(await f.backend.reconcile({ ...second, action: "delete" })).toEqual({ kind: "unknown" });
    expect(f.rawRequests()).toBe(before);
    await retainedOriginal(f);
  } finally {
    await f.close();
  }
});

test("expired serving UPDATE lease fences its send and fresh reconciliation keeps the retained generation", async () => {
  const f = await fixture();
  try {
    const created = await serving(f);
    const updated = await f.update(created.resourceUid);
    f.expireNextUpdateRead();
    expect(await f.engine.runNext()).toMatchObject({
      id: updated.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.docker.creates()).toHaveLength(1);
    expect(f.physical.starts()).toBe(1);
    expect(f.refusedUpdateOpens()).toBe(0);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 1 },
    ]);
    const stale = f.executions.find((execution) => execution.action === "update");
    if (!stale) throw new Error("expired original UPDATE execution missing");
    expect(await f.retry(updated.id)).toMatchObject({
      id: updated.id,
      status: "reconciling",
      effect: "unknown",
    });
    const current = f.executions.filter((execution) => execution.action === "update")[1];
    if (!current) throw new Error("fresh original UPDATE execution missing");
    expect(current.leaseToken).not.toBe(stale.leaseToken);
    expect(current.backendKey).toBe(stale.backendKey);
    await pendingOriginal(f);
    const before = f.rawRequests();
    expect(await f.backend.execute(stale)).toEqual({ kind: "unknown" });
    expect(f.rawRequests()).toBe(before);
  } finally {
    await f.close();
  }
});

test("lost serving UPDATE CREATE response resolves original binding without replay or retained deletion", async () => {
  const f = await fixture();
  try {
    const created = await serving(f);
    const updated = await f.update(created.resourceUid);
    f.loseNextCreateAck();
    expect(await f.engine.runNext()).toMatchObject({
      id: updated.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(
      await f.sql.query(
        "SELECT generation,native_id,state FROM tf_v2_container_create_claims ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, native_id: "1".padStart(64, "0"), state: "bound" },
      { generation: 2, native_id: "2".padStart(64, "0"), state: "bound" },
    ]);
    expect(f.docker.creates()).toHaveLength(2);
    expect(f.refusedUpdateOpens()).toBe(1);
    // Original ensureCreated catches a genuinely lost ACK, checks the same
    // original claim/labels by name, and binds it in this first held scope.
    const create = f.docker.creates()[1];
    if (!create) throw new Error("original generation-two CREATE missing");
    const nativeName = new URL(create.path, "http://docker.invalid").searchParams.get("name");
    if (!nativeName) throw new Error("original generation-two native name missing");
    expect(f.docker.calls.slice(f.docker.calls.indexOf(create) + 1)).toContainEqual({
      method: "GET",
      path: `/containers/${nativeName}/json`,
    });
    expect(await f.retry(updated.id)).toMatchObject({
      id: updated.id,
      status: "reconciling",
      effect: "unknown",
    });
    await retainedOriginal(f);
    expect(f.refusedUpdateOpens()).toBe(1);
    const executions = f.executions.filter((execution) => execution.action === "update");
    expect(executions.map(({ operationId }) => operationId)).toEqual([updated.id, updated.id]);
    const [first, second] = executions;
    if (!first || !second) throw new Error("original UPDATE executions missing");
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.privateInputs).toBeUndefined();
  } finally {
    await f.close();
  }
});
