import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { runD1Schema, type SchemaProcess } from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-queue-retirement-schema-"));
const migrations = copyCurrentSchemaFixture(join(root, "migrations"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const COMMIT = "a".repeat(40);
const RETIREMENT = "0063_cloudflare_managed_queue_retirement.sql";
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000063",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "current" },
} satisfies DeployTarget;

// Match Wrangler's statement-at-a-time D1 migration transaction in the local fixture.
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
    readonly malformedPredecessor?: boolean;
    readonly driftAtShapeRead?: number;
    readonly afterApply?: (db: Database) => void;
    readonly lostAck?: boolean;
    readonly migrationDirectory?: string;
  } = {},
) {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const { name } of MIGRATIONS.slice(0, 62)) {
    db.exec(readFileSync(join(migrations, name), "utf8"));
    db.query("INSERT INTO d1_migrations(name,applied_at) VALUES (?, 'fixture')").run(name);
  }
  if (options.malformedPredecessor) db.exec("CREATE TABLE rogue_predecessor(value TEXT)");

  const directory = mkdtempSync(join(root, "case-"));
  const commands: string[] = [];
  let applies = 0;
  let shapeReads = 0;
  let invocations = 0;
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const run: SchemaProcess = async (command) => {
    const key = command.join(" ");
    commands.push(key);
    if (command.includes("--command")) {
      const sql = command[command.indexOf("--command") + 1] as string;
      if (sql.includes("FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")) {
        shapeReads++;
        if (shapeReads === options.driftAtShapeRead) {
          db.exec("CREATE TABLE rogue_immediate_fence(value TEXT)");
        }
      }
      return ok(JSON.stringify([{ success: true, results: db.query(sql).all() }]));
    }
    if (key === "git rev-parse HEAD") return ok(COMMIT);
    if (key === "git branch --show-current") return ok("candidate/queue-retirement-schema");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (
      key === "bun run check:migrations" ||
      key === "bun test tests/deploy-schema-managed-queue-retirement.test.ts"
    ) {
      return ok("green");
    }
    if (command.includes("migrations") && command.includes("apply")) {
      applies++;
      const configPath = command[command.indexOf("--config") + 1] as string;
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        d1_databases: { migrations_dir: string }[];
      };
      const migrationDirectory = resolve(
        dirname(configPath),
        config.d1_databases[0]?.migrations_dir as string,
      );
      const applied = db.query("SELECT name FROM d1_migrations ORDER BY id").all();
      try {
        for (const name of readdirSync(migrationDirectory).sort().slice(applied.length)) {
          db.transaction(() => {
            executeMigration(db, readFileSync(join(migrationDirectory, name), "utf8"));
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
    commands: () => commands,
    invoke: (action: "status" | "apply") => {
      invocations++;
      return runD1Schema({ action, environment: "integration", commit: COMMIT }, target, {
        run,
        migrationDirectory: options.migrationDirectory ?? migrations,
        outputDirectory: join(directory, `${action}-${invocations}`),
        leaseRoot: join(directory, "leases"),
        review: "reviewer@example.test",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
      });
    },
  };
}

describe("0062 to 0063 managed Queue retirement transition", () => {
  test("selects only the exact audited 0063 suffix from canonical 0062", async () => {
    const f = fixture();
    try {
      expect(await f.invoke("status")).toMatchObject({
        fromMigration: "0062_takoform_import_provider_selection.sql",
        throughMigration: RETIREMENT,
        pendingMigrations: [RETIREMENT],
        applyProviderSelectionCutover: { status: "not_pending" },
        managedQueueRetirementCutover: { status: "ready" },
        readyForApply: true,
      });
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("refuses a malformed predecessor before source qualification or mutation", async () => {
    const f = fixture({ malformedPredecessor: true });
    try {
      expect(await f.invoke("status")).toMatchObject({
        managedQueueRetirementCutover: { status: "predecessor_schema_mismatch" },
        readyForApply: false,
      });
      await expect(f.invoke("apply")).rejects.toThrow("predecessor_schema_mismatch");
      expect(f.applies()).toBe(0);
      expect(f.commands().some((command) => command.startsWith("git "))).toBe(false);
    } finally {
      f.db.close();
    }
  });

  test("re-reads and refuses predecessor drift at the immediate mutation fence", async () => {
    const f = fixture({ driftAtShapeRead: 4 });
    try {
      await expect(f.invoke("apply")).rejects.toThrow(
        "immediate 0063 managed Queue retirement migration fence",
      );
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("requires the exact canonical all-0063 post-shape", async () => {
    const f = fixture();
    try {
      expect(await f.invoke("apply")).toMatchObject({
        pendingMigrations: [RETIREMENT],
        appliedMigrations: MIGRATIONS.map(({ name }) => name),
        managedQueueRetirementCutover: { status: "ready" },
        providerAcknowledgement: "acknowledged",
      });
      expect(f.applies()).toBe(1);
    } finally {
      f.db.close();
    }

    const drifted = fixture({
      afterApply: (db) => db.exec("CREATE TABLE rogue_post_shape(value TEXT)"),
    });
    try {
      const failure = await drifted.invoke("apply").catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("verification");
      expect(String(failure)).toContain("managed Queue retirement cutover post-shape differs");
      expect(drifted.applies()).toBe(1);
    } finally {
      drifted.db.close();
    }
  });

  test("reconciles a lost acknowledgement and never replays completed 0063", async () => {
    const f = fixture({ lostAck: true });
    try {
      expect(await f.invoke("apply")).toMatchObject({
        appliedMigrations: MIGRATIONS.map(({ name }) => name),
        providerAcknowledgement: "provider-error-recovered-by-authoritative-readback",
      });
      expect(f.applies()).toBe(1);
      await expect(f.invoke("apply")).rejects.toThrow("already complete");
      expect(f.applies()).toBe(1);
    } finally {
      f.db.close();
    }
  });

  test("refuses an unreviewed 0064 tail instead of adopting it", async () => {
    const unreviewed = join(root, "unreviewed-migrations");
    cpSync(migrations, unreviewed, { recursive: true });
    writeFileSync(
      join(unreviewed, "0064_unreviewed_extension.sql"),
      "CREATE TABLE unreviewed_extension(value TEXT);\n",
    );
    const f = fixture({ migrationDirectory: unreviewed });
    try {
      await expect(f.invoke("status")).rejects.toThrow("exact audited source inventory 0001-0063");
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });
});
