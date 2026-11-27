import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { LinuxDockerRuntimePreparation } from "../src/providers/linux-docker-runtime-preparation.ts";
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
import { CONTAINER_DOCKER_BACKEND_ID } from "../src/takoform-v2/forms/container-backend.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";

async function selection(): Promise<SelfhostLinuxDockerCoreSelection> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    installationId: "synthetic-node-installation",
    backendId: CONTAINER_DOCKER_BACKEND_ID,
    targetKey: "synthetic-node-target",
    configuredInputs: {
      keyring: {
        current: { id: "synthetic-node-key", key },
        keyForDecryption: (id) => (id === "synthetic-node-key" ? key : undefined),
      },
      maxSecretBytes: 4096,
    },
    runtime: {
      process: {
        helper: "/synthetic/not-executed/native-helper",
        socketPath: "/synthetic/not-opened/docker.sock",
        peerPid: 1,
        peerUid: 0,
        ipBinary: "/synthetic/not-executed/ip",
        nftBinary: "/synthetic/not-executed/nft",
        guestNamespaceRoot: "/synthetic/not-opened/namespaces",
      },
      host: { tcpPorts: [8080], conntrackMark: 1, deniedDestinations: [] },
      dnsServers: ["1.1.1.1"],
      maxConnections: 4,
      packetLimitBytes: 4096,
    },
    docker: { network: "synthetic-owned", maxMemoryBytes: 4096, maxNanoCpus: 1000, pidsLimit: 4 },
  };
}

test("disabled Node F2 composition does not read Sql or its clock", () => {
  const input = {
    get sql(): ReturnType<typeof createSqliteSql> {
      throw new Error("disabled Sql must not be read");
    },
    get clock(): () => Date {
      throw new Error("disabled clock must not be read");
    },
    selection: undefined,
  };
  expect(createSelfhostLinuxDockerCore(input)).toBeUndefined();
});

for (const phase of ["work", "read"] as const) {
  test(`shutdown drains the original ${phase} scope before dependent database cleanup`, async () => {
    const database = new Database(":memory:");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      migrateSqlite(database);
      const originalSql = createSqliteSql(database);
      await originalSql.batch(
        frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
      );
      await originalSql.batch(v2ContainerOwnerMigrationCandidate());
      let blockRead = phase === "read";
      const sql: Sql = {
        ...originalSql,
        async query(statement, params) {
          if (
            blockRead &&
            statement.includes("SELECT op.accepted_spec_json FROM tf_v2_operations op")
          ) {
            blockRead = false;
            entered();
            await gate;
          }
          return originalSql.query(statement, params);
        },
      };
      const selected = await selection();
      const composition = createSelfhostLinuxDockerCore({
        sql,
        clock: () => new Date(),
        selection: selected,
      });
      if (!composition) throw new Error("explicit selection not constructed");
      let workFinished = false;
      const outcomes: unknown[] = [];
      const dispatch = async (execution: V2Execution): Promise<V2BackendResult> => {
        try {
          return await composition.withAcceptedRevision(execution, async () => {
            if (phase === "work") {
              entered();
              await gate;
            }
            expect(await sql.query("SELECT 1 AS still_open")).toEqual([{ still_open: 1 }]);
            workFinished = true;
            return { kind: "unknown" as const };
          });
        } catch (error) {
          outcomes.push(error);
          return { kind: "unknown" };
        }
      };
      const engine = createTakoformV2Engine(
        {
          sql,
          authorize: async () => true,
          replayWindowSeconds: 3600,
          forms: {
            [V2_CONTAINER_F2_FORM]: {
              validateCreate: () => {},
              validateUpdate: () => {},
              privateInputs: {
                validateCreate: () => {},
                validateUpdate: () => {},
                prepareCreate: composition.configuredInputs.prepareCreate,
                prepareUpdate: composition.configuredInputs.prepareUpdate,
              },
              initialOutput: () => ({}),
              backend: {
                id: selected.backendId,
                targetKey: selected.targetKey,
                execute: dispatch,
                reconcile: dispatch,
              },
            },
          },
        },
        composition.acceptance,
      );
      const fields = CONTAINER_CONTRACT.fields;
      await engine.acceptCreate({
        principal: "synthetic-drain-principal",
        key: `synthetic-drain-${phase}`,
        input: {
          form: V2_CONTAINER_F2_FORM,
          space: "synthetic-space",
          name: `synthetic-drain-${phase}`,
          spec: {
            [fields.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
            [fields.httpPort]: 8080,
            [fields.healthPath]: "/health",
            [fields.workloadRevision]: "1".repeat(64),
            [fields.environment]: {},
            [fields.requiredSensitiveVars]: [],
            [fields.outboundInternet]: true,
          },
        },
      });
      const running = engine.runNext();
      try {
        await waiting;
        const closing = composition.close();
        expect(composition.close()).toBe(closing);
        let dependentDatabaseCleanup = false;
        const dependent = closing.then(() => {
          dependentDatabaseCleanup = true;
        });
        // Give an incorrectly immediate close its entire promise chain without
        // sleeps or native IO. The held scope cannot settle until gate release.
        for (let turn = 0; turn < 12; turn++) await Promise.resolve();
        expect(dependentDatabaseCleanup).toBe(false);
        release();
        await running;
        await dependent;
        expect(dependentDatabaseCleanup).toBe(true);
        expect(workFinished).toBe(phase === "work");
        if (phase === "work") expect(outcomes).toEqual([]);
        else expect(outcomes).toMatchObject([{ code: "closed" }]);
      } finally {
        release();
        await running;
        await composition.close();
      }
    } finally {
      database.close();
    }
  });
}

