import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createActorResourceGraphReader } from "./actor-resource-graph.ts";
import { buildApp, createAppResourceStoreBundle } from "./app.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import {
  parseSelfhostV2PrivatePlaneBoot,
  prepareSelfhostV2PrivatePlaneRoots,
} from "./entry-v2-private-plane-boot.ts";
import { resolveIdentity } from "./identity-setup.ts";
import { migrateSqlite } from "./migrate-sqlite.ts";
import { createFileObjectStore } from "./objects-fs.ts";
import { createMemoryObjectStore } from "./objects-mem.ts";
import { createOperatorSettlement } from "./operator-credentials.ts";
import {
  ensureOperatorKey,
  parseOperatorPublicKey,
  signOperatorAssertion,
} from "./operator-key.ts";
import { resolvePayment } from "./payment-setup.ts";
import { createOpenAiGateway, parseOpenAiModelConfig } from "./providers/openai.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostEventTargets,
  selfhostObjectsRoot,
} from "./providers/selfhost.ts";
import { createSelfhostV2KvStore } from "./providers/selfhost-v2-kv-store.ts";
import { createSelfhostV2ObjectBucketStore } from "./providers/selfhost-v2-object-bucket-store.ts";
import { createSelfhostV2SQLiteStore } from "./providers/selfhost-v2-sqlite-store.ts";
import { createProvisionerEndpoint } from "./provisioner-endpoint.ts";
import { selectPublicHostFormSource } from "./public-host-form-source.ts";
import { createQueueCustody } from "./queue-custody.ts";
import {
  createRuntimeInputAuthority,
  runtimeInputCanonicalOriginSupported,
} from "./runtime-input-preparations.ts";
import { parseRuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
import {
  openSelfhostActorPublicRuntime,
  type SelfhostActorPublicRuntime,
} from "./selfhost-actor-public-runtime.ts";
import {
  hasExactLocalContainerEndpointCandidatePair,
  SELFHOST_TLS_ENVIRONMENT,
  selfhostWorkerEndpointPublication,
  selfhostWorkerEndpointScheme,
} from "./selfhost-composition.ts";
import {
  createSelfhostContainerBootstrap,
  createSelfhostContainerSignalHandler,
  parseSelfhostContainerBootstrapConfiguration,
} from "./selfhost-container-bootstrap.ts";
import {
  createSelfhostContainerEndpointHttpsDispatch,
  createSelfhostContainerEndpointHttpsListenerIfSupported,
  parseSelfhostContainerEndpointHttpsConfiguration,
  type SelfhostContainerEndpointHttpsListener,
  validateSelfhostContainerEndpointHttpsCertificate,
} from "./selfhost-container-endpoint-https.ts";
import { createSelfhostContainerEndpointIngress } from "./selfhost-container-endpoint-ingress.ts";
import {
  runSelfhostKvOperation,
  selfhostKvOperationErrorCode,
  serveSelfhostDataPlanes,
} from "./selfhost-data-planes.ts";
import {
  closeSelfhostEntryOwnedResources,
  createSelfhostEntryShutdown,
} from "./selfhost-entry-shutdown.ts";
import {
  createSelfhostBunFetchHandler,
  createSelfhostHealthHandler,
  discardSelfhostReadinessProbeBody,
  type SelfhostStartupRestoreOutcome,
} from "./selfhost-health.ts";
import { createSelfhostQueuePump } from "./selfhost-queue-pump.ts";
import { createSelfhostWorkerScheduler } from "./selfhost-scheduler.ts";
import { renderSelfhostOperatorSignInInstructions } from "./selfhost-startup-instructions.ts";
import { createSelfhostTakoformV2Ingress } from "./selfhost-takoform-v2-ingress.ts";
import {
  assertActiveSelfhostTenantRunCredentialSigningKey,
  assertSelfhostTenantRunCredentialKeyConfiguration,
  createSelfhostTenantRunCredentials,
} from "./selfhost-tenant-run-credentials.ts";
import { createSelfhostV2ConfiguredInputSealer } from "./selfhost-v2-configured-input-sealer.ts";
import { createSelfhostV2QueueComposition } from "./selfhost-v2-queue-composition.ts";
import { createSelfhostV2QueueScheduler } from "./selfhost-v2-queue-scheduler.ts";
import { createSelfhostV2WorkerComposition } from "./selfhost-v2-worker-composition.ts";
import { ensureSigningKey } from "./signing-key.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import {
  createSelfhostCronOwnerReader,
  createStandaloneProviderComposition,
  RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN,
  resolveStandaloneProviderMode,
} from "./standalone-provider-composition.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { parseTakoformV2ApplicationConfig } from "./takoform-v2/config.ts";
import { selectClosedGraphWorkerd } from "./workerd-artifact.ts";
import { spawnWorkerdWithParentDeath, workerPortOwnership } from "./workerd-linux-process.ts";
import { createWorkerdRuntime } from "./workerd-runtime.ts";
import { createWorkerdSupervisor } from "./workerd-supervisor.ts";

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
if (process.env.TAKOSERVER_R2_BUCKET !== undefined) {
  throw new Error(
    "TAKOSERVER_R2_BUCKET is not supported by the Bun entry; use its local exact-identity artifact store",
  );
}

