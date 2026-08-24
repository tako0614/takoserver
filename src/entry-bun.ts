import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildApp } from "./app.ts";
import { buildEdgeForms, objectBucketProviderOffering } from "./edge-forms.ts";
import { resolveIdentity } from "./identity-setup.ts";
import { migrateSqlite } from "./migrate-sqlite.ts";
import { compileObjectBucketDeployment } from "./object-bucket-deployment.ts";
import { createFileObjectStore } from "./objects-fs.ts";
import { createMemoryObjectStore } from "./objects-mem.ts";
import { createR2HttpObjectStore } from "./objects-r2-http.ts";
import { createOperatorSettlement } from "./operator-credentials.ts";
import { ensureOperatorKey, signOperatorAssertion } from "./operator-key.ts";
import { resolvePayment } from "./payment-setup.ts";
import type { ProviderPack } from "./provider-pack.ts";
import type { Provider } from "./provider-port.ts";
import { CloudflareProvider } from "./providers/cloudflare.ts";
import { createOpenAiGateway, parseOpenAiModelConfig } from "./providers/openai.ts";
import { createProvisionerEndpoint } from "./provisioner-endpoint.ts";
import { createSelfhostComposition } from "./selfhost-composition.ts";
import { ensureSigningKey, loadSigningKey } from "./signing-key.ts";
import { createD1HttpSql } from "./sql-d1-http.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import { createProductionStandardServiceResolver } from "./standard-service-production.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { currentTakoformCatalog } from "./takoform/current-catalog.ts";
import { createJavaScriptWorkerModuleInspector } from "./takoform/worker-module-inspector.ts";
import { createWorkerdRuntime } from "./workerd-runtime.ts";
import { createWorkerdSupervisor, findWorkerd } from "./workerd-supervisor.ts";

/**
 * The self-hosted entry and its local or account-backed provisioners.
 *
 * This process can own local state and long-running provider SDKs. The deployed
 * Worker may provision through edge-safe adapters too; both entries assemble
 * the same Provider Pack and Catalog Compiler boundary rather than carrying
 * separate product semantics.
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

function aiGateway() {
  const baseUrl = process.env.TAKOSERVER_AI_BASE_URL;
  const models = process.env.TAKOSERVER_AI_MODELS;
  const tokenFile = process.env.TAKOSERVER_AI_TOKEN_FILE;
  const token = process.env.TAKOSERVER_AI_TOKEN;
  if (!baseUrl && !models && !tokenFile && !token) return undefined;
  if (!baseUrl || !models || (!tokenFile && !token)) {
    throw new Error(
      "TAKOSERVER_AI_BASE_URL, TAKOSERVER_AI_MODELS, and one AI token source are required together",
    );
  }
  return createOpenAiGateway({
    baseUrl,
    models: parseOpenAiModelConfig(models),
    authorize: () => {
      const secret = tokenFile ? readFileSync(tokenFile, "utf8").trim() : token;
      if (!secret) throw new Error("AI upstream token is empty");
      return `Bearer ${secret}`;
    },
  });
}

const publicOrigin = process.env.TAKOSERVER_PUBLIC_ORIGIN ?? "http://localhost:8787";
const port = Number(process.env.PORT ?? 8787);

/** Everything this machine keeps lives under one directory. */
const dataRoot = process.env.TAKOSERVER_DATA_ROOT ?? ".takoserver";

// Organizations, keys, and the ledger are as durable as the files are: a
// machine that forgets who its customers are, and what they are owed, on
// restart is not a platform. Memory is kept for tests, which say so by
// asking for it.
const databasePath =
  process.env.TAKOSERVER_DB ??
  (dataRoot === ":memory:" ? ":memory:" : `${dataRoot}/control.sqlite`);
if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

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
      // A self-hosted deployment starts with an empty file, so it is brought up
      // to this build's schema here. Forward only and recorded, so running it
      // again applies nothing and a database from a newer build is refused
      // rather than repaired.
      const migrated = migrateSqlite(database);
      if (migrated.applied.length > 0) {
        process.stdout.write(
          `applied ${migrated.applied.length} migration(s): ${migrated.applied.join(", ")}\n`,
        );
      }
      return createSqliteSql(database);
    })();
