import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPortableExercise,
  assertSampleEvidence,
  buildHostedSampleFixtureDocument,
  buildWorkerVersionSpec,
  checkHostedSampleFixture,
  endpointUrlFromResource,
  exactStagingOrigin,
  hostedSampleEndpointName,
  hostedSampleResourceGraphSummary,
  hostedSampleWorkerSource,
  parseHostedSampleFixtureDocument,
  runHostedStagingE2E,
  SAMPLE_COUNTS,
  scheduledSlots,
  sqliteMigrationSource,
  typedEndpointUrlFromResource,
  WFP_HOSTED_SAMPLE_FIXTURE_KIND,
  writeHostedSampleFixture,
} from "../scripts/wfp-hosted-staging-e2e.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { OBJECT_BUCKET_FORM_URL } from "../src/takoform-v2/forms/object-bucket.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import {
  parseSQLiteMigrationManifest,
  parseSQLiteMigrationSetSpec,
} from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import {
  parseStaticAssetBundleManifest,
  STATIC_ASSET_BUNDLE_FORM_URL,
} from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  parseWorkerBundleManifest,
  parseWorkerBundleSpec,
} from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerVersionSpec,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";

test("WfP hosted sample fixture emits exact artifact specs and the current binding graph", async () => {
  const { document, worker, migration, assets } = await buildHostedSampleFixtureDocument(
    "https://artifacts.example.test/wfp-hosted/sample/",
    new Date("2026-10-14T12:31:00Z"),
  );

  expect(document.kind).toBe(WFP_HOSTED_SAMPLE_FIXTURE_KIND);
  expect(document.generatedAt).toBe("2026-10-14T12:31:00.000Z");
  expect(
    parseHostedSampleFixtureDocument(document).resourceGraph.map((entry) => entry.form),
  ).toEqual(hostedSampleResourceGraphSummary().map((entry) => entry.form));
  expect(document.resourceGraph.map((entry) => entry.form)).toContain(SQLITE_DATABASE_FORM_URL);
  expect(document.resourceGraph.map((entry) => entry.form)).toContain(EDGE_KV_NAMESPACE_FORM_URL);
  expect(document.resourceGraph.map((entry) => entry.form)).toContain(OBJECT_BUCKET_FORM_URL);
  expect(document.resourceGraph.map((entry) => entry.form)).toContain(WORKER_VERSION_FORM_URL);
  expect(document.resourceGraph.map((entry) => entry.form)).toContain(WORKER_CRON_TRIGGER_FORM_URL);
  expect(document.resourceGraph.map((entry) => entry.form)).toContain(STATIC_ASSET_BUNDLE_FORM_URL);
  expect(document.counts).toEqual(SAMPLE_COUNTS);
  expect(parseStaticAssetBundleManifest(assets.manifestBytes).files[0]?.path).toBe("sample.txt");

  expect(parseWorkerBundleSpec({ artifact: document.workerBundle.artifact })).toEqual({
    artifact: document.workerBundle.artifact,
  });
  expect(parseSQLiteMigrationSetSpec({ artifact: document.sqliteMigrationSet.artifact })).toEqual({
    artifact: document.sqliteMigrationSet.artifact,
  });
  expect(parseWorkerBundleManifest(worker.manifestBytes)).toMatchObject({
    entrypoint: "worker.mjs",
    files: [{ path: "worker.mjs", mediaType: "application/javascript+module" }],
  });
  expect(parseSQLiteMigrationManifest(migration.manifestBytes)).toMatchObject({
    files: [{ path: "0001_wfp_hosted_sample.sql", mediaType: "application/sql" }],
  });
});

test("WfP hosted WorkerVersion spec binds D1, R2, KV and scheduled handlers", () => {
  const spec = buildWorkerVersionSpec({
    runId: "wfp-sample-run-001",
    workerUid: "worker-uid",
    bundleUid: "bundle-uid",
    databaseUid: "database-uid",
    kvUid: "kv-uid",
    bucketUid: "bucket-uid",
    serviceWorkerUid: "service-worker-uid",
    assetsUid: "asset-uid",
  });

  expect(parseWorkerVersionSpec(spec)).toEqual(spec);
  expect(spec.handlers).toEqual(["fetch", "scheduled"]);
  expect(spec.vars).toEqual({ E2E_RUN_ID: "wfp-sample-run-001", E2E_REVISION: "v1" });
  expect(spec.serviceBindings).toEqual([
    { name: "SERVICE", resource: { resourceUid: "service-worker-uid" } },
  ]);
  expect(spec.assets?.bundle.resourceUid).toBe("asset-uid");
  expect(spec.sqliteBindings).toEqual([{ name: "DB", resource: { resourceUid: "database-uid" } }]);
  expect(spec.kvBindings).toEqual([{ name: "KV", resource: { resourceUid: "kv-uid" } }]);
  expect(spec.bucketBindings).toEqual([
    { name: "BUCKET", resource: { resourceUid: "bucket-uid" } },
  ]);
});

interface LocalWorker {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  scheduled(
    controller: { scheduledTime: number; cron: string },
    env: Record<string, unknown>,
  ): Promise<void>;
}

