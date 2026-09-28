import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createTakoformDeleteSubeffectStore,
  type TakoformDeleteSubeffectInput,
} from "../src/takoform/provider-delete-subeffect.ts";

const OPERATION = "op_actor_delete_1";
const TENANT = "tenant-actor-delete";
const UID = "uid_actor_namespace_1";
const FINGERPRINT = "delete-actor-fingerprint";
const ADDRESS = {
  space: "main",
  apiVersion: "actors.forms.takoform.com/v1alpha1",
  kind: "ActorNamespace",
  name: "room",
} as const;
const TOMBSTONE_DIGEST = `sha256:${"a".repeat(64)}` as const;
const SCRIPT_DIGEST = `sha256:${"b".repeat(64)}` as const;

function ticket(
  subeffectName: "actor-tombstone" | "actor-script-delete",
  mode: "initial" | "recovery" = "initial",
  leaseToken = "lease-initial",
): TakoformDeleteSubeffectInput {
  return {
    tenantId: TENANT,
    resourceUid: UID,
    operationId: OPERATION,
    fingerprint: FINGERPRINT,
    leaseToken,
    operationMode: mode,
    expectedAddress: ADDRESS,
    subeffectName,
    providerPackRef: "cloudflare",
    providerInstallationRef: "cloudflare.installation",
    nativeId: "actor:0123456789abcdef0123456789abcdef",
    identityDigest: subeffectName === "actor-tombstone" ? TOMBSTONE_DIGEST : SCRIPT_DIGEST,
  };
}

