import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublicFormImplementationIdentity } from "../../src/public-worker-implementation.ts";
import { preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";
import type { DeployTarget } from "./target.ts";
import type { LegacyHostServiceBinding } from "./worker-state.ts";

const NEUTRAL_CONFIG_PATH = resolve(REPOSITORY, "wrangler.jsonc");
const CLOUDFLARE_PROVIDER_EXECUTOR_NEUTRAL_CONFIG_PATH = resolve(
  REPOSITORY,
  "wrangler.cloudflare-provider-executor.jsonc",
);

export interface WorkerConfigOptions {
  readonly path: string;
  readonly main: string;
  readonly commit: string;
  readonly signingKeyId?: string;
  /**
   * Explicit immutable Version authority profile. JIT-enabled targets must
   * select either historical-pre-jit or provenance-bound-jit; no profile is
   * inferred from annotations or a target clone.
   */
  readonly authorityProfile?: WorkerVersionAuthorityProfile;
  /** Build-derived semantic identity embedded into the outer Worker bytes. */
  readonly formImplementationIdentity?: PublicFormImplementationIdentity;
  /** Exact final outer Worker artifact, kept separate from semantic identity. */
  readonly workerArtifactDigest?: `sha256:${string}`;
  /**
   * Transition-only legacy service binding.  Ordinary target realization never
   * supplies this field; it exists solely for the reviewed L→C profile.
   */
  readonly transitionServiceBinding?: LegacyHostServiceBinding;
  /**
   * Transition-only secret inventory override.  This keeps retirement able to
   * prove the observed legacy token without putting retired fields on the
   * normal target descriptor.
   */
  readonly transitionExpectedSecrets?: readonly string[];
  /**
   * `version-only` realizes only immutable Worker resources. It deliberately
   * omits routes, custom domains, workers.dev toggles and triggers so the
   * versions API cannot change topology during routine non-production work.
   */
  readonly topology?: WorkerConfigTopology;
}

export type WorkerConfigTopology = "normal" | "version-only";

export interface PublicWorkerProvenance {
  readonly sourceCommit: string;
  readonly artifactDigest: `sha256:${string}`;
}

/**
 * Exact immutable-Worker authority shape used by live inspectors. Historical
 * Versions may explicitly prove the absence of the five JIT bindings; current
 * Versions must carry their source/artifact provenance.
 */
export type WorkerVersionAuthorityProfile =
  | { readonly kind: "historical-pre-jit" }
  | { readonly kind: "provenance-bound-jit"; readonly provenance: PublicWorkerProvenance };

/**
 * Caller-selected authority shape for live inspection. A JIT selection may
 * omit provenance while the inspector binds it to the Version's canonical
 * annotation; upload/config realization always uses the concrete profile
 * above and therefore requires provenance.
 */
export type WorkerVersionAuthoritySelection =
  | { readonly kind: "historical-pre-jit" }
  | { readonly kind: "provenance-bound-jit"; readonly provenance?: PublicWorkerProvenance };

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
  const authorityProfile = options.authorityProfile;
  if (
    authorityProfile?.kind === "provenance-bound-jit" &&
    authorityProfile.provenance.sourceCommit !== options.commit
  ) {
    throw preflightError("Worker config provenance must match its exact commit");
  }
  if (target.integrationE2eCredentialAuthority !== undefined && authorityProfile === undefined) {
    throw preflightError("JIT-enabled Worker config requires an explicit authority profile");
  }
  const { $schema: _schema, ...neutralConfigWithTopology } = neutral;
  const neutralConfig =
    options.topology === "version-only"
      ? Object.fromEntries(
          Object.entries(neutralConfigWithTopology).filter(
            ([key]) => !VERSION_ONLY_TOPOLOGY_KEYS.has(key),
          ),
        )
      : neutralConfigWithTopology;
  const signingKeyId = options.signingKeyId ?? effectiveSigningKeyId(target);
  const services = [
    ...(target.cloudflareProviderExecutor === undefined
      ? []
      : [
          {
            binding: "CLOUDFLARE_PROVIDER_EXECUTOR",
            service: target.cloudflareProviderExecutor.workerName,
            entrypoint: "CloudflareProviderExecutor",
          },
        ]),
    ...(options.transitionServiceBinding === undefined
      ? []
      : [
          {
            binding: legacyServiceBindingName(),
            service: options.transitionServiceBinding.service,
            entrypoint: options.transitionServiceBinding.entrypoint,
          },
        ]),
  ];
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
    ...(options.topology === "version-only"
      ? {}
      : serviceAddress(target.publicOrigin, target.aliases ?? [])),
    ...deploymentVariables(target, signingKeyId, authorityProfile, {
      ...(options.formImplementationIdentity === undefined
        ? {}
        : { formImplementationIdentity: options.formImplementationIdentity }),
      ...(options.workerArtifactDigest === undefined
        ? {}
        : { workerArtifactDigest: options.workerArtifactDigest }),
    }),
    ...(options.formImplementationIdentity === undefined
      ? {}
      : {
          define: {
            TAKOSERVER_BUILD_FORM_IMPLEMENTATION_DIGEST: JSON.stringify(
              options.formImplementationIdentity.implementationDigest,
            ),
            TAKOSERVER_BUILD_FORM_CAPABILITY_DIGEST: JSON.stringify(
              options.formImplementationIdentity.capabilityDigest,
            ),
            TAKOSERVER_BUILD_FORM_IMPLEMENTATION_PAYLOAD_DIGEST: JSON.stringify(
              options.formImplementationIdentity.implementationPayloadDigest,
            ),
          },
        }),
    ...(services.length === 0 ? {} : { services }),
    secrets: {
      required: options.transitionExpectedSecrets ?? expectedWorkerSecrets(target),
    },
  };
  writeFileSync(options.path, `${JSON.stringify(realized, null, 2)}\n`, { mode: 0o600 });
  return options.path;
}

