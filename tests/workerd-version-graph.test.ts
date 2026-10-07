import { expect, test } from "bun:test";
import {
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
  selfhostDataServiceSource,
} from "../src/providers/selfhost-data-service.ts";
import {
  SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND,
  SELFHOST_WORKER_EVENT_SERVICE_MODULE,
  SELFHOST_WORKER_EVENT_TOKEN_BINDING,
  selfhostEventServiceSource,
} from "../src/providers/selfhost-events.ts";
import {
  SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE,
  selfhostV2ObjectBucketDataServiceSource,
} from "../src/providers/selfhost-v2-object-bucket-data-service.ts";
import {
  V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
  V2_QUEUE_SETTLEMENT_TOKEN_BINDING,
} from "../src/providers/selfhost-v2-queue-transport.ts";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
  SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
  SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND,
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  SELFHOST_WORKER_SERVICE_BINDING_KIND,
  type SelfhostWorkerBindingDescriptor,
  selfhostWorkerEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import {
  WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE,
  WORKERD_V2_PRIVATE_KV_BINDING,
  WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING,
} from "../src/providers/workerd-v2-private-binding-names.ts";
import {
  renderSelfhostActorForwardRuntimeModuleSource,
  selfhostActorForwardEntrypointSource,
} from "../src/selfhost-actor-forward-worker-wrapper.ts";
import {
  renderSelfhostWorkflowBindingRuntimeModuleSource,
  SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE,
  SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE,
  selfhostWorkflowBindingEntrypointSource,
} from "../src/selfhost-workflow-binding-worker-wrapper.ts";
import { forwardTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import {
  compileWorkerdVersionGraph,
  type WorkerdVersionGraph,
  type WorkerdVersionGraphInput,
  workerdVersionServiceBindingName,
} from "../src/workerd-version-graph.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DATA_TOKEN = "opaque-data-token";
const EVENT_TOKEN = "opaque-event-token";
const SERVICE_TOKEN = "a".repeat(64);

function graphInput(overrides: Partial<WorkerdVersionGraphInput> = {}): WorkerdVersionGraphInput {
  return {
    directory: "site",
    mainModule: "index.js",
    modules: new Map([
      ["index.js", encoder.encode("export default { fetch() {} };\n")],
      ["module.txt", encoder.encode("auxiliary module\n")],
    ]),
    moduleMediaTypes: {
      "index.js": "application/javascript+module",
      "module.txt": "text/plain",
    },
    environment: [
      { name: "PLAIN", value: "plain-value", type: "plain_text" },
      { name: "JSON_VALUE", value: '{"enabled":true}', type: "json" },
      { name: "SECRET", value: "secret-value", type: "secret_text" },
    ],
    serviceBindings: [],
    hostnames: ["public.example.invalid"],
    generation: "generation-1",
    workerResourceUid: "uid-worker-1",
    declaredHandlers: ["fetch"],
    readiness: {
      publication: "publication-1",
      probeHostname: "site.selfhost-internal.invalid",
    },
    ...overrides,
  };
}

function workflowForwardInput(
  bindings?: Array<{
    publicName: string;
    tenantId: string;
    workflowResourceUid: string;
    workflowFormRef: Record<string, string>;
    bindingRef: Record<string, string>;
    runtimeClassRef: Record<string, string>;
    token: string;
    [key: string]: unknown;
  }>,
): {
  snapshotDigest: string;
  bindings: NonNullable<typeof bindings>;
} {
  return {
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    bindings: bindings ?? [
      {
        publicName: "ORDERS",
        tenantId: "tenant-workflow-1",
        workflowResourceUid: "workflow-resource-001",
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
        token: SERVICE_TOKEN,
      },
    ],
  };
}

function source(bytes: Uint8Array | undefined): string {
  if (!bytes) throw new Error("expected generated module");
  return decoder.decode(bytes);
}

test("v2 queue settlement is an explicit private boot capability, not a tenant binding", () => {
  const graph = compileWorkerdVersionGraph(
    graphInput({
      declaredHandlers: ["queue"],
      eventToken: EVENT_TOKEN,
      v2QueueSettlement: { address: "127.0.0.1:4999", token: "A".repeat(43) },
    }),
  );
  expect(graph.site.queueSettlement).toEqual({
    address: "127.0.0.1:4999",
    module: V2_QUEUE_SETTLEMENT_SERVICE_MODULE,
    vars: [{ name: V2_QUEUE_SETTLEMENT_TOKEN_BINDING, value: "A".repeat(43), kind: "text" }],
  });
  expect(graph.site.vars?.some((binding) => binding.value === "A".repeat(43))).not.toBe(true);
  expect(source(graph.hostModules.get(SELFHOST_WORKER_ENTRYPOINT_MODULE))).toContain(
    '"v2Queue":true',
  );
  expect(source(graph.hostModules.get(V2_QUEUE_SETTLEMENT_SERVICE_MODULE))).toContain("Bearer ");
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        declaredHandlers: ["queue"],
        v2QueueSettlement: { address: "127.0.0.1:4999", token: "A".repeat(43) },
      }),
    ),
  ).toThrow();
});

