import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareProviderExecutorInspection } from "./cloudflare-provider-executor.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  type CommandResult,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  type SealedArtifact,
  unsealDirectory,
} from "./qualification.ts";
import {
  expectedWorkerSecrets,
  type WorkerConfigOptions,
  type WorkerVersionAuthorityProfile,
  writeWorkerConfig,
} from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import {
  assertProviderExecutorUnchanged,
  providerExecutorQualificationReader,
  providerExecutorStatus,
  type WorkerProviderExecutorQualification,
} from "./worker.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { assertTargetComposes } from "./worker-composition.ts";
import {
  assertLiveWorkerRoutingClosure,
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
  parseWorkerSecretInventory,
  readVersionBindings,
  type WorkerDeploymentChainEntry,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

export const PUBLIC_PARENT_TOKEN = "CLOUDFLARE_API_TOKEN" as const;
const EXECUTOR_BINDING = "CLOUDFLARE_PROVIDER_EXECUTOR" as const;

export interface PublicParentTokenRetirementInvocation {
  readonly surface: "takoserver-public-parent-token-retirement";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface PublicParentTokenRetirementState extends WorkerState {}

export type PublicParentTokenRetirementProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface PublicParentTokenRetirementOptions {
  readonly run?: PublicParentTokenRetirementProcess;
  readonly state?: PublicParentTokenRetirementState;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly providerExecutorQualification?: WorkerProviderExecutorQualification;
  readonly outputDirectory?: string;
  readonly review?: string;
  readonly publicationLease?: WranglerVersionPublicationLease;
  readonly executorPublicationLease?: WranglerVersionPublicationLease;
  readonly publicationLeaseRoot?: string;
}

type PublicRetirementStateKind =
  | "legacy-unbound-parent-token"
  | "bound-parent-token"
  | "retired-canonical"
  | "retired-secret-successor";

interface PublicRetirementInspection {
  readonly kind: PublicRetirementStateKind;
  readonly history: WorkerDeploymentHistory;
  readonly chain: readonly WorkerDeploymentChainEntry[];
  /** Canonical source identity, or the trusted canonical predecessor for a secret successor. */
  readonly commit: string;
  readonly bundleDigestHex: string;
  readonly scriptContentIdentity: string;
  readonly executorBindingReady: boolean;
  readonly parentTokenPresent: boolean;
  readonly trustedPredecessorVersionId: string | null;
}

/**
 * Fixed owner lane for the one public-Worker credential retirement.
 *
 * The selected target chooses account, public Worker and executor. The command
 * accepts none of those identities and never accepts a secret name. Apply may
 * make only the exact selected-commit binding release followed by deletion of
 * `CLOUDFLARE_API_TOKEN`; every other state change is outside this surface.
 */
export async function runPublicParentTokenRetirement(
  invocation: PublicParentTokenRetirementInvocation,
  target: DeployTarget,
  options: PublicParentTokenRetirementOptions = {},
): Promise<Record<string, unknown>> {
  validateInvocation(invocation, target);
  const run = options.run ?? runCommand;
  const credential =
    invocation.action === "status" && options.state !== undefined
      ? undefined
      : await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
        });
  const environment = credential?.childEnvironment ?? {};
  const cloudflareState =
    options.state === undefined
      ? new CloudflareState({
          accountId: target.accountId,
          token: credential?.token ?? exactToken(environment),
        })
      : null;
  const state = options.state ?? cloudflareState;
  if (state === null) throw preflightError("public parent-token retirement state is unavailable");
  const qualification = providerExecutorQualificationReader({
    target,
    commit: invocation.commit,
    state: cloudflareState,
    environment,
    run,
    ...(options.providerExecutorQualification === undefined
      ? {}
      : { injected: options.providerExecutorQualification }),
  });
  if (qualification === null) {
    throw preflightError("public parent-token retirement requires provider-executor qualification");
  }

  const executorBefore = await qualification.read("preflight");
  const publicBefore = await inspectPublicRetirementState("preflight", target, state);
  if (invocation.action === "status") {
    return statusResult(invocation, executorBefore, publicBefore);
  }
  if (!executorBefore.ready || !executorBefore.routeLess) {
    throw preflightError(
      "public parent-token retirement requires the exact selected-commit route-less provider executor",
    );
  }
  if (isCompleted(publicBefore, invocation.commit)) {
    throw preflightError("public parent-token retirement is already complete; use --status");
  }
  if (!publicBefore.parentTokenPresent) {
    throw preflightError(
      "public parent token is already absent without a completed exact cutover; use --status for adoption evidence",
    );
  }

  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  await assertTargetComposes("preflight", target);
  await runOwnerGate(run);

  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-public-parent-retirement-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let artifact: SealedArtifact | null = null;
  let publicLease: WranglerVersionPublicationLease | null = null;
  let executorLease: WranglerVersionPublicationLease | null = null;
  let targetTouched = false;
  try {
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      run,
      environment,
      writeConfig: publicParentConfigWriter(target, source.commit),
    });
    artifact = prepared.seal();
    artifact.assertUnchanged();

    const executorWorkerName = target.cloudflareProviderExecutor?.workerName;
    if (executorWorkerName === undefined) {
      throw preflightError("public parent-token retirement executor target disappeared");
    }
    executorLease =
      options.executorPublicationLease ??
      (await acquireWranglerVersionPublicationLease({
        accountId: target.accountId,
        workerName: executorWorkerName,
        ...(options.publicationLeaseRoot === undefined
          ? {}
          : { root: options.publicationLeaseRoot }),
      }));
    assertLeaseTarget(executorLease, target.accountId, executorWorkerName);

    publicLease =
      options.publicationLease ??
      (await acquireWranglerVersionPublicationLease({
        accountId: target.accountId,
        workerName: target.workerName,
        ...(options.publicationLeaseRoot === undefined
          ? {}
          : { root: options.publicationLeaseRoot }),
      }));
    assertLeaseTarget(publicLease, target.accountId, target.workerName);

    let current = await inspectPublicRetirementState("preflight", target, state);
    assertSameInspection(
      "preflight",
      publicBefore,
      current,
      "public Worker changed before the retirement lease was acquired",
    );
    assertProviderExecutorUnchanged(executorBefore, await qualification.read("preflight"));

    const releaseRequired =
      !current.executorBindingReady ||
      current.commit !== source.commit ||
      current.bundleDigestHex !== prepared.bundleDigestHex;
    let bindingRelease: Record<string, unknown>;
    if (releaseRequired) {
      const predecessorVersionId = current.history.versionId;
      await runBindingRelease({
        sourceCommit: source.commit,
        bundleDigestHex: prepared.bundleDigestHex,
        bundlePath: prepared.bundlePath,
        configPath: prepared.configPath,
        environment,
        run,
      });
      targetTouched = true;
      artifact.assertUnchanged();
      current = await inspectPublicRetirementState("verification", target, state);
      if (
        current.kind !== "bound-parent-token" ||
        current.history.previousVersionId !== predecessorVersionId ||
        current.commit !== source.commit ||
        current.bundleDigestHex !== prepared.bundleDigestHex
      ) {
        throw verificationError(
          "binding release did not create the exact selected-commit direct successor",
        );
      }
      assertProviderExecutorUnchanged(
        executorBefore,
        await qualification.read("verification"),
        "verification",
      );
      bindingRelease = {
        performed: true,
        previousVersionId: predecessorVersionId,
        versionId: current.history.versionId,
        bundleDigest: `sha256:${prepared.bundleDigestHex}`,
      };
    } else {
      if (current.kind !== "bound-parent-token") {
        throw preflightError(
          "public Worker is not the exact bound parent-token predecessor required for retirement",
        );
      }
      bindingRelease = {
        performed: false,
        versionId: current.history.versionId,
        bundleDigest: `sha256:${current.bundleDigestHex}`,
      };
    }

    const beforeDeletePhase: DeployPhase = targetTouched ? "verification" : "preflight";
    const beforeDelete = await inspectPublicRetirementState(beforeDeletePhase, target, state);
    assertSameInspection(
      beforeDeletePhase,
      current,
      beforeDelete,
      "public Worker changed before parent-token deletion",
    );
    if (
      beforeDelete.kind !== "bound-parent-token" ||
      beforeDelete.commit !== source.commit ||
      beforeDelete.bundleDigestHex !== prepared.bundleDigestHex
    ) {
      throw phaseError(
        beforeDeletePhase,
        "parent-token deletion requires the exact selected-commit bound predecessor",
      );
    }
    assertProviderExecutorUnchanged(
      executorBefore,
      await qualification.read(targetTouched ? "verification" : "preflight"),
      targetTouched ? "verification" : "preflight",
    );

    await runParentTokenDeletion({
      target,
      configPath: prepared.configPath,
      environment,
      run,
    });
    targetTouched = true;
    const after = await inspectPublicRetirementState("verification", target, state);
    if (
      after.kind !== "retired-secret-successor" ||
      after.history.previousVersionId !== beforeDelete.history.versionId ||
      after.trustedPredecessorVersionId !== beforeDelete.history.versionId ||
      after.commit !== source.commit ||
      after.bundleDigestHex !== prepared.bundleDigestHex ||
      after.scriptContentIdentity !== beforeDelete.scriptContentIdentity
    ) {
      throw verificationError(
        "parent-token deletion did not create the exact token-free direct successor",
      );
    }
    const executorAfter = await qualification.read("verification");
    assertProviderExecutorUnchanged(executorBefore, executorAfter, "verification");
    artifact.assertUnchanged();
    return {
      kind: "takoserver.public-parent-token-retirement-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      state: "complete",
      ready: true,
      commit: source.commit,
      dirty: source.dirty,
      changedPaths: source.changedPaths,
      remoteRef: source.remoteRef,
      reviewer,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      bundleDigest: `sha256:${after.bundleDigestHex}`,
      bindingRelease,
      secretRetirement: {
        performed: true,
        previousVersionId: beforeDelete.history.versionId,
        versionId: after.history.versionId,
        secretRemoved: PUBLIC_PARENT_TOKEN,
      },
      deploymentId: after.history.deploymentId,
      versionId: after.history.versionId,
      executorBindingReady: true,
      parentTokenPresent: false,
      scriptContentIdentity: after.scriptContentIdentity,
      ...providerExecutorStatus(executorAfter),
    };
  } catch (error) {
    if (targetTouched) {
      if (error instanceof DeployError && error.phase === "preflight") {
        throw verificationError(error.message, error.detail);
      }
      if (!(error instanceof DeployError)) {
        throw verificationError(
          "public parent-token retirement failed after its first effect",
          error instanceof Error ? error.name : typeof error,
        );
      }
    }
    throw error;
  } finally {
    try {
      await publicLease?.release();
    } finally {
      try {
        await executorLease?.release();
      } finally {
        if (artifact !== null) unsealDirectory(artifact.root);
        else unsealDirectory(root);
        if (temporary) rmSync(root, { recursive: true, force: true });
      }
    }
  }
}

