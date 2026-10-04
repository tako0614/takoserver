import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformHost } from "../src/takoform/host.ts";
import type { TakoformHostAuthority } from "../src/takoform/host-authority.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { InstalledTakoformForm, TakoformHost } from "../src/takoform/types.ts";
import { createWorkflowRuntime, type WorkflowExecutionHost } from "../src/workflow-execution.ts";
import {
  createWorkflowResourceDeletionContribution,
  type WorkflowResourceDeletionContribution,
} from "../src/workflow-resource-lifecycle.ts";

const LANE = "/apis/forms.takoform.com/v1";
const START = Date.UTC(2026, 9, 3);
const TENANT = "tenant-a";
const WORKFLOW_INTERFACE_REF = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.workflow",
  version: "3.0.0",
  schemaDigest: "sha256:2584721b4bc9f5feef94b272337c348fb67130de57317afaf84aa7ca55246f69",
} as const;
const FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "DurableWorkflow",
  definitionVersion: "0.2.0",
  schemaDigest: "sha256:a58c885bed4431fbdc6b923059fe3b3bf98f7727578914d2d212552ae97fdc65",
} as const;
const FORM: InstalledTakoformForm = {
  identity: {
    formRef: FORM_REF,
    packageDigest: `sha256:${"b".repeat(64)}`,
    implementationDigest: `sha256:${"c".repeat(64)}`,
  },
  desiredSchema: { type: "object", properties: {}, additionalProperties: false },
  operations: ["create", "read", "delete"],
};

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

interface Fixture {
  readonly sql: Sql;
  readonly host: TakoformHost;
  readonly contribution: WorkflowResourceDeletionContribution;
  readonly runtime: ReturnType<typeof createWorkflowRuntime>;
  readonly driver: InMemoryTakoformResourceDriver;
  setNow(value: number): void;
  setStopOutcome(value: "stopped" | Error): void;
  stopCalls(): number;
  setBeforeBatch(callback: (statements: readonly SqlStatement[]) => Promise<void>): void;
}

/**
 * Public Host router/engine/store and Workflow runtime use one real SQLite
 * adapter. The authority and stop/deadline Host are declared protocol doubles:
 * this is source contract coverage, not native workerd/WfP qualification.
 */
function fixture(options: { readonly deferDelete?: boolean } = {}): Fixture {
  const db = new Database(":memory:");
  databases.push(db);
  migrateSqlite(db);
  const databaseSql = createSqliteSql(db);
  let beforeBatch: (statements: readonly SqlStatement[]) => Promise<void> = async () => {};
  const sql: Sql = {
    query: (statement, params) => databaseSql.query(statement, params),
    run: (statement, params) => databaseSql.run(statement, params),
    batch: async (statements) => {
      await beforeBatch(statements);
      return databaseSql.batch(statements);
    },
  };
  const contribution = createWorkflowResourceDeletionContribution(sql, FORM_REF);
  let timestamp = START;
  let next = 0;
  let stopOutcome: "stopped" | Error = new Error("unexpected protocol stop");
  let stopped = 0;
  const clock = () => new Date(timestamp);
  const driver = new InMemoryTakoformResourceDriver();
  const availability = {
    executable: true,
    activated: true,
    availableToPrincipal: true,
  };
  // The test keeps public routing and durable writes real while supplying an
  // unpublished Form as a synthetic authority; no publisher event is minted.
  const authority = {
    async catalog() {
      return {
        forms: [
          { form: FORM, supported: true, availability, headDigest: `sha256:${"d".repeat(64)}` },
        ],
        bindings: [],
      };
    },
    async supportCatalog() {
      return { forms: [], bindings: [] };
    },
    async authorizeMutation() {
      return { form: FORM };
    },
    async authorizeRetained() {
      return { form: FORM };
    },
  } as unknown as TakoformHostAuthority;
  const host = createTakoformHost({
    sql,
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: TENANT, principalId: "principal-a" }),
    forms: [FORM],
    driver,
    authority,
    clock,
    randomId: () => `host-id-${++next}`,
    workflowResourceDeletion: contribution,
    ...(options.deferDelete
      ? {
          deferredOperations: {
            shouldDefer: ({ operation }: { readonly operation: string }) => operation === "delete",
            pollsBeforeCommit: 1,
            retryAfterSeconds: 0,
            executeOnAccept: true,
          },
        }
      : {}),
  });
  const protocolHost: WorkflowExecutionHost = {
    async openPaused() {
      throw new Error("this scenario must not start application execution");
    },
    async stop() {
      stopped += 1;
      if (stopOutcome instanceof Error) throw stopOutcome;
      return stopOutcome;
    },
  };
  const runtime = createWorkflowRuntime({
    sql,
    clock,
    randomId: () => `workflow-id-${++next}`,
    waitUntil: async () => {
      throw new Error("this scenario must not wait for a deadline");
    },
    host: protocolHost,
    workflowInterfaceRef: WORKFLOW_INTERFACE_REF,
    workflowResourceDeletion: contribution,
  });
  return {
    sql,
    host,
    contribution,
    runtime,
    driver,
    setNow(value) {
      timestamp = value;
    },
    setStopOutcome(value) {
      stopOutcome = value;
    },
    stopCalls() {
      return stopped;
    },
    setBeforeBatch(callback) {
      beforeBatch = callback;
    },
  };
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function resource(name: string) {
  return {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF, packageDigest: FORM.identity.packageDigest },
    metadata: { name, space: "main" },
    spec: {},
  };
}