// Bytes come from the same bucket the Worker writes to, for the same reason
// the rows do: a bundle committed through the public API has to be there when
// the provisioner goes to publish it.
const workerd = createWorkerdSupervisor({
  binary: process.env.TAKOSERVER_WORKERD_BINARY ?? findWorkerd(process.cwd()),
  spawn: (command) => Bun.spawn(command as string[], { stdout: "inherit", stderr: "inherit" }),
  log: (message) => process.stdout.write(`${message}\n`),
});

const sharedBucket = process.env.TAKOSERVER_R2_BUCKET;
const objects = sharedBucket
  ? createR2HttpObjectStore({
      accountId: required("CLOUDFLARE_ACCOUNT_ID"),
      bucketName: sharedBucket,
      authorize: () => `Bearer ${cloudflareToken()}`,
    })
  : // No shared bucket means this is a machine standing on its own, and a
    // self-hosted deployment that forgets every customer's files on restart is
    // not storage. Memory is kept for tests, which say so by asking for it.
    process.env.TAKOSERVER_OBJECTS_IN_MEMORY === "1"
    ? createMemoryObjectStore()
    : createFileObjectStore({ root: dataRoot });
const clock = () => new Date();
const edge = await buildEdgeForms();
const currentHost = currentTakoformCatalog(edge);

// The provider reads committed bundles through the same artifact store the
// Host writes them to, so a Worker can only be published from bytes a tenant
// actually uploaded and had verified.
const artifactStore = createTakoformArtifacts({
  sql,
  objects,
  clock,
  randomId: () => crypto.randomUUID(),
});
const providerArtifacts = {
  manifest: (tenantRef: string, digest: string) => artifactStore.resolveManifest(tenantRef, digest),
  async blob(digest: string) {
    const stored = await objects.get(`art/${digest.slice("sha256:".length)}`);
    return stored ? new Uint8Array(await new Response(stored.body).arrayBuffer()) : null;
  },
};

/**
 * What this machine can use to drain historical Deployments.
 *
 * A Cloudflare account if one is configured; otherwise the machine itself. The
 * second is what makes self-hosting real rather than architectural: without a
 * provider, every apply answers that the backend is unavailable, which is true
 * and leaves nothing to run.
 *
 * Released provider Forms remain installed for existing Deployment
 * observation/deletion, but publish no current catalog Offering. Stable S3 is
 * supplied through the Host-owned standard-service resolver below.
 */
