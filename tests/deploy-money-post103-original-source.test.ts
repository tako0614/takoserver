import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import {
  buildMoneyOriginalPreserved100ImportData,
  moneyFenceInstallSql,
  moneyPost94GuardDefinitions,
  moneyPost100ExpectedPreservedShape,
  moneyPost103ExpectedPreservedShape,
  moneyPost103OriginalFreezeReleaseSql,
  readMoneyOriginalPreservedSourceInventory,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "money-post103-original-source-"));
const repository = resolve(import.meta.dir, "..");
mkdirSync(join(fixtureRoot, "migrations"));
mkdirSync(join(fixtureRoot, "src"));
copyFileSync(
  join(repository, "src", "auth103-source-clock.ts"),
  join(fixtureRoot, "src", "auth103-source-clock.ts"),
);
for (const file of readMigrationArtifact(join(repository, "migrations")).files.slice(0, 100))
  copyFileSync(file.path, join(fixtureRoot, "migrations", file.name));
const sourceDirectory = join(fixtureRoot, "migrations");
const selected100 = readMoneyOriginalPreservedSourceInventory(sourceDirectory, 100, fixtureRoot);
const selected103 = readMoneyOriginalPreservedSourceInventory(sourceDirectory, 103, fixtureRoot);
const source = selected103.files;
afterAll(() => {
  selected100.dispose();
  selected103.dispose();
  rmSync(fixtureRoot, { recursive: true, force: true });
});
const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const original = {
  freezeBindingDigest: sha("1"),
  originDigest: sha("2"),
  original92BackupDigest: sha("3"),
  originalWriterDigest: sha("4"),
  currentWriterEpoch: sha("5"),
};

test("source replay preserves the exact Money objects through canonical Auth103", () => {
  expect(source.length).toBe(103);
  const before = JSON.parse(moneyPost100ExpectedPreservedShape(selected100.files)) as {
    name: string;
  }[];
  const after = JSON.parse(moneyPost103ExpectedPreservedShape(source)) as { name: string }[];
  const names = (rows: { name: string }[]) => new Set(rows.map((row) => row.name));
  const beforeNames = names(before);
  const afterNames = names(after);
  for (const name of [
    "money_cutover_freeze",
    "money_cutover_authorized_epoch",
    "money_cutover_writer_permit",
    "money_cutover_permit_epoch_guard",
  ]) {
    expect(beforeNames.has(name)).toBe(true);
    expect(afterNames.has(name)).toBe(true);
  }
  expect(after.length).toBeGreaterThan(before.length);
});

test("the original readers synthesize canonical103 from an audited physical100 checkout", () => {
  expect(readMigrationArtifact(sourceDirectory).files).toHaveLength(100);
  expect(selected100.files).toHaveLength(100);
  expect(selected103.files).toHaveLength(103);
  selected100.assertCurrent();
  selected103.assertCurrent();
});

test("synthesized103 source identity fails closed when the physical prefix changes", () => {
  const predecessor = selected100.files[90];
  if (predecessor === undefined) throw new Error("the fixture requires the audited0091 source");
  const bytes = readFileSync(predecessor.path);
  try {
    writeFileSync(predecessor.path, "foreign predecessor\n");
    expect(() => selected103.assertCurrent()).toThrow();
  } finally {
    writeFileSync(predecessor.path, bytes);
  }
  selected103.assertCurrent();
});

test("a physical103 successor must be exact, complete, and the only extension", () => {
  const successors = source.slice(100).map((file) => ({
    name: file.name,
    sourcePath: file.path,
    physicalPath: join(sourceDirectory, file.name),
  }));
  const third = successors.at(2);
  if (third === undefined) throw new Error("the fixture requires three Auth103 successors");
  try {
    for (const successor of successors) copyFileSync(successor.sourcePath, successor.physicalPath);
    const exact = readMoneyOriginalPreservedSourceInventory(sourceDirectory, 103, fixtureRoot);
    try {
      expect(exact.files).toHaveLength(103);
      exact.assertCurrent();
    } finally {
      exact.dispose();
    }
    writeFileSync(third.physicalPath, "foreign Auth103 successor\n");
    expect(() =>
      readMoneyOriginalPreservedSourceInventory(sourceDirectory, 100, fixtureRoot),
    ).toThrow();
    expect(() =>
      readMoneyOriginalPreservedSourceInventory(sourceDirectory, 103, fixtureRoot),
    ).toThrow();
    rmSync(third.physicalPath);
    expect(() =>
      readMoneyOriginalPreservedSourceInventory(sourceDirectory, 100, fixtureRoot),
    ).toThrow();
    expect(() =>
      readMoneyOriginalPreservedSourceInventory(sourceDirectory, 103, fixtureRoot),
    ).toThrow();
    copyFileSync(third.sourcePath, third.physicalPath);
    writeFileSync(join(sourceDirectory, "0104_foreign.sql"), "SELECT 1;\n");
    expect(() =>
      readMoneyOriginalPreservedSourceInventory(sourceDirectory, 100, fixtureRoot),
    ).toThrow();
    expect(() =>
      readMoneyOriginalPreservedSourceInventory(sourceDirectory, 103, fixtureRoot),
    ).toThrow();
  } finally {
    for (const successor of successors) rmSync(successor.physicalPath, { force: true });
    rmSync(join(sourceDirectory, "0104_foreign.sql"), { force: true });
  }
});

