import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bytesDigest } from "./json.ts";
import {
  canonicalSelfhostWeightedVersions,
  type SelfhostWeightedVersion,
  selectSelfhostWeightedVersion,
} from "./selfhost-weighted-deployment.ts";
import { createWorkerdWorkerModuleInspector } from "./workerd-worker-module-inspector.ts";

/**
 * The files and the configuration workerd runs from.
 *
 * The configuration is generated from what is on disk, every time, rather than
 * edited in place. That is the whole reliability story here: there is no state
 * to keep in step, so a process that dies mid-write leaves a directory that the
 * next reload reads correctly, and an operator who deletes a directory by hand
 * gets exactly what they asked for.
 *
 * Each published script gets a directory holding its modules and a small
 * manifest naming its entry point and hostnames. The manifest is written last,
 * so a directory without one is a half-written script and is skipped rather
 * than served — a script serving somebody's traffic from an incomplete upload
 * is worse than one that is not there yet.
 *
 * Routing is by `Host`, and only to hostnames a script claimed. An unclaimed
 * host gets a refusal rather than whichever script sorted first: answering one
 * customer's address with another customer's site is the failure worth
 * preventing, and it is silent when it happens.
 *
 * A script's environment variables are rendered into this configuration as
 * ordinary capnp bindings, because workerd has no separate notion of a secret:
 * a sensitive value looks exactly like a plain one here. That makes the
 * generated file itself the secret, so it is written `0600` inside a `0700`
 * directory, through a temporary file and a rename — a config half-written when
 * a process died must never be the one workerd picks up.
 */

/** One environment entry the module sees on `env`. */
export interface WorkerdBinding {
  readonly name: string;
  readonly value: string;
  /** `text` is a string; `json` is parsed by the runtime before the module sees it. */
  readonly kind: "text" | "json";
}

/** One Host-private native service binding on a tenant entrypoint. */
export interface WorkerdServiceBinding {
  readonly name: string;
  readonly target: string;
  readonly targetResourceUid: string;
  /** Per-caller marker used only by the unavailable router. */
  readonly unavailableToken: string;
}

/** Media types workerd can use for a module declaration in this runtime. */
export type WorkerdModuleMediaType =
  | "application/javascript+module"
  | "text/plain"
  | "application/octet-stream"
  | "application/wasm";

interface WorkerdAssetDeclaration {
  readonly notFoundHandling: "none" | "single-page-application";
  readonly runWorkerFirst: boolean;
  /** Exact normalized media type for every logical asset path. */
  readonly mediaTypes: Readonly<Record<string, string>>;
}

interface WorkerdAssetManifestEntry {
  /** Operator-private flat filename, never a tenant-visible path. */
  readonly key: string;
  readonly mediaType: string;
  readonly size: number;
  readonly digest: `sha256:${string}`;
}

interface WorkerdAssetManifest {
  readonly storageLayout: typeof WORKERD_ASSET_STORAGE_LAYOUT;
  readonly notFoundHandling: "none" | "single-page-application";
  readonly runWorkerFirst: boolean;
  /** Exact logical path to private physical key and declared media. */
  readonly files: Readonly<Record<string, WorkerdAssetManifestEntry>>;
}

interface WorkerdStoredModule {
  readonly name: string;
  /** Operator-private filename; logical module names never become paths. */
  readonly key: string;
  readonly size: number;
  readonly digest: `sha256:${string}`;
}

interface WorkerdModuleStorageManifest {
  readonly application: readonly WorkerdStoredModule[];
  readonly hostPrivate: readonly WorkerdStoredModule[];
}

export interface WorkerdSite {
  /** Directory holding this script's modules. */
  readonly directory: string;
  readonly mainModule: string;
  /**
   * Host-private entrypoint that imports the exact application main.
   *
   * Its logical spelling may equal `mainModule`: provenance, not a reserved
   * filename, keeps the two identities distinct.
   */
  readonly hostEntrypoint?: string;
  /** Additional Host-private modules, distinct from the application namespace. */
  readonly hostModules?: readonly string[];
  readonly hostnames: readonly string[];
  /** Durable identity of the desired publication, including its routes. */
  readonly generation?: string;
  /** Exact logical Worker incarnation. Absent only on a retained legacy site. */
  readonly workerResourceUid?: string;
  /** Whether this exact active Version declared the worker.runtime fetch handler. */
  readonly fetchHandler?: boolean;
  /** Logical fetch bindings; target selection never consults a request URL. */
  readonly serviceBindings?: readonly WorkerdServiceBinding[];
  /**
   * How the Host-owned HTTP router composes this script with its asset lookup.
   * Absent means it declared no assets and public traffic reaches the script
   * directly. Neither service is projected into the tenant environment.
   */
  readonly assets?: WorkerdAssetDeclaration;
  /**
   * Environment entries for this script. Absent and empty both render nothing,
   * so a script that declares none produces the same bytes it always did.
   */
  readonly vars?: readonly WorkerdBinding[];
  /**
   * Modules to declare beside the main one, in order.
   *
   * workerd resolves an import against the module registry the configuration
   * builds, so a module that is on disk but not named here cannot be imported.
   * Absent renders exactly the single-module configuration it always did.
   */
  readonly modules?: readonly string[];
  /**
   * Exact media types for every module in `mainModule` plus `modules`.
   *
   * Absent keeps the historical `esModule` declaration for every module. When
   * present, every declared module must have one entry and every entry must
   * name a declared module; the runtime never guesses from a file extension.
   */
  readonly moduleMediaTypes?: Readonly<Record<string, WorkerdModuleMediaType>>;
  /**
   * The Host-owned facade service this script's generated entrypoint calls.
   *
   * Absent means this script binds no KV namespace and no SQLite database, and
   * renders exactly the configuration it always did. Present renders a second
   * service beside the script — its own module, its own bindings — and gives
   * the script a plain service binding to it. The token and the loopback
   * address are declared there and never on the script, because workerd hands
   * every binding of a service to every module that service runs.
   */
  readonly dataPlane?: WorkerdDataPlane;
  /**
   * The Host-owned gate a queue batch or a cron match reaches this script
   * through.
   *
   * Absent means nothing delivers events to this script, and it renders exactly
   * the configuration it always did. Present renders one more service beside
   * the script — its own module, its own token — and a route on a hostname of
   * this Host's own that reaches the gate and never the script. The gate is the
   * only holder of a binding that names the script's event entrypoint, so a
   * customer request at the script's own hostname reaches `fetch` and nothing
   * else.
   */
  readonly events?: WorkerdEventGate;
}

/** One exact private Version in a single logical Worker publication. */
export interface WorkerdDeploymentVariant extends SelfhostWeightedVersion {
  /** Version-scoped runtime declaration. Its routes and Worker identity are owned above it. */
  readonly site: WorkerdSite;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly assets?: ReadonlyMap<string, Uint8Array>;
  readonly hostModules?: ReadonlyMap<string, Uint8Array>;
}

/** The complete graph a logical Worker activates in one runtime write. */
export interface WorkerdDeploymentPublication {
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly hostnames: readonly string[];
  readonly versions: readonly WorkerdDeploymentVariant[];
}

/** Exact weighted identity behind the runtime's committed stable pointer. */
export interface WorkerdActiveDeployment {
  readonly generation: string;
  readonly versions: readonly SelfhostWeightedVersion[];
  /** Whether the committed graph contains the one logical event dispatcher. */
  readonly events: boolean;
}

/**
 * One exact Version selected from the active private weighted publication.
 *
 * The returned graph is caller-owned: module and asset bytes, bindings, and
 * every nested declaration are copied out of the operator-private durable
 * tree. No physical storage key or root is exposed to the caller.
 * This includes secrets: never log or persist it, or expose it through a
 * provider/status response. Retain it only for trusted child preparation and
 * release references after disposal; JavaScript strings are not zeroizable.
 */
export interface WorkerdSelectedActiveVersion {
  readonly generation: string;
  readonly generationKey: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionUid: string;
  readonly site: WorkerdSite;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly hostModules: ReadonlyMap<string, Uint8Array>;
  readonly assets?: ReadonlyMap<string, Uint8Array>;
}

/** The gate service one script receives its events through. */
export interface WorkerdEventGate {
  /** Module inside the script's directory that implements the gate. */
  readonly module: string;
  /** Bindings for the gate alone; this is where the event token lives. */
  readonly vars: readonly WorkerdBinding[];
}

/** The facade service one script's entrypoint reaches its storage through. */
export interface WorkerdDataPlane {
  /** Loopback address of this Host's KV and SQL planes. */
  readonly address: string;
  /** Module inside the script's directory that implements the facade. */
  readonly module: string;
  /** Bindings for the facade service alone; this is where the token lives. */
  readonly vars: readonly WorkerdBinding[];
}

/** The seam a provider publishes through: files present, config rewritten. */
export interface WorkerdRuntime {
  /** Load one credential-free module snapshot in a fresh bounded runtime. */
  readonly inspectModule: ReturnType<typeof createWorkerdWorkerModuleInspector>["inspect"];
  /**
   * Atomically activates one complete weighted deployment, or removes its
   * logical routes. Implementations without this capability must leave this
   * absent; a provider may then refuse weighted publication before mutation.
   */
  publish?(name: string, publication: WorkerdDeploymentPublication | null): Promise<void>;
  /** Makes a published script's files present, replacing whatever was there. */
  write(
    name: string,
    site: WorkerdSite,
    modules: ReadonlyMap<string, Uint8Array>,
    assets?: ReadonlyMap<string, Uint8Array>,
    hostModules?: ReadonlyMap<string, Uint8Array>,
  ): Promise<void>;
  /** Forgets a script and its files. */
  remove(name: string): Promise<void>;
  /** Rewrites the configuration from every script currently published. */
  reload(): Promise<void>;
  /** Whether the requested generation is actually activated, for `observe`. */
  has(name: string, generation?: string): Promise<boolean>;
  /**
   * Asks one published script a question over the router this runtime serves.
   *
   * `null` means the runtime did not answer at all — it is not running, or it
   * is restarting on the configuration just written — which is a different
   * thing from a script that answered badly and must never be read as one.
   */
  probe?(
    name: string,
    path: string,
    init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      /** The exact body, when the question carries one. */
      readonly body?: string;
      /**
       * Which of this Host's own hostnames to ask on. `internal` reaches the
       * script itself and is what readiness uses; `events` reaches the gate in
       * front of it, which is the only way an event may enter.
       */
      readonly route?: "internal" | "events";
      readonly timeoutMillis?: number;
    },
  ): Promise<{ readonly status: number; readonly body: string } | null>;
}

/** Exact private selection, not provider desired state or caller-supplied bindings. */
export interface WorkerdSelectedVersionIdentity {
  readonly script: string;
  readonly generation: string;
  readonly generationKey: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionUid: string;
}

/** Secret-bearing execution capability; never log, persist or expose through a provider. */
export interface WorkerdPrivateServiceLease {
  readonly services: readonly {
    readonly name: string;
    readonly upstreamSocket: string;
    readonly unavailableToken: string;
  }[];
  /**
   * Release only before a child starts or after child/gateway reap and ingress
   * drain. Artifact removal is an independent cleanup obligation: its failure
   * must not retain an otherwise unused live service lease.
   * Idempotent and retry-safe: even a rejection after release took effect must
   * allow another call without releasing a different holder's pin.
   */
  release(): Promise<void>;
}

/**
 * Composition-owned lifecycle and private execution, not provider authority.
 * The composition restores the process and retains bindings for its children;
 * a provider only publishes through WorkerdRuntime.
 */
export interface HostedWorkerdRuntime extends WorkerdRuntime {
  /**
   * Brings the runtime back up for whatever is already published.
   *
   * Answers the names it restored, or nothing when this machine has published
   * no Worker — which is the case a boot must not start a runtime for. The
   * configuration is re-rendered from the durable manifests rather than trusted
   * as it stands, so a machine whose configuration was written by an older
   * build comes back on this one's router.
   */
  restore(): Promise<readonly string[]>;
  /**
   * Pin a captured caller's binding routers while targets follow the current
   * graph. Abort before acquisition rejects without waiting for queued reads;
   * an already acquired lease is returned for the caller's owned cleanup.
   */
  acquirePrivateServiceBindings(
    identity: WorkerdSelectedVersionIdentity,
    signal?: AbortSignal,
  ): Promise<WorkerdPrivateServiceLease>;
}

/**
 * The certificate this runtime's socket serves, when the operator configured
 * one.
 *
 * Both halves are PEM text — the private key and the leaf-first certificate
 * chain — and they are rendered into the generated configuration, which is
 * already written `0600` inside a `0700` directory because it carries every
 * script's environment. workerd terminates the TLS itself; there is no reverse
 * proxy in front of it and nothing else to keep in step.
 */
export interface WorkerdTlsKeypair {
  readonly privateKey: string;
  readonly certificateChain: string;
}

export interface WorkerdRuntimeOptions {
  /** Directory holding scripts and the generated configuration. */
  readonly root: string;
  /** Same binary selected by the serving supervisor; null makes inspection unavailable. */
  readonly binary?: string | null;
  /**
   * Where the generated config is written. Kept beside the scripts by default,
   * because workerd resolves an `embed` relative to the config's own
   * directory — an absolute path is not read, and the failure arrives as a
   * startup error naming a file that plainly exists.
   */
  readonly configPath?: string;
  /** Port the router listens on. */
  readonly port?: number;
  /** Current Host-owned loopback listener; persisted Versions retain their original metadata. */
  readonly dataPlaneAddress?: string;
  /**
   * Opt-in, existing operator-owned 0700 directory for private service sockets.
   * Must be canonical, non-symlinked and short enough for a 64-hex `.sock` name
   * within 100 bytes, outside root. It must be fresh and empty for this runtime
   * incarnation; its lifecycle follows the shared supervisor, not a run.
   * Requires immutable weighted publish(); legacy write()/remove() are refused.
   */
  readonly serviceBindingSocketDirectory?: string;
  /**
   * Terminates TLS on that port with this keypair. Absent means the socket is
   * plain HTTP, which is what the Host must then publish as the endpoint
   * address: advertising `https` for a socket that speaks `http` gives out an
   * address nothing answers on.
   */
  readonly tls?: WorkerdTlsKeypair;
  /** Called after the config is rewritten, to make workerd read it. */
  readonly onReload?: (configPath: string) => Promise<void>;
  /** Runtime liveness/readiness truth for serving observations. */
  readonly isReady?: () => boolean;
}

interface Manifest {
  readonly mainModule: string;
  readonly hostEntrypoint?: string;
  readonly hostModules?: readonly string[];
  readonly moduleStorageLayout: typeof WORKERD_MODULE_STORAGE_LAYOUT;
  readonly moduleFiles: WorkerdModuleStorageManifest;
  readonly hostnames: readonly string[];
  readonly generation?: string;
  readonly workerResourceUid?: string;
  readonly fetchHandler?: boolean;
  readonly serviceBindings?: readonly WorkerdServiceBinding[];
  readonly assets?: WorkerdAssetManifest;
  readonly vars?: readonly WorkerdBinding[];
  readonly modules?: readonly string[];
  readonly moduleMediaTypes?: Readonly<Record<string, WorkerdModuleMediaType>>;
  readonly dataPlane?: WorkerdDataPlane;
  readonly events?: WorkerdEventGate;
}

interface WorkerdDeploymentStoredVersion extends SelfhostWeightedVersion {
  readonly storageKey: string;
  readonly manifest: Manifest;
}

interface WorkerdDeploymentManifest {
  readonly publicationStorageLayout: typeof WORKERD_DEPLOYMENT_STORAGE_LAYOUT;
  readonly generation: string;
  readonly workerResourceUid: string;
  readonly hostnames: readonly string[];
  readonly versions: readonly WorkerdDeploymentStoredVersion[];
}

interface WorkerdDeploymentPointer {
  readonly publicationStorageLayout: typeof WORKERD_DEPLOYMENT_STORAGE_LAYOUT;
  readonly generation: string;
  readonly generationKey: string;
}

const MANIFEST = "takoserver-site.json";
/**
 * The service binding a generated entrypoint reaches its facade through, and
 * the one the facade reaches the Bun planes through.
 *
 * Kept in step with the provider's own constants by name rather than by import:
 * this module is the runtime, and it must not depend on the provider that
 * publishes into it.
 */
const DATA_SERVICE_BINDING = "__TAKOSERVER_SELFHOST_DATA";
const DATA_PLANE_BINDING = "__TAKOSERVER_SELFHOST_DATA_PLANE";
/**
 * The gate's binding to the script's event entrypoint, and the named export it
 * addresses.
 *
 * Kept in step with the provider's constants by name for the same reason as
 * the two above: this module is the runtime, and it must not depend on the
 * provider that publishes into it.
 */
const EVENT_TARGET_BINDING = "__TAKOSERVER_SELFHOST_EVENT_TARGET";
const EVENT_ENTRYPOINT = "takoserverSelfhostEvents";
const SERVICE_UNAVAILABLE_TOKEN_BINDING = "UNAVAILABLE_TOKEN";
/**
 * Compatibility flags for a script published through a generated entrypoint.
 *
 * The module policy, rather than a source-language subset, decides what an
 * import may resolve. `disallow_importable_env` keeps the handler's bindings
 * out of the ambient cloudflare:workers export. The facade service is what
 * actually keeps Host tokens away from tenant code.
 */
const APPLICATION_COMPATIBILITY_FLAGS = ["disallow_importable_env"] as const;
/**
 * The hostname this Host asks a generated entrypoint its own questions on.
 *
 * A script is reachable through the router by `Host` and by nothing else, so a
 * publication that has not been given a customer hostname yet would be
 * unreachable — including to the readiness probe that decides whether it may be
 * published at all. `.invalid` can never be delegated, and the route is written
 * after the customer routes so a claimed custom domain cannot capture it.
 */
const INTERNAL_ROUTE_SUFFIX = ".selfhost-internal.invalid";
/**
 * The hostname this Host delivers a script's events on.
 *
 * Separate from the readiness one because they reach different services: the
 * readiness probe asks the script itself, and an event must never be able to.
 * Written after the customer routes for the same reason.
 */
