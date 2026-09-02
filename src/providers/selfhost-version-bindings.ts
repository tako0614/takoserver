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
const EVENT_TOKEN_BYTES = 32;
/** The Form's own `maxItems` for `kvBindings` and for `sqliteBindings`. */
const MAX_DATA_BINDINGS = 64;
const MUTEXES = new Map<string, Promise<void>>();

/** The record shape a version that declares no data plane still writes. */
const FORMAT_V1 = "takoserver.selfhost-version-bindings@v1";
/** The shape that also carries the KV/SQL projection and its plane secret. */
const FORMAT_V2 = "takoserver.selfhost-version-bindings@v2";
/**
 * The shape every version writes now: handlers at the top level rather than
 * inside the data plane, and an event token beside the plane token.
 *
 * Handlers moved because a Cron Trigger or a Queue Consumer is attached long
 * after the Version that answers it was published, and the wrapper that
 * receives the event has to re-export exactly the handlers the Version
 * declared. Keeping them inside the data plane made them a fact only a Version
 * with KV or SQL had.
 *
 * The event token is minted with the record for the same reason. A Worker
 * Version is immutable, so there is no later moment at which one could be
 * added: by the time a Consumer exists, the record it would have to go in is
 * already written.
 */
const FORMAT_V3 = "takoserver.selfhost-version-bindings@v3";

export const SELFHOST_VERSION_DATA_BINDING_KINDS = ["edge.kv", "edge.queue", "edge.sql"] as const;
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
 * `target` is the namespace id, queue id, or database name this Host derived
 * for the related Resource, never a customer string and never a filesystem
 * path. The
 * Worker never sees it: it addresses its own binding by name and the data plane
 * resolves the name through this record, so a Worker cannot reach a namespace
 * its Version did not declare.
 */
export interface SelfhostVersionDataBinding {
  readonly kind: SelfhostVersionDataBindingKind;
  readonly name: string;
  readonly target: string;
  /**
   * Only for `edge.queue`: the retention and default delay the queue itself
   * promises, recorded with the binding because the plane has to apply them at
   * the moment a message is accepted.
   *
   * Recorded rather than looked up, for the same reason `vars` are: a
   * publication projects exactly what its apply resolved. The cost is that
   * raising a queue's retention reaches a Worker on its next published Version,
   * not immediately.
   */
  readonly queue?: SelfhostVersionQueueSettings;
}

export interface SelfhostVersionQueueSettings {
  readonly messageRetentionSeconds: number;
  readonly deliveryDelaySeconds: number;
}

/**
 * The half of a version's environment that needs a data plane behind it.
 *
 * A KV, queue, or SQL binding is not a value workerd can carry — there is no
 * such binding type — so the version is published through a generated
 * entrypoint that projects the exact `edge.kv` / `edge.queue` / `edge.sql`
 * facades over this Host's data planes.
 */
export interface SelfhostVersionDataPlane {
  readonly bindings: readonly SelfhostVersionDataBinding[];
}

export interface SelfhostVersionBindingSet {
  /**
   * The events the Version says its module answers.
   *
   * Recorded for every Version, with or without a binding, because the wrapper
   * that receives a queue batch or a cron match has to re-export exactly them
   * and is generated long after the apply that read the declaration.
   */
  readonly handlers: readonly SelfhostWorkerHandlerName[];
  /** Non-secret configuration from the Worker Version's own `vars`. */
  readonly vars: readonly SelfhostVersionBinding[];
  /** Values delivered through the runtime-input lease, never from portable state. */
  readonly sensitiveVars: readonly SelfhostVersionBinding[];
  /** Absent when the version binds no namespace, queue, or database. */
  readonly dataPlane?: SelfhostVersionDataPlane;
}

