import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
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
import type { Sql, SqlParam } from "../../src/ports.ts";
import {
  frameHostMigrationSql,
  prepareNativeMigrationSql,
} from "../../src/sqlite-migration-policy.ts";
import { assertStripeModeRealm } from "../../src/stripe-mode-realm.ts";
import { applicationSchemaMatches, canonicalApplicationShape } from "./application-schema-shape.ts";
import { readAuth103CanonicalMigrationSource } from "./auth103-canonical-migration-source.ts";
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
import { readMoneyNativeTypedCensusDigest } from "./money-native-typed-census.ts";
import type { MoneyNormalWorkerSigningGenesisContribution } from "./money-normal-worker-version-upload.ts";
import {
  type CommandResult,
  REPOSITORY,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { qualifySource, sealDirectory } from "./qualification.ts";
import type {
  MoneyUnitHeldPost94ConsumerInputs,
  MoneyUnitOriginalCutoverOptions,
} from "./schema-money-unit-owner.ts";
import type { MoneyRealmPinContribution, MoneyRealmPinDraftData } from "./stripe-mode-realm.ts";
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
export type MoneyCustodyPhase = MoneyCutoverPhase | "preserved100";
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
  readonly throughMigration: "0093" | "0094" | "0098" | "0100";
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

/** Immutable uploaded-Version facts only; neither current traffic nor serving permission. */
export interface MoneyHeldNormalWorkerModeFacts {
  readonly kind: "takoserver.money-held-normal-worker-mode-facts@v1";
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly bucketName: string;
  readonly workerName: string;
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
  readonly heldConvertDigest: string;
  readonly convertBindingDigest: string;
  readonly converted94BackupDigest: string;
  readonly versionId: string;
  readonly sourceCommit: string;
  readonly moduleDigest: string;
  readonly sourceArtifactDigest: string;
  readonly sourceArtifactBytes: number;
  readonly sourceArtifactFiles: number;
  readonly sourceTreeDigest: string;
  readonly dependencyClosureDigest: string;
  readonly toolClosureDigest: string;
  readonly nativeBindingDigest: string;
  readonly stripeMode: "test";
  readonly modeEvidence: "explicit-native-test" | "verified-source-default-test-native-absence";
  readonly entrySourceDigest: string;
  readonly entryModuleSourceDigest: string;
  readonly parserSourceDigest: string;
  readonly parserFunctionDigest: string;
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

/** Selection data only; this is neither a Financial review nor a native mode proof. */
export interface MoneyPost94SelectionReviewBinding {
  readonly kind: "takoserver.money-post94-selection-review@v1";
  readonly phase: MoneyPost94Phase;
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
  readonly original92BackupDigest: string;
  readonly converted94BackupDigest: string;
  readonly convertBindingDigest: string;
  readonly selectedStripeMode: "test";
  readonly declarationDigest: string;
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
  /** Bound selection data, not a normal Worker TEST-mode or Financial policy proof. */
  readonly selectedStripeMode: "test";
  readonly selectionReviewDigest: string;
  readonly financialContributionDigest?: string;
  readonly financialSourceBindingDigest?: string;
  readonly financialContributionPath?: string;
  readonly signingGenesisDigest?: string;
  readonly signingGenesisPath?: string;
}

/** Exact pre-import review DATA for the sole suffix import, not a phase grant. */
export interface MoneyPost94OneDispatchBinding extends MoneyPost94DispatchBinding {
  readonly financialContributionDigest: string;
  readonly financialSourceBindingDigest: string;
  readonly financialContributionPath: string;
  readonly signingGenesisDigest: string;
  readonly signingGenesisPath: string;
}

/** Same original custody journal, but a distinct exact98→100 transition. */
export interface MoneyPreserved100DispatchBinding
  extends Omit<MoneyLegacyCutoverDispatchBinding, "kind" | "phase" | "afterSchemaPhase"> {
  readonly kind: "takoserver.money-cutover-dispatch@v3";
  readonly phase: "preserved100";
  readonly afterSchemaPhase: "0100-fenced";
  readonly suffixBindingDigest: string;
  readonly suffixPostDigest: string;
  readonly expectedAfterShapeDigest: string;
  readonly nextWriterEpoch: string;
  readonly suffixReviewDigest: string;
}

/** The existing protected exact-review record binds this one source-built transition. */
export interface MoneyPreserved100ReviewBinding {
  readonly kind: "takoserver.money-preserved100-import-review@v1";
  readonly phase: "preserved100";
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly bucketName: string;
  readonly workerName: string;
  readonly sourceCommit: string;
  readonly sourceDigest: string;
  readonly importDigest: string;
  readonly suffixBindingDigest: string;
  readonly suffixPostDigest: string;
  readonly suffixReviewDigest: string;
  readonly freezeBindingDigest: string;
  readonly originDigest: string;
  readonly original92BackupDigest: string;
  readonly writerDigest: string;
  readonly nextWriterEpoch: string;
  readonly beforeShapeDigest: string;
  readonly afterShapeDigest: string;
}

export interface MoneyPost94ImportReviewBinding
  extends Omit<
    MoneyPost94OneDispatchBinding,
    | "kind"
    | "reviewDigest"
    | "beforeShapeDigest"
    | "afterSchemaPhase"
    | "sealedImportPath"
    | "financialContributionPath"
    | "signingGenesisPath"
  > {
  readonly kind: "takoserver.money-post94-import-review@v1";
}

export type MoneyCutoverDispatchBinding =
  | MoneyLegacyCutoverDispatchBinding
  | MoneyPost94DispatchBinding
  | MoneyPreserved100DispatchBinding;

export interface MoneyCutoverCustodyReceipt {
  readonly kind: "takoserver.money-cutover-custody@v1";
  readonly phase: MoneyCustodyPhase;
  readonly state: "dispatched" | "terminal";
  readonly bindingDigest: string;
  readonly postDigest: string | null;
}

export interface MoneyCutoverCustody {
  read(phase: MoneyCustodyPhase): Promise<MoneyCutoverCustodyReceipt | null>;
  /** Exact immutable dispatch body, retained separately from the no-overwrite receipt. */
  readDispatch(phase: MoneyCustodyPhase): Promise<MoneyCutoverDispatchBinding | null>;
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

/** Exact source-owned persistent objects that the Money suffix preserves. */
export function moneyPost94GuardDefinitions(): readonly (readonly [string, string])[] {
  return [
    [FENCE_TABLE, FENCE_DDL],
    [MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE, MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL],
    [MONEY_CUTOVER_PERMIT_TABLE, MONEY_CUTOVER_PERMIT_DDL],
    ["money_cutover_permit_epoch_guard", MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL],
    ...fenceTables("0098-fenced").flatMap((table) =>
      verbs.map(
        (verb) => [moneyFenceTriggerName(table, verb), fenceTriggerSql(table, verb)] as const,
      ),
    ),
  ];
}

let post94ExpectedShapeCache: { readonly sourceDigest: string; readonly shape: string } | null =
  null;

export function moneyPost94ExpectedShape(files: readonly MigrationFile[]): string {
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
    const definitions = moneyPost94GuardDefinitions();
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

/**
 * Exact candidate 103 application shape reached from the Money fenced98
 * lineage. The Auth103 owner must independently accept this precise preserved
 * Money union and verify its own source/installation receipts. Source replay
 * fails if 99–103 remove or rewrite a Money guard; nothing is silently healed.
 */
function moneyPostExpectedPreservedShape(
  files: readonly MigrationFile[],
  through: 100 | 103,
): string {
  assertMoneyPost94Source(files);
  if (
    files.length !== through ||
    files.some(
      (file, index) =>
        !new RegExp(`^${String(index + 1).padStart(4, "0")}_[-a-z0-9_]+\\.sql$`, "u").test(
          file.name,
        ),
    )
  )
    throw preflightError("money preserved shape requires the exact selected source inventory");
  const database = new Database(":memory:", { strict: true });
  let stage = "prefix94";
  try {
    database.query("PRAGMA foreign_keys = ON").all();
    executeMoneyHostSql(
      database,
      buildD1MigrationImport(files.slice(0, 94), { freshLedger: true }).sql,
    );
    executeMoneyHostSql(
      database,
      `${FENCE_DDL};\n${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};\n${MONEY_CUTOVER_PERMIT_DDL};\n${MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL};\n${moneyFenceInstallSql("0094-fenced")}`,
    );
    stage = "suffix98";
    executeMoneyHostSql(
      database,
      buildD1MigrationImport(files.slice(94, 98), { freshLedger: false }).sql,
    );
    for (const [name, sql] of moneyPost94GuardDefinitions()) {
      const existing = database.query("SELECT sql FROM sqlite_schema WHERE name = ?").get(name) as {
        sql: string;
      } | null;
      if (existing === null) executeMoneyHostSql(database, `${sql};`);
      else if (existing.sql !== sql)
        throw preflightError("money post103 predecessor guard differs from owned98 source");
    }
    for (const [index, file] of files.slice(98, through).entries()) {
      stage = `successor${99 + index}`;
      const statements = frameHostMigrationSql(
        buildD1MigrationImport([file], { freshLedger: false }).sql,
      );
      for (const [statementIndex, statement] of statements.entries()) {
        try {
          database.exec(statement);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const category = message.includes("already exists")
            ? "existing-object"
            : message.includes("no such table")
              ? "missing-table"
              : message.includes("no such column")
                ? "missing-column"
                : message.includes("FOREIGN KEY")
                  ? "foreign-key"
                  : message.includes("syntax error")
                    ? "syntax"
                    : message.includes("constraint failed")
                      ? message.includes("UNIQUE")
                        ? message.includes("d1_migrations.name")
                          ? "migration-ledger-duplicate"
                          : message.includes("money_cutover")
                            ? "money-fence-trap"
                            : message.includes("tf_v2")
                              ? "container-identity"
                              : message.includes("auth103")
                                ? "auth-identity"
                                : "unique-constraint"
                        : message.includes("CHECK")
                          ? "check-constraint"
                          : message.includes("NOT NULL")
                            ? "not-null-constraint"
                            : "constraint"
                      : message.includes("is not allowed")
                        ? "not-allowed"
                        : message.includes("cannot")
                          ? "cannot"
                          : message.includes("not authorized")
                            ? "not-authorized"
                            : "sqlite-rejection";
          stage = `successor${99 + index}-statement${statementIndex}-${category}`;
          throw error;
        }
      }
    }
    stage = "preserved-guards";
    for (const [name, sql] of moneyPost94GuardDefinitions()) {
      const existing = database.query("SELECT sql FROM sqlite_schema WHERE name = ?").get(name) as {
        sql: string;
      } | null;
      if (existing?.sql !== sql)
        throw preflightError("money successor removed or changed an original guard");
    }
    stage = "canonical-shape";
    return canonicalApplicationShape(moneyLocalSchema(database));
  } catch {
    throw preflightError(`money exact preserved shape could not be reconstructed at ${stage}`);
  } finally {
    database.close();
  }
}

/** Exact original100 predecessor of the Money-preserved Auth103 transition. */
export function moneyPost100ExpectedPreservedShape(files: readonly MigrationFile[]): string {
  return moneyPostExpectedPreservedShape(files, 100);
}

/** Exact Money-preserved post103 shape, including source-owned guards. */
export function moneyPost103ExpectedPreservedShape(files: readonly MigrationFile[]): string {
  return moneyPostExpectedPreservedShape(files, 103);
}

/**
 * Select an original100 or full103 observation from the whole current checkout.
 * The audited source owner validates the complete inventory, including every
 * canonical Auth103 successor, before the Money reader takes a 100 prefix.
 * This is source DATA, not native qualification or permission to apply files.
 */
export function readMoneyOriginalPreservedSourceInventory(
  sourceDirectory: string,
  through: 100 | 103,
  scratchBase: string,
): {
  readonly sourceDigest: string;
  readonly files: readonly MigrationFile[];
  assertCurrent(): void;
  dispose(): void;
} {
  const source = readAuth103CanonicalMigrationSource(resolve(sourceDirectory, ".."), scratchBase);
  return Object.freeze({
    sourceDigest: source.artifact.digest,
    files: through === 100 ? source.prefix.files : source.artifact.files,
    assertCurrent: () => source.assertCurrent(),
    dispose: () => source.dispose(),
  });
}

export interface MoneyPreserved100ImportData {
  readonly kind: "takoserver.money-preserved100-import-data@v1";
  readonly qualification: "source-data-only";
  readonly sourceDigest: string;
  readonly importDigest: string;
  readonly sql: string;
  readonly beforeShape: string;
  readonly afterShape: string;
  readonly names: readonly string[];
}

function moneyPreserved100SqlShapePredicate(shape: string): string {
  return `NOT EXISTS (
    WITH expected AS MATERIALIZED (SELECT value FROM json_each(${sqlLiteral(shape)})),
    actual AS MATERIALIZED (SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM main.sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' AND tbl_name NOT IN ('d1_migrations','_cf_KV','_cf_METADATA'))
    SELECT 1 FROM expected LEFT JOIN actual ON actual.type=json_extract(expected.value,'$.type')
      AND actual.name=json_extract(expected.value,'$.name')
      AND actual.tbl_name=json_extract(expected.value,'$.table')
    WHERE actual.name IS NULL OR actual.sql IS NOT json_extract(expected.value,'$.sql')
    UNION ALL
    SELECT 1 FROM actual WHERE NOT EXISTS (SELECT 1 FROM expected
      WHERE actual.type=json_extract(expected.value,'$.type') AND actual.name=json_extract(expected.value,'$.name')
        AND actual.tbl_name=json_extract(expected.value,'$.table'))
  )`;
}

/** Pure, audited 99–100 source DATA. The native owner supplies original custody. */
export function buildMoneyOriginalPreserved100ImportData(input: {
  readonly sourceDirectory: string;
  readonly scratchBase: string;
  readonly freezeBindingDigest: string;
  readonly originDigest: string;
  readonly original92BackupDigest: string;
  readonly writerDigest: string;
  readonly nextWriterEpoch: string;
  readonly signingKeyId: string;
  readonly signingPublicJwk: string;
  readonly signingCreatedAtEpochSeconds: number;
}): MoneyPreserved100ImportData {
  const fields = [
    "sourceDirectory",
    "scratchBase",
    "freezeBindingDigest",
    "originDigest",
    "original92BackupDigest",
    "writerDigest",
    "nextWriterEpoch",
    "signingKeyId",
    "signingPublicJwk",
    "signingCreatedAtEpochSeconds",
  ] as const;
  if (
    !record(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...fields].sort()) ||
    fields.some((name) => {
      const slot = Object.getOwnPropertyDescriptor(input, name);
      return !slot || !("value" in slot) || !slot.enumerable;
    })
  )
    throw preflightError("money preserved100 import requires closed source-owned DATA");
  for (const value of [
    input.freezeBindingDigest,
    input.originDigest,
    input.original92BackupDigest,
    input.writerDigest,
    input.nextWriterEpoch,
  ])
    if (!SHA256.test(value)) throw preflightError("money preserved100 binding is malformed");
  if (
    typeof input.signingKeyId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.signingKeyId) ||
    typeof input.signingPublicJwk !== "string" ||
    Buffer.byteLength(input.signingPublicJwk, "utf8") > 1024 ||
    !Number.isSafeInteger(input.signingCreatedAtEpochSeconds) ||
    input.signingCreatedAtEpochSeconds < 0
  )
    throw preflightError("money preserved100 signing identity is malformed");
  const source = readMoneyOriginalPreservedSourceInventory(
    input.sourceDirectory,
    100,
    input.scratchBase,
  );
  try {
    const files = source.files;
    const beforeShape = moneyPost94ExpectedShape(files);
    const afterShape = moneyPost100ExpectedPreservedShape(files);
    const names = Object.freeze(files.map((file) => file.name));
    const freeze = [
      `binding_digest = ${sqlLiteral(input.freezeBindingDigest)}`,
      `origin_digest = ${sqlLiteral(input.originDigest)}`,
      `backup_digest = ${sqlLiteral(input.original92BackupDigest)}`,
      `writer_digest = ${sqlLiteral(input.writerDigest)}`,
      `source_digest = ${sqlLiteral(SOURCE_0092)}`,
    ].join(" AND ");
    const ledger = (count: 98 | 100) =>
      `(SELECT json_group_array(name) FROM
        (SELECT name FROM main.d1_migrations ORDER BY id))
        IS ${sqlLiteral(JSON.stringify(names.slice(0, count)))}
        AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema
          WHERE tbl_name='d1_migrations' AND type<>'table' AND name NOT GLOB 'sqlite_*')`;
    const invariant = `(SELECT COUNT(*) FROM money_cutover_freeze) = 1
       AND EXISTS (SELECT 1 FROM money_cutover_freeze WHERE singleton = 1 AND ${freeze})
       AND (SELECT COUNT(*) FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}) = 1
       AND EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}
         WHERE singleton = 1 AND writer_epoch = ${sqlLiteral(input.nextWriterEpoch)})
       AND NOT EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_PERMIT_TABLE})
       AND (SELECT COUNT(*) FROM stripe_mode_realm) = 1
       AND EXISTS (SELECT 1 FROM stripe_mode_realm WHERE singleton = 1 AND mode = 'test')
       AND (SELECT COUNT(*) FROM runtime_grant_keys) = 1
       AND EXISTS (SELECT 1 FROM runtime_grant_keys WHERE
         key_id = ${sqlLiteral(input.signingKeyId)}
         AND public_jwk = ${sqlLiteral(input.signingPublicJwk)}
         AND created_at_epoch_seconds = ${input.signingCreatedAtEpochSeconds}
         AND revoked_at_epoch_seconds IS NULL)`;
    const guard = (predicate: string) =>
      `SELECT json(CASE WHEN (${predicate}) IS 1 THEN '{}' ELSE '!' END);\n`;
    const migration = buildD1MigrationImport(files.slice(98, 100), { freshLedger: false });
    const sql =
      guard(
        `${ledger(98)} AND ${moneyPreserved100SqlShapePredicate(beforeShape)} AND ${invariant}`,
      ) +
      migration.sql +
      "\n" +
      guard(
        `${ledger(100)} AND ${moneyPreserved100SqlShapePredicate(afterShape)} AND ${invariant}`,
      );
    source.assertCurrent();
    return Object.freeze({
      kind: "takoserver.money-preserved100-import-data@v1",
      qualification: "source-data-only",
      sourceDigest: source.sourceDigest,
      importDigest: digest(sql),
      sql,
      beforeShape,
      afterShape,
      names,
    });
  } finally {
    source.dispose();
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
  binding:
    | MoneyCutoverDispatchBinding
    | MoneyReviewBinding
    | MoneyPost94SelectionReviewBinding
    | MoneyPost94ImportReviewBinding
    | MoneyPreserved100ReviewBinding,
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

export interface ClassificationRow {
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

/**
 * The post103 thaw is one guarded native DELETE. It can remove only the
 * original Money freeze row, while the selected new epoch, empty permit and
 * exact 103-name ledger are still present. The caller must require one
 * RETURNING row and re-read the full schema, FK state and public health.
 */
export function moneyPost103OriginalFreezeReleaseSql(input: {
  readonly files: readonly MigrationFile[];
  readonly freezeBindingDigest: string;
  readonly originDigest: string;
  readonly original92BackupDigest: string;
  readonly originalWriterDigest: string;
  readonly currentWriterEpoch: string;
}): string {
  const {
    files,
    freezeBindingDigest,
    originDigest,
    original92BackupDigest,
    originalWriterDigest,
    currentWriterEpoch,
  } = input;
  assertMoneyPost94Source(files);
  if (
    files.length !== 103 ||
    files.some(
      (file, index) =>
        !new RegExp(`^${String(index + 1).padStart(4, "0")}_[-a-z0-9_]+\\.sql$`, "u").test(
          file.name,
        ),
    ) ||
    ![freezeBindingDigest, originDigest, original92BackupDigest, originalWriterDigest].every(
      (value) => SHA256.test(value),
    ) ||
    !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(currentWriterEpoch)
  )
    throw preflightError("money post103 thaw requires exact source, original binding and epoch");
  const orderedNames = sqlLiteral(JSON.stringify(files.map((file) => file.name)));
  return `DELETE FROM ${FENCE_TABLE}
WHERE singleton = 1
  AND binding_digest = ${sqlLiteral(freezeBindingDigest)}
  AND origin_digest = ${sqlLiteral(originDigest)}
  AND backup_digest = ${sqlLiteral(original92BackupDigest)}
  AND writer_digest = ${sqlLiteral(originalWriterDigest)}
  AND source_digest = ${sqlLiteral(SOURCE_0092)}
  AND (SELECT COUNT(*) FROM ${FENCE_TABLE}) = 1
  AND (SELECT COUNT(*) FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}) = 1
  AND EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}
              WHERE singleton = 1 AND writer_epoch = ${sqlLiteral(currentWriterEpoch)})
  AND NOT EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_PERMIT_TABLE})
  AND (SELECT COUNT(*) FROM d1_migrations) = 103
  AND (SELECT json_group_array(name) FROM
       (SELECT name FROM d1_migrations ORDER BY id)) IS ${orderedNames}
RETURNING binding_digest`;
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

/** Fixed Root SQL DATA around the still-missing operative Financial contribution. */
export interface MoneyPost94RootImportData {
  readonly kind: "takoserver.money-post94-root-import-data@v1";
  readonly qualification: "data-only";
  readonly sourceDigest: string;
  readonly beforeFinancialSql: string;
  readonly afterFinancialSql: string;
  readonly digest: string;
  readonly normalHostReady: false;
}

/**
 * Pure fragments, never import permission. The owning executor still refuses
 * suffix98/resume98 until Financial supplies its real original contribution.
 * A future owner must place all three Financial statements adjacently between
 * these fragments inside the SAME existing sealed ONE; no new importer lives here.
 */
export function buildMoneyPost94RootImportData(input: {
  readonly files: readonly MigrationFile[];
  readonly freezeBindingDigest: string;
  readonly originDigest: string;
  readonly original92BackupDigest: string;
  readonly writerDigest: string;
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
}): MoneyPost94RootImportData {
  const fields = [
    "files",
    "freezeBindingDigest",
    "originDigest",
    "original92BackupDigest",
    "writerDigest",
    "previousWriterEpoch",
    "nextWriterEpoch",
  ] as const;
  if (
    input === null ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).length !== fields.length
  )
    throw preflightError("money post94 Root DATA requires only closed own-data fields");
  const captured = Object.fromEntries(
    fields.map((name) => {
      const property = Object.getOwnPropertyDescriptor(input, name);
      if (!property || !("value" in property) || !property.enumerable)
        throw preflightError("money post94 Root DATA fields must be own data");
      return [name, property.value];
    }),
  ) as typeof input;
  const { files, previousWriterEpoch, nextWriterEpoch } = captured;
  for (const name of fields.filter((name) => name !== "files"))
    if (typeof captured[name] !== "string" || !SHA256.test(captured[name]))
      throw preflightError("money post94 Root DATA requires exact SHA256 bindings");
  if (previousWriterEpoch === nextWriterEpoch)
    throw preflightError("money post94 Root DATA requires distinct old and next epochs");
  assertMoneyPost94Source(files);
  const suffix = buildD1MigrationImport(files.slice(94, 98), {
    freshLedger: false,
  });
  const freezeValues = [
    captured.freezeBindingDigest,
    captured.originDigest,
    captured.original92BackupDigest,
    captured.writerDigest,
    SOURCE_0092,
  ].map(sqlLiteral);
  const freezePredicate = [
    "singleton = 1",
    `binding_digest = ${freezeValues[0]}`,
    `origin_digest = ${freezeValues[1]}`,
    `backup_digest = ${freezeValues[2]}`,
    `writer_digest = ${freezeValues[3]}`,
    `source_digest = ${freezeValues[4]}`,
  ].join(" AND ");
  const stateGuard = (epoch: string, through: 94 | 98): string =>
    `INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE} (singleton, epoch, writer_epoch) SELECT 1, 'invalid-post94-root-state', ${sqlLiteral(epoch)} WHERE (SELECT COUNT(*) FROM ${FENCE_TABLE}) != 1 OR NOT EXISTS (SELECT 1 FROM ${FENCE_TABLE} WHERE ${freezePredicate}) OR (SELECT COUNT(*) FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}) != 1 OR NOT EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} WHERE singleton = 1 AND writer_epoch = ${sqlLiteral(epoch)}) OR EXISTS (SELECT 1 FROM ${MONEY_CUTOVER_PERMIT_TABLE}) OR (SELECT COUNT(*) FROM d1_migrations) != ${through} OR EXISTS (SELECT 1 FROM d1_migrations WHERE name IS NULL OR name NOT IN (${files
      .slice(0, through)
      .map((file) => sqlLiteral(file.name))
      .join(", ")}));`;
  const restore: string[] = [];
  const database = new Database(":memory:");
  const executeExpectedSql = (sql: string): void => {
    // Bun exec(script) can continue after an earlier statement error. Use the
    // existing Host framer so an invalid opaque source reconstruction stops here.
    for (const statement of frameHostMigrationSql(sql)) database.exec(statement);
  };
  try {
    // Canonical migration bodies stay opaque and byte-checked by the existing
    // importer. Only known Root guard definitions may be restored here.
    executeExpectedSql(buildD1MigrationImport(files.slice(0, 94), { freshLedger: true }).sql);
    executeExpectedSql(
      `${FENCE_DDL};\n${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};\n${MONEY_CUTOVER_PERMIT_DDL};\n${MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL};\n${moneyFenceInstallSql("0094-fenced")}`,
    );
    executeExpectedSql(suffix.sql);
    const missing = new Set<string>();
    for (const [name, definition] of moneyPost94GuardDefinitions()) {
      const existing = database.query("SELECT sql FROM sqlite_schema WHERE name = ?").get(name) as {
        sql: string;
      } | null;
      if (existing === null) {
        missing.add(name);
        restore.push(`${definition};`);
        executeExpectedSql(`${definition};`);
      } else if (existing.sql !== definition)
        throw preflightError("money post94 Root guard definition differs from fixed source");
    }
    if (missing.has(FENCE_TABLE))
      restore.push(`INSERT INTO ${FENCE_TABLE} VALUES (1, ${freezeValues.join(", ")});`);
    if (missing.has(MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE))
      restore.push(
        `INSERT INTO ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} (singleton, writer_epoch) VALUES (1, ${sqlLiteral(previousWriterEpoch)});`,
      );
  } finally {
    database.close();
  }
  const beforeFinancialSql = [
    stateGuard(previousWriterEpoch, 94),
    suffix.sql,
    ...restore,
    stateGuard(previousWriterEpoch, 98),
  ].join("\n");
  const afterFinancialSql = [
    stateGuard(previousWriterEpoch, 98),
    `UPDATE ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE} SET writer_epoch = ${sqlLiteral(nextWriterEpoch)} WHERE singleton = 1 AND writer_epoch = ${sqlLiteral(previousWriterEpoch)};`,
    `INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE} (singleton, epoch, writer_epoch) SELECT 1, 'invalid-post94-root-rotation', ${sqlLiteral(nextWriterEpoch)} WHERE changes() != 1;`,
    stateGuard(nextWriterEpoch, 98),
  ].join("\n");
  assertMoneyPost94Source(files);
  return Object.freeze({
    kind: "takoserver.money-post94-root-import-data@v1",
    qualification: "data-only",
    sourceDigest: SOURCE_0098,
    beforeFinancialSql,
    afterFinancialSql,
    digest: digest(JSON.stringify([SOURCE_0098, beforeFinancialSql, afterFinancialSql])),
    normalHostReady: false,
  });
}

/** Local source-built result DATA. The actual executor still checks original producers. */
export interface MoneyPost94OneImportData {
  readonly qualification: "source-data-only";
  readonly sql: string;
  readonly digest: string;
  readonly financialStatementsDigest: string;
  readonly expectedRowCounts: Readonly<Record<string, number>>;
  readonly expectedAllDataDigest: string;
}

function executeMoneyHostSql(database: Database, sql: string): void {
  for (const statement of frameHostMigrationSql(sql)) database.exec(statement);
}

function moneyLocalSchema(database: Database): D1SchemaState {
  const applied = (
    database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
  ).map((row) => row.name);
  const shape = canonicalSchemaShape(
    database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[],
  );
  return { applied, shape, shapeDigest: digest(shape) };
}

/** Native SQLite prepares/binds/expands without executing the selected statement. */
function renderMoneyBoundSql(database: Database, sql: string, params: readonly SqlParam[]): string {
  if (
    typeof sql !== "string" ||
    Buffer.byteLength(sql, "utf8") > 100_000 ||
    frameHostMigrationSql(sql).length !== 1 ||
    params.length > 100
  )
    throw preflightError(
      "money ONE requires one bounded original statement and at most100 parameters",
    );
  const captured = params.map((value) => {
    if (typeof value === "string") {
      if (
        value.includes("\0") ||
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "utf8")) !== value
      )
        throw preflightError(
          "money ONE string parameter cannot be represented losslessly by native SQLite expansion",
        );
      return value;
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0))
      return value;
    if (value === null) return null;
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    throw preflightError("money ONE parameter must retain its exact native type and value");
  });
  const statement = database.prepare(sql, captured);
  try {
    if (statement.paramsCount !== captured.length)
      throw preflightError("money ONE original parameter arity differs");
    const expanded = statement.toString();
    if (
      frameHostMigrationSql(expanded).length !== 1 ||
      Buffer.byteLength(expanded, "utf8") > 100_000
    )
      throw preflightError("money ONE expanded statement exceeds the native bounded shape");
    return expanded.endsWith(";") ? expanded : `${expanded};`;
  } finally {
    statement.finalize();
  }
}

/** Public registration DATA only; native ownership is supplied by the real genesis owner. */
export interface MoneyPost94SigningGenesisDataInput {
  readonly keyId: string;
  readonly publicJwk: string;
  readonly createdAtEpochSeconds: number;
  readonly previousWriterEpoch: string;
}
export function buildMoneyPost94SigningGenesisData(
  input: MoneyPost94SigningGenesisDataInput,
): readonly [string, string, string] {
  const names = ["keyId", "publicJwk", "createdAtEpochSeconds", "previousWriterEpoch"] as const;
  if (!record(input) || Reflect.ownKeys(input).length !== names.length)
    throw preflightError("money signing registration requires closed public DATA");
  const values = Object.fromEntries(
    names.map((name) => {
      const slot = Object.getOwnPropertyDescriptor(input, name);
      if (!slot || !("value" in slot))
        throw preflightError("money signing registration fields must be own DATA");
      return [name, slot.value];
    }),
  ) as unknown as MoneyPost94SigningGenesisDataInput;
  if (
    typeof values.keyId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(values.keyId) ||
    typeof values.publicJwk !== "string" ||
    Buffer.byteLength(values.publicJwk, "utf8") > 1024 ||
    !Number.isSafeInteger(values.createdAtEpochSeconds) ||
    values.createdAtEpochSeconds < 0 ||
    Object.is(values.createdAtEpochSeconds, -0) ||
    !SHA256.test(values.previousWriterEpoch)
  )
    throw preflightError(
      "money signing registration public identity or retained creation DATA is malformed",
    );
  let publicJwk: unknown;
  try {
    publicJwk = JSON.parse(values.publicJwk);
  } catch {
    throw preflightError("money signing registration public JWK is malformed");
  }
  if (
    !record(publicJwk) ||
    Object.keys(publicJwk).sort().join(",") !== "crv,kty,x" ||
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(publicJwk.x) ||
    Buffer.from(publicJwk.x, "base64url").length !== 32 ||
    Buffer.from(publicJwk.x, "base64url").toString("base64url") !== publicJwk.x ||
    values.publicJwk !== JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x })
  )
    throw preflightError("money signing registration requires canonical public-only Ed25519 bytes");
  const exact = `key_id=${sqlLiteral(values.keyId)} AND public_jwk=${sqlLiteral(values.publicJwk)} AND created_at_epoch_seconds=${values.createdAtEpochSeconds} AND revoked_at_epoch_seconds IS NULL`;
  const bad = (condition: string) =>
    `INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE} (singleton,epoch,writer_epoch) SELECT 1,'invalid-post94-signing-genesis',${sqlLiteral(values.previousWriterEpoch)} WHERE ${condition};`;
  return Object.freeze([
    bad("(SELECT COUNT(*) FROM runtime_grant_keys)!=0"),
    `INSERT INTO runtime_grant_keys (key_id,public_jwk,created_at_epoch_seconds,revoked_at_epoch_seconds) VALUES (${sqlLiteral(values.keyId)},${sqlLiteral(values.publicJwk)},${values.createdAtEpochSeconds},NULL) RETURNING key_id,public_jwk,created_at_epoch_seconds,revoked_at_epoch_seconds;`,
    bad(
      `changes()!=1 OR (SELECT COUNT(*) FROM runtime_grant_keys)!=1 OR NOT EXISTS(SELECT 1 FROM runtime_grant_keys WHERE ${exact})`,
    ),
  ]);
}

