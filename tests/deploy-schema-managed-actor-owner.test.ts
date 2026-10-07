import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { runD1Schema, type SchemaProcess } from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-actor-owner-schema-"));
const migrations = copyCurrentSchemaFixture(join(root, "migrations"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const COMMIT = "a".repeat(40);
const ACTOR_CLAIM = "0064_cloudflare_managed_actor_owner_claims.sql";
const QUEUE_RETIREMENT = "0063_cloudflare_managed_queue_retirement.sql";
const DIGEST = "a".repeat(64);
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000064",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "current" },
} satisfies DeployTarget;

// Match Wrangler's statement-at-a-time migration transaction, including triggers.
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
  for (const { name } of MIGRATIONS.slice(0, 63)) {
    db.exec(readFileSync(join(migrations, name), "utf8"));
    db.query("INSERT INTO d1_migrations(name,applied_at) VALUES (?, 'fixture')").run(name);
  }
  // A protected predecessor has durable rows, not just migration metadata.
  db.exec(`INSERT INTO cloudflare_managed_worker_receipts
    (provider_id, resource_uid, native_id, kind, logical_worker_id, operation_id,
     generation, descriptor_digest, state)
    VALUES ('provider-a', 'worker-a', 'worker:worker-a', 'worker', 'worker-a',
      'create-worker-a', 1, 'sha256:${DIGEST}', 'pending'),
      ('provider-a', 'worker-b', 'worker:worker-b', 'worker', 'worker-b',
      'create-worker-b', 2, 'sha256:${DIGEST}', 'committed')`);
  const workerReceipts = db
    .query("SELECT * FROM cloudflare_managed_worker_receipts ORDER BY resource_uid")
    .all();
  const workerSchema = db
    .query("SELECT sql FROM sqlite_schema WHERE name = 'cloudflare_managed_worker_receipts'")
    .get();
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
      if (sql.includes("FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")) {
        shapeReads++;
        if (shapeReads === options.driftAtShapeRead) {
          db.exec("CREATE TABLE rogue_immediate_fence(value TEXT)");
        }
      }
      return ok(JSON.stringify([{ success: true, results: db.query(sql).all() }]));
    }
    if (key === "git rev-parse HEAD") return ok(COMMIT);
    if (key === "git branch --show-current") return ok("candidate/actor-owner-schema");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (
      key === "bun run check:migrations" ||
      key === "bun test tests/deploy-schema-managed-actor-owner.test.ts"
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
    workerReceipts,
    workerSchema,
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

describe("0063 to 0064 durable Actor owner claim transition", () => {
  test("selects only the audited 0064 suffix from exact nonempty 0063", async () => {
    const f = fixture();
    try {
      expect(await f.invoke("status")).toMatchObject({
        fromMigration: QUEUE_RETIREMENT,
        throughMigration: ACTOR_CLAIM,
        pendingMigrations: [ACTOR_CLAIM],
        managedActorOwnerCutover: { status: "ready" },
        readyForApply: true,
      });
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("refuses a malformed 0063 predecessor before source qualification or mutation", async () => {
    const f = fixture({ malformedPredecessor: true });
    try {
      expect(await f.invoke("status")).toMatchObject({
        managedActorOwnerCutover: { status: "predecessor_schema_mismatch" },
        readyForApply: false,
      });
      await expect(f.invoke("apply")).rejects.toThrow("predecessor_schema_mismatch");
      expect(f.applies()).toBe(0);
      expect(f.commands().some((command) => command.startsWith("git "))).toBe(false);
    } finally {
      f.db.close();
    }
  });

  test("rechecks the exact 0063 predecessor at the immediate mutation fence", async () => {
    const f = fixture({ driftAtShapeRead: 4 });
    try {
      await expect(f.invoke("apply")).rejects.toThrow(
        "immediate 0064 Actor owner claim migration fence",
      );
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("refuses predecessor drift after source qualification", async () => {
    const f = fixture({ driftAtShapeRead: 2 });
    try {
      await expect(f.invoke("apply")).rejects.toThrow(
        "D1 lineage or schema shape changed during qualification",
      );
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("preserves old Worker data/schema and requires exact all-0064 post-shape", async () => {
    const f = fixture();
    try {
      expect(await f.invoke("apply")).toMatchObject({
        pendingMigrations: [ACTOR_CLAIM],
        appliedMigrations: MIGRATIONS.slice(0, 64).map(({ name }) => name),
        managedActorOwnerCutover: { status: "ready" },
        providerAcknowledgement: "acknowledged",
      });
      expect(f.applies()).toBe(1);
      expect(
        f.db.query("SELECT * FROM cloudflare_managed_worker_receipts ORDER BY resource_uid").all(),
      ).toEqual(f.workerReceipts);
      expect(
        f.db
          .query("SELECT sql FROM sqlite_schema WHERE name = 'cloudflare_managed_worker_receipts'")
          .get(),
      ).toEqual(f.workerSchema);
      expect(
        f.db
          .query(
            "SELECT name FROM sqlite_schema WHERE name = 'cloudflare_managed_actor_owner_claims'",
          )
          .get(),
      ).not.toBeNull();
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
      expect(String(failure)).toContain("Actor owner claim cutover post-shape differs");
      expect(drifted.applies()).toBe(1);
    } finally {
      drifted.db.close();
    }
  });

  test("settles lost acknowledgement from authoritative lineage without replay", async () => {
    const f = fixture({ lostAck: true });
    try {
      expect(await f.invoke("apply")).toMatchObject({
        appliedMigrations: MIGRATIONS.slice(0, 64).map(({ name }) => name),
        providerAcknowledgement: "provider-error-recovered-by-authoritative-readback",
      });
      expect(f.applies()).toBe(1);
      expect(await f.invoke("status")).toMatchObject({
        fromMigration: ACTOR_CLAIM,
        throughMigration: "0065_worker_runtime_input_lease_generation.sql",
        pendingMigrations: ["0065_worker_runtime_input_lease_generation.sql"],
      });
      expect(f.applies()).toBe(1);
    } finally {
      f.db.close();
    }
  });

  test("rejects any unreviewed post-0075 source tail before provider I/O", async () => {
    const unreviewed = join(root, "unreviewed-migrations");
    cpSync(migrations, unreviewed, { recursive: true });
    writeFileSync(
      join(unreviewed, "0077_unreviewed_extension.sql"),
      "CREATE TABLE unreviewed_extension(value TEXT);\n",
    );
    const f = fixture({ migrationDirectory: unreviewed });
    try {
      await expect(f.invoke("status")).rejects.toThrow("exact audited source inventory 0001-0076");
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });
});
