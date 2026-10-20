import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import {
  buildFreshPreservedRealmClaim,
  freshMoneyWriterEpochSql,
  mintFreshMoneyWriterEpoch,
  verifyFreshMoneyWriterEpoch,
} from "../scripts/deploy/money-fresh-writer-epoch.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
} from "../src/money-cutover-sql.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

const files = readMigrationArtifact(resolve(import.meta.dir, "../migrations")).files;
const plainSql = buildD1MigrationImport(files.slice(0, 100), { freshLedger: true }).sql;
// A stand-in for the preserved replay's extra objects: the three money_cutover tables.
const preservedSql = `${plainSql}\n${MONEY_CUTOVER_FREEZE_DDL};\n${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};\n${MONEY_CUTOVER_PERMIT_DDL};\n`;

const binding = {
  accountId: "0123456789abcdef0123456789abcdef",
  databaseId: "01234567-89ab-cdef-0123-456789abcdef",
  databaseName: "integration-ts-fedcba9876543210fedcba9876543210",
  generation: "fedcba9876543210fedcba9876543210",
};

function run(database: Database, sql: string): void {
  for (const statement of frameHostMigrationSql(sql)) database.query(statement).all();
}

describe("fresh Money Writer epoch", () => {
  test("every mint is a new epoch that verifies only for its own D1", () => {
    const first = mintFreshMoneyWriterEpoch(binding);
    const second = mintFreshMoneyWriterEpoch(binding);
    expect(first.epoch).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(second.epoch).not.toBe(first.epoch);
    expect(second.bindingDigest).toBe(first.bindingDigest);
    verifyFreshMoneyWriterEpoch(first, { binding, epoch: first.epoch });
    expect(() => verifyFreshMoneyWriterEpoch(first, { binding, epoch: second.epoch })).toThrow();
    expect(() =>
      verifyFreshMoneyWriterEpoch(first, {
        binding: { ...binding, databaseId: "11234567-89ab-cdef-0123-456789abcdef" },
        epoch: first.epoch,
      }),
    ).toThrow();
    expect(() =>
      verifyFreshMoneyWriterEpoch(
        { ...first, nonce: second.nonce },
        { binding, epoch: first.epoch },
      ),
    ).toThrow();
  });

  test("production, foreign-generation and open bindings are refused", () => {
    for (const bad of [
      { ...binding, databaseName: "takoserver-p-fedcba9876543210fedcba9876543210" },
      { ...binding, databaseName: "takoserver-runtime" },
      { ...binding, databaseName: "integration-ts-00000000000000000000000000000000" },
      { ...binding, accountId: "not-an-account" },
      { ...binding, extra: 1 },
    ])
      expect(() => mintFreshMoneyWriterEpoch(bad)).toThrow();
  });

  test("readback must hold exactly the minted epoch", () => {
    const record = mintFreshMoneyWriterEpoch(binding);
    const row = { singleton: 1, writer_epoch: record.epoch };
    verifyFreshMoneyWriterEpoch(record, { binding, epoch: record.epoch, readbackRows: [row] });
    for (const rows of [[], [row, row], [{ ...row, writer_epoch: `sha256:${"0".repeat(64)}` }]])
      expect(() =>
        verifyFreshMoneyWriterEpoch(record, { binding, epoch: record.epoch, readbackRows: rows }),
      ).toThrow();
  });
});

describe("fresh preserved realm claim", () => {
  test("claims test over the preserved inventory, then binds the epoch after it", () => {
    const claim = buildFreshPreservedRealmClaim(preservedSql);
    const plainCount = (() => {
      const database = new Database(":memory:");
      try {
        run(database, plainSql);
        return (
          database
            .query(
              "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name LIKE 'money_cutover_%'",
            )
            .get() as { n: number }
        ).n;
      } finally {
        database.close();
      }
    })();
    expect(claim.historyTables).toContain("money_cutover_authorized_epoch");
    expect(claim.historyTables).toContain("money_cutover_freeze");
    expect(claim.historyTables).toContain("money_cutover_writer_permit");
    expect(plainCount).toBe(
      claim.historyTables.filter((t) => t.startsWith("money_cutover_")).length - 3,
    );

    const record = mintFreshMoneyWriterEpoch(binding);
    const database = new Database(":memory:");
    try {
      run(database, `${preservedSql}\n${claim.sql}\n${freshMoneyWriterEpochSql(record)}`);
      expect(database.query("SELECT singleton, mode FROM stripe_mode_realm").all()).toEqual([
        { singleton: 1, mode: "test" },
      ]);
      verifyFreshMoneyWriterEpoch(record, {
        binding,
        epoch: record.epoch,
        readbackRows: database
          .query("SELECT singleton, writer_epoch FROM money_cutover_authorized_epoch")
          .all() as Record<string, unknown>[],
      });
    } finally {
      database.close();
    }
  });

  test("the plain inventory is refused, and an epoch before the claim fails the import", () => {
    expect(() => buildFreshPreservedRealmClaim(plainSql)).toThrow();
    const claim = buildFreshPreservedRealmClaim(preservedSql);
    const record = mintFreshMoneyWriterEpoch(binding);
    const database = new Database(":memory:");
    try {
      run(database, preservedSql);
      run(database, freshMoneyWriterEpochSql(record));
      expect(() => run(database, claim.sql)).toThrow();
      expect(database.query("SELECT count(*) AS n FROM stripe_mode_realm").get()).toEqual({ n: 0 });
    } finally {
      database.close();
    }
  });
});
