import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { spawnWorkerdWithParentDeath, workerPortOwnership } from "./workerd-linux-process.ts";
import { createWorkerdSupervisor, type WorkerdProcess } from "./workerd-supervisor.ts";

const MANIFEST_NAME = "group.json";
const CONFIG_NAME = "workerd.conf";
const RECEIPT_NAME = "retirement.json";
const RECEIPT_TEMP_PREFIX = ".retirement-";

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
  start(): Promise<void>;
  fetch(request: Request): Promise<Response>;
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
  readonly workerdBinary: string | null;
  readonly spawn?: (command: readonly string[]) => WorkerdProcess;
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
  let state: GroupState = input.initialState;
  let supervisor: ReturnType<typeof createWorkerdSupervisor> | null = null;
  let startPromise: Promise<void> | null = null;
  let retirePromise: Promise<WorkerdWorkerRetirementReceipt> | null = null;
  let retiringOperationId: string | null = null;
  let retirementStarted = input.initialState === "retired";
  let receipt = input.receipt ? Object.freeze({ ...input.receipt }) : undefined;

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
    const promise = created.ensure(join(directory, CONFIG_NAME)).then(
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
      await owner.ensure(join(directory, CONFIG_NAME));
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
        await supervisor?.shutdown();
        if ((await workerPortOwnership(options.listenerPort, undefined)) !== "vacant")
          throw new WorkerdWorkerExecutionGroupError("retirement_uncertain");
        const completed: WorkerdWorkerRetirementReceipt = Object.freeze({
          workerResourceUid: options.workerResourceUid,
          operationId,
          listenerPort: options.listenerPort,
          configurationSha256: manifest.configurationSha256,
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
    start,
    fetch: fetchRequest,
    retire,
  });
}

export async function openWorkerdWorkerExecutionGroup(
  options: OpenWorkerdWorkerExecutionGroupOptions,
): Promise<WorkerdWorkerExecutionGroup> {
  validateIdentity(options.workerResourceUid);
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
  if (created) {
    try {
      // Persist the UID's permanent directory entry before any child can start.
      await syncDirectory(canonicalRoot);
      const configFile = await open(join(directory, CONFIG_NAME), "wx", 0o600);
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
  const configurationInfo = await lstat(join(directory, CONFIG_NAME)).catch(() => null);
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
  const storedConfiguration = await readFile(join(directory, CONFIG_NAME)).catch(() => null);
  if (
    !parseExactJson(manifestText, manifest) ||
    !storedConfiguration ||
    !Buffer.from(storedConfiguration).equals(Buffer.from(options.configuration))
  )
    throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
  const receiptText = await readText(join(directory, RECEIPT_NAME));
  if (receiptText === null) throw new WorkerdWorkerExecutionGroupError("ownership_uncertain");
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
