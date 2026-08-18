import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkerdRuntime, WorkerdSite } from "./providers/workerd.ts";

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
 */

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
}

interface Manifest {
  readonly mainModule: string;
  readonly hostnames: readonly string[];
  readonly assets?: { readonly notFoundHandling: string };
}

const MANIFEST = "takoserver-site.json";
/** Where a script's static files live inside its directory. */
const ASSETS_DIRECTORY = "__assets";

export function createWorkerdRuntime(options: WorkerdRuntimeOptions): WorkerdRuntime {
  const scriptsRoot = join(options.root, "workers");
  const configPath = options.configPath ?? join(scriptsRoot, "workerd.capnp");
  const port = options.port ?? 8788;

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
      await mkdir(directory, { recursive: true });

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

      // Written last. Until it exists the directory is not a script.
      await writeFile(
        join(directory, MANIFEST),
        JSON.stringify({
          mainModule: site.mainModule,
          hostnames: site.hostnames,
          ...(site.assets ? { assets: site.assets } : {}),
        }),
        "utf8",
      );
    },

    async remove(name) {
      await rm(scriptDirectory(name), { recursive: true, force: true });
    },

    async has(name) {
      const manifest = await readFile(join(scriptDirectory(name), MANIFEST), "utf8").catch(
        () => null,
      );
      return manifest !== null;
    },

    async reload() {
      const published = await readPublished(scriptsRoot);
      await mkdir(scriptsRoot, { recursive: true });
      // Written before the config that embeds it, every time, so a router
      // improvement reaches a deployment on its next reload rather than
      // whenever somebody remembers.
      await writeFile(join(scriptsRoot, "router.js"), ROUTER_SOURCE, "utf8");
      await writeFile(join(scriptsRoot, "assets.js"), ASSETS_SOURCE, "utf8");
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, renderConfig(published, port, scriptsRoot), "utf8");
      await options.onReload?.(configPath);
    },
  };
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
    if (typeof manifest.mainModule !== "string") continue;
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
      const assetBindings = entry.manifest.assets
        ? `\n      bindings = [ (name = "ASSETS", service = "${entry.name}-assets") ],`
        : "";
      return `  ( name = "${entry.name}",
    worker = (
      modules = [ (name = "${entry.manifest.mainModule}", esModule = embed "${entry.name}/${entry.manifest.mainModule}") ],${assetBindings}
      compatibilityDate = "2026-01-01",
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

  const routes = published.flatMap((entry) =>
    entry.manifest.hostnames.map((hostname) => ({ hostname, service: entry.name })),
  );
  const routeTable = JSON.stringify(Object.fromEntries(routes.map((r) => [r.hostname, r.service])));
  const bindings = published
    .map((entry) => `      (name = "${entry.name}", service = "${entry.name}"),`)
    .join("\n");

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${services}
${assetServices}
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
