import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";
import { canonicalApplicationShape } from "./application-schema-shape.ts";
import type { D1MigrationImportArtifact } from "./d1-migration-import.ts";
import { preflightError } from "./errors.ts";
import { canonicalSchemaShape, type MigrationFile } from "./migrations.ts";
import {
  buildFreshPreservedRealmClaim,
  type FreshMoneyWriterEpochBinding,
  type FreshMoneyWriterEpochRecord,
  freshMoneyWriterEpochSql,
} from "./money-fresh-writer-epoch.ts";
import {
  moneyPost100ExpectedPreservedShape,
  moneyPost100PreservedFreshImportSegments,
} from "./schema-money-unit-cutover.ts";

/**
 * Public storage composition of the staging-only `v2-0100-money-preserved`
 * fresh lineage. The sealed import is, in order:
 *
 * 1. the Money-preserved 0001–0100 replay owned by Money source
 *    (`moneyPost100PreservedFreshImportSegments`),
 * 2. Financial's test realm claim over that replay's own inventory,
 * 3. Financial's single Writer epoch row for exactly the new D1.
 *
 * Parts 1 and 2 are fixed before any provider call. Part 3 exists only once
 * the new D1's identity has been read back, so the import is written after it.
 */
export const FRESH_MONEY_PRESERVED_LINEAGE = "v2-0100-money-preserved" as const;

export const FRESH_MONEY_WRITER_EPOCH_OWNER_UNAVAILABLE =
  "the fresh Money writer epoch owner is unavailable";

/** The operator-private Writer epoch record beside the generation's output root. */
export const FRESH_MONEY_WRITER_EPOCH_RECORD_FILE = "money-fresh-writer-epoch.json";
const RECORD_LIMIT = 4096;

/**
 * The operator-chosen directory that holds the Writer epoch record across
 * apply and status (`--epoch-record-directory`). It must be one canonical
 * absolute path (no trailing slash, `.` or `..`) with no symbolic link in any
 * component, naming a directory owned by this user with no group or other
 * access. `create` makes a missing directory 0700 under a canonical existing
 * parent; `read` answers false for a missing one; `recheck` (just before the
 * record is written) requires it to still be exactly that directory.
 */
export function assertFreshMoneyEpochRecordDirectory(
  directory: string,
  mode: "create" | "read" | "recheck",
): boolean {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    /[\0\r\n]/u.test(directory) ||
    resolve(directory) !== directory
  )
    throw preflightError(
      "fresh Money Writer epoch record directory must be one canonical absolute path",
    );
  const unlinked = (path: string): boolean => {
    try {
      return realpathSync(path) === path;
    } catch {
      return false;
    }
  };
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw preflightError("fresh Money Writer epoch record directory is unreadable");
    if (mode === "read") return false;
    if (mode === "recheck")
      throw preflightError(
        "fresh Money Writer epoch record directory disappeared before the write",
      );
    if (!unlinked(dirname(directory)))
      throw preflightError(
        "fresh Money Writer epoch record directory parent must be a canonical path with no symbolic link",
      );
    try {
      mkdirSync(directory, { mode: 0o700 });
      status = lstatSync(directory);
    } catch {
      throw preflightError("fresh Money Writer epoch record directory could not be created");
    }
  }
  if (!unlinked(directory))
    throw preflightError(
      "fresh Money Writer epoch record directory must be a canonical path with no symbolic link",
    );
  if (
    !status.isDirectory() ||
    (status.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  )
    throw preflightError(
      "fresh Money Writer epoch record directory must be an operator-owned 0700 directory",
    );
  return true;
}

/**
 * Whether anything (a file, a directory or any link, even a dangling one)
 * already occupies the record name in `directory`. Links are not followed.
 */
export function freshMoneyWriterEpochRecordPresent(directory: string): boolean {
  try {
    lstatSync(join(directory, FRESH_MONEY_WRITER_EPOCH_RECORD_FILE));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw preflightError("fresh Money Writer epoch record name is unreadable");
  }
}

