import type { DeployPhase } from "./errors.ts";
import { DeployError } from "./errors.ts";
import { runChecked, runCommand, wranglerCommand } from "./process.ts";

const VERSION_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/u;
const MISSING_WORKER = /script_not_found|could not find|does not exist|no deployments/iu;

/**
 * The Worker version currently receiving production traffic, or null when the
 * Worker has never been deployed. A missing Worker is a normal first-publish
 * state, not a failure.
 */
export async function servedVersionId(configPath: string): Promise<string | null> {
  const result = await runCommand(
    wranglerCommand(["deployments", "status", "--config", configPath]),
  );
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) {
    if (MISSING_WORKER.test(output)) return null;
    throw new DeployError(
      "preflight",
      `wrangler deployments status failed (exit ${result.exitCode})`,
      output.trim(),
    );
  }
  const match = VERSION_ID.exec(output);
  return match ? match[0] : null;
}

/**
 * Reads back the exact binding closure of one immutable version. The realized
 * D1 database id and R2 bucket name must appear inside their own binding, so a
 * Worker pointed at the wrong resource cannot pass verification.
 */
export async function assertBindingClosure(
  phase: DeployPhase,
  configPath: string,
  versionId: string,
  expected: Readonly<Record<string, readonly string[]>>,
): Promise<void> {
  const raw = await runChecked(
    phase,
    "wrangler versions view",
    wranglerCommand(["versions", "view", versionId, "--config", configPath, "--json"]),
  );
  const start = raw.indexOf("{");
  if (start < 0) throw new DeployError(phase, "wrangler versions view returned no JSON", raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    throw new DeployError(phase, "wrangler versions view returned unparsable JSON", raw);
  }

  for (const [binding, requiredValues] of Object.entries(expected)) {
    const node = findBinding(parsed, binding);
    if (node === null) {
      throw new DeployError(
        phase,
        `version ${versionId} does not declare the ${binding} binding`,
        raw,
      );
    }
    const serialized = JSON.stringify(node);
    for (const value of requiredValues) {
      if (!serialized.includes(value)) {
        throw new DeployError(
          phase,
          `version ${versionId} binds ${binding} to unexpected state: ${value} is absent`,
          serialized,
        );
      }
    }
  }
}

function findBinding(value: unknown, binding: string): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findBinding(entry, binding);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record.name === binding || record.binding === binding) return record;
    for (const entry of Object.values(record)) {
      const found = findBinding(entry, binding);
      if (found !== null) return found;
    }
  }
  return null;
}
