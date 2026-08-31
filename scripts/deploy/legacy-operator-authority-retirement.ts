import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseStrictJson } from "../../src/strict-json.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import {
  type DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import {
  expectedWorkerSecrets,
  type WorkerVersionAuthorityProfile,
  writeWorkerConfig,
} from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { probeProduct } from "./worker.ts";
import {
  assertDomainClosure,
  isWorkerVersionId,
  type WorkerState,
  workerVersionAnnotationProfile,
  workerVersionAuthorityBindingShape,
  workerVersionIdentity,
  workerVersionScriptContentIdentity,
} from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  parseWorkerDeploymentChain,
  type WorkerDeploymentChainEntry,
} from "./worker-state.ts";

export const LEGACY_OPERATOR_PUBLIC_JWK_SECRET = "OPERATOR_PUBLIC_JWK" as const;

const MAX_PUBLIC_JWK_BYTES = 16_384;
const MAX_CAPTURE_BYTES = 32_768;
const MAX_RETIREMENT_CHECKPOINT_BYTES = 16_384;
const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CAPTURE_KIND = "takoserver.legacy-operator-authority-capture@v1" as const;
const RETIREMENT_CHECKPOINT_KIND =
  "takoserver.legacy-operator-authority-retirement-checkpoint@v1" as const;
const RETIREMENT_CHECKPOINT_SUFFIX = ".retirement-checkpoint.json" as const;

export type LegacyOperatorAuthoritySurface =
  | "takoserver-integration-legacy-operator-authority-retirement"
  | "takoserver-integration-legacy-operator-authority-restore";

export interface LegacyOperatorAuthorityInvocation {
  readonly surface: LegacyOperatorAuthoritySurface;
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly legacyOperatorAuthorityPredecessorVersionId?: string;
}

export type LegacyOperatorAuthorityProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface LegacyOperatorAuthorityState extends WorkerState {}