test("ObjectBucket uses a distinct signed-grant service beside the generic data plane", () => {
  const grant = `${Buffer.from('{"schema":"fixture"}').toString("base64url")}.${"a".repeat(43)}`;
  const graph = compileWorkerdVersionGraph(
    graphInput({
      generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
      dataPlane: {
        address: "127.0.0.1:4666",
        token: "generic-data-plane-token",
        bindings: [{ kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "KV" }],
      },
      v2ObjectBucketBinding: {
        address: "127.0.0.1:4777",
        token: grant,
        bindings: [{ publicName: "MEDIA" }],
      },
    }),
  );
  expect(graph.site.dataPlane?.vars).toEqual([
    { name: SELFHOST_WORKER_DATA_TOKEN_BINDING, value: "generic-data-plane-token", kind: "text" },
  ]);
  expect(graph.site.v2ObjectBucketPlane).toEqual({ address: "127.0.0.1:4777", token: grant });
  expect(graph.site.hostModules).not.toContain(SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE);
  expect(graph.hostModules.has(SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE)).toBe(true);
  const wrapper = source(graph.hostModules.get(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE));
  expect(wrapper).toContain(WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING);
  expect(wrapper).not.toContain(grant);
  expect(source(graph.hostModules.get(SELFHOST_V2_OBJECT_BUCKET_DATA_SERVICE_MODULE))).toBe(
    selfhostV2ObjectBucketDataServiceSource(),
  );
});

