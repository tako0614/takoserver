import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const EDGE_API = "edge.forms.takoform.com/v1beta1";
const MODULE_SOURCE = "export default { fetch() {}, scheduled() {} };";
const identity = (name: string) => ({ tenantRef: "org_demo", space: "default", name });

function offering(kind: string): ProviderOffering {
  return {
    id: `selfhost.edge.${kind.toLowerCase()}`,
    kind: `takoform.${kind}`,
    displayName: kind,
    form: {
      apiVersion: EDGE_API,
      kind,
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "delete", "import", "observe"],
  };
}

function relation(
  pointer: string,
  kind: string,
  name: string,
  spec: Record<string, unknown> = {},
): ProviderRelation {
  return {
    pointer,
    relation: pointer.replace(/\/[0-9]+\//gu, "/*/"),
    targetUid: `uid-${kind}-${name}`,
    resource: {
      apiVersion: EDGE_API,
      kind,
      form: {
        formRef: {
          apiVersion: EDGE_API,
          kind,
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      metadata: {
        name,
        space: "default",
        uid: `uid-${kind}-${name}`,
        generation: "1",
        revision: "1",
      },
      spec: spec as never,
    },
  };
}

function runtimeWithInspectionBarrier(): {
  readonly runtime: WorkerdRuntime;
  readonly arm: () => void;
  readonly firstInspection: () => Promise<void>;
  readonly release: () => void;
  readonly failNextInspection: () => void;
  readonly inspections: () => number;
} {
  let armed = false;
  let waiting = 0;
  let count = 0;
  let failNext = false;
  let release!: () => void;
  let barrier = Promise.resolve();
  let firstInspection = Promise.resolve();
  let signalFirstInspection!: () => void;
  return {
    runtime: {
      async inspectModule(input) {
        count += 1;
        if (failNext) {
          failNext = false;
          return { outcome: "invalid", error: "handler_not_exported" };
        }
        if (armed) {
          waiting += 1;
          if (waiting === 1) {
            signalFirstInspection();
            barrier = new Promise<void>((resolve) => {
              release = resolve;
              // A corrected provider may serialize the whole apply, in which
              // case the sibling cannot reach this hook until this caller
              // finishes. Keep the repro bounded and let that serial path
              // proceed; the old implementation reaches the second hook well
              // before this fallback and remains deterministically red.
              setTimeout(() => {
                armed = false;
                resolve();
              }, 250);
            });
          }
          if (waiting === 2) {
            // Both callers have already read the same script revision before
            // either can reach scriptStates.write. Let both preflights finish,
            // then the stale expected revision makes the CAS loser visible.
            armed = false;
            release();
          }
          await barrier;
        }
        return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
      },
      async write() {},
      async remove() {},
      async reload() {},
      async has() {
        return true;
      },
    },
    arm() {
      armed = true;
      waiting = 0;
      firstInspection = new Promise<void>((resolve) => {
        signalFirstInspection = resolve;
      });
    },
    firstInspection() {
      return firstInspection;
    },
    release() {
      armed = false;
      release?.();
    },
    failNextInspection() {
      failNext = true;
    },
    inspections() {
      return count;
    },
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-concurrent-cron-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function createProvider(runtime: WorkerdRuntime) {
  return createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    artifacts: {
      async manifest(_tenantRef, digest) {
        if (digest !== "sha256:worker") return null;
        return {
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: [{ name: "index.js", digest: "sha256:index.js" }],
        };
      },
      async blob(digest) {
        return digest === "sha256:index.js" ? new TextEncoder().encode(MODULE_SOURCE) : null;
      },
    },
  });
}

async function publishBaseline(local: ReturnType<typeof createProvider>): Promise<string> {
  const worker = await local.apply({
    operationId: "op_worker",
    offering: offering("ModuleWorker"),
    identity: identity("hello"),
    spec: {},
  });
  expect(worker.phase).toBe("succeeded");
  if (worker.phase !== "succeeded") throw new Error("Worker apply failed");
  const script = worker.result.outputs.scriptName as string;

  const version = await local.apply({
    operationId: "op_version",
    offering: offering("WorkerVersion"),
    identity: identity("hello-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch", "scheduled"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
    ],
  });
  expect(version.phase).toBe("succeeded");

  const deployment = await local.apply({
    operationId: "op_deployment",
    offering: offering("WorkerDeployment"),
    identity: identity("hello-live"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      versions: [
        {
          workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v1" },
          weight: 10_000,
        },
      ],
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/versions/0/workerVersion", "WorkerVersion", "hello-v1"),
    ],
  });
  expect(deployment.phase).toBe("succeeded");
  return script;
}

function applyModuleWorker(
  local: ReturnType<typeof createProvider>,
  name: string,
  operationId: string,
) {
  return local.apply({
    operationId,
    offering: offering("ModuleWorker"),
    identity: identity(name),
    spec: {},
  });
}

function applyCron(
  local: ReturnType<typeof createProvider>,
  operationId = "op_cron",
  cron = "0 * * * *",
) {
  return local.apply({
    operationId,
    offering: offering("WorkerCronTrigger"),
    identity: identity("hello-cron"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      cron,
    },
    relations: [relation("/worker", "ModuleWorker", "hello")],
  });
}

function deleteCron(local: ReturnType<typeof createProvider>, operationId: string, cron: string) {
  return local.delete({
    operationId,
    offering: offering("WorkerCronTrigger"),
    identity: identity("hello-cron"),
    nativeId: "selfhost-cron:retained",
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      cron,
    },
    relations: [relation("/worker", "ModuleWorker", "hello")],
  });
}

function applyEndpoint(
  local: ReturnType<typeof createProvider>,
  script: string,
  operationId = "op_endpoint",
) {
  return local.apply({
    operationId,
    offering: offering("WorkerEndpoint"),
    identity: identity("hello-endpoint"),
    spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
    relations: [relation("/worker", "ModuleWorker", "hello")],
    workerEndpointOriginAssignment: {
      canonicalPublicOrigin: `https://${script}.localhost`,
      assignmentDigest: `sha256:${"e".repeat(64)}`,
    },
  });
}

describe("self-host Worker script CAS", () => {
  test("serializes a Cron attachment with a sibling Worker endpoint mutation", async () => {
    const barrier = runtimeWithInspectionBarrier();
    const local = createProvider(barrier.runtime);
    const script = await publishBaseline(local);
    expect(barrier.inspections()).toBe(3);

    barrier.arm();
    const [cron, endpoint] = await Promise.all([applyCron(local), applyEndpoint(local, script)]);

    // Before command serialization this returned a retryable conflict: both mutations read the
    // same revision and one scriptStates.write loses the CAS. The desired
    // provider seam is per-script serialization, so both attachments must
    // commit and republish without exposing that implementation race.
    expect(cron).toMatchObject({ phase: "succeeded" });
    expect(endpoint).toMatchObject({ phase: "succeeded" });

    const state = JSON.parse(
      readFileSync(join(root, "selfhost", "scripts", `${script}.json`), "utf8"),
    ) as { endpointHostname?: string; crons?: readonly string[] };
    expect(state.endpointHostname).toBe(`${script}.localhost`);
    expect(state.crons).toEqual(["0 * * * *"]);
  });

  test("serializes same-script mutations across provider instances sharing a root", async () => {
    const barrier = runtimeWithInspectionBarrier();
    const cronProvider = createProvider(barrier.runtime);
    const endpointProvider = createProvider(barrier.runtime);
    const script = await publishBaseline(cronProvider);

    barrier.arm();
    const [cron, endpoint] = await Promise.all([
      applyCron(cronProvider, "op_cron_other_provider"),
      applyEndpoint(endpointProvider, script, "op_endpoint_other_provider"),
    ]);

    expect(cron).toMatchObject({ phase: "succeeded" });
    expect(endpoint).toMatchObject({ phase: "succeeded" });
    const state = JSON.parse(
      readFileSync(join(root, "selfhost", "scripts", `${script}.json`), "utf8"),
    ) as { endpointHostname?: string; crons?: readonly string[] };
    expect(state.endpointHostname).toBe(`${script}.localhost`);
    expect(state.crons).toEqual(["0 * * * *"]);
  });

  test("does not hold a distinct Worker behind a blocked mutation", async () => {
    const barrier = runtimeWithInspectionBarrier();
    const local = createProvider(barrier.runtime);
    await publishBaseline(local);

    let cronSettled = false;
    barrier.arm();
    const cron = applyCron(local).then((ticket) => {
      cronSettled = true;
      return ticket;
    });
    await barrier.firstInspection();

    // The hello script is held in inspectModule. An unrelated Worker must be
    // able to acquire its own script key and finish before hello is released.
    const unrelated = await applyModuleWorker(local, "other", "op_other_worker");
    expect(unrelated).toMatchObject({ phase: "succeeded" });
    expect(cronSettled).toBe(false);

    barrier.release();
    expect(await cron).toMatchObject({ phase: "succeeded" });
  });

  test("releases a same-script queue after a definite preflight failure", async () => {
    const barrier = runtimeWithInspectionBarrier();
    const local = createProvider(barrier.runtime);
    const script = await publishBaseline(local);

    barrier.failNextInspection();
    expect(await applyCron(local, "op_cron_rejected")).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });

    // If the failed caller retained the per-script queue, this operation would
    // never reach its read/preflight path. The deadline keeps that assertion
    // bounded if a future implementation forgets its finally release.
    const endpoint = await Promise.race([
      applyEndpoint(local, script, "op_endpoint_after_failure"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("same-script mutation queue did not release")), 500),
      ),
    ]);
    expect(endpoint).toMatchObject({ phase: "succeeded" });
  });

  test("preserves independent fields across a concurrent apply and delete", async () => {
    const barrier = runtimeWithInspectionBarrier();
    const local = createProvider(barrier.runtime);
    const script = await publishBaseline(local);
    expect(await applyCron(local, "op_cron_keep", "0 1 * * *")).toMatchObject({
      phase: "succeeded",
    });
    expect(await applyCron(local, "op_cron_remove", "0 * * * *")).toMatchObject({
      phase: "succeeded",
    });

    barrier.arm();
    const [endpoint, removed] = await Promise.all([
      applyEndpoint(local, script, "op_endpoint_with_delete"),
      deleteCron(local, "op_delete_cron", "0 * * * *"),
    ]);
    expect(endpoint).toMatchObject({ phase: "succeeded" });
    expect(removed).toMatchObject({ phase: "succeeded" });

    const state = JSON.parse(
      readFileSync(join(root, "selfhost", "scripts", `${script}.json`), "utf8"),
    ) as { endpointHostname?: string; crons?: readonly string[] };
    expect(state.endpointHostname).toBe(`${script}.localhost`);
    expect(state.crons).toEqual(["0 1 * * *"]);
  });
});
