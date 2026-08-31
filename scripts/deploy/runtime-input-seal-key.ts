import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  inspectCanonicalRuntimeInputSealKeyRing,
  parseRuntimeInputSealKeyRingDescriptor,
  type RuntimeInputSealKeyRingDescriptor,
} from "../../src/runtime-input-seal-keyring.ts";
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
  type D1SchemaState,
  pendingMigrations,
  readD1SchemaState,
  readMigrationArtifact,
} from "./migrations.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  type SourceQualification,
} from "./qualification.ts";
import { expectedWorkerSecrets, writeWorkerConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { probeProduct } from "./worker.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  type CanonicalWorkerVersionWithScriptIdentity,
  inspectCanonicalWorkerVersionWithScriptIdentity,
  type WorkerState,
  workerVersionAuthorityBindingShape,
} from "./worker-live.ts";
import {
  optionalExactPlainTextBinding,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";

const SECRET_NAME = "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING";
const CURRENT_KEY_ID = "TAKOSERVER_RUNTIME_INPUT_SEAL_CURRENT_KEY_ID";
const PREVIOUS_KEY_IDS = "TAKOSERVER_RUNTIME_INPUT_SEAL_PREVIOUS_KEY_IDS";
const KEYRING_COMMITMENT = "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING_COMMITMENT";
const REQUIRED_SCHEMA_PREFIX = "0032_";
const MAX_KEYRING_BYTES = 16 * 1024;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type RuntimeInputSealKeyProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface RuntimeInputSealKeyDatabase {
  readSchemaState(phase?: DeployPhase): Promise<D1SchemaState>;
  readLiveKeyUsage(
    phase?: DeployPhase,
  ): Promise<readonly { readonly keyId: string; readonly rowCount: number }[]>;
}

export interface RuntimeInputSealKeyInvocation {
  readonly surface: "takoserver-runtime-input-seal-key";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface RuntimeInputSealKeyOptions {
  readonly run?: RuntimeInputSealKeyProcess;
  readonly state?: WorkerState;
  readonly database?: RuntimeInputSealKeyDatabase;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly keyringPath?: string;
  readonly review?: string;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

type TransitionState = "bootstrap-required" | "rotation-required" | "desired-current";

interface WorkerInspection {
  readonly state: TransitionState;
  readonly descriptor: RuntimeInputSealKeyRingDescriptor | null;
  readonly canonical: CanonicalWorkerVersionWithScriptIdentity;
}

interface SchemaInspection {
  readonly ready: boolean;
  readonly applied: readonly string[];
  readonly pending: readonly string[];
  readonly shapeDigest: string;
}

interface SealedRows {
  readonly total: number;
  readonly byKeyId: readonly { readonly keyId: string; readonly count: number }[];
}

interface DatabaseInspection {
  readonly schema: SchemaInspection;
  readonly rows: SealedRows | null;
  readonly safe: boolean;
}

/** Sole authority for the runtime-input seal key ring and its Worker metadata. */
export async function runRuntimeInputSealKey(
  invocation: RuntimeInputSealKeyInvocation,
  target: DeployTarget,
  options: RuntimeInputSealKeyOptions = {},
): Promise<Record<string, unknown>> {
  assertInvocation(invocation, target);
  const desired = requiredDescriptor(target);
  const run = options.run ?? runCommand;
  const suppliedToken =
    options.cloudflareEnvironment === undefined
      ? process.env.CLOUDFLARE_API_TOKEN
      : options.cloudflareEnvironment.CLOUDFLARE_API_TOKEN;
  if (
    (options.state === undefined || options.database === undefined) &&
    suppliedToken === undefined
  ) {
    throw preflightError(
      "CLOUDFLARE_API_TOKEN is required because exact Worker and D1 readback are authoritative",
    );
  }
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && options.database !== undefined
      ? {}
      : cloudflareChildEnvironment());
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-runtime-input-seal-key-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });

  try {
    const inspectionConfig = writeWorkerConfig(target, {
      path: join(root, "inspect-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
      ...(target.integrationE2eCredentialAuthority === undefined
        ? {}
        : { authorityProfile: { kind: "historical-pre-jit" as const } }),
    });
    const state =
      options.state ??
      new CloudflareState({ accountId: target.accountId, token: exactToken(environment) });
    const database =
      options.database ?? remoteRuntimeInputSealDatabase(inspectionConfig, environment, run);
    const before = await inspectWorker("preflight", target, desired, state);
    const beforeDatabase = await inspectDatabase("preflight", database, before.state, desired);
    const activeKeyRetained = retainsObservedActiveKey(before, desired);

    if (invocation.action === "status") {
      const probe = await probeProduct(
        target.publicOrigin,
        options.fetcher ?? ((input, init) => fetch(input, init)),
      );
      const stable = await inspectWorker("verification", target, desired, state);
      assertSameInspection(
        "verification",
        before,
        stable,
        "Worker state changed during status readback",
      );
      const commitMatches = before.canonical.commit === invocation.commit;
      return statusResult(
        invocation,
        desired,
        before,
        beforeDatabase,
        probe,
        commitMatches,
        activeKeyRetained,
      );
    }

    if (!beforeDatabase.schema.ready) {
      throw preflightError(
        "runtime-input seal-key deployment requires the complete local D1 migration lineage including 0032",
      );
    }
    if (!beforeDatabase.safe) {
      throw preflightError(
        before.state === "bootstrap-required"
          ? "runtime-input seal-key bootstrap requires zero prepared or claimed sealed rows"
          : "desired runtime-input key ids do not cover every live sealed-row key id",
      );
    }
    if (!activeKeyRetained) {
      throw preflightError(
        "runtime-input seal-key rotation must retain the observed active key as a previous key",
      );
    }
    if (before.state === "desired-current") {
      throw preflightError(
        "runtime-input seal-key is already exact; settle this operation with --status",
      );
    }

    const keyring = await readOwnedCanonicalKeyring(
      options.keyringPath ?? requireEnvironment("TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING_PATH"),
      desired,
    );
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    const source = await qualifySource({
      environment: invocation.environment,
      commit: invocation.commit,
      run,
    });
    await checked(run, "preflight", "scoped owner gate `bun run check`", ["bun", "run", "check"]);

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
          transitionExpectedSecrets:
            bundleDigestHex === undefined
              ? expectedWorkerSecrets(target).filter((name) => name !== SECRET_NAME)
              : expectedWorkerSecrets(target),
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
    writeFileSync(secretsPath, JSON.stringify({ [SECRET_NAME]: keyring.raw }), { mode: 0o600 });
    const artifact = prepared.seal(["secrets.json"]);
    artifact.assertUnchanged();

    const last = await inspectWorker("preflight", target, desired, state);
    assertSameInspection(
      "preflight",
      before,
      last,
      "Worker state changed before runtime-input key upload",
    );
    const lastDatabase = await inspectDatabase("preflight", database, last.state, desired);
    if (
      !lastDatabase.schema.ready ||
      !lastDatabase.safe ||
      !retainsObservedActiveKey(last, desired) ||
      !sameSchemaInspection(beforeDatabase.schema, lastDatabase.schema)
    ) {
      throw preflightError("D1 sealed-row key usage changed before runtime-input key upload");
    }
    const requalifiedSource = await qualifySource({
      environment: invocation.environment,
      commit: invocation.commit,
      run,
    });
    assertSourceQualificationUnchanged(source, requalifiedSource);
    artifact.assertUnchanged();

    const message = `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`;
    let upload: CommandResult;
    try {
      upload = await run(
        wranglerCommand([
          "deploy",
          prepared.bundlePath,
          "--no-bundle",
          "--config",
          prepared.configPath,
          "--strict",
          "--message",
          message,
          "--secrets-file",
          secretsPath,
        ]),
        { env: environment },
      );
    } catch {
      throw mutationError(
        "runtime-input seal-key upload acknowledgement is indeterminate; do not retry before --status",
        "Wrangler execution threw; diagnostics withheld because the command carried secret material",
      );
    }
    if (upload.exitCode !== 0) {
      throw mutationError(
        "runtime-input seal-key upload acknowledgement is indeterminate; do not retry before --status",
        `wrangler exited ${upload.exitCode}; diagnostics withheld because the command carried secret material`,
      );
    }

    const after = await inspectWorker("verification", target, desired, state);
    assertDirectSuccessor(before, after, source.commit, prepared.bundleDigestHex);
    const afterDatabase = await inspectDatabase("verification", database, after.state, desired);
    if (
      !afterDatabase.schema.ready ||
      !afterDatabase.safe ||
      !sameSchemaInspection(beforeDatabase.schema, afterDatabase.schema)
    ) {
      throw verificationError("runtime-input seal-key post-readback failed the D1 live-key fence");
    }
    const probe = await probeProduct(
      target.publicOrigin,
      options.fetcher ?? ((input, init) => fetch(input, init)),
    );
    const stable = await inspectWorker("verification", target, desired, state);
    assertSameInspection(
      "verification",
      after,
      stable,
      "Worker state changed during post-upload product probe",
    );

    return {
      kind: "takoserver.runtime-input-seal-key-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      transition: before.state === "bootstrap-required" ? "bootstrap" : "rotation",
      commit: source.commit,
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      reviewer,
      currentKeyId: desired.currentKeyId,
      previousKeyIds: desired.previousKeyIds,
      commitment: desired.commitment,
      schemaDigest: afterDatabase.schema.shapeDigest,
      sealedRows: afterDatabase.rows,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      bundleDigest: `sha256:${prepared.bundleDigestHex}`,
      preMutationObservedVersionId: before.canonical.history.versionId,
      previousVersionId: after.canonical.history.previousVersionId,
      deploymentId: after.canonical.history.deploymentId,
      versionId: after.canonical.history.versionId,
      probe,
      reversal:
        "Forward repair requires a separately reviewed retained prior canonical keyring and matching target descriptor; Worker Version rollback does not restore the script-wide secret.",
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

function assertInvocation(invocation: RuntimeInputSealKeyInvocation, target: DeployTarget): void {
  if (invocation.surface !== "takoserver-runtime-input-seal-key") {
    throw preflightError("runtime-input seal-key invocation selected the wrong surface");
  }
  if (target.environment !== invocation.environment) {
    throw preflightError("runtime-input seal-key invocation and target environments differ");
  }
  if (target.edgeSupplies === undefined || target.runtimeInputSealKeyring === undefined) {
    throw preflightError(
      "runtime-input seal-key authority requires one edge-supplies target descriptor",
    );
  }
}

function requiredDescriptor(target: DeployTarget): RuntimeInputSealKeyRingDescriptor {
  return parseRuntimeInputSealKeyRingDescriptor(target.runtimeInputSealKeyring);
}

async function inspectWorker(
  phase: DeployPhase,
  desiredTarget: DeployTarget,
  desired: RuntimeInputSealKeyRingDescriptor,
  state: WorkerState,
): Promise<WorkerInspection> {
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(desiredTarget.workerName),
    phase,
  );
  if (history === null) throw phaseError(phase, "Worker has no authoritative current deployment");
  const version = await state.workerVersion(desiredTarget.workerName, history.versionId);
  const currentKeyId = optionalExactPlainTextBinding(
    phase,
    history.versionId,
    version,
    CURRENT_KEY_ID,
  );
  const previousKeyIds = optionalExactPlainTextBinding(
    phase,
    history.versionId,
    version,
    PREVIOUS_KEY_IDS,
  );
  const commitment = optionalExactPlainTextBinding(
    phase,
    history.versionId,
    version,
    KEYRING_COMMITMENT,
  );
  const present = [currentKeyId, previousKeyIds, commitment].filter(
    (value) => value !== null,
  ).length;
  if (present !== 0 && present !== 3) {
    throw phaseError(phase, "Worker has a partial runtime-input seal-key metadata profile");
  }

  let descriptor: RuntimeInputSealKeyRingDescriptor | null = null;
  if (present === 3) {
    let previous: unknown;
    try {
      previous = JSON.parse(previousKeyIds as string);
    } catch {
      throw phaseError(phase, "Worker has an invalid runtime-input seal-key metadata profile");
    }
    try {
      descriptor = parseRuntimeInputSealKeyRingDescriptor({
        currentKeyId,
        previousKeyIds: previous,
        commitment,
      });
    } catch {
      throw phaseError(phase, "Worker has an invalid runtime-input seal-key metadata profile");
    }
  }
  const selectedTarget = targetForDescriptor(desiredTarget, descriptor);
  const authorityProfile = authoritySelection(phase, selectedTarget, history.versionId, version);
  const canonical = await inspectCanonicalWorkerVersionWithScriptIdentity(
    phase,
    selectedTarget,
    state,
    authorityProfile === undefined ? {} : { authorityProfile },
  );
  if (!sameHistory(history, canonical.history)) {
    throw phaseError(phase, "Worker deployment history changed during seal-key classification");
  }
  return {
    state:
      descriptor === null
        ? "bootstrap-required"
        : sameDescriptor(descriptor, desired)
          ? "desired-current"
          : "rotation-required",
    descriptor,
    canonical,
  };
}

function authoritySelection(
  phase: DeployPhase,
  target: DeployTarget,
  versionId: string,
  version: unknown,
): { readonly kind: "historical-pre-jit" | "provenance-bound-jit" } | undefined {
  if (target.integrationE2eCredentialAuthority === undefined) return undefined;
  return { kind: workerVersionAuthorityBindingShape(phase, versionId, version) };
}

function targetForDescriptor(
  target: DeployTarget,
  descriptor: RuntimeInputSealKeyRingDescriptor | null,
): DeployTarget {
  const { runtimeInputSealKeyring: _descriptor, ...withoutDescriptor } = target;
  return descriptor === null
    ? withoutDescriptor
    : { ...withoutDescriptor, runtimeInputSealKeyring: descriptor };
}

async function inspectDatabase(
  phase: DeployPhase,
  database: RuntimeInputSealKeyDatabase,
  state: TransitionState,
  desired: RuntimeInputSealKeyRingDescriptor,
): Promise<DatabaseInspection> {
  const local = readMigrationArtifact().names;
  const schemaState = await database.readSchemaState(phase);
  const pending = pendingMigrations(local, schemaState.applied);
  const required = local.find((name) => name.startsWith(REQUIRED_SCHEMA_PREFIX));
  if (required === undefined) {
    throw phaseError(phase, "selected source has no runtime-input preparations schema migration");
  }
  const schema: SchemaInspection = {
    ready: schemaState.applied.includes(required) && pending.length === 0,
    applied: schemaState.applied,
    pending,
    shapeDigest: schemaState.shapeDigest,
  };
  if (!schema.ready) return { schema, rows: null, safe: false };
  const usages = normalizeKeyUsage(await database.readLiveKeyUsage(phase), phase);
  const rows = {
    total: usages.reduce((total, { rowCount }) => total + rowCount, 0),
    byKeyId: usages.map(({ keyId, rowCount }) => ({ keyId, count: rowCount })),
  };
  if (!Number.isSafeInteger(rows.total)) {
    throw phaseError(phase, "D1 live sealed-row key usage total exceeds the safe integer bound");
  }
  const desiredIds = new Set([desired.currentKeyId, ...desired.previousKeyIds]);
  const safe =
    state === "bootstrap-required"
      ? rows.total === 0
      : usages.every(({ keyId }) => desiredIds.has(keyId));
  return { schema, rows, safe };
}

function normalizeKeyUsage(
  usages: readonly { readonly keyId: string; readonly rowCount: number }[],
  phase: DeployPhase,
): readonly { readonly keyId: string; readonly rowCount: number }[] {
  const normalized = usages.map(({ keyId, rowCount }) => {
    if (!KEY_ID.test(keyId) || !Number.isSafeInteger(rowCount) || rowCount <= 0) {
      throw phaseError(phase, "D1 live sealed-row key usage returned a malformed row");
    }
    return { keyId, rowCount };
  });
  const sorted = [...normalized].sort((left, right) => left.keyId.localeCompare(right.keyId));
  if (
    new Set(sorted.map(({ keyId }) => keyId)).size !== sorted.length ||
    JSON.stringify(normalized) !== JSON.stringify(sorted)
  ) {
    throw phaseError(phase, "D1 live sealed-row key usage is not one canonical grouped inventory");
  }
  return sorted;
}

function remoteRuntimeInputSealDatabase(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: RuntimeInputSealKeyProcess,
): RuntimeInputSealKeyDatabase {
  const remote = new RemoteD1(configPath, { environment, run });
  return {
    readSchemaState: async (phase = "preflight") => await readD1SchemaState(remote, phase),
    readLiveKeyUsage: async (phase = "preflight") => {
      const rows = await remote.query(
        phase,
        "D1 runtime-input live sealed-row key usage",
        "SELECT seal_key_id, COUNT(*) AS row_count " +
          "FROM worker_runtime_input_preparations " +
          "WHERE state IN ('prepared', 'claimed') AND seal_key_id IS NOT NULL " +
          "GROUP BY seal_key_id ORDER BY seal_key_id",
      );
      return rows.map((row) => {
        if (
          typeof row.seal_key_id !== "string" ||
          (typeof row.row_count !== "number" && typeof row.row_count !== "string")
        ) {
          throw phaseError(phase, "D1 live sealed-row key usage returned a malformed row");
        }
        if (typeof row.row_count === "string" && !/^[1-9][0-9]*$/u.test(row.row_count)) {
          throw phaseError(phase, "D1 live sealed-row key usage returned a malformed count");
        }
        const count = typeof row.row_count === "number" ? row.row_count : Number(row.row_count);
        return { keyId: row.seal_key_id, rowCount: count };
      });
    },
  };
}

async function readOwnedCanonicalKeyring(
  path: string,
  desired: RuntimeInputSealKeyRingDescriptor,
): Promise<{ readonly raw: string }> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw preflightError("runtime-input seal keyring path must be one absolute normalized path");
  }
  assertLinkFreePath(path);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw preflightError("runtime-input seal keyring file could not be opened safely");
  }
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o7777) !== 0o600 ||
      before.size < 1 ||
      before.size > MAX_KEYRING_BYTES
    ) {
      throw preflightError(
        "runtime-input seal keyring must be an owned, link-free, exact-0600 bounded regular file",
      );
    }
    let openedPath: string;
    try {
      openedPath = realpathSync(`/proc/self/fd/${descriptor}`);
    } catch {
      throw preflightError("runtime-input seal keyring file identity could not be proven");
    }
    if (openedPath !== path) {
      throw preflightError("runtime-input seal keyring path changed while it was opened");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const named = lstatSync(path);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      bytes.byteLength !== before.size
    ) {
      throw preflightError("runtime-input seal keyring file changed while it was read");
    }
    const raw = bytes.toString("utf8");
    let actual: RuntimeInputSealKeyRingDescriptor;
    try {
      actual = await inspectCanonicalRuntimeInputSealKeyRing(raw);
    } catch {
      throw preflightError("runtime-input seal keyring file is not canonical and valid");
    }
    if (!sameDescriptor(actual, desired)) {
      throw preflightError("runtime-input seal keyring does not match the exact target descriptor");
    }
    return { raw };
  } finally {
    closeSync(descriptor);
  }
}

