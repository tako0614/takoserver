import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import { type WorkerConfigOptions, writeWorkerConfig } from "./realized-config.ts";
import {
  createRemoteSponsorshipCutoverConsumptionDatabase,
  type SponsorshipCutoverConsumptionDatabase,
  writeSponsorshipCutoverConsumptionConfig,
} from "./sponsorship-cutover-consumption.ts";
import {
  createSponsorshipCutoverProofGate,
  inspectSponsorshipCutoverPublicWorker,
  type SponsorshipCutoverProofGate,
  type SponsorshipCutoverProofState,
  sponsorshipCutoverProofConfigured,
} from "./sponsorship-cutover-proof.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  assertLiveWorkerRoutingClosure,
  inspectLiveWorkerVersionForRetirement,
  isWorkerVersionId,
  type RetirementLiveWorkerVersion,
  type WorkerState,
  type WorkerVersionAuthorityBindingShape,
  type WorkerVersionAuthorityProfile,
  workerVersionAnnotationProfile,
  workerVersionAuthorityBindingShape,
  workerVersionScriptContentIdentity,
} from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedTransitionBindingClosure,
  extractLegacyHostServiceBinding,
  LEGACY_HOSTED_SPONSORSHIP_SECRET,
  type LegacyHostServiceBinding,
  parseWorkerDeploymentHistory,
  versionSecretBindingNames,
  type WorkerDeploymentHistory,
  workerLegacySecretCustodyProfile,
  workerSecretsForLegacyCustody,
} from "./worker-state.ts";

export const HOSTED_SPONSORSHIP_SECRET = LEGACY_HOSTED_SPONSORSHIP_SECRET;
const QUIESCED_ARTIFACT_MODE = "pre-0043-quiesced" as const;
const PROVIDER_EXECUTOR_BINDING = "CLOUDFLARE_PROVIDER_EXECUTOR" as const;

/**
 * Retirement only follows the known provider-history suffix. Older history is
 * intentionally ignored once the pinned predecessor is reached, but no
 * mutation may rely on a longer or untyped ancestry walk. The longest
 * accepted word is the five-edge C' -> T' -> R -> T -> C -> P suffix.
 */
const MAX_RETIREMENT_ANCESTRY_DISTANCE = 5;

function legacyServiceBindingName(): string {
  return ["HOST", "RUNTIME", "MATERIALIZER"].join("_");
}

export type RetirementSurface =
  | "takoserver-worker-authority-cutover"
  | "takoserver-sponsorship-public-route-retirement"
  | "takoserver-host-runtime-topology-retirement"
  | "takoserver-hosted-token-retirement"
  | "takoserver-worker-retirement-attribution-repair";

export interface RetirementInvocation {
  readonly surface: RetirementSurface;
  readonly action: "status" | "apply";
  readonly reverse?: boolean;
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly legacyHostRuntimePredecessorVersionId?: string;
  readonly unattributedSuccessorVersionId?: string;
}

export type RetirementProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface RetirementState extends WorkerState {}

export interface RetirementOptions {
  readonly run?: RetirementProcess;
  readonly state?: RetirementState;
  readonly review?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly proofGate?: SponsorshipCutoverProofGate;
  readonly cutoverConsumptionDatabase?: SponsorshipCutoverConsumptionDatabase;
}

/**
 * Executes one reviewed retirement transition. Each apply path performs at
 * most one provider mutation and then reads authoritative state; an
 * acknowledgement failure is never retried by this process.
 */
export async function runRetirement(
  invocation: RetirementInvocation,
  target: DeployTarget,
  options: RetirementOptions = {},
): Promise<Record<string, unknown>> {
  validateInvocation(invocation, target);
  const run = options.run ?? runCommand;
  const credential =
    invocation.environment === "integration" &&
    options.state !== undefined &&
    invocation.action === "status"
      ? undefined
      : await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
        });
  const environment = credential?.childEnvironment ?? {};
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: credential?.token ?? exactToken(environment),
    });
  const runtimeOptions: RetirementOptions = {
    ...options,
    cloudflareEnvironment: environment,
  };
  if (
    invocation.surface === "takoserver-worker-authority-cutover" ||
    invocation.surface === "takoserver-sponsorship-public-route-retirement"
  ) {
    return await runAuthorityTransition(invocation, target, state, run, runtimeOptions);
  }
  if (invocation.surface === "takoserver-host-runtime-topology-retirement") {
    return await runTopologyRetirement(invocation, target, state, run, runtimeOptions);
  }
  if (invocation.surface === "takoserver-worker-retirement-attribution-repair") {
    return await runAttributionRepair(invocation, target, state, run, runtimeOptions);
  }
  return await runTokenRetirement(invocation, target, state, run, runtimeOptions);
}

