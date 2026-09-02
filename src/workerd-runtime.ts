import { constants as fsConstants } from "node:fs";
import {
  chmod,
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

export interface WorkerdSite {
  /** Directory holding this script's modules. */
  readonly directory: string;
  readonly mainModule: string;
  readonly hostnames: readonly string[];
  /** Durable identity of the desired publication, including its routes. */
  readonly generation?: string;
  /**
   * How the asset layer answers a path that matches no file, when the script
   * declared assets. Absent means it declared none.
   */
  readonly assets?: { readonly notFoundHandling: string };
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
  /** Makes a published script's files present, replacing whatever was there. */
  write(
    name: string,
    site: WorkerdSite,
    modules: ReadonlyMap<string, Uint8Array>,
    assets?: ReadonlyMap<string, Uint8Array>,
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

export interface WorkerdRuntimeOptions {
  /** Directory holding scripts and the generated configuration. */
  readonly root: string;
  /**
   * Where the generated config is written. Kept beside the scripts by default,
   * because workerd resolves an `embed` relative to the config's own
   * directory — an absolute path is not read, and the failure arrives as a
   * startup error naming a file that plainly exists.
   */
  readonly configPath?: string;
  /** Port the router listens on. */
  readonly port?: number;
  /** Called after the config is rewritten, to make workerd read it. */
  readonly onReload?: (configPath: string) => Promise<void>;
  /** Runtime liveness/readiness truth for serving observations. */
  readonly isReady?: () => boolean;
}

interface Manifest {
  readonly mainModule: string;
  readonly hostnames: readonly string[];
  readonly generation?: string;
  readonly assets?: { readonly notFoundHandling: string };
  readonly vars?: readonly WorkerdBinding[];
  readonly modules?: readonly string[];
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
 * `disallow_importable_env` makes `import { env } from "cloudflare:workers"`
 * yield an empty object while the handler's own `env` argument keeps its
 * bindings. The facade service is what actually keeps the token away from
 * tenant code; this is the second lock on the same door, and it also stops a
 * tenant module reading the service binding the entrypoint holds.
 */
const DATA_PLANE_COMPATIBILITY_FLAGS = ["disallow_importable_env"] as const;
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
/** Where a script's static files live inside its directory. */
const ASSETS_DIRECTORY = "__assets";

export function createWorkerdRuntime(options: WorkerdRuntimeOptions): WorkerdRuntime {
  const scriptsRoot = join(options.root, "workers");
  const configPath = options.configPath ?? join(scriptsRoot, "workerd.capnp");
  const port = options.port ?? 8788;
  const activationPath = join(scriptsRoot, ".takoserver-active.json");

  const scriptDirectory = (name: string): string => {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(name)) {
      throw new Error(`unusable script name: ${name}`);
    }
    return join(scriptsRoot, name);
  };

  return {
    async write(name, site, modules, assets) {
      const directory = scriptDirectory(name);
      // Replaced rather than merged: a module the new bundle does not contain
      // must not survive from the old one, where it would be loadable and
      // wrong.
      await rm(directory, { recursive: true, force: true });
      await privateDirectory(scriptsRoot);
      await privateDirectory(directory);

      for (const [moduleName, bytes] of modules) {
        if (moduleName.includes("..") || moduleName.startsWith("/")) {
          throw new Error(`unusable module name: ${moduleName}`);
        }
        const path = join(directory, moduleName);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }

      for (const [assetName, bytes] of assets ?? []) {
        // Asset names come from a customer's bundle, so they are checked
        // against escaping the directory they are written into — the same rule
        // the object store applies to a key, for the same reason.
        if (assetName.includes("..") || assetName.startsWith("/")) {
          throw new Error(`unusable asset name: ${assetName}`);
        }
        const path = join(directory, ASSETS_DIRECTORY, assetName);
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
          hostnames: site.hostnames,
          ...(site.generation === undefined ? {} : { generation: site.generation }),
          ...(site.assets ? { assets: site.assets } : {}),
          ...(site.vars && site.vars.length > 0 ? { vars: validBindings(site.vars) } : {}),
          ...(site.modules && site.modules.length > 0
            ? { modules: validModules(site.modules) }
            : {}),
          ...(site.dataPlane ? { dataPlane: validDataPlane(site.dataPlane) } : {}),
          ...(site.events ? { events: validEventGate(site.events) } : {}),
        }),
        "utf8",
      );
    },

    async remove(name) {
      await rm(scriptDirectory(name), { recursive: true, force: true });
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
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: init.method,
          headers: { ...init.headers, host: hostname },
          ...(init.body === undefined ? {} : { body: init.body }),
          // A readiness question is answered by this Host's own module and is
          // over in milliseconds. An event runs a customer's handler, so the
          // caller says how long it is willing to wait for one.
          signal: AbortSignal.timeout(init.timeoutMillis ?? 2_000),
        });
        // Bounded because the answer is this Host's own small envelope and the
        // body on the other side of that router is a tenant's Worker.
        const body = (await response.text()).slice(0, 65_536);
        return { status: response.status, body };
      } catch {
        return null;
      }
    },

    async reload() {
      const published = await readPublished(scriptsRoot);
      await privateDirectory(scriptsRoot);
      for (const entry of published) await privateDirectory(join(scriptsRoot, entry.name));
      // Written before the config that embeds it, every time, so a router
      // improvement reaches a deployment on its next reload rather than
      // whenever somebody remembers.
      await writeFile(join(scriptsRoot, "router.js"), ROUTER_SOURCE, "utf8");
      await writeFile(join(scriptsRoot, "assets.js"), ASSETS_SOURCE, "utf8");
      await privateDirectory(dirname(configPath));
      // The rendered configuration contains every binding value, sensitive ones
      // included, so it is created `0600` and moved into place atomically.
      await writePrivate(configPath, renderConfig(published, port, scriptsRoot), "utf8");
      await options.onReload?.(configPath);
      // A staged manifest is not runtime truth. Only after the reload hook
      // returns successfully do we persist the generation actually activated;
      // a failed reload therefore leaves the previous marker intact.
      await writeActivation(
        activationPath,
        Object.fromEntries(
          published.map((entry) => [entry.name, entry.manifest.generation ?? null]),
        ),
      );
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
 * They come from a tenant's own bundle, so they are held to the same rule the
 * files were written under and to renderability, and a duplicate is refused
 * rather than silently shadowing the main module.
 */
function validModules(modules: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const name of modules) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 240 ||
      name.includes("..") ||
      name.startsWith("/") ||
      seen.has(name)
    ) {
      throw new Error("unusable worker module");
    }
    seen.add(name);
    capnpText(name);
  }
  return modules;
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

