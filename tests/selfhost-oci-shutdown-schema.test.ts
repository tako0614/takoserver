import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { v2FinalDeleteConfiguredUpdateSchemaFence } from "../src/takoform-v2/configured-private-inputs.ts";
import {
  additiveV2ConfiguredUpdateInputsDDL,
  v2ConfiguredUpdateDiscardTransition,
} from "../src/takoform-v2/configured-update-inputs-schema.ts";
import {
  inspectV2ContainerOwnerApplicationSuccessorSchema,
  inspectV2ContainerOwnerFinalDeleteSchema,
  inspectV2ContainerOwnerShutdownIoSchema,
  V2_CONTAINER_OWNER_ALLOCATION_EXPAND,
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND,
  V2_CONTAINER_OWNER_CONTROL_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import { writeMigrateSqliteFile } from "./helpers/migrated-database.ts";

const repo = resolve(import.meta.dir, "..");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function backupFixture(
  predecessor: "application-io" | "final-delete" | "shutdown" = "final-delete",
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "oci-shutdown-schema-"));
  fixtureRoots.push(root);
  const source = join(root, "original.sqlite");
  const output = join(root, "prepared.sqlite");
  writeMigrateSqliteFile(source);
  const database = new Database(source, { readwrite: true, create: false });
  try {
    const sql = createSqliteSql(database);
    await sql.batch(
      frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
    );
    await sql.batch(v2ContainerOwnerMigrationCandidate());
    for (const expand of [
      V2_CONTAINER_OWNER_CONTROL_EXPAND,
      V2_CONTAINER_OWNER_ALLOCATION_EXPAND,
      V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
    ]) {
      await sql.batch(expand.statements.map((sql) => ({ sql })));
    }
    if (predecessor !== "application-io")
      await sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    if (predecessor === "shutdown")
      await sql.batch(V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND.statements);
    expect(await inspectV2ContainerOwnerFinalDeleteSchema(sql)).toBe(
      predecessor === "final-delete",
    );
    expect(await inspectV2ContainerOwnerShutdownIoSchema(sql)).toBe(predecessor === "shutdown");
    database.exec("CREATE TABLE private_fixture_anchor (identity TEXT PRIMARY KEY) STRICT");
    database.query("INSERT INTO private_fixture_anchor VALUES (?)").run("fixture-preserved");
  } finally {
    database.close();
  }
  return { root, source, output };
}

type BackupFixture = Awaited<ReturnType<typeof backupFixture>>;

const schema = (database: Database) =>
  database
    .query<{ name: string; type: string; tbl_name: string; sql: string | null }, []>(
      "SELECT name, type, tbl_name, sql FROM main.sqlite_schema ORDER BY name",
    )
    .all();
const ledger = (database: Database) =>
  database
    .query<{ name: string; applied_at: string }, []>(
      "SELECT name, applied_at FROM applied_migrations ORDER BY name",
    )
    .all();

function prepare({ source, output }: BackupFixture, action = "prepare") {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "scripts/selfhost-oci-shutdown-schema.ts",
      action,
      source,
      output,
    ],
    { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
}

function directoryState(root: string) {
  return readdirSync(root)
    .sort()
    .map((name) => {
      const path = join(root, name);
      return [
        name,
        statSync(path).mode,
        Bun.CryptoHasher.hash("sha256", readFileSync(path), "hex"),
      ];
    });
}

function expectRefusal(fixture: BackupFixture) {
  const before = directoryState(fixture.root);
  const result = prepare(fixture);
  expect(result.exitCode).toBe(1);
  expect(directoryState(fixture.root)).toEqual(before);
}

test("prepares the shutdown witness in a separate copy of an exact stock backup", async () => {
  const fixture = await backupFixture();
  const original = new Database(fixture.source, { readonly: true });
  const before = (() => {
    try {
      return {
        schema: schema(original),
        ledger: ledger(original),
        userVersion: original.query("PRAGMA user_version").get(),
      };
    } finally {
      original.close();
    }
  })();
  expect(before.ledger.map(({ name }) => name)).toEqual(MIGRATIONS.map(({ name }) => name).sort());
  const originalBytes = readFileSync(fixture.source);
  const result = prepare(fixture);
  if (result.exitCode !== 0) throw new Error(`prepare failed: ${result.stderr.toString()}`);
  expect(readFileSync(fixture.source).equals(originalBytes)).toBe(true);
  expect(statSync(fixture.output).mode & 0o777).toBe(0o600);
  expect(readdirSync(fixture.root).sort()).toEqual(
    [basename(fixture.source), basename(fixture.output)].sort(),
  );

  const prepared = new Database(fixture.output, { readonly: true });
  try {
    expect(await inspectV2ContainerOwnerShutdownIoSchema(createSqliteSql(prepared))).toBe(true);
    const existingNames = new Set(before.schema.map(({ name }) => name));
    const after = schema(prepared);
    expect(after.filter(({ name }) => existingNames.has(name))).toEqual(before.schema);
    const added = after.filter(({ name }) => !existingNames.has(name));
    expect(added.filter(({ sql }) => sql !== null)).toHaveLength(4);
    expect(added.every(({ name }) => name.includes("shutdown_io_close"))).toBe(true);
    expect(ledger(prepared)).toEqual(before.ledger);
    expect(prepared.query("PRAGMA user_version").get()).toEqual(before.userVersion);
    expect(prepared.query("SELECT identity FROM private_fixture_anchor").get()).toEqual({
      identity: "fixture-preserved",
    });
    expect(
      prepared.query("SELECT count(*) AS count FROM tf_v2_container_shutdown_io_closes").get(),
    ).toEqual({ count: 0 });
  } finally {
    prepared.close();
  }
});

