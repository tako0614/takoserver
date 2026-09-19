import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPublicHostIdentity, type PublicHostIdentity } from "../../src/public-host-identity.ts";
import {
  derivePublicFormImplementationIdentity,
  publicFormCapabilityManifest,
} from "../../src/public-worker-implementation.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { assertPublicFormCapabilityTarget } from "./form-authority-capability.ts";
import {
  type CommandResult,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import { type DeployTarget, parseDeployTarget, targetPath } from "./target.ts";
import {
  type DescriptorBindingMap,
  planTargetAdoption,
  writeAdoptedTargetCandidate,
} from "./target-adoption.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { inspectLiveWorkerVersion } from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  type ExpectedBindingClosure,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";
import {
  assertServiceBindingRefreshIntegrationOnly,
  type BindingDifference,
  describeBindingDrift,
  surfaceTransitionAdmits,
  type WorkerBindingDrift,
  type WorkerSurfaceTransition,
} from "./worker-surface-transition.ts";

/** Which descriptor field owns each probe binding value; see target-adoption.ts. */
export const IDENTITY_PROBE_DESCRIPTOR_BINDINGS: DescriptorBindingMap = {
  TAKOSERVER_FORM_AUTHORITY_HOST_ID: { field: "text", pointer: "/formAuthority/hostId" },
  FORM_AUTHORITY: { field: "service", pointer: "/formAuthority/workerName" },
};

const PROBE_PATH = "/v1/public-host-identity";
const MAX_PROBE_RESPONSE_BYTES = 16 * 1_024;

/** Internal profile for the first integration probe while Core is absent. */
export const INTEGRATION_HOST_ONLY_PROBE_PROFILE = "integration-host-only" as const;
export type FormAuthorityIdentityProbeProfile = typeof INTEGRATION_HOST_ONLY_PROBE_PROFILE;

export interface FormAuthorityIdentityProbeInvocation {
  readonly surface: "takoserver-form-authority-identity-probe";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  /**
   * Pinned predecessor Version plus the declared difference between its closure
   * and the closure this commit publishes. The probe gained a third binding in
   * one commit; without a name for that difference the live probe can never
   * follow the code that added it.
   */
  readonly transition?: WorkerSurfaceTransition;
  /** `--status` only: absolute path of the candidate descriptor to write. */
  readonly adoptLivePath?: string;
}

export type FormAuthorityIdentityProbeProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface FormAuthorityIdentityProbeState {
  workerScripts(): Promise<readonly string[]>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerSecrets(workerName: string): Promise<readonly unknown[]>;
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
  workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }>;
  workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  >;
}

export interface FormAuthorityIdentityProbeOptions {
  readonly run?: FormAuthorityIdentityProbeProcess;
  readonly state?: FormAuthorityIdentityProbeState;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly review?: string;
  /** Operator-private descriptor path adoption re-reads; defaults to the selected target path. */
  readonly targetDescriptorPath?: string;
}

interface ProbeInspection {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly artifactDigest: `sha256:${string}`;
  /** Whether the live Version is admissible only because a difference was declared. */
  readonly bindingTransitionProfile: "none" | "declared-delta-predecessor";
  readonly drift: readonly BindingDifference[];
  /** Exact profile recognized from the served binding closure, if any. */
  readonly probeProfile: FormAuthorityIdentityProbeProfile | null;
}

export interface PublicIdentityProbeExpectation {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly workerArtifactDigest: `sha256:${string}`;
}

export interface PublicIdentityProbeReadback {
  readonly ready: boolean;
  readonly identity: PublicHostIdentity | null;
}

