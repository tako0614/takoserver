import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseRuntimeInputSealKeyRing } from "../../src/runtime-input-seal-keyring.ts";
import { parseTakoformV2ApplicationConfig } from "../../src/takoform-v2/config.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import { assertFreshV2DataReadback, type FreshV2DataReader } from "./fresh-v2-data-readback.ts";
import {
  CloudflareIntegrationStorageProvider,
  type FreshV2IntegrationStorageTargetProof,
  type IntegrationStorageGenerationInvocation,
  type IntegrationStorageGenerationTargetVerificationOptions,
  type IntegrationStorageOriginalCreateOptions,
  loadIntegrationStorageOriginalCreateInput,
  verifyFreshV2IntegrationStorageTarget,
  verifyIntegrationStorageOriginalCreate,
} from "./integration-storage-generation.ts";
import {
  assertMoneyUnitSchema,
  assertOrgBillingSchema,
  assertStripeWebhookSchema,
  canonicalSchemaShape,
  type D1SchemaState,
  moneyUnitSchemaReady,
  orgBillingSchemaReady,
  readD1SchemaState,
} from "./migrations.ts";
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
import {
  projectFreshIntegrationV2MigrationArtifact0091,
  projectFreshIntegrationV2MigrationArtifact0092,
  projectFreshProductionV2MigrationArtifact,
  projectFreshProductionV2MigrationArtifact0089,
  projectFreshV2ArtifactMigrationArtifact,
  readAuditedMigrationArtifact,
  readCurrentAuditedMigrationSourceArtifact,
} from "./schema.ts";
import {
  activePublicJwk,
  createRemoteSigningDatabase,
  readVerifiedPrivateSigningJwk,
  type SigningDatabase,
  type SigningPublicKeyRow,
} from "./signing.ts";
import { type DeployTarget, parseDeployTarget, takoformV2StorageLineage } from "./target.ts";
import {
  assertProviderExecutorUnchanged,
  type ProviderExecutorInspection,
  probeProduct,
  probeSchemaMaintenance,
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
  publishWranglerVersion,
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
    label:
      "Host bootstrap tests `bun test --timeout 60000 --bail=1 <fixed Host bootstrap test set>`",
    // The repository gate's own flags (`bun run test`): these tests pass
    // there, and a shared, loaded operator machine must not fail the
    // bootstrap on the 5-second default alone.
    command: [
      "bun",
      "test",
      "--timeout",
      "60000",
      "--bail=1",
      ...INTEGRATION_WORKER_BOOTSTRAP_GATE_TESTS,
    ],
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
  /** Explicit successor command DATA only; production captures all native evidence itself. */
  readonly originalMoneyMaintenanceRepair?: {
    readonly originalCreateInputPath: string;
    readonly selectionPath: string;
    readonly repairSelectionPath: string;
  };
  /** Locator selection only. This mode accepts no injected read, write, runner or proof ports. */
  readonly originalMoneyMaintenance?: {
    readonly originalCreateInputPath: string;
    readonly selectionPath: string;
  };
  readonly run?: WorkerProcess;
  readonly state?: IntegrationWorkerBootstrapState;
  readonly sourceRepositoryRoot?: string;
  readonly wranglerPath?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly providerExecutorQualification?: WorkerProviderExecutorQualification;
  readonly signingDatabase?: Pick<SigningDatabase, "readKey">;
  readonly schemaReader?: IntegrationWorkerBootstrapSchemaReader;
  readonly r2Identity?: IntegrationWorkerBootstrapR2IdentityReader;
  /** Narrow read-only test seam; production verifies the selected generated pair remotely. */
  readonly v2StorageVerification?: IntegrationStorageGenerationTargetVerificationOptions;
  /** Test seam for the fresh-lineage unserved-data proof; production reads remote D1. */
  readonly freshV2DataReader?: FreshV2DataReader;
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

const ORIGINAL_MONEY_MAINTENANCE_MODE = "pre-wallet-usd-micros-quiesced" as const;
const ORIGINAL_MONEY_MAINTENANCE_RESULT =
  "takoserver.integration-worker-bootstrap-original-money-maintenance-apply@v1" as const;

function maintenanceDigest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function maintenanceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maintenanceKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...names].sort().join("\0");
}

/** Detached own DATA only; getters, Proxies and callable values cannot enter native selection. */
function maintenanceData(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || seen.has(value))
    throw preflightError("original money maintenance requires detached own JSON data");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype)
    throw preflightError("original money maintenance requires plain own JSON data");
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length !== 0)
      throw preflightError("original money maintenance selection has symbol properties");
    if (Array.isArray(value)) {
      const keys = Object.keys(descriptors).filter((name) => name !== "length");
      if (keys.length !== value.length || keys.some((name, index) => name !== String(index)))
        throw preflightError("original money maintenance selection has a sparse array");
      return Object.freeze(
        keys.map((name) => {
          const descriptor = descriptors[name];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            throw preflightError("original money maintenance selection has an accessor");
          return maintenanceData(descriptor.value, seen);
        }),
      );
    }
    const detached: Record<string, unknown> = {};
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable || name === "__proto__")
        throw preflightError("original money maintenance selection has an accessor");
      detached[name] = maintenanceData(descriptor.value, seen);
    }
    return Object.freeze(detached);
  } finally {
    seen.delete(value);
  }
}

function maintenancePrivateDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw preflightError("original money maintenance custody path is not canonical");
  const status = lstatSync(path);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o777) !== 0o700 ||
    status.uid !== process.getuid?.()
  )
    throw preflightError("original money maintenance custody requires an owned0700 directory");
  for (let current = path; current !== dirname(current); current = dirname(current)) {
    try {
      lstatSync(join(current, ".git"));
      throw preflightError("original money maintenance custody must be outside every checkout");
    } catch (error) {
      if (error instanceof DeployError) throw error;
      if (!maintenanceRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
}

function maintenanceProtectedInput(path: string, absent = false) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    /[\0\r\n]/u.test(path)
  )
    throw preflightError("original money maintenance requires canonical protected locator paths");
  maintenancePrivateDirectory(dirname(path));
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (absent && maintenanceRecord(error) && error.code === "ENOENT") return null;
    throw preflightError("original money maintenance protected input is unavailable");
  }
  const identity = (status: ReturnType<typeof fstatSync>) =>
    [
      status.dev,
      status.ino,
      status.uid,
      status.gid,
      status.mode,
      status.nlink,
      status.size,
      status.mtimeMs,
      status.ctimeMs,
    ].join(":");
  let bytes: Buffer;
  let seal: string;
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.uid !== process.getuid?.() ||
      before.size > 1024 * 1024
    )
      throw preflightError("original money maintenance input requires an owned bounded0600 file");
    if (identity(lstatSync(path)) !== identity(before))
      throw preflightError("original money maintenance named and held inputs differ");
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) throw preflightError("original money maintenance input was truncated");
      offset += count;
    }
    if (
      readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 ||
      identity(fstatSync(fd)) !== identity(before) ||
      identity(lstatSync(path)) !== identity(before)
    )
      throw preflightError("original money maintenance input changed during read");
    seal = `${identity(before)}:${maintenanceDigest(bytes)}`;
  } finally {
    closeSync(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw preflightError("original money maintenance input is not fatalUTF8 JSON");
  }
  return {
    value,
    seal,
    assertUnchanged(): void {
      if (maintenanceProtectedInput(path)?.seal !== seal)
        throw preflightError("original money maintenance input changed after capture");
    },
  };
}

function originalMaintenanceCustodyRoot(
  originalCreate: IntegrationStorageOriginalCreateOptions,
): string {
  if (originalCreate.kind !== "positive-fresh-0092")
    throw preflightError("original money maintenance requires original fresh92 custody");
  const root = originalCreate.custodyDirectory;
  maintenancePrivateDirectory(root);
  const status = lstatSync(root);
  if (
    String(status.dev) !== originalCreate.custodyIdentity.device ||
    String(status.ino) !== originalCreate.custodyIdentity.inode
  )
    throw preflightError("original money maintenance custody root identity differs");
  return join(dirname(root), `${basename(root)}.money-maintenance-publication`);
}

interface OriginalMaintenancePublicationBinding {
  readonly originalCreateTerminalCustodyDigest: string;
  readonly targetDigest: string;
  readonly sourceCommit: string;
  readonly writerEpoch: string;
  readonly moduleDigest: string;
  readonly artifactDigest: string;
  readonly artifactBytes: number;
  readonly artifactFiles: number;
}

function maintenanceTargetDigest(target: DeployTarget): string {
  return maintenanceDigest(
    canonicalJson({ ...target, schemaMaintenanceMode: ORIGINAL_MONEY_MAINTENANCE_MODE }),
  );
}

