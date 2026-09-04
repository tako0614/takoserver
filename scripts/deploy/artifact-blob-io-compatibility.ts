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
import { parseStrictJson } from "../../src/strict-json.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import type { DeployTarget } from "./target.ts";
import { workerVersionIdentity, workerVersionScriptContentIdentity } from "./worker-live.ts";
import {
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  optionalExactPlainTextBinding,
  parseWorkerDeploymentChain,
} from "./worker-state.ts";

const RECEIPT_KIND = "takoserver.artifact-blob-io-quiescence@v1";
const QUIESCED_MODE = "pre-0043-quiesced";
const MAX_RECEIPT_BYTES = 16_384;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9@._:+/-]{2,255}$/u;
const COMPATIBILITY_PENDING_SUFFIX = [
  "0037_worker_runtime_input_preparation_v2.sql",
  "0038_selfhost_edge_kv.sql",
  "0039_takoform_live_native_claim_across_tenants.sql",
  "0040_selfhost_queues_and_schedules.sql",
  "0041_selfhost_object_buckets.sql",
  "0042_worker_endpoint_origin_reservation_space_id.sql",
  "0043_artifact_blob_io_fences.sql",
] as const;

export interface ArtifactBlobIoCompatibilityState {
  workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
}

export interface ArtifactBlobIoDeploymentCompatibility {
  readonly status: "compatibility_worker_required" | "drain_receipt_required" | "ready";
  readonly currentCompatibilityDeploymentId: string | null;
  readonly rollbackCompatibilityDeploymentId: string | null;
  readonly currentCompatibilityVersionId: string | null;
  readonly rollbackCompatibilityVersionId: string | null;
  readonly unsafePredecessorInvocations: "unproven" | "drained-or-cancelled";
}

interface QuiescenceReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly environment: DeployTarget["environment"];
  readonly accountId: string;
  readonly workerName: string;
  readonly databaseId: string;
  readonly bucketName: string;
  readonly currentCompatibilityDeploymentId: string;
  readonly rollbackCompatibilityDeploymentId: string;
  readonly currentCompatibilityVersionId: string;
  readonly rollbackCompatibilityVersionId: string;
  readonly unsafePredecessorInvocations: "drained-or-cancelled";
  readonly observedAt: string;
  readonly operator: string;
}

/** The only pending lineage for which the all-traffic quiescence Worker is valid. */
export function artifactBlobIoCompatibilityAllowsPending(
  target: DeployTarget,
  pending: readonly string[],
): boolean {
  if (target.artifactBlobIoMode !== QUIESCED_MODE || pending.length === 0) return false;
  return COMPATIBILITY_PENDING_SUFFIX.some(
    (_name, index) =>
      JSON.stringify(pending) === JSON.stringify(COMPATIBILITY_PENDING_SUFFIX.slice(index)),
  );
}

/** Public smoke for the maintenance Worker: every request must stop before composition. */
export async function probeArtifactBlobIoQuiescence(
  origin: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ readonly url: string; readonly status: 503; readonly traffic: "quiesced" }> {
  const url = `${origin}/healthz`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
      redirect: "error",
    });
  } catch (error) {
    throw verificationError(
      "artifact blob I/O compatibility Worker probe failed",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    response.status !== 503 ||
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("retry-after") !== "60" ||
    !isRecord(body) ||
    !isRecord(body.error) ||
    body.error.code !== "backend_unavailable" ||
    body.error.message !== "artifact blob I/O is quiesced for the 0043 compatibility cutover" ||
    !isRecord(body.error.details) ||
    body.error.details.reason !== "runtime-configuration"
  ) {
    throw verificationError(
      "artifact blob I/O compatibility Worker did not prove all-traffic quiescence",
      `status=${response.status}`,
    );
  }
  return { url, status: 503, traffic: "quiesced" };
}

/**
 * Proves the runtime half of the 0043 cutover.
 *
 * Two consecutive immutable Versions must contain the pre-0043-compatible
 * quiescence code and binding: one serves, one is the owned one-step rollback.
 * The private receipt is deliberately not manufactured here. It records the
 * external operator's proof that invocations of every older Version have
 * either completed or been cancelled while mutation ingress was blocked.
 */