async function inspectPublicRetirementState(
  phase: DeployPhase,
  target: DeployTarget,
  state: PublicParentTokenRetirementState,
): Promise<PublicRetirementInspection> {
  const before = await deploymentSnapshot(phase, target, state);
  const current = before.chain[0];
  if (current === undefined)
    throw phaseError(phase, "public Worker has no authoritative deployment");
  const version = await state.workerVersion(target.workerName, current.versionId);
  assertVersionIdentity(phase, current.versionId, version);
  const inventory = await state.workerSecrets(target.workerName);
  const secretNames = parseWorkerSecretInventory(inventory, phase);
  const parentTokenPresent = secretNames.includes(PUBLIC_PARENT_TOKEN);
  const bindingEntries = readVersionBindings(phase, current.versionId, version).filter(
    (binding) => binding.name === EXECUTOR_BINDING || binding.binding === EXECUTOR_BINDING,
  );
  const executorBindingReady = bindingEntries.length > 0;

  let result: PublicRetirementInspection;
  if (workerVersionAnnotationProfile(version) === "canonical") {
    const identity = workerVersionIdentity(phase, version);
    const authorityProfile = authorityProfileForCanonicalVersion(
      phase,
      target,
      current.versionId,
      version,
      identity,
    );
    const expectedSecrets = parentTokenPresent
      ? publicParentSecrets(target)
      : publicSecrets(target);
    const closure = expectedExactBindingClosure(target, {
      expectedSecrets,
      ...(authorityProfile === undefined ? {} : { authorityProfile }),
      workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
    });
    assertExactVersionBindingClosure(phase, current.versionId, version, {
      ...closure,
      ...(!executorBindingReady ? { [EXECUTOR_BINDING]: null } : {}),
    });
    assertExactSecretInventory(inventory, expectedSecrets, phase);
    if (!executorBindingReady && !parentTokenPresent) {
      throw phaseError(
        phase,
        "public parent token is absent before the exact executor binding was released",
      );
    }
    result = {
      kind: !executorBindingReady
        ? "legacy-unbound-parent-token"
        : parentTokenPresent
          ? "bound-parent-token"
          : "retired-canonical",
      history: before.history,
      chain: before.chain,
      ...identity,
      scriptContentIdentity: workerVersionScriptContentIdentity(phase, current.versionId, version),
      executorBindingReady,
      parentTokenPresent,
      trustedPredecessorVersionId: null,
    };
  } else if (workerVersionAnnotationProfile(version) === "secret-created") {
    if (parentTokenPresent || !executorBindingReady) {
      throw phaseError(
        phase,
        "secret-created public Worker is not an exact bound token-retirement successor",
      );
    }
    const predecessor = before.chain[1];
    if (predecessor === undefined || predecessor.versionId === current.versionId) {
      throw phaseError(phase, "token-retirement successor has no unique direct predecessor");
    }
    const predecessorVersion = await state.workerVersion(target.workerName, predecessor.versionId);
    assertVersionIdentity(phase, predecessor.versionId, predecessorVersion);
    if (workerVersionAnnotationProfile(predecessorVersion) !== "canonical") {
      throw phaseError(phase, "token-retirement predecessor has no canonical source identity");
    }
    const identity = workerVersionIdentity(phase, predecessorVersion);
    const authorityProfile = authorityProfileForCanonicalVersion(
      phase,
      target,
      predecessor.versionId,
      predecessorVersion,
      identity,
    );
    assertExactVersionBindingClosure(
      phase,
      predecessor.versionId,
      predecessorVersion,
      expectedExactBindingClosure(target, {
        expectedSecrets: publicParentSecrets(target),
        ...(authorityProfile === undefined ? {} : { authorityProfile }),
        workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
      }),
    );
    assertExactVersionBindingClosure(
      phase,
      current.versionId,
      version,
      expectedExactBindingClosure(target, {
        expectedSecrets: publicSecrets(target),
        ...(authorityProfile === undefined ? {} : { authorityProfile }),
        workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
      }),
    );
    assertExactSecretInventory(inventory, publicSecrets(target), phase);
    const predecessorScript = workerVersionScriptContentIdentity(
      phase,
      predecessor.versionId,
      predecessorVersion,
    );
    const successorScript = workerVersionScriptContentIdentity(phase, current.versionId, version);
    if (predecessorScript !== successorScript) {
      throw phaseError(phase, "token retirement changed the public Worker script identity");
    }
    result = {
      kind: "retired-secret-successor",
      history: before.history,
      chain: before.chain,
      ...identity,
      scriptContentIdentity: successorScript,
      executorBindingReady: true,
      parentTokenPresent: false,
      trustedPredecessorVersionId: predecessor.versionId,
    };
  } else {
    throw phaseError(phase, "public Worker has an unrecognized authority annotation profile");
  }

  await assertLiveWorkerRoutingClosure(phase, target, state);
  const after = await deploymentSnapshot(phase, target, state);
  if (!sameChain(before.chain, after.chain)) {
    throw phaseError(phase, "public Worker changed during parent-token retirement inspection");
  }
  return result;
}

