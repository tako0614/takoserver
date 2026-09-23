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
  "Input contract: an explicit `CLOUDFLARE_API_TOKEN` always wins. In `integration`, when it is absent, " +
  'the deploy process may consume only the exact `{type:"oauth",token}` result of `wrangler auth token --json`; ' +
  "the bearer is used only by in-process direct REST readers and is never logged, serialized, or passed to Wrangler " +
  "children (which use their stored OAuth profile). The OAuth extractor sets `WRANGLER_WRITE_LOGS=false` and " +
  "passes only that explicit Wrangler behavior flag as its credential child-environment overlay; ambient API keys, " +
  "emails, token variants, and unrelated secrets are stripped. `rehearsal` and `production` still require the explicit API token.";
const routineWorkerAuthInput =
  "Input contract: the same credential resolver applies to this Worker surface: an explicit `CLOUDFLARE_API_TOKEN` " +
  "always wins; integration may consume the exact Wrangler OAuth token for direct REST readback only, while Wrangler " +
  "children use stored OAuth with no token environment variable (the extractor disables Wrangler disk logs with " +
  "`WRANGLER_WRITE_LOGS=false` and passes no competing or unrelated credential variables); rehearsal and production " +
  "require the explicit token.";
const integrationE2eCloudflareTokenInput =
  "Input contract: an explicit `CLOUDFLARE_API_TOKEN` always wins; integration may resolve an absent token through the " +
  "exact Wrangler OAuth JSON result for direct REST readback while Wrangler children use stored OAuth without a token " +
  "environment variable. The OAuth extractor sets `WRANGLER_WRITE_LOGS=false` and strips competing or unrelated " +
  "credential variables. Each action is integration-only.";
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
const sponsorshipCredentialPrivateJwkInput =
  "`TAKOSERVER_SPONSORSHIP_CREDENTIAL_PRIVATE_JWK_PATH` is required for `--apply` only; its public half is target-pinned and append-only registered with exact readback. `--status` does not read the private file.";
const sponsorshipReceiptPrivateJwkInput =
  "`TAKOSERVER_SPONSORSHIP_RECEIPT_PRIVATE_JWK_PATH` is required for `--apply` only; `--status` does not read it.";
const topologyAuditCredentialInput =
  "`TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL` must name an owned absolute 0600 credential file for every action; it is distinct from the deployment token and may only read that exact token's active policy and permission-group metadata.";
const sponsorshipCutoverProofInput =
  "`TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH` and `TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256` select and confirm the exact owned 0600 proof; no local consumption path is accepted.";
const signingNextPrivateJwkInput =
  "`TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH` is required for `--apply` only; `--status` does not read it.";
const operatorPrivateJwkInput =
  "`TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` and `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` are required for `--apply` only; `--status` does not read either file. Every action also requires one exact `--organization=<org_...>` selector.";
const orgApiKeyInput =
  "Input contract: `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` and " +
  "`TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` are required for each `--mint`, `--status` and " +
  "`--revoke` action; `TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY` for `--mint` only; " +
  "`TAKOSERVER_INDEPENDENT_REVIEW` for `--mint` and `--revoke` only. No Cloudflare credential is " +
  "read: this surface acts through the Host's own published organization API, not through the provider.";
const closureSecretDirectoryInput =
  "`TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY` is required for `--apply` only, and only when the declared closure delta names an added or rotated secret; `--status` never reads it.";
const integrationServiceBindingRefresh =
  "The `--refresh-service-binding=NAME` delta is integration-only: the exact pinned predecessor must contain exactly one same-name service binding whose observed `service`/`entrypoint` pair differs from the selected target. The successor pair remains target-derived; D1, R2, Durable Object, plain-text and secret bindings cannot use this selector.";
