import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RemoteD1 } from "../scripts/deploy/d1.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import { type D1SchemaState, readD1SchemaState } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { runD1Schema, type SchemaProcess } from "../scripts/deploy/schema.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const migrationFixtureRoot = mkdtempSync(
  join(process.env.TMPDIR ?? "/tmp", "takoserver-operation-generation-"),
);
const currentMigrations = copyCurrentSchemaFixture(join(migrationFixtureRoot, "migrations"));
const fullCurrentMigrations = copyCurrentSchemaFixture(
  join(migrationFixtureRoot, "current-migrations"),
);
afterAll(() => rmSync(migrationFixtureRoot, { recursive: true, force: true }));

const COMMIT = "a".repeat(40);
const APPLY_PROVIDER_SELECTION = "0059_takoform_apply_provider_selection.sql";
const OPERATION_GENERATION = "0060_takoform_operation_generation.sql";
const integrationTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000060",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

type AttestationState = "live" | "pending" | "closed" | "cancelled" | "missing";

interface ProcessOptions {
  readonly failMigration?: string;
  readonly afterMigrationApply?: (database: Database) => void;
  readonly beforeCanonicalShapeRead?: (read: number, database: Database) => void;
  readonly malformedOrphanCountAt?: number;
}

interface DatabaseProcessFixture {
  readonly run: SchemaProcess;
  readonly calls: string[][];
  readonly migrationApplyCalls: () => number;
  readonly canonicalShapeReads: () => number;
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function createDatabaseThrough(count: number, attestation: AttestationState = "live"): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.slice(0, count)) {
    database.exec(readFileSync(join(currentMigrations, migration.name), "utf8"));
    database
      .query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'fixture')")
      .run(migration.name);
  }
  if (count >= 58) seedLegacyRows(database, attestation);
  return database;
}

function seedLegacyRows(database: Database, attestation: AttestationState): void {
  database
    .query(
      `INSERT INTO tf_deferred_operations (
         id, tenant_id, principal_id, operation, phase, request_path, request_query,
         request_headers_json, request_body_json, fingerprint, replay_key,
         target_space, target_api_version, target_kind, target_name, target_form_ref_json,
         accepted_uid, accepted_generation, accepted_revision, resource_uid,
         polls_remaining, lease_token, lease_until, terminal_json, committed_uid,
         created_at, updated_at, expires_at
       ) VALUES (
         'operation-legacy', 'tenant-legacy', 'principal-legacy', 'apply', 'committing',
         '/apis/forms/resources/example/Thing/legacy', '', '{}', '{}', 'fingerprint-legacy',
         'replay-legacy', 'main', 'example.forms.takoform.com/v1', 'Thing', 'legacy', '{}',
         NULL, NULL, NULL, 'resource-legacy', 0, NULL, NULL, NULL, NULL,
         '2026-09-20T00:00:00.000Z', 100, 1000
       )`,
    )
    .run();
  database
    .query(
      `INSERT INTO tf_provider_mutation_sagas (
         operation_id, replay_key, tenant_id, fingerprint, resource_uid,
         target_space, target_api_version, target_kind, target_name,
         accepted_uid, accepted_generation, accepted_revision, phase, receipt_json,
         created_at, updated_at, expires_at, authority_head_digest,
         execution_lease_token, execution_lease_until, execution_started_at,
         provider_handle, provider_outcome
       ) VALUES (
         'operation-legacy', 'replay-legacy', 'tenant-legacy', 'fingerprint-legacy',
         'resource-legacy', 'main', 'example.forms.takoform.com/v1', 'Thing', 'legacy',
         NULL, NULL, NULL, 'planned', NULL, 100, 100, 1000, NULL,
         NULL, NULL, NULL, NULL, 'planned'
       )`,
    )
    .run();
  database
    .query(
      `INSERT INTO tf_resource_provider_effects (
         tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
         operation_mode, provider_pack_ref, provider_installation_ref, native_id,
         target_json, created_at
       ) VALUES (
         'tenant-legacy', 'resource-legacy', 'event-legacy', 'effect-legacy',
         'apply', 'dispatched', 'recovery', 'provider-pack', 'provider-installation',
         'native-legacy', '{}', 100
       )`,
    )
    .run();
  if (attestation === "missing") return;
  database
    .query(
      `INSERT INTO tf_resource_deletion_attestations (
         tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
         state, closure_fence, effects_json, evidence_json, evidence_ref,
         evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at
       ) VALUES (
         'tenant-legacy', 'resource-legacy', 'main', 'example.forms.takoform.com/v1',
         'Thing', 'legacy',
         '{"apiVersion":"example.forms.takoform.com/v1","kind":"Thing","definitionVersion":"1.0.0","schemaDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
         ?, 1, '[]', NULL, NULL, NULL, NULL, NULL, 100, 100
       )`,
    )
    .run(attestation);
}