/** Never expose a native SQLite query, expanded parameters or foreign error cause. */
function moneyOneLocalFailure(
  error: unknown,
  stage: string,
  source: string,
  bindingsDigest: string,
  statement: number | null,
  cleanupFailed: boolean,
): DeployError {
  const allowed = new Set([
    "money ONE requires one bounded original statement and at most100 parameters",
    "money ONE string parameter cannot be represented losslessly by native SQLite expansion",
    "money ONE parameter must retain its exact native type and value",
    "money ONE original parameter arity differs",
    "money ONE expanded statement exceeds the native bounded shape",
    "money ONE mandatory Financial INSERT did not return its exact singleton TEST postimage",
    "money ONE local snapshot is not exact fenced94",
    "money ONE signing genesis old epoch differs",
    "money ONE signing registration did not return its exact active public row",
    "money ONE local terminal schema differs from immutable98 plus restored guards",
    "money ONE local table name is malformed",
    "money signing registration requires closed public DATA",
    "money signing registration fields must be own DATA",
    "money signing registration public identity or retained creation DATA is malformed",
    "money signing registration public JWK is malformed",
    "money signing registration requires canonical public-only Ed25519 bytes",
  ]);
  let message: unknown, code: unknown;
  try {
    if (typeof error === "object" && error !== null) {
      message = Object.getOwnPropertyDescriptor(error, "message")?.value;
      code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    }
  } catch {}
  const finiteMessage =
    error instanceof DeployError && typeof message === "string" && allowed.has(message)
      ? message
      : "money ONE local exact rehearsal refused";
  const nativeCode =
    code === "SQLITE_ERROR"
      ? "sqlite_error"
      : typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")
        ? "sqlite_constraint"
        : "native_sql_failure";
  return preflightError(
    finiteMessage,
    JSON.stringify({
      kind: "takoserver.money-one-local-failure@v1",
      stage,
      statement,
      nativeCode,
      reason: message === "malformed JSON" ? "malformed_json" : "unreported",
      statementDigest: digest(source),
      bindingsDigest,
      cleanupFailed,
    }),
  );
}

