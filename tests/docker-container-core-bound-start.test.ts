import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { canonicalDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import {
  createDockerContainerConfiguredInputs,
  validateDockerContainerPrivateInputs,
  validateDockerContainerSpec,
} from "../src/providers/docker-container-configured-inputs.ts";
import type { DockerContainerCreateRecord } from "../src/providers/docker-container-create-custody.ts";
import {
  createDockerHttpRevisionRuntime,
  type DockerHttpRevisionOptions,
} from "../src/providers/docker-http-revision.ts";
import { createLinuxDockerCoreRuntime } from "../src/providers/linux-docker-core-runtime.ts";
import type { SelfhostLinuxDockerCoreSelection } from "../src/selfhost-linux-docker-core.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { V2_CONTAINER_F2_FORM } from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";
import { engineDouble } from "./helpers/docker-container-configured-owner-snapshot.ts";
import {
  containerSpec,
  SOURCE_SELECTION,
} from "./helpers/docker-container-configured-source-selection.ts";
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

// ORIGINAL owner + engine + custody/runtime. Only raw HTTP/stdio are doubled.
// The raw daemon refuses post-CREATE readback, so the original binder has a
// stopped native ID but NO START attempt. These checks claim the ledger only;
// they neither send START nor infer physical readiness/publication/terminal.
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
        current: { id: "synthetic-bound-start", key },
        keyForDecryption: (id) => (id === "synthetic-bound-start" ? key : undefined),
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
      network: "synthetic-bound-start-network",
      maxMemoryBytes: 268435456,
      maxNanoCpus: 500000000,
      pidsLimit: 128,
    },
  };
  const core = createLinuxDockerCoreRuntime({
    sql,
    clock: () => new Date(),
    installationId: selection.installationId,
    backendId: selection.backendId,
    targetKey: selection.targetKey,
    configuredInputs: selection.configuredInputs,
  });
  const owner = core.owner;
  const foreign = createLinuxDockerCoreRuntime({
    sql,
    clock: () => new Date(),
    installationId: selection.installationId,
    backendId: selection.backendId,
    targetKey: selection.targetKey,
    configuredInputs: selection.configuredInputs,
  });
  const configured = createDockerContainerConfiguredInputs({
    sql,
    selection: SOURCE_SELECTION,
    owner,
    ...selection.configuredInputs,
  });
  const docker = engineDouble();
  const physical = createRawLinuxDockerStdio({
    containers: docker.containers,
    networkName: selection.docker.network,
    installationId: selection.installationId,
  });
  let refusedReadbacks = 0;
  const restoreHttp = interceptHttp(async (method, path, body) => {
    if (method === "GET" && path === `/networks/${selection.docker.network}`)
      return { status: 200, body: JSON.stringify(physical.network()) };
    if (method === "GET" && /^\/containers\/[a-f0-9]{64}\/json$/u.test(path)) {
      refusedReadbacks++;
      return { status: 500, body: "" };
    }
    const response = await docker.engine(method, path, body);
    if (method === "POST" && path.startsWith("/containers/create?")) {
      const id: unknown = JSON.parse(response.body).Id;
      for (const [name, current] of docker.containers)
        if (current.Id === id)
          docker.containers.set(name, { ...current, NetworkSettings: { Networks: { none: {} } } });
    }
    return response;
  });
  const spawn = spyOn(childProcess, "spawn").mockImplementation(
    physical.spawn as unknown as typeof childProcess.spawn,
  );
  if (!Object.is(importedSpawn, spawn)) {
    spawn.mockRestore();
    restoreHttp();
    database.close();
    throw new Error("raw stdio interception unavailable");
  }
  const runtimes: ReturnType<typeof core.createRuntime>[] = [];
  let check: (record: DockerContainerCreateRecord, execution: V2Execution) => Promise<void> =
    async () => {
      throw new Error("test callback absent");
    };
  let escaped: DockerContainerCreateRecord | undefined;
  let dispatchFailure: unknown;
  const dispatch = (execution: V2Execution): Promise<V2BackendResult> =>
    owner
      .withExecution(execution, async (): Promise<V2BackendResult> => {
        const accepted = await owner.readAcceptedExecution(execution);
        const runtime = core.createRuntime({
          ...selection.runtime,
          policy: {
            tenantRef: accepted.principal,
            generation: accepted.generation,
            outboundInternet: accepted.outboundInternet,
            policyDigest: await canonicalDigest({ selection: "synthetic-bound-start" }),
          },
          requiredSecretNames: accepted.requiredSecretNames,
        });
        runtimes.push(runtime);
        const dockerRuntime = createDockerHttpRevisionRuntime({
          ...selection.docker,
          installationId: selection.installationId,
          socketPath: selection.runtime.process.socketPath,
          dnsServers: runtime.dnsServers,
          runtimePreparation: runtime,
        });
        // The original pipeline must fail BEFORE the one-use START; no fake result
        // or catch-to-complete adapter can manufacture a successful backend here.
        await expect(
          dockerRuntime.reconcile({
            resourceUid: accepted.resourceUid,
            incarnationId: accepted.incarnationId,
            revision: accepted.revision,
            image: String(accepted.spec.image),
            port: 8080,
            healthPath: "/health",
            memoryBytes: selection.docker.maxMemoryBytes,
            nanoCpus: selection.docker.maxNanoCpus,
            environment: { MODE: "11111111" },
          }),
        ).rejects.toThrow();
        expect(refusedReadbacks).toBeGreaterThan(0);
        expect(physical.starts()).toBe(0);
        const current = (await owner.readAcceptedExecution(execution)).retained.find(
          ({ record }) => record.intent.policy.generation === accepted.generation,
        );
        if (current?.record.state !== "bound" || current.record.nativeId === null)
          throw new Error("actual binder did not retain stopped native");
        escaped = current.record;
        await check(current.record, execution);
        return { kind: "unknown" };
      })
      .catch((error: unknown): V2BackendResult => {
        dispatchFailure = error;
        return { kind: "unknown" };
      });
  const engine = createTakoformV2Engine(
    {
      sql,
      authorize: async () => true,
      replayWindowSeconds: 3600,
      privateInputCustody: {
        transfer: { current: selection.configuredInputs.keyring.current },
        comparison: {
          current: {
            id: "synthetic-bound-start-comparison",
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
          validateCreate: (spec) => {
            validateDockerContainerSpec(spec);
          },
          validateUpdate: (_previous, spec) => {
            validateDockerContainerSpec(spec);
          },
          privateInputs: {
            validateCreate: (spec, values) =>
              validateDockerContainerPrivateInputs(
                validateDockerContainerSpec(spec).requiredSensitiveVars,
                values,
              ),
            validateUpdate: (_previous, spec, values) => {
              if (values !== undefined)
                validateDockerContainerPrivateInputs(
                  validateDockerContainerSpec(spec).requiredSensitiveVars,
                  values,
                );
            },
            prepareCreate: configured.prepareCreate,
            prepareUpdate: configured.prepareUpdate,
          },
          initialOutput: () => ({}),
          backend: {
            id: selection.backendId,
            targetKey: selection.targetKey,
            execute: dispatch,
            reconcile: dispatch,
          },
        },
      },
    },
    owner.acceptance,
  );
  return {
    sql,
    owner,
    foreign: foreign.owner,
    physical,
    docker,
    async run(work: typeof check) {
      check = work;
      await engine.acceptCreate({
        principal: "synthetic-bound-start-parent",
        key: crypto.randomUUID(),
        input: {
          form: V2_CONTAINER_F2_FORM,
          space: "synthetic-space",
          name: "bound-start",
          spec: { ...containerSpec("1".repeat(64)), outboundInternet: true },
          privateInputs: { SECRET: "synthetic-transient-value" },
        },
      });
      expect(await engine.runNext()).toMatchObject({ effect: "unknown" });
      if (dispatchFailure !== undefined) throw dispatchFailure;
      if (!escaped) throw new Error("test scope not reached");
      return escaped;
    },
    async close() {
      try {
        await Promise.all(runtimes.map((runtime) => runtime.close()));
      } finally {
        spawn.mockRestore();
        restoreHttp();
        database.close();
      }
      expect(physical.liveChildren()).toBe(0);
    },
  };
}

