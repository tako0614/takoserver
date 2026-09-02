import { createHash } from "node:crypto";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  assertExactVersionBindingClosure,
  type ExpectedBinding,
  type ExpectedBindingClosure,
  exactVersionBindingNames,
  optionalExactPlainTextBinding,
  readVersionBindings,
  type WorkerClosureDelta,
  workerClosureDeltaIsEmpty,
} from "./worker-state.ts";

/**
 * One forward-transition admission, shared by every Worker-publishing surface.
 *
 * A Worker surface fences the live Version against the exact closure its
 * current code and target derive. That fence is right, and it is also the
 * reason a code advance can strand a Worker: when the advance itself changes a
 * derived binding — a capability manifest gains a Form kind, a service binding
 * appears — the predecessor cannot already equal the value the advance
 * introduces, so no publication is admissible and the Worker is stuck at the
 * commit before the change.
 *
 * The remedy is one mechanism rather than one profile per surface: the operator
 * pins the predecessor Version and declares the difference by name. Code-derived
 * values stay derived — the declaration names the binding, never the value — and
 * everything the declaration does not name stays exactly as strict as the
 * routine path. Where nothing is declared, nothing changes.
 */

/** A declaration that names no binding is an ordinary publication. */
export const EMPTY_WORKER_CLOSURE_DELTA: WorkerClosureDelta = {
  retiredVars: [],
  addedVars: [],
  refreshedVars: [],
  addedBindings: [],
  addedSecrets: [],
  rotatedSecrets: [],
};

const DELTA_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Longest value echoed verbatim in a difference report; longer ones are digested. */
const MAX_REPORTED_VALUE_BYTES = 200;

/**
 * One pinned predecessor Version plus the declaration that must account for the
 * entire difference between it and the closure the surface would publish now.
 */
export interface WorkerSurfaceTransition {
  /** Authoritative current Version this declaration is pinned to. */
  readonly predecessorVersionId: string;
  readonly delta: WorkerClosureDelta;
}

export interface SurfaceTransitionAdmission {
  readonly delta: WorkerClosureDelta;
  /** Exact closure a fresh publication of this surface would realize. */
  readonly targetClosure: ExpectedBindingClosure;
  /** Secret names the current target requires. Empty for secret-free Workers. */
  readonly targetSecrets?: readonly string[];
  /**
   * Secrets Cloudflare's script-level store holds that the pinned Version does
   * not declare. A rollback leaves the store ahead of the served Version, and a
   * secret the Worker already holds is carried rather than demanded again.
   */
  readonly carriedStoreSecrets?: readonly string[];
}

/** Rejects duplicates and invalid names once, then sorts for stable reporting. */
export function normalizedWorkerClosureDelta(delta: WorkerClosureDelta): WorkerClosureDelta {
  const names = [
    ...delta.retiredVars,
    ...delta.addedVars,
    ...delta.refreshedVars,
    ...delta.addedBindings,
    ...delta.addedSecrets,
    ...delta.rotatedSecrets,
  ];
  if (new Set(names).size !== names.length) {
    throw preflightError("transition delta names one binding more than once");
  }
  for (const name of names) {
    if (!DELTA_NAME.test(name)) {
      throw preflightError("transition delta contains an invalid binding name");
    }
  }
  return {
    retiredVars: [...delta.retiredVars].sort(),
    addedVars: [...delta.addedVars].sort(),
    refreshedVars: [...delta.refreshedVars].sort(),
    addedBindings: [...delta.addedBindings].sort(),
    addedSecrets: [...delta.addedSecrets].sort(),
    rotatedSecrets: [...delta.rotatedSecrets].sort(),
  };
}

/**
 * The exact closure a pinned predecessor must already serve: the closure this
 * surface publishes now, with exactly the declared delta reversed.
 *
 * Added names must be absent. Retired and refreshed vars must still be declared
 * as plain text with an unconstrained value — retired because the target no
 * longer derives it, refreshed because the declaration exists precisely to say
 * the value is wrong. Every other name, type and value stays strict.
 */
export function transitionPredecessorClosure(
  targetClosure: ExpectedBindingClosure,
  input: {
    readonly delta: WorkerClosureDelta;
    readonly carriedStoreSecrets?: readonly string[];
  },
): ExpectedBindingClosure {
  const closure: Record<string, ExpectedBinding | null> = { ...targetClosure };
  for (const name of [
    ...input.delta.addedVars,
    ...input.delta.addedBindings,
    ...input.delta.addedSecrets,
    ...(input.carriedStoreSecrets ?? []),
  ]) {
    closure[name] = null;
  }
  for (const name of [...input.delta.retiredVars, ...input.delta.refreshedVars]) {
    closure[name] = { type: "plain_text", fields: {} };
  }
  return closure;
}

/**
 * Proves one pinned Version is admissible under the declaration.
 *
 * Refusals are ordered so the operator reads the most actionable sentence
 * first: a declaration that does not describe the current target, then a
 * declaration that does not account for the whole difference (naming every
 * unaccounted binding), then a no-op refresh, and only then the exact closure.
 */