let providers: readonly Provider[];
let providerPacks: readonly ProviderPack[];
let offerings: ReturnType<typeof compileObjectBucketDeployment>["offerings"];
if (process.env.CLOUDFLARE_ACCOUNT_ID) {
  const objectBucketOffering = objectBucketProviderOffering(edge.objectBucket.form, {
    id: "storage.object.standard",
    displayName: "Object bucket",
    regions: ["global"],
  });
  const objectBucketProvider = new CloudflareProvider({
    accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    offerings: [objectBucketOffering],
    authorize: () => `Bearer ${cloudflareToken()}`,
    // Where tenants may be served. A platform suffix is the free address
    // every tenant gets; a customer domain is added here only after the
    // operator has confirmed the customer controls it.
    zones: JSON.parse(process.env.TAKOSERVER_ZONES ?? "[]") as {
      suffix: string;
      zoneId: string;
      tenantRef?: string;
    }[],
    artifacts: providerArtifacts,
  });
  const deployment = compileObjectBucketDeployment({
    form: edge.objectBucket.form,
    provider: objectBucketProvider,
    providerType: "cloudflare",
    offeringId: objectBucketOffering.id,
    displayName: objectBucketOffering.displayName,
    regions: ["global"],
    providerInstallation: {
      id: "cloudflare.primary",
      providerPackRef: objectBucketProvider.id,
      supplyContractRef: "cloudflare.operator-contract",
      state: "active",
      regions: [{ id: "global", capacity: "available" }],
    },
    supplyContract: {
      id: "cloudflare.operator-contract",
      providerType: "cloudflare",
      permittedResourceClasses: ["storage.object"],
      deliveryModes: ["embedded-binding"],
      customerAccess: "operator-only",
      whiteLabelAllowed: false,
      endUserTermsRequired: false,
      regions: ["global"],
      validFrom: "2026-01-01T00:00:00.000Z",
      evidenceRef: "operator-contract:cloudflare",
    },
    pricePlan: {
      id: "storage.object.standard.price-v1",
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 0 },
      meters: [],
    },
    placement: {
      deliveryMode: "embedded-binding",
      supportPolicyRef: "support:operator:standard",
      abusePolicyRef: "abuse:operator:standard",
      portability: {
        api: "portable",
        exportFormats: ["s3.object-set.takoform.com/v1"],
        importFormats: ["s3.object-set.takoform.com/v1"],
        migrationModes: ["offline", "online"],
      },
      isolation: "dedicated-resource",
    },
    now: clock(),
  });
  providers = [objectBucketProvider];
  providerPacks = deployment.providerPacks;
  // Keep the released provider installed only to drain recorded Deployments.
  // Stable S3 is supplied out of band; a beta ObjectBucket is no longer a
  // current `/v1` sale or `/provision/v1` creation authority.
  offerings = [];
} else {
  const composition = createSelfhostComposition({
    edge,
    dataRoot,
    runtime: createWorkerdRuntime({
      root: dataRoot,
      ...(process.env.TAKOSERVER_WORKERD_PORT
        ? { port: Number(process.env.TAKOSERVER_WORKERD_PORT) }
        : {}),
      async onReload(configPath) {
        // Started on the first publish rather than at boot, so a machine
        // that never runs a Worker never runs a runtime for one. After
        // that it watches the file itself: one tenant's deploy must not
        // bounce every other tenant's in-flight requests.
        await workerd.ensure(configPath);
      },
    }),
    artifacts: providerArtifacts,
    edgeForms: process.env.TAKOSERVER_EDGE_FORMS !== "0",
    ...(process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX
      ? { workerEndpointSuffix: process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX }
      : {}),
    ...(process.env.TAKOSERVER_SUFFIXES
      ? { suffixes: process.env.TAKOSERVER_SUFFIXES.split(",").map((entry) => entry.trim()) }
      : {}),
    now: clock(),
  });
  providers = [composition.provider];
  providerPacks = composition.providerPacks;
  offerings = composition.offerings;
}

const unconfigured = {
  async verify(): Promise<never> {
    throw new Error("operator credentials are not configured");
  },
};

// A machine with no identity provider would advertise no way in and refuse
// every sign-in, so it mints an operator key and offers that instead. A shared
// deployment is given its public half and generates nothing.
const operatorKeyPath = join(dataRoot, "operator-key.jwk");
const publicKeyJwk = await ensureOperatorKey({
  configured: process.env.TAKOSERVER_OPERATOR_PUBLIC_JWK,
  hasIdentityProvider:
    Boolean(process.env.TAKOS_ID_ISSUER && process.env.TAKOS_ID_CLIENT_ID) ||
    Boolean(process.env.GOOGLE_CLIENT_ID) ||
    Boolean(sharedDatabaseId),
  path: operatorKeyPath,
  readFile: (path) =>
    readFile(path, "utf8").then(
      (text) => text,
      () => null,
    ),
  async writeFile(path, contents) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode: 0o600 });
    process.stdout.write(`generated an operator key at ${path}\n`);
  },
});

const payment = resolvePayment({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  consoleOrigin: process.env.TAKOSERVER_CONSOLE_ORIGIN,
});

