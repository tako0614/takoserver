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
const PLANE_TOKEN_BYTES = 32;
/** The Form's own `maxItems` for `kvBindings` and for `sqliteBindings`. */
const MAX_DATA_BINDINGS = 64;
const MUTEXES = new Map<string, Promise<void>>();

/** The record shape a version that declares no data plane still writes. */
const FORMAT_V1 = "takoserver.selfhost-version-bindings@v1";
/** The shape that also carries the KV/SQL projection and its plane secret. */
const FORMAT_V2 = "takoserver.selfhost-version-bindings@v2";

export const SELFHOST_VERSION_DATA_BINDING_KINDS = ["edge.kv", "edge.sql"] as const;
export type SelfhostVersionDataBindingKind = (typeof SELFHOST_VERSION_DATA_BINDING_KINDS)[number];

export const SELFHOST_WORKER_HANDLER_NAMES = ["fetch", "queue", "scheduled"] as const;
export type SelfhostWorkerHandlerName = (typeof SELFHOST_WORKER_HANDLER_NAMES)[number];

const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface SelfhostVersionBinding {
  readonly name: string;
  /** Rendered exactly as the module environment must see it. */
  readonly value: string;
  /** `text` is a string binding; `json` is parsed by the runtime before use. */
  readonly kind: "text" | "json";
}

/**
 * One `kvBindings` or `sqliteBindings` entry, resolved to what it addresses.
 *
 * `target` is the namespace id or database name this Host derived for the
 * related Resource, never a customer string and never a filesystem path. The
 * Worker never sees it: it addresses its own binding by name and the data plane
 * resolves the name through this record, so a Worker cannot reach a namespace
 * its Version did not declare.
 */
export interface SelfhostVersionDataBinding {
  readonly kind: SelfhostVersionDataBindingKind;
  readonly name: string;
  readonly target: string;
}

/**
 * The half of a version's environment that needs a wrapper module.
 *
 * A KV or SQL binding is not a value workerd can carry — there is no such
 * binding type — so the version is published through a generated entrypoint
 * that projects the exact `edge.kv` / `edge.sql` facades over this Host's data
 * planes. The declared handlers are recorded here because the wrapper has to
 * re-export exactly them, and a republish happens long after the apply that
 * read the declaration.
 */
export interface SelfhostVersionDataPlane {
  readonly handlers: readonly SelfhostWorkerHandlerName[];
  readonly bindings: readonly SelfhostVersionDataBinding[];
}

export interface SelfhostVersionBindingSet {
  /** Non-secret configuration from the Worker Version's own `vars`. */
  readonly vars: readonly SelfhostVersionBinding[];
  /** Values delivered through the runtime-input lease, never from portable state. */
  readonly sensitiveVars: readonly SelfhostVersionBinding[];
  /** Absent when the version binds no KV namespace and no SQLite database. */
  readonly dataPlane?: SelfhostVersionDataPlane;
}

export interface StoredSelfhostVersionBindings extends SelfhostVersionBindingSet {
  /** Salted commitment to this exact binding set; safe to place in a generation. */
  readonly digest: `sha256:${string}`;
  /**
   * The per-version secret the generated entrypoint presents to the data
   * planes. Minted once and kept across a retry, exactly like the salt, because
   * a Worker Version is immutable and a second token would leave the serving
   * script authenticating with one this Host no longer holds. Never logged,
   * never observed, never projected into the module environment.
   */
  readonly planeToken?: string;
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
        const planeToken = normalized.dataPlane
          ? base64Url(Uint8Array.from(randomBytes(PLANE_TOKEN_BYTES)))
          : undefined;
        if (
          decodedLength(salt) !== SALT_BYTES ||
          (planeToken !== undefined && decodedLength(planeToken) !== PLANE_TOKEN_BYTES)
        ) {
          throw new SelfhostVersionBindingStoreError("unavailable");
        }
        const raw = canonicalRecord(salt, normalized, planeToken);
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
        return {
          ...normalized,
          digest: digestOf(salt, normalized, planeToken),
          ...(planeToken === undefined ? {} : { planeToken }),
        };
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
  const dataPlane = set.dataPlane === undefined ? undefined : normalizeDataPlane(set.dataPlane);
  const names = new Set<string>();
  for (const name of [
    ...vars.map((binding) => binding.name),
    ...sensitiveVars.map((binding) => binding.name),
    ...(dataPlane?.bindings ?? []).map((binding) => binding.name),
  ]) {
    if (names.has(name)) throw new SelfhostVersionBindingStoreError("corrupt");
    names.add(name);
  }
  return { vars, sensitiveVars, ...(dataPlane ? { dataPlane } : {}) };
}

/**
 * A data plane is present or it is not; an empty one is a contradiction.
 *
 * The wrapper module exists only to carry these bindings, so a version that
 * declares none must publish the same bytes it published before this Host could
 * project any. Refusing the empty shape here is what keeps that true.
 */
