import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { DeployError, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  type DeployProcess,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget, ManagedWorkerDispatchNamespaceTarget } from "./target.ts";

const API = "https://api.cloudflare.com/client/v4";
const RECEIPT_KIND = "takoserver.managed-worker-dispatch-namespace-rehearsal@v1";
const RECEIPT_ENV = "TAKOSERVER_MANAGED_WORKER_DISPATCH_NAMESPACE_REHEARSAL_RECEIPT_PATH";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ManagedWorkerDispatchNamespaceInvocation {
  readonly surface: "takoserver-managed-worker-dispatch-namespace";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface ManagedWorkerDispatchNamespaceState {
  dispatchNamespace(name: string): Promise<unknown | null>;
}

export interface ManagedWorkerDispatchNamespaceMutation {
  create(name: string): Promise<{ readonly namespaceId: string | null }>;
}

export interface ManagedWorkerDispatchNamespaceMetadata {
  readonly createdBy: string;
  readonly createdOn: string;
  readonly modifiedBy: string;
  readonly modifiedOn: string;
  readonly namespaceId: string;
  readonly namespaceName: string;
  readonly scriptCount: number;
  readonly trustedWorkers: boolean;
}

export interface ManagedWorkerDispatchNamespaceInspection {
  readonly status: "absent" | "pin-existing" | "ready" | "drift";
  readonly ready: boolean;
  readonly plan: "create" | "pin-existing" | "none" | "refuse";
  readonly reason: string;
  readonly namespace: ManagedWorkerDispatchNamespaceMetadata | null;
  readonly pinnedNamespaceId: string | null;
}

interface RehearsalReceipt {
  readonly kind: typeof RECEIPT_KIND;
  readonly environment: "rehearsal";
  readonly sourceCommit: string;
  readonly sourceRemoteRef: string;
  readonly accountId: string;
  readonly namespaceName: string;
  readonly namespaceId: string;
  readonly namespaceScriptCount: 0;
  readonly namespaceTrustedWorkers: false;
  readonly result: "created-needs-target-pin";
}

interface RehearsalEvidence {
  readonly receipt: RehearsalReceipt;
  readonly digestHex: string;
}

export interface ManagedWorkerDispatchNamespaceOptions {
  readonly state?: ManagedWorkerDispatchNamespaceState;
  readonly mutate?: ManagedWorkerDispatchNamespaceMutation;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly run?: DeployProcess;
  readonly review?: string;
  readonly rehearsalReceiptPath?: string;
  readonly fetcher?: (request: Request) => Promise<Response>;
}

export function inspectManagedWorkerDispatchNamespace(
  value: unknown | null,
  input: { readonly name: string; readonly pinnedId?: string },
): ManagedWorkerDispatchNamespaceInspection {
  const name = exactName(input.name);
  const pinnedId =
    input.pinnedId === undefined ? null : exactUuid(input.pinnedId, "dispatch namespace target id");
  if (value === null) {
    return pinnedId === null
      ? {
          status: "absent",
          ready: false,
          plan: "create",
          reason: "dispatch namespace is authoritatively absent",
          namespace: null,
          pinnedNamespaceId: null,
        }
      : {
          status: "drift",
          ready: false,
          plan: "refuse",
          reason: "pinned dispatch namespace is absent and must never be recreated implicitly",
          namespace: null,
          pinnedNamespaceId: pinnedId,
        };
  }
  let namespace: ManagedWorkerDispatchNamespaceMetadata;
  try {
    namespace = parseMetadata(value);
  } catch {
    return {
      status: "drift",
      ready: false,
      plan: "refuse",
      reason: "dispatch namespace metadata is malformed",
      namespace: null,
      pinnedNamespaceId: pinnedId,
    };
  }
  if (namespace.namespaceName !== name) {
    return drift(namespace, pinnedId, "dispatch namespace name does not match the target");
  }
  if (namespace.trustedWorkers) {
    return drift(namespace, pinnedId, "dispatch namespace unexpectedly trusts dynamic workers");
  }
  if (pinnedId === null) {
    return namespace.scriptCount === 0
      ? {
          status: "pin-existing",
          ready: false,
          plan: "pin-existing",
          reason: "empty existing namespace requires an explicit target id pin",
          namespace,
          pinnedNamespaceId: null,
        }
      : drift(
          namespace,
          null,
          "unowned existing namespace contains scripts and cannot be adopted automatically",
        );
  }
  if (namespace.namespaceId !== pinnedId) {
    return drift(namespace, pinnedId, "dispatch namespace id does not match the target pin");
  }
  return {
    status: "ready",
    ready: true,
    plan: "none",
    reason: "dispatch namespace matches the exact pinned target identity",
    namespace,
    pinnedNamespaceId: pinnedId,
  };
}

export async function readPinnedManagedWorkerDispatchNamespace(
  phase: "preflight" | "verification",
  state: ManagedWorkerDispatchNamespaceState,
  target: DeployTarget,
): Promise<ManagedWorkerDispatchNamespaceInspection> {
  const topology = target.cloudflareProviderExecutor;
  if (!topology)
    throw phaseError(phase, "managed Worker dispatch namespace target topology is absent");
  if (topology.dispatchNamespaceId === undefined) {
    throw phaseError(phase, "managed Worker dispatch namespace requires an explicit target id pin");
  }
  let value: unknown | null;
  try {
    value = await state.dispatchNamespace(topology.dispatchNamespace);
  } catch (error) {
    throw phaseError(phase, "managed Worker dispatch namespace readback failed", error);
  }
  return inspectManagedWorkerDispatchNamespace(value, {
    name: topology.dispatchNamespace,
    pinnedId: topology.dispatchNamespaceId,
  });
}

export async function requirePinnedManagedWorkerDispatchNamespace(
  phase: "preflight" | "verification",
  state: ManagedWorkerDispatchNamespaceState,
  target: DeployTarget,
): Promise<ManagedWorkerDispatchNamespaceMetadata> {
  const inspection = await readPinnedManagedWorkerDispatchNamespace(phase, state, target);
  if (!inspection.ready || inspection.namespace === null) {
    throw phaseError(phase, `managed Worker dispatch namespace is not ready: ${inspection.reason}`);
  }
  return inspection.namespace;
}

export async function runManagedWorkerDispatchNamespace(
  invocation: ManagedWorkerDispatchNamespaceInvocation,
  target: ManagedWorkerDispatchNamespaceTarget,
  options: ManagedWorkerDispatchNamespaceOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("dispatch namespace invocation and target environments differ");
  }
  const topology = target.cloudflareProviderExecutor;
  if (!topology) throw preflightError("dispatch namespace requires exact target topology");
  const name = exactName(topology.dispatchNamespace);
  const run = options.run ?? runCommand;
  const credential =
    options.state === undefined || (invocation.action === "apply" && options.mutate === undefined)
      ? await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
        })
      : undefined;
  const accountId = exactAccountId(target.accountId);
  const state =
    options.state ??
    new CloudflareState({
      accountId,
      token: credential?.token ?? unavailableCredential(),
    });
  let inspection = inspectManagedWorkerDispatchNamespace(
    await readNamespace("preflight", state, name),
    {
      name,
      ...(topology.dispatchNamespaceId === undefined
        ? {}
        : { pinnedId: topology.dispatchNamespaceId }),
    },
  );
  if (invocation.action === "status") return statusResult(invocation, name, inspection);
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  if (inspection.plan === "none") {
    return applyResult(invocation, name, inspection, reviewer, "none", null);
  }
  if (inspection.plan === "pin-existing") {
    throw preflightError(
      "dispatch namespace already exists empty; pin its exact namespace_id in the target before continuing",
    );
  }
  if (inspection.plan !== "create") throw preflightError(inspection.reason);
  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    ...(invocation.environment === "rehearsal" ? { policy: "clean-remote" as const } : {}),
    run,
  });
  await runOwnerGate(run);
  const receiptPath =
    invocation.environment === "integration"
      ? null
      : exactReceiptPath(options.rehearsalReceiptPath ?? requireEnvironment(RECEIPT_ENV));
  let productionEvidence: RehearsalEvidence | null = null;
  if (invocation.environment === "rehearsal") assertReceiptAbsent(receiptPath as string);
  if (invocation.environment === "production") {
    productionEvidence = readReceipt(receiptPath as string);
    assertProductionReceipt(productionEvidence.receipt, source.commit);
  }
  inspection = inspectManagedWorkerDispatchNamespace(
    await readNamespace("preflight", state, name),
    {
      name,
      ...(topology.dispatchNamespaceId === undefined
        ? {}
        : { pinnedId: topology.dispatchNamespaceId }),
    },
  );
  if (inspection.plan !== "create") {
    throw preflightError(`dispatch namespace changed before creation: ${inspection.reason}`);
  }
  if (invocation.environment === "rehearsal") assertReceiptAbsent(receiptPath as string);
  if (productionEvidence !== null && receiptPath !== null) {
    const finalEvidence = readReceipt(receiptPath);
    assertProductionReceipt(finalEvidence.receipt, source.commit);
    if (finalEvidence.digestHex !== productionEvidence.digestHex) {
      throw preflightError("dispatch namespace rehearsal receipt changed before creation");
    }
  }
  const mutation =
    options.mutate ??
    createCloudflareDispatchNamespaceMutation({
      accountId,
      token: credential?.token ?? unavailableCredential(),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
  let acknowledged: { readonly namespaceId: string | null };
  try {
    acknowledged = await mutation.create(name);
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw mutationError(
      "Cloudflare dispatch namespace creation acknowledgement is indeterminate; do not retry",
      error instanceof Error ? error.name : typeof error,
    );
  }
  const rawAfter = await readNamespace("verification", state, name);
  const after = inspectManagedWorkerDispatchNamespace(rawAfter, { name });
  const created = after.namespace;
  if (
    after.status !== "pin-existing" ||
    created === null ||
    created.scriptCount !== 0 ||
    created.trustedWorkers ||
    (acknowledged.namespaceId !== null && acknowledged.namespaceId !== created.namespaceId)
  ) {
    throw verificationError(
      "created dispatch namespace readback does not match the acknowledged empty untrusted identity",
    );
  }
  let receiptDigest: string | null = productionEvidence?.digestHex ?? null;
  if (invocation.environment === "rehearsal") {
    if (source.remoteRef === null) {
      throw verificationError("rehearsal namespace creation has no exact remote source");
    }
    const receipt: RehearsalReceipt = {
      kind: RECEIPT_KIND,
      environment: "rehearsal",
      sourceCommit: source.commit,
      sourceRemoteRef: source.remoteRef,
      accountId,
      namespaceName: created.namespaceName,
      namespaceId: created.namespaceId,
      namespaceScriptCount: 0,
      namespaceTrustedWorkers: false,
      result: "created-needs-target-pin",
    };
    writeReceipt(receiptPath as string, receipt);
    const evidence = readReceipt(receiptPath as string);
    if (!receiptBytes(receipt).equals(receiptBytes(evidence.receipt))) {
      throw verificationError("dispatch namespace rehearsal receipt readback is not exact");
    }
    receiptDigest = evidence.digestHex;
  }
  return applyResult(invocation, name, after, reviewer, "created-needs-target-pin", receiptDigest);
}

export function createCloudflareDispatchNamespaceMutation(input: {
  readonly accountId: string;
  readonly token: string;
  readonly fetcher?: (request: Request) => Promise<Response>;
}): ManagedWorkerDispatchNamespaceMutation {
  const accountId = exactAccountId(input.accountId);
  const token = exactToken(input.token, "CLOUDFLARE_API_TOKEN", 4_096);
  const fetcher = input.fetcher ?? ((request: Request) => fetch(request));
  return {
    async create(name) {
      const exact = exactName(name);
      let response: Response;
      try {
        response = await fetcher(
          new Request(`${API}/accounts/${accountId}/workers/dispatch/namespaces`, {
            method: "POST",
            redirect: "error",
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({ name: exact }),
            signal: AbortSignal.timeout(15_000),
          }),
        );
      } catch (error) {
        throw mutationError(
          "Cloudflare dispatch namespace creation acknowledgement is indeterminate; do not retry",
          error instanceof Error ? error.name : typeof error,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBoundedText(response));
      } catch {
        throw mutationError(
          "Cloudflare dispatch namespace creation acknowledgement is indeterminate; do not retry",
          `HTTP ${response.status}`,
        );
      }
      if (!response.ok || !isRecord(body) || body.success !== true || !isRecord(body.result)) {
        throw mutationError(
          "Cloudflare dispatch namespace creation acknowledgement is indeterminate; do not retry",
          `HTTP ${response.status}`,
        );
      }
      const rawId = body.result.namespace_id;
      if (rawId !== undefined && (typeof rawId !== "string" || !UUID.test(rawId))) {
        throw mutationError(
          "Cloudflare dispatch namespace creation acknowledgement is indeterminate; do not retry",
          `HTTP ${response.status}`,
        );
      }
      if (
        (body.result.namespace_name !== undefined && body.result.namespace_name !== exact) ||
        (body.result.trusted_workers !== undefined && body.result.trusted_workers !== false)
      ) {
        throw mutationError(
          "Cloudflare dispatch namespace creation acknowledgement is indeterminate; do not retry",
          `HTTP ${response.status}`,
        );
      }
      return { namespaceId: (rawId as string | undefined) ?? null };
    },
  };
}

function parseMetadata(value: unknown): ManagedWorkerDispatchNamespaceMetadata {
  if (!isRecord(value)) throw new TypeError("metadata is not an object");
  const namespaceId = exactUuid(value.namespace_id, "dispatch namespace id");
  const namespaceName = exactName(value.namespace_name);
  const scriptCount = value.script_count;
  if (!Number.isSafeInteger(scriptCount) || Number(scriptCount) < 0) {
    throw new TypeError("dispatch namespace script count is invalid");
  }
  const trustedWorkers = Object.hasOwn(value, "trusted_workers") ? value.trusted_workers : false;
  if (typeof trustedWorkers !== "boolean") {
    throw new TypeError("dispatch namespace trust flag is invalid");
  }
  return {
    createdBy: exactToken(value.created_by, "dispatch namespace creator", 512),
    createdOn: exactToken(value.created_on, "dispatch namespace creation time", 512),
    modifiedBy: exactToken(value.modified_by, "dispatch namespace modifier", 512),
    modifiedOn: exactToken(value.modified_on, "dispatch namespace modification time", 512),
    namespaceId,
    namespaceName,
    scriptCount: Number(scriptCount),
    trustedWorkers,
  };
}

function drift(
  namespace: ManagedWorkerDispatchNamespaceMetadata,
  pinnedNamespaceId: string | null,
  reason: string,
): ManagedWorkerDispatchNamespaceInspection {
  return {
    status: "drift",
    ready: false,
    plan: "refuse",
    reason,
    namespace,
    pinnedNamespaceId,
  };
}

function statusResult(
  invocation: ManagedWorkerDispatchNamespaceInvocation,
  name: string,
  inspection: ManagedWorkerDispatchNamespaceInspection,
): Record<string, unknown> {
  return {
    kind: "takoserver.managed-worker-dispatch-namespace-status@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    namespaceName: name,
    namespaceId: inspection.namespace?.namespaceId ?? null,
    pinnedNamespaceId: inspection.pinnedNamespaceId,
    scriptCount: inspection.namespace?.scriptCount ?? null,
    trustedWorkers: inspection.namespace?.trustedWorkers ?? null,
    status: inspection.status,
    ready: inspection.ready,
    plan: inspection.plan,
    reason: inspection.reason,
  };
}

function applyResult(
  invocation: ManagedWorkerDispatchNamespaceInvocation,
  name: string,
  inspection: ManagedWorkerDispatchNamespaceInspection,
  reviewer: string,
  mutation: "none" | "created-needs-target-pin",
  rehearsalReceiptDigestHex: string | null,
): Record<string, unknown> {
  return {
    kind: "takoserver.managed-worker-dispatch-namespace-apply@v1",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    namespaceName: name,
    namespaceId: inspection.namespace?.namespaceId ?? null,
    pinnedNamespaceId: inspection.pinnedNamespaceId,
    scriptCount: inspection.namespace?.scriptCount ?? null,
    trustedWorkers: inspection.namespace?.trustedWorkers ?? null,
    status: inspection.status,
    ready: inspection.ready,
    mutation,
    reviewer,
    rehearsalReceiptDigest:
      rehearsalReceiptDigestHex === null ? null : `sha256:${rehearsalReceiptDigestHex}`,
  };
}

function exactReceiptPath(value: string): string {
  if (!isAbsolute(value) || value.trim() !== value || value.length > 4_096) {
    throw preflightError(
      "dispatch namespace rehearsal receipt path must be an exact absolute path",
    );
  }
  const requested = resolve(value);
  let parent: string;
  try {
    parent = realpathSync(dirname(requested));
  } catch {
    throw preflightError("dispatch namespace rehearsal receipt parent is unavailable");
  }
  const path = join(parent, basename(requested));
  const fromRepository = relative(realpathSync(REPOSITORY), path);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw preflightError("dispatch namespace rehearsal receipt must stay outside the repository");
  }
  const held = statSync(parent, { throwIfNoEntry: false });
  if (
    !held?.isDirectory() ||
    (held.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && held.uid !== process.getuid())
  ) {
    throw preflightError(
      "dispatch namespace rehearsal receipt parent must be an owned mode-0700 directory",
    );
  }
  for (let cursor = parent; ; ) {
    if (existsSync(join(cursor, ".git"))) {
      throw preflightError(
        "dispatch namespace rehearsal receipt must stay outside every Git repository",
      );
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return path;
}

function assertReceiptAbsent(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw preflightError(
      "dispatch namespace rehearsal receipt already exists and cannot be overwritten",
    );
  }
}

function writeReceipt(path: string, receipt: RehearsalReceipt): void {
  try {
    writeFileSync(path, receiptBytes(receipt), { flag: "wx", mode: 0o600 });
  } catch {
    throw verificationError(
      "dispatch namespace was created but rehearsal receipt could not be written; inspect status before repair",
    );
  }
}

function readReceipt(path: string): RehearsalEvidence {
  const bytes = readSecureFile(path);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw preflightError("dispatch namespace rehearsal receipt is not valid UTF-8 JSON");
  }
  const receipt = parseReceipt(value);
  if (!bytes.equals(receiptBytes(receipt))) {
    throw preflightError("dispatch namespace rehearsal receipt is not canonical exact-byte JSON");
  }
  return { receipt, digestHex: createHash("sha256").update(bytes).digest("hex") };
}