const EVENT_ROUTE_SUFFIX = ".selfhost-events.invalid";
const CONFIG_PROBE_HOSTNAME = "runtime.selfhost-config.invalid";
const CONFIG_PROBE_PATH = "/.well-known/takoserver/selfhost-runtime-config/v1";
const CONFIG_PROBE_HEADER = "x-takoserver-selfhost-runtime-config";
const CONFIG_IDENTITY_HEADER = "x-takoserver-selfhost-config-identity";
const WORKER_READINESS_PATH = "/.well-known/takoserver/selfhost-worker-readiness/v1";
const WORKER_READINESS_HEADER = "x-takoserver-selfhost-readiness";
const WORKER_READINESS_PROTOCOL = "takoserver.selfhost-worker-readiness@v1";
const INTERNAL_READINESS_CAPABILITY_HEADER = "x-takoserver-selfhost-runtime-readiness";
const INTERNAL_READINESS_CAPABILITY_BINDING = "__TAKOSERVER_SELFHOST_RUNTIME_READINESS";
/** Operator-private sibling tree holding every script's flat static files. */
const ASSETS_ROOT_DIRECTORY = "assets";
/** Exact persisted meaning of the private physical asset keys. */
const WORKERD_ASSET_STORAGE_LAYOUT = "flat-ordinal-v1" as const;
/** Separate physical roots mirror the runtime's two module namespaces. */
const WORKERD_MODULE_STORAGE_LAYOUT = "provenance-v1" as const;
/** One immutable tree plus one stable, atomically replaced pointer. */
const WORKERD_DEPLOYMENT_STORAGE_LAYOUT = "weighted-deployment-v1" as const;
const DEPLOYMENT_MANIFEST = "deployment.json";
const DEPLOYMENT_PUBLICATIONS_DIRECTORY = ".publications";
const APPLICATION_MODULE_DIRECTORY = "application";
const HOST_PRIVATE_MODULE_DIRECTORY = "host-private";
const SERVICE_ROUTER_MODULE = "service-router.js";
const DEPLOYMENT_ROUTER_MODULE = "deployment-router.js";
const EVENT_DISPATCHER_MODULE = "event-dispatcher.js";
const SERVICE_UNAVAILABLE_HEADER = "x-takoserver-selfhost-service-unavailable";

function privateRuntimeToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createWorkerdRuntime(options: WorkerdRuntimeOptions): HostedWorkerdRuntime {
  const serviceSocketDirectory = options.serviceBindingSocketDirectory;
  if (serviceSocketDirectory !== undefined) {
    validPrivateSocketDirectory(serviceSocketDirectory);
    const withinRoot = relative(resolve(options.root), serviceSocketDirectory);
    if (
      withinRoot === "" ||
      (!isAbsolute(withinRoot) && withinRoot !== ".." && !withinRoot.startsWith(`..${sep}`))
    ) {
      throw new Error("private service socket directory must be outside the runtime root");
    }
  }
  const dataPlaneAddress =
    options.dataPlaneAddress === undefined
      ? undefined
      : validDataPlaneAddress(options.dataPlaneAddress);
  const moduleInspector = createWorkerdWorkerModuleInspector({
    binary: options.binary ?? null,
    temporaryRoot: join(options.root, ".workerd-inspection"),
  });
  const scriptsRoot = join(options.root, "workers");
  // A sibling tree, not a reserved child of the tenant module tree: the
  // portable module grammar allows every child name, including `__assets`.
  const assetsRoot = join(options.root, ASSETS_ROOT_DIRECTORY);
  const configPath = options.configPath ?? join(scriptsRoot, "workerd.capnp");
  const port = options.port ?? 8788;
  const activationPath = join(scriptsRoot, ".takoserver-active.json");
  const configProbeToken = options.onReload === undefined ? "" : privateRuntimeToken();
  // Separate from config identity: this capability authorizes only the
  // Host-originated readiness path and is never bound into tenant code.
  const internalReadinessCapability = privateRuntimeToken();
  let activationTail: Promise<void> = Promise.resolve();
  const servicePins = new Map<string, { readonly binding: WorkerdServiceBinding; count: number }>();
  let renderedPrivateRouters = new Set<string>();
  let privateSocketRoot: PrivateSocketIdentity | undefined;
  const ownedPrivateSockets = new Map<string, PrivateSocketIdentity>();
  let pendingPrivateSockets: readonly string[] | undefined;
  let privateSocketTransition = 0;
  let privateSocketUncertain = false;

  const privateServiceGraph = (published: readonly PublishedDeployment[]) =>
    serviceSocketDirectory === undefined
      ? undefined
      : {
          socketDirectory: serviceSocketDirectory,
          bindings: collectServiceBindings(
            published,
            [...servicePins.values()].map((pin) => pin.binding),
          ),
        };
  const retainRenderedRouters = (published: readonly PublishedDeployment[]) => {
    renderedPrivateRouters = new Set(privateServiceGraph(published)?.bindings.keys());
  };

  const requireCertainRuntime = (): void => {
    if (privateSocketUncertain) {
      throw new Error("private service runtime requires a fresh supervised incarnation");
    }
  };

  const clearFailedActivation = async (failure: unknown): Promise<void> => {
    renderedPrivateRouters.clear();
    try {
      await writeActivation(activationPath, {});
    } catch (clearFailure) {
      if (serviceSocketDirectory !== undefined) privateSocketUncertain = true;
      throw new AggregateError(
        [failure, clearFailure],
        "worker runtime activation could not be cleared",
      );
    }
  };

  const requireSocketRoot = async (): Promise<void> => {
    if (serviceSocketDirectory === undefined) return;
    requireCertainRuntime();
    const metadata = await requirePrivateSocketDirectory(serviceSocketDirectory);
    if (privateSocketRoot === undefined) {
      if ((await readdir(serviceSocketDirectory)).length !== 0) {
        throw new Error("private service socket directory must be fresh and empty");
      }
      privateSocketRoot = metadata;
    } else if (!samePrivateSocketIdentity(privateSocketRoot, metadata)) {
      throw new Error("private service socket directory was replaced");
    }
  };

  // Capture only the graph being proved. An unproved reload may still create
  // listeners later: its paths must never be swept by an automatic rollback.
  const capturePrivateSockets = async (): Promise<boolean> => {
    if (pendingPrivateSockets === undefined) return true;
    await requireSocketRoot();
    let complete = true;
    for (const path of pendingPrivateSockets) {
      const metadata = await privateSocketMetadata(path);
      if (metadata === undefined) {
        if (ownedPrivateSockets.has(path)) throw new Error("private service socket disappeared");
        complete = false;
        continue;
      }
      const owned = ownedPrivateSockets.get(path);
      if (owned && !samePrivateSocketIdentity(owned, metadata)) {
        throw new Error("private service socket was replaced");
      }
      ownedPrivateSockets.set(path, metadata);
    }
    if (complete) pendingPrivateSockets = undefined;
    return complete;
  };

  const transitionPrivateSockets = async (published: readonly PublishedDeployment[]) => {
    if (serviceSocketDirectory === undefined) return;
    await requireSocketRoot();
    const next = [...(privateServiceGraph(published)?.bindings.keys() ?? [])].map((router) =>
      privateServiceSocket(serviceSocketDirectory, router),
    );
    // Validate the whole set before disrupting a single old listener. Never
    // adopt a pre-existing path merely because it has the right filename.
    for (const [path, owned] of ownedPrivateSockets) {
      const metadata = await privateSocketMetadata(path);
      if (metadata === undefined || !samePrivateSocketIdentity(owned, metadata)) {
        throw new Error("private service socket was replaced");
      }
    }
    for (const path of next) {
      if (!ownedPrivateSockets.has(path) && (await privateSocketMetadata(path)) !== undefined) {
        throw new Error("private service socket path is already occupied");
      }
    }
    privateSocketTransition += 1;
    for (const [path, owned] of ownedPrivateSockets) {
      // Recheck immediately before unlink; the directory excludes other UIDs.
      const metadata = await privateSocketMetadata(path);
      if (metadata === undefined || !samePrivateSocketIdentity(owned, metadata)) {
        throw new Error("private service socket was replaced");
      }
      await unlink(path);
      ownedPrivateSockets.delete(path);
    }
    pendingPrivateSockets = next;
  };

  /** Shared config and activation truth have one commit order across scripts. */
  const exclusiveActivation = <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = activationTail;
    const next = queued.then(operation, operation);
    activationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const scriptDirectory = (name: string): string => {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(name)) {
      throw new Error(`unusable script name: ${name}`);
    }
    return join(scriptsRoot, name);
  };
  const assetDirectory = (name: string): string => {
    scriptDirectory(name);
    return join(assetsRoot, name);
  };

  /**
   * Rewrites everything derived from the durable manifests, then makes workerd
   * read it.
   *
   * Named because two callers need exactly this and must not diverge: a publish,
   * and a boot bringing an already-published machine back up. A boot that
   * re-rendered by some other route would be the second place the router, the
   * asset shim and the socket are decided.
   */
  const writeRendered = async (published: readonly PublishedDeployment[]): Promise<void> => {
    if (serviceSocketDirectory !== undefined) {
      await requireSocketRoot();
    }
    await privateDirectory(scriptsRoot);
    for (const entry of published) await privateDirectory(join(scriptsRoot, entry.name));
    const assetPublications = published
      .filter((candidate) => !candidate.weighted)
      .flatMap((candidate) => candidate.variants)
      .filter((candidate) => candidate.manifest.assets);
    if (assetPublications.length > 0) {
      await privateDirectory(assetsRoot);
      for (const entry of assetPublications) await privateDirectory(assetDirectory(entry.name));
    }
    // Materialize the current Host helpers before the config that embeds them.
    // Identical helper writes would trigger --watch before the config/socket
    // transition. These sources are constant for this Host incarnation.
    const immutableHelpers = serviceSocketDirectory !== undefined && privateSocketTransition > 0;
    await writeRuntimeModule(join(scriptsRoot, "router.js"), ROUTER_SOURCE, immutableHelpers);
    await writeRuntimeModule(join(scriptsRoot, "assets.js"), ASSETS_SOURCE, immutableHelpers);
    await writeRuntimeModule(
      join(scriptsRoot, "asset-router.js"),
      ASSET_ROUTER_SOURCE,
      immutableHelpers,
    );
    await writeRuntimeModule(
      join(scriptsRoot, SERVICE_ROUTER_MODULE),
      SERVICE_ROUTER_SOURCE,
      immutableHelpers,
    );
    await writeRuntimeModule(
      join(scriptsRoot, DEPLOYMENT_ROUTER_MODULE),
      DEPLOYMENT_ROUTER_SOURCE,
      immutableHelpers,
    );
    await writeRuntimeModule(
      join(scriptsRoot, EVENT_DISPATCHER_MODULE),
      EVENT_DISPATCHER_SOURCE,
      immutableHelpers,
    );
    await privateDirectory(dirname(configPath));
    // The rendered configuration contains every binding value, sensitive ones
    // included, so it is created `0600` and moved into place atomically.
    await writePrivate(
      configPath,
      renderConfig(
        published,
        port,
        assetsRoot,
        options.tls,
        configProbeToken,
        internalReadinessCapability,
        dataPlaneAddress,
        privateServiceGraph(published),
      ),
      "utf8",
      () => transitionPrivateSockets(published),
    );
  };

  const activated = (published: readonly PublishedDeployment[]) =>
    Object.fromEntries(published.map((entry) => [entry.name, entry.generation ?? null]));

  const proveRendered = async (published: readonly PublishedDeployment[]): Promise<void> => {
    // A composition with no process hook intentionally stages files only. It
    // cannot prove serving truth, but `has()` will still fail closed unless its
    // composition supplies a live `isReady` probe.
    if (options.onReload === undefined) return;
    const expected = publishedGraphIdentity(published, privateServiceGraph(published));
    const deadline = Date.now() + 5_000;
    for (;;) {
      let confirmed = false;
      try {
        const response = await fetch(
          `${options.tls ? "https" : "http"}://127.0.0.1:${port}${CONFIG_PROBE_PATH}`,
          {
            method: "POST",
            headers: {
              host: CONFIG_PROBE_HOSTNAME,
              [CONFIG_PROBE_HEADER]: configProbeToken,
            },
            ...(options.tls ? { tls: { rejectUnauthorized: false } } : {}),
            signal: AbortSignal.timeout(1_000),
          },
        );
        confirmed =
          response.status === 204 && response.headers.get(CONFIG_IDENTITY_HEADER) === expected;
      } catch {
        // The watcher may still be crossing to the atomically replaced file.
      }
      if (confirmed && (await capturePrivateSockets())) return;
      if (Date.now() >= deadline) {
        throw new Error("worker runtime did not confirm the rendered configuration");
      }
      await new Promise<void>((wake) => setTimeout(wake, 25));
    }
  };

  /**
   * Moves the complete configuration, runtime process, stable publication
   * pointer, and activation truth as one recoverable transaction.
   *
   * `onReload` is an arbitrary process boundary: a throw does not prove that a
   * watching workerd ignored the new config. The default topology restores the
   * prior graph and proves that second crossing. Private Unix listeners instead
   * require a fresh supervised incarnation after an unproved transition: a
   * rollback could race sockets bound late by the first reload. Only a proved
   * private graph may roll back after a later commit failure. Uncertain
   * activation truth is cleared rather than fabricated.
   */
  const activate = async (
    published: readonly PublishedDeployment[],
    previous: readonly PublishedDeployment[],
    pointer?: {
      readonly commit: () => Promise<void>;
      readonly rollback: () => Promise<void>;
      readonly commitAfterActivation?: boolean;
    },
  ): Promise<void> => {
    requireCertainRuntime();
    const initialSocketTransition = privateSocketTransition;
    let graphProved = false;
    try {
      const before = activated(previous);
      const after = activated(published);
      const transitioning = new Set([...Object.keys(before), ...Object.keys(after)]);
      const indeterminate = { ...before };
      let changed = false;
      for (const name of transitioning) {
        if (before[name] === after[name]) continue;
        delete indeterminate[name];
        changed = true;
      }
      // A watcher may begin serving the new config before its stable pointer
      // commits. Clear only the changing scripts first so an external event
      // selector cannot mistake either side of that crossing for committed.
      if (changed) await writeActivation(activationPath, indeterminate);
      await writeRendered(published);
      await options.onReload?.(configPath);
      await proveRendered(published);
      graphProved = options.onReload !== undefined;
      if (!pointer?.commitAfterActivation) await pointer?.commit();
      await writeActivation(activationPath, activated(published));
      // Retiring a validated scalar carrier is the final fallible operation.
      // Its absence must not precede a marker write that could still fail.
      if (pointer?.commitAfterActivation) await pointer.commit();
      retainRenderedRouters(published);
    } catch (failure) {
      if (
        serviceSocketDirectory !== undefined &&
        initialSocketTransition === privateSocketTransition
      ) {
        // Preflight failed before any socket unlink or config rename. Do not
        // disrupt the old listeners by trying a second render of an unknown
        // filesystem. No pointer commit has happened; refuse serving claims.
        await clearFailedActivation(failure);
        throw failure;
      }
      if (serviceSocketDirectory !== undefined && !graphProved) {
        // A timed-out/throwing reload can still bind listeners after this
        // catch. Only external stop/reap and a fresh runtime/socket directory
        // can recover it; do not race that process with a rollback sweep.
        privateSocketUncertain = true;
        await clearFailedActivation(failure);
        throw failure;
      }
      try {
        await pointer?.rollback();
        // Re-render the exact prior graph with this process's private probe
        // token. A config left by an earlier Host instance contains that
        // instance's token, so restoring its bytes would make an otherwise
        // successful rollback impossible for this process to authenticate.
        await writeRendered(previous);
        await options.onReload?.(configPath);
        await proveRendered(previous);
        // The graph just proved is the authority. A marker captured before
        // this call may be stale after a crash between pointer commit and
        // marker commit, especially during boot restore.
        await writeActivation(activationPath, activated(previous));
        retainRenderedRouters(previous);
      } catch (rollbackFailure) {
        // The child may now be serving either graph. No per-script marker is
        // trustworthy across a failed process boundary, so fail closed for
        // the whole runtime rather than claiming a rollback that was not seen.
        if (serviceSocketDirectory !== undefined) privateSocketUncertain = true;
        const unknownState = new AggregateError(
          [failure, rollbackFailure],
          "worker runtime activation state is unknown",
        );
        await clearFailedActivation(unknownState);
        throw unknownState;
      }
      throw failure;
    }
  };

  const stageDeployment = async (
    name: string,
    publication: WorkerdDeploymentPublication,
  ): Promise<{
    readonly pointer: WorkerdDeploymentPointer;
    readonly deployment: PublishedDeployment;
  }> => {
    scriptDirectory(name);
    if (typeof publication.generation !== "string") {
      throw new Error("unusable worker deployment generation");
    }
    capnpText(publication.generation);
    const workerResourceUid = validWorkerResourceUid(publication.workerResourceUid);
    const hostnames = validDeploymentHostnames(publication.hostnames);
    internalHostname(name);
    eventHostname(name);
    if (!Array.isArray(publication.versions)) {
      throw new Error("unusable weighted worker deployment");
    }
    const canonical = canonicalSelfhostWeightedVersions(
      publication.versions.map(({ versionId, workerVersionUid, weight }) => ({
        versionId,
        workerVersionUid,
        weight,
      })),
    );
    const byUid = new Map(
      publication.versions.map((version) => [version.workerVersionUid, version]),
    );
    const preparedVersions: Array<{
      readonly identity: SelfhostWeightedVersion;
      readonly storageKey: string;
      readonly prepared: PreparedWorkerdSite;
    }> = [];
    // This loop is deliberately complete before the first mkdir/write. A bad
    // second Version must not stage state for the first one.
    for (let index = 0; index < canonical.length; index += 1) {
      const identity = canonical[index] as SelfhostWeightedVersion;
      const variant = byUid.get(identity.workerVersionUid);
      if (
        !variant ||
        variant.versionId !== identity.versionId ||
        variant.weight !== identity.weight
      ) {
        throw new Error("unusable weighted worker deployment");
      }
      if (
        variant.site.hostnames.length !== 0 ||
        (variant.site.generation !== undefined &&
          variant.site.generation !== publication.generation) ||
        (variant.site.workerResourceUid !== undefined &&
          variant.site.workerResourceUid !== workerResourceUid)
      ) {
        throw new Error("unusable private worker Version declaration");
      }
      const prepared = await prepareWorkerdSite(
        {
          ...variant.site,
          hostnames: [],
          generation: publication.generation,
          workerResourceUid,
        },
        variant.modules,
        variant.assets,
        variant.hostModules,
      );
      if (!prepared.manifest.hostEntrypoint) {
        throw new Error("weighted worker Versions require a Host entrypoint");
      }
      preparedVersions.push({
        identity,
        storageKey: `version-${index.toString(10).padStart(5, "0")}`,
        prepared,
      });
    }
    const eventShapes = new Set(
      preparedVersions.map(({ prepared }) => prepared.manifest.events !== undefined),
    );
    if (eventShapes.size > 1) {
      throw new Error("weighted worker Versions require one event capability shape");
    }
    const manifest: WorkerdDeploymentManifest = {
      publicationStorageLayout: WORKERD_DEPLOYMENT_STORAGE_LAYOUT,
      generation: publication.generation,
      workerResourceUid,
      hostnames,
      versions: preparedVersions.map(({ identity, storageKey, prepared }) => ({
        ...identity,
        storageKey,
        manifest: prepared.manifest,
      })),
    };
    const manifestJson = JSON.stringify(manifest);
    const generationKey = createHash("sha256").update(manifestJson, "utf8").digest("hex");
    const publicationRoot = join(scriptsRoot, DEPLOYMENT_PUBLICATIONS_DIRECTORY, name);
    const generationRoot = join(publicationRoot, generationKey);
    const existing = await lstat(generationRoot).catch(() => null);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("unusable worker deployment snapshot");
      }
      const current = await readFile(join(generationRoot, DEPLOYMENT_MANIFEST), "utf8");
      if (current !== manifestJson) throw new Error("conflicting worker deployment snapshot");
    } else {
      await privateDirectory(join(scriptsRoot, DEPLOYMENT_PUBLICATIONS_DIRECTORY));
      await privateDirectory(publicationRoot);
      const staging = join(publicationRoot, `.tmp-${crypto.randomUUID()}`);
      try {
        await privateDirectory(staging);
        for (const version of preparedVersions) {
          await writePreparedWorkerdSite(join(staging, version.storageKey), version.prepared);
        }
        await writePrivate(join(staging, DEPLOYMENT_MANIFEST), manifestJson, "utf8");
        await rename(staging, generationRoot);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const pointer: WorkerdDeploymentPointer = {
      publicationStorageLayout: WORKERD_DEPLOYMENT_STORAGE_LAYOUT,
      generation: publication.generation,
      generationKey,
    };
    // Re-open every stored byte and manifest through the restart reader before
    // this generation is eligible to enter a config.
    const deployment = await readWeightedDeployment(scriptsRoot, name, pointer);
    return { pointer, deployment };
  };

  return {
    inspectModule: (input) => moduleInspector.inspect(input),
    acquirePrivateServiceBindings(identity, signal) {
      // Copy before entering the queue so a caller cannot change the requested
      // identity while another publication owns the activation lock.
      const requested = { ...identity };
      let leaseAcquired = false;
      const pending = exclusiveActivation(async () => {
        signal?.throwIfAborted();
        const unavailable = () =>
          new Error("private execution service binding bridge is unavailable");
        if (
          serviceSocketDirectory === undefined ||
          options.onReload === undefined ||
          options.isReady?.() !== true
        ) {
          throw unavailable();
        }
        await requireSocketRoot();
        const active = await readWorkerdActiveDeployment(options.root, requested.script);
        if (!active || active.generation !== requested.generation) throw unavailable();
        let basisPoint = 0;
        let found = false;
        for (const version of active.versions) {
          if (
            version.versionId === requested.versionId &&
            version.workerVersionUid === requested.workerVersionUid
          ) {
            found = true;
            break;
          }
          basisPoint += version.weight;
        }
        if (!found) throw unavailable();
        const selected = await readWorkerdSelectedActiveVersion(options.root, requested.script, {
          expectedWorkerResourceUid: requested.workerResourceUid,
          basisPoint,
        });
        if (
          !selected ||
          selected.generation !== requested.generation ||
          selected.generationKey !== requested.generationKey ||
          selected.workerResourceUid !== requested.workerResourceUid ||
          selected.versionId !== requested.versionId ||
          selected.workerVersionUid !== requested.workerVersionUid ||
          options.isReady?.() !== true
        ) {
          throw unavailable();
        }
        // Binding declarations come only from the authenticated immutable
        // manifest. The caller cannot supply a different target or token.
        const bindings = validServiceBindings(selected.site.serviceBindings ?? []);
        const routers = bindings.map(serviceRouterName);
        if (routers.some((router) => !renderedPrivateRouters.has(router))) throw unavailable();
        for (const router of routers) {
          const path = privateServiceSocket(serviceSocketDirectory, router);
          const owned = ownedPrivateSockets.get(path);
          const metadata = await privateSocketMetadata(path);
          if (!owned || !metadata || !samePrivateSocketIdentity(owned, metadata)) {
            throw unavailable();
          }
        }
        let released = false;
        const lease: WorkerdPrivateServiceLease = {
          services: bindings.map((binding) => ({
            name: binding.name,
            upstreamSocket: privateServiceSocket(
              serviceSocketDirectory,
              serviceRouterName(binding),
            ),
            unavailableToken: binding.unavailableToken,
          })),
          release: () =>
            exclusiveActivation(async () => {
              if (released) return;
              released = true;
              for (const router of routers) {
                const pin = servicePins.get(router);
                if (!pin) continue;
                pin.count -= 1;
                if (pin.count === 0) servicePins.delete(router);
              }
              // No child can hold the socket after this lifecycle barrier. Lazy
              // pruning avoids a shared-graph reload for every completed run.
            }),
        };
        // Build paths and the complete lease before the synchronous pin
        // commit. No fallible service mapping or await can lose a new pin.
        const additions = bindings.map((binding) => ({
          binding,
          router: serviceRouterName(binding),
        }));
        signal?.throwIfAborted();
        for (const { binding, router } of additions) {
          const existing = servicePins.get(router);
          if (existing) existing.count += 1;
          else servicePins.set(router, { binding, count: 1 });
        }
        leaseAcquired = true;
        return lease;
      });
      if (!signal) return pending;
      return new Promise<WorkerdPrivateServiceLease>((resolve, reject) => {
        const onAbort = (): void => {
          if (leaseAcquired) return;
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        // Retain both handlers after an early abort. If the synchronous pin
        // commit already happened, deliver its lease rather than losing it to
        // an abort race; preparation observes abort and owns the release.
        void pending.then(
          (lease) => {
            signal.removeEventListener("abort", onAbort);
            resolve(lease);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    },
    async publish(name, publication) {
      requireCertainRuntime();
      const directory = scriptDirectory(name);
      const pointerPath = join(directory, MANIFEST);
      const removePointer = async (): Promise<void> => {
        await rm(pointerPath, { force: true });
        try {
          // An empty carrier is not a partial publication. Remove it without
          // touching retained generations or a nonempty, incomplete script.
          await rmdir(directory);
        } catch (error) {
          const code = (error as { readonly code?: unknown }).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        }
      };
      // Without private sockets, immutable generation staging can proceed in
      // parallel for different Workers. The shared graph snapshot/commit is
      // always serialized so two valid publishes cannot each render a graph
      // missing the other. Private staging also shares the uncertainty fence.
      const concurrentStaged =
        publication === null || serviceSocketDirectory !== undefined
          ? null
          : await stageDeployment(name, publication);
      await exclusiveActivation(async () => {
        requireCertainRuntime();
        // Private publication staging shares the uncertain-state fence. It
        // cannot keep writing after another activation invalidates this Host.
        const staged =
          serviceSocketDirectory !== undefined && publication !== null
            ? await stageDeployment(name, publication)
            : concurrentStaged;
        const previous = await readPublished(scriptsRoot, assetsRoot);
        const beforePointer = await readFile(pointerPath, "utf8").catch(() => null);
        const next = (
          staged === null
            ? previous.filter((entry) => entry.name !== name)
            : [...previous.filter((entry) => entry.name !== name), staged.deployment]
        ).sort((left, right) => left.name.localeCompare(right.name));
        const pointerContents = staged === null ? null : JSON.stringify(staged.pointer);
        const retiringScalar =
          staged === null && previous.some((entry) => entry.name === name && !entry.weighted);
        let retiredCarrier: string | undefined;
        if (retiringScalar) {
          // Only the fully validated runtime publication authorizes this move.
          // Provider desired state may already have cleared its legacy scalar.
          // Retain the modules for recovery; legacy assets keep their old path
          // so an in-flight request can still read them after graph replacement.
          const retainedRoot = join(scriptsRoot, ".retired");
          await privateDirectory(retainedRoot);
          retiredCarrier = join(await mkdtemp(join(retainedRoot, `${name}-`)), "publication");
        }
        let retirementCommitted = false;
        try {
          await activate(next, previous, {
            ...(retiredCarrier === undefined ? {} : { commitAfterActivation: true }),
            commit: async () => {
              if (retiredCarrier !== undefined) {
                await rename(directory, retiredCarrier);
                retirementCommitted = true;
                return;
              }
              if (pointerContents === null) {
                await removePointer();
              } else {
                await privateDirectory(directory);
                await writePrivate(pointerPath, pointerContents, "utf8");
              }
            },
            rollback: async () => {
              // A failed scalar retirement leaves its original carrier in place;
              // no operation follows a successful rename that could need rollback.
              if (retiredCarrier !== undefined) return;
              if (beforePointer === null) {
                await removePointer();
              } else {
                await privateDirectory(directory);
                await writePrivate(pointerPath, beforePointer, "utf8");
              }
            },
          });
        } catch (failure) {
          if (retiredCarrier !== undefined && !retirementCommitted) {
            // This operation created the private staging parent. Failed
            // attempts must not accumulate it; committed recovery bytes stay.
            try {
              await rm(dirname(retiredCarrier), { recursive: true, force: true });
            } catch (cleanupFailure) {
              throw new AggregateError(
                [failure, cleanupFailure],
                "worker retirement staging cleanup failed",
              );
            }
          }
          throw failure;
        }
      });
    },
    async write(name, site, modules, assets, hostModules) {
      requireCertainRuntime();
      if (serviceSocketDirectory !== undefined) {
        throw new Error("private service runtime requires immutable weighted publication");
      }
      const directory = scriptDirectory(name);
      // Validate the declaration before removing the currently serving
      // directory. A bad media map is a rejected publication, not a reason to
      // destroy the last known-good bytes.
      const mainModule = validModules([site.mainModule])[0] as string;
      const declaredModules = validModules(site.modules ?? [], site.mainModule);
      const moduleMediaTypes = validModuleMediaTypes(
        mainModule,
        declaredModules,
        site.moduleMediaTypes,
      );
      const hostEntrypoint =
        site.hostEntrypoint === undefined
          ? undefined
          : (validModules([site.hostEntrypoint])[0] as string);
      const declaredHostModules = validHostModuleNames(site, hostEntrypoint);
      const applicationSnapshot = await snapshotModuleBytes(
        modules,
        [mainModule, ...declaredModules],
        "application",
      );
      const hostSnapshot = await snapshotModuleBytes(
        hostModules ?? new Map(),
        declaredHostModules,
        "Host-private",
      );
      const assetDeclaration = await validAssets(site.assets, assets);
      const workerResourceUid =
        site.workerResourceUid === undefined
          ? undefined
          : validWorkerResourceUid(site.workerResourceUid);
      if (
        (workerResourceUid === undefined) !== (site.fetchHandler === undefined) ||
        (site.fetchHandler !== undefined && typeof site.fetchHandler !== "boolean")
      ) {
        throw new Error("unusable worker service identity");
      }
      const serviceBindings = validServiceBindings(site.serviceBindings ?? []);
      if (serviceBindings.length > 0 && workerResourceUid === undefined) {
        throw new Error("unusable worker service binding");
      }
      // Replaced rather than merged: a module the new bundle does not contain
      // must not survive from the old one, where it would be loadable and
      // wrong.
      await rm(directory, { recursive: true, force: true });
      await rm(assetDirectory(name), { recursive: true, force: true });
      await privateDirectory(scriptsRoot);
      await privateDirectory(directory);
      const applicationDirectory = join(directory, APPLICATION_MODULE_DIRECTORY);
      const hostDirectory = join(directory, HOST_PRIVATE_MODULE_DIRECTORY);
      await privateDirectory(applicationDirectory);
      if (declaredHostModules.length > 0) await privateDirectory(hostDirectory);
      if (assetDeclaration) {
        await privateDirectory(assetsRoot);
        await privateDirectory(assetDirectory(name));
      }

      for (const entry of applicationSnapshot.entries) {
        await writeFile(join(applicationDirectory, entry.key), entry.bytes);
      }
      for (const entry of hostSnapshot.entries) {
        await writeFile(join(hostDirectory, entry.key), entry.bytes);
      }

      for (const [assetName, bytes] of assetDeclaration?.entries ?? []) {
        const path = join(assetDirectory(name), assetName);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }

      // Written last. Until it exists the directory is not a script. It now
      // carries binding values, so it is written with the same `0600` care as
      // the configuration rendered from it.
      await writePrivate(
        join(directory, MANIFEST),
        JSON.stringify({
          mainModule: site.mainModule,
          ...(hostEntrypoint === undefined ? {} : { hostEntrypoint }),
          ...(site.hostModules && site.hostModules.length > 0
            ? { hostModules: [...site.hostModules] }
            : {}),
          moduleStorageLayout: WORKERD_MODULE_STORAGE_LAYOUT,
          moduleFiles: {
            application: applicationSnapshot.manifest,
            hostPrivate: hostSnapshot.manifest,
          },
          hostnames: site.hostnames,
          ...(site.generation === undefined ? {} : { generation: site.generation }),
          ...(workerResourceUid === undefined ? {} : { workerResourceUid }),
          ...(site.fetchHandler === undefined ? {} : { fetchHandler: site.fetchHandler }),
          ...(serviceBindings.length > 0 ? { serviceBindings } : {}),
          ...(assetDeclaration ? { assets: assetDeclaration.configuration } : {}),
          ...(site.vars && site.vars.length > 0 ? { vars: validBindings(site.vars) } : {}),
          ...(site.modules && site.modules.length > 0 ? { modules: declaredModules } : {}),
          ...(moduleMediaTypes ? { moduleMediaTypes } : {}),
          ...(site.dataPlane ? { dataPlane: validDataPlane(site.dataPlane) } : {}),
          ...(site.events ? { events: validEventGate(site.events) } : {}),
        }),
        "utf8",
      );
    },

    async remove(name) {
      requireCertainRuntime();
      if (serviceSocketDirectory !== undefined) {
        throw new Error("private service runtime requires immutable weighted publication");
      }
      await rm(scriptDirectory(name), { recursive: true, force: true });
      await rm(assetDirectory(name), { recursive: true, force: true });
    },

    async has(name, generation) {
      return await exclusiveActivation(async () => {
        if (privateSocketUncertain) return false;
        const active = await readActivation(activationPath);
        if (!(name in active)) return false;
        if (generation !== undefined && active[name] !== generation) return false;
        // A marker only records the generation the last successful reload
        // attempted to activate. Without an explicit process-readiness probe
        // there is no runtime truth to distinguish staged files from serving
        // traffic, so fail closed and discard the marker.
        if (options.isReady === undefined || !options.isReady()) {
          // A dead child or failed boot invalidates the activation marker.
          // Serialize this read-modify-write with graph activation so it
          // cannot erase a generation another publication just committed.
          const next = { ...active };
          delete next[name];
          await writeActivation(activationPath, next);
          return false;
        }
        return true;
      });
    },

    async probe(name, path, init) {
      if (privateSocketUncertain) return null;
      let hostname: string;
      try {
        hostname = init.route === "events" ? eventHostname(name) : internalHostname(name);
      } catch {
        return null;
      }
      try {
        const headers = new Headers(init.headers);
        // The public `probe` shape does not grant callers a way to inject this
        // internal capability. Only the exact readiness question on the
        // Host-owned route receives it; event and arbitrary internal probes
        // have any same-named input stripped.
        headers.delete(INTERNAL_READINESS_CAPABILITY_HEADER);
        if (
          init.route !== "events" &&
          init.method === "POST" &&
          path === WORKER_READINESS_PATH &&
          headers.get(WORKER_READINESS_HEADER) === WORKER_READINESS_PROTOCOL
        ) {
          headers.set(INTERNAL_READINESS_CAPABILITY_HEADER, internalReadinessCapability);
        }
        headers.set("host", hostname);
        // This Host asking its own runtime, over loopback, by address. Where the
        // socket terminates TLS the certificate names the endpoint suffix and
        // not `127.0.0.1`, so verifying it here would refuse every publication
        // on a correctly configured machine; the connection never leaves this
        // host and the answer is authenticated by the publication it names.
        const response = await fetch(
          `${options.tls ? "https" : "http"}://127.0.0.1:${port}${path}`,
          {
            method: init.method,
            headers,
            ...(init.body === undefined ? {} : { body: init.body }),
            ...(options.tls ? { tls: { rejectUnauthorized: false } } : {}),
            // A readiness question is answered by this Host's own module and is
            // over in milliseconds. An event runs a customer's handler, so the
            // caller says how long it is willing to wait for one.
            signal: AbortSignal.timeout(init.timeoutMillis ?? 2_000),
          },
        );
        // Bounded because the answer is this Host's own small envelope and the
        // body on the other side of that router is a tenant's Worker.
        const body = (await response.text()).slice(0, 65_536);
        if (privateSocketUncertain) return null;
        return { status: response.status, body };
      } catch {
        return null;
      }
    },

    async restore() {
      // The one question a boot has to ask before starting anything: is there a
      // Worker on this machine at all. Rendering an empty configuration and
      // starting a runtime for it would give every machine a workerd it never
      // asked for, which is exactly what deferring the start to the first
      // publish was avoiding.
      return await exclusiveActivation(async () => {
        requireCertainRuntime();
        const published = await readPublished(scriptsRoot, assetsRoot);
        if (published.length === 0) return [];
        await activate(published, published);
        return published.map((entry) => entry.name);
      });
    },

    async reload() {
      await exclusiveActivation(async () => {
        requireCertainRuntime();
        const published = await readPublished(scriptsRoot, assetsRoot);
        await activate(published, published);
      });
    },
  };
}

/**
 * Creates a file only this process's user can read, then moves it into place.
 *
 * `O_EXCL` plus `O_NOFOLLOW` means an attacker who can create paths in the
 * directory cannot pre-place a symlink and have the secret written through it,
 * and the rename means a reader never observes a partially written config.
 */
async function writePrivate(
  path: string,
  contents: string,
  encoding: "utf8",
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let closed = false;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, encoding);
    await handle.sync();
    await handle.close();
    closed = true;
    await beforeRename?.();
    await rename(temporary, path);
  } finally {
    if (!closed) await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeRuntimeModule(
  path: string,
  contents: string,
  immutable: boolean,
): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === contents) return;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (immutable)
    throw new Error("private service runtime helpers require a fresh supervised incarnation");
  await writeFile(path, contents, "utf8");
}

/**
 * A directory this process is willing to keep a secret in.
 *
 * `mkdir(mode)` is a no-op on a directory that already exists, so a tree
 * created by an earlier version of this Host — or by an operator's `mkdir -p` —
 * keeps whatever mode it was made with, and the `0o700` above is silently not
 * applied. These directories hold rendered binding values and the manifests
 * they were rendered from, so the mode is tightened and then re-read: a
 * directory this process cannot make private is one it refuses to publish into,
 * rather than one it publishes into and hopes about.
 */
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
  if (((await stat(path)).mode & 0o077) !== 0) {
    throw new Error(`refusing to publish into a group- or world-accessible directory: ${path}`);
  }
}

/**
 * The environment names workerd will accept from here.
 *
 * The union is deliberately the union of what the two declarations upstream can
 * produce: a Worker Version's `vars` keys and the sensitive names a runtime
 * input carries. A name outside it is refused rather than rewritten — a mangled
 * binding is a variable the module silently cannot find, which is worse than a
 * publication that stops and says so.
 */
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,127}$/u;
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u;
const INTERNAL_SERVICE_BINDING = /^__TAKOSERVER_SELFHOST_SERVICE_[0-9]{5}$/u;
const SERVICE_UNAVAILABLE_TOKEN = /^[0-9a-f]{64}$/u;

function validBindings(bindings: readonly WorkerdBinding[]): readonly WorkerdBinding[] {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (
      typeof binding?.name !== "string" ||
      !BINDING_NAME.test(binding.name) ||
      typeof binding.value !== "string" ||
      (binding.kind !== "text" && binding.kind !== "json")
    ) {
      throw new Error("unusable worker binding");
    }
    if (seen.has(binding.name)) throw new Error("unusable worker binding");
    seen.add(binding.name);
    // Renderability is part of validity. A value capnp Text cannot carry is
    // refused here, where every caller already fails closed, rather than in
    // `renderConfig`, which runs once for the whole machine and would take
    // every other script down with the broken one.
    capnpText(binding.name);
    capnpText(binding.value);
  }
  return bindings;
}

