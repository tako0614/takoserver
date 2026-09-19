import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalJson } from "../../src/json.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { type DeployError, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  type DeployProcess,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import {
  inspectLiveWorkerVersion,
  type LiveWorkerVersion,
  type WorkerState,
  workerVersionAnnotationProfile,
  workerVersionAuthorityBindingShape,
  workerVersionIdentity,
  workerVersionScriptContentIdentity,
} from "./worker-live.ts";
import {
  assertExactSecretInventory,
  LEGACY_HOSTED_SPONSORSHIP_SECRET,
  LEGACY_PUBLIC_PARENT_SECRET,
  parseWorkerDeploymentHistory,
  readVersionBindings,
} from "./worker-state.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const ACCOUNT_SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/u;
const OLD_HOST_CRON = ["*/5 * * * *"] as const;
const OLD_HOST_SECRET_NAMES = [
  LEGACY_PUBLIC_PARENT_SECRET,
  LEGACY_HOSTED_SPONSORSHIP_SECRET,
  "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING",
  "TAKOSERVER_SIGNING_KEY",
] as const;
const OLD_HOST_BINDING_TYPES = {
  AI: "ai",
  CLOUDFLARE_ACCOUNT_ID: "plain_text",
  CLOUDFLARE_API_TOKEN: "secret_text",
  OBJECTS: "r2_bucket",
  OPERATOR_IDENTITY_PUBLIC_JWK: "plain_text",
  PUBLIC_ORIGIN: "plain_text",
  STATE_DB: "d1",
  TAKOSERVER_AI_MODELS: "plain_text",
  TAKOSERVER_EDGE_SUPPLIES: "plain_text",
  TAKOSERVER_ENVIRONMENT: "plain_text",
  TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN: "secret_text",
  TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: "plain_text",
  TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: "plain_text",
  TAKOSERVER_OBJECT_BUCKET_SUPPLIES: "plain_text",
  TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: "secret_text",
  TAKOSERVER_SIGNING_KEY: "secret_text",
  TAKOSERVER_SIGNING_KEY_ID: "plain_text",
  TAKOSERVER_SOURCE_COMMIT: "plain_text",
  TAKOSERVER_WORKER_ARTIFACT_DIGEST: "plain_text",
  TAKOSERVER_WORKER_ENDPOINT_SUFFIX: "plain_text",
  TAKOSERVER_ZONES: "plain_text",
  WORKER_VERSION: "version_metadata",
} as const;

export interface IntegrationHostRetirementInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly retiredTargetPath: string;
  readonly retiredDeploymentId: string;
  readonly retiredVersionId: string;
}

/** Only the reviewed identity selectors are read from the historical file. */
export interface RetiredIntegrationHostDescriptor {
  readonly kind: "takoserver.deploy-target@v2";
  readonly environment: "integration";
  readonly accountId: string;
  readonly workerName: string;
  readonly d1: { readonly databaseName: string; readonly databaseId: string };
  readonly r2: { readonly bucketName: string };
  readonly publicOrigin: string;
  readonly zones: readonly Record<string, unknown>[];
  readonly workerEndpointSuffix: string;
  readonly signingKeyId?: string;
}

export interface IntegrationHostRetirementState extends WorkerState {
  workerScripts(): Promise<readonly string[]>;
  workerSettings(workerName: string): Promise<unknown>;
  workerSchedules(workerName: string): Promise<readonly string[]>;
  workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }>;
  workerAccountSubdomain(): Promise<string>;
  workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  >;
  list(path: string, label: string): Promise<readonly unknown[]>;
}

export type IntegrationHostRetirementFetcher = (request: Request) => Promise<Response>;

export interface IntegrationHostRetirementOptions {
  readonly run?: DeployProcess;
  readonly review?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  /** Test seam; production reads the strict private historical descriptor. */
  readonly retiredTarget?: RetiredIntegrationHostDescriptor;
  readonly state?: IntegrationHostRetirementState;
  readonly fetcher?: IntegrationHostRetirementFetcher;
  readonly wranglerPath?: string;
}

interface RetiredHostSnapshot {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly previousVersionId: string | null;
  readonly sourceCommit: string;
  readonly artifactDigest: string;
  readonly scriptEtag: string;
  /** Canonical, in-memory readback fence; never emitted in CLI output. */
  readonly closureFingerprint: string;
}

interface SuccessorSnapshot {
  readonly deploymentId: string;
  readonly versionId: string;
  readonly previousVersionId: string | null;
  readonly sourceCommit: string;
  readonly bundleDigestHex: string;
}

