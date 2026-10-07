import { expect, test } from "bun:test";
import {
  WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING,
  WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
  WORKERD_V2_PRIVATE_QUEUE_SETTLEMENT_BINDING,
  WORKERD_V2_PRIVATE_READINESS_BINDING,
  workerdV2PrivateActorBindingName,
  workerdV2PrivateServiceBindingName,
  workerdV2PrivateWorkflowBindingName,
} from "../src/providers/workerd-v2-private-binding-names.ts";
import {
  compileWorkerdVersionGraph,
  type WorkerdVersionGraphInput,
} from "../src/workerd-version-graph.ts";

const PUBLIC_BINDING_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

function input(generation: string): WorkerdVersionGraphInput {
  return {
    directory: "site",
    mainModule: "index.js",
    modules: new Map([["index.js", new TextEncoder().encode("export default { fetch() {} };\n")]]),
    moduleMediaTypes: { "index.js": "application/javascript+module" },
    environment: [{ name: "TAKOSERVER_SELFHOST_DATA", value: "public", type: "plain_text" }],
    serviceBindings: [
      {
        publicName: "SERVICE",
        target: "target",
        targetResourceUid: "target-uid",
        unavailableToken: "a".repeat(64),
      },
    ],
    dataPlane: {
      address: "127.0.0.1:1234",
      token: "host-private-token",
      bindings: [{ kind: "edge.sql@1.0.0", publicName: "__TAKOSERVER_SELFHOST_SERVICE_00000" }],
    },
    hostnames: [],
    generation,
    workerResourceUid: "worker-uid",
    declaredHandlers: ["fetch"],
    readiness: { publication: "publication", probeHostname: "site.selfhost-internal.invalid" },
  };
}

test("new v2 private native names cannot be claimed by a public Binding", () => {
  const names = [
    WORKERD_V2_PRIVATE_DATA_SERVICE_BINDING,
    WORKERD_V2_PRIVATE_READINESS_BINDING,
    WORKERD_V2_PRIVATE_QUEUE_SETTLEMENT_BINDING,
    workerdV2PrivateServiceBindingName(0),
    workerdV2PrivateServiceBindingName(63),
    workerdV2PrivateActorBindingName("HTTP", 0),
    workerdV2PrivateActorBindingName("UPGRADE", 0),
    workerdV2PrivateWorkflowBindingName(0),
  ];
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) {
    expect(name.length).toBeGreaterThan(64);
    expect(name.length).toBeLessThanOrEqual(128);
    expect(PUBLIC_BINDING_NAME.test(name)).toBe(false);
  }
});

test("v2 Actor and Workflow native service names cannot shadow valid public bindings", () => {
  const source = input("takoserver-v2-operation:11111111-1111-4111-8111-111111111111");
  const graph = compileWorkerdVersionGraph({
    ...source,
    actorForward: [
      {
        publicName: "__TAKOSERVER_ACTOR_HTTP_00000",
        tenantId: "tenant-one",
        namespaceResourceUid: "actor-uid-one",
        token: "b".repeat(64),
      },
    ],
    workflowForward: {
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      bindings: [
        {
          publicName: "__TAKOSERVER_WORKFLOW_BINDING_00000",
          tenantId: "tenant-one",
          workflowResourceUid: "workflow-uid-one",
          workflowFormRef: {
            apiVersion: "edge.forms.takoform.com",
            kind: "DurableWorkflow",
            definitionVersion: "0.2.0",
            schemaDigest: "sha256:21b0c5cfd9722d58ca669297cf856120cf8443aa8f653a36f13d452ddf8e5585",
          },
          bindingRef: {
            apiVersion: "bindings.takoform.com/v1alpha2",
            name: "module-worker.workflow",
            version: "3.0.0",
            schemaDigest: "sha256:2b8df3ba036b2781ee3ea8af6603b3de5f09226f4eb1f3385565211cdacc854b",
          },
          runtimeClassRef: {
            apiVersion: "interfaces.takoform.com/v1alpha1",
            name: "worker.workflow",
            version: "3.0.0",
            schemaDigest: "sha256:2584721b4bc9f5feef94b272337c348fb67130de57317afaf84aa7ca55246f69",
          },
          token: "c".repeat(64),
        },
      ],
    },
  });
  expect(graph.site.actorForward?.bindings[0]?.httpService).toBe(
    workerdV2PrivateActorBindingName("HTTP", 0),
  );
  expect(graph.site.actorForward?.bindings[0]?.upgradeService).toBe(
    workerdV2PrivateActorBindingName("UPGRADE", 0),
  );
  expect(graph.site.workflowForward?.bindings[0]?.serviceName).toBe(
    workerdV2PrivateWorkflowBindingName(0),
  );
  expect(graph.site.hostModules).toContain(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE);
});

test("v2 uses a persisted private-name profile while old publications keep the legacy profile", () => {
  const v2 = compileWorkerdVersionGraph(
    input("takoserver-v2-operation:11111111-1111-4111-8111-111111111111"),
  );
  expect(v2.site.hostEntrypoint).toBe(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE);
  expect(v2.hostModules?.has(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE)).toBe(true);
  expect(v2.site.serviceBindings?.[0]?.name).toBe(workerdV2PrivateServiceBindingName(0));
  expect(v2.site.vars?.map(({ name }) => name)).toEqual(["TAKOSERVER_SELFHOST_DATA"]);
  expect(() => compileWorkerdVersionGraph(input("old-publication"))).toThrow(TypeError);
});

test("v2 Queue settlement uses the same unclaimable native profile", () => {
  const graph = compileWorkerdVersionGraph({
    ...input("takoserver-v2-operation:11111111-1111-4111-8111-111111111111"),
    declaredHandlers: ["queue"],
    eventToken: "event-token",
    v2QueueSettlement: { address: "127.0.0.1:1235", token: "A".repeat(43) },
  });
  const wrapper = graph.hostModules.get(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE);
  expect(wrapper).toBeDefined();
  expect(new TextDecoder().decode(wrapper)).toContain(WORKERD_V2_PRIVATE_QUEUE_SETTLEMENT_BINDING);
});
