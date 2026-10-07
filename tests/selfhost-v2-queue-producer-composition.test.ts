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

async function exercise(injectFailureAfterNativeFetch: boolean): Promise<void> {
  if (!binary) throw new Error("pinned Workerd binary missing");
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-queue-producer-composition-"));
  const db = new Database(join(root, "state.sqlite"));
  let queue: ReturnType<typeof createSelfhostV2QueueComposition> | undefined;
  let workers: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
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
    const signedIn = await accounts.signIn({ provider: "google", assertion: "producer-owner" });
    const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
    if (!actor) throw new Error("fixture actor missing");
    const organization = await accounts.createOrganization({
      actor,
      name: "Producer Organization",
    });
    const key = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "Producer writer",
      scopes: ["resources:write"],
      expiresInSeconds: 3_600,
    });
    const targetKey = "normal-v2-queue-producer";
    const moduleUrl = "https://artifacts.example.test/producer/app.mjs";
    const manifestUrl = "https://artifacts.example.test/producer/manifest.json";
    const moduleBytes = new TextEncoder().encode(`export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname === "/batch") {
        const first = await env.TASKS.send("first");
        const rest = await env.TASKS.sendBatch([{ body: "second" }, { body: new Uint8Array([3, 4]) }]);
        return Response.json({ first, rest, keys: Object.keys(env) });
      }
      const id = await env.TASKS.send("after");
      return Response.json({ id });
    } catch (error) { return Response.json({ error: error.name }); }
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
    await objects.create("producer/manifest", manifestBytes);
    await objects.create("producer/app.mjs", moduleBytes);
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
            objectKey: "producer/manifest",
            grants: [{ principal: `org:${organization.id}`, space: organization.id }],
          },
          {
            url: moduleUrl,
            sha256: sha(moduleBytes),
            objectKey: "producer/app.mjs",
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
    const missingProducerBoot = createSelfhostV2WorkerComposition({
      sql,
      objects,
      clock,
      config,
      rootDirectory: join(root, "unwired-owners"),
      targetKey,
      workerdBinary: selected.binary,
      queueSettlement: queue.settlementBinding,
    });
    expect(await missingProducerBoot.restoreOwners()).toEqual([]);
    expect(
      missingProducerBoot.internalFormFactory({ sql, objects, clock })[
        AT_LEAST_ONCE_QUEUE_FORM_URL
      ],
    ).toBeUndefined();
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
    // No Form override: this must be the composition's own same-SQL Queue Form.
    expect(
      workers.internalFormFactory({ sql, objects, clock })[AT_LEAST_ONCE_QUEUE_FORM_URL],
    ).toBeDefined();
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
      let last: unknown;
      const deadline = Date.now() + 8_000;
      for (let attempt = 0; attempt < 64 && Date.now() < deadline; attempt += 1) {
        const progress = await app.tickTakoformV2();
        last = progress;
        if (progress?.id === id && progress.status === "succeeded") return;
        if (progress?.id === id && progress.status === "failed")
          throw new Error(`Operation failed: ${JSON.stringify(progress)}`);
        if (progress === null) {
          const rows = await sql.query(
            "SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id = ?",
            [id],
          );
          const nextAt = rows[0]?.next_attempt_at_ms;
          if (typeof nextAt === "number" && nextAt > Date.now()) {
            await Bun.sleep(Math.min(1_100, Math.max(20, nextAt - Date.now() + 20)));
          }
        }
      }
      const state = await sql.query(
        "SELECT status,effect,updated_at FROM tf_v2_operations WHERE id = ?",
        [id],
      );
      throw new Error(`Operation ${id} did not settle: ${JSON.stringify({ last, state })}`);
    };
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
        `producer-create-${name}`,
      );
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as { id: string; resourceUid: string };
      await awaitOperation(accepted.id);
      return accepted.resourceUid;
    };
    const remove = async (uid: string, name: string, generation = 1) => {
      const response = await request(
        `/resources/${uid}`,
        "DELETE",
        undefined,
        `producer-delete-${name}`,
        generation,
      );
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as { id: string };
      await awaitOperation(accepted.id);
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
      handlers: ["fetch"],
      queueProducerBindings: [{ name: "TASKS", resource: { resourceUid: queueUid } }],
    });
    const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: workerUid },
      versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
    });
    const owner = await workers.ownerForWorkerUid(workerUid);
    const internalOrigin = `https://${internalHostname(await v2ServiceTargetName(workerUid))}`;
    const batch = await owner.fetch(new Request(`${internalOrigin}/batch`));
    expect(batch.status).toBe(200);
    const result = (await batch.json()) as Record<string, unknown>;
    if (injectFailureAfterNativeFetch) throw new Error("injected after active native fetch");
    expect(result.keys).toEqual(["TASKS"]);
    expect(typeof result.first).toBe("string");
    expect((result.rest as unknown[]).length).toBe(2);
    expect(
      await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
        v2QueueId(queueUid),
      ]),
    ).toEqual([{ n: 3 }]);
    // The native request must not trust its boot token after the accepted SQL scope is lost.
    await sql.run("UPDATE tf_v2_resources SET phase = 'pending' WHERE uid = ?", [queueUid]);
    const stale = await owner.fetch(new Request(`${internalOrigin}/one`));
    expect(await stale.json()).toEqual({ error: "backend_unavailable" });
    expect(
      await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
        v2QueueId(queueUid),
      ]),
    ).toEqual([{ n: 3 }]);
    await sql.run("UPDATE tf_v2_resources SET phase = 'idle' WHERE uid = ?", [queueUid]);
    const update = await request(
      `/resources/${queueUid}`,
      "PUT",
      {
        spec: { messageRetentionSeconds: 7_200 },
      },
      "producer-update-queue",
      1,
    );
    expect(update.status).toBe(202);
    await awaitOperation(((await update.json()) as { id: string }).id);
    expect(
      await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
        v2QueueId(queueUid),
      ]),
    ).toEqual([{ n: 3 }]);
    // The accepted Queue UPDATE keeps the sealed UID binding, not a stale spec snapshot.
    const again = await owner.fetch(new Request(`${internalOrigin}/one`));
    expect(await again.json()).toMatchObject({ id: expect.any(String) });
    expect(
      await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
        v2QueueId(queueUid),
      ]),
    ).toEqual([{ n: 4 }]);
    await remove(deploymentUid, "deployment");
    await remove(versionUid, "version");
    await remove(bundleUid, "bundle");
    await remove(queueUid, "queue", 2);
    await remove(workerUid, "worker");
    expect(
      await sql.query("SELECT count(*) AS n FROM selfhost_queue_messages WHERE queue_id = ?", [
        v2QueueId(queueUid),
      ]),
    ).toEqual([{ n: 0 }]);
    await owner.close();
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  } finally {
    try {
      // The owner proves exact child exit and listener vacancy before either
      // private service, SQL handle, or on-disk custody can be removed.
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
  if (primaryFailed && cleanupFailed) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "native Queue test and ownership-safe teardown both failed",
    );
  }
  if (cleanupFailed) throw cleanupError;
  if (primaryFailed) throw primaryError;
}

test.skipIf(binary === undefined)(
  "internal normal Host factory accepts Queue producer refs and native send/sendBatch using one SQL custody",
  () => exercise(false),
  30_000,
);

test.skipIf(binary === undefined)(
  "failed active native Queue test suspends the owner before removing private custody",
  async () => {
    await expect(exercise(true)).rejects.toThrow("injected after active native fetch");
  },
  30_000,
);
