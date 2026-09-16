import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createQueueCustody } from "../src/queue-custody.ts";

const SOURCE = {
  queueId: "queue-source",
  messageRetentionSeconds: 3_600,
  deliveryDelaySeconds: 0,
} as const;
const OLD_DLQ = {
  queueId: "queue-old-dlq",
  messageRetentionSeconds: 7_200,
  deliveryDelaySeconds: 3,
} as const;
const NEW_DLQ = {
  queueId: "queue-new-dlq",
  messageRetentionSeconds: 14_400,
  deliveryDelaySeconds: 5,
} as const;
const FIRST = {
  queueId: SOURCE.queueId,
  consumerId: "consumer-one",
  generation: 1,
  policy: { maxRetries: 0, retryDelaySeconds: 7, deadLetterQueue: OLD_DLQ },
} as const;
const SECOND = {
  queueId: SOURCE.queueId,
  consumerId: "consumer-one",
  generation: 2,
  policy: { maxRetries: 3, retryDelaySeconds: 11, deadLetterQueue: NEW_DLQ },
} as const;

test("retirement fences new claims and reaps an expired generation with its snapshotted DLQ", async () => {
  const sql = createEphemeralSql();
  let millis = 100_000;
  const ids = ["lease-one", "old-dead-letter", "lease-two"];
  const custody = createQueueCustody({
    sql,
    clock: () => new Date(millis),
    randomId: () => ids.shift() ?? "unused-id",
  });

  await custody.admitBatch(SOURCE, [
    { messageId: "message-one", body: new Uint8Array([1]) },
    { messageId: "message-two", body: new Uint8Array([2]) },
  ]);
  await custody.activateConsumer(FIRST);
  const [claimed] = await custody.claim({ ...FIRST, limit: 1, leaseMillis: 1_000 });
  expect(claimed).toMatchObject({
    messageId: "message-one",
    generation: 1,
    attempts: 1,
    policy: FIRST.policy,
  });
  if (!claimed) throw new Error("first Queue custody claim is missing");

  expect(await custody.beginRetirement(FIRST)).toEqual({
    state: "waiting",
    waitUntilMillis: 101_000,
  });
  await custody.admit(SOURCE, { messageId: "message-three", body: new Uint8Array([3]) });
  expect(await custody.claim({ ...FIRST, limit: 3 })).toEqual([]);
  expect(await custody.finishRetirement({ ...FIRST, replacement: SECOND })).toEqual({
    state: "waiting",
    waitUntilMillis: 101_000,
  });

  millis = 101_001;
  expect(await custody.finishRetirement({ ...FIRST, replacement: SECOND })).toEqual({
    state: "reap",
    remaining: 1,
  });
  expect(await custody.reapRetired(FIRST)).toEqual({ state: "ready" });
  expect(await custody.finishRetirement({ ...FIRST, replacement: SECOND })).toEqual({
    state: "activated",
    generation: 2,
  });

  const rows = await sql.query(
    `SELECT queue_id, message_id, deliveries, enqueued_at_ms, visible_at_ms, expires_at_ms
     FROM selfhost_queue_messages ORDER BY queue_id, message_id`,
  );
  expect(rows).toEqual([
    {
      queue_id: OLD_DLQ.queueId,
      message_id: "old-dead-letter",
      deliveries: 0,
      enqueued_at_ms: 101_001,
      visible_at_ms: 104_001,
      expires_at_ms: 7_301_001,
    },
    {
      queue_id: SOURCE.queueId,
      message_id: "message-three",
      deliveries: 0,
      enqueued_at_ms: 100_000,
      visible_at_ms: 100_000,
      expires_at_ms: 3_700_000,
    },
    {
      queue_id: SOURCE.queueId,
      message_id: "message-two",
      deliveries: 0,
      enqueued_at_ms: 100_000,
      visible_at_ms: 100_000,
      expires_at_ms: 3_700_000,
    },
  ]);

  const next = await custody.claim({ ...SECOND, limit: 1 });
  expect(next[0]).toMatchObject({ generation: 2, policy: SECOND.policy });
  expect(await custody.settle(claimed, { outcome: "ack" })).toBe(false);
});

