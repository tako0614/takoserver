import { createHash } from "node:crypto";
import type {
  V2QueueBatchExecutionIdentity,
  V2QueueBatchSQLiteCustody,
  V2QueueBatchTerminal,
} from "../queue-v2-batch-custody-contract.ts";
import {
  createSelfhostV2SqlitePlane,
  type EdgeSqlValue,
  SelfhostV2SqliteError,
  type SelfhostV2SqliteStatement,
} from "./selfhost-v2-sqlite-plane.ts";
import { type SelfhostV2SQLiteStore, SQLITE_MIGRATION_LEDGER } from "./selfhost-v2-sqlite-store.ts";

const UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BINDING = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const RECEIPT = /^[a-f0-9]{64}$/u;
const DRAIN_RECEIPT = /^sha256:[a-f0-9]{64}$/u;

type Binding = Readonly<{ name: string; resourceUid: string }>;

/** A private, selected 0083 batch. No tenant-controlled SQL or HTTP path accepts this. */
export interface V2QueueSQLiteGrant {
  readonly execution: V2QueueBatchExecutionIdentity;
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly versionOperationId: string;
  readonly nativeVersionId: string;
  readonly bindings: readonly Binding[];
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
  readonly bindings: readonly Binding[];
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
    }
  | {
      readonly grant: V2QueueSQLiteGrant;
      readonly binding: string;
      readonly method: "transaction";
      readonly statements: readonly SelfhostV2SqliteStatement[];
    };

function unavailable(): SelfhostV2SqliteError {
  return new SelfhostV2SqliteError("backend_unavailable");
}

function checkedExecution(input: V2QueueBatchExecutionIdentity): V2QueueBatchExecutionIdentity {
  if (
    !input ||
    [
      input.batchId,
      input.reservationToken,
      input.queueUid,
      input.consumerUid,
      input.workerUid,
      input.servingSourceOperationId,
      input.workerVersionUid,
      input.incarnationOperationId,
    ].some((value) => typeof value !== "string" || !UID.test(value)) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !Number.isSafeInteger(input.workerVersionGeneration) ||
    input.workerVersionGeneration < 1
  )
    throw unavailable();
  return {
    batchId: input.batchId,
    reservationToken: input.reservationToken,
    queueUid: input.queueUid,
    consumerUid: input.consumerUid,
    generation: input.generation,
    workerUid: input.workerUid,
    servingSourceOperationId: input.servingSourceOperationId,
    workerVersionUid: input.workerVersionUid,
    workerVersionGeneration: input.workerVersionGeneration,
    incarnationOperationId: input.incarnationOperationId,
  };
}

