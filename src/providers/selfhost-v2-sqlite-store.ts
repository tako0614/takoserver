import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock, Sql } from "../ports.ts";

export const SQLITE_MIGRATION_LEDGER = Object.freeze({
  schema: "main",
  table: "_takoform_sqlite_migrations",
} as const);

const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPERATION_ID = RESOURCE_UID;
const OWNER_VERSION = 1;
const OWNER_FILE = "owner.json";
const DATABASE_FILE = "database.sqlite";
const LEDGER_SCHEMA = `CREATE TABLE _takoform_sqlite_migrations (
  sequence INTEGER PRIMARY KEY CHECK (sequence BETWEEN 1 AND 512),
  path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  operation_id TEXT NOT NULL
)`;
const LEDGER_SQL = LEDGER_SCHEMA.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ");

type Presence = "present" | "absent" | "unknown";

/** Neutral structural input: this adapter never imports the v2 Form layer. */
interface SQLiteNativeExecution {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly backendKey: string;
  readonly backendId: string;
  readonly targetKey: string;
  readonly resourceUid: string;
  readonly principal: string;
  readonly action: "create" | "update" | "delete";
  readonly generation: number;
  readonly form: string;
  readonly space: string;
  readonly name: string;
}

interface OwnerReceipt {
  readonly version: 1;
  readonly resourceUid: string;
  readonly targetKey: string;
  readonly createOperationId: string;
}

export class SelfhostV2SQLiteStoreError extends Error {
  constructor(readonly code: "busy" | "backend_unavailable" | "ownership_uncertain") {
    super(code);
    this.name = "SelfhostV2SQLiteStoreError";
  }
}

/**
 * A Resource UID owns one local SQLite file. Sidecar receipts prove ownership;
 * the v2 SQL Resource/Operation tables remain the only management authority.
 * `withAuthorizedDatabase` is Host-internal and must never be exposed to a
 * Worker: the Worker receives only the SQL plane's three safe methods.
 */
