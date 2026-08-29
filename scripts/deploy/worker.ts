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
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import { writeWorkerConfig } from "./realized-config.ts";
import { runAuthorityTransition } from "./retirement.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import type { WorkerDeploymentHistory } from "./worker-state.ts";

const AUTHORITY_PATHS = [
  /^bun\.lock$/u,
  /^package\.json$/u,
  /^wrangler\.jsonc$/u,
  /^scripts\/build-worker\.ts$/u,
  /^scripts\/deploy(?:\.ts|\/)/u,
  /^src\/(?:app|auth|control|deployment-composition|google-identity|identity-setup|operator-credentials|operator-key|provider-driver|provider-port|reseller|resource-deployments|resource-migrations|runtime-grants|signing-key|sponsorship-api|takos-id-identity|token)\.ts$/u,
  /^src\/(?:entry-cloudflare-worker|entry-worker|public-host-identity|router|worker-production-composition)\.ts$/u,
  /^src\/takoform\/(?:admission|admission-projection|host-authority|routes)(?:\.|\/)/u,
] as const;

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
} from "./worker-live.ts";

export interface WorkerMigrationReader {
  read(): Promise<{ readonly local: readonly string[]; readonly applied: readonly string[] }>;
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
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly review?: string;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface WorkerInspection {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string | null;
  readonly bundleDigestHex: string | null;
  readonly predecessorIdentity?: typeof LEGACY_UNATTRIBUTED_PREDECESSOR;
  readonly legacyPredecessorProfile?: typeof LEGACY_PRE_VERSION_METADATA_PROFILE;
  readonly migrations: { readonly local: readonly string[]; readonly applied: readonly string[] };
  readonly pending: readonly string[];
}

/** Paths whose code publication changes authentication, authorization or deploy authority. */
export function authoritySensitiveWorkerPaths(paths: readonly string[]): readonly string[] {
  return [
    ...new Set(paths.filter((path) => AUTHORITY_PATHS.some((pattern) => pattern.test(path)))),
  ].sort();
}

/** Routine or explicitly reviewed authority-sensitive Worker code publication. */
export async function runWorker(
  invocation: WorkerInvocation,
  target: DeployTarget,
  options: WorkerOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("Worker invocation and target environments differ");
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
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({ accountId: target.accountId, token: exactToken(environment) });
  if (invocation.legacyHostRuntimePredecessorVersionId !== undefined) {
    if (invocation.surface !== "takoserver-worker-authority-cutover") {
      throw preflightError(
        "legacy Host-runtime predecessor transition requires takoserver-worker-authority-cutover",
      );
    }
    return await runAuthorityTransition(
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
  }
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-worker-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const inspectionConfig = writeWorkerConfig(target, {
      path: join(root, "inspect-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
    });
    const migrations =
      options.migrations ?? remoteMigrationReader(inspectionConfig, environment, run);
    const before = await inspectWorker(
      "preflight",
      target,
      state,
      migrations,
      invocation.legacyPredecessorVersionId === undefined
        ? {}
        : {
            legacyPredecessorVersionId: invocation.legacyPredecessorVersionId,
            reconcileStatus: invocation.action === "status",
          },
    );

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
        ready:
          before.pending.length === 0 &&
          !legacyProfileCurrent &&
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
    if (before.pending.length > 0) {
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
      run,
    });
    const { bundlePath, configPath, bundleDigestHex } = prepared;
    const artifact = prepared.seal();
    artifact.assertUnchanged();
    if (legacyBootstrap) {
      const selector = invocation.legacyPredecessorVersionId;
      if (selector === undefined) {
        throw preflightError("Worker legacy predecessor selector is unavailable");
      }
      const last = await inspectLiveWorkerVersionWithLegacyPredecessor("preflight", target, state, {
        legacyPredecessorVersionId: selector,
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
    const message = `takoserver-worker:${source.commit}:${bundleDigestHex}`;
    const upload = await run(
      wranglerCommand([
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

    const after = await inspectWorker("verification", target, state, migrations);
    if (
      after.history.versionId === before.history.versionId ||
      after.history.previousVersionId !== before.history.versionId
    ) {
      throw verificationError(
        "authoritative Worker deployment history does not advance exactly from the previous version",
      );
    }
    if (after.commit !== source.commit || after.bundleDigestHex !== bundleDigestHex) {
      throw verificationError("served Worker annotation does not identify the sealed upload");
    }
    if (after.pending.length > 0) {
      throw verificationError("Worker publication left pending D1 migrations");
    }
    const probe = await probeProduct(
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
      previousVersionId: before.history.versionId,
      deploymentId: after.history.deploymentId,
      versionId: after.history.versionId,
      probe,
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
        `wrangler versions deploy ${before.history.versionId}@100% --yes ` +
        `--name ${target.workerName}`,
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function inspectWorker(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  migrations: WorkerMigrationReader,
  options: {
    readonly legacyPredecessorVersionId?: string;
    readonly reconcileStatus?: boolean;
  } = {},
): Promise<WorkerInspection> {
  const live =
    options.legacyPredecessorVersionId === undefined
      ? await inspectLiveWorkerVersion(phase, target, state, {})
      : options.reconcileStatus === true
        ? await inspectLiveWorkerVersionForLegacyStatus(phase, target, state, {
            legacyPredecessorVersionId: options.legacyPredecessorVersionId,
          })
        : await inspectLiveWorkerVersionWithLegacyPredecessor(phase, target, state, {
            legacyPredecessorVersionId: options.legacyPredecessorVersionId,
          });
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
  };
}

function remoteMigrationReader(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: WorkerProcess,
): WorkerMigrationReader {
  return {
    async read() {
      const local = readMigrationArtifact();
      const remote = await readD1SchemaState(new RemoteD1(configPath, { environment, run }));
      return { local: local.names, applied: remote.applied };
    },
  };
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
