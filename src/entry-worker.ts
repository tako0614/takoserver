import { type App, buildApp } from "./app.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { resolveIdentity } from "./identity-setup.ts";
import { createR2ObjectStore } from "./objects-r2.ts";
import { createOperatorSettlement } from "./operator-credentials.ts";
import { resolvePayment } from "./payment-setup.ts";
import type { Provider } from "./provider-port.ts";
import { CloudflareProvider, type CloudflareZone } from "./providers/cloudflare.ts";
import { createRemoteProvider } from "./providers/remote.ts";
import { createD1Sql } from "./sql-d1.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";

/**
 * The Cloudflare Workers entry.
 *
 * This serves the whole product except provisioning. Creating a bucket, a
 * database, or a Worker needs `api.cloudflare.com` and an account token, and
 * the bundle gate forbids both here — a Worker that could reach them would
 * hand that reach to everything sharing its bundle. Provisioning therefore
 * runs on the self-hosted entry, and an apply that arrives here is refused
 * rather than half-performed.
 *
 * Accounts, the wallet, the reseller lane, artifact upload, and every Takoform
 * read are served normally.
 */

interface WorkerEnv {
  readonly STATE_DB: Parameters<typeof createD1Sql>[0];
  readonly OBJECTS: Parameters<typeof createR2ObjectStore>[0];
  readonly PUBLIC_ORIGIN?: string;
  /** Where this deployment's console is served, if it has one. */
  readonly TAKOSERVER_CONSOLE_ORIGIN?: string;
  /** Public half of the operator key, as an Ed25519 JWK. */
  readonly OPERATOR_PUBLIC_JWK?: string;
  /** Public OAuth client id. Its presence turns Google sign-in on. */
  readonly GOOGLE_CLIENT_ID?: string;
  /** Origin of the provisioner this deployment runs, for providers that need one. */
  readonly TAKOSERVER_PROVISIONER_ORIGIN?: string;
  /** Credential this deployment issued to itself for that provisioner. */
  readonly TAKOSERVER_PROVISIONER_TOKEN?: string;
  /** The Cloudflare account this deployment provisions in. */
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
  /** Scoped Cloudflare API token. A secret, never a var. */
  readonly CLOUDFLARE_API_TOKEN?: string;
  /** DNS zones this deployment may attach Workers to, as JSON. */
  readonly TAKOSERVER_ZONES?: string;
  /** Stripe secret key. Its presence is what lets a customer pay. */
  readonly STRIPE_SECRET_KEY?: string;
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

/**
 * What this deployment can provision on.
 *
 * Cloudflare is provisioned from here, with a scoped token held as a secret —
 * see docs/adr/0001-provision-from-the-worker.md, which retired the rule that
 * kept it out. A remote provisioner remains available for a provider that
 * cannot live at the edge; both may be present, and neither is required.
 */
function provisioning(
  env: WorkerEnv,
  edge: Awaited<ReturnType<typeof buildEdgeForms>>,
  objects: ReturnType<typeof createR2ObjectStore>,
  artifacts: ReturnType<typeof createTakoformArtifacts>,
): readonly Provider[] {
  const providers: Provider[] = [];

  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    const token = env.CLOUDFLARE_API_TOKEN;
    providers.push(
      new CloudflareProvider({
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        offerings: edge.providerOfferings,
        authorize: () => `Bearer ${token}`,
        // Where tenants may be served. A platform suffix is the free address
        // every tenant gets; a customer domain appears here only after the
        // operator has confirmed the customer controls it.
        zones: JSON.parse(env.TAKOSERVER_ZONES ?? "[]") as CloudflareZone[],
        artifacts: {
          manifest: (tenantRef, digest) => artifacts.resolveManifest(tenantRef, digest),
          async blob(digest) {
            const stored = await objects.get(`art/${digest.slice("sha256:".length)}`);
            return stored ? new Uint8Array(await new Response(stored.body).arrayBuffer()) : null;
          },
        },
      }),
    );
  }

  if (env.TAKOSERVER_PROVISIONER_ORIGIN && env.TAKOSERVER_PROVISIONER_TOKEN) {
    const token = env.TAKOSERVER_PROVISIONER_TOKEN;
    providers.push(
      createRemoteProvider({
        origin: env.TAKOSERVER_PROVISIONER_ORIGIN,
        offerings: edge.providerOfferings,
        authorize: () => `Bearer ${token}`,
      }),
    );
  }

  return providers;
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
  const app = buildApp({
    sql,
    objects,
    artifacts,
    identity,
    identityProviders,
    settlement,
    ...(checkout ? { checkout } : {}),
    publicOrigin: origin,
    ...(env.TAKOSERVER_CONSOLE_ORIGIN ? { consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN } : {}),
    forms: edge.forms,
    providers: provisioning(env, edge, objects, artifacts),
    offerings: edge.offerings,
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
