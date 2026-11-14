import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as net from "node:net";
import ts from "typescript";
import { canonicalJson } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import {
  createLinuxOciContainerBindingSource,
  type LinuxOciWorkerdContainerClaim,
} from "../src/providers/linux-oci-container-binding-broker.ts";
import { createSelfhostContainerBindingBroker } from "../src/providers/selfhost-container-binding-broker.ts";
import { makeContainerBinding } from "../src/providers/selfhost-container-binding-client.ts";
import { openSelfhostContainerBindingSocket } from "../src/providers/selfhost-container-binding-socket.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  fixedReferencesForForwardFamilyWorkerVersion,
  prepareContainerConsumerWorkerVersionReferences,
} from "../src/takoform-v2/forms/container-consumer-references.ts";
import { CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL } from "../src/takoform-v2/forms/container-consumer-specs.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseForwardWorkerVersionSpec,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL } from "../src/takoform-v2/operation-generation-index.ts";
import { v2ServiceTargetName } from "../src/takoform-v2/worker-service-resolution.ts";
import {
  workerdServiceBindingRouterName,
  workerdV2ServiceBindingBrokerSocketPath,
} from "../src/workerd-runtime.ts";
import { observeRawPromise, ownedRawHttp, rawTick } from "./container-http-transport.test.ts";
import {
  acceptedHttpSelection,
  acceptedRawHttp,
  originalOwnedOciFixture,
} from "./linux-oci-owned-bundle.test.ts";

