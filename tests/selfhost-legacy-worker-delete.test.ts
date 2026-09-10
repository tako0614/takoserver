import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import { createSelfhostScriptStateStore } from "../src/providers/selfhost-script-state.ts";
import { createWorkerdRuntime, type WorkerdRuntime } from "../src/workerd-runtime.ts";

const EDGE_API = "edge.forms.takoform.com/v1beta1";
const WORKER_SOURCE = "export default { fetch() {} };";
const WORKER_BUNDLE_DIGEST = "sha256:worker";
const WORKER_MODULE_DIGEST = "sha256:index.js";

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

function identity(name: string) {
  return { tenantRef: "org_demo", space: "default", name };
}

function relation(pointer: string, kind: string, name: string): ProviderRelation {
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
      spec: {},
    },
  };
}

interface LegacyWorkerFixture {
  readonly local: ReturnType<typeof createSelfhostProvider>;
  readonly runtimeWrites: () => number;
  readonly runtimePublishes: () => number;
  readonly script: string;
  readonly versionId: string;
  readonly workerNativeId: string;
}

/**
 * Build the retained pre-weighted state that the current provider still
 * supports: a materialized Version named by one scalar `activeVersion`.
 * Endpoint apply is the provider path that republishes that state through the
 * legacy runtime.write branch before the parent Worker is deleted.
 */
async function legacyWorkerFixture(): Promise<LegacyWorkerFixture> {
  const baseRuntime = createWorkerdRuntime({ root, isReady: () => true });
  let writes = 0;
  let publishes = 0;
  const runtime: WorkerdRuntime = {
    ...baseRuntime,
    inspectModule: async (input) => ({
      outcome: "valid",
      exportedHandlers: [...input.declaredHandlers],
    }),
    async write(...args) {
      writes += 1;
      await baseRuntime.write(...args);
    },
    async publish(name, publication) {
      publishes += 1;
      if (!baseRuntime.publish) throw new Error("workerd runtime publish is unavailable");
      await baseRuntime.publish(name, publication);
    },
  };
  const local = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    artifacts: {
      async manifest(_tenantRef, digest) {
        if (digest !== WORKER_BUNDLE_DIGEST) return null;
        return {
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: [{ name: "index.js", digest: WORKER_MODULE_DIGEST }],
        };
      },
      async blob(digest) {
        return digest === WORKER_MODULE_DIGEST ? new TextEncoder().encode(WORKER_SOURCE) : null;
      },
    },
  });

  const workerOffering = offering("ModuleWorker");
  const worker = await local.apply({
    operationId: "op_legacy_worker",
    offering: workerOffering,
    identity: identity("hello"),
    spec: {},
  });
  if (worker.phase !== "succeeded") throw new Error("legacy Worker allocation failed");
  const script = String(worker.result.outputs.scriptName);
  const workerNativeId = worker.result.nativeId;

  const version = await local.apply({
    operationId: "op_legacy_version",
    offering: offering("WorkerVersion"),
    identity: identity("hello-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      {
        ...relation("/bundle", "WorkerBundle", "bundle"),
        resource: {
          ...relation("/bundle", "WorkerBundle", "bundle").resource,
          spec: { manifestDigest: WORKER_BUNDLE_DIGEST },
        },
      },
    ],
  });
  if (version.phase !== "succeeded")
    throw new Error("legacy Worker Version materialization failed");
  const versionId = String(version.result.outputs.versionId);

  const stateStore = createSelfhostScriptStateStore({
    root: join(root, "selfhost", "scripts"),
  });
  await stateStore.write(script, null, { activeVersion: versionId, domains: [] });

  const endpoint = await local.apply({
    operationId: "op_legacy_endpoint",
    offering: offering("WorkerEndpoint"),
    identity: identity("hello-endpoint"),
    spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
    relations: [relation("/worker", "ModuleWorker", "hello")],
    workerEndpointOriginAssignment: {
      canonicalPublicOrigin: `https://${script}.localhost`,
      assignmentDigest: `sha256:${"e".repeat(64)}`,
    },
  });
  if (endpoint.phase !== "succeeded") throw new Error("legacy Worker Endpoint publication failed");
  if (writes !== 1) throw new Error(`expected one legacy runtime.write, got ${writes}`);

  return {
    local,
    runtimeWrites: () => writes,
    runtimePublishes: () => publishes,
    script,
    versionId,
    workerNativeId,
  };
}