async function localApp() {
  const worker = (await import(
    `data:text/javascript;base64,${Buffer.from(hostedSampleWorkerSource()).toString("base64")}`
  )) as { default: LocalWorker };
  const db = new Database(":memory:");
  db.exec(sqliteMigrationSource());
  const execute = async (sql: string, params: (string | number | null)[] = []) => {
    const result = db.query(sql).run(...params);
    return { rows: [], rowsWritten: result.changes };
  };
  const values = new Map<string, { value: string; metadata?: Record<string, string> }>();
  const objects = new Map<string, string>();
  const uploads = new Map<string, string>();
  const env = {
    E2E_RUN_ID: "portable-sample-run",
    E2E_REVISION: "v1",
    DB: {
      execute,
      query: async (sql: string, params: (string | number | null)[] = []) => ({
        rows: db.query(sql).all(...params),
        rowsWritten: 0,
      }),
      transaction: async (statements: { sql: string; params?: (string | number | null)[] }[]) => {
        const results = db.transaction(() =>
          statements.map((item) => {
            const result = db.query(item.sql).run(...(item.params ?? []));
            return { rows: [], rowsWritten: result.changes };
          }),
        )();
        return { results };
      },
    },
    KV: {
      get: async (key: string) =>
        values.has(key) ? new TextEncoder().encode(values.get(key)?.value).buffer : null,
      getWithMetadata: async (key: string) => {
        const item = values.get(key);
        return item
          ? { value: new TextEncoder().encode(item.value).buffer, metadata: item.metadata }
          : null;
      },
      put: async (key: string, value: string, options?: { metadata?: Record<string, string> }) => {
        values.set(key, {
          value,
          ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
        });
      },
      delete: async (key: string) => {
        values.delete(key);
      },
      list: async (options: { prefix: string; limit: number }) => {
        const keys = [...values.keys()].filter((key) => key.startsWith(options.prefix)).sort();
        return {
          keys: keys.slice(0, options.limit).map((name) => ({ name })),
          listComplete: keys.length <= options.limit,
        };
      },
    },
    BUCKET: {
      put: async (key: string, bytes: ArrayBuffer) => {
        const value = new TextDecoder().decode(bytes);
        objects.set(key, value);
        return { etag: value, size: bytes.byteLength };
      },
      get: async (
        key: string,
        options?: { range?: { offset: number; length: number }; ifMatch?: string },
      ) => {
        const value = objects.get(key);
        if (value === undefined) return null;
        if (options?.ifMatch && options.ifMatch !== value) throw new Error("precondition_failed");
        const body = options?.range
          ? value.slice(options.range.offset, options.range.offset + options.range.length)
          : value;
        return { body: new Response(body).body, etag: value, size: value.length };
      },
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key)?.length } : null),
      delete: async (key: string) => {
        objects.delete(key);
      },
      list: async (options: { prefix: string; limit: number }) => {
        const keys = [...objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
        return {
          objects: keys.slice(0, options.limit).map((key) => ({ key })),
          truncated: keys.length > options.limit,
        };
      },
      createMultipartUpload: async (key: string) => {
        uploads.set(key, "");
        return { uploadId: key };
      },
      uploadPart: async (key: string, _id: string, partNumber: number, bytes: ArrayBuffer) => {
        uploads.set(key, new TextDecoder().decode(bytes));
        return { etag: "part-etag", partNumber };
      },
      completeMultipartUpload: async (key: string) => {
        objects.set(key, uploads.get(key) ?? "");
        uploads.delete(key);
      },
      abortMultipartUpload: async (key: string) => {
        uploads.delete(key);
      },
    },
    SERVICE: { fetch: async () => Response.json({ runId: "portable-sample-run", revision: "v1" }) },
  };
  const request = (path: string, method = "GET") =>
    worker.default.fetch(
      new Request(`https://sample.invalid${path}`, {
        method,
        headers: { "x-takoserver-e2e-run": env.E2E_RUN_ID },
      }),
      env,
    );
  return { worker: worker.default, env, request, db, objects, values, uploads };
}

test("portable fixture seeds real SQLite at community scale, exercises transactions and retains three-plane receipts", async () => {
  const app = await localApp();
  try {
    assertSampleEvidence(
      await (await app.request("/e2e/seed", "POST")).json(),
      app.env.E2E_RUN_ID,
      "v1",
    );
    assertPortableExercise(
      await (await app.request("/e2e/exercise", "POST")).json(),
      app.env.E2E_RUN_ID,
    );
    expect(await (await app.request("/e2e/feed")).json()).toMatchObject({ cache: "miss" });
    expect(await (await app.request("/e2e/feed")).json()).toMatchObject({ cache: "hit" });
    const now = Date.now();
    const controller = { scheduledTime: Math.floor(now / 60_000) * 60_000, cron: "* * * * *" };
    await app.worker.scheduled(controller, app.env);
    await app.worker.scheduled(controller, app.env);
    const evidence = await (await app.request("/e2e/evidence")).json();
    assertSampleEvidence(evidence, app.env.E2E_RUN_ID, "v1");
    expect(scheduledSlots(evidence, app.env.E2E_RUN_ID, now - 60_000, now + 70_000)).toEqual([
      controller.scheduledTime,
    ]);
    expect(app.uploads.size).toBe(0);
    app.env.E2E_REVISION = "v2";
    assertSampleEvidence(
      await (await app.request("/e2e/evidence")).json(),
      app.env.E2E_RUN_ID,
      "v2",
    );
    expect(
      (
        await app.worker.fetch(
          new Request("https://sample.invalid/e2e/seed", { method: "POST" }),
          app.env,
        )
      ).status,
    ).toBe(403);
    await app.request("/e2e/clear", "POST");
    expect(app.objects.size).toBe(0);
    expect(app.values.size).toBe(0);
  } finally {
    app.db.close();
  }
});

test("scheduled acceptance excludes HTTP-woken later slots and rejects disagreement/duplicates", () => {
  const runId = "scheduled-run";
  const receipt = (slot: number) => {
    const value = JSON.stringify({ runId, slot, posts: 1_000, invokedAt: slot + 1_000 });
    return { slot, sql: value, kv: value, object: value };
  };
  expect(
    scheduledSlots(
      { runId, scheduled: [receipt(60_000), receipt(120_000), receipt(180_000)] },
      runId,
      0,
      130_000,
    ),
  ).toEqual([60_000, 120_000]);
  expect(() =>
    scheduledSlots({ runId, scheduled: [{ ...receipt(60_000), kv: "wrong" }] }, runId, 0, 130_000),
  ).toThrow("disagree");
  expect(() =>
    scheduledSlots({ runId, scheduled: [receipt(60_000), receipt(60_000)] }, runId, 0, 130_000),
  ).toThrow("duplicate");
  const late = {
    ...receipt(120_000),
    sql: JSON.stringify({ runId, slot: 120_000, posts: 1_000, invokedAt: 131_000 }),
  };
  expect(scheduledSlots({ runId, scheduled: [late] }, runId, 0, 130_000)).toEqual([]);
  expect(() => scheduledSlots({ runId, scheduled: [] }, runId, 0, 10_000)).toThrow(
    "quiet interval",
  );
  expect(() =>
    assertSampleEvidence(
      { runId, revision: "v1", counts: { ...SAMPLE_COUNTS, posts: 999 } },
      runId,
      "v1",
    ),
  ).toThrow("scale");
});

