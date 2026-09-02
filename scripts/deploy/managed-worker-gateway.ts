import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact, type WorkerArtifactProcess } from "./worker-artifact.ts";
import { parseWorkerDeploymentHistory } from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  deployExistingWranglerVersion,
  publishWranglerVersion,
  type WranglerVersionPublicationLease,
} from "./wrangler-state.ts";

export interface ManagedWorkerGatewayInvocation {
  readonly surface: "takoserver-managed-worker-gateway";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly reverse?: boolean;
}

export interface ManagedWorkerGatewayRoute {
  readonly zoneId: string;
  readonly id: string;
  readonly pattern: string;
  readonly script: string | null;
}

export interface ManagedWorkerGatewayRouteState {
  workerRoutes(): Promise<readonly ManagedWorkerGatewayRoute[]>;
  /** Immutable gateway Worker deployment history and Version readback. */
  workerDeployments?(workerName: string): Promise<readonly unknown[]>;
  workerVersion?(workerName: string, versionId: string): Promise<unknown>;
  /** Official Version resource with provider-stored module bytes included. */
  workerVersionWithModules?(workerName: string, versionId: string): Promise<unknown>;
  workerSettings?(workerName: string): Promise<unknown>;
  workerSubdomain?(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }>;
}

export interface ManagedWorkerGatewayMutation {
  create(input: {
    readonly zoneId: string;
    readonly pattern: string;
    readonly script: string;
  }): Promise<void>;
  update(input: {
    readonly zoneId: string;
    readonly id: string;
    readonly pattern: string;
    readonly script: string;
  }): Promise<void>;
}

/**
 * Owner-private state used by this surface.  `CloudflareState` implements this
 * shape; the optional members keep the route planner useful in portable tests
 * that intentionally exercise only exact-pattern classification.
 */
export type ManagedWorkerGatewayState = ManagedWorkerGatewayRouteState;

export type ManagedWorkerGatewayRouteMutationFetcher = (request: Request) => Promise<Response>;

export interface ManagedWorkerGatewayOptions {
  readonly state?: ManagedWorkerGatewayState;
  readonly mutate?: ManagedWorkerGatewayMutation;
  readonly accountId?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  /** Provider identity carried as an explicit Worker variable. */
  readonly providerId?: string;
  /** Dispatch namespace id carried as an explicit Wrangler binding. */
  readonly dispatchNamespace?: string;
  /** Stable gateway identity carried as an explicit Worker variable. */
  readonly gatewayId?: string;
  readonly routePattern?: string;
  readonly gatewayScript?: string;
  readonly legacyScript?: string;
  readonly zoneId?: string;
  /** Concrete Cloudflare route API transport; injectable only for tests. */
  readonly routeMutationFetcher?: ManagedWorkerGatewayRouteMutationFetcher;
  /** Owner command runner; injected in portable tests. */
  readonly run?: WorkerArtifactProcess;
  readonly outputDirectory?: string;
  /** Independent reviewer required for every gateway apply/reversal. */
  readonly review?: string;
  /** Exact target lease injection for portable tests. Production acquires it locally. */
  readonly publicationLease?: WranglerVersionPublicationLease;
}

export type ManagedWorkerGatewayRouteStatus =
  | "absent"
  | "ready"
  | "legacy-adoptable"
  | "reversible"
  | "drift"
  | "ambiguous";

export interface ManagedWorkerGatewayRouteInspection {
  readonly status: ManagedWorkerGatewayRouteStatus;
  readonly pattern: string;
  readonly gatewayScript: string;
  readonly legacyScript: string;
  readonly targetZoneId: string | null;
  readonly matches: readonly ManagedWorkerGatewayRoute[];
  readonly current: ManagedWorkerGatewayRoute | null;
  readonly reversalScript: string | null;
}

/**
 * Classify only the exact route pattern supplied by the operator.  Specific
 * customer routes are intentionally ignored, so Cloudflare's specificity
 * ordering remains untouched.
 */
export function inspectManagedWorkerGatewayRoute(
  routes: readonly ManagedWorkerGatewayRoute[],
  input: {
    readonly pattern: string;
    readonly gatewayScript: string;
    readonly legacyScript: string;
    readonly zoneId?: string;
  },
): ManagedWorkerGatewayRouteInspection {
  const pattern = exactToken(input.pattern, "route pattern");
  const gatewayScript = exactToken(input.gatewayScript, "gateway script");
  const legacyScript = exactToken(input.legacyScript, "legacy script");
  const matches = routes.filter(
    (route) =>
      route.pattern === pattern && (input.zoneId === undefined || route.zoneId === input.zoneId),
  );
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      pattern,
      gatewayScript,
      legacyScript,
      targetZoneId: input.zoneId ?? null,
      matches,
      current: null,
      reversalScript: null,
    };
  }
  const current = matches[0] ?? null;
  if (current === null) {
    return {
      status: "absent",
      pattern,
      gatewayScript,
      legacyScript,
      targetZoneId: input.zoneId ?? null,
      matches,
      current,
      reversalScript: null,
    };
  }
  const status: ManagedWorkerGatewayRouteStatus =
    current.script === gatewayScript
      ? "ready"
      : current.script === legacyScript
        ? "legacy-adoptable"
        : "drift";
  return {
    status,
    pattern,
    gatewayScript,
    legacyScript,
    targetZoneId: current.zoneId,
    matches,
    current,
    reversalScript: current.script === gatewayScript ? legacyScript : null,
  };
}

