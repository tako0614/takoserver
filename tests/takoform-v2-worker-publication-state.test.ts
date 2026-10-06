import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v2-publication-"));
  const path = join(root, "state.sqlite");
  const db = new Database(path);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let clockMs = Date.UTC(2026, 9, 6, 12);
  const now = () => new Date(clockMs++);
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
    [BUNDLE_FORM_URL]: form(),
    [WORKER_VERSION_FORM_URL]: form({
      references(spec) {
        const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
        const bundleUid = (spec.bundle as { resourceUid: string }).resourceUid;
        return [
          { resourceUid: workerUid, formUrl: MODULE_WORKER_FORM_URL, readiness: "observed" },
          { resourceUid: bundleUid, formUrl: BUNDLE_FORM_URL, readiness: "ready" },
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
  const reader = createV2WorkerPublicationState({ sql, now: () => new Date(clockMs) });

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
    const bundle = await create(BUNDLE_FORM_URL, "bundle", {});
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
    const resolved = await f.reader.resolve({ execution });
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") return;
    expect(resolved.snapshot.deployment?.versions).toMatchObject([
      { uid: version.resourceUid, weight: 10_000, spec: { handlers: ["fetch"] } },
    ]);
    expect(resolved.snapshot.endpoint).toBeNull();
    expect(Object.isFrozen(resolved.snapshot.deployment?.versions[0]?.spec)).toBe(true);
    expect(await resolved.stillCurrent()).toBe(true);

    const endpoint = await f.create(
      WORKER_ENDPOINT_FORM_URL,
      "endpoint",
      { worker: { resourceUid: worker.resourceUid } },
      false,
    );
    expect(await resolved.stillCurrent()).toBe(false);
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