/**
 * Reads a retained Writer epoch record from `root`, or null when no file
 * exists there. It is accepted only as a link-free regular file of mode 0600,
 * at most 4 KiB, holding one plain JSON object; anything else at that name
 * (a link, a looser mode, an oversize file, JSON `null`, an array) is
 * refused rather than treated as absent. The object is returned as untrusted
 * data for `verifyFreshMoneyWriterEpoch`.
 */
export function readRetainedFreshMoneyWriterEpochRecord(root: string): object | null {
  const path = join(root, FRESH_MONEY_WRITER_EPOCH_RECORD_FILE);
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw preflightError("retained fresh Money Writer epoch record is unreadable");
  }
  if (!status.isFile() || (status.mode & 0o777) !== 0o600 || status.size > RECORD_LIMIT)
    throw preflightError(
      "retained fresh Money Writer epoch record is not an operator-private regular file",
    );
  let fd: number | null = null;
  let parsed: unknown;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.ino !== status.ino ||
      opened.dev !== status.dev ||
      opened.size > RECORD_LIMIT
    )
      throw new Error("record changed");
    parsed = JSON.parse(readFileSync(fd, "utf8")) as unknown;
  } catch {
    throw preflightError("retained fresh Money Writer epoch record is unreadable");
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  )
    throw preflightError("retained fresh Money Writer epoch record is not one plain object");
  return parsed;
}

/** Financial's mint, injectable for tests. The default is the real owner function. */
export type FreshMoneyWriterEpochPort = (
  binding: FreshMoneyWriterEpochBinding,
) => FreshMoneyWriterEpochRecord | Promise<FreshMoneyWriterEpochRecord>;

export interface FreshMoneyPreservedPreEpochImport {
  /** The replay, one newline, then the realm claim. */
  readonly sql: string;
  readonly historyTables: readonly string[];
  /** Exact `moneyPost100ExpectedPreservedShape` the replay produces. */
  readonly shape: string;
  readonly shapeDigest: `sha256:${string}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * The one place the preserved import takes its realm claim. Financial owns
 * the builder; the plain v2-0100 claim is a different function and is not used.
 */
export function freshMoneyPreservedRealmClaim(sqlBeforeClaim: string): {
  readonly sql: string;
  readonly historyTables: readonly string[];
} {
  return buildFreshPreservedRealmClaim(sqlBeforeClaim);
}

/**
 * The replay plus the claim. The replay is executed in memory first and must
 * leave exactly the Money-owned preserved 0100 shape, so a drifted composition
 * is refused before any storage exists.
 */
export function buildFreshMoneyPreservedPreEpochImport(
  files: readonly MigrationFile[],
): FreshMoneyPreservedPreEpochImport {
  const replay = moneyPost100PreservedFreshImportSegments(files).join("\n");
  const shape = moneyPost100ExpectedPreservedShape(files);
  const database = new Database(":memory:");
  let actual: string;
  try {
    for (const statement of frameHostMigrationSql(replay)) database.exec(statement);
    const raw = canonicalSchemaShape(
      database
        .query(
          "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
        )
        .all() as Record<string, unknown>[],
    );
    actual = canonicalApplicationShape({ applied: [], shape: raw, shapeDigest: sha256(raw) });
  } catch {
    throw preflightError("fresh Money-preserved replay could not be executed");
  } finally {
    database.close();
  }
  if (actual !== shape)
    throw preflightError("fresh Money-preserved replay differs from the exact preserved shape");
  const claim = freshMoneyPreservedRealmClaim(replay);
  return Object.freeze({
    sql: `${replay}\n${claim.sql}`,
    historyTables: claim.historyTables,
    shape,
    shapeDigest: sha256(shape),
  });
}

/** The sealed import: replay, claim, then the epoch row for this exact D1. */
export function composeFreshMoneyPreservedImport(
  preEpoch: FreshMoneyPreservedPreEpochImport,
  record: FreshMoneyWriterEpochRecord,
): D1MigrationImportArtifact {
  const sql = `${preEpoch.sql}\n${freshMoneyWriterEpochSql(record)}`;
  const bytes = Buffer.from(sql, "utf8");
  return {
    sql,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}