/** Owns the permanent minimal HTTP-to-PublicHostIdentity RPC bridge. */
export async function runFormAuthorityIdentityProbe(
  invocation: FormAuthorityIdentityProbeInvocation,
  target: DeployTarget,
  options: FormAuthorityIdentityProbeOptions = {},
): Promise<Record<string, unknown>> {
  if (invocation.transition?.delta.storageRebind !== undefined) {
    throw preflightError("Form authority identity probe does not bind STATE_DB or OBJECTS");
  }
  if (invocation.transition !== undefined) {
    assertServiceBindingRefreshIntegrationOnly(
      "preflight",
      invocation.environment,
      invocation.transition.delta,
    );
  }
  assertPublicFormCapabilityTarget(target);
  if (target.environment !== invocation.environment) {
    throw preflightError("Form authority identity probe invocation and target differ");
  }
  const selected = requireProbeTarget(target);
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
  const fetcher = options.fetcher ?? fetch;
  const publicBefore = await inspectPublic("preflight", target, state);
  const authorityWorkerPresent = await isBoundAuthorityWorkerPresent(target, state);
  const completeIntegrationHostOnlyTopology = hasCompleteIntegrationHostOnlyTopology(target);
  const before = await inspectProbe(
    "preflight",
    target,
    state,
    invocation.action,
    invocation.transition,
    undefined,
    completeIntegrationHostOnlyTopology,
  );
  if (
    invocation.environment === "integration" &&
    invocation.transition === undefined &&
    !authorityWorkerPresent &&
    before === null &&
    !completeIntegrationHostOnlyTopology
  ) {
    throw preflightError(
      "integration Host-only identity probe requires the complete Form authority topology",
    );
  }
  const initialHostOnlyProfile =
    invocation.environment === "integration" &&
    invocation.transition === undefined &&
    !authorityWorkerPresent &&
    before === null &&
    completeIntegrationHostOnlyTopology;
  const probeProfile =
    invocation.transition === undefined &&
    (initialHostOnlyProfile ||
      (completeIntegrationHostOnlyTopology &&
        before?.probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE))
      ? INTEGRATION_HOST_ONLY_PROBE_PROFILE
      : null;
  /**
   * Once the first Host-only Version exists, ordinary integration code updates
   * may keep serving that exact closure while Core is still absent. This path
   * is deliberately narrower than bootstrap selection: it requires the
   * complete operator topology, an exact recognized predecessor, no declared
   * closure transition, and the independently read absence of Core.
   */
  const hostOnlyProfilePreservingUpdate =
    invocation.environment === "integration" &&
    invocation.transition === undefined &&
    !authorityWorkerPresent &&
    completeIntegrationHostOnlyTopology &&
    before?.probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE;
  if (
    invocation.action === "apply" &&
    !authorityWorkerPresent &&
    !initialHostOnlyProfile &&
    !hostOnlyProfilePreservingUpdate
  ) {
    throw preflightError(
      `Worker ${selected.authorityWorkerName} named by the probe's FORM_AUTHORITY binding does not ` +
        `exist on account ${target.accountId}; deploy it first with \`bun run deploy -- ` +
        `takoserver-form-authority-worker --apply --environment=${invocation.environment} ` +
        `--commit=${invocation.commit}\``,
    );
  }
  if (
    invocation.action === "apply" &&
    invocation.transition === undefined &&
    (probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE ||
      before?.probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE) &&
    !initialHostOnlyProfile &&
    !hostOnlyProfilePreservingUpdate
  ) {
    throw preflightError(
      "integration Host-only identity probe already exists; its Core binding may be added only " +
        "through the explicit --add-binding=FORM_AUTHORITY transition",
    );
  }
  const readbackBefore =
    before === null
      ? { ready: false, identity: null }
      : await readPublicHostIdentityProbe(target, publicBefore, fetcher);

  if (invocation.action === "status") {
    const drift: readonly WorkerBindingDrift[] =
      before === null
        ? []
        : [
            {
              workerName: selected.workerName,
              versionId: before.history.versionId,
              differences: before.drift,
            },
          ];
    const plan = planTargetAdoption(drift, IDENTITY_PROBE_DESCRIPTOR_BINDINGS);
    const candidate =
      invocation.adoptLivePath === undefined
        ? null
        : writeAdoptedTargetCandidate({
            descriptorPath: options.targetDescriptorPath ?? targetPath(invocation.environment),
            candidatePath: invocation.adoptLivePath,
            environment: invocation.environment,
            plan,
          });
    return {
      ...probeResult({
        kind: "takoserver.form-authority-identity-probe-status@v1",
        invocation,
        selected,
        publicWorker: publicBefore,
        probe: before,
        readback: readbackBefore,
        probeProfile,
        formAuthorityWorkerPresent: authorityWorkerPresent,
        ready: invocation.transition
          ? authorityWorkerPresent &&
            before?.bindingTransitionProfile === "declared-delta-predecessor" &&
            publicBefore.commit === invocation.commit
          : probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE
            ? authorityWorkerPresent === false &&
              before?.probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE &&
              before.commit === invocation.commit &&
              publicBefore.commit === invocation.commit &&
              readbackBefore.ready
            : authorityWorkerPresent &&
              before?.commit === invocation.commit &&
              before.bindingTransitionProfile === "none" &&
              before.drift.length === 0 &&
              publicBefore.commit === invocation.commit &&
              readbackBefore.ready,
      }),
      formAuthorityWorkerName: selected.authorityWorkerName,
      formAuthorityWorkerPresent: authorityWorkerPresent,
      ...(authorityWorkerPresent || initialHostOnlyProfile || hostOnlyProfilePreservingUpdate
        ? {}
        : {
            formAuthorityWorkerRemedy:
              probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE
                ? `bun run deploy -- takoserver-form-authority-worker --apply --environment=` +
                  `${invocation.environment} --commit=${invocation.commit} ` +
                  `--bootstrap-verifier-bridge --bootstrap-probe-predecessor-version=` +
                  `${before?.history.versionId ?? "<host-only-version>"} first, then transition ` +
                  `the Host-only probe with \`bun run deploy -- ` +
                  `takoserver-form-authority-identity-probe --apply --environment=${invocation.environment} ` +
                  `--commit=${invocation.commit} --closure-predecessor-version=` +
                  `${before?.history.versionId ?? "<host-only-version>"} --add-binding=FORM_AUTHORITY\``
                : `deploy takoserver-form-authority-worker --apply --environment=` +
                  `${invocation.environment} --commit=${invocation.commit} first`,
          }),
      bindingTransitionProfile: before?.bindingTransitionProfile ?? null,
      ...(invocation.transition
        ? {
            transitionPredecessorVersionId: invocation.transition.predecessorVersionId,
            transitionDelta: { ...invocation.transition.delta },
          }
        : {}),
      descriptorDrift: drift,
      adoptableFromLive: plan.adopted,
      unadoptableFromLive: plan.refused,
      ...(candidate === null
        ? {}
        : {
            adoptedTargetCandidate: candidate.path,
            adoptedTargetCandidateDigest: candidate.digest,
            adoptedTargetCandidatePatch: candidate.patch,
          }),
    };
  }

  if (invocation.transition) {
    if (before === null) {
      throw preflightError(
        "identity probe forward transition refuses absent or bootstrap topology",
      );
    }
    if (invocation.transition.predecessorVersionId !== before.history.versionId) {
      throw preflightError(
        "authoritative current identity probe Version is not the pinned transition predecessor",
        `expected=${invocation.transition.predecessorVersionId} actual=${before.history.versionId}`,
      );
    }
    if (before.bindingTransitionProfile !== "declared-delta-predecessor") {
      throw preflightError(
        "declared transition is already at the target closure; use the routine invocation",
      );
    }
  }

  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  if (publicBefore.commit !== source.commit) {
    throw preflightError("served public Worker differs from identity probe source commit");
  }
  await checked(run, "scoped identity probe owner gate `bun run check`", ["bun", "run", "check"]);

  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-form-identity-probe-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const publicProof = await prepareWorkerArtifact({
      root: join(root, "public-worker-proof"),
      target,
      commit: source.commit,
      run,
      environment,
    });
    if (`sha256:${publicProof.bundleDigestHex}` !== publicBefore.workerArtifactDigest) {
      throw preflightError(
        "served public Worker artifact differs from identity probe source build",
      );
    }
    const publicArtifact = publicProof.seal();
    publicArtifact.assertUnchanged();
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      run,
      environment,
      main: resolve(REPOSITORY, "src/entry-form-authority-identity-probe.ts"),
      writeConfig: ({ path, main }) =>
        writeProbeConfigInternal({
          path,
          main,
          target,
          ...(probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE
            ? { probeProfile: INTEGRATION_HOST_ONLY_PROBE_PROFILE }
            : {}),
        }),
    });
    const artifactDigest = `sha256:${prepared.bundleDigestHex}` as const;
    const artifact = prepared.seal();
    artifact.assertUnchanged();

    const publicLast = await inspectPublic("preflight", target, state);
    assertSamePublic("preflight", publicBefore, publicLast);
    const last = await inspectProbe(
      "preflight",
      target,
      state,
      invocation.action,
      invocation.transition,
      undefined,
      completeIntegrationHostOnlyTopology,
    );
    assertSameProbe("preflight", before, last);
    const authorityWorkerPresentLast = await isBoundAuthorityWorkerPresent(target, state);
    if (probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE) {
      const hostOnlyProfileStableAtFinalFence = initialHostOnlyProfile
        ? last === null
        : hostOnlyProfilePreservingUpdate &&
          last?.probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE;
      if (!hostOnlyProfileStableAtFinalFence || authorityWorkerPresentLast) {
        throw preflightError(
          initialHostOnlyProfile
            ? "integration Host-only identity probe requires both the probe and released-Core authority " +
                "Workers to remain absent at the final mutation fence"
            : "integration Host-only identity probe requires its existing profile and released-Core " +
                "authority absence to remain stable at the final mutation fence",
        );
      }
    }
    if (probeProfile !== INTEGRATION_HOST_ONLY_PROBE_PROFILE && !authorityWorkerPresentLast) {
      throw preflightError(
        `Worker ${selected.authorityWorkerName} named by the probe's FORM_AUTHORITY binding does ` +
          `not exist on account ${target.accountId}; deploy it first with \`bun run deploy -- ` +
          `takoserver-form-authority-worker --apply --environment=${invocation.environment} ` +
          `--commit=${invocation.commit}\``,
      );
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
        probeMessage(source.commit, artifactDigest),
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "identity probe upload acknowledgement is indeterminate; do not retry before --status",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }

    const publicAfter = await inspectPublic("verification", target, state);
    assertSamePublic("verification", publicBefore, publicAfter);
    const after = await inspectProbe(
      "verification",
      target,
      state,
      "apply",
      undefined,
      probeProfile,
      completeIntegrationHostOnlyTopology,
    );
    if (
      after === null ||
      (probeProfile !== null && after.probeProfile !== probeProfile) ||
      after.bindingTransitionProfile !== "none" ||
      after.drift.length !== 0 ||
      after.history.versionId === before?.history.versionId ||
      (before !== null && after.history.previousVersionId !== before.history.versionId) ||
      after.commit !== source.commit ||
      after.artifactDigest !== artifactDigest
    ) {
      throw verificationError(
        "identity probe authoritative history does not identify the uploaded successor",
      );
    }
    const readback = await readPublicHostIdentityProbe(target, publicAfter, fetcher);
    if (!readback.ready) {
      throw verificationError("identity probe did not return the exact live public RPC identity");
    }
    return {
      ...probeResult({
        kind: "takoserver.form-authority-identity-probe-apply@v1",
        invocation,
        selected,
        publicWorker: publicAfter,
        probe: after,
        readback,
        probeProfile: probeProfile ?? after.probeProfile,
        formAuthorityWorkerPresent: authorityWorkerPresentLast,
        ready: true,
      }),
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      reviewer,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      previousVersionId: before?.history.versionId ?? null,
      formAuthorityWorkerName: selected.authorityWorkerName,
      bindingTransitionProfile: after.bindingTransitionProfile,
      ...(invocation.transition
        ? {
            transitionPredecessorVersionId: invocation.transition.predecessorVersionId,
            transitionDelta: { ...invocation.transition.delta },
          }
        : {}),
      rollback: before
        ? `wrangler versions deploy ${before.history.versionId}@100% --yes --name ${selected.workerName}`
        : "forward repair only: no previous identity probe version exists",
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

export function writeProbeConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly target: DeployTarget;
}): string {
  return writeProbeConfigInternal(input);
}