async function seedAcceptedDelete(
  sql: Sql,
  createdAt = Date.now(),
  leaseUntil = createdAt + 60_000,
): Promise<number> {
  // Authority also checks the real database clock. Sample per fixture, after
  // migration/setup, rather than using a fixed date or the file's import time.
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 3, ?, ?, ?)`,
    [
      TENANT,
      UID,
      ADDRESS.space,
      ADDRESS.apiVersion,
      ADDRESS.kind,
      ADDRESS.name,
      JSON.stringify({
        apiVersion: ADDRESS.apiVersion,
        kind: ADDRESS.kind,
        definitionVersion: "1.0.0",
        schemaDigest: `sha256:${"c".repeat(64)}`,
      }),
      JSON.stringify([
        {
          eventId: `${OPERATION}:planned`,
          operationId: OPERATION,
          kind: "delete",
          phase: "planned",
          operationMode: "initial",
        },
        {
          eventId: `${OPERATION}:dispatched`,
          operationId: OPERATION,
          kind: "delete",
          phase: "dispatched",
          operationMode: "initial",
        },
      ]),
      createdAt,
      createdAt,
    ],
  );
  await sql.run(
    `INSERT INTO tf_provider_mutation_sagas_selection_v1
       (operation_id, protocol_generation, operation_kind, replay_key, tenant_id,
        fingerprint, resource_uid, target_space, target_api_version,
        target_kind, target_name, accepted_uid, accepted_generation,
        accepted_revision, phase, receipt_json, created_at, updated_at,
        expires_at, execution_lease_token, execution_lease_until,
        execution_started_at, provider_outcome)
     VALUES (?, 1, 'delete', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generation-1',
       'revision-1', 'planned', NULL, ?, ?, 253402300799999, ?, ?, ?, 'running')`,
    [
      OPERATION,
      `replay-${OPERATION}`,
      TENANT,
      FINGERPRINT,
      UID,
      ADDRESS.space,
      ADDRESS.apiVersion,
      ADDRESS.kind,
      ADDRESS.name,
      UID,
      createdAt,
      createdAt,
      "lease-initial",
      leaseUntil,
      createdAt,
    ],
  );
  for (const phase of ["planned", "dispatched"]) {
    await sql.run(
      `INSERT INTO tf_resource_provider_effects
         (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
          operation_mode, created_at)
       VALUES (?, ?, ?, ?, 'delete', ?, 'initial', ?)`,
      [TENANT, UID, `${OPERATION}:${phase}`, OPERATION, phase, createdAt],
    );
  }
  return createdAt;
}

async function rotateLease(sql: Sql, now: number): Promise<void> {
  await sql.run(
    `UPDATE tf_provider_mutation_sagas_selection_v1
     SET execution_lease_token = 'lease-recovery', execution_lease_until = ?, updated_at = ?
     WHERE operation_id = ?`,
    [now + 120_000, now + 1, OPERATION],
  );
}

async function rows(sql: Sql) {
  return await sql.query(
    `SELECT effect_id, phase, operation_mode FROM tf_resource_provider_effects
     WHERE tenant_id = ? AND resource_uid = ? AND effect_id <> ?
     ORDER BY effect_id, phase`,
    [TENANT, UID, OPERATION],
  );
}

test("Host subeffect CAS grants exactly one native writer and recovery terminalizes both effects", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const now = await seedAcceptedDelete(sql);
    const store = createTakoformDeleteSubeffectStore(sql, () => now + 2);
    const tombstone = ticket("actor-tombstone");
    expect(await store.readExact(tombstone)).toBe("absent");
    const outcomes = await Promise.all([store.issue(tombstone), store.issue(tombstone)]);
    expect(outcomes.filter((value) => value === "claimed")).toHaveLength(1);
    expect(outcomes.every((value) => value === "claimed" || value === "already-issued")).toBe(true);
    expect(await store.readExact(tombstone)).toBe("issued");
    expect(
      await store.issue({
        ...ticket("actor-script-delete"),
        requiresSucceededSubeffect: { name: "actor-tombstone", identityDigest: TOMBSTONE_DIGEST },
      }),
    ).toBe("conflict");

    await rotateLease(sql, now);
    expect(await store.readExact(tombstone)).toBe("conflict");
    expect(await store.issue(tombstone)).toBe("conflict");
    expect(await store.concludeExact(tombstone)).toBe("conflict");
    const recoveryTombstone = ticket("actor-tombstone", "recovery", "lease-recovery");
    expect(await store.readExact({ ...recoveryTombstone, fingerprint: "wrong-fingerprint" })).toBe(
      "conflict",
    );
    expect(await store.issue({ ...recoveryTombstone, identityDigest: SCRIPT_DIGEST })).toBe(
      "conflict",
    );
    expect(await store.readExact(recoveryTombstone)).toBe("issued");
    expect(await store.issue(recoveryTombstone)).toBe("already-issued");
    expect(await store.concludeExact(recoveryTombstone)).toBe("recorded");
    expect(await store.concludeExact(recoveryTombstone)).toBe("existing");
    expect(await store.readExact(recoveryTombstone)).toBe("succeeded");

    const script = ticket("actor-script-delete", "recovery", "lease-recovery");
    expect(
      await store.issue({
        ...script,
        requiresSucceededSubeffect: { name: "actor-tombstone", identityDigest: TOMBSTONE_DIGEST },
      }),
    ).toBe("claimed");
    expect(await store.concludeExact(script)).toBe("recorded");
    expect(await store.readExact(script)).toBe("succeeded");
    expect(await rows(sql)).toHaveLength(6);
    expect(await sql.query("SELECT token FROM tf_operation_commit_guards")).toEqual([]);
    const open = await sql.query(
      `SELECT effect_id FROM tf_resource_provider_effects AS effect
       WHERE effect.tenant_id = ? AND effect.resource_uid = ?
         AND effect.phase IN ('planned', 'dispatched')
         AND NOT EXISTS (
           SELECT 1 FROM tf_resource_provider_effects AS terminal
           WHERE terminal.tenant_id = effect.tenant_id
             AND terminal.resource_uid = effect.resource_uid
             AND terminal.effect_id = effect.effect_id
             AND terminal.phase IN ('succeeded', 'cancelled')
         )`,
      [TENANT, UID],
    );
    expect(open.map((row) => row.effect_id)).toEqual([OPERATION, OPERATION]);
  } finally {
    database.close();
  }
});

test("an expired database lease is refused even when the injected clock is still valid", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const start = Date.now() - 120_000;
    await seedAcceptedDelete(sql, start, start + 60_000);
    const store = createTakoformDeleteSubeffectStore(sql, () => start + 2);
    const tombstone = ticket("actor-tombstone");
    expect(await store.readExact(tombstone)).toBe("conflict");
    expect(await store.issue(tombstone)).toBe("conflict");
    expect(await store.concludeExact(tombstone)).toBe("conflict");
    expect(await rows(sql)).toEqual([]);
    expect(await sql.query("SELECT token FROM tf_operation_commit_guards")).toEqual([]);
  } finally {
    database.close();
  }
});

test("a batch queued past lease expiry cannot grant a native write", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const start = Date.now();
    const leaseUntil = start + 500;
    await seedAcceptedDelete(sql, start, leaseUntil);
    let authorityObserved = false;
    const delayedSql: Sql = {
      ...sql,
      async query(statement, params) {
        const result = await sql.query(statement, params);
        if (statement.startsWith("SELECT 1 AS valid WHERE") && result.length === 1)
          authorityObserved = true;
        return result;
      },
      async batch(statements) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, leaseUntil - Date.now() + 50)),
        );
        return await sql.batch(statements);
      },
    };
    const store = createTakoformDeleteSubeffectStore(delayedSql, () => start);
    expect(await store.issue(ticket("actor-tombstone"))).toBe("conflict");
    expect(authorityObserved).toBe(true);
    expect(await rows(sql)).toEqual([]);
  } finally {
    database.close();
  }
});

test("recovery rejects an issued effect whose attestation mirror is missing", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const now = await seedAcceptedDelete(sql);
    const store = createTakoformDeleteSubeffectStore(sql, () => now + 2);
    const tombstone = ticket("actor-tombstone");
    expect(await store.issue(tombstone)).toBe("claimed");
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET effects_json = json_remove(effects_json, '$[3]')
       WHERE tenant_id = ? AND resource_uid = ?`,
      [TENANT, UID],
    );
    await rotateLease(sql, now);
    const recovery = ticket("actor-tombstone", "recovery", "lease-recovery");
    expect(await store.readExact(recovery)).toBe("conflict");
    expect(await store.concludeExact(recovery)).toBe("conflict");
  } finally {
    database.close();
  }
});

