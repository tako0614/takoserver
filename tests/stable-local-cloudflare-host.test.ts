import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { startStableLocalCloudflareHost } from "../src/entry-stable-local-cloudflare-host.ts";

const TAKOFORM_ROOT = resolve(import.meta.dir, "fixtures/takoform-v1");
const YURU_FORM_KINDS = [
  "AtLeastOnceQueue",
  "EdgeKVNamespace",
  "ModuleWorker",
  "QueueConsumer",
  "SQLiteDatabase",
  "SQLiteMigrationApplication",
  "SQLiteMigrationSet",
  "WorkerBundle",
  "WorkerCronTrigger",
  "WorkerDeployment",
  "WorkerEndpoint",
  "WorkerVersion",
] as const;
const ROAD_FORM_KINDS = [
  "ModuleWorker",
  "SQLiteDatabase",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
  "WorkerBundle",
  "StaticAssetBundle",
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerEndpoint",
] as const;
const HOST_FORM_KINDS = [...new Set([...YURU_FORM_KINDS, ...ROAD_FORM_KINDS])].sort();
const TOKEN = "stable-local-cloudflare-token";
const LANE = "/apis/forms.takoform.com/v1";
type HostResourceKind = (typeof YURU_FORM_KINDS)[number] | (typeof ROAD_FORM_KINDS)[number];

interface FormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

