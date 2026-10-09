import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { v2SqliteWorkerProjection } from "../src/providers/selfhost-v2-sqlite-worker-projection.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  V2_SQLITE_ADAPTER_MODULE,
  V2_SQLITE_INTRINSIC_MODULE,
} from "../src/takoform-v2/worker-code-runtime.ts";
import { DURABLE_WORKFLOW_BACKEND_ID } from "../src/takoform-v2/workflow-backend.ts";
import { createV2WorkflowForwardRuntime } from "../src/takoform-v2/workflow-forward-runtime.ts";
import { createV2WorkflowNativeSelection } from "../src/takoform-v2/workflow-native-selection.ts";
import { createV2WorkflowSelectedMaterials } from "../src/takoform-v2/workflow-selected-materials.ts";
import type { WorkflowRunIdentity } from "../src/workflow-execution.ts";

const PRINCIPAL = "org:workflow-native";
const SPACE = "production";
const TARGET = "selfhost-workflow-native-test";
const WORKER_UID = "worker-uid";
const VERSION_UID = "version-uid";
const WORKFLOW_UID = "workflow-uid";
const SOURCE_OPERATION = "deployment-operation";
const GENERATION = "native-generation";
const source = new TextEncoder().encode("export class ReportWorkflow { run() { return {}; } }");
const digest = createHash("sha256").update(source).digest("hex");
const versionId = `v2-${createHash("sha256").update(`${VERSION_UID}\u00001`).digest("hex")}`;

const identity: WorkflowRunIdentity = {
  scope: { tenantId: PRINCIPAL, workflowResourceUid: WORKFLOW_UID },
  instanceId: "instance-1",
  executionId: "execution-1",
  createdAt: Date.now(),
  epoch: 1,
  owner: "runner-1",
  deadlineAt: Date.now() + 60_000,
};