function legacySnapshot(database: Database): Record<string, unknown[]> {
  return {
    sagas: database
      .query(
        `SELECT operation_id, replay_key, tenant_id, fingerprint, resource_uid,
                target_space, target_api_version, target_kind, target_name,
                accepted_uid, accepted_generation, accepted_revision, phase, receipt_json,
                created_at, updated_at, expires_at, authority_head_digest,
                execution_lease_token, execution_lease_until, execution_started_at,
                provider_handle, provider_outcome
         FROM tf_provider_mutation_sagas`,
      )
      .all(),
    operations: database.query("SELECT * FROM tf_deferred_operations").all(),
    effects: database.query("SELECT * FROM tf_resource_provider_effects").all(),
    attestations: database.query("SELECT * FROM tf_resource_deletion_attestations").all(),
  };
}

function newGenerationCounts(database: Database): Record<string, number> {
  return {
    operations: Number(
      (
        database
          .query("SELECT COUNT(*) AS count FROM tf_deferred_operations_selection_v1")
          .get() as {
          count: number;
        }
      ).count,
    ),
    sagas: Number(
      (
        database
          .query("SELECT COUNT(*) AS count FROM tf_provider_mutation_sagas_selection_v1")
          .get() as {
          count: number;
        }
      ).count,
    ),
  };
}

function d1ReadProcess(database: Database): SchemaProcess {
  return async (command): Promise<CommandResult> => {
    const commandIndex = command.indexOf("--command");
    if (commandIndex < 0) throw new Error(`unexpected D1 read command: ${command.join(" ")}`);
    const sql = command[commandIndex + 1];
    if (!sql) throw new Error("D1 read omitted SQL");
    const results = database.query(sql).all() as Record<string, unknown>[];
    return ok(`${JSON.stringify([{ success: true, results }])}\n`);
  };
}

async function canonicalState(database: Database): Promise<D1SchemaState> {
  return await readD1SchemaState(
    new RemoteD1("/unused/wrangler.jsonc", {
      environment: {},
      run: d1ReadProcess(database),
    }),
  );
}

function databaseProcess(database: Database, options: ProcessOptions = {}): DatabaseProcessFixture {
  const calls: string[][] = [];
  let migrationApplyCalls = 0;
  let canonicalShapeReads = 0;
  let orphanCountReads = 0;
  const run: SchemaProcess = async (command): Promise<CommandResult> => {
    calls.push([...command]);
    const key = command.join(" ");
    if (command.includes("--command")) {
      const commandIndex = command.indexOf("--command");
      const sql = command[commandIndex + 1];
      if (!sql) throw new Error("D1 command omitted SQL");
      if (sql.includes("FROM sqlite_schema") && sql.includes("COALESCE(sql, '')")) {
        canonicalShapeReads += 1;
        options.beforeCanonicalShapeRead?.(canonicalShapeReads, database);
      }
      if (sql.includes("FROM tf_resource_provider_effects")) {
        orphanCountReads += 1;
        if (options.malformedOrphanCountAt === orphanCountReads) {
          return ok('[{"success":true,"results":[{"unexpected":0}]}]\n');
        }
      }
      try {
        const results = database.query(sql).all() as Record<string, unknown>[];
        return ok(`${JSON.stringify([{ success: true, results }])}\n`);
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: String(error) };
      }
    }
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("release/schema\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check:migrations") return ok("green\n");
    if (command.includes("migrations") && command.includes("apply")) {
      migrationApplyCalls += 1;
      const configPath = command[command.indexOf("--config") + 1];
      if (!configPath) throw new Error("migration apply omitted config");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        d1_databases: { migrations_dir: string }[];
      };
      const databaseConfig = config.d1_databases[0];
      if (!databaseConfig) throw new Error("migration apply omitted D1 config");
      const directory = resolve(dirname(configPath), databaseConfig.migrations_dir);
      const names = readdirSync(directory).sort();
      const applied = (
        database.query("SELECT name FROM d1_migrations ORDER BY id").all() as {
          name: string;
        }[]
      ).map(({ name }) => name);
      try {
        for (const name of names.slice(applied.length)) {
          const sql = readFileSync(join(directory, name), "utf8");
          database.transaction(() => {
            database.exec(sql);
            if (options.failMigration === name) {
              throw new Error(`injected migration failure at ${name}`);
            }
            database
              .query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'fixture')")
              .run(name);
          })();
        }
      } catch (error) {
        return { exitCode: 1, stdout: "", stderr: String(error) };
      }
      options.afterMigrationApply?.(database);
      return ok("applied migrations\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return {
    run,
    calls,
    migrationApplyCalls: () => migrationApplyCalls,
    canonicalShapeReads: () => canonicalShapeReads,
  };
}

