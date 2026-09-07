import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { bytesDigest } from "./json.ts";
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

/**
 * The runtime as its own process holds it, which is one capability more.
 *
 * `WorkerdRuntime` is the seam a *provider* publishes through, and a provider
 * never restarts a machine. A composition root does, and it is the only thing
 * that knows this process has just started with a data directory that may
 * already hold published Workers.
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
  readonly assets?: WorkerdAssetManifest;
  readonly vars?: readonly WorkerdBinding[];
  readonly modules?: readonly string[];
  readonly moduleMediaTypes?: Readonly<Record<string, WorkerdModuleMediaType>>;
  readonly dataPlane?: WorkerdDataPlane;
  readonly events?: WorkerdEventGate;
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
/** Operator-private sibling tree holding every script's flat static files. */
const ASSETS_ROOT_DIRECTORY = "assets";
/** Exact persisted meaning of the private physical asset keys. */
const WORKERD_ASSET_STORAGE_LAYOUT = "flat-ordinal-v1" as const;
/** Separate physical roots mirror the runtime's two module namespaces. */
const WORKERD_MODULE_STORAGE_LAYOUT = "provenance-v1" as const;
const APPLICATION_MODULE_DIRECTORY = "application";
const HOST_PRIVATE_MODULE_DIRECTORY = "host-private";

