import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../src/json.ts";
import {
  applicationSchemaMatches,
  deriveExpectedApplicationShape,
} from "./application-schema-shape.ts";
import {
  artifactBlobIoSchemaAllowsPending,
  probeArtifactBlobIoQuiescence,
} from "./artifact-blob-io-compatibility.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  type FreshV2ArtifactIntegrationStorageTargetProof,
  type IntegrationStorageGenerationTargetVerificationOptions,
  verifyFreshV2ArtifactIntegrationStorageTarget,
} from "./integration-storage-generation.ts";
import { pendingMigrations, readD1SchemaState, readMigrationArtifact } from "./migrations.ts";
import {
  type CommandResult,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import { writeWorkerConfig } from "./realized-config.ts";
import { runAuthorityTransition } from "./retirement.ts";
import { readCurrentAuditedMigrationSourceArtifact } from "./schema.ts";
import {
  activePublicJwk,
  createRemoteSigningDatabase,
  type SigningDatabase,
  type SigningPublicKeyRow,
} from "./signing.ts";
import { type DeployTarget, isArtifactBlobIoQuiescedTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { authoritySensitiveWorkerPaths } from "./worker-authority-paths.ts";
import { assertTargetComposes } from "./worker-composition.ts";
import { parseWorkerDeploymentHistory, type WorkerDeploymentHistory } from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  inspectWranglerVersionPublicationLease,
  publishWranglerVersion,
  type WranglerVersionPublication,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

export type WorkerProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export type { WorkerState } from "./worker-live.ts";
export { isWorkerVersionId } from "./worker-live.ts";

import {
  inspectLiveWorkerVersion,
  inspectLiveWorkerVersionForLegacyStatus,
  inspectLiveWorkerVersionWithLegacyPredecessor,
  isWorkerVersionId,
  type LEGACY_PRE_VERSION_METADATA_PROFILE,
  LEGACY_UNATTRIBUTED_PREDECESSOR,
  type WorkerState,
  type WorkerVersionAuthoritySelection,
} from "./worker-live.ts";

export interface WorkerMigrationReader {
  read(): Promise<{
    readonly local: readonly string[];
    readonly applied: readonly string[];
    readonly shape?: string;
    readonly shapeDigest?: string;
  }>;
}

export interface WorkerInvocation {
  readonly surface: "takoserver-worker" | "takoserver-worker-authority-cutover";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly legacyPredecessorVersionId?: string;
  readonly legacyHostRuntimePredecessorVersionId?: string;
  readonly reverse?: boolean;
}

export interface WorkerOptions {
  readonly run?: WorkerProcess;
  readonly state?: WorkerState;
  readonly migrations?: WorkerMigrationReader;
  readonly outputDirectory?: string;
  /** Checkout whose source and migration bytes define the publication. */
  readonly sourceRepositoryRoot?: string;
  /** Wrangler executable selected by the composing owner. */
  readonly wranglerPath?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly review?: string;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Owner-private lease root override for portable tests. */
  readonly publicationLeaseRoot?: string;
  /** Authoritative active runtime-signing identity; injectable only for portable tests. */
  readonly signingDatabase?: Pick<SigningDatabase, "readKey">;
  /** Exact private-executor qualification seam; injectable only for portable tests. */
  readonly providerExecutorQualification?: WorkerProviderExecutorQualification;
  /** Read-only generated-storage verifier inputs; injectable only for portable tests. */
  readonly integrationStorageVerification?: Omit<
    IntegrationStorageGenerationTargetVerificationOptions,
    "run" | "cloudflareEnvironment" | "wranglerPath"
  >;
}

/** Immutable, value-free projection read by public lifecycle code. */
export interface ProviderExecutorDependencyInspection {
  readonly ready: boolean;
  readonly receiptAuthorityReady: boolean;
  readonly receiptAuthorityVersionId: string | null;
  readonly managedWorkerGatewayReady: boolean;
  readonly managedWorkerGatewayVersionId: string | null;
}

/**
 * Provider-neutral qualification supplied by the owner of a managed backend.
 * Concrete module bytes, credentials and provider state never cross this seam.
 */
export interface ProviderExecutorInspection {
  readonly status: "absent" | "ready" | "stale" | "drift";
  readonly ready: boolean;
  readonly managedExact: boolean;
  readonly routeLess: boolean;
  readonly schemaReady: boolean;
  readonly dependencies: ProviderExecutorDependencyInspection;
  readonly versionId: string | null;
  readonly deploymentId: string | null;
  readonly previousVersionId: string | null;
  readonly commit: string | null;
  readonly bundleDigestHex: string | null;
  readonly moduleDigestHex: string | null;
  /** Owner-proved, non-serving predecessor publication for the integration 0088 wave. */
  readonly maintenance?: {
    readonly mode: "pre-v2-0088-quiesced";
    readonly accountId: string;
    readonly databaseId: string;
    readonly databaseName: string;
    readonly workerName: string;
    readonly activeVersionId: string;
    readonly activeDeploymentId: string;
    readonly previousVersionId: string;
    readonly selectedSourceCommit: string;
    readonly selectedModuleDigestHex: string;
    readonly predecessorSourceCommit: string;
    readonly predecessorVersionId: string;
    readonly observedNonCodeDigestHex: string;
  };
}

export function providerExecutorAllowsPublication(
  target: DeployTarget,
  inspection: ProviderExecutorInspection | null,
): boolean {
  if (inspection === null) return true;
  if (target.schemaMaintenanceMode !== "pre-v2-0088-quiesced") return inspection.ready;
  const proof = inspection.maintenance;
  return (
    proof?.mode === target.schemaMaintenanceMode &&
    !inspection.ready &&
    !inspection.schemaReady &&
    inspection.managedExact &&
    inspection.routeLess &&
    proof.accountId === target.accountId &&
    proof.databaseId === target.d1.databaseId &&
    proof.databaseName === target.d1.databaseName &&
    proof.workerName === target.cloudflareProviderExecutor?.workerName &&
    proof.activeVersionId === inspection.versionId &&
    proof.activeDeploymentId === inspection.deploymentId &&
    proof.previousVersionId === inspection.previousVersionId &&
    proof.selectedSourceCommit === inspection.commit &&
    proof.selectedModuleDigestHex === inspection.moduleDigestHex &&
    proof.predecessorVersionId === inspection.previousVersionId &&
    /^[0-9a-f]{40}$/u.test(proof.predecessorSourceCommit) &&
    /^[0-9a-f]{64}$/u.test(proof.observedNonCodeDigestHex)
  );
}

export interface WorkerProviderExecutorQualification {
  read(phase: "preflight" | "verification"): Promise<ProviderExecutorInspection>;
}

interface WorkerInspection {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string | null;
  readonly bundleDigestHex: string | null;
  readonly predecessorIdentity?: typeof LEGACY_UNATTRIBUTED_PREDECESSOR;
  readonly legacyPredecessorProfile?: typeof LEGACY_PRE_VERSION_METADATA_PROFILE;
  readonly migrations: { readonly local: readonly string[]; readonly applied: readonly string[] };
  readonly pending: readonly string[];
  readonly integrationE2eCredentialAuthorityConfigured: boolean;
}

const SCHEMA_0058_NAME = "0058_cloudflare_managed_worker_domain_receipts.sql";

/** Non-serving source profiles only; neither is authority to apply a pending migration. */
export function workerSchemaAllowsPending(
  target: DeployTarget,
  migrations: {
    readonly local: readonly string[];
    readonly applied: readonly string[];
    readonly shape?: string;
    readonly shapeDigest?: string;
  },
  sourceRepositoryRoot = REPOSITORY,
): boolean {
  if (target.schemaMaintenanceMode === "pre-v2-0088-quiesced") {
    if (target.environment !== "integration" || target.artifactBlobIoMode !== undefined) {
      return false;
    }
    const source = readCurrentAuditedMigrationSourceArtifact(
      resolve(sourceRepositoryRoot, "migrations"),
    );
    const count = migrations.applied.length;
    if (
      count < 66 ||
      count > 88 ||
      JSON.stringify(migrations.local) !== JSON.stringify(source.names) ||
      migrations.applied.some((name, index) => name !== source.names[index]) ||
      migrations.shape === undefined ||
      migrations.shapeDigest === undefined
    ) {
      return false;
    }
    return applicationSchemaMatches(
      { applied: migrations.applied, shape: migrations.shape, shapeDigest: migrations.shapeDigest },
      deriveExpectedApplicationShape(source.files.slice(0, count)),
    );
  }
  if (target.schemaMaintenanceMode !== "pre-0058-quiesced") {
    return artifactBlobIoSchemaAllowsPending(
      target,
      pendingMigrations(migrations.local, migrations.applied),
    );
  }
  if (target.artifactBlobIoMode !== undefined) return false;
  const source = readMigrationArtifact(resolve(sourceRepositoryRoot, "migrations"));
  if (JSON.stringify(migrations.local) !== JSON.stringify(source.names)) return false;
  if (migrations.applied.length !== 57 || source.names[57] !== SCHEMA_0058_NAME) return false;
  return migrations.applied.every((name, index) => name === source.names[index]);
}

export async function probeSchemaMaintenance(
  origin: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  mode: NonNullable<DeployTarget["schemaMaintenanceMode"]> = "pre-0058-quiesced",
): Promise<{ readonly url: string; readonly status: 503; readonly traffic: "maintenance" }> {
  const url = `${origin}/healthz`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
      redirect: "error",
    });
  } catch (error) {
    throw verificationError(
      "schema maintenance Worker probe failed",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    response.status !== 503 ||
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("retry-after") !== "60" ||
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    typeof body.error !== "object" ||
    body.error === null ||
    !("code" in body.error) ||
    body.error.code !== "backend_unavailable" ||
    !("message" in body.error) ||
    body.error.message !==
      (mode === "pre-0058-quiesced"
        ? "Host is quiesced for the 0058 schema maintenance transition"
        : "Host is quiesced for the v2 0088 schema maintenance transition") ||
    !("details" in body.error) ||
    typeof body.error.details !== "object" ||
    body.error.details === null ||
    !("reason" in body.error.details) ||
    body.error.details.reason !== "runtime-configuration"
  ) {
    throw verificationError(
      "schema maintenance Worker did not prove maintenance refusal",
      `status=${response.status}`,
    );
  }
  return { url, status: 503, traffic: "maintenance" };
}

