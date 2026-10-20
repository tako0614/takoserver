import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeSnapshotDump } from "../scripts/deploy/d1-snapshot-restore.ts";
import {
  buildMoneyPost94OneImportData as buildActualMoneyPost94OneImportData,
  buildMoneyPost94RootImportData,
  buildMoneyPost94SigningGenesisData,
  moneyUnitCutoverSchemaMatches,
  readMoneyUnitHeldConvertFacts,
  readWholeDatabaseDataDigest,
  runIntegrationMoneyHeldSuffix98,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import type {
  MoneyUnitHeldConvertFacts,
  MoneyUnitHeldPost94ConsumerInputs,
  MoneyUnitOriginalCutoverOptions,
} from "../scripts/deploy/schema-money-unit-owner.ts";
import {
  composeMoneyUnitHeldPost94ConsumerInputs,
  readMoneyUnitHeldPost94ContextSelection,
} from "../scripts/deploy/schema-money-unit-owner.ts";
import { compileMoneyD1StripeRealmPinDraftData } from "../scripts/deploy/stripe-mode-realm.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { assertStripeModeRealm } from "../src/stripe-mode-realm.ts";

import {
  converted94CaptureFixture,
  files,
  fixture,
  legacyMoneyStagingTarget,
  marker,
  opaqueSql,
  opaqueValue,
  reader,
  sha,
  sql,
  state,
  writerEpoch,
} from "./helpers/money-unit-cutover-fixtures.ts";

describe("fixed post94 ONE Financial DATA composer", () => {
  // Component DATA fixture only; the actual executor obtains a genuine retained
  // signing artifact separately and cannot consume this compiler wrapper.
  const genesis = () => ({
    keyId: "component-signing-key",
    publicJwk: JSON.stringify({
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        "hex",
      ).toString("base64url"),
    }),
    createdAtEpochSeconds: 1720000000,
    previousWriterEpoch: writerEpoch,
  });
  const buildMoneyPost94OneImportData = (
    input: Omit<Parameters<typeof buildActualMoneyPost94OneImportData>[0], "signingGenesis">,
  ) => buildActualMoneyPost94OneImportData({ ...input, signingGenesis: genesis() });

  const execute = (database: Database, sql: string) => {
    for (const statement of frameHostMigrationSql(sql)) database.exec(statement);
  };
  const allData = (database: Database) =>
    readWholeDatabaseDataDigest(
      reader(database),
      "verification",
      (
        database
          .query(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
  // The converted94 capture and the compiled DATA are identical for every test
  // here, so they are built once; each test mutates its own copy of the
  // captured database and gets its own copy of the compiled values.
  let prepared: ReturnType<typeof prepareOnce> | undefined;
  afterAll(async () => {
    if (prepared !== undefined) (await prepared).f.close();
  });
  const prepare = async () => {
    prepared ??= prepareOnce();
    const { f, image, ...values } = await prepared;
    const database = Database.deserialize(image);
    return {
      ...structuredClone(values),
      f: { database, nextWriterEpoch: f.nextWriterEpoch, close: () => database.close() },
    };
  };
  const prepareOnce = async () => {
    const base = await converted94CaptureFixture(true);
    const f = { ...base, nextWriterEpoch: sha("ONE component-only next epoch") };
    try {
      await f.capture();
      const sourceFacts = await readMoneyUnitHeldConvertFacts({
        target: f.target,
        options: { ...f.options, phase: "convert" },
        previousWriterEpoch: writerEpoch,
        nextWriterEpoch: f.nextWriterEpoch,
        convertedBackupPath: f.convertedBackupPath,
      });
      // This compiler input is explicitly synthetic DATA, not an original context.
      const { qualification: _simulation, ...data } = sourceFacts;
      const facts: MoneyUnitHeldConvertFacts = { ...data, selectedStripeMode: "test" };
      // This DATA-only fixture supplies one synthetic original instant to the Financial compiler.
      const originalPinnedAt = new Date(genesis().createdAtEpochSeconds * 1000).toISOString();
      const draft = compileMoneyD1StripeRealmPinDraftData(facts, originalPinnedAt);
      const root = {
        files,
        freezeBindingDigest: facts.conversion.freezeBindingDigest,
        originDigest: facts.conversion.originDigest,
        original92BackupDigest: facts.original92.backupDigest,
        writerDigest: facts.conversion.writerDigest,
        previousWriterEpoch: writerEpoch,
        nextWriterEpoch: f.nextWriterEpoch,
      };
      return {
        f,
        image: f.database.serialize(),
        facts,
        draft,
        root,
        originalPinnedAt,
        convertedSnapshot: readFileSync(f.convertedBackupPath, "utf8"),
      };
    } catch (error) {
      f.close();
      throw error;
    }
  };
  test("actual V15 DATA triple is adjacent between fixed98 and one epoch rotation", async () => {
    const { f, draft, root, convertedSnapshot, originalPinnedAt } = await prepare();
    try {
      expect(draft.contribution).toBe(null);
      expect(draft.statements[1].params).toEqual([originalPinnedAt]);
      const one = await buildMoneyPost94OneImportData({
        root,
        financialStatements: draft.statements,
        convertedSnapshot,
      });
      expect(one.qualification).toBe("source-data-only");
      expect(one.digest).toBe(sha(one.sql));
      expect(one.expectedRowCounts.money_cutover_writer_permit).toBe(0);
      const statements = frameHostMigrationSql(one.sql),
        fragments = buildMoneyPost94RootImportData(root);
      const prefix = frameHostMigrationSql(fragments.beforeFinancialSql),
        suffix = frameHostMigrationSql(fragments.afterFinancialSql);
      expect(statements.length).toBe(prefix.length + 6 + suffix.length);
      expect(statements.slice(prefix.length + 3, prefix.length + 6).map(opaqueSql)).toEqual(
        [...buildMoneyPost94SigningGenesisData(genesis())]
          .flatMap((sql) => [...frameHostMigrationSql(sql)])
          .map((sql) => opaqueSql(`\n${sql}`)),
      );
      expect(statements.slice(0, prefix.length).map(opaqueSql)).toEqual(prefix.map(opaqueSql));
      expect(statements.slice(-suffix.length).map(opaqueSql)).toEqual(
        suffix.map((sql, index) => opaqueSql(index === 0 ? `\n${sql}` : sql)),
      );
      // Replaying after the SQLite clock advances must preserve the composer's typed postimage.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      f.database.transaction(() => execute(f.database, one.sql))();
      expect(moneyUnitCutoverSchemaMatches(state(f.database), files, "0098-fenced")).toBe(true);
      await assertStripeModeRealm(createSqliteSql(f.database), "test");
      expect(
        f.database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: f.nextWriterEpoch });
      expect(
        await readWholeDatabaseDataDigest(
          reader(f.database),
          "verification",
          Object.keys(one.expectedRowCounts),
        ),
      ).toBe(one.expectedAllDataDigest);
      expect(() => f.database.transaction(() => execute(f.database, one.sql))()).toThrow();
    } finally {
      f.close();
    }
  });
  test("a deliberate error after the real triple rolls back suffix, pin and old epoch together", async () => {
    const { f, draft, root, convertedSnapshot } = await prepare();
    try {
      const one = await buildMoneyPost94OneImportData({
        root,
        financialStatements: draft.statements,
        convertedSnapshot,
      });
      const statements = frameHostMigrationSql(one.sql),
        after = frameHostMigrationSql(buildMoneyPost94RootImportData(root).afterFinancialSql);
      const before = state(f.database),
        dataBefore = await allData(f.database);
      let reached = false;
      expect(() =>
        f.database.transaction(() => {
          execute(f.database, statements.slice(0, -after.length).join("\n"));
          reached = true;
          f.database.exec("SELECT missing FROM root_deliberate_missing_post94_table");
          execute(f.database, after.join("\n"));
        })(),
      ).toThrow("root_deliberate_missing_post94_table");
      expect(reached).toBe(true);
      expect(opaqueValue(state(f.database))).toEqual(opaqueValue(before));
      expect(await allData(f.database)).toBe(dataBefore);
      expect(
        f.database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: writerEpoch });
      await expect(assertStripeModeRealm(createSqliteSql(f.database), "test")).rejects.toThrow();
    } finally {
      f.close();
    }
  });
  test("zero-row fake INSERT or a malformed tuple cannot become a positive TEST pin", async () => {
    const { f, draft, root, convertedSnapshot } = await prepare();
    try {
      const triple = [
        { sql: "SELECT 1", params: [] },
        {
          sql: "SELECT 1 AS singleton, 'test' AS mode, 'irrelevant' AS pinned_at WHERE 0",
          params: [],
        },
        draft.statements[2],
      ] as unknown as typeof draft.statements;
      await expect(
        buildMoneyPost94OneImportData({ root, financialStatements: triple, convertedSnapshot }),
      ).rejects.toThrow("mandatory Financial INSERT");
      await expect(
        buildMoneyPost94OneImportData({
          root,
          financialStatements: draft.statements.slice(1) as unknown as typeof draft.statements,
          convertedSnapshot,
        }),
      ).rejects.toThrow("exact adjacent Financial triple");
      const altered = [
        { sql: "SELECT 1", params: [] },
        { ...draft.statements[1], params: [...draft.statements[1].params, "extraneous"] },
        draft.statements[2],
      ] as unknown as typeof draft.statements;
      await expect(
        buildMoneyPost94OneImportData({ root, financialStatements: altered, convertedSnapshot }),
      ).rejects.toThrow();
    } finally {
      f.close();
    }
  });
  test("native SQLite boundaries retain only finite codes and opaque hashes", async () => {
    const { f, draft, root, convertedSnapshot } = await prepare();
    try {
      const cases = [
        { sql: "SELECT missing FROM root_only_private_sql_marker", stage: "financial-expand" },
        { sql: "SELECT json('root_only_private_json_marker')", stage: "financial-execute" },
      ];
      for (const selected of cases) {
        const triple = [
          { sql: selected.sql, params: [] },
          draft.statements[1],
          draft.statements[2],
        ] as unknown as typeof draft.statements;
        const error = await buildMoneyPost94OneImportData({
          root,
          financialStatements: triple,
          convertedSnapshot,
        }).then(
          () => null,
          (value: unknown) => value,
        );
        expect(error instanceof Error).toBe(true);
        expect(Object.hasOwn(error as object, "query")).toBe(false);
        expect(Object.hasOwn(error as object, "cause")).toBe(false);
        expect(JSON.stringify(error).includes("root_only_private_")).toBe(false);
        const metadata = JSON.parse((error as { detail: string }).detail);
        expect(metadata.stage).toBe(selected.stage);
        expect(metadata.nativeCode).toBe("sqlite_error");
        expect(metadata.statementDigest).toBe(sha(selected.sql));
      }
      const badSnapshot = normalizeSnapshotDump(
        Buffer.from(
          `${convertedSnapshot}\nSELECT missing FROM root_only_private_snapshot_marker;\n`,
        ),
      ).sql;
      const error = await buildMoneyPost94OneImportData({
        root,
        financialStatements: draft.statements,
        convertedSnapshot: badSnapshot,
      }).then(
        () => null,
        (value: unknown) => value,
      );
      expect(error instanceof Error).toBe(true);
      expect(Object.hasOwn(error as object, "query")).toBe(false);
      expect(Object.hasOwn(error as object, "cause")).toBe(false);
      expect(JSON.stringify(error).includes("root_only_private_")).toBe(false);
      const metadata = JSON.parse((error as { detail: string }).detail);
      expect(metadata.stage).toBe("snapshot-import");
      expect(metadata.statementDigest).toBe(sha(badSnapshot));
    } finally {
      f.close();
    }
  });
  test("lossy NUL parameter refuses before native expansion or any external mutation", async () => {
    const { f, draft, root, convertedSnapshot } = await prepare();
    try {
      const triple = [
        { sql: "SELECT ?", params: ["retained\0bytes"] },
        draft.statements[1],
        draft.statements[2],
      ] as unknown as typeof draft.statements;
      await expect(
        buildMoneyPost94OneImportData({ root, financialStatements: triple, convertedSnapshot }),
      ).rejects.toThrow("losslessly");
      expect(moneyUnitCutoverSchemaMatches(state(f.database), files, "0094-fenced")).toBe(true);
    } finally {
      f.close();
    }
  });
  test("bare options/context DTO cannot enter actual operative constructor or native executor", async () => {
    const target = legacyMoneyStagingTarget();
    await expect(
      runIntegrationMoneyHeldSuffix98(
        {
          action: "apply",
          environment: "integration",
          commit: "a".repeat(40),
          throughMigration: "0098",
        },
        target,
        { phase: "convert" } as MoneyUnitOriginalCutoverOptions,
        {} as MoneyUnitHeldPost94ConsumerInputs,
        {},
      ),
    ).rejects.toThrow();
  });
});

describe("fixed post94 Root signing genesis DATA", () => {
  const nextWriterEpoch = sha("signing DATA next epoch");
  const publicJwk = JSON.stringify({
    kty: "OKP",
    crv: "Ed25519",
    x: Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    ).toString("base64url"),
  });
  const input = () => ({
    keyId: "component-signing-key",
    publicJwk,
    createdAtEpochSeconds: 1720000000,
    previousWriterEpoch: writerEpoch,
  });
  const selected = () => ({
    files,
    freezeBindingDigest: marker,
    originDigest: marker,
    original92BackupDigest: marker,
    writerDigest: marker,
    previousWriterEpoch: writerEpoch,
    nextWriterEpoch,
  });
  const execute = (database: Database, source: string) => {
    for (const statement of frameHostMigrationSql(source)) database.exec(statement);
  };
  const converted = () => {
    const database = fixture(true);
    for (const phase of ["freeze", "prepare", "classify", "convert"] as const)
      execute(database, sql(phase, []));
    return database;
  };
  test("fixed public registration returns exact active row and precedes epoch rotation", () => {
    const database = converted();
    try {
      const fragments = buildMoneyPost94RootImportData(selected()),
        statements = buildMoneyPost94SigningGenesisData(input());
      database.exec("BEGIN");
      execute(database, fragments.beforeFinancialSql);
      database.exec(statements[0]);
      const rows = database.prepare(statements[1]).all();
      expect(rows).toEqual([
        {
          key_id: input().keyId,
          public_jwk: publicJwk,
          created_at_epoch_seconds: 1720000000,
          revoked_at_epoch_seconds: null,
        },
      ]);
      database.exec(statements[2]);
      execute(database, fragments.afterFinancialSql);
      database.exec("COMMIT");
      expect(
        database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: nextWriterEpoch });
      expect(database.query("SELECT COUNT(*) AS n FROM runtime_grant_keys").get()).toEqual({
        n: 1,
      });
    } finally {
      database.close();
    }
  });
  test("existing row refuses before INSERT and never overwrites its exact bytes", () => {
    const database = converted();
    try {
      execute(database, buildMoneyPost94RootImportData(selected()).beforeFinancialSql);
      for (const statement of buildMoneyPost94SigningGenesisData(input()))
        database.prepare(statement).all();
      const before = database.query("SELECT * FROM runtime_grant_keys").all();
      expect(() =>
        database.transaction(() =>
          execute(
            database,
            buildMoneyPost94SigningGenesisData({ ...input(), keyId: "other-component-key" }).join(
              "\n",
            ),
          ),
        )(),
      ).toThrow();
      expect(database.query("SELECT * FROM runtime_grant_keys").all()).toEqual(before);
    } finally {
      database.close();
    }
  });
  test("zero INSERT and a crossed postimage both abort rather than passing on zero rows", () => {
    for (const mutation of ["zero", "crossed"]) {
      const database = converted();
      try {
        execute(database, buildMoneyPost94RootImportData(selected()).beforeFinancialSql);
        const statements = buildMoneyPost94SigningGenesisData(input());
        expect(() =>
          database.transaction(() => {
            database.exec(statements[0]);
            if (mutation === "zero") database.exec("SELECT 1 WHERE 0");
            else {
              database.prepare(statements[1]).all();
              database.exec("UPDATE runtime_grant_keys SET revoked_at_epoch_seconds=1720000001");
            }
            database.exec(statements[2]);
          })(),
        ).toThrow();
        expect(database.query("SELECT COUNT(*) AS n FROM runtime_grant_keys").get()).toEqual({
          n: 0,
        });
      } finally {
        database.close();
      }
    }
  });
  test("late old-epoch failure rolls back schema and public registration together", () => {
    const database = converted();
    try {
      const before = state(database),
        fragments = buildMoneyPost94RootImportData(selected());
      let registered = false;
      expect(() =>
        database.transaction(() => {
          execute(database, fragments.beforeFinancialSql);
          execute(database, buildMoneyPost94SigningGenesisData(input()).join("\n"));
          registered = true;
          execute(
            database,
            buildMoneyPost94RootImportData({
              ...selected(),
              previousWriterEpoch: sha("wrong-old-epoch"),
            }).afterFinancialSql,
          );
        })(),
      ).toThrow();
      expect(registered).toBe(true);
      expect(opaqueValue(state(database))).toEqual(opaqueValue(before));
      expect(database.query("SELECT COUNT(*) AS n FROM runtime_grant_keys").get()).toEqual({
        n: 0,
      });
      expect(
        database.query("SELECT writer_epoch FROM money_cutover_authorized_epoch").get(),
      ).toEqual({ writer_epoch: writerEpoch });
    } finally {
      database.close();
    }
  });
  test("private fields, noncanonical bytes and accessor DATA are refused without minting authority", () => {
    expect(() =>
      buildMoneyPost94SigningGenesisData({
        ...input(),
        publicJwk: JSON.stringify({ ...JSON.parse(publicJwk), d: "not-a-key" }),
      }),
    ).toThrow();
    expect(() =>
      buildMoneyPost94SigningGenesisData({ ...input(), publicJwk: `${publicJwk} ` }),
    ).toThrow();
    let calls = 0;
    const accessor = Object.defineProperty({ ...input() }, "keyId", {
      enumerable: true,
      get() {
        calls++;
        return "component";
      },
    });
    expect(() => buildMoneyPost94SigningGenesisData(accessor)).toThrow();
    expect(calls).toBe(0);
  });
});