export interface CloudflareProviderExecutorConfigOptions {
  readonly path: string;
  readonly main: string;
}

/**
 * Realizes the private Cloudflare provider executor from the same exact target
 * as the public Worker. Secret values are never accepted here: Wrangler fills
 * only the two declared secret names at the separate secret-mutation boundary.
 */
export function writeCloudflareProviderExecutorConfig(
  target: DeployTarget,
  options: CloudflareProviderExecutorConfigOptions,
): string {
  const topology = target.cloudflareProviderExecutor;
  if (!topology) {
    throw preflightError("Cloudflare provider executor config requires exact target topology");
  }
  const neutral = readExecutorNeutralConfig();
  assertExecutorNeutral(neutral);
  const { $schema: _schema, ...base } = neutral;
  const vars: Record<string, string> = {
    PUBLIC_ORIGIN: target.publicOrigin,
    CLOUDFLARE_ACCOUNT_ID: target.accountId,
    TAKOSERVER_ZONES: JSON.stringify(target.zones ?? []),
    TAKOSERVER_CLOUDFLARE_DISPATCH_NAMESPACE: topology.dispatchNamespace,
    TAKOSERVER_MANAGED_WORKER_GATEWAY_NAME: topology.gatewayWorkerName,
    TAKOSERVER_MANAGED_BASE_DOMAIN: topology.managedBaseDomain,
    TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID: topology.providerInstallationId,
    TAKOSERVER_CLOUDFLARE_RELEASE_READBACK_QUALIFICATION: JSON.stringify(
      topology.releaseReadbackQualification,
    ),
    TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_NAME: topology.receiptAuthorityWorkerName,
  };
  if (target.objectBucketSupplies !== undefined) {
    vars.TAKOSERVER_OBJECT_BUCKET_SUPPLIES = JSON.stringify(target.objectBucketSupplies);
  }
  if (target.edgeSupplies !== undefined) {
    vars.TAKOSERVER_EDGE_SUPPLIES = JSON.stringify(target.edgeSupplies);
  }
  const realized = {
    ...base,
    name: topology.workerName,
    main: options.main,
    account_id: target.accountId,
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      {
        binding: "STATE_DB",
        database_name: target.d1.databaseName,
        database_id: target.d1.databaseId,
        migrations_dir: "migrations",
      },
    ],
    r2_buckets: [{ binding: "OBJECTS", bucket_name: target.r2.bucketName }],
    dispatch_namespaces: [{ binding: "DISPATCHER", namespace: topology.dispatchNamespace }],
    durable_objects: {
      bindings: [
        {
          name: "SQLITE_DATABASES",
          class_name: "TakoserverManagedWorkerSqlite",
          script_name: topology.gatewayWorkerName,
        },
      ],
    },
    services: [
      {
        binding: "MANAGED_WORKER_AUTHORITY",
        service: topology.gatewayWorkerName,
        entrypoint: "TakoserverManagedWorkerAuthority",
      },
      {
        binding: "MANAGED_OBJECT_RECEIPT_AUTHORITY",
        service: topology.receiptAuthorityWorkerName,
        entrypoint: "TakoserverManagedObjectReceiptAuthority",
      },
    ],
    vars,
    secrets: {
      required: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING"],
    },
  };
  writeFileSync(options.path, `${JSON.stringify(realized, null, 2)}\n`, { mode: 0o600 });
  return options.path;
}

