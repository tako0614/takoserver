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
export interface LinuxOciCancelObservation {
  readonly kind: "linux-oci-cancel-observation@1";
  readonly stage: "cancel";
  readonly errno: number;
  readonly custody: "released-uncreated" | "retained";
  readonly barrier: "unproven";
}
interface Refusal {
  readonly kind: "linux-oci-refused@1";
  readonly stage: "frame" | "request" | "create" | "observe" | "cancel";
  readonly errno: number;
  readonly custody: "released-uncreated" | "retained";
  readonly barrier: "unproven";
}
type Reply = LinuxOciStoppedObservation | LinuxOciCancelObservation | Refusal;
type Operation = "create" | "observe" | "cancel";
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
  return { kind: "linux-oci-create-stopped@1", ...data, claimId: data.claimId, args, env };
}

function parseReply(body: Buffer): Reply {
  const original = decoder.decode(body);
  const value: unknown = JSON.parse(original);
  if (!record(value) || value.barrier !== "unproven") throw failure();
  let reply: Reply;
  if (
    value.kind === "linux-oci-created-stopped@1" ||
    value.kind === "linux-oci-stopped-observation@1"
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
        value.stage !== "cancel"
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

  constructor(options: { readonly binary: string; readonly timeoutMs?: number }) {
    this.#timeout = options.timeoutMs ?? 20_000;
    if (!integer(this.#timeout, 1, 60_000)) throw failure();
    this.#assertBinary = ownedExecutable(options.binary);
    this.#assertBinary();
    this.#child = spawn(options.binary, [], {
      env: {},
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
    this.#child.stdout.on("end", () => this.#break());
    this.#child.on("error", () => this.#break());
    this.#child.on("exit", (code, signal) => {
      this.#exit = { code, signal };
      this.#break();
    });
    this.#child.on("close", () => {
      this.#closed = true;
      this.#break();
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
    if (!this.#identity || this.#admissionClosed || signal.aborted) throw failure();
    const reply = await this.#request("observe", { kind: "linux-oci-observe-stopped@1" }, signal);
    if (this.#admissionClosed || !this.#usable || reply.kind !== "linux-oci-stopped-observation@1")
      throw failure();
    return reply;
  }

  cancel(): Promise<LinuxOciCancelObservation> {
    this.#admissionClosed = true;
    this.#cancelPromise ??= (async () => {
      await this.#pending?.done;
      const reply = await this.#request("cancel", { kind: "linux-oci-cancel@1" });
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

  #break() {
    this.#usable = false;
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
    if (!this.#usable) return;
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
        if (reply.stage !== "frame" && reply.stage !== "request" && reply.stage !== operation)
          throw failure();
      } else if (
        reply.kind !==
        (operation === "create"
          ? "linux-oci-created-stopped@1"
          : operation === "observe"
            ? "linux-oci-stopped-observation@1"
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
        if (operation === "create") {
          this.#identity = reply;
          this.#mustRetain = true;
        }
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
    if (!this.#usable || this.#pending) return Promise.reject(failure());
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
      this.#pending = { operation, resolve, reject, done, finish, abort, timer, signal };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        this.#settle(undefined);
        return;
      }
      try {
        this.#assertBinary();
        if (operation === "create") this.#createSent = true;
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
