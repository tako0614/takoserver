import type {
  V2QueueBatchExecutionIdentity,
  V2QueueBatchSQLiteCustody,
  V2QueueBatchTerminal,
} from "./queue-v2-batch-custody-contract.ts";
import type { SQLiteLockedPhysicalSet } from "./queue-v2-sqlite-physical-fence.ts";

export type { SQLiteLockedPhysicalSet } from "./queue-v2-sqlite-physical-fence.ts";

export type EdgeSqlValue = null | number | string | Readonly<{ encoding: "base64"; data: string }>;

export type EdgeSqlRow = Readonly<Record<string, EdgeSqlValue>>;

export type SelfhostV2SqliteResult = Readonly<{
  rows: readonly EdgeSqlRow[];
  rowsWritten: number;
}>;

export type SelfhostV2SqliteStatement = Readonly<{
  sql: string;
  params?: readonly EdgeSqlValue[];
}>;

export type V2QueueSQLiteBinding = Readonly<{ name: string; resourceUid: string }>;

/** A private, selected 0083 batch. No tenant-controlled SQL or HTTP path accepts this. */
export interface V2QueueSQLiteGrant {
  readonly execution: V2QueueBatchExecutionIdentity;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly versionOperationId: string;
  readonly nativeVersionId: string;
  readonly bindings: readonly V2QueueSQLiteBinding[];
}

export interface V2QueueSQLiteSelectedBindings {
  /** The unique succeeded, sealed historical Operation for this selected UID/generation. */
  readonly versionOperationId: string;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionGeneration: number;
  readonly bindings: readonly V2QueueSQLiteBinding[];
}

export interface V2QueueSQLiteProofPort {
  /** Fixed primary-D1 Core read of exact execution identity and 0090 custody. */
  readCustody(execution: V2QueueBatchExecutionIdentity): Promise<V2QueueBatchSQLiteCustody>;
  /** Fixed primary-D1 read of the selected historical Version Operation's sealed full set. */
  readSelectedBindings(
    execution: V2QueueBatchExecutionIdentity,
  ): Promise<V2QueueSQLiteSelectedBindings | null>;
  /** Existing current Version/native/active-edge and settled Database authority. */
  resolveCurrentBinding(
    grant: V2QueueSQLiteGrant,
    name: string,
  ): Promise<{ readonly resourceUid: string; readonly vector: string } | null>;
  /** Positive native owner readback; a process map or grant alone is insufficient. */
  observeNative(grant: V2QueueSQLiteGrant): Promise<
    | {
        readonly kind: "confirmed";
        readonly workerUid: string;
        readonly versionId: string;
        readonly incarnationId: string;
        readonly servingSourceOperationId: string;
        readonly status: "active" | "draining";
      }
    | { readonly kind: "unknown" }
  >;
  /**
   * The same native/current/closure readback, but without a recursive Node
   * SQLite inspection. The store has locked and verified *every* selected UID
   * in the opaque physical set before this method may be called.
   */
  observeNativeWithPhysicalFence(
    grant: V2QueueSQLiteGrant,
    physical: SQLiteLockedPhysicalSet,
  ): ReturnType<V2QueueSQLiteProofPort["observeNative"]>;
  /** The one Core 0090 pending→drained CAS, not a Node-owned ledger. */
  confirmDrained(input: {
    readonly execution: V2QueueBatchExecutionIdentity;
    readonly terminal: V2QueueBatchTerminal;
    readonly receiptDigest: `sha256:${string}`;
  }): Promise<boolean>;
}

export type V2QueueSQLiteCall =
  | {
      readonly grant: V2QueueSQLiteGrant;
      readonly binding: string;
      readonly method: "execute" | "query";
      readonly statement: SelfhostV2SqliteStatement;
      readonly signal?: AbortSignal;
      readonly deadlineAtMs?: number;
    }
  | {
      readonly grant: V2QueueSQLiteGrant;
      readonly binding: string;
      readonly method: "transaction";
      readonly statements: readonly SelfhostV2SqliteStatement[];
      readonly signal?: AbortSignal;
      readonly deadlineAtMs?: number;
    };
