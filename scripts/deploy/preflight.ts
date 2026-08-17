import { RemoteD1, sqlLiteral } from "./d1.ts";
import { preflightError } from "./errors.ts";
import { assertPublishedIdentity, readLedger } from "./evidence.ts";
import { runChecked, wranglerCommand } from "./process.ts";
import { buildBundleDigest, migrationProvenance, resolvePushedCommit } from "./provenance.ts";
import { writeRealizedConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { servedVersionId } from "./worker-state.ts";

export const RUNTIME_TABLES = [
  "runtime_grant_keys",
  "runtime_grant_replays",
  "runtime_resources",
] as const;

/** Read-only description of the live target, taken before anything is mutated. */
export interface LiveState {
  readonly servedVersionId: string | null;
  readonly tables: readonly string[];
  readonly appliedMigrations: readonly string[];
  readonly activeGrantKeyIds: readonly string[];
}

export interface PreflightReport {
  readonly target: DeployTarget;
  readonly configPath: string;
  readonly commit: string;
  readonly branch: string;
  readonly remoteUrl: string;
  readonly bundleDigest: string;
  readonly bundleBytes: number;
  readonly migrationDigest: string;
  readonly migrationFiles: readonly string[];
  readonly live: LiveState;
  readonly alreadyCurrent: boolean;
}

/** Read-only inspection of the realized target. Safe to run at any time. */
export async function inspectLive(configPath: string, target: DeployTarget): Promise<LiveState> {
  const version = await servedVersionId(configPath);
  const database = new RemoteD1(configPath);

  const tableRows = await database.query(
    "preflight",
    "D1 table inventory",
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
  );
  const tables = tableRows
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");

  const appliedMigrations = tables.includes("d1_migrations")
    ? (
        await database.query(
          "preflight",
          "D1 migration lineage",
          "SELECT name FROM d1_migrations ORDER BY id",
        )
      )
        .map((row) => row.name)
        .filter((name): name is string => typeof name === "string")
    : [];

  const activeGrantKeyIds = tables.includes("runtime_grant_keys")
    ? (
        await database.query(
          "preflight",
          "active grant keys",
          "SELECT key_id FROM runtime_grant_keys WHERE revoked_at_epoch_seconds IS NULL " +
            "ORDER BY key_id LIMIT 32",
        )
      )
        .map((row) => row.key_id)
        .filter((value): value is string => typeof value === "string")
    : [];

  await runChecked(
    "preflight",
    "R2 bucket reachability",
    wranglerCommand(["r2", "bucket", "info", target.r2.bucketName, "--config", configPath]),
  );

  return { servedVersionId: version, tables, appliedMigrations, activeGrantKeyIds };
}

/**
 * Everything that must hold before the first writer runs. Any failure here
 * leaves the Cloudflare target untouched.
 */
export async function preflight(
  target: DeployTarget,
  options: { readonly runGate: boolean },
): Promise<PreflightReport> {
  const configPath = writeRealizedConfig(target);
  const { commit, branch, remoteUrl } = await resolvePushedCommit();

  if (options.runGate) {
    await runChecked("preflight", "portable gate `bun run check`", ["bun", "run", "check"]);
  }

  const bundle = await buildBundleDigest(configPath);
  const migrations = migrationProvenance();
  const live = await inspectLive(configPath, target);

  assertMigrationLineage(live.appliedMigrations, migrations.files);
  await assertProbeDatabaseIdentity(configPath, target);

  const { alreadyCurrent } = assertPublishedIdentity(
    readLedger(),
    live.servedVersionId,
    bundle.digest,
  );

  return {
    target,
    configPath,
    commit,
    branch,
    remoteUrl,
    bundleDigest: bundle.digest,
    bundleBytes: bundle.bytes,
    migrationDigest: migrations.digest,
    migrationFiles: migrations.files,
    live,
    alreadyCurrent,
  };
}

/**
 * The applied lineage must be a prefix of the local migration files. A target
 * carrying a migration this worktree does not contain, or a diverged name at
 * the same position, is a lineage break that forward-only application cannot
 * repair on its own.
 */
function assertMigrationLineage(applied: readonly string[], local: readonly string[]): void {
  if (applied.length > local.length) {
    throw preflightError(
      "the target has applied more migrations than this worktree declares",
      `applied=${JSON.stringify(applied)} local=${JSON.stringify(local)}`,
    );
  }
  for (const [index, name] of applied.entries()) {
    if (local[index] !== name) {
      throw preflightError(
        `migration lineage diverges at position ${index + 1}`,
        `applied=${JSON.stringify(applied)} local=${JSON.stringify(local)}`,
      );
    }
  }
}

/** Proves the credential in use can reach the exact database the target names. */
async function assertProbeDatabaseIdentity(
  configPath: string,
  target: DeployTarget,
): Promise<void> {
  const rows = await new RemoteD1(configPath).query(
    "preflight",
    "D1 capability probe",
    `SELECT ${sqlLiteral(target.d1.databaseId)} AS database_id`,
  );
  const first = rows[0];
  if (!first || first.database_id !== target.d1.databaseId) {
    throw preflightError("the D1 capability probe did not return the expected identity");
  }
}
