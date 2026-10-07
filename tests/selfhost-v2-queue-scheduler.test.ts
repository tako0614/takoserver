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
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";
import type { V2WorkerCurrentServingResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { createAtLeastOnceQueueForm } from "../src/takoform-v2/worker-queue-backend.ts";
import { createQueueConsumerForm } from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import {
  authorizeV2QueueBatchSend,
  createV2QueueDelivery,
  v2QueueId,
} from "../src/takoform-v2/worker-queue-delivery.ts";

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
  let servingSourceOperationId = "unassigned-source";
  let selectedVersionUid = "unassigned-version";
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
        sourceOperationId: servingSourceOperationId,
        snapshot: {
          sourceOperationId: servingSourceOperationId,
          worker: { uid: workerUid, principal, space, generation: 1 },
          deployment: {
            uid: "scheduler-test-deployment",
            generation: 1,
            spec: {},
            versions: [
              {
                uid: selectedVersionUid,
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
      [WORKER_VERSION_FORM_URL]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "scheduler-test-version",
          targetKey,
          async execute() {
            return { kind: "complete", observed: { ready: true }, output: {} };
          },
          async reconcile() {
            return { kind: "unknown" };
          },
        },
      },
      [WORKER_DEPLOYMENT_FORM_URL]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "scheduler-test-deployment",
          targetKey,
          async execute() {
            return { kind: "complete", observed: { active: true }, output: {} };
          },
          async reconcile() {
            return { kind: "unknown" };
          },
        },
      },
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
  selectedVersionUid = await create(WORKER_VERSION_FORM_URL, "version", {
    worker: { resourceUid: workerUid },
  });
  const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
    worker: { resourceUid: workerUid },
  });
  const [deployment] = await sql.query("SELECT last_operation FROM tf_v2_resources WHERE uid = ?", [
    deploymentUid,
  ]);
  if (typeof deployment?.last_operation !== "string") throw new Error("Deployment not settled");
  servingSourceOperationId = deployment.last_operation;
  const consumerUid = await create(
    QUEUE_CONSUMER_FORM_URL,
    "consumer",
    consumerSpec(queueUid, workerUid),
  );
  return {
    sql,
    engine,
    capability,
    queueUid,
    workerUid,
    versionUid: selectedVersionUid,
    servingSourceOperationId,
    consumerUid,
    create,
  };
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

test("a persisted send-authorized slot prevents a second send after SQL handle restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-queue-authorized-restart-"));
  const path = join(root, "state.sqlite");
  let database = new Database(path);
  try {
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    const accepted = await acceptedConsumer(database);
    const custody = createQueueCustody({ sql: accepted.sql });
    await custody.admit(
      {
        queueId: v2QueueId(accepted.queueUid),
        messageRetentionSeconds: 3_600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "authorized-before-restart", body: new Uint8Array([1]) },
    );
    const selected = await createV2QueueDelivery({
      sql: accepted.sql,
      custody,
      capability: accepted.capability,
    }).claimRegisteredBatch({ consumerUid: accepted.consumerUid, principal, space, targetKey });
    expect(selected.kind).toBe("ready");
    if (selected.kind !== "ready") throw new Error("batch not registered");
    const execution = {
      batchId: selected.batchId,
      reservationToken: selected.reservationToken,
      queueUid: accepted.queueUid,
      consumerUid: accepted.consumerUid,
      generation: selected.generation,
      workerUid: accepted.workerUid,
      servingSourceOperationId: accepted.servingSourceOperationId,
      workerVersionUid: accepted.versionUid,
      workerVersionGeneration: 1,
      incarnationOperationId: "scheduler-test-incarnation",
    };
    expect(await authorizeV2QueueBatchSend(accepted.sql, execution)).toBe("authorized");
    database.close();

    database = new Database(path);
    const sql = createSqliteSql(database);
    const seen: string[] = [];
    const restarted = createSelfhostV2QueueScheduler({
      sql,
      custody: createQueueCustody({ sql }),
      composition: {
        async deliverOnce(input) {
          seen.push(input.consumerUid);
          const result = await createV2QueueDelivery({
            sql,
            custody: createQueueCustody({ sql }),
            capability: accepted.capability,
          }).claimRegisteredBatch(input);
          return { kind: result.kind === "ready" ? "unknown" : result.kind };
        },
      },
    });
    try {
      expect(await restarted.tick()).toBe(1);
      for (let attempt = 0; attempt < 100 && seen.length === 0; attempt += 1) await Bun.sleep(1);
      expect(seen).toEqual([accepted.consumerUid]);
      expect(
        await sql.query(
          "SELECT state FROM queue_v2_batch_executions WHERE consumer_uid = ? ORDER BY reserved_at_ms",
          [accepted.consumerUid],
        ),
      ).toEqual([{ state: "send_authorized" }]);
      expect(
        await createV2QueueDelivery({
          sql,
          custody: createQueueCustody({ sql }),
          capability: accepted.capability,
        }).claimRegisteredBatch({ consumerUid: accepted.consumerUid, principal, space, targetKey }),
      ).toEqual({ kind: "idle" });
    } finally {
      await restarted.close();
    }
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one Consumer is not re-sent while its native handler remains in flight", async () => {
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
    expect(scheduler.tick()).toBe(first);
    expect(await first).toBe(1);
    expect(entered).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    expect(await scheduler.tick()).toBe(0);
    expect(entered).toBe(1);
    const close = scheduler.close();
    const secondClose = scheduler.close();
    expect(
      await Promise.race([close.then(() => "stopped"), Bun.sleep(100).then(() => "stuck")]),
    ).toBe("stopped");
    release();
    await close;
    await secondClose;
    expect(await scheduler.tick()).toBe(0);
    expect(entered).toBe(1);
  } finally {
    database.close();
  }
});

