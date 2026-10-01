import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
const configProbes = new Set<ReturnType<typeof Bun.serve>>();

function configProbe() {
  let serving: { identity: string; token: string } | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (
        serving === null ||
        request.method !== "POST" ||
        request.headers.get("host") !== "runtime.selfhost-config.invalid" ||
        url.pathname !== "/.well-known/takoserver/selfhost-runtime-config/v1" ||
        request.headers.get("x-takoserver-selfhost-runtime-config") !== serving.token
      ) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 204,
        headers: { "x-takoserver-selfhost-config-identity": serving.identity },
      });
    },
  });
  configProbes.add(server);
  if (server.port === undefined) throw new Error("config probe did not bind");
  return {
    port: server.port,
    async onReload(path: string) {
      const config = await readFile(path, "utf8");
      const identity = /\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      const token = /\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      if (!identity || !token) throw new Error("invalid config probe declaration");
      serving = { identity, token };
    },
  };
}

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
  readonly failNextPublication: () => void;
  readonly script: string;
  readonly versionId: string;
  readonly workerNativeId: string;
  readonly versionNativeId: string;
  readonly endpointNativeId: string;
}

/**
 * Build the retained pre-weighted state that the current provider still
 * supports: a materialized Version named by one scalar `activeVersion`.
 * Endpoint apply is the provider path that republishes that state through the
 * legacy runtime.write branch before the parent Worker is deleted.
 */
async function legacyWorkerFixture(
  options: {
    readonly legacyRuntime?: boolean;
    readonly probe?: ReturnType<typeof configProbe>;
  } = {},
): Promise<LegacyWorkerFixture> {
  // This fixture publishes to disk but does not boot workerd. Avoid mistaking
  // an unrelated process on the shared default port for its runtime.
  const baseRuntime = createWorkerdRuntime({
    root,
    isReady: () => true,
    port: options.probe?.port ?? 0,
    ...(options.probe ? { onReload: options.probe.onReload } : {}),
  });
  let writes = 0;
  let publishes = 0;
  let failNextPublication = false;
  const runtime: WorkerdRuntime = {
    ...(options.legacyRuntime
      ? (({ publish: _publish, ...withoutPublish }) => withoutPublish)(baseRuntime)
      : baseRuntime),
    inspectModule: async (input) => ({
      outcome: "valid",
      exportedHandlers: [...input.declaredHandlers],
    }),
    async probe() {
      // This fake fixture has no serving workerd process to probe. Tests that
      // exercise runtime probing install an isolated probe server.
      return null;
    },
    async write(...args) {
      writes += 1;
      await baseRuntime.write(...args);
    },
    ...(!options.legacyRuntime
      ? {
          async publish(
            name: string,
            publication: Parameters<NonNullable<WorkerdRuntime["publish"]>>[1],
          ) {
            publishes += 1;
            if (failNextPublication) {
              failNextPublication = false;
              throw new Error("simulated interrupted runtime publication");
            }
            if (!baseRuntime.publish) throw new Error("workerd runtime publish is unavailable");
            await baseRuntime.publish(name, publication);
          },
        }
      : {
          async reload() {
            if (failNextPublication) {
              failNextPublication = false;
              throw new Error("simulated interrupted runtime reload");
            }
            await baseRuntime.reload();
          },
        }),
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
    failNextPublication: () => {
      failNextPublication = true;
    },
    script,
    versionId,
    workerNativeId,
    versionNativeId: version.result.nativeId,
    endpointNativeId: endpoint.result.nativeId,
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
  for (const server of configProbes) server.stop(true);
  configProbes.clear();
  rmSync(root, { recursive: true, force: true });
});

let root: string;

