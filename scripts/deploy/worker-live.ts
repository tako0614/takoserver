import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { expectedWorkerSecrets } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  expectedLegacyPreVersionMetadataBindingClosure,
  expectedTransitionBindingClosure,
  extractLegacyHostServiceBinding,
  type LegacyHostServiceBinding,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
  workerVersionMetadataBindingProfile,
} from "./worker-state.ts";

const WORKER_MESSAGE = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u;
const WORKER_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const LEGACY_UNATTRIBUTED_PREDECESSOR = "legacy-unattributed-predecessor" as const;
export const LEGACY_PRE_VERSION_METADATA_PROFILE = "pre-version-metadata" as const;

export interface WorkerState {
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerSecrets(workerName: string): Promise<readonly unknown[]>;
}

export interface LiveWorkerVersion {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly bundleDigestHex: string;
  readonly legacyPredecessorProfile?: typeof LEGACY_PRE_VERSION_METADATA_PROFILE;
}

export interface LegacyLiveWorkerVersion {
  readonly history: WorkerDeploymentHistory;
  readonly commit: null;
  readonly bundleDigestHex: null;
  readonly predecessorIdentity: typeof LEGACY_UNATTRIBUTED_PREDECESSOR;
  readonly legacyPredecessorProfile: typeof LEGACY_PRE_VERSION_METADATA_PROFILE;
}

export interface RetirementLiveWorkerVersion {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string | null;
  readonly bundleDigestHex: string | null;
  readonly serviceBinding: LegacyHostServiceBinding | null;
  readonly hostedTokenPresent: boolean;
}

/**
 * Reads the exact code/binding/secret closure used by the three Hosted-edge
 * retirement transitions. The service identity is supplied only by the
 * transition caller; ordinary target inspection never accepts it.
 */
export async function inspectLiveWorkerVersionForRetirement(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly expectedServiceBinding: LegacyHostServiceBinding | null;
    readonly expectedSecrets: readonly string[];
    readonly expectedInventorySecrets?: readonly string[];
    readonly expectedVersionId?: string;
    readonly signingKeyId?: string;
  },
): Promise<RetirementLiveWorkerVersion> {
  const history = parseWorkerDeploymentHistory(await state.workerDeployments(target.workerName));
  if (history === null) throw phaseError(phase, "Worker has no authoritative current deployment");
  if (input.expectedVersionId !== undefined && history.versionId !== input.expectedVersionId) {
    throw phaseError(
      phase,
      "authoritative current Worker Version does not match the selected retirement predecessor",
      `expected=${input.expectedVersionId} actual=${history.versionId}`,
    );
  }
  const version = await state.workerVersion(target.workerName, history.versionId);
  const metadataProfile = workerVersionMetadataBindingProfile(phase, history.versionId, version);
  const identity = workerVersionIdentityOrLegacy(phase, version);
  assertExactVersionBindingClosure(
    phase,
    history.versionId,
    version,
    expectedTransitionBindingClosure(target, {
      serviceBinding: input.expectedServiceBinding,
      expectedSecrets: input.expectedSecrets,
      metadataProfile,
      ...(input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId }),
      ...(identity.kind === "canonical"
        ? {
            provenance: {
              sourceCommit: identity.commit,
              artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
            },
          }
        : {}),
    }),
  );
  const inventorySecrets = input.expectedInventorySecrets ?? input.expectedSecrets;
  assertExactSecretInventory(await state.workerSecrets(target.workerName), inventorySecrets, phase);
  assertDomainClosure(phase, target, await state.workerDomains());
  const historyAfter = parseWorkerDeploymentHistory(
    await state.workerDeployments(target.workerName),
  );
  if (
    historyAfter === null ||
    historyAfter.deploymentId !== history.deploymentId ||
    historyAfter.versionId !== history.versionId ||
    historyAfter.previousVersionId !== history.previousVersionId
  ) {
    throw phaseError(
      phase,
      "authoritative Worker deployment history changed during retirement inspection",
    );
  }
  return {
    history,
    commit: identity.kind === "canonical" ? identity.commit : null,
    bundleDigestHex: identity.kind === "canonical" ? identity.bundleDigestHex : null,
    serviceBinding:
      input.expectedServiceBinding === null
        ? null
        : extractLegacyHostServiceBinding(phase, history.versionId, version),
    hostedTokenPresent: inventorySecrets.includes("TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN"),
  };
}

/** Exact authoritative code/config/secret/domain state for one served Version. */
export async function inspectLiveWorkerVersion(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
  },
): Promise<LiveWorkerVersion> {
  const inspected = await inspectLiveWorkerVersionCore(phase, target, state, input, "strict");
  if (inspected.commit === null) {
    throw phaseError(phase, "Worker version has no exact commit and artifact annotation");
  }
  return inspected;
}

