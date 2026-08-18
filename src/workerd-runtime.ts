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
}

const MANIFEST = "takoserver-site.json";

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
    async write(name, site, modules) {
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

      // Written last. Until it exists the directory is not a script.
      await writeFile(
        join(directory, MANIFEST),
        JSON.stringify({ mainModule: site.mainModule, hostnames: site.hostnames }),
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
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, renderConfig(published, port), "utf8");
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
function renderConfig(published: readonly Published[], port: number): string {
  const services = published
    .map(
      (entry) => `  ( name = "${entry.name}",
    worker = (
      modules = [ (name = "${entry.manifest.mainModule}", esModule = embed "${entry.name}/${entry.manifest.mainModule}") ],
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
