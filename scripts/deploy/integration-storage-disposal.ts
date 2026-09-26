import { CloudflareState } from "./cloudflare-state.ts";
import { DeployError, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  CloudflareIntegrationStorageProvider,
  type IntegrationStorageD1Database,
  type IntegrationStorageR2Bucket,
} from "./integration-storage-generation.ts";
import {
  type CloudflareCredential,
  type DeployProcess,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { parseWorkerDeploymentHistory } from "./worker-state.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const GENERATED_NAME = /^takoserver-i-[0-9a-f]{32}$/u;
const STAGING_D1_NAME = "takoserver-runtime-staging";
const STAGING_R2_NAME = "takoserver-objects-staging";
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export interface IntegrationStorageDisposalInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface IntegrationStorageDisposalProvider {
  listD1(name: string): Promise<readonly IntegrationStorageD1Database[]>;
  getD1ById(databaseId: string): Promise<IntegrationStorageD1Database | null>;
  listR2(name: string): Promise<readonly IntegrationStorageR2Bucket[]>;
  deleteR2(name: string): Promise<void>;
  deleteD1(databaseId: string): Promise<void>;
}

export interface IntegrationStorageDisposalStateReader {
  workerScripts(): Promise<readonly string[]>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerSettings(workerName: string): Promise<unknown>;
  read(path: string, label: string): Promise<unknown>;
}

export type IntegrationStorageDisposalProcess = DeployProcess;
export type IntegrationStorageDisposalFetcher = (request: Request) => Promise<Response>;

export interface IntegrationStorageDisposalOptions {
  readonly run?: IntegrationStorageDisposalProcess;
  readonly review?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly provider?: IntegrationStorageDisposalProvider;
  readonly state?: IntegrationStorageDisposalStateReader;
  readonly fetcher?: IntegrationStorageDisposalFetcher;
}

interface StorageSelection {
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly bucketName: string;
}

interface StorageInventory {
  readonly d1: IntegrationStorageD1Database | null;
  readonly r2: IntegrationStorageR2Bucket | null;
}

interface WorkerInventory {
  readonly regularScripts: number;
  readonly dispatchNamespaces: number;
  readonly dispatchScripts: number;
  readonly bindingsInspected: number;
  readonly d1References: readonly string[];
  readonly r2References: readonly string[];
}

interface FullInventory {
  readonly storage: StorageInventory;
  readonly workers: WorkerInventory;
}

class DeleteAcknowledgementError extends Error {
  constructor(readonly outcome: "rejected" | "unknown") {
    super("Cloudflare delete acknowledgement was not successful");
  }
}

/**
 * Status and deliberately bounded disposal for the exact integration target.
 * Storage is never selected by an arbitrary CLI name: it comes from the
 * environment-selected DeployTarget and must match one dedicated staging pair
 * or one complete generated pair.
 */
export async function runIntegrationStorageDisposal(
  invocation: IntegrationStorageDisposalInvocation,
  target: DeployTarget,
  options: IntegrationStorageDisposalOptions = {},
): Promise<Record<string, unknown>> {
  const selection = validateSelection(invocation, target);
  const run = options.run ?? runCommand;
  const reviewer =
    invocation.action === "apply"
      ? exactReviewer(options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"))
      : null;
  if (invocation.action === "apply") {
    await qualifySource({ environment: "integration", commit: invocation.commit, run });
  }

  const services = await resolveServices(target, options);
  const observed = await inspect(selection, services.provider, services.state, "preflight");
  if (invocation.action === "status") {
    return statusResult(invocation, selection, observed);
  }
  assertUnreferenced(observed.workers, "pre-mutation inventory");
  if (!observed.storage.d1 && !observed.storage.r2) {
    return applyResult(invocation, selection, reviewer, false, false);
  }

  // Close the exact identity and current-binding inventory again at the
  // mutation fence. This is a one-way operation with no API-side CAS.
  const fence = await inspect(selection, services.provider, services.state, "preflight");
  assertUnreferenced(fence.workers, "immediate pre-mutation inventory");
  let deletedR2 = false;
  let deletedD1 = false;
  let current = fence.storage;

  if (current.r2 !== null) {
    try {
      await services.provider.deleteR2(selection.bucketName);
    } catch (error) {
      throw deleteFailure("R2", error, "D1 was not attempted");
    }
    deletedR2 = true;
    current = await verifiedStorageReadback(
      selection,
      services.provider,
      "R2 delete was acknowledged but exact absence readback failed; D1 was not attempted",
    );
    if (current.r2 !== null) {
      throw verificationError(
        "R2 delete was acknowledged but the selected bucket remains present; D1 was not attempted",
      );
    }
  }

  if (current.d1 !== null) {
    if (deletedR2) {
      let postR2Fence: FullInventory;
      try {
        postR2Fence = await inspect(selection, services.provider, services.state, "verification");
      } catch {
        throw verificationError(
          "R2 absence was verified; D1 deletion was withheld because the post-R2 inventory was incomplete",
        );
      }
      if (postR2Fence.storage.r2 !== null || postR2Fence.storage.d1 === null) {
        throw verificationError(
          "R2 absence was verified; exact D1 identity changed before its delete and D1 deletion was withheld",
        );
      }
      if (hasReferences(postR2Fence.workers)) {
        throw verificationError(
          "R2 absence was verified; a current Worker references selected storage, so D1 deletion was withheld",
          JSON.stringify(referenceSummary(postR2Fence.workers)),
        );
      }
      current = postR2Fence.storage;
    }
    try {
      await services.provider.deleteD1(selection.databaseId);
    } catch (error) {
      throw deleteFailure(
        "D1",
        error,
        deletedR2 ? "R2 absence was verified; read --status before repair" : "R2 was not touched",
      );
    }
    deletedD1 = true;
  }

  let after: StorageInventory;
  try {
    after = await readStorageInventory(selection, services.provider, "verification");
  } catch {
    throw verificationError(
      "storage deletion completed or partially completed but exact identity readback failed; run --status before repair",
    );
  }
  if (after.d1 !== null || after.r2 !== null) {
    throw verificationError(
      "storage deletion acknowledgement did not reach authoritative absence; run --status before repair",
      JSON.stringify({ d1Present: after.d1 !== null, r2Present: after.r2 !== null }),
    );
  }
  return applyResult(invocation, selection, reviewer, deletedR2, deletedD1);
}

function validateSelection(
  invocation: IntegrationStorageDisposalInvocation,
  target: DeployTarget,
): StorageSelection {
  if (invocation.action !== "status" && invocation.action !== "apply") {
    throw preflightError("integration storage disposal requires --status or --apply");
  }
  if (
    invocation.environment !== "integration" ||
    target.environment !== "integration" ||
    invocation.environment !== target.environment
  ) {
    throw preflightError("integration storage disposal is integration-only");
  }
  if (!/^[0-9a-f]{40}$/u.test(invocation.commit)) {
    throw preflightError("integration storage disposal requires one exact lowercase 40-hex commit");
  }
  if (target.kind !== "takoserver.deploy-target@v2" || !ACCOUNT_ID.test(target.accountId)) {
    throw preflightError("integration storage disposal requires one exact selected DeployTarget");
  }
  const { databaseName, databaseId } = target.d1;
  const bucketName = target.r2.bucketName;
  const stagingPair = databaseName === STAGING_D1_NAME && bucketName === STAGING_R2_NAME;
  const generatedPair = GENERATED_NAME.test(databaseName) && bucketName === databaseName;
  if (!stagingPair && !generatedPair) {
    throw preflightError(
      "integration storage disposal refuses arbitrary or mismatched D1/R2 target names",
    );
  }
  if (!UUID.test(databaseId)) {
    throw preflightError("integration storage disposal requires the selected exact D1 database id");
  }
  return { accountId: target.accountId, databaseName, databaseId, bucketName };
}

async function resolveServices(
  target: DeployTarget,
  options: IntegrationStorageDisposalOptions,
): Promise<{
  readonly provider: IntegrationStorageDisposalProvider;
  readonly state: IntegrationStorageDisposalStateReader;
}> {
  if (options.provider !== undefined || options.state !== undefined) {
    if (options.provider === undefined || options.state === undefined) {
      throw preflightError(
        "storage disposal test seams must provide both provider and state readers",
      );
    }
    return { provider: options.provider, state: options.state };
  }
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    ...(options.run === undefined ? {} : { run: options.run }),
  });
  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  return {
    provider: cloudflareProvider(target.accountId, credential, fetcher),
    state: new CloudflareState({
      accountId: target.accountId,
      token: credential.token,
      fetcher,
    }),
  };
}

