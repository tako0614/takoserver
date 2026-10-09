import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import type { Sql } from "../src/ports.ts";
import { createSelfhostV2QueueProducerBroker } from "../src/providers/selfhost-v2-queue-producer-broker.ts";
import {
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_QUEUE_PATH,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { createQueueWorkerBindingAuthority } from "../src/takoform-v2/forms/queue-worker-binding-authority.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { V2_QUEUE_BACKEND_ID } from "../src/takoform-v2/worker-queue-backend.ts";
import { v2QueueId } from "../src/takoform-v2/worker-queue-delivery.ts";

const TARGET = "v2-queue-producer-custody";
const QUEUE = "producer-queue";
const WORKER = "producer-worker";
const BUNDLE = "producer-bundle";
const VERSION = "producer-version";
const VERSION_OPERATION = "producer-version-op";
const DEPLOYMENT = "producer-deployment";
const ENDPOINT = "producer-endpoint";
const BINDING = "TASKS";

function settled(
  db: Database,
  input: {
    uid: string;
    form: string;
    backend: string;
    spec: string;
    observed: string;
    queued?: boolean;
  },
): void {
  const operation = input.uid === VERSION ? VERSION_OPERATION : `${input.uid}-op`;
  db.prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,observed_json,output_json,last_operation,busy_operation)
    VALUES (?,'org:one',?,'prod',?,?,?, ?,1,1,?, ?,?,'{}',?,?)`).run(
    input.uid,
    input.form,
    input.uid,
    input.backend,
    TARGET,
    input.uid,
    input.queued ? "pending" : "idle",
    input.spec,
    input.observed,
    operation,
    input.queued ? operation : null,
  );
  db.prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES (?,?,'org:one',?,'fp','create',1,?,? ,
      '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',?,?,?,?)`).run(
    operation,
    input.uid,
    `replay-${input.uid}`,
    input.queued ? "queued" : "succeeded",
    input.queued ? "none" : "complete",
    input.backend,
    TARGET,
    `key-${input.uid}`,
    input.spec,
  );
}

