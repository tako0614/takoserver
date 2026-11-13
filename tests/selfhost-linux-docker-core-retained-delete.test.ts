import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT } from "../src/container-contract.ts";
import { canonicalDigest, isJsonObject, type JsonObject } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { DockerContainerCreateDriver } from "../src/providers/docker-container-create-custody.ts";
import type { DockerHttpRevisionOptions } from "../src/providers/docker-http-revision.ts";
import {
  createSelfhostLinuxDockerCore,
  type SelfhostLinuxDockerAcceptedRevision,
  type SelfhostLinuxDockerCoreSelection,
} from "../src/selfhost-linux-docker-core.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { V2_CONTAINER_F2_FORM } from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";
import { engineDouble } from "./helpers/docker-container-configured-owner-snapshot.ts";
import { SOURCE_SELECTION } from "./helpers/docker-container-configured-source-selection.ts";

type Engine = NonNullable<DockerHttpRevisionOptions["engine"]>;

/** Only raw HTTP is replaced. Product factory, runtime class, custody, Core
 * acceptance/SQL and original removal/exit/tombstone guards remain unchanged.
 */
function interceptRawHttp(engine: Engine) {
  const implementation = ((
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
            this.destroy(error instanceof Error ? error : new Error("synthetic HTTP failure")),
          );
        return this;
      }
    }
    return new MemoryRequest() as unknown as http.ClientRequest;
  }) as typeof http.request;
  const intercepted = spyOn(http, "request").mockImplementation(implementation);
  // Refuse before any product transport invocation if this Bun cannot replace
  // the named raw import. This test must never fall back to a real socket.
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
        current: { id: "synthetic-retained-key", key },
        keyForDecryption: (id) => (id === "synthetic-retained-key" ? key : undefined),
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
  const composition = createSelfhostLinuxDockerCore({ sql, clock: () => new Date(), selection });
  if (!composition) throw new Error("explicit source composition missing");
  const docker = engineDouble();
  let raw: Engine = docker.engine;
  let rawRequests = 0;
  const restore = interceptRawHttp((...args) => {
    rawRequests++;
    return raw(...args);
  });
  const fields = CONTAINER_CONTRACT.fields;
  const spec = {
    [fields.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
    [fields.httpPort]: 8080,
    [fields.healthPath]: "/health",
    [fields.workloadRevision]: "1".repeat(64),
    [fields.environment]: { MODE: "synthetic-retained" },
    [fields.requiredSensitiveVars]: ["SECRET"],
    [fields.outboundInternet]: false,
  };
  const failures: unknown[] = [];
  let action: (execution: V2Execution) => Promise<void> = (execution) =>
    composition.retireAccepted(execution);
  const originalExecutions: V2Execution[] = [];
  async function createStopped({ accepted, runtime }: SelfhostLinuxDockerAcceptedRevision) {
    // This fixture's CREATE models known stopped ownership only. It never calls
    // ensureRunning/publishServing, replaces physical verification, or reports ready.
    const body: JsonObject = {
      Image: spec.image,
      Env: ["MODE=synthetic-retained"],
      ExposedPorts: { "8080/tcp": {} },
      HostConfig: {
        NetworkMode: "none",
        Memory: selection.docker.maxMemoryBytes,
        MemorySwap: selection.docker.maxMemoryBytes,
        NanoCpus: selection.docker.maxNanoCpus,
        PidsLimit: selection.docker.pidsLimit,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        PublishAllPorts: false,
        Dns: [...selection.runtime.dnsServers],
        DnsOptions: [],
        DnsSearch: [],
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      },
    };
    const identityLabel = await canonicalDigest({
      installation: accepted.installationId,
      resource: accepted.resourceUid,
      incarnation: accepted.incarnationId,
      revision: accepted.revision,
    });
    const revisionLabel = await canonicalDigest({
      body,
      healthPath: spec.healthPath,
      runtimePolicy: { ...runtime.policy },
      requiredSecretNames: runtime.createCustody.requiredSecretNames,
    });
    const target = {
      installationId: accepted.installationId,
      resourceUid: accepted.resourceUid,
      incarnationId: accepted.incarnationId,
      revision: accepted.revision,
      nativeName: `takoserver-${identityLabel.slice(7)}`,
      identityLabel,
      revisionLabel,
    };
    const native = (id: string) => ({
      backend: "docker" as const,
      installationId: accepted.installationId,
      resourceUid: accepted.resourceUid,
      incarnationId: accepted.incarnationId,
      revision: accepted.revision,
      nativeId: id,
      network: selection.docker.network,
      networkId: "b".repeat(64),
      image: spec.image,
      imageId: `sha256:${"1".repeat(64)}`,
      identityLabel,
      revisionLabel,
    });
    const driver: DockerContainerCreateDriver = {
      async inspect(record) {
        const response = await docker.engine(
          "GET",
          `/containers/${record.nativeId ?? target.nativeName}/json`,
        );
        if (response.status === 404) return null;
        const current: unknown = JSON.parse(response.body);
        if (
          !isJsonObject(current) ||
          typeof current.Id !== "string" ||
          !isJsonObject(current.Config) ||
          !Array.isArray(current.Config.Env)
        )
          throw new Error("synthetic native snapshot invalid");
        return {
          native: native(current.Id),
          state: "stopped",
          claimId: record.claimId,
          environment: current.Config.Env as string[],
        };
      },
      async create(record, overrides) {
        const result = await docker.engine("POST", `/containers/create?name=${target.nativeName}`, {
          ...body,
          Env: [
            "MODE=synthetic-retained",
            ...Object.entries(overrides).map(([name, value]) => `${name}=${value}`),
          ],
          Labels: {
            "takoserver.identity": identityLabel,
            "takoserver.revision": revisionLabel,
            "takoserver.create-claim": record.claimId,
          },
        });
        const value: unknown = JSON.parse(result.body);
        if (!isJsonObject(value) || typeof value.Id !== "string")
          throw new Error("synthetic CREATE ACK invalid");
        // The generic double normally attaches its ordinary network. A Linux
        // none-network CREATE is quarantined, with no owned-network attachment.
        for (const [name, current] of docker.containers)
          if (current.Id === value.Id)
            docker.containers.set(name, {
              ...current,
              NetworkSettings: { Networks: { none: {} } },
            });
        return value.Id;
      },
      stop: async () => {
        throw new Error("setup must not STOP");
      },
      remove: async () => {
        throw new Error("setup must not DELETE");
      },
    };
    await runtime.createCustody.withAuthority(target, "reconcile", driver, async (session) => {
      const observed = await session.ensureCreated();
      expect(observed?.state).toBe("stopped");
    });
  }
  const dispatch = async (execution: V2Execution): Promise<V2BackendResult> => {
    originalExecutions.push(execution);
    try {
      if (execution.action === "create") {
        await composition.withAcceptedRevision(execution, createStopped);
        // Test-only stopped-ownership protocol terminal permits accepting the
        // subsequent change. No F2 public/serving/usage completion is simulated.
        return { kind: "complete", observed: {}, output: {} };
      }
      await action(execution);
    } catch (error) {
      failures.push(error);
    }
    return { kind: "unknown" };
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
            id: "synthetic-retained-comparison",
            key: await crypto.subtle.generateKey(
              { name: "HMAC", hash: "SHA-256", length: 256 },
              false,
              ["sign", "verify"],
            ),
          },
        },
        transferTtlSeconds: 300,
      },
      forms: {
        [V2_CONTAINER_F2_FORM]: {
          validateCreate: () => {},
          validateUpdate: () => {},
          initialOutput: () => ({}),
          privateInputs: {
            validateCreate: () => {},
            validateUpdate: () => {},
            prepareCreate: composition.configuredInputs.prepareCreate,
            prepareUpdate: composition.configuredInputs.prepareUpdate,
          },
          backend: {
            id: selection.backendId,
            targetKey: selection.targetKey,
            execute: dispatch,
            reconcile: dispatch,
          },
        },
      },
    },
    composition.acceptance,
  );
  return {
    database,
    sql,
    engine,
    docker,
    composition,
    selection,
    spec,
    failures,
    originalExecutions,
    action(fn: typeof action) {
      action = fn;
    },
    raw(fn: Engine) {
      raw = fn;
    },
    rawRequests: () => rawRequests,
    async create() {
      const accepted = await engine.acceptCreate({
        principal: "synthetic-retained-principal",
        key: crypto.randomUUID(),
        input: {
          form: V2_CONTAINER_F2_FORM,
          space: "synthetic-space",
          name: "synthetic-retained",
          spec,
          privateInputs: { SECRET: "synthetic-retained-transient" },
        },
      });
      expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
      expect(failures).toEqual([]);
      expect(await sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
        { serving_generation: null },
      ]);
      expect(await sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual([]);
      return accepted;
    },
    async remove(uid: string) {
      const accepted = await engine.acceptDelete({
        principal: "synthetic-retained-principal",
        key: crypto.randomUUID(),
        uid,
        expectedGeneration: 1,
      });
      await engine.runNext();
      return accepted;
    },
    async close() {
      try {
        await composition.close();
      } finally {
        restore();
        database.close();
      }
    },
  };
}