test("v2 KV uses its own private service when mixed with the generic SQL plane", () => {
  const grant = `${Buffer.from('{"schema":"fixture"}').toString("base64url")}.${"b".repeat(43)}`;
  const graph = compileWorkerdVersionGraph(
    graphInput({
      generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
      dataPlane: {
        address: "127.0.0.1:4666",
        token: "generic-sql-plane-token",
        bindings: [{ kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" }],
      },
      v2KvBinding: {
        address: "127.0.0.1:4888",
        token: grant,
        bindings: [{ publicName: "CACHE" }],
      },
    }),
  );

  const descriptor = graph.hostModules.get(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE);
  const wrapper = source(descriptor);
  expect(wrapper).toContain(WORKERD_V2_PRIVATE_KV_BINDING);
  expect(wrapper).not.toContain(grant);
  expect(graph.site.dataPlane?.address).toBe("127.0.0.1:4666");
  expect(graph.site.v2KvPlane).toEqual({ address: "127.0.0.1:4888", token: grant });
});

function graphSnapshot(graph: WorkerdVersionGraph): unknown {
  return {
    site: structuredClone(graph.site),
    modules: [...graph.modules].map(([name, bytes]) => [name, [...bytes]]),
    assets:
      graph.assets === undefined
        ? undefined
        : [...graph.assets].map(([name, bytes]) => [name, [...bytes]]),
    hostModules: [...graph.hostModules].map(([name, bytes]) => [name, [...bytes]]),
  };
}

test("compiles the plain Version projection and exact generated Host bytes", () => {
  const input = graphInput();
  const graph = compileWorkerdVersionGraph(input);
  expect(graphSnapshot(compileWorkerdVersionGraph(input))).toEqual(graphSnapshot(graph));
  const preludeModule = selfhostWorkerPreludeModuleName(input.mainModule);
  const expectedEnvironment = [
    { name: "PLAIN", value: "plain-value", kind: "text" as const },
    { name: "JSON_VALUE", value: '{"enabled":true}', kind: "json" as const },
    { name: "SECRET", value: "secret-value", kind: "text" as const },
  ];
  const expectedSite: WorkerdVersionGraph["site"] = {
    directory: "site",
    mainModule: "index.js",
    hostEntrypoint: SELFHOST_WORKER_ENTRYPOINT_MODULE,
    hostModules: [preludeModule],
    hostnames: ["public.example.invalid"],
    modules: ["module.txt"],
    moduleMediaTypes: {
      "index.js": "application/javascript+module",
      "module.txt": "text/plain",
    },
    generation: "generation-1",
    workerResourceUid: "uid-worker-1",
    fetchHandler: true,
    vars: expectedEnvironment,
  };
  expect(graph.site).toEqual(expectedSite);
  expect([...graph.hostModules.keys()]).toEqual([SELFHOST_WORKER_ENTRYPOINT_MODULE, preludeModule]);

  const expectedBindings: SelfhostWorkerBindingDescriptor[] = [
    { name: "PLAIN", type: "plain_text" },
    { name: "JSON_VALUE", type: "json" },
    { name: "SECRET", type: "secret_text" },
  ];
  expect(source(graph.hostModules.get(SELFHOST_WORKER_ENTRYPOINT_MODULE))).toBe(
    selfhostWorkerEntrypointSource({
      originalMainModule: "index.js",
      declaredHandlers: ["fetch"],
      bindings: expectedBindings,
      publication: "publication-1",
      probeHostname: "site.selfhost-internal.invalid",
    }),
  );
  expect(source(graph.hostModules.get(preludeModule))).toBe(selfhostWorkerPreludeSource());
  expect(graph.assets).toBeUndefined();
  expect(graph.site.dataPlane).toBeUndefined();
  expect(graph.site.events).toBeUndefined();
  expect(graph.site.serviceBindings).toBeUndefined();
});

test("compiles the opt-in Actor forward outer Host entrypoint without changing the inner wrapper", () => {
  const withoutForwarding = graphInput({
    modules: new Map([
      ["index.js", encoder.encode("export default { fetch() {}, queue() {}, scheduled() {} };\n")],
      ["module.txt", encoder.encode("auxiliary module\n")],
    ]),
    declaredHandlers: ["fetch", "queue", "scheduled"],
  });
  const input = graphInput({
    modules: withoutForwarding.modules,
    declaredHandlers: withoutForwarding.declaredHandlers,
    eventToken: EVENT_TOKEN,
    actorForward: [
      {
        publicName: "ROOM",
        tenantId: "tenant-actor-1",
        namespaceResourceUid: "actor-namespace-001",
        token: SERVICE_TOKEN,
      },
    ],
  });
  const graph = compileWorkerdVersionGraph(input);
  const innerModule = SELFHOST_WORKER_ENTRYPOINT_MODULE;
  const outerModule = "__takoserver-selfhost-actor-forward-entrypoint.js";
  const runtimeModule = "__takoserver-selfhost-actor-forward-runtime.js";
  const actorBinding = {
    publicName: "ROOM",
    tenantId: "tenant-actor-1",
    namespaceResourceUid: "actor-namespace-001",
    httpService: "__TAKOSERVER_ACTOR_HTTP_00000",
    upgradeService: "__TAKOSERVER_ACTOR_UPGRADE_00000",
    token: SERVICE_TOKEN,
  };
  expect(graph.site.hostEntrypoint).toBe(outerModule);
  expect(graph.site.hostModules).toContain(innerModule);
  expect(graph.site.hostModules).toContain(runtimeModule);
  expect(source(graph.hostModules.get(innerModule))).toBe(
    selfhostWorkerEntrypointSource({
      originalMainModule: input.mainModule,
      declaredHandlers: input.declaredHandlers,
      bindings: [
        { name: "PLAIN", type: "plain_text" },
        { name: "JSON_VALUE", type: "json" },
        { name: "SECRET", type: "secret_text" },
        { name: "ROOM", type: "json" },
      ],
      publication: input.readiness.publication,
      probeHostname: input.readiness.probeHostname,
      events: true,
    }),
  );
  expect(source(graph.hostModules.get(runtimeModule))).toBe(
    renderSelfhostActorForwardRuntimeModuleSource(),
  );
  expect(source(graph.hostModules.get(outerModule))).toBe(
    selfhostActorForwardEntrypointSource({
      runtimeModule,
      innerModule,
      bindings: [actorBinding],
      queue: true,
      scheduled: true,
      events: true,
      projectEnvironment: true,
    }),
  );
  expect(graph.site.actorForward).toEqual({
    schema: "takoserver.selfhost-actor-forward@v1",
    bindings: [actorBinding],
  });
  expect(source(graph.hostModules.get(innerModule))).toContain('"name":"ROOM","type":"json"');
});

test("projects exact Workflow bindings from the selected V10 snapshot without aliasing it", () => {
  const workflowForward = workflowForwardInput();
  const input = graphInput({ workflowForward } as never);

  const graph = compileWorkerdVersionGraph(input);

  expect(graph.site).toMatchObject({
    workflowForward: {
      schema: "takoserver.selfhost-workflow-binding-forward@v1",
      snapshotDigest: workflowForward.snapshotDigest,
      bindings: [
        {
          publicName: "ORDERS",
          serviceName: "__TAKOSERVER_WORKFLOW_BINDING_00000",
          tenantId: "tenant-workflow-1",
          workflowResourceUid: "workflow-resource-001",
          workflowFormRef: workflowForward.bindings[0]?.workflowFormRef,
          bindingRef: workflowForward.bindings[0]?.bindingRef,
          runtimeClassRef: workflowForward.bindings[0]?.runtimeClassRef,
          token: SERVICE_TOKEN,
        },
      ],
    },
  });
  expect(graph.site).not.toBe(input);
  expect(graph.site.serviceBindings).toBeUndefined();
  expect(graph.site.vars?.some((binding) => binding.name === "ORDERS")).toBe(false);

  const callerBinding = workflowForward.bindings[0];
  if (!callerBinding) throw new Error("Workflow binding fixture unavailable");
  callerBinding.workflowFormRef.kind = "ChangedAfterProjection";
  callerBinding.token = "changed";
  expect(graph.site).toMatchObject({
    workflowForward: {
      bindings: [
        {
          workflowFormRef: { kind: "DurableWorkflow" },
          token: SERVICE_TOKEN,
        },
      ],
    },
  });
});

test("rejects non-selected Workflow refs, malformed snapshots, and cross-kind name aliases", () => {
  const valid = workflowForwardInput();
  const base = valid.bindings[0] as NonNullable<typeof valid.bindings>[number];
  const candidates = [
    {
      ...valid,
      bindings: [
        {
          ...base,
          workflowFormRef: { ...base.workflowFormRef, schemaDigest: `sha256:${"f".repeat(64)}` },
        },
      ],
    },
    {
      ...valid,
      bindings: [
        {
          ...base,
          bindingRef: { ...base.bindingRef, schemaDigest: `sha256:${"f".repeat(64)}` },
        },
      ],
    },
    {
      ...valid,
      bindings: [
        {
          ...base,
          runtimeClassRef: { ...base.runtimeClassRef, schemaDigest: `sha256:${"f".repeat(64)}` },
        },
      ],
    },
    { ...valid, snapshotDigest: "sha256:short" },
    { ...valid, bindings: [{ ...base, token: "not-a-token" }] },
    { ...valid, bindings: [{ ...base, extra: "not-a-closed-snapshot" }] },
    { ...valid, bindings: [{ ...base, workflowFormRef: { kind: "DurableWorkflow" } }] },
    { ...valid, bindings: [{ ...base, publicName: "__TAKOSERVER_INTERNAL" }] },
    { ...valid, bindings: [{ ...base }, { ...base }] },
    {
      ...valid,
      bindings: Array.from({ length: 65 }, (_, index) => ({
        ...base,
        publicName: `WORKFLOW_${index}`,
        workflowResourceUid: `workflow-resource-${index.toString().padStart(3, "0")}`,
      })),
    },
  ];
  for (const workflowForward of candidates) {
    expect(() => compileWorkerdVersionGraph(graphInput({ workflowForward } as never))).toThrow(
      TypeError,
    );
  }

  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        workflowForward: valid,
        environment: [{ name: "ORDERS", value: "{}", type: "json" }],
      } as never),
    ),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        workflowForward: valid,
        environment: [
          {
            name: "__TAKOSERVER_WORKFLOW_BINDING_00000",
            value: "reserved",
            type: "plain_text",
          },
        ],
      } as never),
    ),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        workflowForward: { ...valid, bindings: [{ ...base, publicName: "DATA" }] },
        dataPlane: {
          address: "127.0.0.1:4666",
          token: DATA_TOKEN,
          bindings: [{ kind: "edge.kv@1.0.0", publicName: "DATA" }],
        },
      } as never),
    ),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        workflowForward: valid,
        serviceBindings: [
          {
            publicName: "ORDERS",
            target: "orders",
            targetResourceUid: "service-resource-001",
            unavailableToken: "unavailable",
          },
        ],
      } as never),
    ),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        workflowForward: valid,
        actorForward: [
          {
            publicName: "ORDERS",
            tenantId: "tenant-actor-1",
            namespaceResourceUid: "actor-namespace-001",
            token: SERVICE_TOKEN,
          },
        ],
      } as never),
    ),
  ).toThrow(TypeError);
});

