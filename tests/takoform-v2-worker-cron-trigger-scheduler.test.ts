import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  runWorkerCronTriggerTick,
  type WorkerCronTriggerDelivery,
} from "../src/takoform-v2/worker-cron-trigger-scheduler.ts";

const PRINCIPAL = "cron-scheduler-fixture";
const SPACE = "prod";
const TARGET_KEY = "cron-scheduler-fixture";
const SETTLED_BEFORE_MATCH = "2026-10-07T11:59:00.000Z";
const MATCH_AT = Date.parse("2026-10-07T12:00:00.000Z");

function seedGraph(
  db: Database,
  handlers: readonly string[] = ["scheduled"],
  settledAt = SETTLED_BEFORE_MATCH,
) {
  // This fixture seeds already accepted/settled v2 rows to isolate scheduler
  // durability. The production acceptance guard and match insert guard remain
  // enabled; only the ordinary v2 reference-acceptance insert guards are
  // bypassed to build immutable fixture history directly.
  db.exec(
    "DROP TRIGGER tf_v2_operation_reference_set_guard; DROP TRIGGER tf_v2_operation_reference_guard;",
  );
  const workerUid = "worker-cron-fixture";
  const versionUid = "version-cron-fixture";
  const deploymentUid = "deployment-cron-fixture";
  const cronUid = "cron-trigger-fixture";
  const workerOperation = "worker-operation-fixture";
  const versionOperation = "version-operation-fixture";
  const deploymentOperation = "deployment-operation-fixture";
  const cronOperation = "cron-operation-fixture";
  const moduleUrl = MODULE_WORKER_FORM_URL;
  const workerSpec = "{}";
  const versionSpec = JSON.stringify({ handlers, worker: { resourceUid: workerUid } });
  const deploymentSpec = JSON.stringify({
    worker: { resourceUid: workerUid },
    versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
  });
  const cronSpec = JSON.stringify({ cron: "* * * * *", worker: { resourceUid: workerUid } });
  const observedWorker = JSON.stringify({ activeDeploymentUid: deploymentUid, ready: true });
  const observedVersion = JSON.stringify({ ready: true });
  const observedDeployment = JSON.stringify({
    active: true,
    ready: true,
    selectedVersions: [{ resourceUid: versionUid, weight: 10_000 }],
  });

  function resource(
    uid: string,
    formUrl: string,
    name: string,
    spec: string,
    observed: string,
    op: string,
  ) {
    db.query(
      `INSERT INTO tf_v2_resources
       (uid, principal, form_url, space, name, backend_id, target_key, active_name,
        generation, observed_generation, observed_at, phase, spec_json, observed_json,
        output_json, last_operation, busy_operation, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'idle', ?, ?, '{}', ?, NULL, NULL)`,
    ).run(
      uid,
      PRINCIPAL,
      formUrl,
      SPACE,
      name,
      "fixture-backend",
      TARGET_KEY,
      name,
      settledAt,
      spec,
      observed,
      op,
    );
  }
  function operation(id: string, uid: string, spec: string, updatedAt: string) {
    db.query(
      `INSERT INTO tf_v2_operations
       (id, resource_uid, principal, replay_key, request_fingerprint, action, generation,
        status, effect, created_at, updated_at, retain_until, backend_id, target_key,
        backend_key, accepted_spec_json, dispatch_possible, next_attempt_at_ms,
        lease_token, lease_until_ms, error_code, error_message, result_observed_json,
        result_output_json)
       VALUES (?, ?, ?, ?, ?, 'create', 1, 'succeeded', 'complete', ?, ?, ?, ?, ?, ?, ?,
               1, 0, NULL, NULL, NULL, NULL, ?, '{}')`,
    ).run(
      id,
      uid,
      PRINCIPAL,
      `replay-${id}`,
      `fingerprint-${id}`,
      updatedAt,
      updatedAt,
      "2027-10-07T12:00:00.000Z",
      "fixture-backend",
      TARGET_KEY,
      `backend-${id}`,
      spec,
      id === workerOperation
        ? observedWorker
        : id === versionOperation
          ? observedVersion
          : id === deploymentOperation
            ? observedDeployment
            : '{"ready":true}',
    );
  }
  resource(workerUid, moduleUrl, "cron-worker", workerSpec, observedWorker, workerOperation);
  resource(
    versionUid,
    WORKER_VERSION_FORM_URL,
    "cron-version",
    versionSpec,
    observedVersion,
    versionOperation,
  );
  resource(
    deploymentUid,
    WORKER_DEPLOYMENT_FORM_URL,
    "cron-deployment",
    deploymentSpec,
    observedDeployment,
    deploymentOperation,
  );
  resource(
    cronUid,
    WORKER_CRON_TRIGGER_FORM_URL,
    "cron-trigger",
    cronSpec,
    '{"ready":true}',
    cronOperation,
  );
  operation(workerOperation, workerUid, workerSpec, settledAt);
  operation(versionOperation, versionUid, versionSpec, settledAt);
  operation(deploymentOperation, deploymentUid, deploymentSpec, settledAt);
  operation(cronOperation, cronUid, cronSpec, settledAt);

  function refs(
    operationId: string,
    targets: readonly { uid: string; form: string; readiness: "observed" | "ready" }[],
  ) {
    db.query("INSERT INTO tf_v2_operation_reference_sets (operation_id, sealed) VALUES (?, 1)").run(
      operationId,
    );
    for (const target of targets) {
      db.query(
        `INSERT INTO tf_v2_operation_references
         (operation_id, target_uid, form_url, readiness, target_spec_path, target_spec_equals)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
      ).run(operationId, target.uid, target.form, target.readiness);
    }
  }
  refs(versionOperation, [{ uid: workerUid, form: moduleUrl, readiness: "observed" }]);
  refs(deploymentOperation, [
    { uid: workerUid, form: moduleUrl, readiness: "observed" },
    { uid: versionUid, form: WORKER_VERSION_FORM_URL, readiness: "ready" },
  ]);
  refs(cronOperation, [{ uid: workerUid, form: moduleUrl, readiness: "observed" }]);
  return { workerUid, versionUid, deploymentUid, cronUid, cronOperation };
}

function openDb(path = ":memory:") {
  const db = new Database(path);
  migrateSqlite(db);
  return db;
}

test("records one exact match, redelivers the same id after unknown ACK and SQL restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v2-cron-scheduler-"));
  const path = join(directory, "state.sqlite");
  const first = openDb(path);
  const graph = seedGraph(first);
  const calls: string[] = [];
  const delivery: WorkerCronTriggerDelivery = {
    async invokeScheduled(input) {
      calls.push(input.matchId);
      return calls.length === 1
        ? { kind: "unknown" }
        : { kind: "handler_resolved", workerVersionUid: graph.versionUid };
    },
  };
  const now = () => new Date(MATCH_AT + 10_000);
  try {
    expect(
      await runWorkerCronTriggerTick({
        sql: createSqliteSql(first),
        now,
        delivery,
        retryMilliseconds: 1_000,
      }),
    ).toEqual({ recorded: 1, claimed: 1, resolved: 0, rejected: 0, unknown: 1 });
    first.close();

    const restarted = openDb(path);
    try {
      expect(
        await runWorkerCronTriggerTick({
          sql: createSqliteSql(restarted),
          now: () => new Date(MATCH_AT + 12_000),
          delivery,
          retryMilliseconds: 1_000,
        }),
      ).toEqual({ recorded: 0, claimed: 1, resolved: 1, rejected: 0, unknown: 0 });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(calls[1]);
      expect(
        restarted
          .query("SELECT state, attempts, result_version_uid FROM tf_v2_worker_cron_matches")
          .all(),
      ).toEqual([{ state: "resolved", attempts: 2, result_version_uid: graph.versionUid }]);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not catch up an unrecorded minute after a late tick", async () => {
  const db = openDb();
  seedGraph(db, ["scheduled"], "2026-10-07T12:00:05.000Z");
  try {
    const delivery: WorkerCronTriggerDelivery = {
      async invokeScheduled() {
        return { kind: "unknown" };
      },
    };
    const result = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 70_000),
      delivery,
    });
    expect(result.recorded).toBe(1);
    expect(db.query("SELECT scheduled_time_ms FROM tf_v2_worker_cron_matches").all()).toEqual([
      { scheduled_time_ms: MATCH_AT + 60_000 },
    ]);
  } finally {
    db.close();
  }
});

test("does not record a later match while an earlier delivery remains outstanding", async () => {
  const db = openDb();
  seedGraph(db);
  const matchIds: string[] = [];
  try {
    const delivery: WorkerCronTriggerDelivery = {
      async invokeScheduled(input) {
        matchIds.push(input.matchId);
        return { kind: "unknown" };
      },
    };
    await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 10_000),
      delivery,
      retryMilliseconds: 1_000,
    });
    const nextTick = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 70_000),
      delivery,
      retryMilliseconds: 1_000,
    });
    expect(nextTick.recorded).toBe(0);
    expect(db.query("SELECT scheduled_time_ms FROM tf_v2_worker_cron_matches").all()).toEqual([
      { scheduled_time_ms: MATCH_AT },
    ]);
    expect(matchIds).toHaveLength(2);
    expect(matchIds[0]).toBe(matchIds[1]);
  } finally {
    db.close();
  }
});

test("a handler rejection is terminal and is not retried for the same match", async () => {
  const db = openDb();
  const graph = seedGraph(db);
  let calls = 0;
  try {
    const delivery: WorkerCronTriggerDelivery = {
      async invokeScheduled() {
        calls += 1;
        return { kind: "handler_rejected", workerVersionUid: graph.versionUid };
      },
    };
    const options = {
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 10_000),
      delivery,
    };
    expect(await runWorkerCronTriggerTick(options)).toMatchObject({ rejected: 1, unknown: 0 });
    expect(await runWorkerCronTriggerTick(options)).toMatchObject({ rejected: 0, claimed: 0 });
    expect(calls).toBe(1);
    expect(db.query("SELECT state, error_code FROM tf_v2_worker_cron_matches").all()).toEqual([
      { state: "rejected", error_code: "handler_rejected" },
    ]);
  } finally {
    db.close();
  }
});

test("fails closed when the selected Worker Version lacks the scheduled handler", async () => {
  const db = openDb();
  seedGraph(db, ["fetch"]);
  try {
    const delivery: WorkerCronTriggerDelivery = {
      async invokeScheduled() {
        throw new Error("must not dispatch without a scheduled Version");
      },
    };
    const result = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 10_000),
      delivery,
    });
    expect(result.recorded).toBe(0);
    expect(result.claimed).toBe(0);
    expect(db.query("SELECT count(*) AS count FROM tf_v2_worker_cron_matches").get()).toEqual({
      count: 0,
    });
  } finally {
    db.close();
  }
});
