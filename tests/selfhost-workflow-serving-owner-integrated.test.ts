import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
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
import {
  SELFHOST_SOCKET_DIRECTORY_PREFIX,
  SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES,
} from "../src/selfhost-socket-layout.ts";
import { createSelfhostWorkflowPrivateOwner } from "../src/selfhost-workflow-private-owner.ts";
import { openSelfhostWorkflowServing } from "../src/selfhost-workflow-serving.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createWorkflowResourceGraphReader } from "../src/workflow-resource-graph.ts";
import { mkdtempForSockets } from "./helpers/socket-temp-root.ts";

const NOW = Date.UTC(2026, 9, 4);
const TENANT = "tenant-serving-integrated";
const WORKER_UID = "uid-worker-integrated";
const VERSION_UID = "uid-version-integrated";
const WORKFLOW_UID = "uid-workflow-integrated";
const SCRIPT = "workflow-integrated";
const VERSION = "version-integrated";
const PACK = "local";
const INSTALLATION = "local.primary";
const forward = forwardTakoformCandidates();

function form(kind: string): InstalledTakoformForm {
  const selected = forward.forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!selected) throw new Error(`selected ${kind} Form unavailable`);
  return selected;
}

const workerForm = form("ModuleWorker");
const versionForm = form("WorkerVersion");
const workflowForm = form("DurableWorkflow");
const workflowBinding = forward.bindings.find(
  (candidate) => candidate.bindingRef.name === "module-worker.workflow",
);
const runtimeClassRef = workflowForm.workerClassRuntime?.runtimeClassRef;
if (!workflowBinding || !runtimeClassRef) throw new Error("selected Workflow contract unavailable");

async function insertLive(
  sql: Sql,
  selected: InstalledTakoformForm,
  uid: string,
  name: string,
  spec: object,
  relations: readonly object[] = [],
): Promise<void> {
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
      (tenant_id, space, api_version, kind, name, uid, generation, revision,
       resource_json, relations_json, updated_at)
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
      (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
       state, closure_fence, effects_json, created_at, updated_at)
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
}

