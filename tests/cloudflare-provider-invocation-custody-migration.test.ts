import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectApplyQualifiedMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
} from "../scripts/deploy/schema.ts";
import { MIGRATIONS } from "../src/db-schema.ts";

const MIGRATION_NAME = "0068_cloudflare_provider_invocation_custody.sql";

function custodyMigrationSql(): string {
  const migration = MIGRATIONS.find(({ name }) => name === MIGRATION_NAME);
  if (!migration) throw new Error(`migration ${MIGRATION_NAME} is missing`);
  return migration.sql;
}

function applyBeforeCustody(database: Database): void {
  for (const migration of MIGRATIONS) {
    if (migration.name === MIGRATION_NAME) return;
    database.exec(migration.sql);
  }
  throw new Error(`migration ${MIGRATION_NAME} is missing`);
}

function insertInvocation(
  database: Database,
  input: {
    readonly invocationId: string;
    readonly epochId?: string;
    readonly createdAtMs?: number;
    readonly phase?: "admitted" | "effect_started" | "terminal";
    readonly terminalProof?: string | null;
  },
): void {
  database
    .query(
      `INSERT INTO tf_cloudflare_provider_invocations (
        invocation_id, epoch_id, provider_id, installation_id, method, operation_id,
        tenant_id, resource_uid, host_fingerprint, execution_lease_token,
        logical_intent_digest, created_at_ms, phase, effect_started_at_ms,
        terminal_at_ms, terminal_proof
      ) VALUES (?, ?, 'provider-one', 'installation-one',
        'applyWithExecutionContextV1', ?, 'tenant-one', ?, ?, 'lease-one', ?,
        ?, ?, NULL, NULL, ?)`,
    )
    .run(
      input.invocationId,
      input.epochId ?? "epoch-one",
      `operation-${input.invocationId}`,
      `resource-${input.invocationId}`,
      `sha256:${"a".repeat(64)}`,
      `sha256:${"b".repeat(64)}`,
      input.createdAtMs ?? 100,
      input.phase ?? "admitted",
      input.terminalProof ?? null,
    );
}

function createVersionReceipt(database: Database, suffix: string): void {
  database
    .query(
      `INSERT INTO cloudflare_managed_worker_receipts (
        provider_id, resource_uid, native_id, kind, logical_worker_id,
        operation_id, generation, descriptor_digest, state
      ) VALUES ('provider-one', ?, ?, 'version', ?, ?, 1, ?, 'committed')`,
    )
    .run(
      `resource-${suffix}`,
      `native-${suffix}`,
      `logical-${suffix}`,
      `operation-${suffix}`,
      `sha256:${"c".repeat(64)}`,
    );
}

