import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES,
  cloudflareProviderExecutorSecretsFileName,
  materializeCloudflareProviderExecutorSecrets,
  readCloudflareProviderExecutorSecrets,
} from "./cloudflare-provider-executor-secrets.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  inspectManagedObjectReceiptAuthority,
  type ManagedObjectReceiptAuthorityState,
} from "./managed-object-receipt-authority.ts";
import {
  type ManagedWorkerDispatchNamespaceState,
  readPinnedManagedWorkerDispatchNamespace,
} from "./managed-worker-dispatch-namespace.ts";
import { type CommandResult, REPOSITORY, requireEnvironment, runCommand } from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import { writeCloudflareProviderExecutorConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact, type WorkerArtifactProcess } from "./worker-artifact.ts";
import {
  assertExactSecretInventory,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  deployExistingWranglerVersion,
  deployWranglerLifecycleChange,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

const EXECUTOR_ENTRYPOINT = "CloudflareProviderExecutor";
const EXECUTOR_MESSAGE = /^takoserver-cloudflare-provider-executor:([0-9a-f]{40}):([0-9a-f]{64})$/u;
const GATEWAY_MESSAGE = /^takoserver-managed-worker-gateway:([0-9a-f]{40}):([0-9a-f]{64})$/u;
const EXECUTOR_MIGRATION = "0045_cloudflare_provider_executor_operations.sql";
type ExecutorReadPhase = "preflight" | "verification";

export interface CloudflareProviderExecutorInvocation {
  readonly surface: "cloudflare-provider-executor";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly reverse?: boolean;
}

export interface CloudflareProviderExecutorState extends ManagedObjectReceiptAuthorityState {
  dispatchNamespace?: ManagedWorkerDispatchNamespaceState["dispatchNamespace"];
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerSecrets(workerName: string): Promise<readonly unknown[]>;
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
}

export interface CloudflareProviderExecutorSchemaReader {
  read(phase: ExecutorReadPhase): Promise<boolean>;
}

export interface CloudflareProviderExecutorDependencyInspection {
  readonly ready: boolean;
  readonly receiptAuthorityReady: boolean;
  readonly receiptAuthorityVersionId: string | null;
  readonly managedWorkerGatewayReady: boolean;
  readonly managedWorkerGatewayVersionId: string | null;
}

export interface CloudflareProviderExecutorDependencyReader {
  read(phase: ExecutorReadPhase): Promise<CloudflareProviderExecutorDependencyInspection>;
}

export interface CloudflareProviderExecutorOptions {
  readonly state?: CloudflareProviderExecutorState;
  readonly schema?: CloudflareProviderExecutorSchemaReader;
  readonly dependencies?: CloudflareProviderExecutorDependencyReader;
  readonly secretsPath?: string;
  readonly run?: WorkerArtifactProcess;
  readonly outputDirectory?: string;
  readonly review?: string;
  readonly publicationLease?: WranglerVersionPublicationLease;
  readonly accountId?: string;
}

export interface CloudflareProviderExecutorInspection {
  readonly status: "absent" | "ready" | "stale" | "drift";
  readonly ready: boolean;
  /** Exact owned executor closure, independent of the selected source commit. */
  readonly managedExact: boolean;
  readonly routeLess: boolean;
  readonly schemaReady: boolean;
  readonly dependencies: CloudflareProviderExecutorDependencyInspection;
  readonly versionId: string | null;
  readonly deploymentId: string | null;
  readonly previousVersionId: string | null;
  readonly commit: string | null;
  readonly bundleDigestHex: string | null;
  readonly moduleDigestHex: string | null;
  readonly moduleBytes: Uint8Array | null;
  readonly bindingsExact: boolean;
  readonly secretsExact: boolean;
  readonly settingsExact: boolean;
  readonly migrationExact: boolean;
}

interface ExpectedModule {
  readonly bytes: Uint8Array;
  readonly digestHex: string;
}

/**
 * Publishes the only isolate that may hold Cloudflare parent authority.
 *
 * The secret source is one canonical external file. A forward apply always
 * republishes it atomically with the sealed code because provider APIs do not
 * expose secret values for equality readback; status proves names and closure,
 * never claims the opaque values already match.
 */
export async function runCloudflareProviderExecutor(
  invocation: CloudflareProviderExecutorInvocation,
  target: DeployTarget,
  options: CloudflareProviderExecutorOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("provider executor invocation and target environments differ");
  }
  const topology = target.cloudflareProviderExecutor;
  if (!topology) {
    throw preflightError("Cloudflare provider executor requires exact target topology");
  }
  const run = options.run ?? runCommand;
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-provider-executor-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let materializedSecretPath: string | null = null;
  let result: Record<string, unknown> | undefined;
  let primaryFailure: unknown = null;
  try {
    const secretSource =
      options.secretsPath ??
      requireEnvironment("TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH");
    const secretMaterial =
      invocation.action === "apply" && invocation.reverse !== true
        ? (() => {
            const release = join(root, "release");
            mkdirSync(release, { recursive: true, mode: 0o700 });
            const held = materializeCloudflareProviderExecutorSecrets({
              sourcePath: secretSource,
              releaseRoot: release,
            });
            materializedSecretPath = held.path;
            return held;
          })()
        : readCloudflareProviderExecutorSecrets(secretSource);
    const childEnvironment = {
      CLOUDFLARE_API_TOKEN: secretMaterial.values.CLOUDFLARE_API_TOKEN,
    };
    const state =
      options.state ??
      new CloudflareState({
        accountId: options.accountId ?? target.accountId,
        token: secretMaterial.values.CLOUDFLARE_API_TOKEN,
      });
    const inspectionConfig = writeCloudflareProviderExecutorConfig(target, {
      path: join(root, "inspect-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-provider-executor.ts"),
    });
    const schema =
      options.schema ??
      remoteCloudflareProviderExecutorSchema(inspectionConfig, childEnvironment, run);
    const dependencies =
      options.dependencies === undefined
        ? cloudflareProviderExecutorDependencies(state, target, invocation.commit)
        : namespaceQualifiedDependencies(options.dependencies, state, target);
    let before = await inspectCloudflareProviderExecutor(
      "preflight",
      state,
      schema,
      dependencies,
      target,
      {
        commit: invocation.commit,
      },
    );
    const plan = planCloudflareProviderExecutor(before, invocation.reverse === true);
    if (invocation.action === "status") {
      result = statusResult(invocation, topology.workerName, before, plan);
    } else {
      const reviewer = exactReviewer(
        options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
      );
      if (plan === "refuse") {
        throw preflightError(
          "Cloudflare provider executor live state is not an exact managed predecessor",
        );
      }
      if (!before.schemaReady) {
        throw preflightError(
          `Cloudflare provider executor requires applied D1 migration ${EXECUTOR_MIGRATION}`,
        );
      }
      if (!before.dependencies.ready) {
        throw preflightError(
          "Cloudflare provider executor requires receipt authority then managed gateway to be exact-target ready",
        );
      }
      const source = await qualifySource({
        environment: invocation.environment,
        commit: invocation.commit,
        run,
      });
      await runOwnerGate(run);
      if (invocation.reverse) {
        before = await rollbackCloudflareProviderExecutor({
          invocation,
          target,
          options,
          state,
          schema,
          dependencies,
          before,
          configPath: inspectionConfig,
          childEnvironment,
          root,
        });
        result = applyResult(invocation, topology.workerName, before, reviewer, "rollback", null);
      } else {
        const prepared = await prepareWorkerArtifact({
          root,
          target,
          commit: source.commit,
          main: resolve(REPOSITORY, "src/entry-cloudflare-provider-executor.ts"),
          run,
          // A dry-run bundle build has no reason to receive either parent secret.
          environment: {},
          writeConfig: ({ path, main }) =>
            writeCloudflareProviderExecutorConfig(target, { path, main }),
        });
        if (materializedSecretPath === null) {
          throw preflightError("Cloudflare provider executor sealed secret copy is unavailable");
        }
        const artifact = prepared.seal([cloudflareProviderExecutorSecretsFileName()]);
        artifact.assertUnchanged();
        const expectedModule = expectedExecutorModule(
          prepared.bundlePath,
          prepared.bundleDigestHex,
        );
        const predecessor = await readHistory("preflight", state, topology.workerName);
        if (!sameHistory(predecessor, historyOf(before))) {
          throw preflightError("Cloudflare provider executor predecessor changed during build");
        }
        const fenced = await inspectCloudflareProviderExecutor(
          "preflight",
          state,
          schema,
          dependencies,
          target,
          { commit: invocation.commit },
        );
        if (
          !sameExecutorInspection(before, fenced) ||
          !fenced.schemaReady ||
          !fenced.dependencies.ready
        ) {
          throw preflightError("Cloudflare provider executor authority changed during build");
        }
        const lease =
          options.publicationLease ??
          (await acquireWranglerVersionPublicationLease({
            accountId: options.accountId ?? target.accountId,
            workerName: topology.workerName,
            root: join(root, "publication-lease"),
          }));
        let publication: Awaited<ReturnType<typeof deployWranglerLifecycleChange>>;
        try {
          publication = await deployWranglerLifecycleChange({
            root,
            bundlePath: prepared.bundlePath,
            configPath: prepared.configPath,
            accountId: options.accountId ?? target.accountId,
            workerName: topology.workerName,
            message: `takoserver-cloudflare-provider-executor:${source.commit}:${prepared.bundleDigestHex}`,
            lease,
            secretsFilePath: materializedSecretPath,
            environment: childEnvironment,
            run,
            assertCurrentStillExpected: async () => {
              artifact.assertUnchanged();
              const current = await inspectCloudflareProviderExecutor(
                "preflight",
                state,
                schema,
                dependencies,
                target,
                { commit: invocation.commit },
              );
              if (!sameExecutorInspection(before, current) || !current.dependencies.ready) {
                throw preflightError(
                  "Cloudflare provider executor predecessor or dependencies changed before publication",
                );
              }
            },
          });
        } catch (error) {
          const repair = await inspectCloudflareProviderExecutor(
            "preflight",
            state,
            schema,
            dependencies,
            target,
            { commit: source.commit, expectedModule },
          ).catch(() => null);
          throw mutationError(
            "Cloudflare provider executor publication acknowledgement is indeterminate; run --status before repair",
            JSON.stringify({
              versionId: repair?.versionId ?? null,
              deploymentId: repair?.deploymentId ?? null,
              commit: repair?.commit ?? null,
              ready: repair?.ready ?? false,
              cause: error instanceof Error ? error.name : typeof error,
            }),
          );
        } finally {
          await lease.release();
        }
        artifact.assertUnchanged();
        const after = await inspectCloudflareProviderExecutor(
          "verification",
          state,
          schema,
          dependencies,
          target,
          { commit: source.commit, expectedModule },
        );
        if (
          !after.ready ||
          after.versionId !== publication.versionId ||
          after.previousVersionId !== (predecessor?.versionId ?? null) ||
          publication.targets.length !== 0
        ) {
          throw verificationError(
            "Cloudflare provider executor readback does not match the sealed route-less publication",
          );
        }
        result = applyResult(
          invocation,
          topology.workerName,
          after,
          reviewer,
          predecessor === null ? "create" : "publish",
          artifact.digest,
        );
      }
    }
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure: unknown = null;
  try {
    unsealDirectory(root);
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (materializedSecretPath !== null) {
    try {
      rmSync(materializedSecretPath, { force: true });
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (temporary) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (primaryFailure !== null) throw primaryFailure;
  if (cleanupFailure !== null) {
    throw verificationError("Cloudflare provider executor release material cleanup failed");
  }
  if (result === undefined) {
    throw verificationError("Cloudflare provider executor returned no result");
  }
  return result;
}

export function planCloudflareProviderExecutor(
  inspection: CloudflareProviderExecutorInspection,
  reverse: boolean,
): "create" | "publish" | "rollback" | "refuse" {
  if (!inspection.schemaReady || !inspection.dependencies.ready) return "refuse";
  if (reverse) {
    return inspection.managedExact && inspection.previousVersionId !== null ? "rollback" : "refuse";
  }
  if (inspection.status === "absent") return "create";
  return inspection.managedExact ? "publish" : "refuse";
}

/** Exact current executor readback used by its owner and the public Worker gate. */
export async function inspectCloudflareProviderExecutor(
  phase: ExecutorReadPhase,
  state: CloudflareProviderExecutorState,
  schema: CloudflareProviderExecutorSchemaReader,
  dependencies: CloudflareProviderExecutorDependencyReader,
  target: DeployTarget,
  input: { readonly commit?: string; readonly expectedModule?: ExpectedModule } = {},
): Promise<CloudflareProviderExecutorInspection> {
  const topology = target.cloudflareProviderExecutor;
  if (!topology) throw phaseError(phase, "Cloudflare provider executor target topology is absent");
  if (topology.dispatchNamespaceId === undefined) {
    throw phaseError(phase, "Cloudflare provider executor requires a pinned dispatch namespace id");
  }
  const [history, schemaReady, dependencyState] = await Promise.all([
    readHistory(phase, state, topology.workerName),
    schema.read(phase),
    dependencies.read(phase),
  ]);
  if (history === null) {
    return absentInspection(schemaReady, dependencyState);
  }
  try {
    const [version, settings, subdomain, routes, domains, secretInventory] = await Promise.all([
      state.workerVersionWithModules(topology.workerName, history.versionId),
      state.workerSettings(topology.workerName),
      state.workerSubdomain(topology.workerName),
      state.workerRoutes(),
      state.workerDomains(),
      state.workerSecrets(topology.workerName),
    ]);
    const identity = executorVersionIdentity(phase, version, history.versionId);
    const module = moduleClosure(phase, version, input.expectedModule);
    const bindingsExact = executorBindingClosure(phase, version, target);
    let secretsExact = true;
    try {
      assertExactSecretInventory(secretInventory, CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES, phase);
    } catch (error) {
      if (phase === "verification") throw error;
      secretsExact = false;
    }
    const settingsExact = routeLessSettingsClosure(phase, version, settings, subdomain);
    const migrationExact = executorVersionMigrationClosure(version);
    const routeLess =
      routes.every((route) => route.script !== topology.workerName) &&
      domains.every((domain) => domain.service !== topology.workerName) &&
      !subdomain.enabled &&
      !subdomain.previewsEnabled;
    const moduleOwned = module.digestHex === identity.bundleDigestHex;
    const moduleExpected = input.expectedModule === undefined || module.exact;
    const managedExact =
      moduleOwned &&
      moduleExpected &&
      bindingsExact &&
      secretsExact &&
      settingsExact &&
      migrationExact &&
      routeLess;
    const commitMatches = input.commit === undefined || identity.commit === input.commit;
    const ready = managedExact && commitMatches && schemaReady && dependencyState.ready;
    return {
      status: ready ? "ready" : managedExact ? "stale" : "drift",
      ready,
      managedExact,
      routeLess,
      schemaReady,
      dependencies: dependencyState,
      versionId: history.versionId,
      deploymentId: history.deploymentId,
      previousVersionId: history.previousVersionId,
      commit: identity.commit,
      bundleDigestHex: identity.bundleDigestHex,
      moduleDigestHex: module.digestHex,
      moduleBytes: module.bytes,
      bindingsExact,
      secretsExact,
      settingsExact,
      migrationExact,
    };
  } catch (error) {
    if (phase === "verification") {
      throw phaseError(phase, "Cloudflare provider executor readback is malformed", error);
    }
    return {
      ...absentInspection(schemaReady, dependencyState),
      status: "drift",
      versionId: history.versionId,
      deploymentId: history.deploymentId,
      previousVersionId: history.previousVersionId,
    };
  }
}

/** D1 migration/shape reader used by both executor and public-Worker qualification. */
export function remoteCloudflareProviderExecutorSchema(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
  ) => Promise<CommandResult> = runCommand,
): CloudflareProviderExecutorSchemaReader {
  const database = new RemoteD1(configPath, { environment, run });
  return {
    async read(phase) {
      const [migrations, columns, indexColumns] = await Promise.all([
        database.query(
          phase,
          "Cloudflare provider executor D1 migration readback",
          `SELECT name FROM d1_migrations WHERE name = '${EXECUTOR_MIGRATION}' ORDER BY id`,
        ),
        database.query(
          phase,
          "Cloudflare provider executor operation table readback",
          "PRAGMA table_info('tf_cloudflare_provider_executor_operations')",
        ),
        database.query(
          phase,
          "Cloudflare provider executor operation index readback",
          "PRAGMA index_info('tf_cloudflare_provider_executor_operations_resource')",
        ),
      ]);
      return (
        migrations.length === 1 &&
        migrations[0]?.name === EXECUTOR_MIGRATION &&
        exactTableColumns(columns) &&
        exactIndexColumns(indexColumns)
      );
    },
  };
}

/** Live dependency proof enforces receipt -> gateway -> executor ordering. */
export function cloudflareProviderExecutorDependencies(
  state: CloudflareProviderExecutorState,
  target: DeployTarget,
  commit: string,
): CloudflareProviderExecutorDependencyReader {
  const topology = target.cloudflareProviderExecutor;
  if (!topology) throw preflightError("Cloudflare provider executor dependency topology is absent");
  const namespaceState = executorNamespaceState(state);
  return {
    async read(phase) {
      const [receipt, gateway, namespace] = await Promise.all([
        inspectManagedObjectReceiptAuthority(phase, state, {
          scriptName: topology.receiptAuthorityWorkerName,
          providerInstallationId: topology.providerInstallationId,
          accountId: target.accountId,
          commit,
        }),
        inspectManagedWorkerGatewayDependency(phase, state, target, commit),
        readPinnedManagedWorkerDispatchNamespace(phase, namespaceState, target),
      ]);
      const receiptAuthorityReady = receipt.ready && receipt.routeLess;
      return {
        ready: receiptAuthorityReady && gateway.ready && namespace.ready,
        receiptAuthorityReady,
        receiptAuthorityVersionId: receipt.versionId,
        managedWorkerGatewayReady: gateway.ready,
        managedWorkerGatewayVersionId: gateway.versionId,
      };
    },
  };
}

function namespaceQualifiedDependencies(
  dependencies: CloudflareProviderExecutorDependencyReader,
  state: CloudflareProviderExecutorState,
  target: DeployTarget,
): CloudflareProviderExecutorDependencyReader {
  const namespaceState = executorNamespaceState(state);
  return {
    async read(phase) {
      const [inspection, namespace] = await Promise.all([
        dependencies.read(phase),
        readPinnedManagedWorkerDispatchNamespace(phase, namespaceState, target),
      ]);
      return { ...inspection, ready: inspection.ready && namespace.ready };
    },
  };
}

function executorNamespaceState(
  state: CloudflareProviderExecutorState,
): ManagedWorkerDispatchNamespaceState {
  if (state.dispatchNamespace === undefined) {
    throw preflightError("Cloudflare provider executor dispatch namespace reader is unavailable");
  }
  return { dispatchNamespace: state.dispatchNamespace.bind(state) };
}

async function inspectManagedWorkerGatewayDependency(
  phase: ExecutorReadPhase,
  state: CloudflareProviderExecutorState,
  target: DeployTarget,
  commit: string,
): Promise<{ readonly ready: boolean; readonly versionId: string | null }> {
  const topology = target.cloudflareProviderExecutor;
  if (!topology) throw phaseError(phase, "managed gateway dependency topology is absent");
  const history = await readHistory(phase, state, topology.gatewayWorkerName);
  if (history === null) return { ready: false, versionId: null };
  try {
    const [version, settings, subdomain, routes, domains, secrets] = await Promise.all([
      state.workerVersionWithModules(topology.gatewayWorkerName, history.versionId),
      state.workerSettings(topology.gatewayWorkerName),
      state.workerSubdomain(topology.gatewayWorkerName),
      state.workerRoutes(),
      state.workerDomains(),
      state.workerSecrets(topology.gatewayWorkerName),
    ]);
    const identity = versionIdentity(phase, version, history.versionId, GATEWAY_MESSAGE, "gateway");
    const module = moduleClosure(phase, version);
    assertExactSecretInventory(secrets, ["TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET"], phase);
    const gatewayRoutes = routes.filter((route) => route.script === topology.gatewayWorkerName);
    const ready =
      identity.commit === commit &&
      identity.bundleDigestHex === module.digestHex &&
      gatewayBindingClosure(phase, version, target) &&
      gatewayMigrationClosure(version) &&
      routeLessSettingsClosure(phase, version, settings, subdomain) &&
      gatewayRoutes.length === 1 &&
      gatewayRoutes[0]?.pattern === `*.${topology.managedBaseDomain}/*` &&
      domains.every((domain) => domain.service !== topology.gatewayWorkerName);
    return { ready, versionId: history.versionId };
  } catch (error) {
    if (phase === "verification")
      throw phaseError(phase, "managed gateway dependency drift", error);
    return { ready: false, versionId: history.versionId };
  }
}

async function rollbackCloudflareProviderExecutor(input: {
  readonly invocation: CloudflareProviderExecutorInvocation;
  readonly target: DeployTarget;
  readonly options: CloudflareProviderExecutorOptions;
  readonly state: CloudflareProviderExecutorState;
  readonly schema: CloudflareProviderExecutorSchemaReader;
  readonly dependencies: CloudflareProviderExecutorDependencyReader;
  readonly before: CloudflareProviderExecutorInspection;
  readonly configPath: string;
  readonly childEnvironment: Readonly<Record<string, string>>;
  readonly root: string;
}): Promise<CloudflareProviderExecutorInspection> {
  const topology = input.target.cloudflareProviderExecutor;
  const previousVersionId = input.before.previousVersionId;
  if (!topology || !input.before.managedExact || previousVersionId === null) {
    throw preflightError("Cloudflare provider executor has no exact rollback predecessor");
  }
  const predecessor = await inspectExecutorVersion(
    "preflight",
    input.state,
    input.target,
    previousVersionId,
  );
  if (!predecessor.managedExact || predecessor.commit === null) {
    throw preflightError("Cloudflare provider executor rollback predecessor is not exact");
  }
  const currentHistory = historyOf(input.before);
  if (!currentHistory)
    throw preflightError("Cloudflare provider executor current history is absent");
  const lease =
    input.options.publicationLease ??
    (await acquireWranglerVersionPublicationLease({
      accountId: input.options.accountId ?? input.target.accountId,
      workerName: topology.workerName,
      root: join(input.root, "publication-lease"),
    }));
  let deployment: Awaited<ReturnType<typeof deployExistingWranglerVersion>>;
  try {
    deployment = await deployExistingWranglerVersion({
      root: input.root,
      configPath: input.configPath,
      accountId: input.options.accountId ?? input.target.accountId,
      workerName: topology.workerName,
      versionId: previousVersionId,
      message: `takoserver-cloudflare-provider-executor:rollback:${currentHistory.versionId}`,
      lease,
      environment: input.childEnvironment,
      run: input.options.run ?? runCommand,
      assertCurrentStillExpected: async () => {
        const current = await inspectCloudflareProviderExecutor(
          "preflight",
          input.state,
          input.schema,
          input.dependencies,
          input.target,
          { commit: input.invocation.commit },
        );
        if (!current.ready || !sameExecutorInspection(input.before, current)) {
          throw preflightError(
            "Cloudflare provider executor closure or dependencies changed before rollback",
          );
        }
      },
    });
  } finally {
    await lease.release();
  }
  const restoredHistory = await readHistory("verification", input.state, topology.workerName);
  if (
    restoredHistory === null ||
    restoredHistory.versionId !== previousVersionId ||
    restoredHistory.deploymentId !== deployment.deploymentId ||
    restoredHistory.previousVersionId !== currentHistory.versionId
  ) {
    throw verificationError(
      "Cloudflare provider executor rollback history does not identify the exact predecessor",
    );
  }
  const restored = await inspectCloudflareProviderExecutor(
    "verification",
    input.state,
    input.schema,
    input.dependencies,
    input.target,
    {
      commit: predecessor.commit,
      expectedModule: {
        bytes: predecessor.moduleBytes as Uint8Array,
        digestHex: predecessor.moduleDigestHex as string,
      },
    },
  );
  if (!restored.ready) {
    throw verificationError("Cloudflare provider executor rollback did not restore exact state");
  }
  return restored;
}

async function inspectExecutorVersion(
  phase: ExecutorReadPhase,
  state: CloudflareProviderExecutorState,
  target: DeployTarget,
  versionId: string,
): Promise<{
  readonly managedExact: boolean;
  readonly commit: string | null;
  readonly moduleBytes: Uint8Array | null;
  readonly moduleDigestHex: string | null;
}> {
  const topology = target.cloudflareProviderExecutor;
  if (!topology) throw phaseError(phase, "Cloudflare provider executor topology is absent");
  try {
    const version = await state.workerVersionWithModules(topology.workerName, versionId);
    const identity = executorVersionIdentity(phase, version, versionId);
    const module = moduleClosure(phase, version);
    return {
      managedExact:
        identity.bundleDigestHex === module.digestHex &&
        executorBindingClosure(phase, version, target) &&
        immutableWorkerSettingsClosure(version) &&
        executorVersionMigrationClosure(version),
      commit: identity.commit,
      moduleBytes: module.bytes,
      moduleDigestHex: module.digestHex,
    };
  } catch (error) {
    if (phase === "verification") throw error;
    return { managedExact: false, commit: null, moduleBytes: null, moduleDigestHex: null };
  }
}

function statusResult(
  invocation: CloudflareProviderExecutorInvocation,
  workerName: string,
  inspection: CloudflareProviderExecutorInspection,
  plan: ReturnType<typeof planCloudflareProviderExecutor>,
): Record<string, unknown> {
  return {
    kind: "takoserver.cloudflare-provider-executor-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    workerName,
    entrypoint: EXECUTOR_ENTRYPOINT,
    status: inspection.status,
    ready: inspection.ready,
    routeLess: inspection.routeLess,
    schemaReady: inspection.schemaReady,
    dependencies: inspection.dependencies,
    versionId: inspection.versionId,
    deploymentId: inspection.deploymentId,
    previousVersionId: inspection.previousVersionId,
    deployedCommit: inspection.commit,
    bundleDigest:
      inspection.bundleDigestHex === null ? null : `sha256:${inspection.bundleDigestHex}`,
    plan,
  };
}

function applyResult(
  invocation: CloudflareProviderExecutorInvocation,
  workerName: string,
  inspection: CloudflareProviderExecutorInspection,
  reviewer: string,
  mutation: "create" | "publish" | "rollback",
  artifactDigest: string | null,
): Record<string, unknown> {
  return {
    kind: "takoserver.cloudflare-provider-executor-apply@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    deployedCommit: inspection.commit,
    workerName,
    entrypoint: EXECUTOR_ENTRYPOINT,
    versionId: inspection.versionId,
    deploymentId: inspection.deploymentId,
    previousVersionId: inspection.previousVersionId,
    routeLess: inspection.routeLess,
    schemaReady: inspection.schemaReady,
    dependencies: inspection.dependencies,
    secretNames: CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES,
    secretPublication:
      mutation === "rollback"
        ? "restored-with-predecessor-version"
        : "atomic-wrangler-secrets-file",
    artifactDigest,
    mutation,
    reviewer,
    ready: inspection.ready,
  };
}

function executorVersionIdentity(
  phase: ExecutorReadPhase,
  value: unknown,
  versionId: string,
): { readonly commit: string; readonly bundleDigestHex: string } {
  return versionIdentity(phase, value, versionId, EXECUTOR_MESSAGE, "provider executor");
}

function versionIdentity(
  phase: ExecutorReadPhase,
  value: unknown,
  versionId: string,
  pattern: RegExp,
  label: string,
): { readonly commit: string; readonly bundleDigestHex: string } {
  if (!isRecord(value) || value.id !== versionId || !isRecord(value.annotations)) {
    throw phaseError(phase, `${label} Version identity is malformed`);
  }
  const message = value.annotations["workers/message"];
  const match = typeof message === "string" ? pattern.exec(message) : null;
  if (!match?.[1] || !match[2]) {
    throw phaseError(phase, `${label} Version upload message is malformed`);
  }
  return { commit: match[1], bundleDigestHex: match[2] };
}

function moduleClosure(
  phase: ExecutorReadPhase,
  value: unknown,
  expected?: ExpectedModule,
): { readonly bytes: Uint8Array; readonly digestHex: string; readonly exact: boolean } {
  if (!isRecord(value) || value.main_module !== "worker.js" || !Array.isArray(value.modules)) {
    throw phaseError(phase, "Worker Version module closure is malformed");
  }
  if (value.modules.length !== 1 || !isRecord(value.modules[0])) {
    throw phaseError(phase, "Worker Version module closure is not exact");
  }
  const module = value.modules[0];
  if (
    Object.keys(module).sort().join(",") !== "content_base64,content_type,name" ||
    module.name !== "worker.js" ||
    module.content_type !== "application/javascript+module" ||
    typeof module.content_base64 !== "string"
  ) {
    throw phaseError(phase, "Worker Version module is malformed");
  }
  const bytes = strictBase64(module.content_base64);
  const digestHex = createHash("sha256").update(bytes).digest("hex");
  const exact =
    expected !== undefined && expected.digestHex === digestHex && sameBytes(bytes, expected.bytes);
  return { bytes, digestHex, exact };
}

function executorBindingClosure(
  phase: ExecutorReadPhase,
  value: unknown,
  target: DeployTarget,
): boolean {
  const topology = target.cloudflareProviderExecutor;
  if (!topology) throw phaseError(phase, "Cloudflare provider executor topology is absent");
  const expected: Readonly<Record<string, BindingExpectation>> = {
    STATE_DB: { type: "d1", fields: { database_id: target.d1.databaseId } },
    OBJECTS: { type: "r2_bucket", fields: { bucket_name: target.r2.bucketName } },
    DISPATCHER: {
      type: "dispatch_namespace",
      fields: { namespace: topology.dispatchNamespace },
    },
    SQLITE_DATABASES: {
      type: "durable_object_namespace",
      fields: {
        class_name: "TakoserverManagedWorkerSqlite",
        script_name: topology.gatewayWorkerName,
      },
    },
    MANAGED_WORKER_AUTHORITY: {
      type: "service",
      fields: {
        service: topology.gatewayWorkerName,
        entrypoint: "TakoserverManagedWorkerAuthority",
      },
    },
    MANAGED_OBJECT_RECEIPT_AUTHORITY: {
      type: "service",
      fields: {
        service: topology.receiptAuthorityWorkerName,
        entrypoint: "TakoserverManagedObjectReceiptAuthority",
      },
    },
    PUBLIC_ORIGIN: { type: "plain_text", fields: { text: target.publicOrigin } },
    CLOUDFLARE_ACCOUNT_ID: { type: "plain_text", fields: { text: target.accountId } },
    TAKOSERVER_ENVIRONMENT: { type: "plain_text", fields: { text: target.environment } },
    TAKOSERVER_ZONES: {
      type: "plain_text",
      fields: { text: JSON.stringify(target.zones ?? []) },
    },
    TAKOSERVER_CLOUDFLARE_DISPATCH_NAMESPACE: {
      type: "plain_text",
      fields: { text: topology.dispatchNamespace },
    },
    TAKOSERVER_MANAGED_WORKER_GATEWAY_NAME: {
      type: "plain_text",
      fields: { text: topology.gatewayWorkerName },
    },
    TAKOSERVER_MANAGED_BASE_DOMAIN: {
      type: "plain_text",
      fields: { text: topology.managedBaseDomain },
    },
    TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID: {
      type: "plain_text",
      fields: { text: topology.providerInstallationId },
    },
    TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_NAME: {
      type: "plain_text",
      fields: { text: topology.receiptAuthorityWorkerName },
    },
    ...(target.objectBucketSupplies === undefined
      ? {}
      : {
          TAKOSERVER_OBJECT_BUCKET_SUPPLIES: {
            type: "plain_text",
            fields: { text: JSON.stringify(target.objectBucketSupplies) },
          },
        }),
    ...(target.edgeSupplies === undefined
      ? {}
      : {
          TAKOSERVER_EDGE_SUPPLIES: {
            type: "plain_text",
            fields: { text: JSON.stringify(target.edgeSupplies) },
          },
        }),
    CLOUDFLARE_API_TOKEN: { type: "secret_text", fields: {} },
    TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: { type: "secret_text", fields: {} },
  };
  return exactBindingClosure(phase, value, expected);
}

function gatewayBindingClosure(
  phase: ExecutorReadPhase,
  value: unknown,
  target: DeployTarget,
): boolean {
  const topology = target.cloudflareProviderExecutor;
  if (!topology) throw phaseError(phase, "managed gateway topology is absent");
  const bindings = rawBindings(phase, value);
  const gatewayId = bindings.find(
    (binding) => binding.name === "TAKOSERVER_MANAGED_WORKER_GATEWAY_ID",
  );
  if (
    gatewayId?.type !== "plain_text" ||
    typeof gatewayId.text !== "string" ||
    gatewayId.text.length === 0 ||
    gatewayId.text.length > 255
  ) {
    return false;
  }
  return exactBindingClosure(phase, value, {
    STATE_DB: { type: "d1", fields: { database_id: target.d1.databaseId } },
    DISPATCHER: {
      type: "dispatch_namespace",
      fields: { namespace: topology.dispatchNamespace },
    },
    SQLITE_DATABASES: {
      type: "durable_object_namespace",
      fields: { class_name: "TakoserverManagedWorkerSqlite" },
    },
    MANAGED_PROVIDER_ID: { type: "plain_text", fields: { text: "cloudflare" } },
    TAKOSERVER_MANAGED_WORKER_GATEWAY_ID: {
      type: "plain_text",
      fields: { text: gatewayId.text },
    },
    TAKOSERVER_ENVIRONMENT: { type: "plain_text", fields: { text: target.environment } },
    TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET: { type: "secret_text", fields: {} },
  });
}

interface BindingExpectation {
  readonly type: string;
  readonly fields: Readonly<Record<string, string>>;
}

function exactBindingClosure(
  phase: ExecutorReadPhase,
  value: unknown,
  expected: Readonly<Record<string, BindingExpectation>>,
): boolean {
  const bindings = rawBindings(phase, value);
  if (bindings.length !== Object.keys(expected).length) return false;
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (typeof binding.name !== "string" || seen.has(binding.name)) return false;
    seen.add(binding.name);
    const requirement = expected[binding.name];
    if (!requirement || binding.type !== requirement.type) return false;
    const keys = ["name", "type", ...Object.keys(requirement.fields)].sort().join(",");
    if (Object.keys(binding).sort().join(",") !== keys) return false;
    for (const [field, expectedValue] of Object.entries(requirement.fields)) {
      if (binding[field] !== expectedValue) return false;
    }
  }
  return true;
}

function rawBindings(phase: ExecutorReadPhase, value: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.bindings) || !value.bindings.every(isRecord)) {
    throw phaseError(phase, "Worker Version binding inventory is malformed");
  }
  return value.bindings;
}

