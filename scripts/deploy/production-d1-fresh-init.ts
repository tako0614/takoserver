import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deriveExpectedApplicationShape } from "./application-schema-shape.ts";
import { RemoteD1 } from "./d1.ts";
import { buildD1MigrationImport } from "./d1-migration-import.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  applySealedMigrations,
  assertCompleteDatabase,
  assertEmptyDatabase,
  CloudflareIntegrationStorageProvider,
  checkedMigrationGate,
  type GeneratedD1Target,
  type IntegrationStorageD1Database,
  type IntegrationStorageFetcher,
  type IntegrationStorageGeneratedStateOptions,
  type IntegrationStorageGenerationProcess,
  readGeneratedState,
} from "./integration-storage-generation.ts";
import type { D1SchemaState } from "./migrations.ts";
import {
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type FreshD1AttemptBinding,
  type FreshD1Custody,
  openFreshD1Custody,
} from "./production-d1-fresh-init-custody.ts";
import {
  type DeployEnvironment,
  qualifySource,
  sealDirectory,
  unsealDirectory,
} from "./qualification.ts";
import {
  projectFreshProductionMigrationArtifact,
  projectFreshProductionV2MigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
  readSealedFreshProductionMigrationArtifact,
  readSealedFreshProductionV2MigrationArtifact,
} from "./schema.ts";
import type { DeployTarget } from "./target.ts";
import { acquireWranglerVersionPublicationLease } from "./wrangler-state.ts";

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const GENERATION = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAX_REVIEWER_LENGTH = 256;
/**
 * Fresh production storage is never the incumbent name and never a human
 * description. The generation keeps one fresh identity per attempt inside the
 * same lowercase provider-name alphabet as every other generated resource
 * here (compare `takoserver-i-<generation>`).
 */
export const PRODUCTION_FRESH_D1_PREFIX = "takoserver-p-";
export const PRODUCTION_D1_FRESH_INIT_SURFACE = "takoserver-production-d1-fresh-init";

export interface ProductionD1FreshInitInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly generation: string;
  readonly freshLineage?: "v2-0088";
}

export interface FreshV2DataReadback {
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly ledgerRows: number;
  readonly foreignKeyViolations: number;
  readonly invocationEpoch: readonly Record<string, unknown>[];
  readonly acceptanceCounter: readonly Record<string, unknown>[];
}

const FRESH_V2_SEED_TABLES = [
  "tf_cloudflare_provider_invocation_epoch",
  "tf_v2_operation_acceptance_counter",
] as const;

/**
 * The only provider capability this surface needs. It deliberately has no
 * delete, update, binding, Worker, route, namespace, R2 or target operation:
 * the replaced database is never read, adopted, reset, archived or deleted
 * here.
 */
export interface ProductionD1FreshInitProvider {
  listD1(name: string): Promise<readonly IntegrationStorageD1Database[]>;
  getD1(databaseId: string): Promise<IntegrationStorageD1Database>;
  createD1(name: string): Promise<IntegrationStorageD1Database>;
}

export interface ProductionD1FreshInitOptions extends IntegrationStorageGeneratedStateOptions {
  readonly run?: IntegrationStorageGenerationProcess;
  readonly review?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly outputDirectory?: string;
  /** Test seam; the real operator supplies the required preexisting private directory. */
  readonly custodyDirectory?: string;
  /** Test-only source seam; production callers use the repository migrations. */
  readonly migrationDirectory?: string;
  /** Narrow provider seam used by tests and local contract simulations. */
  readonly provider?: ProductionD1FreshInitProvider;
  readonly fetcher?: IntegrationStorageFetcher;
  /** Test seam; the CLI always uses authoritative remote D1 queries. */
  readonly freshV2DataReader?: {
    read(phase: "preflight" | "verification", configPath: string): Promise<FreshV2DataReadback>;
  };
}

interface FreshD1Names {
  readonly databaseName: string;
}

interface IncumbentProductionD1 {
  readonly databaseName: string;
  readonly databaseId: string;
  readonly treatment: string;
}