function seedProducerGraph(db: Database): void {
  const queueSpec = JSON.stringify({ messageRetentionSeconds: 3600 });
  settled(db, {
    uid: QUEUE,
    form: AT_LEAST_ONCE_QUEUE_FORM_URL,
    backend: V2_QUEUE_BACKEND_ID,
    spec: queueSpec,
    observed: '{"queueExists":true}',
  });
  for (const [uid, form] of [
    [WORKER, MODULE_WORKER_FORM_URL],
    [DEPLOYMENT, "https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/"],
    [ENDPOINT, "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/"],
    [BUNDLE, "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/"],
  ] as const) {
    settled(db, {
      uid,
      form,
      backend: "worker-backend",
      spec: "{}",
      observed: '{"ready":true}',
    });
  }
  const versionSpec = JSON.stringify({
    worker: { resourceUid: WORKER },
    bundle: { resourceUid: BUNDLE },
    handlers: ["fetch"],
    queueProducerBindings: [{ name: BINDING, resource: { resourceUid: QUEUE } }],
  });
  settled(db, {
    uid: VERSION,
    form: WORKER_VERSION_FORM_URL,
    backend: "worker-backend",
    spec: versionSpec,
    observed: '{"ready":true,"resolvedBindings":true,"bundleVerified":true}',
    queued: true,
  });
  db.prepare("INSERT INTO tf_v2_operation_reference_sets (operation_id,sealed) VALUES (?,0)").run(
    VERSION_OPERATION,
  );
  for (const [uid, form] of [
    [QUEUE, AT_LEAST_ONCE_QUEUE_FORM_URL],
    [WORKER, MODULE_WORKER_FORM_URL],
    [BUNDLE, "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/"],
  ] as const) {
    db.prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness) VALUES (?,?,?,'observed')`).run(
      VERSION_OPERATION,
      uid,
      form,
    );
  }
  db.prepare("UPDATE tf_v2_operation_reference_sets SET sealed=1 WHERE operation_id=?").run(
    VERSION_OPERATION,
  );
  db.prepare("UPDATE tf_v2_operations SET status='running' WHERE id=?").run(VERSION_OPERATION);
  db.prepare("UPDATE tf_v2_operations SET status='reconciling',effect='unknown' WHERE id=?").run(
    VERSION_OPERATION,
  );
  db.prepare("UPDATE tf_v2_operations SET status='succeeded',effect='complete' WHERE id=?").run(
    VERSION_OPERATION,
  );
  db.prepare("UPDATE tf_v2_resources SET busy_operation=NULL,phase='idle' WHERE uid=?").run(
    VERSION,
  );
}

const producerClaim = {
  principal: "org:one",
  space: "prod",
  targetKey: TARGET,
  queueUid: QUEUE,
  workerUid: WORKER,
  workerVersionUid: VERSION,
  workerVersionOperationId: VERSION_OPERATION,
  bindingName: BINDING,
};

const producerTarget = {
  queueId: v2QueueId(QUEUE),
  messageRetentionSeconds: 3600,
  deliveryDelaySeconds: 0,
};

function insertSourceInvocation(
  db: Database,
  input: {
    invocationId: string;
    custodyToken: string;
    incarnationId?: string;
    sourceOperationId?: string;
    principal?: string;
    space?: string;
    targetKey?: string;
    workerUid?: string;
    versionUid?: string;
    versionOperationId?: string;
    phase?: "admitted" | "send_authorized" | "pre_effect_refused";
  },
): void {
  const phase = input.phase ?? "send_authorized";
  db.prepare(`INSERT INTO tf_v2_worker_invocations
    (invocation_id, custody_token, backend_id, target_key, principal, space,
     worker_uid, deployment_uid, deployment_generation, source_operation_id,
     endpoint_uid, endpoint_generation, version_uid, version_generation,
     version_operation_id, native_identity, closure_digest, confirmed_receipt,
     admitted_at_ms, phase, send_authorized_at_ms, refused_at_ms)
    VALUES (?, ?, 'worker-backend', ?, ?, ?,
     ?, ?, 1, ?, ?, 1, ?, 1, ?, ?, ?, 'source-receipt',
     1000, ?, ?, ?)`).run(
    input.invocationId,
    input.custodyToken,
    input.targetKey ?? TARGET,
    input.principal ?? "org:one",
    input.space ?? "prod",
    input.workerUid ?? WORKER,
    DEPLOYMENT,
    input.sourceOperationId ?? VERSION_OPERATION,
    ENDPOINT,
    input.versionUid ?? VERSION,
    input.versionOperationId ?? VERSION_OPERATION,
    input.incarnationId ?? "v2w-physical-source-001",
    `sha256:${"a".repeat(64)}`,
    phase,
    phase === "send_authorized" ? 1500 : null,
    phase === "pre_effect_refused" ? 1500 : null,
  );
}

test("v2 producer admission is atomic with live Queue and sealed Version reference", async () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    seedProducerGraph(db);
    const raw = createSqliteSql(db);
    let raceDelete = false;
    const sql: Sql = {
      ...raw,
      async batch(statements) {
        if (raceDelete) {
          raceDelete = false;
          db.prepare(
            "UPDATE tf_v2_resources SET phase='deleting', busy_operation='delete-op' WHERE uid=?",
          ).run(QUEUE);
        }
        return await raw.batch(statements);
      },
    };
    const custody = createQueueCustody({ sql });
    const claim = producerClaim;
    const nativeVersionId = `v2-${(
      await bytesDigest(new TextEncoder().encode(`${VERSION}\u00001`))
    ).slice("sha256:".length)}`;
    const authority = createQueueWorkerBindingAuthority({ sql: raw, targetKey: TARGET });
    const bindingClaim = {
      principal: claim.principal,
      space: claim.space,
      targetKey: claim.targetKey,
      workerUid: claim.workerUid,
      workerVersionUid: claim.workerVersionUid,
      workerVersionOperationId: claim.workerVersionOperationId,
      nativeVersionId,
      incarnationId: "native-incarnation",
      servingSourceOperationId: "logical-source-op",
      bindings: [{ name: BINDING, resourceUid: QUEUE }],
    };
    expect((await authority.resolveCurrentBinding(bindingClaim, BINDING))?.target.queueId).toBe(
      v2QueueId(QUEUE),
    );
    expect(
      await authority.resolveCurrentBinding(
        { ...bindingClaim, nativeVersionId: "v2-wrong" },
        BINDING,
      ),
    ).toBeNull();
    expect(
      await authority.resolveCurrentBinding({ ...bindingClaim, principal: "org:foreign" }, BINDING),
    ).toBeNull();
    const target = producerTarget;
    const message = (messageId: string) => ({
      messageId,
      body: new TextEncoder().encode(messageId),
    });
    expect(
      await custody.admitV2Batch({
        claim,
        target,
        messages: [message("first"), message("second")],
      }),
    ).toBe(true);
    expect(
      await raw.query("SELECT message_id FROM selfhost_queue_messages ORDER BY message_id"),
    ).toEqual([{ message_id: "first" }, { message_id: "second" }]);
    let nativeCurrent = true;
    const broker = createSelfhostV2QueueProducerBroker({
      custody,
      targetKey: TARGET,
      signingKey: new Uint8Array(32).fill(41),
      resolveCurrentBinding: authority.resolveCurrentBinding,
      async observeVersionTarget(input) {
        return nativeCurrent
          ? { kind: "confirmed" as const, ...input, status: "active" as const }
          : { kind: "unknown" as const };
      },
    });
    const token = broker.issueGrant(bindingClaim);
    const request = (payload: Record<string, unknown>, bearer = token) =>
      new Request(`http://localhost${SELFHOST_DATA_PLANE_QUEUE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          protocol: SELFHOST_DATA_PLANE_PROTOCOL,
          binding: BINDING,
          ...payload,
        }),
      });
    const sent = await broker.handle(request({ op: "send", body: "aGVsbG8=" }));
    expect(sent?.status).toBe(200);
    const sentBody = (await sent?.json()) as { ok: boolean; value: { messageId: string } };
    expect(sentBody.ok).toBe(true);
    expect(sentBody.value.messageId.length).toBeGreaterThan(0);
    const batch = await broker.handle(
      request({
        op: "sendBatch",
        messages: [{ body: "b25l" }, { body: "dHdv", delaySeconds: 2 }],
      }),
    );
    const batchBody = (await batch?.json()) as { ok: boolean; value: { messageIds: string[] } };
    expect(batchBody.ok).toBe(true);
    expect(batchBody.value.messageIds).toHaveLength(2);
    expect(await raw.query("SELECT count(*) AS count FROM selfhost_queue_messages")).toEqual([
      { count: 5 },
    ]);
    expect(
      await (
        await broker.handle(
          request({
            op: "sendBatch",
            messages: [{ body: "b2s=" }, { body: "not-base64" }],
          }),
        )
      )?.json(),
    ).toEqual({ ok: false, error: { code: "invalid_body" } });
    const foreignToken = broker.issueGrant({ ...bindingClaim, principal: "org:foreign" });
    expect(
      await (await broker.handle(request({ op: "send", body: "eA==" }, foreignToken)))?.json(),
    ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(await raw.query("SELECT count(*) AS count FROM selfhost_queue_messages")).toEqual([
      { count: 5 },
    ]);
    nativeCurrent = false;
    expect(await (await broker.handle(request({ op: "send", body: "eA==" })))?.json()).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    nativeCurrent = true;
    expect(
      await (await broker.handle(request({ op: "send", body: "eA==" }, `${token}x`)))?.json(),
    ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(await raw.query("SELECT count(*) AS count FROM selfhost_queue_messages")).toEqual([
      { count: 5 },
    ]);
    raceDelete = true;
    expect(
      await custody.admitV2Batch({
        claim,
        target,
        messages: [message("late-one"), message("late-two")],
      }),
    ).toBe(false);
    expect(await raw.query("SELECT count(*) AS count FROM selfhost_queue_messages")).toEqual([
      { count: 5 },
    ]);
    db.prepare("UPDATE tf_v2_resources SET phase='idle', busy_operation=NULL WHERE uid=?").run(
      QUEUE,
    );
    db.exec("DROP TABLE tf_v2_worker_invocations");
    expect(
      await custody.admitV2Batch({
        claim,
        target,
        messages: [message("legacy-without-invocation-ledger")],
      }),
    ).toBe(true);
  } finally {
    db.close();
  }
});

