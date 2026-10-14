import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../src/json.ts";
import {
  hasImmutableStripeModeRealmSchema,
  STRIPE_MODE_REALM_SCHEMA_QUERY,
} from "../../src/stripe-mode-realm.ts";
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
  type CanonicalV20092IntegrationStorageTargetProof,
  type FreshV2IntegrationStorageTargetProof,
  type IntegrationStorageGenerationTargetVerificationOptions,
  verifyCanonicalV20092IntegrationStorageTarget,
  verifyFreshV2IntegrationStorageTarget,
} from "./integration-storage-generation.ts";
import {
  assertMoneyUnitSchema,
  assertOrgBillingSchema,
  assertStripeWebhookSchema,
  MONEY_UNIT_MIGRATION,
  type MoneyUnitPolicyRow,
  moneyUnitPolicyReady,
  moneyUnitSchemaReady,
  orgBillingSchemaReady,
  pendingMigrations,
  readD1SchemaState,
  readMigrationArtifact,
  readMoneyUnitPolicy,
  stripeWebhookSchemaReady,
} from "./migrations.ts";
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
import {
  projectCanonicalIntegrationV2MigrationArtifact0092,
  readCurrentAuditedMigrationSourceArtifact,
} from "./schema.ts";
import { moneyUnitCutoverSchemaMatches } from "./schema-money-unit-cutover.ts";
import {
  activePublicJwk,
  createRemoteSigningDatabase,
  type SigningDatabase,
  type SigningPublicKeyRow,
} from "./signing.ts";
import {
  inspectStripeModeRealm,
  type StripeModeRealmRead,
  type StripeModeRealmStatus,
} from "./stripe-mode-realm.ts";
import {
  type DeployTarget,
  isArtifactBlobIoQuiescedTarget,
  takoformV2StorageLineage,
} from "./target.ts";
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
  workerVersionIdentity,
} from "./worker-live.ts";

type MaintenanceNativeState = WorkerState & {
  workerVersionWithModules?(workerName: string, versionId: string): Promise<unknown>;
  workerSettings?(workerName: string): Promise<unknown>;
  workerRoutes?(): Promise<readonly unknown[]>;
};

export interface WorkerMigrationReader {
  read(): Promise<{
    readonly local: readonly string[];
    readonly applied: readonly string[];
    readonly shape?: string;
    readonly shapeDigest?: string;
    readonly moneyUnitPolicy?: readonly MoneyUnitPolicyRow[];
  }>;
}

export interface WorkerStripeModeRealmReader {
  /** Returns raw rows from the selected realized D1; validation stays local. */
  read(): Promise<StripeModeRealmRead>;
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
  readonly state?: MaintenanceNativeState;
  readonly migrations?: WorkerMigrationReader;
  /** Read-only selected-D1 realm proof; injectable only for portable tests. */
  readonly stripeModeRealm?: WorkerStripeModeRealmReader;
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
  /** Owner-proved, non-serving publication for one exact integration schema wave. */
  readonly maintenance?:
    | {
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
      }
    | {
        readonly mode: "pre-v2-0098-quiesced";
        readonly storageLineage: "v2-0088";
        readonly appliedSchemaLineage: "v2-0092";
        readonly accountId: string;
        readonly databaseId: string;
        readonly databaseName: string;
        readonly workerName: string;
        readonly activeVersionId: string;
        readonly activeDeploymentId: string;
        readonly previousVersionId: string;
        readonly selectedSourceCommit: string;
        readonly selectedModuleDigestHex: string;
        /** Private owner derives this from fresh native Version and settings readback. */
        readonly observedNonCodeDigestHex: string;
        /** The 0088 historical-source witness is not part of this distinct proof. */
        readonly predecessorSourceCommit?: never;
      };
}

