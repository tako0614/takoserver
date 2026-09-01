import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import {
  createWorkerdRuntime,
  type WorkerdRuntime,
  type WorkerdSite,
} from "../src/workerd-runtime.ts";

/**
 * Running somebody's Worker on a machine you own is what makes a self-hosted
 * deployment a platform rather than a place to keep files. The chain under
 * test is the released Edge Family's: a WorkerVersion stores a committed
 * bundle, a WorkerDeployment publishes the winning version into workerd, and
 * the endpoint and domain attachments decide which hostnames route to it.
 */

const EDGE_API = "edge.forms.takoform.com/v1beta1";

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

const identity = (name: string) => ({ tenantRef: "org_demo", space: "default", name });

const endpointAssignment = (hostname = "reserved.localhost") => ({
  canonicalPublicOrigin: `https://${hostname}`,
  assignmentDigest: `sha256:${"e".repeat(64)}` as const,
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ProviderCase {
  readonly modules?: Record<string, string>;
  readonly suffixes?: readonly string[];
  readonly runtime?: WorkerdRuntime;
  readonly missingBlobs?: boolean;
}

interface FlakyRuntimeState {
  serving: boolean;
  failNextWrite: boolean;
  failNextReload: boolean;
  writes: number;
  reloads: number;
}

function flakyRuntime(): { runtime: WorkerdRuntime; state: FlakyRuntimeState } {
  const state: FlakyRuntimeState = {
    serving: false,
    failNextWrite: false,
    failNextReload: false,
    writes: 0,
    reloads: 0,
  };
  return {
    state,
    runtime: {
      async write() {
        state.writes += 1;
        if (state.failNextWrite) {
          state.failNextWrite = false;
          state.serving = false;
          throw new Error("runtime write failed");
        }
      },
      async remove() {
        state.serving = false;
      },
      async reload() {
        state.reloads += 1;
        if (state.failNextReload) {
          state.failNextReload = false;
          state.serving = false;
          throw new Error("runtime reload failed");
        }
        state.serving = true;
      },
      async has() {
        return state.serving;
      },
    },
  };
}

function provider(options: ProviderCase = {}) {
  const modules = options.modules ?? { "index.js": "export default {}" };
  return createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime: options.runtime ?? createWorkerdRuntime({ root, isReady: () => true }),
    ...(options.suffixes ? { suffixes: options.suffixes } : {}),
    artifacts: {
      async manifest(_tenant, digest) {
        if (digest === "sha256:worker") {
          return {
            kind: "WorkerBundle",
            mainModule: "index.js",
            modules: Object.keys(modules).map((name) => ({ name, digest: `sha256:${name}` })),
          };
        }
        if (digest === "sha256:site") {
          return {
            kind: "StaticAssetBundle",
            files: [
              { path: "index.html", digest: "sha256:index.html" },
              { path: "app.css", digest: "sha256:app.css" },
            ],
          };
        }
        return null;
      },
      async blob(digest) {
        if (options.missingBlobs) return null;
        const name = digest.slice("sha256:".length);
        const source = modules[name] ?? { "index.html": "<html>", "app.css": "body{}" }[name];
        return source === undefined ? null : new TextEncoder().encode(source);
      },
    },
  });
}

