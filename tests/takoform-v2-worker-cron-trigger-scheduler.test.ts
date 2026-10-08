import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
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
import {
  createV2WorkerInvocationLifecycle,
  type V2WorkerCronInvocationClaim,
} from "../src/takoform-v2/worker-invocation-custody.ts";

const PRINCIPAL = "cron-scheduler-fixture";
const SPACE = "prod";
const TARGET_KEY = "cron-scheduler-fixture";
const SETTLED_BEFORE_MATCH = "2026-10-07T11:59:00.000Z";
const MATCH_AT = Date.parse("2026-10-07T12:00:00.000Z");

function seedGraph(
  db: Database,
  handlers: readonly string[] = ["scheduled"],
  settledAt = SETTLED_BEFORE_MATCH,
  targetKey = TARGET_KEY,
  additionalCronCount = 0,
  versionTargetKey = targetKey,
  triggerTargetKey = targetKey,
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
    resourceTargetKey = targetKey,
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
      resourceTargetKey,
      name,
      settledAt,
      spec,
      observed,
      op,
    );
  }
  function operation(
    id: string,
    uid: string,
    spec: string,
    updatedAt: string,
    operationTargetKey = targetKey,
  ) {
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
      operationTargetKey,
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
    versionTargetKey,
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
    triggerTargetKey,
  );
  operation(workerOperation, workerUid, workerSpec, settledAt);
  operation(versionOperation, versionUid, versionSpec, settledAt, versionTargetKey);
  operation(deploymentOperation, deploymentUid, deploymentSpec, settledAt);
  operation(cronOperation, cronUid, cronSpec, settledAt, triggerTargetKey);

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
  for (let index = 0; index < additionalCronCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const extraUid = `cron-trigger-extra-${suffix}`;
    const extraOperation = `cron-operation-extra-${suffix}`;
    const extraSpec = JSON.stringify({ cron: "* * * * *", worker: { resourceUid: workerUid } });
    resource(
      extraUid,
      WORKER_CRON_TRIGGER_FORM_URL,
      `cron-extra-${suffix}`,
      extraSpec,
      "{}",
      extraOperation,
    );
    operation(extraOperation, extraUid, extraSpec, settledAt);
    refs(extraOperation, [{ uid: workerUid, form: moduleUrl, readiness: "observed" }]);
  }
  return {
    workerUid,
    versionUid,
    versionOperation,
    deploymentUid,
    deploymentOperation,
    cronUid,
    cronOperation,
  };
}

function openDb(path = ":memory:") {
  const db = new Database(path);
  migrateSqlite(db);
  return db;
}

function seedPublishedGraph(db: Database) {
  const graph = seedGraph(db);
  const release = {
    versionUid: graph.versionUid,
    versionGeneration: 1,
    scriptName: `v2w-${"a".repeat(48)}`,
    weight: 10_000,
    descriptorDigest: `sha256:${"b".repeat(64)}` as const,
    providerEtag: "provider-cron-receipt-001",
  };
  // Fixture already has an accepted Version operation. Publication grant
  // protocol is tested separately; seed only its confirmed native receipt.
  db.exec("DROP TRIGGER tf_v2_worker_native_effect_insert_guard");
  db.prepare(`INSERT INTO tf_v2_worker_native_effects
    (operation_id,resource_uid,principal,space,backend_key,backend_id,target_key,
     generation,native_identity,closure_digest,grant_lease_token,granted_at_ms,
     acknowledged_receipt,confirmed_receipt)
    VALUES (?,?,?,?,'backend-version-operation-fixture','fixture-backend',?,
     1,?,?,?,1000,?,?)`).run(
    graph.versionOperation,
    graph.versionUid,
    PRINCIPAL,
    SPACE,
    TARGET_KEY,
    release.scriptName,
    release.descriptorDigest,
    "version-grant-token-001",
    release.providerEtag,
    release.providerEtag,
  );
  return { graph, release };
}

