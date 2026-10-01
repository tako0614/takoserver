import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runD1Schema } from "../scripts/deploy/schema.ts";
import {
  assertProtected0058Preserved,
  readProtected0058Snapshot,
} from "../scripts/deploy/schema-0058-proof.ts";
import { build0058SyntheticFixtureSql } from "../scripts/deploy/schema-0058-rehearsal.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE cloudflare_managed_worker_receipts
      (provider_id TEXT, resource_uid TEXT, state TEXT, PRIMARY KEY(provider_id, resource_uid));
    CREATE TABLE cloudflare_managed_worker_version_execution_material
      (provider_id TEXT, resource_uid TEXT, descriptor_json TEXT, PRIMARY KEY(provider_id, resource_uid));
    CREATE TABLE cloudflare_managed_worker_version_execution_secrets
      (provider_id TEXT, resource_uid TEXT, name TEXT, nonce BLOB, ciphertext BLOB,
       PRIMARY KEY(provider_id, resource_uid, name));
    CREATE TABLE cloudflare_managed_worker_version_execution_provider_proofs
      (provider_id TEXT, resource_uid TEXT, name TEXT, nonce BLOB, ciphertext BLOB,
       PRIMARY KEY(provider_id, resource_uid, name));
  `);
  const reader = {
    async query(_phase: string, _description: string, sql: string) {
      return db.query(sql).all() as Record<string, unknown>[];
    },
  };
  return { db, reader };
}

describe("protected 0058 bounded integrity", () => {
  test("status inspects a real 0057 predecessor but apply refuses missing owner proofs", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-protected-0058-"));
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(
        "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL)",
      );
      for (const migration of MIGRATIONS.slice(0, 57)) {
        db.exec(migration.sql);
        db.query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'now')").run(
          migration.name,
        );
      }
      db.exec(build0058SyntheticFixtureSql());
      const run = async (command: readonly string[]) => {
        const index = command.indexOf("--command");
        if (index < 0) throw new Error("unexpected mutating command");
        const rows = db.query(command[index + 1] as string).all();
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ success: true, results: rows }]),
          stderr: "",
        };
      };
      const target = {
        kind: "takoserver.deploy-target@v2",
        environment: "integration",
        accountId: "a".repeat(32),
        workerName: "takoserver-api-integration",
        d1: {
          databaseName: "takoserver-runtime-integration",
          databaseId: "00000000-0000-4000-8000-000000000058",
        },
        r2: { bucketName: "takoserver-objects-integration" },
        publicOrigin: "https://integration.example.test",
        signing: { currentKeyId: "key-current" },
      } as DeployTarget;
      const common = {
        run,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
        leaseRoot: join(root, "leases"),
      };
      const status = await runD1Schema(
        {
          action: "status",
          environment: "integration",
          commit: "a".repeat(40),
          throughMigration: "0058",
        },
        target,
        common,
      );
      expect(status.readyForApply).toBe(false);
      expect(status.protected0058).toMatchObject({
        affectedData: { counts: { cloudflare_managed_worker_receipts: 4 }, maxBlobBytes: 19 },
        writerDrain: "public-Host-and-private-CPE-owner-proof-required",
      });
      let failure: unknown;
      try {
        await runD1Schema(
          {
            action: "apply",
            environment: "integration",
            commit: "a".repeat(40),
            throughMigration: "0058",
          },
          target,
          common,
        );
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("public Host and private CPE writer-drain");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves all rows including exact sealed BLOB bytes without exposing them", async () => {
    const { db, reader } = fixture();
    try {
      for (let index = 0; index < 11; index++) {
        db.query("INSERT INTO cloudflare_managed_worker_receipts VALUES (?, ?, ?)").run(
          "provider",
          `uid-${String(index).padStart(2, "0")}`,
          "pending",
        );
      }
      db.exec(
        "INSERT INTO cloudflare_managed_worker_version_execution_material VALUES ('provider', 'uid-00', '{}')",
      );
      db.exec(
        "INSERT INTO cloudflare_managed_worker_version_execution_secrets VALUES ('provider', 'uid-00', 'secret', X'001122', X'DEADBEEF')",
      );
      db.exec(
        "INSERT INTO cloudflare_managed_worker_version_execution_provider_proofs VALUES ('provider', 'uid-00', 'proof', X'334455', X'AABBCCDD')",
      );
      const before = await readProtected0058Snapshot(reader, "preflight");
      const unchanged = await readProtected0058Snapshot(reader, "verification");
      expect(() => assertProtected0058Preserved(before, unchanged)).not.toThrow();
      expect(JSON.stringify(before)).not.toContain("DEADBEEF");
      expect(before.counts.cloudflare_managed_worker_receipts).toBe(11);
      expect(before.maxBlobBytes).toBe(4);
      db.exec(
        "UPDATE cloudflare_managed_worker_version_execution_secrets SET ciphertext=X'DEADBE00'",
      );
      const changed = await readProtected0058Snapshot(reader, "verification");
      expect(() => assertProtected0058Preserved(before, changed)).toThrow("changed");
    } finally {
      db.close();
    }
  });

  test("detects changes between distinct valid SQLite integers beyond JSON number precision", async () => {
    const { db, reader: sqliteReader } = fixture();
    const reader = {
      async query(phase: string, description: string, sql: string) {
        const rows = await sqliteReader.query(phase, description, sql);
        return JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
      },
    };
    try {
      db.exec(
        "ALTER TABLE cloudflare_managed_worker_receipts ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)",
      );
      db.exec("ALTER TABLE cloudflare_managed_worker_receipts ADD COLUMN optional_text TEXT");
      db.exec(
        "INSERT INTO cloudflare_managed_worker_receipts (provider_id, resource_uid, state, generation, optional_text) VALUES ('provider', 'uid-unsafe-int', 'pending', 9007199254740992, NULL)",
      );
      const before = await readProtected0058Snapshot(reader, "preflight");
      const unchanged = await readProtected0058Snapshot(reader, "verification");
      const storedBefore = db
        .query(
          "SELECT CAST(generation AS TEXT) AS generation FROM cloudflare_managed_worker_receipts WHERE resource_uid = 'uid-unsafe-int'",
        )
        .get() as { generation: string };

      db.exec(
        "UPDATE cloudflare_managed_worker_receipts SET generation = 9007199254740993 WHERE resource_uid = 'uid-unsafe-int'",
      );
      const storedAfter = db
        .query(
          "SELECT CAST(generation AS TEXT) AS generation FROM cloudflare_managed_worker_receipts WHERE resource_uid = 'uid-unsafe-int'",
        )
        .get() as { generation: string };
      const after = await readProtected0058Snapshot(reader, "verification");

      expect(storedBefore.generation).toBe("9007199254740992");
      expect(storedAfter.generation).toBe("9007199254740993");
      expect(() => assertProtected0058Preserved(before, unchanged)).not.toThrow();
      expect(() => assertProtected0058Preserved(before, after)).toThrow("changed");
    } finally {
      db.close();
    }
  });

  test("turns raw remote failures into value-free diagnostics", async () => {
    const reader = {
      async query() {
        throw new Error("DEADBEEFPRIVATEBLOB");
      },
    };
    let failure: unknown;
    try {
      await readProtected0058Snapshot(reader, "preflight");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).not.toContain("DEADBEEFPRIVATEBLOB");
  });
});
