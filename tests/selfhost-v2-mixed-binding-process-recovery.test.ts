import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { OBJECT_BUCKET_FORM_URL } from "../src/takoform-v2/forms/object-bucket.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { v2QueueId } from "../src/takoform-v2/worker-queue-delivery.ts";
import { type LinuxProcessIdentity, linuxProcessLiveness } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact") ?? null;
const API = "/apis/forms.takoform.com/v2";
const MANIFEST_URL = "https://artifacts.example.test/mixed-worker/manifest.json";
const MODULE_URL = "https://artifacts.example.test/mixed-worker/index.mjs";
const CREATE_VERSION_KEY = "create-version-mixed-process-recovery";

type HostEvent = {
  readonly stage: "listening" | "startup_error";
  readonly port?: number;
  readonly pid?: number;
  readonly restored?: readonly string[];
  readonly code?: string;
};

type OwnerState = {
  readonly activeOperationId: string | null;
  readonly incarnations: readonly {
    readonly operationId: string;
    readonly processIdentity: LinuxProcessIdentity | null;
    readonly identity: unknown;
    readonly status: string;
  }[];
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startHost(
  root: string,
  workerdBinary: string,
  organizationId: string,
  manifestSha: string,
  moduleSha: string,
  ports: readonly number[],
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/selfhost-v2-mixed-binding-host.ts"),
      root,
      workerdBinary,
      organizationId,
      manifestSha,
      moduleSha,
      ...ports.map(String),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  const events: HostEvent[] = [];
  const reader = child.stdout.getReader();
  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        events.push(JSON.parse(buffer.slice(0, end)) as HostEvent);
        buffer = buffer.slice(end + 1);
      }
    }
  })();
  async function kill() {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await stderr;
    reader.releaseLock();
  }
  try {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const failure = events.find((event) => event.stage === "startup_error");
      if (failure) throw new Error(`mixed-binding Host startup refused: ${failure.code}`);
      const listening = events.find((event) => event.stage === "listening");
      if (listening?.port && listening.pid) {
        return {
          pid: listening.pid,
          port: listening.port,
          restored: listening.restored ?? [],
          kill,
        };
      }
      if (child.exitCode !== null) throw new Error(`Host exited before listen: ${await stderr}`);
      await Bun.sleep(10);
    }
    throw new Error("mixed-binding Host did not listen");
  } catch (error) {
    await kill();
    throw error;
  }
}

async function request(
  port: number,
  key: string,
  path: string,
  method = "GET",
  body?: unknown,
  idempotencyKey?: string,
  expectedGeneration?: number,
  holdAck = false,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      host: "api.example.test",
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      ...(expectedGeneration === undefined
        ? {}
        : { "takoform-expected-generation": String(expectedGeneration) }),
      ...(holdAck ? { "x-fixture-hold-accepted-response": "yes" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
}

async function operation(port: number, key: string, operationId: string) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const response = await request(port, key, `${API}/operations/${operationId}`);
    expect(response.status).toBe(200);
    const value = (await response.json()) as { status: string; effect: string };
    if (value.status === "succeeded") {
      expect(value.effect).toBe("complete");
      return value;
    }
    if (value.status === "failed") throw new Error("mixed-binding operation failed");
    await Bun.sleep(10);
  }
  throw new Error("mixed-binding operation did not settle");
}

async function ownerState(root: string, workerUid: string): Promise<OwnerState> {
  const ownerKey = createHash("sha256").update(workerUid).digest("hex");
  return JSON.parse(
    await readFile(join(root, "worker-owners", ownerKey, "runtime-owner.json"), "utf8"),
  ) as OwnerState;
}

function readQueueMessages(root: string, queueUid: string) {
  const database = new Database(join(root, "control.sqlite"), { readonly: true });
  try {
    const rows = database
      .query(
        "SELECT message_id, body FROM selfhost_queue_messages WHERE queue_id = ? ORDER BY rowid",
      )
      .all(v2QueueId(queueUid)) as { message_id: string; body: Uint8Array }[];
    return rows.map(({ message_id, body }) => ({
      id: message_id,
      body: new TextDecoder().decode(body),
    }));
  } finally {
    database.close();
  }
}

