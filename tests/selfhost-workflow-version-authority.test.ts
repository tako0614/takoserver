import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "../src/ports.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import type { WorkerdSite } from "../src/workerd-runtime.ts";

const source = forwardTakoformCandidates();
const form = (kind: string) => {
  const found = source.forms.find((entry) => entry.identity.formRef.kind === kind);
  if (!found) throw new Error(`missing forward Form ${kind}`);
  return found;
};
const workerForm = form("ModuleWorker").identity.formRef;
const versionForm = form("WorkerVersion").identity.formRef;
const workflowForm = form("DurableWorkflow").identity.formRef;
const binding = source.bindings.find((entry) => entry.bindingRef.name === "module-worker.workflow");
if (!binding) throw new Error("missing forward Workflow Binding");
const bindingRef = binding.bindingRef;
const runtimeClassRef = form("DurableWorkflow").providedInterfaces?.find(
  (entry) => entry.name === "worker.workflow",
);
if (!runtimeClassRef) throw new Error("missing forward Workflow Interface");
const apiVersion = "edge.forms.takoform.com";
const tenantId = "org_demo";
const workerUid = "uid-worker-demo";
const versionUid = "uid-version-demo";
const workflowUid = "uid-workflow-demo";
const address = (kind: string, name: string) => ({ apiVersion, kind, name });
const identity = (name: string, uid: string) => ({
  tenantRef: tenantId,
  space: "default",
  name,
  uid,
});
const offering = (kind: string, selected = true): ProviderOffering => ({
  id: `selfhost.${kind}`,
  kind: `takoform.${kind}`,
  displayName: kind,
  form: selected ? form(kind).identity.formRef : { ...versionForm, definitionVersion: "0.3.0" },
  providedInterfaces: [],
  bindingRefs: kind === "WorkerVersion" ? [bindingRef] : [],
  capabilities: ["create", "delete", "import", "observe"],
});

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test("unpublished V10 records an exact Workflow pin before the first WorkerDeployment", async () => {
  root = mkdtempSync(join(tmpdir(), "selfhost-workflow-v10-"));
  let graphWorkerUid = workerUid;
  let graphTenantId = tenantId;
  let publishedSite: WorkerdSite | undefined;
  const deployments = new Map<string, { observed: JsonObject; nativeId: string }>();
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
      async readCurrentGraph() {
        return {
          tenantId: graphTenantId,
          workflow: {
            address: { space: "default", ...address("DurableWorkflow", "flow") },
            uid: workflowUid,
            generation: "1",
            revision: "1",
            formRef: workflowForm,
            className: "Flow",
          },
          worker: {
            address: { space: "default", ...address("ModuleWorker", "worker") },
            uid: graphWorkerUid,
            generation: "1",
            revision: "1",
            formRef: workerForm,
          },
          runtimeClassRef,
        };
      },
      async readVersionDeployment({ workerVersionResourceUid }) {
        const deployment = deployments.get(workerVersionResourceUid);
        return deployment
          ? {
              tenantId,
              resourceUid: workerVersionResourceUid,
              state: "active",
              providerPackRef: "local",
              providerInstallationRef: "local.primary",
              nativeId: deployment.nativeId,
              observed: deployment.observed,
            }
          : null;
      },
    },
  });
  const allocated = await provider.apply({
    operationId: "op-worker",
    offering: offering("ModuleWorker"),
    identity: identity("worker", workerUid),
    spec: {},
  });
  expect(allocated.phase).toBe("succeeded");
  if (allocated.phase !== "succeeded") return;
  const script = String(allocated.result.outputs.scriptName);
  const workerResource = {
    apiVersion,
    kind: "ModuleWorker",
    form: { formRef: workerForm },
    metadata: { name: "worker", space: "default", uid: workerUid, generation: "1", revision: "1" },
    spec: {},
  };
  const workerRelation: ProviderRelation = {
    pointer: "/worker",
    relation: "/worker",
    targetUid: workerUid,
    resource: workerResource,
    deployment: {
      tenantId,
      id: "dep-worker",
      resourceUid: workerUid,
      offeringId: "selfhost.ModuleWorker",
      providerPackRef: "local",
      providerInstallationRef: "local.primary",
      nativeId: allocated.result.nativeId,
      state: "active",
      observed: {},
      outputs: allocated.result.outputs,
      createdAt: "2026-10-04T00:00:00Z",
      updatedAt: "2026-10-04T00:00:00Z",
    },
  };
  const workflowRelation: ProviderRelation = {
    pointer: "/workflowBindings/0/resource",
    relation: "/workflowBindings/*/resource",
    targetUid: workflowUid,
    bindingRef,
    resource: {
      apiVersion,
      kind: "DurableWorkflow",
      form: { formRef: workflowForm },
      metadata: {
        name: "flow",
        space: "default",
        uid: workflowUid,
        generation: "1",
        revision: "1",
      },
      spec: { className: "Flow", worker: address("ModuleWorker", "worker") },
    },
  };
  const input = {
    operationId: "op-version",
    offering: offering("WorkerVersion"),
    identity: identity("version", versionUid),
    spec: {
      worker: address("ModuleWorker", "worker"),
      bundle: address("WorkerBundle", "bundle"),
      handlers: ["fetch"],
      workflowBindings: [{ name: "FLOW", resource: address("DurableWorkflow", "flow") }],
    },
    relations: [
      workerRelation,
      {
        pointer: "/bundle",
        relation: "/bundle",
        targetUid: "uid-bundle-demo",
        resource: {
          apiVersion,
          kind: "WorkerBundle",
          form: { formRef: versionForm },
          metadata: {
            name: "bundle",
            space: "default",
            uid: "uid-bundle-demo",
            generation: "1",
            revision: "1",
          },
          spec: { manifestDigest: "sha256:worker" },
        },
      },
      workflowRelation,
    ],
  };
  const ticket = await provider.apply(input);
  expect(ticket).toMatchObject({ phase: "succeeded" });
  if (ticket.phase !== "succeeded") return;
  expect(ticket.result.observed.workflowBindingsDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(ticket.result.outputs.workflowBindingsDigest).toBeUndefined();
  graphWorkerUid = "uid-worker-replaced";
  const staleGraph = await provider.apply({ ...input, operationId: "op-stale-graph" });
  expect(staleGraph).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  graphWorkerUid = workerUid;
  graphTenantId = "org_other";
  const wrongTenant = await provider.apply({ ...input, operationId: "op-wrong-tenant" });
  expect(wrongTenant).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  graphTenantId = tenantId;
  const wrongBinding = await provider.apply({
    ...input,
    operationId: "op-wrong-binding",
    relations: input.relations.map((relation) =>
      relation === workflowRelation
        ? { ...relation, bindingRef: { ...bindingRef, version: "2.0.0" } }
        : relation,
    ),
  });
  expect(wrongBinding).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  deployments.set(versionUid, {
    nativeId: ticket.result.nativeId,
    observed: ticket.result.observed,
  });
  const observed = await provider.observe({
    offering: input.offering,
    nativeId: ticket.result.nativeId,
    identity: input.identity,
    spec: input.spec,
    relations: input.relations,
  });
  expect(observed).toMatchObject({
    phase: "succeeded",
    result: { observed: { workflowBindingsDigest: ticket.result.observed.workflowBindingsDigest } },
  });
  const recovered = await provider.apply({ ...input, operationMode: "recovery" });
  expect(recovered).toMatchObject({
    phase: "succeeded",
    result: { observed: { workflowBindingsDigest: ticket.result.observed.workflowBindingsDigest } },
  });
  const published = await provider.apply({
    ...input,
    operationId: "op-published",
    offering: offering("WorkerVersion", false),
  });
  expect(published).toMatchObject({ phase: "failed", failure: { code: "denied" } });
  deployments.set(versionUid, {
    nativeId: ticket.result.nativeId,
    observed: { ...ticket.result.observed, workflowBindingsDigest: `sha256:${"0".repeat(64)}` },
  });
  const rotated = await provider.observe({
    offering: input.offering,
    nativeId: ticket.result.nativeId,
    identity: input.identity,
    spec: input.spec,
    relations: input.relations,
  });
  expect(rotated).toMatchObject({ phase: "failed", failure: { code: "conflict" } });
  const rotatedRetry = await provider.apply({ ...input, operationMode: "recovery" });
  expect(rotatedRetry).toMatchObject({ phase: "failed", failure: { code: "conflict" } });
  deployments.delete(versionUid);
  const withoutCanonicalPin = await provider.apply({
    operationId: "op-deployment",
    offering: offering("WorkerDeployment"),
    identity: identity("deployment", "uid-deployment-demo"),
    spec: {
      worker: address("ModuleWorker", "worker"),
      versions: [{ workerVersion: address("WorkerVersion", "version"), weight: 10_000 }],
    },
    relations: [
      workerRelation,
      {
        pointer: "/versions/0/workerVersion",
        relation: "/versions/*/workerVersion",
        targetUid: versionUid,
        resource: {
          apiVersion,
          kind: "WorkerVersion",
          form: { formRef: versionForm },
          metadata: {
            name: "version",
            space: "default",
            uid: versionUid,
            generation: "1",
            revision: "1",
          },
          spec: input.spec,
        },
      },
    ],
  });
  expect(withoutCanonicalPin).toMatchObject({ phase: "failed", failure: { code: "conflict" } });
  deployments.set(versionUid, {
    nativeId: ticket.result.nativeId,
    observed: ticket.result.observed,
  });
  const withCanonicalPin = await provider.apply({
    operationId: "op-deployment",
    offering: offering("WorkerDeployment"),
    identity: identity("deployment", "uid-deployment-demo"),
    spec: {
      worker: address("ModuleWorker", "worker"),
      versions: [{ workerVersion: address("WorkerVersion", "version"), weight: 10_000 }],
    },
    relations: [
      workerRelation,
      {
        pointer: "/versions/0/workerVersion",
        relation: "/versions/*/workerVersion",
        targetUid: versionUid,
        resource: {
          apiVersion,
          kind: "WorkerVersion",
          form: { formRef: versionForm },
          metadata: {
            name: "version",
            space: "default",
            uid: versionUid,
            generation: "1",
            revision: "1",
          },
          spec: input.spec,
        },
      },
    ],
  });
  expect(withCanonicalPin).toMatchObject({ phase: "succeeded" });
  expect(String(publishedSite?.workflowForward?.snapshotDigest)).toBe(
    String(ticket.result.observed.workflowBindingsDigest),
  );
  expect(script).toBeTruthy();
});
