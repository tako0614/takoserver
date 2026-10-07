import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql } from "../src/ports.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2WorkerQueueSettlement } from "../src/takoform-v2/worker-queue-settlement.ts";

const queue = { queueId: "queue-one", messageRetentionSeconds: 3600, deliveryDelaySeconds: 0 };
const consumer = {
  queueId: queue.queueId,
  consumerId: "consumer-one",
  generation: 1,
  policy: { maxRetries: 2, retryDelaySeconds: 7 },
} as const;

test("settles each exact claimed message durably before its Promise resolves", async () => {
  const sql = createEphemeralSql();
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(consumer);
  await custody.admitBatch(queue, [
    { messageId: "one", body: new Uint8Array([1]) },
    { messageId: "two", body: new Uint8Array([2]) },
  ]);
  const claims = await custody.claim({ ...consumer, limit: 2 });
  const bridge = createV2WorkerQueueSettlement({ custody });
  const batch = await bridge.open({ batchId: "batch-one", queue: "orders", messages: claims });
  expect(batch.queue).toBe("orders");
  expect(Object.keys(batch.messages[0] ?? {})).toEqual([
    "id",
    "timestampMillis",
    "body",
    "attempts",
  ]);
  expect(batch.messages.map(({ id }) => id)).toEqual(["one", "two"]);
  await batch.acknowledge("one");
  await batch.retryAll(0);
  expect(await bridge.observe({ batchId: "batch-one", ...consumer })).toEqual([
    { messageId: "one", state: "settled", outcome: "ack", delaySeconds: null },
    { messageId: "two", state: "settled", outcome: "retry", delaySeconds: 0 },
  ]);
  expect(await custody.claim({ ...consumer, limit: 2 })).toMatchObject([
    { messageId: "two", attempts: 2 },
  ]);
});

test("snapshots the batch identity before awaiting durable registration", async () => {
  const durable = createEphemeralSql();
  let entered!: () => void;
  let release!: () => void;
  const enteredBatch = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const allowBatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sql: Sql = {
    query: (statement, params) => durable.query(statement, params),
    run: (statement, params) => durable.run(statement, params),
    async batch(statements) {
      if (
        statements.some(({ sql: statement }) =>
          statement.includes("INSERT INTO queue_v2_batch_settlements"),
        )
      ) {
        entered();
        await allowBatch;
      }
      return await durable.batch(statements);
    },
  };
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(consumer);
  await custody.admit(queue, { messageId: "one", body: new Uint8Array([1]) });
  const claims = await custody.claim({ ...consumer, limit: 1 });
  const bridge = createV2WorkerQueueSettlement({ custody });
  const input = { batchId: "batch-original", queue: "orders", messages: claims };
  const opening = bridge.open(input);
  try {
    await enteredBatch;
    input.batchId = "batch-mutated";
    input.queue = "changed";
  } finally {
    release();
  }
  const batch = await opening;
  expect(batch.batchId).toBe("batch-original");
  expect(batch.queue).toBe("orders");
  await batch.acknowledge("one");
  expect(await bridge.observe({ batchId: "batch-original", ...consumer })).toMatchObject([
    { state: "settled", outcome: "ack" },
  ]);
});

test("handler throw retries only unsettled messages and preserves an acknowledged message", async () => {
  const sql = createEphemeralSql();
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(consumer);
  await custody.admitBatch(queue, [
    { messageId: "one", body: new Uint8Array([1]) },
    { messageId: "two", body: new Uint8Array([2]) },
  ]);
  const claims = await custody.claim({ ...consumer, limit: 2 });
  const bridge = createV2WorkerQueueSettlement({ custody });
  const result = await bridge.invoke({
    batchId: "batch-throw",
    queue: "orders",
    messages: claims,
    async handler(batch) {
      await batch.acknowledge("one");
      throw new Error("handler failed");
    },
  });
  expect(result).toBe("rejected");
  expect(await bridge.observe({ batchId: "batch-throw", ...consumer })).toMatchObject([
    { messageId: "one", state: "settled", outcome: "ack" },
    { messageId: "two", state: "settled", outcome: "retry", delaySeconds: 7 },
  ]);
});

