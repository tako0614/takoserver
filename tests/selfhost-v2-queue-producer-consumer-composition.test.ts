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
import { createSelfhostV2QueueScheduler } from "../src/selfhost-v2-queue-scheduler.ts";
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
import type { V2QueueConsumerCapability } from "../src/takoform-v2/worker-queue-consumer-backend.ts";
import { v2QueueId } from "../src/takoform-v2/worker-queue-delivery.ts";
import { v2ServiceTargetName } from "../src/takoform-v2/worker-service-resolution.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { internalHostname } from "../src/workerd-runtime.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

test.skipIf(binary === undefined)(
  "internal normal Host automatically delivers native Queue Producer messages through durable ACK and retry",
  async () => {
    if (!binary) throw new Error("pinned Workerd binary missing");
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-producer-consumer-"));
    const db = new Database(join(root, "state.sqlite"));
    let workers: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    let queue: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
    let scheduler: ReturnType<typeof createSelfhostV2QueueScheduler> | undefined;
    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
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
      const signedIn = await accounts.signIn({ provider: "google", assertion: "connected-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture actor missing");
      const organization = await accounts.createOrganization({ actor, name: "Connected Queue" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Queue writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      const targetKey = "normal-v2-producer-consumer";
      const moduleUrl = "https://artifacts.example.test/connected-queue/app.mjs";
      const manifestUrl = "https://artifacts.example.test/connected-queue/manifest.json";
      const moduleBytes = new TextEncoder().encode(`export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/batch") {
        const first = await env.TASKS.send("first");
        const rest = await env.TASKS.sendBatch([{ body: "second" }, { body: "third" }]);
        return Response.json({ first, rest, keys: Object.keys(env) });
      }
      const id = await env.TASKS.send(path === "/retry" ? "retry" : "after-update");
      return Response.json({ id });
    } catch (error) { return Response.json({ error: error.name }); }
  },
  async queue(batch) {
    if (new TextDecoder().decode(batch.messages[0].body) === "retry" &&
        batch.messages[0].attempts === 1) throw new Error("retry once");
    await batch.acknowledgeAll();
  }
};`);
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
      await objects.create("connected-queue/manifest", manifestBytes);
      await objects.create("connected-queue/app.mjs", moduleBytes);
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
              objectKey: "connected-queue/manifest",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
            {
              url: moduleUrl,
              sha256: sha(moduleBytes),
              objectKey: "connected-queue/app.mjs",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
          ],
        },
      };
      const ownerForWorkerUid = async (uid: string): Promise<WorkerdWorkerRuntimeOwner> => {
        if (!workers) throw new Error("Worker factory not composed");
        return await workers.ownerForWorkerUid(uid);
      };
      const forward: V2QueueConsumerCapability = {
        async observeQueueServingCapability(input) {
          if (!workers?.queueCapability) throw new Error("native Queue capability unavailable");
          return await workers.queueCapability.observeQueueServingCapability(input);
        },
        async observeCurrentServing(input) {
          if (!workers?.queueCapability) throw new Error("native Queue capability unavailable");
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
        workerdBinary: selected.binary,
        queueSettlement: queue.settlementBinding,
        v2QueueProducerBinding: {
          custody,
          signingKey: new Uint8Array(32).fill(0x61),
          privatePort: await unusedPort(),
        },
      });
      expect(await workers.restoreOwners()).toEqual([]);
      const forms = workers.internalFormFactory({ sql, objects, clock });
      expect(forms[AT_LEAST_ONCE_QUEUE_FORM_URL]).toBeDefined();
      expect(forms[QUEUE_CONSUMER_FORM_URL]).toBeDefined();
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
        v2FormFactory: workers.internalFormFactory,
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
      const awaitOperation = async (id: string) => {
        const deadline = Date.now() + 8_000;
        for (let attempt = 0; attempt < 64 && Date.now() < deadline; attempt += 1) {
          const progress = await app.tickTakoformV2();
          if (progress?.id === id && progress.status === "succeeded") return;
          if (progress?.id === id && progress.status === "failed")
            throw new Error(`Operation failed: ${JSON.stringify(progress)}`);
          if (progress === null) {
            const row = (
              await sql.query("SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id = ?", [id])
            )[0];
            if (typeof row?.next_attempt_at_ms === "number" && row.next_attempt_at_ms > Date.now())
              await Bun.sleep(
                Math.min(1_100, Math.max(20, row.next_attempt_at_ms - Date.now() + 20)),
              );
          }
        }
        throw new Error(`Operation ${id} did not settle`);
      };
      const create = async (form: string, name: string, spec: Record<string, unknown>) => {
        const response = await request(
          "/resources",
          "POST",
          { form, space: organization.id, name, spec },
          `connected-create-${name}`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await awaitOperation(accepted.id);
        return accepted.resourceUid;
      };
      const update = async (uid: string, name: string, spec: Record<string, unknown>) => {
        const response = await request(
          `/resources/${uid}`,
          "PUT",
          { spec },
          `connected-update-${name}`,
          1,
        );
        expect(response.status).toBe(202);
        await awaitOperation(((await response.json()) as { id: string }).id);
      };
      const remove = async (uid: string, name: string, generation = 1) => {
        const response = await request(
          `/resources/${uid}`,
          "DELETE",
          undefined,
          `connected-delete-${name}`,
          generation,
        );
        expect(response.status).toBe(202);
        await awaitOperation(((await response.json()) as { id: string }).id);
      };
      const queueUid = await create(AT_LEAST_ONCE_QUEUE_FORM_URL, "queue", {
        messageRetentionSeconds: 3_600,
      });
      const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: manifestUrl, sha256: sha(manifestBytes) },
      });
      const versionUid = await create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: workerUid },
        bundle: { resourceUid: bundleUid },
        handlers: ["fetch", "queue"],
        queueProducerBindings: [{ name: "TASKS", resource: { resourceUid: queueUid } }],
      });
      const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: workerUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const consumerSpec = {
        queue: { resourceUid: queueUid },
        worker: { resourceUid: workerUid },
        maxBatchSize: 2,
        maxBatchTimeoutSeconds: 0,
        maxConcurrency: 1,
        maxRetries: 1,
        retryDelaySeconds: 0,
      };
      const consumerUid = await create(QUEUE_CONSUMER_FORM_URL, "consumer", consumerSpec);
      const owner = await workers.ownerForWorkerUid(workerUid);
      const origin = `https://${internalHostname(await v2ServiceTargetName(workerUid))}`;
      const produced = await owner.fetch(new Request(`${origin}/batch`));
      expect(produced.status).toBe(200);
      const body = (await produced.json()) as Record<string, unknown>;
      expect(body.keys).toEqual(["TASKS"]);
      expect(typeof body.first).toBe("string");
      expect((body.rest as unknown[]).length).toBe(2);
      const scope = {
        consumerUid,
        principal: `org:${organization.id}`,
        space: organization.id,
        targetKey,
      };
      scheduler = createSelfhostV2QueueScheduler({
        sql,
        custody,
        composition: queue,
        workerComposition: workers,
      });
      const waitForDrained = async (remaining: number) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const messages = await sql.query(
            "SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?",
            [v2QueueId(queueUid)],
          );
          const active = await sql.query(
            "SELECT count(*) AS n FROM queue_v2_batch_executions WHERE state = 'send_authorized'",
          );
          if (messages[0]?.n === remaining && active[0]?.n === 0) return;
          await Bun.sleep(10);
        }
        throw new Error(`automatic Queue delivery did not drain to ${remaining}`);
      };
      // No caller invokes deliverOnce for these messages. The Host-owned
      // bounded scanner discovers the accepted Consumer and invokes Workerd.
      expect(await scheduler.tick()).toBe(1);
      await waitForDrained(1);
      expect(await scheduler.tick()).toBe(1);
      await waitForDrained(0);
      expect(
        await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
          v2QueueId(queueUid),
        ]),
      ).toEqual([{ n: 0 }]);
      expect(
        await sql.query(
          "SELECT count(*) AS n FROM queue_v2_batch_settlements WHERE state = 'settled'",
        ),
      ).toEqual([{ n: 3 }]);
      const retry = await owner.fetch(new Request(`${origin}/retry`));
      expect(await retry.json()).toMatchObject({ id: expect.any(String) });
      expect(await queue.deliverOnce(scope)).toEqual({ kind: "handler_rejected" });
      expect(
        await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
          v2QueueId(queueUid),
        ]),
      ).toEqual([{ n: 1 }]);
      expect(await queue.deliverOnce(scope)).toEqual({ kind: "handler_resolved" });
      await update(consumerUid, "consumer", {
        ...consumerSpec,
        maxBatchSize: 1,
        retryDelaySeconds: 1,
      });
      const afterUpdate = await owner.fetch(new Request(`${origin}/one`));
      const afterUpdateBody = (await afterUpdate.json()) as { id: string };
      expect(typeof afterUpdateBody.id).toBe("string");
      // A stale accepted-scope read is a candidate, never dispatch authority.
      await sql.run("UPDATE tf_v2_resources SET phase = 'pending' WHERE uid = ?", [consumerUid]);
      expect(await scheduler.tick()).toBe(0);
      expect(
        await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
          v2QueueId(queueUid),
        ]),
      ).toEqual([{ n: 1 }]);
      await sql.run("UPDATE tf_v2_resources SET phase = 'idle' WHERE uid = ?", [consumerUid]);
      expect(await scheduler.tick()).toBe(1);
      await waitForDrained(0);
      expect(
        await sql.query(
          "SELECT generation,state FROM queue_v2_batch_settlements WHERE message_id = ?",
          [afterUpdateBody.id],
        ),
      ).toEqual([{ generation: 2, state: "settled" }]);
      await remove(consumerUid, "consumer", 2);
      expect(await queue.deliverOnce(scope)).toEqual({ kind: "unknown" });
      expect(await scheduler.tick()).toBe(0);
      await remove(deploymentUid, "deployment");
      await remove(versionUid, "version");
      await remove(bundleUid, "bundle");
      await remove(queueUid, "queue");
      await remove(workerUid, "worker");
      expect(
        await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
          v2QueueId(queueUid),
        ]),
      ).toEqual([{ n: 0 }]);
      expect(
        await sql.query(
          "SELECT count(*) AS n FROM queue_v2_batch_executions WHERE state <> 'retired'",
        ),
      ).toEqual([{ n: 0 }]);
      await owner.close();
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    } finally {
      try {
        await scheduler?.close();
        await workers?.suspendOwnersRetainingCustody();
        await workers?.closePrivateBindingServices();
        await queue?.close();
        db.close();
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }
    if (primaryFailed && cleanupFailed)
      throw new AggregateError(
        [primaryError, cleanupError],
        "Queue journey and ownership-safe teardown failed",
      );
    if (cleanupFailed) throw cleanupError;
    if (primaryFailed) throw primaryError;
  },
  30_000,
);
