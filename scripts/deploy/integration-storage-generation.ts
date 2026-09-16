import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RemoteD1 } from "./d1.ts";
import { buildD1MigrationImport } from "./d1-migration-import.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import { canonicalSchemaShape, type D1SchemaState, readD1SchemaState } from "./migrations.ts";
import {
  type CommandResult,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  sealDirectory,
  unsealDirectory,
} from "./qualification.ts";
import { readAuditedMigrationArtifact, type SchemaReader } from "./schema.ts";
import type { DeployTarget } from "./target.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GENERATION = /^[0-9a-f]{32}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_D1_LIST_PAGES = 100;
const MAX_R2_LIST_PAGES = 100;
const R2_LIST_PAGE_SIZE = 100;
const MAX_MIGRATION_DIAGNOSTIC_NAMES = 128;

interface BoundedMigrationFailureEvidence {
  readonly exitCode: number | null;
  readonly appliedMigrations: readonly string[] | null;
  readonly expectedMigrations: readonly string[];
}

// Keep migration evidence in a private typed error so normalization never has
// to trust or forward arbitrary error detail text.
class MigrationApplyError extends DeployError {
  constructor(
    message: string,
    readonly evidence: BoundedMigrationFailureEvidence,
  ) {
    super("mutation", message);
  }
}

export interface IntegrationStorageGenerationInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly generation: string;
}

export interface IntegrationStorageD1Database {
  readonly name: string;
  readonly uuid: string;
}

export interface IntegrationStorageR2Bucket {
  readonly name: string;
}

/**
 * The only provider capability this surface needs.  It deliberately has no
 * delete, update, Worker, route, namespace, or target-binding operation.
 */
export interface IntegrationStorageGenerationProvider {
  listD1(name: string): Promise<readonly IntegrationStorageD1Database[]>;
  getD1(databaseId: string): Promise<IntegrationStorageD1Database>;
  createD1(name: string): Promise<IntegrationStorageD1Database>;
  listR2(name: string): Promise<readonly IntegrationStorageR2Bucket[]>;
  getR2(name: string): Promise<IntegrationStorageR2Bucket>;
  createR2(name: string): Promise<IntegrationStorageR2Bucket>;
}

export type IntegrationStorageFetcher = (request: Request) => Promise<Response>;

export type IntegrationStorageGenerationProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface IntegrationStorageGenerationStateReader {
  read(phase: DeployPhase): Promise<D1SchemaState>;
}

export interface IntegrationStorageGenerationOptions {
  readonly run?: IntegrationStorageGenerationProcess;
  readonly review?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly outputDirectory?: string;
  /** Test-only source seam; production callers use the repository migrations. */
  readonly migrationDirectory?: string;
  /** Narrow provider seam used by tests and local contract simulations. */
  readonly provider?: IntegrationStorageGenerationProvider;
  readonly fetcher?: IntegrationStorageFetcher;
  /** Narrow D1 state seam; no provider adoption or state writes are exposed. */
  readonly reader?: IntegrationStorageGenerationStateReader | Pick<SchemaReader, "read">;
  readonly readD1State?: (
    phase: DeployPhase,
    input: {
      readonly configPath: string;
      readonly databaseName: string;
      readonly databaseId: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly run: IntegrationStorageGenerationProcess;
    },
  ) => Promise<D1SchemaState>;
  readonly wranglerCommand?: (args: readonly string[]) => readonly string[];
}

/**
 * Read-only/status and one-way fresh-storage bootstrap for integration.
 *
 * The generated names are the complete identity of this surface.  The
 * environment-selected target contributes only the account and environment
 * guard; its current D1/R2 are never passed to a provider operation.
 */
export async function runIntegrationStorageGeneration(
  invocation: IntegrationStorageGenerationInvocation,
  target: DeployTarget,
  options: IntegrationStorageGenerationOptions = {},
): Promise<Record<string, unknown>> {
  const names = validateInvocation(invocation, target);
  if (invocation.action === "status") {
    const provider = await resolveProvider(target, options);
    return await statusStorageGeneration(invocation, names, provider);
  }
  return await applyStorageGeneration(invocation, target, names, options);
}

interface StorageNames {
  readonly databaseName: string;
  readonly bucketName: string;
}