/**
 * Rehearses the EXACT single script on the retained converted94 snapshot locally.
 * This is DATA/atomic-mechanics proof, never a substitute for either original
 * producer. The live route obtains statements only from Financial V15's real
 * constructor and reasserts it immediately before no-overwrite dispatch.
 */
export async function buildMoneyPost94OneImportData(input: {
  readonly root: Parameters<typeof buildMoneyPost94RootImportData>[0];
  readonly financialStatements: MoneyRealmPinDraftData["statements"];
  readonly convertedSnapshot: string;
  readonly signingGenesis: MoneyPost94SigningGenesisDataInput;
}): Promise<MoneyPost94OneImportData> {
  let root: ReturnType<typeof buildMoneyPost94RootImportData>;
  try {
    root = buildMoneyPost94RootImportData(input.root);
  } catch (error) {
    throw moneyOneLocalFailure(
      error,
      "root-source-reconstruction",
      "",
      digest("unavailable-before-original-statement-capture"),
      null,
      false,
    );
  }
  if (!Array.isArray(input.financialStatements) || input.financialStatements.length !== 3)
    throw preflightError("money ONE requires the exact adjacent Financial triple");
  const statements = input.financialStatements.map((statement) => {
    if (
      !record(statement) ||
      Object.getPrototypeOf(statement) !== Object.prototype ||
      Reflect.ownKeys(statement).length !== 2 ||
      !Object.hasOwn(statement, "sql") ||
      !Object.hasOwn(statement, "params")
    )
      throw preflightError("money ONE requires closed original Financial statement DATA");
    const sql = Object.getOwnPropertyDescriptor(statement, "sql"),
      params = Object.getOwnPropertyDescriptor(statement, "params");
    if (
      !sql ||
      !("value" in sql) ||
      !params ||
      !("value" in params) ||
      typeof sql.value !== "string" ||
      !Array.isArray(params.value)
    )
      throw preflightError("money ONE Financial statements must be original own-data vectors");
    const values = Array.from({ length: params.value.length }, (_, index) => {
      const value = Object.getOwnPropertyDescriptor(params.value, String(index));
      if (!value || !("value" in value))
        throw preflightError("money ONE parameters must be own DATA indexes");
      return value.value;
    });
    return Object.freeze({
      sql: sql.value,
      params: Object.freeze(values) as readonly (string | number)[],
    });
  });
  const financialStatementsDigest = digest(JSON.stringify(statements));
  const normalized = normalizeSnapshotDump(Buffer.from(input.convertedSnapshot, "utf8"));
  if (normalized.sql !== input.convertedSnapshot || normalized.nulBytes !== 0)
    throw preflightError("money ONE requires the exact normalized converted94 snapshot");
  const database = new Database(":memory:");
  let stage = "snapshot-import",
    source = normalized.sql;
  let statementIndex: number | null = null;
  let cleanupFailed = false;
  let failure: DeployError | undefined;
  let result: MoneyPost94OneImportData | undefined;
  try {
    executeMoneyHostSql(database, normalized.sql);
    stage = "snapshot-schema";
    if (!moneyUnitCutoverSchemaMatches(moneyLocalSchema(database), input.root.files, "0094-fenced"))
      throw preflightError("money ONE local snapshot is not exact fenced94");
    const expanded: string[] = [];
    database.transaction(() => {
      stage = "root-before";
      source = root.beforeFinancialSql;
      executeMoneyHostSql(database, root.beforeFinancialSql);
      for (const [index, statement] of statements.entries()) {
        let prepared: ReturnType<Database["prepare"]> | undefined;
        let primaryFailure: unknown;
        let didFail = false;
        stage = "financial-expand";
        source = statement.sql;
        statementIndex = index + 1;
        try {
          const sql = renderMoneyBoundSql(database, statement.sql, statement.params);
          expanded.push(sql);
          stage = "financial-prepare";
          prepared = database.prepare(sql);
          stage = "financial-execute";
          const rows = prepared.all() as Record<string, unknown>[];
          if (
            index === 1 &&
            (rows.length !== 1 ||
              Object.keys(rows[0] ?? {})
                .sort()
                .join(",") !== "mode,pinned_at,singleton" ||
              rows[0]?.singleton !== 1 ||
              rows[0]?.mode !== "test")
          )
            throw preflightError(
              "money ONE mandatory Financial INSERT did not return its exact singleton TEST postimage",
            );
        } catch (error) {
          didFail = true;
          primaryFailure = error;
        }
        try {
          prepared?.finalize();
        } catch (error) {
          if (!didFail) {
            didFail = true;
            primaryFailure = error;
            stage = "financial-finalize";
          } else cleanupFailed = true;
        }
        if (didFail) throw primaryFailure;
      }
      statementIndex = null;
      stage = "signing-data";
      source = "";
      const genesisStatements = buildMoneyPost94SigningGenesisData(input.signingGenesis);
      if (input.signingGenesis.previousWriterEpoch !== input.root.previousWriterEpoch)
        throw preflightError("money ONE signing genesis old epoch differs");
      for (const [index, sql] of genesisStatements.entries()) {
        stage = "signing-registration";
        source = sql;
        statementIndex = index + 1;
        const statement = database.prepare(sql);
        try {
          const rows = statement.all() as Record<string, unknown>[];
          if (
            index === 1 &&
            (rows.length !== 1 || !moneySigningPostimageMatches(rows[0], input.signingGenesis))
          )
            throw preflightError(
              "money ONE signing registration did not return its exact active public row",
            );
        } finally {
          statement.finalize();
        }
        expanded.push(sql);
      }
      statementIndex = null;
      stage = "root-after";
      source = root.afterFinancialSql;
      executeMoneyHostSql(database, root.afterFinancialSql);
    })();
    stage = "terminal-schema";
    source = "";
    if (!moneyUnitCutoverSchemaMatches(moneyLocalSchema(database), input.root.files, "0098-fenced"))
      throw preflightError(
        "money ONE local terminal schema differs from immutable98 plus restored guards",
      );
    stage = "terminal-permit";
    await assertPermitEmpty(localReader(database), "preflight", input.root.nextWriterEpoch);
    stage = "terminal-realm";
    await assertStripeModeRealm(
      readonlyMoneySql(localReader(database), database, "preflight"),
      "test",
    );
    stage = "terminal-foreign-keys";
    await assertMoneyNativeForeignKeys(localReader(database), "preflight");
    stage = "terminal-table-list";
    const tables = (
      database
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    stage = "terminal-row-counts";
    const expectedRowCounts = Object.fromEntries(
      tables.map((table) => {
        if (!/^[a-z_][a-z_0-9]*$/u.test(table))
          throw preflightError("money ONE local table name is malformed");
        return [
          table,
          (database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        ];
      }),
    );
    stage = "terminal-typed-census";
    const expectedAllDataDigest = await readWholeDatabaseDataDigest(
      localReader(database),
      "preflight",
      tables,
    );
    const sql = [root.beforeFinancialSql, ...expanded, root.afterFinancialSql].join("\n");
    result = Object.freeze({
      qualification: "source-data-only",
      sql,
      digest: digest(sql),
      financialStatementsDigest,
      expectedRowCounts: Object.freeze(expectedRowCounts),
      expectedAllDataDigest,
    });
  } catch (error) {
    failure = moneyOneLocalFailure(
      error,
      stage,
      source,
      financialStatementsDigest,
      statementIndex,
      cleanupFailed,
    );
  }
  try {
    database.close();
  } catch (error) {
    failure =
      failure === undefined
        ? moneyOneLocalFailure(error, "database-close", "", financialStatementsDigest, null, true)
        : preflightError(
            failure.message,
            JSON.stringify({ ...JSON.parse(failure.detail ?? "{}"), cleanupFailed: true }),
          );
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw preflightError("money ONE exact rehearsal produced no result");
  return result;
}

function readonlyMoneySql(database: PreimageReader, compiler: Database, phase: DeployPhase): Sql {
  return Object.freeze({
    query: async (sql: string, params: readonly SqlParam[] = []) => {
      const framed = prepareNativeMigrationSql(sql, "introspection");
      if (framed.length !== 1 || !["select", "pragma"].includes(framed[0]?.command ?? ""))
        throw proofError(phase, "money realm verification attempted a non-read statement");
      return database.query(
        phase,
        "immutable TEST realm read",
        renderMoneyBoundSql(compiler, sql, params),
      );
    },
    run: async () => {
      throw proofError(phase, "money realm verification has no writer");
    },
    batch: async () => {
      throw proofError(phase, "money realm verification has no batch writer");
    },
  });
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
          "--skip-confirmation",
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

type MoneyPost94ReadInput = MoneyHistoryInput & {
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
  readonly convertedBackupPath: string;
};

/**
 * Shared component inspection. Only the owning reader below may use its retained
 * backup and history facts; the public component result retains its old shape.
 */
async function inspectMoneyUnitPost94Details(
  input: MoneyPost94ReadInput,
  allowOriginalConvertPhase = false,
) {
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
    (allowOriginalConvertPhase
      ? options.phase !== "convert"
      : options.phase !== "suffix98" && options.phase !== "resume98") ||
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
      binding.selectedStripeMode !== "test" ||
      !SHA256.test(binding.selectionReviewDigest) ||
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
  const state: MoneyUnitPost94State = {
    schemaPhase: phase,
    historicalWriterEpoch: previousWriterEpoch,
    currentWriterEpoch,
    convertBindingDigest: history.convert.receipt.bindingDigest,
    converted94BackupDigest: converted.digest,
    continuation: unknown ? "unknown-dispatch" : "blocked-financial-port",
    qualification: "component-simulation-only",
    normalHostReady: false,
  };
  return { state, backup, converted, convertedIdentityDigest, schema, history };
}

/**
 * Component inspection of the same held history and real SQL state. This does not
 * export, import, dispatch, reconcile, publish, or supply Financial realm authority.
 */
export async function inspectMoneyUnitPost94State(
  input: MoneyPost94ReadInput,
): Promise<MoneyUnitPost94State> {
  return (await inspectMoneyUnitPost94Details(input)).state;
}

interface MoneyHeldTableCensus {
  readonly backupDigest: string;
  readonly identityDigest: string;
  readonly allDataDigest: string;
  readonly tableInventory: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly preimageDigest: string;
  readonly aggregateDigest: string;
  readonly financialDigest: string;
}

/** Facts only. Caller-controlled ports never turn this result into native authority. */
export interface MoneyUnitHeldConvertSourceFacts {
  readonly qualification: "component-simulation-only";
  readonly schemaPhase: "0094-fenced";
  readonly origin: MoneyStageOriginProof;
  readonly storage: MoneyStorageIdentity;
  readonly original92: MoneyHeldTableCensus & { readonly sourceDigest: typeof SOURCE_0092 };
  readonly converted94: MoneyHeldTableCensus & { readonly sourceDigest: string };
  readonly current94: {
    readonly schemaShapeDigest: string;
    readonly applied: readonly string[];
    readonly allDataDigest: string;
    readonly tableInventory: readonly string[];
    readonly rowCounts: Readonly<Record<string, number>>;
    readonly freezeBindingDigest: string;
    readonly authorizedWriterEpoch: string;
  };
  readonly conversion: {
    readonly source94Digest: string;
    readonly originDigest: string;
    readonly convertBindingDigest: string;
    readonly convertPostDigest: string;
    readonly convertImportDigest: string;
    readonly freezeBindingDigest: string;
    readonly preimageDigest: string;
    readonly aggregateDigest: string;
    readonly classificationDigest: string;
    readonly classifications: readonly ClassificationRow[];
    readonly writerDigest: string;
    readonly retained: readonly {
      readonly phase: MoneyLegacyCutoverPhase;
      readonly bindingDigest: string;
      readonly receiptDigest: string;
      readonly importDigest: string;
      readonly sourceDigest: string;
    }[];
  };
  readonly maintenance: MoneyWriterProof;
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
}

function freezeMoneyFact<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeMoneyFact(child);
    Object.freeze(value);
  }
  return value;
}

export interface MoneyUnitConverted94BackupData {
  readonly qualification: "component-simulation-only";
  readonly schemaPhase: "0094-fenced";
  readonly convertedBackupPath: string;
  readonly backupDigest: string;
  readonly identityDigest: string;
  readonly captureDigest: string;
  readonly completionDigest: string;
  readonly convertBindingDigest: string;
  readonly historicalWriterEpoch: string;
  readonly sourceDigest: string;
  readonly allDataDigest: string;
  readonly tableInventory: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
}

/**
 * One historical read/export/local-seal operation. DATA only: the original
 * native owner must authenticate its option instance before and after calling.
 * This does not create a held context, dispatch SQL, or select a next epoch.
 */
export async function captureMoneyUnitConverted94Backup(input: {
  readonly target: DeployTarget;
  readonly options: MoneyUnitCutoverOptions;
  readonly convertedBackupPath: string;
}): Promise<MoneyUnitConverted94BackupData> {
  const { target, convertedBackupPath } = input;
  const options = captureMoneyOptions(input.options);
  const targetJson = JSON.stringify(target);
  const epoch = options.writerEpoch;
  if (
    target.environment !== "integration" ||
    target.schemaMaintenanceMode !== "pre-wallet-usd-micros-quiesced" ||
    options.phase !== "convert" ||
    epoch !== target.moneyCutoverWriterEpoch ||
    !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(epoch) ||
    options.outputDirectory === undefined ||
    typeof convertedBackupPath !== "string" ||
    !isAbsolute(convertedBackupPath) ||
    resolve(convertedBackupPath) !== convertedBackupPath ||
    resolve(convertedBackupPath) === resolve(options.backupPath)
  )
    throw preflightError("money converted94 capture requires the unchanged original convert owner");
  assertProtectedDirectory(options.outputDirectory, "money converted94 capture output");
  assertProtectedDirectory(dirname(convertedBackupPath), "money converted94 backup");
  const capturePath = `${convertedBackupPath}.capture.json`;
  const completionPath = `${convertedBackupPath}.capture.complete.json`;
  const identityPath = `${convertedBackupPath}.identity.json`;
  const present = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return false;
      throw preflightError("money converted94 capture path cannot be observed");
    }
  };
  const existing = [capturePath, convertedBackupPath, identityPath, completionPath].map(present);
  const reopening = existing.every(Boolean);
  if (!reopening && existing.some(Boolean))
    throw preflightError("money converted94 capture is partial or unknown; no export or repair");
  const parentStat = lstatSync(dirname(convertedBackupPath));
  const parentIdentity = `${parentStat.dev}:${parentStat.ino}:${parentStat.uid}:${parentStat.mode}`;
  const fileSeal = (path: string): string => {
    // Capture through one no-follow FD, then require the pathname still names
    // that exact file. Hashes and physical identity are both retained across awaits.
    assertProtectedDirectory(dirname(path), "money converted94 capture custody");
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw preflightError("money converted94 capture custody file is unavailable");
    }
    try {
      const before = fstatSync(fd, { bigint: true });
      const fingerprint = (value: typeof before) =>
        [
          value.dev,
          value.ino,
          value.uid,
          value.mode,
          value.nlink,
          value.size,
          value.mtimeNs,
          value.ctimeNs,
        ]
          .map(String)
          .join(":");
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        (before.mode & 0o077n) !== 0n ||
        (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
      )
        throw preflightError("money converted94 capture requires owned link-free0600 files");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      if (fingerprint(before) !== fingerprint(after) || fingerprint(before) !== fingerprint(named))
        throw preflightError("money converted94 capture custody changed during FD read");
      return `${fingerprint(after)}:${digest(bytes)}`;
    } finally {
      closeSync(fd);
    }
  };
  const syncCaptureDirectory = () => {
    const fd = openSync(
      dirname(convertedBackupPath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const originalSeal = fileSeal(options.backupPath);
  const originalIdentitySeal = fileSeal(`${options.backupPath}.identity.json`);
  let captureSeal: string | undefined;
  let convertedSeal: string | undefined;
  let convertedIdentitySeal: string | undefined;
  let completionSeal: string | undefined;
  if (reopening) {
    captureSeal = fileSeal(capturePath);
    convertedSeal = fileSeal(convertedBackupPath);
    convertedIdentitySeal = fileSeal(identityPath);
    completionSeal = fileSeal(completionPath);
  }
  const sourceDirectory = options.sourceDirectory ?? resolve(REPOSITORY, "migrations");
  const files = readMigrationArtifact(sourceDirectory).files;
  assertMoneyCutoverSource(files);
  const sourceDigest = moneyUnitCutoverSourcePrefixDigest(files, 94);
  let configPath: string | undefined;
  let configBytes: string | undefined;
  const assertLocal = () => {
    assertProtectedDirectory(dirname(convertedBackupPath), "money converted94 backup");
    const currentParent = lstatSync(dirname(convertedBackupPath));
    if (
      `${currentParent.dev}:${currentParent.ino}:${currentParent.uid}:${currentParent.mode}` !==
        parentIdentity ||
      JSON.stringify(target) !== targetJson ||
      fileSeal(options.backupPath) !== originalSeal ||
      fileSeal(`${options.backupPath}.identity.json`) !== originalIdentitySeal ||
      (captureSeal !== undefined && fileSeal(capturePath) !== captureSeal) ||
      (convertedSeal !== undefined && fileSeal(convertedBackupPath) !== convertedSeal) ||
      (convertedIdentitySeal !== undefined && fileSeal(identityPath) !== convertedIdentitySeal) ||
      (completionSeal !== undefined && fileSeal(completionPath) !== completionSeal) ||
      (configPath !== undefined &&
        readProtectedBytes(configPath, "money capture config").toString("utf8") !== configBytes)
    )
      throw preflightError("money converted94 capture source or physical custody changed");
    const currentFiles = readMigrationArtifact(sourceDirectory).files;
    assertMoneyCutoverSource(currentFiles);
    if (moneyUnitCutoverSourcePrefixDigest(currentFiles, 94) !== sourceDigest)
      throw preflightError("money converted94 capture source94 changed");
  };
  assertLocal();
  const maintenance = structuredClone(await options.maintenanceProof());
  assertLocal();
  assertMaintenanceProof(target, maintenance, options.maintenanceCommit);
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    run,
  });
  assertLocal();
  const root = mkdtempSync(join(options.outputDirectory, "money-converted94-capture-"));
  let result: Omit<MoneyUnitConverted94BackupData, "completionDigest">;
  let completionBytes: Buffer;
  try {
    configPath = join(root, "wrangler.jsonc");
    configBytes = configJson(target);
    writeFileSync(configPath, configBytes, { flag: "wx", mode: 0o600 });
    const database = new RemoteD1(configPath, { environment: credential.childEnvironment, run });
    const originalQuery = database.query;
    // Every native query retains the exact same RemoteD1 receiver/method and
    // rechecks local selection/custody on both sides of its awaited operation.
    const nativeRead: Pick<RemoteD1, "query" | "column"> = Object.freeze({
      query: async (phase: DeployPhase, description: string, sql: string) => {
        assertLocal();
        if (database.query !== originalQuery)
          throw preflightError("money converted94 native reader was replaced");
        const rows = await originalQuery.call(database, phase, description, sql);
        assertLocal();
        if (database.query !== originalQuery)
          throw preflightError("money converted94 native reader was replaced");
        return rows;
      },
      column: async (phase: DeployPhase, description: string, sql: string, name: string) => {
        const rows = await nativeRead.query(phase, description, sql);
        return rows.map((row) => {
          if (typeof row[name] !== "string")
            throw preflightError("money converted94 schema column is malformed");
          return row[name] as string;
        });
      },
    });
    const origin = await options.stageOriginProof();
    assertLocal();
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
    assertLocal();
    const history = await readHeldMoneyConversionHistory(
      {
        target,
        options,
        files,
        database: nativeRead,
        readSchema: () => readD1SchemaState(nativeRead as unknown as RemoteD1),
        backup,
      },
      epoch,
      false,
    );
    assertLocal();
    if (history.writerDigest !== digest(JSON.stringify(maintenance)))
      throw preflightError("money converted94 maintenance differs from terminal convert Writer");
    const assertCurrent = async () => {
      assertLocal();
      await history.assertCurrent();
      assertLocal();
      await history.assertReview();
      assertLocal();
      const writer = await options.maintenanceProof();
      assertLocal();
      assertMaintenanceProof(target, writer, options.maintenanceCommit);
      if (JSON.stringify(writer) !== JSON.stringify(maintenance))
        throw preflightError("money converted94 maintenance changed");
      const schema = await readD1SchemaState(nativeRead as unknown as RemoteD1);
      if ((await exactStatus(nativeRead, schema, files, epoch)) !== "0094-fenced")
        throw preflightError("money converted94 requires native fenced94 and its original epoch");
      assertFreezeRow(
        await readFreezeRow(nativeRead, "preflight"),
        history.anchor,
        history.originDigest,
        backup.digest,
        history.writerDigest,
        "preflight",
      );
      if (
        (await readMoneyPreimageDigest(nativeRead, "preflight", true)) !== backup.preimageDigest ||
        (await readMoneyAggregateDigest(nativeRead, "preflight", true)) !== backup.aggregateDigest
      )
        throw preflightError("money converted94 conserved preimages differ");
      await assertClassificationsStored(nativeRead, history.classifications, "preflight");
      await assertMoneyNativeForeignKeys(nativeRead, "preflight");
      for (const phase of ["suffix98", "resume98"] as const) {
        if (
          (await options.custody.read(phase)) !== null ||
          (await options.custody.readDispatch(phase)) !== null
        )
          throw preflightError("money converted94 capture refuses a post94 dispatch");
        assertLocal();
      }
      if (
        history.convert.receipt.postDigest !==
        digest(
          JSON.stringify({
            applied: schema.applied,
            shapeDigest: schema.shapeDigest,
            preimageDigest: backup.preimageDigest,
            aggregateDigest: backup.aggregateDigest,
          }),
        )
      )
        throw preflightError("money converted94 schema differs from terminal convert postimage");
      assertLocal();
      return schema;
    };
    await assertCurrent();
    const tables = (
      await nativeRead.query(
        "preflight",
        "converted94 full table inventory",
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations') ORDER BY name",
      )
    ).map((row) => String(row.name));
    const rowCounts: Record<string, number> = {};
    for (const table of tables) {
      if (!/^[a-z_][a-z_0-9]*$/u.test(table))
        throw preflightError("money converted94 table name is malformed");
      rowCounts[table] = exactNumber(
        await nativeRead.query(
          "preflight",
          "converted94 exact row count",
          `SELECT COUNT(*) AS n FROM ${table}`,
        ),
        "n",
        "preflight",
      );
    }
    const before = {
      rowCounts,
      allDataDigest: await readWholeDatabaseDataDigest(nativeRead, "preflight", tables),
    };
    const capture = {
      kind: "takoserver.money-converted94-export-capture@v1",
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      databaseName: target.d1.databaseName,
      originDigest: history.originDigest,
      sourceDigest,
      convertBindingDigest: history.convert.receipt.bindingDigest,
      writerEpoch: epoch,
      convertedBackupPath,
    };
    const captureBytes = Buffer.from(`${JSON.stringify(capture)}\n`);
    await assertCurrent();
    if (reopening) {
      if (!readProtectedBytes(capturePath, "money converted94 capture").equals(captureBytes))
        throw preflightError("money converted94 capture command differs");
    } else {
      if ([capturePath, convertedBackupPath, identityPath, completionPath].some(present))
        throw preflightError("money converted94 capture appeared before its exclusive reservation");
      writeProtectedFile(capturePath, captureBytes);
      syncCaptureDirectory();
      captureSeal = fileSeal(capturePath);
    }
    assertLocal();
    let exported = false;
    const exportOnce: typeof run = async (command, environment) => {
      assertLocal();
      if (
        reopening ||
        exported ||
        present(convertedBackupPath) ||
        present(identityPath) ||
        present(completionPath)
      )
        throw preflightError("money converted94 export already started or custody changed");
      exported = true;
      const response = await run(command, environment);
      assertLocal();
      return response;
    };
    const converted = await backupAndRead(
      convertedBackupPath,
      configPath,
      target,
      files,
      history.originDigest,
      root,
      exportOnce,
      credential.childEnvironment,
      !reopening,
      {
        schemaPhase: "0094-fenced",
        convertBindingDigest: history.convert.receipt.bindingDigest,
        writerEpoch: epoch,
      },
    );
    syncCaptureDirectory();
    convertedSeal = fileSeal(convertedBackupPath);
    convertedIdentitySeal = fileSeal(identityPath);
    assertLocal();
    if (
      converted.preimageDigest !== backup.preimageDigest ||
      converted.aggregateDigest !== backup.aggregateDigest ||
      converted.schema === undefined ||
      converted.freezeRows === undefined
    )
      throw preflightError(
        "money converted94 exported snapshot differs from original financial data",
      );
    assertFreezeRow(
      converted.freezeRows,
      history.anchor,
      history.originDigest,
      backup.digest,
      history.writerDigest,
      "preflight",
    );
    await assertMoneyLiveBackupCompleteness(nativeRead, "preflight", before);
    await assertMoneyLiveBackupCompleteness(nativeRead, "preflight", converted);
    await assertCurrent();
    await assertMoneyLiveBackupCompleteness(nativeRead, "preflight", converted);
    assertLocal();
    result = {
      qualification: "component-simulation-only",
      schemaPhase: "0094-fenced",
      convertedBackupPath,
      backupDigest: converted.digest,
      identityDigest: digest(readProtectedBytes(identityPath, "money converted94 identity")),
      captureDigest: digest(captureBytes),
      convertBindingDigest: history.convert.receipt.bindingDigest,
      historicalWriterEpoch: epoch,
      sourceDigest,
      allDataDigest: converted.allDataDigest,
      tableInventory: Object.keys(converted.rowCounts).sort(),
      rowCounts: { ...converted.rowCounts },
    };
    completionBytes = Buffer.from(
      `${JSON.stringify({ kind: "takoserver.money-converted94-export-completion@v1", ...result })}\n`,
    );
    if (
      reopening &&
      !readProtectedBytes(completionPath, "money converted94 completion").equals(completionBytes)
    )
      throw preflightError("money converted94 completion differs from its retained exact snapshot");
  } finally {
    // Retain reservation/snapshot evidence on every failure; only this temporary
    // source-built config/raw-export workspace is removed. Never heal or retry.
    rmSync(root, { recursive: true, force: true });
    configPath = undefined;
  }
  assertLocal();
  if (!reopening) {
    writeProtectedFile(completionPath, completionBytes);
    syncCaptureDirectory();
    completionSeal = fileSeal(completionPath);
  }
  assertLocal();
  return freezeMoneyFact({ ...result, completionDigest: digest(completionBytes) });
}