/**
 * Reads one explicitly pinned integration predecessor while permitting only a
 * the exact known absence of the pre-version-metadata self binding. Artifact
 * identity is retained when canonical and represented as unattributed only
 * when its annotation is missing or malformed. Every other binding, secret,
 * domain, and target check remains identical to the strict path.
 */
export async function inspectLiveWorkerVersionWithLegacyPredecessor(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
    readonly legacyPredecessorVersionId: string;
  },
): Promise<LiveWorkerVersion | LegacyLiveWorkerVersion> {
  if (!isWorkerVersionId(input.legacyPredecessorVersionId)) {
    throw phaseError(phase, "legacy predecessor Version ID must be one exact UUID");
  }
  return await inspectLiveWorkerVersionCore(phase, target, state, input, "pinned-current");
}

/**
 * Reconciles a selector-bearing read after an upload acknowledgement may have
 * been lost. Only the selected current Version or its exact direct successor
 * is related to that attempt; an advanced Version is always read strictly.
 */
export async function inspectLiveWorkerVersionForLegacyStatus(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
    readonly legacyPredecessorVersionId: string;
  },
): Promise<LiveWorkerVersion | LegacyLiveWorkerVersion> {
  if (!isWorkerVersionId(input.legacyPredecessorVersionId)) {
    throw phaseError(phase, "legacy predecessor Version ID must be one exact UUID");
  }
  return await inspectLiveWorkerVersionCore(phase, target, state, input, "status-reconciliation");
}

async function inspectLiveWorkerVersionCore(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
    readonly legacyPredecessorVersionId?: string;
  },
  mode: "strict" | "pinned-current" | "status-reconciliation",
): Promise<LiveWorkerVersion | LegacyLiveWorkerVersion> {
  const history = parseWorkerDeploymentHistory(await state.workerDeployments(target.workerName));
  if (history === null) throw phaseError(phase, "Worker has no authoritative current deployment");
  const selector = input.legacyPredecessorVersionId;
  const selectorIsCurrent = selector !== undefined && history.versionId === selector;
  if (mode === "pinned-current" && !selectorIsCurrent) {
    throw phaseError(
      phase,
      "authoritative current Worker Version does not match the pinned legacy predecessor",
      `expected=${selector} actual=${history.versionId}`,
    );
  }
  if (
    mode === "status-reconciliation" &&
    !selectorIsCurrent &&
    history.previousVersionId !== selector
  ) {
    throw phaseError(
      phase,
      "authoritative current Worker Version is not the direct successor of the pinned legacy predecessor",
      `expected_previous=${selector} actual_previous=${history.previousVersionId ?? "none"} current=${history.versionId}`,
    );
  }
  const version = await state.workerVersion(target.workerName, history.versionId);
  const metadataBindingProfile = workerVersionMetadataBindingProfile(
    phase,
    history.versionId,
    version,
  );
  const legacyPredecessorProfile =
    mode !== "strict" && selectorIsCurrent && metadataBindingProfile === "pre-version-metadata"
      ? LEGACY_PRE_VERSION_METADATA_PROFILE
      : null;
  const identity =
    legacyPredecessorProfile === null
      ? { kind: "canonical" as const, ...workerVersionIdentity(phase, version) }
      : workerVersionIdentityOrLegacy(phase, version);
  const bindingInput = {
    ...(input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId }),
    ...(input.expectedSecrets === undefined ? {} : { expectedSecrets: input.expectedSecrets }),
    ...(identity.kind === "canonical"
      ? {
          provenance: {
            sourceCommit: identity.commit,
            artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
          },
        }
      : {}),
  } as const;
  assertExactVersionBindingClosure(
    phase,
    history.versionId,
    version,
    legacyPredecessorProfile !== null
      ? expectedLegacyPreVersionMetadataBindingClosure(target, bindingInput)
      : expectedExactBindingClosure(target, bindingInput),
  );
  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    input.expectedSecrets ?? expectedWorkerSecrets(target),
    phase,
  );
  assertDomainClosure(phase, target, await state.workerDomains());
  if (mode === "pinned-current") {
    const historyAfterClosure = parseWorkerDeploymentHistory(
      await state.workerDeployments(target.workerName),
    );
    if (
      historyAfterClosure === null ||
      historyAfterClosure.deploymentId !== history.deploymentId ||
      historyAfterClosure.versionId !== history.versionId ||
      historyAfterClosure.previousVersionId !== history.previousVersionId
    ) {
      throw phaseError(
        phase,
        "authoritative Worker deployment history changed during closure inspection",
      );
    }
  }
  return identity.kind === "canonical"
    ? {
        history,
        commit: identity.commit,
        bundleDigestHex: identity.bundleDigestHex,
        ...(legacyPredecessorProfile === null ? {} : { legacyPredecessorProfile }),
      }
    : {
        history,
        commit: null,
        bundleDigestHex: null,
        predecessorIdentity: LEGACY_UNATTRIBUTED_PREDECESSOR,
        legacyPredecessorProfile: LEGACY_PRE_VERSION_METADATA_PROFILE,
      };
}

