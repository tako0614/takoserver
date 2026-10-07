import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const violations: string[] = [];

// ---------------------------------------------------------------------------
// Cross-product firewall: no Takosumi source, package, or path may be reached.
// ---------------------------------------------------------------------------

const forbidden =
  /(?:^|[/@])takosumi(?:-cloud)?(?:$|[/])|(?:^|[/@])takoserver-private(?:$|[/])|^@takoserver\/private-/iu;
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
// allowed to know which implementations exist.
//
// Every module under `src` must match exactly one layer. An unmatched file used
// to be silently exempt as "pre-redesign", which meant the rule could be
// escaped by adding a module rather than by classifying one — the gate answered
// "no violation" for a file it had never looked at. A module the architecture
// has no name for is now a violation, so the only way past this gate is to say
// where the module belongs. Ambient declaration files (`*.d.ts`) declare types
// for code elsewhere and are not modules in the graph, so they are skipped
// before the classification, not exempted after it.
// ---------------------------------------------------------------------------

interface Layer {
  readonly name: string;
  readonly match: RegExp;
  readonly may: readonly string[];
}

const LAYERS: readonly Layer[] = [
  // v2 shares neutral primitives, not the v1 package/admission domain. Keep
  // these edges explicit so a protocol translator cannot enter unnoticed.
  {
    name: "v2-extension",
    match: /^src\/takoform-v2\/index\.ts$/u,
    may: [
      "core",
      "v2-contract",
      "v2-private",
      "v2-state",
      "v2-form",
      "v2-code-validation",
      "v2-runtime",
    ],
  },
  {
    name: "v2-private",
    match: /^src\/takoform-v2\/(?:private-inputs|configured-private-inputs)\.ts$/u,
    may: ["core"],
  },
  {
    name: "v2-contract",
    match: /^src\/takoform-v2\/(?:types|identity|references)\.ts$/u,
    may: ["core", "v2-contract", "v2-private"],
  },
  {
    name: "v2-state",
    match: /^src\/takoform-v2\/(?:store|worker-invocation-custody)\.ts$/u,
    may: ["core", "v2-contract", "v2-private"],
  },
  {
    name: "v2-form",
    match: /^src\/takoform-v2\/forms\/[^/]+\.ts$/u,
    may: ["core", "v2-contract", "v2-form"],
  },
  {
    name: "v2-code-validation",
    match:
      /^src\/takoform-v2\/(?:worker-code-eligibility|worker-material-validation|worker-service-resolution|worker-version-configured-inputs)\.ts$/u,
    // Eligibility accepts a host-supplied semantic inspector. Its adapter
    // contract is imported as a type only; this layer never loads an adapter.
    may: ["core", "v2-form", "v2-code-validation"],
  },
  {
    name: "v2-queue-bridge",
    match: /^src\/takoform-v2\/worker-queue-settlement\.ts$/u,
    may: ["domain"],
  },
  {
    name: "v2-runtime",
    match:
      /^src\/takoform-v2\/(?:worker-bundle-runtime|worker-code-runtime|worker-cron-trigger-backend|worker-cron-trigger-scheduler|worker-deployment-backend|worker-endpoint-backend|worker-lifecycle-backend|worker-runtime-readers|worker-publication-state|worker-publication-sql-guard|worker-static-runtime|worker-static-publication|worker-native-effects|worker-native-deletions)\.ts$|^src\/workerd-worker-runtime-owner\.ts$/u,
    may: [
      "core",
      "v2-contract",
      "v2-state",
      "v2-form",
      "v2-code-validation",
      "v2-runtime",
      "adapter",
    ],
  },
  {
    name: "v2-engine",
    match: /^src\/takoform-v2\/engine\.ts$/u,
    may: ["core", "v2-contract", "v2-private", "v2-state"],
  },
  {
    name: "v2-http",
    match: /^src\/takoform-v2\/routes\.ts$/u,
    may: ["core", "v2-contract", "v2-private", "v2-engine"],
  },
  {
    name: "v2-host",
    match: /^src\/takoform-v2\/host\.ts$/u,
    may: ["v2-contract", "v2-engine", "v2-http"],
  },
  {
    name: "v2-accounts",
    match: /^src\/takoform-v2\/accounts\.ts$/u,
    may: ["core", "domain", "v2-http"],
  },
  {
    name: "v2-config",
    match: /^src\/takoform-v2\/config\.ts$/u,
    may: ["core", "v2-contract", "v2-form"],
  },
  {
    name: "v2-application",
    match: /^src\/takoform-v2\/application\.ts$/u,
    may: [
      "core",
      "domain",
      "v2-contract",
      "v2-private",
      "v2-config",
      "v2-accounts",
      "v2-form",
      "v2-host",
    ],
  },
  {
    name: "v2-documentation",
    match: /^src\/takoform-v2\/openapi\.ts$/u,
    may: [],
  },
  {
    name: "app",
    match: /^src\/selfhost-takoform-v2-ingress\.ts$/u,
    may: ["v2-contract"],
  },
  {
    name: "release-data",
    match:
      /^(?:vendor\/takoform\/.*\.json|src\/generated\/takoform-(?:stable-v1-catalog|stable-error-taxonomy|integration-form-packages|publisher-set-receipt|publisher-set-authority-closure)\.ts)$/u,
    may: ["release-data"],
  },
  {
    name: "core",
    match:
      /^src\/(?:ports|json|strict-json|artifact-path|cron|error-envelope|route-table|request-lifetime|public-host-identity|form-ref|interface-ref|actor-abi-ref|standard-service-port|worker-class-runtime-port|worker-module-inspection-contract|provider-port|provider-meter-port|provider-runtime-input-port|provider-worker-endpoint-origin|ai-port|database|database-schema|db-schema|migrate-sqlite|vector-index-codec)\.ts$|^src\/takoform\/limits\.ts$/u,
    // Frozen published data sits below every layer: it is bytes a release
    // pinned, not a decision any layer here may make. The wire error taxonomy
    // this Host answers by is exactly that.
    may: ["core", "release-data"],
  },
  {
    name: "adapter",
    match:
      /^src\/(?:sql-d1|sql-d1-http|sql-sqlite|objects-r2|objects-r2-http|objects-mem|objects-fs|selfhost-weighted-deployment|selfhost-actor-class-runtime|selfhost-actor-forward-worker-wrapper|selfhost-workflow-binding-worker-wrapper|workflow-transport-journal|vector-index-store)\.ts$|^src\/workerd-(?:artifact|execution-guard|linux-process|runtime|supervisor|version-graph|worker-execution-group|worker-module-inspector)\.ts$|^src\/generated\/(?:actor-native-bootstrap|selfhost-actor-forward-runtime-source|selfhost-workflow-binding-runtime-source)\.ts$|^src\/providers\//u,
    may: ["core", "adapter"],
  },
  {
    name: "domain",
    match:
      /^src\/(?:token|auth|ledger|catalog|catalog-compiler|reseller|metering|provider-driver|provider-pack|provider-metering|provider-placement|provider-runtime-bindings|resource-deployments|resource-execution-evidence|resource-migrations|runtime-input-preparations|queue-custody|actor-class-execution|actor-class-candidate-inspection|actor-resource-graph|worker-endpoint-origin-reservations|selfhost-actor-contract-closure|workflow-instances|workflow-resource-graph|workflow-resource-lifecycle|workflow-data|workflow-driver|workflow-execution|workflow-due-scheduler|workflow-class-execution|workflow-execution-host|artifact-consumer-repair|artifact-recovery|artifact-recovery-owner-gc|exact-artifact-recovery-operator-proof|attachments|reconcile|metering|edge-forms|ai-requests|operator-credentials|integration-e2e-credential-authority|integration-organization-bootstrap|sponsorship-authority|sponsorship-credential|sponsorship-issuance-receipt|tenant-run-credential|tenant-run-principal|form-authority-operator-proof|google-identity|takos-id-identity|identity-setup|stripe-settlement|signing-key|operator-key|ed25519-private-jwk|runtime-grants|takoform-released-provider)\.ts$|^src\/takoform\/(?!routes\.ts$|host\.ts$|host-admission-endpoint\.ts$|integration-operator-endpoint\.ts$|integration-actor-(?:host|form-authority)\.ts$)/u,
    may: ["core", "domain", "release-data"],
  },
  {
    name: "routes",
    match:
      /^src\/(?:router|control|data-storage|data-ai|openapi|landing|provisioner-endpoint)\.ts$|^src\/takoform\/(?:routes|host)\.ts$/u,
    may: ["core", "adapter", "domain", "routes", "v2-documentation"],
  },
  {
    name: "app",
    // `payment-setup` builds the shape the routes layer asks for, which makes
    // it composition rather than domain: it is allowed to know both halves.
    match:
      /^src\/(?:app|actor-addressing(?:-source)?|actor-upgrade-handoff(?:-source)?|actor-namespace-facade(?:-source)?|actor-native-(?:class-execution|owner-worker|bootstrap-entry|bootstrap-source)|selfhost-actor-(?:execution-host|native-process|upgrade-broker|http-broker|forward-runtime(?:-entry)?|forward-worker-wrapper|forward-brokers|public-runtime)|compat|cloudflare-provider-surface|cloudflare-runtime-binding-materializer|deployment-composition|exact-artifact-recovery-worker|existing-space-operator(?:-proof)?|form-authority-(?:identity-probe|public-identity|worker-composition)|integration-form-authority-gateway|hosted-(?:object-bucket|edge)-supplies|object-bucket-deployment|payment-setup|public-form-(?:implementation-build|runtime)|public-host-form-source|public-worker-implementation|runtime-input-seal-keyring|selfhost-composition|selfhost-container-(?:bootstrap|endpoint-(?:ingress|https))|selfhost-data-planes|selfhost-entry-shutdown|selfhost-form-authority-composition|selfhost-health|selfhost-object-store|selfhost-queue-pump|selfhost-runtime-binding-materializer|selfhost-scheduler|selfhost-startup-instructions|selfhost-tenant-run-credentials|selfhost-workflow-binding-(?:broker|runtime-entry)|selfhost-workflow-execution-host|selfhost-workflow-http-transport|selfhost-workflow-preparation|selfhost-workflow-private-owner|selfhost-workflow-serving|workerd-workflow-preparation|workflow-http-bootstrap-entry|workflow-http-controller|workflow-http-worker|standalone-provider-composition|worker-data-services|worker-(?:production|stable-local)-composition)\.ts$|^src\/generated\/(?:workflow-http-bootstrap|actor-upgrade-handoff-source|actor-namespace-facade-source|actor-addressing-source)\.ts$|^src\/takoform\/(?:host-admission-endpoint|integration-operator-endpoint)\.ts$/u,
    may: [
      "core",
      "adapter",
      "domain",
      "routes",
      "app",
      "release-data",
      "v2-application",
      "v2-config",
      "v2-contract",
      "v2-private",
    ],
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
    may: ["core", "adapter", "domain", "routes", "app", "entry", "v2-config"],
  },
  // The published package surface re-exports the product for an embedder. It
  // states no policy of its own, so it may name anything a consumer is allowed
  // to construct — but it stays below `entry`, which owns a running process.
  {
    name: "package-surface",
    match:
      /^src\/(?:index|provider-extension|workflow-runtime|workflow-runtime-workerd)\.ts$|^src\/takoform\/integration-actor-(?:host|form-authority)\.ts$/u,
    may: ["core", "adapter", "domain", "routes", "app", "package-surface"],
  },
];