function routeLessSettingsClosure(
  phase: ExecutorReadPhase,
  version: unknown,
  settings: unknown,
  subdomain: { readonly enabled: boolean; readonly previewsEnabled: boolean },
): boolean {
  if (!isRecord(version) || !isRecord(settings)) {
    throw phaseError(phase, "Worker settings readback is malformed");
  }
  return (
    immutableWorkerSettingsClosure(version) &&
    (settings.workers_dev === false || settings.workers_dev === undefined) &&
    (settings.preview_urls === false || settings.preview_urls === undefined) &&
    !subdomain.enabled &&
    !subdomain.previewsEnabled
  );
}

function immutableWorkerSettingsClosure(version: unknown): boolean {
  return (
    isRecord(version) &&
    version.compatibility_date === "2026-08-31" &&
    Array.isArray(version.compatibility_flags) &&
    version.compatibility_flags.length === 1 &&
    version.compatibility_flags[0] === "nodejs_compat" &&
    version.assets === undefined &&
    version.placement === undefined
  );
}

function executorVersionMigrationClosure(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.migration_tag === undefined &&
    (value.migrations === undefined ||
      (isRecord(value.migrations) && Object.keys(value.migrations).length === 0))
  );
}

function gatewayMigrationClosure(value: unknown): boolean {
  if (!isRecord(value) || value.migration_tag !== "v1") return false;
  if (value.migrations === undefined) return true;
  if (!isRecord(value.migrations)) return false;
  if (Object.keys(value.migrations).length === 0) return true;
  return (
    Object.keys(value.migrations).sort().join(",") === "new_tag,steps" &&
    value.migrations.new_tag === "v1" &&
    Array.isArray(value.migrations.steps) &&
    value.migrations.steps.length === 1 &&
    isRecord(value.migrations.steps[0]) &&
    Object.keys(value.migrations.steps[0]).join(",") === "new_sqlite_classes" &&
    Array.isArray(value.migrations.steps[0].new_sqlite_classes) &&
    value.migrations.steps[0].new_sqlite_classes.length === 1 &&
    value.migrations.steps[0].new_sqlite_classes[0] === "TakoserverManagedWorkerSqlite"
  );
}