function assertLinkFreePath(path: string): void {
  const root = parse(path).root;
  const components: string[] = [];
  let current = path;
  while (current !== root) {
    components.push(current);
    current = dirname(current);
  }
  components.push(root);
  for (const component of components.reverse()) {
    let status: ReturnType<typeof lstatSync>;
    try {
      status = lstatSync(component);
    } catch {
      throw preflightError("runtime-input seal keyring path is not a complete link-free path");
    }
    if (status.isSymbolicLink()) {
      throw preflightError("runtime-input seal keyring path must not contain symbolic links");
    }
  }
  if (realpathSync(path) !== path) {
    throw preflightError("runtime-input seal keyring path must resolve to itself exactly");
  }
}

function statusResult(
  invocation: RuntimeInputSealKeyInvocation,
  desired: RuntimeInputSealKeyRingDescriptor,
  worker: WorkerInspection,
  database: DatabaseInspection,
  probe: Awaited<ReturnType<typeof probeProduct>>,
  commitMatches: boolean,
  activeKeyRetained: boolean,
): Record<string, unknown> {
  const applyReady =
    worker.state !== "desired-current" &&
    database.schema.ready &&
    database.safe &&
    activeKeyRetained;
  return {
    kind: "takoserver.runtime-input-seal-key-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    state: worker.state,
    selectedCommit: invocation.commit,
    deployedCommit: worker.canonical.commit,
    commitMatches,
    deploymentId: worker.canonical.history.deploymentId,
    versionId: worker.canonical.history.versionId,
    previousVersionId: worker.canonical.history.previousVersionId,
    artifactDigest: `sha256:${worker.canonical.bundleDigestHex}`,
    scriptEtag: worker.canonical.scriptEtag,
    currentKeyId: desired.currentKeyId,
    previousKeyIds: desired.previousKeyIds,
    commitment: desired.commitment,
    observedDescriptor: worker.descriptor,
    schemaReady: database.schema.ready,
    schemaDigest: database.schema.shapeDigest,
    appliedMigrations: database.schema.applied,
    pendingMigrations: database.schema.pending,
    sealedRows: database.rows,
    activeKeyRetained,
    applyReady,
    ready:
      worker.state === "desired-current" && commitMatches && database.schema.ready && database.safe,
    probe,
    reversal:
      "Forward repair requires a separately reviewed retained prior canonical keyring and matching target descriptor; Worker Version rollback does not restore the script-wide secret.",
  };
}

