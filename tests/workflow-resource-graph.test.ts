import { expect, test } from "bun:test";
import type { SelfhostWorkflowTarget } from "../src/selfhost-workflow-preparation.ts";
import type { TakoformStoredRelation } from "../src/takoform/relations.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import type {
  ResourceListing,
  ResourceRelationTargetSnapshot,
  TakoformStore,
} from "../src/takoform/store.ts";
import type { InstalledTakoformForm, TakoformStoredResource } from "../src/takoform/types.ts";
import {
  createWorkflowResourceGraphReader,
  type WorkflowResourceGraph,
} from "../src/workflow-resource-graph.ts";

const catalog = stableProductionTakoformCatalog();
function requiredForm(kind: string): InstalledTakoformForm {
  const form = catalog.forms.find((candidate) => candidate.identity.formRef.kind === kind);
  if (!form) throw new Error(`stable ${kind} vocabulary is unavailable`);
  return form;
}
const workflowForm = requiredForm("DurableWorkflow");
const workerForm = requiredForm("ModuleWorker");

const tenantId = "tenant-1";
const workflowUid = "uid-workflow";
const workerUid = "uid-worker";
const workflowAddress = {
  space: "default",
  apiVersion: workflowForm.identity.formRef.apiVersion,
  kind: workflowForm.identity.formRef.kind,
  name: "orders",
};
const workerAddress = {
  space: workflowAddress.space,
  apiVersion: workerForm.identity.formRef.apiVersion,
  kind: workerForm.identity.formRef.kind,
  name: "worker",
};

function resource(
  form: InstalledTakoformForm,
  address: {
    readonly space: string;
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
  },
  uid: string,
  generation = "1",
  revision = "1",
  spec: Record<string, unknown> = {},
): TakoformStoredResource {
  return {
    apiVersion: address.apiVersion,
    kind: address.kind,
    form: structuredClone(form.identity),
    metadata: {
      name: address.name,
      space: address.space,
      uid,
      generation,
      revision,
    },
    spec: spec as TakoformStoredResource["spec"],
    // The reader intentionally does not inspect this status. A class-only
    // Worker has no fetch/Ready predicate to satisfy.
    status: { observedGeneration: generation, conditions: [] },
  };
}

function listing(
  resourceValue: TakoformStoredResource,
  updatedAt = "2026-09-14T00:00:00.000Z",
): ResourceListing {
  return {
    space: resourceValue.metadata.space,
    apiVersion: resourceValue.apiVersion,
    kind: resourceValue.kind,
    name: resourceValue.metadata.name,
    uid: resourceValue.metadata.uid,
    generation: resourceValue.metadata.generation,
    revision: resourceValue.metadata.revision,
    updatedAt,
    resource: resourceValue,
  };
}

function baseSnapshot(): ResourceRelationTargetSnapshot {
  const source = resource(workflowForm, workflowAddress, workflowUid, "3", "17", {
    className: "OrdersWorkflow",
    worker: {
      apiVersion: workerAddress.apiVersion,
      kind: workerAddress.kind,
      name: workerAddress.name,
    },
  });
  const target = resource(workerForm, workerAddress, workerUid, "8", "23");
  const relation: TakoformStoredRelation = {
    pointer: "/worker",
    relation: "/worker",
    targetApiVersion: workerAddress.apiVersion,
    targetKind: workerAddress.kind,
    targetName: workerAddress.name,
    targetUid: workerUid,
    // This is deliberately older than the current worker revision. It is
    // historical relation evidence, not a revision lock.
    targetRevision: "4",
    targetFormRef: structuredClone(target.form.formRef),
  };
  return { source: listing(source), relation, target: listing(target) };
}

function reader(
  snapshot: ResourceRelationTargetSnapshot | null = baseSnapshot(),
  form: InstalledTakoformForm = workflowForm,
): {
  readonly read: ReturnType<typeof createWorkflowResourceGraphReader>;
  readonly calls: readonly {
    readonly tenantId: string;
    readonly uid: string;
    readonly pointer: string;
  }[];
} {
  const calls: {
    tenantId: string;
    uid: string;
    pointer: string;
  }[] = [];
  const store: Pick<TakoformStore, "resourceWithRelationTargetByUid"> = {
    async resourceWithRelationTargetByUid(tenant, uid, pointer) {
      calls.push({ tenantId: tenant, uid, pointer });
      return snapshot;
    },
  };
  return { read: createWorkflowResourceGraphReader({ store, form }), calls };
}

