import type { DeployPhase } from "./errors.ts";
import { DeployError } from "./errors.ts";
import { runChecked, runCommand, wranglerCommand } from "./process.ts";
import { deploymentVariables, expectedWorkerSecrets } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";

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
  expected: ExpectedBindingClosure,
): Promise<void> {
  const raw = await runChecked(
    phase,
    "wrangler versions view",
    wranglerCommand(["versions", "view", versionId, "--config", configPath, "--json"]),
  );
  const start = raw.indexOf("{");
  if (start < 0) {
    throw new DeployError(
      phase,
      "wrangler versions view returned no JSON",
      `output_bytes=${new TextEncoder().encode(raw).byteLength}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    throw new DeployError(
      phase,
      "wrangler versions view returned unparsable JSON",
      `json_bytes=${new TextEncoder().encode(raw.slice(start)).byteLength}`,
    );
  }

  assertVersionBindingClosure(phase, versionId, parsed, expected);
}

export interface ExpectedBinding {
  readonly type: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * `null` is an exact absence requirement. It prevents an old authority-bearing
 * service binding from surviving after the private target removes it.
 */
export type ExpectedBindingClosure = Readonly<Record<string, ExpectedBinding | null>>;

export interface WorkerBindingTarget {
  readonly d1: { readonly databaseId: string };
  readonly r2: { readonly bucketName: string };
  readonly hostedTopology?: {
    readonly service: string;
    readonly entrypoint: string;
  };
}

/**
 * The immutable Worker binding closure one realized target must serve.
 *
 * Keeping this derivation beside the Version parser makes ordinary status
 * readback and post-publication verification prove the same authority seam.
 */
export function expectedBindingClosureForTarget(
  target: WorkerBindingTarget,
): ExpectedBindingClosure {
  const materializer = target.hostedTopology;
  return {
    STATE_DB: {
      type: "d1",
      // Worker Version resources expose the D1 identifier as `id`; Wrangler's
      // input-only config spelling is `database_id`.
      fields: { id: target.d1.databaseId },
    },
    OBJECTS: {
      type: "r2_bucket",
      fields: { bucket_name: target.r2.bucketName },
    },
    HOST_RUNTIME_MATERIALIZER: materializer
      ? {
          type: "service",
          fields: {
            service: materializer.service,
            entrypoint: materializer.entrypoint,
          },
        }
      : null,
  };
}

/**
 * Complete non-secret Worker binding closure for one selected target.
 *
 * Secret values remain unreadable by design, but their exact names/types are
 * still part of the immutable Version. Plain-text values are compared exactly;
 * this is the config-drift fence used before and after every Worker upload.
 */
export function expectedExactBindingClosure(
  target: DeployTarget,
  input: {
    readonly hostedTopology: "desired" | "absent";
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
  },
): ExpectedBindingClosure {
  const vars = deploymentVariables(target, input.signingKeyId);
  const entries = (vars.vars ?? {}) as Readonly<Record<string, string>>;
  const topologyTarget: WorkerBindingTarget =
    input.hostedTopology === "desired" ? target : { d1: target.d1, r2: target.r2 };
  const topology = expectedBindingClosureForTarget(topologyTarget);
  return {
    AI: { type: "ai", fields: {} },
    ...topology,
    ...Object.fromEntries(
      Object.entries(entries).map(([name, value]) => [
        name,
        { type: "plain_text", fields: { text: value } },
      ]),
    ),
    ...Object.fromEntries(
      (input.expectedSecrets ?? expectedWorkerSecrets(target)).map((name) => [
        name,
        { type: "secret_text", fields: {} },
      ]),
    ),
  };
}

/** Exact means no unnamed, duplicate, or target-unexpected binding survives. */
export function assertExactVersionBindingClosure(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  expected: ExpectedBindingClosure,
): void {
  assertVersionBindingClosure(phase, versionId, version, expected);
  const bindings = versionBindings(phase, versionId, version);
  const expectedNames = new Set(
    Object.entries(expected)
      .filter(([, requirement]) => requirement !== null)
      .map(([name]) => name),
  );
  const actualNames: string[] = [];
  for (const binding of bindings) {
    const name =
      typeof binding.name === "string"
        ? binding.name
        : typeof binding.binding === "string"
          ? binding.binding
          : null;
    if (name === null) {
      throw new DeployError(
        phase,
        `version ${versionId} contains an unnamed binding`,
        bindingInventoryDetail(bindings),
      );
    }
    actualNames.push(name);
  }
  if (
    actualNames.length !== new Set(actualNames).size ||
    actualNames.some((name) => !expectedNames.has(name)) ||
    expectedNames.size !== actualNames.length
  ) {
    throw new DeployError(
      phase,
      `version ${versionId} binding inventory is not the exact selected target closure`,
      `expected=${JSON.stringify([...expectedNames].sort())} actual=${JSON.stringify([...actualNames].sort())}`,
    );
  }
}

export interface WorkerDeploymentHistory {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly previousVersionId: string | null;
}

/**
 * Reduces exhaustive Cloudflare deployment history to the active and rollback
 * identities. A gradual or malformed deployment is not silently treated as a
 * single-version routine target.
 */
export function parseWorkerDeploymentHistory(
  value: readonly unknown[],
): WorkerDeploymentHistory | null {
  if (value.length === 0) return null;
  const deployments = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.created_on !== "string" ||
      !Array.isArray(entry.versions) ||
      !Number.isFinite(Date.parse(entry.created_on))
    ) {
      throw new DeployError("preflight", "Worker deployment history contains a malformed entry");
    }
    return { id: entry.id, createdOn: entry.created_on, versions: entry.versions };
  });
  deployments.sort((left, right) => right.createdOn.localeCompare(left.createdOn));
  const currentDeployment = deployments[0];
  if (!currentDeployment) return null;
  const current = singleVersion(currentDeployment);
  const previous = deployments[1] === undefined ? null : singleVersion(deployments[1]);
  return {
    deploymentId: currentDeployment.id,
    versionId: current,
    previousVersionId: previous,
  };
}

/** Exact names and binding types; Cloudflare never exposes the values. */
export function assertExactSecretInventory(
  inventory: readonly unknown[],
  expected: readonly string[],
  phase: DeployPhase = "preflight",
): void {
  const actual = inventory.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.type !== "secret_text") {
      throw new DeployError(phase, "Worker secret inventory contains a malformed entry");
    }
    return entry.name;
  });
  const sortedActual = [...new Set(actual)].sort();
  const sortedExpected = [...new Set(expected)].sort();
  if (
    actual.length !== sortedActual.length ||
    JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)
  ) {
    throw new DeployError(
      phase,
      "Worker secret inventory drift",
      `expected=${JSON.stringify(sortedExpected)} actual=${JSON.stringify(sortedActual)}`,
    );
  }
}

function singleVersion(deployment: {
  readonly id: string;
  readonly versions: readonly unknown[];
}): string {
  if (deployment.versions.length !== 1) {
    throw new DeployError(
      "preflight",
      `deployment ${deployment.id} must contain exactly one 100 percent version`,
    );
  }
  const version = deployment.versions[0];
  if (!isRecord(version) || typeof version.version_id !== "string" || version.percentage !== 100) {
    throw new DeployError(
      "preflight",
      `deployment ${deployment.id} must contain exactly one 100 percent version`,
    );
  }
  return version.version_id;
}

export async function assertTargetBindingClosure(
  phase: DeployPhase,
  configPath: string,
  versionId: string,
  target: WorkerBindingTarget,
): Promise<void> {
  await assertBindingClosure(phase, configPath, versionId, expectedBindingClosureForTarget(target));
}

/** Exact, duplicate-free binding proof over `wrangler versions view --json`. */
export function assertVersionBindingClosure(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  expected: ExpectedBindingClosure,
): void {
  const bindings = versionBindings(phase, versionId, version);
  for (const [binding, requirement] of Object.entries(expected)) {
    const nodes = bindings.filter((node) => node.name === binding || node.binding === binding);
    if (requirement === null) {
      if (nodes.length !== 0) {
        throw new DeployError(
          phase,
          `version ${versionId} unexpectedly declares the ${binding} binding`,
          JSON.stringify(nodes),
        );
      }
      continue;
    }
    if (nodes.length === 0) {
      throw new DeployError(
        phase,
        `version ${versionId} does not declare the ${binding} binding`,
        bindingInventoryDetail(bindings),
      );
    }
    if (nodes.length !== 1) {
      throw new DeployError(
        phase,
        `version ${versionId} declares the ${binding} binding more than once`,
        JSON.stringify(nodes),
      );
    }
    const node = nodes[0] as Record<string, unknown>;
    if (node.type !== requirement.type) {
      throw new DeployError(
        phase,
        `version ${versionId} binds ${binding} with unexpected type`,
        JSON.stringify(node),
      );
    }
    for (const [field, value] of Object.entries(requirement.fields)) {
      if (node[field] !== value) {
        throw new DeployError(
          phase,
          `version ${versionId} binds ${binding} with unexpected ${field}`,
          JSON.stringify(node),
        );
      }
    }
  }
}

function versionBindings(
  phase: DeployPhase,
  versionId: string,
  value: unknown,
): readonly Record<string, unknown>[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).resources !== "object" ||
    (value as Record<string, unknown>).resources === null ||
    Array.isArray((value as Record<string, unknown>).resources) ||
    !Array.isArray(
      ((value as Record<string, unknown>).resources as Record<string, unknown>).bindings,
    )
  ) {
    throw new DeployError(
      phase,
      `version ${versionId} has no canonical binding inventory`,
      versionShapeDetail(value),
    );
  }
  const bindings = ((value as Record<string, unknown>).resources as Record<string, unknown>)
    .bindings as readonly unknown[];
  if (
    bindings.some(
      (binding) => typeof binding !== "object" || binding === null || Array.isArray(binding),
    )
  ) {
    throw new DeployError(
      phase,
      `version ${versionId} has an invalid binding inventory`,
      bindingInventoryDetail(bindings),
    );
  }
  return bindings as readonly Record<string, unknown>[];
}

function bindingInventoryDetail(bindings: readonly unknown[]): string {
  return JSON.stringify(
    bindings.map((binding) => {
      if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
        return { shape: Array.isArray(binding) ? "array" : typeof binding };
      }
      const record = binding as Record<string, unknown>;
      return {
        name:
          typeof record.name === "string"
            ? record.name
            : typeof record.binding === "string"
              ? record.binding
              : null,
        type: typeof record.type === "string" ? record.type : null,
      };
    }),
  );
}

function versionShapeDetail(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return JSON.stringify({ shape: Array.isArray(value) ? "array" : typeof value });
  }
  const record = value as Record<string, unknown>;
  const resources = record.resources;
  return JSON.stringify({
    keys: Object.keys(record).sort(),
    resourceKeys:
      typeof resources === "object" && resources !== null && !Array.isArray(resources)
        ? Object.keys(resources).sort()
        : [],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