describe("fixed post94 live original transport refusal", () => {
  test("pre-upload original selection cannot be created from naked default-looking options", async () => {
    await expect(
      readMoneyUnitHeldPost94ContextSelection(
        { phase: "convert", writerEpoch } as MoneyUnitOriginalCutoverOptions,
        "/unavailable/component-only-declaration.json",
      ),
    ).rejects.toThrow();
  });
  test("matching member DTOs cannot mint original same-context mode inputs", async () => {
    await expect(
      composeMoneyUnitHeldPost94ConsumerInputs(
        { phase: "convert" } as MoneyUnitOriginalCutoverOptions,
        {
          context: { kind: "takoserver.money-held-convert-context@v1" },
          selection: { phase: "suffix98" },
        } as unknown as Parameters<typeof composeMoneyUnitHeldPost94ConsumerInputs>[1],
        {} as Parameters<typeof composeMoneyUnitHeldPost94ConsumerInputs>[2],
      ),
    ).rejects.toThrow();
  });
  test("getter-backed context transport is rejected without invoking getters", async () => {
    let calls = 0;
    const data = Object.defineProperty({ selection: {} }, "context", {
      enumerable: true,
      get() {
        calls++;
        throw Error("must not invoke");
      },
    });
    await expect(
      composeMoneyUnitHeldPost94ConsumerInputs(
        {} as MoneyUnitOriginalCutoverOptions,
        data as unknown as Parameters<typeof composeMoneyUnitHeldPost94ConsumerInputs>[1],
        {} as Parameters<typeof composeMoneyUnitHeldPost94ConsumerInputs>[2],
      ),
    ).rejects.toThrow("own DATA");
    expect(calls).toBe(0);
  });
});