function validateInvocation(
  invocation: IntegrationStorageGenerationInvocation,
  target: DeployTarget,
): StorageNames {
  if (invocation.action !== "status" && invocation.action !== "apply") {
    throw preflightError("integration storage generation requires --status or --apply");
  }
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("integration storage generation is integration-only");
  }
  if (invocation.environment !== target.environment) {
    throw preflightError("integration storage generation and target environments differ");
  }
  if (!COMMIT.test(invocation.commit)) {
    throw preflightError(
      "integration storage generation requires one exact lowercase 40-hex commit",
    );
  }
  if (!GENERATION.test(invocation.generation)) {
    throw preflightError("--generation must be exactly 32 lowercase hexadecimal characters");
  }
  if (!ACCOUNT_ID.test(target.accountId)) {
    throw preflightError("integration storage generation requires one exact account id");
  }
  const names = {
    databaseName: `takoserver-i-${invocation.generation}`,
    bucketName: `takoserver-i-${invocation.generation}`,
  } satisfies StorageNames;
  if (!RESOURCE_NAME.test(names.databaseName) || !RESOURCE_NAME.test(names.bucketName)) {
    throw preflightError("integration storage generation derived an invalid provider name");
  }
  if (target.d1.databaseName === names.databaseName || target.r2.bucketName === names.bucketName) {
    throw preflightError(
      "integration storage generation name collides with the selected target; " +
        "current storage is never adopted",
    );
  }
  return names;
}

async function statusStorageGeneration(
  invocation: IntegrationStorageGenerationInvocation,
  names: StorageNames,
  provider: ProviderContext,
): Promise<Record<string, unknown>> {
  const inventory = await readInventory(provider.provider, names, "preflight");
  const d1 = inventory.d1[0] ?? null;
  const r2 = inventory.r2[0] ?? null;
  const presence =
    d1 === null && r2 === null
      ? "absent"
      : d1 !== null && r2 === null
        ? "d1-only"
        : d1 === null
          ? "r2-only"
          : "both";
  return {
    kind: "takoserver.integration-storage-generation-status@v1",
    surface: "takoserver-integration-storage-generation",
    environment: "integration",
    selectedCommit: invocation.commit,
    generation: invocation.generation,
    d1: {
      databaseName: names.databaseName,
      databaseId: d1?.uuid ?? null,
      present: d1 !== null,
    },
    r2: {
      bucketName: names.bucketName,
      present: r2 !== null,
    },
    presence,
    readyForApply: d1 === null && r2 === null,
    rollback: "old active target remains unchanged; repair forward from any known aftermath",
  };
}

interface ProviderContext {
  readonly provider: IntegrationStorageGenerationProvider;
  readonly environment: Readonly<Record<string, string>>;
}

async function resolveProvider(
  target: DeployTarget,
  options: IntegrationStorageGenerationOptions,
): Promise<ProviderContext> {
  if (options.provider !== undefined) {
    return {
      provider: options.provider,
      environment: options.cloudflareEnvironment ?? {},
    };
  }
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("integration", {
    cloudflareEnvironment: options.cloudflareEnvironment,
    run,
  });
  return {
    provider: new CloudflareIntegrationStorageProvider(target.accountId, credential.token, {
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    }),
    environment: credential.childEnvironment,
  };
}