function statusResult(
  invocation: PublicParentTokenRetirementInvocation,
  executor: CloudflareProviderExecutorInspection,
  inspected: PublicRetirementInspection,
): Record<string, unknown> {
  const complete = isCompleted(inspected, invocation.commit);
  return {
    kind: "takoserver.public-parent-token-retirement-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    state: inspected.kind,
    ready: complete && executor.ready && executor.routeLess,
    canApply: !complete && inspected.parentTokenPresent && executor.ready && executor.routeLess,
    deploymentId: inspected.history.deploymentId,
    versionId: inspected.history.versionId,
    previousVersionId: inspected.history.previousVersionId,
    deployedCommit: inspected.commit,
    artifactDigest: `sha256:${inspected.bundleDigestHex}`,
    bundleDigest: `sha256:${inspected.bundleDigestHex}`,
    scriptContentIdentity: inspected.scriptContentIdentity,
    executorBindingReady: inspected.executorBindingReady,
    parentTokenPresent: inspected.parentTokenPresent,
    ...providerExecutorStatus(executor),
  };
}

function publicParentConfigWriter(
  target: DeployTarget,
  commit: string,
): (input: {
  readonly path: string;
  readonly main: string;
  readonly bundleDigestHex?: string;
  readonly formImplementationIdentity?: WorkerConfigOptions["formImplementationIdentity"];
}) => string {
  return (input) =>
    writeWorkerConfig(target, {
      path: input.path,
      main: input.main,
      commit,
      signingKeyId: target.signing.currentKeyId,
      transitionExpectedSecrets: publicParentSecrets(target),
      ...(input.formImplementationIdentity === undefined
        ? {}
        : { formImplementationIdentity: input.formImplementationIdentity }),
      ...(input.bundleDigestHex === undefined
        ? target.integrationE2eCredentialAuthority === undefined
          ? {}
          : { authorityProfile: { kind: "historical-pre-jit" as const } }
        : {
            workerArtifactDigest: `sha256:${input.bundleDigestHex}` as const,
            ...(target.integrationE2eCredentialAuthority === undefined
              ? {}
              : {
                  authorityProfile: {
                    kind: "provenance-bound-jit" as const,
                    provenance: {
                      sourceCommit: commit,
                      artifactDigest: `sha256:${input.bundleDigestHex}` as const,
                    },
                  },
                }),
          }),
    });
}