function readOriginalMaintenanceCustody(
  originalCreate: IntegrationStorageOriginalCreateOptions,
  target: DeployTarget,
  sourceCommit: string,
  originalCreateTerminalCustodyDigest: string,
) {
  const root = originalMaintenanceCustodyRoot(originalCreate);
  try {
    lstatSync(root);
  } catch (error) {
    if (maintenanceRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const rootPin = maintenanceDirectoryPin(root);
  const entries = readdirSync(root).sort();
  if (entries.join(",") !== "dispatch.json" && entries.join(",") !== "dispatch.json,terminal.json")
    throw preflightError(
      "original money maintenance existing custody is partial or contains unknown entries; do not retry",
    );
  const dispatch = maintenanceProtectedInput(join(root, "dispatch.json"));
  const terminal = maintenanceProtectedInput(join(root, "terminal.json"), true);
  if (dispatch === null)
    throw preflightError("original maintenance custody has no original dispatch");
  const assertCustodyUnchanged = () => {
    if (
      maintenanceDirectoryPin(root) !== rootPin ||
      readdirSync(root).sort().join(",") !== entries.join(",")
    )
      throw preflightError("original money maintenance publication inventory changed during read");
    dispatch.assertUnchanged();
    terminal?.assertUnchanged();
  };
  const value = dispatch.value;
  if (
    !maintenanceRecord(value) ||
    !maintenanceKeys(value, ["kind", "binding", "bindingDigest"]) ||
    value.kind !== "takoserver.original-money-maintenance-publication-dispatch@v1" ||
    !maintenanceRecord(value.binding) ||
    !maintenanceKeys(value.binding, [
      "originalCreateTerminalCustodyDigest",
      "targetDigest",
      "sourceCommit",
      "writerEpoch",
      "moduleDigest",
      "artifactDigest",
      "artifactBytes",
      "artifactFiles",
    ]) ||
    value.bindingDigest !== maintenanceDigest(JSON.stringify(value.binding)) ||
    value.binding.originalCreateTerminalCustodyDigest !== originalCreateTerminalCustodyDigest ||
    value.binding.targetDigest !== maintenanceTargetDigest(target) ||
    value.binding.sourceCommit !== sourceCommit ||
    value.binding.writerEpoch !== target.moneyCutoverWriterEpoch ||
    !SHA256.test(String(value.binding.moduleDigest)) ||
    !SHA256.test(String(value.binding.artifactDigest)) ||
    !Number.isSafeInteger(value.binding.artifactBytes) ||
    Number(value.binding.artifactBytes) <= 0 ||
    !Number.isSafeInteger(value.binding.artifactFiles) ||
    Number(value.binding.artifactFiles) <= 0
  )
    throw preflightError(
      "original money maintenance dispatch custody differs from its full command",
    );
  const dispatchDigest = maintenanceDigest(JSON.stringify(value));
  if (terminal === null) {
    assertCustodyUnchanged();
    return {
      dispatchDigest,
      binding: value.binding,
      result: null,
      resultDigest: null,
      terminalDigest: null,
    };
  }
  const end = terminal.value;
  if (
    !maintenanceRecord(end) ||
    !maintenanceKeys(end, ["kind", "dispatchDigest", "result", "resultDigest"]) ||
    end.kind !== "takoserver.original-money-maintenance-publication-terminal@v1" ||
    end.dispatchDigest !== dispatchDigest ||
    !maintenanceRecord(end.result) ||
    end.result.kind !== ORIGINAL_MONEY_MAINTENANCE_RESULT ||
    end.result.maintenanceOnly !== true ||
    end.result.normalHostReady !== false ||
    end.result.runtimeSigningAndSecrets !== "not-qualified-maintenance-unused" ||
    end.result.originalCreateTerminalCustodyDigest !== originalCreateTerminalCustodyDigest ||
    end.result.bundleDigest !== value.binding.moduleDigest ||
    end.result.artifactDigest !== value.binding.artifactDigest ||
    end.result.artifactBytes !== value.binding.artifactBytes ||
    end.result.artifactFiles !== value.binding.artifactFiles ||
    end.result.commit !== sourceCommit ||
    end.resultDigest !== maintenanceDigest(JSON.stringify(end.result))
  )
    throw preflightError(
      "original money maintenance terminal custody is partial or differs from dispatch",
    );
  assertCustodyUnchanged();
  return {
    dispatchDigest,
    binding: value.binding,
    result: end.result,
    resultDigest: end.resultDigest,
    terminalDigest: maintenanceDigest(JSON.stringify(end)),
  };
}

/** Historical DATA only. The Money owner separately proves native original and current Version/source. */
export function readIntegrationMoneyMaintenancePublicationOriginal(
  originalCreate: IntegrationStorageOriginalCreateOptions,
  target: DeployTarget,
  sourceCommit: string,
  originalCreateTerminalCustodyDigest: string,
) {
  return readOriginalMaintenanceCustody(
    originalCreate,
    target,
    sourceCommit,
    originalCreateTerminalCustodyDigest,
  );
}

/** Historical custody DATA only. The Money owner still proves native currentness. */
export function readIntegrationMoneyMaintenanceSuccessorOriginal(
  originalCreate: IntegrationStorageOriginalCreateOptions,
  target: DeployTarget,
  successorSourceCommit: string,
  originalCreateTerminalCustodyDigest: string,
) {
  const root = `${originalMaintenanceCustodyRoot(originalCreate)}.successor`;
  try {
    lstatSync(root);
  } catch (error) {
    if (maintenanceRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const rootPin = maintenanceDirectoryPin(root);
  const entries = readdirSync(root).sort().join(",");
  if (entries !== "dispatch.json" && entries !== "dispatch.json,terminal.json")
    throw preflightError(
      "original maintenance successor custody is partial or contains unknown entries",
    );
  const dispatch = maintenanceProtectedInput(join(root, "dispatch.json"));
  const terminal = maintenanceProtectedInput(join(root, "terminal.json"), true);
  if (dispatch === null)
    throw preflightError("original maintenance successor has no original dispatch");
  const value = dispatch.value;
  if (
    !maintenanceRecord(value) ||
    !maintenanceKeys(value, [
      "kind",
      "originalDispatchDigest",
      "originalSourceCommit",
      "originalCreateTerminalCustodyDigest",
      "targetDigest",
      "writerEpoch",
      "predecessor",
      "historicalBindingProfile",
      "sourceCommit",
      "moduleDigest",
      "artifactDigest",
      "artifactBytes",
      "artifactFiles",
    ]) ||
    value.kind !== "takoserver.original-money-maintenance-successor-dispatch@v1" ||
    value.sourceCommit !== successorSourceCommit ||
    !COMMIT.test(successorSourceCommit) ||
    value.sourceCommit === value.originalSourceCommit ||
    value.originalCreateTerminalCustodyDigest !== originalCreateTerminalCustodyDigest ||
    value.targetDigest !== maintenanceTargetDigest(target) ||
    value.writerEpoch !== target.moneyCutoverWriterEpoch ||
    !SHA256.test(String(value.moduleDigest)) ||
    !SHA256.test(String(value.artifactDigest)) ||
    !Number.isSafeInteger(value.artifactBytes) ||
    Number(value.artifactBytes) <= 0 ||
    !Number.isSafeInteger(value.artifactFiles) ||
    Number(value.artifactFiles) <= 0
  )
    throw preflightError("original maintenance successor differs from its exact full command");
  const selected = parseOriginalMoneyMaintenanceSuccessorSelection({
    kind: "takoserver.integration-money-maintenance-original-successor-selection@v1",
    originalSourceCommit: value.originalSourceCommit,
    originalDispatchDigest: value.originalDispatchDigest,
    predecessor: value.predecessor,
    historicalBindingProfile: value.historicalBindingProfile,
  });
  const originalFirst = readOriginalMaintenanceCustody(
    originalCreate,
    target,
    selected.originalSourceCommit,
    originalCreateTerminalCustodyDigest,
  );
  if (
    originalFirst === null ||
    originalFirst.result !== null ||
    originalFirst.dispatchDigest !== selected.originalDispatchDigest
  )
    throw preflightError(
      "original maintenance successor lost its immutable unknown first dispatch",
    );
  const assertUnchanged = () => {
    if (maintenanceDirectoryPin(root) !== rootPin || readdirSync(root).sort().join(",") !== entries)
      throw preflightError("original maintenance successor custody changed during read");
    dispatch.assertUnchanged();
    terminal?.assertUnchanged();
    const first = readOriginalMaintenanceCustody(
      originalCreate,
      target,
      selected.originalSourceCommit,
      originalCreateTerminalCustodyDigest,
    );
    if (JSON.stringify(first) !== JSON.stringify(originalFirst))
      throw preflightError("original maintenance first dispatch changed during successor read");
  };
  const dispatchDigest = maintenanceDigest(JSON.stringify(value));
  if (terminal === null) {
    assertUnchanged();
    return {
      originalFirst,
      dispatchDigest,
      binding: value,
      result: null,
      resultDigest: null,
      terminalDigest: null,
    };
  }
  const end = terminal.value;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (
    !maintenanceRecord(end) ||
    !maintenanceKeys(end, ["kind", "dispatchDigest", "result", "resultDigest"]) ||
    end.kind !== "takoserver.original-money-maintenance-successor-terminal@v1" ||
    end.dispatchDigest !== dispatchDigest ||
    !maintenanceRecord(end.result) ||
    end.result.kind !==
      "takoserver.integration-worker-original-money-maintenance-successor-apply@v1" ||
    end.result.commit !== successorSourceCommit ||
    end.result.originalSourceCommit !== selected.originalSourceCommit ||
    end.result.originalDispatchDigest !== originalFirst.dispatchDigest ||
    end.result.originalCreateTerminalCustodyDigest !== originalCreateTerminalCustodyDigest ||
    end.result.targetDigest !== value.targetDigest ||
    end.result.writerEpoch !== value.writerEpoch ||
    end.result.bundleDigest !== value.moduleDigest ||
    end.result.artifactDigest !== value.artifactDigest ||
    end.result.artifactBytes !== value.artifactBytes ||
    end.result.artifactFiles !== value.artifactFiles ||
    end.result.previousVersionId !== selected.predecessor.versionId ||
    end.result.preMutationObservedVersionId !== selected.predecessor.versionId ||
    !uuid.test(String(end.result.versionId)) ||
    !uuid.test(String(end.result.deploymentId)) ||
    end.result.versionId === selected.predecessor.versionId ||
    end.result.deploymentId === selected.predecessor.deploymentId ||
    end.result.maintenanceOnly !== true ||
    end.result.normalHostReady !== false ||
    end.result.runtimeSigningAndSecrets !== "not-qualified-maintenance-unused" ||
    end.result.surface !== INTEGRATION_WORKER_BOOTSTRAP_SURFACE ||
    end.result.environment !== "integration" ||
    !maintenanceRecord(end.result.probe) ||
    !maintenanceKeys(end.result.probe, ["url", "status", "traffic"]) ||
    end.result.probe.url !== `${target.publicOrigin}/healthz` ||
    end.result.probe.status !== 503 ||
    end.result.probe.traffic !== "maintenance" ||
    end.result.originalDispatchPreserved !== true ||
    end.result.originalTerminalRecovery !== "not-manufactured-by-successor" ||
    end.resultDigest !== maintenanceDigest(JSON.stringify(end.result))
  )
    throw preflightError(
      "original maintenance successor terminal differs from its mandatory original chain",
    );
  assertUnchanged();
  return {
    originalFirst,
    dispatchDigest,
    binding: value,
    result: end.result,
    resultDigest: String(end.resultDigest),
    terminalDigest: maintenanceDigest(JSON.stringify(end)),
  };
}

function maintenanceDirectoryPin(path: string): string {
  maintenancePrivateDirectory(path);
  const status = lstatSync(path);
  return [status.dev, status.ino, status.uid, status.gid, status.mode].join(":");
}

function writeOriginalMaintenanceCustody(
  path: string,
  value: unknown,
  expectedDirectoryPin: string,
): void {
  const root = dirname(path);
  if (maintenanceDirectoryPin(root) !== expectedDirectoryPin)
    throw preflightError("original money maintenance publication directory identity changed");
  const directoryFd = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const held = fstatSync(directoryFd);
    if ([held.dev, held.ino, held.uid, held.gid, held.mode].join(":") !== expectedDirectoryPin)
      throw preflightError(
        "original money maintenance named and held publication directories differ",
      );
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (maintenanceDirectoryPin(root) !== expectedDirectoryPin)
      throw preflightError("original money maintenance publication directory changed during write");
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

async function captureOriginalMoneyMaintenance(
  invocation: IntegrationWorkerBootstrapInvocation,
  selectedTarget: DeployTarget,
  options: IntegrationWorkerBootstrapOptions,
) {
  const descriptor = Object.getOwnPropertyDescriptor(options, "originalMoneyMaintenance");
  if (descriptor === undefined) return undefined;
  if (
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    (Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null) ||
    Object.getOwnPropertyNames(options).join(",") !== "originalMoneyMaintenance" ||
    Object.getOwnPropertySymbols(options).length !== 0
  )
    throw preflightError(
      "original money maintenance accepts only original locator selection, no injected ports",
    );
  const locators = maintenanceData(descriptor.value);
  if (
    !maintenanceRecord(locators) ||
    !maintenanceKeys(locators, ["originalCreateInputPath", "selectionPath"]) ||
    typeof locators.originalCreateInputPath !== "string" ||
    typeof locators.selectionPath !== "string"
  )
    throw preflightError("original money maintenance requires only two protected locator paths");
  const target = parseDeployTarget(
    maintenanceData(selectedTarget),
    "original money maintenance target",
    "integration",
    "money-original-maintenance-bootstrap",
  );
  if (target.schemaMaintenanceMode !== ORIGINAL_MONEY_MAINTENANCE_MODE)
    throw preflightError("original money maintenance cannot publish normal Host code");
  const input = maintenanceProtectedInput(locators.selectionPath);
  const originalInput = maintenanceProtectedInput(locators.originalCreateInputPath);
  if (!input || !originalInput)
    throw preflightError("original money maintenance locator input is unavailable");
  const value = input.value;
  if (
    !maintenanceRecord(value) ||
    !maintenanceKeys(value, ["kind", "originalOrigin"]) ||
    value.kind !== "takoserver.integration-money-maintenance-original-selection@v1" ||
    !maintenanceRecord(value.originalOrigin) ||
    !maintenanceKeys(value.originalOrigin, ["invocation", "originalTargetPath"]) ||
    !maintenanceRecord(value.originalOrigin.invocation) ||
    !maintenanceKeys(value.originalOrigin.invocation, [
      "action",
      "environment",
      "commit",
      "generation",
      "namespace",
      "freshLineage",
    ]) ||
    typeof value.originalOrigin.originalTargetPath !== "string"
  )
    throw preflightError(
      "original money maintenance selection requires the exact original six-field invocation",
    );
  const selected = value.originalOrigin.invocation;
  if (
    selected.action !== "apply" ||
    selected.environment !== "integration" ||
    selected.namespace !== "integration-ts" ||
    selected.freshLineage !== "v2-0092" ||
    !COMMIT.test(String(selected.commit)) ||
    !/^[0-9a-f]{32}$/u.test(String(selected.generation))
  )
    throw preflightError("original money maintenance selection differs from fresh92 creation");
  const originalTargetInput = maintenanceProtectedInput(value.originalOrigin.originalTargetPath);
  if (!originalTargetInput) throw preflightError("original money collision target is unavailable");
  const originalTarget = parseDeployTarget(
    originalTargetInput.value,
    "original money collision target",
    "integration",
  );
  const originalInvocation = maintenanceData(
    selected,
  ) as unknown as IntegrationStorageGenerationInvocation;
  const originalCreate = loadIntegrationStorageOriginalCreateInput(
    locators.originalCreateInputPath,
  );
  const assertLocators = () => {
    input.assertUnchanged();
    originalInput.assertUnchanged();
    originalTargetInput.assertUnchanged();
  };
  // No dependency or caller proof port enters this native original reader.
  const readOrigin = async () => {
    assertLocators();
    const observed = await verifyIntegrationStorageOriginalCreate(
      originalInvocation,
      originalTarget,
      target,
      { originalCreate },
    );
    assertLocators();
    if (
      observed.qualification !== "independent-origin-review-required" ||
      observed.originalCreate.authority !== "provider-native" ||
      observed.nativeReadback.authority !== "provider-native"
    )
      throw preflightError("original money maintenance requires genuine native original92 custody");
    return observed;
  };
  const origin = await readOrigin();
  const retained = JSON.stringify(origin);
  const originalDigest = origin.originalCreate.terminalCustodyDigest;
  const readCustody = () =>
    readOriginalMaintenanceCustody(originalCreate, target, invocation.commit, originalDigest);
  // A retained dispatch is never a new publication permission, even after positive native absence.
  if (invocation.action === "apply" && readCustody() !== null)
    throw mutationError(
      "original money maintenance already has publication custody; use original status only, never resend",
    );
  let dispatchDigest: string | undefined;
  let publicationDirectoryPin: string | undefined;
  const assertPublication = () => {
    if (
      publicationDirectoryPin !== undefined &&
      maintenanceDirectoryPin(originalMaintenanceCustodyRoot(originalCreate)) !==
        publicationDirectoryPin
    )
      throw preflightError(
        "original money maintenance publication directory changed after dispatch",
      );
    if (dispatchDigest !== undefined && readCustody()?.dispatchDigest !== dispatchDigest)
      throw preflightError("original money maintenance original dispatch changed after capture");
  };
  return {
    target,
    locators: Object.freeze({
      originalCreateInputPath: locators.originalCreateInputPath,
      selectionPath: locators.selectionPath,
    }),
    originalCreateTerminalCustodyDigest: originalDigest,
    readCustody,
    async assertCurrent() {
      assertPublication();
      if (JSON.stringify(await readOrigin()) !== retained)
        throw preflightError("original money maintenance native original identity changed");
      assertPublication();
    },
    dispatch(
      binding: Omit<
        OriginalMaintenancePublicationBinding,
        "originalCreateTerminalCustodyDigest" | "targetDigest" | "sourceCommit" | "writerEpoch"
      >,
    ) {
      assertLocators();
      if (readCustody() !== null)
        throw mutationError("original money maintenance dispatch already exists; do not resend");
      const root = originalMaintenanceCustodyRoot(originalCreate);
      try {
        mkdirSync(root, { mode: 0o700 });
        const parentFd = openSync(
          dirname(root),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(parentFd);
        } finally {
          closeSync(parentFd);
        }
      } catch {
        throw mutationError(
          "original money maintenance publication custody already exists or cannot be created; no retry",
        );
      }
      publicationDirectoryPin = maintenanceDirectoryPin(root);
      if (readdirSync(root).length !== 0)
        throw mutationError("original money maintenance new publication directory is not empty");
      const value = {
        kind: "takoserver.original-money-maintenance-publication-dispatch@v1",
        binding: {
          originalCreateTerminalCustodyDigest: originalDigest,
          targetDigest: maintenanceTargetDigest(target),
          sourceCommit: invocation.commit,
          writerEpoch: target.moneyCutoverWriterEpoch,
          ...binding,
        },
      };
      const record = { ...value, bindingDigest: maintenanceDigest(JSON.stringify(value.binding)) };
      writeOriginalMaintenanceCustody(join(root, "dispatch.json"), record, publicationDirectoryPin);
      dispatchDigest = maintenanceDigest(JSON.stringify(record));
    },
    terminal(result: Record<string, unknown>) {
      assertLocators();
      assertPublication();
      if (
        !dispatchDigest ||
        !publicationDirectoryPin ||
        readCustody()?.dispatchDigest !== dispatchDigest
      )
        throw verificationError(
          "original money maintenance dispatch custody changed before terminal",
        );
      const value = {
        kind: "takoserver.original-money-maintenance-publication-terminal@v1",
        dispatchDigest,
        result,
        resultDigest: maintenanceDigest(JSON.stringify(result)),
      };
      writeOriginalMaintenanceCustody(
        join(originalMaintenanceCustodyRoot(originalCreate), "terminal.json"),
        value,
        publicationDirectoryPin,
      );
      return {
        originalMaintenanceDispatchDigest: dispatchDigest,
        originalMaintenanceTerminalCustodyDigest: maintenanceDigest(JSON.stringify(value)),
        originalMaintenanceResultDigest: value.resultDigest,
      };
    },
  };
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
/** Closed command DATA only; successful parsing never authorizes publication. */
export interface OriginalMoneyMaintenanceSuccessorSelection {
  readonly kind: "takoserver.integration-money-maintenance-original-successor-selection@v1";
  readonly originalSourceCommit: string;
  readonly originalDispatchDigest: string;
  readonly predecessor: { readonly versionId: string; readonly deploymentId: string };
  readonly historicalBindingProfile: "original-money-maintenance-without-environment-v1";
}

export function parseOriginalMoneyMaintenanceSuccessorSelection(
  input: unknown,
): OriginalMoneyMaintenanceSuccessorSelection {
  const value = maintenanceData(input);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (
    !maintenanceRecord(value) ||
    !maintenanceKeys(value, [
      "kind",
      "originalSourceCommit",
      "originalDispatchDigest",
      "predecessor",
      "historicalBindingProfile",
    ]) ||
    value.kind !== "takoserver.integration-money-maintenance-original-successor-selection@v1" ||
    !COMMIT.test(String(value.originalSourceCommit)) ||
    !SHA256.test(String(value.originalDispatchDigest)) ||
    value.historicalBindingProfile !== "original-money-maintenance-without-environment-v1" ||
    !maintenanceRecord(value.predecessor) ||
    !maintenanceKeys(value.predecessor, ["versionId", "deploymentId"]) ||
    !uuid.test(String(value.predecessor.versionId)) ||
    !uuid.test(String(value.predecessor.deploymentId))
  )
    throw preflightError(
      "original money maintenance repair requires its exact closed original command selection",
    );
  return value as unknown as OriginalMoneyMaintenanceSuccessorSelection;
}

/**
 * Existing owner, native GET-only selection preparation. The returned JSON is
 * command DATA, never permission; apply reopens the original and all native fences.
 * This does not require the known-broken predecessor to pass the new503 contract.
 */
export async function prepareIntegrationMoneyMaintenanceSuccessorSelection(
  originalInvocation: IntegrationWorkerBootstrapInvocation,
  selectedTarget: DeployTarget,
  originalLocators: NonNullable<IntegrationWorkerBootstrapOptions["originalMoneyMaintenance"]>,
): Promise<{
  readonly selection: OriginalMoneyMaintenanceSuccessorSelection;
  readonly preparationSource: { readonly head: string; readonly moduleDigest: string };
}> {
  const invocation = maintenanceData(
    originalInvocation,
  ) as unknown as IntegrationWorkerBootstrapInvocation;
  const target = parseDeployTarget(
    maintenanceData(selectedTarget),
    "original maintenance repair preparation target",
    "integration",
    "money-original-maintenance-bootstrap",
  );
  const locators = maintenanceData(originalLocators);
  validateInvocation(invocation, target);
  if (
    invocation.action !== "status" ||
    !maintenanceRecord(locators) ||
    !maintenanceKeys(locators, ["originalCreateInputPath", "selectionPath"]) ||
    typeof locators.originalCreateInputPath !== "string" ||
    typeof locators.selectionPath !== "string"
  )
    throw preflightError(
      "original maintenance successor preparation requires status and original locators only",
    );
  const captureCurrentSource = async () => {
    const observed = await runCommand(["git", "-C", REPOSITORY, "rev-parse", "HEAD"]);
    const head = observed.stdout.trim();
    if (observed.exitCode !== 0 || !COMMIT.test(head))
      throw preflightError(
        "original maintenance native preparation cannot capture its current source HEAD",
      );
    return { head, moduleDigest: maintenanceDigest(readFileSync(new URL(import.meta.url))) };
  };
  const preparationSource = await captureCurrentSource();
  const origin = await captureOriginalMoneyMaintenance(invocation, target, {
    originalMoneyMaintenance: {
      originalCreateInputPath: locators.originalCreateInputPath,
      selectionPath: locators.selectionPath,
    },
  });
  if (origin === undefined)
    throw preflightError("original maintenance native selection is unavailable");
  const first = origin.readCustody();
  if (first === null || first.result !== null)
    throw preflightError(
      "original maintenance successor preparation requires retained unknown first dispatch",
    );
  const retained = JSON.stringify(first);
  const credential = await resolveCloudflareCredential("integration", { run: runCommand });
  const state = new CloudflareState({
    accountId: target.accountId,
    token: credential.token ?? exactToken(credential.childEnvironment),
  });
  await origin.assertCurrent();
  const native = await readNativePresence("preflight", target, state);
  if (
    !native.scriptPresent ||
    native.history === null ||
    native.chain.length !== 1 ||
    native.history.previousVersionId !== null
  )
    throw preflightError(
      "original maintenance selection requires exactly its one acknowledged first Version",
    );
  assertWorkersDevOrigin(target, await requiredAccountSubdomain("preflight", state));
  const version = await readVersionWithModules(state, target.workerName, native.history.versionId);
  await inspectVersion(
    "preflight",
    target,
    state,
    native.history,
    version,
    invocation.commit,
    target.signing.currentKeyId,
    String(first.binding.moduleDigest).slice(7),
    true,
    true,
  );
  await assertWorkerSchedules(
    "preflight",
    target,
    state,
    readExpectedWorkerSchedules("preflight", REPOSITORY),
  );
  await origin.assertCurrent();
  const after = await readNativePresence("preflight", target, state);
  if (
    canonicalJson(native) !== canonicalJson(after) ||
    JSON.stringify(origin.readCustody()) !== retained
  )
    throw preflightError("original maintenance native selection changed during preparation");
  if (JSON.stringify(await captureCurrentSource()) !== JSON.stringify(preparationSource))
    throw preflightError("original maintenance native preparation source changed during read");
  return {
    preparationSource,
    selection: parseOriginalMoneyMaintenanceSuccessorSelection({
      kind: "takoserver.integration-money-maintenance-original-successor-selection@v1",
      originalSourceCommit: invocation.commit,
      originalDispatchDigest: first.dispatchDigest,
      predecessor: {
        versionId: native.history.versionId,
        deploymentId: native.history.deploymentId,
      },
      historicalBindingProfile: "original-money-maintenance-without-environment-v1",
    }),
  };
}

/** A separate successor cohort; the original first-publication15 stay immutable. */
export const INTEGRATION_WORKER_MAINTENANCE_SUCCESSOR_GATE_TESTS = [
  ...INTEGRATION_WORKER_BOOTSTRAP_GATE_TESTS,
  "tests/deploy-integration-worker-maintenance-successor.test.ts",
  "tests/deploy-money-maintenance-runtime-bindings.test.ts",
  "tests/deploy-original-maintenance-repair-cli.test.ts",
  "tests/deploy-contract.test.ts",
  "tests/deploy-schema-money-unit-owner.test.ts",
] as const;

async function checkedSuccessorGate(run: WorkerProcess): Promise<void> {
  for (const command of [
    ["bun", "run", "typecheck:worker"],
    [
      "bun",
      "test",
      "--timeout",
      "60000",
      "--bail=1",
      ...INTEGRATION_WORKER_MAINTENANCE_SUCCESSOR_GATE_TESTS,
    ],
  ] as const) {
    let result: CommandResult;
    try {
      result = await run(command);
    } catch {
      throw preflightError("original maintenance successor owner gate could not be started");
    }
    if (result.exitCode !== 0)
      throw preflightError(
        "original maintenance successor owner gate failed",
        `${result.stdout}${result.stderr}`.trim(),
      );
  }
}

/**
 * Explicit forward command, not a first-publication retry. All ports below are
 * this owner's existing native implementations; callers supply locators only.
 */
async function runOriginalMoneyMaintenanceSuccessor(
  selectedInvocation: IntegrationWorkerBootstrapInvocation,
  selectedTarget: DeployTarget,
  selectedOptions: IntegrationWorkerBootstrapOptions,
): Promise<Record<string, unknown>> {
  const descriptor = Object.getOwnPropertyDescriptor(
    selectedOptions,
    "originalMoneyMaintenanceRepair",
  );
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    (Object.getPrototypeOf(selectedOptions) !== Object.prototype &&
      Object.getPrototypeOf(selectedOptions) !== null) ||
    Object.getOwnPropertyNames(selectedOptions).join(",") !== "originalMoneyMaintenanceRepair" ||
    Object.getOwnPropertySymbols(selectedOptions).length !== 0
  )
    throw preflightError(
      "original money maintenance repair accepts only its original locator selection, no injected ports",
    );
  const locators = maintenanceData(descriptor.value);
  if (
    !maintenanceRecord(locators) ||
    !maintenanceKeys(locators, [
      "originalCreateInputPath",
      "selectionPath",
      "repairSelectionPath",
    ]) ||
    typeof locators.originalCreateInputPath !== "string" ||
    typeof locators.selectionPath !== "string" ||
    typeof locators.repairSelectionPath !== "string"
  )
    throw preflightError(
      "original money maintenance repair requires exactly three protected locators",
    );
  const invocation = maintenanceData(
    selectedInvocation,
  ) as unknown as IntegrationWorkerBootstrapInvocation;
  const target = parseDeployTarget(
    maintenanceData(selectedTarget),
    "original maintenance repair target",
    "integration",
    "money-original-maintenance-bootstrap",
  );
  validateInvocation(invocation, target);
  if (invocation.action !== "apply")
    throw preflightError("original money maintenance repair requires explicit integration apply");
  const selectionInput = maintenanceProtectedInput(locators.repairSelectionPath);
  if (selectionInput === null)
    throw preflightError("original maintenance repair command is unavailable");
  const selected = parseOriginalMoneyMaintenanceSuccessorSelection(selectionInput.value);
  if (selected.originalSourceCommit === invocation.commit)
    throw preflightError(
      "original maintenance repair must select a distinct corrected source commit",
    );
  const origin = await captureOriginalMoneyMaintenance(
    { ...invocation, action: "status", commit: selected.originalSourceCommit },
    target,
    {
      originalMoneyMaintenance: {
        originalCreateInputPath: locators.originalCreateInputPath,
        selectionPath: locators.selectionPath,
      },
    },
  );
  if (origin === undefined)
    throw preflightError("original maintenance repair original capture is unavailable");
  const original = origin.readCustody();
  if (
    original === null ||
    original.result !== null ||
    original.dispatchDigest !== selected.originalDispatchDigest
  )
    throw preflightError(
      "original maintenance repair requires the exact retained unknown original dispatch",
    );
  const retained = JSON.stringify(original);
  const originalCreate = loadIntegrationStorageOriginalCreateInput(
    locators.originalCreateInputPath,
  );
  const repairRoot = `${originalMaintenanceCustodyRoot(originalCreate)}.successor`;
  try {
    lstatSync(repairRoot);
    throw mutationError("original maintenance successor custody already exists; no replay");
  } catch (error) {
    if (!maintenanceRecord(error) || error.code !== "ENOENT") throw error;
  }
  const assertOriginal = async () => {
    selectionInput.assertUnchanged();
    await origin.assertCurrent();
    if (JSON.stringify(origin.readCustody()) !== retained)
      throw preflightError("original maintenance repair retained first dispatch changed");
    selectionInput.assertUnchanged();
  };
  const credential = await resolveCloudflareCredential("integration", { run: runCommand });
  let environment = credential.childEnvironment;
  let state: IntegrationWorkerBootstrapState = new CloudflareState({
    accountId: target.accountId,
    token: credential.token ?? exactToken(environment),
  });
  const assertSource = async () => {
    const source = await qualifySource({
      environment: "integration",
      commit: invocation.commit,
      run: runCommand,
    });
    if (source.dirty)
      throw preflightError("original maintenance successor requires exact clean corrected source");
    return source;
  };
  const readPredecessor = async () => {
    await assertOriginal();
    const native = await readNativePresence("preflight", target, state);
    if (
      !native.scriptPresent ||
      native.history === null ||
      native.chain.length !== 1 ||
      native.history.versionId !== selected.predecessor.versionId ||
      native.history.deploymentId !== selected.predecessor.deploymentId ||
      native.history.previousVersionId !== null
    )
      throw preflightError(
        "original maintenance repair requires exactly its one acknowledged first native Version",
      );
    const version = await readVersionWithModules(
      state,
      target.workerName,
      native.history.versionId,
    );
    await inspectVersion(
      "preflight",
      target,
      state,
      native.history,
      version,
      selected.originalSourceCommit,
      target.signing.currentKeyId,
      String(original.binding.moduleDigest).slice(7),
      true,
      true,
    );
    await assertOriginal();
    return native;
  };
  const predecessor = await readPredecessor();
  assertWorkersDevOrigin(target, await requiredAccountSubdomain("preflight", state));
  const reviewer = exactReviewer(requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"));
  const source = await assertSource();
  const root = mkdtempSync(join(tmpdir(), "takoserver-original-money-maintenance-successor-"));
  let lease: WranglerVersionPublicationLease | undefined;
  let leaseReleaseAttempted = false;
  let repairPin: string | undefined;
  let repairDispatch: ReturnType<typeof maintenanceProtectedInput> = null;
  let result: Record<string, unknown> | undefined;
  let rootCleaned = false;
  try {
    const inspectionConfig = writeInspectionConfig(root, target, REPOSITORY, invocation.commit);
    const artifactBefore = readBootstrapArtifact(REPOSITORY, target);
    const expectedShape = deriveExpectedApplicationShape(artifactBefore);
    let schemaReader = resolveSchemaReader({}, inspectionConfig, target, environment, runCommand);
    const schemaBefore = await readSchema("preflight", schemaReader);
    assertCompleteSchema(schemaBefore, artifactBefore, expectedShape);
    let r2Identity = resolveR2IdentityReader({}, target, credential.token);
    await assertR2Identity("preflight", target, r2Identity);
    const assertStorage = async (phase: "preflight" | "verification") => {
      await assertOriginal();
      const currentArtifact = readBootstrapArtifact(REPOSITORY, target);
      assertSameArtifact(artifactBefore, currentArtifact, phase);
      const schema = await readSchema(phase, schemaReader);
      assertCompleteSchema(schema, currentArtifact, expectedShape, phase);
      assertSameSchema(schemaBefore, schema, phase);
      await assertR2Identity(phase, target, r2Identity);
      await assertFreshV2DataReadback(
        phase,
        "v2-0092",
        inspectionConfig,
        environment,
        expectedShape,
        { run: runCommand, allowedTables: ["runtime_grant_keys"] },
      );
      await assertOriginal();
      await assertSource();
    };
    await assertStorage("preflight");
    await checkedSuccessorGate(runCommand);
    await assertSource();
    // Resolve the owner credential again after the potentially long gate.
    const refreshed = await resolveCloudflareCredential("integration", { run: runCommand });
    environment = refreshed.childEnvironment;
    state = new CloudflareState({
      accountId: target.accountId,
      token: refreshed.token ?? exactToken(environment),
    });
    schemaReader = resolveSchemaReader({}, inspectionConfig, target, environment, runCommand);
    r2Identity = resolveR2IdentityReader({}, target, refreshed.token);
    await assertSource();
    const prepared = await prepareBootstrapArtifact(
      root,
      target,
      invocation.commit,
      REPOSITORY,
      runCommand,
      undefined,
      {},
      true,
      true,
    );
    const artifact = prepared.seal();
    artifact.assertUnchanged();
    await assertSource();
    const expectedSuccessor = expectedExactBindingClosure(target, {
      signingKeyId: target.signing.currentKeyId,
      expectedSecrets: [],
      workerArtifactDigest: `sha256:${prepared.bundleDigestHex}`,
    });
    if (expectedSuccessor.TAKOSERVER_ENVIRONMENT?.fields.text !== "integration")
      throw preflightError(
        "corrected maintenance successor must emit the exact integration environment binding",
      );
    await assertStorage("preflight");
    await readPredecessor();
    lease = await acquireWranglerVersionPublicationLease({
      accountId: target.accountId,
      workerName: target.workerName,
    });
    // Exclusive custody is written before the first upload attempt; unknown
    // upload/deploy never authorizes a second call or a first-bootstrap resend.
    mkdirSync(repairRoot, { mode: 0o700 });
    const repairParent = openSync(
      dirname(repairRoot),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(repairParent);
    } finally {
      closeSync(repairParent);
    }
    repairPin = maintenanceDirectoryPin(repairRoot);
    const dispatch = {
      kind: "takoserver.original-money-maintenance-successor-dispatch@v1",
      originalDispatchDigest: original.dispatchDigest,
      originalSourceCommit: selected.originalSourceCommit,
      originalCreateTerminalCustodyDigest: origin.originalCreateTerminalCustodyDigest,
      targetDigest: maintenanceTargetDigest(target),
      writerEpoch: target.moneyCutoverWriterEpoch,
      predecessor: selected.predecessor,
      historicalBindingProfile: selected.historicalBindingProfile,
      sourceCommit: invocation.commit,
      moduleDigest: `sha256:${prepared.bundleDigestHex}`,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
    };
    writeOriginalMaintenanceCustody(join(repairRoot, "dispatch.json"), dispatch, repairPin);
    repairDispatch = maintenanceProtectedInput(join(repairRoot, "dispatch.json"));
    if (repairDispatch === null)
      throw mutationError("original maintenance successor dispatch is unavailable after capture");
    const assertRepair = () => {
      if (
        maintenanceDirectoryPin(repairRoot) !== repairPin ||
        readdirSync(repairRoot).sort().join(",") !== "dispatch.json"
      )
        throw mutationError("original maintenance successor custody changed; no replay");
      if (repairDispatch === null)
        throw mutationError("original maintenance successor dispatch capture is missing");
      repairDispatch.assertUnchanged();
    };
    await assertSource();
    artifact.assertUnchanged();
    assertRepair();
    const publication = await publishWranglerVersion({
      root,
      bundlePath: prepared.bundlePath,
      configPath: prepared.configPath,
      accountId: target.accountId,
      workerName: target.workerName,
      message: `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`,
      lease,
      environment: refreshed.childEnvironment,
      run: runCommand,
      assertUploadedVersion: async (versionId) => {
        assertRepair();
        await assertStorage("preflight");
        const version = await readVersionWithModules(state, target.workerName, versionId);
        await inspectVersion(
          "preflight",
          target,
          state,
          { versionId },
          version,
          invocation.commit,
          target.signing.currentKeyId,
          prepared.bundleDigestHex,
          true,
        );
        await assertSource();
        artifact.assertUnchanged();
        assertRepair();
      },
      assertPredecessorStillCurrent: async () => {
        assertRepair();
        await assertStorage("preflight");
        const current = await readPredecessor();
        if (canonicalJson(current) !== canonicalJson(predecessor))
          throw mutationError("original maintenance successor predecessor changed before traffic");
        await assertSource();
        artifact.assertUnchanged();
        assertRepair();
      },
    });
    const verifySuccessor = async () => {
      assertRepair();
      await assertStorage("verification");
      const current = await readNativePresence("verification", target, state);
      if (
        current.history === null ||
        current.chain.length !== 2 ||
        current.history.versionId !== publication.versionId ||
        current.history.deploymentId !== publication.deploymentId ||
        current.history.previousVersionId !== selected.predecessor.versionId ||
        current.chain[1]?.versionId !== selected.predecessor.versionId ||
        current.chain[1]?.deploymentId !== selected.predecessor.deploymentId
      )
        throw verificationError(
          "original maintenance successor native history does not retain its exact first predecessor",
        );
      const version = await readVersionWithModules(state, target.workerName, publication.versionId);
      await inspectVersion(
        "verification",
        target,
        state,
        current.history,
        version,
        invocation.commit,
        target.signing.currentKeyId,
        prepared.bundleDigestHex,
        true,
      );
      await assertWorkerSchedules(
        "verification",
        target,
        state,
        readExpectedWorkerSchedules("verification", REPOSITORY),
      );
      const probe = await probeSchemaMaintenance(
        target.publicOrigin,
        (url, init) => fetch(url, init),
        ORIGINAL_MONEY_MAINTENANCE_MODE,
      );
      const afterProbe = await readNativePresence("verification", target, state);
      if (canonicalJson(current) !== canonicalJson(afterProbe))
        throw verificationError(
          "original maintenance successor native state changed across strict503 proof",
        );
      await assertStorage("verification");
      assertRepair();
      return { current, probe };
    };
    const verified = await verifySuccessor();
    result = {
      kind: "takoserver.integration-worker-original-money-maintenance-successor-apply@v1",
      surface: INTEGRATION_WORKER_BOOTSTRAP_SURFACE,
      environment: "integration",
      commit: source.commit,
      originalSourceCommit: selected.originalSourceCommit,
      originalDispatchDigest: original.dispatchDigest,
      originalCreateTerminalCustodyDigest: origin.originalCreateTerminalCustodyDigest,
      targetDigest: maintenanceTargetDigest(target),
      writerEpoch: target.moneyCutoverWriterEpoch,
      originalDispatchPreserved: true,
      originalTerminalRecovery: "not-manufactured-by-successor",
      maintenanceOnly: true,
      normalHostReady: false,
      runtimeSigningAndSecrets: "not-qualified-maintenance-unused",
      previousVersionId: selected.predecessor.versionId,
      preMutationObservedVersionId: selected.predecessor.versionId,
      deploymentId: verified.current.history?.deploymentId,
      versionId: verified.current.history?.versionId,
      bundleDigest: `sha256:${prepared.bundleDigestHex}`,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      probe: verified.probe,
      reviewer,
    };
    // Cleanup is part of the terminal path, never silently ignored.
    unsealDirectory(root);
    rmSync(root, { recursive: true, force: true });
    rootCleaned = true;
    leaseReleaseAttempted = true;
    await lease.release();
    lease = undefined;
    assertRepair();
    await assertOriginal();
    await assertSource();
    const afterCleanup = await readNativePresence("verification", target, state);
    if (canonicalJson(afterCleanup) !== canonicalJson(verified.current))
      throw verificationError(
        "original maintenance successor native history changed after cleanup",
      );
    const afterCleanupVersion = await readVersionWithModules(
      state,
      target.workerName,
      publication.versionId,
    );
    await inspectVersion(
      "verification",
      target,
      state,
      { versionId: publication.versionId },
      afterCleanupVersion,
      invocation.commit,
      target.signing.currentKeyId,
      prepared.bundleDigestHex,
      true,
    );
    await probeSchemaMaintenance(
      target.publicOrigin,
      (url, init) => fetch(url, init),
      ORIGINAL_MONEY_MAINTENANCE_MODE,
    );
    await assertOriginal();
    await assertSource();
    assertRepair();
    const finalNative = await readNativePresence("verification", target, state);
    if (canonicalJson(finalNative) !== canonicalJson(afterCleanup))
      throw verificationError("original maintenance successor changed after final strict503 proof");
    await assertOriginal();
    await assertSource();
    assertRepair();
    const terminal = {
      kind: "takoserver.original-money-maintenance-successor-terminal@v1",
      dispatchDigest: maintenanceDigest(JSON.stringify(dispatch)),
      result,
      resultDigest: maintenanceDigest(JSON.stringify(result)),
    };
    writeOriginalMaintenanceCustody(join(repairRoot, "terminal.json"), terminal, repairPin);
    return {
      ...result,
      successorDispatchDigest: terminal.dispatchDigest,
      successorResultDigest: terminal.resultDigest,
      successorTerminalCustodyDigest: maintenanceDigest(JSON.stringify(terminal)),
    };
  } catch (error) {
    if (repairPin !== undefined) throw postPublicationVerificationError(error);
    throw error;
  } finally {
    try {
      if (!rootCleaned) {
        unsealDirectory(root);
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      if (lease !== undefined && !leaseReleaseAttempted) {
        leaseReleaseAttempted = true;
        await lease.release();
      }
    }
  }
}

export async function runIntegrationWorkerBootstrap(
  invocation: IntegrationWorkerBootstrapInvocation,
  target: DeployTarget,
  options: IntegrationWorkerBootstrapOptions = {},
): Promise<Record<string, unknown>> {
  if (Object.getOwnPropertyDescriptor(options, "originalMoneyMaintenanceRepair") !== undefined)
    return await runOriginalMoneyMaintenanceSuccessor(invocation, target, options);
  const originalDescriptor = Object.getOwnPropertyDescriptor(options, "originalMoneyMaintenance");
  if (originalDescriptor !== undefined) {
    target = maintenanceData(target) as unknown as DeployTarget;
    invocation = maintenanceData(invocation) as unknown as IntegrationWorkerBootstrapInvocation;
  }
  validateInvocation(invocation, target);
  const originalMaintenance =
    originalDescriptor === undefined
      ? undefined
      : await captureOriginalMoneyMaintenance(invocation, target, options);
  if (originalMaintenance !== undefined) {
    target = originalMaintenance.target;
    // Never consult a caller's option object, prototype or Proxy after original capture.
    options = Object.freeze({ originalMoneyMaintenance: originalMaintenance.locators });
  }
  const run = options.run ?? runCommand;
  const assertOriginalPublicationSource = async () => {
    if (originalMaintenance !== undefined) {
      const current = await qualifySource({
        environment: "integration",
        commit: invocation.commit,
        run,
      });
      if (current.dirty) {
        throw preflightError(
          "original money maintenance publication requires the exact clean source commit",
        );
      }
    }
  };
  const resolveCredential = async () =>
    await resolveCloudflareCredential("integration", {
      cloudflareEnvironment: options.cloudflareEnvironment,
      run,
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
    });
  const credential =
    invocation.action === "status" && options.state !== undefined
      ? undefined
      : await resolveCredential();
  const environment = credential?.childEnvironment ?? {};
  const createState = (resolved: typeof credential): IntegrationWorkerBootstrapState =>
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: resolved?.token ?? exactToken(resolved?.childEnvironment ?? {}),
    });
  let state = createState(credential);

  // No source, provider qualification or secret directory is touched before
  // all four exhaustive native inventories prove exact absence.
  const initial = await readNativePresence("preflight", target, state);
  if (invocation.action === "status" && initial.absent) {
    if (originalMaintenance !== undefined) {
      await originalMaintenance.assertCurrent();
      return {
        ...statusResult(invocation, target, initial),
        state:
          originalMaintenance.readCustody() === null
            ? "not_published"
            : "original_publication_outcome_unknown",
        ready: false,
        normalHostReady: false,
        maintenanceOnly: true,
        originalCreateTerminalCustodyDigest:
          originalMaintenance.originalCreateTerminalCustodyDigest,
        runtimeSigningAndSecrets: "not-qualified-maintenance-unused",
      };
    }
    if (target.takoformV2 === undefined) return statusResult(invocation, target, initial);
    let storageQualified = false;
    try {
      await readV2StorageProof(target, options);
      storageQualified = true;
    } catch {
      // Status is value-free and never promotes an unavailable or unreadable
      // D1 merely because the Worker name is unoccupied.
    }
    return {
      ...statusResult(invocation, target, initial),
      state: "not_published",
      ready: false,
      nativeCreateEligible: true,
      storageQualified,
    };
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
      originalMaintenance,
    );
  }

  if (originalMaintenance === undefined) await assertTargetComposes("preflight", target);
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
    const artifactBefore = readBootstrapArtifact(sourceRepositoryRoot, target);
    const expectedShape = deriveExpectedApplicationShape(artifactBefore);
    const schemaReader = resolveSchemaReader(options, inspectionConfig, target, environment, run);
    const schemaBefore = await readSchema("preflight", schemaReader);
    assertCompleteSchema(schemaBefore, artifactBefore, expectedShape);
    if (originalMaintenance === undefined) assertMoneyUnitSchema(schemaBefore.applied);
    assertStripeWebhookSchema(target, schemaBefore.applied);
    assertOrgBillingSchema(target, schemaBefore.applied);
    const v2StorageBefore =
      target.takoformV2 === undefined ? null : await readV2StorageProof(target, options);
    // A fresh generation must still be unserved when its first Host appears:
    // only the migration seeds and the append-only signing registration may
    // exist. A copied or previously served database is refused, not adopted.
    const assertUnserved = async () => {
      const lineage = target.takoformV2?.storageLineage;
      if (lineage === undefined) return;
      try {
        await assertFreshV2DataReadback(
          "preflight",
          lineage,
          inspectionConfig,
          environment,
          expectedShape,
          {
            run,
            ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
            ...(options.freshV2DataReader === undefined
              ? {}
              : { freshV2DataReader: options.freshV2DataReader }),
            allowedTables: ["runtime_grant_keys"],
          },
        );
      } catch {
        throw preflightError(
          "fresh v2 storage generation already holds data beyond its seeds and signing registration; first Host publication refused",
        );
      }
    };
    await assertUnserved();

    const provider =
      originalMaintenance === undefined
        ? providerExecutorQualificationReader({
            target,
            ...(options.providerExecutorQualification === undefined
              ? {}
              : { injected: options.providerExecutorQualification }),
          })
        : null;
    const providerBefore = provider === null ? null : await provider.read("preflight");
    if (providerBefore !== null && !providerBefore.ready) {
      throw preflightError(
        "public Worker bootstrap requires the exact selected-commit Cloudflare provider executor",
      );
    }

    const signingDatabase =
      originalMaintenance === undefined
        ? (options.signingDatabase ??
          createRemoteSigningDatabase(
            inspectionConfig,
            environment,
            run,
            wranglerCommandForPath(options.wranglerPath),
          ))
        : null;
    const signingBefore =
      signingDatabase === null ? null : await readSigning("preflight", target, signingDatabase);
    if (signingBefore !== null) assertDistinctJit(target, signingBefore);
    let r2Identity = resolveR2IdentityReader(options, target, credential?.token);
    await assertR2Identity("preflight", target, r2Identity);

    const source = await qualifySource({
      environment: "integration",
      commit: invocation.commit,
      run,
    });
    if (originalMaintenance !== undefined && source.dirty) {
      throw preflightError(
        "original money maintenance publication requires the exact clean source commit",
      );
    }
    const expectedSecrets = originalMaintenance === undefined ? expectedWorkerSecrets(target) : [];
    const secretDirectory =
      originalMaintenance === undefined
        ? (options.secretDirectory ?? requireEnvironment(CLOSURE_SECRET_DIRECTORY_ENV))
        : undefined;
    const readQualifiedSecretInputs = async (): Promise<Readonly<Record<string, string>>> => {
      if (originalMaintenance !== undefined) return Object.freeze({});
      if (secretDirectory === undefined || signingBefore === null)
        throw preflightError("normal Worker signing and secret qualification are unavailable");
      if (target.edgeSupplies !== undefined && originalMaintenance === undefined) {
        if (options.expectedRuntimeInputSealKeyring === undefined) {
          throw preflightError("runtime input seal keyring qualification is unavailable");
        }
        await parseRuntimeInputSealKeyRing(options.expectedRuntimeInputSealKeyring);
      }
      let values: Readonly<Record<string, string>>;
      try {
        values = readClosureSecretInputs(secretDirectory, expectedSecrets);
      } catch (error) {
        throw valueFree(error, "initial Worker secret inputs are unavailable");
      }
      const privateRaw = await readVerifiedPrivateSigningJwk(
        join(secretDirectory, "TAKOSERVER_SIGNING_KEY"),
        signingBefore.row,
        signingBefore.keyId,
      );
      if (privateRaw !== values.TAKOSERVER_SIGNING_KEY) {
        throw preflightError("active runtime signing private key changed during qualification");
      }
      if (target.edgeSupplies !== undefined && originalMaintenance === undefined) {
        const localKeyring = values.TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING;
        if (localKeyring === undefined || options.expectedRuntimeInputSealKeyring === undefined) {
          throw preflightError("runtime input seal keyring input is unavailable");
        }
        await parseRuntimeInputSealKeyRing(localKeyring);
        if (
          canonicalJson(localKeyring) !== canonicalJson(options.expectedRuntimeInputSealKeyring)
        ) {
          throw preflightError("runtime input seal keyring differs from qualified CPE input");
        }
      }
      if (target.takoformV2 !== undefined) {
        try {
          parseTakoformV2ApplicationConfig({
            TAKOSERVER_TAKOFORM_V2_CONFIG: target.takoformV2.config,
            TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: values.TAKOSERVER_TAKOFORM_V2_CURSOR_KEY,
          });
        } catch {
          throw preflightError("v2 Host cursor secret does not satisfy the selected configuration");
        }
      }
      return values;
    };
    // Fail a missing, unsafe or mismatched secret input before the long Host
    // bootstrap gate. The read after the gate stays the authoritative one.
    await readQualifiedSecretInputs();
    await checkedGate(run);
    await assertOriginalPublicationSource();
    // The owner gate can outlive a Wrangler OAuth access token (about one hour;
    // Wrangler refreshes only an already expired token). No Cloudflare read or
    // write after the gate reuses a bearer resolved before it.
    const gatedCredential = await resolveCredential();
    state = createState(gatedCredential);
    r2Identity = resolveR2IdentityReader(options, target, gatedCredential.token);

    await originalMaintenance?.assertCurrent();
    const secretValues = await readQualifiedSecretInputs();

    const prepared = await prepareBootstrapArtifact(
      root,
      target,
      source.commit,
      sourceRepositoryRoot,
      run,
      options.wranglerPath,
      secretValues,
      originalMaintenance !== undefined,
    );
    let secretSeal: SealedArtifact | null = null;
    if (originalMaintenance === undefined) {
      secretsRoot = mkdtempSync(join(tmpdir(), "takoserver-integration-worker-secrets-"));
      mkdirSync(secretsRoot, { recursive: true, mode: 0o700 });
      const secretsFile = join(secretsRoot, "secrets.json");
      // Register the path before writing so even a partially-created file is
      // attempted during the independent cleanup pass below.
      secretsPath = secretsFile;
      writeFileSync(secretsFile, `${JSON.stringify(secretValues)}\n`, { mode: 0o600 });
      assertPrivateSecretFile(secretsFile);
      secretSeal = sealDirectory(secretsRoot, ["secrets.json"]);
      assertSecretSeal("preflight", secretSeal);
    }
    // The public artifact identity deliberately excludes the private secrets
    // file. Its seal is checked in-memory but its digest/size never leave this
    // function, so result identities cannot be influenced by secret bytes.
    const artifact = prepared.seal();
    artifact.assertUnchanged();
    await assertOriginalPublicationSource();

    const afterBuild = await readNativePresence("preflight", target, state);
    if (!afterBuild.absent) {
      throw preflightError(
        "integration Worker bootstrap native absence changed during qualification",
      );
    }
    const artifactAfterBuild = readBootstrapArtifact(sourceRepositoryRoot, target);
    assertSameArtifact(artifactBefore, artifactAfterBuild);
    const schemaAfterBuild = await readSchema("preflight", schemaReader);
    assertCompleteSchema(schemaAfterBuild, artifactAfterBuild, expectedShape);
    assertSameSchema(schemaBefore, schemaAfterBuild);
    if (signingDatabase !== null && signingBefore !== null) {
      const signingAfterBuild = await readSigning("preflight", target, signingDatabase);
      assertSameSigning(signingBefore, signingAfterBuild);
      assertDistinctJit(target, signingAfterBuild);
    }
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
    await originalMaintenance?.assertCurrent();
    await assertOriginalPublicationSource();
    originalMaintenance?.dispatch({
      moduleDigest: `sha256:${prepared.bundleDigestHex}`,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
    });
    mutationStarted = true;
    const publication = await lifecycle({
      root,
      bundlePath: prepared.bundlePath,
      configPath: prepared.configPath,
      accountId: target.accountId,
      workerName: target.workerName,
      message: `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`,
      lease,
      ...(secretsPath === null ? {} : { secretsFilePath: secretsPath }),
      environment,
      run,
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
      assertCurrentStillExpected: async () => {
        await originalMaintenance?.assertCurrent();
        const current = await readNativePresence("preflight", target, state);
        if (!current.absent) {
          throw preflightError(
            "integration Worker bootstrap native absence fence failed immediately before deployment",
          );
        }
        const localFinal = readBootstrapArtifact(sourceRepositoryRoot, target);
        assertSameArtifact(artifactBefore, localFinal);
        const schemaFinal = await readSchema("preflight", schemaReader);
        assertCompleteSchema(schemaFinal, localFinal, expectedShape);
        assertSameSchema(schemaBefore, schemaFinal);
        if (signingDatabase !== null && signingBefore !== null) {
          const signingFinal = await readSigning("preflight", target, signingDatabase);
          assertSameSigning(signingBefore, signingFinal);
          assertDistinctJit(target, signingFinal);
        }
        await assertR2Identity("preflight", target, r2Identity);
        if (v2StorageBefore !== null) {
          const storageFinal = await readV2StorageProof(target, options);
          assertSameV2StorageProof(v2StorageBefore, storageFinal, "preflight");
          await assertUnserved();
        }
        const providerFinal = provider === null ? null : await provider.read("preflight");
        if (providerBefore !== null && providerFinal !== null) {
          assertProviderExecutorUnchanged(providerBefore, providerFinal);
        }
        if (secretSeal !== null) assertSecretSeal("preflight", secretSeal);
        artifact.assertUnchanged();
        await assertOriginalPublicationSource();
      },
    } satisfies LifecycleInput);

    try {
      if (secretSeal !== null) assertSecretSeal("verification", secretSeal);
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
        v2StorageBefore,
        expectedShape,
        signingDatabase,
        signingBefore,
        schemaReader,
        r2Identity,
        expectedSchedules,
        reviewer,
        provider,
        providerBefore,
        originalMaintenance,
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
  if (originalMaintenance !== undefined) {
    await assertOriginalPublicationSource();
    await originalMaintenance.assertCurrent();
    const current = await readNativePresence("verification", target, state);
    if (
      current.history === null ||
      current.chain.length !== 1 ||
      current.history.versionId !== result.versionId ||
      current.history.deploymentId !== result.deploymentId ||
      typeof result.bundleDigest !== "string" ||
      !SHA256.test(result.bundleDigest)
    )
      throw verificationError(
        "original money maintenance native publication changed after cleanup",
      );
    const version = await readVersionWithModules(
      state,
      target.workerName,
      current.history.versionId,
    );
    await inspectVersion(
      "verification",
      target,
      state,
      current.history,
      version,
      invocation.commit,
      target.signing.currentKeyId,
      result.bundleDigest.slice(7),
      true,
    );
    await probeSchemaMaintenance(
      target.publicOrigin,
      (url, init) => fetch(url, init),
      ORIGINAL_MONEY_MAINTENANCE_MODE,
    );
    await originalMaintenance.assertCurrent();
    const after = await readNativePresence("verification", target, state);
    if (
      after.history?.versionId !== current.history.versionId ||
      after.history.deploymentId !== current.history.deploymentId ||
      after.chain.length !== 1
    )
      throw verificationError("original money maintenance Version changed after cleanup probe");
    await assertOriginalPublicationSource();
    result = { ...result, ...originalMaintenance.terminal(result) };
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
  originalMaintenance?: Awaited<ReturnType<typeof captureOriginalMoneyMaintenance>>,
): Promise<Record<string, unknown>> {
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-integration-worker-status-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const sourceRoot = resolve(options.sourceRepositoryRoot ?? REPOSITORY);
    const expectedSchedules = readExpectedWorkerSchedules("preflight", sourceRoot);
    const config = writeInspectionConfig(root, target, sourceRoot, invocation.commit);
    const artifact = readBootstrapArtifact(sourceRoot, target);
    const expectedShape = deriveExpectedApplicationShape(artifact);
    const schemaReader = resolveSchemaReader(options, config, target, environment, run);
    const schema = await readSchema("preflight", schemaReader);
    assertCompleteSchema(schema, artifact, expectedShape);
    const provider =
      originalMaintenance === undefined
        ? providerExecutorQualificationReader({
            target,
            ...(options.providerExecutorQualification === undefined
              ? {}
              : { injected: options.providerExecutorQualification }),
          })
        : null;
    const providerInspection = provider === null ? null : await provider.read("preflight");
    const signingDatabase =
      originalMaintenance === undefined
        ? (options.signingDatabase ??
          createRemoteSigningDatabase(
            config,
            environment,
            run,
            wranglerCommandForPath(options.wranglerPath),
          ))
        : null;
    const signing =
      signingDatabase === null ? null : await readSigning("preflight", target, signingDatabase);
    if (signing !== null) assertDistinctJit(target, signing);
    const r2Identity = resolveR2IdentityReader(options, target, cloudflareToken);
    await assertR2Identity("preflight", target, r2Identity);
    if (target.takoformV2 !== undefined) await readV2StorageProof(target, options);
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
      signing?.keyId ?? target.signing.currentKeyId,
      undefined,
      originalMaintenance !== undefined,
    );
    await assertWorkerSchedules("preflight", target, state, expectedSchedules);
    await originalMaintenance?.assertCurrent();
    const maintenanceProbe =
      originalMaintenance === undefined
        ? null
        : await probeSchemaMaintenance(
            target.publicOrigin,
            (url, init) => fetch(url, init),
            ORIGINAL_MONEY_MAINTENANCE_MODE,
          );
    const originalCustody = originalMaintenance?.readCustody();
    const ready =
      originalMaintenance === undefined &&
      identity.commit === invocation.commit &&
      moneyUnitSchemaReady(schema.applied) &&
      orgBillingSchemaReady(target, schema.applied) &&
      (providerInspection === null || providerInspection.ready);
    return {
      ...statusResult(invocation, target, initial),
      state:
        originalMaintenance === undefined
          ? ready
            ? "complete"
            : "drift"
          : originalCustody === null
            ? "unbound_maintenance_publication"
            : "maintenance_observed_original_custody_held",
      ...(originalMaintenance === undefined
        ? {}
        : {
            maintenanceOnly: true,
            normalHostReady: false,
            maintenanceProbe,
            runtimeSigningAndSecrets: "not-qualified-maintenance-unused",
            originalPublicationCustody:
              originalCustody === null
                ? "absent"
                : originalCustody?.result === null
                  ? "unknown"
                  : "terminal",
          }),
      deployedCommit: identity.commit,
      artifactDigest: `sha256:${identity.bundleDigestHex}`,
      appliedMigrations: schema.applied,
      schemaShapeDigest: schema.shapeDigest,
      moneyUnitSchemaReady: moneyUnitSchemaReady(schema.applied),
      ready,
      ...(target.takoformV2 === undefined ? {} : { storageQualified: true }),
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
  const result = {
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
    moneyUnitSchemaReady: false,
    billingSchemaReady: orgBillingSchemaReady(target, []),
    ready: false,
    mutationApplied: false,
  };
  return target.takoformV2 === undefined
    ? result
    : {
        ...result,
        state: native.absent ? "not_published" : "partial",
        ready: false,
        nativeCreateEligible: native.absent,
        storageQualified: false,
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
  readonly v2StorageBefore: FreshV2IntegrationStorageTargetProof | null;
  readonly expectedShape: string;
  readonly signingDatabase: Pick<SigningDatabase, "readKey"> | null;
  readonly signingBefore: SigningEvidence | null;
  readonly schemaReader: IntegrationWorkerBootstrapSchemaReader;
  readonly r2Identity: IntegrationWorkerBootstrapR2IdentityReader;
  readonly expectedSchedules: readonly string[];
  readonly reviewer: string;
  readonly provider: WorkerProviderExecutorQualification | null;
  readonly providerBefore: ProviderExecutorInspection | null;
  readonly originalMaintenance?: Awaited<ReturnType<typeof captureOriginalMoneyMaintenance>>;
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
    input.signingBefore?.keyId ?? input.target.signing.currentKeyId,
    input.prepared.bundleDigestHex,
    input.originalMaintenance !== undefined,
  );
  const artifactAfter = readBootstrapArtifact(
    resolve(input.options.sourceRepositoryRoot ?? REPOSITORY),
    input.target,
  );
  assertSameArtifact(input.artifactBefore, artifactAfter, "verification");
  const schemaAfter = await readSchema("verification", input.schemaReader);
  assertCompleteSchema(schemaAfter, artifactAfter, input.expectedShape, "verification");
  assertSameSchema(input.schemaBefore, schemaAfter, "verification");
  if (input.originalMaintenance === undefined) {
    if (input.signingDatabase === null || input.signingBefore === null)
      throw verificationError("normal Worker signing qualification is unavailable");
    const signingAfter = await readSigning("verification", input.target, input.signingDatabase);
    assertSameSigning(input.signingBefore, signingAfter, "verification");
    assertDistinctJit(input.target, signingAfter, "verification");
  }
  await assertR2Identity("verification", input.target, input.r2Identity);
  if (input.v2StorageBefore !== null) {
    const storageAfter = await readV2StorageProof(input.target, input.options);
    assertSameV2StorageProof(input.v2StorageBefore, storageAfter, "verification");
  }
  await assertWorkerSchedules("verification", input.target, input.state, input.expectedSchedules);
  const providerAfter = input.provider === null ? null : await input.provider.read("verification");
  if (input.providerBefore !== null && providerAfter !== null) {
    assertProviderExecutorUnchanged(input.providerBefore, providerAfter, "verification");
  }
  await input.originalMaintenance?.assertCurrent();
  const probe =
    input.originalMaintenance === undefined
      ? await probeProduct(
          input.target.publicOrigin,
          input.options.fetcher ?? ((url, init) => fetch(url, init)),
        )
      : await probeSchemaMaintenance(
          input.target.publicOrigin,
          (url, init) => fetch(url, init),
          ORIGINAL_MONEY_MAINTENANCE_MODE,
        );
  if (input.originalMaintenance !== undefined) {
    const final = await readNativePresence("verification", input.target, input.state);
    if (
      final.history?.versionId !== after.history.versionId ||
      final.history.deploymentId !== after.history.deploymentId ||
      final.chain.length !== 1
    )
      throw verificationError("original money maintenance Version changed after503 readback");
    await input.originalMaintenance.assertCurrent();
  }
  return {
    kind:
      input.originalMaintenance === undefined
        ? "takoserver.integration-worker-bootstrap-apply@v1"
        : ORIGINAL_MONEY_MAINTENANCE_RESULT,
    ...(input.originalMaintenance === undefined
      ? {}
      : {
          maintenanceOnly: true,
          normalHostReady: false,
          originalCreateTerminalCustodyDigest:
            input.originalMaintenance.originalCreateTerminalCustodyDigest,
          oldWritersAndExternalEffects: "not-qualified-here",
          runtimeSigningAndSecrets: "not-qualified-maintenance-unused",
        }),
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
  history: Pick<WorkerDeploymentHistory, "versionId">,
  version: unknown,
  selectedCommit: string,
  signingKeyId: string,
  expectedBundleDigestHex?: string,
  maintenanceOnly = false,
  historicalMissingMoneyEnvironment = false,
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
  const expectedBindings = {
    ...expectedExactBindingClosure(target, {
      signingKeyId,
      ...(maintenanceOnly ? { expectedSecrets: [] } : {}),
      ...(authorityProfile === undefined ? {} : { authorityProfile }),
      workerArtifactDigest: `sha256:${identity.bundleDigestHex}` as const,
    }),
  };
  // This exact historical exception is reachable only after the repair owner
  // matches original first-dispatch source/module and single native history.
  // It does not weaken ordinary/current Version inspection.
  if (historicalMissingMoneyEnvironment) {
    if (!maintenanceOnly || target.moneyCutoverWriterPolicy !== "transaction-fenced-usd-micros-v1")
      throw phaseError(phase, "historical maintenance environment profile is unavailable");
    delete expectedBindings.TAKOSERVER_ENVIRONMENT;
  }
  assertExactVersionBindingClosure(phase, history.versionId, bindingProjection, expectedBindings);
  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    maintenanceOnly ? [] : expectedWorkerSecrets(target),
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
  maintenanceOnly = false,
  versionOnly = false,
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
    ...(versionOnly ? { dryRunCommand: "versions-upload" as const } : {}),
    writeConfig: ({ path, main, bundleDigestHex, formImplementationIdentity }) =>
      writeWorkerConfig(target, {
        path,
        main,
        commit,
        sourceRepositoryRoot,
        ...(maintenanceOnly ? { transitionExpectedSecrets: [] } : {}),
        ...(versionOnly ? { topology: "version-only" as const } : {}),
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

function readBootstrapArtifact(sourceRoot: string, target: DeployTarget): MigrationArtifact {
  const directory = resolve(sourceRoot, "migrations");
  if (target.takoformV2 === undefined) return readAuditedMigrationArtifact(directory);
  const source = readCurrentAuditedMigrationSourceArtifact(directory);
  switch (takoformV2StorageLineage(target)) {
    case "v2-artifacts-0075":
      return projectFreshV2ArtifactMigrationArtifact(source);
    case "v2-0088":
      return projectFreshProductionV2MigrationArtifact(source);
    case "v2-0089":
      return projectFreshProductionV2MigrationArtifact0089(source);
    case "v2-0091":
      return projectFreshIntegrationV2MigrationArtifact0091(source);
    case "v2-0092":
      return projectFreshIntegrationV2MigrationArtifact0092(source);
  }
}

async function readV2StorageProof(
  target: DeployTarget,
  options: IntegrationWorkerBootstrapOptions,
): Promise<FreshV2IntegrationStorageTargetProof> {
  return await verifyFreshV2IntegrationStorageTarget(
    target,
    "integration",
    takoformV2StorageLineage(target),
    {
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
      ...(options.cloudflareEnvironment === undefined
        ? {}
        : { cloudflareEnvironment: options.cloudflareEnvironment }),
      ...options.v2StorageVerification,
      ...(options.originalMoneyMaintenance === undefined
        ? {}
        : { allowMoneyUnitMaintenance: true }),
      migrationDirectory: resolve(options.sourceRepositoryRoot ?? REPOSITORY, "migrations"),
    },
  );
}

function assertSameV2StorageProof(
  expected: FreshV2IntegrationStorageTargetProof,
  actual: FreshV2IntegrationStorageTargetProof,
  phase: "preflight" | "verification",
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    throw phaseError(
      phase,
      "v2 artifact storage identity, lineage or schema changed during bootstrap",
    );
  }
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
