import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { JsonObject, Sql, SqlParam } from "../src/ports.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createSelfhostV2QueueComposition } from "../src/selfhost-v2-queue-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";
import type { V2WorkerCurrentServingResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { createAtLeastOnceQueueForm } from "../src/takoform-v2/worker-queue-backend.ts";
import type { V2QueueConsumerCapability } from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import { createQueueConsumerForm } from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import {
  authorizeV2QueueBatchSend,
  cancelV2QueueBatchBeforeSend,
  confirmV2QueueBatchRetirement,
  createV2QueueDelivery,
  listV2AuthorizedQueueExecutions,
  listV2AuthorizedQueueExecutionsForWorker,
  v2QueueId,
  verifyV2QueueSettlementScope,
} from "../src/takoform-v2/worker-queue-delivery.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

const principal = "org-one";
const space = "default";
const targetKey = "local-target";
const consumerSpec = (
  queueUid: string,
  workerUid: string,
  extras: Record<string, unknown> = {},
) => ({
  queue: { resourceUid: queueUid },
  worker: { resourceUid: workerUid },
  maxBatchSize: 10,
  maxBatchTimeoutSeconds: 0,
  maxConcurrency: 2,
  maxRetries: 2,
  retryDelaySeconds: 5,
  ...extras,
});

function fixture(databasePath = ":memory:", beforeRetentionWrite?: () => Promise<void>) {
  const database = new Database(databasePath);
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  const sql = createSqliteSql(database);
  const queueSql = beforeRetentionWrite
    ? {
        ...sql,
        async run(statement: string, params?: readonly SqlParam[]) {
          if (statement.includes("SET expires_at_ms")) await beforeRetentionWrite();
          return sql.run(statement, params);
        },
      }
    : sql;
  let nowMs = Date.now();
  let capabilityAvailable = true;
  let servingSourceOperationId = "fixture-source";
  let servingVersionUid = "fixture-version";
  let selectedVersions: readonly { uid: string; generation: number; weight: number }[] | null =
    null;
  const currentVersions = () =>
    selectedVersions ?? [{ uid: servingVersionUid, generation: 1, weight: 10_000 }];
  let admissionGate: Promise<void> | null = null;
  let admissionEntered: (() => void) | null = null;
  const worker: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "fixture-worker",
      targetKey,
      async execute() {
        return { kind: "complete", observed: { ready: true }, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const version: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    references(spec) {
      if (typeof spec.queueUid !== "string") return [];
      return [
        {
          resourceUid: String(spec.queueUid),
          formUrl: AT_LEAST_ONCE_QUEUE_FORM_URL,
          readiness: "observed",
        },
      ];
    },
    backend: {
      id: "fixture-version",
      targetKey,
      async execute() {
        return {
          kind: "complete",
          observed: { ready: true, resolvedBindings: true, bundleVerified: true },
          output: {},
        };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const deployment: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "fixture-deployment",
      targetKey,
      async execute() {
        return { kind: "complete", observed: { active: true }, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const capability: V2QueueConsumerCapability = {
    async observeQueueServingCapability() {
      const source = servingSourceOperationId;
      const deployment = servingDeploymentUid;
      const versions = currentVersions().map((version) => ({ ...version }));
      admissionEntered?.();
      if (admissionGate) await admissionGate;
      if (!capabilityAvailable || servingSourceOperationId === "fixture-source")
        return { kind: "unknown" };
      return {
        kind: "confirmed",
        servingSourceOperationId: source,
        deploymentUid: deployment,
        deploymentGeneration: 1,
        versions: versions.map((version) => ({
          workerVersionUid: version.uid,
          generation: version.generation,
          weight: version.weight,
        })),
        async stillCurrent() {
          return capabilityAvailable;
        },
      };
    },
    async observeCurrentServing({ workerUid }) {
      if (!capabilityAvailable)
        return { kind: "unresolved", code: "graph_unresolved", message: "offline" };
      // Explicit privileged runtime stand-in. The manager still writes the
      // real QueueCustody row and Core Resource/Operation through SQLite.
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
            versions: currentVersions().map((version) => ({
              uid: version.uid,
              generation: version.generation,
              weight: version.weight,
              spec: { handlers: ["queue"] },
            })),
          },
          endpoint: null,
        },
        async stillCurrent() {
          return capabilityAvailable;
        },
        async readVersionMaterials() {
          throw new Error("stand-in does not provide native materials");
        },
      } as unknown as V2WorkerCurrentServingResolution;
    },
  };
  let servingDeploymentUid = "fixture-deployment";
  const consumer = createQueueConsumerForm({ sql, targetKey, capability });
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(nowMs),
    replayWindowSeconds: 60,
    leaseMilliseconds: 1_000,
    authorize: async (who, where) => who === principal && where === space,
    forms: {
      [AT_LEAST_ONCE_QUEUE_FORM_URL]: createAtLeastOnceQueueForm({ sql: queueSql, targetKey }),
      [MODULE_WORKER_FORM_URL]: worker,
      [WORKER_VERSION_FORM_URL]: version,
      [WORKER_DEPLOYMENT_FORM_URL]: deployment,
      [WORKER_ENDPOINT_FORM_URL]: deployment,
      [QUEUE_CONSUMER_FORM_URL]: consumer,
    },
  });
  const create = async (form: string, name: string, spec: JsonObject) => {
    if (form === QUEUE_CONSUMER_FORM_URL && servingSourceOperationId === "fixture-source") {
      const workerUid = String((spec.worker as { resourceUid: string }).resourceUid);
      await create(WORKER_VERSION_FORM_URL, `${name}-admission-version`, {
        worker: { resourceUid: workerUid },
        handlers: ["queue"],
      });
      await create(WORKER_DEPLOYMENT_FORM_URL, `${name}-admission-deployment`, {
        worker: { resourceUid: workerUid },
      });
    }
    const acceptedSpec =
      form === WORKER_DEPLOYMENT_FORM_URL
        ? {
            ...spec,
            versions: currentVersions().map((version) => ({
              workerVersion: { resourceUid: version.uid },
              weight: version.weight,
            })),
          }
        : form === WORKER_VERSION_FORM_URL && spec.worker
          ? { handlers: ["queue"], ...spec }
          : spec;
    const accepted = await engine.acceptCreate({
      principal,
      key: `create-${name}-key-00000001`,
      input: { form, space, name, spec: acceptedSpec },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    if (form === WORKER_VERSION_FORM_URL && spec.worker) servingVersionUid = accepted.resourceUid;
    if (form === WORKER_DEPLOYMENT_FORM_URL) {
      servingDeploymentUid = accepted.resourceUid;
      servingSourceOperationId = accepted.id;
    }
    return accepted;
  };
  return {
    database,
    sql,
    engine,
    create,
    capability,
    advance(ms: number) {
      nowMs += ms;
    },
    setCapability(ready: boolean) {
      capabilityAvailable = ready;
    },
    setServingSource(operationId: string) {
      servingSourceOperationId = operationId;
    },
    setServingVersion(uid: string) {
      servingVersionUid = uid;
      selectedVersions = null;
    },
    setServingVersions(versions: readonly { uid: string; generation: number; weight: number }[]) {
      selectedVersions = versions.map((version) => ({ ...version }));
    },
    holdAdmission() {
      let release: (() => void) | null = null;
      const entered = new Promise<void>((resolve) => {
        admissionEntered = resolve;
      });
      admissionGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        entered,
        release() {
          admissionGate = null;
          admissionEntered = null;
          release?.();
        },
      };
    },
  };
}

test("one Queue namespace and Consumer attachment use Core UID, real custody, replay and references", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "orders", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    const spec = consumerSpec(queue.resourceUid, worker.resourceUid);
    const consumer = await f.create(QUEUE_CONSUMER_FORM_URL, "consumer", spec);
    expect(await f.engine.getResource({ principal, uid: consumer.resourceUid })).toMatchObject({
      observed: { queueExists: true, workerExists: true, consumerAttached: true },
    });
    expect(
      await f.sql.query("SELECT queue_id, consumer_id, state FROM queue_consumer_custody"),
    ).toEqual([
      {
        queue_id: v2QueueId(queue.resourceUid),
        consumer_id: consumer.resourceUid,
        state: "active",
      },
    ]);
    expect(
      (
        await f.engine.acceptCreate({
          principal,
          key: "create-consumer-key-00000001",
          input: { form: QUEUE_CONSUMER_FORM_URL, space, name: "consumer", spec },
        })
      ).id,
    ).toBe(consumer.id);
    await expect(
      f.engine.acceptCreate({
        principal,
        key: "other-consumer-key-0000001",
        input: { form: QUEUE_CONSUMER_FORM_URL, space, name: "consumer-2", spec },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    await expect(
      f.engine.acceptDelete({
        principal,
        key: "queue-delete-blocked-key-01",
        uid: queue.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    const update = await f.engine.acceptUpdate({
      principal,
      key: "consumer-update-key-00001",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
      spec: { ...spec, maxRetries: 3 },
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect(await f.sql.query("SELECT max_retries, generation FROM queue_consumer_custody")).toEqual(
      [{ max_retries: 3, generation: 2 }],
    );
    expect((await f.engine.getOperation({ principal, id: update.id })).effect).toBe("complete");
    const deleted = await f.engine.acceptDelete({
      principal,
      key: "consumer-delete-key-0001",
      uid: consumer.resourceUid,
      expectedGeneration: 2,
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: deleted.id })).effect).toBe("complete");
    expect(await f.sql.query("SELECT state FROM queue_consumer_custody")).toEqual([
      { state: "tombstone" },
    ]);
    const successor = await f.create(QUEUE_CONSUMER_FORM_URL, "consumer-successor", spec);
    expect(successor.resourceUid).not.toBe(consumer.resourceUid);
    expect(
      await f.sql.query("SELECT consumer_id, generation, state FROM queue_consumer_custody"),
    ).toEqual([{ consumer_id: successor.resourceUid, generation: 3, state: "active" }]);
    const successorDelete = await f.engine.acceptDelete({
      principal,
      key: "consumer-successor-delete-0001",
      uid: successor.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: successorDelete.id })).effect).toBe(
      "complete",
    );
    const queueDeleted = await f.engine.acceptDelete({
      principal,
      key: "queue-delete-key-00000001",
      uid: queue.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: queueDeleted.id })).effect).toBe(
      "complete",
    );
  } finally {
    f.database.close();
  }
});

test("accepted DLQ cycles and duplicate Consumers lose before a second Operation", async () => {
  const f = fixture();
  try {
    const a = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "queue-a", {
      messageRetentionSeconds: 3600,
    });
    const b = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "queue-b", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "consumer-a",
      consumerSpec(a.resourceUid, worker.resourceUid, {
        deadLetterQueue: { resourceUid: b.resourceUid },
      }),
    );
    const before = await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations");
    await expect(
      f.engine.acceptCreate({
        principal,
        key: "cycle-consumer-key-000001",
        input: {
          form: QUEUE_CONSUMER_FORM_URL,
          space,
          name: "consumer-b",
          spec: consumerSpec(b.resourceUid, worker.resourceUid, {
            deadLetterQueue: { resourceUid: a.resourceUid },
          }),
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual(before);
  } finally {
    f.database.close();
  }
});

test("Consumer target mismatch is rejected in the accepted SQL transaction", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "orders", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    const wrongTarget = createTakoformV2Engine({
      sql: f.sql,
      replayWindowSeconds: 60,
      authorize: async () => true,
      forms: {
        [QUEUE_CONSUMER_FORM_URL]: createQueueConsumerForm({
          sql: f.sql,
          targetKey: "other-target",
          capability: f.capability,
        }),
      },
    });
    const before = await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations");
    await expect(
      wrongTarget.acceptCreate({
        principal,
        key: "wrong-target-consumer-0001",
        input: {
          form: QUEUE_CONSUMER_FORM_URL,
          space,
          name: "consumer-other-target",
          spec: consumerSpec(queue.resourceUid, worker.resourceUid),
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual(before);
  } finally {
    f.database.close();
  }
});

test("unavailable privileged serving proof refuses Consumer before acceptance", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "orders", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    f.setCapability(false);
    const before = await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations");
    await expect(
      f.engine.acceptCreate({
        principal,
        key: "create-consumer-key-00000001",
        input: {
          form: QUEUE_CONSUMER_FORM_URL,
          space,
          name: "consumer",
          spec: consumerSpec(queue.resourceUid, worker.resourceUid),
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual(before);
    expect(await f.sql.query("SELECT 1 FROM queue_consumer_custody")).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("a weighted Version without queue handler is refused before Consumer acceptance", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "handler-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "handler-worker", {});
    await f.create(WORKER_VERSION_FORM_URL, "fetch-only-version", {
      worker: { resourceUid: worker.resourceUid },
      handlers: ["fetch"],
    });
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "handler-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    const before = await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations");
    await expect(
      f.engine.acceptCreate({
        principal,
        key: "missing-queue-handler-0001",
        input: {
          form: QUEUE_CONSUMER_FORM_URL,
          space,
          name: "missing-handler-consumer",
          spec: consumerSpec(queue.resourceUid, worker.resourceUid),
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual(before);
  } finally {
    f.database.close();
  }
});

test("every weighted Version must be queue-ready in the accepted SQL graph", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "weighted-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "weighted-worker", {});
    const first = await f.create(WORKER_VERSION_FORM_URL, "weighted-queue-version", {
      worker: { resourceUid: worker.resourceUid },
      handlers: ["queue"],
    });
    const second = await f.create(WORKER_VERSION_FORM_URL, "weighted-fetch-version", {
      worker: { resourceUid: worker.resourceUid },
      handlers: ["fetch"],
    });
    f.setServingVersions([
      { uid: first.resourceUid, generation: 1, weight: 5_000 },
      { uid: second.resourceUid, generation: 1, weight: 5_000 },
    ]);
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "weighted-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    const request = {
      principal,
      key: "weighted-consumer-create-0001",
      input: {
        form: QUEUE_CONSUMER_FORM_URL,
        space,
        name: "weighted-consumer",
        spec: consumerSpec(queue.resourceUid, worker.resourceUid),
      },
    };
    const before = await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations");
    await expect(f.engine.acceptCreate(request)).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual(before);
    const updated = await f.engine.acceptUpdate({
      principal,
      key: "weighted-version-update-0001",
      uid: second.resourceUid,
      expectedGeneration: 1,
      spec: { worker: { resourceUid: worker.resourceUid }, handlers: ["queue"] },
    });
    expect((await f.engine.runNext())?.id).toBe(updated.id);
    f.setServingVersions([
      { uid: first.resourceUid, generation: 1, weight: 5_000 },
      { uid: second.resourceUid, generation: 2, weight: 5_000 },
    ]);
    expect((await f.engine.acceptCreate(request)).status).toBe("queued");
  } finally {
    f.database.close();
  }
});

test("a reordered weighted Version set remains eligible for Consumer admission", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "reordered-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "reordered-worker", {});
    const first = await f.create(WORKER_VERSION_FORM_URL, "reordered-first", {
      worker: { resourceUid: worker.resourceUid },
      handlers: ["queue"],
    });
    const second = await f.create(WORKER_VERSION_FORM_URL, "reordered-second", {
      worker: { resourceUid: worker.resourceUid },
      handlers: ["queue"],
    });
    f.setServingVersions([
      { uid: second.resourceUid, generation: 1, weight: 4_000 },
      { uid: first.resourceUid, generation: 1, weight: 6_000 },
    ]);
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "reordered-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersions([
      { uid: first.resourceUid, generation: 1, weight: 6_000 },
      { uid: second.resourceUid, generation: 1, weight: 4_000 },
    ]);
    const accepted = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "reordered-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid),
    );
    expect((await f.engine.getOperation({ principal, id: accepted.id })).effect).toBe("complete");
    f.setServingVersions([
      { uid: first.resourceUid, generation: 1, weight: 5_000 },
      { uid: second.resourceUid, generation: 1, weight: 5_000 },
    ]);
    await expect(
      f.engine.acceptUpdate({
        principal,
        key: "reordered-weight-drift-update-0001",
        uid: accepted.resourceUid,
        expectedGeneration: 1,
        spec: consumerSpec(queue.resourceUid, worker.resourceUid),
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    expect((await f.engine.getResource({ principal, uid: accepted.resourceUid })).generation).toBe(
      1,
    );
  } finally {
    f.database.close();
  }
});

test("a publication accepted while Queue admission awaits cannot win with the old source", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "race-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "race-worker", {});
    await f.create(WORKER_VERSION_FORM_URL, "race-version", {
      worker: { resourceUid: worker.resourceUid },
    });
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "race-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    const held = f.holdAdmission();
    const pending = f.engine.acceptCreate({
      principal,
      key: "race-consumer-create-0001",
      input: {
        form: QUEUE_CONSUMER_FORM_URL,
        space,
        name: "race-consumer",
        spec: consumerSpec(queue.resourceUid, worker.resourceUid),
      },
    });
    try {
      await held.entered;
      const current = await f.engine.getResource({ principal, uid: deployment.resourceUid });
      const publisher = await f.engine.acceptUpdate({
        principal,
        key: "race-deployment-update-0001",
        uid: deployment.resourceUid,
        expectedGeneration: current.generation,
        spec: current.spec,
      });
      held.release();
      await expect(pending).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
      expect(await f.engine.getOperation({ principal, id: publisher.id })).toMatchObject({
        status: "queued",
      });
      expect(
        await f.sql.query("SELECT uid FROM tf_v2_resources WHERE name = 'race-consumer'"),
      ).toEqual([]);
    } finally {
      held.release();
    }
  } finally {
    f.database.close();
  }
});

test("settled Endpoint DELETE remains the latest serving source for Consumer admission", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "endpoint-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "endpoint-worker", {});
    await f.create(WORKER_VERSION_FORM_URL, "endpoint-version", {
      worker: { resourceUid: worker.resourceUid },
    });
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "endpoint-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint-route", {
      worker: { resourceUid: worker.resourceUid },
    });
    const before = await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations");
    await expect(
      f.engine.acceptCreate({
        principal,
        key: "stale-deployment-source-consumer-0001",
        input: {
          form: QUEUE_CONSUMER_FORM_URL,
          space,
          name: "stale-source-consumer",
          spec: consumerSpec(queue.resourceUid, worker.resourceUid),
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual(before);
    const detached = await f.engine.acceptDelete({
      principal,
      key: "endpoint-detach-queue-source-0001",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    f.setServingSource(detached.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "endpoint-source-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid),
    );
    expect((await f.engine.getOperation({ principal, id: consumer.id })).effect).toBe("complete");
  } finally {
    f.database.close();
  }
});

test("registered batch selection is UID-scoped and DELETE closes admission before drain", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "v2-queue-execution-"));
  const path = join(root, "state.sqlite");
  const f = fixture(path);
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "orders", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "queue-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    const unselectedVersion = await f.create(WORKER_VERSION_FORM_URL, "unselected-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid, { maxConcurrency: 1, maxBatchSize: 1 }),
    );
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "message-1", body: new Uint8Array([1, 2, 3]) },
    );
    let randomIndex = 0;
    const delivery = createV2QueueDelivery({
      sql: f.sql,
      custody,
      capability: f.capability,
      randomId: () => ["batch-1", "reservation-1"][randomIndex++] ?? "unused-id",
    });
    const selected = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    expect(selected.kind).toBe("ready");
    if (selected.kind !== "ready") throw new Error("batch not selected");
    expect(selected).toMatchObject({
      batchId: "batch-1",
      queueUid: queue.resourceUid,
      queueName: "orders",
      workerUid: worker.resourceUid,
      consumerUid: consumer.resourceUid,
      claims: [{ messageId: "message-1", body: new Uint8Array([1, 2, 3]), attempts: 1 }],
    });
    expect(
      await custody.readSettlementBatch({
        batchId: selected.batchId,
        queueId: v2QueueId(queue.resourceUid),
        consumerId: consumer.resourceUid,
        generation: selected.generation,
      }),
    ).toMatchObject([{ state: "pending" }]);
    const beforeSendClaim = selected.claims[0];
    if (!beforeSendClaim) throw new Error("claim missing before send");
    expect(
      await custody.settleRegisteredBatchMessage({
        batchId: selected.batchId,
        messageId: beforeSendClaim.messageId,
        expected: {
          queueId: beforeSendClaim.queueId,
          consumerId: beforeSendClaim.consumerId,
          generation: beforeSendClaim.generation,
          leaseToken: beforeSendClaim.leaseToken,
        },
        decision: { outcome: "ack" },
        settlementToken: "too-early",
      }),
    ).toBe("unavailable");
    expect(
      await verifyV2QueueSettlementScope(f.sql, {
        batchId: selected.batchId,
        messageId: beforeSendClaim.messageId,
        leaseToken: beforeSendClaim.leaseToken,
        consumerUid: consumer.resourceUid,
        queueUid: queue.resourceUid,
        workerUid: worker.resourceUid,
        generation: selected.generation,
        servingSourceOperationId: deployment.id,
      }),
    ).toEqual({ kind: "unknown" });
    const execution = {
      batchId: selected.batchId,
      reservationToken: selected.reservationToken,
      queueUid: queue.resourceUid,
      consumerUid: consumer.resourceUid,
      generation: selected.generation,
      workerUid: worker.resourceUid,
      servingSourceOperationId: deployment.id,
      workerVersionUid: version.resourceUid,
      workerVersionGeneration: 1,
      incarnationOperationId: "incarnation-1",
    };
    const lostSendAckSql = {
      ...f.sql,
      async run(statement: string, params?: readonly SqlParam[]) {
        const result = await f.sql.run(statement, params);
        if (statement.includes("SET state = 'send_authorized'"))
          throw new Error("SQL acknowledgement lost after commit");
        return result;
      },
    };
    expect(
      await authorizeV2QueueBatchSend(f.sql, {
        ...execution,
        workerVersionUid: unselectedVersion.resourceUid,
      }),
    ).toBe("unknown");
    expect(await authorizeV2QueueBatchSend(lostSendAckSql, execution)).toBe("already_authorized");
    expect(await authorizeV2QueueBatchSend(f.sql, execution)).toBe("already_authorized");
    // A distinct SQLite handle can recover the exact send grant, never a new
    // batch or a guessed settled outcome. This is not an OS process restart.
    const reopened = new Database(path);
    try {
      expect(await authorizeV2QueueBatchSend(createSqliteSql(reopened), execution)).toBe(
        "already_authorized",
      );
    } finally {
      reopened.close();
    }
    expect(
      await authorizeV2QueueBatchSend(f.sql, {
        ...execution,
        incarnationOperationId: "other-incarnation",
      }),
    ).toBe("unknown");
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "message-2", body: new Uint8Array([4]) },
    );
    expect(
      (
        await delivery.claimRegisteredBatch({
          consumerUid: consumer.resourceUid,
          principal,
          space,
          targetKey,
        })
      ).kind,
    ).toBe("idle");
    const [unreserved] = await custody.claim({
      queueId: v2QueueId(queue.resourceUid),
      consumerId: consumer.resourceUid,
      generation: selected.generation,
      limit: 1,
      v2Attachment: { principal, space, targetKey },
    });
    if (!unreserved) throw new Error("unreserved claim missing");
    await expect(
      custody.registerSettlementBatch("orphan-batch", [unreserved], {
        reservationToken: "wrong-reservation",
      }),
    ).rejects.toThrow("queue batch claim is unavailable");
    expect(
      await f.sql.query("SELECT 1 FROM queue_v2_batch_settlements WHERE batch_id = 'orphan-batch'"),
    ).toEqual([]);
    expect(await custody.release(unreserved)).toBe(true);
    const deleteOp = await f.engine.acceptDelete({
      principal,
      key: "consumer-delete-with-lease-1",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
    });
    expect(
      await delivery.claimRegisteredBatch({
        consumerUid: consumer.resourceUid,
        principal,
        space,
        targetKey,
      }),
    ).toEqual({ kind: "unknown" });
    expect(await selected.stillCurrent()).toBe(false);
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(await f.sql.query("SELECT state FROM queue_consumer_custody")).toEqual([
      { state: "retiring" },
    ]);
    const claim = selected.claims[0];
    if (!claim) throw new Error("claim missing");
    const proof = {
      batchId: selected.batchId,
      messageId: claim.messageId,
      leaseToken: claim.leaseToken,
      consumerUid: consumer.resourceUid,
      queueUid: queue.resourceUid,
      workerUid: worker.resourceUid,
      generation: selected.generation,
      servingSourceOperationId: deployment.id,
    };
    expect(await verifyV2QueueSettlementScope(f.sql, proof)).toEqual({
      kind: "confirmed_live",
      ...proof,
    });
    expect(
      await verifyV2QueueSettlementScope(f.sql, { ...proof, leaseToken: "wrong-lease" }),
    ).toEqual({ kind: "unknown" });
    expect(
      await verifyV2QueueSettlementScope(f.sql, { ...proof, servingSourceOperationId: worker.id }),
    ).toEqual({ kind: "unknown" });
    expect(
      await custody.settleRegisteredBatchMessage({
        batchId: selected.batchId,
        messageId: claim.messageId,
        expected: {
          queueId: claim.queueId,
          consumerId: claim.consumerId,
          generation: claim.generation,
          leaseToken: claim.leaseToken,
        },
        decision: { outcome: "ack" },
        settlementToken: "settlement-1",
      }),
    ).toBe("settled");
    expect(await verifyV2QueueSettlementScope(f.sql, proof)).toEqual({
      kind: "confirmed_receipt",
      ...proof,
    });
    await expect(
      f.engine.acceptDelete({
        principal,
        key: "version-delete-while-handler-live",
        uid: version.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    // ACK removed the message, but the handler and its waitUntil may still run.
    expect(await f.sql.query("SELECT state FROM queue_v2_batch_executions")).toEqual([
      { state: "send_authorized" },
    ]);
    f.advance(1_001);
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(await f.sql.query("SELECT state FROM queue_v2_batch_executions")).toEqual([
      { state: "send_authorized" },
    ]);
    expect(
      await confirmV2QueueBatchRetirement(f.sql, {
        execution: { ...execution, incarnationOperationId: "wrong-incarnation" },
        kind: "handler_and_wait_until",
        receiptDigest: "a".repeat(64),
      }),
    ).toBe("unknown");
    const lostRetirementAckSql = {
      ...f.sql,
      async run(statement: string, params?: readonly SqlParam[]) {
        const result = await f.sql.run(statement, params);
        if (statement.includes("SET state = 'retired'"))
          throw new Error("SQL retirement acknowledgement lost after commit");
        return result;
      },
    };
    expect(
      await confirmV2QueueBatchRetirement(lostRetirementAckSql, {
        execution,
        kind: "handler_and_wait_until",
        receiptDigest: "a".repeat(64),
      }),
    ).toBe("already_retired");
    expect(
      await confirmV2QueueBatchRetirement(f.sql, {
        execution,
        kind: "handler_and_wait_until",
        receiptDigest: "a".repeat(64),
      }),
    ).toBe("already_retired");
    expect(
      await confirmV2QueueBatchRetirement(f.sql, {
        execution,
        kind: "handler_and_wait_until",
        receiptDigest: "b".repeat(64),
      }),
    ).toBe("unknown");
    f.advance(1_001);
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: deleteOp.id })).effect).toBe("complete");
    expect(await f.sql.query("SELECT state FROM queue_consumer_custody")).toEqual([
      { state: "tombstone" },
    ]);
    expect(await verifyV2QueueSettlementScope(f.sql, proof)).toEqual({
      kind: "confirmed_receipt",
      ...proof,
    });
  } finally {
    f.database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-send cancellation after SQLite handle reopen refunds the exact unsent lease", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "v2-queue-unsent-"));
  const path = join(root, "state.sqlite");
  const f = fixture(path);
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "unsent-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "unsent-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "unsent-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "unsent-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "unsent-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid, { maxConcurrency: 1 }),
    );
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "unsent-message", body: new Uint8Array([3]) },
    );
    const delivery = createV2QueueDelivery({ sql: f.sql, custody, capability: f.capability });
    const selected = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    if (selected.kind !== "ready") throw new Error("unsent batch not registered");
    expect(await f.sql.query("SELECT deliveries FROM selfhost_queue_messages")).toEqual([
      { deliveries: 1 },
    ]);
    const reopened = new Database(path);
    try {
      const sql = createSqliteSql(reopened);
      expect(
        await cancelV2QueueBatchBeforeSend(sql, {
          batchId: selected.batchId,
          reservationToken: selected.reservationToken,
        }),
      ).toBe(true);
    } finally {
      reopened.close();
    }
    expect(await f.sql.query("SELECT deliveries,lease_token FROM selfhost_queue_messages")).toEqual(
      [{ deliveries: 0, lease_token: null }],
    );
    expect(await f.sql.query("SELECT state FROM queue_v2_batch_executions")).toEqual([
      { state: "pre_effect_refused" },
    ]);
    const next = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    expect(next.kind).toBe("ready");
    if (next.kind !== "ready") throw new Error("unsent message did not reappear");
    expect(next.claims[0]?.attempts).toBe(1);
    // Accepted DELETE closes SQL send authorization, so a registered but
    // unsent batch need not wait for its reservation deadline to drain.
    const deleted = await f.engine.acceptDelete({
      principal,
      key: "unsent-consumer-delete-key-01",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(await f.sql.query("SELECT deliveries,lease_token FROM selfhost_queue_messages")).toEqual(
      [{ deliveries: 0, lease_token: null }],
    );
    f.advance(1_000);
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: deleted.id })).effect).toBe("complete");
  } finally {
    f.database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pending Deployment DELETE fences the old source before native Queue send", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "source-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "source-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "source-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "source-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "source-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid),
    );
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "source-message", body: new Uint8Array([5]) },
    );
    const delivery = createV2QueueDelivery({ sql: f.sql, custody, capability: f.capability });
    const batch = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    if (batch.kind !== "ready") throw new Error("pre-send batch not registered");
    const accepted = await f.engine.acceptDelete({
      principal,
      key: "source-deployment-delete-key-01",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.getOperation({ principal, id: accepted.id })).status).toBe("queued");
    expect(
      await authorizeV2QueueBatchSend(f.sql, {
        batchId: batch.batchId,
        reservationToken: batch.reservationToken,
        queueUid: queue.resourceUid,
        consumerUid: consumer.resourceUid,
        generation: batch.generation,
        workerUid: worker.resourceUid,
        servingSourceOperationId: deployment.id,
        workerVersionUid: version.resourceUid,
        workerVersionGeneration: 1,
        incarnationOperationId: "source-incarnation",
      }),
    ).toBe("unknown");
    expect(await f.sql.query("SELECT state FROM queue_v2_batch_executions")).toEqual([
      { state: "registered" },
    ]);
  } finally {
    f.database.close();
  }
});

