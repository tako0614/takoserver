import type { DeployPhase } from "./errors.ts";
import { DeployError } from "./errors.ts";
import { runChecked, runCommand, wranglerCommand } from "./process.ts";
import {
  deploymentVariables,
  expectedWorkerSecrets,
  type WorkerVersionAuthorityProfile,
} from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";

const VERSION_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/u;
const EXACT_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
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

export type WorkerVersionMetadataBindingProfile = "current" | "pre-version-metadata";

export interface WorkerBindingTarget {
  readonly d1: { readonly databaseId: string };
  readonly r2: { readonly bucketName: string };
}

/**
 * A legacy Hosted edge is intentionally not part of `DeployTarget`.  Retirement
 * reads this opaque service identity from the authoritative predecessor and
 * carries it only through the named transition profile.
 */
export interface LegacyHostServiceBinding {
  readonly service: string;
  readonly entrypoint: string;
}

/**
 * Reads one optional immutable plain-text binding without exposing its value in
 * diagnostics. Transition classifiers use this before proving the complete
 * exact closure selected by that value.
 */
export function optionalExactPlainTextBinding(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  name: string,
): string | null {
  const bindings = versionBindings(phase, versionId, version);
  const matches = bindings.filter((binding) => binding.name === name || binding.binding === name);
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new DeployError(
      phase,
      `version ${versionId} declares the ${name} binding more than once`,
      bindingInventoryDetail(matches),
    );
  }
  const match = matches[0] as Record<string, unknown>;
  if (match.type !== "plain_text" || typeof match.text !== "string") {
    throw new DeployError(
      phase,
      `version ${versionId} has an invalid ${name} binding`,
      bindingInventoryDetail(matches),
    );
  }
  return match.text;
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
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
    readonly authorityProfile?: WorkerVersionAuthorityProfile;
    /** Canonical outer artifact annotation for current Form-authority Hosts. */
    readonly workerArtifactDigest?: `sha256:${string}`;
  } = {},
): ExpectedBindingClosure {
  const vars = deploymentVariables(target, input.signingKeyId, input.authorityProfile, {
    ...(input.workerArtifactDigest === undefined
      ? {}
      : { workerArtifactDigest: input.workerArtifactDigest }),
  });
  const entries = (vars.vars ?? {}) as Readonly<Record<string, string>>;
  return {
    AI: { type: "ai", fields: {} },
    WORKER_VERSION: { type: "version_metadata", fields: {} },
    ...expectedBindingClosureForTarget(target),
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

/**
 * Exact binding closure of the one pinned integration predecessor that
 * predates Cloudflare Worker Version metadata. Every desired binding remains
 * strict; the self-version binding must be absent, not optional.
 */
export function expectedLegacyPreVersionMetadataBindingClosure(
  target: DeployTarget,
  input: {
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
    readonly authorityProfile?: WorkerVersionAuthorityProfile;
    readonly workerArtifactDigest?: `sha256:${string}`;
  } = {},
): ExpectedBindingClosure {
  return {
    ...expectedExactBindingClosure(target, input),
    WORKER_VERSION: null,
  };
}

/**
 * One reviewed, explicitly declared difference between a pinned predecessor
 * Version and the current realized target closure.
 *
 * Every name is declared by the operator on the command line. Nothing here is
 * inferred from live state: the declaration is what makes the difference
 * reviewable, and an undeclared difference is a refusal rather than a repair.
 */
export interface WorkerClosureDelta {
  /** Plain-text bindings the current target no longer derives. */
  readonly retiredVars: readonly string[];
  /** Plain-text bindings the current target derives and the predecessor lacks. */
  readonly addedVars: readonly string[];
  /**
   * Plain-text bindings both sides declare whose value this upload corrects.
   *
   * A corrected target descriptor often changes no binding name at all: it
   * changes one value. Without this the routine surface refuses the predecessor
   * for binding that value with unexpected text, and the transition refuses the
   * declaration for naming a var the target still derives — so a value-only
   * correction would be unpublishable by any surface.
   */
  readonly refreshedVars: readonly string[];
  /**
   * Non-plain-text bindings the current target declares and the predecessor
   * lacks.
   *
   * A code advance can add a service, D1, R2 or Durable Object binding to a
   * surface's derived closure. The predecessor cannot have declared it, so
   * without a name for that difference the advance is unpublishable on every
   * Worker that is already live.
   */
  readonly addedBindings: readonly string[];
  /** Secrets the current target requires and the predecessor does not carry. */
  readonly addedSecrets: readonly string[];
  /** Secrets carried by both sides whose value this one upload replaces. */
  readonly rotatedSecrets: readonly string[];
}

/** A selector without any declared change is an ordinary publication, not a transition. */
export function workerClosureDeltaIsEmpty(delta: WorkerClosureDelta): boolean {
  return (
    delta.retiredVars.length === 0 &&
    delta.addedVars.length === 0 &&
    delta.refreshedVars.length === 0 &&
    delta.addedBindings.length === 0 &&
    delta.addedSecrets.length === 0 &&
    delta.rotatedSecrets.length === 0
  );
}

/** Exact declared binding names on one immutable Version; unnamed or duplicate fails closed. */
export function exactVersionBindingNames(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
): readonly string[] {
  const bindings = versionBindings(phase, versionId, version);
  const names = bindings.map((binding) => {
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
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new DeployError(
      phase,
      `version ${versionId} declares a duplicate binding name`,
      bindingInventoryDetail(bindings),
    );
  }
  return names;
}

/** Exact binding closure used by the reviewed Hosted-edge retirement surfaces. */
export function expectedTransitionBindingClosure(
  target: DeployTarget,
  input: {
    readonly serviceBinding: LegacyHostServiceBinding | null;
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
    readonly metadataProfile?: WorkerVersionMetadataBindingProfile;
    readonly authorityProfile?: WorkerVersionAuthorityProfile;
    readonly workerArtifactDigest?: `sha256:${string}`;
  },
): ExpectedBindingClosure {
  const exact = expectedExactBindingClosure(target, {
    ...(input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId }),
    ...(input.expectedSecrets === undefined ? {} : { expectedSecrets: input.expectedSecrets }),
    ...(input.authorityProfile === undefined ? {} : { authorityProfile: input.authorityProfile }),
    ...(input.workerArtifactDigest === undefined
      ? {}
      : { workerArtifactDigest: input.workerArtifactDigest }),
  });
  return {
    ...exact,
    ...(input.metadataProfile === "pre-version-metadata" ? { WORKER_VERSION: null } : {}),
    [legacyServiceBindingName()]:
      input.serviceBinding === null
        ? null
        : {
            type: "service",
            fields: {
              service: input.serviceBinding.service,
              entrypoint: input.serviceBinding.entrypoint,
            },
          },
  };
}

/** Extracts one exact legacy Hosted service binding without exposing other values. */
export function extractLegacyHostServiceBinding(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
): LegacyHostServiceBinding {
  const bindings = versionBindings(phase, versionId, version);
  const matches = bindings.filter(
    (binding) =>
      binding.name === legacyServiceBindingName() || binding.binding === legacyServiceBindingName(),
  );
  if (matches.length !== 1) {
    throw new DeployError(
      phase,
      `version ${versionId} must declare exactly one ${legacyServiceBindingName()} binding`,
      bindingInventoryDetail(matches),
    );
  }
  const match = matches[0] as Record<string, unknown>;
  if (
    match.type !== "service" ||
    typeof match.service !== "string" ||
    typeof match.entrypoint !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(match.service) ||
    !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(match.entrypoint)
  ) {
    throw new DeployError(
      phase,
      `version ${versionId} has an invalid ${legacyServiceBindingName()} binding`,
      bindingInventoryDetail(matches),
    );
  }
  return { service: match.service, entrypoint: match.entrypoint };
}

function legacyServiceBindingName(): string {
  return ["HOST", "RUNTIME", "MATERIALIZER"].join("_");
}

/**
 * Classifies only the structural generation of the immutable Version binding
 * inventory. Artifact identity is a separate fact and must not be inferred
 * from whether the self-version binding exists.
 */
export function workerVersionMetadataBindingProfile(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
): WorkerVersionMetadataBindingProfile {
  const bindings = versionBindings(phase, versionId, version);
  const nodes = bindings.filter(
    (node) => node.name === "WORKER_VERSION" || node.binding === "WORKER_VERSION",
  );
  if (nodes.length > 1) {
    throw new DeployError(
      phase,
      `version ${versionId} declares the WORKER_VERSION binding more than once`,
      bindingInventoryDetail(nodes),
    );
  }
  return nodes.length === 0 ? "pre-version-metadata" : "current";
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

export interface WorkerDeploymentChainEntry {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly createdOn: string;
}

export interface WorkerDeploymentChainOptions {
  /** Secret-created lineage inference requires provider UUID identities. */
  readonly requireUuidVersionIds?: boolean;
}

/**
 * Canonical Cloudflare deployment-history parser.
 *
 * All callers share entry/percentage/deployment-identity validation. Named
 * transition callers may additionally require UUID identities. Repeated
 * immutable Versions remain valid rollback history; transition consumers own
 * uniqueness checks for only the C→H or C→H→S prefix they infer.
 */
export function parseWorkerDeploymentChain(
  value: readonly unknown[],
  phase: DeployPhase = "preflight",
  options: WorkerDeploymentChainOptions = {},
): readonly WorkerDeploymentChainEntry[] {
  const entries = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.created_on !== "string" ||
      !Number.isFinite(Date.parse(entry.created_on)) ||
      !Array.isArray(entry.versions)
    ) {
      throw new DeployError(phase, "Worker deployment history contains a malformed entry");
    }
    if (entry.versions.length !== 1) {
      throw new DeployError(
        phase,
        `deployment ${entry.id} must contain exactly one 100 percent Version`,
      );
    }
    const version = entry.versions[0];
    if (
      !isRecord(version) ||
      typeof version.version_id !== "string" ||
      version.version_id.length === 0 ||
      version.percentage !== 100
    ) {
      throw new DeployError(
        phase,
        `deployment ${entry.id} must contain exactly one 100 percent Version`,
      );
    }
    if (options.requireUuidVersionIds === true && !EXACT_VERSION_ID.test(version.version_id)) {
      throw new DeployError(phase, "Worker deployment history contains an invalid Version ID");
    }
    return {
      deploymentId: entry.id,
      versionId: version.version_id,
      createdOn: entry.created_on,
    };
  });
  const deploymentIds = entries.map(({ deploymentId }) => deploymentId);
  if (new Set(deploymentIds).size !== deploymentIds.length) {
    throw new DeployError(phase, "Worker deployment history contains duplicate deployment IDs");
  }
  return [...entries].sort((left, right) => right.createdOn.localeCompare(left.createdOn));
}

