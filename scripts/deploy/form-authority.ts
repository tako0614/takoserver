import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH,
  type FormAuthorityCoreVerifierIdentity,
  isFormAuthorityCoreVerifierIdentity,
} from "../../src/form-authority-identity-probe.ts";
import { canonicalDigest, canonicalJson } from "../../src/json.ts";
import { publicFormCapabilityManifest } from "../../src/public-worker-implementation.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import { deriveFormAuthorityIdentity } from "../../src/takoform/host-admission-endpoint.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import { assertPublicFormCapabilityTarget } from "./form-authority-capability.ts";
import {
  readPublicHostIdentityProbe,
  runFormAuthorityIdentityProbe,
} from "./form-authority-identity-probe.ts";
import {
  assertLoadedFormAuthorityScopeTransition,
  type FormAuthorityScope,
  type LoadedFormAuthorityScopeTransition,
} from "./form-authority-scope-transition.ts";
import {
  type CommandResult,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import { type DeployTarget, targetPath } from "./target.ts";
import {
  type DescriptorBindingMap,
  planTargetAdoption,
  type TargetAdoptionPlan,
  writeAdoptedTargetCandidate,
} from "./target-adoption.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  inspectLiveWorkerVersion,
  isWorkerVersionId,
  workerVersionAnnotationProfile,
  workerVersionIdentity,
} from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  optionalExactPlainTextBinding,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";
import {
  type BindingDifference,
  describeBindingDrift,
  surfaceTransitionAdmits,
  type WorkerBindingDrift,
  type WorkerSurfaceTransition,
} from "./worker-surface-transition.ts";

/**
 * Which descriptor field owns each Form-authority binding value.
 *
 * Only these can be adopted from live state. Everything else the closure
 * carries is code-derived, invocation-selected, or durable data identity, and
 * is refused by name with the remedy that fits it.
 */
export const FORM_AUTHORITY_DESCRIPTOR_BINDINGS: DescriptorBindingMap = {
  TAKOSERVER_FORM_AUTHORITY_HOST_ID: { field: "text", pointer: "/formAuthority/hostId" },
  TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: {
    field: "text",
    pointer: "/formAuthority/integrationOperatorScope/tenantId",
  },
  TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: {
    field: "text",
    pointer: "/formAuthority/integrationOperatorScope/space",
  },
  TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: {
    field: "text",
    pointer: "/formAuthority/integrationOperatorOrigin",
  },
  FORM_AUTHORITY: { field: "service", pointer: "/formAuthority/integrationWorkerName" },
};

export type FormAuthoritySurface =
  | "takoserver-form-authority-worker"
  | "takoserver-integration-form-authority-worker"
  | "takoserver-integration-form-authority-operator-worker";

export { publicFormCapabilityManifest } from "../../src/public-worker-implementation.ts";

export interface FormAuthorityDeployInvocation {
  readonly surface: FormAuthoritySurface;
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly scopeTransition?: LoadedFormAuthorityScopeTransition;
  /**
   * Pinned predecessor Version plus the declared difference between its closure
   * and the closure this commit would publish. The one way a code-derived
   * binding change reaches a Worker that is already live.
   */
  readonly transition?: WorkerSurfaceTransition;
  /** `--status` only: absolute path of the candidate descriptor to write. */
  readonly adoptLivePath?: string;
  /**
   * `--apply` on the released-Core authority, and only where that Worker has no
   * Version at all: publish it with its Core-verifier readback deferred to the
   * probe run that can only follow it.
   */
  readonly bootstrapVerifierBridge?: boolean;
  /**
   * Immutable identity-probe Version which must be the exact predecessor of
   * the one-binding transition that will make the deferred bridge live.
   */
  readonly bootstrapProbePredecessorVersionId?: string;
}