test("latest settled Endpoint publisher replaces Deployment, including Endpoint DELETE", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "publisher-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "publisher-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "publisher-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "publisher-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "publisher-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid),
    );
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "publisher-one", body: new Uint8Array([1]) },
    );
    const delivery = createV2QueueDelivery({ sql: f.sql, custody, capability: f.capability });
    const old = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    if (old.kind !== "ready") throw new Error("old publisher batch unavailable");
    const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "publisher-endpoint", {
      worker: { resourceUid: worker.resourceUid },
    });
    expect(
      await authorizeV2QueueBatchSend(f.sql, {
        batchId: old.batchId,
        reservationToken: old.reservationToken,
        queueUid: queue.resourceUid,
        consumerUid: consumer.resourceUid,
        generation: old.generation,
        workerUid: worker.resourceUid,
        servingSourceOperationId: deployment.id,
        workerVersionUid: version.resourceUid,
        workerVersionGeneration: 1,
        incarnationOperationId: "publisher-incarnation",
      }),
    ).toBe("unknown");
    expect(
      await cancelV2QueueBatchBeforeSend(f.sql, {
        batchId: old.batchId,
        reservationToken: old.reservationToken,
      }),
    ).toBe(true);
    const endpointDelete = await f.engine.acceptDelete({
      principal,
      key: "publisher-endpoint-delete-key-01",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    f.setServingSource(endpointDelete.id);
    const next = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    expect(next.kind).toBe("ready");
    if (next.kind !== "ready") throw new Error("Endpoint DELETE publisher not accepted");
    expect(next.servingSourceOperationId).toBe(endpointDelete.id);
  } finally {
    f.database.close();
  }
});