function databaseWithOriginalFreeze(
  overrides: {
    readonly originDigest?: string;
    readonly currentWriterEpoch?: string;
    readonly missingMigration?: boolean;
  } = {},
): Database {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL)");
  database.exec(`${MONEY_CUTOVER_FREEZE_DDL};`);
  database.exec(`${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};`);
  database.exec(`${MONEY_CUTOVER_PERMIT_DDL};`);
  const insert = database.prepare("INSERT INTO d1_migrations (id,name) VALUES (?,?)");
  for (const [index, file] of source.entries()) {
    if (overrides.missingMigration && index === 101) continue;
    insert.run(index + 1, file.name);
  }
  database
    .prepare("INSERT INTO money_cutover_authorized_epoch (singleton,writer_epoch) VALUES (1,?)")
    .run(overrides.currentWriterEpoch ?? original.currentWriterEpoch);
  database
    .prepare(
      "INSERT INTO money_cutover_freeze (singleton,binding_digest,origin_digest,backup_digest,writer_digest,source_digest) VALUES (1,?,?,?,?,?)",
    )
    .run(
      original.freezeBindingDigest,
      overrides.originDigest ?? original.originDigest,
      original.original92BackupDigest,
      original.originalWriterDigest,
      "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2",
    );
  return database;
}

test("post103 thaw deletes exactly the original freeze once, and refuses drift", () => {
  const sql = moneyPost103OriginalFreezeReleaseSql({ files: source, ...original });
  const selected = databaseWithOriginalFreeze();
  try {
    expect(selected.query(sql).all()).toHaveLength(1);
    expect(selected.query(sql).all()).toHaveLength(0);
    expect(selected.query("SELECT * FROM money_cutover_freeze").all()).toHaveLength(0);
  } finally {
    selected.close();
  }
  for (const drift of [
    { originDigest: sha("6") },
    { currentWriterEpoch: sha("6") },
    { missingMigration: true },
  ]) {
    const database = databaseWithOriginalFreeze(drift);
    try {
      expect(database.query(sql).all()).toHaveLength(0);
      expect(database.query("SELECT * FROM money_cutover_freeze").all()).toHaveLength(1);
    } finally {
      database.close();
    }
  }
});

function preserved98Fixture(
  drift: {
    readonly mode?: "test" | "live";
    readonly freezeOrigin?: string;
    readonly writerEpoch?: string;
    readonly signingKey?: string;
    readonly extraTable?: boolean;
    readonly partialLedger?: boolean;
  } = {},
): Database {
  const database = new Database(":memory:", { strict: true });
  const step = (sql: string) => {
    try {
      database.exec(sql);
    } catch {
      throw new Error("preserved98 local source replay failed");
    }
  };
  for (const sql of frameHostMigrationSql(
    buildD1MigrationImport(selected100.files.slice(0, 94), { freshLedger: true }).sql,
  ))
    step(sql);
  for (const sql of frameHostMigrationSql(
    `${MONEY_CUTOVER_FREEZE_DDL};${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};
    ${MONEY_CUTOVER_PERMIT_DDL};${MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL};
    ${moneyFenceInstallSql("0094-fenced")}`,
  ))
    step(sql);
  for (const sql of frameHostMigrationSql(
    buildD1MigrationImport(selected100.files.slice(94, 98), { freshLedger: false }).sql,
  ))
    step(sql);
  for (const [name, sql] of moneyPost94GuardDefinitions()) {
    const present = database.query("SELECT 1 FROM sqlite_schema WHERE name=?").get(name);
    if (present === null) step(sql);
  }
  database
    .prepare(
      "INSERT INTO money_cutover_freeze (singleton,binding_digest,origin_digest,backup_digest,writer_digest,source_digest) VALUES (1,?,?,?,?,?)",
    )
    .run(
      original.freezeBindingDigest,
      drift.freezeOrigin ?? original.originDigest,
      original.original92BackupDigest,
      original.originalWriterDigest,
      "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2",
    );
  database
    .prepare("INSERT INTO money_cutover_authorized_epoch (singleton,writer_epoch) VALUES (1,?)")
    .run(drift.writerEpoch ?? original.currentWriterEpoch);
  database
    .prepare("INSERT INTO stripe_mode_realm (singleton,mode,pinned_at) VALUES (1,?,?)")
    .run(drift.mode ?? "test", "2020-01-01T00:00:00.000Z");
  database
    .prepare(
      "INSERT INTO runtime_grant_keys (key_id,public_jwk,created_at_epoch_seconds,revoked_at_epoch_seconds) VALUES (?,?,?,NULL)",
    )
    .run(
      drift.signingKey ?? "original-key",
      '{"crv":"Ed25519","kty":"OKP","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
      1,
    );
  if (drift.extraTable) database.exec("CREATE TABLE foreign_extra (id INTEGER)");
  if (drift.partialLedger) database.exec("DELETE FROM d1_migrations WHERE id = 98");
  return database;
}

