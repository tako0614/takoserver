import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const SCRIPT_STATE_MAX_BYTES = 64 * 1_024;
const SCRIPT_STATE_MUTEXES = new Map<string, Promise<void>>();

export interface SelfhostScriptState {
  readonly activeVersion?: string;
  readonly endpointHostname?: string;
  readonly domains: readonly string[];
}

export interface SelfhostScriptStateSnapshot {
  readonly state: SelfhostScriptState;
  readonly revision: string | null;
}

export class SelfhostScriptStateStoreError extends Error {
  constructor(readonly code: "corrupt" | "conflict" | "unavailable") {
    super(`selfhost_script_state_${code}`);
    this.name = "SelfhostScriptStateStoreError";
  }
}

export interface SelfhostScriptStateFile {
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface SelfhostScriptStateFileSystem {
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  openExclusive(path: string): Promise<SelfhostScriptStateFile>;
  replace(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<boolean>;
  syncDirectory(path: string): Promise<void>;
}

export const nodeSelfhostScriptStateFileSystem: SelfhostScriptStateFileSystem = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },

  async read(path) {
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  },

  async openExclusive(path) {
    const handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    return {
      async write(bytes) {
        await handle.writeFile(bytes);
      },
      async sync() {
        await handle.sync();
      },
      async close() {
        await handle.close();
      },
    };
  },

  async replace(source, destination) {
    await rename(source, destination);
  },

  async remove(path) {
    try {
      await rm(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  },

  async syncDirectory(path) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      if (!directorySyncUnsupported(error)) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};

export interface SelfhostScriptStateStore {
  read(script: string): Promise<SelfhostScriptStateSnapshot>;
  write(
    script: string,
    expectedRevision: string | null,
    state: SelfhostScriptState,
  ): Promise<SelfhostScriptStateSnapshot>;
  remove(script: string): Promise<boolean>;
}

export function createSelfhostScriptStateStore(options: {
  readonly root: string;
  readonly fileSystem?: SelfhostScriptStateFileSystem;
}): SelfhostScriptStateStore {
  const root = resolve(options.root);
  const fileSystem = options.fileSystem ?? nodeSelfhostScriptStateFileSystem;
  const pathFor = (script: string) => join(root, `${script}.json`);
  const temporaryPathFor = (script: string) => `${pathFor(script)}.tmp`;

  const cleanAbandonedWrite = async (script: string): Promise<void> => {
    try {
      if (await fileSystem.remove(temporaryPathFor(script))) {
        await fileSystem.syncDirectory(root);
      }
    } catch {
      throw new SelfhostScriptStateStoreError("unavailable");
    }
  };

  const readCurrent = async (script: string): Promise<SelfhostScriptStateSnapshot> => {
    let bytes: Uint8Array | null;
    try {
      bytes = await fileSystem.read(pathFor(script));
    } catch {
      throw new SelfhostScriptStateStoreError("unavailable");
    }
    if (bytes === null) return { state: { domains: [] }, revision: null };
    if (bytes.byteLength < 2 || bytes.byteLength > SCRIPT_STATE_MAX_BYTES) {
      throw new SelfhostScriptStateStoreError("corrupt");
    }
    let raw: string;
    let parsed: unknown;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      parsed = JSON.parse(raw);
    } catch {
      throw new SelfhostScriptStateStoreError("corrupt");
    }
    return { state: persistedState(parsed), revision: revision(bytes) };
  };

  const locked = <T>(script: string, operation: () => Promise<T>): Promise<T> =>
    withScriptStateMutex(`${root}\0${script}`, operation);

  return {
    async read(script) {
      return await locked(script, async () => {
        await cleanAbandonedWrite(script);
        return await readCurrent(script);
      });
    },

    async write(script, expectedRevision, state) {
      return await locked(script, async () => {
        try {
          await fileSystem.mkdir(root);
        } catch {
          throw new SelfhostScriptStateStoreError("unavailable");
        }
        await cleanAbandonedWrite(script);
        const current = await readCurrent(script);
        if (current.revision !== expectedRevision) {
          throw new SelfhostScriptStateStoreError("conflict");
        }
        const normalized = persistedState(state);
        const raw = JSON.stringify(normalized);
        const bytes = new TextEncoder().encode(raw);
        if (bytes.byteLength > SCRIPT_STATE_MAX_BYTES) {
          throw new SelfhostScriptStateStoreError("corrupt");
        }
        const temporaryPath = temporaryPathFor(script);
        let file: SelfhostScriptStateFile | undefined;
        let closed = false;
        try {
          file = await fileSystem.openExclusive(temporaryPath);
          await file.write(bytes);
          await file.sync();
          await file.close();
          closed = true;
          await fileSystem.replace(temporaryPath, pathFor(script));
          await fileSystem.syncDirectory(root);
        } catch (error) {
          if (!closed) await file?.close().catch(() => undefined);
          if (error instanceof SelfhostScriptStateStoreError) throw error;
          throw new SelfhostScriptStateStoreError("unavailable");
        } finally {
          await fileSystem.remove(temporaryPath).catch(() => undefined);
        }
        return { state: normalized, revision: revision(bytes) };
      });
    },

    async remove(script) {
      return await locked(script, async () => {
        await cleanAbandonedWrite(script);
        let removed: boolean;
        try {
          removed = await fileSystem.remove(pathFor(script));
          if (removed) await fileSystem.syncDirectory(root);
        } catch {
          throw new SelfhostScriptStateStoreError("unavailable");
        }
        return removed;
      });
    },
  };
}

async function withScriptStateMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = SCRIPT_STATE_MUTEXES.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  SCRIPT_STATE_MUTEXES.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (SCRIPT_STATE_MUTEXES.get(key) === current) SCRIPT_STATE_MUTEXES.delete(key);
  }
}

function revision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function persistedState(value: unknown): SelfhostScriptState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SelfhostScriptStateStoreError("corrupt");
  }
  const parsed = value as Record<string, unknown>;
  const keys = Object.keys(parsed);
  if (
    keys.some(
      (key) => key !== "activeVersion" && key !== "endpointHostname" && key !== "domains",
    ) ||
    !Array.isArray(parsed.domains) ||
    parsed.domains.some((entry) => typeof entry !== "string") ||
    (parsed.activeVersion !== undefined && typeof parsed.activeVersion !== "string") ||
    (parsed.endpointHostname !== undefined && typeof parsed.endpointHostname !== "string")
  ) {
    throw new SelfhostScriptStateStoreError("corrupt");
  }
  return {
    ...(typeof parsed.activeVersion === "string" ? { activeVersion: parsed.activeVersion } : {}),
    ...(typeof parsed.endpointHostname === "string"
      ? { endpointHostname: parsed.endpointHostname }
      : {}),
    domains: [...(parsed.domains as string[])],
  };
}

function directorySyncUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "ENOSYS" ||
    (process.platform === "win32" && (code === "EPERM" || code === "EISDIR"))
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
