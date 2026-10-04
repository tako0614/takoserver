import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { createSelfhostWorkflowPrivateOwner } from "../src/selfhost-workflow-private-owner.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { WorkflowRuntimeError } from "../src/workflow-driver.ts";

const NOW = Date.UTC(2026, 9, 4);
const TENANT = "tenant-workflow";
const selectedForm = (() => {
  const form = forwardTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "DurableWorkflow",
  );
  if (!form) throw new Error("unpublished Workflow candidate is unavailable");
  return form;
})();
const selectedWorker = (() => {
  const form = forwardTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  if (!form) throw new Error("unpublished ModuleWorker candidate is unavailable");
  return form;
})();
const selectedVersion = (() => {
  const form = forwardTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "WorkerVersion",
  );
  if (!form) throw new Error("unpublished WorkerVersion candidate is unavailable");
  return form;
})();

const databases: Database[] = [];
const runtimeRoots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of runtimeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function insertLiveResource(
  sql: Sql,
  form: InstalledTakoformForm,
  uid: string,
  name: string,
  spec: Record<string, unknown>,
  relations: readonly Record<string, unknown>[] = [],
  tenantId = TENANT,
): Promise<void> {
  const resource = {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: form.identity,
    metadata: { space: "default", name, uid, generation: "1", revision: "1" },
    spec,
    status: { observedGeneration: "1", conditions: [] },
  };
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, relations_json, updated_at)
     VALUES (?, 'default', ?, ?, ?, ?, '1', '1', ?, ?, ?)`,
    [
      tenantId,
      resource.apiVersion,
      resource.kind,
      name,
      uid,
      JSON.stringify(resource),
      JSON.stringify(relations),
      NOW,
    ],
  );
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, created_at, updated_at)
     VALUES (?, ?, 'default', ?, ?, ?, ?, 'live', 1, '[]', ?, ?)`,
    [
      tenantId,
      uid,
      resource.apiVersion,
      resource.kind,
      name,
      canonicalJson(form.identity.formRef),
      NOW,
      NOW,
    ],
  );
}

async function insertSelectedPair(
  sql: Sql,
  workflowUid = "wf-qualified",
  workerUid = "worker-qualified",
): Promise<void> {
  await insertLiveResource(sql, selectedWorker, workerUid, "worker", {});
  await insertLiveResource(
    sql,
    selectedForm,
    workflowUid,
    "workflow",
    {
      className: "OrdersWorkflow",
      worker: {
        apiVersion: selectedWorker.identity.formRef.apiVersion,
        kind: "ModuleWorker",
        name: "worker",
      },
    },
    [
      {
        pointer: "/worker",
        relation: "/worker",
        targetApiVersion: selectedWorker.identity.formRef.apiVersion,
        targetKind: "ModuleWorker",
        targetName: "worker",
        targetUid: workerUid,
        targetRevision: "1",
        targetFormRef: selectedWorker.identity.formRef,
      },
    ],
  );
}

