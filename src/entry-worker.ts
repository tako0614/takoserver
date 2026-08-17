import { type App, buildApp } from "./app.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { resolveIdentity } from "./identity-setup.ts";
import { createR2ObjectStore } from "./objects-r2.ts";
import { createOperatorSettlement } from "./operator-credentials.ts";
import { createD1Sql } from "./sql-d1.ts";

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
  return {
    identity: identity.verifier,
    identityProviders: identity.providers,
    settlement: publicKeyJwk
      ? createOperatorSettlement({ publicKeyJwk })
      : {
          async verify(): Promise<never> {
            throw new Error("settlement credentials are not configured");
          },
        },
  };
}

let cached: { readonly env: WorkerEnv; readonly app: App } | null = null;

async function appFor(env: WorkerEnv, origin: string): Promise<App> {
  if (cached?.env === env) return cached.app;
  const edge = await buildEdgeForms();
  const { identity, identityProviders, settlement } = credentials(env);
  const app = buildApp({
    sql: createD1Sql(env.STATE_DB),
    objects: createR2ObjectStore(env.OBJECTS),
    identity,
    identityProviders,
    settlement,
    publicOrigin: origin,
    ...(env.TAKOSERVER_CONSOLE_ORIGIN ? { consoleOrigin: env.TAKOSERVER_CONSOLE_ORIGIN } : {}),
    forms: edge.forms,
    // No providers: this entry cannot provision. See the note above.
    providers: [],
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