export interface LegacyOperatorAuthorityOptions {
  readonly run?: LegacyOperatorAuthorityProcess;
  readonly state?: LegacyOperatorAuthorityState;
  readonly review?: string;
  readonly outputDirectory?: string;
  readonly capturePath?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

type Direction = "retirement" | "restore";
type Relationship = "predecessor-current" | "direct-successor-current";
type SuccessorAttribution = "provider-secret-marker" | "annotation-free-exact-secret-transition";

interface ReplacementAuthorities {
  readonly publicJwkDigest: `sha256:${string}`;
}

interface LegacyOperatorAuthorityCapture {
  readonly legacyPredecessorVersionId: string;
  readonly publicJwkBytes: string;
  readonly publicJwkDigest: `sha256:${string}`;
  readonly canonicalPath: string;
  readonly captureDigest: `sha256:${string}`;
  readonly captureBytes: number;
  readonly capturePathDigest: `sha256:${string}`;
}

interface LegacyOperatorAuthorityRetirementCheckpoint {
  readonly kind: typeof RETIREMENT_CHECKPOINT_KIND;
  readonly environment: "integration";
  readonly accountId: string;
  readonly workerName: string;
  readonly legacyPredecessorVersionId: string;
  readonly sourceCommit: string;
  readonly bundleDigest: `sha256:${string}`;
  readonly scriptEtag: string;
  readonly captureDigest: `sha256:${string}`;
  readonly captureBytes: number;
  readonly capturePathDigest: `sha256:${string}`;
  readonly publicJwkDigest: `sha256:${string}`;
}

interface LoadedRetirementCheckpoint {
  readonly value: LegacyOperatorAuthorityRetirementCheckpoint;
  readonly digest: `sha256:${string}`;
  readonly canonicalPath: string;
}

interface TransitionInspection {
  readonly relationship: Relationship;
  readonly currentDeploymentId: string;
  readonly currentVersionId: string;
  readonly currentPreviousVersionId: string | null;
  readonly selectorVersionId: string;
  readonly anchorVersionId: string;
  readonly commit: string;
  readonly bundleDigestHex: string;
  readonly scriptEtag: string;
  readonly legacySecretPresent: boolean;
  readonly successorAttribution: SuccessorAttribution | null;
  readonly authorityProfile?: WorkerVersionAuthorityProfile;
  readonly chainFingerprint: string;
}

/**
 * Retires or exactly restores the one legacy public-JWK secret. Each apply
 * performs at most one provider mutation. A failed acknowledgement is never
 * retried by this process and can be reconciled only by the same surface's
 * read-only status path.
 */
export async function runLegacyOperatorAuthorityTransition(
  invocation: LegacyOperatorAuthorityInvocation,
  target: DeployTarget,
  options: LegacyOperatorAuthorityOptions = {},
): Promise<Record<string, unknown>> {
  const direction = validateInvocation(invocation, target);
  const replacement = requireReplacementAuthorities(target);
  const capture = readLegacyOperatorAuthorityCapture(
    options.capturePath ?? requireEnvironment("TAKOSERVER_LEGACY_OPERATOR_AUTHORITY_CAPTURE_PATH"),
    target,
  );
  const retirementCheckpointPath = checkpointPathForCapture(capture.canonicalPath);
  const initialCheckpoint = readRetirementCheckpoint(retirementCheckpointPath, target);
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({ accountId: target.accountId, token: exactToken(environment) });
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const selector = invocation.legacyOperatorAuthorityPredecessorVersionId as string;
  const before = await inspectTransition(
    "preflight",
    direction,
    selector,
    invocation.commit,
    target,
    state,
    capture.legacyPredecessorVersionId,
  );
  assertRetirementCheckpointForTransition(
    "preflight",
    direction,
    before,
    capture,
    initialCheckpoint,
  );

  if (invocation.action === "status") {
    const probe = await probeProduct(target.publicOrigin, fetcher);
    const final = await inspectTransition(
      "verification",
      direction,
      selector,
      invocation.commit,
      target,
      state,
      capture.legacyPredecessorVersionId,
    );
    assertSameInspection(
      "verification",
      before,
      final,
      "Worker changed during legacy operator authority status",
    );
    const finalCapture = readLegacyOperatorAuthorityCapture(
      capture.canonicalPath,
      target,
      "verification",
    );
    assertSameCapture(
      "verification",
      capture,
      finalCapture,
      "operator capture changed during legacy operator authority status",
    );
    const finalCheckpoint = readRetirementCheckpoint(
      retirementCheckpointPath,
      target,
      "verification",
    );
    assertRetirementCheckpointForTransition(
      "verification",
      direction,
      final,
      finalCapture,
      finalCheckpoint,
    );
    assertSameCheckpointSelection(
      "verification",
      initialCheckpoint,
      finalCheckpoint,
      "retirement checkpoint changed during legacy operator authority status",
    );
    return statusResult(
      invocation,
      direction,
      before,
      replacement,
      finalCapture,
      finalCheckpoint,
      probe,
    );
  }

  if (before.relationship !== "predecessor-current") {
    throw preflightError(
      direction === "retirement"
        ? "legacy operator authority is already retired; run --status instead of retrying"
        : "legacy operator authority is already restored; run --status instead of retrying",
    );
  }

  const run = options.run ?? runCommand;
  const source = await qualifySource({
    environment: "integration",
    commit: invocation.commit,
    run,
  });
  if (source.commit !== before.commit) {
    throw preflightError(
      "legacy operator authority transition commit must equal the trusted served Worker commit",
    );
  }
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-legacy-operator-authority-"));
  const temporary = options.outputDirectory === undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const expectedPredecessorSecrets = transitionSecrets(target, direction === "retirement");
    const configPath = writeWorkerConfig(target, {
      path: join(root, "wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: source.commit,
      signingKeyId: target.signing.currentKeyId,
      transitionExpectedSecrets: expectedPredecessorSecrets,
      workerArtifactDigest: `sha256:${before.bundleDigestHex}`,
      ...(before.authorityProfile === undefined
        ? {}
        : { authorityProfile: before.authorityProfile }),
    });

    // Establish public health before touching the one authority secret, then
    // close every qualification/config/probe race with one final exact read.
    await probeProduct(target.publicOrigin, fetcher);
    const fresh = await inspectTransition(
      "preflight",
      direction,
      selector,
      source.commit,
      target,
      state,
      capture.legacyPredecessorVersionId,
    );
    assertSameInspection(
      "preflight",
      before,
      fresh,
      "Worker changed before the legacy operator authority mutation",
    );
    if (fresh.relationship !== "predecessor-current") {
      throw preflightError("selected predecessor changed before the authority mutation");
    }

    const freshCapture = readLegacyOperatorAuthorityCapture(capture.canonicalPath, target);
    assertSameCapture(
      "preflight",
      capture,
      freshCapture,
      "operator capture changed before the legacy authority mutation",
    );
    const freshCheckpoint = readRetirementCheckpoint(retirementCheckpointPath, target);
    if (initialCheckpoint !== null && freshCheckpoint === null) {
      throw preflightError("legacy operator authority retirement checkpoint disappeared");
    }
    const mutationCheckpoint =
      direction === "retirement"
        ? ensureRetirementCheckpoint(
            retirementCheckpointPath,
            target,
            expectedRetirementCheckpoint(target, freshCapture, fresh),
          )
        : requireRetirementCheckpoint("preflight", fresh, freshCapture, freshCheckpoint);
    assertRetirementCheckpointForTransition(
      "preflight",
      direction,
      fresh,
      freshCapture,
      mutationCheckpoint,
    );
    if (initialCheckpoint !== null) {
      assertSameCheckpointSelection(
        "preflight",
        initialCheckpoint,
        mutationCheckpoint,
        "retirement checkpoint changed before the legacy authority mutation",
      );
    }

    // Re-open both retained files after checkpoint creation/adoption. The
    // mutation consumes only bytes that remain bound to that exact evidence.
    const mutationCapture = readLegacyOperatorAuthorityCapture(capture.canonicalPath, target);
    assertSameCapture(
      "preflight",
      freshCapture,
      mutationCapture,
      "operator capture changed before the legacy authority mutation",
    );
    const sealedCheckpoint = requireRetirementCheckpoint(
      "preflight",
      fresh,
      mutationCapture,
      readRetirementCheckpoint(retirementCheckpointPath, target),
    );
    assertSameCheckpointSelection(
      "preflight",
      mutationCheckpoint,
      sealedCheckpoint,
      "retirement checkpoint changed before the legacy authority mutation",
    );

    const command = wranglerCommand([
      "secret",
      direction === "retirement" ? "delete" : "put",
      LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
      "--name",
      target.workerName,
      "--config",
      configPath,
    ]);
    const mutation = await run(command, {
      env: environment,
      ...(direction === "restore" ? { input: mutationCapture.publicJwkBytes } : {}),
    });
    if (mutation.exitCode !== 0) {
      const diagnostic = `${mutation.stdout}${mutation.stderr}`.trim();
      throw mutationError(
        `legacy operator authority ${direction} acknowledgement is indeterminate; do not retry before --status`,
        diagnostic.length === 0 ? undefined : "[redacted]",
      );
    }

    const after = await inspectTransition(
      "verification",
      direction,
      selector,
      source.commit,
      target,
      state,
      mutationCapture.legacyPredecessorVersionId,
    );
    assertExactDirectSuccessor(direction, before, after);
    const probe = await probeProduct(target.publicOrigin, fetcher);
    const final = await inspectTransition(
      "verification",
      direction,
      selector,
      source.commit,
      target,
      state,
      mutationCapture.legacyPredecessorVersionId,
    );
    assertSameInspection(
      "verification",
      after,
      final,
      "Worker changed during legacy operator authority verification",
    );
    const finalCapture = readLegacyOperatorAuthorityCapture(
      capture.canonicalPath,
      target,
      "verification",
    );
    assertSameCapture(
      "verification",
      mutationCapture,
      finalCapture,
      "operator capture changed during legacy operator authority verification",
    );
    const finalCheckpoint = requireRetirementCheckpoint(
      "verification",
      final,
      finalCapture,
      readRetirementCheckpoint(retirementCheckpointPath, target, "verification"),
    );
    assertSameCheckpointSelection(
      "verification",
      sealedCheckpoint,
      finalCheckpoint,
      "retirement checkpoint changed during legacy operator authority verification",
    );
    return applyResult(
      invocation,
      direction,
      source,
      reviewer,
      before,
      after,
      replacement,
      finalCapture,
      finalCheckpoint,
      probe,
    );
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

function validateInvocation(
  invocation: LegacyOperatorAuthorityInvocation,
  target: DeployTarget,
): Direction {
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("legacy operator authority transition is integration-only");
  }
  if (target.environment !== invocation.environment) {
    throw preflightError("legacy operator authority invocation and target environments differ");
  }
  if (!/^[0-9a-f]{40}$/u.test(invocation.commit)) {
    throw preflightError("--commit must be one exact lowercase 40-hex commit");
  }
  const selector = invocation.legacyOperatorAuthorityPredecessorVersionId;
  if (selector === undefined || !isWorkerVersionId(selector)) {
    throw preflightError(
      "legacy operator authority transition requires --legacy-operator-authority-predecessor-version=<uuid>",
    );
  }
  return invocation.surface === "takoserver-integration-legacy-operator-authority-retirement"
    ? "retirement"
    : "restore";
}

function requireReplacementAuthorities(target: DeployTarget): ReplacementAuthorities {
  const publicJwk = target.operatorIdentity?.publicJwk;
  if (
    publicJwk === undefined ||
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    !BASE64URL_32.test(publicJwk.x) ||
    JSON.stringify(Object.keys(publicJwk).sort()) !== JSON.stringify(["crv", "kty", "x"])
  ) {
    throw preflightError(
      "legacy authority retirement requires the replacement operator identity in the v2 target",
    );
  }
  if (target.stripeCheckout !== true || target.consoleOrigin === undefined) {
    throw preflightError(
      "legacy authority retirement requires replacement settlement/checkout authority",
    );
  }
  let consoleUrl: URL;
  try {
    consoleUrl = new URL(target.consoleOrigin);
  } catch {
    throw preflightError(
      "legacy authority retirement requires replacement settlement/checkout authority",
    );
  }
  if (consoleUrl.protocol !== "https:" || consoleUrl.origin !== target.consoleOrigin) {
    throw preflightError(
      "legacy authority retirement requires replacement settlement/checkout authority",
    );
  }
  const desiredSecrets = expectedWorkerSecrets(target);
  if (
    !desiredSecrets.includes("STRIPE_SECRET_KEY") ||
    desiredSecrets.includes(LEGACY_OPERATOR_PUBLIC_JWK_SECRET)
  ) {
    throw preflightError(
      "legacy authority retirement requires replacement settlement/checkout authority and a legacy-free v2 closure",
    );
  }
  const publicJwkBytes = JSON.stringify(publicJwk);
  return { publicJwkDigest: sha256(publicJwkBytes) };
}

async function inspectTransition(
  phase: DeployPhase,
  direction: Direction,
  selector: string,
  selectedCommit: string,
  target: DeployTarget,
  state: LegacyOperatorAuthorityState,
  capturedLegacyPredecessorVersionId: string,
): Promise<TransitionInspection> {
  const chain = parseWorkerDeploymentChain(
    await state.workerDeployments(target.workerName),
    phase,
    { requireUuidVersionIds: true },
  );
  const current = chain[0];
  if (current === undefined) throw phaseFailure(phase, "Worker has no authoritative deployment");
  const relationship: Relationship =
    current.versionId === selector
      ? "predecessor-current"
      : chain[1]?.versionId === selector
        ? "direct-successor-current"
        : (() => {
            throw phaseFailure(
              phase,
              "authoritative Worker is not the selected predecessor or its exact direct successor",
            );
          })();
  const captureIndex =
    direction === "retirement"
      ? relationship === "predecessor-current"
        ? 0
        : 1
      : relationship === "predecessor-current"
        ? 1
        : 2;
  if (chain[captureIndex]?.versionId !== capturedLegacyPredecessorVersionId) {
    throw phaseFailure(
      phase,
      "operator capture is not bound to the exact legacy predecessor in this selected transition",
    );
  }
  const inspected: {
    readonly entry: WorkerDeploymentChainEntry;
    readonly version: unknown;
    readonly legacyPresent: boolean;
    readonly scriptEtag: string;
  }[] = [];
  let anchorIndex = -1;
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index] as WorkerDeploymentChainEntry;
    const version = await state.workerVersion(target.workerName, entry.versionId);
    inspected.push({
      entry,
      version,
      legacyPresent: versionHasLegacySecret(phase, entry.versionId, version),
      scriptEtag: workerVersionScriptContentIdentity(phase, entry.versionId, version),
    });
    const profile = workerVersionAnnotationProfile(version);
    if (profile === "canonical") {
      anchorIndex = index;
      break;
    }
    if (profile !== "secret-created" && !isAnnotationFreeVersion(version)) {
      throw phaseFailure(
        phase,
        `version ${entry.versionId} is neither a canonical anchor nor an exact provider secret successor`,
      );
    }
  }
  if (anchorIndex < 0) {
    throw phaseFailure(phase, "legacy operator authority lineage has no canonical Worker anchor");
  }
  const transitionEntries = inspected.slice(0, anchorIndex + 1);
  const transitionVersionIds = transitionEntries.map(({ entry }) => entry.versionId);
  if (new Set(transitionVersionIds).size !== transitionVersionIds.length) {
    throw phaseFailure(phase, "legacy operator authority lineage reuses a transition Version ID");
  }
  for (let index = 0; index < anchorIndex; index += 1) {
    const newer = transitionEntries[index];
    const older = transitionEntries[index + 1];
    if (newer === undefined || older === undefined || newer.legacyPresent === older.legacyPresent) {
      throw phaseFailure(
        phase,
        "secret-created legacy operator authority lineage changed more than the named secret",
      );
    }
  }