test("compiles the V10 maximum of 64 distinct Workflow bindings", () => {
  const binding = workflowForwardInput().bindings[0];
  if (!binding) throw new Error("Workflow binding fixture unavailable");
  const bindings = Array.from({ length: 64 }, (_, index) => ({
    ...binding,
    publicName: `WORKFLOW_${index}`,
    workflowResourceUid: `workflow-resource-${index.toString().padStart(3, "0")}`,
  }));

  const graph = compileWorkerdVersionGraph(
    graphInput({ workflowForward: { ...workflowForwardInput(), bindings } } as never),
  );

  expect(graph.site.workflowForward?.bindings).toHaveLength(64);
  expect(graph.site.workflowForward?.bindings.map((item) => item.serviceName)).toEqual(
    Array.from(
      { length: 64 },
      (_, index) => `__TAKOSERVER_WORKFLOW_BINDING_${index.toString().padStart(5, "0")}`,
    ),
  );
});

test("composes Workflow as the outer wrapper and preserves the selected event handlers", () => {
  const forward = workflowForwardInput();
  const input = graphInput({
    workflowForward: forward as never,
    declaredHandlers: ["fetch", "queue", "scheduled"],
    eventToken: EVENT_TOKEN,
  } as never);

  const graph = compileWorkerdVersionGraph(input);

  expect(graph.site.hostEntrypoint).toBe(SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE);
  expect(graph.site.hostModules).toContain(SELFHOST_WORKER_ENTRYPOINT_MODULE);
  expect(graph.site.hostModules).toContain(SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE);
  expect(source(graph.hostModules.get(SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE))).toBe(
    selfhostWorkflowBindingEntrypointSource({
      runtimeModule: SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE,
      innerModule: SELFHOST_WORKER_ENTRYPOINT_MODULE,
      bindings: [
        {
          publicName: "ORDERS",
          serviceName: "__TAKOSERVER_WORKFLOW_BINDING_00000",
          token: SERVICE_TOKEN,
        },
      ],
      queue: true,
      scheduled: true,
      events: true,
    }),
  );
  expect(source(graph.hostModules.get(SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE))).toBe(
    renderSelfhostWorkflowBindingRuntimeModuleSource(),
  );
  const innerWrapper = source(graph.hostModules.get(SELFHOST_WORKER_ENTRYPOINT_MODULE));
  expect(innerWrapper).toContain('"name":"ORDERS","type":"json"');
  expect(innerWrapper).not.toContain(SERVICE_TOKEN);
});