export interface StoredSelfhostVersionBindings {
  /**
   * Absent on a record an earlier build wrote with no data plane. Such a
   * Version publishes exactly as it did; it simply cannot be given a wrapper,
   * so attaching an event to it is refused rather than half-served.
   */
  readonly handlers?: readonly SelfhostWorkerHandlerName[];
  readonly vars: readonly SelfhostVersionBinding[];
  readonly sensitiveVars: readonly SelfhostVersionBinding[];
  readonly dataPlane?: SelfhostVersionDataPlane;
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
  /**
   * The per-version secret this Host presents to the event gate in front of the
   * Worker. Declared on the gate service and nowhere else, so tenant code
   * cannot read it and cannot forge a delivery to its own handlers — or, more
   * to the point, to another script's.
   */
  readonly eventToken?: string;
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
        // Minted for every Version, because a Worker Version is immutable and
        // the Consumer or Trigger that needs it is attached after this record
        // is the only one there will ever be.
        const eventToken = base64Url(Uint8Array.from(randomBytes(EVENT_TOKEN_BYTES)));
        if (
          decodedLength(salt) !== SALT_BYTES ||
          decodedLength(eventToken) !== EVENT_TOKEN_BYTES ||
          (planeToken !== undefined && decodedLength(planeToken) !== PLANE_TOKEN_BYTES)
        ) {
          throw new SelfhostVersionBindingStoreError("unavailable");
        }
        const raw = canonicalRecord(FORMAT_V3, salt, normalized, planeToken, eventToken);
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
          digest: digestOf(FORMAT_V3, salt, normalized, planeToken, eventToken),
          ...(planeToken === undefined ? {} : { planeToken }),
          eventToken,
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
  const handlers = normalizeHandlers(set.handlers);
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
  return { handlers, vars, sensitiveVars, ...(dataPlane ? { dataPlane } : {}) };
}

