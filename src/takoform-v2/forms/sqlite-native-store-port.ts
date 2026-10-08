import type { V2Execution } from "../types.ts";

export type SQLiteDatabasePresence = "present" | "absent" | "unknown";

/** Form-facing shape; the self-host adapter satisfies it without a reverse import. */
export interface SQLiteDatabaseNativePort {
  readonly targetKey: string;
  ensureCreated(input: V2Execution): Promise<SQLiteDatabasePresence>;
  inspect(input: V2Execution): Promise<SQLiteDatabasePresence>;
  ensureDeleted(input: V2Execution): Promise<SQLiteDatabasePresence>;
}