export function providerExecutorAllowsPublication(
  target: DeployTarget,
  inspection: ProviderExecutorInspection | null,
): boolean {
  if (target.schemaMaintenanceMode === "pre-v2-0098-quiesced") {
    if (
      target.environment !== "integration" ||
      target.takoformV2?.storageLineage !== "v2-0088" ||
      target.takoformV2.appliedSchemaLineage !== "v2-0092" ||
      target.artifactBlobIoMode !== undefined
    )
      return false;
    if (target.cloudflareProviderExecutor === undefined) return inspection === null;
    if (inspection?.maintenance?.mode !== "pre-v2-0098-quiesced") return false;
    const proof = inspection.maintenance;
    return (
      inspection.status === "stale" &&
      !inspection.ready &&
      !inspection.schemaReady &&
      inspection.managedExact &&
      inspection.routeLess &&
      inspection.dependencies.ready &&
      proof.storageLineage === target.takoformV2.storageLineage &&
      proof.appliedSchemaLineage === target.takoformV2.appliedSchemaLineage &&
      proof.accountId === target.accountId &&
      proof.databaseId === target.d1.databaseId &&
      proof.databaseName === target.d1.databaseName &&
      proof.workerName === target.cloudflareProviderExecutor.workerName &&
      proof.activeVersionId === inspection.versionId &&
      proof.activeDeploymentId === inspection.deploymentId &&
      proof.previousVersionId === inspection.previousVersionId &&
      isWorkerVersionId(proof.activeVersionId) &&
      isWorkerVersionId(proof.activeDeploymentId) &&
      isWorkerVersionId(proof.previousVersionId) &&
      proof.selectedSourceCommit === inspection.commit &&
      /^[0-9a-f]{40}$/u.test(proof.selectedSourceCommit) &&
      proof.selectedModuleDigestHex === inspection.moduleDigestHex &&
      /^[0-9a-f]{64}$/u.test(proof.selectedModuleDigestHex) &&
      typeof inspection.bundleDigestHex === "string" &&
      /^[0-9a-f]{64}$/u.test(inspection.bundleDigestHex) &&
      /^[0-9a-f]{64}$/u.test(proof.observedNonCodeDigestHex)
    );
  }
  if (inspection === null) return true;
  if (target.schemaMaintenanceMode !== "pre-v2-0088-quiesced") return inspection.ready;
  const proof = inspection.maintenance;
  if (proof?.mode !== "pre-v2-0088-quiesced") return false;
  return (
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
  readonly migrations: Awaited<ReturnType<WorkerMigrationReader["read"]>>;
  readonly pending: readonly string[];
  readonly integrationE2eCredentialAuthorityConfigured: boolean;
}

const SCHEMA_0058_NAME = "0058_cloudflare_managed_worker_domain_receipts.sql";
const expectedMoneyShapes = new Map<string, string>();

/** Explicit source profiles only; this check never grants D1 apply authority. */
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
  if (target.schemaMaintenanceMode === "pre-wallet-usd-micros-quiesced") {
    if (
      target.moneyCutoverWriterPolicy !== "transaction-fenced-usd-micros-v1" ||
      !/^sha256:[0-9a-f]{64}$/u.test(target.moneyCutoverWriterEpoch ?? "") ||
      target.environment !== "integration" ||
      target.artifactBlobIoMode !== undefined ||
      (target.takoformV2?.storageLineage !== "v2-0092" &&
        target.takoformV2?.appliedSchemaLineage !== "v2-0092") ||
      migrations.shape === undefined ||
      migrations.shapeDigest === undefined
    ) {
      return false;
    }
    const source = readCurrentAuditedMigrationSourceArtifact(
      resolve(sourceRepositoryRoot, "migrations"),
    );
    if (JSON.stringify(migrations.local) !== JSON.stringify(source.names)) return false;
    const state = {
      applied: migrations.applied,
      shape: migrations.shape,
      shapeDigest: migrations.shapeDigest,
    };
    return (
      moneyUnitCutoverSchemaMatches(state, source.files, "0092") ||
      moneyUnitCutoverSchemaMatches(state, source.files, "0092-fenced") ||
      moneyUnitCutoverSchemaMatches(state, source.files, "0093") ||
      moneyUnitCutoverSchemaMatches(state, source.files, "0093-fenced") ||
      moneyUnitCutoverSchemaMatches(state, source.files, "0094") ||
      moneyUnitCutoverSchemaMatches(state, source.files, "0094-fenced")
    );
  }
  if (target.schemaMaintenanceMode === "pre-v2-0098-quiesced") {
    if (
      target.environment !== "integration" ||
      target.artifactBlobIoMode !== undefined ||
      target.takoformV2?.storageLineage !== "v2-0088" ||
      target.takoformV2.appliedSchemaLineage !== "v2-0092"
    ) {
      return false;
    }
    const source = readCurrentAuditedMigrationSourceArtifact(
      resolve(sourceRepositoryRoot, "migrations"),
    );
    const canonical = projectCanonicalIntegrationV2MigrationArtifact0092(source);
    return (
      JSON.stringify(migrations.local) === JSON.stringify(source.names) &&
      JSON.stringify(migrations.applied) === JSON.stringify(canonical.names) &&
      migrations.shape !== undefined &&
      migrations.shapeDigest !== undefined &&
      applicationSchemaMatches(
        {
          applied: migrations.applied,
          shape: migrations.shape,
          shapeDigest: migrations.shapeDigest,
        },
        deriveExpectedApplicationShape(canonical.files),
      )
    );
  }
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
  // Only explicit all-traffic quiescence may publish this artifact before the
  // USD-micros cutover. A fresh v2 generation still serves the wallet route.
  if (
    target.schemaMaintenanceMode === undefined &&
    target.artifactBlobIoMode === undefined &&
    !moneyUnitSchemaReady(migrations.applied)
  ) {
    return false;
  }
  if (
    target.schemaMaintenanceMode === undefined &&
    target.artifactBlobIoMode === undefined &&
    target.environment === "integration" &&
    (target.takoformV2?.storageLineage !== undefined ||
      target.takoformV2?.appliedSchemaLineage !== undefined)
  ) {
    // The selected storage lineage remains the immutable generation origin;
    // it never authorizes this USD-micros Worker on the old money unit.
    const source = readCurrentAuditedMigrationSourceArtifact(
      resolve(sourceRepositoryRoot, "migrations"),
    );
    if (JSON.stringify(migrations.local) !== JSON.stringify(source.names)) return false;
    // 0095 rebuilds stripe_events and drops its permanent writer trigger.
    // A separate reviewed suffix must restore the guard in the same import.
    if (target.moneyCutoverWriterPolicy !== undefined && migrations.applied.length > 94)
      return false;
    if (JSON.stringify(migrations.applied) === JSON.stringify(source.names)) return true;
    // The selected 0092 generation may serve the exact reviewed 0094 cutover
    // prefix while 0095 remains an audited source-only successor. Hosted
    // subscriptions need the complete 0095 schema and cannot use this prefix.
    if (
      target.moneyCutoverWriterPolicy !== "transaction-fenced-usd-micros-v1" ||
      !/^sha256:[0-9a-f]{64}$/u.test(target.moneyCutoverWriterEpoch ?? "") ||
      target.hostedPricing !== undefined ||
      (target.takoformV2?.storageLineage !== "v2-0092" &&
        target.takoformV2?.appliedSchemaLineage !== "v2-0092") ||
      migrations.shape === undefined ||
      migrations.shapeDigest === undefined
    ) {
      return false;
    }
    const state = {
      applied: migrations.applied,
      shape: migrations.shape,
      shapeDigest: migrations.shapeDigest,
    };
    return (
      moneyUnitCutoverSchemaMatches(state, source.files, "0094") ||
      moneyUnitCutoverSchemaMatches(state, source.files, "0094-fenced")
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

export function workerMoneyUnitSchemaReady(
  migrations: Awaited<ReturnType<WorkerMigrationReader["read"]>>,
  sourceRepositoryRoot: string,
): boolean {
  if (
    !moneyUnitSchemaReady(migrations.applied) ||
    !moneyUnitPolicyReady(migrations.moneyUnitPolicy) ||
    migrations.shape === undefined ||
    migrations.shapeDigest === undefined
  ) {
    return false;
  }
  const source = readCurrentAuditedMigrationSourceArtifact(
    resolve(sourceRepositoryRoot, "migrations"),
  );
  let expectedShape = expectedMoneyShapes.get(source.digest);
  if (expectedShape === undefined) {
    expectedShape = deriveExpectedApplicationShape(source.files);
    if (expectedMoneyShapes.size >= 4) expectedMoneyShapes.clear();
    expectedMoneyShapes.set(source.digest, expectedShape);
  }
  if (
    !source.names.includes(MONEY_UNIT_MIGRATION) ||
    JSON.stringify(migrations.local) !== JSON.stringify(source.names)
  ) {
    return false;
  }
  const state = {
    applied: migrations.applied,
    shape: migrations.shape,
    shapeDigest: migrations.shapeDigest,
  };
  if (JSON.stringify(migrations.applied) === JSON.stringify(source.names)) {
    return applicationSchemaMatches(state, expectedShape);
  }
  return (
    moneyUnitCutoverSchemaMatches(state, source.files, "0094") ||
    moneyUnitCutoverSchemaMatches(state, source.files, "0094-fenced")
  );
}

export function assertWorkerMoneyUnitSchema(
  migrations: Awaited<ReturnType<WorkerMigrationReader["read"]>>,
  sourceRepositoryRoot: string,
  phase: "preflight" | "verification",
): void {
  if (phase === "preflight") assertMoneyUnitSchema(migrations.applied);
  if (!workerMoneyUnitSchemaReady(migrations, sourceRepositoryRoot)) {
    const message = "Worker requires the exact complete audited D1 schema and USD-micros policy";
    if (phase === "verification") throw verificationError(message);
    throw preflightError(message);
  }
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
      (mode === "pre-wallet-usd-micros-quiesced"
        ? "Host is quiesced for the wallet USD-micros schema maintenance transition"
        : mode === "pre-0058-quiesced"
          ? "Host is quiesced for the 0058 schema maintenance transition"
          : mode === "pre-v2-0088-quiesced"
            ? "Host is quiesced for the v2 0088 schema maintenance transition"
            : "Host is quiesced for the v2 0098 schema maintenance transition") ||
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

/** Exact staged normal Worker refusal while the reviewed 0094 freeze row remains. */
export async function probeMoneyCutoverFrozen(
  origin: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ readonly url: string; readonly status: 503; readonly traffic: "money-frozen" }> {
  const url = `${origin}/healthz`;
  const response = await fetcher(url, {
    method: "GET",
    headers: { "cache-control": "no-cache" },
    redirect: "error",
  }).catch(() => {
    throw verificationError("money cutover frozen Worker probe failed");
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    response.status !== 503 ||
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("retry-after") !== "60" ||
    !isRecord(body) ||
    !isRecord(body.error) ||
    body.error.code !== "backend_unavailable" ||
    body.error.message !== "Host is frozen for the wallet USD-micros writer transition" ||
    !isRecord(body.error.details) ||
    body.error.details.reason !== "money-cutover-freeze"
  )
    throw verificationError("money cutover Worker did not prove exact guarded refusal");
  return { url, status: 503, traffic: "money-frozen" };
}

/** A 0094 normal Version can be published before the reviewed freeze-row deletion. */
export async function probeMoneyCutoverProductOrFrozen(
  origin: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
) {
  const response = await fetcher(`${origin}/healthz`, {
    method: "GET",
    headers: { "cache-control": "no-cache" },
    redirect: "error",
  }).catch(() => {
    throw verificationError("money cutover Worker health state is unavailable");
  });
  if (response.status === 503) return probeMoneyCutoverFrozen(origin, fetcher);
  if (response.status === 200) return probeProduct(origin, fetcher);
  throw verificationError("money cutover Worker health state is divergent");
}

/** Native Host observation only: no D1 read and no schema/publication authority. */
async function observePreV20098HostMaintenance(
  invocation: WorkerInvocation,
  target: DeployTarget,
  state: MaintenanceNativeState,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  sourceRepositoryRoot: string,
  run: WorkerProcess,
  providerExecutorQualification?: WorkerProviderExecutorQualification,
  wranglerPath?: string,
): Promise<Record<string, unknown>> {
  if (
    target.environment !== "integration" ||
    target.takoformV2?.storageLineage !== "v2-0088" ||
    target.takoformV2.appliedSchemaLineage !== "v2-0092" ||
    target.artifactBlobIoMode !== undefined
  ) {
    throw preflightError(
      "pre-0098 native status requires the exact original v2-0088/applied v2-0092 integration target",
    );
  }
  const executorQualification = providerExecutorQualificationReader({
    target,
    ...(providerExecutorQualification === undefined
      ? {}
      : { injected: providerExecutorQualification }),
  });
  const executorBefore =
    executorQualification === null ? null : await executorQualification.read("preflight");
  if (!providerExecutorAllowsPublication(target, executorBefore)) {
    throw preflightError(
      "pre-0098 native status requires exact non-serving provider executor proof",
    );
  }
  // Capture values before any Host/native await: a private reader may return the
  // same mutable object on both reads, making reference-based drift checks vacuous.
  const executorBeforeSnapshot = executorBefore === null ? null : canonicalJson(executorBefore);
  // This audits only the selected local source. The durable schema is deliberately
  // unobserved, including when a migration stopped between 0093 and 0098.
  readCurrentAuditedMigrationSourceArtifact(resolve(sourceRepositoryRoot, "migrations"));
  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  if (source.dirty) {
    throw preflightError("pre-0098 native status requires a clean selected source checkout");
  }
  if (
    state.workerVersionWithModules === undefined ||
    state.workerSettings === undefined ||
    state.workerRoutes === undefined ||
    state.workerSubdomain === undefined
  ) {
    throw preflightError(
      "pre-0098 native status requires Version modules, settings, route and subdomain readers",
    );
  }
  const moduleReader = state.workerVersionWithModules.bind(state);
  const settingsReader = state.workerSettings.bind(state);
  const routesReader = state.workerRoutes.bind(state);
  const subdomainReader = state.workerSubdomain.bind(state);
  const root = mkdtempSync(join(tmpdir(), "takoserver-pre98-status-"));
  let expectedBundleDigestHex: string;
  let expectedNativeSettings: {
    readonly compatibilityDate: string;
    readonly compatibilityFlags: readonly string[];
  };
  try {
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      sourceRepositoryRoot,
      ...(wranglerPath === undefined ? {} : { wranglerPath }),
      run,
      environment: {},
      dryRunCommand: "versions-upload",
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
          topology: "version-only",
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
    expectedBundleDigestHex = prepared.bundleDigestHex;
    const sourceSettings: unknown = JSON.parse(readFileSync(prepared.configPath, "utf8"));
    if (
      !isRecord(sourceSettings) ||
      typeof sourceSettings.compatibility_date !== "string" ||
      !Array.isArray(sourceSettings.compatibility_flags) ||
      !sourceSettings.compatibility_flags.every((flag) => typeof flag === "string")
    ) {
      throw preflightError(
        "selected source does not define exact native Worker compatibility settings",
      );
    }
    expectedNativeSettings = {
      compatibilityDate: sourceSettings.compatibility_date,
      compatibilityFlags: [...sourceSettings.compatibility_flags],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const observe = async () => {
    const authorityProfile = await authoritySelectionForCurrent("preflight", target, state, {});
    const live = await inspectLiveWorkerVersion("preflight", target, state, {
      ...(authorityProfile === undefined ? {} : { authorityProfile }),
    });
    if (live.commit !== invocation.commit) {
      throw preflightError("pre-0098 active Host Version is not the selected source commit");
    }
    if (live.bundleDigestHex !== expectedBundleDigestHex) {
      throw preflightError("pre-0098 active Host Version differs from the selected source bundle");
    }
    const [version, moduleVersion, settings, routes, subdomain] = await Promise.all([
      state.workerVersion(target.workerName, live.history.versionId),
      moduleReader(target.workerName, live.history.versionId),
      settingsReader(target.workerName),
      routesReader(),
      subdomainReader(target.workerName),
    ]);
    const native = inspectPreV20098NativeClosure(
      target,
      live.history.versionId,
      live.commit,
      live.bundleDigestHex,
      version,
      moduleVersion,
      settings,
      routes,
      subdomain,
      expectedNativeSettings,
    );
    return { live, native };
  };
  const before = await observe();
  const probe = await probeSchemaMaintenance(target.publicOrigin, fetcher, "pre-v2-0098-quiesced");
  const after = await observe();
  if (canonicalJson(before.live) !== canonicalJson(after.live) || before.native !== after.native) {
    throw preflightError("pre-0098 active Host native Version or settings changed during status");
  }
  const executorAfter =
    executorQualification === null ? null : await executorQualification.read("verification");
  if (executorBefore !== null && executorAfter !== null) {
    assertProviderExecutorUnchanged(executorBefore, executorAfter, "verification", target);
    if (canonicalJson(executorAfter) !== executorBeforeSnapshot) {
      throw verificationError(
        "Cloudflare provider executor qualification changed during public Worker status",
      );
    }
  }
  return {
    kind: "takoserver.worker-status@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    deployedCommit: after.live.commit,
    commitMatches: true,
    deploymentId: after.live.history.deploymentId,
    versionId: after.live.history.versionId,
    previousVersionId: after.live.history.previousVersionId,
    artifactDigest: `sha256:${after.live.bundleDigestHex}`,
    maintenance: "pre-v2-0098-quiesced",
    nativeNonServing: true,
    schemaUnproven: true,
    schemaReady: false,
    moneyUnitSchemaReady: false,
    billingSchemaReady: false,
    ...(executorAfter === null
      ? {}
      : {
          ...providerExecutorStatus(executorAfter),
          cloudflareProviderExecutorNativeNonServing: true,
        }),
    probe,
    ready: false,
  };
}

function inspectPreV20098NativeClosure(
  target: DeployTarget,
  versionId: string,
  commit: string,
  bundleDigestHex: string,
  version: unknown,
  moduleVersion: unknown,
  settings: unknown,
  routes: readonly unknown[],
  subdomain: unknown,
  expectedNativeSettings: {
    readonly compatibilityDate: string;
    readonly compatibilityFlags: readonly string[];
  },
): string {
  if (
    !isRecord(version) ||
    version.id !== versionId ||
    !isRecord(version.resources) ||
    workerVersionIdentity("preflight", version).commit !== commit ||
    workerVersionIdentity("preflight", version).bundleDigestHex !== bundleDigestHex ||
    !isRecord(moduleVersion) ||
    moduleVersion.id !== versionId ||
    moduleVersion.main_module !== "worker.js" ||
    moduleVersion.resources !== undefined ||
    !Array.isArray(moduleVersion.modules) ||
    moduleVersion.modules.length !== 1 ||
    !isRecord(moduleVersion.modules[0])
  ) {
    throw preflightError("pre-0098 active Host native module closure is malformed");
  }
  const module = moduleVersion.modules[0];
  if (
    Object.keys(module).sort().join(",") !== "content_base64,content_type,name" ||
    module.name !== "worker.js" ||
    module.content_type !== "application/javascript+module" ||
    typeof module.content_base64 !== "string"
  ) {
    throw preflightError("pre-0098 active Host native module is malformed");
  }
  const bytes = Buffer.from(module.content_base64, "base64");
  if (
    bytes.toString("base64") !== module.content_base64 ||
    createHash("sha256").update(bytes).digest("hex") !== bundleDigestHex
  ) {
    throw preflightError("pre-0098 active Host native module differs from its Version identity");
  }
  const workersDev = new URL(target.publicOrigin).hostname.endsWith(".workers.dev");
  if (
    !isRecord(subdomain) ||
    subdomain.enabled !== workersDev ||
    subdomain.previewsEnabled !== false
  ) {
    throw preflightError("pre-0098 active Host native subdomain or preview topology differs");
  }
  const compatibilityDate = version.compatibility_date ?? moduleVersion.compatibility_date;
  const compatibilityFlags = version.compatibility_flags ?? moduleVersion.compatibility_flags;
  if (
    !isRecord(settings) ||
    compatibilityDate !== expectedNativeSettings.compatibilityDate ||
    canonicalJson(compatibilityFlags) !==
      canonicalJson(expectedNativeSettings.compatibilityFlags) ||
    (version.compatibility_date !== undefined &&
      version.compatibility_date !== compatibilityDate) ||
    (version.compatibility_flags !== undefined &&
      canonicalJson(version.compatibility_flags) !== canonicalJson(compatibilityFlags)) ||
    (settings.workers_dev !== undefined && settings.workers_dev !== workersDev) ||
    (settings.preview_urls !== undefined && settings.preview_urls !== false) ||
    (settings.compatibility_date !== undefined &&
      settings.compatibility_date !== compatibilityDate) ||
    (settings.compatibility_flags !== undefined &&
      canonicalJson(settings.compatibility_flags) !== canonicalJson(compatibilityFlags)) ||
    (moduleVersion.compatibility_date !== undefined &&
      moduleVersion.compatibility_date !== compatibilityDate) ||
    (moduleVersion.compatibility_flags !== undefined &&
      canonicalJson(moduleVersion.compatibility_flags) !== canonicalJson(compatibilityFlags))
  ) {
    throw preflightError("pre-0098 active Host native settings differ from the selected profile");
  }
  const bindings = (value: unknown): string => {
    if (!Array.isArray(value) || !value.every(isRecord)) {
      throw preflightError("pre-0098 active Host native binding inventory is incomplete");
    }
    const normalized = value.map(({ name, binding, ...fields }) => {
      const effectiveName = typeof name === "string" ? name : binding;
      if (typeof effectiveName !== "string" || effectiveName.length === 0) {
        throw preflightError("pre-0098 active Host native binding inventory is malformed");
      }
      return { name: effectiveName, ...fields };
    });
    if (new Set(normalized.map((entry) => entry.name)).size !== normalized.length) {
      throw preflightError("pre-0098 active Host native binding inventory is malformed");
    }
    return canonicalJson(normalized.sort((left, right) => left.name.localeCompare(right.name)));
  };
  const versionBindings = bindings(version.resources.bindings);
  if (
    (moduleVersion.bindings !== undefined &&
      versionBindings !== bindings(moduleVersion.bindings)) ||
    versionBindings !== bindings(settings.bindings)
  ) {
    throw preflightError(
      "pre-0098 active Host native bindings differ across Version, module and script settings",
    );
  }
  if (
    !Array.isArray(routes) ||
    routes.some(
      (route) =>
        !isRecord(route) ||
        (route.script !== null && typeof route.script !== "string") ||
        route.script === target.workerName,
    )
  ) {
    throw preflightError("pre-0098 active Host has an unexpected native route");
  }
  return canonicalJson({ moduleDigestHex: bundleDigestHex, settings, routes, subdomain });
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
  const resolveCredential = async () =>
    await resolveCloudflareCredential(invocation.environment, {
      cloudflareEnvironment: options.cloudflareEnvironment,
      run,
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
    });
  const credential =
    invocation.environment === "integration" &&
    options.state !== undefined &&
    invocation.action === "status"
      ? undefined
      : await resolveCredential();
  const environment = credential?.childEnvironment ?? {};
  // Before any live read or upload: the selected target must compose the
  // Worker the same way the Worker composes itself on its first request.
  await assertTargetComposes("preflight", target);
  if (invocation.action === "status" && target.schemaMaintenanceMode === "pre-v2-0098-quiesced") {
    if (
      invocation.surface !== "takoserver-worker" ||
      invocation.legacyPredecessorVersionId !== undefined ||
      invocation.legacyHostRuntimePredecessorVersionId !== undefined ||
      invocation.reverse === true
    ) {
      throw preflightError("pre-0098 native status does not accept authority or reverse selectors");
    }
    return await observePreV20098HostMaintenance(
      invocation,
      target,
      options.state ??
        new CloudflareState({
          accountId: target.accountId,
          token: credential?.token ?? exactToken(environment),
        }),
      options.fetcher ?? ((input, init) => fetch(input, init)),
      sourceRepositoryRoot,
      run,
      options.providerExecutorQualification,
      options.wranglerPath,
    );
  }
  if (
    invocation.action === "apply" &&
    target.schemaMaintenanceMode === "pre-v2-0098-quiesced" &&
    (invocation.surface !== "takoserver-worker" ||
      invocation.legacyPredecessorVersionId !== undefined ||
      invocation.legacyHostRuntimePredecessorVersionId !== undefined ||
      invocation.reverse === true)
  ) {
    throw preflightError("pre-0098 CPE proof permits only routine Host maintenance publication");
  }
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
  const createCloudflareState = (token: string | undefined): CloudflareState =>
    new CloudflareState({
      accountId: target.accountId,
      token: token ?? exactToken(environment),
      ...(target.environment === "integration" &&
      new URL(target.publicOrigin).hostname.endsWith(".workers.dev")
        ? { workerDomainServiceScope: target.workerName }
        : {}),
    });
  const cloudflareState =
    options.state === undefined ? createCloudflareState(credential?.token) : null;
  const initialState = options.state ?? cloudflareState;
  if (initialState === null) throw preflightError("Worker state is unavailable");
  let state: WorkerState = initialState;
  // Rebuilds only the state this owner built; an injected state keeps its own
  // credential. Each owner gate (here or in a sub-runner) calls it afterwards.
  const refreshStateAfterGate =
    cloudflareState === null
      ? undefined
      : async (): Promise<CloudflareState> =>
          createCloudflareState((await resolveCredential()).token);
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
    if (target.billingConfig !== undefined && invocation.action === "apply") {
      throw preflightError(
        "billing-enabled authority transition requires ordinary Worker migration readback before publication",
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
      {
        ...options,
        cloudflareEnvironment: environment,
        // The transition owns the next gate and rebuilds this state after it.
        ...(refreshStateAfterGate === undefined ? {} : { refreshStateAfterGate }),
      },
    );
    const qualifiedTransition = withProviderExecutorQualification(
      transition,
      providerExecutorBefore,
    );
    if (target.billingConfig !== undefined && invocation.action === "status") {
      return { ...qualifiedTransition, ready: false, billingSchemaReady: false };
    }
    return qualifiedTransition;
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
    const servingTarget =
      target.schemaMaintenanceMode === undefined && target.artifactBlobIoMode === undefined;
    const stripeModeRealmReader = servingTarget
      ? (options.stripeModeRealm ??
        remoteStripeModeRealmReader(inspectionConfig, environment, run, options.wranglerPath))
      : undefined;
    const selectedStripeMode = target.stripeMode ?? "test";
    const stripeModeRealmBefore =
      stripeModeRealmReader === undefined
        ? null
        : await readStripeModeRealmProof(stripeModeRealmReader, selectedStripeMode);
    if (
      invocation.action === "apply" &&
      stripeModeRealmReader !== undefined &&
      stripeModeRealmBefore?.ready !== true
    ) {
      throw preflightError(
        "serving Worker publication requires the selected D1 to have an immutable Stripe mode realm pin",
        stripeModeRealmBefore?.reason ?? "realm proof unavailable",
      );
    }
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
      throw preflightError(
        target.schemaMaintenanceMode === "pre-v2-0098-quiesced"
          ? "Worker maintenance requires its exact audited predecessor schema"
          : "0058 Worker maintenance requires exact applied 0057 and 0058 next",
      );
    }

    if (invocation.action === "status") {
      const moneyServingProbe =
        target.moneyCutoverWriterPolicy === "transaction-fenced-usd-micros-v1" &&
        target.schemaMaintenanceMode === undefined &&
        before.migrations.applied.length === 94 &&
        workerSchemaAllowsPending(target, before.migrations, sourceRepositoryRoot)
          ? await probeMoneyCutoverProductOrFrozen(
              target.publicOrigin,
              options.fetcher ?? ((input, init) => fetch(input, init)),
            )
          : null;
      const moneyServingReady =
        moneyServingProbe === null ||
        !("traffic" in moneyServingProbe && moneyServingProbe.traffic === "money-frozen");
      const advancedFromSelector =
        invocation.legacyPredecessorVersionId !== undefined &&
        before.history.versionId !== invocation.legacyPredecessorVersionId;
      const legacyProfileCurrent = before.legacyPredecessorProfile !== undefined;
      const moneySchemaReady =
        target.schemaMaintenanceMode === undefined &&
        target.artifactBlobIoMode === undefined &&
        workerMoneyUnitSchemaReady(before.migrations, sourceRepositoryRoot);
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
        moneyUnitSchemaReady: moneySchemaReady,
        billingSchemaReady: orgBillingSchemaReady(target, before.migrations.applied),
        ...(moneyServingProbe === null
          ? {}
          : { servingReady: moneyServingReady, probe: moneyServingProbe }),
        ...(stripeModeRealmBefore === null ? {} : { stripeModeRealm: stripeModeRealmBefore }),
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
          moneyServingReady &&
          workerSchemaAllowsPending(target, before.migrations, sourceRepositoryRoot) &&
          (target.artifactBlobIoMode !== undefined || moneySchemaReady) &&
          stripeWebhookSchemaReady(target, before.migrations.applied) &&
          orgBillingSchemaReady(target, before.migrations.applied) &&
          !legacyProfileCurrent &&
          (target.integrationE2eCredentialAuthority === undefined ||
            before.integrationE2eCredentialAuthorityConfigured) &&
          (providerExecutorBefore === null || providerExecutorBefore.ready) &&
          (stripeModeRealmBefore === null || stripeModeRealmBefore.ready) &&
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
    if (target.schemaMaintenanceMode === undefined && target.artifactBlobIoMode === undefined) {
      assertWorkerMoneyUnitSchema(before.migrations, sourceRepositoryRoot, "preflight");
    }
    if (!workerSchemaAllowsPending(target, before.migrations, sourceRepositoryRoot)) {
      throw preflightError(
        "routine Worker publication refuses pending D1 migrations; apply takoserver-d1-schema first",
        JSON.stringify(before.pending),
      );
    }
    assertStripeWebhookSchema(target, before.migrations.applied);
    assertOrgBillingSchema(target, before.migrations.applied);
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
    // The owner gate can outlive a Wrangler OAuth access token (about one hour;
    // Wrangler refreshes only an already expired token). No Cloudflare read or
    // write after the gate reuses a bearer resolved before it.
    if (refreshStateAfterGate !== undefined) state = await refreshStateAfterGate();

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
    if (
      legacyBootstrap &&
      target.schemaMaintenanceMode === undefined &&
      target.artifactBlobIoMode === undefined
    ) {
      const finalMigrations = await migrations.read();
      assertWorkerMoneyUnitSchema(finalMigrations, sourceRepositoryRoot, "preflight");
      if (JSON.stringify(finalMigrations) !== JSON.stringify(before.migrations)) {
        throw preflightError("D1 money-unit schema changed before Worker upload");
      }
    }
    const assertStripeModeRealmUnchanged = async (): Promise<void> => {
      if (stripeModeRealmReader === undefined || stripeModeRealmBefore === null) return;
      const current = await readStripeModeRealmProof(stripeModeRealmReader, selectedStripeMode);
      if (!current.ready || !sameStripeModeRealm(stripeModeRealmBefore, current)) {
        throw preflightError("selected D1 Stripe mode realm proof changed before Worker upload");
      }
    };
    const message = `takoserver-worker:${source.commit}:${bundleDigestHex}`;
    // A Version upload is an external mutation even before traffic moves.
    await assertStripeModeRealmUnchanged();
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
          await assertStripeModeRealmUnchanged();
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
        await assertStripeModeRealmUnchanged();
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
    if (target.schemaMaintenanceMode === undefined && target.artifactBlobIoMode === undefined) {
      assertWorkerMoneyUnitSchema(after.migrations, sourceRepositoryRoot, "verification");
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
          : target.moneyCutoverWriterPolicy === "transaction-fenced-usd-micros-v1" &&
              after.migrations.applied.length === 94
            ? await probeMoneyCutoverProductOrFrozen(
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
      servingReady: !("traffic" in probe),
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
): Promise<FreshV2IntegrationStorageTargetProof | CanonicalV20092IntegrationStorageTargetProof> {
  try {
    const verificationOptions: IntegrationStorageGenerationTargetVerificationOptions = {
      ...options.integrationStorageVerification,
      allowCurrentAuditedSuccessor:
        target.schemaMaintenanceMode === undefined && target.artifactBlobIoMode === undefined,
      run,
      ...(options.cloudflareEnvironment === undefined
        ? {}
        : { cloudflareEnvironment: options.cloudflareEnvironment }),
      migrationDirectory:
        options.integrationStorageVerification?.migrationDirectory ??
        resolve(sourceRepositoryRoot, "migrations"),
      ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
    };
    if (target.takoformV2?.appliedSchemaLineage === "v2-0092") {
      return await verifyCanonicalV20092IntegrationStorageTarget(
        target,
        environment,
        verificationOptions,
      );
    }
    return await verifyFreshV2IntegrationStorageTarget(
      target,
      environment,
      takoformV2StorageLineage(target),
      {
        ...options.integrationStorageVerification,
        allowCurrentAuditedSuccessor:
          target.schemaMaintenanceMode === undefined && target.artifactBlobIoMode === undefined,
        allowMoneyUnitMaintenance:
          target.schemaMaintenanceMode === "pre-wallet-usd-micros-quiesced",
        run,
        ...(options.cloudflareEnvironment === undefined
          ? {}
          : { cloudflareEnvironment: options.cloudflareEnvironment }),
        migrationDirectory:
          options.integrationStorageVerification?.migrationDirectory ??
          resolve(sourceRepositoryRoot, "migrations"),
        ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
      },
    );
  } catch {
    throw phase === "preflight"
      ? preflightError(
          "v2 Worker requires the exact generated integration D1/R2 and its selected origin or current audited schema before publication",
        )
      : verificationError(
          "v2 Worker storage readback no longer proves the generated D1/R2 and its selected origin or current audited schema",
        );
  }
}

function assertFreshV2StorageProofUnchanged(
  phase: "preflight" | "verification",
  before: FreshV2IntegrationStorageTargetProof | CanonicalV20092IntegrationStorageTargetProof,
  after: FreshV2IntegrationStorageTargetProof | CanonicalV20092IntegrationStorageTargetProof,
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
  const injected = input.injected;
  if (injected !== undefined) {
    return {
      read: async (phase) => {
        const observed = await injected.read(phase);
        try {
          // A value round-trip severs aliases to the owner's mutable native readback.
          const value: unknown = JSON.parse(canonicalJson(observed));
          if (!isRecord(value) || !isRecord(value.dependencies)) throw new Error("shape");
          const dependencies = value.dependencies;
          const nullableString = (field: unknown): boolean =>
            field === null || typeof field === "string";
          if (
            typeof value.status !== "string" ||
            !["absent", "ready", "stale", "drift"].includes(value.status) ||
            typeof value.ready !== "boolean" ||
            typeof value.managedExact !== "boolean" ||
            typeof value.routeLess !== "boolean" ||
            typeof value.schemaReady !== "boolean" ||
            typeof dependencies.ready !== "boolean" ||
            typeof dependencies.receiptAuthorityReady !== "boolean" ||
            !nullableString(dependencies.receiptAuthorityVersionId) ||
            typeof dependencies.managedWorkerGatewayReady !== "boolean" ||
            !nullableString(dependencies.managedWorkerGatewayVersionId) ||
            !nullableString(value.versionId) ||
            !nullableString(value.deploymentId) ||
            !nullableString(value.previousVersionId) ||
            !nullableString(value.commit) ||
            !nullableString(value.bundleDigestHex) ||
            !nullableString(value.moduleDigestHex)
          ) {
            throw new Error("shape");
          }
          if (value.maintenance !== undefined) {
            if (!isRecord(value.maintenance)) throw new Error("maintenance");
            const proof = value.maintenance;
            if (
              typeof proof.mode !== "string" ||
              !["pre-v2-0088-quiesced", "pre-v2-0098-quiesced"].includes(proof.mode) ||
              ![
                "accountId",
                "databaseId",
                "databaseName",
                "workerName",
                "activeVersionId",
                "activeDeploymentId",
                "previousVersionId",
                "selectedSourceCommit",
                "selectedModuleDigestHex",
                "observedNonCodeDigestHex",
              ].every((field) => typeof proof[field] === "string") ||
              (proof.mode === "pre-v2-0088-quiesced" &&
                (typeof proof.predecessorSourceCommit !== "string" ||
                  typeof proof.predecessorVersionId !== "string")) ||
              (proof.mode === "pre-v2-0098-quiesced" &&
                (proof.storageLineage !== "v2-0088" ||
                  proof.appliedSchemaLineage !== "v2-0092" ||
                  proof.predecessorSourceCommit !== undefined))
            ) {
              throw new Error("maintenance");
            }
          }
          return value as unknown as ProviderExecutorInspection;
        } catch {
          const message =
            "Cloudflare provider executor qualification is not a value-free inspection";
          throw phase === "preflight" ? preflightError(message) : verificationError(message);
        }
      },
    };
  }
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
      const database = new RemoteD1(configPath, {
        environment,
        run,
        wranglerCommand: (args) => deployWranglerCommand(wranglerPath, args),
      });
      const remote = await readD1SchemaState(database);
      return {
        local: local.names,
        applied: remote.applied,
        shape: remote.shape,
        shapeDigest: remote.shapeDigest,
        ...(moneyUnitSchemaReady(remote.applied)
          ? { moneyUnitPolicy: await readMoneyUnitPolicy(database) }
          : {}),
      };
    },
  };
}

export function remoteStripeModeRealmReader(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: WorkerProcess,
  wranglerPath?: string,
): WorkerStripeModeRealmReader {
  return {
    async read() {
      const database = new RemoteD1(configPath, {
        environment,
        run,
        wranglerCommand: (args) => deployWranglerCommand(wranglerPath, args),
      });
      const schema = await database.query(
        "preflight",
        "Stripe mode realm schema read",
        STRIPE_MODE_REALM_SCHEMA_QUERY,
      );
      // Avoid querying a possibly absent table. Missing schema is already a
      // conclusive refusal and status can report the schema as not ready.
      const schemaRows = schema.map(({ type, name, sql }) => ({ type, name, sql }));
      if (!hasImmutableStripeModeRealmSchema(schemaRows)) return { schema: schemaRows, pins: [] };
      const pins = await database.query(
        "preflight",
        "Stripe mode realm pin read",
        "SELECT mode FROM stripe_mode_realm WHERE singleton = 1",
      );
      return { schema: schemaRows, pins: pins.map(({ mode }) => ({ mode })) };
    },
  };
}

export async function readStripeModeRealmProof(
  reader: WorkerStripeModeRealmReader,
  selectedMode: "test" | "live",
): Promise<StripeModeRealmStatus> {
  return inspectStripeModeRealm(await reader.read(), selectedMode);
}

export function sameStripeModeRealm(
  left: StripeModeRealmStatus,
  right: StripeModeRealmStatus,
): boolean {
  return (
    left.ready === right.ready &&
    left.selectedMode === right.selectedMode &&
    left.pinnedMode === right.pinnedMode &&
    left.reason === right.reason
  );
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