test("a Consumer batch-size PUT during readiness cannot claim under old settings", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "settings-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "settings-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "settings-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "settings-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const spec = consumerSpec(queue.resourceUid, worker.resourceUid, { maxBatchSize: 10 });
    const consumer = await f.create(QUEUE_CONSUMER_FORM_URL, "settings-consumer", spec);
    const custody = createQueueCustody({ sql: f.sql });
    for (const id of ["settings-one", "settings-two"])
      await custody.admit(
        {
          queueId: v2QueueId(queue.resourceUid),
          messageRetentionSeconds: 3600,
          deliveryDelaySeconds: 0,
        },
        { messageId: id, body: new Uint8Array([1]) },
      );
    let releaseReadiness!: () => void;
    let signalReadiness!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalReadiness = resolve;
    });
    const delivery = createV2QueueDelivery({
      sql: f.sql,
      custody: {
        ...custody,
        async readiness(input) {
          signalReadiness();
          await waiting;
          return custody.readiness(input);
        },
      },
      capability: f.capability,
    });
    const inFlight = delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    await entered;
    const update = await f.engine.acceptUpdate({
      principal,
      key: "settings-consumer-update-key-01",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
      spec: { ...spec, maxBatchSize: 1 },
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: update.id })).effect).toBe("complete");
    releaseReadiness();
    expect((await inFlight).kind).toBe("unknown");
    expect(await f.sql.query("SELECT batch_id FROM queue_v2_batch_executions")).toEqual([]);
    expect(await f.sql.query("SELECT deliveries FROM selfhost_queue_messages")).toEqual([
      { deliveries: 0 },
      { deliveries: 0 },
    ]);
  } finally {
    f.database.close();
  }
});

