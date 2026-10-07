import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  SELFHOST_WORKER_EVENT_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_HEADER,
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_TOKEN_HEADER,
  selfhostScheduleEvent,
} from "./providers/selfhost-events.ts";
import {
  randomSelfhostDeploymentBasisPoint,
  selectSelfhostWeightedVersion,
} from "./selfhost-weighted-deployment.ts";
import {
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
} from "./takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "./takoform-v2/types.ts";
import type { V2CodeConfiguredInputReader } from "./takoform-v2/worker-lifecycle-backend.ts";
import type {
  V2WorkerPublicationResolution,
  V2WorkerPublicationSnapshot,
} from "./takoform-v2/worker-publication-state.ts";
import {
  createV2WorkerPublication,
  type V2EndpointRouteAbsentReceipt,
  type V2WorkerPublicationResult,
} from "./takoform-v2/worker-static-publication.ts";
import {
  type LinuxProcessIdentity,
  linuxProcessLiveness,
  readLinuxProcessIdentity,
  workerPortOwnership,
} from "./workerd-linux-process.ts";
import type {
  HostedWorkerdRuntime,
  WorkerdPublicationIdentity,
  WorkerdRuntime,
  WorkerdSite,
  WorkerdStaticSite,
} from "./workerd-runtime.ts";
import { createWorkerdRuntime } from "./workerd-runtime.ts";
import type { WorkerdProcess } from "./workerd-supervisor.ts";
import {
  inspectWorkerdWorkerExecutionCopies,
  openWorkerdWorkerExecutionGroup,
  releaseRetiredWorkerdWorkerExecutionCopies,
  verifyRetiredWorkerdWorkerExecutionCopies,
  type WorkerdWorkerExecutionGroup,
  type WorkerdWorkerRetirementReceipt,
} from "./workerd-worker-execution-group.ts";

const STATE_NAME = "runtime-owner.json";
const LOCK_NAME = "runtime-owner.lock";
const LEGACY_STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@1";
const PREVIOUS_STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@2";
const RETIRED_COPIES_STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@3";
const CLEANUP_STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@4";
const ROUTE_RECEIPT_STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@5";
const PROCESS_PIN_STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@6";
const EVENTLESS_STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@7";
const STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@8";
const LOCK_SCHEMA = "takoserver.v2-worker-runtime-owner-lock@2";
const OPERATION_MARKER = "takoserver-v2-operation:";
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DRAIN_GRACE_MS = 15 * 60 * 1000;
const LOCK_MAX_BYTES = 2_048;
const RECOVERY_PREFIX = ".runtime-owner-recovery.";
const ENDPOINT_HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

type PublicationState = {
  resolve(input: {
    execution: V2Execution;
    incumbentSourceOperationId?: string;
  }): Promise<V2WorkerPublicationResolution>;
  resolveCurrentServing?(input: {
    readonly workerUid: string;
    readonly targetKey: string;
    readonly sourceOperationId: string;
    readonly expectedIdentity: WorkerdPublicationIdentity;
  }): Promise<
    | {
        readonly kind: "ready";
        readonly snapshot: V2WorkerPublicationSnapshot;
        stillCurrent(): Promise<boolean>;
      }
    | { readonly kind: "unresolved"; readonly code: string; readonly message: string }
  >;
};

type IncarnationStatus = "candidate" | "active" | "draining" | "retiring" | "retired" | "uncertain";

interface IncarnationRecord {
  readonly operationId: string;
  readonly listenerPort: number;
  readonly status: IncarnationStatus;
  readonly retirementOperationId: string | null;
  readonly retireAtMs: number | null;
  /** Whether this exact candidate graph may have ctx.waitUntil work past response completion. */
  readonly deferRetirementUntilDeadline: boolean;
  /** Persisted only after the exact retired group's execution copies are absent. */
  readonly executionCopiesReleased: boolean;
  /** Persisted with the exact group receipt before any execution-copy rename/removal. */
  readonly executionCopiesCleanupStarted: boolean;
  /** Exact pre-cleanup path/type/size/content-digest inventory pinned in owner state. */
  readonly executionCopiesCleanupManifestSha256: string | null;
  /** Exact current OS child identity, persisted before readiness or publication. */
  readonly processIdentity: LinuxProcessIdentity | null;
  /** Exact config bytes pinned when this incarnation became active. */
  readonly configurationSha256: string | null;
  /** Recovery is re-rendering the same accepted graph with a new private readiness token. */
  readonly configurationRefreshPending: boolean;
  /** Private per-incarnation event gate credential; null for pre-event incarnations. */
  readonly eventToken: string | null;
  readonly identity: WorkerdPublicationIdentity | null;
  readonly receipt: WorkerdWorkerRetirementReceipt | null;
}

interface PersistedOwnerState {
  readonly schema: typeof STATE_SCHEMA;
  readonly workerResourceUid: string;
  readonly activeOperationId: string | null;
  readonly admissionClosedBy: string | null;
  readonly deletionPublicationConfirmed: boolean;
  /** Latest exact no-active-Deployment Endpoint absence proof in this owner record. */
  readonly endpointRouteAbsence: V2WorkerEndpointRouteAbsentResult | null;
  readonly incarnations: readonly IncarnationRecord[];
}

interface ActiveInvocation {
  readonly abort: AbortController;
  readonly done: Promise<void>;
  readonly finish: () => void;
  bodyController?: ReadableStreamDefaultController<Uint8Array>;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  finished: boolean;
}

interface IncarnationHandle {
  record: IncarnationRecord;
  readonly group: WorkerdWorkerExecutionGroup;
  readonly runtime: HostedWorkerdRuntime;
  readonly publication: ReturnType<typeof createV2WorkerPublication>;
  readonly invocations: Set<ActiveInvocation>;
  retirementTimer?: () => void;
  retiring?: Promise<WorkerdWorkerRetirementReceipt>;
}

export class WorkerdWorkerRuntimeOwnerError extends Error {
  readonly code: "invalid_identity" | "ownership_uncertain" | "not_serving" | "admission_closed";

  constructor(code: WorkerdWorkerRuntimeOwnerError["code"]) {
    super(code);
    this.name = "WorkerdWorkerRuntimeOwnerError";
    this.code = code;
  }
}

/** Explicit no-active-Deployment endpoint absence, never Worker teardown. */
export type V2WorkerEndpointRouteAbsentResult = V2EndpointRouteAbsentReceipt;

export type V2WorkerRuntimeOwnerExecutionResult =
  | V2WorkerPublicationResult
  | V2WorkerEndpointRouteAbsentResult;

export interface WorkerdWorkerRuntimeOwner {
  readonly workerResourceUid: string;
  /** Run one accepted WorkerDeployment or WorkerEndpoint Operation for this UID. */
  execute(execution: V2Execution): Promise<V2WorkerRuntimeOwnerExecutionResult>;
  /** Read exact current serving truth without changing publication state. */
  observeServing(input: {
    readonly workerResourceUid: string;
    readonly targetKey: string;
  }): Promise<
    | {
        readonly kind: "serving";
        readonly workerResourceUid: string;
        readonly targetKey: string;
        readonly sourceOperationId: string;
        readonly generation: string;
        readonly hostnames: readonly string[];
        readonly versions: readonly {
          readonly workerVersionUid: string;
          readonly weight: number;
        }[];
      }
    | { readonly kind: "unknown" }
  >;
  /** Prove absence only after the exact active inventory or all retired receipts. */
  observeRetirement(input: { readonly workerVersionUid?: string }): Promise<
    | {
        readonly kind: "confirmed_absent";
        readonly workerResourceUid: string;
        readonly targetKey: string;
        readonly workerVersionUid?: string;
        readonly incarnationOperationIds: readonly string[];
      }
    | { readonly kind: "unknown" }
  >;
  /** Route a Host-accepted request to the exact active incarnation. */
  fetch(request: Request): Promise<Response>;
  /** Deliver one persisted cron match through the selected current private Version gate. */
  invokeScheduled(input: {
    readonly triggerUid: string;
    readonly workerUid: string;
    readonly cron: string;
    readonly scheduledTime: number;
    readonly matchId: string;
  }): Promise<
    | { readonly kind: "handler_resolved"; readonly workerVersionUid: string }
    | { readonly kind: "handler_rejected"; readonly workerVersionUid: string }
    | { readonly kind: "unknown" }
  >;
  /** Non-effecting proof that every current weighted Version can receive scheduled events. */
  observeScheduledCapability(input: {
    readonly workerUid: string;
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
  }): Promise<
    | {
        readonly kind: "confirmed";
        readonly servingSourceOperationId: string;
        readonly deploymentUid: string;
        readonly deploymentGeneration: number;
        readonly versions: readonly {
          readonly workerVersionUid: string;
          readonly generation: number;
          readonly weight: number;
        }[];
        stillCurrent(): Promise<boolean>;
      }
    | { readonly kind: "unknown" }
  >;
  /** Release the owner lock only after every known incarnation has a durable receipt. */
  close(): Promise<void>;
}

export interface OpenWorkerdWorkerRuntimeOwnerOptions {
  /** Private operator-owned root for this Worker UID. */
  readonly rootDirectory: string;
  readonly workerResourceUid: string;
  readonly targetKey: string;
  readonly publicationState: PublicationState;
  /** Exact Resource-owned configured input reader, shared with Version eligibility. */
  readonly configuredInputs?: V2CodeConfiguredInputReader;
  readonly workerdBinary: string | null;
  /** Trusted code-module inspector; absent uses the WorkerdRuntime's pinned inspector. */
  readonly inspectModule?: WorkerdRuntime["inspectModule"];
  /** Deterministic retirement scheduler; serving composition uses bounded real timers. */
  readonly scheduleRetirement?: (run: () => void, delayMs: number) => () => void;
  /** Allocate a distinct private listener for each immutable Deployment incarnation. */
  readonly listenerPortForOperation: (operationId: string) => number | Promise<number>;
  readonly spawn?: (command: readonly string[]) => WorkerdProcess;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function scheduledAnswer(
  answer: { readonly status: number; readonly body: string } | null | undefined,
): "handler_resolved" | "handler_rejected" | null {
  if (!answer || answer.body.length > 65_536) return null;
  try {
    const parsed: unknown = JSON.parse(answer.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "kind,outcome,protocol" ||
      value.kind !== "schedule" ||
      value.protocol !== SELFHOST_WORKER_EVENT_PROTOCOL
    ) {
      return null;
    }
    if (answer.status === 200 && value.outcome === "ack") return "handler_resolved";
    if (answer.status === 500 && value.outcome === "rejected") return "handler_rejected";
  } catch {
    // A transport body that is not this Host's exact response decides nothing.
  }
  return null;
}

interface OwnerProcessFingerprint {
  readonly bootId: string;
  readonly pidNamespace: string;
  readonly startTimeTicks: string;
}

interface RuntimeOwnerLockRecord {
  readonly schema: typeof LOCK_SCHEMA;
  readonly ownerId: string;
  readonly pid: number;
  readonly process: OwnerProcessFingerprint | null;
  readonly device: string;
  readonly inode: string;
}

interface OwnerFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly links: bigint;
}

interface OpenedOwnerLock {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly record: RuntimeOwnerLockRecord;
  readonly recoveredFromStaleOwner: boolean;
}

interface ReadOwnerLock {
  readonly record: RuntimeOwnerLockRecord;
  readonly identity: OwnerFileIdentity;
}

type ProcessLiveness = "live" | "stale" | "unknown";

function sameOwnerFile(left: OwnerFileIdentity, right: OwnerFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function parseOwnerFingerprint(value: unknown): OwnerProcessFingerprint | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "bootId,pidNamespace,startTimeTicks" ||
    typeof candidate.bootId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(candidate.bootId) ||
    typeof candidate.startTimeTicks !== "string" ||
    !/^\d{1,32}$/u.test(candidate.startTimeTicks) ||
    typeof candidate.pidNamespace !== "string" ||
    !/^\d{1,32}:\d{1,32}$/u.test(candidate.pidNamespace)
  ) {
    return undefined;
  }
  return {
    bootId: candidate.bootId.toLowerCase(),
    pidNamespace: candidate.pidNamespace,
    startTimeTicks: candidate.startTimeTicks,
  };
}

function parseOwnerLockRecord(value: unknown, identity: OwnerFileIdentity): RuntimeOwnerLockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  const candidate = value as Record<string, unknown>;
  const expectedKeys = ["device", "inode", "ownerId", "pid", "process", "schema"];
  const processFingerprint = parseOwnerFingerprint(candidate.process);
  if (
    Object.keys(candidate).sort().join(",") !== expectedKeys.join(",") ||
    candidate.schema !== LOCK_SCHEMA ||
    typeof candidate.ownerId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      candidate.ownerId,
    ) ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid as number) < 1 ||
    processFingerprint === undefined ||
    candidate.device !== identity.device ||
    candidate.inode !== identity.inode
  ) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
  return {
    schema: LOCK_SCHEMA,
    ownerId: candidate.ownerId,
    pid: candidate.pid as number,
    process: processFingerprint,
    device: identity.device,
    inode: identity.inode,
  };
}

function ownerFileIdentity(stat: { dev: bigint; ino: bigint; nlink: bigint }): OwnerFileIdentity {
  return { device: String(stat.dev), inode: String(stat.ino), links: stat.nlink };
}

async function readBoundedText(path: string, maximumBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead <= 0) break;
      offset += result.bytesRead;
    }
    if (offset > maximumBytes) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function currentOwnerFingerprint(): Promise<OwnerProcessFingerprint | null> {
  if (process.platform !== "linux") return null;
  const [bootIdText, statText, namespace] = await Promise.all([
    readBoundedText("/proc/sys/kernel/random/boot_id", 128),
    readBoundedText(`/proc/${process.pid}/stat`, 4_096),
    stat("/proc/self/ns/pid", { bigint: true }).catch(() => null),
  ]);
  const bootId = bootIdText?.trim().toLowerCase();
  if (
    !bootId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId) ||
    !statText ||
    !namespace
  ) {
    return null;
  }
  const commandEnd = statText.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = statText
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTimeTicks = fields[19];
  if (!startTimeTicks || !/^\d{1,32}$/u.test(startTimeTicks)) return null;
  return {
    bootId,
    pidNamespace: `${namespace.dev}:${namespace.ino}`,
    startTimeTicks,
  };
}