  const anchor = transitionEntries[anchorIndex];
  if (anchor === undefined) {
    throw phaseFailure(phase, "legacy operator authority lineage has no canonical Worker anchor");
  }
  const identity = workerVersionIdentity(phase, anchor.version);
  if (identity.commit !== selectedCommit) {
    throw phaseFailure(
      phase,
      "legacy operator authority canonical anchor does not match the selected commit",
    );
  }
  const authorityProfile = exactAuthorityProfile(phase, target, anchor, identity);
  for (const entry of transitionEntries) {
    if (entry.scriptEtag !== anchor.scriptEtag) {
      throw phaseFailure(
        phase,
        "legacy operator authority transition changed the script code identity",
      );
    }
    try {
      assertExactVersionBindingClosure(
        phase,
        entry.entry.versionId,
        entry.version,
        expectedExactBindingClosure(target, {
          signingKeyId: target.signing.currentKeyId,
          expectedSecrets: transitionSecrets(target, entry.legacyPresent),
          workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
          ...(authorityProfile === undefined ? {} : { authorityProfile }),
        }),
      );
    } catch {
      // Binding helpers intentionally retain useful raw-value diagnostics for
      // ordinary configuration work. This authority surface cannot reflect a
      // JWK-shaped value, including a foreign one, so collapse the detail to
      // the closed-shape fact before it reaches CLI output.
      throw phaseFailure(
        phase,
        `version ${entry.entry.versionId} binding inventory is not the exact selected target closure`,
      );
    }
  }

