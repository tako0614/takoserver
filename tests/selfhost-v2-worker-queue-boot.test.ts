import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createSelfhostV2QueueComposition } from "../src/selfhost-v2-queue-composition.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createAtLeastOnceQueueForm } from "../src/takoform-v2/worker-queue-backend.ts";
import type { V2QueueConsumerCapability } from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import { createQueueConsumerForm } from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import { v2QueueId } from "../src/takoform-v2/worker-queue-delivery.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

test("normal Worker factory requires the exact prebuilt Queue boot before restore and exposes a fail-closed real capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-queue-boot-"));
  const db = new Database(join(root, "state.sqlite"));
  let queue: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const custody = createQueueCustody({ sql });
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    const config = {
      cursorSigningKey: new Uint8Array(32).fill(0x52),
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    };
    const targetKey = "queue-boot-target";
    let workers: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    const ownerForWorkerUid = async (uid: string): Promise<WorkerdWorkerRuntimeOwner> => {
      if (!workers) throw new Error("Worker factory has not been composed");
      return await workers.ownerForWorkerUid(uid);
    };
    const forward: V2QueueConsumerCapability = {
      async observeQueueServingCapability(input) {
        if (!workers?.queueCapability) throw new Error("native Queue capability is not composed");
        return await workers.queueCapability.observeQueueServingCapability(input);
      },
      async observeCurrentServing(input) {
        if (!workers?.queueCapability) throw new Error("native Queue capability is not composed");
        return await workers.queueCapability.observeCurrentServing(input);
      },
    };
    queue = createSelfhostV2QueueComposition({
      sql,
      custody,
      capability: forward,
      settlementKey: new Uint8Array(32).fill(0x41),
      privatePort: await unusedPort(),
      ownerForWorkerUid,
    });
    workers = createSelfhostV2WorkerComposition({
      sql,
      objects,
      clock,
      config,
      rootDirectory: join(root, "owners"),
      targetKey,
      workerdBinary: null,
      queueSettlement: queue.settlementBinding,
      endpoint: {
        assignHostname: () => "worker.example.test",
        async observeTls(input) {
          return { ...input, ready: false };
        },
        async observeRouteAbsent(input) {
          return { ...input, absent: true };
        },
      },
    });
    const scope = {
      workerUid: "missing-worker",
      principal: "org:one",
      space: "default",
      targetKey,
    };
    expect(await workers.queueCapability?.observeQueueServingCapability(scope)).toEqual({
      kind: "unknown",
    });
    expect(await workers.restoreOwners()).toEqual([]);
    expect(await workers.queueCapability?.observeCurrentServing(scope)).toMatchObject({
      kind: "unresolved",
    });
    const forms = workers.internalFormFactory({ sql, objects, clock });
    const version = forms[WORKER_VERSION_FORM_URL];
    if (!version) throw new Error("WorkerVersion Form was not composed");
    expect(() =>
      version.validateCreate({
        worker: { resourceUid: "missing-worker" },
        bundle: { resourceUid: "missing-bundle" },
        handlers: ["queue"],
      }),
    ).not.toThrow();
    expect(workers.queueCapability).toBeDefined();
  } finally {
    await queue?.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(binary === undefined)(
  "authenticated normal Host creates a real Queue Worker graph and its native handler durably ACKs one batch",
  async () => {
    if (!binary) throw new Error("pinned Workerd binary missing");
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-queue-normal-native-"));
    const db = new Database(join(root, "state.sqlite"));
    let queue: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
    let workers: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    let workerUid: string | undefined;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: join(root, "binary"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "native binary unavailable");
      migrateSqlite(db);
      const sql = createSqliteSql(db);
      const custody = createQueueCustody({ sql });
      const objects = createMemoryObjectStore();
      const clock = () => new Date();
      const identity = {
        async verify({ assertion }: { assertion: string }) {
          return {
            providerSubject: assertion,
            email: `${assertion}@example.test`,
            displayName: assertion,
          };
        },
      };
      const accounts = createAccounts({ sql, identity, clock });
      const signedIn = await accounts.signIn({ provider: "google", assertion: "queue-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture actor missing");
      const organization = await accounts.createOrganization({ actor, name: "Queue Organization" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Queue writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      const targetKey = "normal-v2-queue-native";
      const moduleUrl = "https://artifacts.example.test/normal-queue/app.mjs";
      const manifestUrl = "https://artifacts.example.test/normal-queue/manifest.json";
      const moduleBytes = new TextEncoder().encode(
        "export default { async queue(batch) { if (batch.messages[0].id === 'normal-queue-retry' && batch.messages[0].attempts === 1) throw new Error('retry once'); await batch.acknowledgeAll(); } };",
      );
      const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "app.mjs",
          files: [
            {
              path: "app.mjs",
              url: moduleUrl,
              sha256: sha(moduleBytes),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      await objects.create("normal-queue/manifest", manifestBytes);
      await objects.create("normal-queue/app.mjs", moduleBytes);
      const config = {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: {
          targetKey,
          heldArtifacts: [
            {
              url: manifestUrl,
              sha256: sha(manifestBytes),
              objectKey: "normal-queue/manifest",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
            {
              url: moduleUrl,
              sha256: sha(moduleBytes),
              objectKey: "normal-queue/app.mjs",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
          ],
        },
      };
      const ownerForWorkerUid = async (uid: string): Promise<WorkerdWorkerRuntimeOwner> => {
        if (!workers) throw new Error("Worker factory has not been composed");
        return await workers.ownerForWorkerUid(uid);
      };
      const forward: V2QueueConsumerCapability = {
        async observeQueueServingCapability(input) {
          if (!workers?.queueCapability) throw new Error("native Queue capability not composed");
          return await workers.queueCapability.observeQueueServingCapability(input);
        },
        async observeCurrentServing(input) {
          if (!workers?.queueCapability) throw new Error("native Queue capability not composed");
          return await workers.queueCapability.observeCurrentServing(input);
        },
      };
      queue = createSelfhostV2QueueComposition({
        sql,
        custody,
        capability: forward,
        settlementKey: new Uint8Array(32).fill(0x41),
        ownerForWorkerUid,
        privatePort: await unusedPort(),
      });
      workers = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config,
        rootDirectory: join(root, "owners"),
        targetKey,
        workerdBinary: selected.binary,
        queueSettlement: queue.settlementBinding,
        endpoint: {
          // This test never accepts an Endpoint; no public HTTPS route is claimed.
          assignHostname: () => "not-published.example.test",
          async observeTls(input) {
            return { ...input, ready: false };
          },
          async observeRouteAbsent(input) {
            return { ...input, absent: true };
          },
        },
      });
      expect(await workers.restoreOwners()).toEqual([]);
      const app = buildApp({
        sql,
        objects,
        clock,
        identity,
        settlement: {
          async verify() {
            throw new Error("not configured");
          },
        },
        publicOrigin: "https://api.example.test",
        forms: [],
        hostForms: [],
        driver: new InMemoryTakoformResourceDriver(),
        offerings: [],
        v2: config,
        v2FormFactory(context) {
          if (!workers?.queueCapability) throw new Error("Queue capability unavailable");
          return {
            ...workers.internalFormFactory(context),
            [AT_LEAST_ONCE_QUEUE_FORM_URL]: createAtLeastOnceQueueForm({ sql, targetKey }),
            [QUEUE_CONSUMER_FORM_URL]: createQueueConsumerForm({
              sql,
              targetKey,
              capability: workers.queueCapability,
            }),
          };
        },
      });
      const request = (
        path: string,
        method = "GET",
        body?: unknown,
        replayKey?: string,
        generation?: number,
      ) =>
        app.fetch(
          new Request(`https://api.example.test/apis/forms.takoform.com/v2${path}`, {
            method,
            headers: {
              authorization: `Bearer ${key.secret}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              ...(replayKey ? { "idempotency-key": replayKey } : {}),
              ...(generation === undefined
                ? {}
                : { "takoform-expected-generation": String(generation) }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const create = async (form: string, name: string, spec: Record<string, unknown>) => {
        const response = await request(
          "/resources",
          "POST",
          {
            form,
            space: organization.id,
            name,
            spec,
          },
          `normal-queue-create-${name}-key`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        for (let attempt = 0; attempt < 16; attempt += 1) {
          const progress = await app.tickTakoformV2();
          if (progress?.id === accepted.id && progress.status === "succeeded")
            return accepted.resourceUid;
          if (progress?.id === accepted.id && progress.status === "failed")
            throw new Error(`Form ${name} failed: ${JSON.stringify(progress)}`);
        }
        throw new Error(`Form ${name} did not settle`);
      };
      const remove = async (uid: string, name: string, generation = 1) => {
        const response = await request(
          `/resources/${uid}`,
          "DELETE",
          undefined,
          `normal-queue-delete-${name}-key`,
          generation,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string };
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const progress = await app.tickTakoformV2();
          if (progress?.id === accepted.id && progress.status === "succeeded") return;
          if (progress?.id === accepted.id && progress.status === "failed")
            throw new Error(`Delete ${name} failed: ${JSON.stringify(progress)}`);
        }
        throw new Error(`Delete ${name} did not settle`);
      };
      const queueUid = await create(AT_LEAST_ONCE_QUEUE_FORM_URL, "queue", {
        messageRetentionSeconds: 3_600,
      });
      workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: manifestUrl, sha256: sha(manifestBytes) },
      });
      const versionUid = await create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: workerUid },
        bundle: { resourceUid: bundleUid },
        handlers: ["queue"],
      });
      const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: workerUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const observed = await workers.queueCapability?.observeQueueServingCapability({
        workerUid,
        principal: `org:${organization.id}`,
        space: organization.id,
        targetKey,
      });
      expect(observed).toMatchObject({ kind: "confirmed" });
      const consumerSpec = {
        queue: { resourceUid: queueUid },
        worker: { resourceUid: workerUid },
        maxBatchSize: 1,
        maxBatchTimeoutSeconds: 0,
        maxConcurrency: 1,
        maxRetries: 1,
        retryDelaySeconds: 0,
      };
      const consumerUid = await create(QUEUE_CONSUMER_FORM_URL, "consumer", consumerSpec);
      await custody.admit(
        { queueId: v2QueueId(queueUid), messageRetentionSeconds: 3_600, deliveryDelaySeconds: 0 },
        { messageId: "normal-queue-message", body: new TextEncoder().encode("payload") },
      );
      expect(
        await queue.deliverOnce({
          consumerUid,
          principal: `org:${organization.id}`,
          space: organization.id,
          targetKey,
        }),
      ).toEqual({ kind: "handler_resolved" });
      expect(
        await sql.query("SELECT state FROM queue_v2_batch_settlements WHERE message_id = ?", [
          "normal-queue-message",
        ]),
      ).toEqual([{ state: "settled" }]);
      expect(
        await sql.query("SELECT state,retirement_kind FROM queue_v2_batch_executions"),
      ).toEqual([{ state: "retired", retirement_kind: "handler_and_wait_until" }]);
      await custody.admit(
        { queueId: v2QueueId(queueUid), messageRetentionSeconds: 3_600, deliveryDelaySeconds: 0 },
        { messageId: "normal-queue-retry", body: new TextEncoder().encode("retry") },
      );
      const scope = {
        consumerUid,
        principal: `org:${organization.id}`,
        space: organization.id,
        targetKey,
      };
      expect(await queue.deliverOnce(scope)).toEqual({ kind: "handler_rejected" });
      expect(await queue.deliverOnce(scope)).toEqual({ kind: "handler_resolved" });
      expect(
        await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
          v2QueueId(queueUid),
        ]),
      ).toEqual([{ n: 0 }]);
      const update = await request(
        `/resources/${consumerUid}`,
        "PUT",
        { spec: { ...consumerSpec, maxBatchSize: 2 } },
        "normal-queue-update-consumer-key",
        1,
      );
      expect(update.status).toBe(202);
      const updated = (await update.json()) as { id: string };
      expect(await app.tickTakoformV2()).toMatchObject({ id: updated.id, status: "succeeded" });
      await custody.admit(
        { queueId: v2QueueId(queueUid), messageRetentionSeconds: 3_600, deliveryDelaySeconds: 0 },
        { messageId: "normal-queue-after-update", body: new TextEncoder().encode("updated") },
      );
      expect(await queue.deliverOnce(scope)).toEqual({ kind: "handler_resolved" });
      await remove(consumerUid, "consumer", 2);
      expect(await queue.deliverOnce(scope)).toEqual({ kind: "unknown" });
      await remove(deploymentUid, "deployment");
      await remove(versionUid, "version");
      await remove(bundleUid, "bundle");
      await remove(queueUid, "queue");
      await remove(workerUid, "worker");
      const owner = await workers.ownerForWorkerUid(workerUid);
      await owner.close();
    } finally {
      await queue?.close().catch(() => undefined);
      if (workers && workerUid) {
        const owner = await workers.ownerForWorkerUid(workerUid).catch(() => undefined);
        await owner?.close().catch(() => undefined);
      }
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
