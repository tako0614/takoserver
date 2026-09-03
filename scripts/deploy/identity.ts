import { createHash } from "node:crypto";
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
  OPERATOR_IDENTITY_ENV,
  OPERATOR_PRIVATE_JWK_ENV,
  type PrivateKeyInput,
  provePrivateMatchesPublic,
  readOperatorSignInIdentity,
  readPrivateJwk,
  withOperatorOwnerSession,
} from "./operator-authority.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import { expectedWorkerSecrets, writeWorkerConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  assertLiveWorkerRoutingClosure,
  type LiveWorkerVersion,
  type WorkerState,
  workerVersionAnnotationProfile,
  workerVersionAuthorityBindingShape,
  workerVersionIdentity,
} from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  optionalExactPlainTextBinding,
  parseWorkerDeploymentChain,
  type WorkerDeploymentChainEntry,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";

export type { PrivateKeyInput } from "./operator-authority.ts";
export { provePrivateMatchesPublic, readPrivateJwk } from "./operator-authority.ts";

export type OperatorIdentitySurface =
  | "takoserver-integration-operator-identity"
  | "takoserver-operator-identity";

export interface OperatorIdentityInvocation {
  /** The legacy spelling remains accepted until deploy.ts/contract/docs move together. */
  readonly surface: OperatorIdentitySurface;
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  /** Required at runtime; optional in the type until the CLI integration lands. */
  readonly organizationId?: string;
}

export type OperatorIdentityProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface OperatorIdentityMigrationReader {
  read(): Promise<{ readonly local: readonly string[]; readonly applied: readonly string[] }>;
}

export interface OperatorIdentityOptions {
  readonly run?: OperatorIdentityProcess;
  readonly state?: WorkerState;
  readonly migrations?: OperatorIdentityMigrationReader;
  readonly privateJwkPath?: string;
  readonly operatorIdentityPath?: string;
  readonly review?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}

type PublicEd25519Jwk = NonNullable<DeployTarget["operatorIdentity"]>["publicJwk"];

interface IdentityInspection extends LiveWorkerVersion {
  readonly deploymentChain: readonly WorkerDeploymentChainEntry[];
  readonly version: unknown;
  readonly configuredPublicJwk: PublicEd25519Jwk | null;
  readonly configuredPublicJwkDigest: string | null;
  readonly state: "absent" | "different" | "desired";
}

