import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { runD1Schema, type SchemaProcess } from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-lease-gen-wave-"));
const migrations = copyCurrentSchemaFixture(join(root, "migrations"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const COMMIT = "a".repeat(40);
const PREDECESSOR = "0064_cloudflare_managed_actor_owner_claims.sql";
const LEASE_GENERATION = "0065_worker_runtime_input_lease_generation.sql";
const NONCE = "abcdefghABCDEFGH";
const DIGEST = `sha256:${"a".repeat(64)}`;
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000065",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "current" },
} satisfies DeployTarget;

// Emulate Wrangler's one-migration transaction, including its ledger insert.
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
  for (const { name } of MIGRATIONS.slice(0, 64)) {
    db.exec(readFileSync(join(migrations, name), "utf8"));
    db.query("INSERT INTO d1_migrations(name,applied_at) VALUES (?, 'fixture')").run(name);
  }
  const insert = db.query(`INSERT INTO worker_runtime_input_preparations
    (organization_id, operation_key, preparation_id, apply_commitment,
     canonical_public_origin, binding_names_json, sealed_payload, seal_nonce, seal_key_id,
     state, fence, host_operation_id, claimed_resource_uid, space, worker_name,
     worker_resource_uid, bundle_name, consumed_receipt_digest,
     expires_at, created_at, updated_at, consumed_at)
    VALUES ('org', ?, ?, ?, 'https://api.example.test', '["TOKEN"]', ?, ?, ?,
      ?, 1, ?, ?, ?, ?, ?, ?, ?, 200, 100, 100, ?)`);
  insert.run(
    "prepared-a",
    "rip.prepared",
    DIGEST,
    "sealed",
    NONCE,
    "key",
    "prepared",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  );
  insert.run(
    "claimed-a",
    "rip.claimed",
    DIGEST,
    "sealed",
    NONCE,
    "key",
    "claimed",
    "host-claimed",
    "worker-a",
    "space",
    "name",
    "worker-a",
    "bundle",
    null,
    null,
  );
  insert.run(
    "dispatched-a",
    "rip.dispatched",
    DIGEST,
    null,
    null,
    null,
    "dispatched",
    "host-dispatched",
    "worker-b",
    "space",
    "name",
    "worker-b",
    "bundle",
    null,
    null,
  );
  insert.run(
    "consumed-a",
    "rip.consumed",
    DIGEST,
    null,
    null,
    null,
    "consumed",
    "host-consumed",
    "worker-c",
    "space",
    "name",
    "worker-c",
    "bundle",
    DIGEST,
    150,
  );
  const before = db
    .query("SELECT * FROM worker_runtime_input_preparations ORDER BY operation_key")
    .all() as Record<string, unknown>[];
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
        if (shapeReads === options.driftAtShapeRead)
          db.exec("CREATE TABLE rogue_shape(value TEXT)");
      }
      return ok(JSON.stringify([{ success: true, results: db.query(sql).all() }]));
    }
    if (key === "git rev-parse HEAD") return ok(COMMIT);
    if (key === "git branch --show-current") return ok("candidate/lease-generation");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (
      key === "bun run check:migrations" ||
      key ===
        "bun test tests/deploy-schema-runtime-input-lease-generation.test.ts tests/runtime-input-preparations.test.ts"
    )
      return ok("green");
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
    before,
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

