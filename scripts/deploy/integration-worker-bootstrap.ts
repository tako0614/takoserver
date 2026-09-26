import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRuntimeInputSealKeyRing } from "../../src/runtime-input-seal-keyring.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import { CloudflareIntegrationStorageProvider } from "./integration-storage-generation.ts";
import { canonicalSchemaShape, type D1SchemaState, readD1SchemaState } from "./migrations.ts";
import {
  type CommandResult,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  type SealedArtifact,
  sealDirectory,
  unsealDirectory,
} from "./qualification.ts";
import { expectedWorkerSecrets, writeWorkerConfig } from "./realized-config.ts";
import { readAuditedMigrationArtifact } from "./schema.ts";
import {
  activePublicJwk,
  createRemoteSigningDatabase,
  readVerifiedPrivateSigningJwk,
  type SigningDatabase,
  type SigningPublicKeyRow,
} from "./signing.ts";
import type { DeployTarget } from "./target.ts";
import {
  assertProviderExecutorUnchanged,
  type ProviderExecutorInspection,
  probeProduct,
  providerExecutorQualificationReader,
  type WorkerProcess,
  type WorkerProviderExecutorQualification,
} from "./worker.ts";
import { type PreparedWorkerArtifact, prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  CLOSURE_SECRET_DIRECTORY_ENV,
  readClosureSecretInputs,
} from "./worker-closure-transition.ts";
import { assertTargetComposes } from "./worker-composition.ts";
import {
  assertLiveWorkerRoutingClosure,
  type WorkerState,
  workerVersionAnnotationProfile,
  workerVersionIdentity,
} from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  parseWorkerDeploymentChain,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  deployWranglerLifecycleChange,
  type WranglerLifecycleDeployment,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

/** The public Host's one-way first-publication surface. */
export const INTEGRATION_WORKER_BOOTSTRAP_SURFACE =
  "takoserver-integration-worker-bootstrap" as const;

const COMMIT = /^[0-9a-f]{40}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const INTEGRATION_WORKER_BOOTSTRAP_GATE_TESTS = [
  "tests/deploy-integration-worker-bootstrap.test.ts",
  "tests/deploy-integration-storage-generation.test.ts",
  "tests/deploy-signing.test.ts",
  "tests/deploy-realized-config-v2.test.ts",
  "tests/deploy-worker-artifact.test.ts",
  "tests/deploy-worker-composition.test.ts",
  "tests/deploy-worker-state.test.ts",
  "tests/deploy-wrangler-state.test.ts",
  "tests/deploy-cloudflare-state.test.ts",
  "tests/deploy-worker.test.ts",
  "tests/entry-worker-origin.test.ts",
  "tests/entry-worker-operator-authority.test.ts",
  "tests/entry-worker-startup.test.ts",
  "tests/runtime-input-seal-keyring.test.ts",
  "tests/worker-production-composition.test.ts",
] as const;
const INTEGRATION_WORKER_BOOTSTRAP_GATES = [
  {
    label: "Host bootstrap typecheck `bun run typecheck:worker`",
    command: ["bun", "run", "typecheck:worker"],
  },
  {
    label: "Host bootstrap tests `bun test <fixed Host bootstrap test set>`",
    command: ["bun", "test", ...INTEGRATION_WORKER_BOOTSTRAP_GATE_TESTS],
  },
] as const;