interface Inspection {
  readonly retired: RetiredHostSnapshot | null;
  readonly successor: SuccessorSnapshot;
}

/** Retires only the explicitly pinned historical public Host Worker. */
export async function runIntegrationHostRetirement(
  invocation: IntegrationHostRetirementInvocation,
  currentTarget: DeployTarget,
  options: IntegrationHostRetirementOptions = {},
): Promise<Record<string, unknown>> {
  const retiredTarget = options.retiredTarget ?? loadRetiredTarget(invocation);
  validateInvocation(invocation, currentTarget, retiredTarget);

  const run = options.run ?? runCommand;
  const reviewer =
    invocation.action === "apply"
      ? exactReviewer(options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"))
      : null;
  if (invocation.action === "apply") {
    await qualifySource({ environment: "integration", commit: invocation.commit, run });
  }

  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  const credential =
    invocation.action === "status" && options.state !== undefined
      ? null
      : await resolveCloudflareCredential("integration", {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
          ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
        });
  const state =
    options.state ??
    new CloudflareState({
      accountId: currentTarget.accountId,
      token: credential?.token ?? exactToken(options.cloudflareEnvironment),
      fetcher,
    });

  const before = await inspect(
    invocation,
    retiredTarget,
    currentTarget,
    state,
    fetcher,
    "preflight",
  );
  if (invocation.action === "status") {
    return statusResult(invocation, retiredTarget, currentTarget, before);
  }
  if (before.retired === null) {
    throw preflightError(
      "retired Host script is already absent; use --status before any further action",
    );
  }
  if (credential === null) {
    throw preflightError("integration Host retirement apply requires Cloudflare API authority");
  }

  const fence = await inspect(
    invocation,
    retiredTarget,
    currentTarget,
    state,
    fetcher,
    "preflight",
  );
  assertSameInspection(before, fence, "Host identities or closure changed before deletion");
  if (fence.retired === null) {
    throw preflightError("retired Host script disappeared before deletion; use --status");
  }

  await deleteRetiredWorker({
    accountId: currentTarget.accountId,
    workerName: retiredTarget.workerName,
    token: credential.token,
    fetcher,
  });

  const after = await inspectAfterDeletion(
    retiredTarget.workerName,
    currentTarget,
    state,
    fetcher,
    fence.successor,
  );
  return {
    surface: "takoserver-integration-host-retirement",
    action: "apply",
    environment: "integration",
    sourceCommit: invocation.commit,
    reviewer,
    retiredWorker: retiredTarget.workerName,
    retiredDeploymentId: fence.retired.deploymentId,
    retiredVersionId: fence.retired.versionId,
    retiredScriptAbsent: after.retiredAbsent,
    successorWorker: currentTarget.workerName,
    successorDeploymentId: after.successor.deploymentId,
    successorVersionId: after.successor.versionId,
    publicIdentityReady: true,
    storageTouched: false,
    routesTouched: false,
    namespacesTouched: false,
    rollback:
      "No rollback; restore only through a separately reviewed bootstrap under a new identity.",
  };
}

function loadRetiredTarget(
  invocation: IntegrationHostRetirementInvocation,
): RetiredIntegrationHostDescriptor {
  if (!isAbsolute(invocation.retiredTargetPath)) {
    throw preflightError("--retired-target must be one absolute operator-private target path");
  }
  let raw: string;
  try {
    raw = readFileSync(invocation.retiredTargetPath, "utf8");
  } catch {
    throw preflightError("retired integration Host descriptor could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw preflightError("retired integration Host descriptor is not valid JSON");
  }
  return parseRetiredIntegrationHostDescriptor(parsed);
}

function parseRetiredIntegrationHostDescriptor(value: unknown): RetiredIntegrationHostDescriptor {
  const record = asRecord(value, "retired integration Host descriptor is malformed");
  if (record.kind !== "takoserver.deploy-target@v2" || record.environment !== "integration") {
    throw preflightError("retired descriptor must select the historical integration target kind");
  }
  const accountId = exactString(record.accountId, ACCOUNT_ID, "retired account id");
  const workerName = exactString(record.workerName, WORKER_NAME, "retired Host name");
  const d1 = asRecord(record.d1, "retired descriptor D1 identity is malformed");
  const r2 = asRecord(record.r2, "retired descriptor R2 identity is malformed");
  assertExactKeys(d1, ["databaseName", "databaseId"], [], "retired D1 identity");
  assertExactKeys(r2, ["bucketName"], [], "retired R2 identity");
  const databaseName = exactString(d1.databaseName, RESOURCE_NAME, "retired D1 name");
  const databaseId = exactString(d1.databaseId, UUID, "retired D1 id");
  const bucketName = exactString(r2.bucketName, RESOURCE_NAME, "retired R2 name");
  const publicOrigin = exactHttpsOrigin(record.publicOrigin, "retired Host origin");
  const workerEndpointSuffix = exactString(
    record.workerEndpointSuffix,
    ACCOUNT_SUFFIX,
    "retired workers.dev suffix",
  );
  if (publicOrigin !== `https://${workerName}.${workerEndpointSuffix}`) {
    throw preflightError("retired Host origin does not match its selected workers.dev identity");
  }
  const signingKeyId = optionalRetiredSigningKeyId(record.signing);
  if (!Array.isArray(record.zones)) throw preflightError("retired descriptor zones are malformed");
  const zones = record.zones.map((zone) => {
    const entry = asRecord(zone, "retired descriptor zone is malformed");
    if (
      typeof entry.suffix !== "string" ||
      entry.suffix.length === 0 ||
      typeof entry.zoneId !== "string" ||
      entry.zoneId.length === 0
    ) {
      throw preflightError("retired descriptor zone is incomplete");
    }
    return entry;
  });
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId,
    workerName,
    d1: { databaseName, databaseId },
    r2: { bucketName },
    publicOrigin,
    zones,
    workerEndpointSuffix,
    ...(signingKeyId === undefined ? {} : { signingKeyId }),
  };
}

function validateInvocation(
  invocation: IntegrationHostRetirementInvocation,
  currentTarget: DeployTarget,
  retiredTarget: RetiredIntegrationHostDescriptor,
): void {
  if (invocation.action !== "status" && invocation.action !== "apply") {
    throw preflightError("integration Host retirement requires --status or --apply");
  }
  if (
    invocation.environment !== "integration" ||
    currentTarget.environment !== "integration" ||
    retiredTarget.environment !== "integration"
  ) {
    throw preflightError("integration Host retirement is integration-only");
  }
  if (!COMMIT.test(invocation.commit)) {
    throw preflightError("integration Host retirement requires one exact lowercase 40-hex commit");
  }
  if (!isAbsolute(invocation.retiredTargetPath)) {
    throw preflightError("--retired-target must be one absolute operator-private target path");
  }
  if (!UUID.test(invocation.retiredDeploymentId) || !UUID.test(invocation.retiredVersionId)) {
    throw preflightError(
      "integration Host retirement requires exact retired deployment and Version UUID pins",
    );
  }
  if (
    currentTarget.kind !== "takoserver.deploy-target@v2" ||
    retiredTarget.kind !== "takoserver.deploy-target@v2" ||
    !ACCOUNT_ID.test(currentTarget.accountId) ||
    !ACCOUNT_ID.test(retiredTarget.accountId)
  ) {
    throw preflightError(
      "integration Host retirement requires exact current and retired identities",
    );
  }
  if (currentTarget.accountId !== retiredTarget.accountId) {
    throw preflightError(
      "current and retired integration Hosts must use the same Cloudflare account",
    );
  }
  if (currentTarget.integrationE2eCredentialAuthority === undefined) {
    throw preflightError(
      "successor must declare the exact integration public Host identity authority",
    );
  }
  if (!WORKER_NAME.test(currentTarget.workerName) || !WORKER_NAME.test(retiredTarget.workerName)) {
    throw preflightError("integration Host retirement requires exact Host Worker names");
  }
  if (retiredTarget.workerName === currentTarget.workerName) {
    throw preflightError("retired Host is still the current target Host identity");
  }
  if (retiredTarget.publicOrigin === currentTarget.publicOrigin) {
    throw preflightError("current and retired integration Hosts must use distinct public origins");
  }
  if (currentWorkerNames(currentTarget).has(retiredTarget.workerName)) {
    throw preflightError(
      "retired Host is still a Worker identity in the current integration target",
    );
  }
}

function currentWorkerNames(target: DeployTarget): ReadonlySet<string> {
  return new Set([
    target.workerName,
    ...(target.sponsorshipAuthority ? [target.sponsorshipAuthority.workerName] : []),
    ...(target.cloudflareProviderExecutor
      ? [
          target.cloudflareProviderExecutor.workerName,
          target.cloudflareProviderExecutor.gatewayWorkerName,
          target.cloudflareProviderExecutor.receiptAuthorityWorkerName,
        ]
      : []),
    ...(target.formAuthority
      ? [
          target.formAuthority.workerName,
          target.formAuthority.identityProbeWorkerName,
          ...(target.formAuthority.integrationWorkerName
            ? [target.formAuthority.integrationWorkerName]
            : []),
          ...(target.formAuthority.integrationOperatorWorkerName
            ? [target.formAuthority.integrationOperatorWorkerName]
            : []),
        ]
      : []),
    ...(target.exactArtifactRecovery ? [target.exactArtifactRecovery.workerName] : []),
  ]);
}

async function inspect(
  invocation: IntegrationHostRetirementInvocation,
  retiredTarget: RetiredIntegrationHostDescriptor,
  currentTarget: DeployTarget,
  state: IntegrationHostRetirementState,
  fetcher: IntegrationHostRetirementFetcher,
  phase: "preflight" | "verification",
): Promise<Inspection> {
  try {
    return await inspectUnchecked(invocation, retiredTarget, currentTarget, state, fetcher, phase);
  } catch (error) {
    if (isDeployError(error) && error.phase === phase) throw error;
    throw phaseError(phase, "integration Host retirement state readback failed");
  }
}

async function inspectUnchecked(
  invocation: IntegrationHostRetirementInvocation,
  retiredTarget: RetiredIntegrationHostDescriptor,
  currentTarget: DeployTarget,
  state: IntegrationHostRetirementState,
  fetcher: IntegrationHostRetirementFetcher,
  phase: "preflight" | "verification",
): Promise<Inspection> {
  const scripts = await readWorkerScripts(state, phase);
  const retiredPresent = scripts.includes(retiredTarget.workerName);
  const retiredHistory = await state.workerDeployments(retiredTarget.workerName);
  if (!retiredPresent) {
    if (!Array.isArray(retiredHistory) || retiredHistory.length !== 0) {
      throw phaseError(
        phase,
        "retired Worker script is absent but deployment history is not empty",
      );
    }
    return {
      retired: null,
      successor: await inspectSuccessor(currentTarget, state, fetcher, phase),
    };
  }

  const history = parseWorkerDeploymentHistory(retiredHistory, phase);
  if (
    history === null ||
    history.deploymentId !== invocation.retiredDeploymentId ||
    history.versionId !== invocation.retiredVersionId
  ) {
    throw phaseError(
      phase,
      "retired Host current deployment and Version do not match the explicit UUID pins",
    );
  }
  const version = await state.workerVersion(retiredTarget.workerName, history.versionId);
  const accountSubdomain = await state.workerAccountSubdomain();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(accountSubdomain) ||
    retiredTarget.workerEndpointSuffix !== `${accountSubdomain}.workers.dev` ||
    retiredTarget.publicOrigin !==
      `https://${retiredTarget.workerName}.${accountSubdomain}.workers.dev`
  ) {
    throw phaseError(
      phase,
      "retired Host origin does not match the exact account-owned workers.dev identity",
    );
  }
  const [settings, secrets, schedules, subdomain, routes, domains, namespaces] = await Promise.all([
    state.workerSettings(retiredTarget.workerName),
    state.workerSecrets(retiredTarget.workerName),
    state.workerSchedules(retiredTarget.workerName),
    state.workerSubdomain(retiredTarget.workerName),
    state.workerRoutes(),
    state.workerDomains(),
    readOwnedDurableObjectNamespaces(state, phase),
  ]);
  const retired = inspectRetiredVersion({
    phase,
    retiredTarget,
    version,
    settings,
    secrets,
    schedules,
    subdomain,
    versionId: history.versionId,
  });
  if (
    routes.some(({ script }) => script === retiredTarget.workerName) ||
    domains.some(({ service }) => service === retiredTarget.workerName)
  ) {
    throw phaseError(phase, "retired Host still owns a custom route or domain");
  }
  if (namespaces.some(({ script }) => script === retiredTarget.workerName)) {
    throw phaseError(phase, "retired Host still owns a Durable Object namespace");
  }
  return {
    retired: {
      deploymentId: history.deploymentId,
      versionId: history.versionId,
      previousVersionId: history.previousVersionId,
      ...retired,
    },
    successor: await inspectSuccessor(currentTarget, state, fetcher, phase),
  };
}

