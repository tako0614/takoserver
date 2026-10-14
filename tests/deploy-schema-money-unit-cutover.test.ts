import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { normalizeSnapshotDump } from "../scripts/deploy/d1-snapshot-restore.ts";
import {
  canonicalSchemaShape,
  type D1SchemaState,
  readMigrationArtifact,
} from "../scripts/deploy/migrations.ts";
import { runD1Schema } from "../scripts/deploy/schema.ts";
import {
  assertMoneyLiveBackupCompleteness,
  assertMoneyNativeForeignKeys,
  buildMoneyCutoverImportSql,
  MONEY_FENCE_TABLES_0092,
  type MoneyCutoverDispatchBinding,
  type MoneyReviewBinding,
  type MoneyStageOriginProof,
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

const files = readMigrationArtifact().files;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const marker = sha("local money cutover proof");
const writerEpoch = sha("reviewed writer generation");

function fixture() {
  const database = new Database(":memory:");
  database.exec(buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql);
  database.exec(
    "INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at) VALUES ('fund-1','org-1','funding','credit-1',7,0,'2026-01-01T00:00:00Z')",
  );
  database.exec(
    "INSERT INTO wallet_credit_lots (org_id, ref, kind, amount_minor, expires_at, created_at) VALUES ('org-1','credit-1','direct',7,NULL,'2026-01-01T00:00:00Z')",
  );
  return database;
}

function state(database: Database): D1SchemaState {
  const applied = (
    database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
  ).map(({ name }) => name);
  const rows = database
    .query(
      "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all() as Record<string, unknown>[];
  const shape = canonicalSchemaShape(rows);
  return { applied, shape, shapeDigest: sha(shape) };
}

function apply(database: Database, sql: string) {
  database.exec(`BEGIN TRANSACTION;\n${sql}\nCOMMIT;`);
}

function sql(
  phase: "freeze" | "prepare" | "classify" | "convert" | "resume" | "abandon",
  classifications: readonly Record<string, unknown>[] = [],
  abandonFrom?: "0092-fenced" | "0093-fenced",
) {
  return buildMoneyCutoverImportSql({
    phase,
    files,
    anchor: marker,
    originDigest: marker,
    backupDigest: marker,
    writerDigest: marker,
    writerEpoch,
    classifications: classifications as never,
    ...(abandonFrom === undefined ? {} : { abandonFrom }),
  });
}

const reader = (database: Database) => ({
  async query(_phase: unknown, _description: unknown, query: string) {
    return database.query(query).all() as Record<string, unknown>[];
  },
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
      const target = {
        environment: "integration",
        accountId,
        d1: { databaseId, databaseName },
        r2: { bucketName: databaseName },
        workerName: databaseName,
        moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
        moneyCutoverWriterEpoch: writerEpoch,
      } as never;
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
    const target = { environment: "integration" } as never;
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