const ORGANIZATION_ID = /^org_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/** Environment-neutral operator identity configuration transition. */
export async function runOperatorIdentity(
  invocation: OperatorIdentityInvocation,
  target: DeployTarget,
  options: OperatorIdentityOptions = {},
): Promise<Record<string, unknown>> {
  assertInvocation(invocation, target);
  const organizationId = invocation.organizationId;
  if (organizationId === undefined || !ORGANIZATION_ID.test(organizationId)) {
    throw preflightError("operator identity requires one exact --organization id");
  }
  const publicJwk = target.operatorIdentity?.publicJwk;
  if (!publicJwk) {
    throw preflightError("operator identity surface requires target `operatorIdentity.publicJwk`");
  }
  const desiredPublicJwkDigest = sha256(JSON.stringify(publicJwk));
  const run = options.run ?? runCommand;
  const suppliedToken =
    options.cloudflareEnvironment === undefined
      ? process.env.CLOUDFLARE_API_TOKEN
      : options.cloudflareEnvironment.CLOUDFLARE_API_TOKEN;
  if (options.state === undefined && suppliedToken === undefined) {
    throw preflightError(
      "CLOUDFLARE_API_TOKEN is required because authoritative Worker state must be read directly",
    );
  }
  const cloudflareEnvironment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-identity-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const state =
      options.state ??
      new CloudflareState({
        accountId: target.accountId,
        token: exactCloudflareToken(cloudflareEnvironment),
      });
    const migrations =
      options.migrations ??
      remoteMigrationReader(
        writeInspectionConfig(root, target, invocation.commit),
        cloudflareEnvironment,
        run,
      );
    const live = await inspectIdentity("preflight", target, state, publicJwk);
    const migrationState = await migrations.read();
    const pending = pendingMigrations(migrationState.local, migrationState.applied);

    if (invocation.action === "status") {
      const desiredCurrent = live.state === "desired";
      const configurationReady =
        desiredCurrent && live.commit === invocation.commit && pending.length === 0;
      const predecessorVersionId = desiredCurrent
        ? live.history.previousVersionId
        : live.history.versionId;
      return {
        kind: "takoserver.operator-identity-status@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        organizationId,
        state: desiredCurrent ? "desired-current" : "identity-change-required",
        selectedCommit: invocation.commit,
        deployedCommit: live.commit,
        commitMatches: live.commit === invocation.commit,
        desiredPublicJwkDigest,
        configuredPublicJwkDigest: live.configuredPublicJwkDigest,
        transition: desiredCurrent ? null : live.configuredPublicJwk === null ? "add" : "change",
        deploymentId: live.history.deploymentId,
        predecessorVersionId,
        successorVersionId: desiredCurrent ? live.history.versionId : null,
        currentVersionId: live.history.versionId,
        appliedMigrations: migrationState.applied,
        pendingMigrations: pending,
        ownerProof: "not_performed",
        mutationApplied: false,
        configurationReady,
        ready: invocation.environment === "production" ? false : configurationReady,
        readyForApply: !desiredCurrent && live.commit === invocation.commit && pending.length === 0,
        rollback:
          desiredCurrent && predecessorVersionId !== null
            ? rollbackEvidence(target, predecessorVersionId)
            : null,
      };
    }

    if (pending.length > 0) {
      throw preflightError(
        "operator identity transition refuses pending D1 migrations; apply takoserver-d1-schema first",
        JSON.stringify(pending),
      );
    }
    if (live.state === "desired") {
      throw preflightError(
        "operator identity is already exact; --apply refuses to turn a no-op into mutation evidence",
      );
    }

    const source = await qualifySource({
      environment: invocation.environment,
      commit: invocation.commit,
      run,
    });
    if (live.commit !== source.commit) {
      throw preflightError(
        "operator identity commit must equal the currently served Worker commit",
      );
    }
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    const privateInput = readPrivateJwk(
      options.privateJwkPath ?? requireEnvironment(OPERATOR_PRIVATE_JWK_ENV),
    );
    await provePrivateMatchesPublic(privateInput, publicJwk);
    const operatorIdentity = readOperatorSignInIdentity(
      options.operatorIdentityPath ?? requireEnvironment(OPERATOR_IDENTITY_ENV),
    );
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
    });
    if (prepared.bundleDigestHex !== live.bundleDigestHex) {
      throw preflightError(
        "operator identity transition refuses to carry different Worker code bytes",
        `served=sha256:${live.bundleDigestHex} built=sha256:${prepared.bundleDigestHex}`,
      );
    }
    const artifact = prepared.seal();
    artifact.assertUnchanged();

    const last = await inspectIdentity("preflight", target, state, publicJwk);
    assertSamePredecessor(live, last);
    const lastMigrations = await migrations.read();
    if (pendingMigrations(lastMigrations.local, lastMigrations.applied).length > 0) {
      throw preflightError("D1 migration lineage changed during operator identity qualification");
    }
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
      { env: cloudflareEnvironment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "operator identity upload acknowledgement is indeterminate; do not retry before --status",
        redactDiagnostics(`${upload.stdout}${upload.stderr}`.trim(), [
          cloudflareEnvironment.CLOUDFLARE_API_TOKEN,
        ]),
      );
    }

    const after = await inspectIdentity("verification", target, state, publicJwk);
    assertOnlyOperatorIdentityAdvance(live, after);
    const afterMigrations = await migrations.read();
    if (pendingMigrations(afterMigrations.local, afterMigrations.applied).length > 0) {
      throw verificationError("operator identity transition left pending D1 migrations");
    }
    if (after.history.previousVersionId === null) {
      throw verificationError(
        "operator identity successor has no authoritative rollback predecessor",
      );
    }

    let ownerProof: Awaited<ReturnType<typeof proveOwner>>;
    try {
      ownerProof = await proveOwner({
        origin: target.publicOrigin,
        organizationId,
        privateInput,
        operatorIdentity,
        fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } catch (proofFailure) {
      const rollback = await rollbackFailedOwnerProof({
        target,
        state,
        migrations,
        before: live,
        successor: after,
        proofFailure,
        configPath: prepared.configPath,
        run,
        cloudflareEnvironment,
      });
      throw verificationError(
        "operator identity owner proof failed; the exact predecessor was rolled back",
        JSON.stringify({
          cause: safeFailureMessage(proofFailure),
          predecessorVersionId: live.history.versionId,
          successorVersionId: after.history.versionId,
          rollbackDeploymentId: rollback.deploymentId,
          rollbackVersionId: rollback.versionId,
        }),
      );
    }

    const settled = await inspectIdentity("verification", target, state, publicJwk);
    assertSameSuccessor(after, settled);
    const settledMigrations = await migrations.read();
    if (pendingMigrations(settledMigrations.local, settledMigrations.applied).length > 0) {
      throw verificationError("D1 migration lineage changed during operator owner proof");
    }

    const transition = live.configuredPublicJwk === null ? "add" : "change";
    return {
      kind: "takoserver.operator-identity-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      organizationId,
      transition,
      commit: source.commit,
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      reviewer,
      desiredPublicJwkDigest,
      previousConfiguredPublicJwkDigest: live.configuredPublicJwkDigest,
      artifactDigest: artifact.digest,
      bundleDigest: `sha256:${prepared.bundleDigestHex}`,
      predecessorDeploymentId: live.history.deploymentId,
      predecessorVersionId: live.history.versionId,
      successorDeploymentId: settled.history.deploymentId,
      successorVersionId: settled.history.versionId,
      exactConfigDiff: {
        added:
          transition === "add"
            ? [{ name: "OPERATOR_IDENTITY_PUBLIC_JWK", valueDigest: desiredPublicJwkDigest }]
            : [],
        changed:
          transition === "change"
            ? [
                {
                  name: "OPERATOR_IDENTITY_PUBLIC_JWK",
                  previousValueDigest: live.configuredPublicJwkDigest,
                  valueDigest: desiredPublicJwkDigest,
                },
              ]
            : [],
        removed: [],
      },
      appliedMigrations: settledMigrations.applied,
      pendingMigrations: [],
      ownerProof,
      mutationApplied: true,
      rollback: rollbackEvidence(target, live.history.versionId),
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function inspectIdentity(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  desiredPublicJwk: PublicEd25519Jwk,
): Promise<IdentityInspection> {
  try {
    return await inspectIdentityState(phase, target, state, desiredPublicJwk);
  } catch (error) {
    if (phase === "verification" && error instanceof DeployError && error.phase !== phase) {
      throw verificationError(error.message, error.detail);
    }
    throw error;
  }
}

async function inspectIdentityState(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
  desiredPublicJwk: PublicEd25519Jwk,
): Promise<IdentityInspection> {
  const deploymentChain = parseWorkerDeploymentChain(
    await state.workerDeployments(target.workerName),
    phase,
    { requireUuidVersionIds: true },
  );
  const history = historyFromDeploymentChain(phase, deploymentChain);
  const version = await state.workerVersion(target.workerName, history.versionId);
  if (workerVersionAnnotationProfile(version) !== "canonical") {
    throw phaseError(
      phase,
      `version ${history.versionId} has a non-canonical annotation inventory`,
    );
  }
  const identity = workerVersionIdentity(phase, version);
  const raw = optionalExactPlainTextBinding(
    phase,
    history.versionId,
    version,
    "OPERATOR_IDENTITY_PUBLIC_JWK",
  );
  const configuredPublicJwk = raw === null ? null : parseConfiguredPublicJwk(phase, raw);
  const closureTarget = withConfiguredIdentity(target, configuredPublicJwk);
  const authorityProfile = authorityProfileForVersion(
    phase,
    target,
    history.versionId,
    version,
    identity,
  );
  assertExactVersionBindingClosure(
    phase,
    history.versionId,
    version,
    expectedExactBindingClosure(closureTarget, {
      signingKeyId: target.signing.currentKeyId,
      workerArtifactDigest: `sha256:${identity.bundleDigestHex}`,
      ...(authorityProfile === undefined ? {} : { authorityProfile }),
    }),
  );
  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    expectedWorkerSecrets(target),
    phase,
  );
  await assertLiveWorkerRoutingClosure(phase, target, state);
  const configuredPublicJwkDigest =
    configuredPublicJwk === null ? null : sha256(JSON.stringify(configuredPublicJwk));
  return {
    deploymentChain,
    history,
    ...identity,
    version,
    configuredPublicJwk,
    configuredPublicJwkDigest,
    state:
      configuredPublicJwk === null
        ? "absent"
        : configuredPublicJwk.x === desiredPublicJwk.x
          ? "desired"
          : "different",
  };
}

function authorityProfileForVersion(
  phase: DeployPhase,
  target: DeployTarget,
  versionId: string,
  version: unknown,
  identity: { readonly commit: string; readonly bundleDigestHex: string },
) {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  return workerVersionAuthorityBindingShape(phase, versionId, version) === "historical-pre-jit"
    ? ({ kind: "historical-pre-jit" } as const)
    : ({
        kind: "provenance-bound-jit",
        provenance: {
          sourceCommit: identity.commit,
          artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
        },
      } as const);
}

function withConfiguredIdentity(
  target: DeployTarget,
  publicJwk: PublicEd25519Jwk | null,
): DeployTarget {
  const { operatorIdentity: _operatorIdentity, ...withoutIdentity } = target;
  return publicJwk === null
    ? withoutIdentity
    : { ...withoutIdentity, operatorIdentity: { publicJwk } };
}

function parseConfiguredPublicJwk(phase: DeployPhase, raw: string): PublicEd25519Jwk {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw phaseError(phase, "Worker has a malformed OPERATOR_IDENTITY_PUBLIC_JWK binding");
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["kty", "crv", "x"]) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !BASE64URL_32.test(value.x)
  ) {
    throw phaseError(phase, "Worker has a malformed OPERATOR_IDENTITY_PUBLIC_JWK binding");
  }
  const canonical = { kty: "OKP" as const, crv: "Ed25519" as const, x: value.x };
  if (raw !== JSON.stringify(canonical)) {
    throw phaseError(phase, "Worker has a non-canonical OPERATOR_IDENTITY_PUBLIC_JWK binding");
  }
  return canonical;
}

