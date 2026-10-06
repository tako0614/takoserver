import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { WORKER_DEPLOYMENT_FORM_URL } from "./takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "./takoform-v2/types.ts";
import type { V2WorkerPublicationResolution } from "./takoform-v2/worker-publication-state.ts";
import {
  createV2StaticWorkerPublication,
  type V2StaticWorkerPublicationResult,
} from "./takoform-v2/worker-static-publication.ts";
import type {
  WorkerdPublicationIdentity,
  WorkerdRuntime,
  WorkerdStaticSite,
} from "./workerd-runtime.ts";
import { createWorkerdRuntime } from "./workerd-runtime.ts";
import type { WorkerdProcess } from "./workerd-supervisor.ts";
import {
  openWorkerdWorkerExecutionGroup,
  type WorkerdWorkerExecutionGroup,
  type WorkerdWorkerRetirementReceipt,
} from "./workerd-worker-execution-group.ts";

const STATE_NAME = "runtime-owner.json";
const LOCK_NAME = "runtime-owner.lock";
const STATE_SCHEMA = "takoserver.v2-worker-runtime-owner@1";
const OPERATION_MARKER = "takoserver-v2-operation:";
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DRAIN_GRACE_MS = 15 * 60 * 1000;

type PublicationState = {
  resolve(input: {
    execution: V2Execution;
    incumbentSourceOperationId?: string;
  }): Promise<V2WorkerPublicationResolution>;
};

type IncarnationStatus = "candidate" | "active" | "draining" | "retiring" | "retired" | "uncertain";

interface IncarnationRecord {
  readonly operationId: string;
  readonly listenerPort: number;
  readonly status: IncarnationStatus;
  readonly retirementOperationId: string | null;
  readonly retireAtMs: number | null;
  readonly identity: WorkerdPublicationIdentity | null;
  readonly receipt: WorkerdWorkerRetirementReceipt | null;
}

