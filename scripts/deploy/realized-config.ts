import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";
import type { DeployTarget } from "./target.ts";

/**
 * The checked `wrangler.jsonc` is deliberately target-neutral: it carries the
 * binding shape but no account, database, or bucket identity. Realization joins
 * it with one operator-private target into a gitignored config that Wrangler
 * reads from the repository root, so every relative path still resolves.
 */
export const REALIZED_CONFIG_PATH = resolve(REPOSITORY, ".wrangler-realized.jsonc");
export const NEUTRAL_CONFIG_PATH = resolve(REPOSITORY, "wrangler.jsonc");

export function writeRealizedConfig(target: DeployTarget): string {
  const neutral = readNeutralConfig();

  if (neutral.name !== target.workerName) {
    throw preflightError(
      `worker name mismatch: wrangler.jsonc declares ${JSON.stringify(neutral.name)} but the ` +
        `deploy target names ${JSON.stringify(target.workerName)}`,
    );
  }
  assertNeutral(neutral);

  const realized = {
    ...neutral,
    account_id: target.accountId,
    d1_databases: [
      {
        binding: "STATE_DB",
        database_name: target.d1.databaseName,
        database_id: target.d1.databaseId,
        migrations_dir: "migrations",
      },
    ],
    r2_buckets: [{ binding: "OBJECTS", bucket_name: target.r2.bucketName }],
    ...serviceAddress(target.publicOrigin, target.aliases ?? []),
    ...deploymentVariables(target),
  };
  writeFileSync(REALIZED_CONFIG_PATH, `${JSON.stringify(realized, null, 2)}\n`, { mode: 0o600 });
  return REALIZED_CONFIG_PATH;
}

/**
 * Digest of what the bundle will run under.
 *
 * A deployment is the bytes and the wiring together. Naming the wiring lets the
 * publish decision notice when only the wiring moved — turning a feature on
 * through a variable is a change that has to reach production, not one that
 * reports itself as already deployed.
 */
export async function realizedConfigDigest(configPath: string): Promise<string> {
  const bytes = new TextEncoder().encode(readFileSync(configPath, "utf8"));
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface NeutralConfig extends Record<string, unknown> {
  readonly name: string;
}

function readNeutralConfig(): NeutralConfig {
  const raw = readFileSync(NEUTRAL_CONFIG_PATH, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw preflightError(
      "wrangler.jsonc must stay comment-free JSON so realization can join it with a target",
    );
  }
  if (!isRecord(parsed) || typeof parsed.name !== "string") {
    throw preflightError("wrangler.jsonc must declare a string `name`");
  }
  return parsed as NeutralConfig;
}

/** Guards the claim that the committed configuration carries no realized identity. */
/**
 * Per-deployment values the Worker reads, and that are not secrets.
 *
 * Both are public by nature — one is an address, the other is an OAuth client
 * id that ships in every page offering the button. They are here rather than in
 * the repository because they differ per deployment, which is the same reason
 * the account and the database are.
 */
export function deploymentVariables(target: DeployTarget): Record<string, unknown> {
  const vars: Record<string, string> = {};
  if (target.consoleOrigin !== undefined) vars.TAKOSERVER_CONSOLE_ORIGIN = target.consoleOrigin;
  if (target.googleClientId !== undefined) vars.GOOGLE_CLIENT_ID = target.googleClientId;
  if (target.takosId !== undefined) {
    vars.TAKOS_ID_ISSUER = target.takosId.issuer;
    vars.TAKOS_ID_CLIENT_ID = target.takosId.clientId;
  }
  if (target.stripeCheckout === true) vars.TAKOSERVER_STRIPE_CHECKOUT_ENABLED = "1";
  // The key id is public — its public half is in the database for anyone to
  // verify against. The private half is a secret and is set separately.
  vars.TAKOSERVER_SIGNING_KEY_ID = target.grantKeyId;
  if (
    target.zones !== undefined ||
    target.aiModels !== undefined ||
    target.r2ParentAccessKeyId !== undefined ||
    target.objectBucketSupplies !== undefined ||
    target.edgeSupplies !== undefined
  ) {
    // The account the Worker provisions in is the account it is deployed to;
    // saying so once here keeps the provider from having to be told twice.
    vars.CLOUDFLARE_ACCOUNT_ID = target.accountId;
  }
  if (target.zones !== undefined) vars.TAKOSERVER_ZONES = JSON.stringify(target.zones);
  if (target.aiModels !== undefined) vars.TAKOSERVER_AI_MODELS = JSON.stringify(target.aiModels);
  if (target.r2ParentAccessKeyId !== undefined) {
    vars.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID = target.r2ParentAccessKeyId;
  }
  if (target.objectBucketSupplies !== undefined) {
    vars.TAKOSERVER_OBJECT_BUCKET_SUPPLIES = JSON.stringify(target.objectBucketSupplies);
  }
  if (target.edgeSupplies !== undefined) {
    vars.TAKOSERVER_EDGE_SUPPLIES = JSON.stringify(target.edgeSupplies);
  }
  if (target.workerEndpointSuffix !== undefined) {
    vars.TAKOSERVER_WORKER_ENDPOINT_SUFFIX = target.workerEndpointSuffix;
  }
  return Object.keys(vars).length === 0 ? {} : { vars };
}

/**
 * Makes the target's `publicOrigin` true.
 *
 * The origin is not a label for a deployment, it is the address callers use, so
 * publishing has to put the Worker there. A `workers.dev` origin is served by
 * the subdomain that flag turns on; anything else is a domain in the account,
 * attached as a custom domain — and the subdomain is then switched off, because
 * leaving it on publishes the same API at a second address that spells out the
 * operator's account name.
 */
function serviceAddress(
  publicOrigin: string,
  aliases: readonly string[] = [],
): Record<string, unknown> {
  const { hostname } = new URL(publicOrigin);
  if (hostname.endsWith(".workers.dev")) {
    if (aliases.length > 0) {
      throw preflightError("a workers.dev origin cannot carry aliases; name a real origin first");
    }
    return { workers_dev: true };
  }
  return {
    workers_dev: false,
    routes: [hostname, ...aliases].map((pattern) => ({ pattern, custom_domain: true })),
  };
}

function assertNeutral(neutral: Record<string, unknown>): void {
  for (const forbidden of ["account_id", "routes", "route", "vars", "workers_dev_subdomain"]) {
    if (forbidden in neutral) {
      throw preflightError(
        `wrangler.jsonc must stay target-neutral but declares ${JSON.stringify(forbidden)}`,
      );
    }
  }
  for (const [field, key] of [
    ["d1_databases", "database_id"],
    ["r2_buckets", "bucket_name"],
  ] as const) {
    const entries = neutral[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isRecord(entry) && key in entry) {
        throw preflightError(`wrangler.jsonc must not pin ${field}[].${key}`);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
