import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { pendingMigrations, readD1SchemaState, readMigrationArtifact } from "./migrations.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import {
  expectedWorkerSecrets,
  type WorkerVersionAuthorityProfile,
  writeWorkerConfig,
} from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { probeProduct, type WorkerMigrationReader } from "./worker.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { assertTargetComposes } from "./worker-composition.ts";
import {
  assertLiveWorkerRoutingClosure,
  inspectLiveWorkerVersion,
  isWorkerVersionId,
  type WorkerState,
  workerVersionAnnotationProfile,
  workerVersionAuthorityBindingShape,
  workerVersionIdentity,
} from "./worker-live.ts";
import {
  expectedExactBindingClosure,
  parseWorkerDeploymentHistory,
  type WorkerClosureDelta,
  type WorkerDeploymentHistory,
  workerClosureDeltaIsEmpty,
  workerTransitionSecretInventory,
} from "./worker-state.ts";
import {
  assertSurfaceTransitionPredecessor,
  normalizedWorkerClosureDelta,
} from "./worker-surface-transition.ts";

/**
 * Operator-private directory holding one `0600` file per declared secret name.
 *
 * Secret bytes reach Cloudflare only through the ephemeral sealed Wrangler
 * secrets file this surface writes beside the sealed bundle. They never enter
 * argv, the child environment, success output or diagnostics.
 */
export const CLOSURE_SECRET_DIRECTORY_ENV = "TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY";

export type ClosureTransitionProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface WorkerClosureTransitionInvocation {
  readonly surface: "takoserver-worker-authority-cutover";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly closurePredecessorVersionId: string;
  readonly delta: WorkerClosureDelta;
}

