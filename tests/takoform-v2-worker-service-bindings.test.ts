import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  parseWorkerBundleManifest,
  validateWorkerBundlePayload,
  WORKER_BUNDLE_FORM_URL,
} from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  referencesForModuleWorker,
  referencesForWorkerDeployment,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  validateWorkerDeploymentUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Backend, V2Form } from "../src/takoform-v2/types.ts";
import { projectV2WorkerCodeVersion } from "../src/takoform-v2/worker-code-runtime.ts";
import { createInternalV2CodeWorkerVersionForm } from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { v2ServiceTargetName } from "../src/takoform-v2/worker-service-resolution.ts";
import { createV2WorkerPublication } from "../src/takoform-v2/worker-static-publication.ts";
import type {
  WorkerdDeploymentPublication,
  WorkerdPublicationIdentity,
  WorkerdSite,
  WorkerdStaticSite,
} from "../src/workerd-runtime.ts";

const workerUid = "caller-worker";
const targetUid = "target-worker";
const bundleUid = "caller-bundle";
const file = new TextEncoder().encode(
  "export default { fetch(request, env) { return env.UPSTREAM ? env.UPSTREAM.fetch(request) : new Response(request.body, { headers: { 'x-target-version': env.MARKER ?? 'one' } }); } };",
);
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function heldBundle() {
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.js",
      files: [
        {
          path: "index.js",
          url: "https://artifacts.example.test/caller/index.js",
          sha256: sha256(file),
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const verified = await validateWorkerBundlePayload({
    spec: {
      artifact: {
        url: "https://artifacts.example.test/caller/manifest.json",
        sha256: sha256(manifestBytes),
      },
    },
    manifestBytes,
    fileBytes: [file],
  });
  return {
    manifest: parseWorkerBundleManifest(manifestBytes),
    manifestBytes,
    files: [new Uint8Array(file)],
    observed: verified.observed as unknown as JsonObject,
  };
}

test("a declared service Binding needs exact resolved UID proof before code projection", async () => {
  const input = {
    identity: {
      directory: "v2-worker-caller",
      hostnames: [],
      generation: "takoserver-v2-operation:00000000-0000-4000-8000-000000000001",
      workerResourceUid: workerUid,
      workerVersionUid: "caller-version",
      versionId: "caller-version-id",
      weight: 10_000,
      bundleResourceUid: bundleUid,
    },
    spec: {
      worker: { resourceUid: workerUid },
      bundle: { resourceUid: bundleUid },
      handlers: ["fetch"],
      serviceBindings: [{ name: "UPSTREAM", resource: { resourceUid: targetUid } }],
    },
    bundle: await heldBundle(),
    inspectModule: async () => ({
      outcome: "valid" as const,
      exportedHandlers: ["fetch" as const],
    }),
  };

  await expect(projectV2WorkerCodeVersion(input)).rejects.toMatchObject({
    code: "worker_binding_unavailable",
  });
  const target = `v2-worker-${sha256(new TextEncoder().encode(targetUid))}`;
  const resolvedServiceBindings = [
    { name: "UPSTREAM", target, targetResourceUid: targetUid, unavailableToken: "a".repeat(64) },
  ];
  const first = resolvedServiceBindings[0];
  if (!first) throw new Error("missing expected service binding");
  const projection = await projectV2WorkerCodeVersion({ ...input, resolvedServiceBindings });
  expect(projection.site.serviceBindings).toEqual(resolvedServiceBindings);
  const mutableBundle = await heldBundle();
  const projectedBeforeMutation = projectV2WorkerCodeVersion({
    ...input,
    bundle: mutableBundle,
    resolvedServiceBindings,
  });
  mutableBundle.files[0]?.fill(0x20);
  expect((await projectedBeforeMutation).modules.get("index.js")).toEqual(file);
  await expect(
    projectV2WorkerCodeVersion({
      ...input,
      resolvedServiceBindings: [{ ...first, targetResourceUid: "other" }],
    }),
  ).rejects.toMatchObject({ code: "worker_binding_unavailable" });
});

test("real Host SQL accepts a settled same-owner service UID and verifies the held caller Version", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-service-binding-"));
  const db = new Database(join(root, "state.sqlite"));
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    const targetKey = "service-fixture-target";
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "index.js",
        files: [
          {
            path: "index.js",
            url: "https://artifacts.example.test/caller/index.js",
            sha256: sha256(file),
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    const bundleHost = createWorkerBundleHost({
      sql,
      targetKey,
      source: {
        async read({ url }: { url: string }) {
          if (url === "https://artifacts.example.test/caller/manifest.json")
            return new Uint8Array(manifestBytes);
          if (url === "https://artifacts.example.test/caller/index.js") return new Uint8Array(file);
          throw new Error("source not granted");
        },
      },
    });
    const moduleBackend: V2Backend = {
      id: "fixture-module-worker",
      targetKey,
      async execute() {
        return {
          kind: "complete",
          observed: { activeDeploymentUid: null, ready: false },
          output: {},
        };
      },
      async reconcile(input) {
        return this.execute(input);
      },
    };
    const moduleForm: V2Form = {
      validateCreate: parseModuleWorkerSpec,
      validateUpdate(_previous, next) {
        parseModuleWorkerSpec(next);
      },
      references: referencesForModuleWorker,
      backend: moduleBackend,
    };
    const state = createV2WorkerPublicationState({ sql, bundleCustody: bundleHost.custody });
    const published = new Map<
      string,
      WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite>
    >();
    const publicationIdentity = (
      value: WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | undefined,
    ): WorkerdPublicationIdentity | null =>
      value
        ? {
            generation: value.generation,
            workerResourceUid: value.workerResourceUid,
            hostnames: [...value.hostnames].sort(),
            versions: value.versions.map(({ versionId, workerVersionUid, weight }) => ({
              versionId,
              workerVersionUid,
              weight,
            })),
          }
        : null;
    const runtime: Parameters<typeof createV2WorkerPublication>[0]["runtime"] = {
      async inspectModule() {
        return { outcome: "valid", exportedHandlers: ["fetch"] };
      },
      async publishFenced(name, resolve, stillCurrent) {
        if (!(await stillCurrent())) throw new Error("stale publication");
        const desired = await resolve(publicationIdentity(published.get(name)));
        if (!(await stillCurrent())) throw new Error("stale publication");
        if (desired) published.set(name, desired);
        else published.delete(name);
      },
      async observeExactPublication(name, expected) {
        return canonicalJson(publicationIdentity(published.get(name))) === canonicalJson(expected)
          ? "matches"
          : "different";
      },
    };
    let serviceBindingProjectionRequests = 0;
    const serviceBindingTokens: string[] = [];
    const publication = createV2WorkerPublication({
      targetKey,
      publicationState: state,
      runtime,
      // This suite checks SQL-held projection shape, not the native Host
      // broker; the pinned-workerd test covers that separate execution path.
      v2ServiceBindingForward: {
        async issueBinding(_claim, binding) {
          serviceBindingProjectionRequests += 1;
          serviceBindingTokens.push(binding.unavailableToken);
        },
      },
    });
    const versionForm = createInternalV2CodeWorkerVersionForm({
      sql,
      targetKey,
      publicationState: state,
      retirement: {
        async observeRetired() {
          return { kind: "unknown" };
        },
      },
      inspectModule: async () => ({ outcome: "valid", exportedHandlers: ["fetch"] }),
    });
    const deploymentBackend: V2Backend = {
      id: "fixture-deployment-publication",
      targetKey,
      async execute(input) {
        const result = await publication.publish(input);
        if (result.kind === "confirmed" && result.identity !== null) {
          const forwarded = serviceBindingProjectionRequests;
          expect(await publication.observe(input)).toMatchObject({ kind: "confirmed" });
          // A read-only reconciliation cannot create another Host broker.
          expect(serviceBindingProjectionRequests).toBe(forwarded);
        }
        return result.kind === "confirmed" && result.identity !== null
          ? {
              kind: "complete",
              observed: { ready: true, active: true, selectedVersions: [] },
              output: {},
            }
          : { kind: "unknown" };
      },
      async reconcile(input) {
        const result = await publication.observe(input);
        return result.kind === "confirmed" && result.identity !== null
          ? {
              kind: "complete",
              observed: { ready: true, active: true, selectedVersions: [] },
              output: {},
            }
          : { kind: "unknown" };
      },
    };
    const deploymentForm: V2Form = {
      validateCreate: parseWorkerDeploymentSpec,
      validateUpdate: validateWorkerDeploymentUpdate,
      references(spec) {
        return referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec));
      },
      backend: deploymentBackend,
    };
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3600,
      authorize: async () => true,
      forms: {
        [MODULE_WORKER_FORM_URL]: moduleForm,
        [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
        [WORKER_VERSION_FORM_URL]: versionForm,
        [WORKER_DEPLOYMENT_FORM_URL]: deploymentForm,
      },
    });
    async function create(form: string, name: string, spec: JsonObject) {
      const accepted = await engine.acceptCreate({
        principal: "owner-1",
        key: `service-create-${name}-key`,
        input: { form, space: "production", name, spec },
      });
      expect(await engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
      return accepted;
    }

    const target = await create(MODULE_WORKER_FORM_URL, "target", {});
    const caller = await create(MODULE_WORKER_FORM_URL, "caller", {});
    const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: {
        url: "https://artifacts.example.test/caller/manifest.json",
        sha256: sha256(manifestBytes),
      },
    });
    const targetVersion = await create(WORKER_VERSION_FORM_URL, "target-version", {
      worker: { resourceUid: target.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    });
    const targetDeployment = await create(WORKER_DEPLOYMENT_FORM_URL, "target-deployment", {
      worker: { resourceUid: target.resourceUid },
      versions: [{ workerVersion: { resourceUid: targetVersion.resourceUid }, weight: 10_000 }],
    });
    const version = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: caller.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      serviceBindings: [{ name: "UPSTREAM", resource: { resourceUid: target.resourceUid } }],
    });
    expect(
      await engine.getResource({ principal: "owner-1", uid: version.resourceUid }),
    ).toMatchObject({
      observed: { ready: true, resolvedBindings: true, bundleVerified: true },
    });
    await create(WORKER_DEPLOYMENT_FORM_URL, "caller-deployment", {
      worker: { resourceUid: caller.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    expect(serviceBindingProjectionRequests).toBeGreaterThan(0);
    // One accepted publication resolves its candidate twice around the native
    // fence. Both passes must address the same broker socket in this owner.
    expect(serviceBindingProjectionRequests).toBeGreaterThan(1);
    expect(new Set(serviceBindingTokens).size).toBe(1);
    const callerPublication = published.get(await v2ServiceTargetName(caller.resourceUid));
    const callerVariant = callerPublication?.versions[0];
    if (!callerVariant || !("mainModule" in callerVariant.site))
      throw new Error("caller code was not published");
    expect(callerVariant.site.serviceBindings).toMatchObject([
      {
        target: await v2ServiceTargetName(target.resourceUid),
        targetResourceUid: target.resourceUid,
      },
    ]);
    expect(callerVariant.site.hostModules).toBeDefined();
    expect(
      [...(callerVariant.hostModules?.values() ?? [])].some((bytes) =>
        new TextDecoder().decode(bytes).includes("UPSTREAM"),
      ),
    ).toBe(true);

    // A Bun stand-in executes the exact selected held JS, while routing from
    // the compiled native service descriptor. Native workerd/asset routing is
    // separately covered by its own evidence lane, not asserted by this shim.
    async function invokeLogical(uid: string, request: Request): Promise<Response> {
      const name = await v2ServiceTargetName(uid);
      const selected = published.get(name);
      if (!selected || selected.workerResourceUid !== uid) {
        throw Object.assign(new Error("target is not serving"), { name: "backend_unavailable" });
      }
      const variant = selected.versions[0];
      if (!variant || !("mainModule" in variant.site)) throw new Error("code Version missing");
      const body = variant.modules.get(variant.site.mainModule);
      if (!body) throw new Error("held application module missing");
      const env: Record<string, unknown> = {};
      for (const entry of variant.site.vars ?? []) env[entry.name] = JSON.parse(entry.value);
      for (const binding of variant.site.serviceBindings ?? []) {
        if (binding.target !== (await v2ServiceTargetName(binding.targetResourceUid))) {
          throw new Error("compiled service target changed");
        }
        env.UPSTREAM = {
          fetch: (forwarded: Request) => invokeLogical(binding.targetResourceUid, forwarded),
        };
      }
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(body).toString("base64")}`
      );
      return await module.default.fetch(request, env, { waitUntil() {} });
    }

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const response = await invokeLogical(
      caller.resourceUid,
      new Request("https://unrelated.invalid/stream", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(response.headers.get("x-target-version")).toBe("one");
    const reader = response.body?.getReader();
    if (!reader || !controller) throw new Error("streaming response was not returned");
    controller.enqueue(new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    controller.enqueue(new TextEncoder().encode("second"));
    controller.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("second");
    expect((await reader.read()).done).toBe(true);

    const secondTargetVersion = await create(WORKER_VERSION_FORM_URL, "target-version-two", {
      worker: { resourceUid: target.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      vars: { MARKER: "two" },
    });
    const nextTarget = await engine.acceptUpdate({
      principal: "owner-1",
      key: "update-target-deployment-key",
      uid: targetDeployment.resourceUid,
      expectedGeneration: 1,
      spec: {
        worker: { resourceUid: target.resourceUid },
        versions: [
          { workerVersion: { resourceUid: secondTargetVersion.resourceUid }, weight: 10_000 },
        ],
      },
    });
    expect(await engine.runNext()).toMatchObject({ id: nextTarget.id, status: "succeeded" });
    expect(
      published.get(await v2ServiceTargetName(target.resourceUid))?.versions[0]?.workerVersionUid,
    ).toBe(secondTargetVersion.resourceUid);
    expect(
      (
        await invokeLogical(
          caller.resourceUid,
          new Request("https://another-host.invalid/current", { method: "POST", body: "payload" }),
        )
      ).headers.get("x-target-version"),
    ).toBe("two");
    await expect(
      engine.acceptDelete({
        principal: "owner-1",
        key: "delete-still-referenced-target-key",
        uid: target.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict" });
    published.delete(await v2ServiceTargetName(target.resourceUid));
    await expect(
      invokeLogical(caller.resourceUid, new Request("https://name-must-not-be-resolved.invalid/")),
    ).rejects.toMatchObject({ name: "backend_unavailable" });

    await expect(
      engine.acceptCreate({
        principal: "owner-1",
        key: "missing-service-target-key",
        input: {
          form: WORKER_VERSION_FORM_URL,
          space: "production",
          name: "missing",
          spec: {
            worker: { resourceUid: caller.resourceUid },
            bundle: { resourceUid: bundle.resourceUid },
            handlers: ["fetch"],
            serviceBindings: [{ name: "UPSTREAM", resource: { resourceUid: "missing-uid" } }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict" });

    const foreign = await engine.acceptCreate({
      principal: "owner-2",
      key: "create-foreign-worker-key",
      input: { form: MODULE_WORKER_FORM_URL, space: "production", name: "foreign", spec: {} },
    });
    expect(await engine.runNext()).toMatchObject({ id: foreign.id, status: "succeeded" });
    await expect(
      engine.acceptCreate({
        principal: "owner-1",
        key: "foreign-service-reference-key",
        input: {
          form: WORKER_VERSION_FORM_URL,
          space: "production",
          name: "foreign-reference",
          spec: {
            worker: { resourceUid: caller.resourceUid },
            bundle: { resourceUid: bundle.resourceUid },
            handlers: ["fetch"],
            serviceBindings: [{ name: "UPSTREAM", resource: { resourceUid: foreign.resourceUid } }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict" });

    const otherTargetKey = "other-service-target";
    const otherBackend = { ...moduleBackend, targetKey: otherTargetKey };
    const otherEngine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3600,
      authorize: async () => true,
      forms: { [MODULE_WORKER_FORM_URL]: { ...moduleForm, backend: otherBackend } },
    });
    const otherTarget = await otherEngine.acceptCreate({
      principal: "owner-1",
      key: "create-other-target-worker-key",
      input: {
        form: MODULE_WORKER_FORM_URL,
        space: "production",
        name: "other-target",
        spec: {},
      },
    });
    expect(await otherEngine.runNext()).toMatchObject({ id: otherTarget.id, status: "succeeded" });
    const unresolvedVersion = await engine.acceptCreate({
      principal: "owner-1",
      key: "other-target-service-reference-key",
      input: {
        form: WORKER_VERSION_FORM_URL,
        space: "production",
        name: "other-target-reference",
        spec: {
          worker: { resourceUid: caller.resourceUid },
          bundle: { resourceUid: bundle.resourceUid },
          handlers: ["fetch"],
          serviceBindings: [
            { name: "UPSTREAM", resource: { resourceUid: otherTarget.resourceUid } },
          ],
        },
      },
    });
    expect(await engine.runNext()).toMatchObject({
      id: unresolvedVersion.id,
      status: "reconciling",
    });
    expect(
      await engine.getResource({ principal: "owner-1", uid: unresolvedVersion.resourceUid }),
    ).toMatchObject({ observedGeneration: 0, observed: {} });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