function cloudflareProvider(
  accountId: string,
  credential: CloudflareCredential,
  fetcher: IntegrationStorageDisposalFetcher,
): IntegrationStorageDisposalProvider {
  const reader = new CloudflareIntegrationStorageProvider(accountId, credential.token, { fetcher });
  const url = (path: string) =>
    `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}${path}`;
  return {
    listD1: (name) => reader.listD1(name),
    getD1ById: (databaseId) => getD1ById(fetcher, credential.token, url, databaseId),
    listR2: (name) => reader.listR2(name),
    deleteR2: async (name) =>
      await deleteCloudflareResource(
        fetcher,
        credential.token,
        url(`/r2/buckets/${encodeURIComponent(name)}`),
      ),
    deleteD1: async (databaseId) =>
      await deleteCloudflareResource(
        fetcher,
        credential.token,
        url(`/d1/database/${encodeURIComponent(databaseId)}`),
      ),
  };
}

async function getD1ById(
  fetcher: IntegrationStorageDisposalFetcher,
  token: string,
  url: (path: string) => string,
  databaseId: string,
): Promise<IntegrationStorageD1Database | null> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(url(`/d1/database/${encodeURIComponent(databaseId)}`), {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      }),
    );
  } catch {
    throw new Error("exact D1 id read failed");
  }
  let body: unknown;
  try {
    body = JSON.parse(await boundedResponseText(response));
  } catch {
    throw new Error("exact D1 id read returned malformed data");
  }
  if (
    response.status === 404 &&
    isRecord(body) &&
    body.success === false &&
    body.result === null &&
    Array.isArray(body.errors) &&
    body.errors.length > 0 &&
    body.errors.every(
      (error) =>
        isRecord(error) &&
        Number.isSafeInteger(error.code) &&
        typeof error.message === "string" &&
        error.message.length > 0,
    )
  ) {
    return null;
  }
  if (!response.ok || !isRecord(body) || body.success !== true || !isRecord(body.result)) {
    throw new Error("exact D1 id read failed");
  }
  const { name, uuid } = body.result;
  if (
    typeof name !== "string" ||
    !RESOURCE_NAME.test(name) ||
    typeof uuid !== "string" ||
    !UUID.test(uuid)
  ) {
    throw new Error("exact D1 id read returned a malformed identity");
  }
  return { name, uuid };
}

