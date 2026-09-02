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
    match:
      /^(?:vendor\/takoform\/.*\.json|src\/generated\/takoform-(?:stable-v1-catalog|integration-form-packages|publisher-set-receipt|publisher-set-authority-closure)\.ts)$/u,
    may: ["release-data"],
  },
  {
    name: "core",
    match:
      /^src\/(?:ports|json|strict-json|public-host-identity|form-ref|interface-ref|provider-port|provider-meter-port|provider-runtime-input-port|provider-worker-endpoint-origin|ai-port|database|database-schema|db-schema|migrate-sqlite)\.ts$/u,
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
      /^src\/(?:token|auth|ledger|catalog|catalog-compiler|reseller|metering|provider-driver|provider-pack|provider-metering|provider-placement|provider-runtime-bindings|resource-deployments|resource-migrations|runtime-input-preparations|worker-endpoint-origin-reservations|attachments|reconcile|metering|edge-forms|ai-requests|operator-credentials|integration-e2e-credential-authority|form-authority-operator-proof|google-identity|takos-id-identity|identity-setup|stripe-settlement|signing-key|operator-key)\.ts$|^src\/takoform\/(?!routes\.ts$|host\.ts$|host-admission-endpoint\.ts$|integration-operator-endpoint\.ts$)/u,
    may: ["core", "domain", "release-data"],
  },
  {
    name: "routes",
    match:
      /^src\/(?:router|control|data-storage|data-ai|openapi|landing|provisioner-endpoint|sponsorship-api)\.ts$|^src\/takoform\/(?:routes|host)\.ts$/u,
    may: ["core", "adapter", "domain", "routes"],
  },
  {
    name: "app",
    // `payment-setup` builds the shape the routes layer asks for, which makes
    // it composition rather than domain: it is allowed to know both halves.
    match:
      /^src\/(?:app|cloudflare-runtime-binding-materializer|deployment-composition|form-authority-(?:identity-probe|public-identity|worker-composition)|integration-form-authority-gateway|hosted-(?:object-bucket|edge)-supplies|object-bucket-deployment|payment-setup|public-form-(?:implementation-build|runtime)|public-worker-implementation|runtime-input-seal-keyring|selfhost-composition|selfhost-data-planes|standalone-provider-composition|worker-data-services|worker-(?:production|stable-local)-composition)\.ts$|^src\/takoform\/(?:host-admission-endpoint|integration-operator-endpoint)\.ts$/u,
    may: ["core", "adapter", "domain", "routes", "app", "release-data"],
  },
  // An entry chooses concrete implementations — that is its whole job. What it
  // may not do is reach something its host cannot support, which the
  // host-only ban below enforces per entry rather than by tier.
  {
    name: "entry",
    match: /^src\/entry-[^/]+\.ts$/u,
    // A runtime-specific wrapper may re-export the host-independent entry it
    // adapts (for example Cloudflare's WorkerEntrypoint intrinsic). Both remain
    // composition roots and the host-only graph checks below still apply.
    may: ["core", "adapter", "domain", "routes", "app", "entry"],
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

const WORKER_ENTRY = "src/entry-cloudflare-worker.ts";
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
  const reachable = reachableFrom([WORKER_ENTRY]);
  for (const banned of HOST_ONLY) {
    if (reachable.has(banned)) {
      violations.push(`${WORKER_ENTRY} transitively imports host-only module ${banned}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Form authority separation: every customer/public graph is reader-only. The
// route-less service-binding Workers are the only graphs allowed to reach the
// admission writer and package store.
// ---------------------------------------------------------------------------

const PUBLIC_READER_ENTRIES = [
  "src/entry-bun.ts",
  "src/entry-cloudflare-worker.ts",
  "src/entry-worker.ts",
  "src/router.ts",
  "src/openapi.ts",
  "src/entry-public-form-runtime-payload.ts",
];
const FORM_AUTHORITY_ENTRIES = [
  "src/entry-form-authority-worker.ts",
  "src/entry-integration-form-authority-worker.ts",
];
const FORM_AUTHORITY_OPERATOR_GATEWAY_ENTRIES = [
  "src/entry-integration-form-authority-operator-worker.ts",
  "src/entry-form-authority-identity-probe.ts",
];
const FORM_AUTHORITY_WRITERS = [
  "src/takoform/admission-store.ts",
  "src/takoform/admission.ts",
  "src/takoform/form-packages.ts",
];
const FORM_AUTHORITY_RPC_MODULES = [
  "src/form-authority-operator-proof.ts",
  "src/form-authority-public-identity.ts",
  "src/form-authority-worker-composition.ts",
  "src/takoform/host-admission-coordinator.ts",
  "src/takoform/host-admission-endpoint.ts",
  "src/takoform/form-authority-verification.ts",
  "src/takoform/integration-operator-endpoint.ts",
];

for (const entry of PUBLIC_READER_ENTRIES.filter(existsSync)) {
  const reachable = reachableFrom([entry]);
  for (const writer of [...FORM_AUTHORITY_WRITERS, ...FORM_AUTHORITY_RPC_MODULES]) {
    if (reachable.has(writer)) {
      violations.push(`${entry} transitively imports private Form authority module ${writer}`);
    }
  }
}

for (const entry of FORM_AUTHORITY_ENTRIES.filter(existsSync)) {
  const reachable = reachableFrom([entry]);
  for (const writer of FORM_AUTHORITY_WRITERS) {
    if (!reachable.has(writer)) {
      violations.push(`${entry} does not reach required Form authority module ${writer}`);
    }
  }
  for (const route of ["src/app.ts", "src/router.ts", "src/openapi.ts"]) {
    if (reachable.has(route)) {
      violations.push(`${entry} transitively imports public route module ${route}`);
    }
  }
}

for (const entry of FORM_AUTHORITY_OPERATOR_GATEWAY_ENTRIES.filter(existsSync)) {
  const reachable = reachableFrom([entry]);
  for (const writer of FORM_AUTHORITY_WRITERS) {
    if (reachable.has(writer)) {
      violations.push(`${entry} transitively imports Form authority storage writer ${writer}`);
    }
  }
  for (const route of ["src/app.ts", "src/router.ts", "src/openapi.ts"]) {
    if (reachable.has(route)) {
      violations.push(`${entry} transitively imports customer/public route module ${route}`);
    }
  }
}

if (existsSync("src/entry-form-authority-worker.ts")) {
  const production = reachableFrom(["src/entry-form-authority-worker.ts"]);
  for (const fixture of [
    "src/takoform/integration-operator-endpoint.ts",
    "src/generated/takoform-integration-form-packages.ts",
  ]) {
    if (production.has(fixture)) {
      violations.push(`production Form authority Worker imports integration fixture ${fixture}`);
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

function reachableFrom(entries: readonly string[]): ReadonlySet<string> {
  const reachable = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || reachable.has(path) || !existsSync(path)) continue;
    reachable.add(path);
    pending.push(...localImportsOf(path));
  }
  return reachable;
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