export interface IntegrationWorkerBootstrapInvocation {
  readonly surface?: typeof INTEGRATION_WORKER_BOOTSTRAP_SURFACE;
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

/** Exhaustive read-only provider state needed to prove first-publication absence. */
export interface IntegrationWorkerBootstrapState
  extends Pick<
    WorkerState,
    | "workerDomains"
    | "workerDeployments"
    | "workerVersion"
    | "workerSecrets"
    | "workerSubdomain"
    | "workerAccountSubdomain"
  > {
  workerScripts(): Promise<readonly string[]>;
  workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  >;
  workerSchedules(workerName: string): Promise<readonly string[]>;
  workerSettings(workerName: string): Promise<unknown>;
  workerVersionWithModules?(workerName: string, versionId: string): Promise<unknown>;
}

export interface IntegrationWorkerBootstrapSchemaReader {
  read(phase: DeployPhase): Promise<D1SchemaState>;
}

export interface IntegrationWorkerBootstrapR2IdentityReader {
  read(phase: DeployPhase): Promise<{ readonly bucketName: string }>;
}

export interface IntegrationWorkerBootstrapOptions {
  readonly run?: WorkerProcess;
  readonly state?: IntegrationWorkerBootstrapState;
  readonly sourceRepositoryRoot?: string;
  readonly wranglerPath?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly providerExecutorQualification?: WorkerProviderExecutorQualification;
  readonly signingDatabase?: Pick<SigningDatabase, "readKey">;
  readonly schemaReader?: IntegrationWorkerBootstrapSchemaReader;
  readonly r2Identity?: IntegrationWorkerBootstrapR2IdentityReader;
  readonly secretDirectory?: string;
  /** The exact keyring retained by the qualified CPE owner (never emitted). */
  readonly expectedRuntimeInputSealKeyring?: string;
  readonly review?: string;
  readonly outputDirectory?: string;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly publicationLeaseRoot?: string;
  /** Narrow test seam; production uses the native publication lease helper. */
  readonly publicationLease?: WranglerVersionPublicationLease;
  /** Narrow test seam; production uses deployWranglerLifecycleChange. */
  readonly deployLifecycle?: (
    input: Parameters<typeof deployWranglerLifecycleChange>[0],
  ) => Promise<WranglerLifecycleDeployment>;
}

type MigrationArtifact = ReturnType<typeof readAuditedMigrationArtifact>;
type LifecycleInput = Parameters<typeof deployWranglerLifecycleChange>[0];

interface NativePresence {
  readonly chain: readonly ReturnType<typeof parseWorkerDeploymentChain>[number][];
  readonly history: WorkerDeploymentHistory | null;
  readonly scriptPresent: boolean;
  readonly routeOwner: boolean;
  readonly domainOwner: boolean;
  readonly absent: boolean;
}

interface SigningEvidence {
  readonly row: SigningPublicKeyRow;
  readonly keyId: string;
  readonly publicX: string;
}

/**
 * Status is value-free. Apply admits only exact native absence, then performs
 * one normal Host artifact lifecycle deploy with a temporary secrets file.
 */
export async function runIntegrationWorkerBootstrap(
  invocation: IntegrationWorkerBootstrapInvocation,
  target: DeployTarget,
  options: IntegrationWorkerBootstrapOptions = {},
): Promise<Record<string, unknown>> {
  validateInvocation(invocation, target);
  const run = options.run ?? runCommand;
  const credential =
    invocation.action === "status" && options.state !== undefined
      ? undefined
      : await resolveCloudflareCredential("integration", {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
          ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
        });
  const environment = credential?.childEnvironment ?? {};
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: credential?.token ?? exactToken(environment),
    });

  // No source, provider qualification or secret directory is touched before
  // all four exhaustive native inventories prove exact absence.
  const initial = await readNativePresence("preflight", target, state);
  if (invocation.action === "status" && initial.absent) {
    return statusResult(invocation, target, initial);
  }
  if (invocation.action === "apply" && !initial.absent) {
    throw preflightError(
      "integration Worker bootstrap requires exact native absence; existing or partial Worker state is never adopted",
    );
  }
  if (invocation.action === "status") {
    if (initial.history === null || initial.chain.length !== 1) {
      return statusResult(invocation, target, initial);
    }
    return await statusExisting(
      invocation,
      target,
      options,
      run,
      environment,
      credential?.token,
      state,
      initial,
    );
  }

  await assertTargetComposes("preflight", target);
  const accountSubdomain = await requiredAccountSubdomain("preflight", state);
  assertWorkersDevOrigin(target, accountSubdomain);
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const sourceRepositoryRoot = resolve(options.sourceRepositoryRoot ?? REPOSITORY);
  const expectedSchedules = readExpectedWorkerSchedules("preflight", sourceRepositoryRoot);
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-integration-worker-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let lease: WranglerVersionPublicationLease | null = null;
  let secretsPath: string | null = null;
  let secretsRoot: string | null = null;
  let mutationStarted = false;
  let operationFailed = false;
  let operationFailure: unknown;
  let result: Record<string, unknown> | undefined;
  try {
    const inspectionConfig = writeInspectionConfig(
      root,
      target,
      sourceRepositoryRoot,
      invocation.commit,
    );
    const artifactBefore = readAuditedArtifact(sourceRepositoryRoot);
    const expectedShape = deriveExpectedApplicationShape(artifactBefore);
    const schemaReader = resolveSchemaReader(options, inspectionConfig, target, environment, run);
    const schemaBefore = await readSchema("preflight", schemaReader);
    assertCompleteSchema(schemaBefore, artifactBefore, expectedShape);

    const provider = providerExecutorQualificationReader({
      target,
      ...(options.providerExecutorQualification === undefined
        ? {}
        : { injected: options.providerExecutorQualification }),
    });
    const providerBefore = provider === null ? null : await provider.read("preflight");
    if (providerBefore !== null && !providerBefore.ready) {
      throw preflightError(
        "public Worker bootstrap requires the exact selected-commit Cloudflare provider executor",
      );
    }

    const signingDatabase =
      options.signingDatabase ??
      createRemoteSigningDatabase(
        inspectionConfig,
        environment,
        run,
        wranglerCommandForPath(options.wranglerPath),
      );
    const signingBefore = await readSigning("preflight", target, signingDatabase);
    assertDistinctJit(target, signingBefore);
    const r2Identity = resolveR2IdentityReader(options, target, credential?.token);
    await assertR2Identity("preflight", target, r2Identity);

    const source = await qualifySource({
      environment: "integration",
      commit: invocation.commit,
      run,
    });
    await checkedGate(run);

    const expectedSecrets = expectedWorkerSecrets(target);
    if (target.edgeSupplies !== undefined) {
      if (options.expectedRuntimeInputSealKeyring === undefined) {
        throw preflightError("runtime input seal keyring qualification is unavailable");
      }
      await parseRuntimeInputSealKeyRing(options.expectedRuntimeInputSealKeyring);
    }
    const secretDirectory =
      options.secretDirectory ?? requireEnvironment(CLOSURE_SECRET_DIRECTORY_ENV);
    let secretValues: Readonly<Record<string, string>>;
    try {
      secretValues = readClosureSecretInputs(secretDirectory, expectedSecrets);
    } catch (error) {
      throw valueFree(error, "initial Worker secret inputs are unavailable");
    }
    const privateRaw = await readVerifiedPrivateSigningJwk(
      join(secretDirectory, "TAKOSERVER_SIGNING_KEY"),
      signingBefore.row,
      signingBefore.keyId,
    );
    if (privateRaw !== secretValues.TAKOSERVER_SIGNING_KEY) {
      throw preflightError("active runtime signing private key changed during qualification");
    }
    if (target.edgeSupplies !== undefined) {
      const localKeyring = secretValues.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING;
      if (localKeyring === undefined || options.expectedRuntimeInputSealKeyring === undefined) {
        throw preflightError("runtime input seal keyring input is unavailable");
      }
      await parseRuntimeInputSealKeyRing(localKeyring);
      if (canonicalJson(localKeyring) !== canonicalJson(options.expectedRuntimeInputSealKeyring)) {
        throw preflightError("runtime input seal keyring differs from qualified CPE input");
      }
    }

    const prepared = await prepareBootstrapArtifact(
      root,
      target,
      source.commit,
      sourceRepositoryRoot,
      run,
      options.wranglerPath,
      secretValues,
    );
    secretsRoot = mkdtempSync(join(tmpdir(), "takoserver-integration-worker-secrets-"));
    mkdirSync(secretsRoot, { recursive: true, mode: 0o700 });
    const secretsFile = join(secretsRoot, "secrets.json");
    // Register the path before writing so even a partially-created file is
    // attempted during the independent cleanup pass below.
    secretsPath = secretsFile;
    writeFileSync(secretsFile, `${JSON.stringify(secretValues)}\n`, { mode: 0o600 });
    assertPrivateSecretFile(secretsFile);
    const secretSeal = sealDirectory(secretsRoot, ["secrets.json"]);
    assertSecretSeal("preflight", secretSeal);
    // The public artifact identity deliberately excludes the private secrets
    // file. Its seal is checked in-memory but its digest/size never leave this
    // function, so result identities cannot be influenced by secret bytes.
    const artifact = prepared.seal();
    artifact.assertUnchanged();

    const afterBuild = await readNativePresence("preflight", target, state);
    if (!afterBuild.absent) {
      throw preflightError(
        "integration Worker bootstrap native absence changed during qualification",
      );
    }
    const artifactAfterBuild = readAuditedArtifact(sourceRepositoryRoot);
    assertSameArtifact(artifactBefore, artifactAfterBuild);
    const schemaAfterBuild = await readSchema("preflight", schemaReader);
    assertCompleteSchema(schemaAfterBuild, artifactAfterBuild, expectedShape);
    assertSameSchema(schemaBefore, schemaAfterBuild);
    const signingAfterBuild = await readSigning("preflight", target, signingDatabase);
    assertSameSigning(signingBefore, signingAfterBuild);
    assertDistinctJit(target, signingAfterBuild);
    await assertR2Identity("preflight", target, r2Identity);
    const providerAfterBuild = provider === null ? null : await provider.read("preflight");
    if (providerBefore !== null && providerAfterBuild !== null) {
      assertProviderExecutorUnchanged(providerBefore, providerAfterBuild);
    }

    lease =
      options.publicationLease ??
      (await acquireWranglerVersionPublicationLease({
        accountId: target.accountId,
        workerName: target.workerName,
        ...(options.publicationLeaseRoot === undefined
          ? {}
          : { root: options.publicationLeaseRoot }),
      }));
    const lifecycle = options.deployLifecycle ?? deployWranglerLifecycleChange;
    mutationStarted = true;
    const publication = await lifecycle({
      root,
      bundlePath: prepared.bundlePath,
      configPath: prepared.configPath,
      accountId: target.accountId,
      workerName: target.workerName,
      message: `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`,
      lease,
      secretsFilePath: secretsPath,
      environment,
      run,
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
      assertCurrentStillExpected: async () => {
        const current = await readNativePresence("preflight", target, state);
        if (!current.absent) {
          throw preflightError(
            "integration Worker bootstrap native absence fence failed immediately before deployment",
          );
        }
        const localFinal = readAuditedArtifact(sourceRepositoryRoot);
        assertSameArtifact(artifactBefore, localFinal);
        const schemaFinal = await readSchema("preflight", schemaReader);
        assertCompleteSchema(schemaFinal, localFinal, expectedShape);
        assertSameSchema(schemaBefore, schemaFinal);
        const signingFinal = await readSigning("preflight", target, signingDatabase);
        assertSameSigning(signingBefore, signingFinal);
        assertDistinctJit(target, signingFinal);
        await assertR2Identity("preflight", target, r2Identity);
        const providerFinal = provider === null ? null : await provider.read("preflight");
        if (providerBefore !== null && providerFinal !== null) {
          assertProviderExecutorUnchanged(providerBefore, providerFinal);
        }
        assertSecretSeal("preflight", secretSeal);
        artifact.assertUnchanged();
      },
    } satisfies LifecycleInput);

    try {
      assertSecretSeal("verification", secretSeal);
      result = await verifyBootstrap({
        invocation,
        target,
        options,
        state,
        publication,
        source,
        prepared,
        artifact,
        schemaBefore,
        artifactBefore,
        expectedShape,
        signingDatabase,
        signingBefore,
        schemaReader,
        r2Identity,
        expectedSchedules,
        reviewer,
        provider,
        providerBefore,
      });
    } catch (error) {
      throw postPublicationVerificationError(error);
    }
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  const cleanupFailures: unknown[] = [];
  const cleanup = async (action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      cleanupFailures.push(error);
    }
  };
  // Each cleanup action is attempted independently. In particular, an
  // unseal failure must not prevent removal of the temporary secrets file or
  // release of the publication lease.
  const cleanupSecretsRoot = secretsRoot;
  if (cleanupSecretsRoot !== null) {
    await cleanup(() => unsealDirectory(cleanupSecretsRoot));
  }
  await cleanup(() => unsealDirectory(root));
  if (secretsPath !== null) await cleanup(() => rmSync(secretsPath, { force: true }));
  if (cleanupSecretsRoot !== null) {
    await cleanup(() => rmSync(cleanupSecretsRoot, { recursive: true, force: true }));
  }
  const cleanupLease = lease;
  if (cleanupLease !== null) await cleanup(() => cleanupLease.release());
  if (temporary) await cleanup(() => rmSync(root, { recursive: true, force: true }));

  // Preserve the operation's bounded failure when both operation and cleanup
  // fail. A cleanup-only failure is still a hard failure: a successful return
  // must never claim that secret material was removed when it was not.
  if (operationFailed) {
    if (cleanupFailures.length > 0) {
      if (operationFailure instanceof DeployError) {
        throw phaseError(
          operationFailure.phase,
          `${operationFailure.message}; integration Worker bootstrap cleanup failed; secret material may remain`,
        );
      }
      throw phaseError(
        mutationStarted ? "verification" : "preflight",
        "integration Worker bootstrap operation and cleanup failed; secret material may remain",
      );
    }
    throw operationFailure;
  }
  if (cleanupFailures.length > 0) {
    throw phaseError(
      mutationStarted ? "verification" : "preflight",
      "integration Worker bootstrap cleanup failed; secret material may remain",
    );
  }
  if (result === undefined) {
    throw preflightError("integration Worker bootstrap produced no result");
  }
  return result;
}

