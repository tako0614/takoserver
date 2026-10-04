import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider, selfhostVersionBindingsRoot } from "../src/providers/selfhost.ts";
import {
  createSelfhostVersionBindingStore,
  deriveSelfhostWorkflowBindingToken,
} from "../src/providers/selfhost-version-bindings.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import type { TakoformStoredRelation } from "../src/takoform/relations.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import type { WorkerdSite } from "../src/workerd-runtime.ts";
import { createWorkflowResourceGraphReader } from "../src/workflow-resource-graph.ts";

const NOW = Date.UTC(2026, 9, 4);
const TENANT = "org_demo";
const WORKER_UID = "uid-worker-canonical";
const WORKFLOW_UID = "uid-workflow-canonical";
const VERSION_UID = "uid-version-canonical";
const BUNDLE_UID = "uid-bundle-canonical";
const apiVersion = "edge.forms.takoform.com";
const forward = forwardTakoformCandidates();

function selectedForm(kind: string): InstalledTakoformForm {
  const selected = forward.forms.find((entry) => entry.identity.formRef.kind === kind);
  if (!selected) throw new Error(`selected ${kind} Form unavailable`);
  return selected;
}

function offering(kind: string, form = selectedForm(kind)): ProviderOffering {
  return {
    id: `selfhost.${kind}`,
    kind: `takoform.${kind}`,
    displayName: kind,
    form: form.identity.formRef,
    providedInterfaces: [],
    bindingRefs: kind === "WorkerVersion" ? [workflowBinding.bindingRef] : [],
    capabilities: ["create", "delete", "import", "observe"],
  };
}

const workerForm = selectedForm("ModuleWorker");
const workflowForm = selectedForm("DurableWorkflow");
const versionForm = selectedForm("WorkerVersion");
const bundleForm = selectedForm("WorkerBundle");
const workflowBinding = (() => {
  const selected = forward.bindings.find(
    (entry) => entry.bindingRef.name === "module-worker.workflow",
  );
  if (!selected) throw new Error("selected Workflow Binding unavailable");
  return selected;
})();
const workflowInterfaceRef = workflowForm.providedInterfaces?.find(
  (entry) => entry.name === "worker.workflow",
);
if (!workflowInterfaceRef) throw new Error("selected Workflow Interface unavailable");
const address = (kind: string, name: string) => ({ apiVersion, kind, name });
const identity = (name: string, uid: string) => ({
  tenantRef: TENANT,
  space: "default",
  name,
  uid,
});

async function insertLiveResource(
  sql: Sql,
  form: InstalledTakoformForm,
  uid: string,
  name: string,
  spec: Record<string, unknown>,
  relations: readonly TakoformStoredRelation[] = [],
): Promise<void> {
  const resource = {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: form.identity,
    metadata: { space: "default", name, uid, generation: "1", revision: "1" },
    spec,
    status: { observedGeneration: "1", conditions: [] },
  };
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, relations_json, updated_at)
     VALUES (?, 'default', ?, ?, ?, ?, '1', '1', ?, ?, ?)`,
    [
      TENANT,
      resource.apiVersion,
      resource.kind,
      name,
      uid,
      JSON.stringify(resource),
      JSON.stringify(relations),
      NOW,
    ],
  );
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, created_at, updated_at)
     VALUES (?, ?, 'default', ?, ?, ?, ?, 'live', 1, '[]', ?, ?)`,
    [
      TENANT,
      uid,
      resource.apiVersion,
      resource.kind,
      name,
      canonicalJson(form.identity.formRef),
      NOW,
      NOW,
    ],
  );
}