/** Pure mutation plan used by status/readback tests and the owning runner. */
export function planManagedWorkerGatewayRoute(
  inspection: ManagedWorkerGatewayRouteInspection,
  input: { readonly environment: DeployEnvironment; readonly reverse?: boolean },
): {
  readonly action: "none" | "create" | "adopt" | "reverse" | "refuse";
  readonly reason: string;
  readonly targetScript: string | null;
} {
  if (inspection.status === "ambiguous" || inspection.status === "drift") {
    return {
      action: "refuse",
      reason: `exact gateway route is ${inspection.status}`,
      targetScript: null,
    };
  }
  if (input.reverse) {
    if (input.environment !== "production" || inspection.status !== "ready") {
      return {
        action: "refuse",
        reason: "reverse requires the adopted production route",
        targetScript: null,
      };
    }
    return {
      action: "reverse",
      reason: "restore the recorded legacy script",
      targetScript: inspection.reversalScript,
    };
  }
  if (inspection.status === "ready") {
    return {
      action: "none",
      reason: "exact gateway route is already adopted",
      targetScript: inspection.gatewayScript,
    };
  }
  if (inspection.status === "absent") {
    return {
      action: input.environment === "integration" ? "create" : "refuse",
      reason:
        input.environment === "integration"
          ? "create the exact integration route"
          : "production route is absent; adoption requires an exact live predecessor",
      targetScript: input.environment === "integration" ? inspection.gatewayScript : null,
    };
  }
  if (inspection.status === "legacy-adoptable" && input.environment === "production") {
    return {
      action: "adopt",
      reason: "adopt the exact legacy production route",
      targetScript: inspection.gatewayScript,
    };
  }
  return {
    action: "refuse",
    reason: "integration route is owned by the configured gateway",
    targetScript: null,
  };
}

/**
 * Readback plus one owner-controlled Worker publication followed by an
 * optional route transition. The route is deliberately the last mutation: a
 * route can only point at a Version whose exact code, bindings and topology
 * were already read back from Cloudflare.
 */
