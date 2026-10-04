import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { openSelfhostWorkflowBindingBroker } from "../src/selfhost-workflow-binding-broker.ts";
import {
  renderSelfhostWorkflowBindingRuntimeModuleSource,
  selfhostWorkflowBindingEntrypointSource,
} from "../src/selfhost-workflow-binding-worker-wrapper.ts";
import { createSelfhostWorkflowPrivateOwner } from "../src/selfhost-workflow-private-owner.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";

const NOW = Date.UTC(2026, 9, 4);
const TENANT = "tenant-binding-journey";
const WORKFLOW_UID = "workflow-binding-journey";
const WORKER_UID = "worker-binding-journey";
const VERSION_UID = "version-binding-journey";
const TOKEN = "a".repeat(64);
const SERVICE = "__TAKOSERVER_WORKFLOW_BINDING_00000";
const forms = forwardTakoformCandidates().forms;
type Deferred = ReturnType<typeof Promise.withResolvers<void>>;

function selectedForm(kind: string): InstalledTakoformForm {
  const form = forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!form) throw new Error(`unpublished ${kind} candidate unavailable`);
  return form;
}

async function insertLiveResource(
  sql: Sql,
  form: InstalledTakoformForm,
  uid: string,
  name: string,
  spec: Record<string, unknown>,
  relations: readonly Record<string, unknown>[] = [],
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
      canonicalJson(form.identity.formRef),
      NOW,
      NOW,
    ],
  );
}