test("selected serving manager dispatches to a real private owner and drains before same-DB handoff", async () => {
  // Only the external guard/workerd child boundary is substituted: no class is
  // run. Resource, deployment, Version selection, owner, broker and UDS are real.
  // Leave room for `<root>/sockets/w??????/<20 hex>.sock` under the 100-byte
  // Unix socket limit whatever TMPDIR the runner uses.
  const root = await mkdtempForSockets(
    "ts-workflow-owner-",
    SELFHOST_UNIX_SOCKET_PATH_MAX_BYTES -
      Buffer.byteLength(
        `/sockets/${SELFHOST_SOCKET_DIRECTORY_PREFIX.workflowBrokers}XXXXXX/${"0".repeat(20)}.sock`,
      ),
  );
  await chmod(root, 0o700);
  const db = new Database(join(root, "state.sqlite"));
  migrateSqlite(db);
  const sqlite = createSqliteSql(db);
  const eventEntered = Promise.withResolvers<void>();
  const eventRelease = Promise.withResolvers<void>();
  let holdEvent = false;
  const sql: Sql = {
    ...sqlite,
    async batch(statements) {
      if (
        holdEvent &&
        statements.some((statement) => statement.sql.includes("INSERT INTO tf_workflow_events"))
      ) {
        holdEvent = false;
        eventEntered.resolve();
        await eventRelease.promise;
      }
      return sqlite.batch(statements);
    },
  };
  const clock = () => new Date(NOW);
  const deployments = createResourceDeploymentStore(sql, clock);
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
  let manager: Awaited<ReturnType<typeof openSelfhostWorkflowServing>> | undefined;
  let restarted: Awaited<ReturnType<typeof openSelfhostWorkflowServing>> | undefined;
  let owner: ReturnType<typeof createSelfhostWorkflowPrivateOwner> | undefined;
  let freshOwner: ReturnType<typeof createSelfhostWorkflowPrivateOwner> | undefined;
  try {
    await insertLive(sql, workerForm, WORKER_UID, "worker", {});
    await insertLive(
      sql,
      workflowForm,
      WORKFLOW_UID,
      "workflow",
      { className: "OrdersWorkflow", worker: workerPointer },
      [workerRelation],
    );
    await insertLive(
      sql,
      versionForm,
      VERSION_UID,
      "version",
      {
        bundle: { apiVersion: workerPointer.apiVersion, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: workerPointer,
      },
      [workerRelation],
    );
    await deployments.create({
      tenantId: TENANT,
      id: "deployment-worker-integrated",
      resourceUid: WORKER_UID,
      offeringId: "offering-worker",
      providerPackRef: PACK,
      providerInstallationRef: INSTALLATION,
      nativeId: `selfhost-worker:${SCRIPT}:operation-worker`,
      state: "active",
      observed: { scriptName: SCRIPT },
      outputs: { scriptName: SCRIPT },
    });
    const runtime = createWorkerdRuntime({ root, isReady: () => true });
    if (!runtime.publish) throw new Error("weighted Version publication unavailable");
    await runtime.publish(SCRIPT, {
      generation: "generation-integrated",
      workerResourceUid: WORKER_UID,
      hostnames: [],
      versions: [
        {
          versionId: VERSION,
          workerVersionUid: VERSION_UID,
          weight: 10_000,
          site: {
            directory: SCRIPT,
            mainModule: "app.js",
            hostEntrypoint: "__host.js",
            hostnames: [],
            generation: "generation-integrated",
            workerResourceUid: WORKER_UID,
            fetchHandler: true,
          },
          modules: new Map([
            [
              "app.js",
              new TextEncoder().encode(
                "export default { fetch() { return new Response('ok'); } };",
              ),
            ],
          ]),
          hostModules: new Map([
            ["__host.js", new TextEncoder().encode("export { default } from './app.js';")],
          ]),
        },
      ],
    });
    const binding = {
      name: "ORDERS",
      tenantId: TENANT,
      workflowResourceUid: WORKFLOW_UID,
      workflowFormRef: workflowForm.identity.formRef,
      bindingRef: workflowBinding.bindingRef,
      runtimeClassRef,
    };
    const sidecar = createSelfhostVersionBindingStore({ root: selfhostVersionBindingsRoot(root) });
    const stored = await sidecar.write(SCRIPT, VERSION, {
      workerResourceUid: WORKER_UID,
      workerVersionResourceUid: VERSION_UID,
      handlers: ["fetch"],
      vars: [],
      sensitiveVars: [],
      serviceBindings: [],
      workflowBindings: [binding],
    });
    if (!stored.eventToken) throw new Error("binding token source unavailable");
    await deployments.create({
      tenantId: TENANT,
      id: "deployment-version-integrated",
      resourceUid: VERSION_UID,
      offeringId: "offering-version",
      providerPackRef: PACK,
      providerInstallationRef: INSTALLATION,
      nativeId: `selfhost-version:${SCRIPT}:${VERSION}:operation-version`,
      state: "active",
      observed: { scriptName: SCRIPT, versionId: VERSION, workflowBindingsDigest: stored.digest },
      outputs: { scriptName: SCRIPT, versionId: VERSION },
    });
    const publication = {
      script: SCRIPT,
      workerResourceUid: WORKER_UID,
      versionId: VERSION,
      workerVersionResourceUid: VERSION_UID,
      snapshotDigest: stored.digest,
      bindings: [
        {
          publicName: "ORDERS",
          serviceName: "__TAKOSERVER_WORKFLOW_BINDING_00000",
          tenantId: TENANT,
          workflowResourceUid: WORKFLOW_UID,
          workflowFormRef: workflowForm.identity.formRef,
          bindingRef: workflowBinding.bindingRef,
          runtimeClassRef,
          token: deriveSelfhostWorkflowBindingToken({
            eventToken: stored.eventToken,
            workerVersionResourceUid: VERSION_UID,
            binding,
          }),
        },
      ],
    };
    const token = publication.bindings[0]?.token;
    if (!token) throw new Error("selected binding token unavailable");
    let nextId = 0;
    const openOwner = () =>
      createSelfhostWorkflowPrivateOwner({
        sql,
        clock,
        randomId: () => `generated-${++nextId}`,
        waitUntil: async () => {},
        runtimeRoot: root,
        guardBinary: "/unmounted-workflow-guard",
        workerdBinary: "/unmounted-workerd",
        maximumRegistrations: 1,
        providerPackRef: PACK,
        providerInstallationRef: INSTALLATION,
        basisPoint: () => 0,
      });
    const openManager = (currentOwner: ReturnType<typeof openOwner>) => {
      const resources = createTakoformStore(sql, clock, currentOwner.contribution);
      return openSelfhostWorkflowServing({
        dataRoot: root,
        socketParent: join(root, "sockets"),
        owner: currentOwner,
        graph: createWorkflowResourceGraphReader({ store: resources, form: workflowForm }),
        resources,
        deployments,
        providerPackRef: PACK,
        providerInstallationRef: INSTALLATION,
      });
    };
    const activate = async (current: Awaited<ReturnType<typeof openManager>>) => {
      await current.prepare([publication]);
      const lease = await current.reserve([publication]);
      current.activated([publication]);
      expect(current.isRestored()).toBe(true);
      const [socket] = current.sockets();
      if (!socket) throw new Error("selected Workflow socket unavailable");
      return { lease, socket };
    };
    const call = (socketPath: string, operation: string, body: object) =>
      fetch(`http://workflow.invalid/__takoserver/workflow-binding/v1/${operation}`, {
        method: "POST",
        unix: socketPath,
        headers: {
          "content-type": "application/json",
          "x-takoserver-private-workflow-binding-token": token,
        },
        body: JSON.stringify(body),
      });
    owner = openOwner();
    manager = await openManager(owner);
    const { lease, socket } = await activate(manager);
    expect(
      await (
        await call(socket.socketPath, "create", { id: "order-1", params: { amount: 7 } })
      ).json(),
    ).toEqual({
      schema: "takoserver.selfhost-workflow-binding-result@v1",
      value: { id: "order-1", status: "queued" },
    });
    expect(await (await call(socket.socketPath, "get", { id: "order-1" })).json()).toMatchObject({
      value: { id: "order-1" },
    });
    expect(await (await call(socket.socketPath, "status", { id: "order-1" })).json()).toMatchObject(
      { value: { status: "queued" } },
    );
    expect(
      await (
        await call(socket.socketPath, "sendEvent", { id: "order-1", type: "approved" })
      ).json(),
    ).toEqual({
      schema: "takoserver.selfhost-workflow-binding-result@v1",
      value: {},
    });
    holdEvent = true;
    const accepted = call(socket.socketPath, "sendEvent", {
      id: "order-1",
      type: "confirmed",
    }).catch(() => undefined);
    await eventEntered.promise;
    let settled = false;
    const closing = manager.close().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    eventRelease.resolve();
    await accepted; // A destroyed client socket need not receive its ACK.
    await closing;
    expect(manager.sockets()).toEqual([]);
    await expect(call(socket.socketPath, "create", { id: "order-2" })).rejects.toBeDefined();
    expect(await sql.query("SELECT type FROM tf_workflow_events ORDER BY event_id")).toEqual([
      { type: "approved" },
      { type: "confirmed" },
    ]);
    await lease.release();

    // Fresh handles over the same SQLite connection demonstrate durable
    // readback only. This is not an OS/process restart qualification.
    freshOwner = openOwner();
    restarted = await openManager(freshOwner);
    const fresh = await activate(restarted);
    expect(
      await (await call(fresh.socket.socketPath, "get", { id: "order-1" })).json(),
    ).toMatchObject({ value: { id: "order-1" } });
    expect(
      await (await call(fresh.socket.socketPath, "status", { id: "order-1" })).json(),
    ).toMatchObject({ value: { status: "queued" } });
    expect(
      await (await call(fresh.socket.socketPath, "terminate", { id: "order-1" })).json(),
    ).toEqual({
      schema: "takoserver.selfhost-workflow-binding-result@v1",
      value: {},
    });
    expect(
      await (await call(fresh.socket.socketPath, "status", { id: "order-1" })).json(),
    ).toMatchObject({ value: { status: "terminated" } });
    await fresh.lease.release();
  } finally {
    eventRelease.resolve();
    await restarted?.close();
    await manager?.close();
    await freshOwner?.close();
    await owner?.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