const takoformV2Config = parseTakoformV2ApplicationConfig({
  TAKOSERVER_TAKOFORM_V2_CONFIG: process.env.TAKOSERVER_TAKOFORM_V2_CONFIG,
  TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: process.env.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY,
});
const publicOrigin = process.env.TAKOSERVER_PUBLIC_ORIGIN;
if (!publicOrigin || !runtimeInputCanonicalOriginSupported(publicOrigin)) {
  throw new Error("TAKOSERVER_PUBLIC_ORIGIN must be a canonical HTTPS bare origin");
}
const port = Number(process.env.PORT ?? 8787);

/** Everything this machine keeps lives under one directory. */
const dataRoot = process.env.TAKOSERVER_DATA_ROOT ?? ".takoserver";
const v2WorkerTargetKey = "selfhost-v2-worker-primary";
const workerdPort = process.env.TAKOSERVER_WORKERD_PORT
  ? Number(process.env.TAKOSERVER_WORKERD_PORT)
  : 8788;
const workerEndpointPort = process.env.TAKOSERVER_WORKER_ENDPOINT_PORT
  ? Number(process.env.TAKOSERVER_WORKER_ENDPOINT_PORT)
  : workerdPort;
if (
  !Number.isSafeInteger(workerEndpointPort) ||
  workerEndpointPort < 1 ||
  workerEndpointPort > 65_535
) {
  throw new Error("TAKOSERVER_WORKER_ENDPOINT_PORT must be a TCP port between 1 and 65535");
}
const parsedContainerConfiguration = parseSelfhostContainerBootstrapConfiguration(process.env);
const containerEndpointHttpsConfiguration = parseSelfhostContainerEndpointHttpsConfiguration(
  process.env,
  {
    containerRuntimeConfigured: parsedContainerConfiguration !== undefined,
    controlPort: port,
    workerdPort,
    workerEndpointPort,
  },
);
/**
 * Keep the existing Workerd TLS inputs and parsing semantics as the one source
 * of certificate material. Container HTTPS validates and handshakes its own
 * listener independently; Workerd's socket and published scheme remain owned
 * by the existing Workerd configuration.
 */