  const currentInspection = transitionEntries[0];
  const selectorInspection =
    relationship === "predecessor-current" ? transitionEntries[0] : transitionEntries[1];
  if (currentInspection === undefined || selectorInspection === undefined) {
    throw phaseFailure(phase, "legacy operator authority transition history is incomplete");
  }
  const predecessorLegacyPresent = direction === "retirement";
  const successorLegacyPresent = !predecessorLegacyPresent;
  if (
    selectorInspection.legacyPresent !== predecessorLegacyPresent ||
    currentInspection.legacyPresent !==
      (relationship === "predecessor-current" ? predecessorLegacyPresent : successorLegacyPresent)
  ) {
    throw phaseFailure(
      phase,
      direction === "retirement"
        ? "selected retirement predecessor is not the exact legacy-only v2 closure"
        : "selected restore predecessor is not the exact retired v2 closure",
    );
  }

  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    transitionSecrets(target, currentInspection.legacyPresent),
    phase,
  );
  assertDomainClosure(phase, target, await state.workerDomains());
  const afterChain = parseWorkerDeploymentChain(
    await state.workerDeployments(target.workerName),
    phase,
    { requireUuidVersionIds: true },
  );
  if (!sameChain(chain, afterChain)) {
    throw phaseFailure(
      phase,
      "authoritative Worker deployment history changed during legacy authority inspection",
    );
  }
  return {
    relationship,
    currentDeploymentId: current.deploymentId,
    currentVersionId: current.versionId,
    currentPreviousVersionId: chain[1]?.versionId ?? null,
    selectorVersionId: selector,
    anchorVersionId: anchor.entry.versionId,
    commit: identity.commit,
    bundleDigestHex: identity.bundleDigestHex,
    scriptEtag: currentInspection.scriptEtag,
    legacySecretPresent: currentInspection.legacyPresent,
    successorAttribution: successorAttribution(currentInspection.version),
    ...(authorityProfile === undefined ? {} : { authorityProfile }),
    chainFingerprint: JSON.stringify(chain),
  };
}

function isAnnotationFreeVersion(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    !("annotations" in value) ||
    (isRecord(value.annotations) && Object.keys(value.annotations).length === 0)
  );
}

function successorAttribution(value: unknown): SuccessorAttribution | null {
  if (workerVersionAnnotationProfile(value) === "secret-created") {
    return "provider-secret-marker";
  }
  return isAnnotationFreeVersion(value) ? "annotation-free-exact-secret-transition" : null;
}

function exactAuthorityProfile(
  phase: DeployPhase,
  target: DeployTarget,
  anchor: { readonly entry: WorkerDeploymentChainEntry; readonly version: unknown },
  identity: { readonly commit: string; readonly bundleDigestHex: string },
): WorkerVersionAuthorityProfile | undefined {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  if (
    workerVersionAuthorityBindingShape(phase, anchor.entry.versionId, anchor.version) !==
    "provenance-bound-jit"
  ) {
    throw phaseFailure(
      phase,
      "legacy operator authority transition requires the exact current JIT authority closure",
    );
  }
  return {
    kind: "provenance-bound-jit",
    provenance: {
      sourceCommit: identity.commit,
      artifactDigest: `sha256:${identity.bundleDigestHex}`,
    },
  };
}

function transitionSecrets(target: DeployTarget, legacyPresent: boolean): readonly string[] {
  const desired = expectedWorkerSecrets(target);
  return legacyPresent
    ? [...desired, LEGACY_OPERATOR_PUBLIC_JWK_SECRET].sort()
    : [...desired].sort();
}