test("Consumer DELETE drains a crashed pre-send batch without charging delivery", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "drain-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "drain-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "drain-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "drain-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "drain-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid),
    );
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "drain-message", body: new Uint8Array([7]) },
    );
    const delivery = createV2QueueDelivery({ sql: f.sql, custody, capability: f.capability });
    const batch = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    if (batch.kind !== "ready") throw new Error("pre-send batch not registered");
    // Model the crash boundary after the durable cancellation state changed,
    // before its lease refund statement ran. This is not a fabricated send.
    expect(
      (
        await f.sql.run(
          `UPDATE queue_v2_batch_executions
      SET state = 'pre_effect_refused' WHERE batch_id = ? AND state = 'registered'`,
          [batch.batchId],
        )
      ).changes,
    ).toBe(1);
    const deleted = await f.engine.acceptDelete({
      principal,
      key: "drain-consumer-delete-key-01",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(await f.sql.query("SELECT deliveries,lease_token FROM selfhost_queue_messages")).toEqual(
      [{ deliveries: 0, lease_token: null }],
    );
    f.advance(1_000);
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: deleted.id })).effect).toBe("complete");
  } finally {
    f.database.close();
  }
});

test("retiring Consumer reaps only a physically retired expired handler lease", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "retire-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "retire-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "retire-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "retire-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "retire-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid),
    );
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "retire-message", body: new Uint8Array([9]) },
    );
    const delivery = createV2QueueDelivery({ sql: f.sql, custody, capability: f.capability });
    const batch = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    if (batch.kind !== "ready") throw new Error("retiring batch not registered");
    const execution = {
      batchId: batch.batchId,
      reservationToken: batch.reservationToken,
      queueUid: queue.resourceUid,
      consumerUid: consumer.resourceUid,
      generation: batch.generation,
      workerUid: worker.resourceUid,
      servingSourceOperationId: deployment.id,
      workerVersionUid: version.resourceUid,
      workerVersionGeneration: 1,
      incarnationOperationId: "retire-incarnation",
    };
    expect(await authorizeV2QueueBatchSend(f.sql, execution)).toBe("authorized");
    expect(
      await listV2AuthorizedQueueExecutions(f.sql, {
        consumerUid: consumer.resourceUid,
        principal,
        space,
        targetKey,
      }),
    ).toEqual([execution]);
    expect(
      await listV2AuthorizedQueueExecutionsForWorker(f.sql, {
        workerUid: worker.resourceUid,
      }),
    ).toEqual({ executions: [execution], nextCursor: null });
    // Simulate the actual clock passing the persisted message lease deadline;
    // no settlement or native handler receipt is manufactured by this write.
    await f.sql.run("UPDATE selfhost_queue_messages SET lease_expires_at_ms = ?", [Date.now() - 1]);
    const deleted = await f.engine.acceptDelete({
      principal,
      key: "retire-consumer-delete-key-01",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(await f.sql.query("SELECT lease_token FROM selfhost_queue_messages")).toMatchObject([
      { lease_token: batch.claims[0]?.leaseToken },
    ]);
    expect(
      await confirmV2QueueBatchRetirement(f.sql, {
        execution,
        kind: "incarnation_absent",
        receiptDigest: "c".repeat(64),
      }),
    ).toBe("retired");
    expect(
      await listV2AuthorizedQueueExecutions(f.sql, {
        consumerUid: consumer.resourceUid,
        principal,
        space,
        targetKey,
      }),
    ).toEqual([]);
    expect(
      await listV2AuthorizedQueueExecutionsForWorker(f.sql, {
        workerUid: worker.resourceUid,
      }),
    ).toEqual({ executions: [], nextCursor: null });
    await expect(
      custody.reapRetiredV2({
        queueId: v2QueueId(queue.resourceUid),
        consumerId: consumer.resourceUid,
        generation: batch.generation,
        operationClaim: {
          operationId: deleted.id,
          leaseToken: "stale-token",
          resourceUid: consumer.resourceUid,
          principal,
          form: QUEUE_CONSUMER_FORM_URL,
          space,
          name: "retire-consumer",
          backendId: "wrong-backend",
          targetKey,
          backendKey: "wrong-key",
          action: "delete",
          generation: 2,
          specJson: JSON.stringify(consumerSpec(queue.resourceUid, worker.resourceUid)),
        },
      }),
    ).rejects.toThrow();
    expect(await f.sql.query("SELECT lease_token FROM selfhost_queue_messages")).toMatchObject([
      { lease_token: batch.claims[0]?.leaseToken },
    ]);
    f.advance(1_000);
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: deleted.id })).effect).toBe("complete");
    expect(await f.sql.query("SELECT lease_token,deliveries FROM selfhost_queue_messages")).toEqual(
      [{ lease_token: null, deliveries: 1 }],
    );
  } finally {
    f.database.close();
  }
});

