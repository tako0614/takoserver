import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import { createLinuxOciContainerBindingSource } from "../src/providers/linux-oci-container-binding-broker.ts";
import { createSelfhostContainerBindingBroker } from "../src/providers/selfhost-container-binding-broker.ts";
import {
  makeContainerBinding,
  selfhostContainerBindingClientSource,
} from "../src/providers/selfhost-container-binding-client.ts";
import { selfhostWorkerPreludeModuleName } from "../src/providers/selfhost-worker-prelude.ts";
import {
  createSelfhostV2ContainerWorkerComposition,
  createSelfhostV2WorkerComposition,
} from "../src/selfhost-v2-worker-composition.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/container-consumer-specs.ts";
import { parseForwardWorkerVersionSpec } from "../src/takoform-v2/forms/worker-specs.ts";
import { currentClaim } from "../src/takoform-v2/module-worker-lifecycle-backend.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { inspectV2WorkerCodeVersionEligibility } from "../src/takoform-v2/worker-code-eligibility.ts";
import {
  createInternalV2ContainerConsumerWorkerVersionForm,
  WORKER_VERSION_UNIFIED_BACKEND_ID,
} from "../src/takoform-v2/worker-lifecycle-backend.ts";
import type { V2WorkerPublicationResolution } from "../src/takoform-v2/worker-publication-state.ts";
import { createV2WorkerPublication } from "../src/takoform-v2/worker-static-publication.ts";
import type {
  WorkerdDeploymentPublication,
  WorkerdPublicationIdentity,
  WorkerdSite,
  WorkerdStaticSite,
} from "../src/workerd-runtime.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";
import { observeRawPromise, ownedRawHttp, rawTick } from "./container-http-transport.test.ts";
import { bindingOriginal, rawNativeOwner } from "./linux-oci-container-binding-broker.test.ts";
import { originalOciNodeBindingFixture } from "./selfhost-linux-container-node-composition.test.ts";