describe("legacy scalar Worker deletion", () => {
  test("does not recover Version deletion while the removed legacy generation still serves", async () => {
    const probe = configProbe();
    const fixture = await legacyWorkerFixture({ legacyRuntime: true, probe });
    fixture.failNextPublication();
    const deletion = {
      operationId: "op_legacy_version_delete",
      offering: offering("WorkerVersion"),
      nativeId: fixture.versionNativeId,
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    } as const;

    expect(
      await fixture.local.delete({
        operationMode: "initial",
        ...deletion,
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });

    if (!fixture.local.createNativeReadbackDescriptor || !fixture.local.verifyNativeAbsence) {
      throw new Error("missing self-host native absence readback");
    }
    const descriptor = fixture.local.createNativeReadbackDescriptor(deletion);
    expect(
      await fixture.local.verifyNativeAbsence({
        offering: deletion.offering,
        descriptor,
        target: {
          tenantId: "org_demo",
          resourceUid: "uid-WorkerVersion-hello-v1",
          incarnationId: "dep-legacy-version",
          generation: "1",
        },
      }),
    ).toEqual({ outcome: "unknown", reason: "transport", retryable: true });

    if (!fixture.local.recoverDelete) throw new Error("missing self-host delete recovery");
    const recovered = await fixture.local.recoverDelete({
      operationMode: "recovery",
      ...deletion,
    });

    expect(recovered).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });

    const restartedRuntime = createWorkerdRuntime({
      root,
      isReady: () => true,
      port: probe.port,
      onReload: probe.onReload,
    });
    let emptyPublications = 0;
    const convergenceRuntime: WorkerdRuntime = {
      ...restartedRuntime,
      async publish(name, publication) {
        if (publication === null) emptyPublications += 1;
        await restartedRuntime.publish?.(name, publication);
      },
    };
    const restartedProvider = createSelfhostProvider({
      offerings: [],
      dataRoot: root,
      runtime: convergenceRuntime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
    });
    if (!restartedProvider.convergeDelete) throw new Error("missing self-host delete convergence");
    const converged = await restartedProvider.convergeDelete({
      ...deletion,
      operationMode: "recovery",
      executionAuthority: {
        tenantId: "org_demo",
        resourceUid: "uid-WorkerVersion-hello-v1",
        leaseToken: "repair-lease-token",
        fingerprint: "delete-fingerprint",
      },
    });

    expect(converged).toMatchObject({
      phase: "succeeded",
      result: { observed: { deleted: true } },
    });
    expect(emptyPublications).toBe(1);
    expect(await convergenceRuntime.observePublication?.(fixture.script)).toBe("absent");
    if (!restartedProvider.verifyNativeAbsence) {
      throw new Error("missing self-host native absence readback");
    }
    expect(
      await restartedProvider.verifyNativeAbsence({
        offering: deletion.offering,
        descriptor,
        target: {
          tenantId: "org_demo",
          resourceUid: "uid-WorkerVersion-hello-v1",
          incarnationId: "dep-legacy-version",
          generation: "1",
        },
      }),
    ).toMatchObject({ outcome: "absent" });
  });

  test("does not claim a removed endpoint absent while the prior route still serves", async () => {
    const probe = configProbe();
    const fixture = await legacyWorkerFixture({ legacyRuntime: true, probe });
    fixture.failNextPublication();
    const endpointOffering = offering("WorkerEndpoint");
    const endpointRelations = [relation("/worker", "ModuleWorker", "hello")];
    if (!fixture.local.createNativeReadbackDescriptor || !fixture.local.verifyNativeAbsence) {
      throw new Error("missing self-host native absence readback");
    }
    const descriptor = fixture.local.createNativeReadbackDescriptor({
      offering: endpointOffering,
      nativeId: fixture.endpointNativeId,
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: endpointRelations,
    });
    expect(
      await fixture.local.delete({
        operationId: "op_legacy_endpoint_delete",
        operationMode: "initial",
        offering: endpointOffering,
        nativeId: fixture.endpointNativeId,
        identity: identity("hello-endpoint"),
        relations: endpointRelations,
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });
    expect(
      await fixture.local.verifyNativeAbsence({
        offering: endpointOffering,
        descriptor,
        target: {
          tenantId: "org_demo",
          resourceUid: "uid-WorkerEndpoint-hello-endpoint",
          incarnationId: "dep-legacy-endpoint",
          generation: "1",
        },
      }),
    ).toEqual({ outcome: "unknown", reason: "transport", retryable: true });
    if (!fixture.local.recoverDelete) throw new Error("missing self-host delete recovery");
    expect(
      await fixture.local.recoverDelete({
        operationId: "op_legacy_endpoint_delete",
        operationMode: "recovery",
        offering: endpointOffering,
        nativeId: fixture.endpointNativeId,
        identity: identity("hello-endpoint"),
        relations: endpointRelations,
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });
    if (!fixture.local.convergeDelete) throw new Error("missing self-host delete convergence");
    expect(
      await fixture.local.convergeDelete({
        operationId: "op_legacy_endpoint_delete",
        operationMode: "recovery",
        offering: endpointOffering,
        nativeId: fixture.endpointNativeId,
        identity: identity("hello-endpoint"),
        relations: endpointRelations,
        executionAuthority: {
          tenantId: "org_demo",
          resourceUid: "uid-WorkerEndpoint-hello-endpoint",
          leaseToken: "repair-lease-token",
          fingerprint: "delete-fingerprint",
        },
      }),
    ).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
  });

  test("does not recover Deployment deletion while the prior graph still serves, then converges", async () => {
    const probe = configProbe();
    const fixture = await legacyWorkerFixture({ legacyRuntime: true, probe });
    const deletion = {
      operationId: "op_legacy_deployment_failed_delete",
      offering: offering("WorkerDeployment"),
      nativeId: `selfhost-deployment:${fixture.script}:op_legacy_deployment`,
      identity: identity("hello-live"),
      relations: [relation("/worker", "ModuleWorker", "hello")],
    } as const;
    fixture.failNextPublication();
    expect(await fixture.local.delete({ ...deletion, operationMode: "initial" })).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    if (!fixture.local.recoverDelete || !fixture.local.convergeDelete) {
      throw new Error("missing self-host delete recovery");
    }
    expect(
      await fixture.local.recoverDelete({ ...deletion, operationMode: "recovery" }),
    ).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    expect(
      await fixture.local.convergeDelete({
        ...deletion,
        operationMode: "recovery",
        executionAuthority: {
          tenantId: "org_demo",
          resourceUid: "uid-WorkerDeployment-hello-live",
          leaseToken: "repair-lease-token",
          fingerprint: "delete-fingerprint",
        },
      }),
    ).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
  });

  test("does not recover CustomDomain deletion while its prior route still serves, then converges", async () => {
    const probe = configProbe();
    const fixture = await legacyWorkerFixture({ legacyRuntime: true, probe });
    const relations = [relation("/worker", "ModuleWorker", "hello")];
    const spec = {
      hostname: "legacy.localhost",
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
    };
    const applied = await fixture.local.apply({
      operationId: "op_legacy_domain",
      offering: offering("WorkerCustomDomain"),
      identity: identity("hello-domain"),
      spec,
      relations,
    });
    if (applied.phase !== "succeeded") throw new Error("custom domain setup failed");
    const deletion = {
      operationId: "op_legacy_domain_failed_delete",
      offering: offering("WorkerCustomDomain"),
      nativeId: applied.result.nativeId,
      identity: identity("hello-domain"),
      spec,
      relations,
    } as const;
    fixture.failNextPublication();
    expect(await fixture.local.delete({ ...deletion, operationMode: "initial" })).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    if (!fixture.local.recoverDelete || !fixture.local.convergeDelete) {
      throw new Error("missing self-host delete recovery");
    }
    expect(
      await fixture.local.recoverDelete({ ...deletion, operationMode: "recovery" }),
    ).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    expect(
      await fixture.local.convergeDelete({
        ...deletion,
        operationMode: "recovery",
        executionAuthority: {
          tenantId: "org_demo",
          resourceUid: "uid-WorkerCustomDomain-hello-domain",
          leaseToken: "repair-lease-token",
          fingerprint: "delete-fingerprint",
        },
      }),
    ).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
  });

  for (const kind of ["WorkerDeployment", "WorkerCustomDomain"] as const) {
    test(`does not republish over a replacement during ${kind} delete observation`, async () => {
      const probe = configProbe();
      const fixture = await legacyWorkerFixture({ legacyRuntime: true, probe });
      const relations = [relation("/worker", "ModuleWorker", "hello")];
      const spec = { hostname: "legacy.localhost" };
      const domain =
        kind === "WorkerCustomDomain"
          ? await fixture.local.apply({
              operationId: "op_domain_for_race",
              offering: offering(kind),
              identity: identity("hello-domain"),
              spec,
              relations,
            })
          : null;
      if (domain && domain.phase !== "succeeded") throw new Error("custom domain setup failed");
      const deletion = {
        operationId: `op_${kind}_race_delete`,
        offering: offering(kind),
        nativeId:
          domain?.phase === "succeeded"
            ? domain.result.nativeId
            : `selfhost-deployment:${fixture.script}:op_legacy_deployment`,
        identity: identity(kind === "WorkerCustomDomain" ? "hello-domain" : "hello-live"),
        spec,
        relations,
      };
      fixture.failNextPublication();
      expect(await fixture.local.delete({ ...deletion, operationMode: "initial" })).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable" },
      });

      let entered!: () => void;
      let release!: () => void;
      const observed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runtime = createWorkerdRuntime({
        root,
        isReady: () => true,
        port: probe.port,
        onReload: probe.onReload,
      });
      let publications = 0;
      const racingRuntime: WorkerdRuntime = {
        ...runtime,
        async observePublication(name, subject) {
          entered();
          await paused;
          return (await runtime.observePublication?.(name, subject)) ?? "unknown";
        },
        async publish(name, publication) {
          publications += 1;
          await runtime.publish?.(name, publication);
        },
        async write(...args) {
          publications += 1;
          await runtime.write(...args);
        },
      };
      const provider = createSelfhostProvider({
        offerings: [],
        dataRoot: root,
        runtime: racingRuntime,
        artifacts: {
          async manifest() {
            return null;
          },
          async blob() {
            return null;
          },
        },
      });
      if (!provider.convergeDelete) throw new Error("missing self-host delete convergence");
      const convergence = provider.convergeDelete({
        ...deletion,
        operationMode: "recovery",
        executionAuthority: {
          tenantId: "org_demo",
          resourceUid: `uid-${kind}-replacement`,
          leaseToken: "repair-lease-token",
          fingerprint: "delete-fingerprint",
        },
      });
      await observed;
      const store = createSelfhostScriptStateStore({ root: join(root, "selfhost", "scripts") });
      const current = await store.read(fixture.script);
      await store.write(fixture.script, current.revision, {
        ...current.state,
        ...(kind === "WorkerDeployment"
          ? { activeVersion: fixture.versionId }
          : { domains: [...current.state.domains, spec.hostname] }),
      });
      release();
      expect(await convergence).toMatchObject({
        phase: "failed",
        failure: { code: "unavailable" },
      });
      expect(publications).toBe(0);
    });
  }

  test("does not stop a replacement generation while converging an old Version delete", async () => {
    const fixture = await legacyWorkerFixture({ legacyRuntime: true });
    fixture.failNextPublication();
    const deletion = {
      operationId: "op_legacy_version_replacement_delete",
      offering: offering("WorkerVersion"),
      nativeId: fixture.versionNativeId,
      identity: identity("hello-v1"),
      spec: {},
      relations: [relation("/worker", "ModuleWorker", "hello")],
    } as const;
    await fixture.local.delete({ ...deletion, operationMode: "initial" });
    const store = createSelfhostScriptStateStore({ root: join(root, "selfhost", "scripts") });
    const current = await store.read(fixture.script);
    await store.write(fixture.script, current.revision, {
      deployment: {
        versions: [
          {
            versionId: fixture.versionId,
            workerVersionUid: "uid-WorkerVersion-hello-v1",
            weight: 10_000,
          },
        ],
      },
      domains: [],
    });

    const restartedRuntime = createWorkerdRuntime({ root, isReady: () => true, port: 0 });
    let emptyPublications = 0;
    const convergenceRuntime: WorkerdRuntime = {
      ...restartedRuntime,
      async publish(name, publication) {
        if (publication === null) emptyPublications += 1;
        await restartedRuntime.publish?.(name, publication);
      },
    };
    const restartedProvider = createSelfhostProvider({
      offerings: [],
      dataRoot: root,
      runtime: convergenceRuntime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
    });
    if (!restartedProvider.convergeDelete) throw new Error("missing self-host delete convergence");

    expect(
      await restartedProvider.convergeDelete({
        ...deletion,
        operationMode: "recovery",
        executionAuthority: {
          tenantId: "org_demo",
          resourceUid: "uid-WorkerVersion-hello-v1",
          leaseToken: "repair-lease-token",
          fingerprint: "delete-fingerprint",
        },
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });
    expect(emptyPublications).toBe(0);
  });

  test("does not empty-publish when a replacement arrives during runtime observation", async () => {
    const fixture = await legacyWorkerFixture({ legacyRuntime: true });
    fixture.failNextPublication();
    const deletion = {
      operationId: "op_legacy_version_race_delete",
      offering: offering("WorkerVersion"),
      nativeId: fixture.versionNativeId,
      identity: identity("hello-v1"),
      spec: {},
      relations: [relation("/worker", "ModuleWorker", "hello")],
    } as const;
    expect(await fixture.local.delete({ ...deletion, operationMode: "initial" })).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });

    let entered!: () => void;
    let release!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createWorkerdRuntime({ root, isReady: () => true, port: 0 });
    let emptyPublications = 0;
    const racingRuntime: WorkerdRuntime = {
      ...runtime,
      async observePublication(name) {
        entered();
        await paused;
        return (await runtime.observePublication?.(name)) ?? "unknown";
      },
      async publish(name, publication) {
        if (publication === null) emptyPublications += 1;
        await runtime.publish?.(name, publication);
      },
    };
    const provider = createSelfhostProvider({
      offerings: [],
      dataRoot: root,
      runtime: racingRuntime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
    });
    if (!provider.convergeDelete) throw new Error("missing self-host delete convergence");
    const convergence = provider.convergeDelete({
      ...deletion,
      operationMode: "recovery",
      executionAuthority: {
        tenantId: "org_demo",
        resourceUid: "uid-WorkerVersion-hello-v1",
        leaseToken: "repair-lease-token",
        fingerprint: "delete-fingerprint",
      },
    });
    await observed;
    const store = createSelfhostScriptStateStore({ root: join(root, "selfhost", "scripts") });
    const current = await store.read(fixture.script);
    await store.write(fixture.script, current.revision, {
      deployment: {
        versions: [
          { versionId: "new-version", workerVersionUid: "uid-version-new", weight: 10_000 },
        ],
      },
      domains: [],
    });
    release();
    expect(await convergence).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable" },
    });
    expect(emptyPublications).toBe(0);
  });

  test("does not recover a non-active Version while its prior scalar graph still serves", async () => {
    const probe = configProbe();
    const fixture = await legacyWorkerFixture({ probe });
    const stateStore = createSelfhostScriptStateStore({
      root: join(root, "selfhost", "scripts"),
    });
    const current = await stateStore.read(fixture.script);
    await stateStore.write(fixture.script, current.revision, {
      deployment: {
        versions: [
          { versionId: "other-version", workerVersionUid: "uid-version-other", weight: 10_000 },
        ],
      },
      domains: [],
    });
    rmSync(join(root, "selfhost", "versions", fixture.script, fixture.versionId), {
      recursive: true,
      force: true,
    });

    if (!fixture.local.recoverDelete) throw new Error("missing self-host delete recovery");
    expect(
      await fixture.local.recoverDelete({
        operationId: "op_non_active_version_delete",
        operationMode: "recovery",
        offering: offering("WorkerVersion"),
        nativeId: fixture.versionNativeId,
        identity: identity("hello-v1"),
        spec: {},
        relations: [relation("/worker", "ModuleWorker", "hello")],
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "unavailable" } });
  });

  test("proves a removed Version absent while an exact different weighted graph serves", async () => {
    const probe = configProbe();
    const fixture = await legacyWorkerFixture({ probe });
    const store = createSelfhostScriptStateStore({ root: join(root, "selfhost", "scripts") });
    const current = await store.read(fixture.script);
    await store.write(fixture.script, current.revision, {
      deployment: {
        versions: [
          { versionId: "new-version", workerVersionUid: "uid-WorkerVersion-new", weight: 10_000 },
        ],
      },
      domains: [],
    });
    rmSync(join(root, "selfhost", "versions", fixture.script, fixture.versionId), {
      recursive: true,
      force: true,
    });

    const runtime = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    if (!runtime.publish) throw new Error("weighted runtime publication is unavailable");
    const workerResourceUid = "uid-ModuleWorker-hello";
    await runtime.publish(fixture.script, {
      generation: "generation-other",
      workerResourceUid,
      hostnames: [`${fixture.script}.localhost`],
      versions: [
        {
          versionId: "new-version",
          workerVersionUid: "uid-WorkerVersion-new",
          weight: 10_000,
          site: {
            directory: fixture.script,
            mainModule: "index.js",
            hostEntrypoint: "__takoserver-host.js",
            hostnames: [],
            generation: "generation-other",
            workerResourceUid,
            fetchHandler: true,
          },
          modules: new Map([
            ["index.js", new TextEncoder().encode("export default { fetch() {} };")],
          ]),
          hostModules: new Map([
            [
              "__takoserver-host.js",
              new TextEncoder().encode('export { default } from "./index.js";'),
            ],
          ]),
        },
      ],
    });

    const provider = createSelfhostProvider({
      offerings: [],
      dataRoot: root,
      runtime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
    });
    if (!provider.createNativeReadbackDescriptor || !provider.verifyNativeAbsence) {
      throw new Error("missing self-host native absence readback");
    }
    const descriptor = provider.createNativeReadbackDescriptor({
      offering: offering("WorkerVersion"),
      nativeId: fixture.versionNativeId,
      identity: identity("hello-v1"),
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(
      await provider.verifyNativeAbsence({
        offering: offering("WorkerVersion"),
        descriptor,
        target: {
          tenantId: "org_demo",
          resourceUid: "uid-WorkerVersion-hello-v1",
          incarnationId: "dep-legacy-version",
          generation: "1",
        },
      }),
    ).toMatchObject({ outcome: "absent" });
    if (!provider.recoverDelete) throw new Error("missing self-host delete recovery");
    expect(
      await provider.recoverDelete({
        operationId: "op_non_active_version_delete",
        operationMode: "recovery",
        offering: offering("WorkerVersion"),
        nativeId: fixture.versionNativeId,
        identity: identity("hello-v1"),
        spec: {},
        relations: [relation("/worker", "ModuleWorker", "hello")],
      }),
    ).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
    expect(
      await runtime.observePublication?.(fixture.script, {
        kind: "version",
        versionId: "new-version",
      }),
    ).toBe("present");
  });

  test("deletes a supported activeVersion carrier and proves native absence", async () => {
    const probe = configProbe();
    const fixture = await legacyWorkerFixture({ probe });
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
    const probe = configProbe();
    const fixture = await legacyWorkerFixture({ probe });
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