function inspectRetiredVersion(input: {
  readonly phase: "preflight" | "verification";
  readonly retiredTarget: RetiredIntegrationHostDescriptor;
  readonly version: unknown;
  readonly settings: unknown;
  readonly secrets: readonly unknown[];
  readonly schedules: readonly string[];
  readonly subdomain: { readonly enabled: boolean; readonly previewsEnabled: boolean };
  readonly versionId: string;
}): Omit<RetiredHostSnapshot, "deploymentId" | "versionId" | "previousVersionId"> {
  const { phase, retiredTarget, version, versionId } = input;
  if (workerVersionAnnotationProfile(version) !== "canonical") {
    throw phaseError(phase, "retired Host Version has no canonical source and artifact provenance");
  }
  const identity = workerVersionIdentity(phase, version);
  const scriptEtag = workerVersionScriptContentIdentity(phase, versionId, version);
  if (workerVersionAuthorityBindingShape(phase, versionId, version) !== "provenance-bound-jit") {
    throw phaseError(
      phase,
      "retired Host Version does not carry its exact public integration authority profile",
    );
  }
  const versionRecord = asRecord(version, phase, "retired Host Version is malformed");
  if (versionRecord.id !== versionId)
    throw phaseError(phase, "retired Host Version response identity does not match its pin");
  const resources = asRecord(
    versionRecord.resources,
    phase,
    "retired Host Version resources are malformed",
  );
  const script = asRecord(
    resources.script,
    phase,
    "retired Host Version script metadata is missing",
  );
  const runtime = asRecord(
    resources.script_runtime,
    phase,
    "retired Host Version runtime is missing",
  );
  if (
    !sameStrings(script.handlers, ["fetch", "scheduled"]) ||
    !sameNamedHandlers(script.named_handlers) ||
    runtime.compatibility_date !== "2026-08-17" ||
    !sameStrings(runtime.compatibility_flags, ["nodejs_compat"]) ||
    runtime.usage_model !== "standard"
  ) {
    throw phaseError(phase, "retired Version is not the exact fetch/scheduled legacy Host role");
  }

  const bindings = readVersionBindings(phase, versionId, version);
  validateLegacyBindings(phase, bindings, retiredTarget, identity);
  assertExactSecretInventory(input.secrets, OLD_HOST_SECRET_NAMES, phase);
  const settings = asRecord(input.settings, phase, "retired Host settings are malformed");
  if (!Array.isArray(settings.bindings))
    throw phaseError(phase, "retired Host settings have no complete binding inventory");
  const settingsBindings = recordBindings(settings.bindings, phase);
  validateLegacyBindings(phase, settingsBindings, retiredTarget, identity);
  if (
    canonicalJson(bindingProjection(bindings)) !==
    canonicalJson(bindingProjection(settingsBindings))
  ) {
    throw phaseError(
      phase,
      "retired Host settings bindings differ from the immutable Version projection",
    );
  }
  if (
    (Object.hasOwn(settings, "workers_dev") && settings.workers_dev !== true) ||
    (Object.hasOwn(settings, "preview_urls") && settings.preview_urls !== false) ||
    canonicalJson(settings.placement) !== "{}" ||
    canonicalJson(settings.tail_consumers) !== "[]" ||
    settings.logpush !== false ||
    !isRecord(settings.observability)
  ) {
    throw phaseError(
      phase,
      "retired Host settings differ from the exact legacy workers.dev Host profile",
    );
  }
  for (const key of ["routes", "custom_domains", "domains"] as const) {
    if (
      settings[key] !== undefined &&
      (!Array.isArray(settings[key]) || settings[key].length !== 0)
    ) {
      throw phaseError(phase, "retired Host settings declare custom route or domain topology");
    }
  }
  if (
    !sameStrings(input.schedules, OLD_HOST_CRON) ||
    input.subdomain.enabled !== true ||
    input.subdomain.previewsEnabled !== true
  ) {
    throw phaseError(
      phase,
      "retired Host workers.dev settings or cron differ from the exact legacy Host role",
    );
  }
  const closureFingerprint = canonicalJson({
    bindings: sortBindings(bindings),
    settingsBindings: sortBindings(settingsBindings),
    settings,
    secretNames: [...OLD_HOST_SECRET_NAMES].sort(),
    schedules: [...input.schedules].sort(),
    subdomain: input.subdomain,
  });
  return {
    sourceCommit: identity.commit,
    artifactDigest: `sha256:${identity.bundleDigestHex}`,
    scriptEtag,
    closureFingerprint,
  };
}

