import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const violations: string[] = [];

// ---------------------------------------------------------------------------
// Cross-product firewall: no Takosumi source, package, or path may be reached.
// ---------------------------------------------------------------------------

const forbidden = /(?:^|[/@])takosumi(?:-cloud)?(?:$|[/])/iu;
const roots = ["src", "scripts", "tests"];

for (const root of roots) {
  for (const path of walk(root)) {
    if (!path.endsWith(".ts")) continue;
    for (const specifier of importsOf(path)) {
      if (forbidden.test(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
  if (forbidden.test(name)) violations.push(`package.json: ${name}`);
}

// ---------------------------------------------------------------------------
// Layering: the architecture is only real if the import graph enforces it.
//
// Each layer names the layers it may import from. Domain code never reaches for
// an adapter — it receives ports instead — and only the composition root is
// allowed to know which implementations exist. Files that match no layer are
// pre-redesign modules; they are exempt until the milestone that deletes them,
// so the rule tightens on its own as the rewrite lands.
// ---------------------------------------------------------------------------

interface Layer {
  readonly name: string;
  readonly match: RegExp;
  readonly may: readonly string[];
}

const LAYERS: readonly Layer[] = [
  {
    name: "release-data",
    match: /^vendor\/takoform\/.*\.json$/u,
    may: ["release-data"],
  },
  {
    name: "core",
    match:
      /^src\/(?:ports|json|strict-json|form-ref|provider-port|ai-port|s3-port|db-schema|migrate-sqlite)\.ts$/u,
    may: ["core"],
  },
  {
    name: "adapter",
    match:
      /^src\/(?:sql-d1|sql-d1-http|sql-sqlite|objects-r2|objects-r2-http|objects-mem|objects-fs)\.ts$|^src\/workerd-(?:runtime|supervisor)\.ts$|^src\/providers\//u,
    may: ["core", "adapter"],
  },
  {
    name: "domain",
    match:
      /^src\/(?:token|auth|ledger|catalog|reseller|metering|provider-driver|reconcile|metering|edge-forms|ai-requests|operator-credentials|google-identity|identity-setup|stripe-settlement|signing-key|operator-key)\.ts$|^src\/takoform\/(?!routes\.ts$|host\.ts$)/u,
    may: ["core", "domain", "release-data"],
  },
  {
    name: "routes",
    match:
      /^src\/(?:router|control|data-storage|data-ai|openapi|landing|data-objects|provisioner-endpoint)\.ts$|^src\/takoform\/(?:routes|host)\.ts$/u,
    may: ["core", "adapter", "domain", "routes"],
  },
  {
    name: "app",
    // `payment-setup` builds the shape the routes layer asks for, which makes
    // it composition rather than domain: it is allowed to know both halves.
    match: /^src\/(?:app|payment-setup)\.ts$/u,
    may: ["core", "adapter", "domain", "routes", "app"],
  },
  // An entry chooses concrete implementations — that is its whole job. What it
  // may not do is reach something its host cannot support, which the
  // host-only ban below enforces per entry rather than by tier.
  {
    name: "entry",
    match: /^src\/entry-[^/]+\.ts$/u,
    may: ["core", "adapter", "domain", "routes", "app"],
  },
];

function layerOf(path: string): Layer | undefined {
  return LAYERS.find((layer) => layer.match.test(path));
}

for (const path of walk("src")) {
  if (!path.endsWith(".ts")) continue;
  const layer = layerOf(path);
  if (!layer) continue;
  for (const target of localImportsOf(path)) {
    const targetLayer = layerOf(target);
    if (!targetLayer) {
      violations.push(`${path} (${layer.name}) imports pre-redesign module ${target}`);
      continue;
    }
    if (!layer.may.includes(targetLayer.name)) {
      violations.push(
        `${path} (${layer.name}) imports ${target} (${targetLayer.name}); ` +
          `${layer.name} may import only ${layer.may.join(", ")}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Bundle hygiene: the Workers entry must not be able to reach a host-only
// implementation, even indirectly. `scripts/build-worker.ts` checks the emitted
// bytes; this checks the graph, so the mistake is caught before a build.
// ---------------------------------------------------------------------------

const WORKER_ENTRY = "src/entry-worker.ts";
const HOST_ONLY = [
  "src/sql-sqlite.ts",
  "src/objects-mem.ts",
  // A Worker has no filesystem. Reaching this would fail at runtime rather
  // than at the gate, and only for the requests that touched it.
  "src/objects-fs.ts",
  // Writing files and starting processes: a Worker can do neither.
  "src/workerd-runtime.ts",
  "src/workerd-supervisor.ts",
  // The Worker has D1 and R2 bindings. A credential-bearing HTTP transport is
  // not a capability it needs, and a capability nothing needs is one worth
  // refusing — see docs/adr/0001-provision-from-the-worker.md, which permits
  // the Cloudflare provider here and keeps these two out.
  "src/sql-d1-http.ts",
  "src/objects-r2-http.ts",
];

if (existsSync(WORKER_ENTRY)) {
  const reachable = new Set<string>();
  const pending = [WORKER_ENTRY];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || reachable.has(path)) continue;
    reachable.add(path);
    pending.push(...localImportsOf(path));
  }
  for (const banned of HOST_ONLY) {
    if (reachable.has(banned)) {
      violations.push(`${WORKER_ENTRY} transitively imports host-only module ${banned}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`forbidden imports found:\n${violations.join("\n")}`);
  process.exit(1);
}

/**
 * Every module specifier a file names. The bare side-effect form (`import
 * "./x.ts"`) is matched too: it carries a real edge in the graph, and a rule
 * that misses it can be stepped around without noticing.
 */
function importsOf(path: string): readonly string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/(?:from\s+|import\s*\(|import\s+)(["'])([^"']+)\1/gu)]
    .map((match) => match[2])
    .filter((specifier): specifier is string => specifier !== undefined);
}

/** Repository-relative paths of the in-repo modules a file imports. */
function localImportsOf(path: string): readonly string[] {
  return importsOf(path)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => normalize(relative(resolve("."), resolve(dirname(path), specifier))));
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
