import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { readHostedToken } from "./hosted.ts";
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
  type WorkerConfigOptions,
  writeWorkerConfig,
} from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  inspectLiveWorkerVersionForRetirement,
  type RetirementLiveWorkerVersion,
  type WorkerState,
} from "./worker-live.ts";
import {
  assertExactVersionBindingClosure,
  expectedTransitionBindingClosure,
  extractLegacyHostServiceBinding,
  type LegacyHostServiceBinding,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";

export const HOSTED_SPONSORSHIP_SECRET = "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN" as const;

function legacyServiceBindingName(): string {
  return ["HOST", "RUNTIME", "MATERIALIZER"].join("_");
}

export type RetirementSurface =
  | "takoserver-worker-authority-cutover"
  | "takoserver-host-runtime-topology-retirement"
  | "takoserver-hosted-token-retirement";

export interface RetirementInvocation {
  readonly surface: RetirementSurface;
  readonly action: "status" | "apply";
  readonly reverse?: boolean;
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly legacyHostRuntimePredecessorVersionId?: string;
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
  readonly tokenPath?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
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
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: exactToken(environment),
    });
  const runtimeOptions: RetirementOptions = {
    ...options,
    cloudflareEnvironment: environment,
  };
  if (invocation.surface === "takoserver-worker-authority-cutover") {
    return await runAuthorityTransition(invocation, target, state, run, runtimeOptions);
  }
  if (invocation.surface === "takoserver-host-runtime-topology-retirement") {
    return await runTopologyRetirement(invocation, target, state, run, runtimeOptions);
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
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-authority-transition-"));
  const temporary = options.outputDirectory === undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const current = await currentHistory("preflight", target, state);
    const predecessor = await readVersionAt("preflight", target, state, current.versionId);
    const service = extractLegacyHostServiceBinding("preflight", current.versionId, predecessor);
    if (current.versionId !== selector) {
      if (!invocation.reverse && current.previousVersionId === selector) {
        return await authorityCandidateStatus(invocation, target, state, current, service);
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
      );
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
    const legacy = await inspectRetirementVersionAt(
      "preflight",
      target,
      state,
      current,
      service,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
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
    );
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
    );
    if (after.commit !== source.commit || after.bundleDigestHex !== prepared.bundleDigestHex) {
      throw verificationError(
        "authority transition successor identity differs from the sealed candidate",
      );
    }
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
      reverse: {
        surface: "takoserver-worker-authority-cutover",
        exactVersionId: legacy.history.versionId,
        mode: "provider-history",
      },
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function authorityCandidateStatus(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  history: WorkerDeploymentHistory,
  service: LegacyHostServiceBinding,
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
  );
  const candidate = await inspectRetirementVersionAt(
    "preflight",
    target,
    state,
    history,
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
  );
  if (candidate.commit !== invocation.commit) {
    throw preflightError(
      "authority transition candidate commit does not match the selected commit",
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
  const candidate = await inspectRetirementVersionAt(
    "preflight",
    target,
    state,
    current,
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
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
  );
  const configPath = writeWorkerConfig(target, {
    path: join(root, "retirement-reverse-wrangler.jsonc"),
    main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
    commit: invocation.commit,
    signingKeyId: target.signing.currentKeyId,
    transitionServiceBinding: service,
    transitionExpectedSecrets: hostedVersionSecrets(target),
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
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-topology-retirement-"));
  const temporary = options.outputDirectory === undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const beforeHistory = await currentHistory("preflight", target, state);
    const beforeVersion = await readVersionAt("preflight", target, state, beforeHistory.versionId);
    const topologyPresent = hasMaterializerBinding(beforeVersion);
    if (!topologyPresent) {
      const beforeInventory = await state.workerSecrets(target.workerName);
      const beforeHasToken = inventoryHasSecret(beforeInventory, HOSTED_SPONSORSHIP_SECRET);
      const before = await inspectRetirementVersionAt(
        "preflight",
        target,
        state,
        beforeHistory,
        null,
        versionSecretsForRetiredToken(target, beforeVersion),
        beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
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
      );
    }
    const service = extractLegacyHostServiceBinding(
      "preflight",
      beforeHistory.versionId,
      beforeVersion,
    );
    const before = await inspectRetirementVersionAt(
      "preflight",
      target,
      state,
      beforeHistory,
      service,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
    );
    const predecessor = await requireDirectServicePredecessor(
      "preflight",
      target,
      state,
      beforeHistory,
      before,
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
  candidateVersionId?: string,
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
  );
  const candidate = await previous;
  if (candidate.commit !== before.commit || candidate.bundleDigestHex !== before.bundleDigestHex) {
    throw preflightError("topology retirement reverse predecessor identity is not byte-identical");
  }
  const configPath = writeWorkerConfig(target, {
    path: join(root, "topology-reverse-wrangler.jsonc"),
    main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
    commit: invocation.commit,
    signingKeyId: target.signing.currentKeyId,
    transitionServiceBinding: service,
    transitionExpectedSecrets: hostedVersionSecrets(target),
  });
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

async function runTokenRetirement(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions,
): Promise<Record<string, unknown>> {
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-token-retirement-"));
  const temporary = options.outputDirectory === undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const beforeHistory = await currentHistory("preflight", target, state);
    const beforeVersion = await readVersionAt("preflight", target, state, beforeHistory.versionId);
    if (hasMaterializerBinding(beforeVersion)) {
      throw preflightError(
        "Hosted token retirement requires the service topology to be retired first",
      );
    }
    const beforeInventory = await state.workerSecrets(target.workerName);
    const beforeHasToken = inventoryHasSecret(beforeInventory, HOSTED_SPONSORSHIP_SECRET);
    const before = await inspectRetirementVersionAt(
      "preflight",
      target,
      state,
      beforeHistory,
      null,
      versionSecretsForRetiredToken(target, beforeVersion),
      beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
    );
    const predecessorService = beforeHasToken
      ? await requireDirectServicePredecessor("preflight", target, state, beforeHistory, before)
      : await requireDirectTopologyPredecessor("preflight", target, state, beforeHistory, before);
    if (invocation.action === "status") {
      return {
        kind: "takoserver.hosted-token-retirement-status@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        state: beforeHasToken ? "topology-retired" : "token-retired",
        ready: !beforeHasToken && before.commit === invocation.commit,
        versionId: before.history.versionId,
        deployedCommit: before.commit,
        artifactDigest: digestValue(before.bundleDigestHex),
        secretPresent: beforeHasToken,
        serviceRetired: true,
        predecessorService: predecessorService.service,
        predecessorEntrypoint: predecessorService.entrypoint,
      };
    }
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    const configPath = writeWorkerConfig(target, {
      path: join(root, "token-retirement-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
      signingKeyId: target.signing.currentKeyId,
      transitionExpectedSecrets: hostedVersionSecrets(target),
    });
    if (invocation.reverse) {
      return await reverseToken(
        invocation,
        target,
        state,
        run,
        options,
        beforeHistory,
        before,
        reviewer,
        configPath,
      );
    }
    if (!beforeHasToken) {
      throw preflightError("Hosted token retirement requires the legacy secret to be present");
    }
    if (before.commit !== invocation.commit) {
      throw preflightError(
        "Hosted token retirement commit must equal the currently served candidate",
      );
    }
    const mutation = await run(
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
    const after = await inspectRetirementVersionAt(
      "verification",
      target,
      state,
      afterHistory,
      null,
      versionSecretsForRetiredToken(target, afterVersion),
      baseWorkerSecrets(target),
    );
    if (after.commit !== before.commit || after.bundleDigestHex !== before.bundleDigestHex) {
      throw verificationError("Hosted token retirement changed the served code identity");
    }
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
      reverse: { surface: "takoserver-hosted-token-retirement", mode: "secret-reput" },
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function reverseToken(
  invocation: RetirementInvocation,
  target: DeployTarget,
  state: RetirementState,
  run: RetirementProcess,
  options: RetirementOptions,
  beforeHistory: WorkerDeploymentHistory,
  before: RetirementLiveWorkerVersion,
  reviewer: string,
  configPath: string,
): Promise<Record<string, unknown>> {
  if (inventoryHasSecret(await state.workerSecrets(target.workerName), HOSTED_SPONSORSHIP_SECRET)) {
    throw preflightError("Hosted token retirement reverse requires the legacy secret to be absent");
  }
  const token = readHostedToken(
    options.tokenPath ?? requireEnvironment("TAKOSERVER_HOSTED_TOKEN_PATH"),
  );
  const mutation = await run(
    wranglerCommand([
      "secret",
      "put",
      HOSTED_SPONSORSHIP_SECRET,
      "--name",
      target.workerName,
      "--config",
      configPath,
    ]),
    { ...providerOptions(options.cloudflareEnvironment), input: token },
  );
  if (mutation.exitCode !== 0) {
    throw mutationError(
      "Hosted token retirement reverse acknowledgement is indeterminate; run --status before repair",
      `${mutation.stdout}${mutation.stderr}`.trim(),
    );
  }
  const afterHistory = await currentHistory("verification", target, state);
  if (
    afterHistory.versionId === beforeHistory.versionId ||
    afterHistory.previousVersionId !== beforeHistory.versionId
  ) {
    throw verificationError(
      "Hosted token retirement reverse did not create the exact direct successor",
    );
  }
  const afterVersion = await readVersionAt("verification", target, state, afterHistory.versionId);
  const after = await inspectRetirementVersionAt(
    "verification",
    target,
    state,
    afterHistory,
    null,
    versionSecretsForRetiredToken(target, afterVersion),
    hostedVersionSecrets(target),
  );
  if (after.commit !== before.commit || after.bundleDigestHex !== before.bundleDigestHex) {
    throw verificationError("Hosted token retirement reverse changed the served code identity");
  }
  return {
    kind: "takoserver.hosted-token-retirement-reverse@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    state: "token-restored",
    reviewer,
    versionId: after.history.versionId,
    previousVersionId: beforeHistory.versionId,
    secretRestored: HOSTED_SPONSORSHIP_SECRET,
    reverse: { mode: "secret-reput" },
  };
}

function transitionConfigWriter(
  target: DeployTarget,
  commit: string,
  serviceBinding: LegacyHostServiceBinding | undefined,
  expectedSecrets: readonly string[],
): (input: { readonly path: string; readonly main: string }) => string {
  return (input) => {
    const config: WorkerConfigOptions = {
      ...input,
      commit,
      signingKeyId: target.signing.currentKeyId,
      transitionExpectedSecrets: expectedSecrets,
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
): Promise<RetirementLiveWorkerVersion> {
  if (versionOverride !== undefined) {
    assertRetirementVersionShape(
      phase,
      target,
      state,
      history.versionId,
      versionOverride,
      expectedServiceBinding,
      expectedVersionSecrets,
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
  });
}

function assertRetirementVersionShape(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  versionId: string,
  version: unknown,
  expectedServiceBinding: LegacyHostServiceBinding | null,
  expectedSecrets: readonly string[],
): void {
  assertExactVersionBindingClosure(
    phase,
    versionId,
    version,
    expectedTransitionBindingClosure(target, {
      serviceBinding: expectedServiceBinding,
      expectedSecrets,
      metadataProfile: metadataProfileForVersion(phase, versionId, version),
      signingKeyId: target.signing.currentKeyId,
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
  return [...new Set([...expectedWorkerSecrets(target), HOSTED_SPONSORSHIP_SECRET])].sort();
}

function baseWorkerSecrets(target: DeployTarget): readonly string[] {
  return expectedWorkerSecrets(target).filter((name) => name !== HOSTED_SPONSORSHIP_SECRET);
}

function versionSecretsForRetiredToken(target: DeployTarget, version: unknown): readonly string[] {
  return hasSecretBinding(version, HOSTED_SPONSORSHIP_SECRET)
    ? hostedVersionSecrets(target)
    : baseWorkerSecrets(target);
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
  current: RetirementLiveWorkerVersion,
): Promise<LegacyHostServiceBinding> {
  const predecessorId = history.previousVersionId;
  if (predecessorId === null) {
    throw phaseError(phase, "retirement requires one direct candidate predecessor");
  }
  const predecessor = await readVersionAt(phase, target, state, predecessorId);
  const service = extractLegacyHostServiceBinding(phase, predecessorId, predecessor);
  const previous = await inspectRetirementVersionAt(
    phase,
    target,
    state,
    { ...history, versionId: predecessorId },
    service,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
    predecessor,
  );
  if (
    current.commit !== null &&
    previous.commit !== null &&
    (current.commit !== previous.commit || current.bundleDigestHex !== previous.bundleDigestHex)
  ) {
    throw phaseError(phase, "retirement candidate and direct predecessor identities differ");
  }
  return service;
}

/** Verifies the topology-retired Version immediately before token reverse. */
async function requireDirectTopologyPredecessor(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  history: WorkerDeploymentHistory,
  current: RetirementLiveWorkerVersion,
): Promise<LegacyHostServiceBinding> {
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
  );
  const candidate = await topologyReverseCandidate(phase, target, state, history, current);
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
 * Finds the candidate code Version for topology reverse. A token reverse
 * creates T' as a new Version, so the candidate is no longer the immediate
 * deployment predecessor; every intervening Version must still be the same
 * code identity and carry only the expected service/secret transition shape.
 */
async function topologyReverseCandidate(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  currentHistory: WorkerDeploymentHistory,
  current: RetirementLiveWorkerVersion,
): Promise<TopologyReverseCandidate> {
  const chain = await deploymentChain(phase, target, state);
  if (chain[0]?.versionId !== currentHistory.versionId) {
    throw phaseError(phase, "retirement deployment history changed during predecessor inspection");
  }
  for (let index = 1; index < chain.length; index += 1) {
    const versionId = chain[index]?.versionId;
    if (versionId === undefined) continue;
    const version = await readVersionAt(phase, target, state, versionId);
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
    if (hasMaterializerBinding(version)) {
      const service = extractLegacyHostServiceBinding(phase, versionId, version);
      assertRetirementVersionShape(
        phase,
        target,
        state,
        versionId,
        version,
        service,
        hostedVersionSecrets(target),
      );
      return {
        versionId,
        version,
        service,
        commit: identity?.commit ?? null,
        bundleDigestHex: identity?.bundleDigestHex ?? null,
      };
    }
    // Intervening token/topology Versions are valid only when their binding
    // closure remains the selected target and their secret presence is
    // explicit. This rejects unrelated history instead of guessing a rollback.
    assertRetirementVersionShape(
      phase,
      target,
      state,
      versionId,
      version,
      null,
      hasSecretBinding(version, HOSTED_SPONSORSHIP_SECRET)
        ? hostedVersionSecrets(target)
        : baseWorkerSecrets(target),
    );
  }
  throw phaseError(phase, "retirement requires one direct candidate predecessor");
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
    return {
      deploymentId: parsed.deploymentId,
      versionId: parsed.versionId,
      createdOn: entry.created_on,
    };
  });
  entries.sort((left, right) => right.createdOn.localeCompare(left.createdOn));
  const ids = entries.map((entry) => entry.versionId);
  if (new Set(ids).size !== ids.length) {
    throw phaseError(phase, "Worker deployment history contains duplicate retirement Versions");
  }
  return entries;
}

function versionIdentity(
  value: unknown,
): { readonly commit: string; readonly bundleDigestHex: string } | null {
  if (!isRecord(value) || !isRecord(value.annotations)) return null;
  const message = value.annotations["workers/message"];
  if (typeof message !== "string") return null;
  const match = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u.exec(message);
  return match?.[1] && match[2] ? { commit: match[1], bundleDigestHex: match[2] } : null;
}

function digestValue(digest: string | null): string | null {
  return digest === null ? null : `sha256:${digest}`;
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
    invocation.legacyHostRuntimePredecessorVersionId !== undefined
  ) {
    throw preflightError("legacy Host-runtime predecessor selector is authority-transition-only");
  }
  if (
    invocation.legacyHostRuntimePredecessorVersionId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      invocation.legacyHostRuntimePredecessorVersionId,
    )
  ) {
    throw preflightError("legacy Host-runtime predecessor Version ID must be one exact UUID");
  }
  if (
    invocation.surface === "takoserver-worker-authority-cutover" &&
    invocation.legacyHostRuntimePredecessorVersionId === undefined
  ) {
    throw preflightError(
      "authority transition requires the legacy Host-runtime predecessor selector",
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

function providerOptions(environment: Readonly<Record<string, string>> | undefined): {
  readonly env?: Readonly<Record<string, string>>;
} {
  return environment === undefined ? {} : { env: environment };
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
