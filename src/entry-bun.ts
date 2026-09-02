import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildApp } from "./app.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { resolveIdentity } from "./identity-setup.ts";
import { migrateSqlite } from "./migrate-sqlite.ts";
import { createFileObjectStore } from "./objects-fs.ts";
import { createMemoryObjectStore } from "./objects-mem.ts";
import { createR2HttpObjectStore } from "./objects-r2-http.ts";
import { createOperatorSettlement } from "./operator-credentials.ts";
import {
  ensureOperatorKey,
  parseOperatorPublicKey,
  signOperatorAssertion,
} from "./operator-key.ts";
import { resolvePayment } from "./payment-setup.ts";
import { createOpenAiGateway, parseOpenAiModelConfig } from "./providers/openai.ts";
import { createSelfhostDataPlaneAccess } from "./providers/selfhost.ts";
import { createProvisionerEndpoint } from "./provisioner-endpoint.ts";
import {
  createRuntimeInputAuthority,
  runtimeInputCanonicalOriginSupported,
} from "./runtime-input-preparations.ts";
import { parseRuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
import { createSelfhostDataPlanes } from "./selfhost-data-planes.ts";
import { ensureSigningKey } from "./signing-key.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import {
  createStandaloneProviderComposition,
  RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
  resolveStandaloneProviderMode,
} from "./standalone-provider-composition.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { currentTakoformCandidates } from "./takoform/current-candidates.ts";
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
 *   bun src/entry-bun.ts
 *
 * Cloudflare account credentials may back the explicitly selected provider
 * pack; they never create a separate storage-retail surface.
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

if (process.env.TAKOSERVER_D1_DATABASE_ID !== undefined) {
  throw new Error(
    "TAKOSERVER_D1_DATABASE_ID is not supported by the Bun entry; use local SQLite control state",
  );
}

const publicOrigin = process.env.TAKOSERVER_PUBLIC_ORIGIN ?? "http://localhost:8787";
const port = Number(process.env.PORT ?? 8787);

/** Everything this machine keeps lives under one directory. */
const dataRoot = process.env.TAKOSERVER_DATA_ROOT ?? ".takoserver";
const providerMode = resolveStandaloneProviderMode({
  retiredProviderMode: process.env.TAKOSERVER_RETIRED_PROVIDER_MODE,
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareCredentialConfigured: Boolean(
    process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.TAKOSERVER_CF_TOKEN_FILE?.trim(),
  ),
  provisionerCredentialConfigured: Boolean(process.env.TAKOSERVER_PROVISIONER_TOKEN?.trim()),
  cloudflareZones: process.env.TAKOSERVER_ZONES,
  legacyEdgeForms: process.env.TAKOSERVER_EDGE_FORMS,
  workerEndpointSuffix: process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX,
  suffixes: process.env.TAKOSERVER_SUFFIXES,
  workerdPort: process.env.TAKOSERVER_WORKERD_PORT,
});

// Organizations, keys, and the ledger are as durable as the files are: a
// machine that forgets who its customers are, and what they are owed, on
// restart is not a platform. Memory is kept for tests, which say so by
// asking for it.
const databasePath =
  process.env.TAKOSERVER_DB ??
  (dataRoot === ":memory:" ? ":memory:" : `${dataRoot}/control.sqlite`);
if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