export function assertSurfaceTransitionPredecessor(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  admission: SurfaceTransitionAdmission,
): void {
  const delta = normalizedWorkerClosureDelta(admission.delta);
  if (workerClosureDeltaIsEmpty(delta)) {
    throw phaseError(
      phase,
      "transition requires a non-empty declared delta; use the routine surface instead",
    );
  }
  const targetSecrets = admission.targetSecrets ?? [];
  const carriedStoreSecrets = admission.carriedStoreSecrets ?? [];
  assertDeltaNamesTarget(phase, delta, admission.targetClosure, targetSecrets);
  assertDeltaAccountsForDifference(
    phase,
    versionId,
    exactVersionBindingNames(phase, versionId, version),
    admission.targetClosure,
    delta,
    carriedStoreSecrets,
  );
  assertRefreshedVarsDiffer(phase, versionId, version, admission.targetClosure, delta);
  assertExactVersionBindingClosure(
    phase,
    versionId,
    version,
    transitionPredecessorClosure(admission.targetClosure, { delta, carriedStoreSecrets }),
  );
}

/** Whether the pinned Version is admissible, without raising. */
export function surfaceTransitionAdmits(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  admission: SurfaceTransitionAdmission,
): boolean {
  try {
    assertSurfaceTransitionPredecessor(phase, versionId, version, admission);
    return true;
  } catch (error) {
    if (error instanceof DeployError) return false;
    throw error;
  }
}

/** The declared names must be meaningful against the closure being published. */
function assertDeltaNamesTarget(
  phase: DeployPhase,
  delta: WorkerClosureDelta,
  targetClosure: ExpectedBindingClosure,
  targetSecrets: readonly string[],
): void {
  const offences: string[] = [];
  for (const name of delta.retiredVars) {
    if (present(targetClosure[name])) offences.push(`retired-var-still-in-target:${name}`);
  }
  for (const name of delta.addedVars) {
    if (!isPlainText(targetClosure[name])) offences.push(`added-var-not-a-target-var:${name}`);
  }
  for (const name of delta.refreshedVars) {
    if (!isPlainText(targetClosure[name])) offences.push(`refreshed-var-not-a-target-var:${name}`);
  }
  for (const name of delta.addedBindings) {
    const requirement = targetClosure[name];
    if (!present(requirement) || isPlainText(requirement) || isSecretText(requirement)) {
      offences.push(`added-binding-not-a-target-binding:${name}`);
    }
  }
  for (const name of delta.addedSecrets) {
    if (!targetSecrets.includes(name)) offences.push(`added-secret-not-a-target-secret:${name}`);
  }
  for (const name of delta.rotatedSecrets) {
    if (!targetSecrets.includes(name)) offences.push(`rotated-secret-not-a-target-secret:${name}`);
  }
  if (offences.length > 0) {
    throw phaseError(
      phase,
      "declared transition delta does not describe the closure this surface publishes",
      JSON.stringify(offences.sort()),
    );
  }
}

/**
 * Refuses before any mutation when the declaration is not exactly the observed
 * difference, and names every unaccounted binding in the refusal.
 */
function assertDeltaAccountsForDifference(
  phase: DeployPhase,
  versionId: string,
  actualNames: readonly string[],
  targetClosure: ExpectedBindingClosure,
  delta: WorkerClosureDelta,
  carriedStoreSecrets: readonly string[],
): void {
  const actual = new Set(actualNames);
  // A secret the script-level store already holds is present for the purpose of
  // "is this binding missing", even when the served Version does not declare it.
  const held = new Set([...actualNames, ...carriedStoreSecrets]);
  const expected = new Set(
    Object.entries(targetClosure)
      .filter(([, requirement]) => requirement !== null)
      .map(([name]) => name),
  );
  const declaredAdded = new Set([
    ...delta.addedVars,
    ...delta.addedBindings,
    ...delta.addedSecrets,
  ]);
  const declaredRetired = new Set(delta.retiredVars);
  const undeclaredExtra = [...actual].filter(
    (name) => !expected.has(name) && !declaredRetired.has(name),
  );
  const undeclaredMissing = [...expected].filter(
    (name) => !held.has(name) && !declaredAdded.has(name),
  );
  const retiredNotPresent = [...declaredRetired].filter((name) => !actual.has(name));
  const refreshedNotPresent = delta.refreshedVars.filter((name) => !actual.has(name));
  const addedAlreadyPresent = [...declaredAdded].filter((name) => actual.has(name));
  const rotatedNotPresent = delta.rotatedSecrets.filter((name) => !held.has(name));
  if (
    undeclaredExtra.length > 0 ||
    undeclaredMissing.length > 0 ||
    retiredNotPresent.length > 0 ||
    refreshedNotPresent.length > 0 ||
    addedAlreadyPresent.length > 0 ||
    rotatedNotPresent.length > 0
  ) {
    throw phaseError(
      phase,
      `version ${versionId} differs from the target closure outside the declared delta`,
      JSON.stringify({
        undeclaredExtraBindings: undeclaredExtra.sort(),
        undeclaredMissingBindings: undeclaredMissing.sort(),
        retiredVarsAbsentFromPredecessor: retiredNotPresent.sort(),
        refreshedVarsAbsentFromPredecessor: [...refreshedNotPresent].sort(),
        addedBindingsAlreadyPresent: addedAlreadyPresent.sort(),
        rotatedSecretsAbsentFromPredecessor: [...rotatedNotPresent].sort(),
      }),
    );
  }
}

