import { createHash } from "node:crypto";
import { sqlLiteral } from "./d1.ts";
import type { DeployPhase } from "./errors.ts";
import { preflightError } from "./errors.ts";

/** Only the four existing-data tables rebuilt by the immutable 0058 SQL. */
const TABLES = [
  "cloudflare_managed_worker_receipts",
  "cloudflare_managed_worker_version_execution_material",
  "cloudflare_managed_worker_version_execution_secrets",
  "cloudflare_managed_worker_version_execution_provider_proofs",
] as const;
type Table = (typeof TABLES)[number];
const PAGE_SIZE = 8;
const MAX_ROWS_PER_TABLE = 50_000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface Protected0058Snapshot {
  readonly digest: `sha256:${string}`;
  readonly counts: Readonly<Record<Table, number>>;
  readonly bytes: number;
  readonly maxBlobBytes: number;
  readonly foreignKeyViolations: 0;
}

export interface Protected0058Reader {
  query(
    phase: DeployPhase,
    description: string,
    sql: string,
  ): Promise<readonly Record<string, unknown>[]>;
}

function fail(): never {
  // Do not attach an underlying RemoteD1 diagnostic: it can contain raw row
  // values, including a sealed BLOB in a provider error/JSON parse failure.
  throw preflightError("0058 bounded D1 integrity readback failed; no row values are disclosed");
}

async function safeQuery(
  reader: Protected0058Reader,
  phase: DeployPhase,
  label: string,
  sql: string,
): Promise<readonly Record<string, unknown>[]> {
  try {
    return await reader.query(phase, label, sql);
  } catch {
    return fail();
  }
}

function safeNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail();
  return Number(value);
}

function stringKey(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail();
  return value;
}

function byteLength(value: unknown, blobHex: boolean): number {
  if (value === null) return 0;
  if (blobHex) {
    if (typeof value !== "string" || value.length % 2 !== 0 || /[^0-9A-F]/u.test(value)) fail();
    return value.length / 2;
  }
  if (typeof value !== "string" && typeof value !== "number") fail();
  return Buffer.byteLength(String(value), "utf8");
}

/**
 * Keyset pages give a fixed per-query response bound. The digest includes every
 * column and exact sealed nonce/ciphertext bytes; only digests and sizes leave
 * this function. A count before and after the scan fences inconsistent pages.
 */
export async function readProtected0058Snapshot(
  reader: Protected0058Reader,
  phase: DeployPhase,
): Promise<Protected0058Snapshot> {
  const hash = createHash("sha256");
  const counts = {} as Record<Table, number>;
  let bytes = 0;
  let maxBlobBytes = 0;
  for (const table of TABLES) {
    const countRows = await safeQuery(
      reader,
      phase,
      "0058 bounded row count",
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    if (countRows.length !== 1) fail();
    const expected = safeNumber(countRows[0]?.n);
    if (expected > MAX_ROWS_PER_TABLE) fail();
    const sealed = table.endsWith("_secrets") || table.endsWith("_provider_proofs");
    const columns = sealed
      ? "provider_id, resource_uid, name, hex(nonce) AS nonce_hex, hex(ciphertext) AS ciphertext_hex"
      : "*";
    let cursor: readonly string[] | null = null;
    let actual = 0;
    while (actual < expected) {
      const predicate =
        cursor === null
          ? ""
          : sealed
            ? `WHERE (provider_id, resource_uid, name) > (${cursor.map(sqlLiteral).join(", ")})`
            : `WHERE (provider_id, resource_uid) > (${cursor.map(sqlLiteral).join(", ")})`;
      const order = sealed ? "provider_id, resource_uid, name" : "provider_id, resource_uid";
      const rows = await safeQuery(
        reader,
        phase,
        "0058 bounded integrity page",
        `SELECT ${columns} FROM ${table} ${predicate} ORDER BY ${order} LIMIT ${PAGE_SIZE}`,
      );
      if (rows.length === 0 || rows.length > PAGE_SIZE) fail();
      const encoded = Buffer.from(JSON.stringify(rows), "utf8");
      if (encoded.byteLength > MAX_PAGE_BYTES) fail();
      for (const row of rows) {
        const key = sealed
          ? [stringKey(row, "provider_id"), stringKey(row, "resource_uid"), stringKey(row, "name")]
          : [stringKey(row, "provider_id"), stringKey(row, "resource_uid")];
        if (cursor !== null && key.join("\0") <= cursor.join("\0")) fail();
        cursor = key;
        for (const [name, value] of Object.entries(row)) {
          const blobHex = name === "nonce_hex" || name === "ciphertext_hex";
          const length = byteLength(value, blobHex);
          bytes += length;
          if (blobHex) maxBlobBytes = Math.max(maxBlobBytes, length);
        }
        if (bytes > MAX_TOTAL_BYTES) fail();
        hash.update(table).update("\0").update(JSON.stringify(row)).update("\n");
      }
      actual += rows.length;
      if (actual > expected) fail();
    }
    const after = await safeQuery(
      reader,
      phase,
      "0058 bounded row recount",
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    if (after.length !== 1 || safeNumber(after[0]?.n) !== expected) fail();
    counts[table] = actual;
  }
  const integrity = await safeQuery(
    reader,
    phase,
    "0058 foreign-key integrity",
    "SELECT COUNT(*) AS n FROM pragma_foreign_key_check",
  );
  if (integrity.length !== 1 || safeNumber(integrity[0]?.n) !== 0) fail();
  const foreignKeys = await safeQuery(
    reader,
    phase,
    "0058 foreign-key mode",
    "PRAGMA foreign_keys",
  );
  if (foreignKeys.length !== 1 || foreignKeys[0]?.foreign_keys !== 1) fail();
  return {
    digest: `sha256:${hash.digest("hex")}`,
    counts,
    bytes,
    maxBlobBytes,
    foreignKeyViolations: 0,
  };
}

export function assertProtected0058Preserved(
  before: Protected0058Snapshot,
  after: Protected0058Snapshot,
): void {
  if (
    before.digest !== after.digest ||
    before.bytes !== after.bytes ||
    before.maxBlobBytes !== after.maxBlobBytes ||
    TABLES.some((table) => before.counts[table] !== after.counts[table])
  ) {
    throw preflightError("0058 affected-table rows or sealed BLOB bytes changed across migration");
  }
}
