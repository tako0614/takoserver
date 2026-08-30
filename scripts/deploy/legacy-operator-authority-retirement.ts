import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

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
  readonly publicJwkPath?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

type Direction = "retirement" | "restore";
type Relationship = "predecessor-current" | "direct-successor-current";

interface ReplacementAuthorities {
  readonly publicJwkBytes: string;
  readonly publicJwkDigest: `sha256:${string}`;
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
    );
    assertSameInspection(
      "verification",
      before,
      final,
      "Worker changed during legacy operator authority status",
    );
    return statusResult(invocation, direction, before, replacement, probe);
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
  const restoreInput =
    direction === "restore"
      ? readExactRestorePublicJwk(
          options.publicJwkPath ?? requireEnvironment("TAKOSERVER_LEGACY_OPERATOR_PUBLIC_JWK_PATH"),
          replacement,
        )
      : undefined;

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
      ...(restoreInput === undefined ? {} : { input: restoreInput.bytes }),
    });
    if (mutation.exitCode !== 0) {
      const diagnostic = `${mutation.stdout}${mutation.stderr}`.trim();
      throw mutationError(
        `legacy operator authority ${direction} acknowledgement is indeterminate; do not retry before --status`,
        direction === "restore"
          ? diagnostic.length === 0
            ? undefined
            : "[redacted]"
          : redactDiagnostics(diagnostic, [environment.CLOUDFLARE_API_TOKEN]),
      );
    }

    const after = await inspectTransition(
      "verification",
      direction,
      selector,
      source.commit,
      target,
      state,
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
    );
    assertSameInspection(
      "verification",
      after,
      final,
      "Worker changed during legacy operator authority verification",
    );
    return applyResult(invocation, direction, source, reviewer, before, after, replacement, probe);
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
  return { publicJwkBytes, publicJwkDigest: sha256(publicJwkBytes) };
}

async function inspectTransition(
  phase: DeployPhase,
  direction: Direction,
  selector: string,
  selectedCommit: string,
  target: DeployTarget,
  state: LegacyOperatorAuthorityState,
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
    if (profile !== "secret-created") {
      throw phaseFailure(
        phase,
        `version ${entry.versionId} is neither a canonical anchor nor an exact secret-created successor`,
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
    ...(authorityProfile === undefined ? {} : { authorityProfile }),
    chainFingerprint: JSON.stringify(chain),
  };
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

function readExactRestorePublicJwk(
  path: string,
  expected: ReplacementAuthorities,
): { readonly bytes: string; readonly digest: `sha256:${string}` } {
  let descriptor: number | null = null;
  let raw: string;
  try {
    const normalized = linkFreePath(path);
    descriptor = openSync(normalized, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      typeof process.getuid !== "function" ||
      status.uid !== process.getuid() ||
      (status.mode & 0o7777) !== 0o600 ||
      status.size < 1 ||
      status.size > MAX_PUBLIC_JWK_BYTES
    ) {
      throw new Error("unsafe");
    }
    raw = readFileSync(descriptor, "utf8");
  } catch {
    throw preflightError(
      "legacy operator public JWK must be an owned 0600 link-free regular file of at most 16 KiB",
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw preflightError(
      "legacy operator public JWK does not match the expected operator identity",
    );
  }
  if (
    !isRecord(value) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !BASE64URL_32.test(value.x) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["crv", "kty", "x"]) ||
    raw !== expected.publicJwkBytes ||
    sha256(raw) !== expected.publicJwkDigest
  ) {
    throw preflightError(
      "legacy operator public JWK does not match the expected operator identity",
    );
  }
  return { bytes: raw, digest: expected.publicJwkDigest };
}

function linkFreePath(path: string): string {
  const normalized = resolve(path);
  const parts = normalized.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    const status = lstatSync(current);
    if (status.isSymbolicLink()) throw new Error("linked path");
  }
  return normalized;
}

function statusResult(
  invocation: LegacyOperatorAuthorityInvocation,
  direction: Direction,
  live: TransitionInspection,
  replacement: ReplacementAuthorities,
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
      : { restoreApplyReady: !advanced, expectedPublicJwkDigest: replacement.publicJwkDigest }),
    selectedPredecessorVersionId: live.selectorVersionId,
    ...(advanced ? { previousVersionId: live.selectorVersionId } : {}),
    versionId: live.currentVersionId,
    deployedCommit: live.commit,
    bundleDigest: `sha256:${live.bundleDigestHex}`,
    scriptEtag: live.scriptEtag,
    legacySecretPresent: live.legacySecretPresent,
    replacementIdentity: {
      binding: "OPERATOR_IDENTITY_PUBLIC_JWK",
      publicJwkDigest: replacement.publicJwkDigest,
    },
    replacementSettlement: {
      provider: "stripe-checkout",
      secretBinding: "STRIPE_SECRET_KEY",
    },
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
    ...(direction === "retirement"
      ? {
          secretRemoved: LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
          exactRestore: {
            surface: "takoserver-integration-legacy-operator-authority-restore",
            predecessorVersionId: after.currentVersionId,
            publicJwkDigest: replacement.publicJwkDigest,
          },
        }
      : {
          secretRestored: LEGACY_OPERATOR_PUBLIC_JWK_SECRET,
          publicJwkDigest: replacement.publicJwkDigest,
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
    probe,
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

function redactDiagnostics(value: string, secrets: readonly (string | undefined)[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

function sha256(value: string): `sha256:${string}` {
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
