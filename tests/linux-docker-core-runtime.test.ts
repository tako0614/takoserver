import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT } from "../src/container-contract.ts";
import { canonicalDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createDockerContainerConfiguredInputs } from "../src/providers/docker-container-configured-inputs.ts";
import type {
  DockerContainerCreateDriver,
  DockerContainerCreateTarget,
} from "../src/providers/docker-container-create-custody.ts";
import { LinuxDockerRuntimePreparation } from "../src/providers/linux-docker-runtime-preparation.ts";
import {
  createLinuxDockerCoreRuntime,
  type LinuxDockerCorePreparationOptions,
} from "../src/providers/selfhost-extension.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { V2_CONTAINER_F2_FORM } from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { CONTAINER_DOCKER_BACKEND_ID } from "../src/takoform-v2/forms/container-backend.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";

const selection = {
  installationId: "synthetic-linux-provider",
  backendId: CONTAINER_DOCKER_BACKEND_ID,
  targetKey: "synthetic-linux-target",
};
const principal = "synthetic-linux-principal";
const policy = {
  tenantRef: principal,
  generation: 1,
  policyDigest: `sha256:${"a".repeat(64)}`,
  outboundInternet: true,
};
function preparation(): LinuxDockerCorePreparationOptions {
  return {
    policy,
    requiredSecretNames: [],
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
    maxConnections: 3,
    packetLimitBytes: 4096,
  };
}

async function configuredInputs() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    keyring: {
      current: { id: "synthetic-key", key },
      keyForDecryption: (id: string) => (id === "synthetic-key" ? key : undefined),
    },
    maxSecretBytes: 4096,
  };
}

