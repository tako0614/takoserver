import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { normalizeSnapshotDump } from "../scripts/deploy/d1-snapshot-restore.ts";
import { runD1Schema } from "../scripts/deploy/schema.ts";
import {
  assertMoneyLiveBackupCompleteness,
  assertMoneyNativeForeignKeys,
  assertMoneyPost94Source,
  buildMoneyCutoverImportSql,
  inspectMoneyUnitResumeState,
  MONEY_FENCE_TABLES_0092,
  type MoneyCutoverDispatchBinding,
  type MoneyReviewBinding,
  type MoneyStageOriginProof,
  type MoneyUnitCutoverOptions,
  moneyCutoverBindingDigest,
  moneyUnitCutoverExpectedShape,
  moneyUnitCutoverSchemaMatches,
  moneyUnitCutoverSourcePrefixDigest,
  readMoneyAggregateDigest,
  readMoneyFrozenDataDigest,
  readMoneyPreimageDigest,
  readWholeDatabaseDataDigest,
  reconcileMoneyCutoverDispatched,
  runIntegrationMoneyUnitCutover,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import { createMoneyCutoverSql, inspectMoneyCutoverGuard } from "../src/money-cutover-sql.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

import {
  apply,
  applyPost94SchemaModel,
  files,
  fixture,
  legacyMoneyStagingTarget,
  marker,
  post94ReadFixture,
  reader,
  resumeReadFixture,
  sha,
  sql,
  state,
  writerEpoch,
} from "./helpers/money-unit-cutover-fixtures.ts";

describe("money resume read component", () => {
  test("money resume read distinguishes guarded94 by actual freeze rows and never grants normal Host readiness", async () => {
    const f = await resumeReadFixture();
    try {
      const result = await f.inspect();
      expect(result.schemaPhase).toBe("0094-fenced");
      expect(result.health).toBe("guarded");
      expect(result.normalHostReady).toBe(false);
      expect(result.resumeBindingDigest).toBeNull();
      expect(
        f.database.query("SELECT CAST(settled_delta_micros AS TEXT) AS amount FROM ledger").get(),
      ).toEqual({ amount: "70000" });
      expect(f.queries.length).toBeGreaterThan(0);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
  test("money resume read rereads a terminal resume without requiring its deleted freeze row", async () => {
    const f = await resumeReadFixture();
    try {
      const before = state(f.database);
      f.advance("resume");
      expect(state(f.database).shapeDigest).toBe(before.shapeDigest);
      expect(f.database.query("SELECT * FROM money_cutover_freeze").all()).toEqual([]);
      const result = await f.inspect();
      expect(result.schemaPhase).toBe("0094");
      expect(result.health).toBe("healthy");
      expect(result.normalHostReady).toBe(false);
      expect(result.resumeBindingDigest).not.toBeNull();
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
  test("money resume read holds unknown and missing custody even when current schema is complete", async () => {
    const f = await resumeReadFixture();
    try {
      f.advance("resume");
      const receipt = f.receipts.get("resume");
      if (!receipt) throw new Error("fixture resume missing");
      f.receipts.set("resume", { ...receipt, state: "dispatched", postDigest: null });
      await expect(f.inspect()).rejects.toThrow("unknown resume dispatch");
      f.receipts.delete("resume");
      f.bindings.delete("resume");
      await expect(f.inspect()).rejects.toThrow("lacks terminal resume custody");
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
  test("money resume read refuses exact-digest custody with changed predecessor origin backup or epoch", async () => {
    const f = await resumeReadFixture();
    try {
      const binding = f.bindings.get("convert");
      const receipt = f.receipts.get("convert");
      if (!binding || !receipt) throw new Error("fixture convert missing");
      for (const field of [
        "predecessorCustodyDigest",
        "originDigest",
        "backupDigest",
        "writerEpoch",
      ] as const) {
        const changed = { ...binding, [field]: sha(`changed-${field}`) };
        f.bindings.set("convert", changed);
        f.receipts.set("convert", {
          ...receipt,
          bindingDigest: moneyCutoverBindingDigest(changed),
        });
        await expect(f.inspect()).rejects.toThrow("dispatch differs");
      }
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
  test("money resume read refuses retained import bytes changed after terminal custody", async () => {
    const f = await resumeReadFixture();
    try {
      const binding = f.bindings.get("convert");
      if (!binding) throw new Error("fixture missing");
      writeFileSync(binding.sealedImportPath, "-- changed\n", { mode: 0o600 });
      await expect(f.inspect()).rejects.toThrow("sealed import/source differs");
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
  test("money resume read detects a deferred native Version change across health await", async () => {
    const f = await resumeReadFixture();
    try {
      let observed = f.native;
      f.setNative(async () => observed);
      f.setHealth(async () => {
        await Promise.resolve();
        observed = { ...f.native, versionId: "22222222-2222-4222-8222-222222222222" };
      });
      await expect(f.inspect()).rejects.toThrow("changed during observation");
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
  test("money resume read detects authorized epoch drift during its health observation", async () => {
    const f = await resumeReadFixture();
    try {
      f.setHealth(async () => {
        f.database.exec(
          `UPDATE money_cutover_authorized_epoch SET writer_epoch = '${sha("drift")}'`,
        );
      });
      await expect(f.inspect()).rejects.toThrow("changed during observation");
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
  test("money resume read selector cannot grant original writer provenance", async () => {
    const f = await resumeReadFixture();
    try {
      const read = await f.inspect();
      expect(read.schemaPhase).toBe("0094-fenced");
      expect(read.normalHostReady).toBe(false);
      expect(f.mutations()).toBe(0);
      await expect(
        runIntegrationMoneyUnitCutover(
          {
            action: "status",
            environment: "integration",
            commit: "c".repeat(40),
            throughMigration: "0094",
          },
          f.target,
          f.options,
        ),
      ).rejects.toThrow("fresh money writer requires the same owning original options and target");
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });
});

describe("fixed money cutover SQL", () => {
  test("selected transaction-fenced target cannot use generic 0095 schema lane", async () => {
    await expect(
      runD1Schema(
        { action: "status", environment: "integration", commit: "a".repeat(40) },
        {
          environment: "integration",
          moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
        } as never,
        {
          run: async () => {
            throw new Error("provider read");
          },
        },
      ),
    ).rejects.toThrow("reviewed 0095 suffix");
  });
  test("expected-shape cache still rejects changed migration bytes after warm-up", () => {
    const phases = ["0092", "0092-fenced", "0093", "0093-fenced", "0094", "0094-fenced"] as const;
    const shapes = phases.map((phase) => moneyUnitCutoverExpectedShape(files, phase));
    expect(new Set(shapes).size).toBe(5);
    expect(shapes[4]).toBe(shapes[5]); // 0094 freeze is a row-state distinction.
    for (const [index, phase] of phases.entries()) {
      expect(moneyUnitCutoverExpectedShape(files, phase)).toBe(
        shapes[index] ?? "missing expected shape",
      );
    }
    const directory = mkdtempSync(join(tmpdir(), "money-source-tamper-"));
    try {
      const source94 = files[93];
      if (source94 === undefined) throw new Error("missing fixed 0094 source");
      const path = join(directory, source94.name);
      writeFileSync(
        path,
        Buffer.concat([
          readFileSync(source94.path),
          Buffer.from("\n-- tampered after cache warm-up\n"),
        ]),
        { mode: 0o600 },
      );
      const changed = files.map((file, index) => (index === 93 ? { ...file, path } : file));
      expect(() => moneyUnitCutoverExpectedShape(changed, "0092")).toThrow(
        "source changed after inventory",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("freeze checkpoint refuses equal-count nonfinancial drift and native FK violations", async () => {
    const database = new Database(":memory:");
    try {
      database.exec(
        "CREATE TABLE nonmoney (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO nonmoney VALUES (1, 'before')",
      );
      const backup = {
        rowCounts: { nonmoney: 1 },
        allDataDigest: await readWholeDatabaseDataDigest(reader(database), "preflight", [
          "nonmoney",
        ]),
      };
      await expect(
        assertMoneyLiveBackupCompleteness(reader(database), "preflight", backup),
      ).resolves.toBeUndefined();
      database.exec("UPDATE nonmoney SET note = 'after'");
      await expect(
        assertMoneyLiveBackupCompleteness(reader(database), "preflight", backup),
      ).rejects.toThrow("complete typed row bytes differ");
      database.exec(
        "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (9)",
      );
      await expect(assertMoneyNativeForeignKeys(reader(database), "verification")).rejects.toThrow(
        "foreign-key violation",
      );
    } finally {
      database.close();
    }
  });
  test("full backup digest distinguishes NUL suffixes and SQLite storage classes", async () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE typed_values (id INTEGER PRIMARY KEY, value)");
      const fingerprint = () =>
        readWholeDatabaseDataDigest(reader(database), "preflight", ["typed_values"]);
      const empty = await fingerprint();
      database.exec("INSERT INTO typed_values VALUES (1, 'A' || char(0) || 'B')");
      const nulB = await fingerprint();
      database.exec("UPDATE typed_values SET value = 'A' || char(0) || 'C'");
      const nulC = await fingerprint();
      expect(nulB).not.toBe(nulC);
      expect(nulB).not.toBe(empty);
      database.exec("UPDATE typed_values SET value = NULL");
      const nil = await fingerprint();
      database.exec("UPDATE typed_values SET value = ''");
      const text = await fingerprint();
      database.exec("UPDATE typed_values SET value = X''");
      const blob = await fingerprint();
      expect(new Set([nil, text, blob]).size).toBe(3);
      database.exec("UPDATE typed_values SET value = 9007199254740993");
      const largeInteger = await fingerprint();
      database.exec("UPDATE typed_values SET value = 9007199254740992");
      expect(await fingerprint()).not.toBe(largeInteger);
      database.exec("UPDATE typed_values SET value = 1.0000000000000002");
      const realA = await fingerprint();
      database.exec("UPDATE typed_values SET value = 1.0000000000000004");
      expect(await fingerprint()).not.toBe(realA);
    } finally {
      database.close();
    }
  });

  test("unknown ACK terminalizes only after GET readback of sealed SQL, backup, source and reviewed after-state", async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "money-reconcile-"));
    const importDirectory = join(outputDirectory, "money-freeze-retained");
    mkdirSync(importDirectory, { mode: 0o700 });
    const database = fixture();
    try {
      const accountId = "1".repeat(32);
      const databaseId = "11111111-1111-4111-8111-111111111111";
      const databaseName = `takoserver-i-${accountId}`;
      const target = legacyMoneyStagingTarget(accountId, databaseId, databaseName);
      const liveIdentity = { accountId, databaseId, databaseName, bucketName: databaseName };
      const origin: MoneyStageOriginProof = {
        kind: "takoserver.money-stage-origin@v1",
        state: "terminal",
        ...liveIdentity,
        sourceDigest: "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2",
        sourceCommit: "a".repeat(40),
        terminalCustodyDigest: marker,
      };
      expect(moneyUnitCutoverSourcePrefixDigest(files, 92)).toBe(origin.sourceDigest);
      const originDigest = sha(JSON.stringify(origin));
      const writer = {
        kind: "takoserver.money-writer-quiescence@v1",
        mode: "pre-wallet-usd-micros-quiesced",
        accountId,
        databaseId,
        workerName: databaseName,
        deploymentId: databaseId,
        versionId: databaseId,
        sourceCommit: "b".repeat(40),
        moduleDigest: marker,
        trafficPercent: 100,
        privateMoneyWriters: 0,
        writerEpoch,
        privateScopeDigest: marker,
        privateSourceInventoryDigest: marker,
        privateDependencyClosureDigest: marker,
        privateDeploymentsDigest: marker,
        publicPublicationDigest: marker,
        publicSourceArtifactDigest: marker,
      } as const;
      const writerDigest = sha(JSON.stringify(writer));
      const cursorHandle = (
        database.query("SELECT cursor_handle FROM wallet_credit_lots").get() as {
          cursor_handle: string;
        }
      ).cursor_handle;
      const originalSql = `${buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql}\nINSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at) VALUES ('fund-1','org-1','funding','credit-1',7,0,'2026-01-01T00:00:00Z');\nINSERT INTO wallet_credit_lots (org_id, ref, kind, amount_minor, expires_at, created_at, cursor_handle) VALUES ('org-1','credit-1','direct',7,NULL,'2026-01-01T00:00:00Z','${cursorHandle}');\n`;
      const normalized = normalizeSnapshotDump(Buffer.from(originalSql));
      const backupPath = join(outputDirectory, "backup.sql");
      writeFileSync(backupPath, normalized.sql, { mode: 0o600 });
      writeFileSync(
        `${backupPath}.identity.json`,
        `${JSON.stringify({
          kind: "takoserver.money-protected-backup@v1",
          accountId,
          databaseId,
          databaseName,
          originDigest,
          sourceDigest: origin.sourceDigest,
          backupDigest: normalized.digest,
        })}\n`,
        { mode: 0o600 },
      );
      const preimageDigest = await readMoneyPreimageDigest(reader(database), "preflight");
      const aggregateDigest = await readMoneyAggregateDigest(reader(database), "preflight");
      const financialDigest = await readMoneyFrozenDataDigest(reader(database), "preflight");
      const restored = new Database(":memory:");
      try {
        restored.exec(normalized.sql);
        expect(await readMoneyPreimageDigest(reader(restored), "preflight")).toBe(preimageDigest);
        expect(await readMoneyAggregateDigest(reader(restored), "preflight")).toBe(aggregateDigest);
        for (const table of MONEY_FENCE_TABLES_0092) {
          const first = await readWholeDatabaseDataDigest(reader(database), "preflight", [table]);
          const second = await readWholeDatabaseDataDigest(reader(restored), "preflight", [table]);
          expect(second, table).toBe(first);
        }
        expect(await readMoneyFrozenDataDigest(reader(restored), "preflight")).toBe(
          financialDigest,
        );
      } finally {
        restored.close();
      }
      const anchor = sha(
        JSON.stringify({
          kind: "takoserver.money-freeze-anchor@v1",
          target: liveIdentity,
          originDigest,
          backupDigest: normalized.digest,
          preimageDigest,
          aggregateDigest,
          financialDigest,
          writerDigest,
          writerEpoch,
          sourceDigest: origin.sourceDigest,
        }),
      );
      const beforeShapeDigest = state(database).shapeDigest;
      const importSql = buildMoneyCutoverImportSql({
        phase: "freeze",
        files,
        anchor,
        originDigest,
        backupDigest: normalized.digest,
        writerDigest,
        writerEpoch,
      });
      const sealedImportPath = join(importDirectory, "import.sql");
      writeFileSync(sealedImportPath, importSql, { mode: 0o600 });
      apply(database, importSql);
      const reviewBinding: MoneyReviewBinding = {
        kind: "takoserver.money-review-binding@v1",
        phase: "freeze",
        accountId,
        databaseId,
        originDigest,
        predecessorCustodyDigest: marker,
        sourceCommit: "c".repeat(40),
        sourceDigest: moneyUnitCutoverSourcePrefixDigest(files, 93),
        importDigest: sha(importSql),
        backupDigest: normalized.digest,
        preimageDigest,
        aggregateDigest,
        classificationDigest: sha("[]\n"),
        writerDigest,
        resumeDigest: sha("no-resume-worker"),
        writerEpoch,
      };
      const review = {
        kind: "takoserver.money-independent-review@v1",
        reviewer: "independent reviewer",
        reviewRef: "reviewed-freeze-local-evidence",
        bindingDigest: moneyCutoverBindingDigest(reviewBinding),
        evidenceDigest: marker,
      } as const;
      const binding: MoneyCutoverDispatchBinding = {
        kind: "takoserver.money-cutover-dispatch@v1",
        phase: "freeze",
        accountId,
        databaseId,
        databaseName,
        originDigest,
        predecessorCustodyDigest: marker,
        sourceCommit: reviewBinding.sourceCommit,
        sourceDigest: reviewBinding.sourceDigest,
        importDigest: reviewBinding.importDigest,
        backupDigest: normalized.digest,
        preimageDigest,
        aggregateDigest,
        classificationDigest: reviewBinding.classificationDigest,
        writerDigest,
        resumeDigest: reviewBinding.resumeDigest,
        writerEpoch,
        reviewDigest: sha(JSON.stringify(review)),
        beforeShapeDigest,
        afterSchemaPhase: "0092-fenced",
        sealedImportPath,
      };
      const receipt = {
        kind: "takoserver.money-cutover-custody@v1",
        phase: "freeze",
        state: "dispatched",
        bindingDigest: moneyCutoverBindingDigest(binding),
        postDigest: null,
      } as const;
      let terminalWrites = 0;
      let d1Writes = 0;
      const options = {
        phase: "freeze",
        maintenanceCommit: writer.sourceCommit,
        writerEpoch,
        backupPath,
        outputDirectory,
        stageOriginProof: async () => origin,
        storageIdentityRead: async () => liveIdentity,
        maintenanceProof: async () => writer,
        independentReview: async () => review,
        custody: {
          read: async () => receipt,
          readDispatch: async () => binding,
          dispatch: async () => {
            throw new Error("must not reimport");
          },
          terminal: async (_binding: unknown, postDigest: string) => {
            terminalWrites += 1;
            return { ...receipt, state: "terminal" as const, postDigest };
          },
        },
        run: async () => {
          d1Writes += 1;
          throw new Error("must not invoke Wrangler");
        },
      } as const;
      const input = {
        invocation: {
          action: "status" as const,
          environment: "integration" as const,
          commit: reviewBinding.sourceCommit,
          throughMigration: "0093",
        },
        target,
        options,
        files,
        database: reader(database) as never,
        schema: state(database),
        actualPhase: "0092-fenced",
        originDigest,
        origin,
        liveIdentity,
        writer,
        previousReceipt: null,
        root: importDirectory,
        configPath: join(importDirectory, "wrangler.jsonc"),
        run: options.run,
        environment: {},
        receipt,
      } as const;
      const incomplete = await reconcileMoneyCutoverDispatched({ ...input, actualPhase: "0092" });
      expect(incomplete.custody).toBe("dispatched");
      expect(terminalWrites).toBe(0);
      const result = await reconcileMoneyCutoverDispatched(input);
      expect(result.custody).toBe("terminal");
      expect(result.d1Writes).toBe(0);
      expect(terminalWrites).toBe(1);
      expect(d1Writes).toBe(0);
    } finally {
      database.close();
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
  test("92 freeze, 93 classification and 94 conversion preserve old row evidence and fences", async () => {
    const database = fixture();
    try {
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0092")).toBe(true);
      const before = await readMoneyPreimageDigest(reader(database), "preflight");
      const aggregates = await readMoneyAggregateDigest(reader(database), "preflight");
      apply(database, sql("freeze"));
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0092-fenced")).toBe(true);
      expect(() =>
        database.exec("INSERT INTO ledger VALUES ('x','org-1','funding','x',1,0,'now')"),
      ).toThrow();
      apply(database, sql("prepare"));
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0093-fenced")).toBe(true);
      const classifications = [
        {
          org_id: "org-1",
          ref: "credit-1",
          original_kind: "direct",
          original_amount_minor: "7",
          original_expires_at: null,
          consumption_class: "free",
          evidence_ref: "reviewed-local-credit-1",
          reviewed_at: "2026-10-14T00:00:00Z",
        },
      ];
      apply(database, sql("classify", classifications));
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0093-fenced")).toBe(true);
      expect(await readMoneyPreimageDigest(reader(database), "preflight")).toBe(before);
      apply(database, sql("convert", classifications));
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0094-fenced")).toBe(true);
      expect(await inspectMoneyCutoverGuard(createSqliteSql(database), writerEpoch)).toBe("frozen");
      expect(await readMoneyPreimageDigest(reader(database), "verification", true)).toBe(before);
      expect(await readMoneyAggregateDigest(reader(database), "verification", true)).toBe(
        aggregates,
      );
      expect(
        (
          database
            .query("SELECT settled_delta_micros AS amount FROM ledger WHERE id = 'fund-1'")
            .get() as { amount: number }
        ).amount,
      ).toBe(70000);
      expect(() =>
        database.exec(
          "INSERT INTO ledger (id,org_id,type,ref,settled_delta_micros,held_delta_micros,created_at) VALUES ('x','org-1','funding','x',1,0,'now')",
        ),
      ).toThrow();
      database.exec("SAVEPOINT missing_freeze");
      database.exec("DELETE FROM money_cutover_freeze");
      expect(
        (database.query("SELECT COUNT(*) AS n FROM money_cutover_freeze").get() as { n: number }).n,
      ).toBe(0);
      expect(sql("resume")).toContain("invalid-resume-epoch");
      const resumeAssertion = sql("resume").split(";\n")[0] ?? "";
      expect(() => database.query(resumeAssertion).run()).toThrow();
      database.exec("ROLLBACK TO missing_freeze; RELEASE missing_freeze");
      database.exec(
        `INSERT INTO money_cutover_writer_permit VALUES (1, 'usd-micros-v2', '${writerEpoch}')`,
      );
      expect(() => database.query(resumeAssertion).run()).toThrow();
      const resumeDelete = sql("resume").split(";\n")[1] ?? "";
      expect(database.query(resumeDelete).run().changes).toBe(0);
      expect(
        (database.query("SELECT COUNT(*) AS n FROM money_cutover_freeze").get() as { n: number }).n,
      ).toBe(1);
      database.exec("DELETE FROM money_cutover_writer_permit");
      apply(database, sql("resume"));
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0094")).toBe(true);
      const bare = createSqliteSql(database);
      expect(await inspectMoneyCutoverGuard(bare, writerEpoch)).toBe("ready");
      const oldStripeInsert =
        "INSERT INTO stripe_events (event_id,type,livemode,event_created_at,received_at,outcome) VALUES ('evt_legacy','checkout.session.completed',0,'now','now','received')";
      expect(() => database.exec(oldStripeInsert)).toThrow("money cutover writer permit required");
      const current = createMoneyCutoverSql(bare, writerEpoch);
      await expect(current.run("DELETE FROM money_cutover_freeze")).rejects.toThrow(
        "outside the guarded surface",
      );
      await expect(current.run("/* comment */ DROP TABLE stripe_events")).rejects.toThrow(
        "outside the guarded surface",
      );
      await expect(
        current.run("UPDATE stripe_events SET outcome = 'x'; DELETE FROM stripe_events"),
      ).rejects.toThrow("outside the guarded surface");
      expect((await current.run(oldStripeInsert)).changes).toBe(1);
      expect(() =>
        database.exec(
          "UPDATE stripe_events SET outcome = 'ignored', settled_at = 'now' WHERE event_id = 'evt_legacy'",
        ),
      ).toThrow("money cutover writer permit required");
      expect(
        (
          await current.run(
            "UPDATE stripe_events SET outcome = 'ignored', settled_at = 'now' WHERE event_id = 'evt_legacy'",
          )
        ).changes,
      ).toBe(1);
      await expect(
        current.batch([
          { sql: oldStripeInsert },
          { sql: "UPDATE stripe_events SET outcome = 'credited' WHERE event_id = 'evt_legacy'" },
        ]),
      ).rejects.toThrow();
      expect(await bare.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
      await expect(
        current.query(
          "UPDATE stripe_events SET outcome = 'ignored' WHERE event_id = 'evt_legacy' RETURNING event_id",
        ),
      ).rejects.toThrow();
      expect(
        await current.query(
          "WITH selected AS (SELECT 'evt_legacy' AS id) UPDATE stripe_events SET outcome = 'credited' WHERE event_id = (SELECT id FROM selected) RETURNING event_id",
        ),
      ).toEqual([{ event_id: "evt_legacy" }]);
      const concurrent = await Promise.allSettled([
        current.run(
          "INSERT INTO stripe_events (event_id,type,livemode,event_created_at,received_at,outcome) VALUES ('evt_new_a','checkout.session.completed',0,'now','now','received')",
        ),
        current.run(
          "INSERT INTO stripe_events (event_id,type,livemode,event_created_at,received_at,outcome) VALUES ('evt_new_b','checkout.session.completed',0,'now','now','received')",
        ),
      ]);
      expect(concurrent.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await bare.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
      const nextWriterEpoch = sha("next reviewed Writer generation");
      database
        .query("UPDATE money_cutover_authorized_epoch SET writer_epoch = ? WHERE singleton = 1")
        .run(nextWriterEpoch);
      await expect(inspectMoneyCutoverGuard(bare, writerEpoch)).rejects.toThrow(
        "permit or policy differs",
      );
      await expect(current.run("SELECT 1")).rejects.toThrow("Writer epoch revoked");
      expect(await bare.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("a failed 94 import restores 93, all old fences, and financial rows atomically", async () => {
    const database = fixture();
    try {
      apply(database, sql("freeze"));
      apply(database, sql("prepare"));
      apply(
        database,
        sql("classify", [
          {
            org_id: "org-1",
            ref: "credit-1",
            original_kind: "direct",
            original_amount_minor: "7",
            original_expires_at: null,
            consumption_class: "free",
            evidence_ref: "reviewed-local-credit-1",
            reviewed_at: "2026-10-14T00:00:00Z",
          },
        ]),
      );
      const before = await readMoneyPreimageDigest(reader(database), "preflight");
      const broken = sql("convert").replace(
        "CREATE TABLE money_cutover_guard",
        "INSERT INTO no_such_money_table DEFAULT VALUES;\nCREATE TABLE money_cutover_guard",
      );
      expect(() => apply(database, broken)).toThrow();
      database.exec("ROLLBACK");
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0093-fenced")).toBe(true);
      expect(await readMoneyPreimageDigest(reader(database), "verification")).toBe(before);
      expect(() => database.exec("DELETE FROM wallet_credit_lots")).toThrow();
    } finally {
      database.close();
    }
  });

  test("reviewed preconversion abandon removes only fences and retains the 93 data", async () => {
    const database = fixture();
    try {
      const before = await readMoneyPreimageDigest(reader(database), "preflight");
      apply(database, sql("freeze"));
      apply(database, sql("prepare"));
      apply(database, sql("abandon", [], "0093-fenced"));
      expect(moneyUnitCutoverSchemaMatches(state(database), files, "0093")).toBe(true);
      expect(await readMoneyPreimageDigest(reader(database), "verification")).toBe(before);
      expect(
        (
          database
            .query(
              "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'money_cutover_fence_%'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  test("dispatched custody blocks a second apply before any provider read", async () => {
    let reads = 0;
    const target = legacyMoneyStagingTarget();
    await expect(
      runIntegrationMoneyUnitCutover(
        {
          action: "apply",
          environment: "integration",
          commit: "a".repeat(40),
          throughMigration: "0093",
        },
        target,
        {
          phase: "freeze",
          maintenanceCommit: "b".repeat(40),
          writerEpoch,
          backupPath: "/dev/null",
          outputDirectory: tmpdir(),
          stageOriginProof: async () => {
            reads += 1;
            throw new Error("read");
          },
          storageIdentityRead: async () => {
            reads += 1;
            throw new Error("read");
          },
          maintenanceProof: async () => {
            reads += 1;
            throw new Error("read");
          },
          custody: {
            read: async () => ({
              kind: "takoserver.money-cutover-custody@v1",
              phase: "freeze",
              state: "dispatched",
              bindingDigest: marker,
              postDigest: null,
            }),
            readDispatch: async () => {
              throw new Error("dispatch read");
            },
            dispatch: async () => {
              throw new Error("dispatch");
            },
            terminal: async () => {
              throw new Error("terminal");
            },
          },
        },
      ),
    ).rejects.toThrow("already has dispatch custody");
    expect(reads).toBe(0);
  });

  test("production target is refused before custody or provider reads", async () => {
    let reads = 0;
    await expect(
      runIntegrationMoneyUnitCutover(
        {
          action: "status",
          environment: "integration",
          commit: "a".repeat(40),
          throughMigration: "0093",
        },
        { environment: "production" } as never,
        {
          phase: "freeze",
          maintenanceCommit: "b".repeat(40),
          writerEpoch,
          backupPath: "/dev/null",
          stageOriginProof: async () => {
            reads += 1;
            throw new Error("read");
          },
          storageIdentityRead: async () => {
            reads += 1;
            throw new Error("read");
          },
          maintenanceProof: async () => {
            reads += 1;
            throw new Error("read");
          },
          custody: {
            read: async () => {
              reads += 1;
              return null;
            },
            readDispatch: async () => {
              throw new Error("dispatch read");
            },
            dispatch: async () => {
              throw new Error("dispatch");
            },
            terminal: async () => {
              throw new Error("terminal");
            },
          },
        },
      ),
    ).rejects.toThrow("exact integration invocation");
    expect(reads).toBe(0);
  });
});

/** Full local replay snapshot from the genuine fixed conversion fixture, never a native export. */
describe("bounded fresh money table count reads", () => {
  test("grouped counts match every original COUNT and retain all typed bytes and FK reads", async () => {
    const database = new Database(":memory:");
    try {
      const tables = Array.from(
        { length: 130 },
        (_, index) => `count_${String(index).padStart(3, "0")}`,
      );
      const rowCounts: Record<string, number> = {};
      let originalCountReads = 0;
      for (const [index, table] of tables.entries()) {
        database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value)`);
        if (index % 7 !== 0)
          database.exec(
            `INSERT INTO ${table} VALUES (1, NULL), (2, X'0041'), (3, 9007199254740993), (4, 'A' || char(0) || 'B'), (5, 1.0000000000000002)`,
          );
        rowCounts[table] = (
          database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
        ).n;
        originalCountReads++;
      }
      const allDataDigest = await readWholeDatabaseDataDigest(
        reader(database),
        "preflight",
        tables,
      );
      const beforeChanges = database.query("SELECT total_changes() AS n").get();
      const calls: { description: string; sql: string }[] = [];
      const countRows: Record<string, unknown>[] = [];
      await assertMoneyLiveBackupCompleteness(
        {
          async query(_phase, description, query) {
            calls.push({ description, sql: query });
            const rows = database.query(query).all() as Record<string, unknown>[];
            if (description === "native complete table row counts") countRows.push(...rows);
            return rows;
          },
        },
        "preflight",
        { rowCounts, allDataDigest },
      );
      const grouped = calls.filter(
        (call) => call.description === "native complete table row counts",
      );
      expect(originalCountReads).toBe(130);
      expect(grouped).toHaveLength(2);
      expect(countRows).toEqual(
        tables.map((table) => ({ table_name: table, n: rowCounts[table] })),
      );
      const groupedColumns = calls.filter(
        (call) => call.description === "backup grouped table columns",
      );
      const groupedTypedRows = calls.filter(
        (call) => call.description === "backup grouped typed rows",
      );
      expect(groupedColumns).toHaveLength(2);
      expect(groupedTypedRows).toHaveLength(9);
      expect(
        calls.filter((call) => call.description === "native foreign-key integrity"),
      ).toHaveLength(1);
      expect(calls).toHaveLength(15);
      expect(await readWholeDatabaseDataDigest(reader(database), "preflight", tables)).toBe(
        allDataDigest,
      );
      expect(database.query("SELECT total_changes() AS n").get()).toEqual(beforeChanges);
      for (const call of grouped) {
        expect(new TextEncoder().encode(call.sql).byteLength).toBeLessThanOrEqual(90_000);
        expect((call.sql.match(/COUNT\(\*\)/gu) ?? []).length).toBeLessThanOrEqual(128);
        expect(call.sql.includes("?")).toBe(false);
        let depth = 0;
        let maximumDepth = 0;
        for (const character of call.sql) {
          if (character === "(") maximumDepth = Math.max(maximumDepth, ++depth);
          if (character === ")") depth--;
        }
        expect(depth).toBe(0);
        expect(maximumDepth).toBeLessThanOrEqual(20);
      }
    } finally {
      database.close();
    }
  });

  test("missing duplicate reordered extra and noninteger count rows refuse before typed data", async () => {
    const database = new Database(":memory:");
    try {
      database.exec(
        "CREATE TABLE count_a (value); CREATE TABLE count_b (value); INSERT INTO count_a VALUES (1)",
      );
      const rowCounts = { count_a: 1, count_b: 0 };
      const allDataDigest = await readWholeDatabaseDataDigest(
        reader(database),
        "preflight",
        Object.keys(rowCounts),
      );
      const invalid: readonly ((rows: Record<string, unknown>[]) => Record<string, unknown>[])[] = [
        (rows) => rows.slice(1),
        (rows) => [rows[0] ?? {}, rows[0] ?? {}],
        (rows) => [...rows].reverse(),
        (rows) => rows.map((row) => ({ ...row, extra: 0 })),
        (rows) => rows.map((row) => ({ ...row, n: "0" })),
        (rows) => rows.map((row) => ({ ...row, n: -1 })),
        (rows) => rows.map((row) => ({ ...row, n: Number.MAX_SAFE_INTEGER + 1 })),
        (rows) => rows.map((row) => ({ table_name: row.table_name })),
      ];
      for (const replace of invalid) {
        let countReads = 0;
        let typedReads = 0;
        await expect(
          assertMoneyLiveBackupCompleteness(
            {
              async query(_phase, description, query) {
                const rows = database.query(query).all() as Record<string, unknown>[];
                if (description === "native complete table row counts") {
                  countReads++;
                  return replace(rows);
                }
                if (description.startsWith("backup ")) typedReads++;
                return rows;
              },
            },
            "preflight",
            { rowCounts, allDataDigest },
          ),
        ).rejects.toThrow("money live table count");
        expect(countReads).toBe(1);
        expect(typedReads).toBe(0);
      }
    } finally {
      database.close();
    }
  });

  test("long valid identifiers split by SQL bytes without losing any fresh count or typed row", async () => {
    const database = new Database(":memory:");
    try {
      const tables = Array.from(
        { length: 32 },
        (_, index) => `long_${String(index).padStart(3, "0")}_${"x".repeat(3000)}`,
      );
      const rowCounts: Record<string, number> = {};
      for (const table of tables) {
        database.exec(`CREATE TABLE ${table} (value)`);
        rowCounts[table] = 0;
      }
      const allDataDigest = await readWholeDatabaseDataDigest(
        reader(database),
        "preflight",
        tables,
      );
      const countSql: string[] = [];
      let typedReads = 0;
      await assertMoneyLiveBackupCompleteness(
        {
          async query(_phase, description, query) {
            if (description === "native complete table row counts") countSql.push(query);
            if (description.startsWith("backup ")) typedReads++;
            return database.query(query).all() as Record<string, unknown>[];
          },
        },
        "preflight",
        { rowCounts, allDataDigest },
      );
      expect(countSql.length).toBeGreaterThan(1);
      expect(
        countSql.reduce((count, query) => count + (query.match(/COUNT\(\*\)/gu) ?? []).length, 0),
      ).toBe(32);
      expect(countSql.every((query) => new TextEncoder().encode(query).byteLength <= 90_000)).toBe(
        true,
      );
      expect(countSql.every((query) => !query.includes("?"))).toBe(true);
      expect(typedReads).toBe(7);
    } finally {
      database.close();
    }
  });

  test("a zero count never skips typed bytes and late row drift still refuses", async () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE count_empty (value)");
      const allDataDigest = await readWholeDatabaseDataDigest(reader(database), "preflight", [
        "count_empty",
      ]);
      let typedReads = 0;
      let countReads = 0;
      await expect(
        assertMoneyLiveBackupCompleteness(
          {
            async query(_phase, description, query) {
              const rows = database.query(query).all() as Record<string, unknown>[];
              if (description === "native complete table row counts") {
                countReads++;
                database.exec("INSERT INTO count_empty VALUES ('late')");
              }
              if (description.startsWith("backup ")) typedReads++;
              return rows;
            },
          },
          "preflight",
          { rowCounts: { count_empty: 0 }, allDataDigest },
        ),
      ).rejects.toThrow("complete typed row bytes differ");
      expect(countReads).toBe(1);
      expect(typedReads).toBe(2);
    } finally {
      database.close();
    }
  });

  test("grouped complete counts still reach actual foreign-key refusal", async () => {
    const database = new Database(":memory:");
    try {
      database.exec(
        "PRAGMA foreign_keys = OFF; CREATE TABLE count_parent (id INTEGER PRIMARY KEY); CREATE TABLE count_child (parent_id INTEGER REFERENCES count_parent(id)); INSERT INTO count_child VALUES (9)",
      );
      const rowCounts = { count_child: 1, count_parent: 0 };
      const allDataDigest = await readWholeDatabaseDataDigest(
        reader(database),
        "preflight",
        Object.keys(rowCounts),
      );
      await expect(
        assertMoneyLiveBackupCompleteness(reader(database), "verification", {
          rowCounts,
          allDataDigest,
        }),
      ).rejects.toThrow("foreign-key violation");
    } finally {
      database.close();
    }
  });
});

describe("held post94 continuation component", () => {
  test("post94 shares actual convert history without a normal Worker proof and remains blocked", async () => {
    const f = await post94ReadFixture();
    try {
      const read = await f.inspectPost94();
      expect(read).toMatchObject({
        schemaPhase: "0094-fenced",
        historicalWriterEpoch: writerEpoch,
        currentWriterEpoch: writerEpoch,
        continuation: "blocked-financial-port",
        qualification: "component-simulation-only",
        normalHostReady: false,
      });
      expect(f.options.resumeProof).toBeUndefined();
      expect(f.mutations()).toBe(0);
      await expect(
        inspectMoneyUnitResumeState({
          target: f.target,
          options: f.options,
          files,
          database: reader(f.database),
          readSchema: async () => state(f.database),
          backup: f.backup,
        }),
      ).rejects.toThrow("complete resume owner");
    } finally {
      f.close();
    }
  });

  test("post94 refuses a 92 backup relabelled as 94 and keeps original history untouched", async () => {
    const f = await post94ReadFixture();
    try {
      const before = JSON.stringify([...f.bindings]);
      const bytes = normalizeSnapshotDump(Buffer.from(f.originalSql));
      writeFileSync(f.convertedBackupPath, bytes.sql);
      writeFileSync(
        `${f.convertedBackupPath}.identity.json`,
        JSON.stringify({
          ...f.convertedIdentity,
          backupDigest: bytes.digest,
        }),
      );
      await expect(f.inspectPost94()).rejects.toThrow("fixed 0094-fenced");
      expect(JSON.stringify([...f.bindings])).toBe(before);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("post94 preserves UNKNOWN without normal proof, terminalization or replay", async () => {
    const f = await post94ReadFixture();
    try {
      const binding = f.suffixBinding();
      f.bindings.set("suffix98", binding);
      f.receipts.set("suffix98", {
        kind: "takoserver.money-cutover-custody@v1",
        phase: "suffix98",
        state: "dispatched",
        bindingDigest: moneyCutoverBindingDigest(binding),
        postDigest: null,
      });
      expect(await f.inspectPost94()).toMatchObject({
        continuation: "unknown-dispatch",
        normalHostReady: false,
      });
      await expect(
        runIntegrationMoneyUnitCutover(
          {
            action: "apply",
            environment: "integration",
            commit: "a".repeat(40),
            throughMigration: "0098",
          },
          f.target,
          f.options,
        ),
      ).rejects.toThrow("Financial realm transition port");
      expect(f.receipts.get("suffix98")?.state).toBe("dispatched");
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("post94 checks historical old epoch separately from current model98 new epoch", async () => {
    const f = await post94ReadFixture();
    try {
      const binding = f.suffixBinding();
      f.bindings.set("suffix98", binding);
      f.receipts.set("suffix98", {
        kind: "takoserver.money-cutover-custody@v1",
        phase: "suffix98",
        state: "dispatched",
        bindingDigest: moneyCutoverBindingDigest(binding),
        postDigest: null,
      });
      const before = f.receipts.get("convert")?.postDigest;
      applyPost94SchemaModel(f.database, f.nextWriterEpoch);
      const currentTarget = { ...f.target, moneyCutoverWriterEpoch: f.nextWriterEpoch };
      expect(moneyUnitCutoverSchemaMatches(state(f.database), files, "0098-fenced")).toBe(true);
      expect(await f.inspectPost94(currentTarget)).toMatchObject({
        schemaPhase: "0098-fenced",
        historicalWriterEpoch: writerEpoch,
        currentWriterEpoch: f.nextWriterEpoch,
        qualification: "component-simulation-only",
        normalHostReady: false,
      });
      expect(f.receipts.get("convert")?.postDigest).toBe(before);
      f.database.exec("DROP TRIGGER money_cutover_fence_ledger_insert");
      expect(moneyUnitCutoverSchemaMatches(state(f.database), files, "0098-fenced")).toBe(false);
      await expect(f.inspectPost94(currentTarget)).rejects.toThrow("schema and old/new epoch");
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("post94 refuses legacy resume custody and historical epoch drift before effects", async () => {
    const f = await post94ReadFixture();
    try {
      f.advance("resume");
      await expect(f.inspectPost94()).rejects.toThrow("no legacy resume dispatch");
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("post94 detects late retained-history replacement and leaves the original92 backup unchanged", async () => {
    const f = await post94ReadFixture();
    try {
      const originalBytes = readFileSync(f.options.backupPath);
      let origins = 0;
      const options: MoneyUnitCutoverOptions = {
        ...f.options,
        stageOriginProof: async () => {
          const origin = await f.options.stageOriginProof();
          if (++origins === 2) {
            const binding = f.bindings.get("convert");
            if (binding === undefined) throw new Error("missing history");
            f.bindings.set("convert", { ...binding, predecessorCustodyDigest: sha("late drift") });
          }
          return origin;
        },
      };
      await expect(f.inspectPost94(f.target, options)).rejects.toThrow("protected custody changed");
      expect(readFileSync(f.options.backupPath)).toEqual(originalBytes);
      expect(f.mutations()).toBe(0);
    } finally {
      f.close();
    }
  });

  test("post94 source validation remains exact after expected-shape cache warmup", () => {
    const expected = moneyUnitCutoverExpectedShape(files, "0098-fenced");
    expect(expected.length).toBeGreaterThan(0);
    const changed = files.map((file, index) =>
      index === 97 ? { ...file, digest: sha("drift") } : file,
    );
    expect(() => assertMoneyPost94Source(changed)).toThrow();
    expect(() => moneyUnitCutoverExpectedShape(changed, "0098-fenced")).toThrow();
  });

  test("post94 native entry refuses both new phases before any custody provider or backup effects", async () => {
    for (const phase of ["suffix98", "resume98"] as const) {
      const f = await post94ReadFixture();
      try {
        let reads = 0;
        const options: MoneyUnitCutoverOptions = {
          ...f.options,
          phase,
          stageOriginProof: async () => {
            reads++;
            throw new Error("must not read");
          },
          storageIdentityRead: async () => {
            reads++;
            throw new Error("must not read");
          },
          custody: {
            ...f.options.custody,
            read: async () => {
              reads++;
              throw new Error("must not read");
            },
          },
        };
        await expect(
          runIntegrationMoneyUnitCutover(
            {
              action: "apply",
              environment: "integration",
              commit: "a".repeat(40),
              throughMigration: "0098",
            },
            f.target,
            options,
          ),
        ).rejects.toThrow("no export/import/dispatch");
        expect(reads).toBe(0);
        expect(f.mutations()).toBe(0);
      } finally {
        f.close();
      }
    }
  });
});

/** Real reduced SQLite history/export bytes; native commands are controlled component ports. */