export { authoritySensitiveWorkerPaths } from "./worker-authority-paths.ts";

/** Routine or explicitly reviewed authority-sensitive Worker code publication. */
export async function runWorker(
  invocation: WorkerInvocation,
  target: DeployTarget,
  options: WorkerOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("Worker invocation and target environments differ");
  }
  if (target.artifactBlobIoMode !== undefined && target.schemaMaintenanceMode !== undefined) {
    throw preflightError("Worker maintenance selectors conflict");
  }
  if (invocation.legacyPredecessorVersionId !== undefined) {
    if (invocation.surface !== "takoserver-worker-authority-cutover") {
      throw preflightError(
        "legacy predecessor bootstrap requires takoserver-worker-authority-cutover",
      );
    }
    if (invocation.environment !== "integration") {
      throw preflightError("legacy predecessor bootstrap is integration-only");
    }
    if (!isWorkerVersionId(invocation.legacyPredecessorVersionId)) {
      throw preflightError("legacy predecessor Version ID must be one exact UUID");
    }
  }
  const run = options.run ?? runCommand;
  const sourceRepositoryRoot = resolve(options.sourceRepositoryRoot ?? REPOSITORY);
  const credential =
    invocation.environment === "integration" &&
    options.state !== undefined &&
    invocation.action === "status"
      ? undefined
      : await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
          ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
        });
  const environment = credential?.childEnvironment ?? {};
  // Before any live read or upload: the selected target must compose the
  // Worker the same way the Worker composes itself on its first request.
  await assertTargetComposes("preflight", target);
  const v2StorageBefore =
    target.takoformV2 === undefined || target.schemaMaintenanceMode === "pre-v2-0088-quiesced"
      ? null
      : await readFreshV2StorageProof(
          "preflight",
          target,
          invocation.environment,
          options,
          run,
          sourceRepositoryRoot,
        );
  const cloudflareState =
    options.state === undefined
      ? new CloudflareState({
          accountId: target.accountId,
          token: credential?.token ?? exactToken(environment),
        })
      : null;
  const state = options.state ?? cloudflareState;
  if (state === null) throw preflightError("Worker state is unavailable");
  const providerExecutorQualification = isArtifactBlobIoQuiescedTarget(target)
    ? null
    : providerExecutorQualificationReader({
        target,
        ...(options.providerExecutorQualification === undefined
          ? {}
          : { injected: options.providerExecutorQualification }),
      });
  const providerExecutorBefore =
    providerExecutorQualification === null
      ? null
      : await providerExecutorQualification.read("preflight");
  if (
    invocation.action === "apply" &&
    !providerExecutorAllowsPublication(target, providerExecutorBefore)
  ) {
    throw preflightError(
      "public Worker publication requires the exact selected-commit Cloudflare provider executor",
    );
  }
  if (invocation.legacyHostRuntimePredecessorVersionId !== undefined) {
    if (invocation.surface !== "takoserver-worker-authority-cutover") {
      throw preflightError(
        "legacy Host-runtime predecessor transition requires takoserver-worker-authority-cutover",
      );
    }
    const transition = await runAuthorityTransition(
      {
        surface: "takoserver-worker-authority-cutover",
        action: invocation.action,
        environment: invocation.environment,
        commit: invocation.commit,
        legacyHostRuntimePredecessorVersionId: invocation.legacyHostRuntimePredecessorVersionId,
        ...(invocation.reverse ? { reverse: true } : {}),
      },
      target,
      state,
      run,
      { ...options, cloudflareEnvironment: environment },
    );
    return withProviderExecutorQualification(transition, providerExecutorBefore);
  }
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-worker-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let publicationLease: WranglerVersionPublicationLease | null = null;
  try {
    const inspectionConfig = writeWorkerConfig(target, {
      path: join(root, "inspect-wrangler.jsonc"),
      main: resolve(sourceRepositoryRoot, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
      sourceRepositoryRoot,
      ...(target.integrationE2eCredentialAuthority === undefined
        ? {}
        : { authorityProfile: { kind: "historical-pre-jit" as const } }),
    });
    const migrations =
      options.migrations ??
      remoteMigrationReader(
        inspectionConfig,
        environment,
        run,
        sourceRepositoryRoot,
        options.wranglerPath,
      );
    const signingDatabase =
      target.integrationE2eCredentialAuthority === undefined
        ? undefined
        : (options.signingDatabase ??
          createRemoteSigningDatabase(inspectionConfig, environment, run, (args) =>
            deployWranglerCommand(options.wranglerPath, args),
          ));
    const signingIdentity =
      signingDatabase === undefined
        ? undefined
        : await requireDistinctIntegrationE2eSigningIdentity(target, signingDatabase);
    const beforeAuthorityProfile = await authoritySelectionForCurrent("preflight", target, state, {
      ...(invocation.legacyPredecessorVersionId === undefined
        ? {}
        : { legacyPredecessorVersionId: invocation.legacyPredecessorVersionId }),
    });
    const before = await inspectWorker("preflight", target, state, migrations, {
      ...(invocation.legacyPredecessorVersionId === undefined
        ? {}
        : {
            legacyPredecessorVersionId: invocation.legacyPredecessorVersionId,
            reconcileStatus: invocation.action === "status",
          }),
      ...(beforeAuthorityProfile === undefined ? {} : { authorityProfile: beforeAuthorityProfile }),
    });
    const versionPublication =
      invocation.surface === "takoserver-worker" && invocation.environment !== "production";

    if (
      target.schemaMaintenanceMode !== undefined &&
      !workerSchemaAllowsPending(target, before.migrations, sourceRepositoryRoot)
    ) {
      throw preflightError("0058 Worker maintenance requires exact applied 0057 and 0058 next");
    }

    if (invocation.action === "status") {
      const advancedFromSelector =
        invocation.legacyPredecessorVersionId !== undefined &&
        before.history.versionId !== invocation.legacyPredecessorVersionId;
      const legacyProfileCurrent = before.legacyPredecessorProfile !== undefined;
      return {
        kind: "takoserver.worker-status@v2",
        surface: invocation.surface,
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        deployedCommit: before.commit,
        commitMatches: before.commit === invocation.commit,
        deploymentId: before.history.deploymentId,
        versionId: before.history.versionId,
        previousVersionId: before.history.previousVersionId,
        artifactDigest: before.bundleDigestHex === null ? null : `sha256:${before.bundleDigestHex}`,
        appliedMigrations: before.migrations.applied,
        pendingMigrations: before.pending,
        ...(target.schemaMaintenanceMode === undefined
          ? {}
          : { maintenance: target.schemaMaintenanceMode }),
        integrationE2eCredentialAuthorityConfigured:
          before.integrationE2eCredentialAuthorityConfigured,
        ...providerExecutorStatus(providerExecutorBefore),
        ...(versionPublication
          ? {
              publicationLease: inspectWranglerVersionPublicationLease({
                accountId: target.accountId,
                workerName: target.workerName,
                ...(options.publicationLeaseRoot === undefined
                  ? {}
                  : { root: options.publicationLeaseRoot }),
              }),
            }
          : {}),
        ready:
          target.schemaMaintenanceMode === undefined &&
          workerSchemaAllowsPending(target, before.migrations, sourceRepositoryRoot) &&
          !legacyProfileCurrent &&
          (target.integrationE2eCredentialAuthority === undefined ||
            before.integrationE2eCredentialAuthorityConfigured) &&
          (providerExecutorBefore === null || providerExecutorBefore.ready) &&
          (!advancedFromSelector || before.commit === invocation.commit),
        ...(advancedFromSelector
          ? {
              legacyPredecessorVersionId: invocation.legacyPredecessorVersionId,
              cutoverState:
                before.commit === invocation.commit
                  ? "selected-commit-current"
                  : "different-commit-current",
            }
          : {}),
        ...(!legacyProfileCurrent
          ? {}
          : {
              ...(invocation.legacyPredecessorVersionId === undefined
                ? {}
                : { legacyPredecessorVersionId: invocation.legacyPredecessorVersionId }),
              ...(before.predecessorIdentity === undefined
                ? {}
                : { predecessorIdentity: before.predecessorIdentity }),
              authorityScope: "entire-worker-artifact",
              cutoverState: "legacy-predecessor-current",
            }),
      };
    }

    const source = await qualifySource({
      environment: invocation.environment,
      commit: invocation.commit,
      run,
    });
    if (!workerSchemaAllowsPending(target, before.migrations, sourceRepositoryRoot)) {
      throw preflightError(
        "routine Worker publication refuses pending D1 migrations; apply takoserver-d1-schema first",
        JSON.stringify(before.pending),
      );
    }
    const legacyBootstrap = before.legacyPredecessorProfile !== undefined;
    const changedPaths = legacyBootstrap
      ? null
      : before.commit === null
        ? (() => {
            throw preflightError("Worker predecessor identity is unavailable");
          })()
        : await sourceDiff(run, before.commit, source.commit, source.changedPaths);
    const authorityPaths =
      changedPaths === null ? null : authoritySensitiveWorkerPaths(changedPaths);
    let reviewer: string | null = null;
    if (
      invocation.surface === "takoserver-worker" &&
      authorityPaths !== null &&
      authorityPaths.length > 0
    ) {
      throw preflightError(
        "authority-sensitive Worker diff requires takoserver-worker-authority-cutover",
        JSON.stringify(authorityPaths),
      );
    }
    if (invocation.surface === "takoserver-worker-authority-cutover") {
      reviewer = exactReviewer(
        options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
      );
    }

    await checked(run, "preflight", "scoped owner gate `bun run check`", ["bun", "run", "check"]);

    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      sourceRepositoryRoot,
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
      run,
      environment,
      ...(versionPublication ? { dryRunCommand: "versions-upload" as const } : {}),
      writeConfig: ({ path, main, bundleDigestHex, formImplementationIdentity }) =>
        writeWorkerConfig(target, {
          path,
          main,
          commit: source.commit,
          sourceRepositoryRoot,
          ...(formImplementationIdentity === undefined ? {} : { formImplementationIdentity }),
          ...(bundleDigestHex === undefined
            ? {}
            : { workerArtifactDigest: `sha256:${bundleDigestHex}` as const }),
          ...(versionPublication ? { topology: "version-only" as const } : {}),
          ...(target.integrationE2eCredentialAuthority === undefined
            ? {}
            : bundleDigestHex === undefined
              ? { authorityProfile: { kind: "historical-pre-jit" as const } }
              : {
                  authorityProfile: {
                    kind: "provenance-bound-jit" as const,
                    provenance: {
                      sourceCommit: source.commit,
                      artifactDigest: `sha256:${bundleDigestHex}` as const,
                    },
                  },
                }),
        }),
    });
    const { bundlePath, configPath, bundleDigestHex } = prepared;
    const artifact = prepared.seal();
    artifact.assertUnchanged();
    if (versionPublication) {
      publicationLease = await acquireWranglerVersionPublicationLease({
        accountId: target.accountId,
        workerName: target.workerName,
        ...(options.publicationLeaseRoot === undefined
          ? {}
          : { root: options.publicationLeaseRoot }),
      });
    }
    if (!legacyBootstrap) {
      const last = await inspectWorker("preflight", target, state, migrations, {
        ...(beforeAuthorityProfile === undefined
          ? {}
          : { authorityProfile: beforeAuthorityProfile }),
      });
      assertWorkerInspectionUnchanged(
        before,
        last,
        "Worker state or integration E2E credential authority changed before upload",
      );
    }
    if (signingDatabase !== undefined && signingIdentity !== undefined) {
      const lastSigningIdentity = await requireDistinctIntegrationE2eSigningIdentity(
        target,
        signingDatabase,
      );
      if (!sameSigningIdentity(signingIdentity, lastSigningIdentity)) {
        throw preflightError("active runtime signing identity changed before Worker upload");
      }
    }
    if (providerExecutorQualification !== null && providerExecutorBefore !== null) {
      const currentProviderExecutor = await providerExecutorQualification.read("preflight");
      assertProviderExecutorUnchanged(
        providerExecutorBefore,
        currentProviderExecutor,
        "preflight",
        target,
      );
    }
    if (legacyBootstrap) {
      const selector = invocation.legacyPredecessorVersionId;
      if (selector === undefined) {
        throw preflightError("Worker legacy predecessor selector is unavailable");
      }
      const last = await inspectLiveWorkerVersionWithLegacyPredecessor("preflight", target, state, {
        legacyPredecessorVersionId: selector,
        ...(beforeAuthorityProfile === undefined
          ? {}
          : { authorityProfile: beforeAuthorityProfile }),
      });
      if (
        last.history.versionId !== before.history.versionId ||
        last.legacyPredecessorProfile !== before.legacyPredecessorProfile ||
        last.commit !== before.commit ||
        last.bundleDigestHex !== before.bundleDigestHex ||
        ("predecessorIdentity" in last ? last.predecessorIdentity : undefined) !==
          before.predecessorIdentity
      ) {
        throw preflightError(
          "pinned legacy predecessor identity or binding profile changed before upload",
        );
      }
    }
    if (
      target.artifactBlobIoMode === undefined &&
      target.schemaMaintenanceMode === undefined &&
      target.takoformV2 === undefined
    ) {
      throw preflightError(
        "serving Worker publication requires explicit target.takoformV2.config and the separately installed TAKOSERVER_TAKOFORM_V2_CURSOR_KEY secret; select an integration v2 target before apply",
      );
    }
    if (v2StorageBefore !== null) {
      const finalStorage = await readFreshV2StorageProof(
        "preflight",
        target,
        invocation.environment,
        options,
        run,
        sourceRepositoryRoot,
      );
      assertFreshV2StorageProofUnchanged("preflight", v2StorageBefore, finalStorage);
    }
    const message = `takoserver-worker:${source.commit}:${bundleDigestHex}`;
    let publication: WranglerVersionPublication | null;
    if (versionPublication) {
      if (publicationLease === null) {
        throw preflightError("Worker Version publication lease is unavailable");
      }
      publication = await publishWranglerVersion({
        root,
        bundlePath,
        configPath,
        accountId: target.accountId,
        workerName: target.workerName,
        message,
        lease: publicationLease,
        environment,
        run,
        ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
        assertPredecessorStillCurrent: async () => {
          const current = await inspectWorker("preflight", target, state, migrations, {
            ...(beforeAuthorityProfile === undefined
              ? {}
              : { authorityProfile: beforeAuthorityProfile }),
          });
          assertWorkerInspectionUnchanged(
            before,
            current,
            "Worker state changed after Version upload and before traffic deployment",
          );
          if (providerExecutorQualification !== null && providerExecutorBefore !== null) {
            const currentProviderExecutor = await providerExecutorQualification.read("preflight");
            assertProviderExecutorUnchanged(
              providerExecutorBefore,
              currentProviderExecutor,
              "preflight",
              target,
            );
          }
        },
      });
    } else {
      publication = await (async () => {
        const upload = await run(
          deployWranglerCommand(options.wranglerPath, [
            "deploy",
            bundlePath,
            "--no-bundle",
            "--config",
            configPath,
            "--strict",
            "--message",
            message,
          ]),
          { env: environment },
        );
        if (upload.exitCode !== 0) {
          throw mutationError(
            "Worker upload acknowledgement is indeterminate; do not retry before --status",
            `${upload.stdout}${upload.stderr}`.trim(),
          );
        }
        return null;
      })();
    }

    const afterAuthorityProfile =
      target.integrationE2eCredentialAuthority === undefined
        ? undefined
        : {
            kind: "provenance-bound-jit" as const,
            provenance: {
              sourceCommit: source.commit,
              artifactDigest: `sha256:${bundleDigestHex}` as const,
            },
          };
    const after = await inspectWorker("verification", target, state, migrations, {
      ...(afterAuthorityProfile === undefined ? {} : { authorityProfile: afterAuthorityProfile }),
    });
    const rollbackVersionId = after.history.previousVersionId;
    if (after.history.versionId === before.history.versionId || rollbackVersionId === null) {
      throw verificationError(
        "authoritative Worker deployment history does not identify a new current Version and its actual immediate predecessor",
      );
    }
    if (
      publication !== null &&
      (after.history.versionId !== publication.versionId ||
        after.history.deploymentId !== publication.deploymentId)
    ) {
      throw verificationError(
        "Wrangler publication identity does not match authoritative Worker readback",
      );
    }
    if (after.commit !== source.commit || after.bundleDigestHex !== bundleDigestHex) {
      throw verificationError("served Worker annotation does not identify the sealed upload");
    }
    if (!workerSchemaAllowsPending(target, after.migrations, sourceRepositoryRoot)) {
      throw verificationError("Worker publication left pending D1 migrations");
    }
    if (v2StorageBefore !== null) {
      const servedStorage = await readFreshV2StorageProof(
        "verification",
        target,
        invocation.environment,
        options,
        run,
        sourceRepositoryRoot,
      );
      assertFreshV2StorageProofUnchanged("verification", v2StorageBefore, servedStorage);
    }
    const providerExecutorAfter =
      providerExecutorQualification === null
        ? null
        : await providerExecutorQualification.read("verification");
    if (providerExecutorBefore !== null && providerExecutorAfter !== null) {
      assertProviderExecutorUnchanged(
        providerExecutorBefore,
        providerExecutorAfter,
        "verification",
        target,
      );
    }
    const probe =
      target.schemaMaintenanceMode !== undefined
        ? await probeSchemaMaintenance(
            target.publicOrigin,
            options.fetcher ?? ((input, init) => fetch(input, init)),
            target.schemaMaintenanceMode,
          )
        : target.artifactBlobIoMode === "pre-0043-quiesced"
          ? await probeArtifactBlobIoQuiescence(
              target.publicOrigin,
              options.fetcher ?? ((input, init) => fetch(input, init)),
            )
          : await probeProduct(
              target.publicOrigin,
              options.fetcher ?? ((input, init) => fetch(input, init)),
            );
    return {
      kind: "takoserver.worker-apply@v2",
      surface: invocation.surface,
      environment: invocation.environment,
      commit: source.commit,
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      changedPaths,
      authorityPaths,
      ...(legacyBootstrap ? { worktreePaths: source.changedPaths } : {}),
      reviewer,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      bundleDigest: `sha256:${bundleDigestHex}`,
      preMutationObservedVersionId: before.history.versionId,
      previousVersionId: rollbackVersionId,
      deploymentId: after.history.deploymentId,
      versionId: after.history.versionId,
      probe,
      ...(target.schemaMaintenanceMode === undefined
        ? {}
        : { maintenance: target.schemaMaintenanceMode }),
      ...providerExecutorStatus(providerExecutorAfter),
      ...(publication === null
        ? {}
        : {
            publication: "versions-upload-and-deploy",
            uploadedVersionId: publication.versionId,
            publicationDeploymentId: publication.deploymentId,
          }),
      ...(!legacyBootstrap
        ? {}
        : {
            ...(invocation.legacyPredecessorVersionId === undefined
              ? {}
              : { legacyPredecessorVersionId: invocation.legacyPredecessorVersionId }),
            ...(before.predecessorIdentity === undefined
              ? {}
              : { predecessorIdentity: before.predecessorIdentity }),
            authorityScope: "entire-worker-artifact",
          }),
      rollback:
        `wrangler versions deploy ${rollbackVersionId}@100% --yes ` + `--name ${target.workerName}`,
    };
  } finally {
    await publicationLease?.release();
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function readFreshV2StorageProof(
  phase: "preflight" | "verification",
  target: DeployTarget,
  environment: DeployEnvironment,
  options: WorkerOptions,
  run: WorkerProcess,
  sourceRepositoryRoot: string,
): Promise<FreshV2ArtifactIntegrationStorageTargetProof> {
  try {
    return await verifyFreshV2ArtifactIntegrationStorageTarget(target, environment, {
      ...options.integrationStorageVerification,
      run,
      ...(options.cloudflareEnvironment === undefined
        ? {}
        : { cloudflareEnvironment: options.cloudflareEnvironment }),
      migrationDirectory:
        options.integrationStorageVerification?.migrationDirectory ??
        resolve(sourceRepositoryRoot, "migrations"),
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
    });
  } catch {
    throw phase === "preflight"
      ? preflightError(
          "v2 Worker requires the exact generated integration D1/R2 and fixed 0075 schema before publication",
        )
      : verificationError(
          "v2 Worker storage readback no longer proves the generated D1/R2 and fixed 0075 schema",
        );
  }
}

function assertFreshV2StorageProofUnchanged(
  phase: "preflight" | "verification",
  before: FreshV2ArtifactIntegrationStorageTargetProof,
  after: FreshV2ArtifactIntegrationStorageTargetProof,
): void {
  if (canonicalJson(before) === canonicalJson(after)) return;
  throw phase === "preflight"
    ? preflightError("generated v2 integration storage target or schema changed before publication")
    : verificationError(
        "generated v2 integration storage target or schema changed after publication",
      );
}

export function providerExecutorQualificationReader(input: {
  readonly target: DeployTarget;
  readonly injected?: WorkerProviderExecutorQualification;
}): WorkerProviderExecutorQualification | null {
  if (input.target.cloudflareProviderExecutor === undefined) return null;
  if (input.injected !== undefined) return input.injected;
  throw preflightError(
    "a target with a managed provider executor requires owner-injected live qualification",
  );
}

export function providerExecutorStatus(
  inspection: ProviderExecutorInspection | null,
): Record<string, unknown> {
  return inspection === null
    ? { cloudflareProviderExecutor: { required: false } }
    : {
        cloudflareProviderExecutor: {
          required: true,
          ready: inspection.ready,
          status: inspection.status,
          routeLess: inspection.routeLess,
          versionId: inspection.versionId,
          deploymentId: inspection.deploymentId,
          commit: inspection.commit,
          bundleDigest:
            inspection.bundleDigestHex === null ? null : `sha256:${inspection.bundleDigestHex}`,
          schemaReady: inspection.schemaReady,
          dependencies: inspection.dependencies,
        },
      };
}

export function withProviderExecutorQualification(
  result: Record<string, unknown>,
  inspection: ProviderExecutorInspection | null,
): Record<string, unknown> {
  return {
    ...result,
    ...providerExecutorStatus(inspection),
    ...(typeof result.ready === "boolean"
      ? { ready: result.ready && (inspection === null || inspection.ready) }
      : {}),
  };
}

export function assertProviderExecutorUnchanged(
  expected: ProviderExecutorInspection,
  actual: ProviderExecutorInspection,
  phase: "preflight" | "verification" = "preflight",
  target?: DeployTarget,
): void {
  if (
    (target === undefined ? !actual.ready : !providerExecutorAllowsPublication(target, actual)) ||
    actual.versionId !== expected.versionId ||
    actual.deploymentId !== expected.deploymentId ||
    actual.previousVersionId !== expected.previousVersionId ||
    actual.commit !== expected.commit ||
    actual.bundleDigestHex !== expected.bundleDigestHex ||
    actual.moduleDigestHex !== expected.moduleDigestHex ||
    actual.managedExact !== expected.managedExact ||
    actual.routeLess !== expected.routeLess ||
    actual.schemaReady !== expected.schemaReady ||
    JSON.stringify(actual.dependencies) !== JSON.stringify(expected.dependencies) ||
    JSON.stringify(actual.maintenance) !== JSON.stringify(expected.maintenance)
  ) {
    const message =
      "Cloudflare provider executor qualification changed during public Worker publication";
    if (phase === "verification") throw verificationError(message);
    throw preflightError(message);
  }
}

function assertWorkerInspectionUnchanged(
  expected: WorkerInspection,
  actual: WorkerInspection,
  message: string,
): void {
  if (
    actual.history.deploymentId !== expected.history.deploymentId ||
    actual.history.versionId !== expected.history.versionId ||
    actual.history.previousVersionId !== expected.history.previousVersionId ||
    actual.commit !== expected.commit ||
    actual.bundleDigestHex !== expected.bundleDigestHex ||
    actual.integrationE2eCredentialAuthorityConfigured !==
      expected.integrationE2eCredentialAuthorityConfigured ||
    JSON.stringify(actual.migrations) !== JSON.stringify(expected.migrations) ||
    JSON.stringify(actual.pending) !== JSON.stringify(expected.pending)
  ) {
    throw preflightError(message);
  }
}

async function requireDistinctIntegrationE2eSigningIdentity(
  target: DeployTarget,
  database: Pick<SigningDatabase, "readKey">,
): Promise<SigningPublicKeyRow> {
  const authority = target.integrationE2eCredentialAuthority;
  if (authority === undefined) {
    throw preflightError("integration E2E signing-key preflight has no configured authority");
  }
  const keyId = target.signing.currentKeyId;
  const row = await database.readKey(keyId, "preflight");
  const signingPublicJwk = activePublicJwk(row, keyId);
  if (signingPublicJwk.x === authority.publicJwk.x) {
    throw preflightError(
      "integration E2E credential authority must not reuse the active runtime signing key",
    );
  }
  if (row === null) {
    throw preflightError("active runtime signing identity is unavailable");
  }
  return row;
}

function sameSigningIdentity(expected: SigningPublicKeyRow, actual: SigningPublicKeyRow): boolean {
  return (
    actual.keyId === expected.keyId &&
    actual.publicJwk === expected.publicJwk &&
    actual.createdAtEpochSeconds === expected.createdAtEpochSeconds &&
    actual.revokedAtEpochSeconds === expected.revokedAtEpochSeconds
  );
}

async function inspectWorker(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  migrations: WorkerMigrationReader,
  options: {
    readonly legacyPredecessorVersionId?: string;
    readonly reconcileStatus?: boolean;
    readonly authorityProfile?: WorkerVersionAuthoritySelection;
  } = {},
): Promise<WorkerInspection> {
  try {
    return await inspectWorkerState(phase, target, state, migrations, options);
  } catch (error) {
    if (phase !== "verification" || (error instanceof DeployError && error.phase === phase)) {
      throw error;
    }
    if (error instanceof DeployError) {
      throw verificationError(
        `Worker post-mutation authoritative inspection failed: ${error.message}`,
      );
    }
    throw verificationError("Worker post-mutation authoritative inspection failed");
  }
}

async function inspectWorkerState(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  migrations: WorkerMigrationReader,
  options: {
    readonly legacyPredecessorVersionId?: string;
    readonly reconcileStatus?: boolean;
    readonly authorityProfile?: WorkerVersionAuthoritySelection;
  },
): Promise<WorkerInspection> {
  const inspect = async (selectedTarget: DeployTarget) =>
    options.legacyPredecessorVersionId === undefined
      ? await inspectLiveWorkerVersion(phase, selectedTarget, state, {
          ...(options.authorityProfile === undefined
            ? {}
            : { authorityProfile: options.authorityProfile }),
        })
      : options.reconcileStatus === true
        ? await inspectLiveWorkerVersionForLegacyStatus(phase, selectedTarget, state, {
            legacyPredecessorVersionId: options.legacyPredecessorVersionId,
            ...(options.authorityProfile === undefined
              ? {}
              : { authorityProfile: options.authorityProfile }),
          })
        : await inspectLiveWorkerVersionWithLegacyPredecessor(phase, selectedTarget, state, {
            legacyPredecessorVersionId: options.legacyPredecessorVersionId,
            ...(options.authorityProfile === undefined
              ? {}
              : { authorityProfile: options.authorityProfile }),
          });
  const live = await inspect(target);
  const integrationE2eCredentialAuthorityConfigured =
    target.integrationE2eCredentialAuthority === undefined ||
    options.authorityProfile?.kind === "provenance-bound-jit";
  const migrationState = await migrations.read();
  const pending = pendingMigrations(migrationState.local, migrationState.applied);
  return {
    history: live.history,
    commit: live.commit,
    bundleDigestHex: live.bundleDigestHex,
    ...(live.commit === null ? { predecessorIdentity: LEGACY_UNATTRIBUTED_PREDECESSOR } : {}),
    ...(live.legacyPredecessorProfile === undefined
      ? {}
      : { legacyPredecessorProfile: live.legacyPredecessorProfile }),
    migrations: migrationState,
    pending,
    integrationE2eCredentialAuthorityConfigured,
  };
}

/**
 * Chooses the caller's authority profile before the strict live inspector.
 * A pinned current legacy predecessor is explicitly historical; every other
 * current Version must prove its canonical source/artifact provenance. This
 * reads only deployment lineage, never the Version's own annotation/bindings,
 * so the inspector remains the sole authority check.
 */
async function authoritySelectionForCurrent(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  options: { readonly legacyPredecessorVersionId?: string },
): Promise<WorkerVersionAuthoritySelection | undefined> {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(target.workerName),
    phase,
  );
  if (history === null) throw preflightError("Worker has no authoritative current deployment");
  if (
    options.legacyPredecessorVersionId !== undefined &&
    history.versionId === options.legacyPredecessorVersionId
  ) {
    return { kind: "historical-pre-jit" };
  }
  return { kind: "provenance-bound-jit" };
}