export async function runManagedWorkerGateway(
  invocation: ManagedWorkerGatewayInvocation,
  target: DeployTarget,
  options: ManagedWorkerGatewayOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("gateway invocation and target environments differ");
  }
  const reviewer =
    invocation.action === "apply"
      ? exactReviewer(options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"))
      : null;
  const pattern =
    options.routePattern ?? requireEnvironment("TAKOSERVER_MANAGED_WORKER_ROUTE_PATTERN");
  const gatewayScript =
    options.gatewayScript ?? requireEnvironment("TAKOSERVER_MANAGED_WORKER_GATEWAY_SCRIPT");
  const legacyScript =
    options.legacyScript ?? requireEnvironment("TAKOSERVER_MANAGED_WORKER_LEGACY_SCRIPT");
  const zoneId = options.zoneId ?? process.env.TAKOSERVER_MANAGED_WORKER_ZONE_ID;
  const providerId =
    options.providerId ?? process.env.TAKOSERVER_MANAGED_WORKER_PROVIDER_ID ?? null;
  const dispatchNamespace =
    options.dispatchNamespace ?? process.env.TAKOSERVER_MANAGED_WORKER_DISPATCH_NAMESPACE ?? null;
  const gatewayId = options.gatewayId ?? process.env.TAKOSERVER_MANAGED_WORKER_GATEWAY_ID ?? null;
  const cloudflareEnvironment =
    options.cloudflareEnvironment ??
    (options.state !== undefined ? {} : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({
      accountId: options.accountId ?? target.accountId,
      token: exactCloudflareToken(cloudflareEnvironment),
    });
  const inspect = (routes: readonly ManagedWorkerGatewayRoute[]) =>
    inspectManagedWorkerGatewayRoute(routes, {
      pattern,
      gatewayScript,
      legacyScript,
      ...(zoneId === undefined ? {} : { zoneId }),
    });

  let inspection = inspect(await state.workerRoutes());
  let worker = await inspectGatewayWorker("preflight", state, {
    target,
    commit: invocation.commit,
    gatewayScript,
    providerId: providerId ?? "",
    dispatchNamespace: dispatchNamespace ?? "",
    gatewayId: gatewayId ?? "",
  });
  let plan = planManagedWorkerGatewayRoute(inspection, invocation);
  if (invocation.action === "status") {
    return gatewayStatus(invocation, inspection, plan, worker);
  }
  if (plan.action === "refuse" || plan.targetScript === null) {
    throw preflightError(plan.reason);
  }

  // Reverse first restores the exact immutable predecessor from provider
  // history, proves that traffic readback, and only then reverses the route.
  if (invocation.reverse) {
    if (plan.action !== "reverse" || inspection.current === null) {
      throw preflightError(plan.reason);
    }
    worker = await rollbackGatewayWorker({
      invocation,
      target,
      options,
      state,
      cloudflareEnvironment,
      gatewayScript,
      providerId: exactToken(providerId ?? "", "managed Worker provider id"),
      dispatchNamespace: exactToken(dispatchNamespace ?? "", "managed Worker dispatch namespace"),
      gatewayId: exactToken(gatewayId ?? "", "managed Worker gateway id"),
    });
    const mutation =
      options.mutate ??
      createCloudflareManagedWorkerMutation({
        accountId: options.accountId ?? target.accountId,
        token: exactCloudflareToken(cloudflareEnvironment),
        ...(options.routeMutationFetcher === undefined
          ? {}
          : { fetcher: options.routeMutationFetcher }),
      });
    await mutation.update({
      zoneId: inspection.current.zoneId,
      id: inspection.current.id,
      pattern: inspection.current.pattern,
      script: plan.targetScript,
    });
    inspection = inspect(await state.workerRoutes());
    if (inspection.current?.script !== inspection.legacyScript) {
      throw verificationError(
        "managed gateway route reversal readback did not restore legacy script",
      );
    }
    return gatewayApply(invocation, inspection, plan, true, worker, reviewer);
  }

  if (!worker.ready) {
    const run = options.run ?? runCommand;
    const source = await qualifySource({
      environment: invocation.environment,
      commit: invocation.commit,
      run,
    });
    const configuredProviderId = exactToken(providerId ?? "", "managed Worker provider id");
    const configuredDispatchNamespace = exactToken(
      dispatchNamespace ?? "",
      "managed Worker dispatch namespace",
    );
    const configuredGatewayId = exactToken(gatewayId ?? "", "managed Worker gateway id");
    await runOwnerGate(run);
    const temporary = options.outputDirectory === undefined;
    const root =
      options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-managed-gateway-"));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      const prepared = await prepareWorkerArtifact({
        root,
        target,
        commit: source.commit,
        main: resolve(REPOSITORY, "src/entry-cloudflare-managed-worker-gateway.ts"),
        run,
        writeConfig: ({ path, main, bundleDigestHex }) =>
          writeManagedGatewayConfig({
            path,
            main,
            ...(bundleDigestHex === undefined ? {} : { bundleDigestHex }),
            target,
            gatewayScript,
            dispatchNamespace: configuredDispatchNamespace,
            providerId: configuredProviderId,
            gatewayId: configuredGatewayId,
            environment: invocation.environment,
          }),
      });
      const artifact = prepared.seal();
      artifact.assertUnchanged();
      const expectedModule = expectedGatewayModule(prepared.bundlePath, prepared.bundleDigestHex);
      const predecessor = await readGatewayHistory("preflight", state, gatewayScript);
      const beforeUpload = await inspectGatewayWorker("preflight", state, {
        target,
        commit: source.commit,
        gatewayScript,
        providerId: configuredProviderId,
        dispatchNamespace: configuredDispatchNamespace,
        gatewayId: configuredGatewayId,
        bundleDigestHex: prepared.bundleDigestHex,
        expectedModule,
      });
      if (!gatewayInspectionMatchesHistory(beforeUpload, predecessor)) {
        throw preflightError("gateway Worker predecessor changed during artifact build");
      }
      if (beforeUpload.ready) {
        worker = beforeUpload;
      } else {
        const publicationLease =
          options.publicationLease ??
          (await acquireWranglerVersionPublicationLease({
            accountId: options.accountId ?? target.accountId,
            workerName: gatewayScript,
            root: join(root, "publication-lease"),
          }));
        let publication: Awaited<ReturnType<typeof publishWranglerVersion>>;
        try {
          publication = await publishWranglerVersion({
            root,
            bundlePath: prepared.bundlePath,
            configPath: prepared.configPath,
            accountId: options.accountId ?? target.accountId,
            workerName: gatewayScript,
            message: `takoserver-managed-worker-gateway:${source.commit}:${prepared.bundleDigestHex}`,
            lease: publicationLease,
            environment: cloudflareEnvironment,
            run,
            assertUploadedVersion: async (versionId) => {
              artifact.assertUnchanged();
              const staged = await inspectGatewayVersion(
                "verification",
                state,
                {
                  target,
                  commit: source.commit,
                  gatewayScript,
                  providerId: configuredProviderId,
                  dispatchNamespace: configuredDispatchNamespace,
                  gatewayId: configuredGatewayId,
                  bundleDigestHex: prepared.bundleDigestHex,
                  allowInheritedMigration: beforeUpload.settingsExact,
                  expectedModule,
                },
                versionId,
              );
              if (!staged.ready || !staged.codeExact) {
                throw verificationError("staged gateway Version is not the sealed artifact");
              }
            },
            assertPredecessorStillCurrent: async () => {
              const current = await readGatewayHistory("preflight", state, gatewayScript);
              if (!sameGatewayHistory(current, predecessor)) {
                throw preflightError("gateway Worker predecessor changed during Version staging");
              }
            },
          });
        } finally {
          await publicationLease.release();
        }
        artifact.assertUnchanged();
        const afterUpload = await inspectGatewayWorker("verification", state, {
          target,
          commit: source.commit,
          gatewayScript,
          providerId: configuredProviderId,
          dispatchNamespace: configuredDispatchNamespace,
          gatewayId: configuredGatewayId,
          bundleDigestHex: prepared.bundleDigestHex,
          expectedModule,
        });
        if (!afterUpload.ready) {
          throw verificationError("gateway Worker readback does not match the sealed upload");
        }
        if (
          afterUpload.versionId !== publication.versionId ||
          afterUpload.deploymentId !== publication.deploymentId ||
          afterUpload.previousVersionId !== (predecessor?.versionId ?? null)
        ) {
          throw verificationError(
            "gateway traffic deployment history does not match publication",
            JSON.stringify({
              expectedVersionId: publication.versionId,
              expectedDeploymentId: publication.deploymentId,
              expectedPreviousVersionId: predecessor?.versionId ?? null,
              actualVersionId: afterUpload.versionId,
              actualDeploymentId: afterUpload.deploymentId,
              actualPreviousVersionId: afterUpload.previousVersionId,
            }),
          );
        }
        worker = afterUpload;
      }
      worker.artifactDigest = artifact.digest;
      // Close the route race as well: route ownership may have changed while
      // the immutable Worker was being built and uploaded. Re-plan from the
      // authoritative inventory immediately before any route mutation.
      inspection = inspect(await state.workerRoutes());
      plan = planManagedWorkerGatewayRoute(inspection, invocation);
      if (plan.action === "refuse" || plan.targetScript === null) {
        throw preflightError(plan.reason);
      }
    } finally {
      if (temporary) rmSync(root, { recursive: true, force: true });
    }
  }

  if (plan.action === "none") {
    return gatewayApply(invocation, inspection, plan, false, worker, reviewer);
  }
  const mutation =
    options.mutate ??
    createCloudflareManagedWorkerMutation({
      accountId: options.accountId ?? target.accountId,
      token: exactCloudflareToken(cloudflareEnvironment),
      ...(options.routeMutationFetcher === undefined
        ? {}
        : { fetcher: options.routeMutationFetcher }),
    });
  const current = inspection.current;
  if (plan.action === "create") {
    if (zoneId === undefined) {
      throw preflightError(
        "integration gateway route creation requires TAKOSERVER_MANAGED_WORKER_ZONE_ID",
      );
    }
    await mutation.create({ zoneId, pattern: inspection.pattern, script: plan.targetScript });
  } else if (plan.action === "adopt" && current !== null) {
    await mutation.update({
      zoneId: current.zoneId,
      id: current.id,
      pattern: current.pattern,
      script: plan.targetScript,
    });
  } else {
    throw preflightError("managed gateway route transition is not actionable");
  }
  inspection = inspect(await state.workerRoutes());
  if (inspection.status !== "ready") {
    throw verificationError(
      "managed gateway route readback does not match the requested transition",
    );
  }
  return gatewayApply(invocation, inspection, plan, true, worker, reviewer);
}