function validWorkerResourceUid(value: unknown): string {
  if (typeof value !== "string" || !RESOURCE_UID.test(value)) {
    throw new Error("unusable worker resource identity");
  }
  return value;
}

function validServiceBindings(
  bindings: readonly WorkerdServiceBinding[],
): readonly WorkerdServiceBinding[] {
  if (!Array.isArray(bindings) || bindings.length > 64) {
    throw new Error("unusable worker service binding");
  }
  const names = new Set<string>();
  return bindings.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !==
        "name,target,targetResourceUid,unavailableToken" ||
      typeof candidate.name !== "string" ||
      !INTERNAL_SERVICE_BINDING.test(candidate.name) ||
      names.has(candidate.name) ||
      typeof candidate.target !== "string" ||
      !SCRIPT_NAME.test(candidate.target) ||
      typeof candidate.targetResourceUid !== "string" ||
      !RESOURCE_UID.test(candidate.targetResourceUid) ||
      typeof candidate.unavailableToken !== "string" ||
      !SERVICE_UNAVAILABLE_TOKEN.test(candidate.unavailableToken)
    ) {
      throw new Error("unusable worker service binding");
    }
    names.add(candidate.name);
    capnpText(candidate.name);
    capnpText(candidate.target);
    capnpText(candidate.targetResourceUid);
    capnpText(candidate.unavailableToken);
    return {
      name: candidate.name,
      target: candidate.target,
      targetResourceUid: candidate.targetResourceUid,
      unavailableToken: candidate.unavailableToken,
    };
  });
}

/**
 * Module names this configuration may declare.
 *
 * A module name is a registry identity, not a filesystem path. Physical files
 * use private ordinal keys, so builtin-looking names and names equal to a Host
 * module remain valid. A duplicate within one provenance namespace is refused
 * rather than silently shadowing another declaration.
 */
function validModules(modules: readonly string[], mainModule?: string): readonly string[] {
  const seen = new Set(mainModule === undefined ? [] : [mainModule]);
  for (const name of modules) {
    if (typeof name !== "string" || name.length === 0 || name.length > 1_024 || seen.has(name)) {
      throw new Error("unusable worker module");
    }
    seen.add(name);
    capnpText(name);
  }
  return modules;
}

function validHostModuleNames(
  site: Pick<WorkerdSite, "hostModules" | "dataPlane" | "events">,
  hostEntrypoint: string | undefined,
): readonly string[] {
  return validModules([
    ...(hostEntrypoint === undefined ? [] : [hostEntrypoint]),
    ...(site.hostModules ?? []),
    ...(site.dataPlane === undefined ? [] : [validDataPlane(site.dataPlane).module]),
    ...(site.events === undefined ? [] : [validEventGate(site.events).module]),
  ]);
}

interface SnapshottedModule {
  readonly name: string;
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly digest: `sha256:${string}`;
}

async function snapshotModuleBytes(
  modules: ReadonlyMap<string, Uint8Array>,
  expectedNames: readonly string[],
  provenance: string,
): Promise<{
  readonly entries: readonly SnapshottedModule[];
  readonly manifest: readonly WorkerdStoredModule[];
}> {
  if (modules.size !== expectedNames.length) {
    throw new Error(`unusable ${provenance} worker module snapshot`);
  }
  const expected = new Set(expectedNames);
  for (const [name, bytes] of modules) {
    if (!expected.has(name) || !(bytes instanceof Uint8Array)) {
      throw new Error(`unusable ${provenance} worker module snapshot`);
    }
  }
  const entries: SnapshottedModule[] = [];
  for (const [index, name] of expectedNames.entries()) {
    const source = modules.get(name);
    if (!(source instanceof Uint8Array)) {
      throw new Error(`unusable ${provenance} worker module snapshot`);
    }
    const bytes = new Uint8Array(source);
    const key = `module-${index.toString(10).padStart(5, "0")}`;
    entries.push({
      name,
      key,
      bytes,
      size: bytes.byteLength,
      digest: await bytesDigest(bytes),
    });
  }
  return {
    entries,
    manifest: entries.map(({ name, key, size, digest }) => ({ name, key, size, digest })),
  };
}

const WORKERD_MODULE_MEDIA_TYPES: readonly WorkerdModuleMediaType[] = [
  "application/javascript+module",
  "text/plain",
  "application/octet-stream",
  "application/wasm",
];

function isWorkerdModuleMediaType(value: unknown): value is WorkerdModuleMediaType {
  return (WORKERD_MODULE_MEDIA_TYPES as readonly unknown[]).includes(value);
}

/**
 * Checks the media map against the exact module declaration set.
 *
 * The map is persisted in the site manifest, so this validation is also the
 * readback fence: a tampered or partially written map makes that one site
 * unavailable rather than making the whole machine render an invalid config.
 */
function validModuleMediaTypes(
  mainModule: string,
  modules: readonly string[],
  mediaTypes: unknown,
): Readonly<Record<string, WorkerdModuleMediaType>> | undefined {
  if (mediaTypes === undefined) return undefined;
  if (typeof mediaTypes !== "object" || mediaTypes === null || Array.isArray(mediaTypes)) {
    throw new Error("unusable worker module media types");
  }

  const declared = new Set([mainModule, ...modules]);
  const entries = Object.entries(mediaTypes);
  if (entries.length !== declared.size) {
    throw new Error("unusable worker module media types");
  }

  const normalized: Record<string, WorkerdModuleMediaType> = Object.create(null);
  for (const [name, mediaType] of entries) {
    if (!declared.has(name) || !isWorkerdModuleMediaType(mediaType)) {
      throw new Error("unusable worker module media types");
    }
    normalized[name] = mediaType;
  }
  for (const name of declared) {
    if (!Object.hasOwn(mediaTypes, name)) {
      throw new Error("unusable worker module media types");
    }
  }
  return normalized;
}

const SAFE_ASSET_PATH = /^[A-Za-z0-9_.][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$/u;
const ASSET_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const MAX_ASSET_MEDIA_TYPE_LENGTH = 255;
const MAX_ASSET_ENTRIES = 16_384;
const MAX_ASSET_BYTES = 10_485_760;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

function validAssetPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    SAFE_ASSET_PATH.test(value) &&
    value.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

function validAssetMediaType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ASSET_MEDIA_TYPE_LENGTH &&
    ASSET_MEDIA_TYPE.test(value)
  );
}

function assetStorageName(index: number): string {
  return `asset-${index.toString(10).padStart(5, "0")}`;
}

function validAssetMediaTypes(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("unusable worker asset declaration");
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > MAX_ASSET_ENTRIES) {
    throw new Error("unusable worker asset declaration");
  }
  const normalized: Record<string, string> = Object.create(null);
  for (const [path, mediaType] of entries) {
    if (!validAssetPath(path) || !validAssetMediaType(mediaType)) {
      throw new Error("unusable worker asset declaration");
    }
    normalized[path] = mediaType;
  }
  return normalized;
}

/**
 * Captures and validates the exact private asset publication before `write`
 * removes the currently serving directory.
 */
async function validAssets(
  configuration: WorkerdSite["assets"] | undefined,
  assets: ReadonlyMap<string, Uint8Array> | undefined,
): Promise<
  | {
      readonly configuration: WorkerdAssetManifest;
      readonly entries: readonly (readonly [string, Uint8Array])[];
    }
  | undefined
> {
  if (configuration === undefined && assets === undefined) return undefined;
  const normalized = validAssetDeclaration(configuration);
  if (normalized === undefined || assets === undefined || assets.size < 1) {
    throw new Error("unusable worker asset declaration");
  }
  const logicalEntries: Array<readonly [string, Uint8Array]> = [];
  for (const [name, source] of assets) {
    if (typeof name !== "string" || !validAssetPath(name) || !(source instanceof Uint8Array)) {
      throw new Error("unusable worker asset declaration");
    }
    logicalEntries.push([name, new Uint8Array(source)]);
  }
  logicalEntries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    Object.keys(normalized.mediaTypes).length !== logicalEntries.length ||
    logicalEntries.some(([name]) => !Object.hasOwn(normalized.mediaTypes, name))
  ) {
    throw new Error("unusable worker asset declaration");
  }
  if (
    normalized.notFoundHandling === "single-page-application" &&
    !logicalEntries.some(([name]) => name === "index.html")
  ) {
    throw new Error("single-page application assets require index.html");
  }
  const files: Record<string, WorkerdAssetManifestEntry> = Object.create(null);
  let total = 0;
  const entries: Array<readonly [string, Uint8Array]> = [];
  for (const [index, [name, bytes]] of logicalEntries.entries()) {
    const key = assetStorageName(index);
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_ASSET_BYTES) {
      throw new Error("unusable worker asset declaration");
    }
    files[name] = {
      key,
      mediaType: normalized.mediaTypes[name] as string,
      size: bytes.byteLength,
      digest: await bytesDigest(bytes),
    };
    entries.push([key, bytes]);
  }
  return {
    configuration: {
      storageLayout: WORKERD_ASSET_STORAGE_LAYOUT,
      notFoundHandling: normalized.notFoundHandling,
      runWorkerFirst: normalized.runWorkerFirst,
      files,
    },
    entries,
  };
}

function validAssetDeclaration(value: unknown): WorkerdSite["assets"] | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "mediaTypes,notFoundHandling,runWorkerFirst"
  ) {
    throw new Error("unusable worker asset declaration");
  }
  const candidate = value as Record<string, unknown>;
  const notFoundHandling = candidate.notFoundHandling;
  const runWorkerFirst = candidate.runWorkerFirst;
  const mediaTypes = candidate.mediaTypes;
  if (
    (notFoundHandling !== "none" && notFoundHandling !== "single-page-application") ||
    typeof runWorkerFirst !== "boolean"
  ) {
    throw new Error("unusable worker asset declaration");
  }
  return {
    notFoundHandling,
    runWorkerFirst,
    mediaTypes: validAssetMediaTypes(mediaTypes),
  };
}

function validAssetManifest(value: unknown): WorkerdAssetManifest | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "files,notFoundHandling,runWorkerFirst,storageLayout"
  ) {
    throw new Error("unusable worker asset manifest");
  }
  const candidate = value as Record<string, unknown>;
  const storageLayout = candidate.storageLayout;
  const notFoundHandling = candidate.notFoundHandling;
  const runWorkerFirst = candidate.runWorkerFirst;
  const sourceFiles = candidate.files;
  if (
    storageLayout !== WORKERD_ASSET_STORAGE_LAYOUT ||
    (notFoundHandling !== "none" && notFoundHandling !== "single-page-application") ||
    typeof runWorkerFirst !== "boolean" ||
    typeof sourceFiles !== "object" ||
    sourceFiles === null ||
    Array.isArray(sourceFiles)
  ) {
    throw new Error("unusable worker asset manifest");
  }
  const filesRecord = sourceFiles as Record<string, unknown>;
  const logicalPaths = Object.keys(filesRecord).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (logicalPaths.length < 1 || logicalPaths.length > MAX_ASSET_ENTRIES) {
    throw new Error("unusable worker asset manifest");
  }
  const files: Record<string, WorkerdAssetManifestEntry> = Object.create(null);
  let total = 0;
  for (const [index, path] of logicalPaths.entries()) {
    const entry = filesRecord[path];
    if (
      !validAssetPath(path) ||
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "digest,key,mediaType,size"
    ) {
      throw new Error("unusable worker asset manifest");
    }
    const record = entry as Record<string, unknown>;
    if (
      record.key !== assetStorageName(index) ||
      !validAssetMediaType(record.mediaType) ||
      !Number.isSafeInteger(record.size) ||
      (record.size as number) < 0 ||
      (record.size as number) > MAX_ASSET_BYTES ||
      typeof record.digest !== "string" ||
      !SHA256_DIGEST.test(record.digest)
    ) {
      throw new Error("unusable worker asset manifest");
    }
    total += record.size as number;
    if (!Number.isSafeInteger(total) || total > MAX_ASSET_BYTES) {
      throw new Error("unusable worker asset manifest");
    }
    files[path] = {
      key: record.key,
      mediaType: record.mediaType,
      size: record.size as number,
      digest: record.digest as `sha256:${string}`,
    };
  }
  if (notFoundHandling === "single-page-application" && !Object.hasOwn(files, "index.html")) {
    throw new Error("single-page application assets require index.html");
  }
  return {
    storageLayout,
    notFoundHandling,
    runWorkerFirst,
    files,
  };
}

type WorkerdModuleKind = "esModule" | "text" | "data" | "wasm";

function workerdModuleKind(mediaType: WorkerdModuleMediaType): WorkerdModuleKind {
  switch (mediaType) {
    case "application/javascript+module":
      return "esModule";
    case "text/plain":
      return "text";
    case "application/octet-stream":
      return "data";
    case "application/wasm":
      return "wasm";
  }
}

/**
 * The one address a data-plane service may point at.
 *
 * Loopback only, and deliberately: the address is written into a generated
 * `externalServer`, every request the facade service makes on that binding goes
 * to it whatever URL was written, and each of those requests carries the
 * version's plane token. An address off this machine would be somewhere that
 * token could be sent.
 *
 * Two literal addresses, not a name. `localhost` is a resolver answer rather
 * than an address: it may be `::1` where the listener is on `127.0.0.1`, it may
 * be several addresses, and on a machine whose `hosts` file somebody edited it
 * may be neither. A port is a port — `0` is not one, and neither is `99999`.
 */
function validDataPlaneAddress(address: string): string {
  const separator = address.lastIndexOf(":");
  const host = separator < 0 ? "" : address.slice(0, separator);
  const port = separator < 0 ? "" : address.slice(separator + 1);
  const number = /^[1-9][0-9]{0,4}$/u.test(port) ? Number(port) : 0;
  if ((host !== "127.0.0.1" && host !== "[::1]") || number < 1 || number > 65_535) {
    throw new Error("unusable data plane address");
  }
  return address;
}

/** The facade service one script publishes beside itself, checked whole. */
function validDataPlane(plane: WorkerdDataPlane): WorkerdDataPlane {
  if (typeof plane !== "object" || plane === null) throw new Error("unusable data plane");
  validDataPlaneAddress(plane.address);
  validModules([plane.module]);
  validBindings(plane.vars ?? []);
  return plane;
}

/** The event gate one script publishes beside itself, checked whole. */
function validEventGate(gate: WorkerdEventGate): WorkerdEventGate {
  if (typeof gate !== "object" || gate === null) throw new Error("unusable event gate");
  validModules([gate.module]);
  validBindings(gate.vars ?? []);
  return gate;
}

interface PreparedWorkerdSite {
  readonly manifest: Manifest;
  readonly application: readonly SnapshottedModule[];
  readonly hostPrivate: readonly SnapshottedModule[];
  readonly assets?: readonly (readonly [string, Uint8Array])[];
}

