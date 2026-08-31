import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const persistence = mkdtempSync(join(tmpdir(), "takoserver-d1-migrations-"));
const wrangler = resolve(repository, "node_modules/.bin/wrangler");
const config = resolve(repository, "wrangler.jsonc");

async function run(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([wrangler, ...args], {
    cwd: repository,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    throw new Error(`wrangler exited with ${exitCode}`);
  }
  return stdout;
}

try {
  await run([
    "d1",
    "migrations",
    "apply",
    "STATE_DB",
    "--local",
    "--persist-to",
    persistence,
    "--config",
    config,
  ]);
  const raw = await run([
    "d1",
    "execute",
    "STATE_DB",
    "--local",
    "--persist-to",
    persistence,
    "--config",
    config,
    "--json",
    "--command",
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('integration_e2e_credential_pair_operations', 'provision_token_consumptions', 'runtime_grant_keys', 'runtime_grant_replays', 'runtime_resources', 'sponsorship_resources', 'sponsorship_tenants', 'tf_deferred_operations', 'tf_operation_commit_guards', 'tf_provider_mutation_sagas', 'tf_resource_attachments', 'tf_resource_claims', 'tf_resource_deletion_attestations', 'tf_resource_deployments', 'tf_resource_provider_effects', 'wallet_credit_allocations', 'wallet_credit_lots', 'worker_endpoint_origin_reservations', 'worker_runtime_input_preparations') ORDER BY name",
  ]);
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !isRecord(value[0]) || !Array.isArray(value[0].results)) {
    throw new Error("unexpected D1 schema probe response");
  }
  const names = value[0].results
    .filter(isRecord)
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
  if (
    JSON.stringify(names) !==
    JSON.stringify([
      "integration_e2e_credential_pair_operations",
      "provision_token_consumptions",
      "runtime_grant_keys",
      "runtime_grant_replays",
      "runtime_resources",
      "sponsorship_resources",
      "sponsorship_tenants",
      "tf_deferred_operations",
      "tf_operation_commit_guards",
      "tf_provider_mutation_sagas",
      "tf_resource_attachments",
      "tf_resource_claims",
      "tf_resource_deletion_attestations",
      "tf_resource_deployments",
      "tf_resource_provider_effects",
      "wallet_credit_allocations",
      "wallet_credit_lots",
      "worker_endpoint_origin_reservations",
      "worker_runtime_input_preparations",
    ])
  ) {
    throw new Error(`D1 schema probe returned unexpected tables: ${JSON.stringify(names)}`);
  }
} finally {
  rmSync(persistence, { recursive: true, force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
