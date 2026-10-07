import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { JsonObject } from "../src/ports.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createSelfhostV2QueueScheduler } from "../src/selfhost-v2-queue-scheduler.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
import { MODULE_WORKER_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";
import type { V2WorkerCurrentServingResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { createAtLeastOnceQueueForm } from "../src/takoform-v2/worker-queue-backend.ts";
import { createQueueConsumerForm } from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import { v2QueueId } from "../src/takoform-v2/worker-queue-delivery.ts";

const principal = "queue-scheduler-principal";
const space = "default";
const targetKey = "queue-scheduler-target";

function consumerSpec(
  queueUid: string,
  workerUid: string,
  extras: Record<string, unknown> = {},
): JsonObject {
  return {
    queue: { resourceUid: queueUid },
    worker: { resourceUid: workerUid },
    maxBatchSize: 10,
    maxBatchTimeoutSeconds: 0,
    maxConcurrency: 1,
    maxRetries: 1,
    retryDelaySeconds: 1,
    ...extras,
  };
}

async function acceptedConsumer(database: Database) {
  const sql = createSqliteSql(database);
  const worker: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "scheduler-test-worker",
      targetKey,
      async execute() {
        return { kind: "complete", observed: { ready: true }, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const capability = {
    async observeCurrentServing({ workerUid }: { workerUid: string }) {
      return {
        kind: "ready",
        sourceOperationId: "scheduler-test-source",
        snapshot: {
          sourceOperationId: "scheduler-test-source",
          worker: { uid: workerUid, principal, space, generation: 1 },
          deployment: {
            uid: "scheduler-test-deployment",
            generation: 1,
            spec: {},
            versions: [
              {
                uid: "scheduler-test-version",
                generation: 1,
                weight: 10_000,
                spec: { handlers: ["queue"] },
              },
            ],
          },
          endpoint: null,
        },
        async stillCurrent() {
          return true;
        },
      } as unknown as V2WorkerCurrentServingResolution;
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(),
    replayWindowSeconds: 3_600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [AT_LEAST_ONCE_QUEUE_FORM_URL]: createAtLeastOnceQueueForm({ sql, targetKey }),
      [MODULE_WORKER_FORM_URL]: worker,
      [QUEUE_CONSUMER_FORM_URL]: createQueueConsumerForm({ sql, targetKey, capability }),
    },
  });
  const create = async (form: string, name: string, spec: JsonObject) => {
    const accepted = await engine.acceptCreate({
      principal,
      key: `queue-scheduler-${name}-create-key-00000001`,
      input: { form, space, name, spec },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    return accepted.resourceUid;
  };
  const queueUid = await create(AT_LEAST_ONCE_QUEUE_FORM_URL, "queue", {
    messageRetentionSeconds: 3_600,
  });
  const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
  const consumerUid = await create(
    QUEUE_CONSUMER_FORM_URL,
    "consumer",
    consumerSpec(queueUid, workerUid),
  );
  return { sql, engine, queueUid, workerUid, consumerUid, create };
}

test("accepted active Consumer is rediscovered from durable SQL after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-queue-scheduler-"));
  const path = join(root, "state.sqlite");
  let database = new Database(path);
  try {
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    const accepted = await acceptedConsumer(database);
    const visited: string[] = [];
    const composition = {
      async deliverOnce(input: { consumerUid: string }) {
        visited.push(input.consumerUid);
        return { kind: "idle" as const };
      },
    };
    const first = createSelfhostV2QueueScheduler({
      sql: accepted.sql,
      custody: createQueueCustody({ sql: accepted.sql }),
      composition,
    });
    await first.tick();
    expect(visited).toEqual([accepted.consumerUid]);
    await first.close();
    database.close();
    database = new Database(path);
    const sql = createSqliteSql(database);
    const restarted = createSelfhostV2QueueScheduler({
      sql,
      custody: createQueueCustody({ sql }),
      composition,
    });
    await restarted.tick();
    expect(visited).toEqual([accepted.consumerUid, accepted.consumerUid]);
    await restarted.close();
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping ticks share one pass and close waits for its delivery", async () => {
  const database = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    const accepted = await acceptedConsumer(database);
    let entered = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = createSelfhostV2QueueScheduler({
      sql: accepted.sql,
      custody: createQueueCustody({ sql: accepted.sql }),
      composition: {
        async deliverOnce() {
          entered += 1;
          await blocked;
          return { kind: "idle" as const };
        },
      },
    });
    const first = scheduler.tick();
    const second = scheduler.tick();
    expect(second).toBe(first);
    for (let attempt = 0; attempt < 20 && entered === 0; attempt += 1) await Bun.sleep(1);
    expect(entered).toBe(1);
    const close = scheduler.close();
    const secondClose = scheduler.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    let secondClosed = false;
    void secondClose.then(() => {
      secondClosed = true;
    });
    await Bun.sleep(1);
    expect(closed).toBe(false);
    expect(secondClosed).toBe(false);
    release();
    await close;
    await secondClose;
    expect(await first).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    expect(entered).toBe(1);
  } finally {
    database.close();
  }
});

test("dead-letter notice stays pending without a verified active target wake, then ACKs exact token", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-queue-notice-"));
  const path = join(root, "state.sqlite");
  let database = new Database(path);
  try {
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    const accepted = await acceptedConsumer(database);
    const sourceQueueUid = await accepted.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "source-queue", {
      messageRetentionSeconds: 3_600,
    });
    const sourceConsumerUid = await accepted.create(
      QUEUE_CONSUMER_FORM_URL,
      "source-consumer",
      consumerSpec(sourceQueueUid, accepted.workerUid, {
        maxRetries: 0,
        retryDelaySeconds: 0,
        deadLetterQueue: { resourceUid: accepted.queueUid },
      }),
    );
    const source = {
      queueId: v2QueueId(sourceQueueUid),
      consumerId: sourceConsumerUid,
      generation: 1,
      policy: {
        maxRetries: 0,
        retryDelaySeconds: 0,
        deadLetterQueue: {
          queueId: v2QueueId(accepted.queueUid),
          messageRetentionSeconds: 3_600,
          deliveryDelaySeconds: 0,
        },
      },
    };
    const custody = createQueueCustody({
      sql: accepted.sql,
      randomId: () => "scheduler-dead-letter-message",
    });
    await custody.admit(
      { queueId: source.queueId, messageRetentionSeconds: 3_600, deliveryDelaySeconds: 0 },
      { messageId: "source-message", body: new Uint8Array([7]) },
    );
    const [claimed] = await custody.claim({ ...source, limit: 1 });
    if (!claimed) throw new Error("source claim is missing");
    expect(await custody.settle(claimed, { outcome: "retry" })).toBe(true);
    expect((await custody.listTransferNotices(source)).length).toBe(1);

    let available = true;
    const scheduler = createSelfhostV2QueueScheduler({
      sql: accepted.sql,
      custody,
      composition: {
        async deliverOnce() {
          if (!available) throw new Error("native owner is unavailable");
          return { kind: "idle" as const };
        },
      },
      pollMillis: 60_000,
    });
    // A copied target row alone, without a running wake path, is not an ACK.
    await scheduler.tick();
    expect((await custody.listTransferNotices(source)).length).toBe(1);
    available = false;
    scheduler.start();
    await scheduler.tick();
    expect((await custody.listTransferNotices(source)).length).toBe(1);
    available = true;
    await accepted.engine.acceptUpdate({
      principal,
      key: "scheduler-target-update-key-00000001",
      uid: accepted.consumerUid,
      expectedGeneration: 1,
      spec: consumerSpec(accepted.queueUid, accepted.workerUid),
    });
    await scheduler.tick();
    expect((await custody.listTransferNotices(source)).length).toBe(1);
    expect((await accepted.engine.runNext())?.status).toBe("succeeded");
    await scheduler.close();
    database.close();

    database = new Database(path);
    const sql = createSqliteSql(database);
    const restartedCustody = createQueueCustody({ sql });
    const restarted = createSelfhostV2QueueScheduler({
      sql,
      custody: restartedCustody,
      composition: {
        async deliverOnce() {
          return { kind: "idle" as const };
        },
      },
      pollMillis: 60_000,
    });
    expect((await restartedCustody.listTransferNotices(source)).length).toBe(1);
    restarted.start();
    await restarted.tick();
    expect(await restartedCustody.listTransferNotices(source)).toEqual([]);
    await restarted.close();
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
