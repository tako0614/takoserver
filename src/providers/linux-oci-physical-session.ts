import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, parse } from "node:path";
import { canonicalDigest } from "../json.ts";
import { parseStrictJson } from "../strict-json.ts";
import type { V2PrivateInputKey } from "../takoform-v2/private-inputs.ts";
import {
  decodeContainerSecretBytes,
  encodeContainerSecretBytes,
  encryptContainerSecretBytes,
  isContainerSecretKey,
} from "./container-secret-codec.ts";

const LIMIT = 1_048_576;
const STDERR_LIMIT = 65_536;
const INT_MAX = 2_147_483_647;
const CLAIM = /^[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RETIREMENT_PRODUCER_REVISION = "NCLOSE01";
const RUNTIME_APPLICATION_RECONSTRUCTION_PURPOSE =
  "takoserver.linux-oci-peer-runtime-application-owner-reconstruction@1";
function executableDigest(binary: string): string {
  const size = lstatSync(binary).size;
  if (!Number.isSafeInteger(size) || size < 1 || size > 64 * 1024 * 1024) throw failure("binary");
  return "sha256:" + createHash("sha256").update(readFileSync(binary)).digest("hex");
}
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
    generation: data.generation,
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

// Only the original P method below may install this synchronous one-use
// handoff. No caller-supplied ChildProcess/observation is accepted.
const parentHandoffs = new WeakMap<
  object,
  { readonly child: ChildProcessWithoutNullStreams; readonly current: () => void }
>();
const originalRuntimePeerSessions = new WeakSet<LinuxOciPhysicalSession>();

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
  #inputWrites = 0;
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
  #peerDetachState: "available" | "attempted" | "detached" | "unknown" = "available";
  #peerDetachPromise: Promise<void> | undefined;
  #peerDetachReject: ((error: Error) => void) | undefined;
  #peerDetachTimer: ReturnType<typeof setTimeout> | undefined;
  #releasedUncreated = false;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #closed = false;
  #stderr = 0;
  #cancelPromise: Promise<LinuxOciCancelObservation> | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #exitWaiters = new Set<() => void>();

  constructor(
    options: {
      readonly binary: string;
      readonly timeoutMs?: number;
    },
    originalParent?: object,
  ) {
    const handoff = originalParent === undefined ? undefined : parentHandoffs.get(originalParent);
    if (originalParent !== undefined) {
      if (!handoff) throw failure("parent_handoff");
      parentHandoffs.delete(originalParent);
    }
    this.#timeout = options.timeoutMs ?? 20_000;
    if (!integer(this.#timeout, 1, 60_000)) throw failure();
    this.#assertBinary = handoff?.current ?? ownedExecutable(options.binary);
    this.#assertBinary();
    this.#child =
      handoff?.child ??
      spawn(options.binary, [], {
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
      if (handoff) {
        this.#break();
        return;
      } // P is never the H exit oracle.
      this.#exit = { code, signal };
      if (code === 0 && signal === null) this.#end();
      else this.#break();
    });
    this.#child.on("close", () => {
      if (handoff) {
        this.#break();
        return;
      }
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

  /** No-effect synchronous bookend for the original controller after its last
   * awaited lease guard. Neither the local seal nor a returned DTO is a fact. */
  assertDisposedHelperClosed(): void {
    if (
      !this.#disposedLocalClosed ||
      !this.#admissionClosed ||
      !this.#localDisposalObserved ||
      !this.#localDisposalReply ||
      this.#pending !== undefined ||
      !this.#closed ||
      this.#exit?.code !== 0 ||
      this.#exit.signal !== null
    )
      throw failure("custody_retained");
  }

  /** Close original tracked-runtime admission and detach only its idle P stdin.
   * P/H remain alive; the caller must use the authenticated same-owner socket
   * before sending any subsequent H operation. */
  detachForPeerReconstruction(signal: AbortSignal): Promise<void> {
    if (
      !originalRuntimePeerSessions.has(this) ||
      !(signal instanceof AbortSignal) ||
      signal.aborted
    )
      return Promise.reject(failure("parent_peer_retained"));
    if (this.#peerDetachState === "detached") return Promise.resolve();
    if (this.#peerDetachState === "attempted")
      return this.#peerDetachPromise ?? Promise.reject(failure("parent_peer_retained"));
    if (this.#peerDetachState === "unknown") return Promise.reject(failure("parent_peer_retained"));
    if (
      !this.#usable ||
      !this.#mustRetain ||
      !this.#identity ||
      this.#pending !== undefined ||
      this.#inputWrites !== 0 ||
      this.#buffer.length !== 0 ||
      this.#exit !== undefined ||
      this.#closed ||
      this.#child.stdin.destroyed
    )
      return Promise.reject(failure("parent_peer_retained"));
    // A refusal above leaves the existing session usable for its current
    // admitted operation. Only the one-way detach attempt revokes admission.
    this.#admissionClosed = true;
    this.#peerDetachState = "attempted";
    this.#peerDetachPromise = new Promise<void>((resolve, reject) => {
      this.#peerDetachReject = reject;
      const stream = this.#child.stdin;
      const cleanup = () => {
        stream.removeListener("error", onError);
        stream.removeListener("close", onClose);
      };
      const unknown = () => {
        if (this.#peerDetachState !== "attempted") return;
        this.#peerDetachState = "unknown";
        if (this.#peerDetachTimer) clearTimeout(this.#peerDetachTimer);
        this.#peerDetachTimer = undefined;
        cleanup();
        const rejectPending = this.#peerDetachReject;
        this.#peerDetachReject = undefined;
        rejectPending?.(failure("parent_peer_retained"));
      };
      const onError = () => unknown();
      const onClose = () => {
        if (!stream.writableFinished) unknown();
      };
      const finished = () => {
        if (this.#peerDetachState !== "attempted") return;
        if (
          !this.#usable ||
          this.#exit !== undefined ||
          this.#closed ||
          stream.destroyed ||
          stream.errored !== null ||
          !stream.writableFinished
        ) {
          unknown();
          return;
        }
        this.#peerDetachState = "detached";
        if (this.#peerDetachTimer) clearTimeout(this.#peerDetachTimer);
        this.#peerDetachTimer = undefined;
        cleanup();
        this.#peerDetachReject = undefined;
        resolve();
      };
      stream.once("error", onError);
      stream.once("close", onClose);
      this.#peerDetachTimer = setTimeout(() => {
        unknown();
      }, this.#timeout);
      try {
        // This one-shot EOF is the runtime3 ownership handoff. Never call
        // cancel(), close(), signal P/H, or start a replacement process here.
        stream.end(finished);
      } catch {
        unknown();
      }
    });
    return this.#peerDetachPromise;
  }

  cancel(): Promise<LinuxOciCancelObservation> {
    if (this.#peerDetachState !== "available")
      return Promise.reject(failure("parent_peer_retained"));
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
    if (this.#peerDetachState !== "available")
      return Promise.reject(failure("parent_peer_retained"));
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
    if (this.#peerDetachState === "attempted") {
      this.#peerDetachState = "unknown";
      if (this.#peerDetachTimer) clearTimeout(this.#peerDetachTimer);
      this.#peerDetachTimer = undefined;
      const reject = this.#peerDetachReject;
      this.#peerDetachReject = undefined;
      reject?.(failure("parent_peer_retained"));
    }
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
      this.#peerDetachState !== "available" ||
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
        this.#inputWrites++;
        this.#child.stdin.write(frame, (error) => {
          this.#inputWrites = Math.max(0, this.#inputWrites - 1);
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

/** Only a session born from this module's original tracked-runtime P handoff can
 * consume the one-shot stdin detach used by live authenticated reconstruction. */
export function detachOriginalLinuxOciRuntimePeer(
  session: LinuxOciPhysicalSession,
  signal: AbortSignal,
): Promise<void> {
  if (!originalRuntimePeerSessions.has(session))
    return Promise.reject(failure("parent_peer_retained"));
  return session.detachForPeerReconstruction(signal);
}

/** Original P bootstrap facts only. The cookie is lossless, not H identity,
 * an accepted claim, a CREATE permission, or an authenticated reconnect. */
export interface LinuxOciParentBootstrapInfo {
  readonly kind:
    | "linux-oci-parent-bootstrap@1"
    | "linux-oci-parent-bootstrap@2"
    | "linux-oci-parent-bootstrap@3"
    | "linux-oci-parent-bootstrap@4"
    | "linux-oci-parent-bootstrap@5"
    | "linux-oci-parent-bootstrap@6";
  readonly peer?: LinuxOciParentPeerIdentity;
  readonly applicationOwner?: LinuxOciApplicationOwnerIdentity;
  readonly claimId: string;
  readonly generation: number;
  readonly listenerCookie: string;
  readonly barrier: "unproven";
}
/** Original v6.12 64-bit pidfs interval identity, never PID/name authority. */
export interface LinuxOciParentPeerIdentity {
  readonly kind: "linux-oci-parent-peer@1";
  readonly device: string;
  readonly inode: string;
  readonly bootId: string;
}
/** Original application process group, captured from P's actual stdin peer.
 * Readiness is nonconsuming process exit, never H wait, I/O join or removal. */
export interface LinuxOciApplicationOwnerIdentity {
  readonly kind: "linux-oci-application-owner@1";
  readonly device: string;
  readonly inode: string;
  readonly bootId: string;
}
export interface LinuxOciApplicationOwnerExit
  extends Omit<LinuxOciApplicationOwnerIdentity, "kind"> {
  readonly kind: "linux-oci-parent-application-owner-exited@1";
  readonly barrier: "unproven";
}
export interface LinuxOciParentHResult {
  readonly kind: "linux-oci-parent-h-exited@1" | "linux-oci-parent-h-result-refused@1";
  readonly error: number;
  readonly barrier: "unproven";
}
interface ParentBootstrapPending {
  readonly resolve: (info: LinuxOciParentBootstrapInfo) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

/** Internal opt-in transport for a fresh original P only. Retain this object
 * even on failure: it owns that original child, and never kills, replaces,
 * closes its stdin, or turns P exit into the direct H exit oracle. This unit
 * supplies same-P CREATE after the original creator seals its claim. It
 * supplies no authenticated reconnect, result reader or SQL operation. */
export class LinuxOciParentBootstrap {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #assertBinary: () => void;
  readonly #timeout: number;
  readonly #claim: string;
  readonly #generation: number;
  readonly #capability: Buffer;
  readonly #binary: string;
  readonly #runtimeBinaryDigest: string | undefined;
  readonly #binaryIdentity: Readonly<{
    path: string;
    dev: number;
    ino: number;
    uid: number;
    mode: number;
  }>;
  readonly #lifetime: AbortSignal | undefined;
  readonly #peerProfile: boolean;
  readonly #runtimeFirst: boolean;
  readonly #localCleanup: boolean;
  readonly #applicationProfile: boolean;
  readonly #runtimeApplicationProfile: boolean;
  readonly #bootstrapVersion: 1 | 2 | 3 | 4 | 5 | 6;
  #retirementProducer: Readonly<{ revision: string; digest: string }> | undefined;
  #applicationOwner: LinuxOciApplicationOwnerIdentity | undefined;
  #peer: LinuxOciParentPeerIdentity | undefined;
  #peerConnector: ChildProcessWithoutNullStreams | undefined;
  #peerReadUnknown = false;
  #peerProcessLost = false;
  #handoff = false;
  #createAttempted = false;
  #created = false;
  #sealAttempted = false;
  #buffer = Buffer.alloc(0);
  #pending: ParentBootstrapPending | undefined;
  #signal: AbortSignal | undefined;
  #info: LinuxOciParentBootstrapInfo | undefined;
  #attempted = false;
  #usable = true;
  #written = false;
  #bootstrapped = false;
  #stderr = 0;

  constructor(options: {
    readonly binary: string;
    readonly peerProfile?:
      | "pidfs64@1"
      | "pidfs64-runtime@1"
      | "pidfs64-local-cleanup@1"
      | "pidfs64-application-owner@1"
      | "pidfs64-runtime-application-owner@1";
    readonly qualifiedPhysicalDigest?: string;
    readonly claimId: string;
    readonly generation: number;
    readonly capability: Uint8Array;
    readonly timeoutMs?: number;
    readonly lifetimeSignal?: AbortSignal;
  }) {
    if (
      options.peerProfile !== undefined &&
      options.peerProfile !== "pidfs64@1" &&
      options.peerProfile !== "pidfs64-runtime@1" &&
      options.peerProfile !== "pidfs64-local-cleanup@1" &&
      options.peerProfile !== "pidfs64-application-owner@1" &&
      options.peerProfile !== "pidfs64-runtime-application-owner@1"
    )
      throw failure("parent_binding");
    this.#peerProfile = options.peerProfile !== undefined;
    const localApplicationProfile = options.peerProfile === "pidfs64-application-owner@1";
    this.#runtimeApplicationProfile = options.peerProfile === "pidfs64-runtime-application-owner@1";
    this.#applicationProfile = localApplicationProfile || this.#runtimeApplicationProfile;
    this.#localCleanup =
      localApplicationProfile || options.peerProfile === "pidfs64-local-cleanup@1";
    this.#runtimeFirst =
      this.#localCleanup ||
      this.#runtimeApplicationProfile ||
      options.peerProfile === "pidfs64-runtime@1";
    this.#bootstrapVersion = this.#runtimeApplicationProfile
      ? 6
      : localApplicationProfile
        ? 5
        : this.#localCleanup
          ? 4
          : this.#runtimeFirst
            ? 3
            : this.#peerProfile
              ? 2
              : 1;
    this.#claim = options.claimId;
    this.#generation = options.generation;
    this.#timeout = options.timeoutMs ?? 20_000;
    if (
      typeof this.#claim !== "string" ||
      !CLAIM.test(this.#claim) ||
      !integer(this.#generation, 1) ||
      !integer(this.#timeout, 1, 60_000) ||
      !(options.capability instanceof Uint8Array) ||
      options.capability.length !== 32
    )
      throw failure("parent_binding");
    this.#capability = Buffer.from(options.capability);
    if (!this.#capability.some((byte) => byte !== 0)) throw failure("parent_binding");
    const binary = options.binary;
    this.#binary = binary;
    this.#lifetime = options.lifetimeSignal;
    if (this.#lifetime?.aborted) throw failure("parent_retained");
    this.#assertBinary = ownedExecutable(binary);
    this.#assertBinary();
    const stat = lstatSync(binary);
    this.#binaryIdentity = Object.freeze({
      path: binary,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode,
    });
    this.#runtimeBinaryDigest =
      this.#runtimeFirst && !this.#localCleanup ? executableDigest(binary) : undefined;
    if (this.#runtimeApplicationProfile) {
      const qualifiedPhysicalDigest = options.qualifiedPhysicalDigest;
      if (
        typeof qualifiedPhysicalDigest !== "string" ||
        !DIGEST.test(qualifiedPhysicalDigest) ||
        this.#runtimeBinaryDigest !== qualifiedPhysicalDigest
      )
        throw failure("parent_binary");
    }
    this.#assertBinary();
    this.#child = spawn(
      binary,
      [
        this.#runtimeApplicationProfile
          ? "--persistent-parent-peer-runtime-application-owner"
          : localApplicationProfile
            ? "--persistent-parent-peer-application-owner"
            : this.#localCleanup
              ? "--persistent-parent-peer-local-cleanup"
              : this.#runtimeFirst
                ? "--persistent-parent-peer-runtime"
                : this.#peerProfile
                  ? "--persistent-parent-peer"
                  : "--persistent-parent",
      ],
      {
        env: Object.create(null),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child.stdout.on("data", (chunk: Buffer) => this.#data(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk) || chunk.length > STDERR_LIMIT - this.#stderr) this.#break();
      else this.#stderr += chunk.length;
    });
    this.#child.stdin.on("error", () => this.#break());
    this.#child.stdout.on("error", () => this.#break());
    this.#child.stderr.on("error", () => this.#break());
    this.#child.stdout.on("end", () => this.#break());
    this.#child.stderr.on("end", () => this.#break());
    this.#child.on("error", () => {
      this.#peerProcessLost = true;
      this.#break();
    });
    this.#child.on("exit", () => {
      this.#peerProcessLost = true;
      this.#break();
    });
    this.#child.on("close", () => {
      this.#peerProcessLost = true;
      this.#break();
    });
  }

  async bootstrap(signal: AbortSignal): Promise<LinuxOciParentBootstrapInfo> {
    if (this.#attempted) throw failure("one_use");
    this.#attempted = true;
    this.#signal = signal;
    this.#current(signal);
    const body = Buffer.alloc(112);
    body.write(`TKOBIND${this.#bootstrapVersion}`, 0, "ascii");
    body.write(this.#claim, 8, "ascii");
    body.writeBigUInt64BE(BigInt(this.#generation), 72);
    this.#capability.copy(body, 80);
    const frame = Buffer.alloc(body.length + 4);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);
    body.fill(0);
    const info = await new Promise<LinuxOciParentBootstrapInfo>((resolve, reject) => {
      const abort = () => this.#break();
      const timer = setTimeout(abort, this.#timeout);
      this.#pending = { resolve, reject, timer, signal, abort };
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.#current(signal);
        this.#child.stdin.write(frame, (error) => {
          frame.fill(0);
          if (error) this.#break();
          else {
            this.#written = true;
            this.#finish();
          }
        });
      } catch {
        frame.fill(0);
        this.#break();
      }
    });
    // A synchronous trailing frame/EOF/P-exit/abort after resolve still wins
    // before this async return. The caller must check again after its save.
    this.#current(signal);
    this.#bootstrapped = true;
    return info;
  }

  /** Original transport/current executable only, never an SQL/fresh-claim gate.
   * A later creator must call after durable save and before any first effect. */
  assertCurrent(signal: AbortSignal): void {
    this.#current(signal);
    if (!this.#bootstrapped) throw failure("parent_unprepared");
  }

  /** Ciphertext from THIS actual bootstrap/capability/executable only. A seal
   * is not a SQL save or CREATE grant; the original creator must await both. */
  async sealControlBinding(
    key: V2PrivateInputKey,
    scope: string,
    signal: AbortSignal,
    originalCreate: LinuxOciCreateStoppedRequest,
  ) {
    if (this.#peerProfile) throw failure("parent_profile");
    this.assertCurrent(signal);
    if (
      this.#sealAttempted ||
      !isContainerSecretKey(key.key) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key.id)
    )
      throw failure("parent_seal");
    this.#sealAttempted = true;
    const actual = project(originalCreate);
    if (actual.claimId !== this.#claim || actual.generation !== this.#generation)
      throw failure("parent_binding");
    const keyId = key.id,
      actualKey = key.key;
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(
      JSON.stringify({
        kind: "linux-oci-original-control@1",
        claimId: this.#claim,
        generation: this.#generation,
        listenerCookie: this.#info?.listenerCookie,
        capability: encodeContainerSecretBytes(this.#capability),
        executable: this.#binaryIdentity,
        // The request includes original loan secrets. Its unkeyed digest
        // belongs only inside this ciphertext, never in public AAD/Sql scope.
        createDigest: await canonicalDigest(actual),
      }),
    );
    try {
      const ciphertext = await encryptContainerSecretBytes(
        actualKey,
        nonce,
        plaintext,
        encoder.encode(scope),
      );
      this.assertCurrent(signal);
      return Object.freeze({
        keyId,
        nonce: encodeContainerSecretBytes(nonce),
        ciphertext: encodeContainerSecretBytes(new Uint8Array(ciphertext)),
      });
    } finally {
      plaintext.fill(0);
    }
  }

  /** Explicit new profile only; never silently seal a peer claim with v1 AAD. */
  async sealPeerControlBinding(
    key: V2PrivateInputKey,
    scope: string,
    signal: AbortSignal,
    originalCreate: LinuxOciCreateStoppedRequest,
    originalAllocation?: Readonly<Record<string, unknown>>,
  ) {
    this.assertCurrent(signal);
    const context = parseStrictJson(encoder.encode(scope), LIMIT);
    if (
      !this.#peerProfile ||
      !this.#peer ||
      (this.#applicationProfile && !this.#applicationOwner) ||
      (this.#runtimeApplicationProfile && !this.#retirementProducer) ||
      this.#sealAttempted ||
      !record(context) ||
      context.purpose !== "takoserver.linux-oci-parent-peer-control@1" ||
      !isContainerSecretKey(key.key) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key.id)
    )
      throw failure("parent_seal");
    this.#sealAttempted = true;
    const actual = project(originalCreate);
    if (actual.claimId !== this.#claim || actual.generation !== this.#generation)
      throw failure("parent_binding");
    const keyId = key.id,
      actualKey = key.key;
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(
      JSON.stringify({
        kind: "linux-oci-original-peer-control@1",
        claimId: this.#claim,
        generation: this.#generation,
        listenerCookie: this.#info?.listenerCookie,
        capability: encodeContainerSecretBytes(this.#capability),
        executable: this.#binaryIdentity,
        peer: this.#peer,
        ...(this.#retirementProducer ? { retirementProducer: this.#retirementProducer } : {}),
        ...(this.#applicationProfile ? { applicationOwner: this.#applicationOwner } : {}),
        createDigest: await canonicalDigest(actual),
        ...(originalAllocation === undefined
          ? {}
          : {
              purpose: this.#runtimeApplicationProfile
                ? RUNTIME_APPLICATION_RECONSTRUCTION_PURPOSE
                : this.#applicationProfile
                  ? "takoserver.linux-oci-peer-application-owner-reconstruction@1"
                  : this.#localCleanup
                    ? "takoserver.linux-oci-peer-local-cleanup-reconstruction@1"
                    : this.#runtimeFirst
                      ? "takoserver.linux-oci-peer-runtime-reconstruction@1"
                      : "takoserver.linux-oci-peer-reconstruction@1",
              allocation: originalAllocation,
            }),
      }),
    );
    try {
      const ciphertext = await encryptContainerSecretBytes(
        actualKey,
        nonce,
        plaintext,
        encoder.encode(scope),
      );
      this.assertCurrent(signal);
      return Object.freeze({
        keyId,
        nonce: encodeContainerSecretBytes(nonce),
        ciphertext: encodeContainerSecretBytes(new Uint8Array(ciphertext)),
      });
    } finally {
      plaintext.fill(0);
    }
  }

  /** Fixed read-only connector, target-free: all identity/cap bytes come from
   * this original captured P. It does not recover a fresh creator's custody.
   * A connector's own exit0/close is transport closure, never H's exit oracle. */
  readPeerHResult(signal: AbortSignal): Promise<LinuxOciParentHResult> {
    if (
      !this.#peerProfile ||
      !this.#peer ||
      !this.#info ||
      !this.#bootstrapped ||
      this.#peerConnector ||
      this.#peerReadUnknown ||
      this.#peerProcessLost ||
      signal.aborted ||
      this.#lifetime?.aborted
    )
      return Promise.reject(failure("parent_peer_retained"));
    const owner = this;
    return readOriginalPeerResult(
      {
        runtimeFirst: this.#runtimeFirst,
        localCleanup: this.#localCleanup,
        binary: this.#binary,
        claim: this.#claim,
        generation: this.#generation,
        info: this.#info,
        peer: this.#peer,
        capability: this.#capability,
        lifetime: this.#lifetime,
        timeout: this.#timeout,
        assertBinary: () => this.#assertCurrentBinary(),
        get connector() {
          return owner.#peerConnector;
        },
        set connector(value) {
          owner.#peerConnector = value;
        },
        get unknown() {
          return owner.#peerReadUnknown;
        },
        set unknown(value) {
          owner.#peerReadUnknown = value;
        },
        get processLost() {
          return owner.#peerProcessLost;
        },
      },
      signal,
    );
  }

  async createStopped(request: LinuxOciCreateStoppedRequest, signal: AbortSignal) {
    this.assertCurrent(signal);
    if (this.#createAttempted) throw failure("one_use");
    this.#createAttempted = true;
    const actual = project(request);
    if (actual.claimId !== this.#claim || actual.generation !== this.#generation)
      throw failure("parent_binding");
    this.#handoff = true;
    parentHandoffs.set(this, {
      child: this.#child,
      current: () => this.#current(this.#lifetime ?? signal),
    });
    let session: LinuxOciPhysicalSession;
    try {
      session = new LinuxOciPhysicalSession(
        { binary: this.#binary, timeoutMs: this.#timeout },
        this,
      );
    } finally {
      parentHandoffs.delete(this);
    }
    const observation = await session.createStopped(request, signal);
    this.assertCurrent(signal);
    this.#created = true;
    if (this.#runtimeFirst && !this.#localCleanup) originalRuntimePeerSessions.add(session);
    return Object.freeze({ session, observation });
  }

  /** Compare decrypted data with THIS original live bootstrap. This is not a
   * restart peer proof and cannot adopt a P from an endpoint or decoded DTO. */
  verifySealedControl(value: unknown, signal: AbortSignal): void {
    this.assertCurrent(signal);
    const keys = [
      "kind",
      "claimId",
      "generation",
      "listenerCookie",
      "capability",
      "executable",
      "createDigest",
    ];
    if (
      !record(value) ||
      Reflect.ownKeys(value).length !== keys.length ||
      !keys.every((key) =>
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"),
      ) ||
      value.kind !== "linux-oci-original-control@1" ||
      value.claimId !== this.#claim ||
      value.generation !== this.#generation ||
      value.listenerCookie !== this.#info?.listenerCookie ||
      !this.#sealAttempted ||
      typeof value.capability !== "string" ||
      typeof value.createDigest !== "string" ||
      !DIGEST.test(value.createDigest) ||
      !record(value.executable)
    )
      throw failure("parent_binding");
    const executable = value.executable,
      names = ["path", "dev", "ino", "uid", "mode"] as const;
    if (
      Reflect.ownKeys(executable).length !== names.length ||
      !names.every(
        (key) =>
          Object.hasOwn(Object.getOwnPropertyDescriptor(executable, key) ?? {}, "value") &&
          executable[key] === this.#binaryIdentity[key],
      )
    )
      throw failure("parent_binding");
    const capability = decodeContainerSecretBytes(value.capability);
    try {
      if (capability.length !== 32) throw failure("parent_binding");
      let difference = 0;
      for (let i = 0; i < 32; i++) difference |= capability[i]! ^ this.#capability[i]!;
      if (difference) throw failure("parent_binding");
      this.assertCurrent(signal);
    } finally {
      capability.fill(0);
    }
  }

  /** Only after original CREATE, bindNative and fresh same-Sql guard. This
   * detaches the completed temporary loan, never creator-lifetime cancellation.
   * Failed/aborted CREATE cannot get here or reset any one-use/UNKNOWN latch. */
  finishCreateScope(signal: AbortSignal): void {
    this.assertCurrent(signal);
    if (!this.#created || !this.#lifetime || this.#lifetime.aborted)
      throw failure("parent_retained");
    this.#signal = undefined;
  }

  #current(signal: AbortSignal): void {
    if (!this.#usable || signal.aborted || this.#signal?.aborted || this.#lifetime?.aborted)
      throw failure("parent_retained");
    try {
      this.#assertCurrentBinary();
    } catch {
      this.#break();
      throw failure("parent_binary");
    }
  }

  #assertCurrentBinary(): void {
    this.#assertBinary();
    const digest = this.#runtimeApplicationProfile
      ? this.#runtimeBinaryDigest
      : this.#retirementProducer?.digest;
    if (digest !== undefined) {
      if (executableDigest(this.#binary) !== digest) throw failure("parent_binary");
      this.#assertBinary();
    }
  }

  #break(): void {
    this.#usable = false;
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    pending.reject(failure("parent_retained"));
  }

  #data(chunk: Buffer): void {
    if (!this.#usable || this.#handoff) return;
    try {
      const extendedRuntime = this.#bootstrapVersion === 3;
      const expectedLength = this.#runtimeApplicationProfile
        ? 164
        : this.#applicationProfile
          ? 156
          : this.#peerProfile
            ? 140
            : 88;
      const maximum = extendedRuntime ? 148 : expectedLength;
      if (
        !this.#pending ||
        !Buffer.isBuffer(chunk) ||
        chunk.length > maximum + 4 - this.#buffer.length
      )
        throw failure();
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.length < 4) return;
      const length = this.#buffer.readUInt32BE(0);
      if (
        (length !== expectedLength && !(extendedRuntime && length === 148)) ||
        this.#buffer.length > length + 4
      )
        throw failure();
      if (this.#buffer.length < length + 4) return;
      const body = this.#buffer.subarray(4);
      if (this.#runtimeApplicationProfile || (extendedRuntime && length === 148)) {
        const markerOffset = this.#runtimeApplicationProfile ? 156 : 140;
        if (!body.subarray(markerOffset).equals(Buffer.from(RETIREMENT_PRODUCER_REVISION, "ascii")))
          throw failure();
        this.#assertBinary();
        const digest = this.#runtimeBinaryDigest;
        if (digest === undefined || executableDigest(this.#binary) !== digest) throw failure();
        this.#retirementProducer = Object.freeze({
          revision: RETIREMENT_PRODUCER_REVISION,
          digest,
        });
        this.#assertBinary();
      }
      const cookie = body.readBigUInt64BE(80);
      if (
        !body.subarray(0, 8).equals(Buffer.from(`TKOINFO${this.#bootstrapVersion}`, "ascii")) ||
        !body.subarray(8, 72).equals(Buffer.from(this.#claim, "ascii")) ||
        body.readBigUInt64BE(72) !== BigInt(this.#generation) ||
        cookie === 0n
      )
        throw failure();
      if (this.#peerProfile) {
        const bootBytes = body.subarray(104, 140),
          bootId = bootBytes.toString("ascii");
        const device = body.readBigUInt64BE(88),
          inode = body.readBigUInt64BE(96);
        if (
          !inode ||
          (this.#runtimeApplicationProfile &&
            (!device || bootId === "00000000-0000-0000-0000-000000000000")) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId) ||
          !bootBytes.equals(Buffer.from(bootId, "ascii"))
        )
          throw failure();
        this.#peer = Object.freeze({
          kind: "linux-oci-parent-peer@1",
          device: device.toString(),
          inode: inode.toString(),
          bootId,
        });
      }
      if (this.#applicationProfile) {
        const device = body.readBigUInt64BE(140),
          inode = body.readBigUInt64BE(148);
        if (!inode || !this.#peer || (this.#runtimeApplicationProfile && !device)) throw failure();
        this.#applicationOwner = Object.freeze({
          kind: "linux-oci-application-owner@1",
          device: device.toString(),
          inode: inode.toString(),
          bootId: this.#peer.bootId,
        });
      }
      this.#info = Object.freeze({
        kind: `linux-oci-parent-bootstrap@${this.#bootstrapVersion}` as const,
        ...(this.#peer ? { peer: this.#peer } : {}),
        ...(this.#applicationOwner ? { applicationOwner: this.#applicationOwner } : {}),
        claimId: this.#claim,
        generation: this.#generation,
        listenerCookie: cookie.toString(10),
        barrier: "unproven",
      });
      this.#finish();
    } catch {
      this.#break();
    }
  }

  #finish(): void {
    const pending = this.#pending;
    if (!pending || !this.#info || !this.#written) return;
    try {
      this.#current(pending.signal);
    } catch {
      this.#break();
      return;
    }
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(this.#info);
  }
}

export function createLinuxOciParentBootstrap(
  options: ConstructorParameters<typeof LinuxOciParentBootstrap>[0],
): LinuxOciParentBootstrap {
  return new LinuxOciParentBootstrap(options);
}

/** Internal transport state; facts come from the original bootstrap or from
 * the owning Core's authenticated capture + actual-file bridge. Neither this
 * type nor the returned unproven result is an accepted/removed authority. */
interface OriginalPeerReaderState {
  readonly runtimeFirst: boolean;
  readonly localCleanup: boolean;
  readonly applicationOwner?: LinuxOciApplicationOwnerIdentity;
  readonly binary: string;
  readonly claim: string;
  readonly generation: number;
  readonly info: { readonly listenerCookie: string };
  readonly peer: LinuxOciParentPeerIdentity;
  readonly capability: Buffer;
  readonly lifetime: AbortSignal | undefined;
  readonly timeout: number;
  readonly assertBinary: () => void;
  readonly processLost: boolean;
  connector: ChildProcessWithoutNullStreams | undefined;
  unknown: boolean;
}
function parseOriginalPeerHResult(body: Buffer): LinuxOciParentHResult {
  const value = parseStrictJson(body, 512);
  if (JSON.stringify(value) !== new TextDecoder("utf-8", { fatal: true }).decode(body))
    throw failure();
  if (
    !record(value) ||
    Reflect.ownKeys(value).length !== 3 ||
    !["kind", "error", "barrier"].every((k) =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, k) ?? {}, "value"),
    ) ||
    (value.kind !== "linux-oci-parent-h-exited@1" &&
      value.kind !== "linux-oci-parent-h-result-refused@1") ||
    !integer(value.error, 0, 2147483647) ||
    value.barrier !== "unproven" ||
    (value.kind === "linux-oci-parent-h-exited@1" ? value.error !== 0 : value.error === 0)
  )
    throw failure();
  return Object.freeze({ kind: value.kind, error: value.error, barrier: "unproven" });
}
function readOriginalPeerResult(state: OriginalPeerReaderState, signal: AbortSignal) {
  return readOriginalPeerTransport(
    state,
    signal,
    "--parent-peer-read-result",
    parseOriginalPeerHResult,
  );
}
function readOriginalPeerTransport<T>(
  state: OriginalPeerReaderState,
  signal: AbortSignal,
  argument:
    | "--parent-peer-read-result"
    | "--parent-peer-read-application-owner"
    | "--parent-peer-read-live-init",
  parse: (body: Buffer) => T,
): Promise<T> {
  state.assertBinary();
  const frame = originalPeerConnectorFrame(state);
  const child = spawn(state.binary, [argument], {
    env: Object.create(null),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  state.connector = child;
  return new Promise<T>((resolve, reject) => {
    let buffer = Buffer.alloc(0),
      written = false,
      ended = false,
      errorsEnded = false,
      exited = false,
      closed = false,
      code: number | null = null,
      exitSignal: NodeJS.Signals | null = null,
      errorBytes = 0,
      finished = false;
    const stop = () => {
      state.unknown = true;
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      state.lifetime?.removeEventListener("abort", stop);
      frame.fill(0);
      reject(failure("parent_peer_retained"));
    };
    const check = () => {
      if (finished || !written || !ended || !errorsEnded || !exited || !closed) return;
      try {
        if (
          signal.aborted ||
          state.lifetime?.aborted ||
          code !== 0 ||
          exitSignal !== null ||
          buffer.length < 5 ||
          buffer.readUInt32BE(0) !== buffer.length - 4
        )
          throw failure();
        state.assertBinary();
        const value = parse(buffer.subarray(4));
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        state.lifetime?.removeEventListener("abort", stop);
        state.connector = undefined;
        resolve(value);
      } catch {
        stop();
      }
    };
    const timer = setTimeout(stop, state.timeout);
    signal.addEventListener("abort", stop, { once: true });
    state.lifetime?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished) {
        if (chunk.length) stop();
        return;
      }
      if (!Buffer.isBuffer(chunk) || chunk.length > 516 - buffer.length) {
        stop();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (
        buffer.length >= 4 &&
        (!buffer.readUInt32BE(0) ||
          buffer.readUInt32BE(0) >= 512 ||
          buffer.length > buffer.readUInt32BE(0) + 4)
      )
        stop();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk) || chunk.length > STDERR_LIMIT - errorBytes) stop();
      else errorBytes += chunk.length;
    });
    child.stdout.on("end", () => {
      ended = true;
      check();
    });
    child.stderr.on("end", () => {
      errorsEnded = true;
      check();
    });
    child.on("exit", (value, signal) => {
      exited = true;
      code = value;
      exitSignal = signal;
      check();
    });
    child.on("close", (value, signal) => {
      closed = true;
      if (value !== code || signal !== exitSignal) stop();
      else check();
    });
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    try {
      if (signal.aborted || state.lifetime?.aborted) {
        stop();
        return;
      }
      state.assertBinary();
      child.stdin.write(frame, (error) => {
        frame.fill(0);
        if (error) stop();
        else {
          written = true;
          check();
        }
      });
    } catch {
      stop();
    }
  }).then((value) => {
    try {
      if (signal.aborted || state.lifetime?.aborted || state.unknown || state.processLost)
        throw failure("parent_peer_retained");
      state.assertBinary();
      return value;
    } catch (error) {
      state.unknown = true;
      throw error;
    }
  });
}

function positiveU64String(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}

/** Owning internal entrance after AEAD and original-files validation. This
 * constructs only a one-use read-only connector, never a Parent or H session.
 * Its input is data, not authority; the original same-Sql creator owns the
 * authenticated callsite and must recheck that scope around this interval. */
function authenticatedPeerState(binary: string, value: unknown, lifetime: AbortSignal) {
  const purpose = record(value) ? value.purpose : undefined;
  const runtimeApplicationOwner = purpose === RUNTIME_APPLICATION_RECONSTRUCTION_PURPOSE;
  const localApplicationOwner =
    purpose === "takoserver.linux-oci-peer-application-owner-reconstruction@1";
  const applicationProfile = runtimeApplicationOwner || localApplicationOwner;
  const keys = [
    ...(applicationProfile ? ["applicationOwner"] : []),
    ...(runtimeApplicationOwner || (record(value) && Object.hasOwn(value, "retirementProducer"))
      ? ["retirementProducer"]
      : []),
    "kind",
    "claimId",
    "generation",
    "listenerCookie",
    "capability",
    "executable",
    "peer",
    "createDigest",
    "purpose",
    "allocation",
  ];
  const exact = (v: unknown, names: readonly string[]): v is Record<string, unknown> =>
    record(v) &&
    Reflect.ownKeys(v).length === names.length &&
    names.every((k) => Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, "value"));
  if (
    !exact(value, keys) ||
    value.kind !== "linux-oci-original-peer-control@1" ||
    (purpose !== "takoserver.linux-oci-peer-reconstruction@1" &&
      purpose !== "takoserver.linux-oci-peer-runtime-reconstruction@1" &&
      purpose !== "takoserver.linux-oci-peer-local-cleanup-reconstruction@1" &&
      !applicationProfile) ||
    typeof value.claimId !== "string" ||
    !CLAIM.test(value.claimId) ||
    !integer(value.generation, 1) ||
    !positiveU64String(value.listenerCookie) ||
    typeof value.capability !== "string" ||
    typeof value.createDigest !== "string" ||
    !DIGEST.test(value.createDigest) ||
    !exact(value.executable, ["path", "dev", "ino", "uid", "mode"]) ||
    !exact(value.peer, ["kind", "device", "inode", "bootId"]) ||
    value.peer.kind !== "linux-oci-parent-peer@1" ||
    !positiveU64String(value.peer.device) ||
    !positiveU64String(value.peer.inode) ||
    typeof value.peer.bootId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.peer.bootId) ||
    value.peer.bootId === "00000000-0000-0000-0000-000000000000" ||
    lifetime.aborted
  )
    throw failure("parent_binding");
  const originalBinary = ownedExecutable(binary),
    stat = lstatSync(binary),
    executable = value.executable;
  const producer = value.retirementProducer;
  let producerDigest: string | undefined;
  if (producer !== undefined || runtimeApplicationOwner) {
    if (
      (!runtimeApplicationOwner &&
        purpose !== "takoserver.linux-oci-peer-runtime-reconstruction@1") ||
      !exact(producer, ["revision", "digest"]) ||
      producer.revision !== RETIREMENT_PRODUCER_REVISION ||
      typeof producer.digest !== "string" ||
      !DIGEST.test(producer.digest)
    )
      throw failure("parent_binding");
    producerDigest = producer.digest;
  }
  const assertBinary = () => {
    originalBinary();
    if (producerDigest !== undefined && executableDigest(binary) !== producerDigest)
      throw failure("parent_binary");
    originalBinary();
  };
  assertBinary();
  if (
    executable.path !== binary ||
    executable.dev !== stat.dev ||
    executable.ino !== stat.ino ||
    executable.uid !== stat.uid ||
    executable.mode !== stat.mode
  )
    throw failure("parent_binding");
  const capability = Buffer.from(decodeContainerSecretBytes(value.capability));
  if (capability.length !== 32 || !capability.some((b) => b !== 0)) {
    capability.fill(0);
    throw failure("parent_binding");
  }
  const peer: LinuxOciParentPeerIdentity = Object.freeze({
    kind: "linux-oci-parent-peer@1",
    device: value.peer.device,
    inode: value.peer.inode,
    bootId: value.peer.bootId,
  });
  let applicationOwner: LinuxOciApplicationOwnerIdentity | undefined;
  if (applicationProfile) {
    if (
      !exact(value.applicationOwner, ["kind", "device", "inode", "bootId"]) ||
      value.applicationOwner.kind !== "linux-oci-application-owner@1" ||
      !positiveU64String(value.applicationOwner.device) ||
      !positiveU64String(value.applicationOwner.inode) ||
      value.applicationOwner.bootId !== peer.bootId
    )
      throw failure("parent_binding");
    applicationOwner = Object.freeze({
      kind: "linux-oci-application-owner@1",
      device: value.applicationOwner.device,
      inode: value.applicationOwner.inode,
      bootId: peer.bootId,
    });
  }
  const state: OriginalPeerReaderState = {
    ...(applicationOwner ? { applicationOwner } : {}),
    runtimeFirst: purpose !== "takoserver.linux-oci-peer-reconstruction@1",
    localCleanup:
      localApplicationOwner ||
      purpose === "takoserver.linux-oci-peer-local-cleanup-reconstruction@1",
    binary,
    claim: value.claimId,
    generation: value.generation,
    info: Object.freeze({ listenerCookie: value.listenerCookie }),
    peer,
    capability,
    lifetime,
    timeout: 20_000,
    assertBinary,
    processLost: false,
    connector: undefined,
    unknown: false,
  };
  return state;
}

export function prepareAuthenticatedLinuxOciPeerReader(
  binary: string,
  value: unknown,
  lifetime: AbortSignal,
) {
  const state = authenticatedPeerState(binary, value, lifetime),
    capability = state.capability,
    assertBinary = state.assertBinary;
  let attempted = false;
  return async (signal: AbortSignal) => {
    if (attempted || signal.aborted || lifetime.aborted) throw failure("parent_peer_retained");
    attempted = true;
    try {
      assertBinary();
      return await readOriginalPeerResult(state, signal);
    } finally {
      capability.fill(0);
    }
  };
}

/** Read-only process fact from the original P. No H oracle or I/O-close fact. */
export function prepareAuthenticatedLinuxOciApplicationOwnerReader(
  binary: string,
  value: unknown,
  lifetime: AbortSignal,
) {
  const state = authenticatedPeerState(binary, value, lifetime),
    owner = state.applicationOwner;
  if (!owner) throw failure("parent_binding");
  let attempted = false;
  return async (signal: AbortSignal): Promise<LinuxOciApplicationOwnerExit> => {
    if (attempted || signal.aborted || lifetime.aborted) throw failure("parent_peer_retained");
    attempted = true;
    try {
      return await readOriginalPeerTransport(
        state,
        signal,
        "--parent-peer-read-application-owner",
        (body) => {
          const v = parseStrictJson(body, 512);
          if (
            !record(v) ||
            Reflect.ownKeys(v).length !== 5 ||
            JSON.stringify(v) !== new TextDecoder("utf-8", { fatal: true }).decode(body) ||
            v.kind !== "linux-oci-parent-application-owner-exited@1" ||
            v.device !== owner.device ||
            v.inode !== owner.inode ||
            v.bootId !== owner.bootId ||
            v.barrier !== "unproven"
          )
            throw failure("parent_binding");
          return Object.freeze({
            kind: "linux-oci-parent-application-owner-exited@1",
            device: owner.device,
            inode: owner.inode,
            bootId: owner.bootId,
            barrier: "unproven",
          });
        },
      );
    } finally {
      state.capability.fill(0);
    }
  };
}

export interface LinuxOciOriginalLiveInit {
  readonly kind: "linux-oci-parent-live-init@1";
  readonly nativeId: string;
  readonly namespaceDevice: string;
  readonly namespaceInode: string;
  readonly barrier: "unproven";
}

/** Fresh init identity from the authenticated original P. This observation
 * grants no serving, cleanup, or retirement authority. */
export function prepareAuthenticatedLinuxOciLiveInitReader(
  binary: string,
  value: unknown,
  lifetime: AbortSignal,
) {
  if (
    !record(value) ||
    Object.getOwnPropertyDescriptor(value, "purpose")?.value !==
      RUNTIME_APPLICATION_RECONSTRUCTION_PURPOSE
  )
    throw failure("parent_binding");
  const state = authenticatedPeerState(binary, value, lifetime);
  let attempted = false;
  return async (signal: AbortSignal): Promise<LinuxOciOriginalLiveInit> => {
    if (attempted) throw failure("parent_peer_retained");
    attempted = true;
    try {
      if (signal.aborted || lifetime.aborted) throw failure("parent_peer_retained");
      return await readOriginalPeerTransport(
        state,
        signal,
        "--parent-peer-read-live-init",
        (body) => {
          const observation = parseStrictJson(body, 512);
          if (
            !record(observation) ||
            Reflect.ownKeys(observation).length !== 5 ||
            JSON.stringify(observation) !==
              new TextDecoder("utf-8", { fatal: true }).decode(body) ||
            observation.kind !== "linux-oci-parent-live-init@1" ||
            observation.nativeId !== state.claim ||
            !positiveU64String(observation.namespaceDevice) ||
            !positiveU64String(observation.namespaceInode) ||
            observation.barrier !== "unproven"
          )
            throw failure("parent_binding");
          return Object.freeze({
            kind: "linux-oci-parent-live-init@1",
            nativeId: state.claim,
            namespaceDevice: observation.namespaceDevice,
            namespaceInode: observation.namespaceInode,
            barrier: "unproven",
          });
        },
      );
    } finally {
      state.capability.fill(0);
    }
  };
}

function originalPeerConnectorFrame(state: OriginalPeerReaderState) {
  const frame = Buffer.alloc(176),
    peer = state.peer;
  frame.writeUInt32BE(172);
  frame.write("TKOPEER2", 4, "ascii");
  frame.write(state.claim, 12, "ascii");
  frame.writeBigUInt64BE(BigInt(state.generation), 76);
  frame.writeBigUInt64BE(BigInt(state.info.listenerCookie), 84);
  state.capability.copy(frame, 92);
  frame.writeBigUInt64BE(BigInt(peer.device), 124);
  frame.writeBigUInt64BE(BigInt(peer.inode), 132);
  frame.write(peer.bootId, 140, "ascii");
  return frame;
}

/** Past original P facts only. Delivery uncertainty stays a fact, never a new
 * effect permission; current Core authority is required after this interval. */
export interface LinuxOciPeerInitOutcome {
  readonly kind: "linux-oci-parent-outcome@1";
  readonly requestKind: number;
  readonly effects: number;
  readonly requestBytes: string;
  readonly issuedBytes: string;
  readonly deliveryUnknown: 0 | 1;
  readonly replyBytes: string;
  readonly barrier: "unproven";
}
export interface LinuxOciPeerInitProgress {
  readonly kind: "linux-oci-peer-init-progress@1";
  readonly operation:
    | "stop-init"
    | "join-init"
    | "release-namespace"
    | "continue-namespace-release"
    | RetirementOperation
    | "read-helper-result";
  readonly reply: Reply | LinuxOciParentHResult;
  readonly barrier: "unproven";
}
/** Owning internal two-stage connector. No caller-selected target or command;
 * The owning Core selects init or namespace routing after its fresh SQL guard.
 * Each route selects a fixed command from this connection's original past facts. */
export function prepareAuthenticatedLinuxOciPeerInit(
  binary: string,
  binding: unknown,
  lifetime: AbortSignal,
) {
  const state = authenticatedPeerState(binary, binding, lifetime);
  let started = false,
    sent = false,
    signal: AbortSignal | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let buffer = Buffer.alloc(0),
    outcome: LinuxOciPeerInitOutcome | undefined,
    captured: Reply | undefined;
  let reply: Reply | LinuxOciParentHResult | undefined,
    operation: LinuxOciPeerInitProgress["operation"] | undefined,
    phase: "outcome" | "paused" | "reply" | "done" = "outcome";
  let commandWritten = false,
    written = false,
    exited = false,
    ended = false,
    errorEnded = false,
    closed = false,
    finished = false,
    stderr = 0;
  let code: number | null = null,
    exitSignal: NodeJS.Signals | null = null;
  let resolveOutcome!: (v: LinuxOciPeerInitOutcome) => void, rejectOutcome!: (e: Error) => void;
  let resolveResult!: (v: LinuxOciPeerInitProgress) => void, rejectResult!: (e: Error) => void;
  const rawOutcome = new Promise<LinuxOciPeerInitOutcome>((yes, no) => {
    resolveOutcome = yes;
    rejectOutcome = no;
  });
  const rawResult = new Promise<LinuxOciPeerInitProgress>((yes, no) => {
    resolveResult = yes;
    rejectResult = no;
  });
  const current = () => {
    if (!started || state.unknown || signal?.aborted || lifetime.aborted)
      throw failure("parent_peer_retained");
    state.assertBinary();
  };
  const stop = () => {
    state.unknown = true;
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    lifetime.removeEventListener("abort", stop);
    state.capability.fill(0);
    rejectOutcome(failure("parent_peer_retained"));
    rejectResult(failure("parent_peer_retained"));
    // Only the short-lived connector stdin, never the original H pipe.
    try {
      state.connector?.stdin.end();
    } catch {
      /* retained UNKNOWN */
    }
  };
  const result = rawResult.then((value) => {
    current();
    return value;
  });
  const observed = rawOutcome.then((value) => {
    current();
    return value;
  });
  void result.catch(() => undefined);
  void observed.catch(() => undefined);
  const check = () => {
    if (
      finished ||
      !sent ||
      !commandWritten ||
      !written ||
      !exited ||
      !ended ||
      !errorEnded ||
      !closed
    )
      return;
    try {
      current();
      if (!reply || code !== 0 || exitSignal !== null || buffer.length) throw failure();
      finished = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      lifetime.removeEventListener("abort", stop);
      state.capability.fill(0);
      phase = "done";
      resolveResult(
        Object.freeze({
          kind: "linux-oci-peer-init-progress@1",
          operation: operation!,
          reply,
          barrier: "unproven",
        }),
      );
    } catch {
      stop();
    }
  };
  const frame = (): Buffer | undefined => {
    if (buffer.length < 4) return;
    const n = buffer.readUInt32BE(0);
    if (!n || n > LIMIT) throw failure();
    if (buffer.length < n + 4) return;
    const body = buffer.subarray(4, n + 4);
    buffer = buffer.subarray(n + 4);
    return body;
  };
  const data = () => {
    try {
      current();
      if (phase === "outcome") {
        if (!outcome) {
          const body = frame();
          if (!body) return;
          const v = parseStrictJson(body, 512);
          const keys = [
            "kind",
            "requestKind",
            "effects",
            "requestBytes",
            "issuedBytes",
            "deliveryUnknown",
            "replyBytes",
            "barrier",
          ];
          if (
            !record(v) ||
            Object.keys(v).length !== keys.length ||
            !keys.every((k) => Object.hasOwn(v, k)) ||
            JSON.stringify(v) !== decoder.decode(body) ||
            v.kind !== "linux-oci-parent-outcome@1" ||
            v.barrier !== "unproven" ||
            !integer(v.requestKind, 0, 16) ||
            !integer(v.effects, 0, 131070) ||
            (v.effects & ~131070) !== 0 ||
            !uint64(v.requestBytes) ||
            !uint64(v.issuedBytes) ||
            !uint64(v.replyBytes) ||
            !bit(v.deliveryUnknown) ||
            BigInt(v.requestBytes) > BigInt(LIMIT + 4) ||
            BigInt(v.issuedBytes) > BigInt(v.requestBytes) ||
            BigInt(v.replyBytes) > BigInt(LIMIT + 4) ||
            (v.replyBytes !== "0" && BigInt(v.replyBytes) < 5n)
          )
            throw failure();
          outcome = Object.freeze({
            kind: v.kind,
            requestKind: v.requestKind,
            effects: v.effects,
            requestBytes: v.requestBytes,
            issuedBytes: v.issuedBytes,
            deliveryUnknown: v.deliveryUnknown,
            replyBytes: v.replyBytes,
            barrier: "unproven",
          });
        }
        if (outcome.replyBytes !== "0" && !captured) {
          if (buffer.length < Number(outcome.replyBytes)) return;
          const amount = buffer.length,
            body = frame();
          if (!body || amount - buffer.length !== Number(outcome.replyBytes)) throw failure();
          captured = parseReply(body);
        }
        if (buffer.length) throw failure();
        if (written) {
          phase = "paused";
          resolveOutcome(outcome);
        }
        return;
      }
      if (phase === "reply") {
        const body = frame();
        if (!body) return;
        if (reply || buffer.length) throw failure();
        reply =
          operation === "read-helper-result" ? parseOriginalPeerHResult(body) : parseReply(body);
        if (operation !== "read-helper-result") {
          if (reply.kind === "linux-oci-refused@1") {
            if (reply.custody !== "retained" || reply.stage !== operation) throw failure();
          } else {
            const expected =
              operation === "stop-init"
                ? "linux-oci-init-reaped@1"
                : operation === "join-init"
                  ? "linux-oci-init-reaped-observation@1"
                  : operation === "release-namespace"
                    ? "linux-oci-namespace-release-observation@1"
                    : operation === "continue-namespace-release"
                      ? "linux-oci-namespace-release-continuation@1"
                      : operation && retirementOperation(operation)
                        ? RETIREMENT[operation][1]
                        : undefined;
            if (!expected || reply.kind !== expected) throw failure();
          }
        }
        if (
          "nativeId" in reply &&
          (reply.nativeId !== expectedNative ||
            (captured &&
              "namespaceDevice" in captured &&
              (reply.namespaceDevice !== captured.namespaceDevice ||
                reply.namespaceInode !== captured.namespaceInode)))
        )
          throw failure();
        if (
          "netCookie" in reply &&
          captured &&
          "netCookie" in captured &&
          (reply.netCookie !== captured.netCookie ||
            reply.releaseAttempted < captured.releaseAttempted ||
            reply.referenceReleased < captured.referenceReleased ||
            reply.netGone < captured.netGone ||
            reply.poisoned < captured.poisoned)
        )
          throw failure();
        check();
        return;
      }
      if (buffer.length) throw failure();
    } catch {
      stop();
    }
  };
  let expectedNative: string | undefined;
  const send = (nativeId: string) => {
    expectedNative = nativeId;
    sent = true;
    phase = "reply";
    const body = Buffer.from(
        JSON.stringify({
          kind:
            operation === "read-helper-result"
              ? "linux-oci-parent-read-result@1"
              : `linux-oci-${operation}@1`,
        }),
      ),
      request = Buffer.alloc(body.length + 4);
    request.writeUInt32BE(body.length);
    body.copy(request, 4);
    try {
      current();
      state.connector!.stdin.write(request, (error) => {
        if (error) stop();
        else {
          commandWritten = true;
          check();
        }
      });
    } catch {
      stop();
    }
    return result;
  };
  const advanceRetirement = (nativeId: string, actualSignal: AbortSignal) => {
    current();
    if (
      signal !== actualSignal ||
      sent ||
      phase !== "paused" ||
      !outcome ||
      !captured ||
      !CLAIM.test(nativeId) ||
      outcome.requestBytes === "0" ||
      outcome.requestBytes !== outcome.issuedBytes
    )
      throw failure("parent_peer_phase");
    const base = (1 << 1) | (1 << 4) | (1 << 6) | (1 << 8);
    const begin = 1 << 11,
      deletion = 1 << 13,
      disposal = 1 << 15;
    if (state.runtimeFirst) {
      const previous = captured;
      if (
        outcome.effects & ~(base | begin | deletion | disposal) ||
        !(outcome.effects & (1 << 6)) ||
        !(outcome.effects & (1 << 8)) ||
        (outcome.effects & begin && !(outcome.effects & deletion)) ||
        (outcome.effects & disposal && !(outcome.effects & begin))
      )
        throw failure("parent_peer_phase");
      const matched = (op: RetirementOperation) =>
        previous.kind === RETIREMENT[op][1] ||
        (previous.kind === "linux-oci-refused@1" &&
          previous.custody === "retained" &&
          previous.stage === op);
      const known = (op: RetirementOperation) => previous.kind === RETIREMENT[op][1];
      if (outcome.effects & disposal) {
        if (
          !(outcome.requestKind === 15 && matched("dispose-born")) &&
          !(outcome.requestKind === 16 && matched("continue-born-disposal"))
        )
          throw failure("parent_peer_phase");
        operation =
          known("dispose-born") || known("continue-born-disposal")
            ? "read-helper-result"
            : "continue-born-disposal";
      } else if (outcome.effects & begin) {
        if (outcome.requestKind === 11 && matched("begin-tracked-join")) {
          if (state.localCleanup && !known("begin-tracked-join"))
            throw failure("parent_peer_phase");
          operation = state.localCleanup ? "dispose-born" : "read-tracked-join";
        } else if (outcome.requestKind === 12 && matched("read-tracked-join"))
          operation = known("read-tracked-join") ? "dispose-born" : "read-tracked-join";
        else throw failure("parent_peer_phase");
      } else if (outcome.effects & deletion) {
        if (outcome.requestKind === 13 && matched("delete-born")) operation = "join-born-delete";
        else if (outcome.requestKind === 14 && matched("join-born-delete"))
          operation = known("join-born-delete") ? "begin-tracked-join" : "join-born-delete";
        else throw failure("parent_peer_phase");
      } else {
        if (
          ![8, 9].includes(outcome.requestKind) ||
          ![
            "linux-oci-namespace-release-observation@1",
            "linux-oci-namespace-release-continuation@1",
          ].includes(captured.kind) ||
          !("nativeId" in captured) ||
          captured.nativeId !== nativeId
        )
          throw failure("parent_peer_phase");
        operation = "delete-born";
      }
      return send(nativeId);
    }
    if (
      outcome.effects & ~(base | begin | deletion | disposal) ||
      !(outcome.effects & (1 << 6)) ||
      !(outcome.effects & (1 << 8)) ||
      (outcome.effects & deletion && !(outcome.effects & begin)) ||
      (outcome.effects & disposal && !(outcome.effects & deletion))
    )
      throw failure("parent_peer_phase");
    const previous = captured;
    const matched = (op: RetirementOperation) =>
      previous.kind === RETIREMENT[op][1] ||
      (previous.kind === "linux-oci-refused@1" &&
        previous.custody === "retained" &&
        previous.stage === op);
    const known = (op: RetirementOperation) => previous.kind === RETIREMENT[op][1];
    if (outcome.effects & disposal) {
      if (
        !(outcome.requestKind === 15 && matched("dispose-born")) &&
        !(outcome.requestKind === 16 && matched("continue-born-disposal"))
      )
        throw failure("parent_peer_phase");
      operation =
        known("dispose-born") || known("continue-born-disposal")
          ? "read-helper-result"
          : "continue-born-disposal";
    } else if (outcome.effects & deletion) {
      if (outcome.requestKind === 13 && matched("delete-born")) operation = "join-born-delete";
      else if (outcome.requestKind === 14 && matched("join-born-delete"))
        operation = known("join-born-delete") ? "dispose-born" : "join-born-delete";
      else throw failure("parent_peer_phase");
    } else if (outcome.effects & begin) {
      if (outcome.requestKind === 11 && matched("begin-tracked-join"))
        operation = "read-tracked-join";
      else if (outcome.requestKind === 12 && matched("read-tracked-join"))
        operation = known("read-tracked-join") ? "delete-born" : "read-tracked-join";
      else throw failure("parent_peer_phase");
    } else {
      if (
        outcome.requestKind !== 9 ||
        captured.kind !== "linux-oci-namespace-release-continuation@1" ||
        captured.nativeId !== nativeId
      )
        throw failure("parent_peer_phase");
      operation = "begin-tracked-join";
    }
    return send(nativeId);
  };
  return Object.freeze({
    outcome: observed,
    settlement: result,
    assertCurrent: current,
    begin(actualSignal: AbortSignal) {
      if (started || actualSignal.aborted || lifetime.aborted)
        throw failure("parent_peer_retained");
      started = true;
      signal = actualSignal;
      state.assertBinary();
      const child = spawn(binary, ["--parent-peer-manage-init"], {
        env: Object.create(null),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      state.connector = child;
      timer = setTimeout(stop, state.timeout);
      signal.addEventListener("abort", stop, { once: true });
      lifetime.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (!Buffer.isBuffer(chunk) || chunk.length > LIMIT + 1024 - buffer.length) {
          stop();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        data();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (!Buffer.isBuffer(chunk) || chunk.length > STDERR_LIMIT - stderr) stop();
        else stderr += chunk.length;
      });
      child.stdout.on("end", () => {
        ended = true;
        if (!sent) stop();
        else check();
      });
      child.stderr.on("end", () => {
        errorEnded = true;
        check();
      });
      child.on("exit", (value, s) => {
        exited = true;
        code = value;
        exitSignal = s;
        if (!sent) stop();
        else check();
      });
      child.on("close", (value, s) => {
        closed = true;
        if (value !== code || s !== exitSignal) stop();
        else check();
      });
      child.on("error", stop);
      child.stdin.on("error", stop);
      child.stdout.on("error", stop);
      child.stderr.on("error", stop);
      const bootstrap = originalPeerConnectorFrame(state);
      try {
        current();
        child.stdin.write(bootstrap, (error) => {
          bootstrap.fill(0);
          if (error) stop();
          else {
            written = true;
            data();
            check();
          }
        });
      } catch {
        bootstrap.fill(0);
        stop();
      }
      return observed;
    },
    advance(
      nativeId: string,
      actualSignal: AbortSignal,
      expectedStart?: "linux-oci-started@1" | "linux-oci-started-observation@1",
    ) {
      current();
      if (
        signal !== actualSignal ||
        sent ||
        phase !== "paused" ||
        !outcome ||
        !captured ||
        (expectedStart !== undefined && captured.kind !== expectedStart) ||
        !CLAIM.test(nativeId) ||
        outcome.requestBytes === "0" ||
        outcome.requestBytes !== outcome.issuedBytes
      )
        throw failure("parent_peer_phase");
      // Exact original completion facts fence routing; neither effects nor a
      // captured reply can replace the fresh owning Core guard.
      const allowed = (1 << 1) | (1 << 4) | (1 << 6);
      if (outcome.effects & ~allowed) throw failure("parent_peer_phase");
      if (outcome.effects & (1 << 6)) {
        if (
          ![6, 7].includes(outcome.requestKind) ||
          !(
            captured.kind === "linux-oci-init-reaped@1" ||
            captured.kind === "linux-oci-init-reaped-observation@1" ||
            (captured.kind === "linux-oci-refused@1" &&
              captured.custody === "retained" &&
              ["stop-init", "join-init"].includes(captured.stage))
          )
        )
          throw failure("parent_peer_phase");
        operation = "join-init";
      } else {
        if (
          !(outcome.effects & (1 << 1)) ||
          ![1, 2, 4, 5].includes(outcome.requestKind) ||
          ![
            "linux-oci-created-stopped@1",
            "linux-oci-stopped-observation@1",
            "linux-oci-started@1",
            "linux-oci-started-observation@1",
          ].includes(captured.kind)
        )
          throw failure("parent_peer_phase");
        operation = "stop-init";
      }
      if ("nativeId" in captured && captured.nativeId !== nativeId)
        throw failure("parent_peer_phase");
      return send(nativeId);
    },
    advanceNamespace(nativeId: string, actualSignal: AbortSignal) {
      current();
      if (
        signal !== actualSignal ||
        sent ||
        phase !== "paused" ||
        !outcome ||
        !captured ||
        !CLAIM.test(nativeId) ||
        outcome.requestBytes === "0" ||
        outcome.requestBytes !== outcome.issuedBytes
      )
        throw failure("parent_peer_phase");
      if (
        (state.runtimeFirst &&
          outcome.requestKind === 8 &&
          captured.kind === "linux-oci-namespace-release-observation@1") ||
        (outcome.requestKind === 9 &&
          captured.kind === "linux-oci-namespace-release-continuation@1") ||
        outcome.effects & ((1 << 11) | (1 << 13) | (1 << 15))
      )
        return advanceRetirement(nativeId, actualSignal);
      const allowed = (1 << 1) | (1 << 4) | (1 << 6) | (1 << 8);
      if (outcome.effects & ~allowed || !(outcome.effects & (1 << 6)))
        throw failure("parent_peer_phase");
      if (outcome.effects & (1 << 8)) {
        if (
          ![8, 9].includes(outcome.requestKind) ||
          !(
            captured.kind ===
              (outcome.requestKind === 8
                ? "linux-oci-namespace-release-observation@1"
                : "linux-oci-namespace-release-continuation@1") ||
            (captured.kind === "linux-oci-refused@1" &&
              captured.custody === "retained" &&
              captured.stage ===
                (outcome.requestKind === 8 ? "release-namespace" : "continue-namespace-release"))
          )
        )
          throw failure("parent_peer_phase");
        operation = "continue-namespace-release";
      } else {
        if (outcome.requestKind !== 7 || captured.kind !== "linux-oci-init-reaped-observation@1")
          throw failure("parent_peer_phase");
        operation = "release-namespace";
      }
      if ("nativeId" in captured && captured.nativeId !== nativeId)
        throw failure("parent_peer_phase");
      return send(nativeId);
    },
    advanceRetirement,
    /** This exact private connector has read THIS authenticated P's original
     * consuming H wait + two output EOF result; its own exit is only transport. */
    observeHelperExited(actualSignal: AbortSignal): LinuxOciParentHResult {
      current();
      if (
        signal !== actualSignal ||
        phase !== "done" ||
        !finished ||
        operation !== "read-helper-result" ||
        reply?.kind !== "linux-oci-parent-h-exited@1" ||
        reply.error !== 0
      )
        throw failure("parent_peer_phase");
      return reply;
    },
    /** Read only the observation produced by THIS completed original JOIN.
     * A STOP reply, public progress DTO or connector exit alone cannot supply it. */
    observeJoined(actualSignal: AbortSignal): LinuxOciInitReapedObservation {
      current();
      if (
        signal !== actualSignal ||
        phase !== "done" ||
        !finished ||
        operation !== "join-init" ||
        reply?.kind !== "linux-oci-init-reaped-observation@1"
      )
        throw failure("parent_peer_phase");
      if (
        captured &&
        "pidNamespaceDevice" in captured &&
        (reply.pidNamespaceDevice !== captured.pidNamespaceDevice ||
          reply.pidNamespaceInode !== captured.pidNamespaceInode)
      )
        throw failure("parent_peer_phase");
      return reply;
    },
    cancel: stop,
  });
}