function sameGatewayHistory(
  left: ReturnType<typeof parseWorkerDeploymentHistory>,
  right: ReturnType<typeof parseWorkerDeploymentHistory>,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.deploymentId === right.deploymentId &&
    left.versionId === right.versionId &&
    left.previousVersionId === right.previousVersionId
  );
}

function gatewayInspectionMatchesHistory(
  inspection: GatewayWorkerInspection,
  history: ReturnType<typeof parseWorkerDeploymentHistory>,
): boolean {
  if (history === null) {
    return (
      inspection.versionId === null &&
      inspection.deploymentId === null &&
      inspection.previousVersionId === null
    );
  }
  return (
    inspection.versionId === history.versionId &&
    inspection.deploymentId === history.deploymentId &&
    inspection.previousVersionId === history.previousVersionId
  );
}

function expectedGatewayModule(
  bundlePath: string,
  digestHex: string,
): NonNullable<GatewayWorkerReadbackInput["expectedModule"]> {
  const bytes = Uint8Array.from(readFileSync(bundlePath));
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== digestHex) {
    throw preflightError("sealed gateway bundle digest changed before provider readback");
  }
  return {
    name: "worker.js",
    contentType: "application/javascript+module",
    bytes,
    digestHex,
  };
}

async function rollbackGatewayWorker(input: {
  readonly invocation: ManagedWorkerGatewayInvocation;
  readonly target: DeployTarget;
  readonly options: ManagedWorkerGatewayOptions;
  readonly state: ManagedWorkerGatewayState;
  readonly cloudflareEnvironment: Readonly<Record<string, string>>;
  readonly gatewayScript: string;
  readonly providerId: string;
  readonly dispatchNamespace: string;
  readonly gatewayId: string;
}): Promise<GatewayWorkerInspection> {
  const { invocation, target, options, state, gatewayScript } = input;
  const current = await readGatewayHistory("preflight", state, gatewayScript);
  if (current === null || current.previousVersionId === null) {
    throw preflightError("gateway Worker has no authoritative rollback predecessor");
  }

  // The predecessor is selected only from Cloudflare deployment history. Its
  // own immutable Version must be healthy, but the broken successor does not
  // need to be importable or otherwise ready for rollback to proceed.
  const predecessor = await inspectGatewayVersion(
    "preflight",
    state,
    {
      target,
      gatewayScript,
      providerId: input.providerId,
      dispatchNamespace: input.dispatchNamespace,
      gatewayId: input.gatewayId,
    },
    current.previousVersionId,
  );
  if (
    !predecessor.bindingsExact ||
    !predecessor.settingsExact ||
    predecessor.moduleBytes === null ||
    predecessor.moduleDigestHex === null ||
    predecessor.commit === null ||
    predecessor.bundleDigestHex === null ||
    predecessor.bundleDigestHex !== predecessor.moduleDigestHex
  ) {
    throw preflightError("gateway Worker rollback predecessor is not an exact managed gateway");
  }

  const run = options.run ?? runCommand;
  await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  await runOwnerGate(run);
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-gateway-rollback-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const configPath = join(root, "wrangler.rollback.jsonc");
    writeManagedGatewayConfig({
      path: configPath,
      main: resolve(REPOSITORY, "src/entry-cloudflare-managed-worker-gateway.ts"),
      target,
      gatewayScript,
      dispatchNamespace: input.dispatchNamespace,
      providerId: input.providerId,
      gatewayId: input.gatewayId,
      environment: invocation.environment,
    });
    const lease =
      options.publicationLease ??
      (await acquireWranglerVersionPublicationLease({
        accountId: options.accountId ?? target.accountId,
        workerName: gatewayScript,
        root: join(root, "publication-lease"),
      }));
    let deployment: Awaited<ReturnType<typeof deployExistingWranglerVersion>>;
    try {
      deployment = await deployExistingWranglerVersion({
        root,
        configPath,
        accountId: options.accountId ?? target.accountId,
        workerName: gatewayScript,
        versionId: current.previousVersionId,
        message: `takoserver-managed-worker-gateway:rollback:${current.versionId}`,
        lease,
        environment: input.cloudflareEnvironment,
        run,
        assertCurrentStillExpected: async () => {
          const latest = await readGatewayHistory("preflight", state, gatewayScript);
          if (!sameGatewayHistory(latest, current)) {
            throw preflightError("gateway Worker changed before rollback traffic mutation");
          }
        },
      });
    } finally {
      await lease.release();
    }

    const restoredHistory = await readGatewayHistory("verification", state, gatewayScript);
    if (
      restoredHistory === null ||
      restoredHistory.versionId !== current.previousVersionId ||
      restoredHistory.deploymentId !== deployment.deploymentId ||
      restoredHistory.previousVersionId !== current.versionId
    ) {
      throw verificationError(
        "gateway Worker rollback history does not identify the exact predecessor",
      );
    }
    const restored = await inspectGatewayVersion(
      "verification",
      state,
      {
        target,
        gatewayScript,
        providerId: input.providerId,
        dispatchNamespace: input.dispatchNamespace,
        gatewayId: input.gatewayId,
        commit: predecessor.commit,
        bundleDigestHex: predecessor.bundleDigestHex,
        expectedModule: {
          name: "worker.js",
          contentType: "application/javascript+module",
          bytes: predecessor.moduleBytes,
          digestHex: predecessor.moduleDigestHex,
        },
      },
      restoredHistory.versionId,
    );
    if (!restored.ready || !restored.codeExact) {
      throw verificationError(
        "gateway Worker rollback Version readback is not the exact predecessor",
      );
    }
    return {
      ...restored,
      deploymentId: restoredHistory.deploymentId,
      previousVersionId: restoredHistory.previousVersionId,
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

function gatewayStatus(
  invocation: ManagedWorkerGatewayInvocation,
  inspection: ManagedWorkerGatewayRouteInspection,
  plan: ReturnType<typeof planManagedWorkerGatewayRoute>,
  worker: GatewayWorkerInspection,
): Record<string, unknown> {
  return {
    kind: "takoserver.managed-worker-gateway-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    routePattern: inspection.pattern,
    gatewayScript: inspection.gatewayScript,
    legacyScript: inspection.legacyScript,
    routeStatus: inspection.status,
    workerStatus: worker.status,
    workerReady: worker.ready,
    ready: inspection.status === "ready" && worker.ready,
    workerVersionId: worker.versionId,
    workerDeploymentId: worker.deploymentId,
    workerPreviousVersionId: worker.previousVersionId,
    workerCommit: worker.commit,
    workerBundleDigest: worker.bundleDigestHex,
    workerCodeEtag: worker.codeEtag,
    workerModuleDigest: worker.moduleDigestHex,
    workerCodeExact: worker.codeExact,
    workerBindingsExact: worker.bindingsExact,
    workerSettingsExact: worker.settingsExact,
    current: inspection.current,
    reversalScript: inspection.reversalScript,
    plan: plan.action,
  };
}

function gatewayApply(
  invocation: ManagedWorkerGatewayInvocation,
  inspection: ManagedWorkerGatewayRouteInspection,
  plan: ReturnType<typeof planManagedWorkerGatewayRoute>,
  mutated: boolean,
  worker: GatewayWorkerInspection,
  reviewer: string | null,
): Record<string, unknown> {
  return {
    kind: "takoserver.managed-worker-gateway-apply@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    commit: invocation.commit,
    reviewer,
    routePattern: inspection.pattern,
    routeStatus: inspection.status,
    workerStatus: worker.status,
    workerReady: worker.ready,
    workerVersionId: worker.versionId,
    workerDeploymentId: worker.deploymentId,
    workerPreviousVersionId: worker.previousVersionId,
    workerCommit: worker.commit,
    workerBundleDigest: worker.bundleDigestHex,
    workerCodeEtag: worker.codeEtag,
    workerModuleDigest: worker.moduleDigestHex,
    workerCodeExact: worker.codeExact,
    workerArtifactDigest: worker.artifactDigest,
    mutation: mutated ? plan.action : "none",
    previousScript: inspection.current?.script ?? null,
    script: inspection.current?.script ?? inspection.gatewayScript,
    reversal:
      inspection.current?.script === inspection.gatewayScript ? inspection.legacyScript : null,
  };
}

interface GatewayWorkerInspection {
  status: "unavailable" | "absent" | "ready" | "drift" | "malformed";
  ready: boolean;
  versionId: string | null;
  deploymentId: string | null;
  previousVersionId: string | null;
  commit: string | null;
  bundleDigestHex: string | null;
  codeEtag: string | null;
  moduleDigestHex: string | null;
  moduleBytes: Uint8Array | null;
  codeExact: boolean;
  artifactDigest: string | null;
  bindingsExact: boolean;
  settingsExact: boolean;
}

interface GatewayWorkerReadbackInput {
  readonly target: DeployTarget;
  readonly commit?: string;
  readonly gatewayScript: string;
  readonly providerId: string;
  readonly dispatchNamespace: string;
  readonly gatewayId: string;
  readonly bundleDigestHex?: string;
  /** A staged update may omit an already-applied v1 migration payload. */
  readonly allowInheritedMigration?: boolean;
  readonly expectedModule?: {
    readonly name: "worker.js";
    readonly contentType: "application/javascript+module";
    readonly bytes: Uint8Array;
    readonly digestHex: string;
  };
}

async function inspectGatewayWorker(
  phase: "preflight" | "verification",
  state: ManagedWorkerGatewayState,
  input: GatewayWorkerReadbackInput,
): Promise<GatewayWorkerInspection> {
  const unavailable = (): GatewayWorkerInspection => unavailableWorker("unavailable", null);
  if (
    state.workerDeployments === undefined ||
    state.workerVersion === undefined ||
    state.workerVersionWithModules === undefined ||
    state.workerSettings === undefined
  ) {
    return unavailable();
  }
  const history = await readGatewayHistory(phase, state, input.gatewayScript);
  if (history === null) {
    return unavailableWorker("absent", null);
  }
  try {
    return {
      ...(await inspectGatewayVersion(phase, state, input, history.versionId)),
      deploymentId: history.deploymentId,
      previousVersionId: history.previousVersionId,
    };
  } catch (error) {
    if (phase === "verification") throw error;
    return unavailableWorker("malformed", history);
  }
}

async function readGatewayHistory(
  phase: "preflight" | "verification",
  state: ManagedWorkerGatewayState,
  workerName: string,
): Promise<ReturnType<typeof parseWorkerDeploymentHistory>> {
  if (!state.workerDeployments) return null;
  try {
    return parseWorkerDeploymentHistory(await state.workerDeployments(workerName), phase);
  } catch (error) {
    throw phaseError(phase, "gateway Worker deployment history readback failed", error);
  }
}

async function inspectGatewayVersion(
  phase: "preflight" | "verification",
  state: ManagedWorkerGatewayState,
  input: GatewayWorkerReadbackInput,
  versionId: string,
): Promise<GatewayWorkerInspection> {
  if (!state.workerVersion || !state.workerVersionWithModules || !state.workerSettings) {
    return unavailableWorker("unavailable", null);
  }
  let version: unknown;
  let classicVersion: unknown;
  try {
    [version, classicVersion] = await Promise.all([
      state.workerVersionWithModules(input.gatewayScript, versionId),
      state.workerVersion(input.gatewayScript, versionId),
    ]);
  } catch (error) {
    throw phaseError(phase, "gateway Worker Version readback failed", error);
  }
  const identity = gatewayVersionIdentity(phase, version, versionId);
  const module = gatewayModuleClosure(phase, version, input.expectedModule);
  const bindingsExact = gatewayBindingClosure(phase, version, input);
  const settingsExact =
    gatewayVersionSettingsClosure(phase, version, input.allowInheritedMigration === true) &&
    (await gatewaySettingsClosure(phase, state, input.gatewayScript));
  const commitMatches = input.commit === undefined || identity.commit === input.commit;
  const digestMatches =
    input.bundleDigestHex === undefined || identity.bundleDigestHex === input.bundleDigestHex;
  const ready = module.exact && bindingsExact && settingsExact && commitMatches && digestMatches;
  return {
    status: ready ? "ready" : "drift",
    ready,
    versionId,
    deploymentId: null,
    previousVersionId: null,
    commit: identity.commit,
    bundleDigestHex: identity.bundleDigestHex,
    codeEtag: gatewayClassicEtag(classicVersion),
    moduleDigestHex: module.digestHex,
    moduleBytes: module.bytes,
    codeExact: module.exact,
    artifactDigest: null,
    bindingsExact,
    settingsExact,
  };
}

function unavailableWorker(
  status: "unavailable" | "absent" | "malformed",
  history: ReturnType<typeof parseWorkerDeploymentHistory>,
): GatewayWorkerInspection {
  return {
    status,
    ready: false,
    versionId: history?.versionId ?? null,
    deploymentId: history?.deploymentId ?? null,
    previousVersionId: history?.previousVersionId ?? null,
    commit: null,
    bundleDigestHex: null,
    codeEtag: null,
    moduleDigestHex: null,
    moduleBytes: null,
    codeExact: false,
    artifactDigest: null,
    bindingsExact: false,
    settingsExact: false,
  };
}

function gatewayVersionIdentity(
  phase: "preflight" | "verification",
  value: unknown,
  versionId: string,
): { readonly commit: string; readonly bundleDigestHex: string } {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    throw phaseError(phase, "gateway Worker Version has no canonical annotations");
  }
  const message = value.annotations["workers/message"];
  if (typeof message !== "string") {
    throw phaseError(phase, "gateway Worker Version has no canonical upload message");
  }
  const match = /^takoserver-managed-worker-gateway:([0-9a-f]{40}):([0-9a-f]{64})$/u.exec(message);
  if (!match?.[1] || !match[2]) {
    throw phaseError(phase, "gateway Worker Version has an invalid upload message");
  }
  if (value.id !== versionId) {
    throw phaseError(phase, "gateway Worker Version detail has an unexpected identity");
  }
  return { commit: match[1], bundleDigestHex: match[2] };
}

function gatewayClassicEtag(value: unknown): string | null {
  const resources = isRecord(value) && isRecord(value.resources) ? value.resources : null;
  const script = resources && isRecord(resources.script) ? resources.script : null;
  const etag = script?.etag;
  return typeof etag === "string" && etag.length >= 1 && etag.length <= 4_096 ? etag : null;
}

function gatewayModuleClosure(
  phase: "preflight" | "verification",
  value: unknown,
  expected: GatewayWorkerReadbackInput["expectedModule"],
): { readonly bytes: Uint8Array; readonly digestHex: string; readonly exact: boolean } {
  if (!isRecord(value) || value.main_module !== "worker.js" || !Array.isArray(value.modules)) {
    throw phaseError(phase, "gateway Worker Version has no canonical module closure");
  }
  if (value.modules.length !== 1 || !isRecord(value.modules[0])) {
    throw phaseError(phase, "gateway Worker Version module closure is not exact");
  }
  const module = value.modules[0];
  if (
    Object.keys(module).sort().join(",") !== "content_base64,content_type,name" ||
    module.name !== "worker.js" ||
    module.content_type !== "application/javascript+module" ||
    typeof module.content_base64 !== "string"
  ) {
    throw phaseError(phase, "gateway Worker Version module closure is malformed");
  }
  const bytes = strictBase64Bytes(module.content_base64);
  if (!bytes) throw phaseError(phase, "gateway Worker Version module bytes are malformed");
  const digestHex = createHash("sha256").update(bytes).digest("hex");
  const exact =
    expected !== undefined &&
    expected.name === module.name &&
    expected.contentType === module.content_type &&
    expected.digestHex === digestHex &&
    sameBytes(bytes, expected.bytes);
  return { bytes, digestHex, exact };
}

function gatewayVersionSettingsClosure(
  phase: "preflight" | "verification",
  value: unknown,
  allowInheritedMigration: boolean,
): boolean {
  if (!isRecord(value)) {
    throw phaseError(phase, "gateway Worker Version settings are malformed");
  }
  const flags = value.compatibility_flags;
  const migrationsExact = gatewayVersionMigrationsExact(value.migrations);
  const migrationTagExact = value.migration_tag === "v1";
  const appliedMigrationMarker =
    isRecord(value.migrations) && Object.keys(value.migrations).length === 0;
  const migrationClosureExact =
    (migrationTagExact &&
      (value.migrations === undefined || appliedMigrationMarker || migrationsExact)) ||
    (value.migration_tag === undefined &&
      (migrationsExact || (allowInheritedMigration && value.migrations === undefined)));
  if (
    value.compatibility_date !== "2026-08-31" ||
    !Array.isArray(flags) ||
    flags.length !== 1 ||
    flags[0] !== "nodejs_compat" ||
    !migrationClosureExact ||
    value.assets !== undefined ||
    value.placement !== undefined
  ) {
    throw phaseError(phase, "gateway Worker Version settings closure is not exact");
  }
  return true;
}

function gatewayVersionMigrationsExact(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "new_tag,steps") return false;
  if (value.new_tag !== "v1" || !Array.isArray(value.steps) || value.steps.length !== 1) {
    return false;
  }
  const step = value.steps[0];
  return (
    isRecord(step) &&
    Object.keys(step).join(",") === "new_sqlite_classes" &&
    Array.isArray(step.new_sqlite_classes) &&
    step.new_sqlite_classes.length === 1 &&
    step.new_sqlite_classes[0] === "TakoserverManagedWorkerSqlite"
  );
}