/**
 * Creates one brand-new empty **production** D1 and applies the complete
 * audited local `0001-0069` lineage to it, in one reviewed command.
 *
 * The protected 0023+ wave lane exists to move one production-shaped durable
 * predecessor forward; it can never invent the durable state a brand-new
 * database starts from, and the rehearsal and integration storage owners
 * deliberately refuse production. This surface fills exactly that gap, so the
 * operator can choose between a wave-by-wave transition and a fresh start at
 * the separately reviewed 0069 payload without reaching for ad-hoc provider commands.
 *
 * `--status` is the dry run: it proves exact name absence through the provider
 * and prints the planned identity plus the audited lineage digest, and it
 * never calls a mutating provider operation. `--apply` additionally requires
 * the explicit production target descriptor, a clean production source commit
 * and TAKOSERVER_INDEPENDENT_REVIEW. Repointing the deploy target at the
 * returned identity and archiving the replaced database are separate operator
 * steps.
 */
export async function runProductionD1FreshInit(
  invocation: ProductionD1FreshInitInvocation,
  target: DeployTarget,
  options: ProductionD1FreshInitOptions = {},
): Promise<Record<string, unknown>> {
  const names = validateInvocation(invocation, target);
  const auditedSource = readCurrentAuditedMigrationSourceArtifact(
    options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
  );
  const sourceArtifact =
    invocation.freshLineage === "v2-0088"
      ? projectFreshProductionV2MigrationArtifact(auditedSource)
      : projectFreshProductionMigrationArtifact(auditedSource);
  const expectedApplicationShape = deriveExpectedApplicationShape(sourceArtifact.files);
  const expectedApplicationShapeDigest = `sha256:${createHash("sha256")
    .update(expectedApplicationShape)
    .digest("hex")}`;
  const sourceImport = buildD1MigrationImport(sourceArtifact.files, { freshLedger: true });
  const custody = openFreshD1Custody(
    options.custodyDirectory ?? requireEnvironment("TAKOSERVER_D1_FRESH_INIT_CUSTODY_DIRECTORY"),
    target.accountId,
    invocation.generation,
  );
  const binding: FreshD1AttemptBinding = {
    ...(invocation.freshLineage === undefined ? {} : { freshLineage: invocation.freshLineage }),
    accountId: target.accountId,
    generation: invocation.generation,
    databaseName: names.databaseName,
    incumbentDatabaseName: target.d1.databaseName,
    incumbentDatabaseId: target.d1.databaseId,
    incumbentBucketName: target.r2.bucketName,
    workerName: target.workerName,
    sourceCommit: invocation.commit,
    migrationDigest: sourceArtifact.digest,
    migrationBytes: sourceArtifact.bytes,
    importDigest: sourceImport.digest,
    importBytes: sourceImport.bytes,
    applicationShapeDigest: expectedApplicationShapeDigest,
  };
  const incumbent: IncumbentProductionD1 = {
    databaseName: target.d1.databaseName,
    databaseId: target.d1.databaseId,
    treatment: "retained and untouched; archiving it is a separate operator decision",
  };

  if (invocation.action === "status") {
    const { provider, environment } = await resolveProvider(target, options);
    const observed = await inspectFreshD1Attempt({
      provider,
      environment,
      names,
      target,
      sourceArtifact,
      expectedApplicationShape,
      options,
      custody,
      binding,
      ...(invocation.freshLineage === undefined ? {} : { freshLineage: invocation.freshLineage }),
    });
    return {
      kind: "takoserver.production-d1-fresh-init-status@v1",
      surface: PRODUCTION_D1_FRESH_INIT_SURFACE,
      environment: "production",
      selectedCommit: invocation.commit,
      ...(invocation.freshLineage === undefined ? {} : { freshLineage: invocation.freshLineage }),
      generation: invocation.generation,
      d1: {
        databaseName: names.databaseName,
        databaseId: observed.databaseId,
        present: observed.present,
      },
      incumbent,
      migrationDigest: sourceArtifact.digest,
      migrationBytes: sourceArtifact.bytes,
      migrationCount: sourceArtifact.names.length,
      throughMigration: sourceArtifact.names[sourceArtifact.names.length - 1] ?? null,
      expectedApplicationShapeDigest,
      readyForApply: observed.readyForApply,
      attemptState: observed.attemptState,
      adoption: "an existing D1 is never adopted, reset or re-migrated by this surface",
      targetBinding: "this surface never writes the deploy target; repointing is operator-owned",
    };
  }

  if (custody.read(binding) !== null) {
    throw preflightError(
      "fresh D1 generation has a retained attempt; use status, never redispatch",
    );
  }

  return await applyFreshProductionD1(
    invocation,
    target,
    names,
    sourceArtifact,
    expectedApplicationShape,
    expectedApplicationShapeDigest,
    incumbent,
    custody,
    binding,
    options,
  );
}