function assertSamePredecessor(before: IdentityInspection, last: IdentityInspection): void {
  if (
    last.history.deploymentId !== before.history.deploymentId ||
    last.history.versionId !== before.history.versionId ||
    last.history.previousVersionId !== before.history.previousVersionId ||
    !sameDeploymentChain(last.deploymentChain, before.deploymentChain) ||
    last.commit !== before.commit ||
    last.bundleDigestHex !== before.bundleDigestHex ||
    last.configuredPublicJwkDigest !== before.configuredPublicJwkDigest ||
    canonicalNonIdentityResources(last.version) !== canonicalNonIdentityResources(before.version)
  ) {
    throw preflightError("Worker changed during operator identity qualification; upload refused");
  }
}

function assertOnlyOperatorIdentityAdvance(
  before: IdentityInspection,
  after: IdentityInspection,
): void {
  if (
    after.state !== "desired" ||
    after.history.versionId === before.history.versionId ||
    after.history.previousVersionId !== before.history.versionId ||
    after.commit !== before.commit ||
    after.bundleDigestHex !== before.bundleDigestHex ||
    canonicalNonIdentityResources(after.version) !== canonicalNonIdentityResources(before.version)
  ) {
    throw verificationError(
      "operator identity transition changed more than the exact OPERATOR_IDENTITY_PUBLIC_JWK variable",
    );
  }
}