test("Linux composition shares actual Core acceptance and unknown CREATE custody across runtimes", async () => {
  // Only this disposable SQLite is real. No Linux runtime method is invoked:
  // the driver below simulates an uncertain CREATE ACK and observes no native object.
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    await sql.batch(
      frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
    );
    await sql.batch(v2ContainerOwnerMigrationCandidate());
    const configured = await configuredInputs();
    const composition = createLinuxDockerCoreRuntime({
      ...selection,
      sql,
      clock: () => new Date(),
      configuredInputs: configured,
    });
    const codec = createDockerContainerConfiguredInputs({
      sql,
      selection: {
        providerInstallationId: selection.installationId,
        backendId: selection.backendId,
        targetKey: selection.targetKey,
      },
      owner: composition.owner,
      ...configured,
    });
    composition.owner.acceptance.assertSql(sql);
    expect(() => composition.owner.acceptance.assertSql({ ...sql })).toThrow();
    expect(Object.isFrozen(composition)).toBe(true);
    let creates = 0;
    let inspections = 0;
    const driver: DockerContainerCreateDriver = {
      inspect: async () => {
        inspections++;
        return null;
      },
      create: async () => {
        creates++;
        throw new Error("synthetic unknown CREATE ACK");
      },
      stop: async () => {
        throw new Error("stop must not run");
      },
      remove: async () => {
        throw new Error("remove must not run");
      },
    };
    let target: DockerContainerCreateTarget | undefined;
    const runtimes: LinuxDockerRuntimePreparation[] = [];
    let dispatches = 0;
    let dispatchFailure: unknown;
    const dispatch = (input: V2Execution): Promise<V2BackendResult> => {
      const running = composition.owner.withExecution(input, async () => {
        dispatches++;
        const accepted = await composition.owner.readAcceptedExecution(input);
        const identityLabel = await canonicalDigest({
          installation: accepted.installationId,
          resource: accepted.resourceUid,
          incarnation: accepted.incarnationId,
          revision: accepted.revision,
        });
        target = {
          installationId: accepted.installationId,
          resourceUid: accepted.resourceUid,
          incarnationId: accepted.incarnationId,
          revision: accepted.revision,
          nativeName: `takoserver-${identityLabel.slice(7)}`,
          identityLabel,
          revisionLabel: await canonicalDigest({ revision: accepted.revision }),
        };
        const options = {
          ...preparation(),
          policy: { ...policy, generation: accepted.generation },
          requiredSecretNames: accepted.requiredSecretNames,
        };
        const wrong = composition.createRuntime({
          ...options,
          policy: { ...options.policy, generation: accepted.generation + 1 },
        });
        await expect(
          wrong.createCustody.withAuthority(target, "reconcile", driver, async () => undefined),
        ).rejects.toThrow();
        expect(creates).toBe(0);
        expect(inspections).toBe(0);
        for (let index = 0; index < 2; index++) {
          const runtime = composition.createRuntime(options);
          runtimes.push(runtime);
          expect(runtime).toBeInstanceOf(LinuxDockerRuntimePreparation);
          expect(Object.isFrozen(runtime)).toBe(true);
          const observed = await runtime.createCustody.withAuthority(
            target,
            "reconcile",
            driver,
            (session) => session.ensureCreated(),
          );
          expect(observed).toBeNull();
          expect(creates).toBe(1);
        }
        return { kind: "unknown" as const };
      });
      return running.catch((error: unknown) => {
        dispatchFailure = error;
        throw error;
      });
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
              prepareCreate: codec.prepareCreate,
              prepareUpdate: codec.prepareUpdate,
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
      composition.owner.acceptance,
    );
    const f = CONTAINER_CONTRACT.fields;
    const created = await engine.acceptCreate({
      principal,
      key: "synthetic-linux-create",
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: "synthetic-space",
        name: "synthetic-linux-container",
        spec: {
          [f.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
          [f.httpPort]: 8080,
          [f.healthPath]: "/health",
          [f.workloadRevision]: "1".repeat(64),
          [f.environment]: {},
          [f.requiredSensitiveVars]: [],
          [f.outboundInternet]: true,
        },
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: created.id });
    expect(dispatchFailure).toBeUndefined();
    expect(dispatches).toBe(1);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[0]).not.toBe(runtimes[1]);
    expect(creates).toBe(1);
    expect(inspections).toBe(3);
    expect(await sql.query("SELECT state,native_id FROM tf_v2_container_create_claims")).toEqual([
      { state: "pending", native_id: null },
    ]);
    expect(await sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual([]);
    expect(await sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    if (!target) throw new Error("accepted target missing");
    const retained = runtimes[0];
    if (!retained) throw new Error("accepted runtime missing");
    await expect(
      retained.createCustody.withAuthority(target, "reconcile", driver, (session) =>
        session.ensureCreated(),
      ),
    ).rejects.toThrow();
    expect(creates).toBe(1);
    expect(inspections).toBe(3);
  } finally {
    database.close();
  }
});

test("creator requires original configured custody and rejects supplied authority ports", async () => {
  const database = new Database(":memory:");
  try {
    const sql = createSqliteSql(database);
    const composition = createLinuxDockerCoreRuntime({
      ...selection,
      sql,
      clock: () => new Date(),
    });
    // The original owner's configured-input requirement must precede the Linux
    // constructor, which alone could otherwise construct a local custody object.
    expect(() =>
      composition.createRuntime({ ...preparation(), requiredSecretNames: ["SECRET"] }),
    ).toThrow();
    let injectedReads = 0;
    for (const name of ["owner", "createCustody"]) {
      const injected = Object.defineProperty(preparation(), name, {
        get() {
          injectedReads++;
          throw new Error("caller authority must not be read");
        },
        enumerable: true,
      });
      expect(() => composition.createRuntime(injected)).toThrow(
        "linux_docker_core_runtime_invalid_request",
      );
    }
    expect(injectedReads).toBe(0);
    const foreign = createLinuxDockerCoreRuntime({ ...selection, sql, clock: () => new Date() });
    const foreignRuntime = foreign.createRuntime(preparation());
    expect(() =>
      composition.createRuntime({ ...preparation(), ...{ owner: foreign.owner.owner } }),
    ).toThrow("linux_docker_core_runtime_invalid_request");
    expect(() =>
      composition.createRuntime({
        ...preparation(),
        ...{ createCustody: foreignRuntime.createCustody },
      }),
    ).toThrow("linux_docker_core_runtime_invalid_request");
    const configured = createLinuxDockerCoreRuntime({
      ...selection,
      sql,
      clock: () => new Date(),
      configuredInputs: await configuredInputs(),
    });
    const runtime = configured.createRuntime({ ...preparation(), requiredSecretNames: ["SECRET"] });
    expect(runtime.createCustody.requiredSecretNames).toEqual(["SECRET"]);
    expect(runtime.policy).toEqual(policy);
    expect(() => configured.createRuntime({ ...preparation(), dnsServers: [] })).toThrow();
    expect(() => configured.createRuntime({ ...preparation(), maxConnections: -1 })).toThrow();
  } finally {
    database.close();
  }
});