function cronClaim(
  graph: ReturnType<typeof seedGraph>,
  release: ReturnType<typeof seedPublishedGraph>["release"],
  match: { matchId: string; leaseToken: string; attempt: number },
): V2WorkerCronInvocationClaim {
  return {
    handle: {
      invocationId: `cron-attempt-${match.attempt}`,
      custodyToken: "cron-custody-token-001",
    },
    match,
    route: {
      targetKey: TARGET_KEY,
      workerUid: graph.workerUid,
      deploymentUid: graph.deploymentUid,
      deploymentGeneration: 1,
      sourceOperationId: graph.deploymentOperation,
      releases: [release],
    },
    selected: release,
  };
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
        targetKey: TARGET_KEY,
        retryMilliseconds: 1_000,
      }),
    ).toEqual({
      recorded: 1,
      claimed: 1,
      resolved: 0,
      rejected: 0,
      unknown: 1,
      scanComplete: true,
      hasMore: false,
      continuation: null,
    });
    first.close();

    const restarted = openDb(path);
    try {
      expect(
        await runWorkerCronTriggerTick({
          sql: createSqliteSql(restarted),
          now: () => new Date(MATCH_AT + 12_000),
          delivery,
          targetKey: TARGET_KEY,
          retryMilliseconds: 1_000,
        }),
      ).toEqual({
        recorded: 0,
        claimed: 1,
        resolved: 1,
        rejected: 0,
        unknown: 0,
        scanComplete: true,
        hasMore: false,
        continuation: null,
      });
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

test("a claimed Cron match admits one exact physical attempt before native send", async () => {
  const db = openDb();
  try {
    const { graph, release } = seedPublishedGraph(db);
    const sql = createSqliteSql(db);
    const custody = createV2WorkerInvocationLifecycle({ sql });
    let result: unknown;
    let began = false;
    let duplicateBegan = true;
    let admittedHandle: V2WorkerCronInvocationClaim["handle"] | undefined;
    const tick = await runWorkerCronTriggerTick({
      sql,
      now: () => new Date(),
      targetKey: TARGET_KEY,
      delivery: {
        async invokeScheduled(input) {
          const claim = cronClaim(graph, release, input);
          result = await custody.admitCron(claim);
          admittedHandle = claim.handle;
          began = await custody.beginSend(claim.handle);
          duplicateBegan = await custody.beginSend(claim.handle);
          return { kind: "unknown" };
        },
      },
    });
    expect(tick.claimed).toBe(1);
    expect(result).toMatchObject({ kind: "granted" });
    expect(began).toBe(true);
    expect(duplicateBegan).toBe(false);
    expect(
      db.prepare("SELECT ingress_kind, version_uid FROM tf_v2_worker_invocations").all(),
    ).toEqual([{ ingress_kind: "cron", version_uid: graph.versionUid }]);
    if (!admittedHandle) throw new Error("missing admitted handle");
    expect(await custody.inspectDeployment(graph.deploymentUid)).toEqual({
      outstanding: 1,
      bodyFinished: 0,
    });
    const record = await custody.read(admittedHandle);
    if (!record) throw new Error("missing Cron custody row");
    expect(record.ingress).toMatchObject({ kind: "cron", attempt: 1 });
    expect(
      await custody.confirmNativeRetirement({
        handle: admittedHandle,
        expected: record,
        receiptDigest: `sha256:${"d".repeat(64)}`,
      }),
    ).toBe(true);
    expect(await custody.inspectDeployment(graph.deploymentUid)).toEqual({
      outstanding: 0,
      bodyFinished: 0,
    });
  } finally {
    db.close();
  }
});

test("Cron admission rejects retired leases, deleted Trigger, changed Deployment and foreign publication", async () => {
  for (const change of ["lease", "trigger-delete", "deployment", "receipt", "scope"] as const) {
    const db = openDb();
    try {
      const { graph, release } = seedPublishedGraph(db);
      const sql = createSqliteSql(db);
      const custody = createV2WorkerInvocationLifecycle({ sql });
      let admission: unknown;
      let thrown: unknown;
      await runWorkerCronTriggerTick({
        sql,
        now: () => new Date(),
        targetKey: TARGET_KEY,
        delivery: {
          async invokeScheduled(input) {
            try {
              let claim = cronClaim(graph, release, input);
              if (change === "lease") {
                db.prepare(`UPDATE tf_v2_worker_cron_matches
                SET state='pending', lease_token=NULL, lease_until_ms=NULL,
                    next_attempt_at_ms=next_attempt_at_ms+1000, updated_at_ms=?
                WHERE match_id=?`).run(Date.now(), input.matchId);
              } else if (change === "trigger-delete") {
                db.prepare(
                  "UPDATE tf_v2_resources SET active_name=NULL, deleted_at=? WHERE uid=?",
                ).run(new Date().toISOString(), graph.cronUid);
              } else if (change === "deployment") {
                db.prepare("UPDATE tf_v2_resources SET observed_json=? WHERE uid=?").run(
                  JSON.stringify({ activeDeploymentUid: "other-deployment", ready: true }),
                  graph.workerUid,
                );
              } else if (change === "receipt") {
                claim = {
                  ...claim,
                  route: { ...claim.route, releases: [{ ...release, providerEtag: "wrong" }] },
                };
              } else {
                claim = { ...claim, route: { ...claim.route, targetKey: "another-target" } };
              }
              admission = await custody.admitCron(claim);
              return { kind: "unknown" };
            } catch (error) {
              thrown = error;
              return { kind: "unknown" };
            }
          },
        },
      });
      expect(thrown).toBeUndefined();
      expect(admission).toEqual({ kind: "unavailable" });
      expect(db.query("SELECT count(*) AS count FROM tf_v2_worker_invocations").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  }
});

test("Cron admission and beginSend recheck the lease at their delayed SQL mutation", async () => {
  for (const stage of ["admit", "beginSend"] as const) {
    const db = openDb();
    try {
      const { graph, release } = seedPublishedGraph(db);
      const base = createSqliteSql(db);
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const delayed: Sql = {
        ...base,
        async run(statement, params) {
          if (
            stage === "admit"
              ? statement.startsWith("INSERT INTO tf_v2_worker_invocations")
              : statement.startsWith(
                  "UPDATE tf_v2_worker_invocations SET phase = 'send_authorized'",
                )
          ) {
            enter();
            await gate;
          }
          return base.run(statement, params);
        },
      };
      const custody = createV2WorkerInvocationLifecycle({ sql: delayed });
      let admitted: unknown;
      let began: boolean | undefined;
      const tick = runWorkerCronTriggerTick({
        sql: base,
        now: () => new Date(),
        targetKey: TARGET_KEY,
        delivery: {
          async invokeScheduled(input) {
            const claim = cronClaim(graph, release, input);
            if (stage === "beginSend") admitted = await custody.admitCron(claim);
            else admitted = undefined;
            const result = stage === "admit" ? await custody.admitCron(claim) : undefined;
            if (stage === "admit") admitted = result;
            else began = await custody.beginSend(claim.handle);
            return { kind: "unknown" };
          },
        },
      });
      await entered;
      db.prepare(`UPDATE tf_v2_worker_cron_matches
        SET state='pending', lease_token=NULL, lease_until_ms=NULL,
            next_attempt_at_ms=next_attempt_at_ms+1000, updated_at_ms=?
        WHERE state='dispatching'`).run(Date.now());
      resume();
      await tick;
      if (stage === "admit") {
        expect(admitted).toEqual({ kind: "unavailable" });
        expect(db.query("SELECT count(*) AS count FROM tf_v2_worker_invocations").get()).toEqual({
          count: 0,
        });
      } else {
        expect(admitted).toMatchObject({ kind: "granted" });
        expect(began).toBe(false);
        expect(db.query("SELECT phase FROM tf_v2_worker_invocations").get()).toEqual({
          phase: "admitted",
        });
      }
    } finally {
      db.close();
    }
  }
});

test("Cron lease deadline is checked by the mutation's SQLite clock", async () => {
  const db = openDb();
  try {
    const { graph, release } = seedPublishedGraph(db);
    const sql = createSqliteSql(db);
    const custody = createV2WorkerInvocationLifecycle({ sql });
    let admission: unknown;
    await runWorkerCronTriggerTick({
      sql,
      now: () => new Date(),
      targetKey: TARGET_KEY,
      leaseMilliseconds: 1_000,
      delivery: {
        async invokeScheduled(input) {
          await Bun.sleep(1_100);
          admission = await custody.admitCron(cronClaim(graph, release, input));
          return { kind: "unknown" };
        },
      },
    });
    expect(admission).toEqual({ kind: "unavailable" });
    expect(db.query("SELECT count(*) AS count FROM tf_v2_worker_invocations").get()).toEqual({
      count: 0,
    });
  } finally {
    db.close();
  }
});

test("an accepted Trigger update retains the already recorded match identity", async () => {
  const db = openDb();
  try {
    const { graph, release } = seedPublishedGraph(db);
    const sql = createSqliteSql(db);
    const custody = createV2WorkerInvocationLifecycle({ sql });
    let admission: unknown;
    await runWorkerCronTriggerTick({
      sql,
      now: () => new Date(),
      targetKey: TARGET_KEY,
      delivery: {
        async invokeScheduled(input) {
          const changedSpec = JSON.stringify({
            cron: "*/2 * * * *",
            worker: { resourceUid: graph.workerUid },
          });
          db.prepare(`INSERT INTO tf_v2_operations
            (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,
             status,effect,created_at,updated_at,retain_until,backend_id,target_key,
             backend_key,accepted_spec_json,dispatch_possible,next_attempt_at_ms,
             result_observed_json,result_output_json)
            SELECT 'cron-operation-update',resource_uid,principal,'cron-replay-update',
              'cron-fingerprint-update','update',2,status,effect,created_at,?,
              retain_until,backend_id,target_key,'backend-cron-operation-update',?,
              dispatch_possible,next_attempt_at_ms,result_observed_json,result_output_json
            FROM tf_v2_operations WHERE id=?`).run(
            new Date().toISOString(),
            changedSpec,
            graph.cronOperation,
          );
          db.prepare(`UPDATE tf_v2_resources SET generation=2, observed_generation=2,
            spec_json=?,last_operation='cron-operation-update' WHERE uid=?`).run(
            changedSpec,
            graph.cronUid,
          );
          admission = await custody.admitCron(cronClaim(graph, release, input));
          return { kind: "unknown" };
        },
      },
    });
    expect(admission).toMatchObject({ kind: "granted" });
    expect(
      db.query("SELECT cron_trigger_operation_id FROM tf_v2_worker_invocations").get(),
    ).toEqual({
      cron_trigger_operation_id: graph.cronOperation,
    });
  } finally {
    db.close();
  }
});

test("ambiguous Cron admission and beginSend ACKs never authorize a second native send", async () => {
  for (const lost of ["admit", "beginSend"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "v2-cron-custody-ack-"));
    const path = join(directory, "state.sqlite");
    const db = openDb(path);
    try {
      const { graph, release } = seedPublishedGraph(db);
      const base = createSqliteSql(db);
      let threw = false;
      const uncertain: Sql = {
        ...base,
        async run(statement, params) {
          const result = await base.run(statement, params);
          const target =
            lost === "admit"
              ? statement.startsWith("INSERT INTO tf_v2_worker_invocations")
              : statement.startsWith(
                  "UPDATE tf_v2_worker_invocations SET phase = 'send_authorized'",
                );
          if (target && !threw) {
            threw = true;
            throw new Error("committed; acknowledgement lost");
          }
          return result;
        },
      };
      const custody = createV2WorkerInvocationLifecycle({ sql: uncertain });
      let admission: unknown;
      let began: boolean | undefined;
      let physicalHandle: V2WorkerCronInvocationClaim["handle"] | undefined;
      await runWorkerCronTriggerTick({
        sql: base,
        now: () => new Date(),
        targetKey: TARGET_KEY,
        delivery: {
          async invokeScheduled(input) {
            const claim = cronClaim(graph, release, input);
            admission = await custody.admitCron(claim);
            physicalHandle = claim.handle;
            began = await custody.beginSend(claim.handle);
            return { kind: "unknown" };
          },
        },
      });
      expect(threw).toBe(true);
      expect(admission).toMatchObject({ kind: lost === "admit" ? "already_admitted" : "granted" });
      expect(began).toBe(lost === "admit");
      if (!physicalHandle) throw new Error("missing physical handle");
      const restarted = new Database(path);
      try {
        const afterRestart = createV2WorkerInvocationLifecycle({ sql: createSqliteSql(restarted) });
        expect((await afterRestart.read(physicalHandle))?.phase).toBe("send_authorized");
        expect(await afterRestart.beginSend(physicalHandle)).toBe(false);
        expect(await afterRestart.inspectDeployment(graph.deploymentUid)).toEqual({
          outstanding: 1,
          bodyFinished: 0,
        });
        let nextMatch: string | undefined;
        let nextAttempt: number | undefined;
        let nextAdmission: unknown;
        await runWorkerCronTriggerTick({
          sql: createSqliteSql(restarted),
          now: () => new Date(Date.now() + 2_000),
          targetKey: TARGET_KEY,
          limit: 1,
          delivery: {
            async invokeScheduled(input) {
              nextMatch = input.matchId;
              nextAttempt = input.attempt;
              nextAdmission = await afterRestart.admitCron(cronClaim(graph, release, input));
              return { kind: "unknown" };
            },
          },
        });
        const originalMatch = restarted
          .query("SELECT cron_match_id FROM tf_v2_worker_invocations WHERE cron_attempt=1")
          .get() as { cron_match_id: string };
        expect(nextMatch).toBe(originalMatch.cron_match_id);
        expect(nextAttempt).toBe(2);
        expect(nextAdmission).toMatchObject({ kind: "granted" });
        expect(await afterRestart.inspectDeployment(graph.deploymentUid)).toEqual({
          outstanding: 2,
          bodyFinished: 0,
        });
        expect(
          await afterRestart.refuseBeforeSend({
            invocationId: "cron-attempt-2",
            custodyToken: "cron-custody-token-001",
          }),
        ).toBe(true);
        expect(await afterRestart.inspectDeployment(graph.deploymentUid)).toEqual({
          outstanding: 1,
          bodyFinished: 0,
        });
        expect(() =>
          restarted
            .prepare(`INSERT INTO tf_v2_operations
          (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,
           status,effect,created_at,updated_at,retain_until,backend_id,target_key,
           backend_key,accepted_spec_json)
          VALUES ('cron-version-delete','version-cron-fixture',?,'cron-delete-replay',
            'cron-delete-fingerprint','delete',2,'queued','none',?,?,?,
            'fixture-backend',?,'cron-delete-backend-key','{}')`)
            .run(
              PRINCIPAL,
              new Date().toISOString(),
              new Date().toISOString(),
              "2027-10-07T12:00:00.000Z",
              TARGET_KEY,
            ),
        ).toThrow("tf_v2_worker_invocation_live_reference");
      } finally {
        restarted.close();
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
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
      targetKey: TARGET_KEY,
    });
    expect(result.recorded).toBe(1);
    expect(db.query("SELECT scheduled_time_ms FROM tf_v2_worker_cron_matches").all()).toEqual([
      { scheduled_time_ms: MATCH_AT + 60_000 },
    ]);
  } finally {
    db.close();
  }
});

test("continues bounded current-minute pages while delivering due matches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v2-cron-scan-cursor-"));
  const path = join(directory, "state.sqlite");
  let db = openDb(path);
  const graph = seedGraph(
    db,
    ["scheduled"],
    SETTLED_BEFORE_MATCH,
    TARGET_KEY,
    130,
    TARGET_KEY,
    "other-target",
  );
  try {
    let tickAt = MATCH_AT + 10_000;
    const deliveredMatchIds: string[] = [];
    const delivery = {
      async invokeScheduled(input: { readonly matchId: string }) {
        deliveredMatchIds.push(input.matchId);
        return deliveredMatchIds.length === 1
          ? { kind: "unknown" as const }
          : { kind: "handler_resolved" as const, workerVersionUid: graph.versionUid };
      },
    };
    const firstPage = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(tickAt),
      delivery,
      targetKey: TARGET_KEY,
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      recorded: 128,
      claimed: 1,
      unknown: 1,
      scanComplete: false,
      hasMore: true,
    });
    expect(firstPage.continuation).toMatchObject({
      targetKey: TARGET_KEY,
      scheduledTime: MATCH_AT,
    });

    db.close();
    db = openDb(path);
    tickAt += 1_001;
    const secondPage = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(tickAt),
      delivery,
      targetKey: TARGET_KEY,
      limit: 1,
    });
    expect(secondPage).toMatchObject({
      recorded: 2,
      claimed: 1,
      resolved: 1,
      scanComplete: true,
      hasMore: false,
      continuation: null,
    });
    expect(deliveredMatchIds).toHaveLength(2);
    expect(deliveredMatchIds[0]).toBe(deliveredMatchIds[1]);
    expect(db.query("SELECT count(*) AS count FROM tf_v2_worker_cron_matches").get()).toEqual({
      count: 130,
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new UTC minute starts a fresh bounded scan without catching up old pages", async () => {
  const db = openDb();
  const graph = seedGraph(
    db,
    ["scheduled"],
    SETTLED_BEFORE_MATCH,
    TARGET_KEY,
    130,
    TARGET_KEY,
    "other-target",
  );
  const delivery: WorkerCronTriggerDelivery = {
    async invokeScheduled() {
      return { kind: "handler_resolved", workerVersionUid: graph.versionUid };
    },
  };
  try {
    const priorMinute = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 10_000),
      delivery,
      targetKey: TARGET_KEY,
      limit: 100,
    });
    expect(priorMinute).toMatchObject({
      recorded: 128,
      scanComplete: false,
      hasMore: true,
    });

    const currentMinute = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 70_000),
      delivery,
      targetKey: TARGET_KEY,
      limit: 100,
    });
    expect(currentMinute).toMatchObject({
      recorded: 100,
      scanComplete: false,
      hasMore: true,
      continuation: { targetKey: TARGET_KEY, scheduledTime: MATCH_AT + 60_000 },
    });

    const finalPage = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 71_000),
      delivery,
      targetKey: TARGET_KEY,
      limit: 100,
    });
    expect(finalPage).toMatchObject({
      recorded: 2,
      scanComplete: true,
      hasMore: false,
      continuation: null,
    });
    expect(
      db
        .query(
          "SELECT scheduled_time_ms, count(*) AS count FROM tf_v2_worker_cron_matches GROUP BY scheduled_time_ms ORDER BY scheduled_time_ms",
        )
        .all(),
    ).toEqual([
      { scheduled_time_ms: MATCH_AT, count: 128 },
      { scheduled_time_ms: MATCH_AT + 60_000, count: 102 },
    ]);
  } finally {
    db.close();
  }
});

test("does not record a match when a selected Version belongs to another target", async () => {
  const db = openDb();
  seedGraph(db, ["scheduled"], SETTLED_BEFORE_MATCH, TARGET_KEY, 0, "other-target");
  try {
    const result = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 10_000),
      delivery: {
        async invokeScheduled() {
          throw new Error("must not dispatch a cross-target graph");
        },
      },
      targetKey: TARGET_KEY,
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
      targetKey: TARGET_KEY,
      retryMilliseconds: 1_000,
    });
    const nextTick = await runWorkerCronTriggerTick({
      sql: createSqliteSql(db),
      now: () => new Date(MATCH_AT + 70_000),
      delivery,
      targetKey: TARGET_KEY,
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
      targetKey: TARGET_KEY,
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
      targetKey: TARGET_KEY,
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