function versionHasLegacySecret(phase: DeployPhase, versionId: string, value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.resources) || !Array.isArray(value.resources.bindings)) {
    throw phaseFailure(phase, `version ${versionId} has no canonical binding inventory`);
  }
  const matches = value.resources.bindings.filter((binding) => {
    if (!isRecord(binding)) {
      throw phaseFailure(phase, `version ${versionId} has a malformed binding inventory`);
    }
    return (
      binding.name === LEGACY_OPERATOR_PUBLIC_JWK_SECRET ||
      binding.binding === LEGACY_OPERATOR_PUBLIC_JWK_SECRET
    );
  });
  if (matches.length === 0) return false;
  if (matches.length !== 1 || matches[0]?.type !== "secret_text") {
    throw phaseFailure(
      phase,
      `version ${versionId} has an invalid legacy operator authority secret binding`,
    );
  }
  return true;
}

function readLegacyOperatorAuthorityCapture(
  path: string,
  target: DeployTarget,
  phase: DeployPhase = "preflight",
): LegacyOperatorAuthorityCapture {
  const loaded = readSecureEvidenceFile(
    path,
    "legacy operator authority capture",
    MAX_CAPTURE_BYTES,
    phase,
  );
  if (loaded === null) {
    throw phaseFailure(phase, "legacy operator authority capture is missing");
  }
  const { raw } = loaded;
  let value: unknown;
  try {
    value = parseStrictJson(raw, MAX_CAPTURE_BYTES);
  } catch {
    throw phaseFailure(phase, "legacy operator authority capture is not strict bounded JSON");
  }
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([
        "accountId",
        "environment",
        "kind",
        "legacyPredecessorVersionId",
        "publicJwk",
        "publicJwkDigest",
        "workerName",
      ]) ||
    value.kind !== CAPTURE_KIND ||
    value.environment !== "integration" ||
    value.accountId !== target.accountId ||
    value.workerName !== target.workerName ||
    typeof value.legacyPredecessorVersionId !== "string" ||
    !isWorkerVersionId(value.legacyPredecessorVersionId) ||
    typeof value.publicJwk !== "string" ||
    typeof value.publicJwkDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.publicJwkDigest)
  ) {
    throw phaseFailure(
      phase,
      "legacy operator authority capture does not match the selected target",
    );
  }
  const publicJwkBytes = new TextEncoder().encode(value.publicJwk);
  let publicJwk: unknown;
  try {
    publicJwk = parseStrictJson(publicJwkBytes, MAX_PUBLIC_JWK_BYTES);
  } catch {
    throw phaseFailure(phase, "legacy operator authority capture contains an invalid public JWK");
  }
  if (
    !isRecord(publicJwk) ||
    JSON.stringify(Object.keys(publicJwk).sort()) !== JSON.stringify(["crv", "kty", "x"]) ||
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string" ||
    !BASE64URL_32.test(publicJwk.x) ||
    sha256(publicJwkBytes) !== value.publicJwkDigest
  ) {
    throw phaseFailure(phase, "legacy operator authority capture contains an invalid public JWK");
  }
  return {
    legacyPredecessorVersionId: value.legacyPredecessorVersionId,
    publicJwkBytes: value.publicJwk,
    publicJwkDigest: value.publicJwkDigest as `sha256:${string}`,
    canonicalPath: loaded.canonicalPath,
    captureDigest: loaded.digest,
    captureBytes: raw.byteLength,
    capturePathDigest: loaded.pathDigest,
  };
}

interface SecureEvidenceFile {
  readonly canonicalPath: string;
  readonly raw: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly pathDigest: `sha256:${string}`;
}

function readSecureEvidenceFile(
  path: string,
  label: string,
  maxBytes: number,
  phase: DeployPhase,
  allowMissing = false,
): SecureEvidenceFile | null {
  const normalized = canonicalEvidencePath(path, label, phase);
  let descriptor: number | null = null;
  let raw: Uint8Array;
  try {
    descriptor = openSync(normalized, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      typeof process.getuid !== "function" ||
      status.uid !== process.getuid() ||
      (status.mode & 0o7777) !== 0o600 ||
      status.size < 1 ||
      status.size > maxBytes
    ) {
      throw new Error("unsafe");
    }
    raw = readFileSync(descriptor);
    const pathStatus = lstatSync(normalized);
    if (
      pathStatus.isSymbolicLink() ||
      pathStatus.dev !== status.dev ||
      pathStatus.ino !== status.ino ||
      pathStatus.size !== status.size ||
      pathStatus.mode !== status.mode ||
      raw.byteLength !== status.size
    ) {
      throw new Error("drifted");
    }
  } catch (error) {
    if (allowMissing && isErrno(error, "ENOENT")) return null;
    throw phaseFailure(
      phase,
      `${label} must be an owned 0600 link-free regular file of at most ${Math.floor(maxBytes / 1024)} KiB`,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return {
    canonicalPath: normalized,
    raw,
    digest: sha256(raw),
    pathDigest: sha256(normalized),
  };
}

function canonicalEvidencePath(path: string, label: string, phase: DeployPhase): string {
  if (!isAbsolute(path)) {
    throw phaseFailure(phase, `${label} path must be absolute`);
  }
  const normalized = resolve(path);
  const parent = dirname(normalized);
  const parts = parent.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    let status: ReturnType<typeof lstatSync>;
    try {
      status = lstatSync(current);
    } catch {
      throw phaseFailure(phase, `${label} parent path is unavailable`);
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw phaseFailure(phase, `${label} path must be link-free`);
    }
  }
  const parentStatus = lstatSync(parent);
  if (
    !parentStatus.isDirectory() ||
    parentStatus.isSymbolicLink() ||
    typeof process.getuid !== "function" ||
    parentStatus.uid !== process.getuid() ||
    (parentStatus.mode & 0o7777) !== 0o700
  ) {
    throw phaseFailure(phase, `${label} parent must be an owned exact-0700 directory`);
  }
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    let gitMarkerExists = false;
    try {
      lstatSync(join(cursor, ".git"));
      gitMarkerExists = true;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw phaseFailure(phase, `${label} Git-worktree boundary cannot be proven`);
      }
    }
    if (gitMarkerExists) {
      throw phaseFailure(phase, `${label} must stay outside every Git worktree`);
    }
    const next = dirname(cursor);
    if (next === cursor) break;
  }
  return normalized;
}