test("prepares the application-successor schema from an exact shutdown-evidence backup", async () => {
  const fixture = await backupFixture("shutdown");
  const before = directoryState(fixture.root);
  const result = prepare(fixture, "prepare-successor");
  if (result.exitCode !== 0) throw new Error(`prepare failed: ${result.stderr.toString()}`);
  expect(
    directoryState(fixture.root).filter(([name]) => name !== basename(fixture.output)),
  ).toEqual(before);
  expect(statSync(fixture.output).mode & 0o777).toBe(0o600);

  const original = new Database(fixture.source, { readonly: true });
  const prepared = new Database(fixture.output, { readonly: true });
  try {
    expect(await inspectV2ContainerOwnerApplicationSuccessorSchema(createSqliteSql(prepared))).toBe(
      true,
    );
    const final = v2FinalDeleteConfiguredUpdateSchemaFence();
    expect(
      await createSqliteSql(prepared).query(`SELECT ${final.sql} AS ready`, final.params),
    ).toEqual([{ ready: 1 }]);
    expect(ledger(prepared)).toEqual(ledger(original));
    expect(prepared.query("SELECT identity FROM private_fixture_anchor").get()).toEqual({
      identity: "fixture-preserved",
    });
  } finally {
    original.close();
    prepared.close();
  }
});

for (const gate of ["missing", "legacy"] as const) {
  test(`completes an earlier application-successor backup with a ${gate} discard gate`, async () => {
    const fixture = await backupFixture("shutdown");
    const old = new Database(fixture.source, { readwrite: true, create: false });
    try {
      const sql = createSqliteSql(old);
      await sql.batch(V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.statements);
      if (gate === "legacy") await sql.batch(v2ConfiguredUpdateDiscardTransition());
    } finally {
      old.close();
    }
    const before = directoryState(fixture.root);
    expect(prepare(fixture, "prepare-successor").exitCode).toBe(0);
    expect(
      directoryState(fixture.root).filter(([name]) => name !== basename(fixture.output)),
    ).toEqual(before);
    const ready = new Database(fixture.output, { readonly: true, create: false });
    try {
      const final = v2FinalDeleteConfiguredUpdateSchemaFence();
      expect(
        await createSqliteSql(ready).query(`SELECT ${final.sql} AS ready`, final.params),
      ).toEqual([{ ready: 1 }]);
    } finally {
      ready.close();
    }
  });
}

test("successor preparation refuses earlier or already expanded backups and existing outputs", async () => {
  const earlier = await backupFixture();
  const earlierBefore = directoryState(earlier.root);
  const refusal = prepare(earlier, "prepare-successor");
  expect(refusal.exitCode).toBe(1);
  expect(refusal.stderr.toString()).toContain(
    "exact Container shutdown evidence or incomplete application successor schema",
  );
  expect(directoryState(earlier.root)).toEqual(earlierBefore);

  const fixture = await backupFixture("shutdown");
  expect(prepare(fixture, "prepare-successor").exitCode).toBe(0);
  const bothCopies = directoryState(fixture.root);
  expect(prepare(fixture, "prepare-successor").exitCode).toBe(1);
  expect(
    prepare(
      { ...fixture, source: fixture.output, output: join(fixture.root, "second.sqlite") },
      "prepare-successor",
    ).exitCode,
  ).toBe(1);
  expect(directoryState(fixture.root)).toEqual(bothCopies);
});

test("refuses a backup missing the exact final-delete predecessor", async () => {
  const fixture = await backupFixture("application-io");
  expectRefusal(fixture);
});

test("refuses a substituted stock migration even with the complete ledger count", async () => {
  const fixture = await backupFixture();
  const database = new Database(fixture.source, { readwrite: true, create: false });
  try {
    database
      .query("UPDATE applied_migrations SET name = ? WHERE name = ?")
      .run("fixture-substitute.sql", MIGRATIONS[0]?.name ?? "");
    expect(ledger(database)).toHaveLength(MIGRATIONS.length);
    expect(ledger(database).some(({ name }) => name === "fixture-substitute.sql")).toBe(true);
  } finally {
    database.close();
  }
  expectRefusal(fixture);
});

test("refuses an existing output without replacing its bytes", async () => {
  const fixture = await backupFixture();
  writeFileSync(fixture.output, "existing-output-fixture", { mode: 0o600, flag: "wx" });
  expectRefusal(fixture);
});

for (const suffix of ["-wal", "-shm", "-journal"]) {
  test(`refuses a source with a ${suffix} sidecar without removing it`, async () => {
    const fixture = await backupFixture();
    writeFileSync(`${fixture.source}${suffix}`, "source-sidecar-fixture", {
      mode: 0o600,
      flag: "wx",
    });
    expectRefusal(fixture);
  });
}