test("old physical Queue execution retires only with exact persisted absence proof", async () => {
  const f = fixture();
  let composition: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "absence-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "absence-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "absence-version", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "absence-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "absence-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid),
    );
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "absence-message", body: new Uint8Array([9]) },
    );
    const batch = await createV2QueueDelivery({
      sql: f.sql,
      custody,
      capability: f.capability,
    }).claimRegisteredBatch({ consumerUid: consumer.resourceUid, principal, space, targetKey });
    if (batch.kind !== "ready") throw new Error("absence batch not registered");
    const physicalIncarnation = "physical-incarnation-one";
    expect(
      await authorizeV2QueueBatchSend(f.sql, {
        batchId: batch.batchId,
        reservationToken: batch.reservationToken,
        queueUid: queue.resourceUid,
        consumerUid: consumer.resourceUid,
        generation: batch.generation,
        workerUid: worker.resourceUid,
        servingSourceOperationId: deployment.id,
        workerVersionUid: version.resourceUid,
        workerVersionGeneration: 1,
        incarnationOperationId: physicalIncarnation,
      }),
    ).toBe("authorized");
    await f.engine.acceptDelete({
      principal,
      key: "absence-consumer-delete-key-01",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(
      await f.sql.query("SELECT busy_operation FROM tf_v2_resources WHERE uid = ?", [
        consumer.resourceUid,
      ]),
    ).toMatchObject([{ busy_operation: expect.any(String) }]);
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const privatePort = Number(reservation.port);
    await reservation.stop(true);
    let observedIncarnation = "wrong-physical-incarnation";
    composition = createSelfhostV2QueueComposition({
      sql: f.sql,
      custody,
      capability: f.capability,
      settlementKey: new Uint8Array(32).fill(7),
      privatePort,
      ownerForWorkerUid: async (uid) => {
        expect(uid).toBe(worker.resourceUid);
        return {
          async observeQueuePhysicalAbsence(input: {
            workerUid: string;
            incarnationId: string;
            servingSourceOperationId: string;
          }) {
            return {
              kind: "confirmed_absent" as const,
              workerUid: input.workerUid,
              incarnationId: observedIncarnation,
              servingSourceOperationId: input.servingSourceOperationId,
              receiptDigest: "a".repeat(64),
            };
          },
        } as unknown as WorkerdWorkerRuntimeOwner;
      },
    });
    const scan = { workerUid: worker.resourceUid };
    expect(await composition.reconcileWorkerAuthorizedAbsence(scan)).toEqual({
      kind: "unknown",
      retired: 0,
      nextCursor: null,
    });
    expect(await f.sql.query("SELECT state FROM queue_v2_batch_executions")).toEqual([
      { state: "send_authorized" },
    ]);
    observedIncarnation = physicalIncarnation;
    expect(await composition.reconcileWorkerAuthorizedAbsence(scan)).toEqual({
      kind: "reconciled",
      retired: 1,
      nextCursor: null,
    });
    expect(
      await f.sql.query("SELECT state,retirement_kind FROM queue_v2_batch_executions"),
    ).toEqual([{ state: "retired", retirement_kind: "incarnation_absent" }]);
    expect(await f.sql.query("SELECT state FROM queue_v2_batch_settlements")).toEqual([
      { state: "pending" },
    ]);
    expect(await f.sql.query("SELECT deliveries FROM selfhost_queue_messages")).toEqual([
      { deliveries: 1 },
    ]);
    expect(await composition.reconcileWorkerAuthorizedAbsence(scan)).toEqual({
      kind: "reconciled",
      retired: 0,
      nextCursor: null,
    });
  } finally {
    await composition?.close();
    f.database.close();
  }
});