function checkpointPathForCapture(canonicalCapturePath: string): string {
  return `${canonicalCapturePath}${RETIREMENT_CHECKPOINT_SUFFIX}`;
}

function readRetirementCheckpoint(
  path: string,
  target: DeployTarget,
  phase: DeployPhase = "preflight",
): LoadedRetirementCheckpoint | null {
  const loaded = readSecureEvidenceFile(
    path,
    "legacy operator authority retirement checkpoint",
    MAX_RETIREMENT_CHECKPOINT_BYTES,
    phase,
    true,
  );
  if (loaded === null) return null;
  let parsed: unknown;
  try {
    parsed = parseStrictJson(loaded.raw, MAX_RETIREMENT_CHECKPOINT_BYTES);
  } catch {
    throw phaseFailure(
      phase,
      "legacy operator authority retirement checkpoint is not strict bounded JSON",
    );
  }
  const value = parseRetirementCheckpoint(parsed, target, phase);
  const canonicalBytes = new TextEncoder().encode(serializeRetirementCheckpoint(value));
  if (!sameBytes(canonicalBytes, loaded.raw)) {
    throw phaseFailure(
      phase,
      "legacy operator authority retirement checkpoint does not contain the exact canonical generated bytes",
    );
  }
  return { value, digest: loaded.digest, canonicalPath: loaded.canonicalPath };
}

function parseRetirementCheckpoint(
  value: unknown,
  target: DeployTarget,
  phase: DeployPhase,
): LegacyOperatorAuthorityRetirementCheckpoint {
  const keys = [
    "accountId",
    "bundleDigest",
    "captureBytes",
    "captureDigest",
    "capturePathDigest",
    "environment",
    "kind",
    "legacyPredecessorVersionId",
    "publicJwkDigest",
    "scriptEtag",
    "sourceCommit",
    "workerName",
  ];
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
    value.kind !== RETIREMENT_CHECKPOINT_KIND ||
    value.environment !== "integration" ||
    value.accountId !== target.accountId ||
    value.workerName !== target.workerName ||
    typeof value.legacyPredecessorVersionId !== "string" ||
    !isWorkerVersionId(value.legacyPredecessorVersionId) ||
    typeof value.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceCommit) ||
    typeof value.bundleDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.bundleDigest) ||
    typeof value.scriptEtag !== "string" ||
    value.scriptEtag.length < 1 ||
    value.scriptEtag.length > 1_024 ||
    typeof value.captureDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.captureDigest) ||
    typeof value.captureBytes !== "number" ||
    !Number.isSafeInteger(value.captureBytes) ||
    value.captureBytes < 1 ||
    value.captureBytes > MAX_CAPTURE_BYTES ||
    typeof value.capturePathDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.capturePathDigest) ||
    typeof value.publicJwkDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.publicJwkDigest)
  ) {
    throw phaseFailure(
      phase,
      "legacy operator authority retirement checkpoint is missing or ambiguous for the selected target",
    );
  }
  return {
    kind: RETIREMENT_CHECKPOINT_KIND,
    environment: "integration",
    accountId: value.accountId as string,
    workerName: value.workerName as string,
    legacyPredecessorVersionId: value.legacyPredecessorVersionId,
    sourceCommit: value.sourceCommit,
    bundleDigest: value.bundleDigest as `sha256:${string}`,
    scriptEtag: value.scriptEtag,
    captureDigest: value.captureDigest as `sha256:${string}`,
    captureBytes: value.captureBytes,
    capturePathDigest: value.capturePathDigest as `sha256:${string}`,
    publicJwkDigest: value.publicJwkDigest as `sha256:${string}`,
  };
}

function expectedRetirementCheckpoint(
  target: DeployTarget,
  capture: LegacyOperatorAuthorityCapture,
  live: TransitionInspection,
): LegacyOperatorAuthorityRetirementCheckpoint {
  return {
    kind: RETIREMENT_CHECKPOINT_KIND,
    environment: "integration",
    accountId: target.accountId,
    workerName: target.workerName,
    legacyPredecessorVersionId: capture.legacyPredecessorVersionId,
    sourceCommit: live.commit,
    bundleDigest: `sha256:${live.bundleDigestHex}`,
    scriptEtag: live.scriptEtag,
    captureDigest: capture.captureDigest,
    captureBytes: capture.captureBytes,
    capturePathDigest: capture.capturePathDigest,
    publicJwkDigest: capture.publicJwkDigest,
  };
}

function ensureRetirementCheckpoint(
  path: string,
  target: DeployTarget,
  expected: LegacyOperatorAuthorityRetirementCheckpoint,
): LoadedRetirementCheckpoint {
  const existing = readRetirementCheckpoint(path, target);
  if (existing !== null) {
    assertCheckpointValue("preflight", existing, expected);
    return existing;
  }
  const normalized = canonicalEvidencePath(
    path,
    "legacy operator authority retirement checkpoint",
    "preflight",
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      normalized,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, serializeRetirementCheckpoint(expected), "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw preflightError(
        "legacy operator authority retirement checkpoint could not be retained before provider mutation",
      );
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  fsyncDirectory(dirname(normalized));
  const retained = readRetirementCheckpoint(normalized, target);
  if (retained === null) {
    throw preflightError(
      "legacy operator authority retirement checkpoint is missing before provider mutation",
    );
  }
  assertCheckpointValue("preflight", retained, expected);
  return retained;
}

