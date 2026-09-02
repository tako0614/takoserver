import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RemoteD1 } from "./d1.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  type D1SchemaState,
  pendingMigrations,
  readD1SchemaState,
  readMigrationArtifact,
} from "./migrations.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  sealDirectory,
  unsealDirectory,
} from "./qualification.ts";
import type { DeployTarget } from "./target.ts";

const RECEIPT_KIND = "takoserver.d1-schema-rehearsal-receipt@v1";
const PROVIDER_REPAIR_MIGRATION = "0036_provider_repair_and_managed_schedule_reconciliation.sql";
const PROVIDER_EXECUTION_LEASE_MIGRATION = "0024_takoform_provider_execution_leases.sql";

export type SchemaProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface SchemaReader {
  read(phase: DeployPhase): Promise<D1SchemaState>;
  /** Read-only 0036 preflight; required when that migration is the pending head. */
  unmatchedProviderRepairSagaCount?(phase: DeployPhase): Promise<number>;
}

export interface SchemaInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface SchemaOptions {
  readonly run?: SchemaProcess;
  readonly reader?: SchemaReader;
  readonly migrationDirectory?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly receiptPath?: string;
  readonly review?: string;
}

interface RehearsalReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly commit: string;
  readonly migrationDigest: string;
  readonly migrationFiles: readonly {
    readonly name: string;
    readonly digest: string;
    readonly bytes: number;
  }[];
  readonly preAppliedMigrations: readonly string[];
  readonly pendingMigrations: readonly string[];
  readonly preShapeDigest: string;
  readonly postAppliedMigrations: readonly string[];
  readonly postShapeDigest: string;
}

