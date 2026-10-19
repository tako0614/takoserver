import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import type { HostedContainerSecretKeyring } from "../src/providers/container-secret-codec.ts";
import {
  createDockerContainerConfiguredInputs,
  validateDockerContainerPrivateInputs,
  validateDockerContainerSensitiveNames,
} from "../src/providers/docker-container-configured-inputs.ts";
import { createDockerContainerCoreOwner } from "../src/providers/docker-container-core-owner.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { V2_CONTAINER_F2_FORM } from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { CONTAINER_DOCKER_BACKEND_ID } from "../src/takoform-v2/forms/container-backend.ts";
import type { V2PrivateInputCustody } from "../src/takoform-v2/private-inputs.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";
import { currentAuditedSchemaMigrations } from "./helpers/audited-schema-fixture.ts";

const f = CONTAINER_CONTRACT.fields;

const selection = {
  targetKey: "target",
  providerInstallationId: "provider",
  backendId: CONTAINER_DOCKER_BACKEND_ID,
};

const secret = "synthetic-configured-create-value";

const spec = (revision = "one", names: readonly string[] = ["SECRET"]) => ({
  [f.image]: `registry.example/app@sha256:${"1".repeat(64)}`,
  [f.httpPort]: 8080,
  [f.healthPath]: "/health",
  [f.workloadRevision]: revision,
  [f.environment]: { MODE: revision },
  [f.requiredSensitiveVars]: names,
});

async function keyring(): Promise<HostedContainerSecretKeyring> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    current: { id: "configured-key", key },
    keyForDecryption: (id) => (id === "configured-key" ? key : undefined),
  };
}

async function transferCustody(): Promise<V2PrivateInputCustody> {
  return {
    transfer: {
      current: {
        id: "transfer",
        key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]),
      },
    },
    comparison: {
      current: {
        id: "comparison",
        key: await crypto.subtle.generateKey(
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign", "verify"],
        ),
      },
    },
    transferTtlSeconds: 300,
  };
}

function declared(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid_spec");
  const record = value as Record<string, unknown>;
  const environment = record[f.environment];
  if (environment === null || typeof environment !== "object" || Array.isArray(environment))
    throw new TypeError("invalid_spec");
  return validateDockerContainerSensitiveNames(
    record[f.requiredSensitiveVars],
    Object.keys(environment),
  );
}

async function fixture() {
  const database = new Database(":memory:");
  expect(currentAuditedSchemaMigrations()).toHaveLength(100);
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  let materialReads = 0;
  const codecSql: Sql = {
    ...sql,
    query: async (statement, params) => {
      if (statement.includes("SELECT material.key_id")) materialReads++;
      return sql.query(statement, params);
    },
  };
  const keys = await keyring();
  const owner = createDockerContainerCoreOwner({
    sql: codecSql,
    clock: () => new Date(),
    installationId: selection.providerInstallationId,
    backendId: selection.backendId,
    targetKey: selection.targetKey,
  });
  const codec = createDockerContainerConfiguredInputs({
    sql: codecSql,
    selection,
    keyring: keys,
    owner,
    maxSecretBytes: 4096,
  });
  const abort = new AbortController();
  let live = true,
    now = Date.now();
  let dispatch: (input: V2Execution) => Promise<V2BackendResult> = async () => ({
    kind: "unknown",
  });
  const hooks = {
    validateCreate(value: V2Execution["spec"], inputs: V2Execution["privateInputs"]) {
      const names = declared(value);
      validateDockerContainerPrivateInputs(names, inputs);
    },
    validateUpdate(
      _previous: V2Execution["spec"],
      value: V2Execution["spec"],
      inputs: V2Execution["privateInputs"],
    ) {
      const names = declared(value);
      if (inputs !== undefined) validateDockerContainerPrivateInputs(names, inputs);
    },
    prepareCreate: codec.prepareCreate,
    prepareUpdate: codec.prepareUpdate,
  };
  const engine = createTakoformV2Engine({
    sql,
    authorize: async () => true,
    replayWindowSeconds: 3600,
    now: () => new Date(now),
    privateInputCustody: await transferCustody(),
    forms: {
      [V2_CONTAINER_F2_FORM]: {
        validateCreate: (value) => {
          declared(value);
        },
        validateUpdate: (_previous, value) => {
          declared(value);
        },
        privateInputs: hooks,
        initialOutput: () => ({}),
        backend: {
          id: CONTAINER_DOCKER_BACKEND_ID,
          targetKey: selection.targetKey,
          execute: (input) => dispatch(input),
          reconcile: (input) => dispatch(input),
        },
      },
    },
  });

  // Projection deliberately excludes selection.backendId from the closed scope.

  return {
    database,
    sql,
    codec,
    keys,
    engine,
    hooks,
    materialReads: () => materialReads,

    lease: { revocation: abort.signal, stillCurrent: async () => live },
    revoke: () => {
      live = false;
      abort.abort();
    },
    advance: () => {
      now += 120_000;
    },
    dispatch: (work: typeof dispatch) => {
      dispatch = work;
    },
    create: (
      key = "configured-create-owner",
      name = "container",
      names: readonly string[] = ["SECRET"],
      privateInputs?: V2Execution["privateInputs"],
    ) =>
      engine.acceptCreate({
        principal: "principal",
        key,
        input: {
          form: V2_CONTAINER_F2_FORM,
          space: "space",
          name,
          spec: spec("one", names),
          ...(privateInputs === undefined && names.length > 0
            ? { privateInputs: { SECRET: secret } }
            : privateInputs === undefined
              ? {}
              : { privateInputs }),
        },
      }),
  };
}