/**
 * Reduces Cloudflare's endpoint-provided deployment history to the active and
 * rollback identities. The endpoint exposes a bounded, non-paginated history;
 * a gradual or malformed deployment is not silently treated as a single-version
 * routine target.
 */
export function parseWorkerDeploymentHistory(
  value: readonly unknown[],
  phase: DeployPhase = "preflight",
): WorkerDeploymentHistory | null {
  const deployments = parseWorkerDeploymentChain(value, phase);
  const currentDeployment = deployments[0];
  if (!currentDeployment) return null;
  return {
    deploymentId: currentDeployment.deploymentId,
    versionId: currentDeployment.versionId,
    previousVersionId: deployments[1]?.versionId ?? null,
  };
}

/** Exact names and binding types; Cloudflare never exposes the values. */
export function assertExactSecretInventory(
  inventory: readonly unknown[],
  expected: readonly string[],
  phase: DeployPhase = "preflight",
): void {
  const actual = parseWorkerSecretInventory(inventory, phase);
  const sortedActual = [...actual].sort();
  const sortedExpected = [...new Set(expected)].sort();
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new DeployError(
      phase,
      "Worker secret inventory drift",
      `expected=${JSON.stringify(sortedExpected)} actual=${JSON.stringify(sortedActual)}`,
    );
  }
}

