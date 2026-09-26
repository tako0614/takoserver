import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { runD1Schema, type SchemaProcess } from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-import-cutover-"));
const migrations = copyCurrentSchemaFixture(join(root, "migrations"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const COMMIT = "a".repeat(40);
const IMPORT_SELECTION = "0062_takoform_import_provider_selection.sql";
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000062",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "current" },
} satisfies DeployTarget;

function oldImport(db: Database, phase: "planned" | "executed"): void {
  db.query(`INSERT INTO tf_provider_mutation_sagas_selection_v1 (
    operation_id, protocol_generation, operation_kind, replay_key, tenant_id,
    fingerprint, resource_uid, target_space, target_api_version, target_kind,
    target_name, phase, receipt_json, created_at, updated_at, expires_at
  ) VALUES ('op-import', 1, 'import', 'replay-import', 'tenant', 'fingerprint',
    'uid-import', 'main', 'example.forms.test', 'Thing', 'import', ?, ?, 1, 1, ?)`).run(
    phase,
    phase === "executed" ? "{}" : null,
    phase === "executed" ? null : 1000,
  );
}

// Match Wrangler's statement-by-statement transaction. Bun's multi-statement
// exec can continue after a trigger ABORT, which is not a D1 migration batch.
function executeMigration(db: Database, sql: string): void {
  let rest = sql.replace(/^\s*--.*$/gmu, "").trim();
  while (rest) {
    const end = /^CREATE\s+TRIGGER\b/iu.test(rest) ? /^END\s*;/imu.exec(rest) : /;/u.exec(rest);
    if (!end) throw new Error("incomplete migration statement");
    const boundary = end.index + end[0].length;
    db.exec(rest.slice(0, boundary));
    rest = rest.slice(boundary).trim();
  }
}

function fixture(
  options: {
    plannedCountHook?: (read: number, db: Database) => void;
    beforeApply?: (db: Database) => void;
    afterApply?: ((db: Database) => void) | undefined;
    lostAck?: boolean;
    malformedCount?: boolean;
    malformedPostCount?: boolean;
  } = {},
) {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const { name } of MIGRATIONS.slice(0, 61)) {
    db.exec(readFileSync(join(migrations, name), "utf8"));
    db.query("INSERT INTO d1_migrations(name,applied_at) VALUES (?, 'fixture')").run(name);
  }
  const directory = mkdtempSync(join(root, "case-"));
  let applies = 0;
  let counts = 0;
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const run: SchemaProcess = async (command) => {
    const key = command.join(" ");
    if (command.includes("--command")) {
      const sql = command[command.indexOf("--command") + 1] as string;
      if (
        sql.includes("COUNT(*)") &&
        sql.includes("FROM tf_provider_mutation_sagas_selection_v1")
      ) {
        counts++;
        options.plannedCountHook?.(counts, db);
        if (options.malformedCount || (options.malformedPostCount && applies > 0))
          return ok('[{"success":true,"results":[{"row_count":"bad"}]}]');
      }
      return ok(JSON.stringify([{ success: true, results: db.query(sql).all() }]));
    }
    if (key === "git rev-parse HEAD") return ok(COMMIT);
    if (key === "git branch --show-current") return ok("candidate/import-cutover");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (
      key === "bun run check:migrations" ||
      key.startsWith("bun test tests/deploy-schema-import-selection.test.ts")
    )
      return ok("green");
    if (command.includes("migrations") && command.includes("apply")) {
      applies++;
      options.beforeApply?.(db);
      const configPath = command[command.indexOf("--config") + 1] as string;
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        d1_databases: { migrations_dir: string }[];
      };
      const directory = resolve(
        dirname(configPath),
        config.d1_databases[0]?.migrations_dir as string,
      );
      const applied = db.query("SELECT name FROM d1_migrations ORDER BY id").all();
      try {
        for (const name of readdirSync(directory).sort().slice(applied.length)) {
          db.transaction(() => {
            executeMigration(db, readFileSync(join(directory, name), "utf8"));
            db.query("INSERT INTO d1_migrations(name,applied_at) VALUES (?, 'fixture')").run(name);
          })();
        }
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: String(error) };
      }
      options.afterApply?.(db);
      return options.lostAck
        ? { exitCode: 1, stdout: "", stderr: "lost acknowledgement" }
        : ok("applied");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return {
    db,
    applies: () => applies,
    counts: () => counts,
    invoke: (action: "status" | "apply") =>
      runD1Schema({ action, environment: "integration", commit: COMMIT }, target, {
        run,
        migrationDirectory: migrations,
        outputDirectory: join(directory, action),
        leaseRoot: join(directory, "leases"),
        review: "reviewer@example.test",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
      }),
  };
}