function gatewayBindingClosure(
  phase: "preflight" | "verification",
  value: unknown,
  input: GatewayWorkerReadbackInput,
): boolean {
  if (!isRecord(value)) {
    throw phaseError(phase, "gateway Worker Version has no canonical binding inventory");
  }
  const rawBindings = value.bindings;
  if (!Array.isArray(rawBindings)) {
    throw phaseError(phase, "gateway Worker Version has no canonical binding inventory");
  }
  const expected: Readonly<Record<string, BindingExpectation>> = {
    STATE_DB: { type: "d1", fields: { database_id: input.target.d1.databaseId } },
    DISPATCHER: {
      type: "dispatch_namespace",
      fields: { namespace: input.dispatchNamespace },
    },
    SQLITE_DATABASES: {
      type: "durable_object_namespace",
      fields: { class_name: "TakoserverManagedWorkerSqlite" },
    },
    MANAGED_PROVIDER_ID: { type: "plain_text", fields: { text: input.providerId } },
    TAKOSERVER_MANAGED_WORKER_GATEWAY_ID: {
      type: "plain_text",
      fields: { text: input.gatewayId },
    },
    TAKOSERVER_ENVIRONMENT: { type: "plain_text", fields: { text: input.target.environment } },
  };
  // The managed SQLite Durable Object refuses every admin operation without
  // this secret, and an operator provisions it out of band: the deploy neither
  // mints it nor uploads it, because a value this surface does not hold is not
  // a value it can prove. It is therefore recognised rather than required —
  // present, it must be exactly a secret with this name and nothing else, so a
  // Version carrying an unexpected binding still fails the closure.
  const optional: Readonly<Record<string, BindingExpectation>> = {
    TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET: { type: "secret_text", fields: {} },
  };
  const bindings = rawBindings.filter(isRecord);
  if (bindings.length !== rawBindings.length) {
    throw phaseError(phase, "gateway Worker Version contains a malformed binding");
  }
  const seen = new Set<string>();
  for (const binding of bindings) {
    const name = typeof binding.name === "string" ? binding.name : null;
    if (
      name === null ||
      seen.has(name) ||
      !(Object.hasOwn(expected, name) || Object.hasOwn(optional, name))
    ) {
      throw phaseError(phase, "gateway Worker Version binding closure is not exact");
    }
    seen.add(name);
    const requirement = expected[name] ?? optional[name];
    if (!requirement) {
      throw phaseError(phase, "gateway Worker Version binding closure is not exact");
    }
    if (binding.type !== requirement.type) {
      throw phaseError(phase, `gateway Worker Version binding ${name} has unexpected type`);
    }
    const expectedKeys = ["name", "type", ...Object.keys(requirement.fields)].sort().join(",");
    if (Object.keys(binding).sort().join(",") !== expectedKeys) {
      throw phaseError(phase, `gateway Worker Version binding ${name} is not exact`);
    }
    for (const [field, expectedValue] of Object.entries(requirement.fields)) {
      const actual = binding[field];
      if (actual !== expectedValue) {
        throw phaseError(phase, `gateway Worker Version binding ${name} has unexpected ${field}`);
      }
    }
  }
  for (const name of Object.keys(expected)) {
    if (!seen.has(name)) {
      throw phaseError(phase, "gateway Worker Version binding closure is incomplete");
    }
  }
  return true;
}