test("nests Workflow outside Actor and preserves both private facades and handlers", () => {
  const forward = workflowForwardInput();
  const actorForward = [
    {
      publicName: "ROOM",
      tenantId: "tenant-actor-1",
      namespaceResourceUid: "actor-namespace-001",
      token: SERVICE_TOKEN,
    },
  ];
  const input = graphInput({
    workflowForward: forward as never,
    actorForward,
    declaredHandlers: ["fetch", "queue", "scheduled"],
    eventToken: EVENT_TOKEN,
  } as never);

  const graph = compileWorkerdVersionGraph(input);

  expect(graph.site.hostEntrypoint).toBe(SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE);
  expect(graph.site.hostModules).toEqual([
    selfhostWorkerPreludeModuleName(input.mainModule),
    SELFHOST_WORKER_ENTRYPOINT_MODULE,
    "__takoserver-selfhost-actor-forward-runtime.js",
    "__takoserver-selfhost-actor-forward-entrypoint.js",
    SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE,
  ]);
  expect(source(graph.hostModules.get("__takoserver-selfhost-actor-forward-entrypoint.js"))).toBe(
    selfhostActorForwardEntrypointSource({
      runtimeModule: "__takoserver-selfhost-actor-forward-runtime.js",
      innerModule: SELFHOST_WORKER_ENTRYPOINT_MODULE,
      bindings: [
        {
          publicName: "ROOM",
          httpService: "__TAKOSERVER_ACTOR_HTTP_00000",
          upgradeService: "__TAKOSERVER_ACTOR_UPGRADE_00000",
          token: SERVICE_TOKEN,
        },
      ],
      queue: true,
      scheduled: true,
      events: true,
      projectEnvironment: true,
    }),
  );
  expect(source(graph.hostModules.get(SELFHOST_WORKFLOW_BINDING_ENTRYPOINT_MODULE))).toBe(
    selfhostWorkflowBindingEntrypointSource({
      runtimeModule: SELFHOST_WORKFLOW_BINDING_RUNTIME_MODULE,
      innerModule: "__takoserver-selfhost-actor-forward-entrypoint.js",
      bindings: [
        {
          publicName: "ORDERS",
          serviceName: "__TAKOSERVER_WORKFLOW_BINDING_00000",
          token: SERVICE_TOKEN,
        },
      ],
      queue: true,
      scheduled: true,
      events: true,
    }),
  );
});

test("compiles the released maximum of 64 distinct Actor forward bindings", () => {
  const actorForward = Array.from({ length: 64 }, (_, index) => ({
    publicName: `ROOM_${index}`,
    tenantId: "tenant-actor-1",
    namespaceResourceUid: `actor-namespace-${index.toString().padStart(3, "0")}`,
    token: SERVICE_TOKEN,
  }));

  const graph = compileWorkerdVersionGraph(graphInput({ actorForward }));

  expect(graph.site.actorForward?.bindings).toHaveLength(64);
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        actorForward: [
          ...actorForward,
          {
            publicName: "ROOM_64",
            tenantId: "tenant-actor-1",
            namespaceResourceUid: "actor-namespace-064",
            token: SERVICE_TOKEN,
          },
        ],
      }),
    ),
  ).toThrow(TypeError);
});

test("carries the exact forward Actor InterfaceRef into only its private manifest and wrapper", () => {
  const ref = forwardTakoformCandidates().forms.find(
    (form) => form.identity.formRef.kind === "ActorNamespace",
  )?.workerClassRuntime?.runtimeClassRef;
  if (!ref) throw new Error("forward Actor runtime InterfaceRef unavailable");
  const binding = {
    publicName: "ROOM",
    tenantId: "tenant-actor-1",
    namespaceResourceUid: "actor-namespace-001",
    token: SERVICE_TOKEN,
  };
  const legacy = compileWorkerdVersionGraph(graphInput({ actorForward: [binding] }));
  expect(legacy.site.actorForward?.bindings[0]).not.toHaveProperty("runtimeClassRef");
  const forward = compileWorkerdVersionGraph(
    graphInput({ actorForward: [{ ...binding, runtimeClassRef: ref }] }),
  );
  expect(forward.site.actorForward?.bindings[0]?.runtimeClassRef).toEqual(ref);
  const wrapper = source(
    forward.hostModules.get("__takoserver-selfhost-actor-forward-entrypoint.js"),
  );
  expect(wrapper).toContain(`"runtimeClassRef":${JSON.stringify(ref)}`);
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        actorForward: [
          {
            ...binding,
            runtimeClassRef: { ...ref, schemaDigest: `sha256:${"f".repeat(64)}` },
          },
        ],
      }),
    ),
  ).toThrow();
});