function writeProbeConfigInternal(input: {
  readonly path: string;
  readonly main: string;
  readonly target: DeployTarget;
  readonly probeProfile?: FormAuthorityIdentityProbeProfile;
}): string {
  const selected = requireProbeTarget(input.target);
  const configuration = {
    account_id: input.target.accountId,
    name: selected.workerName,
    main: input.main,
    compatibility_date: "2026-08-17",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    observability: { enabled: true },
    vars: { TAKOSERVER_FORM_AUTHORITY_HOST_ID: selected.hostId },
    services: [
      {
        binding: "PUBLIC_HOST_IDENTITY",
        service: input.target.workerName,
        entrypoint: "PublicHostIdentityEntrypoint",
      },
      ...(input.probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE
        ? []
        : [
            {
              binding: "FORM_AUTHORITY",
              service: selected.authorityWorkerName,
              entrypoint: "FormAuthorityEntrypoint",
            },
          ]),
    ],
  };
  writeFileSync(input.path, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return input.path;
}

async function inspectPublic(
  phase: DeployPhase,
  target: DeployTarget,
  state: FormAuthorityIdentityProbeState,
): Promise<PublicIdentityProbeExpectation> {
  const live = await inspectLiveWorkerVersion(phase, target, state, {
    authorityProfile: { kind: "provenance-bound-jit" },
  });
  return {
    history: live.history,
    commit: live.commit,
    workerArtifactDigest: `sha256:${live.bundleDigestHex}`,
  };
}

async function inspectProbe(
  phase: DeployPhase,
  target: DeployTarget,
  state: FormAuthorityIdentityProbeState,
  action: "status" | "apply",
  transition?: WorkerSurfaceTransition,
  expectedProfile?: FormAuthorityIdentityProbeProfile | null,
  hostOnlyProfileEligible = false,
): Promise<ProbeInspection | null> {
  const selected = requireProbeTarget(target);
  const scripts = await state.workerScripts();
  if (scripts.length !== new Set(scripts).size) {
    throw phaseError(phase, "identity probe script inventory contains duplicates");
  }
  const domains = await state.workerDomains();
  if (domains.some(({ service }) => service === selected.workerName)) {
    throw phaseError(phase, "identity probe unexpectedly owns a custom domain");
  }
  const routes = (await state.workerRoutes()).filter(
    ({ script }) => script === selected.workerName,
  );
  if (routes.length > 0) throw phaseError(phase, "identity probe unexpectedly owns a zone route");
  if (!scripts.includes(selected.workerName)) return null;
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(selected.workerName),
    phase,
  );
  if (history === null) throw phaseError(phase, "identity probe has no served deployment");
  const version = await state.workerVersion(selected.workerName, history.versionId);
  const identity = probeVersionIdentity(phase, version);
  const fullExpected = probeBindingClosure(target);
  const hostOnlyExpected = probeBindingClosure(target, INTEGRATION_HOST_ONLY_PROBE_PROFILE);
  const fullDrift = describeBindingDrift(phase, history.versionId, version, fullExpected);
  const hostOnlyDrift =
    target.environment === "integration"
      ? describeBindingDrift(phase, history.versionId, version, hostOnlyExpected)
      : [];
  const recognizedProfile =
    hostOnlyProfileEligible && expectedProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE
      ? hostOnlyDrift.length === 0
        ? INTEGRATION_HOST_ONLY_PROBE_PROFILE
        : null
      : hostOnlyProfileEligible && fullDrift.length !== 0 && hostOnlyDrift.length === 0
        ? INTEGRATION_HOST_ONLY_PROBE_PROFILE
        : null;
  const expected =
    expectedProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE ? hostOnlyExpected : fullExpected;
  const drift = expectedProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE ? hostOnlyDrift : fullDrift;
  let bindingTransitionProfile: ProbeInspection["bindingTransitionProfile"] = "none";
  if (drift.length === 0) {
    assertExactVersionBindingClosure(phase, history.versionId, version, expected);
  } else if (
    transition !== undefined &&
    transition.predecessorVersionId === history.versionId &&
    surfaceTransitionAdmits(phase, history.versionId, version, {
      delta: transition.delta,
      environment: target.environment,
      targetClosure: expected,
    })
  ) {
    bindingTransitionProfile = "declared-delta-predecessor";
  } else if (action === "apply" && recognizedProfile === null) {
    // Apply must still fence exactly; this raises the surface's own refusal.
    assertExactVersionBindingClosure(phase, history.versionId, version, expected);
  }
  assertExactSecretInventory(await state.workerSecrets(selected.workerName), [], phase);
  const subdomain = await state.workerSubdomain(selected.workerName);
  if (!subdomain.enabled || subdomain.previewsEnabled) {
    throw phaseError(phase, "identity probe workers.dev topology is not exact");
  }
  return {
    history,
    ...identity,
    bindingTransitionProfile,
    drift,
    probeProfile: recognizedProfile,
  };
}