interface BindingExpectation {
  readonly type: string;
  readonly fields: Readonly<Record<string, string>>;
}

async function gatewaySettingsClosure(
  phase: "preflight" | "verification",
  state: ManagedWorkerGatewayState,
  workerName: string,
): Promise<boolean> {
  if (state.workerSettings === undefined) return false;
  let settings: unknown;
  try {
    settings = await state.workerSettings(workerName);
  } catch (error) {
    throw phaseError(phase, "gateway Worker settings readback failed", error);
  }
  if (!isRecord(settings)) {
    throw phaseError(phase, "gateway Worker settings readback is malformed");
  }
  const workersDev = settings.workers_dev;
  const previewUrls = settings.preview_urls;
  const settingsProveWorkersDev = workersDev === false;
  const settingsProvePreview = previewUrls === undefined || previewUrls === false;
  if (workersDev !== undefined && typeof workersDev !== "boolean") {
    throw phaseError(phase, "gateway Worker workers_dev setting is malformed");
  }
  if (previewUrls !== undefined && typeof previewUrls !== "boolean") {
    throw phaseError(phase, "gateway Worker preview_urls setting is malformed");
  }
  if (state.workerSubdomain !== undefined) {
    let subdomain: { readonly enabled: boolean; readonly previewsEnabled: boolean };
    try {
      subdomain = await state.workerSubdomain(workerName);
    } catch (error) {
      throw phaseError(phase, "gateway Worker subdomain readback failed", error);
    }
    if (subdomain.enabled || subdomain.previewsEnabled) return false;
  }
  // The direct settings endpoint may omit workers_dev; the subdomain readback
  // above is then the authoritative proof that no workers.dev endpoint exists.
  return (settingsProveWorkersDev || state.workerSubdomain !== undefined) && settingsProvePreview;
}

