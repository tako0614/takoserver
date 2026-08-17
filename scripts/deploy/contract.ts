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
        "src/worker.ts",
        "src/durable-worker-entry.ts",
        "src/state-store.ts",
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
          "closure, proves all three D1 tables plus at least one active verification key, and " +
          "then exercises the published origin as a real caller: discovery, a fresh signed " +
          "object PUT, a GET that must return the exact bytes, replay of the consumed grant " +
          "which must be rejected, and a control-plane route which must stay fail-closed. The " +
          "probe registration and object are removed afterwards. No grant token or object byte " +
          "is written to evidence.",
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
  ],
} as const;