async function runBindingRelease(input: {
  readonly sourceCommit: string;
  readonly bundleDigestHex: string;
  readonly bundlePath: string;
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: PublicParentTokenRetirementProcess;
}): Promise<void> {
  let result: CommandResult;
  try {
    result = await input.run(
      wranglerCommand([
        "deploy",
        input.bundlePath,
        "--no-bundle",
        "--config",
        input.configPath,
        "--strict",
        "--message",
        `takoserver-worker:${input.sourceCommit}:${input.bundleDigestHex}`,
      ]),
      { env: input.environment },
    );
  } catch (error) {
    throw mutationError(
      "public executor-binding release could not be started; run --status before repair",
      error instanceof Error ? error.name : typeof error,
    );
  }
  if (result.exitCode !== 0) {
    throw mutationError(
      "public executor-binding release acknowledgement is indeterminate; run --status before repair",
      `exit=${result.exitCode}`,
    );
  }
}

async function runParentTokenDeletion(input: {
  readonly target: DeployTarget;
  readonly configPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly run: PublicParentTokenRetirementProcess;
}): Promise<void> {
  let result: CommandResult;
  try {
    result = await input.run(
      wranglerCommand([
        "secret",
        "delete",
        PUBLIC_PARENT_TOKEN,
        "--name",
        input.target.workerName,
        "--config",
        input.configPath,
      ]),
      { env: input.environment },
    );
  } catch (error) {
    throw mutationError(
      "public parent-token deletion could not be started; run --status before repair",
      error instanceof Error ? error.name : typeof error,
    );
  }
  if (result.exitCode !== 0) {
    throw mutationError(
      "public parent-token deletion acknowledgement is indeterminate; run --status before repair",
      `exit=${result.exitCode}`,
    );
  }
}

