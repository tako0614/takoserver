import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Durable runtime bindings for one immutable Worker Version.
 *
 * These live outside the version directory on purpose. That directory's
 * `materializationDigest` means "the bytes the tenant committed", and its
 * `meta.json` is a closed shape whose reader rejects unknown keys and unknown
 * entries — so a binding written into it would turn every already-materialized
 * version corrupt. Bindings are a create-time fact about the same version, kept
 * beside it rather than inside it.
 *
 * The file is `0600` under a `0700` root, because a sensitive var is a value in
 * it. Nothing here is ever logged, and the only thing this module hands to a
 * caller that may travel further is `digest`: a salted commitment, so a short
 * secret cannot be recovered from the runtime generation string that carries it.
 */

const MAX_BYTES = 4 * 1_024 * 1_024;
const SALT_BYTES = 32;
const MUTEXES = new Map<string, Promise<void>>();

const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface SelfhostVersionBinding {
  readonly name: string;
  /** Rendered exactly as the module environment must see it. */
  readonly value: string;
  /** `text` is a string binding; `json` is parsed by the runtime before use. */
  readonly kind: "text" | "json";
}

export interface SelfhostVersionBindingSet {
  /** Non-secret configuration from the Worker Version's own `vars`. */
  readonly vars: readonly SelfhostVersionBinding[];
  /** Values delivered through the runtime-input lease, never from portable state. */
  readonly sensitiveVars: readonly SelfhostVersionBinding[];
}

export interface StoredSelfhostVersionBindings extends SelfhostVersionBindingSet {
  /** Salted commitment to this exact binding set; safe to place in a generation. */
  readonly digest: `sha256:${string}`;
}

export class SelfhostVersionBindingStoreError extends Error {
  constructor(readonly code: "corrupt" | "unavailable") {
    super(`selfhost_version_bindings_${code}`);
    this.name = "SelfhostVersionBindingStoreError";
  }
}

export interface SelfhostVersionBindingStore {
  /** The stored set, or null when this version declared none. */
  read(script: string, versionId: string): Promise<StoredSelfhostVersionBindings | null>;
  /**
   * Writes the set for one version. A Worker Version is immutable, so a retry
   * that presents the same bindings adopts the stored record — salt included —
   * rather than minting a generation the runtime would then have to chase.
   */
  write(
    script: string,
    versionId: string,
    set: SelfhostVersionBindingSet,
  ): Promise<StoredSelfhostVersionBindings>;
  remove(script: string, versionId: string): Promise<boolean>;
  /** Forgets every version of one script. */
  removeScript(script: string): Promise<void>;
}

export function createSelfhostVersionBindingStore(options: {
  readonly root: string;
  readonly randomBytes?: (length: number) => Uint8Array;
}): SelfhostVersionBindingStore {
  const root = resolve(options.root);
  const randomBytes = options.randomBytes ?? ((length: number) => nodeRandomBytes(length));

  const directoryFor = (script: string): string => {
    if (!SCRIPT_NAME.test(script)) throw new SelfhostVersionBindingStoreError("corrupt");
    return join(root, script);
  };
  const pathFor = (script: string, versionId: string): string => {
    if (!VERSION_ID.test(versionId)) throw new SelfhostVersionBindingStoreError("corrupt");
    return join(directoryFor(script), `${versionId}.json`);
  };

  const readCurrent = async (
    script: string,
    versionId: string,
  ): Promise<StoredSelfhostVersionBindings | null> => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(pathFor(script, versionId)));
    } catch (error) {
      if (error instanceof SelfhostVersionBindingStoreError) throw error;
      if (errorCode(error) === "ENOENT") return null;
      throw new SelfhostVersionBindingStoreError("unavailable");
    }
    if (bytes.byteLength < 2 || bytes.byteLength > MAX_BYTES) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    return parseStored(bytes);
  };

  return {
    async read(script, versionId) {
      return await locked(`${root}\u0000${script}\u0000${versionId}`, async () => {
        await cleanAbandonedWrite(pathFor(script, versionId));
        return await readCurrent(script, versionId);
      });
    },

    async write(script, versionId, set) {
      const normalized = normalizeSet(set);
      return await locked(`${root}\u0000${script}\u0000${versionId}`, async () => {
        const path = pathFor(script, versionId);
        await cleanAbandonedWrite(path);
        const current = await readCurrent(script, versionId);
        if (current && sameBindings(current, normalized)) return current;
        try {
          // 0700 so a second account on the machine cannot even enumerate which
          // versions carry which binding names.
          await mkdir(directoryFor(script), { recursive: true, mode: 0o700 });
        } catch {
          throw new SelfhostVersionBindingStoreError("unavailable");
        }
        const salt = base64Url(Uint8Array.from(randomBytes(SALT_BYTES)));
        if (decodedLength(salt) !== SALT_BYTES) {
          throw new SelfhostVersionBindingStoreError("unavailable");
        }
        const raw = canonicalRecord(salt, normalized);
        const bytes = new TextEncoder().encode(raw);
        if (bytes.byteLength > MAX_BYTES) throw new SelfhostVersionBindingStoreError("corrupt");
        const temporary = `${path}.tmp`;
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let closed = false;
        try {
          handle = await open(
            temporary,
            fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              fsConstants.O_WRONLY |
              fsConstants.O_NOFOLLOW,
            0o600,
          );
          await handle.writeFile(bytes);
          await handle.sync();
          await handle.close();
          closed = true;
          await rename(temporary, path);
          await syncDirectory(directoryFor(script));
        } catch {
          if (!closed) await handle?.close().catch(() => undefined);
          throw new SelfhostVersionBindingStoreError("unavailable");
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        return { ...normalized, digest: digestOf(salt, normalized) };
      });
    },

    async remove(script, versionId) {
      return await locked(`${root}\u0000${script}\u0000${versionId}`, async () => {
        const path = pathFor(script, versionId);
        await cleanAbandonedWrite(path);
        try {
          await rm(path);
          await syncDirectory(directoryFor(script));
          return true;
        } catch (error) {
          if (errorCode(error) === "ENOENT") return false;
          throw new SelfhostVersionBindingStoreError("unavailable");
        }
      });
    },

    async removeScript(script) {
      try {
        await rm(directoryFor(script), { recursive: true, force: true });
      } catch (error) {
        if (error instanceof SelfhostVersionBindingStoreError) throw error;
        throw new SelfhostVersionBindingStoreError("unavailable");
      }
    },
  };
}