export async function inspectArtifactBlobIoDeploymentCompatibility(input: {
  readonly phase: DeployPhase;
  readonly target: DeployTarget;
  readonly selectedCommit: string;
  readonly state: ArtifactBlobIoCompatibilityState;
  readonly receiptPath?: string;
}): Promise<ArtifactBlobIoDeploymentCompatibility> {
  if (input.target.artifactBlobIoMode !== QUIESCED_MODE) {
    return {
      status: "compatibility_worker_required",
      currentCompatibilityDeploymentId: null,
      rollbackCompatibilityDeploymentId: null,
      currentCompatibilityVersionId: null,
      rollbackCompatibilityVersionId: null,
      unsafePredecessorInvocations: "unproven",
    };
  }
  await assertPreviewUrlsDisabled(input.phase, input.target.workerName, input.state);
  const before = parseWorkerDeploymentChain(
    await input.state.workerDeployments(input.target.workerName),
    input.phase,
    { requireUuidVersionIds: true },
  );
  const currentDeployment = before[0];
  const rollbackDeployment = before[1];
  if (!currentDeployment || !rollbackDeployment) {
    throw phaseError(
      input.phase,
      "0043 requires current and one-step rollback compatibility Worker Versions",
    );
  }
  const currentDeploymentId = currentDeployment.deploymentId;
  const rollbackDeploymentId = rollbackDeployment.deploymentId;
  const currentVersionId = currentDeployment.versionId;
  const rollbackVersionId = rollbackDeployment.versionId;
  if (!VERSION_ID.test(currentDeploymentId) || !VERSION_ID.test(rollbackDeploymentId)) {
    throw phaseError(input.phase, "0043 compatibility Worker deployment identity is invalid");
  }
  const [current, rollback] = await Promise.all([
    input.state.workerVersion(input.target.workerName, currentVersionId),
    input.state.workerVersion(input.target.workerName, rollbackVersionId),
  ]);
  proveVersion(input.phase, input.target, input.selectedCommit, currentVersionId, current);
  proveVersion(input.phase, input.target, input.selectedCommit, rollbackVersionId, rollback);
  const currentScriptContentIdentity = workerVersionScriptContentIdentity(
    input.phase,
    currentVersionId,
    current,
  );
  const rollbackScriptContentIdentity = workerVersionScriptContentIdentity(
    input.phase,
    rollbackVersionId,
    rollback,
  );
  if (currentScriptContentIdentity !== rollbackScriptContentIdentity) {
    throw phaseError(
      input.phase,
      "0043 compatibility current and rollback Worker Versions do not share the same strong script content identity",
    );
  }
  const after = parseWorkerDeploymentChain(
    await input.state.workerDeployments(input.target.workerName),
    input.phase,
    { requireUuidVersionIds: true },
  );
  const currentAfter = after[0];
  const rollbackAfter = after[1];
  if (
    !currentAfter ||
    !rollbackAfter ||
    currentAfter.deploymentId !== currentDeploymentId ||
    currentAfter.versionId !== currentVersionId ||
    rollbackAfter.deploymentId !== rollbackDeploymentId ||
    rollbackAfter.versionId !== rollbackVersionId
  ) {
    throw phaseError(input.phase, "0043 compatibility Worker history changed during inspection");
  }
  await assertPreviewUrlsDisabled(input.phase, input.target.workerName, input.state);
  const withoutReceipt = {
    currentCompatibilityDeploymentId: currentDeploymentId,
    rollbackCompatibilityDeploymentId: rollbackDeploymentId,
    currentCompatibilityVersionId: currentVersionId,
    rollbackCompatibilityVersionId: rollbackVersionId,
  } as const;
  if (input.receiptPath === undefined) {
    return {
      status: "drain_receipt_required",
      ...withoutReceipt,
      unsafePredecessorInvocations: "unproven",
    };
  }
  const receipt = loadReceipt(input.receiptPath);
  assertReceipt(receipt, input.target, currentDeployment, rollbackDeployment, input.phase);
  return {
    status: "ready",
    ...withoutReceipt,
    unsafePredecessorInvocations: "drained-or-cancelled",
  };
}

async function assertPreviewUrlsDisabled(
  phase: DeployPhase,
  workerName: string,
  state: ArtifactBlobIoCompatibilityState,
): Promise<void> {
  const subdomain = await state.workerSubdomain(workerName);
  if (subdomain.previewsEnabled) {
    throw phaseError(
      phase,
      "0043 cannot proceed while public preview URLs remain enabled for historical Worker Versions",
    );
  }
}

function proveVersion(
  phase: DeployPhase,
  target: DeployTarget,
  selectedCommit: string,
  versionId: string,
  version: unknown,
): void {
  if (
    optionalExactPlainTextBinding(phase, versionId, version, "TAKOSERVER_ARTIFACT_BLOB_IO_MODE") !==
    QUIESCED_MODE
  ) {
    throw phaseError(
      phase,
      `Worker version ${versionId} is not ${QUIESCED_MODE}; historical object I/O remains possible`,
    );
  }
  const identity = workerVersionIdentity(phase, version);
  if (identity.commit !== selectedCommit) {
    throw phaseError(
      phase,
      "0043 compatibility Worker does not identify the selected source commit",
    );
  }
  const artifactDigest = `sha256:${identity.bundleDigestHex}` as const;
  assertExactVersionBindingClosure(
    phase,
    versionId,
    version,
    expectedExactBindingClosure(target, {
      workerArtifactDigest: artifactDigest,
      ...(target.integrationE2eCredentialAuthority === undefined
        ? {}
        : {
            authorityProfile: {
              kind: "provenance-bound-jit" as const,
              provenance: { sourceCommit: identity.commit, artifactDigest },
            },
          }),
    }),
  );
}