// Emitted graph/codec and actual publication bodies, with explicit inspection/
// native-publish boundary models. No Workerd, listener, socket or child executes.
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function graph(mainModule: string, names: readonly string[] = ["APP"]) {
  return compileWorkerdVersionGraph({
    directory: "site",
    mainModule,
    modules: new Map([
      [
        mainModule,
        encoder.encode("export default {fetch(request,env){return env.APP.fetch(request)}};"),
      ],
    ]),
    moduleMediaTypes: { [mainModule]: "application/javascript+module" },
    environment: [],
    serviceBindings: [
      {
        publicName: "APP",
        target: "v2-worker-" + "a".repeat(64),
        targetResourceUid: "container-uid",
        unavailableToken: "b".repeat(64),
      },
    ],
    hostnames: [],
    generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
    workerResourceUid: "worker-uid",
    declaredHandlers: ["fetch"],
    readiness: { publication: "pub", probeHostname: "site.selfhost-internal.invalid" },
    ociContainerBindings: names,
  });
}
async function evaluateWrapper(
  g: ReturnType<typeof compileWorkerdVersionGraph>,
  applicationSource?: string,
) {
  const url = (bytes: Uint8Array) =>
    `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
  const application = url(
    applicationSource === undefined
      ? g.modules.get(g.site.mainModule)!
      : encoder.encode(applicationSource),
  );
  let source = decoder.decode(g.hostModules.get(g.site.hostEntrypoint!)!);
  source = source.replaceAll(JSON.stringify(`./${g.site.mainModule}`), JSON.stringify(application));
  for (const [name, bytes] of g.hostModules) {
    if (name !== g.site.hostEntrypoint)
      source = source.replaceAll(JSON.stringify(`./${name}`), JSON.stringify(url(bytes)));
  }
  const namespace = await import(url(encoder.encode(source)));
  return {
    wrapper: namespace.default as {
      fetch: (request: Request, env: object, context?: object) => Promise<Response>;
    },
    application: await import(application),
  };
}

test("OCI Composition closed graph keeps legal application/prelude identities and actual Container client bytes", async () => {
  for (const main of [
    "index.js",
    "__takoserver-selfhost-prelude.js",
    "__takoserver-v2-private-container-entrypoint.js",
    "__takoserver-v2-private-container-client.js",
  ]) {
    const g = graph(main);
    const wrapper = decoder.decode(g.hostModules.get(g.site.hostEntrypoint!));
    expect(wrapper).toContain(`from "./${selfhostWorkerPreludeModuleName(main)}"`);
    expect(wrapper).toContain(`TenantWorkerModule from "./${main}"`);
    expect(wrapper).toContain("validateOriginal(TenantWorkerModule)");
    const clients = [...g.hostModules].filter(([name]) => name.includes("container-client"));
    expect(clients).toHaveLength(1);
    expect(clients[0]![0]).not.toBe(main);
    expect(decoder.decode(clients[0]![1])).toBe(selfhostContainerBindingClientSource());
    expect(g.site.mainModule).toBe(main);
    expect(g.modules.has(main)).toBe(true);
    let originalUrl = "";
    const broker = createSelfhostContainerBindingBroker({
      async dispatch(request) {
        originalUrl = request.url;
        return new Response("NONSECRET projected body");
      },
    });
    const { wrapper: actual, application } = await evaluateWrapper(
      g,
      `let reads=0; const original={ get fetch(){ reads++; return (request,env)=>env.APP.fetch(request) } }; export default original; export function count(){return reads}; export function mutate(){Object.defineProperty(original,"fetch",{value:()=>new Response("BAD mutation")})};`,
    );
    const env = { [g.site.serviceBindings![0]!.name]: { fetch: broker } };
    expect(
      await (await actual.fetch(new Request("http://ignored.invalid/adapter?q=1"), env)).text(),
    ).toBe("NONSECRET projected body");
    application.mutate();
    expect(
      await (await actual.fetch(new Request("http://ignored.invalid/adapter?q=1"), env)).text(),
    ).toBe("NONSECRET projected body");
    expect(application.count()).toBe(1);
    expect(originalUrl).toBe("http://logical.invalid/adapter?q=1");
  }
  expect(() => graph("index.js", ["FOREIGN"])).toThrow();
  expect(() => graph("index.js", ["APP", "APP"])).toThrow();
});

async function material() {
  const file = encoder.encode(
    "export default { fetch(request,env){ return env.APP.fetch(request) } };\n",
  );
  const manifest = {
    entrypoint: "index.js",
    files: [
      {
        path: "index.js",
        url: "https://NONSECRET.invalid/index.js",
        sha256: sha(file),
        mediaType: "application/javascript+module" as const,
      },
    ],
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  return {
    manifest,
    manifestBytes,
    files: [file],
    observed: {
      manifestSha256: (await bytesDigest(manifestBytes)).slice(7),
      fileCount: 1,
      totalBytes: file.length,
      entrypoint: "index.js",
      files: [
        {
          path: "index.js",
          sha256: sha(file),
          mediaType: "application/javascript+module",
          byteSize: file.length,
        },
      ],
    },
  };
}

test("OCI Composition accepted source feeds original publication and same native caller dispatch", async () => {
  const x = await bindingOriginal(),
    io = ownedRawHttp();
  try {
    const n = await rawNativeOwner(x),
      bundle = await material();
    const spec = parseForwardWorkerVersionSpec(x.spec);
    const resolved = spec.containerBindings.map((binding) => ({
      name: binding.name,
      resourceUid: binding.resource.resourceUid,
    }));
    const eligibility = {
      workerResourceUid: x.claim.workerUid,
      bundleResourceUid: spec.bundle!.resourceUid,
      spec,
      sourceForm: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      bundle,
      inspectModule: async () => ({
        outcome: "valid" as const,
        exportedHandlers: ["fetch" as const],
      }),
    };
    // Pure metadata cannot bypass the missing-source/vector gate.
    expect(
      await observeRawPromise(inspectV2WorkerCodeVersionEligibility(eligibility)).value,
    ).toHaveProperty("error");
    await inspectV2WorkerCodeVersionEligibility({
      ...eligibility,
      resolvedContainerBindings: resolved,
    });
    expect(
      await observeRawPromise(
        inspectV2WorkerCodeVersionEligibility({
          ...eligibility,
          resolvedContainerBindings: [{ name: "APP", resourceUid: "foreign" }],
        }),
      ).value,
    ).toHaveProperty("error");
    expect(
      await x.source.readVersionTarget({
        ...x.claim,
        workerVersionUid: x.claim.workerVersionUid,
        targetUid: x.claim.targetUid,
      }),
    ).toBe(x.claim.targetUid);
    const execution: V2Execution = {
      operationId: x.claim.incarnationId,
      leaseToken: "NONSECRET-fixture",
      backendKey: "NONSECRET-fixture",
      backendId: "NONSECRET-pub-model",
      targetKey: x.claim.targetKey,
      resourceUid: crypto.randomUUID(),
      principal: x.claim.principal,
      space: x.claim.space,
      action: "create",
      generation: 1,
      form: CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
      name: "deployment",
      spec: {},
      previousObserved: {},
      previousOutput: {},
    };
    const resolution: Extract<V2WorkerPublicationResolution, { kind: "ready" }> = {
      kind: "ready",
      // This predicate is never executed: only pure publication/material paths
      // run. Actual Core accepted target reads remain the source below.
      sqlGuard: { sql: "0", params: [] },
      snapshot: {
        sourceOperationId: execution.operationId,
        worker: {
          uid: x.claim.workerUid,
          principal: x.claim.principal,
          space: x.claim.space,
          generation: 1,
        },
        deployment: {
          uid: execution.resourceUid,
          generation: 1,
          spec: {
            worker: { resourceUid: x.claim.workerUid },
            versions: [{ workerVersion: { resourceUid: x.claim.workerVersionUid }, weight: 10000 }],
          },
          versions: [
            {
              uid: x.claim.workerVersionUid,
              sourceOperationId: x.claim.operationId,
              generation: 1,
              weight: 10000,
              spec,
              form: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
              bucketBindings: [],
            },
          ],
        },
        endpoint: null,
      },
      stillCurrent: async () => (await x.source.read(x.claim)) !== null,
      readVersionMaterials: async () => ({ bundle, assets: null }),
    };
    let issued = 0;
    let publication: WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null = null;
    let observed = false;
    const original = createV2WorkerPublication({
      targetKey: x.claim.targetKey,
      publicationState: { resolve: async () => resolution, resolveForward: async () => resolution },
      v2ContainerBindingForward: {
        async issueBinding(claim, binding) {
          issued++;
          expect(claim).toEqual(x.claim);
          await n.binder.issueBinding(claim, binding);
        },
      },
      runtime: {
        inspectModule: eligibility.inspectModule,
        async publishFenced(_name, read, fence) {
          publication = await read(null);
          expect(await fence()).toBe(true);
          observed = true;
        },
        async observeExactPublication() {
          return observed ? "matches" : "different";
        },
      },
    });
    expect(await original.publish(execution)).toMatchObject({ kind: "confirmed" });
    expect(issued).toBeGreaterThan(0);
    expect(publication).not.toBeNull();
    const variant = publication!.versions[0]!;
    expect([...variant.hostModules!.keys()].some((name) => name.includes("container-client"))).toBe(
      true,
    );
    const broker = createSelfhostContainerBindingBroker({ dispatch: n.dispatch });
    const { wrapper: caller } = await evaluateWrapper({
      site: variant.site as WorkerdSite,
      modules: variant.modules!,
      hostModules: variant.hostModules!,
    });
    const call = observeRawPromise(
      caller.fetch(new Request("http://caller.invalid/from-original-publication"), {
        [variant.site.serviceBindings![0]!.name]: { fetch: broker },
      }),
    );
    for (let i = 0; i < 50 && !io.counts().calls; i++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    const head = await call.value;
    if (!("result" in head)) throw head.error;
    io.incoming.end("NONSECRET native target");
    expect(await head.result.text()).toBe("NONSECRET native target");
    expect(n.handle.serviceBindingLeases.size).toBe(1);
    io.closeResponse();
    io.closeRequest();
    for (let i = 0; i < 30 && n.handle.serviceBindingLeases.size; i++) await rawTick();
    expect(n.handle.serviceBindingLeases.size).toBe(0);
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});

test("OCI Composition original Version Form keeps absent-source refusal and repeats target basis after inspection", async () => {
  const x = await bindingOriginal();
  const bundle = await material();
  let targetUnknown = false,
    targetReads = 0,
    inspection = 0;
  const query = x.f.sql.query.bind(x.f.sql);
  // The source captures this actual same-Sql query before any eligibility await.
  const { spyOn } = await import("bun:test");
  const intercept = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
    const rows = await query(sql, params);
    if (sql.startsWith("SELECT r.uid FROM tf_v2_resources r")) {
      targetReads++;
      if (targetUnknown) return [];
    }
    return rows;
  });
  try {
    const source = createLinuxOciContainerBindingSource({
      sql: x.f.sql,
      targetKey: x.claim.targetKey,
      workerBackendId: WORKER_VERSION_UNIFIED_BACKEND_ID,
      containerBackendId: "synthetic-oci-backend",
      original: x.f.composition,
    });
    const resolve = async ({ execution }: { execution: V2Execution }) => ({
      kind: "ready" as const,
      // Explicit held-material resolution boundary model. Exact reference
      // acceptance and current SQL claim below run through the original Engine.
      snapshot: {
        sourceOperationId: execution.operationId,
        worker: {
          uid: x.claim.workerUid,
          principal: execution.principal,
          space: execution.space,
          generation: 1,
        },
        version: {
          uid: execution.resourceUid,
          generation: execution.generation,
          spec: parseForwardWorkerVersionSpec(execution.spec),
          form: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
          bucketBindings: [],
        },
      },
      stillCurrent: () => currentClaim(x.f.sql, execution),
      readMaterials: async () => ({ bundle, assets: null }),
    });
    const options = {
      sql: x.f.sql,
      targetKey: x.claim.targetKey,
      publicationState: { resolveVersion: resolve, resolveForwardVersion: resolve },
      retirement: { observeRetired: async () => ({ kind: "unknown" as const }) },
      inspectModule: async () => {
        inspection++;
        if (inspection === 2) targetUnknown = true;
        return { outcome: "valid" as const, exportedHandlers: ["fetch" as const] };
      },
    };
    const absent = createInternalV2ContainerConsumerWorkerVersionForm(options);
    expect(() => absent.validateCreate(x.spec)).toThrow("capability_required");
    const form = createInternalV2ContainerConsumerWorkerVersionForm({
      ...options,
      v2ContainerBinding: source,
    });
    expect(() => form.validateCreate(x.spec)).not.toThrow();
    const engine = createTakoformV2Engine({
      sql: x.f.sql,
      now: () => new Date(),
      replayWindowSeconds: 3600,
      authorize: async () => true,
      forms: { [CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]: form },
    });
    await engine.acceptCreate({
      principal: x.claim.principal,
      key: crypto.randomUUID(),
      input: {
        form: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
        space: x.claim.space,
        name: "original-code-form",
        spec: x.spec,
      },
    });
    expect(await engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(inspection).toBe(1);
    expect(targetReads).toBe(2);
    await engine.acceptCreate({
      principal: x.claim.principal,
      key: crypto.randomUUID(),
      input: {
        form: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
        space: x.claim.space,
        name: "original-code-form-refusal",
        spec: x.spec,
      },
    });
    expect(await engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect(inspection).toBe(2);
    expect(targetReads).toBe(4);
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    intercept.mockRestore();
    await x.cleanup();
  }
});

test("OCI Composition actual Node source is selected by the same Sql Worker constructor only", async () => {
  const f = await originalOciNodeBindingFixture();
  const root = await mkdtemp("/root/dev/tmp/oci-binding-composition-");
  const node = f.compose();
  try {
    const source = node.containerBindingSource;
    expect(source).toBeDefined();
    if (!source) throw Error("original OCI Node source absent");
    const options = {
      ...f.context,
      config: {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://NONSECRET.invalid",
        authenticationDocumentation: "https://NONSECRET.invalid/auth",
      },
      rootDirectory: join(root, "owners"),
      targetKey: f.source.targetKey,
      workerdBinary: null,
    };
    expect(() =>
      createSelfhostV2ContainerWorkerComposition({
        ...options,
        sql: { ...f.sql },
        ociContainerBinding: source,
      }),
    ).toThrow("foreign_sql");
    expect(() =>
      createSelfhostV2ContainerWorkerComposition({
        ...options,
        targetKey: "foreign",
        ociContainerBinding: source,
      }),
    ).toThrow("profile mismatch");
    const actual = createSelfhostV2ContainerWorkerComposition({
      ...options,
      ociContainerBinding: source,
    });
    expect(await actual.restoreOwners()).toEqual([]);
    const selected = actual.internalFormFactory(f.context);
    expect(Object.hasOwn(selected, CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL)).toBe(true);
    const unchanged = createSelfhostV2WorkerComposition({
      ...options,
      rootDirectory: join(root, "old"),
    });
    expect(await unchanged.restoreOwners()).toEqual([]);
    expect(
      Object.hasOwn(
        unchanged.internalFormFactory(f.context),
        CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      ),
    ).toBe(false);
    await actual.closePrivateBindingServices();
    await actual.closeScheduledHost();
    await actual.closeWorkflowHost();
    await unchanged.closePrivateBindingServices();
    await unchanged.closeScheduledHost();
    await unchanged.closeWorkflowHost();
    expect(f.io()).toBe(0);
  } finally {
    await f.close();
    await rm(root, { recursive: true });
  }
});