interface PersistedOwnerState {
  readonly schema: typeof STATE_SCHEMA;
  readonly workerResourceUid: string;
  readonly activeOperationId: string | null;
  readonly admissionClosedBy: string | null;
  readonly deletionPublicationConfirmed: boolean;
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
  readonly runtime: ReturnType<typeof createWorkerdRuntime>;
  readonly publication: ReturnType<typeof createV2StaticWorkerPublication>;
  readonly invocations: Set<ActiveInvocation>;
  retirementTimer?: ReturnType<typeof setTimeout>;
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

export interface WorkerdWorkerRuntimeOwner {
  readonly workerResourceUid: string;
  /** Run one accepted WorkerDeployment Operation and switch only this UID's listener. */
  execute(execution: V2Execution): Promise<V2StaticWorkerPublicationResult>;
  /** Route a Host-accepted request to the exact active incarnation. */
  fetch(request: Request): Promise<Response>;
  /** Release the owner lock only after every known incarnation has a durable receipt. */
  close(): Promise<void>;
}

export interface OpenWorkerdWorkerRuntimeOwnerOptions {
  /** Private operator-owned root for this Worker UID. */
  readonly rootDirectory: string;
  readonly workerResourceUid: string;
  readonly targetKey: string;
  readonly publicationState: PublicationState;
  readonly workerdBinary: string | null;
  /** Allocate a distinct private listener for each immutable Deployment incarnation. */
  readonly listenerPortForOperation: (operationId: string) => number | Promise<number>;
  readonly spawn?: (command: readonly string[]) => WorkerdProcess;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
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
    incarnations: [],
  };
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

function parseState(text: string | null, workerResourceUid: string): PersistedOwnerState {
  if (text === null) return emptyState(workerResourceUid);
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const state = value as Record<string, unknown>;
    if (
      state.schema !== STATE_SCHEMA ||
      state.workerResourceUid !== workerResourceUid ||
      !(state.activeOperationId === null || typeof state.activeOperationId === "string") ||
      !(state.admissionClosedBy === null || typeof state.admissionClosedBy === "string") ||
      typeof state.deletionPublicationConfirmed !== "boolean" ||
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
      incarnations.push(item as unknown as IncarnationRecord);
    }
    const result: PersistedOwnerState = {
      schema: STATE_SCHEMA,
      workerResourceUid,
      activeOperationId: state.activeOperationId as string | null,
      admissionClosedBy: state.admissionClosedBy as string | null,
      deletionPublicationConfirmed: state.deletionPublicationConfirmed,
      incarnations,
    };
    const activeRecords = incarnations.filter((item) => item.status === "active");
    if (
      (state.admissionClosedBy === null && state.deletionPublicationConfirmed) ||
      (state.deletionPublicationConfirmed &&
        (state.activeOperationId !== null ||
          incarnations.some((item) => item.status !== "retired" || item.receipt === null))) ||
      (state.activeOperationId === null && activeRecords.length !== 0) ||
      (state.activeOperationId !== null &&
        !incarnations.some(
          (item) =>
            item.operationId === state.activeOperationId &&
            item.identity !== null &&
            ["active", "retiring", "retired"].includes(item.status),
        )) ||
      incarnations.some(
        (item) =>
          (item.status === "retired") !== (item.receipt !== null) ||
          (["draining", "retiring", "retired"].includes(item.status) &&
            item.retirementOperationId === null),
      )
    ) {
      throw new Error();
    }
    if (canonicalJson(result) !== text) throw new Error();
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

  let lockHandle: Awaited<ReturnType<typeof open>>;
  try {
    // Never reclaim a leftover lock from PID state alone. A crashed owner can
    // leave Workerd children behind; crash recovery needs a separate proof of
    // exclusive ownership and exact child retirement before this UID can open.
    lockHandle = await open(join(directory, LOCK_NAME), "wx", 0o600);
    await lockHandle.writeFile(`${process.pid}\n`);
    await lockHandle.sync();
    await syncDirectory(directory);
  } catch {
    throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
  }

  const statePath = join(directory, STATE_NAME);
  let state: PersistedOwnerState;
  try {
    const text = await readFile(statePath, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    state = parseState(text, options.workerResourceUid);
    if (state.incarnations.some((item) => item.status !== "retired")) {
      throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
    }
  } catch (error) {
    await lockHandle.close().catch(() => undefined);
    await rm(join(directory, LOCK_NAME), { force: true }).catch(() => undefined);
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
    if (incarnation.invocations.size === 0 && incarnation.record.status === "draining") {
      void retireIncarnation(incarnation).catch(() => undefined);
    }
  };

  async function retireIncarnation(
    incarnation: IncarnationHandle,
  ): Promise<WorkerdWorkerRetirementReceipt> {
    if (incarnation.retiring) return await incarnation.retiring;
    if (incarnation.record.status === "retired" && incarnation.record.receipt)
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
        const retired = await updateRecord(incarnation.record.operationId, (current) => ({
          ...current,
          status: "retired",
          receipt,
        }));
        incarnation.record = retired;
        if (incarnation.retirementTimer !== undefined) clearTimeout(incarnation.retirementTimer);
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
    if (incarnation.invocations.size === 0) {
      void retireIncarnation(incarnation).catch(() => undefined);
      return;
    }
    const at = incarnation.record.retireAtMs;
    if (at === null) return;
    const delay = Math.max(0, at - Date.now());
    incarnation.retirementTimer = setTimeout(() => {
      void cancelInvocations(incarnation)
        .then(() => retireIncarnation(incarnation))
        .catch(() => undefined);
    }, delay);
    incarnation.retirementTimer.unref?.();
  };

  const incarnationDirectory = (operationId: string): string =>
    join(directory, "incarnations", operationId);

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
      identity: null,
      receipt: null,
    };
    await transitionState((current) => ({
      ...current,
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
    });
    const runtime = createWorkerdRuntime({
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
    const candidateRuntime: WorkerdRuntime<WorkerdStaticSite> = {
      ...runtime,
      publishFenced: async (name, resolvePublication, isFenceCurrent) => {
        await runtime.publishFenced?.(
          name,
          async (current) => resolvePublication(current ?? incumbent),
          isFenceCurrent,
        );
      },
    };
    const publication = createV2StaticWorkerPublication({
      targetKey: options.targetKey,
      publicationState: options.publicationState,
      runtime: candidateRuntime,
    });
    const handle: IncarnationHandle = {
      record: candidateRecord,
      group,
      runtime,
      publication,
      invocations: new Set(),
    };
    handles.set(operationId, handle);
    await runtime.reload();
    return handle;
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

  const execute = (inputExecution: V2Execution): Promise<V2StaticWorkerPublicationResult> => {
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
        execution.form !== WORKER_DEPLOYMENT_FORM_URL ||
        execution.targetKey !== options.targetKey ||
        workerFromExecution(execution) !== options.workerResourceUid
      ) {
        return { kind: "not_dispatched", code: "worker_publication_target_mismatch" };
      }
      if (execution.action === "delete") {
        try {
          return await deleteDeployment(execution);
        } catch {
          return { kind: "unknown" };
        }
      }
      if (admissionClosedBy !== null && execution.operationId !== admissionClosedBy) {
        const deleteRetired =
          state.deletionPublicationConfirmed &&
          state.incarnations.every((item) => item.status === "retired" && item.receipt !== null);
        if (!deleteRetired) return { kind: "unknown" };
        admissionClosedBy = null;
        await transitionState((current) => ({
          ...current,
          admissionClosedBy: null,
          deletionPublicationConfirmed: false,
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
            canonicalJson(observed.identity) === canonicalJson(existing.record.identity)
          ) {
            return observed;
          }
          return { kind: "unknown" };
        }
        const result = await existing.publication.publish(execution);
        if (result.kind === "confirmed" && result.identity !== null) {
          return await activateIncarnation(existing, result.identity, execution.operationId);
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
          return result;
        }
        candidate.group.sealConfiguration();
        return await activateIncarnation(candidate, result.identity, execution.operationId);
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
    operationId: string,
  ): Promise<V2StaticWorkerPublicationResult> {
    if (identity.workerResourceUid !== options.workerResourceUid) return { kind: "unknown" };
    if (identity.generation !== expectedOperationMarker(operationId)) return { kind: "unknown" };
    const previous = active;
    const now = Date.now();
    let oldRecord: IncarnationRecord | null = null;
    const snapshot = await transitionState((current) => {
      const candidateRecord = current.incarnations.find(
        (item) => item.operationId === candidate.record.operationId,
      );
      if (!candidateRecord) throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      const nextCandidate: IncarnationRecord = { ...candidateRecord, status: "active", identity };
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
    return { kind: "confirmed", identity };
  }

  async function deleteDeployment(
    execution: V2Execution,
  ): Promise<V2StaticWorkerPublicationResult> {
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
      state.incarnations.every((item) => item.status === "retired" && item.receipt !== null)
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
      }));
    }
    for (const incarnation of handles.values()) await cancelInvocations(incarnation);

    const live = [...handles.values()].filter((item) => item.record.status !== "retired");
    for (const incarnation of live) {
      if (incarnation.retirementTimer !== undefined) clearTimeout(incarnation.retirementTimer);
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

  const close = async (): Promise<void> => {
    await runSerial(async () => {
      if (closed) return;
      if (state.incarnations.some((item) => item.status !== "retired" || item.receipt === null))
        throw new WorkerdWorkerRuntimeOwnerError("ownership_uncertain");
      for (const item of handles.values()) {
        if (item.retirementTimer !== undefined) clearTimeout(item.retirementTimer);
      }
      closed = true;
      await lockHandle.close();
      await rm(join(directory, LOCK_NAME), { force: true });
      await syncDirectory(directory);
    });
  };

  const initial: PersistedOwnerState = state;
  if (!initial.incarnations.length) await transitionState((current) => current);
  // If this owner opens after all groups were retired, the durable state can
  // replay its delete proof. Unretired groups are rejected above and never adopted.
  return Object.freeze({
    workerResourceUid: options.workerResourceUid,
    execute,
    fetch: fetchRequest,
    close,
  });
}