test("control origins require a literal staging/integration prefix before file or network access", async () => {
  for (const origin of [
    "https://integration-api.takoserver.com",
    "https://staging-api.takoserver.com",
    "https://integration-api.account.workers.dev",
    "https://staging-api.account.workers.dev",
  ]) {
    expect(exactStagingOrigin(`${origin}/`)).toBe(origin);
  }
  let requests = 0;
  for (const origin of [
    "https://api.takoserver.com",
    "https://api.integration.takoserver.com",
    "https://api-staging.takoserver.com",
    "https://production.integration.takoserver.com",
    "https://integration.takoserver.com",
    "https://integration-.takoserver.com",
    "https://api.staging.account.workers.dev",
    "https://integration-api.takoserver.com.evil.test",
    "https://integration-api.example.test",
    "http://integration-api.takoserver.com",
    "https://user:pass@integration-api.takoserver.com",
    "https://integration-api.takoserver.com:8443",
    "https://integration-api.takoserver.com/path",
    "https://integration-api.takoserver.com/?query=1",
    "https://integration-api.takoserver.com/#fragment",
  ]) {
    await expect(
      runHostedStagingE2E({
        fixturePath: "missing",
        origin,
        writerSecretPath: "missing",
        evidenceSecretPath: "missing",
        outputPath: "missing",
        journalPath: "missing",
        sourceCommit: "a".repeat(40),
        space: "sample",
        runId: "sample-run",
        pollSeconds: 1,
        scheduleSeconds: 1,
        now: () => new Date(),
        fetcher: async () => {
          requests++;
          return Response.json({});
        },
      }),
    ).rejects.toThrow("staging");
  }
  expect(requests).toBe(0);
});

test("Endpoint origin binds the accepted canonical UID without widening the Host API origin guard", () => {
  const uid = "01234567-89ab-cdef-0123-456789abcdef";
  const hostname = "integration-v2-0123456789abcdef0123456789abcdef.app-staging.takos.jp";
  expect(
    endpointUrlFromResource({ uid, output: { hostname, url: `https://${hostname}/` } }, uid),
  ).toBe(`https://${hostname}`);
  expect(() => exactStagingOrigin(`https://${hostname}/`)).toThrow("staging");
});

test("Endpoint origin refuses UID substitution, sibling namespaces and noncanonical URL fields", () => {
  const uid = "01234567-89ab-cdef-0123-456789abcdef";
  const hostname = "integration-v2-0123456789abcdef0123456789abcdef.app-staging.takos.jp";
  const output = { hostname, url: `https://${hostname}/` };
  for (const invalidUid of [uid.toUpperCase(), uid.replaceAll("-", ""), "resource-fixture"]) {
    expect(() => endpointUrlFromResource({ uid: invalidUid, output }, invalidUid)).toThrow(
      "accepted Resource UID",
    );
  }
  expect(() =>
    endpointUrlFromResource({ uid: "00000000-0000-4000-8000-000000000001", output }, uid),
  ).toThrow("accepted Resource UID");
  for (const invalidHostname of [
    "v2-0123456789abcdef0123456789abcdef.app-staging.takos.jp",
    "staging-v2-0123456789abcdef0123456789abcdef.app-staging.takos.jp",
    "integration-v2-00000000000040008000000000000001.app-staging.takos.jp",
    "integration-v2-0123456789abcdef0123456789abcdef.app.takos.jp",
    `${hostname}.evil.test`,
    `${hostname}.integration.takoserver.com`,
    "integration-v2-0123456789abcdef0123456789abcdef.sibling.app-staging.takos.jp",
    hostname.toUpperCase(),
    `${hostname}.`,
    "worker.integration.takoserver.com",
  ]) {
    expect(() =>
      endpointUrlFromResource(
        { uid, output: { hostname: invalidHostname, url: `https://${invalidHostname}/` } },
        uid,
      ),
    ).toThrow("accepted staging Resource UID");
  }
  for (const invalidUrl of [
    `http://${hostname}/`,
    `https://user:pass@${hostname}/`,
    `https://${hostname}:443/`,
    `https://${hostname}:8443/`,
    `https://${hostname}/path`,
    `https://${hostname}/?query=1`,
    `https://${hostname}/?`,
    `https://${hostname}/#fragment`,
    `https://${hostname}/#`,
    `https://${hostname}/./`,
    `https://${hostname}//`,
    `https://${hostname}`,
    "https://integration-v2-00000000000040008000000000000001.app-staging.takos.jp/",
  ]) {
    expect(() =>
      endpointUrlFromResource({ uid, output: { hostname, url: invalidUrl } }, uid),
    ).toThrow("accepted staging Resource UID");
  }
  for (const incomplete of [{ hostname }, { url: output.url }, { hostname, url: null }]) {
    expect(() => endpointUrlFromResource({ uid, output: incomplete }, uid)).toThrow(
      "accepted staging Resource UID",
    );
  }
});

async function harnessFixture() {
  const root = await mkdtemp(join(tmpdir(), "wfp-hosted-harness-"));
  await writeHostedSampleFixture({
    artifactBaseUrl: "https://artifacts.example.test/sample/",
    outputDirectory: join(root, "fixture"),
  });
  await writeFile(join(root, "writer.secret"), "synthetic-writer-secret-only", { mode: 0o600 });
  await writeFile(join(root, "evidence.secret"), "synthetic-evidence-secret-only", { mode: 0o600 });
  return {
    root,
    options: {
      fixturePath: join(root, "fixture", "fixture.json"),
      origin: "https://integration-api.takoserver.com",
      writerSecretPath: join(root, "writer.secret"),
      evidenceSecretPath: join(root, "evidence.secret"),
      outputPath: join(root, "evidence.json"),
      journalPath: join(root, "journal.jsonl"),
      sourceCommit: "a".repeat(40),
      space: "sample",
      runId: "harness-sample-run",
      pollSeconds: 1,
      scheduleSeconds: 1,
    },
  };
}