test("Docker adapter participates in actual Core accepted full-map and omitted UPDATE history", async () => {
  const fx = await fixture();
  try {
    const created = await fx.create(crypto.randomUUID(), "docker-regression", ["SECRET"], {
      SECRET: secret,
    });
    expect(created.resourceUid).toBeDefined();
    fx.dispatch(async () => ({ kind: "complete", observed: {}, output: {} }));
    expect(await fx.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const identity = {
      principal: "principal",
      space: "space",
      name: "docker-regression",
      form: V2_CONTAINER_F2_FORM,
      resourceUid: created.resourceUid,
    };
    const stable = await readV2ConfiguredPrivateInputs(fx.sql, identity);
    expect(stable).not.toBeNull();
    const state = fx.database
      .query("SELECT busy_operation, generation FROM tf_v2_resources WHERE uid = ?")
      .get(created.resourceUid) as { busy_operation: string | null; generation: number };
    expect(state.busy_operation).toBeNull();
    expect(state.generation).toBe(1);
    const accepted = await fx.engine.acceptUpdate({
      principal: "principal",
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: spec("r2"),
      privateInputs: { SECRET: "replacement" },
    });
    expect(await fx.engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    const selected = await readV2ConfiguredPrivateInputs(fx.sql, identity, {
      operationId: accepted.id,
      generation: 2,
    });
    expect(selected).not.toBeNull();
    expect(selected).not.toEqual(stable);
    const omitted = await fx.engine.acceptUpdate({
      principal: "principal",
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 2,
      spec: spec("r3"),
    });
    expect(omitted.generation).toBe(3);
    const missing = await readV2ConfiguredPrivateInputs(fx.sql, identity, {
      operationId: omitted.id,
      generation: 3,
    });
    expect(missing).toBeNull();
  } finally {
    fx.database.close();
  }
});

test("Docker adapter accepts name removal by omitted PUT and requires a full map to re-add", async () => {
  const fx = await fixture();
  try {
    const principal = "principal";
    const name = "docker-names";
    const created = await fx.create(crypto.randomUUID(), name, ["OTHER", "SECRET"], {
      OTHER: "other-value",
      SECRET: secret,
    });
    fx.dispatch(async () => ({ kind: "complete", observed: {}, output: {} }));
    expect(await fx.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const removed = await fx.engine.acceptUpdate({
      principal,
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: spec("r2", ["SECRET"]),
    });
    expect(removed.generation).toBe(2);
    expect(await fx.engine.runNext()).toMatchObject({ id: removed.id, status: "succeeded" });
    const before = Buffer.from(fx.database.serialize());
    await expect(
      fx.engine.acceptUpdate({
        principal,
        key: crypto.randomUUID(),
        uid: created.resourceUid,
        expectedGeneration: 2,
        spec: spec("r3", ["OTHER", "SECRET"]),
      }),
    ).rejects.toThrow("invalid_spec");
    expect(Buffer.from(fx.database.serialize()).equals(before)).toBe(true);
    const restored = await fx.engine.acceptUpdate({
      principal,
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 2,
      spec: spec("r4", ["OTHER", "SECRET"]),
      privateInputs: { OTHER: "next-other", SECRET: "next-secret" },
    });
    expect(restored.generation).toBe(3);
    const identity = {
      principal,
      space: "space",
      name,
      form: V2_CONTAINER_F2_FORM,
      resourceUid: created.resourceUid,
    };
    expect(
      await readV2ConfiguredPrivateInputs(fx.sql, identity, {
        operationId: restored.id,
        generation: 3,
      }),
    ).not.toBeNull();
  } finally {
    fx.database.close();
  }
});

test("failed accepted replacement remains selectable through omitted removal and empty projection", async () => {
  const fx = await fixture();
  try {
    const principal = "principal";
    const name = "docker-failed";
    const created = await fx.create(crypto.randomUUID(), name, ["OTHER", "SECRET"], {
      OTHER: "old-other",
      SECRET: secret,
    });
    fx.dispatch(async () => ({ kind: "complete", observed: {}, output: {} }));
    expect(await fx.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const identity = {
      principal,
      space: "space",
      name,
      form: V2_CONTAINER_F2_FORM,
      resourceUid: created.resourceUid,
    };
    const initial = await readV2ConfiguredPrivateInputs(fx.sql, identity);
    expect(initial).not.toBeNull();
    const key = crypto.randomUUID();
    const replacement = { OTHER: "new-other", SECRET: "new-secret" };
    const replaced = await fx.engine.acceptUpdate({
      principal,
      key,
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: spec("r2", ["OTHER", "SECRET"]),
      privateInputs: replacement,
    });
    fx.dispatch(async () => ({
      kind: "no_effect",
      code: "backend_failure",
      message: "backend failed after acceptance",
    }));
    expect(await fx.engine.runNext()).toMatchObject({ id: replaced.id, status: "failed" });
    const selected = await readV2ConfiguredPrivateInputs(fx.sql, identity, {
      operationId: replaced.id,
      generation: 2,
    });
    expect(selected).not.toBeNull();
    expect(selected).not.toEqual(initial);
    expect(
      (
        await fx.engine.acceptUpdate({
          principal,
          key,
          uid: created.resourceUid,
          expectedGeneration: 1,
          spec: spec("r2", ["OTHER", "SECRET"]),
          privateInputs: replacement,
        })
      ).id,
    ).toBe(replaced.id);
    fx.dispatch(async () => ({ kind: "complete", observed: {}, output: {} }));
    const omitted = await fx.engine.acceptUpdate({
      principal,
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 2,
      spec: spec("r3", ["OTHER", "SECRET"]),
    });
    expect(
      await readV2ConfiguredPrivateInputs(fx.sql, identity, {
        operationId: omitted.id,
        generation: 3,
      }),
    ).toBeNull();
    expect(await fx.engine.runNext()).toMatchObject({ id: omitted.id, status: "succeeded" });
    const removed = await fx.engine.acceptUpdate({
      principal,
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 3,
      spec: spec("r4", ["SECRET"]),
    });
    expect(
      await readV2ConfiguredPrivateInputs(fx.sql, identity, {
        operationId: removed.id,
        generation: 4,
      }),
    ).toBeNull();
    expect(await fx.engine.runNext()).toMatchObject({ id: removed.id, status: "succeeded" });
    const empty = await fx.engine.acceptUpdate({
      principal,
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 4,
      spec: spec("r5", []),
    });
    expect(
      await readV2ConfiguredPrivateInputs(fx.sql, identity, {
        operationId: empty.id,
        generation: 5,
      }),
    ).toBeNull();
    expect(await fx.engine.runNext()).toMatchObject({ id: empty.id, status: "succeeded" });
    const before = Buffer.from(fx.database.serialize());
    await expect(
      fx.engine.acceptUpdate({
        principal,
        key: crypto.randomUUID(),
        uid: created.resourceUid,
        expectedGeneration: 5,
        spec: spec("r6", ["SECRET"]),
      }),
    ).rejects.toThrow("invalid_spec");
    expect(Buffer.from(fx.database.serialize()).equals(before)).toBe(true);
  } finally {
    fx.database.close();
  }
});
