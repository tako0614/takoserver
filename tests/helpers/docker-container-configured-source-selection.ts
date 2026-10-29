import { Database } from "bun:sqlite";
import { v2ContainerOwnerMigrationCandidate } from "../../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT } from "../../src/container-contract.ts";
import { canonicalDigest } from "../../src/json.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import type { Sql } from "../../src/ports.ts";
import type { HostedContainerSecretKeyring } from "../../src/providers/container-secret-codec.ts";
import {
  createDockerContainerConfiguredInputs,
  validateDockerContainerPrivateInputs,
  validateDockerContainerSensitiveNames,
} from "../../src/providers/docker-container-configured-inputs.ts";
import { createDockerContainerCoreOwner } from "../../src/providers/docker-container-core-owner.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../../src/takoform-v2/configured-update-inputs-schema.ts";
import { V2_CONTAINER_F2_FORM } from "../../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../../src/takoform-v2/engine.ts";
import { CONTAINER_DOCKER_BACKEND_ID } from "../../src/takoform-v2/forms/container-backend.ts";
import type { V2BackendResult, V2Execution } from "../../src/takoform-v2/types.ts";

const f = CONTAINER_CONTRACT.fields;

export const SOURCE_SELECTION = Object.freeze({
  targetKey: "synthetic-docker-source-target",
  providerInstallationId: "synthetic-docker-source-provider",
  backendId: CONTAINER_DOCKER_BACKEND_ID,
});

export const PRINCIPAL = "synthetic-source-principal";
export const SPACE = "synthetic-source-space";

/** Disposable values; none is a credential and none leaves the in-memory database. */
export const VALUE = Object.freeze({
  create: "synthetic-source-create-A",
  second: "synthetic-source-update-B",
  third: "synthetic-source-update-C",
});

/** The owner's native intent encodes the workload revision as 64 lowercase hex. */
export const revision = (digit: string) => digit.repeat(64);