function validateLegacyBindings(
  phase: "preflight" | "verification",
  bindings: readonly Record<string, unknown>[],
  target: RetiredIntegrationHostDescriptor,
  identity: { readonly commit: string; readonly bundleDigestHex: string },
): void {
  const names = bindings.map((binding) => {
    if (
      typeof binding.name === "string" &&
      typeof binding.binding === "string" &&
      binding.name !== binding.binding
    ) {
      throw phaseError(phase, "retired Host binding has conflicting names");
    }
    const name = typeof binding.name === "string" ? binding.name : binding.binding;
    if (typeof name !== "string") throw phaseError(phase, "retired Host binding is unnamed");
    return name;
  });
  const expectedNames = Object.keys(OLD_HOST_BINDING_TYPES).sort();
  if (
    new Set(names).size !== names.length ||
    canonicalJson([...names].sort()) !== canonicalJson(expectedNames)
  ) {
    throw phaseError(phase, "retired Host binding inventory is missing, duplicated, or extraneous");
  }
  const byName = new Map(bindings.map((binding, index) => [names[index] as string, binding]));
  for (const [name, type] of Object.entries(OLD_HOST_BINDING_TYPES)) {
    const binding = byName.get(name);
    if (binding?.type !== type)
      throw phaseError(
        phase,
        "retired Host binding type differs from its fixed historical profile",
      );
    if (type === "plain_text" && typeof binding.text !== "string") {
      throw phaseError(phase, "retired Host plain-text binding is malformed");
    }
  }
  const assertText = (name: string, expected: string): void => {
    if (byName.get(name)?.text !== expected) {
      throw phaseError(
        phase,
        "retired Host selector-derived binding differs from the private descriptor",
      );
    }
  };
  assertText("CLOUDFLARE_ACCOUNT_ID", target.accountId);
  assertText("PUBLIC_ORIGIN", target.publicOrigin);
  assertText("TAKOSERVER_ENVIRONMENT", "integration");
  if (target.signingKeyId !== undefined) {
    assertText("TAKOSERVER_SIGNING_KEY_ID", target.signingKeyId);
  }
  assertText("TAKOSERVER_SOURCE_COMMIT", identity.commit);
  assertText("TAKOSERVER_WORKER_ARTIFACT_DIGEST", `sha256:${identity.bundleDigestHex}`);
  assertText("TAKOSERVER_WORKER_ENDPOINT_SUFFIX", target.workerEndpointSuffix);
  assertText("TAKOSERVER_ZONES", JSON.stringify(target.zones));
  const database = byName.get("STATE_DB");
  if (database?.id !== target.d1.databaseId || database.database_id !== target.d1.databaseId) {
    throw phaseError(phase, "retired Host D1 binding differs from the selected private identity");
  }
  const objects = byName.get("OBJECTS");
  if (objects?.bucket_name !== target.r2.bucketName) {
    throw phaseError(phase, "retired Host R2 binding differs from the selected private identity");
  }
  const ai = byName.get("AI");
  if (typeof ai?.project !== "string" || ai.project.length === 0) {
    throw phaseError(phase, "retired Host AI binding is malformed");
  }
}