async function processLiveness(
  pid: number,
  expected: OwnerProcessFingerprint | null,
): Promise<ProcessLiveness> {
  if (expected === null) return "unknown";
  const namespace = await stat("/proc/self/ns/pid", { bigint: true }).catch(() => null);
  if (!namespace || `${namespace.dev}:${namespace.ino}` !== expected.pidNamespace) return "unknown";
  let currentBootId: string | null = null;
  const bootIdText = await readBoundedText("/proc/sys/kernel/random/boot_id", 128);
  const bootId = bootIdText?.trim().toLowerCase();
  if (bootId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId))
    currentBootId = bootId;
  if (!currentBootId) return "unknown";
  if (expected.bootId !== currentBootId) return "unknown";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "stale";
    return "unknown";
  }
  const statText = await readBoundedText(`/proc/${pid}/stat`, 4_096);
  if (!statText) return "unknown";
  const commandEnd = statText.lastIndexOf(")");
  if (commandEnd < 0) return "unknown";
  const fields = statText
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const startTimeTicks = fields[19];
  if (!state || !startTimeTicks || !/^\d{1,32}$/u.test(startTimeTicks)) return "unknown";
  if (startTimeTicks !== expected.startTimeTicks) return "stale";
  // A zombie has exited and cannot hold admission or restart a child. Listener
  // vacancy is checked separately before a successor can take ownership.
  return state === "Z" || state === "X" ? "stale" : "live";
}

async function readOwnerLock(path: string): Promise<ReadOwnerLock | null> {
  const before = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  if (before === null) return null;
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077n) !== 0n)
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    const identity = ownerFileIdentity(stat);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077n) !== 0n ||
      stat.size < 1n ||
      stat.size > BigInt(LOCK_MAX_BYTES)
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(text, "utf8") > LOCK_MAX_BYTES)
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const after = await lstat(path, { bigint: true });
    const afterIdentity = ownerFileIdentity(after);
    if (
      !sameOwnerFile(identity, ownerFileIdentity(before)) ||
      !sameOwnerFile(identity, afterIdentity)
    )
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const record = parseOwnerLockRecord(parsed, identity);
    if (canonicalJson(record) !== text)
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    return { record, identity: afterIdentity };
  } catch (error) {
    if (error instanceof WorkerdWorkerRuntimeOwnerError) throw error;
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface OwnerStateSnapshot {
  readonly state: PersistedOwnerState;
  readonly identity: OwnerFileIdentity | null;
  readonly text: string | null;
}

async function readOwnerStateSnapshot(
  path: string,
  workerResourceUid: string,
): Promise<OwnerStateSnapshot> {
  const before = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  if (before === null) return { state: emptyState(workerResourceUid), identity: null, text: null };
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o077n) !== 0n ||
    before.size > 8_388_608n
  ) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
  const identity = ownerFileIdentity(before);
  const text = await readFile(path, "utf8").catch(() => {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  const after = await lstat(path, { bigint: true }).catch(() => null);
  if (!after || !sameOwnerFile(identity, ownerFileIdentity(after)))
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  return { state: parseState(text, workerResourceUid), identity, text };
}

function hasOnlyRetiredOrRetirementPendingIncarnations(state: PersistedOwnerState): boolean {
  return state.incarnations.every(
    (item) =>
      (item.status === "retired" && item.receipt !== null && item.retirementOperationId) ||
      ((item.status === "retiring" || item.status === "uncertain") &&
        item.retirementOperationId !== null),
  );
}

async function requireVacantOwnerListeners(state: PersistedOwnerState): Promise<void> {
  const ports = new Set(state.incarnations.map((item) => item.listenerPort));
  for (const port of ports) {
    if ((await workerPortOwnership(port, undefined)) !== "vacant")
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path, { bigint: true }).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077n) !== 0n) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
}

async function requireExactEntries(path: string, expected: readonly string[]): Promise<void> {
  const actual = await readdir(path).catch(() => {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  if (canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
}

async function verifyKnownGroupContents(
  groupDirectory: string,
  record: IncarnationRecord,
): Promise<void> {
  const entries = await readdir(groupDirectory).catch(() => {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  const retired = record.status === "retired";
  const draining = record.status === "draining";
  const allowed =
    retired || draining
      ? new Set([
          "group.json",
          "retirement.json",
          "workers",
          "assets",
          ...(retired || record.executionCopiesCleanupStarted ? [".retired-execution-copies"] : []),
        ])
      : new Set(["group.json", "workers", "assets"]);
  if (
    !entries.includes("group.json") ||
    !entries.includes("workers") ||
    (retired && !entries.includes("retirement.json")) ||
    entries.some((entry) => !allowed.has(entry))
  ) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
  for (const entry of entries) {
    const path = join(groupDirectory, entry);
    const info = await lstat(path, { bigint: true }).catch(() => null);
    if (!info || info.isSymbolicLink() || (info.mode & 0o077n) !== 0n) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    if (entry === "group.json" || entry === "retirement.json") {
      if (!info.isFile()) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    } else if (!info.isDirectory()) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
  }
}

/**
 * Under the exact UID owner lock, prove that persisted incarnations are the
 * complete namespace inventory. Unknown/orphan entries are evidence gaps,
 * never garbage to clean up.
 */
async function verifyOwnerNamespace(
  directory: string,
  state: PersistedOwnerState,
  workerResourceUid: string,
): Promise<void> {
  const stateInfo = await lstat(join(directory, STATE_NAME)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  const incarnationRoot = join(directory, "incarnations");
  const incarnationInfo = await lstat(incarnationRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  const topLevel = [
    LOCK_NAME,
    ...(stateInfo ? [STATE_NAME] : []),
    ...(incarnationInfo ? ["incarnations"] : []),
  ];
  await requireExactEntries(directory, topLevel);
  if (stateInfo && (!stateInfo.isFile() || stateInfo.isSymbolicLink())) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
  if (incarnationInfo && (!incarnationInfo.isDirectory() || incarnationInfo.isSymbolicLink())) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
  const expectedOperations = state.incarnations.map((record) => record.operationId).sort();
  if (expectedOperations.length === 0) {
    if (incarnationInfo !== null) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    return;
  }
  if (incarnationInfo === null) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  await requirePrivateDirectory(incarnationRoot);
  await requireExactEntries(incarnationRoot, expectedOperations);
  const groupsName = "groups";
  const workerKey = uidKey(workerResourceUid);
  for (const operationId of expectedOperations) {
    if (!OPERATION_ID.test(operationId))
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const record = state.incarnations.find((item) => item.operationId === operationId);
    if (!record) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const operationRoot = join(incarnationRoot, operationId);
    await requirePrivateDirectory(operationRoot);
    await requireExactEntries(operationRoot, [groupsName]);
    const groupsRoot = join(operationRoot, groupsName);
    await requirePrivateDirectory(groupsRoot);
    await requireExactEntries(groupsRoot, [workerKey]);
    const groupDirectory = join(groupsRoot, workerKey);
    await requirePrivateDirectory(groupDirectory);
    await verifyKnownGroupContents(groupDirectory, record);
  }
}

function recoveryClaimName(fingerprint: OwnerProcessFingerprint, ownerId: string): string {
  return `${RECOVERY_PREFIX}${process.pid}.${fingerprint.bootId}.${fingerprint.startTimeTicks}.${fingerprint.pidNamespace}.${ownerId}`;
}

function parseRecoveryClaimName(name: string): {
  readonly pid: number;
  readonly fingerprint: OwnerProcessFingerprint;
} | null {
  if (!name.startsWith(RECOVERY_PREFIX)) return null;
  const parts = name.slice(RECOVERY_PREFIX.length).split(".");
  const [pidText, bootId, startTimeTicks, pidNamespace, ownerId] = parts;
  if (
    parts.length !== 5 ||
    !pidText ||
    !/^\d{1,10}$/u.test(pidText) ||
    !bootId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(bootId) ||
    !startTimeTicks ||
    !/^\d{1,32}$/u.test(startTimeTicks) ||
    !pidNamespace ||
    !/^\d{1,32}:\d{1,32}$/u.test(pidNamespace) ||
    !ownerId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ownerId)
  ) {
    return null;
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  return {
    pid,
    fingerprint: { bootId: bootId.toLowerCase(), pidNamespace, startTimeTicks },
  };
}

async function cleanStaleRecoveryClaims(directory: string): Promise<number> {
  const entries = await readdir(directory).catch(() => {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  let count = 0;
  for (const name of entries) {
    if (!name.startsWith(RECOVERY_PREFIX)) continue;
    count += 1;
    if (count > 64) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const parsed = parseRecoveryClaimName(name);
    if (!parsed) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    if ((await processLiveness(parsed.pid, parsed.fingerprint)) !== "stale") continue;
    const path = join(directory, name);
    const stat = await lstat(path, { bigint: true }).catch(() => null);
    if (stat === null) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077n) !== 0n)
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    if ((await processLiveness(parsed.pid, parsed.fingerprint)) !== "stale") continue;
    await unlink(path).catch(() => {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    });
    await syncDirectory(directory);
  }
  const remaining = await readdir(directory).catch(() => {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  });
  return remaining.filter((name) => name.startsWith(RECOVERY_PREFIX)).length;
}

async function createOwnerLock(path: string, directory: string): Promise<OpenedOwnerLock | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: OwnerFileIdentity | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const stat = await handle.stat({ bigint: true });
    identity = ownerFileIdentity(stat);
    const record: RuntimeOwnerLockRecord = {
      schema: LOCK_SCHEMA,
      ownerId: randomUUID(),
      pid: process.pid,
      process: await currentOwnerFingerprint(),
      device: identity.device,
      inode: identity.inode,
    };
    await handle.writeFile(canonicalJson(record), "utf8");
    await handle.sync();
    await syncDirectory(directory);
    return { handle, record, recoveredFromStaleOwner: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && !handle) return null;
    if (identity) {
      const current = await lstat(path, { bigint: true }).catch(() => null);
      if (current && sameOwnerFile(identity, ownerFileIdentity(current)))
        await unlink(path).catch(() => undefined);
    }
    await handle?.close().catch(() => undefined);
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
}

async function requireSafeStateForNewOwner(
  snapshot: OwnerStateSnapshot,
  allowDeleteReplayOnly: boolean,
  allowProcessRecovery = false,
): Promise<void> {
  if (hasOnlyRetiredOrRetirementPendingIncarnations(snapshot.state)) {
    if (
      allowDeleteReplayOnly &&
      (snapshot.state.admissionClosedBy === null || !snapshot.state.deletionPublicationConfirmed)
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    if (allowDeleteReplayOnly) await requireVacantOwnerListeners(snapshot.state);
    return;
  }
  if (!allowProcessRecovery || !recoverableIncarnationSet(snapshot.state)) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
  await requireStaleIncarnationChildrenAndVacantListeners(snapshot.state);
}

function recoverableIncarnationSet(state: PersistedOwnerState): boolean {
  const active = state.incarnations.filter((record) => record.status === "active");
  if (
    state.admissionClosedBy !== null ||
    state.deletionPublicationConfirmed ||
    state.endpointRouteAbsence !== null ||
    !state.activeOperationId ||
    active.length !== 1 ||
    active[0]?.operationId !== state.activeOperationId
  ) {
    return false;
  }
  return state.incarnations.every((record) => {
    if (record.status === "retired") {
      return record.receipt !== null && record.retirementOperationId !== null;
    }
    return (
      (record.status === "active" || record.status === "draining") &&
      record.identity !== null &&
      record.processIdentity !== null &&
      record.configurationSha256 !== null &&
      (record.status === "active"
        ? record.receipt === null && !record.executionCopiesCleanupStarted
        : record.retirementOperationId !== null &&
          (record.executionCopiesCleanupStarted
            ? record.receipt !== null && record.executionCopiesCleanupManifestSha256 !== null
            : record.receipt === null))
    );
  });
}

async function requireStaleIncarnationChildrenAndVacantListeners(
  state: PersistedOwnerState,
): Promise<void> {
  const ports = new Set<number>();
  for (const record of state.incarnations) {
    if (record.status !== "active" && record.status !== "draining") continue;
    if (
      !record.processIdentity ||
      (await linuxProcessLiveness(record.processIdentity)) !== "stale" ||
      ports.has(record.listenerPort)
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    ports.add(record.listenerPort);
  }
  for (const port of ports) {
    if ((await workerPortOwnership(port, undefined)) !== "vacant") {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
  }
}

async function sameOwnerStateSnapshot(
  path: string,
  workerResourceUid: string,
  expected: OwnerStateSnapshot,
): Promise<boolean> {
  const current = await readOwnerStateSnapshot(path, workerResourceUid);
  return (
    current.text === expected.text &&
    ((current.identity === null && expected.identity === null) ||
      (current.identity !== null &&
        expected.identity !== null &&
        sameOwnerFile(current.identity, expected.identity)))
  );
}

async function acquireOwnerLock(
  directory: string,
  statePath: string,
  workerResourceUid: string,
): Promise<OpenedOwnerLock> {
  const lockPath = join(directory, LOCK_NAME);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const remainingClaims = await cleanStaleRecoveryClaims(directory);
    const previous = await readOwnerLock(lockPath);
    if (previous === null) {
      if (remainingClaims !== 0) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      const snapshot = await readOwnerStateSnapshot(statePath, workerResourceUid);
      await requireSafeStateForNewOwner(snapshot, false);
      const created = await createOwnerLock(lockPath, directory);
      if (created) return created;
      continue;
    }

    const priorLiveness = await processLiveness(previous.record.pid, previous.record.process);
    if (priorLiveness !== "stale") throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const stateSnapshot = await readOwnerStateSnapshot(statePath, workerResourceUid);
    await requireSafeStateForNewOwner(stateSnapshot, true, true);
    const fingerprint = await currentOwnerFingerprint();
    if (!fingerprint) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const claimPath = join(directory, recoveryClaimName(fingerprint, randomUUID()));
    let pinnedIdentity: OwnerFileIdentity | null = null;
    try {
      await link(lockPath, claimPath);
      const claimStat = await lstat(claimPath, { bigint: true }).catch(() => null);
      const pinned = await readOwnerLock(lockPath);
      if (
        !claimStat ||
        !pinned ||
        !sameOwnerFile(previous.identity, ownerFileIdentity(claimStat)) ||
        !sameOwnerFile(previous.identity, pinned.identity) ||
        !sameOwnerFile(previous.identity, ownerFileIdentity(claimStat))
      ) {
        continue;
      }
      pinnedIdentity = ownerFileIdentity(claimStat);
      if (pinnedIdentity.links !== 2n) continue;
      if (
        pinned.record.ownerId !== previous.record.ownerId ||
        (await processLiveness(previous.record.pid, previous.record.process)) !== "stale" ||
        !(await sameOwnerStateSnapshot(statePath, workerResourceUid, stateSnapshot))
      ) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      await requireSafeStateForNewOwner(stateSnapshot, true, true);
      const finalLock = await readOwnerLock(lockPath);
      const finalClaim = await lstat(claimPath, { bigint: true }).catch(() => null);
      if (
        !finalLock ||
        !finalClaim ||
        !sameOwnerFile(previous.identity, finalLock.identity) ||
        !sameOwnerFile(previous.identity, ownerFileIdentity(finalClaim)) ||
        finalLock.identity.links !== 2n ||
        (await processLiveness(previous.record.pid, previous.record.process)) !== "stale" ||
        !(await sameOwnerStateSnapshot(statePath, workerResourceUid, stateSnapshot))
      ) {
        continue;
      }
      await unlink(lockPath);
      await syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof WorkerdWorkerRuntimeOwnerError) throw error;
      }
      continue;
    } finally {
      if (pinnedIdentity) {
        const currentClaim = await lstat(claimPath, { bigint: true }).catch(() => null);
        if (currentClaim && sameOwnerFile(pinnedIdentity, ownerFileIdentity(currentClaim)))
          await unlink(claimPath).catch(() => undefined);
      } else {
        await unlink(claimPath).catch(() => undefined);
      }
    }

    const successor = await createOwnerLock(lockPath, directory);
    if (!successor) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    return { ...successor, recoveredFromStaleOwner: true };
  }
  throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
}

async function releaseOwnerLock(
  lockPath: string,
  directory: string,
  opened: OpenedOwnerLock,
): Promise<void> {
  try {
    const current = await readOwnerLock(lockPath);
    if (
      !current ||
      current.record.ownerId !== opened.record.ownerId ||
      current.record.pid !== opened.record.pid ||
      current.record.device !== opened.record.device ||
      current.record.inode !== opened.record.inode
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    await unlink(lockPath);
    await syncDirectory(directory);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

// A failed successor must leave its lock file in place until PID death, but
// must not abandon the open FileHandle to GC (Bun treats that as a fatal error).
// Keep the handle strongly referenced only if close itself is uncertain.
const failedRecoveryLockHandles = new Set<OpenedOwnerLock["handle"]>();

async function retainOwnerLockAfterFailure(opened: OpenedOwnerLock): Promise<void> {
  try {
    await opened.handle.close();
  } catch {
    failedRecoveryLockHandles.add(opened.handle);
  }
}

export function createSerializedWorkerdOwnerStateWriter<State>(
  initial: State,
  commit: (next: State) => Promise<State>,
): {
  current(): State;
  transition(change: (current: State) => State): Promise<State>;
} {
  let current = initial;
  let tail: Promise<void> = Promise.resolve();
  let poisoned = false;
  let poisonReason: unknown;
  return {
    current: () => current,
    transition(change) {
      const task = tail.then(async () => {
        if (poisoned) throw poisonReason;
        try {
          current = await commit(change(current));
          return current;
        } catch (error) {
          // A failed durable commit may have renamed the snapshot before its
          // directory sync failed. Without exact disk readback, no later write
          // may rebase on stale memory and overwrite that possibly durable state.
          poisoned = true;
          poisonReason = error;
          throw error;
        }
      });
      tail = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
}

function uidKey(uid: string): string {
  return createHash("sha256").update(uid, "utf8").digest("hex");
}

function validateOperationId(value: string): void {
  if (!OPERATION_ID.test(value)) throw new WorkerdWorkerRuntimeOwnerError("invalid_identity");
}

function cloneRecord(record: IncarnationRecord): IncarnationRecord {
  return {
    ...record,
    identity:
      record.identity === null
        ? null
        : {
            generation: record.identity.generation,
            workerResourceUid: record.identity.workerResourceUid,
            hostnames: [...record.identity.hostnames],
            versions: record.identity.versions.map((version) => ({ ...version })),
          },
    receipt: record.receipt === null ? null : Object.freeze({ ...record.receipt }),
  };
}

function emptyState(workerResourceUid: string): PersistedOwnerState {
  return {
    schema: STATE_SCHEMA,
    workerResourceUid,
    activeOperationId: null,
    admissionClosedBy: null,
    deletionPublicationConfirmed: false,
    endpointRouteAbsence: null,
    incarnations: [],
  };
}

function validLinuxProcessIdentityRecord(value: unknown): value is LinuxProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const processIdentity = value as Record<string, unknown>;
  return (
    Object.keys(processIdentity).sort().join(",") === "bootId,pid,pidNamespace,startTimeTicks" &&
    Number.isSafeInteger(processIdentity.pid) &&
    (processIdentity.pid as number) > 1 &&
    typeof processIdentity.bootId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      processIdentity.bootId,
    ) &&
    typeof processIdentity.pidNamespace === "string" &&
    /^\d{1,32}:\d{1,32}$/u.test(processIdentity.pidNamespace) &&
    typeof processIdentity.startTimeTicks === "string" &&
    /^\d{1,32}$/u.test(processIdentity.startTimeTicks)
  );
}

function validEndpointRouteAbsence(value: unknown): value is V2EndpointRouteAbsentReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).sort().join(",") ===
      "assignedHostname,endpointResourceUid,kind,sourceOperationId,targetKey,workerResourceUid" &&
    receipt.kind === "confirmed_route_absent" &&
    typeof receipt.sourceOperationId === "string" &&
    OPERATION_ID.test(receipt.sourceOperationId) &&
    typeof receipt.endpointResourceUid === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(receipt.endpointResourceUid) &&
    typeof receipt.workerResourceUid === "string" &&
    typeof receipt.targetKey === "string" &&
    receipt.targetKey.length > 0 &&
    typeof receipt.assignedHostname === "string" &&
    ENDPOINT_HOSTNAME.test(receipt.assignedHostname)
  );
}

function validReceipt(value: unknown): value is WorkerdWorkerRetirementReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.workerResourceUid === "string" &&
    typeof receipt.operationId === "string" &&
    OPERATION_ID.test(receipt.operationId) &&
    Number.isSafeInteger(receipt.listenerPort) &&
    typeof receipt.configurationSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(receipt.configurationSha256)
  );
}

function validIdentity(value: unknown): value is WorkerdPublicationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.generation === "string" &&
    typeof candidate.workerResourceUid === "string" &&
    Array.isArray(candidate.hostnames) &&
    candidate.hostnames.every((item) => typeof item === "string") &&
    Array.isArray(candidate.versions) &&
    candidate.versions.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const version = item as Record<string, unknown>;
      return (
        typeof version.versionId === "string" &&
        typeof version.workerVersionUid === "string" &&
        Number.isSafeInteger(version.weight)
      );
    })
  );
}