function retainsObservedActiveKey(
  worker: WorkerInspection,
  desired: RuntimeInputSealKeyRingDescriptor,
): boolean {
  if (worker.state !== "rotation-required") return true;
  return (
    worker.descriptor !== null &&
    worker.descriptor.currentKeyId !== desired.currentKeyId &&
    desired.previousKeyIds.includes(worker.descriptor.currentKeyId)
  );
}

function assertSourceQualificationUnchanged(
  before: SourceQualification,
  after: SourceQualification,
): void {
  if (
    before.commit !== after.commit ||
    before.branch !== after.branch ||
    before.dirty !== after.dirty ||
    before.remoteRef !== after.remoteRef ||
    JSON.stringify(before.changedPaths) !== JSON.stringify(after.changedPaths)
  ) {
    throw preflightError("selected source changed while the seal-key upload was prepared");
  }
}

function assertDirectSuccessor(
  before: WorkerInspection,
  after: WorkerInspection,
  commit: string,
  bundleDigestHex: string,
): void {
  if (
    after.state !== "desired-current" ||
    after.canonical.history.versionId === before.canonical.history.versionId ||
    after.canonical.history.previousVersionId !== before.canonical.history.versionId ||
    after.canonical.commit !== commit ||
    after.canonical.bundleDigestHex !== bundleDigestHex
  ) {
    throw verificationError(
      "authoritative Worker readback is not the exact seal-key upload and its immediate predecessor",
    );
  }
}

