import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CloudflareTopologyAuditEvidence } from "./cloudflare-topology-audit.ts";
import { preflightError, verificationError } from "./errors.ts";
import type { DeployEnvironment } from "./qualification.ts";
import {
  inspectSponsorshipAuthority,
  type SponsorshipAuthorityDeployState,
} from "./sponsorship-authority.ts";
import {
  type SponsorshipCutoverConsumptionDatabase,
  type SponsorshipCutoverConsumptionRecord,
  sponsorshipCutoverOperationIdentity,
} from "./sponsorship-cutover-consumption.ts";
import type { DeployTarget } from "./target.ts";
import {
  workerVersionAnnotationProfile,
  workerVersionCutoverOperationIdentity,
  workerVersionIdentity,
  workerVersionScriptContentIdentity,
} from "./worker-live.ts";
import { parseWorkerDeploymentHistory } from "./worker-state.ts";

const PROOF_KIND = "takosumi-hosted.sponsorship-authority-cutover-proof@v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?$/u;
const AUTHORITY_BINDING = "TAKOSERVER_SPONSORSHIP_AUTHORITY";
const MAX_PROOF_BYTES = 64 * 1024;
const EXACT_PROOF_TTL_MS = 2 * 60 * 60 * 1_000;
const RECEIPT_TYPE = "takoserver-sponsorship-issuance-receipt+jwt";
const RECEIPT_AUDIENCE = "takosumi-hosted.sponsorship-cutover-proof.v1";

export type SponsorshipCutoverProofStage = "public-route-removal" | "legacy-secret-retirement";

export interface SponsorshipCutoverProofHandle {
  readonly stage: SponsorshipCutoverProofStage;
  readonly proofSha256: string;
}

export interface SponsorshipCutoverProofGate {
  authorize(stage: SponsorshipCutoverProofStage): Promise<SponsorshipCutoverProofHandle>;
  begin(
    handle: SponsorshipCutoverProofHandle,
    candidate: SponsorshipCutoverCandidateIdentity,
  ): Promise<SponsorshipCutoverStartAdmission>;
  complete(handle: SponsorshipCutoverProofHandle, versionId: string): Promise<void>;
  settle(stage: SponsorshipCutoverProofStage, versionId: string): Promise<string | undefined>;
}

export interface SponsorshipCutoverStartedOperation {
  readonly operationId: `sha256:${string}`;
  readonly candidateIdentitySha256: string;
}

export interface SponsorshipCutoverExecutionClaim {
  /** Crosses the provider boundary at most once in this owner process. */
  execute<T>(mutation: () => Promise<T>): Promise<T>;
}

export type SponsorshipCutoverStartAdmission = SponsorshipCutoverStartedOperation &
  (
    | {
        readonly fresh: true;
        readonly executionClaim: SponsorshipCutoverExecutionClaim;
      }
    | {
        readonly fresh: false;
      }
  );

export interface SponsorshipCutoverCandidateIdentity {
  readonly sourceCommit: string;
  readonly bundleSha256: string;
  readonly configSha256: string;
}

export interface SponsorshipCutoverProofState extends SponsorshipAuthorityDeployState {
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerTopologyAudit(): Promise<CloudflareTopologyAuditEvidence>;
}