test("rejects malformed and colliding Actor forward projections", () => {
  const binding = {
    publicName: "ROOM",
    tenantId: "tenant-actor-1",
    namespaceResourceUid: "actor-namespace-001",
    token: SERVICE_TOKEN,
  };
  const candidates: Partial<WorkerdVersionGraphInput>[] = [
    { actorForward: [{ ...binding, publicName: "not-valid" }] },
    { actorForward: [{ ...binding, tenantId: "" }] },
    { actorForward: [{ ...binding, tenantId: "tenant\u0000invalid" }] },
    { actorForward: [{ ...binding, namespaceResourceUid: "x" }] },
    { actorForward: [{ ...binding, token: "not-a-token" }] },
    { actorForward: [{ ...binding }, { ...binding }] },
    {
      actorForward: Array.from({ length: 65 }, (_, index) => ({
        ...binding,
        publicName: `ROOM_${index}`,
        namespaceResourceUid: `actor-namespace-${index.toString().padStart(3, "0")}`,
      })),
    },
    { actorForward: [binding], environment: [{ name: "ROOM", value: "{}", type: "json" }] },
    {
      actorForward: [binding],
      dataPlane: {
        address: "127.0.0.1:4666",
        token: DATA_TOKEN,
        bindings: [{ kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "ROOM" }],
      },
    },
    {
      actorForward: [binding],
      serviceBindings: [
        {
          publicName: "ROOM",
          target: "target-worker",
          targetResourceUid: "uid-target-worker",
          unavailableToken: SERVICE_TOKEN,
        },
      ],
    },
  ];
  for (const candidate of candidates) {
    expect(() => compileWorkerdVersionGraph(graphInput(candidate))).toThrow(TypeError);
  }
});

