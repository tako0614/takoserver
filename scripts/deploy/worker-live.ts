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
  parseWorkerDeploymentChain,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentChainEntry,
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

export interface CanonicalWorkerVersionWithScriptIdentity extends LiveWorkerVersion {
  readonly scriptEtag: string;
}

/**
 * A provider-created Version made by adding one named secret. Cloudflare does
 * not inherit the `workers/message` annotation when it creates this Version,
 * so the predecessor's canonical identity, exact closure and script content
 * identity are all required before this transition can be trusted.
 */
export interface SecretCreatedDirectSuccessor {
  readonly history: WorkerDeploymentHistory;
  readonly predecessorVersionId: string;
  readonly successorVersionId: string;
  readonly predecessorCommit: string;
  readonly predecessorBundleDigestHex: string;
  readonly predecessorScriptEtag: string;
  readonly successorScriptEtag: string;
  readonly addedSecret: string;
  readonly provenance: "exact-secret-created-direct-successor";
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
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(target.workerName),
    phase,
  );
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
  const identity = canonicalWorkerVersionIdentityOrLegacy(phase, version);
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
    phase,
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
    readonly secretInventory?: readonly unknown[];
  },
): Promise<LiveWorkerVersion> {
  const inspected = await inspectLiveWorkerVersionCore(phase, target, state, input, "strict");
  if (inspected.commit === null) {
    throw phaseError(phase, "Worker version has no exact commit and artifact annotation");
  }
  return inspected;
}

/**
 * Stable exact canonical predecessor used immediately before a named secret
 * mutation. Unlike routine status, this includes the provider script identity
 * and rejects ambiguous deployment histories.
 */
export async function inspectCanonicalWorkerVersionWithScriptIdentity(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly signingKeyId?: string;
    readonly expectedSecrets?: readonly string[];
    readonly selectedCommit?: string;
    readonly secretInventory?: readonly unknown[];
  },
): Promise<CanonicalWorkerVersionWithScriptIdentity> {
  const chain = strictTransitionChain(phase, await state.workerDeployments(target.workerName));
  const current = chain[0];
  if (current === undefined) {
    throw phaseError(phase, "Worker has no authoritative current deployment");
  }
  const history = historyFromChain(phase, chain);
  const version = await state.workerVersion(target.workerName, current.versionId);
  assertExactVersionBindingClosure(
    phase,
    current.versionId,
    version,
    expectedExactBindingClosure(target, {
      ...(input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId }),
      ...(input.expectedSecrets === undefined ? {} : { expectedSecrets: input.expectedSecrets }),
    }),
  );
  const identity = canonicalWorkerVersionIdentity(phase, current.versionId, version);
  if (input.selectedCommit !== undefined && identity.commit !== input.selectedCommit) {
    throw phaseError(phase, "canonical Worker predecessor does not match the selected commit");
  }
  const scriptEtag = workerVersionScriptContentIdentity(phase, current.versionId, version);
  assertExactSecretInventory(
    input.secretInventory ?? (await state.workerSecrets(target.workerName)),
    input.expectedSecrets ?? expectedWorkerSecrets(target),
    phase,
  );
  assertDomainClosure(phase, target, await state.workerDomains());
  const after = strictTransitionChain(phase, await state.workerDeployments(target.workerName));
  if (!sameDeploymentChain(chain, after)) {
    throw phaseError(
      phase,
      "authoritative Worker deployment history changed during canonical closure inspection",
    );
  }
  return { history, ...identity, scriptEtag };
}

/**
 * Proves the exact direct successor Cloudflare creates for a secret update.
 *
 * The current deployment must be the 100% successor H and its deployment
 * history must name C as the direct predecessor. C carries the canonical
 * commit/digest annotation; H must carry only Cloudflare's
 * `workers/triggered_by=secret` marker. The marker is a shape check, not
 * provenance: C's annotation, both exact binding closures, equal script etags,
 * exhaustive secret inventory and domains, and a stable history are required.
 */
export async function inspectSecretCreatedDirectSuccessor(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly addedSecret: string;
    readonly signingKeyId?: string;
    readonly selectedCommit?: string;
    readonly expectedPredecessorVersionId?: string;
    readonly expectedSuccessorVersionId?: string;
    readonly secretInventory?: readonly unknown[];
  },
): Promise<SecretCreatedDirectSuccessor> {
  return await inspectSecretCreatedTransition(phase, target, state, {
    ...input,
    profile: "current-successor",
  });
}

/**
 * Rechecks an already-proven C→H pair while an exact later Version is current.
 * This is used by the one planned integration signing upload to prove
 * C→H→S without pretending H had the canonical workers/message plus
 * workers/triggered_by=version_upload annotation inventory.
 */
export async function inspectSecretCreatedLineage(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: {
    readonly predecessorVersionId?: string;
    readonly successorVersionId: string;
    readonly expectedCurrentVersionId: string;
    readonly addedSecret: string;
    readonly signingKeyId?: string;
    readonly selectedCommit?: string;
    readonly secretInventory?: readonly unknown[];
  },
): Promise<SecretCreatedDirectSuccessor> {
  return await inspectSecretCreatedTransition(phase, target, state, {
    ...input,
    profile: "current-descendant",
  });
}

