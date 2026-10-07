import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  DURABLE_WORKFLOW_FORM_URL,
  durableWorkflowReferences,
  parseDurableWorkflowSpec,
  validateDurableWorkflowUpdate,
} from "../src/takoform-v2/forms/durable-workflow.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { referencesForWorkerVersion } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerVersionSpec,
  validateWorkerVersionUpdate,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { DURABLE_WORKFLOW_BACKEND_ID } from "../src/takoform-v2/workflow-backend.ts";
import { createV2WorkflowBindingAuthority } from "../src/takoform-v2/workflow-binding-authority.ts";

const PRINCIPAL = "org:workflow-binding";
const SPACE = "production";
const TARGET = "selfhost-workflow-binding-test";
const counts = {
  queued: 0,
  running: 0,
  sleeping: 0,
  waiting: 0,
  complete: 0,
  errored: 0,
  terminated: 0,
};

test("an accepted Workflow UID is bindable before it is Ready, and same-spec generations preserve the source", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const complete = (observed: JsonObject = {}, id = "workflow-binding-fixture") => ({
      id,
      targetKey: TARGET,
      execute: async () => ({ kind: "complete" as const, observed, output: {} }),
      reconcile: async () => ({ kind: "unknown" as const }),
    });
    const engine = createTakoformV2Engine({
      sql,
      now: () => new Date(),
      leaseMilliseconds: 60_000,
      replayWindowSeconds: 3600,
      authorize: async () => true,
      forms: {
        [MODULE_WORKER_FORM_URL]: {
          validateCreate: parseModuleWorkerSpec,
          validateUpdate: (_previous, next) => parseModuleWorkerSpec(next),
          backend: complete(),
        },
        [WORKER_BUNDLE_FORM_URL]: {
          validateCreate: () => undefined,
          validateUpdate: () => undefined,
          backend: complete(),
        },
        [DURABLE_WORKFLOW_FORM_URL]: {
          validateCreate: parseDurableWorkflowSpec,
          validateUpdate: validateDurableWorkflowUpdate,
          references: (spec) => durableWorkflowReferences(parseDurableWorkflowSpec(spec)),
          backend: complete({ ready: false, instanceCounts: counts }, DURABLE_WORKFLOW_BACKEND_ID),
        },
        [WORKER_VERSION_FORM_URL]: {
          validateCreate: parseWorkerVersionSpec,
          validateUpdate: validateWorkerVersionUpdate,
          references: (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
          backend: complete({ ready: true, resolvedBindings: true, bundleVerified: true }),
        },
      },
    });
    const create = async (form: string, name: string, spec: JsonObject) => {
      const operation = await engine.acceptCreate({
        principal: PRINCIPAL,
        key: `workflow-binding-${name}-create-key`,
        input: { form, space: SPACE, name, spec },
      });
      expect(await engine.runNext()).toMatchObject({ id: operation.id, status: "succeeded" });
      return operation;
    };
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {});
    const workflowSpec = {
      worker: { resourceUid: worker.resourceUid },
      className: "ReportWorkflow",
    };
    const workflow = await create(DURABLE_WORKFLOW_FORM_URL, "workflow", workflowSpec);
    const versionSpec = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      workflowBindings: [{ name: "FLOW", resource: { resourceUid: workflow.resourceUid } }],
    };
    const version = await create(WORKER_VERSION_FORM_URL, "version", versionSpec);
    const authority = createV2WorkflowBindingAuthority({ sql, targetKey: TARGET });
    const nativeVersionId = `v2-${createHash("sha256")
      .update(`${version.resourceUid}\u00001`)
      .digest("hex")}`;
    const claim = {
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      workerUid: worker.resourceUid,
      workerVersionUid: version.resourceUid,
      workerVersionOperationId: version.id,
      nativeVersionId,
      bindings: [{ name: "FLOW", resourceUid: workflow.resourceUid }],
    };
    expect(
      await authority.resolveTarget({
        principal: PRINCIPAL,
        space: SPACE,
        targetKey: TARGET,
        workflowResourceUid: workflow.resourceUid,
      }),
    ).toMatchObject({
      tenantId: PRINCIPAL,
      workflowResourceUid: workflow.resourceUid,
      workerUid: worker.resourceUid,
      className: "ReportWorkflow",
    });
    expect(await authority.resolveCurrentBinding(claim, "FLOW")).toMatchObject({
      tenantId: PRINCIPAL,
      workflowResourceUid: workflow.resourceUid,
      className: "ReportWorkflow",
    });
    expect(
      await authority.resolveCurrentBinding({ ...claim, principal: "org:other" }, "FLOW"),
    ).toBeNull();
    expect(await authority.resolveCurrentBinding(claim, "OTHER")).toBeNull();

    const workflowUpdate = await engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "workflow-binding-workflow-update-key",
      uid: workflow.resourceUid,
      expectedGeneration: 1,
      spec: workflowSpec,
    });
    expect(await authority.resolveCurrentBinding(claim, "FLOW")).not.toBeNull();
    expect(await engine.runNext()).toMatchObject({ id: workflowUpdate.id, status: "succeeded" });
    const versionUpdate = await engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "workflow-binding-version-update-key",
      uid: version.resourceUid,
      expectedGeneration: 1,
      spec: versionSpec,
    });
    expect(await authority.resolveCurrentBinding(claim, "FLOW")).not.toBeNull();
    expect(await engine.runNext()).toMatchObject({ id: versionUpdate.id, status: "succeeded" });
    expect(await authority.resolveCurrentBinding(claim, "FLOW")).not.toBeNull();

    await sql.run(
      "DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?",
      [version.resourceUid, workflow.resourceUid],
    );
    expect(await authority.resolveCurrentBinding(claim, "FLOW")).toBeNull();
  } finally {
    db.close();
  }
});
