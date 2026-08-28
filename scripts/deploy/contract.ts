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
        "scripts/deploy/qualification.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN"],
      triggers: [],
      obligations: {
        provenance:
          `${exactSource} The owner gate runs once, then the exact link-free bundle and realized ` +
          "configuration are sealed and requalified immediately before one upload.",
        "post-conditions":
          "Authoritative deployment/version state, exact binding/configuration closure and the " +
          "public product probe identify the selected commit and uploaded artifact.",
        reversal:
          "The immediately previous Cloudflare Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${routineFailure} The surface refuses pending migrations and any configuration, secret, ` +
          "signing or Hosted topology drift before upload. A diff that changes authentication, " +
          "authorization or the deploy mechanism is refused and routed to the authority cutover surface.",
      },
    },
    {
      surface: "takoserver-worker-authority-cutover",
      target: "cloudflare-worker:environment-selected-takoserver-worker-authority-code",
      covers: [
        "src",
        "wrangler.jsonc",
        "scripts/build-worker.ts",
        "scripts/deploy.ts",
        "scripts/deploy/worker.ts",
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
          "public product probe identify the selected authority-sensitive commit and uploaded artifact.",
        reversal:
          "The immediately previous Cloudflare Worker version is printed as the provider-history rollback target.",
        "failure-handling":
          `${highRiskFailure} Pending schema and any configuration, secret, signing or Hosted topology ` +
          "drift are still refused; this surface changes authority-sensitive code bytes only.",
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
        "failure-handling": routineFailure,
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
        "failure-handling": routineFailure,
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
        "failure-handling": highRiskFailure,
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
        "failure-handling": highRiskFailure,
        "pre-mutation-proof":
          "The exact public-JWK digest, canonical Ed25519 shape and key-id absence are proven, then absence is rechecked immediately before insert.",
        "independent-review": review,
        "no-overwrite":
          "The selected key id must be absent. Registration uses an insert-only statement; an existing identical or different row is never rewritten.",
      },
    },
    {
      surface: "takoserver-hosted-topology-cutover",
      target: "cloudflare-worker:environment-selected-hosted-materializer-topology",
      covers: [
        "scripts/deploy/hosted.ts",
        "scripts/deploy/realized-config.ts",
        "scripts/deploy/worker-state.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_HOSTED_TOKEN_PATH",
      ],
      triggers: ["irreversible", "authority"],
      obligations: {
        provenance:
          `${exactSource} The sealed currently selected Worker artifact is joined only with the ` +
          "explicit Hosted materializer service and entrypoint.",
        "post-conditions":
          "The immutable Worker version readback contains the exact materializer binding and all " +
          "other configuration remains byte-for-byte equivalent.",
        reversal:
          "Topology is forward-repair only; no automatic removal or fallback service is attempted.",
        "failure-handling": highRiskFailure,
        "pre-mutation-proof":
          "The Hosted token cutover and bounded signing proof must already pass while the materializer binding is still absent.",
        "independent-review": review,
      },
    },
    {
      surface: "takoserver-signing-repair",
      target: "cloudflare-worker-secret:environment-selected-current-signing-key",
      covers: ["scripts/deploy/signing.ts", "scripts/deploy/worker-live.ts"],
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
        "failure-handling": highRiskFailure,
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
          "The target explicitly names different current and next ids; both public keys must be pre-registered and the owned 0600 next private JWK must prove the next public half.",
        "post-conditions":
          "The immutable Worker version explicitly names the next id with the exact secret inventory and unchanged code, while both public rows remain byte-identical.",
        reversal:
          "The explicit current key remains pre-registered, so an operator may run a separately reviewed inverse rotation; no silent switch or key deletion occurs.",
        "failure-handling": highRiskFailure,
        "independent-review": review,
        "no-overwrite":
          "Rotation consumes a separately pre-registered next id, retains the current public row, and never overwrites either identity.",
      },
    },
    {
      surface: "takoserver-hosted-token-cutover",
      target: "cloudflare-worker-secret:environment-selected-hosted-token",
      covers: ["scripts/deploy/hosted.ts", "scripts/deploy/signing.ts"],
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
          "The owned 0600 token file is sent only on stdin while the Hosted topology binding is authoritatively absent.",
        "post-conditions":
          "Before any topology cutover, the bounded sponsorship route accepts the exact token and returns a credential whose signature matches the current D1 public key.",
        reversal:
          "Before topology cutover, remove the newly added named secret through an explicit Cloudflare secret deletion; token bytes are never printed.",
        "failure-handling": highRiskFailure,
        "independent-review": review,
      },
    },
  ],
} as const;
