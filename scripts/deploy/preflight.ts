import { RemoteD1 } from "./d1.ts";
import { preflightError } from "./errors.ts";
import { assertPublishedIdentity, readLedger } from "./evidence.ts";
import { runChecked, wranglerCommand } from "./process.ts";
import { buildBundleDigest, migrationProvenance, resolvePushedCommit } from "./provenance.ts";
import { writeRealizedConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { servedVersionId } from "./worker-state.ts";

/**
 * Tables whose absence means the deployment is not the product: identity,
 * money, declared resources, and the key material tokens are checked against.
 * A migration that failed halfway shows up here rather than as a 500 later.
 */
export const RUNTIME_TABLES = [
  "auth_tokens",
  "ledger",
  "orgs",
  "reservations",
  "runtime_grant_keys",
  "tf_resources",
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

  const tables = await database.column(
    "preflight",
    "D1 table inventory",
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    "name",
  );

  const appliedMigrations = tables.includes("d1_migrations")
    ? await database.column(
        "preflight",
        "D1 migration lineage",
        "SELECT name FROM d1_migrations ORDER BY id",
        "name",
      )
    : [];

  const activeGrantKeyIds = tables.includes("runtime_grant_keys")
    ? await database.column(
        "preflight",
        "active grant keys",
        "SELECT key_id FROM runtime_grant_keys WHERE revoked_at_epoch_seconds IS NULL " +
          "ORDER BY key_id LIMIT 32",
        "key_id",
      )
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

/**
 * Proves the credential in use resolves the target's database name to exactly
 * the database id the target pins, so a same-named database in another account
 * or a stale id cannot be published against.
 */
async function assertProbeDatabaseIdentity(
  configPath: string,
  target: DeployTarget,
): Promise<void> {
  const raw = await runChecked(
    "preflight",
    "D1 identity probe",
    wranglerCommand(["d1", "info", target.d1.databaseName, "--json", "--config", configPath]),
  );
  const start = raw.indexOf("{");
  if (start < 0) throw preflightError("the D1 identity probe returned no JSON", raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    throw preflightError("the D1 identity probe returned unparsable JSON", raw);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw preflightError("the D1 identity probe returned an unexpected shape", raw);
  }
  const info = parsed as { readonly uuid?: unknown; readonly name?: unknown };
  if (info.uuid !== target.d1.databaseId || info.name !== target.d1.databaseName) {
    throw preflightError(
      "the D1 identity probe resolved a different database than the deploy target pins",
      `resolved uuid=${JSON.stringify(info.uuid)} name=${JSON.stringify(info.name)}`,
    );
  }
}
