import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";
import { createV2WorkerInvocationLifecycle } from "../src/takoform-v2/worker-invocation-custody.ts";

test("Version DELETE waits for no-send or a positive native retirement receipt", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    // This adapter isolates SQL acceptance/error classification. It is not a
    // Worker ABI, publication, or invocation-admission qualification.
    const form: V2Form = {
      validateCreate() {},
      validateUpdate() {},
      backend: {
        id: "reference-test-backend",
        targetKey: "reference-test-target",
        async execute() {
          return { kind: "complete", observed: {}, output: {} };
        },
        async reconcile() {
          return { kind: "unknown" };
        },
      },
    };
    const engine = createTakoformV2Engine({
      sql,
      authorize: async () => true,
      replayWindowSeconds: 3600,
      forms: {
        [MODULE_WORKER_FORM_URL]: form,
        [WORKER_VERSION_FORM_URL]: form,
        [WORKER_DEPLOYMENT_FORM_URL]: form,
        [WORKER_ENDPOINT_FORM_URL]: form,
      },
    });
    async function create(formUrl: string, name: string) {
      const accepted = await engine.acceptCreate({
        principal: "org-1",
        key: `reference-create-${name}-0001`,
        input: { form: formUrl, space: "default", name, spec: {} },
      });
      expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
      return accepted;
    }
    const worker = await create(MODULE_WORKER_FORM_URL, "worker");
    const version = await create(WORKER_VERSION_FORM_URL, "version");
    const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment");
    const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint");
    const handle = { invocationId: "reference-invocation", custodyToken: "reference-token-0001" };
    // An admitted-but-unsent durable invocation is the minimal live-reference
    // case. No native dispatch or completion is inferred from this fixture row.
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id, custody_token, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms)
       VALUES (?, ?, 'reference-test-backend', 'reference-test-target', 'org-1', 'default',
         ?, ?, 1, ?, ?, 1, ?, 1, ?, 'reference-native-identity', ?, 'reference-receipt', 1000)`,
      [
        handle.invocationId,
        handle.custodyToken,
        worker.resourceUid,
        deployment.resourceUid,
        deployment.id,
        endpoint.resourceUid,
        version.resourceUid,
        version.id,
        `sha256:${"a".repeat(64)}`,
      ],
    );
    const deletion = {
      principal: "org-1",
      key: "reference-version-delete-0001",
      uid: version.resourceUid,
      expectedGeneration: 1,
    };
    await expect(engine.acceptDelete(deletion)).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    expect(
      await engine.getResource({ principal: "org-1", uid: version.resourceUid }),
    ).toMatchObject({
      generation: 1,
      phase: "idle",
      lastOperation: version.id,
    });
    expect(
      await sql.query("SELECT id FROM tf_v2_operations WHERE replay_key = ?", [deletion.key]),
    ).toHaveLength(0);
    const custody = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
    expect(await custody.refuseBeforeSend(handle)).toBe(true);
    const sent = {
      invocationId: "reference-sent-invocation",
      custodyToken: "reference-sent-token-0001",
    };
    const closureDigest = `sha256:${"a".repeat(64)}` as const;
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id, custody_token, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms)
       VALUES (?, ?, 'reference-test-backend', 'reference-test-target', 'org-1', 'default',
         ?, ?, 1, ?, ?, 1, ?, 1, ?, 'reference-native-identity', ?, 'reference-receipt', 1000)`,
      [
        sent.invocationId,
        sent.custodyToken,
        worker.resourceUid,
        deployment.resourceUid,
        deployment.id,
        endpoint.resourceUid,
        version.resourceUid,
        version.id,
        closureDigest,
      ],
    );
    expect(await custody.beginSend(sent)).toBe(true);
    expect(await custody.observeBody(sent, "finished")).toBe(true);
    await expect(engine.acceptDelete(deletion)).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    // The native invocation belongs to its immutable admitted Version and
    // Deployment, not whatever generations become current while it drains.
    const versionUpdate = await engine.acceptUpdate({
      principal: "org-1",
      key: "reference-version-update-0001",
      uid: version.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await engine.runNext()).toMatchObject({ id: versionUpdate.id, status: "succeeded" });
    const deploymentUpdate = await engine.acceptUpdate({
      principal: "org-1",
      key: "reference-deployment-update-0001",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await engine.runNext()).toMatchObject({ id: deploymentUpdate.id, status: "succeeded" });
    const deploymentDelete = await engine.acceptDelete({
      principal: "org-1",
      key: "reference-deployment-delete-0001",
      uid: deployment.resourceUid,
      expectedGeneration: 2,
    });
    expect(deploymentDelete).toMatchObject({ generation: 3, status: "queued" });
    expect(
      await custody.confirmNativeRetirement({
        handle: sent,
        expected: {
          backendId: "reference-test-backend",
          targetKey: "reference-test-target",
          principal: "org-1",
          space: "default",
          workerUid: worker.resourceUid,
          deploymentUid: deployment.resourceUid,
          deploymentGeneration: 1,
          sourceOperationId: deployment.id,
          ingress: { kind: "endpoint", endpointUid: endpoint.resourceUid, endpointGeneration: 1 },
          versionUid: version.resourceUid,
          versionGeneration: 1,
          versionOperationId: version.id,
          nativeIdentity: "reference-native-identity",
          closureDigest,
          confirmedReceipt: "reference-receipt",
        },
        receiptDigest: `sha256:${"b".repeat(64)}`,
      }),
    ).toBe(true);
    expect(await custody.inspectDeployment(deployment.resourceUid)).toEqual({
      outstanding: 0,
      bodyFinished: 0,
    });
    // This dummy backend only checks the public acceptance/drain boundary;
    // it does not stand in for native child or publication retirement.
    expect(await engine.runNext()).toMatchObject({ id: deploymentDelete.id, status: "succeeded" });
    const settledDelete = { ...deletion, expectedGeneration: 2 };
    const accepted = await engine.acceptDelete(settledDelete);
    expect(accepted).toMatchObject({ action: "delete", generation: 3, status: "queued" });
    expect(await engine.acceptDelete(settledDelete)).toEqual(accepted);
  } finally {
    db.close();
  }
});