async function statusExisting(
  invocation: IntegrationWorkerBootstrapInvocation,
  target: DeployTarget,
  options: IntegrationWorkerBootstrapOptions,
  run: WorkerProcess,
  environment: Readonly<Record<string, string>>,
  cloudflareToken: string | undefined,
  state: IntegrationWorkerBootstrapState,
  initial: NativePresence,
): Promise<Record<string, unknown>> {
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-integration-worker-status-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const sourceRoot = resolve(options.sourceRepositoryRoot ?? REPOSITORY);
    const expectedSchedules = readExpectedWorkerSchedules("preflight", sourceRoot);
    const config = writeInspectionConfig(root, target, sourceRoot, invocation.commit);
    const artifact = readAuditedArtifact(sourceRoot);
    const expectedShape = deriveExpectedApplicationShape(artifact);
    const schemaReader = resolveSchemaReader(options, config, target, environment, run);
    const schema = await readSchema("preflight", schemaReader);
    assertCompleteSchema(schema, artifact, expectedShape);
    const provider = providerExecutorQualificationReader({
      target,
      ...(options.providerExecutorQualification === undefined
        ? {}
        : { injected: options.providerExecutorQualification }),
    });
    const providerInspection = provider === null ? null : await provider.read("preflight");
    const signingDatabase =
      options.signingDatabase ??
      createRemoteSigningDatabase(
        config,
        environment,
        run,
        wranglerCommandForPath(options.wranglerPath),
      );
    const signing = await readSigning("preflight", target, signingDatabase);
    assertDistinctJit(target, signing);
    const r2Identity = resolveR2IdentityReader(options, target, cloudflareToken);
    await assertR2Identity("preflight", target, r2Identity);
    const history = initial.history;
    if (history === null) {
      throw preflightError("Worker bootstrap status cannot read an existing deployment history");
    }
    const version = await readVersionWithModules(state, target.workerName, history.versionId);
    const identity = await inspectVersion(
      "preflight",
      target,
      state,
      history,
      version,
      invocation.commit,
      signing.keyId,
    );
    await assertWorkerSchedules("preflight", target, state, expectedSchedules);
    const ready =
      identity.commit === invocation.commit &&
      (providerInspection === null || providerInspection.ready);
    return {
      ...statusResult(invocation, target, initial),
      state: ready ? "complete" : "drift",
      deployedCommit: identity.commit,
      artifactDigest: `sha256:${identity.bundleDigestHex}`,
      appliedMigrations: schema.applied,
      schemaShapeDigest: schema.shapeDigest,
      ready,
      ...(providerInspection === null
        ? { cloudflareProviderExecutor: { required: false } }
        : {
            cloudflareProviderExecutor: {
              required: true,
              ready: providerInspection.ready,
              status: providerInspection.status,
              routeLess: providerInspection.routeLess,
              versionId: providerInspection.versionId,
              deploymentId: providerInspection.deploymentId,
            },
          }),
    };
  } catch {
    return { ...statusResult(invocation, target, initial), state: "drift", ready: false };
  } finally {
    try {
      unsealDirectory(root);
      if (temporary) rmSync(root, { recursive: true, force: true });
    } catch {
      // Read-only status remains value-free even if cleanup is unavailable.
    }
  }
}

