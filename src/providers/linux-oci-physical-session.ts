import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join, parse } from "node:path";

const LIMIT = 1_048_576;
const STDERR_LIMIT = 65_536;
const INT_MAX = 2_147_483_647;
const CLAIM = /^[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const failure = (code = "unavailable") => new Error(`linux_oci_physical_session_${code}`);
const RETIREMENT = {
  "begin-tracked-join": ["linux-oci-begin-tracked-join@1", "linux-oci-tracked-join-handoff@1"],
  "read-tracked-join": ["linux-oci-read-tracked-join@1", "linux-oci-tracked-owner-destruction@1"],
  "delete-born": ["linux-oci-delete-born@1", "linux-oci-born-delete-observation@1"],
  "join-born-delete": ["linux-oci-join-born-delete@1", "linux-oci-born-delete-join-observation@1"],
  "dispose-born": ["linux-oci-dispose-born@1", "linux-oci-local-disposal@1"],
  "continue-born-disposal": [
    "linux-oci-continue-born-disposal@1",
    "linux-oci-local-disposal-continuation@1",
  ],
} as const;
type RetirementOperation = keyof typeof RETIREMENT;
function retirementOperation(operation: string): operation is RetirementOperation {
  return Object.hasOwn(RETIREMENT, operation);
}

/** Private physical protocol data. Acceptance and the original artifact/claim
 * remain the calling owner's responsibility; none of these fields is a grant. */
export interface LinuxOciCreateStoppedRequest {
  readonly allocationRoot: string;
  readonly claimId: string;
  readonly installationId: string;
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly generation: number;
  readonly revision: string;
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly archiveDigest: string;
  readonly args: readonly string[];
  readonly env: readonly string[];
  readonly cwd: string;
  readonly uid: number;
  readonly gid: number;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
}

/** Stopped physical observations only: never admission, readiness or terminal. */
export interface LinuxOciStoppedObservation {
  readonly kind: "linux-oci-created-stopped@1" | "linux-oci-stopped-observation@1";
  readonly nativeId: string;
  readonly namespaceDevice: number;
  readonly namespaceInode: number;
  readonly barrier: "unproven";
}
/** Actual START/exec-transition facts from the SAME original private child.
 * These are neither network admission nor health/serving/retirement results. */
export interface LinuxOciStartedObservation {
  readonly kind: "linux-oci-started@1" | "linux-oci-started-observation@1";
  readonly nativeId: string;
  readonly namespaceDevice: number;
  readonly namespaceInode: number;
  readonly barrier: "unproven";
}
/** Actual consuming init-reap fact from the SAME original child/PIDNS.
 * Task reaping never grants network lifetime completion or runtime deletion. */
export interface LinuxOciInitReapedObservation {
  readonly kind: "linux-oci-init-reaped@1" | "linux-oci-init-reaped-observation@1";
  readonly nativeId: string;
  readonly namespaceDevice: number;
  readonly namespaceInode: number;
  readonly pidNamespaceDevice: number;
  readonly pidNamespaceInode: number;
  readonly barrier: "unproven";
}
/** Factual retained-ledger data from the SAME original namespace owner.
 * Counters/cookie remain lossless uint64 strings; no combination grants
 * admission, full lifetime coverage, runtime deletion or successful close. */
export interface LinuxOciNamespaceLifetimeObservation {
  readonly kind:
    | "linux-oci-namespace-release-observation@1"
    | "linux-oci-namespace-release-continuation@1"
    | "linux-oci-namespace-lifetime-observation@1";
  readonly nativeId: string;
  readonly namespaceDevice: number;
  readonly namespaceInode: number;
  readonly netCookie: string;
  readonly fullIpSockets: string;
  readonly requests: string;
  readonly timewait: string;
  readonly packetGroups: string;
  readonly born: 1;
  readonly releaseAttempted: 0 | 1;
  readonly referenceReleased: 0 | 1;
  readonly netGone: 0 | 1;
  readonly poisoned: 0 | 1;
  readonly barrier: "unproven";
}
export interface LinuxOciCancelObservation {
  readonly kind: "linux-oci-cancel-observation@1";
  readonly stage: "cancel";
  readonly errno: number;
  readonly custody: "released-uncreated" | "retained";
  readonly barrier: "unproven";
}
/** Facts from this original stream only. BEGIN acknowledges handoff; READ
 * observes tracked-owner destruction. Local disposal covers current held
 * slots, never historical FDs, helper-child exit, full traffic or Core removal. */
export interface LinuxOciRetirementObservation {
  readonly kind: (typeof RETIREMENT)[RetirementOperation][1];
  readonly barrier: "unproven";
}
/** Same original helper process has exited zero and closed its stdio.
 * This is not full traffic, historical FD coverage or Core removal authority. */
export interface LinuxOciDisposedHelperObservation {
  readonly kind: "linux-oci-disposed-helper-exit@1";
  readonly barrier: "unproven";
}
interface Refusal {
  readonly kind: "linux-oci-refused@1";
  readonly stage:
    | RetirementOperation
    | "frame"
    | "request"
    | "create"
    | "observe"
    | "start"
    | "observe-started"
    | "stop-init"
    | "join-init"
    | "release-namespace"
    | "continue-namespace-release"
    | "observe-namespace-lifetime"
    | "cancel";
  readonly errno: number;
  readonly custody: "released-uncreated" | "retained";
  readonly barrier: "unproven";
}
type Reply =
  | LinuxOciStoppedObservation
  | LinuxOciStartedObservation
  | LinuxOciInitReapedObservation
  | LinuxOciNamespaceLifetimeObservation
  | LinuxOciRetirementObservation
  | LinuxOciCancelObservation
  | Refusal;
type Operation =
  | RetirementOperation
  | "create"
  | "observe"
  | "start"
  | "observe-started"
  | "stop-init"
  | "join-init"
  | "release-namespace"
  | "continue-namespace-release"
  | "observe-namespace-lifetime"
  | "cancel";
interface Pending {
  readonly operation: Operation;
  readonly resolve: (reply: Reply) => void;
  readonly reject: (error: Error) => void;
  readonly done: Promise<void>;
  readonly finish: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}

function integer(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
function uint64(value: unknown, nonzero = false): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]{0,19})$/u.test(value) &&
    (value.length < 20 || value <= "18446744073709551615") &&
    (!nonzero || value !== "0")
  );
}
function bit(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}
function text(value: unknown, maximum: number, nonempty = true): value is string {
  if (typeof value !== "string" || (nonempty && !value) || value.includes("\0")) return false;
  const encoded = encoder.encode(value);
  return encoded.length <= maximum && decoder.decode(encoded) === value;
}
function absolute(value: unknown): value is string {
  return (
    text(value, 4095) &&
    isAbsolute(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 1024 ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw failure("request");
  const copy: string[] = [];
  if (Reflect.ownKeys(value).length !== value.length + 1) throw failure("request");
  for (let index = 0; index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !Object.hasOwn(item, "value") || !text(item.value, 131071, false))
      throw failure("request");
    copy.push(item.value);
  }
  return copy;
}

function project(request: LinuxOciCreateStoppedRequest) {
  const names = [
    "allocationRoot",
    "claimId",
    "installationId",
    "resourceUid",
    "incarnationId",
    "generation",
    "revision",
    "sourceDigest",
    "manifestDigest",
    "configDigest",
    "archiveDigest",
    "args",
    "env",
    "cwd",
    "uid",
    "gid",
    "memoryBytes",
    "nanoCpus",
    "pidsLimit",
  ];
  if (!record(request) || Reflect.ownKeys(request).length !== names.length)
    throw failure("request");
  const data: Record<string, unknown> = {};
  for (const name of names) {
    const field = Object.getOwnPropertyDescriptor(request, name);
    if (!field || !Object.hasOwn(field, "value")) throw failure("request");
    data[name] = field.value;
  }
  const args = strings(data.args),
    env = strings(data.env);
  if (
    !absolute(data.allocationRoot) ||
    typeof data.claimId !== "string" ||
    !CLAIM.test(data.claimId) ||
    ![data.installationId, data.resourceUid, data.incarnationId, data.revision].every((value) =>
      text(value, 1024),
    ) ||
    !integer(data.generation, 1) ||
    ![data.sourceDigest, data.manifestDigest, data.configDigest, data.archiveDigest].every(
      (value) => typeof value === "string" && DIGEST.test(value),
    ) ||
    !args.length ||
    !args[0] ||
    !text(data.cwd, 4095) ||
    !isAbsolute(data.cwd) ||
    !integer(data.uid, 0, 0xffffffff) ||
    !integer(data.gid, 0, 0xffffffff) ||
    !integer(data.memoryBytes, 1) ||
    !integer(data.nanoCpus, 10_000_000) ||
    !integer(data.pidsLimit, 1, INT_MAX) ||
    [...args, ...env].reduce((sum, value) => sum + encoder.encode(value).length, 0) > LIMIT / 2
  )
    throw failure("request");
  const keys = new Set<string>();
  for (const entry of env) {
    const equals = entry.indexOf("="),
      key = entry.slice(0, equals);
    if (equals < 1 || keys.has(key)) throw failure("request");
    keys.add(key);
  }
  return {
    kind: "linux-oci-create-stopped@1",
    ...data,
    claimId: data.claimId,
    args,
    env,
  };
}

function parseReply(body: Buffer): Reply {
  const original = decoder.decode(body);
  const value: unknown = JSON.parse(original);
  if (!record(value) || value.barrier !== "unproven") throw failure();
  let reply: Reply;
  if (
    value.kind === "linux-oci-created-stopped@1" ||
    value.kind === "linux-oci-stopped-observation@1" ||
    value.kind === "linux-oci-started@1" ||
    value.kind === "linux-oci-started-observation@1"
  ) {
    if (
      typeof value.nativeId !== "string" ||
      !CLAIM.test(value.nativeId) ||
      !integer(value.namespaceDevice, 1) ||
      !integer(value.namespaceInode, 1)
    )
      throw failure();
    reply = {
      kind: value.kind,
      nativeId: value.nativeId,
      namespaceDevice: value.namespaceDevice,
      namespaceInode: value.namespaceInode,
      barrier: "unproven",
    };
  } else if (
    value.kind === "linux-oci-init-reaped@1" ||
    value.kind === "linux-oci-init-reaped-observation@1"
  ) {
    if (
      typeof value.nativeId !== "string" ||
      !CLAIM.test(value.nativeId) ||
      !integer(value.namespaceDevice, 1) ||
      !integer(value.namespaceInode, 1) ||
      !integer(value.pidNamespaceDevice, 1) ||
      !integer(value.pidNamespaceInode, 1)
    )
      throw failure();
    reply = {
      kind: value.kind,
      nativeId: value.nativeId,
      namespaceDevice: value.namespaceDevice,
      namespaceInode: value.namespaceInode,
      pidNamespaceDevice: value.pidNamespaceDevice,
      pidNamespaceInode: value.pidNamespaceInode,
      barrier: "unproven",
    };
  } else if (
    value.kind === "linux-oci-namespace-release-observation@1" ||
    value.kind === "linux-oci-namespace-release-continuation@1" ||
    value.kind === "linux-oci-namespace-lifetime-observation@1"
  ) {
    if (
      typeof value.nativeId !== "string" ||
      !CLAIM.test(value.nativeId) ||
      !integer(value.namespaceDevice, 1) ||
      !integer(value.namespaceInode, 1) ||
      !uint64(value.netCookie, true) ||
      !uint64(value.fullIpSockets) ||
      !uint64(value.requests) ||
      !uint64(value.timewait) ||
      !uint64(value.packetGroups) ||
      value.born !== 1 ||
      !bit(value.releaseAttempted) ||
      !bit(value.referenceReleased) ||
      !bit(value.netGone) ||
      !bit(value.poisoned) ||
      (value.referenceReleased === 1 && value.releaseAttempted !== 1) ||
      (value.netGone === 1 && value.releaseAttempted !== 1)
    )
      throw failure();
    reply = {
      kind: value.kind,
      nativeId: value.nativeId,
      namespaceDevice: value.namespaceDevice,
      namespaceInode: value.namespaceInode,
      netCookie: value.netCookie,
      fullIpSockets: value.fullIpSockets,
      requests: value.requests,
      timewait: value.timewait,
      packetGroups: value.packetGroups,
      born: value.born,
      releaseAttempted: value.releaseAttempted,
      referenceReleased: value.referenceReleased,
      netGone: value.netGone,
      poisoned: value.poisoned,
      barrier: "unproven",
    };
  } else if (Object.values(RETIREMENT).some(([, kind]) => kind === value.kind)) {
    // Repeat the closed kinds for narrowing; neither identity nor custody is
    // read after the C producer may have freed its original owner.
    if (
      value.kind !== "linux-oci-tracked-join-handoff@1" &&
      value.kind !== "linux-oci-tracked-owner-destruction@1" &&
      value.kind !== "linux-oci-born-delete-observation@1" &&
      value.kind !== "linux-oci-born-delete-join-observation@1" &&
      value.kind !== "linux-oci-local-disposal@1" &&
      value.kind !== "linux-oci-local-disposal-continuation@1"
    )
      throw failure();
    reply = { kind: value.kind, barrier: "unproven" };
  } else if (
    value.kind === "linux-oci-refused@1" ||
    value.kind === "linux-oci-cancel-observation@1"
  ) {
    if (
      (value.custody !== "retained" && value.custody !== "released-uncreated") ||
      !integer(value.errno, value.kind === "linux-oci-refused@1" ? 1 : 0, INT_MAX)
    )
      throw failure();
    if (value.kind === "linux-oci-cancel-observation@1") {
      if (value.stage !== "cancel") throw failure();
      reply = {
        kind: value.kind,
        stage: "cancel",
        errno: value.errno,
        custody: value.custody,
        barrier: "unproven",
      };
    } else {
      if (
        value.stage !== "frame" &&
        value.stage !== "request" &&
        value.stage !== "create" &&
        value.stage !== "observe" &&
        value.stage !== "start" &&
        value.stage !== "observe-started" &&
        value.stage !== "stop-init" &&
        value.stage !== "join-init" &&
        value.stage !== "release-namespace" &&
        value.stage !== "continue-namespace-release" &&
        value.stage !== "observe-namespace-lifetime" &&
        value.stage !== "cancel" &&
        !(typeof value.stage === "string" && retirementOperation(value.stage))
      )
        throw failure();
      reply = {
        kind: value.kind,
        stage: value.stage,
        errno: value.errno,
        custody: value.custody,
        barrier: "unproven",
      };
    }
  } else throw failure();
  if (JSON.stringify(reply) !== original) throw failure();
  return Object.freeze(reply);
}

function ownedExecutable(binary: string) {
  if (!absolute(binary) || binary.endsWith("/")) throw failure("binary");
  const uid = process.getuid?.();
  if (uid === undefined) throw failure("binary");
  const paths = [parse(binary).root];
  for (const part of binary.slice(paths[0]?.length ?? 0).split("/")) {
    if (!part) throw failure("binary");
    paths.push(join(paths.at(-1) ?? "/", part));
  }
  const capture = paths.map((path, index) => {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      stat.mode & 0o022 ||
      (index === paths.length - 1 ? !stat.isFile() || !(stat.mode & 0o111) : !stat.isDirectory())
    )
      throw failure("binary");
    return { path, dev: stat.dev, ino: stat.ino };
  });
  accessSync(binary, constants.X_OK);
  return () => {
    for (const expected of capture) {
      const stat = lstatSync(expected.path);
      if (
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        stat.isSymbolicLink() ||
        stat.uid !== uid ||
        stat.mode & 0o022
      )
        throw failure("binary");
    }
    accessSync(binary, constants.X_OK);
  };
}