function executionCopiesMatchRecord(
  record: IncarnationRecord,
  copies: Awaited<ReturnType<typeof inspectWorkerdWorkerExecutionCopies>>,
  requirePublication: boolean,
): boolean {
  if (requirePublication && copies.publications.length === 0) return false;
  const expectedGeneration =
    record.identity?.generation ?? expectedOperationMarker(record.operationId);
  const expectedVersions = record.identity?.versions.map(({ workerVersionUid, weight }) => ({
    workerVersionUid,
    weight,
  }));
  return copies.publications.every(
    (publication) =>
      publication.generation === expectedGeneration &&
      (expectedVersions === undefined ||
        canonicalJson(publication.versions) === canonicalJson(expectedVersions)),
  );
}

function parseState(text: string | null, workerResourceUid: string): PersistedOwnerState {
  if (text === null) return emptyState(workerResourceUid);
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const state = value as Record<string, unknown>;
    const legacyStaticState = state.schema === LEGACY_STATE_SCHEMA;
    const previousState = state.schema === PREVIOUS_STATE_SCHEMA;
    const retiredCopiesState = state.schema === RETIRED_COPIES_STATE_SCHEMA;
    const cleanupState = state.schema === CLEANUP_STATE_SCHEMA;
    const routeReceiptState = state.schema === ROUTE_RECEIPT_STATE_SCHEMA;
    const processPinState = state.schema === PROCESS_PIN_STATE_SCHEMA;
    const eventlessState = state.schema === EVENTLESS_STATE_SCHEMA;
    const currentState = state.schema === STATE_SCHEMA;
    if (
      (!legacyStaticState &&
        !previousState &&
        !retiredCopiesState &&
        !cleanupState &&
        !routeReceiptState &&
        !processPinState &&
        !eventlessState &&
        !currentState) ||
      state.workerResourceUid !== workerResourceUid ||
      !(state.activeOperationId === null || typeof state.activeOperationId === "string") ||
      !(state.admissionClosedBy === null || typeof state.admissionClosedBy === "string") ||
      typeof state.deletionPublicationConfirmed !== "boolean" ||
      (routeReceiptState || processPinState || eventlessState || currentState
        ? !(
            state.endpointRouteAbsence === null ||
            validEndpointRouteAbsence(state.endpointRouteAbsence)
          )
        : state.endpointRouteAbsence !== undefined) ||
      !Array.isArray(state.incarnations)
    ) {
      throw new Error();
    }
    const incarnations: IncarnationRecord[] = [];
    const ids = new Set<string>();
    for (const raw of state.incarnations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
      const item = raw as Record<string, unknown>;
      if (
        typeof item.operationId !== "string" ||
        !OPERATION_ID.test(item.operationId) ||
        ids.has(item.operationId) ||
        !Number.isSafeInteger(item.listenerPort) ||
        typeof item.status !== "string" ||
        !["candidate", "active", "draining", "retiring", "retired", "uncertain"].includes(
          item.status,
        ) ||
        !(item.retirementOperationId === null || typeof item.retirementOperationId === "string") ||
        !(item.retireAtMs === null || Number.isSafeInteger(item.retireAtMs)) ||
        (legacyStaticState
          ? item.deferRetirementUntilDeadline !== undefined
          : typeof item.deferRetirementUntilDeadline !== "boolean") ||
        (retiredCopiesState ||
        cleanupState ||
        routeReceiptState ||
        processPinState ||
        eventlessState ||
        currentState
          ? typeof item.executionCopiesReleased !== "boolean"
          : item.executionCopiesReleased !== undefined) ||
        (cleanupState || routeReceiptState || processPinState || eventlessState || currentState
          ? typeof item.executionCopiesCleanupStarted !== "boolean"
          : item.executionCopiesCleanupStarted !== undefined) ||
        (cleanupState || routeReceiptState || processPinState || eventlessState || currentState
          ? !(
              item.executionCopiesCleanupManifestSha256 === null ||
              (typeof item.executionCopiesCleanupManifestSha256 === "string" &&
                /^sha256:[0-9a-f]{64}$/u.test(item.executionCopiesCleanupManifestSha256))
            )
          : item.executionCopiesCleanupManifestSha256 !== undefined) ||
        (processPinState || eventlessState || currentState
          ? !(
              item.processIdentity === null || validLinuxProcessIdentityRecord(item.processIdentity)
            ) ||
            !(
              item.configurationSha256 === null ||
              (typeof item.configurationSha256 === "string" &&
                /^[0-9a-f]{64}$/u.test(item.configurationSha256))
            )
          : item.processIdentity !== undefined || item.configurationSha256 !== undefined) ||
        (eventlessState || currentState
          ? typeof item.configurationRefreshPending !== "boolean"
          : item.configurationRefreshPending !== undefined) ||
        (currentState
          ? !(
              item.eventToken === null ||
              (typeof item.eventToken === "string" && /^[0-9a-f]{64}$/u.test(item.eventToken))
            )
          : item.eventToken !== undefined) ||
        ((eventlessState || currentState) &&
          item.configurationRefreshPending === true &&
          (item.status !== "active" ||
            item.processIdentity === null ||
            item.configurationSha256 === null)) ||
        !(item.identity === null || validIdentity(item.identity)) ||
        !(item.receipt === null || validReceipt(item.receipt))
      ) {
        throw new Error();
      }
      if (
        item.receipt !== null &&
        ((item.receipt as WorkerdWorkerRetirementReceipt).workerResourceUid !== workerResourceUid ||
          (item.receipt as WorkerdWorkerRetirementReceipt).operationId !==
            item.retirementOperationId ||
          (item.receipt as WorkerdWorkerRetirementReceipt).listenerPort !== item.listenerPort)
      ) {
        throw new Error();
      }
      ids.add(item.operationId);
      incarnations.push({
        ...item,
        deferRetirementUntilDeadline: legacyStaticState
          ? false
          : (item.deferRetirementUntilDeadline as boolean),
        executionCopiesReleased:
          retiredCopiesState ||
          cleanupState ||
          routeReceiptState ||
          processPinState ||
          eventlessState ||
          currentState
            ? (item.executionCopiesReleased as boolean)
            : false,
        executionCopiesCleanupStarted:
          cleanupState || routeReceiptState || processPinState || eventlessState || currentState
            ? (item.executionCopiesCleanupStarted as boolean)
            : retiredCopiesState
              ? (item.executionCopiesReleased as boolean)
              : false,
        executionCopiesCleanupManifestSha256:
          cleanupState || routeReceiptState || processPinState || eventlessState || currentState
            ? (item.executionCopiesCleanupManifestSha256 as string | null)
            : null,
        processIdentity:
          processPinState || eventlessState || currentState
            ? (item.processIdentity as LinuxProcessIdentity | null)
            : null,
        configurationSha256:
          processPinState || eventlessState || currentState
            ? (item.configurationSha256 as string | null)
            : null,
        configurationRefreshPending:
          eventlessState || currentState ? (item.configurationRefreshPending as boolean) : false,
        eventToken: currentState ? (item.eventToken as string | null) : null,
      } as unknown as IncarnationRecord);
    }
    const result: PersistedOwnerState = {
      schema: STATE_SCHEMA,
      workerResourceUid,
      activeOperationId: state.activeOperationId as string | null,
      admissionClosedBy: state.admissionClosedBy as string | null,
      deletionPublicationConfirmed: state.deletionPublicationConfirmed,
      endpointRouteAbsence:
        routeReceiptState || processPinState || eventlessState || currentState
          ? (state.endpointRouteAbsence as V2EndpointRouteAbsentReceipt | null)
          : null,
      incarnations,
    };
    const activeRecords = incarnations.filter((item) => item.status === "active");
    if (
      (state.admissionClosedBy === null && state.deletionPublicationConfirmed) ||
      (state.deletionPublicationConfirmed &&
        (state.activeOperationId !== null ||
          incarnations.some(
            (item) =>
              item.status !== "retired" ||
              item.receipt === null ||
              ((retiredCopiesState ||
                cleanupState ||
                routeReceiptState ||
                processPinState ||
                eventlessState ||
                currentState) &&
                !item.executionCopiesReleased),
          ))) ||
      (result.endpointRouteAbsence !== null &&
        (result.activeOperationId !== null ||
          result.incarnations.some(
            (item) =>
              item.status !== "retired" || item.receipt === null || !item.executionCopiesReleased,
          ) ||
          result.endpointRouteAbsence.workerResourceUid !== workerResourceUid)) ||
      (state.activeOperationId === null && activeRecords.length !== 0) ||
      (state.activeOperationId !== null &&
        !incarnations.some(
          (item) =>
            item.operationId === state.activeOperationId &&
            item.identity !== null &&
            ["active", "retiring", "retired", "uncertain"].includes(item.status),
        )) ||
      incarnations.some(
        (item) =>
          (item.status === "retired" && item.receipt === null) ||
          (item.executionCopiesReleased && (item.status !== "retired" || item.receipt === null)) ||
          (item.executionCopiesCleanupStarted && item.receipt === null) ||
          (item.executionCopiesReleased && !item.executionCopiesCleanupStarted) ||
          (item.executionCopiesCleanupStarted &&
            !item.executionCopiesReleased &&
            item.executionCopiesCleanupManifestSha256 === null) ||
          (!item.executionCopiesCleanupStarted &&
            item.executionCopiesCleanupManifestSha256 !== null) ||
          (["draining", "retiring", "retired"].includes(item.status) &&
            item.retirementOperationId === null),
      )
    ) {
      throw new Error();
    }
    const canonicalState = legacyStaticState
      ? {
          schema: LEGACY_STATE_SCHEMA,
          workerResourceUid: state.workerResourceUid,
          activeOperationId: state.activeOperationId,
          admissionClosedBy: state.admissionClosedBy,
          deletionPublicationConfirmed: state.deletionPublicationConfirmed,
          incarnations: incarnations.map(
            ({
              deferRetirementUntilDeadline: _defer,
              executionCopiesReleased: _released,
              executionCopiesCleanupStarted: _cleanupStarted,
              executionCopiesCleanupManifestSha256: _cleanupManifestSha256,
              processIdentity: _processIdentity,
              configurationSha256: _configurationSha256,
              configurationRefreshPending: _refreshPending,
              eventToken: _eventToken,
              ...item
            }) => item,
          ),
        }
      : previousState
        ? {
            schema: PREVIOUS_STATE_SCHEMA,
            workerResourceUid: state.workerResourceUid,
            activeOperationId: state.activeOperationId,
            admissionClosedBy: state.admissionClosedBy,
            deletionPublicationConfirmed: state.deletionPublicationConfirmed,
            incarnations: incarnations.map(
              ({
                executionCopiesReleased: _released,
                executionCopiesCleanupStarted: _cleanupStarted,
                executionCopiesCleanupManifestSha256: _cleanupManifestSha256,
                processIdentity: _processIdentity,
                configurationSha256: _configurationSha256,
                configurationRefreshPending: _refreshPending,
                eventToken: _eventToken,
                ...item
              }) => item,
            ),
          }
        : retiredCopiesState
          ? {
              schema: RETIRED_COPIES_STATE_SCHEMA,
              workerResourceUid: state.workerResourceUid,
              activeOperationId: state.activeOperationId,
              admissionClosedBy: state.admissionClosedBy,
              deletionPublicationConfirmed: state.deletionPublicationConfirmed,
              incarnations: incarnations.map(
                ({
                  executionCopiesCleanupStarted: _cleanupStarted,
                  executionCopiesCleanupManifestSha256: _cleanupManifestSha256,
                  processIdentity: _processIdentity,
                  configurationSha256: _configurationSha256,
                  configurationRefreshPending: _refreshPending,
                  eventToken: _eventToken,
                  ...item
                }) => item,
              ),
            }
          : routeReceiptState
            ? {
                schema: ROUTE_RECEIPT_STATE_SCHEMA,
                workerResourceUid: state.workerResourceUid,
                activeOperationId: state.activeOperationId,
                admissionClosedBy: state.admissionClosedBy,
                deletionPublicationConfirmed: state.deletionPublicationConfirmed,
                endpointRouteAbsence: result.endpointRouteAbsence,
                incarnations: incarnations.map(
                  ({
                    processIdentity: _processIdentity,
                    configurationSha256: _configurationSha256,
                    configurationRefreshPending: _refreshPending,
                    eventToken: _eventToken,
                    ...item
                  }) => item,
                ),
              }
            : processPinState
              ? {
                  schema: PROCESS_PIN_STATE_SCHEMA,
                  workerResourceUid: state.workerResourceUid,
                  activeOperationId: state.activeOperationId,
                  admissionClosedBy: state.admissionClosedBy,
                  deletionPublicationConfirmed: state.deletionPublicationConfirmed,
                  endpointRouteAbsence: result.endpointRouteAbsence,
                  incarnations: incarnations.map(
                    ({
                      configurationRefreshPending: _refreshPending,
                      eventToken: _eventToken,
                      ...item
                    }) => item,
                  ),
                }
              : cleanupState
                ? {
                    schema: CLEANUP_STATE_SCHEMA,
                    workerResourceUid: state.workerResourceUid,
                    activeOperationId: state.activeOperationId,
                    admissionClosedBy: state.admissionClosedBy,
                    deletionPublicationConfirmed: state.deletionPublicationConfirmed,
                    incarnations: incarnations.map(
                      ({
                        processIdentity: _processIdentity,
                        configurationSha256: _configurationSha256,
                        configurationRefreshPending: _refreshPending,
                        eventToken: _eventToken,
                        ...item
                      }) => item,
                    ),
                  }
                : eventlessState
                  ? {
                      schema: EVENTLESS_STATE_SCHEMA,
                      workerResourceUid: state.workerResourceUid,
                      activeOperationId: state.activeOperationId,
                      admissionClosedBy: state.admissionClosedBy,
                      deletionPublicationConfirmed: state.deletionPublicationConfirmed,
                      endpointRouteAbsence: result.endpointRouteAbsence,
                      incarnations: incarnations.map(
                        ({ eventToken: _eventToken, ...item }) => item,
                      ),
                    }
                  : result;
    if (canonicalJson(canonicalState) !== text) throw new Error();
    return result;
  } catch {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(join(path, ".."));
  } catch {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
}