describe("the stable local Cloudflare-backed Host", () => {
  test("installs exactly the Road and Yuru Form union without current ObjectBucket", async () => {
    const host = await startStableLocalCloudflareHost({
      takoformRepositoryRoot: TAKOFORM_ROOT,
      token: TOKEN,
    });
    try {
      expect(host.report()).toMatchObject({
        classification: "test-only-local-cloudflare-adapter",
        installedFormKindCount: 13,
        resourceGraphCount: 13,
        currentObjectBucketIdentities: 0,
        currentEdgeObjectsReferences: 0,
      });
      expect(
        await fetch(`${host.endpoint}/.well-known/takoform/v1`).then((response) => response.status),
      ).toBe(200);
      const response = await fetch(
        `${host.endpoint}/apis/forms.takoform.com/v1/forms?space=default`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        forms: Array<{ identity: { formRef: { kind: string } } }>;
      };
      const installed = body.forms
        .map((form) => form.identity.formRef.kind)
        .sort((left, right) => left.localeCompare(right));
      expect(installed).toEqual(HOST_FORM_KINDS);
      expect(YURU_FORM_KINDS.every((kind) => installed.includes(kind))).toBe(true);
      expect(ROAD_FORM_KINDS.every((kind) => installed.includes(kind))).toBe(true);
      expect(installed).not.toContain("ObjectBucket");
    } finally {
      await host.close();
    }
  }, 30_000);

  test("applies Road's nine-resource graph and serves its committed static asset relation", async () => {
    const host = await startStableLocalCloudflareHost({
      takoformRepositoryRoot: TAKOFORM_ROOT,
      token: TOKEN,
    });
    try {
      const forms = await installedForms(host.endpoint);
      const reference = (kind: (typeof ROAD_FORM_KINDS)[number], name: string) => ({
        apiVersion: requiredForm(forms, kind).apiVersion,
        kind,
        name,
      });
      const migrationDigest = await uploadArtifact(host.endpoint, {
        kind: "MigrationBundle",
        files: [
          {
            path: "0000_init.sql",
            mediaType: "application/sql",
            bytes: "CREATE TABLE road_probe (id TEXT PRIMARY KEY);",
          },
        ],
      });
      const workerDigest = await uploadArtifact(host.endpoint, {
        kind: "WorkerBundle",
        mainModule: "worker.js",
        modules: [
          {
            name: "worker.js",
            mediaType: "application/javascript+module",
            bytes: `class RoadApp {
  fetch = async (request, env) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      const table = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'road_probe'",
      ).first();
      return Response.json({ ready: table?.name === "road_probe" });
    }
    return env.ASSETS.fetch(request);
  };
}
const app = new RoadApp();
const index_default = {
  fetch: (request, env, context) => app.fetch(request, env, context),
};
export { index_default as default };`,
          },
        ],
      });
      const indexHtml = '<!doctype html><main id="road-static">Road static fallback</main>';
      const appJavaScript = 'document.querySelector("#road-static").dataset.ready = "true";';
      const assetsDigest = await uploadArtifact(host.endpoint, {
        kind: "StaticAssetBundle",
        files: [
          { path: "assets/app.js", mediaType: "text/javascript", bytes: appJavaScript },
          { path: "index.html", mediaType: "text/html", bytes: indexHtml },
        ],
      });

      await applyResource(host.endpoint, forms, "ModuleWorker", "road-local", {});
      await applyResource(host.endpoint, forms, "SQLiteDatabase", "road-local-db", {});
      await applyResource(host.endpoint, forms, "SQLiteMigrationSet", "road-local-migration-set", {
        manifestDigest: migrationDigest,
      });
      await applyResource(
        host.endpoint,
        forms,
        "SQLiteMigrationApplication",
        "road-local-migrations",
        {
          database: reference("SQLiteDatabase", "road-local-db"),
          migrationSet: reference("SQLiteMigrationSet", "road-local-migration-set"),
        },
      );
      await applyResource(host.endpoint, forms, "WorkerBundle", "road-local-bundle", {
        manifestDigest: workerDigest,
      });
      await applyResource(host.endpoint, forms, "StaticAssetBundle", "road-local-assets", {
        manifestDigest: assetsDigest,
      });
      await applyResource(host.endpoint, forms, "WorkerVersion", "road-local-version", {
        worker: reference("ModuleWorker", "road-local"),
        bundle: reference("WorkerBundle", "road-local-bundle"),
        handlers: ["fetch"],
        vars: { ENVIRONMENT: "local" },
        requiredSensitiveVars: [],
        sqliteBindings: [{ name: "DB", resource: reference("SQLiteDatabase", "road-local-db") }],
        assets: {
          bundle: reference("StaticAssetBundle", "road-local-assets"),
          runWorkerFirst: true,
          notFoundHandling: "single_page_application",
        },
      });
      await applyResource(host.endpoint, forms, "WorkerDeployment", "road-local-deployment", {
        worker: reference("ModuleWorker", "road-local"),
        versions: [
          { workerVersion: reference("WorkerVersion", "road-local-version"), weight: 10_000 },
        ],
      });
      await applyResource(host.endpoint, forms, "WorkerEndpoint", "road-local-endpoint", {
        worker: reference("ModuleWorker", "road-local"),
      });

      const health = await fetch(`${host.endpoint}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ready: true });
      const asset = await fetch(`${host.endpoint}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toStartWith("text/javascript");
      expect(await asset.text()).toBe(appJavaScript);
      const fallback = await fetch(`${host.endpoint}/journal/today`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toStartWith("text/html");
      expect(await fallback.text()).toBe(indexHtml);
    } finally {
      await host.close();
    }
  }, 120_000);

  test("applies Yurucommu's 13-resource graph and exercises native queue and schedule handlers", async () => {
    const host = await startStableLocalCloudflareHost({
      takoformRepositoryRoot: TAKOFORM_ROOT,
      token: TOKEN,
    });
    try {
      const forms = await installedForms(host.endpoint);
      const reference = (kind: HostResourceKind, name: string) => ({
        apiVersion: requiredForm(forms, kind).apiVersion,
        kind,
        name,
      });
      const migrationDigest = await uploadArtifact(host.endpoint, {
        kind: "MigrationBundle",
        files: [
          {
            path: "0000_native_handler_probe.sql",
            mediaType: "application/sql",
            bytes: "CREATE TABLE native_handler_probe (id TEXT PRIMARY KEY);",
          },
        ],
      });
      const workerDigest = await uploadArtifact(host.endpoint, {
        kind: "WorkerBundle",
        mainModule: "worker.js",
        modules: [
          {
            name: "worker.js",
            mediaType: "application/javascript+module",
            bytes: `const assertRuntimeBindings = async (env) => {
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_handler_probe'",
  ).first();
  if (table?.name !== "native_handler_probe") throw new Error("D1 migration binding unavailable");
  if (typeof env.KV?.put !== "function") throw new Error("KV binding unavailable");
  if (typeof env.DELIVERY_QUEUE?.send !== "function") {
    throw new Error("queue binding unavailable");
  }
};

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/native-handler-probe") {
      return new Response("ok");
    }
    return Response.json({
      migrated: (await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_handler_probe'",
      ).first())?.name === "native_handler_probe",
      queue: await env.KV.get("queue-handler"),
      scheduled: await env.KV.get("scheduled-handler"),
    });
  },
  async queue(_batch, env) {
    await assertRuntimeBindings(env);
    await env.KV.put("queue-handler", "ready");
  },
  async scheduled(_controller, env) {
    await assertRuntimeBindings(env);
    await env.KV.put("scheduled-handler", "ready");
  },
};`,
          },
        ],
      });

      const worker = "yuru-local";
      const database = "yuru-local-db";
      const migrationSet = "yuru-local-migration-set";
      const migrationApplication = "yuru-local-migrations";
      const kv = "yuru-local-kv";
      const deliveryQueue = "yuru-local-delivery";
      const deadLetterQueue = "yuru-local-dlq";
      const bundle = "yuru-local-bundle";
      const version = "yuru-local-version";
      const deployment = "yuru-local-deployment";
      const endpoint = "yuru-local-endpoint";
      const consumer = "yuru-local-consumer";
      const schedule = "yuru-local-cron";

      await applyResource(host.endpoint, forms, "ModuleWorker", worker, {});
      await applyResource(host.endpoint, forms, "SQLiteDatabase", database, {});
      await applyResource(host.endpoint, forms, "SQLiteMigrationSet", migrationSet, {
        manifestDigest: migrationDigest,
      });
      await applyResource(
        host.endpoint,
        forms,
        "SQLiteMigrationApplication",
        migrationApplication,
        {
          database: reference("SQLiteDatabase", database),
          migrationSet: reference("SQLiteMigrationSet", migrationSet),
        },
      );
      await applyResource(host.endpoint, forms, "EdgeKVNamespace", kv, {});
      await applyResource(host.endpoint, forms, "AtLeastOnceQueue", deliveryQueue, {
        deliveryDelaySeconds: 0,
        messageRetentionSeconds: 60,
      });
      await applyResource(host.endpoint, forms, "AtLeastOnceQueue", deadLetterQueue, {
        deliveryDelaySeconds: 0,
        messageRetentionSeconds: 60,
      });
      await applyResource(host.endpoint, forms, "WorkerBundle", bundle, {
        manifestDigest: workerDigest,
      });
      await applyResource(host.endpoint, forms, "WorkerVersion", version, {
        worker: reference("ModuleWorker", worker),
        bundle: reference("WorkerBundle", bundle),
        handlers: ["fetch", "queue", "scheduled"],
        requiredSensitiveVars: [],
        kvBindings: [{ name: "KV", resource: reference("EdgeKVNamespace", kv) }],
        queueProducerBindings: [
          { name: "DELIVERY_DLQ", resource: reference("AtLeastOnceQueue", deadLetterQueue) },
          { name: "DELIVERY_QUEUE", resource: reference("AtLeastOnceQueue", deliveryQueue) },
        ],
        sqliteBindings: [{ name: "DB", resource: reference("SQLiteDatabase", database) }],
      });
      await applyResource(host.endpoint, forms, "WorkerDeployment", deployment, {
        worker: reference("ModuleWorker", worker),
        versions: [{ workerVersion: reference("WorkerVersion", version), weight: 10_000 }],
      });
      await applyResource(host.endpoint, forms, "WorkerEndpoint", endpoint, {
        worker: reference("ModuleWorker", worker),
      });
      await applyResource(host.endpoint, forms, "QueueConsumer", consumer, {
        deadLetterQueue: reference("AtLeastOnceQueue", deadLetterQueue),
        maxBatchSize: 10,
        maxBatchTimeoutSeconds: 0,
        maxConcurrency: 1,
        maxRetries: 0,
        queue: reference("AtLeastOnceQueue", deliveryQueue),
        retryDelaySeconds: 0,
        worker: reference("ModuleWorker", worker),
      });
      await applyResource(host.endpoint, forms, "WorkerCronTrigger", schedule, {
        cron: "0 3 * * *",
        worker: reference("ModuleWorker", worker),
      });

      await expect(host.exerciseNativeHandlers()).resolves.toEqual({
        queueHandlerInvocations: 1,
        scheduledHandlerInvocations: 1,
      });
      const probe = await fetch(`${host.endpoint}/native-handler-probe`);
      expect(probe.status).toBe(200);
      expect(await probe.json()).toEqual({
        migrated: true,
        queue: "ready",
        scheduled: "ready",
      });
    } finally {
      await host.close();
    }
  }, 120_000);
});

async function installedForms(endpoint: string): Promise<ReadonlyMap<string, FormRef>> {
  const response = await fetch(`${endpoint}${LANE}/forms?space=default`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    forms: Array<{ identity: { formRef: FormRef } }>;
  };
  return new Map(body.forms.map((form) => [form.identity.formRef.kind, form.identity.formRef]));
}

function requiredForm(forms: ReadonlyMap<string, FormRef>, kind: string): FormRef {
  const form = forms.get(kind);
  if (!form) throw new Error(`stable local Form was not installed: ${kind}`);
  return form;
}

async function applyResource(
  endpoint: string,
  forms: ReadonlyMap<string, FormRef>,
  kind: HostResourceKind,
  name: string,
  spec: Record<string, unknown>,
): Promise<void> {
  const formRef = requiredForm(forms, kind);
  const desired = {
    apiVersion: formRef.apiVersion,
    kind,
    form: { formRef },
    metadata: { name, space: "default" },
    spec,
  };
  const prepared = await fetch(`${endpoint}${LANE}/resources/prepare`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(desired),
  });
  expect(prepared.status).toBe(200);
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;
  const applied = await fetch(
    `${endpoint}${LANE}/resources/${formRef.apiVersion}/${kind}/${name}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "idempotency-key": `road-local-${kind.toLowerCase()}-create`,
        "if-none-match": "*",
      },
      body: JSON.stringify({ ...desired, review }),
    },
  );
  expect(applied.status).toBe(201);
}

type ArtifactInput =
  | {
      readonly kind: "WorkerBundle";
      readonly mainModule: string;
      readonly modules: readonly {
        readonly name: string;
        readonly mediaType: string;
        readonly bytes: string;
      }[];
    }
  | {
      readonly kind: "MigrationBundle" | "StaticAssetBundle";
      readonly files: readonly {
        readonly path: string;
        readonly mediaType: string;
        readonly bytes: string;
      }[];
    };

async function uploadArtifact(endpoint: string, artifact: ArtifactInput): Promise<string> {
  const declarations =
    artifact.kind === "WorkerBundle"
      ? artifact.modules.map((module) => ({
          name: module.name,
          mediaType: module.mediaType,
          size: Buffer.byteLength(module.bytes),
          digest: digest(module.bytes),
        }))
      : artifact.files.map((file) => ({
          path: file.path,
          mediaType: file.mediaType,
          size: Buffer.byteLength(file.bytes),
          digest: digest(file.bytes),
        }));
  const manifest =
    artifact.kind === "WorkerBundle"
      ? {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: artifact.kind,
          mainModule: artifact.mainModule,
          modules: declarations,
        }
      : {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: artifact.kind,
          files: declarations,
        };
  const started = await fetch(`${endpoint}${LANE}/artifacts/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": `road-local-${artifact.kind.toLowerCase()}-start`,
    },
    body: JSON.stringify({ manifest }),
  });
  expect(started.status).toBe(201);
  const upload = (await started.json()) as { uploadId: string; missingBlobs: string[] };
  const files = artifact.kind === "WorkerBundle" ? artifact.modules : artifact.files;
  for (const file of files) {
    const blobDigest = digest(file.bytes);
    if (!upload.missingBlobs.includes(blobDigest)) continue;
    const uploaded = await fetch(
      `${endpoint}${LANE}/artifacts/uploads/${upload.uploadId}/blobs/${blobDigest}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: file.bytes,
      },
    );
    expect(uploaded.status).toBe(201);
  }
  const committed = await fetch(`${endpoint}${LANE}/artifacts/uploads/${upload.uploadId}/commit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "idempotency-key": `road-local-${artifact.kind.toLowerCase()}-commit`,
    },
  });
  expect(committed.status).toBe(201);
  return String(((await committed.json()) as { manifestDigest: string }).manifestDigest);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