const scope = { tenantId, workflowResourceUid: workflowUid };

test("resolves a factual nested graph without readiness or execution fields", async () => {
  const fixture = reader();
  const graph = await fixture.read(scope, new AbortController().signal);
  expect(graph).toEqual({
    tenantId,
    workflow: {
      address: workflowAddress,
      uid: workflowUid,
      generation: "3",
      revision: "17",
      formRef: workflowForm.identity.formRef,
      className: "OrdersWorkflow",
    },
    worker: {
      address: workerAddress,
      uid: workerUid,
      generation: "8",
      revision: "23",
      formRef: workerForm.identity.formRef,
    },
  });
  expect(graph && "script" in graph).toBe(false);
  expect(graph && "workerResourceUid" in graph).toBe(false);
  expect(fixture.calls).toEqual([{ tenantId, uid: workflowUid, pointer: "/worker" }]);
});

test("a published v1 graph is not a bootstrap target", () => {
  const graph = null as unknown as WorkflowResourceGraph;
  // @ts-expect-error A factual graph must not authorize self-host bootstrap.
  const target: SelfhostWorkflowTarget = graph;
  void target;
});

test("rejects a malformed duplicate of the supplied Workflow interface", () => {
  const form = structuredClone(workflowForm);
  Object.defineProperty(form, "providedInterfaces", {
    value: [...(form.providedInterfaces ?? []), { name: "worker.workflow" }],
  });
  expect(() => reader(baseSnapshot(), form)).toThrow(
    "Workflow Form does not declare the exact worker.workflow interface",
  );
});

test("uses supplied parsing vocabulary without an implicit catalog version pin", async () => {
  const form: InstalledTakoformForm = {
    ...workflowForm,
    identity: {
      formRef: {
        ...workflowForm.identity.formRef,
        definitionVersion: "99.0.0",
        schemaDigest: `sha256:${"e".repeat(64)}`,
      },
      packageDigest: `sha256:${"d".repeat(64)}`,
    },
    providedInterfaces: [
      {
        apiVersion: "interfaces.takoform.com/v1alpha1",
        name: "worker.workflow",
        version: "99.0.0",
        schemaDigest: `sha256:${"f".repeat(64)}`,
      },
    ],
  };
  const snapshot = baseSnapshot();
  const source = listing({ ...snapshot.source.resource, form: form.identity });
  const graph = await reader({ ...snapshot, source }, form).read(
    scope,
    new AbortController().signal,
  );
  expect(graph?.workflow.formRef).toEqual(form.identity.formRef);
});

test("does not require Worker fetch or Ready status for factual class resolution", async () => {
  const snapshot = baseSnapshot();
  const worker = {
    ...snapshot.target.resource,
    status: { observedGeneration: "8", conditions: [] },
  };
  const result = await reader({ ...snapshot, target: listing(worker) }).read(
    scope,
    new AbortController().signal,
  );
  expect(result?.worker.uid).toBe(workerUid);
});

test("accepts a stale historical targetRevision when the current Worker revision moved", async () => {
  const snapshot = baseSnapshot();
  const result = await reader({
    ...snapshot,
    relation: { ...snapshot.relation, targetRevision: "revision-before-worker-update" },
    target: listing({
      ...snapshot.target.resource,
      metadata: { ...snapshot.target.resource.metadata, revision: "current-24" },
    }),
  }).read(scope, new AbortController().signal);
  expect(result?.worker.revision).toBe("current-24");
});

test("captures scope before a pending store read and never relabels its result", async () => {
  const snapshot = baseSnapshot();
  let release!: (value: ResourceRelationTargetSnapshot) => void;
  const pending = new Promise<ResourceRelationTargetSnapshot>((resolve) => {
    release = resolve;
  });
  let requested: { tenantId: string; uid: string } | undefined;
  const store: Pick<TakoformStore, "resourceWithRelationTargetByUid"> = {
    async resourceWithRelationTargetByUid(requestedTenant, requestedUid) {
      requested = { tenantId: requestedTenant, uid: requestedUid };
      return pending;
    },
  };
  const read = createWorkflowResourceGraphReader({ store, form: workflowForm });
  const mutableScope = { ...scope };
  const resultPromise = read(mutableScope, new AbortController().signal);
  mutableScope.tenantId = "tenant-attacker";
  mutableScope.workflowResourceUid = "uid-attacker";
  release(snapshot);
  const result = await resultPromise;
  expect(requested).toEqual({ tenantId, uid: workflowUid });
  expect(result?.tenantId).toBe(tenantId);
  expect(result?.workflow.uid).toBe(workflowUid);
});