const VERSION_ONLY_TOPOLOGY_KEYS = new Set([
  "routes",
  "route",
  "triggers",
  "workers_dev",
  "workers_dev_subdomain",
  "preview_urls",
  "custom_domains",
  "domains",
]);

function legacyServiceBindingName(): string {
  return ["HOST", "RUNTIME", "MATERIALIZER"].join("_");
}

export function effectiveSigningKeyId(target: DeployTarget): string {
  // `nextKeyId` is a rotation proposal, never routine desired state. Only the
  // signing-rotation surface may pass it explicitly to writeWorkerConfig.
  return target.signing.currentKeyId;
}

/** Public per-deployment values. Secret bytes never enter this object. */
export function deploymentVariables(
  target: DeployTarget,
  signingKeyId = effectiveSigningKeyId(target),
  authorityProfile?: WorkerVersionAuthorityProfile,
  implementation: {
    readonly formImplementationIdentity?: PublicFormImplementationIdentity;
    readonly workerArtifactDigest?: `sha256:${string}`;
  } = {},
): Record<string, unknown> {
  const vars: Record<string, string> = {
    PUBLIC_ORIGIN: target.publicOrigin,
    TAKOSERVER_SIGNING_KEY_ID: signingKeyId,
  };
  if (target.artifactBlobIoMode !== undefined) {
    vars.TAKOSERVER_ARTIFACT_BLOB_IO_MODE = target.artifactBlobIoMode;
  }
  if (target.consoleOrigin !== undefined) vars.TAKOSERVER_CONSOLE_ORIGIN = target.consoleOrigin;
  if (target.googleClientId !== undefined) vars.GOOGLE_CLIENT_ID = target.googleClientId;
  if (target.takosId !== undefined) {
    vars.TAKOS_ID_ISSUER = target.takosId.issuer;
    vars.TAKOS_ID_CLIENT_ID = target.takosId.clientId;
  }
  if (target.stripeCheckout === true) vars.TAKOSERVER_STRIPE_CHECKOUT_ENABLED = "1";
  if (target.aiModels !== undefined) vars.TAKOSERVER_AI_MODELS = JSON.stringify(target.aiModels);
  if (target.objectBucketSupplies !== undefined) {
    vars.TAKOSERVER_OBJECT_BUCKET_SUPPLIES = JSON.stringify(target.objectBucketSupplies);
  }
  if (target.edgeSupplies !== undefined) {
    vars.TAKOSERVER_EDGE_SUPPLIES = JSON.stringify(target.edgeSupplies);
  }
  if (target.formAuthority !== undefined && implementation.workerArtifactDigest !== undefined) {
    vars.TAKOSERVER_WORKER_ARTIFACT_DIGEST = implementation.workerArtifactDigest;
  }
  if (target.cloudflareProviderExecutor !== undefined) {
    vars.TAKOSERVER_MANAGED_BASE_DOMAIN = target.cloudflareProviderExecutor.managedBaseDomain;
  }
  if (target.operatorIdentity !== undefined) {
    vars.OPERATOR_IDENTITY_PUBLIC_JWK = JSON.stringify(target.operatorIdentity.publicJwk);
  }
  if (
    target.integrationE2eCredentialAuthority !== undefined &&
    authorityProfile?.kind !== "historical-pre-jit"
  ) {
    if (target.environment !== "integration") {
      throw preflightError("integration E2E credential authority config is integration-only");
    }
    const exact = exactPublicWorkerProvenance(
      authorityProfile?.kind === "provenance-bound-jit" ? authorityProfile.provenance : undefined,
    );
    if (
      implementation.workerArtifactDigest !== undefined &&
      implementation.workerArtifactDigest !== exact.artifactDigest
    ) {
      throw preflightError("public Worker artifact identity differs from JIT provenance");
    }
    vars.TAKOSERVER_ENVIRONMENT = "integration";
    vars.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK = JSON.stringify(
      target.integrationE2eCredentialAuthority.publicJwk,
    );
    vars.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID =
      target.integrationE2eCredentialAuthority.organizationId;
    vars.TAKOSERVER_SOURCE_COMMIT = exact.sourceCommit;
    vars.TAKOSERVER_WORKER_ARTIFACT_DIGEST = exact.artifactDigest;
  }
  return { vars };
}