/** Captures every byte and validates every binding before durable state moves. */
async function prepareWorkerdSite(
  site: WorkerdSite,
  modules: ReadonlyMap<string, Uint8Array>,
  assets: ReadonlyMap<string, Uint8Array> | undefined,
  hostModules: ReadonlyMap<string, Uint8Array> | undefined,
): Promise<PreparedWorkerdSite> {
  const mainModule = validModules([site.mainModule])[0] as string;
  const declaredModules = validModules(site.modules ?? [], site.mainModule);
  const moduleMediaTypes = validModuleMediaTypes(
    mainModule,
    declaredModules,
    site.moduleMediaTypes,
  );
  const hostEntrypoint =
    site.hostEntrypoint === undefined
      ? undefined
      : (validModules([site.hostEntrypoint])[0] as string);
  const declaredHostModules = validHostModuleNames(site, hostEntrypoint);
  const applicationSnapshot = await snapshotModuleBytes(
    modules,
    [mainModule, ...declaredModules],
    "application",
  );
  const hostSnapshot = await snapshotModuleBytes(
    hostModules ?? new Map(),
    declaredHostModules,
    "Host-private",
  );
  const assetDeclaration = await validAssets(site.assets, assets);
  const workerResourceUid =
    site.workerResourceUid === undefined
      ? undefined
      : validWorkerResourceUid(site.workerResourceUid);
  if (
    (workerResourceUid === undefined) !== (site.fetchHandler === undefined) ||
    (site.fetchHandler !== undefined && typeof site.fetchHandler !== "boolean")
  ) {
    throw new Error("unusable worker service identity");
  }
  const serviceBindings = validServiceBindings(site.serviceBindings ?? []);
  if (serviceBindings.length > 0 && workerResourceUid === undefined) {
    throw new Error("unusable worker service binding");
  }
  return {
    manifest: {
      mainModule: site.mainModule,
      ...(hostEntrypoint === undefined ? {} : { hostEntrypoint }),
      ...(site.hostModules && site.hostModules.length > 0
        ? { hostModules: [...site.hostModules] }
        : {}),
      moduleStorageLayout: WORKERD_MODULE_STORAGE_LAYOUT,
      moduleFiles: {
        application: applicationSnapshot.manifest,
        hostPrivate: hostSnapshot.manifest,
      },
      hostnames: validDeploymentHostnames(site.hostnames),
      ...(site.generation === undefined ? {} : { generation: site.generation }),
      ...(workerResourceUid === undefined ? {} : { workerResourceUid }),
      ...(site.fetchHandler === undefined ? {} : { fetchHandler: site.fetchHandler }),
      ...(serviceBindings.length > 0 ? { serviceBindings } : {}),
      ...(assetDeclaration ? { assets: assetDeclaration.configuration } : {}),
      ...(site.vars && site.vars.length > 0 ? { vars: validBindings(site.vars) } : {}),
      ...(site.modules && site.modules.length > 0 ? { modules: declaredModules } : {}),
      ...(moduleMediaTypes ? { moduleMediaTypes } : {}),
      ...(site.dataPlane ? { dataPlane: validDataPlane(site.dataPlane) } : {}),
      ...(site.events ? { events: validEventGate(site.events) } : {}),
    },
    application: applicationSnapshot.entries,
    hostPrivate: hostSnapshot.entries,
    ...(assetDeclaration ? { assets: assetDeclaration.entries } : {}),
  };
}

async function writePreparedWorkerdSite(
  root: string,
  prepared: PreparedWorkerdSite,
): Promise<void> {
  await privateDirectory(root);
  await privateDirectory(join(root, APPLICATION_MODULE_DIRECTORY));
  if (prepared.hostPrivate.length > 0) {
    await privateDirectory(join(root, HOST_PRIVATE_MODULE_DIRECTORY));
  }
  if (prepared.assets) await privateDirectory(join(root, ASSETS_ROOT_DIRECTORY));
  for (const entry of prepared.application) {
    await writeFile(join(root, APPLICATION_MODULE_DIRECTORY, entry.key), entry.bytes, {
      mode: 0o600,
    });
  }
  for (const entry of prepared.hostPrivate) {
    await writeFile(join(root, HOST_PRIVATE_MODULE_DIRECTORY, entry.key), entry.bytes, {
      mode: 0o600,
    });
  }
  for (const [assetName, bytes] of prepared.assets ?? []) {
    await writeFile(join(root, ASSETS_ROOT_DIRECTORY, assetName), bytes);
  }
}

/**
 * Private, single-execution materialization. The caller owns a fresh directory
 * and cleanup; this never publishes a route or changes the active graph.
 * Assets/event routers are HTTP delivery services, not class environment
 * bindings. Service bindings require an exact private per-binding gateway
 * mapping acquired from the shared runtime; no target URL is derived here.
 */
export async function writeWorkerdPrivateExecution(options: {
  readonly root: string;
  readonly site: WorkerdSite;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly hostModules: ReadonlyMap<string, Uint8Array>;
  readonly companionAddress: string;
  readonly runSocketPath: string;
  /** Current Host-owned listener, never the persisted prior-process address. */
  readonly dataPlaneAddress?: string;
  /** Exact child-local guard listeners, not shared sockets or public endpoints. */
  readonly serviceBindings?: readonly { readonly name: string; readonly socketPath: string }[];
  /**
   * Dynamic Workflow loader graph. When present, only these trusted outer
   * modules are installed statically; selected tenant modules stay inert data
   * embedded in the outer entry and are supplied to WorkerLoader on RUN.
   */
  readonly workflowLoader?: {
    readonly outerEntrypoint: string;
    readonly outerHelper: string;
    readonly outerModules: ReadonlyMap<string, Uint8Array>;
    readonly outerModuleMediaTypes: Readonly<Record<string, WorkerdModuleMediaType>>;
    readonly staticHostModules: ReadonlyMap<string, Uint8Array>;
  };
}): Promise<string> {
  const { root, site, runSocketPath } = options;
  if (
    !isAbsolute(root) ||
    !isAbsolute(runSocketPath) ||
    runSocketPath.includes("\u0000") ||
    Buffer.byteLength(runSocketPath) > 100 ||
    dirname(runSocketPath) !== root
  ) {
    throw new Error("unusable private execution directory or socket");
  }
  if (
    !options.workflowLoader &&
    (!site.hostEntrypoint || site.hostEntrypoint === site.mainModule)
  ) {
    throw new Error("private execution requires a distinct Host entrypoint");
  }
  const declaredServices = validServiceBindings(site.serviceBindings ?? []);
  const serviceMappings = options.serviceBindings ?? [];
  const serviceNames = new Set(declaredServices.map((binding) => binding.name));
  const servicePaths = new Set<string>();
  if (!Array.isArray(serviceMappings) || serviceMappings.length !== declaredServices.length) {
    throw new Error("private execution service binding bridge is unavailable");
  }
  for (const mapping of serviceMappings) {
    if (
      !mapping ||
      !serviceNames.delete(mapping.name) ||
      typeof mapping.socketPath !== "string" ||
      !isAbsolute(mapping.socketPath) ||
      resolve(mapping.socketPath) !== mapping.socketPath ||
      mapping.socketPath.includes("\u0000") ||
      Buffer.byteLength(mapping.socketPath) > 100 ||
      dirname(mapping.socketPath) !== root ||
      mapping.socketPath === runSocketPath ||
      servicePaths.has(mapping.socketPath)
    ) {
      throw new Error("unusable private execution service binding bridge");
    }
    servicePaths.add(mapping.socketPath);
  }
  const companion = validDataPlaneAddress(options.companionAddress);
  const planeAddress = site.dataPlane
    ? validDataPlaneAddress(options.dataPlaneAddress ?? "")
    : undefined;
  // Deliberately select declarations: never carry hostname, assets or event
  // ingress into a guarded class process. Their Host-private module bytes can
  // remain in the exact closed graph without installing their routing services.
  const { assets: _assets, events: _events, ...classSite } = site;
  const { hostEntrypoint: _workflowHostEntrypoint, ...workflowClassSite } = classSite;
  if (options.workflowLoader) {
    const graph = options.workflowLoader;
    for (const [name, mediaType] of Object.entries(graph.outerModuleMediaTypes)) {
      const executable = name === graph.outerEntrypoint || name === graph.outerHelper;
      if (
        executable
          ? mediaType !== "application/javascript+module"
          : mediaType !== "text/plain" && mediaType !== "application/octet-stream"
      ) {
        throw new Error("workflow source carriers must be inert text or data");
      }
    }
  }
  const prepared = options.workflowLoader
    ? await prepareWorkerdSite(
        {
          ...workflowClassSite,
          mainModule: options.workflowLoader.outerEntrypoint,
          hostModules: [...options.workflowLoader.staticHostModules.keys()].filter(
            (name) => name !== classSite.dataPlane?.module,
          ),
          modules: [...options.workflowLoader.outerModules.keys()].filter(
            (name) => name !== options.workflowLoader?.outerEntrypoint,
          ),
          moduleMediaTypes: options.workflowLoader.outerModuleMediaTypes,
          hostnames: [],
        },
        options.workflowLoader.outerModules,
        undefined,
        options.workflowLoader.staticHostModules,
      )
    : await prepareWorkerdSite(
        { ...classSite, hostnames: [] },
        options.modules,
        undefined,
        options.hostModules,
      );
  const bindings = validBindings(prepared.manifest.vars ?? []).map(
    (binding) =>
      `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
  );
  const companionBinding = "__TAKOSERVER_WORKFLOW_COMPANION";
  const loaderBinding = "__TAKOSERVER_WORKFLOW_LOADER";
  if (
    prepared.manifest.vars?.some(
      (binding) =>
        binding.name === companionBinding ||
        (options.workflowLoader && binding.name === loaderBinding) ||
        declaredServices.some((service) => service.name === binding.name) ||
        (prepared.manifest.dataPlane && binding.name === DATA_SERVICE_BINDING),
    )
  ) {
    throw new Error("private execution internal binding collision");
  }
  bindings.push(`(name = ${capnpText(companionBinding)}, service = "companion")`);
  if (options.workflowLoader) {
    bindings.push(`(name = ${capnpText(loaderBinding)}, workerLoader = ())`);
  }
  const serviceExternals = serviceMappings
    .map((mapping, index) => {
      const name = `service-${index}`;
      bindings.push(`(name = ${capnpText(mapping.name)}, service = ${capnpText(name)})`);
      return `\n  (name = ${capnpText(name)}, external = (address = ${capnpText(`unix:${mapping.socketPath}`)}, http = (style = proxy))),`;
    })
    .join("");
  let dataServices = "";
  if (prepared.manifest.dataPlane) {
    const plane = prepared.manifest.dataPlane;
    const module = requiredStoredModule(prepared.manifest.moduleFiles.hostPrivate, plane.module);
    bindings.push(`(name = "${DATA_SERVICE_BINDING}", service = "data")`);
    const facadeBindings = [
      `(name = "${DATA_PLANE_BINDING}", service = "data-origin")`,
      ...validBindings(plane.vars).map(
        (binding) =>
          `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
      ),
    ];
    dataServices = `
  (name = "data", worker = (
    modules = [(name = ${capnpText(plane.module)}, esModule = embed ${capnpText(`${HOST_PRIVATE_MODULE_DIRECTORY}/${module.key}`)})],
    bindings = [${facadeBindings.join(", ")}], compatibilityDate = "2026-01-01", globalOutbound = "deny"
  )),
  (name = "data-origin", external = (address = ${capnpText(planeAddress as string)}, http = ())),`;
  }
  // The static outer is a trusted supervisor, not a tenant execution graph.
  // Closed modulePolicy forbids builtins even to Host-private code, whereas
  // its generated WorkerEntrypoint needs cloudflare:workers. Tenant bytes here
  // are checked inert carriers; WorkerLoader installs the closed policy in the
  // separate tenant child on RUN. Ordinary private executions keep their policy.
  const modulePolicy = options.workflowLoader
    ? ""
    : `\n    modulePolicy = (applicationMain = ${capnpText(prepared.manifest.mainModule)}),`;
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "application", worker = (
    modules = [${renderWorkerdModules(prepared.manifest, ".", options.workflowLoader !== undefined)}],
    bindings = [${bindings.join(", ")}],${modulePolicy}
    compatibilityDate = "2026-01-01",
    compatibilityFlags = [${APPLICATION_COMPATIBILITY_FLAGS.map(capnpText).join(", ")}],
    globalOutbound = "deny"
  )),
  (name = "companion", external = (address = ${capnpText(companion)}, http = ())),${dataServices}${serviceExternals}
  (name = "deny", network = (allow = []))
 ],
 sockets = [(name = "workflow", address = ${capnpText(`unix:${runSocketPath}`)}, http = (), service = "application")]
);`;
  await writePreparedWorkerdSite(root, prepared);
  const configPath = join(root, "workerd.capnp");
  await writeFile(configPath, config, { mode: 0o600, flag: "wx" });
  return configPath;
}

/**
 * The hostname the router answers this Host's own questions about a script on.
 *
 * Derived from the script name rather than stored, so it cannot drift from the
 * service it names and no manifest can claim somebody else's.
 */
export function internalHostname(script: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(script)) {
    throw new Error(`unusable script name: ${script}`);
  }
  return `${script}${INTERNAL_ROUTE_SUFFIX}`;
}

/** The hostname a queue batch or a cron match is delivered on. */
export function eventHostname(script: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(script)) {
    throw new Error(`unusable script name: ${script}`);
  }
  return `${script}${EVENT_ROUTE_SUFFIX}`;
}

/**
 * A capnp text literal.
 *
 * This configuration is assembled by concatenating strings, and the values in
 * it are a tenant's. An unescaped quote would close the literal and let the
 * rest of a value be read as configuration — the next binding, the next
 * service, or the socket. Everything printable stays as itself so the file
 * remains readable by an operator; the rest is escaped, and the two characters
 * capnp Text cannot carry at all are refused.
 */
function capnpText(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) throw new Error("unusable worker binding value");
    if (code >= 0xd800 && code <= 0xdfff) throw new Error("unusable worker binding value");
    switch (character) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "\v":
        out += "\\v";
        continue;
      default:
        break;
    }
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    out += character;
  }
  return `${out}"`;
}

async function readActivation(path: string): Promise<Record<string, string | null>> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record: Record<string, string | null> = {};
    for (const [name, generation] of Object.entries(parsed)) {
      if (generation !== null && typeof generation !== "string") return {};
      record[name] = generation;
    }
    return record;
  } catch {
    return {};
  }
}

async function writeActivation(path: string, active: Record<string, string | null>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(active), "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

interface PublishedVariant {
  /** Runtime-private service name; equal to the script only for legacy sites. */
  readonly name: string;
  readonly logicalName: string;
  /** Path relative to the generated config for module embeds. */
  readonly storagePrefix: string;
  /** Absolute immutable asset directory used by workerd's disk service. */
  readonly assetRoot: string;
  readonly manifest: Manifest;
  readonly versionId?: string;
  readonly workerVersionUid?: string;
  readonly weight?: number;
}

interface PublishedDeployment {
  readonly name: string;
  readonly generation?: string;
  readonly workerResourceUid?: string;
  readonly hostnames: readonly string[];
  readonly weighted: boolean;
  readonly variants: readonly PublishedVariant[];
}

/**
 * Optional byte collectors used by the active-version reader.
 *
 * The collectors are fed by the same reads that verify each durable digest;
 * there is intentionally no verify-then-reread path for snapshot material.
 */
interface ReadbackCapture {
  readonly application?: Map<string, Uint8Array>;
  readonly hostPrivate?: Map<string, Uint8Array>;
  readonly assets?: Map<string, Uint8Array>;
}

/**
 * Whether this publication runs through a generated entrypoint.
 *
 * The entrypoint identity is explicit. A retained manifest from the former
 * flat registry has no provenance layout and is rejected by readback rather
 * than silently serving with an open graph.
 */
function hasHostEntrypoint(entry: PublishedVariant): boolean {
  return entry.manifest.hostEntrypoint !== undefined;
}

/** Exact private asset readback used before restart or configuration reload. */
async function readPublishedAssetSnapshot(
  root: string,
  value: unknown,
  capture?: Map<string, Uint8Array>,
): Promise<WorkerdAssetManifest | undefined> {
  const manifest = validAssetManifest(value);
  if (!manifest) return undefined;
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("unusable worker asset snapshot");
  }
  const entries = await readdir(root, { withFileTypes: true });
  const expected = new Set(Object.values(manifest.files).map((entry) => entry.key));
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))
  ) {
    throw new Error("unusable worker asset snapshot");
  }
  for (const [logicalPath, entry] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(root, entry.key));
    if (bytes.byteLength !== entry.size || (await bytesDigest(bytes)) !== entry.digest) {
      throw new Error("unusable worker asset snapshot");
    }
    // Capture the logical path, never the operator-private flat key. The
    // caller owns a copy, and this is the same read that just passed the
    // size/digest fence above.
    capture?.set(logicalPath, new Uint8Array(bytes));
  }
  return manifest;
}

function validStoredModuleInventory(
  value: unknown,
  expectedNames: readonly string[],
): readonly WorkerdStoredModule[] {
  if (!Array.isArray(value) || value.length !== expectedNames.length) {
    throw new Error("unusable worker module storage manifest");
  }
  let total = 0;
  return value.map((candidate, index) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "digest,key,name,size"
    ) {
      throw new Error("unusable worker module storage manifest");
    }
    const record = candidate as Record<string, unknown>;
    const expectedKey = `module-${index.toString(10).padStart(5, "0")}`;
    if (
      record.name !== expectedNames[index] ||
      record.key !== expectedKey ||
      !Number.isSafeInteger(record.size) ||
      (record.size as number) < 0 ||
      typeof record.digest !== "string" ||
      !SHA256_DIGEST.test(record.digest)
    ) {
      throw new Error("unusable worker module storage manifest");
    }
    total += record.size as number;
    if (!Number.isSafeInteger(total) || total > 268_435_456) {
      throw new Error("unusable worker module storage manifest");
    }
    return {
      name: record.name as string,
      key: record.key,
      size: record.size as number,
      digest: record.digest as `sha256:${string}`,
    };
  });
}

async function verifyStoredModuleDirectory(
  root: string,
  inventory: readonly WorkerdStoredModule[],
  capture?: Map<string, Uint8Array>,
): Promise<void> {
  const rootStat = await lstat(root).catch(() => null);
  if (inventory.length === 0) {
    if (rootStat === null) return;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("unusable worker module storage snapshot");
    }
  } else if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("unusable worker module storage snapshot");
  }
  const entries = await readdir(root, { withFileTypes: true });
  const expected = new Set(inventory.map((entry) => entry.key));
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))
  ) {
    throw new Error("unusable worker module storage snapshot");
  }
  for (const entry of inventory) {
    const bytes = await readFile(join(root, entry.key));
    if (bytes.byteLength !== entry.size || (await bytesDigest(bytes)) !== entry.digest) {
      throw new Error("unusable worker module storage snapshot");
    }
    // The digest fence and the returned bytes come from one read. Keys exposed
    // to callers are logical module names, never private ordinal filenames.
    capture?.set(entry.name, new Uint8Array(bytes));
  }
}

