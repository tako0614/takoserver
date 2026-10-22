import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  FORWARD_WORKER_VERSION_FORM_URL,
  parseForwardWorkerVersionSpec,
  validateForwardWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createForwardWorkerNative106Recipe } from "../src/takoform-v2/forward-worker-native-schema.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { createForwardV2WorkerInvocationLifecycle } from "../src/takoform-v2/worker-invocation-custody.ts";
import { createForwardV2NativeDeletionCustody } from "../src/takoform-v2/worker-native-deletions.ts";
import {
  createForwardV2NativeEffectCustody,
  createRetainedV2NativeEffectCustody,
  createV2NativeEffectCustody,
} from "../src/takoform-v2/worker-native-effects.ts";
import { createV2WorkerNativeIdentityMigrationRecipe } from "../src/takoform-v2/worker-native-identity-schema.ts";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

function apply(
  db: Database,
  recipe: { readonly steps: readonly { readonly statements: readonly string[] }[] },
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of recipe.steps) for (const statement of step.statements) db.exec(statement);
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The source assertion may have rolled back already.
    }
    throw new Error("source transition failed");
  }
}

async function fixture(
  installForward = true,
  form:
    | typeof FORWARD_WORKER_VERSION_FORM_URL
    | typeof WORKER_VERSION_FORM_URL = FORWARD_WORKER_VERSION_FORM_URL,
) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  db.exec("PRAGMA foreign_keys = ON");
  apply(db, createV2WorkerNativeIdentityMigrationRecipe());
  if (installForward) apply(db, createForwardWorkerNative106Recipe());
  const sql = createSqliteSql(db);
  const now = () => new Date();
  const backend = {
    id: "forward-native-backend",
    targetKey: "target-a",
    async execute() {
      return { kind: "unknown" as const };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    now,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [WORKER_VERSION_FORM_URL]: {
        validateCreate() {},
        validateUpdate() {},
        backend,
      },
      [FORWARD_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseForwardWorkerVersionSpec,
        validateUpdate: validateForwardWorkerVersionUpdate,
        backend,
      },
    },
  });
  const accepted = await engine.acceptCreate({
    principal: "org-a",
    key: "forward-version-create-key",
    input: {
      form,
      space: "production",
      name: "version-a",
      spec: {
        worker: { resourceUid: "worker-a" },
        bundle: { resourceUid: "bundle-a" },
        handlers: ["fetch"],
        containerBindings: [],
      },
    },
  });
  const store = createV2Store(sql);
  const operation = await store.operation(accepted.id);
  const resource = operation && (await store.resource(operation.resource_uid));
  if (!operation || !resource) throw new Error("accepted source missing");
  const leaseToken = "forward-source-lease";
  const start = Date.now();
  expect(await store.claim(operation.id, leaseToken, start, start + 60_000)).toBe(true);
  expect(await store.markDispatch(operation.id, leaseToken, now().toISOString())).toBe(true);
  const execution: V2Execution = {
    operationId: operation.id,
    resourceUid: resource.uid,
    principal: operation.principal,
    action: operation.action,
    generation: operation.generation,
    form: resource.form_url,
    space: resource.space,
    name: resource.name,
    spec: JSON.parse(operation.accepted_spec_json),
    previousObserved: {},
    previousOutput: {},
    backendKey: operation.backend_key,
    backendId: operation.backend_id,
    targetKey: operation.target_key,
    leaseToken,
  };
  return { db, sql, now, engine, store, execution };
}