async function readPublished(scriptsRoot: string): Promise<readonly Published[]> {
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
      validBindings(manifest.vars ?? []);
      validModules(manifest.modules ?? []);
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

/**
 * The configuration, rendered whole.
 *
 * A router service in front, because workerd binds a socket to one service and
 * a platform needs many. The router holds a service binding per script and
 * picks by `Host`; anything unclaimed gets a 404 that says so, which is the
 * only honest answer when nobody has asked for that name.
 */
function renderConfig(published: readonly Published[], port: number, scriptsRoot: string): string {
  const services = published
    .map((entry) => {
      // A script that declared assets is given a binding to them, always. The
      // alternative is an asset layer the script cannot ask, which is the same
      // as having none: every path that is not an exact file reaches the
      // script, and `notFoundHandling` never applies.
      const bindings = [
        ...(entry.manifest.assets ? [`(name = "ASSETS", service = "${entry.name}-assets")`] : []),
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
      // The main module first, then whatever it imports. A generated entrypoint
      // is only an entrypoint because it is named here.
      const moduleList = [entry.manifest.mainModule, ...validModules(entry.manifest.modules ?? [])]
        .map(
          (name) =>
            `(name = ${capnpText(name)}, esModule = embed ${capnpText(`${entry.name}/${name}`)})`,
        )
        .join(", ");
      // Rendered only for a script published through a generated entrypoint, so
      // a script that binds no data plane produces the bytes it always did.
      const flagList =
        entry.manifest.dataPlane || entry.manifest.events
          ? `\n      compatibilityFlags = [ ${DATA_PLANE_COMPATIBILITY_FLAGS.map((flag) => capnpText(flag)).join(", ")} ],`
          : "";
      return `  ( name = "${entry.name}",
    worker = (
      modules = [ ${moduleList} ],${bindingList}
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
  // Files come off the disk through workerd's own directory service, and the
  // shim in front of it is what turns a miss into whatever the declaration
  // asked for. Serving index.html for an unmatched path is the whole reason a
  // single-page application survives a reload, and a bare directory service
  // cannot know that was wanted.
  const assetServices = published
    .filter((entry) => entry.manifest.assets)
    .map(
      (entry) => `  ( name = "${entry.name}-assets-files",
    disk = ( path = "${join(scriptsRoot, entry.name, ASSETS_DIRECTORY)}", writable = false )
  ),
  ( name = "${entry.name}-assets",
    worker = (
      modules = [ (name = "assets.js", esModule = embed "assets.js") ],
      bindings = [
        (name = "FILES", service = "${entry.name}-assets-files"),
        (name = "NOT_FOUND", text = "${entry.manifest.assets?.notFoundHandling ?? "none"}"),
      ],
      compatibilityDate = "2026-01-01",
    )
  ),`,
    )
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
      const facadeBindings = [
        `(name = "${DATA_PLANE_BINDING}", service = "${entry.name}-selfhost-data-origin")`,
        ...validBindings(plane.vars).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ].join(", ");
      return `  ( name = "${entry.name}-selfhost-data",
    worker = (
      modules = [ (name = ${capnpText(plane.module)}, esModule = embed ${capnpText(`${entry.name}/${plane.module}`)}) ],
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
      const gateBindings = [
        `(name = "${EVENT_TARGET_BINDING}", service = (name = ${capnpText(entry.name)}, entrypoint = "${EVENT_ENTRYPOINT}"))`,
        ...validBindings(gate.vars).map(
          (binding) =>
            `(name = ${capnpText(binding.name)}, ${binding.kind} = ${capnpText(binding.value)})`,
        ),
      ].join(", ");
      return `  ( name = "${entry.name}-selfhost-events",
    worker = (
      modules = [ (name = ${capnpText(gate.module)}, esModule = embed ${capnpText(`${entry.name}/${gate.module}`)}) ],
      bindings = [ ${gateBindings} ],
      compatibilityDate = "2026-01-01",
    )
  ),`;
    })
    .join("\n");

  const routes = [
    ...published.flatMap((entry) =>
      entry.manifest.hostnames.map((hostname) => ({ hostname, service: entry.name })),
    ),
    // Last, so a customer domain that happens to claim one of these names
    // cannot capture this Host's own probe for another script.
    ...published
      .filter((entry) => entry.manifest.dataPlane)
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
  sockets = [ ( name = "http", address = "*:${port}", http = (), service = "router" ) ]
);
`;
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
 * The asset layer, written beside the scripts so the config can embed it.
 *
 * workerd's directory service answers with a file or with nothing. What a site
 * needs on top of that is small and entirely about what a miss means: a
 * directory should serve its index, and an application that routes on the
 * client needs its shell served for paths no file will ever match. Cloudflare's
 * asset layer decides this from `notFoundHandling`, and a self-hosted
 * deployment that ignored it would 404 on every deep link — working in
 * production and broken on the operator's own machine is the worst arrangement
 * of the two.
 */
export const ASSETS_SOURCE = `const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  map: "application/json",
  wasm: "application/wasm",
};

function typeFor(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return TYPES[path.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

async function file(env, path) {
  // The directory service is addressed by path; the origin is arbitrary and
  // never leaves this worker.
  const response = await env.FILES.fetch("http://assets" + path, { method: "GET" });
  if (response.status !== 200) return null;
  // A directory answers 200 with a JSON listing of itself. That is exactly
  // distinguishable from a file, because the service never sniffs a type and
  // hands back every real file — .json included — as octet-stream. Serving
  // the listing would put the names of a customer's files on their homepage.
  if ((response.headers.get("content-type") ?? "").startsWith("application/json")) return null;
  return response;
}

function served(response, path, status) {
  const headers = new Headers(response.headers);
  // The directory service reports bytes, not what they mean. A stylesheet sent
  // as application/octet-stream is ignored by the browser, silently.
  headers.set("content-type", typeFor(path));
  return new Response(response.body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\\n", { status: 405 });
    }
    // What keeps a request inside the site is the directory service's own
    // root, not this: a path that climbs out simply is not found there. The
    // check is for the encodings URL parsing leaves alone, and it is cheap.
    let path = decodeURIComponent(url.pathname);
    if (path.includes("..")) return new Response("not found\\n", { status: 404 });

    const direct = await file(env, path);
    if (direct) return served(direct, path, 200);

    // A directory serves its index, with or without the trailing slash the
    // visitor happened to type.
    const index = path.endsWith("/") ? path + "index.html" : path + "/index.html";
    const inside = await file(env, index);
    if (inside) return served(inside, index, 200);

    if (env.NOT_FOUND === "single-page-application") {
      const shell = await file(env, "/index.html");
      // Status 200, because the application is what was found and it will
      // route the path itself. A 200 is what Cloudflare's asset layer returns
      // here, and a client router behind a 404 is a different product.
      if (shell) return served(shell, "/index.html", 200);
    }
    if (env.NOT_FOUND === "404-page") {
      const page = await file(env, "/404.html");
      if (page) return served(page, "/404.html", 404);
    }
    return new Response("not found\\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
`;