async function readPublishedModuleSnapshot(
  root: string,
  manifest: Manifest,
  capture?: Pick<ReadbackCapture, "application" | "hostPrivate">,
): Promise<WorkerdModuleStorageManifest> {
  if (
    manifest.moduleStorageLayout !== WORKERD_MODULE_STORAGE_LAYOUT ||
    typeof manifest.moduleFiles !== "object" ||
    manifest.moduleFiles === null ||
    Array.isArray(manifest.moduleFiles) ||
    Object.keys(manifest.moduleFiles).sort().join(",") !== "application,hostPrivate"
  ) {
    throw new Error("unusable worker module storage manifest");
  }
  const applicationNames = [manifest.mainModule, ...(manifest.modules ?? [])];
  const hostNames = validHostModuleNames(manifest, manifest.hostEntrypoint);
  const application = validStoredModuleInventory(
    (manifest.moduleFiles as unknown as Record<string, unknown>).application,
    applicationNames,
  );
  const hostPrivate = validStoredModuleInventory(
    (manifest.moduleFiles as unknown as Record<string, unknown>).hostPrivate,
    hostNames,
  );
  await verifyStoredModuleDirectory(
    join(root, APPLICATION_MODULE_DIRECTORY),
    application,
    capture?.application,
  );
  await verifyStoredModuleDirectory(
    join(root, HOST_PRIVATE_MODULE_DIRECTORY),
    hostPrivate,
    capture?.hostPrivate,
  );
  return { application, hostPrivate };
}

async function readValidatedManifest(
  moduleRoot: string,
  assetRoot: string,
  value: unknown,
  capture?: ReadbackCapture,
): Promise<Manifest> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("unusable worker runtime manifest");
  }
  let manifest = value as Manifest;
  if (
    typeof manifest.mainModule !== "string" ||
    (manifest.generation !== undefined && typeof manifest.generation !== "string")
  ) {
    throw new Error("unusable worker runtime manifest");
  }
  validModules([manifest.mainModule]);
  const declaredModules = validModules(manifest.modules ?? [], manifest.mainModule);
  validModuleMediaTypes(manifest.mainModule, declaredModules, manifest.moduleMediaTypes);
  const moduleFiles = await readPublishedModuleSnapshot(moduleRoot, manifest, capture);
  manifest = { ...manifest, moduleFiles };
  const assets = await readPublishedAssetSnapshot(assetRoot, manifest.assets, capture?.assets);
  if (assets) manifest = { ...manifest, assets };
  validBindings(manifest.vars ?? []);
  if (manifest.workerResourceUid !== undefined) {
    validWorkerResourceUid(manifest.workerResourceUid);
  }
  if (
    (manifest.workerResourceUid === undefined) !== (manifest.fetchHandler === undefined) ||
    (manifest.fetchHandler !== undefined && typeof manifest.fetchHandler !== "boolean")
  ) {
    throw new Error("unusable worker service identity");
  }
  const serviceBindings = validServiceBindings(manifest.serviceBindings ?? []);
  if (serviceBindings.length > 0 && manifest.workerResourceUid === undefined) {
    throw new Error("unusable worker service binding");
  }
  if (manifest.dataPlane !== undefined) validDataPlane(manifest.dataPlane);
  if (manifest.events !== undefined) validEventGate(manifest.events);
  return manifest;
}

function validDeploymentHostnames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("unusable worker deployment hostnames");
  }
  const hostnames = value as readonly string[];
  if (new Set(hostnames).size !== hostnames.length) {
    throw new Error("unusable worker deployment hostnames");
  }
  for (const hostname of hostnames) capnpText(hostname);
  return [...hostnames];
}

function privateVariantServiceName(
  script: string,
  generationKey: string,
  workerVersionUid: string,
): string {
  const digest = createHash("sha256")
    .update("takoserver.selfhost-private-version@v1\u0000", "utf8")
    .update(script, "utf8")
    .update("\u0000", "utf8")
    .update(generationKey, "utf8")
    .update("\u0000", "utf8")
    .update(workerVersionUid, "utf8")
    .digest("hex");
  return `selfhost-version-${digest}`;
}

interface WeightedDeploymentSnapshot {
  readonly pointer: WorkerdDeploymentPointer;
  readonly deployment: WorkerdDeploymentManifest;
  readonly generationRoot: string;
  readonly hostnames: readonly string[];
  readonly canonical: readonly SelfhostWeightedVersion[];
}

async function readWeightedDeploymentSnapshot(
  scriptsRoot: string,
  script: string,
  pointerValue: unknown,
): Promise<WeightedDeploymentSnapshot> {
  if (
    typeof pointerValue !== "object" ||
    pointerValue === null ||
    Array.isArray(pointerValue) ||
    Object.keys(pointerValue).sort().join(",") !==
      "generation,generationKey,publicationStorageLayout"
  ) {
    throw new Error("unusable worker deployment pointer");
  }
  const pointer = pointerValue as WorkerdDeploymentPointer;
  if (
    pointer.publicationStorageLayout !== WORKERD_DEPLOYMENT_STORAGE_LAYOUT ||
    typeof pointer.generation !== "string" ||
    typeof pointer.generationKey !== "string" ||
    !/^[0-9a-f]{64}$/u.test(pointer.generationKey)
  ) {
    throw new Error("unusable worker deployment pointer");
  }
  const generationRoot = join(
    scriptsRoot,
    DEPLOYMENT_PUBLICATIONS_DIRECTORY,
    script,
    pointer.generationKey,
  );
  const raw = await readFile(join(generationRoot, DEPLOYMENT_MANIFEST), "utf8");
  if (createHash("sha256").update(raw, "utf8").digest("hex") !== pointer.generationKey) {
    throw new Error("unusable worker deployment snapshot");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("unusable worker deployment manifest");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "generation,hostnames,publicationStorageLayout,versions,workerResourceUid"
  ) {
    throw new Error("unusable worker deployment manifest");
  }
  const deployment = parsed as WorkerdDeploymentManifest;
  if (
    deployment.publicationStorageLayout !== WORKERD_DEPLOYMENT_STORAGE_LAYOUT ||
    deployment.generation !== pointer.generation ||
    typeof deployment.workerResourceUid !== "string" ||
    !Array.isArray(deployment.versions)
  ) {
    throw new Error("unusable worker deployment manifest");
  }
  validWorkerResourceUid(deployment.workerResourceUid);
  const hostnames = validDeploymentHostnames(deployment.hostnames);
  for (let index = 0; index < deployment.versions.length; index += 1) {
    const stored = deployment.versions[index];
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      Object.keys(stored).sort().join(",") !==
        "manifest,storageKey,versionId,weight,workerVersionUid" ||
      stored.storageKey !== `version-${index.toString(10).padStart(5, "0")}`
    ) {
      throw new Error("unusable worker deployment manifest");
    }
  }
  const canonical = canonicalSelfhostWeightedVersions(
    deployment.versions.map((version) => ({
      versionId: version.versionId,
      workerVersionUid: version.workerVersionUid,
      weight: version.weight,
    })),
  );
  for (let index = 0; index < deployment.versions.length; index += 1) {
    const stored = deployment.versions[index] as WorkerdDeploymentStoredVersion;
    const identity = canonical[index];
    if (
      !identity ||
      stored.versionId !== identity.versionId ||
      stored.workerVersionUid !== identity.workerVersionUid ||
      stored.weight !== identity.weight
    ) {
      throw new Error("unusable worker deployment manifest");
    }
  }
  return { pointer, deployment, generationRoot, hostnames, canonical };
}

async function readWeightedDeployment(
  scriptsRoot: string,
  script: string,
  pointerValue: unknown,
): Promise<PublishedDeployment> {
  const { pointer, deployment, generationRoot, hostnames, canonical } =
    await readWeightedDeploymentSnapshot(scriptsRoot, script, pointerValue);
  const variants: PublishedVariant[] = [];
  for (let index = 0; index < deployment.versions.length; index += 1) {
    const stored = deployment.versions[index] as WorkerdDeploymentStoredVersion;
    const identity = canonical[index];
    if (
      !identity ||
      stored.versionId !== identity.versionId ||
      stored.workerVersionUid !== identity.workerVersionUid ||
      stored.weight !== identity.weight
    ) {
      throw new Error("unusable worker deployment manifest");
    }
    const moduleRoot = join(generationRoot, stored.storageKey);
    const manifest = await readValidatedManifest(
      moduleRoot,
      join(moduleRoot, ASSETS_ROOT_DIRECTORY),
      stored.manifest,
    );
    if (
      manifest.generation !== deployment.generation ||
      manifest.workerResourceUid !== deployment.workerResourceUid ||
      manifest.hostnames.length !== 0
    ) {
      throw new Error("unusable worker deployment Version");
    }
    variants.push({
      name: privateVariantServiceName(script, pointer.generationKey, stored.workerVersionUid),
      logicalName: script,
      storagePrefix: `${DEPLOYMENT_PUBLICATIONS_DIRECTORY}/${script}/${pointer.generationKey}/${stored.storageKey}`,
      assetRoot: join(moduleRoot, ASSETS_ROOT_DIRECTORY),
      manifest,
      versionId: stored.versionId,
      workerVersionUid: stored.workerVersionUid,
      weight: stored.weight,
    });
  }
  return {
    name: script,
    generation: deployment.generation,
    workerResourceUid: deployment.workerResourceUid,
    hostnames,
    weighted: true,
    variants,
  };
}

async function readActivationStrict(path: string): Promise<Record<string, string | null>> {
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("unusable worker activation marker");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("unusable worker activation marker");
  }
  const active: Record<string, string | null> = {};
  for (const [name, generation] of Object.entries(parsed)) {
    if (!SCRIPT_NAME.test(name) || (generation !== null && typeof generation !== "string")) {
      throw new Error("unusable worker activation marker");
    }
    active[name] = generation;
  }
  return active;
}

/**
 * Reads the immutable weighted identity that both the stable pointer and the
 * last proven activation marker name. This is the event selector's serving
 * authority: provider desired state may legitimately be one reconcile ahead
 * after a failed activation, but it must never select an unserved Version.
 */
export async function readWorkerdActiveDeployment(
  root: string,
  script: string,
): Promise<WorkerdActiveDeployment | null> {
  if (!SCRIPT_NAME.test(script)) throw new Error("unusable script name");
  const scriptsRoot = join(root, "workers");
  const activationPath = join(scriptsRoot, ".takoserver-active.json");
  const before = await readActivationStrict(activationPath);
  const activeGeneration = before[script];
  if (typeof activeGeneration !== "string") return null;
  const pointerRaw = await readFile(join(scriptsRoot, script, MANIFEST), "utf8").catch(
    (error: unknown) => {
      if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
      throw error;
    },
  );
  if (pointerRaw === null) return null;
  let pointer: unknown;
  try {
    pointer = JSON.parse(pointerRaw);
  } catch {
    throw new Error("unusable worker deployment pointer");
  }
  const snapshot = await readWeightedDeploymentSnapshot(scriptsRoot, script, pointer);
  const eventShapes = new Set<boolean>();
  for (const stored of snapshot.deployment.versions) {
    const manifest: unknown = stored.manifest;
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error("unusable worker deployment Version");
    }
    const identity = manifest as Partial<Manifest>;
    if (
      identity.generation !== snapshot.deployment.generation ||
      identity.workerResourceUid !== snapshot.deployment.workerResourceUid ||
      !Array.isArray(identity.hostnames) ||
      identity.hostnames.length !== 0
    ) {
      throw new Error("unusable worker deployment Version");
    }
    if (identity.events !== undefined) validEventGate(identity.events);
    eventShapes.add(identity.events !== undefined);
  }
  if (eventShapes.size !== 1) throw new Error("unusable worker deployment event graph");
  const after = await readActivationStrict(activationPath);
  if (after[script] !== activeGeneration || snapshot.deployment.generation !== activeGeneration) {
    return null;
  }
  return {
    generation: activeGeneration,
    versions: snapshot.canonical,
    events: eventShapes.has(true),
  };
}

/**
 * Reads one caller-owned Version snapshot from the active private publication.
 *
 * This is deliberately a Host-private seam rather than a provider API. It
 * authenticates the active marker, stable pointer, immutable deployment
 * manifest, and selected module/asset bytes, then fences the result with an
 * exact final marker/pointer reread. A crossing or stale expected Worker UID
 * returns `null`; malformed or tampered durable state throws one generic error
 * without exposing bindings or operator-private paths.
 */
export async function readWorkerdSelectedActiveVersion(
  root: string,
  script: string,
  options: {
    readonly expectedWorkerResourceUid: string;
    readonly basisPoint: number;
  },
): Promise<WorkerdSelectedActiveVersion | null> {
  if (!SCRIPT_NAME.test(script)) throw new Error("unusable script name");
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("unusable worker active version options");
  }
  const expectedWorkerResourceUid = validWorkerResourceUid(options.expectedWorkerResourceUid);
  const scriptsRoot = join(root, "workers");
  const activationPath = join(scriptsRoot, ".takoserver-active.json");

  let before: Record<string, string | null>;
  try {
    before = await readActivationStrict(activationPath);
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  const activeGeneration = before[script];
  if (typeof activeGeneration !== "string") return null;

  const pointerPath = join(scriptsRoot, script, MANIFEST);
  const pointerRaw = await readFile(pointerPath, "utf8").catch((error: unknown) => {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw new Error("unusable worker active version snapshot");
  });
  if (pointerRaw === null) return null;

  let pointerValue: unknown;
  try {
    pointerValue = JSON.parse(pointerRaw);
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  let deployment: WeightedDeploymentSnapshot;
  try {
    deployment = await readWeightedDeploymentSnapshot(scriptsRoot, script, pointerValue);
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  if (
    deployment.deployment.generation !== activeGeneration ||
    deployment.deployment.workerResourceUid !== expectedWorkerResourceUid
  ) {
    return null;
  }

  // This is the sole selection call. A graph crossing discovered by the final
  // fence below returns null; it never causes a second sample. Invalid caller
  // entropy retains the selector's range/type error for the caller.
  const selected = selectSelfhostWeightedVersion(deployment.canonical, options.basisPoint);

  const selectedIndex = deployment.deployment.versions.findIndex(
    (version) =>
      version.workerVersionUid === selected.workerVersionUid &&
      version.versionId === selected.versionId &&
      version.weight === selected.weight,
  );
  if (selectedIndex < 0) throw new Error("unusable worker active version snapshot");
  const stored = deployment.deployment.versions[selectedIndex];
  if (!stored) throw new Error("unusable worker active version snapshot");

  // Check the selected Version's identity before opening its module or asset
  // files. The top-level Worker UID check above already rejects a stale caller
  // expectation before any secret-bearing Version material is read.
  const selectedManifest = stored.manifest;
  if (
    typeof selectedManifest !== "object" ||
    selectedManifest === null ||
    Array.isArray(selectedManifest) ||
    selectedManifest.generation !== deployment.deployment.generation ||
    selectedManifest.workerResourceUid !== deployment.deployment.workerResourceUid ||
    !Array.isArray(selectedManifest.hostnames) ||
    selectedManifest.hostnames.length !== 0
  ) {
    throw new Error("unusable worker active version snapshot");
  }

  const capture: Required<ReadbackCapture> = {
    application: new Map(),
    hostPrivate: new Map(),
    assets: new Map(),
  };
  let manifest: Manifest;
  try {
    const moduleRoot = join(deployment.generationRoot, stored.storageKey);
    manifest = await readValidatedManifest(
      moduleRoot,
      join(moduleRoot, ASSETS_ROOT_DIRECTORY),
      selectedManifest,
      capture,
    );
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  if (
    manifest.generation !== deployment.deployment.generation ||
    manifest.workerResourceUid !== deployment.deployment.workerResourceUid ||
    manifest.hostnames.length !== 0
  ) {
    throw new Error("unusable worker active version snapshot");
  }

  let site: WorkerdSite;
  try {
    site = {
      directory: script,
      mainModule: manifest.mainModule,
      ...(manifest.hostEntrypoint === undefined ? {} : { hostEntrypoint: manifest.hostEntrypoint }),
      ...(manifest.hostModules === undefined ? {} : { hostModules: [...manifest.hostModules] }),
      hostnames: [...manifest.hostnames],
      ...(manifest.generation === undefined ? {} : { generation: manifest.generation }),
      ...(manifest.workerResourceUid === undefined
        ? {}
        : { workerResourceUid: manifest.workerResourceUid }),
      ...(manifest.fetchHandler === undefined ? {} : { fetchHandler: manifest.fetchHandler }),
      ...(manifest.serviceBindings === undefined
        ? {}
        : {
            serviceBindings: manifest.serviceBindings.map((binding) => ({
              name: binding.name,
              target: binding.target,
              targetResourceUid: binding.targetResourceUid,
              unavailableToken: binding.unavailableToken,
            })),
          }),
      ...(manifest.assets === undefined
        ? {}
        : {
            assets: {
              notFoundHandling: manifest.assets.notFoundHandling,
              runWorkerFirst: manifest.assets.runWorkerFirst,
              mediaTypes: Object.fromEntries(
                Object.entries(manifest.assets.files).map(([path, entry]) => [
                  path,
                  entry.mediaType,
                ]),
              ),
            },
          }),
      ...(manifest.vars === undefined
        ? {}
        : { vars: manifest.vars.map((binding) => ({ ...binding })) }),
      ...(manifest.modules === undefined ? {} : { modules: [...manifest.modules] }),
      ...(manifest.moduleMediaTypes === undefined
        ? {}
        : { moduleMediaTypes: { ...manifest.moduleMediaTypes } }),
      ...(manifest.dataPlane === undefined
        ? {}
        : {
            dataPlane: {
              address: manifest.dataPlane.address,
              module: manifest.dataPlane.module,
              vars: manifest.dataPlane.vars.map((binding) => ({ ...binding })),
            },
          }),
      ...(manifest.events === undefined
        ? {}
        : {
            events: {
              module: manifest.events.module,
              vars: manifest.events.vars.map((binding) => ({ ...binding })),
            },
          }),
    };
  } catch {
    // Validators normally reject these shapes earlier. Keep the reader's
    // public failure generic even for legacy manifests with missing nested
    // arrays that older validators treated as empty.
    throw new Error("unusable worker active version snapshot");
  }

  // Each collector was allocated for this call and receives a fresh byte copy
  // from the digest-verified read, so returning it directly gives ownership to
  // the caller without a second full copy of potentially large modules/assets.
  const modules = capture.application;
  const hostModules = capture.hostPrivate;
  const assets = manifest.assets === undefined ? undefined : capture.assets;

  let after: Record<string, string | null>;
  try {
    after = await readActivationStrict(activationPath);
  } catch {
    throw new Error("unusable worker active version snapshot");
  }
  const finalPointerRaw = await readFile(pointerPath, "utf8").catch((error: unknown) => {
    if ((error as { readonly code?: unknown }).code === "ENOENT") return null;
    throw new Error("unusable worker active version snapshot");
  });
  if (
    finalPointerRaw === null ||
    after[script] !== activeGeneration ||
    finalPointerRaw !== pointerRaw
  ) {
    return null;
  }

  return {
    generation: deployment.deployment.generation,
    generationKey: deployment.pointer.generationKey,
    workerResourceUid: deployment.deployment.workerResourceUid,
    versionId: selected.versionId,
    workerVersionUid: selected.workerVersionUid,
    site,
    modules,
    hostModules,
    ...(assets === undefined ? {} : { assets }),
  };
}

async function readPublished(
  scriptsRoot: string,
  assetsRoot: string,
): Promise<readonly PublishedDeployment[]> {
  const entries = await readdir(scriptsRoot, { withFileTypes: true }).catch(() => []);
  const published: PublishedDeployment[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SCRIPT_NAME.test(entry.name)) continue;
    const raw = await readFile(join(scriptsRoot, entry.name, MANIFEST), "utf8").catch(() => null);
    if (raw === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      if (raw.includes("publicationStorageLayout")) {
        throw new Error("unusable worker deployment pointer");
      }
      continue;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "publicationStorageLayout" in value
    ) {
      published.push(await readWeightedDeployment(scriptsRoot, entry.name, value));
      continue;
    }
    // A manifest whose bindings cannot be rendered is not a script this process
    // will serve. Skipping it keeps one broken directory from taking every
    // other customer's site down with it on the next reload. Renderability is
    // proved here, not merely name validity: `capnpText` refuses a NUL or a
    // lone surrogate, and it is the only thing that stands between a torn or
    // tampered manifest and a `renderConfig` that throws for everyone.
    let manifest: Manifest;
    try {
      manifest = await readValidatedManifest(
        join(scriptsRoot, entry.name),
        join(assetsRoot, entry.name),
        value,
      );
      internalHostname(entry.name);
      eventHostname(entry.name);
    } catch {
      continue;
    }
    published.push({
      name: entry.name,
      ...(manifest.generation === undefined ? {} : { generation: manifest.generation }),
      ...(manifest.workerResourceUid === undefined
        ? {}
        : { workerResourceUid: manifest.workerResourceUid }),
      hostnames: validDeploymentHostnames(manifest.hostnames),
      weighted: false,
      variants: [
        {
          name: entry.name,
          logicalName: entry.name,
          storagePrefix: entry.name,
          assetRoot: join(assetsRoot, entry.name),
          manifest,
        },
      ],
    });
  }
  return published.sort((left, right) => left.name.localeCompare(right.name));
}

function requiredStoredModule(
  inventory: readonly WorkerdStoredModule[],
  name: string,
): WorkerdStoredModule {
  const match = inventory.find((entry) => entry.name === name);
  if (!match) throw new Error("unusable worker module storage manifest");
  return match;
}

function serviceRouterName(binding: WorkerdServiceBinding): string {
  const digest = createHash("sha256")
    .update("takoserver.selfhost-service-router@v1\u0000", "utf8")
    .update(binding.target, "utf8")
    .update("\u0000", "utf8")
    .update(binding.targetResourceUid, "utf8")
    .update("\u0000", "utf8")
    .update(binding.unavailableToken, "utf8")
    .digest("hex");
  return `selfhost-service-${digest}`;
}

function validPrivateSocketDirectory(path: string): void {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.includes("\u0000") ||
    Buffer.byteLength(join(path, `${"0".repeat(64)}.sock`)) > 100
  ) {
    throw new Error("unusable private service socket directory");
  }
}

interface PrivateSocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

function samePrivateSocketIdentity(
  left: PrivateSocketIdentity,
  right: PrivateSocketIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function privateSocketMetadata(path: string): Promise<PrivateSocketIdentity | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket() || metadata.uid !== process.getuid?.()) {
      throw new Error("private service socket path is not an owned socket");
    }
    return metadata;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function requirePrivateSocketDirectory(path: string): Promise<PrivateSocketIdentity> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== 0o700 ||
    metadata.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  ) {
    throw new Error("unusable private service socket directory");
  }
  return metadata;
}

