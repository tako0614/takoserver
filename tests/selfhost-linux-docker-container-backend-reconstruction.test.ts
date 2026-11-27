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
import {
  createSelfhostLinuxDockerContainerBackend,
  type SelfhostLinuxDockerContainerBackend,
} from "../src/selfhost-linux-docker-container-backend.ts";
import type { SelfhostLinuxDockerCoreSelection } from "../src/selfhost-linux-docker-core.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";
import { engineDouble } from "./helpers/docker-container-configured-owner-snapshot.ts";
import { SOURCE_SELECTION } from "./helpers/docker-container-configured-source-selection.ts";
import { createRawLinuxDockerStdio } from "./helpers/linux-docker-raw-stdio.ts";

type Engine = NonNullable<DockerHttpRevisionOptions["engine"]>;
type ServingInterleaving =
  | "commit-held"
  | "old-read-held"
  | "old-read-error"
  | "ack-lost"
  | "wrong-epoch";

function latch() {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}

const updateNativeId = "2".repeat(64);

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

async function fixture(fault: "helper-open" | "health-response" = "helper-open") {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const baseSql = createSqliteSql(database);
  const oldRead = { capture: false, entered: latch(), complete: latch() };
  let servingInterleaving: ServingInterleaving | undefined;
  let servingWrites = 0;
  const sql: typeof baseSql = {
    ...baseSql,
    async query(query, params) {
      const rows = await baseSql.query(query, params);
      if (
        oldRead.capture &&
        params?.[1] === 2 &&
        query.includes("i.runtime_epoch AS i_runtime_epoch") &&
        query.endsWith(" WHERE i.resource_uid=? AND v.generation=?")
      ) {
        oldRead.capture = false;
        oldRead.entered.release();
        await oldRead.complete.waiting;
        if (servingInterleaving === "old-read-error")
          throw new Error("synthetic owner read failed during serving publication");
      }
      return rows;
    },
    async batch(statements) {
      const result = await baseSql.batch(statements);
      const publish = statements.find(
        ({ sql, params }) =>
          sql.startsWith(
            "UPDATE tf_v2_container_instances SET serving_generation=?,runtime_epoch=runtime_epoch+1 ",
          ) && params?.[0] === 2,
      );
      if (servingInterleaving && publish) {
        servingWrites++;
        if (servingInterleaving === "commit-held") await Bun.sleep(425);
        if (servingInterleaving === "ack-lost")
          throw new Error("synthetic serving publication acknowledgement lost");
        if (servingInterleaving === "wrong-epoch") {
          await baseSql.run(
            "UPDATE tf_v2_container_instances SET runtime_epoch=runtime_epoch+1 WHERE resource_uid=?",
            [publish.params?.[1] ?? null],
          );
        }
      }
      return result;
    },
  };
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const comparisonKey = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
  const selection: SelfhostLinuxDockerCoreSelection = {
    installationId: SOURCE_SELECTION.providerInstallationId,
    backendId: SOURCE_SELECTION.backendId,
    targetKey: SOURCE_SELECTION.targetKey,
    configuredInputs: {
      keyring: {
        current: { id: "synthetic-reconstruction-transfer", key },
        keyForDecryption: (id) => (id === "synthetic-reconstruction-transfer" ? key : undefined),
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
  const clock = () => new Date();
  const custody = {
    transfer: { current: selection.configuredInputs.keyring.current },
    comparison: { current: { id: "synthetic-reconstruction-comparison", key: comparisonKey } },
    transferTtlSeconds: 300,
  };
  let composition = createSelfhostLinuxDockerContainerBackend({ sql, clock, selection });
  const docker = engineDouble();
  const inventory = new Proxy(docker.containers, {
    get(target, name) {
      if (name === "values")
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
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const physical = createRawLinuxDockerStdio({
    containers: inventory,
    networkName: selection.docker.network,
    installationId: selection.installationId,
  });
  let creates = 0,
    rawRequests = 0;
  const restoreHttp = interceptHttp(async (method, path, body) => {
    rawRequests++;
    if (method === "GET" && path === `/networks/${selection.docker.network}`)
      return { status: 200, body: JSON.stringify(physical.network()) };
    const response = await docker.engine(method, path, body);
    if (method !== "POST" || !path.startsWith("/containers/create?")) return response;
    const received: unknown = JSON.parse(response.body).Id;
    // Daemon-generated distinct IDs must have distinct nft table prefixes. Keep
    // the actual outgoing names/labels/claim/environment and only model raw IDs.
    const nativeId = String(++creates).repeat(64);
    for (const [name, current] of docker.containers)
      if (current.Id === received)
        docker.containers.set(name, {
          ...current,
          Id: nativeId,
          NetworkSettings: { Networks: { none: {} } },
        });
    return { ...response, body: JSON.stringify({ Id: nativeId }) };
  });
  let updateOpenAllowed = fault === "health-response",
    failedUpdateOpens = 0;
  let updateHealthAvailable = fault !== "health-response";
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((
    file: string,
    args: readonly string[],
  ) => {
    const selected = args.indexOf("--container");
    if (selected >= 0 && args[selected + 1] === "2".repeat(64) && !updateOpenAllowed) {
      failedUpdateOpens++;
      throw new Error("synthetic generation-two helper temporarily absent");
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
  const originalFetch = globalThis.fetch;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (request: Parameters<typeof originalFetch>[0]) => {
        if (
          !(request instanceof Request) ||
          request.redirect !== "manual" ||
          request.signal.aborted
        )
          throw new Error("unexpected raw health request");
        const known = [...docker.containers.values()].find((container) => {
          const settings = container.NetworkSettings,
            state = container.State;
          if (
            !isJsonObject(settings) ||
            !isJsonObject(settings.Networks) ||
            !isJsonObject(state) ||
            state.Running !== true
          )
            return false;
          const attached = settings.Networks[selection.docker.network];
          return (
            isJsonObject(attached) &&
            request.url === `http://${String(attached.IPAddress)}:8080/health`
          );
        });
        if (!known) throw new Error("unknown raw health destination");
        healthRequests++;
        if (
          known.Id === updateNativeId &&
          (servingInterleaving === "old-read-held" || servingInterleaving === "old-read-error")
        ) {
          // The main execution is awaiting this response. Only the previously
          // armed runtime monitor can start the selected gen2 owner read.
          oldRead.capture = true;
          await Promise.race([
            oldRead.entered.waiting,
            Bun.sleep(800).then(() => {
              throw new Error("runtime monitor did not start its owner read");
            }),
          ]);
        }
        return new Response("", {
          status: known.Id === updateNativeId && !updateHealthAvailable ? 503 : 200,
        });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const executions: V2Execution[] = [];
  let observeResult:
    | ((
        execution: V2Execution,
        original: SelfhostLinuxDockerContainerBackend,
        result: V2BackendResult,
      ) => Promise<void>)
    | undefined;
  const bindEngine = (candidate: SelfhostLinuxDockerContainerBackend) => {
    const backend = candidate.retainedForm.backend;
    return createTakoformV2Engine(
      {
        sql,
        authorize: async () => true,
        replayWindowSeconds: 3600,
        privateInputCustody: custody,
        forms: {
          [candidate.formUrl]: {
            ...candidate.retainedForm,
            backend: {
              ...backend,
              execute(execution: V2Execution) {
                executions.push(execution);
                const running = backend.execute(execution);
                const observer = observeResult;
                return observer
                  ? running.then(async (result) => {
                      await observer(execution, candidate, result);
                      return result;
                    })
                  : running;
              },
              reconcile(execution: V2Execution) {
                executions.push(execution);
                const running = backend.reconcile(execution);
                const observer = observeResult;
                return observer
                  ? running.then(async (result) => {
                      await observer(execution, candidate, result);
                      return result;
                    })
                  : running;
              },
            },
          },
        },
      },
      candidate.acceptance,
    );
  };
  let engine = bindEngine(composition);
  const fields = CONTAINER_CONTRACT.fields;
  const spec = (generation: number) => ({
    [fields.image]: `registry.example/app@sha256:${String(generation).repeat(64)}`,
    [fields.httpPort]: 8080,
    [fields.healthPath]: "/health",
    [fields.workloadRevision]: String(generation).repeat(64),
    [fields.environment]: { MODE: `synthetic-generation-${generation}` },
    [fields.requiredSensitiveVars]: ["SECRET"],
    [fields.outboundInternet]: true,
  });
  return {
    sql,
    docker,
    physical,
    executions,
    get engine() {
      return engine;
    },
    get backend() {
      return composition.retainedForm.backend;
    },
    get composition() {
      return composition;
    },
    observeResults(observer: typeof observeResult) {
      observeResult = observer;
    },
    rawRequests: () => rawRequests,
    failedUpdateOpens: () => failedUpdateOpens,
    healthRequests: () => healthRequests,
    interleaveServing(mode: ServingInterleaving | undefined) {
      servingInterleaving = mode;
    },
    servingWrites: () => servingWrites,
    releaseOldServingRead: oldRead.complete.release,
    create() {
      return engine.acceptCreate({
        principal: "synthetic-reconstruction-parent",
        key: crypto.randomUUID(),
        input: {
          form: composition.formUrl,
          space: "synthetic-space",
          name: "synthetic-reconstruction",
          spec: spec(1),
          privateInputs: { SECRET: "synthetic-generation-one" },
        },
      });
    },
    update(uid: string) {
      return engine.acceptUpdate({
        principal: "synthetic-reconstruction-parent",
        key: crypto.randomUUID(),
        uid,
        expectedGeneration: 1,
        spec: spec(2),
        privateInputs: { SECRET: "synthetic-generation-two" },
      });
    },
    async reconstruct() {
      // Each caller already awaited original engine settlement. Await complete
      // original close (including errors) before constructing another owner.
      const previous = composition;
      const closed = await previous.close().then(
        () => null,
        (error: unknown) => error,
      );
      expect(physical.liveChildren()).toBe(0);
      updateOpenAllowed = true;
      updateHealthAvailable = true;
      composition = createSelfhostLinuxDockerContainerBackend({ sql, clock, selection });
      engine = bindEngine(composition);
      return { closed, backend: previous.retainedForm.backend };
    },
    async retry(id: string) {
      await sql.run("UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=?", [id]);
      return engine.runNext();
    },
    async close() {
      oldRead.complete.release();
      try {
        const closed = await composition.close().then(
          () => null,
          (error: unknown) => error,
        );
        if (!updateOpenAllowed && failedUpdateOpens)
          expect(closed).toMatchObject({ message: "linux_docker_runtime_preparation_unavailable" });
        else expect(closed).toBeNull();
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

test("original host reconstruction resumes bound UPDATE with fresh owner and no CREATE or START replay", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: created.id,
      status: "succeeded",
      effect: "complete",
    });
    const originalWire = f.physical.guestReadback("1".repeat(64));
    if (!originalWire) throw new Error("original raw guest table missing");
    const updated = await f.update(created.resourceUid);
    expect(await f.engine.runNext()).toMatchObject({
      id: updated.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.failedUpdateOpens()).toBe(1);
    expect(f.docker.creates()).toHaveLength(2);
    expect(f.physical.starts()).toBe(1);
    const originalExecution = f.executions.find((execution) => execution.action === "update");
    if (!originalExecution) throw new Error("original UPDATE execution missing");
    const closed = await f.reconstruct();
    expect(closed.closed).toMatchObject({
      message: "linux_docker_runtime_preparation_unavailable",
    });
    const denyWire = f.physical.guestReadback("1".repeat(64));
    if (!denyWire) throw new Error("closed raw guest table missing");
    const parsed: unknown = JSON.parse(denyWire);
    if (!isJsonObject(parsed) || !Array.isArray(parsed.nftables))
      throw new Error("closed raw guest response invalid");
    expect(
      parsed.nftables.some(
        (item) =>
          isJsonObject(item) &&
          isJsonObject(item.rule) &&
          item.rule.comment === "guest_lifetime_closed",
      ),
    ).toBe(true);
    expect(
      JSON.stringify({
        nftables: parsed.nftables.filter(
          (item) =>
            !(
              isJsonObject(item) &&
              isJsonObject(item.rule) &&
              item.rule.comment === "guest_lifetime_closed"
            ),
        ),
      }),
    ).toBe(originalWire);
    const oldReads = f.physical.nativeCommands.filter(
      ({ nativeId, operation }) => nativeId === "1".repeat(64) && operation === "NFTREAD inet",
    ).length;
    expect(await f.retry(updated.id)).toMatchObject({
      id: updated.id,
      generation: 2,
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await f.sql.query(
        "SELECT desired_generation,serving_generation FROM tf_v2_container_instances",
      ),
    ).toEqual([{ desired_generation: 2, serving_generation: 2 }]);
    expect(
      await f.sql.query(
        "SELECT generation,retention FROM tf_v2_container_revisions ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, retention: "draining" },
      { generation: 2, retention: "serving" },
    ]);
    expect(
      await f.sql.query(
        "SELECT generation,native_id,state FROM tf_v2_container_create_claims ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, native_id: "1".repeat(64), state: "bound" },
      { generation: 2, native_id: "2".repeat(64), state: "bound" },
    ]);
    expect(
      await f.sql.query(
        "SELECT generation,state FROM tf_v2_container_start_attempts ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, state: "running" },
      { generation: 2, state: "running" },
    ]);
    expect(f.physical.starts()).toBe(2); // One original START per generation, none replayed.
    expect(f.docker.creates()).toHaveLength(2);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(f.docker.containers.size).toBe(2); // Retention state is not traffic-drain authority.
    expect(f.physical.guestReadback("1".repeat(64))).toBe(denyWire);
    expect(
      f.physical.nativeCommands.filter(
        ({ nativeId, operation }) => nativeId === "1".repeat(64) && operation === "NFTREAD inet",
      ).length,
    ).toBeGreaterThan(oldReads);
    expect(
      f.physical.nativeCommands.filter(
        ({ nativeId, operation }) => nativeId === "1".repeat(64) && operation === "RESUMEGUEST",
      ),
    ).toEqual([]);
    const updates = f.executions.filter((execution) => execution.action === "update");
    const current = updates[1];
    if (!current) throw new Error("reconstructed original execution missing");
    expect(current.leaseToken).not.toBe(originalExecution.leaseToken);
    expect(current.backendKey).toBe(originalExecution.backendKey);
    expect(current.privateInputs).toBeUndefined();
    const io = f.rawRequests();
    expect(await closed.backend.reconcile(originalExecution)).toEqual({ kind: "unknown" });
    expect(f.rawRequests()).toBe(io);
    expect(f.healthRequests()).toBe(2);
  } finally {
    await f.close();
  }
});

async function runningUpdateReconstruction(interleaving?: ServingInterleaving) {
  const f = await fixture("health-response");
  try {
    const created = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const updated = await f.update(created.resourceUid);
    expect(await f.engine.runNext()).toMatchObject({
      id: updated.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(f.physical.starts()).toBe(2);
    expect(f.failedUpdateOpens()).toBe(0);
    expect(f.healthRequests()).toBe(2);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 1 },
    ]);
    const originalWire = f.physical.guestReadback("2".repeat(64));
    if (!originalWire) throw new Error("running original guest table missing");
    const closed = await f.reconstruct();
    expect(closed.closed).toBeNull();
    const closedWire = f.physical.guestReadback("2".repeat(64));
    if (!closedWire || closedWire === originalWire)
      throw new Error("original closed lifetime deny missing");
    f.interleaveServing(interleaving);
    const result = await f.retry(updated.id);
    if (interleaving !== undefined) expect(f.servingWrites()).toBe(1);
    if (interleaving === "ack-lost" || interleaving === "wrong-epoch") {
      expect(result).toMatchObject({ id: updated.id, status: "reconciling", effect: "unknown" });
      expect(f.physical.guestReadback(updateNativeId)).toBe(closedWire);
      expect(f.docker.creates()).toHaveLength(2);
      expect(f.physical.starts()).toBe(2);
      expect(
        f.physical.nativeCommands.filter(
          ({ nativeId, operation }) => nativeId === updateNativeId && operation === "RESUMEGUEST",
        ),
      ).toHaveLength(1);
      return;
    }
    expect(result).toMatchObject({
      id: updated.id,
      generation: 2,
      status: "succeeded",
      effect: "complete",
    });
    if (interleaving === "old-read-error") {
      f.releaseOldServingRead();
      const closed = () => f.physical.guestReadback(updateNativeId) === closedWire;
      const until = performance.now() + 500;
      while (!closed() && performance.now() < until) await Bun.sleep(5);
      expect(closed()).toBe(true);
      expect(f.docker.creates()).toHaveLength(2);
      expect(f.physical.starts()).toBe(2);
      expect(
        f.physical.nativeCommands.filter(
          ({ nativeId, operation }) => nativeId === updateNativeId && operation === "RESUMEGUEST",
        ),
      ).toHaveLength(1);
      return;
    }
    if (interleaving === "old-read-held") {
      const renewals = () =>
        f.physical.nativeCommands.filter(
          ({ nativeId, operation }) => nativeId === updateNativeId && operation === "KEEPGUEST",
        ).length;
      const beforeRelease = renewals();
      f.releaseOldServingRead();
      const until = performance.now() + 500;
      while (renewals() === beforeRelease && performance.now() < until) await Bun.sleep(5);
      expect(renewals()).toBeGreaterThan(beforeRelease);
    }
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: 2 },
    ]);
    expect(
      await f.sql.query(
        "SELECT generation,state FROM tf_v2_container_start_attempts ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, state: "running" },
      { generation: 2, state: "running" },
    ]);
    expect(f.docker.creates()).toHaveLength(2);
    expect(f.physical.starts()).toBe(2);
    expect(f.physical.guestReadback("2".repeat(64))).toBe(originalWire);
    expect(
      f.physical.nativeCommands.filter(
        ({ nativeId, operation }) => nativeId === "2".repeat(64) && operation === "NFTAPPLY",
      ),
    ).toHaveLength(1);
    expect(
      f.physical.nativeCommands.filter(
        ({ nativeId, operation }) => nativeId === "2".repeat(64) && operation === "RESUMEGUEST",
      ),
    ).toHaveLength(1);
    expect(
      f.physical.nativeCommands.filter(
        ({ nativeId, operation }) => nativeId === "1".repeat(64) && operation === "RESUMEGUEST",
      ),
    ).toEqual([]);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(f.docker.containers.size).toBe(2);
    expect(f.healthRequests()).toBe(3);
  } finally {
    await f.close();
  }
}

test("running UPDATE reconstruction resumes the original closed lifetime without another START", async () => {
  await runningUpdateReconstruction();
});

test("running UPDATE reconstruction retains its lifetime during the original serving write acknowledgement", async () => {
  await runningUpdateReconstruction("commit-held");
});

test("running UPDATE reconstruction renews after a stale pre-publication owner read", async () => {
  await runningUpdateReconstruction("old-read-held");
});

test("running UPDATE reconstruction refuses an owner read error crossing publication", async () => {
  await runningUpdateReconstruction("old-read-error");
});

test("running UPDATE reconstruction keeps a lost serving acknowledgement closed", async () => {
  await runningUpdateReconstruction("ack-lost");
});

test("running UPDATE reconstruction rejects an unrelated serving epoch increment", async () => {
  await runningUpdateReconstruction("wrong-epoch");
});

test("accepted old-generation owner observes native drain primitives before settlement and rejects foreign or stale execution", async () => {
  const f = await fixture("health-response");
  try {
    const created = await f.create();
    expect(await f.engine.runNext()).toMatchObject({
      id: created.id,
      status: "succeeded",
      effect: "complete",
    });
    const updated = await f.update(created.resourceUid);
    expect(await f.engine.runNext()).toMatchObject({
      id: updated.id,
      status: "reconciling",
      effect: "unknown",
    });
    await f.reconstruct();
    let acceptedExecution: V2Execution | undefined;
    let observationFailure: unknown;
    let observed:
      | Awaited<ReturnType<SelfhostLinuxDockerContainerBackend["observeRetainedFlowPrimitives"]>>
      | undefined;
    const probes = () =>
      f.physical.nativeCommands.filter(({ operation }) => operation === "DRAINPROBE");
    f.observeResults(async (execution, original, result) => {
      try {
        if (execution.operationId !== updated.id || result.kind !== "complete") return;
        expect(
          await f.sql.query(
            "SELECT desired_generation,serving_generation FROM tf_v2_container_instances",
          ),
        ).toEqual([{ desired_generation: 2, serving_generation: 2 }]);
        expect(
          await f.sql.query("SELECT status FROM tf_v2_operations WHERE id=?", [updated.id]),
        ).toEqual([{ status: "reconciling" }]);
        // These are negative copies of the actual executing object. No positive
        // owner/runtime/accepted native snapshot is supplied by the test.
        await expect(
          original.observeRetainedFlowPrimitives({
            ...execution,
            principal: "synthetic-foreign-parent",
          }),
        ).rejects.toThrow();
        await expect(
          original.observeRetainedFlowPrimitives({
            ...execution,
            targetKey: "synthetic-foreign-target",
          }),
        ).rejects.toThrow();
        expect(probes()).toHaveLength(0);
        // The SDK itself retains the original accepted UPDATE/remove owner,
        // old policy/runtime and exact native snapshot from session.inspect().
        observed = await original.observeRetainedFlowPrimitives(execution);
        acceptedExecution = execution;
      } catch (error: unknown) {
        observationFailure = error;
        throw error;
      }
    });
    const retried = await f.retry(updated.id);
    if (observationFailure !== undefined) throw observationFailure;
    expect(retried).toMatchObject({
      id: updated.id,
      status: "succeeded",
      effect: "complete",
    });
    f.observeResults(undefined);
    if (!acceptedExecution || !observed) throw new Error("original accepted probe not reached");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      kind: "docker-guest-drain-primitives@1",
      nativeId: "1".repeat(64),
      fenceTable: `takos_cx_${"1".repeat(32)}_drain`,
      barrier: "unproven",
      probe: "nonempty-nft-check-completed",
      kernelRcu: "unqualified",
      atomicity: "sequential",
      allocatedEntries: 7,
      maxEntries: 65536,
    });
    expect(probes()).toHaveLength(1);
    expect(probes()[0]?.nativeId).toBe("1".repeat(64));
    // Reusing the original object after engine settlement cannot renew its
    // lease, replay the primitive, or authorize another native observation.
    const oldNativeCommands = () =>
      f.physical.nativeCommands.filter(({ nativeId }) => nativeId === "1".repeat(64));
    const beforeStaleNativeCommands = oldNativeCommands().length;
    await expect(f.composition.observeRetainedFlowPrimitives(acceptedExecution)).rejects.toThrow();
    expect(oldNativeCommands()).toHaveLength(beforeStaleNativeCommands);
    expect(probes()).toHaveLength(1);
    expect(
      await f.sql.query(
        "SELECT generation,retention FROM tf_v2_container_revisions ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, retention: "draining" },
      { generation: 2, retention: "serving" },
    ]);
    expect(
      await f.sql.query(
        "SELECT generation,native_id,state FROM tf_v2_container_create_claims ORDER BY generation",
      ),
    ).toEqual([
      { generation: 1, native_id: "1".repeat(64), state: "bound" },
      { generation: 2, native_id: "2".repeat(64), state: "bound" },
    ]);
    expect(f.physical.starts()).toBe(2);
    expect(f.docker.creates()).toHaveLength(2);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(f.docker.containers.size).toBe(2);
  } finally {
    await f.close();
  }
});