/**
 * A refreshed var must actually be wrong on the predecessor.
 *
 * Declaring one that already equals the target value would hide a no-op inside
 * a reviewed transition and let the selector stand in for the routine surface.
 * Only names reach the refusal; the values themselves stay out of diagnostics.
 */
function assertRefreshedVarsDiffer(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  targetClosure: ExpectedBindingClosure,
  delta: WorkerClosureDelta,
): void {
  const unchanged = delta.refreshedVars.filter((name) => {
    const requirement = targetClosure[name];
    if (!isPlainText(requirement)) return false;
    return (
      optionalExactPlainTextBinding(phase, versionId, version, name) === requirement.fields.text
    );
  });
  if (unchanged.length > 0) {
    throw phaseError(
      phase,
      `version ${versionId} already binds a refreshed var with the exact target value`,
      JSON.stringify([...unchanged].sort()),
    );
  }
}

/**
 * One observed difference between the closure a surface would publish and the
 * closure one live Version actually serves.
 *
 * This is the readback that turns "no profile matches" into an operator-legible
 * fact. Values are echoed only while they are short enough to read; anything
 * longer is reported as a digest and a byte count, so a capability manifest
 * stays a comparison rather than a wall of JSON.
 */
export interface BindingDifference {
  readonly binding: string;
  readonly difference: "missing" | "unexpected" | "type" | "value";
  readonly field?: string;
  readonly target?: string;
  readonly live?: string;
  /**
   * Set only when `live` is the exact observed value rather than a digest
   * summary. Adoption of a live value into the descriptor requires it: a value
   * an operator cannot read in the readback is not one they can review.
   */
  readonly liveIsExact?: true;
}

/** Every difference on one Worker, as one readback row. */
export interface WorkerBindingDrift {
  readonly workerName: string;
  readonly versionId: string;
  readonly differences: readonly BindingDifference[];
}

/** Every difference between one live Version and the closure it should serve. */
export function describeBindingDrift(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  expected: ExpectedBindingClosure,
): readonly BindingDifference[] {
  const bindings = readVersionBindings(phase, versionId, version);
  const observed = new Map<string, Record<string, unknown>>();
  for (const binding of bindings) {
    const name =
      typeof binding.name === "string"
        ? binding.name
        : typeof binding.binding === "string"
          ? binding.binding
          : null;
    if (name !== null) observed.set(name, binding);
  }
  const differences: BindingDifference[] = [];
  for (const [name, requirement] of Object.entries(expected)) {
    const node = observed.get(name);
    if (requirement === null) {
      if (node !== undefined) {
        differences.push({
          binding: name,
          difference: "unexpected",
          live: typeof node.type === "string" ? node.type : "unknown",
        });
      }
      continue;
    }
    if (node === undefined) {
      differences.push({ binding: name, difference: "missing", target: requirement.type });
      continue;
    }
    if (node.type !== requirement.type) {
      differences.push({
        binding: name,
        difference: "type",
        target: requirement.type,
        live: typeof node.type === "string" ? node.type : "unknown",
      });
      continue;
    }
    for (const [field, value] of Object.entries(requirement.fields)) {
      if (node[field] === value) continue;
      const observedValue = node[field];
      differences.push({
        binding: name,
        difference: "value",
        field,
        target: reportedValue(value),
        live: reportedValue(observedValue),
        ...(isExactlyReportable(observedValue) ? { liveIsExact: true as const } : {}),
      });
    }
  }
  for (const name of observed.keys()) {
    if (!(name in expected)) {
      const node = observed.get(name);
      differences.push({
        binding: name,
        difference: "unexpected",
        live: typeof node?.type === "string" ? node.type : "unknown",
      });
    }
  }
  return differences.sort((left, right) =>
    left.binding === right.binding
      ? `${left.field ?? ""}`.localeCompare(`${right.field ?? ""}`)
      : left.binding.localeCompare(right.binding),
  );
}

function isExactlyReportable(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_REPORTED_VALUE_BYTES
  );
}

function reportedValue(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value !== "string") return `non-string:${typeof value}`;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_REPORTED_VALUE_BYTES) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex")} (${bytes.byteLength} bytes)`;
}

function present(requirement: ExpectedBinding | null | undefined): requirement is ExpectedBinding {
  return requirement !== null && requirement !== undefined;
}

function isPlainText(
  requirement: ExpectedBinding | null | undefined,
): requirement is ExpectedBinding {
  return present(requirement) && requirement.type === "plain_text";
}

function isSecretText(requirement: ExpectedBinding | null | undefined): boolean {
  return present(requirement) && requirement.type === "secret_text";
}

function phaseError(phase: DeployPhase, message: string, detail?: string): DeployError {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "mutation") return mutationError(message, detail);
  return verificationError(message, detail);
}