function statusResult(
  invocation: IntegrationWorkerBootstrapInvocation,
  target: DeployTarget,
  native: NativePresence,
): Record<string, unknown> {
  return {
    kind: "takoserver.integration-worker-bootstrap-status@v1",
    surface: INTEGRATION_WORKER_BOOTSTRAP_SURFACE,
    environment: "integration",
    selectedCommit: invocation.commit,
    state: native.absent ? "absent" : "partial",
    scriptPresent: native.scriptPresent,
    routeOwner: native.routeOwner,
    domainOwner: native.domainOwner,
    deploymentId: native.history?.deploymentId ?? null,
    versionId: native.history?.versionId ?? null,
    previousVersionId: native.history?.previousVersionId ?? null,
    deployedCommit: null,
    artifactDigest: null,
    signingKeyId: target.signing.currentKeyId,
    ready: native.absent,
    mutationApplied: false,
  };
}

async function verifyBootstrap(input: {
  readonly invocation: IntegrationWorkerBootstrapInvocation;
  readonly target: DeployTarget;
  readonly options: IntegrationWorkerBootstrapOptions;
  readonly state: IntegrationWorkerBootstrapState;
  readonly publication: WranglerLifecycleDeployment;
  readonly source: Awaited<ReturnType<typeof qualifySource>>;
  readonly prepared: PreparedWorkerArtifact;
  readonly artifact: ReturnType<PreparedWorkerArtifact["seal"]>;
  readonly schemaBefore: D1SchemaState;
  readonly artifactBefore: MigrationArtifact;
  readonly expectedShape: string;
  readonly signingDatabase: Pick<SigningDatabase, "readKey">;
  readonly signingBefore: SigningEvidence;
  readonly schemaReader: IntegrationWorkerBootstrapSchemaReader;
  readonly r2Identity: IntegrationWorkerBootstrapR2IdentityReader;
  readonly expectedSchedules: readonly string[];
  readonly reviewer: string;
  readonly provider: WorkerProviderExecutorQualification | null;
  readonly providerBefore: ProviderExecutorInspection | null;
}): Promise<Record<string, unknown>> {
  const after = await readNativePresence("verification", input.target, input.state);
  if (after.absent || after.history === null || after.chain.length !== 1) {
    throw verificationError(
      "authoritative Worker deployment history does not identify the acknowledged first Version",
    );
  }
  if (
    after.history.versionId !== input.publication.versionId ||
    after.history.previousVersionId !== null
  ) {
    throw verificationError(
      "authoritative Worker deployment/version does not match the acknowledged first publication",
    );
  }
  assertNoTargetOwners("verification", input.target, after);
  const version = await readVersionWithModules(
    input.state,
    input.target.workerName,
    after.history.versionId,
  );
  await inspectVersion(
    "verification",
    input.target,
    input.state,
    after.history,
    version,
    input.source.commit,
    input.signingBefore.keyId,
    input.prepared.bundleDigestHex,
  );
  const artifactAfter = readAuditedArtifact(
    resolve(input.options.sourceRepositoryRoot ?? REPOSITORY),
  );
  assertSameArtifact(input.artifactBefore, artifactAfter, "verification");
  const schemaAfter = await readSchema("verification", input.schemaReader);
  assertCompleteSchema(schemaAfter, artifactAfter, input.expectedShape, "verification");
  assertSameSchema(input.schemaBefore, schemaAfter, "verification");
  const signingAfter = await readSigning("verification", input.target, input.signingDatabase);
  assertSameSigning(input.signingBefore, signingAfter, "verification");
  assertDistinctJit(input.target, signingAfter, "verification");
  await assertR2Identity("verification", input.target, input.r2Identity);
  await assertWorkerSchedules("verification", input.target, input.state, input.expectedSchedules);
  const providerAfter = input.provider === null ? null : await input.provider.read("verification");
  if (input.providerBefore !== null && providerAfter !== null) {
    assertProviderExecutorUnchanged(input.providerBefore, providerAfter, "verification");
  }
  const probe = await probeProduct(
    input.target.publicOrigin,
    input.options.fetcher ?? ((url, init) => fetch(url, init)),
  );
  return {
    kind: "takoserver.integration-worker-bootstrap-apply@v1",
    surface: INTEGRATION_WORKER_BOOTSTRAP_SURFACE,
    environment: "integration",
    commit: input.source.commit,
    dirty: input.source.dirty,
    remoteRef: input.source.remoteRef,
    reviewer: input.reviewer,
    migrationDigest: artifactAfter.digest,
    migrationBytes: artifactAfter.bytes,
    appliedMigrations: schemaAfter.applied,
    schemaShapeDigest: schemaAfter.shapeDigest,
    artifactDigest: input.artifact.digest,
    artifactBytes: input.artifact.bytes,
    artifactFiles: input.artifact.files,
    bundleDigest: `sha256:${input.prepared.bundleDigestHex}`,
    preMutationObservedVersionId: null,
    previousVersionId: null,
    deploymentId: after.history.deploymentId,
    versionId: after.history.versionId,
    acknowledgedVersionId: input.publication.versionId,
    probe,
    mutationApplied: true,
    ...(providerAfter === null
      ? { cloudflareProviderExecutor: { required: false } }
      : {
          cloudflareProviderExecutor: {
            required: true,
            ready: providerAfter.ready,
            status: providerAfter.status,
            routeLess: providerAfter.routeLess,
            versionId: providerAfter.versionId,
            deploymentId: providerAfter.deploymentId,
          },
        }),
    rollback:
      "forward repair only: this first Worker publication has no predecessor; never replay bootstrap",
  };
}