function authorityProfileForCanonicalVersion(
  phase: DeployPhase,
  target: DeployTarget,
  versionId: string,
  version: unknown,
  identity: { readonly commit: string; readonly bundleDigestHex: string },
): WorkerVersionAuthorityProfile | undefined {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  return workerVersionAuthorityBindingShape(phase, versionId, version) === "historical-pre-jit"
    ? { kind: "historical-pre-jit" }
    : {
        kind: "provenance-bound-jit",
        provenance: {
          sourceCommit: identity.commit,
          artifactDigest: `sha256:${identity.bundleDigestHex}`,
        },
      };
}

async function deploymentSnapshot(
  phase: DeployPhase,
  target: DeployTarget,
  state: PublicParentTokenRetirementState,
): Promise<{
  readonly history: WorkerDeploymentHistory;
  readonly chain: readonly WorkerDeploymentChainEntry[];
}> {
  const chain = parseWorkerDeploymentChain(
    await state.workerDeployments(target.workerName),
    phase,
    {
      requireUuidVersionIds: true,
    },
  );
  const current = chain[0];
  if (current === undefined)
    throw phaseError(phase, "public Worker has no authoritative deployment");
  return {
    chain,
    history: {
      deploymentId: current.deploymentId,
      versionId: current.versionId,
      previousVersionId: chain[1]?.versionId ?? null,
    },
  };
}