/** The exact closure one probe Version must serve for the selected target. */
function probeBindingClosure(
  target: DeployTarget,
  profile?: FormAuthorityIdentityProbeProfile,
): ExpectedBindingClosure {
  const selected = requireProbeTarget(target);
  return {
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: {
      type: "plain_text",
      fields: { text: selected.hostId },
    },
    PUBLIC_HOST_IDENTITY: {
      type: "service",
      fields: { service: target.workerName, entrypoint: "PublicHostIdentityEntrypoint" },
    },
    ...(profile === INTEGRATION_HOST_ONLY_PROBE_PROFILE
      ? {}
      : {
          FORM_AUTHORITY: {
            type: "service",
            fields: {
              service: selected.authorityWorkerName,
              entrypoint: "FormAuthorityEntrypoint",
            },
          },
        }),
  };
}

/**
 * The probe binds a Worker it does not own.
 *
 * `FORM_AUTHORITY` names the released-core authority Worker, whose publication
 * belongs to `takoserver-form-authority-worker`. Uploading a probe that binds a
 * script which does not exist would realize a dangling service binding, and a
 * first deploy is not this surface's to perform. So the absence is named, with
 * the surface that owns the remedy, rather than published around.
 */
async function isBoundAuthorityWorkerPresent(
  target: DeployTarget,
  state: FormAuthorityIdentityProbeState,
): Promise<boolean> {
  const selected = requireProbeTarget(target);
  const scripts = await state.workerScripts();
  if (scripts.includes(selected.authorityWorkerName)) return true;
  return false;
}

