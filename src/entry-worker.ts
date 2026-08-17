import { type App, buildApp } from "./app.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { createR2ObjectStore } from "./objects-r2.ts";
import { createOperatorIdentity, createOperatorSettlement } from "./operator-credentials.ts";
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
  /** Public half of the operator key, as an Ed25519 JWK. */
  readonly OPERATOR_PUBLIC_JWK?: string;
}

/**
 * Sign-in and funding both need a fact the server cannot determine alone. When
 * an operator key is configured they are answered by the operator's signature;
 * when it is not, they refuse. Refusing is the point — a stub that said yes
 * would accept anyone and credit any amount while looking like a product.
 */
function operatorCredentials(env: WorkerEnv) {
  const raw = env.OPERATOR_PUBLIC_JWK;
  if (!raw) {
    const unconfigured = {
      async verify(): Promise<never> {
        throw new Error("operator credentials are not configured");
      },
    };
    return { identity: unconfigured, settlement: unconfigured };
  }
  const publicKeyJwk = JSON.parse(raw) as { kty: string; crv: string; x: string };
  return {
    identity: createOperatorIdentity({ publicKeyJwk }),
    settlement: createOperatorSettlement({ publicKeyJwk }),
  };
}

let cached: { readonly env: WorkerEnv; readonly app: App } | null = null;

async function appFor(env: WorkerEnv, origin: string): Promise<App> {
  if (cached?.env === env) return cached.app;
  const edge = await buildEdgeForms();
  const { identity, settlement } = operatorCredentials(env);
  const app = buildApp({
    sql: createD1Sql(env.STATE_DB),
    objects: createR2ObjectStore(env.OBJECTS),
    identity,
    settlement,
    publicOrigin: origin,
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