/** Parses the provider's exhaustive secret name/type inventory once. */
export function parseWorkerSecretInventory(
  inventory: readonly unknown[],
  phase: DeployPhase = "preflight",
): readonly string[] {
  const names = inventory.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.type !== "secret_text") {
      throw new DeployError(phase, "Worker secret inventory contains a malformed entry");
    }
    return entry.name;
  });
  if (new Set(names).size !== names.length) {
    throw new DeployError(phase, "Worker secret inventory contains a duplicate name");
  }
  return names;
}

/** Exact declared `secret_text` binding names on one immutable Version. */
export function versionSecretBindingNames(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
): readonly string[] {
  // Fails closed on an unnamed or duplicated binding before classifying types.
  const declared = new Set(exactVersionBindingNames(phase, versionId, version));
  return versionBindings(phase, versionId, version)
    .filter((binding) => binding.type === "secret_text")
    .map((binding) => `${binding.name ?? binding.binding}`)
    .filter((name) => declared.has(name))
    .sort();
}

/**
 * What a Worker actually holds a secret value for, as opposed to what the
 * served Version happens to declare.
 *
 * Cloudflare keeps secrets on the script, not on the immutable Version. A
 * rollback therefore leaves the store ahead: it still holds every secret a
 * later Version installed, while the Version now serving declares fewer. The
 * inventory a transition reasons about is the union of the two, so a secret the
 * store already holds is carried into the upload rather than demanded again —
 * with or without `--add-secret`, which only decides whether its value is
 * re-entered.
 */