async function inspectVersion(
  phase: "preflight" | "verification",
  target: DeployTarget,
  state: IntegrationWorkerBootstrapState,
  history: WorkerDeploymentHistory,
  version: unknown,
  selectedCommit: string,
  signingKeyId: string,
  expectedBundleDigestHex?: string,
): Promise<{ readonly commit: string; readonly bundleDigestHex: string }> {
  if (workerVersionAnnotationProfile(version) !== "canonical") {
    throw phaseError(phase, "Worker Version has a non-canonical annotation inventory");
  }
  const identity = workerVersionIdentity(phase, version);
  if (identity.commit !== selectedCommit) {
    throw phaseError(phase, "Worker Version source commit differs from the selected publication");
  }
  if (
    expectedBundleDigestHex !== undefined &&
    identity.bundleDigestHex !== expectedBundleDigestHex
  ) {
    throw phaseError(phase, "Worker Version bundle identity differs from the sealed upload");
  }
  const authorityProfile =
    target.integrationE2eCredentialAuthority === undefined
      ? undefined
      : {
          kind: "provenance-bound-jit" as const,
          provenance: {
            sourceCommit: identity.commit,
            artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
          },
        };
  const bindingProjection = flatVersionBindingProjection(phase, history.versionId, version);
  assertExactVersionBindingClosure(
    phase,
    history.versionId,
    bindingProjection,
    expectedExactBindingClosure(target, {
      signingKeyId,
      ...(authorityProfile === undefined ? {} : { authorityProfile }),
      workerArtifactDigest: `sha256:${identity.bundleDigestHex}` as const,
    }),
  );
  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    expectedWorkerSecrets(target),
    phase,
  );
  await assertLiveWorkerRoutingClosure(phase, target, state);
  await assertWorkersDevSubdomainState(phase, target, state);
  const native = await readNativePresence(phase, target, state);
  assertNoTargetOwners(phase, target, native);
  assertWorkerSettings(phase, await state.workerSettings(target.workerName));
  assertImmutableVersion(phase, version);
  const moduleDigest = exactModuleDigest(phase, version);
  if (moduleDigest !== identity.bundleDigestHex) {
    throw phaseError(phase, "Worker Version module bytes differ from its bundle annotation");
  }
  return identity;
}

async function prepareBootstrapArtifact(
  root: string,
  target: DeployTarget,
  commit: string,
  sourceRepositoryRoot: string,
  run: WorkerProcess,
  wranglerPath: string | undefined,
  secretValues: Readonly<Record<string, string>>,
): Promise<PreparedWorkerArtifact> {
  const buildRun: WorkerProcess = async (command, input = {}) => {
    const childEnvironment = input.env ?? {};
    if (
      Object.hasOwn(childEnvironment, "CLOUDFLARE_API_TOKEN") ||
      Object.values(secretValues).some(
        (secret) =>
          secret.length > 0 &&
          Object.values(childEnvironment).some((value) => value.includes(secret)),
      )
    ) {
      throw preflightError("Worker artifact build environment contains deployment secret material");
    }
    return await run(command, { ...input, env: {} });
  };
  return await prepareWorkerArtifact({
    root,
    target,
    commit,
    sourceRepositoryRoot,
    ...(wranglerPath === undefined ? {} : { wranglerPath }),
    run: buildRun,
    environment: {},
    writeConfig: ({ path, main, bundleDigestHex, formImplementationIdentity }) =>
      writeWorkerConfig(target, {
        path,
        main,
        commit,
        sourceRepositoryRoot,
        ...(formImplementationIdentity === undefined ? {} : { formImplementationIdentity }),
        ...(bundleDigestHex === undefined
          ? {}
          : { workerArtifactDigest: `sha256:${bundleDigestHex}` as const }),
        ...(target.integrationE2eCredentialAuthority === undefined
          ? {}
          : bundleDigestHex === undefined
            ? { authorityProfile: { kind: "historical-pre-jit" as const } }
            : {
                authorityProfile: {
                  kind: "provenance-bound-jit" as const,
                  provenance: {
                    sourceCommit: commit,
                    artifactDigest: `sha256:${bundleDigestHex}` as const,
                  },
                },
              }),
      }),
  });
}

function writeInspectionConfig(
  root: string,
  target: DeployTarget,
  sourceRepositoryRoot: string,
  commit: string,
): string {
  return writeWorkerConfig(target, {
    path: join(root, "inspect-wrangler.jsonc"),
    main: resolve(sourceRepositoryRoot, "src/entry-cloudflare-worker.ts"),
    commit,
    sourceRepositoryRoot,
    ...(target.integrationE2eCredentialAuthority === undefined
      ? {}
      : { authorityProfile: { kind: "historical-pre-jit" as const } }),
  });
}

async function readVersionWithModules(
  state: IntegrationWorkerBootstrapState,
  workerName: string,
  versionId: string,
): Promise<unknown> {
  return state.workerVersionWithModules === undefined
    ? await state.workerVersion(workerName, versionId)
    : await state.workerVersionWithModules(workerName, versionId);
}

