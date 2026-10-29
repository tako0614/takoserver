import type { Clock, Row, Sql } from "./ports.ts";
import { SqlError } from "./ports.ts";
import { legacyOriginForName } from "./shared-app-staging-adoption.ts";

/** Additive destination schema only. Never applies a migration or selects a physical source. */
export const SHARED_APP_STAGING_ORIGIN_HISTORY_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE shared_app_staging_origin_history (
    name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 63
      AND name NOT GLOB '*[^a-z0-9-]*' AND substr(name,1,1)<>'-' AND substr(name,-1)<>'-'),
    predecessor TEXT NOT NULL, original_key TEXT NOT NULL, owner_ref TEXT,
    original_state TEXT NOT NULL, original_json TEXT NOT NULL CHECK(CASE WHEN json_valid(original_json)=1
      THEN json_type(original_json) IS 'object' AND json_extract(original_json,'$.state') IS original_state
      ELSE 0 END),
    retained_at INTEGER NOT NULL CHECK(retained_at>=0), UNIQUE(predecessor,original_key)
  )`,
  `CREATE TRIGGER shared_app_staging_origin_history_conflict BEFORE INSERT ON shared_app_staging_origin_history
    WHEN EXISTS (SELECT 1 FROM shared_app_staging_names WHERE normalized_name=NEW.name)
      OR EXISTS (SELECT 1 FROM shared_app_staging_assignments WHERE name=NEW.name)
      OR EXISTS (SELECT 1 FROM worker_endpoint_origin_reservations l
        WHERE l.requested_subdomain=NEW.name OR ${legacyOriginForName("l.canonical_public_origin", "NEW.name")})
    BEGIN SELECT RAISE(ABORT,'destination staging origin already retained'); END`,
  `CREATE TRIGGER shared_app_staging_origin_history_no_update BEFORE UPDATE ON shared_app_staging_origin_history
    BEGIN SELECT RAISE(ABORT,'predecessor staging origin retained'); END`,
  `CREATE TRIGGER shared_app_staging_origin_history_no_delete BEFORE DELETE ON shared_app_staging_origin_history
    BEGIN SELECT RAISE(ABORT,'predecessor staging origin retained'); END`,
  ...[
    { table: "shared_app_staging_assignments", column: "name" },
    { table: "shared_app_staging_names", column: "normalized_name" },
  ].flatMap(({ table, column }) =>
    ["INSERT", `UPDATE OF ${column}`].map(
      (
        operation,
      ) => `CREATE TRIGGER ${table}_predecessor_${operation === "INSERT" ? "insert" : "update"}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (SELECT 1 FROM shared_app_staging_origin_history WHERE name=NEW.${column})
        BEGIN SELECT RAISE(ABORT,'predecessor staging origin retained'); END`,
    ),
  ),
  ...["INSERT", "UPDATE"].map(
    (
      operation,
    ) => `CREATE TRIGGER shared_app_staging_origin_history_legacy_${operation.toLowerCase()}
      BEFORE ${operation} ON worker_endpoint_origin_reservations
      WHEN EXISTS (SELECT 1 FROM shared_app_staging_origin_history h
        WHERE h.name=NEW.requested_subdomain OR ${legacyOriginForName("NEW.canonical_public_origin", "h.name")})
      BEGIN SELECT RAISE(ABORT,'predecessor staging origin retained'); END`,
  ),
]);

/** Opaque ownership metadata from the trusted operator's retained original. */
export interface SharedAppStagingOriginHistoryRecord {
  readonly name: string;
  readonly predecessor: string;
  readonly originalKey: string;
  readonly ownerRef: string | null;
  readonly originalState: string;
  /** Exact original metadata bytes; never request headers, credentials or response bodies. */
  readonly originalJson: string;
}

export class SharedAppStagingOriginHistoryError extends Error {
  constructor(readonly code: "conflict" | "unavailable" | "indeterminate") {
    super(code);
    this.name = "SharedAppStagingOriginHistoryError";
  }
}

function record(input: SharedAppStagingOriginHistoryRecord): SharedAppStagingOriginHistoryRecord {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !==
      "name,originalJson,originalKey,originalState,ownerRef,predecessor"
  )
    throw new TypeError("retained staging origin is invalid");
  const value = {
    name: input.name,
    predecessor: input.predecessor,
    originalKey: input.originalKey,
    ownerRef: input.ownerRef,
    originalState: input.originalState,
    originalJson: input.originalJson,
  };
  const opaque = (text: unknown): text is string =>
    typeof text === "string" && text.length > 0 && text.length <= 2048 && !text.includes("\0");
  if (
    typeof value.name !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value.name) ||
    !opaque(value.predecessor) ||
    !opaque(value.originalKey) ||
    (value.ownerRef !== null && !opaque(value.ownerRef)) ||
    !opaque(value.originalState) ||
    typeof value.originalJson !== "string" ||
    new TextEncoder().encode(value.originalJson).length > 65_536
  )
    throw new TypeError("retained staging origin is invalid");
  let original: unknown;
  try {
    original = JSON.parse(value.originalJson);
  } catch {
    throw new TypeError("retained staging origin is invalid");
  }
  if (
    !original ||
    typeof original !== "object" ||
    Array.isArray(original) ||
    (original as { state?: unknown }).state !== value.originalState
  )
    throw new TypeError("retained staging origin is invalid");
  return Object.freeze(value);
}

function same(row: Row, value: SharedAppStagingOriginHistoryRecord): boolean {
  return (
    row.name === value.name &&
    row.predecessor === value.predecessor &&
    row.original_key === value.originalKey &&
    row.owner_ref === value.ownerRef &&
    row.original_state === value.originalState &&
    row.original_json === value.originalJson
  );
}

/**
 * Trusted SQL composition only. Retention can only deny new name allocation;
 * it grants no reservation, incarnation, route, custody, drain or census proof.
 * Active originals remain active history. There is deliberately no update/delete.
 * This part alone is not an active-route migration or a physical cutover proof.
 */
export function createSharedAppStagingOriginHistory(options: {
  readonly sql: Sql;
  readonly clock?: Clock;
}) {
  const sql = options.sql;
  const clock = options.clock ?? (() => new Date());
  return Object.freeze({
    async retain(input: SharedAppStagingOriginHistoryRecord): Promise<void> {
      const value = record(input);
      const retainedAt = clock().getTime();
      if (!Number.isSafeInteger(retainedAt) || retainedAt < 0)
        throw new SharedAppStagingOriginHistoryError("unavailable");
      const read = () =>
        sql.query("SELECT * FROM shared_app_staging_origin_history WHERE name=?", [value.name]);
      let existing: readonly Row[];
      try {
        existing = await read();
      } catch {
        throw new SharedAppStagingOriginHistoryError("unavailable");
      }
      if (existing.length) {
        const row = existing[0];
        if (existing.length !== 1 || !row || !same(row, value))
          throw new SharedAppStagingOriginHistoryError("conflict");
        return;
      }
      try {
        await sql.run(
          `INSERT INTO shared_app_staging_origin_history
            (name,predecessor,original_key,owner_ref,original_state,original_json,retained_at)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(name) DO NOTHING`,
          [
            value.name,
            value.predecessor,
            value.originalKey,
            value.ownerRef,
            value.originalState,
            value.originalJson,
            retainedAt,
          ],
        );
      } catch (error) {
        throw new SharedAppStagingOriginHistoryError(
          error instanceof SqlError && error.code === "constraint" ? "conflict" : "indeterminate",
        );
      }
      let stored: readonly Row[];
      try {
        stored = await read();
      } catch {
        throw new SharedAppStagingOriginHistoryError("indeterminate");
      }
      const row = stored[0];
      if (stored.length !== 1 || !row || !same(row, value))
        throw new SharedAppStagingOriginHistoryError("conflict");
    },
  });
}