function normalizeDataPlane(plane: SelfhostVersionDataPlane): SelfhostVersionDataPlane {
  if (typeof plane !== "object" || plane === null || Array.isArray(plane)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (!Array.isArray(plane.handlers) || !Array.isArray(plane.bindings)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const handlers = [...plane.handlers].sort();
  if (
    handlers.length === 0 ||
    handlers.length > SELFHOST_WORKER_HANDLER_NAMES.length ||
    new Set(handlers).size !== handlers.length ||
    handlers.some(
      (handler) => !(SELFHOST_WORKER_HANDLER_NAMES as readonly string[]).includes(handler),
    )
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const bindings = [...plane.bindings].sort((left, right) => (left?.name < right?.name ? -1 : 1));
  if (bindings.length === 0 || bindings.length > 2 * MAX_DATA_BINDINGS) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  for (const binding of bindings) {
    if (
      typeof binding?.name !== "string" ||
      binding.name.length === 0 ||
      binding.name.length > 64 ||
      typeof binding.target !== "string" ||
      binding.target.length === 0 ||
      binding.target.length > 512 ||
      !(SELFHOST_VERSION_DATA_BINDING_KINDS as readonly string[]).includes(binding.kind)
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
  }
  return {
    handlers,
    bindings: bindings.map((binding) => ({
      kind: binding.kind,
      name: binding.name,
      target: binding.target,
    })),
  };
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
  return JSON.stringify({
    vars: set.vars,
    sensitiveVars: set.sensitiveVars,
    dataPlane: set.dataPlane ?? null,
  });
}

/**
 * The exact bytes on disk, in one place, so `parseStored` can prove a record it
 * read back is the record this function would have written.
 *
 * A version with no data plane writes the shape it always wrote, under the
 * format it always wrote — the fields the wrapper needs appear together with
 * the `@v2` name that says they are there. That is what lets a machine
 * published by an earlier build keep serving, and what makes "no KV, no SQL,
 * byte-identical" a property of the file rather than of a code path.
 */
function canonicalRecord(
  salt: string,
  set: SelfhostVersionBindingSet,
  planeToken: string | undefined,
): string {
  if (!set.dataPlane) {
    return JSON.stringify({
      format: FORMAT_V1,
      salt,
      vars: set.vars,
      sensitiveVars: set.sensitiveVars,
    });
  }
  return JSON.stringify({
    format: FORMAT_V2,
    salt,
    vars: set.vars,
    sensitiveVars: set.sensitiveVars,
    dataPlane: {
      handlers: set.dataPlane.handlers,
      bindings: set.dataPlane.bindings.map((binding) => ({
        kind: binding.kind,
        name: binding.name,
        target: binding.target,
      })),
    },
    planeToken,
  });
}

/**
 * A salted commitment rather than a plain hash of the values. The digest is
 * placed in the runtime generation, which is written to a manifest a workerd
 * reload reads; an unsalted SHA-256 of a short secret is guessable, and a
 * generation string is not a place to put one.
 */
function digestOf(
  salt: string,
  set: SelfhostVersionBindingSet,
  planeToken: string | undefined,
): `sha256:${string}` {
  const record = canonicalRecord(salt, set, planeToken);
  return `sha256:${createHash("sha256").update(record, "utf8").digest("hex")}`;
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
  const keys = Object.keys(record).sort().join(",");
  const planeRecord =
    record.format === FORMAT_V2 && keys === "dataPlane,format,planeToken,salt,sensitiveVars,vars";
  if (
    !(planeRecord || (record.format === FORMAT_V1 && keys === "format,salt,sensitiveVars,vars")) ||
    typeof record.salt !== "string" ||
    decodedLength(record.salt) !== SALT_BYTES
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const planeToken = planeRecord ? record.planeToken : undefined;
  if (
    planeRecord &&
    (typeof planeToken !== "string" || decodedLength(planeToken) !== PLANE_TOKEN_BYTES)
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const set = normalizeSet({
    vars: parsedBindings(record.vars),
    sensitiveVars: parsedBindings(record.sensitiveVars),
    ...(planeRecord ? { dataPlane: parsedDataPlane(record.dataPlane) } : {}),
  });
  if (canonicalRecord(record.salt, set, planeToken as string | undefined) !== decodeUtf8(bytes)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return {
    ...set,
    digest: digestOf(record.salt, set, planeToken as string | undefined),
    ...(planeToken === undefined ? {} : { planeToken: planeToken as string }),
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function parsedDataPlane(value: unknown): SelfhostVersionDataPlane {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const plane = value as Record<string, unknown>;
  if (Object.keys(plane).sort().join(",") !== "bindings,handlers") {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (!Array.isArray(plane.bindings)) throw new SelfhostVersionBindingStoreError("corrupt");
  for (const entry of plane.bindings) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    if (
      Object.keys(entry as Record<string, unknown>)
        .sort()
        .join(",") !== "kind,name,target"
    ) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
  }
  return plane as unknown as SelfhostVersionDataPlane;
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