export function sponsorshipCutoverProofConfigured(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return [
    "TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH",
    "TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256",
  ].every((name) => {
    const value = environment[name];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Build the only retirement proof gate. It revalidates both live Worker
 * Versions and the service binding at authorization and again immediately
 * before the provider mutation. Append-only receipts in the target STATE_DB
 * make each proof single-use per irreversible phase across machines/checkouts.
 */
export function createSponsorshipCutoverProofGate(input: {
  readonly target: DeployTarget;
  readonly environment: DeployEnvironment;
  readonly state: SponsorshipCutoverProofState;
  readonly database: SponsorshipCutoverConsumptionDatabase;
  readonly variables?: Readonly<Record<string, string | undefined>>;
  readonly clock?: () => Date;
}): SponsorshipCutoverProofGate {
  const variables = input.variables ?? process.env;
  const proofPath = privatePath(variables.TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH, "proof path");
  const confirmedProofSha256 = variables.TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256;
  if (!confirmedProofSha256 || !SHA256.test(confirmedProofSha256)) {
    throw preflightError("sponsorship cutover proof digest is required");
  }
  const proofBytes = readPrivateProof(proofPath);
  const proofSha256 = sha256(proofBytes);
  if (proofSha256 !== confirmedProofSha256) {
    throw preflightError("sponsorship cutover proof digest does not match the private artifact");
  }
  const proof = parseProof(proofBytes);
  const clock = input.clock ?? (() => new Date());
  const consumptionEnvironment = input.environment;
  if (consumptionEnvironment !== "integration" && consumptionEnvironment !== "production") {
    throw preflightError("sponsorship cutover proof consumption is unavailable in rehearsal");
  }
  const targetSha256 = sha256Text(
    canonicalJson({
      accountId: input.target.accountId,
      databaseId: input.target.d1.databaseId,
      environment: input.environment,
      workerName: input.target.workerName,
    }),
  );

  const validateCurrent = async (): Promise<void> => {
    validateProofSemantics(proof, input.target, input.environment, clock());
    await verifyProofReceipt(proof, input.target);
    await assertCurrentWorkerIdentities(proof, input.target, input.state);
  };

  const readConsumption = (stage: SponsorshipCutoverProofStage) =>
    input.database.read(
      { targetSha256, environment: input.environment, stage, proofSha256 },
      "preflight",
    );

  const authorize = async (
    stage: SponsorshipCutoverProofStage,
    allowStarted = false,
  ): Promise<SponsorshipCutoverProofHandle> => {
    await validateCurrent();
    const publicWorker = await inspectPublicWorker(input.target, input.state);
    const record = await readConsumption(stage);
    if (record?.completion) {
      throw preflightError(`sponsorship cutover proof was already consumed for ${stage}`);
    }
    if (!allowStarted && record) {
      throw preflightError(
        `sponsorship cutover proof consumption for ${stage} is indeterminate; reconcile with status`,
      );
    }
    if (stage === "public-route-removal") {
      assertProofPredecessor(proof, publicWorker);
    } else {
      const routeVersionId = publicWorker.previousVersionId;
      if (routeVersionId === null) {
        throw preflightError(
          "legacy sponsorship secret retirement requires the exact topology-only successor of completed route removal",
        );
      }
      const routeVersion = await input.state.workerVersion(input.target.workerName, routeVersionId);
      const routeOperationId =
        workerVersionAnnotationProfile(routeVersion) === "canonical"
          ? workerVersionCutoverOperationIdentity("preflight", routeVersion)
          : null;
      const route =
        routeOperationId === null
          ? null
          : await input.database.readByOperationId(routeOperationId, "preflight");
      if (
        !route?.completion ||
        route.start.targetSha256 !== targetSha256 ||
        route.start.environment !== consumptionEnvironment ||
        route.start.stage !== "public-route-removal" ||
        route.start.operationId !== routeOperationId ||
        publicWorker.provenance !== "canonical-upload" ||
        publicWorker.cutoverOperationId !== null ||
        publicWorker.previousVersionId !== route.completion.successorVersionId ||
        publicWorker.deploymentId === route.completion.successorDeploymentId ||
        publicWorker.commit !== route.start.sourceCommit ||
        publicWorker.bundleSha256 !== route.start.bundleSha256 ||
        publicWorker.topologySha256 !== route.start.predecessorTopologySha256
      ) {
        throw preflightError(
          "legacy sponsorship secret retirement requires the exact topology-only successor of completed route removal",
        );
      }
      // After a reversal, a later proof must authorize the replacement route
      // operation. An older proof cannot borrow that newer operation as its
      // ordering witness. A proof different from the route operation's proof
      // is accepted only when it was freshly captured against the exact live
      // topology-only successor (for example after the original proof expires).
      if (route.start.proofSha256 !== proofSha256) {
        assertProofPredecessor(proof, publicWorker);
      }
      if (
        workerVersionAnnotationProfile(routeVersion) !== "canonical" ||
        workerVersionCutoverOperationIdentity("preflight", routeVersion) !==
          route.start.operationId ||
        workerVersionIdentity("preflight", routeVersion).commit !== route.start.sourceCommit ||
        `sha256:${workerVersionIdentity("preflight", routeVersion).bundleDigestHex}` !==
          route.start.bundleSha256 ||
        sha256Text(
          workerVersionScriptContentIdentity(
            "preflight",
            route.completion.successorVersionId,
            routeVersion,
          ),
        ) !== publicWorker.scriptEtagSha256
      ) {
        throw preflightError(
          "legacy sponsorship secret retirement cannot prove the completed route-removal lineage",
        );
      }
    }
    return { stage, proofSha256 };
  };

  return {
    // An existing durable start is visible for status reconciliation only.
    // Only the process whose insert was acknowledged and read back receives a
    // one-use execution capability from begin().
    authorize: (stage) => authorize(stage, true),
    async begin(handle, candidate) {
      exactHandle(handle, proofSha256);
      await authorize(handle.stage, true);
      const publicWorker = await inspectPublicWorker(input.target, input.state);
      validateCandidate(candidate);
      const base = {
        targetSha256,
        environment: consumptionEnvironment,
        stage: handle.stage,
        proofSha256,
        predecessorDeploymentId: publicWorker.deploymentId,
        predecessorVersionId: publicWorker.versionId,
        predecessorTopologySha256: publicWorker.topologySha256,
        sourceCommit: candidate.sourceCommit,
        bundleSha256: candidate.bundleSha256,
        configSha256: candidate.configSha256,
      };
      const identity = sponsorshipCutoverOperationIdentity(base);
      const existing = await readConsumption(handle.stage);
      if (existing) {
        if (
          existing.completion !== null ||
          existing.start.operationId !== identity.operationId ||
          existing.start.candidateIdentitySha256 !== identity.candidateIdentitySha256
        ) {
          throw preflightError(
            `sponsorship cutover proof for ${handle.stage} was started for a different candidate or predecessor`,
          );
        }
        return { ...identity, fresh: false };
      }
      const admission = await input.database.begin({
        ...base,
        ...identity,
        startedAt: exactNow(clock()).toISOString(),
      });
      const recorded = await readConsumption(handle.stage);
      if (
        !recorded ||
        recorded.completion !== null ||
        recorded.start.operationId !== identity.operationId ||
        recorded.start.candidateIdentitySha256 !== identity.candidateIdentitySha256
      ) {
        throw preflightError("sponsorship cutover start receipt readback failed");
      }
      if (admission === "existing") {
        return { ...identity, fresh: false };
      }
      return {
        ...identity,
        fresh: true,
        executionClaim: oneUseExecutionClaim(handle.stage),
      };
    },
    async complete(handle, versionId) {
      exactHandle(handle, proofSha256);
      if (!VERSION_ID.test(versionId)) {
        throw verificationError("sponsorship cutover proof completion state is invalid");
      }
      await settleStarted(handle.stage, versionId, "verification");
    },
    async settle(stage, versionId) {
      if (!VERSION_ID.test(versionId)) {
        throw preflightError("sponsorship cutover reconciliation Version is invalid");
      }
      const record = await readConsumption(stage);
      if (!record) return undefined;
      if (record.completion) {
        await assertExactSuccessor(stage, record, versionId, "preflight", true);
        return proofSha256;
      }
      await settleStarted(stage, versionId, "preflight");
      return proofSha256;
    },
  };

  async function settleStarted(
    stage: SponsorshipCutoverProofStage,
    versionId: string,
    phase: "preflight" | "verification",
  ): Promise<void> {
    const record = await readConsumption(stage);
    if (!record || record.completion) {
      throw phase === "verification"
        ? verificationError("sponsorship cutover start receipt is unavailable")
        : preflightError("sponsorship cutover start receipt is unavailable");
    }
    // Reconciliation may happen after the short-lived proof expires. The
    // append-only start is the authorization boundary: re-check that the proof
    // was valid at its recorded start and that its authority receipt is still
    // authentic, then settle only the exact live successor below.
    validateProofSemantics(
      proof,
      input.target,
      input.environment,
      new Date(record.start.startedAt),
    );
    await verifyProofReceipt(proof, input.target);
    const current = await assertExactSuccessor(stage, record, versionId, phase, false);
    await input.database.complete({
      operationId: record.start.operationId,
      successorDeploymentId: current.deploymentId,
      successorVersionId: current.versionId,
      completedAt: exactNow(clock()).toISOString(),
    });
    const completed = await readConsumption(stage);
    if (
      !completed?.completion ||
      completed.completion.operationId !== record.start.operationId ||
      completed.completion.successorVersionId !== current.versionId ||
      completed.completion.successorDeploymentId !== current.deploymentId
    ) {
      throw phase === "verification"
        ? verificationError("sponsorship cutover completion receipt readback failed")
        : preflightError("sponsorship cutover completion receipt readback failed");
    }
  }

  async function assertExactSuccessor(
    stage: SponsorshipCutoverProofStage,
    record: SponsorshipCutoverConsumptionRecord,
    versionId: string,
    phase: "preflight" | "verification",
    completed: boolean,
  ): Promise<PublicWorkerInspection> {
    const current = await inspectPublicWorker(input.target, input.state);
    if (
      current.versionId !== versionId ||
      current.previousVersionId !== record.start.predecessorVersionId ||
      current.commit !== record.start.sourceCommit ||
      current.bundleSha256 !== record.start.bundleSha256 ||
      current.topologySha256 !== record.start.predecessorTopologySha256 ||
      current.deploymentId === record.start.predecessorDeploymentId
    ) {
      throw phase === "verification"
        ? verificationError(
            `sponsorship cutover successor differs from the exact ${completed ? "completed successor" : "started operation"}`,
          )
        : preflightError(
            `sponsorship cutover successor differs from the exact ${completed ? "completed successor" : "started operation"}`,
          );
    }
    if (
      completed &&
      (record.completion === null ||
        current.deploymentId !== record.completion.successorDeploymentId ||
        current.versionId !== record.completion.successorVersionId)
    ) {
      throw phase === "verification"
        ? verificationError(
            "sponsorship cutover successor differs from the exact completed successor",
          )
        : preflightError(
            "sponsorship cutover successor differs from the exact completed successor",
          );
    }
    if (
      (stage === "public-route-removal" &&
        (current.provenance !== "canonical-upload" ||
          current.cutoverOperationId !== record.start.operationId)) ||
      (stage === "legacy-secret-retirement" &&
        (current.provenance !== "secret-created-direct-successor" ||
          current.cutoverOperationId !== null))
    ) {
      throw phase === "verification"
        ? verificationError("sponsorship cutover successor lacks the exact operation identity")
        : preflightError("sponsorship cutover successor lacks the exact operation identity");
    }
    return current;
  }
}

function oneUseExecutionClaim(
  stage: SponsorshipCutoverProofStage,
): SponsorshipCutoverExecutionClaim {
  let consumed = false;
  return {
    async execute<T>(mutation: () => Promise<T>): Promise<T> {
      if (consumed) {
        throw preflightError(
          `sponsorship cutover execution claim for ${stage} was already consumed`,
        );
      }
      consumed = true;
      return await mutation();
    },
  };
}

export interface PublicWorkerInspection {
  readonly workerName: string;
  readonly deploymentId: string;
  readonly versionId: string;
  readonly previousVersionId: string | null;
  readonly commit: string;
  readonly bundleSha256: `sha256:${string}`;
  readonly scriptEtagSha256: `sha256:${string}`;
  readonly cutoverOperationId: `sha256:${string}` | null;
  readonly provenance: "canonical-upload" | "secret-created-direct-successor";
  readonly publicTopology: PublicWorkerTopology;
  readonly topologySha256: `sha256:${string}`;
}

export interface PublicWorkerTopology {
  readonly workersDevEnabled: boolean;
  readonly previewsEnabled: boolean;
  readonly customDomainCount: number;
  readonly customDomainSetSha256: `sha256:${string}`;
  readonly routeCount: number;
  readonly routeSetSha256: `sha256:${string}`;
  readonly deploymentTokenIdSha256: `sha256:${string}`;
  readonly deploymentTokenPolicySha256: `sha256:${string}`;
  readonly allZoneResourceSha256: `sha256:${string}`;
}

/** Exact live predecessor/successor identity shared by status proof and CAS settlement. */
export async function inspectSponsorshipCutoverPublicWorker(
  target: DeployTarget,
  state: SponsorshipCutoverProofState,
): Promise<PublicWorkerInspection> {
  return await inspectPublicWorker(target, state);
}

async function inspectPublicWorker(
  target: DeployTarget,
  state: SponsorshipCutoverProofState,
): Promise<PublicWorkerInspection> {
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(target.workerName),
    "preflight",
  );
  if (history === null) throw preflightError("public Worker has no authoritative deployment");
  const version = await state.workerVersion(target.workerName, history.versionId);
  const annotation = workerVersionAnnotationProfile(version);
  let identity: { readonly commit: string; readonly bundleDigestHex: string };
  let cutoverOperationId: `sha256:${string}` | null = null;
  let provenance: PublicWorkerInspection["provenance"];
  const scriptEtag = workerVersionScriptContentIdentity("preflight", history.versionId, version);
  if (annotation === "canonical") {
    identity = workerVersionIdentity("preflight", version);
    cutoverOperationId = workerVersionCutoverOperationIdentity("preflight", version);
    provenance = "canonical-upload";
  } else if (annotation === "secret-created" && history.previousVersionId !== null) {
    const predecessor = await state.workerVersion(target.workerName, history.previousVersionId);
    if (
      workerVersionAnnotationProfile(predecessor) !== "canonical" ||
      workerVersionScriptContentIdentity("preflight", history.previousVersionId, predecessor) !==
        scriptEtag
    ) {
      throw preflightError("public Worker secret successor lacks an exact canonical predecessor");
    }
    identity = workerVersionIdentity("preflight", predecessor);
    provenance = "secret-created-direct-successor";
  } else {
    throw preflightError("public Worker has no exact source and bundle identity");
  }

  const audit = await state.workerTopologyAudit();
  const domains = (await state.workerDomains())
    .filter(({ service }) => service === target.workerName)
    .map(({ hostname }) => ({ hostname }))
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
  const routes = (await state.workerRoutes())
    .filter(({ script }) => script === target.workerName)
    .map(({ zoneId, id, pattern }) => ({ id, pattern, zoneId }))
    .sort((left, right) =>
      `${left.zoneId}\0${left.id}\0${left.pattern}`.localeCompare(
        `${right.zoneId}\0${right.id}\0${right.pattern}`,
      ),
    );
  const subdomain = await state.workerSubdomain(target.workerName);
  const publicTopology: PublicWorkerTopology = {
    workersDevEnabled: subdomain.enabled,
    previewsEnabled: subdomain.previewsEnabled,
    customDomainCount: domains.length,
    customDomainSetSha256: sha256Text(canonicalJson(domains)),
    routeCount: routes.length,
    routeSetSha256: sha256Text(canonicalJson(routes)),
    ...audit,
  };
  return {
    workerName: target.workerName,
    deploymentId: history.deploymentId,
    versionId: history.versionId,
    previousVersionId: history.previousVersionId,
    commit: identity.commit,
    bundleSha256: `sha256:${identity.bundleDigestHex}`,
    scriptEtagSha256: sha256Text(scriptEtag),
    cutoverOperationId,
    provenance,
    publicTopology,
    topologySha256: sha256Text(canonicalJson(publicTopology)),
  };
}

function assertProofPredecessor(proof: CutoverProof, current: PublicWorkerInspection): void {
  const expected = proof.publicWorkerPredecessor;
  if (
    current.provenance !== "canonical-upload" ||
    current.workerName !== expected.workerName ||
    current.deploymentId !== expected.deploymentId ||
    current.versionId !== expected.versionId ||
    current.previousVersionId !== expected.previousVersionId ||
    current.commit !== expected.sourceCommit ||
    current.bundleSha256 !== expected.artifactSha256 ||
    current.scriptEtagSha256 !== expected.scriptEtagSha256 ||
    current.cutoverOperationId !== expected.cutoverOperationId ||
    current.topologySha256 !== expected.topologySha256 ||
    canonicalJson(current.publicTopology) !== canonicalJson(expected.publicTopology)
  ) {
    throw preflightError("public Worker predecessor no longer matches the cutover proof");
  }
}

function validateCandidate(value: SponsorshipCutoverCandidateIdentity): void {
  if (
    !COMMIT.test(value.sourceCommit) ||
    !SHA256.test(value.bundleSha256) ||
    !SHA256.test(value.configSha256)
  ) {
    throw preflightError("sponsorship cutover candidate identity is invalid");
  }
}

async function assertCurrentWorkerIdentities(
  proof: CutoverProof,
  target: DeployTarget,
  state: SponsorshipCutoverProofState,
): Promise<void> {
  const authority = await inspectSponsorshipAuthority("preflight", target, state);
  if (
    authority === null ||
    authority.history.versionId !== proof.authority.versionId ||
    authority.commit !== proof.authority.sourceCommit ||
    authority.artifactDigest !== proof.authority.artifactSha256 ||
    sha256Text(authority.scriptEtag) !== proof.authority.scriptEtagSha256
  ) {
    throw preflightError("sponsorship authority no longer matches the cutover proof");
  }

  const hostedHistory = parseWorkerDeploymentHistory(
    await state.workerDeployments(proof.hosted.workerName),
    "preflight",
  );
  if (hostedHistory?.versionId !== proof.hosted.versionId) {
    throw preflightError("Hosted serving Version no longer matches the cutover proof");
  }
  const hostedVersion = await state.workerVersion(proof.hosted.workerName, proof.hosted.versionId);
  assertHostedVersion(proof, hostedVersion);
  const domains = (await state.workerDomains()).filter(
    ({ service }) => service === proof.hosted.workerName,
  );
  const routes = (await state.workerRoutes()).filter(
    ({ script }) => script === proof.hosted.workerName,
  );
  const subdomain = await state.workerSubdomain(proof.hosted.workerName);
  if (
    domains.length !== 0 ||
    routes.length !== 0 ||
    subdomain.enabled ||
    subdomain.previewsEnabled
  ) {
    throw preflightError("Hosted public topology no longer matches the cutover proof");
  }
}

function assertHostedVersion(proof: CutoverProof, value: unknown): void {
  const version = record(value, "Hosted Version readback is malformed");
  const annotations = record(version.annotations, "Hosted Version annotations are malformed");
  const resources = record(version.resources, "Hosted Version resources are malformed");
  const expectedMessage = new RegExp(
    `^takosumi-hosted-worker:${proof.hosted.sourceCommit}:${proof.hosted.artifactSha256.slice(7)}:[0-9a-f]{64}:[0-9a-f]{64}$`,
    "u",
  );
  if (
    typeof annotations["workers/message"] !== "string" ||
    !expectedMessage.test(annotations["workers/message"] as string) ||
    annotations["workers/tag"] !== `source-${proof.hosted.sourceCommit.slice(0, 16)}` ||
    annotations["workers/triggered_by"] !== "version_upload" ||
    !Array.isArray(resources.bindings)
  ) {
    throw preflightError("Hosted Version source identity no longer matches the cutover proof");
  }
  const bindings = resources.bindings.map(bindingEvidence);
  const names = bindings.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw preflightError("Hosted Version binding inventory contains duplicates");
  }
  const authorityBindings = bindings.filter(
    ({ name, type }) => name === AUTHORITY_BINDING && type === "service",
  );
  if (
    authorityBindings.length !== 1 ||
    authorityBindings[0]?.resourceSha256 !== proof.hosted.authorityServiceBinding.serviceSha256 ||
    sha256Text(canonicalJson(sortedBindings(bindings))) !== proof.hosted.providerBindingSetSha256
  ) {
    throw preflightError("Hosted authority service binding no longer matches the cutover proof");
  }
  // Pin the strong immutable-script identity as part of the current Version
  // read, even though Hosted's release artifact hash is independently bound by
  // its exact annotation and release evidence.
  workerVersionScriptContentIdentity("preflight", proof.hosted.versionId, value);
}

interface BindingEvidence {
  readonly name: string;
  readonly type: string;
  readonly resourceSha256?: string;
  readonly valueSha256?: string;
}

function bindingEvidence(value: unknown): BindingEvidence {
  const binding = record(value, "Hosted Version binding is malformed");
  if (
    typeof binding.name !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(binding.name) ||
    typeof binding.type !== "string"
  ) {
    throw preflightError("Hosted Version binding is malformed");
  }
  if (binding.type === "secret_text") return { name: binding.name, type: binding.type };
  if (binding.type === "d1") {
    if (typeof binding.database_id !== "string" || !VERSION_ID.test(binding.database_id)) {
      throw preflightError("Hosted Version D1 binding is malformed");
    }
    return {
      name: binding.name,
      type: binding.type,
      resourceSha256: sha256Text(binding.database_id),
    };
  }
  if (binding.type === "service") {
    if (
      typeof binding.service !== "string" ||
      !WORKER_NAME.test(binding.service) ||
      binding.environment !== undefined ||
      binding.entrypoint !== undefined
    ) {
      throw preflightError("Hosted Version service binding is malformed");
    }
    return { name: binding.name, type: binding.type, resourceSha256: sha256Text(binding.service) };
  }
  if (binding.type === "plain_text") {
    if (typeof binding.text !== "string") {
      throw preflightError("Hosted Version text binding is malformed");
    }
    return { name: binding.name, type: binding.type, valueSha256: sha256Text(binding.text) };
  }
  return { name: binding.name, type: binding.type };
}

interface CutoverProof {
  readonly environment: "staging";
  readonly completedAt: string;
  readonly expiresAt: string;
  readonly authority: {
    readonly environment: DeployEnvironment;
    readonly workerName: string;
    readonly sourceCommit: string;
    readonly versionId: string;
    readonly artifactSha256: string;
    readonly scriptEtagSha256: string;
    readonly credentialKeyIdSha256: string;
    readonly credentialPublicJwkSha256: string;
    readonly receiptKeyIdSha256: string;
    readonly receiptPublicJwkSha256: string;
  };
  readonly hosted: {
    readonly workerName: string;
    readonly sourceCommit: string;
    readonly versionId: string;
    readonly artifactSha256: string;
    readonly providerBindingSetSha256: string;
    readonly authorityServiceBinding: {
      readonly name: typeof AUTHORITY_BINDING;
      readonly serviceSha256: string;
      readonly entrypoint: "default";
    };
    readonly configSha256: string;
    readonly evidenceSha256: string;
    readonly publicTopology: {
      readonly workersDevEnabled: false;
      readonly previewsEnabled: false;
      readonly routeCount: 0;
      readonly customDomainCount: 0;
      readonly deploymentTokenIdSha256: string;
      readonly deploymentTokenPolicySha256: string;
      readonly allZoneResourceSha256: string;
    };
  };
  readonly publicWorkerPredecessor: {
    readonly workerName: string;
    readonly deploymentId: string;
    readonly versionId: string;
    readonly previousVersionId: string | null;
    readonly sourceCommit: string;
    readonly artifactSha256: string;
    readonly scriptEtagSha256: string;
    readonly cutoverOperationId: string | null;
    readonly topologySha256: string;
    readonly publicTopology: PublicWorkerTopology;
    readonly evidenceSha256: string;
  };
  readonly issuance: {
    readonly authorityReceipt: {
      readonly jws: string;
      readonly sha256: string;
      readonly issuanceOperationId: string;
      readonly requestSha256: string;
      readonly requestNonceSha256: string;
      readonly recordedAt: string;
    };
    readonly exchange: {
      readonly authKind: "run-credential";
      readonly audience: "takosumi-hosted.takoform.v1";
      readonly scopes: readonly ["takoform.run"];
      readonly phase: "apply";
      readonly lifecycleIntent: "provision";
      readonly subjectSha256: string;
      readonly workspaceIdSha256: string;
      readonly capsuleIdSha256: string;
      readonly installingPrincipalIdSha256: string;
      readonly runRefSha256: string;
      readonly providerSource: "registry.terraform.io/tako0614/takoform";
      readonly requiredAvailableMinor: number;
      readonly status: 200;
      readonly capturedAt: string;
      readonly transcriptSha256: string;
    };
    readonly credential: {
      readonly alg: "EdDSA";
      readonly typ: "takoserver-token+jwt";
      readonly keyIdSha256: string;
      readonly issuerSha256: string;
      readonly audience: "takoform.run";
      readonly mode: "tenant-run";
      readonly organizationIdSha256: string;
      readonly tenantRefSha256: string;
      readonly spaceRefSha256: string;
      readonly runRefSha256: string;
      readonly reservationRefSha256: string | null;
      readonly tokenSha256: string;
      readonly issuedAt: string;
      readonly expiresAt: string;
      readonly lifetimeSeconds: number;
    };
    readonly readback: {
      readonly method: "GET";
      readonly routeTemplate: "/apis/forms.takoform.com/v1/forms?space={spaceRef}";
      readonly status: 200;
      readonly mediaType: "application/json";
      readonly semantic: "takoform-form-list";
      readonly verifiedAt: string;
      readonly responseSha256: string;
    };
  };
  readonly confirmation: string;
}

function parseProof(bytes: Uint8Array): CutoverProof {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw preflightError("sponsorship cutover proof is invalid JSON");
  }
  const proof = exact(parsed, [
    "authority",
    "completedAt",
    "confirmation",
    "environment",
    "expiresAt",
    "hosted",
    "issuance",
    "kind",
    "publicWorkerPredecessor",
  ]);
  const authority = exact(proof.authority, [
    "artifactSha256",
    "credentialKeyIdSha256",
    "credentialPublicJwkSha256",
    "environment",
    "evidenceSha256",
    "scriptEtagSha256",
    "receiptKeyIdSha256",
    "receiptPublicJwkSha256",
    "sourceCommit",
    "versionId",
    "workerName",
  ]);
  const hosted = exact(proof.hosted, [
    "artifactSha256",
    "authorityServiceBinding",
    "configSha256",
    "evidenceSha256",
    "providerBindingSetSha256",
    "publicTopology",
    "sourceCommit",
    "versionId",
    "workerName",
  ]);
  const service = exact(hosted.authorityServiceBinding, ["entrypoint", "name", "serviceSha256"]);
  const topology = exact(hosted.publicTopology, [
    "allZoneResourceSha256",
    "customDomainCount",
    "deploymentTokenIdSha256",
    "deploymentTokenPolicySha256",
    "previewsEnabled",
    "routeCount",
    "workersDevEnabled",
  ]);
  const publicWorker = exact(proof.publicWorkerPredecessor, [
    "artifactSha256",
    "cutoverOperationId",
    "deploymentId",
    "evidenceSha256",
    "previousVersionId",
    "publicTopology",
    "scriptEtagSha256",
    "sourceCommit",
    "topologySha256",
    "versionId",
    "workerName",
  ]);
  const publicTopology = exact(publicWorker.publicTopology, [
    "allZoneResourceSha256",
    "customDomainCount",
    "customDomainSetSha256",
    "deploymentTokenIdSha256",
    "deploymentTokenPolicySha256",
    "previewsEnabled",
    "routeCount",
    "routeSetSha256",
    "workersDevEnabled",
  ]);
  const issuance = exact(proof.issuance, [
    "authorityReceipt",
    "credential",
    "exchange",
    "readback",
  ]);
  const authorityReceipt = exact(issuance.authorityReceipt, [
    "issuanceOperationId",
    "jws",
    "recordedAt",
    "requestNonceSha256",
    "requestSha256",
    "sha256",
  ]);
  const exchange = exact(issuance.exchange, [
    "audience",
    "authKind",
    "capsuleIdSha256",
    "capturedAt",
    "installingPrincipalIdSha256",
    "lifecycleIntent",
    "phase",
    "providerSource",
    "requiredAvailableMinor",
    "runRefSha256",
    "scopes",
    "status",
    "subjectSha256",
    "transcriptSha256",
    "workspaceIdSha256",
  ]);
  const credential = exact(issuance.credential, [
    "alg",
    "audience",
    "expiresAt",
    "issuedAt",
    "issuerSha256",
    "keyIdSha256",
    "lifetimeSeconds",
    "mode",
    "organizationIdSha256",
    "reservationRefSha256",
    "runRefSha256",
    "spaceRefSha256",
    "tenantRefSha256",
    "tokenSha256",
    "typ",
  ]);
  const readback = exact(issuance.readback, [
    "mediaType",
    "method",
    "responseSha256",
    "routeTemplate",
    "semantic",
    "status",
    "verifiedAt",
  ]);
  const { confirmation, ...subject } = proof;
  if (
    proof.kind !== PROOF_KIND ||
    proof.environment !== "staging" ||
    !SHA256.test(String(confirmation)) ||
    sha256Text(canonicalJson(subject)) !== confirmation ||
    !isEnvironment(authority.environment) ||
    !WORKER_NAME.test(String(authority.workerName)) ||
    !COMMIT.test(String(authority.sourceCommit)) ||
    !VERSION_ID.test(String(authority.versionId)) ||
    !digests(authority.artifactSha256, authority.scriptEtagSha256, authority.evidenceSha256) ||
    !digests(
      authority.credentialKeyIdSha256,
      authority.credentialPublicJwkSha256,
      authority.receiptKeyIdSha256,
      authority.receiptPublicJwkSha256,
    ) ||
    !WORKER_NAME.test(String(hosted.workerName)) ||
    !COMMIT.test(String(hosted.sourceCommit)) ||
    !VERSION_ID.test(String(hosted.versionId)) ||
    !digests(
      hosted.artifactSha256,
      hosted.configSha256,
      hosted.evidenceSha256,
      hosted.providerBindingSetSha256,
    ) ||
    service.name !== AUTHORITY_BINDING ||
    service.entrypoint !== "default" ||
    !SHA256.test(String(service.serviceSha256)) ||
    topology.workersDevEnabled !== false ||
    topology.previewsEnabled !== false ||
    topology.routeCount !== 0 ||
    topology.customDomainCount !== 0 ||
    !digests(
      topology.deploymentTokenIdSha256,
      topology.deploymentTokenPolicySha256,
      topology.allZoneResourceSha256,
    ) ||
    !WORKER_NAME.test(String(publicWorker.workerName)) ||
    !nonempty(publicWorker.deploymentId, 512) ||
    !VERSION_ID.test(String(publicWorker.versionId)) ||
    (publicWorker.previousVersionId !== null &&
      !VERSION_ID.test(String(publicWorker.previousVersionId))) ||
    !COMMIT.test(String(publicWorker.sourceCommit)) ||
    !digests(
      publicWorker.artifactSha256,
      publicWorker.scriptEtagSha256,
      publicWorker.topologySha256,
      publicWorker.evidenceSha256,
      publicTopology.customDomainSetSha256,
      publicTopology.routeSetSha256,
      publicTopology.deploymentTokenIdSha256,
      publicTopology.deploymentTokenPolicySha256,
      publicTopology.allZoneResourceSha256,
    ) ||
    (publicWorker.cutoverOperationId !== null &&
      !SHA256.test(String(publicWorker.cutoverOperationId))) ||
    typeof publicTopology.workersDevEnabled !== "boolean" ||
    typeof publicTopology.previewsEnabled !== "boolean" ||
    !nonnegativeInteger(publicTopology.customDomainCount) ||
    !nonnegativeInteger(publicTopology.routeCount) ||
    sha256Text(canonicalJson(publicTopology)) !== publicWorker.topologySha256 ||
    exchange.authKind !== "run-credential" ||
    exchange.audience !== "takosumi-hosted.takoform.v1" ||
    JSON.stringify(exchange.scopes) !== JSON.stringify(["takoform.run"]) ||
    exchange.phase !== "apply" ||
    exchange.lifecycleIntent !== "provision" ||
    exchange.providerSource !== "registry.terraform.io/tako0614/takoform" ||
    exchange.status !== 200 ||
    !Number.isSafeInteger(exchange.requiredAvailableMinor) ||
    (exchange.requiredAvailableMinor as number) < 0 ||
    !digests(
      exchange.subjectSha256,
      exchange.workspaceIdSha256,
      exchange.capsuleIdSha256,
      exchange.installingPrincipalIdSha256,
      exchange.runRefSha256,
      exchange.transcriptSha256,
    ) ||
    typeof authorityReceipt.jws !== "string" ||
    authorityReceipt.jws.length < 16 ||
    authorityReceipt.jws.length > 16_384 ||
    !digests(
      authorityReceipt.sha256,
      authorityReceipt.issuanceOperationId,
      authorityReceipt.requestSha256,
      authorityReceipt.requestNonceSha256,
    ) ||
    sha256Text(authorityReceipt.jws) !== authorityReceipt.sha256 ||
    credential.alg !== "EdDSA" ||
    credential.typ !== "takoserver-token+jwt" ||
    credential.audience !== "takoform.run" ||
    credential.mode !== "tenant-run" ||
    !Number.isSafeInteger(credential.lifetimeSeconds) ||
    (credential.lifetimeSeconds as number) < 1 ||
    (credential.lifetimeSeconds as number) > 300 ||
    !digests(
      credential.keyIdSha256,
      credential.issuerSha256,
      credential.organizationIdSha256,
      credential.tenantRefSha256,
      credential.spaceRefSha256,
      credential.runRefSha256,
      credential.tokenSha256,
    ) ||
    (credential.reservationRefSha256 !== null &&
      !SHA256.test(String(credential.reservationRefSha256))) ||
    readback.method !== "GET" ||
    readback.routeTemplate !== "/apis/forms.takoform.com/v1/forms?space={spaceRef}" ||
    readback.status !== 200 ||
    readback.mediaType !== "application/json" ||
    readback.semantic !== "takoform-form-list" ||
    !SHA256.test(String(readback.responseSha256)) ||
    !isInstant(proof.completedAt) ||
    !isInstant(proof.expiresAt) ||
    !isInstant(exchange.capturedAt) ||
    !isInstant(authorityReceipt.recordedAt) ||
    !isInstant(credential.issuedAt) ||
    !isInstant(credential.expiresAt) ||
    !isInstant(readback.verifiedAt)
  ) {
    throw preflightError("sponsorship cutover proof shape is invalid");
  }
  return proof as unknown as CutoverProof;
}