/** One forward-only D1 migration lane with rehearsal-to-production shape proof. */
export async function runD1Schema(
  invocation: SchemaInvocation,
  target: DeployTarget,
  options: SchemaOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("D1 schema invocation and target environments differ");
  }
  const run = options.run ?? runCommand;
  const environment =
    options.cloudflareEnvironment ??
    (options.reader !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const sourceMigrations = readMigrationArtifact(
    options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
  );
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-schema-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const inspectionConfig = writeD1Config(
      join(root, "inspect-wrangler.jsonc"),
      target,
      options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
    );
    const initial = await readState(
      "preflight",
      inspectionConfig,
      environment,
      run,
      options.reader,
    );
    const pending = pendingMigrations(sourceMigrations.names, initial.applied);
    const providerRepairPreflight = await inspectProviderRepairPreflight({
      phase: "preflight",
      pending,
      applied: initial.applied,
      configPath: inspectionConfig,
      environment,
      run,
      injected: options.reader,
    });
    if (invocation.action === "status") {
      return {
        kind: "takoserver.d1-schema-status@v2",
        surface: "takoserver-d1-schema",
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        migrationDigest: sourceMigrations.digest,
        migrationBytes: sourceMigrations.bytes,
        appliedMigrations: initial.applied,
        pendingMigrations: pending,
        schemaShapeDigest: initial.shapeDigest,
        providerRepairPreflight,
      };
    }
    if (providerRepairPreflight.status === "operator_reconciliation_required") {
      throw preflightError(
        "0036 requires provider-specific operator reconciliation before migration apply",
        `unmatchedDispatchedSagaCount=${providerRepairPreflight.unmatchedDispatchedSagaCount}`,
      );
    }
    if (pending.length === 0) {
      throw preflightError(
        "no pending D1 migration exists; --apply refuses to turn a no-op into green mutation evidence",
      );
    }

    const source = await qualifySource({
      environment: invocation.environment === "integration" ? "integration" : "production",
      commit: invocation.commit,
      run,
    });
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    const receiptPath =
      invocation.environment === "integration"
        ? null
        : exactReceiptPath(
            options.receiptPath ?? requireEnvironment("TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH"),
          );
    if (invocation.environment === "rehearsal" && receiptPath && existsSync(receiptPath)) {
      throw preflightError("rehearsal receipt already exists and will not be overwritten");
    }
    await checked(run, "preflight", "scoped migration gate `bun run check:migrations`", [
      "bun",
      "run",
      "check:migrations",
    ]);

    const release = join(root, "release");
    const sealedMigrations = join(release, "migrations");
    mkdirSync(sealedMigrations, { recursive: true, mode: 0o700 });
    for (const file of sourceMigrations.files) {
      copyFileSync(file.path, join(sealedMigrations, file.name));
    }
    const sealedMigrationArtifact = readMigrationArtifact(sealedMigrations);
    if (
      sealedMigrationArtifact.digest !== sourceMigrations.digest ||
      JSON.stringify(sealedMigrationArtifact.names) !== JSON.stringify(sourceMigrations.names)
    ) {
      throw preflightError("sealed migration copy differs from the qualified source bytes");
    }
    const configPath = writeD1Config(join(release, "wrangler.jsonc"), target, "migrations");
    const artifact = sealDirectory(release, [
      "wrangler.jsonc",
      ...sourceMigrations.names.map((name) => `migrations/${name}`),
    ]);

    const requalified = await readState("preflight", configPath, environment, run, options.reader);
    assertSamePreState(initial, requalified);
    const requalifiedPending = pendingMigrations(sourceMigrations.names, requalified.applied);
    if (JSON.stringify(requalifiedPending) !== JSON.stringify(pending)) {
      throw preflightError("D1 pending migration suffix changed during qualification");
    }
    const requalifiedProviderRepair = await inspectProviderRepairPreflight({
      phase: "preflight",
      pending: requalifiedPending,
      applied: requalified.applied,
      configPath,
      environment,
      run,
      injected: options.reader,
    });
    if (
      JSON.stringify(requalifiedProviderRepair) !== JSON.stringify(providerRepairPreflight) ||
      requalifiedProviderRepair.status === "operator_reconciliation_required"
    ) {
      throw preflightError("D1 provider repair preflight changed during qualification");
    }

    const receipt =
      invocation.environment === "production" ? readReceipt(receiptPath as string) : null;
    if (receipt) {
      assertReceiptMatches(receipt, {
        commit: source.commit,
        artifact: sourceMigrations,
        pre: requalified,
        pending,
      });
    }

    artifact.assertUnchanged();
    const apply = await run(
      wranglerCommand([
        "d1",
        "migrations",
        "apply",
        target.d1.databaseName,
        "--remote",
        "--config",
        configPath,
      ]),
      { env: environment },
    );
    if (apply.exitCode !== 0) {
      throw mutationError(
        "D1 migration apply acknowledgement is indeterminate; inspect exact lineage and shape",
        `${apply.stdout}${apply.stderr}`.trim(),
      );
    }
    const post = await readState("verification", configPath, environment, run, options.reader);
    if (JSON.stringify(post.applied) !== JSON.stringify(sourceMigrations.names)) {
      throw verificationError(
        "D1 post-readback does not contain the exact complete ordered migration lineage",
        `expected=${JSON.stringify(sourceMigrations.names)} actual=${JSON.stringify(post.applied)}`,
      );
    }
    if (pendingMigrations(sourceMigrations.names, post.applied).length !== 0) {
      throw verificationError("D1 post-readback still has pending migrations");
    }
    if (receipt && post.shapeDigest !== receipt.postShapeDigest) {
      throw verificationError(
        "production D1 post-shape differs from the exact rehearsal receipt",
        `expected=${receipt.postShapeDigest} actual=${post.shapeDigest}`,
      );
    }

    if (invocation.environment === "rehearsal" && receiptPath) {
      writeReceipt(receiptPath, {
        kind: RECEIPT_KIND,
        commit: source.commit,
        migrationDigest: sourceMigrations.digest,
        migrationFiles: sourceMigrations.files.map(({ name, digest, bytes }) => ({
          name,
          digest,
          bytes,
        })),
        preAppliedMigrations: requalified.applied,
        pendingMigrations: pending,
        preShapeDigest: requalified.shapeDigest,
        postAppliedMigrations: post.applied,
        postShapeDigest: post.shapeDigest,
      });
    }

    return {
      kind: "takoserver.d1-schema-apply@v2",
      surface: "takoserver-d1-schema",
      environment: invocation.environment,
      commit: source.commit,
      remoteRef: source.remoteRef,
      reviewer,
      migrationDigest: sourceMigrations.digest,
      migrationBytes: sourceMigrations.bytes,
      pendingMigrations: pending,
      providerRepairPreflight: requalifiedProviderRepair,
      preShapeDigest: requalified.shapeDigest,
      postShapeDigest: post.shapeDigest,
      appliedMigrations: post.applied,
      rehearsalReceipt:
        invocation.environment === "rehearsal"
          ? "written-without-overwrite"
          : invocation.environment === "production"
            ? "exact-match-consumed-read-only"
            : "not-required",
      rollback: "forward repair only: D1 migrations have no down path",
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

interface ProviderRepairPreflight {
  readonly status: "not_pending" | "ready" | "operator_reconciliation_required";
  readonly unmatchedDispatchedSagaCount: number;
}

async function inspectProviderRepairPreflight(input: {
  readonly phase: DeployPhase;
  readonly pending: readonly string[];
  readonly applied: readonly string[];
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: SchemaProcess;
  readonly injected: SchemaReader | undefined;
}): Promise<ProviderRepairPreflight> {
  if (!input.pending.includes(PROVIDER_REPAIR_MIGRATION)) {
    return { status: "not_pending", unmatchedDispatchedSagaCount: 0 };
  }
  // Before 0024 no row can carry execution_started_at, so no dispatched
  // historical saga exists for 0036 to reconstruct.
  if (!input.applied.includes(PROVIDER_EXECUTION_LEASE_MIGRATION)) {
    return { status: "ready", unmatchedDispatchedSagaCount: 0 };
  }
  const count = input.injected
    ? await input.injected.unmatchedProviderRepairSagaCount?.(input.phase)
    : await readUnmatchedProviderRepairSagaCount(
        new RemoteD1(input.configPath, { environment: input.environment, run: input.run }),
        input.phase,
      );
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw preflightError("D1 provider repair preflight is unavailable");
  }
  return {
    status: count === 0 ? "ready" : "operator_reconciliation_required",
    unmatchedDispatchedSagaCount: Number(count),
  };
}

async function readUnmatchedProviderRepairSagaCount(
  database: RemoteD1,
  phase: DeployPhase,
): Promise<number> {
  const rows = await database.query(
    phase,
    "0036 unmatched provider repair preflight",
    `SELECT COUNT(*) AS unmatched_count
     FROM tf_provider_mutation_sagas AS saga
     WHERE saga.phase = 'planned'
       AND saga.receipt_json IS NULL
       AND saga.execution_started_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM tf_deferred_operations AS operation
         WHERE operation.id = saga.operation_id
           AND operation.tenant_id = saga.tenant_id
           AND operation.resource_uid = saga.resource_uid
           AND operation.replay_key = saga.replay_key
           AND operation.fingerprint = saga.fingerprint
           AND operation.target_space = saga.target_space
           AND operation.target_api_version = saga.target_api_version
           AND operation.target_kind = saga.target_kind
           AND operation.target_name = saga.target_name
           AND operation.accepted_uid IS saga.accepted_uid
           AND operation.accepted_generation IS saga.accepted_generation
           AND operation.accepted_revision IS saga.accepted_revision
           AND operation.phase = 'committing'
           AND operation.terminal_json IS NULL
       )`,
  );
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.unmatched_count)) {
    throw preflightError("D1 provider repair preflight returned a malformed count");
  }
  return Number(rows[0]?.unmatched_count);
}

