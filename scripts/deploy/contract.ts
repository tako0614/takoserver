const routineFailure =
  "Pre-upload failures touch nothing. An upload acknowledgement failure is indeterminate; " +
  "the command never retries and directs the operator to the same surface's --status readback.";
const highRiskFailure =
  "Pre-mutation failures touch nothing. A mutation acknowledgement failure is indeterminate; " +
  "the command stops without retry and requires authoritative --status before forward repair.";
const exactSource =
  "The explicit 40-hex commit must equal HEAD. Production requires a clean main equal to freshly " +
  "fetched origin/main, or a clean HEAD proven reachable from an exact remote ref.";
const review =
  "TAKOSERVER_INDEPENDENT_REVIEW names the reviewer that did not author the change and is printed " +
  "without granting deploy authority.";
const legacyServiceBindingName = () => ["HOST", "RUNTIME", "MATERIALIZER"].join("_");
const cloudflareTokenInput =
  "Input contract: `CLOUDFLARE_API_TOKEN` is required for both `--status` and `--apply` in every supported environment.";
const routineWorkerAuthInput =
  "Input contract: explicit `CLOUDFLARE_API_TOKEN` is required for both `--status` and `--apply` in every environment. " +
  "Wrangler OAuth is refused because its supported readers cannot prove workers.dev enabled state or exhaustive " +
  "custom-domain inventory; the deploy tool never extracts an OAuth credential.";
const integrationE2eCloudflareTokenInput =
  "Input contract: `CLOUDFLARE_API_TOKEN` is required for each `--issue`, `--status`, and `--revoke` action; all three actions are integration-only.";
const applyReviewInput =
  "`TAKOSERVER_INDEPENDENT_REVIEW` is required for `--apply` only; `--status` does not read it.";
const formAuthorityPrivateJwkInput =
  "`TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` is required for both `--status` and `--apply`; both actions are integration-only.";
const integrationE2ePrivateJwkInput =
  "`TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH` is required for each `--issue`, `--status`, and `--revoke` action; all three actions are integration-only.";
const integrationE2eOutputDirectoryInput =
  "`TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` is required for each `--issue`, `--status`, and `--revoke` action; all three actions are integration-only.";
const integrationE2eReviewInput =
  "`TAKOSERVER_INDEPENDENT_REVIEW` is required for `--issue` and `--revoke`; `--status` does not read it.";
const rehearsalReceiptInput =
  "`TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH` is required for `--apply` in `rehearsal` and `production`; integration `--apply` and every `--status` action do not read it.";
const signingPublicJwkInput =
  "`TAKOSERVER_SIGNING_PUBLIC_JWK_PATH` is required for `--apply` only; `--status` does not read it.";
const signingPrivateJwkInput =
  "`TAKOSERVER_SIGNING_PRIVATE_JWK_PATH` is required for `--apply` only; `--status` does not read it.";
const signingNextPrivateJwkInput =
  "`TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH` is required for `--apply` only; `--status` does not read it.";
const hostedTokenInput =
  "`TAKOSERVER_HOSTED_TOKEN_PATH` is required for `--apply` only; `--status` does not read it.";
const operatorPrivateJwkInput =
  "`TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` is required for `--apply` only; `--status` does not read it and this surface is integration-only.";

function inputContractWithToken(
  tokenRequirement: string,
  ...requirements: readonly string[]
): string {
  return ` ${[tokenRequirement, ...requirements].join(" ")}`;
}

function inputContract(...requirements: readonly string[]): string {
  return inputContractWithToken(cloudflareTokenInput, ...requirements);
}