function privateServiceSocket(directory: string, router: string): string {
  return join(directory, `${router.slice("selfhost-service-".length)}.sock`);
}

interface PrivateServiceGraph {
  readonly socketDirectory: string;
  readonly bindings: ReadonlyMap<string, WorkerdServiceBinding>;
}

function collectServiceBindings(
  published: readonly PublishedDeployment[],
  retained: readonly WorkerdServiceBinding[] = [],
): ReadonlyMap<string, WorkerdServiceBinding> {
  const bindings = new Map<string, WorkerdServiceBinding>();
  for (const deployment of published) {
    for (const entry of deployment.variants) {
      for (const binding of validServiceBindings(entry.manifest.serviceBindings ?? [])) {
        bindings.set(serviceRouterName(binding), binding);
      }
    }
  }
  for (const binding of retained) bindings.set(serviceRouterName(binding), binding);
  return new Map([...bindings].sort(([left], [right]) => left.localeCompare(right)));
}

function variantFetchService(entry: PublishedVariant): string {
  return entry.manifest.assets ? `${entry.name}-asset-router` : entry.name;
}

function logicalFetchService(entry: PublishedDeployment): string {
  return entry.weighted
    ? `${entry.name}-selfhost-deployment`
    : variantFetchService(entry.variants[0] as PublishedVariant);
}

function logicalEventService(entry: PublishedDeployment): string | null {
  if (entry.weighted) {
    return entry.variants.every((variant) => variant.manifest.events !== undefined)
      ? `${entry.name}-selfhost-events`
      : null;
  }
  const variant = entry.variants[0];
  return variant?.manifest.events ? `${variant.name}-selfhost-events` : null;
}

function publishedGraphIdentity(
  published: readonly PublishedDeployment[],
  privateServices?: PrivateServiceGraph,
): string {
  const hash = createHash("sha256").update(
    JSON.stringify(
      published.map((deployment) => ({
        name: deployment.name,
        generation: deployment.generation ?? null,
        workerResourceUid: deployment.workerResourceUid ?? null,
        hostnames: deployment.hostnames,
        weighted: deployment.weighted,
        variants: deployment.variants.map((variant) => ({
          name: variant.name,
          storagePrefix: variant.storagePrefix,
          assetRoot: variant.assetRoot,
          versionId: variant.versionId ?? null,
          workerVersionUid: variant.workerVersionUid ?? null,
          weight: variant.weight ?? null,
          manifest: variant.manifest,
        })),
      })),
    ),
    "utf8",
  );
  if (privateServices) {
    // A reload that only prunes retired callers must not be acknowledged by
    // the prior graph's probe. Private topology is part of config identity.
    hash.update("\u0000private-services\u0000").update(
      JSON.stringify({
        directory: privateServices.socketDirectory,
        routers: [...privateServices.bindings.keys()],
      }),
    );
  }
  return hash.digest("hex");
}

/**
 * The configuration, rendered whole.
 *
 * A router service in front, because workerd binds a socket to one service and
 * a platform needs many. The router holds a service binding per script and
 * picks by `Host`; anything unclaimed gets a 404 that says so, which is the
 * only honest answer when nobody has asked for that name.
 */
function renderWorkerdModules(
  manifest: Manifest,
  storagePrefix: string,
  trustedWorkflowOuter = false,
): string {
  const mainModule = validModules([manifest.mainModule])[0] as string;
  const declaredModules = validModules(manifest.modules ?? [], manifest.mainModule);
  const moduleMediaTypes = validModuleMediaTypes(
    mainModule,
    declaredModules,
    manifest.moduleMediaTypes,
  );
  const applicationModules = manifest.moduleFiles.application;
  const hostModules = manifest.moduleFiles.hostPrivate;
  const hostEntrypoint = manifest.hostEntrypoint;
  const orderedHostModules =
    hostEntrypoint === undefined
      ? hostModules
      : [
          requiredStoredModule(hostModules, hostEntrypoint),
          ...hostModules.filter((module) => module.name !== hostEntrypoint),
        ];
  const application = applicationModules.map((module) => ({
    module,
    role: "application" as const,
  }));
  const host = orderedHostModules.map((module) => ({ module, role: "hostPrivate" as const }));
  return (hostEntrypoint === undefined ? [...application, ...host] : [...host, ...application])
    .map(({ module, role }) => {
      const mediaType =
        role === "application"
          ? (moduleMediaTypes?.[module.name] ?? "application/javascript+module")
          : "application/javascript+module";
      const directory =
        role === "application" ? APPLICATION_MODULE_DIRECTORY : HOST_PRIVATE_MODULE_DIRECTORY;
      return `(name = ${capnpText(module.name)}, ${workerdModuleKind(mediaType)} = embed ${capnpText(`${storagePrefix}/${directory}/${module.key}`)}${trustedWorkflowOuter ? "" : `, role = ${role}`})`;
    })
    .join(", ");
}