test("v2 producer admission refuses an exact source invocation retired before the SQLite batch", async () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    seedProducerGraph(db);
    const invocationId = "source-invocation-001";
    const custodyToken = "source-custody-token-001";
    const incarnationId = "v2w-physical-source-001";
    const sourceInvocation = {
      invocationId,
      custodyToken,
      incarnationId,
      servingSourceOperationId: VERSION_OPERATION,
    };
    insertSourceInvocation(db, { invocationId, custodyToken, incarnationId });
    const raw = createSqliteSql(db);
    const batchReached = Promise.withResolvers<void>();
    const resumeBatch = Promise.withResolvers<void>();
    let pauseBatch = false;
    const sql: Sql = {
      ...raw,
      async batch(statements) {
        if (pauseBatch) {
          pauseBatch = false;
          batchReached.resolve();
          await resumeBatch.promise;
        }
        return await raw.batch(statements);
      },
    };
    const custody = createQueueCustody({ sql });
    const claim = { ...producerClaim, sourceInvocation };
    const message = (messageId: string) => ({
      messageId,
      body: new TextEncoder().encode(messageId),
    });
    expect(
      await custody.admitV2Batch({
        claim,
        target: producerTarget,
        messages: [message("live-source")],
      }),
    ).toBe(true);
    pauseBatch = true;
    const pending = custody.admitV2Batch({
      claim,
      target: producerTarget,
      messages: [message("retired-first"), message("retired-second")],
    });
    await batchReached.promise;
    db.prepare(`UPDATE tf_v2_worker_invocations
      SET retired_at_ms = 1600, retirement_receipt_digest = ?
      WHERE invocation_id = ?`).run(`sha256:${"b".repeat(64)}`, invocationId);
    resumeBatch.resolve();
    expect(await pending).toBe(false);
    expect(
      await raw.query("SELECT message_id FROM selfhost_queue_messages ORDER BY message_id"),
    ).toEqual([{ message_id: "live-source" }]);
  } finally {
    db.close();
  }
});