test("compiles data, service, event, and asset projections with explicit publication", () => {
  const input = graphInput({
    modules: new Map([
      ["index.js", encoder.encode("export default { fetch() {}, queue() {}, scheduled() {} };\n")],
      ["worker.js", encoder.encode("export const worker = true;\n")],
    ]),
    moduleMediaTypes: {
      "index.js": "application/javascript+module",
      "worker.js": "application/javascript+module",
    },
    environment: [{ name: "PLAIN", value: "plain-value", type: "plain_text" }],
    assets: {
      files: new Map([
        ["index.html", encoder.encode("<h1>site</h1>\n")],
        ["style.css", encoder.encode("h1 { color: red }\n")],
      ]),
      notFoundHandling: "none",
      runWorkerFirst: true,
      mediaTypes: { "index.html": "text/html", "style.css": "text/css" },
    },
    dataPlane: {
      address: "127.0.0.1:4666",
      token: DATA_TOKEN,
      bindings: [
        { kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "KV" },
        { kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND, publicName: "BUCKET" },
        { kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" },
        { kind: SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND, publicName: "QUEUE" },
      ],
    },
    serviceBindings: [
      {
        publicName: "API",
        target: "target-worker",
        targetResourceUid: "uid-target-worker",
        unavailableToken: SERVICE_TOKEN,
      },
    ],
    hostnames: [],
    generation: "weighted-generation",
    declaredHandlers: ["fetch", "queue", "scheduled"],
    readiness: {
      publication: "weighted-publication",
      probeHostname: "weighted.selfhost-internal.invalid",
    },
    eventToken: EVENT_TOKEN,
  });
  const graph = compileWorkerdVersionGraph(input);
  const preludeModule = selfhostWorkerPreludeModuleName(input.mainModule);
  const serviceName = "__TAKOSERVER_SELFHOST_SERVICE_00000";
  const expectedSite: WorkerdVersionGraph["site"] = {
    directory: "site",
    mainModule: "index.js",
    hostEntrypoint: SELFHOST_WORKER_ENTRYPOINT_MODULE,
    hostModules: [preludeModule],
    hostnames: [],
    modules: ["worker.js"],
    moduleMediaTypes: {
      "index.js": "application/javascript+module",
      "worker.js": "application/javascript+module",
    },
    generation: "weighted-generation",
    workerResourceUid: "uid-worker-1",
    fetchHandler: true,
    vars: [{ name: "PLAIN", value: "plain-value", kind: "text" as const }],
    assets: {
      notFoundHandling: "none" as const,
      runWorkerFirst: true,
      mediaTypes: { "index.html": "text/html", "style.css": "text/css" },
    },
    dataPlane: {
      address: "127.0.0.1:4666",
      module: SELFHOST_WORKER_DATA_SERVICE_MODULE,
      vars: [
        { name: SELFHOST_WORKER_DATA_TOKEN_BINDING, value: DATA_TOKEN, kind: "text" as const },
      ],
    },
    serviceBindings: [
      {
        name: serviceName,
        target: "target-worker",
        targetResourceUid: "uid-target-worker",
        unavailableToken: SERVICE_TOKEN,
      },
    ],
    events: {
      module: SELFHOST_WORKER_EVENT_SERVICE_MODULE,
      vars: [
        { name: SELFHOST_WORKER_EVENT_TOKEN_BINDING, value: EVENT_TOKEN, kind: "text" as const },
      ],
    },
  };
  expect(graph.site).toEqual(expectedSite);
  expect([...graph.hostModules.keys()]).toEqual([
    SELFHOST_WORKER_ENTRYPOINT_MODULE,
    preludeModule,
    SELFHOST_WORKER_DATA_SERVICE_MODULE,
    SELFHOST_WORKER_EVENT_SERVICE_MODULE,
  ]);
  const expectedBindings: SelfhostWorkerBindingDescriptor[] = [
    { name: "PLAIN", type: "plain_text" },
    { kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "KV" },
    { kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND, publicName: "BUCKET" },
    { kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" },
    { kind: SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND, publicName: "QUEUE" },
    {
      kind: SELFHOST_WORKER_SERVICE_BINDING_KIND,
      publicName: "API",
      internalName: serviceName,
      unavailableToken: SERVICE_TOKEN,
    },
  ];
  expect(source(graph.hostModules.get(SELFHOST_WORKER_ENTRYPOINT_MODULE))).toBe(
    selfhostWorkerEntrypointSource({
      originalMainModule: "index.js",
      declaredHandlers: ["fetch", "queue", "scheduled"],
      bindings: expectedBindings,
      publication: "weighted-publication",
      probeHostname: "weighted.selfhost-internal.invalid",
      events: true,
    }),
  );
  expect(source(graph.hostModules.get(SELFHOST_WORKER_DATA_SERVICE_MODULE))).toBe(
    selfhostDataServiceSource(),
  );
  expect(source(graph.hostModules.get(SELFHOST_WORKER_EVENT_SERVICE_MODULE))).toBe(
    selfhostEventServiceSource(),
  );
  expect(graph.assets && [...graph.assets.keys()]).toEqual(["index.html", "style.css"]);
  expect(source(graph.hostModules.get(SELFHOST_WORKER_ENTRYPOINT_MODULE))).toContain(
    "weighted-publication",
  );
});

test("uses one ordinal map for accepted public and v2-private service names", () => {
  const binding = {
    publicName: "TARGET",
    target: "target-worker",
    targetResourceUid: "uid-target-worker",
    unavailableToken: SERVICE_TOKEN,
  };
  const graph = compileWorkerdVersionGraph(
    graphInput({
      generation: "takoserver-v2-operation:123e4567-e89b-42d3-a456-426614174000",
      serviceBindings: [binding],
    }),
  );
  expect(workerdVersionServiceBindingName(0, true)).toBe(
    "__TAKOSERVER_V2_PRIVATE_SELFHOST_SERVICE_BINDING_000000000000000000000_00000",
  );
  expect(graph.site.serviceBindings?.map(({ name }) => name)).toEqual([
    workerdVersionServiceBindingName(0, true),
  ]);
  expect(graph.site.hostEntrypoint).toBe(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE);
  expect(workerdVersionServiceBindingName(0, false)).toBe("__TAKOSERVER_SELFHOST_SERVICE_00000");
});

test("projects the opt-in edge.vector descriptor into the generated entrypoint", () => {
  const input = graphInput({
    dataPlane: {
      address: "127.0.0.1:4667",
      token: DATA_TOKEN,
      bindings: [{ kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND, publicName: "SEARCH" }],
    },
  });
  const graph = compileWorkerdVersionGraph(input);
  const entrypoint = source(graph.hostModules.get(SELFHOST_WORKER_ENTRYPOINT_MODULE));
  expect(entrypoint).toBe(
    selfhostWorkerEntrypointSource({
      originalMainModule: input.mainModule,
      declaredHandlers: input.declaredHandlers,
      bindings: [
        { name: "PLAIN", type: "plain_text" },
        { name: "JSON_VALUE", type: "json" },
        { name: "SECRET", type: "secret_text" },
        {
          kind: SELFHOST_WORKER_EDGE_VECTOR_BINDING_KIND,
          publicName: "SEARCH",
        },
      ],
      publication: input.readiness.publication,
      probeHostname: input.readiness.probeHostname,
    }),
  );
  expect(entrypoint).toContain('const VECTOR_KIND = "edge.vector@0.1.0";');
  expect(graph.site.dataPlane?.vars).toEqual([
    { name: SELFHOST_WORKER_DATA_TOKEN_BINDING, value: DATA_TOKEN, kind: "text" },
  ]);
});

test("copies every caller-owned map, byte array, and nested declaration", () => {
  const input = graphInput({
    assets: {
      files: new Map([["index.html", encoder.encode("index-original")]]),
      notFoundHandling: "none",
      runWorkerFirst: false,
      mediaTypes: { "index.html": "text/html" },
    },
    dataPlane: {
      address: "127.0.0.1:4666",
      token: DATA_TOKEN,
      bindings: [{ kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "KV" }],
    },
    serviceBindings: [
      {
        publicName: "API",
        target: "target-worker",
        targetResourceUid: "uid-target-worker",
        unavailableToken: SERVICE_TOKEN,
      },
    ],
    eventToken: EVENT_TOKEN,
  });
  const graph = compileWorkerdVersionGraph(input);
  const before = graphSnapshot(graph);
  const moduleBytes = input.modules.get("index.js");
  const assetBytes = input.assets?.files.get("index.html");
  const environment = input.environment as unknown as Array<{
    name: string;
    value: string;
    type: "plain_text" | "json" | "secret_text";
  }>;
  const assetMediaTypes = input.assets?.mediaTypes as Record<string, string> | undefined;
  const dataBindings = input.dataPlane?.bindings as unknown as
    | Array<{ kind: string; publicName: string }>
    | undefined;
  const serviceBindings = input.serviceBindings as unknown as Array<{
    publicName: string;
    target: string;
    targetResourceUid: string;
    unavailableToken: string;
  }>;
  if (
    !(moduleBytes instanceof Uint8Array) ||
    !(assetBytes instanceof Uint8Array) ||
    !environment[0] ||
    !assetMediaTypes ||
    !dataBindings?.[0] ||
    !serviceBindings[0]
  ) {
    throw new Error("test fixture incomplete");
  }
  moduleBytes.set(encoder.encode("mutated"));
  assetBytes.set(encoder.encode("asset-mutated"));
  environment[0].value = "environment-mutated";
  assetMediaTypes["index.html"] = "text/css";
  dataBindings[0].publicName = "DB";
  serviceBindings[0].target = "mutated-worker";
  (input.hostnames as string[]).push("mutated.example.invalid");
  (input.readiness as { publication: string; probeHostname: string }).publication = "mutated";
  expect(graphSnapshot(graph)).toEqual(before);
  expect(graph.modules).not.toBe(input.modules);
  expect(graph.modules.get("index.js")).not.toBe(input.modules.get("index.js"));
  expect(graph.assets).not.toBe(input.assets?.files);
});

test("preserves an explicit weighted publication while emitting no routes", () => {
  const graph = compileWorkerdVersionGraph(
    graphInput({
      hostnames: [],
      generation: "weighted-generation",
      readiness: {
        publication: "publication-verbatim",
        probeHostname: "weighted.selfhost-internal.invalid",
      },
    }),
  );
  expect(graph.site.hostnames).toEqual([]);
  expect(graph.site.generation).toBe("weighted-generation");
  expect(source(graph.hostModules.get(SELFHOST_WORKER_ENTRYPOINT_MODULE))).toContain(
    "publication-verbatim",
  );
});

test("rejects incomplete module and asset media maps and a non-JavaScript main", () => {
  const base = graphInput();
  expect(() =>
    compileWorkerdVersionGraph({
      ...base,
      moduleMediaTypes: { "index.js": "application/javascript+module" },
    }),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph({
      ...base,
      moduleMediaTypes: {
        "index.js": "application/javascript+module",
        "module.txt": "text/plain",
        "extra.js": "application/javascript+module",
      },
    }),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph({
      ...base,
      mainModule: "module.txt",
    }),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph({
      ...base,
      assets: {
        files: new Map([["index.html", encoder.encode("index")]]),
        notFoundHandling: "none",
        runWorkerFirst: false,
        mediaTypes: {},
      },
    }),
  ).toThrow(TypeError);
});

test("rejects duplicate public names, service bindings without a Worker UID, and empty tokens", () => {
  const service = {
    publicName: "SHARED",
    target: "target-worker",
    targetResourceUid: "uid-target-worker",
    unavailableToken: SERVICE_TOKEN,
  };
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({ environment: [{ name: "SHARED", value: "x", type: "plain_text" }] }),
    ),
  ).not.toThrow();
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        environment: [{ name: "SHARED", value: "x", type: "plain_text" }],
        serviceBindings: [service],
      }),
    ),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        environment: [{ name: "SHARED", value: "x", type: "plain_text" }],
        dataPlane: {
          address: "127.0.0.1:4666",
          token: DATA_TOKEN,
          bindings: [{ kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "SHARED" }],
        },
      }),
    ),
  ).toThrow(TypeError);
  expect(() =>
    compileWorkerdVersionGraph(
      graphInput({
        dataPlane: {
          address: "127.0.0.1:4666",
          token: DATA_TOKEN,
          bindings: [{ kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "SHARED" }],
        },
        serviceBindings: [service],
      }),
    ),
  ).toThrow(TypeError);

  const withoutUid = graphInput({ serviceBindings: [service] });
  delete (withoutUid as { workerResourceUid?: string }).workerResourceUid;
  expect(() => compileWorkerdVersionGraph(withoutUid)).toThrow(TypeError);

  const emptyDataToken = graphInput({
    dataPlane: { address: "127.0.0.1:4666", token: "", bindings: [] },
  });
  const emptyDataAddress = graphInput({
    dataPlane: { address: "", token: DATA_TOKEN, bindings: [] },
  });
  const emptyEventToken = graphInput({ eventToken: "" });
  const emptyServiceToken = graphInput({ serviceBindings: [{ ...service, unavailableToken: "" }] });
  const emptyServiceTarget = graphInput({ serviceBindings: [{ ...service, target: "" }] });
  const emptyServiceTargetUid = graphInput({
    serviceBindings: [{ ...service, targetResourceUid: "" }],
  });
  const malformedServiceToken = graphInput({
    serviceBindings: [{ ...service, unavailableToken: "x".repeat(64) }],
  });
  for (const candidate of [
    emptyDataToken,
    emptyDataAddress,
    emptyEventToken,
    emptyServiceToken,
    emptyServiceTarget,
    emptyServiceTargetUid,
    malformedServiceToken,
  ]) {
    expect(() => compileWorkerdVersionGraph(candidate)).toThrow(TypeError);
  }
});

test("omits both scalar Worker identity fields when no UID is supplied", () => {
  const input = graphInput();
  delete (input as { workerResourceUid?: string }).workerResourceUid;
  const graph = compileWorkerdVersionGraph(input);
  expect(Object.hasOwn(graph.site, "workerResourceUid")).toBe(false);
  expect(Object.hasOwn(graph.site, "fetchHandler")).toBe(false);
});