test("a finished batch whose retirement hit a lock retires from its remembered receipt", async () => {
  const f = fixture();
  let composition: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "locked-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "locked-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "locked-version", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "locked-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "locked-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid),
    );
    const custody = createQueueCustody({ sql: f.sql });
    const admit = async (messageId: string) =>
      await custody.admit(
        {
          queueId: v2QueueId(queue.resourceUid),
          messageRetentionSeconds: 3600,
          deliveryDelaySeconds: 0,
        },
        { messageId, body: new Uint8Array([1]) },
      );
    await admit("locked-message");
    // A lock that outlasts the busy timeout fails the retirement UPDATE twice.
    let lockedRetirements = 2;
    const sql: Sql = {
      query: (statement, params) => f.sql.query(statement, params),
      batch: (statements) => f.sql.batch(statements),
      async run(statement, params) {
        if (lockedRetirements > 0 && statement.includes("SET state = 'retired'")) {
          lockedRetirements -= 1;
          throw new Error("database is locked");
        }
        return await f.sql.run(statement, params);
      },
    };
    const target = {
      workerVersionUid: version.resourceUid,
      workerVersionGeneration: 1,
      incarnationOperationId: "live-physical-incarnation",
    };
    const sent: string[] = [];
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const privatePort = Number(reservation.port);
    await reservation.stop(true);
    composition = createSelfhostV2QueueComposition({
      sql,
      custody,
      capability: f.capability,
      settlementKey: new Uint8Array(32).fill(7),
      privatePort,
      ownerForWorkerUid: async () =>
        ({
          // The child that ran the batch is alive, so absence never applies.
          async observeQueuePhysicalAbsence() {
            return { kind: "unknown" as const };
          },
          async invokeQueue(input: {
            readonly batchId: string;
            authorizeSend(value: typeof target): Promise<string>;
          }) {
            if ((await input.authorizeSend(target)) !== "authorized") return { kind: "unknown" };
            sent.push(input.batchId);
            // Retirement receipts are unique per batch.
            const receiptDigest = (sent.length === 1 ? "b" : "c").repeat(64);
            return { kind: "handler_resolved", ...target, receiptDigest };
          },
        }) as unknown as WorkerdWorkerRuntimeOwner,
    });
    const scope = { consumerUid: consumer.resourceUid, principal, space, targetKey };
    const executions = async () =>
      await f.sql.query(
        "SELECT batch_id,state,retirement_kind,retirement_receipt_digest FROM queue_v2_batch_executions ORDER BY rowid",
      );

    expect(await composition.deliverOnce(scope)).toEqual({ kind: "unknown" });
    expect(sent).toHaveLength(1);
    expect(await executions()).toMatchObject([{ batch_id: sent[0], state: "send_authorized" }]);
    // Still locked: the batch stays occupied, its message leased, and nothing
    // is sent again.
    expect(await composition.deliverOnce(scope)).toEqual({ kind: "idle" });
    expect(sent).toHaveLength(1);
    expect(await executions()).toMatchObject([{ state: "send_authorized" }]);

    // The lock is gone: the same receipt retires the batch and the default ACK lands.
    expect(await composition.deliverOnce(scope)).toEqual({ kind: "idle" });
    expect(await executions()).toEqual([
      {
        batch_id: sent[0],
        state: "retired",
        retirement_kind: "handler_and_wait_until",
        retirement_receipt_digest: "b".repeat(64),
      },
    ]);
    expect(await f.sql.query("SELECT state,outcome FROM queue_v2_batch_settlements")).toEqual([
      { state: "settled", outcome: "ack" },
    ]);
    expect(sent).toHaveLength(1);

    // The Consumer is free again: the next message is delivered at once.
    await admit("next-message");
    expect(await composition.deliverOnce(scope)).toEqual({ kind: "handler_resolved" });
    expect(sent).toHaveLength(2);
    expect(await executions()).toMatchObject([{ state: "retired" }, { state: "retired" }]);
  } finally {
    await composition?.close();
    f.database.close();
  }
});