test("actual physical100 source composes one guarded 98→100 batch and retains Money invariants", () => {
  const prepared = buildMoneyOriginalPreserved100ImportData({
    sourceDirectory,
    scratchBase: fixtureRoot,
    freezeBindingDigest: original.freezeBindingDigest,
    originDigest: original.originDigest,
    original92BackupDigest: original.original92BackupDigest,
    writerDigest: original.originalWriterDigest,
    nextWriterEpoch: original.currentWriterEpoch,
    signingKeyId: "original-key",
    signingPublicJwk:
      '{"crv":"Ed25519","kty":"OKP","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
    signingCreatedAtEpochSeconds: 1,
  });
  expect(prepared.names).toHaveLength(100);
  const firstGuard = frameHostMigrationSql(prepared.sql)[0];
  if (firstGuard === undefined) throw new Error("preserved100 source lacks its first guard");
  const database = preserved98Fixture();
  try {
    for (const sql of frameHostMigrationSql(prepared.sql)) {
      try {
        database.query(sql).all();
      } catch {
        throw new Error("preserved100 local guarded batch rejected source");
      }
    }
    expect(
      (database.query("SELECT COUNT(*) AS n FROM d1_migrations").get() as { n: number }).n,
    ).toBe(100);
    expect(
      (database.query("SELECT COUNT(*) AS n FROM money_cutover_freeze").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (
        database.query("SELECT COUNT(*) AS n FROM money_cutover_writer_permit").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(() => database.query(firstGuard).all()).toThrow();
  } finally {
    database.close();
  }
  for (const drift of [
    { mode: "live" as const },
    { freezeOrigin: sha("6") },
    { writerEpoch: sha("7") },
    { signingKey: "foreign-key" },
    { extraTable: true },
    { partialLedger: true },
  ]) {
    const foreign = preserved98Fixture(drift);
    try {
      const before = (
        foreign.query("SELECT COUNT(*) AS n FROM d1_migrations").get() as { n: number }
      ).n;
      expect(() => foreign.query(firstGuard).all()).toThrow();
      expect(
        (foreign.query("SELECT COUNT(*) AS n FROM d1_migrations").get() as { n: number }).n,
      ).toBe(before);
    } finally {
      foreign.close();
    }
  }
}, 30_000);

test("0100 parser selects only the original integration schema route", () => {
  const command = (
    environment: "integration" | "production",
    action: "status" | "apply" = "status",
  ) =>
    spawnSync(
      process.execPath,
      [
        "scripts/deploy.ts",
        "takoserver-d1-schema",
        `--${action}`,
        `--environment=${environment}`,
        `--commit=${"a".repeat(40)}`,
        "--through-migration=0100",
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          TAKOSERVER_INTEGRATION_STORAGE_ORIGINAL_CREATE_INPUT_PATH: "",
        },
        encoding: "utf8",
      },
    );
  const selected = command("integration");
  expect(selected.status).toBe(2);
  expect(selected.stderr).toContain("money original100 requires canonical original-create custody");
  const apply = command("integration", "apply");
  expect(apply.status).toBe(2);
  expect(apply.stderr).toContain("money original100 requires canonical original-create custody");
  const rejected = command("production");
  expect(rejected.status).toBe(2);
  expect(rejected.stderr).toContain("no target was touched");
});
