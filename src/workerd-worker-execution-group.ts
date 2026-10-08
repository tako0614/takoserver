import { createHash, randomUUID } from "node:crypto";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnWorkerdWithParentDeath, workerPortOwnership } from "./workerd-linux-process.ts";
import { createWorkerdSupervisor, type WorkerdProcess } from "./workerd-supervisor.ts";

const MANIFEST_NAME = "group.json";
const CONFIG_NAME = "workerd.conf";
const RECEIPT_NAME = "retirement.json";
const RECEIPT_TEMP_PREFIX = ".retirement-";
const DEPLOYMENT_MANIFEST_NAME = "deployment.json";
const DEPLOYMENT_PUBLICATIONS_NAME = ".publications";
const WORKER_POINTER_NAME = "takoserver-site.json";

/** Bun's native client socket has immediate termination in addition to DOM close. */
export type WorkerdBridgeMessage = string | ArrayBuffer | Uint8Array;
export type WorkerdNativeWebSocket = WebSocket & {
  terminate(): void;
  /** Stage native messages before the public upgrade, then drain in order. */
  forwardMessages(send: (value: WorkerdBridgeMessage) => void): void;
};
export const WORKER_ENDPOINT_ACTOR_SOCKET_LIMIT = 33_554_432;

export class WorkerdWorkerExecutionGroupError extends Error {
  readonly code:
    | "invalid_identity"
    | "identity_mismatch"
    | "ownership_uncertain"
    | "already_retired"
    | "admission_closed"
    | "not_serving"
    | "retirement_uncertain";

  constructor(code: WorkerdWorkerExecutionGroupError["code"]) {
    super(code);
    this.name = "WorkerdWorkerExecutionGroupError";
    this.code = code;
  }
}

export interface WorkerdWorkerRetirementReceipt {
  readonly workerResourceUid: string;
  readonly operationId: string;
  readonly listenerPort: number;
  readonly configurationSha256: string;
}

export interface WorkerdWorkerExecutionGroup {
  readonly workerResourceUid: string;
  /** Private root used by the WorkerdRuntime owned by this incarnation. */
  readonly runtimeRoot: string;
  /** Exact config watched by this incarnation's one supervisor. */
  readonly configurationPath: string;
  /** Current group-manifest pin for the exact immutable Workerd config bytes. */
  readonly configurationSha256: string;
  start(): Promise<void>;
  /** Reconcile a renderer's atomic config replacement through the same supervisor. */
  reloadConfiguration(): Promise<void>;
  /** Freeze config mutation after the incarnation's exact publication is proved. */
  sealConfiguration(): void;
  isReady(): boolean;
  fetch(request: Request): Promise<Response>;
  /** One original-client upgrade against this exact native incarnation. */
  connectWebSocket(request: Request, signal: AbortSignal): Promise<WorkerdNativeWebSocket>;
  /** Stop a failed recovery child without writing retirement or deleting custody. */
  stopAfterFailedRecovery(): Promise<void>;
  /** Stop the owned child and listener, retaining the exact execution copies for reopen. */
  suspendRetainingCustody(): Promise<void>;
  /**
   * The trusted caller supplies the durable accepted Operation ID. This local
   * primitive binds its receipt to that identity but does not resolve/authorize
   * the Operation itself.
   */
  retire(input: {
    readonly workerResourceUid: string;
    readonly operationId: string;
  }): Promise<WorkerdWorkerRetirementReceipt>;
}

export interface WorkerdWorkerExecutionCopies {
  readonly versionUids: readonly string[];
  readonly generationKeys: readonly string[];
  readonly publications: readonly {
    readonly generationKey: string;
    readonly generation: string;
    readonly versions: readonly { readonly workerVersionUid: string; readonly weight: number }[];
  }[];
}

export interface RetiredWorkerdWorkerExecutionCopiesInput {
  readonly groupDirectory: string;
  readonly workerResourceUid: string;
  readonly operationId: string;
  readonly listenerPort: number;
  readonly scriptName: string;
  /** The owner persisted the exact retirement receipt and cleanup intent first. */
  readonly cleanupIntentPersisted: true;
  /** SHA-256 of the exact pre-cleanup inventory persisted in the owner state. */
  readonly cleanupManifestSha256: string | null;
  /** Verify, but never resume mutation for, a previously committed completion marker. */
  readonly alreadyReleased?: true;
  /** Deterministic interruption seam for recovery tests; production callers omit it. */
  readonly afterEntryRemoved?: () => void;
}

export interface VerifyRetiredWorkerdWorkerExecutionCopiesInput {
  readonly groupDirectory: string;
  readonly workerResourceUid: string;
  readonly operationId: string;
  readonly listenerPort: number;
  readonly scriptName: string;
}

interface WorkerdExecutionCopyInventoryEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size?: number;
  readonly sha256?: string;
}

interface WorkerdExecutionCopyInventory {
  readonly schema: "takoserver.workerd-execution-copy-inventory@1";
  readonly workerResourceUid: string;
  readonly operationId: string;
  readonly listenerPort: number;
  readonly scriptName: string;
  readonly configurationSha256: string;
  readonly entries: readonly WorkerdExecutionCopyInventoryEntry[];
}

export interface OpenWorkerdWorkerExecutionGroupOptions {
  /**
   * Private namespace for one execution-group incarnation. A committed receipt
   * permanently blocks this UID in this namespace, not a global Resource
   * tombstone; a later incarnation uses a distinct private namespace.
   */
  readonly rootDirectory: string;
  readonly workerResourceUid: string;
  readonly listenerPort: number;
  readonly configuration: Uint8Array;
  /** Private relative path below the UID directory; defaults to `workerd.conf`. */
  readonly configurationPath?: string;
  readonly workerdBinary: string | null;
  readonly spawn?: (command: readonly string[]) => WorkerdProcess;
  /** Persist exact child identity before readiness admits this incarnation. */
  readonly onSpawned?: (child: WorkerdProcess) => Promise<void> | void;
  /** Reopen exact stored config/copies after the owner proves its prior child stale. */
  readonly recoverExisting?: true;
}

type GroupManifest = {
  readonly schema: "takoserver.workerd-worker-group@1";
  readonly workerResourceUid: string;
  readonly listenerPort: number;
  readonly configurationSha256: string;
};

type GroupState = "idle" | "starting" | "serving" | "frozen" | "retired" | "uncertain";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function validateIdentity(workerResourceUid: string, operationId?: string): void {
  if (typeof workerResourceUid !== "string")
    throw new WorkerdWorkerExecutionGroupError("invalid_identity");
  let hasControlCharacter = false;
  for (let index = 0; index < workerResourceUid.length; index += 1) {
    const code = workerResourceUid.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      hasControlCharacter = true;
      break;
    }
  }
  if (
    typeof workerResourceUid !== "string" ||
    workerResourceUid.length === 0 ||
    workerResourceUid.length > 256 ||
    hasControlCharacter
  )
    throw new WorkerdWorkerExecutionGroupError("invalid_identity");
  if (
    operationId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)
  )
    throw new WorkerdWorkerExecutionGroupError("invalid_identity");
}

