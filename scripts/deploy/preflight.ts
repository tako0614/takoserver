import { RemoteD1 } from "./d1.ts";
import { preflightError } from "./errors.ts";
import { assertPublishedIdentity, readLedger } from "./evidence.ts";
import { runChecked, runCommand, wranglerCommand } from "./process.ts";
import { buildBundleDigest, migrationProvenance, resolvePushedCommit } from "./provenance.ts";
import { realizedConfigDigest, writeRealizedConfig } from "./realized-config.ts";
import {
  inspectSigningAuthority,
  liveSigningKeyMatches,
  type SigningAuthority,
} from "./signing-authority.ts";
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
  readonly configDigest: string;
  readonly signingAuthority: SigningAuthority | null;
  readonly signingKeyRepairRequired: boolean;
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
  const configDigest = await realizedConfigDigest(configPath);
  const migrations = migrationProvenance();
  const live = await inspectLive(configPath, target);

  assertMigrationLineage(live.appliedMigrations, migrations.files);
  await assertAliasesAttachable(target);
  await assertRequiredSecretsPresent(configPath, target);
  await assertProbeDatabaseIdentity(configPath, target);

  const signingAuthority = live.activeGrantKeyIds.includes(target.grantKeyId)
    ? await inspectSigningAuthority("preflight", configPath, target)
    : null;
  const liveSigningKeyMatchesAuthority = signingAuthority
    ? await liveSigningKeyMatches("preflight", configPath, target, signingAuthority)
    : null;
  const signingKeyRepairRequired = liveSigningKeyMatchesAuthority === false;

  const { alreadyCurrent } = assertPublishedIdentity(
    readLedger(),
    live.servedVersionId,
    bundle.digest,
    configDigest,
  );

  return {
    target,
    configPath,
    commit,
    branch,
    remoteUrl,
    bundleDigest: bundle.digest,
    bundleBytes: bundle.bytes,
    configDigest,
    migrationDigest: migrations.digest,
    migrationFiles: migrations.files,
    live,
    alreadyCurrent,
    signingAuthority,
    signingKeyRepairRequired,
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

/**
 * An alias must be attachable before the publish begins.
 *
 * Cloudflare refuses a custom domain on a hostname that already has DNS
 * records of its own, and it refuses it *after* the script has uploaded — so
 * the deploy ends with the code published, the routes half applied, and
 * wrangler saying in as many words that nothing was rolled back.
 *
 * What Cloudflare objects to is the record, not the answer: a hostname can
 * resolve and serve nothing at all, and still be refused. So the question is
 * whether anything resolves, and whether what resolves is already us — the
 * second half matters because attaching succeeds and then this deployment's
 * own record would look exactly like somebody else's.
 */
async function assertAliasesAttachable(target: DeployTarget): Promise<void> {
  for (const alias of target.aliases ?? []) {
    if (!(await resolves(alias))) continue;
    const answer = await fetch(`https://${alias}/.well-known/takoserver`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (answer?.ok) continue;
    throw preflightError(
      `${alias} already has DNS records of its own`,
      "Cloudflare will not attach a Worker to such a hostname, and it refuses only after the " +
        "script is uploaded — leaving the deploy half applied. Delete the records for " +
        `${alias}, or drop it from \`aliases\`, then deploy again.`,
    );
  }
}

/** Whether a hostname resolves at all, asked of a resolver rather than of us. */
async function resolves(hostname: string): Promise<boolean> {
  for (const type of ["A", "AAAA", "CNAME"]) {
    const answer = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) },
    ).catch(() => null);
    if (!answer?.ok) continue;
    const body = (await answer.json().catch(() => null)) as { Answer?: unknown[] } | null;
    if (Array.isArray(body?.Answer) && body.Answer.length > 0) return true;
  }
  return false;
}

/**
 * A deployment that verifies tokens it can never issue.
 *
 * The public half of the signing key lives in the database, so verification
 * works from the first deploy and issuing does not. The failure surfaces later,
 * to a customer, as `no_active_keys` on the one call that mattered — true, and
 * unhelpful unless you already know what it means. Asking here turns it into a
 * sentence naming the secret to set.
 */
async function assertRequiredSecretsPresent(
  configPath: string,
  target: DeployTarget,
): Promise<void> {
  const listed = await runCommand(wranglerCommand(["secret", "list", "--config", configPath]));
  // A listing we could not obtain is not evidence of absence, and refusing to
  // deploy over a transient wrangler failure would be its own defect.
  if (listed.exitCode !== 0) return;
  const required = [
    {
      name: "TAKOSERVER_SIGNING_KEY",
      why: "data tokens cannot be issued without the private signing key",
    },
    ...(target.hostedSponsorship
      ? [
          {
            name: "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
            why: "Takosumi Hosted sponsorship is enabled by this target",
          },
        ]
      : []),
    ...(target.stripeCheckout
      ? [
          {
            name: "STRIPE_SECRET_KEY",
            why: "customer Stripe Checkout funding is enabled by this target",
          },
        ]
      : []),
    ...(target.edgeSupplies ||
    target.objectBucketSupplies?.supplies.some((supply) => supply.provider.kind === "cloudflare")
      ? [
          {
            name: "CLOUDFLARE_API_TOKEN",
            why: "Cloudflare provisioning is enabled by this target",
          },
        ]
      : []),
    ...(target.r2ParentAccessKeyId !== undefined
      ? [
          {
            name: "TAKOSERVER_R2_PARENT_TOKEN",
            why: "standard S3 temporary credentials are enabled by this target",
          },
        ]
      : []),
    ...(target.objectBucketSupplies?.supplies.some((supply) => supply.provider.kind === "wasabi")
      ? [
          {
            name: "TAKOSERVER_WASABI_ACCESS_KEY_ID",
            why: "Wasabi ObjectBucket provisioning and scoped STS credentials are enabled",
          },
          {
            name: "TAKOSERVER_WASABI_SECRET_ACCESS_KEY",
            why: "Wasabi ObjectBucket provisioning and scoped STS credentials are enabled",
          },
        ]
      : []),
  ];
  for (const secret of required) {
    if (listed.stdout.includes(secret.name)) continue;
    throw preflightError(
      `required Worker secret ${secret.name} is not set`,
      `${secret.why}. Set it through the owner configuration before publishing:\n` +
        `  wrangler secret put ${secret.name} --config .wrangler-realized.jsonc`,
    );
  }
}