test("accepted DELETE removes the original stopped retained object without CREATE or START replay", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    await f.remove(created.resourceUid);
    expect(f.failures).toEqual([]);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_create_claims")).toEqual([
      { state: "removed" },
    ]);
    expect(f.docker.containers.size).toBe(0);
    expect(f.docker.creates()).toHaveLength(1);
    expect(f.docker.starts()).toHaveLength(0);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
    expect(f.rawRequests()).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test("accepted UPDATE alone does not grant removal of a generation not yet draining", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    const updated = await f.engine.acceptUpdate({
      principal: "synthetic-retained-principal",
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { ...f.spec, workloadRevision: "2".repeat(64) },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: updated.id });
    expect(f.failures).toHaveLength(1);
    expect(await f.sql.query("SELECT generation,state FROM tf_v2_container_create_claims")).toEqual(
      [{ generation: 1, state: "bound" }],
    );
    expect(f.rawRequests()).toBe(0);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(f.docker.creates()).toHaveLength(1);
    expect(f.docker.starts()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("a different accepted parent cannot authorize the retained native removal", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    f.action(async (execution) => {
      const before = f.docker.calls.length;
      await expect(
        f.composition.retireAccepted({ ...execution, principal: "synthetic-foreign-principal" }),
      ).rejects.toThrow();
      expect(f.docker.calls.length).toBe(before);
    });
    await f.remove(created.resourceUid);
    expect(f.failures).toEqual([]);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_create_claims")).toEqual([
      { state: "bound" },
    ]);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("changed Host settings require the original retained policy instead of current settings", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    const changed = createSelfhostLinuxDockerCore({
      sql: f.sql,
      clock: () => new Date(),
      selection: { ...f.selection, runtime: { ...f.selection.runtime, maxConnections: 5 } },
    });
    if (!changed) throw new Error("changed code selection missing");
    f.action(async (execution) => {
      const before = f.docker.calls.length;
      await expect(changed.retireAccepted(execution)).rejects.toThrow(
        "retained_policy_unavailable",
      );
      expect(f.docker.calls.length).toBe(before);
    });
    await f.remove(created.resourceUid);
    expect(f.failures).toEqual([]);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    await changed.close();
  } finally {
    await f.close();
  }
});