function readSecureFile(path: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw preflightError("dispatch namespace rehearsal receipt must be an owned link-free file");
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      Number(before.mode & 0o777n) !== 0o600 ||
      before.size < 3n ||
      before.size > 16_384n ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      throw preflightError(
        "dispatch namespace rehearsal receipt must be an owned single-link mode-0600 bounded file",
      );
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes.byteLength !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.nlink !== after.nlink ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw preflightError("dispatch namespace rehearsal receipt changed while it was read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseReceipt(value: unknown): RehearsalReceipt {
  const keys = [
    "accountId",
    "environment",
    "kind",
    "namespaceId",
    "namespaceName",
    "namespaceScriptCount",
    "namespaceTrustedWorkers",
    "result",
    "sourceCommit",
    "sourceRemoteRef",
  ];
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== keys.join(",") ||
    value.kind !== RECEIPT_KIND ||
    value.environment !== "rehearsal" ||
    typeof value.sourceCommit !== "string" ||
    !COMMIT.test(value.sourceCommit) ||
    typeof value.accountId !== "string" ||
    !ACCOUNT_ID.test(value.accountId) ||
    value.namespaceScriptCount !== 0 ||
    value.namespaceTrustedWorkers !== false ||
    value.result !== "created-needs-target-pin"
  ) {
    throw preflightError("dispatch namespace rehearsal receipt has an invalid exact shape");
  }
  return {
    kind: RECEIPT_KIND,
    environment: "rehearsal",
    sourceCommit: value.sourceCommit,
    sourceRemoteRef: exactToken(value.sourceRemoteRef, "receipt remote source", 1_024),
    accountId: value.accountId,
    namespaceName: exactName(value.namespaceName),
    namespaceId: exactUuid(value.namespaceId, "receipt namespace id"),
    namespaceScriptCount: 0,
    namespaceTrustedWorkers: false,
    result: "created-needs-target-pin",
  };
}