test("106 retains populated WV0.5 effects and a selected retained sender can continue", async () => {
  const f = await fixture(false, WORKER_VERSION_FORM_URL);
  try {
    const identity = {
      execution: f.execution,
      nativeIdentity: "old-script",
      closureDigest: DIGEST,
    };
    const old = createV2NativeEffectCustody({
      sql: f.sql,
      now: f.now,
      requiredNativeIdentityDomain: "opaque255",
    });
    expect(await old.grant(identity)).toBe("granted");
    const before = f.db
      .query("SELECT * FROM tf_v2_worker_native_effects WHERE operation_id = ?")
      .get(f.execution.operationId);
    apply(f.db, createForwardWorkerNative106Recipe());
    expect(
      f.db
        .query("SELECT * FROM tf_v2_worker_native_effects WHERE operation_id = ? /* 106 */")
        .get(f.execution.operationId),
    ).toEqual(before);
    expect(await old.grant(identity)).toBe("already_granted");
    expect(
      await createRetainedV2NativeEffectCustody({ sql: f.sql, now: f.now }).grant(identity),
    ).toBe("already_granted");
    expect(
      await createRetainedV2NativeEffectCustody({ sql: f.sql, now: f.now }).confirm({
        ...identity,
        receipt: "old-exact-etag",
      }),
    ).toBe(true);
    const second = await f.engine.acceptCreate({
      principal: "org-a",
      key: "retained-version-create-key",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "production",
        name: "version-retained",
        spec: { worker: { resourceUid: "worker-a" }, handlers: ["fetch"] },
      },
    });
    const secondOp = await f.store.operation(second.id);
    const secondResource = secondOp && (await f.store.resource(secondOp.resource_uid));
    if (!secondOp || !secondResource) throw new Error("retained accepted source missing");
    const secondLease = "retained-source-lease";
    const start = Date.now();
    expect(await f.store.claim(secondOp.id, secondLease, start, start + 60_000)).toBe(true);
    expect(await f.store.markDispatch(secondOp.id, secondLease, f.now().toISOString())).toBe(true);
    const secondIdentity = {
      execution: {
        ...f.execution,
        operationId: secondOp.id,
        resourceUid: secondResource.uid,
        name: secondResource.name,
        generation: secondOp.generation,
        spec: JSON.parse(secondOp.accepted_spec_json),
        backendKey: secondOp.backend_key,
        leaseToken: secondLease,
      },
      nativeIdentity: "retained-script",
      closureDigest: DIGEST,
    };
    expect(await old.grant(secondIdentity)).toBe("conflict");
    expect(
      await createRetainedV2NativeEffectCustody({ sql: f.sql, now: f.now }).grant(secondIdentity),
    ).toBe("granted");
    expect(
      await createForwardV2NativeEffectCustody({ sql: f.sql, now: f.now }).grant(identity),
    ).toBe("conflict");
  } finally {
    f.db.close();
  }
});

test("Forward Cron admission selects retained WV0.5 within a mixed WV0.5/WV0.7 release", async () => {
  let admission = "";
  const sql: Sql = {
    async run(statement) {
      admission = statement;
      return { changes: 0, rows: [] };
    },
    async query() {
      return [];
    },
    async batch() {
      return [];
    },
  };
  const lifecycle = createForwardV2WorkerInvocationLifecycle({
    sql,
    selectedVersionForm: WORKER_VERSION_FORM_URL,
  });
  const oldRelease = {
    versionUid: "old-version",
    versionGeneration: 1,
    scriptName: "old-script",
    weight: 5000,
    descriptorDigest: DIGEST,
    providerEtag: "old-etag",
  };
  expect(
    await lifecycle.admitCron({
      handle: { invocationId: "mixed-cron", custodyToken: "mixed-custody-token" },
      match: {
        matchId: `sha256:${"c".repeat(64)}`,
        leaseToken: "mixed-cron-lease",
        attempt: 1,
      },
      route: {
        targetKey: "target-a",
        workerUid: "worker-a",
        deploymentUid: "deployment-a",
        deploymentGeneration: 1,
        sourceOperationId: "deployment-operation-a",
        releases: [oldRelease, { ...oldRelease, versionUid: "forward-version" }],
      },
      selected: oldRelease,
    }),
  ).toEqual({ kind: "unavailable" });
  expect(admission).toContain(
    `d.form_url='https://edge.forms.takoform.com/forms/WorkerDeployment/0.6.0/'`,
  );
  expect(admission).toContain(`v.form_url='${WORKER_VERSION_FORM_URL}'`);
  expect(admission).toContain(
    `rv.form_url NOT IN ('${WORKER_VERSION_FORM_URL}', '${FORWARD_WORKER_VERSION_FORM_URL}')`,
  );
});

