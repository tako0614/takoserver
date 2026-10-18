import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assertMoneyPost94Source,
  buildMoneyPost94OneImportData as buildActualMoneyPost94OneImportData,
  buildMoneyCutoverImportSql,
  buildMoneyPost94RootImportData,
  buildMoneyPost94SigningGenesisData,
  captureMoneyUnitConverted94Backup,
  inspectMoneyUnitPost94State,
  inspectMoneyUnitResumeState,
  MONEY_FENCE_TABLES_0092,
  type MoneyCutoverCustodyReceipt,
  type MoneyCutoverDispatchBinding,
  type MoneyPost94DispatchBinding,
  type MoneyResumeProof,
  type MoneyReviewBinding,
  type MoneyReviewProof,
  type MoneyStageOriginProof,
  type MoneyUnitCutoverOptions,
  moneyCutoverBindingDigest,
  moneyUnitCutoverExpectedShape,
  moneyUnitCutoverSchemaMatches,
  moneyUnitCutoverSourcePrefixDigest,
  readMoneyAggregateDigest,
  readMoneyFrozenDataDigest,
  readMoneyPreimageDigest,
  readMoneyUnitHeldConvertFacts,
  readWholeDatabaseDataDigest,
  reconcileMoneyCutoverDispatched,
  runIntegrationMoneyHeldSuffix98,
  runIntegrationMoneyUnitCutover,
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
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  createMoneyCutoverSql,
  inspectMoneyCutoverGuard,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  moneyCutoverClassificationTriggerSql,
  moneyCutoverFinancialTriggerSql,
} from "../src/money-cutover-sql.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { assertStripeModeRealm } from "../src/stripe-mode-realm.ts";

const files = readMigrationArtifact().files;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const opaqueSql = (source: string) => ({
  bytes: Buffer.byteLength(source, "utf8"),
  sha256: sha(source),
});
const opaqueValue = (value: unknown) => opaqueSql(JSON.stringify(value));
const marker = sha("local money cutover proof");
const writerEpoch = sha("reviewed writer generation");

function fixture(emptyFinancialHistory = false) {
  const database = new Database(":memory:");
  database.exec(buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql);
  if (!emptyFinancialHistory) {
    database.exec(
      "INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at) VALUES ('fund-1','org-1','funding','credit-1',7,0,'2026-01-01T00:00:00Z')",
    );
    database.exec(
      "INSERT INTO wallet_credit_lots (org_id, ref, kind, amount_minor, expires_at, created_at) VALUES ('org-1','credit-1','direct',7,NULL,'2026-01-01T00:00:00Z')",
    );
  }
  return database;
}

function legacyMoneyStagingTarget(
  accountId = "1".repeat(32),
  databaseId = "11111111-1111-4111-8111-111111111111",
  databaseName = `takoserver-i-${accountId}`,
): DeployTarget {
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId,
    workerName: databaseName,
    publicOrigin: "https://integration-money-host.test.workers.dev",
    d1: { databaseId, databaseName },
    r2: { bucketName: databaseName },
    signing: { currentKeyId: "test-key" },
    moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
    moneyCutoverWriterEpoch: writerEpoch,
  };
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