function renderConfig(
  published: readonly PublishedDeployment[],
  port: number,
  _assetsRoot: string,
  tls?: WorkerdTlsKeypair,
  configProbeToken?: string,
  internalReadinessCapability = "",
  dataPlaneAddress?: string,
  privateServices?: PrivateServiceGraph,
): string {
  const variants = published.flatMap((deployment) => deployment.variants);
  const graphIdentity = publishedGraphIdentity(published, privateServices);
  const services = variants
    .map((entry) => {
      const bindings = [
        ...(hasHostEntrypoint(entry)
          ? [
              `(name = ${capnpText(INTERNAL_READINESS_CAPABILITY_BINDING)}, text = ${capnpText(internalReadinessCapability)})`,
            ]
          : []),
        ...(entry.manifest.dataPlane
          ? [`(name = "${DATA_SERVICE_BINDING}", service = "${entry.name}-selfhost-data")`]
          : []),
        ...validServiceBindings(entry.manifest.serviceBindings ?? []).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, service = ${capnpText(serviceRouterName(binding))})`,
        ),
        ...validBindings(entry.manifest.vars ?? []).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ];
      const bindingList =
        bindings.length === 0 ? "" : `\n      bindings = [ ${bindings.join(", ")} ],`;
      // The configured entrypoint comes first. Host-private and application
      // modules retain separate registry identities even when their logical
      // names are equal; only the Host entrypoint has the explicit bridge to
      // this publication's exact application main.
      const mainModule = validModules([entry.manifest.mainModule])[0] as string;
      const moduleList = renderWorkerdModules(entry.manifest, entry.storagePrefix);
      // Rendered only for a script published through a generated entrypoint, so
      // a script that binds no data plane produces the bytes it always did.
      const flagList = hasHostEntrypoint(entry)
        ? `\n      compatibilityFlags = [ ${APPLICATION_COMPATIBILITY_FLAGS.map((flag) => capnpText(flag)).join(", ")} ],`
        : "";
      return `  ( name = "${entry.name}",
    worker = (
      modules = [ ${moduleList} ],${bindingList}
      modulePolicy = (applicationMain = ${capnpText(mainModule)}),
      compatibilityDate = "2026-01-01",${flagList}
    )
  ),`;
    })
    .join("\n");

  // Absolute, because a `disk` path is resolved against the process's working
  // directory while an `embed` is resolved against this file — the same config
  // read from two directories would otherwise find its modules and lose its
  // files. The failure names the directory it could not find, which reads like
  // the files are missing rather than like the path is relative.
  //
  // Files come off the disk through workerd's own directory service. A private
  // lookup service validates the portable path grammar and applies SPA miss
  // behavior; a second Host-owned service composes that lookup with the tenant
  // worker in the exact declared order. Neither binding is on the tenant
  // service, so `env.ASSETS` is never invented by this Host.
  const assetServices = variants
    .filter((entry) => entry.manifest.assets)
    .map((entry) => {
      const assets = validAssetManifest(entry.manifest.assets);
      if (!assets) throw new Error("unusable worker asset manifest");
      return `  ( name = "${entry.name}-assets-files",
    disk = ( path = ${capnpText(entry.assetRoot)}, writable = false )
  ),
  ( name = "${entry.name}-assets",
    worker = (
      modules = [ (name = "assets.js", esModule = embed "assets.js") ],
      bindings = [
        (name = "FILES", service = "${entry.name}-assets-files"),
        (name = "NOT_FOUND", text = "${assets.notFoundHandling}"),
        (name = "ASSET_MANIFEST", json = ${capnpText(JSON.stringify(assets.files))}),
      ],
      compatibilityDate = "2026-01-01",
    )
  ),
  ( name = "${entry.name}-asset-router",
    worker = (
      modules = [ (name = "asset-router.js", esModule = embed "asset-router.js") ],
      bindings = [
        (name = "WORKER", service = "${entry.name}"),
        (name = "ASSETS", service = "${entry.name}-assets"),
        (name = "RUN_WORKER_FIRST", text = "${assets.runWorkerFirst ? "true" : "false"}"),
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  // One private router per immutable caller binding. Its per-Version token is
  // what makes the unavailable signal unforgeable by the target while letting
  // an active response pass through byte-for-byte, headers and body stream
  // included. Target selection is only the persisted script + Resource UID;
  // the request URL and Host header are never consulted.
  const publishedByName = new Map(published.map((entry) => [entry.name, entry] as const));
  const routedBindings = privateServices?.bindings ?? collectServiceBindings(published);
  const serviceBindingServices = [...routedBindings]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, binding]) => {
      const target = publishedByName.get(binding.target);
      const active =
        target?.workerResourceUid === binding.targetResourceUid &&
        target.variants.every((variant) => variant.manifest.fetchHandler === true);
      const targetService = target ? logicalFetchService(target) : binding.target;
      return `  ( name = ${capnpText(name)},
    worker = (
      modules = [ (name = ${capnpText(SERVICE_ROUTER_MODULE)}, esModule = embed ${capnpText(SERVICE_ROUTER_MODULE)}) ],
      bindings = [
        (name = "${SERVICE_UNAVAILABLE_TOKEN_BINDING}", text = ${capnpText(binding.unavailableToken)}),${
          active ? `\n        (name = "TARGET", service = ${capnpText(targetService)}),` : ""
        }
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  // Each script contributes its own service pair. Service membership derives
  // from manifests on disk: a script that binds no data plane contributes
  // neither service, and removing it removes both. The origin listener comes
  // from current Host-owned transport so restart never rewrites the manifest.
  //
  // The token is declared here and only here. The script's own service holds a
  // binding to this one and nothing else, so tenant code — by `env`, by
  // `cloudflare:workers`, or by any other route into its own isolate — has
  // nothing to find.
  const dataServices = variants
    .filter((entry) => entry.manifest.dataPlane)
    .map((entry) => {
      const plane = validDataPlane(entry.manifest.dataPlane as WorkerdDataPlane);
      const planeModule = requiredStoredModule(
        entry.manifest.moduleFiles.hostPrivate,
        plane.module,
      );
      const facadeBindings = [
        `(name = "${DATA_PLANE_BINDING}", service = "${entry.name}-selfhost-data-origin")`,
        ...validBindings(plane.vars).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ].join(", ");
      return `  ( name = "${entry.name}-selfhost-data",
    worker = (
      modules = [ (name = ${capnpText(plane.module)}, esModule = embed ${capnpText(`${entry.storagePrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${planeModule.key}`)}) ],
      bindings = [ ${facadeBindings} ],
      compatibilityDate = "2026-01-01",
    )
  ),
  ( name = "${entry.name}-selfhost-data-origin",
    external = ( address = ${capnpText(dataPlaneAddress ?? plane.address)}, http = () )
  ),`;
    })
    .join("\n");

  // One gate per script that receives events. It holds the token and the only
  // binding on this machine that names the script's event entrypoint; the
  // script itself is not reachable on the event hostname at all, and the
  // entrypoint the gate calls is a named export the router never addresses.
  const eventGateServices = variants
    .filter((entry) => entry.manifest.events)
    .map((entry) => {
      const gate = validEventGate(entry.manifest.events as WorkerdEventGate);
      const gateModule = requiredStoredModule(entry.manifest.moduleFiles.hostPrivate, gate.module);
      const gateBindings = [
        `(name = "${EVENT_TARGET_BINDING}", service = (name = ${capnpText(entry.name)}, entrypoint = "${EVENT_ENTRYPOINT}"))`,
        ...validBindings(gate.vars).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ].join(", ");
      return `  ( name = "${entry.name}-selfhost-events",
    worker = (
      modules = [ (name = ${capnpText(gate.module)}, esModule = embed ${capnpText(`${entry.storagePrefix}/${HOST_PRIVATE_MODULE_DIRECTORY}/${gateModule.key}`)}) ],
      bindings = [ ${gateBindings} ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  // One stable logical fetch service owns the weighted choice. Private
  // variants are bound only here (and to their per-Version event gates), so
  // they have no hostname, router binding, or service-binding identity of
  // their own. Ordinary fetch forwards the original Request and returns the
  // original Response; readiness alone fans out to prove the complete graph.
  const deploymentRouterServices = published
    .filter((entry) => entry.weighted)
    .map((entry) => {
      const table = entry.variants.map((variant, index) => ({
        binding: `VERSION_${index.toString(10).padStart(5, "0")}`,
        readinessBinding: `READINESS_${index.toString(10).padStart(5, "0")}`,
        versionId: variant.versionId as string,
        weight: variant.weight as number,
      }));
      const versionBindings = entry.variants.flatMap((variant, index) => [
        `(name = ${capnpText(table[index]?.binding as string)}, service = ${capnpText(variantFetchService(variant))})`,
        `(name = ${capnpText(table[index]?.readinessBinding as string)}, service = ${capnpText(variant.name)})`,
      ]);
      return `  ( name = ${capnpText(logicalFetchService(entry))},
    worker = (
      modules = [ (name = ${capnpText(DEPLOYMENT_ROUTER_MODULE)}, esModule = embed ${capnpText(DEPLOYMENT_ROUTER_MODULE)}) ],
      bindings = [
        (name = "VERSIONS", json = ${capnpText(JSON.stringify(table))}),
        (name = "PUBLICATION", text = ${capnpText(
          createHash("sha256")
            .update(entry.generation as string, "utf8")
            .digest("hex"),
        )}),
        (name = "INTERNAL_HOSTNAME", text = ${capnpText(internalHostname(entry.name))}),
        (name = "INTERNAL_READINESS_CAPABILITY", text = ${capnpText(internalReadinessCapability)}),
        ${versionBindings.join(",\n        ")}
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  // The public event hostname reaches one stable dispatcher. It reads only a
  // bounded clone of the existing private envelope, requires this exact
  // logical script and a currently weighted deployment id, then forwards the
  // untouched original request to that Version's private token gate.
  const eventDispatcherServices = published
    .filter((entry) => entry.weighted && logicalEventService(entry) !== null)
    .map((entry) => {
      const table = entry.variants.map((variant, index) => ({
        binding: `VERSION_${index.toString(10).padStart(5, "0")}`,
        versionId: variant.versionId as string,
      }));
      const gateBindings = entry.variants.map(
        (variant, index) =>
          `(name = ${capnpText(table[index]?.binding as string)}, service = ${capnpText(`${variant.name}-selfhost-events`)})`,
      );
      return `  ( name = ${capnpText(logicalEventService(entry) as string)},
    worker = (
      modules = [ (name = ${capnpText(EVENT_DISPATCHER_MODULE)}, esModule = embed ${capnpText(EVENT_DISPATCHER_MODULE)}) ],
      bindings = [
        (name = "LOGICAL_WORKER", text = ${capnpText(entry.name)}),
        (name = "VERSIONS", json = ${capnpText(JSON.stringify(table))}),
        ${gateBindings.join(",\n        ")}
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  const routes = [
    ...published.flatMap((entry) =>
      entry.hostnames.map((hostname) => ({
        hostname,
        service: logicalFetchService(entry),
      })),
    ),
    // Last, so a customer domain that happens to claim one of these names
    // cannot capture this Host's own probe for another script.
    // Every script published through a generated entrypoint, not only the ones
    // that bind a data plane: the entrypoint answers the readiness question and
    // a script this Host cannot ask is one it publishes without checking.
    ...published
      .filter((entry) => entry.variants.every((variant) => hasHostEntrypoint(variant)))
      .map((entry) => ({
        hostname: internalHostname(entry.name),
        service: logicalFetchService(entry),
      })),
    ...published
      .filter((entry) => logicalEventService(entry) !== null)
      .map((entry) => ({
        hostname: eventHostname(entry.name),
        service: logicalEventService(entry) as string,
      })),
  ];
  const routeTable = JSON.stringify(Object.fromEntries(routes.map((r) => [r.hostname, r.service])));
  const internalReadinessRoutes = JSON.stringify(
    Object.fromEntries(
      published
        .filter((entry) => entry.variants.every((variant) => hasHostEntrypoint(variant)))
        .map((entry) => [internalHostname(entry.name), logicalFetchService(entry)]),
    ),
  );
  const bindings = [
    ...published.map((entry) => {
      const service = logicalFetchService(entry);
      return `      (name = ${capnpText(service)}, service = ${capnpText(service)}),`;
    }),
    ...published
      .map((entry) => logicalEventService(entry))
      .filter((entry): entry is string => entry !== null)
      .map((entry) => `      (name = ${capnpText(entry)}, service = ${capnpText(entry)}),`),
  ].join("\n");

  const privateSockets = privateServices
    ? [...privateServices.bindings.keys()].map(
        (router) =>
          `( name = ${capnpText(router)}, address = ${capnpText(`unix:${privateServiceSocket(privateServices.socketDirectory, router)}`)}, http = (style = proxy), service = ${capnpText(router)} )`,
      )
    : [];

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${services}
${assetServices}${serviceBindingServices === "" ? "" : `\n${serviceBindingServices}`}${dataServices === "" ? "" : `\n${dataServices}`}${eventGateServices === "" ? "" : `\n${eventGateServices}`}${deploymentRouterServices === "" ? "" : `\n${deploymentRouterServices}`}${eventDispatcherServices === "" ? "" : `\n${eventDispatcherServices}`}
  ( name = "router",
    worker = (
      modules = [ (name = "router.js", esModule = embed "router.js") ],
      bindings = [
        (name = "ROUTES", text = ${JSON.stringify(routeTable)}),
        (name = "INTERNAL_READINESS_ROUTES", text = ${capnpText(internalReadinessRoutes)}),
        (name = "INTERNAL_READINESS_CAPABILITY", text = ${capnpText(internalReadinessCapability)}),
        (name = "CONFIG_IDENTITY", text = ${capnpText(graphIdentity)}),
        (name = "CONFIG_PROBE_TOKEN", text = ${capnpText(configProbeToken ?? "")}),
${bindings}
      ],
      compatibilityDate = "2026-01-01",
    )
  ),
  ],
  sockets = [ ${[socket(port, tls), ...privateSockets].join(", ")} ]
);
`;
}

/**
 * The one socket the router answers on, and the only place a scheme is decided.
 *
 * With a keypair, workerd terminates TLS itself — `https` in workerd's own
 * schema, with the PEM text inline, which is why the generated configuration is
 * a `0600` file. Without one the socket is plain HTTP, and the Host publishes
 * `http://` for it rather than an `https://` address the socket cannot serve.
 */
function socket(port: number, tls?: WorkerdTlsKeypair): string {
  if (!tls) {
    return `( name = "http", address = "*:${port}", http = (), service = "router" )`;
  }
  const keypair = `keypair = ( privateKey = ${capnpText(tls.privateKey)}, certificateChain = ${capnpText(tls.certificateChain)} )`;
  return `( name = "https", address = "*:${port}", https = ( options = (), tlsOptions = ( ${keypair} ) ), service = "router" )`;
}

/**
 * The router, written beside the scripts so the config can embed it.
 *
 * Small on purpose: it reads a host, finds a binding, and forwards. Everything
 * it does not know about is a 404 naming the host, because the alternative —
 * falling back to some script — is how one customer's traffic reaches another
 * customer's code without anybody noticing.
 */
export const ROUTER_SOURCE = `const CONFIG_PROBE_HOSTNAME = ${JSON.stringify(CONFIG_PROBE_HOSTNAME)};
const CONFIG_PROBE_PATH = ${JSON.stringify(CONFIG_PROBE_PATH)};
const CONFIG_PROBE_HEADER = ${JSON.stringify(CONFIG_PROBE_HEADER)};
const CONFIG_IDENTITY_HEADER = ${JSON.stringify(CONFIG_IDENTITY_HEADER)};
const INTERNAL_READINESS_CAPABILITY_HEADER = ${JSON.stringify(INTERNAL_READINESS_CAPABILITY_HEADER)};

function refuse() {
  return new Response(null, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    if (
      request.method === "POST" &&
      host === CONFIG_PROBE_HOSTNAME &&
      url.pathname === CONFIG_PROBE_PATH &&
      env.CONFIG_PROBE_TOKEN.length === 64 &&
      request.headers.get(CONFIG_PROBE_HEADER) === env.CONFIG_PROBE_TOKEN
    ) {
      return new Response(null, {
        status: 204,
        headers: { [CONFIG_IDENTITY_HEADER]: env.CONFIG_IDENTITY },
      });
    }
    const routes = JSON.parse(env.ROUTES);
    const service = routes[host];
    if (!service || !env[service]) {
      return new Response("no worker is published for " + host + "\\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const capability = request.headers.get(INTERNAL_READINESS_CAPABILITY_HEADER);
    if (capability !== null) {
      const internal = JSON.parse(env.INTERNAL_READINESS_ROUTES);
      if (
        capability !== env.INTERNAL_READINESS_CAPABILITY ||
        internal[host] !== service
      ) return refuse();
    }
    return env[service].fetch(request);
  },
};
`;

/** Stable private entropy router for one complete weighted deployment. */
export const DEPLOYMENT_ROUTER_SOURCE = `const READINESS_PATH = ${JSON.stringify(WORKER_READINESS_PATH)};
const READINESS_HEADER = ${JSON.stringify(WORKER_READINESS_HEADER)};
const READINESS_PROTOCOL = ${JSON.stringify(WORKER_READINESS_PROTOCOL)};
const READINESS_SCHEMA = "takoserver.selfhost-worker-readiness-result@v1";
const INTERNAL_READINESS_CAPABILITY_HEADER = ${JSON.stringify(INTERNAL_READINESS_CAPABILITY_HEADER)};
const UINT32_RANGE = 0x1_0000_0000;
const RANDOM_LIMIT = UINT32_RANGE - (UINT32_RANGE % 10000);

function basisPoint() {
  const words = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(words);
    const value = words[0];
    if (value < RANDOM_LIMIT) return value % 10000;
  }
}

function selected(versions) {
  const point = basisPoint();
  let upper = 0;
  for (const version of versions) {
    upper += version.weight;
    if (point < upper) return version;
  }
  throw new Error("invalid weighted deployment");
}

function readinessAnswer(publication, status, failure) {
  return new Response(JSON.stringify({
    schema: READINESS_SCHEMA,
    publication,
    ...(failure ? { failure } : {}),
  }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readiness(request, env) {
  for (const version of env.VERSIONS) {
    const response = await env[version.readinessBinding].fetch(request.clone());
    const body = await response.text();
    let answer;
    try {
      answer = body.length <= 8192 ? JSON.parse(body) : null;
    } catch {
      answer = null;
    }
    if (
      !answer ||
      answer.schema !== READINESS_SCHEMA ||
      answer.publication !== version.versionId
    ) {
      return readinessAnswer(env.PUBLICATION, 503, { reason: "module" });
    }
    if (response.status !== 200) {
      return readinessAnswer(env.PUBLICATION, response.status, answer.failure ?? { reason: "module" });
    }
  }
  return readinessAnswer(env.PUBLICATION, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const capability = request.headers.get(INTERNAL_READINESS_CAPABILITY_HEADER);
    const internalReadiness =
      request.method === "POST" &&
      url.hostname === env.INTERNAL_HOSTNAME &&
      url.pathname === READINESS_PATH &&
      request.headers.get(READINESS_HEADER) === READINESS_PROTOCOL &&
      capability === env.INTERNAL_READINESS_CAPABILITY;
    if (internalReadiness) {
      return await readiness(request, env);
    }
    // A same-named header is Host-private. Never expose even an incorrect
    // guess to tenant code, and never treat it as authority on another shape.
    if (capability !== null) return new Response(null, { status: 404 });
    const version = selected(env.VERSIONS);
    // Selection is final. Transport failure propagates; no second Version is
    // sampled and the original Request/Response streams are never rebuilt.
    return await env[version.binding].fetch(request);
  },
};
`;

/** Stable dispatcher from one logical event route to one private Version gate. */
export const EVENT_DISPATCHER_SOURCE = `const EVENT_PATH = "/.well-known/takoserver/managed-worker-events/v1";
const EVENT_HEADER = "x-takoserver-managed-worker-event";
const EVENT_PROTOCOL = "takoserver.managed-worker-event@v1";
const EVENT_CONTENT_TYPE = "application/vnd.takoserver.managed-worker-event.v1+json";
const MAX_REQUEST_BYTES = ${2 * 1024 * 1024};

function refuse() {
  return new Response(null, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.pathname !== EVENT_PATH ||
      request.headers.get(EVENT_HEADER) !== EVENT_PROTOCOL ||
      request.headers.get("content-type") !== EVENT_CONTENT_TYPE
    ) return refuse();
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_REQUEST_BYTES) return refuse();
    let bytes;
    let event;
    try {
      bytes = await request.clone().arrayBuffer();
      if (bytes.byteLength > MAX_REQUEST_BYTES) return refuse();
      event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return refuse();
    }
    if (
      !event ||
      typeof event !== "object" ||
      event.logicalWorkerId !== env.LOGICAL_WORKER ||
      typeof event.deploymentId !== "string"
    ) return refuse();
    const version = env.VERSIONS.find((candidate) => candidate.versionId === event.deploymentId);
    if (!version || !env[version.binding]) return refuse();
    // The selected private gate validates the original per-Version token and
    // the full existing envelope. Unknown or no-longer-weighted ids stop here.
    return await env[version.binding].fetch(request);
  },
};
`;

/**
 * Private logical-worker router for one immutable caller binding.
 *
 * An active native response is returned without reconstruction, which is what
 * preserves its stream and every response field. The token exists only on
 * this Host-owned service and in the caller's Host-private wrapper. A target
 * cannot manufacture the exact unavailable signal, even if it returns the
 * same status and header name intentionally.
 */
export const SERVICE_ROUTER_SOURCE = `const HEADER = ${JSON.stringify(SERVICE_UNAVAILABLE_HEADER)};

function unavailable(env) {
  return new Response(null, {
    status: 530,
    headers: { [HEADER]: env.${SERVICE_UNAVAILABLE_TOKEN_BINDING} },
  });
}

export default {
  async fetch(request, env) {
    if (!env.TARGET || typeof env.TARGET.fetch !== "function") return unavailable(env);
    // Native cancellation and request/response stream aborts are transport
    // outcomes, not evidence that target selection failed. Let them propagate;
    // the target wrapper has already converted an actual handler throw to 500.
    return await env.TARGET.fetch(request);
  },
};
`;

/**
 * The Host-owned HTTP composition layer for one Worker Version with assets.
 *
 * Only its service receives `WORKER` and `ASSETS`. The tenant service receives
 * neither, and the public router reaches this service only for customer
 * hostnames; the provider's readiness hostname still reaches the Worker
 * directly.
 */
export const ASSET_ROUTER_SOURCE = `const MISS_HEADER = "x-takoserver-selfhost-asset-miss";

function isAssetMiss(response) {
  return response.status === 404 && response.headers.get(MISS_HEADER) === "1";
}

function assetMethod(request) {
  return request.method === "GET" || request.method === "HEAD";
}

export default {
  async fetch(request, env) {
    // A request body must cross exactly one service boundary. Static lookup is
    // not meaningful for another method and must not consume a body before the
    // application sees it.
    if (!assetMethod(request)) return env.WORKER.fetch(request);

    if (env.RUN_WORKER_FIRST === "true") {
      const worker = await env.WORKER.fetch(request);
      if (worker.status !== 404) return worker;
      const asset = await env.ASSETS.fetch(request);
      return isAssetMiss(asset) ? worker : asset;
    }

    const asset = await env.ASSETS.fetch(request);
    if (!isAssetMiss(asset)) return asset;
    return env.WORKER.fetch(request);
  },
};
`;

/**
 * The asset layer, written beside the scripts so the config can embed it.
 *
 * workerd's directory service answers with a file or with nothing. What a site
 * needs on top of that is small and entirely about exact path admission and
 * what a miss means. An application that routes on the client needs its shell
 * served for a valid path no file matches; malformed and ambiguous paths fail
 * closed before that fallback. Cloudflare's asset layer decides the former
 * from `notFoundHandling`, and the bounded URL safety rules decide the latter;
 * the manifest filename grammar is not an application URL allowlist.
 */
export const ASSETS_SOURCE = `const MISS_HEADER = "x-takoserver-selfhost-asset-miss";

async function file(env, entry) {
  // Logical manifest paths never become filesystem paths. The private
  // manifest maps each one to a Host-generated flat key, so two valid names
  // such as foo and foo/bar.txt cannot collide on disk.
  const response = await env.FILES.fetch("http://assets/" + entry.key, { method: "GET" });
  if (response.status === 404) return null;
  if (response.status !== 200) return response;
  // A directory answers 200 with a JSON listing of itself. That is exactly
  // distinguishable from a file, because the service never sniffs a type and
  // hands back every real file — .json included — as octet-stream. Serving
  // the listing would put the names of a customer's files on their homepage.
  if ((response.headers.get("content-type") ?? "").startsWith("application/json")) return null;
  return response;
}

function miss() {
  return new Response("not found\\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [MISS_HEADER]: "1",
    },
  });
}

function invalidPath() {
  // Deliberately indistinguishable from an ordinary public 404, but without
  // the private miss marker: once the declared ordering reaches asset lookup,
  // the composition service treats this as final instead of entering a later
  // Worker stage or SPA fallback.
  return new Response("not found\\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function pathOf(request) {
  const rawUrl = typeof request.url === "string" ? request.url : "";
  const rawPath = rawUrl.split(/[?#]/u, 1)[0] ?? "";
  // Some URL implementations normalize encoded dot segments while parsing;
  // inspect the wire spelling first so traversal never becomes a native key.
  const rawLower = rawPath.toLowerCase();
  if (
    rawPath.split("/").some((segment) =>
      [".", "..", "%2e", "%2e%2e", "%2e.", ".%2e"].includes(segment.toLowerCase()),
    ) ||
    rawLower.includes("%2f") ||
    rawLower.includes("%5c")
  ) return null;
  let pathname;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  // Separators encoded into a segment must not turn into routing structure.
  if (/%(?:2f|5c)/i.test(pathname)) return null;
  let decoded;
  try {
    // decodeURIComponent is strict UTF-8 and throws on malformed escapes,
    // invalid sequences, and lone encoded surrogates. It is called once.
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\\\")) return null;
  for (const symbol of decoded) {
    const point = symbol.codePointAt(0);
    if (
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0xfdd0 && point <= 0xfdef) ||
      (point & 0xffff) === 0xfffe ||
      (point & 0xffff) === 0xffff
    ) return null;
  }
  const path = decoded.slice(1);
  // The root, a single trailing slash, and repeated slashes are valid missing
  // paths. Only literal dot or dotdot segments are rejected as traversal.
  if (path === "") return path;
  const segments = path.split("/");
  const checkedSegments = segments.at(-1) === "" ? segments.slice(0, -1) : segments;
  if (checkedSegments.some((segment) => segment === "." || segment === "..")) return null;
  // URL paths are not constrained by the manifest filename grammar. A valid
  // Unicode, extensionless, or trailing-slash path can simply miss the
  // inventory and then follow the declared none/SPA fallback policy.
  return path;
}

function served(response, mediaType, status) {
  const headers = new Headers(response.headers);
  // Artifact evidence, not a filename table, is the meaning of these bytes.
  headers.set("content-type", mediaType);
  return new Response(response.body, { status, headers });
}

function manifestEntry(env, path) {
  return Object.prototype.hasOwnProperty.call(env.ASSET_MANIFEST, path)
    ? env.ASSET_MANIFEST[path]
    : null;
}

export default {
  async fetch(request, env) {
    const assetPath = pathOf(request);
    if (assetPath === null) return invalidPath();

    const directEntry = assetPath === "" ? null : manifestEntry(env, assetPath);
    const direct = directEntry ? await file(env, directEntry) : null;
    if (direct) return direct.status === 200 ? served(direct, directEntry.mediaType, 200) : direct;

    if (env.NOT_FOUND === "single-page-application") {
      const shellEntry = manifestEntry(env, "index.html");
      const shell = shellEntry ? await file(env, shellEntry) : null;
      // Status 200, because the application is what was found and it will
      // route the path itself. A 200 is what Cloudflare's asset layer returns
      // here, and a client router behind a 404 is a different product.
      if (shell) return shell.status === 200 ? served(shell, shellEntry.mediaType, 200) : shell;
    }
    return miss();
  },
};
`;