test("accepted Forward operation obtains one durable lease fenced native grant", async () => {
  const before = await fixture(false);
  try {
    const custody = createForwardV2NativeEffectCustody({ sql: before.sql, now: before.now });
    expect(
      await custody.grant({
        execution: before.execution,
        nativeIdentity: "forward-script",
        closureDigest: DIGEST,
      }),
    ).toBe("conflict");
  } finally {
    before.db.close();
  }
  const f = await fixture();
  try {
    const custody = createForwardV2NativeEffectCustody({ sql: f.sql, now: f.now });
    const identity = {
      execution: f.execution,
      nativeIdentity: "forward-script",
      closureDigest: DIGEST,
    };
    expect(await custody.grant(identity)).toBe("granted");
    expect(await custody.grant(identity)).toBe("already_granted");
    expect(await custody.inspect(identity)).toEqual({ kind: "sent" });
    expect(await custody.confirm({ ...identity, receipt: "exact-forward-etag" })).toBe(true);
    expect(await custody.inspect(identity)).toEqual({
      kind: "confirmed",
      receipt: "exact-forward-etag",
    });
    expect(await createV2NativeEffectCustody({ sql: f.sql }).grant(identity)).toBe("conflict");
    expect(
      await custody.grant({
        ...identity,
        execution: { ...f.execution, form: WORKER_VERSION_FORM_URL },
      }),
    ).toBe("conflict");
    expect(await custody.grant({ ...identity, execution: { ...f.execution, generation: 2 } })).toBe(
      "conflict",
    );
    expect(
      await custody.grant({ ...identity, execution: { ...f.execution, resourceUid: "other" } }),
    ).toBe("conflict");
    expect(
      await custody.grant({ ...identity, execution: { ...f.execution, space: "other" } }),
    ).toBe("conflict");
    expect(
      await custody.grant({ ...identity, execution: { ...f.execution, spec: { forged: true } } }),
    ).toBe("conflict");
    expect(
      await custody.grant({ ...identity, execution: { ...f.execution, targetKey: "other" } }),
    ).toBe("conflict");
  } finally {
    f.db.close();
  }
  const expired = await fixture();
  try {
    await expired.sql.run("UPDATE tf_v2_operations SET lease_until_ms = 1 WHERE id = ?", [
      expired.execution.operationId,
    ]);
    expect(
      await createForwardV2NativeEffectCustody({ sql: expired.sql, now: expired.now }).grant({
        execution: expired.execution,
        nativeIdentity: "forward-script",
        closureDigest: DIGEST,
      }),
    ).toBe("conflict");
  } finally {
    expired.db.close();
  }
});