test("one indefinitely running Consumer cannot block a later SQL page or scheduler stop", async () => {
  const database = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    const first = await acceptedConsumer(database);
    const consumerUids = [first.consumerUid];
    for (let index = 1; index < 17; index += 1) {
      const queueUid = await first.create(AT_LEAST_ONCE_QUEUE_FORM_URL, `queue-${index}`, {
        messageRetentionSeconds: 3_600,
      });
      consumerUids.push(
        await first.create(
          QUEUE_CONSUMER_FORM_URL,
          `consumer-${index}`,
          consumerSpec(queueUid, first.workerUid),
        ),
      );
    }
    consumerUids.sort();
    const blockedUid = consumerUids[0];
    const laterPageUid = consumerUids[16];
    if (!blockedUid || !laterPageUid) throw new Error("Consumer pages are incomplete");
    let release!: () => void;
    const neverEnding = new Promise<void>((resolve) => {
      release = resolve;
    });
    const visited: string[] = [];
    const scheduler = createSelfhostV2QueueScheduler({
      sql: first.sql,
      custody: createQueueCustody({ sql: first.sql }),
      composition: {
        async deliverOnce(input) {
          visited.push(input.consumerUid);
          if (input.consumerUid === blockedUid) await neverEnding;
          return { kind: "idle" as const };
        },
      },
    });
    try {
      const initial = scheduler.tick();
      expect(
        await Promise.race([initial.then(() => "done"), Bun.sleep(100).then(() => "stuck")]),
      ).toBe("done");
      expect(await scheduler.tick()).toBe(1);
      expect(visited).toContain(laterPageUid);
      await scheduler.tick(); // pass the end and restart the bounded keyset
      await scheduler.tick();
      expect(visited.filter((uid) => uid === blockedUid)).toHaveLength(1);
      const stopping = scheduler.close();
      expect(
        await Promise.race([stopping.then(() => "stopped"), Bun.sleep(100).then(() => "stuck")]),
      ).toBe("stopped");
      expect(await scheduler.tick()).toBe(0);
      expect(visited.filter((uid) => uid === blockedUid)).toHaveLength(1);
    } finally {
      release();
      await scheduler.close();
    }
  } finally {
    database.close();
  }
});