/**
 * Reopens only the existing protected 92/94 snapshots and native GET/SELECT
 * state. The complete current census must still equal the sealed converted94
 * snapshot; any unrelated intervening write fails closed for this first route.
 * This lower reader remains unqualified until the original owner authenticates it.
 */
export async function readMoneyUnitHeldConvertFacts(input: {
  readonly target: DeployTarget;
  readonly options: MoneyUnitCutoverOptions;
  readonly previousWriterEpoch: string;
  readonly nextWriterEpoch: string;
  readonly convertedBackupPath: string;
}): Promise<MoneyUnitHeldConvertSourceFacts> {
  const { target, options, previousWriterEpoch, nextWriterEpoch, convertedBackupPath } = input;
  if (
    target.environment !== "integration" ||
    options.phase !== "convert" ||
    options.outputDirectory === undefined ||
    options.writerEpoch !== previousWriterEpoch ||
    target.moneyCutoverWriterEpoch !== previousWriterEpoch ||
    !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(nextWriterEpoch) ||
    previousWriterEpoch === nextWriterEpoch ||
    !isAbsolute(convertedBackupPath)
  )
    throw preflightError("money held convert requires exact old/new epochs and the convert owner");
  const files = readMigrationArtifact(
    options.sourceDirectory ?? resolve(REPOSITORY, "migrations"),
  ).files;
  assertMoneyPost94Source(files);
  const maintenance = structuredClone(await options.maintenanceProof());
  assertMaintenanceProof(target, maintenance, options.maintenanceCommit);
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    run,
  });
  assertProtectedDirectory(options.outputDirectory, "money held convert read output");
  const root = mkdtempSync(join(options.outputDirectory, "money-held-convert-read-"));
  const configPath = join(root, "wrangler.jsonc");
  writeFileSync(configPath, configJson(target), { flag: "wx", mode: 0o600 });
  const database = new RemoteD1(configPath, { environment: credential.childEnvironment, run });
  const origin = await options.stageOriginProof();
  const originalIdentityDigest = digest(
    readProtectedBytes(`${options.backupPath}.identity.json`, "money original backup identity"),
  );
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
  const details = await inspectMoneyUnitPost94Details(
    {
      target,
      options,
      files,
      database,
      readSchema: () => readD1SchemaState(database),
      backup,
      previousWriterEpoch,
      nextWriterEpoch,
      convertedBackupPath,
    },
    true,
  );
  if (
    details.state.schemaPhase !== "0094-fenced" ||
    details.state.continuation !== "blocked-financial-port"
  )
    throw preflightError("money held convert requires current fenced94 before suffix dispatch");
  await assertMoneyLiveBackupCompleteness(database, "preflight", details.converted);
  const currentSchema = await readD1SchemaState(database);
  if (
    JSON.stringify(currentSchema) !== JSON.stringify(details.schema) ||
    (await exactStatus(database, currentSchema, files, previousWriterEpoch, true)) !== "0094-fenced"
  )
    throw preflightError("money held convert current94 schema or old epoch changed");
  assertFreezeRow(
    await readFreezeRow(database, "preflight"),
    details.history.anchor,
    details.history.originDigest,
    backup.digest,
    details.history.writerDigest,
    "preflight",
  );
  for (const phase of ["suffix98", "resume98"] as const) {
    if (
      (await options.custody.read(phase)) !== null ||
      (await options.custody.readDispatch(phase)) !== null
    )
      throw preflightError("money held convert suffix dispatch appeared during observation");
  }
  await details.history.assertCurrent();
  const maintenanceAfter = await options.maintenanceProof();
  assertMaintenanceProof(target, maintenanceAfter, options.maintenanceCommit);
  if (
    JSON.stringify(maintenanceAfter) !== JSON.stringify(maintenance) ||
    digest(readProtectedBytes(options.backupPath, "money original backup")) !== backup.digest ||
    digest(
      readProtectedBytes(`${options.backupPath}.identity.json`, "money original backup identity"),
    ) !== originalIdentityDigest ||
    digest(readProtectedBytes(convertedBackupPath, "money converted backup")) !==
      details.converted.digest ||
    digest(
      readProtectedBytes(`${convertedBackupPath}.identity.json`, "money converted backup identity"),
    ) !== details.convertedIdentityDigest
  )
    throw preflightError("money held convert maintenance or original backup changed");
  const census = (value: typeof backup, identityDigest: string): MoneyHeldTableCensus => ({
    backupDigest: value.digest,
    identityDigest,
    allDataDigest: value.allDataDigest,
    tableInventory: Object.keys(value.rowCounts).sort(),
    rowCounts: { ...value.rowCounts },
    preimageDigest: value.preimageDigest,
    aggregateDigest: value.aggregateDigest,
    financialDigest: value.financialDigest,
  });
  return freezeMoneyFact(
    structuredClone({
      qualification: "component-simulation-only" as const,
      schemaPhase: "0094-fenced" as const,
      origin: details.history.origin,
      storage: details.history.identity,
      original92: { ...census(backup, originalIdentityDigest), sourceDigest: SOURCE_0092 },
      converted94: {
        ...census(details.converted, details.convertedIdentityDigest),
        sourceDigest: moneyUnitCutoverSourcePrefixDigest(files, 94),
      },
      current94: {
        schemaShapeDigest: currentSchema.shapeDigest,
        applied: [...currentSchema.applied],
        allDataDigest: details.converted.allDataDigest,
        tableInventory: Object.keys(details.converted.rowCounts).sort(),
        rowCounts: { ...details.converted.rowCounts },
        freezeBindingDigest: details.history.anchor,
        authorizedWriterEpoch: previousWriterEpoch,
      },
      conversion: {
        source94Digest: moneyUnitCutoverSourcePrefixDigest(files, 94),
        originDigest: details.history.originDigest,
        convertBindingDigest: details.history.convert.receipt.bindingDigest,
        convertPostDigest: details.history.convert.receipt.postDigest as string,
        convertImportDigest: details.history.convert.binding.importDigest,
        freezeBindingDigest: details.history.anchor,
        preimageDigest: backup.preimageDigest,
        aggregateDigest: backup.aggregateDigest,
        classificationDigest: details.history.convert.binding.classificationDigest,
        classifications: details.history.classifications.map((row) => ({ ...row })),
        writerDigest: details.history.writerDigest,
        retained: details.history.retained.map(({ phase, receipt, binding }) => ({
          phase,
          bindingDigest: receipt.bindingDigest,
          receiptDigest: digest(JSON.stringify(receipt)),
          importDigest: binding.importDigest,
          sourceDigest: binding.sourceDigest,
        })),
      },
      maintenance,
      previousWriterEpoch,
      nextWriterEpoch,
    }),
  );
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
  return readMoneyNativeTypedCensusDigest(database, phase, tables);
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
  // Keep every typed row/FK/currentness proof below. Only group the COUNT
  // statements into bounded fresh SELECTs; never infer bytes from a zero count.
  const countReads: { readonly tables: readonly string[]; readonly sql: string }[] = [];
  const countSql = (selected: readonly string[]) =>
    `SELECT table_name, n FROM (${moneyProofUnionSql(
      selected.map(
        (table) => `SELECT ${sqlLiteral(table)} AS table_name, COUNT(*) AS n FROM ${table}`,
      ),
    )}) ORDER BY table_name`;
  let selected: string[] = [];
  for (const table of tables) {
    if (!/^[a-z_][a-z_0-9]*$/u.test(table))
      throw proofError(phase, "money live table name is malformed");
    const next = [...selected, table];
    const query = countSql(next);
    // Zero bind parameters. At most 128 leaves of the existing balanced
    // two-term UNION and 90,000 UTF8 bytes, below the native SQL-size budget.
    if (selected.length !== 0 && (next.length > 128 || Buffer.byteLength(query, "utf8") > 90_000)) {
      countReads.push({ tables: selected, sql: countSql(selected) });
      selected = [table];
      if (Buffer.byteLength(countSql(selected), "utf8") > 90_000)
        throw proofError(phase, "money live table count exceeds the bounded SQL size");
    } else {
      if (Buffer.byteLength(query, "utf8") > 90_000)
        throw proofError(phase, "money live table count exceeds the bounded SQL size");
      selected = next;
    }
  }
  if (selected.length !== 0) countReads.push({ tables: selected, sql: countSql(selected) });
  for (const read of countReads) {
    const rows = await database.query(phase, "native complete table row counts", read.sql);
    if (rows.length !== read.tables.length)
      throw proofError(phase, "money live table counts are incomplete or duplicated");
    for (const [index, table] of read.tables.entries()) {
      const row = rows[index];
      if (
        !record(row) ||
        Object.keys(row).sort().join(",") !== "n,table_name" ||
        row.table_name !== table ||
        !Number.isSafeInteger(row.n) ||
        (row.n as number) < 0
      )
        throw proofError(phase, "money live table counts are malformed or out of order");
      if (row.n !== backup.rowCounts[table])
        throw proofError(phase, `money backup and live D1 ${table} row counts differ`);
    }
  }
  if ((await readWholeDatabaseDataDigest(database, phase, tables)) !== backup.allDataDigest) {
    throw proofError(phase, "money backup and live D1 complete typed row bytes differ");
  }
  await assertMoneyNativeForeignKeys(database, phase);
}

