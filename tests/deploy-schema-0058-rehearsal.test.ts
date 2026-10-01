import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import { read0058Receipt } from "../scripts/deploy/schema-0058-apply-receipt.ts";
import {
  build0058SyntheticFixtureSql,
  type Fixture0058Snapshot,
  type Rehearsal0058Invocation,
  read0058FixtureSnapshot,
  runD1Schema0058Rehearsal,
} from "../scripts/deploy/schema-0058-rehearsal.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { copyCurrentSchemaFixture } from "./helpers/audited-schema-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "takoserver-0058-rehearsal-tests-"));
const migrationDirectory = copyCurrentSchemaFixture(join(root, "migrations"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const COMMIT = "a".repeat(40);
const ISOLATED_DATABASE_ID = "11111111-1111-4111-8111-111111111111";
const ISOLATED_DATABASE_NAME = "takoserver-0058-fixture";
const ordinaryTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "rehearsal",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-rehearsal",
  d1: {
    databaseName: "takoserver-runtime-rehearsal",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-rehearsal" },
  publicOrigin: "https://api.rehearsal.example.test",
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

function sqliteReader(database: Database) {
  return {
    async query(_phase: string, _description: string, sql: string) {
      return database.query(sql).all() as Record<string, unknown>[];
    },
  };
}

function databaseThrough(count: number): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.slice(0, count)) {
    database.exec(migration.sql);
    database
      .query("INSERT INTO d1_migrations (name, applied_at) VALUES (?, 'fixture')")
      .run(migration.name);
  }
  return database;
}

function writeCustody(directory: string): string {
  const path = join(directory, "0058-custody.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      kind: "takoserver.d1-0058-isolated-rehearsal-target@v1",
      accountId: ordinaryTarget.accountId,
      databaseId: ISOLATED_DATABASE_ID,
      databaseName: ISOLATED_DATABASE_NAME,
      disposableFixtureCustody: true,
      writersQuiesced: true,
      credentialScopeReviewed: true,
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

function processFixture(
  database: Database,
  interruptedImport = false,
  interruptedSeed = false,
  driftAfterSeed = false,
  advanceBeforeSeed = false,
  partialFailureProbe = false,
  partialQueryProbe = false,
  timeoutQueryProbe = false,
  timeoutImportProbe = false,
) {
  const calls: string[][] = [];
  const readQueries: string[] = [];
  const fileImports: string[] = [];
  let interruptNextImport = interruptedImport;
  let interruptNextSeed = interruptedSeed;
  let readsAtSeed = -1;
  let lineageReads = 0;
  let fixtureSeeded = false;
  let postSeedReceiptReads = 0;
  const run = async (command: readonly string[]): Promise<CommandResult> => {
    calls.push([...command]);
    if (command[0] === "timeout" && command[1] !== "--version") {
      expect(command.slice(0, 4)).toEqual(["timeout", "--signal=TERM", "--kill-after=5s", "120s"]);
      command = command.slice(4);
    }
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("release/schema\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "git fetch --quiet --all --prune") return ok("");
    if (key === `git branch -r --contains ${COMMIT}`) return ok("  origin/release-schema\n");
    if (key === "bun run check:migrations") return ok("green\n");
    if (key === "timeout --version") return ok("GNU coreutils timeout\n");

    if (command.includes("migrations") && command.includes("apply")) {
      const configPath = command[command.indexOf("--config") + 1];
      const migrationName = MIGRATIONS[57]?.name;
      if (!configPath || !migrationName)
        throw new Error("0058 query probe lacks config or migration");
      const sql = readFileSync(
        join(dirname(configPath), "query-probe-migrations", migrationName),
        "utf8",
      );
      const audited = readMigrationArtifact(migrationDirectory).files[57];
      if (!audited || sql !== buildD1MigrationImport([audited], { freshLedger: false }).sql)
        throw new Error("0058 query probe lacks exact audited migration and first ledger insert");
      if (timeoutQueryProbe)
        return {
          exitCode: 124,
          stdout: "",
          stderr: "UNIQUE constraint failed: d1_migrations.name",
        };
      try {
        if (partialQueryProbe) {
          database.exec(sql);
          database.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migrationName);
        } else
          database.transaction(() => {
            database.exec(sql);
            database.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migrationName);
          })();
      } catch (error) {
        if (!String(error).includes("UNIQUE constraint failed: d1_migrations.name")) throw error;
        return { exitCode: 1, stdout: "", stderr: "UNIQUE constraint failed: d1_migrations.name" };
      }
      throw new Error("0058 query probe unexpectedly succeeded");
    }

    const commandIndex = command.indexOf("--command");
    if (commandIndex >= 0) {
      const sql = command[commandIndex + 1];
      if (!sql) throw new Error("D1 query omitted its SQL");
      if (sql.includes("FROM d1_migrations ORDER BY id")) {
        lineageReads += 1;
        if (advanceBeforeSeed && lineageReads === 2) {
          const migration = readMigrationArtifact(migrationDirectory).files[57];
          if (!migration) throw new Error("audited 0058 migration is missing");
          database.exec(buildD1MigrationImport([migration], { freshLedger: false }).sql);
        }
      }
      if (
        fixtureSeeded &&
        sql.includes(
          "SELECT * FROM cloudflare_managed_worker_receipts ORDER BY provider_id, resource_uid",
        )
      ) {
        postSeedReceiptReads += 1;
        if (driftAfterSeed && postSeedReceiptReads === 2) {
          database
            .query(`INSERT INTO cloudflare_managed_worker_receipts
              (provider_id, resource_uid, native_id, kind, logical_worker_id, operation_id,
               generation, descriptor_digest, state, observed_json)
              VALUES (?, ?, ?, 'version', ?, ?, 1, ?, 'pending', '{}')`)
            .run(
              "synthetic-0058-drift",
              "synthetic-0058-drift-resource",
              "version:synthetic-0058-drift",
              "synthetic-worker",
              "synthetic-0058-drift-operation",
              `sha256:${"e".repeat(64)}`,
            );
        }
      }
      readQueries.push(sql);
      const results = database.query(sql).all() as Record<string, unknown>[];
      return ok(`${JSON.stringify([{ success: true, results }])}\n`);
    }

    const fileIndex = command.indexOf("--file");
    if (fileIndex >= 0) {
      const path = command[fileIndex + 1];
      if (!path) throw new Error("D1 file import omitted its path");
      fileImports.push(path);
      if (path.endsWith("fixture.sql")) readsAtSeed = readQueries.length;
      if (path.endsWith("rollback-probe.sql")) {
        if (timeoutImportProbe)
          return {
            exitCode: 124,
            stdout: "",
            stderr: "UNIQUE constraint failed: d1_migrations.name",
          };
        const sql = readFileSync(path, "utf8");
        const migrationName = MIGRATIONS[57]?.name;
        if (
          !migrationName ||
          !sql.endsWith(`INSERT INTO "d1_migrations" (name) VALUES ('${migrationName}');\n`)
        )
          throw new Error("rollback probe lacks the exact duplicate ledger tail");
        try {
          if (partialFailureProbe) database.exec(sql);
          else {
            const transactional = database.transaction(() => {
              database.exec(sql);
              // bun:sqlite may execute the final conflicting statement as a
              // separate prepare; force the same UNIQUE failure in this mock.
              database.query("INSERT INTO d1_migrations (name) VALUES (?)").run(migrationName);
            });
            transactional();
          }
        } catch (error) {
          if (!String(error).includes("UNIQUE constraint failed: d1_migrations.name")) throw error;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "UNIQUE constraint failed: d1_migrations.name",
          };
        }
        throw new Error("rollback probe unexpectedly succeeded");
      }
      database.exec(readFileSync(path, "utf8"));
      if (path.endsWith("fixture.sql")) fixtureSeeded = true;
      if (interruptNextSeed && path.endsWith("fixture.sql")) {
        interruptNextSeed = false;
        return { exitCode: 1, stdout: "", stderr: "seed transport interrupted after apply" };
      }
      if (interruptNextImport && path.endsWith("migration-import.sql")) {
        interruptNextImport = false;
        return { exitCode: 1, stdout: "", stderr: "transport interrupted after apply" };
      }
      return ok("executed file\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return {
    run,
    calls,
    readQueries,
    fileImports,
    queriesAfterSeed: () => readQueries.slice(readsAtSeed),
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function caseDirectory(label: string): string {
  return mkdtempSync(join(root, `${label}-`));
}

function makeOptions(
  directory: string,
  database: Database,
  interruptedImport = false,
  interruptedSeed = false,
  providerIdentity:
    | { readonly uuid: string; readonly name: string }
    | readonly { readonly uuid: string; readonly name: string }[] = {
    uuid: ISOLATED_DATABASE_ID,
    name: ISOLATED_DATABASE_NAME,
  },
  driftAfterSeed = false,
  advanceBeforeSeed = false,
  partialFailureProbe = false,
  partialQueryProbe = false,
  timeoutQueryProbe = false,
  timeoutImportProbe = false,
) {
  const fixture = processFixture(
    database,
    interruptedImport,
    interruptedSeed,
    driftAfterSeed,
    advanceBeforeSeed,
    partialFailureProbe,
    partialQueryProbe,
    timeoutQueryProbe,
    timeoutImportProbe,
  );
  const providerIdentities = Array.isArray(providerIdentity)
    ? providerIdentity
    : [providerIdentity];
  let providerRead = 0;
  return {
    fixture,
    options: {
      run: fixture.run,
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
      custodyPath: writeCustody(directory),
      migrationDirectory,
      outputDirectory: join(directory, "output"),
      fetcher: async () => {
        const identity =
          providerIdentities[Math.min(providerRead++, providerIdentities.length - 1)];
        return new Response(JSON.stringify({ success: true, result: identity }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}

function snapshotShape(snapshot: Fixture0058Snapshot) {
  return {
    counts: snapshot.counts,
    states: snapshot.states,
    digest: snapshot.digest,
    blobBytes: snapshot.blobBytes,
    exactSyntheticBlobs: snapshot.exactSyntheticBlobs,
    foreignKeyViolations: snapshot.foreignKeyViolations,
    foreignKeysEnabled: snapshot.foreignKeysEnabled,
  };
}

function schemaShape(database: Database): string {
  return canonicalSchemaShape(
    database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
          "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[],
  );
}

describe("0058 isolated D1 rehearsal", () => {
  test("requires a failed exact-import rollback probe before the real import", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const { fixture, options } = makeOptions(caseDirectory("probe-success"), database);
      const result = await runD1Schema0058Rehearsal(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        options,
      );
      expect(fixture.fileImports.map((path) => path.split("/").at(-1))).toEqual([
        "fixture.sql",
        "rollback-probe.sql",
        "migration-import.sql",
      ]);
      expect(
        fixture.calls.filter(
          (command) => command.includes("migrations") && command.includes("apply"),
        ),
      ).toHaveLength(1);
      expect(result).toMatchObject({ rollbackProbe: "failed-and-exact-0057-restored" });
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });

  test("partial failed D1 import quarantines target and never attempts the real 0058 import", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const { fixture, options } = makeOptions(
        caseDirectory("probe-partial"),
        database,
        false,
        false,
        { uuid: ISOLATED_DATABASE_ID, name: ISOLATED_DATABASE_NAME },
        false,
        false,
        true,
      );
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("rollback probe");
      expect(fixture.fileImports.map((path) => path.split("/").at(-1))).toEqual([
        "fixture.sql",
        "rollback-probe.sql",
      ]);
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });
  test("partial query-transport migration quarantines before either file import probe", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const { fixture, options } = makeOptions(
        caseDirectory("query-probe-partial"),
        database,
        false,
        false,
        { uuid: ISOLATED_DATABASE_ID, name: ISOLATED_DATABASE_NAME },
        false,
        false,
        false,
        true,
      );
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("query rollback probe");
      expect(fixture.fileImports.map((path) => path.split("/").at(-1))).toEqual(["fixture.sql"]);
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });
  test("timed-out query probe quarantines even when readback is unchanged", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const { fixture, options } = makeOptions(
        caseDirectory("query-probe-timeout"),
        database,
        false,
        false,
        { uuid: ISOLATED_DATABASE_ID, name: ISOLATED_DATABASE_NAME },
        false,
        false,
        false,
        false,
        true,
      );
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("query rollback probe");
      expect(fixture.fileImports.map((path) => path.split("/").at(-1))).toEqual(["fixture.sql"]);
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });
  test("timed-out import probe with UNIQUE output still quarantines and skips real import", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const { fixture, options } = makeOptions(
        caseDirectory("import-probe-timeout"),
        database,
        false,
        false,
        { uuid: ISOLATED_DATABASE_ID, name: ISOLATED_DATABASE_NAME },
        false,
        false,
        false,
        false,
        false,
        true,
      );
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("rollback probe");
      expect(fixture.fileImports.map((path) => path.split("/").at(-1))).toEqual([
        "fixture.sql",
        "rollback-probe.sql",
      ]);
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });
  test("the exact 0058 migration preserves all four synthetic lifecycle states and sealed BLOBs", async () => {
    const database = databaseThrough(57);
    try {
      database.exec(build0058SyntheticFixtureSql());
      const before = await read0058FixtureSnapshot(sqliteReader(database), "preflight");
      expect(before.counts).toEqual({
        cloudflare_managed_worker_receipts: 4,
        cloudflare_managed_worker_version_execution_material: 3,
        cloudflare_managed_worker_version_execution_secrets: 3,
        cloudflare_managed_worker_version_execution_provider_proofs: 3,
      });
      expect(before.states).toEqual({ pending: 1, committed: 1, deleting: 1, deleted: 1 });
      expect(before.blobBytes).toBeGreaterThanOrEqual(174);
      expect(before.exactSyntheticBlobs).toBe(true);
      expect(before.foreignKeyViolations).toBe(0);
      expect(before.foreignKeysEnabled).toBe(true);

      const artifact = readMigrationArtifact(migrationDirectory);
      const migration = artifact.files[57];
      expect(migration?.name).toBe("0058_cloudflare_managed_worker_domain_receipts.sql");
      if (!migration) throw new Error("audited 0058 migration is missing");
      database.exec(buildD1MigrationImport([migration], { freshLedger: false }).sql);

      const after = await read0058FixtureSnapshot(sqliteReader(database), "verification");
      expect(snapshotShape(after)).toEqual(snapshotShape(before));
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.query("SELECT name FROM d1_migrations ORDER BY id").all()).toHaveLength(58);
      expect(
        database.query("SELECT name FROM d1_migrations WHERE name = ?").get(migration.name),
      ).toEqual({ name: migration.name });
    } finally {
      database.close();
    }
  });

  test("an interrupted transactional 0058 import rolls back its DDL and ledger together", async () => {
    const database = databaseThrough(57);
    try {
      database.exec(build0058SyntheticFixtureSql());
      const beforeRows = await read0058FixtureSnapshot(sqliteReader(database), "preflight");
      const beforeShape = schemaShape(database);
      const beforeLineage = database.query("SELECT name FROM d1_migrations ORDER BY id").all() as {
        name: string;
      }[];
      const artifact = readMigrationArtifact(migrationDirectory);
      const migration = artifact.files[57];
      if (!migration) throw new Error("audited 0058 migration is missing");
      const imported = buildD1MigrationImport([migration], { freshLedger: false });
      const createStart = imported.sql.indexOf(
        "CREATE TABLE migration_0058_cloudflare_managed_worker_receipts",
      );
      const createEnd = imported.sql.indexOf(";", createStart) + 1;
      expect(createStart).toBeGreaterThanOrEqual(0);
      expect(createEnd).toBeGreaterThan(createStart);

      const interrupted = database.transaction(() => {
        database.exec(imported.sql.slice(createStart, createEnd));
        throw new Error("injected interruption after first 0058 DDL statement");
      });
      expect(interrupted).toThrow("injected interruption");

      expect(await read0058FixtureSnapshot(sqliteReader(database), "verification")).toEqual(
        beforeRows,
      );
      expect(schemaShape(database)).toBe(beforeShape);
      expect(database.query("SELECT name FROM d1_migrations ORDER BY id").all()).toEqual(
        beforeLineage,
      );
      expect(beforeLineage.map(({ name }) => name)).toEqual(
        MIGRATIONS.slice(0, 57).map(({ name }) => name),
      );
      expect(
        database.query("SELECT name FROM sqlite_schema WHERE name LIKE 'migration_0058_%'").all(),
      ).toEqual([]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      database.close();
    }
  });

  test("production selection is rejected before custody or transport is touched", async () => {
    const database = databaseThrough(57);
    try {
      const directory = caseDirectory("production-refusal");
      const { fixture } = makeOptions(directory, database);
      const invocation = {
        action: "apply",
        environment: "production",
        commit: COMMIT,
      } as unknown as Rehearsal0058Invocation;
      await expect(
        runD1Schema0058Rehearsal(
          invocation,
          {
            ...ordinaryTarget,
            environment: "production",
          },
          {
            run: fixture.run,
            migrationDirectory,
          },
        ),
      ).rejects.toThrow("rehearsal-only");
      expect(fixture.calls).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("status reports nonempty fixture tables and apply refuses before any write", async () => {
    const database = databaseThrough(57);
    try {
      database.exec(build0058SyntheticFixtureSql());
      const statusDirectory = caseDirectory("nonempty-status");
      const { fixture, options } = makeOptions(statusDirectory, database);
      const status = await runD1Schema0058Rehearsal(
        { action: "status", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        options,
      );
      expect(status).toMatchObject({
        kind: "takoserver.d1-0058-rehearsal-status@v1",
        fixtureTableCounts: {
          cloudflare_managed_worker_receipts: 4,
          cloudflare_managed_worker_version_execution_material: 3,
          cloudflare_managed_worker_version_execution_secrets: 3,
          cloudflare_managed_worker_version_execution_provider_proofs: 3,
        },
        readyForApply: false,
      });
      const applyDirectory = caseDirectory("nonempty-apply");
      const { fixture: applyFixture, options: applyOptions } = makeOptions(
        applyDirectory,
        database,
      );
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          applyOptions,
        ),
      ).rejects.toBeInstanceOf(DeployError);
      expect(fixture.fileImports).toHaveLength(0);
      expect(applyFixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("a noncanonical predecessor is refused before fixture inspection or mutation", async () => {
    const database = databaseThrough(56);
    try {
      const directory = caseDirectory("wrong-predecessor");
      const { fixture, options } = makeOptions(directory, database);
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("exact 0057 or 0058 lineage");
      expect(fixture.fileImports).toHaveLength(0);
      expect(
        fixture.readQueries.some((query) =>
          query.includes("FROM cloudflare_managed_worker_receipts"),
        ),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  test("a mismatched Cloudflare database UUID/name refuses before D1 reads", async () => {
    const database = databaseThrough(57);
    try {
      const directory = caseDirectory("wrong-provider-identity");
      const { fixture, options } = makeOptions(directory, database, false, false, {
        uuid: "22222222-2222-4222-8222-222222222222",
        name: ISOLATED_DATABASE_NAME,
      });
      await expect(
        runD1Schema0058Rehearsal(
          { action: "status", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("provider identity does not match");
      expect(fixture.readQueries).toHaveLength(0);
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("a 0058 change at the immediate predecessor fence refuses before fixture seed", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const directory = caseDirectory("advanced-predecessor-fence");
      const { fixture, options } = makeOptions(
        directory,
        database,
        false,
        false,
        { uuid: ISOLATED_DATABASE_ID, name: ISOLATED_DATABASE_NAME },
        false,
        true,
      );
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("exact canonical 0057 predecessor");
      expect(fixture.fileImports).toHaveLength(0);
      expect(database.query("SELECT name FROM d1_migrations ORDER BY id").all()).toHaveLength(58);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });

  test("an interrupted import reconciles from its durable receipt on fresh status without replay", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const directory = caseDirectory("interrupted-import");
      const { fixture, options } = makeOptions(directory, database, true);
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("acknowledgement indeterminate");
      expect(fixture.fileImports.filter((path) => path.endsWith("fixture.sql"))).toHaveLength(1);
      expect(
        fixture.fileImports.filter((path) => path.endsWith("migration-import.sql")),
      ).toHaveLength(1);
      expect(
        fixture.readQueries.some((query) => query.includes("FROM d1_migrations ORDER BY id")),
      ).toBe(true);
      expect(
        database
          .query("SELECT name FROM d1_migrations WHERE name = ?")
          .get(MIGRATIONS[57]?.name ?? ""),
      ).toEqual({ name: MIGRATIONS[57]?.name });
      const after = await read0058FixtureSnapshot(sqliteReader(database), "verification");
      expect(after.counts).toEqual({
        cloudflare_managed_worker_receipts: 4,
        cloudflare_managed_worker_version_execution_material: 3,
        cloudflare_managed_worker_version_execution_secrets: 3,
        cloudflare_managed_worker_version_execution_provider_proofs: 3,
      });
      expect(after.foreignKeyViolations).toBe(0);
      const importsBeforeStatus = fixture.fileImports.filter((path) =>
        path.endsWith("migration-import.sql"),
      ).length;
      const statusOptions = makeOptions(caseDirectory("interrupted-import-status"), database);
      statusOptions.options.custodyPath = options.custodyPath;
      const status = await runD1Schema0058Rehearsal(
        { action: "status", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        statusOptions.options,
      );
      expect(status).toMatchObject({
        attemptState: "dispatched",
        reconciliation: "observed-complete-no-provider-ack-claimed",
        providerAcknowledgement: "not-claimed",
        readyForApply: false,
        qualification: "not-production-evidence",
      });
      expect(status).toHaveProperty("observedAppliedMigration", MIGRATIONS[57]?.name);
      const duplicateStatusOptions = makeOptions(
        caseDirectory("interrupted-import-duplicate-status"),
        database,
      );
      duplicateStatusOptions.options.custodyPath = options.custodyPath;
      const duplicateStatus = await runD1Schema0058Rehearsal(
        { action: "status", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        duplicateStatusOptions.options,
      );
      expect(duplicateStatus).toEqual(status);
      expect(
        fixture.fileImports.filter((path) => path.endsWith("migration-import.sql")),
      ).toHaveLength(importsBeforeStatus);
      const duplicateApplyOptions = makeOptions(
        caseDirectory("interrupted-import-duplicate-apply"),
        database,
      );
      duplicateApplyOptions.options.custodyPath = options.custodyPath;
      const duplicateApply = await runD1Schema0058Rehearsal(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        duplicateApplyOptions.options,
      );
      expect(duplicateApply).toMatchObject({
        reconciliation: "observed-complete-no-provider-ack-claimed",
        recovery: "status-only reconciliation; a dispatched 0058 import is never replayed",
      });
      expect(duplicateApplyOptions.fixture.fileImports).toHaveLength(0);
      const mismatchedSourceOptions = makeOptions(
        caseDirectory("interrupted-import-source-mismatch"),
        database,
      );
      mismatchedSourceOptions.options.custodyPath = options.custodyPath;
      await expect(
        runD1Schema0058Rehearsal(
          { action: "status", environment: "rehearsal", commit: "b".repeat(40) },
          ordinaryTarget,
          mismatchedSourceOptions.options,
        ),
      ).rejects.toThrow("attempt receipt does not match");
      expect(mismatchedSourceOptions.fixture.fileImports).toHaveLength(0);
      const dispatchedPath = `${options.custodyPath}.0058-dispatched.json`;
      const corruptedReceipt = JSON.parse(readFileSync(dispatchedPath, "utf8")) as {
        digest: string;
      };
      corruptedReceipt.digest = `sha256:${"0".repeat(64)}`;
      writeFileSync(dispatchedPath, `${JSON.stringify(corruptedReceipt)}\n`);
      const corruptedReceiptOptions = makeOptions(
        caseDirectory("interrupted-import-receipt-tamper"),
        database,
      );
      corruptedReceiptOptions.options.custodyPath = options.custodyPath;
      await expect(
        runD1Schema0058Rehearsal(
          { action: "status", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          corruptedReceiptOptions.options,
        ),
      ).rejects.toThrow("attempt receipt integrity check");
      expect(corruptedReceiptOptions.fixture.fileImports).toHaveLength(0);
      const custodyPath = options.custodyPath;
      if (custodyPath === undefined) throw new Error("test target custody path was not selected");
      const preparedPath = `${custodyPath}.0058-prepared.json`;
      const prepared = JSON.parse(readFileSync(preparedPath, "utf8")) as Record<string, unknown>;
      const { digest: _preparedDigest, ...preparedBody } = prepared;
      const mismatchedBody = {
        kind: preparedBody.kind,
        state: "dispatched",
        preparedDigest: `sha256:${"1".repeat(64)}`,
        environment: preparedBody.environment,
        target: preparedBody.target,
        source: preparedBody.source,
        before: preparedBody.before,
      };
      writeFileSync(
        preparedPath,
        `${JSON.stringify({
          ...mismatchedBody,
          digest: `sha256:${createHash("sha256").update(JSON.stringify(mismatchedBody)).digest("hex")}`,
        })}\n`,
      );
      expect(() => read0058Receipt(custodyPath, "prepared")).toThrow(
        "state does not match receipt filename",
      );
      writeFileSync(dispatchedPath, Buffer.alloc(128 * 1024 + 1, 0x20));
      expect(() => read0058Receipt(custodyPath, "dispatched")).toThrow(
        "receipt custody is invalid",
      );
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });

  test("a nonzero seed acknowledgement is read back and the fixture is never replayed", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const directory = caseDirectory("interrupted-seed");
      const { fixture, options } = makeOptions(directory, database, false, true);
      await expect(
        runD1Schema0058Rehearsal(
          { action: "apply", environment: "rehearsal", commit: COMMIT },
          ordinaryTarget,
          options,
        ),
      ).rejects.toThrow("fixture seed acknowledgement indeterminate");

      expect(fixture.fileImports.filter((path) => path.endsWith("fixture.sql"))).toHaveLength(1);
      expect(
        fixture.fileImports.filter((path) => path.endsWith("migration-import.sql")),
      ).toHaveLength(0);
      const postSeedQueries = fixture.queriesAfterSeed();
      expect(
        postSeedQueries.some((query) => query.includes("FROM d1_migrations ORDER BY id")),
      ).toBe(true);
      expect(
        postSeedQueries.some((query) =>
          query.includes(
            "FROM cloudflare_managed_worker_receipts ORDER BY provider_id, resource_uid",
          ),
        ),
      ).toBe(true);
      const seeded = await read0058FixtureSnapshot(sqliteReader(database), "verification");
      expect(seeded.counts).toEqual({
        cloudflare_managed_worker_receipts: 4,
        cloudflare_managed_worker_version_execution_material: 3,
        cloudflare_managed_worker_version_execution_secrets: 3,
        cloudflare_managed_worker_version_execution_provider_proofs: 3,
      });
      expect(seeded.states).toEqual({ pending: 1, committed: 1, deleting: 1, deleted: 1 });
      expect(seeded.foreignKeyViolations).toBe(0);
      expect(database.query("SELECT name FROM d1_migrations ORDER BY id").all()).toHaveLength(57);
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });

  test("post-seed row drift is classified as changed-target failure and status remains available", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const directory = caseDirectory("post-seed-row-drift");
      const { fixture, options } = makeOptions(
        directory,
        database,
        false,
        false,
        { uuid: ISOLATED_DATABASE_ID, name: ISOLATED_DATABASE_NAME },
        true,
      );
      const failure = await runD1Schema0058Rehearsal(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        options,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(["mutation", "verification"]).toContain((failure as DeployError).phase);
      expect(fixture.fileImports.filter((path) => path.endsWith("fixture.sql"))).toHaveLength(1);
      expect(
        fixture.fileImports.filter((path) => path.endsWith("migration-import.sql")),
      ).toHaveLength(0);

      const statusDirectory = caseDirectory("post-seed-row-drift-status");
      const { options: statusOptions } = makeOptions(statusDirectory, database);
      const status = await runD1Schema0058Rehearsal(
        { action: "status", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        statusOptions,
      );
      expect(status).toMatchObject({
        appliedMigration: MIGRATIONS[56]?.name,
        fixtureTableCounts: { cloudflare_managed_worker_receipts: 5 },
        readyForApply: false,
      });
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });

  test("post-seed provider UUID/name drift is classified as changed-target failure", async () => {
    const database = databaseThrough(57);
    const reviewer = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    process.env.TAKOSERVER_INDEPENDENT_REVIEW = "reviewer@example.test";
    try {
      const directory = caseDirectory("post-seed-provider-drift");
      const { fixture, options } = makeOptions(directory, database, false, false, [
        { uuid: ISOLATED_DATABASE_ID, name: ISOLATED_DATABASE_NAME },
        { uuid: ISOLATED_DATABASE_ID, name: ISOLATED_DATABASE_NAME },
        { uuid: "22222222-2222-4222-8222-222222222222", name: ISOLATED_DATABASE_NAME },
      ]);
      const failure = await runD1Schema0058Rehearsal(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        options,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(["mutation", "verification"]).toContain((failure as DeployError).phase);
      expect(fixture.fileImports.filter((path) => path.endsWith("fixture.sql"))).toHaveLength(1);
      expect(
        fixture.fileImports.filter((path) => path.endsWith("migration-import.sql")),
      ).toHaveLength(0);

      const statusDirectory = caseDirectory("post-seed-provider-drift-status");
      const { options: statusOptions } = makeOptions(statusDirectory, database);
      const status = await runD1Schema0058Rehearsal(
        { action: "status", environment: "rehearsal", commit: COMMIT },
        ordinaryTarget,
        statusOptions,
      );
      expect(status).toMatchObject({
        appliedMigration: MIGRATIONS[56]?.name,
        fixtureTableCounts: { cloudflare_managed_worker_receipts: 4 },
        readyForApply: false,
      });
    } finally {
      database.close();
      if (reviewer === undefined) delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
      else process.env.TAKOSERVER_INDEPENDENT_REVIEW = reviewer;
    }
  });
});

test("receipt lookup treats only ENOENT as an absent marker", () => {
  const custodyPath = join(caseDirectory("receipt-non-enoent"), "x".repeat(245));
  expect(() => read0058Receipt(custodyPath, "dispatched")).toThrow("could not be opened safely");
});