/** Side-effect-free live declaration for the repository's only deploy entrypoint. */
export const DEPLOY_CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: "takoserver-worker",
      target: "cloudflare-worker:environment-selected-takoserver-worker",
      covers: [
        "src",
        "wrangler.jsonc",
        "scripts/build-worker.ts",
        "scripts/deploy.ts",
        "scripts/deploy/worker.ts",
        "scripts/deploy/worker-authority-paths.ts",
        "scripts/deploy/wrangler-state.ts",
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN"],
      triggers: [],
      obligations: {
        provenance:
          `${exactSource} The owner gate runs once, then the exact link-free bundle and realized ` +
          "configuration are sealed and requalified immediately before one upload. Every environment " +
          "uses explicit `CLOUDFLARE_API_TOKEN` and direct-REST live state; stored OAuth is not a topology authority.",
        "post-conditions":
          "Authoritative deployment/version state, exact binding/configuration closure and the " +
          "public product probe identify the selected commit and uploaded artifact. Non-production " +
          "routine publication uses one versions upload followed by one explicit 100 percent deployment " +
          "with a topology-neutral config, so routes, domains and triggers are never mutated. The exact " +
          "pinned predecessor closure is re-read immediately after upload and before traffic deployment.",
        reversal:
          "The immediately previous Cloudflare Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${routineFailure} The surface refuses pending migrations and any configuration, secret, ` +
          "signing or Hosted topology drift before upload. A diff that changes authentication, " +
          "authorization or the deploy mechanism is refused and routed to the authority cutover surface. " +
          "Wrangler JSON framing, the upload-to-deploy predecessor re-fence, publication identities and " +
          "final public smoke are strict; any drift or readback mismatch fails closed. A post-upload " +
          "re-fence failure leaves only the acknowledged inactive Version and does not change traffic. " +
          routineWorkerAuthInput,
      },
    },
    {
      surface: "takoserver-worker-authority-cutover",
      target: "cloudflare-worker:environment-selected-takoserver-worker-authority-code-and-config",
      covers: [
        "src",
        "wrangler.jsonc",
        "scripts/build-worker.ts",
        "scripts/deploy.ts",
        "scripts/deploy/worker.ts",
        "scripts/deploy/worker-authority-paths.ts",
        "scripts/deploy/realized-config.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/worker-state.ts",
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} The scoped owner gate runs once, then the exact link-free bundle and ` +
          "realized configuration are sealed and requalified immediately before one upload.",
        "post-conditions":
          "Authoritative deployment/version state, exact binding/configuration closure and the " +
          "public product probe identify the selected authority-sensitive commit and uploaded artifact. " +
          "Integration JIT enablement adds exactly its environment, dedicated public JWK, fixed organization, " +
          "source commit and artifact digest plain-text bindings as one all-or-none profile. Every Form-authority " +
          "environment separately seals handler/provider payload P, derives semantic I from P plus the adapter/capability and exact Form package-operation set, embeds P/capability/I, then hashes outer artifact A.",
        reversal:
          "The immediately previous Cloudflare Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${highRiskFailure} Pending schema and any configuration, secret, signing or Hosted topology ` +
          "drift are still refused. Integration alone may bridge exact absence to the complete JIT " +
          "credential-authority profile; partial fields, wrong organization, reused keys and provenance " +
          "mismatch are refused. " +
          "The named --legacy-host-runtime-predecessor-version transition profile is the only " +
          "path that may carry the observed legacy service binding and Hosted secret into a " +
          "candidate; ordinary target realization remains free of both retired fields." +
          inputContract(applyReviewInput),
        "production-selector":
          "Production accepts this transition only with the exact pinned predecessor Version ID, " +
          "a clean/reachable exact commit and independent review; ordinary takoserver-worker deploy " +
          "cannot bypass the selector or carry the retired edge.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-form-authority-identity-probe",
      target: "cloudflare-worker:environment-selected-read-only-public-identity-rpc-probe",
      covers: [
        "src/entry-form-authority-identity-probe.ts",
        "src/form-authority-identity-probe.ts",
        "src/public-host-identity.ts",
        "src/public-worker-implementation.ts",
        "wrangler.form-authority-identity-probe.jsonc",
        "scripts/deploy/form-authority-capability.ts",
        "scripts/deploy/form-authority-identity-probe.ts",
        "scripts/deploy/target.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} The minimal probe bundle, one public identity service binding and one ` +
          "target Host id are sealed before one upload.",
        "post-conditions":
          "Authoritative Worker history and exact binding closure identify the upload. Its permanent " +
          "workers.dev endpoint must actively return the exact PublicHostIdentity@v2 value read through " +
          "the named public Worker RPC; no storage, secret, mutation RPC, route or custom domain exists.",
        reversal:
          "The immediately previous identity probe Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${highRiskFailure} A missing, thrown, malformed or identity-inconsistent public RPC response ` +
          "is unavailable and prevents Form-authority readiness." +
          inputContract(applyReviewInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-form-authority-worker",
      target: "cloudflare-worker:environment-selected-route-less-form-authority",
      covers: [
        "src/entry-form-authority-worker.ts",
        "src/takoform/host-admission-coordinator.ts",
        "src/takoform/host-admission-endpoint.ts",
        "src/takoform/form-authority-verification.ts",
        "src/takoform/implementation-catalog.ts",
        "src/public-worker-implementation.ts",
        "src/form-authority-public-identity.ts",
        "src/public-host-identity.ts",
        "wrangler.form-authority.jsonc",
        "scripts/deploy/form-authority-capability.ts",
        "scripts/deploy/form-authority.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} The exact route-less Worker bundle, target D1/R2 bindings, Host identity ` +
          "and code-derived capability manifest are sealed before one upload. The public Worker's " +
          "internal PublicHostIdentity@v2 RPC is the runtime authority for its served Version, artifact, and implementation identities.",
        "post-conditions":
          "Authoritative Worker history must name the exact commit/artifact. The immutable Version " +
          "must contain exactly STATE_DB, OBJECTS, PUBLIC_HOST_IDENTITY and the three plain-text " +
          "variables TAKOSERVER_ENVIRONMENT, TAKOSERVER_FORM_AUTHORITY_HOST_ID and " +
          "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST, with no public Worker identity pins, " +
          "secret, route, or public-domain ownership. Status is ready only after the permanent minimal " +
          "identity probe actively calls PublicHostIdentity@v2 and matches live Version/A/P/capability/I.",
        reversal:
          "The immediately previous Form authority Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${highRiskFailure} Deploying this shell does not enable Form mutation: RPC apply remains ` +
          "fail-closed until released Form package verification is present. Admission policy and private handle issuance remain Takoserver Host-owned." +
          inputContract(applyReviewInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-integration-form-authority-worker",
      target: "cloudflare-worker:integration-route-less-form-authority-fixture",
      covers: [
        "src/entry-integration-form-authority-worker.ts",
        "src/form-authority-worker-composition.ts",
        "src/takoform/integration-operator-endpoint.ts",
        "src/generated/takoform-integration-form-packages.ts",
        "wrangler.integration-form-authority.jsonc",
        "scripts/deploy.ts",
        "scripts/deploy/form-authority.ts",
        "scripts/deploy/form-authority-scope-transition.ts",
        "scripts/deploy/target.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. The generated exact 12-package unsigned fixture corpus, ` +
          "route-less bundle, target D1/R2 bindings, public identity RPC, and canonical capability manifest are sealed before one upload.",
        "post-conditions":
          "Authoritative Worker history and exact binding closure identify the uploaded integration fixture; " +
          "the closure includes PUBLIC_HOST_IDENTITY, the dedicated operator public JWK, and the exact " +
          "operator tenant and Space plain-text bindings, with no public Worker Version or artifact pin. " +
          "Scope status is exact-target or, only with the " +
          "reviewed descriptor, exact-transition-predecessor; output binds the descriptor digest without its path. " +
          "The Worker owns no public domain, and every " +
          "authority receipt identifies Takoserver Host policy plus integration-fixture verification and remains non-production.",
        reversal:
          "The immediately previous integration Form authority Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${highRiskFailure} The entry hard-refuses every environment except integration before ` +
          "reading D1 or R2 bindings. It independently rejects every signed plan/apply/readback body " +
          "outside its sealed tenant/Space; partial Form mutation requires authoritative readback and replan. " +
          "A one-time identity migration accepts only a fully verified legacy exact pin, without relying on " +
          "that public Version's position in deployment history, and removes both identity pins in one upload. " +
          "A scope transition accepts only the exact configured predecessor, uploads target scope once, " +
          "refuses absent/bootstrap, stale-public, third-scope and already-target apply, and settles a lost " +
          "acknowledgement through status without retry." +
          inputContract(applyReviewInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-integration-form-authority-operator-worker",
      target: "cloudflare-worker:integration-authenticated-form-authority-operator-gateway",
      covers: [
        "src/entry-integration-form-authority-operator-worker.ts",
        "src/integration-form-authority-gateway.ts",
        "src/public-host-identity.ts",
        "wrangler.integration-form-authority-operator.jsonc",
        "scripts/deploy.ts",
        "scripts/deploy/form-authority.ts",
        "scripts/deploy/form-authority-scope-transition.ts",
        "scripts/deploy/target.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. The gateway bundle, dedicated operator public key, ` +
          "exact tenant/Space, exact custom domain, private authority service binding and current " +
          "public identity RPC binding are sealed before one upload. The live PublicHostIdentity@v2 " +
          "result remains request-time authority rather than immutable gateway configuration.",
        "post-conditions":
          "Authoritative Worker history and exhaustive domain/binding state must identify the exact " +
          "custom-domain gateway, route-less integration authority " +
          "dependency and exact operator tenant/Space. A clean first upload is allowed only when both " +
          "the script and configured custom domain are absent; the same exact closure is read back after upload. " +
          "During a named scope transition, the route-less authority must already be exact-target before " +
          "the gateway advances once from exact-transition-predecessor to exact-target.",
        reversal:
          "The immediately previous operator gateway Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${highRiskFailure} The gateway hard-refuses non-integration environments before key or ` +
          "service reads, accepts only short-lived body/method/path-bound Ed25519 proofs, independently " +
          "rejects every body outside its sealed tenant/Space, and reads live public Host identity before " +
          "every RPC; the route-less authority independently rereads and verifies that same proof identity. " +
          "Foreign domain ownership and every script/domain partial topology are refused. " +
          "Transition status rejects stale-public, third-scope, absent/bootstrap and history-based roll-forward; " +
          "already-target apply is a refused no-op and lost acknowledgement is status-only reconciliation." +
          inputContract(applyReviewInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-integration-form-authority",
      target: "https:integration-signed-form-authority-plan-apply-readback",
      covers: [
        "scripts/deploy/form-authority-invoke.ts",
        "scripts/deploy/form-authority-scope-transition.ts",
        "src/form-authority-operator-proof.ts",
        "src/takoform/host-admission-coordinator.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy.ts",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH",
        "TAKOSERVER_INDEPENDENT_REVIEW",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. Exhaustive gateway/authority/public-Worker readback ` +
          "must identify that commit before the owned 0600 Ed25519 key signs any request.",
        "post-conditions":
          "Status performs one signed authoritative readback. Apply obtains one signed canonical plan, " +
          "passes that exact plan digest once to apply, and finishes with a separately signed readback of the exact 12 Space-scoped non-production fixtures.",
        reversal:
          "Authority events are repaired forward: an acknowledged partial apply preserves every sanitized " +
          "action receipt and its next-plan digest for an explicit later readback/replan.",
        "failure-handling":
          "No HTTP mutation is retried. An apply transport or acknowledgement failure is indeterminate; " +
          "run status for authoritative readback before an explicit fresh apply. An acknowledged partial " +
          "apply performs its separate readback and exits as a verification failure with only sanitized " +
          "receipts and next-plan diagnostics. Assertion and private-key bytes are always redacted. Normal " +
          "activation never accepts the scope-transition selector." +
          inputContract(applyReviewInput, formAuthorityPrivateJwkInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-integration-form-authority-deactivation",
      target: "https:integration-signed-form-authority-deactivation-plan-apply-readback",
      covers: [
        "scripts/deploy/form-authority-invoke.ts",
        "scripts/deploy/form-authority-scope-transition.ts",
        "src/form-authority-operator-proof.ts",
        "src/takoform/host-admission-coordinator.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy.ts",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH",
        "TAKOSERVER_INDEPENDENT_REVIEW",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. Exhaustive gateway/authority/public-Worker readback ` +
          "must identify that commit before the owned 0600 Ed25519 key signs a deactivation request. " +
          "A named scope transition additionally requires an owned exact-0600 link-free bounded descriptor " +
          "under an owned exact-0700 symlink-free parent outside every Git worktree; its digest, Host, " +
          "predecessor and exact target scope are verified without emitting its path.",
        "post-conditions":
          "Status performs one signed authoritative readback. Apply obtains one signed canonical " +
          "deactivation plan, passes that exact plan digest once to apply, and finishes with a " +
          "separately signed readback proving every exact 12 Space-scoped fixture is absent or inactive. " +
          "With a transition descriptor, both gateway and route-less authority must have a verified dynamic or legacy exact identity profile and " +
          "exact-transition-predecessor and only predecessor desiredActive:false is signed. Success projects " +
          "only the transition digest, binding profile, and scope-redacted boolean/digest readback summary.",
        reversal:
          "Deactivation is append-only; rollback is an explicit normal Form-authority reactivation, " +
          "not a Worker-version rollback.",
        "failure-handling":
          "No HTTP mutation is retried. An apply transport or acknowledgement failure is indeterminate; " +
          "run status for authoritative readback before making an explicit fresh deactivation decision. " +
          "An acknowledged partial apply preserves only sanitized receipts and next-plan diagnostics. " +
          "Assertion and private-key bytes are always redacted. Mixed predecessor/target topology, stale " +
          "public closure, reverse, activation, and any third scope are refused before signing; refusal " +
          "output never includes raw binding JSON or an actual, predecessor, or foreign scope." +
          inputContract(applyReviewInput, formAuthorityPrivateJwkInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-integration-e2e-credentials",
      target: "https:integration-exact-live-worker-jit-api-key-authority",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/integration-e2e-credentials.ts",
        "scripts/integration-e2e-credentials.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/worker-state.ts",
        "src/integration-e2e-credential-authority.ts",
        "src/entry-worker.ts",
        "migrations/0030_integration_e2e_credential_pairs.sql",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH",
        "TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY",
        "TAKOSERVER_INDEPENDENT_REVIEW",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          "Integration only. Cloudflare's immutable current Worker Version must prove the selected " +
          "commit, annotated artifact digest, exact five-variable JIT authority closure and live Version " +
          "before the owner writes a 0600 target snapshot and invokes the helper once.",
        "post-conditions":
          "Each issue durably publishes operation coordinates, then writes distinct 3600-second writer and " +
          "external-evidence secrets plus pair metadata under owner-only custody. Status is a value-free signed " +
          "readback of both exact roles. Revoke settles both ids and requires a terminal signed absence readback " +
          "before deleting all three owned local files.",
        reversal:
          "The issued pair is reversed only by this surface's exact revoke action. Status and revoke use the " +
          "current dedicated authority while preserving issuance provenance, so a Worker Version change cannot " +
          "strand the old pair. The authority key remains separate from both issued API keys.",
        "failure-handling":
          "The owner never replays issue after an indeterminate secret-bearing mutation. Signed status is " +
          "required before any exact idempotent revoke settlement; a revoking fence may be resumed without " +
          "minting another pair. A partial pair is visible and fenced revoke wins over delayed issue. " +
          "Private JWK and API-key bytes never enter argv, Worker config, stdout or diagnostics; evidence never " +
          "enters a Provider or runner, and a wrong organization, partial profile or key reuse fails closed." +
          inputContractWithToken(
            integrationE2eCloudflareTokenInput,
            integrationE2eReviewInput,
            integrationE2ePrivateJwkInput,
            integrationE2eOutputDirectoryInput,
          ),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-site",
      target: "cloudflare-pages:environment-selected-takoserver-site",
      covers: [
        "src/landing.ts",
        "scripts/build-site.ts",
        "scripts/deploy.ts",
        "scripts/deploy/static.ts",
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["build:site", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN"],
      triggers: [],
      obligations: {
        provenance:
          `${exactSource} The scoped site build runs once into a fresh link-free directory; its ` +
          "sealed digest is sent by one Pages upload.",
        "post-conditions":
          "The immutable Pages deployment URL is read once and must be byte-exact with the sealed index. " +
          "Production additionally requires a byte-exact https://takoserver.com/ readback.",
        reversal:
          "The previous Pages deployment id from authoritative project history is printed as the rollback target.",
        "failure-handling": routineFailure + inputContract(),
      },
    },
    {
      surface: "takoserver-console",
      target: "cloudflare-worker:environment-selected-takoserver-console",
      covers: [
        "console",
        "scripts/build-console.ts",
        "scripts/deploy.ts",
        "scripts/deploy/console.ts",
        "scripts/deploy/cloudflare-state.ts",
      ],
      requiresScripts: ["build:console", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN"],
      triggers: [],
      obligations: {
        provenance:
          `${exactSource} The scoped Console build runs once and the sealed link-free assets are ` +
          "sent by one Worker upload whose configuration contains no route or domain mutation.",
        "post-conditions":
          "Exhaustive paginated domain state must name the same pre-existing Console owner before " +
          "and after upload, and the public console.js must be byte-exact.",
        reversal:
          "The previous Console Worker version is printed; the command never changes its domain owner.",
        "failure-handling": routineFailure + inputContract(),
      },
    },
    {
      surface: "takoserver-d1-schema",
      target: "cloudflare-d1:environment-selected-takoserver-state",
      covers: ["migrations", "scripts/deploy/schema.ts", "scripts/deploy/d1.ts"],
      requiresScripts: ["check:migrations", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH",
      ],
      triggers: ["irreversible"],
      obligations: {
        provenance:
          `${exactSource} Migration names, bytes, lineage and canonical schema shape are digested ` +
          "before the forward-only apply.",
        "post-conditions":
          "D1 lineage and canonical schema shape are read authoritatively after the deliberate last mutation.",
        reversal:
          "There is no down migration. Failure is repaired forward from the authoritative D1 lineage and schema shape.",
        "failure-handling":
          highRiskFailure + inputContract(applyReviewInput, rehearsalReceiptInput),
        "pre-mutation-proof":
          "Rehearsal writes a 0600 receipt outside every repository. Production requires that exact " +
          "commit, migration digest, pre-shape and expected post-shape before applying the same bytes.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-signing-key-register",
      target: "cloudflare-d1:environment-selected-public-signing-key",
      covers: ["scripts/deploy/signing.ts", "scripts/deploy/d1.ts"],
      requiresScripts: ["deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_SIGNING_PUBLIC_JWK_PATH",
      ],
      triggers: ["irreversible", "authority", "published-identity"],
      obligations: {
        provenance:
          "The selected target names the key id and the input file must contain only its exact Ed25519 public JWK; no private member is accepted or read.",
        "post-conditions":
          "D1 returns exactly one byte-identical public key row for the selected id; this surface performs no Worker secret or configuration mutation.",
        reversal:
          "Registration is append-only. A mistaken public identity is not overwritten or deleted; repair forward with a new key id.",
        "failure-handling":
          highRiskFailure + inputContract(applyReviewInput, signingPublicJwkInput),
        "pre-mutation-proof":
          "The exact public-JWK digest, canonical Ed25519 shape and key-id absence are proven, then absence is rechecked immediately before insert.",
        "independent-review": review,
        "no-overwrite":
          "The selected key id must be absent. Registration uses an insert-only statement; an existing identical or different row is never rewritten.",
      },
    },
    {
      surface: "takoserver-signing-repair",
      target: "cloudflare-worker-secret:environment-selected-current-signing-key",
      covers: [
        "scripts/deploy/signing.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/worker-state.ts",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_SIGNING_PRIVATE_JWK_PATH",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          "The current key id must already exist in D1 and the owned 0600 private JWK must prove its exact public half before stdin-only secret repair.",
        "post-conditions":
          "The exact Worker secret-name inventory and a new immutable version are read back while code/config stay unchanged, and the D1 row remains byte-identical.",
        reversal:
          "Reapply the previous exact secret only through this same repair surface; the command prints no secret bytes.",
        "failure-handling":
          highRiskFailure + inputContract(applyReviewInput, signingPrivateJwkInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-signing-rotation",
      target: "cloudflare-worker-secret:environment-selected-next-signing-key",
      covers: ["scripts/deploy/signing.ts", "scripts/deploy/worker-live.ts"],
      requiresScripts: ["deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH",
      ],
      triggers: ["authority", "published-identity"],
      obligations: {
        provenance:
          "The target explicitly names different current and next ids; both public keys must be pre-registered and the owned 0600 next private JWK must prove the next public half. " +
          "The ordinary path requires a canonical current-key Version even when the Hosted secret is present. " +
          "Only integration may instead select the exact workers/triggered_by=secret H profile and its strict canonical C predecessor. " +
          "Status and apply branch exhaustively on that exact annotation profile: mixed or unknown inventories fail before build/upload. " +
          "Every history entry has a valid shape and UUID Version, deployment ids are globally unique, and only the inferred C-to-H or C-to-H-to-S prefix requires unique Version ids; older rollback reuse remains valid outside it.",
        "post-conditions":
          "The immutable Worker version explicitly names the next id with the exact secret inventory and unchanged code, while both public rows remain byte-identical. " +
          "An integration H status remains ready=false and repair-required while naming rotationApplyReady separately; H-to-S performs exactly one canonical deploy with --secrets-file and no classic secret put/delete mutation.",
        reversal:
          "The explicit current key remains pre-registered, so an operator may run a separately reviewed inverse rotation; no silent switch or key deletion occurs.",
        "failure-handling":
          highRiskFailure + inputContract(applyReviewInput, signingNextPrivateJwkInput),
        "independent-review": review,
        "no-overwrite":
          "Rotation consumes a separately pre-registered next id, retains the current public row, and never overwrites either identity.",
      },
    },
    {
      surface: "takoserver-hosted-token-cutover",
      target: "cloudflare-worker-secret:environment-selected-hosted-token",
      covers: [
        "scripts/deploy/hosted.ts",
        "scripts/deploy/signing.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/worker-state.ts",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_HOSTED_TOKEN_PATH",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          "The owned 0600 token file is sent only on stdin to the independent public Worker. " +
          "During the temporary integration transition, a provider-created H Version is " +
          "trusted only as the exact C-to-H direct successor: C has the canonical " +
          "workers/message commit/digest plus workers/triggered_by=version_upload and closure without the named secret, H has only " +
          "workers/triggered_by=secret, both have equal resources.script.etag, and the " +
          "secret/domain inventory and deployment history are exact and stable. The trigger " +
          "annotation alone is not provenance. Rehearsal and production reject H even with a " +
          "canonical D1 row; canonical token-present proof-only apply is available in every environment " +
          "after exact local and remote source qualification, with production-strength qualification " +
          "outside integration. Its strict status remains proof-pending and ready=false, and reports " +
          "proofApplyReady only from the selected commit and source-independent live closure. Secret " +
          "presence alone never selects the bridge. Fresh C-to-H apply is also " +
          "integration-only: rehearsal/production C status reports cutoverApplyReady=false and " +
          "ready=false, while apply refuses after minimal Worker-state classification and before " +
          "source, reviewer, token-file, D1-row, proof-tenant, mutation, or HTTP-proof work. " +
          "Immediately before the " +
          "first secret put, the exact C history, commit, digest, script etag, D1 signing row, " +
          "and proof tenant are requalified.",
        "post-conditions":
          "The bounded sponsorship route accepts the exact token and returns a credential whose signature matches the current D1 public key. " +
          "Status reports an exact H state as unattributed and repair-required; recovery performs " +
          "proof only after exact source and independent-review qualification (zero additional " +
          "secret mutations), and integration signing rotation may repair attribution with one " +
          "canonical H-to-S upload. After proof, H closure/history/inventory/domains and the D1 row " +
          "are read back again. Canonical proof-only apply performs zero secret, build, dry-run, upload, or configuration mutation; " +
          "it validates the owned 0600 token, active current D1 row, stable tenant, exact JWT kid, claims, " +
          "lifetime and signature, and re-reads canonical Version/history/commit/digest/script identity, " +
          "binding/secret/domain closure and the byte-identical D1 row around the one HTTP proof. Its " +
          "sanitized receipt reports mutationApplied=false, functionalProofPending=false, repairRequired=false, and ready=true. " +
          "This temporary bridge is removed after canonical integration cutover.",
        reversal:
          "Proof-only apply has no mutation to reverse. For a fresh integration cutover, remove the newly added named secret through an explicit Cloudflare secret deletion; token bytes are never printed.",
        "failure-handling": highRiskFailure + inputContract(applyReviewInput, hostedTokenInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-host-runtime-topology-retirement",
      target: "cloudflare-worker:environment-selected-hosted-edge-topology-retirement",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/retirement.ts",
        "scripts/deploy/realized-config.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/worker-state.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          `${exactSource} The candidate's sealed bundle must be byte-identical to the currently ` +
          `served predecessor; the transition config removes only ${legacyServiceBindingName()}.`,
        "post-conditions":
          "Authoritative history must identify the exact direct successor, with unchanged commit " +
          `and bundle digest, no ${legacyServiceBindingName()} binding, and the Hosted secret still present.`,
        reversal:
          "The exact direct candidate predecessor Version is redeployed through provider history; no new bundle is built.",
        "failure-handling":
          `${highRiskFailure} A lost acknowledgement is settled by this surface's status readback; ` +
          "wrong service identity, extra binding, non-direct history or changed bytes fail closed." +
          inputContract(applyReviewInput),
        "pre-mutation-proof":
          "Status must prove the candidate is current, the exact legacy service binding is present once, and the Hosted secret remains present.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-hosted-token-retirement",
      target: "cloudflare-worker-secret:environment-selected-hosted-token-retirement",
      covers: ["scripts/deploy.ts", "scripts/deploy/retirement.ts"],
      requiresScripts: ["deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          "Forward retirement deletes only the named Hosted secret. Cloudflare creates a new direct-successor Worker Version; its commit, bundle digest and non-secret closure must remain byte-identical with the topology-retired predecessor.",
        "post-conditions":
          "Authoritative secret inventory omits only TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN and the current Version is the exact direct successor of the topology-retired predecessor, with unchanged commit and bundle digest.",
        reversal:
          "Forward-only; restoration requires a separately reviewed dedicated surface. This surface never re-puts the retired secret.",
        "failure-handling":
          `${highRiskFailure} A lost acknowledgement is settled by status accepting only the exact ` +
          "direct successor; a secret-created Version without the exact canonical annotation inventory is " +
          "reported as token-retired-unattributed-successor with ready=false and repairRequired=true. " +
          "The surface refuses to run before topology retirement and never reports a partial delete as complete." +
          inputContract(applyReviewInput),
        "pre-mutation-proof":
          "Status must prove the direct candidate successor has no Hosted service binding and still carries the Hosted secret before deletion.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-worker-retirement-attribution-repair",
      target: "cloudflare-worker:environment-selected-hosted-token-retirement-attribution-repair",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/retirement.ts",
        "scripts/deploy/worker-artifact.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/worker-state.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN"],
      triggers: [],
      obligations: {
        provenance:
          `${exactSource} The explicit L→C→T→R selectors, trusted T annotation/script identity ` +
          "and one sealed bundle from the selected commit are rechecked before one upload.",
        "post-conditions":
          "Authoritative history must identify one direct successor of the selected unattributed R; " +
          "its canonical commit, bundle digest, provider script identity, exact non-secret closure, " +
          "retired service/secret absence and public product probe must all match trusted T.",
        reversal:
          "This is a forward attribution repair with no reverse mutation; a mistaken publication is " +
          "repaired by a separately selected higher Worker Version.",
        "failure-handling":
          `${routineFailure} The surface never retries a lost upload acknowledgement, never deletes or ` +
          "restores a secret, and refuses an unrelated provider-history advance or weak/missing script identity." +
          inputContract(),
      },
    },
    {
      surface: "takoserver-integration-operator-identity",
      target: "cloudflare-worker:integration-takoserver-operator-identity",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/identity.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy/realized-config.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          "Integration only. The selected commit must already be the served Worker commit. The " +
          "owner gate rebuilds it once, requires the exact served bundle digest, and proves the " +
          "owned 0600 private JWK against the target's exact public Ed25519 JWK.",
        "post-conditions":
          "One immutable Worker Version adds only OPERATOR_IDENTITY_PUBLIC_JWK. Code, every other variable " +
          "and binding, secrets, domains, D1, R2 and Hosted topology remain exact; a short-lived " +
          "redacted operator assertion must create a session whose redacted bearer succeeds at /v1/me, " +
          "is then revoked, and fails a replay.",
        reversal:
          "Before removing this identity, revoke every session and API key issued through it. " +
          "Identity removal is a separate reviewed configuration transition; this surface never deletes it.",
        "failure-handling":
          highRiskFailure + inputContract(applyReviewInput, operatorPrivateJwkInput),
        "independent-review": review,
      },
    },
  ],
} as const;