test("Consumer delete tombstones claims while producers and unspent backlog remain", async () => {
  const sql = createEphemeralSql();
  let millis = 200_000;
  const custody = createQueueCustody({
    sql,
    clock: () => new Date(millis),
    randomId: () => "delete-lease",
  });
  const generation = {
    queueId: SOURCE.queueId,
    consumerId: "consumer-delete",
    generation: 1,
    policy: { maxRetries: 2, retryDelaySeconds: 9 },
  } as const;

  await custody.admitBatch(SOURCE, [
    { messageId: "a-in-flight", body: new Uint8Array([1]) },
    { messageId: "b-backlog", body: new Uint8Array([2]) },
  ]);
  await custody.activateConsumer(generation);
  expect(await custody.claim({ ...generation, limit: 1, leaseMillis: 1_000 })).toHaveLength(1);
  expect(await custody.beginRetirement(generation)).toEqual({
    state: "waiting",
    waitUntilMillis: 201_000,
  });
  await custody.admit(SOURCE, { messageId: "accepted-while-retiring", body: new Uint8Array([3]) });

  millis = 201_001;
  expect(await custody.reapRetired(generation)).toEqual({ state: "ready" });
  expect(await custody.finishRetirement(generation)).toEqual({ state: "tombstone" });
  expect(await custody.claim({ ...generation, limit: 3 })).toEqual([]);
  expect(
    await sql.query(
      "SELECT message_id, deliveries, lease_token FROM selfhost_queue_messages WHERE queue_id = ? ORDER BY message_id",
      [SOURCE.queueId],
    ),
  ).toEqual([
    { message_id: "a-in-flight", deliveries: 1, lease_token: null },
    { message_id: "accepted-while-retiring", deliveries: 0, lease_token: null },
    { message_id: "b-backlog", deliveries: 0, lease_token: null },
  ]);
});

test("dead-letter copy and source removal are one fenced settlement", async () => {
  const sql = createEphemeralSql();
  let millis = 300_000;
  const ids = ["settle-lease", "settled-dead-letter"];
  const custody = createQueueCustody({
    sql,
    clock: () => new Date(millis),
    randomId: () => ids.shift() ?? "unused-id",
  });
  await custody.admit(SOURCE, { messageId: "source-message", body: new Uint8Array([9, 8]) });
  await custody.activateConsumer(FIRST);
  const [claimed] = await custody.claim({ ...FIRST, limit: 1 });
  if (!claimed) throw new Error("settlement claim is missing");
  millis = 301_000;
  expect(await custody.settle(claimed, { outcome: "retry" })).toBe(true);
  expect(
    await sql.query(
      "SELECT queue_id, message_id, hex(body) AS body, deliveries FROM selfhost_queue_messages",
    ),
  ).toEqual([
    {
      queue_id: OLD_DLQ.queueId,
      message_id: "settled-dead-letter",
      body: "0908",
      deliveries: 0,
    },
  ]);
  expect(await custody.settle(claimed, { outcome: "retry" })).toBe(false);
});

test("an expired final active lease is recovered instead of stranding its message", async () => {
  const sql = createEphemeralSql();
  let millis = 400_000;
  const ids = ["active-lease", "active-recovered-dead-letter"];
  const custody = createQueueCustody({
    sql,
    clock: () => new Date(millis),
    randomId: () => ids.shift() ?? "unused-id",
  });
  await custody.admit(SOURCE, { messageId: "crashed-final-attempt", body: new Uint8Array([7]) });
  await custody.activateConsumer(FIRST);
  const [claimed] = await custody.claim({ ...FIRST, limit: 1, leaseMillis: 1_000 });
  if (!claimed) throw new Error("active recovery claim is missing");

  millis = 401_001;
  expect(await custody.claim({ ...FIRST, limit: 1 })).toEqual([]);
  expect(
    await sql.query(
      "SELECT queue_id, message_id, hex(body) AS body, deliveries FROM selfhost_queue_messages",
    ),
  ).toEqual([
    {
      queue_id: OLD_DLQ.queueId,
      message_id: "active-recovered-dead-letter",
      body: "07",
      deliveries: 0,
    },
  ]);
  expect(await custody.settle(claimed, { outcome: "ack" })).toBe(false);
});