interface FreshAttemptObservation {
  readonly databaseId: string | null;
  readonly present: boolean;
  readonly readyForApply: boolean;
  readonly attemptState: "absent" | "pending" | "identified" | "complete";
}

/** Reopen custody and provider state only; this never creates or imports a D1. */
async function inspectFreshD1Attempt(input: {
  readonly provider: ProductionD1FreshInitProvider;
  readonly environment: Readonly<Record<string, string>>;
  readonly names: FreshD1Names;
  readonly target: DeployTarget;
  readonly sourceArtifact: ReturnType<typeof readCurrentAuditedMigrationSourceArtifact>;
  readonly expectedApplicationShape: string;
  readonly options: ProductionD1FreshInitOptions;
  readonly custody: FreshD1Custody;
  readonly binding: FreshD1AttemptBinding;
  readonly freshLineage?: "v2-0088";
}): Promise<FreshAttemptObservation> {
  const attempt = input.custody.read(input.binding);
  const inventory = await readInventory(input.provider, input.names, "preflight");
  input.custody.assertContinuity();
  const present = inventory[0] ?? null;
  if (attempt === null) {
    return {
      databaseId: present?.uuid ?? null,
      present: present !== null,
      readyForApply: present === null,
      attemptState: "absent",
    };
  }
  const base = {
    databaseId: present?.uuid ?? null,
    present: present !== null,
    readyForApply: false,
  };
  if (present === null || attempt.identified === null) {
    return { ...base, attemptState: "pending" };
  }
  if (present.uuid !== attempt.identified.databaseId) {
    throw mutationError("fresh D1 attempt observed a different database identity; retain custody");
  }
  const readback = await providerCall(
    "preflight",
    "fresh D1 attempt identity readback failed",
    () => input.provider.getD1(present.uuid),
  );
  input.custody.assertContinuity();
  let exactReadback: IntegrationStorageD1Database;
  try {
    exactReadback = validateD1Summary(readback, "fresh D1 attempt identity readback");
  } catch {
    throw mutationError("fresh D1 attempt identity readback is malformed; retain custody");
  }
  if (exactReadback.uuid !== present.uuid || exactReadback.name !== input.names.databaseName) {
    throw mutationError("fresh D1 attempt identity readback changed; retain custody");
  }
  if (attempt.importDispatched === null) {
    return { ...base, attemptState: "identified" };
  }
  const directory = mkdtempSync(join(tmpdir(), "takoserver-fresh-d1-readback-"));
  try {
    const configPath = join(directory, "wrangler.jsonc");
    mkdirSync(join(directory, "payload", "migrations"), { recursive: true, mode: 0o700 });
    const generatedTarget: GeneratedD1Target = {
      accountId: input.target.accountId,
      databaseName: input.names.databaseName,
      databaseId: present.uuid,
    };
    writeFreshInitConfig(
      configPath,
      generatedTarget.accountId,
      generatedTarget.databaseName,
      generatedTarget.databaseId,
    );
    try {
      const state = await readGeneratedState(
        "preflight",
        configPath,
        generatedTarget,
        input.environment,
        input.options.run ?? runCommand,
        input.options,
      );
      input.custody.assertContinuity();
      assertCompleteDatabase(
        state,
        input.sourceArtifact.names,
        input.sourceArtifact.digest,
        input.expectedApplicationShape,
        present.uuid,
        "preflight",
      );
      if (input.freshLineage === "v2-0088") {
        await assertFreshV2DataReadback(
          "preflight",
          configPath,
          input.environment,
          input.expectedApplicationShape,
          input.options,
        );
      }
      return { ...base, attemptState: "complete" };
    } catch {
      return { ...base, attemptState: "pending" };
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validateInvocation(
  invocation: ProductionD1FreshInitInvocation,
  target: DeployTarget,
): FreshD1Names {
  if (invocation.action !== "status" && invocation.action !== "apply") {
    throw preflightError("production D1 fresh init requires --status or --apply");
  }
  if (invocation.environment !== "production" || target.environment !== "production") {
    throw preflightError("production D1 fresh init is production-only");
  }
  if (!COMMIT.test(invocation.commit)) {
    throw preflightError("production D1 fresh init requires one exact lowercase 40-hex commit");
  }
  if (!GENERATION.test(invocation.generation)) {
    throw preflightError("--generation must be exactly 32 lowercase hexadecimal characters");
  }
  if (invocation.freshLineage !== undefined && invocation.freshLineage !== "v2-0088") {
    throw preflightError("unsupported fresh production migration lineage");
  }
  if (!ACCOUNT_ID.test(target.accountId)) {
    throw preflightError("production D1 fresh init requires one exact account id");
  }
  if (!UUID.test(target.d1.databaseId) || !RESOURCE_NAME.test(target.d1.databaseName)) {
    throw preflightError(
      "production D1 fresh init requires one exact incumbent production D1 identity",
    );
  }
  const databaseName = `${PRODUCTION_FRESH_D1_PREFIX}${invocation.generation}`;
  if (!RESOURCE_NAME.test(databaseName)) {
    throw preflightError("production D1 fresh init derived an invalid provider name");
  }
  if (databaseName === target.d1.databaseName) {
    throw preflightError(
      "fresh production D1 name collides with the incumbent target database; " +
        "current durable storage is never adopted or re-initialised",
    );
  }
  if (databaseName === target.r2.bucketName) {
    throw preflightError("fresh production D1 name collides with the incumbent object bucket name");
  }
  return { databaseName };
}

interface ProviderContext {
  readonly provider: ProductionD1FreshInitProvider;
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * Resolve one production credential and the child environment that carries it
 * to the single Wrangler migration import.
 *
 * `resolveCloudflareCredential` is the shared owner of this rule: only
 * integration may fall back to Wrangler's stored OAuth profile, so production
 * refuses an absent or malformed explicit token during preflight, before any
 * provider access.
 */
async function resolveProvider(
  target: DeployTarget,
  options: ProductionD1FreshInitOptions,
): Promise<ProviderContext> {
  if (options.provider !== undefined) {
    return {
      provider: options.provider,
      environment: options.cloudflareEnvironment ?? {},
    };
  }
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("production", {
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

async function applyFreshProductionD1(
  invocation: ProductionD1FreshInitInvocation,
  target: DeployTarget,
  names: FreshD1Names,
  sourceArtifact: ReturnType<typeof readCurrentAuditedMigrationSourceArtifact>,
  expectedApplicationShape: string,
  expectedApplicationShapeDigest: string,
  incumbent: IncumbentProductionD1,
  custody: FreshD1Custody,
  binding: FreshD1AttemptBinding,
  options: ProductionD1FreshInitOptions,
): Promise<Record<string, unknown>> {
  const run = options.run ?? runCommand;
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  // Production policy: clean worktree plus an exact commit reachable from a
  // freshly fetched remote ref (or clean main equal to freshly fetched
  // origin/main). A dirty worktree never reaches a provider operation.
  const source = await qualifySource({
    environment: "production",
    commit: invocation.commit,
    run,
  });
  await checkedMigrationGate(run);

  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-production-d1-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = join(root, "release");
  if (existsSync(release)) {
    throw preflightError("production D1 fresh init output directory is already in use");
  }
  const payload = join(release, "payload");
  const migrationOutput = join(payload, "migrations");
  mkdirSync(migrationOutput, { recursive: true, mode: 0o700 });
  let sealed: ReturnType<typeof sealDirectory> | null = null;
  let migrationSeal: ReturnType<typeof sealDirectory> | null = null;
  let lease: Awaited<ReturnType<typeof acquireWranglerVersionPublicationLease>> | null = null;
  let mutationStarted = false;
  let knownDatabaseId: string | null = null;
  let result: Record<string, unknown> | undefined;
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    for (const file of sourceArtifact.files) {
      copyFileSync(file.path, join(migrationOutput, file.name));
    }
    const sealedArtifact =
      invocation.freshLineage === "v2-0088"
        ? readSealedFreshProductionV2MigrationArtifact(migrationOutput)
        : readSealedFreshProductionMigrationArtifact(migrationOutput);
    if (
      sealedArtifact.digest !== sourceArtifact.digest ||
      JSON.stringify(sealedArtifact.names) !== JSON.stringify(sourceArtifact.names)
    ) {
      throw preflightError("sealed production migration lineage differs from the qualified source");
    }
    // The frozen 0047 trigger body defeats D1 /query parsing, so the exact
    // migration bytes travel through the /import transport, unchanged.
    const migrationImport = buildD1MigrationImport(sealedArtifact.files, { freshLedger: true });
    if (
      migrationImport.digest !== binding.importDigest ||
      migrationImport.bytes !== binding.importBytes
    ) {
      throw preflightError("sealed fresh D1 import differs from the bound source");
    }
    const importPath = join(payload, "migration-import.sql");
    writeFileSync(importPath, migrationImport.sql, { mode: 0o600, flag: "wx" });
    migrationSeal = sealDirectory(payload, [
      "migration-import.sql",
      ...sourceArtifact.names.map((name) => `migrations/${name}`),
    ]);
    const configPath = join(release, "wrangler.jsonc");

    const { provider, environment: providerEnvironment } = await resolveProvider(target, options);
    lease = await acquireWranglerVersionPublicationLease({
      accountId: target.accountId,
      workerName: names.databaseName,
      root: custody.root,
      createRoot: false,
    });
    custody.assertContinuity();
    if (custody.read(binding) !== null) {
      throw preflightError(
        "fresh D1 generation has a retained attempt; use status, never redispatch",
      );
    }
    const initial = await readInventory(provider, names, "preflight");
    assertAbsent(initial, "initial fresh production D1 name inventory");
    const fenced = await readInventory(provider, names, "preflight");
    assertAbsent(fenced, "immediate precreate fresh production D1 absence fence");
    migrationSeal.assertUnchanged();
    custody.persistIntent(binding);

    // Set before the provider boundary: a lost acknowledgement can mean
    // Cloudflare created the database even though no identity returned.
    mutationStarted = true;
    const created = await providerCall(
      "mutation",
      "new production D1 create failed; do not retry",
      () => provider.createD1(names.databaseName),
    );
    const databaseId = validateCreatedD1(created, names.databaseName);
    knownDatabaseId = databaseId;
    const createdReadback = await providerCall(
      "mutation",
      "new production D1 identity readback failed; do not retry",
      () => provider.getD1(databaseId),
    );
    if (createdReadback.uuid !== databaseId || createdReadback.name !== names.databaseName) {
      throw mutationError(
        "new production D1 identity readback did not match the exact generated name and id",
        `databaseId=${databaseId}`,
      );
    }
    custody.persistIdentified(binding, databaseId);
    // The first seal predates provider create. Never re-seal bytes that changed
    // while its acknowledgement or identity readback was outstanding.
    migrationSeal.assertUnchanged();

    const generatedTarget: GeneratedD1Target = {
      accountId: target.accountId,
      databaseName: names.databaseName,
      databaseId,
    };
    // The config is written only once the provider identity is known; the
    // migration payload has stayed sealed across the create/read fence.
    writeFreshInitConfig(
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
        providerEnvironment,
        run,
        options,
      );
    } catch {
      throw mutationError(
        "new production D1 empty readback failed; migration is withheld",
        `databaseId=${databaseId}`,
      );
    }
    assertEmptyDatabase(preMigration, databaseId);
    custody.persistImportDispatched(binding);

    const migration = await applySealedMigrations(
      configPath,
      names.databaseName,
      importPath,
      generatedTarget,
      providerEnvironment,
      run,
      options,
      sealed,
      sourceArtifact.names,
    );
    assertCompleteDatabase(
      migration.state,
      sourceArtifact.names,
      sourceArtifact.digest,
      expectedApplicationShape,
      databaseId,
    );
    if (invocation.freshLineage === "v2-0088") {
      await assertFreshV2DataReadback(
        "verification",
        configPath,
        providerEnvironment,
        expectedApplicationShape,
        options,
      );
    }

    const finalD1 = await providerCall(
      "verification",
      "new production D1 final identity readback failed",
      () => provider.getD1(databaseId),
    );
    if (finalD1.uuid !== databaseId || finalD1.name !== names.databaseName) {
      throw verificationError(
        "new production D1 final identity readback did not match the exact generated name and id",
        `databaseId=${databaseId}`,
      );
    }
    sealed.assertUnchanged();
    custody.persistComplete(binding);

    result = {
      kind: "takoserver.production-d1-fresh-init-apply@v1",
      surface: PRODUCTION_D1_FRESH_INIT_SURFACE,
      environment: "production",
      commit: source.commit,
      remoteRef: source.remoteRef,
      reviewer,
      generation: invocation.generation,
      ...(invocation.freshLineage === undefined ? {} : { freshLineage: invocation.freshLineage }),
      d1: { databaseName: names.databaseName, databaseId },
      incumbent,
      migrationDigest: sourceArtifact.digest,
      migrationBytes: sourceArtifact.bytes,
      migrationImportDigest: migrationImport.digest,
      migrationImportBytes: migrationImport.bytes,
      appliedMigrations: migration.state.applied,
      schemaShapeDigest: migration.state.shapeDigest,
      expectedApplicationShapeDigest,
      targetBinding: {
        status: "not-written",
        required: {
          "d1.databaseName": names.databaseName,
          "d1.databaseId": databaseId,
        },
        note: "author the successor target descriptor separately; this surface never writes it",
      },
      reversal:
        "the incumbent D1 and its R2 bucket are unchanged: discard the fresh database and keep " +
        "serving the incumbent, or repoint the target and archive the incumbent separately",
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
  try {
    if (lease !== null) await lease.release();
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure ??= error;
  }

  // Cleanup stays outside a finally block: an unwinding cleanup error must
  // never replace the operation own bounded failure.
  if (operationFailed) {
    if (!mutationStarted) throw operationFailure;
    throw normalizeAfterCreate(operationFailure, knownDatabaseId);
  }
  if (cleanupFailed) {
    if (mutationStarted) throw normalizeAfterCreate(cleanupFailure, knownDatabaseId);
    throw cleanupFailure;
  }
  if (result === undefined) {
    throw preflightError("production D1 fresh init produced no result");
  }
  return result;
}

/**
 * After the create boundary every failure is indeterminate and forward-only.
 * Bounded mutation/verification errors retain their phase. A preflight-tagged
 * local seal error after create cannot claim the target was untouched; it and
 * unknown errors become a bounded mutation failure.
 */
function normalizeAfterCreate(error: unknown, databaseId: string | null): DeployError {
  if (error instanceof DeployError && error.phase !== "preflight") return error;
  return mutationError(
    "production D1 fresh init stopped after the create boundary; do not retry or adopt",
    `databaseId=${databaseId ?? "unknown"}`,
  );
}

/** Data proof is in addition to the canonical schema/ledger readback, never a prefix heuristic. */
async function assertFreshV2DataReadback(
  phase: "preflight" | "verification",
  configPath: string,
  environment: Readonly<Record<string, string>>,
  expectedApplicationShape: string,
  options: ProductionD1FreshInitOptions,
): Promise<void> {
  const shape: unknown = JSON.parse(expectedApplicationShape);
  if (!Array.isArray(shape)) throw new DeployError(phase, "fresh v2 expected shape is malformed");
  const tables = shape
    .filter(
      (row): row is { type: string; name: string } =>
        typeof row === "object" &&
        row !== null &&
        row.type === "table" &&
        typeof row.name === "string",
    )
    .map(({ name }) => name);
  if (
    tables.length === 0 ||
    new Set(tables).size !== tables.length ||
    tables.some((name) => !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name))
  ) {
    throw new DeployError(phase, "fresh v2 audited table inventory is malformed");
  }
  const readback =
    options.freshV2DataReader === undefined
      ? await readRemoteFreshV2Data(configPath, environment, tables, phase, options)
      : await options.freshV2DataReader.read(phase, configPath);
  if (
    readback.ledgerRows !== 88 ||
    readback.foreignKeyViolations !== 0 ||
    Object.keys(readback.tableCounts).length !== tables.length ||
    FRESH_V2_SEED_TABLES.some((name) => !tables.includes(name)) ||
    tables.some(
      (name) =>
        readback.tableCounts[name] !==
        (FRESH_V2_SEED_TABLES.includes(name as (typeof FRESH_V2_SEED_TABLES)[number]) ? 1 : 0),
    ) ||
    !matchesFreshV2Seed(
      readback.invocationEpoch,
      ["closed_at_ms", "epoch_id", "opened_at_ms", "singleton", "state"],
      { singleton: 1, epoch_id: null, state: "closed", opened_at_ms: null, closed_at_ms: null },
    ) ||
    !matchesFreshV2Seed(readback.acceptanceCounter, ["id", "last_operation_id", "last_order"], {
      id: 1,
      last_order: 0,
      last_operation_id: null,
    })
  ) {
    throw new DeployError(phase, "fresh v2 D1 is not the exact empty 0088 database");
  }
}

function matchesFreshV2Seed(
  rows: readonly Record<string, unknown>[],
  expectedKeys: readonly string[],
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0];
  return (
    row !== undefined &&
    JSON.stringify(Object.keys(row).sort()) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => row[key] === expected[key])
  );
}

async function readRemoteFreshV2Data(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  tables: readonly string[],
  phase: "preflight" | "verification",
  options: ProductionD1FreshInitOptions,
): Promise<FreshV2DataReadback> {
  const database = new RemoteD1(configPath, {
    environment,
    run: options.run ?? runCommand,
    wranglerCommand:
      options.wranglerCommand ??
      (options.wranglerPath === undefined
        ? wranglerCommand
        : (args) => [options.wranglerPath as string, ...args]),
  });
  const tableCounts: Record<string, number> = {};
  for (let index = 0; index < tables.length; index += 16) {
    const batch = tables.slice(index, index + 16);
    const sql = `SELECT ${batch.map((name) => `(SELECT COUNT(*) FROM "${name}") AS "${name}"`).join(", ")}`;
    const rows = await database.query(phase, "fresh v2 application row counts", sql);
    if (rows.length !== 1 || Object.keys(rows[0] ?? {}).length !== batch.length) {
      throw new DeployError(phase, "fresh v2 application row counts are malformed");
    }
    for (const name of batch) {
      const value = rows[0]?.[name];
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new DeployError(phase, "fresh v2 application row count is malformed");
      }
      tableCounts[name] = value as number;
    }
  }
  const ledger = await database.query(
    phase,
    "fresh v2 migration ledger count",
    "SELECT COUNT(*) AS count FROM d1_migrations",
  );
  if (ledger.length !== 1 || !Number.isSafeInteger(ledger[0]?.count)) {
    throw new DeployError(phase, "fresh v2 migration ledger count is malformed");
  }
  const foreignKeys = await database.query(
    phase,
    "fresh v2 foreign-key integrity",
    "SELECT 1 AS violation FROM pragma_foreign_key_check LIMIT 1",
  );
  const invocationEpoch = await database.query(
    phase,
    "fresh v2 invocation epoch seed",
    "SELECT singleton, epoch_id, state, opened_at_ms, closed_at_ms FROM tf_cloudflare_provider_invocation_epoch LIMIT 2",
  );
  const acceptanceCounter = await database.query(
    phase,
    "fresh v2 acceptance counter seed",
    "SELECT id, last_order, last_operation_id FROM tf_v2_operation_acceptance_counter LIMIT 2",
  );
  return {
    tableCounts,
    ledgerRows: ledger[0]?.count as number,
    foreignKeyViolations: foreignKeys.length,
    invocationEpoch,
    acceptanceCounter,
  };
}

/**
 * Writes one local wrangler configuration for the fresh-init child process.
 * `name` is only a context label; the account, database name and database id
 * are the load-bearing identity.
 */
function writeFreshInitConfig(
  path: string,
  accountId: string,
  databaseName: string,
  databaseId: string,
): string {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        name: PRODUCTION_D1_FRESH_INIT_SURFACE,
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
  if (
    value.trim() !== value ||
    value.length < 1 ||
    value.length > MAX_REVIEWER_LENGTH ||
    value.includes("\n")
  ) {
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

async function readInventory(
  provider: ProductionD1FreshInitProvider,
  names: FreshD1Names,
  phase: DeployPhase,
): Promise<readonly IntegrationStorageD1Database[]> {
  const entries = await providerCall(phase, "D1 fresh-init name inventory failed", () =>
    provider.listD1(names.databaseName),
  );
  let parsed: readonly IntegrationStorageD1Database[];
  try {
    parsed = entries.map((entry) => validateD1Summary(entry, "D1 fresh-init name inventory"));
  } catch {
    throw new DeployError(phase, "D1 fresh-init name inventory returned a malformed identity");
  }
  const matches = parsed.filter((entry) => entry.name === names.databaseName);
  if (matches.length > 1) {
    throw new DeployError(phase, "D1 fresh-init name inventory contains duplicate exact names");
  }
  return matches;
}

function assertAbsent(inventory: readonly IntegrationStorageD1Database[], label: string): void {
  if (inventory.length !== 0) {
    throw preflightError(
      `${label} is not empty; existing storage is never adopted`,
      JSON.stringify(inventory.map(({ name, uuid }) => ({ name, uuid }))),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