const attempts =
  "SELECT generation,attempt,create_claim_id,native_id,state,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts";

test("an original accepted bound record consumes the same one-use START ledger without a Docker identity DTO", async () => {
  const f = await fixture();
  try {
    const record = await f.run(async (bound, execution) => {
      expect(await f.sql.query(attempts)).toEqual([]);
      await expect(f.owner.claimAcceptedStart(bound)).rejects.toThrow();
      await f.owner.owner.withAuthority(bound, "observe", async () => {
        await expect(f.owner.claimAcceptedStart(bound)).rejects.toThrow();
      });
      await f.owner.owner.withAuthority(bound, "reconcile", async () => {
        for (const changed of [
          { claimId: "f".repeat(64) },
          { nativeId: "f".repeat(64) },
          { state: "pending" as const },
        ])
          await expect(f.owner.claimAcceptedStart({ ...bound, ...changed })).rejects.toThrow();
        await f.foreign.withExecution(execution, async () => {
          await expect(f.foreign.claimAcceptedStart(bound)).rejects.toThrow();
        });
        expect(await f.sql.query(attempts)).toEqual([]);
        expect(await f.owner.claimAcceptedStart(bound)).toBe("claimed");
        expect(await f.owner.claimAcceptedStart(bound)).toBe("unknown");
      });
    });
    expect(await f.sql.query(attempts)).toEqual([
      {
        generation: 1,
        attempt: 1,
        create_claim_id: record.claimId,
        native_id: record.nativeId,
        state: "pending",
        confirmed_running_at_ms: null,
        confirmed_exited_at_ms: null,
      },
    ]);
    await expect(f.owner.claimAcceptedStart(record)).rejects.toThrow();
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    expect(f.physical.starts()).toBe(0);
    expect(f.docker.creates()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("competing original bound START claims have one winner and preserve the unknown pending anchor", async () => {
  const f = await fixture();
  try {
    const record = await f.run(async (bound) =>
      f.owner.owner.withAuthority(bound, "reconcile", async () => {
        const results = await Promise.all([
          f.owner.claimAcceptedStart(bound),
          f.owner.claimAcceptedStart(bound),
        ]);
        expect(results.sort()).toEqual(["claimed", "unknown"]);
        expect(await f.owner.claimAcceptedStart(bound)).toBe("unknown");
      }),
    );
    const rows = await f.sql.query(attempts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      create_claim_id: record.claimId,
      native_id: record.nativeId,
      state: "pending",
    });
    expect(f.physical.starts()).toBe(0);
    expect(f.docker.creates()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("bound START captures original data before Sql awaits and refuses caller accessors without reading them", async () => {
  const f = await fixture();
  try {
    const record = await f.run(async (bound) =>
      f.owner.owner.withAuthority(bound, "reconcile", async () => {
        let reads = 0;
        const accessor = {
          ...bound,
          get claimId() {
            reads++;
            return bound.claimId;
          },
        };
        await expect(f.owner.claimAcceptedStart(accessor)).rejects.toThrow();
        expect(reads).toBe(0);
        expect(await f.sql.query(attempts)).toEqual([]);
        const mutable = { ...bound };
        const original = f.owner.claimAcceptedStart(mutable);
        mutable.nativeId = "f".repeat(64);
        expect(await original).toBe("claimed");
      }),
    );
    expect(await f.sql.query(attempts)).toEqual([
      {
        generation: 1,
        attempt: 1,
        create_claim_id: record.claimId,
        native_id: record.nativeId,
        state: "pending",
        confirmed_running_at_ms: null,
        confirmed_exited_at_ms: null,
      },
    ]);
    expect(f.physical.starts()).toBe(0);
    expect(f.docker.creates()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("accepted bound START requires current execution even when a fresh durable authority lease can be reopened", async () => {
  const f = await fixture();
  try {
    const record = await f.run(async (bound, execution) => {
      // The original owner really opens this durable reconcile lease. Only the
      // genuine SQL execution check can distinguish its foreign principal.
      await f.foreign.withExecution({ ...execution, principal: "synthetic-foreign" }, async () =>
        f.foreign.owner.withAuthority(bound, "reconcile", async () => {
          await expect(f.foreign.claimAcceptedStart(bound)).rejects.toThrow();
        }),
      );
      expect(await f.sql.query(attempts)).toEqual([]);
      await f.owner.owner.withAuthority(bound, "reconcile", async () => {
        expect(await f.owner.claimAcceptedStart(bound)).toBe("claimed");
      });
    });
    // The original engine dispatch has ended; reopening durable withAuthority
    // is not another current execution and must not grant even a claim result.
    await f.owner.owner.withAuthority(record, "reconcile", async () => {
      await expect(f.owner.claimAcceptedStart(record)).rejects.toThrow();
    });
    expect(await f.sql.query(attempts)).toEqual([
      {
        generation: 1,
        attempt: 1,
        create_claim_id: record.claimId,
        native_id: record.nativeId,
        state: "pending",
        confirmed_running_at_ms: null,
        confirmed_exited_at_ms: null,
      },
    ]);
    expect(f.physical.starts()).toBe(0);
    expect(f.docker.creates()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("bound START cannot return a claim after the real authority ends during its final execution read", async () => {
  const f = await fixture();
  try {
    const record = await f.run(async (bound) => {
      const original = f.sql.query.bind(f.sql);
      let release = () => {};
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived = () => {};
      const boundary = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      let reads = 0;
      // Execute ORIGINAL SQLite first and retain its exact rows. Only the
      // adapter's result delivery is delayed; no SQL/currentness result is fake.
      const query = spyOn(f.sql, "query").mockImplementation(async (statement, params) => {
        const rows = await original(statement, params);
        if (
          statement.includes("SELECT op.accepted_spec_json FROM tf_v2_operations op") &&
          ++reads === 2
        ) {
          arrived();
          await delayed;
        }
        return rows;
      });
      let pending: Promise<"claimed" | "already-claimed" | "unknown"> | undefined;
      try {
        await f.owner.owner.withAuthority(bound, "reconcile", async () => {
          pending = f.owner.claimAcceptedStart(bound);
          await boundary;
        });
        // This is after the actual owner finally aborted/deleted its lease,
        // while the outer genuine engine execution remains live.
        release();
        if (!pending) throw new Error("original claim absent");
        await expect(pending).rejects.toThrow();
        expect(reads).toBe(2);
      } finally {
        release();
        query.mockRestore();
      }
    });
    expect(await f.sql.query(attempts)).toEqual([
      {
        generation: 1,
        attempt: 1,
        create_claim_id: record.claimId,
        native_id: record.nativeId,
        state: "pending",
        confirmed_running_at_ms: null,
        confirmed_exited_at_ms: null,
      },
    ]);
    expect(f.physical.starts()).toBe(0);
    expect(f.docker.creates()).toHaveLength(1);
  } finally {
    await f.close();
  }
});