function fixture(basisPoint: () => number = () => 7) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const spec = JSON.stringify({ worker: { resourceUid: WORKER_UID }, className: "ReportWorkflow" });
  const instant = new Date().toISOString();
  db.query(
    `INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key, active_name,
       generation, observed_generation, phase, spec_json, observed_json, last_operation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'idle', '{}', '{"ready":true}', ?)`,
  ).run(
    WORKER_UID,
    PRINCIPAL,
    "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/",
    SPACE,
    "worker",
    "synthetic-worker-backend",
    TARGET,
    "worker",
    "worker-operation",
  );
  db.query(
    `INSERT INTO tf_v2_operations
      (id, resource_uid, principal, replay_key, request_fingerprint, action,
       generation, status, effect, created_at, updated_at, retain_until,
       backend_id, target_key, backend_key, accepted_spec_json)
     VALUES (?, ?, ?, ?, ?, 'create', 1, 'succeeded', 'complete', ?, ?, ?, ?, ?, ?, '{}')`,
  ).run(
    "worker-operation",
    WORKER_UID,
    PRINCIPAL,
    "worker-key",
    "worker-fingerprint",
    instant,
    instant,
    instant,
    "synthetic-worker-backend",
    TARGET,
    "worker-backend-key",
  );
  db.query(
    `INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key, active_name,
       generation, observed_generation, phase, spec_json, observed_json,
       last_operation, busy_operation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'pending', ?, '{}', ?, ?)`,
  ).run(
    WORKFLOW_UID,
    PRINCIPAL,
    "https://edge.forms.takoform.com/forms/DurableWorkflow/0.3.0/",
    SPACE,
    "workflow",
    DURABLE_WORKFLOW_BACKEND_ID,
    TARGET,
    "workflow",
    spec,
    "workflow-operation",
    "workflow-operation",
  );
  db.query(
    `INSERT INTO tf_v2_operations
      (id, resource_uid, principal, replay_key, request_fingerprint, action,
       generation, status, effect, created_at, updated_at, retain_until,
       backend_id, target_key, backend_key, accepted_spec_json)
     VALUES (?, ?, ?, ?, ?, 'create', 1, 'queued', 'none', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "workflow-operation",
    WORKFLOW_UID,
    PRINCIPAL,
    "workflow-key",
    "fingerprint",
    instant,
    instant,
    instant,
    DURABLE_WORKFLOW_BACKEND_ID,
    TARGET,
    "workflow-backend-key",
    spec,
  );
  db.query("INSERT INTO tf_v2_operation_reference_sets (operation_id) VALUES (?)").run(
    "workflow-operation",
  );
  db.query(
    `INSERT INTO tf_v2_operation_references
      (operation_id, target_uid, form_url, readiness)
     VALUES (?, ?, ?, 'observed')`,
  ).run(
    "workflow-operation",
    WORKER_UID,
    "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/",
  );
  db.query("UPDATE tf_v2_operation_reference_sets SET sealed = 1 WHERE operation_id = ?").run(
    "workflow-operation",
  );
  db.query("UPDATE tf_v2_operations SET status = 'running' WHERE id = ?").run("workflow-operation");
  db.query(
    "UPDATE tf_v2_operations SET status = 'reconciling', effect = 'unknown' WHERE id = ?",
  ).run("workflow-operation");
  db.query(
    `UPDATE tf_v2_operations
     SET status = 'succeeded', effect = 'complete', result_observed_json = '{"ready":true}'
     WHERE id = ?`,
  ).run("workflow-operation");
  const selected = {
    generation: GENERATION,
    generationKey: "generation-key",
    workerResourceUid: WORKER_UID,
    versionId,
    workerVersionUid: VERSION_UID,
    site: {
      directory: "/unused-synthetic-site",
      mainModule: "index.mjs",
      hostEntrypoint: "host.mjs",
      hostnames: [],
      generation: GENERATION,
      workerResourceUid: WORKER_UID,
      fetchHandler: false,
      modules: [] as string[],
      moduleMediaTypes: { "index.mjs": "application/javascript+module" as const },
    },
    modules: new Map([["index.mjs", new Uint8Array(source)]]),
    hostModules: new Map([["host.mjs", new TextEncoder().encode("export default {}")]]),
  };
  let ownerCurrent = true;
  let publicationCurrent = true;
  let ownerSelects = 0;
  let inspected = 0;
  const servingVersions = [{ workerVersionUid: VERSION_UID, weight: 10_000 }];
  const servingHostnames: string[] = [];
  const owner = {
    async observeServing() {
      return {
        kind: "serving" as const,
        workerResourceUid: WORKER_UID,
        targetKey: TARGET,
        sourceOperationId: SOURCE_OPERATION,
        generation: GENERATION,
        hostnames: [...servingHostnames],
        versions: servingVersions,
      };
    },
    async selectWorkflowExecution(input: { readonly basisPoint: number }) {
      ownerSelects += 1;
      expect(input.basisPoint).toBe(7);
      return {
        kind: "selected" as const,
        sourceOperationId: SOURCE_OPERATION,
        incarnationId: "physical-incarnation-1",
        selected,
        stillCurrent: async () => ownerCurrent,
        acquirePrivateServiceBindings: async () => ({
          services: [],
          workflowServices: [],
          async release() {},
        }),
      };
    },
  };
  const snapshot = {
    sourceOperationId: SOURCE_OPERATION,
    worker: { uid: WORKER_UID, principal: PRINCIPAL, space: SPACE, generation: 1 },
    deployment: {
      uid: "deployment-uid",
      generation: 1,
      spec: parseWorkerDeploymentSpec({
        worker: { resourceUid: WORKER_UID },
        versions: [{ workerVersion: { resourceUid: VERSION_UID }, weight: 10_000 }],
      }),
      versions: [
        {
          uid: VERSION_UID,
          sourceOperationId: "version-operation",
          generation: 1,
          weight: 10_000,
          spec: parseWorkerVersionSpec({
            worker: { resourceUid: WORKER_UID },
            bundle: { resourceUid: "bundle-uid" },
            handlers: [],
          }),
        },
      ],
    },
    endpoint: null,
  };
  const publicationState = {
    async resolveCurrentServing(input: {
      readonly expectedIdentity: { readonly generation: string };
    }) {
      expect(input.expectedIdentity.generation).toBe(GENERATION);
      return {
        kind: "ready" as const,
        snapshot,
        stillCurrent: async () => publicationCurrent,
        async readVersionMaterials() {
          return {
            bundle: {
              manifest: {
                entrypoint: "index.mjs",
                files: [
                  {
                    path: "index.mjs",
                    url: "https://example.test/index.mjs",
                    sha256: digest,
                    mediaType: "application/javascript+module" as const,
                  },
                ],
              },
              manifestBytes: new Uint8Array(),
              files: [new Uint8Array(source)],
              observed: {},
            },
            assets: null,
          };
        },
      };
    },
  };
  const inspector = {
    async inspectWorkflowClass(input: {
      readonly className: string;
      readonly modules: readonly { readonly bytes: Uint8Array }[];
    }) {
      inspected += 1;
      expect(input.className).toBe("ReportWorkflow");
      expect(input.modules[0]?.bytes).toEqual(source);
      return { outcome: "valid" as const };
    },
  };
  const select = createV2WorkflowNativeSelection({
    sql,
    targetKey: TARGET,
    ownerForWorkerUid: async (workerUid) => {
      expect(workerUid).toBe(WORKER_UID);
      return owner;
    },
    publicationState,
    inspector,
    basisPoint,
  });
  return {
    db,
    sql,
    owner,
    publicationState,
    inspector,
    select,
    selected,
    snapshot,
    servingVersions,
    servingHostnames,
    get ownerSelects() {
      return ownerSelects;
    },
    get inspected() {
      return inspected;
    },
    setOwnerCurrent(value: boolean) {
      ownerCurrent = value;
    },
    setPublicationCurrent(value: boolean) {
      publicationCurrent = value;
    },
  };
}

test("accepted Workflow graph yields one verified selected Version and revokes on Resource deletion", async () => {
  const f = fixture();
  try {
    const select = createV2WorkflowSelectedMaterials({
      sql: f.sql,
      targetKey: TARGET,
      publicationState: f.publicationState,
      inspector: f.inspector,
    });
    const selected = await select(
      identity,
      new AbortController().signal,
      () => f.owner.observeServing(),
      7,
    );
    expect(selected.version.uid).toBe(VERSION_UID);
    expect(selected.snapshot.sourceOperationId).toBe(SOURCE_OPERATION);
    expect(selected.resource.className).toBe("ReportWorkflow");
    expect(selected.materials.bundle?.files[0]).toEqual(source);
    expect(await selected.stillCurrent()).toBe(true);
    f.servingHostnames.push("changed.example.test");
    expect(await selected.stillCurrent()).toBe(false);
    f.servingHostnames.splice(0);
    f.db.query("UPDATE tf_v2_resources SET phase = 'deleting' WHERE uid = ?").run(WORKFLOW_UID);
    expect(await selected.stillCurrent()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("selected Workerd site never relabels accepted Workflow A after caller scope mutates to B", async () => {
  const f = fixture();
  try {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atOwner = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const selectOwner = f.owner.selectWorkflowExecution;
    f.owner.selectWorkflowExecution = async (input) => {
      entered();
      await held;
      return selectOwner(input);
    };
    const mutable = { ...identity, scope: { ...identity.scope } };
    const selected = f.select(mutable, new AbortController().signal);
    await atOwner;
    mutable.scope.workflowResourceUid = "workflow-B";
    release();
    expect((await selected).selection.workflowResourceUid).toBe(WORKFLOW_UID);
  } finally {
    f.db.close();
  }
});

test("selection captures Workflow scope before a mutable basis-point callback", async () => {
  const mutable = { ...identity, scope: { ...identity.scope } };
  const f = fixture(() => {
    mutable.scope.workflowResourceUid = "workflow-B";
    return 7;
  });
  try {
    expect(
      (await f.select(mutable, new AbortController().signal)).selection.workflowResourceUid,
    ).toBe(WORKFLOW_UID);
  } finally {
    f.db.close();
  }
});

test("synthetic selected Version has no hostnames while accepted Worker serves an Endpoint", async () => {
  const f = fixture();
  try {
    f.servingHostnames.push("worker.example.test");
    const captured = await f.select(identity, new AbortController().signal);
    expect(captured.selection.site.hostnames).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("synthetic owner selection binds accepted Workflow principal, Space, class and held native bytes", async () => {
  const f = fixture();
  try {
    const captured = await f.select(identity, new AbortController().signal);
    expect(captured.incarnationId).toBe("physical-incarnation-1");
    expect(captured.selection).toMatchObject({
      tenantId: PRINCIPAL,
      workflowResourceUid: WORKFLOW_UID,
      workerResourceUid: WORKER_UID,
      workerVersionUid: VERSION_UID,
      versionId,
      className: "ReportWorkflow",
    });
    expect(f.ownerSelects).toBe(1);
    expect(f.inspected).toBe(1);
    expect(await captured.stillCurrent()).toBe(true);
    f.setPublicationCurrent(false);
    expect(await captured.stillCurrent()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("synthetic owner selection denies wrong Space, changed bytes, and deleting Resource", async () => {
  const f = fixture();
  try {
    f.snapshot.worker.space = "other-space";
    await expect(f.select(identity, new AbortController().signal)).rejects.toMatchObject({
      code: "host_unavailable",
    });
    f.snapshot.worker.space = SPACE;
    f.selected.modules.set("index.mjs", new TextEncoder().encode("different bytes"));
    await expect(f.select(identity, new AbortController().signal)).rejects.toMatchObject({
      code: "host_unavailable",
    });
    f.selected.modules.set("index.mjs", new Uint8Array(source));
    f.db.query("UPDATE tf_v2_resources SET phase = 'deleting' WHERE uid = ?").run(WORKFLOW_UID);
    await expect(f.select(identity, new AbortController().signal)).rejects.toMatchObject({
      code: "host_unavailable",
    });
  } finally {
    f.db.close();
  }
});

test("synthetic owner selection denies a native main or extra app module outside held Bundle", async () => {
  const f = fixture();
  try {
    const rogue = new TextEncoder().encode(
      "export default { fetch() { return new Response('rogue'); } }",
    );
    f.selected.site.mainModule = "rogue.mjs";
    f.selected.site.modules.push("index.mjs");
    f.selected.modules.set("rogue.mjs", rogue);
    await expect(f.select(identity, new AbortController().signal)).rejects.toMatchObject({
      code: "host_unavailable",
    });
    f.selected.site.mainModule = "index.mjs";
    f.selected.site.modules.splice(0, 1, "rogue.mjs");
    await expect(f.select(identity, new AbortController().signal)).rejects.toMatchObject({
      code: "host_unavailable",
    });
  } finally {
    f.db.close();
  }
});

test("synthetic selection accepts only the accepted Version's exact v2 SQLite adapter", async () => {
  const f = fixture();
  try {
    const version = f.snapshot.deployment.versions[0];
    if (!version) throw new Error("missing synthetic Version");
    version.spec = parseWorkerVersionSpec({
      worker: { resourceUid: WORKER_UID },
      bundle: { resourceUid: "bundle-uid" },
      handlers: [],
      sqliteBindings: [{ name: "DB", resource: { resourceUid: "database-uid" } }],
    });
    const projected = v2SqliteWorkerProjection({
      originalMainModule: "index.mjs",
      adapterModule: V2_SQLITE_ADAPTER_MODULE,
      intrinsicModule: V2_SQLITE_INTRINSIC_MODULE,
      sqliteBindingNames: ["DB"],
      declaredHandlers: [],
    });
    f.selected.site.mainModule = V2_SQLITE_ADAPTER_MODULE;
    f.selected.site.modules.push("index.mjs", V2_SQLITE_INTRINSIC_MODULE);
    for (const [name, bytes] of projected) {
      f.selected.modules.set(name, new Uint8Array(bytes));
      Object.assign(f.selected.site.moduleMediaTypes, {
        [name]: "application/javascript+module",
      });
    }
    expect((await f.select(identity, new AbortController().signal)).selection.className).toBe(
      "ReportWorkflow",
    );
    f.selected.modules.set(V2_SQLITE_ADAPTER_MODULE, new Uint8Array([1]));
    await expect(f.select(identity, new AbortController().signal)).rejects.toMatchObject({
      code: "host_unavailable",
    });
  } finally {
    f.db.close();
  }
});

test("synthetic selected incarnation loses admission on accepted Resource change", async () => {
  const f = fixture();
  try {
    const captured = await f.select(identity, new AbortController().signal);
    f.setOwnerCurrent(false);
    expect(await captured.stillCurrent()).toBe(false);
    f.setOwnerCurrent(true);
    f.db.query("UPDATE tf_v2_resources SET phase = 'deleting' WHERE uid = ?").run(WORKFLOW_UID);
    expect(await captured.stillCurrent()).toBe(false);
  } finally {
    f.db.close();
  }
});

test("synthetic selection requires the sealed Workflow to Worker reference and live edge", async () => {
  const f = fixture();
  try {
    const captured = await f.select(identity, new AbortController().signal);
    f.db.query("DELETE FROM tf_v2_resource_references WHERE referrer_uid = ?").run(WORKFLOW_UID);
    expect(await captured.stillCurrent()).toBe(false);
    await expect(f.select(identity, new AbortController().signal)).rejects.toMatchObject({
      code: "host_unavailable",
    });
  } finally {
    f.db.close();
  }
});

test("synthetic weighted selection uses native codepoint UID order", async () => {
  const f = fixture();
  try {
    f.servingVersions.splice(
      0,
      1,
      { workerVersionUid: "Z-Version", weight: 5_000 },
      { workerVersionUid: "a-version", weight: 5_000 },
    );
    const version = f.snapshot.deployment.versions[0];
    if (!version) throw new Error("missing synthetic Version");
    version.uid = "Z-Version";
    f.selected.workerVersionUid = "Z-Version";
    f.selected.versionId = `v2-${createHash("sha256").update("Z-Version\u00001").digest("hex")}`;
    const captured = await f.select(identity, new AbortController().signal);
    expect(captured.selection.workerVersionUid).toBe("Z-Version");
  } finally {
    f.db.close();
  }
});

test("synthetic existing run remains selectable during a same-spec accepted PUT", async () => {
  const f = fixture();
  try {
    const resource = f.db
      .query("SELECT spec_json FROM tf_v2_resources WHERE uid = ?")
      .get(WORKFLOW_UID) as { spec_json: string };
    f.db
      .query(
        `UPDATE tf_v2_resources SET generation = 2, phase = 'pending',
         last_operation = 'workflow-update', busy_operation = 'workflow-update'
         WHERE uid = ?`,
      )
      .run(WORKFLOW_UID);
    const instant = new Date().toISOString();
    f.db
      .query(
        `INSERT INTO tf_v2_operations
         (id, resource_uid, principal, replay_key, request_fingerprint, action,
          generation, status, effect, created_at, updated_at, retain_until,
          backend_id, target_key, backend_key, accepted_spec_json)
         VALUES ('workflow-update', ?, ?, 'workflow-update-key', 'update-fingerprint',
          'update', 2, 'queued', 'none', ?, ?, ?, ?, ?, 'workflow-update-backend', ?)`,
      )
      .run(
        WORKFLOW_UID,
        PRINCIPAL,
        instant,
        instant,
        instant,
        DURABLE_WORKFLOW_BACKEND_ID,
        TARGET,
        resource.spec_json,
      );
    f.db
      .query("INSERT INTO tf_v2_operation_reference_sets (operation_id) VALUES ('workflow-update')")
      .run();
    f.db
      .query(
        `INSERT INTO tf_v2_operation_references
         (operation_id, target_uid, form_url, readiness)
         VALUES ('workflow-update', ?, ?, 'observed')`,
      )
      .run(WORKER_UID, "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/");
    f.db
      .query(
        "UPDATE tf_v2_operation_reference_sets SET sealed = 1 WHERE operation_id = 'workflow-update'",
      )
      .run();
    const captured = await f.select(identity, new AbortController().signal);
    expect(captured.selection.workflowResourceUid).toBe(WORKFLOW_UID);
    expect(await captured.stillCurrent()).toBe(true);
  } finally {
    f.db.close();
  }
});

test("synthetic forward preparation closes ingress and artifacts when selection goes stale", async () => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "v2-workflow-preparation-"));
  try {
    let currentChecks = 0;
    const prepare = createV2WorkflowForwardRuntime({
      temporaryRoot: root,
      select: async (runIdentity, signal) => {
        const captured = await f.select(runIdentity, signal);
        return {
          ...captured,
          stillCurrent: async () => {
            currentChecks += 1;
            return currentChecks === 1;
          },
        };
      },
    });
    await expect(
      prepare(identity, undefined, new AbortController().signal, {
        journalToken: "a".repeat(64),
        recordPayload() {},
      }),
    ).rejects.toMatchObject({ code: "host_unavailable" });
    expect(currentChecks).toBe(2);
    expect(await readdir(root)).toEqual([]);
  } finally {
    f.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic accepted selection prepares a guarded child config and releases it", async () => {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), "v2-workflow-preparation-"));
  try {
    const prepare = createV2WorkflowForwardRuntime({
      temporaryRoot: root,
      select: f.select,
    });
    const prepared = await prepare(identity, { report: 1 }, new AbortController().signal, {
      journalToken: "b".repeat(64),
      recordPayload() {},
    });
    expect(prepared.configPath.startsWith(root)).toBe(true);
    expect(await readdir(root)).toHaveLength(1);
    await prepared.drainAfterStop();
    await prepared.dispose();
    expect(await readdir(root)).toEqual([]);
  } finally {
    f.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