async function cleanAbandonedWrite(path: string): Promise<void> {
  try {
    await rm(`${path}.tmp`, { force: true });
  } catch {
    throw new SelfhostVersionBindingStoreError("unavailable");
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = MUTEXES.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  MUTEXES.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (MUTEXES.get(key) === current) MUTEXES.delete(key);
  }
}

/**
 * The purely declarative half of `write`: shape, grammar, ordering, and the
 * rule that a `vars` name and a sensitive name cannot collide.
 *
 * It is exported because the caller must be able to run it *before* it spends a
 * one-shot runtime-input lease. A refusal that needs no disk is a refusal that
 * must not happen after the ciphertext has been erased.
 */
export function normalizeSelfhostVersionBindingSet(
  set: SelfhostVersionBindingSet,
): SelfhostVersionBindingSet {
  return normalizeSet(set);
}

function normalizeSet(set: SelfhostVersionBindingSet): SelfhostVersionBindingSet {
  const vars = normalizeBindings(set.vars);
  const sensitiveVars = normalizeBindings(set.sensitiveVars);
  const names = new Set<string>();
  for (const binding of [...vars, ...sensitiveVars]) {
    if (names.has(binding.name)) throw new SelfhostVersionBindingStoreError("corrupt");
    names.add(binding.name);
  }
  return { vars, sensitiveVars };
}

function normalizeBindings(
  bindings: readonly SelfhostVersionBinding[],
): readonly SelfhostVersionBinding[] {
  if (!Array.isArray(bindings)) throw new SelfhostVersionBindingStoreError("corrupt");
  const sorted = [...bindings].sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const binding of sorted) {
    if (
      typeof binding?.name !== "string" ||
      binding.name.length === 0 ||
      typeof binding.value !== "string" ||
      (binding.kind !== "text" && binding.kind !== "json")
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
  }
  return sorted.map((binding) => ({
    name: binding.name,
    value: binding.value,
    kind: binding.kind,
  }));
}

function sameBindings(left: SelfhostVersionBindingSet, right: SelfhostVersionBindingSet): boolean {
  return canonicalBindings(left) === canonicalBindings(right);
}

function canonicalBindings(set: SelfhostVersionBindingSet): string {
  return JSON.stringify({ vars: set.vars, sensitiveVars: set.sensitiveVars });
}

function canonicalRecord(salt: string, set: SelfhostVersionBindingSet): string {
  return JSON.stringify({
    format: "takoserver.selfhost-version-bindings@v1",
    salt,
    vars: set.vars,
    sensitiveVars: set.sensitiveVars,
  });
}

/**
 * A salted commitment rather than a plain hash of the values. The digest is
 * placed in the runtime generation, which is written to a manifest a workerd
 * reload reads; an unsalted SHA-256 of a short secret is guessable, and a
 * generation string is not a place to put one.
 */
function digestOf(salt: string, set: SelfhostVersionBindingSet): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalRecord(salt, set), "utf8").digest("hex")}`;
}

function parseStored(bytes: Uint8Array): StoredSelfhostVersionBindings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "format,salt,sensitiveVars,vars" ||
    record.format !== "takoserver.selfhost-version-bindings@v1" ||
    typeof record.salt !== "string" ||
    decodedLength(record.salt) !== SALT_BYTES
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const set = normalizeSet({
    vars: parsedBindings(record.vars),
    sensitiveVars: parsedBindings(record.sensitiveVars),
  });
  if (canonicalRecord(record.salt, set) !== new TextDecoder().decode(bytes)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return { ...set, digest: digestOf(record.salt, set) };
}

function parsedBindings(value: unknown): readonly SelfhostVersionBinding[] {
  if (!Array.isArray(value)) throw new SelfhostVersionBindingStoreError("corrupt");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    const binding = entry as Record<string, unknown>;
    if (Object.keys(binding).sort().join(",") !== "kind,name,value") {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    return binding as unknown as SelfhostVersionBinding;
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodedLength(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return -1;
  const remainder = value.length % 4;
  if (remainder === 1) return -1;
  return Math.floor((value.length * 3) / 4);
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
