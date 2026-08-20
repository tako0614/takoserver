import { type App, buildApp } from "./app.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { resolveIdentity } from "./identity-setup.ts";
import { createR2ObjectStore } from "./objects-r2.ts";
import { createOperatorSettlement } from "./operator-credentials.ts";
import { resolvePayment } from "./payment-setup.ts";
import type { CloudflareWorkersAiBinding } from "./providers/cloudflare-workers-ai.ts";
import { loadSigningKey } from "./signing-key.ts";
import { createD1Sql } from "./sql-d1.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
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

interface WorkerEnv {
  readonly AI?: CloudflareWorkersAiBinding;
  readonly STATE_DB: Parameters<typeof createD1Sql>[0];
  readonly OBJECTS: Parameters<typeof createR2ObjectStore>[0];
  readonly PUBLIC_ORIGIN?: string;
  /** Where this deployment's console is served, if it has one. */
  readonly TAKOSERVER_CONSOLE_ORIGIN?: string;
  /** Public half of the operator key, as an Ed25519 JWK. */
  readonly OPERATOR_PUBLIC_JWK?: string;
  /** Public OAuth client id. Its presence turns Google sign-in on. */
  readonly GOOGLE_CLIENT_ID?: string;
  /** The Cloudflare account this deployment provisions in. */
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  /** Scoped Cloudflare API token. A secret, never a var. */
  readonly CLOUDFLARE_API_TOKEN?: string;
  /** DNS zones this deployment may attach Workers to, as JSON. */
  readonly TAKOSERVER_ZONES?: string;
  /** Stripe secret key. Its presence is what lets a customer pay. */
  readonly STRIPE_SECRET_KEY?: string;
  /** Key id whose public half is registered for verification. */
  readonly TAKOSERVER_SIGNING_KEY_ID?: string;
  /** Private half, as an Ed25519 JWK. A secret. */
  readonly TAKOSERVER_SIGNING_KEY?: string;
  /** Private model mapping and retail price configuration. */
  readonly TAKOSERVER_AI_MODELS?: string;
  /** Metadata identifying the R2 parent token used for temporary credentials. */
  readonly TAKOSERVER_R2_PARENT_ACCESS_KEY_ID?: string;
  /** R2 parent token. A secret distinct from the general Cloudflare API token. */
  readonly TAKOSERVER_R2_PARENT_TOKEN?: string;
  /** Versioned, non-secret commercial composition emitted by takoserver-private. */
  readonly TAKOSERVER_OBJECT_BUCKET_SUPPLIES?: string;
  /** Reviewed Cloudflare sales for released identity Forms other than storage. */
  readonly TAKOSERVER_EDGE_SUPPLIES?: string;
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
function credentials(env: WorkerEnv) {
  const raw = env.OPERATOR_PUBLIC_JWK;
  const publicKeyJwk = raw
    ? (JSON.parse(raw) as { kty: string; crv: string; x: string })
    : undefined;
  const identity = resolveIdentity({
    googleClientId: env.GOOGLE_CLIENT_ID,
    operatorPublicKeyJwk: publicKeyJwk,
  });
  const payment = resolvePayment({
    stripeSecretKey: env.STRIPE_SECRET_KEY,
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
      (publicKeyJwk
        ? createOperatorSettlement({ publicKeyJwk })
        : {
            async verify(): Promise<never> {
              throw new Error("settlement credentials are not configured");
            },
          }),
  };
}

let cached: { readonly env: WorkerEnv; readonly app: App } | null = null;

async function appFor(env: WorkerEnv, origin: string): Promise<App> {
  if (cached?.env === env) return cached.app;
  const edge = await buildEdgeForms();
  const { identity, identityProviders, settlement, checkout } = credentials(env);
  const sql = createD1Sql(env.STATE_DB);
  const objects = createR2ObjectStore(env.OBJECTS);
  const artifacts = createTakoformArtifacts({
    sql,
    objects,
    clock: () => new Date(),
    randomId: () => crypto.randomUUID(),
  });
  const signingKey = await loadSigningKey(
    env.TAKOSERVER_SIGNING_KEY_ID,
    env.TAKOSERVER_SIGNING_KEY,
  );
  const dataServices = createWorkerDataServices(env);
  const deployment = createWorkerProductionComposition({
    env,
    forms: edge.forms,
    artifacts: {
      manifest: (tenantRef, digest) => artifacts.resolveManifest(tenantRef, digest),
      async blob(digest) {
        const stored = await objects.get(`art/${digest.slice("sha256:".length)}`);
        return stored ? new Uint8Array(await new Response(stored.body).arrayBuffer()) : null;
      },
    },
    ...(dataServices.s3 ? { s3CredentialIssuer: dataServices.s3 } : {}),
    now: new Date(),
  });
  const app = buildApp({
    sql,
    objects,
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
    forms: edge.forms,
    bindings: edge.bindings,
    providers: deployment.providers,
    providerPacks: deployment.providerPacks,
    offerings: deployment.offerings,
  });
  cached = { env, app };
  return app;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const origin = env.PUBLIC_ORIGIN ?? new URL(request.url).origin;
    const app = await appFor(env, origin);
    return await app.fetch(request);
  },

  /** Background settlement: expiring reservations return their holds. */
  async scheduled(_event: unknown, env: WorkerEnv): Promise<void> {
    const app = await appFor(env, env.PUBLIC_ORIGIN ?? "https://api.takoserver.com");
    await app.tick();
  },
};
