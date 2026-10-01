import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import type {
  SelfhostEventSelection,
  SelfhostEventTarget,
  SelfhostEventTargets,
} from "../src/providers/selfhost.ts";
import { SELFHOST_WORKER_EVENT_PROTOCOL } from "../src/providers/selfhost-events.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createSelfhostQueuePump } from "../src/selfhost-queue-pump.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const STARTED_AT = Date.UTC(2026, 8, 2, 12, 0, 0);
const QUEUE_ID = "queue-durable-reopen";
const CONSUMER_ID = "consumer-durable-reopen";
const MESSAGE_ID = "message-durable-reopen";

function openSqlite(path: string): { readonly database: Database; readonly sql: Sql } {
  const database = new Database(path);
  migrateSqlite(database);
  return { database, sql: createSqliteSql(database) };
}

function pumpTargets(): SelfhostEventTargets {
  const target: SelfhostEventTarget = {
    script: "worker-durable-reopen",
    consumers: [
      {
        queue: QUEUE_ID,
        queueName: "durable-reopen",
        maxBatchSize: 1,
        maxBatchTimeoutSeconds: 0,
        maxConcurrency: 1,
        maxRetries: 2,
        retryDelaySeconds: 9,
      },
    ],
    crons: [],
  };
  const selection: SelfhostEventSelection = {
    versionId: "version-durable-reopen",
    workerVersionUid: "worker-version-durable-reopen",
    eventToken: "event-token-durable-reopen",
    handlers: ["queue"],
  };
  return {
    async list() {
      return [target];
    },
    async select() {
      return selection;
    },
  };
}

function queueRuntime(outcome: "ack" | "retry", attempts: number[]): WorkerdRuntime {
  return {
    async inspectModule(input) {
      return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
    },
    async write() {},
    async remove() {},
    async reload() {},
    async has() {
      return true;
    },
    async probe(_name, _path, init) {
      const event = JSON.parse(init.body ?? "{}") as {
        readonly messages?: readonly { readonly messageId: string; readonly attempts: number }[];
      };
      const messages = event.messages ?? [];
      attempts.push(...messages.map((message) => message.attempts));
      return {
        status: 200,
        body: JSON.stringify({
          protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
          kind: "queue",
          decisions: messages.map((message) => ({
            messageId: message.messageId,
            outcome,
            ...(outcome === "retry" ? { delaySeconds: 5 } : {}),
          })),
        }),
      };
    },
  };
}

