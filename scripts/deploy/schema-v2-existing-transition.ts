import { createHash } from "node:crypto";
import { type DeployPhase, preflightError, verificationError } from "./errors.ts";
import type { CommandResult } from "./process.ts";
import type { DeployTarget } from "./target.ts";
import {
  type ProviderExecutorInspection,
  providerExecutorAllowsPublication,
  type WorkerProviderExecutorQualification,
} from "./worker.ts";
import {
  inspectLiveWorkerVersion,
  type WorkerState,
  workerVersionIdentity,
} from "./worker-live.ts";

// Direct parent of the first public v2 entry (7296cdc3); it builds only the
// previous Host path. An ancestor check alone is never native-byte proof.
const PRE_V2_PUBLIC_ENTRY = "af6dd0e6b38a23a075ee47f5d60d4d04173676ff";

export interface V2ExistingMaintenanceWorkerState extends WorkerState {
  workerVersionWithModules(workerName: string, versionId: string): Promise<unknown>;
}

export interface V2ExistingMaintenanceProof {
  readonly publicDeploymentId: string;
  readonly publicVersionId: string;
  readonly publicPredecessorVersionId: string;
  readonly publicPredecessorCommit: string;
  readonly publicModuleDigestHex: string;
  readonly provider: ProviderExecutorInspection;
}

function phaseError(phase: DeployPhase, message: string): Error {
  return phase === "verification" ? verificationError(message) : preflightError(message);
}

/** Full provider module bytes, not a workers/message digest or version title. */
export function exactV2MaintenanceModuleDigest(phase: DeployPhase, value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw phaseError(phase, "0088 Worker native module closure is malformed");
  }
  const version = value as Record<string, unknown>;
  if (
    version.main_module !== "worker.js" ||
    version.resources !== undefined ||
    !Array.isArray(version.modules) ||
    version.modules.length !== 1
  ) {
    throw phaseError(phase, "0088 Worker native module closure is not exact");
  }
  const module = version.modules[0];
  if (typeof module !== "object" || module === null || Array.isArray(module)) {
    throw phaseError(phase, "0088 Worker native module is malformed");
  }
  const entry = module as Record<string, unknown>;
  if (
    Object.keys(entry).sort().join(",") !== "content_base64,content_type,name" ||
    entry.name !== "worker.js" ||
    entry.content_type !== "application/javascript+module" ||
    typeof entry.content_base64 !== "string"
  ) {
    throw phaseError(phase, "0088 Worker native module is malformed");
  }
  const bytes = Buffer.from(entry.content_base64, "base64");
  if (bytes.toString("base64") !== entry.content_base64) {
    throw phaseError(phase, "0088 Worker native module is not canonical base64");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export async function inspectV2ExistingMaintenancePublication(input: {
  readonly phase: "preflight" | "verification";
  readonly target: DeployTarget;
  readonly selectedCommit: string;
  readonly providerExecutorSourceCommit: string;
  readonly selectedBuiltModuleDigestHex: string;
  readonly buildHistorical: (commit: string) => Promise<string>;
  readonly state: V2ExistingMaintenanceWorkerState;
  readonly providerExecutorQualification: WorkerProviderExecutorQualification;
  readonly run: (command: readonly string[]) => Promise<CommandResult>;
}): Promise<V2ExistingMaintenanceProof> {
  const { phase, target, state } = input;
  if (!/^[0-9a-f]{40}$/u.test(input.providerExecutorSourceCommit)) {
    throw phaseError(phase, "0088 private CPE selected source is malformed");
  }
  if (
    target.environment !== "integration" ||
    target.schemaMaintenanceMode !== "pre-v2-0088-quiesced" ||
    target.takoformV2 === undefined ||
    target.cloudflareProviderExecutor === undefined
  ) {
    throw phaseError(phase, "0088 requires the exact integration v2 maintenance target");
  }
  const publicWorker = await inspectLiveWorkerVersion(phase, target, state, {});
  const predecessorVersionId = publicWorker.history.previousVersionId;
  if (
    predecessorVersionId === null ||
    publicWorker.commit !== input.selectedCommit ||
    publicWorker.bundleDigestHex !== input.selectedBuiltModuleDigestHex
  ) {
    throw phaseError(phase, "0088 public maintenance Worker source or predecessor changed");
  }
  const activeDigest = exactV2MaintenanceModuleDigest(
    phase,
    await state.workerVersionWithModules(target.workerName, publicWorker.history.versionId),
  );
  if (activeDigest !== input.selectedBuiltModuleDigestHex) {
    throw phaseError(
      phase,
      "0088 public maintenance Worker native bytes differ from selected build",
    );
  }
  const predecessor = workerVersionIdentity(
    phase,
    await state.workerVersion(target.workerName, predecessorVersionId),
  );
  const predecessorNativeDigest = exactV2MaintenanceModuleDigest(
    phase,
    await state.workerVersionWithModules(target.workerName, predecessorVersionId),
  );
  const ancestor = await input.run([
    "git",
    "merge-base",
    "--is-ancestor",
    predecessor.commit,
    PRE_V2_PUBLIC_ENTRY,
  ]);
  if (ancestor.exitCode !== 0) {
    throw phaseError(phase, "0088 public predecessor is not a proven pre-v2 entry source");
  }
  const historicalBuiltModuleDigestHex = await input.buildHistorical(predecessor.commit);
  if (
    predecessor.bundleDigestHex !== predecessorNativeDigest ||
    predecessorNativeDigest !== historicalBuiltModuleDigestHex
  ) {
    throw phaseError(
      phase,
      "0088 public predecessor native module differs from its historical build",
    );
  }
  const provider = await input.providerExecutorQualification.read(phase);
  if (
    !providerExecutorAllowsPublication(target, provider) ||
    provider.maintenance?.selectedSourceCommit !== input.providerExecutorSourceCommit ||
    provider.maintenance.predecessorSourceCommit === provider.maintenance.selectedSourceCommit
  ) {
    throw phaseError(phase, "0088 private CPE maintenance publication is not exact");
  }
  const after = await inspectLiveWorkerVersion(phase, target, state, {});
  if (
    after.history.deploymentId !== publicWorker.history.deploymentId ||
    after.history.versionId !== publicWorker.history.versionId ||
    after.history.previousVersionId !== predecessorVersionId ||
    after.commit !== publicWorker.commit ||
    after.bundleDigestHex !== publicWorker.bundleDigestHex
  ) {
    throw phaseError(phase, "0088 public maintenance Worker changed during proof");
  }
  return {
    publicDeploymentId: publicWorker.history.deploymentId,
    publicVersionId: publicWorker.history.versionId,
    publicPredecessorVersionId: predecessorVersionId,
    publicPredecessorCommit: predecessor.commit,
    publicModuleDigestHex: activeDigest,
    provider,
  };
}

export function assertSameV2ExistingMaintenanceProof(
  expected: V2ExistingMaintenanceProof,
  actual: V2ExistingMaintenanceProof,
  phase: DeployPhase,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw phaseError(phase, "0088 public Host or private CPE maintenance proof changed");
  }
}