function exactTableColumns(rows: readonly Record<string, unknown>[]): boolean {
  const expected = [
    ["operation_id", "TEXT", 1, 1],
    ["tenant_id", "TEXT", 1, 0],
    ["resource_uid", "TEXT", 1, 0],
    ["host_fingerprint", "TEXT", 1, 0],
    ["mutation_kind", "TEXT", 1, 0],
    ["logical_intent_digest", "TEXT", 1, 0],
    ["created_at", "INTEGER", 1, 0],
  ] as const;
  return (
    rows.length === expected.length &&
    rows.every((row, index) => {
      const column = expected[index];
      return (
        column !== undefined &&
        row.cid === index &&
        row.name === column[0] &&
        row.type === column[1] &&
        row.notnull === column[2] &&
        row.dflt_value === null &&
        row.pk === column[3]
      );
    })
  );
}

function exactIndexColumns(rows: readonly Record<string, unknown>[]): boolean {
  const expected = ["tenant_id", "resource_uid", "created_at"];
  return (
    rows.length === expected.length &&
    rows.every(
      (row, index) =>
        row.seqno === index && row.name === expected[index] && typeof row.cid === "number",
    )
  );
}

async function readHistory(
  phase: ExecutorReadPhase,
  state: Pick<CloudflareProviderExecutorState, "workerDeployments">,
  workerName: string,
): Promise<WorkerDeploymentHistory | null> {
  try {
    return parseWorkerDeploymentHistory(await state.workerDeployments(workerName), phase);
  } catch (error) {
    throw phaseError(phase, `${workerName} deployment history readback failed`, error);
  }
}

