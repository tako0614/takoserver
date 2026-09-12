/**
 * Curated deploy extension for an owner-private provider composition.
 *
 * This is intentionally a narrow public seam: it exports generic lifecycle,
 * source/artifact and provider-readback primitives, never concrete managed
 * backend implementations, credentials or private configuration writers.
 */

export { CloudflareState } from "./deploy/cloudflare-state.ts";
export { GENERIC_WORKER_DEPLOY_CONTRACT_SURFACES } from "./deploy/contract.ts";
export type { D1Process } from "./deploy/d1.ts";
export { RemoteD1, sqlLiteral } from "./deploy/d1.ts";
export type { DeployPhase } from "./deploy/errors.ts";
export {
  DeployError,
  deployFailureAftermath,
  mutationError,
  PHASE_EXIT_CODE,
  preflightError,
  verificationError,
} from "./deploy/errors.ts";
export type {
  ExactArtifactRecoveryDeployInvocation,
  ExactArtifactRecoveryDeploymentAction,
  ExactArtifactRecoveryDeploymentPlan,
  ExactArtifactRecoveryDeploymentSnapshot,
  ExactArtifactRecoveryDeployOptions,
  ExactArtifactRecoveryDeployRuntime,
} from "./deploy/exact-artifact-recovery.ts";
export {
  planExactArtifactRecoveryDeployment,
  runExactArtifactRecoveryDeployment,
} from "./deploy/exact-artifact-recovery.ts";
export { runIntegrationWorkerBootstrap } from "./deploy/integration-worker-bootstrap.ts";
export type {
  CloudflareCredential,
  CloudflareDeployEnvironment,
  CommandResult,
  DeployProcess,
  DeployProcessContext,
} from "./deploy/process.ts";
export {
  cloudflareChildEnvironment,
  createDeployProcess,
  parseWranglerAuthToken,
  requireEnvironment,
  resolveCloudflareCredential,
  sanitizedChildEnvironment,
} from "./deploy/process.ts";
export type {
  PublicParentTokenRetirementInvocation,
  PublicParentTokenRetirementOptions,
} from "./deploy/public-parent-token-retirement.ts";
export { runPublicParentTokenRetirement } from "./deploy/public-parent-token-retirement.ts";
export type {
  DeployEnvironment,
  QualificationProcess,
  SealedArtifact,
  SourceQualification,
  SourceQualificationPolicy,
} from "./deploy/qualification.ts";
export {
  qualifySource,
  removeArtifactTree,
  sealDirectory,
  unsealDirectory,
} from "./deploy/qualification.ts";
export type {
  DeployTarget,
  ManagedWorkerDispatchNamespaceTarget,
} from "./deploy/target.ts";
export {
  DEPLOY_TARGET_KIND,
  loadManagedWorkerDispatchNamespaceTarget,
  loadTarget,
  parseDeployTarget,
  targetPath,
} from "./deploy/target.ts";
export type {
  ProviderExecutorDependencyInspection,
  ProviderExecutorInspection,
  WorkerInvocation,
  WorkerMigrationReader,
  WorkerOptions,
  WorkerProcess,
  WorkerProviderExecutorQualification,
} from "./deploy/worker.ts";
export {
  assertProviderExecutorUnchanged,
  isWorkerVersionId,
  providerExecutorQualificationReader,
  providerExecutorStatus,
  runWorker,
  withProviderExecutorQualification,
} from "./deploy/worker.ts";
export type {
  PreparedWorkerArtifact,
  WorkerArtifactConfigInput,
  WorkerArtifactConfigWriter,
  WorkerArtifactProcess,
  WorkerDryRunCommand,
} from "./deploy/worker-artifact.ts";
export {
  canonicalizeWorkerBundleSource,
  prepareWorkerArtifact,
} from "./deploy/worker-artifact.ts";
export type {
  WorkerClosureTransitionInvocation,
  WorkerClosureTransitionOptions,
} from "./deploy/worker-closure-transition.ts";
export { runWorkerClosureTransition } from "./deploy/worker-closure-transition.ts";
export type {
  ExpectedBindingClosure,
  WorkerClosureDelta,
  WorkerDeploymentChainEntry,
  WorkerDeploymentHistory,
} from "./deploy/worker-state.ts";
export {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  optionalExactPlainTextBinding,
  parseWorkerDeploymentChain,
  parseWorkerDeploymentHistory,
  parseWorkerSecretInventory,
  readVersionBindings,
} from "./deploy/worker-state.ts";
export type {
  WranglerExistingVersionDeployment,
  WranglerLifecycleDeployment,
  WranglerProcess,
  WranglerVersionPublication,
  WranglerVersionPublicationLease,
  WranglerVersionPublicationLeaseStatus,
} from "./deploy/wrangler-state.ts";
export {
  acquireWranglerVersionPublicationLease,
  deployExistingWranglerVersion,
  deployWranglerLifecycleChange,
  inspectWranglerVersionPublicationLease,
  publishWranglerVersion,
} from "./deploy/wrangler-state.ts";
