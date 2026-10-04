import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { selfhostVersionBindingsRoot } from "../src/providers/selfhost.ts";
import {
  createSelfhostVersionBindingStore,
  deriveSelfhostWorkflowBindingToken,
} from "../src/providers/selfhost-version-bindings.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { openSelfhostWorkflowBindingBroker } from "../src/selfhost-workflow-binding-broker.ts";
import { openSelfhostWorkflowServing } from "../src/selfhost-workflow-serving.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import type { WorkerdWorkflowForwardBinding } from "../src/workerd-runtime.ts";
import { createWorkflowInstances } from "../src/workflow-instances.ts";
import { createWorkflowResourceGraphReader } from "../src/workflow-resource-graph.ts";
import { createWorkflowResourceDeletionContribution } from "../src/workflow-resource-lifecycle.ts";

const NOW = Date.UTC(2026, 9, 4);
const TENANT = "tenant-workflow-serving";
const WORKER_UID = "uid-worker-serving";
const VERSION_UID = "uid-version-serving";
const WORKFLOW_UID = "uid-workflow-serving";
const SCRIPT = "sw-workflow-serving";
const VERSION = "v-workflow-serving";
const forward = forwardTakoformCandidates();
function form(kind: string): InstalledTakoformForm {
  const found = forward.forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!found) throw new Error(`missing selected ${kind}`);
  return found;
}
const workerForm = form("ModuleWorker");
const versionForm = form("WorkerVersion");
const workflowForm = form("DurableWorkflow");
const workflowBinding = (() => {
  const found = forward.bindings.find(
    (candidate) => candidate.bindingRef.name === "module-worker.workflow",
  );
  if (!found) throw new Error("missing Workflow Binding");
  return found;
})();
const runtimeClassRef = (() => {
  const found = workflowForm.workerClassRuntime?.runtimeClassRef;
  if (!found) throw new Error("missing Workflow runtime Interface");
  return found;
})();