// Only the selected new cases execute. Imported old case bodies never run.
// Original signed Core/Engine/OCI creator + memorySQLite + raw P/H/HTTP streams.
// Workerd's selected ORIGINAL owner bodies below use explicit OS-boundary data;
// this is not an actual Workerd/native process or configuration qualification.
export async function bindingOriginal() {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0xa5),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const comparison = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0x5a),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  let byte = 0x60;
  const random = spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(value: T): T => {
      if (!(value instanceof Uint8Array)) throw Error("NONSECRET raw random shape");
      value.fill(++byte);
      return value;
    },
  );
  const network = spyOn(net, "createConnection").mockImplementation(() => {
    throw Error("unexpected actual socket");
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  let f: Awaited<ReturnType<typeof originalOwnedOciFixture>> | undefined;
  try {
    f = await originalOwnedOciFixture(false, {
      ...acceptedHttpSelection(),
      normalBackend: true,
      parentPeer: true,
      fixedKeys: { key, comparison },
    });
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(f.failures).toEqual([]);
    health.restore();
    const actual = f;
    // Accepted graph fixture backends are metadata only, not native authority.
    const backendId = "NONSECRET-worker-metadata";
    await actual.sql.run(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL);
    const metadata = (observed: JsonObject = {}) => ({
      validateCreate: () => undefined,
      validateUpdate: () => undefined,
      backend: {
        id: backendId,
        targetKey: "synthetic-oci-target",
        async execute() {
          return { kind: "complete" as const, observed, output: {} };
        },
        async reconcile() {
          return { kind: "unknown" as const };
        },
      },
    });
    const engine = createTakoformV2Engine({
      sql: actual.sql,
      now: () => new Date(),
      replayWindowSeconds: 3600,
      authorize: async () => true,
      forms: {
        [MODULE_WORKER_FORM_URL]: metadata(),
        [WORKER_BUNDLE_FORM_URL]: metadata({ ready: true }),
        [CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]: {
          ...metadata({ ready: true, resolvedBindings: true, bundleVerified: true }),
          validateCreate: parseForwardWorkerVersionSpec,
          references: (spec) =>
            fixedReferencesForForwardFamilyWorkerVersion(
              CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
              parseForwardWorkerVersionSpec(spec),
            ),
          prepareAdmission: prepareContainerConsumerWorkerVersionReferences,
        },
      },
    });
    const create = async (form: string, name: string, spec: JsonObject = {}) => {
      const op = await engine.acceptCreate({
        principal: "synthetic-oci-parent",
        key: crypto.randomUUID(),
        input: { form, space: "synthetic-space", name, spec },
      });
      expect(await engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
      return op;
    };
    const worker = await create(MODULE_WORKER_FORM_URL, "binding-worker");
    const bundle = await create(WORKER_BUNDLE_FORM_URL, "binding-bundle");
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      containerBindings: [{ name: "APP", resource: { resourceUid: accepted.resourceUid } }],
    };
    const version = await create(
      CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      "binding-version",
      spec,
    );
    const operation = crypto.randomUUID();
    const claim: LinuxOciWorkerdContainerClaim = {
      principal: "synthetic-oci-parent",
      space: "synthetic-space",
      targetKey: "synthetic-oci-target",
      workerUid: worker.resourceUid,
      workerVersionUid: version.resourceUid,
      workerVersionGeneration: 1,
      workerVersionFormUrl: CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
      operationId: version.id,
      bindingName: "APP",
      targetUid: accepted.resourceUid,
      nativeVersionId: `v2-${createHash("sha256").update(`${version.resourceUid}\0${1}`).digest("hex")}`,
      incarnationId: operation,
      servingSourceOperationId: operation,
    };
    const source = createLinuxOciContainerBindingSource({
      sql: actual.sql,
      targetKey: claim.targetKey,
      workerBackendId: backendId,
      containerBackendId: "synthetic-oci-backend",
      original: actual.composition,
    });
    return {
      f: actual,
      accepted,
      source,
      claim,
      spec,
      network,
      async cleanup() {
        try {
          await actual.close();
        } catch {
          /* retain unknown, not an authority oracle */
        } finally {
          random.mockRestore();
          network.mockRestore();
        }
      },
    };
  } catch (error) {
    health.restore();
    try {
      await f?.close();
    } catch {
      /* raw teardown only */
    }
    random.mockRestore();
    network.mockRestore();
    throw error;
  }
}

// Repo-only extraction: these exact variable declarations are compiled without
// edits by Bun.Transpiler. No copied owner implementation/positive owner factory.
// The returned closure is private to this raw boundary model, never production.
export function ownerDeclarations() {
  const path = new URL("../src/workerd-worker-runtime-owner.ts", import.meta.url);
  const text = readFileSync(path, "utf8");
  const ast = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true);
  const names = [
    "observeVersionTargetCore",
    "acquireServiceBindingRequest",
    "containerBindingForward",
  ];
  return names.map((name) => {
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === name,
        )
      )
        found.push(node.getText(ast));
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (found.length !== 1) throw Error(`actual owner declaration ${name}`);
    return {
      name,
      source: found[0]!,
      sha256: createHash("sha256").update(found[0]!).digest("hex"),
    };
  });
}
export async function rawNativeOwner(x: Awaited<ReturnType<typeof bindingOriginal>>) {
  const source = x.source;
  const claim = x.claim;
  const identity = {
    workerResourceUid: claim.workerUid,
    generation: `takoserver-v2-operation:${claim.incarnationId}`,
    versions: [{ versionId: claim.nativeVersionId, workerVersionUid: claim.workerVersionUid }],
  };
  const record = {
    operationId: claim.incarnationId,
    status: "active",
    identity,
    receipt: null,
    executionCopiesCleanupStarted: false,
    executionCopiesReleased: false,
    processIdentity: { pid: 1234, startTimeTicks: "NONSECRET-model" },
    configurationSha256: "c".repeat(64),
    configurationRefreshPending: false,
    listenerPort: 4567,
    retireAtMs: null,
    deferRetirementUntilDeadline: false,
  };
  const boundary = {
    ready: true,
    live: true,
    port: true,
    pinned: true,
    socketCloses: 0,
    nativeReads: 0,
  };
  let dispatch: ((request: Request) => Promise<Response>) | undefined;
  const handle = {
    record,
    group: { isReady: () => boundary.ready, configurationSha256: record.configurationSha256 },
    serviceBindingLeases: new Set<Promise<void>>(),
    containerCalls: new Set<{ abort: AbortController }>(),
    invocations: new Set(),
  };
  const handles = new Map([[record.operationId, handle]]);
  const binding = {
    name: "__takoserver_v2_service_0",
    target: await v2ServiceTargetName(claim.targetUid),
    targetResourceUid: claim.targetUid,
    unavailableToken: "a".repeat(64),
  };
  const snapshot = {
    worker: { uid: claim.workerUid, principal: claim.principal, space: claim.space },
    deployment: {
      versions: [
        {
          uid: claim.workerVersionUid,
          form: claim.workerVersionFormUrl,
          generation: 1,
          sourceOperationId: claim.operationId,
        },
      ],
    },
  };
  const options = {
    workerResourceUid: claim.workerUid,
    targetKey: claim.targetKey,
    v2ContainerBinding: source,
    publicationState: {
      async resolveCurrentServing() {
        return {
          kind: "ready",
          snapshot,
          async stillCurrent() {
            return true;
          },
        };
      },
    },
  };
  const serviceBindingBrokers = new Map();
  const env = {
    options,
    record,
    handles,
    active: handle,
    state: { activeOperationId: record.operationId },
    recordFor: (id: string) => (id === record.operationId ? handles.get(id)?.record : undefined),
    runSerial: async (fn: () => unknown) => fn(),
    canonicalJson,
    readPinnedGroupConfiguration: async () => {
      boundary.nativeReads++;
      return boundary.pinned ? { original: "NONSECRET-model-config" } : null;
    },
    linuxProcessLiveness: async () => (boundary.live ? "live" : "absent"),
    workerPortOwnership: async () => (boundary.port ? "owned" : "foreign"),
    expectedOperationMarker: (id: string) => `takoserver-v2-operation:${id}`,
    OPERATION_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    WorkerdWorkerRuntimeOwnerError: class extends Error {
      constructor(code: string) {
        super(code);
      }
    },
    serviceBindingBrokers,
    privateSocketDirectoryFor: () => "/NONSECRET-model-owned",
    v2ServiceTargetName,
    workerdServiceBindingRouterName,
    workerdV2ServiceBindingBrokerSocketPath,
    openSelfhostContainerBindingSocket: async (input: {
      dispatch: (r: Request) => Promise<Response>;
      socketName: string;
    }) => {
      expect(input.socketName).toMatch(/^[a-f0-9]{64}\.sock$/u);
      dispatch = input.dispatch;
      return {
        path: `/NONSECRET-model-owned/${input.socketName}`,
        identity: { dev: 1, ino: 2, uid: 0 },
        close: async () => {
          boundary.socketCloses++;
        },
      };
    },
    retireIncarnation: async () => {
      throw Error("unexpected model native retirement");
    },
  };
  const program = `const {${Object.keys(env).join(",")}}=env;let closed=false,suspending=false,admissionClosedBy=null;\n${ownerDeclarations()
    .map((v) => v.source)
    .join(
      "\n",
    )}\nreturn { binder:containerBindingForward, fence(){admissionClosedBy="retiring";}, revoke(){handles.delete(record.operationId);}, close(){closed=true;} };`;
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(program);
  const native = new Function("env", compiled)(env) as {
    binder: { issueBinding: (c: typeof claim, b: typeof binding) => Promise<void> };
    fence: () => void;
    revoke: () => void;
    close: () => void;
  };
  await native.binder.issueBinding(claim, binding);
  if (!dispatch) throw Error("original native dispatch was not constructed");
  const broker = createSelfhostContainerBindingBroker({ dispatch });
  const client = makeContainerBinding({ fetch: broker });
  return { ...native, boundary, handle, binding, brokers: serviceBindingBrokers, client, dispatch };
}