export type FormAuthorityProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface FormAuthorityDeployState {
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

export interface FormAuthorityDeployOptions {
  readonly run?: FormAuthorityProcess;
  readonly state?: FormAuthorityDeployState;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly review?: string;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Operator-private descriptor path adoption re-reads; defaults to the selected target path. */
  readonly targetDescriptorPath?: string;
}

export interface FormAuthorityCoreVerifierReadbackExpectation {
  readonly probeOrigin: string;
  readonly authorityWorkerVersionId: string;
  readonly artifactDigest: `sha256:${string}`;
}

export interface FormAuthorityCoreVerifierReadback {
  readonly ready: boolean;
  readonly identity: FormAuthorityCoreVerifierIdentity | null;
}

export interface SelectedFormAuthorityTarget {
  readonly kind: "authority" | "operator-gateway";
  readonly workerName: string;
  readonly hostId: string;
  readonly main: string;
  readonly policyAuthority: "takoserver-host";
  readonly verificationMode: "released-core" | "integration-fixture";
  readonly verificationAvailable: boolean;
  readonly productionEligible: false;
  readonly operatorOrigin?: string;
  readonly authorityWorkerName?: string;
  readonly operatorPublicJwk?: {
    readonly kty: "OKP";
    readonly crv: "Ed25519";
    readonly x: string;
  };
  readonly operatorScope?: {
    readonly tenantId: string;
    readonly space: string;
  };
}

interface FormAuthorityInspection {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly authorityArtifactDigest: `sha256:${string}`;
  readonly publicWorkerBindingProfile:
    | "dynamic-public-rpc"
    | "legacy-exact-pinned"
    | "unclassified";
  readonly scopeBindingProfile: "exact-target" | "exact-transition-predecessor" | "unclassified";
  /**
   * Whether the live Version is admissible only because the operator declared
   * the difference. `none` means it already is one of the strict profiles.
   */
  readonly bindingTransitionProfile: "none" | "declared-delta-predecessor";
  readonly boundPublicWorkerVersionId: string | null;
  readonly boundPublicWorkerArtifactDigest: `sha256:${string}` | null;
  /** Every difference between the closure this commit publishes and the live one. */
  readonly drift: readonly BindingDifference[];
}

interface PublicWorkerInspection {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly workerArtifactDigest: `sha256:${string}`;
}

interface BootstrapProbePredecessorInspection {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly previousVersionId: string | null;
  readonly commit: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly publicWorkerVersionId: string;
  readonly publicWorkerArtifactDigest: `sha256:${string}`;
}

const BOOTSTRAP_PROBE_TRANSITION_DELTA: WorkerSurfaceTransition["delta"] = {
  retiredVars: [],
  addedVars: [],
  refreshedVars: [],
  addedBindings: ["FORM_AUTHORITY"],
  addedSecrets: [],
  rotatedSecrets: [],
};

/**
 * Deploys the isolated authority composition or its authenticated integration
 * operator gateway. The gateway is a separate custom-domain Worker and never
 * joins the customer/public Worker graph. Integration is fenced before
 * credentials, state adapters, or storage target data are read.
 */
export async function runFormAuthority(
  invocation: FormAuthorityDeployInvocation,
  target: DeployTarget,
  options: FormAuthorityDeployOptions = {},
): Promise<Record<string, unknown>> {
  if (isIntegrationOnlySurface(invocation.surface) && invocation.environment !== "integration") {
    throw preflightError("integration Form authority deploy surface is integration-only");
  }
  if (target.environment !== invocation.environment) {
    throw preflightError("Form authority invocation and target environments differ");
  }
  assertPublicFormCapabilityTarget(target);
  if (invocation.scopeTransition) {
    if (
      invocation.environment !== "integration" ||
      invocation.surface === "takoserver-form-authority-worker"
    ) {
      throw preflightError("Form authority scope transition is integration-only");
    }
    assertLoadedFormAuthorityScopeTransition(invocation.scopeTransition, target);
  }
  if (invocation.scopeTransition && invocation.transition) {
    throw preflightError("one Form authority transition selector at a time");
  }
  const selected = selectTarget(invocation, target);
  const bootstrapVerifierBridge = invocation.bootstrapVerifierBridge === true;
  const bootstrapProbePredecessorVersionId = invocation.bootstrapProbePredecessorVersionId;
  if (bootstrapVerifierBridge !== (bootstrapProbePredecessorVersionId !== undefined)) {
    throw preflightError(
      "the verifier-bridge bootstrap and its identity-probe predecessor must be declared together",
      "Use --bootstrap-verifier-bridge with " +
        "--bootstrap-probe-predecessor-version=<exact identity probe Version from --status>",
    );
  }
  if (
    bootstrapProbePredecessorVersionId !== undefined &&
    !isWorkerVersionId(bootstrapProbePredecessorVersionId)
  ) {
    throw preflightError("bootstrap identity-probe predecessor is not a Worker Version id");
  }
  if (
    bootstrapVerifierBridge &&
    (invocation.action !== "apply" ||
      invocation.transition !== undefined ||
      invocation.scopeTransition !== undefined ||
      invocation.adoptLivePath !== undefined)
  ) {
    throw preflightError(
      "the verifier-bridge bootstrap is one forward-only first publication, not another transition",
    );
  }
  if (bootstrapVerifierBridge && selected.verificationMode !== "released-core") {
    throw preflightError(
      "only the released-Core Form authority Worker has a Core-verifier readback bridge to bootstrap",
    );
  }
  const capabilityManifest = publicFormCapabilityManifest();
  const capabilityManifestJson = canonicalJson(capabilityManifest);
  const capabilityDigest = await canonicalDigest(capabilityManifest);
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
  const publicBefore = await inspectPublicWorker("preflight", target, state);
  const publicIdentityReadback = await readPublicHostIdentityProbe(
    target,
    publicBefore,
    options.fetcher ?? fetch,
  );
  const operatorIdentity = publicIdentityReadback.identity
    ? await deriveFormAuthorityIdentity({
        environment: invocation.environment,
        hostId: selected.hostId,
        workerArtifactDigest: publicIdentityReadback.identity.workerArtifactDigest,
        publicWorkerVersionId: publicIdentityReadback.identity.workerVersionId,
        implementationPayloadDigest: publicIdentityReadback.identity.implementationPayloadDigest,
        implementationDigest: publicIdentityReadback.identity.implementationDigest,
        capabilities: capabilityManifest,
      })
    : null;
  const dependencySelected =
    selected.kind === "operator-gateway"
      ? selectTarget(
          { ...invocation, surface: "takoserver-integration-form-authority-worker" },
          target,
        )
      : null;
  const dependencyBefore = dependencySelected
    ? await inspectFormAuthority(
        "preflight",
        { ...invocation, surface: "takoserver-integration-form-authority-worker" },
        target,
        dependencySelected,
        publicBefore,
        capabilityManifestJson,
        state,
      )
    : null;
  const before = await inspectFormAuthority(
    "preflight",
    invocation,
    target,
    selected,
    publicBefore,
    capabilityManifestJson,
    state,
  );
  const statusCoreVerifierReadback =
    invocation.action === "status" && selected.verificationMode === "released-core"
      ? before === null
        ? unavailableCoreVerifierReadback()
        : await readFormAuthorityCoreVerifierIdentityProbe(
            {
              probeOrigin: requiredIdentityProbeOrigin(target),
              authorityWorkerVersionId: before.history.versionId,
              artifactDigest: takoformCoreVerifierArtifactDigest(),
            },
            options.fetcher ?? fetch,
          )
      : null;
  if (
    invocation.scopeTransition &&
    (before === null || (dependencySelected !== null && dependencyBefore === null))
  ) {
    throw preflightError("Form authority scope transition refuses absent or bootstrap topology");
  }
  const drift: readonly WorkerBindingDrift[] = [
    ...(before === null
      ? []
      : [
          {
            workerName: selected.workerName,
            versionId: before.history.versionId,
            differences: before.drift,
          },
        ]),
    ...(dependencySelected === null || dependencyBefore === null
      ? []
      : [
          {
            workerName: dependencySelected.workerName,
            versionId: dependencyBefore.history.versionId,
            differences: dependencyBefore.drift,
          },
        ]),
  ];
  // Redaction again: a scope transition never emits scope values, so it never
  // offers to adopt one either.
  const adoption = invocation.scopeTransition ? null : adoptLive(invocation, drift, options);

  if (invocation.action === "status") {
    return {
      kind: "takoserver.form-authority-worker-status@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      workerName: selected.workerName,
      hostId: selected.hostId,
      selectedCommit: invocation.commit,
      deployedCommit: before?.commit ?? null,
      commitMatches: before?.commit === invocation.commit,
      deploymentId: before?.history.deploymentId ?? null,
      versionId: before?.history.versionId ?? null,
      previousVersionId: before?.history.previousVersionId ?? null,
      authorityArtifactDigest: before?.authorityArtifactDigest ?? null,
      publicWorkerBindingProfile: before?.publicWorkerBindingProfile ?? null,
      scopeBindingProfile: before?.scopeBindingProfile ?? null,
      bindingTransitionProfile: before?.bindingTransitionProfile ?? null,
      ...(invocation.transition
        ? {
            transitionPredecessorVersionId: invocation.transition.predecessorVersionId,
            transitionDelta: { ...invocation.transition.delta },
          }
        : {}),
      ...(invocation.scopeTransition ? {} : { descriptorDrift: drift }),
      ...(adoption === null
        ? {}
        : {
            adoptableFromLive: adoption.plan.adopted,
            unadoptableFromLive: adoption.plan.refused,
            ...(adoption.candidate === null
              ? {}
              : {
                  adoptedTargetCandidate: adoption.candidate.path,
                  adoptedTargetCandidateDigest: adoption.candidate.digest,
                  adoptedTargetCandidatePatch: adoption.candidate.patch,
                }),
          }),
      boundPublicWorkerVersionId: before?.boundPublicWorkerVersionId ?? null,
      boundPublicWorkerArtifactDigest: before?.boundPublicWorkerArtifactDigest ?? null,
      workerArtifactDigest: publicBefore.workerArtifactDigest,
      publicWorkerCommit: publicBefore.commit,
      publicWorkerVersionId: publicBefore.history.versionId,
      publicWorkerCommitMatches: publicBefore.commit === invocation.commit,
      capabilityDigest,
      coreVerifierArtifactDigest:
        selected.verificationMode === "released-core" ? takoformCoreVerifierArtifactDigest() : null,
      coreVerifierRpcReady: statusCoreVerifierReadback?.ready ?? null,
      coreVerifierAuthorityWorkerVersionId:
        statusCoreVerifierReadback?.identity?.authorityWorkerVersionId ?? null,
      coreVerifierProtocol: statusCoreVerifierReadback?.identity?.verifier.protocol ?? null,
      coreVerifierVersion: statusCoreVerifierReadback?.identity?.verifier.coreVersion ?? null,
      coreVerifierCommit: statusCoreVerifierReadback?.identity?.verifier.coreCommit ?? null,
      coreVerifierObservedArtifactDigest:
        statusCoreVerifierReadback?.identity?.verifier.artifactDigest ?? null,
      // The one readback nothing this surface publishes can repair on its own,
      // so an unready bridge always arrives with the run that closes it.
      ...(selected.verificationMode === "released-core" &&
      statusCoreVerifierReadback?.ready !== true
        ? {
            coreVerifierBridgeRemedy:
              before === null
                ? bootstrapVerifierBridgeRemedy(invocation, target)
                : verifierBridgeRemedy(invocation, target),
          }
        : {}),
      publicIdentityRpcReady: publicIdentityReadback.ready,
      implementationPayloadDigest:
        publicIdentityReadback.identity?.implementationPayloadDigest ?? null,
      implementationDigest: operatorIdentity?.implementationDigest ?? null,
      ...(invocation.scopeTransition
        ? { scopeTransitionDigest: invocation.scopeTransition.digest }
        : {}),
      routeMode: routeMode(selected),
      ...(selected.operatorOrigin ? { operatorOrigin: selected.operatorOrigin } : {}),
      ...(dependencySelected
        ? {
            authorityWorkerName: dependencySelected.workerName,
            authorityDeployedCommit: dependencyBefore?.commit ?? null,
            authorityVersionId: dependencyBefore?.history.versionId ?? null,
            authorityCommitMatches: dependencyBefore?.commit === invocation.commit,
            authorityPublicWorkerBindingProfile:
              dependencyBefore?.publicWorkerBindingProfile ?? null,
            authorityScopeBindingProfile: dependencyBefore?.scopeBindingProfile ?? null,
          }
        : {}),
      policyAuthority: selected.policyAuthority,
      verificationMode: selected.verificationMode,
      verificationAvailable: selected.verificationAvailable,
      productionEligible: selected.productionEligible,
      // A declared transition is ready when the pinned predecessor is admitted
      // and everything it does not name is already exact. The authority's own
      // commit is deliberately not required to match: advancing it past a
      // closure-changing commit is precisely what the declaration exists for.
      ready: invocation.transition
        ? before?.bindingTransitionProfile === "declared-delta-predecessor" &&
          publicIdentityReadback.ready &&
          operatorIdentity !== null &&
          publicBefore.commit === invocation.commit &&
          (dependencySelected === null ||
            (dependencyBefore?.commit === invocation.commit &&
              dependencyBefore.publicWorkerBindingProfile === "dynamic-public-rpc" &&
              dependencyBefore.scopeBindingProfile === "exact-target" &&
              dependencyBefore.bindingTransitionProfile === "none"))
        : before?.commit === invocation.commit &&
          (selected.verificationMode !== "released-core" ||
            statusCoreVerifierReadback?.ready === true) &&
          publicIdentityReadback.ready &&
          operatorIdentity !== null &&
          before.publicWorkerBindingProfile === "dynamic-public-rpc" &&
          before.scopeBindingProfile === "exact-target" &&
          publicBefore.commit === invocation.commit &&
          (dependencySelected === null ||
            (dependencyBefore?.commit === invocation.commit &&
              dependencyBefore.publicWorkerBindingProfile === "dynamic-public-rpc" &&
              dependencyBefore.scopeBindingProfile === "exact-target")),
    };
  }

  if (!publicIdentityReadback.ready || operatorIdentity === null) {
    throw preflightError("public Host identity RPC is unavailable or inconsistent");
  }

  if (bootstrapVerifierBridge && before !== null) {
    throw preflightError(
      `Worker ${selected.workerName} already has a live Version, so its Core-verifier bridge is ` +
        "not a bootstrap",
      `Drop --bootstrap-verifier-bridge. If the readback is not yet live, ${verifierBridgeRemedy(invocation, target)}`,
    );
  }
  if (
    !bootstrapVerifierBridge &&
    before === null &&
    selected.verificationMode === "released-core"
  ) {
    throw preflightError(
      `Worker ${selected.workerName} does not exist yet, and its apply post-condition reads the ` +
        "identity probe's FORM_AUTHORITY binding, which cannot name an absent script",
      `Name the pinned two-phase order: ${bootstrapVerifierBridgeRemedy(invocation, target)}`,
    );
  }
  const bootstrapProbeBefore = bootstrapVerifierBridge
    ? await inspectBootstrapProbePredecessor(
        "preflight",
        invocation,
        target,
        publicBefore,
        state,
        options.fetcher ?? fetch,
      )
    : null;

  if (invocation.transition) {
    if (before === null) {
      throw preflightError(
        "Form authority forward transition refuses absent or bootstrap topology",
      );
    }
    if (invocation.transition.predecessorVersionId !== before.history.versionId) {
      throw preflightError(
        "authoritative current Form authority Version is not the pinned transition predecessor",
        `expected=${invocation.transition.predecessorVersionId} actual=${before.history.versionId}`,
      );
    }
    // An inadmissible declaration never reaches here: the classifier refuses an
    // apply it cannot place. What is left is a declaration with nothing to do.
    if (before.bindingTransitionProfile !== "declared-delta-predecessor") {
      throw preflightError(
        "declared transition is already at the target closure; use the routine invocation",
      );
    }
  }

  if (invocation.scopeTransition) {
    if (before?.scopeBindingProfile === "exact-target") {
      throw preflightError(
        "Form authority scope transition is already exact-target; apply refused",
      );
    }
    if (before?.scopeBindingProfile !== "exact-transition-predecessor") {
      throw preflightError("Form authority scope transition has no exact predecessor");
    }
    if (
      selected.kind === "operator-gateway" &&
      dependencyBefore?.scopeBindingProfile !== "exact-target"
    ) {
      throw preflightError(
        "Form authority gateway scope transition requires the route-less authority at exact-target",
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
    throw preflightError(
      "served public Worker commit differs from the Form authority source commit",
    );
  }
  if (
    dependencySelected &&
    (dependencyBefore?.commit !== source.commit ||
      dependencyBefore.publicWorkerBindingProfile !== "dynamic-public-rpc" ||
      (invocation.scopeTransition !== undefined &&
        dependencyBefore.scopeBindingProfile !== "exact-target"))
  ) {
    throw preflightError(
      "served integration Form authority Worker differs from the operator gateway source commit",
    );
  }
  await checked(run, "scoped Form authority owner gate `bun run check`", ["bun", "run", "check"]);

  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-form-authority-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const publicProof = await prepareWorkerArtifact({
      root: join(root, "public-worker-proof"),
      target,
      commit: source.commit,
      run,
      environment,
    });
    const expectedPublicDigest = `sha256:${publicProof.bundleDigestHex}` as const;
    if (expectedPublicDigest !== publicBefore.workerArtifactDigest) {
      throw preflightError(
        "served public Worker artifact differs from the exact Form authority source build",
        `served=${publicBefore.workerArtifactDigest} source=${expectedPublicDigest}`,
      );
    }
    const publicProofArtifact = publicProof.seal();
    publicProofArtifact.assertUnchanged();
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      run,
      environment,
      main: resolve(REPOSITORY, selected.main),
      writeConfig: ({ path, main }) =>
        writeFormAuthorityConfig({
          path,
          main,
          invocation: { ...invocation, commit: source.commit },
          target,
          selected,
          capabilityManifestJson,
        }),
    });
    const authorityArtifactDigest = `sha256:${prepared.bundleDigestHex}` as const;
    const artifact = prepared.seal();
    artifact.assertUnchanged();

    const publicLast = await inspectPublicWorker("preflight", target, state);
    assertSamePublicWorker("preflight", publicBefore, publicLast);
    const last = await inspectFormAuthority(
      "preflight",
      invocation,
      target,
      selected,
      publicBefore,
      capabilityManifestJson,
      state,
    );
    assertSameVersion(before, last);
    if (dependencySelected) {
      const dependencyLast = await inspectFormAuthority(
        "preflight",
        { ...invocation, surface: "takoserver-integration-form-authority-worker" },
        target,
        dependencySelected,
        publicBefore,
        capabilityManifestJson,
        state,
      );
      assertSameVersion(dependencyBefore, dependencyLast);
    }
    if (bootstrapProbeBefore !== null) {
      const bootstrapProbeLast = await inspectBootstrapProbePredecessor(
        "preflight",
        invocation,
        target,
        publicBefore,
        state,
        options.fetcher ?? fetch,
      );
      assertSameBootstrapProbePredecessor(bootstrapProbeBefore, bootstrapProbeLast);
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
        message(invocation.surface, source.commit, authorityArtifactDigest),
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "Form authority Worker upload acknowledgement is indeterminate; do not retry before --status",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }

    const publicAfter = await inspectPublicWorker("verification", target, state);
    assertSamePublicWorker("verification", publicBefore, publicAfter);
    const publicIdentityAfter = await readPublicHostIdentityProbe(
      target,
      publicAfter,
      options.fetcher ?? fetch,
    );
    if (
      !publicIdentityAfter.ready ||
      publicIdentityAfter.identity === null ||
      publicIdentityAfter.identity.implementationPayloadDigest !==
        publicIdentityReadback.identity?.implementationPayloadDigest ||
      publicIdentityAfter.identity.capabilityDigest !==
        publicIdentityReadback.identity?.capabilityDigest ||
      publicIdentityAfter.identity.implementationDigest !==
        publicIdentityReadback.identity?.implementationDigest
    ) {
      throw verificationError("public Host identity RPC changed or became unavailable");
    }
    if (dependencySelected) {
      const dependencyAfter = await inspectFormAuthority(
        "verification",
        { ...invocation, surface: "takoserver-integration-form-authority-worker" },
        target,
        dependencySelected,
        publicBefore,
        capabilityManifestJson,
        state,
      );
      assertSameVersion(dependencyBefore, dependencyAfter, "verification");
      if (
        !dependencyAfter ||
        dependencyAfter.history.versionId !== dependencyBefore?.history.versionId ||
        dependencyAfter.commit !== source.commit ||
        dependencyAfter.publicWorkerBindingProfile !== "dynamic-public-rpc" ||
        (invocation.scopeTransition !== undefined &&
          dependencyAfter.scopeBindingProfile !== "exact-target")
      ) {
        throw verificationError(
          "integration Form authority Worker changed during operator gateway deployment",
        );
      }
    }
    const after = await inspectFormAuthority(
      "verification",
      invocation,
      target,
      selected,
      publicBefore,
      capabilityManifestJson,
      state,
    );
    if (
      !after ||
      after.history.versionId === before?.history.versionId ||
      (before !== null && after.history.previousVersionId !== before.history.versionId) ||
      after.publicWorkerBindingProfile !== "dynamic-public-rpc" ||
      after.scopeBindingProfile !== "exact-target" ||
      after.bindingTransitionProfile !== "none" ||
      after.commit !== source.commit ||
      after.authorityArtifactDigest !== authorityArtifactDigest
    ) {
      throw verificationError(
        "Form authority authoritative history does not identify the exact uploaded successor",
      );
    }
    // The bootstrap upload deliberately does not read the bridge: the probe
    // cannot have bound a script that did not exist when this run started, so
    // asking would only spend a timeout proving what the order already says.
    const coreVerifierAfter =
      selected.verificationMode === "released-core" && !bootstrapVerifierBridge
        ? await readFormAuthorityCoreVerifierIdentityProbe(
            {
              probeOrigin: requiredIdentityProbeOrigin(target),
              authorityWorkerVersionId: after.history.versionId,
              artifactDigest: takoformCoreVerifierArtifactDigest(),
            },
            options.fetcher ?? fetch,
          )
        : null;
    if (
      selected.verificationMode === "released-core" &&
      !bootstrapVerifierBridge &&
      coreVerifierAfter?.ready !== true
    ) {
      throw verificationError(
        "released Core verifier live identity is unavailable or differs from the uploaded Worker Version",
      );
    }
    return {
      kind: "takoserver.form-authority-worker-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      workerName: selected.workerName,
      hostId: selected.hostId,
      commit: source.commit,
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      reviewer,
      authorityArtifactDigest,
      workerArtifactDigest: publicBefore.workerArtifactDigest,
      publicWorkerVersionId: publicBefore.history.versionId,
      capabilityDigest,
      coreVerifierArtifactDigest:
        selected.verificationMode === "released-core" ? takoformCoreVerifierArtifactDigest() : null,
      coreVerifierRpcReady: coreVerifierAfter?.ready ?? null,
      coreVerifierAuthorityWorkerVersionId:
        coreVerifierAfter?.identity?.authorityWorkerVersionId ?? null,
      coreVerifierProtocol: coreVerifierAfter?.identity?.verifier.protocol ?? null,
      coreVerifierVersion: coreVerifierAfter?.identity?.verifier.coreVersion ?? null,
      coreVerifierCommit: coreVerifierAfter?.identity?.verifier.coreCommit ?? null,
      coreVerifierObservedArtifactDigest:
        coreVerifierAfter?.identity?.verifier.artifactDigest ?? null,
      ...(bootstrapVerifierBridge
        ? {
            verifierBridgePending: true,
            verifierBridgeNextStep: verifierBridgeRemedy(invocation, target),
          }
        : {}),
      ...(bootstrapProbeBefore === null
        ? {}
        : {
            bootstrapProbePredecessorVersionId: bootstrapProbeBefore.versionId,
            bootstrapProbePredecessorCommit: bootstrapProbeBefore.commit,
            bootstrapProbeArtifactDigest: bootstrapProbeBefore.artifactDigest,
          }),
      publicIdentityRpcReady: true,
      implementationPayloadDigest: publicIdentityAfter.identity.implementationPayloadDigest,
      implementationDigest: operatorIdentity.implementationDigest,
      scopeBindingProfile: after.scopeBindingProfile,
      bindingTransitionProfile: after.bindingTransitionProfile,
      ...(invocation.scopeTransition
        ? { scopeTransitionDigest: invocation.scopeTransition.digest }
        : {}),
      ...(invocation.transition
        ? {
            transitionPredecessorVersionId: invocation.transition.predecessorVersionId,
            transitionDelta: { ...invocation.transition.delta },
          }
        : {}),
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      previousVersionId: before?.history.versionId ?? null,
      deploymentId: after.history.deploymentId,
      versionId: after.history.versionId,
      routeMode: routeMode(selected),
      ...(selected.operatorOrigin ? { operatorOrigin: selected.operatorOrigin } : {}),
      ...(dependencySelected
        ? {
            authorityWorkerName: dependencySelected.workerName,
            authorityVersionId: dependencyBefore?.history.versionId ?? null,
            authorityScopeBindingProfile: dependencyBefore?.scopeBindingProfile ?? null,
          }
        : {}),
      policyAuthority: selected.policyAuthority,
      verificationMode: selected.verificationMode,
      verificationAvailable: selected.verificationAvailable,
      productionEligible: selected.productionEligible,
      rollback: before
        ? `wrangler versions deploy ${before.history.versionId}@100% --yes --name ${selected.workerName}`
        : bootstrapVerifierBridge
          ? "forward repair only: a first Version has no predecessor to roll back to, and no " +
            `surface deletes a Worker. Finish the lane: ${verifierBridgeRemedy(invocation, target)}`
          : "forward repair only: no previous Form authority Worker version exists",
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

export function writeFormAuthorityConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly invocation: FormAuthorityDeployInvocation;
  readonly target: DeployTarget;
  readonly selected: SelectedFormAuthorityTarget;
  readonly capabilityManifestJson: string;
}): string {
  if (!/^[0-9a-f]{40}$/u.test(input.invocation.commit)) {
    throw preflightError("Form authority config requires one exact commit");
  }
  if (canonicalJson(publicFormCapabilityManifest()) !== input.capabilityManifestJson) {
    throw preflightError("Form authority config requires one canonical capability manifest");
  }
  const shared = {
    account_id: input.target.accountId,
    name: input.selected.workerName,
    main: input.main,
    compatibility_date: "2026-08-17",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
  } as const;
  const coreVerifierArtifactDigest =
    input.selected.verificationMode === "released-core"
      ? takoformCoreVerifierArtifactDigest()
      : null;
  const configuration =
    input.selected.kind === "operator-gateway"
      ? operatorGatewayConfiguration(input, shared)
      : {
          ...shared,
          vars: {
            TAKOSERVER_ENVIRONMENT: input.invocation.environment,
            TAKOSERVER_FORM_AUTHORITY_HOST_ID: input.selected.hostId,
            TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: input.capabilityManifestJson,
            ...(coreVerifierArtifactDigest === null
              ? {}
              : {
                  TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: coreVerifierArtifactDigest,
                }),
            ...(input.invocation.surface === "takoserver-integration-form-authority-worker"
              ? {
                  TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson(
                    requiredOperatorPublicJwk(input.selected),
                  ),
                  TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: requiredOperatorScope(
                    input.selected,
                  ).tenantId,
                  TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: requiredOperatorScope(input.selected)
                    .space,
                }
              : {}),
          },
          d1_databases: [
            {
              binding: "STATE_DB",
              database_name: input.target.d1.databaseName,
              database_id: input.target.d1.databaseId,
              migrations_dir: resolve(REPOSITORY, "migrations"),
            },
          ],
          r2_buckets: [{ binding: "OBJECTS", bucket_name: input.target.r2.bucketName }],
          services: [
            {
              binding: "PUBLIC_HOST_IDENTITY",
              service: input.target.workerName,
              entrypoint: "PublicHostIdentityEntrypoint",
            },
          ],
          ...(coreVerifierArtifactDigest === null
            ? {}
            : {
                version_metadata: { binding: "WORKER_VERSION" },
                durable_objects: {
                  bindings: [
                    {
                      name: "CORE_VERIFIER",
                      class_name: "TakoformCoreVerifierContainer",
                    },
                  ],
                },
                migrations: [
                  {
                    tag: "takoform-core-verifier-v1",
                    new_sqlite_classes: ["TakoformCoreVerifierContainer"],
                  },
                ],
                containers: [
                  {
                    class_name: "TakoformCoreVerifierContainer",
                    image: resolve(REPOSITORY, "services/takoform-core-verifier/Dockerfile"),
                    image_build_context: resolve(REPOSITORY, "services/takoform-core-verifier"),
                    image_vars: {
                      TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: coreVerifierArtifactDigest,
                    },
                    max_instances: 1,
                    instance_type: "lite",
                  },
                ],
              }),
        };
  writeFileSync(input.path, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return input.path;
}

/** Digest of every byte Wrangler passes to the native verifier image build. */
export function takoformCoreVerifierArtifactDigest(): `sha256:${string}` {
  const root = resolve(REPOSITORY, "services/takoform-core-verifier");
  const hash = createHash("sha256");
  for (const path of recursiveFiles(root)) {
    const relative = path.slice(root.length + 1);
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function recursiveFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? recursiveFiles(path) : [path];
    })
    .sort();
}

function operatorGatewayConfiguration(
  input: Parameters<typeof writeFormAuthorityConfig>[0],
  shared: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const origin = input.selected.operatorOrigin;
  const authorityWorkerName = input.selected.authorityWorkerName;
  const operatorPublicJwk = input.selected.operatorPublicJwk;
  const operatorScope = input.selected.operatorScope;
  if (
    input.invocation.environment !== "integration" ||
    !origin ||
    !authorityWorkerName ||
    !operatorPublicJwk ||
    !operatorScope
  ) {
    throw preflightError("integration Form authority operator gateway target is incomplete");
  }
  return {
    ...shared,
    vars: {
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: input.selected.hostId,
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: origin,
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson(operatorPublicJwk),
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: operatorScope.tenantId,
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: operatorScope.space,
    },
    routes: [{ pattern: new URL(origin).hostname, custom_domain: true }],
    services: [
      {
        binding: "FORM_AUTHORITY",
        service: authorityWorkerName,
        entrypoint: "IntegrationFormAuthorityEntrypoint",
      },
      {
        binding: "PUBLIC_HOST_IDENTITY",
        service: input.target.workerName,
        entrypoint: "PublicHostIdentityEntrypoint",
      },
    ],
  };
}

async function inspectFormAuthority(
  phase: DeployPhase,
  invocation: FormAuthorityDeployInvocation,
  target: DeployTarget,
  selected: SelectedFormAuthorityTarget,
  _publicWorker: PublicWorkerInspection,
  capabilityManifestJson: string,
  state: FormAuthorityDeployState,
): Promise<FormAuthorityInspection | null> {
  const scripts = await state.workerScripts();
  if (scripts.length !== new Set(scripts).size) {
    throw phaseError(phase, "Cloudflare Worker script inventory contains duplicates");
  }
  const scriptPresent = scripts.includes(selected.workerName);
  const domains = await state.workerDomains();
  const ownedDomains = domains.filter(({ service }) => service === selected.workerName);
  if (selected.kind === "operator-gateway") {
    const expectedHostname = new URL(selected.operatorOrigin as string).hostname;
    const expectedDomains = domains.filter(({ hostname }) => hostname === expectedHostname);
    if (expectedDomains.length > 1) {
      throw phaseError(
        phase,
        "Form authority operator gateway custom domain topology is ambiguous",
      );
    }
    const expectedDomain = expectedDomains[0];
    if (expectedDomain && expectedDomain.service !== selected.workerName) {
      throw phaseError(phase, "Form authority operator gateway custom domain has a foreign owner");
    }
    const domainPresent = expectedDomain?.service === selected.workerName;
    if (
      ownedDomains.length !== (domainPresent ? 1 : 0) ||
      (domainPresent && ownedDomains[0]?.hostname !== expectedHostname) ||
      scriptPresent !== domainPresent
    ) {
      throw phaseError(
        phase,
        "Form authority operator gateway script/custom domain topology is partial",
      );
    }
  } else if (ownedDomains.length > 0) {
    throw phaseError(phase, "route-less Form authority Worker unexpectedly owns a public domain");
  }
  const routes = (await state.workerRoutes()).filter(
    ({ script }) => script === selected.workerName,
  );
  if (routes.length > 0) {
    throw phaseError(phase, "Form authority Worker unexpectedly owns a zone route");
  }
  if (!scriptPresent) return null;
  const history = parseWorkerDeploymentHistory(await state.workerDeployments(selected.workerName));
  if (!history) throw phaseError(phase, "Form authority Worker has no served deployment");
  const version = await state.workerVersion(selected.workerName, history.versionId);
  const identity = versionIdentity(phase, invocation.surface, version);
  const binding = await classifyPublicWorkerBinding(
    phase,
    invocation,
    target,
    selected,
    history.versionId,
    version,
    identity.commit,
    capabilityManifestJson,
    state,
  );
  assertExactSecretInventory(await state.workerSecrets(selected.workerName), [], phase);
  const subdomain = await state.workerSubdomain(selected.workerName);
  if (subdomain.enabled || subdomain.previewsEnabled) {
    throw phaseError(phase, "Form authority Worker has a workers.dev or preview subdomain enabled");
  }
  return { history, ...identity, ...binding };
}

async function classifyPublicWorkerBinding(
  phase: DeployPhase,
  invocation: FormAuthorityDeployInvocation,
  target: DeployTarget,
  selected: SelectedFormAuthorityTarget,
  authorityVersionId: string,
  authorityVersion: unknown,
  authorityCommit: string,
  capabilityManifestJson: string,
  state: FormAuthorityDeployState,
): Promise<
  Pick<
    FormAuthorityInspection,
    | "publicWorkerBindingProfile"
    | "scopeBindingProfile"
    | "bindingTransitionProfile"
    | "boundPublicWorkerVersionId"
    | "boundPublicWorkerArtifactDigest"
    | "drift"
  >
> {
  const transition = invocation.scopeTransition;
  const targetExpected = expectedBindings(
    invocation.environment,
    target,
    selected,
    capabilityManifestJson,
    transition?.value.targetScope,
  );
  // Computed once, whatever the outcome: it is the sentence that turns "no
  // profile matches" into a difference an operator can act on, and it is the
  // input `--adopt-live` reads.
  const drift = describeBindingDrift(phase, authorityVersionId, authorityVersion, targetExpected);
  if (hasExactBindingClosure(phase, authorityVersionId, authorityVersion, targetExpected)) {
    return {
      publicWorkerBindingProfile: "dynamic-public-rpc",
      scopeBindingProfile: "exact-target",
      bindingTransitionProfile: "none",
      boundPublicWorkerVersionId: null,
      boundPublicWorkerArtifactDigest: null,
      drift,
    };
  }

  if (transition) {
    const predecessorExpected = expectedBindings(
      invocation.environment,
      target,
      selected,
      capabilityManifestJson,
      transition.value.predecessorScope,
    );
    if (hasExactBindingClosure(phase, authorityVersionId, authorityVersion, predecessorExpected)) {
      return {
        publicWorkerBindingProfile: "dynamic-public-rpc",
        scopeBindingProfile: "exact-transition-predecessor",
        bindingTransitionProfile: "none",
        boundPublicWorkerVersionId: null,
        boundPublicWorkerArtifactDigest: null,
        drift,
      };
    }
  }

  // The shared forward transition. A code advance that changes this Worker's
  // derived closure — the capability manifest gaining a Form kind is the live
  // case — cannot be published while the fence demands the predecessor already
  // carry the value the advance introduces. The operator pins the Version and
  // names the difference; the value itself still comes from the code.
  const declared = invocation.transition;
  if (
    declared !== undefined &&
    declared.predecessorVersionId === authorityVersionId &&
    surfaceTransitionAdmits(phase, authorityVersionId, authorityVersion, {
      delta: declared.delta,
      targetClosure: targetExpected,
    })
  ) {
    return {
      publicWorkerBindingProfile: "dynamic-public-rpc",
      scopeBindingProfile: "exact-target",
      bindingTransitionProfile: "declared-delta-predecessor",
      boundPublicWorkerVersionId: null,
      boundPublicWorkerArtifactDigest: null,
      drift,
    };
  }

  const pinned = await inspectLegacyPinnedPublicWorker(
    phase,
    target,
    authorityVersionId,
    authorityVersion,
    state,
    transition === undefined,
  );
  if (pinned !== null) {
    const legacyTarget = expectedLegacyBindings(
      invocation.environment,
      target,
      selected,
      capabilityManifestJson,
      pinned,
      transition?.value.targetScope,
    );
    if (hasExactBindingClosure(phase, authorityVersionId, authorityVersion, legacyTarget)) {
      if (authorityCommit === pinned.commit) {
        return {
          publicWorkerBindingProfile: "legacy-exact-pinned",
          scopeBindingProfile: "exact-target",
          bindingTransitionProfile: "none",
          boundPublicWorkerVersionId: pinned.versionId,
          boundPublicWorkerArtifactDigest: pinned.workerArtifactDigest,
          drift,
        };
      }
      if (!transition) {
        throw phaseError(
          phase,
          "legacy Form authority commit differs from its exact pinned public Worker commit",
        );
      }
    }
    if (transition) {
      const legacyPredecessor = expectedLegacyBindings(
        invocation.environment,
        target,
        selected,
        capabilityManifestJson,
        pinned,
        transition.value.predecessorScope,
      );
      if (hasExactBindingClosure(phase, authorityVersionId, authorityVersion, legacyPredecessor)) {
        if (authorityCommit === pinned.commit) {
          return {
            publicWorkerBindingProfile: "legacy-exact-pinned",
            scopeBindingProfile: "exact-transition-predecessor",
            bindingTransitionProfile: "none",
            boundPublicWorkerVersionId: pinned.versionId,
            boundPublicWorkerArtifactDigest: pinned.workerArtifactDigest,
            drift,
          };
        }
      }
    }
  }

  // The scope-transition selector owes redaction: neither the predecessor, a
  // foreign observed scope, nor raw binding JSON may leave it, in success or in
  // refusal. So that path keeps its exact, detail-free refusal and never
  // reaches the difference readback below.
  if (transition) {
    throw phaseError(
      phase,
      "Form authority scope transition binding is neither exact-target nor exact-transition-predecessor",
    );
  }
  // `--status` exists to say what is wrong. Refusing it here is what left the
  // descriptor drift underneath this refusal unreadable, so status reports the
  // unclassified Version and its exact differences instead.
  if (invocation.action === "status") {
    return {
      publicWorkerBindingProfile: "unclassified",
      scopeBindingProfile: "unclassified",
      bindingTransitionProfile: "none",
      boundPublicWorkerVersionId: null,
      boundPublicWorkerArtifactDigest: null,
      drift,
    };
  }
  throw new DeployError(
    phase,
    "Form authority binding is neither dynamic public RPC, an exact legacy public pin, nor a " +
      "declared forward transition; run --status for the exact difference",
    JSON.stringify(drift),
  );
}

interface LegacyPinnedPublicWorker {
  readonly versionId: string;
  readonly commit: string;
  readonly workerArtifactDigest: `sha256:${string}`;
}

const HISTORICAL_SIGNING_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;

async function inspectLegacyPinnedPublicWorker(
  phase: DeployPhase,
  target: DeployTarget,
  authorityVersionId: string,
  authorityVersion: unknown,
  state: FormAuthorityDeployState,
  allowHistoricalProfile: boolean,
): Promise<LegacyPinnedPublicWorker | null> {
  const versionId = optionalExactPlainTextBinding(
    phase,
    authorityVersionId,
    authorityVersion,
    "TAKOSERVER_PUBLIC_WORKER_VERSION_ID",
  );
  const artifactDigest = optionalExactPlainTextBinding(
    phase,
    authorityVersionId,
    authorityVersion,
    "TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST",
  );
  if (versionId === null && artifactDigest === null) return null;
  if (
    versionId === null ||
    artifactDigest === null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(versionId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifactDigest)
  ) {
    throw phaseError(phase, "legacy Form authority public identity pins are incomplete or invalid");
  }
  const publicVersion = await state.workerVersion(target.workerName, versionId);
  if (workerVersionAnnotationProfile(publicVersion) !== "canonical") {
    throw phaseError(phase, "legacy Form authority pin has no canonical annotation inventory");
  }
  const identity = workerVersionIdentity(phase, publicVersion);
  const expected = expectedExactBindingClosure(target, {
    workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
    ...(target.integrationE2eCredentialAuthority === undefined
      ? {}
      : {
          authorityProfile: {
            kind: "provenance-bound-jit" as const,
            provenance: {
              sourceCommit: identity.commit,
              artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
            },
          },
        }),
  });
  const legacyBeforeCapabilityIdentity = {
    ...expected,
    TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: null,
  };
  const historicalBeforeJitAndSponsorship = allowHistoricalProfile
    ? expectedHistoricalPinnedPublicWorkerClosure(phase, target, versionId, publicVersion)
    : null;
  if (
    !hasExactBindingClosure(phase, versionId, publicVersion, expected) &&
    !hasExactBindingClosure(phase, versionId, publicVersion, legacyBeforeCapabilityIdentity) &&
    (historicalBeforeJitAndSponsorship === null ||
      !hasExactBindingClosure(phase, versionId, publicVersion, historicalBeforeJitAndSponsorship))
  ) {
    throw phaseError(
      phase,
      "legacy Form authority pin does not name an exact public Worker closure",
    );
  }
  const observedArtifactDigest = `sha256:${identity.bundleDigestHex}` as const;
  if (artifactDigest !== observedArtifactDigest) {
    throw phaseError(
      phase,
      "legacy Form authority artifact pin mismatches its public Worker Version",
    );
  }
  return {
    versionId,
    commit: identity.commit,
    workerArtifactDigest: observedArtifactDigest,
  };
}

/**
 * One-time integration bridge for the deployed generation before JIT provenance
 * and sponsorship. Remove it after both authority Workers are verified dynamic.
 */
function expectedHistoricalPinnedPublicWorkerClosure(
  phase: DeployPhase,
  target: DeployTarget,
  versionId: string,
  publicVersion: unknown,
): Parameters<typeof assertExactVersionBindingClosure>[3] | null {
  if (
    target.environment !== "integration" ||
    target.sponsorship !== true ||
    target.integrationE2eCredentialAuthority === undefined
  ) {
    return null;
  }
  const signingKeyId = optionalExactPlainTextBinding(
    phase,
    versionId,
    publicVersion,
    "TAKOSERVER_SIGNING_KEY_ID",
  );
  if (signingKeyId === null || !HISTORICAL_SIGNING_KEY_ID.test(signingKeyId)) return null;
  const {
    sponsorship: _currentSponsorship,
    integrationE2eCredentialAuthority: _currentCredentialAuthority,
    ...historicalTarget
  } = target;
  return expectedExactBindingClosure({
    ...historicalTarget,
    signing: { currentKeyId: signingKeyId },
  });
}

function expectedLegacyBindings(
  environment: DeployEnvironment,
  target: DeployTarget,
  selected: SelectedFormAuthorityTarget,
  capabilityManifestJson: string,
  pinned: LegacyPinnedPublicWorker,
  scopeOverride?: FormAuthorityScope,
) {
  return {
    ...expectedBindings(environment, target, selected, capabilityManifestJson, scopeOverride),
    TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: {
      type: "plain_text",
      fields: { text: pinned.workerArtifactDigest },
    },
    TAKOSERVER_PUBLIC_WORKER_VERSION_ID: {
      type: "plain_text",
      fields: { text: pinned.versionId },
    },
  };
}

function hasExactBindingClosure(
  phase: DeployPhase,
  versionId: string,
  version: unknown,
  expected: Parameters<typeof assertExactVersionBindingClosure>[3],
): boolean {
  try {
    assertExactVersionBindingClosure(phase, versionId, version, expected);
    return true;
  } catch (error) {
    if (error instanceof DeployError) return false;
    throw error;
  }
}

function expectedBindings(
  environment: DeployEnvironment,
  target: DeployTarget,
  selected: SelectedFormAuthorityTarget,
  capabilityManifestJson: string,
  scopeOverride?: FormAuthorityScope,
) {
  const operatorScope = scopeOverride ?? selected.operatorScope;
  if (selected.kind === "operator-gateway") {
    if (
      !selected.authorityWorkerName ||
      !selected.operatorOrigin ||
      !selected.operatorPublicJwk ||
      !operatorScope
    ) {
      throw preflightError("integration Form authority operator gateway target is incomplete");
    }
    return {
      FORM_AUTHORITY: {
        type: "service",
        fields: {
          service: selected.authorityWorkerName,
          entrypoint: "IntegrationFormAuthorityEntrypoint",
        },
      },
      PUBLIC_HOST_IDENTITY: {
        type: "service",
        fields: {
          service: target.workerName,
          entrypoint: "PublicHostIdentityEntrypoint",
        },
      },
      TAKOSERVER_ENVIRONMENT: { type: "plain_text", fields: { text: "integration" } },
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: {
        type: "plain_text",
        fields: { text: selected.hostId },
      },
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: {
        type: "plain_text",
        fields: { text: selected.operatorOrigin },
      },
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: {
        type: "plain_text",
        fields: { text: canonicalJson(selected.operatorPublicJwk) },
      },
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: {
        type: "plain_text",
        fields: { text: operatorScope.tenantId },
      },
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: {
        type: "plain_text",
        fields: { text: operatorScope.space },
      },
    } as const;
  }
  return {
    STATE_DB: { type: "d1", fields: { id: target.d1.databaseId } },
    OBJECTS: { type: "r2_bucket", fields: { bucket_name: target.r2.bucketName } },
    PUBLIC_HOST_IDENTITY: {
      type: "service",
      fields: {
        service: target.workerName,
        entrypoint: "PublicHostIdentityEntrypoint",
      },
    },
    TAKOSERVER_ENVIRONMENT: { type: "plain_text", fields: { text: environment } },
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: {
      type: "plain_text",
      fields: { text: selected.hostId },
    },
    TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: {
      type: "plain_text",
      fields: { text: capabilityManifestJson },
    },
    ...(selected.verificationMode === "released-core"
      ? {
          WORKER_VERSION: { type: "version_metadata", fields: {} },
          CORE_VERIFIER: {
            type: "durable_object_namespace",
            fields: { class_name: "TakoformCoreVerifierContainer" },
          },
          TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: {
            type: "plain_text",
            fields: { text: takoformCoreVerifierArtifactDigest() },
          },
        }
      : {}),
    ...(invocationSurfaceIsIntegrationAuthority(selected)
      ? {
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: {
            type: "plain_text",
            fields: { text: canonicalJson(requiredOperatorPublicJwk(selected)) },
          },
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: {
            type: "plain_text",
            fields: { text: (operatorScope ?? requiredOperatorScope(selected)).tenantId },
          },
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: {
            type: "plain_text",
            fields: { text: (operatorScope ?? requiredOperatorScope(selected)).space },
          },
        }
      : {}),
  } as const;
}

const MAX_CORE_VERIFIER_IDENTITY_BYTES = 16 * 1024;

/**
 * Reads the permanent HTTP-to-named-RPC bridge and accepts only proof emitted
 * by the exact currently served authority Worker Version and verifier image.
 */
export async function readFormAuthorityCoreVerifierIdentityProbe(
  expectation: FormAuthorityCoreVerifierReadbackExpectation,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<FormAuthorityCoreVerifierReadback> {
  try {
    const response = await fetcher(
      `${exactProbeOrigin(expectation.probeOrigin)}${FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH}`,
      {
        method: "GET",
        headers: { accept: "application/json", "cache-control": "no-store" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      return unavailableCoreVerifierReadback();
    }
    const bytes = await boundedCoreVerifierIdentityResponse(response);
    const value = parseStrictJson(bytes, MAX_CORE_VERIFIER_IDENTITY_BYTES);
    if (
      !isFormAuthorityCoreVerifierIdentity(value) ||
      value.authorityWorkerVersionId !== expectation.authorityWorkerVersionId ||
      value.verifier.artifactDigest !== expectation.artifactDigest
    ) {
      return unavailableCoreVerifierReadback();
    }
    return { ready: true, identity: structuredClone(value) };
  } catch {
    return unavailableCoreVerifierReadback();
  }
}

function unavailableCoreVerifierReadback(): FormAuthorityCoreVerifierReadback {
  return { ready: false, identity: null };
}

/**
 * Reuses the identity-probe surface's own exact transition classifier. The
 * authority bootstrap is allowed to defer its readback only when the probe is
 * already one immutable, explicitly pinned upload away from closing it.
 */
async function inspectBootstrapProbePredecessor(
  phase: DeployPhase,
  invocation: FormAuthorityDeployInvocation,
  target: DeployTarget,
  publicWorker: PublicWorkerInspection,
  state: FormAuthorityDeployState,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<BootstrapProbePredecessorInspection> {
  const predecessorVersionId = invocation.bootstrapProbePredecessorVersionId;
  if (predecessorVersionId === undefined) {
    throw phaseError(phase, "verifier-bridge bootstrap has no identity-probe predecessor");
  }
  const status = await runFormAuthorityIdentityProbe(
    {
      surface: "takoserver-form-authority-identity-probe",
      action: "status",
      environment: invocation.environment,
      commit: invocation.commit,
      transition: {
        predecessorVersionId,
        delta: BOOTSTRAP_PROBE_TRANSITION_DELTA,
      },
    },
    target,
    { state, fetcher },
  );
  const exact =
    status.kind === "takoserver.form-authority-identity-probe-status@v1" &&
    status.versionId === predecessorVersionId &&
    status.transitionPredecessorVersionId === predecessorVersionId &&
    status.bindingTransitionProfile === "declared-delta-predecessor" &&
    status.formAuthorityWorkerPresent === false &&
    status.publicIdentityRpcReady === true &&
    status.publicWorkerCommit === invocation.commit &&
    status.publicWorkerVersionId === publicWorker.history.versionId &&
    status.workerArtifactDigest === publicWorker.workerArtifactDigest &&
    typeof status.deploymentId === "string" &&
    typeof status.deployedCommit === "string" &&
    typeof status.probeArtifactDigest === "string" &&
    (status.previousVersionId === null || typeof status.previousVersionId === "string");
  if (!exact) {
    throw phaseError(
      phase,
      "identity probe is not the exact declared predecessor with only FORM_AUTHORITY missing",
    );
  }
  return {
    deploymentId: status.deploymentId as string,
    versionId: predecessorVersionId,
    previousVersionId: status.previousVersionId as string | null,
    commit: status.deployedCommit as string,
    artifactDigest: status.probeArtifactDigest as `sha256:${string}`,
    publicWorkerVersionId: status.publicWorkerVersionId as string,
    publicWorkerArtifactDigest: status.workerArtifactDigest as `sha256:${string}`,
  };
}

function assertSameBootstrapProbePredecessor(
  before: BootstrapProbePredecessorInspection,
  last: BootstrapProbePredecessorInspection,
): void {
  if (
    before.deploymentId !== last.deploymentId ||
    before.versionId !== last.versionId ||
    before.previousVersionId !== last.previousVersionId ||
    before.commit !== last.commit ||
    before.artifactDigest !== last.artifactDigest ||
    before.publicWorkerVersionId !== last.publicWorkerVersionId ||
    before.publicWorkerArtifactDigest !== last.publicWorkerArtifactDigest
  ) {
    throw preflightError("identity probe changed during verifier-bridge qualification");
  }
}

/**
 * The released-Core lane's readback bridge cannot exist before the Worker it
 * reads, so the order is declared rather than deadlocked.
 *
 * `takoserver-form-authority-worker`'s apply post-condition is
 * `GET <identityProbeOrigin>/v1/core-verifier-identity`, and the probe serves
 * that route only through `env.FORM_AUTHORITY` — a service binding naming this
 * Worker. `takoserver-form-authority-identity-probe` refuses to publish a
 * binding to a script that is not there, because that would realize a dangling
 * service binding. So each surface required the other to have gone first and
 * the lane could not be started in any environment: a first upload would have
 * failed its own verification with certainty, and a first Version has no
 * predecessor to roll back to.
 *
 * Three phases, named on the invocation: publish the authority with the
 * readback deferred, bind the probe, then prove the verifier live. The deferral
 * is admitted only where the Worker has no Version at all — the one state in
 * which the bridge provably cannot exist — and it relaxes nothing afterwards:
 * every later apply meets the steady-state post-condition, and the probe's
 * "no dangling binding" refusal is untouched, because by phase two the script
 * it names exists.
 */
function verifierBridgeRemedy(
  invocation: FormAuthorityDeployInvocation,
  target: DeployTarget,
): string {
  const probe = target.formAuthority?.identityProbeWorkerName ?? "the identity probe";
  const selector = `--environment=${invocation.environment} --commit=${invocation.commit}` as const;
  const probePredecessor =
    invocation.bootstrapProbePredecessorVersionId ?? "<probe-version-from-status>";
  return (
    `give ${probe} its FORM_AUTHORITY binding with \`bun run deploy -- ` +
    `takoserver-form-authority-identity-probe --apply ${selector} ` +
    `--closure-predecessor-version=${probePredecessor} ` +
    "--add-binding=FORM_AUTHORITY`, then prove the bridge live with `bun run deploy -- " +
    `takoserver-form-authority-worker --status ${selector}\`, which reports ` +
    "coreVerifierRpcReady: true only once it is"
  );
}

function bootstrapVerifierBridgeRemedy(
  invocation: FormAuthorityDeployInvocation,
  target: DeployTarget,
): string {
  const probe = target.formAuthority?.identityProbeWorkerName ?? "the identity probe";
  const selector = `--environment=${invocation.environment} --commit=${invocation.commit}` as const;
  return (
    `read ${probe}'s exact current Version with \`bun run deploy -- ` +
    `takoserver-form-authority-identity-probe --status ${selector}\`, then run \`bun run deploy -- ` +
    `takoserver-form-authority-worker --apply ${selector} --bootstrap-verifier-bridge ` +
    "--bootstrap-probe-predecessor-version=<that exact versionId>`. The apply admits only a " +
    "probe closure missing FORM_AUTHORITY and rechecks the same immutable Version at its final " +
    "mutation fence; after it succeeds, " +
    verifierBridgeRemedy(invocation, target)
  );
}

function requiredIdentityProbeOrigin(target: DeployTarget): string {
  const origin = target.formAuthority?.identityProbeOrigin;
  if (!origin) throw preflightError("selected target has no Form authority identity probe origin");
  return exactProbeOrigin(origin);
}

function exactProbeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("Form authority identity probe origin is invalid");
  }
  return url.origin;
}

async function boundedCoreVerifierIdentityResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_CORE_VERIFIER_IDENTITY_BYTES)
  ) {
    throw new TypeError("Core verifier identity response is too large");
  }
  if (!response.body) throw new TypeError("Core verifier identity response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_CORE_VERIFIER_IDENTITY_BYTES) {
        await reader.cancel();
        throw new TypeError("Core verifier identity response is too large");
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

function selectTarget(
  invocation: FormAuthorityDeployInvocation,
  target: DeployTarget,
): SelectedFormAuthorityTarget {
  const authority = target.formAuthority;
  if (!authority) throw preflightError("selected target has no formAuthority configuration");
  if (invocation.surface === "takoserver-integration-form-authority-operator-worker") {
    if (
      !authority.integrationWorkerName ||
      !authority.integrationOperatorWorkerName ||
      !authority.integrationOperatorOrigin ||
      !authority.operatorPublicJwk ||
      !authority.integrationOperatorScope
    ) {
      throw preflightError(
        "selected integration target has no complete Form authority operator gateway",
      );
    }
    return {
      kind: "operator-gateway",
      workerName: authority.integrationOperatorWorkerName,
      hostId: authority.hostId,
      main: "src/entry-integration-form-authority-operator-worker.ts",
      operatorOrigin: authority.integrationOperatorOrigin,
      authorityWorkerName: authority.integrationWorkerName,
      operatorPublicJwk: authority.operatorPublicJwk,
      operatorScope: authority.integrationOperatorScope,
      policyAuthority: "takoserver-host",
      verificationMode: "integration-fixture",
      verificationAvailable: true,
      productionEligible: false,
    };
  }
  if (invocation.surface === "takoserver-integration-form-authority-worker") {
    if (
      !authority.integrationWorkerName ||
      !authority.operatorPublicJwk ||
      !authority.integrationOperatorScope
    ) {
      throw preflightError(
        "selected integration target has no authenticated integration Form authority Worker",
      );
    }
    return {
      kind: "authority",
      workerName: authority.integrationWorkerName,
      hostId: authority.hostId,
      main: "src/entry-integration-form-authority-worker.ts",
      operatorPublicJwk: authority.operatorPublicJwk,
      operatorScope: authority.integrationOperatorScope,
      policyAuthority: "takoserver-host",
      verificationMode: "integration-fixture",
      verificationAvailable: true,
      productionEligible: false,
    };
  }
  return {
    kind: "authority",
    workerName: authority.workerName,
    hostId: authority.hostId,
    main: "src/entry-form-authority-worker.ts",
    policyAuthority: "takoserver-host",
    verificationMode: "released-core",
    verificationAvailable: true,
    productionEligible: false,
  };
}

interface AdoptionReadback {
  readonly plan: TargetAdoptionPlan;
  readonly candidate: ReturnType<typeof writeAdoptedTargetCandidate> | null;
}

/**
 * Sorts the observed drift into what the descriptor owns and what it does not,
 * and — only when the operator names a destination — writes the candidate.
 *
 * The plan itself is always computed, so an ordinary `--status` already says
 * which side of each difference could be the truth. Writing is a separate,
 * explicitly named act, and it never touches the descriptor.
 */
function adoptLive(
  invocation: FormAuthorityDeployInvocation,
  drift: readonly WorkerBindingDrift[],
  options: FormAuthorityDeployOptions,
): AdoptionReadback | null {
  if (invocation.action !== "status") return null;
  const plan = planTargetAdoption(drift, FORM_AUTHORITY_DESCRIPTOR_BINDINGS);
  if (invocation.adoptLivePath === undefined) return { plan, candidate: null };
  return {
    plan,
    candidate: writeAdoptedTargetCandidate({
      descriptorPath: options.targetDescriptorPath ?? targetPath(invocation.environment),
      candidatePath: invocation.adoptLivePath,
      environment: invocation.environment,
      plan,
    }),
  };
}

function invocationSurfaceIsIntegrationAuthority(selected: SelectedFormAuthorityTarget): boolean {
  return selected.kind === "authority" && selected.verificationMode === "integration-fixture";
}

function requiredOperatorPublicJwk(
  selected: SelectedFormAuthorityTarget,
): NonNullable<SelectedFormAuthorityTarget["operatorPublicJwk"]> {
  if (!selected.operatorPublicJwk) {
    throw preflightError("integration Form authority Worker has no dedicated operator public key");
  }
  return selected.operatorPublicJwk;
}

function requiredOperatorScope(
  selected: SelectedFormAuthorityTarget,
): NonNullable<SelectedFormAuthorityTarget["operatorScope"]> {
  if (!selected.operatorScope) {
    throw preflightError("integration Form authority Worker has no sealed operator scope");
  }
  return selected.operatorScope;
}

function isIntegrationOnlySurface(surface: FormAuthoritySurface): boolean {
  return surface !== "takoserver-form-authority-worker";
}

function routeMode(selected: SelectedFormAuthorityTarget): string {
  return selected.kind === "operator-gateway"
    ? "authenticated-integration-custom-domain"
    : "service-binding-rpc-only";
}

async function inspectPublicWorker(
  phase: DeployPhase,
  target: DeployTarget,
  state: FormAuthorityDeployState,
): Promise<PublicWorkerInspection> {
  const live = await inspectLiveWorkerVersion(phase, target, state, {
    authorityProfile: { kind: "provenance-bound-jit" },
  });
  return {
    history: live.history,
    commit: live.commit,
    workerArtifactDigest: `sha256:${live.bundleDigestHex}`,
  };
}

function assertSamePublicWorker(
  phase: DeployPhase,
  before: PublicWorkerInspection,
  after: PublicWorkerInspection,
): void {
  if (
    before.history.deploymentId !== after.history.deploymentId ||
    before.history.versionId !== after.history.versionId ||
    before.history.previousVersionId !== after.history.previousVersionId ||
    before.commit !== after.commit ||
    before.workerArtifactDigest !== after.workerArtifactDigest
  ) {
    throw phaseError(phase, "public Takoserver Worker changed during Form authority qualification");
  }
}

function versionIdentity(
  phase: DeployPhase,
  surface: FormAuthoritySurface,
  value: unknown,
): { readonly commit: string; readonly authorityArtifactDigest: `sha256:${string}` } {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    throw phaseError(phase, "Form authority Worker version has no canonical annotations");
  }
  const annotation = value.annotations["workers/message"];
  const match =
    typeof annotation === "string"
      ? /^form-authority:([^:]+):([0-9a-f]{40}):(sha256:[0-9a-f]{64})$/u.exec(annotation)
      : null;
  if (!match?.[1] || match[1] !== surface || !match[2] || !match[3]) {
    throw phaseError(phase, "Form authority Worker version identity is missing or mismatched");
  }
  return { commit: match[2], authorityArtifactDigest: match[3] as `sha256:${string}` };
}

function message(
  surface: FormAuthoritySurface,
  commit: string,
  authorityArtifactDigest: `sha256:${string}`,
): string {
  return `form-authority:${surface}:${commit}:${authorityArtifactDigest}`;
}

function assertSameVersion(
  before: FormAuthorityInspection | null,
  last: FormAuthorityInspection | null,
  phase: DeployPhase = "preflight",
): void {
  if (
    (before === null) !== (last === null) ||
    (before !== null &&
      last !== null &&
      (before.history.versionId !== last.history.versionId ||
        before.history.deploymentId !== last.history.deploymentId ||
        before.history.previousVersionId !== last.history.previousVersionId ||
        before.commit !== last.commit ||
        before.authorityArtifactDigest !== last.authorityArtifactDigest ||
        before.publicWorkerBindingProfile !== last.publicWorkerBindingProfile ||
        before.scopeBindingProfile !== last.scopeBindingProfile ||
        before.boundPublicWorkerVersionId !== last.boundPublicWorkerVersionId ||
        before.boundPublicWorkerArtifactDigest !== last.boundPublicWorkerArtifactDigest))
  ) {
    throw phaseError(phase, "Form authority Worker changed during qualification");
  }
}

async function checked(
  run: FormAuthorityProcess,
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
  const value = environment.CLOUDFLARE_API_TOKEN;
  if (!value) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return value;
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
