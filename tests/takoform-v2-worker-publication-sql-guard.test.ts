import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { createWorkerPublicationSqlGuard } from "../src/takoform-v2/worker-publication-sql-guard.ts";

function fixture() {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const workerUid = "worker-1";
  const spec = { worker: { resourceUid: workerUid }, versions: [] };
  const operationId = "op-deployment-1";
  const resourceUid = "deployment-1";
  const leaseToken = "lease-1";
  const future = Date.now() + 60_000;
  db.query(
    `INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key, active_name,
       generation, observed_generation, phase, spec_json, last_operation)
     VALUES (?, 'org-1', ?, 'prod', 'worker', 'backend-1', 'target-1',
       'worker', 1, 1, 'idle', '{}', 'op-worker-1')`,
  ).run(workerUid, MODULE_WORKER_FORM_URL);
  db.query(
    `INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key, active_name,
       generation, phase, spec_json, last_operation, busy_operation)
     VALUES (?, 'org-1', ?, 'prod', 'deployment', 'backend-1', 'target-1',
       'deployment', 1, 'pending', ?, ?, ?)`,
  ).run(resourceUid, WORKER_DEPLOYMENT_FORM_URL, canonicalJson(spec), operationId, operationId);
  db.query(
    `INSERT INTO tf_v2_operations
      (id, resource_uid, principal, replay_key, request_fingerprint, action,
       generation, status, effect, created_at, updated_at, retain_until,
       backend_id, target_key, backend_key, accepted_spec_json, dispatch_possible,
       lease_token, lease_until_ms)
     VALUES (?, ?, 'org-1', ?, 'fingerprint', 'create', 1,
       'reconciling', 'unknown', '2026-10-06T12:00:00Z', '2026-10-06T12:00:00Z',
       '2026-10-07T12:00:00Z', 'backend-1', 'target-1', ?, ?, 1, ?, ?)`,
  ).run(
    operationId,
    resourceUid,
    operationId,
    operationId,
    canonicalJson(spec),
    leaseToken,
    future,
  );
  db.exec("CREATE TABLE test_routes (route_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("INSERT INTO test_routes VALUES ('route-1', 'old')");
  const own = db.query("SELECT * FROM tf_v2_resources WHERE uid = ?").get(resourceUid);
  const worker = db.query("SELECT * FROM tf_v2_resources WHERE uid = ?").get(workerUid);
  const op = db.query("SELECT * FROM tf_v2_operations WHERE id = ?").get(operationId);
  if (!own || !op || !worker) throw new Error("missing test SQL evidence");
  const execution: V2Execution = {
    operationId,
    leaseToken,
    backendKey: operationId,
    backendId: "backend-1",
    targetKey: "target-1",
    resourceUid,
    principal: "org-1",
    action: "create",
    generation: 1,
    form: WORKER_DEPLOYMENT_FORM_URL,
    space: "prod",
    name: "deployment",
    spec,
    previousObserved: {},
    previousOutput: {},
  };
  const guard = createWorkerPublicationSqlGuard({
    execution,
    workerUid,
    principal: "org-1",
    space: "prod",
    pendingIds: [operationId],
    deploymentIds: [resourceUid],
    endpointIds: [],
    inboundTargetIds: [workerUid, resourceUid],
    inboundEdges: [],
    referenceSetIds: [],
    evidence: { op, own, worker },
  });
  const statement = `UPDATE test_routes SET value = ? WHERE route_id = 'route-1' AND (${guard.sql})`;
  const update = (value: string) => sql.run(statement, [value, ...guard.params]);
  const route = () =>
    db.query("SELECT value FROM test_routes WHERE route_id = 'route-1'").get() as {
      value: string;
    };
  return { db, sql, guard, update, route, operationId, resourceUid, leaseToken, workerUid };
}

test("the captured SQL guard permits one same-statement route CAS and refuses stale lease", async () => {
  const f = fixture();
  try {
    expect(f.guard.params.length).toBeLessThanOrEqual(100);
    expect((await f.update("new")).changes).toBe(1);
    expect(f.route().value).toBe("new");
    f.db
      .query("UPDATE tf_v2_operations SET lease_token = ? WHERE id = ?")
      .run("reclaimed-lease", f.operationId);
    expect((await f.update("wrong")).changes).toBe(0);
    expect(f.route().value).toBe("new");
  } finally {
    f.db.close();
  }
});

test("a graph drift or newly accepted competing attachment is refused at route write time", async () => {
  const f = fixture();
  try {
    // The resolver's earlier read is not an authorization after this await.
    await Promise.resolve();
    f.db
      .query("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?")
      .run('{"unexpected":true}', f.resourceUid);
    expect((await f.update("wrong")).changes).toBe(0);
    f.db.query("UPDATE tf_v2_resources SET observed_json = '{}' WHERE uid = ?").run(f.resourceUid);
    const endpointSpec = canonicalJson({ worker: { resourceUid: f.workerUid } });
    f.db
      .query(
        `INSERT INTO tf_v2_resources
        (uid, principal, form_url, space, name, backend_id, target_key, active_name,
         generation, phase, spec_json, last_operation, busy_operation)
       VALUES ('endpoint-2', 'org-1', ?, 'prod', 'endpoint', 'backend-1', 'target-1',
         'endpoint', 1, 'pending', ?, 'op-endpoint-2', 'op-endpoint-2')`,
      )
      .run(WORKER_ENDPOINT_FORM_URL, endpointSpec);
    expect((await f.update("wrong")).changes).toBe(0);
    expect(f.route().value).toBe("old");
  } finally {
    f.db.close();
  }
});

test("a new incoming reference edge is a phantom graph change even if known rows remain exact", async () => {
  const f = fixture();
  try {
    f.db
      .query("INSERT INTO tf_v2_resource_references (target_uid, referrer_uid) VALUES (?, ?)")
      .run(f.workerUid, f.resourceUid);
    expect((await f.update("wrong")).changes).toBe(0);
    expect(f.route().value).toBe("old");
  } finally {
    f.db.close();
  }
});

test("an atomic SQL batch rolls back the guarded route mutation on a later failure", async () => {
  const f = fixture();
  try {
    await expect(
      f.sql.batch([
        {
          sql: `UPDATE test_routes SET value = 'new' WHERE route_id = 'route-1' AND (${f.guard.sql})`,
          params: f.guard.params,
        },
        { sql: "INSERT INTO test_routes VALUES ('route-1', 'duplicate')" },
      ]),
    ).rejects.toThrow();
    expect(f.route().value).toBe("old");
    expect((await f.update("new")).changes).toBe(1);
    expect(f.route().value).toBe("new");
  } finally {
    f.db.close();
  }
});
