import { Buffer } from "node:buffer";
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
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE,
  SELFHOST_V2_QUEUE_EVENT_PATH,
  SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_HEADER,
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_TOKEN_BINDING,
  SELFHOST_WORKER_EVENT_TOKEN_HEADER,
  selfhostScheduleEvent,
  selfhostV2QueueCompletionAnswer,
  selfhostV2QueueEvent,
} from "./providers/selfhost-events.ts";
import type { V2ObjectBucketBindingGrant } from "./providers/selfhost-v2-object-bucket-binding-broker.ts";
import {
  V2_QUEUE_SETTLEMENT_TOKEN_BINDING,
  type V2QueueDispatchGrant,
} from "./providers/selfhost-v2-queue-transport.ts";
import type { V2SqliteBindingGrant } from "./providers/selfhost-v2-sqlite-binding-broker.ts";
import {
  randomSelfhostDeploymentBasisPoint,
  selectSelfhostWeightedVersion,
} from "./selfhost-weighted-deployment.ts";
import type { KvWorkerBindingClaim } from "./takoform-v2/forms/kv-worker-binding-authority.ts";
import type {
  ObjectBucketWorkerBindingClaim,
  ObjectBucketWorkerBindingResolution,
} from "./takoform-v2/forms/object-bucket-worker-binding-authority.ts";
import type {
  QueueWorkerBindingClaim,
  QueueWorkerBindingResolution,
} from "./takoform-v2/forms/queue-worker-binding-authority.ts";
import type { SQLiteWorkerBindingClaim } from "./takoform-v2/forms/sqlite-worker-binding-authority.ts";
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
  V2WorkerVersionMaterials,
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
  WorkerdActiveActorGraph,
  WorkerdActorForwardSocket,
  WorkerdPrivateServiceLease,
  WorkerdPublicationIdentity,
  WorkerdRuntime,
  WorkerdSelectedActiveVersion,
  WorkerdSite,
  WorkerdStaticSite,
  WorkerdWorkflowForwardLifecycle,
  WorkerdWorkflowForwardPublication,
  WorkerdWorkflowForwardSocket,
} from "./workerd-runtime.ts";
import {
  createWorkerdRuntime,
  readWorkerdActiveActorGraph,
  readWorkerdActiveDeployment,
  readWorkerdSelectedActiveVersion,
} from "./workerd-runtime.ts";
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
const EVENT_TOKEN_STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@8";
const STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@9";
const LOCK_SCHEMA = "takoserver.v2-worker-runtime-owner-lock@2";
const OPERATION_MARKER = "takoserver-v2-operation:";
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DRAIN_GRACE_MS = 15 * 60 * 1000;
const LOCK_MAX_BYTES = 2_048;
const RECOVERY_PREFIX = ".runtime-owner-recovery.";
const ENDPOINT_HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const PRIVATE_SOCKET_NAME = /^[0-9a-f]{64}\.sock$/u;

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
        readVersionMaterials?(versionUid: string): Promise<V2WorkerVersionMaterials>;
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
  /** A normal Host stop keeps custody but has no serving child or admission. */
  readonly suspended: boolean;
  /** Exact physical executions proved absent before a replacement PID is recorded. */
  readonly physicalAbsences: readonly PhysicalIncarnationAbsence[];
  readonly incarnations: readonly IncarnationRecord[];
}

interface PhysicalIncarnationAbsence {
  readonly operationId: string;
  readonly incarnationId: string;
  readonly processIdentity: LinuxProcessIdentity;
  readonly listenerPort: number;
  readonly configurationSha256: string;
  readonly receiptDigest: string;
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
  readonly actorForward?: V2ActorForwardIncarnation;
  readonly workflowForward?: V2WorkflowForwardIncarnation;
  readonly invocations: Set<ActiveInvocation>;
  readonly workflowLeases: Set<Promise<void>>;
  retirementTimer?: () => void;
  retiring?: Promise<WorkerdWorkerRetirementReceipt>;
}

type V2ActorForwardIncarnation = NonNullable<
  ReturnType<NonNullable<OpenWorkerdWorkerRuntimeOwnerOptions["v2ActorForward"]>["openIncarnation"]>
>;
type V2WorkflowForwardIncarnation = ReturnType<
  NonNullable<OpenWorkerdWorkerRuntimeOwnerOptions["v2WorkflowForward"]>["openIncarnation"]
>;

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

/** Host-local physical readback; SQL acceptance remains the caller's authority. */
export type WorkerdActorNativeGraphObservation =
  | {
      readonly kind: "ready";
      readonly sourceOperationId: string;
      readonly incarnationId: string;
      readonly script: string;
      readonly identity: WorkerdPublicationIdentity;
      readonly graph: WorkerdActiveActorGraph;
    }
  | { readonly kind: "unknown" };

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
  /** Operator-private, exact current Actor bytes; never a public Resource observation. */
  observeActorGraph(input: {
    readonly workerResourceUid: string;
    readonly targetKey: string;
    readonly sourceOperationId: string;
  }): Promise<WorkerdActorNativeGraphObservation>;
  /** Physical native graph only; accepted Operation/lease/refs must be checked by its caller. */
  observeActorGraphForAcceptedOperation(input: {
    readonly workerResourceUid: string;
    readonly targetKey: string;
    readonly sourceOperationId: string;
  }): Promise<WorkerdActorNativeGraphObservation>;
  /** Exact active code Version and private Service bridge for one Workflow run. */
  selectWorkflowExecution(input: {
    readonly workerUid: string;
    readonly targetKey: string;
    readonly servingSourceOperationId: string;
    readonly basisPoint: number;
  }): Promise<
    | { readonly kind: "unknown" }
    | {
        readonly kind: "selected";
        readonly sourceOperationId: string;
        readonly incarnationId: string;
        readonly selected: WorkerdSelectedActiveVersion<WorkerdSite>;
        stillCurrent(): Promise<boolean>;
        acquirePrivateServiceBindings(signal: AbortSignal): Promise<WorkerdPrivateServiceLease>;
      }
  >;
  /** Neutral exact native Version proof; SQL and binding authority remain with each caller. */
  observeVersionTarget(input: {
    readonly workerUid: string;
    readonly versionId: string;
    readonly incarnationId: string;
    readonly servingSourceOperationId: string;
  }): Promise<
    | {
        readonly kind: "confirmed";
        readonly workerUid: string;
        readonly versionId: string;
        readonly incarnationId: string;
        readonly servingSourceOperationId: string;
        readonly status: "active" | "draining";
      }
    | { readonly kind: "unknown" }
  >;
  /** Queue-specific live gate proof; Core owns SQL serving and receipt scope. */
  observeQueueTarget(input: {
    readonly workerUid: string;
    readonly versionId: string;
    readonly incarnationId: string;
    readonly servingSourceOperationId: string;
  }): ReturnType<WorkerdWorkerRuntimeOwner["observeVersionTarget"]>;
  /** Exact old physical Queue execution absence, never a logical Operation completion. */
  observeQueuePhysicalAbsence(input: {
    readonly workerUid: string;
    readonly incarnationId: string;
    readonly servingSourceOperationId: string;
  }): Promise<
    | {
        readonly kind: "confirmed_absent";
        readonly workerUid: string;
        readonly incarnationId: string;
        readonly servingSourceOperationId: string;
        readonly receiptDigest: string;
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
  /** One selected active incarnation, one SQL send authorization, one native Queue event. */
  invokeQueue(input: {
    readonly batchId: string;
    readonly workerUid: string;
    readonly consumerUid: string;
    readonly queueUid: string;
    readonly queueName: string;
    readonly generation: number;
    readonly servingSourceOperationId: string;
    readonly versions: readonly {
      readonly workerVersionUid: string;
      readonly generation: number;
      readonly weight: number;
    }[];
    readonly claims: readonly {
      readonly queueId: string;
      readonly consumerId: string;
      readonly generation: number;
      readonly leaseToken: string;
      readonly messageId: string;
      readonly body: Uint8Array;
      readonly enqueuedAtMillis: number;
      readonly attempts: number;
    }[];
    /** Trusted Host authority, never tenant code or an HTTP DTO. */
    mintCapability(grant: V2QueueDispatchGrant): string;
    /** SQL 0083 CAS. Only a new authorization may precede a send. */
    authorizeSend(target: {
      readonly workerVersionUid: string;
      readonly workerVersionGeneration: number;
      readonly incarnationOperationId: string;
    }): Promise<"authorized" | "already_authorized" | "unknown">;
    /** Host-private guarded SQL renewal; no tenant-visible completion/lease port. */
    renewLease(target: {
      readonly workerVersionUid: string;
      readonly workerVersionGeneration: number;
      readonly incarnationOperationId: string;
      readonly versionId: string;
    }): Promise<boolean>;
    /** Internal bounded cadence, normally 30s; test fixtures may compress time. */
    readonly renewalIntervalMillis: number;
    stillCurrent(): Promise<boolean>;
  }): Promise<
    | {
        readonly kind: "handler_resolved" | "handler_rejected";
        readonly workerVersionUid: string;
        readonly workerVersionGeneration: number;
        readonly incarnationOperationId: string;
        readonly receiptDigest: string;
      }
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
  /** Preaccept proof of the whole inspected, Queue-enabled current native graph. */
  observeQueueServingCapability(input: {
    readonly workerUid: string;
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
  }): ReturnType<WorkerdWorkerRuntimeOwner["observeScheduledCapability"]>;
  /** Release the owner lock only after every known incarnation has a durable receipt. */
  close(): Promise<void>;
  /** Host-private graceful stop: no DELETE, no retirement receipt, no lost custody. */
  suspend(): Promise<void>;
}