test("honors abort before and after the awaited read", async () => {
  const before = new AbortController();
  before.abort("before-read");
  const beforeFixture = reader();
  await expect(beforeFixture.read(scope, before.signal)).rejects.toBe("before-read");
  expect(beforeFixture.calls).toHaveLength(0);

  let release!: (value: ResourceRelationTargetSnapshot) => void;
  const pending = new Promise<ResourceRelationTargetSnapshot>((resolve) => {
    release = resolve;
  });
  const store: Pick<TakoformStore, "resourceWithRelationTargetByUid"> = {
    async resourceWithRelationTargetByUid() {
      return pending;
    },
  };
  const after = new AbortController();
  const afterPromise = createWorkflowResourceGraphReader({
    store,
    form: workflowForm,
  })(scope, after.signal);
  after.abort("after-read");
  release(baseSnapshot());
  await expect(afterPromise).rejects.toBe("after-read");
});

test("propagates a storage failure instead of treating it as an absent graph", async () => {
  const failure = new Error("database unavailable");
  const store: Pick<TakoformStore, "resourceWithRelationTargetByUid"> = {
    async resourceWithRelationTargetByUid() {
      throw failure;
    },
  };
  const read = createWorkflowResourceGraphReader({ store, form: workflowForm });
  await expect(read(scope, new AbortController().signal)).rejects.toBe(failure);
});

test("returns null for missing or malformed source identity, class spec, relation, and target", async () => {
  const snapshot = baseSnapshot();
  const cases: readonly (ResourceRelationTargetSnapshot | null)[] = [
    null,
    {
      ...snapshot,
      source: listing({
        ...snapshot.source.resource,
        form: {
          ...snapshot.source.resource.form,
          formRef: {
            ...snapshot.source.resource.form.formRef,
            schemaDigest: `sha256:${"f".repeat(64)}`,
          },
        },
      }),
    },
    {
      ...snapshot,
      source: listing({
        ...snapshot.source.resource,
        form: {
          ...snapshot.source.resource.form,
          packageDigest: `sha256:${"f".repeat(64)}`,
        },
      }),
    },
    {
      ...snapshot,
      source: listing({
        ...snapshot.source.resource,
        spec: {
          ...snapshot.source.resource.spec,
          className: "not valid class name!",
        },
      }),
    },
    { ...snapshot, relation: undefined as unknown as TakoformStoredRelation },
    {
      ...snapshot,
      relation: { ...snapshot.relation, relation: "/other" },
    },
    {
      ...snapshot,
      relation: {
        ...snapshot.relation,
        targetUid: "uid-other",
      },
    },
    {
      ...snapshot,
      target: listing({
        ...snapshot.target.resource,
        metadata: { ...snapshot.target.resource.metadata, uid: "uid-other" },
      }),
    },
    {
      ...snapshot,
      target: listing({
        ...snapshot.target.resource,
        metadata: { ...snapshot.target.resource.metadata, space: "other-space" },
      }),
    },
  ];
  for (const candidate of cases) {
    expect(await reader(candidate).read(scope, new AbortController().signal)).toBeNull();
  }
});

test("snapshots the supplied Definition and does not alias store FormRef output", async () => {
  const mutableForm = structuredClone(workflowForm);
  const storeSnapshot = baseSnapshot();
  const read = reader(storeSnapshot, mutableForm).read;
  // Mutating the caller's Definition after construction must not change the
  // parser used by the reader.
  const schema = mutableForm.desiredSchema as {
    readonly properties: Record<string, unknown>;
  };
  schema.properties.className = { type: "number" };
  const graph = await read(scope, new AbortController().signal);
  expect(graph?.workflow.className).toBe("OrdersWorkflow");
  const outputRef = graph?.workflow.formRef as { schemaDigest: string } | undefined;
  if (outputRef) outputRef.schemaDigest = "sha256:changed";
  expect(storeSnapshot.source.resource.form.formRef.schemaDigest).toBe(
    workflowForm.identity.formRef.schemaDigest,
  );
});