/** Holds its ORIGINAL child even when protocol/custody becomes unknown.
 * Its owner must retain this object; close cannot manufacture runtime deletion. */
export class LinuxOciPhysicalSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #timeout: number;
  readonly #assertBinary: () => void;
  #buffer = Buffer.alloc(0);
  #pending: Pending | undefined;
  #usable = true;
  #admissionClosed = false;
  #createAttempted = false;
  #createSent = false;
  #startAttempted = false;
  #startSent = false;
  #initStopAttempted = false;
  #initStopSent = false;
  #initIdentity: LinuxOciInitReapedObservation | undefined;
  #namespaceReleaseAttempted = false;
  #namespaceReleaseSent = false;
  #namespaceLifetime: LinuxOciNamespaceLifetimeObservation | undefined;
  #trackedJoinAttempted = false;
  #trackedJoinSent = false;
  #trackedDestructionKnown = false;
  #bornDeleteAttempted = false;
  #bornDeleteSent = false;
  #bornDeleteKnown = false;
  #bornDisposalAttempted = false;
  #bornDisposalSent = false;
  #localDisposalReply = false;
  #localDisposalObserved = false;
  #disposedLocalClosed = false;
  #claim: string | undefined;
  #identity: LinuxOciStoppedObservation | undefined;
  #mustRetain = false;
  #releasedUncreated = false;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #closed = false;
  #stderr = 0;
  #cancelPromise: Promise<LinuxOciCancelObservation> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #exitWaiters = new Set<() => void>();

  constructor(options: {
    readonly binary: string;
    readonly timeoutMs?: number;
  }) {
    this.#timeout = options.timeoutMs ?? 20_000;
    if (!integer(this.#timeout, 1, 60_000)) throw failure();
    this.#assertBinary = ownedExecutable(options.binary);
    this.#assertBinary();
    this.#child = spawn(options.binary, [], {
      env: Object.create(null),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#data(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length > STDERR_LIMIT - this.#stderr) this.#break();
      this.#stderr = Math.min(STDERR_LIMIT, this.#stderr + chunk.length);
    });
    this.#child.stdin.on("error", () => this.#break());
    this.#child.stdout.on("error", () => this.#break());
    this.#child.stderr.on("error", () => this.#break());
    this.#child.stdout.on("end", () => this.#end());
    this.#child.on("error", () => this.#break());
    this.#child.on("exit", (code, signal) => {
      this.#exit = { code, signal };
      if (code === 0 && signal === null) this.#end();
      else this.#break();
    });
    this.#child.on("close", () => {
      this.#closed = true;
      this.#end();
      for (const done of this.#exitWaiters) done();
    });
  }

  async createStopped(
    request: LinuxOciCreateStoppedRequest,
    signal: AbortSignal,
  ): Promise<LinuxOciStoppedObservation> {
    if (this.#createAttempted) throw failure("one_use");
    if (this.#admissionClosed || this.#pending || !this.#usable) throw failure();
    this.#createAttempted = true;
    const projected = project(request);
    this.#claim = projected.claimId;
    if (signal.aborted) throw failure();
    const reply = await this.#request("create", projected, signal);
    if (this.#admissionClosed || !this.#usable || reply.kind !== "linux-oci-created-stopped@1")
      throw failure();
    return reply;
  }

  async observeStopped(signal: AbortSignal): Promise<LinuxOciStoppedObservation> {
    if (
      !this.#identity ||
      this.#startAttempted ||
      this.#initStopAttempted ||
      this.#admissionClosed ||
      signal.aborted
    )
      throw failure();
    const reply = await this.#request("observe", { kind: "linux-oci-observe-stopped@1" }, signal);
    if (this.#admissionClosed || !this.#usable || reply.kind !== "linux-oci-stopped-observation@1")
      throw failure();
    return reply;
  }

  async startStopped(signal: AbortSignal): Promise<LinuxOciStartedObservation> {
    if (this.#startAttempted) throw failure("one_use");
    if (
      !this.#identity ||
      this.#initStopAttempted ||
      this.#admissionClosed ||
      this.#pending ||
      !this.#usable
    )
      throw failure();
    this.#startAttempted = true;
    if (signal.aborted) throw failure();
    const reply = await this.#request("start", { kind: "linux-oci-start@1" }, signal);
    if (this.#admissionClosed || !this.#usable || reply.kind !== "linux-oci-started@1")
      throw failure();
    return reply;
  }

  async observeStarted(signal: AbortSignal): Promise<LinuxOciStartedObservation> {
    if (
      !this.#identity ||
      !this.#startSent ||
      this.#initStopAttempted ||
      this.#admissionClosed ||
      signal.aborted
    )
      throw failure();
    const reply = await this.#request(
      "observe-started",
      { kind: "linux-oci-observe-started@1" },
      signal,
    );
    if (this.#admissionClosed || !this.#usable || reply.kind !== "linux-oci-started-observation@1")
      throw failure();
    return reply;
  }

  /** One original-init signal attempt. Only an exact-operation retained
   * refusal permits same child JOIN; frame/request refusal, abort, timeout,
   * and broken framing never resynchronize this stream.
   * The existing default response budget is 20 seconds (explicit timeoutMs
   * still overrides it). C JOIN polls for 10 seconds plus synchronous checks
   * and a separate frame-write deadline; no end-to-end bound is inferred. */
  async stopInit(signal: AbortSignal): Promise<LinuxOciInitReapedObservation> {
    if (this.#initStopAttempted) throw failure("one_use");
    if (!this.#identity || this.#admissionClosed || this.#pending || !this.#usable) throw failure();
    this.#initStopAttempted = true;
    if (signal.aborted) throw failure();
    const reply = await this.#request("stop-init", { kind: "linux-oci-stop-init@1" }, signal);
    if (
      signal.aborted ||
      this.#admissionClosed ||
      !this.#usable ||
      reply.kind !== "linux-oci-init-reaped@1"
    )
      throw failure();
    return reply;
  }

  async joinInit(signal: AbortSignal): Promise<LinuxOciInitReapedObservation> {
    if (!this.#identity || !this.#initStopSent || this.#admissionClosed || signal.aborted)
      throw failure();
    const reply = await this.#request("join-init", { kind: "linux-oci-join-init@1" }, signal);
    if (
      signal.aborted ||
      this.#admissionClosed ||
      !this.#usable ||
      reply.kind !== "linux-oci-init-reaped-observation@1"
    )
      throw failure();
    return reply;
  }

  /** One original-owner namespace release request, only after a positive
   * original init reap. Cancellation/lost framing consumes this attempt;
   * only decoded operation-bound retained refusal permits continuation. */
  async releaseNamespace(signal: AbortSignal): Promise<LinuxOciNamespaceLifetimeObservation> {
    if (this.#namespaceReleaseAttempted) throw failure("one_use");
    if (
      !this.#identity ||
      !this.#initIdentity ||
      this.#admissionClosed ||
      this.#pending ||
      !this.#usable
    )
      throw failure();
    this.#namespaceReleaseAttempted = true;
    if (signal.aborted) throw failure();
    const reply = await this.#request(
      "release-namespace",
      { kind: "linux-oci-release-namespace@1" },
      signal,
    );
    if (signal.aborted) {
      this.#break();
      throw failure();
    }
    if (
      this.#admissionClosed ||
      !this.#usable ||
      reply.kind !== "linux-oci-namespace-release-observation@1"
    )
      throw failure();
    return reply;
  }

  /** Continue recorded unperformed phases on this SAME child only. The C
   * owner decides them; no counter, flag or ACK resets a release attempt. */
  async continueNamespaceRelease(
    signal: AbortSignal,
  ): Promise<LinuxOciNamespaceLifetimeObservation> {
    if (
      !this.#identity ||
      !this.#initIdentity ||
      !this.#namespaceReleaseSent ||
      this.#admissionClosed ||
      signal.aborted
    )
      throw failure();
    const reply = await this.#request(
      "continue-namespace-release",
      { kind: "linux-oci-continue-namespace-release@1" },
      signal,
    );
    if (signal.aborted) {
      this.#break();
      throw failure();
    }
    if (
      this.#admissionClosed ||
      !this.#usable ||
      reply.kind !== "linux-oci-namespace-release-continuation@1"
    )
      throw failure();
    return reply;
  }

  /** Read the retained original ledger; never release again or turn born
   * custody into released-uncreated/successful close. */
  async observeNamespaceLifetime(
    signal: AbortSignal,
  ): Promise<LinuxOciNamespaceLifetimeObservation> {
    if (
      !this.#identity ||
      !this.#initIdentity ||
      !this.#namespaceReleaseSent ||
      this.#admissionClosed ||
      signal.aborted
    )
      throw failure();
    const reply = await this.#request(
      "observe-namespace-lifetime",
      { kind: "linux-oci-observe-namespace-lifetime@1" },
      signal,
    );
    if (signal.aborted) {
      this.#break();
      throw failure();
    }
    if (
      this.#admissionClosed ||
      !this.#usable ||
      reply.kind !== "linux-oci-namespace-lifetime-observation@1"
    )
      throw failure();
    return reply;
  }

  /** One handoff request, then only same-stream READ. No old namespace
   * observation may use the kernel context after its owner was detached. */
  beginTrackedJoin(signal: AbortSignal): Promise<LinuxOciRetirementObservation> {
    return this.#retirementRequest("begin-tracked-join", signal);
  }

  readTrackedJoin(signal: AbortSignal): Promise<LinuxOciRetirementObservation> {
    return this.#retirementRequest("read-tracked-join", signal);
  }

  /** One original runtime DELETE attempt. A decoded retained refusal only
   * permits joining the already requested child; it never permits re-DELETE. */
  deleteBorn(signal: AbortSignal): Promise<LinuxOciRetirementObservation> {
    return this.#retirementRequest("delete-born", signal);
  }

  joinBornDelete(signal: AbortSignal): Promise<LinuxOciRetirementObservation> {
    return this.#retirementRequest("join-born-delete", signal);
  }

  /** C may free its owner and end stdout immediately after this closed reply.
   * That expected end does not qualify helper-child exit or legacy close(). */
  disposeBorn(signal: AbortSignal): Promise<LinuxOciRetirementObservation> {
    return this.#retirementRequest("dispose-born", signal);
  }

  continueBornDisposal(signal: AbortSignal): Promise<LinuxOciRetirementObservation> {
    return this.#retirementRequest("continue-born-disposal", signal);
  }

  async #retirementRequest(
    operation: RetirementOperation,
    signal: AbortSignal,
  ): Promise<LinuxOciRetirementObservation> {
    if (
      !this.#identity ||
      !this.#initIdentity ||
      !this.#namespaceReleaseSent ||
      this.#admissionClosed ||
      this.#pending ||
      !this.#usable ||
      this.#localDisposalReply
    )
      throw failure();
    if (operation === "begin-tracked-join") {
      if (this.#trackedJoinAttempted) throw failure("one_use");
      this.#trackedJoinAttempted = true;
    } else if (!this.#trackedJoinSent) throw failure();
    if (operation === "read-tracked-join" && this.#bornDeleteAttempted) throw failure();
    if (operation === "delete-born") {
      if (this.#bornDeleteAttempted) throw failure("one_use");
      if (!this.#trackedDestructionKnown) throw failure();
      this.#bornDeleteAttempted = true;
    }
    if (operation === "join-born-delete" && !this.#bornDeleteSent) throw failure();
    if (operation === "dispose-born") {
      if (this.#bornDisposalAttempted) throw failure("one_use");
      if (!this.#bornDeleteKnown) throw failure();
      this.#bornDisposalAttempted = true;
    } else if (this.#bornDisposalAttempted && operation !== "continue-born-disposal")
      throw failure();
    if (operation === "continue-born-disposal" && !this.#bornDisposalSent) throw failure();
    if (signal.aborted) throw failure();
    const reply = await this.#request(operation, { kind: RETIREMENT[operation][0] }, signal);
    if (signal.aborted) {
      this.#break();
      throw failure();
    }
    if (
      this.#admissionClosed ||
      (!this.#usable && !this.#localDisposalReply) ||
      reply.kind !== RETIREMENT[operation][1]
    )
      throw failure();
    // Exact kind above is one of the closed two-field replies, never a grant.
    if ("nativeId" in reply || "custody" in reply) throw failure();
    if (operation === "dispose-born" || operation === "continue-born-disposal")
      this.#localDisposalObserved = true;
    return reply;
  }

  /** A local-only wait on this exact child, after its dedicated disposal
   * observation. Timeout/abort stop only this wait; a fresh caller can rejoin
   * the same handle. No wire operation, signal, unref or replacement occurs. */
  async joinDisposedHelper(signal: AbortSignal): Promise<LinuxOciDisposedHelperObservation> {
    if (
      !this.#localDisposalObserved ||
      !this.#localDisposalReply ||
      this.#admissionClosed ||
      signal.aborted
    )
      throw failure("custody_retained");
    if (!this.#closed)
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.#exitWaiters.delete(done);
          signal.removeEventListener("abort", abort);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(failure("custody_retained"));
        };
        const timer = setTimeout(abort, this.#timeout);
        this.#exitWaiters.add(done);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    // No await after this original local observation/cancellation fence.
    if (
      signal.aborted ||
      this.#admissionClosed ||
      !this.#localDisposalObserved ||
      !this.#localDisposalReply ||
      !this.#closed ||
      this.#exit?.code !== 0 ||
      this.#exit.signal !== null
    )
      throw failure("custody_retained");
    return Object.freeze({ kind: "linux-oci-disposed-helper-exit@1", barrier: "unproven" });
  }

  /** Local closure of this same disposed child only. Rechecks the private
   * disposal and actual exit/close facts on every call; no wire or child action. */
  async closeDisposedHelper(): Promise<void> {
    if (
      (!this.#disposedLocalClosed && this.#admissionClosed) ||
      !this.#localDisposalObserved ||
      !this.#localDisposalReply ||
      this.#pending !== undefined ||
      !this.#closed ||
      this.#exit?.code !== 0 ||
      this.#exit.signal !== null
    )
      throw failure("custody_retained");
    // No await after the original private facts. This seal only permits a
    // repeated local close, and never substitutes for those facts above.
    this.#disposedLocalClosed = true;
    this.#admissionClosed = true;
  }

  cancel(): Promise<LinuxOciCancelObservation> {
    this.#admissionClosed = true;
    this.#cancelPromise ??= (async () => {
      await this.#pending?.done;
      const reply = await this.#request("cancel", {
        kind: "linux-oci-cancel@1",
      });
      this.#child.stdin.end();
      if (reply.kind !== "linux-oci-cancel-observation@1") throw failure();
      return reply;
    })();
    return this.#cancelPromise;
  }

  close(): Promise<void> {
    this.#admissionClosed = true;
    this.#closePromise ??= (async () => {
      try {
        if (!this.#releasedUncreated) await this.cancel();
      } catch {
        if (!this.#releasedUncreated || this.#mustRetain) throw failure("custody_retained");
      }
      if (!this.#releasedUncreated || this.#mustRetain) throw failure("custody_retained");
      this.#child.stdin.end();
      if (!this.#closed)
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            this.#exitWaiters.delete(done);
            resolve();
          };
          const timer = setTimeout(() => {
            this.#exitWaiters.delete(done);
            reject(failure("custody_retained"));
          }, this.#timeout);
          this.#exitWaiters.add(done);
        });
      if (this.#exit?.code !== 0 || this.#exit.signal !== null) throw failure("custody_retained");
    })();
    return this.#closePromise;
  }

  #end() {
    if (this.#localDisposalReply && !this.#pending && this.#buffer.length === 0) {
      this.#usable = false;
      return;
    }
    this.#break();
  }

  #break() {
    this.#usable = false;
    this.#localDisposalReply = false;
    this.#localDisposalObserved = false;
    this.#buffer = Buffer.alloc(0);
    if (this.#createSent && !this.#releasedUncreated) this.#mustRetain = true;
    this.#settle(undefined);
  }

  #settle(reply: Reply | undefined) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    pending.finish();
    if (reply) pending.resolve(reply);
    else pending.reject(failure());
  }

  #data(chunk: Buffer) {
    if (!this.#usable) {
      // exit can precede the final stdout bytes. A disposal reply followed by
      // expected end must still reject any later bytes before async resume.
      if (this.#localDisposalReply) this.#break();
      return;
    }
    if (!this.#pending || chunk.length > LIMIT + 4 - this.#buffer.length) {
      this.#break();
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length < 4) return;
    const length = this.#buffer.readUInt32BE(0);
    if (!length || length > LIMIT || this.#buffer.length > length + 4) {
      this.#break();
      return;
    }
    if (this.#buffer.length < length + 4) return;
    try {
      const reply = parseReply(this.#buffer.subarray(4));
      const operation = this.#pending.operation;
      if (reply.kind === "linux-oci-refused@1") {
        if (
          operation === "stop-init" ||
          operation === "join-init" ||
          operation === "release-namespace" ||
          operation === "continue-namespace-release" ||
          operation === "observe-namespace-lifetime" ||
          retirementOperation(operation)
        ) {
          if (reply.stage !== operation || reply.custody !== "retained") throw failure();
        } else if (
          reply.stage !== "frame" &&
          reply.stage !== "request" &&
          reply.stage !== operation
        )
          throw failure();
      } else if (
        reply.kind !==
        (retirementOperation(operation)
          ? RETIREMENT[operation][1]
          : operation === "create"
            ? "linux-oci-created-stopped@1"
            : operation === "observe"
              ? "linux-oci-stopped-observation@1"
              : operation === "start"
                ? "linux-oci-started@1"
                : operation === "observe-started"
                  ? "linux-oci-started-observation@1"
                  : operation === "stop-init"
                    ? "linux-oci-init-reaped@1"
                    : operation === "join-init"
                      ? "linux-oci-init-reaped-observation@1"
                      : operation === "release-namespace"
                        ? "linux-oci-namespace-release-observation@1"
                        : operation === "continue-namespace-release"
                          ? "linux-oci-namespace-release-continuation@1"
                          : operation === "observe-namespace-lifetime"
                            ? "linux-oci-namespace-lifetime-observation@1"
                            : "linux-oci-cancel-observation@1")
      )
        throw failure();
      if ("nativeId" in reply) {
        if (
          reply.nativeId !== this.#claim ||
          (this.#identity &&
            (reply.namespaceDevice !== this.#identity.namespaceDevice ||
              reply.namespaceInode !== this.#identity.namespaceInode))
        )
          throw failure();
        if ("pidNamespaceDevice" in reply) {
          if (
            !this.#initStopSent ||
            (this.#initIdentity &&
              (reply.pidNamespaceDevice !== this.#initIdentity.pidNamespaceDevice ||
                reply.pidNamespaceInode !== this.#initIdentity.pidNamespaceInode))
          )
            throw failure();
          this.#initIdentity = reply;
        }
        if ("netCookie" in reply) {
          const previous = this.#namespaceLifetime;
          if (
            !this.#namespaceReleaseSent ||
            !this.#initIdentity ||
            (previous &&
              (reply.netCookie !== previous.netCookie ||
                reply.releaseAttempted < previous.releaseAttempted ||
                reply.referenceReleased < previous.referenceReleased ||
                reply.netGone < previous.netGone ||
                reply.poisoned < previous.poisoned))
          )
            throw failure();
          this.#namespaceLifetime = reply;
        }
        if (operation === "create") {
          // The operation-kind check above already refused every other kind.
          // Repeat that same closed fact so TypeScript narrows this union.
          if (reply.kind !== "linux-oci-created-stopped@1") throw failure();
          this.#identity = reply;
          this.#mustRetain = true;
        }
      } else if (!("custody" in reply)) {
        if (operation === "read-tracked-join") this.#trackedDestructionKnown = true;
        if (operation === "delete-born" || operation === "join-born-delete")
          this.#bornDeleteKnown = true;
        if (operation === "dispose-born" || operation === "continue-born-disposal")
          this.#localDisposalReply = true;
      } else if (reply.custody === "retained") this.#mustRetain = true;
      else {
        if (this.#mustRetain || this.#identity) throw failure();
        this.#releasedUncreated = true;
      }
      this.#buffer = Buffer.alloc(0);
      this.#settle(reply);
    } catch {
      this.#break();
    }
  }

  #request(operation: Operation, value: unknown, signal?: AbortSignal): Promise<Reply> {
    if (
      !this.#usable ||
      this.#pending ||
      this.#localDisposalReply ||
      (this.#trackedJoinAttempted && operation !== "cancel" && !retirementOperation(operation))
    )
      return Promise.reject(failure());
    const body = Buffer.from(JSON.stringify(value));
    if (!body.length || body.length > LIMIT) return Promise.reject(failure("request"));
    const frame = Buffer.alloc(body.length + 4);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);
    return new Promise<Reply>((resolve, reject) => {
      let finish = () => {};
      const done = new Promise<void>((settled) => {
        finish = settled;
      });
      const abort = () => this.#break();
      const timer = setTimeout(abort, this.#timeout);
      this.#pending = {
        operation,
        resolve,
        reject,
        done,
        finish,
        abort,
        timer,
        signal,
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        this.#settle(undefined);
        return;
      }
      try {
        this.#assertBinary();
        if (operation === "create") this.#createSent = true;
        if (operation === "start") this.#startSent = true;
        if (operation === "stop-init") this.#initStopSent = true;
        if (operation === "release-namespace") this.#namespaceReleaseSent = true;
        if (operation === "begin-tracked-join") this.#trackedJoinSent = true;
        if (operation === "delete-born") this.#bornDeleteSent = true;
        if (operation === "dispose-born") this.#bornDisposalSent = true;
        this.#child.stdin.write(frame, (error) => {
          if (error) this.#break();
        });
      } catch {
        this.#break();
      }
    });
  }
}

export function createLinuxOciPhysicalSession(options: {
  readonly binary: string;
  readonly timeoutMs?: number;
}): LinuxOciPhysicalSession {
  return new LinuxOciPhysicalSession(options);
}