export interface OpenWorkerdWorkerRuntimeOwnerOptions {
  /** Private operator-owned root for this Worker UID. */
  readonly rootDirectory: string;
  readonly workerResourceUid: string;
  readonly targetKey: string;
  readonly publicationState: PublicationState;
  /** Exact per-incarnation private Workflow broker; no tenant-provided socket paths. */
  readonly v2WorkflowForward?: {
    openIncarnation(input: {
      readonly workerUid: string;
      readonly sourceOperationId: string;
      readonly scriptName: string;
      /** Persisted private owner credential, never exposed in tenant config. */
      readonly eventToken: string;
    }): {
      readonly workflowForwardLifecycle: WorkerdWorkflowForwardLifecycle;
      readonly workflowForwardSockets: (
        publications: readonly WorkerdWorkflowForwardPublication[],
      ) => readonly WorkerdWorkflowForwardSocket[];
      close(): Promise<void>;
    };
  };
  /** Exact Resource-owned configured input reader, shared with Version eligibility. */
  readonly configuredInputs?: V2CodeConfiguredInputReader;
  /** Boot-composed Host-private settlement plane; no tenant input or use-time fallback. */
  readonly v2QueueSettlement?: {
    readonly address: string;
    /** Exact boot-composed Core physical namespace codec. */
    queueIdForUid(queueUid: string): string;
    bindingToken(input: {
      readonly workerUid: string;
      readonly versionId: string;
      readonly servingSourceOperationId: string;
    }): string;
  };
  /** Trusted SQL-only facade boot seam; exact selected Version grants are minted during publication. */
  readonly v2SqliteBinding?: {
    readonly address: string;
    issueGrant(grant: V2SqliteBindingGrant): string;
    resolveCurrentBinding(
      claim: SQLiteWorkerBindingClaim,
      binding: string,
    ): Promise<{ readonly resourceUid: string; readonly vector: string } | null>;
  };
  /** Fixed Host-private object broker; never selected by a Worker Version. */
  readonly v2ObjectBucketBinding?: {
    readonly address: string;
    issueGrant(grant: V2ObjectBucketBindingGrant): string;
    resolveCurrentBucketBinding(
      claim: ObjectBucketWorkerBindingClaim,
      binding: string,
    ): Promise<ObjectBucketWorkerBindingResolution | null>;
  };
  /** Fixed Host-private KV broker and Core authority, shared by every incarnation. */
  readonly v2KvBinding?: {
    readonly address: string;
    issueGrant(grant: KvWorkerBindingClaim): string;
    resolveCurrentBinding(
      claim: KvWorkerBindingClaim,
      binding: string,
    ): Promise<{
      readonly identity: {
        readonly targetKey: string;
        readonly principal: string;
        readonly space: string;
        readonly resourceUid: string;
      };
      readonly vector: string;
    } | null>;
  };
  /** Fixed private Queue producer broker and Core authority, not handler settlement. */
  readonly v2QueueProducerBinding?: {
    readonly address: string;
    issueGrant(grant: QueueWorkerBindingClaim): string;
    resolveCurrentBinding(
      claim: QueueWorkerBindingClaim,
      binding: string,
    ): Promise<QueueWorkerBindingResolution | null>;
  };
  /** Parent-composed accepted-v2 Actor authority and physical host, one boot per incarnation. */
  readonly v2ActorForward?: {
    openIncarnation(source: {
      readonly workerUid: string;
      readonly sourceOperationId: string;
      readonly eventToken: string;
      readonly scriptName: string;
    }): {
      readonly actorForwardLifecycle: NonNullable<
        Parameters<typeof createWorkerdRuntime>[0]["actorForwardLifecycle"]
      >;
      actorForwardSockets(): readonly WorkerdActorForwardSocket[];
      readonly issueBinding: NonNullable<
        Parameters<typeof createV2WorkerPublication>[0]["v2ActorForward"]
      >["issueBinding"];
      close(): Promise<void>;
    };
  };
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

async function requireExactEntriesAfterRecoveryRace(
  path: string,
  expected: readonly string[],
): Promise<void> {
  const expectedSet = new Set(expected);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const actual = await readdir(path).catch(() => {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    });
    if (canonicalJson([...actual].sort()) === canonicalJson([...expected].sort())) return;
    // A competing process may have linked the old lock just as this process
    // replaced it. It must remove its own claim after noticing the new inode.
    // Never accept an incomplete namespace; wait only for named claims and
    // perform the same exact inventory check again before opening the owner.
    if (
      expected.some((name) => !actual.includes(name)) ||
      actual.some((name) => !expectedSet.has(name) && parseRecoveryClaimName(name) === null) ||
      attempt === 31
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    await Bun.sleep(10);
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
  const retirementPending = record.status === "draining" || record.status === "retiring";
  const allowed =
    retired || retirementPending
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
  recoveredFromStaleOwner = false,
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
  if (recoveredFromStaleOwner) await requireExactEntriesAfterRecoveryRace(directory, topLevel);
  else await requireExactEntries(directory, topLevel);
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
      (record.status === "active" ||
        record.status === "draining" ||
        record.status === "retiring") &&
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
    if (record.status !== "active" && record.status !== "draining" && record.status !== "retiring")
      continue;
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
      await requireSafeStateForNewOwner(snapshot, false, snapshot.state.suspended);
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

function physicalIncarnationId(operationId: string, identity: LinuxProcessIdentity): string {
  const bytes = createHash("sha256")
    .update("takoserver.v2-worker-physical-incarnation@1\0")
    .update(
      JSON.stringify([
        operationId,
        identity.pid,
        identity.bootId,
        identity.pidNamespace,
        identity.startTimeTicks,
      ]),
    )
    .digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function physicalAbsenceDigest(input: Omit<PhysicalIncarnationAbsence, "receiptDigest">): string {
  return createHash("sha256")
    .update("takoserver.v2-worker-physical-absence@1\0")
    .update(canonicalJson(input))
    .digest("hex");
}

function physicalAbsenceFor(record: IncarnationRecord): PhysicalIncarnationAbsence {
  if (!record.processIdentity || !record.configurationSha256) {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }
  const fields = {
    operationId: record.operationId,
    incarnationId: physicalIncarnationId(record.operationId, record.processIdentity),
    processIdentity: record.processIdentity,
    listenerPort: record.listenerPort,
    configurationSha256: record.configurationSha256,
  };
  return { ...fields, receiptDigest: physicalAbsenceDigest(fields) };
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
    suspended: false,
    physicalAbsences: [],
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
    const currentState = state.schema === STATE_SCHEMA || state.schema === EVENT_TOKEN_STATE_SCHEMA;
    const suspendState = state.schema === STATE_SCHEMA;
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
      !Array.isArray(state.incarnations) ||
      (suspendState
        ? typeof state.suspended !== "boolean" || !Array.isArray(state.physicalAbsences)
        : state.suspended !== undefined || state.physicalAbsences !== undefined)
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
    const physicalAbsences: PhysicalIncarnationAbsence[] = [];
    if (suspendState) {
      const seen = new Set<string>();
      for (const raw of state.physicalAbsences as unknown[]) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
        const item = raw as Record<string, unknown>;
        if (
          Object.keys(item).sort().join(",") !==
            "configurationSha256,incarnationId,listenerPort,operationId,processIdentity,receiptDigest" ||
          typeof item.operationId !== "string" ||
          !OPERATION_ID.test(item.operationId) ||
          typeof item.incarnationId !== "string" ||
          !OPERATION_ID.test(item.incarnationId) ||
          !validLinuxProcessIdentityRecord(item.processIdentity) ||
          !Number.isSafeInteger(item.listenerPort) ||
          typeof item.configurationSha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(item.configurationSha256) ||
          typeof item.receiptDigest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(item.receiptDigest) ||
          seen.has(item.incarnationId) ||
          !incarnations.some((record) => record.operationId === item.operationId) ||
          physicalIncarnationId(item.operationId, item.processIdentity) !== item.incarnationId ||
          physicalAbsenceDigest({
            operationId: item.operationId,
            incarnationId: item.incarnationId,
            processIdentity: item.processIdentity,
            listenerPort: item.listenerPort as number,
            configurationSha256: item.configurationSha256,
          }) !== item.receiptDigest
        )
          throw new Error();
        seen.add(item.incarnationId);
        physicalAbsences.push(item as unknown as PhysicalIncarnationAbsence);
      }
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
      suspended: suspendState ? (state.suspended as boolean) : false,
      physicalAbsences,
      incarnations,
    };
    const activeRecords = incarnations.filter((item) => item.status === "active");
    if (
      (state.admissionClosedBy === null && state.deletionPublicationConfirmed) ||
      (result.suspended && !recoverableIncarnationSet(result)) ||
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
                  : state.schema === EVENT_TOKEN_STATE_SCHEMA
                    ? {
                        schema: EVENT_TOKEN_STATE_SCHEMA,
                        workerResourceUid: result.workerResourceUid,
                        activeOperationId: result.activeOperationId,
                        admissionClosedBy: result.admissionClosedBy,
                        deletionPublicationConfirmed: result.deletionPublicationConfirmed,
                        endpointRouteAbsence: result.endpointRouteAbsence,
                        incarnations: result.incarnations,
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
  if (
    options.v2QueueSettlement !== undefined &&
    (typeof options.v2QueueSettlement.bindingToken !== "function" ||
      typeof options.v2QueueSettlement.queueIdForUid !== "function" ||
      !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(options.v2QueueSettlement.address) ||
      Number(
        options.v2QueueSettlement.address.slice(
          options.v2QueueSettlement.address.lastIndexOf(":") + 1,
        ),
      ) > 65_535)
  ) {
    throw new WorkerdWorkerRuntimeOwnerError("invalid_identity");
  }
  if (
    options.v2SqliteBinding !== undefined &&
    (typeof options.v2SqliteBinding.issueGrant !== "function" ||
      typeof options.v2SqliteBinding.resolveCurrentBinding !== "function" ||
      !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(options.v2SqliteBinding.address) ||
      Number(
        options.v2SqliteBinding.address.slice(options.v2SqliteBinding.address.lastIndexOf(":") + 1),
      ) > 65_535)
  ) {
    throw new WorkerdWorkerRuntimeOwnerError("invalid_identity");
  }
  if (
    options.v2ObjectBucketBinding !== undefined &&
    (typeof options.v2ObjectBucketBinding.issueGrant !== "function" ||
      typeof options.v2ObjectBucketBinding.resolveCurrentBucketBinding !== "function" ||
      !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(options.v2ObjectBucketBinding.address) ||
      Number(
        options.v2ObjectBucketBinding.address.slice(
          options.v2ObjectBucketBinding.address.lastIndexOf(":") + 1,
        ),
      ) > 65_535)
  ) {
    throw new WorkerdWorkerRuntimeOwnerError("invalid_identity");
  }
  const v2ObjectBucketBinding = options.v2ObjectBucketBinding
    ? Object.freeze({
        address: options.v2ObjectBucketBinding.address,
        issueGrant: options.v2ObjectBucketBinding.issueGrant.bind(options.v2ObjectBucketBinding),
        resolveCurrentBucketBinding: options.v2ObjectBucketBinding.resolveCurrentBucketBinding.bind(
          options.v2ObjectBucketBinding,
        ),
      })
    : undefined;
  if (
    options.v2KvBinding !== undefined &&
    (typeof options.v2KvBinding.issueGrant !== "function" ||
      typeof options.v2KvBinding.resolveCurrentBinding !== "function" ||
      !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(options.v2KvBinding.address) ||
      Number(options.v2KvBinding.address.slice(options.v2KvBinding.address.lastIndexOf(":") + 1)) >
        65_535)
  ) {
    throw new WorkerdWorkerRuntimeOwnerError("invalid_identity");
  }
  const v2KvBinding = options.v2KvBinding
    ? Object.freeze({
        address: options.v2KvBinding.address,
        issueGrant: options.v2KvBinding.issueGrant.bind(options.v2KvBinding),
        resolveCurrentBinding: options.v2KvBinding.resolveCurrentBinding.bind(options.v2KvBinding),
      })
    : undefined;
  if (
    options.v2QueueProducerBinding !== undefined &&
    (typeof options.v2QueueProducerBinding.issueGrant !== "function" ||
      typeof options.v2QueueProducerBinding.resolveCurrentBinding !== "function" ||
      !/^(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(options.v2QueueProducerBinding.address) ||
      Number(
        options.v2QueueProducerBinding.address.slice(
          options.v2QueueProducerBinding.address.lastIndexOf(":") + 1,
        ),
      ) > 65_535)
  )
    throw new WorkerdWorkerRuntimeOwnerError("invalid_identity");
  const v2QueueProducerBinding = options.v2QueueProducerBinding
    ? Object.freeze({
        address: options.v2QueueProducerBinding.address,
        issueGrant: options.v2QueueProducerBinding.issueGrant.bind(options.v2QueueProducerBinding),
        resolveCurrentBinding: options.v2QueueProducerBinding.resolveCurrentBinding.bind(
          options.v2QueueProducerBinding,
        ),
      })
    : undefined;

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

  // Linux's Unix-domain path limit excludes the ordinary (possibly very long)
  // execution-copy root. This namespace is deterministic only within the exact
  // owner lock; a pre-existing path is never adopted for a new incarnation.
  const privateSocketDirectoryFor = (operationId: string): string =>
    join(
      "/tmp",
      `tw-${createHash("sha256")
        .update(canonicalRoot)
        .update("\u0000")
        .update(options.workerResourceUid)
        .update("\u0000")
        .update(operationId)
        .digest("hex")
        .slice(0, 20)}`,
    );
  const verifyPrivateSocketDirectory = async (path: string): Promise<void> => {
    const info = await lstat(path).catch(() => null);
    if (
      !info?.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(path)) !== path
    )
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  };
  const preparePrivateSockets = async (
    operationId: string,
    recoveryConfiguration?: Uint8Array,
  ): Promise<string> => {
    const path = privateSocketDirectoryFor(operationId);
    if (recoveryConfiguration === undefined) {
      await mkdir(path, { mode: 0o700 }).catch(() => {
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      });
    } else {
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    await verifyPrivateSocketDirectory(path);
    const entries = await readdir(path);
    if (recoveryConfiguration !== undefined) {
      const config = new TextDecoder().decode(recoveryConfiguration);
      for (const entry of entries) {
        const socket = join(path, entry);
        const info = await lstat(socket).catch(() => null);
        if (
          !PRIVATE_SOCKET_NAME.test(entry) ||
          !config.includes(`address = "unix:${socket}"`) ||
          !info?.isSocket() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.()
        )
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
      // The recorded child was already proved absent by recovery. Remove only
      // its exact config-declared socket files before a new runtime pins them.
      for (const entry of entries) await unlink(join(path, entry));
    } else if (entries.length !== 0) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    return path;
  };
  const releasePrivateSockets = async (
    operationId: string,
    configuration: Uint8Array,
  ): Promise<void> => {
    const path = privateSocketDirectoryFor(operationId);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return; // Legacy incarnations had no private Service namespace.
    await verifyPrivateSocketDirectory(path);
    const config = new TextDecoder().decode(configuration);
    for (const entry of await readdir(path)) {
      const socket = join(path, entry);
      const socketInfo = await lstat(socket).catch(() => null);
      if (
        !PRIVATE_SOCKET_NAME.test(entry) ||
        !config.includes(`address = "unix:${socket}"`) ||
        !socketInfo?.isSocket() ||
        socketInfo.isSymbolicLink() ||
        socketInfo.uid !== process.getuid?.()
      )
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      await unlink(socket);
    }
    await rmdir(path);
  };

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
    await verifyOwnerNamespace(
      directory,
      state,
      options.workerResourceUid,
      ownerLock.recoveredFromStaleOwner,
    );
    const hasServingIncarnations = state.incarnations.some(
      (item) => item.status === "active" || item.status === "draining",
    );
    if (
      (state.endpointRouteAbsence !== null &&
        state.endpointRouteAbsence.targetKey !== options.targetKey) ||
      (hasServingIncarnations &&
        (!(ownerLock.recoveredFromStaleOwner || state.suspended) ||
          !recoverableIncarnationSet(state))) ||
      state.incarnations.some(
        (item) =>
          item.status !== "retired" &&
          !(
            ((item.status === "retiring" || item.status === "uncertain") &&
              item.retirementOperationId !== null) ||
            ((ownerLock.recoveredFromStaleOwner || state.suspended) &&
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
  let suspending = false;

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

  const persistPhysicalAbsence = async (
    record: IncarnationRecord,
    successorIdentity?: LinuxProcessIdentity,
  ): Promise<void> => {
    if (!record.processIdentity || (await linuxProcessLiveness(record.processIdentity)) !== "stale")
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const listener = await workerPortOwnership(record.listenerPort, undefined);
    if (
      listener !== "vacant" &&
      (!successorIdentity ||
        (await linuxProcessLiveness(successorIdentity)) !== "live" ||
        (await workerPortOwnership(record.listenerPort, successorIdentity.pid)) !== "owned")
    )
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    const receipt = physicalAbsenceFor(record);
    await transitionState((current) => {
      const exact = current.incarnations.find((item) => item.operationId === record.operationId);
      if (!exact || canonicalJson(exact) !== canonicalJson(record))
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      const existing = current.physicalAbsences.find(
        (item) => item.incarnationId === receipt.incarnationId,
      );
      if (existing && canonicalJson(existing) !== canonicalJson(receipt))
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      return existing
        ? current
        : { ...current, physicalAbsences: [...current.physicalAbsences, receipt] };
    });
  };

  const persistPhysicalAbsences = async (suspended: boolean): Promise<void> => {
    if (!recoverableIncarnationSet(state))
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    await requireStaleIncarnationChildrenAndVacantListeners(state);
    const nextAbsences = [...state.physicalAbsences];
    for (const record of state.incarnations) {
      if (
        record.status !== "active" &&
        record.status !== "draining" &&
        record.status !== "retiring"
      )
        continue;
      const receipt = physicalAbsenceFor(record);
      const prior = nextAbsences.find((item) => item.incarnationId === receipt.incarnationId);
      if (prior && canonicalJson(prior) !== canonicalJson(receipt))
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      if (!prior) nextAbsences.push(receipt);
    }
    await transitionState((current) => ({
      ...current,
      suspended,
      physicalAbsences: nextAbsences,
    }));
  };

  // Retired receipts outlive their publisher process. Retry physical-copy
  // cleanup under this owner's lock before exposing any replay/observation API.
  // A still-active successor finishes its retiring predecessor only after the
  // exact current SQL graph is resolved below; do not mistake it for a
  // standalone completed retirement here.
  const recoveringActive =
    (ownerLock.recoveredFromStaleOwner || state.suspended) &&
    state.incarnations.some((item) => item.status === "active");
  try {
    for (const record of [...state.incarnations]) {
      if (
        record.status === "active" ||
        record.status === "draining" ||
        (recoveringActive && record.status === "retiring")
      )
        continue;
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
        if (record.status === "retiring" && record.processIdentity) {
          await persistPhysicalAbsence(record);
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
      !suspending &&
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
        // A Workflow child may still be using an exact private Service socket.
        // Do not stop its upstream or release the socket namespace until the
        // caller's lease has completed; no elapsed timeout proves retirement.
        await Promise.all([...incarnation.workflowLeases]);
        const receipt = await incarnation.group.retire({
          workerResourceUid: options.workerResourceUid,
          operationId,
        });
        // No private Actor broker may outlive the child whose immutable graph
        // carried its token. A failed drain retains this UID's owner lock.
        await incarnation.actorForward?.close();
        await incarnation.workflowForward?.close();
        await persistPhysicalAbsence(incarnation.record);
        await releasePrivateSockets(
          incarnation.record.operationId,
          await readFile(incarnation.group.configurationPath),
        );
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
      if (suspending) return;
      void cancelInvocations(incarnation)
        .then(() => {
          if (!suspending) return retireIncarnation(incarnation);
        })
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
    const actorForward =
      options.v2ActorForward && record.eventToken
        ? options.v2ActorForward.openIncarnation({
            workerUid: options.workerResourceUid,
            sourceOperationId: record.operationId,
            eventToken: record.eventToken,
            scriptName: scriptName(options.workerResourceUid),
          })
        : undefined;
    const workflowForward =
      options.v2WorkflowForward && record.eventToken
        ? options.v2WorkflowForward.openIncarnation({
            workerUid: options.workerResourceUid,
            sourceOperationId: record.operationId,
            scriptName: scriptName(options.workerResourceUid),
            eventToken: record.eventToken,
          })
        : undefined;
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
      serviceBindingSocketDirectory: privateSocketDirectoryFor(record.operationId),
      ...(workflowForward
        ? {
            workflowForwardLifecycle: workflowForward.workflowForwardLifecycle,
            workflowForwardSockets: workflowForward.workflowForwardSockets,
          }
        : {}),
      ...(actorForward
        ? {
            actorForwardLifecycle: actorForward.actorForwardLifecycle,
            actorForwardSockets: actorForward.actorForwardSockets,
          }
        : {}),
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
      ...(options.v2QueueSettlement ? { v2QueueSettlement: options.v2QueueSettlement } : {}),
      ...(options.v2SqliteBinding ? { v2SqliteBinding: options.v2SqliteBinding } : {}),
      ...(v2ObjectBucketBinding ? { v2ObjectBucketBinding } : {}),
      ...(v2KvBinding ? { v2KvBinding } : {}),
      ...(v2QueueProducerBinding ? { v2QueueProducerBinding } : {}),
      ...(actorForward ? { v2ActorForward: actorForward } : {}),
      ...(record.eventToken === null ? {} : { scheduledEventToken: record.eventToken }),
    });
    const handle: IncarnationHandle = {
      record,
      group,
      runtime,
      publication,
      ...(actorForward ? { actorForward } : {}),
      ...(workflowForward ? { workflowForward } : {}),
      invocations: new Set(),
      workflowLeases: new Set(),
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
    if (
      spawningRecord?.processIdentity &&
      canonicalJson(spawningRecord.processIdentity) !== canonicalJson(processIdentity)
    ) {
      // A supervisor may replace a crashed child without a Host restart. Its
      // old Queue execution must be absent before this exact record is repinned
      // to the new PID, whether the listener is vacant or already owned by the
      // new child. A live/unknown old birth never permits this transition.
      await persistPhysicalAbsence(spawningRecord, processIdentity);
    }
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
    await preparePrivateSockets(operationId);
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
    // Preserve the pre-publication supervised child start. This bootstrap has
    // no publication authority or private Service sockets: a failed initial
    // spawn cannot poison the candidate's still-unused socket-enabled runtime.
    // The latter remains the sole runtime that can publish tenant bytes.
    const bootstrap = createWorkerdRuntime({
      root: group.runtimeRoot,
      configPath: group.configurationPath,
      port: listenerPort,
      binary: options.workerdBinary,
      onReload: async (configPath) => {
        if (configPath !== group.configurationPath)
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        await group.reloadConfiguration();
      },
      isReady: () => group.isReady(),
    });
    await bootstrap.reload();
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

  const finishRecoveredPredecessorRetirement = async (record: IncarnationRecord): Promise<void> => {
    if (
      (record.status !== "draining" && record.status !== "retiring") ||
      !record.retirementOperationId ||
      !record.processIdentity ||
      (await linuxProcessLiveness(record.processIdentity)) !== "stale" ||
      (await workerPortOwnership(record.listenerPort, undefined)) !== "vacant"
    ) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
    await persistPhysicalAbsence(record);
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
    await releasePrivateSockets(record.operationId, configuration);
    const verified = await verifyRetiredWorkerdWorkerExecutionCopies({
      groupDirectory,
      workerResourceUid: options.workerResourceUid,
      operationId,
      listenerPort: record.listenerPort,
      scriptName: scriptName(options.workerResourceUid),
    });
    if (
      (record.receipt && canonicalJson(record.receipt) !== canonicalJson(verified.receipt)) ||
      !executionCopiesMatchRecord(record, verified.copies, true)
    ) {
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
    // An old Queue grant may remain send-authorized. Record exact physical
    // absence before restore can replace the active record's process identity.
    await persistPhysicalAbsences(state.suspended);
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
      if (record.status === "draining" || record.status === "retiring") {
        await finishRecoveredPredecessorRetirement(record);
      }
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
    await preparePrivateSockets(activeRecord.operationId, configuration);
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
    if (state.suspended) {
      await transitionState((current) => ({ ...current, suspended: false }));
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
      suspending ||
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
      if (closed || suspending) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
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
        suspending ||
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
        suspending ||
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

  const observeActorGraphPhysical = async (
    input: {
      readonly workerResourceUid: string;
      readonly targetKey: string;
      readonly sourceOperationId: string;
    },
    requireSqlCurrentness: boolean,
  ): Promise<WorkerdActorNativeGraphObservation> => {
    const unknown = { kind: "unknown" } as const;
    // Capture caller-owned fields before any serial-lane wait or SQL/native await.
    const target = {
      workerResourceUid: input.workerResourceUid,
      targetKey: input.targetKey,
      sourceOperationId: input.sourceOperationId,
    };
    const source = requireSqlCurrentness
      ? options.publicationState.resolveCurrentServing
      : undefined;
    if (
      (requireSqlCurrentness && !source) ||
      target.workerResourceUid !== options.workerResourceUid ||
      target.targetKey !== options.targetKey ||
      !OPERATION_ID.test(target.sourceOperationId)
    )
      return unknown;

    // The SQL/held-byte resolver must run outside the owner serial lane. Its
    // currentness callback may itself consult the owner in a binding path.
    const captured = await runSerial(async () => {
      const incarnation = active;
      const record = recordFor(target.sourceOperationId);
      if (
        closed ||
        suspending ||
        admissionClosedBy !== null ||
        !incarnation ||
        state.activeOperationId !== target.sourceOperationId ||
        incarnation.record.operationId !== target.sourceOperationId ||
        record?.status !== "active" ||
        !record.processIdentity ||
        !record.configurationSha256 ||
        record.configurationRefreshPending ||
        record.configurationSha256 !== incarnation.group.configurationSha256 ||
        !record.identity ||
        record.identity.workerResourceUid !== options.workerResourceUid ||
        sourceOperationIdFromIdentity(record.identity) !== target.sourceOperationId ||
        !incarnation.group.isReady()
      )
        return null;
      return {
        recordKey: canonicalJson(record),
        identity: structuredClone(record.identity),
        incarnationId: physicalIncarnationId(target.sourceOperationId, record.processIdentity),
      };
    });
    if (!captured) return unknown;

    const resolution = source
      ? await source({
          workerUid: target.workerResourceUid,
          targetKey: target.targetKey,
          sourceOperationId: target.sourceOperationId,
          expectedIdentity: captured.identity,
        }).catch(() => null)
      : null;
    const sqlCurrent = async (): Promise<boolean> =>
      !requireSqlCurrentness ||
      (resolution?.kind === "ready" && (await resolution.stillCurrent().catch(() => false)));
    if (
      (requireSqlCurrentness &&
        (resolution?.kind !== "ready" ||
          resolution.snapshot.sourceOperationId !== target.sourceOperationId ||
          resolution.snapshot.worker.uid !== target.workerResourceUid ||
          !resolution.snapshot.deployment)) ||
      !(await sqlCurrent())
    )
      return unknown;

    const currentOwner = () => {
      const incarnation = active;
      const record = recordFor(target.sourceOperationId);
      return !closed &&
        !suspending &&
        admissionClosedBy === null &&
        incarnation?.record.operationId === target.sourceOperationId &&
        state.activeOperationId === target.sourceOperationId &&
        record?.status === "active" &&
        canonicalJson(record) === captured.recordKey &&
        incarnation.group.isReady()
        ? { incarnation, record }
        : null;
    };
    const graph = await runSerial(async () => {
      const current = currentOwner();
      if (!current) return null;
      const { incarnation, record } = current;
      const processIdentity = record.processIdentity;
      if (!processIdentity) return null;
      const copies = await inspectWorkerdWorkerExecutionCopies({
        groupDirectory: incarnation.group.runtimeRoot,
        workerResourceUid: target.workerResourceUid,
        listenerPort: record.listenerPort,
        scriptName: scriptName(target.workerResourceUid),
      }).catch(() => null);
      if (
        !copies ||
        !executionCopiesMatchRecord(record, copies, true) ||
        captured.identity.versions.some(
          (version) => !copies.versionUids.includes(version.workerVersionUid),
        ) ||
        (await incarnation.runtime.observeExactPublication?.(
          scriptName(target.workerResourceUid),
          captured.identity,
        )) !== "matches" ||
        (await linuxProcessLiveness(processIdentity).catch(() => "unknown")) !== "live" ||
        (await workerPortOwnership(record.listenerPort, processIdentity.pid).catch(
          () => "foreign",
        )) !== "owned" ||
        (await linuxProcessLiveness(processIdentity).catch(() => "unknown")) !== "live"
      )
        return null;
      const native = await readWorkerdActiveActorGraph(
        incarnation.group.runtimeRoot,
        scriptName(target.workerResourceUid),
        target.workerResourceUid,
      ).catch(() => null);
      if (
        !native ||
        native.generation !== captured.identity.generation ||
        canonicalJson(
          native.versions.map(({ versionId, workerVersionUid, weight }) => ({
            versionId,
            workerVersionUid,
            weight,
          })),
        ) !== canonicalJson(captured.identity.versions) ||
        !currentOwner()
      )
        return null;
      return native;
    });
    if (!graph || !(await sqlCurrent())) return unknown;
    const finalOwner = await runSerial(async () => {
      const current = currentOwner();
      const processIdentity = current?.record.processIdentity;
      return (
        current &&
        processIdentity &&
        (await current.incarnation.runtime.observeExactPublication?.(
          scriptName(target.workerResourceUid),
          captured.identity,
        )) === "matches" &&
        (await linuxProcessLiveness(processIdentity).catch(() => "unknown")) === "live" &&
        (await workerPortOwnership(current.record.listenerPort, processIdentity.pid).catch(
          () => "foreign",
        )) === "owned" &&
        (await linuxProcessLiveness(processIdentity).catch(() => "unknown")) === "live" &&
        currentOwner() !== null
      );
    });
    if (!finalOwner || !(await sqlCurrent())) return unknown;
    return {
      kind: "ready",
      sourceOperationId: target.sourceOperationId,
      incarnationId: captured.incarnationId,
      script: scriptName(target.workerResourceUid),
      identity: captured.identity,
      graph,
    };
  };

  const observeActorGraph: WorkerdWorkerRuntimeOwner["observeActorGraph"] = (input) =>
    observeActorGraphPhysical(input, true);
  const observeActorGraphForAcceptedOperation: WorkerdWorkerRuntimeOwner["observeActorGraphForAcceptedOperation"] =
    (input) => observeActorGraphPhysical(input, false);

  const selectWorkflowExecution: WorkerdWorkerRuntimeOwner["selectWorkflowExecution"] = async (
    input,
  ) => {
    const unknown = { kind: "unknown" } as const;
    const target = {
      workerUid: input.workerUid,
      targetKey: input.targetKey,
      servingSourceOperationId: input.servingSourceOperationId,
      basisPoint: input.basisPoint,
    };
    const source = options.publicationState.resolveCurrentServing;
    if (
      !source ||
      target.workerUid !== options.workerResourceUid ||
      target.targetKey !== options.targetKey ||
      !OPERATION_ID.test(target.servingSourceOperationId) ||
      !Number.isSafeInteger(target.basisPoint) ||
      target.basisPoint < 0 ||
      target.basisPoint >= 10_000
    )
      return unknown;
    const captured = await runSerial(async () => {
      const incarnation = active;
      const record = recordFor(target.servingSourceOperationId);
      if (
        closed ||
        suspending ||
        admissionClosedBy !== null ||
        !incarnation ||
        state.activeOperationId !== target.servingSourceOperationId ||
        incarnation.record.operationId !== target.servingSourceOperationId ||
        record?.status !== "active" ||
        !record.processIdentity ||
        !record.configurationSha256 ||
        record.configurationRefreshPending ||
        record.configurationSha256 !== incarnation.group.configurationSha256 ||
        !record.identity ||
        record.identity.workerResourceUid !== target.workerUid ||
        sourceOperationIdFromIdentity(record.identity) !== target.servingSourceOperationId ||
        !incarnation.group.isReady()
      )
        return null;
      return {
        incarnation,
        recordKey: canonicalJson(record),
        identity: structuredClone(record.identity),
        incarnationId: physicalIncarnationId(record.operationId, record.processIdentity),
      };
    });
    if (!captured) return unknown;
    // Never hold the owner serial lane while the accepted SQL/held-byte reader
    // runs: a Binding reader may itself consult this owner.
    const resolution = await source({
      workerUid: target.workerUid,
      targetKey: target.targetKey,
      sourceOperationId: target.servingSourceOperationId,
      expectedIdentity: captured.identity,
    }).catch(() => null);
    if (
      resolution?.kind !== "ready" ||
      resolution.snapshot.sourceOperationId !== target.servingSourceOperationId ||
      resolution.snapshot.worker.uid !== target.workerUid ||
      !resolution.snapshot.deployment
    )
      return unknown;
    let weighted: ReturnType<typeof selectSelfhostWeightedVersion>;
    try {
      weighted = selectSelfhostWeightedVersion(captured.identity.versions, target.basisPoint);
    } catch {
      return unknown;
    }
    const version = resolution.snapshot.deployment.versions.find(
      (item) => item.uid === weighted.workerVersionUid && item.weight === weighted.weight,
    );
    if (
      !version ||
      resolution.snapshot.deployment.versions.length !== captured.identity.versions.length
    )
      return unknown;
    const expectedVersionId = `v2-${createHash("sha256")
      .update(`${version.uid}\u0000${version.generation}`)
      .digest("hex")}`;
    if (weighted.versionId !== expectedVersionId || !version.spec.bundle) return unknown;
    const materials = await resolution.readVersionMaterials?.(version.uid).catch(() => null);
    const bundle = materials?.bundle;
    if (!bundle || !(await resolution.stillCurrent().catch(() => false))) return unknown;
    const currentOwner = () => {
      const incarnation = active;
      const record = recordFor(target.servingSourceOperationId);
      return !closed &&
        !suspending &&
        admissionClosedBy === null &&
        incarnation === captured.incarnation &&
        state.activeOperationId === target.servingSourceOperationId &&
        record?.status === "active" &&
        canonicalJson(record) === captured.recordKey &&
        incarnation.group.isReady()
        ? { incarnation, record }
        : null;
    };
    const script = scriptName(target.workerUid);
    const readNative = async (): Promise<WorkerdSelectedActiveVersion<WorkerdSite> | null> => {
      const current = currentOwner();
      const processIdentity = current?.record.processIdentity;
      if (!current || !processIdentity) return null;
      const copies = await inspectWorkerdWorkerExecutionCopies({
        groupDirectory: current.incarnation.group.runtimeRoot,
        workerResourceUid: target.workerUid,
        listenerPort: current.record.listenerPort,
        scriptName: script,
      }).catch(() => null);
      if (
        !copies ||
        !executionCopiesMatchRecord(current.record, copies, true) ||
        !copies.versionUids.includes(version.uid) ||
        (await current.incarnation.runtime.observeExactPublication?.(script, captured.identity)) !==
          "matches" ||
        (await linuxProcessLiveness(processIdentity).catch(() => "unknown")) !== "live" ||
        (await workerPortOwnership(current.record.listenerPort, processIdentity.pid).catch(
          () => "foreign",
        )) !== "owned"
      )
        return null;
      const selected = await readWorkerdSelectedActiveVersion(
        current.incarnation.group.runtimeRoot,
        script,
        { expectedWorkerResourceUid: target.workerUid, basisPoint: target.basisPoint },
      ).catch(() => null);
      if (
        !selected ||
        selected.generation !== captured.identity.generation ||
        selected.workerResourceUid !== target.workerUid ||
        selected.workerVersionUid !== version.uid ||
        selected.versionId !== expectedVersionId ||
        selected.site.workerResourceUid !== target.workerUid ||
        selected.site.generation !== captured.identity.generation ||
        selected.modules.size < bundle.manifest.files.length ||
        bundle.manifest.files.some((file, index) => {
          const bytes = selected.modules.get(file.path);
          return !bytes || !Buffer.from(bytes).equals(Buffer.from(bundle.files[index] ?? []));
        }) ||
        (materials.assets !== null &&
          (selected.assets === undefined ||
            materials.assets.manifest.files.some((file, index) => {
              const bytes = selected.assets?.get(file.path);
              return (
                !bytes ||
                !Buffer.from(bytes).equals(Buffer.from(materials.assets?.files[index] ?? []))
              );
            }))) ||
        !currentOwner()
      )
        return null;
      return selected;
    };
    const selected = await runSerial(readNative);
    if (!selected || !(await resolution.stillCurrent().catch(() => false))) return unknown;
    const selectedKey = createHash("sha256")
      .update(canonicalJson(selected.site as unknown as Record<string, unknown>))
      .update(selected.generationKey)
      .update(
        [...selected.modules, ...selected.hostModules]
          .map(([path, bytes]) => `${path}:${createHash("sha256").update(bytes).digest("hex")}`)
          .join("\u0000"),
      )
      .digest("hex");
    const stillCurrent = async (): Promise<boolean> => {
      if (!(await resolution.stillCurrent().catch(() => false))) return false;
      // A physical retirement may be waiting for this Workflow's lease while
      // it owns the serial lane. This observer is read-only and rechecks the
      // captured owner record after every await, so it must not queue behind
      // the retirement that the caller's eventual release will unblock.
      const current = await readNative().catch(() => null);
      if (!current) return false;
      const key = createHash("sha256")
        .update(canonicalJson(current.site as unknown as Record<string, unknown>))
        .update(current.generationKey)
        .update(
          [...current.modules, ...current.hostModules]
            .map(([path, bytes]) => `${path}:${createHash("sha256").update(bytes).digest("hex")}`)
            .join("\u0000"),
        )
        .digest("hex");
      return key === selectedKey && (await resolution.stillCurrent().catch(() => false));
    };
    if (!(await stillCurrent())) return unknown;
    const held: WorkerdSelectedActiveVersion<WorkerdSite> = {
      ...selected,
      site: structuredClone(selected.site),
      modules: new Map([...selected.modules].map(([path, bytes]) => [path, new Uint8Array(bytes)])),
      hostModules: new Map(
        [...selected.hostModules].map(([path, bytes]) => [path, new Uint8Array(bytes)]),
      ),
      ...(selected.assets
        ? {
            assets: new Map(
              [...selected.assets].map(([path, bytes]) => [path, new Uint8Array(bytes)]),
            ),
          }
        : {}),
    };
    return {
      kind: "selected",
      sourceOperationId: target.servingSourceOperationId,
      incarnationId: captured.incarnationId,
      selected: held,
      stillCurrent,
      async acquirePrivateServiceBindings(signal) {
        signal.throwIfAborted();
        if (!(await stillCurrent())) throw new WorkerdWorkerRuntimeOwnerError("not_serving");
        const lease = await captured.incarnation.runtime.acquirePrivateServiceBindings(
          {
            script,
            generation: selected.generation,
            generationKey: selected.generationKey,
            workerResourceUid: selected.workerResourceUid,
            versionId: selected.versionId,
            workerVersionUid: selected.workerVersionUid,
          },
          signal,
        );
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const registered = await runSerial(async () => {
          if (!currentOwner()) return false;
          captured.incarnation.workflowLeases.add(done);
          return true;
        });
        // The pin can block retirement inside the serial lane. Do not call
        // stillCurrent() (which re-enters that lane) until after releasing it.
        // SQL remains outside the lane; the final owner check is synchronous.
        if (
          !registered ||
          !(await resolution.stillCurrent().catch(() => false)) ||
          !currentOwner() ||
          signal.aborted
        ) {
          await lease.release();
          if (registered) {
            captured.incarnation.workflowLeases.delete(done);
            finish();
          }
          throw new WorkerdWorkerRuntimeOwnerError("not_serving");
        }
        let released = false;
        return {
          services: lease.services,
          async release() {
            if (released) return;
            await lease.release();
            released = true;
            captured.incarnation.workflowLeases.delete(done);
            finish();
          },
        };
      },
    };
  };

  const observeVersionTargetCore = (
    input: Parameters<WorkerdWorkerRuntimeOwner["observeVersionTarget"]>[0],
    requireEventToken: boolean,
  ): ReturnType<WorkerdWorkerRuntimeOwner["observeVersionTarget"]> => {
    // Capture caller-owned input before waiting for the serial lane or I/O.
    const target = {
      workerUid: input.workerUid,
      versionId: input.versionId,
      incarnationId: input.incarnationId,
      servingSourceOperationId: input.servingSourceOperationId,
    };
    const operationId = requireEventToken ? target.servingSourceOperationId : target.incarnationId;
    return runSerial(async () => {
      const unknown = { kind: "unknown" } as const;
      if (
        closed ||
        suspending ||
        admissionClosedBy !== null ||
        target.workerUid !== options.workerResourceUid ||
        !OPERATION_ID.test(target.incarnationId) ||
        !OPERATION_ID.test(operationId) ||
        target.servingSourceOperationId !== operationId
      ) {
        return unknown;
      }
      const incarnation = handles.get(operationId);
      const record = recordFor(operationId);
      const identity = record?.identity;
      if (
        !incarnation ||
        !record ||
        (record.status !== "active" && record.status !== "draining") ||
        record.receipt !== null ||
        record.executionCopiesCleanupStarted ||
        record.executionCopiesReleased ||
        (requireEventToken && !record.eventToken) ||
        !record.processIdentity ||
        (requireEventToken &&
          physicalIncarnationId(operationId, record.processIdentity) !== target.incarnationId) ||
        !record.configurationSha256 ||
        record.configurationRefreshPending ||
        record.configurationSha256 !== incarnation.group.configurationSha256 ||
        canonicalJson(incarnation.record) !== canonicalJson(record) ||
        !identity ||
        identity.workerResourceUid !== options.workerResourceUid ||
        identity.generation !== expectedOperationMarker(operationId) ||
        !identity.versions.some((version) => version.versionId === target.versionId) ||
        !incarnation.group.isReady() ||
        (record.status === "active"
          ? active !== incarnation || state.activeOperationId !== operationId
          : active === incarnation ||
            state.activeOperationId === operationId ||
            record.retireAtMs === null ||
            record.retireAtMs <= Date.now())
      ) {
        return unknown;
      }

      // Only an installed handle that passed publication/recovery can reach this
      // status. This is live owner/child possession, not a fresh artifact
      // integrity attestation. New dispatch still uses full publication proof;
      // Core independently verifies the SQL serving source and claimed lease.
      const config = await readPinnedGroupConfiguration(record).catch(() => null);
      if (!config) return unknown;
      if (
        (await linuxProcessLiveness(record.processIdentity)) !== "live" ||
        (await workerPortOwnership(record.listenerPort, record.processIdentity.pid).catch(
          () => "foreign",
        )) !== "owned" ||
        (await linuxProcessLiveness(record.processIdentity)) !== "live"
      ) {
        return unknown;
      }
      const latest = recordFor(operationId);
      if (
        closed ||
        suspending ||
        admissionClosedBy !== null ||
        handles.get(operationId) !== incarnation ||
        !latest ||
        canonicalJson(latest) !== canonicalJson(record) ||
        canonicalJson(incarnation.record) !== canonicalJson(record) ||
        !incarnation.group.isReady() ||
        (record.status === "active"
          ? active !== incarnation || state.activeOperationId !== operationId
          : active === incarnation ||
            state.activeOperationId === operationId ||
            record.retireAtMs === null ||
            record.retireAtMs <= Date.now())
      ) {
        return unknown;
      }
      return {
        kind: "confirmed",
        workerUid: target.workerUid,
        versionId: target.versionId,
        incarnationId: target.incarnationId,
        servingSourceOperationId: target.servingSourceOperationId,
        status: record.status,
      };
    });
  };
  const observeVersionTarget: WorkerdWorkerRuntimeOwner["observeVersionTarget"] = (input) =>
    observeVersionTargetCore(input, false);
  const observeQueueTarget: WorkerdWorkerRuntimeOwner["observeQueueTarget"] = (input) =>
    observeVersionTargetCore(input, true);
  const observeQueuePhysicalAbsence: WorkerdWorkerRuntimeOwner["observeQueuePhysicalAbsence"] = (
    input,
  ) =>
    runSerial(async () => {
      const unknown = { kind: "unknown" } as const;
      if (
        closed ||
        input.workerUid !== options.workerResourceUid ||
        !OPERATION_ID.test(input.incarnationId) ||
        !OPERATION_ID.test(input.servingSourceOperationId)
      )
        return unknown;
      const receipt = state.physicalAbsences.find(
        (item) =>
          item.incarnationId === input.incarnationId &&
          item.operationId === input.servingSourceOperationId,
      );
      if (!receipt || (await linuxProcessLiveness(receipt.processIdentity)) !== "stale")
        return unknown;
      return {
        kind: "confirmed_absent",
        workerUid: input.workerUid,
        incarnationId: input.incarnationId,
        servingSourceOperationId: input.servingSourceOperationId,
        receiptDigest: receipt.receiptDigest,
      };
    });

  const observeRetirement: WorkerdWorkerRuntimeOwner["observeRetirement"] = (input) =>
    runSerial(async () => {
      const unknown = { kind: "unknown" } as const;
      if (closed || suspending || (input.workerVersionUid !== undefined && !input.workerVersionUid))
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
    candidate.group.sealConfiguration();
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
    if (closed || suspending) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
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
        suspending ||
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
            suspending ||
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

  const observeQueueServingCapability: WorkerdWorkerRuntimeOwner["observeQueueServingCapability"] =
    (input) => {
      const requested = {
        workerUid: input.workerUid,
        principal: input.principal,
        space: input.space,
        targetKey: input.targetKey,
      };
      return runSerial(async () => {
        const unknown = { kind: "unknown" } as const;
        const source = options.publicationState.resolveCurrentServing;
        const queueBinding = options.v2QueueSettlement;
        const incarnation = active;
        const operationId = state.activeOperationId;
        if (
          closed ||
          suspending ||
          admissionClosedBy !== null ||
          !source ||
          !queueBinding ||
          !incarnation ||
          !operationId ||
          requested.workerUid !== options.workerResourceUid ||
          requested.targetKey !== options.targetKey ||
          incarnation.record.operationId !== operationId ||
          incarnation.record.status !== "active" ||
          !incarnation.record.eventToken ||
          !incarnation.record.identity ||
          !incarnation.record.processIdentity ||
          !incarnation.group.isReady()
        )
          return unknown;
        const record = cloneRecord(incarnation.record);
        const identity = record.identity;
        const processIdentity = record.processIdentity;
        if (
          !identity ||
          !processIdentity ||
          identity.generation !== expectedOperationMarker(operationId)
        )
          return unknown;
        const resolution = await source({
          workerUid: requested.workerUid,
          targetKey: requested.targetKey,
          sourceOperationId: operationId,
          expectedIdentity: identity,
        }).catch(() => null);
        if (resolution?.kind !== "ready") return unknown;
        const snapshot = resolution.snapshot;
        const versions = snapshot.deployment?.versions.map(({ uid, generation, weight, spec }) => ({
          workerVersionUid: uid,
          generation,
          weight,
          spec,
        }));
        if (
          snapshot.sourceOperationId !== operationId ||
          snapshot.worker.uid !== requested.workerUid ||
          snapshot.worker.principal !== requested.principal ||
          snapshot.worker.space !== requested.space ||
          !snapshot.deployment ||
          !versions ||
          versions.length === 0 ||
          versions.length !== identity.versions.length ||
          canonicalJson(snapshot.endpoint ? [snapshot.endpoint.output.hostname] : []) !==
            canonicalJson(identity.hostnames)
        )
          return unknown;
        const expected = [...versions].sort((a, b) =>
          a.workerVersionUid.localeCompare(b.workerVersionUid),
        );
        const installed = [...identity.versions].sort((a, b) =>
          a.workerVersionUid.localeCompare(b.workerVersionUid),
        );
        if (
          expected.some((version, index) => {
            const native = installed[index];
            return (
              !native ||
              !Number.isSafeInteger(version.generation) ||
              version.generation < 1 ||
              native.workerVersionUid !== version.workerVersionUid ||
              native.weight !== version.weight ||
              native.versionId !==
                `v2-${createHash("sha256")
                  .update(`${version.workerVersionUid}\u0000${version.generation}`)
                  .digest("hex")}` ||
              !parseWorkerVersionSpec(version.spec).handlers.includes("queue")
            );
          })
        )
          return unknown;
        const activeDeployment = await readWorkerdActiveDeployment(
          incarnation.group.runtimeRoot,
          scriptName(requested.workerUid),
        ).catch(() => null);
        if (
          !activeDeployment?.events ||
          activeDeployment.generation !== identity.generation ||
          canonicalJson(activeDeployment.versions) !== canonicalJson(identity.versions)
        )
          return unknown;
        let basisPoint = 0;
        for (const version of identity.versions) {
          const bindingIdentity = {
            workerUid: requested.workerUid,
            versionId: version.versionId,
            incarnationId: operationId,
            servingSourceOperationId: operationId,
          };
          const selected = await readWorkerdSelectedActiveVersion(
            incarnation.group.runtimeRoot,
            scriptName(requested.workerUid),
            { expectedWorkerResourceUid: requested.workerUid, basisPoint },
          ).catch(() => null);
          if (
            !selected ||
            selected.versionId !== version.versionId ||
            selected.workerVersionUid !== version.workerVersionUid ||
            selected.generation !== identity.generation ||
            selected.site.events?.vars.length !== 1 ||
            selected.site.events.vars[0]?.name !== SELFHOST_WORKER_EVENT_TOKEN_BINDING ||
            selected.site.events.vars[0]?.value !== record.eventToken ||
            selected.site.queueSettlement?.address !== queueBinding.address ||
            selected.site.queueSettlement.vars.length !== 1 ||
            selected.site.queueSettlement.vars[0]?.name !== V2_QUEUE_SETTLEMENT_TOKEN_BINDING ||
            selected.site.queueSettlement.vars[0]?.value !==
              queueBinding.bindingToken(bindingIdentity)
          )
            return unknown;
          basisPoint += version.weight;
        }
        if (basisPoint !== 10_000) return unknown;
        const copies = await inspectWorkerdWorkerExecutionCopies({
          groupDirectory: incarnation.group.runtimeRoot,
          workerResourceUid: requested.workerUid,
          listenerPort: record.listenerPort,
          scriptName: scriptName(requested.workerUid),
        }).catch(() => null);
        if (
          !copies ||
          !executionCopiesMatchRecord(record, copies, true) ||
          identity.versions.some(
            (version) => !copies.versionUids.includes(version.workerVersionUid),
          ) ||
          (await incarnation.runtime.observeExactPublication?.(
            scriptName(requested.workerUid),
            identity,
          )) !== "matches" ||
          (await linuxProcessLiveness(processIdentity)) !== "live" ||
          (await workerPortOwnership(record.listenerPort, processIdentity.pid).catch(
            () => "foreign",
          )) !== "owned" ||
          !(await resolution.stillCurrent().catch(() => false))
        )
          return unknown;
        const stillCurrent = async (): Promise<boolean> =>
          await runSerial(async () => {
            if (
              closed ||
              suspending ||
              admissionClosedBy !== null ||
              active !== incarnation ||
              state.activeOperationId !== operationId ||
              !incarnation.group.isReady() ||
              canonicalJson(recordFor(operationId)) !== canonicalJson(record) ||
              !(await resolution.stillCurrent().catch(() => false))
            )
              return false;
            const current = await readWorkerdActiveDeployment(
              incarnation.group.runtimeRoot,
              scriptName(requested.workerUid),
            ).catch(() => null);
            const currentCopies = await inspectWorkerdWorkerExecutionCopies({
              groupDirectory: incarnation.group.runtimeRoot,
              workerResourceUid: requested.workerUid,
              listenerPort: record.listenerPort,
              scriptName: scriptName(requested.workerUid),
            }).catch(() => null);
            return (
              current?.generation === identity.generation &&
              current.events &&
              canonicalJson(current.versions) === canonicalJson(identity.versions) &&
              !!currentCopies &&
              executionCopiesMatchRecord(record, currentCopies, true) &&
              identity.versions.every((version) =>
                currentCopies.versionUids.includes(version.workerVersionUid),
              ) &&
              (await incarnation.runtime.observeExactPublication?.(
                scriptName(requested.workerUid),
                identity,
              )) === "matches" &&
              (await linuxProcessLiveness(processIdentity)) === "live" &&
              (await workerPortOwnership(record.listenerPort, processIdentity.pid).catch(
                () => "foreign",
              )) === "owned" &&
              (await resolution.stillCurrent().catch(() => false))
            );
          }).catch(() => false);
        return {
          kind: "confirmed" as const,
          servingSourceOperationId: operationId,
          deploymentUid: snapshot.deployment.uid,
          deploymentGeneration: snapshot.deployment.generation,
          versions: versions.map(({ workerVersionUid, generation, weight }) => ({
            workerVersionUid,
            generation,
            weight,
          })),
          stillCurrent,
        };
      }).catch(() => ({ kind: "unknown" as const }));
    };

  const invokeQueue: WorkerdWorkerRuntimeOwner["invokeQueue"] = async (input) => {
    const unknown = { kind: "unknown" } as const;
    const queueBinding = options.v2QueueSettlement;
    let batch: Omit<
      typeof input,
      "mintCapability" | "authorizeSend" | "renewLease" | "renewalIntervalMillis" | "stillCurrent"
    >;
    const mintCapability = input.mintCapability;
    const authorizeSend = input.authorizeSend;
    const renewLease = input.renewLease;
    const renewalIntervalMillis = input.renewalIntervalMillis;
    const stillCurrent = input.stillCurrent;
    try {
      // Caller-owned arrays and bytes cannot change while native/SQL I/O waits.
      batch = {
        batchId: input.batchId,
        workerUid: input.workerUid,
        consumerUid: input.consumerUid,
        queueUid: input.queueUid,
        queueName: input.queueName,
        generation: input.generation,
        servingSourceOperationId: input.servingSourceOperationId,
        versions: input.versions.map((version) => ({
          workerVersionUid: version.workerVersionUid,
          generation: version.generation,
          weight: version.weight,
        })),
        claims: input.claims.map((claim) => ({
          queueId: claim.queueId,
          consumerId: claim.consumerId,
          generation: claim.generation,
          leaseToken: claim.leaseToken,
          messageId: claim.messageId,
          body: claim.body.slice(),
          enqueuedAtMillis: claim.enqueuedAtMillis,
          attempts: claim.attempts,
        })),
      };
    } catch {
      return unknown;
    }
    let physicalQueueId: string;
    try {
      physicalQueueId = queueBinding?.queueIdForUid(batch.queueUid) ?? "";
    } catch {
      return unknown;
    }
    if (
      !queueBinding ||
      physicalQueueId.length === 0 ||
      !options.publicationState.resolveCurrentServing ||
      batch.workerUid !== options.workerResourceUid ||
      !OPERATION_ID.test(batch.servingSourceOperationId) ||
      !Number.isSafeInteger(batch.generation) ||
      batch.generation < 1 ||
      batch.versions.length < 1 ||
      batch.versions.length > 8 ||
      batch.claims.length < 1 ||
      batch.claims.length > 100 ||
      typeof mintCapability !== "function" ||
      typeof authorizeSend !== "function" ||
      typeof renewLease !== "function" ||
      !Number.isSafeInteger(renewalIntervalMillis) ||
      renewalIntervalMillis < 10 ||
      renewalIntervalMillis > 30_000 ||
      typeof stillCurrent !== "function" ||
      batch.claims.some(
        (claim) =>
          claim.queueId !== physicalQueueId ||
          claim.consumerId !== batch.consumerUid ||
          claim.generation !== batch.generation ||
          !(claim.body instanceof Uint8Array) ||
          claim.body.byteLength > 127_000,
      )
    )
      return unknown;
    const source = options.publicationState.resolveCurrentServing;
    // A real Queue capability's currentness check reads this same native
    // owner under runSerial. Evaluate it before entering the owner lane; the
    // SQL send-authorization CAS below repeats the accepted Consumer/source/
    // Version fences immediately before the one native effect.
    if (!(await stillCurrent().catch(() => false))) return unknown;
    const admitted = await runSerial(async () => {
      if (closed || suspending || admissionClosedBy !== null) return null;
      const incarnation = active;
      const operationId = state.activeOperationId;
      const record = operationId ? recordFor(operationId) : undefined;
      const identity = record?.identity;
      if (
        !incarnation ||
        !operationId ||
        operationId !== batch.servingSourceOperationId ||
        incarnation.record.operationId !== operationId ||
        record?.status !== "active" ||
        !record.eventToken ||
        !record.processIdentity ||
        !identity ||
        identity.generation !== expectedOperationMarker(operationId) ||
        !incarnation.group.isReady() ||
        canonicalJson(record) !== canonicalJson(incarnation.record)
      )
        return null;
      const resolution = await source({
        workerUid: batch.workerUid,
        targetKey: options.targetKey,
        sourceOperationId: operationId,
        expectedIdentity: identity,
      }).catch(() => null);
      if (resolution?.kind !== "ready") return null;
      const snapshot = resolution.snapshot;
      const selectedCore = [...batch.versions].sort((a, b) =>
        a.workerVersionUid.localeCompare(b.workerVersionUid),
      );
      const selectedNative = [...identity.versions].sort((a, b) =>
        a.workerVersionUid.localeCompare(b.workerVersionUid),
      );
      if (
        !snapshot ||
        snapshot.sourceOperationId !== operationId ||
        snapshot.worker.uid !== batch.workerUid ||
        !snapshot.deployment ||
        selectedCore.length !== selectedNative.length ||
        selectedCore.reduce((sum, item) => sum + item.weight, 0) !== 10_000 ||
        selectedCore.some(
          (item, index) =>
            item.workerVersionUid !== selectedNative[index]?.workerVersionUid ||
            item.weight !== selectedNative[index]?.weight ||
            !Number.isSafeInteger(item.generation) ||
            item.generation < 1,
        ) ||
        canonicalJson(
          snapshot.deployment.versions
            .map((version) => ({
              workerVersionUid: version.uid,
              generation: version.generation,
              weight: version.weight,
            }))
            .sort((a, b) => a.workerVersionUid.localeCompare(b.workerVersionUid)),
        ) !== canonicalJson(selectedCore) ||
        snapshot.deployment.versions.some(
          (version) => !parseWorkerVersionSpec(version.spec).handlers.includes("queue"),
        ) ||
        !(await resolution.stillCurrent().catch(() => false)) ||
        (await incarnation.runtime.observeExactPublication?.(
          scriptName(batch.workerUid),
          identity,
        )) !== "matches"
      )
        return null;
      const copies = await inspectWorkerdWorkerExecutionCopies({
        groupDirectory: incarnation.group.runtimeRoot,
        workerResourceUid: batch.workerUid,
        listenerPort: record.listenerPort,
        scriptName: scriptName(batch.workerUid),
      }).catch(() => null);
      if (!copies || !executionCopiesMatchRecord(record, copies, true)) return null;
      let selected: ReturnType<typeof selectSelfhostWeightedVersion>;
      let basisPoint: number;
      try {
        basisPoint = randomSelfhostDeploymentBasisPoint();
        selected = selectSelfhostWeightedVersion(identity.versions, basisPoint);
      } catch {
        return null;
      }
      const version = selectedCore.find(
        (item) => item.workerVersionUid === selected.workerVersionUid,
      );
      if (
        !version ||
        !copies.versionUids.includes(version.workerVersionUid) ||
        selected.versionId !==
          `v2-${createHash("sha256")
            .update(`${version.workerVersionUid}\u0000${version.generation}`)
            .digest("hex")}`
      )
        return null;
      const selectedGraph = await readWorkerdSelectedActiveVersion(
        incarnation.group.runtimeRoot,
        scriptName(batch.workerUid),
        { expectedWorkerResourceUid: batch.workerUid, basisPoint },
      ).catch(() => null);
      const bindingIdentity = {
        workerUid: batch.workerUid,
        versionId: selected.versionId,
        incarnationId: operationId,
        servingSourceOperationId: operationId,
      };
      if (
        !selectedGraph ||
        selectedGraph.versionId !== selected.versionId ||
        selectedGraph.workerVersionUid !== version.workerVersionUid ||
        selectedGraph.generation !== identity.generation ||
        selectedGraph.site.events?.vars.length !== 1 ||
        selectedGraph.site.events.vars[0]?.name !== SELFHOST_WORKER_EVENT_TOKEN_BINDING ||
        selectedGraph.site.events.vars[0]?.value !== record.eventToken ||
        selectedGraph.site.queueSettlement?.address !== queueBinding.address ||
        selectedGraph.site.queueSettlement.vars.length !== 1 ||
        selectedGraph.site.queueSettlement.vars[0]?.name !== V2_QUEUE_SETTLEMENT_TOKEN_BINDING ||
        selectedGraph.site.queueSettlement.vars[0]?.value !==
          queueBinding.bindingToken(bindingIdentity)
      )
        return null;
      const physicalId = physicalIncarnationId(operationId, record.processIdentity);
      const target = {
        workerVersionUid: version.workerVersionUid,
        workerVersionGeneration: version.generation,
        incarnationOperationId: physicalId,
      };
      let event: ReturnType<typeof selfhostV2QueueEvent>;
      try {
        event = selfhostV2QueueEvent({
          batchId: batch.batchId,
          script: scriptName(batch.workerUid),
          publication: selected.versionId,
          workerUid: batch.workerUid,
          consumerUid: batch.consumerUid,
          queueUid: batch.queueUid,
          queue: batch.queueName,
          messages: batch.claims.map((claim) => ({
            messageId: claim.messageId,
            timestampMillis: claim.enqueuedAtMillis,
            attempts: claim.attempts,
            body: { encoding: "base64" as const, data: Buffer.from(claim.body).toString("base64") },
            leaseToken: claim.leaseToken,
            invocationCapability: mintCapability({
              batchId: batch.batchId,
              messageId: claim.messageId,
              workerUid: batch.workerUid,
              versionId: selected.versionId,
              incarnationId: physicalId,
              servingSourceOperationId: operationId,
              consumerUid: batch.consumerUid,
              queueUid: batch.queueUid,
              generation: batch.generation,
              leaseToken: claim.leaseToken,
            }),
          })),
        });
      } catch {
        return null;
      }
      if (
        !(await resolution.stillCurrent().catch(() => false)) ||
        active !== incarnation ||
        state.activeOperationId !== operationId ||
        canonicalJson(recordFor(operationId)) !== canonicalJson(record) ||
        !incarnation.group.isReady()
      )
        return null;
      // A lost authorization ACK is not a permission to resend. The SQL row
      // remains occupied until an exact terminal or physical-absence proof.
      if ((await authorizeSend(target).catch(() => "unknown")) !== "authorized") return null;
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
      // Start the one-shot private event while still holding the owner serial
      // lane. The returned promise is awaited outside it, so lifecycle may drain.
      const response = incarnation.runtime.probe?.(
        scriptName(batch.workerUid),
        SELFHOST_V2_QUEUE_EVENT_PATH,
        {
          route: "events",
          method: "POST",
          headers: {
            "content-type": SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE,
            [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
            [SELFHOST_WORKER_EVENT_TOKEN_HEADER]: record.eventToken,
          },
          body: JSON.stringify(event),
          timeoutMillis: null,
          abortSignal: invocation.abort.signal,
        },
      );
      return { invocation, response, target, incarnation, event };
    }).catch(() => null);
    if (!admitted) return unknown;
    let renewing: Promise<void> | null = null;
    let renewalClosed = false;
    const renew = () => {
      if (renewalClosed || renewing) return;
      renewing = (async () => {
        const target = {
          ...admitted.target,
          versionId: admitted.event.deploymentId,
        };
        const native = await observeQueueTarget({
          workerUid: batch.workerUid,
          versionId: target.versionId,
          incarnationId: target.incarnationOperationId,
          servingSourceOperationId: batch.servingSourceOperationId,
        });
        if (!renewalClosed && native.kind === "confirmed") await renewLease(target);
      })()
        .catch(() => undefined)
        .finally(() => {
          renewing = null;
        });
    };
    const renewalTimer = setInterval(renew, renewalIntervalMillis);
    try {
      const answer = await admitted.response;
      const outcome = answer ? selfhostV2QueueCompletionAnswer(answer) : null;
      if (!outcome || admitted.invocation.abort.signal.aborted) return unknown;
      const native = await observeVersionTargetCore(
        {
          workerUid: batch.workerUid,
          versionId: admitted.event.deploymentId,
          incarnationId: admitted.target.incarnationOperationId,
          servingSourceOperationId: batch.servingSourceOperationId,
        },
        true,
      );
      if (native.kind !== "confirmed") return unknown;
      const receiptDigest = createHash("sha256")
        .update(
          canonicalJson({
            batchId: batch.batchId,
            target: admitted.target,
            outcome,
            protocol: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
          }),
        )
        .digest("hex");
      return { kind: outcome, ...admitted.target, receiptDigest };
    } catch {
      return unknown;
    } finally {
      renewalClosed = true;
      clearInterval(renewalTimer);
      // An in-flight observer can be waiting behind lifecycle's serial lane.
      // Never wait for it while retiring this invocation; the SQL CAS refuses
      // any renewal after 0083 becomes terminal.
      admitted.invocation.finish();
    }
  };

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
      if (closed || suspending || admissionClosedBy !== null) return null;
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
        suspending ||
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
          suspending ||
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
      if (suspending) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      if (
        state.incarnations.some(
          (item) =>
            item.status !== "retired" || item.receipt === null || !item.executionCopiesReleased,
        )
      )
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      for (const item of handles.values()) {
        item.retirementTimer?.();
        await item.actorForward?.close();
        await item.workflowForward?.close();
      }
      await releaseOwnerLock(lockPath, directory, ownerLock);
      closed = true;
    });
  };

  const suspend = async (): Promise<void> => {
    if (closed || suspending) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    // This is a terminal operation on this owner object. Freeze new admission
    // synchronously, even while an earlier serialized publication is settling.
    suspending = true;
    await runSerial(async () => {
      try {
        if (!recoverableIncarnationSet(state))
          throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
        for (const handle of handles.values()) {
          handle.retirementTimer?.();
        }
        // A drain callback may already have started retirement before the
        // synchronous admission freeze. Join it before touching or releasing
        // its group; a failed retire leaves this owner lock in place.
        for (const handle of handles.values()) {
          if (handle.retiring) await handle.retiring;
        }
        for (const handle of handles.values()) {
          await cancelInvocations(handle);
          await Promise.all([...handle.workflowLeases]);
        }
        for (const handle of handles.values()) {
          if (handle.record.status === "active" || handle.record.status === "draining") {
            await handle.group.suspendRetainingCustody();
          }
          await handle.actorForward?.close();
          await handle.workflowForward?.close();
        }
        await persistPhysicalAbsences(true);
        await releaseOwnerLock(lockPath, directory, ownerLock);
        closed = true;
      } catch {
        // A failed stop, vacancy probe, or durable write never releases the
        // successor lock. The object stays admission-closed for this Host.
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      }
    });
  };

  const initial: PersistedOwnerState = state;
  if (!initial.incarnations.length) await transitionState((current) => current);
  if (
    (ownerLock.recoveredFromStaleOwner || state.suspended) &&
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
      // A failed recovery is not a completed graceful suspend. Keep this
      // successor lock even when failure was transient; another Host may
      // retry only after this PID is proven stale.
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
    observeActorGraph,
    observeActorGraphForAcceptedOperation,
    selectWorkflowExecution,
    observeVersionTarget,
    observeQueueTarget,
    observeQueuePhysicalAbsence,
    observeRetirement,
    fetch: fetchRequest,
    observeScheduledCapability,
    observeQueueServingCapability,
    invokeQueue,
    invokeScheduled,
    close,
    suspend,
  });
}