function assertSameSuccessor(after: IdentityInspection, settled: IdentityInspection): void {
  if (
    settled.history.deploymentId !== after.history.deploymentId ||
    settled.history.versionId !== after.history.versionId ||
    settled.history.previousVersionId !== after.history.previousVersionId ||
    !sameDeploymentChain(settled.deploymentChain, after.deploymentChain) ||
    settled.commit !== after.commit ||
    settled.bundleDigestHex !== after.bundleDigestHex ||
    settled.configuredPublicJwkDigest !== after.configuredPublicJwkDigest ||
    canonicalNonIdentityResources(settled.version) !== canonicalNonIdentityResources(after.version)
  ) {
    throw verificationError("Worker changed during operator owner proof");
  }
}

async function proveOwner(input: {
  readonly origin: string;
  readonly organizationId: string;
  readonly privateInput: PrivateKeyInput;
  readonly operatorIdentity: ReturnType<typeof readOperatorSignInIdentity>;
  readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}) {
  const result = await withOperatorOwnerSession(
    {
      origin: input.origin,
      organizationId: input.organizationId,
      privateInput: input.privateInput,
      identity: input.operatorIdentity,
      fetcher: input.fetcher,
      ...(input.now === undefined ? {} : { now: input.now }),
      phase: "verification",
    },
    async () => undefined,
  );
  return result.proof;
}

