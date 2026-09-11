import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import { pendingMigrations, readD1SchemaState, readMigrationArtifact } from "./migrations.ts";
import {
  type CommandResult,
  REPOSITORY,
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
  type WorkerConfigOptions,
  type WorkerVersionAuthorityProfile,
  writeWorkerConfig,
} from "./realized-config.ts";
import { type DeployTarget, isArtifactBlobIoQuiescedTarget } from "./target.ts";
import {
  assertProviderExecutorUnchanged,
  type ProviderExecutorInspection,
  providerExecutorQualificationReader,
  providerExecutorStatus,
  type WorkerMigrationReader,
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
  LEGACY_HOSTED_SPONSORSHIP_SECRET,
  LEGACY_PUBLIC_PARENT_SECRET,
  optionalExactPlainTextBinding,
  parseWorkerDeploymentChain,
  parseWorkerSecretInventory,
  readVersionBindings,
  type WorkerDeploymentChainEntry,
  type WorkerDeploymentHistory,
  workerSecretsForLegacyCustody,
} from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

export const PUBLIC_PARENT_TOKEN = LEGACY_PUBLIC_PARENT_SECRET;
const EXECUTOR_BINDING = "CLOUDFLARE_PROVIDER_EXECUTOR" as const;
const QUIESCED_MODE = "pre-0043-quiesced" as const;

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
  readonly sourceRepositoryRoot?: string;
  readonly wranglerPath?: string;
  readonly outputDirectory?: string;
  readonly review?: string;
  readonly publicationLease?: WranglerVersionPublicationLease;
  readonly executorPublicationLease?: WranglerVersionPublicationLease;
  readonly publicationLeaseRoot?: string;
  /** Exact shared-D1 lineage seam; injectable only for portable tests. */
  readonly migrations?: WorkerMigrationReader;
}

type PublicRetirementStateKind =
  | "legacy-unbound-parent-token"
  | "quiesced-full-custody"
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
  readonly custody: "base" | "parent-only" | "full" | "post-parent";
  readonly trustedPredecessorVersionId: string | null;
}

