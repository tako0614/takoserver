import { expect, test } from "bun:test";
import type { TakoformStoredRelation } from "../src/takoform/relations.ts";
import type { ResourceDeletionTombstone } from "../src/takoform/store.ts";
import type { TakoformStoredResource } from "../src/takoform/types.ts";
import {
  type TakoformWaveSettlement,
  validateWorkerAggregate,
  validateWorkerDeploymentRemoval,
  workerServiceCondition,
} from "../src/takoform/worker-aggregate.ts";

/** No command in this wave holds the deployment claim of any Worker. */
const noClaims = {
  async resourceClaimHolder() {
    return null;
  },
  async committedResourceClaimHolder() {
    return null;
  },
};

/**
 * A wave whose clock is its own, so a refusal these tests want to read is
 * reached in microseconds instead of after the production idle budget.
 */
function testWave(overrides: Partial<TakoformWaveSettlement> = {}): TakoformWaveSettlement {
  let elapsed = 0;
  return {
    now: () => (elapsed += 10),
    sleep: async () => {},
    pollMilliseconds: 1,
    idleMilliseconds: 100,
    ceilingMilliseconds: 1_000,
    ...overrides,
  };
}

const formRef = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ModuleWorker",
  definitionVersion: "0.1.0",
  schemaDigest: `sha256:${"1".repeat(64)}` as const,
};
const worker = resource("ModuleWorker", "worker", "worker-uid", {});
const deployment = resource("WorkerDeployment", "deployment", "deployment-uid", {});
const version = resource("WorkerVersion", "version", "version-uid", {
  handlers: ["fetch", "scheduled", "queue"],
});
const versionRelation: TakoformStoredRelation = {
  pointer: "/versions/0/workerVersion",
  relation: "/versions/*/workerVersion",
  targetApiVersion: version.apiVersion,
  targetKind: version.kind,
  targetName: version.metadata.name,
  targetUid: version.metadata.uid,
  targetFormRef: version.form.formRef,
};

test("a ModuleWorker is Provisioning until a deployment serves fetch", async () => {
  const missing = await workerServiceCondition({
    tenantId: "tenant-a",
    resource: worker,
    store: {
      async resourcesByRelation() {
        return [];
      },
      async readResource() {
        return null;
      },
    },
  });
  expect(missing).toMatchObject({
    status: "False",
    reason: "Provisioning",
    hostReason: expect.stringContaining("worker"),
  });

  const serving = await workerServiceCondition({
    tenantId: "tenant-a",
    resource: worker,
    store: {
      async resourcesByRelation() {
        return [{ resource: deployment, relations: [versionRelation] }];
      },
      async readResource() {
        return version;
      },
    },
  });
  expect(serving).toMatchObject({ status: "True", reason: "Available" });
});