for (const copiedOutcome of ["ack", "retry"] as const)
  test(`a copied DLQ message already ${copiedOutcome === "ack" ? "ACKed" : "retried"} by its exact native batch releases the source notice`, async () => {
    const database = new Database(":memory:");
    try {
      for (const migration of MIGRATIONS) database.exec(migration.sql);
      const accepted = await acceptedConsumer(database);
      const sourceQueueUid = await accepted.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "receipt-source", {
        messageRetentionSeconds: 3_600,
      });
      const sourceConsumerUid = await accepted.create(
        QUEUE_CONSUMER_FORM_URL,
        "receipt-source-consumer",
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
        randomId: () => "copied-dlq-message",
      });
      await custody.admit(
        { queueId: source.queueId, messageRetentionSeconds: 3_600, deliveryDelaySeconds: 0 },
        { messageId: "source-message", body: new Uint8Array([7]) },
      );
      const [sourceClaim] = await custody.claim({ ...source, limit: 1 });
      if (!sourceClaim) throw new Error("source claim is missing");
      expect(await custody.settle(sourceClaim, { outcome: "retry" })).toBe(true);
      expect((await custody.listTransferNotices(source))[0]?.noticeToken).toBe(
        "copied-dlq-message",
      );
      await custody.admit(
        {
          queueId: v2QueueId(accepted.queueUid),
          messageRetentionSeconds: 3_600,
          deliveryDelaySeconds: 0,
        },
        { messageId: "unrelated-target-message", body: new Uint8Array([8]) },
      );
      const selected = await createV2QueueDelivery({
        sql: accepted.sql,
        custody,
        capability: accepted.capability,
      }).claimRegisteredBatch({ consumerUid: accepted.consumerUid, principal, space, targetKey });
      if (selected.kind !== "ready") throw new Error("target batch not registered");
      expect(selected.claims.map((claim) => claim.messageId).sort()).toEqual([
        "copied-dlq-message",
        "unrelated-target-message",
      ]);
      expect(
        await authorizeV2QueueBatchSend(accepted.sql, {
          batchId: selected.batchId,
          reservationToken: selected.reservationToken,
          queueUid: accepted.queueUid,
          consumerUid: accepted.consumerUid,
          generation: selected.generation,
          workerUid: accepted.workerUid,
          servingSourceOperationId: accepted.servingSourceOperationId,
          workerVersionUid: accepted.versionUid,
          workerVersionGeneration: 1,
          incarnationOperationId: "receipt-test-incarnation",
        }),
      ).toBe("authorized");
      const settle = async (messageId: string, outcome: "ack" | "retry" = "ack") => {
        const claim = selected.claims.find((candidate) => candidate.messageId === messageId);
        if (!claim) throw new Error("target claim is missing");
        expect(
          await custody.settleRegisteredBatchMessage({
            batchId: selected.batchId,
            messageId,
            expected: {
              queueId: claim.queueId,
              consumerId: claim.consumerId,
              generation: claim.generation,
              leaseToken: claim.leaseToken,
            },
            decision: { outcome },
            settlementToken: `receipt-${messageId}`,
          }),
        ).toBe("settled");
      };
      await settle("unrelated-target-message");
      const scheduler = createSelfhostV2QueueScheduler({
        sql: accepted.sql,
        custody,
        composition: {
          async deliverOnce() {
            return { kind: "unknown" as const };
          },
        },
        pollMillis: 60_000,
      });
      try {
        scheduler.start();
        await scheduler.tick();
        expect((await custody.listTransferNotices(source)).length).toBe(1);
        await settle("copied-dlq-message", copiedOutcome);
        // Even a valid receipt for this token cannot release a notice that claims
        // another destination than the source generation actually declared.
        const wrongTargetQueueUid = await accepted.create(
          AT_LEAST_ONCE_QUEUE_FORM_URL,
          "wrong-receipt-target",
          { messageRetentionSeconds: 3_600 },
        );
        await accepted.sql.run(
          "UPDATE queue_custody_transfer_notices SET target_queue_id = ? WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?",
          [v2QueueId(wrongTargetQueueUid), source.queueId, source.consumerId, source.generation],
        );
        for (let attempt = 0; attempt < 4; attempt += 1) await scheduler.tick();
        expect((await custody.listTransferNotices(source)).length).toBe(1);
        await accepted.sql.run(
          "UPDATE queue_custody_transfer_notices SET target_queue_id = ? WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?",
          [v2QueueId(accepted.queueUid), source.queueId, source.consumerId, source.generation],
        );
        for (let attempt = 0; attempt < 4; attempt += 1) await scheduler.tick();
        expect(await custody.listTransferNotices(source)).toEqual([]);
        if (copiedOutcome === "ack") {
          // An injected ID reuse demonstrates the limit that *can* be proven
          // from existing rows: an old ACK receipt cannot stand in for a newly
          // copied, still-unattempted message with the same Queue/message ID.
          await custody.admit(
            { queueId: source.queueId, messageRetentionSeconds: 3_600, deliveryDelaySeconds: 0 },
            { messageId: "second-source-message", body: new Uint8Array([9]) },
          );
          const [secondSourceClaim] = await custody.claim({ ...source, limit: 1 });
          if (!secondSourceClaim) throw new Error("second source claim is missing");
          expect(await custody.settle(secondSourceClaim, { outcome: "retry" })).toBe(true);
          expect((await custody.listTransferNotices(source))[0]?.noticeToken).toBe(
            "copied-dlq-message",
          );
          for (let attempt = 0; attempt < 4; attempt += 1) await scheduler.tick();
          expect((await custody.listTransferNotices(source)).length).toBe(1);
        }
      } finally {
        await scheduler.close();
      }
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
    for (
      let attempt = 0;
      attempt < 100 && (await restartedCustody.listTransferNotices(source)).length !== 0;
      attempt += 1
    )
      await Bun.sleep(1);
    expect(await restartedCustody.listTransferNotices(source)).toEqual([]);
    await restarted.close();
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