function readbackTarget() {
  return {
    tenantId: "org_demo",
    resourceUid: "uid-ModuleWorker-hello",
    incarnationId: "dep-legacy-worker",
    generation: "1",
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-legacy-worker-delete-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

let root: string;

describe("legacy scalar Worker deletion", () => {
  test("deletes a supported activeVersion carrier and proves native absence", async () => {
    const fixture = await legacyWorkerFixture();
    const moduleOffering = offering("ModuleWorker");
    const { local, workerNativeId, script } = fixture;
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("self-host provider must expose native absence readback");
    }
    const descriptor = local.createNativeReadbackDescriptor({
      offering: moduleOffering,
      nativeId: workerNativeId,
      identity: identity("hello"),
    });
    expect(
      await local.verifyNativeAbsence({
        offering: moduleOffering,
        descriptor,
        target: readbackTarget(),
      }),
    ).toEqual({
      outcome: "present",
      evidence: { provider: "local", kind: "ModuleWorker", state: "present" },
    });

    expect(
      await local.delete({
        operationId: "op_legacy_worker_delete",
        operationMode: "initial",
        offering: moduleOffering,
        nativeId: workerNativeId,
        identity: identity("hello"),
      }),
    ).toMatchObject({
      phase: "succeeded",
      result: { observed: { deleted: true } },
    });
    expect(fixture.runtimeWrites()).toBe(1);
    expect(fixture.runtimePublishes()).toBe(1);

    expect(
      await local.verifyNativeAbsence({
        offering: moduleOffering,
        descriptor,
        target: readbackTarget(),
      }),
    ).toEqual({
      outcome: "absent",
      evidence: { provider: "local", kind: "ModuleWorker", state: "absent" },
    });
    expect(existsSync(join(root, "workers", script))).toBe(false);
  });

  test("also proves absence after deleting a retained scalar deployment first", async () => {
    const fixture = await legacyWorkerFixture();
    const moduleOffering = offering("ModuleWorker");
    const deploymentOffering = offering("WorkerDeployment");
    const { local, workerNativeId, script } = fixture;
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("self-host provider must expose native absence readback");
    }
    const descriptor = local.createNativeReadbackDescriptor({
      offering: moduleOffering,
      nativeId: workerNativeId,
      identity: identity("hello"),
    });

    expect(
      await local.delete({
        operationId: "op_legacy_deployment_delete",
        operationMode: "initial",
        offering: deploymentOffering,
        nativeId: `selfhost-deployment:${script}:op_legacy_deployment`,
        identity: identity("hello-live"),
        relations: [relation("/worker", "ModuleWorker", "hello")],
      }),
    ).toMatchObject({
      phase: "succeeded",
      result: { observed: { deleted: true } },
    });
    expect(
      await local.delete({
        operationId: "op_legacy_worker_delete_after_deployment",
        operationMode: "initial",
        offering: moduleOffering,
        nativeId: workerNativeId,
        identity: identity("hello"),
      }),
    ).toMatchObject({
      phase: "succeeded",
      result: { observed: { deleted: true } },
    });
    expect(fixture.runtimePublishes()).toBe(2);

    expect(
      await local.verifyNativeAbsence({
        offering: moduleOffering,
        descriptor,
        target: readbackTarget(),
      }),
    ).toEqual({
      outcome: "absent",
      evidence: { provider: "local", kind: "ModuleWorker", state: "absent" },
    });
  });
});