async function fixture() {
  const db = new Database(":memory:");
  const root = mkdtempSync(join(tmpdir(), "workflow-binding-integrated-"));
  chmodSync(root, 0o700);
  const runtimeRoot = join(root, "runtime");
  migrateSqlite(db);
  const sqlite = createSqliteSql(db);
  let batchGate:
    | {
        readonly match: string;
        readonly entered: Deferred;
        readonly release: Deferred;
        readonly committed: Deferred;
      }
    | undefined;
  const sql: Sql = {
    ...sqlite,
    async batch(statements) {
      const gate = batchGate;
      if (gate && statements.some((statement) => statement.sql.includes(gate.match))) {
        batchGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
        const result = await sqlite.batch(statements);
        gate.committed.resolve();
        return result;
      }
      return sqlite.batch(statements);
    },
  };
  const workflow = selectedForm("DurableWorkflow");
  const worker = selectedForm("ModuleWorker");
  const version = selectedForm("WorkerVersion");
  const workerRelation = {
    pointer: "/worker",
    relation: "/worker",
    targetApiVersion: worker.identity.formRef.apiVersion,
    targetKind: "ModuleWorker",
    targetName: "worker",
    targetUid: WORKER_UID,
    targetRevision: "1",
    targetFormRef: worker.identity.formRef,
  };
  await insertLiveResource(sql, worker, WORKER_UID, "worker", {});
  await insertLiveResource(
    sql,
    workflow,
    WORKFLOW_UID,
    "workflow",
    {
      className: "OrdersWorkflow",
      worker: {
        apiVersion: worker.identity.formRef.apiVersion,
        kind: "ModuleWorker",
        name: "worker",
      },
    },
    [workerRelation],
  );
  await insertLiveResource(
    sql,
    version,
    VERSION_UID,
    "version",
    {
      bundle: { apiVersion: "edge.forms.takoform.com", kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch"],
      worker: {
        apiVersion: worker.identity.formRef.apiVersion,
        kind: "ModuleWorker",
        name: "worker",
      },
    },
    [workerRelation],
  );
  await createResourceDeploymentStore(sql, () => new Date(NOW)).create({
    tenantId: TENANT,
    id: "deployment-binding",
    resourceUid: WORKER_UID,
    offeringId: "offering-binding",
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
    nativeId: "selfhost-worker:worker-script:operation-binding",
    state: "active",
    observed: { scriptName: "worker-script" },
    outputs: { scriptName: "worker-script" },
  });
  const serving = createWorkerdRuntime({ root: runtimeRoot, isReady: () => true });
  if (!serving.publish) throw new Error("weighted publication unavailable");
  await serving.publish("worker-script", {
    generation: "generation-binding",
    workerResourceUid: WORKER_UID,
    hostnames: [],
    versions: [
      {
        versionId: "version-one",
        workerVersionUid: VERSION_UID,
        weight: 10_000,
        site: {
          directory: "worker-script",
          mainModule: "app.js",
          hostEntrypoint: "__host.js",
          hostnames: [],
          generation: "generation-binding",
          workerResourceUid: WORKER_UID,
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
  let nextId = 0;
  const owner = createSelfhostWorkflowPrivateOwner({
    sql,
    clock: () => new Date(NOW),
    randomId: () => `execution-${++nextId}`,
    waitUntil: async () => {
      throw new Error("no native execution expected");
    },
    runtimeRoot,
    guardBinary: "/unmounted-workflow-guard",
    workerdBinary: "/unmounted-workerd",
    maximumRegistrations: 1,
    providerPackRef: "selfhost-test-pack",
    providerInstallationRef: "selfhost-test-installation",
    basisPoint: () => 0,
  });
  const broker = await openSelfhostWorkflowBindingBroker({
    socketPath: join(root, "binding.sock"),
    token: TOKEN,
    scope: { tenantId: TENANT, workflowResourceUid: WORKFLOW_UID },
    instances: owner.instances,
  });
  writeFileSync(
    join(root, "workflow-runtime.mjs"),
    renderSelfhostWorkflowBindingRuntimeModuleSource(),
  );
  writeFileSync(
    join(root, "app.mjs"),
    "export default { async fetch() { return new Response('unused'); } };\n",
  );
  writeFileSync(
    join(root, selfhostWorkerPreludeModuleName("app.mjs")),
    selfhostWorkerPreludeSource(),
  );
  writeFileSync(
    join(root, "inner.mjs"),
    selfhostWorkerEntrypointSource({
      originalMainModule: "app.mjs",
      declaredHandlers: ["fetch"],
      // The selected Version graph declares Workflow names as ordinary projected
      // fields; the outer wrapper supplies the actual nested facade value.
      bindings: [{ name: "ORDERS", type: "json" }],
      publication: "workflow-binding-integration",
      probeHostname: "probe.example",
    }),
  );
  writeFileSync(
    join(root, "workflow-wrapper.mjs"),
    selfhostWorkflowBindingEntrypointSource({
      runtimeModule: "workflow-runtime.mjs",
      innerModule: "inner.mjs",
      bindings: [{ publicName: "ORDERS", serviceName: SERVICE, token: TOKEN }],
    }),
  );
  const wrapper = (await import(pathToFileURL(join(root, "workflow-wrapper.mjs")).href)) as {
    __takoserverSelfhostProjectEnv(rawEnv: Record<string, unknown>): Record<string, unknown>;
  };
  let lostRequest:
    | { readonly operation: "create" | "sendEvent"; readonly controller: AbortController }
    | undefined;
  const project = (socketPath: string) => {
    const rawEnv = {
      [SERVICE]: {
        fetch(request: Request) {
          const pending = lostRequest;
          if (pending && new URL(request.url).pathname.endsWith(`/${pending.operation}`)) {
            lostRequest = undefined;
            return fetch(request, { unix: socketPath, signal: pending.controller.signal });
          }
          return fetch(request, { unix: socketPath });
        },
      },
    };
    return wrapper.__takoserverSelfhostProjectEnv(rawEnv);
  };
  const projected = project(broker.socketPath);
  type Handle = {
    readonly id: string;
    status(): Promise<{
      readonly status: string;
      readonly error?: { readonly reason: string; readonly message?: string };
    }>;
    sendEvent(input: { readonly type: string; readonly payload?: unknown }): Promise<void>;
    terminate(): Promise<void>;
  };
  const binding = projected.ORDERS as {
    create(input: { readonly id?: string; readonly params?: unknown }): Promise<Handle>;
    get(id: string): Promise<Handle>;
  };
  return {
    binding,
    broker,
    owner,
    sql,
    root,
    project,
    projected,
    holdNextBatch(match: string) {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      batchGate = { match, entered, release, committed };
      return {
        entered: entered.promise,
        committed: committed.promise,
        release: () => release.resolve(),
      };
    },
    loseNext(operation: "create" | "sendEvent") {
      const controller = new AbortController();
      lostRequest = { operation, controller };
      return () => controller.abort();
    },
    async close() {
      await broker.close();
      await owner.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("generated Workflow facade reaches the real private owner through a Unix broker", async () => {
  const f = await fixture();
  try {
    expect(Object.keys(f.projected)).toEqual(["ORDERS"]);
    const created = await f.binding.create({ id: "order-1", params: { order: 7 } });
    expect(created.id).toBe("order-1");
    expect(await created.status()).toEqual({ status: "queued" });
    const lookedUp = await f.binding.get("order-1");
    expect(lookedUp.id).toBe("order-1");
    await lookedUp.sendEvent({ type: "approved", payload: { by: "owner" } });
    await lookedUp.terminate();
    expect(await created.status()).toEqual({ status: "terminated" });
  } finally {
    await f.close();
  }
});

test("the full generated facade returns a valid multibyte terminal error message", async () => {
  const f = await fixture();
  try {
    const instance = await f.binding.create({ id: "unicode-terminal" });
    const message = "😀".repeat(4_097);
    await f.sql.run(
      "UPDATE tf_workflow_instances SET status = 'errored', error_json = ? WHERE instance_id = ?",
      [JSON.stringify({ reason: "run_threw", message }), instance.id],
    );
    expect(await instance.status()).toEqual({
      status: "errored",
      error: { reason: "run_threw", message },
    });
  } finally {
    await f.close();
  }
});

test("same-process explicit get recovers an id after the generated facade loses its create reply", async () => {
  const f = await fixture();
  const gate = f.holdNextBatch("INSERT INTO tf_workflow_instances");
  try {
    const abortReply = f.loseNext("create");
    const lost = f.binding.create({ id: "recoverable", params: { order: 8 } });
    await gate.entered;
    abortReply();
    await expect(lost).rejects.toMatchObject({ name: "backend_unavailable" });
    gate.release();
    await gate.committed;
    await expect(f.binding.create({ id: "recoverable" })).rejects.toMatchObject({
      name: "instance_exists",
    });
    const recovered = await f.binding.get("recoverable");
    expect(recovered.id).toBe("recoverable");
    expect(await recovered.status()).toEqual({ status: "queued" });
    expect(
      await f.sql.query(
        "SELECT COUNT(*) AS count FROM tf_workflow_instances WHERE instance_id = ?",
        ["recoverable"],
      ),
    ).toEqual([{ count: 1 }]);
  } finally {
    gate.release();
    await f.close();
  }
});

test("a lost sendEvent reply is not retried and broker retirement drains SQL before owner close", async () => {
  const f = await fixture();
  const gate = f.holdNextBatch("INSERT INTO tf_workflow_events");
  try {
    const instance = await f.binding.create({ id: "event-once" });
    const abortReply = f.loseNext("sendEvent");
    const lost = instance.sendEvent({ type: "approved", payload: { by: "owner" } });
    await gate.entered;
    abortReply();
    await expect(lost).rejects.toMatchObject({ name: "backend_unavailable" });
    let handedOff = false;
    const handoff = (async () => {
      await f.broker.retire();
      await f.owner.close();
      handedOff = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handedOff).toBe(false);
    gate.release();
    await gate.committed;
    await handoff;
    expect(handedOff).toBe(true);
    expect(
      await f.sql.query("SELECT type, payload_json FROM tf_workflow_events WHERE instance_id = ?", [
        "event-once",
      ]),
    ).toEqual([{ type: "approved", payload_json: '{"by":"owner"}' }]);
  } finally {
    gate.release();
    await f.close();
  }
});

test("a generated binding on another fixed tenant or Workflow UID cannot observe an instance", async () => {
  const f = await fixture();
  try {
    expect((await f.binding.create({ id: "scoped" })).id).toBe("scoped");
    for (const [name, scope] of [
      ["other-tenant", { tenantId: "tenant-other", workflowResourceUid: WORKFLOW_UID }],
      ["other-workflow", { tenantId: TENANT, workflowResourceUid: "workflow-other" }],
    ] as const) {
      const other = await openSelfhostWorkflowBindingBroker({
        socketPath: join(f.root, `${name}.sock`),
        token: TOKEN,
        scope,
        instances: f.owner.instances,
      });
      try {
        const binding = f.project(other.socketPath).ORDERS as typeof f.binding;
        await expect(binding.get("scoped")).rejects.toMatchObject({ name: "backend_unavailable" });
        await expect(binding.create({ id: "scoped" })).rejects.toMatchObject({
          name: "backend_unavailable",
        });
      } finally {
        await other.close();
      }
    }
    expect(await (await f.binding.get("scoped")).status()).toEqual({ status: "queued" });
  } finally {
    await f.close();
  }
});