export async function readPublicHostIdentityProbe(
  target: DeployTarget,
  publicWorker: PublicIdentityProbeExpectation,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<PublicIdentityProbeReadback> {
  const selected = requireProbeTarget(target);
  try {
    const response = await fetcher(`${selected.origin}${PROBE_PATH}`, {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-store" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      return { ready: false, identity: null };
    }
    const bytes = await boundedProbeResponse(response);
    const value = parseStrictJson(bytes, MAX_PROBE_RESPONSE_BYTES);
    if (!isPublicHostIdentity(value)) return { ready: false, identity: null };
    const expected = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: value.implementationPayloadDigest,
      capabilities: publicFormCapabilityManifest(),
    });
    if (
      value.hostId !== selected.hostId ||
      value.workerVersionId !== publicWorker.history.versionId ||
      value.workerArtifactDigest !== publicWorker.workerArtifactDigest ||
      value.capabilityDigest !== expected.capabilityDigest ||
      value.implementationDigest !== expected.implementationDigest
    ) {
      return { ready: false, identity: null };
    }
    return { ready: true, identity: value };
  } catch {
    return { ready: false, identity: null };
  }
}

async function boundedProbeResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_PROBE_RESPONSE_BYTES)) {
    throw new TypeError("identity probe response is too large");
  }
  if (!response.body) throw new TypeError("identity probe response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROBE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TypeError("identity probe response is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function probeResult(input: {
  readonly kind:
    | "takoserver.form-authority-identity-probe-status@v1"
    | "takoserver.form-authority-identity-probe-apply@v1";
  readonly invocation: FormAuthorityIdentityProbeInvocation;
  readonly selected: { readonly workerName: string; readonly origin: string };
  readonly publicWorker: PublicIdentityProbeExpectation;
  readonly probe: ProbeInspection | null;
  readonly readback: PublicIdentityProbeReadback;
  readonly probeProfile: FormAuthorityIdentityProbeProfile | null;
  readonly formAuthorityWorkerPresent: boolean;
  readonly ready: boolean;
}): Record<string, unknown> {
  const coreVerifierConfigured =
    input.probeProfile === INTEGRATION_HOST_ONLY_PROBE_PROFILE ? false : null;
  return {
    kind: input.kind,
    surface: input.invocation.surface,
    environment: input.invocation.environment,
    workerName: input.selected.workerName,
    origin: input.selected.origin,
    selectedCommit: input.invocation.commit,
    deployedCommit: input.probe?.commit ?? null,
    commitMatches: input.probe?.commit === input.invocation.commit,
    deploymentId: input.probe?.history.deploymentId ?? null,
    versionId: input.probe?.history.versionId ?? null,
    previousVersionId: input.probe?.history.previousVersionId ?? null,
    probeArtifactDigest: input.probe?.artifactDigest ?? null,
    publicWorkerCommit: input.publicWorker.commit,
    publicWorkerVersionId: input.publicWorker.history.versionId,
    workerArtifactDigest: input.publicWorker.workerArtifactDigest,
    publicIdentityRpcReady: input.readback.ready,
    implementationPayloadDigest: input.readback.identity?.implementationPayloadDigest ?? null,
    capabilityDigest: input.readback.identity?.capabilityDigest ?? null,
    implementationDigest: input.readback.identity?.implementationDigest ?? null,
    formAuthorityWorkerPresent: input.formAuthorityWorkerPresent,
    probeProfile: input.probeProfile,
    coreVerifierConfigured,
    coreVerifierRpcReady: coreVerifierConfigured,
    profileReady: input.ready,
    ready: input.ready,
  };
}

function requireProbeTarget(target: DeployTarget): {
  readonly workerName: string;
  readonly origin: string;
  readonly hostId: string;
  readonly authorityWorkerName: string;
} {
  const authority = target.formAuthority;
  if (
    authority === undefined ||
    typeof authority.workerName !== "string" ||
    authority.workerName.length === 0 ||
    typeof authority.identityProbeWorkerName !== "string" ||
    authority.identityProbeWorkerName.length === 0 ||
    typeof authority.identityProbeOrigin !== "string" ||
    authority.identityProbeOrigin.length === 0 ||
    typeof authority.hostId !== "string" ||
    authority.hostId.length === 0
  ) {
    throw preflightError("deploy target has incomplete Form authority identity probe topology");
  }
  try {
    const origin = new URL(authority.identityProbeOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    ) {
      throw new TypeError("identity probe origin is not an https origin");
    }
  } catch {
    throw preflightError("deploy target has incomplete Form authority identity probe topology");
  }
  return {
    workerName: authority.identityProbeWorkerName,
    origin: authority.identityProbeOrigin,
    hostId: authority.hostId,
    authorityWorkerName: authority.workerName,
  };
}

/**
 * Host-only bootstrap is an integration-only escape hatch, so its selection
 * must be gated by the complete operator topology it is intended to precede.
 * Runtime target loading normally proves these fields; this guard remains
 * explicit at the deploy surface because tests and private callers may supply
 * an already-typed descriptor without going through that parser.
 */
function hasCompleteIntegrationHostOnlyTopology(target: DeployTarget): boolean {
  if (target.environment !== "integration") return false;
  let validated: DeployTarget;
  try {
    // Reuse target.ts's pure parser for host/origin/name/scope/JWK invariants.
    // Optional supply data is deliberately omitted from this validation
    // projection: capability supply admission already ran above, and this
    // predicate owns only the Form-authority topology needed for profile
    // selection.
    validated = parseDeployTarget(
      {
        kind: target.kind,
        environment: target.environment,
        accountId: target.accountId,
        workerName: target.workerName,
        d1: target.d1,
        r2: target.r2,
        publicOrigin: target.publicOrigin,
        signing: target.signing,
        ...(target.aliases === undefined ? {} : { aliases: target.aliases }),
        formAuthority: target.formAuthority,
      },
      "<identity-probe-host-only-topology>",
      "integration",
    );
  } catch {
    return false;
  }
  const authority = validated.formAuthority;
  const scope = authority?.integrationOperatorScope;
  const operatorJwk = authority?.operatorPublicJwk;
  if (
    authority === undefined ||
    authority.integrationWorkerName === undefined ||
    authority.integrationOperatorWorkerName === undefined ||
    authority.integrationOperatorOrigin === undefined ||
    scope === undefined ||
    operatorJwk === undefined
  ) {
    return false;
  }
  try {
    const publicOrigin = new URL(target.publicOrigin).origin;
    const origin = new URL(authority.integrationOperatorOrigin);
    return (
      origin.protocol === "https:" &&
      origin.username === "" &&
      origin.password === "" &&
      origin.search === "" &&
      origin.hash === "" &&
      !origin.hostname.endsWith(".workers.dev") &&
      origin.origin !== publicOrigin &&
      !(validated.aliases ?? []).includes(origin.hostname)
    );
  } catch {
    return false;
  }
}

function probeVersionIdentity(
  phase: DeployPhase,
  value: unknown,
): { readonly commit: string; readonly artifactDigest: `sha256:${string}` } {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    throw phaseError(phase, "identity probe has no canonical annotations");
  }
  const message = value.annotations["workers/message"];
  const match =
    typeof message === "string"
      ? /^form-authority-identity-probe:([0-9a-f]{40}):(sha256:[0-9a-f]{64})$/u.exec(message)
      : null;
  if (!match?.[1] || !match[2]) {
    throw phaseError(phase, "identity probe version identity is missing or invalid");
  }
  return { commit: match[1], artifactDigest: match[2] as `sha256:${string}` };
}