test("a replacement with a lower retry cap terminalizes over-budget released backlog", async () => {
  const sql = createEphemeralSql();
  let millis = 500_000;
  const ids = ["old-generation-lease", "recovery-lease", "lower-cap-dead-letter"];
  const custody = createQueueCustody({
    sql,
    clock: () => new Date(millis),
    randomId: () => ids.shift() ?? "unused-id",
  });
  const oldGeneration = {
    queueId: SOURCE.queueId,
    consumerId: "consumer-lower-cap",
    generation: 1,
    policy: { maxRetries: 2, retryDelaySeconds: 3 },
  } as const;
  const lowerCap = {
    queueId: SOURCE.queueId,
    consumerId: "consumer-lower-cap",
    generation: 2,
    policy: { maxRetries: 0, retryDelaySeconds: 5, deadLetterQueue: NEW_DLQ },
  } as const;
  await custody.admit(SOURCE, { messageId: "over-new-cap", body: new Uint8Array([6]) });
  await custody.activateConsumer(oldGeneration);
  const [claimed] = await custody.claim({ ...oldGeneration, limit: 1, leaseMillis: 1_000 });
  if (!claimed) throw new Error("lower-cap claim is missing");
  await custody.beginRetirement(oldGeneration);

  millis = 501_001;
  expect(await custody.reapRetired(oldGeneration)).toEqual({ state: "ready" });
  expect(await custody.finishRetirement({ ...oldGeneration, replacement: lowerCap })).toEqual({
    state: "activated",
    generation: 2,
  });
  expect(await custody.claim({ ...lowerCap, limit: 1 })).toEqual([]);
  expect(
    await sql.query(
      "SELECT queue_id, message_id, hex(body) AS body, deliveries FROM selfhost_queue_messages",
    ),
  ).toEqual([
    {
      queue_id: NEW_DLQ.queueId,
      message_id: "lower-cap-dead-letter",
      body: "06",
      deliveries: 0,
    },
  ]);
  expect(await custody.settle(claimed, { outcome: "ack" })).toBe(false);
});

test("readiness fences the generation and schedules visibility, timeout, and a full batch", async () => {
  const sql = createEphemeralSql();
  let millis = 600_000;
  const custody = createQueueCustody({ sql, clock: () => new Date(millis) });
  const generation = {
    queueId: SOURCE.queueId,
    consumerId: "consumer-readiness",
    generation: 1,
    policy: { maxRetries: 2, retryDelaySeconds: 3 },
  } as const;
  await custody.activateConsumer(generation);

  expect(
    await custody.readiness({
      ...generation,
      maxBatchSize: 2,
      maxBatchTimeoutSeconds: 60,
    }),
  ).toEqual({ state: "idle" });
  expect(
    custody.readiness({
      ...generation,
      maxBatchSize: 2,
      maxBatchTimeoutSeconds: 61,
    }),
  ).rejects.toThrow("queue custody readiness batch timeout is invalid");
  await custody.admitBatch(SOURCE, [
    { messageId: "visible-at-ten", body: new Uint8Array([1]), delaySeconds: 10 },
    { messageId: "visible-at-twelve", body: new Uint8Array([2]), delaySeconds: 12 },
  ]);

  expect(
    await custody.readiness({
      ...generation,
      maxBatchSize: 2,
      maxBatchTimeoutSeconds: 5,
    }),
  ).toEqual({ state: "waiting", wakeAtMillis: 612_000 });
  expect(
    await custody.readiness({
      ...generation,
      maxBatchSize: 3,
      maxBatchTimeoutSeconds: 5,
    }),
  ).toEqual({ state: "waiting", wakeAtMillis: 615_000 });
  expect(
    await custody.readiness({
      ...generation,
      maxBatchSize: 3,
      maxBatchTimeoutSeconds: 0,
    }),
  ).toEqual({ state: "waiting", wakeAtMillis: 610_000 });

  millis = 610_000;
  expect(
    await custody.readiness({
      ...generation,
      maxBatchSize: 3,
      maxBatchTimeoutSeconds: 0,
    }),
  ).toEqual({ state: "ready" });
  expect(
    await custody.readiness({
      ...generation,
      consumerId: "stale-consumer",
      maxBatchSize: 3,
      maxBatchTimeoutSeconds: 0,
    }),
  ).toEqual({ state: "inactive" });
});

