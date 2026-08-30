import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublicFormImplementationIdentity } from "../../src/public-worker-implementation.ts";
import { preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";
import type { DeployTarget } from "./target.ts";
import type { LegacyHostServiceBinding } from "./worker-state.ts";

const NEUTRAL_CONFIG_PATH = resolve(REPOSITORY, "wrangler.jsonc");

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
    ...(options.transitionServiceBinding === undefined
      ? {}
      : {
          services: [
            {
              binding: legacyServiceBindingName(),
              service: options.transitionServiceBinding.service,
              entrypoint: options.transitionServiceBinding.entrypoint,
            },
          ],
        }),
    secrets: {
      required: options.transitionExpectedSecrets ?? expectedWorkerSecrets(target),
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
  if (target.formAuthority !== undefined && implementation.workerArtifactDigest !== undefined) {
    vars.TAKOSERVER_WORKER_ARTIFACT_DIGEST = implementation.workerArtifactDigest;
  }
  if (target.workerEndpointSuffix !== undefined) {
    vars.TAKOSERVER_WORKER_ENDPOINT_SUFFIX = target.workerEndpointSuffix;
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
  if (target.sponsorship === true) names.add("TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN");
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