function validateProofSemantics(
  proof: CutoverProof,
  target: DeployTarget,
  environment: DeployEnvironment,
  nowValue: Date,
): void {
  const now = exactNow(nowValue).getTime();
  const completedAt = Date.parse(proof.completedAt);
  const expiresAt = Date.parse(proof.expiresAt);
  const issuedAt = Date.parse(proof.issuance.credential.issuedAt);
  const credentialExpiresAt = Date.parse(proof.issuance.credential.expiresAt);
  const capturedAt = Date.parse(proof.issuance.exchange.capturedAt);
  const verifiedAt = Date.parse(proof.issuance.readback.verifiedAt);
  const selected = target.sponsorshipAuthority;
  if (
    selected === undefined ||
    target.environment !== environment ||
    proof.authority.environment !== environment ||
    proof.authority.workerName !== selected.workerName ||
    proof.hosted.workerName === selected.workerName ||
    proof.hosted.workerName === target.workerName ||
    proof.publicWorkerPredecessor.workerName !== target.workerName ||
    proof.publicWorkerPredecessor.versionId === proof.authority.versionId ||
    proof.publicWorkerPredecessor.versionId === proof.hosted.versionId ||
    proof.authority.versionId === proof.hosted.versionId ||
    proof.authority.credentialKeyIdSha256 !== sha256Text(selected.credentialKeyId) ||
    proof.authority.credentialPublicJwkSha256 !==
      sha256Text(canonicalJson(selected.credentialPublicJwk)) ||
    proof.authority.receiptKeyIdSha256 !== sha256Text(selected.receiptKeyId) ||
    proof.authority.receiptPublicJwkSha256 !==
      sha256Text(canonicalJson(selected.receiptPublicJwk)) ||
    proof.hosted.authorityServiceBinding.serviceSha256 !== sha256Text(selected.workerName) ||
    proof.issuance.credential.issuerSha256 !== sha256Text(target.publicOrigin) ||
    proof.issuance.credential.keyIdSha256 !== sha256Text(selected.credentialKeyId) ||
    proof.issuance.credential.organizationIdSha256 !== sha256Text(selected.organizationId) ||
    proof.issuance.credential.tenantRefSha256 !== proof.issuance.credential.spaceRefSha256 ||
    proof.issuance.credential.runRefSha256 !== proof.issuance.exchange.runRefSha256 ||
    expiresAt - completedAt !== EXACT_PROOF_TTL_MS ||
    now < completedAt ||
    now >= expiresAt ||
    credentialExpiresAt - issuedAt !== proof.issuance.credential.lifetimeSeconds * 1_000 ||
    issuedAt > capturedAt ||
    Date.parse(proof.issuance.authorityReceipt.recordedAt) > capturedAt ||
    capturedAt >= credentialExpiresAt ||
    verifiedAt !== completedAt ||
    verifiedAt >= credentialExpiresAt
  ) {
    throw preflightError("sponsorship cutover proof is stale or does not match this target");
  }
}

