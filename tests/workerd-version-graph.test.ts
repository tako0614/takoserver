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
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
  SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  SELFHOST_WORKER_SERVICE_BINDING_KIND,
  type SelfhostWorkerBindingDescriptor,
  selfhostWorkerEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import {
  compileWorkerdVersionGraph,
  type WorkerdVersionGraph,
  type WorkerdVersionGraphInput,
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

function source(bytes: Uint8Array | undefined): string {
  if (!bytes) throw new Error("expected generated module");
  return decoder.decode(bytes);
}

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