/** Drives the worker → version → deployment chain one apply at a time. */
async function publish(local: ReturnType<typeof provider>, assets = false) {
  const worker = await local.apply({
    operationId: "op_worker",
    offering: offering("ModuleWorker"),
    identity: identity("hello"),
    spec: {},
  });
  expect(worker.phase).toBe("succeeded");
  const script = worker.phase === "succeeded" ? (worker.result.outputs.scriptName as string) : "";

  const version = await local.apply({
    operationId: "op_version",
    offering: offering("WorkerVersion"),
    identity: identity("hello-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      ...(assets
        ? {
            assets: {
              bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "site" },
              notFoundHandling: "single_page_application",
              runWorkerFirst: false,
            },
          }
        : {}),
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ...(assets
        ? [
            relation("/assets/bundle", "StaticAssetBundle", "site", {
              manifestDigest: "sha256:site",
            }),
          ]
        : []),
    ],
  });
  expect(version.phase).toBe("succeeded");

  const deployment = await local.apply({
    operationId: "op_deploy",
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

describe("publishing a Worker through the Edge Family", () => {
  test("a deployment publishes the version's modules into workerd", async () => {
    const local = provider();
    const script = await publish(local);

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain(`(name = "${script}", service = "${script}")`);
    // Relative, because workerd resolves an embed against the config's own
    // directory and silently fails to read an absolute one.
    expect(config).toContain(`embed "${script}/index.js"`);
    expect(config).not.toContain(`embed "${root}`);
  });

  test("reports malformed durable script state instead of observing an empty deployment", async () => {
    const local = provider();
    const worker = await local.apply({
      operationId: "op_worker_corrupt_state",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    if (worker.phase !== "succeeded") throw new Error("the worker allocation failed");
    const script = String(worker.result.outputs.scriptName);
    const stateRoot = join(root, "selfhost", "scripts");
    const statePath = join(stateRoot, `${script}.json`);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(statePath, '{"activeVersion":"v-truncated","domains":[', "utf8");

    const observed = await local.observe({
      offering: offering("WorkerDeployment"),
      nativeId: `selfhost-deployment:${script}:op_deploy`,
      identity: identity("hello-live"),
      spec: {},
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });

    expect(observed).toMatchObject({
      phase: "failed",
      failure: {
        code: "provider_error",
        message: "the durable Worker script state is malformed",
        retryable: false,
      },
    });
    expect(await readFile(statePath, "utf8")).toBe('{"activeVersion":"v-truncated","domains":[');
  });

  test("the endpoint attachment assigns a stable HTTPS address and routes it", async () => {
    const local = provider();
    const script = await publish(local);

    const endpoint = await local.apply({
      operationId: "op_endpoint",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    });
    expect(endpoint.phase).toBe("succeeded");
    const outputs = endpoint.phase === "succeeded" ? endpoint.result.outputs : {};
    expect(outputs.hostname).toBe("reserved.localhost");
    expect(outputs.url).toBe("https://reserved.localhost/");
    // The published address matches the closed outputs grammar: lowercase
    // labels, at least two of them, no trailing dot.
    expect(String(outputs.hostname)).toMatch(
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u,
    );

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain("reserved.localhost");
    expect(config).not.toContain(`${script}.localhost`);

    // The address is deterministic for the worker, so a re-observation reports
    // exactly what was assigned.
    const observed = await local.observe({
      offering: offering("WorkerEndpoint"),
      nativeId: "whatever-was-recorded",
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(observed.phase === "succeeded" ? observed.result.outputs : {}).toEqual(outputs);

    if (endpoint.phase !== "succeeded") throw new Error("the endpoint allocation failed");
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("the selfhost provider is missing native readback");
    }
    const endpointOffering = offering("WorkerEndpoint");
    const endpointRelations = [relation("/worker", "ModuleWorker", "hello")];
    const descriptor = local.createNativeReadbackDescriptor({
      offering: endpointOffering,
      nativeId: endpoint.result.nativeId,
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: endpointRelations,
    });
    expect(descriptor.data).toEqual({
      hostname: "reserved.localhost",
      scriptName: script,
    });
    expect(
      await local.verifyNativeAbsence({ offering: endpointOffering, descriptor }),
    ).toMatchObject({ outcome: "present" });
    const deleteInput = {
      operationId: "op_endpoint_delete",
      operationMode: "initial" as const,
      offering: endpointOffering,
      nativeId: endpoint.result.nativeId,
      identity: identity("hello-endpoint"),
      spec: {},
      relations: endpointRelations,
    };
    expect(await local.delete(deleteInput)).toMatchObject({ phase: "succeeded" });
    expect(
      await local.verifyNativeAbsence({ offering: endpointOffering, descriptor }),
    ).toMatchObject({ outcome: "absent" });
    if (!local.recoverDelete) throw new Error("the selfhost provider is missing delete recovery");
    expect(await local.recoverDelete({ ...deleteInput, operationMode: "recovery" })).toMatchObject({
      phase: "succeeded",
      result: { nativeId: endpoint.result.nativeId, observed: { deleted: true } },
    });
  });

  test("a differing Worker Version digest refuses overwrite and preserves the committed modules", async () => {
    const first = provider({ modules: { "index.js": "a", "old.js": "b" } });
    const script = await publish(first);
    expect(await readFile(join(root, "workers", script, "old.js"), "utf8")).toBe("b");

    const second = provider({ modules: { "index.js": "a2" } });
    const worker = await second.apply({
      operationId: "op_worker",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    expect(worker.phase).toBe("succeeded");
    const version = await second.apply({
      operationId: "op_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    expect(version).toMatchObject({
      phase: "failed",
      failure: { code: "conflict" },
    });
    // Immutable Worker Version identities are create-only. A module the new
    // bundle does not contain must not be able to erase or replace committed
    // bytes under the same identity.
    expect(await readFile(join(root, "workers", script, "old.js"), "utf8")).toBe("b");
    expect(await readFile(join(root, "workers", script, "index.js"), "utf8")).toBe("a");
  });

  test("refuses a custom domain this deployment does not serve", async () => {
    const local = provider({ suffixes: ["mine.test"] });
    const ticket = await local.apply({
      operationId: "op_domain",
      offering: offering("WorkerCustomDomain"),
      identity: identity("hello-domain"),
      spec: {
        hostname: "somebody-else.test",
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  test("republishes an endpoint after a runtime reload failure persisted its desired state", async () => {
    const runtime = flakyRuntime();
    const local = provider({ runtime: runtime.runtime });
    await publish(local);
    runtime.state.failNextReload = true;

    const endpointInput = {
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    } as const;
    const failedApply = await local.apply({
      ...endpointInput,
      operationId: "op_endpoint_reload_failure",
    });
    expect(failedApply).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(runtime.state.serving).toBe(false);

    const retried = await local.apply({
      ...endpointInput,
      operationId: "op_endpoint_reload_retry",
    });
    expect(retried).toMatchObject({
      phase: "succeeded",
      result: { outputs: { hostname: "reserved.localhost" } },
    });
    expect(runtime.state.serving).toBe(true);
    expect(runtime.state.reloads).toBe(3);
  });

  test("republishes a custom domain after a runtime write failure persisted its desired state", async () => {
    const runtime = flakyRuntime();
    const local = provider({ runtime: runtime.runtime });
    await publish(local);
    runtime.state.failNextWrite = true;

    const domainInput = {
      offering: offering("WorkerCustomDomain"),
      identity: identity("hello-domain"),
      spec: {
        hostname: "www.example.test",
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    } as const;
    const failedApply = await local.apply({
      ...domainInput,
      operationId: "op_domain_write_failure",
    });
    expect(failedApply).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(runtime.state.serving).toBe(false);

    const retried = await local.apply({ ...domainInput, operationId: "op_domain_write_retry" });
    expect(retried).toMatchObject({
      phase: "succeeded",
      result: { observed: { hostname: "www.example.test" } },
    });
    expect(runtime.state.serving).toBe(true);
  });

  test("observes runtime truth instead of treating durable endpoint state as served", async () => {
    const runtime = flakyRuntime();
    const local = provider({ runtime: runtime.runtime });
    await publish(local);
    const endpoint = await local.apply({
      operationId: "op_endpoint_observe_truth",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    });
    expect(endpoint.phase).toBe("succeeded");
    runtime.state.serving = false;

    const observed = await local.observe({
      offering: offering("WorkerEndpoint"),
      nativeId: "whatever-was-recorded",
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(observed).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
  });

  test("does not treat a staged manifest as serving after reload fails", async () => {
    let failNextReload = false;
    const runtime = createWorkerdRuntime({
      root,
      isReady: () => true,
      onReload: async () => {
        if (failNextReload) {
          failNextReload = false;
          throw new Error("runtime reload failed after staging");
        }
      },
    });
    const local = provider({ runtime });
    await publish(local);
    failNextReload = true;

    const endpointInput = {
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    } as const;
    const failedApply = await local.apply({
      ...endpointInput,
      operationId: "op_endpoint_staged_reload_failure",
    });
    expect(failedApply).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });

    const observed = await local.observe({
      offering: offering("WorkerEndpoint"),
      nativeId: "whatever-was-recorded",
      identity: identity("hello-endpoint"),
      spec: endpointInput.spec,
      relations: endpointInput.relations,
    });
    expect(observed).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
  });

  test("removes an activation marker when the serving process is no longer ready", async () => {
    let ready = true;
    const runtime = createWorkerdRuntime({ root, isReady: () => ready });
    await runtime.write(
      "hello",
      { directory: "unused", mainModule: "index.js", hostnames: ["hello.test"], generation: "v1" },
      new Map([["index.js", new TextEncoder().encode("export default {}")]]),
    );
    await runtime.reload();
    expect(await runtime.has("hello", "v1")).toBe(true);
    ready = false;
    expect(await runtime.has("hello", "v1")).toBe(false);
    expect(await runtime.has("hello", "v1")).toBe(false);
  });

  test("refuses a bundle whose modules the store cannot produce", async () => {
    const local = provider({ missingBlobs: true });
    const ticket = await local.apply({
      operationId: "op_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    // Otherwise it becomes a script that fails to start later, for reasons
    // nothing connects back to this apply.
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  test("refuses unsupported sensitive Worker bindings", async () => {
    const local = provider();
    const ticket = await local.apply({
      operationId: "op_sensitive_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-sensitive"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        requiredSensitiveVars: ["ENCRYPTION_KEY"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: {
        code: "denied",
        message: "sensitive Worker bindings are unsupported by this Host",
      },
    });
  });

  test("a version that declares a site carries its files to the runtime", async () => {
    const written: {
      name: string;
      site: WorkerdSite;
      modules: ReadonlyMap<string, Uint8Array>;
      assets?: ReadonlyMap<string, Uint8Array>;
    }[] = [];
    const runtime: WorkerdRuntime = {
      async write(name, site, modules, assets) {
        written.push({ name, site, modules, ...(assets ? { assets } : {}) });
      },
      async remove() {},
      async reload() {},
      async has() {
        return true;
      },
    };
    const local = provider({ runtime });
    await publish(local, true);
    expect([...(written[0]?.assets?.keys() ?? [])].sort()).toEqual(["app.css", "index.html"]);
    expect(written[0]?.site.assets).toEqual({ notFoundHandling: "single-page-application" });
  });

  test("deleting the worker removes the script and its routes", async () => {
    const local = provider();
    const script = await publish(local);

    const deleted = await local.delete({
      operationId: "op_delete",
      offering: offering("ModuleWorker"),
      nativeId: `selfhost-worker:${script}:op_worker`,
      identity: identity("hello"),
    });
    expect(deleted.phase).toBe("succeeded");
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).not.toContain(`embed "${script}/index.js"`);
  });

  test("recovers a local worker delete by readback without repeating the mutation", async () => {
    let reloads = 0;
    const runtime = createWorkerdRuntime({
      root,
      isReady: () => true,
      onReload: async () => {
        reloads += 1;
      },
    });
    const local = provider({ runtime });
    const script = await publish(local);
    const input = {
      operationId: "op_worker_delete_recovery",
      operationMode: "initial" as const,
      offering: offering("ModuleWorker"),
      nativeId: `selfhost-worker:${script}:op_worker`,
      identity: identity("hello"),
    };
    const deleted = await local.delete(input);
    expect(deleted).toMatchObject({ phase: "succeeded" });
    const afterDeleteReloads = reloads;

    if (!local.recoverDelete) throw new Error("selfhost provider missing delete recovery seam");
    const recovered = await local.recoverDelete({
      ...input,
      operationMode: "recovery",
    });
    expect(recovered).toMatchObject({
      phase: "succeeded",
      result: { nativeId: input.nativeId, observed: { deleted: true } },
    });
    // Recovery is a readback-only seam: no second remove/reload is allowed.
    expect(reloads).toBe(afterDeleteReloads);
  });
});

describe("local namespaces", () => {
  test("a create mints an incarnation-unique native identity", async () => {
    const local = provider();
    const kv = offering("EdgeKVNamespace");
    const first = await local.apply({
      operationId: "op_1",
      offering: kv,
      identity: identity("cache"),
      spec: {},
    });
    const second = await local.apply({
      operationId: "op_2",
      offering: kv,
      identity: identity("cache"),
      spec: {},
    });
    const firstId = first.phase === "succeeded" ? first.result.nativeId : "";
    const secondId = second.phase === "succeeded" ? second.result.nativeId : "";
    // Delete-then-recreate of one name is a NEW incarnation, and the durable
    // deployment ledger holds native identities unique — so two creates must
    // never mint the same one.
    expect(firstId).not.toBe(secondId);

    // An update keeps the identity it was created under.
    const updated = await local.apply({
      operationId: "op_3",
      offering: kv,
      identity: identity("cache"),
      spec: {},
      previous: { nativeId: firstId, spec: {} },
    });
    expect(updated.phase === "succeeded" ? updated.result.nativeId : "").toBe(firstId);
  });

  test("the bucket keeps its pre-Edge readable name", async () => {
    const local = provider();
    const bucket = await local.apply({
      operationId: "op_1",
      offering: { ...offering("ObjectBucket"), kind: "object_bucket" },
      identity: identity("media"),
      spec: {},
    });
    expect(bucket.phase === "succeeded" ? bucket.result.outputs : {}).toEqual({
      protocol: "s3",
      bucketName: "org_demo-default-media",
    });
  });
});

describe("read-only native absence verification", () => {
  test("reads worker Version state, then proves it absent after parent deletion", async () => {
    const runtime = flakyRuntime();
    const local = provider({ runtime: runtime.runtime });
    const worker = await local.apply({
      operationId: "op_readback_worker",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    if (worker.phase !== "succeeded") throw new Error("worker allocation failed");
    const script = String(worker.result.outputs.scriptName);
    const version = await local.apply({
      operationId: "op_readback_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    if (version.phase !== "succeeded") throw new Error("version materialization failed");
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("selfhost provider must expose native absence readback");
    }
    const descriptor = local.createNativeReadbackDescriptor({
      offering: offering("WorkerVersion"),
      nativeId: version.result.nativeId,
      identity: identity("hello-v1"),
    });
    const writes = runtime.state.writes;
    const reloads = runtime.state.reloads;
    const present = await local.verifyNativeAbsence({
      offering: offering("WorkerVersion"),
      descriptor,
    });
    expect(present).toEqual({
      outcome: "present",
      evidence: { provider: "local", kind: "WorkerVersion", state: "present" },
    });
    expect(runtime.state.writes).toBe(writes);
    expect(runtime.state.reloads).toBe(reloads);

    const deleted = await local.delete({
      operationId: "op_readback_parent_delete",
      offering: offering("ModuleWorker"),
      nativeId: worker.result.nativeId,
      identity: identity("hello"),
    });
    expect(deleted.phase).toBe("succeeded");
    const writesAfterDelete = runtime.state.writes;
    const reloadsAfterDelete = runtime.state.reloads;
    const absent = await local.verifyNativeAbsence({
      offering: offering("WorkerVersion"),
      descriptor,
    });
    expect(absent).toEqual({
      outcome: "absent",
      evidence: { provider: "local", kind: "WorkerVersion", state: "absent" },
    });
    expect(JSON.stringify(absent)).not.toContain(script);
    expect(runtime.state.writes).toBe(writesAfterDelete);
    expect(runtime.state.reloads).toBe(reloadsAfterDelete);

    const malformed = await local.verifyNativeAbsence({
      offering: offering("WorkerVersion"),
      descriptor: { ...descriptor, data: { scriptName: "not-the-parent", versionId: "bad" } },
    });
    expect(malformed).toEqual({ outcome: "unknown", reason: "malformed", retryable: false });
  });
});

describe("the SQLite migration ledger", () => {
  test("applies real SQL and refuses a moved history", async () => {
    const local = provider();
    const database = await local.apply({
      operationId: "op_db",
      offering: offering("SQLiteDatabase"),
      identity: identity("main"),
      spec: {},
    });
    expect(database.phase).toBe("succeeded");
    const nativeId = database.phase === "succeeded" ? database.result.nativeId : "";
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");

    expect(await port.readLedger({ nativeId })).toEqual({ ok: true, value: [] });

    const first = {
      path: "0001_init.sql",
      digest: `sha256:${"1".repeat(64)}` as const,
      sql: new TextEncoder().encode("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)"),
    };
    expect(await port.applySuffix({ nativeId, expectedPrefix: [], migrations: [first] })).toEqual({
      ok: true,
      value: undefined,
    });

    const ledger = await port.readLedger({ nativeId });
    expect(ledger).toEqual({
      ok: true,
      value: [{ path: first.path, digest: first.digest }],
    });

    // A stale prefix means the database moved underneath the plan.
    const conflicting = await port.applySuffix({
      nativeId,
      expectedPrefix: [],
      migrations: [
        {
          path: "0002_more.sql",
          digest: `sha256:${"2".repeat(64)}`,
          sql: new TextEncoder().encode("CREATE TABLE more (id INTEGER PRIMARY KEY)"),
        },
      ],
    });
    expect(conflicting).toMatchObject({ ok: false, failure: { code: "conflict" } });

    // Broken SQL commits nothing, ledger row included.
    const broken = await port.applySuffix({
      nativeId,
      expectedPrefix: [{ path: first.path, digest: first.digest }],
      migrations: [
        {
          path: "0002_broken.sql",
          digest: `sha256:${"3".repeat(64)}`,
          sql: new TextEncoder().encode("THIS IS NOT SQL"),
        },
      ],
    });
    expect(broken).toMatchObject({ ok: false, failure: { code: "provider_error" } });
    expect(await port.readLedger({ nativeId })).toEqual({
      ok: true,
      value: [{ path: first.path, digest: first.digest }],
    });
  });
});