export function createSelfhostV2SQLiteStore(options: {
  readonly root: string;
  readonly sql: Sql;
  readonly targetKey: string;
  readonly now?: Clock;
}) {
  if (!options.root || !isAbsolute(options.root)) {
    throw new TypeError("an absolute SQLite custody root is required");
  }
  if (!options.targetKey || Buffer.byteLength(options.targetKey, "utf8") > 256) {
    throw new TypeError("targetKey must be 1 to 256 UTF-8 bytes");
  }
  const root = resolve(options.root);
  const resources = join(root, "resources");
  const staging = join(root, "staging");
  const deleted = join(root, "deleted");
  const locks = join(root, "locks");
  for (const directory of [root, resources, staging, deleted, locks]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
      throw new TypeError("SQLite custody directories must be private real directories");
    }
  }
  const now = options.now ?? (() => new Date());

  const resourceDir = (uid: string) => join(resources, checkedId(uid));
  const stageDir = (operationId: string) => join(staging, checkedId(operationId));
  const deletedDir = (uid: string, operationId: string) =>
    join(deleted, checkedId(uid), checkedId(operationId));

  async function withLock<T>(uid: string, work: () => Promise<T>): Promise<T> {
    const shard = createHash("sha256").update(uid).digest("hex").slice(0, 2);
    const mutex = new DatabaseSync(join(locks, `${shard}.sqlite`));
    let locked = false;
    try {
      mutex.exec("PRAGMA busy_timeout = 1000");
      mutex.exec("BEGIN EXCLUSIVE");
      locked = true;
      return await work();
    } catch (error) {
      if (error instanceof SelfhostV2SQLiteStoreError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (/locked|busy/iu.test(message)) throw new SelfhostV2SQLiteStoreError("busy");
      throw error;
    } finally {
      if (locked) {
        try {
          mutex.exec("ROLLBACK");
        } catch {
          // A failed release can only make the outcome uncertain to the caller.
        }
      }
      mutex.close();
    }
  }

  async function ownsClaim(input: SQLiteNativeExecution): Promise<boolean> {
    const nowMs = now().getTime();
    if (!Number.isSafeInteger(nowMs)) return false;
    const row = (
      await options.sql.query(
        `SELECT op.id FROM tf_v2_operations op
         JOIN tf_v2_resources r ON r.uid = op.resource_uid
         WHERE op.id = ? AND op.lease_token = ? AND op.lease_until_ms > ?
           AND op.status = 'reconciling' AND op.dispatch_possible = 1
           AND op.resource_uid = ? AND op.principal = ? AND op.action = ?
           AND op.generation = ? AND op.backend_key = ? AND op.backend_id = ?
           AND op.target_key = ? AND r.busy_operation = op.id
           AND r.last_operation = op.id AND r.generation = op.generation
           AND r.principal = op.principal AND r.form_url = ?
           AND r.space = ? AND r.name = ? AND r.backend_id = op.backend_id
           AND r.target_key = op.target_key AND r.deleted_at IS NULL`,
        [
          input.operationId,
          input.leaseToken,
          nowMs,
          input.resourceUid,
          input.principal,
          input.action,
          input.generation,
          input.backendKey,
          input.backendId,
          input.targetKey,
          input.form,
          input.space,
          input.name,
        ],
      )
    )[0];
    return row?.id === input.operationId;
  }

  function expectedOwner(input: SQLiteNativeExecution): OwnerReceipt {
    if (input.targetKey !== options.targetKey || !RESOURCE_UID.test(input.resourceUid)) {
      throw new SelfhostV2SQLiteStoreError("ownership_uncertain");
    }
    checkedId(input.operationId);
    return {
      version: OWNER_VERSION,
      resourceUid: input.resourceUid,
      targetKey: options.targetKey,
      createOperationId: input.operationId,
    };
  }

  function ownerAt(directory: string): OwnerReceipt | null {
    const path = join(directory, OWNER_FILE);
    if (!regular(path)) return null;
    try {
      const bytes = readFileSync(path);
      if (bytes.byteLength > 1024) return null;
      const candidate = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (
        candidate.version !== OWNER_VERSION ||
        typeof candidate.resourceUid !== "string" ||
        !RESOURCE_UID.test(candidate.resourceUid) ||
        typeof candidate.targetKey !== "string" ||
        typeof candidate.createOperationId !== "string" ||
        !OPERATION_ID.test(candidate.createOperationId) ||
        Object.keys(candidate).length !== 4
      ) {
        return null;
      }
      const normalized: OwnerReceipt = {
        version: OWNER_VERSION,
        resourceUid: candidate.resourceUid,
        targetKey: candidate.targetKey,
        createOperationId: candidate.createOperationId,
      };
      return bytes.toString("utf8") === JSON.stringify(normalized) ? normalized : null;
    } catch {
      return null;
    }
  }

  function matchesOwner(owner: OwnerReceipt | null, uid: string): owner is OwnerReceipt {
    return owner?.resourceUid === uid && owner.targetKey === options.targetKey;
  }

  async function matchesAcceptedCreate(uid: string, owner: OwnerReceipt | null): Promise<boolean> {
    if (!matchesOwner(owner, uid)) return false;
    const rows = await options.sql.query(
      `SELECT created.id FROM tf_v2_resources r
       JOIN tf_v2_operations created ON created.resource_uid = r.uid
       WHERE r.uid = ? AND r.target_key = ? AND r.deleted_at IS NULL
         AND created.action = 'create' AND created.generation = 1
         AND created.principal = r.principal AND created.backend_id = r.backend_id
         AND created.target_key = r.target_key LIMIT 2`,
      [uid, options.targetKey],
    );
    return rows.length === 1 && rows[0]?.id === owner.createOperationId;
  }

  function completeDirectory(directory: string, uid: string): boolean {
    if (!privateDirectory(directory) || !matchesOwner(ownerAt(directory), uid)) return false;
    if (!regular(join(directory, DATABASE_FILE))) return false;
    if (
      readdirSync(directory).some(
        (name) =>
          ![
            OWNER_FILE,
            DATABASE_FILE,
            `${DATABASE_FILE}-journal`,
            `${DATABASE_FILE}-wal`,
            `${DATABASE_FILE}-shm`,
          ].includes(name),
      )
    ) {
      return false;
    }
    try {
      // A hot rollback journal needs a writable open to establish whether
      // the exact owned file can be recovered after a process crash.
      const database = new DatabaseSync(join(directory, DATABASE_FILE));
      try {
        const schema = database
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(SQLITE_MIGRATION_LEDGER.table) as { sql?: unknown } | undefined;
        return typeof schema?.sql === "string" && schema.sql === LEDGER_SCHEMA;
      } finally {
        database.close();
      }
    } catch {
      return false;
    }
  }

  function presence(uid: string): Presence {
    const directory = resourceDir(uid);
    if (!entryExists(directory)) return "absent";
    if (!directoryExists(directory)) return "unknown";
    return completeDirectory(directory, uid) ? "present" : "unknown";
  }

  function createStage(input: SQLiteNativeExecution): void {
    const directory = stageDir(input.operationId);
    const receipt = expectedOwner(input);
    if (!directoryExists(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      syncDir(staging);
    }
    if (!privateDirectory(directory)) {
      throw new SelfhostV2SQLiteStoreError("ownership_uncertain");
    }
    const existing = ownerAt(directory);
    if (existing && JSON.stringify(existing) !== JSON.stringify(receipt)) {
      throw new SelfhostV2SQLiteStoreError("ownership_uncertain");
    }
    if (!existing) {
      const path = join(directory, OWNER_FILE);
      if (existsSync(path)) throw new SelfhostV2SQLiteStoreError("ownership_uncertain");
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(receipt));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDir(directory);
    }
    const path = join(directory, DATABASE_FILE);
    if (existsSync(path) && !regular(path)) {
      throw new SelfhostV2SQLiteStoreError("ownership_uncertain");
    }
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(LEDGER_SQL);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
    chmodSync(path, 0o600);
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDir(directory);
    if (!completeDirectory(directory, input.resourceUid)) {
      throw new SelfhostV2SQLiteStoreError("ownership_uncertain");
    }
  }

  function publishStage(input: SQLiteNativeExecution): Presence {
    const source = stageDir(input.operationId);
    const destination = resourceDir(input.resourceUid);
    if (
      !completeDirectory(source, input.resourceUid) ||
      ownerAt(source)?.createOperationId !== input.operationId
    ) {
      return "unknown";
    }
    if (!directoryExists(destination)) {
      mkdirSync(destination, { mode: 0o700 });
      syncDir(resources);
    }
    if (!privateDirectory(destination)) return "unknown";
    if (readdirSync(destination).some((name) => name !== OWNER_FILE && name !== DATABASE_FILE)) {
      return "unknown";
    }
    const existing = ownerAt(destination);
    if (existing && JSON.stringify(existing) !== JSON.stringify(ownerAt(source))) return "unknown";
    for (const name of [OWNER_FILE, DATABASE_FILE]) {
      const candidate = join(destination, name);
      if (
        entryExists(candidate) &&
        (!regular(candidate) || !sameFile(join(source, name), candidate))
      ) {
        return "unknown";
      }
    }
    for (const name of [OWNER_FILE, DATABASE_FILE]) {
      const dest = join(destination, name);
      if (!existsSync(dest)) {
        linkSync(join(source, name), dest);
        syncDir(destination);
      } else if (!regular(dest)) {
        return "unknown";
      }
    }
    if (!completeDirectory(destination, input.resourceUid)) return "unknown";
    cleanupStage(input);
    return "present";
  }

  function cleanupStage(input: SQLiteNativeExecution): void {
    const source = stageDir(input.operationId);
    if (!privateDirectory(source)) return;
    const final = resourceDir(input.resourceUid);
    if (!completeDirectory(final, input.resourceUid)) return;
    const entries = readdirSync(source);
    if (entries.length === 0) {
      rmdirSync(source);
      syncDir(staging);
      return;
    }
    if (
      entries.length === 1 &&
      entries[0] === OWNER_FILE &&
      sameFile(join(source, OWNER_FILE), join(final, OWNER_FILE))
    ) {
      unlinkSync(join(source, OWNER_FILE));
      rmdirSync(source);
      syncDir(staging);
      return;
    }
    if (
      !completeDirectory(source, input.resourceUid) ||
      !sameFile(join(source, OWNER_FILE), join(final, OWNER_FILE)) ||
      !sameFile(join(source, DATABASE_FILE), join(final, DATABASE_FILE))
    ) {
      return;
    }
    for (const name of [DATABASE_FILE, OWNER_FILE]) {
      const path = join(source, name);
      if (existsSync(path)) unlinkSync(path);
    }
    if (readdirSync(source).length === 0) rmdirSync(source);
    syncDir(staging);
  }

  async function ensureCreated(input: SQLiteNativeExecution): Promise<Presence> {
    if (input.action !== "create") throw new TypeError("create Operation required");
    expectedOwner(input);
    return withLock(input.resourceUid, async () => {
      if (!(await ownsClaim(input))) return "unknown";
      const current = presence(input.resourceUid);
      if (current === "present") {
        const owner = ownerAt(resourceDir(input.resourceUid));
        if (owner?.createOperationId !== input.operationId) return "unknown";
        const stage = stageDir(input.operationId);
        if (
          completeDirectory(stage, input.resourceUid) &&
          (!sameFile(join(stage, OWNER_FILE), join(resourceDir(input.resourceUid), OWNER_FILE)) ||
            !sameFile(
              join(stage, DATABASE_FILE),
              join(resourceDir(input.resourceUid), DATABASE_FILE),
            ))
        ) {
          return "unknown";
        }
        cleanupStage(input);
        return "present";
      }
      if (current === "unknown") {
        // Only the exact stage hard links can complete a crash-interrupted
        // publication. A foreign file or extra directory entry stays unknown.
        if (!(await ownsClaim(input))) return "unknown";
        return publishStage(input);
      }
      createStage(input);
      if (!(await ownsClaim(input))) return "unknown";
      return publishStage(input);
    });
  }

  async function inspect(input: SQLiteNativeExecution): Promise<Presence> {
    expectedOwner(input);
    return withLock(input.resourceUid, async () => {
      if (!(await ownsClaim(input))) return "unknown";
      const state = presence(input.resourceUid);
      if (
        state === "present" &&
        !(await matchesAcceptedCreate(input.resourceUid, ownerAt(resourceDir(input.resourceUid))))
      ) {
        return "unknown";
      }
      if (state !== "absent") return state;
      if (input.action === "create" && directoryExists(stageDir(input.operationId)))
        return "unknown";
      return "absent";
    });
  }

  async function ensureDeleted(input: SQLiteNativeExecution): Promise<Presence> {
    if (input.action !== "delete") throw new TypeError("delete Operation required");
    expectedOwner(input);
    return withLock(input.resourceUid, async () => {
      if (!(await ownsClaim(input))) return "unknown";
      const destination = resourceDir(input.resourceUid);
      const tombstone = deletedDir(input.resourceUid, input.operationId);
      const parent = join(deleted, checkedId(input.resourceUid));
      if (entryExists(parent) && !privateDirectory(parent)) return "unknown";
      const current = presence(input.resourceUid);
      const heldComplete = completeDirectory(tombstone, input.resourceUid);
      if (
        (current === "present" &&
          !(await matchesAcceptedCreate(input.resourceUid, ownerAt(destination)))) ||
        (heldComplete && !(await matchesAcceptedCreate(input.resourceUid, ownerAt(tombstone))))
      ) {
        return "unknown";
      }
      if (current === "absent" && !entryExists(tombstone)) return "absent";
      if (entryExists(tombstone) && !directoryExists(tombstone)) return "unknown";
      if (directoryExists(tombstone) && !privateDirectory(tombstone)) return "unknown";
      if (current === "absent" && privateDirectory(tombstone) && !heldComplete) {
        const entries = readdirSync(tombstone);
        if (
          entries.length === 0 ||
          (entries.length === 1 &&
            entries[0] === OWNER_FILE &&
            (await matchesAcceptedCreate(input.resourceUid, ownerAt(tombstone))))
        ) {
          if (entries.length === 1) unlinkSync(join(tombstone, OWNER_FILE));
          rmdirSync(tombstone);
          if (readdirSync(parent).length === 0) rmdirSync(parent);
          syncDir(deleted);
          return "absent";
        }
        return "unknown";
      }
      if (current === "unknown" && !heldComplete) return "unknown";
      if (!directoryExists(tombstone)) {
        if (!directoryExists(parent)) {
          mkdirSync(parent, { mode: 0o700 });
          syncDir(deleted);
        }
        if (!privateDirectory(parent)) return "unknown";
        mkdirSync(tombstone, { mode: 0o700 });
        syncDir(parent);
      }
      if (current === "present") {
        const expected = ownerAt(destination);
        const held = ownerAt(tombstone);
        if (!matchesOwner(expected, input.resourceUid)) return "unknown";
        if (held && JSON.stringify(held) !== JSON.stringify(expected)) return "unknown";
        if (
          heldComplete &&
          !sameFile(join(destination, DATABASE_FILE), join(tombstone, DATABASE_FILE))
        ) {
          return "unknown";
        }
        for (const name of [OWNER_FILE, DATABASE_FILE]) {
          const dest = join(tombstone, name);
          if (!existsSync(dest)) linkSync(join(destination, name), dest);
          else if (!regular(dest)) return "unknown";
        }
        syncDir(tombstone);
      }
      if (!completeDirectory(tombstone, input.resourceUid)) return "unknown";
      if (directoryExists(destination)) {
        const owner = ownerAt(destination);
        if (owner !== null && !matchesOwner(owner, input.resourceUid)) return "unknown";
        const liveDatabase = join(destination, DATABASE_FILE);
        if (entryExists(liveDatabase)) {
          if (!regular(liveDatabase) || !sameFile(liveDatabase, join(tombstone, DATABASE_FILE))) {
            return "unknown";
          }
        }
        if (owner === null && readdirSync(destination).some((name) => name === OWNER_FILE))
          return "unknown";
        for (const name of [DATABASE_FILE, OWNER_FILE]) {
          const path = join(destination, name);
          if (entryExists(path)) unlinkSync(path);
        }
        for (const suffix of ["-journal", "-wal", "-shm"]) {
          const path = join(destination, `${DATABASE_FILE}${suffix}`);
          if (existsSync(path) && regular(path)) unlinkSync(path);
        }
        if (readdirSync(destination).length !== 0) return "unknown";
        rmdirSync(destination);
        syncDir(resources);
      }
      for (const name of [DATABASE_FILE, OWNER_FILE]) {
        const path = join(tombstone, name);
        if (existsSync(path)) unlinkSync(path);
      }
      if (readdirSync(tombstone).length !== 0) return "unknown";
      rmdirSync(tombstone);
      if (readdirSync(parent).length === 0) rmdirSync(parent);
      syncDir(deleted);
      return "absent";
    });
  }

  async function withAuthorizedDatabase<T>(input: {
    readonly resourceUid: string;
    readonly stillAuthorized: () => Promise<boolean>;
    readonly use: (database: DatabaseSync) => Promise<T> | T;
  }): Promise<T> {
    const uid = checkedId(input.resourceUid);
    if (!(await input.stillAuthorized()))
      throw new SelfhostV2SQLiteStoreError("backend_unavailable");
    return withLock(uid, async () => {
      if (
        !(await input.stillAuthorized()) ||
        presence(uid) !== "present" ||
        !(await matchesAcceptedCreate(uid, ownerAt(resourceDir(uid))))
      ) {
        throw new SelfhostV2SQLiteStoreError("backend_unavailable");
      }
      const database = new DatabaseSync(join(resourceDir(uid), DATABASE_FILE));
      try {
        database.exec("PRAGMA journal_mode = DELETE");
        database.exec("PRAGMA foreign_keys = ON");
        return await input.use(database);
      } finally {
        if (database.isOpen) database.close();
      }
    });
  }

  return {
    targetKey: options.targetKey,
    ensureCreated,
    inspect,
    ensureDeleted,
    withAuthorizedDatabase,
  };
}

export type SelfhostV2SQLiteStore = ReturnType<typeof createSelfhostV2SQLiteStore>;

function checkedId(value: string): string {
  if (typeof value !== "string" || !RESOURCE_UID.test(value)) {
    throw new SelfhostV2SQLiteStoreError("ownership_uncertain");
  }
  return value;
}

function regular(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function privateDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && (metadata.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function sameFile(left: string, right: string): boolean {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function syncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
