import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";
import type { DeployTarget } from "./target.ts";

const NEUTRAL_CONFIG_PATH = resolve(REPOSITORY, "wrangler.jsonc");

export interface WorkerConfigOptions {
  readonly path: string;
  readonly main: string;
  readonly commit: string;
  readonly hostedTopology: "desired" | "absent";
  readonly signingKeyId?: string;
}

/**
 * Realizes one target into a caller-owned temporary path. The caller seals the
 * resulting config beside the exact bundle; this module never writes mutable
 * deploy state into the repository.
 */
export function writeWorkerConfig(target: DeployTarget, options: WorkerConfigOptions): string {
  if (!/^[0-9a-f]{40}$/u.test(options.commit)) {
    throw preflightError("Worker config requires one exact commit");
  }
  const neutral = readNeutralConfig();
  assertNeutral(neutral);
  const { $schema: _schema, ...neutralConfig } = neutral;
  const signingKeyId = options.signingKeyId ?? effectiveSigningKeyId(target);
  const realized = {
    ...neutralConfig,
    name: target.workerName,
    main: options.main,
    account_id: target.accountId,
    d1_databases: [
      {
        binding: "STATE_DB",
        database_name: target.d1.databaseName,
        database_id: target.d1.databaseId,
      },
    ],
    r2_buckets: [{ binding: "OBJECTS", bucket_name: target.r2.bucketName }],
    ...serviceAddress(target.publicOrigin, target.aliases ?? []),
    ...deploymentVariables(target, signingKeyId),
    ...(options.hostedTopology === "desired" ? serviceBindings(target) : {}),
    secrets: { required: expectedWorkerSecrets(target) },
  };
  writeFileSync(options.path, `${JSON.stringify(realized, null, 2)}\n`, { mode: 0o600 });
  return options.path;
}

export function effectiveSigningKeyId(target: DeployTarget): string {
  // `nextKeyId` is a rotation proposal, never routine desired state. Only the
  // signing-rotation surface may pass it explicitly to writeWorkerConfig.
  return target.signing.currentKeyId;
}

/** Exact non-secret RPC route selected only by the topology surface. */
export function serviceBindings(target: DeployTarget): Record<string, unknown> {
  const topology = target.hostedTopology;
  if (!topology) return {};
  return {
    services: [
      {
        binding: "HOST_RUNTIME_MATERIALIZER",
        service: topology.service,
        entrypoint: topology.entrypoint,
      },
    ],
  };
}

/** Public per-deployment values. Secret bytes never enter this object. */
export function deploymentVariables(
  target: DeployTarget,
  signingKeyId = effectiveSigningKeyId(target),
): Record<string, unknown> {
  const vars: Record<string, string> = {
    PUBLIC_ORIGIN: target.publicOrigin,
    TAKOSERVER_SIGNING_KEY_ID: signingKeyId,
  };
  if (target.consoleOrigin !== undefined) vars.TAKOSERVER_CONSOLE_ORIGIN = target.consoleOrigin;
  if (target.googleClientId !== undefined) vars.GOOGLE_CLIENT_ID = target.googleClientId;
  if (target.takosId !== undefined) {
    vars.TAKOS_ID_ISSUER = target.takosId.issuer;
    vars.TAKOS_ID_CLIENT_ID = target.takosId.clientId;
  }
  if (target.stripeCheckout === true) vars.TAKOSERVER_STRIPE_CHECKOUT_ENABLED = "1";
  if (
    target.zones !== undefined ||
    target.aiModels !== undefined ||
    target.r2ParentAccessKeyId !== undefined ||
    target.standardServiceSupplies !== undefined ||
    target.objectBucketSupplies !== undefined ||
    target.edgeSupplies !== undefined
  ) {
    vars.CLOUDFLARE_ACCOUNT_ID = target.accountId;
  }
  if (target.zones !== undefined) vars.TAKOSERVER_ZONES = JSON.stringify(target.zones);
  if (target.aiModels !== undefined) vars.TAKOSERVER_AI_MODELS = JSON.stringify(target.aiModels);
  if (target.r2ParentAccessKeyId !== undefined) {
    vars.TAKOSERVER_R2_PARENT_ACCESS_KEY_ID = target.r2ParentAccessKeyId;
  }
  if (target.standardServiceSupplies !== undefined) {
    vars.TAKOSERVER_STANDARD_SERVICE_SUPPLIES = JSON.stringify(target.standardServiceSupplies);
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
  return { vars };
}

/** Names only; Cloudflare never returns or receives secret bytes here. */
export function expectedWorkerSecrets(target: DeployTarget): readonly string[] {
  const names = new Set<string>(["TAKOSERVER_SIGNING_KEY"]);
  if (target.hostedTopology !== undefined) names.add("TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN");
  if (target.stripeCheckout === true) names.add("STRIPE_SECRET_KEY");
  if (
    target.standardServiceSupplies !== undefined ||
    target.edgeSupplies !== undefined ||
    target.objectBucketSupplies?.supplies.some((supply) => supply.provider.kind === "cloudflare")
  ) {
    names.add("CLOUDFLARE_API_TOKEN");
  }
  if (target.r2ParentAccessKeyId !== undefined) names.add("TAKOSERVER_R2_PARENT_TOKEN");
  if (target.objectBucketSupplies?.supplies.some((supply) => supply.provider.kind === "wasabi")) {
    names.add("TAKOSERVER_WASABI_ACCESS_KEY_ID");
    names.add("TAKOSERVER_WASABI_SECRET_ACCESS_KEY");
  }
  return [...names].sort();
}

interface NeutralConfig extends Record<string, unknown> {
  readonly name: string;
}

function readNeutralConfig(): NeutralConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(NEUTRAL_CONFIG_PATH, "utf8"));
  } catch {
    throw preflightError("wrangler.jsonc must stay comment-free JSON");
  }
  if (!isRecord(parsed) || typeof parsed.name !== "string") {
    throw preflightError("wrangler.jsonc must declare a string `name`");
  }
  return parsed as NeutralConfig;
}

function assertNeutral(neutral: Record<string, unknown>): void {
  for (const forbidden of [
    "account_id",
    "routes",
    "route",
    "vars",
    "services",
    "secrets",
    "annotations",
    "workers_dev_subdomain",
  ]) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
