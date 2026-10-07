import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createSelfhostV2QueueComposition } from "../src/selfhost-v2-queue-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
import {
  parseWorkerBundleManifest,
  validateWorkerBundlePayload,
} from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import type { V2WorkerPublicationResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { createAtLeastOnceQueueForm } from "../src/takoform-v2/worker-queue-backend.ts";
import { createQueueConsumerForm } from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import {
  cancelV2QueueBatchBeforeSend,
  createV2QueueDelivery,
  v2QueueId,
} from "../src/takoform-v2/worker-queue-delivery.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";
import {
  openWorkerdWorkerRuntimeOwner,
  type WorkerdWorkerRuntimeOwner,
} from "../src/workerd-worker-runtime-owner.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");
const principal = "native-queue-principal";
const space = "default";
const targetKey = "native-queue-target";
const modulePath = "app.mjs";
const pidFixtureMode = process.env.TAKOSERVER_QUEUE_PID_FIXTURE;
const waitUntilMillis = pidFixtureMode === "first" || pidFixtureMode === "recover" ? 30_000 : 180;
const moduleBytes = new TextEncoder().encode(`
export default {
  async queue(batch, _env, ctx) {
    if (batch.messages[0].id.startsWith("message-late-"))
      await new Promise((resolve) => setTimeout(resolve, 450));
    if ((batch.messages[0].id === "message-retry" ||
         batch.messages[0].id === "message-late-retry") && batch.messages[0].attempts === 1)
      throw new Error("retry once");
    await batch.acknowledgeAll();
    ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, ${waitUntilMillis})));
  },
};
`);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

