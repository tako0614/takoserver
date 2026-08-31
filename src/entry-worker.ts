import { type App, buildApp } from "./app.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { resolveIdentity } from "./identity-setup.ts";
import {
  INTEGRATION_E2E_ORGANIZATION_ID,
  type IntegrationE2eCredentialAuthorityConfig,
  resolveIntegrationE2eCredentialAuthorityConfig,
} from "./integration-e2e-credential-authority.ts";
import { createR2ObjectStore } from "./objects-r2.ts";
import { createOperatorSettlement } from "./operator-credentials.ts";
import { resolvePayment } from "./payment-setup.ts";
import type { CloudflareWorkersAiBinding } from "./providers/cloudflare-workers-ai.ts";
import { embeddedPublicFormImplementationIdentity } from "./public-form-implementation-build.ts";
import type {
  PublicFormImplementationIdentity,
  PublicWorkerImplementationIdentity,
} from "./public-worker-implementation.ts";
import { createTakoformRuntimeInputOriginAuthority } from "./runtime-input-origin-authority.ts";
import { createRuntimeInputAuthority } from "./runtime-input-preparations.ts";
import { parseRuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
import { loadSigningKey } from "./signing-key.ts";
import { createD1Sql } from "./sql-d1.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { currentTakoformCandidates } from "./takoform/current-candidates.ts";
import { createTakoformStore } from "./takoform/store.ts";
import { createJavaScriptWorkerModuleInspector } from "./takoform/worker-module-inspector.ts";
import { createWorkerDataServices } from "./worker-data-services.ts";
import { createWorkerProductionComposition } from "./worker-production-composition.ts";

/**
 * The Cloudflare Workers entry.
 *
 * This serves the whole product, provisioning included. ADR 0001 decided that
 * the Worker provisions Cloudflare resources itself with a scoped API token
 * held as a secret: customer Workers are separate scripts with separate
 * bundles, so there is nobody to leak that reach to. What stays forbidden in
 * this bundle are the D1/R2 HTTP transports — the Worker has bindings for
 * both, and long-lived storage keys have no business in an edge isolate.
 *
 * The private composition may enable several provider packs at once. Each pack
 * keeps its own credential and exact Offering identity; the catalog compiler
 * rejects a partial or ambiguous composition before the Worker serves.
 */

export interface WorkerEnv {
  readonly AI?: CloudflareWorkersAiBinding;
  readonly STATE_DB: Parameters<typeof createD1Sql>[0];
  readonly OBJECTS: Parameters<typeof createR2ObjectStore>[0];
  readonly WORKER_VERSION: { readonly id: string };
  readonly PUBLIC_ORIGIN?: string;
  /** Exact deploy lane. The JIT credential route refuses every value but integration. */
  readonly TAKOSERVER_ENVIRONMENT?: string;
  /** Public half of the dedicated operator proof key for the JIT pair lifecycle. */
  readonly TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK?: string;
  /** Existing organization to which the JIT writer/evidence pair is pinned. */
  readonly TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID?: string;
  /** Exact source and built artifact identities injected by the owning deploy surface. */
  readonly TAKOSERVER_SOURCE_COMMIT?: string;
  readonly TAKOSERVER_WORKER_ARTIFACT_DIGEST?: string;
  /** Where this deployment's console is served, if it has one. */
  readonly TAKOSERVER_CONSOLE_ORIGIN?: string;
  /** Public half of the operator key, as an Ed25519 JWK. */
  readonly OPERATOR_PUBLIC_JWK?: string;
  /**
   * Public half of an identity-only operator key.
   *
   * Unlike the legacy OPERATOR_PUBLIC_JWK, this key may sign login assertions
   * but never wallet-funding assertions.
   */
  readonly OPERATOR_IDENTITY_PUBLIC_JWK?: string;
  /** Public OAuth client id. Its presence turns Google sign-in on. */
  readonly GOOGLE_CLIENT_ID?: string;
  /** Shared company identity issuer and this product's public OIDC client. */
  readonly TAKOS_ID_ISSUER?: string;
  readonly TAKOS_ID_CLIENT_ID?: string;
  /** Private sponsorship owner API bearer. */
  readonly TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN?: string;
  /** The Cloudflare account this deployment provisions in. */
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  /** Scoped Cloudflare API token. A secret, never a var. */
  readonly CLOUDFLARE_API_TOKEN?: string;
  /** DNS zones this deployment may attach Workers to, as JSON. */
  readonly TAKOSERVER_ZONES?: string;
  /** Stripe secret key. The deploy target must separately authorize Checkout. */
  readonly STRIPE_SECRET_KEY?: string;
  /** Exact operator intent to expose Stripe Checkout on this deployment. */
  readonly TAKOSERVER_STRIPE_CHECKOUT_ENABLED?: string;
  /** Key id whose public half is registered for verification. */
  readonly TAKOSERVER_SIGNING_KEY_ID?: string;
  /** Private half, as an Ed25519 JWK. A secret. */
  readonly TAKOSERVER_SIGNING_KEY?: string;
  /** Private model mapping and retail price configuration. */
  readonly TAKOSERVER_AI_MODELS?: string;
  /** Explicit Host-owned standard-service supplies; absent is fail-closed. */
  readonly TAKOSERVER_STANDARD_SERVICE_SUPPLIES?: string;
  /** Metadata identifying the R2 parent token used for temporary credentials. */
  readonly TAKOSERVER_R2_PARENT_ACCESS_KEY_ID?: string;
  /** R2 parent token. A secret distinct from the general Cloudflare API token. */
  readonly TAKOSERVER_R2_PARENT_TOKEN?: string;
  /** Versioned, non-secret commercial composition emitted by takoserver-private. */
  readonly TAKOSERVER_OBJECT_BUCKET_SUPPLIES?: string;
  /** Reviewed Cloudflare sales for released identity Forms other than storage. */
  readonly TAKOSERVER_EDGE_SUPPLIES?: string;
  /** Operator-private AES key ring for one-shot Worker runtime inputs. */
  readonly TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING?: string;
  /** Exact workers.dev suffix assigned to the configured provider account. */
  readonly TAKOSERVER_WORKER_ENDPOINT_SUFFIX?: string;
  /** Wasabi sub-user credentials. Both are Worker secrets. */
  readonly TAKOSERVER_WASABI_ACCESS_KEY_ID?: string;
  readonly TAKOSERVER_WASABI_SECRET_ACCESS_KEY?: string;
}

/**
 * Sign-in and funding both need a fact the server cannot determine alone.
 *
 * Sign-in is answered by Google where an OAuth client is configured, and
 * otherwise by the operator's signature. Funding has no such provider yet, so
 * it is the operator's signature or nothing — and nothing means refusing. That
 * refusal is the point: a stub that said yes would credit any amount while
 * looking exactly like a finished product.
 */
export function operatorCredentialKeys(env: {
  readonly OPERATOR_PUBLIC_JWK?: string;
  readonly OPERATOR_IDENTITY_PUBLIC_JWK?: string;
}): {
  readonly identity?: { readonly kty: string; readonly crv: string; readonly x: string };
  readonly settlement?: { readonly kty: string; readonly crv: string; readonly x: string };
} {
  const legacy = env.OPERATOR_PUBLIC_JWK
    ? (JSON.parse(env.OPERATOR_PUBLIC_JWK) as { kty: string; crv: string; x: string })
    : undefined;
  const identity = env.OPERATOR_IDENTITY_PUBLIC_JWK
    ? (JSON.parse(env.OPERATOR_IDENTITY_PUBLIC_JWK) as {
        kty: string;
        crv: string;
        x: string;
      })
    : legacy;
  return {
    ...(identity ? { identity } : {}),
    ...(legacy ? { settlement: legacy } : {}),
  };
}

export function workerCredentials(
  env: Pick<
    WorkerEnv,
    | "OPERATOR_PUBLIC_JWK"
    | "OPERATOR_IDENTITY_PUBLIC_JWK"
    | "TAKOS_ID_ISSUER"
    | "TAKOS_ID_CLIENT_ID"
    | "GOOGLE_CLIENT_ID"
    | "STRIPE_SECRET_KEY"
    | "TAKOSERVER_STRIPE_CHECKOUT_ENABLED"
    | "TAKOSERVER_CONSOLE_ORIGIN"
  >,
) {
  const operatorKeys = operatorCredentialKeys(env);
  const identity = resolveIdentity({
    ...(env.TAKOS_ID_ISSUER && env.TAKOS_ID_CLIENT_ID
      ? {
          takosId: {
            issuer: env.TAKOS_ID_ISSUER,
            clientId: env.TAKOS_ID_CLIENT_ID,
          },
        }
      : {}),
    googleClientId: env.GOOGLE_CLIENT_ID,
    operatorPublicKeyJwk: operatorKeys.identity,
  });
  const payment = resolvePayment({
    stripeSecretKey:
      env.TAKOSERVER_STRIPE_CHECKOUT_ENABLED === "1" ? env.STRIPE_SECRET_KEY : undefined,
    consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN,
  });

  return {
    identity: identity.verifier,
    identityProviders: identity.providers,
    ...(payment.checkout ? { checkout: payment.checkout } : {}),
    // Stripe where a customer can pay; the operator's signature where they
    // cannot; and a refusal where neither exists, because a stub that said yes
    // would credit any amount while looking exactly like a finished product.
    settlement:
      payment.settlement ??
      (operatorKeys.settlement
        ? createOperatorSettlement({ publicKeyJwk: operatorKeys.settlement })
        : {
            async verify(): Promise<never> {
              throw new Error("settlement credentials are not configured");
            },
          }),
  };
}

let cached: { readonly env: WorkerEnv; readonly app: App } | null = null;

/**
 * The official Worker has one operator-owned public address. It is injected by
 * the owning deploy target; deriving it from the request host would let an
 * alias or service binding silently become the product's advertised identity.
 */
export function requirePublicOrigin(env: { readonly PUBLIC_ORIGIN?: string | undefined }): string {
  const origin = env.PUBLIC_ORIGIN?.trim();
  if (!origin) throw new Error("PUBLIC_ORIGIN is required for the official Worker");
  return origin;
}

export function resolvePublicWorkerImplementationIdentity(
  env: Pick<WorkerEnv, "TAKOSERVER_WORKER_ARTIFACT_DIGEST">,
  embedded:
    | PublicFormImplementationIdentity
    | undefined = embeddedPublicFormImplementationIdentity(),
): PublicWorkerImplementationIdentity | undefined {
  const artifact = env.TAKOSERVER_WORKER_ARTIFACT_DIGEST;
  if (artifact === undefined && embedded === undefined) return undefined;
  if (artifact === undefined || embedded === undefined) {
    throw new TypeError("public Worker Form implementation identity is incomplete");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(artifact)) {
    throw new TypeError("public Worker Form implementation identity is incomplete");
  }
  return { workerArtifactDigest: artifact as `sha256:${string}`, ...embedded };
}

/**
 * No dedicated fields means no route. Once either dedicated field appears,
 * every provenance and policy field is required before D1 is constructed.
 */
export function workerIntegrationE2eCredentialAuthority(
  env: Pick<
    WorkerEnv,
    | "WORKER_VERSION"
    | "OPERATOR_PUBLIC_JWK"
    | "OPERATOR_IDENTITY_PUBLIC_JWK"
    | "TAKOSERVER_ENVIRONMENT"
    | "TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK"
    | "TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID"
    | "TAKOSERVER_SOURCE_COMMIT"
    | "TAKOSERVER_WORKER_ARTIFACT_DIGEST"
    | "TAKOSERVER_SIGNING_KEY_ID"
    | "TAKOSERVER_SIGNING_KEY"
  >,
): IntegrationE2eCredentialAuthorityConfig | undefined {
  const enabled =
    env.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK !== undefined ||
    env.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID !== undefined;
  if (!enabled) return undefined;
  const values = [
    env.TAKOSERVER_ENVIRONMENT,
    env.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK,
    env.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID,
    env.TAKOSERVER_SOURCE_COMMIT,
    env.TAKOSERVER_WORKER_ARTIFACT_DIGEST,
    env.WORKER_VERSION?.id,
  ];
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError("integration E2E credential authority configuration is incomplete");
  }
  if (env.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID !== INTEGRATION_E2E_ORGANIZATION_ID) {
    throw new TypeError(
      `integration E2E credential authority organization must be ${INTEGRATION_E2E_ORGANIZATION_ID}`,
    );
  }
  const resolved = resolveIntegrationE2eCredentialAuthorityConfig({
    environment: env.TAKOSERVER_ENVIRONMENT as "integration",
    publicJwk: env.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK as string,
    organizationId: env.TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID as string,
    sourceCommit: env.TAKOSERVER_SOURCE_COMMIT as string,
    artifactDigest: env.TAKOSERVER_WORKER_ARTIFACT_DIGEST as `sha256:${string}`,
    publicWorkerVersionId: env.WORKER_VERSION.id,
  });
  if (!resolved) throw new TypeError("integration E2E credential authority is unavailable");
  const operatorKeys = operatorCredentialKeys(env);
  if (
    operatorKeys.identity?.x === resolved.publicJwk.x ||
    operatorKeys.settlement?.x === resolved.publicJwk.x
  ) {
    throw new TypeError(
      "integration E2E API-key authority must not reuse a sign-in or funding key",
    );
  }
  const signingPublicJwk = configuredSigningPublicJwk(
    env.TAKOSERVER_SIGNING_KEY_ID,
    env.TAKOSERVER_SIGNING_KEY,
  );
  if (signingPublicJwk.x === resolved.publicJwk.x) {
    throw new TypeError("integration E2E API-key authority must not reuse the runtime signing key");
  }
  return resolved;
}