test("Node selection refuses supplied authority and transport callbacks without reading getters", async () => {
  const database = new Database(":memory:");
  try {
    const sql = createSqliteSql(database);
    let getterReads = 0;
    for (const [level, field] of [
      ["selection", "owner"],
      ["runtime", "createCustody"],
      ["runtime", "policy"],
      ["runtime", "requiredSecretNames"],
      ["docker", "runtimePreparation"],
      ["docker", "engine"],
    ] as const) {
      const selected = await selection();
      const object = level === "selection" ? selected : selected[level];
      Object.defineProperty(object, field, {
        enumerable: true,
        get() {
          getterReads++;
          throw new Error("injected authority must not be read");
        },
      });
      expect(() =>
        createSelfhostLinuxDockerCore({ sql, clock: () => new Date(), selection: selected }),
      ).toThrow("selfhost_linux_docker_core_invalid_selection");
    }
    expect(getterReads).toBe(0);
  } finally {
    database.close();
  }
});

test("Node composition uses original acceptance and accepted scope for a retained generation runtime", async () => {
  // Only SQLite is real. Neither the Docker transport nor any Linux runtime
  // operation is invoked, and the backend deliberately leaves the Operation unknown.
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    await sql.batch(
      frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
    );
    await sql.batch(v2ContainerOwnerMigrationCandidate());
    const selected = await selection();
    const composition = createSelfhostLinuxDockerCore({
      sql,
      clock: () => new Date(),
      selection: selected,
    });
    if (!composition) throw new Error("explicit selection not constructed");
    composition.acceptance.assertSql(sql);
    expect(() => composition.acceptance.assertSql({ ...sql })).toThrow();
    expect(Object.isFrozen(composition)).toBe(true);
    // The entry owns a captured operator selection, not mutable configuration
    // authority supplied later by an HTTP request or an accepted execution DTO.
    Object.assign(selected.runtime.dnsServers, { 0: "8.8.8.8" });
    Object.assign(selected.runtime, { maxConnections: -1 });
    Object.assign(selected.docker, { network: "host" });
    const revisions: SelfhostLinuxDockerAcceptedRevision[] = [];
    const executions: V2Execution[] = [];
    const unexpectedFailures: unknown[] = [];
    let unacceptedCalls = 0;
    const dispatch = async (execution: V2Execution): Promise<V2BackendResult> => {
      executions.push(execution);
      try {
        await expect(
          composition.withAcceptedRevision({ ...execution, generation: 999 }, async () => {
            unacceptedCalls++;
          }),
        ).rejects.toThrow();
        const marker = new Error("synthetic callback outcome");
        await expect(
          composition.withAcceptedRevision(execution, async () => {
            throw marker;
          }),
        ).rejects.toBe(marker);
        for (let index = 0; index < 2; index++) {
          await composition.withAcceptedRevision(execution, async (revision) => {
            revisions.push(revision);
            expect(revision.accepted.principal).toBe("synthetic-node-principal");
            expect(revision.accepted.generation).toBe(1);
            expect(revision.accepted.outboundInternet).toBe(true);
            expect(revision.runtime).toBeInstanceOf(LinuxDockerRuntimePreparation);
            expect(revision.runtime.policy).toMatchObject({
              tenantRef: "synthetic-node-principal",
              generation: 1,
              outboundInternet: true,
            });
            expect(revision.runtime.createCustody.requiredSecretNames).toEqual(["SECRET"]);
            expect(revision.runtime.dnsServers).toEqual(["1.1.1.1"]);
          });
        }
      } catch (error) {
        unexpectedFailures.push(error);
      }
      return { kind: "unknown" };
    };
    const engine = createTakoformV2Engine(
      {
        sql,
        authorize: async () => true,
        replayWindowSeconds: 3600,
        privateInputCustody: {
          transfer: { current: selected.configuredInputs.keyring.current },
          comparison: {
            current: {
              id: "synthetic-node-comparison",
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
            privateInputs: {
              validateCreate: () => {},
              validateUpdate: () => {},
              prepareCreate: composition.configuredInputs.prepareCreate,
              prepareUpdate: composition.configuredInputs.prepareUpdate,
            },
            initialOutput: () => ({}),
            backend: {
              id: selected.backendId,
              targetKey: selected.targetKey,
              execute: dispatch,
              reconcile: dispatch,
            },
          },
        },
      },
      composition.acceptance,
    );
    const fields = CONTAINER_CONTRACT.fields;
    const accepted = await engine.acceptCreate({
      principal: "synthetic-node-principal",
      key: "synthetic-node-create",
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: "synthetic-space",
        name: "synthetic-node-container",
        spec: {
          [fields.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
          [fields.httpPort]: 8080,
          [fields.healthPath]: "/health",
          [fields.workloadRevision]: "1".repeat(64),
          [fields.environment]: {},
          [fields.requiredSensitiveVars]: ["SECRET"],
          [fields.outboundInternet]: true,
        },
        privateInputs: { SECRET: "synthetic-node-transient" },
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: accepted.id });
    expect(unexpectedFailures).toEqual([]);
    expect(unacceptedCalls).toBe(0);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.runtime).toBe(revisions[1]?.runtime);
    expect(revisions[0]?.docker).toBe(revisions[1]?.docker);
    expect(await sql.query("SELECT * FROM tf_v2_container_create_claims")).toEqual([]);
    expect(await sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual([]);
    expect(await sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    const prior = executions[0];
    if (!prior) throw new Error("original execution not observed");
    await expect(
      composition.withAcceptedRevision(prior, async () => {
        unacceptedCalls++;
      }),
    ).rejects.toThrow();
    expect(unacceptedCalls).toBe(0);
    const closing = composition.close();
    expect(composition.close()).toBe(closing);
    await closing;
    await expect(
      composition.withAcceptedRevision(prior, async () => {
        unacceptedCalls++;
      }),
    ).rejects.toThrow("selfhost_linux_docker_core_closed");
    expect(unacceptedCalls).toBe(0);
  } finally {
    database.close();
  }
});