function recordBindings(
  value: readonly unknown[],
  phase: "preflight" | "verification",
): readonly Record<string, unknown>[] {
  return value.map((binding) =>
    asRecord(binding, phase, "retired Host settings binding is malformed"),
  );
}

function bindingProjection(
  bindings: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return sortBindings(
    bindings.map(({ name, binding, ...fields }) => ({
      name: typeof name === "string" ? name : binding,
      ...fields,
    })),
  );
}

async function inspectSuccessor(
  target: DeployTarget,
  state: IntegrationHostRetirementState,
  fetcher: IntegrationHostRetirementFetcher,
  phase: "preflight" | "verification",
): Promise<SuccessorSnapshot> {
  const current = (await inspectLiveWorkerVersion(phase, target, state, {
    authorityProfile: { kind: "provenance-bound-jit" },
  })) as LiveWorkerVersion;
  await assertPublicIdentity(target.publicOrigin, fetcher, phase);
  return {
    deploymentId: current.history.deploymentId,
    versionId: current.history.versionId,
    previousVersionId: current.history.previousVersionId,
    sourceCommit: current.commit,
    bundleDigestHex: current.bundleDigestHex,
  };
}

async function readOwnedDurableObjectNamespaces(
  state: IntegrationHostRetirementState,
  phase: "preflight" | "verification",
): Promise<
  readonly { readonly id: string; readonly name: string; readonly script: string | null }[]