function serializeRetirementCheckpoint(value: LegacyOperatorAuthorityRetirementCheckpoint): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertRetirementCheckpointForTransition(
  phase: DeployPhase,
  direction: Direction,
  live: TransitionInspection,
  capture: LegacyOperatorAuthorityCapture,
  checkpoint: LoadedRetirementCheckpoint | null,
): void {
  if (checkpoint === null) {
    if (direction === "retirement" && live.relationship === "predecessor-current") return;
    throw phaseFailure(
      phase,
      "legacy operator authority retirement checkpoint is missing; restore and reconciled retirement require the retained pre-mutation evidence",
    );
  }
  assertCheckpointMatchesTransition(phase, checkpoint, capture, live);
}

function requireRetirementCheckpoint(
  phase: DeployPhase,
  live: TransitionInspection,
  capture: LegacyOperatorAuthorityCapture,
  checkpoint: LoadedRetirementCheckpoint | null,
): LoadedRetirementCheckpoint {
  if (checkpoint === null) {
    throw phaseFailure(
      phase,
      "legacy operator authority retirement checkpoint is missing; restore requires retained pre-mutation evidence",
    );
  }
  assertCheckpointMatchesTransition(phase, checkpoint, capture, live);
  return checkpoint;
}

function assertCheckpointMatchesTransition(
  phase: DeployPhase,
  checkpoint: LoadedRetirementCheckpoint,
  capture: LegacyOperatorAuthorityCapture,
  live: TransitionInspection,
): void {
  const value = checkpoint.value;
  if (
    value.legacyPredecessorVersionId !== capture.legacyPredecessorVersionId ||
    value.sourceCommit !== live.commit ||
    value.bundleDigest !== `sha256:${live.bundleDigestHex}` ||
    value.scriptEtag !== live.scriptEtag ||
    value.captureDigest !== capture.captureDigest ||
    value.captureBytes !== capture.captureBytes ||
    value.capturePathDigest !== capture.capturePathDigest ||
    value.publicJwkDigest !== capture.publicJwkDigest
  ) {
    throw phaseFailure(
      phase,
      "legacy operator authority retirement checkpoint does not match the exact capture, path identity, predecessor, or Worker provenance",
    );
  }
}

function assertCheckpointValue(
  phase: DeployPhase,
  loaded: LoadedRetirementCheckpoint,
  expected: LegacyOperatorAuthorityRetirementCheckpoint,
): void {
  if (serializeRetirementCheckpoint(loaded.value) !== serializeRetirementCheckpoint(expected)) {
    throw phaseFailure(
      phase,
      "legacy operator authority retirement checkpoint is ambiguous and will not be overwritten",
    );
  }
}

function assertSameCapture(
  phase: DeployPhase,
  before: LegacyOperatorAuthorityCapture,
  after: LegacyOperatorAuthorityCapture,
  message: string,
): void {
  if (
    before.legacyPredecessorVersionId !== after.legacyPredecessorVersionId ||
    before.publicJwkBytes !== after.publicJwkBytes ||
    before.publicJwkDigest !== after.publicJwkDigest ||
    before.canonicalPath !== after.canonicalPath ||
    before.captureDigest !== after.captureDigest ||
    before.captureBytes !== after.captureBytes ||
    before.capturePathDigest !== after.capturePathDigest
  ) {
    throw phaseFailure(phase, message);
  }
}

function assertSameCheckpointSelection(
  phase: DeployPhase,
  before: LoadedRetirementCheckpoint | null,
  after: LoadedRetirementCheckpoint | null,
  message: string,
): void {
  if (
    before?.canonicalPath !== after?.canonicalPath ||
    before?.digest !== after?.digest ||
    serializeOptionalCheckpoint(before) !== serializeOptionalCheckpoint(after)
  ) {
    throw phaseFailure(phase, message);
  }
}

function serializeOptionalCheckpoint(value: LoadedRetirementCheckpoint | null): string | null {
  return value === null ? null : serializeRetirementCheckpoint(value.value);
}

function fsyncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    throw preflightError(
      "legacy operator authority retirement checkpoint parent could not be durably synchronized",
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function statusResult(
  invocation: LegacyOperatorAuthorityInvocation,
  direction: Direction,
  live: TransitionInspection,
  replacement: ReplacementAuthorities,
  capture: LegacyOperatorAuthorityCapture,
  checkpoint: LoadedRetirementCheckpoint | null,
  probe: Awaited<ReturnType<typeof probeProduct>>,
): Record<string, unknown> {
  const advanced = live.relationship === "direct-successor-current";
  return {
    kind: `takoserver.legacy-operator-authority-${direction}-status@v1`,
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    state:
      direction === "retirement"
        ? advanced
          ? "legacy-operator-authority-retired"
          : "legacy-operator-authority-present"
        : advanced
          ? "legacy-operator-authority-restored"
          : "legacy-operator-authority-retired",
    ready: advanced,
    ...(direction === "retirement"
      ? { retirementApplyReady: !advanced }
      : { restoreApplyReady: !advanced, expectedPublicJwkDigest: capture.publicJwkDigest }),
    selectedPredecessorVersionId: live.selectorVersionId,
    ...(advanced ? { previousVersionId: live.selectorVersionId } : {}),
    versionId: live.currentVersionId,
    deployedCommit: live.commit,
    bundleDigest: `sha256:${live.bundleDigestHex}`,
    scriptEtag: live.scriptEtag,
    legacySecretPresent: live.legacySecretPresent,
    successorAttribution: live.successorAttribution,
    replacementIdentity: {
      binding: "OPERATOR_IDENTITY_PUBLIC_JWK",
      publicJwkDigest: replacement.publicJwkDigest,
    },
    replacementSettlement: {
      provider: "stripe-checkout",
      secretBinding: "STRIPE_SECRET_KEY",
    },
    legacyCapture: captureSummary(capture),
    retirementCheckpoint: retirementCheckpointSummary(checkpoint),
    probe,
  };
}

function applyResult(
  invocation: LegacyOperatorAuthorityInvocation,
  direction: Direction,
  source: Awaited<ReturnType<typeof qualifySource>>,
  reviewer: string,
  before: TransitionInspection,
  after: TransitionInspection,
  replacement: ReplacementAuthorities,
  capture: LegacyOperatorAuthorityCapture,
  checkpoint: LoadedRetirementCheckpoint,
  probe: Awaited<ReturnType<typeof probeProduct>>,
): Record<string, unknown> {
  return {
    kind: `takoserver.legacy-operator-authority-${direction}-apply@v1`,
    surface: invocation.surface,
    environment: invocation.environment,
    state:
      direction === "retirement"
        ? "legacy-operator-authority-retired"
        : "legacy-operator-authority-restored",
    commit: source.commit,
    dirty: source.dirty,
    remoteRef: source.remoteRef,
    reviewer,
    previousVersionId: before.currentVersionId,
    versionId: after.currentVersionId,
    bundleDigest: `sha256:${after.bundleDigestHex}`,
    scriptEtag: after.scriptEtag,
    successorAttribution: after.successorAttribution,
    ...(direction === "retirement"
      ? {
          secretRemoved: LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
          exactRestore: {
            surface: "takoserver-integration-legacy-operator-authority-restore",
            predecessorVersionId: after.currentVersionId,
            publicJwkDigest: capture.publicJwkDigest,
            retirementCheckpointDigest: checkpoint.digest,
          },
        }
      : {
          secretRestored: LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
          publicJwkDigest: capture.publicJwkDigest,
          exactRetirement: {
            surface: "takoserver-integration-legacy-operator-authority-retirement",
            predecessorVersionId: after.currentVersionId,
          },
        }),
    replacementIdentity: {
      binding: "OPERATOR_IDENTITY_PUBLIC_JWK",
      publicJwkDigest: replacement.publicJwkDigest,
    },
    replacementSettlement: {
      provider: "stripe-checkout",
      secretBinding: "STRIPE_SECRET_KEY",
    },
    legacyCapture: captureSummary(capture),
    retirementCheckpoint: retirementCheckpointSummary(checkpoint),
    probe,
  };
}

function captureSummary(capture: LegacyOperatorAuthorityCapture): Record<string, unknown> {
  return {
    kind: CAPTURE_KIND,
    legacyPredecessorVersionId: capture.legacyPredecessorVersionId,
    publicJwkDigest: capture.publicJwkDigest,
    captureDigest: capture.captureDigest,
    captureBytes: capture.captureBytes,
    capturePathDigest: capture.capturePathDigest,
    canonicalPathIdentityRetained: true,
    providerBinding: LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
    providerBindingType: "secret_text",
    providerValueReadable: false,
    providerValueDigestVerified: false,
    verificationBoundary:
      "Cloudflare proves only the secret name/type; exact bytes and digest are operator-captured",
  };
}

function retirementCheckpointSummary(
  checkpoint: LoadedRetirementCheckpoint | null,
): Record<string, unknown> {
  if (checkpoint === null) {
    return {
      kind: RETIREMENT_CHECKPOINT_KIND,
      retained: false,
      requiredBeforeMutation: true,
      requiredForRestore: true,
    };
  }
  return {
    kind: RETIREMENT_CHECKPOINT_KIND,
    retained: true,
    digest: checkpoint.digest,
    captureDigest: checkpoint.value.captureDigest,
    captureBytes: checkpoint.value.captureBytes,
    capturePathDigest: checkpoint.value.capturePathDigest,
    legacyPredecessorVersionId: checkpoint.value.legacyPredecessorVersionId,
    sourceCommit: checkpoint.value.sourceCommit,
    bundleDigest: checkpoint.value.bundleDigest,
    scriptEtag: checkpoint.value.scriptEtag,
    providerValueReadable: false,
    providerValueDigestVerified: false,
  };
}

function assertExactDirectSuccessor(
  direction: Direction,
  before: TransitionInspection,
  after: TransitionInspection,
): void {
  if (
    after.relationship !== "direct-successor-current" ||
    after.selectorVersionId !== before.currentVersionId ||
    after.currentVersionId === before.currentVersionId ||
    after.currentPreviousVersionId !== before.currentVersionId ||
    after.commit !== before.commit ||
    after.bundleDigestHex !== before.bundleDigestHex ||
    after.scriptEtag !== before.scriptEtag ||
    after.successorAttribution === null ||
    after.legacySecretPresent !== (direction === "restore")
  ) {
    throw verificationError(
      `legacy operator authority ${direction} did not create the exact direct-successor Worker Version`,
    );
  }
}

function assertSameInspection(
  phase: DeployPhase,
  before: TransitionInspection,
  after: TransitionInspection,
  message: string,
): void {
  if (
    before.relationship !== after.relationship ||
    before.currentDeploymentId !== after.currentDeploymentId ||
    before.currentVersionId !== after.currentVersionId ||
    before.currentPreviousVersionId !== after.currentPreviousVersionId ||
    before.selectorVersionId !== after.selectorVersionId ||
    before.anchorVersionId !== after.anchorVersionId ||
    before.commit !== after.commit ||
    before.bundleDigestHex !== after.bundleDigestHex ||
    before.scriptEtag !== after.scriptEtag ||
    before.legacySecretPresent !== after.legacySecretPresent ||
    before.successorAttribution !== after.successorAttribution ||
    before.chainFingerprint !== after.chainFingerprint
  ) {
    throw phaseFailure(phase, message);
  }
}

function sameChain(
  left: readonly WorkerDeploymentChainEntry[],
  right: readonly WorkerDeploymentChainEntry[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function exactToken(environment: Readonly<Record<string, string>>): string {
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!token) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return token;
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function phaseFailure(phase: DeployPhase, message: string, detail?: string): DeployError {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "verification") return verificationError(message, detail);
  return mutationError(message, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
