import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { preflightError } from "./errors.ts";
import type { DeployEnvironment } from "./qualification.ts";
import { loadTarget } from "./target.ts";
import type { WorkerBindingDrift } from "./worker-surface-transition.ts";

/**
 * Adopting a live value into the operator-private target descriptor.
 *
 * A steady descriptor and the live Worker can legitimately disagree, and the
 * live side is sometimes the truth: a scope transition was driven from a
 * separate descriptor and the steady one was never advanced, so it still names
 * the retired Space. The surfaces then refuse forever, and the only way out
 * today is to hand-edit an operator-private file and hope the edit matched.
 *
 * So the readback names the difference and this module answers it in the one
 * safe direction: it writes a *candidate* descriptor the operator inspects and
 * moves into place. It never edits the descriptor, and it only adopts values a
 * descriptor actually owns. A code-derived value is refused by name — the
 * commit is the truth there, and the remedy is to publish it with the surface's
 * own `--refresh-var` declaration.
 */

/** Where one binding's value lives in the descriptor. */
export interface DescriptorBinding {
  /** The Version binding field carrying the value (`text`, `service`, …). */
  readonly field: string;
  /** RFC 6901 pointer into the descriptor JSON. */
  readonly pointer: string;
}

export type DescriptorBindingMap = Readonly<Record<string, DescriptorBinding>>;

/**
 * Bindings whose live value is never evidence about the descriptor, with the
 * sentence that says what to do instead.
 */
export const NEVER_ADOPTED: Readonly<Record<string, string>> = {
  TAKOSERVER_ENVIRONMENT: "selected by the invocation, never read back from live state",
  TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST:
    "code-derived: the selected commit is the truth; publish it with " +
    "--closure-predecessor-version=<live> --refresh-var=TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
  TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST:
    "code-derived: the selected commit is the truth; publish it with " +
    "--closure-predecessor-version=<live> --refresh-var=TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST",
  STATE_DB:
    "durable data identity: repointing a Host at another database is an explicit reviewed " +
    "descriptor change, never a drift adoption",
  OBJECTS:
    "durable data identity: repointing a Host at another bucket is an explicit reviewed " +
    "descriptor change, never a drift adoption",
  PUBLIC_HOST_IDENTITY:
    "names this target's own public Worker; moving the Host is an explicit reviewed " +
    "descriptor change, never a drift adoption",
};

export interface AdoptedValue {
  readonly worker: string;
  readonly binding: string;
  readonly field: string;
  readonly pointer: string;
  readonly target: string;
  readonly live: string;
}

export interface RefusedAdoption {
  readonly worker: string;
  readonly binding: string;
  readonly reason: string;
}

export interface TargetAdoptionPlan {
  readonly adopted: readonly AdoptedValue[];
  readonly refused: readonly RefusedAdoption[];
}

/**
 * Sorts every observed difference into the values a descriptor owns and the
 * values it does not. Nothing is written here; the plan is the reviewable part.
 */
export function planTargetAdoption(
  drift: readonly WorkerBindingDrift[],
  map: DescriptorBindingMap,
): TargetAdoptionPlan {
  const adopted: AdoptedValue[] = [];
  const refused: RefusedAdoption[] = [];
  for (const worker of drift) {
    for (const difference of worker.differences) {
      const never = NEVER_ADOPTED[difference.binding];
      if (never !== undefined) {
        refused.push({ worker: worker.workerName, binding: difference.binding, reason: never });
        continue;
      }
      if (difference.difference !== "value") {
        refused.push({
          worker: worker.workerName,
          binding: difference.binding,
          reason:
            `the closure itself differs (${difference.difference}), not one descriptor value; ` +
            "declare it with --add-binding, --add-var or --retire-var",
        });
        continue;
      }
      const descriptor = map[difference.binding];
      if (descriptor === undefined || descriptor.field !== difference.field) {
        refused.push({
          worker: worker.workerName,
          binding: difference.binding,
          reason: "no descriptor field owns this binding value",
        });
        continue;
      }
      if (difference.liveIsExact !== true || difference.live === undefined) {
        refused.push({
          worker: worker.workerName,
          binding: difference.binding,
          reason: "the live value is too large to be read back exactly, so it cannot be reviewed",
        });
        continue;
      }
      adopted.push({
        worker: worker.workerName,
        binding: difference.binding,
        field: descriptor.field,
        pointer: descriptor.pointer,
        target: difference.target ?? "absent",
        live: difference.live,
      });
    }
  }
  return { adopted: sortAdopted(adopted), refused: sortRefused(refused) };
}

