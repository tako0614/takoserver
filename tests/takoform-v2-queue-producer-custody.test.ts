import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import type { Sql } from "../src/ports.ts";
import { createSelfhostV2QueueProducerBroker } from "../src/providers/selfhost-v2-queue-producer-broker.ts";
import {
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_QUEUE_PATH,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
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

test("v2 producer admission is atomic with live Queue and sealed Version reference", async () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    const queueSpec = JSON.stringify({ messageRetentionSeconds: 3600 });
    settled(db, {
      uid: QUEUE,
      form: AT_LEAST_ONCE_QUEUE_FORM_URL,
      backend: V2_QUEUE_BACKEND_ID,
      spec: queueSpec,
      observed: '{"queueExists":true}',
    });
    settled(db, {
      uid: WORKER,
      form: MODULE_WORKER_FORM_URL,
      backend: "worker-backend",
      spec: "{}",
      observed: '{"ready":true}',
    });
    settled(db, {
      uid: BUNDLE,
      form: "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/",
      backend: "worker-backend",
      spec: "{}",
      observed: "{}",
    });
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
    db.prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness) VALUES (?,?,?,'observed')`).run(
      VERSION_OPERATION,
      QUEUE,
      AT_LEAST_ONCE_QUEUE_FORM_URL,
    );
    db.prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness) VALUES (?,?,?,'observed')`).run(
      VERSION_OPERATION,
      WORKER,
      MODULE_WORKER_FORM_URL,
    );
    db.prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness) VALUES (?,?,?,'observed')`).run(
      VERSION_OPERATION,
      BUNDLE,
      "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/",
    );
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
    const claim = {
      principal: "org:one",
      space: "prod",
      targetKey: TARGET,
      queueUid: QUEUE,
      workerUid: WORKER,
      workerVersionUid: VERSION,
      workerVersionOperationId: VERSION_OPERATION,
      bindingName: BINDING,
    };
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
    const target = {
      queueId: v2QueueId(QUEUE),
      messageRetentionSeconds: 3600,
      deliveryDelaySeconds: 0,
    };
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
  } finally {
    db.close();
  }
});
