import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type D1SnapshotRestoreDeclaration,
  type D1SnapshotRestoreInvocation,
  type D1SnapshotRestoreOptions,
  deriveSnapshotExpectations,
  normalizeSnapshotDump,
  runD1SnapshotRestore,
  type SnapshotExpectations,
  type SnapshotRestoreReadback,
  verifySnapshotRestore,
} from "../scripts/deploy/d1-snapshot-restore.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";

const root = mkdtempSync(join(tmpdir(), "takoserver-d1-snapshot-restore-tests-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const COMMIT = "a".repeat(40);
const ACCOUNT_ID = "b".repeat(32);
const DATABASE_NAME = `takoserver-r-${"c".repeat(32)}`;
const DATABASE_ID = "00000000-0000-4000-8000-000000000061";

const DUMP = [
  "PRAGMA defer_foreign_keys=TRUE;",
  'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP);',
  'INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1, \'0001_alpha.sql\', \'2026-01-01 00:00:00\');',
  'INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2, \'0002_beta.sql\', \'2026-01-01 00:00:00\');',
  'CREATE TABLE "alpha" (id INTEGER PRIMARY KEY, name TEXT, note TEXT);',
  'CREATE TABLE "beta" (id INTEGER PRIMARY KEY, payload TEXT);',
  'CREATE UNIQUE INDEX "alpha_by_name" ON "alpha" (name);',
  'CREATE VIEW "gamma" AS SELECT id FROM "alpha";',
  'INSERT INTO "alpha" ("id","name","note") VALUES (1, \'one\', \'semi;colon\'), (2, \'two\', NULL);',
  'INSERT INTO "beta" ("id","payload") VALUES (1, \'x\u0000y\');',
  'INSERT INTO "beta" ("id","payload") VALUES (2, \'plain\');',
  "DELETE FROM sqlite_sequence;",
  "",
].join("\n");

/**
 * The measured `wrangler d1 export` shape: raw NUL bytes inside TEXT
 * literals (composite replay keys), which D1's parser stops at while
 * `wrangler d1 execute --file` still exits 0.
 */
function dumpBytes(): Buffer {
  return Buffer.from(DUMP, "utf8");
}

function dumpBytesWithEmptyTable(): Buffer {
  return Buffer.from(`${DUMP}\nCREATE TABLE "empty" (id INTEGER PRIMARY KEY);`, "utf8");
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

let caseCounter = 0;
function caseDirectory(label: string): string {
  caseCounter += 1;
  return mkdtempSync(join(root, `${label}-${caseCounter}-`));
}

function writeSnapshot(directory: string, bytes: Uint8Array = dumpBytes()): string {
  const path = join(directory, "snapshot.sql");
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function declaration(
  snapshotPath: string,
  bytes: Uint8Array = dumpBytes(),
  overrides: Partial<D1SnapshotRestoreDeclaration> = {},
): D1SnapshotRestoreDeclaration {
  return {
    kind: "takoserver.d1-snapshot-restore@v1",
    environment: "rehearsal",
    accountId: ACCOUNT_ID,
    databaseName: DATABASE_NAME,
    databaseId: DATABASE_ID,
    snapshotPath,
    snapshotSha256: digestBytes(bytes),
    ...overrides,
  };
}

type RestoreRun = NonNullable<D1SnapshotRestoreOptions["run"]>;

function ok(stdout = ""): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

/**
 * A D1 stub backed by SQLite. `--file` imports run the exact bytes the surface
 * sealed; `truncateAt` reproduces the measured provider behaviour where D1's text
 * parser stops at the first raw NUL byte and the command still exits 0.
 */
function harness(
  database: Database,
  options: {
    readonly truncateAt?: number;
    readonly exitCode?: number;
    readonly throwImport?: boolean;
    readonly reportedQueries?: number;
    readonly failQuery?: string;
    readonly queryOverride?: {
      readonly includes: string;
      readonly afterImport?: boolean;
      readonly results: readonly Record<string, unknown>[];
    };
    readonly beforeRemoteReachability?: () => void;
  } = {},
): { readonly run: RestoreRun; readonly calls: string[][]; readonly fileImports: string[] } {
  const calls: string[][] = [];
  const fileImports: string[] = [];
  const run: RestoreRun = async (command) => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("feature/rehearsal-d1-snapshot-restore\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "git fetch --quiet --all --prune") return ok("");
    if (key === `git branch -r --contains ${COMMIT}`) {
      options.beforeRemoteReachability?.();
      return ok("  origin/feature/rehearsal\n");
    }
    const fileIndex = command.indexOf("--file");
    if (fileIndex >= 0) {
      const path = command[fileIndex + 1] ?? "";
      const sql = readFileSync(path, "utf8");
      fileImports.push(sql);
      const applied = options.truncateAt === undefined ? sql : sql.slice(0, options.truncateAt);
      try {
        database.exec(applied);
      } catch {
        // The platform truncates mid-statement without failing the command.
      }
      if (options.throwImport === true) throw new Error("import acknowledgement was lost");
      if (options.exitCode !== undefined && options.exitCode !== 0) {
        return { exitCode: options.exitCode, stdout: "", stderr: "transport interrupted" };
      }
      const summary =
        options.reportedQueries === undefined
          ? {}
          : { "Total queries executed": options.reportedQueries };
      return ok(JSON.stringify([{ success: true, results: [summary] }]));
    }
    const commandIndex = command.indexOf("--command");
    if (commandIndex >= 0) {
      const sql = command[commandIndex + 1] ?? "";
      if (options.failQuery === sql) {
        return { exitCode: 1, stdout: "", stderr: "readback unavailable" };
      }
      if (
        options.queryOverride !== undefined &&
        sql.includes(options.queryOverride.includes) &&
        (!options.queryOverride.afterImport || fileImports.length > 0)
      ) {
        return ok(JSON.stringify([{ success: true, results: options.queryOverride.results }]));
      }
      const results = database.query(sql).all() as Record<string, unknown>[];
      return ok(JSON.stringify([{ success: true, results }]));
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls, fileImports };
}

function restoreOptions(
  directory: string,
  run: RestoreRun,
  overrides: Partial<D1SnapshotRestoreOptions> = {},
): D1SnapshotRestoreOptions {
  return {
    run,
    review: "independent review 123",
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "test-token" },
    outputDirectory: join(directory, "output"),
    fetcher: async () =>
      new Response(
        JSON.stringify({ success: true, result: { uuid: DATABASE_ID, name: DATABASE_NAME } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ...overrides,
  };
}

function invocation(action: "status" | "apply" = "apply"): D1SnapshotRestoreInvocation {
  return { action, environment: "rehearsal", commit: COMMIT };
}

async function rejected(run: Promise<unknown>): Promise<DeployError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(DeployError);
    if (!(error instanceof DeployError)) throw error;
    return error;
  }
  throw new Error("expected operation to reject");
}

function emptyDatabase(): Database {
  return new Database(":memory:");
}

function fixtureExpectations(): SnapshotExpectations {
  return deriveSnapshotExpectations(normalizeSnapshotDump(dumpBytes()).sql);
}

function readbackFixture(overrides: Partial<SnapshotRestoreReadback>): SnapshotRestoreReadback {
  const expected = fixtureExpectations();
  return {
    tables: expected.tables,
    indexes: expected.indexes,
    triggers: expected.triggers,
    views: expected.views,
    rowCounts: expected.rowCounts,
    migrationLineage: expected.migrationLineage,
    foreignKeyViolations: 0,
    reportedQueries: null,
    ...overrides,
  };
}

describe("snapshot dump normalization", () => {
  test("rewrites in-literal NUL bytes so the dump survives D1's text parser intact", () => {
    const normalized = normalizeSnapshotDump(dumpBytes());
    expect(normalized.nulBytes).toBe(1);
    expect(normalized.sql.includes("\u0000")).toBe(false);
    expect(normalized.sql).toContain("'x'||char(0)||'y'");

    const database = new Database(":memory:");
    try {
      database.exec(normalized.sql);
      const row = database.query('SELECT hex(payload) AS hex FROM "beta" WHERE id = 1').get() as {
        hex: string;
      };
      expect(row.hex).toBe("780079");
      expect(
        database.query("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'gamma'").get(),
      ).toEqual({ n: 1 });
    } finally {
      database.close();
    }
  });

  test("refuses a NUL byte that is not inside a single-quoted literal", async () => {
    const raw = Buffer.concat([
      Buffer.from('CREATE TABLE "a" (id INTEGER);', "utf8"),
      Buffer.from([0]),
    ]);
    const error = await rejected(Promise.resolve().then(() => normalizeSnapshotDump(raw)));
    expect(error.phase).toBe("preflight");
    expect(error.message).toContain("NUL byte outside a single-quoted literal");
  });

  test("refuses bytes that are not UTF-8 text", async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const error = await rejected(Promise.resolve().then(() => normalizeSnapshotDump(raw)));
    expect(error.phase).toBe("preflight");
  });
});

describe("snapshot expectations", () => {
  test("derives tables, rows, schema objects and the migration lineage", () => {
    const expected = fixtureExpectations();
    expect(expected.tables).toEqual(["alpha", "beta"]);
    expect(expected.rowCounts).toEqual({ alpha: 2, beta: 2 });
    expect(expected.indexes).toBe(1);
    expect(expected.views).toBe(1);
    expect(expected.triggers).toBe(0);
    expect(expected.migrationLineage).toEqual(["0001_alpha.sql", "0002_beta.sql"]);
    expect(expected.statements).toBeGreaterThan(0);
  });

  test.each([
    [
      "an INSERT this restore cannot count",
      'INSERT INTO "alpha" ("id") SELECT id FROM "beta";',
      "cannot count",
    ],
    [
      "an INSERT into a table the dump never creates",
      'INSERT INTO "delta" ("id") VALUES (1);',
      "does not create",
    ],
    ["a write to an application table", 'UPDATE "alpha" SET note = NULL;', "cannot verify"],
  ])("refuses %s", (_label, statement, message) => {
    const sql = `${normalizeSnapshotDump(dumpBytes()).sql + statement}\n`;
    expect(() => deriveSnapshotExpectations(sql)).toThrow(message);
  });
});

describe("snapshot restore verification", () => {
  test("accepts an exact readback", () => {
    expect(verifySnapshotRestore(fixtureExpectations(), readbackFixture({}))).toEqual({
      ok: true,
      mismatches: [],
    });
  });

  test("reports every difference instead of reporting a partial application as success", () => {
    const comparison = verifySnapshotRestore(
      fixtureExpectations(),
      readbackFixture({
        tables: ["alpha"],
        indexes: 0,
        rowCounts: { alpha: 1 },
        migrationLineage: [],
        foreignKeyViolations: 2,
        reportedQueries: 45,
      }),
    );
    expect(comparison.ok).toBe(false);
    expect(comparison.mismatches).toContain("missing table beta");
    expect(comparison.mismatches).toContain("index count: expected 1, read back 0");
    expect(comparison.mismatches).toContain("table alpha: expected 2 rows, read back 1");
    expect(comparison.mismatches).toContain(
      "d1_migrations lineage: expected 2 entries, read back 0",
    );
    expect(comparison.mismatches).toContain("foreign key violations: 2");
    expect(comparison.mismatches).toContain(
      `applied statements: expected ${fixtureExpectations().statements}, wrangler reported 45`,
    );
  });

  test("reports an unexpected user table as a mismatch", () => {
    const comparison = verifySnapshotRestore(
      fixtureExpectations(),
      readbackFixture({ tables: ["alpha", "beta", "delta"] }),
    );
    expect(comparison.ok).toBe(false);
    expect(comparison.mismatches).toContain("unexpected table delta");
  });

  test("bounds mismatch details while indicating omitted differences", () => {
    const tables = Array.from({ length: 20 }, (_value, index) => `missing_${index}`);
    const expectations = fixtureExpectations();
    const comparison = verifySnapshotRestore(
      {
        ...expectations,
        tables,
        rowCounts: Object.fromEntries(tables.map((table) => [table, 0])),
      },
      readbackFixture({ tables: [] }),
    );

    expect(comparison.mismatches).toHaveLength(13);
    expect(comparison.mismatches.at(-1)).toBe("... and 8 more mismatches");
  });
});

describe("snapshot restore surface", () => {
  test("restores a NUL-bearing dump and proves completeness from the readback", async () => {
    const directory = caseDirectory("restore");
    const database = emptyDatabase();
    try {
      database.exec(
        'CREATE TABLE "_cf_KV" (key TEXT PRIMARY KEY, value BLOB);' +
          'CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP);',
      );
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database);
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath),
        invocation("apply"),
        restoreOptions(directory, fixture.run),
      );

      expect(fixture.fileImports).toHaveLength(1);
      expect(fixture.fileImports[0]?.includes("\u0000")).toBe(false);
      expect(fixture.fileImports[0]).toContain("'x'||char(0)||'y'");
      expect(result).toMatchObject({
        kind: "takoserver.d1-snapshot-restore-apply@v1",
        surface: "takoserver-d1-snapshot-restore",
        environment: "rehearsal",
        commit: COMMIT,
        reviewer: "independent review 123",
        databaseId: DATABASE_ID,
        databaseName: DATABASE_NAME,
        providerIdentityVerified: true,
        nulBytesRewritten: 1,
        tables: 2,
        rows: 4,
        migrationLineage: 2,
        foreignKeyViolations: 0,
      });
      expect(database.query("SELECT name FROM d1_migrations ORDER BY id").all()).toEqual([
        { name: "0001_alpha.sql" },
        { name: "0002_beta.sql" },
      ]);
    } finally {
      database.close();
    }
  });

  test("never reports a partially applied import as success", async () => {
    const directory = caseDirectory("partial");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const normalized = normalizeSnapshotDump(dumpBytes()).sql;
      const cutAt = normalized.indexOf('INSERT INTO "beta"');
      expect(cutAt).toBeGreaterThan(0);
      const fixture = harness(database, { truncateAt: cutAt });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("verification");
      expect(error.message).toContain("partial application is never reported as success");
      expect(fixture.fileImports).toHaveLength(1);
      expect(fixture.calls.filter((command) => command.includes("--file")).length).toBe(1);
    } finally {
      database.close();
    }
  });

  test("refuses a target that already carries application tables before importing", async () => {
    const directory = caseDirectory("occupied");
    const database = emptyDatabase();
    try {
      database.exec('CREATE TABLE "existing" (id INTEGER PRIMARY KEY);');
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database);
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("never resets or overwrites a D1");
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("refuses a target that carries a standalone schema object before importing", async () => {
    const directory = caseDirectory("occupied-view");
    const database = emptyDatabase();
    try {
      database.exec('CREATE VIEW "sqliteXresidue" AS SELECT 1 AS value;');
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database);
      const status = await runD1SnapshotRestore(
        declaration(snapshotPath),
        invocation("status"),
        restoreOptions(directory, fixture.run),
      );
      expect(status).toMatchObject({ readyForApply: false, targetTables: 0, targetViews: 1 });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, fixture.run, {
            outputDirectory: join(directory, "apply-output"),
          }),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("never resets or overwrites a D1");
      expect(fixture.fileImports).toHaveLength(0);
      expect(
        database.query("SELECT type, name FROM sqlite_schema WHERE name = 'sqliteXresidue'").all(),
      ).toEqual([{ type: "view", name: "sqliteXresidue" }]);
    } finally {
      database.close();
    }
  });

  test("rechecks schema-object emptiness at the import fence", async () => {
    const directory = caseDirectory("refence-view");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database, {
        beforeRemoteReachability: () => {
          database.exec('CREATE VIEW "sqliteXlate_residue" AS SELECT 1 AS value;');
        },
      });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("changed before the import");
      expect(fixture.fileImports).toHaveLength(0);
      expect(
        database
          .query("SELECT type, name FROM sqlite_schema WHERE name = 'sqliteXlate_residue'")
          .all(),
      ).toEqual([{ type: "view", name: "sqliteXlate_residue" }]);
    } finally {
      database.close();
    }
  });

  test("treats an interrupted import acknowledgement as indeterminate without replaying it", async () => {
    const directory = caseDirectory("interrupted");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database, { exitCode: 1 });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("mutation");
      expect(error.message).toContain("indeterminate");
      expect(fixture.calls.filter((command) => command.includes("--file")).length).toBe(1);
    } finally {
      database.close();
    }
  });

  test("status is a read-only readback that reports readiness", async () => {
    const directory = caseDirectory("status");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database);
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath),
        invocation("status"),
        restoreOptions(directory, fixture.run),
      );

      expect(fixture.fileImports).toHaveLength(0);
      expect(result).toMatchObject({
        kind: "takoserver.d1-snapshot-restore-status@v1",
        surface: "takoserver-d1-snapshot-restore",
        nulBytesRewritten: 1,
        targetTables: 0,
        targetMigrationRows: 0,
        currentSnapshotExpectationMatch: null,
        currentSnapshotExpectationMismatches: [],
        readyForApply: true,
      });
    } finally {
      database.close();
    }
  });

  test("status compares a nonempty target with the pinned snapshot structure", async () => {
    const directory = caseDirectory("status-match");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      database.exec(normalizeSnapshotDump(dumpBytes()).sql);
      const fixture = harness(database);
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath),
        invocation("status"),
        restoreOptions(directory, fixture.run),
      );

      expect(fixture.fileImports).toHaveLength(0);
      expect(result).toMatchObject({
        expectedTableNames: ["alpha", "beta"],
        expectedRowsByTable: { alpha: 2, beta: 2 },
        expectedIndexes: 1,
        expectedTriggers: 0,
        expectedViews: 1,
        expectedMigrationLineageNames: ["0001_alpha.sql", "0002_beta.sql"],
        currentTables: ["alpha", "beta"],
        currentRowsByTable: { alpha: 2, beta: 2 },
        currentIndexes: 1,
        currentTriggers: 0,
        currentViews: 1,
        currentMigrationLineageNames: ["0001_alpha.sql", "0002_beta.sql"],
        currentForeignKeyViolations: 0,
        currentSnapshotExpectationMatch: true,
        currentSnapshotExpectationMismatches: [],
        readyForApply: false,
      });
    } finally {
      database.close();
    }
  });

  test("status reports partial target state as bounded expectation mismatches", async () => {
    const directory = caseDirectory("status-partial");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      database.exec(
        'CREATE TABLE "alpha" (id INTEGER PRIMARY KEY, name TEXT, note TEXT);' +
          "INSERT INTO \"alpha\" VALUES (1, 'one', NULL);",
      );
      const fixture = harness(database);
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath),
        invocation("status"),
        restoreOptions(directory, fixture.run),
      );

      expect(fixture.fileImports).toHaveLength(0);
      expect(result).toMatchObject({
        currentSnapshotExpectationMatch: false,
        currentSnapshotExpectationMismatches: expect.arrayContaining([
          "table alpha: expected 2 rows, read back 1",
          "missing table beta",
          "index count: expected 1, read back 0",
        ]),
        readyForApply: false,
      });
    } finally {
      database.close();
    }
  });

  test("status detects same-count tables and migration lineage with different names", async () => {
    const directory = caseDirectory("status-same-count-wrong-names");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      database.exec(
        'CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);' +
          "INSERT INTO d1_migrations VALUES (1, '0001_other.sql', 'now'), (2, '0002_other.sql', 'now');" +
          'CREATE TABLE "alpha_renamed" (id INTEGER PRIMARY KEY, name TEXT, note TEXT);' +
          'CREATE TABLE "beta_renamed" (id INTEGER PRIMARY KEY, payload TEXT);' +
          "INSERT INTO \"alpha_renamed\" VALUES (1, 'one', NULL), (2, 'two', NULL);" +
          "INSERT INTO \"beta_renamed\" VALUES (1, 'x'), (2, 'y');" +
          'CREATE UNIQUE INDEX "renamed_alpha_by_name" ON "alpha_renamed" (name);' +
          'CREATE VIEW "renamed_gamma" AS SELECT id FROM "alpha_renamed";',
      );
      const fixture = harness(database);
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath),
        invocation("status"),
        restoreOptions(directory, fixture.run),
      );

      expect(fixture.fileImports).toHaveLength(0);
      expect(result).toMatchObject({
        targetTables: 2,
        targetMigrationRows: 2,
        targetIndexes: 1,
        targetViews: 1,
        currentSnapshotExpectationMatch: false,
        currentSnapshotExpectationMismatches: expect.arrayContaining([
          "missing table alpha",
          "missing table beta",
          "unexpected table alpha_renamed",
          "unexpected table beta_renamed",
          "d1_migrations lineage entries differ",
        ]),
      });
    } finally {
      database.close();
    }
  });

  test("status fails closed with a read-only typed error when structural readback is unreadable", async () => {
    const directory = caseDirectory("status-unreadable");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      database.exec(normalizeSnapshotDump(dumpBytes()).sql);
      const rowCountsQuery =
        'SELECT (SELECT COUNT(*) FROM "alpha") AS "alpha", (SELECT COUNT(*) FROM "beta") AS "beta"';
      const fixture = harness(database, { failQuery: rowCountsQuery });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("status"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("snapshot restore readback row counts failed");
      expect(error.message).not.toContain("SELECT");
      expect(error.detail).toBeUndefined();
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("status accepts a readable zero count for a snapshot table with no rows", async () => {
    const directory = caseDirectory("status-zero-row-table");
    const database = emptyDatabase();
    try {
      const bytes = dumpBytesWithEmptyTable();
      const snapshotPath = writeSnapshot(directory, bytes);
      database.exec(normalizeSnapshotDump(bytes).sql);
      const fixture = harness(database);
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath, bytes),
        invocation("status"),
        restoreOptions(directory, fixture.run),
      );

      expect(result).toMatchObject({
        expectedRowsByTable: { alpha: 2, beta: 2, empty: 0 },
        currentRowsByTable: { alpha: 2, beta: 2, empty: 0 },
        currentSnapshotExpectationMatch: true,
      });
    } finally {
      database.close();
    }
  });

  test.each([
    ["missing zero count", [{ alpha: 2, beta: 2 }]],
    ["unexpected count alias", [{ alpha: 2, beta: 2, empty: 0, extra: 0 }]],
    ["negative zero-table count", [{ alpha: 2, beta: 2, empty: -1 }]],
    ["noninteger zero-table count", [{ alpha: 2, beta: 2, empty: 0.5 }]],
    ["non-numeric zero-table count", [{ alpha: 2, beta: 2, empty: "0" }]],
    [
      "multiple count rows",
      [
        { alpha: 2, beta: 2, empty: 0 },
        { alpha: 2, beta: 2, empty: 0 },
      ],
    ],
  ] as const)(
    "status refuses %s instead of classifying unknown count state",
    async (_label, rows) => {
      const directory = caseDirectory("status-malformed-count");
      const database = emptyDatabase();
      try {
        const bytes = dumpBytesWithEmptyTable();
        const snapshotPath = writeSnapshot(directory, bytes);
        database.exec(normalizeSnapshotDump(bytes).sql);
        const fixture = harness(database, {
          queryOverride: {
            includes: 'SELECT (SELECT COUNT(*) FROM "alpha")',
            results: rows,
          },
        });
        const error = await rejected(
          runD1SnapshotRestore(
            declaration(snapshotPath, bytes),
            invocation("status"),
            restoreOptions(directory, fixture.run),
          ),
        );

        expect(error.phase).toBe("preflight");
        expect(error.message).toContain("snapshot restore readback row counts");
        expect(error.detail).toBeUndefined();
        expect(fixture.fileImports).toHaveLength(0);
      } finally {
        database.close();
      }
    },
  );

  test("apply classifies a malformed successful count readback as verification failure without replay", async () => {
    const directory = caseDirectory("apply-malformed-row-count");
    const database = emptyDatabase();
    try {
      const bytes = dumpBytesWithEmptyTable();
      const snapshotPath = writeSnapshot(directory, bytes);
      const fixture = harness(database, {
        queryOverride: {
          includes: 'SELECT (SELECT COUNT(*) FROM "alpha")',
          results: [{ alpha: 2, beta: 2, empty: "0" }],
        },
      });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath, bytes),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("verification");
      expect(error.message).toContain(
        "snapshot restore readback row counts returned a malformed count",
      );
      expect(fixture.fileImports).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test.each([
    ["unknown kind", [{ kind: "unknown", n: 1 }]],
    ["missing kind", [{ n: 1 }]],
    ["zero group count", [{ kind: "index", n: 0 }]],
  ] as const)(
    "status refuses schema-object readback with %s instead of treating the target as empty",
    async (_label, results) => {
      const directory = caseDirectory("status-unknown-schema-object-kind");
      const database = emptyDatabase();
      try {
        const snapshotPath = writeSnapshot(directory);
        const fixture = harness(database, {
          queryOverride: {
            includes: "SELECT type AS kind, COUNT(*) AS n FROM sqlite_schema",
            results,
          },
        });
        const error = await rejected(
          runD1SnapshotRestore(
            declaration(snapshotPath),
            invocation("status"),
            restoreOptions(directory, fixture.run),
          ),
        );

        expect(error.phase).toBe("preflight");
        expect(error.message).toContain("snapshot restore target schema-object readback");
        expect(error.detail).toBeUndefined();
        expect(fixture.fileImports).toHaveLength(0);
      } finally {
        database.close();
      }
    },
  );

  test.each([
    ["missing row", []],
    ["multiple rows", [{ n: 0 }, { n: 0 }]],
    ["unexpected alias", [{ n: 0, extra: 0 }]],
    ["out-of-domain count", [{ n: 2 }]],
    ["non-numeric count", [{ n: "0" }]],
  ] as const)(
    "status rejects migration-ledger presence readback with %s",
    async (_label, results) => {
      const directory = caseDirectory("status-malformed-ledger-presence");
      const database = emptyDatabase();
      try {
        const snapshotPath = writeSnapshot(directory);
        const fixture = harness(database, {
          queryOverride: {
            includes: "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'd1_migrations'",
            results,
          },
        });
        const error = await rejected(
          runD1SnapshotRestore(
            declaration(snapshotPath),
            invocation("status"),
            restoreOptions(directory, fixture.run),
          ),
        );

        expect(error.phase).toBe("preflight");
        expect(error.message).toContain("snapshot restore target migration ledger");
        expect(error.detail).toBeUndefined();
        expect(fixture.fileImports).toHaveLength(0);
      } finally {
        database.close();
      }
    },
  );

  test("status preserves valid absent and empty migration ledgers as empty targets", async () => {
    const directory = caseDirectory("status-empty-ledger");
    const database = emptyDatabase();
    try {
      database.exec(
        'CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);',
      );
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database);
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath),
        invocation("status"),
        restoreOptions(directory, fixture.run),
      );

      expect(result).toMatchObject({
        targetTables: 0,
        targetMigrationRows: 0,
        currentSnapshotExpectationMatch: null,
        readyForApply: true,
      });
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test.each([
    ["missing row", []],
    ["multiple rows", [{ n: 0 }, { n: 0 }]],
    ["unexpected alias", [{ n: 0, extra: 0 }]],
    ["negative count", [{ n: -1 }]],
    ["noninteger count", [{ n: 0.5 }]],
    ["non-numeric count", [{ n: "0" }]],
  ] as const)("status rejects migration-row count readback with %s", async (_label, results) => {
    const directory = caseDirectory("status-malformed-ledger-rows");
    const database = emptyDatabase();
    try {
      database.exec(
        'CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);',
      );
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database, {
        queryOverride: {
          includes: "SELECT COUNT(*) AS n FROM d1_migrations",
          results,
        },
      });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("status"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("snapshot restore target migration rows");
      expect(error.detail).toBeUndefined();
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("status rejects migration lineage rows that do not agree with the exact ledger count", async () => {
    const directory = caseDirectory("status-malformed-ledger-lineage");
    const database = emptyDatabase();
    try {
      database.exec(
        'CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);' +
          "INSERT INTO d1_migrations VALUES (1, '0001_alpha.sql', 'now');",
      );
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database, {
        queryOverride: {
          includes: "SELECT name FROM d1_migrations ORDER BY id",
          results: [],
        },
      });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("status"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("migration lineage count does not match");
      expect(error.detail).toBeUndefined();
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test.each([
    ["extra user-table field", [{ name: "alpha", extra: "value" }]],
    ["duplicate user-table name", [{ name: "alpha" }, { name: "alpha" }]],
  ] as const)(
    "status rejects %s instead of accepting malformed target tables",
    async (_label, results) => {
      const directory = caseDirectory("status-malformed-user-tables");
      const database = emptyDatabase();
      try {
        const snapshotPath = writeSnapshot(directory);
        const fixture = harness(database, {
          queryOverride: {
            includes: "SELECT name FROM sqlite_schema WHERE type = 'table'",
            results,
          },
        });
        const error = await rejected(
          runD1SnapshotRestore(
            declaration(snapshotPath),
            invocation("status"),
            restoreOptions(directory, fixture.run),
          ),
        );

        expect(error.phase).toBe("preflight");
        expect(error.message).toContain("snapshot restore target tables");
        expect(error.detail).toBeUndefined();
        expect(fixture.fileImports).toHaveLength(0);
      } finally {
        database.close();
      }
    },
  );

  test("status treats every foreign-key result row as a violation without returning row details", async () => {
    const directory = caseDirectory("status-foreign-key-row");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      database.exec(normalizeSnapshotDump(dumpBytes()).sql);
      const fixture = harness(database, {
        queryOverride: {
          includes: "PRAGMA foreign_key_check",
          results: [{ privateRowDetail: "never returned" }],
        },
      });
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath),
        invocation("status"),
        restoreOptions(directory, fixture.run),
      );

      expect(result).toMatchObject({
        currentSnapshotExpectationMatch: false,
        currentSnapshotExpectationMismatches: ["foreign key violations: 1"],
      });
      expect(JSON.stringify(result)).not.toContain("privateRowDetail");
      expect(JSON.stringify(result)).not.toContain("never returned");
    } finally {
      database.close();
    }
  });

  test.each([
    [
      "COUNT",
      "throw",
      'SELECT (SELECT COUNT(*) FROM "alpha")',
      [{ alpha: 2, beta: 2, empty: "0" }],
    ],
    [
      "COUNT",
      "nonzero",
      'SELECT (SELECT COUNT(*) FROM "alpha")',
      [{ alpha: 2, beta: 2, empty: "0" }],
    ],
    [
      "schema",
      "throw",
      "SELECT type AS kind, COUNT(*) AS n FROM sqlite_schema",
      [{ kind: "other", n: 1 }],
    ],
    [
      "schema",
      "nonzero",
      "SELECT type AS kind, COUNT(*) AS n FROM sqlite_schema",
      [{ kind: "other", n: 1 }],
    ],
    [
      "ledger",
      "throw",
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'd1_migrations'",
      [{ n: 2 }],
    ],
    [
      "ledger",
      "nonzero",
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'd1_migrations'",
      [{ n: 2 }],
    ],
  ] as const)(
    "unknown or nonzero import acknowledgement dominates malformed %s readback",
    async (_shape, acknowledgement, includes, results) => {
      const directory = caseDirectory("apply-unknown-ack-malformed-readback");
      const database = emptyDatabase();
      try {
        const bytes = dumpBytesWithEmptyTable();
        const snapshotPath = writeSnapshot(directory, bytes);
        const fixture = harness(database, {
          ...(acknowledgement === "throw" ? { throwImport: true } : { exitCode: 1 }),
          queryOverride: { includes, results, afterImport: true },
        });
        const error = await rejected(
          runD1SnapshotRestore(
            declaration(snapshotPath, bytes),
            invocation("apply"),
            restoreOptions(directory, fixture.run),
          ),
        );

        expect(error.phase).toBe("mutation");
        expect(error.message).toContain("acknowledgement/readback is indeterminate");
        expect(fixture.fileImports).toHaveLength(1);
        expect(fixture.calls.filter((command) => command.includes("--file"))).toHaveLength(1);
      } finally {
        database.close();
      }
    },
  );

  test("apply preserves verification failure for a malformed ledger after successful acknowledgement", async () => {
    const directory = caseDirectory("apply-malformed-ledger-readback");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database, {
        queryOverride: {
          includes: "SELECT COUNT(*) AS n FROM d1_migrations",
          results: [{ n: "2" }],
          afterImport: true,
        },
      });
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("verification");
      expect(error.message).toContain("snapshot restore target migration rows");
      expect(fixture.fileImports).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test("fresh status compares an import after its accepted acknowledgement lost readback without replay", async () => {
    const directory = caseDirectory("status-after-lost-readback");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const failedApplyReadback = harness(database, {
        failQuery:
          'SELECT (SELECT COUNT(*) FROM "alpha") AS "alpha", (SELECT COUNT(*) FROM "beta") AS "beta"',
      });
      const applyError = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, failedApplyReadback.run),
        ),
      );

      expect(applyError.phase).toBe("mutation");
      expect(applyError.message).toContain("acknowledgement/readback is indeterminate");
      expect(failedApplyReadback.fileImports).toHaveLength(1);

      const freshStatusInvocation = invocation("status");
      const statusRun = harness(database);
      const result = await runD1SnapshotRestore(
        declaration(snapshotPath),
        freshStatusInvocation,
        restoreOptions(directory, statusRun.run, {
          outputDirectory: join(directory, "status-output"),
        }),
      );

      expect(result).toMatchObject({
        currentSnapshotExpectationMatch: true,
        currentSnapshotExpectationMismatches: [],
        readyForApply: false,
      });
      expect(statusRun.fileImports).toHaveLength(0);
      expect(failedApplyReadback.fileImports).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test("apply still refuses a nonempty target even when its structure matches the snapshot", async () => {
    const directory = caseDirectory("apply-matching-target");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      database.exec(normalizeSnapshotDump(dumpBytes()).sql);
      const fixture = harness(database);
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("never resets or overwrites a D1");
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test.each([
    [
      "a declaration that is not a rehearsal-generation D1",
      { databaseName: "takoserver-runtime-ga-20260820" },
      "rehearsal-generation",
    ],
    [
      "a declaration naming another environment",
      { environment: "production" },
      "rehearsal-generation",
    ],
    [
      "a declaration without a sha256 pin",
      { snapshotSha256: "sha256:not-a-digest" },
      "rehearsal-generation",
    ],
  ])("refuses %s before any provider access", async (_label, overrides, message) => {
    const directory = caseDirectory("declaration");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database);
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(
            snapshotPath,
            dumpBytes(),
            overrides as Partial<D1SnapshotRestoreDeclaration>,
          ),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain(message);
      expect(fixture.calls).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("refuses a snapshot whose bytes do not match the declared digest", async () => {
    const directory = caseDirectory("digest");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database);
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath, Buffer.from("SELECT 1;", "utf8")),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("do not match the declared sha256");
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("refuses a snapshot file that is readable by group or others", async () => {
    const directory = caseDirectory("mode");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      chmodSync(snapshotPath, 0o644);
      const fixture = harness(database);
      const error = await rejected(
        runD1SnapshotRestore(
          declaration(snapshotPath),
          invocation("apply"),
          restoreOptions(directory, fixture.run),
        ),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("no group or other access");
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test("requires an explicit API token", async () => {
    const directory = caseDirectory("token");
    const database = emptyDatabase();
    try {
      const snapshotPath = writeSnapshot(directory);
      const fixture = harness(database);
      const error = await rejected(
        runD1SnapshotRestore(declaration(snapshotPath), invocation("apply"), {
          ...restoreOptions(directory, fixture.run),
          cloudflareEnvironment: {},
        }),
      );

      expect(error.phase).toBe("preflight");
      expect(error.message).toContain("CLOUDFLARE_API_TOKEN");
      expect(fixture.fileImports).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});
