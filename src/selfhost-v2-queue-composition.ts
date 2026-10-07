import { createHmac } from "node:crypto";
import type { Sql } from "./ports.ts";
import {
  createV2QueueSettlementAuthority,
  createV2QueueSettlementEndpoint,
} from "./providers/selfhost-v2-queue-transport.ts";
import type { QueueCustody } from "./queue-custody.ts";
import type { V2QueueConsumerCapability } from "./takoform-v2/worker-queue-consumer-backend.ts";
import {
  authorizeV2QueueBatchSend,
  cancelV2QueueBatchBeforeSend,
  confirmV2QueueBatchRetirement,
  createV2QueueDelivery,
  type V2QueueBatchExecutionIdentity,
  v2QueueId,
  verifyV2QueueSettlementScope,
} from "./takoform-v2/worker-queue-delivery.ts";
import type { WorkerdWorkerRuntimeOwner } from "./workerd-worker-runtime-owner.ts";

export interface SelfhostV2QueueCompositionOptions {
  readonly sql: Sql;
  readonly custody: QueueCustody;
  readonly capability: V2QueueConsumerCapability;
  /** Must be stable across Host restarts; supplied from operator-private custody. */
  readonly settlementKey: Uint8Array;
  readonly ownerForWorkerUid: (uid: string) => Promise<WorkerdWorkerRuntimeOwner>;
  /** Operator-owned stable port; a recovered native graph retains this address. */
  readonly privatePort: number;
}

/**
 * Private Queue vertical: accepted Core claim/0082 receipt, native one-shot
 * handler, SQL 0083 execution lifetime, and authenticated durable settlement.
 * It does not register public Queue Forms or expose a management endpoint.
 */
export function createSelfhostV2QueueComposition(options: SelfhostV2QueueCompositionOptions) {
  if (
    !options.sql ||
    !options.custody ||
    typeof options.capability?.observeCurrentServing !== "function" ||
    typeof options.ownerForWorkerUid !== "function" ||
    !(options.settlementKey instanceof Uint8Array) ||
    options.settlementKey.byteLength < 32 ||
    !Number.isInteger(options.privatePort) ||
    options.privatePort < 1 ||
    options.privatePort > 65_535
  )
    throw new TypeError("v2 Queue requires SQL, custody, native owner and private authority");
  const key = new Uint8Array(options.settlementKey);
  const delivery = createV2QueueDelivery({
    sql: options.sql,
    custody: options.custody,
    capability: options.capability,
  });
  const auth = createV2QueueSettlementAuthority({
    key,
    now: Date.now,
    scope: {
      native: {
        async observeQueueTarget(input) {
          try {
            const owner = await options.ownerForWorkerUid(input.workerUid);
            return await owner.observeQueueTarget(input);
          } catch {
            return { kind: "unknown" };
          }
        },
      },
      core: {
        verifyV2QueueSettlementScope: async (input) =>
          await verifyV2QueueSettlementScope(options.sql, input),
      },
    },
  });
  const endpoint = createV2QueueSettlementEndpoint({
    custody: options.custody,
    auth,
    queueIdForUid: v2QueueId,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.privatePort,
    fetch: endpoint,
  });
  if (server.port !== options.privatePort) {
    void server.stop(true);
    throw new Error("v2 Queue private port binding differs from configured port");
  }
  const address = `127.0.0.1:${options.privatePort}`;
  const settlementBinding = Object.freeze({
    address,
    bindingToken: auth.bindingToken,
    queueIdForUid: v2QueueId,
  });
  const defaultToken = (batchId: string, messageId: string, outcome: "ack" | "retry") =>
    createHmac("sha256", key)
      .update("default-settlement/v2\0")
      .update(JSON.stringify([batchId, messageId, outcome]))
      .digest("base64url");

  async function deliverOnce(input: {
    readonly consumerUid: string;
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
  }): Promise<{ readonly kind: "idle" | "unknown" | "handler_resolved" | "handler_rejected" }> {
    const scope = { ...input };
    const batch = await delivery
      .claimRegisteredBatch(scope)
      .catch(() => ({ kind: "unknown" as const }));
    if (batch.kind !== "ready") return { kind: batch.kind };
    let owner: WorkerdWorkerRuntimeOwner;
    try {
      owner = await options.ownerForWorkerUid(batch.workerUid);
    } catch {
      await cancelV2QueueBatchBeforeSend(options.sql, batch).catch(() => false);
      return { kind: "unknown" };
    }
    const execution = (target: {
      readonly workerVersionUid: string;
      readonly workerVersionGeneration: number;
      readonly incarnationOperationId: string;
    }): V2QueueBatchExecutionIdentity => ({
      batchId: batch.batchId,
      reservationToken: batch.reservationToken,
      queueUid: batch.queueUid,
      consumerUid: batch.consumerUid,
      generation: batch.generation,
      workerUid: batch.workerUid,
      servingSourceOperationId: batch.servingSourceOperationId,
      ...target,
    });
    const outcome = await owner
      .invokeQueue({
        ...batch,
        mintCapability: auth.mint,
        authorizeSend: async (target) =>
          await authorizeV2QueueBatchSend(options.sql, execution(target)),
      })
      .catch(() => ({ kind: "unknown" as const }));
    if (outcome.kind === "unknown") {
      // Only a provably unsent reservation can be refunded. An authorized
      // batch remains occupied after response loss, even if every ACK landed.
      await cancelV2QueueBatchBeforeSend(options.sql, batch).catch(() => false);
      return { kind: "unknown" };
    }
    const retired = await confirmV2QueueBatchRetirement(options.sql, {
      execution: execution(outcome),
      kind: "handler_and_wait_until",
      receiptDigest: outcome.receiptDigest,
    }).catch(() => "unknown" as const);
    if (retired === "unknown") return { kind: "unknown" };

    // ModuleWorker's default is per pending message. Earlier tenant ACK/retry
    // is terminal; an unknown SQL result is not treated as success.
    const decision = { outcome: outcome.kind === "handler_resolved" ? "ack" : "retry" } as const;
    for (const claim of batch.claims) {
      const settled = await options.custody
        .settleRegisteredBatchMessage({
          batchId: batch.batchId,
          messageId: claim.messageId,
          expected: {
            queueId: claim.queueId,
            consumerId: batch.consumerUid,
            generation: batch.generation,
            leaseToken: claim.leaseToken,
          },
          decision,
          settlementToken: defaultToken(batch.batchId, claim.messageId, decision.outcome),
        })
        .catch(() => "unavailable" as const);
      if (settled !== "settled" && settled !== "already_settled") return { kind: "unknown" };
    }
    return { kind: outcome.kind };
  }

  return Object.freeze({
    /** Pass this exact boot object to every v2 native UID owner. */
    settlementBinding,
    deliverOnce,
    close: async () => {
      await server.stop(true);
    },
  });
}