// Protocol-only stand-in for the existing control API. It does not create or
// prove a shared ledger hold, eligible Offering, provider derive or native grant.
function withOriginalReservationCarrier(
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  options: { readonly origin: string; readonly runId: string },
  observe?: (method: string, body?: Record<string, unknown>) => void,
): (input: string, init?: RequestInit) => Promise<Response> {
  const path = `/v1/worker-endpoint-origin-reservations/integration-wfp-${options.runId}-origin`;
  let projection: Record<string, unknown> | undefined;
  return async (input, init) => {
    const url = new URL(input);
    if (url.origin !== options.origin || url.pathname !== path) return await fetcher(input, init);
    const method = init?.method ?? "GET";
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer synthetic-writer-secret-only",
    );
    if (method === "GET") {
      observe?.(method);
      return projection
        ? Response.json(projection)
        : Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
    if (method !== "PUT") throw new Error("reservation must be retained, never released");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    observe?.(method, body);
    expect(body.format).toBe("takoserver.worker-endpoint-origin-reservation.v2");
    expect(body.expiresInSeconds).toBe(86_400);
    expect(body.requestedSubdomain).toBe(hostedSampleEndpointName(options.runId));
    projection = {
      format: body.format,
      reservationId: `integration-wfp-${options.runId}-origin`,
      requestedSubdomain: body.requestedSubdomain,
      canonicalPublicOrigin: `https://${body.requestedSubdomain}.app-staging.takos.jp`,
      revision: "1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      status: "prepared",
    };
    return Response.json(projection, { status: 201 });
  };
}