function configuredSigningPublicJwk(
  keyId: string | undefined,
  privateJwk: string | undefined,
): JsonWebKey & { readonly x: string } {
  if (!keyId || !privateJwk) {
    throw new TypeError(
      "integration E2E API-key authority requires the configured runtime signing key",
    );
  }
  return readSigningPublicJwk(privateJwk);
}

function readSigningPublicJwk(privateJwk: string): JsonWebKey & { readonly x: string } {
  let value: unknown;
  try {
    value = JSON.parse(privateJwk);
  } catch {
    throw new TypeError("runtime signing key public half is unavailable");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).kty !== "OKP" ||
    (value as Record<string, unknown>).crv !== "Ed25519" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(String((value as Record<string, unknown>).x))
  ) {
    throw new TypeError("runtime signing key public half is unavailable");
  }
  const publicJwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: (value as Record<string, unknown>).x as string,
  } satisfies JsonWebKey & { readonly x: string };
  return publicJwk;
}

async function proveSigningPublicJwk(privateJwk: string, privateKey: CryptoKey): Promise<void> {
  const publicJwk = readSigningPublicJwk(privateJwk);
  try {
    const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const message = new TextEncoder().encode("takoserver.integration-e2e.signing-separation@v1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) throw new Error();
  } catch {
    throw new TypeError("runtime signing key cannot prove its configured public half");
  }
}

async function appFor(env: WorkerEnv, origin: string): Promise<App> {
  if (cached?.env === env) return cached.app;
  const signingKey = await loadSigningKey(
    env.TAKOSERVER_SIGNING_KEY_ID,
    env.TAKOSERVER_SIGNING_KEY,
  );
  const integrationE2eCredentialAuthority = workerIntegrationE2eCredentialAuthority(env);
  if (integrationE2eCredentialAuthority) {
    if (!signingKey || !env.TAKOSERVER_SIGNING_KEY) {
      throw new TypeError(
        "integration E2E API-key authority requires the configured runtime signing key",
      );
    }
    await proveSigningPublicJwk(env.TAKOSERVER_SIGNING_KEY, signingKey.privateKey);
  }
  const edge = await buildEdgeForms();
  const currentCandidates = currentTakoformCandidates();
  const implementationIdentity = resolvePublicWorkerImplementationIdentity(env);
  const { identity, identityProviders, settlement, checkout } = workerCredentials(env);
  const sql = createD1Sql(env.STATE_DB);
  const objects = createR2ObjectStore(env.OBJECTS);
  const clock = () => new Date();
  const randomId = () => crypto.randomUUID();
  const runtimeInputs = env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING
    ? createRuntimeInputAuthority({
        sql,
        sealKeys: await parseRuntimeInputSealKeyRing(env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING),
        origins: createTakoformRuntimeInputOriginAuthority(createTakoformStore(sql, clock)),
        clock,
        randomId,
      })
    : undefined;
  const artifacts = createTakoformArtifacts({
    sql,
    objects,
    clock,
    randomId,
  });
  const dataServices = createWorkerDataServices(env);
  const deployment = createWorkerProductionComposition({
    env,
    forms: currentCandidates.forms,
    retainedForms: edge.forms,
    artifacts: {
      manifest: (tenantRef, digest) => artifacts.resolveManifest(tenantRef, digest),
      async blob(digest) {
        const stored = await objects.get(`art/${digest.slice("sha256:".length)}`);
        return stored ? new Uint8Array(await new Response(stored.body).arrayBuffer()) : null;
      },
    },
    ...(dataServices.s3 ? { s3CredentialIssuer: dataServices.s3 } : {}),
    ...(runtimeInputs ? { runtimeInputs: runtimeInputs.leases } : {}),
    now: new Date(),
  });
  const app = buildApp({
    sql,
    objects,
    publicWorkerVersionId: env.WORKER_VERSION.id,
    ...(implementationIdentity
      ? {
          formImplementationDigest: implementationIdentity.implementationDigest,
        }
      : {}),
    ...(integrationE2eCredentialAuthority ? { integrationE2eCredentialAuthority } : {}),
    ...(runtimeInputs ? { runtimeInputs } : {}),
    artifacts,
    workerModuleInspector: createJavaScriptWorkerModuleInspector(),
    ...(signingKey ? { signingKey } : {}),
    identity,
    identityProviders,
    settlement,
    ...(checkout ? { checkout } : {}),
    ...dataServices,
    publicOrigin: origin,
    ...(env.TAKOSERVER_CONSOLE_ORIGIN ? { consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN } : {}),
    ...(env.TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN
      ? { sponsorshipServiceToken: env.TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN }
      : {}),
    forms: currentCandidates.forms,
    bindings: currentCandidates.bindings,
    hostForms: currentCandidates.forms,
    hostBindings: currentCandidates.bindings,
    providers: deployment.providers,
    providerPacks: deployment.providerPacks,
    offerings: deployment.offerings,
    ...(deployment.standardServiceResolver
      ? { standardServiceResolver: deployment.standardServiceResolver }
      : {}),
  });
  cached = { env, app };
  return app;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const origin = requirePublicOrigin(env);
    const app = await appFor(env, origin);
    return await app.fetch(request);
  },

  /** Background settlement: expiring reservations return their holds. */
  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    const app = await appFor(env, requirePublicOrigin(env));
    await app.tick();
  },
};