test("self-host Queue retry visibility and acknowledged removal survive SQLite close/reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qdr-"));
  const path = join(directory, "queue.sqlite");
  let database: Database | undefined;
  let millis = STARTED_AT;
  const observedAttempts: number[] = [];
  const closeDatabase = () => {
    database?.close();
    database = undefined;
  };

  try {
    const first = openSqlite(path);
    database = first.database;
    await first.sql.run(
      "INSERT INTO selfhost_queue_messages " +
        "(queue_id, message_id, body, enqueued_at_ms, visible_at_ms, expires_at_ms, deliveries) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0)",
      [QUEUE_ID, MESSAGE_ID, new Uint8Array([1, 2, 3]).buffer, millis, millis, millis + 3_600_000],
    );
    const firstPump = createSelfhostQueuePump({
      sql: first.sql,
      runtime: queueRuntime("retry", observedAttempts),
      targets: pumpTargets(),
      clock: () => new Date(millis),
    });

    expect(await firstPump.tick()).toBe(1);
    expect(observedAttempts).toEqual([1]);
    expect(
      await first.sql.query(
        "SELECT deliveries, visible_at_ms, lease_token FROM selfhost_queue_messages " +
          "WHERE queue_id = ? AND message_id = ?",
        [QUEUE_ID, MESSAGE_ID],
      ),
    ).toEqual([{ deliveries: 1, visible_at_ms: millis + 5_000, lease_token: null }]);

    // This is a file close/reopen seam, not an OS-process crash simulation.
    closeDatabase();
    millis += 4_999;
    const second = openSqlite(path);
    database = second.database;
    const secondPump = createSelfhostQueuePump({
      sql: second.sql,
      runtime: queueRuntime("ack", observedAttempts),
      targets: pumpTargets(),
      clock: () => new Date(millis),
    });
    expect(await secondPump.tick()).toBe(0);
    expect(observedAttempts).toEqual([1]);

    millis += 1;
    expect(await secondPump.tick()).toBe(1);
    expect(observedAttempts).toEqual([1, 2]);
    expect(
      await second.sql.query("SELECT message_id FROM selfhost_queue_messages WHERE queue_id = ?", [
        QUEUE_ID,
      ]),
    ).toEqual([]);

    closeDatabase();
    const third = openSqlite(path);
    database = third.database;
    const recoveredPump = createSelfhostQueuePump({
      sql: third.sql,
      runtime: queueRuntime("ack", observedAttempts),
      targets: pumpTargets(),
      clock: () => new Date(millis),
    });
    expect(await recoveredPump.tick()).toBe(0);
    expect(observedAttempts).toEqual([1, 2]);
  } finally {
    closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Queue custody restores an unacknowledged lease and keeps an acknowledged message settled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qdr-"));
  const path = join(directory, "custody.sqlite");
  let database: Database | undefined;
  let millis = STARTED_AT;
  const generation = {
    queueId: QUEUE_ID,
    consumerId: CONSUMER_ID,
    generation: 1,
    policy: { maxRetries: 2, retryDelaySeconds: 9 },
  } as const;
  const closeDatabase = () => {
    database?.close();
    database = undefined;
  };

  try {
    const first = openSqlite(path);
    database = first.database;
    const firstCustody = createQueueCustody({
      sql: first.sql,
      clock: () => new Date(millis),
      randomId: () => "lease-before-reopen",
    });
    await firstCustody.admit(
      { queueId: QUEUE_ID, messageRetentionSeconds: 3_600, deliveryDelaySeconds: 0 },
      { messageId: MESSAGE_ID, body: new Uint8Array([4, 5, 6]) },
    );
    await firstCustody.activateConsumer(generation);
    const [inFlight] = await firstCustody.claim({
      ...generation,
      limit: 1,
      leaseMillis: 1_000,
    });
    expect(inFlight).toMatchObject({ messageId: MESSAGE_ID, attempts: 1 });
    if (!inFlight) throw new Error("Queue custody lease was not created");

    closeDatabase();
    const second = openSqlite(path);
    database = second.database;
    const secondCustody = createQueueCustody({
      sql: second.sql,
      clock: () => new Date(millis),
      randomId: () => "lease-after-reopen",
    });
    expect(await secondCustody.claim({ ...generation, limit: 1, leaseMillis: 1_000 })).toEqual([]);

    millis += 1_001;
    expect(await secondCustody.claim({ ...generation, limit: 1, leaseMillis: 1_000 })).toEqual([]);
    expect(
      await second.sql.query(
        "SELECT deliveries, visible_at_ms, lease_token FROM selfhost_queue_messages " +
          "WHERE queue_id = ? AND message_id = ?",
        [QUEUE_ID, MESSAGE_ID],
      ),
    ).toEqual([{ deliveries: 1, visible_at_ms: STARTED_AT + 10_000, lease_token: null }]);

    closeDatabase();
    const third = openSqlite(path);
    database = third.database;
    const thirdCustody = createQueueCustody({
      sql: third.sql,
      clock: () => new Date(millis),
      randomId: () => "lease-after-visibility-reopen",
    });
    expect(await thirdCustody.claim({ ...generation, limit: 1, leaseMillis: 1_000 })).toEqual([]);

    millis = STARTED_AT + 10_000;
    const [redelivered] = await thirdCustody.claim({
      ...generation,
      limit: 1,
      leaseMillis: 1_000,
    });
    expect(redelivered).toMatchObject({
      messageId: MESSAGE_ID,
      attempts: 2,
      consumerId: CONSUMER_ID,
      generation: 1,
    });
    if (!redelivered) throw new Error("expired Queue custody lease was not recovered");
    expect(await thirdCustody.settle(redelivered, { outcome: "ack" })).toBe(true);

    closeDatabase();
    const fourth = openSqlite(path);
    database = fourth.database;
    const recoveredCustody = createQueueCustody({
      sql: fourth.sql,
      clock: () => new Date(millis),
    });
    expect(await recoveredCustody.claim({ ...generation, limit: 1, leaseMillis: 1_000 })).toEqual(
      [],
    );
    expect(
      await fourth.sql.query("SELECT message_id FROM selfhost_queue_messages WHERE queue_id = ?", [
        QUEUE_ID,
      ]),
    ).toEqual([]);
  } finally {
    closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  }
});