function layerOf(path: string): Layer | undefined {
  // Unpublished source projections are domain inputs, not released data or
  // authority bundles. Their presence cannot confer publisher verification.
  if (path === "src/generated/takoform-forward-candidate-catalog.ts") {
    return LAYERS.find((layer) => layer.name === "domain");
  }
  return LAYERS.find((layer) => layer.match.test(path));
}

for (const path of walk("src")) {
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) continue;
  const layer = layerOf(path);
  if (!layer) {
    violations.push(
      `${path} matches no declared layer; classify it in scripts/check-imports.ts ` +
        `before the import graph can be checked for it`,
    );
    continue;
  }
  for (const target of localImportsOf(path)) {
    const targetLayer = layerOf(target);
    if (!targetLayer) {
      violations.push(`${path} (${layer.name}) imports unclassified module ${target}`);
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
// Bundle hygiene: a Workers entry must not be able to reach a host-only
// implementation, even indirectly. The Worker build scripts check emitted
// bytes; this checks the graph, so the mistake is caught before a build.
// ---------------------------------------------------------------------------

const WORKER_ENTRIES = walk("src").filter((path) =>
  /^src\/entry-(?:[^/]+-)?worker\.ts$/u.test(path),
);
const HOST_ONLY = [
  "src/sql-sqlite.ts",
  "src/objects-mem.ts",
  // A Worker has no filesystem. Reaching this would fail at runtime rather
  // than at the gate, and only for the requests that touched it.
  "src/objects-fs.ts",
  // Writing files and starting processes: a Worker can do neither.
  "src/workerd-runtime.ts",
  "src/workerd-supervisor.ts",
  "src/workerd-linux-process.ts",
  "src/workerd-worker-execution-group.ts",
  "src/workerd-worker-runtime-owner.ts",
  // Health dispatch observes the Bun process's private startup-restore and
  // workerd-supervisor lifecycle; it is not a Worker health route.
  "src/selfhost-health.ts",
  "src/selfhost-entry-shutdown.ts",
  "src/workerd-worker-module-inspector.ts",
  "src/workerd-artifact.ts",
  "src/workerd-execution-guard.ts",
  "src/selfhost-workflow-execution-host.ts",
  "src/selfhost-actor-execution-host.ts",
  "src/selfhost-actor-public-runtime.ts",
  "src/selfhost-form-authority-composition.ts",
  "src/selfhost-startup-instructions.ts",
  "src/selfhost-actor-native-process.ts",
  "src/selfhost-workflow-preparation.ts",
  "src/selfhost-workflow-private-owner.ts",
  "src/selfhost-workflow-binding-broker.ts",
  "src/selfhost-workflow-serving.ts",
  "src/selfhost-workflow-http-transport.ts",
  "src/providers/docker-http-revision.ts",
  "src/providers/selfhost-container-lifecycle.ts",
  "src/providers/selfhost-container-runtime.ts",
  "src/providers/selfhost-container-endpoint.ts",
  "src/selfhost-container-bootstrap.ts",
  "src/selfhost-container-endpoint-ingress.ts",
  "src/selfhost-container-endpoint-https.ts",
  // The public Worker has D1 and R2 bindings. Credential-bearing HTTP
  // transports and the real Cloudflare provider belong only to the route-less
  // executor; see docs/adr/0001-provision-from-the-worker.md.
  "src/sql-d1-http.ts",
  "src/objects-r2-http.ts",
];

for (const entry of WORKER_ENTRIES) {
  const reachable = reachableFrom([entry]);
  for (const banned of HOST_ONLY) {
    if (reachable.has(banned)) {
      violations.push(`${entry} transitively imports host-only module ${banned}`);
    }
  }
  // Public supply may not hold a parent-provider implementation. Route-less
  // authority Workers use the existing Cloudflare Form runtime to inspect
  // handler coverage, so this narrower rule remains on the public entry.
  if (entry !== "src/entry-cloudflare-worker.ts" && entry !== "src/entry-worker.ts") continue;
  for (const banned of [
    "src/providers/cloudflare.ts",
    "src/providers/cloudflare-provider-executor-rpc.ts",
    "src/providers/cloudflare-wfp-backend.ts",
    "src/providers/cloudflare-wfp-client.ts",
    "src/providers/cloudflare-worker-backend.ts",
    "src/providers/cloudflare-edge-meter.ts",
    "src/providers/cloudflare-r2-meter.ts",
    "src/providers/wasabi.ts",
    "src/providers/wasabi-meter.ts",
  ]) {
    if (reachable.has(banned)) {
      violations.push(`${entry} transitively imports private parent-provider module ${banned}`);
    }
  }
  for (const path of reachable) {
    const source = readFileSync(path, "utf8");
    for (const forbidden of [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "TAKOSERVER_WASABI_ACCESS_KEY_ID",
      "TAKOSERVER_WASABI_SECRET_ACCESS_KEY",
    ]) {
      if (source.includes(forbidden)) {
        violations.push(`${entry} reaches ${path}, which names private ${forbidden}`);
      }
    }
  }
}

// WfP implementation and its process entries belong to takoserver-private.
// This checks type-only imports too: an erased edge still couples the OSS
// adapter/self-host source to a non-public implementation. Shared contracts,
// pure helpers, and historical migrations remain in this repository.
const PRIVATE_WFP_MODULE =
  /(?:^|\/)(?:cloudflare-wfp-[^/]+|cloudflare-managed-(?:worker|object)-[^/]+|managed-worker-state|cloudflare-provider-executor-rpc|entry-cloudflare-(?:provider-executor|managed-worker-gateway|managed-object-receipt-authority))\.ts$/u;
for (const root of roots) {
  for (const path of walk(root)) {
    if (!path.endsWith(".ts")) continue;
    if (root === "src" && PRIVATE_WFP_MODULE.test(path)) {
      violations.push(`${path} is a private WfP implementation; its owner is takoserver-private`);
    }
    for (const specifier of importsOf(path)) {
      if (PRIVATE_WFP_MODULE.test(specifier)) {
        violations.push(`${path} imports private WfP implementation ${specifier}`);
      }
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
  "src/entry-existing-space-operator-worker.ts",
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

const SPONSORSHIP_AUTHORITY_ENTRY = "src/entry-sponsorship-authority-worker.ts";
const PUBLIC_WORKER_ENTRIES = ["src/entry-cloudflare-worker.ts", "src/entry-worker.ts"];

for (const entry of PUBLIC_WORKER_ENTRIES.filter(existsSync)) {
  const reachable = reachableFrom([entry]);
  for (const signer of [
    "src/sponsorship-credential.ts",
    "src/tenant-run-credential.ts",
    "src/selfhost-tenant-run-credentials.ts",
  ]) {
    if (reachable.has(signer)) {
      violations.push(`${entry} transitively imports private tenant-run signer ${signer}`);
    }
  }
}

for (const entry of PUBLIC_READER_ENTRIES.filter(existsSync)) {
  const reachable = reachableFrom([entry]);
  if (
    reachable.has("src/sponsorship-authority.ts") ||
    reachable.has("src/sponsorship-issuance-receipt.ts") ||
    reachable.has("src/sponsorship-credential.ts")
  ) {
    violations.push(`${entry} transitively imports private sponsorship authority`);
  }
  for (const writer of [...FORM_AUTHORITY_WRITERS, ...FORM_AUTHORITY_RPC_MODULES]) {
    if (reachable.has(writer)) {
      violations.push(`${entry} transitively imports private Form authority module ${writer}`);
    }
  }
}

if (existsSync(SPONSORSHIP_AUTHORITY_ENTRY)) {
  const reachable = reachableFrom([SPONSORSHIP_AUTHORITY_ENTRY]);
  for (const required of [
    "src/sponsorship-authority.ts",
    "src/sponsorship-credential.ts",
    "src/sponsorship-issuance-receipt.ts",
    "src/tenant-run-credential.ts",
    "src/sql-d1.ts",
    "src/token.ts",
  ]) {
    if (!reachable.has(required)) {
      violations.push(`${SPONSORSHIP_AUTHORITY_ENTRY} does not reach required ${required}`);
    }
  }
  for (const forbidden of [
    "src/app.ts",
    "src/router.ts",
    "src/openapi.ts",
    "src/reseller.ts",
    "src/integration-e2e-credential-authority.ts",
    ...FORM_AUTHORITY_WRITERS,
    ...FORM_AUTHORITY_RPC_MODULES,
  ]) {
    if (reachable.has(forbidden)) {
      violations.push(
        `${SPONSORSHIP_AUTHORITY_ENTRY} transitively imports unrelated authority ${forbidden}`,
      );
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

// ---------------------------------------------------------------------------
// One-shot artifact recovery separation. Customer/public entries cannot reach
// it. The existing owner-authenticated gateway may carry only the signed RPC
// proof and service binding; only the route-less target owns D1/R2 adapters and
// the exact recovery coordinator.
// ---------------------------------------------------------------------------

const EXACT_RECOVERY_ENTRY = "src/entry-exact-artifact-recovery-worker.ts";
const EXACT_RECOVERY_PRIVATE_MODULES = [
  "src/artifact-recovery.ts",
  "src/artifact-recovery-owner-gc.ts",
  "src/exact-artifact-recovery-worker.ts",
  "src/takoform/exact-artifact-recovery-coordinator.ts",
];
for (const entry of PUBLIC_READER_ENTRIES.filter(existsSync)) {
  const reachable = reachableFrom([entry]);
  for (const recovery of EXACT_RECOVERY_PRIVATE_MODULES) {
    if (reachable.has(recovery)) {
      violations.push(`${entry} transitively imports private exact recovery module ${recovery}`);
    }
  }
}

for (const entry of FORM_AUTHORITY_OPERATOR_GATEWAY_ENTRIES.filter(existsSync)) {
  const reachable = reachableFrom([entry]);
  for (const forbidden of [
    "src/sql-d1.ts",
    "src/objects-r2.ts",
    "src/exact-artifact-recovery-worker.ts",
    "src/takoform/exact-artifact-recovery-coordinator.ts",
  ]) {
    if (reachable.has(forbidden)) {
      violations.push(`${entry} transitively imports forbidden recovery authority ${forbidden}`);
    }
  }
}

if (existsSync(EXACT_RECOVERY_ENTRY)) {
  const reachable = reachableFrom([EXACT_RECOVERY_ENTRY]);
  for (const required of [
    "src/sql-d1.ts",
    "src/objects-r2.ts",
    "src/takoform/exact-artifact-recovery-coordinator.ts",
  ]) {
    if (!reachable.has(required)) {
      violations.push(`${EXACT_RECOVERY_ENTRY} does not reach required ${required}`);
    }
  }
  for (const forbidden of ["src/app.ts", "src/router.ts", "src/control.ts", "src/openapi.ts"]) {
    if (reachable.has(forbidden)) {
      violations.push(
        `${EXACT_RECOVERY_ENTRY} transitively imports public route module ${forbidden}`,
      );
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
