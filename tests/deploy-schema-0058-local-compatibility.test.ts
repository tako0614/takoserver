import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { build0058SyntheticFixtureSql } from "../scripts/deploy/schema-0058-rehearsal.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "takoserver-0058-local-compat-"));
const migrationDirectory = copyCurrentSchemaFixture(join(root, "migrations"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Representative pre-0058 CPE SQL from private e28fc572 ManagedWorkerState.
// This pins a source template, NOT the identity or closure of a deployed writer.
const oldReceiptInsert = `INSERT INTO cloudflare_managed_worker_receipts (
  provider_id, resource_uid, native_id, kind, logical_worker_id,
  operation_id, generation, descriptor_digest, state, observed_json
) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?)
ON CONFLICT DO NOTHING`;

function oldReceiptParameters(
  suffix: string,
): [string, string, string, string, string, string, string, string] {
  return [
    "synthetic-0058-old-writer",
    `old-writer-${suffix}`,
    `native-${suffix}`,
    "worker",
    `logical-${suffix}`,
    `operation-${suffix}`,
    `sha256:${"a".repeat(64)}`,
    "{}",
  ];
}

function open0057Pair(name: string): { migrator: Database; oldWriter: Database } {
  const path = join(root, `${name}.sqlite`);
  const migrator = new Database(path, { create: true });
  const oldWriter = new Database(path);
  for (const db of [migrator, oldWriter]) db.exec("PRAGMA foreign_keys = ON");
  migrator.exec(`CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  for (const migration of MIGRATIONS.slice(0, 57)) {
    migrator.exec(migration.sql);
    migrator
      .query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'fixture')")
      .run(migration.name);
  }
  migrator.exec(build0058SyntheticFixtureSql());
  return { migrator, oldWriter };
}

function exact0058Import(): string {
  const migration = readMigrationArtifact(migrationDirectory).files[57];
  if (!migration || migration.name !== MIGRATIONS[57]?.name)
    throw new Error("audited immutable 0058 source is missing");
  return buildD1MigrationImport([migration], { freshLedger: false }).sql;
}

function durableRows(db: Database): unknown {
  return {
    receipts: db
      .query("SELECT * FROM cloudflare_managed_worker_receipts ORDER BY provider_id, resource_uid")
      .all(),
    material: db
      .query(
        "SELECT * FROM cloudflare_managed_worker_version_execution_material ORDER BY provider_id, resource_uid",
      )
      .all(),
    secrets: db
      .query(
        "SELECT provider_id, resource_uid, name, hex(nonce) AS nonce, hex(ciphertext) AS ciphertext FROM cloudflare_managed_worker_version_execution_secrets ORDER BY provider_id, resource_uid, name",
      )
      .all(),
    proofs: db
      .query(
        "SELECT provider_id, resource_uid, name, hex(nonce) AS nonce, hex(ciphertext) AS ciphertext FROM cloudflare_managed_worker_version_execution_provider_proofs ORDER BY provider_id, resource_uid, name",
      )
      .all(),
  };
}

function lineage(db: Database): unknown {
  return db.query("SELECT name FROM d1_migrations ORDER BY id").all();
}

describe("0057 to immutable 0058 local old-writer compatibility", () => {
  test("a second connection's prepared named-column insert works before and after the rebuild", () => {
    const { migrator, oldWriter } = open0057Pair("prepared-across-rebuild");
    try {
      const preparedBefore = oldWriter.query(oldReceiptInsert);
      preparedBefore.run(...oldReceiptParameters("before"));
      const before = durableRows(oldWriter);
      expect((before as { secrets: unknown[] }).secrets).toHaveLength(3);
      expect((before as { proofs: unknown[] }).proofs).toHaveLength(3);
      expect(oldWriter.query("PRAGMA foreign_key_check").all()).toEqual([]);

      migrator.transaction(() => migrator.exec(exact0058Import()))();

      expect(durableRows(oldWriter)).toEqual(before);
      expect(lineage(oldWriter)).toHaveLength(58);
      // This was prepared before 0058; a fresh prepare alone would miss stale-statement behavior.
      preparedBefore.run(...oldReceiptParameters("after"));
      expect(
        oldWriter
          .query(
            "SELECT state FROM cloudflare_managed_worker_receipts WHERE resource_uid = 'old-writer-after'",
          )
          .get(),
      ).toEqual({ state: "pending" });
      oldWriter
        .query(
          "UPDATE cloudflare_managed_worker_receipts SET state = 'committed', observed_json = ? WHERE provider_id = ? AND resource_uid = ?",
        )
        .run("{}", "synthetic-0058-old-writer", "old-writer-after");
      expect(
        oldWriter
          .query(
            "SELECT state FROM cloudflare_managed_worker_receipts WHERE resource_uid = 'old-writer-after'",
          )
          .get(),
      ).toEqual({ state: "committed" });
      expect(oldWriter.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect((durableRows(oldWriter) as { secrets: unknown[] }).secrets).toEqual(
        (before as { secrets: unknown[] }).secrets,
      );
      expect((durableRows(oldWriter) as { proofs: unknown[] }).proofs).toEqual(
        (before as { proofs: unknown[] }).proofs,
      );
    } finally {
      oldWriter.close();
      migrator.close();
    }
  });

  test("a late failure after the whole 0058 SQL and ledger leaves both connections at exact 0057", () => {
    const { migrator, oldWriter } = open0057Pair("late-full-file-rollback");
    try {
      const preparedBefore = oldWriter.query(oldReceiptInsert);
      const beforeRows = durableRows(oldWriter);
      const beforeLineage = lineage(oldWriter);
      const beforeSchema = oldWriter
        .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
        .all();
      expect(() =>
        migrator.transaction(() => {
          migrator.exec(exact0058Import());
          throw new Error("synthetic late failure after SQL and ledger");
        })(),
      ).toThrow("synthetic late failure after SQL and ledger");

      expect(durableRows(oldWriter)).toEqual(beforeRows);
      expect(lineage(oldWriter)).toEqual(beforeLineage);
      expect(
        oldWriter
          .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
          .all(),
      ).toEqual(beforeSchema);
      expect(oldWriter.query("PRAGMA foreign_key_check").all()).toEqual([]);
      preparedBefore.run(...oldReceiptParameters("after-rollback"));
      expect(
        oldWriter
          .query(
            "SELECT state FROM cloudflare_managed_worker_receipts WHERE resource_uid = 'old-writer-after-rollback'",
          )
          .get(),
      ).toEqual({ state: "pending" });
    } finally {
      oldWriter.close();
      migrator.close();
    }
  });
});
