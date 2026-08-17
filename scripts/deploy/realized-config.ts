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
  };
  writeFileSync(REALIZED_CONFIG_PATH, `${JSON.stringify(realized, null, 2)}\n`, { mode: 0o600 });
  return REALIZED_CONFIG_PATH;
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
