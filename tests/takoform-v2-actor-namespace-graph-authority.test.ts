import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2ActorNamespaceGraphAuthority } from "../src/takoform-v2/actor-namespace-graph-authority.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/actor-namespace.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { WorkerdActiveActorGraph, WorkerdActorForwardSocket } from "../src/workerd-runtime.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

const PRINCIPAL = "org:actor-authority-test";
const SPACE = "production";
const TARGET = "actor-authority-target";
const WORKER = "worker-actor-authority";
const NAMESPACE = "namespace-actor-authority";
const CREATE_WORKER = "85a3ff88-8c24-4802-91b5-861e134546dd";
const CREATE_NAMESPACE = "f63bc8f8-880c-4d06-83a1-cc82403979f2";
const CREATE_DEPLOYMENT = "d76bbd33-87e9-42ec-902d-c0c15097e530";
const DELETE_NAMESPACE = "4a925f71-b1ab-4abd-b9b0-d9850aca4e6d";
const UPDATE_NAMESPACE = "a1e4cc39-30bd-4734-83b7-0674e7bda664";

function fixture(options: { namespaceReferences?: boolean } = {}) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const insert = (input: {
    uid: string;
    name: string;
    form: string;
    operationId: string;
    spec: object;
    observed?: object;
  }) => {
    const specJson = JSON.stringify(input.spec);
    db.query(
      `INSERT INTO tf_v2_resources
       (uid, principal, form_url, space, name, backend_id, target_key,
        active_name, generation, observed_generation, phase, spec_json,
        observed_json, last_operation, busy_operation)
       VALUES (?, ?, ?, ?, ?, 'actor-fixture-backend', ?, ?, 1, 0, 'pending', ?, '{}', ?, ?)`,
    ).run(
      input.uid,
      PRINCIPAL,
      input.form,
      SPACE,
      input.name,
      TARGET,
      input.name,
      specJson,
      input.operationId,
      input.operationId,
    );
    db.query(
      `INSERT INTO tf_v2_operations
       (id, resource_uid, principal, replay_key, request_fingerprint,
        action, generation, status, effect, created_at, updated_at,
        retain_until, backend_id, target_key, backend_key, accepted_spec_json)
       VALUES (?, ?, ?, ?, 'fingerprint', 'create', 1, 'queued', 'none',
         '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z', '2027-10-07T00:00:00Z',
         'actor-fixture-backend', ?, ?, ?)`,
    ).run(
      input.operationId,
      input.uid,
      PRINCIPAL,
      `replay-${input.uid}`,
      TARGET,
      `backend-${input.uid}`,
      specJson,
    );
    if (input.form === ACTOR_NAMESPACE_FORM_URL && options.namespaceReferences !== false) {
      db.query("INSERT INTO tf_v2_operation_reference_sets (operation_id) VALUES (?)").run(
        input.operationId,
      );
      db.query(
        `INSERT INTO tf_v2_operation_references
         (operation_id, target_uid, form_url, readiness)
         VALUES (?, ?, ?, 'observed')`,
      ).run(input.operationId, WORKER, MODULE_WORKER_FORM_URL);
      db.query("UPDATE tf_v2_operation_reference_sets SET sealed = 1 WHERE operation_id = ?").run(
        input.operationId,
      );
    }
    db.query("UPDATE tf_v2_operations SET status = 'running' WHERE id = ?").run(input.operationId);
    db.query(
      "UPDATE tf_v2_operations SET status = 'reconciling', effect = 'unknown' WHERE id = ?",
    ).run(input.operationId);
    db.query(
      `UPDATE tf_v2_operations SET status = 'succeeded', effect = 'complete',
       result_observed_json = ? WHERE id = ?`,
    ).run(JSON.stringify(input.observed ?? {}), input.operationId);
  };
  insert({
    uid: WORKER,
    name: WORKER,
    form: MODULE_WORKER_FORM_URL,
    operationId: CREATE_WORKER,
    spec: {},
  });
  insert({
    uid: NAMESPACE,
    name: NAMESPACE,
    form: ACTOR_NAMESPACE_FORM_URL,
    operationId: CREATE_NAMESPACE,
    spec: { worker: { resourceUid: WORKER }, className: "CounterActor" },
    observed: {
      ready: false,
      activeActorCount: 0,
      pendingAlarmCount: 0,
      openSocketCount: 0,
    },
  });
  return { db, sql, insert };
}

test("v2 Actor graph refuses an accepted Namespace without its sealed Worker reference and active edge", async () => {
  const scope = { tenantId: PRINCIPAL, namespaceResourceUid: NAMESPACE };
  const missing = fixture({ namespaceReferences: false });
  try {
    const authority = createV2ActorNamespaceGraphAuthority({
      sql: missing.sql,
      targetKey: TARGET,
      owner: { ownerForWorker: async () => null },
    });
    expect(await authority.readGraph(scope, AbortSignal.timeout(1000))).toBeNull();
  } finally {
    missing.db.close();
  }

  const lostEdge = fixture();
  try {
    lostEdge.db
      .query("DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?")
      .run(NAMESPACE, WORKER);
    const authority = createV2ActorNamespaceGraphAuthority({
      sql: lostEdge.sql,
      targetKey: TARGET,
      owner: { ownerForWorker: async () => null },
    });
    expect(await authority.readGraph(scope, AbortSignal.timeout(1000))).toBeNull();
  } finally {
    lostEdge.db.close();
  }
});