export const containerSpec = (workload: string, names: readonly string[] = ["SECRET"]) => ({
  [f.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
  [f.httpPort]: 8080,
  [f.healthPath]: "/health",
  [f.workloadRevision]: workload,
  [f.environment]: { MODE: workload.slice(0, 8) },
  [f.requiredSensitiveVars]: names,
});

// Unqualified references only; a "main."-qualified one is not rewritten.
const MATERIAL_TABLE = /(?<![\w.])tf_v2_operation_configured_private_inputs\b/gu;

/**
 * Source-discriminating visibility fault.
 *
 * Every SELECT that goes through the fixture's shared Sql (engine, owner proofs
 * and both configured-input readers) stops showing one accepted UPDATE
 * operation's material row. The physical row, its ciphertext and every write
 * stay as they are; only a TEMP VIEW is created, so the main database bytes do
 * not change. The hidden row is selected by table and operation id, not by the
 * shape of a statement, so it applies to a JOIN, an exact read or any future
 * read of that table, and it neither grants authority nor currentness.
 */
export interface MaterialVisibility {
  hide(operationId: string): void;
  readonly hits: () => number;
}

function visibleSql(database: Database, base: Sql): { sql: Sql; visibility: MaterialVisibility } {
  let hidden: string | undefined;
  let hits = 0;
  const sql: Sql = {
    query: async (statement, params) => {
      if (hidden === undefined || !/^\s*(?:SELECT|WITH)\b/iu.test(statement))
        return base.query(statement, params);
      const rewritten = statement.replace(MATERIAL_TABLE, "temp.synthetic_visible_material");
      if (rewritten === statement) return base.query(statement, params);
      hits++;
      return base.query(rewritten, params);
    },
    run: (statement, params) => base.run(statement, params),
    batch: (statements) => base.batch(statements),
  };
  return {
    sql,
    visibility: {
      hide(operationId) {
        if (!/^[A-Za-z0-9-]{1,64}$/u.test(operationId)) throw new TypeError("operation id");
        if (hidden !== undefined) throw new Error("one hidden operation per fixture");
        hidden = operationId;
        database.exec(
          `CREATE TEMP VIEW synthetic_visible_material AS
           SELECT * FROM main.tf_v2_operation_configured_private_inputs
           WHERE operation_id <> '${operationId}'`,
        );
      },
      hits: () => hits,
    },
  };
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export type Dispatch = (input: V2Execution) => Promise<V2BackendResult>;

export type GenuineStage = "scope" | "accepted" | "claim" | "authority" | "environment";

/** What the genuine Core owner path did for the executions routed through it. */
export interface GenuineExecutions {
  /** Every value map that reached the registered native-start callback. */
  readonly started: Record<string, string>[];
  /** Failure that stopped an execution, with the stage that raised it. */
  readonly stopped: { stage: GenuineStage; message: string }[];
}

export async function dockerSourceFixture() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const base = createSqliteSql(database);
  await base.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await base.batch(v2ContainerOwnerMigrationCandidate());
  const { sql, visibility } = visibleSql(database, base);
  const secretKey = await key();
  const keyring: HostedContainerSecretKeyring = {
    current: { id: "synthetic-source-key", key: secretKey },
    keyForDecryption: (id) => (id === "synthetic-source-key" ? secretKey : undefined),
  };
  const owner = createDockerContainerCoreOwner({
    sql,
    clock: () => new Date(),
    installationId: SOURCE_SELECTION.providerInstallationId,
    backendId: SOURCE_SELECTION.backendId,
    targetKey: SOURCE_SELECTION.targetKey,
    configuredInputs: { keyring, maxSecretBytes: 4096 },
  });
  const codec = createDockerContainerConfiguredInputs({
    sql,
    selection: SOURCE_SELECTION,
    keyring,
    owner,
    maxSecretBytes: 4096,
  });
  const names = (value: unknown) => {
    const record = value as Record<string, unknown>;
    return validateDockerContainerSensitiveNames(
      record[f.requiredSensitiveVars],
      Object.keys(record[f.environment] as Record<string, unknown>),
    );
  };
  let dispatch: Dispatch = async () => ({ kind: "complete", observed: {}, output: {} });
  const engine = createTakoformV2Engine(
    {
      sql,
      authorize: async () => true,
      replayWindowSeconds: 3600,
      privateInputCustody: {
        transfer: { current: { id: "synthetic-transfer", key: await key() } },
        comparison: {
          current: {
            id: "synthetic-comparison",
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
          validateCreate: (value) => {
            names(value);
          },
          validateUpdate: (_previous, value) => {
            names(value);
          },
          privateInputs: {
            validateCreate: (value, values) => {
              validateDockerContainerPrivateInputs(names(value), values);
            },
            validateUpdate: (_previous, value, values) => {
              if (values !== undefined) validateDockerContainerPrivateInputs(names(value), values);
            },
            prepareCreate: codec.prepareCreate,
            prepareUpdate: codec.prepareUpdate,
          },
          initialOutput: () => ({}),
          backend: {
            id: SOURCE_SELECTION.backendId,
            targetKey: SOURCE_SELECTION.targetKey,
            execute: (input) => dispatch(input),
            reconcile: (input) => dispatch(input),
          },
        },
      },
    },
    owner.acceptance,
  );
  const genuine: GenuineExecutions = { started: [], stopped: [] };
  /**
   * Routes one accepted Operation through the real Core owner: readAcceptedExecution,
   * claim, withAuthority and withEnvironment. The callback is where a native start
   * would receive its secret environment; here it only records disposable values.
   * Nothing is granted by a boolean, and the execution is the engine's own object.
   */
  const genuineDispatch: Dispatch = async (input) => {
    let stage: GenuineStage = "scope";
    try {
      return await owner.withExecution(input, async () => {
        stage = "accepted";
        const accepted = await owner.readAcceptedExecution(input);
        stage = "claim";
        const identity = await canonicalDigest({
          installation: SOURCE_SELECTION.providerInstallationId,
          resource: accepted.resourceUid,
          incarnation: accepted.incarnationId,
          revision: accepted.revision,
        });
        const { record } = await owner.owner.claim({
          installationId: SOURCE_SELECTION.providerInstallationId,
          resourceUid: accepted.resourceUid,
          incarnationId: accepted.incarnationId,
          revision: accepted.revision,
          nativeName: `takoserver-${identity.slice(7)}`,
          identityLabel: identity,
          revisionLabel: await canonicalDigest({
            role: "synthetic-label",
            revision: accepted.revision,
          }),
          policy: {
            tenantRef: PRINCIPAL,
            generation: accepted.generation,
            policyDigest: await canonicalDigest({ role: "synthetic-policy" }),
            outboundInternet: accepted.outboundInternet,
          },
          requiredSecretNames: accepted.requiredSecretNames,
        });
        stage = "authority";
        await owner.owner.withAuthority(record, "reconcile", async (held) => {
          stage = "environment";
          await held.withEnvironment(async (values) => {
            genuine.started.push({ ...values });
          });
        });
        return { kind: "complete" as const, observed: {}, output: {} };
      });
    } catch (error) {
      genuine.stopped.push({
        stage,
        message: error instanceof Error ? error.message : String(error),
      });
      // The Form contract: a map that cannot be recovered fails secret_unavailable before any start.
      return {
        kind: "no_effect" as const,
        code: "secret_unavailable",
        message: "The required sensitive values are unavailable",
      };
    }
  };
  return {
    /** Bytes of the main database; equal before and after means nothing was written. */
    fingerprint: () => Buffer.from(database.serialize()),
    genuine,
    genuineDispatch,
    database,
    sql,
    owner,
    codec,
    engine,
    visibility,
    dispatch: (work: Dispatch) => {
      dispatch = work;
    },
    create: (name: string, privateInputs: Record<string, string>, nameList = ["SECRET"]) =>
      engine.acceptCreate({
        principal: PRINCIPAL,
        key: crypto.randomUUID(),
        input: {
          form: V2_CONTAINER_F2_FORM,
          space: SPACE,
          name,
          spec: containerSpec(revision("1"), nameList),
          privateInputs,
        },
      }),
    update: (
      uid: string,
      expectedGeneration: number,
      workload: string,
      privateInputs?: Record<string, string>,
      nameList = ["SECRET"],
    ) =>
      engine.acceptUpdate({
        principal: PRINCIPAL,
        key: crypto.randomUUID(),
        uid,
        expectedGeneration,
        spec: containerSpec(workload, nameList),
        ...(privateInputs === undefined ? {} : { privateInputs }),
      }),
  };
}
