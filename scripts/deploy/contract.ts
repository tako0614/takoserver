/**
 * The side-effect-free declaration of what this entrypoint publishes, which
 * triggers stand on it, and how each obligation is discharged. `--contract`
 * prints exactly this and touches nothing.
 */
export const DEPLOY_CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: "takoserver-api",
      target: "cloudflare-worker:takoserver-api",
      covers: [
        "wrangler.jsonc",
        "migrations",
        "src/entry-worker.ts",
        "src",
        "scripts/build-worker.ts",
        "scripts/check-d1-migrations.ts",
        "scripts/check-worker-startup.ts",
        "scripts/deploy.ts",
        "scripts/deploy",
        "package.json",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [],
      triggers: ["published-identity", "authority", "irreversible"],
      obligations: {
        provenance:
          "Publication refuses unless the worktree is clean and HEAD is already contained in " +
          "its upstream branch. The uploaded bytes are built from that worktree by one strict " +
          "Wrangler dry-run and digested; the commit, branch, remote, bundle digest and size, " +
          "migration bytes digest, selected account, D1 database id, and R2 bucket are written " +
          "to an operator-private append-only evidence ledger under .deploy/evidence.",
        "post-conditions":
          "After publishing, the writer reads back the served Worker version id and its binding " +
          "closure, proves every product table remains present, and exercises the anonymous " +
          "published surface: Takoserver discovery, OpenAPI, both Takoform lanes, identity " +
          "discovery, credential-bearing route refusal, and unknown-route 404. Authenticated " +
          "customer lifecycle, signed R2 bytes, replay rejection, AI inference, and billing are " +
          "separate live E2E cadences because the deploy writer does not mint customer or " +
          "commercial authority.",
        reversal:
          "The previously served Worker version id is captured before any mutation and printed " +
          "with the exact `wrangler versions deploy` command that restores it. Worker rollback " +
          "is separate from D1: schema repair is forward-only, and no R2 object or D1 row is " +
          "erased to undo a code change.",
        "failure-handling":
          "Every invocation without an explicit `--apply` refuses before touching a target. " +
          "Failures are classified by phase and carry the raw diagnostics: exit 2 means nothing " +
          "was touched, exit 3 means the target may have been mutated and the state is " +
          "indeterminate, exit 4 means bytes are published but the post-conditions failed. The " +
          "writer never retries on its own; exit 3 and exit 4 direct the operator to `--status` " +
          "for an authoritative readback first.",
        "no-overwrite":
          "Publication mints a new immutable Worker version for changed bytes. If the evidence " +
          "ledger already records the served version for the same bundle digest the writer " +
          "reports the target as current and publishes nothing, and it refuses outright when a " +
          "recorded version id is claimed by a different bundle digest.",
        "pre-mutation-proof":
          "Before the first writer runs: the portable gate `bun run check` (format, lint, import " +
          "boundary, generated Worker types, both type worlds, tests, disposable local D1 " +
          "migration, both builds, Worker startup, checked OpenAPI), a strict Wrangler dry-run " +
          "of the realized configuration, and read-only inspection of the live target covering " +
          "D1 migration lineage against the local migration files, the three runtime tables, " +
          "active key availability, R2 bucket reachability, and the currently served version.",
        "independent-review":
          "This writer moves the deploy mechanism itself and rewrites durable schema, so a " +
          "reviewer who did not author it must inspect account selection, migration lineage, " +
          "key provisioning and custody, replay semantics, R2 scoping, immutable artifact " +
          "identity, reversal, and readback evidence before it is used again.",
      },
    },
    {
      surface: "takoserver-console",
      target: "cloudflare-worker:takoserver-console",
      covers: [
        "wrangler.console.jsonc",
        "console",
        "scripts/build-console.ts",
        "scripts/deploy.ts",
        "scripts/deploy/static.ts",
        "package.json",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [],
      triggers: ["authority"],
      obligations: {
        provenance:
          "Publication refuses a dirty, detached, or unpushed worktree; runs the complete owner gate; rebuilds the Console with the exact production API origin; scans the public artifact for credential-shaped bytes; performs a strict Wrangler dry-run; and records the commit, artifact digest, Worker version, route target, and reviewer in an operator-private 0600 ledger.",
        "post-conditions":
          "After publication the owner reads the new 100% Worker deployment, byte-compares production index.html and console.js to the reviewed build, verifies a SPA deep link, and rejects any served bundle that still contains the retired unitPriceMinor or protocols projection.",
        reversal:
          "The prior Worker version is captured before mutation and printed as an exact Wrangler rollback command. On the first owned publication, deleting the new Worker removes its route and restores the pre-existing DNS origin without changing that DNS record.",
        "failure-handling":
          "Preflight failure exits before Cloudflare mutation; publication or readback failure is terminal and classified as indeterminate, preserves the previous version, and requires the read-only --status path before any retry.",
        "independent-review":
          "--apply requires a named reviewer after the plan has exposed the exact commit, artifact digest, prior version, route, and current HTTP state.",
      },
    },
    {
      surface: "takoserver-site",
      target: "cloudflare-worker:takoserver-site",
      covers: [
        "wrangler.site.jsonc",
        "site",
        "src/landing.ts",
        "scripts/build-site.ts",
        "scripts/deploy.ts",
        "scripts/deploy/static.ts",
        "package.json",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [],
      triggers: ["authority"],
      obligations: {
        provenance:
          "Publication refuses a dirty, detached, or unpushed worktree; runs the complete owner gate; rebuilds the apex from the shared Takoserver landing source with exact Console and API origins; scans public bytes; performs a strict Wrangler dry-run; and records commit, artifact digest, Worker version, route target, and reviewer in an operator-private 0600 ledger.",
        "post-conditions":
          "After publication the owner reads the new 100% Worker deployment; byte-compares https://takoserver.com/, https://takoserver.com/en/, and https://takoserver.com/ja/ with the reviewed locale artifacts; verifies exact HTML language identities; and requires the served page to link the exact production Console and API origins.",
        reversal:
          "The prior Worker version is captured before mutation and printed as an exact Wrangler rollback command. On the first owned publication, deleting the new Worker removes its route and restores the exact pre-publication origin behavior.",
        "failure-handling":
          "Preflight failure exits before Cloudflare mutation; publication or readback failure is terminal and classified as indeterminate, preserves the previous version, and requires the read-only --status path before any retry.",
        "independent-review":
          "--apply requires a named reviewer after the plan has exposed the exact commit, artifact digest, prior version, route, and current HTTP state.",
      },
    },
  ],
} as const;