function sortedBindings(input: readonly Binding[]): Binding[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 64 ||
    input.some(
      (binding) =>
        !binding ||
        typeof binding.name !== "string" ||
        !BINDING.test(binding.name) ||
        typeof binding.resourceUid !== "string" ||
        !UID.test(binding.resourceUid),
    ) ||
    new Set(input.map((binding) => binding.name)).size !== input.length
  )
    throw unavailable();
  return input
    .map((binding) => ({ name: binding.name, resourceUid: binding.resourceUid }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function checkedGrant(input: V2QueueSQLiteGrant, targetKey: string): V2QueueSQLiteGrant {
  if (
    !input ||
    typeof input.principal !== "string" ||
    !input.principal ||
    typeof input.space !== "string" ||
    !input.space ||
    input.targetKey !== targetKey ||
    typeof input.versionOperationId !== "string" ||
    !UID.test(input.versionOperationId) ||
    typeof input.nativeVersionId !== "string" ||
    !input.nativeVersionId
  )
    throw unavailable();
  return {
    execution: checkedExecution(input.execution),
    principal: input.principal,
    space: input.space,
    targetKey: input.targetKey,
    versionOperationId: input.versionOperationId,
    nativeVersionId: input.nativeVersionId,
    bindings: sortedBindings(input.bindings),
  };
}

function sameBindings(left: readonly Binding[], right: readonly Binding[]): boolean {
  const ordered = sortedBindings(right);
  return (
    left.length === ordered.length &&
    left.every(
      (binding, index) =>
        binding.name === ordered[index]?.name &&
        binding.resourceUid === ordered[index]?.resourceUid,
    )
  );
}

function sameTerminal(left: V2QueueBatchTerminal | null, right: V2QueueBatchTerminal): boolean {
  return (
    left?.kind === right.kind &&
    left.receiptDigest === right.receiptDigest &&
    RECEIPT.test(right.receiptDigest)
  );
}

function validTerminal(value: V2QueueBatchTerminal): boolean {
  return (
    (value?.kind === "handler_and_wait_until" || value?.kind === "incarnation_absent") &&
    typeof value.receiptDigest === "string" &&
    RECEIPT.test(value.receiptDigest)
  );
}

/**
 * Dormant Host-private Node module. The private transport must authenticate a
 * grant and supply primary-D1 fixed proof ports before mounting this interface.
 * The existing invocation and queue batch ledgers remain the only authorities.
 */
export function createSelfhostV2SqliteQueueBindingBroker(options: {
  readonly store: SelfhostV2SQLiteStore;
  readonly proofs: V2QueueSQLiteProofPort;
}) {
  if (
    !options?.store ||
    !options.proofs ||
    typeof options.proofs.readCustody !== "function" ||
    typeof options.proofs.readSelectedBindings !== "function" ||
    typeof options.proofs.resolveCurrentBinding !== "function" ||
    typeof options.proofs.observeNative !== "function" ||
    typeof options.proofs.confirmDrained !== "function"
  )
    throw new TypeError("trusted Queue SQLite Node proof ports are required");
  const { store, proofs } = options;

  async function readExact(grant: V2QueueSQLiteGrant): Promise<{
    readonly custody: Extract<V2QueueBatchSQLiteCustody, { kind: "found" }>;
    readonly selected: V2QueueSQLiteSelectedBindings;
  } | null> {
    const [custody, selected] = await Promise.all([
      proofs.readCustody(grant.execution),
      proofs.readSelectedBindings(grant.execution),
    ]);
    if (
      custody.kind !== "found" ||
      !selected ||
      custody.principal !== grant.principal ||
      custody.space !== grant.space ||
      custody.targetKey !== grant.targetKey ||
      selected.principal !== grant.principal ||
      selected.space !== grant.space ||
      selected.targetKey !== grant.targetKey ||
      selected.workerUid !== grant.execution.workerUid ||
      selected.workerVersionUid !== grant.execution.workerVersionUid ||
      selected.workerVersionGeneration !== grant.execution.workerVersionGeneration ||
      selected.versionOperationId !== grant.versionOperationId ||
      !sameBindings(grant.bindings, selected.bindings)
    )
      return null;
    return { custody, selected: { ...selected, bindings: sortedBindings(selected.bindings) } };
  }

  async function liveProof(
    grant: V2QueueSQLiteGrant,
    binding: string,
  ): Promise<{ readonly resourceUid: string; readonly vector: string } | null> {
    const exact = await readExact(grant);
    if (
      exact?.custody.sqliteDrainState !== "pending" ||
      exact.custody.terminal !== null ||
      exact.custody.retirement !== null
    )
      return null;
    const native = await proofs.observeNative(grant);
    if (
      native.kind !== "confirmed" ||
      native.workerUid !== grant.execution.workerUid ||
      native.versionId !== grant.nativeVersionId ||
      native.incarnationId !== grant.execution.incarnationOperationId ||
      native.servingSourceOperationId !== grant.execution.servingSourceOperationId ||
      (native.status !== "active" && native.status !== "draining")
    )
      return null;
    const chosen = grant.bindings.find((entry) => entry.name === binding);
    if (!chosen) return null;
    const current = await proofs.resolveCurrentBinding(grant, binding);
    return current?.resourceUid === chosen.resourceUid && current.vector ? current : null;
  }

  async function call(input: V2QueueSQLiteCall): Promise<unknown> {
    const grant = checkedGrant(input.grant, store.targetKey);
    if (
      typeof input.binding !== "string" ||
      !BINDING.test(input.binding) ||
      (input.method !== "execute" && input.method !== "query" && input.method !== "transaction")
    )
      throw unavailable();
    return await store.withInvocationLock(`queue:${grant.execution.batchId}`, async () => {
      const captured = await liveProof(grant, input.binding);
      if (!captured) throw unavailable();
      const stillAuthorized = async () => {
        const current = await liveProof(grant, input.binding);
        return current?.resourceUid === captured.resourceUid && current.vector === captured.vector;
      };
      return await store.withAuthorizedDatabase({
        resourceUid: captured.resourceUid,
        stillAuthorized,
        use: async (database) => {
          if (!(await stillAuthorized())) throw unavailable();
          const plane = createSelfhostV2SqlitePlane({
            database,
            migrationLedger: SQLITE_MIGRATION_LEDGER,
          });
          let result: unknown;
          if (input.method === "transaction") {
            result = await plane.transaction(input.statements);
          } else {
            const statement = input.statement;
            result =
              input.method === "execute"
                ? await plane.execute(statement.sql, statement.params as readonly EdgeSqlValue[])
                : await plane.query(statement.sql, statement.params as readonly EdgeSqlValue[]);
          }
          // An error after commit is an unknown effect, never permission to retry.
          if (!(await stillAuthorized())) throw unavailable();
          return result;
        },
      });
    });
  }

  async function drain(
    offeredGrant: V2QueueSQLiteGrant,
    terminal: V2QueueBatchTerminal,
  ): Promise<boolean> {
    const grant = checkedGrant(offeredGrant, store.targetKey);
    if (!validTerminal(terminal)) return false;
    try {
      return await store.withInvocationLock(`queue:${grant.execution.batchId}`, async () => {
        const exact = await readExact(grant);
        if (
          !exact ||
          !sameTerminal(exact.custody.terminal, terminal) ||
          exact.custody.retirement !== null ||
          (exact.custody.sqliteDrainState !== "pending" &&
            exact.custody.sqliteDrainState !== "drained")
        )
          return false;
        const resourceUids = [
          ...new Set(exact.selected.bindings.map((item) => item.resourceUid)),
        ].sort();
        const receiptDigest = `sha256:${createHash("sha256")
          .update(
            JSON.stringify([
              "takoserver.v2-queue-sqlite-drain@v1",
              [
                grant.execution.batchId,
                grant.execution.reservationToken,
                grant.execution.queueUid,
                grant.execution.consumerUid,
                grant.execution.generation,
                grant.execution.workerUid,
                grant.execution.servingSourceOperationId,
                grant.execution.workerVersionUid,
                grant.execution.workerVersionGeneration,
                grant.execution.incarnationOperationId,
              ],
              grant.principal,
              grant.space,
              grant.targetKey,
              grant.nativeVersionId,
              exact.selected.versionOperationId,
              exact.selected.bindings.map((binding) => [binding.name, binding.resourceUid]),
              [terminal.kind, terminal.receiptDigest],
              resourceUids,
            ]),
          )
          .digest("hex")}` as const;
        if (!DRAIN_RECEIPT.test(receiptDigest)) return false;
        if (exact.custody.sqliteDrainState === "drained")
          return exact.custody.sqliteDrainReceiptDigest === receiptDigest;
        for (const uid of resourceUids) {
          if (!(await store.recoverOwnedDatabase(uid))) return false;
        }
        try {
          if (await proofs.confirmDrained({ execution: grant.execution, terminal, receiptDigest }))
            return true;
        } catch {
          // The primary-D1 write may have committed before its ACK was lost.
        }
        // A D1 CAS ACK may be lost after commit. Only same-row exact digest
        // readback can distinguish that from an unknown outcome.
        const after = await readExact(grant);
        return (
          after?.custody.sqliteDrainState === "drained" &&
          sameTerminal(after.custody.terminal, terminal) &&
          after.custody.sqliteDrainReceiptDigest === receiptDigest
        );
      });
    } catch {
      return false;
    }
  }

  return Object.freeze({ call, drain });
}