test("worker-wide authorized recovery advances a bounded 32-row keyset cursor", async () => {
  const rows = Array.from({ length: 34 }, (_, index) => ({
    batch_id: `batch-${String(index + 1).padStart(3, "0")}`,
    reservation_token: `reservation-${index + 1}`,
    queue_id: v2QueueId("cursor-queue"),
    consumer_uid: "cursor-consumer",
    consumer_generation: 1,
    worker_uid: "cursor-worker",
    serving_source_operation_id: "cursor-source",
    worker_version_uid: "cursor-version",
    worker_version_generation: 1,
    incarnation_operation_id: "cursor-physical-incarnation",
  }));
  const sql = {
    async query(statement: string, params?: readonly SqlParam[]) {
      expect(statement).toContain("state = 'send_authorized'");
      expect(params?.[0]).toBe("cursor-worker");
      const after = String(params?.[1] ?? "");
      return rows.filter((row) => row.batch_id > after).slice(0, 33);
    },
  } as unknown as Sql;
  const first = await listV2AuthorizedQueueExecutionsForWorker(sql, {
    workerUid: "cursor-worker",
  });
  expect(first.executions).toHaveLength(32);
  expect(first.nextCursor).toBe("batch-032");
  if (!first.nextCursor) throw new Error("first recovery page did not advance");
  const second = await listV2AuthorizedQueueExecutionsForWorker(sql, {
    workerUid: "cursor-worker",
    afterBatchId: first.nextCursor,
  });
  expect(second.executions.map((row) => row.batchId)).toEqual(["batch-033", "batch-034"]);
  expect(second.nextCursor).toBeNull();
});

test("retiring Consumer retains a DLQ wake notice after terminal copy", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "notice-source", {
      messageRetentionSeconds: 3600,
    });
    const dlq = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "notice-target", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "notice-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "notice-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "notice-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "notice-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid, {
        maxRetries: 0,
        deadLetterQueue: { resourceUid: dlq.resourceUid },
      }),
    );
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "notice-message", body: new Uint8Array([8]) },
    );
    const delivery = createV2QueueDelivery({ sql: f.sql, custody, capability: f.capability });
    const batch = await delivery.claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    if (batch.kind !== "ready") throw new Error("DLQ batch not registered");
    const execution = {
      batchId: batch.batchId,
      reservationToken: batch.reservationToken,
      queueUid: queue.resourceUid,
      consumerUid: consumer.resourceUid,
      generation: batch.generation,
      workerUid: worker.resourceUid,
      servingSourceOperationId: deployment.id,
      workerVersionUid: version.resourceUid,
      workerVersionGeneration: 1,
      incarnationOperationId: "notice-incarnation",
    };
    expect(await authorizeV2QueueBatchSend(f.sql, execution)).toBe("authorized");
    await f.sql.run("UPDATE selfhost_queue_messages SET lease_expires_at_ms = ?", [Date.now() - 1]);
    const deleted = await f.engine.acceptDelete({
      principal,
      key: "notice-consumer-delete-key-01",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(
      await confirmV2QueueBatchRetirement(f.sql, {
        execution,
        kind: "incarnation_absent",
        receiptDigest: "d".repeat(64),
      }),
    ).toBe("retired");
    f.advance(1_000);
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(
      await f.sql.query("SELECT queue_id,message_id FROM selfhost_queue_messages"),
    ).toMatchObject([{ queue_id: v2QueueId(dlq.resourceUid) }]);
    expect(
      await f.sql.query("SELECT target_queue_id,notice_token FROM queue_custody_transfer_notices"),
    ).toMatchObject([{ target_queue_id: v2QueueId(dlq.resourceUid) }]);
    expect((await f.engine.getOperation({ principal, id: deleted.id })).status).toBe("reconciling");
  } finally {
    f.database.close();
  }
});

test("Consumer UPDATE cannot reset a sent handler slot after its message ACK", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "update-queue", {
      messageRetentionSeconds: 3600,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "update-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "update-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "update-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const spec = consumerSpec(queue.resourceUid, worker.resourceUid, { maxConcurrency: 1 });
    const consumer = await f.create(QUEUE_CONSUMER_FORM_URL, "update-consumer", spec);
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "update-message", body: new Uint8Array([7]) },
    );
    const selected = await createV2QueueDelivery({
      sql: f.sql,
      custody,
      capability: f.capability,
    }).claimRegisteredBatch({ consumerUid: consumer.resourceUid, principal, space, targetKey });
    if (selected.kind !== "ready") throw new Error("batch not selected");
    const execution = {
      batchId: selected.batchId,
      reservationToken: selected.reservationToken,
      queueUid: queue.resourceUid,
      consumerUid: consumer.resourceUid,
      generation: selected.generation,
      workerUid: worker.resourceUid,
      servingSourceOperationId: deployment.id,
      workerVersionUid: version.resourceUid,
      workerVersionGeneration: 1,
      incarnationOperationId: "update-incarnation",
    };
    expect(await authorizeV2QueueBatchSend(f.sql, execution)).toBe("authorized");
    const update = await f.engine.acceptUpdate({
      principal,
      key: "update-consumer-policy-key",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
      spec: { ...spec, maxRetries: 3 },
    });
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    const claim = selected.claims[0];
    if (!claim) throw new Error("claim missing");
    expect(
      await custody.settleRegisteredBatchMessage({
        batchId: selected.batchId,
        messageId: claim.messageId,
        expected: {
          queueId: claim.queueId,
          consumerId: claim.consumerId,
          generation: claim.generation,
          leaseToken: claim.leaseToken,
        },
        decision: { outcome: "ack" },
        settlementToken: "update-ack",
      }),
    ).toBe("settled");
    f.advance(1_001);
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(await f.sql.query("SELECT generation, state FROM queue_consumer_custody")).toEqual([
      { generation: 1, state: "retiring" },
    ]);
    expect(
      await confirmV2QueueBatchRetirement(f.sql, {
        execution,
        kind: "handler_and_wait_until",
        receiptDigest: "d".repeat(64),
      }),
    ).toBe("retired");
    f.advance(1_001);
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: update.id })).effect).toBe("complete");
    expect(await f.sql.query("SELECT generation, state FROM queue_consumer_custody")).toEqual([
      { generation: 2, state: "active" },
    ]);
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 3600,
        deliveryDelaySeconds: 0,
      },
      { messageId: "next-generation-message", body: new Uint8Array([8]) },
    );
    const next = await createV2QueueDelivery({
      sql: f.sql,
      custody,
      capability: f.capability,
    }).claimRegisteredBatch({
      consumerUid: consumer.resourceUid,
      principal,
      space,
      targetKey,
    });
    if (next.kind !== "ready") throw new Error("next generation did not claim");
    expect(next.generation).toBe(2);
    const nextExecution = {
      ...execution,
      batchId: next.batchId,
      reservationToken: next.reservationToken,
      generation: next.generation,
      incarnationOperationId: "next-incarnation",
    };
    expect(await authorizeV2QueueBatchSend(f.sql, nextExecution)).toBe("authorized");
    expect(
      await confirmV2QueueBatchRetirement(f.sql, {
        execution: nextExecution,
        kind: "handler_and_wait_until",
        receiptDigest: "d".repeat(64),
      }),
    ).toBe("unknown");
    expect(
      await confirmV2QueueBatchRetirement(f.sql, {
        execution: nextExecution,
        kind: "handler_and_wait_until",
        receiptDigest: "e".repeat(64),
      }),
    ).toBe("retired");
  } finally {
    f.database.close();
  }
});

