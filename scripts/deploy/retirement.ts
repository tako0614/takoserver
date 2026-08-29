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
  isWorkerVersionId,
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
  if (!isWorkerVersionId(selector)) {
    throw preflightError("legacy Host-runtime predecessor Version ID must be one exact UUID");
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
  const selector = requiredPredecessorSelector(invocation);
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
        beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
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
          selector,
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
    const fresh = await assertCurrentRetirementState(
      "preflight",
      target,
      state,
      beforeHistory,
      before,
      service,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
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
  candidateVersionId: string | undefined,
  selector: string,
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
  const fresh = await assertCurrentRetirementState(
    "preflight",
    target,
    state,
    beforeHistory,
    before,
    null,
    hostedVersionSecrets(target),
    hostedVersionSecrets(target),
  );
  const freshCandidate = await topologyReverseCandidate(
    "preflight",
    target,
    state,
    fresh.history,
    fresh,
    selector,
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
  const selector = requiredPredecessorSelector(invocation);
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
      beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
      beforeHasToken ? hostedVersionSecrets(target) : baseWorkerSecrets(target),
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
        );
        directTokenRetirement = true;
      } else {
        // A token reverse creates T' on top of the already retired R. Status
        // may reconcile that bounded extension, but another forward/delete
        // must first restore the topology and establish a fresh direct chain.
        const candidate = await topologyReverseCandidate(
          "preflight",
          target,
          state,
          beforeHistory,
          before,
          selector,
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
      );
    }
    await assertPinnedSelectorVersion("preflight", target, state, selector, predecessorService);
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
    if (beforeHasToken && !directTokenRetirement) {
      throw preflightError(
        "Hosted token retirement requires topology reverse before another token transition",
      );
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
        selector,
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
    const fresh = await assertCurrentRetirementState(
      "preflight",
      target,
      state,
      beforeHistory,
      before,
      null,
      hostedVersionSecrets(target),
      hostedVersionSecrets(target),
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
    const after = await inspectRetirementVersionAt(
      "verification",
      target,
      state,
      afterHistory,
      null,
      baseWorkerSecrets(target),
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
  selector: string,
): Promise<Record<string, unknown>> {
  if (inventoryHasSecret(await state.workerSecrets(target.workerName), HOSTED_SPONSORSHIP_SECRET)) {
    throw preflightError("Hosted token retirement reverse requires the legacy secret to be absent");
  }
  const token = readHostedToken(
    options.tokenPath ?? requireEnvironment("TAKOSERVER_HOSTED_TOKEN_PATH"),
  );
  const fresh = await assertCurrentRetirementState(
    "preflight",
    target,
    state,
    beforeHistory,
    before,
    null,
    baseWorkerSecrets(target),
    baseWorkerSecrets(target),
  );
  await assertPinnedLineage(
    "preflight",
    target,
    state,
    fresh.history,
    selector,
    3,
    "token retirement reverse requires the pinned legacy predecessor behind the retired topology",
  );
  await topologyReverseCandidate("preflight", target, state, fresh.history, fresh, selector);
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
  );
}

/** Verifies the topology-retired Version immediately before token reverse. */
async function requireDirectTopologyPredecessor(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  history: WorkerDeploymentHistory,
  current: RetirementLiveWorkerVersion,
  selector: string,
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
  );
  const candidate = await topologyReverseCandidate(
    phase,
    target,
    state,
    history,
    current,
    selector,
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
 * Finds the candidate code Version for topology reverse. A token reverse
 * creates T' as a new Version, so the candidate is no longer the immediate
 * deployment predecessor. The only accepted ancestry is the bounded
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
    // R' -> R -> T -> C -> L after token reverse. The current Version is
    // topology-shaped again, while its direct predecessor is token-shaped.
    await assertReverseAncestor(
      phase,
      target,
      state,
      current,
      chain,
      1,
      false,
      "topology retirement reverse contains an unrelated token predecessor",
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
      );
      return await readRestoredCandidate(phase, target, state, current, selector, candidateEntry);
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
  );
  return await readRestoredCandidate(phase, target, state, current, selector, candidateEntry);
}

async function readRestoredCandidate(
  phase: DeployPhase,
  target: DeployTarget,
  state: RetirementState,
  current: RetirementLiveWorkerVersion,
  selector: string,
  candidateEntry: DeploymentChainEntry,
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
  if (!isRecord(value) || !isRecord(value.annotations)) return null;
  const message = value.annotations["workers/message"];
  if (typeof message !== "string") return null;
  const match = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u.exec(message);
  return match?.[1] && match[2] ? { commit: match[1], bundleDigestHex: match[2] } : null;
}

function digestValue(digest: string | null): string | null {
  return digest === null ? null : `sha256:${digest}`;
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
    invocation.surface !== "takoserver-host-runtime-topology-retirement" &&
    invocation.surface !== "takoserver-hosted-token-retirement" &&
    invocation.legacyHostRuntimePredecessorVersionId !== undefined
  ) {
    throw preflightError("legacy Host-runtime predecessor selector is retirement-only");
  }
  requiredPredecessorSelector(invocation);
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