/** The closed handler vocabulary, sorted, non-empty, without a duplicate. */
function normalizeHandlers(
  handlers: readonly SelfhostWorkerHandlerName[],
): readonly SelfhostWorkerHandlerName[] {
  if (!Array.isArray(handlers)) throw new SelfhostVersionBindingStoreError("corrupt");
  const sorted = [...handlers].sort();
  if (
    sorted.length === 0 ||
    sorted.length > SELFHOST_WORKER_HANDLER_NAMES.length ||
    new Set(sorted).size !== sorted.length ||
    sorted.some(
      (handler) => !(SELFHOST_WORKER_HANDLER_NAMES as readonly string[]).includes(handler),
    )
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return sorted;
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
  if (!Array.isArray(plane.bindings)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const bindings = [...plane.bindings].sort((left, right) => (left?.name < right?.name ? -1 : 1));
  if (bindings.length === 0 || bindings.length > 3 * MAX_DATA_BINDINGS) {
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
    // A queue binding carries its queue's promise; nothing else may.
    if ((binding.queue !== undefined) !== (binding.kind === "edge.queue")) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    if (binding.queue !== undefined) normalizeQueueSettings(binding.queue);
  }
  return {
    bindings: bindings.map((binding) => ({
      kind: binding.kind,
      name: binding.name,
      target: binding.target,
      ...(binding.queue ? { queue: normalizeQueueSettings(binding.queue) } : {}),
    })),
  };
}

function normalizeQueueSettings(
  settings: SelfhostVersionQueueSettings,
): SelfhostVersionQueueSettings {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (Object.keys(settings).sort().join(",") !== "deliveryDelaySeconds,messageRetentionSeconds") {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const { messageRetentionSeconds, deliveryDelaySeconds } = settings;
  if (
    !Number.isSafeInteger(messageRetentionSeconds) ||
    messageRetentionSeconds < 60 ||
    messageRetentionSeconds > 1_209_600 ||
    !Number.isSafeInteger(deliveryDelaySeconds) ||
    deliveryDelaySeconds < 0 ||
    deliveryDelaySeconds > 43_200
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return { messageRetentionSeconds, deliveryDelaySeconds };
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

function sameBindings(
  left: StoredSelfhostVersionBindings,
  right: SelfhostVersionBindingSet,
): boolean {
  return (
    left.handlers !== undefined &&
    canonicalBindings({
      handlers: left.handlers,
      vars: left.vars,
      sensitiveVars: left.sensitiveVars,
      ...(left.dataPlane ? { dataPlane: left.dataPlane } : {}),
    }) === canonicalBindings(right)
  );
}

function canonicalBindings(set: SelfhostVersionBindingSet): string {
  return JSON.stringify({
    handlers: set.handlers,
    vars: set.vars,
    sensitiveVars: set.sensitiveVars,
    dataPlane: set.dataPlane ?? null,
  });
}

/**
 * The exact bytes on disk, in one place, so `parseStored` can prove a record it
 * read back is the record this function would have written.
 *
 * Every format this Host has ever written is reproducible here, because that
 * proof is what tells a torn or tampered file from a good one. `@v1` and `@v2`
 * are read, never written: a machine published by an earlier build keeps
 * serving, and the next Version it publishes is written at `@v3`.
 */
function canonicalRecord(
  format: typeof FORMAT_V1 | typeof FORMAT_V2 | typeof FORMAT_V3,
  salt: string,
  set: SelfhostVersionBindingSet | LegacySet,
  planeToken: string | undefined,
  eventToken: string | undefined,
): string {
  const plane = set.dataPlane
    ? {
        bindings: set.dataPlane.bindings.map((binding) => ({
          kind: binding.kind,
          name: binding.name,
          target: binding.target,
          ...(binding.queue
            ? {
                queue: {
                  messageRetentionSeconds: binding.queue.messageRetentionSeconds,
                  deliveryDelaySeconds: binding.queue.deliveryDelaySeconds,
                },
              }
            : {}),
        })),
      }
    : undefined;
  if (format === FORMAT_V1) {
    return JSON.stringify({
      format: FORMAT_V1,
      salt,
      vars: set.vars,
      sensitiveVars: set.sensitiveVars,
    });
  }
  if (format === FORMAT_V2) {
    return JSON.stringify({
      format: FORMAT_V2,
      salt,
      vars: set.vars,
      sensitiveVars: set.sensitiveVars,
      dataPlane: { handlers: set.handlers, bindings: plane?.bindings },
      planeToken,
    });
  }
  return JSON.stringify({
    format: FORMAT_V3,
    salt,
    handlers: set.handlers,
    vars: set.vars,
    sensitiveVars: set.sensitiveVars,
    ...(plane ? { dataPlane: plane } : {}),
    ...(planeToken === undefined ? {} : { planeToken }),
    eventToken,
  });
}

/** What a record read back carries, before it is proved to be one. */
interface LegacySet {
  readonly handlers?: readonly SelfhostWorkerHandlerName[];
  readonly vars: readonly SelfhostVersionBinding[];
  readonly sensitiveVars: readonly SelfhostVersionBinding[];
  readonly dataPlane?: SelfhostVersionDataPlane;
}

/**
 * A salted commitment rather than a plain hash of the values. The digest is
 * placed in the runtime generation, which is written to a manifest a workerd
 * reload reads; an unsalted SHA-256 of a short secret is guessable, and a
 * generation string is not a place to put one.
 */
function digestOf(
  format: typeof FORMAT_V1 | typeof FORMAT_V2 | typeof FORMAT_V3,
  salt: string,
  set: SelfhostVersionBindingSet | LegacySet,
  planeToken: string | undefined,
  eventToken: string | undefined,
): `sha256:${string}` {
  const record = canonicalRecord(format, salt, set, planeToken, eventToken);
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
  const format =
    record.format === FORMAT_V1 && keys === "format,salt,sensitiveVars,vars"
      ? FORMAT_V1
      : record.format === FORMAT_V2 &&
          keys === "dataPlane,format,planeToken,salt,sensitiveVars,vars"
        ? FORMAT_V2
        : record.format === FORMAT_V3 && isVersion3Keys(keys)
          ? FORMAT_V3
          : null;
  if (
    format === null ||
    typeof record.salt !== "string" ||
    decodedLength(record.salt) !== SALT_BYTES
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const hasPlane = format === FORMAT_V2 || (format === FORMAT_V3 && "dataPlane" in record);
  const planeToken = format === FORMAT_V1 ? undefined : (record.planeToken as unknown);
  if (
    hasPlane &&
    (typeof planeToken !== "string" || decodedLength(planeToken) !== PLANE_TOKEN_BYTES)
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const eventToken = format === FORMAT_V3 ? record.eventToken : undefined;
  if (
    format === FORMAT_V3 &&
    (typeof eventToken !== "string" || decodedLength(eventToken) !== EVENT_TOKEN_BYTES)
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  // `@v2` kept the handlers inside the data plane; `@v3` keeps them beside it,
  // because a Version with no binding declares them too.
  const legacyPlane = format === FORMAT_V2 ? parsedLegacyDataPlane(record.dataPlane) : null;
  const handlers =
    format === FORMAT_V3
      ? normalizeHandlers(parsedHandlers(record.handlers))
      : legacyPlane
        ? normalizeHandlers(legacyPlane.handlers)
        : undefined;
  const set = normalizeSetOrLegacy({
    ...(handlers ? { handlers } : {}),
    vars: parsedBindings(record.vars),
    sensitiveVars: parsedBindings(record.sensitiveVars),
    ...(hasPlane
      ? { dataPlane: parsedDataPlane(format === FORMAT_V2 ? legacyPlane : record.dataPlane) }
      : {}),
  });
  if (
    canonicalRecord(
      format,
      record.salt,
      set,
      planeToken as string | undefined,
      eventToken as string | undefined,
    ) !== decodeUtf8(bytes)
  ) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return {
    ...set,
    digest: digestOf(
      format,
      record.salt,
      set,
      planeToken as string | undefined,
      eventToken as string | undefined,
    ),
    ...(typeof planeToken === "string" ? { planeToken } : {}),
    ...(typeof eventToken === "string" ? { eventToken } : {}),
  };
}

/** A `@v3` record with or without its optional data plane and plane token. */
function isVersion3Keys(keys: string): boolean {
  return (
    keys === "eventToken,format,handlers,salt,sensitiveVars,vars" ||
    keys === "dataPlane,eventToken,format,handlers,planeToken,salt,sensitiveVars,vars"
  );
}

function parsedHandlers(value: unknown): readonly SelfhostWorkerHandlerName[] {
  if (!Array.isArray(value)) throw new SelfhostVersionBindingStoreError("corrupt");
  for (const entry of value) {
    if (typeof entry !== "string") throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return value as readonly SelfhostWorkerHandlerName[];
}

/** Normalizes a set that may predate handlers, without inventing any. */
function normalizeSetOrLegacy(set: LegacySet): LegacySet {
  const normalized = normalizeSet({
    handlers: set.handlers ?? ["fetch"],
    vars: set.vars,
    sensitiveVars: set.sensitiveVars,
    ...(set.dataPlane ? { dataPlane: set.dataPlane } : {}),
  });
  return {
    ...(set.handlers ? { handlers: normalized.handlers } : {}),
    vars: normalized.vars,
    sensitiveVars: normalized.sensitiveVars,
    ...(normalized.dataPlane ? { dataPlane: normalized.dataPlane } : {}),
  };
}

/** The `@v2` data plane, whose handlers travelled inside it. */
function parsedLegacyDataPlane(value: unknown): {
  readonly handlers: readonly SelfhostWorkerHandlerName[];
  readonly bindings: readonly SelfhostVersionDataBinding[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  const plane = value as Record<string, unknown>;
  if (Object.keys(plane).sort().join(",") !== "bindings,handlers") {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  return {
    handlers: parsedHandlers(plane.handlers),
    bindings: parsedDataPlane({ bindings: plane.bindings }).bindings,
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
  if (Object.keys(plane).sort().join(",") !== "bindings") {
    throw new SelfhostVersionBindingStoreError("corrupt");
  }
  if (!Array.isArray(plane.bindings)) throw new SelfhostVersionBindingStoreError("corrupt");
  for (const entry of plane.bindings) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SelfhostVersionBindingStoreError("corrupt");
    }
    const keys = Object.keys(entry as Record<string, unknown>)
      .sort()
      .join(",");
    if (keys !== "kind,name,target" && keys !== "kind,name,queue,target") {
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