export interface WorkerTransitionSecretInventory {
  /** Secret bindings the pinned Version itself declares. */
  readonly versionSecrets: readonly string[];
  /** Secret names the script-level store holds. */
  readonly storeSecrets: readonly string[];
  /** The union: every secret this Worker already holds a value for. */
  readonly held: readonly string[];
  /** Held by the store, undeclared by the served Version. Carried, never re-entered. */
  readonly carriedStoreSecrets: readonly string[];
}

/**
 * Reads that union and refuses anything in it the current target does not
 * require. An extra secret is still drift; what is no longer drift is a
 * required secret arriving from the store rather than from the Version.
 */
export function workerTransitionSecretInventory(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  storeInventory: readonly unknown[],
  targetSecrets: readonly string[],
): WorkerTransitionSecretInventory {
  const versionSecrets = versionSecretBindingNames(phase, versionId, version);
  const storeSecrets = [...parseWorkerSecretInventory(storeInventory, phase)].sort();
  const held = [...new Set([...versionSecrets, ...storeSecrets])].sort();
  const expected = [...new Set(targetSecrets)].sort();
  if (held.some((name) => !expected.includes(name))) {
    throw new DeployError(
      phase,
      "Worker secret inventory drift",
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(held)}`,
    );
  }
  return {
    versionSecrets,
    storeSecrets,
    held,
    carriedStoreSecrets: storeSecrets.filter((name) => !versionSecrets.includes(name)),
  };
}

/** Shared membership check used by Hosted and signing transition classifiers. */
export function workerSecretInventoryIncludes(
  inventory: readonly unknown[],
  name: string,
  phase: DeployPhase = "preflight",
): boolean {
  return parseWorkerSecretInventory(inventory, phase).includes(name);
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
      if (node[field] === value) continue;
      // A plain-text value difference is the one drift with a published
      // remedy, so the refusal names it instead of leaving the operator to
      // discover that no selector accepts a changed value.
      const remedy =
        requirement.type === "plain_text" && field === "text"
          ? "; publish a value-only target correction with " +
            `takoserver-worker-authority-cutover --closure-predecessor-version=${versionId} ` +
            `--refresh-var=${binding}`
          : "";
      throw new DeployError(
        phase,
        `version ${versionId} binds ${binding} with unexpected ${field}${remedy}`,
        JSON.stringify(node),
      );
    }
  }
}

/**
 * Bounded reader for one immutable Version's declared binding inventory.
 *
 * Exported so the shared transition and drift readers can compare a live
 * Version against a surface's expected closure without each re-deriving the
 * provider's envelope shape.
 */
export function readVersionBindings(
  phase: DeployPhase,
  versionId: string,
  value: unknown,
): readonly Record<string, unknown>[] {
  return versionBindings(phase, versionId, value);
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