async function fixture(
  options: {
    readonly holdCreate?: {
      readonly entered: ReturnType<typeof Promise.withResolvers<void>>;
      readonly release: ReturnType<typeof Promise.withResolvers<void>>;
    };
    readonly openBroker?: typeof openSelfhostWorkflowBindingBroker;
    readonly afterFirstGraphRead?: (sql: Sql) => Promise<void>;
  } = {},
) {
  const { holdCreate, openBroker, afterFirstGraphRead } = options;
  const root = await mkdtemp(join(tmpdir(), "takoserver-workflow-serving-"));
  const socketParent = join(root, "sockets");
  await chmod(root, 0o700);
  const db = new Database(":memory:");
  migrateSqlite(db);
  const base = createSqliteSql(db);
  const sql: Sql = holdCreate
    ? {
        ...base,
        async batch(statements) {
          if (
            statements.some((statement) =>
              statement.sql.includes("INSERT INTO tf_workflow_instances"),
            )
          ) {
            holdCreate.entered.resolve();
            await holdCreate.release.promise;
          }
          return base.batch(statements);
        },
      }
    : base;
  const clock = () => new Date(NOW);
  const contribution = createWorkflowResourceDeletionContribution(
    sql,
    workflowForm.identity.formRef,
  );
  const resources = createTakoformStore(sql, clock, contribution);
  const deployments = createResourceDeploymentStore(sql, clock);
  const insert = async (
    selected: InstalledTakoformForm,
    uid: string,
    name: string,
    spec: object,
    relations: object[] = [],
  ) => {
    const resource = {
      apiVersion: selected.identity.formRef.apiVersion,
      kind: selected.identity.formRef.kind,
      form: selected.identity,
      metadata: { space: "default", name, uid, generation: "1", revision: "1" },
      spec,
      status: { observedGeneration: "1", conditions: [] },
    };
    await sql.run(
      `INSERT INTO tf_resources
      (tenant_id, space, api_version, kind, name, uid, generation, revision, resource_json, relations_json, updated_at)
      VALUES (?, 'default', ?, ?, ?, ?, '1', '1', ?, ?, ?)`,
      [
        TENANT,
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
      (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json, state, closure_fence, effects_json, created_at, updated_at)
      VALUES (?, ?, 'default', ?, ?, ?, ?, 'live', 1, '[]', ?, ?)`,
      [
        TENANT,
        uid,
        resource.apiVersion,
        resource.kind,
        name,
        canonicalJson(selected.identity.formRef),
        NOW,
        NOW,
      ],
    );
  };
  const workerPointer = {
    apiVersion: workerForm.identity.formRef.apiVersion,
    kind: "ModuleWorker",
    name: "worker",
  };
  const workerRelation = {
    pointer: "/worker",
    relation: "/worker",
    targetApiVersion: workerPointer.apiVersion,
    targetKind: workerPointer.kind,
    targetName: workerPointer.name,
    targetUid: WORKER_UID,
    targetRevision: "1",
    targetFormRef: workerForm.identity.formRef,
  };
  await insert(workerForm, WORKER_UID, "worker", {});
  await insert(
    workflowForm,
    WORKFLOW_UID,
    "workflow",
    { className: "OrdersWorkflow", worker: workerPointer },
    [workerRelation],
  );
  await insert(
    versionForm,
    VERSION_UID,
    "version",
    { worker: workerPointer, handlers: ["fetch"] },
    [workerRelation],
  );
  await deployments.create({
    tenantId: TENANT,
    id: "dep-worker",
    resourceUid: WORKER_UID,
    offeringId: "offering-worker",
    providerPackRef: "local",
    providerInstallationRef: "local.primary",
    nativeId: `selfhost-worker:${SCRIPT}:op-worker`,
    state: "active",
    observed: { scriptName: SCRIPT },
    outputs: { scriptName: SCRIPT },
  });
  const native = createSelfhostVersionBindingStore({ root: selfhostVersionBindingsRoot(root) });
  const binding = {
    name: "ORDERS",
    tenantId: TENANT,
    workflowResourceUid: WORKFLOW_UID,
    workflowFormRef: workflowForm.identity.formRef,
    bindingRef: workflowBinding.bindingRef,
    runtimeClassRef,
  };
  const stored = await native.write(SCRIPT, VERSION, {
    workerResourceUid: WORKER_UID,
    workerVersionResourceUid: VERSION_UID,
    handlers: ["fetch"],
    vars: [],
    sensitiveVars: [],
    serviceBindings: [],
    workflowBindings: [binding],
  });
  const token = deriveSelfhostWorkflowBindingToken({
    eventToken: stored.eventToken as string,
    workerVersionResourceUid: VERSION_UID,
    binding,
  });
  await deployments.create({
    tenantId: TENANT,
    id: "dep-version",
    resourceUid: VERSION_UID,
    offeringId: "offering-version",
    providerPackRef: "local",
    providerInstallationRef: "local.primary",
    nativeId: `selfhost-version:${SCRIPT}:${VERSION}:op-version`,
    state: "active",
    observed: { scriptName: SCRIPT, versionId: VERSION, workflowBindingsDigest: stored.digest },
    outputs: { scriptName: SCRIPT, versionId: VERSION },
  });
  let nextId = 0;
  const instances = createWorkflowInstances({
    sql,
    clock,
    randomId: () => `private-${++nextId}`,
    workflowInterfaceRef: runtimeClassRef,
    workflowResourceDeletion: contribution,
  });
  let ownerCloses = 0;
  const owner = {
    instances,
    async close() {
      ownerCloses += 1;
    },
  };
  const actualGraph = createWorkflowResourceGraphReader({ store: resources, form: workflowForm });
  let graphReads = 0;
  const manager = await openSelfhostWorkflowServing({
    dataRoot: root,
    socketParent,
    owner,
    graph: async (scope, signal) => {
      const graph = await actualGraph(scope, signal);
      graphReads += 1;
      if (graphReads === 1) await afterFirstGraphRead?.(sql);
      return graph;
    },
    resources,
    deployments,
    providerPackRef: "local",
    providerInstallationRef: "local.primary",
    ...(openBroker ? { openBroker } : {}),
  });
  const publishedBinding: WorkerdWorkflowForwardBinding = {
    publicName: "ORDERS",
    serviceName: "__TAKOSERVER_WORKFLOW_BINDING_00000",
    tenantId: TENANT,
    workflowResourceUid: WORKFLOW_UID,
    workflowFormRef: workflowForm.identity.formRef,
    bindingRef: workflowBinding.bindingRef,
    runtimeClassRef,
    token,
  };
  const publication = {
    script: SCRIPT,
    workerResourceUid: WORKER_UID,
    versionId: VERSION,
    workerVersionResourceUid: VERSION_UID,
    snapshotDigest: stored.digest,
    bindings: [publishedBinding],
  };
  return {
    root,
    db,
    sql,
    manager,
    publication,
    stored,
    deployments,
    instances,
    ownerCloses: () => ownerCloses,
    async addCandidateVersion() {
      const versionId = "v-workflow-candidate";
      const resourceUid = "uid-version-serving-candidate";
      await insert(
        versionForm,
        resourceUid,
        "version-candidate",
        { worker: workerPointer, handlers: ["fetch"] },
        [workerRelation],
      );
      const candidateStored = await native.write(SCRIPT, versionId, {
        workerResourceUid: WORKER_UID,
        workerVersionResourceUid: resourceUid,
        handlers: ["fetch"],
        vars: [],
        sensitiveVars: [],
        serviceBindings: [],
        workflowBindings: [binding],
      });
      await deployments.create({
        tenantId: TENANT,
        id: "dep-version-candidate",
        resourceUid,
        offeringId: "offering-version",
        providerPackRef: "local",
        providerInstallationRef: "local.primary",
        nativeId: `selfhost-version:${SCRIPT}:${versionId}:op-version-candidate`,
        state: "active",
        observed: {
          scriptName: SCRIPT,
          versionId,
          workflowBindingsDigest: candidateStored.digest,
        },
        outputs: { scriptName: SCRIPT, versionId },
      });
      return {
        ...publication,
        versionId,
        workerVersionResourceUid: resourceUid,
        snapshotDigest: candidateStored.digest,
        bindings: [
          {
            ...publishedBinding,
            token: deriveSelfhostWorkflowBindingToken({
              eventToken: candidateStored.eventToken as string,
              workerVersionResourceUid: resourceUid,
              binding,
            }),
          },
        ],
      };
    },
    async close() {
      await manager.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("selected Workflow V10 is served only after exact reservation activation", async () => {
  const f = await fixture();
  try {
    await f.manager.prepare([f.publication]);
    const [socket] = f.manager.sockets();
    expect(socket?.snapshotDigest).toBe(f.stored.digest);
    if (!socket) throw new Error("Workflow socket absent");
    const call = (operation: string, body: object) =>
      fetch(`http://workflow.invalid/__takoserver/workflow-binding/v1/${operation}`, {
        method: "POST",
        unix: socket.socketPath,
        headers: {
          "content-type": "application/json",
          "x-takoserver-private-workflow-binding-token": f.publication.bindings[0]?.token ?? "",
        },
        body: JSON.stringify(body),
      });
    expect((await call("create", { id: "order-1" })).status).toBe(503);
    const lease = await f.manager.reserve([f.publication]);
    f.manager.activated([f.publication]);
    expect((await call("create", { id: "order-1" })).status).toBe(200);
    expect((await call("status", { id: "order-1" })).status).toBe(200);
    expect((await call("sendEvent", { id: "order-1", type: "approved" })).status).toBe(200);
    await lease.release();
    f.manager.uncertain();
    expect((await call("get", { id: "order-1" })).status).toBe(503);
  } finally {
    await f.close();
  }
  expect(f.ownerCloses()).toBe(1);
});

