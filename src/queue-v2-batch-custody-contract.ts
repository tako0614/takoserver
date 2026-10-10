/** Exact accepted 0083 execution, shared by Core custody and the native owner. */
export interface V2QueueBatchExecutionIdentity {
  readonly batchId: string;
  readonly reservationToken: string;
  readonly queueUid: string;
  readonly consumerUid: string;
  readonly generation: number;
  readonly workerUid: string;
  readonly servingSourceOperationId: string;
  readonly workerVersionUid: string;
  readonly workerVersionGeneration: number;
  readonly incarnationOperationId: string;
}

export type V2QueueBatchTerminal = {
  readonly kind: "handler_and_wait_until" | "incarnation_absent";
  readonly receiptDigest: string;
};

export type V2QueueBatchSQLiteCustody =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "found";
      /** Accepted 0083 scope; never substitute an untrusted grant's scope. */
      readonly principal: string;
      readonly space: string;
      readonly targetKey: string;
      readonly sqliteDrainState: null | "pending" | "drained";
      readonly sqliteDrainReceiptDigest: null | `sha256:${string}`;
      readonly terminal: null | V2QueueBatchTerminal;
      readonly retirement: null | V2QueueBatchTerminal;
    };