function remoteMigrationReader(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: WorkerProcess,
  sourceRepositoryRoot = REPOSITORY,
  wranglerPath?: string,
): WorkerMigrationReader {
  return {
    async read() {
      const local = readMigrationArtifact(resolve(sourceRepositoryRoot, "migrations"));
      const remote = await readD1SchemaState(
        new RemoteD1(configPath, {
          environment,
          run,
          wranglerCommand: (args) => deployWranglerCommand(wranglerPath, args),
        }),
      );
      return {
        local: local.names,
        applied: remote.applied,
        shape: remote.shape,
        shapeDigest: remote.shapeDigest,
      };
    },
  };
}

function deployWranglerCommand(
  wranglerPath: string | undefined,
  args: readonly string[],
): readonly string[] {
  return wranglerPath === undefined ? wranglerCommand(args) : [wranglerPath, ...args];
}

async function sourceDiff(
  run: WorkerProcess,
  from: string,
  to: string,
  worktreePaths: readonly string[],
): Promise<readonly string[]> {
  const output =
    from === to
      ? ""
      : await checked(run, "preflight", "selected Worker source diff", [
          "git",
          "diff",
          "--name-only",
          `${from}..${to}`,
          "--",
        ]);
  return [
    ...new Set([
      ...output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      ...worktreePaths,
    ]),
  ].sort();
}

export async function probeProduct(
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

async function checked(
  run: WorkerProcess,
  phase: DeployPhase,
  description: string,
  command: readonly string[],
): Promise<string> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw new DeployError(
      phase,
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result.stdout;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