test("batch registration refuses forged scope, stale lease, and reused batch identity", async () => {
  const sql = createEphemeralSql();
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(consumer);
  await custody.admit(queue, { messageId: "one", body: new Uint8Array([1]) });
  const [claimed] = await custody.claim({ ...consumer, limit: 1 });
  if (!claimed) throw new Error("missing claim");
  const bridge = createV2WorkerQueueSettlement({ custody });
  await expect(
    bridge.open({
      batchId: "forged",
      queue: "orders",
      messages: [{ ...claimed, consumerId: "other-consumer" }],
    }),
  ).rejects.toMatchObject({ name: "backend_unavailable" });
  expect(await sql.query("SELECT batch_id FROM queue_v2_batch_settlements")).toEqual([]);
  const batch = await bridge.open({ batchId: "real", queue: "orders", messages: [claimed] });
  await expect(
    bridge.open({ batchId: "other-batch", queue: "orders", messages: [claimed] }),
  ).rejects.toMatchObject({
    name: "backend_unavailable",
  });
  await expect(
    bridge.observe({ batchId: "real", ...consumer, consumerId: "other-consumer" }),
  ).rejects.toMatchObject({ name: "unknown_batch" });
  await batch.acknowledge("one");
  await expect(
    sql.run("UPDATE queue_v2_batch_settlements SET outcome = 'retry' WHERE batch_id = 'real'"),
  ).rejects.toThrow();
  await custody.admit(queue, { messageId: "two", body: new Uint8Array([2]) });
  const [stale] = await custody.claim({ ...consumer, limit: 1 });
  if (!stale) throw new Error("missing second claim");
  await sql.run(
    "UPDATE selfhost_queue_messages SET lease_expires_at_ms = ? WHERE queue_id = ? AND message_id = ?",
    [Date.now() - 1, queue.queueId, stale.messageId],
  );
  await expect(
    bridge.open({ batchId: "expired", queue: "orders", messages: [stale] }),
  ).rejects.toMatchObject({
    name: "backend_unavailable",
  });
});

test("normal handler return acknowledges every remaining message", async () => {
  const sql = createEphemeralSql();
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(consumer);
  await custody.admit(queue, { messageId: "one", body: new Uint8Array([5]) });
  const claims = await custody.claim({ ...consumer, limit: 1 });
  const bridge = createV2WorkerQueueSettlement({ custody });
  expect(
    await bridge.invoke({
      batchId: "normal",
      queue: "orders",
      messages: claims,
      handler(batch) {
        expect(batch.messages[0]?.body).toEqual(new Uint8Array([5]));
      },
    }),
  ).toBe("resolved");
  expect(await bridge.observe({ batchId: "normal", ...consumer })).toMatchObject([
    { state: "settled", outcome: "ack" },
  ]);
});

test("acknowledge Promise remains pending until the atomic custody batch commits", async () => {
  const durable = createEphemeralSql();
  let entered!: () => void;
  let release!: () => void;
  const enteredBatch = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const allowBatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sql: Sql = {
    query: (statement, params) => durable.query(statement, params),
    run: (statement, params) => durable.run(statement, params),
    async batch(statements) {
      if (statements.some(({ sql: statement }) => statement.includes("SET state = 'settling'"))) {
        entered();
        await allowBatch;
      }
      return await durable.batch(statements);
    },
  };
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(consumer);
  await custody.admit(queue, { messageId: "one", body: new Uint8Array([1]) });
  const claims = await custody.claim({ ...consumer, limit: 1 });
  const bridge = createV2WorkerQueueSettlement({ custody });
  const batch = await bridge.open({ batchId: "batch-await", queue: "orders", messages: claims });
  let resolved = false;
  const acknowledgement = batch.acknowledge("one").then(() => {
    resolved = true;
  });
  try {
    await enteredBatch;
    expect(resolved).toBe(false);
    expect(
      await durable.query("SELECT message_id FROM selfhost_queue_messages WHERE queue_id = ?", [
        queue.queueId,
      ]),
    ).toHaveLength(1);
    expect(await bridge.observe({ batchId: "batch-await", ...consumer })).toMatchObject([
      { state: "pending" },
    ]);
  } finally {
    release();
  }
  await acknowledgement;
  expect(resolved).toBe(true);
  expect(
    await durable.query("SELECT message_id FROM selfhost_queue_messages WHERE queue_id = ?", [
      queue.queueId,
    ]),
  ).toEqual([]);
});

