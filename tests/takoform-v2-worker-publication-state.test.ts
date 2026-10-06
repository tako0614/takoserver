import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const BUNDLE_FORM_URL = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";

// The Version backend below is a graph-only substitute, not ABI qualification;
// its Bundle dependency uses real verified SQL byte custody.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v2-publication-"));
  const path = join(root, "state.sqlite");
  const db = new Database(path);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  // Custody write guards use SQLite's real clock; advance from that same epoch.
  let clockMs = Date.now();
  const now = () => new Date(clockMs++);
  const moduleUrl = "https://artifacts.example.test/fixture/index.js";
  const manifestUrl = "https://artifacts.example.test/fixture/manifest.json";
  const moduleBytes = new TextEncoder().encode("export default { fetch() {} };");
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.js",
      files: [
        {
          path: "index.js",
          url: moduleUrl,
          sha256: digest(moduleBytes),
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const bundleHost = createWorkerBundleHost({
    sql,
    targetKey: "fixture-workerd-root",
    source: {
      async read({ url }) {
        if (url === manifestUrl) return manifestBytes;
        if (url === moduleUrl) return moduleBytes;
        throw new Error("unknown fixture artifact");
      },
    },
  });
  const backend = {
    id: "fixture-worker-publication-v1",
    targetKey: "fixture-workerd-root",
    async execute(input: V2Execution) {
      const observed =
        input.form === WORKER_VERSION_FORM_URL
          ? { ready: true, resolvedBindings: true, bundleVerified: true }
          : input.form === WORKER_DEPLOYMENT_FORM_URL
            ? { ready: true, active: true, selectedVersions: [] }
            : input.form === WORKER_ENDPOINT_FORM_URL
              ? { tlsReady: true, activeDeploymentRouteReady: true }
              : { ready: true };
      return { kind: "complete" as const, observed, output: input.previousOutput };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const form = (extra: Partial<V2Form> = {}): V2Form => ({
    validateCreate() {},
    validateUpdate() {},
    backend,
    ...extra,
  });
  const forms = {
    [MODULE_WORKER_FORM_URL]: form(),
    [BUNDLE_FORM_URL]: bundleHost.form,
    [WORKER_VERSION_FORM_URL]: form({
      references(spec) {
        const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
        const bundleUid = (spec.bundle as { resourceUid: string }).resourceUid;
        return [
          { resourceUid: workerUid, formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
          { resourceUid: bundleUid, formUrl: BUNDLE_FORM_URL, readiness: "observed" },
        ];
      },
    }),
    [WORKER_DEPLOYMENT_FORM_URL]: form({
      references(spec) {
        const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
        const versions = spec.versions as { workerVersion: { resourceUid: string } }[];
        return [
          { resourceUid: workerUid, formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
          ...versions.map((item) => ({
            resourceUid: item.workerVersion.resourceUid,
            formUrl: WORKER_VERSION_FORM_URL,
            readiness: "ready" as const,
            targetSpecMatch: { path: ["worker", "resourceUid"], equals: workerUid },
          })),
        ];
      },
    }),
    [WORKER_ENDPOINT_FORM_URL]: form({
      references(spec) {
        return [
          {
            resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
            formUrl: MODULE_WORKER_FORM_URL,
            readiness: "observed",
          },
        ];
      },
      initialOutput() {
        return { hostname: "assigned.example.test", url: "https://assigned.example.test/" };
      },
    }),
  };
  const engine = createTakoformV2Engine({
    sql,
    now,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms,
  });
  const store = createV2Store(sql);
  const reader = createV2WorkerPublicationState({
    sql,
    now: () => new Date(clockMs),
    bundleCustody: bundleHost.custody,
  });

  async function create(form: string, name: string, spec: JsonObject, settle = true) {
    const accepted = await engine.acceptCreate({
      principal: "org-1",
      key: `create-${name}-key-0001`,
      input: { form, space: "prod", name, spec },
    });
    if (settle)
      expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    return accepted;
  }
  async function basics() {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bundle = await create(BUNDLE_FORM_URL, "bundle", {
      artifact: { url: manifestUrl, sha256: digest(manifestBytes) },
    });
    const version = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    });
    return { worker, bundle, version };
  }
  async function claim(operationId: string): Promise<V2Execution> {
    const op = await store.operation(operationId);
    if (!op) throw new Error("missing accepted operation");
    const resource = await store.resource(op.resource_uid);
    if (!resource) throw new Error("missing resource");
    const token = `lease-${operationId}`;
    expect(await store.claim(op.id, token, clockMs, clockMs + 60_000)).toBe(true);
    expect(await store.markDispatch(op.id, token, new Date(clockMs).toISOString())).toBe(true);
    return {
      operationId: op.id,
      leaseToken: token,
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
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
    };
  }
  async function settle(execution: V2Execution) {
    expect(
      await store.settle({
        id: execution.operationId,
        token: execution.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: new Date(clockMs++).toISOString(),
        retainUntil: new Date(clockMs + 3_600_000).toISOString(),
        observedJson: JSON.stringify({ ready: true, active: true, selectedVersions: [] }),
        outputJson: JSON.stringify(execution.previousOutput),
      }),
    ).toBe(true);
  }
  return {
    root,
    path,
    db,
    sql,
    engine,
    store,
    reader,
    create,
    basics,
    claim,
    settle,
    setClock(value: number) {
      clockMs = value;
    },
    currentClock() {
      return clockMs;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("accepted Deployment overlays only its own operation and fences every graph change", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    };
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", spec, false);
    const replay = await f.engine.acceptCreate({
      principal: "org-1",
      key: "create-deployment-key-0001",
      input: { form: WORKER_DEPLOYMENT_FORM_URL, space: "prod", name: "deployment", spec },
    });
    expect(replay.id).toBe(deployment.id);
    const execution = await f.claim(deployment.id);
    // The route fence uses the database clock, not this fixture's logical Host clock.
    await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = ? WHERE id = ?", [
      Date.now() + 60_000,
      deployment.id,
    ]);
    const resolved = await f.reader.resolve({ execution });
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") return;
    expect(resolved.snapshot.deployment?.versions).toMatchObject([
      { uid: version.resourceUid, weight: 10_000, spec: { handlers: ["fetch"] } },
    ]);
    expect(resolved.snapshot.endpoint).toBeNull();
    expect(Object.isFrozen(resolved.snapshot.deployment?.versions[0]?.spec)).toBe(true);
    expect(await resolved.stillCurrent()).toBe(true);
    f.db.exec("CREATE TABLE test_publication_route (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    f.db.exec("INSERT INTO test_publication_route VALUES ('worker', 'old')");
    const guardedWrite = (value: string) =>
      f.sql.run(
        `UPDATE test_publication_route SET value = ? WHERE id = 'worker' AND (${resolved.sqlGuard.sql})`,
        [value, ...resolved.sqlGuard.params],
      );
    expect(resolved.sqlGuard.params.length + 13).toBeLessThanOrEqual(100);
    // This is the real settled WorkerBundle graph, not a hand-built row image.
    expect((await guardedWrite("held-bundle-graph")).changes).toBe(1);

    const endpoint = await f.create(
      WORKER_ENDPOINT_FORM_URL,
      "endpoint",
      { worker: { resourceUid: worker.resourceUid } },
      false,
    );
    expect(await resolved.stillCurrent()).toBe(false);
    expect((await guardedWrite("stale-graph")).changes).toBe(0);
    const current = await f.reader.resolve({ execution });
    expect(current.kind).toBe("ready"); // later pending Endpoint is never adopted
    if (current.kind === "ready") expect(current.snapshot.endpoint).toBeNull();
    const endpointExecution = await f.claim(endpoint.id);
    expect(await f.reader.resolve({ execution: endpointExecution })).toMatchObject({
      kind: "unresolved",
      code: "publication_conflict",
    });
  } finally {
    f.close();
  }
});

for (const endpointAction of ["update", "delete"] as const) {
  test(`a pending Endpoint ${endpointAction} retains its confirmed route while earlier Deployment publishes`, async () => {
    const f = fixture();
    try {
      const { worker, version } = await f.basics();
      const deploymentSpec = {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      };
      const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", deploymentSpec);
      const endpointSpec = { worker: { resourceUid: worker.resourceUid } };
      const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", endpointSpec);
      const deploymentUpdate = await f.engine.acceptUpdate({
        principal: "org-1",
        key: `deployment-update-${endpointAction}-key`,
        uid: deployment.resourceUid,
        expectedGeneration: 1,
        spec: deploymentSpec,
      });
      const endpointChange =
        endpointAction === "update"
          ? await f.engine.acceptUpdate({
              principal: "org-1",
              key: "endpoint-update-key-0001",
              uid: endpoint.resourceUid,
              expectedGeneration: 1,
              spec: endpointSpec,
            })
          : await f.engine.acceptDelete({
              principal: "org-1",
              key: "endpoint-delete-key-0001",
              uid: endpoint.resourceUid,
              expectedGeneration: 1,
            });
      const deploymentExecution = await f.claim(deploymentUpdate.id);
      const first = await f.reader.resolve({ execution: deploymentExecution });
      expect(first.kind).toBe("ready");
      if (first.kind === "ready") {
        expect(first.snapshot.endpoint).toMatchObject({
          uid: endpoint.resourceUid,
          generation: 1,
          output: { hostname: "assigned.example.test" },
        });
      }
      const endpointExecution = await f.claim(endpointChange.id);
      expect(await f.reader.resolve({ execution: endpointExecution })).toMatchObject({
        kind: "unresolved",
        code: "publication_conflict",
      });
      await f.settle(deploymentExecution);
      const second = await f.reader.resolve({
        execution: endpointExecution,
        incumbentSourceOperationId: deploymentUpdate.id,
      });
      expect(second.kind).toBe("ready");
      if (second.kind === "ready") {
        expect(second.snapshot.deployment?.uid).toBe(deployment.resourceUid);
        expect(second.snapshot.endpoint === null).toBe(endpointAction === "delete");
      }
    } finally {
      f.close();
    }
  });
}

test("confirmed Endpoint delete remains valid incumbent provenance for later Deployment publication", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    };
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", spec);
    const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
      worker: { resourceUid: worker.resourceUid },
    });
    const deleteOp = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-endpoint-key-0001",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
    });
    const deleteExecution = await f.claim(deleteOp.id);
    expect((await f.reader.resolve({ execution: deleteExecution })).kind).toBe("ready");
    await f.settle(deleteExecution);
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-deployment-after-endpoint-delete",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    const resolved = await f.reader.resolve({
      execution: await f.claim(update.id),
      incumbentSourceOperationId: deleteOp.id,
    });
    expect(resolved.kind).toBe("ready");
    if (resolved.kind === "ready") expect(resolved.snapshot.endpoint).toBeNull();
  } finally {
    f.close();
  }
});

