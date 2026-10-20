// Shared fixtures for the deploy-schema-money-unit-cutover*.test.ts files.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildD1MigrationImport } from "../../scripts/deploy/d1-migration-import.ts";
import { normalizeSnapshotDump } from "../../scripts/deploy/d1-snapshot-restore.ts";
import {
  canonicalSchemaShape,
  type D1SchemaState,
  readMigrationArtifact,
} from "../../scripts/deploy/migrations.ts";
import {
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
  moneyUnitCutoverSourcePrefixDigest,
  readMoneyAggregateDigest,
  readMoneyFrozenDataDigest,
  readMoneyPreimageDigest,
  readWholeDatabaseDataDigest,
} from "../../scripts/deploy/schema-money-unit-cutover.ts";
import type { DeployTarget } from "../../scripts/deploy/target.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  moneyCutoverClassificationTriggerSql,
  moneyCutoverFinancialTriggerSql,
} from "../../src/money-cutover-sql.ts";

export const files = readMigrationArtifact().files;
export const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const opaqueSql = (source: string) => ({
  bytes: Buffer.byteLength(source, "utf8"),
  sha256: sha(source),
});
export const opaqueValue = (value: unknown) => opaqueSql(JSON.stringify(value));
export const marker = sha("local money cutover proof");
export const writerEpoch = sha("reviewed writer generation");

export function fixture(emptyFinancialHistory = false) {
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

export function legacyMoneyStagingTarget(
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

export function state(database: Database): D1SchemaState {
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

export function apply(database: Database, sql: string) {
  database.exec(`BEGIN TRANSACTION;\n${sql}\nCOMMIT;`);
}

export function sql(
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

export const reader = (database: Database) => ({
  async query(_phase: unknown, _description: unknown, query: string) {
    return database.query(query).all() as Record<string, unknown>[];
  },
});

/** Actual fixed SQL and SQLite; native proof/health below are controlled component ports. */
export async function resumeReadFixture(emptyFinancialHistory = false) {
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

export async function post94ReadFixture() {
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
  // This component fixture carries the exact four-file historical capture
  // shape. The separate capture-producer tests exercise the real writer.
  const sourceDigest = moneyUnitCutoverSourcePrefixDigest(files, 94);
  const captureBytes = `${JSON.stringify({
    kind: "takoserver.money-converted94-export-capture@v1",
    accountId: f.target.accountId,
    databaseId: f.target.d1.databaseId,
    databaseName: f.target.d1.databaseName,
    originDigest: sha(JSON.stringify(f.origin)),
    sourceDigest,
    convertBindingDigest: convert.bindingDigest,
    writerEpoch,
    convertedBackupPath,
  })}\n`;
  writeFileSync(`${convertedBackupPath}.capture.json`, captureBytes, { mode: 0o600 });
  const tables = (
    f.database
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations') ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const rowCounts: Record<string, number> = {};
  for (const table of tables)
    rowCounts[table] = (
      f.database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  const completionBytes = `${JSON.stringify({
    kind: "takoserver.money-converted94-export-completion@v1",
    qualification: "component-simulation-only",
    schemaPhase: "0094-fenced",
    convertedBackupPath,
    backupDigest: converted.digest,
    identityDigest: sha(readFileSync(`${convertedBackupPath}.identity.json`, "utf8")),
    captureDigest: sha(captureBytes),
    convertBindingDigest: convert.bindingDigest,
    historicalWriterEpoch: writerEpoch,
    sourceDigest,
    allDataDigest: await readWholeDatabaseDataDigest(reader(f.database), "preflight", tables),
    tableInventory: tables,
    rowCounts,
  })}\n`;
  writeFileSync(`${convertedBackupPath}.capture.complete.json`, completionBytes, {
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
export function applyPost94SchemaModel(database: Database, nextWriterEpoch: string) {
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

export async function converted94CaptureFixture(emptyFinancialHistory = false) {
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