test("a canonical live Workflow graph pins the first V10 Version and later runtime projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-version-authority-integrated-"));
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const clock = () => new Date(NOW);
    const store = createTakoformStore(sql, clock);
    const deployments = createResourceDeploymentStore(sql, clock);
    const readCurrentGraph = createWorkflowResourceGraphReader({ store, form: workflowForm });
    let publishedSite: WorkerdSite | undefined;
    const provider = createSelfhostProvider({
      offerings: [offering("DurableWorkflow")],
      dataRoot: root,
      runtime: {
        async inspectModule(input) {
          return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
        },
        async write(_script, site) {
          publishedSite = site;
        },
        async remove() {},
        async reload() {},
        async has() {
          return false;
        },
      },
      artifacts: {
        async manifest(_tenant, digest) {
          return digest === "sha256:worker"
            ? {
                kind: "WorkerBundle",
                mainModule: "index.js",
                modules: [{ name: "index.js", digest: "sha256:module" }],
              }
            : null;
        },
        async blob(digest) {
          return digest === "sha256:module"
            ? new TextEncoder().encode("export default { fetch() { return new Response('ok'); } };")
            : null;
        },
      },
      workflowVersionAuthority: {
        readCurrentGraph,
        async readVersionDeployment({ tenantId, workerVersionResourceUid }) {
          return deployments.active(tenantId, workerVersionResourceUid);
        },
      },
    });

    const workerTicket = await provider.apply({
      operationId: "op-worker-canonical",
      offering: offering("ModuleWorker"),
      identity: identity("worker", WORKER_UID),
      spec: {},
    });
    expect(workerTicket.phase).toBe("succeeded");
    if (workerTicket.phase !== "succeeded") return;
    const script = String(workerTicket.result.outputs.scriptName);
    await insertLiveResource(sql, workerForm, WORKER_UID, "worker", {});
    await deployments.create({
      tenantId: TENANT,
      id: "dep-worker-canonical",
      resourceUid: WORKER_UID,
      offeringId: "selfhost.ModuleWorker",
      providerPackRef: "local",
      providerInstallationRef: "local.primary",
      nativeId: workerTicket.result.nativeId,
      state: "active",
      observed: {},
      outputs: workerTicket.result.outputs,
    });
    const workerRelation: TakoformStoredRelation = {
      pointer: "/worker",
      relation: "/worker",
      targetApiVersion: apiVersion,
      targetKind: "ModuleWorker",
      targetName: "worker",
      targetUid: WORKER_UID,
      targetRevision: "1",
      targetFormRef: workerForm.identity.formRef,
    };
    await insertLiveResource(
      sql,
      workflowForm,
      WORKFLOW_UID,
      "flow",
      {
        className: "Flow",
        worker: address("ModuleWorker", "worker"),
      },
      [workerRelation],
    );
    await insertLiveResource(sql, bundleForm, BUNDLE_UID, "bundle", {
      manifestDigest: "sha256:worker",
    });
    const graph = await readCurrentGraph(
      { tenantId: TENANT, workflowResourceUid: WORKFLOW_UID },
      new AbortController().signal,
    );
    expect(graph).toMatchObject({
      tenantId: TENANT,
      workflow: { uid: WORKFLOW_UID, formRef: workflowForm.identity.formRef, className: "Flow" },
      worker: { uid: WORKER_UID, formRef: workerForm.identity.formRef },
      runtimeClassRef: workflowInterfaceRef,
    });
    const worker = await store.resourceByUid(TENANT, WORKER_UID);
    const workflow = await store.resourceByUid(TENANT, WORKFLOW_UID);
    const bundle = await store.resourceByUid(TENANT, BUNDLE_UID);
    const workerDeployment = await deployments.active(TENANT, WORKER_UID);
    if (!worker || !workflow || !bundle || !workerDeployment)
      throw new Error("canonical Version relations unavailable");
    const versionSpec = {
      worker: address("ModuleWorker", "worker"),
      bundle: address("WorkerBundle", "bundle"),
      handlers: ["fetch"],
      workflowBindings: [{ name: "FLOW", resource: address("DurableWorkflow", "flow") }],
    };
    const providerWorkerRelation: ProviderRelation = {
      pointer: "/worker",
      relation: "/worker",
      targetUid: WORKER_UID,
      resource: worker.resource,
      deployment: workerDeployment,
    };
    const providerBundleRelation: ProviderRelation = {
      pointer: "/bundle",
      relation: "/bundle",
      targetUid: BUNDLE_UID,
      resource: bundle.resource,
    };
    const providerWorkflowRelation: ProviderRelation = {
      pointer: "/workflowBindings/0/resource",
      relation: "/workflowBindings/*/resource",
      targetUid: WORKFLOW_UID,
      bindingRef: workflowBinding.bindingRef,
      resource: workflow.resource,
    };
    const versionInput = {
      operationId: "op-version-canonical",
      offering: offering("WorkerVersion"),
      identity: identity("version", VERSION_UID),
      spec: versionSpec,
      relations: [providerWorkerRelation, providerBundleRelation, providerWorkflowRelation],
    };
    expect(await deployments.active(TENANT, VERSION_UID)).toBeNull();
    await sql.run(
      "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, WORKFLOW_UID],
    );
    expect(
      await readCurrentGraph(
        { tenantId: TENANT, workflowResourceUid: WORKFLOW_UID },
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(
      await provider.apply({ ...versionInput, operationId: "op-workflow-not-live" }),
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    await sql.run(
      "UPDATE tf_resource_deletion_attestations SET state = 'live' WHERE tenant_id = ? AND resource_uid = ?",
      [TENANT, WORKFLOW_UID],
    );
    const versionTicket = await provider.apply(versionInput);
    expect(versionTicket.phase).toBe("succeeded");
    if (versionTicket.phase !== "succeeded") return;
    const digestValue = versionTicket.result.observed.workflowBindingsDigest;
    if (typeof digestValue !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digestValue)) {
      throw new Error("Version has no exact Workflow digest");
    }
    const digest = digestValue as `sha256:${string}`;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(versionTicket.result.outputs.workflowBindingsDigest).toBeUndefined();

    await insertLiveResource(sql, versionForm, VERSION_UID, "version", versionSpec, [
      workerRelation,
      {
        pointer: "/bundle",
        relation: "/bundle",
        targetApiVersion: apiVersion,
        targetKind: "WorkerBundle",
        targetName: "bundle",
        targetUid: BUNDLE_UID,
        targetRevision: "1",
        targetFormRef: bundleForm.identity.formRef,
      },
      {
        pointer: "/workflowBindings/0/resource",
        relation: "/workflowBindings/*/resource",
        targetApiVersion: apiVersion,
        targetKind: "DurableWorkflow",
        targetName: "flow",
        targetUid: WORKFLOW_UID,
        targetRevision: "1",
        targetFormRef: workflowForm.identity.formRef,
        bindingRef: workflowBinding.bindingRef,
      },
    ]);
    await deployments.create({
      tenantId: TENANT,
      id: "dep-version-canonical",
      resourceUid: VERSION_UID,
      offeringId: "selfhost.WorkerVersion",
      providerPackRef: "local",
      providerInstallationRef: "local.primary",
      nativeId: versionTicket.result.nativeId,
      state: "active",
      observed: versionTicket.result.observed,
      outputs: versionTicket.result.outputs,
    });
    const canonicalVersion = await deployments.active(TENANT, VERSION_UID);
    expect(canonicalVersion?.observed.workflowBindingsDigest).toBe(digest);
    expect(canonicalVersion?.nativeId).toBe(versionTicket.result.nativeId);
    const recordedBindings = await createSelfhostVersionBindingStore({
      root: selfhostVersionBindingsRoot(root),
    }).read(script, String(versionTicket.result.observed.versionId));
    if (!recordedBindings?.eventToken || !recordedBindings.workflowBindings?.[0]) {
      throw new Error("durable V10 binding and token unavailable");
    }
    expect(recordedBindings.digest).toBe(digest);
    const expectedToken = deriveSelfhostWorkflowBindingToken({
      eventToken: recordedBindings.eventToken,
      workerVersionResourceUid: VERSION_UID,
      binding: recordedBindings.workflowBindings[0],
    });
    const selectedVersion = await store.resourceByUid(TENANT, VERSION_UID);
    if (!selectedVersion) throw new Error("canonical Version Resource unavailable");
    const deploymentTicket = await provider.apply({
      operationId: "op-deployment-canonical",
      offering: offering("WorkerDeployment"),
      identity: identity("deployment", "uid-deployment-canonical"),
      spec: {
        worker: address("ModuleWorker", "worker"),
        versions: [{ workerVersion: address("WorkerVersion", "version"), weight: 10_000 }],
      },
      relations: [
        providerWorkerRelation,
        {
          pointer: "/versions/0/workerVersion",
          relation: "/versions/*/workerVersion",
          targetUid: VERSION_UID,
          resource: selectedVersion.resource,
        },
      ],
    });
    expect(deploymentTicket.phase).toBe("succeeded");
    expect(publishedSite?.workflowForward).toMatchObject({
      schema: "takoserver.selfhost-workflow-binding-forward@v1",
      snapshotDigest: digest,
      bindings: [
        {
          publicName: "FLOW",
          tenantId: TENANT,
          workflowResourceUid: WORKFLOW_UID,
          workflowFormRef: workflowForm.identity.formRef,
          bindingRef: workflowBinding.bindingRef,
          runtimeClassRef: workflowInterfaceRef,
          token: expectedToken,
        },
      ],
    });
    expect(publishedSite?.workflowForward?.bindings[0]?.serviceName).toMatch(
      /^__TAKOSERVER_WORKFLOW_BINDING_[0-9]{5}$/u,
    );
    const publishedVersion = currentTakoformCandidates().forms.find(
      (entry) => entry.identity.formRef.kind === "WorkerVersion",
    );
    if (!publishedVersion) throw new Error("published WorkerVersion unavailable");
    const legacy = await provider.apply({
      ...versionInput,
      operationId: "op-old-published-version",
      offering: offering("WorkerVersion", publishedVersion),
    });
    expect(legacy).toMatchObject({ phase: "failed", failure: { code: "denied" } });
    expect(script).toBeTruthy();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