function validateInvocation(
  invocation: PublicParentTokenRetirementInvocation,
  target: DeployTarget,
): void {
  if (invocation.surface !== "takoserver-public-parent-token-retirement") {
    throw preflightError("public parent-token retirement requires its fixed owner surface");
  }
  if (target.environment !== invocation.environment) {
    throw preflightError(
      "public parent-token retirement invocation and target environments differ",
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(invocation.commit)) {
    throw preflightError("public parent-token retirement requires one exact commit");
  }
  if (target.cloudflareProviderExecutor === undefined) {
    throw preflightError(
      "public parent-token retirement requires exact provider-executor topology",
    );
  }
  if (target.workerName === target.cloudflareProviderExecutor.workerName) {
    throw preflightError("public Worker and provider executor must be distinct exact targets");
  }
}

function assertVersionIdentity(phase: DeployPhase, versionId: string, version: unknown): void {
  if (!isRecord(version) || version.id !== versionId) {
    throw phaseError(phase, `public Worker Version ${versionId} returned a mismatched identity`);
  }
}

function assertLeaseTarget(
  lease: WranglerVersionPublicationLease,
  accountId: string,
  workerName: string,
): void {
  if (lease.accountId !== accountId || lease.workerName !== workerName) {
    throw preflightError("public parent-token retirement lease does not match the exact target");
  }
}

function assertSameInspection(
  phase: DeployPhase,
  expected: PublicRetirementInspection,
  actual: PublicRetirementInspection,
  message: string,
): void {
  if (
    expected.kind !== actual.kind ||
    expected.commit !== actual.commit ||
    expected.bundleDigestHex !== actual.bundleDigestHex ||
    expected.scriptContentIdentity !== actual.scriptContentIdentity ||
    expected.executorBindingReady !== actual.executorBindingReady ||
    expected.parentTokenPresent !== actual.parentTokenPresent ||
    !sameHistory(expected.history, actual.history) ||
    !sameChain(expected.chain, actual.chain)
  ) {
    throw phaseError(phase, message);
  }
}

function sameHistory(left: WorkerDeploymentHistory, right: WorkerDeploymentHistory): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.versionId === right.versionId &&
    left.previousVersionId === right.previousVersionId
  );
}

function sameChain(
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

function isCompleted(inspection: PublicRetirementInspection, selectedCommit: string): boolean {
  return (
    inspection.executorBindingReady &&
    !inspection.parentTokenPresent &&
    inspection.commit === selectedCommit &&
    (inspection.kind === "retired-canonical" || inspection.kind === "retired-secret-successor")
  );
}

function publicParentSecrets(target: DeployTarget): readonly string[] {
  return [...new Set([...expectedWorkerSecrets(target), PUBLIC_PARENT_TOKEN])].sort();
}

function publicSecrets(target: DeployTarget): readonly string[] {
  return expectedWorkerSecrets(target).filter((name) => name !== PUBLIC_PARENT_TOKEN);
}

async function runOwnerGate(run: PublicParentTokenRetirementProcess): Promise<void> {
  const result = await run(["bun", "run", "check"]);
  if (result.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
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

function phaseError(phase: DeployPhase, message: string): Error {
  return phase === "verification" ? verificationError(message) : preflightError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
