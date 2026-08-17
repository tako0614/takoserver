import { Database } from "bun:sqlite";
import { buildApp } from "./app.ts";
import { MIGRATIONS } from "./db-schema.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { createMemoryObjectStore } from "./objects-mem.ts";
import { CloudflareProvider } from "./providers/cloudflare.ts";
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

const publicOrigin = process.env.TAKOSERVER_PUBLIC_ORIGIN ?? "http://localhost:8787";
const databasePath = process.env.TAKOSERVER_DB ?? ":memory:";
const port = Number(process.env.PORT ?? 8787);

const database = new Database(databasePath);
// Applying every migration is safe to repeat only on a fresh file; a durable
// deployment is migrated by its own operator step, exactly as D1 is.
if (databasePath === ":memory:") {
  for (const migration of MIGRATIONS) database.exec(migration.sql);
}
const sql = createSqliteSql(database);
const objects = createMemoryObjectStore();
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
        authorize: () => `Bearer ${required("CLOUDFLARE_API_TOKEN")}`,
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

const app = buildApp({
  sql,
  objects,
  identity: {
    async verify() {
      throw new Error("identity verification is not configured");
    },
  },
  settlement: {
    async verify() {
      throw new Error("settlement verification is not configured");
    },
  },
  publicOrigin,
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

Bun.serve({ port, fetch: app.fetch });
console.log(
  `takoserver listening on :${port} as ${publicOrigin} ` +
    `(${providers.length === 0 ? "no provisioning backend" : "cloudflare provisioning"})`,
);