const identity = resolveIdentity({
  ...(process.env.TAKOS_ID_ISSUER && process.env.TAKOS_ID_CLIENT_ID
    ? {
        takosId: {
          issuer: process.env.TAKOS_ID_ISSUER,
          clientId: process.env.TAKOS_ID_CLIENT_ID,
        },
      }
    : {}),
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
  applyOfferingIds: offerings.map((offering) => offering.id),
});

// A shared deployment is given its key; a machine standing on its own makes
// one, keeps it under the data root, and registers the half that verifies it.
const signingKey = sharedDatabaseId
  ? await loadSigningKey(process.env.TAKOSERVER_SIGNING_KEY_ID, process.env.TAKOSERVER_SIGNING_KEY)
  : await ensureSigningKey({
      keyId: process.env.TAKOSERVER_SIGNING_KEY_ID ?? "takoserver-local",
      privateJwk: process.env.TAKOSERVER_SIGNING_KEY,
      path: join(dataRoot, "signing-key.jwk"),
      sql,
      readFile: (path) =>
        readFile(path, "utf8").then(
          (text) => text,
          () => null,
        ),
      async writeFile(path, contents) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, { mode: 0o600 });
        process.stdout.write(`generated a signing key at ${path}\n`);
      },
    });

const configuredAi = aiGateway();
const standardServiceResolver = createProductionStandardServiceResolver({
  ...(process.env.TAKOSERVER_STANDARD_SERVICE_SUPPLIES
    ? { raw: process.env.TAKOSERVER_STANDARD_SERVICE_SUPPLIES }
    : {}),
  ...(process.env.CLOUDFLARE_ACCOUNT_ID
    ? {
        cloudflare: {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
          authorize: () => `Bearer ${cloudflareToken()}`,
        },
      }
    : {}),
});
const app = buildApp({
  sql,
  objects,
  ...(signingKey ? { signingKey } : {}),
  identity: identity.verifier,
  identityProviders: identity.providers,
  ...(configuredAi ? { ai: configuredAi } : {}),
  settlement:
    payment.settlement ??
    (publicKeyJwk ? createOperatorSettlement({ publicKeyJwk }) : unconfigured),
  ...(payment.checkout ? { checkout: payment.checkout } : {}),
  publicOrigin,
  ...(process.env.TAKOSERVER_CONSOLE_ORIGIN
    ? { consoleOrigin: process.env.TAKOSERVER_CONSOLE_ORIGIN }
    : {}),
  forms: edge.forms,
  bindings: edge.bindings,
  hostForms: currentHost.forms,
  hostBindings: currentHost.bindings,
  ...(standardServiceResolver ? { standardServiceResolver } : {}),
  providers,
  providerPacks,
  offerings,
  artifacts: artifactStore,
  workerModuleInspector: createJavaScriptWorkerModuleInspector(),
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
    // Named from what is actually configured. A banner that says Cloudflare on
    // a machine with no account is the first thing an operator reads and the
    // first thing that misleads them.
    `(provisioning: ${providers.map((provider) => provider.id).join(", ") || "none"})`,
);

// Having minted the way in, say what it is. A machine that generates a key and
// leaves the operator to discover how to present it has automated the easy half.
if (identity.providers.some((provider) => provider.method === "operator-assertion")) {
  const stored = await readFile(operatorKeyPath, "utf8").catch(() => null);
  if (stored) {
    const assertion = await signOperatorAssertion({
      privateJwk: stored,
      claims: {
        purpose: "sign-in",
        provider: "google",
        subject: "operator",
        email: "operator@localhost",
        displayName: "Operator",
      },
      nowSeconds: Math.floor(Date.now() / 1_000),
      lifetimeSeconds: 600,
    });
    console.log(
      `\nno identity provider is configured, so this deployment signs you in as its operator.\n` +
        `open ${publicOrigin}/console and paste this (valid 10 minutes):\n\n${assertion}\n\n` +
        `later ones: bun scripts/operator-key.ts sign-in google operator operator@localhost Operator\n` +
        `  (with TAKOSERVER_OPERATOR_KEY=${operatorKeyPath})`,
    );
  }
}
