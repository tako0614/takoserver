import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

test("trusted transport reopens exact registered claim without caller-held body or policy", async () => {
  const sql = createEphemeralSql();
  const queue = { queueId: "v2-queue", messageRetentionSeconds: 3600, deliveryDelaySeconds: 0 };
  const generation = {
    queueId: queue.queueId,
    consumerId: "consumer-uid",
    generation: 1,
    policy: { maxRetries: 2, retryDelaySeconds: 5 },
  };
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(generation);
  await custody.admit(queue, { messageId: "message-1", body: new Uint8Array([1, 2]) });
  const [claim] = await custody.claim({ ...generation, limit: 1 });
  if (!claim) throw new Error("claim missing");
  await custody.registerSettlementBatch("batch-1", [claim]);
  const input = {
    batchId: "batch-1",
    messageId: claim.messageId,
    expected: {
      queueId: claim.queueId,
      consumerId: claim.consumerId,
      generation: claim.generation,
      leaseToken: claim.leaseToken,
    },
    decision: { outcome: "ack" as const },
    settlementToken: "call-1",
  };
  expect(await custody.settleRegisteredBatchMessage(input)).toBe("settled");
  expect(await createQueueCustody({ sql }).settleRegisteredBatchMessage(input)).toBe("settled");
  expect(await custody.settleRegisteredBatchMessage({ ...input, settlementToken: "call-2" })).toBe(
    "already_settled",
  );
  expect(
    await custody.settleRegisteredBatchMessage({
      ...input,
      expected: { ...input.expected, consumerId: "other" },
    }),
  ).toBe("unknown_message");
  expect(
    await sql.query("SELECT 1 FROM selfhost_queue_messages WHERE queue_id = ?", [queue.queueId]),
  ).toEqual([]);
});

test("D1-shaped BLOB arrays reject lossy or coercible message bytes", async () => {
  const sql = createEphemeralSql();
  const queue = { queueId: "strict-queue", messageRetentionSeconds: 3600, deliveryDelaySeconds: 0 };
  const generation = {
    queueId: queue.queueId,
    consumerId: "strict-consumer",
    generation: 1,
    policy: { maxRetries: 1, retryDelaySeconds: 0 },
  };
  const custody = createQueueCustody({ sql });
  await custody.activateConsumer(generation);
  await custody.admit(queue, { messageId: "strict-message", body: new Uint8Array([9]) });
  for (const invalid of [[256], [-1], [1.5], ["9"]]) {
    const corruptingSql = {
      ...sql,
      async query(statement: string, params?: Parameters<typeof sql.query>[1]) {
        const rows = await sql.query(statement, params);
        return statement.includes("SELECT message_id, body FROM selfhost_queue_messages")
          ? rows.map((row) => ({ ...row, body: invalid }))
          : rows;
      },
    };
    await expect(
      createQueueCustody({ sql: corruptingSql }).claim({ ...generation, limit: 1 }),
    ).rejects.toThrow("message body is invalid");
  }
  expect(await sql.query("SELECT lease_token FROM selfhost_queue_messages")).toEqual([
    { lease_token: null },
  ]);
});

test("registered pending batch and terminal ACK survive real SQLite handle reopen", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "v2-queue-reopen-"));
  const path = join(root, "queue.sqlite");
  let database = new Database(path);
  try {
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    let sql = createSqliteSql(database);
    const queue = {
      queueId: "reopen-queue",
      messageRetentionSeconds: 3600,
      deliveryDelaySeconds: 0,
    };
    const generation = {
      queueId: queue.queueId,
      consumerId: "consumer-uid",
      generation: 1,
      policy: { maxRetries: 1, retryDelaySeconds: 0 },
    };
    let custody = createQueueCustody({ sql });
    await custody.activateConsumer(generation);
    await custody.admit(queue, { messageId: "message-1", body: new Uint8Array([5]) });
    const [claim] = await custody.claim({ ...generation, limit: 1 });
    if (!claim) throw new Error("claim missing");
    await custody.registerSettlementBatch("reopen-batch", [claim]);
    database.close();
    database = new Database(path);
    sql = createSqliteSql(database);
    custody = createQueueCustody({ sql });
    const settle = {
      batchId: "reopen-batch",
      messageId: claim.messageId,
      expected: {
        queueId: claim.queueId,
        consumerId: claim.consumerId,
        generation: claim.generation,
        leaseToken: claim.leaseToken,
      },
      decision: { outcome: "ack" as const },
      settlementToken: "reopen-settlement",
    };
    expect(await custody.settleRegisteredBatchMessage(settle)).toBe("settled");
    database.close();
    database = new Database(path);
    sql = createSqliteSql(database);
    custody = createQueueCustody({ sql });
    expect(await custody.settleRegisteredBatchMessage(settle)).toBe("settled");
    expect(
      await custody.settleRegisteredBatchMessage({ ...settle, settlementToken: "other" }),
    ).toBe("already_settled");
    expect(
      await sql.query("SELECT 1 FROM selfhost_queue_messages WHERE queue_id = ?", [queue.queueId]),
    ).toEqual([]);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