async function readState(
  phase: DeployPhase,
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: SchemaProcess,
  injected: SchemaReader | undefined,
): Promise<D1SchemaState> {
  if (injected) return await injected.read(phase);
  return await readD1SchemaState(new RemoteD1(configPath, { environment, run }), phase);
}

function writeD1Config(path: string, target: DeployTarget, migrationDirectory: string): string {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        name: target.workerName,
        account_id: target.accountId,
        compatibility_date: "2026-08-17",
        d1_databases: [
          {
            binding: "STATE_DB",
            database_name: target.d1.databaseName,
            database_id: target.d1.databaseId,
            migrations_dir: migrationDirectory,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return path;
}

function assertSamePreState(left: D1SchemaState, right: D1SchemaState): void {
  if (
    JSON.stringify(left.applied) !== JSON.stringify(right.applied) ||
    left.shapeDigest !== right.shapeDigest ||
    left.shape !== right.shape
  ) {
    throw preflightError("D1 lineage or schema shape changed during qualification");
  }
}

function assertReceiptMatches(
  receipt: RehearsalReceipt,
  input: {
    readonly commit: string;
    readonly artifact: ReturnType<typeof readMigrationArtifact>;
    readonly pre: D1SchemaState;
    readonly pending: readonly string[];
  },
): void {
  const files = input.artifact.files.map(({ name, digest, bytes }) => ({ name, digest, bytes }));
  if (
    receipt.commit !== input.commit ||
    receipt.migrationDigest !== input.artifact.digest ||
    JSON.stringify(receipt.migrationFiles) !== JSON.stringify(files) ||
    JSON.stringify(receipt.preAppliedMigrations) !== JSON.stringify(input.pre.applied) ||
    JSON.stringify(receipt.pendingMigrations) !== JSON.stringify(input.pending) ||
    receipt.preShapeDigest !== input.pre.shapeDigest ||
    JSON.stringify(receipt.postAppliedMigrations) !== JSON.stringify(input.artifact.names)
  ) {
    throw preflightError("production state does not exactly match the D1 rehearsal receipt");
  }
}

function writeReceipt(path: string, receipt: RehearsalReceipt): void {
  try {
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw verificationError(
      "D1 changed but the no-overwrite rehearsal receipt could not be written",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

function readReceipt(path: string): RehearsalReceipt {
  const status = secureFileStatus(path, "D1 rehearsal receipt");
  if ((status.mode & 0o777) !== 0o600) {
    throw preflightError("D1 rehearsal receipt must be an owned 0600 regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw preflightError("D1 rehearsal receipt is not valid JSON");
  }
  if (!isRecord(value)) throw preflightError("D1 rehearsal receipt must be an object");
  assertExactKeys(value, [
    "kind",
    "commit",
    "migrationDigest",
    "migrationFiles",
    "preAppliedMigrations",
    "pendingMigrations",
    "preShapeDigest",
    "postAppliedMigrations",
    "postShapeDigest",
  ]);
  if (
    value.kind !== RECEIPT_KIND ||
    typeof value.commit !== "string" ||
    typeof value.migrationDigest !== "string" ||
    !Array.isArray(value.migrationFiles) ||
    !stringArray(value.preAppliedMigrations) ||
    !stringArray(value.pendingMigrations) ||
    typeof value.preShapeDigest !== "string" ||
    !stringArray(value.postAppliedMigrations) ||
    typeof value.postShapeDigest !== "string"
  ) {
    throw preflightError("D1 rehearsal receipt has an invalid shape");
  }
  const migrationFiles = value.migrationFiles.map((entry) => {
    if (!isRecord(entry)) throw preflightError("D1 rehearsal receipt has an invalid migration row");
    assertExactKeys(entry, ["name", "digest", "bytes"]);
    if (
      typeof entry.name !== "string" ||
      typeof entry.digest !== "string" ||
      !Number.isSafeInteger(entry.bytes) ||
      Number(entry.bytes) <= 0
    ) {
      throw preflightError("D1 rehearsal receipt has an invalid migration row");
    }
    return { name: entry.name, digest: entry.digest, bytes: entry.bytes as number };
  });
  return {
    kind: RECEIPT_KIND,
    commit: value.commit,
    migrationDigest: value.migrationDigest,
    migrationFiles,
    preAppliedMigrations: value.preAppliedMigrations,
    pendingMigrations: value.pendingMigrations,
    preShapeDigest: value.preShapeDigest,
    postAppliedMigrations: value.postAppliedMigrations,
    postShapeDigest: value.postShapeDigest,
  };
}

export function exactReceiptPath(value: string): string {
  if (!isAbsolute(value)) throw preflightError("D1 rehearsal receipt path must be absolute");
  const requested = resolve(value);
  const requestedParent = dirname(requested);
  let parent: string;
  try {
    parent = realpathSync(requestedParent);
  } catch {
    throw preflightError("D1 rehearsal receipt parent is unavailable");
  }
  const path = join(parent, basename(requested));
  const inside = relative(REPOSITORY, path);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw preflightError("D1 rehearsal receipt must stay outside the repository");
  }
  const status = statSync(parent, { throwIfNoEntry: false });
  if (
    !status?.isDirectory() ||
    (status.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw preflightError("D1 rehearsal receipt parent must be an owned 0700 directory");
  }
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      throw preflightError("D1 rehearsal receipt must stay outside every Git repository");
    }
    const next = dirname(cursor);
    if (next === cursor) break;
  }
  return path;
}

function secureFileStatus(path: string, label: string): Stats {
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch {
    throw preflightError(`${label} is unavailable`);
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw preflightError(`${label} must be an owned link-free regular file`);
  }
  return status;
}

async function checked(
  run: SchemaProcess,
  phase: DeployPhase,
  description: string,
  command: readonly string[],
): Promise<string> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw new DeployError(
      phase,
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw preflightError("D1 rehearsal receipt contains unexpected or missing keys");
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
