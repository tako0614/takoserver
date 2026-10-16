import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE,
  MONEY_CUTOVER_FINANCIAL_TABLES,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  MONEY_CUTOVER_PERMIT_TABLE,
  MONEY_CUTOVER_WRITER_EPOCH_PATTERN,
  moneyCutoverClassificationTriggerSql,
  moneyCutoverFinancialTriggerSql,
} from "../../src/money-cutover-sql.ts";
import { applicationSchemaMatches, canonicalApplicationShape } from "./application-schema-shape.ts";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { buildD1MigrationImport } from "./d1-migration-import.ts";
import { normalizeSnapshotDump } from "./d1-snapshot-restore.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  canonicalSchemaShape,
  type D1SchemaState,
  type MigrationFile,
  readD1SchemaState,
  readMigrationArtifact,
} from "./migrations.ts";
import {
  type CommandResult,
  REPOSITORY,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { qualifySource, sealDirectory } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { acquireWranglerVersionPublicationLease } from "./wrangler-state.ts";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STAGE_NAME = /^takoserver-i-[0-9a-f]{32}$/u;
const SOURCE_0092 = "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2";
const SOURCE_0093_FILE = "0093_wallet_credit_classification_proofs.sql";
const SOURCE_0094_FILE = "0094_wallet_usd_micros.sql";
const SOURCE_0093_SHA = "sha256:fc0307e23ee2f80e3eb96da21db7ea065ba7a04d5c582191c34bdf9d4afc3037";
const SOURCE_0094_SHA = "sha256:7ce85b52626f6cbef6e06484e9cddb5052fab76f9718fea279108e2db6da8e44";
const SOURCE_0098 = "sha256:9ba4b09b53f531b787f38b9b65155e12850d05345a432e7ed25ac8841b4fb1f7";
const MAX_CLASSIFICATIONS = 1000;

/** Every predecessor table through which the public Host can start or finish a financial mutation. */
export const MONEY_FENCE_TABLES_0092 = MONEY_CUTOVER_FINANCIAL_TABLES;
const CLASSIFICATION_TABLE = "wallet_credit_lot_classification_proofs";
const FENCE_TABLE = "money_cutover_freeze";
const FENCE_DDL = MONEY_CUTOVER_FREEZE_DDL;
const verbs = ["INSERT", "UPDATE", "DELETE"] as const;

export type MoneyLegacyCutoverPhase =
  | "freeze"
  | "prepare"
  | "classify"
  | "convert"
  | "resume"
  | "abandon";
export type MoneyPost94Phase = "suffix98" | "resume98";
export type MoneyCutoverPhase = MoneyLegacyCutoverPhase | MoneyPost94Phase;
export type MoneySchemaPhase =
  | "0092"
  | "0092-fenced"
  | "0093"
  | "0093-fenced"
  | "0094"
  | "0094-fenced"
  | "0098"
  | "0098-fenced";

export interface MoneyUnitCutoverInvocation {
  readonly action: "status" | "apply";
  readonly environment: "integration";
  readonly commit: string;
  readonly throughMigration: "0093" | "0094" | "0098";
}

export interface MoneyStageOriginProof {
  readonly kind: "takoserver.money-stage-origin@v1";
  readonly state: "terminal";
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly bucketName: string;
  readonly sourceDigest: typeof SOURCE_0092;
  readonly sourceCommit: string;
  readonly terminalCustodyDigest: string;
}

export interface MoneyWriterProof {
  readonly kind: "takoserver.money-writer-quiescence@v1";
  readonly mode: "pre-wallet-usd-micros-quiesced";
  readonly accountId: string;
  readonly databaseId: string;
  readonly workerName: string;
  readonly deploymentId: string;
  readonly versionId: string;
  readonly sourceCommit: string;
  readonly moduleDigest: string;
  readonly trafficPercent: 100;
  readonly privateMoneyWriters: 0;
  readonly writerEpoch: string;
  readonly privateScopeDigest: string;
  readonly privateSourceInventoryDigest: string;
  readonly privateDependencyClosureDigest: string;
  readonly privateDeploymentsDigest: string;
  readonly publicPublicationDigest: string;
  readonly publicSourceArtifactDigest: string;
}

export interface MoneyResumeProof {
  readonly kind: "takoserver.money-resume-worker@v1";
  readonly accountId: string;
  readonly databaseId: string;
  readonly workerName: string;
  readonly sourceCommit: string;
  readonly moduleDigest: string;
  readonly deploymentId: string;
  readonly versionId: string;
  readonly trafficPercent: 100;
  /** Stable native Version policy; phase health is checked separately. */
  readonly writerContainmentPolicy: "transaction-fenced-usd-micros-v1";
  readonly writerEpoch: string;
  readonly privateScopeDigest: string;
  readonly privateSourceInventoryDigest: string;
  readonly privateDependencyClosureDigest: string;
  readonly privateDeploymentsDigest: string;
  readonly publicPublicationDigest: string;
  readonly publicSourceArtifactDigest: string;
}

export interface MoneyReviewBinding {
  readonly kind: "takoserver.money-review-binding@v1";
  readonly phase: MoneyLegacyCutoverPhase;
  readonly accountId: string;
  readonly databaseId: string;
  readonly originDigest: string;
  readonly predecessorCustodyDigest: string;
  readonly sourceCommit: string;
  readonly sourceDigest: string;
  readonly importDigest: string;
  readonly backupDigest: string;
  readonly preimageDigest: string;
  readonly aggregateDigest: string;
  readonly classificationDigest: string;
  readonly writerDigest: string;
  readonly resumeDigest: string;
  readonly writerEpoch: string;
}

export interface MoneyReviewProof {
  readonly kind: "takoserver.money-independent-review@v1";
  readonly reviewer: string;
  readonly reviewRef: string;
  readonly bindingDigest: string;
  readonly evidenceDigest: string;
}

export interface MoneyLegacyCutoverDispatchBinding {
  readonly kind: "takoserver.money-cutover-dispatch@v1";
  readonly phase: MoneyLegacyCutoverPhase;
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly originDigest: string;
  readonly predecessorCustodyDigest: string;
  readonly sourceCommit: string;
  readonly sourceDigest: string;
  readonly importDigest: string;
  readonly backupDigest: string;
  readonly preimageDigest: string;
  readonly aggregateDigest: string;
  readonly classificationDigest: string;
  readonly writerDigest: string;
  readonly resumeDigest: string;
  readonly writerEpoch: string;
  readonly reviewDigest: string;
  readonly beforeShapeDigest: string;
  readonly afterSchemaPhase: Exclude<MoneySchemaPhase, "0098" | "0098-fenced">;
  readonly sealedImportPath: string;
}

/** Retained data only: a binding cannot supply the missing Financial transition authority. */
export interface MoneyPost94DispatchBinding
  extends Omit<MoneyLegacyCutoverDispatchBinding, "kind" | "phase" | "afterSchemaPhase"> {
  readonly kind: "takoserver.money-cutover-dispatch@v2";
  readonly phase: MoneyPost94Phase;
  readonly afterSchemaPhase: "0098" | "0098-fenced";
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
  readonly original92BackupDigest: string;
  readonly converted94BackupDigest: string;
  readonly convertBindingDigest: string;
  readonly modePreparationDigest: string;
}

export type MoneyCutoverDispatchBinding =
  | MoneyLegacyCutoverDispatchBinding
  | MoneyPost94DispatchBinding;

export interface MoneyCutoverCustodyReceipt {
  readonly kind: "takoserver.money-cutover-custody@v1";
  readonly phase: MoneyCutoverPhase;
  readonly state: "dispatched" | "terminal";
  readonly bindingDigest: string;
  readonly postDigest: string | null;
}

export interface MoneyCutoverCustody {
  read(phase: MoneyCutoverPhase): Promise<MoneyCutoverCustodyReceipt | null>;
  /** Exact immutable dispatch body, retained separately from the no-overwrite receipt. */
  readDispatch(phase: MoneyCutoverPhase): Promise<MoneyCutoverDispatchBinding | null>;
  dispatch(binding: MoneyCutoverDispatchBinding): Promise<MoneyCutoverCustodyReceipt>;
  terminal(
    binding: MoneyCutoverDispatchBinding,
    postDigest: string,
  ): Promise<MoneyCutoverCustodyReceipt>;
}

export interface MoneyStorageIdentity {
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly bucketName: string;
}

export interface MoneyUnitCutoverOptions {
  readonly phase: MoneyCutoverPhase;
  readonly maintenanceCommit: string;
  readonly writerEpoch: string;
  readonly resumeCommit?: string;
  readonly stageOriginProof: () => Promise<MoneyStageOriginProof>;
  /** Native GET implementation is supplied by the owning deploy adapter, never by declaration data. */
  readonly storageIdentityRead: () => Promise<MoneyStorageIdentity>;
  /** Must inspect the published native Version, selected source bytes, bindings and 100% deployment. */
  readonly maintenanceProof: () => Promise<MoneyWriterProof>;
  readonly resumeProof?: () => Promise<MoneyResumeProof>;
  /** Exact staged 503 before row deletion, exact healthy product after it. */
  readonly resumeHealthRead?: (expected: "guarded" | "healthy") => Promise<void>;
  readonly independentReview?: (binding: MoneyReviewBinding) => Promise<MoneyReviewProof | null>;
  readonly custody: MoneyCutoverCustody;
  readonly backupPath: string;
  readonly classificationManifestPath?: string;
  readonly classificationManifestDigest?: string;
  readonly sourceDirectory?: string;
  readonly outputDirectory?: string;
  readonly leaseRoot?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly run?: (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>> },
  ) => Promise<CommandResult>;
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sourcePrefixDigest(files: readonly MigrationFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = readFileSync(file.path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.digest) {
      throw preflightError("money cutover migration source changed after inventory");
    }
    hash.update(file.name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** The reviewed prefix bytes; callers select 92, 93 or 94 explicitly. */
export function moneyUnitCutoverSourcePrefixDigest(
  files: readonly MigrationFile[],
  through: 92 | 93 | 94,
): string {
  assertMoneyCutoverSource(files);
  return sourcePrefixDigest(files.slice(0, through));
}

/** 0095 may be present in the audited inventory; it cannot enter this fixed wave. */
export function assertMoneyCutoverSource(files: readonly MigrationFile[]): void {
  if (
    files.length < 94 ||
    files[91]?.name !== "0092_org_wallet_lifecycle.sql" ||
    sourcePrefixDigest(files.slice(0, 92)) !== SOURCE_0092 ||
    files[92]?.name !== SOURCE_0093_FILE ||
    files[92].digest !== SOURCE_0093_SHA ||
    files[93]?.name !== SOURCE_0094_FILE ||
    files[93].digest !== SOURCE_0094_SHA
  ) {
    throw preflightError("money cutover requires the fixed audited 0092/0093/0094 source prefix");
  }
  sourcePrefixDigest(files.slice(92, 94));
}

/** Only the immutable existing suffix; this validates source bytes, never a realm or applied state. */
export function assertMoneyPost94Source(files: readonly MigrationFile[]): void {
  assertMoneyCutoverSource(files);
  if (
    files.length < 98 ||
    files.slice(94, 98).some((file, index) => !file.name.startsWith(`00${95 + index}_`)) ||
    sourcePrefixDigest(files.slice(0, 98)) !== SOURCE_0098
  )
    throw preflightError("money suffix requires the exact immutable fixed0098 source prefix");
}

function fenceTables(phase: MoneySchemaPhase): readonly string[] {
  return phase.startsWith("0092")
    ? MONEY_FENCE_TABLES_0092
    : [...MONEY_FENCE_TABLES_0092, CLASSIFICATION_TABLE];
}

export function moneyFenceTriggerName(table: string, verb: (typeof verbs)[number]): string {
  return `money_cutover_fence_${table}_${verb.toLowerCase()}`;
}

function fenceTriggerSql(table: string, verb: (typeof verbs)[number]): string {
  return table === CLASSIFICATION_TABLE
    ? moneyCutoverClassificationTriggerSql(verb)
    : moneyCutoverFinancialTriggerSql(table, verb);
}

export function moneyFenceInstallSql(phase: MoneySchemaPhase): string {
  return fenceTables(phase)
    .flatMap((table) => verbs.map((verb) => `${fenceTriggerSql(table, verb)};`))
    .join("\n");
}

export function moneyFenceDropSql(phase: MoneySchemaPhase): string {
  return fenceTables(phase)
    .flatMap((table) => verbs.map((verb) => `DROP TRIGGER ${moneyFenceTriggerName(table, verb)};`))
    .join("\n");
}

let expectedShapeCache: {
  readonly prefixDigest: string;
  readonly shapes: ReadonlyMap<MoneySchemaPhase, string>;
} | null = null;

export function moneyUnitCutoverExpectedShape(
  files: readonly MigrationFile[],
  phase: MoneySchemaPhase,
): string {
  if (phase === "0098" || phase === "0098-fenced") return moneyPost94ExpectedShape(files);
  assertMoneyCutoverSource(files);
  const prefixDigest = sourcePrefixDigest(files.slice(0, 94));
  const cached =
    expectedShapeCache?.prefixDigest === prefixDigest
      ? expectedShapeCache.shapes.get(phase)
      : undefined;
  if (cached !== undefined) return cached;
  const database = new Database(":memory:");
  try {
    const shapes = new Map<MoneySchemaPhase, string>();
    const shape = (): string => {
      const rows = database
        .query(
          "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Record<string, unknown>[];
      return canonicalSchemaShape(rows);
    };
    for (const [index, file] of files.slice(0, 94).entries()) {
      database.exec(readFileSync(file.path, "utf8"));
      const count = index + 1;
      if (count !== 92 && count !== 93 && count !== 94) continue;
      const plain = `00${count}` as MoneySchemaPhase;
      const fenced = `${plain}-fenced` as MoneySchemaPhase;
      if (count === 94) {
        database.exec(
          `${FENCE_DDL};\n${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};\n${MONEY_CUTOVER_PERMIT_DDL};\n${MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL};\n${moneyFenceInstallSql("0094-fenced")}`,
        );
      }
      shapes.set(plain, shape());
      database.exec("SAVEPOINT money_cutover_expected_fence");
      if (count !== 94) {
        database.exec(
          `${FENCE_DDL};\n${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};\n${MONEY_CUTOVER_PERMIT_DDL};\n${MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL};\n${moneyFenceInstallSql(fenced)}`,
        );
      }
      shapes.set(fenced, shape());
      database.exec(
        "ROLLBACK TO money_cutover_expected_fence; RELEASE money_cutover_expected_fence",
      );
    }
    if (shapes.size !== 6 || !shapes.has(phase)) {
      throw preflightError("money cutover expected schema reconstruction is incomplete");
    }
    expectedShapeCache = { prefixDigest, shapes };
    return shapes.get(phase) as string;
  } finally {
    database.close();
  }
}

let post94ExpectedShapeCache: { readonly sourceDigest: string; readonly shape: string } | null =
  null;

function moneyPost94ExpectedShape(files: readonly MigrationFile[]): string {
  assertMoneyPost94Source(files);
  if (post94ExpectedShapeCache?.sourceDigest === SOURCE_0098) return post94ExpectedShapeCache.shape;
  const database = new Database(":memory:");
  try {
    database.exec(buildD1MigrationImport(files.slice(0, 94), { freshLedger: true }).sql);
    database.exec(
      `${FENCE_DDL};\n${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};\n${MONEY_CUTOVER_PERMIT_DDL};\n${MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL};\n${moneyFenceInstallSql("0094-fenced")}`,
    );
    database.exec(buildD1MigrationImport(files.slice(94, 98), { freshLedger: false }).sql);
    // 0095 removes the original money guards. Restore the same owned definitions;
    // schema equality says nothing about freeze rows, epochs or Financial mode eligibility.
    const definitions = [
      [FENCE_TABLE, FENCE_DDL],
      [MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE, MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL],
      [MONEY_CUTOVER_PERMIT_TABLE, MONEY_CUTOVER_PERMIT_DDL],
      ["money_cutover_permit_epoch_guard", MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL],
      ...fenceTables("0098-fenced").flatMap((table) =>
        verbs.map((verb) => [moneyFenceTriggerName(table, verb), fenceTriggerSql(table, verb)]),
      ),
    ] as const;
    for (const [name, sql] of definitions) {
      if (name === undefined || sql === undefined)
        throw preflightError("money suffix guard definition is incomplete");
      const existing = database.query("SELECT sql FROM sqlite_schema WHERE name = ?").get(name) as {
        sql: string;
      } | null;
      if (existing === null) database.exec(sql);
      else if (existing.sql !== sql)
        throw preflightError("money suffix changes an existing owned guard definition");
    }
    const canonicalShape = canonicalSchemaShape(
      database
        .query(
          "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as Record<string, unknown>[],
    );
    const shape = canonicalApplicationShape({
      applied: [],
      shape: canonicalShape,
      shapeDigest: digest(canonicalShape),
    });
    post94ExpectedShapeCache = { sourceDigest: SOURCE_0098, shape };
    return shape;
  } finally {
    database.close();
  }
}

/** Exact application schema, including owned persistent freeze metadata and every abort trigger. */
export function moneyUnitCutoverSchemaMatches(
  state: D1SchemaState,
  sourceFiles: readonly MigrationFile[],
  phase: MoneySchemaPhase,
): boolean {
  try {
    assertMoneyCutoverSource(sourceFiles);
    const count = Number(phase.slice(0, 4));
    if (
      state.applied.length !== count ||
      !state.applied.every((name, index) => name === sourceFiles[index]?.name)
    )
      return false;
    return applicationSchemaMatches(state, moneyUnitCutoverExpectedShape(sourceFiles, phase));
  } catch {
    return false;
  }
}

export function moneyCutoverBindingDigest(
  binding: MoneyCutoverDispatchBinding | MoneyReviewBinding,
): string {
  return digest(JSON.stringify(binding));
}

interface PreimageColumn {
  readonly table: string;
  readonly key: string;
  readonly column: string;
}

const PREIMAGE_COLUMNS: readonly PreimageColumn[] = [
  { table: "ledger", key: "id", column: "settled_delta" },
  { table: "ledger", key: "id", column: "held_delta" },
  { table: "wallet_credit_lots", key: "json_array(org_id, ref)", column: "amount_minor" },
  {
    table: "wallet_credit_allocations",
    key: "json_array(org_id, debit_type, debit_ref, lot_ref)",
    column: "amount_minor",
  },
  { table: "org_wallet_holds", key: "json_array(org_id, ref)", column: "amount_minor" },
  { table: "org_wallet_holds", key: "json_array(org_id, ref)", column: "captured_minor" },
  { table: "org_wallet_holds", key: "json_array(org_id, ref)", column: "released_minor" },
  { table: "org_wallet_usage_records", key: "json_array(org_id, ref)", column: "amount_minor" },
  { table: "org_wallet_grant_snapshots", key: "json_array(org_id, ref)", column: "amount_minor" },
  { table: "org_wallet_monthly_tariffs", key: "month", column: "amount_minor" },
];

interface PreimageReader {
  query(
    phase: DeployPhase,
    description: string,
    sql: string,
  ): Promise<readonly Record<string, unknown>[]>;
}

/** Keep one snapshot while limiting each compound SELECT to two terms for D1. */
function moneyProofUnionSql(selects: readonly string[]): string {
  if (selects.length === 0) throw preflightError("money proof source has no SELECT terms");
  if (selects.length === 1) return selects[0] as string;
  const middle = Math.ceil(selects.length / 2);
  return `SELECT * FROM (${moneyProofUnionSql(selects.slice(0, middle))}) UNION ALL SELECT * FROM (${moneyProofUnionSql(selects.slice(middle))})`;
}

/** Bounded, value-free digest of every old-unit row the 0094 SQL copies and scales. */
export async function readMoneyPreimageDigest(
  database: PreimageReader,
  phase: DeployPhase,
  converted = false,
): Promise<string> {
  const hash = createHash("sha256");
  if (converted) {
    const rows = await database.query(
      phase,
      "0094 preserved preimage",
      "SELECT source_table, row_key, source_column, CAST(amount_minor AS TEXT) AS amount FROM money_cutover_preimage ORDER BY source_table, row_key, source_column LIMIT 10001",
    );
    if (rows.length > 10000)
      throw proofError(phase, "0094 preimage exceeds the bounded proof volume");
    for (const row of rows) hash.update(exactPreimageRow(row, phase));
  } else {
    const sql = moneyProofUnionSql(
      PREIMAGE_COLUMNS.map(
        (spec) =>
          `SELECT ${sqlLiteral(spec.table)} AS source_table, ${spec.key} AS row_key, ${sqlLiteral(spec.column)} AS source_column, CAST(${spec.column} AS TEXT) AS amount FROM ${spec.table}`,
      ),
    );
    const rows = await database.query(
      phase,
      "0092 conversion preimage",
      `SELECT * FROM (${sql}) ORDER BY source_table, row_key, source_column LIMIT 10001`,
    );
    if (rows.length > 10000)
      throw proofError(phase, "0092 conversion preimage exceeds the bounded proof volume");
    for (const row of rows) hash.update(exactPreimageRow(row, phase));
  }
  return `sha256:${hash.digest("hex")}`;
}

/** External 0092 snapshot and SQL94's persisted Organization totals must agree exactly. */
export async function readMoneyAggregateDigest(
  database: PreimageReader,
  phase: DeployPhase,
  converted = false,
): Promise<string> {
  const sql = converted
    ? "SELECT source_table, org_id, source_column, CAST(total_minor AS TEXT) AS total FROM money_cutover_aggregates ORDER BY source_table, org_id, source_column LIMIT 10001"
    : `SELECT * FROM (${moneyProofUnionSql(PREIMAGE_COLUMNS.map((spec) => `SELECT ${sqlLiteral(spec.table)} AS source_table, ${spec.table === "org_wallet_monthly_tariffs" ? "'*'" : "org_id"} AS org_id, ${sqlLiteral(spec.column)} AS source_column, CAST(SUM(${spec.column}) AS TEXT) AS total FROM ${spec.table} GROUP BY ${spec.table === "org_wallet_monthly_tariffs" ? "'*'" : "org_id"}`))}) ORDER BY source_table, org_id, source_column LIMIT 10001`;
  const rows = await database.query(phase, "money aggregate conservation", sql);
  if (rows.length > 10000) throw proofError(phase, "money aggregate proof exceeds bounded volume");
  const hash = createHash("sha256");
  for (const row of rows) {
    if (
      typeof row.source_table !== "string" ||
      typeof row.org_id !== "string" ||
      typeof row.source_column !== "string" ||
      typeof row.total !== "string" ||
      !/^-?(?:0|[1-9][0-9]*)$/u.test(row.total)
    ) {
      throw proofError(phase, "money aggregate proof returned malformed exact integer");
    }
    hash
      .update(JSON.stringify([row.source_table, row.org_id, row.source_column, row.total]))
      .update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function exactPreimageRow(row: Record<string, unknown>, phase: DeployPhase): string {
  for (const field of ["source_table", "row_key", "source_column", "amount"] as const) {
    if (typeof row[field] !== "string")
      throw proofError(phase, `money preimage returned malformed ${field}`);
  }
  const amount = row.amount as string;
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(amount))
    throw proofError(phase, "money preimage amount is not an exact integer");
  return `${JSON.stringify([row.source_table, row.row_key, row.source_column, amount])}\n`;
}

function proofError(phase: DeployPhase, message: string): Error {
  return phase === "verification" ? verificationError(message) : preflightError(message);
}

interface ClassificationRow {
  readonly org_id: string;
  readonly ref: string;
  readonly original_kind: "direct" | "plan-included";
  readonly original_amount_minor: string;
  readonly original_expires_at: string | null;
  readonly consumption_class: "free" | "subscription" | "purchased";
  readonly evidence_ref: string;
  readonly reviewed_at: string;
}

function readProtectedClassifications(
  path: string,
  expectedDigest: string,
): readonly ClassificationRow[] {
  const bytes = readProtectedBytes(path, "classification manifest");
  if (!SHA256.test(expectedDigest) || digest(bytes) !== expectedDigest) {
    throw preflightError("classification manifest digest differs from the declaration");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw preflightError("classification manifest is invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_CLASSIFICATIONS) {
    throw preflightError("classification manifest exceeds the bounded review volume");
  }
  const rows: ClassificationRow[] = [];
  for (const value of parsed) {
    if (
      !record(value) ||
      Object.keys(value).sort().join(",") !==
        "consumption_class,evidence_ref,org_id,original_amount_minor,original_expires_at,original_kind,ref,reviewed_at" ||
      typeof value.org_id !== "string" ||
      typeof value.ref !== "string" ||
      !["direct", "plan-included"].includes(String(value.original_kind)) ||
      !["free", "subscription", "purchased"].includes(String(value.consumption_class)) ||
      (value.original_kind === "plan-included" && value.consumption_class === "purchased") ||
      typeof value.original_amount_minor !== "string" ||
      !/^[1-9][0-9]*$/u.test(value.original_amount_minor) ||
      BigInt(value.original_amount_minor) > 900719925474n ||
      (value.original_expires_at !== null && typeof value.original_expires_at !== "string") ||
      typeof value.evidence_ref !== "string" ||
      value.evidence_ref.length < 16 ||
      value.evidence_ref.length > 512 ||
      typeof value.reviewed_at !== "string" ||
      value.reviewed_at.length === 0
    ) {
      throw preflightError("classification manifest contains a malformed reviewed row");
    }
    rows.push(value as unknown as ClassificationRow);
  }
  const keys = rows.map((row) => JSON.stringify([row.org_id, row.ref]));
  if (
    new Set(keys).size !== keys.length ||
    JSON.stringify(keys) !== JSON.stringify([...keys].sort())
  ) {
    throw preflightError("classification manifest must be unique and sorted by exact lot key");
  }
  return rows;
}

async function assertClassificationMatchesLots(
  database: PreimageReader,
  rows: readonly ClassificationRow[],
  phase: DeployPhase,
): Promise<void> {
  const actual = await database.query(
    phase,
    "0093 non-purchased lot inventory",
    "SELECT org_id, ref, kind, CAST(amount_minor AS TEXT) AS amount_minor, expires_at FROM wallet_credit_lots WHERE kind <> 'purchased' ORDER BY org_id, ref LIMIT 1001",
  );
  if (actual.length > 1000 || actual.length !== rows.length)
    throw proofError(phase, "classification does not cover every non-purchased lot exactly");
  for (const [index, lot] of actual.entries()) {
    const proof = rows[index];
    if (
      !proof ||
      lot.org_id !== proof.org_id ||
      lot.ref !== proof.ref ||
      lot.kind !== proof.original_kind ||
      lot.amount_minor !== proof.original_amount_minor ||
      lot.expires_at !== proof.original_expires_at
    ) {
      throw proofError(phase, "classification source does not match the frozen lot preimage");
    }
  }
}

async function assertClassificationsStored(
  database: PreimageReader,
  rows: readonly ClassificationRow[],
  phase: DeployPhase,
): Promise<void> {
  const actual = await database.query(
    phase,
    "0093 reviewed classification readback",
    "SELECT org_id, ref, original_kind, CAST(original_amount_minor AS TEXT) AS original_amount_minor, original_expires_at, consumption_class, evidence_ref, reviewed_at FROM wallet_credit_lot_classification_proofs ORDER BY org_id, ref LIMIT 1001",
  );
  if (
    actual.length !== rows.length ||
    actual.length > 1000 ||
    JSON.stringify(actual) !== JSON.stringify(rows)
  ) {
    throw proofError(phase, "reviewed classification readback differs from the protected manifest");
  }
}

function readProtectedBytes(path: string, label: string): Buffer {
  if (!isAbsolute(path) || relative(REPOSITORY, path).startsWith("..") === false) {
    throw preflightError(`${label} must be an absolute path outside the repository`);
  }
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw preflightError(`${label} is unavailable`);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw preflightError(`${label} must be an owned link-free 0600 file`);
  }
  assertProtectedDirectory(dirname(path), label);
  return readFileSync(path);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact financial table rows, including receipt and pending-state fields, without emitting values. */
export async function readMoneyFrozenDataDigest(
  database: PreimageReader,
  phase: DeployPhase,
): Promise<string> {
  return readWholeDatabaseDataDigest(database, phase, MONEY_FENCE_TABLES_0092);
}

function localReader(database: Database): PreimageReader {
  return {
    async query(_phase, _description, sql) {
      return database.query(sql).all() as Record<string, unknown>[];
    },
  };
}

function assertStageTarget(
  target: DeployTarget,
  origin: MoneyStageOriginProof,
  live: MoneyStorageIdentity,
  originalRead = false,
): void {
  if (
    target.environment !== "integration" ||
    !(
      STAGE_NAME.test(target.d1.databaseName) ||
      (originalRead && /^integration-ts-[0-9a-f]{32}$/u.test(target.d1.databaseName))
    ) ||
    target.r2.bucketName !== target.d1.databaseName ||
    !UUID.test(target.d1.databaseId) ||
    !/^[0-9a-f]{32}$/u.test(target.accountId) ||
    origin.kind !== "takoserver.money-stage-origin@v1" ||
    origin.state !== "terminal" ||
    origin.sourceDigest !== SOURCE_0092 ||
    !COMMIT.test(origin.sourceCommit) ||
    !SHA256.test(origin.terminalCustodyDigest) ||
    origin.accountId !== target.accountId ||
    origin.databaseId !== target.d1.databaseId ||
    origin.databaseName !== target.d1.databaseName ||
    origin.bucketName !== target.r2.bucketName ||
    !record(live) ||
    Object.keys(live).sort().join(",") !== "accountId,bucketName,databaseId,databaseName" ||
    live.accountId !== target.accountId ||
    live.databaseId !== target.d1.databaseId ||
    live.databaseName !== target.d1.databaseName ||
    live.bucketName !== target.r2.bucketName
  ) {
    throw preflightError(
      "money cutover requires the terminal 0092 staging origin and exact native D1/R2 identity",
    );
  }
}

function assertMaintenanceProof(
  target: DeployTarget,
  proof: MoneyWriterProof,
  commit: string,
): void {
  if (
    proof.kind !== "takoserver.money-writer-quiescence@v1" ||
    proof.mode !== "pre-wallet-usd-micros-quiesced" ||
    proof.accountId !== target.accountId ||
    proof.databaseId !== target.d1.databaseId ||
    proof.workerName !== target.workerName ||
    proof.sourceCommit !== commit ||
    !COMMIT.test(commit) ||
    !UUID.test(proof.deploymentId) ||
    !UUID.test(proof.versionId) ||
    !SHA256.test(proof.moduleDigest) ||
    proof.trafficPercent !== 100 ||
    proof.privateMoneyWriters !== 0 ||
    proof.writerEpoch !== target.moneyCutoverWriterEpoch ||
    !SHA256.test(proof.privateScopeDigest) ||
    !SHA256.test(proof.privateSourceInventoryDigest) ||
    !SHA256.test(proof.privateDependencyClosureDigest) ||
    !SHA256.test(proof.privateDeploymentsDigest) ||
    !SHA256.test(proof.publicPublicationDigest) ||
    !SHA256.test(proof.publicSourceArtifactDigest)
  ) {
    throw preflightError(
      "money cutover requires native published maintenance Writer proof for this D1",
    );
  }
}

function assertResumeProof(target: DeployTarget, proof: MoneyResumeProof, commit: string): void {
  if (
    proof.kind !== "takoserver.money-resume-worker@v1" ||
    proof.accountId !== target.accountId ||
    proof.databaseId !== target.d1.databaseId ||
    proof.workerName !== target.workerName ||
    proof.sourceCommit !== commit ||
    !COMMIT.test(commit) ||
    !UUID.test(proof.deploymentId) ||
    !UUID.test(proof.versionId) ||
    !SHA256.test(proof.moduleDigest) ||
    proof.trafficPercent !== 100 ||
    proof.writerContainmentPolicy !== "transaction-fenced-usd-micros-v1" ||
    target.moneyCutoverWriterPolicy !== proof.writerContainmentPolicy ||
    proof.writerEpoch !== target.moneyCutoverWriterEpoch ||
    !SHA256.test(proof.privateScopeDigest) ||
    !SHA256.test(proof.privateSourceInventoryDigest) ||
    !SHA256.test(proof.privateDependencyClosureDigest) ||
    !SHA256.test(proof.privateDeploymentsDigest) ||
    !SHA256.test(proof.publicPublicationDigest) ||
    !SHA256.test(proof.publicSourceArtifactDigest)
  ) {
    throw preflightError(
      "money resume requires native USD-micros Writer with transaction containment policy",
    );
  }
}

function phaseSchemas(phase: MoneyCutoverPhase): {
  before: Exclude<MoneySchemaPhase, "0098" | "0098-fenced">;
  after: Exclude<MoneySchemaPhase, "0098" | "0098-fenced">;
  through: "0093" | "0094";
} {
  switch (phase) {
    case "freeze":
      return { before: "0092", after: "0092-fenced", through: "0093" };
    case "prepare":
      return { before: "0092-fenced", after: "0093-fenced", through: "0093" };
    case "classify":
      return { before: "0093-fenced", after: "0093-fenced", through: "0093" };
    case "convert":
      return { before: "0093-fenced", after: "0094-fenced", through: "0094" };
    case "resume":
      return { before: "0094-fenced", after: "0094", through: "0094" };
    case "abandon":
      return { before: "0092-fenced", after: "0092", through: "0093" };
    case "suffix98":
    case "resume98":
      throw preflightError(
        "money post94 continuation requires the owning Financial realm transition port",
      );
  }
}

async function exactStatus(
  database: PreimageReader,
  state: D1SchemaState,
  files: readonly MigrationFile[],
  writerEpoch: string,
  includePost94 = false,
): Promise<MoneySchemaPhase | null> {
  for (const phase of [
    "0092",
    "0092-fenced",
    "0093",
    "0093-fenced",
    "0094",
    "0094-fenced",
    ...(includePost94 ? (["0098", "0098-fenced"] as const) : []),
  ] as const) {
    if (!moneyUnitCutoverSchemaMatches(state, files, phase)) continue;
    if (phase.endsWith("-fenced") || phase === "0094" || phase === "0098") {
      const permit = await database.query(
        "preflight",
        "money writer permit",
        `SELECT singleton, epoch, writer_epoch FROM ${MONEY_CUTOVER_PERMIT_TABLE}`,
      );
      if (permit.length !== 0) return null;
      const epoch = await database.query(
        "preflight",
        "authorized money writer epoch",
        `SELECT singleton, writer_epoch FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}`,
      );
      if (epoch.length !== 1 || epoch[0]?.singleton !== 1 || epoch[0]?.writer_epoch !== writerEpoch)
        return null;
      const frozen = await readFreezeRow(database, "preflight");
      if (phase === "0094" || phase === "0098")
        return frozen.length === 0 ? phase : phase === "0094" ? "0094-fenced" : "0098-fenced";
      if (frozen.length !== 1) return null;
    }
    return phase;
  }
  return null;
}

function readFreezeRow(
  database: PreimageReader,
  phase: DeployPhase,
): Promise<readonly Record<string, unknown>[]> {
  return database.query(
    phase,
    "money freeze anchor",
    `SELECT binding_digest, origin_digest, backup_digest, writer_digest, source_digest FROM ${FENCE_TABLE} WHERE singleton = 1`,
  );
}

async function assertPermitEmpty(
  database: PreimageReader,
  phase: DeployPhase,
  writerEpoch: string,
): Promise<void> {
  const rows = await database.query(
    phase,
    "money writer permit",
    `SELECT singleton, epoch, writer_epoch FROM ${MONEY_CUTOVER_PERMIT_TABLE}`,
  );
  if (rows.length !== 0) throw proofError(phase, "money writer permit is not empty at rest");
  const authorized = await database.query(
    phase,
    "authorized money writer epoch",
    `SELECT singleton, writer_epoch FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}`,
  );
  if (
    authorized.length !== 1 ||
    authorized[0]?.singleton !== 1 ||
    authorized[0]?.writer_epoch !== writerEpoch
  )
    throw proofError(phase, "money authorized Writer epoch differs");
}

async function assertResumedFreezeEmpty(
  database: PreimageReader,
  phase: DeployPhase,
  writerEpoch: string,
): Promise<void> {
  if ((await readFreezeRow(database, phase)).length !== 0) {
    throw proofError(phase, "money freeze row remains after resume");
  }
  await assertPermitEmpty(database, phase, writerEpoch);
}

function assertFreezeRow(
  rows: readonly Record<string, unknown>[],
  anchor: string,
  originDigest: string,
  backupDigest: string,
  writerDigest: string,
  phase: DeployPhase,
): void {
  if (
    rows.length !== 1 ||
    rows[0]?.binding_digest !== anchor ||
    rows[0]?.origin_digest !== originDigest ||
    rows[0]?.backup_digest !== backupDigest ||
    rows[0]?.writer_digest !== writerDigest ||
    rows[0]?.source_digest !== SOURCE_0092
  ) {
    throw proofError(
      phase,
      "money freeze metadata differs from the reviewed stage/source/backup/writer anchor",
    );
  }
}

function exactNumber(
  rows: readonly Record<string, unknown>[],
  field: string,
  phase: DeployPhase,
): number {
  const value = rows.length === 1 ? rows[0]?.[field] : undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw proofError(phase, `money pending ${field} count is malformed`);
  return value as number;
}

/** Matches the pending-state guard in 0094 before the irreversible import. */
export async function readMoneyPendingCount(
  database: PreimageReader,
  phase: DeployPhase,
): Promise<number> {
  const predicates = [
    "SELECT COUNT(*) AS n FROM org_wallet_holds WHERE state = 'live'",
    "SELECT COUNT(*) AS n FROM wallet_credit_allocations WHERE debit_type = 'hold'",
    "SELECT COUNT(*) AS n FROM org_wallet_usage_records WHERE state = 'pending'",
    "SELECT COUNT(*) AS n FROM reservations WHERE status = 'active'",
    "SELECT COUNT(*) AS n FROM reseller_settlement_intents WHERE state IN ('pending', 'ready', 'recovery_required') OR cancellation_phase IN ('release_pending', 'release_succeeded')",
    "SELECT COUNT(*) AS n FROM usage_events WHERE rollup_id IS NULL",
    "SELECT COUNT(*) AS n FROM idempotency WHERE scope_key LIKE 'ai:%' AND status IN (100, 101, 102, 202)",
    "SELECT COUNT(*) AS n FROM stripe_events WHERE outcome IN ('received', 'deferred')",
  ];
  let pending = 0;
  for (const [index, sql] of predicates.entries()) {
    pending += exactNumber(
      await database.query(phase, `money pending guard ${index}`, sql),
      "n",
      phase,
    );
  }
  return pending;
}

export async function readMoneyExternalCashPendingCount(
  database: PreimageReader,
  phase: DeployPhase,
): Promise<number> {
  const stripe = exactNumber(
    await database.query(
      phase,
      "money unresolved Stripe events",
      "SELECT COUNT(*) AS n FROM stripe_events WHERE outcome IN ('received', 'deferred')",
    ),
    "n",
    phase,
  );
  const reseller = exactNumber(
    await database.query(
      phase,
      "money unresolved reseller settlement",
      "SELECT COUNT(*) AS n FROM reseller_settlement_intents WHERE state IN ('pending', 'ready', 'recovery_required') OR cancellation_phase IN ('release_pending', 'release_succeeded')",
    ),
    "n",
    phase,
  );
  return stripe + reseller;
}

function configJson(target: DeployTarget): string {
  return `${JSON.stringify(
    {
      name: target.workerName,
      account_id: target.accountId,
      compatibility_date: "2026-08-17",
      d1_databases: [
        {
          binding: "STATE_DB",
          database_name: target.d1.databaseName,
          database_id: target.d1.databaseId,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function phaseImportSql(
  phase: MoneyCutoverPhase,
  files: readonly MigrationFile[],
  anchor: string,
  originDigest: string,
  backupDigest: string,
  writerDigest: string,
  writerEpoch: string,
  classifications: readonly ClassificationRow[],
  abandonFrom?: "0092-fenced" | "0093-fenced",
): string {
  switch (phase) {
    case "freeze":
      return `${FENCE_DDL};\n${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};\nINSERT INTO ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} (singleton, writer_epoch) VALUES (1, ${sqlLiteral(writerEpoch)});\n${MONEY_CUTOVER_PERMIT_DDL};\n${MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL};\nINSERT INTO ${FENCE_TABLE} VALUES (1, ${sqlLiteral(anchor)}, ${sqlLiteral(originDigest)}, ${sqlLiteral(backupDigest)}, ${sqlLiteral(writerDigest)}, ${sqlLiteral(SOURCE_0092)});\n${moneyFenceInstallSql("0092-fenced")}\n`;
    case "prepare": {
      const migration = buildD1MigrationImport([files[92] as MigrationFile], {
        freshLedger: false,
      });
      return `${migration.sql}\n${[...verbs].map((verb) => `${fenceTriggerSql(CLASSIFICATION_TABLE, verb)};`).join("\n")}\n`;
    }
    case "classify": {
      const drop = verbs
        .map((verb) => `DROP TRIGGER ${moneyFenceTriggerName(CLASSIFICATION_TABLE, verb)};`)
        .join("\n");
      const inserts = classifications
        .map(
          (row) =>
            `INSERT INTO ${CLASSIFICATION_TABLE} (org_id, ref, original_kind, original_amount_minor, original_expires_at, consumption_class, evidence_ref, reviewed_at) VALUES (${sqlLiteral(row.org_id)}, ${sqlLiteral(row.ref)}, ${sqlLiteral(row.original_kind)}, ${row.original_amount_minor}, ${row.original_expires_at === null ? "NULL" : sqlLiteral(row.original_expires_at)}, ${sqlLiteral(row.consumption_class)}, ${sqlLiteral(row.evidence_ref)}, ${sqlLiteral(row.reviewed_at)});`,
        )
        .join("\n");
      return `${drop}\n${inserts}\n${verbs.map((verb) => `${fenceTriggerSql(CLASSIFICATION_TABLE, verb)};`).join("\n")}\n`;
    }
    case "convert": {
      const migration = buildD1MigrationImport([files[93] as MigrationFile], {
        freshLedger: false,
      });
      return `${moneyFenceDropSql("0093-fenced")}\n${migration.sql}\n${moneyFenceInstallSql("0094-fenced")}\n`;
    }
    case "resume": {
      const matchingFreeze = `SELECT 1 FROM ${FENCE_TABLE} WHERE singleton = 1 AND binding_digest = ${sqlLiteral(anchor)} AND origin_digest = ${sqlLiteral(originDigest)} AND backup_digest = ${sqlLiteral(backupDigest)} AND writer_digest = ${sqlLiteral(writerDigest)} AND source_digest = ${sqlLiteral(SOURCE_0092)}`;
      // A deliberately invalid epoch aborts the entire /import if the exact
      // row disappeared or a permit appeared between preflight and dispatch.
      const matchingEpoch = `SELECT 1 FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} WHERE singleton = 1 AND writer_epoch = ${sqlLiteral(writerEpoch)}`;
      return `INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE} (singleton, epoch, writer_epoch) SELECT 1, 'invalid-resume-epoch', ${sqlLiteral(writerEpoch)} WHERE NOT EXISTS (${matchingFreeze}) OR NOT EXISTS (${matchingEpoch}) OR EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_PERMIT_TABLE});\nDELETE FROM ${FENCE_TABLE} WHERE singleton = 1 AND binding_digest = ${sqlLiteral(anchor)} AND origin_digest = ${sqlLiteral(originDigest)} AND backup_digest = ${sqlLiteral(backupDigest)} AND writer_digest = ${sqlLiteral(writerDigest)} AND source_digest = ${sqlLiteral(SOURCE_0092)} AND EXISTS (${matchingEpoch}) AND NOT EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_PERMIT_TABLE});\n`;
    }
    case "abandon": {
      if (abandonFrom !== "0092-fenced" && abandonFrom !== "0093-fenced")
        throw preflightError("money abandon requires exact preconversion fenced schema");
      return `${moneyFenceDropSql(abandonFrom)}\nDROP TABLE ${MONEY_CUTOVER_PERMIT_TABLE};\nDROP TABLE ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE};\nDROP TABLE ${FENCE_TABLE};\n`;
    }
    case "suffix98":
    case "resume98":
      throw preflightError(
        "money post94 continuation requires the owning Financial realm transition port",
      );
  }
}

/** Pure, exact SQL composer used by the sealed Wrangler import and local rollback tests. */
export function buildMoneyCutoverImportSql(input: {
  readonly phase: MoneyCutoverPhase;
  readonly files: readonly MigrationFile[];
  readonly anchor: string;
  readonly originDigest: string;
  readonly backupDigest: string;
  readonly writerDigest: string;
  readonly writerEpoch: string;
  readonly classifications?: readonly ClassificationRow[];
  readonly abandonFrom?: "0092-fenced" | "0093-fenced";
}): string {
  assertMoneyCutoverSource(input.files);
  for (const value of [input.anchor, input.originDigest, input.backupDigest, input.writerDigest]) {
    if (!SHA256.test(value))
      throw preflightError("money cutover SQL requires exact evidence digests");
  }
  if (!MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(input.writerEpoch))
    throw preflightError("money cutover SQL requires a pinned Writer epoch");
  return phaseImportSql(
    input.phase,
    input.files,
    input.anchor,
    input.originDigest,
    input.backupDigest,
    input.writerDigest,
    input.writerEpoch,
    input.classifications ?? [],
    input.abandonFrom,
  );
}

function assertProtectedDirectory(path: string, label: string): void {
  if (!isAbsolute(path) || !relative(REPOSITORY, path).startsWith("..")) {
    throw preflightError(`${label} must stay outside the repository`);
  }
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch {
    throw preflightError(`${label} directory is unavailable`);
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw preflightError(`${label} must be an owned link-free 0700 directory`);
  }
  if (realpathSync(path) !== path)
    throw preflightError(`${label} has a symlink in its ancestor path`);
}

function writeProtectedFile(path: string, bytes: Uint8Array): void {
  assertProtectedDirectory(dirname(path), "money cutover custody");
  let handle: number;
  try {
    handle = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw preflightError("money cutover protected evidence already exists or cannot be created");
  }
  try {
    writeFileSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

type MoneyBackupProfile =
  | { readonly schemaPhase: "0092" }
  | {
      readonly schemaPhase: "0094-fenced";
      readonly convertBindingDigest: string;
      readonly writerEpoch: string;
    };

async function backupAndRead(
  backupPath: string,
  configPath: string,
  target: DeployTarget,
  files: readonly MigrationFile[],
  originDigest: string,
  root: string,
  run: NonNullable<MoneyUnitCutoverOptions["run"]>,
  environment: Readonly<Record<string, string>>,
  allowExport = true,
  profile: MoneyBackupProfile = { schemaPhase: "0092" },
): Promise<{
  readonly digest: string;
  readonly preimageDigest: string;
  readonly aggregateDigest: string;
  readonly financialDigest: string;
  readonly allDataDigest: string;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly schema?: D1SchemaState;
  readonly freezeRows?: readonly Record<string, unknown>[];
}> {
  assertProtectedDirectory(dirname(backupPath), "money backup");
  const identityPath = `${backupPath}.identity.json`;
  const sourceDigest =
    profile.schemaPhase === "0092" ? SOURCE_0092 : moneyUnitCutoverSourcePrefixDigest(files, 94);
  if (
    profile.schemaPhase === "0094-fenced" &&
    (!SHA256.test(profile.convertBindingDigest) ||
      !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(profile.writerEpoch))
  )
    throw preflightError("money converted backup requires its exact convert binding and old epoch");
  const expectedIdentity = (backupDigest: string) =>
    profile.schemaPhase === "0092"
      ? {
          kind: "takoserver.money-protected-backup@v1",
          accountId: target.accountId,
          databaseId: target.d1.databaseId,
          databaseName: target.d1.databaseName,
          originDigest,
          sourceDigest,
          backupDigest,
        }
      : {
          kind: "takoserver.money-protected-backup@v2",
          accountId: target.accountId,
          databaseId: target.d1.databaseId,
          databaseName: target.d1.databaseName,
          originDigest,
          sourceDigest,
          backupDigest,
          schemaPhase: profile.schemaPhase,
          convertBindingDigest: profile.convertBindingDigest,
          writerEpoch: profile.writerEpoch,
        };
  if (!existsSync(backupPath)) {
    if (!allowExport)
      throw preflightError(
        "money resume read requires its existing protected backup; no export allowed",
      );
    const rawPath = join(root, `export-${randomUUID()}.sql`);
    try {
      const result = await run(
        wranglerCommand([
          "d1",
          "export",
          target.d1.databaseName,
          "--remote",
          "--yes",
          "--config",
          configPath,
          "--output",
          rawPath,
        ]),
        { env: environment },
      );
      if (result.exitCode !== 0)
        throw preflightError(`money backup export failed (exit ${result.exitCode})`);
      let raw: Buffer;
      try {
        raw = readFileSync(rawPath);
      } catch {
        throw preflightError("money backup export produced no protected file");
      }
      const normalized = normalizeSnapshotDump(raw);
      writeProtectedFile(backupPath, Buffer.from(normalized.sql, "utf8"));
      writeProtectedFile(
        identityPath,
        Buffer.from(`${JSON.stringify(expectedIdentity(normalized.digest))}\n`, "utf8"),
      );
    } finally {
      rmSync(rawPath, { force: true });
    }
  }
  const bytes = readProtectedBytes(backupPath, "money backup");
  const normalized = normalizeSnapshotDump(bytes);
  if (
    normalized.nulBytes !== 0 ||
    normalized.bytes !== bytes.length ||
    digest(bytes) !== normalized.digest
  ) {
    throw preflightError("money backup must be a complete normalized protected D1 export");
  }
  let identity: unknown;
  try {
    identity = JSON.parse(
      readProtectedBytes(identityPath, "money backup identity").toString("utf8"),
    );
  } catch {
    throw preflightError("money backup lacks a protected target/source identity receipt");
  }
  const expected = expectedIdentity(normalized.digest);
  if (
    !record(identity) ||
    Object.keys(identity).sort().join(",") !== Object.keys(expected).sort().join(",") ||
    Object.entries(expected).some(([key, value]) => identity[key] !== value)
  ) {
    throw preflightError("money backup target/source identity differs from exact staging origin");
  }
  const snapshot = new Database(":memory:");
  try {
    snapshot.exec(normalized.sql);
    const state = await readD1SchemaState({
      column: async (_phase: DeployPhase, _description: string, sql: string, name: string) =>
        (snapshot.query(sql).all() as Record<string, unknown>[]).map((row) => String(row[name])),
      query: async (_phase: DeployPhase, _description: string, sql: string) =>
        snapshot.query(sql).all() as Record<string, unknown>[],
    } as unknown as RemoteD1);
    if (!moneyUnitCutoverSchemaMatches(state, files, profile.schemaPhase))
      throw preflightError(
        `money backup application shape differs from fixed ${profile.schemaPhase}`,
      );
    if (profile.schemaPhase === "0094-fenced") {
      await assertPermitEmpty(localReader(snapshot), "preflight", profile.writerEpoch);
      if ((await readFreezeRow(localReader(snapshot), "preflight")).length !== 1)
        throw preflightError("money converted backup lacks its original freeze row");
    }
    const tableRows = snapshot
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations') ORDER BY name",
      )
      .all() as { name: string }[];
    const tables = tableRows.map((row) => row.name);
    const rowCounts: Record<string, number> = {};
    for (const table of tables) {
      if (!/^[a-z_][a-z_0-9]*$/u.test(table))
        throw preflightError("money backup has an unexpected table name");
      rowCounts[table] = (
        snapshot.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      ).n;
    }
    if (snapshot.query("PRAGMA foreign_key_check").all().length !== 0)
      throw preflightError("money backup has foreign-key violations");
    return {
      digest: normalized.digest,
      preimageDigest: await readMoneyPreimageDigest(
        localReader(snapshot),
        "preflight",
        profile.schemaPhase !== "0092",
      ),
      aggregateDigest: await readMoneyAggregateDigest(
        localReader(snapshot),
        "preflight",
        profile.schemaPhase !== "0092",
      ),
      financialDigest: await readMoneyFrozenDataDigest(localReader(snapshot), "preflight"),
      allDataDigest: await readWholeDatabaseDataDigest(localReader(snapshot), "preflight", tables),
      rowCounts,
      ...(profile.schemaPhase === "0092"
        ? {}
        : {
            schema: state,
            freezeRows: await readFreezeRow(localReader(snapshot), "preflight"),
          }),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "DeployError") throw error;
    throw preflightError("money backup could not be fully restored and verified locally");
  } finally {
    snapshot.close();
  }
}

/** Current fixed94 money observation. This is never a normal-Host readiness certificate. */
export interface MoneyUnitResumeState {
  readonly schemaPhase: "0094" | "0094-fenced";
  readonly originDigest: string;
  readonly convertBindingDigest: string;
  readonly resumeBindingDigest: string | null;
  readonly nativeResumeProof: MoneyResumeProof;
  readonly health: "guarded" | "healthy";
  readonly normalHostReady: false;
  readonly nextOwner: "qualified-post0094-suffix-and0098-realm";
}

/**
 * Shared verification over held custody and read-only SQL. The native owner constructs
 * all ports; this lower-level function grants no provider-native eligibility itself.
 */
interface MoneyHistoryInput {
  readonly target: DeployTarget;
  readonly options: MoneyUnitCutoverOptions;
  readonly files: readonly MigrationFile[];
  readonly database: Pick<RemoteD1, "query">;
  readonly readSchema: () => Promise<D1SchemaState>;
  readonly backup: Awaited<ReturnType<typeof backupAndRead>>;
}

function captureMoneyOptions(options: MoneyUnitCutoverOptions): MoneyUnitCutoverOptions {
  return Object.freeze({
    ...options,
    custody: Object.freeze({
      read: options.custody.read.bind(options.custody),
      readDispatch: options.custody.readDispatch.bind(options.custody),
      dispatch: options.custody.dispatch.bind(options.custody),
      terminal: options.custody.terminal.bind(options.custody),
    }),
  });
}

/** Original held history only; no normal Worker proof, publication or new grant. */
async function readHeldMoneyConversionHistory(
  input: MoneyHistoryInput,
  historicalWriterEpoch: string,
  includeResume: boolean,
) {
  const { target, files } = input;
  const backup = Object.freeze({ ...input.backup });
  const options = captureMoneyOptions(input.options);
  const targetSelection = JSON.stringify(target);
  if (!MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(historicalWriterEpoch))
    throw preflightError("money conversion history requires its original Writer epoch");
  assertMoneyCutoverSource(files);
  const origin = structuredClone(await options.stageOriginProof());
  const identity = structuredClone(await options.storageIdentityRead());
  assertStageTarget(target, origin, identity, true);
  const originDigest = digest(JSON.stringify(origin));
  const phases = includeResume
    ? (["freeze", "prepare", "classify", "convert", "resume"] as const)
    : (["freeze", "prepare", "classify", "convert"] as const);
  const retained: {
    phase: MoneyLegacyCutoverPhase;
    receipt: MoneyCutoverCustodyReceipt;
    binding: MoneyLegacyCutoverDispatchBinding;
  }[] = [];
  let predecessor = origin.terminalCustodyDigest;
  const classifications = readProtectedClassifications(
    options.classificationManifestPath ?? "",
    options.classificationManifestDigest ?? "",
  );
  for (const phase of phases) {
    const selectedReceipt = await options.custody.read(phase);
    const selectedBinding = await options.custody.readDispatch(phase);
    const receipt = selectedReceipt === null ? null : Object.freeze({ ...selectedReceipt });
    const binding = selectedBinding === null ? null : Object.freeze({ ...selectedBinding });
    if (phase === "resume" && receipt === null && binding === null) break;
    if (receipt === null || binding === null)
      throw preflightError(`money resume read lacks exact ${phase} custody`);
    if (binding.kind !== "takoserver.money-cutover-dispatch@v1")
      throw preflightError("money conversion history cannot promote a post94 binding");
    assertExistingCustodyShape(receipt, phase);
    if (receipt.state !== "terminal")
      throw preflightError(`money resume read holds unknown ${phase} dispatch; no reconciliation`);
    const selected = phaseSchemas(phase);
    const classificationMatches =
      phase === "freeze" || phase === "prepare"
        ? binding.classificationDigest === digest("[]\n") ||
          binding.classificationDigest === options.classificationManifestDigest
        : binding.classificationDigest === options.classificationManifestDigest;
    if (
      receipt.bindingDigest !== moneyCutoverBindingDigest(binding) ||
      binding.phase !== phase ||
      binding.accountId !== target.accountId ||
      binding.databaseId !== target.d1.databaseId ||
      binding.databaseName !== target.d1.databaseName ||
      binding.originDigest !== originDigest ||
      binding.predecessorCustodyDigest !== predecessor ||
      !COMMIT.test(binding.sourceCommit) ||
      binding.sourceDigest !==
        sourcePrefixDigest(files.slice(0, selected.through === "0093" ? 93 : 94)) ||
      binding.afterSchemaPhase !== selected.after ||
      binding.backupDigest !== backup.digest ||
      binding.preimageDigest !== backup.preimageDigest ||
      binding.aggregateDigest !== backup.aggregateDigest ||
      !classificationMatches ||
      !SHA256.test(binding.reviewDigest) ||
      binding.writerEpoch !== historicalWriterEpoch
    )
      throw preflightError(
        `money resume read ${phase} dispatch differs from original/source/backup/epoch`,
      );
    retained.push({ phase, receipt, binding });
    predecessor = digest(JSON.stringify(receipt));
  }
  const convert = retained.find((entry) => entry.phase === "convert");
  const resume = retained.find((entry) => entry.phase === "resume");
  if (convert === undefined)
    throw preflightError("money resume read requires terminal convert custody");
  const reviewed = resume ?? convert;
  const reviewBinding: MoneyReviewBinding = {
    kind: "takoserver.money-review-binding@v1",
    phase: reviewed.phase,
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    originDigest,
    predecessorCustodyDigest: reviewed.binding.predecessorCustodyDigest,
    sourceCommit: reviewed.binding.sourceCommit,
    sourceDigest: reviewed.binding.sourceDigest,
    importDigest: reviewed.binding.importDigest,
    backupDigest: backup.digest,
    preimageDigest: backup.preimageDigest,
    aggregateDigest: backup.aggregateDigest,
    classificationDigest: reviewed.binding.classificationDigest,
    writerDigest: reviewed.binding.writerDigest,
    resumeDigest: reviewed.binding.resumeDigest,
    writerEpoch: historicalWriterEpoch,
  };
  const assertReview = async () => {
    if (options.independentReview === undefined)
      throw preflightError("money resume read independent review unavailable");
    const review = await options.independentReview(reviewBinding);
    if (review === null || validateReview(reviewBinding, review) !== reviewed.binding.reviewDigest)
      throw preflightError("money resume read retained independent review differs");
  };
  await assertReview();
  const writerDigest = convert.binding.writerDigest;
  const anchor = digest(
    JSON.stringify({
      kind: "takoserver.money-freeze-anchor@v1",
      target: identity,
      originDigest,
      backupDigest: backup.digest,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
      financialDigest: backup.financialDigest,
      writerDigest,
      writerEpoch: historicalWriterEpoch,
      sourceDigest: SOURCE_0092,
    }),
  );
  for (const { phase, binding } of retained) {
    const sql = buildMoneyCutoverImportSql({
      phase,
      files,
      anchor,
      originDigest,
      backupDigest: backup.digest,
      writerDigest,
      writerEpoch: historicalWriterEpoch,
      classifications: phase === "freeze" || phase === "prepare" ? [] : classifications,
    });
    if (
      binding.writerDigest !== writerDigest ||
      digest(sql) !== binding.importDigest ||
      readProtectedBytes(binding.sealedImportPath, "money resume retained SQL").toString("utf8") !==
        sql
    )
      throw preflightError(`money resume read ${phase} sealed import/source differs`);
  }
  const assertCurrent = async () => {
    if (
      JSON.stringify(target) !== targetSelection ||
      JSON.stringify(await options.stageOriginProof()) !== JSON.stringify(origin) ||
      JSON.stringify(await options.storageIdentityRead()) !== JSON.stringify(identity)
    )
      throw preflightError("money conversion history origin/target changed during observation");
    assertMoneyCutoverSource(files);
    if (
      JSON.stringify(
        readProtectedClassifications(
          options.classificationManifestPath ?? "",
          options.classificationManifestDigest ?? "",
        ),
      ) !== JSON.stringify(classifications)
    )
      throw preflightError("money resume classification changed during observation");
    for (const { phase: retainedPhase, receipt, binding } of retained) {
      if (
        JSON.stringify(await options.custody.read(retainedPhase)) !== JSON.stringify(receipt) ||
        JSON.stringify(await options.custody.readDispatch(retainedPhase)) !==
          JSON.stringify(binding)
      )
        throw preflightError("money resume read protected custody changed during observation");
    }
    if (
      resume === undefined &&
      ((await options.custody.read("resume")) !== null ||
        (await options.custody.readDispatch("resume")) !== null)
    )
      throw preflightError("money resume dispatch appeared during observation");
  };
  if (
    !includeResume &&
    ((await options.custody.read("resume")) !== null ||
      (await options.custody.readDispatch("resume")) !== null)
  )
    throw preflightError("money suffix requires convert custody with no legacy resume dispatch");
  return {
    options,
    origin,
    identity,
    originDigest,
    retained,
    convert,
    resume,
    classifications,
    writerDigest,
    anchor,
    assertReview,
    assertCurrent,
  };
}

export async function inspectMoneyUnitResumeState(input: {
  readonly target: DeployTarget;
  readonly options: MoneyUnitCutoverOptions;
  readonly files: readonly MigrationFile[];
  readonly database: Pick<RemoteD1, "query">;
  readonly readSchema: () => Promise<D1SchemaState>;
  readonly backup: Awaited<ReturnType<typeof backupAndRead>>;
}): Promise<MoneyUnitResumeState> {
  const { target, files, database, backup } = input;
  const options = captureMoneyOptions(input.options);
  if (
    options.phase !== "resume" ||
    options.resumeProof === undefined ||
    options.resumeCommit === undefined ||
    options.resumeHealthRead === undefined
  )
    throw preflightError("money resume read requires the existing complete resume owner");
  if (options.writerEpoch !== target.moneyCutoverWriterEpoch)
    throw preflightError("money resume read epoch differs from the selected target");
  const history = await readHeldMoneyConversionHistory(
    { ...input, options },
    options.writerEpoch,
    true,
  );
  const {
    origin,
    identity,
    originDigest,
    convert,
    resume,
    classifications,
    writerDigest,
    anchor,
    assertReview,
  } = history;
  const schema = await input.readSchema();
  const phase = await exactStatus(database, schema, files, options.writerEpoch);
  if (phase !== "0094" && phase !== "0094-fenced")
    throw preflightError(
      "money resume read requires exact current fixed94; suffix has a separate owner",
    );
  if (phase === "0094-fenced") {
    if (resume !== undefined)
      throw preflightError("money resume terminal custody disagrees with current freeze");
    assertFreezeRow(
      await readFreezeRow(database, "preflight"),
      anchor,
      originDigest,
      backup.digest,
      writerDigest,
      "preflight",
    );
    await assertPermitEmpty(database, "preflight", options.writerEpoch);
  } else {
    if (resume === undefined)
      throw preflightError("money current94 lacks terminal resume custody; no adoption");
    await assertResumedFreezeEmpty(database, "preflight", options.writerEpoch);
  }
  if (
    (await readMoneyPreimageDigest(database, "preflight", true)) !== backup.preimageDigest ||
    (await readMoneyAggregateDigest(database, "preflight", true)) !== backup.aggregateDigest
  )
    throw preflightError("money resume read differs from protected financial preimages");
  await assertClassificationsStored(database, classifications, "preflight");
  await assertMoneyNativeForeignKeys(database, "preflight");
  const postDigest = digest(
    JSON.stringify({
      applied: schema.applied,
      shapeDigest: schema.shapeDigest,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
    }),
  );
  if (
    convert.receipt.postDigest !== postDigest ||
    (resume !== undefined && resume.receipt.postDigest !== postDigest)
  )
    throw preflightError("money resume read terminal post digest differs");
  const nativeResumeProof = await options.resumeProof();
  assertResumeProof(target, nativeResumeProof, options.resumeCommit);
  const nativeDigest = digest(JSON.stringify(nativeResumeProof));
  if (resume !== undefined && resume.binding.resumeDigest !== nativeDigest)
    throw preflightError("money resume read current native Version differs from terminal resume");
  await options.resumeHealthRead(phase === "0094-fenced" ? "guarded" : "healthy");
  await assertReview();
  if (
    JSON.stringify(await options.stageOriginProof()) !== JSON.stringify(origin) ||
    JSON.stringify(await options.storageIdentityRead()) !== JSON.stringify(identity) ||
    digest(JSON.stringify(await options.resumeProof())) !== nativeDigest ||
    JSON.stringify(await input.readSchema()) !== JSON.stringify(schema) ||
    (await exactStatus(database, schema, files, options.writerEpoch)) !== phase
  )
    throw preflightError("money resume read origin/native/schema changed during observation");
  await history.assertCurrent();
  return {
    schemaPhase: phase,
    originDigest,
    convertBindingDigest: convert.receipt.bindingDigest,
    resumeBindingDigest: resume?.receipt.bindingDigest ?? null,
    nativeResumeProof,
    health: phase === "0094-fenced" ? "guarded" : "healthy",
    normalHostReady: false,
    nextOwner: "qualified-post0094-suffix-and0098-realm",
  };
}

export interface MoneyUnitPost94State {
  readonly schemaPhase: "0094-fenced" | "0098-fenced" | "0098";
  readonly historicalWriterEpoch: string;
  readonly currentWriterEpoch: string;
  readonly convertBindingDigest: string;
  readonly converted94BackupDigest: string;
  readonly continuation: "blocked-financial-port" | "unknown-dispatch";
  readonly qualification: "component-simulation-only";
  readonly normalHostReady: false;
}

/**
 * Component inspection of the same held history and real SQL state. This does not
 * export, import, dispatch, reconcile, publish, or supply Financial realm authority.
 */
export async function inspectMoneyUnitPost94State(
  input: MoneyHistoryInput & {
    readonly previousWriterEpoch: string;
    readonly nextWriterEpoch: string;
    readonly convertedBackupPath: string;
  },
): Promise<MoneyUnitPost94State> {
  const {
    target,
    files,
    database,
    readSchema,
    previousWriterEpoch,
    nextWriterEpoch,
    convertedBackupPath,
  } = input;
  const options = captureMoneyOptions(input.options);
  const backup = Object.freeze({ ...input.backup });
  if (
    target.environment !== "integration" ||
    (options.phase !== "suffix98" && options.phase !== "resume98") ||
    !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(previousWriterEpoch) ||
    !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(nextWriterEpoch) ||
    previousWriterEpoch === nextWriterEpoch ||
    (target.moneyCutoverWriterEpoch !== previousWriterEpoch &&
      target.moneyCutoverWriterEpoch !== nextWriterEpoch) ||
    resolve(convertedBackupPath) === resolve(options.backupPath)
  )
    throw preflightError(
      "money post94 read requires distinct epochs and a separate converted backup",
    );
  assertMoneyPost94Source(files);
  const history = await readHeldMoneyConversionHistory(
    { ...input, options, backup },
    previousWriterEpoch,
    false,
  );
  const profile: MoneyBackupProfile = {
    schemaPhase: "0094-fenced",
    convertBindingDigest: history.convert.receipt.bindingDigest,
    writerEpoch: previousWriterEpoch,
  };
  const convertedIdentityDigest = digest(
    readProtectedBytes(`${convertedBackupPath}.identity.json`, "money converted backup identity"),
  );
  const converted = await backupAndRead(
    convertedBackupPath,
    "",
    target,
    files,
    history.originDigest,
    dirname(convertedBackupPath),
    options.run ?? runCommand,
    {},
    false,
    profile,
  );
  const convertedSchema = converted.schema;
  if (
    convertedSchema === undefined ||
    converted.freezeRows === undefined ||
    converted.preimageDigest !== backup.preimageDigest ||
    converted.aggregateDigest !== backup.aggregateDigest ||
    history.convert.receipt.postDigest !==
      digest(
        JSON.stringify({
          applied: convertedSchema.applied,
          shapeDigest: convertedSchema.shapeDigest,
          preimageDigest: backup.preimageDigest,
          aggregateDigest: backup.aggregateDigest,
        }),
      )
  )
    throw preflightError("money converted snapshot differs from original terminal convert history");
  assertFreezeRow(
    converted.freezeRows,
    history.anchor,
    history.originDigest,
    backup.digest,
    history.writerDigest,
    "preflight",
  );
  const schema = await readSchema();
  const currentWriterEpoch = target.moneyCutoverWriterEpoch;
  if (currentWriterEpoch === undefined)
    throw preflightError("money post94 target lacks its pinned current epoch");
  const phase = await exactStatus(database, schema, files, currentWriterEpoch, true);
  if (
    (phase !== "0094-fenced" && phase !== "0098-fenced" && phase !== "0098") ||
    (phase === "0094-fenced"
      ? currentWriterEpoch !== previousWriterEpoch
      : currentWriterEpoch !== nextWriterEpoch)
  )
    throw preflightError("money post94 current schema and old/new epoch do not match");
  if (phase.endsWith("-fenced"))
    assertFreezeRow(
      await readFreezeRow(database, "preflight"),
      history.anchor,
      history.originDigest,
      backup.digest,
      history.writerDigest,
      "preflight",
    );
  if (
    (await readMoneyPreimageDigest(database, "preflight", true)) !== backup.preimageDigest ||
    (await readMoneyAggregateDigest(database, "preflight", true)) !== backup.aggregateDigest
  )
    throw preflightError("money post94 current state differs from conserved financial preimages");
  await assertClassificationsStored(database, history.classifications, "preflight");
  await assertMoneyNativeForeignKeys(database, "preflight");
  let predecessor = digest(JSON.stringify(history.convert.receipt));
  let unknown = false;
  let suffixTerminal = false;
  const held = [];
  for (const selectedPhase of ["suffix98", "resume98"] as const) {
    const receipt = await options.custody.read(selectedPhase);
    const binding = await options.custody.readDispatch(selectedPhase);
    if (receipt === null && binding === null) {
      if (selectedPhase === "suffix98" && phase !== "0094-fenced")
        throw preflightError("money post94 current suffix lacks retained original dispatch");
      if (selectedPhase === "resume98" && phase === "0098")
        throw preflightError("money post94 current resume lacks retained original dispatch");
      held.push({ phase: selectedPhase, receipt: null, binding: null });
      continue;
    }
    if (
      receipt === null ||
      binding === null ||
      binding.kind !== "takoserver.money-cutover-dispatch@v2"
    )
      throw preflightError("money post94 custody requires its exact v2 dispatch");
    assertExistingCustodyShape(receipt, selectedPhase);
    if (
      (selectedPhase === "suffix98" && receipt.state === "terminal" && phase === "0094-fenced") ||
      (selectedPhase === "resume98" &&
        (!suffixTerminal || (receipt.state === "terminal" && phase !== "0098")))
    )
      throw preflightError(
        "money post94 terminal custody disagrees with its predecessor/current state",
      );
    if (
      receipt.bindingDigest !== moneyCutoverBindingDigest(binding) ||
      binding.phase !== selectedPhase ||
      binding.accountId !== target.accountId ||
      binding.databaseId !== target.d1.databaseId ||
      binding.databaseName !== target.d1.databaseName ||
      binding.originDigest !== history.originDigest ||
      binding.predecessorCustodyDigest !== predecessor ||
      binding.sourceDigest !== SOURCE_0098 ||
      binding.previousWriterEpoch !== previousWriterEpoch ||
      binding.nextWriterEpoch !== nextWriterEpoch ||
      binding.writerEpoch !==
        (selectedPhase === "suffix98" ? previousWriterEpoch : nextWriterEpoch) ||
      binding.original92BackupDigest !== backup.digest ||
      binding.backupDigest !== backup.digest ||
      binding.converted94BackupDigest !== converted.digest ||
      binding.convertBindingDigest !== history.convert.receipt.bindingDigest ||
      binding.preimageDigest !== backup.preimageDigest ||
      binding.aggregateDigest !== backup.aggregateDigest ||
      binding.classificationDigest !== options.classificationManifestDigest ||
      binding.afterSchemaPhase !== (selectedPhase === "suffix98" ? "0098-fenced" : "0098") ||
      !SHA256.test(binding.modePreparationDigest) ||
      (selectedPhase === "resume98" && unknown)
    )
      throw preflightError("money post94 dispatch differs from original history/source/epochs");
    unknown = receipt.state === "dispatched";
    if (selectedPhase === "suffix98") suffixTerminal = receipt.state === "terminal";
    held.push({ phase: selectedPhase, receipt: { ...receipt }, binding: { ...binding } });
    predecessor = digest(JSON.stringify(receipt));
  }
  await history.assertReview();
  await history.assertCurrent();
  assertMoneyPost94Source(files);
  if (
    JSON.stringify(await readSchema()) !== JSON.stringify(schema) ||
    (await exactStatus(database, schema, files, currentWriterEpoch, true)) !== phase ||
    digest(readProtectedBytes(convertedBackupPath, "money converted backup")) !==
      converted.digest ||
    digest(
      readProtectedBytes(`${convertedBackupPath}.identity.json`, "money converted backup identity"),
    ) !== convertedIdentityDigest
  )
    throw preflightError(
      "money post94 current state or converted snapshot changed during observation",
    );
  for (const entry of held)
    if (
      JSON.stringify(await options.custody.read(entry.phase)) !== JSON.stringify(entry.receipt) ||
      JSON.stringify(await options.custody.readDispatch(entry.phase)) !==
        JSON.stringify(entry.binding)
    )
      throw preflightError("money post94 custody changed during observation");
  return {
    schemaPhase: phase,
    historicalWriterEpoch: previousWriterEpoch,
    currentWriterEpoch,
    convertBindingDigest: history.convert.receipt.bindingDigest,
    converted94BackupDigest: converted.digest,
    continuation: unknown ? "unknown-dispatch" : "blocked-financial-port",
    qualification: "component-simulation-only",
    normalHostReady: false,
  };
}

/** Remote GET/SELECT and existing custody reads only; local source-build scratch is retained. */
export async function readMoneyUnitResumeState(
  target: DeployTarget,
  options: MoneyUnitCutoverOptions,
): Promise<MoneyUnitResumeState> {
  if (
    target.environment !== "integration" ||
    options.phase !== "resume" ||
    options.outputDirectory === undefined
  )
    throw preflightError("money resume read requires the selected integration resume owner");
  const files = readMigrationArtifact(
    options.sourceDirectory ?? resolve(REPOSITORY, "migrations"),
  ).files;
  assertMoneyCutoverSource(files);
  for (const phase of ["convert", "resume"] as const) {
    const receipt = await options.custody.read(phase);
    if (receipt?.state === "dispatched")
      throw preflightError("money resume read holds unknown dispatch; no reconciliation");
  }
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    run,
  });
  assertProtectedDirectory(options.outputDirectory, "money resume read output");
  const root = mkdtempSync(join(options.outputDirectory, "money-resume-read-"));
  const configPath = join(root, "wrangler.jsonc");
  writeFileSync(configPath, configJson(target), { flag: "wx", mode: 0o600 });
  const database = new RemoteD1(configPath, { environment: credential.childEnvironment, run });
  const origin = await options.stageOriginProof();
  const backup = await backupAndRead(
    options.backupPath,
    configPath,
    target,
    files,
    digest(JSON.stringify(origin)),
    root,
    run,
    credential.childEnvironment,
    false,
  );
  return inspectMoneyUnitResumeState({
    target,
    options,
    files,
    database,
    readSchema: () => readD1SchemaState(database),
    backup,
  });
}

/** Protects the full existing D1 export against row-value loss, including NUL-bearing text. */
export async function readWholeDatabaseDataDigest(
  database: PreimageReader,
  phase: DeployPhase,
  tables: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const table of tables) {
    if (!/^[a-z_][a-z_0-9]*$/u.test(table))
      throw proofError(phase, "backup data table name is malformed");
    const info = await database.query(
      phase,
      `backup ${table} columns`,
      `PRAGMA table_info(${table})`,
    );
    const names = info.map((row) => row.name);
    if (
      names.length === 0 ||
      names.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name))
    ) {
      throw proofError(phase, `backup ${table} columns are malformed`);
    }
    const projection = names
      .map((name, index) => {
        const column = `"${name}"`;
        return `typeof(${column}) AS t${index}, CASE typeof(${column}) WHEN 'null' THEN '' WHEN 'text' THEN hex(CAST(${column} AS BLOB)) WHEN 'blob' THEN hex(${column}) WHEN 'integer' THEN CAST(${column} AS TEXT) WHEN 'real' THEN printf('%!.26g', ${column}) ELSE NULL END AS v${index}`;
      })
      .join(", ");
    const order = names.flatMap((_name, index) => [`t${index}`, `v${index}`]).join(", ");
    const rows = await database.query(
      phase,
      `backup ${table} data`,
      `SELECT ${projection} FROM ${table} ORDER BY ${order} LIMIT 1001`,
    );
    if (rows.length > 1000)
      throw proofError(phase, `backup ${table} exceeds the bounded row-value proof`);
    hash.update(table).update("\0").update(JSON.stringify(names)).update("\0");
    for (const row of rows) {
      const values = names.map((_name, index) => [row[`t${index}`], row[`v${index}`]]);
      if (
        values.some(
          ([type, value]) =>
            !["null", "text", "blob", "integer", "real"].includes(String(type)) ||
            typeof value !== "string" ||
            ((type === "text" || type === "blob") && !/^(?:[0-9A-F]{2})*$/u.test(value)) ||
            (type === "integer" && !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) ||
            (type === "real" && !/^-?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/iu.test(value)),
        )
      ) {
        throw proofError(phase, `backup ${table} typed value is malformed`);
      }
      hash.update(JSON.stringify(values)).update("\n");
    }
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function assertMoneyNativeForeignKeys(
  database: PreimageReader,
  phase: DeployPhase,
): Promise<void> {
  const violations = await database.query(
    phase,
    "native foreign-key integrity",
    "SELECT * FROM pragma_foreign_key_check LIMIT 1",
  );
  if (violations.length !== 0)
    throw proofError(phase, "money cutover native D1 has a foreign-key violation");
}

export async function assertMoneyLiveBackupCompleteness(
  database: PreimageReader,
  phase: DeployPhase,
  backup: {
    readonly allDataDigest: string;
    readonly rowCounts: Readonly<Record<string, number>>;
  },
): Promise<void> {
  const tables = Object.keys(backup.rowCounts).sort();
  const liveRows = await database.query(
    phase,
    "native complete table inventory",
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations') ORDER BY name",
  );
  if (JSON.stringify(liveRows.map((row) => row.name)) !== JSON.stringify(tables)) {
    throw proofError(phase, "money backup and live D1 table inventory differ");
  }
  for (const table of tables) {
    if (!/^[a-z_][a-z_0-9]*$/u.test(table))
      throw proofError(phase, "money live table name is malformed");
    const count = exactNumber(
      await database.query(
        phase,
        `native ${table} row count`,
        `SELECT COUNT(*) AS n FROM ${table}`,
      ),
      "n",
      phase,
    );
    if (count !== backup.rowCounts[table])
      throw proofError(phase, `money backup and live D1 ${table} row counts differ`);
  }
  if ((await readWholeDatabaseDataDigest(database, phase, tables)) !== backup.allDataDigest) {
    throw proofError(phase, "money backup and live D1 complete typed row bytes differ");
  }
  await assertMoneyNativeForeignKeys(database, phase);
}

function validateReview(binding: MoneyReviewBinding, proof: MoneyReviewProof): string {
  if (
    proof.kind !== "takoserver.money-independent-review@v1" ||
    typeof proof.reviewer !== "string" ||
    proof.reviewer.trim() !== proof.reviewer ||
    proof.reviewer.length < 2 ||
    proof.reviewer.length > 256 ||
    typeof proof.reviewRef !== "string" ||
    proof.reviewRef.length < 16 ||
    proof.reviewRef.length > 512 ||
    proof.bindingDigest !== moneyCutoverBindingDigest(binding) ||
    !SHA256.test(proof.evidenceDigest)
  ) {
    throw preflightError("money independent review does not bind the exact cutover evidence");
  }
  return digest(JSON.stringify(proof));
}

function validateCustody(
  receipt: MoneyCutoverCustodyReceipt,
  phase: MoneyCutoverPhase,
  bindingDigest: string,
  expectedState: "dispatched" | "terminal",
  expectedPostDigest?: string,
): void {
  if (
    receipt.kind !== "takoserver.money-cutover-custody@v1" ||
    receipt.phase !== phase ||
    receipt.state !== expectedState ||
    receipt.bindingDigest !== bindingDigest ||
    (expectedState === "dispatched"
      ? receipt.postDigest !== null
      : typeof receipt.postDigest !== "string" ||
        !SHA256.test(receipt.postDigest) ||
        receipt.postDigest !== expectedPostDigest)
  ) {
    throw mutationError("money cutover no-overwrite dispatch custody is malformed or divergent");
  }
}

function assertExistingCustodyShape(
  receipt: MoneyCutoverCustodyReceipt,
  phase: MoneyCutoverPhase,
): void {
  if (
    receipt.kind !== "takoserver.money-cutover-custody@v1" ||
    receipt.phase !== phase ||
    (receipt.state !== "dispatched" && receipt.state !== "terminal") ||
    !SHA256.test(receipt.bindingDigest) ||
    (receipt.state === "dispatched"
      ? receipt.postDigest !== null
      : typeof receipt.postDigest !== "string" || !SHA256.test(receipt.postDigest))
  ) {
    throw mutationError("money cutover prior custody has an invalid no-overwrite state");
  }
}

async function runImport(
  file: string,
  configPath: string,
  target: DeployTarget,
  run: NonNullable<MoneyUnitCutoverOptions["run"]>,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const sealed = sealDirectory(dirname(file), ["wrangler.jsonc", "import.sql"]);
  sealed.assertUnchanged();
  let result: CommandResult;
  try {
    result = await run(
      wranglerCommand([
        "d1",
        "execute",
        target.d1.databaseName,
        "--remote",
        "--yes",
        "--config",
        configPath,
        "--file",
        file,
      ]),
      { env: environment },
    );
  } catch {
    throw mutationError(
      "money cutover import acknowledgement is unknown; keep freeze and reconcile by GET only",
    );
  }
  if (result.exitCode !== 0) {
    throw mutationError(
      `money cutover import was not acknowledged (exit ${result.exitCode}); keep freeze and reconcile by GET only`,
    );
  }
  try {
    sealed.assertUnchanged();
  } catch (cause) {
    const failure = verificationError(
      "money cutover import was acknowledged but sealed input validation failed; retain custody and inspect status without replay",
    );
    failure.cause = cause;
    throw failure;
  }
}

/** Recover an unknown import acknowledgement using retained evidence and D1 reads only. */
export async function reconcileMoneyCutoverDispatched(input: {
  readonly invocation: MoneyUnitCutoverInvocation;
  readonly target: DeployTarget;
  readonly options: MoneyUnitCutoverOptions;
  readonly files: readonly MigrationFile[];
  readonly database: RemoteD1;
  readonly schema: D1SchemaState;
  readonly actualPhase: MoneySchemaPhase | null;
  readonly originDigest: string;
  readonly origin: MoneyStageOriginProof;
  readonly liveIdentity: MoneyStorageIdentity;
  readonly writer: MoneyWriterProof | null;
  readonly previousReceipt: MoneyCutoverCustodyReceipt | null;
  readonly root: string;
  readonly configPath: string;
  readonly run: NonNullable<MoneyUnitCutoverOptions["run"]>;
  readonly environment: Readonly<Record<string, string>>;
  readonly receipt: MoneyCutoverCustodyReceipt;
}): Promise<Record<string, unknown>> {
  if (input.options.phase === "suffix98" || input.options.phase === "resume98")
    throw preflightError(
      "money post94 unknown dispatch remains held; Financial realm reconciliation is unavailable and cannot resend",
    );
  const {
    invocation,
    target,
    options,
    files,
    database,
    schema,
    actualPhase,
    originDigest,
    origin,
    liveIdentity,
    writer,
    root,
    configPath,
    run,
    environment,
    receipt,
  } = input;
  const binding = await options.custody.readDispatch(options.phase);
  if (
    binding === null ||
    moneyCutoverBindingDigest(binding) !== receipt.bindingDigest ||
    binding.kind !== "takoserver.money-cutover-dispatch@v1" ||
    binding.phase !== options.phase ||
    binding.accountId !== target.accountId ||
    binding.databaseId !== target.d1.databaseId ||
    binding.databaseName !== target.d1.databaseName ||
    binding.originDigest !== originDigest ||
    binding.sourceCommit !== invocation.commit ||
    !SHA256.test(binding.beforeShapeDigest)
  ) {
    throw mutationError("money dispatched custody lacks its exact reviewed target/source binding");
  }
  let predecessor = input.previousReceipt;
  const selected = phaseSchemas(options.phase);
  const beforePhase =
    options.phase === "abandon" && binding.afterSchemaPhase === "0093"
      ? "0093-fenced"
      : selected.before;
  const afterPhase =
    options.phase === "abandon" && binding.afterSchemaPhase === "0093" ? "0093" : selected.after;
  if (
    binding.afterSchemaPhase !== afterPhase ||
    (options.phase === "abandon" &&
      binding.afterSchemaPhase !== "0092" &&
      binding.afterSchemaPhase !== "0093")
  ) {
    throw mutationError("money dispatch terminal schema phase is divergent");
  }
  if (options.phase === "abandon" && beforePhase === "0093-fenced") {
    predecessor = await options.custody.read("prepare");
    if (predecessor === null || predecessor.state !== "terminal")
      throw mutationError("money abandon lacks terminal 0093 preparation custody");
    assertExistingCustodyShape(predecessor, "prepare");
  }
  const expectedPredecessor =
    predecessor === null ? origin.terminalCustodyDigest : digest(JSON.stringify(predecessor));
  const expectedSource = sourcePrefixDigest(
    files.slice(
      0,
      options.phase === "abandon" && beforePhase === "0092-fenced"
        ? 92
        : selected.through === "0093"
          ? 93
          : 94,
    ),
  );
  if (
    binding.predecessorCustodyDigest !== expectedPredecessor ||
    binding.sourceDigest !== expectedSource
  ) {
    throw mutationError("money dispatched predecessor custody or source prefix diverged");
  }
  if (actualPhase !== afterPhase || !moneyUnitCutoverSchemaMatches(schema, files, afterPhase)) {
    return {
      kind: "takoserver.money-cutover-dispatched-readback@v1",
      phase: options.phase,
      custody: "dispatched",
      appliedMigrations: schema.applied,
      schemaShapeDigest: schema.shapeDigest,
      readyForApply: false,
      nextAction:
        "retain freeze; GET-only readback found no exact terminal schema, do not resend import",
    };
  }
  if (
    options.outputDirectory === undefined ||
    !isAbsolute(binding.sealedImportPath) ||
    !relative(options.outputDirectory, binding.sealedImportPath).startsWith("money-") ||
    !binding.sealedImportPath.endsWith("/import.sql")
  ) {
    throw mutationError("money dispatch sealed SQL path is outside protected retained output");
  }
  const retainedSql = readProtectedBytes(binding.sealedImportPath, "money dispatched import");
  if (digest(retainedSql) !== binding.importDigest)
    throw mutationError("money dispatched SQL differs from immutable import digest");
  if (!existsSync(options.backupPath))
    throw mutationError("money dispatched backup is missing; no export or reimport is allowed");
  const backup = await backupAndRead(
    options.backupPath,
    configPath,
    target,
    files,
    originDigest,
    root,
    run,
    environment,
  );
  const writerDigest = writer === null ? binding.writerDigest : digest(JSON.stringify(writer));
  if (
    writerDigest !== binding.writerDigest ||
    backup.digest !== binding.backupDigest ||
    backup.preimageDigest !== binding.preimageDigest ||
    backup.aggregateDigest !== binding.aggregateDigest
  ) {
    throw mutationError("money dispatched writer or protected backup changed");
  }
  let resumeDigest = digest("no-resume-worker");
  if (options.phase === "resume") {
    if (options.resumeProof === undefined || options.resumeCommit === undefined)
      throw mutationError("money resume native proof is missing");
    const resumeProof = await options.resumeProof();
    assertResumeProof(target, resumeProof, options.resumeCommit);
    resumeDigest = digest(JSON.stringify(resumeProof));
  }
  if (resumeDigest !== binding.resumeDigest)
    throw mutationError("money dispatched resume native version changed");
  if (
    binding.writerEpoch !== options.writerEpoch ||
    binding.writerEpoch !== target.moneyCutoverWriterEpoch
  )
    throw mutationError("money dispatched Writer epoch changed");
  const classifications =
    options.phase === "classify" || options.phase === "convert" || options.phase === "resume"
      ? readProtectedClassifications(
          options.classificationManifestPath ?? "",
          options.classificationManifestDigest ?? "",
        )
      : [];
  const classificationDigest = options.classificationManifestDigest ?? digest("[]\n");
  if (classificationDigest !== binding.classificationDigest)
    throw mutationError("money dispatched classification manifest changed");
  const anchor = digest(
    JSON.stringify({
      kind: "takoserver.money-freeze-anchor@v1",
      target: liveIdentity,
      originDigest,
      backupDigest: backup.digest,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
      financialDigest: backup.financialDigest,
      writerDigest,
      writerEpoch: options.writerEpoch,
      sourceDigest: SOURCE_0092,
    }),
  );
  const expectedSql = buildMoneyCutoverImportSql({
    phase: options.phase,
    files,
    anchor,
    originDigest,
    backupDigest: backup.digest,
    writerDigest,
    writerEpoch: options.writerEpoch,
    classifications,
    ...(options.phase === "abandon"
      ? { abandonFrom: beforePhase as "0092-fenced" | "0093-fenced" }
      : {}),
  });
  if (
    digest(expectedSql) !== binding.importDigest ||
    retainedSql.toString("utf8") !== expectedSql
  ) {
    throw mutationError("money dispatched sealed SQL differs from reviewed source and evidence");
  }
  const reviewBinding: MoneyReviewBinding = {
    kind: "takoserver.money-review-binding@v1",
    phase: binding.phase,
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    originDigest,
    predecessorCustodyDigest: expectedPredecessor,
    sourceCommit: invocation.commit,
    sourceDigest: expectedSource,
    importDigest: binding.importDigest,
    backupDigest: backup.digest,
    preimageDigest: backup.preimageDigest,
    aggregateDigest: backup.aggregateDigest,
    classificationDigest,
    writerDigest,
    resumeDigest,
    writerEpoch: options.writerEpoch,
  };
  if (options.independentReview === undefined)
    throw mutationError("money dispatch independent review is unavailable");
  const review = await options.independentReview(reviewBinding);
  if (review === null || validateReview(reviewBinding, review) !== binding.reviewDigest) {
    throw mutationError("money dispatch independent review no longer binds exact evidence");
  }
  if (afterPhase.endsWith("-fenced")) {
    assertFreezeRow(
      await readFreezeRow(database, "verification"),
      anchor,
      originDigest,
      backup.digest,
      writerDigest,
      "verification",
    );
    await assertPermitEmpty(database, "verification", options.writerEpoch);
  } else if (afterPhase === "0094") {
    await assertResumedFreezeEmpty(database, "verification", options.writerEpoch);
    if (options.resumeHealthRead === undefined)
      throw mutationError("money resume healthy native readback is unavailable");
    await options.resumeHealthRead("healthy");
    if (
      options.resumeProof === undefined ||
      digest(JSON.stringify(await options.resumeProof())) !== binding.resumeDigest
    )
      throw mutationError("money resumed native Version changed after D1 transition");
  }
  if (
    options.phase === "freeze" ||
    options.phase === "prepare" ||
    options.phase === "classify" ||
    options.phase === "abandon"
  ) {
    if (
      (await readMoneyPreimageDigest(database, "verification")) !== backup.preimageDigest ||
      (await readMoneyAggregateDigest(database, "verification")) !== backup.aggregateDigest ||
      (await readMoneyFrozenDataDigest(database, "verification")) !== backup.financialDigest
    ) {
      throw verificationError("money dispatched readback differs from backup financial rows");
    }
  } else if (
    (await readMoneyPreimageDigest(database, "verification", true)) !== backup.preimageDigest ||
    (await readMoneyAggregateDigest(database, "verification", true)) !== backup.aggregateDigest
  ) {
    throw verificationError(
      "money dispatched converted preimage or aggregates differ from protected backup",
    );
  }
  if (options.phase === "classify" || options.phase === "convert" || options.phase === "resume") {
    await assertClassificationsStored(database, classifications, "verification");
  }
  if (options.phase === "classify")
    await assertClassificationMatchesLots(database, classifications, "verification");
  if (
    options.phase === "convert" &&
    (await readMoneyPendingCount(database, "verification")) !== 0
  ) {
    throw verificationError("money dispatched conversion has pending external work");
  }
  if (
    options.phase === "abandon" &&
    (await readMoneyExternalCashPendingCount(database, "verification")) !== 0
  ) {
    throw verificationError("money dispatched abandon has pending external cash work");
  }
  await assertMoneyNativeForeignKeys(database, "verification");
  const postDigest = digest(
    JSON.stringify({
      applied: schema.applied,
      shapeDigest: schema.shapeDigest,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
    }),
  );
  validateCustody(
    await options.custody.terminal(binding, postDigest),
    options.phase,
    receipt.bindingDigest,
    "terminal",
    postDigest,
  );
  return {
    kind: "takoserver.money-cutover-reconciled@v1",
    phase: options.phase,
    schemaPhase: afterPhase,
    schemaShapeDigest: schema.shapeDigest,
    custody: "terminal",
    postDigest,
    readyForApply: false,
    d1Writes: 0,
    nextAction: "continue only with the next reviewed phase",
  };
}

/** Dedicated fixed 0092→0093→0094 staging cutover. No path can target production. */
export async function runIntegrationMoneyUnitCutover(
  invocation: MoneyUnitCutoverInvocation,
  target: DeployTarget,
  options: MoneyUnitCutoverOptions,
): Promise<Record<string, unknown>> {
  if (
    invocation.environment !== "integration" ||
    target.environment !== "integration" ||
    !COMMIT.test(invocation.commit) ||
    !options ||
    ![
      "freeze",
      "prepare",
      "classify",
      "convert",
      "resume",
      "abandon",
      "suffix98",
      "resume98",
    ].includes(options.phase)
  ) {
    throw preflightError("money cutover requires an exact integration invocation and phase");
  }
  if (options.phase === "suffix98" || options.phase === "resume98")
    throw preflightError(
      "money post94 continuation requires the owning Financial realm transition port; no export/import/dispatch is permitted",
    );
  // The adapter is already initialized before invoking this executor. This lazy
  // assert-only edge avoids a static owner/executor initialization cycle.
  const originalWriter = /^integration-ts-[0-9a-f]{32}$/u.test(target.d1.databaseName)
    ? (await import("./schema-money-unit-owner.ts")).assertMoneyUnitOriginalWriterOptions
    : undefined;
  if (originalWriter !== undefined) target = originalWriter(options, target);
  const assertOriginalWriter = (phase: "preflight" | "verification" = "preflight") => {
    try {
      return originalWriter?.(options, target);
    } catch (cause) {
      if (phase !== "verification") throw cause;
      const failure = verificationError(
        "fresh money source changed after import; retain custody and inspect status",
      );
      failure.cause = cause;
      throw failure;
    }
  };
  assertOriginalWriter();
  const selected = phaseSchemas(options.phase);
  if (invocation.throughMigration !== selected.through)
    throw preflightError("money cutover phase and fixed schema wave differ");
  if (invocation.action === "apply" && options.outputDirectory === undefined) {
    throw preflightError(
      "money cutover apply requires protected retained import custody directory",
    );
  }
  if (
    invocation.action === "apply" &&
    options.sourceDirectory !== undefined &&
    resolve(options.sourceDirectory) !== resolve(REPOSITORY, "migrations")
  ) {
    throw preflightError(
      "money cutover apply source must be this reviewed worktree migration directory",
    );
  }
  const files = readMigrationArtifact(
    options.sourceDirectory ?? resolve(REPOSITORY, "migrations"),
  ).files;
  assertMoneyCutoverSource(files);
  const run = options.run ?? runCommand;
  const existing = await options.custody.read(options.phase);
  if (existing !== null) assertExistingCustodyShape(existing, options.phase);
  if (existing !== null && invocation.action === "apply") {
    throw mutationError(
      "money cutover phase already has dispatch custody; apply cannot resend an unknown or terminal import",
    );
  }
  if (options.phase === "abandon" && (await options.custody.read("convert")) !== null) {
    throw mutationError(
      "money abandon is forbidden after any 0094 conversion dispatch, including unknown acknowledgement",
    );
  }
  const previousPhase: MoneyCutoverPhase | null =
    options.phase === "prepare"
      ? "freeze"
      : options.phase === "classify"
        ? "prepare"
        : options.phase === "convert"
          ? "classify"
          : options.phase === "resume"
            ? "convert"
            : options.phase === "abandon"
              ? "freeze"
              : null;
  let previousReceipt: MoneyCutoverCustodyReceipt | null = null;
  if (previousPhase !== null) {
    previousReceipt = await options.custody.read(previousPhase);
    if (previousReceipt === null)
      throw preflightError(`money ${options.phase} requires terminal ${previousPhase} custody`);
    assertExistingCustodyShape(previousReceipt, previousPhase);
    if (previousReceipt.state !== "terminal")
      throw mutationError(
        `money ${options.phase} cannot pass unknown ${previousPhase} dispatch acknowledgement`,
      );
  }
  const origin = await options.stageOriginProof();
  const liveIdentity = await options.storageIdentityRead();
  assertOriginalWriter();
  assertStageTarget(target, origin, liveIdentity, originalWriter !== undefined);
  if (
    !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(options.writerEpoch) ||
    options.writerEpoch !== target.moneyCutoverWriterEpoch
  )
    throw preflightError("money cutover requires the exact target-pinned Writer epoch");
  const originDigest = digest(JSON.stringify(origin));
  const writer = options.phase === "resume" ? null : await options.maintenanceProof();
  if (writer !== null) assertMaintenanceProof(target, writer, options.maintenanceCommit);
  const credential = await resolveCloudflareCredential("integration", {
    cloudflareEnvironment: options.cloudflareEnvironment,
    run,
  });
  const environment = credential.childEnvironment;
  const base = options.outputDirectory ?? tmpdir();
  if (options.outputDirectory !== undefined) assertProtectedDirectory(base, "money cutover output");
  const root = mkdtempSync(join(base, `money-${options.phase}-`));
  let lease: Awaited<ReturnType<typeof acquireWranglerVersionPublicationLease>> | null = null;
  try {
    const configPath = join(root, "wrangler.jsonc");
    writeFileSync(configPath, configJson(target), { flag: "wx", mode: 0o600 });
    const database = new RemoteD1(configPath, { environment, run });
    const initial = await readD1SchemaState(database);
    const actualPhase = await exactStatus(database, initial, files, options.writerEpoch);
    if (existing?.state === "dispatched" && invocation.action === "status") {
      return reconcileMoneyCutoverDispatched({
        invocation,
        target,
        options,
        files,
        database,
        schema: initial,
        actualPhase,
        originDigest,
        origin,
        liveIdentity,
        writer,
        previousReceipt,
        root,
        configPath,
        run,
        environment,
        receipt: existing,
      });
    }
    if (actualPhase === null)
      throw preflightError(
        "money cutover D1 is neither exact predecessor nor exact terminal schema; keep frozen and repair forward",
      );
    const abandonBefore =
      options.phase === "abandon" &&
      (actualPhase === "0092-fenced" || actualPhase === "0093-fenced");
    const abandonAfter =
      options.phase === "abandon" && (actualPhase === "0092" || actualPhase === "0093");
    if (
      !abandonBefore &&
      !abandonAfter &&
      actualPhase !== selected.before &&
      actualPhase !== selected.after
    ) {
      throw preflightError(
        "money cutover phase requires its exact predecessor or terminal state; partial schema is refused",
      );
    }
    if (options.phase === "abandon" && actualPhase === "0093-fenced") {
      const prepared = await options.custody.read("prepare");
      if (prepared === null)
        throw preflightError("money abandon from 0093 requires terminal prepare custody");
      assertExistingCustodyShape(prepared, "prepare");
      if (prepared.state !== "terminal")
        throw mutationError("money abandon cannot pass unknown 0093 preparation acknowledgement");
      previousReceipt = prepared;
      const classified = await options.custody.read("classify");
      if (classified !== null) {
        assertExistingCustodyShape(classified, "classify");
        if (classified.state === "dispatched")
          throw mutationError("money abandon cannot pass unknown classification acknowledgement");
      }
    }
    if (abandonAfter && invocation.action === "status") {
      return {
        kind: "takoserver.money-cutover-status@v1",
        phase: "abandon",
        schemaPhase: actualPhase,
        schemaShapeDigest: initial.shapeDigest,
        custody: existing?.state ?? null,
        readyForApply: false,
        writerState: "maintenance-still-quiesced",
      };
    }
    const backup = await backupAndRead(
      options.backupPath,
      configPath,
      target,
      files,
      originDigest,
      root,
      run,
      environment,
    );
    if (options.phase === "freeze" && actualPhase === "0092") {
      await assertMoneyLiveBackupCompleteness(database, "preflight", backup);
    }
    let writerDigest = writer === null ? "" : digest(JSON.stringify(writer));
    let resumeDigest = digest("no-resume-worker");
    if (options.phase === "resume") {
      const rows = await readFreezeRow(database, "preflight");
      if (
        rows.length !== 1 ||
        typeof rows[0]?.writer_digest !== "string" ||
        !SHA256.test(rows[0].writer_digest)
      ) {
        throw preflightError("money resume has no exact prior writer freeze proof");
      }
      writerDigest = rows[0].writer_digest;
      if (options.resumeProof === undefined || options.resumeCommit === undefined) {
        throw preflightError("money resume requires a new native USD-micros Worker proof");
      }
      const resumeProof = await options.resumeProof();
      assertResumeProof(target, resumeProof, options.resumeCommit);
      resumeDigest = digest(JSON.stringify(resumeProof));
      if (options.resumeHealthRead === undefined)
        throw preflightError("money resume guarded native probe is unavailable");
      await options.resumeHealthRead("guarded");
    }
    const anchor = digest(
      JSON.stringify({
        kind: "takoserver.money-freeze-anchor@v1",
        target: liveIdentity,
        originDigest,
        backupDigest: backup.digest,
        preimageDigest: backup.preimageDigest,
        aggregateDigest: backup.aggregateDigest,
        financialDigest: backup.financialDigest,
        writerDigest,
        writerEpoch: options.writerEpoch,
        sourceDigest: SOURCE_0092,
      }),
    );
    if (actualPhase.endsWith("-fenced")) {
      assertFreezeRow(
        await readFreezeRow(database, "preflight"),
        anchor,
        originDigest,
        backup.digest,
        writerDigest,
        "preflight",
      );
      await assertPermitEmpty(database, "preflight", options.writerEpoch);
    }
    if (actualPhase === "0092" || actualPhase === "0092-fenced" || actualPhase === "0093-fenced") {
      if (
        (await readMoneyPreimageDigest(database, "preflight")) !== backup.preimageDigest ||
        (await readMoneyAggregateDigest(database, "preflight")) !== backup.aggregateDigest ||
        (await readMoneyFrozenDataDigest(database, "preflight")) !== backup.financialDigest
      ) {
        throw preflightError(
          "money backup and current financial rows differ; preserve freeze and investigate",
        );
      }
    } else if (
      actualPhase === "0094-fenced" &&
      ((await readMoneyPreimageDigest(database, "preflight", true)) !== backup.preimageDigest ||
        (await readMoneyAggregateDigest(database, "preflight", true)) !== backup.aggregateDigest)
    ) {
      throw preflightError("money 0094 stored preimage differs from protected backup");
    }
    const classifications =
      options.phase === "classify" || options.phase === "convert" || options.phase === "resume"
        ? readProtectedClassifications(
            options.classificationManifestPath ?? "",
            options.classificationManifestDigest ?? "",
          )
        : [];
    if (options.phase === "classify" || options.phase === "convert") {
      await assertClassificationMatchesLots(database, classifications, "preflight");
    }
    if (options.phase === "classify") {
      const stored = exactNumber(
        await database.query(
          "preflight",
          "0093 classification predecessor count",
          `SELECT COUNT(*) AS n FROM ${CLASSIFICATION_TABLE}`,
        ),
        "n",
        "preflight",
      );
      if (stored !== 0)
        throw preflightError(
          "0093 classification is already populated; no overwrite or second seeding",
        );
    }
    if (options.phase === "convert" || options.phase === "resume") {
      await assertClassificationsStored(database, classifications, "preflight");
    }
    if (
      (options.phase === "freeze" || options.phase === "convert") &&
      (await readMoneyPendingCount(database, "preflight")) !== 0
    ) {
      throw preflightError(
        "money cutover has pending holds, usage, reservations, settlement, Stripe or old usage",
      );
    }
    if (
      options.phase === "abandon" &&
      (await readMoneyExternalCashPendingCount(database, "preflight")) !== 0
    ) {
      throw preflightError(
        "money abandon requires zero unresolved external cash work while maintenance remains active",
      );
    }
    const sql = buildMoneyCutoverImportSql({
      phase: options.phase,
      files,
      anchor,
      originDigest,
      backupDigest: backup.digest,
      writerDigest,
      writerEpoch: options.writerEpoch,
      classifications,
      ...(abandonBefore ? { abandonFrom: actualPhase as "0092-fenced" | "0093-fenced" } : {}),
    });
    const importDigest = digest(sql);
    const reviewBinding: MoneyReviewBinding = {
      kind: "takoserver.money-review-binding@v1",
      phase: options.phase,
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      originDigest,
      predecessorCustodyDigest:
        previousReceipt === null
          ? origin.terminalCustodyDigest
          : digest(JSON.stringify(previousReceipt)),
      sourceCommit: invocation.commit,
      sourceDigest: sourcePrefixDigest(
        files.slice(
          0,
          options.phase === "abandon" && actualPhase.startsWith("0092")
            ? 92
            : selected.through === "0093"
              ? 93
              : 94,
        ),
      ),
      importDigest,
      backupDigest: backup.digest,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
      classificationDigest: options.classificationManifestDigest ?? digest("[]\n"),
      writerDigest,
      resumeDigest,
      writerEpoch: options.writerEpoch,
    };
    const reviewProof =
      options.independentReview === undefined
        ? null
        : await options.independentReview(reviewBinding);
    const reviewDigest = reviewProof === null ? null : validateReview(reviewBinding, reviewProof);
    const status = {
      kind: "takoserver.money-cutover-status@v1",
      phase: options.phase,
      environment: "integration",
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      sourceCommit: invocation.commit,
      schemaPhase: actualPhase,
      schemaShapeDigest: initial.shapeDigest,
      backupDigest: backup.digest,
      backupAllDataDigest: backup.allDataDigest,
      backupTableCount: Object.keys(backup.rowCounts).length,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
      classificationDigest: reviewBinding.classificationDigest,
      importDigest,
      reviewBinding,
      reviewBindingDigest: moneyCutoverBindingDigest(reviewBinding),
      custody: existing?.state ?? null,
      readyForApply:
        (abandonBefore || actualPhase === selected.before) &&
        existing === null &&
        reviewDigest !== null,
    };
    if (invocation.action === "status") return status;
    if (!abandonBefore && actualPhase !== selected.before)
      throw preflightError("money cutover phase is already terminal; apply refuses no-op evidence");
    if (reviewDigest === null) {
      throw preflightError("money cutover phase requires exact independent review evidence");
    }
    await qualifySource({
      environment: "integration",
      commit: invocation.commit,
      policy: "clean-remote",
      run,
    });
    const gate = await run(["bun", "run", "check:migrations"]);
    if (gate.exitCode !== 0)
      throw preflightError(`money cutover migration gate failed (exit ${gate.exitCode})`);
    lease = await acquireWranglerVersionPublicationLease({
      accountId: target.accountId,
      workerName: `d1-${target.d1.databaseId}`,
      ...(options.leaseRoot === undefined ? {} : { root: options.leaseRoot }),
    });
    const sourceNow = readMigrationArtifact(
      options.sourceDirectory ?? resolve(REPOSITORY, "migrations"),
    ).files;
    assertMoneyCutoverSource(sourceNow);
    if (sourcePrefixDigest(sourceNow.slice(0, 94)) !== sourcePrefixDigest(files.slice(0, 94))) {
      throw preflightError("money cutover source changed during qualification");
    }
    const originNow = await options.stageOriginProof();
    const liveNow = await options.storageIdentityRead();
    assertOriginalWriter();
    assertStageTarget(target, originNow, liveNow, originalWriter !== undefined);
    if (digest(JSON.stringify(originNow)) !== originDigest)
      throw preflightError("money cutover origin changed before dispatch");
    const atDispatch = await readD1SchemaState(database);
    if (
      atDispatch.shapeDigest !== initial.shapeDigest ||
      !moneyUnitCutoverSchemaMatches(
        atDispatch,
        files,
        (abandonBefore ? actualPhase : selected.before) as MoneySchemaPhase,
      )
    ) {
      throw preflightError("money cutover predecessor changed before dispatch");
    }
    if (options.phase !== "resume") {
      const writerNow = await options.maintenanceProof();
      assertMaintenanceProof(target, writerNow, options.maintenanceCommit);
      if (digest(JSON.stringify(writerNow)) !== writerDigest)
        throw preflightError("money maintenance native Version changed before dispatch");
    } else {
      const resumeNow = await (
        options.resumeProof as NonNullable<MoneyUnitCutoverOptions["resumeProof"]>
      )();
      assertResumeProof(target, resumeNow, options.resumeCommit as string);
      if (digest(JSON.stringify(resumeNow)) !== resumeDigest)
        throw preflightError("money resume native Version changed before dispatch");
      if (options.resumeHealthRead === undefined)
        throw preflightError("money resume guarded native probe is unavailable");
      await options.resumeHealthRead("guarded");
    }
    if (
      options.phase === "freeze" ||
      options.phase === "prepare" ||
      options.phase === "classify" ||
      options.phase === "abandon"
    ) {
      if (
        (await readMoneyPreimageDigest(database, "preflight")) !== backup.preimageDigest ||
        (await readMoneyAggregateDigest(database, "preflight")) !== backup.aggregateDigest ||
        (await readMoneyFrozenDataDigest(database, "preflight")) !== backup.financialDigest
      ) {
        throw preflightError("money backup rows changed before dispatch");
      }
    }
    if (options.phase === "freeze")
      await assertMoneyLiveBackupCompleteness(database, "preflight", backup);
    if (
      options.phase === "convert" &&
      ((await readMoneyPendingCount(database, "preflight")) !== 0 ||
        (await readMoneyPreimageDigest(database, "preflight")) !== backup.preimageDigest ||
        (await readMoneyAggregateDigest(database, "preflight")) !== backup.aggregateDigest)
    ) {
      throw preflightError("money cutover pending state or preimage changed before dispatch");
    }
    if (reviewDigest !== null && options.independentReview !== undefined) {
      const reviewedNow = await options.independentReview(reviewBinding);
      if (reviewedNow === null || validateReview(reviewBinding, reviewedNow) !== reviewDigest) {
        throw preflightError("money independent review changed before dispatch");
      }
    }
    if ((await options.custody.read(options.phase)) !== null)
      throw mutationError("money cutover custody appeared before dispatch; do not retry");
    const importPath = join(root, "import.sql");
    writeProtectedFile(importPath, Buffer.from(sql, "utf8"));
    const sealedImport = sealDirectory(root, ["wrangler.jsonc", "import.sql"]);
    const expectedAfter =
      options.phase === "abandon"
        ? actualPhase === "0093-fenced"
          ? "0093"
          : "0092"
        : selected.after;
    const binding: MoneyCutoverDispatchBinding = {
      kind: "takoserver.money-cutover-dispatch@v1",
      phase: options.phase,
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      databaseName: target.d1.databaseName,
      originDigest,
      predecessorCustodyDigest: reviewBinding.predecessorCustodyDigest,
      sourceCommit: invocation.commit,
      sourceDigest: reviewBinding.sourceDigest,
      importDigest,
      backupDigest: backup.digest,
      preimageDigest: backup.preimageDigest,
      aggregateDigest: backup.aggregateDigest,
      classificationDigest: reviewBinding.classificationDigest,
      writerDigest,
      resumeDigest,
      writerEpoch: options.writerEpoch,
      reviewDigest,
      beforeShapeDigest: initial.shapeDigest,
      afterSchemaPhase: expectedAfter,
      sealedImportPath: importPath,
    };
    const bindingDigest = moneyCutoverBindingDigest(binding);
    validateCustody(
      await options.custody.dispatch(binding),
      options.phase,
      bindingDigest,
      "dispatched",
    );
    sealedImport.assertUnchanged();
    assertOriginalWriter();
    await runImport(importPath, configPath, target, run, environment);
    try {
      if (originalWriter !== undefined) {
        try {
          const postOrigin = await options.stageOriginProof();
          const postIdentity = await options.storageIdentityRead();
          assertOriginalWriter();
          assertStageTarget(target, postOrigin, postIdentity, true);
          if (
            digest(JSON.stringify(postOrigin)) !== originDigest ||
            JSON.stringify(postIdentity) !== JSON.stringify(liveIdentity)
          )
            throw verificationError(
              "fresh money original identity changed after import; retain custody",
            );
        } catch (cause) {
          const failure = verificationError(
            "fresh money original readback failed after import; keep freeze and inspect status without replay",
          );
          failure.cause = cause;
          throw failure;
        }
      }
      const post = await readD1SchemaState(database, "verification");
      assertOriginalWriter("verification");
      if (!moneyUnitCutoverSchemaMatches(post, files, expectedAfter)) {
        throw verificationError(
          "money cutover import was acknowledged but exact terminal schema failed; keep freeze and repair forward",
        );
      }
      if (expectedAfter === "0094") {
        await assertResumedFreezeEmpty(database, "verification", options.writerEpoch);
        if (options.resumeHealthRead === undefined)
          throw verificationError("money resume healthy native readback is unavailable");
        await options.resumeHealthRead("healthy");
        if (
          options.resumeProof === undefined ||
          digest(JSON.stringify(await options.resumeProof())) !== resumeDigest
        )
          throw verificationError("money resumed native Version changed after D1 transition");
      } else if (expectedAfter.endsWith("-fenced"))
        await assertPermitEmpty(database, "verification", options.writerEpoch);
      if (
        options.phase === "freeze" ||
        options.phase === "prepare" ||
        options.phase === "classify" ||
        options.phase === "abandon"
      ) {
        if (options.phase !== "abandon")
          assertFreezeRow(
            await readFreezeRow(database, "verification"),
            anchor,
            originDigest,
            backup.digest,
            writerDigest,
            "verification",
          );
        if (
          (await readMoneyPreimageDigest(database, "verification")) !== backup.preimageDigest ||
          (await readMoneyAggregateDigest(database, "verification")) !== backup.aggregateDigest ||
          (await readMoneyFrozenDataDigest(database, "verification")) !== backup.financialDigest
        ) {
          throw verificationError(
            "money freeze changed financial rows; keep freeze and repair forward",
          );
        }
      }
      if (options.phase === "convert" || options.phase === "resume") {
        if (
          (await readMoneyPreimageDigest(database, "verification", true)) !==
            backup.preimageDigest ||
          (await readMoneyAggregateDigest(database, "verification", true)) !==
            backup.aggregateDigest
        ) {
          throw verificationError(
            "money converted preimage differs from protected backup; repair forward",
          );
        }
        await assertClassificationsStored(database, classifications, "verification");
      }
      if (options.phase === "classify")
        await assertClassificationsStored(database, classifications, "verification");
      await assertMoneyNativeForeignKeys(database, "verification");
      const postDigest = digest(
        JSON.stringify({
          applied: post.applied,
          shapeDigest: post.shapeDigest,
          preimageDigest: backup.preimageDigest,
          aggregateDigest: backup.aggregateDigest,
        }),
      );
      validateCustody(
        await options.custody.terminal(binding, postDigest),
        options.phase,
        bindingDigest,
        "terminal",
        postDigest,
      );
      return {
        ...status,
        schemaPhase: expectedAfter,
        schemaShapeDigest: post.shapeDigest,
        custody: "terminal",
        readyForApply: false,
        postDigest,
        ...(options.phase === "abandon"
          ? {
              writerState: "maintenance-still-quiesced",
              nextAction: "review-qualified old-cents native recovery or forward repair",
            }
          : {}),
      };
    } catch (cause) {
      if (cause instanceof DeployError && cause.phase === "verification") throw cause;
      const failure = verificationError(
        "money import was acknowledged but verification or custody settlement failed; keep freeze and inspect status without replay",
      );
      failure.cause = cause;
      throw failure;
    }
  } finally {
    if (lease !== null) await lease.release();
    if (options.outputDirectory === undefined) rmSync(root, { recursive: true, force: true });
  }
}