async function verifyProofReceipt(proof: CutoverProof, target: DeployTarget): Promise<void> {
  const selected = target.sponsorshipAuthority;
  if (!selected) throw preflightError("sponsorship receipt target is unavailable");
  const jws = proof.issuance.authorityReceipt.jws;
  const parts = jws.split(".");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (parts.length !== 3 || !encodedHeader || !encodedPayload || !encodedSignature) {
    throw preflightError("sponsorship authority receipt is malformed");
  }
  const header = exact(decodeJwsPart(encodedHeader), ["alg", "kid", "typ"]);
  if (
    header.alg !== "EdDSA" ||
    header.kid !== selected.receiptKeyId ||
    header.typ !== RECEIPT_TYPE
  ) {
    throw preflightError("sponsorship authority receipt identity is invalid");
  }
  const key = await crypto.subtle
    .importKey("jwk", selected.receiptPublicJwk, { name: "Ed25519" }, false, ["verify"])
    .catch(() => {
      throw preflightError("sponsorship authority receipt key is invalid");
    });
  const signature = decodeBase64Url(encodedSignature);
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    ))
  ) {
    throw preflightError("sponsorship authority receipt signature is invalid");
  }
  const payload = exact(decodeJwsPart(encodedPayload), [
    "aud",
    "authority",
    "credential",
    "exp",
    "hostedVersionId",
    "iat",
    "issuanceOperationId",
    "requestNonceSha256",
    "requestSha256",
    "requiredAvailableMinor",
  ]);
  const authority = exact(payload.authority, [
    "artifactSha256",
    "sourceCommit",
    "versionId",
    "workerNameSha256",
  ]);
  const credential = exact(payload.credential, [
    "expiresAtEpochSeconds",
    "issuedAtEpochSeconds",
    "organizationIdSha256",
    "publicJwk",
    "reservationRefSha256",
    "runRefSha256",
    "spaceRefSha256",
    "tenantRefSha256",
    "tokenSha256",
  ]);
  const credentialPublicJwk = exactPublicJwk(credential.publicJwk);
  if (canonicalJson(credentialPublicJwk) !== canonicalJson(selected.credentialPublicJwk)) {
    throw preflightError(
      "sponsorship authority receipt does not bind the target credential public key",
    );
  }
  if (
    payload.aud !== RECEIPT_AUDIENCE ||
    payload.hostedVersionId !== proof.hosted.versionId ||
    payload.issuanceOperationId !== proof.issuance.authorityReceipt.issuanceOperationId ||
    payload.requestSha256 !== proof.issuance.authorityReceipt.requestSha256 ||
    payload.requestNonceSha256 !== proof.issuance.authorityReceipt.requestNonceSha256 ||
    payload.requiredAvailableMinor !== proof.issuance.exchange.requiredAvailableMinor ||
    authority.versionId !== proof.authority.versionId ||
    authority.sourceCommit !== proof.authority.sourceCommit ||
    authority.artifactSha256 !== proof.authority.artifactSha256 ||
    authority.workerNameSha256 !== sha256Text(proof.authority.workerName) ||
    credential.tokenSha256 !== proof.issuance.credential.tokenSha256 ||
    credential.organizationIdSha256 !== proof.issuance.credential.organizationIdSha256 ||
    credential.tenantRefSha256 !== proof.issuance.credential.tenantRefSha256 ||
    credential.spaceRefSha256 !== proof.issuance.credential.spaceRefSha256 ||
    credential.runRefSha256 !== proof.issuance.credential.runRefSha256 ||
    credential.reservationRefSha256 !== proof.issuance.credential.reservationRefSha256 ||
    credential.issuedAtEpochSeconds !== Date.parse(proof.issuance.credential.issuedAt) / 1_000 ||
    credential.expiresAtEpochSeconds !== Date.parse(proof.issuance.credential.expiresAt) / 1_000 ||
    payload.iat !== credential.issuedAtEpochSeconds ||
    payload.exp !== credential.expiresAtEpochSeconds
  ) {
    throw preflightError("sponsorship authority receipt does not match the cutover proof");
  }
}