async function readNativePresence(
  phase: DeployPhase,
  target: DeployTarget,
  state: IntegrationWorkerBootstrapState,
): Promise<NativePresence> {
  let scripts: readonly string[];
  let historyRaw: readonly unknown[];
  let domains: readonly { readonly hostname: string; readonly service: string }[];
  let routes: readonly {
    readonly zoneId: string;
    readonly id: string;
    readonly pattern: string;
    readonly script: string | null;
  }[];
  try {
    [scripts, historyRaw, domains, routes] = await Promise.all([
      state.workerScripts(),
      state.workerDeployments(target.workerName),
      state.workerDomains(),
      state.workerRoutes(),
    ]);
  } catch {
    throw phaseError(phase, "Worker bootstrap cannot read exhaustive native absence inventories");
  }
  if (
    scripts.some((name) => typeof name !== "string") ||
    new Set(scripts).size !== scripts.length
  ) {
    throw phaseError(phase, "Worker bootstrap script inventory is malformed");
  }
  if (
    domains.some((entry) => typeof entry.hostname !== "string" || typeof entry.service !== "string")
  ) {
    throw phaseError(phase, "Worker bootstrap domain inventory is malformed");
  }
  if (
    routes.some(
      (entry) =>
        typeof entry.zoneId !== "string" ||
        typeof entry.id !== "string" ||
        typeof entry.pattern !== "string" ||
        (entry.script !== null && typeof entry.script !== "string"),
    )
  ) {
    throw phaseError(phase, "Worker bootstrap route inventory is malformed");
  }
  let chain: readonly ReturnType<typeof parseWorkerDeploymentChain>[number][];
  try {
    chain = parseWorkerDeploymentChain(historyRaw, phase, { requireUuidVersionIds: true });
  } catch {
    throw phaseError(phase, "Worker bootstrap deployment history is malformed");
  }
  const history = parseWorkerDeploymentHistory(historyRaw, phase);
  const scriptPresent = scripts.includes(target.workerName);
  const routeOwner = routes.some((entry) => entry.script === target.workerName);
  const domainOwner = domains.some((entry) => entry.service === target.workerName);
  return {
    chain,
    history,
    scriptPresent,
    routeOwner,
    domainOwner,
    absent: !scriptPresent && history === null && !routeOwner && !domainOwner,
  };
}

function readExpectedWorkerSchedules(
  phase: DeployPhase,
  sourceRepositoryRoot: string,
): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(sourceRepositoryRoot, "wrangler.jsonc"), "utf8"));
  } catch {
    throw phaseError(phase, "Worker bootstrap cannot read the owner wrangler schedule declaration");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw phaseError(phase, "owner wrangler schedule declaration is malformed");
  }
  const triggers = (parsed as Record<string, unknown>).triggers;
  if (triggers === undefined) return [];
  if (typeof triggers !== "object" || triggers === null || Array.isArray(triggers)) {
    throw phaseError(phase, "owner wrangler schedule declaration is malformed");
  }
  const crons = (triggers as Record<string, unknown>).crons;
  if (crons === undefined) return [];
  if (
    !Array.isArray(crons) ||
    crons.some((cron) => typeof cron !== "string" || cron.length === 0 || cron.trim() !== cron)
  ) {
    throw phaseError(phase, "owner wrangler schedule declaration is malformed");
  }
  const values = crons as string[];
  if (new Set(values).size !== values.length) {
    throw phaseError(phase, "owner wrangler schedule declaration contains duplicate crons");
  }
  return [...values].sort();
}

async function assertWorkerSchedules(
  phase: DeployPhase,
  target: DeployTarget,
  state: IntegrationWorkerBootstrapState,
  expected: readonly string[],
): Promise<void> {
  let actual: readonly string[];
  try {
    actual = await state.workerSchedules(target.workerName);
  } catch {
    throw phaseError(phase, "Worker schedule readback failed");
  }
  if (
    actual.some((cron) => typeof cron !== "string" || cron.length === 0 || cron.trim() !== cron) ||
    new Set(actual).size !== actual.length
  ) {
    throw phaseError(phase, "Worker schedule readback is malformed");
  }
  if (canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())) {
    throw phaseError(phase, "Worker schedule closure differs from the owner declaration");
  }
}

function assertNoTargetOwners(
  phase: DeployPhase,
  _target: DeployTarget,
  native: NativePresence,
): void {
  if (native.routeOwner || native.domainOwner) {
    throw phaseError(phase, "integration Worker bootstrap found a custom route or domain owner");
  }
}

async function requiredAccountSubdomain(
  phase: DeployPhase,
  state: IntegrationWorkerBootstrapState,
): Promise<string> {
  if (state.workerAccountSubdomain === undefined) {
    throw phaseError(phase, "Worker bootstrap cannot prove the account workers.dev subdomain");
  }
  const value = await state.workerAccountSubdomain();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
    throw phaseError(phase, "Cloudflare account workers.dev subdomain is invalid");
  }
  return value;
}

function assertWorkersDevOrigin(target: DeployTarget, accountSubdomain: string): void {
  if (
    new URL(target.publicOrigin).hostname !== `${target.workerName}.${accountSubdomain}.workers.dev`
  ) {
    throw preflightError("selected workers.dev origin does not match the account Worker hostname");
  }
}

function validateInvocation(
  invocation: IntegrationWorkerBootstrapInvocation,
  target: DeployTarget,
): void {
  if (
    invocation.surface !== undefined &&
    invocation.surface !== INTEGRATION_WORKER_BOOTSTRAP_SURFACE
  ) {
    throw preflightError("integration Worker bootstrap requires its exact surface");
  }
  if (invocation.action !== "status" && invocation.action !== "apply") {
    throw preflightError("integration Worker bootstrap requires --status or --apply");
  }
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("integration Worker bootstrap is integration-only");
  }
  if (invocation.environment !== target.environment) {
    throw preflightError("integration Worker bootstrap and target environments differ");
  }
  if (!COMMIT.test(invocation.commit)) {
    throw preflightError("integration Worker bootstrap requires one exact lowercase 40-hex commit");
  }
  if (!ACCOUNT_ID.test(target.accountId) || !WORKER_NAME.test(target.workerName)) {
    throw preflightError("integration Worker bootstrap requires one exact account and Worker name");
  }
  if (target.aliases !== undefined && target.aliases.length > 0) {
    throw preflightError("integration Worker bootstrap accepts no aliases");
  }
  let origin: URL;
  try {
    origin = new URL(target.publicOrigin);
  } catch {
    throw preflightError("integration Worker bootstrap requires one exact workers.dev origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !origin.hostname.endsWith(".workers.dev")
  ) {
    throw preflightError("integration Worker bootstrap requires one exact workers.dev origin");
  }
}

function readAuditedArtifact(sourceRoot: string): MigrationArtifact {
  return readAuditedMigrationArtifact(resolve(sourceRoot, "migrations"));
}