function loadReceipt(path: string): QuiescenceReceipt {
  if (!isAbsolute(path)) {
    throw preflightError("artifact blob I/O quiescence receipt path must be absolute");
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
      status.size > MAX_RECEIPT_BYTES
    ) {
      throw new Error("unsafe");
    }
    raw = readFileSync(descriptor);
  } catch {
    throw preflightError(
      "artifact blob I/O quiescence receipt must be an owned 0600 link-free regular file of at most 16 KiB",
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(raw, MAX_RECEIPT_BYTES);
  } catch {
    throw preflightError("artifact blob I/O quiescence receipt is not strict bounded JSON");
  }
  if (!isRecord(parsed)) throw preflightError("artifact blob I/O quiescence receipt is invalid");
  const keys = [
    "kind",
    "environment",
    "accountId",
    "workerName",
    "databaseId",
    "bucketName",
    "currentCompatibilityDeploymentId",
    "rollbackCompatibilityDeploymentId",
    "currentCompatibilityVersionId",
    "rollbackCompatibilityVersionId",
    "unsafePredecessorInvocations",
    "observedAt",
    "operator",
  ];
  if (
    Object.keys(parsed).sort().join("\0") !== [...keys].sort().join("\0") ||
    parsed.kind !== RECEIPT_KIND ||
    !["integration", "rehearsal", "production"].includes(String(parsed.environment)) ||
    typeof parsed.accountId !== "string" ||
    typeof parsed.workerName !== "string" ||
    typeof parsed.databaseId !== "string" ||
    typeof parsed.bucketName !== "string" ||
    typeof parsed.currentCompatibilityDeploymentId !== "string" ||
    typeof parsed.rollbackCompatibilityDeploymentId !== "string" ||
    typeof parsed.currentCompatibilityVersionId !== "string" ||
    typeof parsed.rollbackCompatibilityVersionId !== "string" ||
    parsed.unsafePredecessorInvocations !== "drained-or-cancelled" ||
    typeof parsed.observedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.observedAt)) ||
    typeof parsed.operator !== "string" ||
    !OPERATOR.test(parsed.operator)
  ) {
    throw preflightError("artifact blob I/O quiescence receipt is invalid");
  }
  return parsed as unknown as QuiescenceReceipt;
}

function assertReceipt(
  receipt: QuiescenceReceipt,
  target: DeployTarget,
  current: {
    readonly deploymentId: string;
    readonly versionId: string;
    readonly createdOn: string;
  },
  rollback: {
    readonly deploymentId: string;
    readonly versionId: string;
    readonly createdOn: string;
  },
  phase: DeployPhase,
): void {
  if (
    receipt.environment !== target.environment ||
    receipt.accountId !== target.accountId ||
    receipt.workerName !== target.workerName ||
    receipt.databaseId !== target.d1.databaseId ||
    receipt.bucketName !== target.r2.bucketName
  ) {
    throw phaseError(phase, "artifact blob I/O quiescence receipt names another deploy target");
  }
  if (
    receipt.currentCompatibilityDeploymentId !== current.deploymentId ||
    receipt.rollbackCompatibilityDeploymentId !== rollback.deploymentId
  ) {
    throw phaseError(
      phase,
      "artifact blob I/O quiescence receipt does not match the authoritative compatibility deployment identities",
    );
  }
  if (
    receipt.currentCompatibilityVersionId !== current.versionId ||
    receipt.rollbackCompatibilityVersionId !== rollback.versionId
  ) {
    throw phaseError(
      phase,
      "artifact blob I/O quiescence receipt does not match the authoritative compatibility versions",
    );
  }
  const observedAt = Date.parse(receipt.observedAt);
  if (observedAt < Date.parse(current.createdOn) || observedAt < Date.parse(rollback.createdOn)) {
    throw phaseError(
      phase,
      "artifact blob I/O quiescence receipt predates the compatibility deployments",
    );
  }
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
      throw preflightError("artifact blob I/O quiescence receipt path is unavailable");
    }
    if (status.isSymbolicLink()) {
      throw preflightError("artifact blob I/O quiescence receipt path contains a symlink");
    }
    if (current !== normalized && !status.isDirectory()) {
      throw preflightError(
        "artifact blob I/O quiescence receipt path has a non-directory ancestor",
      );
    }
  }
  const parent = dirname(normalized);
  const parentStatus = lstatSync(parent);
  if (
    !parentStatus.isDirectory() ||
    (parentStatus.mode & 0o7777) !== 0o700 ||
    (typeof process.getuid === "function" && parentStatus.uid !== process.getuid())
  ) {
    throw preflightError(
      "artifact blob I/O quiescence receipt parent must be an owned exact-0700 directory",
    );
  }
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      throw preflightError(
        "artifact blob I/O quiescence receipt must stay outside every Git worktree",
      );
    }
    const next = dirname(cursor);
    if (next === cursor) break;
  }
  return normalized;
}

function phaseError(phase: DeployPhase, message: string) {
  return phase === "mutation"
    ? mutationError(message)
    : phase === "verification"
      ? verificationError(message)
      : preflightError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