// This test covers abrupt Host SIGKILL recovery only; graceful suspend has a
// separate lifecycle test and is not used to prepare or close this owner.
test.skipIf(binary === null)(
  "normal Host recovers the same accepted mixed KV, SQLite, Object, and Queue Worker after Host SIGKILL",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-mixed-binding-recovery-"));
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const control = new Database(join(root, "control.sqlite"));
      migrateSqlite(control);
      const sql = createSqliteSql(control);
      const accounts = createAccounts({
        sql,
        identity: {
          async verify({ assertion }: { assertion: string }) {
            return {
              providerSubject: assertion,
              email: `${assertion}@example.test`,
              displayName: assertion,
            };
          },
        },
      });
      const signedIn = await accounts.signIn({ provider: "google", assertion: "mixed-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture organization owner unavailable");
      const organization = await accounts.createOrganization({ actor, name: "Mixed Worker Org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "mixed worker writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      control.close();

      const objects = createFileObjectStore({ root: join(root, "objects") });
      const module = new TextEncoder().encode(`
const encoder = new TextEncoder();
async function objectText(bucket, key) {
  const item = await bucket.get(key, {});
  return item === null ? null : await new Response(item.body).text();
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/write") {
      await env.CACHE.put("persisted", "kv-before-restart");
      await env.DB.execute("INSERT INTO records(value) VALUES (?)", ["sql-before-restart"]);
      const bytes = encoder.encode("object-before-restart");
      await env.MEDIA.put("persisted.txt", bytes.buffer, { contentLength: bytes.byteLength, contentType: "text/plain" });
      const queueMessageId = await env.TASKS.send("queue-before-restart");
      return Response.json({ written: true, queueMessageId });
    }
    if (path === "/queue-send") {
      const message = new URL(request.url).searchParams.get("message") ?? "queue-after-restart";
      const queueMessageId = await env.TASKS.send(message);
      return Response.json({ queueMessageId });
    }
    if (path === "/read") {
      const kv = await env.CACHE.get("persisted");
      const rows = await env.DB.query("SELECT value FROM records ORDER BY id");
      return Response.json({
        kv: kv === null ? null : new TextDecoder().decode(kv),
        sql: rows.rows.map(row => row.value),
        object: await objectText(env.MEDIA, "persisted.txt"),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
`);
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: MODULE_URL,
              sha256: sha256(module),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const manifestSha = sha256(manifest);
      const moduleSha = sha256(module);
      await objects.create("mixed-worker/manifest", manifest);
      await objects.create("mixed-worker/module", module);

      const reservePort = async () => {
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(null, { status: 503 }),
        });
        const port = Number(server.port);
        await server.stop(true);
        if (!port) throw new Error("private binding port unavailable");
        return port;
      };
      const ports = [
        await reservePort(),
        await reservePort(),
        await reservePort(),
        await reservePort(),
        await reservePort(),
      ];
      const firstHost = await startHost(
        root,
        binary as string,
        organization.id,
        manifestSha,
        moduleSha,
        ports,
      );
      first = firstHost;
      expect(first.restored).toEqual([]);

      const create = async (
        port: number,
        form: string,
        name: string,
        spec: unknown,
        replayKey: string,
      ) => {
        const response = await request(
          port,
          key.secret,
          `${API}/resources`,
          "POST",
          { form, space: organization.id, name, spec },
          replayKey,
        );
        if (response.status !== 202) {
          throw new Error(`create ${name} returned ${response.status}: ${await response.text()}`);
        }
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await operation(port, key.secret, accepted.id);
        return accepted;
      };

      const worker = await create(
        first.port,
        MODULE_WORKER_FORM_URL,
        "worker",
        {},
        "create-worker-mixed",
      );
      const bucket = await create(
        first.port,
        OBJECT_BUCKET_FORM_URL,
        "bucket",
        {},
        "create-bucket-mixed",
      );
      const database = await create(
        first.port,
        SQLITE_DATABASE_FORM_URL,
        "database",
        {},
        "create-database-mixed-process",
      );
      const namespace = await create(
        first.port,
        EDGE_KV_NAMESPACE_FORM_URL,
        "namespace",
        {},
        "create-kv-namespace-mixed-process",
      );
      const queueSpec = { messageRetentionSeconds: 3_600 };
      const queueReplayKey = "create-queue-mixed-process";
      const queueAbort = new AbortController();
      const lostQueueAck = request(
        first.port,
        key.secret,
        `${API}/resources`,
        "POST",
        {
          form: AT_LEAST_ONCE_QUEUE_FORM_URL,
          space: organization.id,
          name: "queue",
          spec: queueSpec,
        },
        queueReplayKey,
        undefined,
        true,
        queueAbort.signal,
      );
      let queueAcknowledgementHeld = false;
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const held = await request(first.port, key.secret, "/__fixture/accepted-response-held");
        queueAcknowledgementHeld = ((await held.json()) as { held: boolean }).held;
        if (queueAcknowledgementHeld) break;
        await Bun.sleep(10);
      }
      expect(queueAcknowledgementHeld).toBe(true);
      queueAbort.abort();
      let queueResponseWasLost = false;
      try {
        await lostQueueAck;
      } catch {
        queueResponseWasLost = true;
      }
      expect(queueResponseWasLost).toBe(true);
      const queueResponse = await request(
        first.port,
        key.secret,
        `${API}/resources`,
        "POST",
        {
          form: AT_LEAST_ONCE_QUEUE_FORM_URL,
          space: organization.id,
          name: "queue",
          spec: queueSpec,
        },
        queueReplayKey,
      );
      expect([200, 202]).toContain(queueResponse.status);
      const queue = (await queueResponse.json()) as { id: string; resourceUid: string };
      await operation(first.port, key.secret, queue.id);
      const bundle = await create(
        first.port,
        WORKER_BUNDLE_FORM_URL,
        "bundle",
        { artifact: { url: MANIFEST_URL, sha256: manifestSha } },
        "create-bundle-mixed",
      );
      if (!worker || !bucket || !database || !namespace || !queue || !bundle) {
        throw new Error("fixture resource creation did not return an identity");
      }

      const prepareDatabase = await request(
        first.port,
        key.secret,
        "/__fixture/prepare-database",
        "POST",
        { resourceUid: database.resourceUid },
      );
      expect(prepareDatabase.status).toBe(204);
      const versionSpec = {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
        kvBindings: [{ name: "CACHE", resource: { resourceUid: namespace.resourceUid } }],
        sqliteBindings: [{ name: "DB", resource: { resourceUid: database.resourceUid } }],
        bucketBindings: [{ name: "MEDIA", resource: { resourceUid: bucket.resourceUid } }],
        queueProducerBindings: [{ name: "TASKS", resource: { resourceUid: queue.resourceUid } }],
      };
      const version = await create(
        first.port,
        WORKER_VERSION_FORM_URL,
        "version",
        versionSpec,
        CREATE_VERSION_KEY,
      );
      const deploymentSpec = {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      };
      const deployment = await create(
        first.port,
        WORKER_DEPLOYMENT_FORM_URL,
        "deployment",
        deploymentSpec,
        "create-deployment-mixed",
      );
      const endpoint = await create(
        first.port,
        WORKER_ENDPOINT_FORM_URL,
        "endpoint",
        { worker: { resourceUid: worker.resourceUid } },
        "create-endpoint-mixed",
      );
      if (!deployment || !endpoint) throw new Error("fixture worker publication is incomplete");

      const write = await request(
        first.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}/write`,
      );
      expect(write.status).toBe(200);
      const queuedBeforeRestart = (await write.json()) as {
        readonly written: boolean;
        readonly queueMessageId: string;
      };
      expect(queuedBeforeRestart.written).toBe(true);
      expect(typeof queuedBeforeRestart.queueMessageId).toBe("string");
      expect(readQueueMessages(root, queue.resourceUid)).toEqual([
        { id: queuedBeforeRestart.queueMessageId, body: "queue-before-restart" },
      ]);
      const before = await request(
        first.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}/read`,
      );
      expect(before.status).toBe(200);
      const values = {
        kv: "kv-before-restart",
        sql: ["sql-before-restart"],
        object: "object-before-restart",
      };
      expect(await before.json()).toEqual(values);

      const stateBefore = await ownerState(root, worker.resourceUid);
      const childBefore = stateBefore.incarnations.find(
        (record) => record.operationId === stateBefore.activeOperationId,
      );
      expect(childBefore?.processIdentity).not.toBeNull();
      const previousPid = first.pid;
      await first.kill();
      first = undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          childBefore?.processIdentity &&
          (await linuxProcessLiveness(childBefore.processIdentity)) === "stale"
        )
          break;
        await Bun.sleep(10);
      }
      expect(
        childBefore?.processIdentity
          ? await linuxProcessLiveness(childBefore.processIdentity)
          : "unknown",
      ).toBe("stale");

      const recoveredHost = await startHost(
        root,
        binary as string,
        organization.id,
        manifestSha,
        moduleSha,
        ports,
      );
      second = recoveredHost;
      const resumedHost = recoveredHost;
      expect(recoveredHost.pid).not.toBe(previousPid);
      expect(recoveredHost.restored).toEqual([worker.resourceUid]);
      const stateAfter = await ownerState(root, worker.resourceUid);
      const childAfter = stateAfter.incarnations.find(
        (record) => record.operationId === stateAfter.activeOperationId,
      );
      expect(childAfter?.identity).toEqual(childBefore?.identity);
      expect(childAfter?.processIdentity?.pid).not.toBe(childBefore?.processIdentity?.pid);
      expect(readQueueMessages(root, queue.resourceUid)).toEqual([
        { id: queuedBeforeRestart.queueMessageId, body: "queue-before-restart" },
      ]);

      const replay = await request(
        resumedHost.port,
        key.secret,
        `${API}/resources`,
        "POST",
        {
          form: WORKER_VERSION_FORM_URL,
          space: organization.id,
          name: "version",
          spec: versionSpec,
        },
        CREATE_VERSION_KEY,
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        id: version.id,
        resourceUid: version.resourceUid,
        status: "succeeded",
        effect: "complete",
      });
      await operation(resumedHost.port, key.secret, version.id);
      const afterReplayState = await ownerState(root, worker.resourceUid);
      expect(afterReplayState.activeOperationId).toBe(stateAfter.activeOperationId);
      expect(
        afterReplayState.incarnations.filter((record) => record.status === "active"),
      ).toHaveLength(1);
      const versions = await request(
        resumedHost.port,
        key.secret,
        `${API}/resources?space=${organization.id}&form=${encodeURIComponent(WORKER_VERSION_FORM_URL)}&limit=100`,
      );
      expect(versions.status).toBe(200);
      expect(
        ((await versions.json()) as { items: readonly { uid: string }[] }).items.map(
          (item) => item.uid,
        ),
      ).toEqual([version.resourceUid]);
      const queueReplay = await request(
        resumedHost.port,
        key.secret,
        `${API}/resources`,
        "POST",
        {
          form: AT_LEAST_ONCE_QUEUE_FORM_URL,
          space: organization.id,
          name: "queue",
          spec: queueSpec,
        },
        queueReplayKey,
      );
      expect(queueReplay.status).toBe(200);
      expect(await queueReplay.json()).toMatchObject({
        id: queue.id,
        resourceUid: queue.resourceUid,
        status: "succeeded",
        effect: "complete",
      });
      const queues = await request(
        resumedHost.port,
        key.secret,
        `${API}/resources?space=${organization.id}&form=${encodeURIComponent(AT_LEAST_ONCE_QUEUE_FORM_URL)}&limit=100`,
      );
      expect(queues.status).toBe(200);
      expect(
        ((await queues.json()) as { items: readonly { uid: string }[] }).items.map(
          (item) => item.uid,
        ),
      ).toEqual([queue.resourceUid]);
      const after = await request(
        resumedHost.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}/read`,
      );
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual(values);
      const queueSend = await request(
        resumedHost.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}/queue-send?message=queue-after-restart`,
      );
      expect(queueSend.status).toBe(200);
      const queuedAfterRestart = (await queueSend.json()) as { readonly queueMessageId: string };
      expect(readQueueMessages(root, queue.resourceUid)).toEqual([
        { id: queuedBeforeRestart.queueMessageId, body: "queue-before-restart" },
        { id: queuedAfterRestart.queueMessageId, body: "queue-after-restart" },
      ]);

      const update = await request(
        resumedHost.port,
        key.secret,
        `${API}/resources/${version.resourceUid}`,
        "PUT",
        { spec: versionSpec },
        "update-version-after-mixed-restart",
        1,
      );
      expect(update.status).toBe(202);
      const updateOperation = (await update.json()) as { id: string };
      await operation(resumedHost.port, key.secret, updateOperation.id);
      const afterUpdate = await request(
        resumedHost.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}/read`,
      );
      expect(await afterUpdate.json()).toEqual(values);
      expect(readQueueMessages(root, queue.resourceUid)).toHaveLength(2);

      const remove = async (uid: string, name: string, generation = 1) => {
        const response = await request(
          resumedHost.port,
          key.secret,
          `${API}/resources/${uid}`,
          "DELETE",
          undefined,
          `delete-${name}-mixed-restart`,
          generation,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string };
        await operation(resumedHost.port, key.secret, accepted.id);
      };
      await remove(endpoint.resourceUid, "endpoint");
      await remove(deployment.resourceUid, "deployment");
      await remove(version.resourceUid, "version", 2);
      await remove(queue.resourceUid, "queue");
      await remove(bucket.resourceUid, "bucket");
      await remove(namespace.resourceUid, "namespace");
      await remove(database.resourceUid, "database");
      await remove(bundle.resourceUid, "bundle");
      await remove(worker.resourceUid, "worker");
      expect(readQueueMessages(root, queue.resourceUid)).toEqual([]);

      const routeAfterDelete = await request(
        resumedHost.port,
        key.secret,
        `/__fixture/serve/${worker.resourceUid}/read`,
      );
      expect(routeAfterDelete.status).toBe(503);

      const ownerAfterDelete = await ownerState(root, worker.resourceUid);
      expect(ownerAfterDelete.activeOperationId).toBeNull();
      expect(childAfter?.processIdentity).not.toBeNull();
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          childAfter?.processIdentity &&
          (await linuxProcessLiveness(childAfter.processIdentity)) === "stale"
        ) {
          break;
        }
        await Bun.sleep(10);
      }
      expect(
        childAfter?.processIdentity
          ? await linuxProcessLiveness(childAfter.processIdentity)
          : "unknown",
      ).toBe("stale");
    } finally {
      await second?.kill();
      await first?.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