export interface WrittenTargetCandidate {
  readonly path: string;
  readonly digest: `sha256:${string}`;
  readonly patch: readonly { readonly pointer: string; readonly value: string }[];
}

/**
 * Writes the candidate descriptor and proves it still loads as a target.
 *
 * The candidate is a new `0600` file at an absolute path the operator names. It
 * is never the descriptor itself, is never overwritten, and stays outside every
 * Git worktree, because a descriptor that reached a tracked tree is a leak
 * whether or not it was ever committed.
 */
export function writeAdoptedTargetCandidate(input: {
  readonly descriptorPath: string;
  readonly candidatePath: string;
  readonly environment: DeployEnvironment;
  readonly plan: TargetAdoptionPlan;
}): WrittenTargetCandidate {
  if (input.plan.adopted.length === 0) {
    throw preflightError(
      "no descriptor-owned value differs; --adopt-live has nothing to write",
      JSON.stringify(input.plan.refused),
    );
  }
  const candidate = candidateDestination(input.candidatePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(input.descriptorPath, "utf8"));
  } catch {
    throw preflightError("deploy target descriptor cannot be re-read for adoption");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw preflightError("deploy target descriptor is not an object");
  }
  const patch: { readonly pointer: string; readonly value: string }[] = [];
  for (const adoption of input.plan.adopted) {
    applyPointer(parsed as Record<string, unknown>, adoption.pointer, adoption.live);
    patch.push({ pointer: adoption.pointer, value: adoption.live });
  }
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  writeFileSync(candidate, serialized, { mode: 0o600, flag: "wx" });
  // A candidate that cannot load is not a candidate; prove it before returning.
  loadTarget(candidate, input.environment);
  return {
    path: candidate,
    digest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    patch,
  };
}

function candidateDestination(path: string): string {
  if (!isAbsolute(path)) throw preflightError("--adopt-live must be one absolute path");
  const normalized = resolve(path);
  if (existsSync(normalized)) {
    throw preflightError("--adopt-live refuses to overwrite an existing file");
  }
  const parent = dirname(normalized);
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(parent);
  } catch {
    throw preflightError("--adopt-live parent directory is unavailable");
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw preflightError("--adopt-live parent must be a link-free directory");
  }
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      throw preflightError("--adopt-live candidate must stay outside every Git worktree");
    }
    const next = dirname(cursor);
    if (next === cursor) break;
  }
  if (normalized.split(sep).some((part) => part === "..")) {
    throw preflightError("--adopt-live must be one normalized absolute path");
  }
  return normalized;
}

/**
 * Replaces exactly one existing string leaf. Adoption corrects a value the
 * descriptor already declares; it never grows the descriptor a new shape.
 */
function applyPointer(root: Record<string, unknown>, pointer: string, value: string): void {
  const parts = pointer.split("/").slice(1);
  let cursor: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw preflightError(`deploy target descriptor has no object at ${pointer}`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (leaf === undefined || typeof cursor[leaf] !== "string") {
    throw preflightError(`deploy target descriptor has no string value at ${pointer}`);
  }
  cursor[leaf] = value;
}

function sortAdopted(values: readonly AdoptedValue[]): readonly AdoptedValue[] {
  return [...values].sort((left, right) => left.pointer.localeCompare(right.pointer));
}

function sortRefused(values: readonly RefusedAdoption[]): readonly RefusedAdoption[] {
  return [...values].sort((left, right) =>
    left.binding === right.binding
      ? left.worker.localeCompare(right.worker)
      : left.binding.localeCompare(right.binding),
  );
}