async function deleteCloudflareResource(
  fetcher: IntegrationStorageDisposalFetcher,
  token: string,
  url: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(url, {
        method: "DELETE",
        redirect: "error",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      }),
    );
  } catch {
    throw new DeleteAcknowledgementError("unknown");
  }
  let body: unknown;
  try {
    body = JSON.parse(await boundedResponseText(response));
  } catch {
    throw new DeleteAcknowledgementError("unknown");
  }
  if (response.ok && isRecord(body) && body.success === true && Object.hasOwn(body, "result")) {
    return;
  }
  if (
    isRecord(body) &&
    body.success === false &&
    ((response.status >= 400 && response.status < 500) || response.ok)
  ) {
    throw new DeleteAcknowledgementError("rejected");
  }
  throw new DeleteAcknowledgementError("unknown");
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("Cloudflare delete response exceeded the safety bound");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Cloudflare delete response exceeded the safety bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function inspect(
  selection: StorageSelection,
  provider: IntegrationStorageDisposalProvider,
  state: IntegrationStorageDisposalStateReader,
  phase: "preflight" | "verification",
): Promise<FullInventory> {
  try {
    const storage = await readStorageInventory(selection, provider, phase);
    const workers = await readCurrentWorkerInventory(selection, state);
    return { storage, workers };
  } catch (error) {
    if (error instanceof DeployError) throw new DeployError(phase, error.message);
    throw new DeployError(
      phase,
      "storage or current Worker inventory is incomplete; no further deletion is permitted",
    );
  }
}