function decodeJwsPart(value: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value)));
  } catch {
    throw preflightError("sponsorship authority receipt is malformed");
  }
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw preflightError("sponsorship authority receipt is malformed");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw preflightError("sponsorship authority receipt is malformed");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function exactPublicJwk(value: unknown): {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
} {
  const jwk = exact(value, ["crv", "kty", "x"]);
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)
  ) {
    throw preflightError("sponsorship authority receipt credential key is invalid");
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

function readPrivateProof(path: string): Uint8Array {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw preflightError("sponsorship cutover proof is unavailable");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    (uid !== undefined && stat.uid !== uid) ||
    stat.size < 1 ||
    stat.size > MAX_PROOF_BYTES
  ) {
    throw preflightError("sponsorship cutover proof must be one owned 0600 regular file");
  }
  return readFileSync(path);
}

function exactHandle(handle: SponsorshipCutoverProofHandle, digest: string): void {
  if (
    handle.proofSha256 !== digest ||
    (handle.stage !== "public-route-removal" && handle.stage !== "legacy-secret-retirement")
  )
    throw preflightError("sponsorship cutover proof handle is invalid");
}

function privatePath(value: string | undefined, label: string): string {
  if (!value?.startsWith("/") || value.includes("\u0000")) {
    throw preflightError(`sponsorship cutover ${label} must be one absolute path`);
  }
  return resolve(value);
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const item = record(value, "sponsorship cutover proof shape is invalid");
  if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify([...keys].sort())) {
    throw preflightError("sponsorship cutover proof shape is invalid");
  }
  return item;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw preflightError(message);
  return value as Record<string, unknown>;
}

function sortedBindings(bindings: readonly BindingEvidence[]): readonly BindingEvidence[] {
  return [...bindings].sort((left, right) =>
    `${left.name}\0${left.type}`.localeCompare(`${right.name}\0${right.type}`),
  );
}

function digests(...values: readonly unknown[]): boolean {
  return values.every((value) => typeof value === "string" && SHA256.test(value));
}

function isEnvironment(value: unknown): value is DeployEnvironment {
  return value === "integration" || value === "rehearsal" || value === "production";
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function exactNow(value: Date): Date {
  if (!Number.isFinite(value.getTime()))
    throw preflightError("sponsorship cutover proof clock is invalid");
  return new Date(value.getTime());
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function nonempty(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value
  );
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sha256Text(value: string): `sha256:${string}` {
  return sha256(new TextEncoder().encode(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
}