test("concurrent conflicting settlement has one durable winner and exact Error.name", async () => {
  const sql = createEphemeralSql();
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(consumer);
  await custody.admit(queue, { messageId: "one", body: new Uint8Array([1]) });
  const claims = await custody.claim({ ...consumer, limit: 1 });
  const bridge = createV2WorkerQueueSettlement({ custody });
  const batch = await bridge.open({ batchId: "batch-race", queue: "orders", messages: claims });
  const outcomes = await Promise.allSettled([batch.acknowledge("one"), batch.retry("one", 0)]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  const rejected = outcomes.find(({ status }) => status === "rejected");
  expect(rejected?.status === "rejected" ? rejected.reason.name : null).toBe("already_settled");
  await expect(batch.acknowledge("one")).rejects.toMatchObject({ name: "already_settled" });
  await expect(batch.retry("foreign")).rejects.toMatchObject({ name: "unknown_message" });
  await expect(bridge.observe({ batchId: "missing", ...consumer })).rejects.toMatchObject({
    name: "unknown_batch",
  });
});

test("expired and reclaimed exact leases cannot settle their successor", async () => {
  const sql = createEphemeralSql();
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(consumer);
  await custody.admit(queue, { messageId: "one", body: new Uint8Array([1]) });
  const [first] = await custody.claim({ ...consumer, limit: 1, leaseMillis: 1000 });
  if (!first) throw new Error("missing first claim");
  const bridge = createV2WorkerQueueSettlement({ custody });
  const firstBatch = await bridge.open({
    batchId: "batch-first",
    queue: "orders",
    messages: [first],
  });
  await sql.run(
    "UPDATE selfhost_queue_messages SET lease_expires_at_ms = ? WHERE queue_id = ? AND message_id = ?",
    [Date.now() - 1, queue.queueId, first.messageId],
  );
  await expect(firstBatch.acknowledge("one")).rejects.toMatchObject({
    name: "backend_unavailable",
  });
  expect(await bridge.observe({ batchId: "batch-first", ...consumer })).toMatchObject([
    { state: "pending", outcome: null },
  ]);

  // A new exact lease is the only valid authority to settle the message.
  expect(await custody.release(first)).toBe(true);
  const [second] = await custody.claim({ ...consumer, limit: 1 });
  if (!second) throw new Error("missing successor claim");
  expect(second.leaseToken).not.toBe(first.leaseToken);
  const secondBatch = await bridge.open({
    batchId: "batch-second",
    queue: "orders",
    messages: [second],
  });
  await expect(firstBatch.retry("one", 0)).rejects.toMatchObject({
    name: "backend_unavailable",
  });
  await secondBatch.acknowledge("one");
  expect(await bridge.observe({ batchId: "batch-second", ...consumer })).toMatchObject([
    { state: "settled", outcome: "ack" },
  ]);
});

test("lost SQL acknowledgement is read back by exact call token and retained across SQLite reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takos-v2-queue-settle-"));
  let database: Database | undefined;
  try {
    const path = join(directory, "state.sqlite");
    database = new Database(path);
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    const durableSql = createSqliteSql(database);
    let loseAck = false;
    const sql: Sql = {
      query: (statement, params) => durableSql.query(statement, params),
      run: (statement, params) => durableSql.run(statement, params),
      async batch(statements) {
        const result = await durableSql.batch(statements);
        if (
          loseAck &&
          statements.some(({ sql: statement }) => statement.includes("SET state = 'settling'"))
        ) {
          loseAck = false;
          throw new Error("transport lost settlement acknowledgement after commit");
        }
        return result;
      },
    };
    const custody = createQueueCustody({ sql });
    await custody.activateConsumer(consumer);
    await custody.admit(queue, { messageId: "one", body: new Uint8Array([1]) });
    const claims = await custody.claim({ ...consumer, limit: 1 });
    const bridge = createV2WorkerQueueSettlement({ custody });
    const batch = await bridge.open({
      batchId: "batch-lost-ack",
      queue: "orders",
      messages: claims,
    });
    loseAck = true;
    await batch.acknowledge("one");
    database.close();
    database = new Database(path);
    const reopenedSql = createSqliteSql(database);
    const reopened = createV2WorkerQueueSettlement({
      custody: createQueueCustody({ sql: reopenedSql }),
    });
    expect(await reopened.observe({ batchId: "batch-lost-ack", ...consumer })).toEqual([
      { messageId: "one", state: "settled", outcome: "ack", delaySeconds: null },
    ]);
    expect(
      await reopenedSql.query("SELECT message_id FROM selfhost_queue_messages WHERE queue_id = ?", [
        queue.queueId,
      ]),
    ).toEqual([]);
    const replay = await reopened.open({
      batchId: "batch-lost-ack",
      queue: "orders",
      messages: claims,
    });
    await expect(replay.acknowledge("one")).rejects.toMatchObject({ name: "already_settled" });
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal retry transfers exact message and retains a settled receipt", async () => {
  const sql = createEphemeralSql();
  const custody = createQueueCustody({ sql });
  const deadLetterConsumer = {
    ...consumer,
    policy: {
      maxRetries: 0,
      retryDelaySeconds: 7,
      deadLetterQueue: {
        queueId: "dead-letter",
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
    },
  } as const;
  await custody.activateConsumer(deadLetterConsumer);
  await custody.admit(queue, { messageId: "one", body: new Uint8Array([9]) });
  const claims = await custody.claim({ ...deadLetterConsumer, limit: 1 });
  const bridge = createV2WorkerQueueSettlement({ custody, randomId: () => "settle-one" });
  const batch = await bridge.open({ batchId: "batch-terminal", queue: "orders", messages: claims });
  await batch.retry("one", 0);
  expect(await bridge.observe({ batchId: "batch-terminal", ...deadLetterConsumer })).toMatchObject([
    { state: "settled", outcome: "retry", delaySeconds: 0 },
  ]);
  expect(
    await sql.query(
      "SELECT message_id, body FROM selfhost_queue_messages WHERE queue_id = 'dead-letter'",
    ),
  ).toHaveLength(1);
  expect(await custody.listTransferNotices(deadLetterConsumer)).toMatchObject([
    { targetQueueId: "dead-letter" },
  ]);
  await expect(batch.retryAll(43_201)).rejects.toBeInstanceOf(TypeError);
});