test("held Namespace PUT has an exact private graph without opening ordinary busy delivery", async () => {
  const f = fixture();
  const scope = { tenantId: PRINCIPAL, namespaceResourceUid: NAMESPACE };
  const authority = createV2ActorNamespaceGraphAuthority({
    sql: f.sql,
    targetKey: TARGET,
    owner: { ownerForWorker: async () => null },
  });
  try {
    const before = await authority.readGraph(scope, AbortSignal.timeout(1000));
    expect(before).not.toBeNull();
    const spec = JSON.stringify({ worker: { resourceUid: WORKER }, className: "CounterActor" });
    const leaseToken = "a".repeat(64);
    f.db
      .query(
        `INSERT INTO tf_v2_operations
       (id, resource_uid, principal, replay_key, request_fingerprint,
        action, generation, status, effect, created_at, updated_at,
        retain_until, backend_id, target_key, backend_key, accepted_spec_json)
       VALUES (?, ?, ?, 'update-replay', 'update-fingerprint', 'update', 2,
         'queued', 'none', '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z',
         '2027-10-07T00:00:00Z', 'actor-fixture-backend', ?, 'update-backend', ?)`,
      )
      .run(UPDATE_NAMESPACE, NAMESPACE, PRINCIPAL, TARGET, spec);
    f.db
      .query(
        `UPDATE tf_v2_resources SET generation = 2, phase = 'pending',
       busy_operation = ?, last_operation = ? WHERE uid = ?`,
      )
      .run(UPDATE_NAMESPACE, UPDATE_NAMESPACE, NAMESPACE);
    f.db
      .query("INSERT INTO tf_v2_operation_reference_sets (operation_id) VALUES (?)")
      .run(UPDATE_NAMESPACE);
    f.db
      .query(
        `INSERT INTO tf_v2_operation_references
       (operation_id, target_uid, form_url, readiness)
       VALUES (?, ?, ?, 'observed')`,
      )
      .run(UPDATE_NAMESPACE, WORKER, MODULE_WORKER_FORM_URL);
    f.db
      .query("UPDATE tf_v2_operation_reference_sets SET sealed = 1 WHERE operation_id = ?")
      .run(UPDATE_NAMESPACE);
    f.db.query("UPDATE tf_v2_operations SET status = 'running' WHERE id = ?").run(UPDATE_NAMESPACE);
    f.db
      .query(
        `UPDATE tf_v2_operations SET status = 'reconciling', effect = 'unknown',
       dispatch_possible = 1, lease_token = ?, lease_until_ms = ? WHERE id = ?`,
      )
      .run(leaseToken, Date.now() + 60_000, UPDATE_NAMESPACE);
    expect(await authority.readGraph(scope, AbortSignal.timeout(1000))).toBeNull();
    expect(
      await authority.readAcceptedOperationGraph(scope, {
        operationId: UPDATE_NAMESPACE,
        leaseToken: "b".repeat(64),
      }),
    ).toBeNull();
    const held = await authority.readAcceptedOperationGraph(scope, {
      operationId: UPDATE_NAMESPACE,
      leaseToken,
    });
    expect(held).toMatchObject({ scope, workerUid: WORKER, className: "CounterActor" });
    f.db
      .query("DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?")
      .run(NAMESPACE, WORKER);
    expect(
      await authority.readAcceptedOperationGraph(scope, {
        operationId: UPDATE_NAMESPACE,
        leaseToken,
      }),
    ).toBeNull();
  } finally {
    f.db.close();
  }
});

const graph: WorkerdActiveActorGraph = {
  generation: `takoserver-v2-operation:${CREATE_DEPLOYMENT}`,
  generationKey: "a".repeat(64),
  workerResourceUid: WORKER,
  versions: [
    {
      versionId: "v2-version-1",
      workerVersionUid: "version-1",
      variantKey: "version-1",
      weight: 10_000,
      site: { directory: "v2-worker", mainModule: "index.mjs", hostnames: [] },
      modules: new Map([["index.mjs", new TextEncoder().encode("export class CounterActor {}")]]),
      hostModules: new Map(),
    },
  ],
};