export function workerVersionIdentity(
  phase: DeployPhase,
  value: unknown,
): { readonly commit: string; readonly bundleDigestHex: string } {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    throw phaseError(phase, "Worker version has no canonical annotation inventory");
  }
  const message = value.annotations["workers/message"];
  const match = typeof message === "string" ? WORKER_MESSAGE.exec(message) : null;
  if (!match?.[1] || !match[2]) {
    throw phaseError(phase, "Worker version has no exact commit and artifact annotation");
  }
  return { commit: match[1], bundleDigestHex: match[2] };
}

/**
 * Reads Cloudflare's content hash for one immutable Worker Version.
 *
 * The Version detail endpoint exposes this under `resources.script.etag` and
 * documents it as hashed script content.  The top-level resource ETag and
 * binding/annotation identities are different facts, so callers that need a
 * byte proof must use this field. Cloudflare exposes the value as an opaque
 * string rather than promising a particular digest encoding; keep it bounded
 * and non-empty, then compare it exactly across Version detail responses.
 */
export function workerVersionScriptContentIdentity(
  phase: DeployPhase,
  versionId: string,
  value: unknown,
): string {
  if (!isRecord(value) || !isRecord(value.resources) || !isRecord(value.resources.script)) {
    throw phaseError(phase, `version ${versionId} has no script content identity`);
  }
  const etag = value.resources.script.etag;
  if (typeof etag !== "string" || etag.length === 0 || etag.length > 1024 || etag.trim() !== etag) {
    throw phaseError(
      phase,
      `version ${versionId} has no strong script content identity`,
      typeof etag === "string" ? `etag=${etag}` : undefined,
    );
  }
  return etag;
}

function workerVersionIdentityOrLegacy(
  _phase: DeployPhase,
  value: unknown,
):
  | { readonly kind: "canonical"; readonly commit: string; readonly bundleDigestHex: string }
  | { readonly kind: typeof LEGACY_UNATTRIBUTED_PREDECESSOR } {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    return { kind: LEGACY_UNATTRIBUTED_PREDECESSOR };
  }
  const message = value.annotations["workers/message"];
  const match = typeof message === "string" ? WORKER_MESSAGE.exec(message) : null;
  if (!match?.[1] || !match[2]) {
    return { kind: LEGACY_UNATTRIBUTED_PREDECESSOR };
  }
  return { kind: "canonical", commit: match[1], bundleDigestHex: match[2] };
}

export function isWorkerVersionId(value: string): boolean {
  return WORKER_VERSION_ID.test(value);
}

export function assertDomainClosure(
  phase: DeployPhase,
  target: DeployTarget,
  entries: readonly { readonly hostname: string; readonly service: string }[],
): void {
  const canonical = new URL(target.publicOrigin).hostname;
  const expected = canonical.endsWith(".workers.dev")
    ? []
    : [canonical, ...(target.aliases ?? [])].sort();
  const actual: string[] = [];
  const ownerByHost = new Map<string, string[]>();
  for (const entry of entries) {
    if (!isHostname(entry.hostname) || entry.service.length === 0) {
      throw phaseError(phase, "Worker domain inventory contains a malformed entry");
    }
    const owners = ownerByHost.get(entry.hostname) ?? [];
    owners.push(entry.service);
    ownerByHost.set(entry.hostname, owners);
    if (entry.service === target.workerName) actual.push(entry.hostname);
  }
  for (const hostname of expected) {
    const owners = ownerByHost.get(hostname) ?? [];
    if (owners.length !== 1 || owners[0] !== target.workerName) {
      throw phaseError(
        phase,
        `Worker domain ${hostname} is not owned exactly once by ${target.workerName}`,
      );
    }
  }
  if (JSON.stringify([...new Set(actual)].sort()) !== JSON.stringify(expected)) {
    throw phaseError(
      phase,
      "Worker custom-domain inventory differs from the selected target",
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual.sort())}`,
    );
  }
}

function phaseError(phase: DeployPhase, message: string, detail?: string) {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "mutation") return mutationError(message, detail);
  return verificationError(message, detail);
}

function isHostname(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