async function rollbackFailedOwnerProof(input: {
  readonly target: DeployTarget;
  readonly state: WorkerState;
  readonly migrations: OperatorIdentityMigrationReader;
  readonly before: IdentityInspection;
  readonly successor: IdentityInspection;
  readonly proofFailure: unknown;
  readonly configPath: string;
  readonly run: OperatorIdentityProcess;
  readonly cloudflareEnvironment: Readonly<Record<string, string>>;
}): Promise<{ readonly deploymentId: string; readonly versionId: string }> {
  let current: IdentityInspection | undefined;
  let observedDeploymentChain: readonly WorkerDeploymentChainEntry[] | undefined;
  try {
    current = await inspectIdentity(
      "verification",
      input.target,
      input.state,
      input.target.operatorIdentity?.publicJwk as PublicEd25519Jwk,
    );
    observedDeploymentChain = current.deploymentChain;
    assertSameSuccessor(input.successor, current);
    const migrations = await input.migrations.read();
    if (pendingMigrations(migrations.local, migrations.applied).length > 0) {
      throw verificationError("D1 migration lineage changed before operator identity rollback");
    }
    // Closure and migration inspection are asynchronous. Re-read the strict
    // provider history after both and immediately before publication so a
    // concurrent deploy cannot be overwritten from the earlier snapshot.
    observedDeploymentChain = parseWorkerDeploymentChain(
      await input.state.workerDeployments(input.target.workerName),
      "verification",
      { requireUuidVersionIds: true },
    );
    if (!sameDeploymentChain(input.successor.deploymentChain, observedDeploymentChain)) {
      throw verificationError(
        "authoritative Worker deployment history changed during rollback qualification",
      );
    }
  } catch {
    const observedCurrent = observedDeploymentChain?.[0];
    throw verificationError(
      "operator identity owner proof failed and rollback was refused because the successor history drifted; target state is indeterminate",
      JSON.stringify({
        primary: safeFailure(input.proofFailure, "verification"),
        rollback: "not_performed",
        expectedSuccessorDeploymentId: input.successor.history.deploymentId,
        expectedSuccessorVersionId: input.successor.history.versionId,
        observedDeploymentId:
          observedCurrent?.deploymentId ?? current?.history.deploymentId ?? null,
        observedVersionId: observedCurrent?.versionId ?? current?.history.versionId ?? null,
        expectedHistoryDigest: sha256(canonicalJson(input.successor.deploymentChain)),
        observedHistoryDigest:
          observedDeploymentChain === undefined
            ? null
            : sha256(canonicalJson(observedDeploymentChain)),
      }),
    );
  }
  const rollback = await input.run(
    wranglerCommand([
      "versions",
      "deploy",
      `${input.before.history.versionId}@100%`,
      "--yes",
      "--name",
      input.target.workerName,
      "--config",
      input.configPath,
    ]),
    { env: input.cloudflareEnvironment },
  );
  if (rollback.exitCode !== 0) {
    throw verificationError(
      "operator identity owner proof failed and rollback acknowledgement is indeterminate; do not retry before --status",
      redactDiagnostics(`${rollback.stdout}${rollback.stderr}`.trim(), [
        input.cloudflareEnvironment.CLOUDFLARE_API_TOKEN,
      ]),
    );
  }
  const restored = await inspectIdentity(
    "verification",
    input.target,
    input.state,
    input.target.operatorIdentity?.publicJwk as PublicEd25519Jwk,
  );
  if (
    restored.history.deploymentId === input.before.history.deploymentId ||
    restored.history.deploymentId === input.successor.history.deploymentId ||
    restored.history.versionId !== input.before.history.versionId ||
    restored.history.previousVersionId !== input.successor.history.versionId ||
    restored.commit !== input.before.commit ||
    restored.bundleDigestHex !== input.before.bundleDigestHex ||
    restored.configuredPublicJwkDigest !== input.before.configuredPublicJwkDigest ||
    canonicalNonIdentityResources(restored.version) !==
      canonicalNonIdentityResources(input.before.version)
  ) {
    throw verificationError(
      "operator identity rollback did not restore the exact authoritative predecessor",
    );
  }
  const migrations = await input.migrations.read();
  if (pendingMigrations(migrations.local, migrations.applied).length > 0) {
    throw verificationError("operator identity rollback readback found pending D1 migrations");
  }
  return {
    deploymentId: restored.history.deploymentId,
    versionId: restored.history.versionId,
  };
}