function path(name: string): string {
  return `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/${name}`;
}

function query(name: string): string {
  return `${path(name)}?${new URLSearchParams({
    space: "main",
    definitionVersion: FORM_REF.definitionVersion,
    schemaDigest: FORM_REF.schemaDigest,
  })}`;
}

async function request(
  host: TakoformHost,
  method: string,
  target: string,
  body?: unknown,
  headers?: HeadersInit,
) {
  const response = await host.handle(
    new Request(`https://host.invalid${target}`, {
      method,
      headers: {
        authorization: "Bearer workflow-test",
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  if (!response) throw new Error("public Host route was not handled");
  return response;
}

async function createResource(
  f: Fixture,
  name: string,
  key = `create-${name}-0001`,
): Promise<string> {
  const prepared = await request(f.host, "POST", `${LANE}/resources/prepare`, resource(name));
  expect(prepared.status).toBe(200);
  const review = (await prepared.json()) as { readonly review: Record<string, string> };
  const created = await request(
    f.host,
    "PUT",
    path(name),
    { ...resource(name), review: review.review },
    { "idempotency-key": key, "if-none-match": "*" },
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as { readonly metadata: { readonly uid: string } };
  return body.metadata.uid;
}

async function remove(f: Fixture, name: string, key: string): Promise<Response> {
  return request(f.host, "DELETE", query(name), undefined, {
    "idempotency-key": key,
    "takoform-expected-generation": "1",
  });
}

async function count(sql: Sql, table: string, tenant: string, uid: string): Promise<number> {
  const rows = await sql.query(
    `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ? AND workflow_resource_uid = ?`,
    [tenant, uid],
  );
  return Number(rows[0]?.count);
}

test("active Workflow identity refuses DELETE without side effects; explicit terminate then DELETE purges its UID", async () => {
  const f = fixture();
  const uid = await createResource(f, "orders");
  const scope = { tenantId: TENANT, workflowResourceUid: uid };
  await f.runtime.instances.create(scope, { id: "order-1" });
  const refused = await remove(f, "orders", "delete-orders-0001");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "dependency_in_use" } });
  expect(await count(f.sql, "tf_workflow_instances", TENANT, uid)).toBe(1);
  const before = await f.sql.query(
    "SELECT state FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
    [TENANT, uid],
  );
  expect(before).toEqual([{ state: "live" }]);
  await f.runtime.instances.terminate(scope, "order-1");
  expect(await f.runtime.instances.status(scope, "order-1")).toEqual({ status: "terminated" });
  const deleted = await remove(f, "orders", "delete-orders-0002");
  expect(deleted.status).toBe(204);
  expect(await count(f.sql, "tf_workflow_instances", TENANT, uid)).toBe(0);
  expect(await count(f.sql, "tf_workflow_events", TENANT, uid)).toBe(0);
  expect(await count(f.sql, "tf_workflow_steps", TENANT, uid)).toBe(0);
  expect((await request(f.host, "GET", query("orders"))).status).toBe(404);
  expect(
    await f.sql.query(
      "SELECT state FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, uid],
    ),
  ).toEqual([{ state: "closed" }]);
});

test("failed physical-stop acknowledgement keeps the owner and DELETE blocked until exact recovery", async () => {
  const f = fixture();
  const uid = await createResource(f, "stop-recovery");
  const scope = { tenantId: TENANT, workflowResourceUid: uid };
  await f.runtime.instances.create(scope, { id: "run-1" });
  await f.sql.run(
    "UPDATE tf_workflow_instances SET status = 'running', run_epoch = 1, run_owner = 'owner-1', run_lease_until = ? WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?",
    [START + 60_000, TENANT, uid, "run-1"],
  );
  f.setStopOutcome(new Error("protocol stop could not prove physical shutdown"));
  await expect(f.runtime.instances.terminate(scope, "run-1")).rejects.toThrow();
  expect(f.stopCalls()).toBe(1);
  expect(
    await f.sql.query(
      "SELECT status, run_owner, termination_requested FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = ?",
      [TENANT, uid],
    ),
  ).toEqual([{ status: "running", run_owner: "owner-1", termination_requested: 1 }]);
  expect((await remove(f, "stop-recovery", "delete-stop-recovery-0001")).status).toBe(409);
  f.setStopOutcome("stopped");
  await f.runtime.instances.terminate(scope, "run-1");
  expect(f.stopCalls()).toBe(2);
  expect(
    await f.sql.query(
      "SELECT status, run_owner, run_lease_until, termination_requested FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = ?",
      [TENANT, uid],
    ),
  ).toEqual([
    {
      status: "terminated",
      run_owner: null,
      run_lease_until: null,
      termination_requested: 0,
    },
  ]);
  expect((await remove(f, "stop-recovery", "delete-stop-recovery-0002")).status).toBe(204);
});

test("the same Sql serializes create and DELETE in either order without orphaned histories", async () => {
  const first = fixture();
  const firstUid = await createResource(first, "race-create-loses");
  const createEntered = latch();
  const releaseCreate = latch();
  first.setBeforeBatch(async (statements) => {
    if (statements.some((entry) => entry.sql.includes("INSERT INTO tf_workflow_instances"))) {
      createEntered.release();
      await releaseCreate.promise;
    }
  });
  const lateCreate = first.runtime.instances.create(
    { tenantId: TENANT, workflowResourceUid: firstUid },
    { id: "late" },
  );
  await createEntered.promise;
  expect((await remove(first, "race-create-loses", "delete-race-create-loses-0001")).status).toBe(
    204,
  );
  releaseCreate.release();
  await expect(lateCreate).rejects.toMatchObject({ code: "unknown_instance" });
  expect(await count(first.sql, "tf_workflow_instances", TENANT, firstUid)).toBe(0);

  const second = fixture();
  const secondUid = await createResource(second, "race-delete-loses");
  const prepareEntered = latch();
  const releasePrepare = latch();
  second.setBeforeBatch(async (statements) => {
    if (
      statements.some((entry) =>
        entry.sql.includes("INSERT OR IGNORE INTO tf_resource_deletion_attestations"),
      )
    ) {
      prepareEntered.release();
      await releasePrepare.promise;
    }
  });
  const lateDelete = remove(second, "race-delete-loses", "delete-race-delete-loses-0001");
  await prepareEntered.promise;
  await second.runtime.instances.create(
    { tenantId: TENANT, workflowResourceUid: secondUid },
    { id: "winner" },
  );
  releasePrepare.release();
  const refused = await lateDelete;
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "dependency_in_use" } });
  expect(await count(second.sql, "tf_workflow_instances", TENANT, secondUid)).toBe(1);
  expect(
    await second.sql.query(
      "SELECT state FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, secondUid],
    ),
  ).toEqual([{ state: "live" }]);
});

