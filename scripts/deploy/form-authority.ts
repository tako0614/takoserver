import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalDigest, canonicalJson } from "../../src/json.ts";
import { deriveFormAuthorityIdentity } from "../../src/takoform/host-admission-endpoint.ts";
import {
  type TakoformLifecycleCapabilityManifest,
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  type YurucommuIdentityCapabilityKind,
  yurucommuLifecycleCapabilityManifest,
} from "../../src/takoform/implementation-catalog.ts";
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
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  inspectLiveWorkerVersion,
  isWorkerVersionId,
  workerVersionIdentity,
} from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";

export type FormAuthoritySurface =
  | "takoserver-form-authority-worker"
  | "takoserver-integration-form-authority-worker"
  | "takoserver-integration-form-authority-operator-worker";

export interface FormAuthorityDeployInvocation {
  readonly surface: FormAuthoritySurface;
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
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
  readonly publicWorkerBindingProfile: "exact-current-public" | "exact-direct-public-predecessor";
  readonly boundPublicWorkerVersionId: string;
  readonly boundPublicWorkerArtifactDigest: `sha256:${string}`;
}

interface PublicWorkerInspection {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly workerArtifactDigest: `sha256:${string}`;
}

interface PublicWorkerVersionIdentity {
  readonly versionId: string;
  readonly commit: string;
  readonly workerArtifactDigest: `sha256:${string}`;
}

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
  const selected = selectTarget(invocation, target);
  const capabilityManifest = targetCapabilityManifest(target);
  const capabilityManifestJson = canonicalJson(capabilityManifest);
  const capabilityDigest = await canonicalDigest(capabilityManifest);
  const run = options.run ?? runCommand;
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({ accountId: target.accountId, token: exactToken(environment) });
  const publicBefore = await inspectPublicWorker("preflight", target, state);
  const operatorIdentity = await deriveFormAuthorityIdentity({
    environment: invocation.environment,
    hostId: selected.hostId,
    workerArtifactDigest: publicBefore.workerArtifactDigest,
    publicWorkerVersionId: publicBefore.history.versionId,
    capabilities: capabilityManifest,
  });
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
      boundPublicWorkerVersionId: before?.boundPublicWorkerVersionId ?? null,
      boundPublicWorkerArtifactDigest: before?.boundPublicWorkerArtifactDigest ?? null,
      workerArtifactDigest: publicBefore.workerArtifactDigest,
      publicWorkerCommit: publicBefore.commit,
      publicWorkerVersionId: publicBefore.history.versionId,
      publicWorkerCommitMatches: publicBefore.commit === invocation.commit,
      capabilityDigest,
      implementationDigest: operatorIdentity.implementationDigest,
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
          }
        : {}),
      policyAuthority: selected.policyAuthority,
      verificationMode: selected.verificationMode,
      verificationAvailable: selected.verificationAvailable,
      productionEligible: selected.productionEligible,
      ready:
        before?.commit === invocation.commit &&
        before.publicWorkerBindingProfile === "exact-current-public" &&
        publicBefore.commit === invocation.commit &&
        (dependencySelected === null ||
          (dependencyBefore?.commit === invocation.commit &&
            dependencyBefore.publicWorkerBindingProfile === "exact-current-public")),
    };
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
      dependencyBefore.publicWorkerBindingProfile !== "exact-current-public")
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
      main: resolve(REPOSITORY, selected.main),
      writeConfig: ({ path, main }) =>
        writeFormAuthorityConfig({
          path,
          main,
          invocation: { ...invocation, commit: source.commit },
          target,
          selected,
          workerArtifactDigest: publicBefore.workerArtifactDigest,
          publicWorkerVersionId: publicBefore.history.versionId,
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
        dependencyAfter.publicWorkerBindingProfile !== "exact-current-public"
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
      after.publicWorkerBindingProfile !== "exact-current-public" ||
      after.commit !== source.commit ||
      after.authorityArtifactDigest !== authorityArtifactDigest
    ) {
      throw verificationError(
        "Form authority authoritative history does not identify the exact uploaded successor",
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
      implementationDigest: operatorIdentity.implementationDigest,
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
          }
        : {}),
      policyAuthority: selected.policyAuthority,
      verificationMode: selected.verificationMode,
      verificationAvailable: selected.verificationAvailable,
      productionEligible: selected.productionEligible,
      rollback: before
        ? `wrangler versions deploy ${before.history.versionId}@100% --yes --name ${selected.workerName}`
        : "forward repair only: no previous Form authority Worker version exists",
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

export function writeFormAuthorityConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly invocation: FormAuthorityDeployInvocation;
  readonly target: DeployTarget;
  readonly selected: SelectedFormAuthorityTarget;
  readonly workerArtifactDigest: `sha256:${string}`;
  readonly publicWorkerVersionId: string;
  readonly capabilityManifestJson: string;
}): string {
  if (!/^[0-9a-f]{40}$/u.test(input.invocation.commit)) {
    throw preflightError("Form authority config requires one exact commit");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.workerArtifactDigest)) {
    throw preflightError("Form authority config requires one exact public Worker artifact digest");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      input.publicWorkerVersionId,
    )
  ) {
    throw preflightError("Form authority config requires one exact public Worker Version id");
  }
  if (canonicalJson(targetCapabilityManifest(input.target)) !== input.capabilityManifestJson) {
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
  const configuration =
    input.selected.kind === "operator-gateway"
      ? operatorGatewayConfiguration(input, shared)
      : {
          ...shared,
          vars: {
            TAKOSERVER_ENVIRONMENT: input.invocation.environment,
            TAKOSERVER_FORM_AUTHORITY_HOST_ID: input.selected.hostId,
            TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: input.workerArtifactDigest,
            TAKOSERVER_PUBLIC_WORKER_VERSION_ID: input.publicWorkerVersionId,
            TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: input.capabilityManifestJson,
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
        };
  writeFileSync(input.path, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return input.path;
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
      TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: input.workerArtifactDigest,
      TAKOSERVER_PUBLIC_WORKER_VERSION_ID: input.publicWorkerVersionId,
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
  publicWorker: PublicWorkerInspection,
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
    publicWorker,
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
  publicWorker: PublicWorkerInspection,
  capabilityManifestJson: string,
  state: FormAuthorityDeployState,
): Promise<
  Pick<
    FormAuthorityInspection,
    "publicWorkerBindingProfile" | "boundPublicWorkerVersionId" | "boundPublicWorkerArtifactDigest"
  >
> {
  const currentExpected = expectedBindings(
    invocation.environment,
    target,
    selected,
    publicWorker.workerArtifactDigest,
    publicWorker.history.versionId,
    capabilityManifestJson,
  );
  if (hasExactBindingClosure(phase, authorityVersionId, authorityVersion, currentExpected)) {
    if (authorityCommit !== publicWorker.commit) {
      throw phaseError(
        phase,
        "Form authority current-public closure commit differs from the public Worker commit",
      );
    }
    return {
      publicWorkerBindingProfile: "exact-current-public",
      boundPublicWorkerVersionId: publicWorker.history.versionId,
      boundPublicWorkerArtifactDigest: publicWorker.workerArtifactDigest,
    };
  }

  const predecessor = await inspectDirectPublicPredecessor(phase, target, state, publicWorker);
  assertExactVersionBindingClosure(
    phase,
    authorityVersionId,
    authorityVersion,
    expectedBindings(
      invocation.environment,
      target,
      selected,
      predecessor.workerArtifactDigest,
      predecessor.versionId,
      capabilityManifestJson,
    ),
  );
  if (authorityCommit !== predecessor.commit) {
    throw phaseError(
      phase,
      "Form authority direct-predecessor closure commit differs from the predecessor public Worker commit",
    );
  }
  return {
    publicWorkerBindingProfile: "exact-direct-public-predecessor",
    boundPublicWorkerVersionId: predecessor.versionId,
    boundPublicWorkerArtifactDigest: predecessor.workerArtifactDigest,
  };
}

async function inspectDirectPublicPredecessor(
  phase: DeployPhase,
  target: DeployTarget,
  state: FormAuthorityDeployState,
  current: PublicWorkerInspection,
): Promise<PublicWorkerVersionIdentity> {
  const versionId = current.history.previousVersionId;
  if (versionId === null || !isWorkerVersionId(versionId)) {
    throw phaseError(
      phase,
      "Form authority closure is not current and public history has no exact direct predecessor",
    );
  }
  const version = await state.workerVersion(target.workerName, versionId);
  const identity = workerVersionIdentity(phase, version);
  assertExactVersionBindingClosure(phase, versionId, version, expectedExactBindingClosure(target));
  return {
    versionId,
    commit: identity.commit,
    workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
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
  workerArtifactDigest: `sha256:${string}`,
  publicWorkerVersionId: string,
  capabilityManifestJson: string,
) {
  if (selected.kind === "operator-gateway") {
    if (
      !selected.authorityWorkerName ||
      !selected.operatorOrigin ||
      !selected.operatorPublicJwk ||
      !selected.operatorScope
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
      TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: {
        type: "plain_text",
        fields: { text: workerArtifactDigest },
      },
      TAKOSERVER_PUBLIC_WORKER_VERSION_ID: {
        type: "plain_text",
        fields: { text: publicWorkerVersionId },
      },
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: {
        type: "plain_text",
        fields: { text: canonicalJson(selected.operatorPublicJwk) },
      },
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: {
        type: "plain_text",
        fields: { text: requiredOperatorScope(selected).tenantId },
      },
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: {
        type: "plain_text",
        fields: { text: requiredOperatorScope(selected).space },
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
    TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: {
      type: "plain_text",
      fields: { text: workerArtifactDigest },
    },
    TAKOSERVER_PUBLIC_WORKER_VERSION_ID: {
      type: "plain_text",
      fields: { text: publicWorkerVersionId },
    },
    TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: {
      type: "plain_text",
      fields: { text: capabilityManifestJson },
    },
    ...(invocationSurfaceIsIntegrationAuthority(selected)
      ? {
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: {
            type: "plain_text",
            fields: { text: canonicalJson(requiredOperatorPublicJwk(selected)) },
          },
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: {
            type: "plain_text",
            fields: { text: requiredOperatorScope(selected).tenantId },
          },
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: {
            type: "plain_text",
            fields: { text: requiredOperatorScope(selected).space },
          },
        }
      : {}),
  } as const;
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
    verificationAvailable: false,
    productionEligible: false,
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

export function targetCapabilityManifest(
  target: DeployTarget,
): TakoformLifecycleCapabilityManifest {
  const kinds = target.edgeSupplies?.offerings.map(({ formKind }) => formKind) ?? [];
  const actual = [...kinds].sort();
  const expected = [...YURUCOMMU_IDENTITY_CAPABILITY_KINDS].sort();
  if (actual.length !== expected.length || actual.some((kind, index) => kind !== expected[index])) {
    throw preflightError(
      "Form authority requires the exact four realized Yurucommu identity capabilities",
    );
  }
  return yurucommuLifecycleCapabilityManifest(
    kinds as YurucommuIdentityCapabilityKind[],
    target.formAuthority?.operatorOperations,
  );
}

async function inspectPublicWorker(
  phase: DeployPhase,
  target: DeployTarget,
  state: FormAuthorityDeployState,
): Promise<PublicWorkerInspection> {
  const live = await inspectLiveWorkerVersion(phase, target, state, {});
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