function exactPublicWorkerProvenance(
  value: PublicWorkerProvenance | undefined,
): PublicWorkerProvenance {
  if (
    value === undefined ||
    !/^[0-9a-f]{40}$/u.test(value.sourceCommit) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.artifactDigest)
  ) {
    throw preflightError(
      "integration E2E credential authority requires exact Worker source/artifact provenance",
    );
  }
  return value;
}

/** Names only; Cloudflare never returns or receives secret bytes here. */
export function expectedWorkerSecrets(target: DeployTarget): readonly string[] {
  const names = new Set<string>(["TAKOSERVER_SIGNING_KEY"]);
  if (target.edgeSupplies !== undefined) {
    names.add("TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING");
  }
  if (target.sponsorship === true) names.add("TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN");
  if (target.stripeCheckout === true) names.add("STRIPE_SECRET_KEY");
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

function readExecutorNeutralConfig(): NeutralConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CLOUDFLARE_PROVIDER_EXECUTOR_NEUTRAL_CONFIG_PATH, "utf8"));
  } catch {
    throw preflightError("wrangler.cloudflare-provider-executor.jsonc must stay comment-free JSON");
  }
  if (!isRecord(parsed) || typeof parsed.name !== "string") {
    throw preflightError("Cloudflare provider executor Wrangler config must declare a name");
  }
  return parsed as NeutralConfig;
}

function assertExecutorNeutral(neutral: Record<string, unknown>): void {
  if (
    neutral.main !== "src/entry-cloudflare-provider-executor.ts" ||
    neutral.workers_dev !== false ||
    neutral.preview_urls !== false
  ) {
    throw preflightError(
      "Cloudflare provider executor Wrangler config must remain route-less and name its exact entry",
    );
  }
  for (const forbidden of ["account_id", "routes", "route", "triggers"]) {
    if (forbidden in neutral) {
      throw preflightError(
        `Cloudflare provider executor Wrangler config must not declare ${JSON.stringify(forbidden)}`,
      );
    }
  }
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
    return { workers_dev: true, preview_urls: false };
  }
  return {
    workers_dev: false,
    preview_urls: false,
    routes: [hostname, ...aliases].map((pattern) => ({ pattern, custom_domain: true })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