test("conclusion cannot terminalize when the mirror changes after its read", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const now = await seedAcceptedDelete(sql);
    const tombstone = ticket("actor-tombstone");
    expect(await createTakoformDeleteSubeffectStore(sql, () => now + 2).issue(tombstone)).toBe(
      "claimed",
    );
    const raceSql: Sql = {
      ...sql,
      async batch(statements) {
        await sql.run(
          `UPDATE tf_resource_deletion_attestations
           SET effects_json = json_remove(effects_json, '$[3]')
           WHERE tenant_id = ? AND resource_uid = ?`,
          [TENANT, UID],
        );
        return await sql.batch(statements);
      },
    };
    const store = createTakoformDeleteSubeffectStore(raceSql, () => now + 2);
    expect(await store.concludeExact(tombstone)).toBe("conflict");
    expect(await rows(sql)).toHaveLength(2);
  } finally {
    database.close();
  }
});

test("conclusion does not repair an unmirrored terminal row inserted after its read", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const now = await seedAcceptedDelete(sql);
    const tombstone = ticket("actor-tombstone");
    expect(await createTakoformDeleteSubeffectStore(sql, () => now + 2).issue(tombstone)).toBe(
      "claimed",
    );
    const raceSql: Sql = {
      ...sql,
      async batch(statements) {
        await sql.run(
          `INSERT INTO tf_resource_provider_effects
             (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
              operation_mode, provider_pack_ref, provider_installation_ref,
              native_id, target_json, created_at)
           SELECT tenant_id, resource_uid, effect_id || ':succeeded', effect_id,
                  effect_kind, 'succeeded', operation_mode, provider_pack_ref,
                  provider_installation_ref, native_id, target_json, ?
           FROM tf_resource_provider_effects
           WHERE tenant_id = ? AND resource_uid = ? AND event_id = ?`,
          [now + 2, TENANT, UID, `${OPERATION}:actor-tombstone:dispatched`],
        );
        return await sql.batch(statements);
      },
    };
    const store = createTakoformDeleteSubeffectStore(raceSql, () => now + 2);
    expect(await store.concludeExact(tombstone)).toBe("conflict");
    const snapshot = await sql.query(
      `SELECT effects_json FROM tf_resource_deletion_attestations
       WHERE tenant_id = ? AND resource_uid = ?`,
      [TENANT, UID],
    );
    expect(JSON.parse(String(snapshot[0]?.effects_json))).toHaveLength(4);
    expect(await store.readExact(tombstone)).toBe("conflict");
  } finally {
    database.close();
  }
});