test("an inward activation with no WorkerDeployment at all names the missing deployment", async () => {
  const workerRelation: TakoformStoredRelation = {
    pointer: "/worker",
    relation: "/worker",
    targetApiVersion: worker.apiVersion,
    targetKind: worker.kind,
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
    targetFormRef: worker.form.formRef,
  };
  await expect(
    validateWorkerAggregate({
      tenantId: "tenant-a",
      space: "conformance",
      resourceName: "domain",
      form: {
        identity: {
          formRef: {
            ...formRef,
            kind: "WorkerCustomDomain",
          },
        },
        role: "attachment",
        desiredSchema: {},
        operations: ["create", "read", "delete"],
      },
      spec: { hostname: "domain.portable-conformance.invalid" },
      relations: [workerRelation],
      wave: testWave(),
      store: {
        async hostnameClaims() {
          return [];
        },
        async queuePathReaches() {
          return false;
        },
        async resourcesByRelation() {
          return [];
        },
        async readResource() {
          return null;
        },
        async readRelations() {
          return [];
        },
        ...noClaims,
      },
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    status: 400,
    publicMessage: expect.stringContaining("has no WorkerDeployment"),
  });
});

test("an inbound service binding is rejected until its target worker serves fetch", async () => {
  await expect(
    validateWorkerAggregate({
      tenantId: "tenant-a",
      space: "conformance",
      resourceName: "version",
      form: {
        identity: { formRef: { ...formRef, kind: "WorkerVersion" } },
        role: "revision",
        desiredSchema: {},
        operations: ["create", "read", "delete"],
      },
      spec: {},
      relations: [
        {
          ...versionRelation,
          pointer: "/serviceBindings/0/resource",
          relation: "/serviceBindings/*/resource",
          targetKind: "ModuleWorker",
          targetName: worker.metadata.name,
          targetUid: worker.metadata.uid,
          targetFormRef: worker.form.formRef,
        },
      ],
      wave: testWave(),
      store: {
        async hostnameClaims() {
          return [];
        },
        async queuePathReaches() {
          return false;
        },
        async resourcesByRelation() {
          return [];
        },
        async readResource() {
          return null;
        },
        async readRelations() {
          return [];
        },
        ...noClaims,
      },
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    status: 400,
    publicMessage: expect.stringContaining("has no WorkerDeployment"),
  });
});

test("WorkerVersion vars, sensitive names, and bindings share one namespace", async () => {
  await expect(
    validateWorkerAggregate({
      tenantId: "tenant-a",
      space: "conformance",
      resourceName: "version",
      form: {
        identity: { formRef: { ...formRef, kind: "WorkerVersion" } },
        role: "revision",
        desiredSchema: {},
        operations: ["create", "read", "delete"],
      },
      spec: {
        handlers: ["fetch"],
        vars: { CACHE: "value" },
        kvBindings: [{ name: "CACHE", resource: {} }],
      },
      relations: [],
      store: {
        async hostnameClaims() {
          return [];
        },
        async queuePathReaches() {
          return false;
        },
        async resourcesByRelation() {
          return [];
        },
        async readResource() {
          return null;
        },
        async readRelations() {
          return [];
        },
        ...noClaims,
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
});

test("a WorkerDeployment requires exactly 10000 basis points", async () => {
  await expect(
    validateWorkerAggregate({
      tenantId: "tenant-a",
      space: "conformance",
      resourceName: "deployment",
      form: {
        identity: { formRef: { ...formRef, kind: "WorkerDeployment" } },
        role: "deployment",
        desiredSchema: {},
        operations: ["create", "read", "update", "delete"],
      },
      spec: { versions: [{ weight: 9_999 }] },
      relations: [],
      store: {
        async hostnameClaims() {
          return [];
        },
        async queuePathReaches() {
          return false;
        },
        async resourcesByRelation() {
          return [];
        },
        async readResource() {
          return null;
        },
        async readRelations() {
          return [];
        },
        ...noClaims,
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
});

test("a queue incarnation has at most one consumer", async () => {
  const queueRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/queue",
    relation: "/queue",
    targetKind: "AtLeastOnceQueue",
    targetName: "queue",
    targetUid: "queue-uid",
  };
  const workerRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/worker",
    relation: "/worker",
    targetKind: "ModuleWorker",
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
  };
  await expect(
    validateWorkerAggregate({
      tenantId: "tenant-a",
      space: "conformance",
      resourceName: "second-consumer",
      form: {
        identity: { formRef: { ...formRef, kind: "QueueConsumer" } },
        role: "attachment",
        desiredSchema: {},
        operations: ["create", "read", "delete"],
      },
      spec: {},
      relations: [workerRelation, queueRelation],
      store: {
        async hostnameClaims() {
          return [];
        },
        async queuePathReaches() {
          return false;
        },
        async resourcesByRelation(input) {
          if (input.sourceKind === "WorkerDeployment") {
            return [{ resource: deployment, relations: [versionRelation] }];
          }
          return [
            {
              resource: resource("QueueConsumer", "first-consumer", "consumer-uid", {}),
              relations: [queueRelation],
            },
          ];
        },
        async readResource() {
          return version;
        },
        async readRelations() {
          return [];
        },
        ...noClaims,
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
});

test("a QueueConsumer cannot close a dead-letter cycle", async () => {
  const workerRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/worker",
    relation: "/worker",
    targetKind: "ModuleWorker",
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
  };
  const queueRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/queue",
    relation: "/queue",
    targetKind: "AtLeastOnceQueue",
    targetName: "queue-a",
    targetUid: "queue-a-uid",
  };
  const deadLetterRelation: TakoformStoredRelation = {
    ...queueRelation,
    pointer: "/deadLetterQueue",
    relation: "/deadLetterQueue",
    targetName: "queue-b",
    targetUid: "queue-b-uid",
  };
  await expect(
    validateWorkerAggregate({
      tenantId: "tenant-a",
      space: "conformance",
      resourceName: "consumer",
      form: {
        identity: { formRef: { ...formRef, kind: "QueueConsumer" } },
        role: "attachment",
        desiredSchema: {},
        operations: ["create", "read", "delete"],
      },
      spec: {},
      relations: [workerRelation, queueRelation, deadLetterRelation],
      store: {
        async hostnameClaims() {
          return [];
        },
        async queuePathReaches(input) {
          expect(input).toMatchObject({
            fromQueueUid: "queue-b-uid",
            toQueueUid: "queue-a-uid",
          });
          return true;
        },
        async resourcesByRelation(input) {
          return input.sourceKind === "WorkerDeployment"
            ? [{ resource: deployment, relations: [versionRelation] }]
            : [];
        },
        async readResource() {
          return version;
        },
        async readRelations() {
          return [];
        },
        ...noClaims,
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
});

test("a custom-domain hostname is unique across every space of one tenant", async () => {
  const workerRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/worker",
    relation: "/worker",
    targetKind: "ModuleWorker",
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
  };
  await expect(
    validateWorkerAggregate({
      tenantId: "tenant-a",
      space: "other-space",
      resourceName: "second-domain",
      form: {
        identity: { formRef: { ...formRef, kind: "WorkerCustomDomain" } },
        role: "attachment",
        desiredSchema: {},
        operations: ["create", "read", "delete"],
      },
      spec: { hostname: "claim.portable-conformance.invalid" },
      relations: [workerRelation],
      store: {
        async hostnameClaims() {
          return [
            {
              space: "conformance",
              apiVersion: formRef.apiVersion,
              kind: "WorkerCustomDomain",
              name: "first-domain",
              uid: "domain-uid",
              generation: "1",
              revision: "1",
              updatedAt: "2026-08-19T00:00:00.000Z",
              resource: resource("WorkerCustomDomain", "first-domain", "domain-uid", {
                hostname: "claim.portable-conformance.invalid",
              }),
            },
          ];
        },
        async queuePathReaches() {
          return false;
        },
        async resourcesByRelation() {
          return [{ resource: deployment, relations: [versionRelation] }];
        },
        async readResource() {
          return version;
        },
        async readRelations() {
          return [];
        },
        ...noClaims,
      },
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    status: 400,
    details: { holder: "first-domain" },
  });
});

test("an inward activation waits for the WorkerDeployment its own apply wave is creating", async () => {
  const workerRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/worker",
    relation: "/worker",
    targetKind: "ModuleWorker",
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
  };
  let landed = false;
  await validateWorkerAggregate({
    tenantId: "tenant-a",
    space: "conformance",
    resourceName: "endpoint",
    form: {
      identity: { formRef: { ...formRef, kind: "WorkerEndpoint" } },
      role: "attachment",
      desiredSchema: {},
      operations: ["create", "read", "delete"],
    },
    spec: {},
    relations: [workerRelation],
    wave: testWave(),
    store: {
      async hostnameClaims() {
        return [];
      },
      async queuePathReaches() {
        return false;
      },
      async resourcesByRelation(input) {
        if (input.sourceKind !== "WorkerDeployment" || !landed) return [];
        return [{ resource: deployment, relations: [versionRelation] }];
      },
      async readResource() {
        return version;
      },
      async readRelations() {
        return [];
      },
      // The deployment's own create holds the reserved `exclusive` claim until
      // it commits, which is exactly "somebody in this wave is making this
      // Worker serve"; the third sighting is the commit.
      async resourceClaimHolder() {
        return {
          tenantId: "tenant-a",
          holderSpace: "conformance",
          holderApiVersion: formRef.apiVersion,
          holderKind: "WorkerDeployment",
          holderName: "deployment",
          holderUid: "deployment-uid",
        };
      },
      async committedResourceClaimHolder() {
        landed = true;
        return null;
      },
    },
  });
  expect(landed).toBe(true);
});

test("an inward activation whose deployment has not become Ready is refused retryably", async () => {
  const workerRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/worker",
    relation: "/worker",
    targetKind: "ModuleWorker",
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
  };
  await expect(
    validateWorkerAggregate({
      tenantId: "tenant-a",
      space: "conformance",
      resourceName: "trigger",
      form: {
        identity: { formRef: { ...formRef, kind: "WorkerCronTrigger" } },
        role: "attachment",
        desiredSchema: {},
        operations: ["create", "read", "delete"],
      },
      spec: { cron: "*/5 * * * *" },
      relations: [workerRelation],
      wave: testWave(),
      store: {
        async hostnameClaims() {
          return [];
        },
        async queuePathReaches() {
          return false;
        },
        async resourcesByRelation(input) {
          return input.sourceKind === "WorkerDeployment"
            ? [{ resource: deployment, relations: [versionRelation] }]
            : [];
        },
        // The deployment exists but the Version it selects is not there yet.
        async readResource() {
          return null;
        },
        async readRelations() {
          return [];
        },
        ...noClaims,
      },
    }),
  ).rejects.toMatchObject({
    code: "resource_busy",
    status: 409,
    publicMessage: expect.stringContaining("no serving deployment yet"),
  });
});

test("a WorkerDeployment delete waits out a holder whose own delete is in flight", async () => {
  const workerRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/worker",
    relation: "/worker",
    targetKind: "ModuleWorker",
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
  };
  const endpoint = resource("WorkerEndpoint", "endpoint", "endpoint-uid", {});
  let reads = 0;
  await validateWorkerDeploymentRemoval({
    tenantId: "tenant-a",
    space: "conformance",
    form: {
      identity: { formRef: { ...formRef, kind: "WorkerDeployment" } },
      role: "deployment",
      desiredSchema: {},
      operations: ["create", "read", "update", "delete"],
    },
    relations: [workerRelation],
    wave: testWave(),
    store: {
      async resourcesByRelation(input) {
        if (input.sourceKind !== "WorkerEndpoint" || reads > 1) return [];
        return [{ resource: endpoint, relations: [workerRelation] }];
      },
      async readResourceDeletion() {
        reads += 1;
        return tombstone("endpoint-uid", "pending");
      },
    },
  });
  expect(reads).toBeGreaterThan(0);
});

test("a WorkerDeployment delete still refuses a holder nobody is deleting", async () => {
  const workerRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/worker",
    relation: "/worker",
    targetKind: "ModuleWorker",
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
  };
  const endpoint = resource("WorkerEndpoint", "endpoint", "endpoint-uid", {});
  await expect(
    validateWorkerDeploymentRemoval({
      tenantId: "tenant-a",
      space: "conformance",
      form: {
        identity: { formRef: { ...formRef, kind: "WorkerDeployment" } },
        role: "deployment",
        desiredSchema: {},
        operations: ["create", "read", "update", "delete"],
      },
      relations: [workerRelation],
      wave: testWave(),
      store: {
        async resourcesByRelation(input) {
          return input.sourceKind === "WorkerEndpoint"
            ? [{ resource: endpoint, relations: [workerRelation] }]
            : [];
        },
        async readResourceDeletion() {
          return tombstone("endpoint-uid", "live");
        },
      },
    }),
  ).rejects.toMatchObject({
    code: "dependency_in_use",
    status: 409,
    publicMessage: expect.stringContaining("WorkerEndpoint endpoint"),
  });
});

test("a WorkerDeployment delete whose holder never finishes leaving is refused retryably", async () => {
  const workerRelation: TakoformStoredRelation = {
    ...versionRelation,
    pointer: "/worker",
    relation: "/worker",
    targetKind: "ModuleWorker",
    targetName: worker.metadata.name,
    targetUid: worker.metadata.uid,
  };
  const endpoint = resource("WorkerEndpoint", "endpoint", "endpoint-uid", {});
  await expect(
    validateWorkerDeploymentRemoval({
      tenantId: "tenant-a",
      space: "conformance",
      form: {
        identity: { formRef: { ...formRef, kind: "WorkerDeployment" } },
        role: "deployment",
        desiredSchema: {},
        operations: ["create", "read", "update", "delete"],
      },
      relations: [workerRelation],
      wave: testWave(),
      store: {
        async resourcesByRelation(input) {
          return input.sourceKind === "WorkerEndpoint"
            ? [{ resource: endpoint, relations: [workerRelation] }]
            : [];
        },
        async readResourceDeletion() {
          return tombstone("endpoint-uid", "pending");
        },
      },
    }),
  ).rejects.toMatchObject({
    code: "resource_busy",
    status: 409,
    publicMessage: expect.stringContaining("WorkerEndpoint endpoint"),
  });
});

function tombstone(
  resourceUid: string,
  state: ResourceDeletionTombstone["state"],
): ResourceDeletionTombstone {
  return {
    tenantId: "tenant-a",
    resourceUid,
    address: {
      tenantId: "tenant-a",
      space: "conformance",
      apiVersion: formRef.apiVersion,
      kind: "WorkerEndpoint",
      name: "endpoint",
    },
    formRef: { ...formRef, kind: "WorkerEndpoint" },
    state,
    closureFence: 1,
    effects: [],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

function resource(
  kind: string,
  name: string,
  uid: string,
  spec: TakoformStoredResource["spec"],
): TakoformStoredResource {
  return {
    apiVersion: formRef.apiVersion,
    kind,
    form: { formRef: { ...formRef, kind } },
    metadata: {
      name,
      space: "conformance",
      uid,
      generation: "1",
      revision: "1",
    },
    spec,
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: "2026-08-19T00:00:00.000Z",
        },
      ],
    },
  };
}