test("a candidate reservation yields only its sockets while the old graph remains admitted", async () => {
  const f = await fixture();
  try {
    const candidate = await f.addCandidateVersion();
    const oldLease = await f.manager.reserve([f.publication]);
    f.manager.activated([f.publication]);
    const candidateLease = await f.manager.reserve([candidate]);
    expect(f.manager.sockets()).toHaveLength(2);
    expect(f.manager.socketsFor([candidate]).map((socket) => socket.versionId)).toEqual([
      "v-workflow-candidate",
    ]);
    expect(f.manager.socketsFor([f.publication]).map((socket) => socket.versionId)).toEqual([
      VERSION,
    ]);
    expect(() => f.manager.socketsFor([candidate, f.publication])).toThrow();
    expect(() => f.manager.socketsFor([candidate, candidate])).toThrow();
    await candidateLease.release();
    await oldLease.release();
  } finally {
    await f.close();
  }
});

test("activation acknowledges only an exact held graph and never acknowledges after close", async () => {
  const f = await fixture();
  try {
    expect(f.manager.activated([f.publication])).toBe(false);
    const lease = await f.manager.reserve([f.publication]);
    expect(f.manager.activated([f.publication])).toBe(true);
    expect(f.manager.socketsFor([f.publication])).toHaveLength(1);
    await lease.release();
    expect(f.manager.socketsFor([f.publication])).toHaveLength(1);
    await f.manager.close();
    expect(f.manager.activated([f.publication])).toBe(false);
  } finally {
    await f.close();
  }
});