async function waitSent(io: ReturnType<typeof ownedRawHttp>) {
  for (let i = 0; i < 60 && !io.counts().calls; i++) await rawTick();
}

test("OCI Binding actual caller body and same accepted creator keep native lease until both actual HTTP closes", async () => {
  const x = await bindingOriginal(),
    io = ownedRawHttp();
  try {
    expect(await x.source.read(x.claim)).toMatchObject({
      targetUid: x.accepted.resourceUid,
      workerVersionFormUrl: x.claim.workerVersionFormUrl,
    });
    const n = await rawNativeOwner(x);
    const pending = observeRawPromise(
      n.client.fetch(new Request("https://untrusted.invalid/caller?ok=1")),
    );
    await waitSent(io);
    expect(io.counts().calls).toBe(1);
    expect(String(io.targets[0])).toBe("http://10.240.0.3:8080/caller?ok=1");
    expect(n.boundary.nativeReads).toBe(1);
    expect(n.handle.serviceBindingLeases.size).toBe(1);
    io.head();
    const received = await pending.value;
    if (!("result" in received)) throw received.error;
    io.incoming.end("NONSECRET actual target");
    expect(await received.result.text()).toBe("NONSECRET actual target");
    await rawTick();
    expect(n.handle.serviceBindingLeases.size).toBe(1);
    io.closeResponse();
    await rawTick();
    expect(n.handle.serviceBindingLeases.size).toBe(1);
    io.closeRequest();
    for (let i = 0; i < 30 && n.handle.serviceBindingLeases.size; i++) await rawTick();
    expect(n.handle.serviceBindingLeases.size).toBe(0);
    expect(n.handle.containerCalls.size).toBe(0);
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});

test("OCI Binding actual caller origin, native liveness and final target-await fence refuse before send", async () => {
  const x = await bindingOriginal(),
    io = ownedRawHttp();
  try {
    const n = await rawNativeOwner(x);
    const foreign = observeRawPromise(
      n.binder.issueBinding({ ...x.claim, operationId: crypto.randomUUID() }, n.binding),
    );
    expect(await foreign.value).toHaveProperty("error");
    n.boundary.live = false;
    expect(
      await observeRawPromise(n.dispatch(new Request("http://caller.invalid/native-gone"))).value,
    ).toHaveProperty("error");
    expect(n.handle.serviceBindingLeases.size).toBe(0);
    n.boundary.live = true;
    const before = x.f
      .nativeCounts()
      .requests.filter((v) => v === "linux-oci-observe-started@1").length;
    let finalAwait = false;
    const query = x.f.sql.query.bind(x.f.sql);
    const intercept = spyOn(x.f.sql, "query").mockImplementation(async (sql, params) => {
      const rows = await query(sql, params);
      const reads = x.f
        .nativeCounts()
        .requests.filter((v) => v === "linux-oci-observe-started@1").length;
      if (reads >= before + 3 && sql.startsWith("SELECT 1 AS owner_current WHERE")) {
        finalAwait = true;
        n.fence();
      }
      return rows;
    });
    try {
      expect(
        await observeRawPromise(n.dispatch(new Request("http://caller.invalid/last-await"))).value,
      ).toHaveProperty("error");
    } finally {
      intercept.mockRestore();
    }
    expect(finalAwait).toBe(true);
    expect(io.counts().calls).toBe(0);
    await rawTick(); // The known no-I/O settlement releases its original lease.
    expect(n.handle.serviceBindingLeases.size).toBe(0);
  } finally {
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});

test("OCI Binding malformed Request and foreign accepted graph cannot acquire or dispatch a caller", async () => {
  const x = await bindingOriginal(),
    io = ownedRawHttp();
  try {
    const n = await rawNativeOwner(x);
    const invalid = await createSelfhostContainerBindingBroker({ dispatch: n.dispatch })(
      new Request("http://wire.invalid/", { method: "POST", body: "not a frame" }),
    );
    expect(invalid.headers.get("x-takoserver-container-result")).toContain("error");
    expect(n.boundary.nativeReads).toBe(0);
    expect(await x.source.read({ ...x.claim, principal: "foreign" })).toBeNull();
    expect(await x.source.read({ ...x.claim, workerVersionGeneration: 2 })).toBeNull();
    expect(() => x.source.assertSql({ ...x.f.sql })).toThrow("foreign_sql");
    expect(
      await observeRawPromise(
        openSelfhostContainerBindingSocket({
          directory: "/no-IO",
          socketName: "../adopt.sock",
          dispatch: n.dispatch,
        }),
      ).value,
    ).toHaveProperty("error");
    expect(io.counts().calls).toBe(0);
    expect(n.handle.serviceBindingLeases.size).toBe(0);
  } finally {
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});

test("OCI Binding original I/O UNKNOWN retains the exact caller lease after late close", async () => {
  const x = await bindingOriginal(),
    io = ownedRawHttp();
  try {
    const n = await rawNativeOwner(x);
    const response = observeRawPromise(n.dispatch(new Request("http://caller.invalid/unknown")));
    await waitSent(io);
    expect(io.counts().calls).toBe(1);
    io.head();
    const head = await response.value;
    if (!("result" in head)) throw head.error;
    io.incoming.end("NONSECRET uncertain transport");
    await head.result.text();
    // Model an actual destroy attempt whose outcome is unknown. Later close
    // events cannot turn that retained original operation into a known join.
    const destroy = spyOn(io.request, "destroy").mockImplementation(() => {
      throw Error("NONSECRET close unknown");
    });
    try {
      [...n.handle.containerCalls][0]!.abort.abort();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      destroy.mockRestore();
    }
    io.closeResponse();
    io.closeRequest();
    await rawTick();
    const [call] = n.handle.containerCalls;
    expect(call).toBeDefined();
    expect(n.handle.serviceBindingLeases.size).toBe(1);
    expect(n.handle.containerCalls.size).toBe(1);
    expect(io.counts().calls).toBe(1);
    expect(await observeRawPromise(x.f.composition.close()).value).toHaveProperty("error");
    expect(n.handle.serviceBindingLeases.size).toBe(1);
    expect(x.network).not.toHaveBeenCalled();
  } finally {
    io.closeRequest();
    io.closeResponse();
    io.restore();
    await x.cleanup();
  }
});