async function runOwnerGate(run: WorkerArtifactProcess): Promise<void> {
  const gate = await run(["bun", "run", "check"]);
  if (gate.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${gate.exitCode})`,
      `${gate.stdout}${gate.stderr}`.trim(),
    );
  }
}

function writeManagedGatewayConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly bundleDigestHex?: string;
  readonly target: DeployTarget;
  readonly gatewayScript: string;
  readonly dispatchNamespace: string;
  readonly providerId: string;
  readonly gatewayId: string;
  readonly environment: DeployEnvironment;
}): string {
  // The artifact digest is carried by the immutable Version upload message;
  // it is intentionally not projected as a mutable user-visible variable.
  void input.bundleDigestHex;
  const config = {
    name: input.gatewayScript,
    main: input.main,
    account_id: input.target.accountId,
    compatibility_date: "2026-08-31",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      {
        binding: "STATE_DB",
        database_name: input.target.d1.databaseName,
        database_id: input.target.d1.databaseId,
      },
    ],
    dispatch_namespaces: [{ binding: "DISPATCHER", namespace: input.dispatchNamespace }],
    durable_objects: {
      bindings: [{ name: "SQLITE_DATABASES", class_name: "TakoserverManagedWorkerSqlite" }],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["TakoserverManagedWorkerSqlite"],
      },
    ],
    vars: {
      MANAGED_PROVIDER_ID: input.providerId,
      TAKOSERVER_MANAGED_WORKER_GATEWAY_ID: input.gatewayId,
      TAKOSERVER_ENVIRONMENT: input.environment,
    },
  };
  writeFileSync(input.path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return input.path;
}

export function createCloudflareManagedWorkerMutation(input: {
  readonly accountId: string;
  readonly token: string;
  readonly fetcher?: ManagedWorkerGatewayRouteMutationFetcher;
}): ManagedWorkerGatewayMutation {
  if (!/^[0-9a-f]{32}$/u.test(input.accountId)) {
    throw preflightError("Cloudflare account id is invalid");
  }
  const token = exactCloudflareToken({ CLOUDFLARE_API_TOKEN: input.token });
  const fetcher = input.fetcher ?? ((request: Request) => fetch(request));
  const request = async (
    method: "POST" | "PUT",
    zoneId: string,
    routeId: string | null,
    body: { readonly pattern: string; readonly script: string },
  ): Promise<void> => {
    const safeZoneId = exactToken(zoneId, "Cloudflare zone id");
    const suffix =
      routeId === null
        ? `/zones/${encodeURIComponent(safeZoneId)}/workers/routes`
        : `/zones/${encodeURIComponent(safeZoneId)}/workers/routes/${encodeURIComponent(
            exactToken(routeId, "Cloudflare route id"),
          )}`;
    const url = `https://api.cloudflare.com/client/v4${suffix}`;
    let response: Response;
    try {
      response = await fetcher(
        new Request(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ pattern: body.pattern, script: body.script }),
        }),
      );
    } catch (error) {
      throw mutationError(
        "Cloudflare gateway route mutation acknowledgement is indeterminate; do not retry",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw mutationError(
        "Cloudflare gateway route mutation acknowledgement is indeterminate; do not retry",
        `HTTP ${response.status}`,
      );
    }
    if (!response.ok || !isRecord(parsed) || parsed.success !== true) {
      throw mutationError(
        "Cloudflare gateway route mutation acknowledgement is indeterminate; do not retry",
        `HTTP ${response.status}`,
      );
    }
  };
  return {
    async create(route) {
      await request("POST", route.zoneId, null, route);
    },
    async update(route) {
      await request("PUT", route.zoneId, route.id, route);
    },
  };
}

function phaseError(
  phase: "preflight" | "verification",
  message: string,
  error?: unknown,
): ReturnType<typeof preflightError> {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : undefined;
  return phase === "verification"
    ? verificationError(message, detail)
    : preflightError(message, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictBase64Bytes(value: string): Uint8Array | null {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return null;
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  return Buffer.from(bytes).toString("base64") === value ? bytes : null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function exactToken(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  )
    throw preflightError(`${label} is invalid`);
  return value;
}

function exactCloudflareToken(environment: Readonly<Record<string, string>>): string {
  return exactToken(environment.CLOUDFLARE_API_TOKEN ?? "", "CLOUDFLARE_API_TOKEN");
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