describe("0061 to 0062 existing-data import-selection transition", () => {
  for (const lostAck of [false, true]) {
    test(`preserves executed historical receipts without backfill (lost ACK=${lostAck})`, async () => {
      const f = fixture({ lostAck });
      try {
        oldImport(f.db, "executed");
        const result = await f.invoke("apply");
        expect(result).toMatchObject({
          pendingMigrations: [IMPORT_SELECTION],
          appliedMigrations: MIGRATIONS.slice(0, 62).map(({ name }) => name),
          applyProviderSelectionCutover: {
            status: "ready",
            plannedImportSagaCount: 0,
            orphanOpenProviderEffectCount: 0,
          },
        });
        expect(f.applies()).toBe(1);
        expect(f.counts()).toBeGreaterThanOrEqual(4);
        expect(
          f.db
            .query(
              "SELECT phase, receipt_json, import_selection_protocol, import_selection_json FROM tf_provider_mutation_sagas_selection_v1",
            )
            .get(),
        ).toEqual({
          phase: "executed",
          receipt_json: "{}",
          import_selection_protocol: null,
          import_selection_json: null,
        });
        f.db.exec(
          "DELETE FROM tf_provider_mutation_sagas_selection_v1 WHERE operation_id='op-import'",
        );
        expect(() => oldImport(f.db, "planned")).toThrow();
      } finally {
        f.db.close();
      }
    });
  }

  test("status exposes planned imports and apply refuses before upload", async () => {
    const f = fixture();
    try {
      oldImport(f.db, "planned");
      expect(await f.invoke("status")).toMatchObject({
        readyForApply: false,
        applyProviderSelectionCutover: {
          status: "planned_imports_require_settlement",
          plannedImportSagaCount: 1,
        },
      });
      await expect(f.invoke("apply")).rejects.toThrow("planned_imports_require_settlement");
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("rechecks planned imports at the immediate mutation fence", async () => {
    const f = fixture({
      plannedCountHook: (read, db) => {
        if (read === 4) oldImport(db, "planned");
      },
    });
    try {
      await expect(f.invoke("apply")).rejects.toThrow("planned_imports_require_settlement");
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("migration atomically refuses a racing old import after the final read", async () => {
    const f = fixture({ beforeApply: (db) => oldImport(db, "planned") });
    try {
      await expect(f.invoke("apply")).rejects.toThrow("D1 migration wave partially applied");
      expect(f.applies()).toBe(1);
      expect(f.db.query("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").get()).toEqual({
        name: "0061_takoform_accepted_authority_continuity.sql",
      });
      expect(
        f.db
          .query(
            "SELECT name FROM pragma_table_info('tf_provider_mutation_sagas_selection_v1') WHERE name LIKE 'import_selection_%'",
          )
          .all(),
      ).toEqual([]);
      expect(f.db.query("SELECT phase FROM tf_provider_mutation_sagas_selection_v1").get()).toEqual(
        { phase: "planned" },
      );
    } finally {
      f.db.close();
    }
  });

  test("malformed planned-count readback fails closed", async () => {
    const f = fixture({ malformedCount: true });
    try {
      await expect(f.invoke("apply")).rejects.toThrow();
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("post-migration shape drift requires forward repair", async () => {
    const f = fixture({
      afterApply: (db) =>
        db.exec("ALTER TABLE tf_provider_mutation_sagas_selection_v1 ADD COLUMN rogue TEXT"),
    });
    try {
      const failure = await f.invoke("apply").catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("verification");
      expect(String(failure)).toContain("import-selection cutover post-shape differs");
      expect(f.applies()).toBe(1);
    } finally {
      f.db.close();
    }
  });

  test("post-readback permits newly admitted protocol1 imports", async () => {
    const f = fixture({
      afterApply: (db) =>
        db.exec(`INSERT INTO tf_provider_mutation_sagas_selection_v1 (
      operation_id, protocol_generation, operation_kind, replay_key, tenant_id,
      fingerprint, resource_uid, target_space, target_api_version, target_kind,
      target_name, phase, created_at, updated_at, expires_at, import_selection_protocol
    ) VALUES ('op-new',1,'import','replay-new','tenant','fingerprint','uid-new',
      'main','example.forms.test','Thing','new','planned',1,1,1000,1)`),
    });
    try {
      expect(await f.invoke("apply")).toMatchObject({
        appliedMigrations: MIGRATIONS.slice(0, 62).map(({ name }) => name),
      });
      expect(f.applies()).toBe(1);
    } finally {
      f.db.close();
    }
  });

  for (const malformed of [false, true]) {
    test(`post-readback refuses historical planned or malformed evidence (malformed=${malformed})`, async () => {
      const f = fixture({
        malformedPostCount: malformed,
        afterApply: malformed
          ? undefined
          : (db) =>
              db.exec(`UPDATE tf_provider_mutation_sagas_selection_v1
          SET phase='planned', receipt_json=NULL, expires_at=1000 WHERE operation_id='op-import'`),
      });
      try {
        oldImport(f.db, "executed");
        const failure = await f.invoke("apply").catch((error) => error);
        expect(failure).toBeInstanceOf(DeployError);
        expect(failure.phase).toBe("verification");
        expect(f.applies()).toBe(1);
      } finally {
        f.db.close();
      }
    });
  }
});