function probeMessage(commit: string, artifactDigest: `sha256:${string}`): string {
  return `form-authority-identity-probe:${commit}:${artifactDigest}`;
}

function assertSamePublic(
  phase: DeployPhase,
  before: PublicIdentityProbeExpectation,
  after: PublicIdentityProbeExpectation,
): void {
  if (
    before.history.deploymentId !== after.history.deploymentId ||
    before.history.versionId !== after.history.versionId ||
    before.history.previousVersionId !== after.history.previousVersionId ||
    before.commit !== after.commit ||
    before.workerArtifactDigest !== after.workerArtifactDigest
  ) {
    throw phaseError(phase, "public Worker changed during identity probe qualification");
  }
}

function assertSameProbe(
  phase: DeployPhase,
  before: ProbeInspection | null,
  after: ProbeInspection | null,
): void {
  if (
    (before === null) !== (after === null) ||
    (before !== null &&
      after !== null &&
      (before.history.deploymentId !== after.history.deploymentId ||
        before.history.versionId !== after.history.versionId ||
        before.commit !== after.commit ||
        before.artifactDigest !== after.artifactDigest))
  ) {
    throw phaseError(phase, "identity probe changed during qualification");
  }
}

async function checked(
  run: FormAuthorityIdentityProbeProcess,
  description: string,
  command: readonly string[],
): Promise<void> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw preflightError(
      `${description} failed (exit ${result.exitCode})`,
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