> {
  const value = await state.list(
    "/workers/durable_objects/namespaces",
    "Cloudflare Durable Object namespace inventory",
  );
  if (!Array.isArray(value))
    throw phaseError(phase, "Durable Object namespace inventory is not a complete list");
  const entries = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      !(typeof entry.script === "string" || entry.script === null)
    ) {
      throw phaseError(phase, "Durable Object namespace inventory contains an incomplete row");
    }
    return { id: entry.id, name: entry.name, script: entry.script };
  });
  if (
    new Set(entries.map(({ id }) => id)).size !== entries.length ||
    new Set(entries.map(({ name }) => name)).size !== entries.length
  ) {
    throw phaseError(phase, "Durable Object namespace inventory contains duplicate identities");
  }
  return entries;
}

async function assertPublicIdentity(
  origin: string,
  fetcher: IntegrationHostRetirementFetcher,
  phase: "preflight" | "verification",
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(`${origin}/.well-known/takoserver`, {
        method: "GET",
        headers: { "cache-control": "no-cache" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
    );
  } catch {
    throw phaseError(phase, "successor Host public identity probe failed");
  }
  let body: unknown;
  try {
    body = JSON.parse(await boundedResponseText(response, 64 * 1024));
  } catch {
    throw phaseError(phase, "successor Host public identity response is malformed");
  }
  const endpoints = isRecord(body) ? body.endpoints : null;
  if (
    response.status !== 200 ||
    !isRecord(body) ||
    body.product !== "takoserver" ||
    body.apiVersion !== "v1" ||
    !isRecord(endpoints) ||
    endpoints.api !== origin
  ) {
    throw phaseError(
      phase,
      "successor Host public identity does not match its selected API origin",
    );
  }
}

async function deleteRetiredWorker(input: {
  readonly accountId: string;
  readonly workerName: string;
  readonly token: string;
  readonly fetcher: IntegrationHostRetirementFetcher;
}): Promise<void> {
  const url = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.workerName)}`;
  let response: Response;
  try {
    response = await input.fetcher(
      new Request(url, {
        method: "DELETE",
        redirect: "error",
        headers: { accept: "application/json", authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(15_000),
      }),
    );
  } catch {
    throw mutationError(
      "Cloudflare Worker delete acknowledgement is unknown; run --status and do not retry",
    );
  }
  if (response.status >= 400 && response.status < 500) {
    throw mutationError(
      `Cloudflare rejected the exact Worker delete (HTTP ${response.status}); no retry was sent`,
    );
  }
  if (response.status >= 500 || !response.ok) {
    throw mutationError(
      `Cloudflare Worker delete acknowledgement is unknown (HTTP ${response.status}); run --status`,
    );
  }
  let text: string;
  try {
    text = await boundedResponseText(response, 64 * 1024);
  } catch {
    throw mutationError(
      "Cloudflare Worker delete acknowledgement is malformed or unknown; run --status",
    );
  }
  if (text.length === 0) return;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw mutationError(
      "Cloudflare Worker delete acknowledgement is malformed or unknown; run --status",
    );
  }
  if (!isRecord(body) || body.success !== true) {
    throw mutationError(
      "Cloudflare Worker delete acknowledgement is malformed or unknown; run --status",
    );
  }
}

async function inspectAfterDeletion(
  retiredWorkerName: string,
  currentTarget: DeployTarget,
  state: IntegrationHostRetirementState,
  fetcher: IntegrationHostRetirementFetcher,
  expectedSuccessor: SuccessorSnapshot,
): Promise<{ readonly retiredAbsent: true; readonly successor: SuccessorSnapshot }> {
  try {
    const scripts = await readWorkerScripts(state, "verification");
    if (scripts.includes(retiredWorkerName)) {
      throw verificationError(
        "Cloudflare acknowledged Worker deletion but the exact script remains present",
      );
    }
    const deployments = await state.workerDeployments(retiredWorkerName);
    if (!Array.isArray(deployments) || deployments.length !== 0) {
      throw verificationError(
        "Cloudflare acknowledged Worker deletion but its deployment history remains",
      );
    }
    const successor = await inspectSuccessor(currentTarget, state, fetcher, "verification");
    assertSameSuccessor(
      expectedSuccessor,
      successor,
      "successor Host changed after retired Worker deletion",
    );
    return { retiredAbsent: true, successor };
  } catch (error) {
    if (isDeployError(error) && error.phase === "verification") throw error;
    throw verificationError(
      "post-delete Cloudflare state readback failed; inspect status before any repair",
    );
  }
}

async function readWorkerScripts(
  state: IntegrationHostRetirementState,
  phase: "preflight" | "verification",
): Promise<readonly string[]> {
  const scripts = await state.workerScripts();
  if (
    !Array.isArray(scripts) ||
    scripts.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(scripts).size !== scripts.length
  ) {
    throw phaseError(phase, "Cloudflare Worker script inventory is incomplete or malformed");
  }
  return scripts;
}

function statusResult(
  invocation: IntegrationHostRetirementInvocation,
  retiredTarget: RetiredIntegrationHostDescriptor,
  currentTarget: DeployTarget,
  inspection: Inspection,
): Record<string, unknown> {
  return {
    surface: "takoserver-integration-host-retirement",
    action: "status",
    environment: "integration",
    sourceCommit: invocation.commit,
    state: inspection.retired === null ? "retired" : "ready-to-retire",
    retiredWorker: retiredTarget.workerName,
    retiredPresent: inspection.retired !== null,
    ...(inspection.retired === null
      ? {}
      : {
          retiredDeploymentId: inspection.retired.deploymentId,
          retiredVersionId: inspection.retired.versionId,
        }),
    successorWorker: currentTarget.workerName,
    successorDeploymentId: inspection.successor.deploymentId,
    successorVersionId: inspection.successor.versionId,
    publicIdentityReady: true,
    mutationAvailable: false,
    storageTouched: false,
  };
}

function assertSameInspection(expected: Inspection, actual: Inspection, message: string): void {
  if (
    canonicalJson(expected.retired) !== canonicalJson(actual.retired) ||
    canonicalJson(expected.successor) !== canonicalJson(actual.successor)
  ) {
    throw preflightError(message);
  }
}

function assertSameSuccessor(
  expected: SuccessorSnapshot,
  actual: SuccessorSnapshot,
  message: string,
): void {
  if (canonicalJson(expected) !== canonicalJson(actual)) throw verificationError(message);
}

function sortBindings(
  bindings: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return [...bindings].sort((left, right) => {
    const leftName = String(left.name ?? left.binding ?? "");
    const rightName = String(right.name ?? right.binding ?? "");
    return leftName.localeCompare(rightName);
  });
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    canonicalJson([...value].sort()) === canonicalJson([...expected].sort())
  );
}

function sameNamedHandlers(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return false;
  return (
    value[0].name === "PublicHostIdentityEntrypoint" && sameStrings(value[0].handlers, ["identity"])
  );
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function exactToken(environment: Readonly<Record<string, string>> | undefined): string {
  const token = environment?.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!token || token.trim() !== token) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return token;
}

function exactString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw preflightError(`${label} is malformed`);
  return value;
}

function optionalRetiredSigningKeyId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const signing = asRecord(value, "retired signing identity is malformed");
  if (signing.currentKeyId === undefined) return undefined;
  return exactString(signing.currentKeyId, KEY_ID, "retired signing key id");
}

function exactHttpsOrigin(value: unknown, label: string): string {
  if (typeof value !== "string") throw preflightError(`${label} is malformed`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw preflightError(`${label} is malformed`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw preflightError(`${label} must be one exact HTTPS origin`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const missing = required.some((key) => !keys.includes(key));
  const unknown = keys.some((key) => !required.includes(key) && !optional.includes(key));
  if (missing || unknown) throw preflightError(`${label} has missing or unknown fields`);
}

function asRecord(value: unknown, message: string): Record<string, unknown>;
function asRecord(
  value: unknown,
  phase: "preflight" | "verification",
  message: string,
): Record<string, unknown>;
function asRecord(
  value: unknown,
  phaseOrMessage: "preflight" | "verification" | string,
  maybeMessage?: string,
): Record<string, unknown> {
  const phase =
    maybeMessage === undefined ? "preflight" : (phaseOrMessage as "preflight" | "verification");
  const message = maybeMessage ?? phaseOrMessage;
  if (!isRecord(value)) throw phaseError(phase, message as string);
  return value;
}

function phaseError(phase: "preflight" | "verification", message: string) {
  return phase === "verification" ? verificationError(message) : preflightError(message);
}

function isDeployError(value: unknown): value is DeployError {
  return typeof value === "object" && value !== null && "phase" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumBytes)
  ) {
    await response.body?.cancel();
    throw new Error("response exceeds the safety bound");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("response exceeds the safety bound");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