export function createWorkerdRuntime(options: WorkerdRuntimeOptions): HostedWorkerdRuntime {
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
  const render = async (published: readonly Published[]): Promise<void> => {
    await privateDirectory(scriptsRoot);
    for (const entry of published) await privateDirectory(join(scriptsRoot, entry.name));
    const assetPublications = published.filter((candidate) => candidate.manifest.assets);
    if (assetPublications.length > 0) {
      await privateDirectory(assetsRoot);
      for (const entry of assetPublications) await privateDirectory(assetDirectory(entry.name));
    }
    // Written before the config that embeds it, every time, so a router
    // improvement reaches a deployment on its next reload rather than
    // whenever somebody remembers.
    await writeFile(join(scriptsRoot, "router.js"), ROUTER_SOURCE, "utf8");
    await writeFile(join(scriptsRoot, "assets.js"), ASSETS_SOURCE, "utf8");
    await writeFile(join(scriptsRoot, "asset-router.js"), ASSET_ROUTER_SOURCE, "utf8");
    await privateDirectory(dirname(configPath));
    // The rendered configuration contains every binding value, sensitive ones
    // included, so it is created `0600` and moved into place atomically.
    await writePrivate(configPath, renderConfig(published, port, assetsRoot, options.tls), "utf8");
    await options.onReload?.(configPath);
    // A staged manifest is not runtime truth. Only after the reload hook
    // returns successfully do we persist the generation actually activated;
    // a failed reload therefore leaves the previous marker intact.
    await writeActivation(
      activationPath,
      Object.fromEntries(published.map((entry) => [entry.name, entry.manifest.generation ?? null])),
    );
  };

  return {
    inspectModule: (input) => moduleInspector.inspect(input),
    async write(name, site, modules, assets, hostModules) {
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
      await rm(scriptDirectory(name), { recursive: true, force: true });
      await rm(assetDirectory(name), { recursive: true, force: true });
    },

    async has(name, generation) {
      const active = await readActivation(activationPath);
      if (!(name in active)) return false;
      if (generation !== undefined && active[name] !== generation) return false;
      // A marker only records the generation the last successful reload
      // attempted to activate. Without an explicit process-readiness probe
      // there is no runtime truth to distinguish staged files from serving
      // traffic, so fail closed and discard the marker.
      if (options.isReady === undefined || !options.isReady()) {
        // A dead child or failed boot invalidates the activation marker. Remove
        // only the stale entry; other scripts may still have a live process.
        const next = { ...active };
        delete next[name];
        await writeActivation(activationPath, next);
        return false;
      }
      return true;
    },

    async probe(name, path, init) {
      let hostname: string;
      try {
        hostname = init.route === "events" ? eventHostname(name) : internalHostname(name);
      } catch {
        return null;
      }
      try {
        // This Host asking its own runtime, over loopback, by address. Where the
        // socket terminates TLS the certificate names the endpoint suffix and
        // not `127.0.0.1`, so verifying it here would refuse every publication
        // on a correctly configured machine; the connection never leaves this
        // host and the answer is authenticated by the publication it names.
        const response = await fetch(
          `${options.tls ? "https" : "http"}://127.0.0.1:${port}${path}`,
          {
            method: init.method,
            headers: { ...init.headers, host: hostname },
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
      const published = await readPublished(scriptsRoot, assetsRoot);
      if (published.length === 0) return [];
      await render(published);
      return published.map((entry) => entry.name);
    },

    async reload() {
      await render(await readPublished(scriptsRoot, assetsRoot));
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
async function writePrivate(path: string, contents: string, encoding: "utf8"): Promise<void> {
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
    await rename(temporary, path);
  } finally {
    if (!closed) await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
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

const SAFE_ASSET_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u;
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
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(active), "utf8");
  await rename(temporary, path);
}

interface Published {
  readonly name: string;
  readonly manifest: Manifest;
}

/**
 * Whether this publication runs through a generated entrypoint.
 *
 * The entrypoint identity is explicit. A retained manifest from the former
 * flat registry has no provenance layout and is rejected by readback rather
 * than silently serving with an open graph.
 */
function hasHostEntrypoint(entry: Published): boolean {
  return entry.manifest.hostEntrypoint !== undefined;
}

/** Exact private asset readback used before restart or configuration reload. */
async function readPublishedAssetSnapshot(
  root: string,
  value: unknown,
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
  for (const entry of Object.values(manifest.files)) {
    const bytes = await readFile(join(root, entry.key));
    if (bytes.byteLength !== entry.size || (await bytesDigest(bytes)) !== entry.digest) {
      throw new Error("unusable worker asset snapshot");
    }
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
  }
}

async function readPublishedModuleSnapshot(
  root: string,
  manifest: Manifest,
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
  await verifyStoredModuleDirectory(join(root, APPLICATION_MODULE_DIRECTORY), application);
  await verifyStoredModuleDirectory(join(root, HOST_PRIVATE_MODULE_DIRECTORY), hostPrivate);
  return { application, hostPrivate };
}

async function readPublished(
  scriptsRoot: string,
  assetsRoot: string,
): Promise<readonly Published[]> {
  const entries = await readdir(scriptsRoot, { withFileTypes: true }).catch(() => []);
  const published: Published[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const raw = await readFile(join(scriptsRoot, entry.name, MANIFEST), "utf8").catch(() => null);
    if (raw === null) continue;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(raw) as Manifest;
    } catch {
      continue;
    }
    if (
      typeof manifest.mainModule !== "string" ||
      (manifest.generation !== undefined && typeof manifest.generation !== "string")
    ) {
      continue;
    }
    // A manifest whose bindings cannot be rendered is not a script this process
    // will serve. Skipping it keeps one broken directory from taking every
    // other customer's site down with it on the next reload. Renderability is
    // proved here, not merely name validity: `capnpText` refuses a NUL or a
    // lone surrogate, and it is the only thing that stands between a torn or
    // tampered manifest and a `renderConfig` that throws for everyone.
    try {
      validModules([manifest.mainModule]);
      const declaredModules = validModules(manifest.modules ?? [], manifest.mainModule);
      validModuleMediaTypes(manifest.mainModule, declaredModules, manifest.moduleMediaTypes);
      const moduleFiles = await readPublishedModuleSnapshot(
        join(scriptsRoot, entry.name),
        manifest,
      );
      manifest = { ...manifest, moduleFiles };
      const assets = await readPublishedAssetSnapshot(
        join(assetsRoot, entry.name),
        manifest.assets,
      );
      if (assets) manifest = { ...manifest, assets };
      validBindings(manifest.vars ?? []);
      if (manifest.dataPlane !== undefined) validDataPlane(manifest.dataPlane);
      if (manifest.events !== undefined) validEventGate(manifest.events);
      internalHostname(entry.name);
      eventHostname(entry.name);
    } catch {
      continue;
    }
    published.push({ name: entry.name, manifest });
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

/**
 * The configuration, rendered whole.
 *
 * A router service in front, because workerd binds a socket to one service and
 * a platform needs many. The router holds a service binding per script and
 * picks by `Host`; anything unclaimed gets a 404 that says so, which is the
 * only honest answer when nobody has asked for that name.
 */
function renderConfig(
  published: readonly Published[],
  port: number,
  assetsRoot: string,
  tls?: WorkerdTlsKeypair,
): string {
  const services = published
    .map((entry) => {
      const bindings = [
        ...(entry.manifest.dataPlane
          ? [`(name = "${DATA_SERVICE_BINDING}", service = "${entry.name}-selfhost-data")`]
          : []),
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
      const declaredModules = validModules(entry.manifest.modules ?? [], entry.manifest.mainModule);
      const moduleMediaTypes = validModuleMediaTypes(
        mainModule,
        declaredModules,
        entry.manifest.moduleMediaTypes,
      );
      const applicationModules = entry.manifest.moduleFiles.application;
      const hostModules = entry.manifest.moduleFiles.hostPrivate;
      const hostEntrypoint = entry.manifest.hostEntrypoint;
      const orderedHostModules =
        hostEntrypoint === undefined
          ? hostModules
          : [
              requiredStoredModule(hostModules, hostEntrypoint),
              ...hostModules.filter((module) => module.name !== hostEntrypoint),
            ];
      const orderedModules =
        hostEntrypoint === undefined
          ? [
              ...applicationModules.map((module) => ({ module, role: "application" as const })),
              ...orderedHostModules.map((module) => ({ module, role: "hostPrivate" as const })),
            ]
          : [
              ...orderedHostModules.map((module) => ({ module, role: "hostPrivate" as const })),
              ...applicationModules.map((module) => ({ module, role: "application" as const })),
            ];
      const moduleList = orderedModules
        .map(({ module, role }) => {
          const mediaType =
            role === "application"
              ? (moduleMediaTypes?.[module.name] ?? "application/javascript+module")
              : "application/javascript+module";
          const provenanceDirectory =
            role === "application" ? APPLICATION_MODULE_DIRECTORY : HOST_PRIVATE_MODULE_DIRECTORY;
          return `(name = ${capnpText(module.name)}, ${workerdModuleKind(mediaType)} = embed ${capnpText(`${entry.name}/${provenanceDirectory}/${module.key}`)}, role = ${role})`;
        })
        .join(", ");
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
  const assetServices = published
    .filter((entry) => entry.manifest.assets)
    .map((entry) => {
      const assets = validAssetManifest(entry.manifest.assets);
      if (!assets) throw new Error("unusable worker asset manifest");
      return `  ( name = "${entry.name}-assets-files",
    disk = ( path = ${capnpText(join(assetsRoot, entry.name))}, writable = false )
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

  // One pair per script rather than one shared, so the configuration stays a
  // pure function of the manifests on disk: a script that binds no data plane
  // contributes neither service, and removing it removes both with it.
  //
  // The token is declared here and only here. The script's own service holds a
  // binding to this one and nothing else, so tenant code — by `env`, by
  // `cloudflare:workers`, or by any other route into its own isolate — has
  // nothing to find.
  const dataServices = published
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
      modules = [ (name = ${capnpText(plane.module)}, esModule = embed ${capnpText(`${entry.name}/${HOST_PRIVATE_MODULE_DIRECTORY}/${planeModule.key}`)}) ],
      bindings = [ ${facadeBindings} ],
      compatibilityDate = "2026-01-01",
    )
  ),
  ( name = "${entry.name}-selfhost-data-origin",
    external = ( address = ${capnpText(plane.address)}, http = () )
  ),`;
    })
    .join("\n");

  // One gate per script that receives events. It holds the token and the only
  // binding on this machine that names the script's event entrypoint; the
  // script itself is not reachable on the event hostname at all, and the
  // entrypoint the gate calls is a named export the router never addresses.
  const eventServices = published
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
      modules = [ (name = ${capnpText(gate.module)}, esModule = embed ${capnpText(`${entry.name}/${HOST_PRIVATE_MODULE_DIRECTORY}/${gateModule.key}`)}) ],
      bindings = [ ${gateBindings} ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  const routes = [
    ...published.flatMap((entry) =>
      entry.manifest.hostnames.map((hostname) => ({
        hostname,
        service: entry.manifest.assets ? `${entry.name}-asset-router` : entry.name,
      })),
    ),
    // Last, so a customer domain that happens to claim one of these names
    // cannot capture this Host's own probe for another script.
    // Every script published through a generated entrypoint, not only the ones
    // that bind a data plane: the entrypoint answers the readiness question and
    // a script this Host cannot ask is one it publishes without checking.
    ...published
      .filter((entry) => hasHostEntrypoint(entry))
      .map((entry) => ({ hostname: internalHostname(entry.name), service: entry.name })),
    ...published
      .filter((entry) => entry.manifest.events)
      .map((entry) => ({
        hostname: eventHostname(entry.name),
        service: `${entry.name}-selfhost-events`,
      })),
  ];
  const routeTable = JSON.stringify(Object.fromEntries(routes.map((r) => [r.hostname, r.service])));
  const bindings = [
    ...published.map((entry) => `      (name = "${entry.name}", service = "${entry.name}"),`),
    ...published
      .filter((entry) => entry.manifest.assets)
      .map(
        (entry) =>
          `      (name = "${entry.name}-asset-router", service = "${entry.name}-asset-router"),`,
      ),
    ...published
      .filter((entry) => entry.manifest.events)
      .map(
        (entry) =>
          `      (name = "${entry.name}-selfhost-events", service = "${entry.name}-selfhost-events"),`,
      ),
  ].join("\n");

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${services}
${assetServices}${dataServices === "" ? "" : `\n${dataServices}`}${eventServices === "" ? "" : `\n${eventServices}`}
  ( name = "router",
    worker = (
      modules = [ (name = "router.js", esModule = embed "router.js") ],
      bindings = [
        (name = "ROUTES", text = ${JSON.stringify(routeTable)}),
${bindings}
      ],
      compatibilityDate = "2026-01-01",
    )
  ),
  ],
  sockets = [ ${socket(port, tls)} ]
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
export const ROUTER_SOURCE = `export default {
  async fetch(request, env) {
    const host = new URL(request.url).hostname;
    const routes = JSON.parse(env.ROUTES);
    const service = routes[host];
    if (!service || !env[service]) {
      return new Response("no worker is published for " + host + "\\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return env[service].fetch(request);
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
 * from `notFoundHandling`, and the portable Worker Version path grammar decides
 * the latter.
 */
export const ASSETS_SOURCE = `const MISS_HEADER = "x-takoserver-selfhost-asset-miss";
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u;

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
  // The root is a valid missing path and may enter SPA fallback. Everywhere
  // else, an empty, dot, or repeated segment is invalid.
  if (path === "") return path;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  // A decoded runtime path still has to be a path a StaticAssetBundle manifest
  // could declare. Otherwise it is invalid, not a valid SPA miss.
  if (path.length > 240 || !SAFE_PATH.test(path)) return null;
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
