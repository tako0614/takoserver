import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { buildApp } from "./app.ts";
import { MIGRATIONS } from "./db-schema.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { resolveIdentity } from "./identity-setup.ts";
import { createMemoryObjectStore } from "./objects-mem.ts";
import { createR2HttpObjectStore } from "./objects-r2-http.ts";
import { createOperatorSettlement } from "./operator-credentials.ts";
import { resolvePayment } from "./payment-setup.ts";
import { CloudflareProvider } from "./providers/cloudflare.ts";
import { createProvisionerEndpoint } from "./provisioner-endpoint.ts";
import { createD1HttpSql } from "./sql-d1-http.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";

/**
 * The self-hosted entry, and the only one that can provision.
 *
 * Publishing a Worker or creating a database means calling a cloud's API with
 * an account credential. That is deliberately impossible inside the deployed
 * Worker, so this process is where provisioning lives — and it is the same
 * shape a future AWS or bare-metal backend will plug into, because it talks to
 * the provider port rather than to any one cloud.
 *
 * Run it with:
 *
 *   TAKOSERVER_PUBLIC_ORIGIN=https://api.example.com \
 *   TAKOSERVER_DB=/var/lib/takoserver/state.sqlite \
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
 *   bun src/entry-bun.ts
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * The account credential, read at the moment it is used.
 *
 * A token captured once at startup is a token that expires while the process
 * keeps running — every call then fails with an authorization error that looks
 * nothing like "your credential aged out". Reading a file per call lets an
 * operator rotate or refresh without a restart.
 */
function cloudflareToken(): string {
  const path = process.env.TAKOSERVER_CF_TOKEN_FILE;
  if (!path) return required("CLOUDFLARE_API_TOKEN");
  return readFileSync(path, "utf8").trim();
}

const publicOrigin = process.env.TAKOSERVER_PUBLIC_ORIGIN ?? "http://localhost:8787";
const databasePath = process.env.TAKOSERVER_DB ?? ":memory:";
const port = Number(process.env.PORT ?? 8787);

/**
 * State comes from the same D1 the Worker serves when one is configured. A
 * provisioner with its own database would be a second product with a second
 * truth: an organization created through the public API would be invisible to
 * the process that provisions for it.
 */
const sharedDatabaseId = process.env.TAKOSERVER_D1_DATABASE_ID;
const sql = sharedDatabaseId
  ? createD1HttpSql({
      accountId: required("CLOUDFLARE_ACCOUNT_ID"),
      databaseId: sharedDatabaseId,
      authorize: () => `Bearer ${cloudflareToken()}`,
    })
  : (() => {
      const database = new Database(databasePath);
      // Applying every migration is safe only on a fresh file; a durable
      // deployment is migrated by its own operator step, exactly as D1 is.
      if (databasePath === ":memory:") {
        for (const migration of MIGRATIONS) database.exec(migration.sql);
      }
      return createSqliteSql(database);
    })();
// Bytes come from the same bucket the Worker writes to, for the same reason
// the rows do: a bundle committed through the public API has to be there when
// the provisioner goes to publish it.
const sharedBucket = process.env.TAKOSERVER_R2_BUCKET;
const objects = sharedBucket
  ? createR2HttpObjectStore({
      accountId: required("CLOUDFLARE_ACCOUNT_ID"),
      bucketName: sharedBucket,
      authorize: () => `Bearer ${cloudflareToken()}`,
    })
  : createMemoryObjectStore();
const clock = () => new Date();
const edge = await buildEdgeForms();

// The provider reads committed bundles through the same artifact store the
// Host writes them to, so a Worker can only be published from bytes a tenant
// actually uploaded and had verified.
const artifactStore = createTakoformArtifacts({
  sql,
  objects,
  clock,
  randomId: () => crypto.randomUUID(),
});

const providers = process.env.CLOUDFLARE_ACCOUNT_ID
  ? [
      new CloudflareProvider({
        accountId: required("CLOUDFLARE_ACCOUNT_ID"),
        offerings: edge.providerOfferings,
        authorize: () => `Bearer ${cloudflareToken()}`,
        // Where tenants may be served. A platform suffix is the free address
        // every tenant gets; a customer domain is added here only after the
        // operator has confirmed the customer controls it.
        zones: JSON.parse(process.env.TAKOSERVER_ZONES ?? "[]") as {
          suffix: string;
          zoneId: string;
          tenantRef?: string;
        }[],
        artifacts: {
          async manifest(tenantRef, digest) {
            return await artifactStore.resolveManifest(tenantRef, digest);
          },
          async blob(digest) {
            const stored = await objects.get(`art/${digest.slice("sha256:".length)}`);
            return stored ? new Uint8Array(await new Response(stored.body).arrayBuffer()) : null;
          },
        },
      }),
    ]
  : [];

const operatorJwk = process.env.TAKOSERVER_OPERATOR_PUBLIC_JWK;
const unconfigured = {
  async verify(): Promise<never> {
    throw new Error("operator credentials are not configured");
  },
};
const publicKeyJwk = operatorJwk
  ? (JSON.parse(operatorJwk) as { kty: string; crv: string; x: string })
  : undefined;

const payment = resolvePayment({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  consoleOrigin: process.env.TAKOSERVER_CONSOLE_ORIGIN,
});

const identity = resolveIdentity({
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  operatorPublicKeyJwk: publicKeyJwk,
});

/**
 * The half that can reach a cloud account also answers for it.
 *
 * Served in front of the product's router because it is not part of the
 * product: no tenant, no billing, no lifecycle — a provider call in, a
 * classified ticket out. It is served only when a credential is configured.
 */
const provision = createProvisionerEndpoint({
  providers,
  credential: process.env.TAKOSERVER_PROVISIONER_TOKEN,
});

const app = buildApp({
  sql,
  objects,
  identity: identity.verifier,
  identityProviders: identity.providers,
  settlement:
    payment.settlement ??
    (publicKeyJwk ? createOperatorSettlement({ publicKeyJwk }) : unconfigured),
  ...(payment.checkout ? { checkout: payment.checkout } : {}),
  publicOrigin,
  ...(process.env.TAKOSERVER_CONSOLE_ORIGIN
    ? { consoleOrigin: process.env.TAKOSERVER_CONSOLE_ORIGIN }
    : {}),
  forms: edge.forms,
  providers,
  offerings: edge.offerings,
  artifacts: artifactStore,
  clock,
});

// Background settlement. One pass at a time: overlapping ticks would compete
// for the same rows and waste the claim they cannot win.
let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  app
    .tick()
    .catch((error: unknown) => console.error("tick failed", error))
    .finally(() => {
      ticking = false;
    });
}, 30_000);

Bun.serve({
  port,
  // Longer than the default, because publishing a site means uploading its
  // files and a request that is doing real work is not an idle one.
  idleTimeout: 120,
  async fetch(request) {
    return (await provision(request)) ?? (await app.fetch(request));
  },
});
console.log(
  `takoserver listening on :${port} as ${publicOrigin} ` +
    `(${providers.length === 0 ? "no provisioning backend" : "cloudflare provisioning"})`,
);