async function applyStorageGeneration(
  invocation: IntegrationStorageGenerationInvocation,
  target: DeployTarget,
  names: StorageNames,
  options: IntegrationStorageGenerationOptions,
): Promise<Record<string, unknown>> {
  const run = options.run ?? runCommand;
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  await qualifySource({ environment: "integration", commit: invocation.commit, run });

  const sourceArtifact = readAuditedMigrationArtifact(
    options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
  );
  await checkedMigrationGate(run);
  const expectedApplicationShape = deriveExpectedApplicationShape(sourceArtifact.files);

  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-integration-storage-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = join(root, "release");
  if (existsSync(release)) {
    throw preflightError("integration storage generation output directory is already in use");
  }
  const payload = join(release, "payload");
  const migrationOutput = join(payload, "migrations");
  mkdirSync(migrationOutput, { recursive: true, mode: 0o700 });
  let sealed: ReturnType<typeof sealDirectory> | null = null;
  let migrationSeal: ReturnType<typeof sealDirectory> | null = null;
  let mutationStarted = false;
  let knownDatabaseId: string | null = null;
  let result: Record<string, unknown> | undefined;
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    for (const file of sourceArtifact.files) {
      copyFileSync(file.path, join(migrationOutput, file.name));
    }
    const sealedArtifact = readAuditedMigrationArtifact(migrationOutput);
    if (
      sealedArtifact.digest !== sourceArtifact.digest ||
      JSON.stringify(sealedArtifact.names) !== JSON.stringify(sourceArtifact.names)
    ) {
      throw preflightError(
        "sealed integration migration lineage differs from the qualified source",
      );
    }
    // D1's /query parser truncates the nested CASE in the frozen 0047 trigger.
    // Its /import transport accepts those exact bytes; do not rewrite history
    // or change the canonical schema to work around a transport parser.
    const migrationImport = buildD1MigrationImport(sealedArtifact.files, { freshLedger: true });
    const importPath = join(payload, "migration-import.sql");
    writeFileSync(importPath, migrationImport.sql, { mode: 0o600, flag: "wx" });
    migrationSeal = sealDirectory(payload, [
      "migration-import.sql",
      ...sourceArtifact.names.map((name) => `migrations/${name}`),
    ]);
    const configPath = join(release, "wrangler.jsonc");

    const provider = await resolveProvider(target, options);
    const initial = await readInventory(provider.provider, names, "preflight");
    assertAbsent(initial, "initial integration storage name inventory");
    const fenced = await readInventory(provider.provider, names, "preflight");
    assertAbsent(fenced, "immediate precreate integration storage absence fence");
    migrationSeal.assertUnchanged();

    // Set this before entering the provider boundary: a lost acknowledgement
    // can mean Cloudflare created the database even when no identity returned.
    mutationStarted = true;
    const created = await providerCall("mutation", "new D1 create failed; do not retry", () =>
      provider.provider.createD1(names.databaseName),
    );
    const databaseId = validateCreatedD1(created, names.databaseName);
    knownDatabaseId = databaseId;
    const createdReadback = await providerCall(
      "mutation",
      "new D1 identity readback failed; do not retry",
      () => provider.provider.getD1(databaseId),
    );
    if (createdReadback.uuid !== databaseId || createdReadback.name !== names.databaseName) {
      throw mutationError(
        "new D1 identity readback did not match the exact generated name and id",
        `databaseId=${databaseId}`,
      );
    }

    const generatedTarget = {
      accountId: target.accountId,
      databaseName: names.databaseName,
      databaseId,
    };
    // The config is written only once the provider identity is known. The
    // migration directory has stayed sealed across the create/read fence.
    writeGenerationConfig(
      configPath,
      generatedTarget.accountId,
      generatedTarget.databaseName,
      generatedTarget.databaseId,
    );
    sealed = sealDirectory(release, [
      "wrangler.jsonc",
      "payload/migration-import.sql",
      ...sourceArtifact.names.map((name) => `payload/migrations/${name}`),
    ]);
    sealed.assertUnchanged();

    let preMigration: D1SchemaState;
    try {
      preMigration = await readGeneratedState(
        "mutation",
        configPath,
        generatedTarget,
        provider.environment,
        run,
        options,
      );
    } catch {
      throw mutationError(
        "new D1 empty readback failed; migration is withheld",
        `databaseId=${databaseId}`,
      );
    }
    assertEmptyDatabase(preMigration, databaseId);

    const migration = await applySealedMigrations(
      configPath,
      names.databaseName,
      importPath,
      generatedTarget,
      provider.environment,
      run,
      options,
      sealed,
      sourceArtifact.names,
    );
    const postMigration = migration.state;
    assertCompleteDatabase(
      postMigration,
      sourceArtifact.names,
      sourceArtifact.digest,
      expectedApplicationShape,
      databaseId,
    );

    const finalD1 = await providerCall(
      "verification",
      "new D1 final identity readback failed",
      () => provider.provider.getD1(databaseId),
    );
    if (finalD1.uuid !== databaseId || finalD1.name !== names.databaseName) {
      throw verificationError(
        "new D1 final identity readback did not match the exact generated name and id",
        `databaseId=${databaseId}`,
      );
    }

    const r2Fence = await readR2Presence(provider.provider, names.bucketName, "mutation");
    if (r2Fence.length > 0) {
      throw mutationError(
        "R2 generated name appeared before its post-migration create fence; do not adopt it",
        `databaseId=${databaseId} bucketName=${names.bucketName}`,
      );
    }
    sealed.assertUnchanged();
    const createdBucket = await providerCall("mutation", "new R2 create failed; do not retry", () =>
      provider.provider.createR2(names.bucketName),
    );
    validateCreatedR2(createdBucket, names.bucketName, databaseId);
    const bucketReadback = await providerCall(
      "verification",
      "new R2 identity readback failed",
      () => provider.provider.getR2(names.bucketName),
    );
    if (bucketReadback.name !== names.bucketName) {
      throw verificationError(
        "new R2 identity readback did not match the exact generated name",
        `databaseId=${databaseId} bucketName=${names.bucketName}`,
      );
    }

    result = {
      kind: "takoserver.integration-storage-generation-apply@v1",
      surface: "takoserver-integration-storage-generation",
      environment: "integration",
      commit: invocation.commit,
      reviewer,
      generation: invocation.generation,
      d1: {
        databaseName: names.databaseName,
        databaseId,
      },
      r2: { bucketName: names.bucketName },
      migrationDigest: sourceArtifact.digest,
      migrationBytes: sourceArtifact.bytes,
      migrationImportDigest: migrationImport.digest,
      migrationImportBytes: migrationImport.bytes,
      appliedMigrations: postMigration.applied,
      schemaShapeDigest: postMigration.shapeDigest,
      rollback: "old active target remains unchanged; repair forward from this exact generation",
    };
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  let cleanupFailed = false;
  let cleanupFailure: unknown;
  try {
    if (sealed !== null) unsealDirectory(sealed.root);
    else if (migrationSeal !== null) unsealDirectory(migrationSeal.root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }

  // Cleanup is deliberately outside a finally block: an unwinding cleanup
  // error must never replace the operation's original bounded failure.
  if (operationFailed) {
    if (!mutationStarted) throw operationFailure;
    throw normalizeAfterD1Create(operationFailure, knownDatabaseId);
  }
  if (cleanupFailed) {
    if (mutationStarted) throw normalizeAfterD1Create(cleanupFailure, knownDatabaseId);
    throw cleanupFailure;
  }
  if (result === undefined) {
    throw preflightError("integration storage generation produced no result");
  }
  return result;
}

async function checkedMigrationGate(run: IntegrationStorageGenerationProcess): Promise<void> {
  const result = await run(["bun", "run", "check:migrations"]);
  if (result.exitCode !== 0) {
    throw preflightError("scoped migration gate `bun run check:migrations` failed");
  }
}

type MigrationArtifactFile = ReturnType<typeof readAuditedMigrationArtifact>["files"][number];

/**
 * Reconstruct the schema expected from the sealed SQL before any provider
 * mutation.  The comparison deliberately ignores only the platform-owned
 * migration/KV metadata rows that do not belong to the application schema.
 */
function deriveExpectedApplicationShape(files: readonly MigrationArtifactFile[]): string {
  const database = new Database(":memory:");
  try {
    for (const file of files) {
      database.exec(readFileSync(file.path, "utf8"));
    }
    const rows = database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
          "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[];
    return canonicalSchemaShape(rows.filter((row) => !isPlatformSchemaMetadata(row)));
  } catch {
    throw preflightError("audited migrations could not reconstruct the expected canonical schema");
  } finally {
    database.close();
  }
}

interface GeneratedD1Target {
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
}

async function applySealedMigrations(
  configPath: string,
  databaseName: string,
  importPath: string,
  target: GeneratedD1Target,
  environment: Readonly<Record<string, string>>,
  run: IntegrationStorageGenerationProcess,
  options: IntegrationStorageGenerationOptions,
  sealed: ReturnType<typeof sealDirectory>,
  expectedMigrations: readonly string[],
): Promise<{ readonly state: D1SchemaState }> {
  sealed.assertUnchanged();
  let result: CommandResult;
  try {
    result = await run(
      (options.wranglerCommand ?? wranglerCommand)([
        "d1",
        "execute",
        databaseName,
        "--remote",
        "--yes",
        "--config",
        configPath,
        "--file",
        importPath,
      ]),
      { env: environment },
    );
  } catch {
    throw migrationFailureError(
      "D1 migration apply acknowledgement is indeterminate; inspect this exact generation " +
        "and do not retry",
      null,
      null,
      expectedMigrations,
    );
  }
  if (result.exitCode !== 0) {
    let aftermath: D1SchemaState | null = null;
    try {
      aftermath = await readGeneratedState(
        "mutation",
        configPath,
        target,
        environment,
        run,
        options,
      );
    } catch {
      // A failed readback is itself indeterminate. Do not turn it into a
      // second migration attempt or infer a new database from the name.
    }
    throw migrationFailureError(
      "D1 migration apply failed; partial or lost acknowledgement is not retried or adopted",
      result.exitCode,
      aftermath?.applied ?? null,
      expectedMigrations,
    );
  }
  const state = await readGeneratedState(
    "verification",
    configPath,
    target,
    environment,
    run,
    options,
  ).catch(() => {
    throw verificationError(
      "D1 migration post-readback failed; R2 creation is withheld",
      `databaseId=${target.databaseId}`,
    );
  });
  return { state };
}

async function readGeneratedState(
  phase: DeployPhase,
  configPath: string,
  target: GeneratedD1Target,
  environment: Readonly<Record<string, string>>,
  run: IntegrationStorageGenerationProcess,
  options: IntegrationStorageGenerationOptions,
): Promise<D1SchemaState> {
  if (options.readD1State !== undefined) {
    return await options.readD1State(phase, {
      configPath,
      databaseName: target.databaseName,
      databaseId: target.databaseId,
      environment,
      run,
    });
  }
  if (options.reader !== undefined) return await options.reader.read(phase);
  return await readD1SchemaState(new RemoteD1(configPath, { environment, run }), phase);
}

function assertEmptyDatabase(state: D1SchemaState, databaseId: string): void {
  let applicationShape: string;
  try {
    applicationShape = assertCanonicalShape(state, databaseId);
  } catch {
    throw mutationError(
      "new D1 empty readback is not a canonical schema shape; migration is withheld",
      `databaseId=${databaseId}`,
    );
  }
  if (state.applied.length !== 0 || applicationShape !== "[]\n") {
    throw mutationError(
      "new D1 is not exactly empty; migration is withheld",
      JSON.stringify({
        databaseId,
        appliedMigrations: state.applied,
        schemaShapeDigest: state.shapeDigest,
      }),
    );
  }
  if (!SHA256.test(state.shapeDigest) || state.shapeDigest !== digestShape(state.shape)) {
    throw mutationError(
      "new D1 empty readback has an invalid schema digest",
      `databaseId=${databaseId}`,
    );
  }
}

function assertCompleteDatabase(
  state: D1SchemaState,
  expectedMigrations: readonly string[],
  migrationDigest: string,
  expectedApplicationShape: string,
  databaseId: string,
): void {
  if (JSON.stringify(state.applied) !== JSON.stringify(expectedMigrations)) {
    throw verificationError(
      "D1 migration readback does not contain the exact audited 0001-0057 lineage; " +
        "R2 creation is withheld",
      JSON.stringify({ databaseId, expectedMigrations, appliedMigrations: state.applied }),
    );
  }
  if (
    !SHA256.test(migrationDigest) ||
    !SHA256.test(state.shapeDigest) ||
    state.shapeDigest !== digestShape(state.shape)
  ) {
    throw verificationError(
      "D1 migration readback has an invalid canonical schema digest; R2 creation is withheld",
      `databaseId=${databaseId}`,
    );
  }
  const applicationShape = assertCanonicalShape(state, databaseId);
  if (applicationShape !== expectedApplicationShape) {
    throw verificationError(
      "D1 migration readback differs from the exact audited application schema; " +
        "R2 creation is withheld",
      `databaseId=${databaseId}`,
    );
  }
}

function assertCanonicalShape(state: D1SchemaState, databaseId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.shape);
  } catch {
    throw verificationError(
      "D1 migration readback is not a canonical schema shape; R2 creation is withheld",
      `databaseId=${databaseId}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw verificationError(
      "D1 migration readback is not a canonical schema shape; R2 creation is withheld",
      `databaseId=${databaseId}`,
    );
  }
  const rows = parsed.map((entry) => {
    if (!isRecord(entry)) {
      throw verificationError(
        "D1 migration readback contains a malformed canonical schema row; R2 creation is withheld",
        `databaseId=${databaseId}`,
      );
    }
    const keys = Object.keys(entry).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["name", "sql", "table", "type"])) {
      throw verificationError(
        "D1 migration readback contains an unexpected canonical schema row; " +
          "R2 creation is withheld",
        `databaseId=${databaseId}`,
      );
    }
    if (
      typeof entry.type !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.table !== "string" ||
      typeof entry.sql !== "string"
    ) {
      throw verificationError(
        "D1 migration readback contains a malformed canonical schema row; R2 creation is withheld",
        `databaseId=${databaseId}`,
      );
    }
    return {
      type: entry.type,
      name: entry.name,
      tbl_name: entry.table,
      sql: entry.sql,
    };
  });
  try {
    if (canonicalSchemaShape(rows) !== state.shape) {
      throw new Error("noncanonical");
    }
  } catch {
    throw verificationError(
      "D1 migration readback is not canonically ordered; R2 creation is withheld",
      `databaseId=${databaseId}`,
    );
  }
  return canonicalSchemaShape(rows.filter((row) => !isPlatformSchemaMetadata(row)));
}

function isPlatformSchemaMetadata(row: Record<string, unknown>): boolean {
  return (
    row.name === "d1_migrations" ||
    row.tbl_name === "d1_migrations" ||
    row.name === "_cf_KV" ||
    row.tbl_name === "_cf_KV"
  );
}

function digestShape(shape: string): string {
  return `sha256:${createHash("sha256").update(shape).digest("hex")}`;
}

function writeGenerationConfig(
  path: string,
  accountId: string,
  databaseName: string,
  databaseId: string,
): string {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        name: "takoserver-integration-storage-generation",
        account_id: accountId,
        compatibility_date: "2026-08-17",
        d1_databases: [
          {
            binding: "STATE_DB",
            database_name: databaseName,
            database_id: databaseId,
            migrations_dir: "payload/migrations",
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

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

async function providerCall<T>(
  phase: DeployPhase,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new DeployError(phase, message);
  }
}

function migrationFailureError(
  message: string,
  exitCode: number | null,
  appliedMigrations: readonly string[] | null,
  expectedMigrations: readonly string[],
): MigrationApplyError {
  return new MigrationApplyError(message, {
    exitCode: safeExitCode(exitCode),
    appliedMigrations: safeAppliedMigrations(appliedMigrations, expectedMigrations),
    expectedMigrations: expectedMigrations.slice(0, MAX_MIGRATION_DIAGNOSTIC_NAMES),
  });
}

function safeExitCode(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= -128 && value <= 255
    ? value
    : null;
}

function safeAppliedMigrations(
  appliedMigrations: readonly string[] | null,
  expectedMigrations: readonly string[],
): readonly string[] | null {
  if (
    appliedMigrations === null ||
    !Array.isArray(appliedMigrations) ||
    appliedMigrations.length > expectedMigrations.length ||
    appliedMigrations.length > MAX_MIGRATION_DIAGNOSTIC_NAMES ||
    appliedMigrations.some((name) => typeof name !== "string")
  ) {
    return null;
  }
  for (let index = 0; index < appliedMigrations.length; index += 1) {
    if (appliedMigrations[index] !== expectedMigrations[index]) return null;
  }
  return appliedMigrations.slice();
}

function normalizeAfterD1Create(error: unknown, databaseId: string | null): DeployError {
  const phase: DeployPhase =
    error instanceof DeployError && error.phase === "verification" ? "verification" : "mutation";
  const evidence = error instanceof MigrationApplyError ? error.evidence : undefined;
  const detail =
    evidence === undefined
      ? `databaseId=${databaseId ?? "unknown"}`
      : [
          `databaseId=${databaseId ?? "unknown"}`,
          `phase=${phase}`,
          `exitCode=${evidence.exitCode ?? "unknown"}`,
          `appliedMigrations=${JSON.stringify(evidence.appliedMigrations)}`,
          `expectedMigrations=${JSON.stringify(evidence.expectedMigrations)}`,
        ].join(" ");
  if (error instanceof DeployError) {
    return new DeployError(phase, error.message, detail);
  }
  return new DeployError(
    "mutation",
    "integration storage generation stopped after D1 creation; do not retry or adopt",
    detail,
  );
}

async function readInventory(
  provider: IntegrationStorageGenerationProvider,
  names: StorageNames,
  phase: DeployPhase,
): Promise<{
  readonly d1: readonly IntegrationStorageD1Database[];
  readonly r2: readonly IntegrationStorageR2Bucket[];
}> {
  const d1 = await providerCall(phase, "D1 generated-name inventory failed", () =>
    provider.listD1(names.databaseName),
  );
  const r2 = await providerCall(phase, "R2 generated-name inventory failed", () =>
    provider.listR2(names.bucketName),
  );
  let d1Exact: readonly IntegrationStorageD1Database[];
  let r2Exact: readonly IntegrationStorageR2Bucket[];
  try {
    d1Exact = d1.map((entry) => validateD1Summary(entry, "D1 generated-name inventory"));
    r2Exact = r2.map((entry) => validateR2Summary(entry, "R2 generated-name inventory"));
  } catch {
    throw new DeployError(phase, "generated storage inventory returned a malformed identity");
  }
  const d1Matches = d1Exact.filter((entry) => entry.name === names.databaseName);
  const r2Matches = r2Exact.filter((entry) => entry.name === names.bucketName);
  if (d1Matches.length > 1 || r2Matches.length > 1) {
    throw new DeployError(phase, "generated storage inventory contains duplicate exact names");
  }
  return { d1: d1Matches, r2: r2Matches };
}

async function readR2Presence(
  provider: IntegrationStorageGenerationProvider,
  bucketName: string,
  phase: DeployPhase,
): Promise<readonly IntegrationStorageR2Bucket[]> {
  const entries = await providerCall(phase, "R2 generated-name absence fence failed", () =>
    provider.listR2(bucketName),
  );
  let parsed: readonly IntegrationStorageR2Bucket[];
  try {
    parsed = entries.map((entry) => validateR2Summary(entry, "R2 generated-name inventory"));
  } catch {
    throw new DeployError(phase, "R2 generated-name inventory returned a malformed identity");
  }
  const matches = parsed.filter((entry) => entry.name === bucketName);
  if (matches.length > 1) {
    throw new DeployError(phase, "R2 generated-name inventory contains duplicate exact names");
  }
  return matches;
}

function assertAbsent(
  inventory: {
    readonly d1: readonly IntegrationStorageD1Database[];
    readonly r2: readonly IntegrationStorageR2Bucket[];
  },
  label: string,
): void {
  if (inventory.d1.length !== 0 || inventory.r2.length !== 0) {
    throw preflightError(
      `${label} is not empty; existing storage is never adopted`,
      JSON.stringify({
        d1: inventory.d1.map(({ name, uuid }) => ({ name, uuid })),
        r2: inventory.r2.map(({ name }) => ({ name })),
      }),
    );
  }
}

function validateCreatedD1(value: IntegrationStorageD1Database, expectedName: string): string {
  let parsed: IntegrationStorageD1Database;
  try {
    parsed = validateD1Summary(value, "new D1 create response");
  } catch {
    throw mutationError("new D1 create returned a malformed identity; do not retry or adopt");
  }
  if (parsed.name !== expectedName) {
    throw mutationError(
      "new D1 create returned an unexpected name; do not retry or adopt",
      `databaseId=${parsed.uuid}`,
    );
  }
  return parsed.uuid;
}

function validateCreatedR2(
  value: IntegrationStorageR2Bucket,
  expectedName: string,
  databaseId: string,
): void {
  let parsed: IntegrationStorageR2Bucket;
  try {
    parsed = validateR2Summary(value, "new R2 create response");
  } catch {
    throw mutationError(
      "new R2 create returned a malformed identity; do not retry or adopt",
      `databaseId=${databaseId}`,
    );
  }
  if (parsed.name !== expectedName) {
    throw mutationError(
      "new R2 create returned an unexpected name; do not retry or adopt",
      `databaseId=${databaseId} bucketName=${parsed.name}`,
    );
  }
}

function validateD1Summary(
  value: IntegrationStorageD1Database,
  label: string,
): IntegrationStorageD1Database {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !RESOURCE_NAME.test(value.name) ||
    typeof value.uuid !== "string" ||
    !UUID.test(value.uuid)
  ) {
    throw preflightError(`${label} returned a malformed D1 identity`);
  }
  return { name: value.name, uuid: value.uuid };
}

function validateR2Summary(
  value: IntegrationStorageR2Bucket,
  label: string,
): IntegrationStorageR2Bucket {
  if (!isRecord(value) || typeof value.name !== "string" || !RESOURCE_NAME.test(value.name)) {
    throw preflightError(`${label} returned a malformed R2 identity`);
  }
  return { name: value.name };
}

/** Direct Cloudflare API adapter kept local to this one-way surface. */
export class CloudflareIntegrationStorageProvider implements IntegrationStorageGenerationProvider {
  readonly #accountId: string;
  readonly #token: string;
  readonly #fetcher: IntegrationStorageFetcher;

  constructor(
    accountId: string,
    token: string,
    options: { readonly fetcher?: IntegrationStorageFetcher } = {},
  ) {
    if (!ACCOUNT_ID.test(accountId)) {
      throw preflightError("Cloudflare storage requires one account id");
    }
    if (token.length === 0 || token.trim() !== token) {
      throw preflightError("Cloudflare storage requires one exact API token");
    }
    this.#accountId = accountId;
    this.#token = token;
    this.#fetcher = options.fetcher ?? ((request) => fetch(request));
  }

  async listD1(name: string): Promise<readonly IntegrationStorageD1Database[]> {
    const values: IntegrationStorageD1Database[] = [];
    let page = 1;
    for (;;) {
      if (page > MAX_D1_LIST_PAGES) {
        throw new StorageProviderError("D1 inventory exceeded the pagination safety bound");
      }
      const url = this.url("/d1/database");
      url.searchParams.set("name", name);
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", "100");
      const envelope = await this.envelope(url, "D1 generated-name inventory");
      if (!Array.isArray(envelope.result)) {
        throw new StorageProviderError("D1 generated-name inventory returned a non-list result");
      }
      const entries = envelope.result.map((entry) => parseD1ApiSummary(entry));
      values.push(...entries);
      if (envelope.result_info === undefined) {
        if (page !== 1 || entries.length === 100) {
          throw new StorageProviderError("D1 inventory omitted pagination metadata");
        }
        break;
      }
      const info = parseD1Pagination(envelope.result_info);
      if (info.page !== page || info.perPage !== 100 || info.count !== entries.length) {
        throw new StorageProviderError("D1 inventory returned inconsistent pagination");
      }
      // Cloudflare documents total_count as the account-wide total when no
      // search parameters are supplied.  It is not a terminal count for the
      // name-filtered query, so use the requested page size and a bounded
      // short-page/empty-page closure instead of adopting that global number.
      if (entries.length < info.perPage) break;
      page += 1;
    }
    return values;
  }

  async getD1(databaseId: string): Promise<IntegrationStorageD1Database> {
    if (!UUID.test(databaseId)) throw new StorageProviderError("D1 identity is invalid");
    const url = this.url(`/d1/database/${encodeURIComponent(databaseId)}`);
    const envelope = await this.envelope(url, "D1 identity readback");
    return parseD1ApiSummary(envelope.result);
  }

  async createD1(name: string): Promise<IntegrationStorageD1Database> {
    const url = this.url("/d1/database");
    const envelope = await this.envelope(url, "D1 create", "POST", { name });
    return parseD1ApiSummary(envelope.result);
  }

  async listR2(name: string): Promise<readonly IntegrationStorageR2Bucket[]> {
    const values: IntegrationStorageR2Bucket[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 1; ; page += 1) {
      if (page > MAX_R2_LIST_PAGES) {
        throw new StorageProviderError("R2 inventory exceeded the pagination safety bound");
      }
      const url = this.url("/r2/buckets");
      url.searchParams.set("name_contains", name);
      url.searchParams.set("per_page", String(R2_LIST_PAGE_SIZE));
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      const envelope = await this.envelope(url, "R2 generated-name inventory");
      if (!isRecord(envelope.result) || !Array.isArray(envelope.result.buckets)) {
        throw new StorageProviderError("R2 generated-name inventory returned a malformed result");
      }
      if (envelope.result.buckets.length > R2_LIST_PAGE_SIZE) {
        throw new StorageProviderError("R2 inventory exceeded the requested page size");
      }
      values.push(...envelope.result.buckets.map((entry) => parseR2ApiSummary(entry)));
      const next = parseR2Cursor(envelope.result_info, envelope.result.buckets.length);
      if (next === null) break;
      if (seenCursors.has(next)) throw new StorageProviderError("R2 inventory cursor repeated");
      seenCursors.add(next);
      cursor = next;
    }
    return values;
  }

  async getR2(name: string): Promise<IntegrationStorageR2Bucket> {
    const url = this.url(`/r2/buckets/${encodeURIComponent(name)}`);
    const envelope = await this.envelope(url, "R2 identity readback");
    return parseR2ApiSummary(envelope.result);
  }

  async createR2(name: string): Promise<IntegrationStorageR2Bucket> {
    const url = this.url("/r2/buckets");
    const envelope = await this.envelope(url, "R2 create", "POST", { name });
    return parseR2ApiSummary(envelope.result);
  }

  private url(path: string): URL {
    return new URL(`${CLOUDFLARE_API}/accounts/${encodeURIComponent(this.#accountId)}${path}`);
  }

  private async envelope(
    url: URL,
    label: string,
    method: "GET" | "POST" = "GET",
    body?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetcher(
        new Request(url, {
          method,
          redirect: "error",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.#token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000),
        }),
      );
    } catch {
      throw new StorageProviderError(`${label} transport failed`);
    }
    const text = await boundedResponseText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StorageProviderError(`${label} returned malformed JSON`);
    }
    if (
      !response.ok ||
      !isRecord(parsed) ||
      parsed.success !== true ||
      !Object.hasOwn(parsed, "result")
    ) {
      throw new StorageProviderError(`${label} failed (HTTP ${response.status})`);
    }
    return parsed;
  }
}