test("a live Workflow Binding holder refuses side-effect-free DELETE until explicitly unbound", async () => {
  const f = fixture();
  const uid = await createResource(f, "bound-orders");
  // This row models the stored WorkerVersion Binding relation. The public
  // DELETE still exercises the real Host relation-holder guard and batch.
  await f.sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, relations_json, updated_at)
     VALUES (?, 'main', 'edge.forms.takoform.com', 'WorkerVersion', 'bound-version',
             'binding-holder-uid', '1', '1', '{}', ?, ?)`,
    [TENANT, JSON.stringify([{ targetUid: uid }]), START],
  );
  const refused = await remove(f, "bound-orders", "delete-bound-orders-0001");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: {
      code: "dependency_in_use",
      details: {
        dependencyKind: "workflow_binding",
        holder: "edge.forms.takoform.com/WorkerVersion/bound-version",
      },
    },
  });
  expect(
    await f.sql.query(
      "SELECT state FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, uid],
    ),
  ).toEqual([{ state: "live" }]);
  await f.sql.run("DELETE FROM tf_resources WHERE tenant_id = ? AND uid = 'binding-holder-uid'", [
    TENANT,
  ]);
  expect((await remove(f, "bound-orders", "delete-bound-orders-0002")).status).toBe(204);
});

test("deferred final commit closes the exact tombstone and purges terminal history in the same batch", async () => {
  const f = fixture({ deferDelete: true });
  const uid = await createResource(f, "deferred-orders");
  const scope = { tenantId: TENANT, workflowResourceUid: uid };
  await f.runtime.instances.create(scope, { id: "retained" });
  await f.runtime.instances.sendEvent(scope, "retained", { type: "signal", payload: { value: 1 } });
  await f.sql.run(
    "UPDATE tf_workflow_instances SET status = 'complete' WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?",
    [TENANT, uid, "retained"],
  );
  expect(await count(f.sql, "tf_workflow_events", TENANT, uid)).toBe(1);
  const deleted = await remove(f, "deferred-orders", "delete-deferred-orders-0001");
  expect(deleted.status).toBe(204);
  expect(
    await f.sql.query(
      "SELECT phase FROM tf_deferred_operations_selection_v1 WHERE tenant_id = ? AND operation = 'delete'",
      [TENANT],
    ),
  ).toEqual([{ phase: "succeeded" }]);
  expect(await count(f.sql, "tf_workflow_instances", TENANT, uid)).toBe(0);
  expect(await count(f.sql, "tf_workflow_events", TENANT, uid)).toBe(0);
  expect(
    await f.sql.query(
      "SELECT state FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, uid],
    ),
  ).toEqual([{ state: "closed" }]);
});

test("an unclosed selected tombstone cannot commit Resource deletion without terminal purge", async () => {
  const f = fixture();
  const uid = await createResource(f, "open-effect");
  const scope = { tenantId: TENANT, workflowResourceUid: uid };
  await f.runtime.instances.create(scope, { id: "retained" });
  await f.runtime.instances.terminate(scope, "retained");
  const originalDelete = f.driver.delete.bind(f.driver);
  f.driver.delete = async (input) => {
    const store = createTakoformStore(f.sql, () => new Date(START), f.contribution);
    expect(
      await store.recordResourceEffect({
        tenantId: TENANT,
        resourceUid: uid,
        effectId: "unsettled-foreign-effect",
        kind: "apply",
        phase: "planned",
        operationMode: "initial",
      }),
    ).toBe(true);
    await originalDelete(input);
  };
  const result = await remove(f, "open-effect", "delete-open-effect-0001");
  expect(result.status).not.toBe(204);
  expect(await count(f.sql, "tf_workflow_instances", TENANT, uid)).toBe(1);
  expect(
    await f.sql.query(
      "SELECT state FROM tf_resource_deletion_attestations WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, uid],
    ),
  ).toEqual([{ state: "pending" }]);
  expect(
    await f.sql.query("SELECT uid FROM tf_resources WHERE tenant_id = ? AND uid = ?", [
      TENANT,
      uid,
    ]),
  ).toEqual([{ uid }]);
});

test("terminal owner metadata blocks only until its qualified hard lease expires", async () => {
  const f = fixture();
  const uid = await createResource(f, "orphan-owner");
  const scope = { tenantId: TENANT, workflowResourceUid: uid };
  await f.runtime.instances.create(scope, { id: "ended" });
  await f.sql.run(
    "UPDATE tf_workflow_instances SET status = 'complete', run_epoch = 1, run_owner = 'lost-controller', run_lease_until = ?, termination_requested = 1 WHERE tenant_id = ? AND workflow_resource_uid = ?",
    [START + 5_000, TENANT, uid],
  );
  expect((await remove(f, "orphan-owner", "delete-orphan-owner-0001")).status).toBe(409);
  f.setNow(START + 5_001);
  expect((await remove(f, "orphan-owner", "delete-orphan-owner-0002")).status).toBe(204);
  expect(await count(f.sql, "tf_workflow_instances", TENANT, uid)).toBe(0);
});

test("terminal ownerless history passes immediately and an owner passes at the exact lease boundary", async () => {
  const f = fixture();
  const ownerlessUid = await createResource(f, "ownerless");
  await f.runtime.instances.create(
    { tenantId: TENANT, workflowResourceUid: ownerlessUid },
    { id: "ended" },
  );
  await f.sql.run(
    "UPDATE tf_workflow_instances SET status = 'complete' WHERE tenant_id = ? AND workflow_resource_uid = ?",
    [TENANT, ownerlessUid],
  );
  expect((await remove(f, "ownerless", "delete-ownerless-0001")).status).toBe(204);
  const uid = await createResource(f, "owner-boundary");
  await f.runtime.instances.create({ tenantId: TENANT, workflowResourceUid: uid }, { id: "ended" });
  await f.sql.run(
    "UPDATE tf_workflow_instances SET status = 'complete', run_owner = 'lost-controller', run_lease_until = ? WHERE tenant_id = ? AND workflow_resource_uid = ?",
    [START, TENANT, uid],
  );
  expect((await remove(f, "owner-boundary", "delete-owner-boundary-0001")).status).toBe(204);
});

test("contribution requires the exact selected FormRef and the identical Sql object", () => {
  const f = fixture();
  const differentSql: Sql = { ...f.sql };
  expect(() =>
    createWorkflowResourceDeletionContribution(f.sql, {
      ...FORM_REF,
      schemaDigest: `sha256:${"0".repeat(64)}`,
    }),
  ).toThrow(TypeError);
  expect(() =>
    createTakoformHost({
      sql: differentSql,
      objects: createMemoryObjectStore(),
      authenticate: async () => ({ tenantId: TENANT, principalId: "principal-a" }),
      forms: [FORM],
      driver: f.driver,
      authority: {} as TakoformHostAuthority,
      workflowResourceDeletion: f.contribution,
    }),
  ).toThrow("belongs to another Sql");
  expect(() =>
    createWorkflowRuntime({
      sql: differentSql,
      clock: () => new Date(START),
      randomId: () => "unused",
      waitUntil: async () => {},
      host: {
        async openPaused() {
          throw new Error("unused");
        },
        async stop() {
          return "stopped";
        },
      },
      workflowInterfaceRef: WORKFLOW_INTERFACE_REF,
      workflowResourceDeletion: f.contribution,
    }),
  ).toThrow("belongs to another Sql");
});

test("DELETE purges only its tenant and UID; recreating the name starts a new empty incarnation", async () => {
  const f = fixture();
  const oldUid = await createResource(f, "reused-name");
  const oldScope = { tenantId: TENANT, workflowResourceUid: oldUid };
  await f.runtime.instances.create(oldScope, { id: "same-public-id" });
  await f.runtime.instances.terminate(oldScope, "same-public-id");
  // A foreign tenant with the same opaque UID cannot be reached by this
  // Host's deletion; the synthetic row isolates the SQL purge predicate.
  await f.sql.run(
    `INSERT INTO tf_workflow_instances
       (tenant_id, workflow_resource_uid, instance_id, execution_id, params_json, status,
        output_json, error_json, created_at, updated_at, deadline_at,
        retention_until, revision)
     SELECT 'tenant-b', workflow_resource_uid, 'foreign', 'foreign-execution',
            NULL, 'complete', NULL, NULL, created_at, updated_at, deadline_at,
            retention_until, 1
     FROM tf_workflow_instances
     WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?`,
    [TENANT, oldUid, "same-public-id"],
  );
  expect((await remove(f, "reused-name", "delete-reused-name-0001")).status).toBe(204);
  expect(await count(f.sql, "tf_workflow_instances", TENANT, oldUid)).toBe(0);
  expect(await count(f.sql, "tf_workflow_instances", "tenant-b", oldUid)).toBe(1);
  const newUid = await createResource(f, "reused-name", "create-reused-name-0002");
  expect(newUid).not.toBe(oldUid);
  const newScope = { tenantId: TENANT, workflowResourceUid: newUid };
  await expect(f.runtime.instances.get(newScope, "same-public-id")).rejects.toMatchObject({
    code: "unknown_instance",
  });
  expect(await f.runtime.instances.create(newScope, { id: "same-public-id" })).toEqual({
    id: "same-public-id",
    status: "queued",
  });
  expect(await count(f.sql, "tf_workflow_instances", TENANT, newUid)).toBe(1);
  expect(await count(f.sql, "tf_workflow_instances", "tenant-b", oldUid)).toBe(1);
});