async function readStorageInventory(
  selection: StorageSelection,
  provider: IntegrationStorageDisposalProvider,
  phase: "preflight" | "verification",
): Promise<StorageInventory> {
  let databases: readonly IntegrationStorageD1Database[];
  let databaseById: IntegrationStorageD1Database | null;
  let buckets: readonly IntegrationStorageR2Bucket[];
  try {
    [databases, databaseById, buckets] = await Promise.all([
      provider.listD1(selection.databaseName),
      provider.getD1ById(selection.databaseId),
      provider.listR2(selection.bucketName),
    ]);
  } catch {
    throw new DeployError(phase, "exact D1/R2 identity inventory failed");
  }
  if (!Array.isArray(databases) || !Array.isArray(buckets)) {
    throw new DeployError(phase, "exact D1/R2 identity inventory is malformed");
  }
  if (
    databaseById !== null &&
    (!isRecord(databaseById) ||
      typeof databaseById.name !== "string" ||
      !RESOURCE_NAME.test(databaseById.name) ||
      typeof databaseById.uuid !== "string" ||
      !UUID.test(databaseById.uuid))
  ) {
    throw new DeployError(phase, "exact D1 id read returned a malformed identity");
  }
  if (
    databases.some(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        !RESOURCE_NAME.test(entry.name) ||
        typeof entry.uuid !== "string" ||
        !UUID.test(entry.uuid),
    ) ||
    buckets.some(
      (entry) =>
        !isRecord(entry) || typeof entry.name !== "string" || !RESOURCE_NAME.test(entry.name),
    )
  ) {
    throw new DeployError(phase, "exact D1/R2 identity inventory contains malformed entries");
  }
  const exactD1 = databases.filter((entry) => entry.name === selection.databaseName);
  const selectedIdAtOtherName = databases.some(
    (entry) => entry.uuid === selection.databaseId && entry.name !== selection.databaseName,
  );
  if (selectedIdAtOtherName) {
    throw new DeployError(phase, "selected D1 id is listed under a different name");
  }
  if (exactD1.length > 1) {
    throw new DeployError(phase, "D1 inventory contains duplicate selected names");
  }
  const d1 = exactD1[0] ?? null;
  if (d1 !== null && d1.uuid !== selection.databaseId) {
    throw new DeployError(phase, "selected D1 name collides with a different database id");
  }
  if (databaseById !== null && databaseById.uuid !== selection.databaseId) {
    throw new DeployError(phase, "exact D1 id read returned a different database id");
  }
  if (databaseById !== null && databaseById.name !== selection.databaseName) {
    throw new DeployError(phase, "selected D1 id exists under a different database name");
  }
  if ((d1 === null) !== (databaseById === null)) {
    throw new DeployError(phase, "D1 name and exact-id inventory disagree");
  }
  const exactR2 = buckets.filter((entry) => entry.name === selection.bucketName);
  if (exactR2.length > 1) {
    throw new DeployError(phase, "R2 inventory contains duplicate selected names");
  }
  return { d1, r2: exactR2[0] ?? null };
}

