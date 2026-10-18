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
  buildMoneyCutoverImportSql,
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
  readWholeDatabaseDataDigest,
  reconcileMoneyCutoverDispatched,
  runIntegrationMoneyUnitCutover,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
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
async function resumeReadFixture() {
  const database = fixture();
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
  const originalSql = `${buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql}\nINSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta, created_at) VALUES ('fund-1','org-1','funding','credit-1',7,0,'2026-01-01T00:00:00Z');\nINSERT INTO wallet_credit_lots (org_id, ref, kind, amount_minor, expires_at, created_at, cursor_handle) VALUES ('org-1','credit-1','direct',7,NULL,'2026-01-01T00:00:00Z','${cursor.cursor_handle}');\n`;
  const normalized = normalizeSnapshotDump(Buffer.from(originalSql));
  const backup = {
    digest: normalized.digest,
    preimageDigest: await readMoneyPreimageDigest(reader(database), "preflight"),
    aggregateDigest: await readMoneyAggregateDigest(reader(database), "preflight"),
    financialDigest: await readMoneyFrozenDataDigest(reader(database), "preflight"),
    allDataDigest: marker,
    rowCounts: {},
  };
  const classifications = [
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
  ] as const;
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
async function converted94CaptureFixture() {
  const base = await resumeReadFixture();
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