function expectedManifest(options: OpenWorkerdWorkerExecutionGroupOptions): GroupManifest {
  return {
    schema: "takoserver.workerd-worker-group@1",
    workerResourceUid: options.workerResourceUid,
    listenerPort: options.listenerPort,
    configurationSha256: sha256(options.configuration),
  };
}

function checkedConfigurationPath(value: string | undefined): string {
  const path = value ?? CONFIG_NAME;
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new WorkerdWorkerExecutionGroupError("invalid_identity");
  }
  return path;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf("/"));
  const temporary = join(directory, `${RECEIPT_TEMP_PREFIX}${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch {
    try {
      await handle?.close();
    } catch {
      // Preserve the payload-free storage failure below.
    }
    throw new WorkerdWorkerExecutionGroupError("retirement_uncertain");
  }
}

async function ensurePrivateDirectory(path: string): Promise<boolean> {
  try {
    await mkdir(path, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
}

function parseExactJson<T>(text: string | null, expected: T): boolean {
  if (text === null) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return canonicalJson(parsed) === canonicalJson(expected) && text === canonicalJson(expected);
  } catch {
    return false;
  }
}

function makeGroup(input: {
  readonly options: OpenWorkerdWorkerExecutionGroupOptions;
  readonly directory: string;
  readonly manifest: GroupManifest;
  readonly initialState: "idle" | "retired";
  readonly receipt?: WorkerdWorkerRetirementReceipt;
}): WorkerdWorkerExecutionGroup {
  const { options, directory, manifest } = input;
  const configurationPath = join(directory, checkedConfigurationPath(options.configurationPath));
  let currentManifest = manifest;
  let state: GroupState = input.initialState;
  let supervisor: ReturnType<typeof createWorkerdSupervisor> | null = null;
  let startPromise: Promise<void> | null = null;
  let retirePromise: Promise<WorkerdWorkerRetirementReceipt> | null = null;
  let retiringOperationId: string | null = null;
  let retirementStarted = input.initialState === "retired";
  let receipt = input.receipt ? Object.freeze({ ...input.receipt }) : undefined;
  let configurationSealed = false;
  let configurationReload: Promise<void> | null = null;

  const fail = (code: WorkerdWorkerExecutionGroupError["code"]): never => {
    throw new WorkerdWorkerExecutionGroupError(code);
  };
  const admissionClosed = (): boolean =>
    retirementStarted || state === "frozen" || state === "retired";

  const start = (): Promise<void> => {
    if (state === "retired")
      return Promise.reject(new WorkerdWorkerExecutionGroupError("already_retired"));
    if (state === "frozen" || retirementStarted)
      return Promise.reject(new WorkerdWorkerExecutionGroupError("admission_closed"));
    if (startPromise) return startPromise;
    state = "starting";
    const created =
      supervisor ??
      createWorkerdSupervisor({
        binary: options.workerdBinary,
        listenerPort: options.listenerPort,
        spawn:
          options.spawn ??
          ((command) =>
            spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" })),
        ...(options.onSpawned === undefined ? {} : { onSpawned: options.onSpawned }),
        readiness: async (_configPath, child, mode) => {
          const attempts = mode === "startup" ? 20 : 1;
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
              const before = await workerPortOwnership(options.listenerPort, child.pid);
              if (before === "foreign") return false;
              // Socket ownership proves only that this exact OS process has
              // bound the configured listener; it deliberately does not probe
              // a route that could execute Worker code. It is process/listener
              // readiness only, not module, ABI, or Worker readiness.
              if (
                before === "owned" &&
                (await workerPortOwnership(options.listenerPort, child.pid)) === "owned"
              )
                return true;
            } catch {
              // Readiness is conservative: transient probes never admit traffic.
            }
            if (mode === "startup") await Bun.sleep(50);
          }
          return false;
        },
      });
    // One supervisor owns this group's complete child/restart lifecycle.
    // Never replace it merely because its current child is temporarily absent.
    supervisor = created;
    const promise = created.ensure(configurationPath).then(
      () => {
        if (supervisor !== created || !created.isReady()) return fail("not_serving");
        if (state === "starting") state = "serving";
      },
      () => {
        state = "uncertain";
        throw new WorkerdWorkerExecutionGroupError("not_serving");
      },
    );
    startPromise = promise;
    void promise.then(
      () => {
        if (startPromise === promise) startPromise = null;
      },
      () => {
        if (startPromise === promise) startPromise = null;
      },
    );
    return promise;
  };

  const fetchRequest = async (request: Request): Promise<Response> => {
    if (state === "frozen" || state === "retired" || state === "uncertain")
      fail("admission_closed");
    const owner = supervisor;
    if (owner === null) throw new WorkerdWorkerExecutionGroupError("not_serving");
    if (state !== "serving" || !owner.isReady())
      throw new WorkerdWorkerExecutionGroupError("not_serving");
    try {
      // Recheck the exact captured child and listener immediately before the
      // TCP request. This is not an atomic kernel check-and-connect primitive.
      await owner.ensure(configurationPath);
    } catch {
      if (admissionClosed()) fail("admission_closed");
      state = "uncertain";
      fail("not_serving");
    }
    if (admissionClosed() || state !== "serving" || supervisor !== owner || !owner.isReady())
      fail("admission_closed");
    const incoming = new URL(request.url);
    const target = new URL(
      `http://127.0.0.1:${options.listenerPort}${incoming.pathname}${incoming.search}`,
    );
    const headers = new Headers(request.headers);
    headers.set("host", incoming.host);
    return fetch(target, {
      method: request.method,
      headers,
      signal: request.signal,
      redirect: "manual",
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: request.body, duplex: "half" as const }),
    });
  };

  const connectWebSocket = async (
    request: Request,
    signal: AbortSignal,
  ): Promise<WorkerdNativeWebSocket> => {
    if (state !== "serving" || retirementStarted || supervisor?.isReady() !== true)
      fail("not_serving");
    const owner = supervisor;
    if (owner === null) throw new WorkerdWorkerExecutionGroupError("not_serving");
    try {
      await owner.ensure(configurationPath);
    } catch {
      if (admissionClosed()) fail("admission_closed");
      state = "uncertain";
      fail("not_serving");
    }
    if (admissionClosed() || state !== "serving" || supervisor !== owner || !owner.isReady())
      fail("admission_closed");
    const incoming = new URL(request.url);
    if (incoming.protocol !== "https:" || request.method !== "GET" || signal.aborted)
      fail("admission_closed");
    const target = `ws://127.0.0.1:${options.listenerPort}${incoming.pathname}${incoming.search}`;
    const headers = new Headers(request.headers);
    // Bun mints its own handshake. A public client cannot choose a private
    // transport key, connection framing, or service-binding dispatch metadata.
    for (const name of [...headers.keys()]) {
      if (/^sec-websocket-/iu.test(name)) headers.delete(name);
    }
    headers.delete("connection");
    headers.delete("upgrade");
    headers.delete("content-length");
    headers.set("host", incoming.host);
    const protocol = request.headers.get("sec-websocket-protocol");
    const NativeWebSocket = WebSocket as unknown as {
      new (url: string, options: Bun.WebSocketOptions): WorkerdNativeWebSocket;
    };
    const socket = new NativeWebSocket(target, {
      headers: Object.fromEntries(headers.entries()),
      ...(protocol ? { protocols: protocol.split(",").map((part) => part.trim()) } : {}),
    });
    socket.binaryType = "arraybuffer";
    const early: WorkerdBridgeMessage[] = [];
    let earlyBytes = 0;
    let forward: ((value: WorkerdBridgeMessage) => void) | undefined;
    socket.addEventListener("message", (event) => {
      const value: unknown = event.data;
      if (
        typeof value !== "string" &&
        !(value instanceof ArrayBuffer) &&
        !(value instanceof Uint8Array)
      ) {
        socket.terminate();
        return;
      }
      const size = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
      if (
        size > WORKER_ENDPOINT_ACTOR_SOCKET_LIMIT ||
        (!forward && earlyBytes + size > WORKER_ENDPOINT_ACTOR_SOCKET_LIMIT)
      ) {
        socket.terminate();
        return;
      }
      if (forward) forward(value);
      else {
        early.push(value);
        earlyBytes += size;
      }
    });
    socket.addEventListener(
      "close",
      () => {
        early.length = 0;
        earlyBytes = 0;
      },
      { once: true },
    );
    Object.defineProperty(socket, "forwardMessages", {
      value(send: (value: WorkerdBridgeMessage) => void) {
        if (forward) throw new WorkerdWorkerExecutionGroupError("admission_closed");
        forward = send;
        for (const value of early) send(value);
        early.length = 0;
        earlyBytes = 0;
      },
    });
    return await new Promise<WorkerdNativeWebSocket>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", closed);
        if (error) {
          socket.terminate();
          reject(error);
        } else resolve(socket);
      };
      const aborted = () => done(new WorkerdWorkerExecutionGroupError("admission_closed"));
      const opened = () => done();
      const failed = () => done(new WorkerdWorkerExecutionGroupError("not_serving"));
      const closed = () => done(new WorkerdWorkerExecutionGroupError("not_serving"));
      const timer = setTimeout(
        () => done(new WorkerdWorkerExecutionGroupError("not_serving")),
        10_000,
      );
      signal.addEventListener("abort", aborted, { once: true });
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", closed, { once: true });
      if (signal.aborted) aborted();
    });
  };

  const reloadConfiguration = (): Promise<void> => {
    if (configurationSealed || retirementStarted || state === "retired")
      return Promise.reject(new WorkerdWorkerExecutionGroupError("admission_closed"));
    if (configurationReload) return configurationReload;
    const task = (async () => {
      try {
        const info = await lstat(configurationPath);
        if (!info.isFile() || info.isSymbolicLink())
          throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
        const bytes = await readFile(configurationPath);
        const nextManifest: GroupManifest = {
          ...currentManifest,
          configurationSha256: sha256(bytes),
        };
        if (nextManifest.configurationSha256 !== currentManifest.configurationSha256) {
          await writeAtomic(
            join(directory, MANIFEST_NAME),
            new TextEncoder().encode(canonicalJson(nextManifest)),
          );
          currentManifest = nextManifest;
        }
        const currentSupervisor = supervisor;
        if (currentSupervisor === null) await start();
        else await currentSupervisor.ensure(configurationPath);
        if (supervisor?.isReady() !== true)
          throw new WorkerdWorkerExecutionGroupError("not_serving");
        if (!retirementStarted) state = "serving";
      } catch {
        state = "uncertain";
        throw new WorkerdWorkerExecutionGroupError("not_serving");
      }
    })();
    configurationReload = task;
    void task.then(
      () => {
        if (configurationReload === task) configurationReload = null;
      },
      () => {
        if (configurationReload === task) configurationReload = null;
      },
    );
    return task;
  };

  const retire = (retireInput: {
    readonly workerResourceUid: string;
    readonly operationId: string;
  }) => {
    const workerResourceUid = retireInput.workerResourceUid;
    const operationId = retireInput.operationId;
    validateIdentity(workerResourceUid, operationId);
    if (workerResourceUid !== options.workerResourceUid)
      return Promise.reject(new WorkerdWorkerExecutionGroupError("identity_mismatch"));
    if (state === "retired") {
      if (receipt?.operationId === operationId) return Promise.resolve(receipt);
      return Promise.reject(new WorkerdWorkerExecutionGroupError("identity_mismatch"));
    }
    if (retirementStarted) {
      if (retiringOperationId !== operationId)
        return Promise.reject(new WorkerdWorkerExecutionGroupError("identity_mismatch"));
      if (retirePromise) return retirePromise;
      if (state !== "uncertain")
        return Promise.reject(new WorkerdWorkerExecutionGroupError("ownership_uncertain"));
    } else {
      // Freeze admission synchronously, before asking the supervisor to cancel.
      retirementStarted = true;
      state = "frozen";
      retiringOperationId = operationId;
    }
    const task = (async () => {
      try {
        if (startPromise) await startPromise.catch(() => undefined);
        if (configurationReload) await configurationReload;
        const assertCurrentConfiguration = async (): Promise<string> => {
          const info = await lstat(configurationPath).catch(() => null);
          if (!info?.isFile() || info.isSymbolicLink())
            throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
          const digest = sha256(await readFile(configurationPath));
          if (digest !== currentManifest.configurationSha256)
            throw new WorkerdWorkerExecutionGroupError("retirement_uncertain");
          return digest;
        };
        await assertCurrentConfiguration();
        await supervisor?.shutdown();
        if ((await workerPortOwnership(options.listenerPort, undefined)) !== "vacant")
          throw new WorkerdWorkerExecutionGroupError("retirement_uncertain");
        // Bind the receipt to the exact bytes still present after the child has
        // exited; a sealed manifest alone cannot prove the file was unchanged.
        const configurationSha256 = await assertCurrentConfiguration();
        const completed: WorkerdWorkerRetirementReceipt = Object.freeze({
          workerResourceUid: options.workerResourceUid,
          operationId,
          listenerPort: options.listenerPort,
          configurationSha256,
        });
        await writeAtomic(
          join(directory, RECEIPT_NAME),
          new TextEncoder().encode(canonicalJson(completed)),
        );
        receipt = completed;
        state = "retired";
        return completed;
      } catch {
        state = "uncertain";
        throw new WorkerdWorkerExecutionGroupError("retirement_uncertain");
      }
    })();
    retirePromise = task;
    void task.catch(() => {
      if (retirePromise === task) retirePromise = null;
    });
    return task;
  };

  return Object.freeze({
    workerResourceUid: options.workerResourceUid,
    runtimeRoot: directory,
    configurationPath,
    get configurationSha256() {
      return currentManifest.configurationSha256;
    },
    start,
    reloadConfiguration,
    sealConfiguration() {
      configurationSealed = true;
    },
    isReady() {
      return state === "serving" && supervisor?.isReady() === true;
    },
    connectWebSocket,
    async stopAfterFailedRecovery() {
      if (options.recoverExisting !== true || retirementStarted) {
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      }
      await startPromise?.catch(() => undefined);
      await configurationReload?.catch(() => undefined);
      await supervisor?.shutdown();
      if ((await workerPortOwnership(options.listenerPort, undefined)) !== "vacant") {
        state = "uncertain";
        throw new WorkerdWorkerExecutionGroupError("retirement_uncertain");
      }
      state = "uncertain";
    },
    async suspendRetainingCustody() {
      if (retirementStarted || state === "retired") {
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      }
      // Freeze admission before the first await. This does not write a
      // retirement receipt or release any execution copy.
      state = "frozen";
      try {
        await startPromise?.catch(() => undefined);
        await configurationReload?.catch(() => undefined);
        await supervisor?.shutdown();
        if ((await workerPortOwnership(options.listenerPort, undefined)) !== "vacant") {
          throw new WorkerdWorkerExecutionGroupError("retirement_uncertain");
        }
      } catch {
        state = "uncertain";
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      }
    },
    fetch: fetchRequest,
    retire,
  });
}