function workerFromExecution(execution: V2Execution): string | null {
  const worker = execution.spec.worker;
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) return null;
  const uid = (worker as Record<string, unknown>).resourceUid;
  return typeof uid === "string" ? uid : null;
}

function expectedOperationMarker(operationId: string): string {
  return `${OPERATION_MARKER}${operationId}`;
}

function sourceOperationIdFromIdentity(identity: WorkerdPublicationIdentity): string | null {
  if (!identity.generation.startsWith(OPERATION_MARKER)) return null;
  const operationId = identity.generation.slice(OPERATION_MARKER.length);
  return OPERATION_ID.test(operationId) &&
    expectedOperationMarker(operationId) === identity.generation
    ? operationId
    : null;
}

function makeRequest(request: Request, signal: AbortSignal): Request {
  return new Request(request, { signal });
}

function responseWithTrackedBody(response: Response, invocation: ActiveInvocation): Response {
  if (!response.body) {
    invocation.finish();
    return response;
  }
  const reader = response.body.getReader();
  invocation.reader = reader;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      invocation.bodyController = controller;
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          invocation.finish();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        invocation.finish();
      }
    },
    async cancel(reason) {
      invocation.abort.abort(reason);
      try {
        await reader.cancel(reason);
      } catch {
        // The request signal and eventual exact child shutdown are the fences.
      }
      invocation.finish();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function openWorkerdWorkerRuntimeOwner(
  inputOptions: OpenWorkerdWorkerRuntimeOwnerOptions,
): Promise<WorkerdWorkerRuntimeOwner> {
  const options = Object.freeze({ ...inputOptions });
  validateOperationId("00000000-0000-4000-8000-000000000000");
  if (
    !options.workerResourceUid ||
    options.workerResourceUid.length > 256 ||
    !options.targetKey ||
    typeof options.listenerPortForOperation !== "function"
  ) {
    throw new WorkerdWorkerRuntimeOwnerError("invalid_identity");
  }

  let canonicalRoot: string;
  try {
    await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
    canonicalRoot = await realpath(options.rootDirectory);
    const info = await lstat(canonicalRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error();
  } catch {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
  const directory = join(canonicalRoot, uidKey(options.workerResourceUid));
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const ownerInfo = await lstat(directory).catch(() => null);
  if (!ownerInfo?.isDirectory() || ownerInfo.isSymbolicLink() || (ownerInfo.mode & 0o077) !== 0)
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");

  const lockPath = join(directory, LOCK_NAME);
  const statePath = join(directory, STATE_NAME);
  let ownerLock: OpenedOwnerLock;
  try {
    ownerLock = await acquireOwnerLock(directory, statePath, options.workerResourceUid);
  } catch (error) {
    if (error instanceof WorkerdWorkerRuntimeOwnerError) throw error;
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }

  let state: PersistedOwnerState;
  try {
    const text = await readFile(statePath, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    state = parseState(text, options.workerResourceUid);
    await verifyOwnerNamespace(directory, state, options.workerResourceUid);
    const hasServingIncarnations = state.incarnations.some(
      (item) => item.status === "active" || item.status === "draining",
    );
    if (
      (state.endpointRouteAbsence !== null &&
        state.endpointRouteAbsence.targetKey !== options.targetKey) ||
      (hasServingIncarnations &&
        (!ownerLock.recoveredFromStaleOwner || !recoverableIncarnationSet(state))) ||
      state.incarnations.some(
        (item) =>
          item.status !== "retired" &&
          !(
            ((item.status === "retiring" || item.status === "uncertain") &&
              item.retirementOperationId !== null) ||
            (ownerLock.recoveredFromStaleOwner &&
              (item.status === "active" || item.status === "draining"))
          ),
      )
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    if (hasServingIncarnations) await requireStaleIncarnationChildrenAndVacantListeners(state);
  } catch (error) {
    if (ownerLock.recoveredFromStaleOwner) await retainOwnerLockAfterFailure(ownerLock);
    else await releaseOwnerLock(lockPath, directory, ownerLock).catch(() => undefined);
    if (error instanceof WorkerdWorkerRuntimeOwnerError) throw error;
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }

  const handles = new Map<string, IncarnationHandle>();
  let active: IncarnationHandle | null = null;
  let admissionClosedBy = state.admissionClosedBy;
  let serial: Promise<void> = Promise.resolve();
  let closed = false;

  const stateWriter = createSerializedWorkerdOwnerStateWriter(state, async (next) => {
    const sorted = [...next.incarnations].sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    );
    const snapshot: PersistedOwnerState = {
      ...next,
      incarnations: sorted.map(cloneRecord),
    };
    await atomicWrite(statePath, new TextEncoder().encode(canonicalJson(snapshot)));
    state = snapshot;
    return snapshot;
  });
  const transitionState = stateWriter.transition;

  // Retired receipts outlive their publisher process. Retry physical-copy
  // cleanup under this owner's lock before exposing any replay/observation API.
  try {
    for (const record of [...state.incarnations]) {
      if (record.status === "active" || record.status === "draining") continue;
      if (!record.retirementOperationId) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      const groupDirectory = join(
        directory,
        "incarnations",
        record.operationId,
        "groups",
        uidKey(options.workerResourceUid),
      );
      let prepared = record;
      if (!record.executionCopiesCleanupStarted) {
        const verified = await verifyRetiredWorkerdWorkerExecutionCopies({
          groupDirectory,
          workerResourceUid: options.workerResourceUid,
          operationId: record.retirementOperationId,
          listenerPort: record.listenerPort,
          scriptName: `v2-worker-${uidKey(options.workerResourceUid)}`,
        });
        if (
          (record.receipt && canonicalJson(record.receipt) !== canonicalJson(verified.receipt)) ||
          !executionCopiesMatchRecord(record, verified.copies, false) ||
          (record.executionCopiesReleased &&
            (verified.copies.versionUids.length !== 0 ||
              verified.copies.generationKeys.length !== 0))
        ) {
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        }
        const snapshot = await transitionState((current) => ({
          ...current,
          incarnations: current.incarnations.map((item) =>
            item.operationId === record.operationId
              ? {
                  ...item,
                  receipt: verified.receipt,
                  executionCopiesCleanupStarted: true,
                  executionCopiesCleanupManifestSha256: verified.cleanupManifestSha256,
                }
              : item,
          ),
        }));
        const updated = snapshot.incarnations.find(
          (item) => item.operationId === record.operationId,
        );
        if (!updated) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        prepared = updated;
      } else if (record.receipt === null) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      if (record.executionCopiesReleased) {
        const verified = await verifyRetiredWorkerdWorkerExecutionCopies({
          groupDirectory,
          workerResourceUid: options.workerResourceUid,
          operationId: record.retirementOperationId,
          listenerPort: record.listenerPort,
          scriptName: `v2-worker-${uidKey(options.workerResourceUid)}`,
        });
        if (
          verified.copies.versionUids.length !== 0 ||
          verified.copies.generationKeys.length !== 0 ||
          !prepared.receipt ||
          canonicalJson(prepared.receipt) !== canonicalJson(verified.receipt)
        ) {
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        }
        const confirmed = await releaseRetiredWorkerdWorkerExecutionCopies({
          groupDirectory,
          workerResourceUid: options.workerResourceUid,
          operationId: record.retirementOperationId,
          listenerPort: record.listenerPort,
          scriptName: `v2-worker-${uidKey(options.workerResourceUid)}`,
          cleanupIntentPersisted: true,
          cleanupManifestSha256: prepared.executionCopiesCleanupManifestSha256,
          alreadyReleased: true,
        });
        if (canonicalJson(confirmed.receipt) !== canonicalJson(prepared.receipt))
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        continue;
      }
      const released = await releaseRetiredWorkerdWorkerExecutionCopies({
        groupDirectory,
        workerResourceUid: options.workerResourceUid,
        operationId: prepared.retirementOperationId as string,
        listenerPort: record.listenerPort,
        scriptName: `v2-worker-${uidKey(options.workerResourceUid)}`,
        cleanupIntentPersisted: true,
        cleanupManifestSha256: prepared.executionCopiesCleanupManifestSha256,
      });
      if (prepared.receipt && canonicalJson(prepared.receipt) !== canonicalJson(released.receipt)) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      if (
        prepared.status !== "retired" ||
        !prepared.executionCopiesReleased ||
        prepared.receipt === null
      ) {
        await transitionState((current) => ({
          ...current,
          incarnations: current.incarnations.map((item) =>
            item.operationId === record.operationId
              ? {
                  ...item,
                  status: "retired",
                  receipt: released.receipt,
                  executionCopiesReleased: true,
                  executionCopiesCleanupStarted: true,
                }
              : item,
          ),
        }));
      }
    }
  } catch (error) {
    if (ownerLock.recoveredFromStaleOwner) await retainOwnerLockAfterFailure(ownerLock);
    else await releaseOwnerLock(lockPath, directory, ownerLock).catch(() => undefined);
    if (error instanceof WorkerdWorkerRuntimeOwnerError) throw error;
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }

  const recordFor = (operationId: string): IncarnationRecord | undefined =>
    state.incarnations.find((item) => item.operationId === operationId);

  const updateRecord = async (
    operationId: string,
    update: (current: IncarnationRecord) => IncarnationRecord,
  ): Promise<IncarnationRecord> => {
    const snapshot = await transitionState((currentState) => {
      const current = currentState.incarnations.find((item) => item.operationId === operationId);
      if (!current) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      const replacement = update(current);
      return {
        ...currentState,
        incarnations: currentState.incarnations.map((item) =>
          item.operationId === operationId ? replacement : item,
        ),
      };
    });
    const copied = snapshot.incarnations.find((item) => item.operationId === operationId);
    if (!copied) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    return copied;
  };

  const finishInvocation = (incarnation: IncarnationHandle, invocation: ActiveInvocation): void => {
    if (invocation.finished) return;
    invocation.finished = true;
    incarnation.invocations.delete(invocation);
    if (
      incarnation.invocations.size === 0 &&
      incarnation.record.status === "draining" &&
      !incarnation.record.deferRetirementUntilDeadline
    ) {
      void retireIncarnation(incarnation).catch(() => undefined);
    }
  };

  async function retireIncarnation(
    incarnation: IncarnationHandle,
  ): Promise<WorkerdWorkerRetirementReceipt> {
    if (incarnation.retiring) return await incarnation.retiring;
    if (
      incarnation.record.status === "retired" &&
      incarnation.record.receipt &&
      incarnation.record.executionCopiesReleased
    )
      return incarnation.record.receipt;
    const operationId = incarnation.record.retirementOperationId;
    if (!operationId) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const task = (async () => {
      try {
        const retiringRecord = await updateRecord(incarnation.record.operationId, (current) => ({
          ...current,
          status: "retiring",
          retirementOperationId: operationId,
        }));
        incarnation.record = retiringRecord;
        const receipt = await incarnation.group.retire({
          workerResourceUid: options.workerResourceUid,
          operationId,
        });
        const verified = await verifyRetiredWorkerdWorkerExecutionCopies({
          groupDirectory: incarnation.group.runtimeRoot,
          workerResourceUid: options.workerResourceUid,
          operationId,
          listenerPort: incarnation.record.listenerPort,
          scriptName: scriptName(options.workerResourceUid),
        });
        if (
          canonicalJson(receipt) !== canonicalJson(verified.receipt) ||
          !executionCopiesMatchRecord(incarnation.record, verified.copies, false)
        ) {
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        }
        const receiptPersisted = await updateRecord(incarnation.record.operationId, (current) => ({
          ...current,
          status: "retiring",
          receipt,
          executionCopiesCleanupStarted: true,
          executionCopiesCleanupManifestSha256: verified.cleanupManifestSha256,
        }));
        incarnation.record = receiptPersisted;
        const released = await releaseRetiredWorkerdWorkerExecutionCopies({
          groupDirectory: incarnation.group.runtimeRoot,
          workerResourceUid: options.workerResourceUid,
          operationId,
          listenerPort: incarnation.record.listenerPort,
          scriptName: scriptName(options.workerResourceUid),
          cleanupIntentPersisted: true,
          cleanupManifestSha256: incarnation.record.executionCopiesCleanupManifestSha256,
        });
        if (canonicalJson(receipt) !== canonicalJson(released.receipt)) {
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        }
        const retired = await updateRecord(incarnation.record.operationId, (current) => ({
          ...current,
          status: "retired",
          receipt,
          executionCopiesReleased: true,
          executionCopiesCleanupStarted: true,
        }));
        incarnation.record = retired;
        incarnation.retirementTimer?.();
        delete incarnation.retirementTimer;
        return receipt;
      } catch {
        const uncertain = await updateRecord(incarnation.record.operationId, (current) => ({
          ...current,
          status: "uncertain",
        })).catch(() => incarnation.record);
        incarnation.record = uncertain;
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
    })();
    incarnation.retiring = task;
    void task.catch(() => {
      if (incarnation.retiring === task) delete incarnation.retiring;
    });
    return await task;
  }

  const cancelInvocations = async (incarnation: IncarnationHandle): Promise<void> => {
    for (const invocation of [...incarnation.invocations]) {
      invocation.abort.abort(new WorkerdWorkerRuntimeOwnerError("admission_closed"));
      try {
        invocation.bodyController?.error(new WorkerdWorkerRuntimeOwnerError("admission_closed"));
      } catch {
        // A stream may already be closed.
      }
      if (invocation.reader) {
        void invocation.reader.cancel().catch(() => undefined);
      }
      invocation.finish();
    }
  };

  const scheduleIncarnationRetirement = (incarnation: IncarnationHandle): void => {
    if (incarnation.record.status !== "draining") return;
    if (incarnation.invocations.size === 0 && !incarnation.record.deferRetirementUntilDeadline) {
      void retireIncarnation(incarnation).catch(() => undefined);
      return;
    }
    const at = incarnation.record.retireAtMs;
    if (at === null) return;
    const delay = Math.max(0, at - Date.now());
    const run = () => {
      delete incarnation.retirementTimer;
      void cancelInvocations(incarnation)
        .then(() => retireIncarnation(incarnation))
        .catch(() => undefined);
    };
    if (options.scheduleRetirement) {
      incarnation.retirementTimer = options.scheduleRetirement(run, delay);
      return;
    }
    const timer = setTimeout(run, delay);
    timer.unref?.();
    incarnation.retirementTimer = () => clearTimeout(timer);
  };

  const incarnationDirectory = (operationId: string): string =>
    join(directory, "incarnations", operationId);

  const makeIncarnationHandle = (
    record: IncarnationRecord,
    group: WorkerdWorkerExecutionGroup,
    incumbent: WorkerdPublicationIdentity | null,
  ): IncarnationHandle => {
    const runtime = createWorkerdRuntime({
      root: group.runtimeRoot,
      configPath: group.configurationPath,
      port: record.listenerPort,
      binary: options.workerdBinary,
      onReload: async (configPath) => {
        if (configPath !== group.configurationPath)
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        await group.reloadConfiguration();
      },
      isReady: () => group.isReady(),
    });
    const candidateRuntime: WorkerdRuntime<WorkerdSite | WorkerdStaticSite> = {
      ...runtime,
      inspectModule: options.inspectModule ?? runtime.inspectModule,
      publishFenced: async (name, resolvePublication, isFenceCurrent) => {
        await runtime.publishFenced?.(
          name,
          async (current) => resolvePublication(current ?? incumbent),
          isFenceCurrent,
        );
      },
    };
    const publication = createV2WorkerPublication({
      targetKey: options.targetKey,
      publicationState: options.publicationState,
      runtime: candidateRuntime,
      ...(options.configuredInputs ? { configuredInputs: options.configuredInputs } : {}),
      ...(record.eventToken === null ? {} : { scheduledEventToken: record.eventToken }),
    });
    const handle: IncarnationHandle = {
      record,
      group,
      runtime,
      publication,
      invocations: new Set(),
    };
    handles.set(record.operationId, handle);
    return handle;
  };

  const persistSpawnedChild = async (operationId: string, child: WorkerdProcess): Promise<void> => {
    if (!Number.isSafeInteger(child.pid) || !child.pid || child.pid <= 1) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const processIdentity = await readLinuxProcessIdentity(child.pid);
    if (processIdentity.pid !== child.pid) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const spawningRecord = recordFor(operationId);
    let refreshedDigest: string | null = null;
    if (spawningRecord?.configurationRefreshPending) {
      const groupDirectory = join(
        incarnationDirectory(operationId),
        "groups",
        uidKey(options.workerResourceUid),
      );
      const config = await readFile(join(groupDirectory, "workers", "workerd.capnp"));
      const manifest = JSON.parse(
        await readFile(join(groupDirectory, "group.json"), "utf8"),
      ) as Record<string, unknown>;
      const digest = createHash("sha256").update(config).digest("hex");
      if (
        manifest.schema !== "takoserver.workerd-worker-group@1" ||
        manifest.workerResourceUid !== options.workerResourceUid ||
        manifest.listenerPort !== spawningRecord.listenerPort ||
        manifest.configurationSha256 !== digest
      ) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      refreshedDigest = digest;
    }
    await updateRecord(operationId, (current) => {
      if (
        current.status !== "candidate" &&
        current.status !== "active" &&
        current.status !== "draining"
      ) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      return {
        ...current,
        processIdentity,
        ...(refreshedDigest === null
          ? {}
          : { configurationSha256: refreshedDigest, configurationRefreshPending: false }),
      };
    });
  };

  const createIncarnation = async (
    execution: V2Execution,
    incumbent: WorkerdPublicationIdentity | null,
  ): Promise<IncarnationHandle> => {
    const operationId = execution.operationId;
    const listenerPort = await options.listenerPortForOperation(operationId);
    if (!Number.isSafeInteger(listenerPort) || listenerPort < 1 || listenerPort > 65_535)
      throw new WorkerdWorkerRuntimeOwnerError("invalid_identity");
    const candidateRecord: IncarnationRecord = {
      operationId,
      listenerPort,
      status: "candidate",
      retirementOperationId: null,
      retireAtMs: null,
      deferRetirementUntilDeadline: false,
      executionCopiesReleased: false,
      executionCopiesCleanupStarted: false,
      executionCopiesCleanupManifestSha256: null,
      processIdentity: null,
      configurationSha256: null,
      configurationRefreshPending: false,
      eventToken: randomBytes(32).toString("hex"),
      identity: null,
      receipt: null,
    };
    await transitionState((current) => ({
      ...current,
      // A route-absence receipt is scoped to the last accepted Endpoint
      // DELETE. Once a new incarnation is durably staged, that historical
      // receipt must no longer describe the current owner state.
      endpointRouteAbsence: null,
      incarnations: [...current.incarnations, candidateRecord],
    }));
    const base = incarnationDirectory(operationId);
    const group = await openWorkerdWorkerExecutionGroup({
      rootDirectory: join(base, "groups"),
      workerResourceUid: options.workerResourceUid,
      listenerPort,
      configuration: new Uint8Array(),
      configurationPath: "workers/workerd.capnp",
      workerdBinary: options.workerdBinary,
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      onSpawned: async (child) => await persistSpawnedChild(operationId, child),
    });
    const handle = makeIncarnationHandle(candidateRecord, group, incumbent);
    await handle.runtime.reload();
    return handle;
  };

  const groupDirectoryFor = (record: IncarnationRecord): string =>
    join(incarnationDirectory(record.operationId), "groups", uidKey(options.workerResourceUid));
  let recoveringGroup: WorkerdWorkerExecutionGroup | null = null;

  const readPinnedGroupConfiguration = async (record: IncarnationRecord): Promise<Uint8Array> => {
    const expectedDigest = record.configurationSha256;
    if (!expectedDigest) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const groupDirectory = groupDirectoryFor(record);
    const configPath = join(groupDirectory, "workers", "workerd.capnp");
    const info = await lstat(configPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const bytes = await readFile(configPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedDigest && !record.configurationRefreshPending) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    if (record.configurationRefreshPending) {
      const manifest = JSON.parse(
        await readFile(join(groupDirectory, "group.json"), "utf8"),
      ) as Record<string, unknown>;
      if (
        manifest.schema !== "takoserver.workerd-worker-group@1" ||
        manifest.workerResourceUid !== options.workerResourceUid ||
        manifest.listenerPort !== record.listenerPort ||
        manifest.configurationSha256 !== digest
      ) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
    }
    return Uint8Array.from(bytes);
  };

  const openExistingRecoveryGroup = async (
    record: IncarnationRecord,
    configuration: Uint8Array,
  ): Promise<WorkerdWorkerExecutionGroup> => {
    if (!record.processIdentity || !record.configurationSha256) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    return await openWorkerdWorkerExecutionGroup({
      rootDirectory: join(incarnationDirectory(record.operationId), "groups"),
      workerResourceUid: options.workerResourceUid,
      listenerPort: record.listenerPort,
      configuration,
      configurationPath: "workers/workerd.capnp",
      workerdBinary: options.workerdBinary,
      recoverExisting: true,
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      onSpawned: async (child) => await persistSpawnedChild(record.operationId, child),
    });
  };

  const retireRecoveredDrainingIncarnation = async (record: IncarnationRecord): Promise<void> => {
    if (
      record.status !== "draining" ||
      !record.retirementOperationId ||
      !record.processIdentity ||
      (await linuxProcessLiveness(record.processIdentity)) !== "stale" ||
      (await workerPortOwnership(record.listenerPort, undefined)) !== "vacant"
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const groupDirectory = groupDirectoryFor(record);
    const operationId = record.retirementOperationId;
    if (record.executionCopiesCleanupStarted) {
      if (!record.receipt || !record.executionCopiesCleanupManifestSha256) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      const released = await releaseRetiredWorkerdWorkerExecutionCopies({
        groupDirectory,
        workerResourceUid: options.workerResourceUid,
        operationId,
        listenerPort: record.listenerPort,
        scriptName: scriptName(options.workerResourceUid),
        cleanupIntentPersisted: true,
        cleanupManifestSha256: record.executionCopiesCleanupManifestSha256,
      });
      if (canonicalJson(released.receipt) !== canonicalJson(record.receipt)) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      await updateRecord(record.operationId, (current) => ({
        ...current,
        status: "retired",
        executionCopiesReleased: true,
      }));
      return;
    }

    if (
      !record.identity ||
      !executionCopiesMatchRecord(
        record,
        await inspectWorkerdWorkerExecutionCopies({
          groupDirectory,
          workerResourceUid: options.workerResourceUid,
          listenerPort: record.listenerPort,
          scriptName: scriptName(options.workerResourceUid),
        }),
        true,
      )
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }

    const configuration = await readPinnedGroupConfiguration(record);
    const receiptPath = join(groupDirectory, "retirement.json");
    const receiptInfo = await lstat(receiptPath).catch(() => null);
    if (receiptInfo && (!receiptInfo.isFile() || receiptInfo.isSymbolicLink())) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    if (!receiptInfo) {
      const group = await openExistingRecoveryGroup(record, configuration);
      await group.retire({ workerResourceUid: options.workerResourceUid, operationId });
    }
    const verified = await verifyRetiredWorkerdWorkerExecutionCopies({
      groupDirectory,
      workerResourceUid: options.workerResourceUid,
      operationId,
      listenerPort: record.listenerPort,
      scriptName: scriptName(options.workerResourceUid),
    });
    if (!executionCopiesMatchRecord(record, verified.copies, true)) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const prepared = await updateRecord(record.operationId, (current) => ({
      ...current,
      receipt: verified.receipt,
      executionCopiesCleanupStarted: true,
      executionCopiesCleanupManifestSha256: verified.cleanupManifestSha256,
    }));
    const released = await releaseRetiredWorkerdWorkerExecutionCopies({
      groupDirectory,
      workerResourceUid: options.workerResourceUid,
      operationId,
      listenerPort: record.listenerPort,
      scriptName: scriptName(options.workerResourceUid),
      cleanupIntentPersisted: true,
      cleanupManifestSha256: prepared.executionCopiesCleanupManifestSha256,
    });
    if (canonicalJson(released.receipt) !== canonicalJson(verified.receipt)) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    await updateRecord(record.operationId, (current) => ({
      ...current,
      status: "retired",
      receipt: released.receipt,
      executionCopiesReleased: true,
      executionCopiesCleanupStarted: true,
    }));
  };

  const recoverActiveIncarnation = async (): Promise<void> => {
    const currentServing = options.publicationState.resolveCurrentServing;
    const activeRecord = state.incarnations.find(
      (record) => record.operationId === state.activeOperationId && record.status === "active",
    );
    if (!currentServing || !activeRecord?.identity || !activeRecord.configurationSha256) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const sourceOperationId = sourceOperationIdFromIdentity(activeRecord.identity);
    if (!sourceOperationId) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const resolution = await currentServing({
      workerUid: options.workerResourceUid,
      targetKey: options.targetKey,
      sourceOperationId,
      expectedIdentity: activeRecord.identity,
    });
    if (
      resolution.kind !== "ready" ||
      resolution.snapshot.sourceOperationId !== sourceOperationId ||
      resolution.snapshot.worker.uid !== options.workerResourceUid ||
      !resolution.snapshot.deployment ||
      canonicalJson(
        resolution.snapshot.deployment.versions
          .map(({ uid, weight }) => ({ workerVersionUid: uid, weight }))
          .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
      ) !==
        canonicalJson(
          activeRecord.identity.versions
            .map(({ workerVersionUid, weight }) => ({ workerVersionUid, weight }))
            .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
        ) ||
      canonicalJson(
        resolution.snapshot.endpoint ? [resolution.snapshot.endpoint.output.hostname] : [],
      ) !== canonicalJson(activeRecord.identity.hostnames) ||
      !(await resolution.stillCurrent())
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }

    for (const record of [...state.incarnations]) {
      if (record.status === "draining") await retireRecoveredDrainingIncarnation(record);
    }
    await verifyOwnerNamespace(directory, state, options.workerResourceUid);
    if (
      canonicalJson(
        state.incarnations.find((item) => item.operationId === activeRecord.operationId),
      ) !== canonicalJson(activeRecord) ||
      !(await resolution.stillCurrent())
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }

    const configuration = await readPinnedGroupConfiguration(activeRecord);
    const copies = await inspectWorkerdWorkerExecutionCopies({
      groupDirectory: groupDirectoryFor(activeRecord),
      workerResourceUid: options.workerResourceUid,
      listenerPort: activeRecord.listenerPort,
      scriptName: scriptName(options.workerResourceUid),
    });
    if (!executionCopiesMatchRecord(activeRecord, copies, true)) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    const group = await openExistingRecoveryGroup(activeRecord, configuration);
    recoveringGroup = group;
    const handle = makeIncarnationHandle(activeRecord, group, activeRecord.identity);
    await updateRecord(activeRecord.operationId, (current) => ({
      ...current,
      configurationRefreshPending: true,
    }));
    const restoredNames = await handle.runtime.restore();
    const nativeProof = await handle.runtime.observeExactPublication?.(
      scriptName(options.workerResourceUid),
      activeRecord.identity,
    );
    if (
      !restoredNames.includes(scriptName(options.workerResourceUid)) ||
      nativeProof !== "matches" ||
      !(await resolution.stillCurrent()) ||
      canonicalJson(
        state.incarnations.find((item) => item.operationId === activeRecord.operationId)?.identity,
      ) !== canonicalJson(activeRecord.identity)
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    group.sealConfiguration();
    const recoveredRecord = recordFor(activeRecord.operationId);
    if (
      !recoveredRecord?.processIdentity ||
      !recoveredRecord.configurationSha256 ||
      recoveredRecord.configurationRefreshPending ||
      recoveredRecord.configurationSha256 !== group.configurationSha256
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    handle.record = recoveredRecord;
    active = handle;
    admissionClosedBy = null;
    await verifyOwnerNamespace(directory, state, options.workerResourceUid);
    if (!(await resolution.stillCurrent())) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    recoveringGroup = null;
  };

  const runSerial = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = serial;
    let release!: () => void;
    serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const confirmNoActiveEndpointRoute = async (
    execution: V2Execution,
  ): Promise<V2EndpointRouteAbsentReceipt | { kind: "unknown" } | null> => {
    const resolution = await options.publicationState.resolve({ execution });
    if (resolution.kind !== "ready") return { kind: "unknown" };
    const snapshot = resolution.snapshot;
    if (snapshot.deployment !== null) return null;
    let endpointSpec: ReturnType<typeof parseWorkerEndpointSpec>;
    try {
      endpointSpec = parseWorkerEndpointSpec(execution.spec);
    } catch {
      return { kind: "unknown" };
    }
    const assigned = snapshot.acceptedEndpointOutput;
    if (
      execution.form !== WORKER_ENDPOINT_FORM_URL ||
      execution.action !== "delete" ||
      snapshot.sourceOperationId !== execution.operationId ||
      snapshot.worker.uid !== options.workerResourceUid ||
      snapshot.worker.principal !== execution.principal ||
      snapshot.worker.space !== execution.space ||
      endpointSpec.worker.resourceUid !== options.workerResourceUid ||
      snapshot.endpoint !== null ||
      !assigned ||
      !ENDPOINT_HOSTNAME.test(assigned.hostname) ||
      assigned.url !== `https://${assigned.hostname}/`
    ) {
      return { kind: "unknown" };
    }

    // A no-Deployment route absence is established either by exact retirement
    // receipts for every known incarnation, or by a complete empty namespace
    // inventory. The receipt proves child exit and listener absence; a stale
    // metadata pointer inside that non-listening group is not a live route.
    if (
      closed ||
      active !== null ||
      state.activeOperationId !== null ||
      state.incarnations.some(
        (record) =>
          record.status !== "retired" ||
          record.receipt === null ||
          record.retirementOperationId === null ||
          !record.executionCopiesReleased ||
          !record.executionCopiesCleanupStarted,
      )
    ) {
      return { kind: "unknown" };
    }

    const capturedState = canonicalJson(state);
    await verifyOwnerNamespace(directory, state, options.workerResourceUid);
    for (const record of state.incarnations) {
      const groupDirectory = join(
        directory,
        "incarnations",
        record.operationId,
        "groups",
        uidKey(options.workerResourceUid),
      );
      const copies = await inspectWorkerdWorkerExecutionCopies({
        groupDirectory,
        workerResourceUid: options.workerResourceUid,
        listenerPort: record.listenerPort,
        scriptName: scriptName(options.workerResourceUid),
      }).catch(() => null);
      if (copies?.versionUids.length !== 0 || copies?.generationKeys.length !== 0) {
        return { kind: "unknown" };
      }
      const physical = await releaseRetiredWorkerdWorkerExecutionCopies({
        groupDirectory,
        workerResourceUid: options.workerResourceUid,
        operationId: record.retirementOperationId as string,
        listenerPort: record.listenerPort,
        scriptName: scriptName(options.workerResourceUid),
        cleanupIntentPersisted: true,
        cleanupManifestSha256: record.executionCopiesCleanupManifestSha256,
        alreadyReleased: true,
      }).catch(() => null);
      if (!physical || canonicalJson(physical.receipt) !== canonicalJson(record.receipt)) {
        return { kind: "unknown" };
      }
    }

    if (
      canonicalJson(state) !== capturedState ||
      active !== null ||
      state.activeOperationId !== null ||
      state.incarnations.some(
        (record) =>
          record.status !== "retired" ||
          record.receipt === null ||
          !record.executionCopiesReleased ||
          !record.executionCopiesCleanupStarted,
      )
    ) {
      return { kind: "unknown" };
    }
    try {
      await verifyOwnerNamespace(directory, state, options.workerResourceUid);
    } catch {
      return { kind: "unknown" };
    }
    if (!(await resolution.stillCurrent())) return { kind: "unknown" };

    const receipt: V2EndpointRouteAbsentReceipt = {
      kind: "confirmed_route_absent",
      sourceOperationId: execution.operationId,
      endpointResourceUid: execution.resourceUid,
      workerResourceUid: options.workerResourceUid,
      targetKey: options.targetKey,
      assignedHostname: assigned.hostname,
    };
    const persisted = await transitionState((current) => {
      if (
        current.activeOperationId !== null ||
        current.incarnations.some(
          (record) =>
            record.status !== "retired" ||
            record.receipt === null ||
            !record.executionCopiesReleased ||
            !record.executionCopiesCleanupStarted,
        )
      ) {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      return { ...current, endpointRouteAbsence: receipt };
    });
    if (
      !validEndpointRouteAbsence(persisted.endpointRouteAbsence) ||
      canonicalJson(persisted.endpointRouteAbsence) !== canonicalJson(receipt) ||
      !(await resolution.stillCurrent())
    ) {
      return { kind: "unknown" };
    }
    try {
      await verifyOwnerNamespace(directory, persisted, options.workerResourceUid);
    } catch {
      return { kind: "unknown" };
    }
    if (canonicalJson(state) !== canonicalJson(persisted) || !(await resolution.stillCurrent())) {
      return { kind: "unknown" };
    }
    return receipt;
  };

  const execute = (inputExecution: V2Execution): Promise<V2WorkerRuntimeOwnerExecutionResult> => {
    let captured: V2Execution;
    try {
      captured = structuredClone(inputExecution);
    } catch {
      return Promise.resolve({ kind: "not_dispatched", code: "worker_operation_invalid" });
    }
    return runSerial(async () => {
      const execution = captured;
      if (closed) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      validateOperationId(execution.operationId);
      if (
        (execution.form !== WORKER_DEPLOYMENT_FORM_URL &&
          execution.form !== WORKER_ENDPOINT_FORM_URL) ||
        execution.targetKey !== options.targetKey ||
        workerFromExecution(execution) !== options.workerResourceUid
      ) {
        return { kind: "not_dispatched", code: "worker_publication_target_mismatch" };
      }
      if (execution.form === WORKER_ENDPOINT_FORM_URL && execution.action === "delete") {
        try {
          const absence = await confirmNoActiveEndpointRoute(execution);
          if (absence !== null) return absence;
        } catch {
          return { kind: "unknown" };
        }
      }
      if (execution.form === WORKER_DEPLOYMENT_FORM_URL && execution.action === "delete") {
        try {
          return await deleteDeployment(execution);
        } catch {
          return { kind: "unknown" };
        }
      }
      if (admissionClosedBy !== null && execution.operationId !== admissionClosedBy) {
        const deleteRetired =
          state.deletionPublicationConfirmed &&
          state.incarnations.every(
            (item) =>
              item.status === "retired" && item.receipt !== null && item.executionCopiesReleased,
          );
        if (!deleteRetired) return { kind: "unknown" };
        admissionClosedBy = null;
        await transitionState((current) => ({
          ...current,
          admissionClosedBy: null,
          deletionPublicationConfirmed: false,
          endpointRouteAbsence: null,
        }));
      }

      const existing = handles.get(execution.operationId);
      if (existing) {
        if (existing.record.status !== "candidate") {
          if (existing.record.status !== "active" || active !== existing)
            return { kind: "unknown" };
          const observed = await existing.publication.observe(execution);
          if (
            observed.kind === "confirmed" &&
            observed.identity !== null &&
            canonicalJson(observed.identity) === canonicalJson(existing.record.identity) &&
            observed.deferRetirementUntilDeadline === existing.record.deferRetirementUntilDeadline
          ) {
            return observed;
          }
          return { kind: "unknown" };
        }
        const result = await existing.publication.publish(execution);
        if (result.kind === "confirmed" && result.identity !== null) {
          return await activateIncarnation(
            existing,
            result.identity,
            result.deferRetirementUntilDeadline,
            execution.operationId,
          );
        }
        if (execution.form === WORKER_ENDPOINT_FORM_URL && result.kind === "confirmed") {
          return { kind: "unknown" };
        }
        return result;
      }
      if (recordFor(execution.operationId)) return { kind: "unknown" };

      let incumbentIdentity: WorkerdPublicationIdentity | null = null;
      if (active) {
        incumbentIdentity = active.record.identity;
        if (
          incumbentIdentity === null ||
          (await active.runtime.observeExactPublication?.(
            scriptName(options.workerResourceUid),
            incumbentIdentity,
          )) !== "matches"
        ) {
          return { kind: "unknown" };
        }
      }

      let candidate: IncarnationHandle | undefined;
      try {
        candidate = await createIncarnation(execution, incumbentIdentity);
        const result = await candidate.publication.publish(execution);
        if (result.kind !== "confirmed" || result.identity === null) {
          if (result.kind === "not_dispatched")
            await retireCandidate(candidate, execution.operationId);
          else await retireCandidate(candidate, execution.operationId).catch(() => undefined);
          if (execution.form === WORKER_ENDPOINT_FORM_URL && result.kind === "confirmed") {
            return { kind: "unknown" };
          }
          return result;
        }
        candidate.group.sealConfiguration();
        return await activateIncarnation(
          candidate,
          result.identity,
          result.deferRetirementUntilDeadline,
          execution.operationId,
        );
      } catch {
        if (candidate)
          await retireCandidate(candidate, execution.operationId).catch(() => undefined);
        else {
          const record = recordFor(execution.operationId);
          if (record?.status === "candidate") {
            await updateRecord(execution.operationId, (current) => ({
              ...current,
              status: "uncertain",
            })).catch(() => undefined);
          }
        }
        return { kind: "unknown" };
      }
    });
  };

  const observeServing: WorkerdWorkerRuntimeOwner["observeServing"] = (input) =>
    runSerial(async () => {
      const unknown = { kind: "unknown" } as const;
      if (
        closed ||
        input.workerResourceUid !== options.workerResourceUid ||
        input.targetKey !== options.targetKey ||
        admissionClosedBy !== null
      ) {
        return unknown;
      }
      const incarnation = active;
      const operationId = state.activeOperationId;
      if (
        !incarnation ||
        !operationId ||
        incarnation.record.operationId !== operationId ||
        incarnation.record.status !== "active" ||
        incarnation.record.identity === null ||
        incarnation.record.identity.workerResourceUid !== options.workerResourceUid ||
        incarnation.record.identity.generation !== expectedOperationMarker(operationId) ||
        !incarnation.group.isReady()
      ) {
        return unknown;
      }
      const identity = cloneRecord(incarnation.record).identity;
      if (!identity) return unknown;
      const copies = await inspectWorkerdWorkerExecutionCopies({
        groupDirectory: incarnation.group.runtimeRoot,
        workerResourceUid: options.workerResourceUid,
        listenerPort: incarnation.record.listenerPort,
        scriptName: scriptName(options.workerResourceUid),
      }).catch(() => null);
      if (
        !copies ||
        !executionCopiesMatchRecord(incarnation.record, copies, true) ||
        identity.versions.some(
          (version) => !copies.versionUids.includes(version.workerVersionUid),
        ) ||
        (await incarnation.runtime.observeExactPublication?.(
          scriptName(options.workerResourceUid),
          identity,
        )) !== "matches"
      ) {
        return unknown;
      }
      const current = recordFor(operationId);
      if (
        closed ||
        admissionClosedBy !== null ||
        active !== incarnation ||
        state.activeOperationId !== operationId ||
        current?.status !== "active" ||
        current.identity === null ||
        canonicalJson(current.identity) !== canonicalJson(identity) ||
        !incarnation.group.isReady()
      ) {
        return unknown;
      }
      return {
        kind: "serving",
        workerResourceUid: options.workerResourceUid,
        targetKey: options.targetKey,
        sourceOperationId: operationId,
        generation: identity.generation,
        hostnames: [...identity.hostnames],
        versions: identity.versions.map(({ workerVersionUid, weight }) => ({
          workerVersionUid,
          weight,
        })),
      };
    });

  const observeRetirement: WorkerdWorkerRuntimeOwner["observeRetirement"] = (input) =>
    runSerial(async () => {
      const unknown = { kind: "unknown" } as const;
      if (closed || (input.workerVersionUid !== undefined && !input.workerVersionUid))
        return unknown;
      const servingIncarnation = active;
      const operationIds: string[] = [];
      for (const record of state.incarnations) {
        operationIds.push(record.operationId);
        if (record.status === "active") {
          if (
            input.workerVersionUid === undefined ||
            !servingIncarnation ||
            servingIncarnation.record.operationId !== record.operationId
          ) {
            return unknown;
          }
          const identity = record.identity;
          if (
            !identity ||
            identity.generation !== expectedOperationMarker(record.operationId) ||
            admissionClosedBy !== null ||
            !servingIncarnation.group.isReady() ||
            (await servingIncarnation.runtime.observeExactPublication?.(
              scriptName(options.workerResourceUid),
              identity,
            )) !== "matches"
          ) {
            return unknown;
          }
          const copies = await inspectWorkerdWorkerExecutionCopies({
            groupDirectory: servingIncarnation.group.runtimeRoot,
            workerResourceUid: options.workerResourceUid,
            listenerPort: record.listenerPort,
            scriptName: scriptName(options.workerResourceUid),
          }).catch(() => null);
          if (
            !copies ||
            !executionCopiesMatchRecord(record, copies, true) ||
            identity.versions.some(
              (version) => !copies.versionUids.includes(version.workerVersionUid),
            ) ||
            copies.versionUids.includes(input.workerVersionUid)
          ) {
            return unknown;
          }
          const current = recordFor(record.operationId);
          if (
            active !== servingIncarnation ||
            state.activeOperationId !== record.operationId ||
            current?.status !== "active" ||
            canonicalJson(current.identity) !== canonicalJson(identity) ||
            admissionClosedBy !== null ||
            !servingIncarnation.group.isReady()
          ) {
            return unknown;
          }
          continue;
        }
        if (
          record.status !== "retired" ||
          record.receipt === null ||
          !record.executionCopiesReleased ||
          record.retirementOperationId === null
        ) {
          return unknown;
        }
        const groupDirectory = join(
          directory,
          "incarnations",
          record.operationId,
          "groups",
          uidKey(options.workerResourceUid),
        );
        const copies = await inspectWorkerdWorkerExecutionCopies({
          groupDirectory,
          workerResourceUid: options.workerResourceUid,
          listenerPort: record.listenerPort,
          scriptName: scriptName(options.workerResourceUid),
        }).catch(() => null);
        if (copies === null) return unknown;
        if (copies.versionUids.length !== 0 || copies.generationKeys.length !== 0) {
          return unknown;
        }
        const checked = await releaseRetiredWorkerdWorkerExecutionCopies({
          groupDirectory,
          workerResourceUid: options.workerResourceUid,
          operationId: record.retirementOperationId,
          listenerPort: record.listenerPort,
          scriptName: scriptName(options.workerResourceUid),
          cleanupIntentPersisted: true,
          cleanupManifestSha256: record.executionCopiesCleanupManifestSha256,
          alreadyReleased: true,
        }).catch(() => null);
        if (!checked || canonicalJson(checked.receipt) !== canonicalJson(record.receipt))
          return unknown;
      }
      return {
        kind: "confirmed_absent",
        workerResourceUid: options.workerResourceUid,
        targetKey: options.targetKey,
        ...(input.workerVersionUid === undefined
          ? {}
          : { workerVersionUid: input.workerVersionUid }),
        incarnationOperationIds: operationIds.sort(),
      };
    });

  function scriptName(workerUid: string): string {
    return `v2-worker-${uidKey(workerUid)}`;
  }

  async function retireCandidate(candidate: IncarnationHandle, operationId: string): Promise<void> {
    candidate.record = await updateRecord(candidate.record.operationId, (current) => ({
      ...current,
      status: "retiring",
      retirementOperationId: operationId,
    }));
    await retireIncarnation(candidate);
  }

  async function activateIncarnation(
    candidate: IncarnationHandle,
    identity: WorkerdPublicationIdentity,
    deferRetirementUntilDeadline: boolean,
    operationId: string,
  ): Promise<V2WorkerPublicationResult> {
    if (
      typeof deferRetirementUntilDeadline !== "boolean" ||
      identity.workerResourceUid !== options.workerResourceUid
    )
      return { kind: "unknown" };
    if (identity.generation !== expectedOperationMarker(operationId)) return { kind: "unknown" };
    const previous = active;
    const now = Date.now();
    let oldRecord: IncarnationRecord | null = null;
    const snapshot = await transitionState((current) => {
      const candidateRecord = current.incarnations.find(
        (item) => item.operationId === candidate.record.operationId,
      );
      if (!candidateRecord) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      const nextCandidate: IncarnationRecord = {
        ...candidateRecord,
        status: "active",
        identity,
        deferRetirementUntilDeadline,
        configurationSha256: candidate.group.configurationSha256,
      };
      oldRecord = previous
        ? {
            ...current.incarnations.find(
              (item) => item.operationId === previous.record.operationId,
            )!,
            status: "draining",
            retirementOperationId: operationId,
            retireAtMs: now + DRAIN_GRACE_MS,
          }
        : null;
      return {
        ...current,
        activeOperationId: operationId,
        admissionClosedBy: null,
        deletionPublicationConfirmed: false,
        endpointRouteAbsence: null,
        incarnations: current.incarnations.map((item) =>
          item.operationId === candidate.record.operationId
            ? nextCandidate
            : oldRecord && previous && item.operationId === previous.record.operationId
              ? oldRecord
              : item,
        ),
      };
    });
    candidate.record = snapshot.incarnations.find(
      (item) => item.operationId === candidate.record.operationId,
    )!;
    active = candidate;
    admissionClosedBy = null;
    if (previous) {
      previous.record = snapshot.incarnations.find(
        (item) => item.operationId === previous.record.operationId,
      )!;
      scheduleIncarnationRetirement(previous);
    }
    return { kind: "confirmed", identity, deferRetirementUntilDeadline };
  }

  async function deleteDeployment(execution: V2Execution): Promise<V2WorkerPublicationResult> {
    if (admissionClosedBy !== null && admissionClosedBy !== execution.operationId) {
      return { kind: "unknown" };
    }
    if (
      state.incarnations.some((item) => item.status !== "retired" && !handles.has(item.operationId))
    ) {
      return { kind: "unknown" };
    }
    const priorOperationId = state.activeOperationId;
    const resolution = await options.publicationState.resolve({
      execution,
      ...(priorOperationId === null ? {} : { incumbentSourceOperationId: priorOperationId }),
    });
    if (resolution.kind !== "ready") return { kind: "not_dispatched", code: resolution.code };
    if (
      resolution.snapshot.sourceOperationId !== execution.operationId ||
      resolution.snapshot.worker.uid !== options.workerResourceUid ||
      resolution.snapshot.worker.principal !== execution.principal ||
      resolution.snapshot.worker.space !== execution.space ||
      resolution.snapshot.deployment !== null
    ) {
      return { kind: "not_dispatched", code: "worker_delete_snapshot_mismatch" };
    }

    if (
      state.admissionClosedBy === execution.operationId &&
      state.deletionPublicationConfirmed &&
      state.incarnations.every(
        (item) =>
          item.status === "retired" && item.receipt !== null && item.executionCopiesReleased,
      )
    ) {
      return (await resolution.stillCurrent())
        ? { kind: "confirmed", identity: null }
        : { kind: "unknown" };
    }

    // The owner route is the only tenant dispatch surface this port proves.
    // Persist closure before canceling streams or stopping any process.
    if (admissionClosedBy === null) {
      admissionClosedBy = execution.operationId;
      await transitionState((current) => ({
        ...current,
        admissionClosedBy,
        deletionPublicationConfirmed: false,
        endpointRouteAbsence: null,
      }));
    }
    for (const incarnation of handles.values()) await cancelInvocations(incarnation);

    const live = [...handles.values()].filter(
      (item) => item.record.status !== "retired" || !item.record.executionCopiesReleased,
    );
    for (const incarnation of live) {
      incarnation.retirementTimer?.();
      delete incarnation.retirementTimer;
      if (incarnation.record.retirementOperationId === null) {
        incarnation.record = await updateRecord(incarnation.record.operationId, (record) => ({
          ...record,
          status: "retiring",
          retirementOperationId: execution.operationId,
          retireAtMs: null,
        }));
      }
    }
    const receipts = await Promise.allSettled(
      live.map((incarnation) => retireIncarnation(incarnation)),
    );
    if (receipts.some((receipt) => receipt.status === "rejected")) return { kind: "unknown" };
    if (!(await resolution.stillCurrent())) return { kind: "unknown" };
    await transitionState((current) => ({
      ...current,
      activeOperationId: null,
      admissionClosedBy,
      deletionPublicationConfirmed: true,
    }));
    active = null;
    return { kind: "confirmed", identity: null };
  }

  const fetchRequest = async (request: Request): Promise<Response> => {
    if (closed) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    if (admissionClosedBy !== null || !active)
      throw new WorkerdWorkerRuntimeOwnerError("admission_closed");
    const incarnation = active;
    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });
    const invocation: ActiveInvocation = {
      abort: new AbortController(),
      done,
      finish() {
        finishInvocation(incarnation, invocation);
        doneResolve();
      },
      finished: false,
    };
    incarnation.invocations.add(invocation);
    let forwarded: Request;
    try {
      forwarded = makeRequest(request, AbortSignal.any([request.signal, invocation.abort.signal]));
      const response = await incarnation.group.fetch(forwarded);
      return responseWithTrackedBody(response, invocation);
    } catch (error) {
      invocation.finish();
      throw error;
    }
  };

  const observeScheduledCapability: WorkerdWorkerRuntimeOwner["observeScheduledCapability"] = (
    input,
  ) =>
    runSerial(async () => {
      const unknown = { kind: "unknown" } as const;
      const source = options.publicationState.resolveCurrentServing;
      const incarnation = active;
      const operationId = state.activeOperationId;
      if (
        closed ||
        admissionClosedBy !== null ||
        !source ||
        !incarnation ||
        !operationId ||
        input.workerUid !== options.workerResourceUid ||
        input.targetKey !== options.targetKey ||
        incarnation.record.operationId !== operationId ||
        incarnation.record.status !== "active" ||
        !incarnation.record.eventToken ||
        !incarnation.record.identity ||
        !incarnation.group.isReady()
      ) {
        return unknown;
      }
      const identity = cloneRecord(incarnation.record).identity;
      if (!identity || identity.generation !== expectedOperationMarker(operationId)) return unknown;
      const resolution = await source({
        workerUid: options.workerResourceUid,
        targetKey: options.targetKey,
        sourceOperationId: operationId,
        expectedIdentity: identity,
      }).catch(() => null);
      if (resolution?.kind !== "ready") return unknown;
      const snapshot = resolution.snapshot;
      if (
        snapshot.sourceOperationId !== operationId ||
        snapshot.worker.uid !== options.workerResourceUid ||
        snapshot.worker.principal !== input.principal ||
        snapshot.worker.space !== input.space ||
        !snapshot.deployment ||
        snapshot.deployment.versions.length !== identity.versions.length ||
        canonicalJson(snapshot.endpoint ? [snapshot.endpoint.output.hostname] : []) !==
          canonicalJson(identity.hostnames) ||
        canonicalJson(
          snapshot.deployment.versions
            .map(({ uid, weight }) => ({ workerVersionUid: uid, weight }))
            .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
        ) !==
          canonicalJson(
            identity.versions
              .map(({ workerVersionUid, weight }) => ({ workerVersionUid, weight }))
              .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
          )
      ) {
        return unknown;
      }
      try {
        if (
          snapshot.deployment.versions.some(
            (version) => !parseWorkerVersionSpec(version.spec).handlers.includes("scheduled"),
          )
        ) {
          return unknown;
        }
      } catch {
        return unknown;
      }
      const stillCurrent = async (): Promise<boolean> =>
        await runSerial(async () => {
          if (
            closed ||
            admissionClosedBy !== null ||
            active !== incarnation ||
            state.activeOperationId !== operationId ||
            canonicalJson(recordFor(operationId)?.identity) !== canonicalJson(identity) ||
            !incarnation.group.isReady() ||
            !(await resolution.stillCurrent().catch(() => false))
          ) {
            return false;
          }
          const copies = await inspectWorkerdWorkerExecutionCopies({
            groupDirectory: incarnation.group.runtimeRoot,
            workerResourceUid: options.workerResourceUid,
            listenerPort: incarnation.record.listenerPort,
            scriptName: scriptName(options.workerResourceUid),
          }).catch(() => null);
          return (
            !!copies &&
            executionCopiesMatchRecord(incarnation.record, copies, true) &&
            identity.versions.every((version) =>
              copies.versionUids.includes(version.workerVersionUid),
            ) &&
            (await incarnation.runtime.observeExactPublication?.(
              scriptName(options.workerResourceUid),
              identity,
            )) === "matches" &&
            (await resolution.stillCurrent().catch(() => false))
          );
        }).catch(() => false);
      // This call already owns the serial lane. Recheck directly here to avoid
      // waiting on ourselves; returned callers use the closure above.
      const copies = await inspectWorkerdWorkerExecutionCopies({
        groupDirectory: incarnation.group.runtimeRoot,
        workerResourceUid: options.workerResourceUid,
        listenerPort: incarnation.record.listenerPort,
        scriptName: scriptName(options.workerResourceUid),
      }).catch(() => null);
      if (
        !copies ||
        !executionCopiesMatchRecord(incarnation.record, copies, true) ||
        identity.versions.some(
          (version) => !copies.versionUids.includes(version.workerVersionUid),
        ) ||
        (await incarnation.runtime.observeExactPublication?.(
          scriptName(options.workerResourceUid),
          identity,
        )) !== "matches" ||
        !(await resolution.stillCurrent().catch(() => false))
      ) {
        return unknown;
      }
      return {
        kind: "confirmed" as const,
        servingSourceOperationId: operationId,
        deploymentUid: snapshot.deployment.uid,
        deploymentGeneration: snapshot.deployment.generation,
        versions: snapshot.deployment.versions.map(({ uid, generation, weight }) => ({
          workerVersionUid: uid,
          generation,
          weight,
        })),
        stillCurrent,
      };
    }).catch(() => ({ kind: "unknown" as const }));

  const invokeScheduled: WorkerdWorkerRuntimeOwner["invokeScheduled"] = async (input) => {
    const unknown = { kind: "unknown" } as const;
    if (
      typeof input.triggerUid !== "string" ||
      input.triggerUid.length === 0 ||
      input.triggerUid.length > 256 ||
      typeof input.matchId !== "string" ||
      input.matchId.length === 0 ||
      input.matchId.length > 512 ||
      input.workerUid !== options.workerResourceUid
    ) {
      return unknown;
    }
    const source = options.publicationState.resolveCurrentServing;
    if (!source) return unknown;
    const admitted = await runSerial(async () => {
      if (closed || admissionClosedBy !== null) return null;
      const incarnation = active;
      const operationId = state.activeOperationId;
      if (
        !incarnation ||
        !operationId ||
        incarnation.record.operationId !== operationId ||
        incarnation.record.status !== "active" ||
        !incarnation.record.eventToken ||
        !incarnation.record.identity ||
        !incarnation.group.isReady()
      ) {
        return null;
      }
      const identity = cloneRecord(incarnation.record).identity;
      if (!identity || identity.generation !== expectedOperationMarker(operationId)) return null;
      const sourceOperationId = sourceOperationIdFromIdentity(identity);
      if (sourceOperationId !== operationId) return null;
      const resolution = await source({
        workerUid: options.workerResourceUid,
        targetKey: options.targetKey,
        sourceOperationId,
        expectedIdentity: identity,
      }).catch(() => null);
      if (
        resolution?.kind !== "ready" ||
        resolution.snapshot.sourceOperationId !== operationId ||
        resolution.snapshot.worker.uid !== options.workerResourceUid ||
        !resolution.snapshot.deployment ||
        canonicalJson(
          resolution.snapshot.endpoint ? [resolution.snapshot.endpoint.output.hostname] : [],
        ) !== canonicalJson(identity.hostnames) ||
        canonicalJson(
          resolution.snapshot.deployment.versions
            .map(({ uid, weight }) => ({ workerVersionUid: uid, weight }))
            .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
        ) !==
          canonicalJson(
            identity.versions
              .map(({ workerVersionUid, weight }) => ({ workerVersionUid, weight }))
              .sort((left, right) => left.workerVersionUid.localeCompare(right.workerVersionUid)),
          ) ||
        !(await resolution.stillCurrent().catch(() => false)) ||
        (await incarnation.runtime.observeExactPublication?.(
          scriptName(options.workerResourceUid),
          identity,
        )) !== "matches"
      ) {
        return null;
      }
      const copies = await inspectWorkerdWorkerExecutionCopies({
        groupDirectory: incarnation.group.runtimeRoot,
        workerResourceUid: options.workerResourceUid,
        listenerPort: incarnation.record.listenerPort,
        scriptName: scriptName(options.workerResourceUid),
      }).catch(() => null);
      if (!copies || !executionCopiesMatchRecord(incarnation.record, copies, true)) return null;
      let selected: ReturnType<typeof selectSelfhostWeightedVersion>;
      let event: ReturnType<typeof selfhostScheduleEvent>;
      try {
        selected = selectSelfhostWeightedVersion(
          identity.versions,
          randomSelfhostDeploymentBasisPoint(),
        );
        if (!copies.versionUids.includes(selected.workerVersionUid)) return null;
        event = selfhostScheduleEvent({
          script: scriptName(options.workerResourceUid),
          publication: selected.versionId,
          cron: input.cron,
          scheduledTime: input.scheduledTime,
        });
      } catch {
        return null;
      }
      if (
        closed ||
        admissionClosedBy !== null ||
        active !== incarnation ||
        state.activeOperationId !== operationId ||
        canonicalJson(recordFor(operationId)?.identity) !== canonicalJson(identity) ||
        !(await resolution.stillCurrent().catch(() => false))
      ) {
        return null;
      }
      let doneResolve!: () => void;
      const done = new Promise<void>((resolve) => {
        doneResolve = resolve;
      });
      const invocation: ActiveInvocation = {
        abort: new AbortController(),
        done,
        finish() {
          finishInvocation(incarnation, invocation);
          doneResolve();
        },
        finished: false,
      };
      incarnation.invocations.add(invocation);
      return {
        incarnation,
        operationId,
        identity,
        selected,
        event,
        token: incarnation.record.eventToken,
        resolution,
        invocation,
      };
    }).catch(() => null);
    if (!admitted) return unknown;
    try {
      if (
        admitted.invocation.abort.signal.aborted ||
        !(await admitted.resolution.stillCurrent().catch(() => false))
      ) {
        return unknown;
      }
      const answer = await admitted.incarnation.runtime.probe?.(
        scriptName(options.workerResourceUid),
        SELFHOST_WORKER_EVENT_PATH,
        {
          route: "events",
          method: "POST",
          headers: {
            "content-type": SELFHOST_WORKER_EVENT_CONTENT_TYPE,
            [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_WORKER_EVENT_PROTOCOL,
            [SELFHOST_WORKER_EVENT_TOKEN_HEADER]: admitted.token,
          },
          body: JSON.stringify(admitted.event),
          timeoutMillis: 30_000,
        },
      );
      const outcome = scheduledAnswer(answer);
      if (!outcome) return unknown;
      return await runSerial(async () => {
        if (
          closed ||
          admitted.invocation.abort.signal.aborted ||
          admissionClosedBy !== null ||
          active !== admitted.incarnation ||
          state.activeOperationId !== admitted.operationId ||
          canonicalJson(recordFor(admitted.operationId)?.identity) !==
            canonicalJson(admitted.identity) ||
          !admitted.incarnation.group.isReady() ||
          !(await admitted.resolution.stillCurrent().catch(() => false))
        ) {
          return unknown;
        }
        return { kind: outcome, workerVersionUid: admitted.selected.workerVersionUid };
      });
    } catch {
      return unknown;
    } finally {
      admitted.invocation.finish();
    }
  };

  const close = async (): Promise<void> => {
    await runSerial(async () => {
      if (closed) return;
      if (
        state.incarnations.some(
          (item) =>
            item.status !== "retired" || item.receipt === null || !item.executionCopiesReleased,
        )
      )
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      for (const item of handles.values()) {
        item.retirementTimer?.();
      }
      await releaseOwnerLock(lockPath, directory, ownerLock);
      closed = true;
    });
  };

  const initial: PersistedOwnerState = state;
  if (!initial.incarnations.length) await transitionState((current) => current);
  if (
    ownerLock.recoveredFromStaleOwner &&
    state.incarnations.some((item) => item.status === "active")
  ) {
    try {
      await recoverActiveIncarnation();
    } catch (error) {
      // A failed recovery must never leave a newly started child serving. The
      // recovery group stops only the exact child it spawned and retains all
      // immutable owner custody for a later safe attempt.
      const operationId = state.activeOperationId;
      const failedRecoveryGroup = recoveringGroup as WorkerdWorkerExecutionGroup | null;
      if (failedRecoveryGroup && operationId) {
        try {
          await failedRecoveryGroup.stopAfterFailedRecovery();
        } catch {
          // The child or listener is still unknown. The live successor lock
          // remains the only proof that this process owns the attempted recovery.
        }
        handles.delete(operationId);
        active = null;
      }
      // An active record can never be reopened through the no-lock path. Keep
      // this successor lock (and its PID fingerprint) even when failure was
      // transient; a later Host may retry only after this PID is proven stale.
      await retainOwnerLockAfterFailure(ownerLock);
      if (error instanceof WorkerdWorkerRuntimeOwnerError) throw error;
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
  }
  // If this owner opens after all groups were retired, the durable state can
  // replay its delete proof. Unretired groups are rejected above and never adopted.
  return Object.freeze({
    workerResourceUid: options.workerResourceUid,
    execute,
    observeServing,
    observeRetirement,
    fetch: fetchRequest,
    observeScheduledCapability,
    invokeScheduled,
    close,
  });
}