function assertProductionReceipt(receipt: RehearsalReceipt, commit: string): void {
  if (receipt.sourceCommit !== commit) {
    throw preflightError(
      "dispatch namespace production creation requires a successful fresh rehearsal receipt for the same commit",
    );
  }
}

function receiptBytes(receipt: RehearsalReceipt): Buffer {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

async function runOwnerGate(run: DeployProcess): Promise<void> {
  const result = await run(["bun", "run", "check"]);
  if (result.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
}

async function readNamespace(
  phase: "preflight" | "verification",
  state: ManagedWorkerDispatchNamespaceState,
  name: string,
): Promise<unknown | null> {
  try {
    return await state.dispatchNamespace(name);
  } catch (error) {
    throw phaseError(phase, "dispatch namespace readback failed", error);
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new TypeError("response is too large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TypeError("response is too large");
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

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function exactName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw preflightError("managed Worker dispatch namespace name is invalid");
  }
  return value;
}

function exactUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw preflightError(`${label} is invalid`);
  return value;
}

function exactAccountId(value: string): string {
  if (!ACCOUNT_ID.test(value)) throw preflightError("Cloudflare account id is invalid");
  return value;
}

function exactToken(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw preflightError(`${label} is invalid`);
  }
  return value;
}

function unavailableCredential(): never {
  throw preflightError("Cloudflare credential is unavailable");
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
