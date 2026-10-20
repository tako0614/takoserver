import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  buildMoneyCutoverImportSql,
  buildMoneyPost94RootImportData,
  type MoneyUnitCutoverOptions,
  moneyUnitCutoverSchemaMatches,
  moneyUnitCutoverSourcePrefixDigest,
  runIntegrationMoneyUnitCutover,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

import {
  converted94CaptureFixture,
  files,
  fixture,
  legacyMoneyStagingTarget,
  marker,
  opaqueValue,
  sha,
  sql,
  state,
  writerEpoch,
} from "./helpers/money-unit-cutover-fixtures.ts";

describe("separate converted94 historical backup producer", () => {
  test("one exact export preserves original92 and seals separate94 with its old epoch and convert history", async () => {
    const f = await converted94CaptureFixture();
    try {
      const original = readFileSync(f.options.backupPath);
      const originalIdentity = readFileSync(`${f.options.backupPath}.identity.json`);
      const result = await f.capture();
      expect(result.qualification).toBe("component-simulation-only");
      expect(result.schemaPhase).toBe("0094-fenced");
      expect(result.historicalWriterEpoch).toBe(writerEpoch);
      const convert = f.receipts.get("convert");
      if (convert === undefined) throw new Error("actual fixture terminal convert missing");
      expect(result.convertBindingDigest).toBe(convert.bindingDigest);
      expect(result.sourceDigest).toBe(moneyUnitCutoverSourcePrefixDigest(files, 94));
      expect(result.tableInventory).toEqual(Object.keys(result.rowCounts).sort());
      const identity = JSON.parse(readFileSync(`${f.convertedBackupPath}.identity.json`, "utf8"));
      expect(identity.kind).toBe("takoserver.money-protected-backup@v2");
      expect(identity.writerEpoch).toBe(writerEpoch);
      expect(identity.convertBindingDigest).toBe(result.convertBindingDigest);
      expect(sha(readFileSync(f.convertedBackupPath, "utf8"))).toBe(result.backupDigest);
      expect(sha(readFileSync(`${f.convertedBackupPath}.capture.json`, "utf8"))).toBe(
        result.captureDigest,
      );
      expect(sha(readFileSync(`${f.convertedBackupPath}.capture.complete.json`, "utf8"))).toBe(
        result.completionDigest,
      );
      expect(readFileSync(f.options.backupPath)).toEqual(original);
      expect(readFileSync(`${f.options.backupPath}.identity.json`)).toEqual(originalIdentity);
      expect(f.exports()).toBe(1);
      expect(f.mutations()).toBe(0);
      expect("nextWriterEpoch" in result).toBe(false);
    } finally {
      f.close();
    }
  });

  test("a complete exact historical capture reopens without another export or custody write", async () => {
    const f = await converted94CaptureFixture();
    try {
      const first = await f.capture();
      const paths = [
        f.convertedBackupPath,
        `${f.convertedBackupPath}.identity.json`,
        `${f.convertedBackupPath}.capture.json`,
        `${f.convertedBackupPath}.capture.complete.json`,
      ];
      const before = paths.map((p) => readFileSync(p));
      const queries = f.commands();
      expect(await f.capture()).toEqual(first);
      expect(paths.map((p) => readFileSync(p))).toEqual(before);
      expect(f.commands()).toBeGreaterThan(queries);
      expect(f.exports()).toBe(1);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("partial or orphan local capture is unknown and refuses before any export or native query", async () => {
    for (const suffix of [".capture.json", ".identity.json", "", ".capture.complete.json"]) {
      const f = await converted94CaptureFixture();
      try {
        const bytes = "retained partial evidence";
        writeFileSync(`${f.convertedBackupPath}${suffix}`, bytes, { mode: 0o600 });
        await expect(f.capture()).rejects.toThrow("partial or unknown");
        expect(readFileSync(`${f.convertedBackupPath}${suffix}`, "utf8")).toBe(bytes);
        expect(f.exports()).toBe(0);
        expect(f.commands()).toBe(0);
        expect(f.mutations()).toBe(0);
      } finally {
        f.close();
      }
    }
  });

  test("accepted-unknown export retains the exclusive reservation and cannot export again", async () => {
    const f = await converted94CaptureFixture();
    try {
      f.setExportHook(() => {
        throw new Error("synthetic acknowledged export response loss");
      });
      await expect(f.capture()).rejects.toThrow("acknowledged export response loss");
      expect(existsSync(`${f.convertedBackupPath}.capture.json`)).toBe(true);
      expect(existsSync(`${f.convertedBackupPath}.capture.complete.json`)).toBe(false);
      expect(f.exports()).toBe(1);
      await expect(f.capture()).rejects.toThrow("partial or unknown");
      expect(f.exports()).toBe(1);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("a real late SQLite schema drift retains pair evidence but never a successful completion", async () => {
    const f = await converted94CaptureFixture();
    try {
      f.setExportHook(() => {
        const changed = f.database
          .query("DELETE FROM d1_migrations WHERE name = ? RETURNING name")
          .all("0094_wallet_usd_micros.sql");
        expect(changed).toHaveLength(1);
      });
      await expect(f.capture()).rejects.toThrow("native fenced94");
      expect(existsSync(f.convertedBackupPath)).toBe(true);
      expect(existsSync(`${f.convertedBackupPath}.identity.json`)).toBe(true);
      expect(existsSync(`${f.convertedBackupPath}.capture.json`)).toBe(true);
      expect(existsSync(`${f.convertedBackupPath}.capture.complete.json`)).toBe(false);
      const retained = readFileSync(f.convertedBackupPath);
      await expect(f.capture()).rejects.toThrow("partial or unknown");
      expect(readFileSync(f.convertedBackupPath)).toEqual(retained);
      expect(f.exports()).toBe(1);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("missing or unknown terminal convert is refused before reserving or exporting", async () => {
    for (const unknown of [false, true]) {
      const f = await converted94CaptureFixture();
      try {
        const terminal = f.receipts.get("convert");
        if (terminal === undefined) throw new Error("missing actual fixture convert");
        if (unknown)
          f.receipts.set("convert", { ...terminal, state: "dispatched", postDigest: null });
        else f.receipts.delete("convert");
        await expect(f.capture()).rejects.toThrow();
        expect(existsSync(`${f.convertedBackupPath}.capture.json`)).toBe(false);
        expect(f.exports()).toBe(0);
        expect(f.mutations()).toBe(0);
      } finally {
        f.close();
      }
    }
  });

  test("current native maintenance drift is refused before capture rather than accepted from history", async () => {
    const f = await converted94CaptureFixture();
    try {
      let reads = 0;
      f.setWriter(async () =>
        ++reads === 1
          ? f.writer
          : { ...f.writer, versionId: "22222222-2222-4222-8222-222222222222" },
      );
      await expect(f.capture()).rejects.toThrow("maintenance changed");
      expect(reads).toBe(2);
      expect(existsSync(`${f.convertedBackupPath}.capture.json`)).toBe(false);
      expect(f.exports()).toBe(0);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("a complete pair cannot borrow another physical/path/convert reservation", async () => {
    const f = await converted94CaptureFixture();
    try {
      await f.capture();
      const path = `${f.convertedBackupPath}.capture.json`;
      const command = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(
        path,
        JSON.stringify({ ...command, convertBindingDigest: sha("foreign convert") }),
        { mode: 0o600 },
      );
      await expect(f.capture()).rejects.toThrow("capture command differs");
      expect(f.exports()).toBe(1);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
});

describe("converted94 retained nonregular custody", () => {
  test("a replaced regular record is refused before another export or a native query", async () => {
    const f = await converted94CaptureFixture();
    try {
      await f.capture();
      const path = `${f.convertedBackupPath}.capture.json`;
      rmSync(path);
      mkdirSync(path, { mode: 0o700 });
      const commands = f.commands();
      await expect(f.capture()).rejects.toThrow("owned link-free0600 files");
      expect(f.commands()).toBe(commands);
      expect(f.exports()).toBe(1);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
});

describe("fixed post94 Root import fragments remain DATA only", () => {
  const nextWriterEpoch = sha("next reviewed writer generation");
  const selected = () => ({
    files,
    freezeBindingDigest: marker,
    originDigest: marker,
    original92BackupDigest: marker,
    writerDigest: marker,
    previousWriterEpoch: writerEpoch,
    nextWriterEpoch,
  });
  const executeRootSql = (database: Database, source: string): void => {
    // Preserve complete trigger/literal bytes and fail on the FIRST statement.
    // A single Bun exec(script) may suppress an earlier statement's SQL error.
    for (const statement of frameHostMigrationSql(source)) database.exec(statement);
  };
  const applyRootSql = (database: Database, source: string): void => {
    database.transaction(() => executeRootSql(database, source))();
  };
  const converted = () => {
    const database = fixture();
    applyRootSql(database, sql("freeze"));
    applyRootSql(database, sql("prepare"));
    applyRootSql(
      database,
      sql("classify", [
        {
          org_id: "org-1",
          ref: "credit-1",
          original_kind: "direct",
          original_amount_minor: "7",
          original_expires_at: null,
          consumption_class: "free",
          evidence_ref: "review://credit-1",
          reviewed_at: "2026-01-01T00:00:00Z",
        },
      ]),
    );
    applyRootSql(database, sql("convert"));
    return database;
  };

  test("fixed suffix and guards preserve original freeze, then rotate exactly once", () => {
    const database = converted();
    try {
      const fragments = buildMoneyPost94RootImportData(selected());
      expect(fragments.qualification).toBe("data-only");
      expect(fragments.normalHostReady).toBe(false);
      expect(Object.isFrozen(fragments)).toBe(true);
      const oldShape = state(database).shapeDigest;
      database.exec("BEGIN TRANSACTION");
      executeRootSql(database, fragments.beforeFinancialSql);
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0098-fenced")).toBe(true);
      expect(state(database).shapeDigest).not.toBe(oldShape);
      expect(
        database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: writerEpoch });
      expect(
        database.query("SELECT binding_digest, source_digest FROM money_cutover_freeze").get(),
      ).toEqual({
        binding_digest: marker,
        source_digest: moneyUnitCutoverSourcePrefixDigest(files, 92),
      });
      // This isolated Root test deliberately inserts NO Financial pin SQL and
      // grants no import/native/serving authority to the fragments.
      executeRootSql(database, fragments.afterFinancialSql);
      expect(
        database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: nextWriterEpoch });
      expect(database.query("SELECT COUNT(*) AS n FROM money_cutover_writer_permit").get()).toEqual(
        { n: 0 },
      );
      let replayStatements = 0;
      expect(() => {
        for (const statement of frameHostMigrationSql(fragments.afterFinancialSql)) {
          replayStatements++;
          database.exec(statement);
        }
      }).toThrow();
      expect(replayStatements).toBe(1);
      expect(
        database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: nextWriterEpoch });
      const statements = frameHostMigrationSql(fragments.afterFinancialSql);
      const rotation = statements[1];
      const requiredChangedOne = statements[2];
      if (statements.length !== 4 || !rotation || !requiredChangedOne)
        throw new Error("missing exact Root rotation/adjacent changes1 statement");
      // This actual UPDATE matches zero old rows after the positive rotation.
      // Its immediately following original SQL guard MUST abort, not no-op.
      expect(database.exec(rotation).changes).toBe(0);
      expect(() => database.exec(requiredChangedOne)).toThrow();
      expect(
        database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: nextWriterEpoch });
      database.exec("ROLLBACK");
      expect(state(database).shapeDigest).toBe(oldShape);
    } finally {
      database.close();
    }
  });

  test("wrong freeze or old epoch aborts before immutable suffix changes", () => {
    for (const patch of [
      { freezeBindingDigest: sha("foreign freeze") },
      { previousWriterEpoch: sha("foreign epoch") },
    ]) {
      const database = converted();
      try {
        const before = state(database);
        const fragments = buildMoneyPost94RootImportData({
          ...selected(),
          ...patch,
        });
        database.exec("BEGIN TRANSACTION");
        let attempted = 0;
        expect(() => {
          for (const statement of frameHostMigrationSql(fragments.beforeFinancialSql)) {
            attempted++;
            database.exec(statement);
          }
        }).toThrow();
        expect(attempted).toBe(1);
        expect(opaqueValue(state(database))).toEqual(opaqueValue(before));
        database.exec("ROLLBACK");
        expect(opaqueValue(state(database))).toEqual(opaqueValue(before));
      } finally {
        database.close();
      }
    }
  });

  test("late SQL failure conserves old schema, original freeze and old epoch", () => {
    const database = converted();
    try {
      const before = state(database);
      const freezeBefore = database.query("SELECT * FROM money_cutover_freeze").all();
      const epochBefore = database.query("SELECT * FROM money_cutover_authorized_epoch").all();
      const fragments = buildMoneyPost94RootImportData(selected());
      database.exec("BEGIN TRANSACTION");
      executeRootSql(database, fragments.beforeFinancialSql);
      executeRootSql(database, fragments.afterFinancialSql);
      expect(
        database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: nextWriterEpoch });
      expect(() => database.exec("INSERT INTO missing_root_post94_late_fault VALUES (1)")).toThrow(
        "missing_root_post94_late_fault",
      );
      database.exec("ROLLBACK");
      expect(opaqueValue(state(database))).toEqual(opaqueValue(before));
      expect(database.query("SELECT * FROM money_cutover_freeze").all()).toEqual(freezeBefore);
      expect(database.query("SELECT * FROM money_cutover_authorized_epoch").all()).toEqual(
        epochBefore,
      );
    } finally {
      database.close();
    }
  });

  test("getter, inherited, extra, equal epochs and changed fixed source refuse", () => {
    let getterCalls = 0;
    const accessor = selected();
    Object.defineProperty(accessor, "writerDigest", {
      enumerable: true,
      get() {
        getterCalls++;
        return marker;
      },
    });
    expect(() => buildMoneyPost94RootImportData(accessor)).toThrow("own data");
    expect(getterCalls).toBe(0);
    expect(() => buildMoneyPost94RootImportData(Object.create(selected()))).toThrow();
    expect(() => buildMoneyPost94RootImportData({ ...selected(), extra: true } as never)).toThrow();
    expect(() =>
      buildMoneyPost94RootImportData({
        ...selected(),
        nextWriterEpoch: writerEpoch,
      }),
    ).toThrow("distinct");
    const changed = files.map((file, index) =>
      index === 97 ? { ...file, digest: sha("foreign fixed source") } : file,
    );
    expect(() => buildMoneyPost94RootImportData({ ...selected(), files: changed })).toThrow();
  });

  test("Root fragments cannot open the existing post94 importer without Financial", async () => {
    const options = { phase: "suffix98" } as MoneyUnitCutoverOptions;
    await expect(
      runIntegrationMoneyUnitCutover(
        {
          action: "apply",
          environment: "integration",
          commit: "1".repeat(40),
          throughMigration: "0098",
        },
        legacyMoneyStagingTarget(),
        options,
      ),
    ).rejects.toThrow("owning Financial realm transition port");
    expect(() =>
      buildMoneyCutoverImportSql({
        phase: "suffix98",
        files,
        anchor: marker,
        originDigest: marker,
        backupDigest: marker,
        writerDigest: marker,
        writerEpoch,
      }),
    ).toThrow("owning Financial realm transition port");
  });
});