class StorageProviderError extends Error {}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new StorageProviderError("Cloudflare response exceeded the safety bound");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new StorageProviderError("Cloudflare response exceeded the safety bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseD1ApiSummary(value: unknown): IntegrationStorageD1Database {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !RESOURCE_NAME.test(value.name) ||
    typeof value.uuid !== "string" ||
    !UUID.test(value.uuid)
  ) {
    throw new StorageProviderError("Cloudflare D1 response contained a malformed identity");
  }
  return { name: value.name, uuid: value.uuid };
}

function parseR2ApiSummary(value: unknown): IntegrationStorageR2Bucket {
  if (!isRecord(value) || typeof value.name !== "string" || !RESOURCE_NAME.test(value.name)) {
    throw new StorageProviderError("Cloudflare R2 response contained a malformed identity");
  }
  return { name: value.name };
}

function parseD1Pagination(value: unknown): {
  readonly page: number;
  readonly perPage: number;
  readonly count: number;
  readonly totalCount: number;
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.page) ||
    !Number.isSafeInteger(value.per_page) ||
    !Number.isSafeInteger(value.count) ||
    !Number.isSafeInteger(value.total_count) ||
    Number(value.page) < 1 ||
    Number(value.per_page) < 1 ||
    Number(value.count) < 0 ||
    Number(value.total_count) < 0
  ) {
    throw new StorageProviderError("Cloudflare D1 pagination metadata is malformed");
  }
  return {
    page: Number(value.page),
    perPage: Number(value.per_page),
    count: Number(value.count),
    totalCount: Number(value.total_count),
  };
}

function parseR2Cursor(value: unknown, count: number): string | null {
  if (value === undefined) {
    if (count >= R2_LIST_PAGE_SIZE) {
      throw new StorageProviderError(
        "R2 full page has no pagination metadata; absence is unproved",
      );
    }
    return null;
  }
  if (!isRecord(value)) {
    throw new StorageProviderError("Cloudflare R2 pagination metadata is malformed");
  }
  if (value.per_page !== undefined && value.per_page !== R2_LIST_PAGE_SIZE) {
    throw new StorageProviderError("Cloudflare R2 pagination page size differs from the request");
  }
  if (value.cursor === undefined || value.cursor === null) return null;
  if (typeof value.cursor !== "string" || value.cursor.length === 0) {
    throw new StorageProviderError("Cloudflare R2 pagination cursor is malformed");
  }
  return value.cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