test("0068 is the exact source-only successor while the qualified 0001-0066 ceiling remains fixed", () => {
  const source = readCurrentAuditedMigrationSourceArtifact();
  expect(source.names).toHaveLength(78);
  expect(source.names.at(-11)).toBe(MIGRATION_NAME);
  expect(source.names.at(-10)).toBe("0069_cloudflare_provider_invocation_delete_ack.sql");
  expect(source.names.at(-9)).toBe("0070_takoform_v2.sql");
  expect(source.names.at(-8)).toBe("0071_v2_sqlite_migration_set_custody.sql");
  expect(source.names.at(-7)).toBe("0072_v2_artifact_custody.sql");
  expect(source.names.at(-6)).toBe("0073_v2_reference_acceptance.sql");
  expect(source.names.at(-5)).toBe("0074_v2_worker_native_effects.sql");
  expect(source.names.at(-4)).toBe("0075_v2_artifact_progress.sql");
  expect(source.names.at(-3)).toBe("0076_v2_worker_invocation_custody.sql");
  expect(source.names.at(-2)).toBe("0077_v2_operation_acceptance_order.sql");
  expect(source.names.at(-1)).toBe("0078_v2_worker_invocation_retirement.sql");
  const qualified = projectApplyQualifiedMigrationArtifact(source);
  expect(qualified.names).toHaveLength(66);
  expect(qualified.names.at(-1)).toBe("0066_cloudflare_managed_actor_kv_capability_claims.sql");

  const root = mkdtempSync(join(tmpdir(), "takoserver-invocation-custody-tail-"));
  try {
    const migrations = join(root, "migrations");
    mkdirSync(migrations);
    for (const file of source.files) copyFileSync(file.path, join(migrations, file.name));
    const tail = source.files.at(-1);
    if (!tail) throw new Error("audited source is missing its terminal migration");
    copyFileSync(tail.path, join(migrations, "0079_unreviewed.sql"));
    expect(() => readCurrentAuditedMigrationSourceArtifact(migrations)).toThrow(
      "audited migration lineage must contain exactly 0001-0078",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0068 preserves existing rows and starts with a closed admission epoch", () => {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  try {
    applyBeforeCustody(database);
    database
      .query(
        `INSERT INTO tf_resources (
          tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, updated_at
        ) VALUES ('tenant-existing', 'default', 'example.test/v1', 'Example',
          'preserved', 'uid-preserved', '1', '1', '{}', 10)`,
      )
      .run();

    expect(MIGRATIONS.some(({ name }) => name === MIGRATION_NAME)).toBe(true);
    database.exec(custodyMigrationSql());

    expect(
      database.query("SELECT tenant_id, uid FROM tf_resources WHERE uid = 'uid-preserved'").get(),
    ).toEqual({ tenant_id: "tenant-existing", uid: "uid-preserved" });
    expect(database.query("SELECT * FROM tf_cloudflare_provider_invocation_epoch").all()).toEqual([
      {
        singleton: 1,
        epoch_id: null,
        state: "closed",
        opened_at_ms: null,
        closed_at_ms: null,
      },
    ]);
    expect(() => insertInvocation(database, { invocationId: "closed-epoch" })).toThrow();
    expect(
      database.query("PRAGMA foreign_key_list(tf_cloudflare_provider_invocations)").all(),
    ).toEqual([]);
  } finally {
    database.close();
  }
});

test("0068 fences admission, preserves invocation identity, and only accepts receipt-backed terminal proof", () => {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  try {
    applyBeforeCustody(database);
    database.exec(custodyMigrationSql());
    database
      .query(
        `UPDATE tf_cloudflare_provider_invocation_epoch
         SET epoch_id = 'epoch-one', state = 'open', opened_at_ms = 100
         WHERE singleton = 1`,
      )
      .run();

    insertInvocation(database, { invocationId: "worker-version" });
    expect(() =>
      database.exec(
        `UPDATE tf_cloudflare_provider_invocations
         SET operation_id = 'rewritten-operation' WHERE invocation_id = 'worker-version'`,
      ),
    ).toThrow();
    expect(() =>
      database.exec(
        "DELETE FROM tf_cloudflare_provider_invocations WHERE invocation_id = 'worker-version'",
      ),
    ).toThrow();

    expect(() =>
      database.exec(
        `UPDATE tf_cloudflare_provider_invocations SET phase = 'terminal',
           terminal_at_ms = 120, terminal_proof = 'version_receipt_committed'
         WHERE invocation_id = 'worker-version'`,
      ),
    ).toThrow();

    database
      .query(
        `UPDATE tf_cloudflare_provider_invocations
         SET phase = 'effect_started', effect_started_at_ms = 110
         WHERE invocation_id = 'worker-version'`,
      )
      .run();
    expect(() =>
      database.exec(
        `UPDATE tf_cloudflare_provider_invocations SET phase = 'terminal',
           terminal_at_ms = 120, terminal_proof = 'version_receipt_committed'
         WHERE invocation_id = 'worker-version'`,
      ),
    ).toThrow();

    createVersionReceipt(database, "worker-version");
    database
      .query(
        `UPDATE tf_cloudflare_provider_invocations SET phase = 'terminal',
           terminal_at_ms = 120, terminal_proof = 'version_receipt_committed'
         WHERE invocation_id = 'worker-version'`,
      )
      .run();
    expect(
      database
        .query(
          `SELECT phase, terminal_proof FROM tf_cloudflare_provider_invocations
           WHERE invocation_id = 'worker-version'`,
        )
        .get(),
    ).toEqual({ phase: "terminal", terminal_proof: "version_receipt_committed" });
    expect(() =>
      database.exec(
        `UPDATE tf_cloudflare_provider_invocations
         SET phase = 'effect_started', effect_started_at_ms = 130
         WHERE invocation_id = 'worker-version'`,
      ),
    ).toThrow();

    insertInvocation(database, { invocationId: "pre-effect-refusal" });
    database
      .query(
        `UPDATE tf_cloudflare_provider_invocations SET phase = 'terminal',
           terminal_at_ms = 120, terminal_proof = 'pre_effect_refusal'
         WHERE invocation_id = 'pre-effect-refusal'`,
      )
      .run();
    expect(
      database
        .query(
          `SELECT effect_started_at_ms, terminal_proof FROM tf_cloudflare_provider_invocations
           WHERE invocation_id = 'pre-effect-refusal'`,
        )
        .get(),
    ).toEqual({ effect_started_at_ms: null, terminal_proof: "pre_effect_refusal" });

    database
      .query(
        `UPDATE tf_cloudflare_provider_invocation_epoch
         SET state = 'closed', closed_at_ms = 130 WHERE singleton = 1`,
      )
      .run();
    expect(() => insertInvocation(database, { invocationId: "closed-after-use" })).toThrow();
    expect(
      database
        .query(
          "SELECT invocation_id FROM tf_cloudflare_provider_invocations WHERE invocation_id = 'worker-version'",
        )
        .get(),
    ).toEqual({ invocation_id: "worker-version" });
    database
      .query(
        `UPDATE tf_cloudflare_provider_invocation_epoch
         SET epoch_id = 'epoch-two', state = 'open', opened_at_ms = 200, closed_at_ms = NULL
         WHERE singleton = 1`,
      )
      .run();
    insertInvocation(database, {
      invocationId: "next-epoch",
      epochId: "epoch-two",
      createdAtMs: 210,
    });

    const before = database
      .query(
        "SELECT invocation_id, phase FROM tf_cloudflare_provider_invocations ORDER BY invocation_id",
      )
      .all();
    expect(() =>
      database.transaction(() => {
        insertInvocation(database, {
          invocationId: "rolled-back",
          epochId: "epoch-two",
          createdAtMs: 220,
        });
        throw new Error("abort admission transaction");
      })(),
    ).toThrow("abort admission transaction");
    expect(
      database
        .query(
          "SELECT invocation_id, phase FROM tf_cloudflare_provider_invocations ORDER BY invocation_id",
        )
        .all(),
    ).toEqual(before);
  } finally {
    database.close();
  }
});
