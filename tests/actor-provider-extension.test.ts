import { expect, test } from "bun:test";
import * as root from "@takoserver/core";
import type { V2QueueBatchExecutionIdentity as ExtensionV2QueueBatchExecutionIdentity } from "@takoserver/core/provider-extension";
import * as providerExtension from "@takoserver/core/provider-extension";
import type { V2QueueBatchExecutionIdentity } from "../src/takoform-v2/worker-queue-delivery.ts";
import {
  authorizeV2QueueBatchSend,
  cancelV2QueueBatchBeforeSend,
  confirmV2QueueBatchRetirement,
  createV2QueueDelivery,
  verifyV2QueueSettlementScope,
} from "../src/takoform-v2/worker-queue-delivery.ts";

const ACTOR_EXTENSION_VALUES = [
  "ActorRuntimeError",
  "createActorClassExecution",
  "createActorContext",
  "createActorTurn",
  "inspectActorClass",
  "isActorRuntimeError",
] as const;

test("provider-extension exposes only the child-only Actor helper seam", () => {
  for (const name of ACTOR_EXTENSION_VALUES) {
    expect(name in providerExtension).toBe(true);
    expect(name in root).toBe(false);
  }

  expect("ActorExecutionError" in providerExtension).toBe(false);
  expect("ActorInstance" in providerExtension).toBe(false);
});

test("provider-extension exposes the existing trusted v2 Queue delivery authority", () => {
  const queueExports = {
    authorizeV2QueueBatchSend,
    cancelV2QueueBatchBeforeSend,
    confirmV2QueueBatchRetirement,
    createV2QueueDelivery,
    verifyV2QueueSettlementScope,
  };

  for (const [name, source] of Object.entries(queueExports)) {
    expect(Reflect.get(providerExtension, name)).toBe(source);
    expect(name in root).toBe(false);
  }

  const execution: ExtensionV2QueueBatchExecutionIdentity = {
    batchId: "batch",
    reservationToken: "reservation",
    queueUid: "queue",
    consumerUid: "consumer",
    generation: 1,
    workerUid: "worker",
    servingSourceOperationId: "source-op",
    workerVersionUid: "worker-version",
    workerVersionGeneration: 1,
    incarnationOperationId: "incarnation-op",
  };
  const source: V2QueueBatchExecutionIdentity = execution;
  expect(source.batchId).toBe("batch");
});
