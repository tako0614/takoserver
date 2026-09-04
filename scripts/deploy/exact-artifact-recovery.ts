import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ArtifactRecoveryLostAckAuthorization,
  type ArtifactRecoveryRequest,
  type ArtifactRecoveryStatus,
  canonicalArtifactRecoveryRequest,
  type Digest,
} from "../../src/artifact-recovery.ts";
import { canonicalDigest, canonicalJson, isSha256Digest } from "../../src/json.ts";
import type { SqlAccess } from "../../src/ports.ts";
import { publicFormCapabilityManifest } from "../../src/public-worker-implementation.ts";
import { createD1HttpSql } from "../../src/sql-d1-http.ts";
import {
  loadExactArtifactRecoveryLostAck,
  loadExactArtifactRecoveryRequest,
  parseExactArtifactRecoveryLostAck,
  runExactArtifactRecoveryOperator,
} from "../exact-artifact-recovery.ts";
import {
  cloudflareProviderExecutorDependencies,
  inspectCloudflareProviderExecutor,
  remoteCloudflareProviderExecutorSchema,
} from "./cloudflare-provider-executor.ts";
import { readCloudflareProviderExecutorSecrets } from "./cloudflare-provider-executor-secrets.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  runFormAuthority,
  type SelectedFormAuthorityTarget,
  writeFormAuthorityConfig,
} from "./form-authority.ts";
import { REPOSITORY, requireEnvironment, runCommand, wranglerCommand } from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import { writeCloudflareProviderExecutorConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact, type WorkerArtifactProcess } from "./worker-artifact.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  type ExpectedBindingClosure,
  optionalExactPlainTextBinding,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  publishWranglerVersion,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

export interface ExactArtifactRecoveryReceiptState {
  readonly phase: "prepared" | "settling" | "complete" | "revoked";
  readonly detailState: "active" | "purging" | "purged";
  readonly activeWorkerVersionId: string;
  readonly purgeAfter: number | null;
  readonly resultSetDigest: Digest | null;
  readonly nextCandidate?: {
    readonly ordinal: number;
    readonly fence: number;
    readonly state: "pending" | "delete_started";
  } | null;
}

export type ExactArtifactRecoveryWorkerDeployment =
  | { readonly state: "absent" }
  | { readonly state: "drift" }
  | {
      readonly state: "ready";
      readonly versionId: string;
      readonly requestDigest: Digest;
      readonly commit: string;
      readonly handoff: ArtifactRecoveryLostAckAuthorization | null;
    };

export type ExactArtifactRecoveryGatewayDeployment =
  | { readonly state: "drift" }
  | { readonly state: "ordinary"; readonly versionId: string }
  | {
      readonly state: "recovery";
      readonly versionId: string;
      readonly recoveryWorkerVersionId: string;
      readonly requestDigest: Digest;
    };

export interface ExactArtifactRecoveryDeploymentSnapshot {
  readonly executorReady: boolean;
  readonly requestDigest: Digest;
  readonly selectedCommit: string;
  readonly worker: ExactArtifactRecoveryWorkerDeployment;
  readonly gateway: ExactArtifactRecoveryGatewayDeployment;
  readonly receipt: ExactArtifactRecoveryReceiptState | null;
  readonly recoveryStatus:
    | (Pick<ArtifactRecoveryStatus, "phase" | "action"> &
        Partial<Pick<ArtifactRecoveryStatus, "blocker">>)
    | null;
  readonly now: number;
}

export type ExactArtifactRecoveryDeploymentAction =
  | "publish_worker"
  | "publish_gateway"
  | "invoke"
  | "wait"
  | "retire_gateway_for_handoff"
  | "publish_handoff_worker"
  | "retire_gateway"
  | "retire_worker"
  | "wait_retention"
  | "purge_details"
  | "none"
  | "refuse";

export interface ExactArtifactRecoveryDeploymentPlan {
  readonly action: ExactArtifactRecoveryDeploymentAction;
  readonly reason: string;
}

export interface ExactArtifactRecoveryDeployInvocation {
  readonly surface: "takoserver-exact-artifact-recovery";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface ExactArtifactRecoveryDeployRuntime {
  inspect(): Promise<ExactArtifactRecoveryDeploymentSnapshot>;
  apply(
    action: Exclude<
      ExactArtifactRecoveryDeploymentAction,
      "refuse" | "wait" | "wait_retention" | "none"
    >,
  ): Promise<unknown>;
  dispose?(): Promise<void> | void;
}

export interface ExactArtifactRecoveryDeployOptions {
  readonly runtime?: ExactArtifactRecoveryDeployRuntime;
  readonly run?: WorkerArtifactProcess;
  readonly state?: ExactArtifactRecoveryCloudflareState;
  readonly requestPath?: string;
  readonly lostAckPath?: string;
  readonly providerExecutorSecretsPath?: string;
  readonly operatorPrivateJwkPath?: string;
  readonly outputDirectory?: string;
  readonly review?: string;
  readonly fetcher?: typeof fetch;
  readonly clock?: () => Date;
  readonly randomId?: () => string;
  readonly publicationLease?: (workerName: string) => Promise<WranglerVersionPublicationLease>;
}

export interface ExactArtifactRecoveryCloudflareState {
  workerScripts(): Promise<readonly string[]>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerVersionWithModules(workerName: string, versionId: string): Promise<unknown>;
  workerSecrets(workerName: string): Promise<readonly unknown[]>;
  workerSettings(workerName: string): Promise<unknown>;
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
  workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }>;
  workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  >;
}

/** Product-owned status/apply surface; one invocation performs at most one planned transition. */
export async function runExactArtifactRecoveryDeployment(
  invocation: ExactArtifactRecoveryDeployInvocation,
  target: DeployTarget,
  options: ExactArtifactRecoveryDeployOptions = {},
): Promise<Record<string, unknown>> {
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("exact artifact recovery deploy surface is integration-only");
  }
  if (target.environment !== invocation.environment) {
    throw preflightError("exact artifact recovery invocation and target environments differ");
  }
  const ownsRuntime = options.runtime === undefined;
  const runtime =
    options.runtime ??
    (await createExactArtifactRecoveryDeployRuntime(invocation, target, options));
  try {
    const before = await runtime.inspect();
    const planned = planExactArtifactRecoveryDeployment(before);
    if (invocation.action === "status")
      return await deploymentStatus(invocation, before, planned, target);
    const reviewer = exactReviewer(
      options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
    );
    if (planned.action === "refuse") throw preflightError(planned.reason);
    if (
      planned.action === "wait" ||
      planned.action === "wait_retention" ||
      planned.action === "none"
    ) {
      return {
        kind: "takoserver.exact-artifact-recovery-apply@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        requestDigest: before.requestDigest,
        selectedCommit: invocation.commit,
        reviewer,
        mutation: "none",
        action: planned.action,
        reason: planned.reason,
      };
    }
    const source = await qualifySource({
      environment: invocation.environment,
      commit: invocation.commit,
      policy: "clean-remote",
      run: options.run ?? runCommand,
    });
    if (source.commit !== before.selectedCommit) {
      throw preflightError("exact artifact recovery selected source changed after inspection");
    }
    if (ownsRuntime) {
      const gate = await (options.run ?? runCommand)(["bun", "run", "check"]);
      if (gate.exitCode !== 0) {
        throw preflightError(
          `exact artifact recovery owner gate failed (exit ${gate.exitCode})`,
          `${gate.stdout}${gate.stderr}`.trim(),
        );
      }
    }
    const effect = await runtime.apply(planned.action);
    const after = await runtime.inspect();
    assertDeploymentAdvanced(planned.action, before, after);
    return {
      kind: "takoserver.exact-artifact-recovery-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      requestDigest: before.requestDigest,
      selectedCommit: invocation.commit,
      reviewer,
      mutation: planned.action,
      next: planExactArtifactRecoveryDeployment(after),
      effect: redactEffect(effect),
    };
  } finally {
    if (ownsRuntime) await runtime.dispose?.();
  }
}

interface ExactRecoveryPublicIdentity {
  readonly hostId: string;
  readonly workerArtifactDigest: Digest;
  readonly publicWorkerVersionId: string;
  readonly implementationDigest: Digest;
}

interface ExactRecoveryRuntimeContext {
  readonly invocation: ExactArtifactRecoveryDeployInvocation;
  readonly target: DeployTarget;
  readonly requestPath: string;
  readonly operatorPrivateJwkPath: string;
  readonly loaded: Awaited<ReturnType<typeof loadExactArtifactRecoveryRequest>>;
  readonly state: ExactArtifactRecoveryCloudflareState;
  readonly sql: Pick<SqlAccess, "query">;
  readonly childEnvironment: Readonly<Record<string, string>>;
  readonly root: string;
  readonly run: WorkerArtifactProcess;
  readonly fetcher: typeof fetch;
  readonly clock: () => Date;
  readonly randomId: () => string;
  readonly publicationLease?: (workerName: string) => Promise<WranglerVersionPublicationLease>;
  readonly lostAckPath?: string;
  readonly providerReady: () => Promise<boolean>;
}