const ordinaryIntegrationFormCodeGate =
  "An ordinary integration code-only apply to an existing exact closure, with source/Host/dependency identities matched and no bootstrap or declared transition, uses the Form-local gate once: `bun run typecheck`, `bun run typecheck:form-authority-worker`, generated Worker types, imports, corpus and integration-package checks, the surface-specific runtime/deploy tests, then `bun run build:form-authority-worker`. That build dry-runs all four Worker bundles with `--containers-rollout none`; it does not build or publish a Core image. Production, rehearsal, bootstrap and transition paths keep their existing gates.";

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
        "scripts/deploy/artifact-blob-io-compatibility.ts",
        "scripts/deploy/worker.ts",
        "scripts/deploy/worker-authority-paths.ts",
        "scripts/deploy/worker-composition.ts",
        "scripts/deploy/wrangler-state.ts",
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler", "flock"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN"],
      triggers: [],
      obligations: {
        provenance:
          `${exactSource} The owner gate runs once, then the exact link-free bundle and realized ` +
          "configuration are sealed and requalified immediately before one upload. Every environment " +
          "uses the Cloudflare credential resolver and direct-REST live state. Integration's OAuth bearer remains " +
          "in-process only; Wrangler children receive either `CLOUDFLARE_API_TOKEN` or no token environment and use " +
          "their stored OAuth profile. Surface triggers, gates, and topology readback obligations are unchanged.",
        "post-conditions":
          "Authoritative deployment/version state, exact binding/configuration closure and the " +
          "public product probe identify the selected commit and uploaded artifact. Non-production " +
          "routine publication uses one versions upload followed by one explicit 100 percent deployment " +
          "with a topology-neutral config, so routes, domains and triggers are never mutated. The exact " +
          "predecessor closure, workers.dev enabled state, and exact account-owned workers.dev hostname " +
          "are re-read immediately after upload and before traffic deployment. A target-scoped same-host " +
          "kernel flock with exact boot, PID-start, " +
          "and lock-inode owner evidence serializes this owning publication path through authoritative " +
          "readback and public smoke. Status distinguishes active, stale-reclaimable crashed, and unsafe " +
          "lease state. While the exact pending lineage through 0043, followed only by an accepted " +
          "contiguous 0044-0057 tail, is pending, public smoke instead requires the " +
          "owned all-traffic quiescence 503 before any request-time composition. Cloudflare exposes no conditional " +
          "deployment/CAS input, so authoritative post-mutation " +
          "history re-establishes the actual immediate predecessor as the rollback target. The Worker's `ready` " +
          "result and discovery/OpenAPI HTTP 200 smoke establish runtime-ready Host state only; they do not establish " +
          "that Form admission is ready or that an application is installed and serving HTTP. When live semantic " +
          "implementation digest `I` differs from its predecessor, the existing owner admission workflow for that environment " +
          "is the prerequisite for reconciling current support/activation heads; Host publication alone leaves those " +
          "durable heads unchanged. A Host code publication with unchanged `I` does not itself require reconvergence; " +
          "other existing drift follows its owning workflow. `I` follows the canonicalized actual emitted Worker " +
          "bundle/import closure and derived inputs, not every docs/test/deploy-only or otherwise unrelated source diff.",
        reversal:
          "The immediately previous Cloudflare Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${routineFailure} The surface refuses pending migrations except the exact pending lineage through 0043, ` +
          "followed only by an accepted contiguous 0044-0057 tail, while the selected target is the all-traffic " +
          "pre-0043 quiescence Worker. It refuses any configuration, secret, " +
          "signing or Hosted topology drift before upload. It also composes the selected target with " +
          "the Worker's own startup path before any upload and refuses with that composition's exact " +
          "words, so a target that parses and yet cannot serve is a pre-mutation refusal rather than a " +
          "failed public probe over a Host that is already down. A plain-text value difference names " +
          "--refresh-var as its remedy. A diff that changes authentication, " +
          "authorization or the deploy mechanism is refused and routed to the authority cutover surface. " +
          "Wrangler JSON framing, the upload-to-deploy predecessor re-fence, publication identities and " +
          "final public smoke are strict; any drift or readback mismatch fails closed. The host-local " +
          "lease does not fence dashboard, direct-API, other owning deploy surfaces, or other-host actors; " +
          "an external advance after the point-in-time history read can evade Version attribution when its " +
          "public behavior still passes smoke. After acknowledged traffic mutation, every authoritative " +
          "inspection error is normalized to verification and never claims that no target was touched. " +
          "A post-upload re-fence failure " +
          "means traffic is indeterminate; this invocation has not started its traffic deployment, but it " +
          "does not infer the uploaded Version's activity or traffic's current owner. " +
          routineWorkerAuthInput,
      },
    },
    {
      surface: "takoserver-integration-worker-bootstrap",
      target: "cloudflare-worker:new-integration-public-host",
      covers: [
        "src",
        "wrangler.jsonc",
        "scripts/build-worker.ts",
        "scripts/deploy.ts",
        "scripts/deploy/integration-worker-bootstrap.ts",
        "scripts/deploy/integration-storage-generation.ts",
        "scripts/deploy/cloudflare-state.ts",
        "scripts/deploy/migrations.ts",
        "scripts/deploy/schema.ts",
        "scripts/deploy/worker-artifact.ts",
        "scripts/deploy/worker-closure-transition.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/realized-config.ts",
        "scripts/deploy/signing.ts",
        "scripts/deploy/wrangler-state.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY",
      ],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          `${exactSource} Integration-only first publication. Qualify the source once, then seal the ` +
          "exact normal Host artifact, configuration and initial secret-name closure before one lifecycle deploy.",
        "post-conditions":
          "Authoritative history must identify the acknowledged first Version with no predecessor; source, " +
          "module, bindings, settings, source-declared cron schedule and secret inventory must exactly match " +
          "the selected target and artifact. " +
          "The public product probe must succeed at its exact account-owned workers.dev origin. No zone route " +
          "or custom domain is adopted. This is a public Host component, not a customer ModuleWorker.",
        reversal:
          "There is no predecessor to roll back to. Keep the old staging target unchanged; inspect the new " +
          "Worker and use an explicitly selected ordinary lifecycle for forward repair, never replay bootstrap.",
        "failure-handling":
          "Existing or partial Worker state refuses apply, even after a prior successful bootstrap. " +
          "Acknowledgement loss is indeterminate; status is read-only and never reads initial secret bytes. " +
          "The command never retries, rotates secrets or changes storage/signing registration. The temporary " +
          "secret file cleanup is attempted on every exit; failure reports potentially retained material. " +
          "TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY supplies only " +
          "the exact target-derived initial secrets for apply; it is never passed to the build." +
          inputContract(applyReviewInput),
        "pre-mutation-proof":
          "Deployment history, exhaustive script, route and custom-domain inventories must prove the exact " +
          "Worker absent before and after qualification and at the final fence. The target must have a " +
          "complete schema, exact R2 identity, valid runtime composition, active registered signing public " +
          "key matching the owned private input, and ready provider qualification. Signing and provider " +
          "state are rechecked before mutation. Only the account-owned workers.dev origin with no aliases " +
          "is accepted; preview URLs remain disabled.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-sponsorship-authority-worker",
      target: "cloudflare-worker:environment-selected-route-less-sponsorship-authority",
      covers: [
        "src/entry-sponsorship-authority-worker.ts",
        "src/sponsorship-credential.ts",
        "src/sponsorship-authority.ts",
        "src/sponsorship-issuance-receipt.ts",
        "sponsorship-authority-worker-configuration.d.ts",
        "migrations/0047_sponsorship_cutover_consumption.sql",
        "wrangler.sponsorship-authority.jsonc",
        "scripts/build-sponsorship-authority-worker.ts",
        "scripts/deploy.ts",
        "scripts/deploy/cloudflare-topology-audit.ts",
        "scripts/deploy/sponsorship-authority.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy/worker-surface-transition.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_SPONSORSHIP_CREDENTIAL_PRIVATE_JWK_PATH",
        "TAKOSERVER_SPONSORSHIP_RECEIPT_PRIVATE_JWK_PATH",
        "TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL",
      ],
      triggers: ["irreversible", "authority", "published-identity"],
      obligations: {
        provenance:
          `${exactSource} The operator-private target pins the only organization and Worker name; ` +
          "the ordinary runtime signing row is read only to prove separation, the target-pinned sponsorship credential public key is append-only registered and read back before its owned 0600 private half is published only to this route-less Worker, the distinct receipt public key is proven against its separate owned 0600 private JWK, and the exact bundle/config/two-secret file is sealed before one upload. A separate owner-private audit credential authenticates the deployment token's active all-zone Zone Read and Workers Routes Read policy; Workers Routes Write is explicitly refused before exhaustive topology readback.",
        "post-conditions":
          "Authoritative Worker history identifies the selected commit and artifact; immutable Version readback proves exactly STATE_DB, the deploy-pinned organization and issuer, dedicated sponsorship credential key id/public JWK/secret, distinct issuance-receipt key id/secret, and Worker version metadata. A policyless target retains that exact closure; an opted-in managed-Space target additionally carries only the target-derived policy digest and TENANT_SPACE_ADMISSION service binding to the named narrow entrypoint. The full Form authority entrypoint is never bound. The public Worker retains only its ordinary run-token key and has no tenant-run mint API or sponsorship private material. Runtime verification requires the immutable issuance-operation row's credential key id to match the JWT kid. Authenticated all-zone topology readback proves workers.dev=false, preview URLs=false, and no public route or custom domain and records only token/policy/resource digests. The entrypoint has exactly one issueTenantRunCredential method, no fetch, and a maximum 300-second credential. After additive migration 0047, one stable logical operation atomically admits the tenant/wallet decision and exact retries reconstruct byte-identical bearer/receipt bytes. This closure status is followed by Hosted's exact service-binding release and a bounded authenticated staging credential issuance/readback before any public route or retired-secret removal.",
        reversal:
          "The immediately previous authority Worker Version is the provider-history rollback target; first publication has forward repair only and never deletes shared D1 state.",
        "failure-handling":
          `${highRiskFailure} The only receipt authority is the dedicated redacted issuance-attestation signer; no funding, inventory, OAuth, billing, delete, managed-object/payment receipt, executor, full Form, or public-fetch authority is present. Managed mode may carry only its exact narrow Form-admission service binding and policy digest. Any extra binding, partial-scope topology token, or public topology fails closed.` +
          inputContract(
            applyReviewInput,
            sponsorshipCredentialPrivateJwkInput,
            sponsorshipReceiptPrivateJwkInput,
            topologyAuditCredentialInput,
          ),
        "independent-review": review,
        "pre-mutation-proof":
          "Before the append-only public-key registration or Worker upload, the command proves the exact source, target, ordinary key row, optional existing credential key row, both owned private/public JWK pairs, closed bundle/config/secrets bytes, and read-only all-zone topology. An existing credential row must already be byte-identical; it is never updated.",
        "no-overwrite":
          "Migration 0047 additively introduces the append-only logical issuance admission while reusing sponsorship_tenants and never rewriting prior migration history. Exact retries reconstruct one fixed bearer/receipt; changed input or a conflicting tenant organization is refused.",
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
        "scripts/deploy/artifact-blob-io-compatibility.ts",
        "scripts/deploy/worker.ts",
        "scripts/deploy/worker-authority-paths.ts",
        "scripts/deploy/worker-closure-transition.ts",
        "scripts/deploy/worker-composition.ts",
        "scripts/deploy/realized-config.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/worker-state.ts",
        "scripts/deploy/worker-surface-transition.ts",
        "scripts/deploy/integration-storage-generation.ts",
        "scripts/deploy-extension.ts",
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["check", "deploy", "typecheck:worker"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} Ordinary applies run the scoped owner gate once; only an integration ` +
          "storage-rebind apply substitutes its component typecheck and filtered storage-rebind " +
          "deploy tests. The exact link-free bundle and " +
          "realized configuration are sealed and requalified immediately before one upload. " +
          "An integration-only storage rebind derives its successor D1/R2 identities from the " +
          "selected target; no resource identity is supplied as a successor selector.",
        "post-conditions":
          "Authoritative deployment/version state, exact binding/configuration closure and the " +
          "public product probe identify the selected authority-sensitive commit and uploaded artifact. " +
          "Integration JIT enablement adds exactly its environment, dedicated public JWK, fixed organization, " +
          "source commit and artifact digest plain-text bindings as one all-or-none profile. While the exact " +
          "pending lineage through 0043, followed only by an accepted contiguous 0044-0057 tail, is pending, " +
          "public smoke instead requires the owned all-traffic quiescence 503 " +
          "before any request-time composition. Every Form-authority environment separately seals " +
          "handler/provider payload P, derives semantic I from P plus the adapter/capability and exact Form " +
          "package-operation set, embeds P/capability/I, then hashes outer artifact A. The Worker's `ready` " +
          "result and discovery/OpenAPI HTTP 200 smoke establish runtime-ready Host state only; they do not establish " +
          "that Form admission is ready or that an application is installed and serving HTTP. When live semantic " +
          "implementation digest `I` differs from its predecessor, the existing owner admission workflow for that environment " +
          "is the prerequisite for reconciling current support/activation heads; Host publication alone leaves those " +
          "durable heads unchanged. A Host code publication with unchanged `I` does not itself require reconvergence; " +
          "other existing drift follows its owning workflow. `I` follows the canonicalized actual emitted Worker " +
          "bundle/import closure and derived inputs, not every docs/test/deploy-only or otherwise unrelated source diff.",
        reversal:
          "The immediately previous Cloudflare Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${highRiskFailure} Pending schema is refused except for the exact pending lineage through 0043, ` +
          "followed only by an accepted contiguous 0044-0057 tail, while " +
          "the selected target blocks all request and scheduled traffic in pre-0043 quiescence mode. " +
          "Any other configuration, secret, signing or Hosted topology drift is still refused. Integration alone may bridge exact absence to the complete JIT " +
          "credential-authority profile; partial fields, wrong organization, reused keys and provenance " +
          "mismatch are refused. " +
          "The separate takoserver-sponsorship-public-route-retirement surface is the only " +
          "path that may carry the observed legacy service binding and Hosted secret into the " +
          "route-removing candidate; this generic authority surface rejects that selector. " +
          "The named --closure-predecessor-version profile refuses before any mutation and names " +
          "every binding its declared delta does not account for. The selected target is composed " +
          "with the Worker's own startup path before any upload and its refusal is reported verbatim. " +
          "Production accepts this transition only with the exact pinned predecessor Version ID, " +
          "a clean/reachable exact commit and independent review; ordinary takoserver-worker deploy " +
          "cannot bypass the selector or carry the retired edge. " +
          "`--closure-predecessor-version=<uuid>` plus the repeatable `--retire-var=NAME`, " +
          "`--add-var=NAME`, `--refresh-var=NAME`, `--refresh-service-binding=NAME`, " +
          "`--add-secret=NAME` and `--rotate-secret=NAME` " +
          "declaration is the only " +
          "path that brings a live Version forward when the operator-private target descriptor " +
          "legitimately changed shape. It is admitted only when the authoritative current Version " +
          "is exactly the pinned id, the declared delta is non-empty, and that declaration equals " +
          "the entire difference between the predecessor closure and the target closure. " +
          "`--refresh-var` covers the difference that changes no binding name at all: the " +
          "predecessor must declare that var with a value different from the one the target derives, " +
          "and the upload publishes the target's value. " +
          integrationServiceBindingRefresh +
          " The secret inventory is the union of what " +
          "the pinned Version declares and what the script-level secret store holds, so a secret a " +
          "rollback left in the store is carried whether or not the declaration names it; naming it " +
          "under `--add-secret` only decides that its value is re-entered. One upload " +
          "then realizes the complete current closure: target plain-text vars exactly as the routine " +
          "surface produces them, every required secret, added and rotated values supplied only " +
          "through the owned 0700 secret-input directory as one ephemeral sealed Wrangler secrets " +
          "file, and every other held secret carried without being re-entered. The routine surfaces " +
          "stay strict and never accept this predecessor. The optional " +
          "`--rebind-state-database-from=<uuid>` and `--rebind-object-bucket-from=<name>` pair is " +
          "integration-only and accepted only on this Host surface and the two route-less Form " +
          "authority Workers. Both exact predecessor values must differ from the selected target's " +
          "successor values; the predecessor must have exactly those old STATE_DB/OBJECTS bindings, " +
          "and all other closure names, types and fields remain exact. Before upload and again at the " +
          "immediate publication fence, read-only verification proves the target D1 UUID/name, exact " +
          "R2 name, audited 0001-0062 lineage and canonical migrated schema. Production and rehearsal " +
          "refuse this pair before provider effects. " +
          integrationServiceBindingRefresh +
          " This one integration rebind branch runs " +
          "`bun run typecheck:worker` and the focused closure-transition, binding-state and storage-generation " +
          "tests before Wrangler dry-run; every other Host apply keeps `bun run check`." +
          inputContract(applyReviewInput, closureSecretDirectoryInput),
        "independent-review": review,
      },
    },

    {
      surface: "takoserver-sponsorship-public-route-retirement",
      target: "cloudflare-worker:environment-selected-proof-gated-sponsorship-route-retirement",
      covers: [
        "src",
        "wrangler.jsonc",
        "scripts/build-worker.ts",
        "scripts/deploy.ts",
        "scripts/deploy/retirement.ts",
        "scripts/deploy/cloudflare-topology-audit.ts",
        "scripts/deploy/sponsorship-cutover-consumption.ts",
        "scripts/deploy/sponsorship-cutover-proof.ts",
        "scripts/deploy/sponsorship-authority.ts",
        "scripts/deploy/worker-live.ts",
        "scripts/deploy/worker-state.ts",
        "migrations/0047_sponsorship_cutover_consumption.sql",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH",
        "TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256",
        "TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL",
      ],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          `${exactSource} The owner-private proof must be a fresh self-digested Hosted staging ` +
          "artifact whose separately confirmed raw SHA-256 binds the exact observed public Worker predecessor/topology/generation, exact served authority " +
          "Version/source/artifact/script, Hosted Version/source/artifact/config/complete binding " +
          "set, and its one default-entrypoint authority service binding. The proof also binds the actual authenticated Hosted exchangeProviderCredential invocation, the authority's separately signed redacted issuance receipt, the matching append-only Hosted 0003 receipt, exact audience/single scope, verified run-credential signature and tenant/space/run claims, at-most-300-second lifetime, and successful Takoform readback. The deployment token's active exact all-zone policy is independently authenticated before either Worker topology is accepted.",
        "post-conditions":
          "Immediately before the sole upload, provider readback must still identify both exact " +
          "proof-bound Workers, exact authority binding, and zero Hosted public topology. The " +
          "uploaded direct successor removes the public sponsorship routes while preserving only " +
          "the separately retired legacy Host-runtime edge and bearer until their ordered steps. " +
          "Terminal ready/status evidence requires proof-aware settlement of the exact remote receipt and includes that proof digest.",
        reversal:
          "The exact direct predecessor may be redeployed through provider history. Reapplying " +
          "route removal after a reverse requires a newly completed staging proof; a consumed " +
          "proof cannot replay.",
        "failure-handling":
          `${highRiskFailure} Missing, stale, mismatched, already consumed, or indeterminate proof ` +
          "state fails before upload, and terminal status without the current proof inputs and exact remote receipt fails closed. The target-derived remote STATE_DB authority writes an append-only operation start immediately before provider mutation and the exact successor completion afterward; the start binds environment/stage/proof, predecessor deployment/version/topology, source commit, exact bundle/config, candidate identity, and operation id. Acknowledgement loss is settled only when proof-aware status observes that exact intended successor carrying the operation id, never by a second upload. Changing checkout, machine, or local path cannot reset replay state." +
          inputContract(
            applyReviewInput,
            sponsorshipCutoverProofInput,
            topologyAuditCredentialInput,
          ),
        "pre-mutation-proof":
          "The route-less authority deploy remains independently allowed first and cannot remove " +
          "the public routes. This surface is the sole route-removing owner lane and requires the " +
          "current bounded Hosted staging proof on every forward apply. Exact migration 0047_sponsorship_cutover_consumption.sql must already be applied through the owning D1 schema surface after the reviewed 0046 lineage. The owned 0600 artifact is selected by TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH and its raw bytes must match TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256; create-only phase state exists only in the target-derived remote STATE_DB.",
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
      requiresScripts: ["check", "deploy", "typecheck:form-authority-worker"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} The steady-state minimal probe bundle, one public identity service binding, ` +
          "one route-less Form-authority service binding and one target Host id are sealed before one upload. " +
          "When integration starts with both the probe and released-Core authority Workers absent, " +
          "the existing surface internally selects the named `integration-host-only` profile: its " +
          "sealed closure contains only the Host id and public identity binding, with no FORM_AUTHORITY. " +
          "An exact existing Host-only predecessor can receive a profile-preserving code update " +
          "while Core remains absent; adding FORM_AUTHORITY still requires the explicit transition.",
        "post-conditions":
          "Authoritative Worker history and exact binding closure identify the upload. Its permanent " +
          "workers.dev endpoint must actively return the exact PublicHostIdentity@v2 value read through " +
          "the named public Worker RPC; no storage, secret, mutation RPC, route or custom domain exists. " +
          "The integration-host-only result reports publicIdentityRpcReady: true, " +
          "coreVerifierConfigured: false, coreVerifierRpcReady: false, and profileReady: true; " +
          "the released-Core binding is added only by the existing explicit transition.",
        reversal:
          "The immediately previous identity probe Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${highRiskFailure} A missing, thrown, malformed or identity-inconsistent public RPC response ` +
          "is unavailable and prevents Form-authority readiness. The integration-host-only profile " +
          "requires complete integration formAuthority topology. Initial publication requires both " +
          "native Workers to remain absent; an existing-profile update requires the exact predecessor " +
          "to remain unchanged and Core to remain absent at the final fence. Drift is refused before upload; " +
          "production and rehearsal retain the absence refusal. This storage-free probe explicitly " +
          "refuses `storageRebind`; only the public Host and the two route-less Form authority Workers " +
          "can carry that integration-only declaration. " +
          integrationServiceBindingRefresh +
          " On this identity-probe surface only, an integration transition declaring " +
          "`--refresh-service-binding` runs `bun run typecheck:form-authority-worker` followed by " +
          "`bun test tests/deploy-form-authority-identity-probe.test.ts " +
          "tests/deploy-worker-state.test.ts tests/deploy-contract.test.ts` before Wrangler dry-run " +
          "or upload; either gate failure stops before dry-run and upload. " +
          ordinaryIntegrationFormCodeGate +
          " For the identity probe this is only a full-profile update of an existing no-drift authority " +
          "whose public identity Host id matches the selected target; Host-only bootstrap/profile updates, " +
          "service refreshes and other transitions do not select it. All other probe applies retain " +
          "`bun run check`. " +
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
        "src/takoform/publisher-set-closure.ts",
        "src/takoform/space-admission-policy.ts",
        "src/takoform/tenant-space-admission.ts",
        "form-authority-worker-configuration.d.ts",
        "src/generated/takoform-publisher-set-receipt.ts",
        "src/generated/takoform-publisher-set-authority-closure.ts",
        "services/takoform-core-verifier",
        "scripts/build-form-authority-worker.ts",
        "wrangler.form-authority.jsonc",
        "scripts/deploy/form-authority-capability.ts",
        "scripts/deploy/form-authority.ts",
        "scripts/deploy/worker-surface-transition.ts",
        "scripts/deploy/integration-storage-generation.ts",
        "scripts/deploy-extension.ts",
      ],
      requiresScripts: ["check", "deploy", "typecheck:form-authority-worker"],
      requiresTools: ["bun", "docker", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} The exact route-less Worker bundle, target D1/R2 bindings, Host identity ` +
          "and code-derived capability manifest are sealed before one upload. The public Worker's " +
          "internal PublicHostIdentity@v2 RPC is the runtime authority for its served Version, artifact, and implementation identities.",
        "post-conditions":
          "Authoritative Worker history must name the exact commit/artifact. The immutable Version " +
          "must contain exactly STATE_DB, OBJECTS, PUBLIC_HOST_IDENTITY, CORE_VERIFIER, WORKER_VERSION " +
          "and the four plain-text variables TAKOSERVER_ENVIRONMENT, TAKOSERVER_FORM_AUTHORITY_HOST_ID, " +
          "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST and TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST, " +
          "with no public Worker identity pins; an opted-in released-Core target adds only its canonical " +
          "TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY plain-text binding, while the integration fixture " +
          "surface remains unchanged, " +
          "secret, route, or public-domain ownership. Status is ready only after the permanent minimal " +
          "identity probe actively calls PublicHostIdentity@v2 and matches live Version/A/P/capability/I. " +
          "Every apply against a Worker that already has a Version must additionally read the live " +
          "released Core verifier identity through the probe and match the uploaded Version exactly.",
        reversal:
          "The immediately previous Form authority Worker version is printed as the provider-history rollback target. " +
          "A bootstrap upload has no predecessor and no surface deletes a Worker, so it names the " +
          "forward repair that completes the lane instead.",
        "failure-handling":
          `${highRiskFailure} RPC apply remains fail-closed unless the released Core Container returns the ` +
          "exact raw 17-package set, checkpoint and artifact identity proof for the embedded publisher-set closure. " +
          "Admission policy and private handle issuance remain Takoserver Host-owned. " +
          "The Core-verifier readback is served by the identity probe through its FORM_AUTHORITY " +
          "service binding, and the probe refuses to bind a script that does not exist, so the very " +
          "first Version of this Worker cannot be verified through it. `--apply " +
          "--bootstrap-verifier-bridge --bootstrap-probe-predecessor-version=<uuid>` is the declared " +
          "order out for this released-Core Worker's `--apply`: it requires the identity probe's exact " +
          "predecessor Version and is admitted only where this Worker has no Version at all, never " +
          "alongside an authority-Worker predecessor pin, a scope transition, an adoption or reverse, " +
          "and it publishes phase one with the readback deferred and " +
          "`verifierBridgePending` set. The run prints the two commands that finish the lane — the " +
          "probe's `--add-binding=FORM_AUTHORITY` transition, then this surface's `--status`, which " +
          "reports `coreVerifierRpcReady: true` only once the bridge is live. No binding to an " +
          "absent script is ever published, and the steady-state post-condition is never relaxed. " +
          "Integration storage rebind, when explicitly declared with both predecessor flags, is " +
          "limited to this route-less Form authority Worker and the integration fixture Worker; its " +
          "successor comes only from the selected target, and its exact generated D1/R2/schema proof " +
          "is repeated immediately before upload. Production and rehearsal refuse it before provider effects. " +
          "This integration storage-rebind branch runs `bun run typecheck:form-authority-worker` and " +
          "focused Form-transition, binding-state and storage-generation tests before Wrangler dry-run; " +
          "it retains precedence when a service-binding refresh is declared too. With no storage rebind, " +
          "an integration service-binding refresh runs `bun run typecheck:form-authority-worker` and " +
          "`bun test tests/deploy-form-authority.test.ts tests/deploy-worker-state.test.ts " +
          "tests/deploy-contract.test.ts` before dry-run or upload; either gate failure stops both. " +
          ordinaryIntegrationFormCodeGate +
          " The route-less fast path additionally requires the already-present no-drift dynamic-public-RPC " +
          "authority at exact-target scope on the parser-approved generated integration D1/R2 target. " +
          "Its exact D1/R2/schema proof runs before the gate and is repeated identically at the immediate " +
          "upload fence; migrations already applied or changed elsewhere do not force the full-repository " +
          "gate. For the released-Core route-less target, an already-selected reusable Core verifier identity " +
          "is also required; absent or mismatched image identity retains the full check and normal image build. " +
          "Bootstrap, scope/storage/service transitions, other storage targets, and production or rehearsal " +
          "retain their existing gates. All other Form authority applies keep `bun run check`." +
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
        "scripts/deploy/worker-surface-transition.ts",
        "scripts/deploy/integration-storage-generation.ts",
        "scripts/deploy-extension.ts",
        "scripts/deploy/target.ts",
      ],
      requiresScripts: ["check", "deploy", "typecheck:form-authority-worker"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. The generated exact 17-package unsigned fixture corpus, ` +
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
          "acknowledgement through status without retry. Its optional integration storage rebind requires " +
          "both exact predecessor flags; the selected generated target alone supplies the successor, " +
          "and D1 UUID/name, R2 existence, audited lineage and canonical schema are reverified at the " +
          "immediate upload fence. " +
          integrationServiceBindingRefresh +
          " This integration storage-rebind branch runs `bun run typecheck:form-authority-worker` and " +
          "focused Form-transition, binding-state and storage-generation tests before Wrangler dry-run; " +
          "it retains precedence when a service-binding refresh is also declared. With no storage " +
          "rebind, an integration service-binding refresh runs `bun run typecheck:form-authority-worker` " +
          "and `bun test tests/deploy-form-authority.test.ts tests/deploy-worker-state.test.ts " +
          "tests/deploy-contract.test.ts` before dry-run or upload; either gate failure stops both. " +
          ordinaryIntegrationFormCodeGate +
          " The same exact-target/no-drift and generated D1/R2/schema fence applies here; migrations " +
          "already applied or changed elsewhere do not select the full-repository gate. Bootstrap, " +
          "transitions, other storage targets, and production or rehearsal retain their existing gate. " +
          "All other Form authority applies keep `bun run check`." +
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
      requiresScripts: ["check", "deploy", "typecheck:form-authority-worker"],
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
          "already-target apply is a refused no-op and lost acknowledgement is status-only reconciliation. " +
          "The operator gateway does not accept the public storageRebind declaration; only the route-less " +
          "Host/Form authority Workers carry that integration-only transition. " +
          integrationServiceBindingRefresh +
          " An integration apply declaring this service refresh runs " +
          "`bun run typecheck:form-authority-worker` and `bun test " +
          "tests/deploy-form-authority.test.ts tests/deploy-worker-state.test.ts tests/deploy-contract.test.ts` " +
          "before Wrangler dry-run or upload; either gate failure stops both. " +
          ordinaryIntegrationFormCodeGate +
          " The gateway branch requires its existing exact scope and dynamic-public-RPC closure plus an " +
          "exact, source-matched, no-drift authority dependency on the selected Host; bootstrap, scope and " +
          "service transitions do not select it. All other operator gateway applies keep `bun run check`." +
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
      triggers: ["authority", "irreversible"],
      obligations: {
        provenance:
          `${exactSource} Integration only. Exhaustive gateway/authority/public-Worker readback ` +
          "must identify that commit before the owned 0600 Ed25519 key signs any request.",
        "post-conditions":
          "Before this lane, when live semantic implementation digest `I` differs from its predecessor, reconcile the " +
          "existing integration fixture Worker (`takoserver-integration-form-authority-worker`) then operator gateway " +
          "(`takoserver-integration-form-authority-operator-worker`) to the selected public commit. Status performs " +
          "one signed authoritative readback. Apply obtains one signed canonical plan, passes that exact plan digest " +
          "once to apply, and finishes with a separately signed status/catalog readback of all exact 17 Space-scoped " +
          "non-production fixture identities. Form admission ready prerequisites are all 17 package identities " +
          "installed and implemented catalog entries supported with active activation heads matching `I`; unsupported " +
          "identities may retain package/support heads but must have no active activation head. A successful/converged " +
          "apply returns a zero-command next plan; these prerequisites do not by themselves prove " +
          "application installation or HTTP serving. A dynamic host-only probe result with `publicIdentityRpcReady=true` " +
          "can be reused in this sequence; probe code changes continue through its existing probe surface and checks.",
        "pre-mutation-proof":
          "Before mutation, the existing current-target identity readback must match the gateway/public Worker. " +
          "Apply obtains one fresh signed canonical plan bound to the current durable heads; the authority rechecks " +
          "its plan digest and request identity, re-derives operations from current heads, rereads heads after " +
          "verification, and fences the live target immediately before every durable command. A mismatch at that " +
          "fence fails closed before the command's package, support, or activation event is appended.",
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
          "separately signed readback proving every exact 17 Space-scoped fixture identity is absent or inactive; support and activation remain limited to the implemented catalog subset. " +
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
      surface: "takoserver-integration-organization-bootstrap",
      target: "https:integration-exact-host-fixed-organization-owner",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/integration-organization-bootstrap.ts",
        "src/integration-organization-bootstrap.ts",
        "src/auth.ts",
        "src/app.ts",
        "src/entry-worker.ts",
        "src/route-table.ts",
        "src/openapi.ts",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH",
        "TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH",
        "TAKOSERVER_INDEPENDENT_REVIEW",
      ],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. Native current Host Version and exact configuration ` +
          "prove the existing operator identity key and source/artifact before its private half is read. " +
          "The request proof binds that identity, the fixed organization tuple, action, method, path and canonical body.",
        "pre-mutation-proof":
          "A signed status must resolve an already-existing exact operator principal and prove both organization " +
          "and membership absent. Exact existing state is a no-op; partial state, another owner and identity drift " +
          "are refused. Native Host provenance is reread immediately before apply.",
        "post-conditions":
          "Only org_takosumi_hosted_staging and its exact owner membership are created, atomically. A separately " +
          "signed status and native Host readback must agree with the acknowledged tuple. No principal, session, " +
          "API key, schema, Worker, route or secret is created or changed.",
        reversal:
          "No automatic reversal or row deletion exists. Inspect status after an uncertain acknowledgement; " +
          "forward repair or disposal of the isolated generation requires a separate explicit decision.",
        "failure-handling":
          `${highRiskFailure} Accepted apply responses are acknowledged before decoding. Status never creates ` +
          "a session or durable row. Credentials, assertion, operator identity fields and raw HTTP bodies are not printed." +
          inputContract(
            applyReviewInput,
            "`TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` and `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` " +
              "are required for both `--status` and `--apply`; no JIT, Form or customer private key is read.",
          ),
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
      surface: "takoserver-integration-storage-generation",
      target: "cloudflare-d1-and-r2:new-integration-generation-only",
      covers: [
        "scripts/deploy/application-schema-shape.ts",
        "migrations",
        "scripts/deploy.ts",
        "scripts/deploy/integration-storage-generation.ts",
        "scripts/deploy/d1-migration-import.ts",
        "scripts/deploy/schema.ts",
        "scripts/deploy/migrations.ts",
        "scripts/deploy/d1.ts",
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["check:migrations", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. One explicit --generation=<32-lowercase-hex> derives ` +
          "both resource names as takoserver-i-<generation>. The scoped migration gate runs once; " +
          "the fixed audited 0001-0062 names and bytes are sealed before creation. A separately " +
          "digested import file preserves every migration byte and adds only Wrangler's migration-ledger DDL and inserts.",
        "post-conditions":
          "The invocation creates one D1 database, proves it empty, applies and reads back the exact " +
          "0001-0062 lineage and canonical schema after one Wrangler file import, then creates and reads back one new R2 bucket. " +
          "It emits a nonsecret candidate storage projection, not an adopted target. No Worker, " +
          "route, namespace, secret or current target is changed.",
        reversal:
          "Before cutover, retain the existing target and do not adopt the candidate. Partial resources " +
          "are not automatically deleted. There is no down migration or retry/adoption of an existing generation.",
        "failure-handling":
          "Pre-existing resources, even empty ones, are refused. After any creation attempt the command " +
          "stops on failure, reports only bounded identity/state diagnostics and never retries. Lost " +
          "acknowledgements are indeterminate; --status is read-only and cannot adopt or repair them." +
          inputContract(applyReviewInput),
        "pre-mutation-proof":
          "Both derived names must be absent at inspection and at the creation fence. The new D1 " +
          "UUID/name and exact empty state are checked before migration. The R2 bucket must remain " +
          "absent until the complete schema is verified, so no older object operation can target it " +
          "during 0043. Existing database migration and rehearsal controls remain unchanged.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-integration-storage-disposal",
      target: "cloudflare-d1-and-r2:exact-selected-integration-target-only",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/integration-storage-disposal.ts",
        "scripts/deploy/integration-storage-generation.ts",
        "scripts/deploy/cloudflare-state.ts",
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. No resource-name selector is accepted: the exact selected ` +
          "DeployTarget D1 id/name and R2 name must be the dedicated staging pair or one matching " +
          "takoserver-i-<32-hex> pair. Apply requires the independent reviewer input.",
        "post-conditions":
          "The provider inventories the selected D1 by exact name and exact id and the R2 by exact " +
          "name. Before deletion, current regular Worker settings and current serving Versions plus " +
          "all current dispatch namespace scripts/bindings must be completely inventoried; namespace " +
          "names and script counts reconcile. Any current selected-storage binding blocks disposal. " +
          "Coverage excludes historical Versions and external API clients. The command rereads the " +
          "identities and bindings immediately before mutation, deletes only the exact empty R2 bucket " +
          "first, then the exact D1 id, and requires authoritative exact-identity absence readback.",
        reversal:
          "There is no rollback. Recreate forward through the separate storage-generation surface; " +
          "this surface never wipes bucket objects, rebinds a target, deletes a Worker or runs migrations.",
        "failure-handling":
          highRiskFailure +
          " A rejected/nonempty R2 deletion stops before D1; an unknown acknowledgement is never retried. " +
          "After partial or indeterminate completion, use --status to read the exact selected identities." +
          inputContract(applyReviewInput),
        "pre-mutation-proof":
          "Before each deletion, the exact selected D1 id/name and R2 name are reread together with " +
          "all current regular Worker settings/serving Versions and dispatch namespace scripts/bindings. " +
          "Any selected-storage reference, incomplete inventory, identity collision or namespace count mismatch withholds mutation.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-integration-host-retirement",
      target: "cloudflare-worker:exact-replaced-integration-public-host-only",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/integration-host-retirement.ts",
        "scripts/deploy/cloudflare-state.ts",
        "scripts/deploy/worker-state.ts",
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_DEPLOY_TARGET_INTEGRATION",
        "TAKOSERVER_INDEPENDENT_REVIEW",
      ],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          `${exactSource} Integration only. TAKOSERVER_DEPLOY_TARGET_INTEGRATION selects the ` +
          "current Host; --retired-target selects a separate absolute operator-private historical Host descriptor. " +
          "Both targets must name the same integration account and distinct Host identities. " +
          "--retired-deployment and --retired-version pin the old live incarnation. No arbitrary " +
          "Worker-name operand or old-source rebuild is accepted.",
        "post-conditions":
          "Readback proves the old script and deployment are absent, while the successor retains " +
          "its exact deployment, Version and target binding closure and answers its own public " +
          "product discovery. Storage, namespaces, routes and keys are never mutated.",
        reversal:
          "There is no rollback of the deleted Worker or its secret store. Recreate through the " +
          "owning bootstrap surface under a new exact identity if needed. Existing storage is retained.",
        "failure-handling":
          highRiskFailure +
          " Exactly one DELETE is sent without the force query; Cloudflare's associated-binding " +
          "protection remains active. Explicit rejection stops. Transport failure, malformed " +
          "acknowledgement or server error is indeterminate and requires --status; no retry, " +
          "forced deletion, namespace cleanup or storage fallback is attempted." +
          inputContract(applyReviewInput),
        "pre-mutation-proof":
          "The retired Host must not be any current target Worker identity. Its pinned deployment, " +
          "Version, exact Host binding/secret-name/settings/cron profile, absence of routes, custom " +
          "domains and owned Durable Object namespaces are rechecked at the deletion fence. " +
          "The successor must retain its current exact deployment/Version and target closure and " +
          "answer /.well-known/takoserver with its own identity. The provider, not a duplicated " +
          "account-wide reference scanner, enforces associated-binding refusal at DELETE time. " +
          "No Version CAS or preservation of callers using retired workers.dev or preview URLs is claimed.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-d1-schema-rehearsal-baseline",
      target: "cloudflare-d1:environment-selected-takoserver-rehearsal-baseline",
      covers: ["migrations", "scripts/deploy/schema.ts", "scripts/deploy/d1.ts"],
      requiresScripts: ["check:migrations", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN", "TAKOSERVER_INDEPENDENT_REVIEW"],
      triggers: ["irreversible"],
      obligations: {
        provenance:
          `${exactSource} The fixed empty-to-0022 migration prefix is copied byte-for-byte into ` +
          "one sealed link-free artifact; this surface accepts only the rehearsal target and no through selector.",
        "post-conditions":
          "The selected D1 must be exactly empty before mutation and must read back the exact ordered " +
          "0001-0022 lineage and canonical schema shape afterwards.",
        reversal:
          "Only the explicitly disposable isolated rehearsal database may be destroyed and recreated; " +
          "this is never a production reset strategy.",
        "failure-handling":
          highRiskFailure +
          inputContract(applyReviewInput) +
          " The baseline never reads TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH and cannot emit production rehearsal evidence.",
        "pre-mutation-proof":
          "The empty lineage and empty canonical schema shape are read before qualification and again at the final mutation fence.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-d1-schema",
      target: "cloudflare-d1:environment-selected-takoserver-state",
      covers: [
        "scripts/deploy/application-schema-shape.ts",
        "migrations",
        "scripts/deploy/artifact-blob-io-compatibility.ts",
        "scripts/deploy/schema.ts",
        "scripts/deploy/d1-migration-import.ts",
        "scripts/deploy/d1.ts",
        "scripts/deploy/wrangler-state.ts",
      ],
      requiresScripts: ["check:migrations", "deploy"],
      requiresTools: ["bun", "wrangler", "flock"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH",
        "TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH",
        "TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH",
      ],
      triggers: ["irreversible"],
      obligations: {
        provenance:
          `${exactSource} Rehearsal and production accept only the fixed next boundaries 0022, 0028, ` +
          "0033, 0036, 0043, 0044, 0045, 0046, 0047, 0048, 0049, 0050, 0051, 0052, 0053, 0054, 0055, 0056 or 0057. The exact predecessor lineage, selected through-prefix and wave " +
          "bytes are checked against their fixed SHA-256 inventory, digested and sealed before the " +
          "forward-only apply. The current source inventory is exactly 0001-0062; unreviewed 0063+ tails are refused before any provider command. Protected wave selectors still end at 0057. " +
          "Integration may select one audited wave or a separately qualified existing-data additive " +
          "transition; selected integration reports evidenceClass integration-protected-wave, " +
          "never writes rehearsal receipts, and is never production evidence. The 0022 selector is a one-time exact 0016-to-0022 " +
          "catch-up and never permits arbitrary migration-prefix adoption. The selected 0047 wave " +
          "uses a separately sealed Wrangler file import containing the unchanged audited SQL plus " +
          "its migration-ledger insert; other selected waves keep their existing transport.",
        "post-conditions":
          "D1 must read back the exact selected through-lineage and canonical schema shape. Status " +
          "always names lastAppliedMigration and nextPendingMigration within the selected wave. " +
          "While 0043 is pending it also names current and rollback compatibility deployment and " +
          "Version identities, drain state, and active-root/deleting-candidate repair count. The " +
          "0044 boundary ends at the durable artifact-consumer resolution receipt migration; the " +
          "0045 boundary is the separate additive Cloudflare executor pre-effect CAS; the 0046 " +
          "boundary adds one exact artifact-recovery singleton and its receipt constraints only after 0045; " +
          "the 0047 boundary adds the sponsorship issuance admission and cutover-consumption receipts only after 0046; " +
          "the 0048 boundary adds value-free Resource execution evidence only after 0047; " +
          "the 0049 boundary preserves prior artifact-consumer receipts and admits active zero-consumption resolution only after 0048; " +
          "the 0050 boundary adds dormant workflow instance and event tables after 0049 without enabling workflow execution; " +
          "the 0051 boundary adds internal workflow execution ownership and step state after 0050 without changing the public workflow declaration or enabling an executor by itself. " +
          "The 0052 boundary adds a durable termination-intent bit after 0051; it fences new claims and terminal writes until the exact execution context is stopped, without changing public workflow declaration identity. " +
          "The 0053 boundary adds shared Queue message custody state after 0052, extending the existing self-host message ledger with Consumer generations and lease policy snapshots without adopting provider-native backlog or changing the public Queue contract. " +
          "The 0054 boundary adds only the bounded unleased Queue custody readiness index after 0053; it does not activate managed delivery, adopt provider-native backlog or change the public Queue contract. " +
          "The 0055 boundary adds durable value-free Queue custody dead-letter transfer notices after 0054; terminal transfer, notice coalescing and source removal remain one guarded atomic batch, while notice acknowledgement stays an exact source-generation/target/token CAS for a private destination wake. " +
          "The 0056 boundary adds Host-owned bounded VectorIndex SQL storage after 0055: immutable cosine index configuration, per-Resource record quotas, binary32 vector records, and type-sensitive equality filter terms; it changes no published identity, binding or provider catalog. " +
          "The 0057 boundary adds receipt-coupled, provider-private execution-material tables for immutable managed Worker Versions after 0056; it stores only bounded execution descriptors and sealed values, and does not publish a Worker, activate custody, or apply any schema automatically. " +
          "The standalone 0022 catch-up receipt binds the canonical 0016 application shape and critical " +
          "data digest before the exact 0017-0022 transition; it is not an ordinary receipt-chain predecessor.",
        reversal:
          "There is no down migration. Failure is repaired forward from the authoritative D1 lineage and schema shape.",
        "failure-handling":
          highRiskFailure +
          inputContract(applyReviewInput, rehearsalReceiptInput) +
          " Every rehearsal wave after the first also requires " +
          "TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH; its exact canonical bytes are " +
          "SHA-256-linked into the next receipt. One target-D1 kernel lease spans attempt creation, " +
          "mutation, authoritative readback, and receipt/marker finalization. " +
          "A failed provider acknowledgement performs an immediate authoritative lineage/shape " +
          "readback. A partial result can resume only under the same through selector and exact " +
          "rehearsal/attempt evidence; a boundary already reached under that attempt is reconciled " +
          "without a second provider apply, and a later boundary cannot be skipped to. Pending 0043 " +
          "requires the operator-private TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH; the " +
          "repository never manufactures the external drained-or-cancelled assertion. The no-selector " +
          "integration lane permits only exact audited 0058 to 0059+0060 or 0059 to 0060: canonical " +
          "predecessor shape and zero open apply/import/delete effects without a live/pending " +
          "Resource attestation are required before qualification and at the final mutation fence. " +
          "Unresolved identified effects remain retained and fence new conflicting work; no drain, " +
          "NULL-selection backfill, reset or arbitrary suffix adoption is implied. Each migration " +
          "and its ledger insert share one D1 transaction; complete 0059 is the resumable boundary. " +
          "Exact 0060 schema and lineage plus retained-effect integrity must read back before " +
          "publishing the matching executor then Host. After 0060 the old binaries cannot restore " +
          "service: repair forward. Protected selectors remain capped at 0057, and fresh generation " +
          "initialization is not a recovery alternative for protected data. A separate exact 0060 " +
          "to 0061 integration transition preserves historical NULL accepted-authority summaries " +
          "without backfill and fences new pre-0061 apply admissions. It requires the audited " +
          "0001-0061 prefix bytes, canonical predecessor/post schemas and retained-effect integrity. Never " +
          "bundle it with the 0059/0060 transition. Have the compatible Host ready before migration; " +
          "publish it only after schema readback, then reconcile current Form authority as needed. " +
          "A separate exact 0061 to 0062 integration transition requires the audited 0061 predecessor " +
          "and canonical 0061 application shape, from exact current 0001-0062 source. It requires zero planned current-generation imports " +
          "before qualification and at the final mutation fence; the migration, ledger insert and " +
          "old-writer fence are one atomic D1 transaction. New import writers explicitly insert immutable " +
          "import_selection_protocol=1; old inserts are refused before preparation. The import selection " +
          "is immutable once bound while its verified token is renewed per lease; " +
          "historical rows are never backfilled. A provider native destination has one unique reservation " +
          "retained through receipt publication. Read back the schema, then publish CPE and Host in that " +
          "order as a forward-only integration repair; it grants no production authorization. " +
          "The executor protocol generation is unchanged; unrelated components need not be republished. " +
          "This forward-only availability boundary is not a zero-downtime or historical recovery claim.",
        "pre-mutation-proof":
          "Status, post-qualification recheck and the final mutation fence all run named zero-count " +
          "checks for 0029 malformed FormRef and duplicate live Resource UID, 0036 unmatched " +
          "dispatched repair saga, 0037 nonempty replaced predecessor, and 0039 duplicate live " +
          "native claim, plus the 0043 active-root/deleting-candidate conflict count. The additive " +
          "integration 0058/0059 to 0060 transition also requires exact canonical schema and no " +
          "orphan open provider effects; identified unresolved effects need not be drained. The separate " +
          "0060 to 0061 integration transition additionally runs focused transition/preservation tests " +
          "before the local D1 migration gate. The separate 0061 to 0062 transition additionally checks " +
          "the exact 0061 predecessor shape, zero planned current-generation imports and the unique " +
          "native-destination reservation through receipt publication before the local D1 migration gate. " +
          "Rehearsal writes " +
          "one no-overwrite 0600 receipt per wave outside every " +
          "repository. Production requires that exact commit, predecessor, through boundary, wave " +
          "bytes, pre-shape and expected post-shape. Before 0037, one monotonic single-statement " +
          "CREATE TRIGGER IF NOT EXISTS installs the exact insert guard. Canonical trigger SQL and a zero " +
          "predecessor count are read back after installation and again immediately before migration; 0037 " +
          "removes the guarded table. This never treats REST query execution as D1Database.batch(). For 0043, " +
          "current and immediate rollback Worker deployments and Versions " +
          "must both be exact all-traffic compatibility builds at the selected commit, public preview URLs are disabled, and a private " +
          "receipt created after and bound to both deployments must attest that every older request/event " +
          "invocation drained or was cancelled. " +
          "Those Version/history, receipt, and conflict proofs are re-read in mutation phase after " +
          "the 0037 guard and immediately before the wave's first migration. For the exceptional 0022 " +
          "catch-up, the exact audited 0001-0016 names, frozen canonical application-schema digest, zero " +
          "unsafe critical-data invariants, and matching rehearsal data counts/digest are checked before " +
          "qualification, after qualification, and at the final mutation fence. Integration evidence is never accepted.",
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
          "The public Worker must be an exact canonical current-key Version with the ordinary public secret closure. " +
          "Provider-created secret successors and mixed or unknown annotation inventories fail before build/upload.",
        "post-conditions":
          "The immutable Worker version explicitly names the next id with the exact secret inventory and unchanged code, while both public rows remain byte-identical.",
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
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/retirement.ts",
        "scripts/deploy/cloudflare-topology-audit.ts",
        "scripts/deploy/sponsorship-cutover-consumption.ts",
        "scripts/deploy/sponsorship-cutover-proof.ts",
        "migrations/0047_sponsorship_cutover_consumption.sql",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH",
        "TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256",
        "TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL",
      ],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          "Forward retirement deletes only the named Hosted secret. Cloudflare creates a new direct-successor Worker Version; its commit, bundle digest and non-secret closure must remain byte-identical with the topology-retired predecessor.",
        "post-conditions":
          "Authoritative secret inventory omits only the retired Hosted bearer and the current Version is the exact direct successor of the topology-retired predecessor, with unchanged commit and bundle digest. Terminal ready/status evidence requires proof-aware settlement of the exact remote receipt and includes that proof digest.",
        reversal:
          "Forward-only; restoration requires a separately reviewed dedicated surface. This surface never re-puts the retired secret.",
        "failure-handling":
          `${highRiskFailure} A lost acknowledgement is settled from the remote STATE_DB operation receipt by status accepting only the exact ` +
          "direct successor; a secret-created Version without the exact canonical annotation inventory is " +
          "reported as token-retired-unattributed-successor with ready=false and repairRequired=true. " +
          "The operation binds the completed route-removal proof plus the exact topology-only direct predecessor, source commit, bundle/config, candidate identity and intended successor; the surface refuses to run before topology retirement, terminal status without current proof inputs and exact remote receipt fails closed, and it never reports a partial delete as complete. Changing checkout, machine, or local path cannot reset replay state." +
          inputContract(
            applyReviewInput,
            sponsorshipCutoverProofInput,
            topologyAuditCredentialInput,
          ),
        "pre-mutation-proof":
          "Status must prove the direct candidate successor has no Hosted service binding and still carries the Hosted secret before deletion. Exact migration 0047_sponsorship_cutover_consumption.sql must already be applied through the owning D1 schema surface after the reviewed 0046 lineage. Forward apply reads TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH, confirms its exact bytes with TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256, and requires a valid completed route-removal receipt in the target-derived remote STATE_DB before recording its own append-only proof consumption immediately ahead of the one secret delete.",
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
      surface: "takoserver-operator-identity",
      target: "cloudflare-worker:environment-selected-takoserver-operator-identity",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/identity.ts",
        "scripts/deploy/operator-authority.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy/realized-config.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH",
        "TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} The canonical environment-neutral operator identity surface requires one ` +
          "exact `--organization=<org_...>` selector. The selected commit must already be the served " +
          "Worker commit. The owner gate rebuilds it once, requires the exact served bundle digest, and " +
          "proves the owned 0600 private JWK against the target's exact public Ed25519 JWK.",
        "post-conditions":
          "One immutable Worker Version adds only OPERATOR_IDENTITY_PUBLIC_JWK. Code, every other variable " +
          "and binding, secrets, domains, D1, R2 and Hosted topology remain exact; a short-lived redacted " +
          "operator assertion for the selected organization must prove the real owner, create a session " +
          "whose redacted bearer succeeds at /v1/me, is then revoked, and fails a replay. Production " +
          "status never presents provider-only configuration as owner-ready.",
        reversal:
          "Rollback evidence names the exact predecessor but is explicitly non-executable. Any recovery " +
          "requires a freshly qualified product-owned exact-target status/qualification operation; this " +
          "surface emits no provider rollback command and never treats prior evidence as authorization.",
        "failure-handling":
          `${highRiskFailure} Unrelated configuration or Version advance is refused rather than attributed. ` +
          "An upload acknowledgement failure is settled by the same canonical surface's fresh " +
          "`--status` with the exact organization selector; it is never retried blindly. Owner-proof " +
          "failure in production may roll back only after the successor history is freshly re-read and " +
          "the exact predecessor is still authoritative; otherwise rollback is refused as indeterminate." +
          inputContract(applyReviewInput, operatorPrivateJwkInput),
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-integration-operator-identity",
      target: "cloudflare-worker:integration-takoserver-operator-identity",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/identity.ts",
        "scripts/deploy/operator-authority.ts",
        "scripts/deploy/target.ts",
        "scripts/deploy/realized-config.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH",
        "TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          "Integration-only legacy spelling of the canonical operator identity surface. The selected " +
          "commit must already be the served Worker commit. The " +
          "owner gate rebuilds it once, requires the exact served bundle digest, and proves the " +
          "owned 0600 private JWK against the target's exact public Ed25519 JWK.",
        "post-conditions":
          "One immutable Worker Version adds only OPERATOR_IDENTITY_PUBLIC_JWK. Code, every other variable " +
          "and binding, secrets, domains, D1, R2 and Hosted topology remain exact; a short-lived " +
          "redacted operator assertion must create a session whose redacted bearer succeeds at /v1/me, " +
          "is then revoked, and fails a replay.",
        reversal:
          "Rollback evidence names the exact predecessor but is explicitly non-executable. Any recovery " +
          "requires a freshly qualified product-owned exact-target status/qualification operation; this " +
          "surface emits no provider rollback command. Before removing this identity, revoke every " +
          "session and API key issued through it. Identity removal is a separate reviewed configuration " +
          "transition; this surface never deletes it.",
        "failure-handling":
          highRiskFailure + inputContract(applyReviewInput, operatorPrivateJwkInput),
        "independent-review": review,
      },
    },

    {
      surface: "takoserver-org-api-key",
      target: "https:environment-selected-durable-organization-api-key",
      covers: [
        "scripts/deploy.ts",
        "scripts/deploy/org-api-key.ts",
        "scripts/deploy/identity.ts",
        "scripts/deploy/target.ts",
        "src/auth.ts",
        "src/control.ts",
        "src/operator-key.ts",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["bun"],
      requiresEnv: [
        "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH",
        "TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH",
        "TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY",
        "TAKOSERVER_INDEPENDENT_REVIEW",
      ],
      triggers: ["authority"],
      obligations: {
        provenance:
          `${exactSource} The owned 0600 Ed25519 private half must prove the target's declared ` +
          "operator public JWK before it signs one 60-second sign-in assertion, and the public " +
          "product probe must identify this target's Host before any credential moves. The key is " +
          "minted through the Host's own organization API, so it is recorded exactly where an " +
          "interactive owner's key is recorded and the console lists and revokes it unchanged.",
        "post-conditions":
          "`--mint` writes the one-time secret to a new owner-only 0600 file under the exact " +
          "`TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY`, then re-reads the organization's unrevoked keys " +
          "and requires the exact minted id, name and expiry to be listed. Expiry is always declared " +
          "and bounded; an unbounded organization API key is refused. `--status` is a value-free " +
          "readback of every unrevoked key. `--revoke` requires the exact key id and proves absence " +
          "from a fresh readback. Every action revokes its proof session and proves that revocation " +
          "by replay.",
        reversal:
          "A minted key is reversed by this surface's own `--revoke` with the printed key id, which " +
          "the result names. Revocation itself is forward-only: a revoked key is never restored.",
        "failure-handling":
          `${highRiskFailure} A second unrevoked key with the same name is refused before any ` +
          "mutation, and so is an existing secret file for that name, because a duplicate would " +
          "leave two keys the operator cannot tell apart with a secret for only one. A lost mint or " +
          "revoke acknowledgement is indeterminate and is never retried: `--status` lists the " +
          "organization's live keys, and a key listed without a secret file on disk is revoked " +
          "through this surface before minting again. Secret bytes never enter argv, the child " +
          "environment, success output or diagnostics. The surface requires the target to declare " +
          "`operatorIdentity`; a target without that operator authority is refused by name in every " +
          "environment." +
          orgApiKeyInput,
        "independent-review": review,
      },
    },
  ],
  otherProviderScripts: [],
} as const;

type DeployContractSurface = (typeof DEPLOY_CONTRACT.surfaces)[number];
type DeployContractSurfaceName = DeployContractSurface["surface"];

function declaredSurface<Name extends DeployContractSurfaceName>(
  name: Name,
): Extract<DeployContractSurface, { readonly surface: Name }> {
  const surface = DEPLOY_CONTRACT.surfaces.find((candidate) => candidate.surface === name);
  if (surface === undefined) throw new TypeError(`missing deploy contract surface ${name}`);
  return surface as Extract<DeployContractSurface, { readonly surface: Name }>;
}

/** Generic public Worker lifecycles that a private backend may qualify and compose. */
export const GENERIC_WORKER_DEPLOY_CONTRACT_SURFACES = [
  declaredSurface("takoserver-worker"),
  declaredSurface("takoserver-worker-authority-cutover"),
  declaredSurface("takoserver-integration-worker-bootstrap"),
] as const;