function deriveExpectedApplicationShape(artifact: MigrationArtifact): string {
  const database = new Database(":memory:");
  try {
    for (const file of artifact.files) database.exec(readFileSync(file.path, "utf8"));
    const rows = database
      .query(
        "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql " +
          "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Record<string, unknown>[];
    return canonicalSchemaShape(rows.filter((row) => !platformSchemaMetadata(row)));
  } catch {
    throw preflightError("audited migrations could not reconstruct the expected canonical schema");
  } finally {
    database.close();
  }
}

function assertCompleteSchema(
  state: D1SchemaState,
  artifact: MigrationArtifact,
  expectedApplicationShape: string,
  phase: DeployPhase = "preflight",
): void {
  if (canonicalJson(state.applied) !== canonicalJson(artifact.names)) {
    throw phaseError(phase, "D1 schema is not the exact complete audited migration lineage");
  }
  if (!SHA256.test(state.shapeDigest) || digest(state.shape) !== state.shapeDigest) {
    throw phaseError(phase, "D1 canonical schema shape digest is invalid");
  }
  if (applicationShapeFromState(state.shape, phase) !== expectedApplicationShape) {
    throw phaseError(phase, "D1 schema shape does not match the exact audited application schema");
  }
}

function applicationShapeFromState(shape: string, phase: DeployPhase): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(shape);
  } catch {
    throw phaseError(phase, "D1 canonical schema shape is not JSON");
  }
  if (!Array.isArray(parsed)) throw phaseError(phase, "D1 canonical schema shape is not an array");
  const rows = parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw phaseError(phase, "D1 canonical schema shape contains a malformed row");
    }
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "name,sql,table,type" ||
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.table !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw phaseError(phase, "D1 canonical schema shape contains a malformed row");
    }
    return { type: row.type, name: row.name, tbl_name: row.table, sql: row.sql };
  });
  // canonicalSchemaShape validates order and exact row keys. The full shape is
  // intentionally retained for the state digest; application comparison drops
  // only provider-owned metadata tables.
  try {
    canonicalSchemaShape(rows);
    return canonicalSchemaShape(rows.filter((row) => !platformSchemaMetadata(row)));
  } catch {
    throw phaseError(phase, "D1 canonical schema shape is not canonically ordered");
  }
}

function platformSchemaMetadata(row: Record<string, unknown>): boolean {
  return (
    row.name === "d1_migrations" ||
    row.tbl_name === "d1_migrations" ||
    row.name === "_cf_KV" ||
    row.tbl_name === "_cf_KV"
  );
}

function resolveSchemaReader(
  options: IntegrationWorkerBootstrapOptions,
  configPath: string,
  target: DeployTarget,
  environment: Readonly<Record<string, string>>,
  run: WorkerProcess,
): IntegrationWorkerBootstrapSchemaReader {
  if (options.schemaReader !== undefined) return options.schemaReader;
  const wranglerPath = options.wranglerPath;
  return {
    async read(phase) {
      try {
        return await readD1SchemaState(
          new RemoteD1(configPath, {
            environment,
            run,
            ...(wranglerPath === undefined
              ? {}
              : {
                  wranglerCommand: (args: readonly string[]) => [wranglerPath, ...args],
                }),
          }),
          phase,
        );
      } catch {
        throw phaseError(phase, `D1 schema state read failed for ${target.d1.databaseName}`);
      }
    },
  };
}

async function readSchema(
  phase: DeployPhase,
  reader: IntegrationWorkerBootstrapSchemaReader,
): Promise<D1SchemaState> {
  try {
    return await reader.read(phase);
  } catch {
    throw phaseError(phase, "D1 schema state read failed");
  }
}

async function assertR2Identity(
  phase: DeployPhase,
  target: DeployTarget,
  reader: IntegrationWorkerBootstrapR2IdentityReader,
): Promise<void> {
  let value: { readonly bucketName: string };
  try {
    value = await reader.read(phase);
  } catch {
    throw phaseError(phase, "target R2 identity read failed");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.bucketName !== "string" ||
    value.bucketName !== target.r2.bucketName
  ) {
    throw phaseError(phase, "target R2 identity does not match the selected bucket");
  }
}

function resolveR2IdentityReader(
  options: IntegrationWorkerBootstrapOptions,
  target: DeployTarget,
  cloudflareToken: string | undefined,
): IntegrationWorkerBootstrapR2IdentityReader {
  if (options.r2Identity !== undefined) return options.r2Identity;
  if (cloudflareToken === undefined || cloudflareToken.length === 0) {
    throw preflightError("target R2 identity reader is unavailable");
  }
  const provider = new CloudflareIntegrationStorageProvider(target.accountId, cloudflareToken);
  return {
    async read(phase) {
      try {
        const bucket = await provider.getR2(target.r2.bucketName);
        if (bucket.name !== target.r2.bucketName) {
          throw new Error("identity");
        }
        return { bucketName: bucket.name };
      } catch {
        throw phaseError(phase, "target R2 identity read failed");
      }
    },
  };
}

async function readSigning(
  phase: "preflight" | "verification",
  target: DeployTarget,
  database: Pick<SigningDatabase, "readKey">,
): Promise<SigningEvidence> {
  const keyId = target.signing.currentKeyId;
  const row = await database.readKey(keyId, phase);
  if (
    row === null ||
    row.keyId !== keyId ||
    row.revokedAtEpochSeconds !== null ||
    !Number.isSafeInteger(row.createdAtEpochSeconds)
  ) {
    throw phaseError(phase, "active runtime signing identity is unavailable or revoked");
  }
  return { row, keyId, publicX: activePublicJwk(row, keyId).x };
}

function assertDistinctJit(
  target: DeployTarget,
  signing: SigningEvidence,
  phase: "preflight" | "verification" = "preflight",
): void {
  if (
    target.integrationE2eCredentialAuthority !== undefined &&
    signing.publicX === target.integrationE2eCredentialAuthority.publicJwk.x
  ) {
    throw phaseError(
      phase,
      "integration E2E credential authority must not reuse the active runtime signing key",
    );
  }
}

function assertSameSigning(
  expected: SigningEvidence,
  actual: SigningEvidence,
  phase: "preflight" | "verification" = "preflight",
): void {
  if (
    expected.keyId !== actual.keyId ||
    expected.row.publicJwk !== actual.row.publicJwk ||
    expected.row.createdAtEpochSeconds !== actual.row.createdAtEpochSeconds ||
    expected.row.revokedAtEpochSeconds !== actual.row.revokedAtEpochSeconds
  ) {
    throw phaseError(phase, "active runtime signing identity changed during Worker bootstrap");
  }
}