interface PublicRetirementMigrationState {
  readonly local: readonly string[];
  readonly applied: readonly string[];
  readonly pending: readonly string[];
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
  if (isArtifactBlobIoQuiescedTarget(target)) {
    throw preflightError(
      "public parent-token retirement is unavailable for a pre-0043-quiesced target",
    );
  }
  validateInvocation(invocation, target);
  const run = options.run ?? runCommand;
  const credential =
    invocation.action === "status" && options.state !== undefined
      ? undefined
      : await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
          ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
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
    ...(options.providerExecutorQualification === undefined
      ? {}
      : { injected: options.providerExecutorQualification }),
  });
  if (qualification === null) {
    throw preflightError("public parent-token retirement requires provider-executor qualification");
  }

  const executorBefore = await qualification.read("preflight");
  const publicBefore = await inspectPublicRetirementState(
    "preflight",
    target,
    state,
    invocation.commit,
  );
  const migrations =
    options.migrations ??
    remoteMigrationReader(
      target,
      invocation.commit,
      environment,
      run,
      options.sourceRepositoryRoot ?? REPOSITORY,
      options.wranglerPath,
    );
  const migrationBefore = await retirementMigrationState(publicBefore, migrations);
  if (invocation.action === "status") {
    return statusResult(invocation, executorBefore, publicBefore, migrationBefore);
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
  assertSettledRetirementMigrations("preflight", migrationBefore);

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
      ...(options.sourceRepositoryRoot === undefined
        ? {}
        : { sourceRepositoryRoot: options.sourceRepositoryRoot }),
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
      run,
      environment,
      writeConfig: publicParentConfigWriter(
        target,
        source.commit,
        parentReleaseSecrets(target, publicBefore.custody),
        options.sourceRepositoryRoot,
      ),
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

    let current = await inspectPublicRetirementState("preflight", target, state, invocation.commit);
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
      await assertRetirementMigrationsUnchanged("preflight", migrationBefore, migrations);
      await runBindingRelease({
        sourceCommit: source.commit,
        bundleDigestHex: prepared.bundleDigestHex,
        bundlePath: prepared.bundlePath,
        configPath: prepared.configPath,
        environment,
        run,
        ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
      });
      targetTouched = true;
      artifact.assertUnchanged();
      current = await inspectPublicRetirementState(
        "verification",
        target,
        state,
        invocation.commit,
      );
      if (
        current.kind !== "bound-parent-token" ||
        current.custody !== publicBefore.custody ||
        current.history.previousVersionId !== predecessorVersionId ||
        current.commit !== source.commit ||
        current.bundleDigestHex !== prepared.bundleDigestHex
      ) {
        throw verificationError(
          "binding release did not create the exact selected-commit direct successor",
        );
      }
      await assertRetirementMigrationsUnchanged("verification", migrationBefore, migrations);
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
    const beforeDelete = await inspectPublicRetirementState(
      beforeDeletePhase,
      target,
      state,
      invocation.commit,
    );
    assertSameInspection(
      beforeDeletePhase,
      current,
      beforeDelete,
      "public Worker changed before parent-token deletion",
    );
    if (
      beforeDelete.kind !== "bound-parent-token" ||
      (beforeDelete.custody !== "parent-only" && beforeDelete.custody !== "full") ||
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
    await assertRetirementMigrationsUnchanged(beforeDeletePhase, migrationBefore, migrations);

    await runParentTokenDeletion({
      target,
      configPath: prepared.configPath,
      environment,
      run,
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
    });
    targetTouched = true;
    const after = await inspectPublicRetirementState(
      "verification",
      target,
      state,
      invocation.commit,
    );
    if (
      after.kind !== "retired-secret-successor" ||
      after.custody !== (beforeDelete.custody === "full" ? "post-parent" : "base") ||
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
    await assertRetirementMigrationsUnchanged("verification", migrationBefore, migrations);
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
  selectedCommit: string,
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
  const hostedTokenPresent = secretNames.includes(LEGACY_HOSTED_SPONSORSHIP_SECRET);
  const mode = optionalExactPlainTextBinding(
    phase,
    current.versionId,
    version,
    "TAKOSERVER_ARTIFACT_BLOB_IO_MODE",
  );
  if (mode !== null) {
    if (mode !== QUIESCED_MODE) {
      throw phaseError(phase, "public Worker has an unrecognized artifact blob I/O mode");
    }
    const rollback = before.chain[1];
    if (rollback === undefined || rollback.versionId === current.versionId) {
      throw phaseError(
        phase,
        "parent-token retirement requires two distinct immutable 0043 compatibility Versions",
      );
    }
    const rollbackVersion = await state.workerVersion(target.workerName, rollback.versionId);
    assertVersionIdentity(phase, rollback.versionId, rollbackVersion);
    const expectedSecrets = workerSecretsForLegacyCustody(target, "full");
    assertExactSecretInventory(inventory, expectedSecrets, phase);
    const quiescedTarget = { ...target, artifactBlobIoMode: QUIESCED_MODE } satisfies DeployTarget;
    const currentIdentity = proveQuiescedCustodyVersion(
      phase,
      quiescedTarget,
      current.versionId,
      version,
      selectedCommit,
      expectedSecrets,
    );
    const rollbackIdentity = proveQuiescedCustodyVersion(
      phase,
      quiescedTarget,
      rollback.versionId,
      rollbackVersion,
      selectedCommit,
      expectedSecrets,
    );
    const currentScript = workerVersionScriptContentIdentity(phase, current.versionId, version);
    const rollbackScript = workerVersionScriptContentIdentity(
      phase,
      rollback.versionId,
      rollbackVersion,
    );
    if (
      currentIdentity.bundleDigestHex !== rollbackIdentity.bundleDigestHex ||
      currentScript !== rollbackScript
    ) {
      throw phaseError(
        phase,
        "0043 compatibility custody Versions do not share one exact selected artifact",
      );
    }
    await assertLiveWorkerRoutingClosure(phase, target, state);
    const after = await deploymentSnapshot(phase, target, state);
    if (!sameChain(before.chain, after.chain)) {
      throw phaseError(phase, "public Worker changed during parent-token retirement inspection");
    }
    return {
      kind: "quiesced-full-custody",
      history: before.history,
      chain: before.chain,
      ...currentIdentity,
      scriptContentIdentity: currentScript,
      executorBindingReady: false,
      parentTokenPresent: true,
      custody: "full",
      trustedPredecessorVersionId: rollback.versionId,
    };
  }
  const bindingEntries = readVersionBindings(phase, current.versionId, version).filter(
    (binding) => binding.name === EXECUTOR_BINDING || binding.binding === EXECUTOR_BINDING,
  );
  const executorBindingReady = bindingEntries.length > 0;
  const custody: PublicRetirementInspection["custody"] =
    parentTokenPresent && hostedTokenPresent
      ? "full"
      : parentTokenPresent
        ? "parent-only"
        : hostedTokenPresent
          ? "post-parent"
          : "base";

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
    if ((custody === "full" && !executorBindingReady) || custody === "post-parent") {
      throw phaseError(
        phase,
        "canonical public Worker is not an exact parent-token retirement state",
      );
    }
    const expectedSecrets = publicRetirementSecrets(target, custody);
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
      custody,
      trustedPredecessorVersionId: null,
    };
  } else if (workerVersionAnnotationProfile(version) === "secret-created") {
    if (
      parentTokenPresent ||
      !executorBindingReady ||
      (custody !== "base" && custody !== "post-parent")
    ) {
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
    const predecessorCustody = custody === "post-parent" ? "full" : "parent-only";
    assertExactVersionBindingClosure(
      phase,
      predecessor.versionId,
      predecessorVersion,
      expectedExactBindingClosure(target, {
        expectedSecrets: publicRetirementSecrets(target, predecessorCustody),
        ...(authorityProfile === undefined ? {} : { authorityProfile }),
        workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
      }),
    );
    assertExactVersionBindingClosure(
      phase,
      current.versionId,
      version,
      expectedExactBindingClosure(target, {
        expectedSecrets: publicRetirementSecrets(target, custody),
        ...(authorityProfile === undefined ? {} : { authorityProfile }),
        workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
      }),
    );
    assertExactSecretInventory(inventory, publicRetirementSecrets(target, custody), phase);
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
      custody,
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

function proveQuiescedCustodyVersion(
  phase: DeployPhase,
  target: DeployTarget,
  versionId: string,
  version: unknown,
  selectedCommit: string,
  expectedSecrets: readonly string[],
): { readonly commit: string; readonly bundleDigestHex: string } {
  if (workerVersionAnnotationProfile(version) !== "canonical") {
    throw phaseError(phase, "0043 compatibility custody Version has no canonical source identity");
  }
  const identity = workerVersionIdentity(phase, version);
  if (identity.commit !== selectedCommit) {
    throw phaseError(
      phase,
      "0043 compatibility custody Version does not identify the selected source commit",
    );
  }
  const authorityProfile = authorityProfileForCanonicalVersion(
    phase,
    target,
    versionId,
    version,
    identity,
  );
  assertExactVersionBindingClosure(
    phase,
    versionId,
    version,
    expectedExactBindingClosure(target, {
      expectedSecrets,
      ...(authorityProfile === undefined ? {} : { authorityProfile }),
      workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
    }),
  );
  return identity;
}

function statusResult(
  invocation: PublicParentTokenRetirementInvocation,
  executor: ProviderExecutorInspection,
  inspected: PublicRetirementInspection,
  migrations: PublicRetirementMigrationState | null,
): Record<string, unknown> {
  const complete = isCompleted(inspected, invocation.commit);
  const schemaReady = migrations === null || migrations.pending.length === 0;
  return {
    kind: "takoserver.public-parent-token-retirement-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    state: inspected.kind,
    ready: complete && executor.ready && executor.routeLess && schemaReady,
    canApply:
      !complete &&
      inspected.parentTokenPresent &&
      executor.ready &&
      executor.routeLess &&
      schemaReady,
    deploymentId: inspected.history.deploymentId,
    versionId: inspected.history.versionId,
    previousVersionId: inspected.history.previousVersionId,
    deployedCommit: inspected.commit,
    artifactDigest: `sha256:${inspected.bundleDigestHex}`,
    bundleDigest: `sha256:${inspected.bundleDigestHex}`,
    scriptContentIdentity: inspected.scriptContentIdentity,
    executorBindingReady: inspected.executorBindingReady,
    parentTokenPresent: inspected.parentTokenPresent,
    legacySecretCustody: inspected.custody,
    ...(migrations === null
      ? {}
      : { appliedMigrations: migrations.applied, pendingMigrations: migrations.pending }),
    ...providerExecutorStatus(executor),
  };
}

function publicParentConfigWriter(
  target: DeployTarget,
  commit: string,
  expectedSecrets: readonly string[],
  sourceRepositoryRoot?: string,
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
      ...(sourceRepositoryRoot === undefined ? {} : { sourceRepositoryRoot }),
      signingKeyId: target.signing.currentKeyId,
      transitionExpectedSecrets: expectedSecrets,
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
  readonly wranglerPath?: string;
}): Promise<void> {
  let result: CommandResult;
  try {
    result = await input.run(
      deployWranglerCommand(input.wranglerPath, [
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
  readonly wranglerPath?: string;
}): Promise<void> {
  let result: CommandResult;
  try {
    result = await input.run(
      deployWranglerCommand(input.wranglerPath, [
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

function deployWranglerCommand(
  wranglerPath: string | undefined,
  args: readonly string[],
): readonly string[] {
  return wranglerPath === undefined ? wranglerCommand(args) : [wranglerPath, ...args];
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
    expected.custody !== actual.custody ||
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

function parentReleaseSecrets(
  target: DeployTarget,
  custody: PublicRetirementInspection["custody"],
): readonly string[] {
  if (custody === "full") return workerSecretsForLegacyCustody(target, "full");
  if (custody === "parent-only") {
    return [
      ...new Set([...workerSecretsForLegacyCustody(target, "base"), PUBLIC_PARENT_TOKEN]),
    ].sort();
  }
  throw preflightError("public parent-token release requires an exact parent-token custody state");
}

function publicRetirementSecrets(
  target: DeployTarget,
  custody: PublicRetirementInspection["custody"],
): readonly string[] {
  if (custody === "full") return workerSecretsForLegacyCustody(target, "full");
  if (custody === "post-parent") return workerSecretsForLegacyCustody(target, "post-parent");
  if (custody === "base") return workerSecretsForLegacyCustody(target, "base");
  return [
    ...new Set([...workerSecretsForLegacyCustody(target, "base"), PUBLIC_PARENT_TOKEN]),
  ].sort();
}

async function retirementMigrationState(
  inspection: PublicRetirementInspection,
  migrations: WorkerMigrationReader,
): Promise<PublicRetirementMigrationState | null> {
  if (inspection.custody !== "full" && inspection.custody !== "post-parent") return null;
  const state = await migrations.read();
  const local = [...state.local];
  const applied = [...state.applied];
  return {
    local,
    applied,
    pending: pendingMigrations(local, applied),
  };
}

function assertSettledRetirementMigrations(
  phase: DeployPhase,
  state: PublicRetirementMigrationState | null,
): void {
  if (state !== null && state.pending.length > 0) {
    throw phaseError(
      phase,
      "0043 compatibility exit requires the complete shared D1 migration lineage",
    );
  }
}

async function assertRetirementMigrationsUnchanged(
  phase: DeployPhase,
  expected: PublicRetirementMigrationState | null,
  migrations: WorkerMigrationReader,
): Promise<void> {
  if (expected === null) return;
  const actualState = await migrations.read();
  const local = [...actualState.local];
  const applied = [...actualState.applied];
  const actual: PublicRetirementMigrationState = {
    local,
    applied,
    pending: pendingMigrations(local, applied),
  };
  assertSettledRetirementMigrations(phase, actual);
  if (
    JSON.stringify(actual.local) !== JSON.stringify(expected.local) ||
    JSON.stringify(actual.applied) !== JSON.stringify(expected.applied) ||
    JSON.stringify(actual.pending) !== JSON.stringify(expected.pending)
  ) {
    throw phaseError(phase, "shared D1 migration lineage changed during 0043 compatibility exit");
  }
}

function remoteMigrationReader(
  target: DeployTarget,
  commit: string,
  environment: Readonly<Record<string, string>>,
  run: PublicParentTokenRetirementProcess,
  sourceRepositoryRoot: string,
  wranglerPath?: string,
): WorkerMigrationReader {
  return {
    async read() {
      const root = mkdtempSync(join(tmpdir(), "takoserver-public-parent-migrations-"));
      try {
        const configPath = writeWorkerConfig(target, {
          path: join(root, "wrangler.jsonc"),
          main: resolve(sourceRepositoryRoot, "src/entry-cloudflare-worker.ts"),
          commit,
          sourceRepositoryRoot,
          ...(target.integrationE2eCredentialAuthority === undefined
            ? {}
            : { authorityProfile: { kind: "historical-pre-jit" as const } }),
        });
        const local = readMigrationArtifact(resolve(sourceRepositoryRoot, "migrations"));
        const remote = await readD1SchemaState(
          new RemoteD1(configPath, {
            environment,
            run,
            wranglerCommand: (args) => deployWranglerCommand(wranglerPath, args),
          }),
        );
        return { local: local.names, applied: remote.applied };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
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
