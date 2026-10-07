import {
  type QueueCustody,
  type QueueCustodyBatchReceipt,
  type QueueCustodyClaimedMessage,
  QueueCustodyConflictError,
} from "../queue-custody.ts";

type QueueSettlementErrorName =
  | "unknown_batch"
  | "unknown_message"
  | "already_settled"
  | "backend_unavailable";

function settlementError(name: QueueSettlementErrorName): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function checkedDelay(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 43_200)) {
    throw new TypeError("Queue retry delay must be an integer from 0 to 43200");
  }
  return value;
}

function snapshotClaim(message: QueueCustodyClaimedMessage): QueueCustodyClaimedMessage {
  const deadLetterQueue = message.policy.deadLetterQueue;
  return {
    queueId: message.queueId,
    consumerId: message.consumerId,
    generation: message.generation,
    leaseToken: message.leaseToken,
    messageId: message.messageId,
    body: message.body.slice(),
    enqueuedAtMillis: message.enqueuedAtMillis,
    visibleAtMillis: message.visibleAtMillis,
    attempts: message.attempts,
    policy: {
      maxRetries: message.policy.maxRetries,
      retryDelaySeconds: message.policy.retryDelaySeconds,
      ...(deadLetterQueue
        ? {
            deadLetterQueue: {
              queueId: deadLetterQueue.queueId,
              messageRetentionSeconds: deadLetterQueue.messageRetentionSeconds,
              deliveryDelaySeconds: deadLetterQueue.deliveryDelaySeconds,
            },
          }
        : {}),
    },
  };
}

export interface V2WorkerQueueMessage {
  readonly id: string;
  readonly timestampMillis: number;
  readonly body: Uint8Array;
  readonly attempts: number;
}

export interface V2WorkerQueueBatch {
  readonly batchId: string;
  readonly queue: string;
  readonly messages: readonly V2WorkerQueueMessage[];
  acknowledge(messageId: string): Promise<void>;
  retry(messageId: string, delaySeconds?: number): Promise<void>;
  acknowledgeAll(): Promise<void>;
  retryAll(delaySeconds?: number): Promise<void>;
}

export interface V2WorkerQueueSettlement {
  open(input: {
    readonly batchId: string;
    readonly queue: string;
    readonly messages: readonly QueueCustodyClaimedMessage[];
  }): Promise<V2WorkerQueueBatch>;
  observe(input: {
    readonly batchId: string;
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
  }): Promise<readonly QueueCustodyBatchReceipt[]>;
  invoke(input: {
    readonly batchId: string;
    readonly queue: string;
    readonly messages: readonly QueueCustodyClaimedMessage[];
    readonly handler: (batch: V2WorkerQueueBatch) => Promise<unknown> | unknown;
  }): Promise<"resolved" | "rejected">;
}

/**
 * Internal v2 Queue batch bridge. `QueueCustody` remains the only message/lease
 * authority; its atomic receipt-aware settlement is awaited before any JS
 * Promise resolves. This is not a Form registration or native event sender.
 */
export function createV2WorkerQueueSettlement(options: {
  readonly custody: QueueCustody;
  readonly randomId?: () => string;
}): V2WorkerQueueSettlement {
  const custody = options.custody;
  if (!custody) throw new TypeError("Queue custody is required");
  const randomId = options.randomId ?? (() => crypto.randomUUID());

  const observe: V2WorkerQueueSettlement["observe"] = async (input) => {
    let receipts: readonly QueueCustodyBatchReceipt[];
    try {
      receipts = await custody.readSettlementBatch(input);
    } catch {
      throw settlementError("backend_unavailable");
    }
    if (receipts.length === 0) throw settlementError("unknown_batch");
    return receipts;
  };

  const open: V2WorkerQueueSettlement["open"] = async (input) => {
    // The exact public ABI identity is immutable for the entire invocation.
    // Do not reread a caller-owned input after the first registration await.
    const batchId = input.batchId;
    const queue = input.queue;
    if (typeof queue !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(queue)) {
      throw new TypeError("Queue Resource name is invalid");
    }
    const messages = input.messages.map(snapshotClaim);
    try {
      await custody.registerSettlementBatch(batchId, messages);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      if (error instanceof QueueCustodyConflictError) {
        throw settlementError("backend_unavailable");
      }
      throw settlementError("backend_unavailable");
    }
    const first = messages[0];
    if (!first) throw new TypeError("Queue batch is empty");
    const scope = {
      batchId,
      queueId: first.queueId,
      consumerId: first.consumerId,
      generation: first.generation,
    };
    const byId = new Map(messages.map((message) => [message.messageId, message]));

    const settle = async (
      id: string,
      decision: { readonly outcome: "ack" | "retry"; readonly delaySeconds?: number },
    ): Promise<void> => {
      const message = byId.get(id);
      if (!message) throw settlementError("unknown_message");
      let result: Awaited<ReturnType<QueueCustody["settleBatchMessage"]>>;
      try {
        result = await custody.settleBatchMessage({
          batchId,
          message,
          decision,
          settlementToken: randomId(),
        });
      } catch (error) {
        if (error instanceof TypeError) throw error;
        throw settlementError("backend_unavailable");
      }
      if (result === "settled") return;
      throw settlementError(result === "unavailable" ? "backend_unavailable" : result);
    };

    const settleAll = async (decision: {
      readonly outcome: "ack" | "retry";
      readonly delaySeconds?: number;
    }): Promise<void> => {
      const receipts = await observe(scope);
      for (const receipt of receipts) {
        if (receipt.state === "settled") continue;
        try {
          await settle(receipt.messageId, decision);
        } catch (error) {
          // A concurrent individual settle wins permanently; All never
          // reverses it and may continue with the remaining messages.
          if (error instanceof Error && error.name === "already_settled") continue;
          if (error instanceof Error && error.name === "unknown_message") {
            throw settlementError("backend_unavailable");
          }
          throw error;
        }
      }
    };

    const batch: V2WorkerQueueBatch = Object.freeze({
      batchId,
      queue,
      messages: Object.freeze(
        messages.map((message) =>
          Object.freeze({
            id: message.messageId,
            timestampMillis: message.enqueuedAtMillis,
            body: message.body.slice(),
            attempts: message.attempts,
          }),
        ),
      ),
      acknowledge: async (id: string) => await settle(id, { outcome: "ack" }),
      retry: async (id: string, delaySeconds?: number) => {
        const delay = checkedDelay(delaySeconds);
        await settle(id, {
          outcome: "retry",
          ...(delay === undefined ? {} : { delaySeconds: delay }),
        });
      },
      acknowledgeAll: async () => await settleAll({ outcome: "ack" }),
      retryAll: async (delaySeconds?: number) => {
        checkedDelay(delaySeconds);
        await settleAll({
          outcome: "retry",
          ...(delaySeconds === undefined ? {} : { delaySeconds }),
        });
      },
    });
    return batch;
  };

  return {
    open,
    observe,
    async invoke(input) {
      const batch = await open(input);
      let rejected = false;
      try {
        await input.handler(batch);
      } catch {
        rejected = true;
      }
      if (rejected) {
        await batch.retryAll();
        return "rejected";
      }
      await batch.acknowledgeAll();
      return "resolved";
    },
  };
}