/** Actual fixed SQL and SQLite; native proof/health below are controlled component ports. */
async function resumeReadFixture(emptyFinancialHistory = false) {
  const database = fixture(emptyFinancialHistory);
  const directory = mkdtempSync(join(tmpdir(), "money-resume-read-component-"));
  const databaseName = `integration-ts-${"a".repeat(32)}`;
  const target: DeployTarget = {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "1".repeat(32),
    workerName: "integration-money-host",
    publicOrigin: "https://integration-money-host.test.workers.dev",
    d1: { databaseId: "11111111-1111-4111-8111-111111111111", databaseName },
    r2: { bucketName: databaseName },
    signing: { currentKeyId: "test-key" },
    moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
    moneyCutoverWriterEpoch: writerEpoch,
  };
  const identity = {
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    databaseName,
    bucketName: databaseName,
  };
  const origin: MoneyStageOriginProof = {
    kind: "takoserver.money-stage-origin@v1",
    state: "terminal",
    ...identity,
    sourceDigest: "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2",
    sourceCommit: "a".repeat(40),
    terminalCustodyDigest: marker,
  };
  const originDigest = sha(JSON.stringify(origin));
  const cursor = database.query("SELECT cursor_handle FROM wallet_credit_lots").get() as {
    cursor_handle: string;
  };
  const originalSql = emptyFinancialHistory
    ? buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql
    : `${buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql}\nINSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at) VALUES ('fund-1','org-1','funding','credit-1',7,0,'2026-01-01T00:00:00Z');\nINSERT INTO wallet_credit_lots (org_id, ref, kind, amount_minor, expires_at, created_at, cursor_handle) VALUES ('org-1','credit-1','direct',7,NULL,'2026-01-01T00:00:00Z','${cursor.cursor_handle}');\n`;
  const normalized = normalizeSnapshotDump(Buffer.from(originalSql));
  const backup = {
    digest: normalized.digest,
    preimageDigest: await readMoneyPreimageDigest(reader(database), "preflight"),
    aggregateDigest: await readMoneyAggregateDigest(reader(database), "preflight"),
    financialDigest: await readMoneyFrozenDataDigest(reader(database), "preflight"),
    allDataDigest: marker,
    rowCounts: {},
  };
  const classifications = emptyFinancialHistory
    ? []
    : ([
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
      ] as const);
  const classificationPath = join(directory, "classifications.json");
  const classificationBytes = `${JSON.stringify(classifications)}\n`;
  writeFileSync(classificationPath, classificationBytes, { mode: 0o600 });
  const native: MoneyResumeProof = {
    kind: "takoserver.money-resume-worker@v1",
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    workerName: target.workerName,
    sourceCommit: "b".repeat(40),
    moduleDigest: marker,
    deploymentId: target.d1.databaseId,
    versionId: target.d1.databaseId,
    trafficPercent: 100,
    writerContainmentPolicy: "transaction-fenced-usd-micros-v1",
    writerEpoch,
    privateScopeDigest: marker,
    privateSourceInventoryDigest: marker,
    privateDependencyClosureDigest: marker,
    privateDeploymentsDigest: marker,
    publicPublicationDigest: marker,
    publicSourceArtifactDigest: marker,
  };
  const anchor = sha(
    JSON.stringify({
      kind: "takoserver.money-freeze-anchor@v1",
      target: identity,
      originDigest,
      backupDigest: backup.digest,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
      financialDigest: backup.financialDigest,
      writerDigest: marker,
      writerEpoch,
      sourceDigest: origin.sourceDigest,
    }),
  );
  const receipts = new Map<string, MoneyCutoverCustodyReceipt>();
  const bindings = new Map<string, MoneyCutoverDispatchBinding>();
  const reviews = new Map<string, MoneyReviewProof>();
  let previous = origin.terminalCustodyDigest;
  const advance = (phase: "freeze" | "prepare" | "classify" | "convert" | "resume") => {
    const beforeShapeDigest = state(database).shapeDigest;
    const sql = buildMoneyCutoverImportSql({
      phase,
      files,
      anchor,
      originDigest,
      backupDigest: backup.digest,
      writerDigest: marker,
      writerEpoch,
      classifications: phase === "freeze" || phase === "prepare" ? [] : classifications,
    });
    const sealedImportPath = join(directory, `${phase}.sql`);
    writeFileSync(sealedImportPath, sql, { mode: 0o600 });
    apply(database, sql);
    const post = state(database);
    const binding: MoneyCutoverDispatchBinding = {
      kind: "takoserver.money-cutover-dispatch@v1",
      phase,
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      databaseName,
      originDigest,
      predecessorCustodyDigest: previous,
      sourceCommit: "c".repeat(40),
      sourceDigest: moneyUnitCutoverSourcePrefixDigest(
        files,
        phase === "convert" || phase === "resume" ? 94 : 93,
      ),
      importDigest: sha(sql),
      backupDigest: backup.digest,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
      classificationDigest:
        phase === "freeze" || phase === "prepare" ? sha("[]\n") : sha(classificationBytes),
      writerDigest: marker,
      resumeDigest: phase === "resume" ? sha(JSON.stringify(native)) : sha("no-resume-worker"),
      writerEpoch,
      reviewDigest: marker,
      beforeShapeDigest,
      afterSchemaPhase:
        phase === "freeze"
          ? "0092-fenced"
          : phase === "resume"
            ? "0094"
            : phase === "convert"
              ? "0094-fenced"
              : "0093-fenced",
      sealedImportPath,
    };
    const reviewBinding: MoneyReviewBinding = {
      kind: "takoserver.money-review-binding@v1",
      phase,
      accountId: binding.accountId,
      databaseId: binding.databaseId,
      originDigest,
      predecessorCustodyDigest: binding.predecessorCustodyDigest,
      sourceCommit: binding.sourceCommit,
      sourceDigest: binding.sourceDigest,
      importDigest: binding.importDigest,
      backupDigest: binding.backupDigest,
      preimageDigest: binding.preimageDigest,
      aggregateDigest: binding.aggregateDigest,
      classificationDigest: binding.classificationDigest,
      writerDigest: binding.writerDigest,
      resumeDigest: binding.resumeDigest,
      writerEpoch,
    };
    const review: MoneyReviewProof = {
      kind: "takoserver.money-independent-review@v1",
      reviewer: "component reviewer",
      reviewRef: "review://component-sqlite-transition",
      bindingDigest: moneyCutoverBindingDigest(reviewBinding),
      evidenceDigest: marker,
    };
    const reviewedBinding = { ...binding, reviewDigest: sha(JSON.stringify(review)) };
    reviews.set(phase, review);
    const receipt: MoneyCutoverCustodyReceipt = {
      kind: "takoserver.money-cutover-custody@v1",
      phase,
      state: "terminal",
      bindingDigest: moneyCutoverBindingDigest(reviewedBinding),
      postDigest: sha(
        JSON.stringify({
          applied: post.applied,
          shapeDigest: post.shapeDigest,
          preimageDigest: backup.preimageDigest,
          aggregateDigest: backup.aggregateDigest,
        }),
      ),
    };
    bindings.set(phase, reviewedBinding);
    receipts.set(phase, receipt);
    previous = sha(JSON.stringify(receipt));
  };
  for (const phase of ["freeze", "prepare", "classify", "convert"] as const) advance(phase);
  let mutations = 0;
  let health: (expected: "guarded" | "healthy") => Promise<void> = async () => {};
  let nativeRead: () => Promise<MoneyResumeProof> = async () => native;
  const queries: string[] = [];
  const options: MoneyUnitCutoverOptions = {
    phase: "resume",
    maintenanceCommit: "d".repeat(40),
    resumeCommit: native.sourceCommit,
    writerEpoch,
    backupPath: join(directory, "backup.sql"),
    classificationManifestPath: classificationPath,
    classificationManifestDigest: sha(classificationBytes),
    stageOriginProof: async () => origin,
    storageIdentityRead: async () => identity,
    maintenanceProof: async () => {
      throw new Error("reader must not require a stale maintenance deployment");
    },
    resumeProof: () => nativeRead(),
    resumeHealthRead: (expected) => health(expected),
    independentReview: async (binding) => reviews.get(binding.phase) ?? null,
    custody: {
      read: async (phase) => receipts.get(phase) ?? null,
      readDispatch: async (phase) => bindings.get(phase) ?? null,
      dispatch: async () => {
        mutations++;
        throw new Error("dispatch");
      },
      terminal: async () => {
        mutations++;
        throw new Error("terminal");
      },
    },
    run: async () => {
      mutations++;
      throw new Error("native command");
    },
  };
  const inspect = () =>
    inspectMoneyUnitResumeState({
      target,
      options,
      files,
      backup,
      database: {
        query: async (_phase, _description, query) => {
          queries.push(query);
          if (!/^(?:SELECT\b|PRAGMA foreign_key_check\b)/u.test(query))
            throw new Error("non-read SQL");
          return database.query(query).all() as Record<string, unknown>[];
        },
      },
      readSchema: async () => state(database),
    });
  return {
    database,
    directory,
    target,
    options,
    backup,
    originalSql,
    origin,
    native,
    receipts,
    bindings,
    queries,
    advance,
    inspect,
    mutations: () => mutations,
    setHealth: (read: typeof health) => {
      health = read;
    },
    setNative: (read: typeof nativeRead) => {
      nativeRead = read;
    },
    close: () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

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
async function post94ReadFixture() {
  const f = await resumeReadFixture();
  const nextWriterEpoch = sha("reviewed post94 successor generation");
  const convert = f.receipts.get("convert");
  if (convert === undefined) throw new Error("missing actual fixture convert custody");
  writeFileSync(f.options.backupPath, normalizeSnapshotDump(Buffer.from(f.originalSql)).sql, {
    mode: 0o600,
  });
  const convertedSql =
    f.originalSql +
    ["freeze", "prepare", "classify", "convert"]
      .map((phase) => {
        const binding = f.bindings.get(phase);
        if (binding === undefined) throw new Error("missing actual fixture sealed SQL");
        return readFileSync(binding.sealedImportPath, "utf8");
      })
      .join("\n");
  const converted = normalizeSnapshotDump(Buffer.from(convertedSql));
  const convertedBackupPath = join(f.directory, "converted94.sql");
  writeFileSync(convertedBackupPath, converted.sql, { mode: 0o600 });
  const convertedIdentity = {
    kind: "takoserver.money-protected-backup@v2",
    accountId: f.target.accountId,
    databaseId: f.target.d1.databaseId,
    databaseName: f.target.d1.databaseName,
    originDigest: sha(JSON.stringify(f.origin)),
    sourceDigest: moneyUnitCutoverSourcePrefixDigest(files, 94),
    backupDigest: converted.digest,
    schemaPhase: "0094-fenced",
    convertBindingDigest: convert.bindingDigest,
    writerEpoch,
  };
  writeFileSync(`${convertedBackupPath}.identity.json`, JSON.stringify(convertedIdentity), {
    mode: 0o600,
  });
  const {
    resumeCommit: _commit,
    resumeProof: _proof,
    resumeHealthRead: _health,
    ...withoutNormal
  } = f.options;
  const options: MoneyUnitCutoverOptions = { ...withoutNormal, phase: "suffix98" };
  const inspect = (
    selectedTarget: DeployTarget = f.target,
    selectedOptions: MoneyUnitCutoverOptions = options,
  ) =>
    inspectMoneyUnitPost94State({
      target: selectedTarget,
      options: selectedOptions,
      files,
      database: reader(f.database),
      backup: f.backup,
      readSchema: async () => state(f.database),
      previousWriterEpoch: writerEpoch,
      nextWriterEpoch,
      convertedBackupPath,
    });
  const suffixBinding = (): MoneyPost94DispatchBinding => {
    const original = f.bindings.get("convert");
    if (original === undefined) throw new Error("missing converted binding");
    // Structural review data only; no protected declaration or held selection is minted.
    const selectionReview = {
      kind: "takoserver.money-post94-selection-review@v1" as const,
      phase: "suffix98" as const,
      accountId: original.accountId,
      databaseId: original.databaseId,
      databaseName: original.databaseName,
      previousWriterEpoch: writerEpoch,
      nextWriterEpoch,
      original92BackupDigest: f.backup.digest,
      converted94BackupDigest: converted.digest,
      convertBindingDigest: convert.bindingDigest,
      selectedStripeMode: "test" as const,
      declarationDigest: sha("component-only suffix selection declaration; never native custody"),
    };
    const sealedImportPath = join(f.directory, "component-only-suffix.sql");
    const bytes = "-- retained structural fixture; no Financial pin or native import\n";
    writeFileSync(sealedImportPath, bytes, { mode: 0o600 });
    return {
      ...original,
      kind: "takoserver.money-cutover-dispatch@v2",
      phase: "suffix98",
      sourceDigest: "sha256:9ba4b09b53f531b787f38b9b65155e12850d05345a432e7ed25ac8841b4fb1f7",
      predecessorCustodyDigest: sha(JSON.stringify(convert)),
      importDigest: sha(bytes),
      writerEpoch,
      previousWriterEpoch: writerEpoch,
      nextWriterEpoch,
      original92BackupDigest: f.backup.digest,
      converted94BackupDigest: converted.digest,
      convertBindingDigest: convert.bindingDigest,
      modePreparationDigest: sha("component structural taint; not a Financial preparation"),
      selectedStripeMode: selectionReview.selectedStripeMode,
      selectionReviewDigest: moneyCutoverBindingDigest(selectionReview),
      afterSchemaPhase: "0098-fenced",
      sealedImportPath,
    };
  };
  return {
    ...f,
    nextWriterEpoch,
    convertedBackupPath,
    convertedIdentity,
    converted,
    options,
    inspectPost94: inspect,
    suffixBinding,
  };
}

/** Canonical suffix plus owned guard model only: deliberately no Financial pin or native proof. */
function applyPost94SchemaModel(database: Database, nextWriterEpoch: string) {
  const freeze = database.query("SELECT * FROM money_cutover_freeze").get() as {
    singleton: number;
    binding_digest: string;
    origin_digest: string;
    backup_digest: string;
    writer_digest: string;
    source_digest: string;
  };
  apply(database, buildD1MigrationImport(files.slice(94, 98), { freshLedger: false }).sql);
  const definitions = [
    ["money_cutover_freeze", MONEY_CUTOVER_FREEZE_DDL],
    [MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE, MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL],
    ["money_cutover_writer_permit", MONEY_CUTOVER_PERMIT_DDL],
    ["money_cutover_permit_epoch_guard", MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL],
    ...MONEY_FENCE_TABLES_0092.flatMap((table) =>
      ["INSERT", "UPDATE", "DELETE"].map((verb) => {
        if (verb !== "INSERT" && verb !== "UPDATE" && verb !== "DELETE") throw new Error("verb");
        return [
          `money_cutover_fence_${table}_${verb.toLowerCase()}`,
          moneyCutoverFinancialTriggerSql(table, verb),
        ];
      }),
    ),
    ...(["INSERT", "UPDATE", "DELETE"] as const).map((verb) => [
      `money_cutover_fence_wallet_credit_lot_classification_proofs_${verb.toLowerCase()}`,
      moneyCutoverClassificationTriggerSql(verb),
    ]),
  ];
  for (const [name, sql] of definitions) {
    if (name === undefined || sql === undefined) throw new Error("guard model");
    if (database.query("SELECT name FROM sqlite_schema WHERE name=?").get(name) === null)
      database.exec(sql);
  }
  if (database.query("SELECT * FROM money_cutover_freeze").get() === null)
    database
      .query("INSERT INTO money_cutover_freeze VALUES (?,?,?,?,?,?)")
      .run(
        freeze.singleton,
        freeze.binding_digest,
        freeze.origin_digest,
        freeze.backup_digest,
        freeze.writer_digest,
        freeze.source_digest,
      );
  database.exec("DELETE FROM money_cutover_authorized_epoch");
  database.query("INSERT INTO money_cutover_authorized_epoch VALUES (1,?)").run(nextWriterEpoch);
}

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
      expect(calls.filter((call) => call.description.endsWith(" columns"))).toHaveLength(130);
      expect(calls.filter((call) => call.description.endsWith(" data"))).toHaveLength(130);
      expect(
        calls.filter((call) => call.description === "native foreign-key integrity"),
      ).toHaveLength(1);
      expect(calls).toHaveLength(264);
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
      expect(typedReads).toBe(64);
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
async function converted94CaptureFixture(emptyFinancialHistory = false) {
  const base = await resumeReadFixture(emptyFinancialHistory);
  const classificationManifestPath = base.options.classificationManifestPath;
  const classificationManifestDigest = base.options.classificationManifestDigest;
  if (classificationManifestPath === undefined || classificationManifestDigest === undefined)
    throw new Error("actual fixture classification selection missing");
  const database = new Database(":memory:");
  database.exec(base.originalSql);
  const target: DeployTarget = {
    ...base.target,
    schemaMaintenanceMode: "pre-wallet-usd-micros-quiesced",
  };
  const identity = {
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    databaseName: target.d1.databaseName,
    bucketName: target.r2.bucketName,
  };
  const writer = {
    kind: "takoserver.money-writer-quiescence@v1" as const,
    mode: "pre-wallet-usd-micros-quiesced" as const,
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    workerName: target.workerName,
    deploymentId: target.d1.databaseId,
    versionId: target.d1.databaseId,
    sourceCommit: "d".repeat(40),
    moduleDigest: marker,
    trafficPercent: 100 as const,
    privateMoneyWriters: 0 as const,
    writerEpoch,
    privateScopeDigest: marker,
    privateSourceInventoryDigest: marker,
    privateDependencyClosureDigest: marker,
    privateDeploymentsDigest: marker,
    publicPublicationDigest: marker,
    publicSourceArtifactDigest: marker,
  };
  const writerDigest = sha(JSON.stringify(writer));
  const originDigest = sha(JSON.stringify(base.origin));
  const anchor = sha(
    JSON.stringify({
      kind: "takoserver.money-freeze-anchor@v1",
      target: identity,
      originDigest,
      backupDigest: base.backup.digest,
      preimageDigest: base.backup.preimageDigest,
      aggregateDigest: base.backup.aggregateDigest,
      financialDigest: base.backup.financialDigest,
      writerDigest,
      writerEpoch,
      sourceDigest: base.origin.sourceDigest,
    }),
  );
  const classifications = JSON.parse(
    readFileSync(base.options.classificationManifestPath ?? "", "utf8"),
  );
  const receipts = new Map<string, MoneyCutoverCustodyReceipt>();
  const bindings = new Map<string, MoneyCutoverDispatchBinding>();
  const reviews = new Map<string, MoneyReviewProof>();
  let predecessor = base.origin.terminalCustodyDigest;
  const imports: string[] = [];
  for (const phase of ["freeze", "prepare", "classify", "convert"] as const) {
    const before = state(database);
    const text = buildMoneyCutoverImportSql({
      phase,
      files,
      anchor,
      originDigest,
      backupDigest: base.backup.digest,
      writerDigest,
      writerEpoch,
      classifications: phase === "freeze" || phase === "prepare" ? [] : classifications,
    });
    const old = base.bindings.get(phase);
    if (old === undefined || old.kind !== "takoserver.money-cutover-dispatch@v1")
      throw new Error("actual fixture legacy phase missing");
    const sealedImportPath = join(base.directory, `capture-${phase}.sql`);
    writeFileSync(sealedImportPath, text, { mode: 0o600 });
    apply(database, text);
    imports.push(text);
    const binding = {
      ...old,
      writerDigest,
      predecessorCustodyDigest: predecessor,
      importDigest: sha(text),
      beforeShapeDigest: before.shapeDigest,
      sealedImportPath,
    };
    const reviewBinding: MoneyReviewBinding = {
      kind: "takoserver.money-review-binding@v1",
      phase,
      accountId: binding.accountId,
      databaseId: binding.databaseId,
      originDigest,
      predecessorCustodyDigest: predecessor,
      sourceCommit: binding.sourceCommit,
      sourceDigest: binding.sourceDigest,
      importDigest: binding.importDigest,
      backupDigest: binding.backupDigest,
      preimageDigest: binding.preimageDigest,
      aggregateDigest: binding.aggregateDigest,
      classificationDigest: binding.classificationDigest,
      writerDigest,
      resumeDigest: binding.resumeDigest,
      writerEpoch,
    };
    const review: MoneyReviewProof = {
      kind: "takoserver.money-independent-review@v1",
      reviewer: "capture component reviewer",
      reviewRef: "review://capture-original-conversion",
      bindingDigest: moneyCutoverBindingDigest(reviewBinding),
      evidenceDigest: marker,
    };
    const reviewed = { ...binding, reviewDigest: sha(JSON.stringify(review)) };
    const after = state(database);
    const receipt: MoneyCutoverCustodyReceipt = {
      kind: "takoserver.money-cutover-custody@v1",
      phase,
      state: "terminal",
      bindingDigest: moneyCutoverBindingDigest(reviewed),
      postDigest: sha(
        JSON.stringify({
          applied: after.applied,
          shapeDigest: after.shapeDigest,
          preimageDigest: base.backup.preimageDigest,
          aggregateDigest: base.backup.aggregateDigest,
        }),
      ),
    };
    bindings.set(phase, reviewed);
    receipts.set(phase, receipt);
    reviews.set(phase, review);
    predecessor = sha(JSON.stringify(receipt));
  }
  const original = normalizeSnapshotDump(Buffer.from(base.originalSql));
  writeFileSync(base.options.backupPath, original.sql, { mode: 0o600 });
  writeFileSync(
    `${base.options.backupPath}.identity.json`,
    `${JSON.stringify({
      kind: "takoserver.money-protected-backup@v1",
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      databaseName: target.d1.databaseName,
      originDigest,
      sourceDigest: base.origin.sourceDigest,
      backupDigest: original.digest,
    })}\n`,
    { mode: 0o600 },
  );
  const convertedSql = normalizeSnapshotDump(
    Buffer.from(base.originalSql + imports.join("\n")),
  ).sql;
  let exports = 0;
  let commands = 0;
  let mutations = 0;
  let exportHook: (() => void) | undefined;
  let writerRead: () => Promise<typeof writer> = async () => writer;
  const options: MoneyUnitCutoverOptions = {
    phase: "convert",
    maintenanceCommit: writer.sourceCommit,
    writerEpoch,
    backupPath: base.options.backupPath,
    outputDirectory: base.directory,
    classificationManifestPath,
    classificationManifestDigest,
    stageOriginProof: async () => base.origin,
    storageIdentityRead: async () => identity,
    maintenanceProof: () => writerRead(),
    independentReview: async (binding) => reviews.get(binding.phase) ?? null,
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "synthetic-component-token-not-live" },
    custody: {
      read: async (phase) => receipts.get(phase) ?? null,
      readDispatch: async (phase) => bindings.get(phase) ?? null,
      dispatch: async () => {
        mutations++;
        throw new Error("unexpected dispatch");
      },
      terminal: async () => {
        mutations++;
        throw new Error("unexpected terminal");
      },
    },
    run: async (command) => {
      commands++;
      if (command.includes("export")) {
        exports++;
        const path = command[command.indexOf("--output") + 1];
        if (typeof path !== "string") throw new Error("missing actual export path");
        writeFileSync(path, convertedSql, { mode: 0o600 });
        exportHook?.();
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const text = command[command.indexOf("--command") + 1];
      if (
        !command.includes("execute") ||
        typeof text !== "string" ||
        !/^(?:SELECT\b|PRAGMA\b)/u.test(text)
      )
        throw new Error("unexpected non-read native command");
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ success: true, results: database.query(text).all() }]),
        stderr: "",
      };
    },
  };
  const convertedBackupPath = join(base.directory, "captured94.sql");
  return {
    ...base,
    database,
    target,
    options,
    writer,
    receipts,
    bindings,
    convertedBackupPath,
    capture: () => captureMoneyUnitConverted94Backup({ target, options, convertedBackupPath }),
    exports: () => exports,
    commands: () => commands,
    mutations: () => mutations,
    setExportHook: (hook: () => void) => {
      exportHook = hook;
    },
    setWriter: (read: typeof writerRead) => {
      writerRead = read;
    },
    close: () => {
      database.close();
      base.close();
    },
  };
}

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
  const prepare = async () => {
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