test("v2 source admission rejects malformed, foreign, stale and terminal identities without writes", async () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    seedProducerGraph(db);
    const sourceInvocation = {
      invocationId: "source-live",
      custodyToken: "source-custody-token-live",
      incarnationId: "v2w-physical-source-live",
      servingSourceOperationId: VERSION_OPERATION,
    };
    insertSourceInvocation(db, sourceInvocation);
    const custody = createQueueCustody({ sql: createSqliteSql(db) });
    const attempt = (claim: Parameters<typeof custody.admitV2Batch>[0]["claim"], id: string) =>
      custody.admitV2Batch({
        claim,
        target: producerTarget,
        messages: [{ messageId: id, body: new Uint8Array([70]) }],
      });
    await expect(
      attempt(
        { ...producerClaim, sourceInvocation: undefined } as unknown as Parameters<
          typeof custody.admitV2Batch
        >[0]["claim"],
        "malformed-undefined",
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      attempt(
        { ...producerClaim, sourceInvocation: { ...sourceInvocation, custodyToken: "short" } },
        "malformed-short",
      ),
    ).rejects.toThrow(TypeError);
    for (const [id, source] of [
      ["wrong-invocation", { ...sourceInvocation, invocationId: "not-this-invocation" }],
      ["wrong-token", { ...sourceInvocation, custodyToken: "other-custody-token-live" }],
      ["wrong-native", { ...sourceInvocation, incarnationId: "v2w-other-physical-source" }],
      ["wrong-serving-op", { ...sourceInvocation, servingSourceOperationId: `${DEPLOYMENT}-op` }],
    ] as const) {
      expect(await attempt({ ...producerClaim, sourceInvocation: source }, id)).toBe(false);
    }
    for (const [id, override] of [
      ["foreign-principal", { principal: "org:foreign" }],
      ["foreign-space", { space: "other" }],
      ["foreign-target", { targetKey: "other-target" }],
      ["foreign-worker", { workerUid: BUNDLE }],
      ["foreign-version", { versionUid: BUNDLE }],
      ["stale-version-op", { versionOperationId: `${DEPLOYMENT}-op` }],
      ["unsent", { phase: "admitted" as const }],
      ["refused", { phase: "pre_effect_refused" as const }],
    ] as const) {
      const row = {
        invocationId: id,
        custodyToken: `source-custody-token-${id}`,
        ...override,
      };
      insertSourceInvocation(db, row);
      expect(
        await attempt(
          {
            ...producerClaim,
            sourceInvocation: { ...sourceInvocation, ...row },
          },
          id,
        ),
      ).toBe(false);
    }
    const marked = {
      ...sourceInvocation,
      invocationId: "no-dispatch-marker",
      custodyToken: "source-custody-token-marker",
    };
    insertSourceInvocation(db, marked);
    db.prepare(`UPDATE tf_v2_worker_invocations SET no_native_dispatch_at_ms = 1600
      WHERE invocation_id = ?`).run(marked.invocationId);
    expect(await attempt({ ...producerClaim, sourceInvocation: marked }, "marked")).toBe(false);
    expect(db.prepare("SELECT count(*) AS count FROM selfhost_queue_messages").get()).toEqual({
      count: 0,
    });

    // A same-spec Version update need not retire the exact old physical source.
    const updatedOperation = "producer-version-update-op";
    db.prepare(`INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
       created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
      SELECT ?,resource_uid,principal,?,'fp','update',2,'queued','none',
       created_at,updated_at,retain_until,backend_id,target_key,?,accepted_spec_json
      FROM tf_v2_operations WHERE id=?`).run(
      updatedOperation,
      "replay-version-update",
      "key-version-update",
      VERSION_OPERATION,
    );
    db.prepare(`UPDATE tf_v2_resources
      SET generation=2, phase='pending', busy_operation=?, last_operation=? WHERE uid=?`).run(
      updatedOperation,
      updatedOperation,
      VERSION,
    );
    db.prepare(`INSERT INTO tf_v2_operation_reference_sets (operation_id,sealed)
      VALUES (?,0)`).run(updatedOperation);
    db.prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness)
      SELECT ?,target_uid,form_url,readiness FROM tf_v2_operation_references
      WHERE operation_id=?`).run(updatedOperation, VERSION_OPERATION);
    db.prepare("UPDATE tf_v2_operation_reference_sets SET sealed=1 WHERE operation_id=?").run(
      updatedOperation,
    );
    db.prepare("UPDATE tf_v2_operations SET status='running' WHERE id=?").run(updatedOperation);
    db.prepare("UPDATE tf_v2_operations SET status='reconciling',effect='unknown' WHERE id=?").run(
      updatedOperation,
    );
    db.prepare("UPDATE tf_v2_operations SET status='succeeded',effect='complete' WHERE id=?").run(
      updatedOperation,
    );
    db.prepare(`UPDATE tf_v2_resources
      SET observed_generation=2, phase='idle', busy_operation=NULL WHERE uid=?`).run(VERSION);
    expect(
      await custody.admitV2Batch({
        claim: { ...producerClaim, sourceInvocation },
        target: producerTarget,
        messages: Array.from({ length: 100 }, (_, index) => ({
          messageId: `drain-${index}`,
          body: new Uint8Array([index]),
        })),
      }),
    ).toBe(true);
    expect(db.prepare("SELECT count(*) AS count FROM selfhost_queue_messages").get()).toEqual({
      count: 100,
    });
  } finally {
    db.close();
  }
});

test("real D1 admits one exact v2 Queue producer batch and refuses source or graph drift", async () => {
  const source = new Database(":memory:");
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-queue-producer-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-queue-producer-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    for (const migration of MIGRATIONS) source.exec(migration.sql);
    seedProducerGraph(source);
    const sourceInvocation = {
      invocationId: "producer-d1-source",
      custodyToken: "producer-d1-custody-token",
      incarnationId: "producer-d1-native-incarnation",
      servingSourceOperationId: VERSION_OPERATION,
    };
    insertSourceInvocation(source, sourceInvocation);
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS) {
      for (const statement of splitD1Migration(migration.sql))
        await database.prepare(statement).run();
    }
    const sql = createD1Sql(database);
    await sql.run("DROP TRIGGER tf_v2_operation_reference_set_guard");
    await sql.run("DROP TRIGGER tf_v2_operation_reference_guard");
    for (const table of [
      "tf_v2_resources",
      "tf_v2_operations",
      "tf_v2_operation_reference_sets",
      "tf_v2_operation_references",
      "tf_v2_worker_invocations",
    ]) {
      for (const raw of source.query(`SELECT * FROM ${table}`).all()) {
        const row = raw as Record<string, string | number | null>;
        const entries = Object.entries(row).filter(([name]) => name !== "acceptance_order");
        await sql.run(
          `INSERT INTO ${table} (${entries.map(([name]) => `"${name}"`).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
          entries.map(([, value]) => value),
        );
      }
    }
    const custody = createQueueCustody({ sql });
    const claim = { ...producerClaim, sourceInvocation };
    const admit = (claimForAttempt: typeof claim, messageId: string) =>
      custody.admitV2Batch({
        claim: claimForAttempt,
        target: producerTarget,
        messages: [{ messageId, body: new Uint8Array([77]) }],
      });
    expect(await admit(claim, "d1-first")).toBe(true);
    await expect(admit(claim, "d1-first")).rejects.toThrow("UNIQUE constraint");
    expect(await admit({ ...claim, principal: "org:foreign" }, "d1-foreign")).toBe(false);
    expect(await admit({ ...claim, space: "other" }, "d1-space")).toBe(false);
    expect(
      await admit({ ...claim, workerVersionOperationId: `${DEPLOYMENT}-op` }, "d1-stale-op"),
    ).toBe(false);
    await sql.run("UPDATE tf_v2_resources SET observed_json=? WHERE uid=?", [
      '{"ready":false}',
      VERSION,
    ]);
    expect(await admit(claim, "d1-stale-version")).toBe(false);
    await sql.run("UPDATE tf_v2_resources SET observed_json=? WHERE uid=?", [
      '{"ready":true,"resolvedBindings":true,"bundleVerified":true}',
      VERSION,
    ]);
    expect(
      await admit(
        {
          ...claim,
          sourceInvocation: { ...sourceInvocation, custodyToken: "different-custody-token" },
        },
        "d1-lease",
      ),
    ).toBe(false);
    const lostAckSql: Sql = {
      ...sql,
      async batch(statements) {
        await sql.batch(statements);
        throw new Error("fixture-lost-ack-after-commit");
      },
    };
    await expect(
      createQueueCustody({ sql: lostAckSql }).admitV2Batch({
        claim,
        target: producerTarget,
        messages: [{ messageId: "d1-lost-ack", body: new Uint8Array([78]) }],
      }),
    ).rejects.toThrow("fixture-lost-ack-after-commit");
    await expect(admit(claim, "d1-lost-ack")).rejects.toThrow("UNIQUE constraint");
    await sql.run(
      "UPDATE tf_v2_worker_invocations SET retired_at_ms=?, retirement_receipt_digest=? WHERE invocation_id=?",
      [Date.now(), `sha256:${"b".repeat(64)}`, sourceInvocation.invocationId],
    );
    expect(await admit(claim, "d1-retired")).toBe(false);
    expect(
      await sql.query("SELECT message_id FROM selfhost_queue_messages ORDER BY message_id"),
    ).toEqual([{ message_id: "d1-first" }, { message_id: "d1-lost-ack" }]);
  } finally {
    source.close();
    await runtime.dispose();
  }
});

function splitD1Migration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