export interface WorkerClosureTransitionOptions {
  readonly run?: ClosureTransitionProcess;
  readonly state?: WorkerState;
  readonly migrations?: WorkerMigrationReader;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly review?: string;
  /** Owner-private secret input root override for portable tests. */
  readonly secretDirectory?: string;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface ClosurePredecessor {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly bundleDigestHex: string;
  /** Secrets already held that this upload carries unchanged. */
  readonly carriedSecrets: readonly string[];
  /** Held by the script-level store while the served Version does not declare them. */
  readonly carriedStoreSecrets: readonly string[];
}

/**
 * Reviewed forward repair for one pinned Worker Version whose realized closure
 * legitimately predates the current target descriptor shape.
 *
 * The routine surfaces stay strict: they refuse such a predecessor and must.
 * This profile is admitted only when the operator declares the exact
 * difference, the live Version is exactly the pinned id, and that declaration
 * accounts for every difference. It then uploads the complete current closure
 * once — target vars, every required secret, and the plain-text closure the
 * routine surface would produce — and reads it back the way the cutover does.
 */
export async function runWorkerClosureTransition(
  invocation: WorkerClosureTransitionInvocation,
  target: DeployTarget,
  options: WorkerClosureTransitionOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("Worker invocation and target environments differ");
  }
  if (invocation.surface !== "takoserver-worker-authority-cutover") {
    throw preflightError("closure transition requires takoserver-worker-authority-cutover");
  }
  if (!isWorkerVersionId(invocation.closurePredecessorVersionId)) {
    throw preflightError("closure predecessor Version ID must be one exact UUID");
  }
  const delta = normalizedWorkerClosureDelta(invocation.delta);
  if (workerClosureDeltaIsEmpty(delta)) {
    throw preflightError(
      "closure transition requires a non-empty declared delta; use the routine surface instead",
    );
  }
  const run = options.run ?? runCommand;
  const suppliedToken =
    options.cloudflareEnvironment === undefined
      ? process.env.CLOUDFLARE_API_TOKEN
      : options.cloudflareEnvironment.CLOUDFLARE_API_TOKEN;
  if (options.state === undefined && suppliedToken === undefined) {
    throw preflightError(
      "CLOUDFLARE_API_TOKEN is required because Wrangler OAuth cannot prove authoritative live topology",
    );
  }
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  // A transition exists to publish a corrected target. Prove that the
  // correction composes before it can be uploaded.
  await assertTargetComposes("preflight", target);
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-worker-closure-transition-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const state =
      options.state ??
      new CloudflareState({ accountId: target.accountId, token: exactToken(environment) });
    const inspectionConfig = writeWorkerConfig(target, {
      path: join(root, "inspect-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
      ...(target.integrationE2eCredentialAuthority === undefined
        ? {}
        : { authorityProfile: { kind: "historical-pre-jit" as const } }),
    });
    const migrations =
      options.migrations ?? remoteMigrationReader(inspectionConfig, environment, run);
    const history = await currentHistory("preflight", target, state);
    const selector = invocation.closurePredecessorVersionId;

    if (invocation.action === "status" && history.versionId !== selector) {
      return await appliedClosureTransitionStatus(invocation, target, state, migrations, history);
    }
    if (history.versionId !== selector) {
      throw preflightError(
        "authoritative current Worker Version is not the pinned closure predecessor",
        `expected=${selector} actual=${history.versionId}`,
      );
    }
    const before = await admitClosurePredecessor("preflight", target, state, history, delta);
    const migrationState = await migrations.read();
    const pending = pendingMigrations(migrationState.local, migrationState.applied);

    if (invocation.action === "status") {
      return {
        kind: "takoserver.worker-closure-transition-status@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        selectedCommit: invocation.commit,
        state: "closure-predecessor-current",
        closurePredecessorVersionId: selector,
        deploymentId: before.history.deploymentId,
        versionId: before.history.versionId,
        previousVersionId: before.history.previousVersionId,
        deployedCommit: before.commit,
        artifactDigest: `sha256:${before.bundleDigestHex}`,
        delta: { ...delta },
        carriedSecrets: before.carriedSecrets,
        carriedStoreSecrets: before.carriedStoreSecrets,
        secretInputsRequired: [...delta.addedSecrets, ...delta.rotatedSecrets].sort(),
        appliedMigrations: migrationState.applied,
        pendingMigrations: pending,
        mutationApplied: false,
        ready: pending.length === 0,
      };
    }

    if (pending.length > 0) {
      throw preflightError(
        "closure transition refuses pending D1 migrations; apply takoserver-d1-schema first",
        JSON.stringify(pending),
      );
    }
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    const secretNames = [...delta.addedSecrets, ...delta.rotatedSecrets].sort();
    const secretValues =
      secretNames.length === 0
        ? {}
        : readClosureSecretInputs(
            options.secretDirectory ?? requireEnvironment(CLOSURE_SECRET_DIRECTORY_ENV),
            secretNames,
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
      run,
      writeConfig: ({ path, main, bundleDigestHex, formImplementationIdentity }) =>
        writeWorkerConfig(target, {
          path,
          main,
          commit: source.commit,
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
                      sourceCommit: source.commit,
                      artifactDigest: `sha256:${bundleDigestHex}` as const,
                    },
                  },
                }),
        }),
    });
    const secretsPath = join(prepared.releaseDirectory, "secrets.json");
    if (secretNames.length > 0) {
      writeFileSync(secretsPath, `${JSON.stringify(secretValues)}\n`, { mode: 0o600 });
    }
    const artifact = prepared.seal(secretNames.length === 0 ? [] : ["secrets.json"]);
    artifact.assertUnchanged();
    // Building and sealing sit outside the mutation window. Re-prove the exact
    // pinned predecessor immediately before the single upload.
    const requalifiedHistory = await currentHistory("preflight", target, state);
    if (
      requalifiedHistory.deploymentId !== before.history.deploymentId ||
      requalifiedHistory.versionId !== before.history.versionId ||
      requalifiedHistory.previousVersionId !== before.history.previousVersionId
    ) {
      throw preflightError("pinned closure predecessor changed before the transition upload");
    }
    const requalified = await admitClosurePredecessor(
      "preflight",
      target,
      state,
      requalifiedHistory,
      delta,
    );
    if (
      requalified.commit !== before.commit ||
      requalified.bundleDigestHex !== before.bundleDigestHex ||
      JSON.stringify(requalified.carriedSecrets) !== JSON.stringify(before.carriedSecrets) ||
      JSON.stringify(requalified.carriedStoreSecrets) !== JSON.stringify(before.carriedStoreSecrets)
    ) {
      throw preflightError("pinned closure predecessor identity changed before the upload");
    }
    const message = `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`;
    const upload = await run(
      wranglerCommand([
        "deploy",
        prepared.bundlePath,
        "--no-bundle",
        "--config",
        prepared.configPath,
        "--strict",
        "--message",
        message,
        ...(secretNames.length === 0 ? [] : ["--secrets-file", secretsPath]),
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "closure transition upload acknowledgement is indeterminate; do not retry before --status",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }
    const afterHistory = await currentHistory("verification", target, state);
    if (
      afterHistory.versionId === before.history.versionId ||
      afterHistory.previousVersionId !== before.history.versionId
    ) {
      throw verificationError("closure transition did not create the exact direct successor");
    }
    const after = await inspectLiveWorkerVersion("verification", target, state, {
      ...(target.integrationE2eCredentialAuthority === undefined
        ? {}
        : {
            authorityProfile: {
              kind: "provenance-bound-jit" as const,
              provenance: {
                sourceCommit: source.commit,
                artifactDigest: `sha256:${prepared.bundleDigestHex}` as const,
              },
            },
          }),
    });
    if (after.commit !== source.commit || after.bundleDigestHex !== prepared.bundleDigestHex) {
      throw verificationError("served Worker annotation does not identify the sealed upload");
    }
    const afterMigrations = await migrations.read();
    if (pendingMigrations(afterMigrations.local, afterMigrations.applied).length > 0) {
      throw verificationError("closure transition left pending D1 migrations");
    }
    const probe = await probeProduct(
      target.publicOrigin,
      options.fetcher ?? ((input, init) => fetch(input, init)),
    );
    const rollbackVersionId = after.history.previousVersionId;
    if (rollbackVersionId === null) {
      throw verificationError(
        "authoritative Worker deployment history does not identify the actual immediate predecessor",
      );
    }
    return {
      kind: "takoserver.worker-closure-transition-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      state: "closure-transition-applied",
      commit: source.commit,
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      reviewer,
      closurePredecessorVersionId: selector,
      delta: { ...delta },
      carriedSecrets: before.carriedSecrets,
      carriedStoreSecrets: before.carriedStoreSecrets,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      bundleDigest: `sha256:${prepared.bundleDigestHex}`,
      preMutationObservedVersionId: before.history.versionId,
      previousVersionId: rollbackVersionId,
      deploymentId: after.history.deploymentId,
      versionId: after.history.versionId,
      probe,
      mutationApplied: true,
      rollback:
        `wrangler versions deploy ${rollbackVersionId}@100% --yes ` + `--name ${target.workerName}`,
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Settles a lost upload acknowledgement. Only the exact direct successor of the
 * pinned predecessor is related to that attempt; any other advance fails closed
 * and is never attributed to this transition.
 */
async function appliedClosureTransitionStatus(
  invocation: WorkerClosureTransitionInvocation,
  target: DeployTarget,
  state: WorkerState,
  migrations: WorkerMigrationReader,
  history: WorkerDeploymentHistory,
): Promise<Record<string, unknown>> {
  const selector = invocation.closurePredecessorVersionId;
  if (history.previousVersionId !== selector) {
    throw preflightError(
      "authoritative current Worker Version is neither the pinned closure predecessor nor its direct successor",
      `expected=${selector} actual=${history.versionId} actual_previous=${history.previousVersionId ?? "none"}`,
    );
  }
  const successor = await inspectLiveWorkerVersion("preflight", target, state, {
    ...(target.integrationE2eCredentialAuthority === undefined
      ? {}
      : { authorityProfile: { kind: "provenance-bound-jit" as const } }),
  });
  const migrationState = await migrations.read();
  const pending = pendingMigrations(migrationState.local, migrationState.applied);
  return {
    kind: "takoserver.worker-closure-transition-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    state: "closure-transition-applied",
    closurePredecessorVersionId: selector,
    deploymentId: successor.history.deploymentId,
    versionId: successor.history.versionId,
    previousVersionId: successor.history.previousVersionId,
    deployedCommit: successor.commit,
    artifactDigest: `sha256:${successor.bundleDigestHex}`,
    delta: { ...normalizedWorkerClosureDelta(invocation.delta) },
    appliedMigrations: migrationState.applied,
    pendingMigrations: pending,
    mutationApplied: false,
    ready: pending.length === 0 && successor.commit === invocation.commit,
  };
}

/**
 * Proves the pinned Version is exactly the target closure with the declared
 * delta reversed. Every other binding name, type and plain-text value and the
 * routing closure stay as strict as the routine path. The secret inventory is
 * the union of what the Version declares and what the script-level store holds,
 * because a rollback leaves the store ahead of the Version and a required
 * secret the Worker already holds is carried rather than demanded again.
 */
async function admitClosurePredecessor(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  history: WorkerDeploymentHistory,
  delta: WorkerClosureDelta,
): Promise<ClosurePredecessor> {
  const versionId = history.versionId;
  const version = await state.workerVersion(target.workerName, versionId);
  if (workerVersionAnnotationProfile(version) !== "canonical") {
    throw phaseError(phase, `version ${versionId} has a non-canonical annotation inventory`);
  }
  const identity = workerVersionIdentity(phase, version);
  const workerArtifactDigest = `sha256:${identity.bundleDigestHex}` as const;
  const authorityProfile = predecessorAuthorityProfile(phase, target, versionId, version, identity);
  const bindingInput = {
    ...(authorityProfile === undefined ? {} : { authorityProfile }),
    workerArtifactDigest,
  } as const;
  const targetClosure = expectedExactBindingClosure(target, bindingInput);
  const targetSecrets = expectedWorkerSecrets(target);
  const secrets = workerTransitionSecretInventory(
    phase,
    versionId,
    version,
    await state.workerSecrets(target.workerName),
    targetSecrets,
  );
  // One shared admission for every Worker-publishing surface: the declaration
  // must describe this target, account for the entire difference, and leave the
  // rest of the closure exactly as strict as the routine path.
  assertSurfaceTransitionPredecessor(phase, versionId, version, {
    delta,
    targetClosure,
    targetSecrets,
    carriedStoreSecrets: secrets.carriedStoreSecrets,
  });
  const carriedSecrets = targetSecrets.filter((name) => !delta.addedSecrets.includes(name));
  await assertLiveWorkerRoutingClosure(phase, target, state);
  const after = await currentHistory(phase, target, state);
  if (
    after.deploymentId !== history.deploymentId ||
    after.versionId !== history.versionId ||
    after.previousVersionId !== history.previousVersionId
  ) {
    throw phaseError(
      phase,
      "authoritative Worker deployment history changed during closure transition inspection",
    );
  }
  return { history, ...identity, carriedSecrets, carriedStoreSecrets: secrets.carriedStoreSecrets };
}

/**
 * A JIT-enabled target must select an exact authority profile. The pinned
 * predecessor's own binding inventory decides which one; a partial profile
 * fails closed inside the classifier.
 */
function predecessorAuthorityProfile(
  phase: DeployPhase,
  target: DeployTarget,
  versionId: string,
  version: unknown,
  identity: { readonly commit: string; readonly bundleDigestHex: string },
): WorkerVersionAuthorityProfile | undefined {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  return workerVersionAuthorityBindingShape(phase, versionId, version) === "historical-pre-jit"
    ? { kind: "historical-pre-jit" }
    : {
        kind: "provenance-bound-jit",
        provenance: {
          sourceCommit: identity.commit,
          artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
        },
      };
}

/**
 * Reads the declared secret values from the operator-private input directory.
 * Only names, the exact refusal reason and byte-free diagnostics leave here.
 */
export function readClosureSecretInputs(
  directory: string,
  names: readonly string[],
): Readonly<Record<string, string>> {
  if (!isAbsolute(directory)) {
    throw preflightError(`${CLOSURE_SECRET_DIRECTORY_ENV} must be one absolute path`);
  }
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(directory);
  } catch {
    throw preflightError(`${CLOSURE_SECRET_DIRECTORY_ENV} is unavailable`);
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o7777) !== 0o700 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw preflightError(
      `${CLOSURE_SECRET_DIRECTORY_ENV} must be an owned exact 0700 link-free directory`,
    );
  }
  const values: Record<string, string> = {};
  for (const name of names) {
    values[name] = readClosureSecretValue(join(directory, name), name);
  }
  return values;
}

function readClosureSecretValue(path: string, name: string): string {
  let status: ReturnType<typeof lstatSync>;
  let raw: string;
  try {
    status = lstatSync(path);
    raw = readFileSync(path, "utf8");
  } catch {
    throw preflightError(`closure transition secret input ${name} is unavailable`);
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
    raw.length === 0 ||
    raw.length > 16_384 ||
    raw.trim() !== raw ||
    [...raw].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw preflightError(
      `closure transition secret input ${name} must be an owned 0600 exact non-whitespace regular file`,
    );
  }
  return raw;
}

async function currentHistory(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
): Promise<WorkerDeploymentHistory> {
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(target.workerName),
    phase,
  );
  if (history === null) throw phaseError(phase, "Worker has no authoritative current deployment");
  return history;
}

function remoteMigrationReader(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: ClosureTransitionProcess,
): WorkerMigrationReader {
  return {
    async read() {
      const local = readMigrationArtifact();
      const remote = await readD1SchemaState(new RemoteD1(configPath, { environment, run }));
      return { local: local.names, applied: remote.applied };
    },
  };
}

function phaseError(phase: DeployPhase, message: string, detail?: string) {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "mutation") return mutationError(message, detail);
  return verificationError(message, detail);
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