test.skipIf(binary === undefined)(
  "real 0082/0083 custody + exact native owner holds maxConcurrency after early ACK until waitUntil completes",
  async () => {
    if (!binary) throw new Error("pinned Workerd missing");
    const root =
      pidFixtureMode === "first"
        ? (process.env.TAKOSERVER_QUEUE_PID_ROOT ?? "")
        : await mkdtemp(join(tmpdir(), "v2-queue-native-core-"));
    if (!root) throw new Error("Queue PID fixture root missing");
    await chmod(root, 0o700);
    const db = new Database(join(root, "state.sqlite"));
    const children: ReturnType<typeof spawnWorkerdWithParentDeath>[] = [];
    let owner: WorkerdWorkerRuntimeOwner | undefined;
    let queueComposition: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: join(root, "binary"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "native binary unavailable");
      migrateSqlite(db);
      const sql = createSqliteSql(db);
      const custody = createQueueCustody({ sql });
      const store = createV2Store(sql);
      const manifestUrl = "https://artifacts.example.test/native-queue/manifest.json";
      const moduleUrl = "https://artifacts.example.test/native-queue/app.mjs";
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: modulePath,
          files: [
            {
              path: modulePath,
              url: moduleUrl,
              sha256: sha(moduleBytes),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const held = {
        manifest: parseWorkerBundleManifest(manifestBytes),
        manifestBytes,
        files: [moduleBytes],
        observed: (
          await validateWorkerBundlePayload({
            spec: { artifact: { url: manifestUrl, sha256: sha(manifestBytes) } },
            manifestBytes,
            fileBytes: [moduleBytes],
          })
        ).observed,
      };
      const inspector = createWorkerdWorkerModuleInspector({ binary: selected.binary });
      const inspected = await inspector.inspect({
        mainModule: modulePath,
        modules: [
          {
            name: modulePath,
            mediaType: "application/javascript+module",
            bytes: moduleBytes,
            digest: `sha256:${sha(moduleBytes)}`,
          },
        ],
        declaredHandlers: ["queue"],
      });
      expect(inspected).toMatchObject({ outcome: "valid", exportedHandlers: ["queue"] });
      if (inspected.outcome !== "valid") throw new Error("native queue export inspection failed");
      let workerUid = "";
      let versionUid = "";
      let deploymentUid = "";
      let sourceOperationId = "";
      const versionSpec = () => ({
        worker: { resourceUid: workerUid },
        bundle: { resourceUid: "native-queue-bundle" },
        handlers: ["queue"],
      });
      const snapshot = () => ({
        sourceOperationId,
        worker: { uid: workerUid, principal, space, generation: 1 },
        deployment: {
          uid: deploymentUid,
          generation: 1,
          spec: {
            worker: { resourceUid: workerUid },
            versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
          },
          versions: [{ uid: versionUid, generation: 1, weight: 10_000, spec: versionSpec() }],
        },
        endpoint: null,
      });
      const serving = () => ({
        kind: "ready" as const,
        snapshot: snapshot(),
        sqlGuard: { sql: "SELECT 1", params: [] },
        stillCurrent: async () => true,
        readVersionMaterials: async () => ({ bundle: held, assets: null }),
      });
      const publicationState = {
        async resolve({
          execution,
        }: {
          execution: V2Execution;
        }): Promise<V2WorkerPublicationResolution> {
          return execution.operationId === sourceOperationId
            ? (serving() as unknown as V2WorkerPublicationResolution)
            : { kind: "unresolved", code: "stale_claim", message: "wrong operation" };
        },
        async resolveCurrentServing(input: {
          workerUid: string;
          targetKey: string;
          sourceOperationId: string;
        }) {
          return input.workerUid === workerUid &&
            input.targetKey === targetKey &&
            input.sourceOperationId === sourceOperationId
            ? (serving() as unknown as V2WorkerPublicationResolution)
            : {
                kind: "unresolved" as const,
                code: "graph_unresolved" as const,
                message: "wrong source",
              };
        },
      };
      const capability = {
        async observeQueueServingCapability(input: {
          workerUid: string;
          principal: string;
          space: string;
          targetKey: string;
        }) {
          // Admission must use the installed native owner's current SQL graph
          // and boot-inspected queue export proof, never the fixture snapshot
          // alone or a caller-supplied ready flag.
          return owner
            ? await owner.observeQueueServingCapability(input)
            : ({ kind: "unknown" } as const);
        },
        async observeCurrentServing(input: {
          workerUid: string;
          principal: string;
          space: string;
          targetKey: string;
        }) {
          return input.workerUid === workerUid &&
            input.principal === principal &&
            input.space === space &&
            input.targetKey === targetKey
            ? (serving() as never)
            : {
                kind: "unresolved" as const,
                code: "graph_unresolved" as const,
                message: "wrong scope",
              };
        },
      };
      const ordinary: V2Form = {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "native-queue-ordinary",
          targetKey,
          async execute(execution) {
            // The fixture records the actual held-byte and pinned native
            // inspection result, while Core still checks the accepted SQL
            // Version/Deployment identity at Consumer admission.
            const observed =
              execution.form === WORKER_VERSION_FORM_URL
                ? { ready: true, bundleVerified: true, resolvedBindings: true }
                : execution.form === WORKER_DEPLOYMENT_FORM_URL
                  ? { active: true }
                  : { ready: true };
            return { kind: "complete" as const, observed, output: {} };
          },
          async reconcile() {
            return { kind: "unknown" as const };
          },
        },
      };
      const engine = createTakoformV2Engine({
        sql,
        now: () => new Date(),
        replayWindowSeconds: 3600,
        leaseMilliseconds: 60_000,
        authorize: async () => true,
        forms: {
          [MODULE_WORKER_FORM_URL]: ordinary,
          [WORKER_VERSION_FORM_URL]: ordinary,
          [WORKER_DEPLOYMENT_FORM_URL]: ordinary,
          [AT_LEAST_ONCE_QUEUE_FORM_URL]: createAtLeastOnceQueueForm({ sql, targetKey }),
          [QUEUE_CONSUMER_FORM_URL]: createQueueConsumerForm({ sql, targetKey, capability }),
        },
      });
      const create = async (form: string, name: string, spec: JsonObject) => {
        const accepted = await engine.acceptCreate({
          principal,
          key: `native-queue-create-${name}-key-00000001`,
          input: { form, space, name, spec },
        });
        expect((await engine.runNext())?.status).toBe("succeeded");
        return accepted;
      };
      const queue = await create(AT_LEAST_ONCE_QUEUE_FORM_URL, "queue", {
        messageRetentionSeconds: 3600,
      });
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      workerUid = worker.resourceUid;
      const version = await create(WORKER_VERSION_FORM_URL, "version", versionSpec());
      versionUid = version.resourceUid;
      const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: workerUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      deploymentUid = deployment.resourceUid;
      sourceOperationId = deployment.id;
      const settlementKey = randomBytes(32);
      const privatePort = await unusedPort();
      queueComposition = createSelfhostV2QueueComposition({
        sql,
        custody,
        capability,
        settlementKey,
        privatePort,
        renewalIntervalMillis: 50,
        ownerForWorkerUid: async (uid) => {
          if (!owner || uid !== workerUid) throw new Error("unknown owner");
          return owner;
        },
      });
      owner = await openWorkerdWorkerRuntimeOwner({
        rootDirectory: join(root, "owner"),
        workerResourceUid: workerUid,
        targetKey,
        publicationState,
        workerdBinary: selected.binary,
        inspectModule: inspector.inspect.bind(inspector),
        v2QueueSettlement: queueComposition.settlementBinding,
        listenerPortForOperation: unusedPort,
        spawn(command) {
          const child = spawnWorkerdWithParentDeath(command, {
            stdout: "ignore",
            stderr: "ignore",
          });
          children.push(child);
          return child;
        },
      });
      const op = await store.operation(deployment.id);
      const resource = op && (await store.resource(op.resource_uid));
      if (!op || !resource) throw new Error("accepted Deployment missing");
      const execution: V2Execution = {
        operationId: op.id,
        leaseToken: "native-queue-execution-lease",
        backendKey: op.backend_key,
        backendId: op.backend_id,
        targetKey: op.target_key,
        resourceUid: resource.uid,
        principal: op.principal,
        action: op.action,
        generation: op.generation,
        form: resource.form_url,
        space: resource.space,
        name: resource.name,
        spec: JSON.parse(op.accepted_spec_json),
        previousObserved: {},
        previousOutput: {},
      };
      expect(await owner.execute(execution)).toMatchObject({ kind: "confirmed" });
      const admitted = await owner.observeQueueServingCapability({
        workerUid,
        principal,
        space,
        targetKey,
      });
      expect(admitted).toMatchObject({
        kind: "confirmed",
        servingSourceOperationId: sourceOperationId,
        versions: [{ workerVersionUid: versionUid, generation: 1, weight: 10_000 }],
      });
      if (admitted.kind !== "confirmed") throw new Error("Queue native serving capability missing");
      expect(await admitted.stillCurrent()).toBe(true);
      expect(
        await owner.observeQueueServingCapability({
          workerUid,
          principal: "foreign",
          space,
          targetKey,
        }),
      ).toEqual({ kind: "unknown" });
      const consumer = await create(QUEUE_CONSUMER_FORM_URL, "consumer", {
        queue: { resourceUid: queue.resourceUid },
        worker: { resourceUid: workerUid },
        maxBatchSize: 1,
        maxBatchTimeoutSeconds: 0,
        maxConcurrency: 1,
        maxRetries: 1,
        retryDelaySeconds: 0,
      });
      for (const id of ["message-one", "message-two"]) {
        await custody.admit(
          {
            queueId: v2QueueId(queue.resourceUid),
            messageRetentionSeconds: 3600,
            deliveryDelaySeconds: 0,
          },
          { messageId: id, body: new TextEncoder().encode(id) },
        );
      }
      const scope = { consumerUid: consumer.resourceUid, principal, space, targetKey };
      const first = queueComposition.deliverOnce(scope);
      const deadline = Date.now() + 5_000;
      let occupiedAfterAck = false;
      while (Date.now() < deadline) {
        const [executions, receipts] = await Promise.all([
          sql.query("SELECT state FROM queue_v2_batch_executions ORDER BY reserved_at_ms"),
          sql.query("SELECT state FROM queue_v2_batch_settlements ORDER BY batch_id"),
        ]);
        if (executions[0]?.state === "send_authorized" && receipts[0]?.state === "settled") {
          occupiedAfterAck = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(occupiedAfterAck).toBe(true);
      if (pidFixtureMode === "first") {
        await writeFile(join(root, "settlement.key"), settlementKey, { mode: 0o600 });
        await writeFile(
          join(root, "queue-pid-meta.json"),
          JSON.stringify({
            workerUid,
            versionUid,
            deploymentUid,
            sourceOperationId,
            consumerUid: consumer.resourceUid,
            queueUid: queue.resourceUid,
            privatePort,
            nativePid: children[0]?.pid,
          }),
          { mode: 0o600 },
        );
        process.stdout.write(
          `QUEUE_PID_READY ${JSON.stringify({
            hostPid: process.pid,
            nativePid: children[0]?.pid,
          })}\n`,
        );
        await new Promise<void>(() => {});
      }
      expect(await queueComposition.deliverOnce(scope)).toEqual({ kind: "idle" });
      const firstResult = await first;
      expect(firstResult).toEqual({ kind: "handler_resolved" });
      expect(
        await sql.query(
          "SELECT state, retirement_kind FROM queue_v2_batch_executions ORDER BY reserved_at_ms LIMIT 1",
        ),
      ).toEqual([{ state: "retired", retirement_kind: "handler_and_wait_until" }]);
      expect(await queueComposition.deliverOnce(scope)).toEqual({ kind: "handler_resolved" });
      expect(await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages")).toEqual([
        { n: 0 },
      ]);
      await custody.admit(
        {
          queueId: v2QueueId(queue.resourceUid),
          messageRetentionSeconds: 3600,
          deliveryDelaySeconds: 0,
        },
        { messageId: "message-retry", body: new TextEncoder().encode("retry") },
      );
      expect(await queueComposition.deliverOnce(scope)).toEqual({ kind: "handler_rejected" });
      expect(
        await sql.query(
          "SELECT deliveries FROM selfhost_queue_messages WHERE message_id = 'message-retry'",
        ),
      ).toEqual([{ deliveries: 1 }]);
      expect(await queueComposition.deliverOnce(scope)).toEqual({ kind: "handler_resolved" });
      expect(await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages")).toEqual([
        { n: 0 },
      ]);
      // Compress the 120s lease to 180ms while the real native handler is
      // blocked. The owner must renew from exact 0083/0082 SQL custody; both
      // tenant ACK and handler-throw default retry land after that first lease.
      for (const [id, expected] of [
        ["message-late-ack", "handler_resolved"],
        ["message-late-retry", "handler_rejected"],
      ] as const) {
        await custody.admit(
          {
            queueId: v2QueueId(queue.resourceUid),
            messageRetentionSeconds: 3600,
            deliveryDelaySeconds: 0,
          },
          { messageId: id, body: new TextEncoder().encode(id) },
        );
        const invoked = queueComposition.deliverOnce(scope);
        const sentDeadline = Date.now() + 5_000;
        while (Date.now() < sentDeadline) {
          const rows = await sql.query(
            "SELECT state FROM queue_v2_batch_executions ORDER BY reserved_at_ms DESC LIMIT 1",
          );
          if (rows[0]?.state === "send_authorized") break;
          await Bun.sleep(10);
        }
        const shortLease = Date.now() + 180;
        if (id === "message-late-ack" || id === "message-late-retry") {
          // Retention applies to undelivered messages. This one is already in
          // an exact native invocation; its ACK/default retry must complete.
          await sql.run(
            "UPDATE selfhost_queue_messages SET expires_at_ms = ? WHERE message_id = ?",
            [Date.now() + 90, id],
          );
        }
        expect(
          (
            await sql.run(
              "UPDATE selfhost_queue_messages SET lease_expires_at_ms = ? WHERE message_id = ? AND lease_token IS NOT NULL",
              [shortLease, id],
            )
          ).changes,
        ).toBe(1);
        const [sent] = await sql.query(
          `SELECT batch_id, reservation_token, queue_id, consumer_uid,
                  consumer_generation, worker_uid, serving_source_operation_id,
                  worker_version_uid, worker_version_generation, incarnation_operation_id
           FROM queue_v2_batch_executions WHERE state = 'send_authorized'
           ORDER BY reserved_at_ms DESC LIMIT 1`,
        );
        const exactExecution = {
          batchId: String(sent?.batch_id),
          reservationToken: String(sent?.reservation_token),
          queueId: String(sent?.queue_id),
          consumerUid: String(sent?.consumer_uid),
          generation: Number(sent?.consumer_generation),
          workerUid: String(sent?.worker_uid),
          servingSourceOperationId: String(sent?.serving_source_operation_id),
          workerVersionUid: String(sent?.worker_version_uid),
          workerVersionGeneration: Number(sent?.worker_version_generation),
          incarnationOperationId: String(sent?.incarnation_operation_id),
        };
        expect(
          await custody.renewRegisteredV2BatchLeases({
            ...exactExecution,
            workerVersionUid: "foreign-version",
          }),
        ).toBe("unknown");
        expect(
          await custody.renewRegisteredV2BatchLeases({
            ...exactExecution,
            incarnationOperationId: "foreign-incarnation",
          }),
        ).toBe("unknown");
        await Bun.sleep(230);
        const lease = await sql.query(
          "SELECT lease_expires_at_ms FROM selfhost_queue_messages WHERE message_id = ?",
          [id],
        );
        expect(Number(lease[0]?.lease_expires_at_ms)).toBeGreaterThan(shortLease);
        if (id === "message-late-ack") {
          const renewedLease = Number(lease[0]?.lease_expires_at_ms);
          await sql.run(
            "UPDATE selfhost_queue_messages SET lease_expires_at_ms = ? WHERE message_id = ?",
            [Date.now() - 1, id],
          );
          expect(await custody.renewRegisteredV2BatchLeases(exactExecution)).toBe("unknown");
          await custody.admit(
            {
              queueId: v2QueueId(queue.resourceUid),
              messageRetentionSeconds: 3600,
              deliveryDelaySeconds: 0,
            },
            { messageId: "expired-undelivered", body: new Uint8Array([9]) },
          );
          // Directly probe bounded custody maintenance: the expired sent lease
          // must not consume its reap page and hide another ready message.
          const [other] = await custody.claim({
            queueId: v2QueueId(queue.resourceUid),
            consumerId: consumer.resourceUid,
            generation: 1,
            limit: 1,
          });
          expect(other?.messageId).toBe("expired-undelivered");
          if (!other) throw new Error("ready message hidden behind sent lease");
          expect(await custody.release(other)).toBe(true);
          await sql.run(
            "UPDATE selfhost_queue_messages SET lease_expires_at_ms = ? WHERE message_id = ?",
            [renewedLease, id],
          );
          // The oldest expired sent row must not starve a later expired
          // undelivered row when a bounded sweep takes only one candidate.
          await sql.run(
            "UPDATE selfhost_queue_messages SET expires_at_ms = ? WHERE message_id = 'expired-undelivered'",
            [Date.now() - 1],
          );
          expect(await custody.sweepExpired(1)).toBe(1);
          expect(
            await sql.query("SELECT message_id FROM selfhost_queue_messages WHERE message_id = ?", [
              id,
            ]),
          ).toEqual([{ message_id: id }]);
        }
        expect(await invoked).toEqual({ kind: expected });
        if (expected === "handler_rejected") {
          expect(await queueComposition.deliverOnce(scope)).toEqual({ kind: "idle" });
          expect(
            await sql.query("SELECT message_id FROM selfhost_queue_messages WHERE message_id = ?", [
              id,
            ]),
          ).toEqual([]);
        }
      }
      expect(await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages")).toEqual([
        { n: 0 },
      ]);
      const nativeVersionId = `v2-${sha(new TextEncoder().encode(`${versionUid}\u00001`))}`;
      expect(
        await owner.observeQueueTarget({
          workerUid,
          versionId: nativeVersionId,
          incarnationId: sourceOperationId,
          servingSourceOperationId: sourceOperationId,
        }),
      ).toMatchObject({ kind: "confirmed", status: "active" });
      expect(
        await owner.observeQueueTarget({
          workerUid,
          versionId: versionUid,
          incarnationId: sourceOperationId,
          servingSourceOperationId: sourceOperationId,
        }),
      ).toEqual({ kind: "unknown" });
      await custody.admit(
        {
          queueId: v2QueueId(queue.resourceUid),
          messageRetentionSeconds: 3600,
          deliveryDelaySeconds: 0,
        },
        { messageId: "message-wrong-vector", body: new TextEncoder().encode("wrong-vector") },
      );
      const reserved = await createV2QueueDelivery({
        sql,
        custody,
        capability,
      }).claimRegisteredBatch(scope);
      expect(reserved.kind).toBe("ready");
      if (reserved.kind !== "ready") throw new Error("Queue reservation missing");
      const invokedOwner = owner;
      if (!invokedOwner) throw new Error("native owner missing");
      let authorizeCalls = 0;
      const rejectWrongVector = async (versions: typeof reserved.versions) =>
        await invokedOwner.invokeQueue({
          ...reserved,
          versions,
          mintCapability: () => "unreachable",
          renewalIntervalMillis: 30_000,
          renewLease: async () => false,
          authorizeSend: async () => {
            authorizeCalls++;
            return "authorized" as const;
          },
        });
      expect(
        await rejectWrongVector([
          { workerVersionUid: "foreign-version", generation: 1, weight: 10_000 },
        ]),
      ).toEqual({ kind: "unknown" });
      expect(
        await rejectWrongVector([{ workerVersionUid: versionUid, generation: 2, weight: 10_000 }]),
      ).toEqual({ kind: "unknown" });
      expect(authorizeCalls).toBe(0);
      expect(await cancelV2QueueBatchBeforeSend(sql, reserved)).toBe(true);
      await queueComposition.close();
      let unknownSends = 0;
      queueComposition = createSelfhostV2QueueComposition({
        sql,
        custody,
        capability,
        settlementKey,
        privatePort,
        ownerForWorkerUid: async (uid) => {
          if (uid !== workerUid) throw new Error("foreign Worker");
          return {
            ...invokedOwner,
            async invokeQueue(input) {
              unknownSends++;
              expect(
                await input.authorizeSend({
                  workerVersionUid: versionUid,
                  workerVersionGeneration: 1,
                  incarnationOperationId: sourceOperationId,
                }),
              ).toBe("authorized");
              // The send may have happened. Lost native response is not proof
              // of handler completion and must leave the 0083 slot occupied.
              return { kind: "unknown" } as const;
            },
          };
        },
      });
      expect(await queueComposition.deliverOnce(scope)).toEqual({ kind: "unknown" });
      expect(
        await sql.query(
          "SELECT state FROM queue_v2_batch_executions WHERE state = 'send_authorized'",
        ),
      ).toEqual([{ state: "send_authorized" }]);
      expect(await queueComposition.deliverOnce(scope)).toEqual({ kind: "idle" });
      expect(unknownSends).toBe(1);
    } finally {
      await queueComposition?.close().catch(() => undefined);
      await owner?.close().catch(() => undefined);
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(pidFixtureMode !== "recover")(
  "recover reserved Queue batch in a different Host PID without resending",
  async () => {
    if (!binary) throw new Error("pinned Workerd missing");
    const root = process.env.TAKOSERVER_QUEUE_PID_ROOT;
    if (!root) throw new Error("Queue PID fixture root missing");
    const meta = JSON.parse(await readFile(join(root, "queue-pid-meta.json"), "utf8")) as {
      workerUid: string;
      versionUid: string;
      deploymentUid: string;
      sourceOperationId: string;
      consumerUid: string;
      queueUid: string;
      privatePort: number;
      nativePid: number;
    };
    const db = new Database(join(root, "state.sqlite"));
    const children: ReturnType<typeof spawnWorkerdWithParentDeath>[] = [];
    let owner: WorkerdWorkerRuntimeOwner | undefined;
    let composition: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
    try {
      migrateSqlite(db);
      const sql = createSqliteSql(db);
      const custody = createQueueCustody({ sql });
      const manifestUrl = "https://artifacts.example.test/native-queue/manifest.json";
      const moduleUrl = "https://artifacts.example.test/native-queue/app.mjs";
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: modulePath,
          files: [
            {
              path: modulePath,
              url: moduleUrl,
              sha256: sha(moduleBytes),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const held = {
        manifest: parseWorkerBundleManifest(manifestBytes),
        manifestBytes,
        files: [moduleBytes],
        observed: (
          await validateWorkerBundlePayload({
            spec: { artifact: { url: manifestUrl, sha256: sha(manifestBytes) } },
            manifestBytes,
            fileBytes: [moduleBytes],
          })
        ).observed,
      };
      const versionSpec = () => ({
        worker: { resourceUid: meta.workerUid },
        bundle: { resourceUid: "native-queue-bundle" },
        handlers: ["queue"],
      });
      const serving = () => ({
        kind: "ready" as const,
        snapshot: {
          sourceOperationId: meta.sourceOperationId,
          worker: { uid: meta.workerUid, principal, space, generation: 1 },
          deployment: {
            uid: meta.deploymentUid,
            generation: 1,
            spec: {
              worker: { resourceUid: meta.workerUid },
              versions: [{ workerVersion: { resourceUid: meta.versionUid }, weight: 10_000 }],
            },
            versions: [
              {
                uid: meta.versionUid,
                generation: 1,
                weight: 10_000,
                spec: versionSpec(),
              },
            ],
          },
          endpoint: null,
        },
        sqlGuard: { sql: "SELECT 1", params: [] },
        stillCurrent: async () => true,
        readVersionMaterials: async () => ({ bundle: held, assets: null }),
      });
      const publicationState = {
        async resolve({
          execution,
        }: {
          execution: V2Execution;
        }): Promise<V2WorkerPublicationResolution> {
          return execution.operationId === meta.sourceOperationId
            ? (serving() as unknown as V2WorkerPublicationResolution)
            : { kind: "unresolved", code: "stale_claim", message: "wrong operation" };
        },
        async resolveCurrentServing(input: {
          workerUid: string;
          targetKey: string;
          sourceOperationId: string;
        }) {
          return input.workerUid === meta.workerUid &&
            input.targetKey === targetKey &&
            input.sourceOperationId === meta.sourceOperationId
            ? (serving() as unknown as V2WorkerPublicationResolution)
            : {
                kind: "unresolved" as const,
                code: "graph_unresolved" as const,
                message: "wrong source",
              };
        },
      };
      const capability = {
        async observeQueueServingCapability(input: {
          workerUid: string;
          principal: string;
          space: string;
          targetKey: string;
        }) {
          return owner
            ? await owner.observeQueueServingCapability(input)
            : ({ kind: "unknown" } as const);
        },
        async observeCurrentServing(input: {
          workerUid: string;
          principal: string;
          space: string;
          targetKey: string;
        }) {
          return input.workerUid === meta.workerUid &&
            input.principal === principal &&
            input.space === space &&
            input.targetKey === targetKey
            ? (serving() as never)
            : {
                kind: "unresolved" as const,
                code: "graph_unresolved" as const,
                message: "wrong scope",
              };
        },
      };
      const signingKey = await readFile(join(root, "settlement.key"));
      composition = createSelfhostV2QueueComposition({
        sql,
        custody,
        capability,
        settlementKey: signingKey,
        privatePort: meta.privatePort,
        ownerForWorkerUid: async (uid) => {
          if (!owner || uid !== meta.workerUid) throw new Error("unknown owner");
          return owner;
        },
      });
      const inspector = createWorkerdWorkerModuleInspector({ binary });
      owner = await openWorkerdWorkerRuntimeOwner({
        rootDirectory: join(root, "owner"),
        workerResourceUid: meta.workerUid,
        targetKey,
        publicationState,
        workerdBinary: binary,
        inspectModule: inspector.inspect.bind(inspector),
        v2QueueSettlement: composition.settlementBinding,
        listenerPortForOperation: unusedPort,
        spawn(command) {
          const child = spawnWorkerdWithParentDeath(command, {
            stdout: "ignore",
            stderr: "ignore",
          });
          children.push(child);
          return child;
        },
      });
      const nativeVersionId = `v2-${sha(new TextEncoder().encode(`${meta.versionUid}\u00001`))}`;
      expect(
        await owner.observeQueueTarget({
          workerUid: meta.workerUid,
          versionId: nativeVersionId,
          incarnationId: meta.sourceOperationId,
          servingSourceOperationId: meta.sourceOperationId,
        }),
      ).toMatchObject({ kind: "confirmed", status: "active" });
      expect(
        await owner.observeQueueServingCapability({
          workerUid: meta.workerUid,
          principal,
          space,
          targetKey,
        }),
      ).toMatchObject({ kind: "confirmed", servingSourceOperationId: meta.sourceOperationId });
      expect(
        await sql.query(
          "SELECT state FROM queue_v2_batch_executions WHERE state = 'send_authorized'",
        ),
      ).toEqual([{ state: "send_authorized" }]);
      expect(
        await composition.deliverOnce({
          consumerUid: meta.consumerUid,
          principal,
          space,
          targetKey,
        }),
      ).toEqual({ kind: "idle" });
      await writeFile(
        join(root, "queue-pid-recovered.json"),
        JSON.stringify({
          hostPid: process.pid,
          nativePid: children[0]?.pid,
          servingSourceOperationId: meta.sourceOperationId,
        }),
        { mode: 0o600 },
      );
      await new Promise<void>(() => {});
    } finally {
      await composition?.close().catch(() => undefined);
      await owner?.close().catch(() => undefined);
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      db.close();
    }
  },
);

test.skipIf(binary === undefined || pidFixtureMode !== undefined)(
  "OS Host PID restart retains authorized Queue batch and forbids second send",
  async () => {
    if (!binary) throw new Error("pinned Workerd missing");
    const root = await mkdtemp(join(tmpdir(), "v2-queue-host-pid-restart-"));
    await chmod(root, 0o700);
    const fixture = (mode: "first" | "recover") =>
      Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "test",
          import.meta.path,
          "-t",
          mode === "first" ? "real 0082/0083 custody" : "recover reserved Queue batch",
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            TMPDIR: process.env.TMPDIR ?? tmpdir(),
            TAKOSERVER_QUEUE_PID_FIXTURE: mode,
            TAKOSERVER_QUEUE_PID_ROOT: root,
            TAKOSERVER_WORKERD_BINARY: binary,
          },
        },
      );
    const waitForFile = async (name: string, child: ReturnType<typeof fixture>) => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        try {
          return JSON.parse(await readFile(join(root, name), "utf8")) as Record<string, unknown>;
        } catch {
          if (child.exitCode !== null)
            throw new Error(`Queue PID fixture exited: ${await new Response(child.stderr).text()}`);
          await Bun.sleep(10);
        }
      }
      throw new Error(`Queue PID fixture did not write ${name}`);
    };
    let first: ReturnType<typeof fixture> | undefined;
    let second: ReturnType<typeof fixture> | undefined;
    try {
      first = fixture("first");
      const meta = await waitForFile("queue-pid-meta.json", first);
      const firstHostPid = first.pid;
      const firstNativePid = meta.nativePid;
      first.kill("SIGKILL");
      await first.exited;
      second = fixture("recover");
      const recovered = await waitForFile("queue-pid-recovered.json", second);
      expect(recovered.hostPid).not.toBe(firstHostPid);
      expect(recovered.nativePid).not.toBe(firstNativePid);
      expect(recovered.servingSourceOperationId).toBe(meta.sourceOperationId);
      const db = new Database(join(root, "state.sqlite"), { readonly: true });
      try {
        const sql = createSqliteSql(db);
        expect(
          await sql.query(
            "SELECT state FROM queue_v2_batch_executions WHERE state = 'send_authorized'",
          ),
        ).toEqual([{ state: "send_authorized" }]);
        expect(await sql.query("SELECT count(*) AS n FROM queue_v2_batch_executions")).toEqual([
          { n: 1 },
        ]);
      } finally {
        db.close();
      }
    } finally {
      if (first && first.exitCode === null) first.kill("SIGKILL");
      if (second && second.exitCode === null) second.kill("SIGKILL");
      await Promise.all([first?.exited, second?.exited]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