async function readCurrentWorkerInventory(
  selection: StorageSelection,
  state: IntegrationStorageDisposalStateReader,
): Promise<WorkerInventory> {
  const d1References = new Set<string>();
  const r2References = new Set<string>();
  let regularScripts = 0;
  let dispatchNamespaces = 0;
  let dispatchScripts = 0;
  let bindingsInspected = 0;

  const regular = await state.workerScripts();
  if (
    !Array.isArray(regular) ||
    regular.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw preflightError("current Worker script inventory is malformed");
  }
  if (new Set(regular).size !== regular.length) {
    throw preflightError("current Worker script inventory contains duplicate names");
  }
  regularScripts = regular.length;
  const regularReferences = await mapBounded([...regular].sort(), 4, async (workerName) => {
    const settings = await state.workerSettings(workerName);
    if (!isRecord(settings) || !Array.isArray(settings.bindings)) {
      throw preflightError("current Worker settings have no complete binding inventory");
    }
    const settingReferences = readBindingReferences(settings.bindings, selection);
    const history = parseWorkerDeploymentHistory(await state.workerDeployments(workerName));
    if (history === null) return { workerName, settingReferences, versionReferences: null };
    const version = await state.workerVersion(workerName, history.versionId);
    if (
      !isRecord(version) ||
      !isRecord(version.resources) ||
      !Array.isArray(version.resources.bindings)
    ) {
      throw preflightError("current Worker Version has no complete binding inventory");
    }
    return {
      workerName,
      settingReferences,
      versionReferences: readBindingReferences(version.resources.bindings, selection),
    };
  });
  for (const { workerName, settingReferences, versionReferences } of regularReferences) {
    bindingsInspected += versionReferences === null ? 1 : 2;
    if (settingReferences.d1 || versionReferences?.d1) d1References.add(workerName);
    if (settingReferences.r2 || versionReferences?.r2) r2References.add(workerName);
  }

  const namespaces = await state.read(
    "/workers/dispatch/namespaces",
    "Cloudflare dispatch namespace inventory",
  );
  if (!Array.isArray(namespaces)) {
    throw preflightError("current dispatch namespace inventory is malformed");
  }
  const namespaceNames = namespaces.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.namespace_name !== "string" ||
      entry.namespace_name.length === 0 ||
      !Number.isSafeInteger(entry.script_count) ||
      Number(entry.script_count) < 0
    ) {
      throw preflightError(
        "current dispatch namespace inventory lacks exact names or script counts",
      );
    }
    return { name: entry.namespace_name, count: Number(entry.script_count) };
  });
  if (new Set(namespaceNames.map(({ name }) => name)).size !== namespaceNames.length) {
    throw preflightError("current dispatch namespace inventory contains duplicate names");
  }
  dispatchNamespaces = namespaceNames.length;
  const namespaceScriptLists = await mapBounded(
    [...namespaceNames].sort((left, right) => left.name.localeCompare(right.name)),
    4,
    async (namespace) => {
      const scripts = await state.read(
        `/workers/dispatch/namespaces/${encodeURIComponent(namespace.name)}/scripts`,
        `${namespace.name} dispatch script inventory`,
      );
      if (!Array.isArray(scripts)) {
        throw preflightError("current dispatch script inventory is malformed");
      }
      const scriptNames = scripts.map((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
          throw preflightError("current dispatch script inventory contains a malformed identity");
        }
        return entry.id;
      });
      if (
        new Set(scriptNames).size !== scriptNames.length ||
        scriptNames.length !== namespace.count
      ) {
        throw preflightError(
          "dispatch namespace script count does not match its exact script inventory",
        );
      }
      return scriptNames
        .sort()
        .map((scriptName) => ({ namespaceName: namespace.name, scriptName }));
    },
  );
  const dispatchIdentities = namespaceScriptLists.flat();
  dispatchScripts = dispatchIdentities.length;
  const dispatchReferences = await mapBounded(dispatchIdentities, 4, async (identity) => {
    const rawBindings = await state.read(
      `/workers/dispatch/namespaces/${encodeURIComponent(identity.namespaceName)}/scripts/${encodeURIComponent(identity.scriptName)}/bindings`,
      `${identity.namespaceName}/${identity.scriptName} current binding inventory`,
    );
    return {
      owner: `${identity.namespaceName}/${identity.scriptName}`,
      references: readBindingReferences(rawBindings, selection),
    };
  });
  for (const { owner, references } of dispatchReferences) {
    bindingsInspected += 1;
    if (references.d1) d1References.add(owner);
    if (references.r2) r2References.add(owner);
  }

  return {
    regularScripts,
    dispatchNamespaces,
    dispatchScripts,
    bindingsInspected,
    d1References: [...d1References].sort(),
    r2References: [...r2References].sort(),
  };
}

function readBindingReferences(
  value: unknown,
  selection: StorageSelection,
): { readonly d1: boolean; readonly r2: boolean } {
  if (!Array.isArray(value)) {
    throw preflightError("current Worker binding inventory is incomplete");
  }
  let d1 = false;
  let r2 = false;
  for (const binding of value) {
    if (!isRecord(binding) || typeof binding.type !== "string" || binding.type.length === 0) {
      throw preflightError("current Worker binding inventory contains an unnamed binding type");
    }
    if (binding.type === "d1") {
      const databaseId = binding.id ?? binding.database_id;
      if (
        (binding.id !== undefined &&
          binding.database_id !== undefined &&
          binding.id !== binding.database_id) ||
        typeof databaseId !== "string" ||
        !UUID.test(databaseId)
      ) {
        throw preflightError("current Worker D1 binding identity is incomplete");
      }
      if (databaseId === selection.databaseId) d1 = true;
    }
    if (binding.type === "r2_bucket") {
      if (typeof binding.bucket_name !== "string" || !RESOURCE_NAME.test(binding.bucket_name)) {
        throw preflightError("current Worker R2 binding identity is incomplete");
      }
      if (binding.bucket_name === selection.bucketName) r2 = true;
    }
  }
  return { d1, r2 };
}