export async function runAuthorityTransition(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions = {},
): Promise<Record<string, unknown>> {
  const selector = invocation.legacyHostRuntimePredecessorVersionId;
  if (selector === undefined) {
    throw preflightError(
      "authority transition requires --legacy-host-runtime-predecessor-version=<uuid>",
    );
  }
  if (!isWorkerVersionId(selector)) {
    throw preflightError("legacy Host-runtime predecessor Version ID must be one exact UUID");
  }
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-authority-transition-"));
  const temporary = options.outputDirectory === undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    if (invocation.surface === "takoserver-sponsorship-public-route-retirement") {
      const post0043 = await inspectPost0043RetirementLineage(
        "preflight",
        target,
        state,
        selector,
        invocation.commit,
      );
      if (post0043 !== null) {
        return await runPost0043RouteSettlement(
          invocation,
          target,
          state,
          run,
          options,
          root,
          post0043,
        );
      }
    }
    const current = await currentHistory("preflight", target, state);
    const predecessor = await readVersionAt("preflight", target, state, current.versionId);
    const service = extractLegacyHostServiceBinding("preflight", current.versionId, predecessor);
    if (current.versionId !== selector) {
      if (!invocation.reverse && current.previousVersionId === selector) {
        return await authorityCandidateStatus(
          invocation,
          target,
          state,
          current,
          service,
          optionalProofGate(invocation, target, state, options, root, run),
        );
      }
      if (invocation.action === "status") {
        throw preflightError(
          "authoritative Worker Version is not the pinned legacy predecessor or its direct candidate successor",
        );
      }
      if (!invocation.reverse) {
        throw preflightError(
          "authoritative Worker Version is not the pinned legacy predecessor; status must establish the direct predecessor",
        );
      }
    }

    if (invocation.action === "status") {
      const legacy = await inspectRetirementVersionAt(
        "preflight",
        target,
        state,
        current,
        service,
        hostedVersionSecrets(target),
        hostedVersionSecrets(target),
        undefined,
        historicalAuthorityProfile(target),
      );
      const publicWorkerPredecessor =
        invocation.surface === "takoserver-sponsorship-public-route-retirement"
          ? await inspectSponsorshipCutoverPublicWorker(target, sponsorshipProofState(state))
          : undefined;
      if (
        publicWorkerPredecessor !== undefined &&
        (publicWorkerPredecessor.versionId !== legacy.history.versionId ||
          publicWorkerPredecessor.commit !== legacy.commit ||
          publicWorkerPredecessor.bundleSha256 !== digestValue(legacy.bundleDigestHex))
      ) {
        throw preflightError("public Worker predecessor evidence changed during status inspection");
      }
      return {
        kind: "takoserver.worker-authority-transition-status@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        state: "legacy-predecessor-current",
        ready: false,
        versionId: legacy.history.versionId,
        service: service.service,
        entrypoint: service.entrypoint,
        deployedCommit: legacy.commit,
        artifactDigest: digestValue(legacy.bundleDigestHex),
        ...(publicWorkerPredecessor === undefined
          ? {}
          : {
              publicWorkerPredecessor: {
                kind: "takoserver.sponsorship-public-worker-predecessor@v1",
                workerName: publicWorkerPredecessor.workerName,
                deploymentId: publicWorkerPredecessor.deploymentId,
                versionId: publicWorkerPredecessor.versionId,
                previousVersionId: publicWorkerPredecessor.previousVersionId,
                sourceCommit: publicWorkerPredecessor.commit,
                artifactSha256: publicWorkerPredecessor.bundleSha256,
                scriptEtagSha256: publicWorkerPredecessor.scriptEtagSha256,
                cutoverOperationId: publicWorkerPredecessor.cutoverOperationId,
                topologySha256: publicWorkerPredecessor.topologySha256,
                publicTopology: publicWorkerPredecessor.publicTopology,
              },
            }),
      };
    }

    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    if (invocation.reverse) {
      return await reverseAuthority(
        invocation,
        target,
        state,
        run,
        current,
        service,
        reviewer,
        root,
        options,
      );
    }
    const proofGate = requiredProofGate(invocation, target, state, options, root, run);
    const proof = await proofGate.authorize("public-route-removal");
    const legacy = await inspectRetirementVersionAt(
      "preflight",
      target,
      state,
      current,
      service,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
      undefined,
      historicalAuthorityProfile(target),
    );
    const source = await qualifySource({
      environment: invocation.environment === "integration" ? "integration" : "production",
      commit: invocation.commit,
      run,
    });
    const gate = await run(["bun", "run", "check"]);
    if (gate.exitCode !== 0) {
      throw preflightError(
        `scoped owner gate \`bun run check\` failed (exit ${gate.exitCode})`,
        `${gate.stdout}${gate.stderr}`.trim(),
      );
    }
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      signingKeyId: target.signing.currentKeyId,
      run,
      environment: options.cloudflareEnvironment,
      writeConfig: transitionConfigWriter(
        target,
        source.commit,
        service,
        hostedVersionSecrets(target),
      ),
    });
    const artifact = prepared.seal();
    artifact.assertUnchanged();
    const freshHistory = await currentHistory("preflight", target, state);
    if (
      freshHistory.versionId !== legacy.history.versionId ||
      freshHistory.previousVersionId !== legacy.history.previousVersionId
    ) {
      throw preflightError("pinned legacy predecessor changed before authority transition upload");
    }
    const freshVersion = await readVersionAt("preflight", target, state, freshHistory.versionId);
    const freshService = extractLegacyHostServiceBinding(
      "preflight",
      freshHistory.versionId,
      freshVersion,
    );
    if (
      freshService.service !== service.service ||
      freshService.entrypoint !== service.entrypoint
    ) {
      throw preflightError(
        "pinned legacy service identity changed before authority transition upload",
      );
    }
    await inspectRetirementVersionAt(
      "preflight",
      target,
      state,
      freshHistory,
      service,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
      freshVersion,
      historicalAuthorityProfile(target),
    );
    const started = await proofGate.begin(proof, {
      sourceCommit: source.commit,
      bundleSha256: `sha256:${prepared.bundleDigestHex}`,
      configSha256: digestFile(prepared.configPath),
    });
    if (!started.fresh) {
      throw preflightError(
        "sponsorship cutover start already exists; apply is forbidden and only status reconciliation is allowed",
      );
    }
    const upload = await started.executionClaim.execute(
      async () =>
        await run(
          wranglerCommand([
            "deploy",
            prepared.bundlePath,
            "--no-bundle",
            "--config",
            prepared.configPath,
            "--strict",
            "--message",
            `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}:${started.operationId.slice(7)}`,
          ]),
          providerOptions(options.cloudflareEnvironment),
        ),
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "authority transition upload acknowledgement is indeterminate; run --status before repair",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }
    const afterHistory = await currentHistory("verification", target, state);
    if (
      afterHistory.versionId === legacy.history.versionId ||
      afterHistory.previousVersionId !== legacy.history.versionId
    ) {
      throw verificationError("authority transition did not create the exact direct successor");
    }
    const after = await inspectRetirementVersionAt(
      "verification",
      target,
      state,
      afterHistory,
      service,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
      undefined,
      provenanceBoundAuthorityProfile(
        "verification",
        target,
        source.commit,
        prepared.bundleDigestHex,
      ),
    );
    if (after.commit !== source.commit || after.bundleDigestHex !== prepared.bundleDigestHex) {
      throw verificationError(
        "authority transition successor identity differs from the sealed candidate",
      );
    }
    await proofGate.complete(proof, after.history.versionId);
    return {
      kind: "takoserver.worker-authority-transition-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      state: "candidate",
      commit: source.commit,
      reviewer,
      previousVersionId: legacy.history.versionId,
      versionId: after.history.versionId,
      service: service.service,
      entrypoint: service.entrypoint,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      bundleDigest: `sha256:${prepared.bundleDigestHex}`,
      sponsorshipCutoverProofSha256: proof.proofSha256,
      reverse: {
        surface: "takoserver-sponsorship-public-route-retirement",
        exactVersionId: legacy.history.versionId,
        mode: "provider-history",
      },
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function runPost0043RouteSettlement(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions,
  root: string,
  before: Post0043RetirementLineage,
): Promise<Record<string, unknown>> {
  if (before.head !== "post-parent") {
    throw preflightError(
      "preexisting route-removal settlement requires the exact post-parent P Version",
    );
  }
  if (invocation.reverse) {
    throw preflightError(
      "preexisting route removal has no provider effect to reverse after the 0043 compatibility exit",
    );
  }
  const proofGate = requiredProofGate(invocation, target, state, options, root, run);
  if (invocation.action === "status") {
    const proofSha256 = await proofGate.settlePreexistingRouteRemoval(before.parentVersionId);
    return {
      kind: "takoserver.worker-authority-transition-status@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      state:
        proofSha256 === undefined
          ? "preexisting-route-removal-unsettled"
          : "preexisting-route-removal-settled",
      ready: proofSha256 !== undefined,
      canApply: proofSha256 === undefined,
      versionId: before.history.versionId,
      previousVersionId: before.history.previousVersionId,
      deployedCommit: before.selectedIdentity.commit,
      artifactDigest: digestValue(before.selectedIdentity.bundleDigestHex),
      service: before.service.service,
      entrypoint: before.service.entrypoint,
      providerMutationRequired: false,
      observedPreexistingRouteRemoval: true,
      ...(proofSha256 === undefined ? {} : { sponsorshipCutoverProofSha256: proofSha256 }),
    };
  }

  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const source = await qualifySource({
    environment: invocation.environment === "integration" ? "integration" : "production",
    commit: invocation.commit,
    run,
  });
  if (source.commit !== before.selectedIdentity.commit) {
    throw preflightError("preexisting route-removal source differs from the exact E Version");
  }
  const gate = await run(["bun", "run", "check"]);
  if (gate.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${gate.exitCode})`,
      `${gate.stdout}${gate.stderr}`.trim(),
    );
  }
  const prepared = await prepareWorkerArtifact({
    root,
    target,
    commit: source.commit,
    signingKeyId: target.signing.currentKeyId,
    run,
    environment: options.cloudflareEnvironment,
    writeConfig: transitionConfigWriter(
      target,
      source.commit,
      undefined,
      hostedVersionSecrets(target),
    ),
  });
  if (prepared.bundleDigestHex !== before.selectedIdentity.bundleDigestHex) {
    throw preflightError(
      "preexisting route-removal settlement source differs from the served E artifact",
    );
  }
  const artifact = prepared.seal();
  artifact.assertUnchanged();
  const fresh = await inspectPost0043RetirementLineage(
    "preflight",
    target,
    state,
    before.legacyVersionId,
    invocation.commit,
  );
  if (
    fresh === null ||
    fresh.head !== "post-parent" ||
    fresh.fingerprint !== before.fingerprint ||
    !sameDeploymentHistory(fresh.history, before.history)
  ) {
    throw preflightError("post-0043 custody prefix changed before route settlement");
  }
  const proofSha256 = await proofGate.adoptPreexistingRouteRemoval({
    sourceCommit: source.commit,
    bundleSha256: `sha256:${prepared.bundleDigestHex}`,
    configSha256: digestFile(prepared.configPath),
  });
  artifact.assertUnchanged();
  const after = await inspectPost0043RetirementLineage(
    "verification",
    target,
    state,
    before.legacyVersionId,
    invocation.commit,
  );
  if (
    after === null ||
    after.head !== "post-parent" ||
    after.fingerprint !== before.fingerprint ||
    !sameDeploymentHistory(after.history, before.history)
  ) {
    throw verificationError("preexisting route-removal settlement changed the served Worker state");
  }
  return {
    kind: "takoserver.worker-authority-transition-apply@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    state: "preexisting-route-removal-settled",
    commit: source.commit,
    reviewer,
    previousVersionId: before.history.previousVersionId,
    versionId: before.history.versionId,
    service: before.service.service,
    entrypoint: before.service.entrypoint,
    artifactDigest: artifact.digest,
    artifactBytes: artifact.bytes,
    bundleDigest: `sha256:${prepared.bundleDigestHex}`,
    sponsorshipCutoverProofSha256: proofSha256,
    providerMutationApplied: false,
    receiptMutationApplied: true,
    observedPreexistingRouteRemoval: true,
  };
}

async function authorityCandidateStatus(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  history: WorkerDeploymentHistory,
  service: LegacyHostServiceBinding,
  proofGate?: SponsorshipCutoverProofGate,
): Promise<Record<string, unknown>> {
  const predecessorId = invocation.legacyHostRuntimePredecessorVersionId;
  if (predecessorId === undefined || history.previousVersionId !== predecessorId) {
    throw preflightError(
      "authority transition candidate is not the direct successor of its pinned predecessor",
    );
  }
  const previous = await readVersionAt("preflight", target, state, predecessorId);
  assertRetirementVersionShape(
    "preflight",
    target,
    state,
    predecessorId,
    previous,
    service,
    hostedVersionSecrets(target),
    historicalAuthorityProfile(target),
  );
  const candidate = await inspectRetirementVersionAt(
    "preflight",
    target,
    state,
    history,
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
    undefined,
    await requireCurrentAuthorityProfileAt("preflight", target, state, history.versionId),
  );
  if (candidate.commit !== invocation.commit) {
    throw preflightError(
      "authority transition candidate commit does not match the selected commit",
    );
  }
  const proofSha256 = await proofGate?.settle("public-route-removal", history.versionId);
  if (
    invocation.surface === "takoserver-sponsorship-public-route-retirement" &&
    proofSha256 === undefined
  ) {
    throw preflightError(
      "terminal sponsorship route-removal status requires the current sponsorship cutover proof",
    );
  }
  return {
    kind: "takoserver.worker-authority-transition-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    state: "candidate",
    ready: true,
    versionId: history.versionId,
    previousVersionId: predecessorId,
    deployedCommit: candidate.commit,
    artifactDigest: digestValue(candidate.bundleDigestHex),
    service: service.service,
    entrypoint: service.entrypoint,
    ...(proofSha256 === undefined ? {} : { sponsorshipCutoverProofSha256: proofSha256 }),
  };
}

async function reverseAuthority(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  current: WorkerDeploymentHistory,
  service: LegacyHostServiceBinding,
  reviewer: string,
  root: string,
  options: RetirementOptions,
): Promise<Record<string, unknown>> {
  const selector = invocation.legacyHostRuntimePredecessorVersionId;
  if (selector === undefined || current.previousVersionId !== selector) {
    throw preflightError("authority transition reverse requires the pinned direct predecessor");
  }
  const historicalProfile = historicalAuthorityProfile(target);
  const candidate = await inspectRetirementVersionAt(
    "preflight",
    target,
    state,
    current,
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
    undefined,
    await requireCurrentAuthorityProfileAt("preflight", target, state, current.versionId),
  );
  if (candidate.commit !== invocation.commit) {
    throw preflightError("authority transition reverse requires the selected candidate commit");
  }
  const predecessor = await readVersionAt("preflight", target, state, selector);
  assertRetirementVersionShape(
    "preflight",
    target,
    state,
    selector,
    predecessor,
    service,
    hostedVersionSecrets(target),
    historicalAuthorityProfile(target),
  );
  const configPath = writeWorkerConfig(target, {
    path: join(root, "retirement-reverse-wrangler.jsonc"),
    main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
    commit: invocation.commit,
    signingKeyId: target.signing.currentKeyId,
    transitionServiceBinding: service,
    transitionExpectedSecrets: hostedVersionSecrets(target),
    ...(historicalProfile === undefined ? {} : { authorityProfile: historicalProfile }),
  });
  const mutation = await run(
    wranglerCommand([
      "versions",
      "deploy",
      `${selector}@100%`,
      "--yes",
      "--name",
      target.workerName,
      "--config",
      configPath,
    ]),
    providerOptions(options.cloudflareEnvironment),
  );
  if (mutation.exitCode !== 0) {
    throw mutationError(
      "authority transition reverse acknowledgement is indeterminate; run --status before repair",
      `${mutation.stdout}${mutation.stderr}`.trim(),
    );
  }
  const afterHistory = await currentHistory("verification", target, state);
  if (afterHistory.versionId !== selector) {
    throw verificationError("authority transition reverse did not restore the pinned predecessor");
  }
  const after = await inspectRetirementVersionAt(
    "verification",
    target,
    state,
    afterHistory,
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
    undefined,
    historicalAuthorityProfile(target),
  );
  return {
    kind: "takoserver.worker-authority-transition-reverse@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    state: "legacy-restored",
    reviewer,
    versionId: after.history.versionId,
    service: service.service,
    entrypoint: service.entrypoint,
    reverse: { mode: "provider-history", exactVersionId: selector },
  };
}

async function runTopologyRetirement(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions,
): Promise<Record<string, unknown>> {
  const selector = requiredPredecessorSelector(invocation);
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-topology-retirement-"));
  const temporary = options.outputDirectory === undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const beforeHistory = await currentHistory("preflight", target, state);
    const beforeVersion = await readVersionAt("preflight", target, state, beforeHistory.versionId);
    const post0043 = await inspectPost0043RetirementLineage(
      "preflight",
      target,
      state,
      selector,
      invocation.commit,
    );
    if (post0043 !== null) {
      if (post0043.head !== "post-parent") {
        throw preflightError(
          "post-0043 topology status is only defined at the exact post-parent P Version",
        );
      }
      if (invocation.action === "apply") {
        throw preflightError(
          "post-0043 topology is already retired; no provider apply or reverse is permitted",
        );
      }
      const proofSha256 = await requiredProofGate(
        invocation,
        target,
        state,
        options,
        root,
        run,
      ).settlePreexistingRouteRemoval(post0043.parentVersionId);
      return {
        kind: "takoserver.host-runtime-topology-retirement-status@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        state:
          proofSha256 === undefined
            ? "preexisting-topology-retired-unsettled"
            : "preexisting-topology-retired",
        ready: proofSha256 !== undefined,
        canApply: false,
        versionId: post0043.history.versionId,
        previousVersionId: post0043.history.previousVersionId,
        deployedCommit: post0043.selectedIdentity.commit,
        artifactDigest: digestValue(post0043.selectedIdentity.bundleDigestHex),
        serviceRemoved: legacyServiceBindingName(),
        secretRetained: HOSTED_SPONSORSHIP_SECRET,
        providerMutationRequired: false,
        observedPreexistingTopologyRetirement: true,
        ...(proofSha256 === undefined ? {} : { sponsorshipCutoverProofSha256: proofSha256 }),
      };
    }
    const topologyPresent = hasMaterializerBinding(beforeVersion);
    if (!topologyPresent) {
      const beforeInventory = await state.workerSecrets(target.workerName);
      const beforeHasToken = inventoryHasSecret(beforeInventory, HOSTED_SPONSORSHIP_SECRET);
      // A topology-shaped head is either the direct T successor of C or the
      // bounded T' successor of an already token-retired R. Select the
      // trusted canonical predecessor by that lineage position, never by the
      // current Version's annotation inventory. In the ordinary C -> T
      // suffix, C is the direct predecessor; in the T' -> R -> T extension,
      // R is unannotated and T is the second ancestor.
      const directPredecessor =
        beforeHistory.previousVersionId === null
          ? undefined
          : await readVersionAt("preflight", target, state, beforeHistory.previousVersionId);
      const trustedAncestorDistance: 1 | 2 =
        beforeHasToken &&
        directPredecessor !== undefined &&
        !hasMaterializerBinding(directPredecessor)
          ? 2
          : 1;
      const beforeAuthorityProfile = await requireProviderSuccessorAuthorityProfileAt(
        "preflight",
        target,
        state,
        beforeHistory,
        trustedAncestorDistance,
        "provenance-bound-jit",
      );
      const before = await inspectRetirementVersionAt(
        "preflight",
        target,
        state,
        beforeHistory,
        null,
        beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
        beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
        undefined,
        beforeAuthorityProfile,
      );
      if (invocation.action === "status") {
        if (!beforeHasToken) {
          throw preflightError(
            "topology retirement status cannot prove the candidate while the Hosted secret is absent",
          );
        }
        const candidate = await topologyReverseCandidate(
          "preflight",
          target,
          state,
          beforeHistory,
          before,
          selector,
          beforeAuthorityProfile,
        );
        const predecessorId = candidate.versionId;
        if (
          candidate.commit !== before.commit ||
          candidate.bundleDigestHex !== before.bundleDigestHex
        ) {
          throw preflightError("topology retirement status predecessor is not byte-identical");
        }
        return {
          kind: "takoserver.host-runtime-topology-retirement-status@v1",
          surface: invocation.surface,
          environment: invocation.environment,
          selectedCommit: invocation.commit,
          state: "topology-retired",
          ready: before.commit === invocation.commit,
          versionId: before.history.versionId,
          previousVersionId: predecessorId,
          deployedCommit: before.commit,
          artifactDigest: digestValue(before.bundleDigestHex),
          serviceRemoved: legacyServiceBindingName(),
          secretRetained: HOSTED_SPONSORSHIP_SECRET,
        };
      }
      if (!invocation.reverse) {
        throw preflightError("Hosted topology is already retired; run --status or --reverse");
      }
      if (!beforeHasToken) {
        throw preflightError(
          "topology retirement reverse requires the Hosted secret to remain present",
        );
      }
      const candidate = await topologyReverseCandidate(
        "preflight",
        target,
        state,
        beforeHistory,
        before,
        selector,
        beforeAuthorityProfile,
      );
      return await reverseTopology(
        invocation,
        target,
        state,
        run,
        beforeHistory,
        before,
        candidate.service,
        await exactReviewer(options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW")),
        root,
        options,
        candidate.versionId,
        selector,
        beforeAuthorityProfile,
      );
    }
    const service = extractLegacyHostServiceBinding(
      "preflight",
      beforeHistory.versionId,
      beforeVersion,
    );
    // C is the fresh candidate successor of the pinned historical L. Select
    // C's JIT provenance from L's canonical identity, while independently
    // requiring L to carry the explicit historical binding shape.
    const beforeAuthorityProfile = await requireProviderSuccessorAuthorityProfileAt(
      "preflight",
      target,
      state,
      beforeHistory,
      1,
      "historical-pre-jit",
    );
    const before = await inspectRetirementVersionAt(
      "preflight",
      target,
      state,
      beforeHistory,
      service,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
      undefined,
      beforeAuthorityProfile,
    );
    const directPredecessorId = beforeHistory.previousVersionId;
    if (directPredecessorId !== null) {
      const directPredecessor = await readVersionAt(
        "preflight",
        target,
        state,
        directPredecessorId,
      );
      if (!hasMaterializerBinding(directPredecessor)) {
        const restored = await topologyCandidateRestored(
          "preflight",
          target,
          state,
          beforeHistory,
          before,
          selector,
          beforeAuthorityProfile,
        );
        if (invocation.action === "status") {
          return {
            kind: "takoserver.host-runtime-topology-retirement-status@v1",
            surface: invocation.surface,
            environment: invocation.environment,
            selectedCommit: invocation.commit,
            state: "candidate-restored",
            ready: restored.commit === invocation.commit,
            versionId: before.history.versionId,
            previousVersionId: restored.versionId,
            deployedCommit: restored.commit,
            artifactDigest: digestValue(restored.bundleDigestHex),
            service: service.service,
            entrypoint: service.entrypoint,
          };
        }
        throw preflightError(
          "topology retirement requires a fresh authority rebase after candidate restoration",
        );
      }
    }
    await assertPinnedLineage(
      "preflight",
      target,
      state,
      beforeHistory,
      selector,
      1,
      "topology retirement requires the pinned legacy predecessor as the candidate's direct predecessor",
    );
    const predecessor = await requireDirectServicePredecessor(
      "preflight",
      target,
      state,
      beforeHistory,
      historicalAuthorityProfile(target),
    );
    if (predecessor.service !== service.service || predecessor.entrypoint !== service.entrypoint) {
      throw preflightError(
        "topology retirement candidate service identity changed across its direct predecessor",
      );
    }
    if (invocation.action === "status") {
      return {
        kind: "takoserver.host-runtime-topology-retirement-status@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        state: "candidate",
        ready: false,
        versionId: before.history.versionId,
        deployedCommit: before.commit,
        artifactDigest: digestValue(before.bundleDigestHex),
        service: service.service,
        entrypoint: service.entrypoint,
      };
    }
    if (invocation.reverse) {
      throw preflightError(
        "topology retirement reverse requires the retired topology to be current",
      );
    }
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    if (before.commit !== invocation.commit) {
      throw preflightError(
        "topology retirement commit must equal the currently served candidate commit",
      );
    }
    const source = await qualifySource({
      environment: invocation.environment === "integration" ? "integration" : "production",
      commit: invocation.commit,
      run,
    });
    if (source.commit !== before.commit) {
      throw preflightError("topology retirement source commit differs from the served candidate");
    }
    const gate = await run(["bun", "run", "check"]);
    if (gate.exitCode !== 0) {
      throw preflightError(
        `scoped owner gate \`bun run check\` failed (exit ${gate.exitCode})`,
        `${gate.stdout}${gate.stderr}`.trim(),
      );
    }
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      signingKeyId: target.signing.currentKeyId,
      run,
      environment: options.cloudflareEnvironment,
      writeConfig: transitionConfigWriter(
        target,
        source.commit,
        undefined,
        hostedVersionSecrets(target),
      ),
    });
    if (prepared.bundleDigestHex !== before.bundleDigestHex) {
      throw preflightError("topology retirement refuses to change candidate Worker code bytes");
    }
    const artifact = prepared.seal();
    artifact.assertUnchanged();
    const fresh = await assertCurrentRetirementState(
      "preflight",
      target,
      state,
      beforeHistory,
      before,
      service,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
      await requireCurrentAuthorityProfileAt("preflight", target, state, beforeHistory.versionId),
    );
    await assertPinnedLineage(
      "preflight",
      target,
      state,
      fresh.history,
      selector,
      1,
      "topology retirement requires the pinned legacy predecessor as the candidate's direct predecessor",
    );
    const freshPredecessor = await requireDirectServicePredecessor(
      "preflight",
      target,
      state,
      fresh.history,
      historicalAuthorityProfile(target),
    );
    if (
      freshPredecessor.service !== service.service ||
      freshPredecessor.entrypoint !== service.entrypoint
    ) {
      throw preflightError("topology retirement predecessor service changed before mutation");
    }
    const upload = await run(
      wranglerCommand([
        "deploy",
        prepared.bundlePath,
        "--no-bundle",
        "--config",
        prepared.configPath,
        "--strict",
        "--message",
        `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`,
      ]),
      providerOptions(options.cloudflareEnvironment),
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "topology retirement upload acknowledgement is indeterminate; run --status before repair",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }
    const afterHistory = await currentHistory("verification", target, state);
    if (
      afterHistory.versionId === beforeHistory.versionId ||
      afterHistory.previousVersionId !== beforeHistory.versionId
    ) {
      throw verificationError("topology retirement did not create the exact direct successor");
    }
    const after = await inspectRetirementVersionAt(
      "verification",
      target,
      state,
      afterHistory,
      null,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
      undefined,
      provenanceBoundAuthorityProfile(
        "verification",
        target,
        source.commit,
        prepared.bundleDigestHex,
      ),
    );
    if (after.commit !== before.commit || after.bundleDigestHex !== before.bundleDigestHex) {
      throw verificationError(
        "topology retirement successor is not byte-identical to the candidate",
      );
    }
    return {
      kind: "takoserver.host-runtime-topology-retirement-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      state: "topology-retired",
      commit: after.commit,
      reviewer,
      previousVersionId: beforeHistory.versionId,
      versionId: afterHistory.versionId,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      bundleDigest: `sha256:${after.bundleDigestHex}`,
      serviceRemoved: legacyServiceBindingName(),
      secretRetained: HOSTED_SPONSORSHIP_SECRET,
      reverse: {
        surface: "takoserver-host-runtime-topology-retirement",
        exactVersionId: beforeHistory.versionId,
        mode: "provider-history",
      },
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function reverseTopology(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  beforeHistory: WorkerDeploymentHistory,
  before: RetirementLiveWorkerVersion,
  service: LegacyHostServiceBinding,
  reviewer: string,
  root: string,
  options: RetirementOptions,
  candidateVersionId: string | undefined,
  selector: string,
  authorityProfile: WorkerVersionAuthorityProfile | undefined,
): Promise<Record<string, unknown>> {
  const predecessorId = candidateVersionId ?? beforeHistory.previousVersionId;
  if (predecessorId === null) {
    throw preflightError("topology retirement reverse requires the direct candidate predecessor");
  }
  const predecessor = await readVersionAt("preflight", target, state, predecessorId);
  const previous = inspectRetirementVersionAt(
    "preflight",
    target,
    state,
    { ...beforeHistory, versionId: predecessorId },
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
    predecessor,
    authorityProfile,
  );
  const candidate = await previous;
  if (candidate.commit !== before.commit || candidate.bundleDigestHex !== before.bundleDigestHex) {
    throw preflightError("topology retirement reverse predecessor identity is not byte-identical");
  }
  const historicalProfile = historicalAuthorityProfile(target);
  const configPath = writeWorkerConfig(target, {
    path: join(root, "topology-reverse-wrangler.jsonc"),
    main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
    commit: invocation.commit,
    signingKeyId: target.signing.currentKeyId,
    transitionServiceBinding: service,
    transitionExpectedSecrets: hostedVersionSecrets(target),
    ...(historicalProfile === undefined ? {} : { authorityProfile: historicalProfile }),
  });
  const fresh = await assertCurrentRetirementState(
    "preflight",
    target,
    state,
    beforeHistory,
    before,
    null,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
    authorityProfile,
  );
  const freshCandidate = await topologyReverseCandidate(
    "preflight",
    target,
    state,
    fresh.history,
    fresh,
    selector,
    authorityProfile,
  );
  if (freshCandidate.versionId !== predecessorId) {
    throw preflightError("topology retirement reverse candidate changed before mutation");
  }
  if (
    freshCandidate.service.service !== service.service ||
    freshCandidate.service.entrypoint !== service.entrypoint
  ) {
    throw preflightError("topology retirement reverse service changed before mutation");
  }
  const mutation = await run(
    wranglerCommand([
      "versions",
      "deploy",
      `${predecessorId}@100%`,
      "--yes",
      "--name",
      target.workerName,
      "--config",
      configPath,
    ]),
    providerOptions(options.cloudflareEnvironment),
  );
  if (mutation.exitCode !== 0) {
    throw mutationError(
      "topology retirement reverse acknowledgement is indeterminate; run --status before repair",
      `${mutation.stdout}${mutation.stderr}`.trim(),
    );
  }
  const afterHistory = await currentHistory("verification", target, state);
  if (afterHistory.versionId !== predecessorId) {
    throw verificationError("topology retirement reverse did not restore the candidate Version");
  }
  const after = await inspectRetirementVersionAt(
    "verification",
    target,
    state,
    afterHistory,
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
    undefined,
    authorityProfile,
  );
  return {
    kind: "takoserver.host-runtime-topology-retirement-reverse@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    state: "candidate-restored",
    reviewer,
    versionId: after.history.versionId,
    service: service.service,
    entrypoint: service.entrypoint,
    reverse: { mode: "provider-history", exactVersionId: predecessorId },
  };
}

interface AttributionRepairLineage {
  readonly current: RetirementLiveWorkerVersion;
  readonly currentIsRepaired: boolean;
  readonly legacyVersionId: string;
  readonly candidateVersionId: string;
  readonly topologyVersionId: string;
  readonly unattributedVersionId: string;
  readonly service: LegacyHostServiceBinding;
  readonly candidateIdentity: { readonly commit: string; readonly bundleDigestHex: string };
  readonly topologyIdentity: { readonly commit: string; readonly bundleDigestHex: string };
  readonly topologyScriptEtag: string;
  readonly unattributedScriptEtag: string;
  readonly currentScriptEtag: string;
}

/**
 * Repairs the one provider-created Version that secret retirement cannot
 * attribute. Secret deletion is deliberately kept on the token-retirement
 * surface; this surface publishes code only after that authority mutation has
 * already completed and the exact L -> C -> T -> R history is proven.
 */
async function runAttributionRepair(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions,
): Promise<Record<string, unknown>> {
  const selector = requiredPredecessorSelector(invocation);
  const unattributedSelector = requiredUnattributedSuccessorSelector(invocation);
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-attribution-repair-"));
  const temporary = options.outputDirectory === undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const post0043 = await inspectPost0043RetirementLineage(
      "preflight",
      target,
      state,
      selector,
      invocation.commit,
    );
    if (post0043 !== null) {
      return await runPost0043AttributionRepair(
        invocation,
        target,
        state,
        run,
        options,
        root,
        unattributedSelector,
        post0043,
      );
    }
    const beforeHistory = await currentHistory("preflight", target, state);
    const before = await inspectAttributionRepairLineage(
      "preflight",
      target,
      state,
      beforeHistory,
      selector,
      unattributedSelector,
      invocation.action === "apply",
      invocation.commit,
    );
    if (invocation.action === "status") {
      const probe = await probeRetirementProduct(
        target.publicOrigin,
        options.fetcher ?? ((input, init) => fetch(input, init)),
      );
      const finalHistory = await currentHistory("verification", target, state);
      const final = await inspectAttributionRepairLineage(
        "verification",
        target,
        state,
        finalHistory,
        selector,
        unattributedSelector,
        false,
        invocation.commit,
      );
      return attributionRepairStatus(invocation, final, probe);
    }
    if (before.currentIsRepaired) {
      throw preflightError(
        "attribution repair has already created the exact successor; run --status instead of retrying",
      );
    }
    if (before.current.history.versionId !== unattributedSelector) {
      throw preflightError(
        "attribution repair requires the selected unattributed successor to be current",
      );
    }
    if (before.current.commit !== null || before.current.bundleDigestHex !== null) {
      throw preflightError("attribution repair selector is not an unattributed Worker Version");
    }

    const source = await qualifySource({
      environment: invocation.environment === "integration" ? "integration" : "production",
      commit: invocation.commit,
      run,
    });
    const gate = await run(["bun", "run", "check"]);
    if (gate.exitCode !== 0) {
      throw preflightError(
        `scoped owner gate \`bun run check\` failed (exit ${gate.exitCode})`,
        `${gate.stdout}${gate.stderr}`.trim(),
      );
    }
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      signingKeyId: target.signing.currentKeyId,
      run,
      environment: options.cloudflareEnvironment,
      writeConfig: transitionConfigWriter(
        target,
        source.commit,
        undefined,
        baseWorkerSecrets(target),
      ),
    });
    if (prepared.bundleDigestHex !== before.topologyIdentity.bundleDigestHex) {
      throw preflightError(
        "attribution repair refuses to publish bytes different from the trusted topology-retired Version",
      );
    }
    const artifact = prepared.seal();
    artifact.assertUnchanged();
    const freshHistory = await currentHistory("preflight", target, state);
    const fresh = await inspectAttributionRepairLineage(
      "preflight",
      target,
      state,
      freshHistory,
      selector,
      unattributedSelector,
      false,
      invocation.commit,
    );
    if (fresh.currentIsRepaired || fresh.current.history.versionId !== unattributedSelector) {
      throw preflightError("attribution repair Worker changed before mutation");
    }
    if (
      fresh.topologyIdentity.commit !== before.topologyIdentity.commit ||
      fresh.topologyIdentity.bundleDigestHex !== before.topologyIdentity.bundleDigestHex ||
      fresh.topologyScriptEtag !== before.topologyScriptEtag ||
      fresh.unattributedScriptEtag !== before.unattributedScriptEtag
    ) {
      throw preflightError("attribution repair trusted Version changed before mutation");
    }
    const upload = await run(
      wranglerCommand([
        "deploy",
        prepared.bundlePath,
        "--no-bundle",
        "--config",
        prepared.configPath,
        "--strict",
        "--message",
        `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`,
      ]),
      providerOptions(options.cloudflareEnvironment),
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "attribution repair upload acknowledgement is indeterminate; run --status before repair",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }
    const afterHistory = await currentHistory("verification", target, state);
    const after = await inspectAttributionRepairLineage(
      "verification",
      target,
      state,
      afterHistory,
      selector,
      unattributedSelector,
      false,
      source.commit,
      provenanceBoundAuthorityProfile(
        "verification",
        target,
        source.commit,
        prepared.bundleDigestHex,
      ),
    );
    if (
      !after.currentIsRepaired ||
      after.current.history.previousVersionId !== unattributedSelector
    ) {
      throw verificationError(
        "attribution repair did not create the exact direct successor of the selected R Version",
      );
    }
    if (
      after.current.commit !== source.commit ||
      after.current.bundleDigestHex !== prepared.bundleDigestHex ||
      after.currentScriptEtag !== before.topologyScriptEtag
    ) {
      throw verificationError(
        "attribution repair successor is not canonically attributed to the trusted bytes",
      );
    }
    const probe = await probeRetirementProduct(
      target.publicOrigin,
      options.fetcher ?? ((input, init) => fetch(input, init)),
    );
    const finalHistory = await currentHistory("verification", target, state);
    const final = await inspectAttributionRepairLineage(
      "verification",
      target,
      state,
      finalHistory,
      selector,
      unattributedSelector,
      false,
      source.commit,
      provenanceBoundAuthorityProfile(
        "verification",
        target,
        source.commit,
        prepared.bundleDigestHex,
      ),
    );
    if (
      !final.currentIsRepaired ||
      final.current.history.previousVersionId !== unattributedSelector ||
      final.current.commit !== source.commit ||
      final.current.bundleDigestHex !== prepared.bundleDigestHex ||
      final.currentScriptEtag !== before.topologyScriptEtag
    ) {
      throw verificationError(
        "attribution repair final inspection no longer proves the exact A successor",
      );
    }
    return {
      kind: "takoserver.worker-retirement-attribution-repair-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      state: "token-retirement-attribution-repaired",
      commit: source.commit,
      previousVersionId: unattributedSelector,
      versionId: final.current.history.versionId,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      bundleDigest: `sha256:${prepared.bundleDigestHex}`,
      scriptContentIdentity: final.currentScriptEtag,
      probe,
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function runPost0043AttributionRepair(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions,
  root: string,
  unattributedSelector: string,
  before: Post0043RetirementLineage,
): Promise<Record<string, unknown>> {
  if (before.head === "post-parent") {
    throw preflightError("post-0043 attribution repair requires Hosted secret retirement first");
  }
  const expectedUnattributedVersionId =
    before.head === "hosted-retired" ? before.history.versionId : before.hostedRetiredVersionId;
  if (
    expectedUnattributedVersionId === null ||
    expectedUnattributedVersionId !== unattributedSelector
  ) {
    throw preflightError("post-0043 attribution repair selector is not the exact H Version");
  }
  const proofGate = requiredProofGate(invocation, target, state, options, root, run);
  const receiptProofSha256 = await requirePost0043LegacySecretReceipt(
    "preflight",
    proofGate,
    before,
  );
  if (invocation.action === "status") {
    const probe = await probeRetirementProduct(
      target.publicOrigin,
      options.fetcher ?? ((input, init) => fetch(input, init)),
    );
    const final = await inspectPost0043RetirementLineage(
      "verification",
      target,
      state,
      before.legacyVersionId,
      invocation.commit,
    );
    if (
      final === null ||
      final.head !== before.head ||
      final.fingerprint !== before.fingerprint ||
      !sameDeploymentHistory(final.history, before.history)
    ) {
      throw verificationError("post-0043 attribution status changed during final inspection");
    }
    const finalReceiptProofSha256 = await requirePost0043LegacySecretReceipt(
      "verification",
      proofGate,
      final,
    );
    if (finalReceiptProofSha256 !== receiptProofSha256) {
      throw verificationError("post-0043 attribution status changed proof authority");
    }
    return post0043AttributionStatus(invocation, final, probe, finalReceiptProofSha256);
  }
  if (before.head === "attributed") {
    throw preflightError(
      "post-0043 attribution repair has already created the exact A successor; run --status",
    );
  }
  const source = await qualifySource({
    environment: invocation.environment === "integration" ? "integration" : "production",
    commit: invocation.commit,
    run,
  });
  if (source.commit !== before.selectedIdentity.commit) {
    throw preflightError("attribution repair source differs from the exact compatibility exit");
  }
  const gate = await run(["bun", "run", "check"]);
  if (gate.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${gate.exitCode})`,
      `${gate.stdout}${gate.stderr}`.trim(),
    );
  }
  const prepared = await prepareWorkerArtifact({
    root,
    target,
    commit: source.commit,
    signingKeyId: target.signing.currentKeyId,
    run,
    environment: options.cloudflareEnvironment,
    writeConfig: transitionConfigWriter(
      target,
      source.commit,
      undefined,
      baseWorkerSecrets(target),
    ),
  });
  if (prepared.bundleDigestHex !== before.selectedIdentity.bundleDigestHex) {
    throw preflightError(
      "post-0043 attribution repair refuses bytes different from the exact E Version",
    );
  }
  const artifact = prepared.seal();
  artifact.assertUnchanged();
  const fresh = await inspectPost0043RetirementLineage(
    "preflight",
    target,
    state,
    before.legacyVersionId,
    invocation.commit,
  );
  if (
    fresh === null ||
    fresh.head !== "hosted-retired" ||
    fresh.fingerprint !== before.fingerprint ||
    !sameDeploymentHistory(fresh.history, before.history)
  ) {
    throw preflightError("post-0043 H custody prefix changed before attribution repair");
  }
  const freshReceiptProofSha256 = await requirePost0043LegacySecretReceipt(
    "preflight",
    proofGate,
    fresh,
  );
  if (freshReceiptProofSha256 !== receiptProofSha256) {
    throw preflightError("post-0043 attribution repair proof authority changed before upload");
  }
  const upload = await run(
    wranglerCommand([
      "deploy",
      prepared.bundlePath,
      "--no-bundle",
      "--config",
      prepared.configPath,
      "--strict",
      "--message",
      `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`,
    ]),
    providerOptions(options.cloudflareEnvironment),
  );
  if (upload.exitCode !== 0) {
    throw mutationError(
      "attribution repair upload acknowledgement is indeterminate; run --status before repair",
      `${upload.stdout}${upload.stderr}`.trim(),
    );
  }
  const after = await inspectPost0043RetirementLineage(
    "verification",
    target,
    state,
    before.legacyVersionId,
    invocation.commit,
  );
  if (
    after === null ||
    after.head !== "attributed" ||
    after.history.previousVersionId !== unattributedSelector ||
    after.hostedRetiredVersionId !== unattributedSelector ||
    after.currentCommit !== source.commit ||
    after.currentBundleDigestHex !== prepared.bundleDigestHex ||
    !samePost0043Anchors(before, after)
  ) {
    throw verificationError(
      "post-0043 attribution repair did not create the exact A successor of H",
    );
  }
  const afterReceiptProofSha256 = await requirePost0043LegacySecretReceipt(
    "verification",
    proofGate,
    after,
  );
  if (afterReceiptProofSha256 !== receiptProofSha256) {
    throw verificationError("post-0043 attribution repair changed proof authority");
  }
  artifact.assertUnchanged();
  const probe = await probeRetirementProduct(
    target.publicOrigin,
    options.fetcher ?? ((input, init) => fetch(input, init)),
  );
  const final = await inspectPost0043RetirementLineage(
    "verification",
    target,
    state,
    before.legacyVersionId,
    invocation.commit,
  );
  if (
    final === null ||
    final.head !== "attributed" ||
    final.fingerprint !== after.fingerprint ||
    !sameDeploymentHistory(final.history, after.history)
  ) {
    throw verificationError("post-0043 attribution repair final inspection no longer proves A");
  }
  const finalReceiptProofSha256 = await requirePost0043LegacySecretReceipt(
    "verification",
    proofGate,
    final,
  );
  if (finalReceiptProofSha256 !== receiptProofSha256) {
    throw verificationError("post-0043 attribution repair final proof authority changed");
  }
  return {
    kind: "takoserver.worker-retirement-attribution-repair-apply@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    state: "token-retirement-attribution-repaired",
    commit: source.commit,
    previousVersionId: unattributedSelector,
    versionId: final.history.versionId,
    artifactDigest: artifact.digest,
    artifactBytes: artifact.bytes,
    artifactFiles: artifact.files,
    bundleDigest: `sha256:${prepared.bundleDigestHex}`,
    scriptContentIdentity: final.currentScriptEtag,
    sponsorshipCutoverProofSha256: finalReceiptProofSha256,
    probe,
  };
}

function post0043AttributionStatus(
  invocation: RetirementInvocation,
  lineage: Post0043RetirementLineage,
  probe: Awaited<ReturnType<typeof probeRetirementProduct>>,
  proofSha256: string,
): Record<string, unknown> {
  return {
    kind: "takoserver.worker-retirement-attribution-repair-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    state:
      lineage.head === "attributed"
        ? "token-retirement-attribution-repaired"
        : "token-retired-unattributed-successor",
    ready: true,
    repairRequired: false,
    attributionRepairAvailable: lineage.head !== "attributed",
    versionId: lineage.history.versionId,
    previousVersionId: lineage.history.previousVersionId,
    unattributedVersionId: lineage.hostedRetiredVersionId ?? lineage.history.versionId,
    trustedCompatibilityExitVersionId: lineage.executorVersionId,
    trustedCommit: lineage.selectedIdentity.commit,
    trustedArtifactDigest: `sha256:${lineage.selectedIdentity.bundleDigestHex}`,
    deployedCommit: lineage.currentCommit,
    artifactDigest: digestValue(lineage.currentBundleDigestHex),
    scriptContentIdentity: lineage.currentScriptEtag,
    serviceRetired: true,
    secretRetired: true,
    sponsorshipCutoverProofSha256: proofSha256,
    probe,
  };
}

function attributionRepairStatus(
  invocation: RetirementInvocation,
  lineage: AttributionRepairLineage,
  probe: Awaited<ReturnType<typeof probeRetirementProduct>>,
): Record<string, unknown> {
  return {
    kind: "takoserver.worker-retirement-attribution-repair-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    state: lineage.currentIsRepaired
      ? "token-retirement-attribution-repaired"
      : "token-retired-unattributed-successor",
    ready: lineage.currentIsRepaired,
    repairRequired: !lineage.currentIsRepaired,
    versionId: lineage.current.history.versionId,
    previousVersionId: lineage.current.history.previousVersionId,
    unattributedVersionId: lineage.unattributedVersionId,
    trustedTopologyVersionId: lineage.topologyVersionId,
    trustedCommit: lineage.topologyIdentity.commit,
    trustedArtifactDigest: `sha256:${lineage.topologyIdentity.bundleDigestHex}`,
    deployedCommit: lineage.current.commit,
    artifactDigest: digestValue(lineage.current.bundleDigestHex),
    scriptContentIdentity: lineage.currentScriptEtag,
    serviceRetired: true,
    secretRetired: true,
    probe,
  };
}

async function inspectAttributionRepairLineage(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  currentHistoryValue: WorkerDeploymentHistory,
  legacySelector: string,
  unattributedSelector: string,
  requireCurrentSelector: boolean,
  expectedRepairedCommit?: string,
  repairedAuthorityProfile?: WorkerVersionAuthorityProfile,
): Promise<AttributionRepairLineage> {
  const chain = await deploymentChain(phase, target, state);
  if (
    chain[0]?.versionId !== currentHistoryValue.versionId ||
    chain[0]?.deploymentId !== currentHistoryValue.deploymentId
  ) {
    throw phaseError(phase, "retirement deployment history changed during attribution inspection");
  }
  const currentIsUnattributed = chain[0]?.versionId === unattributedSelector;
  const currentIsRepaired = chain[1]?.versionId === unattributedSelector;
  if (!currentIsUnattributed && !currentIsRepaired) {
    throw phaseError(
      phase,
      "attribution repair requires the selected unattributed successor or its exact direct successor",
    );
  }
  if (requireCurrentSelector && !currentIsUnattributed) {
    throw phaseError(
      phase,
      "attribution repair requires the selected unattributed successor to be current",
    );
  }
  const unattributedIndex = currentIsUnattributed ? 0 : 1;
  const topologyIndex = unattributedIndex + 1;
  const candidateIndex = topologyIndex + 1;
  const legacyIndex = candidateIndex + 1;
  const unattributedEntry = chain[unattributedIndex];
  const topologyEntry = chain[topologyIndex];
  const candidateEntry = chain[candidateIndex];
  const legacyEntry = chain[legacyIndex];
  if (
    unattributedEntry === undefined ||
    topologyEntry === undefined ||
    candidateEntry === undefined ||
    legacyEntry === undefined ||
    legacyEntry.versionId !== legacySelector
  ) {
    throw phaseError(phase, "attribution repair requires the pinned L-to-C-to-T-to-R lineage");
  }
  assertUniqueLineage(phase, chain, legacyIndex);
  if (
    currentHistoryValue.previousVersionId !==
    (currentIsUnattributed ? topologyEntry.versionId : unattributedSelector)
  ) {
    throw phaseError(
      phase,
      "attribution repair current Version has an unexpected direct predecessor",
    );
  }
  const legacyVersion = await readVersionAt(phase, target, state, legacyEntry.versionId);
  const candidateVersion = await readVersionAt(phase, target, state, candidateEntry.versionId);
  const topologyVersion = await readVersionAt(phase, target, state, topologyEntry.versionId);
  const unattributedVersion = await readVersionAt(
    phase,
    target,
    state,
    unattributedEntry.versionId,
  );
  const service = extractLegacyHostServiceBinding(phase, legacyEntry.versionId, legacyVersion);
  const candidateService = extractLegacyHostServiceBinding(
    phase,
    candidateEntry.versionId,
    candidateVersion,
  );
  if (
    candidateService.service !== service.service ||
    candidateService.entrypoint !== service.entrypoint
  ) {
    throw phaseError(
      phase,
      "attribution repair service identity changed across the pinned lineage",
    );
  }
  assertRetirementVersionShape(
    phase,
    target,
    state,
    legacyEntry.versionId,
    legacyVersion,
    service,
    hostedVersionSecrets(target),
    historicalAuthorityProfile(target),
  );
  assertRetirementVersionShape(
    phase,
    target,
    state,
    candidateEntry.versionId,
    candidateVersion,
    service,
    hostedVersionSecrets(target),
    historicalAuthorityProfile(target),
  );
  assertRetirementVersionShape(
    phase,
    target,
    state,
    topologyEntry.versionId,
    topologyVersion,
    null,
    hostedVersionSecrets(target),
    historicalAuthorityProfile(target),
  );
  assertRetirementVersionShape(
    phase,
    target,
    state,
    unattributedEntry.versionId,
    unattributedVersion,
    null,
    baseWorkerSecrets(target),
    historicalAuthorityProfile(target),
  );
  if (hasWorkersMessage(unattributedVersion)) {
    throw phaseError(phase, "selected R Version must have no workers/message annotation");
  }
  const candidateIdentity = versionIdentity(candidateVersion);
  const topologyIdentity = versionIdentity(topologyVersion);
  if (candidateIdentity === null || topologyIdentity === null) {
    throw phaseError(phase, "attribution repair requires canonical C and T annotations");
  }
  if (
    candidateIdentity.commit !== topologyIdentity.commit ||
    candidateIdentity.bundleDigestHex !== topologyIdentity.bundleDigestHex
  ) {
    throw phaseError(phase, "attribution repair C and T code identities differ");
  }
  const topologyScriptEtag = workerVersionScriptContentIdentity(
    phase,
    topologyEntry.versionId,
    topologyVersion,
  );
  const unattributedScriptEtag = workerVersionScriptContentIdentity(
    phase,
    unattributedEntry.versionId,
    unattributedVersion,
  );
  if (topologyScriptEtag !== unattributedScriptEtag) {
    throw phaseError(phase, "attribution repair R script content differs from trusted T");
  }
  const currentVersion =
    currentHistoryValue.versionId === unattributedEntry.versionId
      ? unattributedVersion
      : await readVersionAt(phase, target, state, currentHistoryValue.versionId);
  const current = await inspectRetirementVersionAt(
    phase,
    target,
    state,
    currentHistoryValue,
    null,
    baseWorkerSecrets(target),
    baseWorkerSecrets(target),
    currentVersion,
    currentIsRepaired
      ? (repairedAuthorityProfile ??
          requireCurrentAuthorityProfile(
            phase,
            target,
            currentHistoryValue.versionId,
            currentVersion,
          ))
      : historicalAuthorityProfile(target),
  );
  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    baseWorkerSecrets(target),
    phase,
  );
  await assertLiveWorkerRoutingClosure(phase, target, state);
  const historyAfterCurrent = await currentHistory(phase, target, state);
  if (!sameDeploymentHistory(historyAfterCurrent, currentHistoryValue)) {
    throw phaseError(
      phase,
      "attribution repair deployment history changed during closure inspection",
    );
  }
  const currentScriptEtag = workerVersionScriptContentIdentity(
    phase,
    currentHistoryValue.versionId,
    currentVersion,
  );
  if (currentScriptEtag !== topologyScriptEtag) {
    throw phaseError(phase, "attribution repair current script content differs from trusted T");
  }
  if (
    currentIsUnattributed &&
    (current.commit !== null ||
      current.bundleDigestHex !== null ||
      hasWorkersMessage(currentVersion))
  ) {
    throw phaseError(phase, "selected R Version is not the missing-annotation direct successor");
  }
  if (
    currentIsRepaired &&
    (current.bundleDigestHex !== topologyIdentity.bundleDigestHex ||
      (expectedRepairedCommit !== undefined && current.commit !== expectedRepairedCommit))
  ) {
    throw phaseError(phase, "attribution repair successor has an unexpected canonical identity");
  }
  return {
    current,
    currentIsRepaired,
    legacyVersionId: legacyEntry.versionId,
    candidateVersionId: candidateEntry.versionId,
    topologyVersionId: topologyEntry.versionId,
    unattributedVersionId: unattributedEntry.versionId,
    service,
    candidateIdentity,
    topologyIdentity,
    topologyScriptEtag,
    unattributedScriptEtag,
    currentScriptEtag,
  };
}

async function runTokenRetirement(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions,
): Promise<Record<string, unknown>> {
  const selector = requiredPredecessorSelector(invocation);
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-token-retirement-"));
  const temporary = options.outputDirectory === undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const post0043 = await inspectPost0043RetirementLineage(
      "preflight",
      target,
      state,
      selector,
      invocation.commit,
    );
    if (post0043 !== null) {
      return await runPost0043TokenRetirement(
        invocation,
        target,
        state,
        run,
        options,
        root,
        post0043,
      );
    }
    const beforeHistory = await currentHistory("preflight", target, state);
    const beforeVersion = await readVersionAt("preflight", target, state, beforeHistory.versionId);
    if (hasMaterializerBinding(beforeVersion)) {
      throw preflightError(
        "Hosted token retirement requires the service topology to be retired first",
      );
    }
    const beforeInventory = await state.workerSecrets(target.workerName);
    const beforeHasToken = inventoryHasSecret(beforeInventory, HOSTED_SPONSORSHIP_SECRET);
    // Token retirement starts from topology-shaped T (direct C predecessor)
    // or a bounded T' restoration on top of R. The direct predecessor's
    // topology shape selects whether the trusted canonical source is one or
    // two lineage positions back; annotations never select the profile.
    const directPredecessorForProfile =
      beforeHistory.previousVersionId === null
        ? undefined
        : await readVersionAt("preflight", target, state, beforeHistory.previousVersionId);
    const trustedAncestorDistance: 1 | 2 =
      beforeHasToken &&
      directPredecessorForProfile !== undefined &&
      !hasMaterializerBinding(directPredecessorForProfile)
        ? 2
        : 1;
    const beforeAuthorityProfile = await requireProviderSuccessorAuthorityProfileAt(
      "preflight",
      target,
      state,
      beforeHistory,
      trustedAncestorDistance,
      "provenance-bound-jit",
    );
    const before = await inspectRetirementVersionAt(
      "preflight",
      target,
      state,
      beforeHistory,
      null,
      beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
      beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
      undefined,
      beforeAuthorityProfile,
    );
    let predecessorService: LegacyHostServiceBinding;
    let directTokenRetirement = false;
    if (beforeHasToken) {
      const directPredecessorId = beforeHistory.previousVersionId;
      if (directPredecessorId === null) {
        throw preflightError("token retirement requires one direct candidate predecessor");
      }
      const directPredecessor = await readVersionAt(
        "preflight",
        target,
        state,
        directPredecessorId,
      );
      if (hasMaterializerBinding(directPredecessor)) {
        await assertPinnedLineage(
          "preflight",
          target,
          state,
          beforeHistory,
          selector,
          2,
          "token retirement requires the pinned legacy predecessor behind the candidate topology",
        );
        predecessorService = await requireDirectServicePredecessor(
          "preflight",
          target,
          state,
          beforeHistory,
          beforeAuthorityProfile,
        );
        directTokenRetirement = true;
      } else {
        // An external secret restoration can create T' on top of the already
        // retired R. Status may reconcile that bounded extension, but another
        // forward/delete must first restore the topology and establish a fresh
        // direct chain.
        const candidate = await topologyReverseCandidate(
          "preflight",
          target,
          state,
          beforeHistory,
          before,
          selector,
          beforeAuthorityProfile,
        );
        predecessorService = candidate.service;
        if (invocation.action !== "status") {
          throw preflightError(
            "Hosted token retirement requires topology reverse before another token transition",
          );
        }
      }
    } else {
      predecessorService = await requireDirectTopologyPredecessor(
        "preflight",
        target,
        state,
        beforeHistory,
        before,
        selector,
        beforeAuthorityProfile,
      );
    }
    await assertPinnedSelectorVersion("preflight", target, state, selector, predecessorService);
    if (invocation.action === "status") {
      const unattributed = before.commit === null || before.bundleDigestHex === null;
      const proofSha256 = beforeHasToken
        ? undefined
        : await optionalProofGate(invocation, target, state, options, root, run)?.settle(
            "legacy-secret-retirement",
            before.history.versionId,
          );
      if (!beforeHasToken && proofSha256 === undefined) {
        throw preflightError(
          "terminal sponsorship secret-retirement status requires the current sponsorship cutover proof",
        );
      }
      return {
        kind: "takoserver.hosted-token-retirement-status@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        state: beforeHasToken
          ? unattributed
            ? "topology-retired-unattributed-successor"
            : "topology-retired"
          : unattributed
            ? "token-retired-unattributed-successor"
            : "token-retired",
        ready: !beforeHasToken && !unattributed && before.commit === invocation.commit,
        repairRequired: unattributed,
        versionId: before.history.versionId,
        deployedCommit: before.commit,
        artifactDigest: digestValue(before.bundleDigestHex),
        secretPresent: beforeHasToken,
        serviceRetired: true,
        predecessorService: predecessorService.service,
        predecessorEntrypoint: predecessorService.entrypoint,
        ...(proofSha256 === undefined ? {} : { sponsorshipCutoverProofSha256: proofSha256 }),
      };
    }
    if (beforeHasToken && !directTokenRetirement) {
      throw preflightError(
        "Hosted token retirement requires topology reverse before another token transition",
      );
    }
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    const proofGate = requiredProofGate(invocation, target, state, options, root, run);
    const proof = await proofGate.authorize("legacy-secret-retirement");
    const historicalProfile = historicalAuthorityProfile(target);
    const configPath = writeWorkerConfig(target, {
      path: join(root, "token-retirement-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
      signingKeyId: target.signing.currentKeyId,
      transitionExpectedSecrets: hostedVersionSecrets(target),
      ...(historicalProfile === undefined ? {} : { authorityProfile: historicalProfile }),
    });
    if (!beforeHasToken) {
      throw preflightError("Hosted token retirement requires the legacy secret to be present");
    }
    if (before.commit !== invocation.commit) {
      throw preflightError(
        "Hosted token retirement commit must equal the currently served candidate",
      );
    }
    const fresh = await assertCurrentRetirementState(
      "preflight",
      target,
      state,
      beforeHistory,
      before,
      null,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
      beforeAuthorityProfile,
    );
    await assertPinnedLineage(
      "preflight",
      target,
      state,
      fresh.history,
      selector,
      2,
      "token retirement requires the pinned legacy predecessor behind the candidate topology",
    );
    const freshPredecessorService = await requireDirectServicePredecessor(
      "preflight",
      target,
      state,
      fresh.history,
      beforeAuthorityProfile,
    );
    if (
      freshPredecessorService.service !== predecessorService.service ||
      freshPredecessorService.entrypoint !== predecessorService.entrypoint
    ) {
      throw preflightError("token retirement predecessor service changed before mutation");
    }
    await assertPinnedSelectorVersion(
      "preflight",
      target,
      state,
      selector,
      freshPredecessorService,
    );
    if (before.commit === null || before.bundleDigestHex === null) {
      throw preflightError("Hosted token retirement requires an exact candidate identity");
    }
    const started = await proofGate.begin(proof, {
      sourceCommit: before.commit,
      bundleSha256: `sha256:${before.bundleDigestHex}`,
      configSha256: digestFile(configPath),
    });
    if (!started.fresh) {
      throw preflightError(
        "sponsorship cutover start already exists; apply is forbidden and only status reconciliation is allowed",
      );
    }
    const mutation = await started.executionClaim.execute(
      async () =>
        await run(
          wranglerCommand([
            "secret",
            "delete",
            HOSTED_SPONSORSHIP_SECRET,
            "--name",
            target.workerName,
            "--config",
            configPath,
          ]),
          providerOptions(options.cloudflareEnvironment),
        ),
    );
    if (mutation.exitCode !== 0) {
      throw mutationError(
        "Hosted token retirement acknowledgement is indeterminate; run --status before repair",
        `${mutation.stdout}${mutation.stderr}`.trim(),
      );
    }
    const afterHistory = await currentHistory("verification", target, state);
    if (
      afterHistory.versionId === beforeHistory.versionId ||
      afterHistory.previousVersionId !== beforeHistory.versionId
    ) {
      throw verificationError("Hosted token retirement did not create the exact direct successor");
    }
    const afterVersion = await readVersionAt("verification", target, state, afterHistory.versionId);
    const afterAuthorityProfile = successorAuthorityProfile(
      "verification",
      target,
      before.commit === null || before.bundleDigestHex === null
        ? null
        : { commit: before.commit, bundleDigestHex: before.bundleDigestHex },
    );
    const after = await inspectRetirementVersionAt(
      "verification",
      target,
      state,
      afterHistory,
      null,
      baseWorkerSecrets(target),
      baseWorkerSecrets(target),
      afterVersion,
      afterAuthorityProfile,
    );
    if (after.commit !== before.commit || after.bundleDigestHex !== before.bundleDigestHex) {
      throw verificationError("Hosted token retirement changed the served code identity");
    }
    await proofGate.complete(proof, after.history.versionId);
    return {
      kind: "takoserver.hosted-token-retirement-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      state: "token-retired",
      reviewer,
      versionId: after.history.versionId,
      previousVersionId: beforeHistory.versionId,
      commit: after.commit,
      secretRemoved: HOSTED_SPONSORSHIP_SECRET,
      sponsorshipCutoverProofSha256: proof.proofSha256,
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function runPost0043TokenRetirement(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions,
  root: string,
  before: Post0043RetirementLineage,
): Promise<Record<string, unknown>> {
  if (invocation.action === "status") {
    let proofSha256: string | undefined;
    if (before.head === "post-parent") {
      proofSha256 = await requiredProofGate(
        invocation,
        target,
        state,
        options,
        root,
        run,
      ).settlePreexistingRouteRemoval(before.parentVersionId);
    } else {
      proofSha256 = await requirePost0043LegacySecretReceipt(
        "preflight",
        requiredProofGate(invocation, target, state, options, root, run),
        before,
      );
    }
    return {
      kind: "takoserver.hosted-token-retirement-status@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      state:
        before.head === "post-parent"
          ? proofSha256 === undefined
            ? "preexisting-topology-retired-unsettled"
            : "preexisting-topology-retired"
          : before.head === "hosted-retired"
            ? "token-retired-unattributed-successor"
            : "token-retirement-attribution-repaired",
      ready: before.head !== "post-parent" && proofSha256 !== undefined,
      canApply: before.head === "post-parent" && proofSha256 !== undefined,
      repairRequired: false,
      attributionRepairAvailable: before.head === "hosted-retired",
      versionId: before.history.versionId,
      previousVersionId: before.history.previousVersionId,
      deployedCommit: before.currentCommit,
      trustedCommit: before.selectedIdentity.commit,
      artifactDigest: digestValue(before.selectedIdentity.bundleDigestHex),
      secretPresent: before.head === "post-parent",
      serviceRetired: true,
      predecessorService: before.service.service,
      predecessorEntrypoint: before.service.entrypoint,
      observedPreexistingTopologyRetirement: true,
      ...(proofSha256 === undefined ? {} : { sponsorshipCutoverProofSha256: proofSha256 }),
    };
  }
  if (before.head !== "post-parent") {
    throw preflightError("post-0043 Hosted sponsorship secret is already absent; run --status");
  }

  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const proofGate = requiredProofGate(invocation, target, state, options, root, run);
  const routeProof = await proofGate.settlePreexistingRouteRemoval(before.parentVersionId);
  if (routeProof === undefined) {
    throw preflightError(
      "Hosted token retirement requires the current proof's preexisting route-removal settlement",
    );
  }
  const proof = await proofGate.authorize("legacy-secret-retirement");
  const authorityProfile = provenanceBoundAuthorityProfile(
    "preflight",
    target,
    before.selectedIdentity.commit,
    before.selectedIdentity.bundleDigestHex,
  );
  const configPath = writeWorkerConfig(target, {
    path: join(root, "post-0043-token-retirement-wrangler.jsonc"),
    main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
    commit: invocation.commit,
    signingKeyId: target.signing.currentKeyId,
    transitionExpectedSecrets: hostedVersionSecrets(target),
    ...(authorityProfile === undefined ? {} : { authorityProfile }),
  });
  const fresh = await inspectPost0043RetirementLineage(
    "preflight",
    target,
    state,
    before.legacyVersionId,
    invocation.commit,
  );
  if (
    fresh === null ||
    fresh.head !== "post-parent" ||
    fresh.fingerprint !== before.fingerprint ||
    !sameDeploymentHistory(fresh.history, before.history)
  ) {
    throw preflightError("post-0043 custody prefix changed before Hosted secret retirement");
  }
  const started = await proofGate.begin(proof, {
    sourceCommit: before.selectedIdentity.commit,
    bundleSha256: `sha256:${before.selectedIdentity.bundleDigestHex}`,
    configSha256: digestFile(configPath),
  });
  if (!started.fresh) {
    throw preflightError(
      "sponsorship cutover start already exists; apply is forbidden and only status reconciliation is allowed",
    );
  }
  const mutation = await started.executionClaim.execute(
    async () =>
      await run(
        wranglerCommand([
          "secret",
          "delete",
          HOSTED_SPONSORSHIP_SECRET,
          "--name",
          target.workerName,
          "--config",
          configPath,
        ]),
        providerOptions(options.cloudflareEnvironment),
      ),
  );
  if (mutation.exitCode !== 0) {
    throw mutationError(
      "Hosted token retirement acknowledgement is indeterminate; run --status before repair",
      `${mutation.stdout}${mutation.stderr}`.trim(),
    );
  }
  const after = await inspectPost0043RetirementLineage(
    "verification",
    target,
    state,
    before.legacyVersionId,
    invocation.commit,
  );
  if (
    after === null ||
    after.head !== "hosted-retired" ||
    after.hostedRetiredVersionId !== after.history.versionId ||
    after.parentVersionId !== before.parentVersionId ||
    after.history.previousVersionId !== before.parentVersionId ||
    !samePost0043Anchors(before, after)
  ) {
    throw verificationError("Hosted token retirement did not create the exact H successor of P");
  }
  await proofGate.completePost0043LegacySecretRetirement(proof, {
    hostedRetiredVersionId: after.history.versionId,
    parentVersionId: after.parentVersionId,
    executorVersionId: after.executorVersionId,
  });
  return {
    kind: "takoserver.hosted-token-retirement-apply@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    state: "token-retired-unattributed-successor",
    reviewer,
    versionId: after.history.versionId,
    previousVersionId: before.history.versionId,
    commit: null,
    secretRemoved: HOSTED_SPONSORSHIP_SECRET,
    repairRequired: false,
    attributionRepairAvailable: true,
    sponsorshipCutoverProofSha256: proof.proofSha256,
  };
}

function requiredProofGate(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  options: RetirementOptions,
  root: string,
  run: RetirementProcess,
): SponsorshipCutoverProofGate {
  return (
    options.proofGate ??
    createSponsorshipCutoverProofGate({
      target,
      environment: invocation.environment,
      state: sponsorshipProofState(state),
      database: consumptionDatabase(target, options, root, run),
    })
  );
}

function optionalProofGate(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  options: RetirementOptions,
  root: string,
  run: RetirementProcess,
): SponsorshipCutoverProofGate | undefined {
  if (options.proofGate) return options.proofGate;
  return sponsorshipCutoverProofConfigured()
    ? createSponsorshipCutoverProofGate({
        target,
        environment: invocation.environment,
        state: sponsorshipProofState(state),
        database: consumptionDatabase(target, options, root, run),
      })
    : undefined;
}

function consumptionDatabase(
  target: DeployTarget,
  options: RetirementOptions,
  root: string,
  run: RetirementProcess,
): SponsorshipCutoverConsumptionDatabase {
  if (options.cutoverConsumptionDatabase) return options.cutoverConsumptionDatabase;
  const configPath = writeSponsorshipCutoverConsumptionConfig(
    join(root, "sponsorship-cutover-consumption-wrangler.jsonc"),
    target,
  );
  return createRemoteSponsorshipCutoverConsumptionDatabase(
    configPath,
    options.cloudflareEnvironment ?? {},
    run,
  );
}

function sponsorshipProofState(state: RetirementState): SponsorshipCutoverProofState {
  const candidate = state as RetirementState & Partial<SponsorshipCutoverProofState>;
  if (
    typeof candidate.workerScripts !== "function" ||
    typeof candidate.workerRoutes !== "function" ||
    typeof candidate.workerSubdomain !== "function" ||
    typeof candidate.workerTopologyAudit !== "function"
  ) {
    throw preflightError(
      "sponsorship cutover requires exhaustive Worker and Cloudflare topology state reads",
    );
  }
  return candidate as SponsorshipCutoverProofState;
}

function transitionConfigWriter(
  target: DeployTarget,
  commit: string,
  serviceBinding: LegacyHostServiceBinding | undefined,
  expectedSecrets: readonly string[],
): (input: {
  readonly path: string;
  readonly main: string;
  readonly bundleDigestHex?: string;
}) => string {
  return (input) => {
    const historicalProfile = historicalAuthorityProfile(target);
    const config: WorkerConfigOptions = {
      ...input,
      commit,
      signingKeyId: target.signing.currentKeyId,
      transitionExpectedSecrets: expectedSecrets,
      ...(input.bundleDigestHex === undefined
        ? historicalProfile === undefined
          ? {}
          : { authorityProfile: historicalProfile }
        : {
            authorityProfile: {
              kind: "provenance-bound-jit" as const,
              provenance: {
                sourceCommit: commit,
                artifactDigest: `sha256:${input.bundleDigestHex}` as const,
              },
            },
          }),
      ...(serviceBinding === undefined ? {} : { transitionServiceBinding: serviceBinding }),
    };
    return writeWorkerConfig(target, config);
  };
}

async function inspectRetirementVersionAt(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  history: WorkerDeploymentHistory,
  expectedServiceBinding: LegacyHostServiceBinding | null,
  expectedVersionSecrets: readonly string[],
  expectedInventorySecrets: readonly string[],
  versionOverride?: unknown,
  authorityProfile?: WorkerVersionAuthorityProfile,
): Promise<RetirementLiveWorkerVersion> {
  const resolvedAuthorityProfile = requireExplicitAuthorityProfile(phase, target, authorityProfile);
  if (versionOverride !== undefined) {
    assertRetirementVersionShape(
      phase,
      target,
      state,
      history.versionId,
      versionOverride,
      expectedServiceBinding,
      expectedVersionSecrets,
      resolvedAuthorityProfile,
    );
    const identity = versionIdentity(versionOverride);
    return {
      history,
      commit: identity?.commit ?? null,
      bundleDigestHex: identity?.bundleDigestHex ?? null,
      serviceBinding: expectedServiceBinding,
      hostedTokenPresent: expectedInventorySecrets.includes(HOSTED_SPONSORSHIP_SECRET),
    };
  }
  return await inspectLiveWorkerVersionForRetirement(phase, target, state, {
    expectedServiceBinding,
    expectedSecrets: expectedVersionSecrets,
    expectedInventorySecrets,
    signingKeyId: target.signing.currentKeyId,
    ...(resolvedAuthorityProfile === undefined
      ? {}
      : { authorityProfile: resolvedAuthorityProfile }),
  });
}

/**
 * Re-reads the authoritative current Version and its closure immediately
 * before a retirement mutation. Provider APIs do not expose a CAS token, so
 * comparing every returned history identity is the fail-closed serialization
 * boundary available to this command.
 */
async function assertCurrentRetirementState(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  expectedHistory: WorkerDeploymentHistory,
  expected: RetirementLiveWorkerVersion,
  expectedServiceBinding: LegacyHostServiceBinding | null,
  expectedVersionSecrets: readonly string[],
  expectedInventorySecrets: readonly string[],
  authorityProfile?: WorkerVersionAuthorityProfile,
): Promise<RetirementLiveWorkerVersion> {
  const freshHistory = await currentHistory(phase, target, state);
  if (!sameDeploymentHistory(freshHistory, expectedHistory)) {
    throw phaseError(phase, "retirement Worker changed before mutation");
  }
  const fresh = await inspectRetirementVersionAt(
    phase,
    target,
    state,
    freshHistory,
    expectedServiceBinding,
    expectedVersionSecrets,
    expectedInventorySecrets,
    undefined,
    authorityProfile,
  );
  if (!sameDeploymentHistory(fresh.history, expectedHistory)) {
    throw phaseError(phase, "retirement Worker changed during pre-mutation inspection");
  }
  if (fresh.commit !== expected.commit || fresh.bundleDigestHex !== expected.bundleDigestHex) {
    throw phaseError(phase, "retirement Worker code identity changed before mutation");
  }
  if (fresh.hostedTokenPresent !== expected.hostedTokenPresent) {
    throw phaseError(phase, "retirement Worker secret state changed before mutation");
  }
  return fresh;
}

function sameDeploymentHistory(
  left: WorkerDeploymentHistory,
  right: WorkerDeploymentHistory,
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.versionId === right.versionId &&
    left.previousVersionId === right.previousVersionId
  );
}

function assertRetirementVersionShape(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  versionId: string,
  version: unknown,
  expectedServiceBinding: LegacyHostServiceBinding | null,
  expectedSecrets: readonly string[],
  authorityProfile?: WorkerVersionAuthorityProfile,
): void {
  const identity = versionIdentity(version);
  const resolvedAuthorityProfile = requireExplicitAuthorityProfile(phase, target, authorityProfile);
  assertExactVersionBindingClosure(
    phase,
    versionId,
    version,
    expectedTransitionBindingClosure(target, {
      serviceBinding: expectedServiceBinding,
      expectedSecrets,
      metadataProfile: metadataProfileForVersion(phase, versionId, version),
      signingKeyId: target.signing.currentKeyId,
      ...(resolvedAuthorityProfile === undefined
        ? {}
        : { authorityProfile: resolvedAuthorityProfile }),
      ...(identity === null
        ? {}
        : {
            ...(resolvedAuthorityProfile === undefined
              ? {
                  provenance: {
                    sourceCommit: identity.commit,
                    artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
                  },
                }
              : {}),
          }),
    }),
  );
  void state;
}

function metadataProfileForVersion(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
): "current" | "pre-version-metadata" {
  if (
    !isRecord(version) ||
    !isRecord(version.resources) ||
    !Array.isArray(version.resources.bindings)
  ) {
    throw phaseError(phase, `version ${versionId} has no canonical binding inventory`);
  }
  const nodes = version.resources.bindings.filter(
    (entry) =>
      isRecord(entry) && (entry.name === "WORKER_VERSION" || entry.binding === "WORKER_VERSION"),
  );
  if (nodes.length > 1) {
    throw phaseError(phase, `version ${versionId} declares WORKER_VERSION more than once`);
  }
  return nodes.length === 0 ? "pre-version-metadata" : "current";
}

async function readVersionAt(
  _phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  versionId: string,
): Promise<unknown> {
  return await state.workerVersion(target.workerName, versionId);
}

function requireExplicitAuthorityProfile(
  phase: DeployPhase,
  target: DeployTarget,
  authorityProfile: WorkerVersionAuthorityProfile | undefined,
): WorkerVersionAuthorityProfile | undefined {
  if (target.integrationE2eCredentialAuthority !== undefined && authorityProfile === undefined) {
    throw phaseError(
      phase,
      "JIT-enabled retirement inspection requires an explicit authority profile",
    );
  }
  return authorityProfile;
}

function requireCurrentAuthorityProfile(
  phase: DeployPhase,
  target: DeployTarget,
  versionId: string,
  version: unknown,
): WorkerVersionAuthorityProfile | undefined {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  const shape = workerVersionAuthorityBindingShape(phase, versionId, version);
  if (shape !== "provenance-bound-jit") {
    throw phaseError(
      phase,
      `version ${versionId} must carry the complete provenance-bound JIT authority profile`,
    );
  }
  const identity = versionIdentity(version);
  if (identity === null) {
    throw phaseError(
      phase,
      `version ${versionId} has JIT authority bindings without canonical provenance`,
    );
  }
  return {
    kind: "provenance-bound-jit",
    provenance: {
      sourceCommit: identity.commit,
      artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
    },
  };
}

function historicalAuthorityProfile(
  target: DeployTarget,
): WorkerVersionAuthorityProfile | undefined {
  return target.integrationE2eCredentialAuthority === undefined
    ? undefined
    : { kind: "historical-pre-jit" };
}

function provenanceBoundAuthorityProfile(
  phase: DeployPhase,
  target: DeployTarget,
  commit: string | null,
  bundleDigestHex: string | null,
): WorkerVersionAuthorityProfile | undefined {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  if (commit === null || bundleDigestHex === null) {
    throw phaseError(
      phase,
      "JIT authority profile requires a trusted canonical predecessor identity",
    );
  }
  return {
    kind: "provenance-bound-jit",
    provenance: {
      sourceCommit: commit,
      artifactDigest: `sha256:${bundleDigestHex}` as const,
    },
  };
}

async function requireCurrentAuthorityProfileAt(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  versionId: string,
): Promise<WorkerVersionAuthorityProfile | undefined> {
  return requireCurrentAuthorityProfile(
    phase,
    target,
    versionId,
    await readVersionAt(phase, target, state, versionId),
  );
}

/**
 * Selects the JIT profile for a provider-created successor from its already
 * proven canonical predecessor. The successor itself is never inspected to
 * decide whether it may omit the profile; the exact closure check consumes
 * this profile and rejects any historical or partial shape.
 */
async function requireProviderSuccessorAuthorityProfileAt(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  history: WorkerDeploymentHistory,
  trustedAncestorDistance: 1 | 2 = 1,
  trustedAncestorProfile: WorkerVersionAuthorityBindingShape = "provenance-bound-jit",
): Promise<WorkerVersionAuthorityProfile | undefined> {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  const chain = await deploymentChain(phase, target, state);
  if (
    chain[0]?.versionId !== history.versionId ||
    chain[0]?.deploymentId !== history.deploymentId
  ) {
    throw phaseError(
      phase,
      "retirement deployment history changed while selecting authority profile",
    );
  }
  const predecessorId = chain[trustedAncestorDistance]?.versionId;
  if (predecessorId === undefined) {
    throw phaseError(phase, "provider-created successor has no trusted canonical predecessor");
  }
  const predecessor = await readVersionAt(phase, target, state, predecessorId);
  const actualProfile = workerVersionAuthorityBindingShape(phase, predecessorId, predecessor);
  if (actualProfile !== trustedAncestorProfile) {
    throw phaseError(
      phase,
      `retirement trusted ancestor ${predecessorId} has ${actualProfile} authority bindings; expected ${trustedAncestorProfile}`,
    );
  }
  const identity = versionIdentity(predecessor);
  if (identity === null) {
    throw phaseError(
      phase,
      `retirement trusted ancestor ${predecessorId} has no canonical provenance`,
    );
  }
  return {
    kind: "provenance-bound-jit",
    provenance: {
      sourceCommit: identity.commit,
      artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
    },
  };
}

function successorAuthorityProfile(
  phase: DeployPhase,
  target: DeployTarget,
  predecessor: { readonly commit: string; readonly bundleDigestHex: string } | null,
): WorkerVersionAuthorityProfile | undefined {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  if (predecessor === null) {
    throw phaseError(
      phase,
      "token retirement successor requires a trusted predecessor identity for JIT authority",
    );
  }
  return {
    kind: "provenance-bound-jit",
    provenance: {
      sourceCommit: predecessor.commit,
      artifactDigest: `sha256:${predecessor.bundleDigestHex}` as const,
    },
  };
}

async function currentHistory(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
): Promise<WorkerDeploymentHistory> {
  const history = parseWorkerDeploymentHistory(await state.workerDeployments(target.workerName));
  if (history === null) throw phaseError(phase, "Worker has no authoritative current deployment");
  return history;
}

function hostedVersionSecrets(target: DeployTarget): readonly string[] {
  return workerSecretsForLegacyCustody(target, "post-parent");
}

function baseWorkerSecrets(target: DeployTarget): readonly string[] {
  return workerSecretsForLegacyCustody(target, "base");
}

function fullLegacyCustodySecrets(target: DeployTarget): readonly string[] {
  return workerSecretsForLegacyCustody(target, "full");
}

type Post0043RetirementHead = "post-parent" | "hosted-retired" | "attributed";

interface Post0043RetirementLineage {
  readonly head: Post0043RetirementHead;
  readonly history: WorkerDeploymentHistory;
  readonly currentCommit: string | null;
  readonly currentBundleDigestHex: string | null;
  readonly selectedIdentity: { readonly commit: string; readonly bundleDigestHex: string };
  readonly currentScriptEtag: string;
  readonly service: LegacyHostServiceBinding;
  readonly parentVersionId: string;
  readonly hostedRetiredVersionId: string | null;
  readonly executorVersionId: string;
  readonly quiescedCurrentVersionId: string;
  readonly quiescedRollbackVersionId: string;
  readonly topologyVersionId: string;
  readonly candidateVersionId: string;
  readonly legacyVersionId: string;
  readonly fingerprint: string;
}

async function requirePost0043LegacySecretReceipt(
  phase: DeployPhase,
  proofGate: SponsorshipCutoverProofGate,
  lineage: Post0043RetirementLineage,
): Promise<string> {
  const hostedRetiredVersionId =
    lineage.head === "hosted-retired" ? lineage.history.versionId : lineage.hostedRetiredVersionId;
  if (hostedRetiredVersionId === null) {
    throw phaseError(phase, "post-0043 Hosted retirement has no exact H Version");
  }
  const proofSha256 = await proofGate.settlePost0043LegacySecretRetirement({
    hostedRetiredVersionId,
    parentVersionId: lineage.parentVersionId,
    executorVersionId: lineage.executorVersionId,
  });
  if (proofSha256 === undefined) {
    throw phaseError(
      phase,
      "terminal post-0043 secret retirement requires its exact durable receipt",
    );
  }
  return proofSha256;
}

/**
 * Recognizes only the fixed compatibility-exit word:
 *
 *   [A <-] [H <-] P <- E <- K2 <- K1 <- T <- C <- L
 *
 * K1/K2/E are one selected source and script, P/H are the two provider-created
 * secret successors, and the older T/C/L word remains independently exact.
 * This is deliberately separate from the legacy ancestry walkers: new and old
 * source bytes are not compared, and no unbounded history search is allowed.
 */
async function inspectPost0043RetirementLineage(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  legacySelector: string,
  selectedCommit: string,
): Promise<Post0043RetirementLineage | null> {
  if (target.artifactBlobIoMode !== undefined) {
    throw phaseError(phase, "post-0043 retirement requires the normal Worker target");
  }
  // The compatibility exit exists only for a target that selects the provider
  // executor. Preserve the established legacy retirement read sequence for
  // ordinary targets instead of speculatively walking their deployment history.
  if (target.cloudflareProviderExecutor === undefined) return null;
  const chain = await deploymentChain(phase, target, state);
  const currentEntry = chain[0];
  if (currentEntry === undefined) return null;
  const currentVersion = await readVersionAt(phase, target, state, currentEntry.versionId);
  if (!hasNamedBinding(currentVersion, PROVIDER_EXECUTOR_BINDING)) return null;

  const currentCustody = workerLegacySecretCustodyProfile(
    phase,
    versionSecretBindingNames(phase, currentEntry.versionId, currentVersion),
    ["base", "post-parent"],
  );
  const currentAnnotation = workerVersionAnnotationProfile(currentVersion);
  let head: Post0043RetirementHead;
  let parentIndex: 0 | 1 | 2;
  if (currentCustody === "post-parent" && currentAnnotation === "secret-created") {
    head = "post-parent";
    parentIndex = 0;
  } else if (currentCustody === "base" && currentAnnotation === "secret-created") {
    head = "hosted-retired";
    parentIndex = 1;
  } else if (currentCustody === "base" && currentAnnotation === "canonical") {
    head = "attributed";
    parentIndex = 2;
  } else {
    throw phaseError(phase, "post-0043 retirement head has an invalid custody provenance");
  }

  const parentEntry = chain[parentIndex];
  const hostedRetiredEntry = head === "post-parent" ? undefined : chain[parentIndex - 1];
  const executorEntry = chain[parentIndex + 1];
  const quiescedCurrentEntry = chain[parentIndex + 2];
  const quiescedRollbackEntry = chain[parentIndex + 3];
  const topologyEntry = chain[parentIndex + 4];
  const candidateEntry = chain[parentIndex + 5];
  const legacyEntry = chain[parentIndex + 6];
  if (
    parentEntry === undefined ||
    executorEntry === undefined ||
    quiescedCurrentEntry === undefined ||
    quiescedRollbackEntry === undefined ||
    topologyEntry === undefined ||
    candidateEntry === undefined ||
    legacyEntry === undefined ||
    legacyEntry.versionId !== legacySelector
  ) {
    throw phaseError(
      phase,
      "post-0043 retirement requires the exact P-E-K2-K1-T-C-L custody prefix",
    );
  }
  const throughLegacy = chain.slice(0, parentIndex + 7);
  if (
    new Set(throughLegacy.map(({ deploymentId }) => deploymentId)).size !== throughLegacy.length ||
    new Set(throughLegacy.map(({ versionId }) => versionId)).size !== throughLegacy.length
  ) {
    throw phaseError(phase, "post-0043 retirement custody prefix contains a lineage cycle");
  }
  const history = await currentHistory(phase, target, state);
  if (
    history.deploymentId !== currentEntry.deploymentId ||
    history.versionId !== currentEntry.versionId ||
    history.previousVersionId !== chain[1]?.versionId
  ) {
    throw phaseError(phase, "post-0043 retirement history changed during prefix inspection");
  }

  const entries = [
    parentEntry,
    ...(hostedRetiredEntry === undefined ? [] : [hostedRetiredEntry]),
    executorEntry,
    quiescedCurrentEntry,
    quiescedRollbackEntry,
    topologyEntry,
    candidateEntry,
    legacyEntry,
  ];
  const versions = new Map<string, unknown>();
  for (const entry of entries) {
    versions.set(entry.versionId, await readVersionAt(phase, target, state, entry.versionId));
  }
  versions.set(currentEntry.versionId, currentVersion);
  const versionAt = (entry: DeploymentChainEntry): unknown => {
    const version = versions.get(entry.versionId);
    if (version === undefined) {
      throw phaseError(phase, "post-0043 retirement Version readback is incomplete");
    }
    return version;
  };

  const parentVersion = versionAt(parentEntry);
  const executorVersion = versionAt(executorEntry);
  const quiescedCurrentVersion = versionAt(quiescedCurrentEntry);
  const quiescedRollbackVersion = versionAt(quiescedRollbackEntry);
  const topologyVersion = versionAt(topologyEntry);
  const candidateVersion = versionAt(candidateEntry);
  const legacyVersion = versionAt(legacyEntry);
  const hostedRetiredVersion =
    hostedRetiredEntry === undefined ? undefined : versionAt(hostedRetiredEntry);

  assertAnnotationProfile(phase, parentEntry.versionId, parentVersion, "secret-created");
  workerLegacySecretCustodyProfile(
    phase,
    versionSecretBindingNames(phase, parentEntry.versionId, parentVersion),
    ["post-parent"],
  );
  if (hostedRetiredEntry !== undefined && hostedRetiredVersion !== undefined) {
    assertAnnotationProfile(
      phase,
      hostedRetiredEntry.versionId,
      hostedRetiredVersion,
      "secret-created",
    );
    workerLegacySecretCustodyProfile(
      phase,
      versionSecretBindingNames(phase, hostedRetiredEntry.versionId, hostedRetiredVersion),
      ["base"],
    );
  }
  assertAnnotationProfile(phase, executorEntry.versionId, executorVersion, "canonical");
  assertAnnotationProfile(
    phase,
    quiescedCurrentEntry.versionId,
    quiescedCurrentVersion,
    "canonical",
  );
  assertAnnotationProfile(
    phase,
    quiescedRollbackEntry.versionId,
    quiescedRollbackVersion,
    "canonical",
  );
  assertAnnotationProfile(phase, topologyEntry.versionId, topologyVersion, "canonical");
  assertAnnotationProfile(phase, candidateEntry.versionId, candidateVersion, "canonical");
  assertAnnotationProfile(phase, legacyEntry.versionId, legacyVersion, "canonical");

  const executorIdentity = requiredVersionIdentity(phase, executorEntry.versionId, executorVersion);
  const quiescedCurrentIdentity = requiredVersionIdentity(
    phase,
    quiescedCurrentEntry.versionId,
    quiescedCurrentVersion,
  );
  const quiescedRollbackIdentity = requiredVersionIdentity(
    phase,
    quiescedRollbackEntry.versionId,
    quiescedRollbackVersion,
  );
  if (
    executorIdentity.commit !== selectedCommit ||
    quiescedCurrentIdentity.commit !== selectedCommit ||
    quiescedRollbackIdentity.commit !== selectedCommit ||
    executorIdentity.bundleDigestHex !== quiescedCurrentIdentity.bundleDigestHex ||
    executorIdentity.bundleDigestHex !== quiescedRollbackIdentity.bundleDigestHex
  ) {
    throw phaseError(
      phase,
      "post-0043 K1/K2/E Versions do not identify one exact selected artifact",
    );
  }

  const executorAuthority = requireCurrentAuthorityProfile(
    phase,
    target,
    executorEntry.versionId,
    executorVersion,
  );
  const quiescedTarget = { ...target, artifactBlobIoMode: QUIESCED_ARTIFACT_MODE };
  const legacyTarget = withoutProviderExecutor(target);
  assertRetirementVersionShape(
    phase,
    target,
    state,
    executorEntry.versionId,
    executorVersion,
    null,
    fullLegacyCustodySecrets(target),
    executorAuthority,
  );
  assertRetirementVersionShape(
    phase,
    quiescedTarget,
    state,
    quiescedCurrentEntry.versionId,
    quiescedCurrentVersion,
    null,
    fullLegacyCustodySecrets(target),
    requireCurrentAuthorityProfile(
      phase,
      quiescedTarget,
      quiescedCurrentEntry.versionId,
      quiescedCurrentVersion,
    ),
  );
  assertRetirementVersionShape(
    phase,
    quiescedTarget,
    state,
    quiescedRollbackEntry.versionId,
    quiescedRollbackVersion,
    null,
    fullLegacyCustodySecrets(target),
    requireCurrentAuthorityProfile(
      phase,
      quiescedTarget,
      quiescedRollbackEntry.versionId,
      quiescedRollbackVersion,
    ),
  );
  assertRetirementVersionShape(
    phase,
    target,
    state,
    parentEntry.versionId,
    parentVersion,
    null,
    hostedVersionSecrets(target),
    executorAuthority,
  );
  if (hostedRetiredEntry !== undefined && hostedRetiredVersion !== undefined) {
    assertRetirementVersionShape(
      phase,
      target,
      state,
      hostedRetiredEntry.versionId,
      hostedRetiredVersion,
      null,
      baseWorkerSecrets(target),
      executorAuthority,
    );
  }
  if (head === "attributed") {
    const currentIdentity = requiredVersionIdentity(phase, currentEntry.versionId, currentVersion);
    if (
      currentIdentity.commit !== selectedCommit ||
      currentIdentity.bundleDigestHex !== executorIdentity.bundleDigestHex
    ) {
      throw phaseError(phase, "post-0043 attribution Version has an unexpected identity");
    }
    assertRetirementVersionShape(
      phase,
      target,
      state,
      currentEntry.versionId,
      currentVersion,
      null,
      baseWorkerSecrets(target),
      requireCurrentAuthorityProfile(phase, target, currentEntry.versionId, currentVersion),
    );
  }

  const service = extractLegacyHostServiceBinding(phase, legacyEntry.versionId, legacyVersion);
  const candidateService = extractLegacyHostServiceBinding(
    phase,
    candidateEntry.versionId,
    candidateVersion,
  );
  if (
    service.service !== candidateService.service ||
    service.entrypoint !== candidateService.entrypoint
  ) {
    throw phaseError(phase, "post-0043 legacy service identity changed across L and C");
  }
  const candidateAuthority = requireCurrentAuthorityProfile(
    phase,
    legacyTarget,
    candidateEntry.versionId,
    candidateVersion,
  );
  const topologyAuthority = requireCurrentAuthorityProfile(
    phase,
    legacyTarget,
    topologyEntry.versionId,
    topologyVersion,
  );
  assertRetirementVersionShape(
    phase,
    legacyTarget,
    state,
    legacyEntry.versionId,
    legacyVersion,
    service,
    fullLegacyCustodySecrets(target),
    historicalAuthorityProfile(legacyTarget),
  );
  assertRetirementVersionShape(
    phase,
    legacyTarget,
    state,
    candidateEntry.versionId,
    candidateVersion,
    service,
    fullLegacyCustodySecrets(target),
    candidateAuthority,
  );
  assertRetirementVersionShape(
    phase,
    legacyTarget,
    state,
    topologyEntry.versionId,
    topologyVersion,
    null,
    fullLegacyCustodySecrets(target),
    topologyAuthority,
  );
  const candidateIdentity = requiredVersionIdentity(
    phase,
    candidateEntry.versionId,
    candidateVersion,
  );
  const topologyIdentity = requiredVersionIdentity(phase, topologyEntry.versionId, topologyVersion);
  if (
    candidateIdentity.commit !== topologyIdentity.commit ||
    candidateIdentity.bundleDigestHex !== topologyIdentity.bundleDigestHex ||
    workerVersionScriptContentIdentity(phase, candidateEntry.versionId, candidateVersion) !==
      workerVersionScriptContentIdentity(phase, topologyEntry.versionId, topologyVersion)
  ) {
    throw phaseError(phase, "post-0043 C/T legacy code identity changed");
  }

  const selectedScriptEtag = workerVersionScriptContentIdentity(
    phase,
    executorEntry.versionId,
    executorVersion,
  );
  const selectedScriptVersions: Array<{
    readonly entry: DeploymentChainEntry;
    readonly version: unknown;
  }> = [
    { entry: quiescedCurrentEntry, version: quiescedCurrentVersion },
    { entry: quiescedRollbackEntry, version: quiescedRollbackVersion },
    { entry: parentEntry, version: parentVersion },
    ...(hostedRetiredEntry === undefined || hostedRetiredVersion === undefined
      ? []
      : [{ entry: hostedRetiredEntry, version: hostedRetiredVersion }]),
    ...(head === "attributed" ? [{ entry: currentEntry, version: currentVersion }] : []),
  ];
  for (const { entry, version } of selectedScriptVersions) {
    if (
      workerVersionScriptContentIdentity(phase, entry.versionId, version) !== selectedScriptEtag
    ) {
      throw phaseError(phase, "post-0043 custody transition changed served script content");
    }
  }

  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    head === "post-parent" ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
    phase,
  );
  await assertLiveWorkerRoutingClosure(phase, target, state);
  const afterChain = await deploymentChain(phase, target, state);
  if (JSON.stringify(chain) !== JSON.stringify(afterChain)) {
    throw phaseError(phase, "post-0043 retirement history changed during closure inspection");
  }
  const currentIdentity = versionIdentity(currentVersion);
  return {
    head,
    history,
    currentCommit: currentIdentity?.commit ?? null,
    currentBundleDigestHex: currentIdentity?.bundleDigestHex ?? null,
    selectedIdentity: executorIdentity,
    currentScriptEtag: workerVersionScriptContentIdentity(
      phase,
      currentEntry.versionId,
      currentVersion,
    ),
    service,
    parentVersionId: parentEntry.versionId,
    hostedRetiredVersionId: hostedRetiredEntry?.versionId ?? null,
    executorVersionId: executorEntry.versionId,
    quiescedCurrentVersionId: quiescedCurrentEntry.versionId,
    quiescedRollbackVersionId: quiescedRollbackEntry.versionId,
    topologyVersionId: topologyEntry.versionId,
    candidateVersionId: candidateEntry.versionId,
    legacyVersionId: legacyEntry.versionId,
    fingerprint: JSON.stringify({
      head,
      chain: throughLegacy,
      selectedIdentity: executorIdentity,
      selectedScriptEtag,
      service,
    }),
  };
}

function samePost0043Anchors(
  left: Post0043RetirementLineage,
  right: Post0043RetirementLineage,
): boolean {
  return (
    left.selectedIdentity.commit === right.selectedIdentity.commit &&
    left.selectedIdentity.bundleDigestHex === right.selectedIdentity.bundleDigestHex &&
    left.currentScriptEtag === right.currentScriptEtag &&
    left.parentVersionId === right.parentVersionId &&
    left.executorVersionId === right.executorVersionId &&
    left.quiescedCurrentVersionId === right.quiescedCurrentVersionId &&
    left.quiescedRollbackVersionId === right.quiescedRollbackVersionId &&
    left.topologyVersionId === right.topologyVersionId &&
    left.candidateVersionId === right.candidateVersionId &&
    left.legacyVersionId === right.legacyVersionId &&
    left.service.service === right.service.service &&
    left.service.entrypoint === right.service.entrypoint
  );
}

function assertAnnotationProfile(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  expected: "canonical" | "secret-created",
): void {
  if (workerVersionAnnotationProfile(version) !== expected) {
    throw phaseError(phase, `post-0043 Version ${versionId} does not have ${expected} provenance`);
  }
}

function requiredVersionIdentity(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
): { readonly commit: string; readonly bundleDigestHex: string } {
  const identity = versionIdentity(version);
  if (identity === null) {
    throw phaseError(phase, `post-0043 Version ${versionId} has no canonical identity`);
  }
  return identity;
}

function withoutProviderExecutor(target: DeployTarget): DeployTarget {
  const {
    artifactBlobIoMode: ignoredMode,
    cloudflareProviderExecutor: ignoredExecutor,
    ...legacy
  } = target;
  void ignoredMode;
  void ignoredExecutor;
  return legacy;
}

function hasNamedBinding(version: unknown, name: string): boolean {
  if (
    !isRecord(version) ||
    !isRecord(version.resources) ||
    !Array.isArray(version.resources.bindings)
  ) {
    return false;
  }
  return version.resources.bindings.some(
    (entry) => isRecord(entry) && (entry.name === name || entry.binding === name),
  );
}

function hasSecretBinding(version: unknown, name: string): boolean {
  if (
    !isRecord(version) ||
    !isRecord(version.resources) ||
    !Array.isArray(version.resources.bindings)
  ) {
    return false;
  }
  return version.resources.bindings.some(
    (entry) =>
      isRecord(entry) &&
      (entry.name === name || entry.binding === name) &&
      entry.type === "secret_text",
  );
}

function hasMaterializerBinding(version: unknown): boolean {
  if (
    !isRecord(version) ||
    !isRecord(version.resources) ||
    !Array.isArray(version.resources.bindings)
  ) {
    return false;
  }
  return version.resources.bindings.some(
    (entry) =>
      isRecord(entry) &&
      (entry.name === legacyServiceBindingName() || entry.binding === legacyServiceBindingName()),
  );
}

function inventoryHasSecret(inventory: readonly unknown[], name: string): boolean {
  return inventory.some((entry) => isRecord(entry) && entry.name === name);
}

async function requireDirectServicePredecessor(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  history: WorkerDeploymentHistory,
  authorityProfile?: WorkerVersionAuthorityProfile,
): Promise<LegacyHostServiceBinding> {
  const predecessorId = history.previousVersionId;
  if (predecessorId === null) {
    throw phaseError(phase, "retirement requires one direct candidate predecessor");
  }
  const predecessor = await readVersionAt(phase, target, state, predecessorId);
  const service = extractLegacyHostServiceBinding(phase, predecessorId, predecessor);
  await inspectRetirementVersionAt(
    phase,
    target,
    state,
    { ...history, versionId: predecessorId },
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
    predecessor,
    authorityProfile,
  );
  return service;
}

async function assertPinnedSelectorVersion(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  selector: string,
  service: LegacyHostServiceBinding,
): Promise<void> {
  const predecessor = await readVersionAt(phase, target, state, selector);
  assertRetirementVersionShape(
    phase,
    target,
    state,
    selector,
    predecessor,
    service,
    hostedVersionSecrets(target),
    historicalAuthorityProfile(target),
  );
}

/** Verifies the topology-retired Version immediately before token retirement. */
async function requireDirectTopologyPredecessor(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  history: WorkerDeploymentHistory,
  current: RetirementLiveWorkerVersion,
  selector: string,
  authorityProfile: WorkerVersionAuthorityProfile | undefined,
): Promise<LegacyHostServiceBinding> {
  await assertPinnedLineage(
    phase,
    target,
    state,
    history,
    selector,
    3,
    "token retirement requires the pinned legacy predecessor behind the retired topology",
  );
  const predecessorId = history.previousVersionId;
  if (predecessorId === null) {
    throw phaseError(phase, "token retirement requires one direct topology predecessor");
  }
  const predecessor = await readVersionAt(phase, target, state, predecessorId);
  if (hasMaterializerBinding(predecessor)) {
    throw phaseError(phase, "token retirement direct predecessor still carries the Hosted service");
  }
  const predecessorIdentity = versionIdentity(predecessor);
  if (
    current.commit !== null &&
    current.bundleDigestHex !== null &&
    (predecessorIdentity === null ||
      predecessorIdentity.commit !== current.commit ||
      predecessorIdentity.bundleDigestHex !== current.bundleDigestHex)
  ) {
    throw phaseError(phase, "token retirement topology predecessor identity changed");
  }
  assertRetirementVersionShape(
    phase,
    target,
    state,
    predecessorId,
    predecessor,
    null,
    hasSecretBinding(predecessor, HOSTED_SPONSORSHIP_SECRET)
      ? hostedVersionSecrets(target)
      : baseWorkerSecrets(target),
    authorityProfile,
  );
  const candidate = await topologyReverseCandidate(
    phase,
    target,
    state,
    history,
    current,
    selector,
    authorityProfile,
  );
  return candidate.service;
}

interface TopologyReverseCandidate {
  readonly versionId: string;
  readonly version: unknown;
  readonly service: LegacyHostServiceBinding;
  readonly commit: string | null;
  readonly bundleDigestHex: string | null;
}

/**
 * Finds the candidate code Version for topology reverse. An external secret
 * restoration can create T' as a new Version, so the candidate is no longer
 * the immediate deployment predecessor. The only accepted ancestry is the bounded
 * L -> C -> T -> R chain (or its token-reverse T' -> R extension); every
 * intervening Version must carry the exact semantic binding/secret shape.
 * The walk is capped at the known four-edge suffix and never scans older
 * provider history for a shape that merely happens to look like a candidate.
 */
async function topologyReverseCandidate(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  currentHistory: WorkerDeploymentHistory,
  current: RetirementLiveWorkerVersion,
  selector: string,
  authorityProfile: WorkerVersionAuthorityProfile | undefined,
): Promise<TopologyReverseCandidate> {
  const chain = await deploymentChain(phase, target, state);
  if (
    chain[0]?.versionId !== currentHistory.versionId ||
    chain[0]?.deploymentId !== currentHistory.deploymentId
  ) {
    throw phaseError(phase, "retirement deployment history changed during predecessor inspection");
  }
  const first = chain[1];
  if (first === undefined) {
    throw phaseError(phase, "retirement requires one direct candidate predecessor");
  }

  let candidateIndex: 1 | 2 | 3;
  const firstVersion = await readVersionAt(phase, target, state, first.versionId);
  if (hasMaterializerBinding(firstVersion)) {
    if (!current.hostedTokenPresent) {
      throw phaseError(phase, "token-retired topology has no direct topology predecessor");
    }
    candidateIndex = 1;
  } else if (current.hostedTokenPresent) {
    // R' -> R -> T -> C -> L after external secret restoration. The current
    // Version is topology-shaped again, while its direct predecessor is
    // token-shaped.
    await assertReverseAncestor(
      phase,
      target,
      state,
      current,
      chain,
      1,
      false,
      "topology retirement reverse contains an unrelated token predecessor",
      authorityProfile,
    );
    await assertReverseAncestor(
      phase,
      target,
      state,
      current,
      chain,
      2,
      true,
      "topology retirement reverse contains an unrelated topology predecessor",
      authorityProfile,
    );
    candidateIndex = 3;
  } else {
    // R -> T -> C -> L after token retirement.
    await assertReverseAncestor(
      phase,
      target,
      state,
      current,
      chain,
      1,
      true,
      "token-retired topology has an unrelated direct predecessor",
      authorityProfile,
    );
    candidateIndex = 2;
  }

  const candidateEntry = chain[candidateIndex];
  if (candidateEntry === undefined || chain[candidateIndex + 1]?.versionId !== selector) {
    throw phaseError(
      phase,
      "retirement candidate is not the direct successor of the pinned legacy predecessor",
    );
  }
  assertUniqueLineage(phase, chain, candidateIndex + 1);
  const version = await readVersionAt(phase, target, state, candidateEntry.versionId);
  const identity = versionIdentity(version);
  if (
    current.commit !== null &&
    current.bundleDigestHex !== null &&
    (identity === null ||
      identity.commit !== current.commit ||
      identity.bundleDigestHex !== current.bundleDigestHex)
  ) {
    throw phaseError(phase, "retirement predecessor identity changed across a direct successor");
  }
  const service = extractLegacyHostServiceBinding(phase, candidateEntry.versionId, version);
  assertRetirementVersionShape(
    phase,
    target,
    state,
    candidateEntry.versionId,
    version,
    service,
    hostedVersionSecrets(target),
    authorityProfile,
  );
  const selectorVersion = await readVersionAt(phase, target, state, selector);
  assertRetirementVersionShape(
    phase,
    target,
    state,
    selector,
    selectorVersion,
    service,
    hostedVersionSecrets(target),
    historicalAuthorityProfile(target),
  );
  return {
    versionId: candidateEntry.versionId,
    version,
    service,
    commit: identity?.commit ?? null,
    bundleDigestHex: identity?.bundleDigestHex ?? null,
  };
}

/**
 * Reconciles a topology reverse that already became current before its
 * acknowledgement was lost. The current candidate is the C' head of either
 * bounded rollback suffix C' -> T -> C -> P or
 * C' -> T' -> R -> T -> C -> P. This is intentionally a separate classifier
 * from topologyReverseCandidate: the latter starts at a retired topology head
 * (T, R, or T'), whereas this branch starts after provider history has
 * restored a service-bearing candidate.
 */
async function topologyCandidateRestored(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  currentHistory: WorkerDeploymentHistory,
  current: RetirementLiveWorkerVersion,
  selector: string,
  authorityProfile: WorkerVersionAuthorityProfile | undefined,
): Promise<TopologyReverseCandidate> {
  const chain = await deploymentChain(phase, target, state);
  if (
    chain[0]?.versionId !== currentHistory.versionId ||
    chain[0]?.deploymentId !== currentHistory.deploymentId
  ) {
    throw phaseError(phase, "retirement deployment history changed during predecessor inspection");
  }
  // Direct topology reverse: C' -> T -> C -> P. The same immutable C may be
  // redeployed as C'; that is the one permitted Version-ID repetition.
  const directCandidateEntry = chain[2];
  if (directCandidateEntry !== undefined) {
    const directCandidate = await readVersionAt(
      phase,
      target,
      state,
      directCandidateEntry.versionId,
    );
    if (hasMaterializerBinding(directCandidate)) {
      if (chain[3]?.versionId !== selector) {
        throw phaseError(
          phase,
          "topology retirement restored candidate is not anchored to the pinned legacy predecessor",
        );
      }
      if (chain[0]?.versionId !== directCandidateEntry.versionId) {
        throw phaseError(
          phase,
          "topology retirement reverse minted an unexpected candidate Version",
        );
      }
      const candidateEntry = directCandidateEntry;
      assertUniqueLineage(phase, chain, 3, [0, 2]);
      await assertReverseAncestor(
        phase,
        target,
        state,
        current,
        chain,
        1,
        true,
        "topology retirement restored candidate contains an unrelated topology predecessor",
        authorityProfile,
      );
      return await readRestoredCandidate(
        phase,
        target,
        state,
        current,
        selector,
        candidateEntry,
        authorityProfile,
      );
    }
  }

  // Full reverse: C' -> T' -> R -> T -> C -> P. T' retained the token, R
  // removed it, and T retained it again before the original candidate C.
  const candidateEntry = chain[4];
  if (candidateEntry === undefined) {
    throw phaseError(phase, "topology retirement reverse minted an unexpected candidate Version");
  }
  if (chain[5]?.versionId !== selector) {
    throw phaseError(
      phase,
      "topology retirement restored candidate is not anchored to the pinned legacy predecessor",
    );
  }
  if (chain[0]?.versionId !== candidateEntry.versionId) {
    throw phaseError(phase, "topology retirement reverse minted an unexpected candidate Version");
  }
  assertUniqueLineage(phase, chain, 5, [0, 4]);
  await assertReverseAncestor(
    phase,
    target,
    state,
    current,
    chain,
    1,
    true,
    "topology retirement restored candidate contains an unrelated token predecessor",
    authorityProfile,
  );
  await assertReverseAncestor(
    phase,
    target,
    state,
    current,
    chain,
    2,
    false,
    "topology retirement restored candidate contains an unrelated retired token Version",
    authorityProfile,
  );
  await assertReverseAncestor(
    phase,
    target,
    state,
    current,
    chain,
    3,
    true,
    "topology retirement restored candidate contains an unrelated topology Version",
    authorityProfile,
  );
  return await readRestoredCandidate(
    phase,
    target,
    state,
    current,
    selector,
    candidateEntry,
    authorityProfile,
  );
}

async function readRestoredCandidate(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  current: RetirementLiveWorkerVersion,
  selector: string,
  candidateEntry: DeploymentChainEntry,
  authorityProfile: WorkerVersionAuthorityProfile | undefined,
): Promise<TopologyReverseCandidate> {
  const version = await readVersionAt(phase, target, state, candidateEntry.versionId);
  const identity = versionIdentity(version);
  if (
    current.commit !== null &&
    current.bundleDigestHex !== null &&
    (identity === null ||
      identity.commit !== current.commit ||
      identity.bundleDigestHex !== current.bundleDigestHex)
  ) {
    throw phaseError(
      phase,
      "retirement restored candidate identity changed across provider history",
    );
  }
  const service = extractLegacyHostServiceBinding(phase, candidateEntry.versionId, version);
  assertRetirementVersionShape(
    phase,
    target,
    state,
    candidateEntry.versionId,
    version,
    service,
    hostedVersionSecrets(target),
    authorityProfile,
  );
  const selectorVersion = await readVersionAt(phase, target, state, selector);
  assertRetirementVersionShape(
    phase,
    target,
    state,
    selector,
    selectorVersion,
    service,
    hostedVersionSecrets(target),
    historicalAuthorityProfile(target),
  );
  return {
    versionId: candidateEntry.versionId,
    version,
    service,
    commit: identity?.commit ?? null,
    bundleDigestHex: identity?.bundleDigestHex ?? null,
  };
}

async function assertReverseAncestor(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  current: RetirementLiveWorkerVersion,
  chain: readonly DeploymentChainEntry[],
  index: number,
  hostedToken: boolean,
  message: string,
  authorityProfile: WorkerVersionAuthorityProfile | undefined,
): Promise<void> {
  const entry = chain[index];
  if (entry === undefined) throw phaseError(phase, message);
  const version = await readVersionAt(phase, target, state, entry.versionId);
  const identity = versionIdentity(version);
  if (
    current.commit !== null &&
    current.bundleDigestHex !== null &&
    (identity === null ||
      identity.commit !== current.commit ||
      identity.bundleDigestHex !== current.bundleDigestHex)
  ) {
    throw phaseError(phase, "retirement predecessor identity changed across a direct successor");
  }
  if (hasMaterializerBinding(version)) throw phaseError(phase, message);
  if (hasSecretBinding(version, HOSTED_SPONSORSHIP_SECRET) !== hostedToken) {
    throw phaseError(phase, message);
  }
  assertRetirementVersionShape(
    phase,
    target,
    state,
    entry.versionId,
    version,
    null,
    hostedToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
    authorityProfile,
  );
}

interface DeploymentChainEntry {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly createdOn: string;
}

async function deploymentChain(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
): Promise<readonly DeploymentChainEntry[]> {
  const raw = await state.workerDeployments(target.workerName);
  const entries = raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.created_on !== "string") {
      throw phaseError(phase, "Worker deployment history contains a malformed retirement entry");
    }
    const parsed = parseWorkerDeploymentHistory([entry]);
    if (parsed === null) {
      throw phaseError(phase, "Worker deployment history contains no Version for retirement");
    }
    if (!isWorkerVersionId(parsed.versionId)) {
      throw phaseError(phase, "Worker deployment history contains an invalid Version ID");
    }
    return {
      deploymentId: parsed.deploymentId,
      versionId: parsed.versionId,
      createdOn: entry.created_on,
    };
  });
  entries.sort((left, right) => right.createdOn.localeCompare(left.createdOn));
  // A provider-history rollback can legitimately surface the same immutable
  // Version more than once under distinct deployments. Deployment identities
  // remain unique and are checked globally; repeated Version IDs are valid
  // rollback history and are classified by their bounded semantic position.
  const deploymentIds = entries.map(({ deploymentId }) => deploymentId);
  if (new Set(deploymentIds).size !== deploymentIds.length) {
    throw phaseError(phase, "Worker deployment history contains duplicate deployment IDs");
  }
  return entries;
}

async function assertPinnedLineage(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  current: WorkerDeploymentHistory,
  selector: string,
  distance: 1 | 2 | 3,
  message: string,
): Promise<void> {
  const chain = await deploymentChain(phase, target, state);
  if (
    chain[0]?.versionId !== current.versionId ||
    chain[0]?.deploymentId !== current.deploymentId
  ) {
    throw phaseError(phase, "retirement deployment history changed during predecessor inspection");
  }
  assertUniqueLineage(phase, chain, distance);
  if (chain[distance]?.versionId !== selector) {
    throw phaseError(phase, message);
  }
}

function assertUniqueLineage(
  phase: DeployPhase,
  chain: readonly DeploymentChainEntry[],
  throughIndex: number,
  allowedVersionRepeat?: readonly [number, number],
): void {
  if (throughIndex > MAX_RETIREMENT_ANCESTRY_DISTANCE) {
    throw phaseError(phase, "retirement lineage exceeds the bounded ancestry depth");
  }
  const deploymentIds = chain.slice(0, throughIndex + 1).map(({ deploymentId }) => deploymentId);
  if (new Set(deploymentIds).size !== deploymentIds.length) {
    throw phaseError(phase, "retirement lineage contains a duplicate deployment");
  }
  const versionIds = chain.slice(0, throughIndex + 1).map(({ versionId }) => versionId);
  for (let left = 0; left < versionIds.length; left += 1) {
    for (let right = left + 1; right < versionIds.length; right += 1) {
      if (versionIds[left] === versionIds[right]) {
        const permitted =
          allowedVersionRepeat !== undefined &&
          ((left === allowedVersionRepeat[0] && right === allowedVersionRepeat[1]) ||
            (left === allowedVersionRepeat[1] && right === allowedVersionRepeat[0]));
        if (!permitted) {
          throw phaseError(phase, "retirement lineage contains an unexpected Version cycle");
        }
      }
    }
  }
}

function versionIdentity(
  value: unknown,
): { readonly commit: string; readonly bundleDigestHex: string } | null {
  if (
    workerVersionAnnotationProfile(value) !== "canonical" ||
    !isRecord(value) ||
    !isRecord(value.annotations)
  ) {
    return null;
  }
  const message = value.annotations["workers/message"];
  if (typeof message !== "string") return null;
  const match = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})(?::[0-9a-f]{64})?$/u.exec(
    message,
  );
  return match?.[1] && match[2] ? { commit: match[1], bundleDigestHex: match[2] } : null;
}

function digestValue(digest: string | null): string | null {
  return digest === null ? null : `sha256:${digest}`;
}

function digestFile(path: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function requiredPredecessorSelector(invocation: RetirementInvocation): string {
  const selector = invocation.legacyHostRuntimePredecessorVersionId;
  if (selector === undefined) {
    throw preflightError(
      `${invocation.surface} requires --legacy-host-runtime-predecessor-version=<uuid>`,
    );
  }
  if (!isWorkerVersionId(selector)) {
    throw preflightError("legacy Host-runtime predecessor Version ID must be one exact UUID");
  }
  return selector;
}

function requiredUnattributedSuccessorSelector(invocation: RetirementInvocation): string {
  const selector = invocation.unattributedSuccessorVersionId;
  if (selector === undefined) {
    throw preflightError(`${invocation.surface} requires --unattributed-successor-version=<uuid>`);
  }
  if (!isWorkerVersionId(selector)) {
    throw preflightError("unattributed successor Version ID must be one exact UUID");
  }
  return selector;
}

function validateInvocation(invocation: RetirementInvocation, target: DeployTarget): void {
  if (target.environment !== invocation.environment) {
    throw preflightError("retirement invocation and target environments differ");
  }
  if (!/^[0-9a-f]{40}$/u.test(invocation.commit)) {
    throw preflightError("retirement invocation requires one exact commit");
  }
  if (invocation.action === "status" && invocation.reverse === true) {
    throw preflightError("retirement --reverse is apply-only");
  }
  if (
    invocation.surface !== "takoserver-worker-authority-cutover" &&
    invocation.surface !== "takoserver-sponsorship-public-route-retirement" &&
    invocation.surface !== "takoserver-host-runtime-topology-retirement" &&
    invocation.surface !== "takoserver-hosted-token-retirement" &&
    invocation.surface !== "takoserver-worker-retirement-attribution-repair" &&
    invocation.legacyHostRuntimePredecessorVersionId !== undefined
  ) {
    throw preflightError("legacy Host-runtime predecessor selector is retirement-only");
  }
  if (
    invocation.surface !== "takoserver-worker-retirement-attribution-repair" &&
    invocation.unattributedSuccessorVersionId !== undefined
  ) {
    throw preflightError("unattributed successor selector is attribution-repair-only");
  }
  if (
    invocation.surface === "takoserver-worker-retirement-attribution-repair" &&
    invocation.reverse === true
  ) {
    throw preflightError("attribution repair does not support --reverse");
  }
  if (invocation.surface === "takoserver-hosted-token-retirement" && invocation.reverse === true) {
    throw preflightError(
      "Hosted token retirement is forward-only; restoration requires a separately reviewed dedicated surface",
    );
  }
  if (
    invocation.surface === "takoserver-worker-retirement-attribution-repair" &&
    invocation.environment !== "integration" &&
    invocation.environment !== "production"
  ) {
    throw preflightError("attribution repair is supported only in integration or production");
  }
  requiredPredecessorSelector(invocation);
  if (invocation.surface === "takoserver-worker-retirement-attribution-repair") {
    requiredUnattributedSuccessorSelector(invocation);
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

function providerOptions(environment: Readonly<Record<string, string>> | undefined): {
  readonly env?: Readonly<Record<string, string>>;
} {
  return environment === undefined ? {} : { env: environment };
}

async function probeRetirementProduct(
  origin: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{
  readonly url: string;
  readonly status: number;
  readonly openapi: { readonly url: string; readonly status: number };
}> {
  const url = `${origin}/.well-known/takoserver`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
      redirect: "error",
    });
  } catch (error) {
    throw verificationError(
      "Worker public product probe failed",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    response.status !== 200 ||
    !isRecord(body) ||
    body.product !== "takoserver" ||
    body.apiVersion !== "v1" ||
    !isRecord(body.endpoints) ||
    body.endpoints.api !== origin ||
    body.endpoints.openapi !== `${origin}/openapi.json`
  ) {
    throw verificationError(
      "Worker public product probe returned the wrong product or origin",
      `status=${response.status}`,
    );
  }
  const openapiUrl = `${origin}/openapi.json`;
  let openapiResponse: Response;
  try {
    openapiResponse = await fetcher(openapiUrl, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
      redirect: "error",
    });
  } catch (error) {
    throw verificationError(
      "Worker OpenAPI probe failed",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  const openapiBody = (await openapiResponse.json().catch(() => null)) as unknown;
  const servers = isRecord(openapiBody) ? openapiBody.servers : null;
  if (
    openapiResponse.status !== 200 ||
    !Array.isArray(servers) ||
    servers.length !== 1 ||
    !isRecord(servers[0]) ||
    servers[0].url !== origin
  ) {
    throw verificationError(
      "Worker OpenAPI server does not match the published origin",
      `status=${openapiResponse.status}`,
    );
  }
  return {
    url,
    status: response.status,
    openapi: { url: openapiUrl, status: openapiResponse.status },
  };
}

function phaseError(phase: DeployPhase, message: string): DeployError {
  return phase === "preflight"
    ? preflightError(message)
    : phase === "mutation"
      ? mutationError(message)
      : verificationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasWorkersMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.annotations) &&
    Object.hasOwn(value.annotations, "workers/message")
  );
}