test("v2 Actor authority reads accepted Namespace SQL and never substitutes v1 Deployment", async () => {
  const f = fixture();
  let nativeReads = 0;
  let actorForwardSockets: readonly WorkerdActorForwardSocket[] = [];
  const owner: Pick<
    WorkerdWorkerRuntimeOwner,
    "workerResourceUid" | "observeServing" | "observeActorGraph"
  > = {
    workerResourceUid: WORKER,
    async observeServing() {
      return {
        kind: "serving",
        workerResourceUid: WORKER,
        targetKey: TARGET,
        sourceOperationId: CREATE_DEPLOYMENT,
        generation: graph.generation,
        hostnames: [],
        versions: [{ workerVersionUid: "version-1", weight: 10_000 }],
      };
    },
    async observeActorGraph() {
      nativeReads += 1;
      return {
        kind: "ready",
        sourceOperationId: CREATE_DEPLOYMENT,
        incarnationId: CREATE_DEPLOYMENT,
        script: "v2-worker-private",
        identity: {
          generation: graph.generation,
          workerResourceUid: WORKER,
          hostnames: [],
          versions: [{ versionId: "v2-version-1", workerVersionUid: "version-1", weight: 10_000 }],
        },
        graph,
        actorForwardSockets,
      };
    },
  };
  let selectedOwner = owner;
  const authority = createV2ActorNamespaceGraphAuthority({
    sql: f.sql,
    targetKey: TARGET,
    owner: { ownerForWorker: async () => selectedOwner },
  });
  const scope = { tenantId: PRINCIPAL, namespaceResourceUid: NAMESPACE };
  try {
    const accepted = await authority.readGraph(scope, AbortSignal.timeout(1000));
    expect(accepted).toMatchObject({
      scope,
      workerUid: WORKER,
      className: "CounterActor",
    });
    if (!accepted) throw new Error("accepted v2 namespace missing");
    expect(await authority.hasNamespaceAuthority(scope, AbortSignal.timeout(1000))).toBe(true);
    expect(await authority.hasRealization(accepted)).toBe(false);
    expect(await authority.readRealization(accepted, AbortSignal.timeout(1000))).toEqual({
      kind: "native_unavailable",
    });
    expect(nativeReads).toBe(0);

    f.insert({
      uid: "deployment-actor-authority",
      name: "deployment-actor-authority",
      form: WORKER_DEPLOYMENT_FORM_URL,
      operationId: CREATE_DEPLOYMENT,
      spec: {
        worker: { resourceUid: WORKER },
        versions: [{ workerVersion: { resourceUid: "version-1" }, weight: 10_000 }],
      },
      observed: { ready: true, active: true },
    });
    expect(await authority.hasRealization(accepted)).toBe(true);
    selectedOwner = { ...owner, workerResourceUid: "other-worker" };
    expect(await authority.readRealization(accepted, AbortSignal.timeout(1000))).toEqual({
      kind: "native_unavailable",
    });
    selectedOwner = owner;
    const result = await authority.readRealization(accepted, AbortSignal.timeout(1000));
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("native realization missing");
    expect(
      await authority.stillCurrent(accepted, result.realization, AbortSignal.timeout(1000)),
    ).toBe(true);
    actorForwardSockets = [
      {
        tenantId: PRINCIPAL,
        namespaceResourceUid: NAMESPACE,
        token: "c".repeat(64),
        httpSocketPath: "/tmp/proved-actor-http.sock",
        upgradeSocketPath: "/tmp/proved-actor-upgrade.sock",
      },
    ];
    expect(
      await authority.stillCurrent(accepted, result.realization, AbortSignal.timeout(1000)),
    ).toBe(false);
    actorForwardSockets = [];
    expect((await authority.selectVersion(accepted, result.realization, 0))?.workerVersionUid).toBe(
      "version-1",
    );

    const specJson = JSON.stringify({ worker: { resourceUid: WORKER }, className: "CounterActor" });
    f.db
      .query(
        `INSERT INTO tf_v2_operations
       (id, resource_uid, principal, replay_key, request_fingerprint,
        action, generation, status, effect, created_at, updated_at,
        retain_until, backend_id, target_key, backend_key, accepted_spec_json)
       VALUES (?, ?, ?, 'delete-replay', 'delete-fingerprint', 'delete', 2,
         'queued', 'none', '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z',
         '2027-10-07T00:00:00Z', 'actor-fixture-backend', ?, 'delete-backend', ?)`,
      )
      .run(DELETE_NAMESPACE, NAMESPACE, PRINCIPAL, TARGET, specJson);
    f.db
      .query(
        `UPDATE tf_v2_resources SET generation = 2, phase = 'deleting',
         busy_operation = ?, last_operation = ? WHERE uid = ?`,
      )
      .run(DELETE_NAMESPACE, DELETE_NAMESPACE, NAMESPACE);
    expect(await authority.readGraph(scope, AbortSignal.timeout(1000))).toBeNull();
    expect(await authority.hasNamespaceAuthority(scope, AbortSignal.timeout(1000))).toBe(false);
    expect(
      await authority.stillCurrent(accepted, result.realization, AbortSignal.timeout(1000)),
    ).toBe(false);
  } finally {
    f.db.close();
  }
});