test("cancellation inside original retained inspection sends no native DELETE", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    const abort = new AbortController();
    f.raw(async (method, path, body) => {
      const response = await f.docker.engine(method, path, body);
      if (method === "GET" && path.includes("/containers/")) abort.abort();
      return response;
    });
    f.action((execution) => f.composition.retireAccepted(execution, abort.signal));
    await f.remove(created.resourceUid);
    expect(f.failures).toHaveLength(1);
    expect(abort.signal.aborted).toBe(true);
    expect(f.rawRequests()).toBeGreaterThan(0);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_create_claims")).toEqual([
      { state: "bound" },
    ]);
    expect(f.docker.starts()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("unknown native DELETE ACK resumes exact-ID observation without another DELETE or CREATE", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    let faulted = false;
    f.raw(async (method, path, body) => {
      const response = await f.docker.engine(method, path, body);
      if (method === "DELETE" && !faulted) {
        faulted = true;
        throw new Error("synthetic lost DELETE ACK");
      }
      return response;
    });
    const removed = await f.remove(created.resourceUid);
    expect(f.failures).toHaveLength(1);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_create_claims")).toEqual([
      { state: "bound" },
    ]);
    await f.sql.run("UPDATE tf_v2_operations SET next_attempt_at_ms=0 WHERE id=?", [removed.id]);
    await f.engine.runNext();
    expect(f.failures).toHaveLength(1);
    expect(await f.sql.query("SELECT state FROM tf_v2_container_create_claims")).toEqual([
      { state: "removed" },
    ]);
    expect(f.docker.calls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
    expect(f.docker.creates()).toHaveLength(1);
    expect(f.docker.starts()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
