import { describe, expect, test } from "bun:test";
import {
  parseAtLeastOnceQueueSpec,
  validateAtLeastOnceQueueUpdate,
} from "../src/takoform-v2/forms/at-least-once-queue.ts";
import {
  parseQueueConsumerSpec,
  queueConsumerReferences,
  validateQueueConsumerUpdate,
} from "../src/takoform-v2/forms/queue-consumer.ts";

const consumer = {
  queue: { resourceUid: "queue-1" },
  worker: { resourceUid: "worker-1" },
  maxBatchSize: 10,
  maxBatchTimeoutSeconds: 5,
  maxConcurrency: 4,
  maxRetries: 3,
  retryDelaySeconds: 30,
};

describe("AtLeastOnceQueue 0.2", () => {
  test("normalizes the only default and permits full replacement", () => {
    expect(parseAtLeastOnceQueueSpec({ messageRetentionSeconds: 60 })).toEqual({
      deliveryDelaySeconds: 0,
      messageRetentionSeconds: 60,
    });
    expect(
      validateAtLeastOnceQueueUpdate(
        { messageRetentionSeconds: 60 },
        { deliveryDelaySeconds: 43_200, messageRetentionSeconds: 1_209_600 },
      ),
    ).toEqual({ deliveryDelaySeconds: 43_200, messageRetentionSeconds: 1_209_600 });
  });

  test.each([
    {},
    { messageRetentionSeconds: 59 },
    { messageRetentionSeconds: 1_209_601 },
    { messageRetentionSeconds: "60" },
    { messageRetentionSeconds: 60, deliveryDelaySeconds: -1 },
    { messageRetentionSeconds: 60, deliveryDelaySeconds: 1.5 },
    { messageRetentionSeconds: 60, extra: true },
  ])("rejects invalid closed shape %j", (input) => {
    expect(() => parseAtLeastOnceQueueSpec(input)).toThrow();
  });
});

describe("QueueConsumer 0.3", () => {
  test("parses exact required fields and declares exact UID/Form references", () => {
    const parsed = parseQueueConsumerSpec({
      ...consumer,
      deadLetterQueue: { resourceUid: "dlq-1" },
    });
    expect(parsed).toEqual({ ...consumer, deadLetterQueue: { resourceUid: "dlq-1" } });
    expect(queueConsumerReferences(parsed)).toEqual([
      {
        resourceUid: "dlq-1",
        formUrl: "https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/",
        readiness: "observed",
      },
      {
        resourceUid: "queue-1",
        formUrl: "https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/",
        readiness: "observed",
      },
      {
        resourceUid: "worker-1",
        formUrl: "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/",
        readiness: "observed",
      },
    ]);
  });

  test("allows policy update but pins queue and worker UID", () => {
    expect(validateQueueConsumerUpdate(consumer, { ...consumer, maxRetries: 0 }).maxRetries).toBe(
      0,
    );
    expect(() =>
      validateQueueConsumerUpdate(consumer, { ...consumer, queue: { resourceUid: "other" } }),
    ).toThrow();
    expect(() =>
      validateQueueConsumerUpdate(consumer, { ...consumer, worker: { resourceUid: "other" } }),
    ).toThrow();
  });

  test.each([
    { ...consumer, maxBatchSize: 0 },
    { ...consumer, maxBatchTimeoutSeconds: 61 },
    { ...consumer, maxConcurrency: 251 },
    { ...consumer, maxRetries: 101 },
    { ...consumer, retryDelaySeconds: 43_201 },
    { ...consumer, retryDelaySeconds: "0" },
    { ...consumer, queue: { resourceUid: "bad:uid" } },
    { ...consumer, queue: { resourceUid: "queue-1", name: "wrong" } },
    { ...consumer, deadLetterQueue: { resourceUid: "queue-1" } },
    { ...consumer, extra: true },
  ])("rejects invalid closed shape %j", (input) => {
    expect(() => parseQueueConsumerSpec(input)).toThrow();
  });
});