test("harness drives v2 lifecycle, Service/Version rollback and dependency-ordered deletion with durable evidence", async () => {
  const fixture = await harnessFixture();
  type Resource = Record<string, unknown> & {
    uid: string;
    name: string;
    form: string;
    generation: number;
    spec: Record<string, unknown>;
    output: Record<string, unknown>;
  };
  const resources = new Map<string, Resource>();
  const operations = new Map<string, Record<string, unknown>>();
  const preflightNames: string[] = [];
  const createdNames: string[] = [];
  const reservationMethods: string[] = [];
  const organizationProofRoles: string[] = [];
  const mutationKeys: string[] = [];
  let sequence = 0;
  let now = Date.parse("2026-10-14T14:00:00Z");
  const runId = fixture.options.runId;
  const revision = (service: boolean) => {
    const deployment = [...resources.values()].find(
      (item) =>
        item.name.endsWith(service ? "-service-deployment" : "-deployment") &&
        (service || !item.name.endsWith("-service-deployment")),
    );
    if (!deployment) throw new Error("fixture deployment missing");
    const selected = (deployment.spec.versions as { workerVersion: { resourceUid: string } }[])[0]
      ?.workerVersion.resourceUid;
    const version = resources.get(selected ?? "");
    if (!version) throw new Error("fixture version missing");
    return (version.spec.vars as { E2E_REVISION: string }).E2E_REVISION;
  };
  const references = (value: unknown, uid: string): boolean => {
    if (!value || typeof value !== "object") return false;
    if (!Array.isArray(value) && (value as Record<string, unknown>).resourceUid === uid)
      return true;
    return Object.values(value).some((item) => references(item, uid));
  };
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    if (url.pathname === "/.well-known/takoform/v2")
      return Response.json({ api: "forms.takoform.com/v2", baseUrl: `${url.origin}/host/v2` });
    if (url.pathname === "/host/v2/support")
      return Response.json({ supported: true, form: url.searchParams.get("form") });
    if (url.pathname.startsWith("/host/v2/operations/"))
      return Response.json(operations.get(url.pathname.split("/").at(-1) ?? ""));
    if (url.pathname === "/host/v2/resources" && method === "GET") {
      expect(url.searchParams.get("space")).toBe("sample");
      const name = url.searchParams.get("name");
      if (name === null) {
        expect(url.searchParams.get("limit")).toBe("1");
        organizationProofRoles.push(new Headers(init?.headers).get("authorization") ?? "");
      } else preflightNames.push(name);
      return Response.json({ items: [], nextCursor: null });
    }
    if (url.pathname.startsWith("/host/v2/resources")) {
      const uid = url.pathname.split("/").at(-1) ?? "";
      const current = resources.get(uid);
      if (method === "GET")
        return current ? Response.json(current) : Response.json({ code: "gone" }, { status: 410 });
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      mutationKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (method === "POST") {
        expect(body.space).toBe("sample");
        createdNames.push(String(body.name));
      }
      if (
        method === "PUT" &&
        current &&
        JSON.stringify(body.spec) !== JSON.stringify(current.spec) &&
        current.spec.artifact
      ) {
        return Response.json({ code: "invalid_spec" }, { status: 400 });
      }
      if (
        method === "DELETE" &&
        [...resources.values()].some((item) => item.uid !== uid && references(item.spec, uid))
      ) {
        return Response.json({ code: "dependency_conflict" }, { status: 409 });
      }
      const id = `operation-${++sequence}`;
      const resourceUid =
        current?.uid ??
        (String(body.form).includes("/WorkerEndpoint/")
          ? "00000000-0000-4000-8000-000000000001"
          : `resource-${sequence}`);
      const resource: Resource = current
        ? { ...current }
        : {
            uid: resourceUid,
            form: String(body.form),
            name: String(body.name),
            space: body.space,
            generation: 0,
            spec: {},
            output: {},
          };
      resource.generation++;
      resource.observedGeneration = resource.generation;
      resource.phase = "idle";
      resource.lastOperation = id;
      if (body.spec) resource.spec = body.spec as Record<string, unknown>;
      if (
        resource.form.endsWith("/WorkerEndpoint/0.3.0/") ||
        resource.form.includes("/WorkerEndpoint/")
      ) {
        const hostname = `${resource.name}.app-staging.takos.jp`;
        resource.output = { hostname, url: `https://${hostname}/` };
      }
      operations.set(id, {
        id,
        resourceUid,
        action: method === "POST" ? "create" : method === "PUT" ? "update" : "delete",
        generation: resource.generation,
        status: "succeeded",
        effect: "complete",
      });
      if (method === "DELETE") resources.delete(resourceUid);
      else resources.set(resourceUid, resource);
      return Response.json({ id, resourceUid }, { status: 202 });
    }
    if (![...resources.values()].some((item) => item.form.includes("/WorkerEndpoint/")))
      return new Response(null, { status: 404 });
    if (url.pathname === "/sample.txt") {
      const asset = await readFile(
        new URL("./fixtures/wfp-hosted-portable-sample/sample.txt", import.meta.url),
      );
      if (method === "HEAD")
        return new Response(null, { headers: { "content-length": String(asset.byteLength) } });
      if (new Headers(init?.headers).has("range"))
        return new Response(asset.subarray(0, 10), { status: 206 });
      return new Response(asset);
    }
    if (url.pathname === "/health" || url.pathname === "/e2e/service")
      return Response.json({ runId, revision: revision(url.pathname === "/e2e/service") });
    if (url.pathname === "/e2e/clear") return Response.json({ cleared: true });
    if (url.pathname === "/e2e/feed") {
      const prior = operations.has("feed");
      operations.set("feed", {});
      return Response.json({
        cache: prior ? "hit" : "miss",
        posts: Array.from({ length: 50 }, (_, id) => ({ id })),
      });
    }
    if (url.pathname === "/e2e/exercise")
      return Response.json({
        sqlite: { updated: "after", remaining: 0, transactionRefused: true },
        kv: { value: "portable-kv", metadata: { fixture: runId }, listed: true, deleted: true },
        object: {
          size: 15,
          range: "portable",
          conditional: "portable-object",
          multipart: "multipart-object",
          listed: true,
          deleted: true,
        },
      });
    const quietStart = Date.parse("2026-10-14T14:00:00Z");
    const scheduled = [quietStart + 60_000, quietStart + 120_000].map((slot) => {
      const value = JSON.stringify({ runId, slot, posts: 1_000, invokedAt: slot + 1_000 });
      return { slot, sql: value, kv: value, object: value };
    });
    return Response.json({
      runId,
      revision: revision(false),
      counts: SAMPLE_COUNTS,
      attachments: Array.from({ length: 20 }, (_, i) => `Attachment ${i}`),
      scheduled,
    });
  };
  try {
    const result = await runHostedStagingE2E({
      ...fixture.options,
      fetcher: withOriginalReservationCarrier(fetcher, fixture.options, (method, body) => {
        reservationMethods.push(method);
        if (body) expect(body.offeringId).toBe("selected-sold-module-worker-offering");
      }),
      reservationOfferingId: "selected-sold-module-worker-offering",
      now: () => new Date(now),
      pause: async (ms) => {
        now += ms;
      },
    });
    expect(result.status).toBe("HOSTED_STAGING_SCENARIOS_PASSED");
    expect(resources.size).toBe(0);
    expect(result.launchAcceptance).toContain("unqualified");
    expect(preflightNames).toHaveLength(37);
    expect(organizationProofRoles).toEqual([
      "Bearer synthetic-writer-secret-only",
      "Bearer synthetic-evidence-secret-only",
    ]);
    expect(reservationMethods).toEqual(["GET", "PUT", "GET"]);
    expect(result.originalReservation).toMatchObject({
      retained: true,
      globalNameReusable: false,
      requestedSubdomain: hostedSampleEndpointName(runId),
    });
    const freshNames = preflightNames.filter((name) =>
      name.startsWith(`integration-wfp-${runId}-`),
    );
    const legacyNames = preflightNames.filter((name) => name.startsWith(`wfp-${runId}-`));
    expect(freshNames).toHaveLength(18);
    expect(legacyNames.sort()).toEqual(
      freshNames.map((name) => name.slice("integration-".length)).sort(),
    );
    expect(createdNames).toHaveLength(18);
    expect([...createdNames].sort()).toEqual(
      [
        ...freshNames.filter((name) => name !== `integration-wfp-${runId}-endpoint`),
        hostedSampleEndpointName(runId),
      ].sort(),
    );
    expect(new Set(createdNames).size).toBe(createdNames.length);
    for (const name of createdNames) {
      if (name === hostedSampleEndpointName(runId)) expect(name).toHaveLength(31);
      else expect(name).toStartWith(`integration-wfp-${runId}-`);
    }
    expect(mutationKeys.length).toBeGreaterThan(createdNames.length);
    for (const key of mutationKeys) expect(key).toStartWith(`integration-wfp-${runId}-`);
    const journal = await readFile(fixture.options.journalPath, "utf8");
    expect(journal).toContain("absence-confirmed");
    expect(journal).toContain("refusal-confirmed");
    expect(journal).not.toContain("synthetic-writer-secret-only");
    expect(journal).not.toContain("synthetic-evidence-secret-only");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an occupied legacy run name stops before new-prefix mutations in the selected Space", async () => {
  const fixture = await harnessFixture();
  const lookedUp: string[] = [];
  let mutations = 0;
  const legacyName = `wfp-${fixture.options.runId}-worker`;
  const fetcher = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (init?.method && init.method !== "GET") mutations++;
    if (url.pathname === "/.well-known/takoform/v2")
      return Response.json({ api: "forms.takoform.com/v2", baseUrl: `${url.origin}/host/v2` });
    if (url.pathname === "/host/v2/support")
      return Response.json({ supported: true, form: url.searchParams.get("form") });
    if (url.pathname === "/host/v2/resources" && init?.method === "GET") {
      expect(url.searchParams.get("space")).toBe("sample");
      const name = url.searchParams.get("name") ?? "";
      if (url.searchParams.has("name")) lookedUp.push(name);
      return Response.json({
        items: name === legacyName ? [{ uid: "old-resource-uid", name }] : [],
        nextCursor: null,
      });
    }
    throw new Error("unexpected fixture request");
  };
  try {
    await expect(
      runHostedStagingE2E({
        ...fixture.options,
        fetcher: withOriginalReservationCarrier(fetcher, fixture.options),
        now: () => new Date(),
      }),
    ).rejects.toThrow("fixture name already exists");
    expect(lookedUp).toEqual([`integration-${legacyName}`, legacyName]);
    expect(mutations).toBe(0);
    const journal = await readFile(fixture.options.journalPath, "utf8");
    expect(journal).toContain("halt");
    expect(journal).not.toContain("mutation-intent");
    expect(journal).not.toContain("old-resource-uid");
    expect(JSON.parse(await readFile(fixture.options.outputPath, "utf8")).status).toBe(
      "INCOMPLETE",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Endpoint probes wait for the accepted operation and exact settled Resource readback", async () => {
  for (const fault of [
    "hostname-uid",
    "resource-name",
    "resource-space",
    "resource-form",
    "worker-binding",
    "operation-resource",
    "operation-action",
    "operation-generation",
    "url",
    "resource-uid",
    "operation-id",
    "operation-effect",
    "phase",
    "observed-generation",
    "last-operation",
  ]) {
    const fixture = await harnessFixture();
    const uid = "00000000-0000-4000-8000-000000000001";
    const hostname = `${hostedSampleEndpointName(fixture.options.runId)}.app-staging.takos.jp`;
    const resources = new Map<string, Record<string, unknown>>();
    const operations = new Map<string, Record<string, unknown>>();
    let sequence = 0;
    let endpointOperation = "";
    let endpointCreates = 0;
    let operationReads = 0;
    let resourceReads = 0;
    let probes = 0;
    const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      if (url.origin !== fixture.options.origin) {
        probes++;
        throw new Error("Endpoint must not be probed after a refused readback");
      }
      if (url.pathname === "/.well-known/takoform/v2")
        return Response.json({ api: "forms.takoform.com/v2", baseUrl: `${url.origin}/host/v2` });
      if (url.pathname === "/host/v2/support")
        return Response.json({ supported: true, form: url.searchParams.get("form") });
      if (url.pathname === "/host/v2/resources" && init?.method === "GET")
        return Response.json({ items: [], nextCursor: null });
      if (url.pathname === "/host/v2/resources" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const endpoint = String(body.form).includes("/WorkerEndpoint/");
        const id = `operation-${++sequence}`;
        const resourceUid = endpoint ? uid : `resource-${sequence}`;
        const operation = {
          id,
          resourceUid,
          action: "create",
          generation: 1,
          status: "succeeded",
          effect: "complete",
        };
        const resource: Record<string, unknown> = {
          uid: resourceUid,
          ...body,
          generation: 1,
          observedGeneration: 1,
          phase: "idle",
          lastOperation: id,
          output: endpoint ? { hostname, url: `https://${hostname}/` } : {},
        };
        if (endpoint) {
          endpointCreates++;
          endpointOperation = id;
          if (fault === "hostname-uid") {
            const foreign = "integration-v2-00000000000040008000000000000002.app-staging.takos.jp";
            resource.output = { hostname: foreign, url: `https://${foreign}/` };
          }
          if (fault === "url") resource.output = { hostname, url: `https://${hostname}/#alias` };
          if (fault === "resource-uid") resource.uid = "00000000-0000-4000-8000-000000000002";
          if (fault === "resource-name") resource.name = "integration-foreign-ep";
          if (fault === "resource-space") resource.space = "foreign-org";
          if (fault === "resource-form") resource.form = MODULE_WORKER_FORM_URL;
          if (fault === "worker-binding")
            resource.spec = { worker: { resourceUid: "foreign-worker" } };
          if (fault === "operation-resource") operation.resourceUid = "foreign-resource";
          if (fault === "operation-action") operation.action = "update";
          if (fault === "operation-generation") operation.generation = 2;
          if (fault === "operation-id") operation.id = "foreign-operation";
          if (fault === "operation-effect") operation.effect = "none";
          if (fault === "phase") resource.phase = "updating";
          if (fault === "observed-generation") resource.observedGeneration = 0;
          if (fault === "last-operation") resource.lastOperation = "foreign-operation";
        }
        resources.set(resourceUid, resource);
        operations.set(id, operation);
        return Response.json({ id, resourceUid }, { status: 202 });
      }
      if (url.pathname.startsWith("/host/v2/operations/")) {
        const id = url.pathname.split("/").at(-1) ?? "";
        if (id === endpointOperation) operationReads++;
        return Response.json(operations.get(id));
      }
      if (url.pathname.startsWith("/host/v2/resources/")) {
        const resourceUid = url.pathname.split("/").at(-1) ?? "";
        if (resourceUid === uid) resourceReads++;
        return Response.json(resources.get(resourceUid));
      }
      throw new Error("unexpected fixture request");
    };
    try {
      await expect(
        runHostedStagingE2E({
          ...fixture.options,
          fetcher: withOriginalReservationCarrier(fetcher, fixture.options),
          now: () => new Date(),
        }),
      ).rejects.toThrow();
      expect(endpointCreates).toBe(1);
      expect(operationReads).toBe(1);
      expect(resourceReads).toBe(fault === "operation-id" || fault === "operation-effect" ? 0 : 1);
      expect(probes).toBe(0);
      const journal = (await readFile(fixture.options.journalPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(journal.filter((row) => row.kind === "accepted" && row.uid === uid)).toHaveLength(1);
      expect(journal.some((row) => row.kind === "endpoint-request-intent")).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("unknown CREATE acknowledgement stops without retry and preserves intent without provider secret text", async () => {
  const fixture = await harnessFixture();
  let mutations = 0;
  const fetcher = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/.well-known/takoform/v2")
      return Response.json({ api: "forms.takoform.com/v2", baseUrl: `${url.origin}/host/v2` });
    if (url.pathname.endsWith("/support"))
      return Response.json({ supported: true, form: url.searchParams.get("form") });
    if (url.pathname === "/host/v2/resources" && init?.method === "GET")
      return Response.json({ items: [], nextCursor: null });
    if (init?.method === "POST") {
      mutations++;
      throw new Error("provider diagnostic contains synthetic-writer-secret-only");
    }
    return Response.json({});
  };
  try {
    await expect(
      runHostedStagingE2E({
        ...fixture.options,
        fetcher: withOriginalReservationCarrier(fetcher, fixture.options),
        now: () => new Date(),
      }),
    ).rejects.toThrow("acknowledgement unknown");
    expect(mutations).toBe(1);
    const journal = await readFile(fixture.options.journalPath, "utf8");
    expect(journal).toContain("mutation-intent");
    expect(journal).not.toContain("synthetic-writer-secret-only");
    expect(JSON.parse(await readFile(fixture.options.outputPath, "utf8")).status).toBe(
      "INCOMPLETE",
    );
    await expect(
      runHostedStagingE2E({
        ...fixture.options,
        fetcher: withOriginalReservationCarrier(fetcher, fixture.options),
        now: () => new Date(),
      }),
    ).rejects.toThrow();
    expect(mutations).toBe(1);
    expect(await readFile(fixture.options.journalPath, "utf8")).toBe(journal);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("foreign discovery cannot receive credentials and unsupported Form causes zero writes", async () => {
  for (const foreign of [true, false]) {
    const fixture = await harnessFixture();
    let mutations = 0;
    let foreignRequests = 0;
    const fetcher = async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "integration-api.takoserver.com") foreignRequests++;
      if (init?.method === "POST") mutations++;
      if (url.pathname === "/.well-known/takoform/v2")
        return Response.json({
          api: "forms.takoform.com/v2",
          baseUrl: foreign ? "https://foreign.example.test/host/v2" : `${url.origin}/host/v2`,
        });
      return Response.json({ supported: false, form: url.searchParams.get("form") });
    };
    try {
      await expect(
        runHostedStagingE2E({
          ...fixture.options,
          fetcher: withOriginalReservationCarrier(fetcher, fixture.options),
          now: () => new Date(),
        }),
      ).rejects.toThrow(foreign ? "origin" : "support");
      expect(mutations).toBe(0);
      expect(foreignRequests).toBe(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("read-only fixture verification detects altered bytes and emission never overwrites existing artifacts", async () => {
  const fixture = await harnessFixture();
  try {
    expect((await checkHostedSampleFixture(fixture.options.fixturePath)).counts).toEqual(
      SAMPLE_COUNTS,
    );
    await expect(
      writeHostedSampleFixture({
        artifactBaseUrl: "https://artifacts.example.test/sample/",
        outputDirectory: join(fixture.root, "fixture"),
      }),
    ).rejects.toThrow();
    await writeFile(
      join(fixture.root, "fixture", "assets", "files", "sample.txt"),
      "altered bytes",
    );
    await expect(checkHostedSampleFixture(fixture.options.fixturePath)).rejects.toThrow("digest");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an accepted Operation survives a malformed Resource acknowledgement in the journal", async () => {
  const fixture = await harnessFixture();
  let mutations = 0;
  const fetcher = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/.well-known/takoform/v2")
      return Response.json({ api: "forms.takoform.com/v2", baseUrl: `${url.origin}/host/v2` });
    if (url.pathname.endsWith("/support"))
      return Response.json({ supported: true, form: url.searchParams.get("form") });
    if (init?.method === "POST") {
      mutations++;
      return Response.json({ id: "accepted-op-owned", resourceUid: null });
    }
    return Response.json({ items: [], nextCursor: null });
  };
  try {
    await expect(
      runHostedStagingE2E({
        ...fixture.options,
        fetcher: withOriginalReservationCarrier(fetcher, fixture.options),
        now: () => new Date(),
      }),
    ).rejects.toThrow();
    expect(mutations).toBe(1);
    expect(await readFile(fixture.options.journalPath, "utf8")).toContain("accepted-op-owned");
    expect(JSON.parse(await readFile(fixture.options.outputPath, "utf8")).status).toBe(
      "INCOMPLETE",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("typed Endpoint origin binds the bounded accepted name, UID, create Operation and original", () => {
  for (const runId of ["sample-run", "a".repeat(64), "sample.with_underscores"]) {
    const name = hostedSampleEndpointName(runId);
    expect(name).toMatch(/^integration-[a-f0-9]{16}-ep$/u);
    expect(name).toHaveLength(31);
    expect(hostedSampleEndpointName(runId)).toBe(name);
  }
  expect(hostedSampleEndpointName("sample-run")).not.toBe(hostedSampleEndpointName("sample-run-2"));
  expect(() => hostedSampleEndpointName("bad")).toThrow();
  const name = hostedSampleEndpointName("sample-run");
  const uid = "01234567-89ab-4def-8123-456789abcdef";
  const origin = `https://${name}.app-staging.takos.jp`;
  const resource: Record<string, unknown> = {
    uid,
    name,
    space: "actual-org",
    form: WORKER_ENDPOINT_FORM_URL,
    generation: 1,
    observedGeneration: 1,
    phase: "idle",
    lastOperation: "accepted-create-op",
    spec: { worker: { resourceUid: "accepted-worker-uid" } },
    output: { hostname: `${name}.app-staging.takos.jp`, url: `${origin}/` },
  };
  const operation: Record<string, unknown> = {
    id: "accepted-create-op",
    resourceUid: uid,
    action: "create",
    generation: 1,
    status: "succeeded",
    effect: "complete",
  };
  const input = {
    name,
    space: "actual-org",
    workerUid: "accepted-worker-uid",
    reservedOrigin: origin,
    endpoint: {
      uid,
      operationId: "accepted-create-op",
      resource,
      operation,
    },
  };
  expect(typedEndpointUrlFromResource(input)).toBe(origin);
  const mutations: ((candidate: typeof input) => void)[] = [
    (v) => {
      v.endpoint.uid = "01234567-89ab-4def-8123-456789abcdee";
    },
    (v) => {
      v.endpoint.operationId = "foreign-op";
    },
    (v) => {
      v.endpoint.resource.name = "integration-foreign";
    },
    (v) => {
      v.endpoint.resource.space = "foreign-org";
    },
    (v) => {
      v.endpoint.resource.form = MODULE_WORKER_FORM_URL;
    },
    (v) => {
      v.endpoint.resource.generation = 2;
    },
    (v) => {
      v.endpoint.resource.spec = { worker: { resourceUid: "foreign-worker" } };
    },
    (v) => {
      v.endpoint.operation.resourceUid = "foreign-uid";
    },
    (v) => {
      v.endpoint.operation.action = "update";
    },
    (v) => {
      v.endpoint.operation.generation = 2;
    },
    (v) => {
      v.endpoint.operation.status = "running";
    },
    (v) => {
      v.endpoint.operation.effect = "none";
    },
    (v) => {
      v.reservedOrigin = `${origin}/`;
    },
    (v) => {
      v.endpoint.resource.output = {
        hostname: `${name}.app-staging.takos.jp`,
        url: `${origin}/#alias`,
      };
    },
    (v) => {
      const hostname = `integration-v2-${uid.replaceAll("-", "")}.app-staging.takos.jp`;
      v.endpoint.resource.output = { hostname, url: `https://${hostname}/` };
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(input);
    mutate(candidate);
    expect(() => typedEndpointUrlFromResource(candidate)).toThrow("accepted name, UID, Operation");
  }
});

test("both authenticated keys must prove the explicit organization Space before any reservation or graph write", async () => {
  for (const fault of ["writer-denied", "evidence-denied", "foreign-row", "malformed-list"]) {
    const fixture = await harnessFixture();
    const roles: string[] = [];
    let mutations = 0;
    const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      if (init?.method !== "GET") mutations++;
      if (url.pathname === "/.well-known/takoform/v2")
        return Response.json({ api: "forms.takoform.com/v2", baseUrl: `${url.origin}/host/v2` });
      if (url.pathname.endsWith("/support"))
        return Response.json({ supported: true, form: url.searchParams.get("form") });
      expect(url.pathname).toBe("/host/v2/resources");
      expect(url.searchParams.get("space")).toBe(fixture.options.space);
      expect(url.searchParams.get("limit")).toBe("1");
      expect(url.searchParams.has("name")).toBe(false);
      const role =
        new Headers(init?.headers).get("authorization") === "Bearer synthetic-writer-secret-only"
          ? "writer"
          : "evidence";
      roles.push(role);
      if (fault === `${role}-denied`) return Response.json({ code: "forbidden" }, { status: 403 });
      if (fault === "foreign-row")
        return Response.json({ items: [{ uid: "foreign", space: "other-org" }] });
      if (fault === "malformed-list") return Response.json({ items: null });
      return Response.json({ items: [], nextCursor: null });
    };
    try {
      await expect(
        runHostedStagingE2E({ ...fixture.options, fetcher, now: () => new Date() }),
      ).rejects.toThrow();
      expect(roles).toEqual(fault === "evidence-denied" ? ["writer", "evidence"] : ["writer"]);
      expect(mutations).toBe(0);
      const journal = await readFile(fixture.options.journalPath, "utf8");
      expect(journal).not.toContain("original-reservation-intent");
      expect(journal).not.toContain("mutation-intent");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("original reservation refuses collisions, ambiguous acknowledgement and changed readback before graph CREATE", async () => {
  for (const fault of [
    "present",
    "wrong-404",
    "permission",
    "unknown-put",
    "wrong-origin",
    "wrong-name",
    "wrong-id",
    "expired",
    "bound",
    "changed-readback",
    "unknown-readback",
  ]) {
    const fixture = await harnessFixture();
    let gets = 0;
    let puts = 0;
    let graphWrites = 0;
    const name = hostedSampleEndpointName(fixture.options.runId);
    const projection = {
      format: "takoserver.worker-endpoint-origin-reservation.v2",
      reservationId: `integration-wfp-${fixture.options.runId}-origin`,
      requestedSubdomain: name,
      canonicalPublicOrigin: `https://${name}.app-staging.takos.jp`,
      revision: "1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      status: "prepared",
    };
    const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      expect(url.origin).toBe(fixture.options.origin);
      if (url.pathname === "/.well-known/takoform/v2")
        return Response.json({ api: "forms.takoform.com/v2", baseUrl: `${url.origin}/host/v2` });
      if (url.pathname.endsWith("/support"))
        return Response.json({ supported: true, form: url.searchParams.get("form") });
      if (url.pathname === "/host/v2/resources" && init?.method === "GET")
        return Response.json({ items: [], nextCursor: null });
      if (url.pathname.startsWith("/v1/worker-endpoint-origin-reservations/")) {
        expect(url.pathname).toBe(
          `/v1/worker-endpoint-origin-reservations/${projection.reservationId}`,
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer synthetic-writer-secret-only",
        );
        if (init?.method === "GET") {
          gets++;
          if (gets === 1) {
            if (fault === "present") return Response.json(projection);
            if (fault === "permission")
              return Response.json({ error: { code: "forbidden" } }, { status: 403 });
            return Response.json(
              { error: { code: fault === "wrong-404" ? "other_absence" : "not_found" } },
              { status: 404 },
            );
          }
          if (fault === "unknown-readback")
            throw new Error("synthetic-provider-secret-never-persist");
          return Response.json({
            ...projection,
            revision: fault === "changed-readback" ? "2" : "1",
          });
        }
        expect(init?.method).toBe("PUT");
        puts++;
        const journal = await readFile(fixture.options.journalPath, "utf8");
        expect(journal).toContain("original-reservation-intent");
        expect(journal).toContain(projection.reservationId);
        if (fault === "unknown-put") throw new Error("synthetic-provider-secret-never-persist");
        return Response.json(
          {
            ...projection,
            ...(fault === "wrong-origin"
              ? { canonicalPublicOrigin: "https://arbitrary.example.test" }
              : {}),
            ...(fault === "wrong-name" ? { requestedSubdomain: "integration-foreign" } : {}),
            ...(fault === "wrong-id" ? { reservationId: "foreign-id" } : {}),
            ...(fault === "expired" ? { expiresAt: "2000-01-01T00:00:00.000Z" } : {}),
            ...(fault === "bound" ? { status: "bound" } : {}),
          },
          { status: 201 },
        );
      }
      graphWrites++;
      throw new Error("graph must remain untouched");
    };
    try {
      await expect(
        runHostedStagingE2E({ ...fixture.options, fetcher, now: () => new Date() }),
      ).rejects.toThrow();
      const beforePut = ["present", "wrong-404", "permission"].includes(fault);
      expect(puts).toBe(beforePut ? 0 : 1);
      expect(gets).toBe(fault === "changed-readback" || fault === "unknown-readback" ? 2 : 1);
      expect(graphWrites).toBe(0);
      const journal = await readFile(fixture.options.journalPath, "utf8");
      expect(journal).not.toContain("synthetic-provider-secret-never-persist");
      expect(journal).not.toContain("mutation-intent");
      if (!beforePut) expect(journal).toContain("original-reservation-intent");
      if (fault === "changed-readback" || fault === "unknown-readback")
        expect(journal).toContain("original-reservation-acknowledged");
      expect(JSON.parse(await readFile(fixture.options.outputPath, "utf8")).status).toBe(
        "INCOMPLETE",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});