// The Bun control plane always uses local SQLite. Shared D1 is not accepted
// here because its HTTP API cannot provide the atomic batch capability the app
// requires; the guard above runs before this database is opened or migrated.
const sql = (() => {
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
// Artifact bytes may come from the same R2 bucket the Worker writes to. Bun's
// control rows remain in local SQLite while the Worker keeps its rows in D1;
// sharing only bytes ensures a bundle committed through the public API is there
// when the provisioner goes to publish it.
const workerdPort = process.env.TAKOSERVER_WORKERD_PORT
  ? Number(process.env.TAKOSERVER_WORKERD_PORT)
  : 8788;
const workerd = createWorkerdSupervisor({
  binary: process.env.TAKOSERVER_WORKERD_BINARY ?? findWorkerd(process.cwd()),
  spawn: (command) => Bun.spawn(command as string[], { stdout: "inherit", stderr: "inherit" }),
  log: (message) => process.stdout.write(`${message}\n`),
  readiness: async () => {
    // A successful HTTP response (including the router's honest 404) proves
    // that the child is listening. Retry briefly to cover workerd startup
    // without recording a serving marker before a real liveness check.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${workerdPort}/`, {
          signal: AbortSignal.timeout(250),
        });
        return response.status >= 100;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    return false;
  },
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
const currentCandidates = currentTakoformCandidates();

// The provider reads committed bundles through the same artifact store the
// Host writes them to, so a Worker can only be published from bytes a tenant
// actually uploaded and had verified.
const artifactStore = createTakoformArtifacts({
  sql,
  objects,
  clock,
  randomId: () => crypto.randomUUID(),
});
/**
 * The sealed path a sensitive Worker var travels on this machine.
 *
 * Constructed only when the operator has configured a key ring, because
 * everything downstream is derived from its presence: without one the self-host
 * provider advertises no runtime-input capability, admission refuses a
 * `requiredSensitiveVars` declaration with `unsupported_capability`, and the
 * private preparation route is not served at all. Generating a key here and
 * keeping it beside the ciphertext would not be encryption at rest; it would be
 * a lock with its key taped to it.
 *
 * Two more conditions have to hold, and both are refusals rather than
 * workarounds. `TAKOSERVER_PUBLIC_ORIGIN` must be an `https` bare origin,
 * because the released Takoform provider refuses any other scheme before it
 * sends a value and this Host's own published schema says the same — a Host
 * that accepted `http://localhost:8787` would advertise a capability no client
 * can use. And the retired-ObjectBucket drain mode composes no lease port, so
 * a preparation made there could never be delivered and would simply expire
 * with secrets sealed on disk for an hour.
 */
const runtimeInputsAvailable =
  Boolean(process.env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING) &&
  runtimeInputCanonicalOriginSupported(publicOrigin) &&
  providerMode !== RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN;
if (process.env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING && !runtimeInputsAvailable) {
  console.warn(
    runtimeInputCanonicalOriginSupported(publicOrigin)
      ? "sensitive Worker runtime inputs are disabled: the retired ObjectBucket drain mode composes no lease port"
      : `sensitive Worker runtime inputs are disabled: TAKOSERVER_PUBLIC_ORIGIN must be an https bare origin (got ${publicOrigin})`,
  );
}
const runtimeInputs = runtimeInputsAvailable
  ? createRuntimeInputAuthority({
      sql,
      sealKeys: await parseRuntimeInputSealKeyRing(
        process.env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING as string,
      ),
      canonicalPublicOrigin: publicOrigin,
      clock,
    })
  : undefined;

/**
 * Where a Worker this machine runs finds its KV namespaces and SQL databases.
 *
 * The planes are served by this process, on this process's own port, under a
 * `.well-known` prefix. What reaches them is not that public origin, though: a
 * generated Worker entrypoint calls them through a workerd `externalServer`
 * pointed at the loopback address below, so the traffic never leaves the
 * machine and never depends on `TAKOSERVER_PUBLIC_ORIGIN` resolving to it.
 *
 * `127.0.0.1` and the serving port, therefore — not the public origin, which
 * on a real deployment is a TLS name in front of a proxy that this process
 * cannot reach from inside itself, and not `localhost`, which may resolve to
 * an address the listener is not bound to.
 *
 * Retired-drain mode publishes no Worker Version, so it composes no plane and
 * refuses the address; that keeps the KV table and the SQLite files untouched
 * on a machine whose only job is proving a historical Deployment is gone.
 */
const dataPlaneAddress =
  providerMode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN ? undefined : `127.0.0.1:${port}`;
const selfhostDataAccess = createSelfhostDataPlaneAccess(dataRoot);
const selfhostData = dataPlaneAddress
  ? createSelfhostDataPlanes({
      sql,
      grant: (script, versionId) => selfhostDataAccess.grant(script, versionId),
      databasePath: (name) => selfhostDataAccess.databasePath(name),
      clock,
    })
  : undefined;

const providerArtifacts = {
  manifest: (tenantRef: string, digest: string) => artifactStore.resolveManifest(tenantRef, digest),
  async blob(digest: string) {
    const stored = await objects.get(`art/${digest.slice("sha256:".length)}`);
    return stored ? new Uint8Array(await new Response(stored.body).arrayBuffer()) : null;
  },
};

/**
 * Ordinary Bun always executes current Provider3 Edge Forms on the local
 * workerd-backed provider. Generic Cloudflare credentials may separately back
 * the Host's R2 object store or an explicitly composed current ObjectBucket
 * supply; they are neither provider-selection nor resale authority.
 *
 * The old Cloudflare ObjectBucket adapter remains reachable only through the
 * explicit recovery mode resolved before any local state is opened. That mode
 * reconstructs historical observation/deletion authority and publishes no
 * current Offering.
 */
const providerComposition = createStandaloneProviderComposition({
  mode: providerMode,
  edge,
  stableForms: currentCandidates.forms,
  dataRoot,
  runtime: createWorkerdRuntime({
    root: dataRoot,
    port: workerdPort,
    isReady: () => workerd.isReady(),
    async onReload(configPath) {
      // Started on the first publish rather than at boot, so a machine
      // that never runs a Worker never runs a runtime for one. After
      // that it watches the file itself: one tenant's deploy must not
      // bounce every other tenant's in-flight requests.
      await workerd.ensure(configPath);
    },
  }),
  artifacts: providerArtifacts,
  ...(process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX
    ? { workerEndpointSuffix: process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX }
    : {}),
  ...(process.env.TAKOSERVER_SUFFIXES
    ? { suffixes: process.env.TAKOSERVER_SUFFIXES.split(",").map((entry) => entry.trim()) }
    : {}),
  ...(runtimeInputs ? { runtimeInputs: runtimeInputs.leases } : {}),
  ...(dataPlaneAddress ? { dataPlaneAddress } : {}),
  now: clock(),
  ...(providerMode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN
    ? {
        retiredCloudflare: {
          accountId: required("CLOUDFLARE_ACCOUNT_ID"),
          authorize: () => `Bearer ${cloudflareToken()}`,
          zones: [],
          artifacts: providerArtifacts,
        },
      }
    : {}),
});
const { providers, providerPacks, offerings } = providerComposition;

const unconfigured = {
  async verify(): Promise<never> {
    throw new Error("operator credentials are not configured");
  },
};

// A machine with no identity provider would advertise no way in and refuse
// every sign-in, so it mints an operator key and offers that instead.
const operatorKeyPath = join(dataRoot, "operator-key.jwk");
const identityOnlyPublicKeyJwk = process.env.TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK
  ? parseOperatorPublicKey(
      process.env.TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK,
      "TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK",
    )
  : undefined;
const legacyPublicKeyJwk = await ensureOperatorKey({
  configured: process.env.TAKOSERVER_OPERATOR_PUBLIC_JWK,
  hasIdentityProvider:
    Boolean(identityOnlyPublicKeyJwk) ||
    Boolean(process.env.TAKOS_ID_ISSUER && process.env.TAKOS_ID_CLIENT_ID) ||
    Boolean(process.env.GOOGLE_CLIENT_ID),
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
const identityPublicKeyJwk = identityOnlyPublicKeyJwk ?? legacyPublicKeyJwk;

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
  operatorPublicKeyJwk: identityPublicKeyJwk,
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

// A machine standing on its own makes a signing key, keeps it under the data
// root, and registers the half that verifies it.
const signingKey = await ensureSigningKey({
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
const app = buildApp({
  sql,
  objects,
  ...(signingKey ? { signingKey } : {}),
  identity: identity.verifier,
  identityProviders: identity.providers,
  ...(configuredAi ? { ai: configuredAi } : {}),
  settlement:
    payment.settlement ??
    (legacyPublicKeyJwk
      ? createOperatorSettlement({ publicKeyJwk: legacyPublicKeyJwk })
      : unconfigured),
  ...(payment.checkout ? { checkout: payment.checkout } : {}),
  publicOrigin,
  ...(process.env.TAKOSERVER_CONSOLE_ORIGIN
    ? { consoleOrigin: process.env.TAKOSERVER_CONSOLE_ORIGIN }
    : {}),
  ...(selfhostData ? { selfhostData } : {}),
  forms: currentCandidates.forms,
  bindings: currentCandidates.bindings,
  hostForms: currentCandidates.forms,
  hostBindings: currentCandidates.bindings,
  providers,
  providerPacks,
  offerings,
  artifacts: artifactStore,
  workerModuleInspector: createJavaScriptWorkerModuleInspector(),
  ...(runtimeInputs ? { runtimeInputs } : {}),
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