function applyOptions(
  root: string,
  fixture: DatabaseProcessFixture,
  directory = currentMigrations,
) {
  return {
    run: fixture.run,
    migrationDirectory: directory,
    outputDirectory: join(root, "work"),
    leaseRoot: join(root, "leases"),
    review: "reviewer@example.test",
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
  };
}

describe("0060 operation-generation cutover", () => {
  test("retains legacy 0058/0059 rows, rolls back inside 0060, then resumes exactly", async () => {
    const database = createDatabaseThrough(58);
    const before = legacySnapshot(database);
    const failedRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-opgen-failed-"));
    const resumedRoot = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-opgen-resume-"));
    try {
      const failing = databaseProcess(database, { failMigration: OPERATION_GENERATION });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        integrationTarget,
        applyOptions(failedRoot, failing),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(String(failure)).toContain("D1 migration wave partially applied");
      expect(failing.migrationApplyCalls()).toBe(1);
      expect((await canonicalState(database)).applied.at(-1)).toBe(APPLY_PROVIDER_SELECTION);
      expect(legacySnapshot(database)).toEqual(before);
      const tablesAfterRollback = database
        .query(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%selection_v1' ORDER BY name",
        )
        .all();
      expect(tablesAfterRollback).toEqual([]);

      const resumed = databaseProcess(database);
      const result = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        integrationTarget,
        applyOptions(resumedRoot, resumed),
      );
      expect(result).toMatchObject({
        pendingMigrations: [OPERATION_GENERATION],
        appliedMigrations: MIGRATIONS.slice(0, 60).map(({ name }) => name),
      });
      expect(resumed.migrationApplyCalls()).toBe(1);
      expect(legacySnapshot(database)).toEqual(before);
      expect(newGenerationCounts(database)).toEqual({ operations: 0, sagas: 0 });
      expect(database.query("SELECT selection_json FROM tf_provider_mutation_sagas").get()).toEqual(
        { selection_json: null },
      );
    } finally {
      database.close();
      rmSync(failedRoot, { recursive: true, force: true });
      rmSync(resumedRoot, { recursive: true, force: true });
    }
  });

  for (const attestation of ["missing", "closed", "cancelled"] as const) {
    test(`treats ${attestation} attestation state as an orphan through the real D1 query`, async () => {
      const database = createDatabaseThrough(59, attestation);
      const root = mkdtempSync(
        join(process.env.TMPDIR ?? "/tmp", `takoserver-opgen-${attestation}-`),
      );
      try {
        const fixture = databaseProcess(database);
        const status = await runD1Schema(
          { action: "status", environment: "integration", commit: COMMIT },
          integrationTarget,
          applyOptions(root, fixture),
        );
        expect(status).toMatchObject({
          applyProviderSelectionCutover: {
            status: "orphan_open_effects_repair_required",
            orphanOpenProviderEffectCount: 1,
          },
          readyForApply: false,
        });
        expect(
          fixture.calls.some((call) => call.join(" ").includes("tf_resource_provider_effects")),
        ).toBe(true);
      } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("blocks an orphan that appears at the final mutation fence", async () => {
    const database = createDatabaseThrough(59);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-opgen-final-fence-"));
    try {
      const fixture = databaseProcess(database, {
        beforeCanonicalShapeRead(read, current) {
          if (read === 3) {
            current.query("UPDATE tf_resource_deletion_attestations SET state = 'closed'").run();
          }
        },
      });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        integrationTarget,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(String(failure)).toContain("orphan_open_effects_repair_required");
      expect(fixture.migrationApplyCalls()).toBe(0);
      expect((await canonicalState(database)).applied.at(-1)).toBe(APPLY_PROVIDER_SELECTION);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses changed audited bytes, a rogue lineage prefix, and a rogue predecessor shape", async () => {
    const cases = [
      {
        label: "changed predecessor bytes",
        mutate(directory: string, database: Database) {
          writeFileSync(
            join(directory, APPLY_PROVIDER_SELECTION),
            `${readFileSync(join(directory, APPLY_PROVIDER_SELECTION), "utf8")}\n-- drift\n`,
          );
          void database;
        },
        message: "exact audited migration SHA-256",
      },
      {
        label: "rogue lineage prefix",
        mutate(directory: string, database: Database) {
          const source = join(directory, APPLY_PROVIDER_SELECTION);
          const body = readFileSync(source, "utf8");
          rmSync(source);
          writeFileSync(join(directory, "0059_rogue.sql"), body);
          database
            .query("UPDATE d1_migrations SET name = '0059_rogue.sql' WHERE name = ?")
            .run(APPLY_PROVIDER_SELECTION);
        },
        message: "exact audited source inventory 0001-0063",
      },
      {
        label: "rogue predecessor shape",
        mutate(directory: string, database: Database) {
          database.exec("ALTER TABLE tf_provider_mutation_sagas ADD COLUMN rogue_shape TEXT");
          void directory;
        },
        message: "predecessor_schema_mismatch",
      },
    ] as const;
    for (const entry of cases) {
      const database = createDatabaseThrough(59);
      const root = mkdtempSync(
        join(process.env.TMPDIR ?? "/tmp", `takoserver-opgen-${entry.label}-`),
      );
      const directory = join(root, "migrations");
      try {
        cpSync(currentMigrations, directory, { recursive: true });
        entry.mutate(directory, database);
        const fixture = databaseProcess(database);
        const failure = await runD1Schema(
          { action: "apply", environment: "integration", commit: COMMIT },
          integrationTarget,
          applyOptions(root, fixture, directory),
        ).catch((error) => error);
        expect(failure).toBeInstanceOf(DeployError);
        expect(String(failure)).toContain(entry.message);
        expect(fixture.calls.some((call) => call.includes("check:migrations"))).toBe(false);
        expect(fixture.migrationApplyCalls()).toBe(0);
      } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("refuses a post-0060 application shape that differs from the audited schema", async () => {
    const database = createDatabaseThrough(59);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-opgen-post-shape-"));
    try {
      const fixture = databaseProcess(database, {
        afterMigrationApply(current) {
          current.exec(
            "ALTER TABLE tf_deferred_operations_selection_v1 ADD COLUMN rogue_shape TEXT",
          );
        },
      });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        integrationTarget,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(String(failure)).toContain("operation-generation cutover post-shape differs");
      expect(fixture.migrationApplyCalls()).toBe(1);
      expect((await canonicalState(database)).applied.at(-1)).toBe(OPERATION_GENERATION);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies a malformed post-migration orphan count as verification failure", async () => {
    const database = createDatabaseThrough(59);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-opgen-count-"));
    try {
      const fixture = databaseProcess(database, { malformedOrphanCountAt: 5 });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        integrationTarget,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("verification");
      expect(String(failure)).toContain("operation-generation retained effect identity");
      expect(fixture.migrationApplyCalls()).toBe(1);
      expect((await canonicalState(database)).applied.at(-1)).toBe(OPERATION_GENERATION);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the no-op refusal and rehearsal/production fixed-wave selectors unchanged", async () => {
    const complete = createDatabaseThrough(63);
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "takoserver-opgen-noop-"));
    try {
      const fixture = databaseProcess(complete);
      const status = await runD1Schema(
        { action: "status", environment: "integration", commit: COMMIT },
        integrationTarget,
        applyOptions(root, fixture),
      );
      expect(status).toMatchObject({ pendingMigrations: [], readyForApply: false });
      const failure = await runD1Schema(
        { action: "apply", environment: "integration", commit: COMMIT },
        integrationTarget,
        applyOptions(root, fixture),
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(String(failure)).toContain("selected D1 migration wave is already complete");
      expect(fixture.migrationApplyCalls()).toBe(0);
    } finally {
      complete.close();
      rmSync(root, { recursive: true, force: true });
    }

    for (const environment of ["rehearsal", "production"] as const) {
      const db = createDatabaseThrough(56);
      const selectorRoot = mkdtempSync(
        join(process.env.TMPDIR ?? "/tmp", `takoserver-opgen-selector-${environment}-`),
      );
      try {
        const fixture = databaseProcess(db);
        const status = await runD1Schema(
          { action: "status", environment, commit: COMMIT, throughMigration: "0057" },
          { ...integrationTarget, environment },
          applyOptions(selectorRoot, fixture, fullCurrentMigrations),
        );
        expect(status).toMatchObject({
          throughMigration: "0057_cloudflare_managed_worker_version_execution_material.sql",
          pendingMigrations: ["0057_cloudflare_managed_worker_version_execution_material.sql"],
        });
      } finally {
        db.close();
        rmSync(selectorRoot, { recursive: true, force: true });
      }
    }
  });
});
