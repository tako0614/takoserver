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
    checkHostAcceptanceImports(path);
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
  {
    name: "v2-host-acceptance-contract",
    match: /^src\/takoform-v2\/host-acceptance\.ts$/u,
    may: ["core", "v2-private"],
  },
  {
    // Fixed Container SQL compiler; its acceptance edge is pinned below.
    name: "v2-container-owner-schema",
    match: /^src\/takoform-v2\/container-owner-schema\.ts$/u,
    may: ["core"],
  },
  {
    name: "worker-endpoint-origin-v2-acceptance-composition",
    match: /^src\/worker-endpoint-origin-v2-acceptance\.ts$/u,
    may: ["core", "domain", "v2-contract"],
  },
  {
    // Candidate SQL grants use portable Form/reference evidence, never Docker.
    name: "v2-container-binding-authority",
    match: /^src\/takoform-v2\/container-binding-authority\.ts$/u,
    may: ["core", "v2-form"],
  },
  {
    // Forward binding graph DATA is read-only and cannot reach native adapters.
    name: "v2-forward-container-binding-authority",
    match: /^src\/takoform-v2\/forward-container-binding-authority\.ts$/u,
    may: ["core", "v2-form", "v2-operation-generation-index"],
  },
  {
    name: "v2-operation-generation-index",
    match: /^src\/takoform-v2\/operation-generation-index\.ts$/u,
    may: ["core"],
  },
  {
    name: "v2-forward-native-source",
    match: /^src\/takoform-v2\/forward-worker-native-source\.ts$/u,
    may: [],
  },
  // v2 shares neutral primitives, not the v1 package/admission domain. The
  // Queue and Durable Workflow Resource/Operation managers are exposed as
  // source-extension factories, but this does not register them in the normal
  // Host. Keep other edges explicit so a protocol translator cannot enter
  // unnoticed.
  {
    name: "v2-extension",
    match: /^src\/takoform-v2\/index\.ts$/u,
    may: [
      "core",
      "v2-contract",
      "v2-config",
      "v2-private",
      "v2-state",
      "v2-form",
      "v2-code-validation",
      "v2-runtime",
      "v2-service-binding-authority",
      "v2-forward-container-binding-authority",
      "v2-queue-manager",
      "v2-actor-sql-graph",
      "v2-actor-physical-backend",
      "v2-actor-binding-authority",
      "v2-workflow-binding-authority",
      "v2-workflow-manager",
      "v2-workflow-selected-materials",
    ],
  },
  {
    name: "v2-private",
    match: /^src\/takoform-v2\/(?:private-inputs|configured-private-inputs)\.ts$/u,
    may: ["core"],
  },
  {
    name: "v2-contract",
    match:
      /^src\/takoform-v2\/(?:types|identity|references|form-frontface|worker-form-contract)\.ts$/u,
    may: ["core", "v2-contract", "v2-private"],
  },
  {
    name: "v2-state",
    match:
      /^src\/takoform-v2\/(?:store|configured-update-inputs-schema|worker-invocation-custody|worker-invocation-schema|worker-native-identity-schema|forward-worker-native-schema)\.ts$/u,
    may: ["core", "v2-contract", "v2-private", "v2-state", "v2-operation-generation-index"],
  },
  {
    // Node's DatabaseSync and authorizer are the self-host-only realization.
    // Portable Form orchestration and the SDK index must not import it.
    name: "v2-sqlite-migration-native",
    match: /^src\/takoform-v2\/forms\/sqlite-migration-application-native\.ts$/u,
    may: ["core", "v2-form"],
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
    name: "v2-queue-manager",
    match:
      /^src\/takoform-v2\/worker-queue-(?:admission|backend|consumer-backend|delivery|scheduler|schema)\.ts$/u,
    may: ["core", "domain", "v2-contract", "v2-form", "v2-runtime", "v2-queue-manager"],
  },
  {
    name: "v2-workflow-manager",
    match: /^src\/takoform-v2\/workflow-(?:backend|class-admission)\.ts$/u,
    may: ["core", "domain", "v2-contract", "v2-form", "v2-workflow-manager"],
  },
  {
    // Accepted Workflow graph and held class bytes, shared by Workerd and WfP.
    // Physical sites, private leases and Cloudflare native readback stay outside.
    name: "v2-workflow-selected-materials",
    match: /^src\/takoform-v2\/workflow-selected-materials\.ts$/u,
    may: ["core", "domain", "app", "v2-form", "v2-runtime", "v2-workflow-manager"],
  },
  {
    name: "v2-workflow-native-selection",
    match: /^src\/takoform-v2\/workflow-native-selection\.ts$/u,
    may: [
      "core",
      "domain",
      "adapter",
      "app",
      "v2-form",
      "v2-runtime",
      "v2-workflow-selected-materials",
    ],
  },
  {
    name: "v2-workflow-forward-runtime",
    match: /^src\/takoform-v2\/workflow-forward-runtime\.ts$/u,
    may: ["core", "domain", "app", "v2-workflow-native-selection"],
  },
  {
    name: "v2-selfhost-workflow-composition",
    match: /^src\/takoform-v2\/selfhost-v2-workflow-composition\.ts$/u,
    may: [
      "core",
      "domain",
      "app",
      "package-surface",
      "v2-form",
      "v2-runtime",
      "v2-workflow-manager",
      "v2-workflow-native-selection",
      "v2-workflow-forward-runtime",
    ],
  },
  {
    name: "v2-runtime",
    match:
      /^src\/takoform-v2\/(?:edge-kv-native-custody|module-worker-lifecycle-backend|worker-bundle-runtime|worker-code-runtime|worker-cron-trigger-backend|worker-cron-trigger-scheduler|worker-deployment-backend|worker-endpoint-backend|worker-lifecycle-backend|worker-runtime-readers|worker-publication-state|worker-publication-sql-guard|worker-static-runtime|worker-static-publication|worker-native-effects|worker-native-deletions)\.ts$|^src\/workerd-worker-runtime-owner\.ts$/u,
    may: [
      "core",
      "v2-contract",
      "v2-state",
      "v2-form",
      "v2-code-validation",
      "v2-runtime",
      "v2-workflow-binding-authority",
      "v2-workflow-binding-projection",
      "v2-service-binding-broker",
      "adapter",
    ],
  },
  {
    // Core-only immutable caller binding authority for native ServiceBinding.
    name: "v2-service-binding-authority",
    match: /^src\/takoform-v2\/service-binding-authority\.ts$/u,
    may: ["core", "v2-form"],
  },
  {
    // Host-private streaming bridge for one exact v2 ServiceBinding claim.
    name: "v2-service-binding-broker",
    match: /^src\/selfhost-v2-service-binding-broker\.ts$/u,
    may: ["core", "v2-service-binding-authority"],
  },
  {
    // Accepted Core Workflow/Version graph, never legacy Workflow Resource lookup.
    name: "v2-workflow-binding-authority",
    match: /^src\/takoform-v2\/workflow-binding-authority\.ts$/u,
    may: ["core", "v2-form", "v2-workflow-manager"],
  },
  {
    // Host-private exact grant projection, below the native graph adapter.
    name: "v2-workflow-binding-projection",
    match: /^src\/takoform-v2\/workflow-binding-projection\.ts$/u,
    may: ["core", "v2-form"],
  },
  {
    // Per-incarnation broker wires accepted authority to existing Workflow instances.
    name: "v2-workflow-binding-boot",
    match: /^src\/takoform-v2\/workflow-binding-boot\.ts$/u,
    may: [
      "core",
      "domain",
      "adapter",
      "app",
      "v2-form",
      "v2-workflow-binding-authority",
      "v2-workflow-binding-projection",
    ],
  },
  {
    // Portable accepted Actor graph predicates shared by self-host and
    // provider-owned native adapters. No Workerd or Node owner is reachable.
    name: "v2-actor-sql-graph",
    match: /^src\/takoform-v2\/actor-namespace-sql-graph\.ts$/u,
    may: ["core", "v2-form"],
  },
  {
    // Outer adapter: accepted v2 SQL/native authority meets the existing
    // physical Actor port, whose explicit legacy adapter lives in one module.
    // This is not a pure Form parser or a new native-import permission for it.
    name: "v2-actor-graph-authority",
    match: /^src\/takoform-v2\/actor-namespace-graph-authority\.ts$/u,
    may: ["core", "adapter", "app", "v2-form", "v2-runtime", "v2-actor-sql-graph"],
  },
  {
    // Actor acceptance reads v2 SQL and held Form bytes through typed ports;
    // it does not import the native owner or the legacy Actor adapter.
    name: "v2-actor-admission",
    match: /^src\/takoform-v2\/actor-namespace-admission\.ts$/u,
    may: ["core", "v2-contract", "v2-form"],
  },
  {
    // Exact outer composition point for the existing physical Actor owner;
    // never broadens pure Form or generic v2 runtime access to app modules.
    name: "v2-actor-physical-backend",
    match: /^src\/takoform-v2\/actor-namespace-backend\.ts$/u,
    may: [
      "core",
      "app",
      "native-contract",
      "v2-contract",
      "v2-form",
      "v2-actor-admission",
      "v2-actor-sql-graph",
    ],
  },
  {
    // Exact v2 accepted-reference adapter for the existing physical Actor port.
    name: "v2-actor-binding-authority",
    match: /^src\/takoform-v2\/actor-binding-authority\.ts$/u,
    // Pure scope/graph types permit provider adapters without a self-host runtime import.
    may: ["core", "app", "v2-form", "v2-actor-physical-backend", "native-contract"],
  },
  {
    // Outer Host-private v2 Actor forward boot, never a pure Form/parser layer.
    name: "v2-actor-forward-runtime",
    match: /^src\/takoform-v2\/actor-forward-runtime\.ts$/u,
    may: ["core", "adapter", "app", "v2-form", "v2-actor-binding-authority"],
  },
  {
    // Exact app boot joins accepted SQL, the physical Actor owner, and the
    // portable composition port; generic app/Form/native layers stay unchanged.
    name: "v2-selfhost-actor-boot",
    match: /^src\/selfhost-v2-actor-boot\.ts$/u,
    may: [
      "core",
      "app",
      "v2-actor-binding-authority",
      "v2-actor-forward-runtime",
      "v2-actor-physical-backend",
      "v2-actor-graph-authority",
      "v2-selfhost-composition",
    ],
  },
  {
    // Exact app boot joins the accepted Worker graph and existing guarded
    // Workflow runtime. The pure Form/native layers gain no app import edge.
    name: "v2-selfhost-workflow-boot",
    match: /^src\/selfhost-v2-workflow-boot\.ts$/u,
    may: [
      "core",
      "app",
      "domain",
      "v2-selfhost-composition",
      "v2-selfhost-workflow-composition",
      "v2-workflow-binding-authority",
      "v2-workflow-binding-boot",
    ],
  },
  {
    // The normal entry selects the existing v2 Actor and Workflow boots here;
    // no pure Form/runtime layer gains a composition-root dependency.
    name: "v2-selfhost-runtime-boot",
    match: /^src\/selfhost-v2-runtime-boot\.ts$/u,
    may: [
      "core",
      "app",
      "v2-selfhost-actor-boot",
      "v2-selfhost-workflow-boot",
      "v2-actor-graph-authority",
      "v2-selfhost-composition",
      "v2-runtime",
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
    // Request-lifetime progress belongs to the Worker entry, not the durable
    // engine or protocol routes. It only reads the Operation contract.
    name: "v2-worker-wake",
    match: /^src\/takoform-v2\/worker-wake\.ts$/u,
    may: ["v2-contract"],
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
    name: "v2-selfhost-endpoint-https",
    // This exact HTTPS listener adapts the v2 Endpoint observation contract
    // to a local TLS socket; it is not a general app permission to import the
    // v2 runtime layer.
    match: /^src\/selfhost-v2-worker-endpoint-https\.ts$/u,
    may: ["core", "adapter", "v2-runtime"],
  },
  {
    // The exact outer boot joins the existing TLS witness and SQL/native
    // frontend; it does not broaden generic Form/runtime import authority.
    name: "v2-selfhost-endpoint-boot",
    match: /^src\/selfhost-v2-worker-endpoint-boot\.ts$/u,
    may: [
      "core",
      "v2-contract",
      "v2-runtime",
      "v2-selfhost-endpoint-frontend",
      "v2-selfhost-endpoint-https",
    ],
  },
  {
    name: "app",
    match: /^src\/selfhost-takoform-v2-ingress\.ts$/u,
    may: ["v2-contract"],
  },
  {
    // The native HTTPS dialer has no portable product dependency. Only its
    // self-host composition may pair it with the portable artifact Form.
    name: "selfhost-public-https-artifact-transport",
    match: /^src\/selfhost-public-https-artifact-fetch\.ts$/u,
    may: [],
  },
  {
    name: "v2-selfhost-public-artifact-source-composition",
    match: /^src\/selfhost-public-artifact-source-composition\.ts$/u,
    may: ["core", "v2-form", "selfhost-public-https-artifact-transport"],
  },
  {
    name: "v2-selfhost-composition",
    match: /^src\/selfhost-v2-worker-composition\.ts$/u,
    may: [
      "core",
      "adapter",
      "v2-application",
      "v2-config",
      "v2-form",
      "v2-sqlite-migration-native",
      "v2-runtime",
      "v2-private",
      "v2-code-validation",
      "v2-selfhost-queue-worker-capability",
      "v2-selfhost-scheduled-composition",
      "v2-queue-manager",
      "v2-selfhost-workflow-composition",
      "v2-service-binding-authority",
    ],
  },
  {
    name: "v2-selfhost-endpoint-frontend",
    match: /^src\/selfhost-v2-worker-endpoint-frontend\.ts$/u,
    may: [
      "core",
      "adapter",
      "v2-application",
      "v2-config",
      "v2-form",
      "v2-runtime",
      "v2-private",
      "v2-code-validation",
      "v2-selfhost-queue-worker-capability",
      "v2-queue-manager",
    ],
  },
  {
    name: "v2-selfhost-queue-worker-capability",
    match: /^src\/selfhost-v2-queue-worker-capability\.ts$/u,
    may: ["core", "v2-form", "v2-queue-manager", "v2-runtime"],
  },
  {
    name: "v2-selfhost-scheduled-composition",
    match: /^src\/selfhost-v2-scheduled-composition\.ts$/u,
    may: ["core", "v2-runtime"],
  },
  {
    name: "v2-selfhost-configured-input-sealer",
    match: /^src\/selfhost-v2-configured-input-sealer\.ts$/u,
    may: ["app", "v2-code-validation"],
  },
  {
    name: "v2-selfhost-queue-cancel",
    match: /^src\/selfhost-v2-queue-cancel\.ts$/u,
    may: ["core", "v2-queue-manager"],
  },
  {
    name: "v2-selfhost-queue-composition",
    match: /^src\/selfhost-v2-queue-composition\.ts$/u,
    may: [
      "core",
      "domain",
      "adapter",
      "v2-queue-manager",
      "v2-runtime",
      "v2-selfhost-queue-cancel",
    ],
  },
  {
    name: "v2-selfhost-queue-scheduler",
    match: /^src\/selfhost-v2-queue-scheduler\.ts$/u,
    may: ["core", "domain", "v2-form", "v2-queue-manager", "v2-selfhost-queue-composition"],
  },
  {
    name: "release-data",
    match:
      /^(?:vendor\/takoform\/.*\.json|src\/generated\/takoform-(?:stable-v1-catalog|stable-error-taxonomy|integration-form-packages|publisher-set-receipt|publisher-set-authority-closure)\.ts)$/u,
    may: ["release-data"],
  },
  {
    // Pure type declarations shared by the native Workerd owner and the
    // portable Actor Form; these exact files may not load runtime values.
    name: "native-contract",
    match: /^src\/(?:workerd-site|actor-execution)-contract\.ts$/u,
    may: ["core", "adapter", "native-contract"],
  },
  {
    name: "core",
    match:
      /^src\/(?:ports|json|strict-json|container-contract|container-http|artifact-path|object-bucket-binding-profile|cron|selfhost-socket-layout|error-envelope|route-table|request-authorization|request-body|request-lifetime|public-host-identity|form-ref|interface-ref|actor-abi-ref|standard-service-port|worker-class-runtime-port|worker-module-inspection-contract|worker-invocation-port|queue-v2-batch-custody-contract|queue-v2-sqlite-contract|queue-v2-sqlite-physical-fence|workflow-v2-resource-authority|provider-port|provider-meter-port|provider-runtime-input-port|provider-worker-endpoint-origin|ai-port|database|database-schema|db-schema|migrate-sqlite|sqlite-migration-policy|stripe-mode-realm|vector-index-codec)\.ts$|^src\/takoform\/limits\.ts$/u,
    // Frozen published data sits below every layer: it is bytes a release
    // pinned, not a decision any layer here may make. The wire error taxonomy
    // this Host answers by is exactly that.
    may: ["core", "release-data"],
  },
  {
    name: "adapter",
    match:
      /^src\/(?:sql-d1|sql-d1-http|sql-sqlite|money-cutover-sql|objects-r2|objects-r2-http|objects-mem|objects-fs|selfhost-object-store|selfhost-data-root|selfhost-listen-address|selfhost-socket-root|selfhost-endpoint-https-tls|selfhost-v2-worker-endpoint-upstream-websocket|selfhost-weighted-deployment|selfhost-actor-class-runtime|selfhost-actor-forward-worker-wrapper|selfhost-workflow-binding-worker-wrapper|workflow-transport-journal|vector-index-store)\.ts$|^src\/workerd-(?:artifact|execution-guard|linux-process|runtime|supervisor|version-graph|worker-execution-group|worker-module-inspector)\.ts$|^src\/generated\/(?:actor-native-bootstrap|selfhost-actor-forward-runtime-source|selfhost-workflow-binding-runtime-source)\.ts$|^src\/providers\//u,
    may: ["core", "adapter", "native-contract"],
  },
  {
    // Private ordinary-only SQL fence; native/source/Financial authority is separate.
    name: "adapter",
    match: /^src\/ordinary-financial-public-sql\.ts$/u,
    may: ["core", "domain"],
  },
  {
    name: "domain",
    match:
      /^src\/(?:token|auth|auth-authority-schema-plan|auth-principal-schema-plan|auth-rp-storage-schema-plan|credential-authority-class|shared-principal-authority|ledger|money|meter-pricing|org-billing|org-usage-summary|org-workspace-usage|workspace-billing-organization|org-limit-policy|org-on-demand-terms|org-top-up|shared-financial-action|hosted-billing-realm|hosted-subscription-adapter|stripe-top-up-client|stripe-customer-custody|stripe-card-setup|stripe-on-demand|stripe-on-demand-verification|billing-config|hosted-pricing|hosted-run-pricing|catalog|catalog-compiler|reseller|metering|provider-driver|provider-pack|provider-metering|provider-placement|provider-runtime-bindings|resource-deployments|resource-execution-evidence|resource-migrations|runtime-input-preparations|queue-custody|actor-class-execution|actor-class-candidate-inspection|actor-resource-graph|worker-endpoint-origin-reservations|selfhost-actor-contract-closure|workflow-instances|workflow-resource-graph|workflow-resource-lifecycle|workflow-data|workflow-driver|workflow-execution|workflow-due-scheduler|workflow-class-execution|workflow-execution-host|artifact-consumer-repair|artifact-recovery|artifact-recovery-owner-gc|exact-artifact-recovery-operator-proof|attachments|reconcile|metering|edge-forms|ai-requests|operator-credentials|integration-e2e-credential-authority|integration-organization-bootstrap|sponsorship-authority|sponsorship-credential|sponsorship-issuance-receipt|tenant-run-credential|tenant-run-principal|form-authority-operator-proof|google-identity|takos-id-identity|shared-auth-oidc-client|shared-auth-session|shared-auth-session-store|identity-setup|stripe-settlement|stripe-events|stripe-billing|stripe-billing-client|stripe-billing-store|subscription-custody|subscription-command-receipts|stripe-subscription-plan-change|payment-events|payment-settings|signing-key|operator-key|ed25519-private-jwk|runtime-grants|takoform-released-provider)\.ts$|^src\/takoform\/(?!routes\.ts$|host\.ts$|host-admission-endpoint\.ts$|integration-operator-endpoint\.ts$|integration-actor-(?:host|form-authority)\.ts$)/u,
    may: ["core", "domain", "release-data"],
  },
  {
    // Pure closed browser-route selector; it imports no runtime authority.
    name: "domain",
    match: /^src\/financial-hosted-browser-selector\.ts$/u,
    may: [],
  },
  {
    // These exact browser route helpers capture request/session/current RPC state.
    // The selection helper also imports the existing Checkout route type.
    name: "routes",
    match:
      /^src\/(?:router|control|data-storage|data-ai|openapi|landing|provisioner-endpoint)\.ts$|^src\/takoform\/(?:routes|host)\.ts$|^src\/financial-hosted-browser-(?:continuation|request|rpc|selection)\.ts$|^src\/financial-hosted-owner-read\.ts$/u,
    may: ["core", "adapter", "domain", "routes", "v2-documentation"],
  },
  {
    name: "app",
    // `payment-setup` builds the shape the routes layer asks for, which makes
    // it composition rather than domain: it is allowed to know both halves.
    match:
      /^src\/(?:app|actor-addressing(?:-source)?|actor-upgrade-handoff(?:-source)?|actor-namespace-facade(?:-source)?|actor-native-(?:class-execution|owner-worker|bootstrap-entry|bootstrap-source)|selfhost-actor-(?:execution-host|graph-authority|lease|native-process|upgrade-broker|http-broker|forward-runtime(?:-entry)?|forward-worker-wrapper|forward-brokers|public-runtime)|compat|cloudflare-provider-surface|cloudflare-runtime-binding-materializer|deployment-composition|exact-artifact-recovery-worker|existing-space-operator(?:-proof)?|form-authority-(?:identity-probe|public-identity|worker-composition)|integration-form-authority-gateway|hosted-(?:object-bucket|edge)-supplies|object-bucket-deployment|payment-setup|hosted-billing-composition|public-form-(?:implementation-build|runtime)|public-host-form-source|public-worker-implementation|runtime-input-seal-keyring|selfhost-composition|selfhost-container-(?:bootstrap|endpoint-(?:ingress|https))|selfhost-data-planes|selfhost-entry-(?:process-)?shutdown|selfhost-form-authority-composition|selfhost-health(?:-signals)?|selfhost-queue-pump|selfhost-runtime-binding-materializer|selfhost-scheduler|selfhost-startup-instructions|selfhost-tenant-run-credentials|selfhost-workflow-binding-(?:broker|runtime-entry)|selfhost-workflow-execution-host|selfhost-workflow-http-transport|selfhost-workflow-preparation|selfhost-workflow-private-owner|selfhost-workflow-serving|workerd-workflow-preparation|workflow-http-bootstrap-entry|workflow-http-controller|workflow-http-worker|standalone-provider-composition|worker-data-services|worker-(?:production|stable-local|request)-composition)\.ts$|^src\/generated\/(?:workflow-http-bootstrap|actor-upgrade-handoff-source|actor-namespace-facade-source|actor-addressing-source)\.ts$|^src\/takoform\/(?:host-admission-endpoint|integration-operator-endpoint)\.ts$/u,
    may: [
      "core",
      "adapter",
      "native-contract",
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
  {
    name: "app",
    match: /^src\/worker-request-shared-principal-issuance\.ts$/u,
    may: ["core", "domain", "app"],
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
    may: [
      "core",
      "adapter",
      "domain",
      "routes",
      "app",
      "entry",
      "v2-config",
      "v2-selfhost-composition",
      "v2-selfhost-queue-composition",
      "v2-selfhost-queue-scheduler",
      "v2-selfhost-configured-input-sealer",
      "v2-selfhost-runtime-boot",
      "v2-selfhost-endpoint-boot",
      "v2-selfhost-public-artifact-source-composition",
      "v2-worker-wake",
    ],
  },
  {
    // Plain schema/build DATA and fixed predicates are shared below adapters/app.
    name: "core",
    match: /^src\/auth103-native-source-contract\.ts$/u,
    may: ["core"],
  },
  {
    name: "app",
    match: /^src\/auth103-native-(?:origin-source|platform-origin)\.ts$/u,
    may: ["core", "domain", "app"],
  },
  {
    // The single source Clock recipe is a neutral primitive, not a qualifier.
    name: "core",
    match: /^src\/auth103-source-clock\.ts$/u,
    may: ["core"],
  },
  {
    // These exact request adapters compose actual original-backed ports.
    name: "app",
    match:
      /^src\/(?:financial-auth-consumer|worker-request-financial-auth-original|worker-request-direct-owner-key|worker-request-qualified-local-issuer|worker-request-native-rp-transport)\.ts$/u,
    may: ["core", "domain", "app"],
  },
  // The published package surface re-exports the product for an embedder. It
  // states no policy of its own, so it may name anything a consumer is allowed
  // to construct — but it stays below `entry`, which owns a running process.
  {
    name: "package-surface",
    match:
      /^src\/(?:index|provider-extension|financial-request-origin|workflow-runtime|workflow-runtime-transport|workflow-runtime-workerd)\.ts$|^src\/takoform\/integration-actor-(?:host|form-authority)\.ts$/u,
    may: ["core", "adapter", "domain", "routes", "app", "package-surface"],
  },
  {
    // Host policy decisions are neutral domain functions; native enforcement
    // and image registry adapters stay behind their owning composition ports.
    name: "domain",
    match: /^src\/container-(?:egress-policy|image-admission)\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // The shared monetary source is domain data; the hosted runtime pins its
    // commercial terms while Price identities are resolved separately.
    name: "domain",
    match: /^src\/shared-hosted-pricing\.ts$/u,
    may: ["core", "domain", "release-data"],
  },
  {
    // Source-event codecs and retained receiver CAS use domain ports only.
    // A private runtime binding belongs to a separately reviewed composition.
    name: "domain",
    match: /^src\/shared-financial-source(?:-(?:abi|contract|enrollment))?\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // These exact genesis modules use only portable domain and core inputs.
    name: "domain",
    match: /^src\/shared-financial-source-genesis-(?:admission|schema)\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // This exact composition joins retained custody, the SQL-origin adapter,
    // and the original request/Financial auth composition.
    name: "app",
    match: /^src\/shared-financial-retained-r1\.ts$/u,
    may: ["core", "domain", "adapter", "app"],
  },
  {
    // Exact Financial 0104 money-fence DDL and the static fenced-batch refusal.
    name: "domain",
    match: /^src\/financial-0104-money-fence\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // Exact Financial 0104 Customer schema leaves and the read-only write-shape check.
    name: "domain",
    match: /^src\/financial-0104-customer-schema\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // Financial 0104 source recipe DATA over existing Financial schema leaves.
    // It registers or applies nothing; Root owns the canonical inventory.
    name: "app",
    match: /^src\/financial-0104-source-contract\.ts$/u,
    may: ["core", "domain", "app"],
  },
  {
    // Consent codecs and the unregistered history leaf use portable domain ports.
    name: "domain",
    match: /^src\/shared-auth-financial-consent-(?:contract|schema-plan)\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // This exact DATA store consumes the existing request-origin composition.
    name: "app",
    match: /^src\/shared-auth-financial-consent-store\.ts$/u,
    may: ["core", "domain", "app"],
  },
  {
    // Unmounted request observation and consent composition use app ports only.
    name: "app",
    match: /^src\/shared-auth-financial-(?:source|consent|consent-route)\.ts$/u,
    may: ["core", "domain", "app"],
  },
  {
    // Exact displayed terms join existing R1 app DATA with core/domain tariff facts.
    name: "app",
    match: /^src\/financial-displayed-terms\.ts$/u,
    may: ["core", "domain", "app"],
  },
  {
    // Canonical R1 selection binds app DATA sources without adapter authority.
    name: "app",
    match: /^src\/financial-r1-selection-source\.ts$/u,
    may: ["core", "domain", "app"],
  },
  {
    // Retained history storage is separate from its qualified runtime issuer.
    name: "domain",
    match: /^src\/shared-financial-customer-history\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // Finite portable Financial consent and Customer CAS data compilers.
    name: "domain",
    match:
      /^src\/(?:shared-auth-financial-consent-request|shared-financial-(?:consent-data|admission|customer-(?:dispatch|journal)|current-consent-cas))\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // Request-bound Financial custody joins already selected sources and ports.
    name: "app",
    match:
      /^src\/(?:shared-auth-financial-(?:source|consent|consent-issuer)|shared-financial-customer-tracked-execution|financial-current-consent-customer)\.ts$/u,
    may: ["core", "domain", "app"],
  },
  {
    // Root 0105 Org history capture recipe DATA; it imports nothing.
    name: "domain",
    match: /^src\/root-0105-org-capture-triggers\.ts$/u,
    may: ["core", "domain"],
  },
  {
    // Shared app name policy belongs to the existing origin reservation domain.
    // Its pure helpers do not gain adapter or composition import authority.
    name: "domain",
    match: /^src\/shared-app-(?:name|ledger)\.ts$/u,
    may: ["core", "domain", "release-data"],
  },
  {
    // This unmounted composition alone supplies the fresh primary-D1 capability.
    name: "shared-app-ledger-d1-composition",
    match: /^src\/shared-app-ledger-d1\.ts$/u,
    may: ["core", "adapter", "domain"],
  },
  {
    // Staging physical adoption uses SQL ports and the existing name policy.
    name: "domain",
    match: /^src\/shared-app-staging-adoption\.ts$/u,
    may: ["core", "domain"],
  },
];

function layerOf(path: string): Layer | undefined {
  if (
    path === "config/shared-hosted-pricing.json" ||
    path === "config/shared-hosted-pricing-revisions/hosted-20261014-final-v1.json" ||
    path === "config/shared-hosted-pricing-revisions/hosted-20261015-container-proposed-v1.json"
  ) {
    return LAYERS.find((layer) => layer.name === "domain");
  }
  // Unpublished source projections are domain inputs, not released data or
  // authority bundles. Their presence cannot confer publisher verification.
  if (path === "src/generated/takoform-forward-candidate-catalog.ts") {
    return LAYERS.find((layer) => layer.name === "domain");
  }
  return LAYERS.find((layer) => layer.match.test(path));
}

/** Exact composition roots may carry these types without gaining mint access. */
function exactHostAcceptanceCompositionTypeEdge(path: string, target: string): boolean {
  const expected =
    path === "src/app.ts"
      ? [
          "V2HostAcceptance",
          "V2HostAcceptanceContext",
          "V2HostAcceptanceScope",
          "V2HostDeleteAcceptanceContext",
        ]
      : path === "src/entry-worker.ts"
        ? ["V2HostAcceptance"]
        : undefined;
  if (
    expected === undefined ||
    target !== "src/takoform-v2/host-acceptance.ts" ||
    localImportsOf(path).filter((candidate) => candidate === target).length !== 1
  )
    return false;
  const names = readFileSync(path, "utf8")
    .match(
      /^import\s+type\s+\{([^}]*)\}\s+from\s+(["'])\.\/takoform-v2\/host-acceptance\.ts\2;$/mu,
    )?.[1]
    ?.trim()
    .replace(/,\s*$/u, "")
    .split(",")
    .map((name) => name.trim())
    .sort();
  return JSON.stringify(names) === JSON.stringify(expected.sort());
}

/** Reviewed Container consumers: exact named imports, never adapter-wide v2 access. */
const EXACT_CONTAINER_ADAPTER_IMPORTS: readonly {
  readonly source: string;
  readonly target: string;
  readonly typeOnly: boolean;
  readonly names: readonly string[];
}[] = [
  {
    // The guarded discard factory consumes only its fixed schema and object names.
    source: "src/takoform-v2/configured-private-inputs.ts",
    target: "src/takoform-v2/configured-update-inputs-schema.ts",
    typeOnly: false,
    names: ["v2ConfiguredUpdateDiscardObjects", "v2ConfiguredUpdateDiscardSchema"],
  },
  {
    source: "src/takoform-v2/worker-invocation-custody.ts",
    target: "src/takoform-v2/forms/worker-specs.ts",
    typeOnly: false,
    names: ["FORWARD_WORKER_DEPLOYMENT_FORM_URL", "FORWARD_WORKER_VERSION_FORM_URL"],
  },
  {
    source: "src/takoform-v2/forward-worker-native-schema.ts",
    target: "src/takoform-v2/forward-worker-native-source.ts",
    typeOnly: false,
    names: ["FORWARD_NATIVE_BASE_OBJECTS"],
  },
  {
    source: "src/takoform-v2/forward-container-binding-authority.ts",
    target: "src/takoform-v2/worker-publication-state.ts",
    typeOnly: false,
    names: ["MAX_FAILED_TAIL"],
  },
  {
    source: "src/providers/selfhost-container-entry-contract.ts",
    target: "src/takoform-v2/host-acceptance.ts",
    typeOnly: true,
    names: ["V2HostAcceptance"],
  },
  {
    source: "src/providers/selfhost-container-entry-contract.ts",
    target: "src/takoform-v2/types.ts",
    typeOnly: true,
    names: ["V2Form"],
  },
  {
    source: "src/providers/container-secret-codec.ts",
    target: "src/takoform-v2/private-inputs.ts",
    typeOnly: true,
    names: ["V2PrivateInputKey"],
  },
  {
    source: "src/providers/docker-container-configured-inputs.ts",
    target: "src/takoform-v2/configured-private-inputs.ts",
    typeOnly: false,
    names: [
      "readV2ConfiguredPrivateInputs",
      "type V2ConfiguredPrivateInputIdentity",
      "type V2ConfiguredPrivateInputs",
    ],
  },
  {
    source: "src/providers/docker-container-configured-inputs.ts",
    target: "src/takoform-v2/forms/container.ts",
    typeOnly: false,
    names: ["isContainerHealthPath", "isContainerImage", "scalarStringWithin"],
  },
  {
    source: "src/providers/docker-container-configured-inputs.ts",
    target: "src/takoform-v2/private-inputs.ts",
    typeOnly: true,
    names: ["V2PrivateInputMap"],
  },
  {
    source: "src/providers/docker-container-configured-inputs.ts",
    target: "src/takoform-v2/types.ts",
    typeOnly: true,
    names: ["V2Execution", "V2Form"],
  },
  {
    source: "src/providers/docker-container-core-owner.ts",
    target: "src/takoform-v2/configured-private-inputs.ts",
    typeOnly: false,
    names: ["readV2ConfiguredPrivateInputs"],
  },
  {
    source: "src/providers/docker-container-core-owner.ts",
    target: "src/takoform-v2/container-owner-schema.ts",
    typeOnly: false,
    names: [
      "createV2ContainerHostAcceptance",
      "serializeV2ContainerConfiguredPrivateInputs",
      "V2_CONTAINER_F2_FORM",
      "validateV2ContainerF2SensitiveNames",
    ],
  },
  {
    source: "src/providers/docker-container-core-owner.ts",
    target: "src/takoform-v2/host-acceptance.ts",
    typeOnly: true,
    names: ["V2HostAcceptance", "V2HostAcceptanceContext", "V2HostDeleteAcceptanceContext"],
  },
  {
    source: "src/providers/docker-container-core-owner.ts",
    target: "src/takoform-v2/types.ts",
    typeOnly: true,
    names: ["V2Execution"],
  },
];

/** Financial M/G/receiver and Customer admission/history/tracked/current-consent
 * writers bind their writer epoch exactly as R1 does, through the Money writer
 * origin assertion only. No other adapter access. */
const EXACT_FINANCIAL_MONEY_ORIGIN_IMPORTS: readonly {
  readonly source: string;
  readonly target: string;
  readonly typeOnly: boolean;
  readonly names: readonly string[];
}[] = [
  "src/shared-financial-source.ts",
  "src/shared-financial-source-enrollment.ts",
  "src/shared-financial-source-genesis-admission.ts",
  "src/shared-financial-admission.ts",
  "src/shared-financial-customer-history.ts",
  "src/financial-current-consent-customer.ts",
]
  .map((source) => ({
    source,
    target: "src/money-cutover-sql.ts",
    typeOnly: false,
    names: ["assertMoneyCutoverSqlOrigin"],
  }))
  .concat([
    {
      // Customer tracked execution binds its Money writer to its raw read backing.
      source: "src/shared-financial-customer-tracked-execution.ts",
      target: "src/money-cutover-sql.ts",
      typeOnly: false,
      names: ["assertMoneyCutoverSqlBackingOrigin"],
    },
  ]);

function exactContainerAdapterImportEdge(path: string, target: string): boolean {
  const expected = [
    ...EXACT_CONTAINER_ADAPTER_IMPORTS,
    ...EXACT_FINANCIAL_MONEY_ORIGIN_IMPORTS,
  ].find((entry) => entry.source === path && entry.target === target);
  if (
    expected === undefined ||
    localImportsOf(path).filter((candidate) => candidate === target).length !== 1
  )
    return false;
  const declarations = [
    ...readFileSync(path, "utf8").matchAll(
      /^import\s+(type\s+)?\{([^}]+)\}\s+from\s+(["'])([^"']+)\3;$/gmu,
    ),
  ].filter(
    (entry) => normalize(relative(resolve("."), resolve(dirname(path), entry[4] ?? ""))) === target,
  );
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    declaration === undefined ||
    Boolean(declaration[1]) !== expected.typeOnly
  )
    return false;
  const names = (declaration[2] ?? "")
    .split(",")
    .map((name) => name.trim().replace(/\s+/gu, " "))
    .filter((name) => name !== "");
  if (names.some((name) => !/^(?:type )?[A-Za-z_$][\w$]*$/u.test(name))) return false;
  return JSON.stringify(names.sort()) === JSON.stringify([...expected.names].sort());
}

// These three app modules consume the existing request-origin barrel only for
// their fixed original-backed readers and currentness guards. This is not a
// general app -> package-surface dependency or an authority-minting grant.
const EXACT_RP_FINANCIAL_ORIGIN_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/shared-auth-financial-consent-store.ts": [
    "assertFinancialAuthConsumerPort",
    "assertWorkerRequestFinancialAuthConsumerPort",
    "captureWorkerRequestFinancialAuthRpRequest",
    "financialAuthConsumerSourceCurrentness",
    "readWorkerRequestFinancialAuthConsumerContext",
    "readWorkerRequestFinancialAuthConsumerPort",
    "readWorkerRequestFinancialInputs",
    "readWorkerRequestRetainedRpCapture",
  ],
  "src/shared-auth-financial-consent.ts": [
    "assertFinancialAuthConsumerPort",
    "assertWorkerRequestFinancialAuthConsumerPort",
    "captureWorkerRequestFinancialAuthRpRequest",
    "readWorkerRequestFinancialAuthConsumerContext",
    "readWorkerRequestFinancialAuthConsumerPort",
    "readWorkerRequestFinancialInputs",
    "readWorkerRequestRetainedRpCapture",
    "type WorkerRequestSql",
  ],
  "src/shared-auth-financial-source.ts": [
    "assertFinancialAuthConsumerPort",
    "assertWorkerRequestFinancialAuthConsumerPort",
    "captureWorkerRequestFinancialAuthRpRequest",
    "readWorkerRequestFinancialAuthConsumerContext",
    "readWorkerRequestFinancialAuthConsumerPort",
    "readWorkerRequestFinancialInputs",
    "readWorkerRequestRetainedRpCapture",
    "type WorkerRequestSql",
  ],
};

/** The operator barrel exposes this constructor, never the composition layer. */
function exactSharedAppLedgerD1ExportEdge(path: string, target: string): boolean {
  if (
    (path !== "src/index.ts" && path !== "src/provider-extension.ts") ||
    target !== "src/shared-app-ledger-d1.ts"
  )
    return false;
  const source = readFileSync(path, "utf8");
  const references = [...source.matchAll(/(["'`])(\.[^"'`]+)\1/gu)].filter(
    (entry) => normalize(relative(resolve("."), resolve(dirname(path), entry[2] ?? ""))) === target,
  );
  return (
    references.length === 1 &&
    /^export\s+\{\s*createSharedAppLedgerD1\s*,?\s*\}\s+from\s+(["'])\.\/shared-app-ledger-d1\.ts\1;$/mu.test(
      source,
    )
  );
}

function exactRpFinancialOriginImportEdge(path: string, target: string): boolean {
  if (target !== "src/financial-request-origin.ts") return false;
  const expected = EXACT_RP_FINANCIAL_ORIGIN_IMPORTS[path];
  if (expected === undefined) return false;
  const source = readFileSync(path, "utf8");
  // Count every literal reference, including export, default/namespace,
  // dynamic import and require forms that the general graph parser may miss.
  // These fixed consumers have no dynamic module loading at all.
  const references = [...source.matchAll(/(["'`])(\.[^"'`]+)\1/gu)].filter(
    (entry) => normalize(relative(resolve("."), resolve(dirname(path), entry[2] ?? ""))) === target,
  );
  if (references.length !== 1 || /\b(?:import|require)\s*\(/u.test(source)) return false;
  const declarations = [
    ...source.matchAll(
      /^import\s+\{([^}]+)\}\s+from\s+(["'])\.\/financial-request-origin\.ts\2;$/gmu,
    ),
  ];
  const declaration = declarations[0];
  if (declarations.length !== 1 || declaration === undefined) return false;
  const names = (declaration[1] ?? "")
    .split(",")
    .map((name) => name.trim().replace(/\s+/gu, " "))
    .filter((name) => name !== "");
  if (names.some((name) => !/^(?:type )?[A-Za-z_$][\w$]*$/u.test(name))) return false;
  return JSON.stringify(names.sort()) === JSON.stringify([...expected].sort());
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
    const exactHostAcceptanceEdge =
      target === "src/takoform-v2/host-acceptance.ts" &&
      [
        "src/takoform-v2/engine.ts",
        "src/takoform-v2/store.ts",
        "src/takoform-v2/host.ts",
        "src/takoform-v2/application.ts",
        "src/worker-endpoint-origin-v2-acceptance.ts",
      ].includes(path);
    const exactContainerHostAcceptanceEdge =
      path === "src/takoform-v2/container-owner-schema.ts" &&
      target === "src/takoform-v2/host-acceptance.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      /^import\s*\{\s*prepareV2HostAcceptance\s*,\s*type\s+V2HostAcceptance\s*,\s*type\s+V2HostAcceptanceContext(?:\s*,\s*type\s+V2HostDeleteAcceptanceContext)?\s*,?\s*\}\s*from\s+["']\.\/host-acceptance\.ts["'];$/mu.test(
        readFileSync(path, "utf8"),
      );
    // The operator SDK exposes the existing compiler constructor from this
    // exact barrel. Recipes, readiness SQL and mint primitives stay private;
    // this does not give the extension layer a general schema dependency.
    const exactContainerConstructionExportEdge =
      path === "src/takoform-v2/index.ts" &&
      target === "src/takoform-v2/container-owner-schema.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      /^export\s*\{\s*createV2ContainerHostAcceptance\s*,?\s*\}\s*from\s+["']\.\/container-owner-schema\.ts["'];$/mu.test(
        readFileSync(path, "utf8"),
      );
    // This fixed receiver reuses only the owning Deployment parser/error.
    // No general v2-form edge, re-export, namespace or dynamic import is allowed.
    const exactOriginDeploymentParserEdge =
      path === "src/worker-endpoint-origin-v2-acceptance.ts" &&
      target === "src/takoform-v2/forms/worker-specs.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      /import\s*\{\s*parseWorkerDeploymentSpec\s*,\s*WorkerFormValidationError\s*,?\s*\}\s*from\s+["']\.\/takoform-v2\/forms\/worker-specs\.ts["'];/u.test(
        readFileSync(path, "utf8"),
      );
    const exactWorkerEndpointOriginConstructionEdge =
      path === "src/app.ts" &&
      target === "src/worker-endpoint-origin-v2-acceptance.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      /import\s*\{\s*createWorkerEndpointOriginV2Acceptance\s*(?:,\s*createWorkerEndpointOriginV2FormRouteAcceptance\s*,?)?\s*\}\s*from\s+["']\.\/worker-endpoint-origin-v2-acceptance\.ts["'];/u.test(
        readFileSync(path, "utf8"),
      );
    const originPublicationExports = readFileSync(path, "utf8").match(
      /export\s*\{([^}]*)\}\s*from\s+["']\.\/worker-endpoint-origin-v2-acceptance\.ts["'];/u,
    )?.[1];
    const exactOriginPublicationExtensionEdge =
      path === "src/provider-extension.ts" &&
      target === "src/worker-endpoint-origin-v2-acceptance.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      JSON.stringify(
        originPublicationExports
          ?.split(",")
          .map((name) => name.trim().replace(/^type\s+/u, ""))
          .filter((name) => name !== "")
          .sort(),
      ) ===
        JSON.stringify(
          [
            "createWorkerEndpointOriginV2FormRouteAcceptance",
            "createWorkerEndpointOriginV2FormRoutePublication",
            "createWorkerEndpointOriginV2Publication",
            "WorkerEndpointOriginV2FormRouteDeploymentResult",
            "WorkerEndpointOriginV2FormRouteEndpointResult",
            "WorkerEndpointOriginV2FormRouteNativeRows",
            "WorkerEndpointOriginV2FormRoutePreparation",
            "WorkerEndpointOriginV2FormRoutePublication",
            "WorkerEndpointOriginV2Publication",
            "WorkerEndpointOriginV2PublicationPreparation",
          ].sort(),
        );
    // This Host-only callback carries the exact accepted execution into
    // private lifecycle readbacks. Permit only this single type-only edge;
    // do not widen the general self-host composition layer to v2-contract.
    const exactExecutionTypeEdge =
      path === "src/selfhost-v2-worker-endpoint-frontend.ts" &&
      target === "src/takoform-v2/types.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      /import\s+type\s+\{\s*V2Execution\s*\}\s+from\s+["']\.\/takoform-v2\/types\.ts["'];/u.test(
        readFileSync(path, "utf8"),
      );
    // This Host-only Linux adapter reuses one pure policy decision. Other
    // domain imports remain unavailable to adapters, including this module.
    const exactLinuxContainerEgressPolicyEdge =
      path === "src/providers/linux-container-egress.ts" &&
      target === "src/container-egress-policy.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      /^import\s+\{\s*evaluateContainerEgress\s*\}\s+from\s+["']\.\.\/container-egress-policy\.ts["'];$/mu.test(
        readFileSync(path, "utf8"),
      );
    // The public operator-extension seam may name only this exact native
    // Queue authority port. Keep the dependency narrow; do not admit the
    // v2-queue-manager layer to package-surface in general.
    const queuePortExportBlock = readFileSync(path, "utf8").match(
      /export\s*\{([^}]*)\}\s*from\s+["']\.\/takoform-v2\/worker-queue-delivery\.ts["'];/u,
    )?.[1];
    const queuePortExportNames = queuePortExportBlock
      ?.split(",")
      .map((name) => name.trim().replace(/^type\s+/u, ""))
      .filter((name) => name !== "")
      .sort();
    const exactQueuePortExportNames = [
      "authorizeV2QueueBatchSend",
      "armV2QueueBatchSQLiteExternalUse",
      "cancelV2QueueBatchBeforeSend",
      "confirmV2QueueBatchRetirement",
      "confirmV2QueueBatchSQLiteDrained",
      "createV2QueueDelivery",
      "readV2QueueBatchSQLiteCustody",
      "recordV2QueueBatchTerminal",
      "V2QueueBatchExecutionIdentity",
      "V2QueueBatchSQLiteCustody",
      "V2QueueBatchTerminal",
      "verifyV2QueueSettlementScope",
    ].sort();
    const exactQueueProviderExtensionEdge =
      path === "src/provider-extension.ts" &&
      target === "src/takoform-v2/worker-queue-delivery.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      JSON.stringify(queuePortExportNames) === JSON.stringify(exactQueuePortExportNames);
    const schedulerExportBlock = readFileSync(path, "utf8").match(
      /export\s*\{([^}]*)\}\s*from\s+["']\.\/takoform-v2\/worker-queue-scheduler\.ts["'];/u,
    )?.[1];
    const schedulerExportNames = schedulerExportBlock
      ?.split(",")
      .map((name) => name.trim().replace(/^type\s+/u, ""))
      .filter((name) => name !== "")
      .sort();
    const exactSchedulerProviderExtensionEdge =
      path === "src/provider-extension.ts" &&
      target === "src/takoform-v2/worker-queue-scheduler.ts" &&
      localImportsOf(path).filter((candidate) => candidate === target).length === 1 &&
      JSON.stringify(schedulerExportNames) ===
        JSON.stringify(
          [
            "createV2QueueScheduler",
            "V2QueueSchedulerCheckpoint",
            "V2QueueSchedulerOptions",
          ].sort(),
        );
    if (
      !layer.may.includes(targetLayer.name) &&
      !exactHostAcceptanceEdge &&
      !exactHostAcceptanceCompositionTypeEdge(path, target) &&
      !exactContainerHostAcceptanceEdge &&
      !exactContainerConstructionExportEdge &&
      !exactContainerAdapterImportEdge(path, target) &&
      !exactRpFinancialOriginImportEdge(path, target) &&
      !exactSharedAppLedgerD1ExportEdge(path, target) &&
      !exactOriginDeploymentParserEdge &&
      !exactWorkerEndpointOriginConstructionEdge &&
      !exactOriginPublicationExtensionEdge &&
      !exactExecutionTypeEdge &&
      !exactLinuxContainerEgressPolicyEdge &&
      !exactQueueProviderExtensionEdge &&
      !exactSchedulerProviderExtensionEdge
    ) {
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
  "src/takoform-v2/forms/sqlite-migration-application-native.ts",
  "src/sql-sqlite.ts",
  "src/objects-mem.ts",
  // A Worker has no filesystem. Reaching this would fail at runtime rather
  // than at the gate, and only for the requests that touched it.
  "src/objects-fs.ts",
  "src/selfhost-data-root.ts",
  "src/selfhost-public-https-artifact-fetch.ts",
  "src/selfhost-public-artifact-source-composition.ts",
  // The Bun API listener's bind address; a Worker binds nothing.
  "src/selfhost-listen-address.ts",
  "src/selfhost-socket-root.ts",
  // Writing files and starting processes: a Worker can do neither.
  "src/workerd-runtime.ts",
  "src/workerd-supervisor.ts",
  "src/workerd-linux-process.ts",
  "src/workerd-worker-execution-group.ts",
  "src/selfhost-v2-worker-endpoint-upstream-websocket.ts",
  "src/workerd-worker-runtime-owner.ts",
  // Health dispatch observes the Bun process's private startup-restore and
  // workerd-supervisor lifecycle; it is not a Worker health route.
  "src/selfhost-health.ts",
  "src/selfhost-health-signals.ts",
  "src/selfhost-entry-shutdown.ts",
  "src/selfhost-entry-process-shutdown.ts",
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
  // Applies native Linux network namespace/firewall policy, outside Workers.
  "src/providers/linux-container-egress.ts",
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

// The ungated Customer tracked-execution form exists only for the current-consent
// executor, whose transport reaches nothing but Root's framing receiver and which
// gates the Money writer origin and fenced shape itself. No other file may name it.
const ROOT_RECEIVER_TRACKED_EXECUTION = "createCustomerTrackedExecutionOverRootReceiver";
const ROOT_RECEIVER_TRACKED_EXECUTION_FILES = [
  "src/shared-financial-customer-tracked-execution.ts",
  "src/financial-current-consent-customer.ts",
];
for (const root of roots) {
  for (const path of walk(root)) {
    if (!path.endsWith(".ts") || ROOT_RECEIVER_TRACKED_EXECUTION_FILES.includes(path)) continue;
    if (path === "scripts/check-imports.ts") continue;
    if (readFileSync(path, "utf8").includes(ROOT_RECEIVER_TRACKED_EXECUTION))
      violations.push(
        `${path}: ${ROOT_RECEIVER_TRACKED_EXECUTION} is the current-consent executor's form only`,
      );
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

/** Only fixed SQL compilers may mint; Host/Form hooks cannot supply statements. */
function checkHostAcceptanceImports(path: string): void {
  const source = readFileSync(path, "utf8");
  const owners = [
    "src/takoform-v2/host-acceptance.ts",
    "src/worker-endpoint-origin-v2-acceptance.ts",
    "src/takoform-v2/container-owner-schema.ts",
  ];
  // White-box Core/App boundary tests construct hostile and neutral witnesses.
  // This names only those two tests; runtime callers remain the fixed compilers.
  const whiteBoxTests = [
    "tests/takoform-v2-host-delete-acceptance.test.ts",
    "tests/v2-container-endpoint-app-composition.test.ts",
  ];
  const mayMint = owners.includes(path) || whiteBoxTests.includes(path);
  if (
    path !== "scripts/check-imports.ts" &&
    /\bprepareV2HostAcceptance\b/u.test(source) &&
    !mayMint
  ) {
    violations.push(
      `${path}: prepared Host acceptance mint belongs only to fixed source compilers`,
    );
  }
  const target = "src/takoform-v2/host-acceptance.ts";
  const references = localImportsOf(path).filter((value) => value === target);
  if (references.length === 0) return;
  const named = [
    ...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+(["'])([^"']+)\2/gu),
  ].filter(
    (value) => normalize(relative(resolve("."), resolve(dirname(path), value[3] ?? ""))) === target,
  );
  if (!mayMint && named.some((value) => /\bprepareV2HostAcceptance\b/u.test(value[1] ?? "")))
    violations.push(
      `${path}: prepared Host acceptance mint import is private to fixed source compilers`,
    );
  if (named.length !== references.length) {
    violations.push(
      `${path}: Host acceptance contract permits named imports only, no re-export or namespace/dynamic access`,
    );
  }
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