function historyOf(
  inspection: CloudflareProviderExecutorInspection,
): WorkerDeploymentHistory | null {
  return inspection.versionId === null || inspection.deploymentId === null
    ? null
    : {
        versionId: inspection.versionId,
        deploymentId: inspection.deploymentId,
        previousVersionId: inspection.previousVersionId,
      };
}

function sameHistory(
  left: WorkerDeploymentHistory | null,
  right: WorkerDeploymentHistory | null,
): boolean {
  return (
    left?.versionId === right?.versionId &&
    left?.deploymentId === right?.deploymentId &&
    left?.previousVersionId === right?.previousVersionId
  );
}

function sameExecutorInspection(
  left: CloudflareProviderExecutorInspection,
  right: CloudflareProviderExecutorInspection,
): boolean {
  return (
    sameHistory(historyOf(left), historyOf(right)) &&
    left.commit === right.commit &&
    left.bundleDigestHex === right.bundleDigestHex &&
    left.managedExact === right.managedExact &&
    left.schemaReady === right.schemaReady &&
    JSON.stringify(left.dependencies) === JSON.stringify(right.dependencies)
  );
}

function absentInspection(
  schemaReady: boolean,
  dependencies: CloudflareProviderExecutorDependencyInspection,
): CloudflareProviderExecutorInspection {
  return {
    status: "absent",
    ready: false,
    managedExact: false,
    routeLess: true,
    schemaReady,
    dependencies,
    versionId: null,
    deploymentId: null,
    previousVersionId: null,
    commit: null,
    bundleDigestHex: null,
    moduleDigestHex: null,
    moduleBytes: null,
    bindingsExact: false,
    secretsExact: false,
    settingsExact: false,
    migrationExact: false,
  };
}

function expectedExecutorModule(bundlePath: string, digestHex: string): ExpectedModule {
  const bytes = Uint8Array.from(readFileSync(bundlePath));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== digestHex) {
    throw preflightError("sealed Cloudflare provider executor bundle changed before readback");
  }
  return { bytes, digestHex };
}

function strictBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new TypeError("invalid base64");
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) throw new TypeError("invalid base64");
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function exactReviewer(value: string): string {
  if (value.length < 3 || value.length > 255 || value.trim() !== value || !value.includes("@")) {
    throw preflightError("Cloudflare provider executor apply requires an independent reviewer");
  }
  return value;
}

async function runOwnerGate(run: WorkerArtifactProcess): Promise<void> {
  const result = await run(["bun", "run", "check"]);
  if (result.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
}

function phaseError(phase: ExecutorReadPhase, message: string, cause?: unknown): Error {
  const detail =
    cause instanceof Error ? cause.name : cause === undefined ? undefined : typeof cause;
  return phase === "verification"
    ? verificationError(message, detail)
    : preflightError(message, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