function assertSameInspection(
  phase: DeployPhase,
  left: WorkerInspection,
  right: WorkerInspection,
  message: string,
): void {
  if (
    left.state !== right.state ||
    !sameNullableDescriptor(left.descriptor, right.descriptor) ||
    !sameHistory(left.canonical.history, right.canonical.history) ||
    left.canonical.commit !== right.canonical.commit ||
    left.canonical.bundleDigestHex !== right.canonical.bundleDigestHex ||
    left.canonical.scriptEtag !== right.canonical.scriptEtag
  ) {
    throw phaseError(phase, message);
  }
}

function sameSchemaInspection(left: SchemaInspection, right: SchemaInspection): boolean {
  return (
    left.ready === right.ready &&
    left.shapeDigest === right.shapeDigest &&
    JSON.stringify(left.applied) === JSON.stringify(right.applied) &&
    JSON.stringify(left.pending) === JSON.stringify(right.pending)
  );
}

function sameHistory(left: WorkerDeploymentHistory, right: WorkerDeploymentHistory): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.versionId === right.versionId &&
    left.previousVersionId === right.previousVersionId
  );
}

function sameNullableDescriptor(
  left: RuntimeInputSealKeyRingDescriptor | null,
  right: RuntimeInputSealKeyRingDescriptor | null,
): boolean {
  return left === null || right === null ? left === right : sameDescriptor(left, right);
}

function sameDescriptor(
  left: RuntimeInputSealKeyRingDescriptor,
  right: RuntimeInputSealKeyRingDescriptor,
): boolean {
  return (
    left.currentKeyId === right.currentKeyId &&
    left.commitment === right.commitment &&
    JSON.stringify(left.previousKeyIds) === JSON.stringify(right.previousKeyIds)
  );
}

async function checked(
  run: RuntimeInputSealKeyProcess,
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

function phaseError(phase: DeployPhase, message: string): DeployError {
  return phase === "preflight"
    ? preflightError(message)
    : phase === "mutation"
      ? mutationError(message)
      : verificationError(message);
}