test("private due polling never recovers a legacy row beside an exact selected terminal owner", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const resourceUid = "wf-selected";
  const resource = {
    apiVersion: selectedForm.identity.formRef.apiVersion,
    kind: selectedForm.identity.formRef.kind,
    form: selectedForm.identity,
    metadata: {
      space: "default",
      name: "selected",
      uid: resourceUid,
      generation: "1",
      revision: "1",
    },
    spec: {
      className: "OrdersWorkflow",
      worker: { apiVersion: "edge.forms.takoform.com", kind: "ModuleWorker", name: "worker" },
    },
    status: { observedGeneration: "1", conditions: [] },
  };
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, relations_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '1', '1', ?, '[]', ?)`,
    [
      TENANT,
      "default",
      resource.apiVersion,
      resource.kind,
      "selected",
      resourceUid,
      JSON.stringify(resource),
      NOW,
    ],
  );
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, created_at, updated_at)
     VALUES (?, ?, 'default', ?, ?, 'selected', ?, 'live', 1, '[]', ?, ?)`,
    [
      TENANT,
      resourceUid,
      resource.apiVersion,
      resource.kind,
      canonicalJson(selectedForm.identity.formRef),
      NOW,
      NOW,
    ],
  );
  const insertInstance = async (
    workflowUid: string,
    id: string,
    status: string,
    requested: number,
  ) => {
    await sql.run(
      `INSERT INTO tf_workflow_instances
         (tenant_id, workflow_resource_uid, instance_id, execution_id, params_json, status,
          output_json, error_json, created_at, updated_at, deadline_at, retention_until,
          revision, run_epoch, run_owner, run_lease_until, termination_requested)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
      [
        TENANT,
        workflowUid,
        id,
        `execution-${id}`,
        status,
        NOW - 1000,
        NOW - 1000,
        NOW + 60_000,
        NOW + 120_000,
        `owner-${id}`,
        NOW,
        requested,
      ],
    );
  };
  await insertInstance("wf-legacy", "legacy-intent", "running", 1);
  await insertInstance(resourceUid, "selected-terminal", "errored", 0);
  const legacyBefore = await sql.query(
    "SELECT * FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = 'wf-legacy'",
    [TENANT],
  );
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => "unused-private-id",
    waitUntil: async () => {
      throw new Error("no waiting expected");
    },
    runtimeRoot: "/unmounted-workflow-runtime",
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
  });
  try {
    expect(await owner.pollDue()).toMatchObject({
      examined: 2,
      selected: 2,
      outcomes: [{ kind: "stale" }, { kind: "terminal", status: "errored" }],
    });
    expect(
      await sql.query(
        "SELECT * FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = 'wf-legacy'",
        [TENANT],
      ),
    ).toEqual(legacyBefore);
    expect(
      await sql.query(
        "SELECT run_owner, run_lease_until FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = ?",
        [TENANT, resourceUid],
      ),
    ).toEqual([{ run_owner: null, run_lease_until: null }]);
    expect((await owner.pollDue()).outcomes).toEqual([{ kind: "stale" }]);
  } finally {
    await owner.close();
  }
});

test("private instance creation refuses an unqualified Workflow graph", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => "unused-private-id",
    waitUntil: async () => {
      throw new Error("no waiting expected");
    },
    runtimeRoot: "/unmounted-workflow-runtime",
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
  });
  try {
    await expect(
      owner.instances.create(
        { tenantId: TENANT, workflowResourceUid: "wf-absent" },
        { id: "instance-1" },
      ),
    ).rejects.toMatchObject({ code: "host_unavailable" });
    expect(await sql.query("SELECT * FROM tf_workflow_instances")).toEqual([]);
  } finally {
    await owner.close();
  }
});

test("private instance creation reports unsupported capability when no serving Deployment exists", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  await insertSelectedPair(sql);
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => "unused-private-id",
    waitUntil: async () => {
      throw new Error("no waiting expected");
    },
    runtimeRoot: "/unmounted-workflow-runtime",
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
  });
  try {
    await expect(
      owner.instances.create(
        { tenantId: TENANT, workflowResourceUid: "wf-qualified" },
        { id: "instance-no-serving-deployment" },
      ),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(await sql.query("SELECT * FROM tf_workflow_instances")).toEqual([]);
    await owner.close();
    await expect(
      owner.instances.create(
        { tenantId: TENANT, workflowResourceUid: "wf-qualified" },
        { id: "instance-after-close" },
      ),
    ).rejects.toMatchObject({ code: "host_unavailable" });
    expect(await sql.query("SELECT * FROM tf_workflow_instances")).toEqual([]);
  } finally {
    await owner.close();
  }
});

test("private instance creation preserves backend failure when serving-state SQL is unavailable", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const sqlite = createSqliteSql(db);
  await insertSelectedPair(sqlite);
  const sql: Sql = {
    ...sqlite,
    async query(statement, params) {
      if (statement.includes("FROM tf_resource_deployments")) {
        throw new WorkflowRuntimeError("backend_unavailable");
      }
      return sqlite.query(statement, params);
    },
  };
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => "unused-private-id",
    waitUntil: async () => {
      throw new Error("no waiting expected");
    },
    runtimeRoot: "/unmounted-workflow-runtime",
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
  });
  try {
    await expect(
      owner.instances.create(
        { tenantId: TENANT, workflowResourceUid: "wf-qualified" },
        { id: "instance-storage-failure" },
      ),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(await sqlite.query("SELECT * FROM tf_workflow_instances")).toEqual([]);
  } finally {
    await owner.close();
  }
});

test("private close drains a begun direct run before handing off its Sql", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const sqlite = createSqliteSql(db);
  let entered!: () => void;
  let release!: () => void;
  const readEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sql: Sql = {
    ...sqlite,
    async query(statement, params) {
      if (statement.startsWith("SELECT 1 AS live WHERE")) {
        entered();
        await readGate;
      }
      return sqlite.query(statement, params);
    },
  };
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => "unused-private-id",
    waitUntil: async () => {
      throw new Error("no waiting expected");
    },
    runtimeRoot: "/unmounted-workflow-runtime",
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
  });
  const run = owner.runOne({ tenantId: TENANT, workflowResourceUid: "wf-absent" }, "instance");
  await readEntered;
  let closeSettled = false;
  const closing = owner.close().then(() => {
    closeSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(closeSettled).toBe(false);
  release();
  expect(await run).toEqual({ kind: "stale" });
  await closing;
  expect(closeSettled).toBe(true);
});

test("private instance creation treats a missing selected Version marker as unavailable host state", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  await insertSelectedPair(sql);
  await createResourceDeploymentStore(sql, () => new Date(NOW)).create({
    tenantId: TENANT,
    id: "deployment-qualified",
    resourceUid: "worker-qualified",
    offeringId: "offering-qualified",
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
    nativeId: "selfhost-worker:worker-script:operation-qualified",
    state: "active",
    observed: { scriptName: "worker-script" },
    outputs: { scriptName: "worker-script" },
  });
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => "private-execution-qualified",
    waitUntil: async () => {
      throw new Error("no waiting expected");
    },
    runtimeRoot: "/unmounted-workflow-runtime",
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
  });
  try {
    await expect(
      owner.instances.create(
        { tenantId: TENANT, workflowResourceUid: "wf-qualified" },
        { id: "instance-1" },
      ),
    ).rejects.toMatchObject({ code: "host_unavailable" });
    expect(await sql.query("SELECT * FROM tf_workflow_instances")).toEqual([]);
    await expect(
      owner.instances.create(
        { tenantId: "tenant-other", workflowResourceUid: "wf-qualified" },
        { id: "instance-2" },
      ),
    ).rejects.toMatchObject({ code: "host_unavailable" });
  } finally {
    await owner.close();
  }
});

test("private instance creation keeps a stale selected Worker UID as unavailable host state", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  await insertSelectedPair(sql);
  await createResourceDeploymentStore(sql, () => new Date(NOW)).create({
    tenantId: TENANT,
    id: "deployment-qualified",
    resourceUid: "worker-qualified",
    offeringId: "offering-qualified",
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
    nativeId: "selfhost-worker:worker-script:operation-qualified",
    state: "active",
    observed: { scriptName: "worker-script" },
    outputs: { scriptName: "worker-script" },
  });
  const root = mkdtempSync(join(tmpdir(), "takoserver-workflow-private-owner-stale-worker-"));
  runtimeRoots.push(root);
  const serving = createWorkerdRuntime({ root, isReady: () => true });
  if (!serving.publish) throw new Error("weighted publication is unavailable");
  await serving.publish("worker-script", {
    generation: "generation-stale-worker",
    workerResourceUid: "worker-replaced",
    hostnames: [],
    versions: [
      {
        versionId: "version-stale-worker",
        workerVersionUid: "worker-version-stale-worker",
        weight: 10_000,
        site: {
          directory: "worker-script",
          mainModule: "app.js",
          hostEntrypoint: "__host.js",
          hostnames: [],
          generation: "generation-stale-worker",
          workerResourceUid: "worker-replaced",
          fetchHandler: true,
        },
        modules: new Map([["app.js", new TextEncoder().encode("export default { fetch() {} };")]]),
        hostModules: new Map([
          ["__host.js", new TextEncoder().encode("export { default } from './app.js';")],
        ]),
      },
    ],
  });
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => "unused-private-id",
    waitUntil: async () => {
      throw new Error("no waiting expected");
    },
    runtimeRoot: root,
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
  });
  try {
    await expect(
      owner.instances.create(
        { tenantId: TENANT, workflowResourceUid: "wf-qualified" },
        { id: "instance-stale-worker" },
      ),
    ).rejects.toMatchObject({ code: "host_unavailable" });
    expect(await sql.query("SELECT * FROM tf_workflow_instances")).toEqual([]);
  } finally {
    await owner.close();
  }
});

test("private instance creation admits one exact selected active Version and live worker relation", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const sqlite = createSqliteSql(db);
  let delayVersionQuery = false;
  let entered!: () => void;
  let release!: () => void;
  const queryEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const queryGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sql: Sql = {
    ...sqlite,
    async query(statement, params) {
      if (
        delayVersionQuery &&
        statement.startsWith("WITH source_rows AS") &&
        params?.[1] === "version-qualified"
      ) {
        entered();
        await queryGate;
      }
      return sqlite.query(statement, params);
    },
  };
  await insertSelectedPair(sql);
  await insertLiveResource(
    sql,
    selectedVersion,
    "version-qualified",
    "version",
    {
      bundle: { apiVersion: "edge.forms.takoform.com", kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: "edge.forms.takoform.com", kind: "ModuleWorker", name: "worker" },
    },
    [
      {
        pointer: "/worker",
        relation: "/worker",
        targetApiVersion: selectedWorker.identity.formRef.apiVersion,
        targetKind: "ModuleWorker",
        targetName: "worker",
        targetUid: "worker-qualified",
        targetRevision: "1",
        targetFormRef: selectedWorker.identity.formRef,
      },
    ],
  );
  await createResourceDeploymentStore(sql, () => new Date(NOW)).create({
    tenantId: TENANT,
    id: "deployment-qualified",
    resourceUid: "worker-qualified",
    offeringId: "offering-qualified",
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
    nativeId: "selfhost-worker:worker-script:operation-qualified",
    state: "active",
    observed: { scriptName: "worker-script" },
    outputs: { scriptName: "worker-script" },
  });
  const root = mkdtempSync(join(tmpdir(), "takoserver-workflow-private-owner-"));
  runtimeRoots.push(root);
  const serving = createWorkerdRuntime({ root, isReady: () => true });
  if (!serving.publish) throw new Error("weighted publication is unavailable");
  await serving.publish("worker-script", {
    generation: "generation-qualified",
    workerResourceUid: "worker-qualified",
    hostnames: [],
    versions: [
      {
        versionId: "version-one",
        workerVersionUid: "version-qualified",
        weight: 10_000,
        site: {
          directory: "worker-script",
          mainModule: "app.js",
          hostEntrypoint: "__host.js",
          hostnames: [],
          generation: "generation-qualified",
          workerResourceUid: "worker-qualified",
          fetchHandler: true,
        },
        modules: new Map([
          [
            "app.js",
            new TextEncoder().encode("export default { fetch() { return new Response('ok'); } };"),
          ],
        ]),
        hostModules: new Map([
          ["__host.js", new TextEncoder().encode("export { default } from './app.js';")],
        ]),
      },
    ],
  });
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => "private-execution-qualified",
    waitUntil: async () => {
      throw new Error("no waiting expected");
    },
    runtimeRoot: root,
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
    basisPoint: () => 0,
  });
  try {
    expect(
      await owner.instances.create(
        { tenantId: TENANT, workflowResourceUid: "wf-qualified" },
        { id: "instance-one" },
      ),
    ).toMatchObject({ id: "instance-one" });
    expect(
      await sql.query("SELECT instance_id, workflow_resource_uid FROM tf_workflow_instances"),
    ).toEqual([{ instance_id: "instance-one", workflow_resource_uid: "wf-qualified" }]);
    await sql.run(
      "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, "version-qualified"],
    );
    await expect(
      owner.instances.create(
        { tenantId: TENANT, workflowResourceUid: "wf-qualified" },
        { id: "instance-after-version-closure" },
      ),
    ).rejects.toMatchObject({ code: "host_unavailable" });
    expect(await sql.query("SELECT instance_id FROM tf_workflow_instances")).toEqual([
      { instance_id: "instance-one" },
    ]);
    await sql.run(
      "UPDATE tf_resource_deletion_attestations SET state = 'live' WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, "version-qualified"],
    );
    delayVersionQuery = true;
    const pendingCreate = owner.instances.create(
      { tenantId: TENANT, workflowResourceUid: "wf-qualified" },
      { id: "instance-close-race" },
    );
    await queryEntered;
    let closeSettled = false;
    const closing = owner.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeSettled).toBe(false);
    release();
    await expect(pendingCreate).rejects.toBeDefined();
    await closing;
    expect(closeSettled).toBe(true);
    expect(await sqlite.query("SELECT instance_id FROM tf_workflow_instances")).toEqual([
      { instance_id: "instance-one" },
    ]);
  } finally {
    await owner.close();
  }
});