function writeInspectionConfig(root: string, target: DeployTarget, commit: string): string {
  return writeWorkerConfig(target, {
    path: join(root, "inspect-wrangler.jsonc"),
    main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
    commit,
    ...(target.integrationE2eCredentialAuthority === undefined
      ? {}
      : { authorityProfile: { kind: "historical-pre-jit" as const } }),
  });
}

function remoteMigrationReader(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: OperatorIdentityProcess,
): OperatorIdentityMigrationReader {
  return {
    async read() {
      const local = readMigrationArtifact();
      const remote = await readD1SchemaState(new RemoteD1(configPath, { environment, run }));
      return { local: local.names, applied: remote.applied };
    },
  };
}

function canonicalNonIdentityResources(version: unknown): string {
  if (
    !isRecord(version) ||
    !isRecord(version.resources) ||
    !Array.isArray(version.resources.bindings)
  ) {
    throw preflightError("Worker Version has no canonical resource inventory");
  }
  const bindings = version.resources.bindings.filter((binding) => {
    if (!isRecord(binding)) throw preflightError("Worker Version has a malformed binding");
    const name = typeof binding.name === "string" ? binding.name : binding.binding;
    return name !== "OPERATOR_IDENTITY_PUBLIC_JWK";
  });
  return canonicalJson({ ...version.resources, bindings });
}

function rollbackEvidence(target: DeployTarget, predecessorVersionId: string) {
  return {
    kind: "takoserver.operator-identity-rollback-evidence@v1",
    environment: target.environment,
    workerName: target.workerName,
    predecessorVersionId,
    executable: false,
    recovery:
      "requires a freshly qualified product-owned exact-target recovery operation; no provider command is emitted",
  } as const;
}

function assertInvocation(invocation: OperatorIdentityInvocation, target: DeployTarget): void {
  if (target.environment !== invocation.environment) {
    throw preflightError("operator identity invocation and target environments differ");
  }
  if (
    invocation.surface !== "takoserver-integration-operator-identity" &&
    invocation.surface !== "takoserver-operator-identity"
  ) {
    throw preflightError("operator identity invocation names an unsupported surface");
  }
  if (
    invocation.surface === "takoserver-integration-operator-identity" &&
    invocation.environment !== "integration"
  ) {
    throw preflightError(
      "legacy takoserver-integration-operator-identity is restricted to integration",
    );
  }
}

function exactCloudflareToken(environment: Readonly<Record<string, string>>): string {
  const value = environment.CLOUDFLARE_API_TOKEN;
  if (!value) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return value;
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function safeFailureMessage(value: unknown): string {
  return safeFailure(value, "verification").message;
}

function safeFailure(
  value: unknown,
  fallbackPhase: DeployPhase,
): { readonly phase: DeployPhase; readonly message: string } {
  return value instanceof DeployError
    ? { phase: value.phase, message: value.message }
    : {
        phase: fallbackPhase,
        message: "operator owner proof failed; failure details redacted",
      };
}

function historyFromDeploymentChain(
  phase: DeployPhase,
  chain: readonly WorkerDeploymentChainEntry[],
): WorkerDeploymentHistory {
  const current = chain[0];
  if (current === undefined) {
    throw phaseError(phase, "Worker has no authoritative current deployment");
  }
  return {
    deploymentId: current.deploymentId,
    versionId: current.versionId,
    previousVersionId: chain[1]?.versionId ?? null,
  };
}

function sameDeploymentChain(
  left: readonly WorkerDeploymentChainEntry[],
  right: readonly WorkerDeploymentChainEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.deploymentId === right[index]?.deploymentId &&
        entry.versionId === right[index]?.versionId &&
        entry.createdOn === right[index]?.createdOn,
    )
  );
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function redactDiagnostics(value: string, secrets: readonly (string | undefined)[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

function phaseError(phase: DeployPhase, message: string, detail?: string) {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "mutation") return mutationError(message, detail);
  return verificationError(message, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
