import { expect, test } from "bun:test";
import type { TakoformStoredRelation } from "../src/takoform/relations.ts";
import type { TakoformStoredResource } from "../src/takoform/types.ts";
import {
  validateWorkerAggregate,
  workerServiceCondition,
} from "../src/takoform/worker-aggregate.ts";

const formRef = {
  apiVersion: "edge.forms.takoform.com/v1alpha1",
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

test("an inward activation is rejected before mutation when no deployment serves it", async () => {
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
      },
    }),
  ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
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
      },
    }),
  ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
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
      },
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    status: 400,
    details: { holder: "first-domain" },
  });
});

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