test("privileged producer admission uses live Queue UID and exact current Version reference", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "orders", {
      messageRetentionSeconds: 3600,
    });
    const version = await f.create(WORKER_VERSION_FORM_URL, "producer", {
      queueUid: queue.resourceUid,
    });
    const custody = createQueueCustody({ sql: f.sql });
    let n = 0;
    const delivery = createV2QueueDelivery({
      sql: f.sql,
      custody,
      capability: f.capability,
      randomId: () => `message-${++n}`,
    });
    const ids = await delivery.admitMessages({
      queueUid: queue.resourceUid,
      producerVersionUid: version.resourceUid,
      principal,
      space,
      targetKey,
      messages: [{ body: new Uint8Array([1, 2]), delaySeconds: 0 }, { body: new Uint8Array([3]) }],
    });
    expect(ids).toEqual(["message-1", "message-2"]);
    expect(
      await f.sql.query(
        "SELECT queue_id,message_id FROM selfhost_queue_messages ORDER BY message_id",
      ),
    ).toEqual([
      { queue_id: v2QueueId(queue.resourceUid), message_id: "message-1" },
      { queue_id: v2QueueId(queue.resourceUid), message_id: "message-2" },
    ]);
    await expect(
      delivery.admitMessages({
        queueUid: queue.resourceUid,
        producerVersionUid: "different-version",
        principal,
        space,
        targetKey,
        messages: [{ body: new Uint8Array([4]) }],
      }),
    ).rejects.toMatchObject({ name: "backend_unavailable" });
    expect(await f.sql.query("SELECT count(*) AS n FROM selfhost_queue_messages")).toEqual([
      { n: 2 },
    ]);
    const deleted = await f.engine.acceptDelete({
      principal,
      key: "producer-delete-key-00001",
      uid: version.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: deleted.id })).effect).toBe("complete");
    await expect(
      delivery.admitMessages({
        queueUid: queue.resourceUid,
        producerVersionUid: version.resourceUid,
        principal,
        space,
        targetKey,
        messages: [{ body: new Uint8Array([5]) }],
      }),
    ).rejects.toMatchObject({ name: "backend_unavailable" });
  } finally {
    f.database.close();
  }
});

test("Queue retention update never revives a message already expired", async () => {
  const f = fixture();
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "orders", {
      messageRetentionSeconds: 60,
    });
    const custody = createQueueCustody({ sql: f.sql });
    await custody.admit(
      {
        queueId: v2QueueId(queue.resourceUid),
        messageRetentionSeconds: 60,
        deliveryDelaySeconds: 0,
      },
      { messageId: "expired-message", body: new Uint8Array([9]) },
    );
    const expiredAt = Date.now() - 1_000;
    await f.sql.run(
      "UPDATE selfhost_queue_messages SET expires_at_ms = ? WHERE queue_id = ? AND message_id = ?",
      [expiredAt, v2QueueId(queue.resourceUid), "expired-message"],
    );
    const update = await f.engine.acceptUpdate({
      principal,
      key: "retention-update-key-0001",
      uid: queue.resourceUid,
      expectedGeneration: 1,
      spec: { messageRetentionSeconds: 120 },
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: update.id })).effect).toBe("complete");
    expect(
      await f.sql.query(
        "SELECT expires_at_ms FROM selfhost_queue_messages WHERE queue_id = ? AND message_id = ?",
        [v2QueueId(queue.resourceUid), "expired-message"],
      ),
    ).toEqual([{ expires_at_ms: expiredAt }]);
  } finally {
    f.database.close();
  }
});

test("Queue retention PUT preserves sent leases and updates only undelivered messages", async () => {
  let authorizeDuringWrite: (() => Promise<void>) | undefined;
  const f = fixture(":memory:", async () => {
    const authorize = authorizeDuringWrite;
    authorizeDuringWrite = undefined;
    await authorize?.();
  });
  try {
    const queue = await f.create(AT_LEAST_ONCE_QUEUE_FORM_URL, "retention-sent-queue", {
      messageRetentionSeconds: 60,
    });
    const worker = await f.create(MODULE_WORKER_FORM_URL, "retention-sent-worker", {});
    const version = await f.create(WORKER_VERSION_FORM_URL, "retention-sent-version", {
      queueUid: queue.resourceUid,
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingVersion(version.resourceUid);
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "retention-sent-deployment", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setServingSource(deployment.id);
    const consumer = await f.create(
      QUEUE_CONSUMER_FORM_URL,
      "retention-sent-consumer",
      consumerSpec(queue.resourceUid, worker.resourceUid, {
        maxBatchSize: 1,
        maxConcurrency: 4,
      }),
    );
    const custody = createQueueCustody({ sql: f.sql });
    const delivery = createV2QueueDelivery({ sql: f.sql, custody, capability: f.capability });
    const admit = async (messageId: string) => {
      await custody.admit(
        {
          queueId: v2QueueId(queue.resourceUid),
          messageRetentionSeconds: 60,
          deliveryDelaySeconds: 0,
        },
        { messageId, body: new Uint8Array([1]) },
      );
    };
    const register = async () => {
      const result = await delivery.claimRegisteredBatch({
        consumerUid: consumer.resourceUid,
        principal,
        space,
        targetKey,
      });
      if (result.kind !== "ready") throw new Error("expected an exact registered batch");
      return result;
    };
    const authorize = async (batch: Awaited<ReturnType<typeof register>>) => {
      expect(
        await authorizeV2QueueBatchSend(f.sql, {
          batchId: batch.batchId,
          reservationToken: batch.reservationToken,
          queueUid: queue.resourceUid,
          consumerUid: consumer.resourceUid,
          generation: batch.generation,
          workerUid: worker.resourceUid,
          servingSourceOperationId: deployment.id,
          workerVersionUid: version.resourceUid,
          workerVersionGeneration: 1,
          incarnationOperationId: `incarnation-${batch.batchId}`,
        }),
      ).toBe("authorized");
    };

    await admit("already-sent");
    await authorize(await register());
    await admit("sent-during-put");
    const racing = await register();
    await admit("claimed-unsent");
    await register();
    await admit("unclaimed");
    const before = await f.sql.query(
      "SELECT message_id,enqueued_at_ms,expires_at_ms,lease_expires_at_ms FROM selfhost_queue_messages WHERE queue_id = ?",
      [v2QueueId(queue.resourceUid)],
    );
    expect(before).toHaveLength(4);
    authorizeDuringWrite = () => authorize(racing);
    const update = await f.engine.acceptUpdate({
      principal,
      key: "retention-sent-update-key-0001",
      uid: queue.resourceUid,
      expectedGeneration: 1,
      spec: { messageRetentionSeconds: 120 },
    });
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    f.advance(1_000);
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal, id: update.id })).effect).toBe("complete");
    const after = await f.sql.query(
      "SELECT message_id,enqueued_at_ms,expires_at_ms,lease_expires_at_ms FROM selfhost_queue_messages WHERE queue_id = ?",
      [v2QueueId(queue.resourceUid)],
    );
    const expiration = (rows: typeof before, messageId: string): number => {
      const row = rows.find((item) => item.message_id === messageId);
      if (!row || typeof row.expires_at_ms !== "number" || typeof row.enqueued_at_ms !== "number")
        throw new Error(`missing retention evidence for ${messageId}`);
      return row.expires_at_ms;
    };
    for (const messageId of ["already-sent", "sent-during-put"]) {
      expect(expiration(after, messageId)).toBe(expiration(before, messageId));
    }
    for (const messageId of ["claimed-unsent", "unclaimed"]) {
      const row = after.find((item) => item.message_id === messageId);
      if (!row || typeof row.enqueued_at_ms !== "number") throw new Error("missing message");
      expect(expiration(after, messageId)).toBe(row.enqueued_at_ms + 120_000);
    }
    for (const row of before) {
      expect(after.find((item) => item.message_id === row.message_id)?.lease_expires_at_ms).toBe(
        row.lease_expires_at_ms,
      );
    }
  } finally {
    f.database.close();
  }
});