describe("0064 to 0065 runtime-input lease generation transition", () => {
  test("selects only the audited suffix from exact nonempty 0064", async () => {
    const f = fixture();
    try {
      expect(await f.invoke("status")).toMatchObject({
        fromMigration: PREDECESSOR,
        throughMigration: LEASE_GENERATION,
        pendingMigrations: [LEASE_GENERATION],
        runtimeInputLeaseGenerationCutover: { status: "ready" },
        readyForApply: true,
      });
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("refuses malformed predecessor before qualification and checks immediate mutation fence", async () => {
    const malformed = fixture({ malformedPredecessor: true });
    try {
      expect(await malformed.invoke("status")).toMatchObject({
        runtimeInputLeaseGenerationCutover: { status: "predecessor_schema_mismatch" },
        readyForApply: false,
      });
      await expect(malformed.invoke("apply")).rejects.toThrow("predecessor_schema_mismatch");
      expect(malformed.applies()).toBe(0);
      expect(malformed.commands().some((command) => command.startsWith("git "))).toBe(false);
    } finally {
      malformed.db.close();
    }
    const racing = fixture({ driftAtShapeRead: 4 });
    try {
      await expect(racing.invoke("apply")).rejects.toThrow(
        "immediate 0065 runtime-input lease generation migration fence",
      );
      expect(racing.applies()).toBe(0);
    } finally {
      racing.db.close();
    }
  });

  test("atomically backfills live nonce, keeps ambiguous history closed, and requires exact post-shape", async () => {
    const f = fixture();
    try {
      expect(await f.invoke("apply")).toMatchObject({
        appliedMigrations: MIGRATIONS.slice(0, 65).map(({ name }) => name),
        runtimeInputLeaseGenerationCutover: { status: "ready" },
        providerAcknowledgement: "acknowledged",
      });
      expect(f.applies()).toBe(1);
      const rows = f.db
        .query("SELECT * FROM worker_runtime_input_preparations ORDER BY operation_key")
        .all() as Record<string, unknown>[];
      expect(rows.map(({ lease_generation, ...old }) => old)).toEqual(f.before);
      expect(rows.map((row) => [row.operation_key, row.lease_generation])).toEqual([
        ["claimed-a", NONCE],
        ["consumed-a", null],
        ["dispatched-a", null],
        ["prepared-a", NONCE],
      ]);
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
      expect(String(failure)).toContain(
        "runtime-input lease generation cutover post-shape differs",
      );
    } finally {
      drifted.db.close();
    }
  });

  test("settles lost acknowledgement from authoritative lineage without replay", async () => {
    const f = fixture({ lostAck: true });
    try {
      expect(await f.invoke("apply")).toMatchObject({
        appliedMigrations: MIGRATIONS.slice(0, 65).map(({ name }) => name),
        providerAcknowledgement: "provider-error-recovered-by-authoritative-readback",
      });
      expect(f.applies()).toBe(1);
      expect(await f.invoke("status")).toMatchObject({
        fromMigration: LEASE_GENERATION,
        throughMigration: "0066_cloudflare_managed_actor_kv_capability_claims.sql",
        pendingMigrations: ["0066_cloudflare_managed_actor_kv_capability_claims.sql"],
        actorKvCapabilityCutover: { status: "ready" },
      });
      expect(f.applies()).toBe(1);
    } finally {
      f.db.close();
    }
  });

  test("refuses an unreviewed post-0075 source tail before provider I/O", async () => {
    const unreviewed = join(root, "unreviewed");
    cpSync(migrations, unreviewed, { recursive: true });
    writeFileSync(
      join(unreviewed, "0079_unreviewed_extension.sql"),
      "CREATE TABLE unreviewed(value TEXT);\n",
    );
    const f = fixture({ migrationDirectory: unreviewed });
    try {
      await expect(f.invoke("status")).rejects.toThrow("exact audited source inventory 0001-0078");
      expect(f.applies()).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("refuses changed audited 0065 bytes before source qualification", async () => {
    const changed = join(root, "changed-lease-generation");
    cpSync(migrations, changed, { recursive: true });
    writeFileSync(
      join(changed, LEASE_GENERATION),
      `${readFileSync(join(changed, LEASE_GENERATION), "utf8")}\n-- changed\n`,
    );
    const f = fixture({ migrationDirectory: changed });
    try {
      await expect(f.invoke("apply")).rejects.toThrow("exact audited migration SHA-256");
      expect(f.applies()).toBe(0);
      expect(f.commands().some((command) => command.startsWith("git "))).toBe(false);
    } finally {
      f.db.close();
    }
  });
});
