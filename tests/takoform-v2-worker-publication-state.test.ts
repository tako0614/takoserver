import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import {
  createWorkerBundleHost,
  WORKER_BUNDLE_BACKEND_ID,
} from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import { referencesForWorkerForm } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Backend, V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const BUNDLE_FORM_URL = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";
const ACCEPTANCE_ORDER_MIGRATION = "0077_v2_operation_acceptance_order.sql";
const historicalMigrationCount = MIGRATIONS.findIndex(
  (migration) => migration.name === ACCEPTANCE_ORDER_MIGRATION,
);
if (historicalMigrationCount < 0) throw new Error("missing acceptance-order migration");

// Current acceptance code expects columns added after 0077. Use the 0076 SQL
// claims, reference guards, terminal projection and real Bundle byte custody.
async function insertHistoricalResource(
  db: Database,
  store: ReturnType<typeof createV2Store>,
  input: {
    form: string;
    name: string;
    spec: JsonObject;
    observed?: JsonObject;
    output?: JsonObject;
    backendId?: string;
    materialize?: V2Backend["execute"];
  },
) {
  const resourceUid = crypto.randomUUID();
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const output = input.output ?? {};
  const backendId = input.backendId ?? "fixture-worker-publication-v1";
  db.query(
    `INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key,
       active_name, generation, phase, spec_json, output_json, last_operation, busy_operation)
     VALUES (?, 'org-1', ?, 'prod', ?, ?,
             'fixture-workerd-root', ?, 1, 'pending', ?, ?, ?, ?)`,
  ).run(
    resourceUid,
    input.form,
    input.name,
    backendId,
    input.name,
    canonicalJson(input.spec),
    JSON.stringify(output),
    id,
    id,
  );
  db.query(
    `INSERT INTO tf_v2_operations
      (id, resource_uid, principal, replay_key, request_fingerprint, action, generation,
       status, effect, created_at, updated_at, retain_until, backend_id, target_key,
       backend_key, accepted_spec_json)
     VALUES (?, ?, 'org-1', ?, ?, 'create', 1, 'queued', 'none', ?, ?, ?,
             ?, 'fixture-workerd-root', ?, ?)`,
  ).run(
    id,
    resourceUid,
    `historical-${input.name}`,
    `historical-${id}`,
    at,
    at,
    new Date(Date.now() + 3_600_000).toISOString(),
    backendId,
    `historical-${id}`,
    canonicalJson(input.spec),
  );
  const references =
    input.form === BUNDLE_FORM_URL ? [] : referencesForWorkerForm(input.form, input.spec);
  if (references.length > 0) {
    db.query("INSERT INTO tf_v2_operation_reference_sets (operation_id) VALUES (?)").run(id);
    for (const reference of references) {
      db.query(
        `INSERT INTO tf_v2_operation_references
          (operation_id, target_uid, form_url, readiness, target_spec_path, target_spec_equals)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        reference.resourceUid,
        reference.formUrl,
        reference.readiness,
        reference.targetSpecMatch ? `$.${reference.targetSpecMatch.path.join(".")}` : null,
        reference.targetSpecMatch?.equals ?? null,
      );
    }
    db.query("UPDATE tf_v2_operation_reference_sets SET sealed = 1 WHERE operation_id = ?").run(id);
  }
  const token = `historical-lease-${id}`;
  expect(await store.claim(id, token, Date.now(), Date.now() + 60_000)).toBe(true);
  expect(await store.markDispatch(id, token, at)).toBe(true);
  const result = input.materialize
    ? await input.materialize({
        operationId: id,
        leaseToken: token,
        backendKey: `historical-${id}`,
        backendId,
        targetKey: "fixture-workerd-root",
        resourceUid,
        principal: "org-1",
        action: "create",
        generation: 1,
        form: input.form,
        space: "prod",
        name: input.name,
        spec: input.spec,
        previousObserved: {},
        previousOutput: output,
      })
    : { kind: "complete" as const, observed: input.observed ?? {}, output };
  if (result.kind !== "complete") throw new Error("historical fixture did not settle");
  expect(
    await store.settle({
      id,
      token,
      status: "succeeded",
      effect: "complete",
      at,
      retainUntil: new Date(Date.now() + 3_600_000).toISOString(),
      observedJson: canonicalJson(result.observed),
      outputJson: canonicalJson(result.output),
    }),
  ).toBe(true);
  return { id, resourceUid };
}

// The Version backend below is a graph-only substitute, not ABI qualification;
// its Bundle dependency uses real verified SQL byte custody.
function fixture(distinctFormBackends = false, legacySchema = false) {
  const root = mkdtempSync(join(tmpdir(), "v2-publication-"));
  const path = join(root, "state.sqlite");
  const db = new Database(path);
  if (legacySchema) {
    db.exec(`CREATE TABLE applied_migrations (
      name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL
    )`);
    // A real pre-0077 database has only the prefix. Later migrations depend on
    // 0077/0078 and must run through the normal migrator after the old row exists.
    for (const migration of MIGRATIONS.slice(0, historicalMigrationCount)) {
      db.exec(migration.sql);
      db.query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, datetime('now'))").run(
        migration.name,
      );
    }
  } else {
    migrateSqlite(db);
  }
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
  const form = (role: string, extra: Partial<V2Form> = {}): V2Form => ({
    validateCreate() {},
    validateUpdate() {},
    backend: distinctFormBackends
      ? { ...backend, id: `fixture-${role}-backend`, targetKey: `fixture-${role}-target` }
      : backend,
    ...extra,
  });
  const forms = {
    [MODULE_WORKER_FORM_URL]: form("module"),
    [BUNDLE_FORM_URL]: bundleHost.form,
    [WORKER_VERSION_FORM_URL]: form("version", {
      references(spec) {
        const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
        const bundleUid = (spec.bundle as { resourceUid: string }).resourceUid;
        return [
          { resourceUid: workerUid, formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
          { resourceUid: bundleUid, formUrl: BUNDLE_FORM_URL, readiness: "observed" },
        ];
      },
    }),
    [WORKER_DEPLOYMENT_FORM_URL]: form("deployment", {
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
    [WORKER_ENDPOINT_FORM_URL]: form("endpoint", {
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
    historicalBundle: {
      spec: { artifact: { url: manifestUrl, sha256: digest(manifestBytes) } },
      materialize: bundleHost.custody.execute,
      custody: bundleHost.custody,
    },
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
      {
        uid: version.resourceUid,
        weight: 10_000,
        spec: { handlers: ["fetch"] },
        sourceOperationId: version.id,
      },
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

test("a fresh SQL handle reconstructs a terminal current serving graph without a live lease", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const reopenedDb = new Database(f.path);
    try {
      const reader = createV2WorkerPublicationState({
        sql: createSqliteSql(reopenedDb),
        bundleCustody: createWorkerBundleHost({
          sql: createSqliteSql(reopenedDb),
          targetKey: "fixture-workerd-root",
          source: {
            async read() {
              throw new Error("source is offline after restart");
            },
          },
        }).custody,
      });
      const identity = {
        generation: `takoserver-v2-operation:${deployment.id}`,
        workerResourceUid: worker.resourceUid,
        hostnames: [],
        versions: [{ workerVersionUid: version.resourceUid, weight: 10_000 }],
      };
      const result = await reader.resolveCurrentServing({
        workerUid: worker.resourceUid,
        targetKey: "fixture-workerd-root",
        sourceOperationId: deployment.id,
        expectedIdentity: identity,
      });
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") return;
      expect(result.snapshot.sourceOperationId).toBe(deployment.id);
      expect(result.snapshot.deployment?.versions).toMatchObject([
        { uid: version.resourceUid, weight: 10_000 },
      ]);
      expect(await result.stillCurrent()).toBe(true);
      expect((await result.readVersionMaterials(version.resourceUid)).bundle?.files.length).toBe(1);
      const mutableIdentity = {
        ...identity,
        versions: [{ workerVersionUid: version.resourceUid, weight: 10_000 }],
      };
      const inFlight = reader.resolveCurrentServing({
        workerUid: worker.resourceUid,
        targetKey: "fixture-workerd-root",
        sourceOperationId: deployment.id,
        expectedIdentity: mutableIdentity,
      });
      const mutableVersion = mutableIdentity.versions[0];
      if (!mutableVersion) throw new Error("missing selected Version fixture");
      mutableVersion.weight = 1;
      expect((await inFlight).kind).toBe("ready");
      expect(
        await reader.resolveCurrentServing({
          workerUid: worker.resourceUid,
          targetKey: "foreign-target",
          sourceOperationId: deployment.id,
          expectedIdentity: identity,
        }),
      ).toMatchObject({ kind: "unresolved" });
      expect(
        await reader.resolveCurrentServing({
          workerUid: worker.resourceUid,
          targetKey: "fixture-workerd-root",
          sourceOperationId: deployment.id,
          expectedIdentity: { ...identity, versions: [] },
        }),
      ).toMatchObject({ kind: "unresolved" });
      await f.sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
        JSON.stringify({ ready: false, resolvedBindings: false, bundleVerified: false }),
        version.resourceUid,
      ]);
      expect(await result.stillCurrent()).toBe(false);
    } finally {
      reopenedDb.close();
    }
  } finally {
    f.close();
  }
});

test("a historical source without acceptance order is unresolved after additive migration", async () => {
  const f = fixture(false, true);
  try {
    const worker = await insertHistoricalResource(f.db, f.store, {
      form: MODULE_WORKER_FORM_URL,
      name: "worker",
      spec: {},
      observed: { activeDeploymentUid: null, ready: false },
    });
    expect(await f.store.resource(worker.resourceUid)).toMatchObject({
      observed_json: canonicalJson({ activeDeploymentUid: null, ready: false }),
    });
    const bundle = await insertHistoricalResource(f.db, f.store, {
      form: BUNDLE_FORM_URL,
      name: "bundle",
      spec: f.historicalBundle.spec,
      backendId: WORKER_BUNDLE_BACKEND_ID,
      materialize: f.historicalBundle.materialize,
    });
    const version = await insertHistoricalResource(f.db, f.store, {
      form: WORKER_VERSION_FORM_URL,
      name: "version",
      spec: {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
      },
      observed: { ready: true, resolvedBindings: true, bundleVerified: true },
    });
    const deployment = await insertHistoricalResource(f.db, f.store, {
      form: WORKER_DEPLOYMENT_FORM_URL,
      name: "deployment",
      spec: {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      observed: {
        ready: true,
        active: true,
        selectedVersions: [{ resourceUid: version.resourceUid, weight: 10_000 }],
      },
    });
    f.db
      .query("UPDATE tf_v2_resources SET observed_json = ?, observed_at = ? WHERE uid = ?")
      .run(
        canonicalJson({ activeDeploymentUid: deployment.resourceUid, ready: true }),
        new Date().toISOString(),
        worker.resourceUid,
      );
    const endpointSpec = { worker: { resourceUid: worker.resourceUid } };
    const endpoint = await insertHistoricalResource(f.db, f.store, {
      form: WORKER_ENDPOINT_FORM_URL,
      name: "endpoint",
      spec: endpointSpec,
      observed: { tlsReady: true, activeDeploymentRouteReady: true },
      output: { hostname: "assigned.example.test", url: "https://assigned.example.test/" },
    });
    expect(
      f.db
        .query(
          `SELECT deployment.uid FROM tf_v2_resources worker
           JOIN tf_v2_resources deployment
             ON deployment.uid = json_extract(worker.observed_json, '$.activeDeploymentUid')
           JOIN tf_v2_resources version
             ON version.uid = json_extract(deployment.spec_json,
               '$.versions[0].workerVersion.resourceUid')
           JOIN tf_v2_resources bundle
             ON bundle.uid = json_extract(version.spec_json, '$.bundle.resourceUid')
           JOIN tf_v2_artifact_owners held ON held.resource_uid = bundle.uid
           WHERE worker.uid = ? AND json_extract(worker.observed_json, '$.ready') = 1
             AND deployment.form_url = ? AND deployment.phase = 'idle'
             AND json_extract(deployment.observed_json, '$.active') = 1
             AND json_extract(deployment.spec_json, '$.versions[0].weight') = 10000
             AND version.form_url = ? AND json_extract(version.observed_json, '$.ready') = 1
             AND json_extract(version.observed_json, '$.bundleVerified') = 1
             AND bundle.form_url = ? AND held.state = 'verified'
             AND held.observation_json = bundle.observed_json`,
        )
        .all(
          worker.resourceUid,
          WORKER_DEPLOYMENT_FORM_URL,
          WORKER_VERSION_FORM_URL,
          BUNDLE_FORM_URL,
        ),
    ).toHaveLength(1);
    expect(migrateSqlite(f.db).applied).toEqual(
      MIGRATIONS.slice(historicalMigrationCount).map((migration) => migration.name),
    );
    expect(
      await f.sql.query("SELECT acceptance_order FROM tf_v2_operations WHERE id = ?", [
        endpoint.id,
      ]),
    ).toEqual([{ acceptance_order: null }]);
    const oldInput = {
      workerUid: worker.resourceUid,
      targetKey: "fixture-workerd-root",
      sourceOperationId: endpoint.id,
      expectedIdentity: {
        generation: `takoserver-v2-operation:${endpoint.id}`,
        workerResourceUid: worker.resourceUid,
        hostnames: ["assigned.example.test"],
        versions: [{ workerVersionUid: version.resourceUid, weight: 10_000 }],
      },
    };
    expect(await f.reader.resolveCurrentServing(oldInput)).toMatchObject({
      kind: "unresolved",
      code: "graph_unresolved",
      message: "Serving source is not the unique latest publisher",
    });
    const current = await f.engine.acceptUpdate({
      principal: "org-1",
      key: "update-historical-endpoint-key",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
      spec: endpointSpec,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: current.id, status: "succeeded" });
    expect(
      await f.sql.query("SELECT acceptance_order FROM tf_v2_operations WHERE id = ?", [current.id]),
    ).toEqual([{ acceptance_order: expect.any(Number) }]);
    const bundleRow = await f.store.resource(bundle.resourceUid);
    if (!bundleRow) throw new Error("historical Bundle disappeared");
    expect(
      (
        await f.historicalBundle.custody.readHeldVerified({
          targetResourceUid: bundle.resourceUid,
          principal: "org-1",
          space: "prod",
          expectedSpec: f.historicalBundle.spec,
          expectedObserved: JSON.parse(bundleRow.observed_json),
          stillAuthorized: async () => true,
        })
      ).files,
    ).toHaveLength(1);
    expect(
      await f.reader.resolveCurrentServing({
        ...oldInput,
        sourceOperationId: current.id,
        expectedIdentity: {
          ...oldInput.expectedIdentity,
          generation: `takoserver-v2-operation:${current.id}`,
        },
      }),
    ).toMatchObject({ kind: "ready" });
  } finally {
    f.close();
  }
});

test("current serving limits pending and attachment reads before refusing crowded graphs", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const rowsRead = { pending: [] as number[], attachments: [] as number[] };
    const reader = createV2WorkerPublicationState({
      sql: {
        ...f.sql,
        async query(...args: Parameters<typeof f.sql.query>) {
          const rows = await f.sql.query(...args);
          if (args[0].includes("SELECT 1 FROM tf_v2_operations op"))
            rowsRead.pending.push(rows.length);
          if (args[0].includes("SELECT * FROM tf_v2_resources") && args[0].includes("LIMIT 2"))
            rowsRead.attachments.push(rows.length);
          return rows;
        },
      },
    });
    const input = {
      workerUid: worker.resourceUid,
      targetKey: "fixture-workerd-root",
      sourceOperationId: deployment.id,
      expectedIdentity: {
        generation: `takoserver-v2-operation:${deployment.id}`,
        workerResourceUid: worker.resourceUid,
        hostnames: [],
        versions: [{ workerVersionUid: version.resourceUid, weight: 10_000 }],
      },
    };
    for (let index = 0; index < 12; index++) {
      await f.create(
        WORKER_ENDPOINT_FORM_URL,
        `queued-endpoint-${index}`,
        { worker: { resourceUid: worker.resourceUid } },
        false,
      );
    }
    expect(await reader.resolveCurrentServing(input)).toMatchObject({
      kind: "unresolved",
      code: "source_unsettled",
    });
    expect(rowsRead.pending).toEqual([1]);
    for (let index = 0; index < 12; index++) {
      expect(await f.engine.runNext()).toMatchObject({ status: "succeeded" });
    }
    expect(await reader.resolveCurrentServing(input)).toMatchObject({
      kind: "unresolved",
      code: "publication_conflict",
    });
    expect(rowsRead.attachments.length).toBeGreaterThan(0);
    expect(Math.max(...rowsRead.attachments)).toBe(2);
  } finally {
    f.close();
  }
});

test("current serving follows the latest Endpoint marker across distinct Form backends and its DELETE tombstone", async () => {
  const f = fixture(true);
  try {
    const { worker, version } = await f.basics();
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const deploymentOp = await f.store.operation(deployment.id);
    expect(deploymentOp).not.toBeNull();
    const deploymentIdentity = {
      generation: `takoserver-v2-operation:${deployment.id}`,
      workerResourceUid: worker.resourceUid,
      hostnames: [],
      versions: [{ workerVersionUid: version.resourceUid, weight: 10_000 }],
    };
    const deploymentInput = {
      workerUid: worker.resourceUid,
      targetKey: deploymentOp?.target_key ?? "",
      sourceOperationId: deployment.id,
      expectedIdentity: deploymentIdentity,
    };
    const first = await f.reader.resolveCurrentServing(deploymentInput);
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") return;

    const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
      worker: { resourceUid: worker.resourceUid },
    });
    const endpointOp = await f.store.operation(endpoint.id);
    expect(endpointOp?.target_key).not.toBe(deploymentOp?.target_key);
    const endpointIdentity = {
      ...deploymentIdentity,
      generation: `takoserver-v2-operation:${endpoint.id}`,
      hostnames: ["assigned.example.test"],
    };
    const endpointInput = {
      workerUid: worker.resourceUid,
      targetKey: endpointOp?.target_key ?? "",
      sourceOperationId: endpoint.id,
      expectedIdentity: endpointIdentity,
    };
    expect(await first.stillCurrent()).toBe(false);
    expect(await f.reader.resolveCurrentServing(deploymentInput)).toMatchObject({
      kind: "unresolved",
    });
    const servingEndpoint = await f.reader.resolveCurrentServing(endpointInput);
    expect(servingEndpoint.kind).toBe("ready");
    if (servingEndpoint.kind !== "ready") return;
    expect(servingEndpoint.snapshot.endpoint?.output.hostname).toBe("assigned.example.test");

    const deleted = await f.engine.acceptDelete({
      principal: "org-1",
      key: "delete-endpoint-current-serving-key",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
    });
    expect(
      await f.reader.resolveCurrentServing({
        ...endpointInput,
        sourceOperationId: deleted.id,
        expectedIdentity: {
          ...endpointIdentity,
          generation: `takoserver-v2-operation:${deleted.id}`,
          hostnames: [],
        },
      }),
    ).toMatchObject({ kind: "unresolved", code: "source_unsettled" });
    expect(await f.engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
    const afterDelete = await f.reader.resolveCurrentServing({
      ...endpointInput,
      sourceOperationId: deleted.id,
      expectedIdentity: {
        ...endpointIdentity,
        generation: `takoserver-v2-operation:${deleted.id}`,
        hostnames: [],
      },
    });
    expect(afterDelete.kind).toBe("ready");
    if (afterDelete.kind !== "ready") return;
    expect(afterDelete.snapshot.endpoint).toBeNull();
    expect(afterDelete.snapshot.acceptedEndpointOutput?.hostname).toBe("assigned.example.test");
    expect(afterDelete.snapshot.deployment?.uid).toBe(deployment.resourceUid);
    expect(await afterDelete.stillCurrent()).toBe(true);
    expect((await afterDelete.readVersionMaterials(version.resourceUid)).bundle?.files.length).toBe(
      1,
    );
  } finally {
    f.close();
  }
});

test("current serving compares the complete weighted Version set independent of order", async () => {
  const f = fixture();
  try {
    const { worker, bundle, version } = await f.basics();
    const second = await f.create(WORKER_VERSION_FORM_URL, "second-version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    });
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [
        { workerVersion: { resourceUid: second.resourceUid }, weight: 4_000 },
        { workerVersion: { resourceUid: version.resourceUid }, weight: 6_000 },
      ],
    });
    const base = {
      workerUid: worker.resourceUid,
      targetKey: "fixture-workerd-root",
      sourceOperationId: deployment.id,
      expectedIdentity: {
        generation: `takoserver-v2-operation:${deployment.id}`,
        workerResourceUid: worker.resourceUid,
        hostnames: [],
        versions: [
          { workerVersionUid: version.resourceUid, weight: 6_000 },
          { workerVersionUid: second.resourceUid, weight: 4_000 },
        ],
      },
    };
    const ready = await f.reader.resolveCurrentServing(base);
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") return;
    const selectedVersion = base.expectedIdentity.versions[0];
    if (!selectedVersion) throw new Error("missing selected Version fixture");
    expect(
      await f.reader.resolveCurrentServing({
        ...base,
        expectedIdentity: {
          ...base.expectedIdentity,
          versions: base.expectedIdentity.versions.slice(0, 1),
        },
      }),
    ).toMatchObject({ kind: "unresolved" });
    expect(
      await f.reader.resolveCurrentServing({
        ...base,
        expectedIdentity: {
          ...base.expectedIdentity,
          versions: [selectedVersion, selectedVersion],
        },
      }),
    ).toMatchObject({ kind: "unresolved" });
    await f.sql.run(
      "DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?",
      [second.resourceUid, bundle.resourceUid],
    );
    expect(await ready.stillCurrent()).toBe(false);
    expect(await f.reader.resolveCurrentServing(base)).toMatchObject({ kind: "unresolved" });
  } finally {
    f.close();
  }
});

test("current serving does not revive an older Deployment marker after a clock-rollback Endpoint DELETE", async () => {
  const f = fixture();
  try {
    const { worker, version } = await f.basics();
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const deploymentOp = await f.store.operation(deployment.id);
    if (!deploymentOp) throw new Error("missing Deployment operation fixture");
    const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
      worker: { resourceUid: worker.resourceUid },
    });
    f.setClock(Date.parse(deploymentOp.created_at) - 1_000);
    const deleted = await f.engine.acceptDelete({
      principal: "org-1",
      key: "clock-rollback-delete-endpoint-key",
      uid: endpoint.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
    const deletedOp = await f.store.operation(deleted.id);
    if (!deletedOp) throw new Error("missing Endpoint delete operation fixture");
    expect(deletedOp.created_at < deploymentOp.created_at).toBe(true);
    const identity = {
      workerResourceUid: worker.resourceUid,
      hostnames: [],
      versions: [{ workerVersionUid: version.resourceUid, weight: 10_000 }],
    };
    expect(
      await f.reader.resolveCurrentServing({
        workerUid: worker.resourceUid,
        targetKey: "fixture-workerd-root",
        sourceOperationId: deployment.id,
        expectedIdentity: {
          ...identity,
          generation: `takoserver-v2-operation:${deployment.id}`,
        },
      }),
    ).toMatchObject({ kind: "unresolved" });
    expect(
      await f.reader.resolveCurrentServing({
        workerUid: worker.resourceUid,
        targetKey: "fixture-workerd-root",
        sourceOperationId: deleted.id,
        expectedIdentity: { ...identity, generation: `takoserver-v2-operation:${deleted.id}` },
      }),
    ).toMatchObject({ kind: "ready" });
    f.db.exec("VACUUM");
    const reopened = new Database(f.path);
    try {
      const reopenedSql = createSqliteSql(reopened);
      const reader = createV2WorkerPublicationState({
        sql: reopenedSql,
        bundleCustody: createWorkerBundleHost({
          sql: reopenedSql,
          targetKey: "fixture-workerd-root",
          source: {
            async read() {
              throw new Error("source is offline after restart");
            },
          },
        }).custody,
      });
      expect(
        await reader.resolveCurrentServing({
          workerUid: worker.resourceUid,
          targetKey: "fixture-workerd-root",
          sourceOperationId: deployment.id,
          expectedIdentity: {
            ...identity,
            generation: `takoserver-v2-operation:${deployment.id}`,
          },
        }),
      ).toMatchObject({ kind: "unresolved" });
      expect(
        await reader.resolveCurrentServing({
          workerUid: worker.resourceUid,
          targetKey: "fixture-workerd-root",
          sourceOperationId: deleted.id,
          expectedIdentity: { ...identity, generation: `takoserver-v2-operation:${deleted.id}` },
        }),
      ).toMatchObject({ kind: "ready" });
    } finally {
      reopened.close();
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
    const bounded = await current.openVersionMaterialsUnverified?.(version.resourceUid);
    expect(bounded?.bundle?.manifest.entrypoint).toBe("index.js");
    expect(bounded?.assets?.manifest.files[0]?.path).toBe("index.html");
    expect((await bounded?.bundle?.readPage({ fileIndex: 0, nextChunk: 0 }))?.chunks[0]).toEqual(
      moduleBytes,
    );
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
      const reopenedScope = await afterRestart.openVersionMaterialsUnverified?.(
        version.resourceUid,
      );
      expect(
        (await reopenedScope?.bundle?.readPage({ fileIndex: 0, nextChunk: 0 }))?.chunks[0],
      ).toEqual(moduleBytes);
    }
    expect(sourceReads).toBe(priorSourceReads);
    await expect(current.readVersionMaterials("wrong-selected-version")).rejects.toThrow();
    await expect(
      current.openVersionMaterialsUnverified?.("wrong-selected-version"),
    ).rejects.toThrow();
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

// Boot recovery adopts the committed incarnation while a later Operation is
// only queued. Every other caller keeps the strict fence, and a claimed or
// dispatched Operation (which may have changed native state) still refuses.
type RecoveryScenario = {
  readonly name: string;
  readonly endpoint: boolean;
  readonly source: "deployment" | "endpoint";
  readonly change: "deployment-update" | "endpoint-update" | "endpoint-delete" | "endpoint-create";
};
const recoveryScenarios: readonly RecoveryScenario[] = [
  { name: "Endpoint update", endpoint: true, source: "endpoint", change: "endpoint-update" },
  { name: "Endpoint delete", endpoint: true, source: "endpoint", change: "endpoint-delete" },
  {
    name: "Deployment update behind a later Endpoint source",
    endpoint: true,
    source: "endpoint",
    change: "deployment-update",
  },
  {
    name: "Deployment update of the source",
    endpoint: false,
    source: "deployment",
    change: "deployment-update",
  },
  {
    name: "first Endpoint create over a Deployment source",
    endpoint: false,
    source: "deployment",
    change: "endpoint-create",
  },
];

async function recoveryGraph(f: ReturnType<typeof fixture>, scenario: RecoveryScenario) {
  const { worker, version } = await f.basics();
  const deploymentSpec = {
    worker: { resourceUid: worker.resourceUid },
    versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
  };
  const endpointSpec = { worker: { resourceUid: worker.resourceUid } };
  const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", deploymentSpec);
  const endpoint = scenario.endpoint
    ? await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", endpointSpec)
    : null;
  let pendingId: string;
  switch (scenario.change) {
    case "deployment-update":
      pendingId = (
        await f.engine.acceptUpdate({
          principal: "org-1",
          key: "recovery-deployment-update-0001",
          uid: deployment.resourceUid,
          expectedGeneration: 1,
          spec: deploymentSpec,
        })
      ).id;
      break;
    case "endpoint-update":
      pendingId = (
        await f.engine.acceptUpdate({
          principal: "org-1",
          key: "recovery-endpoint-update-00001",
          uid: endpoint?.resourceUid ?? "",
          expectedGeneration: 1,
          spec: endpointSpec,
        })
      ).id;
      break;
    case "endpoint-delete":
      pendingId = (
        await f.engine.acceptDelete({
          principal: "org-1",
          key: "recovery-endpoint-delete-00001",
          uid: endpoint?.resourceUid ?? "",
          expectedGeneration: 1,
        })
      ).id;
      break;
    case "endpoint-create":
      pendingId = (await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", endpointSpec, false)).id;
      break;
  }
  const sourceId = scenario.source === "endpoint" ? (endpoint?.id ?? "") : deployment.id;
  const input = {
    workerUid: worker.resourceUid,
    targetKey: "fixture-workerd-root",
    sourceOperationId: sourceId,
    expectedIdentity: {
      generation: `takoserver-v2-operation:${sourceId}`,
      workerResourceUid: worker.resourceUid,
      hostnames: scenario.source === "endpoint" ? ["assigned.example.test"] : [],
      versions: [{ workerVersionUid: version.resourceUid, weight: 10_000 }],
    },
  };
  return { worker, version, deployment, endpoint, pendingId, sourceId, input };
}

for (const scenario of recoveryScenarios) {
  test(`recovery adopts the committed serving graph while a queued ${scenario.name} waits`, async () => {
    const f = fixture();
    try {
      const graph = await recoveryGraph(f, scenario);
      // The default fence is unchanged: any pending publication refuses.
      expect(await f.reader.resolveCurrentServing(graph.input)).toMatchObject({
        kind: "unresolved",
      });
      expect(
        await f.reader.resolveCurrentServing({
          ...graph.input,
          tolerateUnstartedSuccessors: false,
        }),
      ).toMatchObject({ kind: "unresolved" });

      const ready = await f.reader.resolveCurrentServing({
        ...graph.input,
        tolerateUnstartedSuccessors: true,
      });
      expect(ready).toMatchObject({ kind: "ready" });
      if (ready.kind !== "ready") return;
      // The snapshot is the committed generation, never the queued spec.
      expect(ready.snapshot.sourceOperationId).toBe(graph.sourceId);
      expect(ready.snapshot.deployment?.generation).toBe(
        scenario.change === "deployment-update" ? 1 : 1,
      );
      expect(ready.snapshot.deployment?.versions).toMatchObject([
        { uid: graph.version.resourceUid, weight: 10_000 },
      ]);
      expect(ready.snapshot.endpoint?.generation).toBe(
        scenario.source === "endpoint" ? 1 : undefined,
      );
      expect(await ready.stillCurrent()).toBe(true);
      expect(
        (await ready.readVersionMaterials(graph.version.resourceUid)).bundle?.files.length,
      ).toBe(1);

      // A claim that has not recorded a dispatch cannot have a backend effect,
      // but it does change the fenced rows: the earlier proof must not survive.
      const token = `claimed-${graph.pendingId}`;
      expect(
        await f.store.claim(graph.pendingId, token, f.currentClock(), f.currentClock() + 60_000),
      ).toBe(true);
      expect(await ready.stillCurrent()).toBe(false);
      const claimedOnly = await f.reader.resolveCurrentServing({
        ...graph.input,
        tolerateUnstartedSuccessors: true,
      });
      expect(claimedOnly.kind).toBe("ready");
      if (claimedOnly.kind !== "ready") return;
      expect(await claimedOnly.stillCurrent()).toBe(true);

      // Once a dispatch is recorded the effect is unknown: refuse, and the
      // proof taken just before it must stop being current.
      expect(
        await f.store.markDispatch(
          graph.pendingId,
          token,
          new Date(f.currentClock()).toISOString(),
        ),
      ).toBe(true);
      expect(await claimedOnly.stillCurrent()).toBe(false);
      expect(
        await f.reader.resolveCurrentServing({
          ...graph.input,
          tolerateUnstartedSuccessors: true,
        }),
      ).toMatchObject({ kind: "unresolved" });
    } finally {
      f.close();
    }
  });
}

test("recovery tolerance requires the queued Operation to be the exact unstarted successor", async () => {
  const scenario = recoveryScenarios[0];
  if (!scenario) throw new Error("missing scenario");
  const f = fixture();
  try {
    const graph = await recoveryGraph(f, scenario);
    const tolerant = { ...graph.input, tolerateUnstartedSuccessors: true };
    expect((await f.reader.resolveCurrentServing(tolerant)).kind).toBe("ready");

    // The pending Operation is not a serving source, even if named as one.
    expect(
      await f.reader.resolveCurrentServing({
        ...tolerant,
        sourceOperationId: graph.pendingId,
        expectedIdentity: {
          ...tolerant.expectedIdentity,
          generation: `takoserver-v2-operation:${graph.pendingId}`,
        },
      }),
    ).toMatchObject({ kind: "unresolved" });
    // A different committed source is not the latest publisher.
    expect(
      await f.reader.resolveCurrentServing({
        ...tolerant,
        sourceOperationId: graph.deployment.id,
        expectedIdentity: {
          ...tolerant.expectedIdentity,
          generation: `takoserver-v2-operation:${graph.deployment.id}`,
          hostnames: [],
        },
      }),
    ).toMatchObject({ kind: "unresolved" });
    // A successor accepted two generations ahead is not the single queued one.
    f.db
      .query("UPDATE tf_v2_resources SET generation = generation + 1 WHERE uid = ?")
      .run(graph.endpoint?.resourceUid ?? "");
    expect(await f.reader.resolveCurrentServing(tolerant)).toMatchObject({ kind: "unresolved" });
  } finally {
    f.close();
  }
});

test("a queued successor that settles becomes the only current serving source", async () => {
  const scenario = recoveryScenarios[0];
  if (!scenario) throw new Error("missing scenario");
  const f = fixture();
  try {
    const graph = await recoveryGraph(f, scenario);
    const tolerant = { ...graph.input, tolerateUnstartedSuccessors: true };
    const before = await f.reader.resolveCurrentServing(tolerant);
    expect(before.kind).toBe("ready");
    expect(await f.engine.runNext()).toMatchObject({ id: graph.pendingId, status: "succeeded" });
    if (before.kind === "ready") expect(await before.stillCurrent()).toBe(false);
    // The old source is superseded in both modes; the new one is current.
    expect(await f.reader.resolveCurrentServing(graph.input)).toMatchObject({
      kind: "unresolved",
    });
    expect(await f.reader.resolveCurrentServing(tolerant)).toMatchObject({ kind: "unresolved" });
    const next = {
      ...graph.input,
      sourceOperationId: graph.pendingId,
      expectedIdentity: {
        ...graph.input.expectedIdentity,
        generation: `takoserver-v2-operation:${graph.pendingId}`,
      },
    };
    const after = await f.reader.resolveCurrentServing(next);
    expect(after.kind).toBe("ready");
    if (after.kind === "ready") expect(after.snapshot.endpoint?.generation).toBe(2);
  } finally {
    f.close();
  }
});