async function verifiedStorageReadback(
  selection: StorageSelection,
  provider: IntegrationStorageDisposalProvider,
  failureMessage: string,
): Promise<StorageInventory> {
  try {
    return await readStorageInventory(selection, provider, "verification");
  } catch {
    throw verificationError(failureMessage);
  }
}

function statusResult(
  invocation: IntegrationStorageDisposalInvocation,
  selection: StorageSelection,
  inventory: FullInventory,
): Record<string, unknown> {
  return {
    kind: "takoserver.integration-storage-disposal-status@v1",
    surface: "takoserver-integration-storage-disposal",
    environment: "integration",
    selectedCommit: invocation.commit,
    accountId: selection.accountId,
    d1: {
      databaseName: selection.databaseName,
      databaseId: selection.databaseId,
      present: inventory.storage.d1 !== null,
    },
    r2: { bucketName: selection.bucketName, present: inventory.storage.r2 !== null },
    workerInventory: {
      coverage: "current-regular-and-dispatch-workers",
      coverageIncludes: [
        "regular-worker-settings",
        "current-serving-worker-versions",
        "dispatch-namespace-scripts-and-bindings",
      ],
      coverageExcludes: ["historical-worker-versions", "external-api-clients"],
      regularScripts: inventory.workers.regularScripts,
      dispatchNamespaces: inventory.workers.dispatchNamespaces,
      dispatchScripts: inventory.workers.dispatchScripts,
      currentBindingsInspected: inventory.workers.bindingsInspected,
      d1References: inventory.workers.d1References,
      r2References: inventory.workers.r2References,
    },
    readyForApply: !hasReferences(inventory.workers),
    mutationApplied: false,
    rollback: "no rollback; recreate forward with a new storage generation and explicit cutover",
  };
}

function applyResult(
  invocation: IntegrationStorageDisposalInvocation,
  selection: StorageSelection,
  reviewer: string | null,
  deletedR2: boolean,
  deletedD1: boolean,
): Record<string, unknown> {
  return {
    kind: "takoserver.integration-storage-disposal-apply@v1",
    surface: "takoserver-integration-storage-disposal",
    environment: "integration",
    selectedCommit: invocation.commit,
    reviewer,
    accountId: selection.accountId,
    d1: { databaseName: selection.databaseName, databaseId: selection.databaseId, present: false },
    r2: { bucketName: selection.bucketName, present: false },
    deletedR2,
    deletedD1,
    mutationApplied: deletedR2 || deletedD1,
    outcome: deletedR2 || deletedD1 ? "disposed" : "already-absent",
    verifiedAbsence: true,
    rollback: "no rollback; recreate forward with a new storage generation and explicit cutover",
  };
}

async function mapBounded<T extends {}, Result>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) throw new Error("bounded inventory queue lost an item");
      results[index] = await task(value);
    }
  });
  await Promise.all(workers);
  return results;
}

function deleteFailure(resource: "D1" | "R2", error: unknown, aftermath: string): DeployError {
  const outcome = error instanceof DeleteAcknowledgementError ? error.outcome : "unknown";
  return mutationError(
    outcome === "rejected"
      ? `Cloudflare rejected exact ${resource} deletion; ${aftermath}; inspect --status before retry`
      : `${resource} deletion acknowledgement is indeterminate; ${aftermath}; inspect --status before repair`,
  );
}

function assertUnreferenced(workers: WorkerInventory, fence: string): void {
  if (!hasReferences(workers)) return;
  throw preflightError(
    `storage disposal refused: ${fence} found a current Worker binding to selected storage`,
    JSON.stringify(referenceSummary(workers)),
  );
}

function hasReferences(workers: WorkerInventory): boolean {
  return workers.d1References.length > 0 || workers.r2References.length > 0;
}

function referenceSummary(workers: WorkerInventory): {
  readonly d1: readonly string[];
  readonly r2: readonly string[];
} {
  return { d1: workers.d1References, r2: workers.r2References };
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