const workerdTls = (() => {
  const read = (path: string, name: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      throw new Error(`${name} could not be read: ${path}`);
    }
  };
  const certificateFile = process.env[SELFHOST_TLS_ENVIRONMENT.certificateFile]?.trim();
  const privateKeyFile = process.env[SELFHOST_TLS_ENVIRONMENT.privateKeyFile]?.trim();
  const certificate = process.env[SELFHOST_TLS_ENVIRONMENT.certificate]?.trim();
  const privateKey = process.env[SELFHOST_TLS_ENVIRONMENT.privateKey]?.trim();
  const certificateChain = certificateFile
    ? read(certificateFile, SELFHOST_TLS_ENVIRONMENT.certificateFile)
    : certificate;
  const key = privateKeyFile
    ? read(privateKeyFile, SELFHOST_TLS_ENVIRONMENT.privateKeyFile)
    : privateKey;
  if (!certificateChain && !key) return undefined;
  if (!certificateChain || !key) {
    throw new Error(
      `a Worker socket certificate needs both halves: set ${SELFHOST_TLS_ENVIRONMENT.certificateFile}` +
        ` and ${SELFHOST_TLS_ENVIRONMENT.privateKeyFile}, or ${SELFHOST_TLS_ENVIRONMENT.certificate}` +
        ` and ${SELFHOST_TLS_ENVIRONMENT.privateKey}`,
    );
  }
  return { certificateChain, privateKey: key };
})();
if (containerEndpointHttpsConfiguration) {
  if (!workerdTls) {
    throw new Error(
      "Container Endpoint HTTPS requires the existing Worker TLS certificate and key material",
    );
  }
  validateSelfhostContainerEndpointHttpsCertificate({
    configuredSuffix: containerEndpointHttpsConfiguration.configuredSuffix,
    certificateChain: workerdTls.certificateChain,
    privateKey: workerdTls.privateKey,
  });
}
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
const v2PrivatePlaneBoot = parseSelfhostV2PrivatePlaneBoot(
  process.env.TAKOSERVER_V2_WORKER_PRIVATE_PLANES,
  {
    dataRoot,
    reservedPorts: [
      port,
      workerdPort,
      workerEndpointPort,
      ...(process.env.TAKOSERVER_DATA_PLANE_PORT
        ? [Number(process.env.TAKOSERVER_DATA_PLANE_PORT)]
        : []),
    ],
  },
);
if (v2PrivatePlaneBoot && providerMode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN) {
  throw new Error("v2 Worker private planes are unavailable in retired ObjectBucket drain mode");
}
const currentCandidates = selectPublicHostFormSource(process.env.TAKOSERVER_FORM_SOURCE_CANDIDATE);
const selfhostContainer = createSelfhostContainerBootstrap({
  environment: process.env,
  dataRoot,
  providerMode,
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
const controlDatabase = new Database(databasePath);
// A self-hosted deployment starts with an empty file, so it is brought up
// to this build's schema here. Forward only and recorded, so running it
// again applies nothing and a database from a newer build is refused
// rather than repaired.
const migrated = migrateSqlite(controlDatabase);
if (migrated.applied.length > 0) {
  process.stdout.write(
    `applied ${migrated.applied.length} migration(s): ${migrated.applied.join(", ")}\n`,
  );
}
const sql = createSqliteSql(controlDatabase);
/**
 * The port a published Worker endpoint address carries.
 *
 * The socket's own port by default, because that is the one this machine can
 * promise answers: a self-host on `28988` published a portless address while
 * every request that reached the Worker carried `:28988`, so the identity the
 * Worker pinned and the identity its Host advertised disagreed. A deployment
 * that puts an ordinary front end on 443 in front of workerd says so here, and
 * the scheme's default is normalized away rather than published.
 */
/**
 * The scheme Worker endpoints are published under, and the sentence an operator
 * has to read when it is `http` on a name that is not this machine.
 */
const workerEndpoint = selfhostWorkerEndpointScheme({
  workerEndpointSuffix: process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX,
  tlsConfigured: workerdTls !== undefined,
});
if (workerEndpoint.warning) process.stderr.write(`${workerEndpoint.warning}\n`);

/**
 * Whether this machine can mint a Worker endpoint at all, said at boot.
 *
 * `WorkerEndpoint@0.1.0` publishes `https://<name>/` and nothing else, so a
 * deployment on plain HTTP or on a port that is not the scheme's default can
 * create no endpoint — and the only place that was discovered before was the
 * middle of somebody's `tofu apply`. It is a diagnostic and not a boot failure
 * because everything else on the machine works: Workers run, storage answers,
 * queues drain, cron fires, and the runtime serves on its own socket.
 */
const workerEndpointPublication = selfhostWorkerEndpointPublication({
  workerEndpointSuffix: process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX,
  scheme: workerEndpoint.scheme,
  port: workerEndpointPort,
});
if (workerEndpointPublication.diagnostic) {
  process.stderr.write(`${workerEndpointPublication.diagnostic}\n`);
}

const workerdSelection = await selectClosedGraphWorkerd({
  binary: process.env.TAKOSERVER_WORKERD_BINARY,
  privateRoot: join(dataRoot === ":memory:" ? ".takoserver" : dataRoot, "runtime-probes"),
});
const workerdBinary = workerdSelection.binary;
if (workerdSelection.diagnostic) process.stderr.write(`${workerdSelection.diagnostic}\n`);
const workerd = createWorkerdSupervisor({
  binary: workerdBinary,
  listenerPort: workerdPort,
  spawn: (command) =>
    spawnWorkerdWithParentDeath(command, { stdout: "inherit", stderr: "inherit" }),
  log: (message) => process.stdout.write(`${message}\n`),
  readiness: async (_configPath, child, mode) => {
    // HTTP alone can be answered by an orphan or a foreign listener. Require
    // the kernel listener inode to be held by this exact spawned PID both
    // before and after the response.
    const attempts = mode === "startup" ? 20 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const before = await workerPortOwnership(workerdPort, child.pid);
        if (before === "foreign") return false;
        if (before !== "owned") {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          continue;
        }
        // By address over loopback, so a certificate naming the endpoint suffix
        // is not the thing being checked here — that the child is listening is.
        const response = await fetch(
          `${workerdTls ? "https" : "http"}://127.0.0.1:${workerdPort}/`,
          {
            ...(workerdTls ? { tls: { rejectUnauthorized: false } } : {}),
            signal: AbortSignal.timeout(250),
          },
        );
        discardSelfhostReadinessProbeBody(response);
        if (
          response.status >= 100 &&
          (await workerPortOwnership(workerdPort, child.pid)) === "owned"
        )
          return true;
      } catch {
        // The child may still be starting, or /proc may be unavailable. The
        // latter must never turn an unrelated HTTP listener into readiness.
      }
      if (mode === "startup") {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    return false;
  },
});

// This machine owns its control rows and artifact bytes together. The R2 HTTP
// adapter remains a read-only/provisioner seam, but it cannot round-trip the
// exact operation identity required by request-time artifact PUT recovery.
const objects =
  process.env.TAKOSERVER_OBJECTS_IN_MEMORY === "1"
    ? createMemoryObjectStore()
    : createFileObjectStore({ root: dataRoot });
const clock = () => new Date();
// Native startup and the application share these exact canonical ledgers.
const resourceStores = createAppResourceStoreBundle(sql, clock);
const edge = await buildEdgeForms();
let selfhostContainerEndpointHttps: SelfhostContainerEndpointHttpsListener | undefined;
if (containerEndpointHttpsConfiguration) {
  // The listener itself proves its port and certificate after binding; it is
  // created only after the exact Form package preflight and only for the
  // explicit Container runtime opt-in.
  selfhostContainerEndpointHttps = await createSelfhostContainerEndpointHttpsListenerIfSupported({
    configuration: containerEndpointHttpsConfiguration,
    containerRuntimeConfigured: selfhostContainer !== undefined,
    exactCandidatePair: hasExactLocalContainerEndpointCandidatePair(currentCandidates.forms),
    ...(workerdTls
      ? { certificateChain: workerdTls.certificateChain, privateKey: workerdTls.privateKey }
      : {}),
  });
  if (!selfhostContainerEndpointHttps) {
    process.stderr.write(
      "Container Endpoint HTTPS is configured but unavailable: the exact supported Service/Endpoint package pair is absent; no HTTPS listener was opened.\n",
    );
  }
}
// Register immediately after binding, before later async composition steps can
// fail. The listener close revokes assertServing before asking Bun to stop it.
if (selfhostContainerEndpointHttps) {
  process.once("exit", () => {
    void selfhostContainerEndpointHttps?.close();
  });
}

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
const runtimeInputSealKeyRing = runtimeInputsAvailable
  ? await parseRuntimeInputSealKeyRing(process.env.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING as string)
  : undefined;
const runtimeInputs = runtimeInputSealKeyRing
  ? createRuntimeInputAuthority({
      sql,
      sealKeys: runtimeInputSealKeyRing,
      canonicalPublicOrigin: publicOrigin,
      clock,
    })
  : undefined;
const v2ConfiguredInputSealer = runtimeInputSealKeyRing
  ? createSelfhostV2ConfiguredInputSealer(runtimeInputSealKeyRing)
  : undefined;

/**
 * Where a Worker this machine runs finds its KV namespaces and SQL databases.
 *
 * On a listener of their own, bound to `127.0.0.1`, and never on the public
 * one. What authenticates here is a bearer token minted per Worker Version, and
 * the only thing that should ever hold one is a workerd service on this
 * machine; a route on the public origin would make that token an
 * internet-facing credential for arbitrary SQL, however loopback-only the
 * intent was. A generated Worker entrypoint reaches this listener through a
 * workerd `externalServer` addressed below, so nothing legitimate loses a path
 * and nothing else gains one.
 *
 * `127.0.0.1` and the port this listener actually got — not the public origin,
 * which on a real deployment is a TLS name in front of a proxy this process
 * cannot reach from inside itself, and not `localhost`, which may resolve to an
 * address the listener is not bound to. `TAKOSERVER_DATA_PLANE_PORT` fixes the
 * port for an operator who needs one; without it the kernel picks a free one
 * and this process records what it got.
 *
 * Retired-drain mode publishes no Worker Version, so it serves no plane and
 * composes no address; that keeps the KV table and the SQLite files untouched
 * on a machine whose only job is proving a historical Deployment is gone.
 */
const configuredDataPlanePort = process.env.TAKOSERVER_DATA_PLANE_PORT;
if (
  configuredDataPlanePort !== undefined &&
  !/^(?:[1-9][0-9]{0,4})$/u.test(configuredDataPlanePort.trim())
) {
  // The value ends up inside a generated `externalServer`, so a
  // not-quite-a-number here becomes a configuration workerd refuses much later
  // and for a reason that names neither this variable nor this process.
  throw new Error("TAKOSERVER_DATA_PLANE_PORT must be a port number");
}
const selfhostDataAccess = createSelfhostDataPlaneAccess(dataRoot);
const dataPlanes =
  providerMode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN
    ? undefined
    : serveSelfhostDataPlanes({
        sql,
        grant: (script, versionId) => selfhostDataAccess.grant(script, versionId),
        databasePath: (name) => selfhostDataAccess.databasePath(name),
        objectRoot: selfhostObjectsRoot(dataRoot),
        clock,
        ...(configuredDataPlanePort ? { port: Number(configuredDataPlanePort.trim()) } : {}),
      });

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
let actorRuntime: SelfhostActorPublicRuntime | undefined;
const installedActorForm = currentCandidates.forms.find(
  (form) => form.identity.formRef.kind === "ActorNamespace",
);
if (
  providerMode !== RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN &&
  workerdBinary &&
  installedActorForm
) {
  try {
    actorRuntime = await openSelfhostActorPublicRuntime({
      dataRoot,
      runtimeRoot: dataRoot,
      socketParent: join(dataRoot, "actor-forward-sockets"),
      binary: workerdBinary,
      graph: createActorResourceGraphReader({
        store: resourceStores.inventory,
        form: installedActorForm,
      }),
      deployments: resourceStores.deployments,
      providerPackRef: "local",
      providerInstallationRef: "local.primary",
    });
  } catch (error) {
    process.stderr.write(
      `the Actor owner could not restore: ${error instanceof Error ? error.message : "unknown error"}; Actor admission remains unavailable.\n`,
    );
  }
}
const workerdRuntime = createWorkerdRuntime({
  root: dataRoot,
  binary: workerdBinary,
  port: workerdPort,
  // The kernel may choose a different listener after a restart. Re-render
  // Host transport from this process, not a Version's saved ephemeral port.
  ...(dataPlanes ? { dataPlaneAddress: dataPlanes.address } : {}),
  ...(workerdTls ? { tls: workerdTls } : {}),
  ...(actorRuntime
    ? {
        actorForwardSockets: () => actorRuntime?.actorForwardSockets() ?? [],
        actorForwardLifecycle: actorRuntime.actorForwardLifecycle,
      }
    : {}),
  beforeRender: () => workerd.assertMayRender(),
  isReady: () => workerd.isReady(),
  async onReload(configPath) {
    // Started on the first publish rather than unconditionally, so a machine
    // that never runs a Worker never runs a runtime for one. A machine that
    // *has* published one starts it at boot instead — see the restore below.
    // After that it watches the file itself: one tenant's deploy must not
    // bounce every other tenant's in-flight requests.
    await workerd.ensure(configPath);
  },
});

// Restore the exact native socket graph before composing any Actor capability
// or opening the public listener. A failed restore is diagnosis, never proof of
// executable Actor admission.
let startupRestore: SelfhostStartupRestoreOutcome;
try {
  const restored = await workerdRuntime.restore();
  startupRestore = restored.length === 0 ? "empty" : "restored";
  if (restored.length > 0) {
    console.log(`restored ${restored.length} published Worker(s): ${restored.join(", ")}`);
  }
} catch (error) {
  startupRestore = "failed";
  actorRuntime?.actorForwardLifecycle.uncertain();
  await actorRuntime?.close();
  actorRuntime = undefined;
  process.stderr.write(
    `the Worker runtime could not be restored at boot: ${
      error instanceof Error ? error.message : "unknown error"
    }. Published Workers will not answer until the next publication.\n`,
  );
}

// Reopen every SQL-explained v2 Worker UID owner before the public listener.
// This does not register the incomplete Worker Forms or make an Endpoint HTTPS
// frontend claim. Unknown private namespaces and missing serving owners are
// startup failures, not silently forgotten native children.
if (v2PrivatePlaneBoot) prepareSelfhostV2PrivatePlaneRoots(v2PrivatePlaneBoot);
const v2SqliteStore = v2PrivatePlaneBoot?.sqlite
  ? createSelfhostV2SQLiteStore({
      sql,
      root: v2PrivatePlaneBoot.sqlite.root,
      targetKey: v2WorkerTargetKey,
      now: clock,
    })
  : undefined;
const v2KvStore = v2PrivatePlaneBoot?.kv
  ? createSelfhostV2KvStore({
      sql,
      root: v2PrivatePlaneBoot.kv.root,
      clock,
      runOperation: runSelfhostKvOperation,
      operationErrorCode: selfhostKvOperationErrorCode,
    })
  : undefined;
const v2ObjectBucketStore = v2PrivatePlaneBoot?.objectBucket
  ? createSelfhostV2ObjectBucketStore({
      sql,
      root: v2PrivatePlaneBoot.objectBucket.root,
      clock,
    })
  : undefined;
const v2QueueCustody =
  v2PrivatePlaneBoot?.queue || v2PrivatePlaneBoot?.queueProducer
    ? createQueueCustody({ sql })
    : undefined;
let workers: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
let queueCapability:
  | NonNullable<ReturnType<typeof createSelfhostV2WorkerComposition>["queueCapability"]>
  | undefined;
let ownersRestored = false;
let v2QueueComposition: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
let restoredV2WorkerUids: readonly string[];
const clearV2BootKeys = () => {
  for (const plane of [
    v2PrivatePlaneBoot?.sqlite,
    v2PrivatePlaneBoot?.kv,
    v2PrivatePlaneBoot?.objectBucket,
    v2PrivatePlaneBoot?.queue,
    v2PrivatePlaneBoot?.queueProducer,
  ]) {
    plane?.signingKey.fill(0);
  }
};
try {
  if (v2PrivatePlaneBoot?.queue && v2QueueCustody) {
    const requireQueueCapability = (): NonNullable<
      ReturnType<typeof createSelfhostV2WorkerComposition>["queueCapability"]
    > => {
      if (!ownersRestored || !queueCapability) {
        throw new Error("v2 Queue owner capability is not restored");
      }
      return queueCapability;
    };
    v2QueueComposition = createSelfhostV2QueueComposition({
      sql,
      custody: v2QueueCustody,
      capability: {
        observeQueueServingCapability: (input) =>
          requireQueueCapability().observeQueueServingCapability(input),
        observeCurrentServing: (input) => requireQueueCapability().observeCurrentServing(input),
      },
      settlementKey: v2PrivatePlaneBoot.queue.signingKey,
      privatePort: v2PrivatePlaneBoot.queue.privatePort,
      ownerForWorkerUid: async (uid) => {
        if (!ownersRestored || !workers) {
          throw new Error("v2 Queue owner is not restored");
        }
        return await workers.ownerForWorkerUid(uid);
      },
    });
  }
  workers = createSelfhostV2WorkerComposition({
    sql,
    objects,
    clock,
    config: takoformV2Config,
    rootDirectory: join(dataRoot === ":memory:" ? ".takoserver" : dataRoot, "v2-worker-owners"),
    targetKey: v2WorkerTargetKey,
    workerdBinary,
    ...(v2ConfiguredInputSealer ? { configuredInputSealer: v2ConfiguredInputSealer } : {}),
    ...(v2SqliteStore && v2PrivatePlaneBoot?.sqlite
      ? {
          sqliteBinding: {
            store: v2SqliteStore,
            signingKey: v2PrivatePlaneBoot.sqlite.signingKey,
            stagingRoot: v2PrivatePlaneBoot.sqlite.stagingRoot,
            privatePort: v2PrivatePlaneBoot.sqlite.privatePort,
          },
        }
      : {}),
    ...(v2KvStore && v2PrivatePlaneBoot?.kv
      ? {
          v2KvBinding: {
            store: v2KvStore,
            signingKey: v2PrivatePlaneBoot.kv.signingKey,
            privatePort: v2PrivatePlaneBoot.kv.privatePort,
          },
        }
      : {}),
    ...(v2ObjectBucketStore && v2PrivatePlaneBoot?.objectBucket
      ? {
          v2ObjectBucketBinding: {
            store: v2ObjectBucketStore,
            signingKey: v2PrivatePlaneBoot.objectBucket.signingKey,
            privatePort: v2PrivatePlaneBoot.objectBucket.privatePort,
          },
        }
      : {}),
    ...(v2QueueComposition ? { queueSettlement: v2QueueComposition.settlementBinding } : {}),
    ...(v2PrivatePlaneBoot?.queueProducer && v2QueueCustody
      ? {
          v2QueueProducerBinding: {
            custody: v2QueueCustody,
            signingKey: v2PrivatePlaneBoot.queueProducer.signingKey,
            privatePort: v2PrivatePlaneBoot.queueProducer.privatePort,
          },
        }
      : {}),
  });
  if (v2QueueComposition) {
    if (!workers.queueCapability) throw new Error("v2 Queue native capability is unavailable");
    queueCapability = workers.queueCapability;
  }
  // Both private broker and Queue authority have already copied the supplied
  // bytes into their exact boot snapshot; do not retain a spare entry copy.
  clearV2BootKeys();
  restoredV2WorkerUids = await workers.restoreOwners();
  ownersRestored = true;
} catch (error) {
  clearV2BootKeys();
  await v2QueueComposition?.close();
  throw error;
}
const v2WorkerComposition = workers;
const v2QueueScheduler =
  v2QueueComposition && v2QueueCustody
    ? createSelfhostV2QueueScheduler({
        sql,
        custody: v2QueueCustody,
        composition: v2QueueComposition,
        workerComposition: v2WorkerComposition,
      })
    : undefined;
if (restoredV2WorkerUids.length > 0) {
  process.stdout.write(`restored ${restoredV2WorkerUids.length} v2 Worker owner(s)\n`);
}

/**
 * The half of the Edge Family that is a clock rather than a request.
 *
 * A queue message and a cron match have no caller: something on this machine
 * has to notice they are due and invoke the Worker itself. Both reach the
 * Worker through the runtime above, on a hostname of this Host's own, past a
 * gate holding a token the tenant cannot read.
 *
 * Retired-drain mode publishes no Worker Version, so it runs neither; the
 * provider then reports a Consumer as not delivering and a Trigger as not
 * firing, which is the truth on that machine.
 */
const eventTargets = createSelfhostEventTargets(dataRoot);
const queuePump =
  providerMode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN
    ? undefined
    : createSelfhostQueuePump({ sql, runtime: workerdRuntime, targets: eventTargets, clock });
const workerScheduler =
  providerMode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN
    ? undefined
    : createSelfhostWorkerScheduler({
        sql,
        runtime: workerdRuntime,
        targets: eventTargets,
        clock,
      });
const selfhostEvents = workerScheduler
  ? {
      forgetSchedules: (script: string, cron?: string) =>
        workerScheduler.forgetSchedules(script, cron),
    }
  : undefined;

const providerComposition = createStandaloneProviderComposition({
  mode: providerMode,
  edge,
  stableForms: currentCandidates.forms,
  stableBindings: currentCandidates.bindings,
  retainedForms: currentCandidates.retainedForms,
  retainedBindings: currentCandidates.retainedBindings,
  workerClassRuntimeContracts: currentCandidates.workerClassRuntimeContracts,
  dataRoot,
  runtime: workerdRuntime,
  ...(actorRuntime ? { actorRuntime } : {}),
  workerRuntimeAvailable: workerdBinary !== null,
  artifacts: providerArtifacts,
  ...(process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX
    ? { workerEndpointSuffix: process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX }
    : {}),
  // The scheme is the socket's, so it is composed here rather than defaulted
  // inside the provider. The drain mode publishes no Worker at all and refuses
  // every self-host setting, including this one.
  ...(providerMode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN
    ? {}
    : { workerEndpointScheme: workerEndpoint.scheme, workerEndpointPort }),
  ...(process.env.TAKOSERVER_SUFFIXES
    ? { suffixes: process.env.TAKOSERVER_SUFFIXES.split(",").map((entry) => entry.trim()) }
    : {}),
  ...(runtimeInputs ? { runtimeInputs: runtimeInputs.leases } : {}),
  ...(selfhostContainer
    ? {
        container: {
          runtime: selfhostContainer.runtime,
          capacityProfile: selfhostContainer.capacityProfile,
        },
      }
    : {}),
  ...(selfhostContainerEndpointHttps
    ? { containerEndpointIngress: selfhostContainerEndpointHttps.ingress }
    : {}),
  ...(dataPlanes
    ? { dataPlaneAddress: dataPlanes.address, dataPlaneMaintenance: dataPlanes.maintenance }
    : {}),
  ...(selfhostEvents ? { events: selfhostEvents } : {}),
  ...(providerMode === RETIRED_CLOUDFLARE_OBJECT_BUCKET_DRAIN
    ? {}
    : {
        listCronOwners: createSelfhostCronOwnerReader({
          inventory: resourceStores.inventory,
          forms: [...currentCandidates.forms, ...currentCandidates.retainedForms, ...edge.forms],
        }),
      }),
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
const containerEndpointIngress = providerComposition.containerEndpointIngress;
if (selfhostContainerEndpointHttps && !containerEndpointIngress) {
  await selfhostContainerEndpointHttps.close();
  selfhostContainerEndpointHttps = undefined;
  process.stderr.write(
    "Container Endpoint HTTPS is configured but unsupported by this exact Provider composition; listener closed and no Endpoint Offering is active.\n",
  );
}
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
  operatorAudience: publicOrigin,
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
const signingKeyId = process.env.TAKOSERVER_SIGNING_KEY_ID ?? "takoserver-local";
const selfhostTenantRunCredentialsEnabled =
  process.env.TAKOSERVER_SELFHOST_TENANT_RUN_CREDENTIALS === "1";
const selfhostTenantRunCredentialKeyId =
  process.env.TAKOSERVER_SELFHOST_TENANT_RUN_CREDENTIAL_KEY_ID ?? "takoserver-selfhost-tenant-run";
if (selfhostTenantRunCredentialsEnabled) {
  assertSelfhostTenantRunCredentialKeyConfiguration({
    credentialKeyId: selfhostTenantRunCredentialKeyId,
    ordinarySigningKeyId: signingKeyId,
  });
}
const signingKey = await ensureSigningKey({
  keyId: signingKeyId,
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
const selfhostTenantRunCredentialSigningKey = selfhostTenantRunCredentialsEnabled
  ? await ensureSigningKey({
      keyId: selfhostTenantRunCredentialKeyId,
      path: join(
        dataRoot,
        `selfhost-tenant-run-signing-key.${selfhostTenantRunCredentialKeyId}.jwk`,
      ),
      sql,
      readFile: (path) =>
        readFile(path, "utf8").then(
          (text) => text,
          () => null,
        ),
      async writeFile(path, contents) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, { mode: 0o600 });
        process.stdout.write("generated a self-host tenant-run signing key under the data root\n");
      },
    })
  : undefined;
if (selfhostTenantRunCredentialSigningKey) {
  await assertActiveSelfhostTenantRunCredentialSigningKey({
    signingKey: selfhostTenantRunCredentialSigningKey,
    runtimeGrantKeys: sql,
  });
}

const configuredAi = aiGateway();
let selfhostEndpointIngressFetch: ((request: Request) => Promise<Response | null>) | undefined;
const app = buildApp({
  sql,
  resourceStores,
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
  v2: takoformV2Config,
  ...(payment.checkout ? { checkout: payment.checkout } : {}),
  publicOrigin,
  ...(process.env.TAKOSERVER_CONSOLE_ORIGIN
    ? { consoleOrigin: process.env.TAKOSERVER_CONSOLE_ORIGIN }
    : {}),
  forms: currentCandidates.forms,
  bindings: currentCandidates.bindings,
  hostForms: currentCandidates.forms,
  hostBindings: currentCandidates.bindings,
  providers,
  providerPacks,
  offerings,
  artifacts: artifactStore,
  ...(selfhostTenantRunCredentialSigningKey
    ? {
        selfhostTenantRunCredentialAuthority: (originReservations) =>
          createSelfhostTenantRunCredentials({
            issuer: publicOrigin,
            signingKey: selfhostTenantRunCredentialSigningKey,
            ordinarySigningKeyId: signingKey.keyId,
            runtimeGrantKeys: sql,
            originReservations,
            clock,
            randomId: () => crypto.randomUUID().replaceAll("-", ""),
          }),
      }
    : {}),
  ...(selfhostContainerEndpointHttps && selfhostContainer && containerEndpointIngress
    ? {
        selfhostEndpointIngressFactory: ({ store, deployments }) => {
          selfhostEndpointIngressFetch = createSelfhostContainerEndpointIngress({
            qualification: containerEndpointIngress,
            store,
            deployments,
          });
          return selfhostEndpointIngressFetch;
        },
      }
    : {}),
  ...(runtimeInputs ? { runtimeInputs } : {}),
  clock,
});
// Install only the callback composed against this Host's canonical stores. A
// suffix miss becomes a private 404 on this dedicated listener and can never
// fall through to Host health, provisioning, or API routes.
if (selfhostContainerEndpointHttps) {
  if (!selfhostEndpointIngressFetch) {
    await selfhostContainerEndpointHttps.close();
    selfhostContainerEndpointHttps = undefined;
    throw new Error("Container Endpoint HTTPS could not install its exact Host ingress handler");
  }
  const endpointFetch = selfhostEndpointIngressFetch;
  selfhostContainerEndpointHttps.installEndpointFetch(
    createSelfhostContainerEndpointHttpsDispatch(endpointFetch),
  );
}

/**
 * Bring the runtime back for the Workers this machine already published.
 *
 * `workerd` used to be started only by a publication, so a self-host that was
 * restarted served nothing at all while its control plane reported healthy and
 * `tofu plan` answered "No changes. Your infrastructure matches the
 * configuration": every resource was observed Ready and no request could reach
 * any Worker. A read or a refresh did not revive it either; only a fresh
 * publication did, so surviving a reboot meant re-applying by hand.
 *
 * The configuration is re-rendered from the durable manifests rather than
 * trusted as it stands, so a machine that was published by an older build comes
 * back on this build's router. It runs before the listener opens, so this Host
 * does not answer anything — readiness included — until the Workers it says it
 * is serving are actually being served.
 *
 * A machine that has published nothing starts nothing, and a runtime that
 * cannot be started is reported rather than fatal: the control plane is how an
 * operator would diagnose it, and `has()` already fails closed, so nothing is
 * observed Ready on a runtime that is not running.
 */
const selfhostHealth = createSelfhostHealthHandler({
  sql,
  startupRestore,
  supervisor: workerd,
});
const takoformV2Ingress = createSelfhostTakoformV2Ingress({
  publicOrigin,
  appFetch: (request) => app.fetch(request),
});

const bunFetch = createSelfhostBunFetchHandler({
  health: selfhostHealth,
  provision,
  appFetch: takoformV2Ingress,
});
let bunServer: ReturnType<typeof Bun.serve> | undefined;
let shutdownClean = true;
let closeSequenceFinished = false;
const handleContainerAndWorkerdShutdown = createSelfhostContainerSignalHandler(
  selfhostContainer,
  () => {
    shutdownClean = false;
    process.stderr.write("self-host shutdown failed at container-close\n");
  },
  async () => {
    // `shutdown()` is the concrete supervisor's terminal, awaited lifecycle;
    // the public WorkerdSupervisor port remains unchanged for runtime clients.
    shutdownClean =
      (await closeSelfhostEntryOwnedResources({
        workerdShutdown: () => workerd.shutdown(),
        mayCloseDependents: () => shutdownClean,
        v2WorkerSuspend: async () => {
          await v2QueueScheduler?.close();
          await v2WorkerComposition.suspendOwnersRetainingCustody();
          await v2QueueComposition?.close();
        },
        actorClose: async () => {
          await actorRuntime?.close();
        },
        dataPlanesStop: async () => {
          await dataPlanes?.stop(false);
        },
        controlDatabaseClose: () => controlDatabase.close(),
        onFailure: (stage) => {
          shutdownClean = false;
          process.stderr.write(`self-host shutdown failed at ${stage}\n`);
        },
      })) && shutdownClean;
  },
  () => {
    // The entry lifecycle calls process.exit only after this ordered sequence
    // and its ingress/request/pass drain have both been proved.
    closeSequenceFinished = true;
  },
);
const entryShutdown = createSelfhostEntryShutdown({
  stopIngress: async () => {
    let endpointClosing: Promise<void> = Promise.resolve();
    if (selfhostContainerEndpointHttps) {
      try {
        endpointClosing = selfhostContainerEndpointHttps.close(false);
      } catch {
        endpointClosing = Promise.reject(new Error("endpoint ingress close failed"));
      }
    }

    let serverStopping: Promise<void> = Promise.resolve();
    try {
      const stopped = bunServer?.stop(false);
      serverStopping = Promise.resolve(stopped);
    } catch {
      serverStopping = Promise.reject(new Error("Bun ingress stop failed"));
    }

    const stopped = await Promise.allSettled([endpointClosing, serverStopping]);
    if (stopped.some((result) => result.status === "rejected")) {
      throw new Error("one or more self-host ingress listeners did not stop cleanly");
    }
  },
  finishShutdown: async () => {
    await handleContainerAndWorkerdShutdown();
    if (!closeSequenceFinished || !shutdownClean) {
      throw new Error("self-host owned resources did not close cleanly");
    }
  },
  onFailure: (stage) => {
    process.exitCode = 1;
    process.stderr.write(`self-host shutdown incomplete at ${stage}\n`);
  },
  onSuccess: () => process.exit(0),
});

/**
 * Keep an idempotent best-effort child stop registered before listener startup:
 * restore may have started Workerd even if Bun.serve cannot bind.
 * This is not a substitute for the awaited shutdown proof above.
 */
process.on("exit", () => {
  workerd.stop();
});

bunServer = Bun.serve({
  port,
  // Longer than the default, because publishing a site means uploading its
  // files and a request that is doing real work is not an idle one.
  idleTimeout: 120,
  fetch: (request) => entryShutdown.fetch(request, bunFetch),
});

// Background settlement. The shutdown owner retains each timer and each pass
// promise, so no new work starts past the signal fence and accepted work drains.
entryShutdown.startInterval(
  "settlement",
  30_000,
  async () => {
    await app.tick();
    if (dataPlanes) {
      await dataPlanes.maintenance.sweepExpiredKv();
      await dataPlanes.maintenance.sweepExpiredObjectUploads();
      await dataPlanes.maintenance.reconcileOrphanObjectFiles();
    }
    if (queuePump) await queuePump.sweep();
  },
  (name) => process.stderr.write(`self-host background pass failed: ${name}\n`),
);
entryShutdown.startInterval(
  "takoform-v2",
  1_000,
  async () => {
    await app.tickTakoformV2();
  },
  (name) => process.stderr.write(`self-host background pass failed: ${name}\n`),
);
entryShutdown.startInterval(
  "queue-wake",
  1_000,
  () => {
    // Share only the wake timer. A blocked recovery scan must not hold the
    // other delivery lane; both named passes remain owned by shutdown.
    void entryShutdown
      .runPass("takoform-v2-queue-delivery", async () => {
        await v2QueueScheduler?.tick();
      })
      .catch(() => {
        process.stderr.write("self-host background pass failed: takoform-v2-queue-delivery\n");
      });
    void entryShutdown
      .runPass("queue-pump", async () => {
        await queuePump?.tick();
      })
      .catch(() => process.stderr.write("self-host background pass failed: queue-pump\n"));
  },
  (name) => process.stderr.write(`self-host background pass failed: ${name}\n`),
);
entryShutdown.startInterval(
  "worker-scheduler",
  5_000,
  async () => {
    await workerScheduler?.tick();
  },
  (name) => process.stderr.write(`self-host background pass failed: ${name}\n`),
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    // Until the terminal shutdown proof completes, a natural event-loop exit
    // must not be reported as a clean stop.
    process.exitCode = 1;
    void entryShutdown.shutdown();
  });
}
if (dataPlanes) {
  // Recorded, because an operator debugging a Worker's storage needs to know
  // which port to look at and the kernel usually chose it.
  console.log(`self-host data planes listening on ${dataPlanes.address} (loopback only)`);
}
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
        aud: publicOrigin,
        provider: "google",
        subject: "operator",
        email: "operator@localhost",
        displayName: "Operator",
      },
      nowSeconds: Math.floor(Date.now() / 1_000),
      lifetimeSeconds: 600,
    });
    console.log(
      renderSelfhostOperatorSignInInstructions({
        publicOrigin,
        ...(process.env.TAKOSERVER_CONSOLE_ORIGIN
          ? { consoleOrigin: process.env.TAKOSERVER_CONSOLE_ORIGIN }
          : {}),
        assertion,
        operatorKeyPath,
      }),
    );
  }
}
