import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";

/**
 * The realized deploy target. It names one Cloudflare account and the exact
 * resources this repository may publish onto. It is operator-private and is
 * never committed: the repository stays account-neutral.
 */
export interface DeployTarget {
  readonly accountId: string;
  readonly workerName: string;
  readonly d1: { readonly databaseName: string; readonly databaseId: string };
  readonly r2: { readonly bucketName: string };
  readonly publicOrigin: string;
  /**
   * Where this deployment's console is served, if it has one. Optional because
   * a deployment is a complete product without a console — the API, the CLI and
   * the Takoform provider are the whole of it for anyone integrating.
   */
  readonly consoleOrigin?: string;
  readonly grantKeyId: string;
}

export const DEFAULT_TARGET_PATH = ".deploy/target.json";

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;

export function targetPath(explicit?: string): string {
  const candidate = explicit ?? process.env.TAKOSERVER_DEPLOY_TARGET ?? DEFAULT_TARGET_PATH;
  return isAbsolute(candidate) ? candidate : resolve(REPOSITORY, candidate);
}

export function loadTarget(path: string): DeployTarget {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw preflightError(
      `deploy target descriptor not found: ${path}`,
      "Create an operator-private descriptor. It is gitignored and holds the only " +
        "account-specific values:\n" +
        JSON.stringify(
          {
            accountId: "<32 hex characters>",
            workerName: "takoserver-api",
            d1: { databaseName: "takoserver-runtime", databaseId: "<uuid>" },
            r2: { bucketName: "takoserver-objects" },
            publicOrigin: "https://<worker>.<subdomain>.workers.dev",
            grantKeyId: "takoserver-runtime-<yyyy-mm>",
          },
          null,
          2,
        ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw preflightError(`deploy target descriptor is not valid JSON: ${path}`);
  }
  return validateTarget(parsed, path);
}

function validateTarget(value: unknown, path: string): DeployTarget {
  if (!isRecord(value)) throw preflightError(`deploy target descriptor must be an object: ${path}`);
  assertExactKeys(
    value,
    ["accountId", "workerName", "d1", "r2", "publicOrigin", "grantKeyId"],
    ["consoleOrigin"],
  );

  const d1 = value.d1;
  const r2 = value.r2;
  if (!isRecord(d1)) throw preflightError("deploy target `d1` must be an object");
  if (!isRecord(r2)) throw preflightError("deploy target `r2` must be an object");
  assertExactKeys(d1, ["databaseName", "databaseId"]);
  assertExactKeys(r2, ["bucketName"]);

  return {
    accountId: pattern(value.accountId, ACCOUNT_ID, "accountId"),
    workerName: pattern(value.workerName, WORKER_NAME, "workerName"),
    d1: {
      databaseName: pattern(d1.databaseName, BUCKET_NAME, "d1.databaseName"),
      databaseId: pattern(d1.databaseId, UUID, "d1.databaseId"),
    },
    r2: { bucketName: pattern(r2.bucketName, BUCKET_NAME, "r2.bucketName") },
    publicOrigin: httpsOrigin(value.publicOrigin),
    ...(value.consoleOrigin === undefined
      ? {}
      : { consoleOrigin: httpsOrigin(value.consoleOrigin) }),
    grantKeyId: pattern(value.grantKeyId, KEY_ID, "grantKeyId"),
  };
}

/**
 * Exactly the required keys, plus any of the optional ones.
 *
 * The strictness is the point: a descriptor with a misspelled key would
 * otherwise deploy successfully against a target subtly other than the one the
 * operator wrote down.
 */
function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const missing = required.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !required.includes(key) && !optional.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw preflightError(
      `deploy target has unexpected keys: got ${JSON.stringify(actual)}, ` +
        `expected ${JSON.stringify([...required].sort())}` +
        (optional.length > 0 ? ` and optionally ${JSON.stringify([...optional].sort())}` : ""),
    );
  }
}

function pattern(value: unknown, expression: RegExp, field: string): string {
  if (typeof value !== "string" || !expression.test(value)) {
    throw preflightError(`deploy target \`${field}\` is invalid`);
  }
  return value;
}

function httpsOrigin(value: unknown): string {
  if (typeof value !== "string") throw preflightError("deploy target `publicOrigin` is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw preflightError("deploy target `publicOrigin` is not a URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw preflightError("deploy target `publicOrigin` must be a bare https origin");
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