function validateReview(
  binding: MoneyReviewBinding | MoneyPost94ImportReviewBinding | MoneyPreserved100ReviewBinding,
  proof: MoneyReviewProof,
): string {
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
  phase: MoneyCustodyPhase,
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
  retainedFiles: readonly string[] = [],
): Promise<void> {
  const sealed = sealDirectory(dirname(file), ["wrangler.jsonc", "import.sql", ...retainedFiles]);
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

function moneyPost94ReadCompiler(files: readonly MigrationFile[]): Database {
  assertMoneyPost94Source(files);
  const database = new Database(":memory:");
  try {
    executeMoneyHostSql(
      database,
      buildD1MigrationImport(files.slice(0, 94), { freshLedger: true }).sql,
    );
    executeMoneyHostSql(
      database,
      `${FENCE_DDL};\n${MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL};\n${MONEY_CUTOVER_PERMIT_DDL};\n${MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL};\n${moneyFenceInstallSql("0094-fenced")}`,
    );
    executeMoneyHostSql(
      database,
      buildD1MigrationImport(files.slice(94, 98), { freshLedger: false }).sql,
    );
    for (const [name, definition] of moneyPost94GuardDefinitions()) {
      const existing = database.query("SELECT sql FROM sqlite_schema WHERE name=?").get(name) as {
        sql: string;
      } | null;
      if (existing === null) executeMoneyHostSql(database, `${definition};`);
      else if (existing.sql !== definition)
        throw preflightError("money post94 verification guard source differs");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Historical original-key GET/SELECT only. This never recreates held94/mode or
 * Financial pre-import artifacts after dispatch and NEVER settles or resends it.
 */
export async function readIntegrationMoneyPost94CustodyStatus(
  invocation: MoneyUnitCutoverInvocation,
  target: DeployTarget,
  options: MoneyUnitOriginalCutoverOptions,
  post94DeclarationPath: string,
): Promise<Record<string, unknown>> {
  if (
    invocation.action !== "status" ||
    invocation.environment !== "integration" ||
    invocation.throughMigration !== "0098"
  )
    throw preflightError("money post94 custody observation is integration status only");
  const owner = await import("./schema-money-unit-owner.ts");
  target = owner.assertMoneyUnitOriginalWriterOptions(options, target);
  const receipt = await options.custody.read("suffix98"),
    binding = await options.custody.readDispatch("suffix98");
  if (
    !receipt ||
    !binding ||
    binding.kind !== "takoserver.money-cutover-dispatch@v2" ||
    typeof binding.signingGenesisPath !== "string" ||
    !SHA256.test(binding.signingGenesisDigest ?? "") ||
    typeof binding.financialContributionPath !== "string" ||
    !SHA256.test(binding.financialContributionDigest ?? "") ||
    !SHA256.test(binding.financialSourceBindingDigest ?? "")
  )
    throw preflightError("money post94 status requires the original complete dispatch pair");
  assertExistingCustodyShape(receipt, "suffix98");
  owner.assertMoneyUnitOriginalPost94DispatchData(options, post94DeclarationPath, binding);
  if (
    digest(
      readProtectedBytes(binding.signingGenesisPath, "money retained original signing genesis"),
    ) !== binding.signingGenesisDigest ||
    dirname(binding.signingGenesisPath) !== dirname(binding.sealedImportPath) ||
    digest(
      readProtectedBytes(
        join(dirname(binding.sealedImportPath), "independent-review.json"),
        "money retained original review",
      ),
    ) !== binding.reviewDigest ||
    receipt.bindingDigest !== moneyCutoverBindingDigest(binding) ||
    binding.sourceDigest !== SOURCE_0098 ||
    options.outputDirectory === undefined ||
    dirname(binding.financialContributionPath) !== dirname(binding.sealedImportPath) ||
    !relative(options.outputDirectory, binding.sealedImportPath).startsWith("money-suffix98-") ||
    !binding.sealedImportPath.endsWith("/import.sql") ||
    digest(readProtectedBytes(binding.sealedImportPath, "money retained suffix SQL")) !==
      binding.importDigest ||
    digest(
      readProtectedBytes(
        binding.financialContributionPath,
        "money retained original Financial DATA",
      ),
    ) !== binding.financialContributionDigest
  )
    throw preflightError("money post94 status retained dispatch/source/Financial DATA differs");
  const files = readMigrationArtifact(
    options.sourceDirectory ?? resolve(REPOSITORY, "migrations"),
  ).files;
  assertMoneyPost94Source(files);
  const run = options.run ?? runCommand,
    credential = await resolveCloudflareCredential("integration", {
      ...(options.cloudflareEnvironment === undefined
        ? {}
        : { cloudflareEnvironment: options.cloudflareEnvironment }),
      run,
    });
  owner.assertMoneyUnitOriginalWriterOptions(options, target);
  assertProtectedDirectory(options.outputDirectory, "money post94 status output");
  const root = mkdtempSync(join(options.outputDirectory, "money-post94-status-"));
  const compiler = moneyPost94ReadCompiler(files);
  try {
    const configPath = join(root, "wrangler.jsonc");
    writeProtectedFile(configPath, Buffer.from(configJson(target)));
    const database = new RemoteD1(configPath, { environment: credential.childEnvironment, run });
    const origin = await options.stageOriginProof(),
      identity = await options.storageIdentityRead();
    assertStageTarget(target, origin, identity, true);
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
    const history = await readHeldMoneyConversionHistory(
      { target, options, files, database, readSchema: () => readD1SchemaState(database), backup },
      binding.previousWriterEpoch,
      false,
    );
    if (
      binding.originDigest !== history.originDigest ||
      binding.predecessorCustodyDigest !== digest(JSON.stringify(history.convert.receipt)) ||
      binding.convertBindingDigest !== history.convert.receipt.bindingDigest ||
      binding.backupDigest !== backup.digest ||
      binding.original92BackupDigest !== backup.digest ||
      binding.preimageDigest !== backup.preimageDigest ||
      binding.aggregateDigest !== backup.aggregateDigest ||
      binding.writerDigest !== history.writerDigest ||
      binding.classificationDigest !== options.classificationManifestDigest
    )
      throw verificationError(
        "money retained post94 dispatch differs from actual original history",
      );
    const schema = await readD1SchemaState(database);
    const epochRows = await database.query(
      "verification",
      "retained post94 current authorized epoch",
      `SELECT singleton, writer_epoch FROM ${MONEY_CUTOVER_AUTHORIZED_EPOCH_TABLE}`,
    );
    if (
      epochRows.length !== 1 ||
      epochRows[0]?.singleton !== 1 ||
      ![binding.previousWriterEpoch, binding.nextWriterEpoch].includes(
        String(epochRows[0]?.writer_epoch),
      )
    )
      throw verificationError(
        "money retained post94 current epoch is neither original nor selected next",
      );
    const epoch = String(epochRows[0]?.writer_epoch);
    const schemaPhase = moneyUnitCutoverSchemaMatches(schema, files, "0094-fenced")
      ? "0094-fenced"
      : moneyUnitCutoverSchemaMatches(schema, files, "0098-fenced")
        ? "0098-fenced"
        : null;
    if (
      schemaPhase === null ||
      (schemaPhase === "0094-fenced"
        ? epoch !== binding.previousWriterEpoch
        : epoch !== binding.nextWriterEpoch)
    )
      throw verificationError("money retained post94 schema and epoch are partial or divergent");
    await assertPermitEmpty(database, "verification", epoch);
    assertFreezeRow(
      await readFreezeRow(database, "verification"),
      history.anchor,
      history.originDigest,
      backup.digest,
      history.writerDigest,
      "verification",
    );
    if (schemaPhase === "0098-fenced") {
      await assertStripeModeRealm(readonlyMoneySql(database, compiler, "verification"), "test");
      const signing: unknown = JSON.parse(
        readProtectedBytes(
          binding.signingGenesisPath,
          "money retained original signing genesis",
        ).toString("utf8"),
      );
      if (
        !record(signing) ||
        signing.kind !== "takoserver.money-normal-signing-genesis-contribution@v1" ||
        signing.normalModeBindingDigest !== binding.modePreparationDigest ||
        signing.convertBindingDigest !== binding.convertBindingDigest ||
        signing.original92BackupDigest !== binding.original92BackupDigest ||
        signing.converted94BackupDigest !== binding.converted94BackupDigest
      )
        throw verificationError(
          "money retained signing genesis differs from original phase binding",
        );
      await assertMoneySigningGenesisPostimage(
        database,
        signing as unknown as MoneyNormalWorkerSigningGenesisContribution,
        "verification",
      );
    }
    await assertMoneyNativeForeignKeys(database, "verification");
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    owner.assertMoneyUnitOriginalPost94DispatchData(options, post94DeclarationPath, binding);
    await history.assertReview();
    await history.assertCurrent();
    if (
      digest(
        readProtectedBytes(binding.signingGenesisPath, "money retained original signing genesis"),
      ) !== binding.signingGenesisDigest
    )
      throw verificationError("money retained signing genesis changed during GET");
    if (
      JSON.stringify(await options.custody.read("suffix98")) !== JSON.stringify(receipt) ||
      JSON.stringify(await options.custody.readDispatch("suffix98")) !== JSON.stringify(binding)
    )
      throw verificationError("money retained post94 custody changed during GET observation");
    return {
      kind: "takoserver.money-post94-custody-observation@v1",
      phase: "suffix98",
      custody: receipt.state,
      schemaPhase,
      schemaShapeDigest: schema.shapeDigest,
      currentWriterEpoch: epoch,
      freezeBindingDigest: history.anchor,
      originDigest: history.originDigest,
      readOnly: true,
      canResend: false,
      terminalRecovery: "not-attempted",
      preImportAssertionsReused: false,
      normalHostReady: false,
    };
  } finally {
    compiler.close();
    rmSync(root, { recursive: true, force: true });
  }
}

interface MoneyOriginalPreservedSourceFacts {
  readonly qualification: "native-read-only";
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
  readonly workerName: string;
  readonly originDigest: string;
  readonly original92BackupDigest: string;
  readonly suffixBindingDigest: string;
  readonly freezeBindingDigest: string;
  readonly freezeWriterDigest: string;
  readonly freezeSourceDigest: typeof SOURCE_0092;
  readonly currentWriterEpoch: string;
  readonly schemaShapeDigest: string;
  readonly normalVersionId: string;
  readonly normalHostReady: false;
}

export interface MoneyOriginalPreserved100Source extends MoneyOriginalPreservedSourceFacts {
  readonly kind: "takoserver.money-original-preserved100-source@v1";
}

interface MoneyOriginalPreserved103Observed extends MoneyOriginalPreservedSourceFacts {
  readonly kind: "takoserver.money-original-preserved103-precursor@v1";
}

export interface MoneyOriginalPreserved103Precursor extends MoneyOriginalPreserved103Observed {
  readonly authTarget: DeployTarget;
}

/**
 * Source-owned original98→100 bridge for Auth103's distinct native importer.
 * Reads the actual original Money custody, retained SQL/Financial/signing bytes,
 * the complete original100 D1 shape and its still-frozen new epoch. It neither
 * reopens held94 nor grants traffic or an Auth103 import on its own.
 */
async function readIntegrationMoneyOriginalPreservedSource(
  target: DeployTarget,
  options: MoneyUnitOriginalCutoverOptions,
  post94DeclarationPath: string,
  through: 100 | 103,
  custodyState: "terminal" | "dispatched" = "terminal",
): Promise<MoneyOriginalPreserved100Source | MoneyOriginalPreserved103Observed> {
  const owner = await import("./schema-money-unit-owner.ts");
  target = owner.assertMoneyUnitOriginalWriterOptions(options, target);
  if (options.phase !== "convert" || options.outputDirectory === undefined)
    throw preflightError("money original100 source requires its original convert owner");
  const receipt = await options.custody.read("suffix98"),
    binding = await options.custody.readDispatch("suffix98");
  if (
    receipt?.state !== "terminal" ||
    binding?.kind !== "takoserver.money-cutover-dispatch@v2" ||
    binding.phase !== "suffix98" ||
    binding.afterSchemaPhase !== "0098-fenced" ||
    !SHA256.test(binding.financialContributionDigest ?? "") ||
    !SHA256.test(binding.signingGenesisDigest ?? "") ||
    typeof binding.financialContributionPath !== "string" ||
    typeof binding.signingGenesisPath !== "string" ||
    receipt.bindingDigest !== moneyCutoverBindingDigest(binding) ||
    (await options.custody.read("resume98")) !== null ||
    (await options.custody.readDispatch("resume98")) !== null
  )
    throw preflightError("money original100 source requires terminal suffix and no thaw dispatch");
  const preservedReceipt = await options.custody.read("preserved100"),
    preservedBinding = await options.custody.readDispatch("preserved100");
  if (
    preservedReceipt?.state !== custodyState ||
    preservedBinding?.kind !== "takoserver.money-cutover-dispatch@v3" ||
    preservedBinding.phase !== "preserved100" ||
    preservedBinding.afterSchemaPhase !== "0100-fenced" ||
    preservedReceipt.bindingDigest !== moneyCutoverBindingDigest(preservedBinding) ||
    preservedBinding.suffixBindingDigest !== receipt.bindingDigest ||
    preservedBinding.suffixPostDigest !== receipt.postDigest ||
    preservedBinding.predecessorCustodyDigest !== digest(JSON.stringify(receipt)) ||
    preservedBinding.nextWriterEpoch !== binding.nextWriterEpoch
  )
    throw preflightError("money original100 requires its distinct exact native99–100 custody");
  owner.assertMoneyUnitOriginalPost94DispatchData(options, post94DeclarationPath, binding);
  if (
    dirname(binding.sealedImportPath) !== dirname(binding.financialContributionPath) ||
    dirname(binding.sealedImportPath) !== dirname(binding.signingGenesisPath) ||
    !relative(options.outputDirectory, binding.sealedImportPath).startsWith("money-suffix98-") ||
    digest(readProtectedBytes(binding.sealedImportPath, "money original suffix SQL")) !==
      binding.importDigest ||
    digest(
      readProtectedBytes(binding.financialContributionPath, "money original Financial DATA"),
    ) !== binding.financialContributionDigest ||
    digest(readProtectedBytes(binding.signingGenesisPath, "money original signing DATA")) !==
      binding.signingGenesisDigest
  )
    throw preflightError("money original100 retained suffix artifacts changed");
  const sourceDirectory = options.sourceDirectory ?? resolve(REPOSITORY, "migrations");
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    run,
  });
  assertProtectedDirectory(options.outputDirectory, "money original100 read output");
  const root = mkdtempSync(join(options.outputDirectory, `money-original${through}-read-`));
  let selectedSource: ReturnType<typeof readMoneyOriginalPreservedSourceInventory> | undefined;
  let compiler: ReturnType<typeof moneyPost94ReadCompiler> | undefined;
  try {
    selectedSource = readMoneyOriginalPreservedSourceInventory(sourceDirectory, through, root);
    const files = selectedSource.files;
    if (
      preservedBinding.sourceDigest !== selectedSource.sourceDigest ||
      preservedBinding.expectedAfterShapeDigest !==
        digest(moneyPost100ExpectedPreservedShape(files.slice(0, 100))) ||
      !relative(options.outputDirectory, preservedBinding.sealedImportPath).startsWith(
        "money-preserved100-",
      ) ||
      preservedBinding.importDigest !==
        digest(
          readProtectedBytes(preservedBinding.sealedImportPath, "money preserved100 sealed SQL"),
        )
    )
      throw preflightError("money original100 native source or sealed import changed");
    const expectedShape =
      through === 100
        ? moneyPost100ExpectedPreservedShape(files)
        : moneyPost103ExpectedPreservedShape(files);
    compiler = moneyPost94ReadCompiler(files);
    const configPath = join(root, "wrangler.jsonc");
    writeProtectedFile(configPath, Buffer.from(configJson(target)));
    const database = new RemoteD1(configPath, { environment: credential.childEnvironment, run });
    const origin = await options.stageOriginProof(),
      identity = await options.storageIdentityRead();
    assertStageTarget(target, origin, identity, true);
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
    const history = await readHeldMoneyConversionHistory(
      { target, options, files, database, readSchema: () => readD1SchemaState(database), backup },
      binding.previousWriterEpoch,
      false,
    );
    if (
      binding.originDigest !== history.originDigest ||
      binding.predecessorCustodyDigest !== digest(JSON.stringify(history.convert.receipt)) ||
      binding.convertBindingDigest !== history.convert.receipt.bindingDigest ||
      binding.backupDigest !== backup.digest ||
      binding.original92BackupDigest !== backup.digest ||
      binding.preimageDigest !== backup.preimageDigest ||
      binding.aggregateDigest !== backup.aggregateDigest ||
      binding.writerDigest !== history.writerDigest ||
      binding.classificationDigest !== options.classificationManifestDigest ||
      binding.sourceDigest !== SOURCE_0098 ||
      binding.selectedStripeMode !== "test"
    )
      throw preflightError("money original100 suffix differs from original Money history");
    if (
      preservedBinding.accountId !== target.accountId ||
      preservedBinding.databaseId !== target.d1.databaseId ||
      preservedBinding.databaseName !== target.d1.databaseName ||
      preservedBinding.originDigest !== history.originDigest ||
      preservedBinding.backupDigest !== backup.digest ||
      preservedBinding.writerDigest !== history.writerDigest ||
      preservedBinding.preimageDigest !== backup.preimageDigest ||
      preservedBinding.aggregateDigest !== backup.aggregateDigest ||
      preservedBinding.classificationDigest !== binding.classificationDigest ||
      preservedBinding.writerEpoch !== binding.nextWriterEpoch ||
      preservedBinding.suffixReviewDigest !== binding.reviewDigest
    )
      throw preflightError("money original100 terminal differs from original suffix history");
    const schema = await readD1SchemaState(database);
    if (
      schema.applied.length !== through ||
      schema.applied.some((name, index) => name !== files[index]?.name) ||
      !applicationSchemaMatches(schema, expectedShape)
    )
      throw preflightError("money original source requires exact preserved schema and ledger");
    await assertPermitEmpty(database, "preflight", binding.nextWriterEpoch);
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
      throw preflightError("money original100 financial preimages changed while frozen");
    await assertClassificationsStored(database, history.classifications, "preflight");
    await assertMoneyNativeForeignKeys(database, "preflight");
    await assertStripeModeRealm(readonlyMoneySql(database, compiler, "preflight"), "test");
    const signing: unknown = JSON.parse(
      readProtectedBytes(binding.signingGenesisPath, "money original signing DATA").toString(
        "utf8",
      ),
    );
    if (
      !record(signing) ||
      signing.kind !== "takoserver.money-normal-signing-genesis-contribution@v1" ||
      signing.normalModeBindingDigest !== binding.modePreparationDigest ||
      signing.convertBindingDigest !== binding.convertBindingDigest ||
      signing.original92BackupDigest !== binding.original92BackupDigest ||
      signing.converted94BackupDigest !== binding.converted94BackupDigest ||
      typeof signing.versionId !== "string" ||
      !UUID.test(signing.versionId)
    )
      throw preflightError("money original100 signing genesis differs from original suffix");
    await assertMoneySigningGenesisPostimage(
      database,
      signing as unknown as MoneyNormalWorkerSigningGenesisContribution,
      "preflight",
    );
    const expectedImport = buildMoneyOriginalPreserved100ImportData({
      sourceDirectory,
      scratchBase: root,
      freezeBindingDigest: history.anchor,
      originDigest: history.originDigest,
      original92BackupDigest: backup.digest,
      writerDigest: history.writerDigest,
      nextWriterEpoch: binding.nextWriterEpoch,
      signingKeyId: String(signing.keyId),
      signingPublicJwk: String(signing.publicJwk),
      signingCreatedAtEpochSeconds: Number(signing.createdAtEpochSeconds),
    });
    if (
      preservedBinding.sourceDigest !== expectedImport.sourceDigest ||
      preservedBinding.importDigest !== expectedImport.importDigest ||
      readProtectedBytes(
        preservedBinding.sealedImportPath,
        "money preserved100 sealed SQL",
      ).toString("utf8") !== expectedImport.sql
    )
      throw preflightError("money preserved100 retained import differs from owned99–100 source");
    const reviewBinding = moneyPreserved100ReviewBinding({
      commit: preservedBinding.sourceCommit,
      target,
      suffix: binding,
      suffixReceipt: receipt,
      freezeBindingDigest: history.anchor,
      beforeShapeDigest: preservedBinding.beforeShapeDigest,
      prepared: expectedImport,
    });
    const review = owner.readMoneyUnitOriginalPreserved100IndependentReview(options, reviewBinding);
    if (
      review === null ||
      validateReview(reviewBinding, review) !== preservedBinding.reviewDigest ||
      digest(
        readProtectedBytes(
          join(dirname(preservedBinding.sealedImportPath), "independent-review.json"),
          "money preserved100 sealed review",
        ),
      ) !== preservedBinding.reviewDigest
    )
      throw preflightError("money preserved100 exact independent review changed");
    if (
      custodyState === "terminal" &&
      through === 100 &&
      preservedReceipt.postDigest !==
        digest(
          JSON.stringify({
            applied: expectedImport.names,
            shapeDigest: schema.shapeDigest,
            writerEpoch: binding.nextWriterEpoch,
            suffixBindingDigest: receipt.bindingDigest,
            sourceDigest: expectedImport.sourceDigest,
            importDigest: expectedImport.importDigest,
          }),
        )
    )
      throw preflightError("money preserved100 terminal receipt differs from exact native100");
    await history.assertReview();
    await history.assertCurrent();
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    owner.assertMoneyUnitOriginalPost94DispatchData(options, post94DeclarationPath, binding);
    selectedSource.assertCurrent();
    if (
      JSON.stringify(await readD1SchemaState(database)) !== JSON.stringify(schema) ||
      JSON.stringify(await options.custody.read("suffix98")) !== JSON.stringify(receipt) ||
      JSON.stringify(await options.custody.readDispatch("suffix98")) !== JSON.stringify(binding) ||
      JSON.stringify(await options.custody.read("preserved100")) !==
        JSON.stringify(preservedReceipt) ||
      JSON.stringify(await options.custody.readDispatch("preserved100")) !==
        JSON.stringify(preservedBinding) ||
      (await options.custody.read("resume98")) !== null ||
      (await options.custody.readDispatch("resume98")) !== null
    )
      throw preflightError("money original100 schema or custody changed during observation");
    selectedSource.assertCurrent();
    const facts: MoneyOriginalPreservedSourceFacts = Object.freeze({
      qualification: "native-read-only",
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      databaseName: target.d1.databaseName,
      workerName: target.workerName,
      originDigest: history.originDigest,
      original92BackupDigest: backup.digest,
      suffixBindingDigest: receipt.bindingDigest,
      freezeBindingDigest: history.anchor,
      freezeWriterDigest: history.writerDigest,
      freezeSourceDigest: SOURCE_0092,
      currentWriterEpoch: binding.nextWriterEpoch,
      schemaShapeDigest: schema.shapeDigest,
      normalVersionId: signing.versionId,
      normalHostReady: false,
    });
    return through === 100
      ? Object.freeze({ ...facts, kind: "takoserver.money-original-preserved100-source@v1" })
      : Object.freeze({ ...facts, kind: "takoserver.money-original-preserved103-precursor@v1" });
  } finally {
    try {
      compiler?.close();
    } finally {
      try {
        selectedSource?.dispose();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
}

export async function readIntegrationMoneyOriginalPreserved100Source(
  target: DeployTarget,
  options: MoneyUnitOriginalCutoverOptions,
  post94DeclarationPath: string,
): Promise<MoneyOriginalPreserved100Source> {
  const result = await readIntegrationMoneyOriginalPreservedSource(
    target,
    options,
    post94DeclarationPath,
    100,
  );
  if (result.kind !== "takoserver.money-original-preserved100-source@v1")
    throw preflightError("money original100 reader returned a divergent phase");
  return result;
}

/**
 * Noncircular Money-owned proof for Auth103's original union importer. This
 * proves the retained Money source and physical/profile transition without
 * consulting Auth103 history or accepting a caller's readiness assertion.
 */
export async function readIntegrationMoneyOriginalPreserved103Precursor(
  moneyTarget: DeployTarget,
  options: MoneyUnitOriginalCutoverOptions,
  post94DeclarationPath: string,
  auth103OriginalTarget: DeployTarget,
): Promise<MoneyOriginalPreserved103Precursor> {
  const owner = await import("./schema-money-unit-owner.ts");
  const money = await readIntegrationMoneyOriginalPreservedSource(
    moneyTarget,
    options,
    post94DeclarationPath,
    103,
  );
  if (money.kind !== "takoserver.money-original-preserved103-precursor@v1")
    throw preflightError("money original103 precursor returned a divergent phase");
  const authTarget = owner.assertMoneyUnitOriginalPost103TargetProfile(
    options,
    moneyTarget,
    auth103OriginalTarget,
    money.currentWriterEpoch,
  );
  return Object.freeze({ ...money, authTarget });
}

export interface MoneyOriginalPreserved103Source extends MoneyOriginalPreservedSourceFacts {
  readonly kind: "takoserver.money-original-preserved103-source@v1";
  readonly authTarget: DeployTarget;
  readonly auth103SourceRef: string;
  readonly auth103DeploymentId: string;
  readonly auth103VersionId: string;
}

/** Read-only original 103+Money union; Auth103 owns its native history proof. */
export async function readIntegrationMoneyOriginalPreserved103Source(
  moneyTarget: DeployTarget,
  options: MoneyUnitOriginalCutoverOptions,
  post94DeclarationPath: string,
  auth103OriginalTarget: DeployTarget,
  auth103Commit: string,
): Promise<MoneyOriginalPreserved103Source> {
  if (!COMMIT.test(auth103Commit))
    throw preflightError("money original103 requires the exact original Auth103 commit");
  const money = await readIntegrationMoneyOriginalPreserved103Precursor(
    moneyTarget,
    options,
    post94DeclarationPath,
    auth103OriginalTarget,
  );
  const authOwner = await import("./schema-auth103-native-source.ts");
  const auth = await authOwner.readD1SchemaAuth103OriginalHistory(
    { commit: auth103Commit },
    money.authTarget,
    moneyTarget.d1,
  );
  if (
    auth.environment !== "integration" ||
    auth.accountId !== moneyTarget.accountId ||
    auth.databaseId !== moneyTarget.d1.databaseId ||
    auth.databaseName !== moneyTarget.d1.databaseName ||
    auth.workerName !== moneyTarget.workerName ||
    auth.commit !== auth103Commit ||
    !UUID.test(auth.originalVersionId) ||
    !UUID.test(auth.originalDeploymentId)
  )
    throw preflightError("money original103 Auth history differs from the same physical Host");
  const authAfter = await authOwner.readD1SchemaAuth103OriginalHistory(
    { commit: auth103Commit },
    money.authTarget,
    moneyTarget.d1,
  );
  if (JSON.stringify(authAfter) !== JSON.stringify(auth))
    throw preflightError("money original103 Auth history changed during observation");
  return Object.freeze({
    ...money,
    kind: "takoserver.money-original-preserved103-source@v1",
    auth103SourceRef: auth.sourceRef,
    auth103DeploymentId: auth.originalDeploymentId,
    auth103VersionId: auth.originalVersionId,
  });
}

/** Sole sealed fixed95–98 import, reached ONLY through both real original producers. */
export async function runIntegrationMoneyHeldSuffix98(
  invocation: MoneyUnitCutoverInvocation,
  target: DeployTarget,
  options: MoneyUnitOriginalCutoverOptions,
  inputs: MoneyUnitHeldPost94ConsumerInputs,
  normalUploadReceipt: unknown,
): Promise<Record<string, unknown>> {
  if (
    invocation.environment !== "integration" ||
    invocation.throughMigration !== "0098" ||
    !COMMIT.test(invocation.commit) ||
    !["status", "apply"].includes(invocation.action)
  )
    throw preflightError("money suffix requires an exact integration0098 invocation");
  const owner = await import("./schema-money-unit-owner.ts");
  target = owner.assertMoneyUnitOriginalWriterOptions(options, target);
  if (
    options.phase !== "convert" ||
    options.outputDirectory === undefined ||
    (options.sourceDirectory !== undefined &&
      resolve(options.sourceDirectory) !== resolve(REPOSITORY, "migrations"))
  )
    throw preflightError(
      "money suffix requires the same original native convert owner and reviewed source",
    );
  if (
    (await options.custody.read("suffix98")) !== null ||
    (await options.custody.readDispatch("suffix98")) !== null
  )
    throw mutationError(
      "money suffix already has original custody; no resend, new key or pre-import recovery",
    );
  await owner.assertMoneyUnitHeldPost94ConsumerInputsOrigin(options, inputs);
  if (inputs.selection.phase !== "suffix98")
    throw preflightError("money suffix cannot use a resume selection");
  const financialOwner = await import("./stripe-mode-realm.ts");
  const financial: MoneyRealmPinContribution =
    await financialOwner.readMoneyD1StripeRealmPinContribution(
      inputs.context,
      inputs.normalWorkerModePreparation,
    );
  await owner.assertMoneyUnitHeldPost94ConsumerInputsOrigin(options, inputs);
  await financialOwner.assertMoneyD1StripeRealmPinContributionCurrent(
    financial,
    inputs.context,
    inputs.normalWorkerModePreparation,
  );
  const signingOwner = await import("./money-normal-worker-version-upload.ts");
  const signing = await signingOwner.readMoneyNormalWorkerSigningGenesisContribution(
    inputs.context,
    inputs.normalWorkerModePreparation,
    normalUploadReceipt,
  );
  await owner.assertMoneyUnitHeldPost94ConsumerInputsOrigin(options, inputs);
  await signingOwner.assertMoneyNormalWorkerSigningGenesisContributionCurrent(
    signing,
    inputs.context,
    inputs.normalWorkerModePreparation,
  );
  const signingBytes = Buffer.from(`${JSON.stringify(signing)}\n`),
    signingGenesisDigest = digest(signingBytes);
  const facts = inputs.context.facts,
    selection = inputs.selection,
    mode = inputs.normalWorkerModePreparation;
  if (
    financial.modePreparationDigest !== mode.bindingDigest ||
    financial.writerEpochBeforeRotation !== facts.previousWriterEpoch ||
    financial.placement !== "same-sealed-one-after-0098-schema-before-epoch-rotation"
  )
    throw preflightError(
      "money suffix Financial original does not bind the same held mode/old epoch/placement",
    );
  const factsJson = JSON.stringify(facts),
    financialBytes = Buffer.from(`${JSON.stringify(financial)}\n`),
    financialContributionDigest = digest(financialBytes);
  const files = readMigrationArtifact(
    options.sourceDirectory ?? resolve(REPOSITORY, "migrations"),
  ).files;
  assertMoneyPost94Source(files);
  const convertedBytes = readProtectedBytes(
    owner.readMoneyUnitHeldPost94ConvertedBackupPath(options, inputs),
    "money original converted94 snapshot",
  );
  if (digest(convertedBytes) !== facts.converted94.backupDigest)
    throw preflightError("money suffix retained94 bytes differ from original held context");
  const one = await buildMoneyPost94OneImportData({
    root: {
      files,
      freezeBindingDigest: facts.conversion.freezeBindingDigest,
      originDigest: facts.conversion.originDigest,
      original92BackupDigest: facts.original92.backupDigest,
      writerDigest: facts.conversion.writerDigest,
      previousWriterEpoch: facts.previousWriterEpoch,
      nextWriterEpoch: facts.nextWriterEpoch,
    },
    financialStatements: financial.statements,
    signingGenesis: {
      keyId: signing.keyId,
      publicJwk: signing.publicJwk,
      createdAtEpochSeconds: signing.createdAtEpochSeconds,
      previousWriterEpoch: facts.previousWriterEpoch,
    },
    convertedSnapshot: convertedBytes.toString("utf8"),
  });
  await owner.assertMoneyUnitHeldPost94ConsumerInputsOrigin(options, inputs);
  await financialOwner.assertMoneyD1StripeRealmPinContributionCurrent(
    financial,
    inputs.context,
    mode,
  );
  const convert = await options.custody.read("convert");
  if (
    convert?.state !== "terminal" ||
    convert.bindingDigest !== facts.conversion.convertBindingDigest
  )
    throw preflightError("money suffix requires the unchanged original terminal convert");
  const reviewBinding: MoneyPost94ImportReviewBinding = {
    kind: "takoserver.money-post94-import-review@v1",
    phase: "suffix98",
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    databaseName: target.d1.databaseName,
    originDigest: facts.conversion.originDigest,
    predecessorCustodyDigest: digest(JSON.stringify(convert)),
    sourceCommit: invocation.commit,
    sourceDigest: SOURCE_0098,
    importDigest: one.digest,
    backupDigest: facts.original92.backupDigest,
    preimageDigest: facts.conversion.preimageDigest,
    aggregateDigest: facts.conversion.aggregateDigest,
    classificationDigest: facts.conversion.classificationDigest,
    writerDigest: facts.conversion.writerDigest,
    resumeDigest: digest("normal immutable Version is held, not serving"),
    writerEpoch: facts.previousWriterEpoch,
    previousWriterEpoch: facts.previousWriterEpoch,
    nextWriterEpoch: facts.nextWriterEpoch,
    original92BackupDigest: facts.original92.backupDigest,
    converted94BackupDigest: facts.converted94.backupDigest,
    convertBindingDigest: facts.conversion.convertBindingDigest,
    modePreparationDigest: mode.bindingDigest,
    selectedStripeMode: "test",
    selectionReviewDigest: selection.selectionReviewDigest,
    financialContributionDigest,
    financialSourceBindingDigest: financial.sourceBindingDigest,
    signingGenesisDigest,
  };
  const readReview = () =>
    owner.readMoneyUnitHeldPost94IndependentReview(options, inputs, reviewBinding);
  const review = readReview(),
    reviewDigest = review === null ? null : validateReview(reviewBinding, review);
  const status = {
    kind: "takoserver.money-held-suffix98-status@v1",
    phase: "suffix98",
    sourceCommit: invocation.commit,
    sourceDigest: SOURCE_0098,
    importDigest: one.digest,
    financialContributionDigest,
    financialSourceBindingDigest: financial.sourceBindingDigest,
    modePreparationDigest: mode.bindingDigest,
    reviewBinding,
    reviewBindingDigest: moneyCutoverBindingDigest(reviewBinding),
    reviewed: reviewDigest !== null,
    normalHostReady: false,
  };
  if (invocation.action === "status") return status;
  if (reviewDigest === null)
    throw preflightError("money suffix requires exact protected independent import review");
  const run = options.run ?? runCommand;
  await qualifySource({
    environment: "integration",
    commit: invocation.commit,
    policy: "clean-remote",
    run,
  });
  const gate = await run(["bun", "run", "check:migrations"]);
  if (gate.exitCode !== 0)
    throw preflightError(`money suffix migration gate failed (exit ${gate.exitCode})`);
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    run,
  });
  assertProtectedDirectory(options.outputDirectory, "money suffix protected output");
  const root = mkdtempSync(join(options.outputDirectory, "money-suffix98-"));
  let lease: Awaited<ReturnType<typeof acquireWranglerVersionPublicationLease>> | null = null;
  let dispatched = false;
  const compiler = moneyPost94ReadCompiler(files);
  try {
    const configPath = join(root, "wrangler.jsonc"),
      importPath = join(root, "import.sql"),
      financialPath = join(root, "financial-contribution.json"),
      signingPath = join(root, "signing-genesis.json"),
      reviewPath = join(root, "independent-review.json");
    writeProtectedFile(configPath, Buffer.from(configJson(target)));
    const database = new RemoteD1(configPath, { environment: credential.childEnvironment, run });
    const initial = await readD1SchemaState(database);
    if (!moneyUnitCutoverSchemaMatches(initial, files, "0094-fenced"))
      throw preflightError("money suffix requires exact current fenced94");
    lease = await acquireWranglerVersionPublicationLease({
      accountId: target.accountId,
      workerName: `d1-${target.d1.databaseId}`,
      ...(options.leaseRoot === undefined ? {} : { root: options.leaseRoot }),
    });
    await qualifySource({
      environment: "integration",
      commit: invocation.commit,
      policy: "clean-remote",
      run,
    });
    await owner.assertMoneyUnitHeldPost94ConsumerInputsOrigin(options, inputs);
    await financialOwner.assertMoneyD1StripeRealmPinContributionCurrent(
      financial,
      inputs.context,
      mode,
    );
    await owner.assertMoneyUnitHeldPost94DispatchSelection(selection, {
      ...reviewBinding,
      kind: "takoserver.money-cutover-dispatch@v2",
    });
    await signingOwner.assertMoneyNormalWorkerSigningGenesisContributionCurrent(
      signing,
      inputs.context,
      mode,
    );
    const reviewedNow = readReview();
    if (
      reviewedNow === null ||
      validateReview(reviewBinding, reviewedNow) !== reviewDigest ||
      JSON.stringify(facts) !== factsJson ||
      digest(
        readProtectedBytes(
          owner.readMoneyUnitHeldPost94ConvertedBackupPath(options, inputs),
          "money original converted94",
        ),
      ) !== facts.converted94.backupDigest ||
      digest(Buffer.from(`${JSON.stringify(financial)}\n`)) !== financialContributionDigest
    )
      throw preflightError("money suffix original source/Financial/review changed before dispatch");
    assertMoneyPost94Source(
      readMigrationArtifact(options.sourceDirectory ?? resolve(REPOSITORY, "migrations")).files,
    );
    if (
      (await options.custody.read("suffix98")) !== null ||
      (await options.custody.readDispatch("suffix98")) !== null
    )
      throw mutationError("money suffix custody appeared; no resend");
    await owner.assertMoneyUnitHeldPost94ConsumerInputsOrigin(options, inputs);
    await financialOwner.assertMoneyD1StripeRealmPinContributionCurrent(
      financial,
      inputs.context,
      mode,
    );
    await signingOwner.assertMoneyNormalWorkerSigningGenesisContributionCurrent(
      signing,
      inputs.context,
      mode,
    );
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    writeProtectedFile(importPath, Buffer.from(one.sql));
    writeProtectedFile(financialPath, financialBytes);
    writeProtectedFile(signingPath, signingBytes);
    const dispatchReview = readReview();
    if (dispatchReview === null || validateReview(reviewBinding, dispatchReview) !== reviewDigest)
      throw preflightError("money suffix review changed before sealed dispatch");
    const reviewBytes = Buffer.from(JSON.stringify(dispatchReview));
    if (digest(reviewBytes) !== reviewDigest)
      throw preflightError("money suffix sealed review value differs");
    writeProtectedFile(reviewPath, reviewBytes);
    const sealed = sealDirectory(root, [
      "wrangler.jsonc",
      "import.sql",
      "financial-contribution.json",
      "signing-genesis.json",
      "independent-review.json",
    ]);
    const { kind: _reviewKind, ...common } = reviewBinding;
    const binding: MoneyPost94OneDispatchBinding = {
      ...common,
      kind: "takoserver.money-cutover-dispatch@v2",
      phase: "suffix98",
      reviewDigest,
      beforeShapeDigest: initial.shapeDigest,
      afterSchemaPhase: "0098-fenced",
      sealedImportPath: importPath,
      financialContributionPath: financialPath,
      signingGenesisPath: signingPath,
    };
    validateCustody(
      await options.custody.dispatch(binding),
      "suffix98",
      moneyCutoverBindingDigest(binding),
      "dispatched",
    );
    dispatched = true;
    sealed.assertUnchanged();
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    // This is the review authorization linearization point for the native
    // invocation. A later withdrawal cannot cancel an irreversible in-flight
    // request, and never permits a resend or a fabricated successful terminal.
    const importReview = readReview();
    if (importReview === null || validateReview(reviewBinding, importReview) !== reviewDigest)
      throw verificationError("money suffix review changed before native import");
    await runImport(importPath, configPath, target, run, credential.childEnvironment, [
      "financial-contribution.json",
      "signing-genesis.json",
      "independent-review.json",
    ]);
    // From this point held94/pre-import Financial assertions are INVALID. Use
    // original native GET/SELECT and immutable source/phase readback only.
    const schema = await readD1SchemaState(database, "verification");
    if (!moneyUnitCutoverSchemaMatches(schema, files, "0098-fenced"))
      throw verificationError("money suffix acknowledged but exact98/restored guards failed");
    assertFreezeRow(
      await readFreezeRow(database, "verification"),
      facts.conversion.freezeBindingDigest,
      facts.conversion.originDigest,
      facts.original92.backupDigest,
      facts.conversion.writerDigest,
      "verification",
    );
    await assertPermitEmpty(database, "verification", facts.nextWriterEpoch);
    await assertStripeModeRealm(readonlyMoneySql(database, compiler, "verification"), "test");
    await assertMoneySigningGenesisPostimage(database, signing, "verification");
    await assertMoneyLiveBackupCompleteness(database, "verification", {
      rowCounts: one.expectedRowCounts,
      allDataDigest: one.expectedAllDataDigest,
    });
    const origin = await options.stageOriginProof(),
      identity = await options.storageIdentityRead(),
      maintenance = await options.maintenanceProof();
    assertStageTarget(target, origin, identity, true);
    assertMaintenanceProof(target, maintenance, options.maintenanceCommit);
    if (
      digest(JSON.stringify(origin)) !== facts.conversion.originDigest ||
      digest(JSON.stringify(maintenance)) !== facts.conversion.writerDigest ||
      JSON.stringify(identity) !== JSON.stringify(facts.storage)
    )
      throw verificationError("money suffix original physical/maintenance origin changed");
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    sealed.assertUnchanged();
    const reviewedAfter = readReview();
    if (reviewedAfter === null || validateReview(reviewBinding, reviewedAfter) !== reviewDigest)
      throw verificationError("money suffix review custody changed after acknowledgement");
    const postDigest = digest(
      JSON.stringify({
        applied: schema.applied,
        shapeDigest: schema.shapeDigest,
        allDataDigest: one.expectedAllDataDigest,
        writerEpoch: facts.nextWriterEpoch,
        financialContributionDigest,
      }),
    );
    await lease.release();
    lease = null;
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    sealed.assertUnchanged();
    const terminalReview = readReview();
    if (terminalReview === null || validateReview(reviewBinding, terminalReview) !== reviewDigest)
      throw verificationError("money suffix review changed after cleanup before terminal");
    validateCustody(
      await options.custody.terminal(binding, postDigest),
      "suffix98",
      moneyCutoverBindingDigest(binding),
      "terminal",
      postDigest,
    );
    return {
      ...status,
      kind: "takoserver.money-held-suffix98-result@v1",
      custody: "terminal",
      schemaPhase: "0098-fenced",
      postDigest,
      writerState: "original maintenance still serves; normal Version remains held",
      normalHostReady: false,
    };
  } catch (error) {
    if (dispatched) {
      const failure = verificationError(
        "money suffix dispatch is retained; keep freeze and use original status GET only, never resend",
      );
      throw verificationError(
        failure.message,
        JSON.stringify({
          kind: "takoserver.money-suffix-retained-failure@v1",
          code: "retained_dispatch_failure",
          sourceDigest: SOURCE_0098,
          importDigest: one.digest,
        }),
      );
    }
    throw error;
  } finally {
    compiler.close();
    if (lease !== null) await lease.release();
    if (!dispatched) rmSync(root, { recursive: true, force: true });
  }
}

function moneySigningPostimageMatches(
  row: unknown,
  signing: Pick<
    MoneyNormalWorkerSigningGenesisContribution,
    "keyId" | "publicJwk" | "createdAtEpochSeconds"
  >,
): boolean {
  return (
    record(row) &&
    Object.keys(row).sort().join(",") ===
      "created_at_epoch_seconds,key_id,public_jwk,revoked_at_epoch_seconds" &&
    row.key_id === signing.keyId &&
    row.public_jwk === signing.publicJwk &&
    row.created_at_epoch_seconds === signing.createdAtEpochSeconds &&
    row.revoked_at_epoch_seconds === null
  );
}

async function assertMoneySigningGenesisPostimage(
  database: PreimageReader,
  signing: MoneyNormalWorkerSigningGenesisContribution,
  phase: DeployPhase,
): Promise<void> {
  const rows = await database.query(
    phase,
    "exact original signing genesis postimage",
    "SELECT key_id,public_jwk,created_at_epoch_seconds,revoked_at_epoch_seconds FROM runtime_grant_keys LIMIT 2",
  );
  if (rows.length !== 1 || !moneySigningPostimageMatches(rows[0], signing))
    throw proofError(phase, "money signing genesis exact active row differs");
}

function moneyPreserved100ReviewBinding(input: {
  readonly commit: string;
  readonly target: DeployTarget;
  readonly suffix: MoneyPost94DispatchBinding;
  readonly suffixReceipt: MoneyCutoverCustodyReceipt;
  readonly freezeBindingDigest: string;
  readonly beforeShapeDigest: string;
  readonly prepared: MoneyPreserved100ImportData;
}): MoneyPreserved100ReviewBinding {
  if (
    input.suffix.phase !== "suffix98" ||
    input.suffixReceipt.phase !== "suffix98" ||
    input.suffixReceipt.state !== "terminal" ||
    !SHA256.test(input.suffixReceipt.postDigest ?? "") ||
    !SHA256.test(input.freezeBindingDigest) ||
    !SHA256.test(input.beforeShapeDigest)
  )
    throw preflightError("money preserved100 review requires original exact98 facts");
  return Object.freeze({
    kind: "takoserver.money-preserved100-import-review@v1",
    phase: "preserved100",
    accountId: input.target.accountId,
    databaseId: input.target.d1.databaseId,
    databaseName: input.target.d1.databaseName,
    bucketName: input.target.r2.bucketName,
    workerName: input.target.workerName,
    sourceCommit: input.commit,
    sourceDigest: input.prepared.sourceDigest,
    importDigest: input.prepared.importDigest,
    suffixBindingDigest: input.suffixReceipt.bindingDigest,
    suffixPostDigest: String(input.suffixReceipt.postDigest),
    suffixReviewDigest: input.suffix.reviewDigest,
    freezeBindingDigest: input.freezeBindingDigest,
    originDigest: input.suffix.originDigest,
    original92BackupDigest: input.suffix.backupDigest,
    writerDigest: input.suffix.writerDigest,
    nextWriterEpoch: input.suffix.nextWriterEpoch,
    beforeShapeDigest: input.beforeShapeDigest,
    afterShapeDigest: digest(input.prepared.afterShape),
  });
}

/** The existing original Money path's 98→100 continuation; no new importer or uploader. */
export async function runIntegrationMoneyOriginalPreserved100(
  invocation: MoneyUnitCutoverInvocation,
  target: DeployTarget,
  options: MoneyUnitOriginalCutoverOptions,
  post94DeclarationPath: string,
): Promise<Record<string, unknown>> {
  if (
    invocation.environment !== "integration" ||
    invocation.throughMigration !== "0100" ||
    !COMMIT.test(invocation.commit) ||
    !["status", "apply"].includes(invocation.action)
  )
    throw preflightError("money preserved100 requires the fixed integration0100 invocation");
  const owner = await import("./schema-money-unit-owner.ts");
  target = owner.assertMoneyUnitOriginalWriterOptions(options, target);
  if (
    options.phase !== "convert" ||
    options.outputDirectory === undefined ||
    (options.sourceDirectory !== undefined &&
      resolve(options.sourceDirectory) !== resolve(REPOSITORY, "migrations"))
  )
    throw preflightError("money preserved100 requires the original convert owner and source");
  const suffixReceipt = await options.custody.read("suffix98"),
    suffix = await options.custody.readDispatch("suffix98");
  if (
    suffixReceipt?.state !== "terminal" ||
    suffix?.kind !== "takoserver.money-cutover-dispatch@v2" ||
    suffix.phase !== "suffix98" ||
    suffix.afterSchemaPhase !== "0098-fenced" ||
    suffixReceipt.bindingDigest !== moneyCutoverBindingDigest(suffix) ||
    !SHA256.test(suffixReceipt.postDigest ?? "") ||
    typeof suffix.signingGenesisPath !== "string" ||
    (await options.custody.read("resume98")) !== null ||
    (await options.custody.readDispatch("resume98")) !== null
  )
    throw preflightError("money preserved100 requires the original terminal98 without thaw");
  owner.assertMoneyUnitOriginalPost94DispatchData(options, post94DeclarationPath, suffix);
  const existing = await options.custody.read("preserved100"),
    existingBinding = await options.custody.readDispatch("preserved100");
  if (invocation.action === "status") {
    if (existing === null && existingBinding === null) {
      const before = await readIntegrationMoneyPost94CustodyStatus(
        { ...invocation, action: "status", throughMigration: "0098" },
        target,
        options,
        post94DeclarationPath,
      );
      if (before.custody !== "terminal" || before.schemaPhase !== "0098-fenced")
        throw preflightError("money preserved100 review source requires exact terminal98");
      const signing: unknown = JSON.parse(
        readProtectedBytes(suffix.signingGenesisPath, "money original signing DATA").toString(
          "utf8",
        ),
      );
      if (
        !record(signing) ||
        typeof signing.keyId !== "string" ||
        typeof signing.publicJwk !== "string" ||
        typeof signing.createdAtEpochSeconds !== "number"
      )
        throw preflightError("money preserved100 status signing source is malformed");
      const scratch = mkdtempSync(join(options.outputDirectory, "money-preserved100-status-"));
      let reviewBinding: MoneyPreserved100ReviewBinding;
      try {
        const prepared = buildMoneyOriginalPreserved100ImportData({
          sourceDirectory: options.sourceDirectory ?? resolve(REPOSITORY, "migrations"),
          scratchBase: scratch,
          freezeBindingDigest: String(before.freezeBindingDigest),
          originDigest: suffix.originDigest,
          original92BackupDigest: suffix.original92BackupDigest,
          writerDigest: suffix.writerDigest,
          nextWriterEpoch: suffix.nextWriterEpoch,
          signingKeyId: signing.keyId,
          signingPublicJwk: signing.publicJwk,
          signingCreatedAtEpochSeconds: signing.createdAtEpochSeconds,
        });
        reviewBinding = moneyPreserved100ReviewBinding({
          commit: invocation.commit,
          target,
          suffix,
          suffixReceipt,
          freezeBindingDigest: String(before.freezeBindingDigest),
          beforeShapeDigest: String(before.schemaShapeDigest),
          prepared,
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      return Object.freeze({
        kind: "takoserver.money-preserved100-status@v1",
        custody: "not-dispatched",
        schemaPhase: before.schemaPhase,
        reviewBinding,
        reviewBindingDigest: moneyCutoverBindingDigest(reviewBinding),
        readOnly: true,
        canResend: false,
        normalHostReady: false,
      });
    }
    if (
      !existing ||
      !existingBinding ||
      existingBinding.kind !== "takoserver.money-cutover-dispatch@v3" ||
      existingBinding.phase !== "preserved100" ||
      existing.bindingDigest !== moneyCutoverBindingDigest(existingBinding)
    )
      throw preflightError("money preserved100 status has partial or foreign custody");
    let schemaPhase: "0100-fenced" | "unknown" = "unknown";
    try {
      await readIntegrationMoneyOriginalPreservedSource(
        target,
        options,
        post94DeclarationPath,
        100,
        existing.state,
      );
      schemaPhase = "0100-fenced";
    } catch {
      // Unknown acknowledgement is observation DATA, never a terminal receipt.
    }
    return Object.freeze({
      kind: "takoserver.money-preserved100-status@v1",
      custody: existing.state,
      schemaPhase,
      readOnly: true,
      canResend: false,
      terminalRecovery: "not-attempted",
      normalHostReady: false,
    });
  }
  if (existing !== null || existingBinding !== null)
    throw mutationError("money preserved100 custody already exists; no resend");
  const before = await readIntegrationMoneyPost94CustodyStatus(
    { ...invocation, action: "status", throughMigration: "0098" },
    target,
    options,
    post94DeclarationPath,
  );
  if (before.custody !== "terminal" || before.schemaPhase !== "0098-fenced")
    throw preflightError("money preserved100 requires exact original fenced98 before dispatch");
  const signing: unknown = JSON.parse(
    readProtectedBytes(suffix.signingGenesisPath, "money original signing DATA").toString("utf8"),
  );
  if (
    !record(signing) ||
    signing.kind !== "takoserver.money-normal-signing-genesis-contribution@v1" ||
    signing.normalModeBindingDigest !== suffix.modePreparationDigest ||
    signing.convertBindingDigest !== suffix.convertBindingDigest ||
    signing.original92BackupDigest !== suffix.original92BackupDigest ||
    signing.converted94BackupDigest !== suffix.converted94BackupDigest ||
    typeof signing.keyId !== "string" ||
    typeof signing.publicJwk !== "string" ||
    typeof signing.createdAtEpochSeconds !== "number"
  )
    throw preflightError("money preserved100 requires unchanged original signing genesis");
  const run = options.run ?? runCommand;
  await qualifySource({
    environment: "integration",
    commit: invocation.commit,
    policy: "clean-remote",
    run,
  });
  const gate = await run(["bun", "run", "check:migrations"]);
  if (gate.exitCode !== 0)
    throw preflightError(`money preserved100 migration gate failed (exit ${gate.exitCode})`);
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    run,
  });
  assertProtectedDirectory(options.outputDirectory, "money preserved100 protected output");
  const root = mkdtempSync(join(options.outputDirectory, "money-preserved100-"));
  let lease: Awaited<ReturnType<typeof acquireWranglerVersionPublicationLease>> | null = null;
  let dispatched = false;
  try {
    const sourceDirectory = options.sourceDirectory ?? resolve(REPOSITORY, "migrations");
    const prepared = buildMoneyOriginalPreserved100ImportData({
      sourceDirectory,
      scratchBase: root,
      freezeBindingDigest:
        suffix.originDigest === before.originDigest ? String(before.freezeBindingDigest) : "",
      originDigest: suffix.originDigest,
      original92BackupDigest: suffix.original92BackupDigest,
      writerDigest: suffix.writerDigest,
      nextWriterEpoch: suffix.nextWriterEpoch,
      signingKeyId: signing.keyId,
      signingPublicJwk: signing.publicJwk,
      signingCreatedAtEpochSeconds: signing.createdAtEpochSeconds,
    });
    const configPath = join(root, "wrangler.jsonc"),
      importPath = join(root, "import.sql");
    writeProtectedFile(configPath, Buffer.from(configJson(target)));
    const database = new RemoteD1(configPath, { environment: credential.childEnvironment, run });
    lease = await acquireWranglerVersionPublicationLease({
      accountId: target.accountId,
      workerName: `d1-${target.d1.databaseId}`,
      ...(options.leaseRoot === undefined ? {} : { root: options.leaseRoot }),
    });
    const observed = await readD1SchemaState(database);
    if (
      observed.applied.length !== 98 ||
      observed.applied.some((name, index) => name !== prepared.names[index]) ||
      !applicationSchemaMatches(observed, prepared.beforeShape) ||
      observed.shapeDigest !== before.schemaShapeDigest
    )
      throw preflightError("money preserved100 requires exact fenced98 schema and ledger");
    const reviewBinding = moneyPreserved100ReviewBinding({
      commit: invocation.commit,
      target,
      suffix,
      suffixReceipt,
      freezeBindingDigest: String(before.freezeBindingDigest),
      beforeShapeDigest: observed.shapeDigest,
      prepared,
    });
    const reviewed = owner.readMoneyUnitOriginalPreserved100IndependentReview(
      options,
      reviewBinding,
    );
    if (reviewed === null)
      throw preflightError("money preserved100 requires exact protected independent import review");
    const reviewDigest = validateReview(reviewBinding, reviewed);
    assertFreezeRow(
      await readFreezeRow(database, "preflight"),
      String(before.freezeBindingDigest),
      suffix.originDigest,
      suffix.original92BackupDigest,
      suffix.writerDigest,
      "preflight",
    );
    await assertPermitEmpty(database, "preflight", suffix.nextWriterEpoch);
    await assertMoneySigningGenesisPostimage(
      database,
      signing as unknown as MoneyNormalWorkerSigningGenesisContribution,
      "preflight",
    );
    await assertMoneyNativeForeignKeys(database, "preflight");
    const maintenance = await options.maintenanceProof();
    assertMaintenanceProof(target, maintenance, options.maintenanceCommit);
    if (digest(JSON.stringify(maintenance)) !== suffix.writerDigest)
      throw preflightError("money preserved100 original maintenance Version changed");
    const preDispatch = await readIntegrationMoneyPost94CustodyStatus(
      { ...invocation, action: "status", throughMigration: "0098" },
      target,
      options,
      post94DeclarationPath,
    );
    if (
      preDispatch.custody !== "terminal" ||
      preDispatch.schemaPhase !== "0098-fenced" ||
      preDispatch.schemaShapeDigest !== observed.shapeDigest ||
      preDispatch.freezeBindingDigest !== before.freezeBindingDigest ||
      preDispatch.originDigest !== suffix.originDigest
    )
      throw preflightError("money preserved100 original98 changed before dispatch");
    const reviewedNow = owner.readMoneyUnitOriginalPreserved100IndependentReview(
      options,
      reviewBinding,
    );
    if (reviewedNow === null || validateReview(reviewBinding, reviewedNow) !== reviewDigest)
      throw preflightError("money preserved100 independent review changed before dispatch");
    if (
      (await options.custody.read("preserved100")) !== null ||
      (await options.custody.readDispatch("preserved100")) !== null ||
      JSON.stringify(await options.custody.read("suffix98")) !== JSON.stringify(suffixReceipt) ||
      JSON.stringify(await options.custody.readDispatch("suffix98")) !== JSON.stringify(suffix)
    )
      throw mutationError("money preserved100 original custody changed before dispatch");
    const currentSource = readMoneyOriginalPreservedSourceInventory(sourceDirectory, 100, root);
    try {
      currentSource.assertCurrent();
      if (currentSource.sourceDigest !== prepared.sourceDigest)
        throw preflightError("money preserved100 source changed before sealed dispatch");
    } finally {
      currentSource.dispose();
    }
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    writeProtectedFile(importPath, Buffer.from(prepared.sql));
    writeProtectedFile(
      join(root, "independent-review.json"),
      Buffer.from(JSON.stringify(reviewedNow)),
    );
    const sealed = sealDirectory(root, ["wrangler.jsonc", "import.sql", "independent-review.json"]);
    const binding: MoneyPreserved100DispatchBinding = {
      kind: "takoserver.money-cutover-dispatch@v3",
      phase: "preserved100",
      accountId: target.accountId,
      databaseId: target.d1.databaseId,
      databaseName: target.d1.databaseName,
      originDigest: suffix.originDigest,
      predecessorCustodyDigest: digest(JSON.stringify(suffixReceipt)),
      sourceCommit: invocation.commit,
      sourceDigest: prepared.sourceDigest,
      importDigest: prepared.importDigest,
      backupDigest: suffix.backupDigest,
      preimageDigest: suffix.preimageDigest,
      aggregateDigest: suffix.aggregateDigest,
      classificationDigest: suffix.classificationDigest,
      writerDigest: suffix.writerDigest,
      resumeDigest: suffix.resumeDigest,
      writerEpoch: suffix.nextWriterEpoch,
      reviewDigest,
      beforeShapeDigest: observed.shapeDigest,
      afterSchemaPhase: "0100-fenced",
      sealedImportPath: importPath,
      suffixBindingDigest: suffixReceipt.bindingDigest,
      suffixPostDigest: String(suffixReceipt.postDigest),
      expectedAfterShapeDigest: digest(prepared.afterShape),
      nextWriterEpoch: suffix.nextWriterEpoch,
      suffixReviewDigest: suffix.reviewDigest,
    };
    validateCustody(
      await options.custody.dispatch(binding),
      "preserved100",
      moneyCutoverBindingDigest(binding),
      "dispatched",
    );
    dispatched = true;
    sealed.assertUnchanged();
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    const reviewBeforeImport = owner.readMoneyUnitOriginalPreserved100IndependentReview(
      options,
      reviewBinding,
    );
    if (
      reviewBeforeImport === null ||
      validateReview(reviewBinding, reviewBeforeImport) !== reviewDigest
    )
      throw verificationError("money preserved100 review changed before native import");
    await runImport(importPath, configPath, target, run, credential.childEnvironment, [
      "independent-review.json",
    ]);
    const post = await readIntegrationMoneyOriginalPreservedSource(
      target,
      options,
      post94DeclarationPath,
      100,
      "dispatched",
    );
    if (post.kind !== "takoserver.money-original-preserved100-source@v1")
      throw verificationError("money preserved100 postread returned a divergent phase");
    const reviewedAfter = owner.readMoneyUnitOriginalPreserved100IndependentReview(
      options,
      reviewBinding,
    );
    if (reviewedAfter === null || validateReview(reviewBinding, reviewedAfter) !== reviewDigest)
      throw verificationError("money preserved100 review changed after acknowledgement");
    sealed.assertUnchanged();
    const postDigest = digest(
      JSON.stringify({
        applied: prepared.names,
        shapeDigest: post.schemaShapeDigest,
        writerEpoch: post.currentWriterEpoch,
        suffixBindingDigest: post.suffixBindingDigest,
        sourceDigest: prepared.sourceDigest,
        importDigest: prepared.importDigest,
      }),
    );
    await lease.release();
    lease = null;
    owner.assertMoneyUnitOriginalWriterOptions(options, target);
    sealed.assertUnchanged();
    const terminalReview = owner.readMoneyUnitOriginalPreserved100IndependentReview(
      options,
      reviewBinding,
    );
    if (terminalReview === null || validateReview(reviewBinding, terminalReview) !== reviewDigest)
      throw verificationError("money preserved100 review changed before terminal custody");
    validateCustody(
      await options.custody.terminal(binding, postDigest),
      "preserved100",
      moneyCutoverBindingDigest(binding),
      "terminal",
      postDigest,
    );
    return Object.freeze({
      kind: "takoserver.money-preserved100-result@v1",
      custody: "terminal",
      schemaPhase: "0100-fenced",
      sourceDigest: prepared.sourceDigest,
      importDigest: prepared.importDigest,
      postDigest,
      normalHostReady: false,
    });
  } catch (error) {
    if (dispatched)
      throw verificationError(
        "money preserved100 dispatch is retained; keep freeze and use status GET only, never resend",
      );
    throw error;
  } finally {
    if (lease !== null) await lease.release();
  }
}