test("published pending incumbent blocks later operation even when its clock sorts later", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const first = await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    const firstExecution = await f.claim(first.id);
    expect((await f.reader.resolve({ execution: firstExecution })).kind).toBe("ready");
    f.setClock(f.currentClock() - 10_000); // accepted_at is not a native publication fence
    const second = await f.create(
      WORKER_ENDPOINT_FORM_URL,
      "endpoint",
      { worker: { resourceUid: worker.resourceUid } },
      false,
    );
    const secondExecution = await f.claim(second.id);
    expect(
      await f.reader.resolve({
        execution: secondExecution,
        incumbentSourceOperationId: first.id,
      }),
    ).toMatchObject({ kind: "unresolved", code: "incumbent_unresolved" });
    expect(
      (await f.reader.resolve({ execution: firstExecution, incumbentSourceOperationId: first.id }))
        .kind,
    ).toBe("ready");
  } finally {
    f.close();
  }
});

test("lease expiry, wrong owner, and committed pointer with unsettled operation fail closed", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const deployment = await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    const execution = await f.claim(deployment.id);
    expect(
      await f.reader.resolve({ execution: { ...execution, principal: "org-other" } }),
    ).toMatchObject({
      kind: "unresolved",
      code: "stale_claim",
    });
    expect(
      await f.reader.resolve({ execution, incumbentSourceOperationId: "nonexistent" }),
    ).toMatchObject({ kind: "unresolved", code: "incumbent_unresolved" });
    expect(
      (await f.reader.resolve({ execution, incumbentSourceOperationId: deployment.id })).kind,
    ).toBe("ready");
    f.setClock(f.currentClock() + 60_001);
    expect(await f.reader.resolve({ execution })).toMatchObject({
      kind: "unresolved",
      code: "stale_claim",
    });
  } finally {
    f.close();
  }
});