test("uncertain invalidates prior socket reservations until a fresh proof", async () => {
  const f = await fixture();
  try {
    const stale = await f.manager.reserve([f.publication]);
    f.manager.uncertain();
    expect(() => f.manager.socketsFor([f.publication])).toThrow();
    expect(f.manager.activated([f.publication])).toBe(false);
    const fresh = await f.manager.reserve([f.publication]);
    expect(f.manager.socketsFor([f.publication])).toHaveLength(1);
    expect(f.manager.activated([f.publication])).toBe(true);
    await stale.release();
    await fresh.release();
  } finally {
    await f.close();
  }
});

test("empty graph sockets require an empty reservation or admitted empty graph", async () => {
  const f = await fixture();
  try {
    expect(() => f.manager.socketsFor([])).toThrow();
    const lease = await f.manager.reserve([]);
    expect(f.manager.socketsFor([])).toEqual([]);
    expect(() => f.manager.socketsFor([f.publication])).toThrow();
    expect(f.manager.activated([])).toBe(true);
    await lease.release();
    expect(f.manager.socketsFor([])).toEqual([]);
    f.manager.uncertain();
    expect(() => f.manager.socketsFor([])).toThrow();
  } finally {
    await f.close();
  }
});

test("corrupt canonical pin and publication identity never open a socket", async () => {
  const f = await fixture();
  try {
    const binding = f.publication.bindings[0];
    if (!binding) throw new Error("Workflow Binding absent");
    await expect(
      f.manager.prepare([{ ...f.publication, workerVersionResourceUid: "uid-other-version" }]),
    ).rejects.toThrow();
    await expect(
      f.manager.prepare([
        {
          ...f.publication,
          bindings: [
            {
              ...binding,
              runtimeClassRef: { ...runtimeClassRef, version: "2.0.0" },
            },
          ],
        },
      ]),
    ).rejects.toThrow();
    expect(f.manager.sockets()).toHaveLength(0);
    const changed = await f.deployments.refresh(
      TENANT,
      "dep-version",
      `selfhost-version:${SCRIPT}:${VERSION}:op-version`,
      {
        scriptName: SCRIPT,
        versionId: VERSION,
        workflowBindingsDigest: `sha256:${"0".repeat(64)}`,
      },
      { scriptName: SCRIPT, versionId: VERSION },
    );
    expect(changed).toBe(true);
    await expect(f.manager.prepare([f.publication])).rejects.toThrow();
    expect(f.manager.sockets()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("wrong tenant, BindingRef, and stale SQL graph cannot prepare a socket", async () => {
  const f = await fixture();
  try {
    const binding = f.publication.bindings[0];
    if (!binding) throw new Error("Workflow Binding absent");
    await expect(
      f.manager.prepare([
        { ...f.publication, bindings: [{ ...binding, tenantId: "tenant-other" }] },
      ]),
    ).rejects.toThrow();
    await expect(
      f.manager.prepare([
        {
          ...f.publication,
          bindings: [
            {
              ...binding,
              bindingRef: {
                ...binding.bindingRef,
                schemaDigest: `sha256:${"0".repeat(64)}`,
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow();
    await f.sql.run(
      "DELETE FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, WORKFLOW_UID],
    );
    await expect(f.manager.prepare([f.publication])).rejects.toThrow();
    expect(f.manager.sockets()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("an activated socket refuses a rotated canonical pin before reaching SQL", async () => {
  const f = await fixture();
  try {
    const lease = await f.manager.reserve([f.publication]);
    f.manager.activated([f.publication]);
    const [socket] = f.manager.sockets();
    if (!socket) throw new Error("Workflow socket absent");
    expect(
      await f.deployments.refresh(
        TENANT,
        "dep-version",
        `selfhost-version:${SCRIPT}:${VERSION}:op-version`,
        {
          scriptName: SCRIPT,
          versionId: VERSION,
          workflowBindingsDigest: `sha256:${"0".repeat(64)}`,
        },
        { scriptName: SCRIPT, versionId: VERSION },
      ),
    ).toBe(true);
    const response = await fetch(
      "http://workflow.invalid/__takoserver/workflow-binding/v1/create",
      {
        method: "POST",
        unix: socket.socketPath,
        headers: {
          "content-type": "application/json",
          "x-takoserver-private-workflow-binding-token": socket.binding.token,
        },
        body: JSON.stringify({ id: "after-pin-rotation" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: "takoserver.selfhost-workflow-binding-result@v1",
      error: "backend_unavailable",
    });
    expect(
      await f.sql.query(
        "SELECT instance_id FROM tf_workflow_instances WHERE tenant_id = ? AND instance_id = ?",
        [TENANT, "after-pin-rotation"],
      ),
    ).toHaveLength(0);
    await lease.release();
  } finally {
    await f.close();
  }
});

test("close joins a lost-reply accepted SQL create before closing its borrowed owner", async () => {
  const holdCreate = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  const f = await fixture({ holdCreate });
  try {
    const lease = await f.manager.reserve([f.publication]);
    f.manager.activated([f.publication]);
    const [socket] = f.manager.sockets();
    if (!socket) throw new Error("Workflow socket absent");
    const abort = new AbortController();
    const pending = fetch("http://workflow.invalid/__takoserver/workflow-binding/v1/create", {
      method: "POST",
      unix: socket.socketPath,
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-takoserver-private-workflow-binding-token": socket.binding.token,
      },
      body: JSON.stringify({ id: "lost-reply" }),
    });
    void pending.catch(() => undefined);
    await holdCreate.entered.promise;
    abort.abort();
    let settled = false;
    const closing = f.manager.close().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(f.ownerCloses()).toBe(0);
    holdCreate.release.resolve();
    await closing;
    await lease.release();
    expect(
      await f.instances.get({ tenantId: TENANT, workflowResourceUid: WORKFLOW_UID }, "lost-reply"),
    ).toEqual({ id: "lost-reply" });
    expect(f.ownerCloses()).toBe(1);
  } finally {
    holdCreate.release.resolve();
    await f.close();
  }
});

test("a failed broker retirement keeps borrowed SQL open and retries the real drain", async () => {
  const holdCreate = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  };
  let failedOnce = false;
  const f = await fixture({
    holdCreate,
    openBroker: async (options) => {
      const actual = await openSelfhostWorkflowBindingBroker(options);
      const retire = (): Promise<void> => {
        if (!failedOnce) {
          failedOnce = true;
          return Promise.reject(new Error("injected listener retirement failure"));
        }
        return actual.retire();
      };
      return { socketPath: actual.socketPath, retire, close: retire };
    },
  });
  try {
    const lease = await f.manager.reserve([f.publication]);
    f.manager.activated([f.publication]);
    const [socket] = f.manager.sockets();
    if (!socket) throw new Error("Workflow socket absent");
    const abort = new AbortController();
    const pending = fetch("http://workflow.invalid/__takoserver/workflow-binding/v1/create", {
      method: "POST",
      unix: socket.socketPath,
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-takoserver-private-workflow-binding-token": socket.binding.token,
      },
      body: JSON.stringify({ id: "retire-retry" }),
    });
    void pending.catch(() => undefined);
    await holdCreate.entered.promise;
    abort.abort();
    const firstClose = f.manager.close().then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    expect(
      await Promise.race([
        firstClose,
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
      ]),
    ).toBe("rejected");
    expect(f.ownerCloses()).toBe(0);
    let retried = false;
    const retry = f.manager.close().then(() => {
      retried = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retried).toBe(false);
    expect(f.ownerCloses()).toBe(0);
    holdCreate.release.resolve();
    await retry;
    await lease.release();
    expect(f.ownerCloses()).toBe(1);
    expect(
      await f.instances.get(
        { tenantId: TENANT, workflowResourceUid: WORKFLOW_UID },
        "retire-retry",
      ),
    ).toEqual({ id: "retire-retry" });
  } finally {
    holdCreate.release.resolve();
    await f.close();
  }
});

test("failed provisional rollback retains its listener without re-admitting it", async () => {
  const actuals: Awaited<ReturnType<typeof openSelfhostWorkflowBindingBroker>>[] = [];
  let failedOnce = false;
  const f = await fixture({
    afterFirstGraphRead: async (sql) => {
      await sql.run(
        "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE tenant_id = ? AND resource_uid = ?",
        [TENANT, WORKFLOW_UID],
      );
    },
    openBroker: async (options) => {
      const actual = await openSelfhostWorkflowBindingBroker(options);
      actuals.push(actual);
      const retire = (): Promise<void> => {
        if (!failedOnce) {
          failedOnce = true;
          return Promise.reject(new Error("injected provisional listener failure"));
        }
        return actual.retire();
      };
      return { socketPath: actual.socketPath, retire, close: retire };
    },
  });
  try {
    await expect(f.manager.prepare([f.publication])).rejects.toThrow();
    expect(f.manager.sockets()).toHaveLength(0);
    const orphan = actuals[0];
    if (!orphan) throw new Error("provisional listener absent");
    await f.sql.run(
      "UPDATE tf_resource_deletion_attestations SET state = 'live' WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, WORKFLOW_UID],
    );
    const lease = await f.manager.reserve([f.publication]);
    f.manager.activated([f.publication]);
    const [replacement] = f.manager.sockets();
    if (!replacement) throw new Error("replacement listener absent");
    expect(replacement.socketPath).not.toBe(orphan.socketPath);
    const call = (socketPath: string, id: string) =>
      fetch("http://workflow.invalid/__takoserver/workflow-binding/v1/create", {
        method: "POST",
        unix: socketPath,
        headers: {
          "content-type": "application/json",
          "x-takoserver-private-workflow-binding-token": replacement.binding.token,
        },
        body: JSON.stringify({ id }),
      });
    expect((await call(orphan.socketPath, "orphan-admission")).status).toBe(503);
    expect((await call(replacement.socketPath, "replacement-admission")).status).toBe(200);
    await lease.release();
  } finally {
    await Promise.allSettled(actuals.map((broker) => broker.retire()));
    await f.close();
  }
});
