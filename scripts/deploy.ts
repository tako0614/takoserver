const contract = {
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
        "package.json",
      ],
      requiresScripts: ["check", "deploy"],
      requiresTools: ["bun", "wrangler"],
      requiresEnv: [],
      triggers: ["published-identity", "authority", "irreversible"],
      obligations: {
        provenance:
          "Live publication is intentionally unavailable. A future reviewed implementation must bind one clean pushed commit, the exact Wrangler bundle digest, generated Env types, migration bytes, and the selected Cloudflare account to operator-private evidence before touching a target.",
        "post-conditions":
          "A future implementation must read back the exact Worker version and binding closure, prove all three D1 tables and active verification-key availability, then exercise a fresh signed object PUT/GET and prove replay rejection on the published origin without exposing grant or object bytes in evidence.",
        reversal:
          "No target is touched today. A future implementation must capture the previous immutable Worker version before mutation; Worker rollback is separate from forward-only D1 repair, and R2/D1 data must never be erased as a code rollback shortcut.",
        "failure-handling":
          "Every invocation except the exact --contract probe refuses before importing or spawning Wrangler, accessing credentials, or touching a target. A future writer must distinguish pre-mutation failure from indeterminate post-mutation state and must not retry without authoritative readback.",
        "no-overwrite":
          "A future implementation must publish a new immutable Worker version for changed bytes and refuse attempts to replace a recorded candidate identity in place.",
        "pre-mutation-proof":
          "A future implementation must run the portable gate, generated-type check, Wrangler strict dry-run, disposable local D1 migrations, read-only production binding and migration-lineage inspection, and a credential-free R2/D1 capability probe before its first writer.",
        "independent-review":
          "Before any live command is implemented or used, a reviewer that did not author it must inspect account selection, migration lineage, key authority, replay semantics, R2 scoping, immutable artifact identity, reversal, and readback evidence.",
      },
    },
  ],
} as const;

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--contract") {
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
  process.exit(0);
}

process.stderr.write("deploy blocked: live deploy is not implemented; no target was touched\n");
process.exit(1);