test("a prior partial publication is not silently replaced by a new accepted update", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    };
    const create = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", spec, false);
    const first = await f.claim(create.id);
    expect(
      await f.store.settle({
        id: first.operationId,
        token: first.leaseToken,
        status: "failed",
        effect: "partial",
        at: new Date(f.currentClock()).toISOString(),
        retainUntil: new Date(f.currentClock() + 3_600_000).toISOString(),
        error: { code: "partial_publication", message: "A private publication may remain" },
      }),
    ).toBe(true);
    const update = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "retry-after-partial-deployment-key",
      uid: create.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    expect(await f.reader.resolve({ execution: await f.claim(update.id) })).toMatchObject({
      kind: "unresolved",
      code: "graph_unresolved",
    });
  } finally {
    f.close();
  }
});

test("a second Deployment UID cannot replace an active one and references are same-owner/Space", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    };
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "first", spec);
    const second = await f.create(WORKER_DEPLOYMENT_FORM_URL, "second", spec, false);
    expect(await f.reader.resolve({ execution: await f.claim(second.id) })).toMatchObject({
      kind: "unresolved",
      code: "publication_conflict",
    });
    await expect(
      f.engine.acceptCreate({
        principal: "org-other",
        key: "foreign-deployment-key",
        input: { form: WORKER_DEPLOYMENT_FORM_URL, space: "prod", name: "foreign", spec },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict" });
    await expect(
      f.engine.acceptCreate({
        principal: "org-1",
        key: "wrong-space-deployment-key",
        input: { form: WORKER_DEPLOYMENT_FORM_URL, space: "other", name: "wrong-space", spec },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict" });
  } finally {
    f.close();
  }
});

test("fresh SQLite handle preserves accepted claim and sealed graph; this is not an OS restart", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const deployment = await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    const execution = await f.claim(deployment.id);
    const secondDb = new Database(f.path);
    try {
      const reopened = createV2WorkerPublicationState({
        sql: createSqliteSql(secondDb),
        now: () => new Date(f.currentClock()),
      });
      const result = await reopened.resolve({ execution });
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") expect(await result.stillCurrent()).toBe(true);
    } finally {
      secondDb.close();
    }
  } finally {
    f.close();
  }
});

test("graph read and stillCurrent refuse a claim whose lease expires during the final awaited query", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const deployment = await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    const execution = await f.claim(deployment.id);
    let expireOnVersionRead = false;
    let advanced = false;
    const delayedSql = {
      ...f.sql,
      async query(...args: Parameters<typeof f.sql.query>) {
        const rows = await f.sql.query(...args);
        if (
          expireOnVersionRead &&
          !advanced &&
          args[0].includes("FROM tf_v2_operation_references WHERE operation_id") &&
          args[1]?.[0] === version.id
        ) {
          f.setClock(f.currentClock() + 60_001);
          advanced = true;
        }
        return rows;
      },
    };
    const reader = createV2WorkerPublicationState({
      sql: delayedSql,
      now: () => new Date(f.currentClock()),
    });
    const current = await reader.resolve({ execution });
    expect(current.kind).toBe("ready");
    if (current.kind !== "ready") return;
    const liveClock = f.currentClock();
    expireOnVersionRead = true;
    expect(await current.stillCurrent()).toBe(false);
    expect(advanced).toBe(true);
    f.setClock(liveClock);
    advanced = false;
    expect(await reader.resolve({ execution })).toMatchObject({
      kind: "unresolved",
      code: "stale_claim",
    });
  } finally {
    f.close();
  }
});