async function createExactArtifactRecoveryDeployRuntime(
  invocation: ExactArtifactRecoveryDeployInvocation,
  target: DeployTarget,
  options: ExactArtifactRecoveryDeployOptions,
): Promise<ExactArtifactRecoveryDeployRuntime> {
  requiredRecoveryTarget(target);
  requiredOperatorTarget(target);
  if (!target.cloudflareProviderExecutor) {
    throw preflightError(
      "exact artifact recovery requires the selected Cloudflare provider executor",
    );
  }
  const requestPath =
    options.requestPath ?? requireEnvironment("TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_PATH");
  const providerExecutorSecretsPath =
    options.providerExecutorSecretsPath ??
    requireEnvironment("TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH");
  const operatorPrivateJwkPath =
    options.operatorPrivateJwkPath ??
    requireEnvironment("TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH");
  const loaded = await loadExactArtifactRecoveryRequest(requestPath);
  await assertExactArtifactRecoveryDeployTarget({
    target,
    request: loaded.request,
    requestDigest: loaded.requestDigest,
    commit: invocation.commit,
  });
  const providerSecrets = readCloudflareProviderExecutorSecrets(providerExecutorSecretsPath);
  const apiToken = providerSecrets.values.CLOUDFLARE_API_TOKEN;
  const childEnvironment = { CLOUDFLARE_API_TOKEN: apiToken };
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: apiToken,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
  const fetcher = options.fetcher ?? fetch;
  const sql = createD1HttpSql({
    accountId: target.accountId,
    databaseId: target.d1.databaseId,
    authorize: () => `Bearer ${apiToken}`,
    fetch: async (request) => await fetcher(request),
  });
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-exact-recovery-deploy-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const providerConfig = writeCloudflareProviderExecutorConfig(target, {
    path: join(root, "provider-executor-inspection.jsonc"),
    main: resolve(REPOSITORY, "src/entry-cloudflare-provider-executor.ts"),
  });
  const run = options.run ?? runCommand;
  const providerSchema = remoteCloudflareProviderExecutorSchema(
    providerConfig,
    childEnvironment,
    run,
  );
  const providerDependencies = cloudflareProviderExecutorDependencies(
    state,
    target,
    invocation.commit,
  );
  const providerReady = async (): Promise<boolean> => {
    const inspection = await inspectCloudflareProviderExecutor(
      "preflight",
      state,
      providerSchema,
      providerDependencies,
      target,
      { commit: invocation.commit },
    );
    return inspection.ready && (await recoveryMigrationApplied(sql));
  };
  const context: ExactRecoveryRuntimeContext = {
    invocation,
    target,
    requestPath,
    operatorPrivateJwkPath,
    loaded,
    state,
    sql,
    childEnvironment,
    root,
    run,
    fetcher,
    clock: options.clock ?? (() => new Date()),
    randomId: options.randomId ?? randomUUID,
    ...(options.publicationLease === undefined
      ? {}
      : { publicationLease: options.publicationLease }),
    ...(options.lostAckPath === undefined ? {} : { lostAckPath: options.lostAckPath }),
    providerReady,
  };

  return {
    async inspect() {
      return await inspectExactArtifactRecoveryDeployment(context);
    },
    async apply(action) {
      return await applyExactArtifactRecoveryDeployment(context, action);
    },
    dispose() {
      unsealDirectory(root);
      if (options.outputDirectory === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
}

async function inspectExactArtifactRecoveryDeployment(
  context: ExactRecoveryRuntimeContext,
): Promise<ExactArtifactRecoveryDeploymentSnapshot> {
  const selected = await loadExactArtifactRecoveryRequest(context.requestPath);
  if (selected.requestDigest !== context.loaded.requestDigest) {
    throw preflightError("exact artifact recovery request changed after deploy selection");
  }
  await assertExactArtifactRecoveryDeployTarget({
    target: context.target,
    request: selected.request,
    requestDigest: selected.requestDigest,
    commit: context.invocation.commit,
  });
  const [executorReady, worker, gateway, receipt, identity] = await Promise.all([
    context.providerReady(),
    inspectRecoveryWorker(context.state, context.target, selected),
    inspectRecoveryGateway(context.state, context.target, selected.requestDigest),
    readRecoveryReceipt(context.sql, selected),
    readRecoveryPublicIdentity(context),
  ]);
  const recoveryStatus =
    gateway.state === "recovery" && worker.state === "ready"
      ? await readRecoveryStatus(context, identity, worker.versionId)
      : null;
  return {
    executorReady,
    requestDigest: selected.requestDigest,
    selectedCommit: context.invocation.commit,
    worker,
    gateway,
    receipt,
    recoveryStatus,
    now: context.clock().getTime(),
  };
}

async function applyExactArtifactRecoveryDeployment(
  context: ExactRecoveryRuntimeContext,
  action: Exclude<
    ExactArtifactRecoveryDeploymentAction,
    "refuse" | "wait" | "wait_retention" | "none"
  >,
): Promise<Record<string, unknown>> {
  const before = await inspectExactArtifactRecoveryDeployment(context);
  const expected = planExactArtifactRecoveryDeployment(before);
  if (expected.action !== action) {
    throw preflightError("exact artifact recovery deployment changed before mutation");
  }
  switch (action) {
    case "publish_worker":
      return await publishRecoveryWorker(context, before, null);
    case "publish_handoff_worker": {
      const handoff = await selectedLostAckHandoff(context, before);
      return await publishRecoveryWorker(context, before, handoff);
    }
    case "publish_gateway":
      return await publishRecoveryGateway(context, before, true);
    case "retire_gateway_for_handoff":
    case "retire_gateway":
      return await publishRecoveryGateway(context, before, false);
    case "invoke":
      return await invokeRecovery(context, before);
    case "retire_worker":
      return await retireRecoveryWorker(context, before);
    case "purge_details":
      return await purgeRecoveryDetails(context, before);
  }
}

async function readRecoveryPublicIdentity(
  context: ExactRecoveryRuntimeContext,
): Promise<ExactRecoveryPublicIdentity> {
  const status = await runFormAuthority(
    {
      surface: "takoserver-integration-form-authority-operator-worker",
      action: "status",
      environment: "integration",
      commit: context.invocation.commit,
    },
    context.target,
    {
      state: context.state,
      fetcher: async (input, init) => await context.fetcher(input, init),
    },
  );
  const hostId = exactText(status.hostId, "Form authority host identity");
  const workerArtifactDigest = exactDigest(
    status.workerArtifactDigest,
    "public Worker artifact identity",
  );
  const publicWorkerVersionId = exactWorkerVersion(
    status.publicWorkerVersionId,
    "public Worker Version identity",
  );
  const implementationDigest = exactDigest(
    status.implementationDigest,
    "public Form implementation identity",
  );
  if (
    status.publicIdentityRpcReady !== true ||
    status.publicWorkerCommitMatches !== true ||
    status.authorityCommitMatches !== true ||
    status.authorityPublicWorkerBindingProfile !== "dynamic-public-rpc" ||
    status.authorityScopeBindingProfile !== "exact-target"
  ) {
    throw preflightError(
      "exact artifact recovery requires the current authenticated Form authority composition",
    );
  }
  return { hostId, workerArtifactDigest, publicWorkerVersionId, implementationDigest };
}

async function readRecoveryStatus(
  context: ExactRecoveryRuntimeContext,
  identity: ExactRecoveryPublicIdentity,
  workerVersionId: string,
): Promise<Pick<ArtifactRecoveryStatus, "phase" | "action" | "blocker">> {
  const raw = await runExactArtifactRecoveryOperator({
    action: "status",
    requestPath: context.requestPath,
    workerVersionId,
    gatewayOrigin: requiredOperatorTarget(context.target).integrationOperatorOrigin,
    identity,
    privateJwkPath: context.operatorPrivateJwkPath,
    fetcher: context.fetcher,
    now: () => context.clock().getTime(),
  });
  const value = record(raw, "gateway recovery status");
  const phase = oneOf(
    value.phase,
    ["eligible", "prepared", "settling", "blocked", "complete", "revoked"] as const,
    "gateway recovery phase",
  );
  const action = oneOf(
    value.action,
    ["prepare", "wait", "settle", "reconcile_absent", "rearm", "complete", "none"] as const,
    "gateway recovery action",
  );
  if (value.blocker !== undefined && typeof value.blocker !== "string") {
    throw preflightError("exact artifact recovery gateway returned a malformed blocker");
  }
  return {
    phase,
    action,
    ...(typeof value.blocker === "string" ? { blocker: value.blocker } : {}),
  };
}

async function inspectRecoveryWorker(
  state: ExactArtifactRecoveryCloudflareState,
  target: DeployTarget,
  loaded: Awaited<ReturnType<typeof loadExactArtifactRecoveryRequest>>,
): Promise<ExactArtifactRecoveryWorkerDeployment> {
  const workerName = requiredRecoveryTarget(target).workerName;
  const [scripts, domains, routes] = await Promise.all([
    state.workerScripts(),
    state.workerDomains(),
    state.workerRoutes(),
  ]);
  if (scripts.length !== new Set(scripts).size) return { state: "drift" };
  if (!scripts.includes(workerName)) {
    return domains.some(({ service }) => service === workerName) ||
      routes.some(({ script }) => script === workerName)
      ? { state: "drift" }
      : { state: "absent" };
  }
  try {
    const history = parseWorkerDeploymentHistory(
      await state.workerDeployments(workerName),
      "preflight",
    );
    if (!history) return { state: "drift" };
    const [version, secrets, settings, subdomain] = await Promise.all([
      state.workerVersionWithModules(workerName, history.versionId),
      state.workerSecrets(workerName),
      state.workerSettings(workerName),
      state.workerSubdomain(workerName),
    ]);
    if (
      domains.some(({ service }) => service === workerName) ||
      routes.some(({ script }) => script === workerName) ||
      subdomain.enabled ||
      subdomain.previewsEnabled ||
      !settingsArePrivate(settings)
    ) {
      return { state: "drift" };
    }
    assertExactSecretInventory(secrets, [], "preflight");
    const identity = assertRecoveryVersion({
      phase: "preflight",
      versionId: history.versionId,
      version,
      target,
      loaded,
    });
    return {
      state: "ready",
      versionId: history.versionId,
      requestDigest: identity.requestDigest,
      commit: identity.commit,
      handoff: identity.handoff,
    };
  } catch {
    return { state: "drift" };
  }
}

async function inspectRecoveryGateway(
  state: ExactArtifactRecoveryCloudflareState,
  target: DeployTarget,
  requestDigest: Digest,
): Promise<ExactArtifactRecoveryGatewayDeployment> {
  const authority = requiredOperatorTarget(target);
  const workerName = authority.integrationOperatorWorkerName;
  try {
    const [scripts, domains, routes] = await Promise.all([
      state.workerScripts(),
      state.workerDomains(),
      state.workerRoutes(),
    ]);
    const expectedHostname = new URL(authority.integrationOperatorOrigin).hostname;
    const domainMatches = domains.filter(({ hostname }) => hostname === expectedHostname);
    if (
      scripts.length !== new Set(scripts).size ||
      !scripts.includes(workerName) ||
      domainMatches.length !== 1 ||
      domainMatches[0]?.service !== workerName ||
      domains.filter(({ service }) => service === workerName).length !== 1 ||
      routes.some(({ script }) => script === workerName)
    ) {
      return { state: "drift" };
    }
    const history = parseWorkerDeploymentHistory(
      await state.workerDeployments(workerName),
      "preflight",
    );
    if (!history) return { state: "drift" };
    const [version, secrets, settings, subdomain] = await Promise.all([
      state.workerVersionWithModules(workerName, history.versionId),
      state.workerSecrets(workerName),
      state.workerSettings(workerName),
      state.workerSubdomain(workerName),
    ]);
    assertExactSecretInventory(secrets, [], "preflight");
    if (subdomain.enabled || subdomain.previewsEnabled || !settingsArePrivate(settings)) {
      return { state: "drift" };
    }
    const identity = assertGatewayVersion({
      phase: "preflight",
      versionId: history.versionId,
      version,
      target,
      requestDigest,
    });
    return identity.recoveryWorkerVersionId === null
      ? { state: "ordinary", versionId: history.versionId }
      : {
          state: "recovery",
          versionId: history.versionId,
          recoveryWorkerVersionId: identity.recoveryWorkerVersionId,
          requestDigest: identity.requestDigest as Digest,
        };
  } catch {
    return { state: "drift" };
  }
}

async function readRecoveryReceipt(
  sql: Pick<SqlAccess, "query">,
  loaded: Awaited<ReturnType<typeof loadExactArtifactRecoveryRequest>>,
): Promise<ExactArtifactRecoveryReceiptState | null> {
  const rows = await sql.query(
    `SELECT request_digest, tenant_id, manifest_digest, member_set_digest,
            r2_identity_digest, source_commit, source_version,
            retention_policy_kind, retention_policy_digest,
            detail_retention_milliseconds, expected_owner_count,
            expected_upload_count, expected_replay_count, expected_member_count,
            expected_hold_count, phase, active_worker_version_id, purge_after,
            result_set_digest, detail_state
       FROM tf_artifact_recovery_once WHERE singleton = 1`,
  );
  if (rows.length === 0) {
    const details = await sql.query(
      `SELECT
         (SELECT COUNT(*) FROM tf_artifact_recovery_details) +
         (SELECT COUNT(*) FROM tf_artifact_recovery_candidates) +
         (SELECT COUNT(*) FROM tf_artifact_recovery_execution_handoffs) AS total`,
    );
    if (exactInteger(details[0]?.total, "orphan recovery detail count") !== 0) {
      throw preflightError("exact artifact recovery has detail rows without its singleton");
    }
    return null;
  }
  if (rows.length !== 1) throw preflightError("exact artifact recovery singleton is ambiguous");
  const row = rows[0] as NonNullable<(typeof rows)[number]>;
  const request = loaded.request;
  if (
    row.request_digest !== loaded.requestDigest ||
    row.tenant_id !== request.tenantId ||
    row.manifest_digest !== request.manifestDigest ||
    row.member_set_digest !== request.memberSetDigest ||
    row.r2_identity_digest !== request.r2.identityDigest ||
    row.source_commit !== request.source.commit ||
    row.source_version !== request.source.version ||
    row.retention_policy_kind !== request.retentionPolicy.kind ||
    row.retention_policy_digest !== request.retentionPolicy.evidenceDigest ||
    row.detail_retention_milliseconds !== request.retentionPolicy.detailRetentionMilliseconds ||
    row.expected_owner_count !== 4 ||
    row.expected_upload_count !== 5 ||
    row.expected_replay_count !== 2 ||
    row.expected_member_count !== 28 ||
    row.expected_hold_count !== 29
  ) {
    throw preflightError("exact artifact recovery durable singleton differs from the request");
  }
  const candidates = await sql.query(
    `SELECT detail.ordinal, detail.state, candidate.fence
       FROM tf_artifact_recovery_candidates AS detail
       JOIN tf_artifact_gc_candidates AS candidate
         ON candidate.kind = detail.kind AND candidate.digest = detail.digest
      WHERE detail.request_digest = ? AND detail.state IN ('pending', 'delete_started')
      ORDER BY detail.ordinal LIMIT 1`,
    [loaded.requestDigest],
  );
  const candidate = candidates[0];
  const nextCandidate =
    candidate === undefined
      ? null
      : {
          ordinal: exactInteger(candidate.ordinal, "recovery candidate ordinal"),
          fence: exactInteger(candidate.fence, "recovery candidate fence"),
          state: oneOf(
            candidate.state,
            ["pending", "delete_started"] as const,
            "recovery candidate state",
          ),
        };
  return {
    phase: oneOf(
      row.phase,
      ["prepared", "settling", "complete", "revoked"] as const,
      "recovery receipt phase",
    ),
    detailState: oneOf(
      row.detail_state,
      ["active", "purging", "purged"] as const,
      "recovery receipt detail state",
    ),
    activeWorkerVersionId: exactWorkerVersion(
      row.active_worker_version_id,
      "active recovery Worker Version",
    ),
    purgeAfter: nullableInteger(row.purge_after, "recovery purge deadline"),
    resultSetDigest: nullableDigest(row.result_set_digest, "recovery result set"),
    nextCandidate,
  };
}

async function recoveryMigrationApplied(sql: Pick<SqlAccess, "query">): Promise<boolean> {
  const rows = await sql.query(
    "SELECT name FROM d1_migrations WHERE name = '0046_exact_artifact_recovery_receipts.sql'",
  );
  return rows.length === 1 && rows[0]?.name === "0046_exact_artifact_recovery_receipts.sql";
}

function assertRecoveryVersion(input: {
  readonly phase: "preflight" | "verification";
  readonly versionId: string;
  readonly version: unknown;
  readonly target: DeployTarget;
  readonly loaded: Awaited<ReturnType<typeof loadExactArtifactRecoveryRequest>>;
  readonly expectedBundleDigestHex?: string;
  readonly expectedHandoff?: ArtifactRecoveryLostAckAuthorization | null;
}): {
  readonly commit: string;
  readonly requestDigest: Digest;
  readonly handoff: ArtifactRecoveryLostAckAuthorization | null;
} {
  const version = record(input.version, "recovery Worker Version");
  if (version.id !== input.versionId || !recordOrNull(version.annotations)) {
    throw phaseFailure(input.phase, "exact recovery Worker Version identity is malformed");
  }
  const annotations = version.annotations as Record<string, unknown>;
  const message = annotations["workers/message"];
  const match =
    typeof message === "string"
      ? /^takoserver-exact-artifact-recovery:([0-9a-f]{40}):([0-9a-f]{64}):([0-9a-f]{64})$/u.exec(
          message,
        )
      : null;
  if (!match?.[1] || !match[2] || !match[3]) {
    throw phaseFailure(input.phase, "exact recovery Worker Version annotation is malformed");
  }
  const requestDigest = `sha256:${match[3]}` as Digest;
  const moduleDigestHex = exactModuleDigest(input.phase, version);
  if (
    match[1] !== input.loaded.request.source.commit ||
    requestDigest !== input.loaded.requestDigest ||
    match[2] !== moduleDigestHex ||
    (input.expectedBundleDigestHex !== undefined &&
      input.expectedBundleDigestHex !== moduleDigestHex) ||
    !immutableRecoveryVersionSettings(version)
  ) {
    throw phaseFailure(input.phase, "exact recovery Worker Version provenance drifted");
  }
  const handoffBinding = optionalExactPlainTextBinding(
    input.phase,
    input.versionId,
    version,
    "TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK",
  );
  const handoff =
    handoffBinding === null ? null : parseExactArtifactRecoveryLostAck(handoffBinding);
  if (
    input.expectedHandoff !== undefined &&
    canonicalJson(input.expectedHandoff) !== canonicalJson(handoff)
  ) {
    throw phaseFailure(input.phase, "exact recovery Worker lost-ack authority drifted");
  }
  assertExactVersionBindingClosure(
    input.phase,
    input.versionId,
    version,
    expectedRecoveryWorkerBindings(input.target, input.loaded, handoff),
  );
  return { commit: match[1], requestDigest, handoff };
}

function assertGatewayVersion(input: {
  readonly phase: "preflight" | "verification";
  readonly versionId: string;
  readonly version: unknown;
  readonly target: DeployTarget;
  readonly requestDigest: Digest;
  readonly expectedBundleDigestHex?: string;
  readonly expectedCommit?: string;
  readonly expectedRecoveryWorkerVersionId?: string | null;
}): {
  readonly commit: string;
  readonly requestDigest: Digest | null;
  readonly recoveryWorkerVersionId: string | null;
} {
  const version = record(input.version, "recovery gateway Version");
  if (version.id !== input.versionId || !recordOrNull(version.annotations)) {
    throw phaseFailure(input.phase, "exact recovery gateway Version identity is malformed");
  }
  const annotation = (version.annotations as Record<string, unknown>)["workers/message"];
  const match =
    typeof annotation === "string"
      ? /^form-authority:takoserver-integration-form-authority-operator-worker:([0-9a-f]{40}):(sha256:[0-9a-f]{64})$/u.exec(
          annotation,
        )
      : null;
  if (!match?.[1] || !match[2]) {
    throw phaseFailure(input.phase, "exact recovery gateway Version annotation is malformed");
  }
  const moduleDigestHex = exactModuleDigest(input.phase, version);
  if (
    match[2] !== `sha256:${moduleDigestHex}` ||
    (input.expectedBundleDigestHex !== undefined &&
      input.expectedBundleDigestHex !== moduleDigestHex) ||
    (input.expectedCommit !== undefined && input.expectedCommit !== match[1]) ||
    !immutableRecoveryVersionSettings(version)
  ) {
    throw phaseFailure(input.phase, "exact recovery gateway Version provenance drifted");
  }
  const requestDigest = optionalExactPlainTextBinding(
    input.phase,
    input.versionId,
    version,
    "TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST",
  );
  const recoveryWorkerVersionId = optionalExactPlainTextBinding(
    input.phase,
    input.versionId,
    version,
    "TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID",
  );
  if ((requestDigest === null) !== (recoveryWorkerVersionId === null)) {
    throw phaseFailure(input.phase, "exact recovery gateway binding is partial");
  }
  let exactRecoveryWorkerVersionId: string | null = null;
  if (requestDigest !== null) {
    if (
      requestDigest !== input.requestDigest ||
      !isSha256Digest(requestDigest) ||
      !isWorkerVersion(recoveryWorkerVersionId)
    ) {
      throw phaseFailure(input.phase, "exact recovery gateway binding drifted");
    }
    exactRecoveryWorkerVersionId = recoveryWorkerVersionId;
  }
  if (
    input.expectedRecoveryWorkerVersionId !== undefined &&
    input.expectedRecoveryWorkerVersionId !== exactRecoveryWorkerVersionId
  ) {
    throw phaseFailure(input.phase, "exact recovery gateway selected the wrong Worker Version");
  }
  assertExactVersionBindingClosure(
    input.phase,
    input.versionId,
    version,
    expectedRecoveryGatewayBindings(
      input.target,
      requestDigest === null
        ? null
        : { requestDigest, workerVersionId: exactRecoveryWorkerVersionId as string },
    ),
  );
  return {
    commit: match[1],
    requestDigest: requestDigest as Digest | null,
    recoveryWorkerVersionId: exactRecoveryWorkerVersionId,
  };
}

function expectedRecoveryWorkerBindings(
  target: DeployTarget,
  loaded: Awaited<ReturnType<typeof loadExactArtifactRecoveryRequest>>,
  handoff: ArtifactRecoveryLostAckAuthorization | null,
): ExpectedBindingClosure {
  const authority = requiredOperatorTarget(target);
  return {
    STATE_DB: { type: "d1", fields: { id: target.d1.databaseId } },
    OBJECTS: { type: "r2_bucket", fields: { bucket_name: target.r2.bucketName } },
    WORKER_VERSION: { type: "version_metadata", fields: {} },
    PUBLIC_HOST_IDENTITY: {
      type: "service",
      fields: { service: target.workerName, entrypoint: "PublicHostIdentityEntrypoint" },
    },
    TAKOSERVER_ENVIRONMENT: { type: "plain_text", fields: { text: "integration" } },
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: {
      type: "plain_text",
      fields: { text: authority.hostId },
    },
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: {
      type: "plain_text",
      fields: { text: canonicalJson(authority.operatorPublicJwk) },
    },
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: {
      type: "plain_text",
      fields: { text: loaded.requestDigest },
    },
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST: {
      type: "plain_text",
      fields: { text: loaded.request.r2.identityDigest },
    },
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT: {
      type: "plain_text",
      fields: { text: loaded.request.source.commit },
    },
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION: {
      type: "plain_text",
      fields: { text: loaded.request.source.version },
    },
    ...(handoff === null
      ? {}
      : {
          TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK: {
            type: "plain_text",
            fields: { text: canonicalJson(handoff) },
          },
        }),
  };
}

function expectedRecoveryGatewayBindings(
  target: DeployTarget,
  recovery: { readonly requestDigest: Digest; readonly workerVersionId: string } | null,
): ExpectedBindingClosure {
  const authority = requiredOperatorTarget(target);
  return {
    TAKOSERVER_ENVIRONMENT: { type: "plain_text", fields: { text: "integration" } },
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: {
      type: "plain_text",
      fields: { text: authority.hostId },
    },
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: {
      type: "plain_text",
      fields: { text: authority.integrationOperatorOrigin },
    },
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: {
      type: "plain_text",
      fields: { text: canonicalJson(authority.operatorPublicJwk) },
    },
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: {
      type: "plain_text",
      fields: { text: authority.integrationOperatorScope.tenantId },
    },
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: {
      type: "plain_text",
      fields: { text: authority.integrationOperatorScope.space },
    },
    FORM_AUTHORITY: {
      type: "service",
      fields: {
        service: authority.integrationWorkerName,
        entrypoint: "IntegrationFormAuthorityEntrypoint",
      },
    },
    PUBLIC_HOST_IDENTITY: {
      type: "service",
      fields: { service: target.workerName, entrypoint: "PublicHostIdentityEntrypoint" },
    },
    ...(recovery === null
      ? {}
      : {
          TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: {
            type: "plain_text",
            fields: { text: recovery.requestDigest },
          },
          TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID: {
            type: "plain_text",
            fields: { text: recovery.workerVersionId },
          },
          EXACT_ARTIFACT_RECOVERY: {
            type: "service",
            fields: {
              service: requiredRecoveryTarget(target).workerName,
              entrypoint: "ExactArtifactRecoveryEntrypoint",
            },
          },
        }),
  };
}

function exactModuleDigest(
  phase: "preflight" | "verification",
  version: Record<string, unknown>,
): string {
  if (version.main_module !== "worker.js" || !Array.isArray(version.modules)) {
    throw phaseFailure(phase, "exact recovery Worker module closure is malformed");
  }
  if (version.modules.length !== 1 || !recordOrNull(version.modules[0])) {
    throw phaseFailure(phase, "exact recovery Worker module closure is not exact");
  }
  const module = version.modules[0] as Record<string, unknown>;
  if (
    Object.keys(module).sort().join(",") !== "content_base64,content_type,name" ||
    module.name !== "worker.js" ||
    module.content_type !== "application/javascript+module" ||
    typeof module.content_base64 !== "string"
  ) {
    throw phaseFailure(phase, "exact recovery Worker module is malformed");
  }
  const bytes = Buffer.from(module.content_base64, "base64");
  if (bytes.toString("base64") !== module.content_base64) {
    throw phaseFailure(phase, "exact recovery Worker module is not canonical base64");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function immutableRecoveryVersionSettings(version: Record<string, unknown>): boolean {
  return (
    version.compatibility_date === "2026-08-17" &&
    Array.isArray(version.compatibility_flags) &&
    version.compatibility_flags.length === 1 &&
    version.compatibility_flags[0] === "nodejs_compat" &&
    version.assets === undefined &&
    version.placement === undefined &&
    version.migration_tag === undefined &&
    (version.migrations === undefined ||
      (recordOrNull(version.migrations) && Object.keys(version.migrations).length === 0))
  );
}

function settingsArePrivate(value: unknown): boolean {
  return (
    recordOrNull(value) &&
    (value.workers_dev === false || value.workers_dev === undefined) &&
    (value.preview_urls === false || value.preview_urls === undefined)
  );
}

export async function exactArtifactRecoveryQuiescenceEvidenceDigest(input: {
  readonly requestDigest: Digest;
  readonly recoveryWorkerName: string;
  readonly recoveryWorkerVersionId: string;
  readonly gatewayWorkerName: string;
  readonly ordinaryGatewayVersionId: string;
  readonly ordinaryConfigurationDigest: Digest;
}): Promise<Digest> {
  if (
    !isSha256Digest(input.requestDigest) ||
    !isWorkerName(input.recoveryWorkerName) ||
    !isWorkerVersion(input.recoveryWorkerVersionId) ||
    !isWorkerName(input.gatewayWorkerName) ||
    !isWorkerVersion(input.ordinaryGatewayVersionId) ||
    !isSha256Digest(input.ordinaryConfigurationDigest)
  ) {
    throw new TypeError("invalid exact artifact recovery quiescence evidence");
  }
  return await canonicalDigest({
    kind: "takoserver.exact-artifact-recovery-quiescence@v1",
    requestDigest: input.requestDigest,
    recoveryWorker: {
      name: input.recoveryWorkerName,
      versionId: input.recoveryWorkerVersionId,
      ingressState: "absent",
    },
    gateway: {
      name: input.gatewayWorkerName,
      versionId: input.ordinaryGatewayVersionId,
      recoveryBindingState: "absent",
      ordinaryConfigurationDigest: input.ordinaryConfigurationDigest,
    },
  });
}

async function selectedLostAckHandoff(
  context: ExactRecoveryRuntimeContext,
  before: ExactArtifactRecoveryDeploymentSnapshot,
): Promise<ArtifactRecoveryLostAckAuthorization> {
  if (
    before.worker.state !== "ready" ||
    before.gateway.state !== "ordinary" ||
    !before.receipt ||
    !before.receipt.nextCandidate ||
    before.receipt.activeWorkerVersionId !== before.worker.versionId
  ) {
    throw preflightError("exact artifact recovery has no quiesced lost-ack predecessor");
  }
  const path =
    context.lostAckPath ?? requireEnvironment("TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK_PATH");
  const authorization = loadExactArtifactRecoveryLostAck(path);
  const expectedQuiescence = await exactArtifactRecoveryQuiescenceEvidenceDigest({
    requestDigest: before.requestDigest,
    recoveryWorkerName: requiredRecoveryTarget(context.target).workerName,
    recoveryWorkerVersionId: before.worker.versionId,
    gatewayWorkerName: requiredOperatorTarget(context.target).integrationOperatorWorkerName,
    ordinaryGatewayVersionId: before.gateway.versionId,
    ordinaryConfigurationDigest: await ordinaryGatewayConfigurationDigest(context.target),
  });
  const candidate = before.receipt.nextCandidate;
  const resolutionMatches =
    authorization.resolution.kind === "confirm-head-absent"
      ? candidate.state === "delete_started"
      : authorization.resolution.candidateFence === candidate.fence + 2;
  if (
    authorization.predecessorWorkerVersionId !== before.worker.versionId ||
    authorization.candidateOrdinal !== candidate.ordinal ||
    authorization.quiescenceEvidenceDigest !== expectedQuiescence ||
    !resolutionMatches
  ) {
    throw preflightError(
      "exact artifact recovery lost-ack authority does not match quiesced state",
    );
  }
  return authorization;
}

async function publishRecoveryWorker(
  context: ExactRecoveryRuntimeContext,
  before: ExactArtifactRecoveryDeploymentSnapshot,
  handoff: ArtifactRecoveryLostAckAuthorization | null,
): Promise<Record<string, unknown>> {
  const recovery = requiredRecoveryTarget(context.target);
  const expectedHistory = await readWorkerHistory(context.state, recovery.workerName);
  if (
    (before.worker.state === "absent") !== (expectedHistory === null) ||
    (before.worker.state === "ready" && expectedHistory?.versionId !== before.worker.versionId)
  ) {
    throw preflightError("exact recovery Worker predecessor changed before build");
  }
  const root = operationRoot(context, "worker");
  const prepared = await prepareWorkerArtifact({
    root,
    target: context.target,
    commit: context.invocation.commit,
    main: resolve(REPOSITORY, "src/entry-exact-artifact-recovery-worker.ts"),
    dryRunCommand: "versions-upload",
    environment: context.childEnvironment,
    run: context.run,
    writeConfig: ({ path, main }) =>
      writeExactArtifactRecoveryWorkerConfig({
        path,
        main,
        target: context.target,
        request: context.loaded.request,
        requestDigest: context.loaded.requestDigest,
        ...(handoff === null ? {} : { handoff }),
      }),
  });
  const artifact = prepared.seal();
  artifact.assertUnchanged();
  const lease = await recoveryPublicationLease(context, recovery.workerName);
  try {
    const published = await publishWranglerVersion({
      root,
      bundlePath: prepared.bundlePath,
      configPath: prepared.configPath,
      accountId: context.target.accountId,
      workerName: recovery.workerName,
      message: recoveryWorkerMessage(
        context.invocation.commit,
        prepared.bundleDigestHex,
        context.loaded.requestDigest,
      ),
      lease,
      environment: context.childEnvironment,
      run: context.run,
      assertUploadedVersion: async (versionId) => {
        artifact.assertUnchanged();
        assertRecoveryVersion({
          phase: "verification",
          versionId,
          version: await context.state.workerVersionWithModules(recovery.workerName, versionId),
          target: context.target,
          loaded: context.loaded,
          expectedBundleDigestHex: prepared.bundleDigestHex,
          expectedHandoff: handoff,
        });
      },
      assertPredecessorStillCurrent: async () => {
        artifact.assertUnchanged();
        const current = await readWorkerHistory(context.state, recovery.workerName);
        if (!sameHistory(expectedHistory, current)) {
          throw preflightError("exact recovery Worker predecessor changed during upload");
        }
      },
    });
    const after = await inspectRecoveryWorker(context.state, context.target, context.loaded);
    if (
      after.state !== "ready" ||
      after.versionId !== published.versionId ||
      canonicalJson(after.handoff) !== canonicalJson(handoff)
    ) {
      throw verificationError("exact recovery Worker publication readback did not converge");
    }
    return {
      kind: "takoserver.exact-artifact-recovery-effect@v1",
      action: handoff === null ? "publish_worker" : "publish_handoff_worker",
      workerName: recovery.workerName,
      versionId: published.versionId,
      deploymentId: published.deploymentId,
      previousVersionId: expectedHistory?.versionId ?? null,
    };
  } finally {
    await lease.release();
  }
}

async function publishRecoveryGateway(
  context: ExactRecoveryRuntimeContext,
  before: ExactArtifactRecoveryDeploymentSnapshot,
  attachRecovery: boolean,
): Promise<Record<string, unknown>> {
  if (before.worker.state !== "ready") {
    throw preflightError("exact recovery gateway requires one ready route-less Worker");
  }
  if (before.gateway.state === "drift") {
    throw preflightError("exact recovery gateway predecessor is drifted");
  }
  const authority = requiredOperatorTarget(context.target);
  const workerName = authority.integrationOperatorWorkerName;
  const expectedHistory = await readWorkerHistory(context.state, workerName);
  if (!expectedHistory || expectedHistory.versionId !== before.gateway.versionId) {
    throw preflightError("exact recovery gateway predecessor changed before build");
  }
  const recovery = attachRecovery
    ? { requestDigest: context.loaded.requestDigest, workerVersionId: before.worker.versionId }
    : null;
  const root = operationRoot(context, attachRecovery ? "gateway-attach" : "gateway-retire");
  const prepared = await prepareWorkerArtifact({
    root,
    target: context.target,
    commit: context.invocation.commit,
    main: resolve(REPOSITORY, "src/entry-integration-form-authority-operator-worker.ts"),
    dryRunCommand: "versions-upload",
    environment: context.childEnvironment,
    run: context.run,
    writeConfig: ({ path, main }) =>
      writeExactArtifactRecoveryGatewayConfig({
        path,
        main,
        target: context.target,
        commit: context.invocation.commit,
        ...(recovery === null ? {} : { recovery }),
      }),
  });
  const artifact = prepared.seal();
  artifact.assertUnchanged();
  const lease = await recoveryPublicationLease(context, workerName);
  try {
    const published = await publishWranglerVersion({
      root,
      bundlePath: prepared.bundlePath,
      configPath: prepared.configPath,
      accountId: context.target.accountId,
      workerName,
      message:
        `form-authority:takoserver-integration-form-authority-operator-worker:` +
        `${context.invocation.commit}:sha256:${prepared.bundleDigestHex}`,
      lease,
      environment: context.childEnvironment,
      run: context.run,
      assertUploadedVersion: async (versionId) => {
        artifact.assertUnchanged();
        assertGatewayVersion({
          phase: "verification",
          versionId,
          version: await context.state.workerVersionWithModules(workerName, versionId),
          target: context.target,
          requestDigest: context.loaded.requestDigest,
          expectedBundleDigestHex: prepared.bundleDigestHex,
          expectedCommit: context.invocation.commit,
          expectedRecoveryWorkerVersionId: recovery?.workerVersionId ?? null,
        });
      },
      assertPredecessorStillCurrent: async () => {
        artifact.assertUnchanged();
        const current = await readWorkerHistory(context.state, workerName);
        if (!sameHistory(expectedHistory, current)) {
          throw preflightError("exact recovery gateway predecessor changed during upload");
        }
      },
    });
    const after = await inspectRecoveryGateway(
      context.state,
      context.target,
      context.loaded.requestDigest,
    );
    const exact =
      recovery === null
        ? after.state === "ordinary"
        : after.state === "recovery" &&
          after.recoveryWorkerVersionId === recovery.workerVersionId &&
          after.requestDigest === recovery.requestDigest;
    if (!exact || after.state === "drift" || after.versionId !== published.versionId) {
      throw verificationError("exact recovery gateway publication readback did not converge");
    }
    return {
      kind: "takoserver.exact-artifact-recovery-effect@v1",
      action: attachRecovery ? "publish_gateway" : "retire_gateway",
      workerName,
      versionId: published.versionId,
      deploymentId: published.deploymentId,
      previousVersionId: expectedHistory.versionId,
    };
  } finally {
    await lease.release();
  }
}

async function invokeRecovery(
  context: ExactRecoveryRuntimeContext,
  before: ExactArtifactRecoveryDeploymentSnapshot,
): Promise<Record<string, unknown>> {
  if (before.worker.state !== "ready" || before.gateway.state !== "recovery") {
    throw preflightError("exact recovery invocation has no attached route-less Worker");
  }
  const identity = await readRecoveryPublicIdentity(context);
  const result = await runExactArtifactRecoveryOperator({
    action: "apply",
    requestPath: context.requestPath,
    workerVersionId: before.worker.versionId,
    gatewayOrigin: requiredOperatorTarget(context.target).integrationOperatorOrigin,
    identity,
    privateJwkPath: context.operatorPrivateJwkPath,
    fetcher: context.fetcher,
    now: () => context.clock().getTime(),
  });
  const status = record(result, "gateway recovery apply response");
  return {
    kind: "takoserver.exact-artifact-recovery-effect@v1",
    action: "invoke",
    phase: oneOf(
      status.phase,
      ["eligible", "prepared", "settling", "blocked", "complete", "revoked"] as const,
      "gateway recovery apply phase",
    ),
    nextAction: oneOf(
      status.action,
      ["prepare", "wait", "settle", "reconcile_absent", "rearm", "complete", "none"] as const,
      "gateway recovery next action",
    ),
    ...(typeof status.blocker === "string" ? { blocker: status.blocker } : {}),
  };
}

async function retireRecoveryWorker(
  context: ExactRecoveryRuntimeContext,
  before: ExactArtifactRecoveryDeploymentSnapshot,
): Promise<Record<string, unknown>> {
  if (
    before.worker.state !== "ready" ||
    before.gateway.state !== "ordinary" ||
    before.receipt?.phase !== "complete" ||
    before.receipt.detailState !== "purged" ||
    before.receipt.activeWorkerVersionId !== before.worker.versionId
  ) {
    throw preflightError("exact recovery Worker retirement prerequisites changed");
  }
  const workerName = requiredRecoveryTarget(context.target).workerName;
  const root = operationRoot(context, "worker-retire");
  const configPath = writeExactArtifactRecoveryWorkerConfig({
    path: join(root, "wrangler.jsonc"),
    main: resolve(REPOSITORY, "src/entry-exact-artifact-recovery-worker.ts"),
    target: context.target,
    request: context.loaded.request,
    requestDigest: context.loaded.requestDigest,
    ...(before.worker.handoff === null ? {} : { handoff: before.worker.handoff }),
  });
  const expectedHistory = await readWorkerHistory(context.state, workerName);
  if (expectedHistory?.versionId !== before.worker.versionId) {
    throw preflightError("exact recovery Worker changed before retirement");
  }
  const lease = await recoveryPublicationLease(context, workerName);
  try {
    const fenced = await inspectExactArtifactRecoveryDeployment(context);
    if (
      fenced.worker.state !== "ready" ||
      fenced.worker.versionId !== before.worker.versionId ||
      fenced.gateway.state !== "ordinary" ||
      fenced.receipt?.phase !== "complete" ||
      fenced.receipt.detailState !== "purged"
    ) {
      throw preflightError("exact recovery Worker retirement re-fence failed");
    }
    const deleted = await context.run(
      wranglerCommand(["delete", "--name", workerName, "--config", configPath, "--force"]),
      { env: context.childEnvironment },
    );
    if (deleted.exitCode !== 0) {
      throw mutationError(
        "exact recovery Worker delete acknowledgement is indeterminate; run --status",
        `exit=${deleted.exitCode}`,
      );
    }
    const after = await inspectRecoveryWorker(context.state, context.target, context.loaded);
    if (after.state !== "absent") {
      throw verificationError("exact recovery Worker remains after acknowledged retirement");
    }
    return {
      kind: "takoserver.exact-artifact-recovery-effect@v1",
      action: "retire_worker",
      workerName,
      versionId: before.worker.versionId,
    };
  } finally {
    await lease.release();
  }
}

async function purgeRecoveryDetails(
  context: ExactRecoveryRuntimeContext,
  before: ExactArtifactRecoveryDeploymentSnapshot,
): Promise<Record<string, unknown>> {
  if (
    before.worker.state !== "ready" ||
    before.gateway.state !== "recovery" ||
    before.gateway.recoveryWorkerVersionId !== before.worker.versionId ||
    before.receipt?.phase !== "complete" ||
    before.receipt.detailState !== "active" ||
    before.receipt.activeWorkerVersionId !== before.worker.versionId ||
    before.receipt.purgeAfter === null ||
    before.now < before.receipt.purgeAfter
  ) {
    throw preflightError("exact recovery detail GC prerequisites changed");
  }
  const recoveryWorkerName = requiredRecoveryTarget(context.target).workerName;
  const gatewayWorkerName = requiredOperatorTarget(context.target).integrationOperatorWorkerName;
  const leases: WranglerVersionPublicationLease[] = [];
  try {
    // All legitimate publication/retirement paths take the same per-Worker
    // host lease. A deterministic order also lets concurrent GC callers
    // serialize without introducing a two-lock deadlock.
    for (const workerName of [recoveryWorkerName, gatewayWorkerName].sort()) {
      leases.push(await recoveryPublicationLease(context, workerName));
    }
    const fenced = await inspectExactArtifactRecoveryDeployment(context);
    if (
      fenced.worker.state !== "ready" ||
      fenced.worker.versionId !== before.worker.versionId ||
      fenced.gateway.state !== "recovery" ||
      fenced.gateway.recoveryWorkerVersionId !== before.worker.versionId ||
      fenced.receipt?.phase !== "complete" ||
      fenced.receipt.detailState !== "active" ||
      fenced.receipt.activeWorkerVersionId !== before.worker.versionId ||
      fenced.receipt.purgeAfter === null ||
      fenced.now < fenced.receipt.purgeAfter ||
      fenced.requestDigest !== before.requestDigest
    ) {
      throw preflightError("exact recovery detail GC service-binding re-fence failed");
    }
    const identity = await readRecoveryPublicIdentity(context);
    const raw = await runExactArtifactRecoveryOperator({
      action: "purge",
      requestPath: context.requestPath,
      workerVersionId: before.worker.versionId,
      gatewayOrigin: requiredOperatorTarget(context.target).integrationOperatorOrigin,
      identity,
      privateJwkPath: context.operatorPrivateJwkPath,
      fetcher: context.fetcher,
      now: () => context.clock().getTime(),
    });
    const result = record(raw, "gateway recovery purge response");
    if (result.outcome === "blocked") {
      throw preflightError(
        `exact recovery detail GC is blocked by ${exactText(result.blocker, "purge blocker")}`,
      );
    }
    const outcome = oneOf(
      result.outcome,
      ["purged", "already_purged"] as const,
      "recovery purge outcome",
    );
    return {
      kind: "takoserver.exact-artifact-recovery-effect@v1",
      action: "purge_details",
      outcome,
      requestDigest: exactDigest(result.requestDigest, "purged recovery request"),
      resultSetDigest: exactDigest(result.resultSetDigest, "purged recovery result set"),
    };
  } finally {
    for (const lease of leases.reverse()) await lease.release();
  }
}

async function ordinaryGatewayConfigurationDigest(target: DeployTarget): Promise<Digest> {
  const authority = requiredOperatorTarget(target);
  return await canonicalDigest({
    kind: "takoserver.exact-artifact-recovery-ordinary-gateway-configuration@v1",
    workerName: authority.integrationOperatorWorkerName,
    operatorOrigin: authority.integrationOperatorOrigin,
    workersDev: false,
    previewUrls: false,
    compatibilityDate: "2026-08-17",
    compatibilityFlags: ["nodejs_compat"],
    bindings: expectedRecoveryGatewayBindings(target, null),
  });
}

async function recoveryPublicationLease(
  context: ExactRecoveryRuntimeContext,
  workerName: string,
): Promise<WranglerVersionPublicationLease> {
  return context.publicationLease
    ? await context.publicationLease(workerName)
    : await acquireWranglerVersionPublicationLease({
        accountId: context.target.accountId,
        workerName,
      });
}

async function readWorkerHistory(
  state: ExactArtifactRecoveryCloudflareState,
  workerName: string,
): Promise<WorkerDeploymentHistory | null> {
  return parseWorkerDeploymentHistory(await state.workerDeployments(workerName), "preflight");
}

function sameHistory(
  left: WorkerDeploymentHistory | null,
  right: WorkerDeploymentHistory | null,
): boolean {
  return (
    (left === null) === (right === null) &&
    (left === null ||
      (right !== null &&
        left.deploymentId === right.deploymentId &&
        left.versionId === right.versionId &&
        left.previousVersionId === right.previousVersionId))
  );
}

function operationRoot(context: ExactRecoveryRuntimeContext, label: string): string {
  const nonce = context.randomId();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(nonce) || nonce === "." || nonce === "..") {
    throw preflightError("exact artifact recovery operation identifier is invalid");
  }
  const path = join(context.root, `${label}-${nonce}`);
  mkdirSync(path, { recursive: false, mode: 0o700 });
  return path;
}

function recoveryWorkerMessage(
  commit: string,
  bundleDigestHex: string,
  requestDigest: Digest,
): string {
  if (
    !/^[0-9a-f]{40}$/u.test(commit) ||
    !/^[0-9a-f]{64}$/u.test(bundleDigestHex) ||
    !isSha256Digest(requestDigest)
  ) {
    throw preflightError("exact recovery Worker publication identity is invalid");
  }
  return `takoserver-exact-artifact-recovery:${commit}:${bundleDigestHex}:${requestDigest.slice(7)}`;
}

async function deploymentStatus(
  invocation: ExactArtifactRecoveryDeployInvocation,
  snapshot: ExactArtifactRecoveryDeploymentSnapshot,
  planned: ExactArtifactRecoveryDeploymentPlan,
  target: DeployTarget,
): Promise<Record<string, unknown>> {
  const quiescenceEvidenceDigest =
    planned.action === "publish_handoff_worker" &&
    snapshot.worker.state === "ready" &&
    snapshot.gateway.state === "ordinary"
      ? await exactArtifactRecoveryQuiescenceEvidenceDigest({
          requestDigest: snapshot.requestDigest,
          recoveryWorkerName: requiredRecoveryTarget(target).workerName,
          recoveryWorkerVersionId: snapshot.worker.versionId,
          gatewayWorkerName: requiredOperatorTarget(target).integrationOperatorWorkerName,
          ordinaryGatewayVersionId: snapshot.gateway.versionId,
          ordinaryConfigurationDigest: await ordinaryGatewayConfigurationDigest(target),
        })
      : null;
  return {
    kind: "takoserver.exact-artifact-recovery-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    requestDigest: snapshot.requestDigest,
    executorReady: snapshot.executorReady,
    recoveryWorkerName: requiredRecoveryTarget(target).workerName,
    recoveryWorkerState: snapshot.worker.state,
    recoveryWorkerVersionId: snapshot.worker.state === "ready" ? snapshot.worker.versionId : null,
    gatewayWorkerName: requiredOperatorTarget(target).integrationOperatorWorkerName,
    gatewayState: snapshot.gateway.state,
    gatewayVersionId: snapshot.gateway.state === "drift" ? null : snapshot.gateway.versionId,
    receipt:
      snapshot.receipt === null
        ? null
        : {
            phase: snapshot.receipt.phase,
            detailState: snapshot.receipt.detailState,
            activeWorkerVersionId: snapshot.receipt.activeWorkerVersionId,
            purgeAfter: snapshot.receipt.purgeAfter,
            resultSetDigest: snapshot.receipt.resultSetDigest,
            nextCandidate: snapshot.receipt.nextCandidate ?? null,
          },
    recoveryStatus:
      snapshot.recoveryStatus === null
        ? null
        : {
            phase: snapshot.recoveryStatus.phase,
            action: snapshot.recoveryStatus.action,
            ...(snapshot.recoveryStatus.blocker === undefined
              ? {}
              : { blocker: snapshot.recoveryStatus.blocker }),
          },
    plan: planned,
    quiescenceEvidenceDigest,
  };
}

function assertDeploymentAdvanced(
  action: Exclude<
    ExactArtifactRecoveryDeploymentAction,
    "refuse" | "wait" | "wait_retention" | "none"
  >,
  before: ExactArtifactRecoveryDeploymentSnapshot,
  after: ExactArtifactRecoveryDeploymentSnapshot,
): void {
  if (
    !after.executorReady ||
    after.requestDigest !== before.requestDigest ||
    after.selectedCommit !== before.selectedCommit
  ) {
    throw verificationError("exact artifact recovery authority changed after mutation");
  }
  const advanced = (() => {
    switch (action) {
      case "publish_worker":
        return before.worker.state === "absent" && after.worker.state === "ready";
      case "publish_handoff_worker":
        return (
          before.worker.state === "ready" &&
          after.worker.state === "ready" &&
          after.worker.versionId !== before.worker.versionId &&
          after.worker.handoff?.predecessorWorkerVersionId === before.worker.versionId
        );
      case "publish_gateway":
        return (
          after.worker.state === "ready" &&
          after.gateway.state === "recovery" &&
          after.gateway.recoveryWorkerVersionId === after.worker.versionId &&
          after.gateway.requestDigest === after.requestDigest
        );
      case "retire_gateway_for_handoff":
      case "retire_gateway":
        return after.gateway.state === "ordinary";
      case "retire_worker":
        return after.worker.state === "absent" && after.gateway.state === "ordinary";
      case "purge_details":
        return after.receipt?.detailState === "purged";
      case "invoke":
        return canonicalJson(recoveryProgress(before)) !== canonicalJson(recoveryProgress(after));
    }
  })();
  if (!advanced) {
    throw verificationError(
      `exact artifact recovery ${action} did not advance authoritative state`,
    );
  }
}

function recoveryProgress(snapshot: ExactArtifactRecoveryDeploymentSnapshot): unknown {
  return {
    receipt: snapshot.receipt,
    recoveryStatus: snapshot.recoveryStatus,
    worker: snapshot.worker,
    gateway: snapshot.gateway,
  };
}

function redactEffect(value: unknown): Record<string, unknown> {
  const input = record(value, "deployment effect");
  const allowed = [
    "kind",
    "action",
    "workerName",
    "versionId",
    "deploymentId",
    "previousVersionId",
    "phase",
    "nextAction",
    "blocker",
    "outcome",
    "requestDigest",
    "resultSetDigest",
  ] as const;
  return Object.fromEntries(
    allowed.filter((name) => Object.hasOwn(input, name)).map((name) => [name, input[name]]),
  );
}

function exactReviewer(value: string): string {
  if (value.length < 3 || value.length > 255 || value.trim() !== value || !value.includes("@")) {
    throw preflightError("exact artifact recovery apply requires an independent reviewer");
  }
  return value;
}

const HANDOFF_BLOCKERS = new Set([
  "recovery_version_not_retired",
  "etag_drift_requires_review",
  "lost_ack_present_requires_review",
  "reviewed_etag_drift",
]);

/** Pure lifecycle planner. Every mutation has an authoritative status state. */
export function planExactArtifactRecoveryDeployment(
  input: ExactArtifactRecoveryDeploymentSnapshot,
): ExactArtifactRecoveryDeploymentPlan {
  if (!input.executorReady) return refuse("the selected provider executor is not exact and ready");
  if (input.worker.state === "drift" || input.gateway.state === "drift") {
    return refuse("the recovery Worker or gateway closure drifted");
  }
  if (
    input.worker.state === "ready" &&
    (input.worker.requestDigest !== input.requestDigest ||
      input.worker.commit !== input.selectedCommit)
  ) {
    return refuse("the recovery Worker immutable identity differs from the selected request");
  }
  if (input.gateway.state === "recovery") {
    if (
      input.worker.state !== "ready" ||
      input.gateway.requestDigest !== input.requestDigest ||
      input.gateway.recoveryWorkerVersionId !== input.worker.versionId
    ) {
      return refuse("the gateway does not pin the exact current recovery Worker");
    }
    const status = input.recoveryStatus;
    if (!status) return refuse("authenticated recovery readback is unavailable");
    if (input.receipt?.phase === "complete") {
      if (
        status.phase !== "complete" ||
        status.action !== "none" ||
        input.receipt.activeWorkerVersionId !== input.worker.versionId ||
        input.receipt.resultSetDigest === null ||
        input.receipt.purgeAfter === null
      ) {
        return refuse("the terminal recovery receipt and authenticated readback differ");
      }
      if (input.receipt.detailState === "purged") {
        return plan(
          "retire_gateway",
          "durable purge readback permits removal of the temporary gateway capability",
        );
      }
      if (input.receipt.detailState !== "active") {
        return refuse("the atomic recovery detail purge is incomplete");
      }
      return input.now < input.receipt.purgeAfter
        ? plan("wait_retention", "the service-bound purge retention deadline has not elapsed")
        : plan("purge_details", "invoke the authenticated binding-backed atomic detail purge");
    }
    if (status.phase === "blocked") {
      return status.blocker && HANDOFF_BLOCKERS.has(status.blocker)
        ? plan(
            "retire_gateway_for_handoff",
            "quiesce the active version before any reviewed lost-ack successor",
          )
        : refuse(`recovery is blocked by ${status.blocker ?? "unknown state"}`);
    }
    if (status.action === "wait") return plan("wait", "the exact quarantine is still active");
    if (
      status.action === "prepare" ||
      status.action === "settle" ||
      status.action === "reconcile_absent" ||
      status.action === "rearm" ||
      status.action === "complete"
    ) {
      return plan("invoke", `apply the exact ${status.action} transition`);
    }
    return refuse("the recovery status is not actionable");
  }

  if (input.worker.state === "absent") {
    if (!input.receipt)
      return plan("publish_worker", "publish the incident-pinned route-less Worker");
    if (input.receipt.phase !== "complete") {
      return refuse("a nonterminal authorization survives without its recovery Worker");
    }
    if (input.receipt.detailState === "purged") {
      return plan("none", "the compact terminal singleton is the only retained state");
    }
    return refuse("the recovery Worker retired before its binding-backed detail purge completed");
  }

  if (!input.receipt) {
    return plan("publish_gateway", "attach the temporary authenticated gateway capability");
  }
  if (input.receipt.phase === "complete") {
    if (input.receipt.activeWorkerVersionId !== input.worker.versionId) {
      return refuse("the terminal receipt names another active recovery Worker");
    }
    return input.receipt.detailState === "purged"
      ? plan(
          "retire_worker",
          "the ordinary gateway and durable purge readback permit Worker removal",
        )
      : refuse("the gateway capability retired before the binding-backed detail purge completed");
  }
  if (input.receipt.phase === "revoked") return refuse("the recovery authorization is revoked");
  if (
    input.worker.handoff &&
    input.worker.handoff.predecessorWorkerVersionId === input.receipt.activeWorkerVersionId
  ) {
    return plan("publish_gateway", "attach the gateway only after the successor Version is staged");
  }
  if (input.worker.versionId !== input.receipt.activeWorkerVersionId) {
    return refuse(
      "the staged recovery Worker is not a valid successor of the durable active Version",
    );
  }
  return plan(
    "publish_handoff_worker",
    "the old Version is quiesced; a reviewed successor may now be published",
  );
}

export function writeExactArtifactRecoveryWorkerConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly target: DeployTarget;
  readonly request: ArtifactRecoveryRequest;
  readonly requestDigest: Digest;
  readonly handoff?: ArtifactRecoveryLostAckAuthorization;
}): string {
  const recovery = requiredRecoveryTarget(input.target);
  const authority = requiredOperatorTarget(input.target);
  const configuration = {
    name: recovery.workerName,
    main: input.main,
    account_id: input.target.accountId,
    compatibility_date: "2026-08-17",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
    vars: {
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: authority.hostId,
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson(authority.operatorPublicJwk),
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: input.requestDigest,
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST: input.request.r2.identityDigest,
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT: input.request.source.commit,
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION: input.request.source.version,
      ...(input.handoff === undefined
        ? {}
        : { TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK: canonicalJson(input.handoff) }),
    },
    version_metadata: { binding: "WORKER_VERSION" },
    d1_databases: [
      {
        binding: "STATE_DB",
        database_name: input.target.d1.databaseName,
        database_id: input.target.d1.databaseId,
        migrations_dir: resolve(REPOSITORY, "migrations"),
      },
    ],
    r2_buckets: [{ binding: "OBJECTS", bucket_name: input.target.r2.bucketName }],
    services: [
      {
        binding: "PUBLIC_HOST_IDENTITY",
        service: input.target.workerName,
        entrypoint: "PublicHostIdentityEntrypoint",
      },
    ],
  };
  writeFileSync(input.path, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return input.path;
}

export function writeExactArtifactRecoveryGatewayConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly target: DeployTarget;
  readonly commit: string;
  readonly recovery?: { readonly requestDigest: Digest; readonly workerVersionId: string };
}): string {
  const selected = selectedGateway(input.target);
  writeFormAuthorityConfig({
    path: input.path,
    main: input.main,
    invocation: {
      surface: "takoserver-integration-form-authority-operator-worker",
      action: "apply",
      environment: "integration",
      commit: input.commit,
    },
    target: input.target,
    selected,
    capabilityManifestJson: canonicalJson(publicFormCapabilityManifest()),
  });
  if (!input.recovery) return input.path;
  const recovery = requiredRecoveryTarget(input.target);
  const configuration = JSON.parse(readFileSync(input.path, "utf8")) as Record<string, unknown>;
  const vars = record(configuration.vars, "gateway vars");
  const services = array(configuration.services, "gateway services");
  configuration.vars = {
    ...vars,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: input.recovery.requestDigest,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID: input.recovery.workerVersionId,
  };
  configuration.services = [
    ...services,
    {
      binding: "EXACT_ARTIFACT_RECOVERY",
      service: recovery.workerName,
      entrypoint: "ExactArtifactRecoveryEntrypoint",
    },
  ];
  writeFileSync(input.path, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return input.path;
}

/** Exact request-to-target fence shared by status and every mutation re-read. */
export async function assertExactArtifactRecoveryDeployTarget(input: {
  readonly target: DeployTarget;
  readonly request: ArtifactRecoveryRequest;
  readonly requestDigest: Digest;
  readonly commit: string;
}): Promise<void> {
  const recovery = requiredRecoveryTarget(input.target);
  const authority = requiredOperatorTarget(input.target);
  const canonical = await canonicalArtifactRecoveryRequest(input.request);
  if (
    canonical.requestDigest !== input.requestDigest ||
    input.target.environment !== "integration" ||
    input.request.tenantId !== authority.integrationOperatorScope.tenantId ||
    input.request.r2.accountId !== input.target.accountId ||
    input.request.r2.bucketName !== input.target.r2.bucketName ||
    input.request.source.repository !== "takoserver" ||
    input.request.source.commit !== input.commit ||
    canonicalJson(input.request.retentionPolicy) !== canonicalJson(recovery.retentionPolicy)
  ) {
    throw preflightError(
      "exact artifact recovery request does not match the selected deploy target",
    );
  }
}

function selectedGateway(target: DeployTarget): SelectedFormAuthorityTarget {
  const authority = requiredOperatorTarget(target);
  return {
    kind: "operator-gateway",
    workerName: authority.integrationOperatorWorkerName,
    hostId: authority.hostId,
    main: "src/entry-integration-form-authority-operator-worker.ts",
    operatorOrigin: authority.integrationOperatorOrigin,
    authorityWorkerName: authority.integrationWorkerName,
    operatorPublicJwk: authority.operatorPublicJwk,
    operatorScope: authority.integrationOperatorScope,
    policyAuthority: "takoserver-host",
    verificationMode: "integration-fixture",
    verificationAvailable: true,
    productionEligible: false,
  };
}

function requiredRecoveryTarget(
  target: DeployTarget,
): NonNullable<DeployTarget["exactArtifactRecovery"]> {
  if (target.environment !== "integration" || !target.exactArtifactRecovery) {
    throw preflightError("selected target has no integration exact artifact recovery policy");
  }
  return target.exactArtifactRecovery;
}

function requiredOperatorTarget(
  target: DeployTarget,
): Required<
  Pick<
    NonNullable<DeployTarget["formAuthority"]>,
    | "hostId"
    | "integrationWorkerName"
    | "integrationOperatorWorkerName"
    | "integrationOperatorOrigin"
    | "integrationOperatorScope"
    | "operatorPublicJwk"
  >
> {
  const authority = target.formAuthority;
  if (
    !authority?.integrationWorkerName ||
    !authority.integrationOperatorWorkerName ||
    !authority.integrationOperatorOrigin ||
    !authority.integrationOperatorScope ||
    !authority.operatorPublicJwk
  ) {
    throw preflightError("selected target has no complete authenticated integration gateway");
  }
  return {
    hostId: authority.hostId,
    integrationWorkerName: authority.integrationWorkerName,
    integrationOperatorWorkerName: authority.integrationOperatorWorkerName,
    integrationOperatorOrigin: authority.integrationOperatorOrigin,
    integrationOperatorScope: authority.integrationOperatorScope,
    operatorPublicJwk: authority.operatorPublicJwk,
  };
}

function plan(
  action: ExactArtifactRecoveryDeploymentAction,
  reason: string,
): ExactArtifactRecoveryDeploymentPlan {
  return { action, reason };
}

function refuse(reason: string): ExactArtifactRecoveryDeploymentPlan {
  return plan("refuse", reason);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw preflightError(`exact artifact recovery ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw preflightError(`exact artifact recovery ${label} is invalid`);
  return value;
}

function recordOrNull(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw preflightError(`exact artifact recovery ${label} is invalid`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function exactDigest(value: unknown, label: string): Digest {
  if (!isSha256Digest(value)) {
    throw preflightError(`exact artifact recovery ${label} is invalid`);
  }
  return value;
}

function nullableDigest(value: unknown, label: string): Digest | null {
  return value === null ? null : exactDigest(value, label);
}

function exactWorkerVersion(value: unknown, label: string): string {
  if (!isWorkerVersion(value)) {
    throw preflightError(`exact artifact recovery ${label} is invalid`);
  }
  return value;
}

function exactInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw preflightError(`exact artifact recovery ${label} is invalid`);
  }
  return Number(value);
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : exactInteger(value, label);
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw preflightError(`exact artifact recovery ${label} is invalid`);
  }
  return value as T[number];
}

function isWorkerVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function isWorkerName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/u.test(value);
}

function phaseFailure(phase: "preflight" | "verification", message: string): Error {
  return phase === "verification" ? verificationError(message) : preflightError(message);
}