export async function openWorkerdWorkerExecutionGroup(
  options: OpenWorkerdWorkerExecutionGroupOptions,
): Promise<WorkerdWorkerExecutionGroup> {
  validateIdentity(options.workerResourceUid);
  checkedConfigurationPath(options.configurationPath);
  if (
    !Number.isSafeInteger(options.listenerPort) ||
    options.listenerPort < 1 ||
    options.listenerPort > 65_535 ||
    !(options.configuration instanceof Uint8Array)
  )
    throw new WorkerdWorkerExecutionGroupError("invalid_identity");

  const ownedConfiguration = Uint8Array.from(options.configuration);
  options = { ...options, configuration: ownedConfiguration };

  let canonicalRoot: string;
  try {
    await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
    canonicalRoot = await realpath(options.rootDirectory);
  } catch {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const uidKey = createHash("sha256").update(options.workerResourceUid).digest("hex");
  const directory = join(canonicalRoot, uidKey);
  const created = await ensurePrivateDirectory(directory);
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");

  const manifest = expectedManifest(options);
  const configurationPath = join(directory, checkedConfigurationPath(options.configurationPath));
  if (created) {
    try {
      // Persist the UID's permanent directory entry before any child can start.
      await syncDirectory(canonicalRoot);
      await mkdir(dirname(configurationPath), { recursive: true, mode: 0o700 });
      const configFile = await open(configurationPath, "wx", 0o600);
      try {
        await configFile.writeFile(options.configuration);
        await configFile.sync();
      } finally {
        await configFile.close();
      }
      const manifestFile = await open(join(directory, MANIFEST_NAME), "wx", 0o600);
      try {
        await manifestFile.writeFile(canonicalJson(manifest));
        await manifestFile.sync();
      } finally {
        await manifestFile.close();
      }
      await syncDirectory(directory);
    } catch {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    return makeGroup({ options, directory, manifest, initialState: "idle" });
  }

  const manifestInfo = await lstat(join(directory, MANIFEST_NAME)).catch(() => null);
  const configurationInfo = await lstat(configurationPath).catch(() => null);
  const receiptInfo = await lstat(join(directory, RECEIPT_NAME)).catch(() => null);
  if (
    !manifestInfo?.isFile() ||
    manifestInfo.isSymbolicLink() ||
    !configurationInfo?.isFile() ||
    configurationInfo.isSymbolicLink() ||
    (receiptInfo !== null && (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()))
  )
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  const manifestText = await readText(join(directory, MANIFEST_NAME));
  const storedConfiguration = await readFile(configurationPath).catch(() => null);
  if (
    !parseExactJson(manifestText, manifest) ||
    !storedConfiguration ||
    !Buffer.from(storedConfiguration).equals(Buffer.from(options.configuration))
  )
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  const receiptText = await readText(join(directory, RECEIPT_NAME));
  if (receiptText === null) {
    if (options.recoverExisting === true) {
      return makeGroup({ options, directory, manifest, initialState: "idle" });
    }
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  if (options.recoverExisting === true) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  let parsedReceipt: unknown;
  try {
    parsedReceipt = JSON.parse(receiptText);
  } catch {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const expectedReceipt: WorkerdWorkerRetirementReceipt = {
    workerResourceUid: options.workerResourceUid,
    operationId:
      typeof parsedReceipt === "object" && parsedReceipt !== null && "operationId" in parsedReceipt
        ? String((parsedReceipt as { operationId: unknown }).operationId)
        : "",
    listenerPort: options.listenerPort,
    configurationSha256: manifest.configurationSha256,
  };
  validateIdentity(expectedReceipt.workerResourceUid, expectedReceipt.operationId);
  if (!parseExactJson(receiptText, expectedReceipt))
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  return makeGroup({
    options,
    directory,
    manifest,
    initialState: "retired",
    receipt: expectedReceipt,
  });
}

/**
 * Verifies the private, immutable publication copies owned by one Worker
 * incarnation. This deliberately inventories stored deployment manifests,
 * including generations no longer selected by the pointer.
 */
export async function inspectWorkerdWorkerExecutionCopies(input: {
  readonly groupDirectory: string;
  readonly workerResourceUid: string;
  readonly listenerPort: number;
  readonly scriptName: string;
}): Promise<WorkerdWorkerExecutionCopies> {
  validateIdentity(input.workerResourceUid);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(input.scriptName)) {
    throw new WorkerdWorkerExecutionGroupError("invalid_identity");
  }
  const directory = await requireOwnedDirectory(input.groupDirectory);
  const manifestPath = join(directory, MANIFEST_NAME);
  const configurationPath = join(directory, "workers/workerd.capnp");
  const manifestText = await readRequiredRegularFile(manifestPath);
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  if (
    !manifestValue ||
    typeof manifestValue !== "object" ||
    Array.isArray(manifestValue) ||
    Object.keys(manifestValue).sort().join(",") !==
      "configurationSha256,listenerPort,schema,workerResourceUid"
  ) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const manifest = manifestValue as Record<string, unknown>;
  if (
    manifest.schema !== "takoserver.workerd-worker-group@1" ||
    manifest.workerResourceUid !== input.workerResourceUid ||
    manifest.listenerPort !== input.listenerPort ||
    typeof manifest.configurationSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.configurationSha256) ||
    manifestText !== canonicalJson(manifestValue)
  ) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const configuration = await readRequiredRegularFile(configurationPath);
  if (sha256(new TextEncoder().encode(configuration)) !== manifest.configurationSha256) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }

  const workersRoot = join(directory, "workers");
  const workersInfo = await lstat(workersRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (!workersInfo) return { versionUids: [], generationKeys: [], publications: [] };
  if (
    !workersInfo.isDirectory() ||
    workersInfo.isSymbolicLink() ||
    (workersInfo.mode & 0o077) !== 0
  )
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  const workersEntries = await readdir(workersRoot).catch(() => {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  const allowedWorkersEntries = new Set([
    "workerd.capnp",
    ".takoserver-active.json",
    "static-readiness.js",
    "event-dispatcher.js",
    "deployment-router.js",
    "service-router.js",
    "asset-router.js",
    "assets.js",
    "router.js",
    input.scriptName,
    DEPLOYMENT_PUBLICATIONS_NAME,
  ]);
  if (workersEntries.some((entry) => !allowedWorkersEntries.has(entry))) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const activationPath = join(workersRoot, ".takoserver-active.json");
  const activationInfo = await lstat(activationPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (activationInfo && (!activationInfo.isFile() || activationInfo.isSymbolicLink())) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const legacyAssetsPath = join(directory, "assets", input.scriptName);
  const legacyAssetsInfo = await lstat(legacyAssetsPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (legacyAssetsInfo) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");

  const directPath = join(workersRoot, input.scriptName);
  const directInfo = await lstat(directPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (directInfo) {
    if (!directInfo.isDirectory() || directInfo.isSymbolicLink())
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    await requireNoSymlinksOrSpecialFiles(directPath);
    const directEntries = await readdir(directPath).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    if (directEntries.length !== 1 || directEntries[0] !== WORKER_POINTER_NAME) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    const pointerPath = join(directPath, WORKER_POINTER_NAME);
    const pointerText = await readRequiredRegularFile(pointerPath);
    let pointer: unknown;
    try {
      pointer = JSON.parse(pointerText);
    } catch {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    if (
      !pointer ||
      typeof pointer !== "object" ||
      Array.isArray(pointer) ||
      Object.keys(pointer).sort().join(",") !==
        "generation,generationKey,publicationStorageLayout" ||
      (pointer as Record<string, unknown>).publicationStorageLayout !== "weighted-deployment-v1" ||
      typeof (pointer as Record<string, unknown>).generation !== "string" ||
      typeof (pointer as Record<string, unknown>).generationKey !== "string" ||
      !/^[0-9a-f]{64}$/u.test((pointer as Record<string, unknown>).generationKey as string) ||
      pointerText !== JSON.stringify(pointer)
    ) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
  }

  const publicationRoot = join(workersRoot, DEPLOYMENT_PUBLICATIONS_NAME);
  const publicationsInfo = await lstat(publicationRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (!publicationsInfo) {
    if (directInfo) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    return { versionUids: [], generationKeys: [], publications: [] };
  }
  if (
    !publicationsInfo.isDirectory() ||
    publicationsInfo.isSymbolicLink() ||
    (publicationsInfo.mode & 0o077) !== 0
  ) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const publicationEntries = await readdir(publicationRoot).catch(() => {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (publicationEntries.some((entry) => entry !== input.scriptName)) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const scriptRoot = join(publicationRoot, input.scriptName);
  const scriptInfo = await lstat(scriptRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (!scriptInfo) {
    if (directInfo) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    return { versionUids: [], generationKeys: [], publications: [] };
  }
  if (!scriptInfo.isDirectory() || scriptInfo.isSymbolicLink() || (scriptInfo.mode & 0o077) !== 0)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");

  const generationKeys = await readdir(scriptRoot).catch(() => {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (generationKeys.length > 256 || generationKeys.some((key) => !/^[0-9a-f]{64}$/u.test(key))) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const versionUids = new Set<string>();
  const publicationInventory: WorkerdWorkerExecutionCopies["publications"][number][] = [];
  let activePointerGenerationKey: string | undefined;
  if (directInfo) {
    const pointerText = await readRequiredRegularFile(join(directPath, WORKER_POINTER_NAME));
    const pointer = JSON.parse(pointerText) as { generationKey?: unknown };
    if (typeof pointer.generationKey !== "string")
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    activePointerGenerationKey = pointer.generationKey;
  }
  for (const generationKey of generationKeys) {
    const generationRoot = join(scriptRoot, generationKey);
    const generationInfo = await lstat(generationRoot).catch(() => null);
    if (!generationInfo?.isDirectory() || generationInfo.isSymbolicLink())
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    await requireNoSymlinksOrSpecialFiles(generationRoot);
    const raw = await readRequiredRegularFile(join(generationRoot, DEPLOYMENT_MANIFEST_NAME));
    if (sha256(new TextEncoder().encode(raw)) !== generationKey) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    let deployment: unknown;
    try {
      deployment = JSON.parse(raw);
    } catch {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    if (
      !deployment ||
      typeof deployment !== "object" ||
      Array.isArray(deployment) ||
      Object.keys(deployment).sort().join(",") !==
        "generation,hostnames,publicationStorageLayout,versions,workerResourceUid"
    ) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    const graph = deployment as Record<string, unknown>;
    if (
      graph.publicationStorageLayout !== "weighted-deployment-v1" ||
      graph.workerResourceUid !== input.workerResourceUid ||
      typeof graph.generation !== "string" ||
      !Array.isArray(graph.versions) ||
      graph.versions.length < 1 ||
      graph.versions.length > 8
    ) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    const expectedEntries = [DEPLOYMENT_MANIFEST_NAME];
    const seenVersions = new Set<string>();
    const seenVersionIds = new Set<string>();
    const publicationVersions: Array<{ workerVersionUid: string; weight: number }> = [];
    let totalWeight = 0;
    let priorVersionUid = "";
    for (const [index, versionValue] of graph.versions.entries()) {
      if (!versionValue || typeof versionValue !== "object" || Array.isArray(versionValue))
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      const version = versionValue as Record<string, unknown>;
      if (
        Object.keys(version).sort().join(",") !==
          "manifest,storageKey,versionId,weight,workerVersionUid" ||
        version.storageKey !== `version-${index.toString(10).padStart(5, "0")}` ||
        typeof version.versionId !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(version.versionId) ||
        typeof version.workerVersionUid !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u.test(version.workerVersionUid) ||
        !Number.isSafeInteger(version.weight) ||
        (version.weight as number) < 1 ||
        (version.weight as number) > 10_000 ||
        seenVersions.has(version.workerVersionUid) ||
        seenVersionIds.has(version.versionId) ||
        (priorVersionUid !== "" && version.workerVersionUid < priorVersionUid)
      ) {
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      }
      seenVersions.add(version.workerVersionUid);
      seenVersionIds.add(version.versionId);
      totalWeight += version.weight as number;
      priorVersionUid = version.workerVersionUid;
      versionUids.add(version.workerVersionUid);
      publicationVersions.push({
        workerVersionUid: version.workerVersionUid,
        weight: version.weight as number,
      });
      expectedEntries.push(version.storageKey as string);
      await verifyStoredVersionTree(
        join(generationRoot, version.storageKey as string),
        version.manifest,
      );
    }
    if (totalWeight !== 10_000) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    publicationInventory.push({
      generationKey,
      generation: graph.generation,
      versions: publicationVersions,
    });
    const actualEntries = await readdir(generationRoot).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    if (
      actualEntries.length !== expectedEntries.length ||
      expectedEntries.some((entry) => !actualEntries.includes(entry))
    ) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    if (
      activePointerGenerationKey === generationKey &&
      graph.generation !== (await readPointerGeneration(directPath))
    ) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
  }
  if (
    generationKeys.length === 0 ||
    (activePointerGenerationKey !== undefined &&
      !generationKeys.includes(activePointerGenerationKey))
  ) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  return {
    versionUids: [...versionUids].sort(),
    generationKeys: [...generationKeys].sort(),
    publications: publicationInventory.sort((left, right) =>
      left.generationKey.localeCompare(right.generationKey),
    ),
  };
}

async function readRetiredGroupAuthority(
  input: VerifyRetiredWorkerdWorkerExecutionCopiesInput,
): Promise<{
  readonly directory: string;
  readonly expectedReceipt: WorkerdWorkerRetirementReceipt;
}> {
  validateIdentity(input.workerResourceUid, input.operationId);
  const directory = await requireOwnedDirectory(input.groupDirectory);
  const groupManifestText = await readRequiredRegularFile(join(directory, MANIFEST_NAME));
  const configurationPath = join(directory, "workers/workerd.capnp");
  const configuration = await readRequiredRegularFile(configurationPath);
  const receiptText = await readRequiredRegularFile(join(directory, RECEIPT_NAME));
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(groupManifestText);
  } catch {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const expectedReceipt: WorkerdWorkerRetirementReceipt = {
    workerResourceUid: input.workerResourceUid,
    operationId: input.operationId,
    listenerPort: input.listenerPort,
    configurationSha256: sha256(new TextEncoder().encode(configuration)),
  };
  if (
    !parseExactJson(receiptText, expectedReceipt) ||
    !manifestValue ||
    typeof manifestValue !== "object" ||
    Array.isArray(manifestValue) ||
    !parseExactJson(groupManifestText, {
      schema: "takoserver.workerd-worker-group@1",
      workerResourceUid: input.workerResourceUid,
      listenerPort: input.listenerPort,
      configurationSha256: expectedReceipt.configurationSha256,
    })
  ) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  return { directory, expectedReceipt };
}

/** Prove the exact receipt and complete immutable copies before cleanup intent is persisted. */
export async function verifyRetiredWorkerdWorkerExecutionCopies(
  input: VerifyRetiredWorkerdWorkerExecutionCopiesInput,
): Promise<{
  readonly copies: WorkerdWorkerExecutionCopies;
  readonly receipt: WorkerdWorkerRetirementReceipt;
  readonly cleanupManifestSha256: string;
}> {
  const { directory, expectedReceipt } = await readRetiredGroupAuthority(input);
  const copies = await inspectWorkerdWorkerExecutionCopies({
    groupDirectory: directory,
    workerResourceUid: input.workerResourceUid,
    listenerPort: input.listenerPort,
    scriptName: input.scriptName,
  });
  const inventory = await buildExecutionCopyInventory(directory, input, expectedReceipt);
  return {
    copies,
    receipt: expectedReceipt,
    cleanupManifestSha256: digestInventory(inventory),
  };
}

function digestInventory(inventory: WorkerdExecutionCopyInventory): string {
  return `sha256:${sha256(new TextEncoder().encode(JSON.stringify(inventory)))}`;
}

async function buildExecutionCopyInventory(
  directory: string,
  input: VerifyRetiredWorkerdWorkerExecutionCopiesInput,
  receipt: WorkerdWorkerRetirementReceipt,
): Promise<WorkerdExecutionCopyInventory> {
  const entries: WorkerdExecutionCopyInventoryEntry[] = [];
  const roots = [
    { path: join(directory, "workers", input.scriptName), label: "direct" },
    {
      path: join(directory, "workers", DEPLOYMENT_PUBLICATIONS_NAME, input.scriptName),
      label: "publications",
    },
  ] as const;
  const visit = async (path: string, label: string, relative: string): Promise<void> => {
    const info = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    const inventoryPath = relative ? `${label}/${relative}` : label;
    if (info.isDirectory()) {
      entries.push({ path: inventoryPath, kind: "directory", mode: info.mode & 0o777 });
      const children = (await readdir(path)).sort();
      for (const child of children) {
        if (!child || child === "." || child === ".." || child.includes("/"))
          throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
        await visit(join(path, child), label, relative ? `${relative}/${child}` : child);
      }
      return;
    }
    if (!info.isFile()) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    const bytes = await readFile(path);
    entries.push({
      path: inventoryPath,
      kind: "file",
      mode: info.mode & 0o777,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
  };
  for (const root of roots) await visit(root.path, root.label, "");
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    schema: "takoserver.workerd-execution-copy-inventory@1",
    workerResourceUid: input.workerResourceUid,
    operationId: input.operationId,
    listenerPort: input.listenerPort,
    scriptName: input.scriptName,
    configurationSha256: receipt.configurationSha256,
    entries,
  };
}

async function validateInventoryAtTree(
  path: string,
  label: "direct" | "publications",
  inventory: WorkerdExecutionCopyInventory,
  requireComplete: boolean,
): Promise<void> {
  const expected = new Map(
    inventory.entries
      .filter((entry) => entry.path === label || entry.path.startsWith(`${label}/`))
      .map((entry) => [entry.path, entry]),
  );
  const actual = new Set<string>();
  const visit = async (currentPath: string, relative: string): Promise<void> => {
    const info = await lstat(currentPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    const key = relative ? `${label}/${relative}` : label;
    const proof = expected.get(key);
    if (
      !proof ||
      (info.isDirectory() ? proof.kind !== "directory" : proof.kind !== "file") ||
      proof.mode !== (info.mode & 0o777)
    )
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    actual.add(key);
    if (info.isDirectory()) {
      if ((info.mode & 0o077) !== 0)
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      const children = (await readdir(currentPath)).sort();
      for (const child of children) {
        if (!child || child === "." || child === ".." || child.includes("/"))
          throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
        await visit(join(currentPath, child), relative ? `${relative}/${child}` : child);
      }
      return;
    }
    if (!info.isFile()) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    const bytes = await readFile(currentPath);
    if (proof.size !== bytes.byteLength || proof.sha256 !== sha256(bytes))
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  };
  await visit(path, "");
  if (requireComplete && actual.size !== expected.size)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
}

async function readCleanupInventory(
  path: string,
  input: VerifyRetiredWorkerdWorkerExecutionCopiesInput,
  receipt: WorkerdWorkerRetirementReceipt,
): Promise<WorkerdExecutionCopyInventory> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error();
    const text = await readFile(path, "utf8");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "configurationSha256,entries,listenerPort,operationId,schema,scriptName,workerResourceUid" ||
      record.schema !== "takoserver.workerd-execution-copy-inventory@1" ||
      record.workerResourceUid !== input.workerResourceUid ||
      record.operationId !== input.operationId ||
      record.listenerPort !== input.listenerPort ||
      record.scriptName !== input.scriptName ||
      record.configurationSha256 !== receipt.configurationSha256 ||
      !Array.isArray(record.entries) ||
      record.entries.length > 100_000
    ) {
      throw new Error();
    }
    let previousPath = "";
    for (const raw of record.entries) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
      const entry = raw as Record<string, unknown>;
      if (
        typeof entry.path !== "string" ||
        (previousPath !== "" && entry.path <= previousPath) ||
        !/^(?:direct|publications)(?:\/[A-Za-z0-9._-]+)*$/u.test(entry.path) ||
        entry.path.split("/").some((part) => part === "." || part === "..")
      ) {
        throw new Error();
      }
      if (entry.kind === "directory") {
        if (
          Object.keys(entry).sort().join(",") !== "kind,mode,path" ||
          !Number.isSafeInteger(entry.mode) ||
          (entry.mode as number) < 0 ||
          (entry.mode as number) > 0o777
        )
          throw new Error();
      } else if (entry.kind === "file") {
        if (
          Object.keys(entry).sort().join(",") !== "kind,mode,path,sha256,size" ||
          !Number.isSafeInteger(entry.mode) ||
          (entry.mode as number) < 0 ||
          (entry.mode as number) > 0o777 ||
          !Number.isSafeInteger(entry.size) ||
          (entry.size as number) < 0 ||
          typeof entry.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(entry.sha256)
        ) {
          throw new Error();
        }
      } else {
        throw new Error();
      }
      previousPath = entry.path;
    }
    if (JSON.stringify(value) !== text) throw new Error();
    return value as unknown as WorkerdExecutionCopyInventory;
  } catch {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
}

async function writeCleanupInventory(
  path: string,
  temporaryPath: string,
  inventory: WorkerdExecutionCopyInventory,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(inventory));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch {
    await handle?.close().catch(() => undefined);
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
}

/**
 * Remove exact retired publication copies after a durable owner cleanup intent.
 * Strictly verified trees are first atomically moved to an incarnation- and
 * retirement-operation-specific quarantine. A partial recursive removal can
 * therefore be resumed without treating a partial ordinary publication tree
 * as valid or weakening validation of any remaining source tree.
 */
export async function releaseRetiredWorkerdWorkerExecutionCopies(
  input: RetiredWorkerdWorkerExecutionCopiesInput,
): Promise<{ readonly receipt: WorkerdWorkerRetirementReceipt }> {
  if (input.cleanupIntentPersisted !== true)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  const { directory, expectedReceipt } = await readRetiredGroupAuthority(input);
  const workersRoot = join(directory, "workers");
  const directPath = join(workersRoot, input.scriptName);
  const publicationRoot = join(workersRoot, DEPLOYMENT_PUBLICATIONS_NAME);
  const publicationPath = join(publicationRoot, input.scriptName);
  const quarantineRoot = join(directory, ".retired-execution-copies");
  const quarantinePath = join(quarantineRoot, input.operationId);
  const quarantinedDirect = join(quarantinePath, "direct");
  const quarantinedPublications = join(quarantinePath, "publications");
  const inventoryPath = join(quarantinePath, "inventory.json");
  const inventoryTemporaryPath = join(quarantinePath, "inventory.tmp");

  const quarantineExists = await requireDirectoryOrMissing(quarantineRoot);
  if (quarantineExists) {
    const quarantineEntries = await readdir(quarantineRoot).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    if (quarantineEntries.some((entry) => entry !== input.operationId))
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const operationQuarantineExists = await requireDirectoryOrMissing(quarantinePath);
  if (operationQuarantineExists) {
    const entries = await readdir(quarantinePath).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    if (
      entries.some(
        (entry) =>
          entry !== "direct" &&
          entry !== "publications" &&
          entry !== "inventory.json" &&
          entry !== "inventory.tmp",
      )
    )
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    for (const target of [quarantinedDirect, quarantinedPublications]) {
      if (await requireDirectoryOrMissing(target)) await requireNoSymlinksOrSpecialFiles(target);
    }
  }

  const hasQuarantinedDirect = await requireDirectoryOrMissing(quarantinedDirect);
  const hasQuarantinedPublications = await requireDirectoryOrMissing(quarantinedPublications);
  const hasSourceDirect = await requireDirectoryOrMissing(directPath);
  const hasSourcePublications = await requireDirectoryOrMissing(publicationPath);
  if (hasSourceDirect && hasQuarantinedDirect)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  if (hasSourcePublications && hasQuarantinedPublications)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  if (hasQuarantinedPublications && hasSourceDirect)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");

  const hasAnyQuarantine = hasQuarantinedDirect || hasQuarantinedPublications;
  const inventoryInfo = await lstat(inventoryPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  const temporaryInfo = await lstat(inventoryTemporaryPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  let inventory: WorkerdExecutionCopyInventory;
  if (input.alreadyReleased === true) {
    if (hasSourceDirect || hasSourcePublications || hasAnyQuarantine || temporaryInfo !== null)
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    if (input.cleanupManifestSha256 === null) {
      if (quarantineExists || inventoryInfo !== null)
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    } else {
      if (inventoryInfo === null || inventoryInfo.isSymbolicLink())
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      inventory = await readCleanupInventory(inventoryPath, input, expectedReceipt);
      if (digestInventory(inventory) !== input.cleanupManifestSha256)
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      await requireEmptyDirectoryOrMissing(quarantinedDirect);
      await requireEmptyDirectoryOrMissing(quarantinedPublications);
    }
    const copies = await inspectWorkerdWorkerExecutionCopies({
      groupDirectory: directory,
      workerResourceUid: input.workerResourceUid,
      listenerPort: input.listenerPort,
      scriptName: input.scriptName,
    });
    if (copies.versionUids.length !== 0 || copies.generationKeys.length !== 0)
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    return { receipt: expectedReceipt };
  }
  if (inventoryInfo) {
    if (inventoryInfo.isSymbolicLink() || !inventoryInfo.isFile() || !input.cleanupManifestSha256)
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    inventory = await readCleanupInventory(inventoryPath, input, expectedReceipt);
    if (digestInventory(inventory) !== input.cleanupManifestSha256)
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  } else {
    if (hasAnyQuarantine) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    await inspectWorkerdWorkerExecutionCopies({
      groupDirectory: directory,
      workerResourceUid: input.workerResourceUid,
      listenerPort: input.listenerPort,
      scriptName: input.scriptName,
    });
    inventory = await buildExecutionCopyInventory(directory, input, expectedReceipt);
    if (
      !input.cleanupManifestSha256 ||
      digestInventory(inventory) !== input.cleanupManifestSha256
    ) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
  }

  if (!operationQuarantineExists) {
    if (!quarantineExists) {
      await mkdir(quarantineRoot, { mode: 0o700 });
      await syncDirectory(directory);
    }
    await mkdir(quarantinePath, { mode: 0o700 });
    await syncDirectory(quarantineRoot);
  }

  if (!inventoryInfo) {
    if (hasAnyQuarantine) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    if (temporaryInfo) {
      if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink())
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      await unlink(inventoryTemporaryPath);
      await syncDirectory(quarantinePath);
    }
    await writeCleanupInventory(inventoryPath, inventoryTemporaryPath, inventory);
  } else if (temporaryInfo) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }

  if (hasSourceDirect) {
    await validateInventoryAtTree(directPath, "direct", inventory, true);
  }
  if (hasSourcePublications) {
    await validateInventoryAtTree(publicationPath, "publications", inventory, true);
  }
  if (hasQuarantinedDirect) {
    await validateInventoryAtTree(quarantinedDirect, "direct", inventory, false);
  }
  if (hasQuarantinedPublications) {
    await validateInventoryAtTree(quarantinedPublications, "publications", inventory, false);
  }

  if (hasSourceDirect && !hasQuarantinedDirect) {
    await rename(directPath, quarantinedDirect).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    await syncDirectory(workersRoot);
    await syncDirectory(quarantinePath);
  }
  if (hasSourcePublications && !hasQuarantinedPublications) {
    const directMoved = await requireDirectoryOrMissing(quarantinedDirect);
    const directStillInSource = await requireDirectoryOrMissing(directPath);
    if (!directMoved && directStillInSource)
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    await rename(publicationPath, quarantinedPublications).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    await syncDirectory(publicationRoot);
    await syncDirectory(quarantinePath);
  }

  for (const [target, label] of [
    [quarantinedDirect, "direct"],
    [quarantinedPublications, "publications"],
  ] as const) {
    if (await requireDirectoryOrMissing(target)) {
      await validateInventoryAtTree(target, label, inventory, false);
      await removeOwnedTreeDurably(target, input.afterEntryRemoved);
    }
  }
  const after = await inspectWorkerdWorkerExecutionCopies({
    groupDirectory: directory,
    workerResourceUid: input.workerResourceUid,
    listenerPort: input.listenerPort,
    scriptName: input.scriptName,
  });
  if (after.generationKeys.length !== 0 || after.versionUids.length !== 0) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  if (await requireDirectoryOrMissing(quarantinedDirect))
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  if (await requireDirectoryOrMissing(quarantinedPublications))
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  const persistedInventory = await readCleanupInventory(inventoryPath, input, expectedReceipt);
  if (digestInventory(persistedInventory) !== input.cleanupManifestSha256)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  return { receipt: expectedReceipt };
}

async function readPointerGeneration(directPath: string): Promise<string> {
  const text = await readRequiredRegularFile(join(directPath, WORKER_POINTER_NAME));
  try {
    const pointer = JSON.parse(text) as Record<string, unknown>;
    if (typeof pointer.generation !== "string") throw new Error();
    return pointer.generation;
  } catch {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
}

async function requireOwnedDirectory(path: string): Promise<string> {
  try {
    const absolute = await realpath(path);
    if (absolute !== path) throw new Error();
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error();
    return absolute;
  } catch {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
}

async function readRequiredRegularFile(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error();
    return await readFile(path, "utf8");
  } catch {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
}

async function requireNoSymlinksOrSpecialFiles(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink())
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  if (info.isDirectory()) {
    if ((info.mode & 0o077) !== 0)
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    const entries = await readdir(path).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    if (entries.length > 100_000) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    for (const entry of entries) await requireNoSymlinksOrSpecialFiles(join(path, entry));
    return;
  }
  if (!info.isFile()) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
}

async function requireDirectoryOrMissing(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  return true;
}

async function requireEmptyDirectoryOrMissing(path: string): Promise<void> {
  if (!(await requireDirectoryOrMissing(path))) return;
  const entries = await readdir(path).catch(() => {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  if (entries.length !== 0) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
}

async function removeOwnedTreeDurably(path: string, afterEntryRemoved?: () => void): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink())
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  if (info.isDirectory()) {
    const entries = await readdir(path).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    for (const entry of entries) await removeOwnedTreeDurably(join(path, entry), afterEntryRemoved);
    await syncDirectory(path);
    await rmdir(path).catch(() => {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    });
    await syncDirectory(dirname(path));
    afterEntryRemoved?.();
    return;
  }
  if (!info.isFile()) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  await unlink(path).catch(() => {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  });
  await syncDirectory(dirname(path));
  afterEntryRemoved?.();
}

async function verifyStoredVersionTree(root: string, manifestValue: unknown): Promise<void> {
  if (!manifestValue || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  const manifest = manifestValue as Record<string, unknown>;
  const expected = new Map<string, { readonly size: number; readonly sha256: string }>();
  if (manifest.kind === "static") {
    if (
      Object.keys(manifest).sort().join(",") !==
        "assets,fetchHandler,generation,hostnames,kind,workerResourceUid" ||
      manifest.fetchHandler !== false
    ) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
  } else {
    if (
      typeof manifest.moduleFiles !== "object" ||
      manifest.moduleFiles === null ||
      Array.isArray(manifest.moduleFiles)
    ) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    const moduleFiles = manifest.moduleFiles as Record<string, unknown>;
    if (Object.keys(moduleFiles).sort().join(",") !== "application,hostPrivate") {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    for (const [directory, inventory] of [
      ["application", moduleFiles.application],
      ["host-private", moduleFiles.hostPrivate],
    ] as const) {
      if (!Array.isArray(inventory))
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      for (const [index, entryValue] of inventory.entries()) {
        if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue))
          throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
        const entry = entryValue as Record<string, unknown>;
        if (
          Object.keys(entry).sort().join(",") !== "digest,key,name,size" ||
          entry.key !== `module-${index.toString(10).padStart(5, "0")}` ||
          typeof entry.digest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(entry.digest) ||
          !Number.isSafeInteger(entry.size) ||
          (entry.size as number) < 0
        ) {
          throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
        }
        expected.set(`${directory}/${entry.key}`, {
          size: entry.size as number,
          sha256: entry.digest.slice("sha256:".length),
        });
      }
    }
  }
  const assetManifest = manifest.assets;
  if (assetManifest !== undefined) {
    if (!assetManifest || typeof assetManifest !== "object" || Array.isArray(assetManifest)) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    const assets = assetManifest as Record<string, unknown>;
    if (typeof assets.files !== "object" || assets.files === null || Array.isArray(assets.files)) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
    const assetEntries = Object.entries(assets.files as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    for (const [index, [, entryValue]] of assetEntries.entries()) {
      if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue))
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      const entry = entryValue as Record<string, unknown>;
      if (
        Object.keys(entry).sort().join(",") !== "digest,key,mediaType,size" ||
        entry.key !== `asset-${index.toString(10).padStart(5, "0")}` ||
        typeof entry.digest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(entry.digest) ||
        !Number.isSafeInteger(entry.size) ||
        (entry.size as number) < 0
      ) {
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      }
      expected.set(`assets/${entry.key}`, {
        size: entry.size as number,
        sha256: entry.digest.slice("sha256:".length),
      });
    }
  }
  if (expected.size === 0) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");

  const actual = new Map<string, Uint8Array>();
  const actualDirectories = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory);
    for (const name of entries) {
      if (name === "" || name === "." || name === ".." || name.includes("/"))
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      const child = join(directory, name);
      const childInfo = await lstat(child).catch(() => null);
      if (!childInfo || childInfo.isSymbolicLink())
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      const relative = prefix ? `${prefix}/${name}` : name;
      if (childInfo.isDirectory()) {
        actualDirectories.add(relative);
        await visit(child, relative);
      } else if (childInfo.isFile()) {
        actual.set(relative, await readFile(child));
      } else {
        throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
      }
    }
  };
  await visit(root, "");
  if (actual.size !== expected.size)
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  const expectedDirectories = new Set<string>();
  for (const name of expected.keys()) {
    const segments = name.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  if (
    actualDirectories.size !== expectedDirectories.size ||
    [...actualDirectories].some((directory) => !expectedDirectories.has(directory))
  ) {
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  }
  for (const [name, proof] of expected) {
    const bytes = actual.get(name);
    if (!bytes || bytes.byteLength !== proof.size || sha256(bytes) !== proof.sha256) {
      throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
    }
  }
}
