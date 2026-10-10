import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql } from "../src/ports.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2WorkerCurrentServingResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { prepareV2QueueConsumerAdmission } from "../src/takoform-v2/worker-queue-admission.ts";
import { createAtLeastOnceQueueForm } from "../src/takoform-v2/worker-queue-backend.ts";
import {
  createQueueConsumerForm,
  type V2QueueConsumerCapability,
} from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import {
  armV2QueueBatchSQLiteExternalUse,
  authorizeV2QueueBatchSend,
  confirmV2QueueBatchRetirement,
  confirmV2QueueBatchSQLiteDrained,
  createV2QueueDelivery,
  readV2QueueBatchSQLiteCustody,
  recordV2QueueBatchTerminal,
  v2QueueId,
} from "../src/takoform-v2/worker-queue-delivery.ts";

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}

function loseOneWriteAck(sql: Sql, needle: string): Sql {
  let lost = false;
  return {
    query: (statement, params) => sql.query(statement, params),
    batch: (statements) => sql.batch(statements),
    async run(statement, params) {
      const result = await sql.run(statement, params);
      if (!lost && statement.includes(needle)) {
        lost = true;
        throw new Error("injected lost SQL acknowledgement");
      }
      return result;
    },
  };
}

test("local Miniflare D1 atomically admits one v2 Consumer for a Queue", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-queue-management-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-queue-management-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS.slice(0, -1)) {
      for (const [index, statement] of splitMigration(migration.sql).entries()) {
        try {
          await database.prepare(statement).run();
        } catch (error) {
          throw new Error(`${migration.name} statement ${index + 1} failed`, { cause: error });
        }
      }
    }
    const queueMigration = MIGRATIONS.at(-1);
    expect(queueMigration?.name).toBe("0090_v2_queue_sqlite_external_drain.sql");
    if (!queueMigration) throw new Error("missing Queue SQLite migration");
    const sql = createD1Sql(database);
    const principal = "org-d1";
    const space = "default";
    const targetKey = "d1-queue-target";
    let servingSourceOperationId = "fixture-serving";
    let selectedVersionUid = "fixture-version";
    let selectedDeploymentUid = "fixture-deployment";
    const capability: V2QueueConsumerCapability = {
      async observeQueueServingCapability() {
        return {
          kind: "confirmed",
          servingSourceOperationId,
          deploymentUid: selectedDeploymentUid,
          deploymentGeneration: 1,
          versions: [{ workerVersionUid: selectedVersionUid, generation: 1, weight: 10_000 }],
          async stillCurrent() {
            return true;
          },
        };
      },
      async observeCurrentServing({ workerUid }) {
        return {
          kind: "ready",
          sourceOperationId: servingSourceOperationId,
          snapshot: {
            sourceOperationId: servingSourceOperationId,
            worker: { uid: workerUid, principal, space, generation: 1 },
            deployment: {
              uid: "fixture-deployment",
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
          async readVersionMaterials() {
            throw new Error("test capability has no native bytes");
          },
        } as unknown as V2WorkerCurrentServingResolution;
      },
    };
    const worker = {
      validateCreate() {},
      validateUpdate() {},
      backend: {
        id: "fixture-worker",
        targetKey,
        async execute() {
          return { kind: "complete" as const, observed: { ready: true }, output: {} };
        },
        async reconcile() {
          return { kind: "unknown" as const };
        },
      },
    };
    const forms = {
      [AT_LEAST_ONCE_QUEUE_FORM_URL]: createAtLeastOnceQueueForm({ sql, targetKey }),
      [MODULE_WORKER_FORM_URL]: worker,
      [WORKER_VERSION_FORM_URL]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "fixture-version",
          targetKey,
          async execute() {
            return {
              kind: "complete" as const,
              observed: { ready: true, resolvedBindings: true, bundleVerified: true },
              output: {},
            };
          },
          async reconcile() {
            return { kind: "unknown" as const };
          },
        },
      },
      [WORKER_DEPLOYMENT_FORM_URL]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "fixture-deployment",
          targetKey,
          async execute() {
            return { kind: "complete" as const, observed: { active: true }, output: {} };
          },
          async reconcile() {
            return { kind: "unknown" as const };
          },
        },
      },
      [QUEUE_CONSUMER_FORM_URL]: createQueueConsumerForm({ sql, targetKey, capability }),
    };
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 60,
      authorize: async () => true,
      forms,
    });
    const queue = await engine.acceptCreate({
      principal,
      key: "d1-queue-create-0001",
      input: {
        form: AT_LEAST_ONCE_QUEUE_FORM_URL,
        space,
        name: "orders",
        spec: { messageRetentionSeconds: 3600 },
      },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    const selectedWorker = await engine.acceptCreate({
      principal,
      key: "d1-worker-create-0001",
      input: { form: MODULE_WORKER_FORM_URL, space, name: "worker", spec: {} },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    const version = await engine.acceptCreate({
      principal,
      key: "d1-version-create-0001",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space,
        name: "version",
        spec: { worker: { resourceUid: selectedWorker.resourceUid }, handlers: ["queue"] },
      },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    selectedVersionUid = version.resourceUid;
    const deployment = await engine.acceptCreate({
      principal,
      key: "d1-deployment-create-0001",
      input: {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space,
        name: "deployment",
        spec: {
          worker: { resourceUid: selectedWorker.resourceUid },
          versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
        },
      },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    servingSourceOperationId = deployment.id;
    selectedDeploymentUid = deployment.resourceUid;
    const spec = {
      queue: { resourceUid: queue.resourceUid },
      worker: { resourceUid: selectedWorker.resourceUid },
      maxBatchSize: 1,
      maxBatchTimeoutSeconds: 0,
      maxConcurrency: 1,
      maxRetries: 2,
      retryDelaySeconds: 5,
    };
    const admission = await prepareV2QueueConsumerAdmission({
      capability,
      principal,
      space,
      targetKey,
      spec,
    });
    if (!admission) throw new Error("expected privileged admission proof");
    expect(
      await sql.query(`SELECT 1 AS permitted WHERE (${admission.sql})`, admission.params),
    ).toEqual([{ permitted: 1 }]);
    const results = await Promise.allSettled([
      engine.acceptCreate({
        principal,
        key: "d1-consumer-a-0001",
        input: {
          form: QUEUE_CONSUMER_FORM_URL,
          space,
          name: "consumer-a",
          spec,
        },
      }),
      engine.acceptCreate({
        principal,
        key: "d1-consumer-b-0001",
        input: {
          form: QUEUE_CONSUMER_FORM_URL,
          space,
          name: "consumer-b",
          spec,
        },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "dependency_conflict", status: 409 },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    expect(
      await sql.query(
        "SELECT COUNT(*) AS n FROM tf_v2_resources WHERE form_url = ? AND deleted_at IS NULL",
        [QUEUE_CONSUMER_FORM_URL],
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await sql.query("SELECT COUNT(*) AS n FROM queue_consumer_custody WHERE state = 'active'"),
    ).toEqual([{ n: 1 }]);
    const [consumer] = await sql.query(
      "SELECT uid FROM tf_v2_resources WHERE form_url = ? AND deleted_at IS NULL",
      [QUEUE_CONSUMER_FORM_URL],
    );
    if (typeof consumer?.uid !== "string") throw new Error("Consumer not settled");
    const updated = await engine.acceptUpdate({
      principal,
      key: "d1-consumer-update-0001",
      uid: consumer.uid,
      expectedGeneration: 1,
      spec: { ...spec, maxBatchSize: 2 },
    });
    expect((await engine.runNext())?.id).toBe(updated.id);
    expect((await engine.getOperation({ principal, id: updated.id })).effect).toBe("complete");
    const custody = createQueueCustody({ sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "d1-message", body: new Uint8Array([1]) },
    );
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "d1-message-2", body: new Uint8Array([2]) },
    );
    let n = 0;
    const delivery = createV2QueueDelivery({
      sql,
      custody,
      capability,
      randomId: () => `d1-execution-${++n}`,
    });
    const attempts = await Promise.all([
      delivery.claimRegisteredBatch({ consumerUid: consumer.uid, principal, space, targetKey }),
      delivery.claimRegisteredBatch({ consumerUid: consumer.uid, principal, space, targetKey }),
    ]);
    expect(attempts.filter((attempt) => attempt.kind === "ready")).toHaveLength(1);
    const selected = attempts.find((attempt) => attempt.kind === "ready");
    if (!selected) throw new Error("D1 batch was not registered");
    expect(selected.kind).toBe("ready");
    if (selected.kind !== "ready") throw new Error("D1 batch was not registered");
    expect(selected.claims[0]?.body).toEqual(new Uint8Array([1]));
    const execution = {
      batchId: selected.batchId,
      reservationToken: selected.reservationToken,
      queueUid: queue.resourceUid,
      consumerUid: consumer.uid,
      generation: selected.generation,
      workerUid: selectedWorker.resourceUid,
      servingSourceOperationId: deployment.id,
      workerVersionUid: version.resourceUid,
      workerVersionGeneration: 1,
      incarnationOperationId: "d1-incarnation",
    };
    expect(await authorizeV2QueueBatchSend(sql, execution)).toBe("authorized");
    expect(await armV2QueueBatchSQLiteExternalUse(sql, execution)).toBe(false);
    expect(await readV2QueueBatchSQLiteCustody(sql, execution)).toEqual({ kind: "unknown" });
    const queueStatements = splitMigration(queueMigration.sql);
    for (const statement of queueStatements.slice(0, 2)) await database.prepare(statement).run();
    expect(await armV2QueueBatchSQLiteExternalUse(sql, execution)).toBe(false);
    expect(
      await confirmV2QueueBatchRetirement(sql, {
        execution,
        kind: "handler_and_wait_until",
        receiptDigest: "c".repeat(64),
      }),
    ).toBe("retired");
    for (const statement of queueStatements.slice(2)) await database.prepare(statement).run();
    expect(await armV2QueueBatchSQLiteExternalUse(sql, execution)).toBe(false);
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "d1-sqlite-message", body: new Uint8Array([3]) },
    );
    const sqliteBatch = await delivery.claimRegisteredBatch({
      consumerUid: consumer.uid,
      principal,
      space,
      targetKey,
    });
    expect(sqliteBatch.kind).toBe("ready");
    if (sqliteBatch.kind !== "ready") throw new Error("SQLite batch was not registered");
    const sqliteExecution = {
      ...execution,
      batchId: sqliteBatch.batchId,
      reservationToken: sqliteBatch.reservationToken,
      generation: sqliteBatch.generation,
      incarnationOperationId: "d1-sqlite-incarnation",
    };
    expect(await authorizeV2QueueBatchSend(sql, sqliteExecution)).toBe("authorized");
    expect(
      await armV2QueueBatchSQLiteExternalUse(
        loseOneWriteAck(sql, "sqlite_drain_state = 'pending'"),
        sqliteExecution,
      ),
    ).toBe(true);
    expect(await armV2QueueBatchSQLiteExternalUse(createD1Sql(database), sqliteExecution)).toBe(
      true,
    );
    const wrongScope = { ...sqliteExecution, consumerUid: "another-consumer" };
    expect(await armV2QueueBatchSQLiteExternalUse(sql, wrongScope)).toBe(false);
    const terminal = { kind: "handler_and_wait_until" as const, receiptDigest: "d".repeat(64) };
    const drainDigest = `sha256:${"e".repeat(64)}` as const;
    expect(await readV2QueueBatchSQLiteCustody(sql, sqliteExecution)).toMatchObject({
      kind: "found",
      principal,
      space,
      targetKey,
      sqliteDrainState: "pending",
      terminal: null,
    });
    expect(
      await confirmV2QueueBatchRetirement(sql, {
        execution: sqliteExecution,
        kind: terminal.kind,
        receiptDigest: terminal.receiptDigest,
      }),
    ).toBe("unknown");
    await expect(
      sql.run(
        `UPDATE queue_v2_batch_executions SET state='retired',
      retired_at_ms=9999999999999,retirement_kind=?,retirement_receipt_digest=?
      WHERE batch_id=?`,
        [terminal.kind, terminal.receiptDigest, sqliteExecution.batchId],
      ),
    ).rejects.toThrow();
    expect(
      await recordV2QueueBatchTerminal(loseOneWriteAck(sql, "SET terminal_kind = ?"), {
        execution: sqliteExecution,
        ...terminal,
      }),
    ).toBe(true);
    expect(
      await recordV2QueueBatchTerminal(createD1Sql(database), {
        execution: sqliteExecution,
        ...terminal,
      }),
    ).toBe(true);
    await expect(
      sql.run(
        `UPDATE queue_v2_batch_executions SET state='retired',
      retired_at_ms=9999999999999,retirement_kind=?,retirement_receipt_digest=?
      WHERE batch_id=?`,
        [terminal.kind, terminal.receiptDigest, sqliteExecution.batchId],
      ),
    ).rejects.toThrow();
    expect(
      await recordV2QueueBatchTerminal(sql, {
        execution: sqliteExecution,
        kind: "incarnation_absent",
        receiptDigest: "f".repeat(64),
      }),
    ).toBe(false);
    expect(
      await confirmV2QueueBatchSQLiteDrained(
        loseOneWriteAck(sql, "SET sqlite_drain_state = 'drained'"),
        {
          execution: sqliteExecution,
          terminal: { ...terminal, receiptDigest: "f".repeat(64) },
          receiptDigest: drainDigest,
        },
      ),
    ).toBe(false);
    expect(
      await confirmV2QueueBatchSQLiteDrained(createD1Sql(database), {
        execution: sqliteExecution,
        terminal,
        receiptDigest: drainDigest,
      }),
    ).toBe(true);
    expect(
      await confirmV2QueueBatchSQLiteDrained(sql, {
        execution: sqliteExecution,
        terminal,
        receiptDigest: drainDigest,
      }),
    ).toBe(true);
    expect(
      await confirmV2QueueBatchSQLiteDrained(sql, {
        execution: sqliteExecution,
        terminal,
        receiptDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      await confirmV2QueueBatchRetirement(sql, {
        execution: sqliteExecution,
        kind: "incarnation_absent",
        receiptDigest: "f".repeat(64),
      }),
    ).toBe("unknown");
    expect(
      await confirmV2QueueBatchRetirement(sql, { execution: sqliteExecution, ...terminal }),
    ).toBe("retired");
    expect(
      await confirmV2QueueBatchRetirement(sql, { execution: sqliteExecution, ...terminal }),
    ).toBe("already_retired");
    expect(await armV2QueueBatchSQLiteExternalUse(sql, sqliteExecution)).toBe(false);
  } finally {
    await runtime.dispose();
  }
});