test("a live Deployment claim rematerializes settled Version bytes from verified custody after a fresh SQL handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-held-version-"));
  const path = join(root, "state.sqlite");
  const db = new Database(path);
  let reopened: Database | undefined;
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    let nowMs = Date.now();
    const now = () => new Date(nowMs++);
    const moduleBytes = new TextEncoder().encode(
      "export default { fetch() { return new Response('held'); } };",
    );
    const moduleDigest = (await bytesDigest(moduleBytes)).slice(7);
    const manifestUrl = "https://artifacts.example.test/worker/manifest.json";
    const moduleUrl = "https://artifacts.example.test/worker/index.js";
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "index.js",
        files: [
          {
            path: "index.js",
            url: moduleUrl,
            sha256: moduleDigest,
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    const manifestDigest = (await bytesDigest(manifestBytes)).slice(7);
    const assetBytes = new TextEncoder().encode("<h1>held asset</h1>");
    const assetDigest = (await bytesDigest(assetBytes)).slice(7);
    const assetManifestUrl = "https://artifacts.example.test/assets/manifest.json";
    const assetUrl = "https://artifacts.example.test/assets/index.html";
    const assetManifestBytes = new TextEncoder().encode(
      JSON.stringify({
        files: [{ path: "index.html", url: assetUrl, sha256: assetDigest, mediaType: "text/html" }],
      }),
    );
    const assetManifestDigest = (await bytesDigest(assetManifestBytes)).slice(7);
    let sourceReads = 0;
    let sourceAvailable = true;
    const source = {
      async read({ url }: { url: string }) {
        sourceReads += 1;
        if (!sourceAvailable) throw new Error("source is gone");
        if (url === manifestUrl) return manifestBytes;
        if (url === moduleUrl) return moduleBytes;
        if (url === assetManifestUrl) return assetManifestBytes;
        if (url === assetUrl) return assetBytes;
        throw new Error("unknown source");
      },
    };
    const targetKey = "held-worker-materialization-sqlite";
    const bundleHost = createWorkerBundleHost({ sql, source, targetKey });
    const assetHost = createStaticAssetBundleHost({ sql, source, targetKey });
    const backend = {
      id: "fixture-worker-materialization-v1",
      targetKey,
      async execute(input: V2Execution) {
        const observed =
          input.form === WORKER_VERSION_FORM_URL
            ? { ready: true, resolvedBindings: true, bundleVerified: true }
            : { ready: true, active: true };
        return { kind: "complete" as const, observed, output: input.previousOutput };
      },
      async reconcile(input: V2Execution) {
        return await this.execute(input);
      },
    };
    const form = (extra: Partial<V2Form> = {}): V2Form => ({
      validateCreate() {},
      validateUpdate() {},
      backend,
      ...extra,
    });
    const forms = {
      [MODULE_WORKER_FORM_URL]: form(),
      "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/": bundleHost.form,
      [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
      [WORKER_VERSION_FORM_URL]: form({
        references(spec) {
          return [
            {
              resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
              formUrl: MODULE_WORKER_FORM_URL,
              readiness: "observed",
            },
            {
              resourceUid: (spec.bundle as { resourceUid: string }).resourceUid,
              formUrl: BUNDLE_FORM_URL,
              readiness: "observed",
            },
            ...(spec.assets
              ? [
                  {
                    resourceUid: (spec.assets as { bundle: { resourceUid: string } }).bundle
                      .resourceUid,
                    formUrl: STATIC_ASSET_BUNDLE_FORM_URL,
                    readiness: "observed" as const,
                  },
                ]
              : []),
          ];
        },
      }),
      [WORKER_DEPLOYMENT_FORM_URL]: form({
        references(spec) {
          const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
          return [
            { resourceUid: workerUid, formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
            ...(spec.versions as { workerVersion: { resourceUid: string } }[]).map((entry) => ({
              resourceUid: entry.workerVersion.resourceUid,
              formUrl: WORKER_VERSION_FORM_URL,
              readiness: "ready" as const,
              targetSpecMatch: { path: ["worker", "resourceUid"], equals: workerUid },
            })),
          ];
        },
      }),
      [WORKER_ENDPOINT_FORM_URL]: form({
        references(spec) {
          return [
            {
              resourceUid: (spec.worker as { resourceUid: string }).resourceUid,
              formUrl: MODULE_WORKER_FORM_URL,
              readiness: "observed",
            },
          ];
        },
        initialOutput() {
          return { hostname: "held.example.test", url: "https://held.example.test/" };
        },
      }),
    };
    const engine = createTakoformV2Engine({
      sql,
      now,
      replayWindowSeconds: 3600,
      leaseMilliseconds: 60_000,
      authorize: async () => true,
      forms,
    });
    const create = async (formUrl: string, name: string, spec: JsonObject, settle = true) => {
      const accepted = await engine.acceptCreate({
        principal: "org-1",
        key: `create-${name}-materialization-key`,
        input: { form: formUrl, space: "prod", name, spec },
      });
      if (settle)
        expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
      return accepted;
    };
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bundle = await create(BUNDLE_FORM_URL, "bundle", {
      artifact: { url: manifestUrl, sha256: manifestDigest },
    });
    const asset = await create(STATIC_ASSET_BUNDLE_FORM_URL, "asset", {
      artifact: { url: assetManifestUrl, sha256: assetManifestDigest },
    });
    sourceAvailable = false;
    const version = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      assets: {
        bundle: { resourceUid: asset.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    const deploymentSpec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    };
    const deployment = await create(
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      deploymentSpec,
      false,
    );
    const replay = await engine.acceptCreate({
      principal: "org-1",
      key: "create-deployment-materialization-key",
      input: {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "prod",
        name: "deployment",
        spec: deploymentSpec,
      },
    });
    expect(replay.id).toBe(deployment.id);
    const store = createV2Store(sql);
    const op = await store.operation(deployment.id);
    const resource = op ? await store.resource(op.resource_uid) : null;
    if (!op || !resource) throw new Error("missing accepted Deployment");
    const token = "held-deployment-lease";
    expect(await store.claim(op.id, token, nowMs, nowMs + 60_000)).toBe(true);
    expect(await store.markDispatch(op.id, token, new Date(nowMs).toISOString())).toBe(true);
    const execution: V2Execution = {
      operationId: op.id,
      leaseToken: token,
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
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
    };
    const reader = createV2WorkerPublicationState({
      sql,
      now: () => new Date(nowMs),
      bundleCustody: bundleHost.custody,
      assetCustody: assetHost.custody,
    });
    const current = await reader.resolve({ execution });
    expect(current.kind).toBe("ready");
    if (current.kind !== "ready") return;
    expect(
      new TextDecoder().decode(
        (await current.readVersionMaterials(version.resourceUid)).bundle?.files[0],
      ),
    ).toBe("export default { fetch() { return new Response('held'); } };");
    expect(
      new TextDecoder().decode(
        (await current.readVersionMaterials(version.resourceUid)).assets?.files[0],
      ),
    ).toBe("<h1>held asset</h1>");
    const callerOwned = await current.readVersionMaterials(version.resourceUid);
    callerOwned.bundle?.files[0]?.fill(0);
    callerOwned.assets?.files[0]?.fill(0);
    const reread = await current.readVersionMaterials(version.resourceUid);
    expect(new TextDecoder().decode(reread.bundle?.files[0])).toContain("fetch()");
    expect(new TextDecoder().decode(reread.assets?.files[0])).toBe("<h1>held asset</h1>");
    const priorSourceReads = sourceReads;
    reopened = new Database(path);
    const reopenedSql = createSqliteSql(reopened);
    const reopenedBundle = createWorkerBundleHost({ sql: reopenedSql, source, targetKey });
    const reopenedAsset = createStaticAssetBundleHost({ sql: reopenedSql, source, targetKey });
    const restarted = createV2WorkerPublicationState({
      sql: reopenedSql,
      now: () => new Date(nowMs),
      bundleCustody: reopenedBundle.custody,
      assetCustody: reopenedAsset.custody,
    });
    const afterRestart = await restarted.resolve({ execution });
    expect(afterRestart.kind).toBe("ready");
    if (afterRestart.kind === "ready") {
      const held = await afterRestart.readVersionMaterials(version.resourceUid);
      expect(held.bundle?.manifest.entrypoint).toBe("index.js");
      expect(held.assets?.manifest.files[0]?.path).toBe("index.html");
      expect(new TextDecoder().decode(held.bundle?.files[0])).toBe(
        "export default { fetch() { return new Response('held'); } };",
      );
    }
    expect(sourceReads).toBe(priorSourceReads);
    await expect(current.readVersionMaterials("wrong-selected-version")).rejects.toThrow();
    const foreignWorker = await engine.acceptCreate({
      principal: "org-2",
      key: "foreign-worker-materialization",
      input: {
        form: MODULE_WORKER_FORM_URL,
        space: "prod",
        name: "foreign-worker",
        spec: {},
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: foreignWorker.id, status: "succeeded" });
    await expect(
      engine.acceptCreate({
        principal: "org-2",
        key: "foreign-version-materialization",
        input: {
          form: WORKER_VERSION_FORM_URL,
          space: "prod",
          name: "foreign-version",
          spec: {
            worker: { resourceUid: foreignWorker.resourceUid },
            bundle: { resourceUid: bundle.resourceUid },
            handlers: ["fetch"],
          },
        },
      }),
    ).rejects.toThrow();

    await sql.run(
      "DELETE FROM tf_v2_resource_references WHERE target_uid = ? AND referrer_uid = ?",
      [bundle.resourceUid, version.resourceUid],
    );
    await expect(current.readVersionMaterials(version.resourceUid)).rejects.toThrow();
    await sql.run(
      "INSERT INTO tf_v2_resource_references (target_uid, referrer_uid) VALUES (?, ?)",
      [bundle.resourceUid, version.resourceUid],
    );
    await sql.run("UPDATE tf_v2_resources SET busy_operation = ? WHERE uid = ?", [
      "busy-version-update",
      version.resourceUid,
    ]);
    await expect(current.readVersionMaterials(version.resourceUid)).rejects.toThrow();
    await sql.run("UPDATE tf_v2_resources SET busy_operation = NULL WHERE uid = ?", [
      version.resourceUid,
    ]);
    const beforeExpiry = nowMs;
    let callbackCount = 0;
    const expiryReader = createV2WorkerPublicationState({
      sql,
      now: () => new Date(nowMs),
      bundleCustody: {
        async readHeldVerified(input) {
          return bundleHost.custody.readHeldVerified({
            ...input,
            stillAuthorized: async () => {
              const authorized = await input.stillAuthorized();
              if (++callbackCount === 1) nowMs += 60_001;
              return authorized;
            },
          });
        },
      },
      assetCustody: assetHost.custody,
    });
    const expiry = await expiryReader.resolve({ execution });
    expect(expiry.kind).toBe("ready");
    if (expiry.kind === "ready") {
      await expect(expiry.readVersionMaterials(version.resourceUid)).rejects.toThrow();
      expect(callbackCount).toBeGreaterThanOrEqual(2);
    }
    nowMs = beforeExpiry;

    const settledAt = new Date(nowMs).toISOString();
    expect(
      await store.settle({
        id: deployment.id,
        token,
        status: "succeeded",
        effect: "complete",
        at: settledAt,
        retainUntil: new Date(nowMs + 3_600_000).toISOString(),
        observedJson: JSON.stringify({ ready: true, active: true }),
        outputJson: "{}",
      }),
    ).toBe(true);
    const endpointSpec = { worker: { resourceUid: worker.resourceUid } };
    const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", endpointSpec, false);
    const makeExecution = async (id: string, lease: string): Promise<V2Execution> => {
      const nextOp = await store.operation(id);
      const nextResource = nextOp && (await store.resource(nextOp.resource_uid));
      if (!nextOp || !nextResource) throw new Error("missing accepted operation");
      expect(await store.claim(id, lease, nowMs, nowMs + 60_000)).toBe(true);
      expect(await store.markDispatch(id, lease, new Date(nowMs).toISOString())).toBe(true);
      return {
        operationId: id,
        leaseToken: lease,
        backendKey: nextOp.backend_key,
        backendId: nextOp.backend_id,
        targetKey: nextOp.target_key,
        resourceUid: nextResource.uid,
        principal: nextOp.principal,
        action: nextOp.action,
        generation: nextOp.generation,
        form: nextResource.form_url,
        space: nextResource.space,
        name: nextResource.name,
        spec: JSON.parse(nextOp.accepted_spec_json),
        previousObserved: JSON.parse(nextResource.observed_json),
        previousOutput: JSON.parse(nextResource.output_json),
      };
    };
    const endpointCreateExecution = await makeExecution(endpoint.id, "held-endpoint-create-lease");
    const endpointCreated = await reader.resolve({ execution: endpointCreateExecution });
    expect(endpointCreated.kind).toBe("ready");
    if (endpointCreated.kind === "ready") {
      expect(endpointCreated.snapshot.endpoint?.output.hostname).toBe("held.example.test");
      await expect(
        endpointCreated.readVersionMaterials(version.resourceUid),
      ).resolves.toMatchObject({
        bundle: { manifest: { entrypoint: "index.js" } },
        assets: { manifest: { files: [{ path: "index.html" }] } },
      });
    }
    expect(
      await store.settle({
        id: endpoint.id,
        token: endpointCreateExecution.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: new Date(nowMs).toISOString(),
        retainUntil: new Date(nowMs + 3_600_000).toISOString(),
        observedJson: JSON.stringify({ tlsReady: true, activeDeploymentRouteReady: true }),
        outputJson: JSON.stringify(endpointCreateExecution.previousOutput),
      }),
    ).toBe(true);
    for (const action of ["update", "delete"] as const) {
      const accepted =
        action === "update"
          ? await engine.acceptUpdate({
              principal: "org-1",
              key: "held-endpoint-update",
              uid: endpoint.resourceUid,
              expectedGeneration: 1,
              spec: endpointSpec,
            })
          : await engine.acceptDelete({
              principal: "org-1",
              key: "held-endpoint-delete",
              uid: endpoint.resourceUid,
              expectedGeneration: 2,
            });
      const endpointExecution = await makeExecution(accepted.id, `held-endpoint-${action}-lease`);
      const endpointRead = await reader.resolve({ execution: endpointExecution });
      expect(endpointRead.kind).toBe("ready");
      if (endpointRead.kind === "ready") {
        expect(endpointRead.snapshot.deployment?.uid).toBe(deployment.resourceUid);
        expect(endpointRead.snapshot.endpoint === null).toBe(action === "delete");
        await expect(endpointRead.readVersionMaterials(version.resourceUid)).resolves.toMatchObject(
          {
            bundle: { manifest: { entrypoint: "index.js" } },
          },
        );
        if (action === "delete") {
          await sql.run("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ?", [
            bundle.resourceUid,
          ]);
          await expect(endpointRead.readVersionMaterials(version.resourceUid)).rejects.toThrow();
        }
      }
      expect(
        await store.settle({
          id: accepted.id,
          token: endpointExecution.leaseToken,
          status: "succeeded",
          effect: "complete",
          at: new Date(nowMs).toISOString(),
          retainUntil: new Date(nowMs + 3_600_000).toISOString(),
          observedJson: JSON.stringify({ tlsReady: true, activeDeploymentRouteReady: true }),
          outputJson: JSON.stringify(endpointExecution.previousOutput),
        }),
      ).toBe(true);
    }
    const deleteDeployment = await engine.acceptDelete({
      principal: "org-1",
      key: "held-deployment-delete",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
    });
    const deleteExecution = await makeExecution(
      deleteDeployment.id,
      "held-deployment-delete-lease",
    );
    const deleting = await reader.resolve({ execution: deleteExecution });
    expect(deleting.kind).toBe("ready");
    if (deleting.kind === "ready") {
      expect(deleting.snapshot.deployment).toBeNull();
      await expect(deleting.readVersionMaterials(version.resourceUid)).rejects.toThrow();
    }
    expect(sourceReads).toBe(priorSourceReads);
  } finally {
    reopened?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
