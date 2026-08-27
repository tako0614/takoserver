/**
 * The side-effect-free declaration of what this entrypoint publishes, which
 * triggers stand on it, and how each obligation is discharged. `--contract`
 * prints exactly this and touches nothing.
 */
const API_COVERS = [
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
] as const;

const API_OBLIGATIONS = {
  provenance:
    "Publication refuses unless the worktree is clean and HEAD is already contained in " +
    "its upstream branch. The uploaded bytes are built from that worktree by one strict " +
    "Wrangler dry-run and digested; the commit, branch, remote, bundle digest and size, " +
    "migration bytes digest, selected account, D1 database id, and R2 bucket are written " +
    "to an operator-private append-only evidence ledger under .deploy/evidence.",
  "post-conditions":
    "After publishing, the writer reads back the served Worker version id and its binding " +
    "closure, including the exact service and named entrypoint of any Hosted runtime " +
    "materializer and the absence of a stale materializer binding when none is declared, " +
    "proves every product table remains present, and exercises the anonymous " +
    "published surface: Takoserver discovery, OpenAPI, both Takoform lanes, identity " +
    "discovery, credential-bearing route refusal, unknown-route 404, and—when Hosted " +
    "sponsorship is enabled—a bounded live token whose signature is verified against the " +
    "active D1 public key. Authenticated " +
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
    "for an authoritative readback of the served Version and its exact D1, R2, and " +
    "runtime-materializer binding closure first.",
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
    "active key availability, exact local-private/D1-public signing authority, live signing " +
    "proof where Hosted is enabled, R2 bucket reachability, and the currently served version.",
  "independent-review":
    "This writer moves the deploy mechanism itself and rewrites durable schema, so a " +
    "reviewer who did not author it must inspect account selection, migration lineage, " +
    "key provisioning and custody, replay semantics, R2 scoping, immutable artifact " +
    "identity, reversal, and readback evidence before it is used again.",
} as const;

function apiSurface(surface: string, target: string) {
  return {
    surface,
    target,
    covers: API_COVERS,
    requiresScripts: ["check", "deploy"],
    requiresTools: ["bun", "wrangler"],
    requiresEnv: [],
    triggers: ["published-identity", "authority", "irreversible"],
    obligations: API_OBLIGATIONS,
  } as const;
}

export const DEPLOY_CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    apiSurface("takoserver-api", "cloudflare-worker:takoserver-api"),
    apiSurface("takoserver-api-staging", "cloudflare-worker:takoserver-api-staging"),
    {
      surface: "takoserver-console",
      target: "cloudflare-worker:takoserver-console",
      covers: ["console", "scripts/build-console.ts", "scripts/deploy.ts", "scripts/deploy/web.ts"],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: ["CLOUDFLARE_API_TOKEN"],
      triggers: ["published-identity"],
      obligations: {
        provenance:
          "The owner builds console assets from a clean pushed commit into a fresh private temporary directory and records the commit, exact asset digest, byte count, Worker name and public origin.",
        "post-conditions":
          "The writer proves the custom domain is owned by takoserver-console and that the live console.js body is byte-exact with the just-built artifact.",
        reversal:
          "The previous custom-domain service is captured before publication and no previous Worker is deleted, so the hostname can be reattached without reconstructing old bytes.",
        "failure-handling":
          "Build and authority failures occur before publication; a failed mutation or byte readback is classified and never retried automatically.",
        "no-overwrite":
          "Wrangler publishes immutable Worker versions and the append-only web ledger never overwrites an earlier publication receipt.",
        "pre-mutation-proof":
          "The full portable gate, pushed-source proof, fresh console build, content digest and current custom-domain owner are read with CLOUDFLARE_API_TOKEN before publication.",
      },
    },
    {
      surface: "takoserver-site",
      target: "cloudflare-worker:takoserver-site",
      covers: [
        "site",
        "src/landing.ts",
        "scripts/build-site.ts",
        "scripts/deploy.ts",
        "scripts/deploy/web.ts",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [],
      triggers: ["published-identity"],
      obligations: {
        provenance:
          "The owner builds the site from a clean pushed commit into a fresh private temporary directory, binds the reviewed Cloudflare account and exact declared zone route, and records a value-free account identity, artifact digest, size, origin, Worker identity, previous route owner, and bounded public state. Route inventory uses Wrangler-managed authentication in memory and never prints or stores its bearer.",
        "post-conditions":
          "The writer proves the account-scoped exact zone route is owned by takoserver-site and that the served index document is byte-exact with the built page.",
        reversal:
          "When a previous exact zone-route service exists it is retained for reattachment. When no previous owner exists, reversal removes the exact route from takoserver-site to restore no owner; it never invents a previous Worker. No customer or API state is changed.",
        "failure-handling":
          "Build, account/route-declaration, malformed Cloudflare envelope, and authenticated inventory failures occur before publication with fixed diagnostics and without disclosing credentials. Mutation and verification failures are terminal and require status readback, which reports deployment identity, route ownership, and bounded public HTTP state even when the origin is unhealthy.",
        "no-overwrite":
          "Each publication is an immutable Worker Version with an append-only evidence receipt.",
        "pre-mutation-proof":
          "The full portable gate, pushed-source proof, fresh site build, exact account_id and hostname/* zone-route declaration, strict Wrangler dry-run, account-scoped zone and route inventory, current route owner, and bounded public HTTP state are read before mutation. Cloudflare envelopes must say success=true and carry result arrays, and the returned zone must name the reviewed account. The active Wrangler profile is sufficient; no separately provisioned site credential is required.",
      },
    },
  ],
} as const;
