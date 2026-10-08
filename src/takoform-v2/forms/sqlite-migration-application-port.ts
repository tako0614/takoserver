/** The migration executor's transport-safe values; no SQLite handle crosses this seam. */
import type { V2Execution } from "../types.ts";

export interface SQLiteMigrationEntry {
  readonly path: string;
  readonly sha256: string;
}

export interface SQLiteMigrationRecord extends SQLiteMigrationEntry {
  readonly sequence: number;
  readonly operationId: string;
}

export type SQLiteMigrationLedgerResult =
  | { readonly kind: "read"; readonly entries: readonly SQLiteMigrationRecord[] }
  | { readonly kind: "unknown" };

export type SQLiteMigrationFileResult =
  | {
      /** Exact durable row read after the file transaction committed. */
      readonly kind: "applied";
      readonly sequence: number;
      readonly record: SQLiteMigrationRecord;
    }
  | {
      /** The current file and its ledger row were rolled back. */
      readonly kind: "rejected";
      readonly code: "artifact_invalid" | "migration_sql_error" | "database_busy";
    }
  | { readonly kind: "unknown" };

export interface SQLiteMigrationSession {
  readLedger(): Promise<SQLiteMigrationLedgerResult>;
  applyOneHeldFile(input: {
    readonly sequence: number;
    /** Exact durable prefix read earlier in this session. */
    readonly expectedPrefix: readonly SQLiteMigrationRecord[];
    readonly entry: SQLiteMigrationEntry;
    readonly bytes: Uint8Array;
    readonly operationId: string;
  }): Promise<SQLiteMigrationFileResult>;
}

/**
 * The adapter holds one database UID's exclusion for the entire callback. The
 * callback runs in the orchestrator; only the two session operations may cross
 * a future transport. A read after an unknown apply must wait until that apply
 * has settled under the same exclusion and return only committed durable rows;
 * an in-doubt transaction must make the read unknown. The adapter must recheck
 * authority before opening the database and before each file effect, and may
 * never expose its native handle here.
 */
export interface SQLiteMigrationApplicationPort {
  withAuthorizedMigrationSession<T>(input: {
    readonly resourceUid: string;
    /** Accepted identity for an adapter that must verify authority on its own side. */
    readonly execution: Pick<
      V2Execution,
      | "operationId"
      | "leaseToken"
      | "backendKey"
      | "backendId"
      | "targetKey"
      | "resourceUid"
      | "principal"
      | "action"
      | "generation"
      | "form"
      | "space"
      | "name"
      | "spec"
    >;
    readonly stillAuthorized: () => Promise<boolean>;
    readonly use: (session: SQLiteMigrationSession) => Promise<T>;
  }): Promise<T>;
}