test("exact reads reject changed issued and missing terminal mirrors", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const now = await seedAcceptedDelete(sql);
    const store = createTakoformDeleteSubeffectStore(sql, () => now + 2);
    const tombstone = ticket("actor-tombstone");
    expect(await store.issue(tombstone)).toBe("claimed");
    const original = await sql.query(
      `SELECT effects_json FROM tf_resource_deletion_attestations
       WHERE tenant_id = ? AND resource_uid = ?`,
      [TENANT, UID],
    );
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET effects_json = json_set(effects_json, '$[2].nativeId', 'actor:wrong')
       WHERE tenant_id = ? AND resource_uid = ?`,
      [TENANT, UID],
    );
    expect(await store.readExact(tombstone)).toBe("conflict");
    await sql.run(
      `UPDATE tf_resource_deletion_attestations SET effects_json = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [String(original[0]?.effects_json), TENANT, UID],
    );
    expect(await store.concludeExact(tombstone)).toBe("recorded");
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET effects_json = json_remove(effects_json, '$[4]')
       WHERE tenant_id = ? AND resource_uid = ?`,
      [TENANT, UID],
    );
    expect(await store.readExact(tombstone)).toBe("conflict");
    expect(await store.concludeExact(tombstone)).toBe("conflict");
  } finally {
    database.close();
  }
});

test("real D1 rolls back row and JSON mirror together and never reissues after a lost ACK", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "delete-subeffect-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "delete-subeffect-d1" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    const sql = createD1Sql(database);
    const now = await seedAcceptedDelete(sql);
    const tombstone = ticket("actor-tombstone");
    const faultSql: Sql = {
      ...sql,
      async batch(statements) {
        return await sql.batch([
          ...statements.slice(0, -1),
          {
            sql: "INSERT INTO tf_operation_commit_guards (token, valid) VALUES ('forced-failure', 0)",
          },
          statements[statements.length - 1] as (typeof statements)[number],
        ]);
      },
    };
    const faultStore = createTakoformDeleteSubeffectStore(faultSql, () => now + 2);
    expect(await faultStore.issue(tombstone)).toBe("conflict");
    expect(await rows(sql)).toEqual([]);
    const before = await sql.query(
      `SELECT effects_json, closure_fence FROM tf_resource_deletion_attestations
       WHERE tenant_id = ? AND resource_uid = ?`,
      [TENANT, UID],
    );
    expect(before[0]?.closure_fence).toBe(3);
    expect(JSON.parse(String(before[0]?.effects_json))).toHaveLength(2);

    let first = true;
    const lostAckSql: Sql = {
      ...sql,
      async batch(statements) {
        const result = await sql.batch(statements);
        if (first) {
          first = false;
          throw new Error("simulated lost acknowledgement");
        }
        return result;
      },
    };
    const lostAckStore = createTakoformDeleteSubeffectStore(lostAckSql, () => now + 2);
    expect(await lostAckStore.issue(tombstone)).toBe("conflict");
    expect(await rows(sql)).toHaveLength(2);
    const after = await sql.query(
      `SELECT effects_json, closure_fence FROM tf_resource_deletion_attestations
       WHERE tenant_id = ? AND resource_uid = ?`,
      [TENANT, UID],
    );
    expect(after[0]?.closure_fence).toBe(5);
    expect(JSON.parse(String(after[0]?.effects_json))).toHaveLength(4);
    await rotateLease(sql, now);
    const recoveryStore = createTakoformDeleteSubeffectStore(sql, () => now + 2);
    const recovery = ticket("actor-tombstone", "recovery", "lease-recovery");
    expect(await recoveryStore.readExact(recovery)).toBe("issued");
    expect(await recoveryStore.issue(recovery)).toBe("already-issued");
    expect(await rows(sql)).toHaveLength(2);
    expect(await recoveryStore.concludeExact(recovery)).toBe("recorded");
    expect(await sql.query("SELECT token FROM tf_operation_commit_guards")).toEqual([]);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement.length > 0) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