test("readiness schedules future over-cap recovery after a lower-cap replacement", async () => {
  const sql = createEphemeralSql();
  let millis = 700_000;
  const custody = createQueueCustody({
    sql,
    clock: () => new Date(millis),
    randomId: () => "future-over-cap-lease",
  });
  const oldGeneration = {
    queueId: SOURCE.queueId,
    consumerId: "consumer-future-cap",
    generation: 1,
    policy: { maxRetries: 2, retryDelaySeconds: 1 },
  } as const;
  const lowerCap = {
    queueId: SOURCE.queueId,
    consumerId: "consumer-future-cap",
    generation: 2,
    policy: { maxRetries: 0, retryDelaySeconds: 1 },
  } as const;
  await custody.admit(SOURCE, { messageId: "future-over-cap", body: new Uint8Array([1]) });
  await custody.activateConsumer(oldGeneration);
  const [claimed] = await custody.claim({ ...oldGeneration, limit: 1 });
  if (!claimed) throw new Error("future over-cap claim is missing");
  expect(await custody.settle(claimed, { outcome: "retry", delaySeconds: 10 })).toBe(true);
  expect(await custody.beginRetirement(oldGeneration)).toEqual({ state: "ready" });
  expect(await custody.finishRetirement({ ...oldGeneration, replacement: lowerCap })).toEqual({
    state: "activated",
    generation: 2,
  });

  expect(
    await custody.readiness({
      ...lowerCap,
      maxBatchSize: 1,
      maxBatchTimeoutSeconds: 5,
    }),
  ).toEqual({ state: "waiting", wakeAtMillis: 710_000 });
  millis = 710_000;
  expect(
    await custody.readiness({
      ...lowerCap,
      maxBatchSize: 1,
      maxBatchTimeoutSeconds: 5,
    }),
  ).toEqual({ state: "ready" });
});

test("readiness remains ready while bounded active terminal recovery has more work", async () => {
  const sql = createEphemeralSql();
  let millis = 800_000;
  const custody = createQueueCustody({
    sql,
    clock: () => new Date(millis),
    randomId: () => "bounded-recovery-lease",
  });
  const generation = {
    queueId: SOURCE.queueId,
    consumerId: "consumer-bounded-recovery",
    generation: 1,
    policy: { maxRetries: 0, retryDelaySeconds: 0 },
  } as const;
  await custody.admitBatch(
    SOURCE,
    Array.from({ length: 51 }, (_, index) => ({
      messageId: `terminal-${index.toString().padStart(2, "0")}`,
      body: new Uint8Array([index]),
    })),
  );
  await custody.activateConsumer(generation);
  expect(await custody.claim({ ...generation, limit: 51, leaseMillis: 1_000 })).toHaveLength(51);

  millis = 801_000;
  expect(
    await custody.readiness({
      ...generation,
      maxBatchSize: 100,
      maxBatchTimeoutSeconds: 5,
    }),
  ).toEqual({ state: "ready" });
  expect(await custody.claim({ ...generation, limit: 100 })).toEqual([]);
  expect(
    await custody.readiness({
      ...generation,
      maxBatchSize: 100,
      maxBatchTimeoutSeconds: 5,
    }),
  ).toEqual({ state: "ready" });
  expect(await custody.claim({ ...generation, limit: 100 })).toEqual([]);
  expect(
    await custody.readiness({
      ...generation,
      maxBatchSize: 100,
      maxBatchTimeoutSeconds: 5,
    }),
  ).toEqual({ state: "idle" });
});