function assertSameArtifact(
  expected: MigrationArtifact,
  actual: MigrationArtifact,
  phase: DeployPhase = "preflight",
): void {
  if (
    expected.digest !== actual.digest ||
    expected.bytes !== actual.bytes ||
    canonicalJson(expected.names) !== canonicalJson(actual.names)
  ) {
    throw phaseError(phase, "audited D1 migration lineage changed during Worker bootstrap");
  }
}

function assertSameSchema(
  expected: D1SchemaState,
  actual: D1SchemaState,
  phase: "preflight" | "verification" = "preflight",
): void {
  if (
    canonicalJson(expected.applied) !== canonicalJson(actual.applied) ||
    expected.shape !== actual.shape ||
    expected.shapeDigest !== actual.shapeDigest
  ) {
    throw phaseError(phase, "D1 schema lineage or canonical shape changed during Worker bootstrap");
  }
}

function assertWorkerSettings(phase: "preflight" | "verification", value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw phaseError(phase, "Worker settings are malformed");
  }
  const settings = value as Record<string, unknown>;
  if (
    (Object.hasOwn(settings, "workers_dev") && settings.workers_dev !== true) ||
    (Object.hasOwn(settings, "preview_urls") && settings.preview_urls !== false)
  ) {
    throw phaseError(phase, "Worker settings contradict the exact workers.dev topology");
  }
  for (const key of ["routes", "custom_domains", "domains"] as const) {
    if (
      settings[key] !== undefined &&
      (!Array.isArray(settings[key]) || settings[key].length !== 0)
    ) {
      throw phaseError(
        phase,
        "Worker settings unexpectedly declare custom route or domain topology",
      );
    }
  }
}

async function assertWorkersDevSubdomainState(
  phase: "preflight" | "verification",
  target: DeployTarget,
  state: IntegrationWorkerBootstrapState,
): Promise<void> {
  if (!new URL(target.publicOrigin).hostname.endsWith(".workers.dev")) return;
  const subdomain = await state.workerSubdomain?.(target.workerName);
  if (subdomain?.enabled !== true || subdomain.previewsEnabled !== false) {
    throw phaseError(
      phase,
      "Worker workers.dev subdomain must be enabled with preview URLs disabled",
    );
  }
}

function assertImmutableVersion(phase: "preflight" | "verification", value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw phaseError(phase, "Worker Version is malformed");
  }
  const version = value as Record<string, unknown>;
  if (
    version.compatibility_date !== "2026-08-17" ||
    !Array.isArray(version.compatibility_flags) ||
    version.compatibility_flags.length !== 1 ||
    version.compatibility_flags[0] !== "nodejs_compat" ||
    version.assets !== undefined ||
    version.placement !== undefined ||
    version.migration_tag !== undefined ||
    (version.migrations !== undefined &&
      (typeof version.migrations !== "object" ||
        version.migrations === null ||
        Array.isArray(version.migrations) ||
        Object.keys(version.migrations).length !== 0))
  ) {
    throw phaseError(phase, "Worker Version settings are not the exact immutable Host settings");
  }
}

function exactModuleDigest(phase: "preflight" | "verification", value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw phaseError(phase, "Worker module closure is malformed");
  }
  const version = value as Record<string, unknown>;
  if (
    version.resources !== undefined ||
    version.main_module !== "worker.js" ||
    !Array.isArray(version.modules)
  ) {
    throw phaseError(phase, "Worker module closure is malformed");
  }
  if (
    version.modules.length !== 1 ||
    typeof version.modules[0] !== "object" ||
    version.modules[0] === null ||
    Array.isArray(version.modules[0])
  ) {
    throw phaseError(phase, "Worker module closure is not exact");
  }
  const module = version.modules[0] as Record<string, unknown>;
  if (
    Object.keys(module).sort().join(",") !== "content_base64,content_type,name" ||
    module.name !== "worker.js" ||
    module.content_type !== "application/javascript+module" ||
    typeof module.content_base64 !== "string"
  ) {
    throw phaseError(phase, "Worker module is malformed");
  }
  const bytes = Buffer.from(module.content_base64, "base64");
  if (bytes.toString("base64") !== module.content_base64) {
    throw phaseError(phase, "Worker module is not canonical base64");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function flatVersionBindingProjection(
  phase: DeployPhase,
  versionId: string,
  value: unknown,
): { readonly resources: { readonly bindings: readonly unknown[] } } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).resources !== undefined ||
    !Array.isArray((value as Record<string, unknown>).bindings)
  ) {
    throw phaseError(phase, `version ${versionId} has no exact flat binding inventory`);
  }
  return {
    resources: {
      bindings: (value as Record<string, unknown>).bindings as readonly unknown[],
    },
  };
}

function assertPrivateSecretFile(path: string): void {
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600
  ) {
    throw preflightError("temporary Worker secrets file must be an exact 0600 regular file");
  }
}

function assertSecretSeal(phase: DeployPhase, seal: SealedArtifact): void {
  try {
    seal.assertUnchanged();
  } catch {
    throw phaseError(phase, "temporary Worker secrets file changed during bootstrap");
  }
}

async function checkedGate(run: WorkerProcess): Promise<void> {
  for (const gate of INTEGRATION_WORKER_BOOTSTRAP_GATES) {
    let result: CommandResult;
    try {
      result = await run(gate.command);
    } catch {
      throw preflightError(`scoped ${gate.label} could not be started`);
    }
    if (result.exitCode !== 0) {
      throw preflightError(
        `scoped ${gate.label} failed (exit ${result.exitCode})`,
        `${result.stdout}${result.stderr}`.trim(),
      );
    }
  }
}

function wranglerCommandForPath(
  wranglerPath: string | undefined,
): ((args: readonly string[]) => readonly string[]) | undefined {
  return wranglerPath === undefined ? undefined : (args) => [wranglerPath, ...args];
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

function valueFree(error: unknown, fallback: string): DeployError {
  if (error instanceof DeployError && error.phase === "preflight") {
    return error;
  }
  return preflightError(fallback);
}

function postPublicationVerificationError(error: unknown): DeployError {
  if (error instanceof DeployError && error.phase === "verification") return error;
  if (error instanceof DeployError) return verificationError(error.message);
  return verificationError(
    "integration Worker bootstrap post-publication authoritative verification failed",
  );
}

function phaseError(phase: DeployPhase, message: string): DeployError {
  if (phase === "preflight") return preflightError(message);
  if (phase === "mutation") return mutationError(message);
  return verificationError(message);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