test("accepted Forward DELETE stages its source and commits only one native delete", async () => {
  const f = await fixture();
  try {
    const upload = createForwardV2NativeEffectCustody({ sql: f.sql, now: f.now });
    const identity = {
      execution: f.execution,
      nativeIdentity: "forward-script",
      closureDigest: DIGEST,
    };
    expect(await upload.grant(identity)).toBe("granted");
    expect(await upload.confirm({ ...identity, receipt: "exact-forward-etag" })).toBe(true);
    expect(
      await f.store.settle({
        id: f.execution.operationId,
        token: f.execution.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: f.now().toISOString(),
        retainUntil: new Date(Date.now() + 86_400_000).toISOString(),
        observedJson: "{}",
        outputJson: "{}",
      }),
    ).toBe(true);
    await f.sql.run(
      `UPDATE tf_v2_resources SET phase = 'idle', busy_operation = NULL,
        observed_generation = 1, observed_json = '{}', output_json = '{}'
       WHERE uid = ?`,
      [f.execution.resourceUid],
    );
    const accepted = await f.engine.acceptDelete({
      principal: "org-a",
      key: "forward-delete-key",
      uid: f.execution.resourceUid,
      expectedGeneration: 1,
    });
    const op = await f.store.operation(accepted.id);
    if (!op) throw new Error("accepted deletion missing");
    const token = "forward-delete-lease";
    const start = Date.now();
    expect(await f.store.claim(op.id, token, start, start + 60_000)).toBe(true);
    expect(await f.store.markDispatch(op.id, token, f.now().toISOString())).toBe(true);
    const deletion = createForwardV2NativeDeletionCustody({ sql: f.sql, now: f.now });
    const execution: V2Execution = {
      ...f.execution,
      operationId: op.id,
      action: "delete",
      generation: op.generation,
      spec: JSON.parse(op.accepted_spec_json),
      backendKey: op.backend_key,
      leaseToken: token,
    };
    expect(await deletion.stageNext(execution)).toBe("more");
    expect(await deletion.stageNext(execution)).toBe("ready");
    const item = await deletion.next(execution);
    if (!item) throw new Error("staged source missing");
    expect(item.nativeIdentity).toBe("forward-script");
    const handle = { invocationId: "forward-invocation", custodyToken: "forward-invocation-token" };
    const expected = {
      backendId: f.execution.backendId,
      targetKey: f.execution.targetKey,
      principal: f.execution.principal,
      space: f.execution.space,
      workerUid: "worker-a",
      deploymentUid: "deployment-a",
      deploymentGeneration: 1,
      sourceOperationId: "deployment-operation-a",
      ingress: { kind: "endpoint" as const, endpointUid: "endpoint-a", endpointGeneration: 1 },
      versionUid: f.execution.resourceUid,
      versionGeneration: 1,
      versionOperationId: f.execution.operationId,
      nativeIdentity: "forward-script",
      closureDigest: DIGEST,
      confirmedReceipt: "exact-forward-etag",
    };
    for (const [uid, form] of [
      [expected.workerUid, "ModuleWorker/0.3.0"],
      [expected.deploymentUid, "WorkerDeployment/0.6.0"],
      [expected.ingress.endpointUid, "WorkerEndpoint/0.3.0"],
    ] as const) {
      await f.sql.run(
        `INSERT INTO tf_v2_resources
         (uid,principal,form_url,space,name,backend_id,target_key,active_name,
          generation,observed_generation,phase,spec_json,last_operation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'idle', '{}', ?)`,
        [
          uid,
          expected.principal,
          `https://edge.forms.takoform.com/forms/${form}/`,
          expected.space,
          uid,
          expected.backendId,
          expected.targetKey,
          uid,
          expected.sourceOperationId,
        ],
      );
    }
    await f.sql.run(
      `INSERT INTO tf_v2_operations
       (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,
        status,effect,created_at,updated_at,retain_until,backend_id,target_key,
        backend_key,accepted_spec_json)
       VALUES (?, ?, ?, 'forward-deployment-replay', 'fp', 'create', 1,
        'succeeded','complete','2026-10-22T00:00:00Z','2026-10-22T00:00:00Z',
        '2026-10-23T00:00:00Z', ?, ?, 'forward-deployment-key', '{}')`,
      [
        expected.sourceOperationId,
        expected.deploymentUid,
        expected.principal,
        expected.backendId,
        expected.targetKey,
      ],
    );
    await f.sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id, custody_token, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1000)`,
      [
        handle.invocationId,
        handle.custodyToken,
        expected.backendId,
        expected.targetKey,
        expected.principal,
        expected.space,
        expected.workerUid,
        expected.deploymentUid,
        expected.deploymentGeneration,
        expected.sourceOperationId,
        expected.ingress.endpointUid,
        expected.ingress.endpointGeneration,
        expected.versionUid,
        expected.versionGeneration,
        expected.versionOperationId,
        expected.nativeIdentity,
        expected.closureDigest,
        expected.confirmedReceipt,
      ],
    );
    const lifecycle = createForwardV2WorkerInvocationLifecycle({ sql: f.sql, now: f.now });
    expect(await lifecycle.beginSend(handle)).toBe(true);
    expect(await lifecycle.armSQLiteExternalUse({ handle, expected })).toBe(true);
    expect(await lifecycle.observeBody(handle, "finished")).toBe(true);
    const terminalReceipt = `sha256:${"b".repeat(64)}` as const;
    expect(
      await lifecycle.confirmNativeRetirement({ handle, expected, receiptDigest: terminalReceipt }),
    ).toBe(true);
    expect(await deletion.grant(item, "exact-forward-etag")).toBe("unknown");
    expect(
      await lifecycle.confirmSQLiteDrained({ handle, expected, receiptDigest: terminalReceipt }),
    ).toBe(true);
    expect(await deletion.grant(item, "exact-forward-etag")).toBe("granted");
    expect(await deletion.grant(item, "exact-forward-etag")).toBe("already_granted");
    expect(await deletion.acknowledge(item, "delete-ack")).toBe(true);
    expect(await deletion.confirmAbsent(item, "absence-readback")).toBe(true);
    expect(await deletion.allAbsent(execution)).toBe(true);
  } finally {
    f.db.close();
  }
});
