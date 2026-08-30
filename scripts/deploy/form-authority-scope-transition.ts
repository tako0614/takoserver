import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../src/json.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import { preflightError } from "./errors.ts";
import type { DeployTarget } from "./target.ts";

const KIND = "takoserver.integration-form-authority-scope-transition@v1";
const MAX_DESCRIPTOR_BYTES = 16_384;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

export interface FormAuthorityScope {
  readonly tenantId: string;
  readonly space: string;
}

export interface FormAuthorityScopeTransition {
  readonly kind: typeof KIND;
  readonly environment: "integration";
  readonly hostId: string;
  readonly predecessorScope: FormAuthorityScope;
  readonly targetScope: FormAuthorityScope;
}

export interface LoadedFormAuthorityScopeTransition {
  readonly value: FormAuthorityScopeTransition;
  readonly digest: `sha256:${string}`;
}

/**
 * Opens one operator-owned transition descriptor only after proving its full
 * path link-free. The returned value deliberately carries no source path.
 */
export function loadFormAuthorityScopeTransition(
  path: string,
  target: DeployTarget,
): LoadedFormAuthorityScopeTransition {
  if (!isAbsolute(path)) {
    throw preflightError("Form authority scope transition selector must be an absolute path");
  }
  const normalized = linkFreePath(path);

  let descriptor: number | null = null;
  let raw: Uint8Array;
  try {
    descriptor = openSync(normalized, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
      (status.mode & 0o7777) !== 0o600 ||
      status.size < 1 ||
      status.size > MAX_DESCRIPTOR_BYTES
    ) {
      throw new Error("unsafe");
    }
    raw = readFileSync(descriptor);
  } catch {
    throw preflightError(
      "Form authority scope transition must be an owned 0600 link-free regular file of at most 16 KiB",
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }

  let parsed: unknown;
  try {
    parsed = parseStrictJson(raw, MAX_DESCRIPTOR_BYTES);
  } catch {
    throw preflightError("Form authority scope transition is not strict bounded JSON");
  }
  const value = parseDescriptor(parsed);
  const loaded = {
    value,
    digest: formAuthorityScopeTransitionDigest(value),
  } as const;
  assertLoadedFormAuthorityScopeTransition(loaded, target);
  return loaded;
}

function linkFreePath(path: string): string {
  const normalized = resolve(path);
  const parts = normalized.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    let status: ReturnType<typeof lstatSync>;
    try {
      status = lstatSync(current);
    } catch {
      throw preflightError("Form authority scope transition path is unavailable");
    }
    if (status.isSymbolicLink()) {
      throw preflightError("Form authority scope transition path contains a symlink");
    }
    if (current !== normalized && !status.isDirectory()) {
      throw preflightError("Form authority scope transition path has a non-directory ancestor");
    }
  }
  const parent = dirname(normalized);
  let parentStatus: ReturnType<typeof lstatSync>;
  try {
    parentStatus = lstatSync(parent);
  } catch {
    throw preflightError("Form authority scope transition parent is unavailable");
  }
  if (
    !parentStatus.isDirectory() ||
    (parentStatus.mode & 0o7777) !== 0o700 ||
    (typeof process.getuid === "function" && parentStatus.uid !== process.getuid())
  ) {
    throw preflightError(
      "Form authority scope transition parent must be an owned exact-0700 directory",
    );
  }
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      throw preflightError("Form authority scope transition must stay outside every Git worktree");
    }
    const next = dirname(cursor);
    if (next === cursor) break;
  }
  return normalized;
}

export function assertLoadedFormAuthorityScopeTransition(
  loaded: LoadedFormAuthorityScopeTransition,
  target: DeployTarget,
): void {
  const value = parseDescriptor(loaded.value);
  assertFormAuthorityScopeTransitionTarget(value, target);
  if (loaded.digest !== formAuthorityScopeTransitionDigest(value)) {
    throw preflightError("Form authority scope transition digest is invalid");
  }
}

export function formAuthorityScopeTransitionDigest(
  value: FormAuthorityScopeTransition,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function assertFormAuthorityScopeTransitionTarget(
  transition: FormAuthorityScopeTransition,
  target: DeployTarget,
): void {
  if (target.environment !== "integration") {
    throw preflightError("Form authority scope transition is integration-only");
  }
  const authority = target.formAuthority;
  if (!authority?.integrationOperatorScope) {
    throw preflightError("Form authority scope transition target is incomplete");
  }
  if (transition.environment !== "integration" || transition.hostId !== authority.hostId) {
    throw preflightError("Form authority scope transition Host identity does not match the target");
  }
  if (!sameScope(transition.targetScope, authority.integrationOperatorScope)) {
    throw preflightError("Form authority scope transition target scope does not match the target");
  }
  if (sameScope(transition.predecessorScope, transition.targetScope)) {
    throw preflightError(
      "Form authority scope transition predecessor and target scopes must differ",
    );
  }
}

function parseDescriptor(value: unknown): FormAuthorityScopeTransition {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["kind", "environment", "hostId", "predecessorScope", "targetScope"])
  ) {
    throw preflightError("Form authority scope transition must contain only its exact v1 members");
  }
  if (value.kind !== KIND) {
    throw preflightError(`Form authority scope transition kind must be ${KIND}`);
  }
  if (value.environment !== "integration") {
    throw preflightError("Form authority scope transition environment must be integration");
  }
  if (typeof value.hostId !== "string" || value.hostId.length === 0 || value.hostId.length > 255) {
    throw preflightError("Form authority scope transition hostId is invalid");
  }
  return {
    kind: KIND,
    environment: "integration",
    hostId: value.hostId,
    predecessorScope: parseScope(value.predecessorScope, "predecessorScope"),
    targetScope: parseScope(value.targetScope, "targetScope"),
  };
}

function parseScope(value: unknown, label: string): FormAuthorityScope {
  if (!isRecord(value) || !exactKeys(value, ["tenantId", "space"])) {
    throw preflightError(`Form authority scope transition ${label} is invalid`);
  }
  return {
    tenantId: boundedIdentity(value.tenantId, `${label}.tenantId`),
    space: boundedIdentity(value.space, `${label}.space`),
  };
}

function boundedIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    !IDENTITY.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw preflightError(`Form authority scope transition ${label} is invalid`);
  }
  return value;
}

function sameScope(left: FormAuthorityScope, right: FormAuthorityScope): boolean {
  return left.tenantId === right.tenantId && left.space === right.space;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