type SecretCreatedTransitionInput = {
  readonly addedSecret: string;
  readonly signingKeyId?: string;
  readonly selectedCommit?: string;
  readonly secretInventory?: readonly unknown[];
} & (
  | {
      readonly profile: "current-successor";
      readonly expectedPredecessorVersionId?: string;
      readonly expectedSuccessorVersionId?: string;
    }
  | {
      readonly profile: "current-descendant";
      readonly predecessorVersionId?: string;
      readonly successorVersionId: string;
      readonly expectedCurrentVersionId: string;
    }
);

async function inspectSecretCreatedTransition(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  input: SecretCreatedTransitionInput,
): Promise<SecretCreatedDirectSuccessor> {
  const chain = strictTransitionChain(phase, await state.workerDeployments(target.workerName));
  const history = historyFromChain(phase, chain);
  let predecessorVersionId: string;
  let successorVersionId: string;
  if (input.profile === "current-successor") {
    successorVersionId = history.versionId;
    if (
      input.expectedSuccessorVersionId !== undefined &&
      successorVersionId !== input.expectedSuccessorVersionId
    ) {
      throw phaseError(
        phase,
        "authoritative current Worker Version does not match the expected secret successor",
        `expected=${input.expectedSuccessorVersionId} actual=${successorVersionId}`,
      );
    }
    if (history.previousVersionId === null) {
      throw phaseError(phase, "secret-created Worker successor has no direct predecessor");
    }
    predecessorVersionId = history.previousVersionId;
    if (
      input.expectedPredecessorVersionId !== undefined &&
      predecessorVersionId !== input.expectedPredecessorVersionId
    ) {
      throw phaseError(
        phase,
        "secret-created Worker successor has an unexpected direct predecessor",
        `expected=${input.expectedPredecessorVersionId} actual=${predecessorVersionId}`,
      );
    }
  } else {
    if (
      history.versionId !== input.expectedCurrentVersionId ||
      history.previousVersionId !== input.successorVersionId
    ) {
      throw phaseError(
        phase,
        "authoritative Worker history does not identify the exact C-to-H-to-current lineage",
      );
    }
    successorVersionId = input.successorVersionId;
    predecessorVersionId = input.predecessorVersionId ?? chain[2]?.versionId ?? "";
    if (predecessorVersionId.length === 0) {
      throw phaseError(phase, "secret-created lineage has no direct C predecessor");
    }
    if (
      chain[1]?.versionId !== successorVersionId ||
      chain[2]?.versionId !== predecessorVersionId
    ) {
      throw phaseError(phase, "secret-created lineage is not the exact C-to-H-to-current chain");
    }
  }
  const transitionVersionIds =
    input.profile === "current-successor"
      ? [successorVersionId, predecessorVersionId]
      : [history.versionId, successorVersionId, predecessorVersionId];
  if (new Set(transitionVersionIds).size !== transitionVersionIds.length) {
    throw phaseError(
      phase,
      `${input.profile === "current-successor" ? "C-to-H" : "C-to-H-to-S"} prefix contains duplicate Version IDs`,
    );
  }

  const desiredSecrets = expectedWorkerSecrets(target);
  if (!desiredSecrets.includes(input.addedSecret)) {
    throw phaseError(phase, "secret-created transition names a secret outside the target closure");
  }
  const predecessorSecrets = desiredSecrets.filter((name) => name !== input.addedSecret);
  const predecessorVersion = await state.workerVersion(target.workerName, predecessorVersionId);
  const successorVersion = await state.workerVersion(target.workerName, successorVersionId);
  const bindingInput = input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId };
  assertExactVersionBindingClosure(
    phase,
    predecessorVersionId,
    predecessorVersion,
    expectedExactBindingClosure(target, { ...bindingInput, expectedSecrets: predecessorSecrets }),
  );
  assertExactVersionBindingClosure(
    phase,
    successorVersionId,
    successorVersion,
    expectedExactBindingClosure(target, { ...bindingInput, expectedSecrets: desiredSecrets }),
  );
  const predecessorIdentity = canonicalWorkerVersionIdentity(
    phase,
    predecessorVersionId,
    predecessorVersion,
  );
  if (input.selectedCommit !== undefined && predecessorIdentity.commit !== input.selectedCommit) {
    throw phaseError(phase, "secret-created predecessor does not match the selected commit");
  }
  assertSecretCreatedAnnotation(phase, successorVersionId, successorVersion);
  const predecessorScriptEtag = workerVersionScriptContentIdentity(
    phase,
    predecessorVersionId,
    predecessorVersion,
  );
  const successorScriptEtag = workerVersionScriptContentIdentity(
    phase,
    successorVersionId,
    successorVersion,
  );
  if (predecessorScriptEtag !== successorScriptEtag) {
    throw phaseError(phase, "secret-created transition changed the script content identity");
  }
  assertExactSecretInventory(
    input.secretInventory ?? (await state.workerSecrets(target.workerName)),
    desiredSecrets,
    phase,
  );
  assertDomainClosure(phase, target, await state.workerDomains());
  const after = strictTransitionChain(phase, await state.workerDeployments(target.workerName));
  if (!sameDeploymentChain(chain, after)) {
    throw phaseError(
      phase,
      "authoritative Worker deployment history changed during secret transition inspection",
    );
  }
  return {
    history,
    predecessorVersionId,
    successorVersionId,
    predecessorCommit: predecessorIdentity.commit,
    predecessorBundleDigestHex: predecessorIdentity.bundleDigestHex,
    predecessorScriptEtag,
    successorScriptEtag,
    addedSecret: input.addedSecret,
    provenance: "exact-secret-created-direct-successor",
  };
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
    readonly secretInventory?: readonly unknown[];
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
    readonly secretInventory?: readonly unknown[];
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
    readonly secretInventory?: readonly unknown[];
  },
  mode: "strict" | "pinned-current" | "status-reconciliation",
): Promise<LiveWorkerVersion | LegacyLiveWorkerVersion> {
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(target.workerName),
    phase,
  );
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
    input.secretInventory ?? (await state.workerSecrets(target.workerName)),
    input.expectedSecrets ?? expectedWorkerSecrets(target),
    phase,
  );
  assertDomainClosure(phase, target, await state.workerDomains());
  if (mode === "pinned-current") {
    const historyAfterClosure = parseWorkerDeploymentHistory(
      await state.workerDeployments(target.workerName),
      phase,
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

export type WorkerVersionAnnotationProfile = "canonical" | "secret-created" | "other";

/** Exact annotation inventory classifier for authority-sensitive transitions. */
export function workerVersionAnnotationProfile(value: unknown): WorkerVersionAnnotationProfile {
  if (!isRecord(value) || !isRecord(value.annotations)) return "other";
  if (
    exactKeys(value.annotations, ["workers/triggered_by"]) &&
    value.annotations["workers/triggered_by"] === "secret"
  ) {
    return "secret-created";
  }
  const message = value.annotations["workers/message"];
  if (
    exactKeys(value.annotations, ["workers/message", "workers/triggered_by"]) &&
    typeof message === "string" &&
    WORKER_MESSAGE.test(message) &&
    value.annotations["workers/triggered_by"] === "version_upload"
  ) {
    return "canonical";
  }
  return "other";
}

function canonicalWorkerVersionIdentity(
  phase: DeployPhase,
  versionId: string,
  value: unknown,
): { readonly commit: string; readonly bundleDigestHex: string } {
  if (!isRecord(value) || workerVersionAnnotationProfile(value) !== "canonical") {
    throw phaseError(phase, `version ${versionId} has a non-canonical annotation inventory`);
  }
  return workerVersionIdentity(phase, value);
}

function assertSecretCreatedAnnotation(
  phase: DeployPhase,
  versionId: string,
  value: unknown,
): void {
  if (!isRecord(value) || workerVersionAnnotationProfile(value) !== "secret-created") {
    throw phaseError(
      phase,
      `version ${versionId} does not carry the exact secret-created annotation inventory`,
    );
  }
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

function canonicalWorkerVersionIdentityOrLegacy(
  phase: DeployPhase,
  value: unknown,
):
  | { readonly kind: "canonical"; readonly commit: string; readonly bundleDigestHex: string }
  | { readonly kind: typeof LEGACY_UNATTRIBUTED_PREDECESSOR } {
  // Current retirement states use the exact authority profile. The historical
  // message-only compatibility remains confined to the separately pinned
  // bootstrap inspectors that call workerVersionIdentityOrLegacy directly.
  if (workerVersionAnnotationProfile(value) !== "canonical") {
    return { kind: LEGACY_UNATTRIBUTED_PREDECESSOR };
  }
  return { kind: "canonical", ...workerVersionIdentity(phase, value) };
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

function strictTransitionChain(
  phase: DeployPhase,
  value: readonly unknown[],
): readonly WorkerDeploymentChainEntry[] {
  return parseWorkerDeploymentChain(value, phase, {
    requireUuidVersionIds: true,
  });
}

function historyFromChain(
  phase: DeployPhase,
  chain: readonly WorkerDeploymentChainEntry[],
): WorkerDeploymentHistory {
  const current = chain[0];
  if (current === undefined) {
    throw phaseError(phase, "Worker has no authoritative current deployment");
  }
  return {
    deploymentId: current.deploymentId,
    versionId: current.versionId,
    previousVersionId: chain[1]?.versionId ?? null,
  };
}

function sameDeploymentChain(
  left: readonly WorkerDeploymentChainEntry[],
  right: readonly WorkerDeploymentChainEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.deploymentId === right[index]?.deploymentId &&
        entry.versionId === right[index]?.versionId &&
        entry.createdOn === right[index]?.createdOn,
    )
  );
}

function isHostname(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
    value,
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
