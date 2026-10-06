import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseStaticAssetBundleManifest } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  ASSET_ROUTER_SOURCE,
  ASSETS_SOURCE,
  createWorkerdRuntime,
  DEPLOYMENT_ROUTER_SOURCE,
  readWorkerdActiveActorGraph,
  readWorkerdSelectedActiveVersion,
  SERVICE_ROUTER_SOURCE,
  STATIC_READINESS_SOURCE,
  type WorkerdDeploymentPublication,
  type WorkerdMixedDeploymentPublication,
  type WorkerdStaticSite,
} from "../src/workerd-runtime.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-static-workerd-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function staticPublication(
  generation = "static-generation-1",
): WorkerdDeploymentPublication<WorkerdStaticSite> {
  return {
    generation,
    workerResourceUid: "uid-ModuleWorker-static",
    hostnames: ["static.localhost"],
    versions: [
      {
        versionId: "static-version",
        workerVersionUid: "uid-WorkerVersion-static",
        weight: 10_000,
        site: {
          kind: "static",
          directory: "static",
          hostnames: [],
          generation,
          workerResourceUid: "uid-ModuleWorker-static",
          fetchHandler: false,
          assets: {
            notFoundHandling: "single-page-application",
            runWorkerFirst: false,
            mediaTypes: { "index.html": "text/html" },
          },
        },
        modules: new Map(),
        assets: new Map([["index.html", new TextEncoder().encode("<h1>static</h1>")]]),
      },
    ],
  };
}

function probe() {
  let serving: { identity: string; token: string } | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (
        !serving ||
        request.method !== "POST" ||
        request.headers.get("host") !== "runtime.selfhost-config.invalid" ||
        new URL(request.url).pathname !== "/.well-known/takoserver/selfhost-runtime-config/v1" ||
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
  if (server.port === undefined) throw new Error("probe unavailable");
  return {
    port: server.port,
    stop: () => server.stop(true),
    async onReload(path: string) {
      const config = await readFile(path, "utf8");
      const identity = /\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      const token = /\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      if (!identity || !token) throw new Error("invalid config probe");
      serving = { identity, token };
    },
  };
}

test("static-only Version publishes without an application module and survives readback", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    const publication = staticPublication();
    if (!runtime.publishFenced || !runtime.observeExactPublication)
      throw new Error("fenced runtime unavailable");
    await runtime.publishFenced(
      "static",
      async () => publication,
      async () => true,
    );
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain('name = "STATIC_ONLY", text = "true"');
    expect(config).not.toContain('name = "WORKER", service = "selfhost-version-');
    const selected = await readWorkerdSelectedActiveVersion(root, "static", {
      expectedWorkerResourceUid: publication.workerResourceUid,
      basisPoint: 0,
      includeStatic: true,
    });
    expect(selected?.site).toMatchObject({ kind: "static", fetchHandler: false });
    expect(selected?.modules.size).toBe(0);
    expect(new TextDecoder().decode(selected?.assets?.get("index.html"))).toBe("<h1>static</h1>");
    expect(
      await readWorkerdSelectedActiveVersion(root, "static", {
        expectedWorkerResourceUid: publication.workerResourceUid,
        basisPoint: 0,
      }),
    ).toBeNull();
    await expect(
      readWorkerdActiveActorGraph(root, "static", publication.workerResourceUid),
    ).rejects.toThrow("unusable worker active Actor graph");
    const pointer = JSON.parse(
      await readFile(join(root, "workers", "static", "takoserver-site.json"), "utf8"),
    );
    const deployment = JSON.parse(
      await readFile(
        join(root, "workers", ".publications", "static", pointer.generationKey, "deployment.json"),
        "utf8",
      ),
    );
    expect(deployment.versions[0].manifest).toEqual({
      kind: "static",
      hostnames: [],
      generation: publication.generation,
      workerResourceUid: publication.workerResourceUid,
      fetchHandler: false,
      assets: expect.any(Object),
    });
    const reopened = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    await reopened.reload();
    if (!reopened.observeExactPublication) throw new Error("exact observation unavailable");
    const identity = {
      generation: publication.generation,
      workerResourceUid: publication.workerResourceUid,
      hostnames: publication.hostnames,
      versions: publication.versions.map(({ versionId, workerVersionUid, weight }) => ({
        versionId,
        workerVersionUid,
        weight,
      })),
    };
    expect(await reopened.observeExactPublication("static", identity)).toBe("matches");
    if (!reopened.publishFenced) throw new Error("fenced runtime unavailable");
    await reopened.publishFenced(
      "static",
      async (current) => {
        expect(current).toEqual(identity);
        return null;
      },
      async () => true,
    );
    expect(await reopened.observeExactPublication("static", null)).toBe("matches");
    expect(
      await readWorkerdSelectedActiveVersion(root, "static", {
        expectedWorkerResourceUid: publication.workerResourceUid,
        basisPoint: 0,
        includeStatic: true,
      }),
    ).toBeNull();
  } finally {
    p.stop();
  }
});

async function generatedFetchWorker(
  source: string,
  name: string,
): Promise<{
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}> {
  const path = join(root, name);
  await writeFile(path, source, "utf8");
  const loaded = (await import(`${pathToFileURL(path).href}?test=${crypto.randomUUID()}`)) as {
    default: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };
  };
  return loaded.default;
}

test("static asset router has no Worker binding and returns only assets or a final 404", async () => {
  const router = await generatedFetchWorker(ASSET_ROUTER_SOURCE, "static-asset-router.mjs");
  let lookups = 0;
  const env = {
    STATIC_ONLY: "true",
    ASSETS: {
      async fetch(request: Request) {
        lookups += 1;
        const path = new URL(request.url).pathname;
        if (path === "/index.html" || path === "/spa") {
          return new Response("<h1>asset</h1>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (path === "/invalid") return new Response("not found\n", { status: 404 });
        return new Response("not found\n", {
          status: 404,
          headers: { "x-takoserver-selfhost-asset-miss": "1" },
        });
      },
    },
  };
  const exact = await router.fetch(new Request("https://static.localhost/index.html"), env);
  expect(exact.status).toBe(200);
  expect(await exact.text()).toBe("<h1>asset</h1>");
  const spa = await router.fetch(new Request("https://static.localhost/spa"), env);
  expect(spa.status).toBe(200);
  const missing = await router.fetch(new Request("https://static.localhost/missing"), env);
  expect(missing.status).toBe(404);
  expect(missing.headers.has("x-takoserver-selfhost-asset-miss")).toBe(false);
  const invalid = await router.fetch(new Request("https://static.localhost/invalid"), env);
  expect(invalid.status).toBe(404);
  const priorLookups = lookups;
  const post = await router.fetch(
    new Request("https://static.localhost/index.html", { method: "POST" }),
    env,
  );
  expect(post.status).toBe(404);
  expect(lookups).toBe(priorLookups);
});

test("static assets reject intermediate empty path segments before SPA fallback and strip HEAD bodies", async () => {
  const assets = await generatedFetchWorker(ASSETS_SOURCE, "strict-static-assets.mjs");
  const router = await generatedFetchWorker(ASSET_ROUTER_SOURCE, "strict-static-router.mjs");
  let reads = 0;
  const assetEnv = {
    STRICT_PATHS: "true",
    NOT_FOUND: "single-page-application",
    ASSET_MANIFEST: {
      "index.html": { key: "held-index", mediaType: "text/html" },
    },
    FILES: {
      async fetch() {
        reads += 1;
        return new Response("<h1>static</h1>", {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      },
    },
  };
  const env = {
    STATIC_ONLY: "true",
    ASSETS: { fetch: (request: Request) => assets.fetch(request, assetEnv) },
  };
  const valid = await router.fetch(new Request("https://static.localhost/a/"), env);
  expect(valid.status).toBe(200);
  expect(await valid.text()).toBe("<h1>static</h1>");
  const beforeInvalid = reads;
  for (const path of ["/a//b", "//", "///a"]) {
    const response = await router.fetch(new Request(`https://static.localhost${path}`), env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found\n");
  }
  expect(reads).toBe(beforeInvalid);
  const invalidHead = await router.fetch(
    new Request("https://static.localhost/a//b", { method: "HEAD" }),
    env,
  );
  expect(invalidHead.status).toBe(404);
  expect(await invalidHead.text()).toBe("");
  const head = await router.fetch(
    new Request("https://static.localhost/index.html", { method: "HEAD" }),
    env,
  );
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("text/html");
  expect(await head.text()).toBe("");

  const directEnv = {
    ...assetEnv,
    NOT_FOUND: "none",
    ASSET_MANIFEST: {
      "index.html": { key: "held-index", mediaType: "text/html" },
      "dir/index.html": { key: "held-dir-index", mediaType: "text/html" },
    },
    FILES: {
      async fetch(url: string) {
        return new Response(url.endsWith("held-dir-index") ? "directory" : "root", {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    },
  };
  expect(
    await (await assets.fetch(new Request("https://static.localhost/"), directEnv)).text(),
  ).toBe("root");
  expect(
    await (await assets.fetch(new Request("https://static.localhost/dir/"), directEnv)).text(),
  ).toBe("directory");
  expect(
    (
      await assets.fetch(new Request("https://static.localhost/a//b"), {
        ...assetEnv,
        STRICT_PATHS: "false",
      })
    ).status,
  ).toBe(200);

  const noncharacterPath = "\uFDD0.txt";
  const noncharacter = await assets.fetch(
    new Request(`https://static.localhost/${encodeURIComponent(noncharacterPath)}`),
    {
      ...assetEnv,
      NOT_FOUND: "none",
      ASSET_MANIFEST: Object.fromEntries([
        [noncharacterPath, { key: "held-noncharacter", mediaType: "text/plain" }],
      ]),
      FILES: { fetch: async () => new Response("noncharacter") },
    },
  );
  expect(noncharacter.status).toBe(200);
  expect(await noncharacter.text()).toBe("noncharacter");
});

test("service Binding routes to static and mixed target assets with exact target UID", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced runtime unavailable");
    const target = staticPublication("target-generation");
    await runtime.publishFenced(
      "target",
      async () => target,
      async () => true,
    );
    const caller: WorkerdDeploymentPublication = {
      generation: "caller-generation",
      workerResourceUid: "uid-ModuleWorker-caller",
      hostnames: ["caller.localhost"],
      versions: [
        {
          versionId: "caller-version",
          workerVersionUid: "uid-WorkerVersion-caller",
          weight: 10_000,
          site: {
            directory: "caller",
            mainModule: "index.js",
            hostEntrypoint: "host.js",
            hostnames: [],
            generation: "caller-generation",
            workerResourceUid: "uid-ModuleWorker-caller",
            fetchHandler: true,
            serviceBindings: [
              {
                name: "__TAKOSERVER_SELFHOST_SERVICE_00001",
                target: "target",
                targetResourceUid: target.workerResourceUid,
                unavailableToken: "a".repeat(64),
              },
            ],
          },
          modules: new Map([
            [
              "index.js",
              new TextEncoder().encode(
                "export default { fetch() { return new Response('caller'); } };",
              ),
            ],
          ]),
          hostModules: new Map([
            ["host.js", new TextEncoder().encode("export { default } from './index.js';")],
          ]),
        },
      ],
    };
    await runtime.publishFenced(
      "caller",
      async () => caller,
      async () => true,
    );
    let config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain('(name = "TARGET", service = "target-selfhost-deployment")');
    const serviceRouter = await generatedFetchWorker(
      SERVICE_ROUTER_SOURCE,
      "static-service-router.mjs",
    );
    const assetRouter = await generatedFetchWorker(
      ASSET_ROUTER_SOURCE,
      "static-service-asset-router.mjs",
    );
    const serviceEnv = {
      __TAKOSERVER_SELFHOST_UNAVAILABLE_TOKEN: "a".repeat(64),
      TARGET: {
        fetch: (request: Request) =>
          assetRouter.fetch(request, {
            STATIC_ONLY: "true",
            ASSETS: { fetch: async () => new Response("static asset") },
          }),
      },
    };
    expect(
      await (
        await serviceRouter.fetch(new Request("https://unrelated.invalid/index.html"), serviceEnv)
      ).text(),
    ).toBe("static asset");
    expect(
      (
        await serviceRouter.fetch(
          new Request("https://unrelated.invalid/index.html", { method: "POST" }),
          serviceEnv,
        )
      ).status,
    ).toBe(404);
    const staticVersion = target.versions[0];
    const moduleVersion = caller.versions[0];
    if (!staticVersion || !moduleVersion) throw new Error("missing Version fixture");
    const mixed: WorkerdMixedDeploymentPublication = {
      ...target,
      generation: "target-mixed-generation",
      versions: [
        {
          ...staticVersion,
          weight: 4_000,
          site: { ...staticVersion.site, generation: "target-mixed-generation" },
        },
        {
          ...moduleVersion,
          versionId: "target-module-version",
          weight: 6_000,
          site: {
            directory: "target",
            mainModule: "index.js",
            hostEntrypoint: "host.js",
            hostnames: [],
            generation: "target-mixed-generation",
            workerResourceUid: target.workerResourceUid,
            fetchHandler: true,
          },
        },
      ],
    };
    await runtime.publishFenced(
      "target",
      async () => mixed,
      async () => true,
    );
    config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain('(name = "TARGET", service = "target-selfhost-deployment")');
    await runtime.publishFenced(
      "target",
      async () => ({
        ...target,
        workerResourceUid: "uid-ModuleWorker-other",
        versions: target.versions.map((version) => ({
          ...version,
          site: { ...version.site, workerResourceUid: "uid-ModuleWorker-other" },
        })),
      }),
      async () => true,
    );
    config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).not.toContain('(name = "TARGET", service = "target-selfhost-deployment")');
  } finally {
    p.stop();
  }
});

test("Form-valid Unicode, space, own-key paths and media types publish and survive restart", async () => {
  const files = [
    { path: "index.html", mediaType: "Text/HTML" },
    { path: "é.txt", mediaType: "text/plain" },
    { path: "space name.txt", mediaType: "text/plain" },
    { path: "__proto__", mediaType: "application/x+test" },
  ];
  parseStaticAssetBundleManifest(
    new TextEncoder().encode(
      JSON.stringify({
        files: files.map(({ path, mediaType }) => ({
          path,
          mediaType,
          url: `https://artifacts.example.invalid/${encodeURIComponent(path)}`,
          sha256: "a".repeat(64),
        })),
      }),
    ),
  );
  const mediaTypes = Object.fromEntries(files.map(({ path, mediaType }) => [path, mediaType]));
  const assetBytes = new Map(files.map(({ path }) => [path, new TextEncoder().encode(path)]));
  const base = staticPublication("form-assets-generation");
  const version = base.versions[0];
  if (!version) throw new Error("static Version fixture unavailable");
  const publication = {
    ...base,
    versions: [
      {
        ...version,
        site: { ...version.site, assets: { ...version.site.assets, mediaTypes } },
        assets: assetBytes,
      },
    ],
  };
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced) throw new Error("fenced runtime unavailable");
    await runtime.publishFenced(
      "static",
      async () => publication,
      async () => true,
    );
    const selected = await readWorkerdSelectedActiveVersion(root, "static", {
      expectedWorkerResourceUid: base.workerResourceUid,
      basisPoint: 0,
      includeStatic: true,
    });
    expect(selected?.site.assets?.mediaTypes).toEqual(mediaTypes);
    expect([...(selected?.assets?.keys() ?? [])]).toEqual(files.map(({ path }) => path).sort());
    const reopened = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    await reopened.reload();
    expect(
      (
        await readWorkerdSelectedActiveVersion(root, "static", {
          expectedWorkerResourceUid: base.workerResourceUid,
          basisPoint: 0,
          includeStatic: true,
        })
      )?.assets?.get("__proto__"),
    ).toEqual(new TextEncoder().encode("__proto__"));
  } finally {
    p.stop();
  }
});

test("Host static readiness and mixed weighted router never invoke tenant code for readiness", async () => {
  const readiness = await generatedFetchWorker(STATIC_READINESS_SOURCE, "static-readiness.mjs");
  const router = await generatedFetchWorker(DEPLOYMENT_ROUTER_SOURCE, "mixed-router.mjs");
  const path = "/.well-known/takoserver/selfhost-worker-readiness/v1";
  const headers = {
    "x-takoserver-selfhost-readiness": "takoserver.selfhost-worker-readiness@v1",
    "x-takoserver-selfhost-runtime-readiness": "host-capability",
  };
  const env = {
    PUBLICATION: "static-version",
    INTERNAL_HOSTNAME: "static.selfhost-internal.invalid",
    INTERNAL_READINESS_CAPABILITY: "host-capability",
  };
  const question = new Request(`https://${env.INTERNAL_HOSTNAME}${path}`, {
    method: "POST",
    headers,
  });
  expect((await readiness.fetch(question, env)).status).toBe(200);
  expect(
    (
      await readiness.fetch(
        new Request(`https://${env.INTERNAL_HOSTNAME}${path}`, { method: "POST" }),
        env,
      )
    ).status,
  ).toBe(404);
  let staticQuestions = 0;
  let moduleQuestions = 0;
  let publicCalls = 0;
  const mixed = {
    PUBLICATION: "weighted-publication",
    INTERNAL_HOSTNAME: env.INTERNAL_HOSTNAME,
    INTERNAL_READINESS_CAPABILITY: "host-capability",
    VERSIONS: [
      {
        binding: "VERSION_00000",
        readinessBinding: "READINESS_00000",
        versionId: "static-version",
        weight: 4_000,
      },
      {
        binding: "VERSION_00001",
        readinessBinding: "READINESS_00001",
        versionId: "module-version",
        weight: 6_000,
      },
    ],
    READINESS_00000: {
      async fetch(request: Request) {
        staticQuestions += 1;
        return readiness.fetch(request, env);
      },
    },
    READINESS_00001: {
      async fetch() {
        moduleQuestions += 1;
        return Response.json({
          schema: "takoserver.selfhost-worker-readiness-result@v1",
          publication: "module-version",
        });
      },
    },
    VERSION_00000: {
      async fetch() {
        publicCalls += 1;
        return new Response("static");
      },
    },
    VERSION_00001: {
      async fetch() {
        publicCalls += 1;
        return new Response("module");
      },
    },
  };
  const answer = await router.fetch(question, mixed);
  expect(answer.status).toBe(200);
  expect(staticQuestions).toBe(1);
  expect(moduleQuestions).toBe(1);
  expect(publicCalls).toBe(0);
  const publicAnswer = await router.fetch(new Request("https://static.localhost/"), mixed);
  expect(["static", "module"]).toContain(await publicAnswer.text());
  expect(publicCalls).toBe(1);
});

test("weighted module and static Versions keep separate fetch/readiness services across reload", async () => {
  const p = probe();
  try {
    const staticVersion = staticPublication("mixed-generation").versions[0];
    if (!staticVersion) throw new Error("static fixture unavailable");
    const publication: WorkerdMixedDeploymentPublication = {
      generation: "mixed-generation",
      workerResourceUid: "uid-ModuleWorker-static",
      hostnames: ["mixed.localhost"],
      versions: [
        { ...staticVersion, weight: 4_000 },
        {
          versionId: "module-version",
          workerVersionUid: "uid-WorkerVersion-module",
          weight: 6_000,
          site: {
            directory: "mixed",
            mainModule: "index.js",
            hostEntrypoint: "host.js",
            hostnames: [],
            generation: "mixed-generation",
            workerResourceUid: "uid-ModuleWorker-static",
            fetchHandler: true,
          },
          modules: new Map([
            [
              "index.js",
              new TextEncoder().encode(
                "export default { fetch() { return new Response('module'); } };",
              ),
            ],
          ]),
          hostModules: new Map([
            ["host.js", new TextEncoder().encode("export { default } from './index.js';")],
          ]),
        },
      ],
    };
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced || !runtime.observeExactPublication)
      throw new Error("fenced runtime unavailable");
    await runtime.publishFenced(
      "mixed",
      async () => publication,
      async () => true,
    );
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain('name = "STATIC_ONLY", text = "true"');
    expect(config).toContain('name = "READINESS_00000"');
    expect(config).toContain('name = "READINESS_00001"');
    expect(config).toContain('applicationMain = "index.js"');
    expect(config).not.toContain('name = "WORKER"');
    const staticSelected = await readWorkerdSelectedActiveVersion(root, "mixed", {
      expectedWorkerResourceUid: publication.workerResourceUid,
      basisPoint: 9_999,
      includeStatic: true,
    });
    const moduleSelected = await readWorkerdSelectedActiveVersion(root, "mixed", {
      expectedWorkerResourceUid: publication.workerResourceUid,
      basisPoint: 0,
    });
    expect(staticSelected?.site).toMatchObject({ kind: "static" });
    expect(moduleSelected?.site.mainModule).toBe("index.js");
    await runtime.reload();
    expect(
      await runtime.observeExactPublication("mixed", {
        generation: publication.generation,
        workerResourceUid: publication.workerResourceUid,
        hostnames: publication.hostnames,
        versions: publication.versions.map(({ versionId, workerVersionUid, weight }) => ({
          versionId,
          workerVersionUid,
          weight,
        })),
      }),
    ).toBe("matches");
  } finally {
    p.stop();
  }
});

test("static declaration refuses module, environment, and forwarding fields before any pointer", async () => {
  const runtime = createWorkerdRuntime({ root });
  if (!runtime.publish) throw new Error("publication unavailable");
  const base = staticPublication();
  const variant = base.versions[0];
  if (!variant) throw new Error("static fixture unavailable");
  for (const forbidden of [
    { mainModule: "index.js" },
    { hostEntrypoint: "host.js" },
    { modules: ["index.js"] },
    { hostModules: ["host.js"] },
    { vars: [{ name: "TOKEN", kind: "text", value: "secret" }] },
    { serviceBindings: [] },
    { actorForward: {} },
    { workflowForward: {} },
    { dataPlane: {} },
    { events: {} },
    { moduleMediaTypes: {} },
    { fetchHandler: true },
    { assets: { ...variant.site.assets, runWorkerFirst: true } },
  ]) {
    const bad = {
      ...base,
      versions: [{ ...variant, site: { ...variant.site, ...forbidden } }],
    } as unknown as WorkerdMixedDeploymentPublication;
    await expect(runtime.publish("static", bad)).rejects.toThrow();
  }
  await expect(
    runtime.publish("static", {
      ...base,
      versions: [{ ...variant, modules: new Map([["index.js", new Uint8Array([1])]]) }],
    }),
  ).rejects.toThrow();
  await expect(
    readFile(join(root, "workers", "static", "takoserver-site.json"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("static readback refuses changed asset bytes and malformed manifest even with a valid carrier digest", async () => {
  const p = probe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: p.port,
      onReload: p.onReload,
      isReady: () => true,
    });
    if (!runtime.publishFenced || !runtime.observeExactPublication)
      throw new Error("fenced runtime unavailable");
    const publication = staticPublication();
    await runtime.publishFenced(
      "static",
      async () => publication,
      async () => true,
    );
    const pointerPath = join(root, "workers", "static", "takoserver-site.json");
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
    const generationRoot = join(root, "workers", ".publications", "static", pointer.generationKey);
    const deploymentPath = join(generationRoot, "deployment.json");
    const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
    const assetKey = deployment.versions[0].manifest.assets.files["index.html"].key;
    const assetPath = join(generationRoot, "version-00000", "assets", assetKey);
    await writeFile(assetPath, "corrupt");
    await expect(
      readWorkerdSelectedActiveVersion(root, "static", {
        expectedWorkerResourceUid: publication.workerResourceUid,
        basisPoint: 0,
        includeStatic: true,
      }),
    ).rejects.toThrow("unusable worker active version snapshot");
    expect(
      await runtime.observeExactPublication("static", {
        generation: publication.generation,
        workerResourceUid: publication.workerResourceUid,
        hostnames: publication.hostnames,
        versions: [
          {
            versionId: "static-version",
            workerVersionUid: "uid-WorkerVersion-static",
            weight: 10_000,
          },
        ],
      }),
    ).toBe("unknown");

    await writeFile(assetPath, "<h1>static</h1>");
    deployment.versions[0].manifest.vars = [{ name: "FORBIDDEN", kind: "text", value: "x" }];
    const malformed = JSON.stringify(deployment);
    const newKey = createHash("sha256").update(malformed, "utf8").digest("hex");
    await writeFile(deploymentPath, malformed);
    await rename(generationRoot, join(root, "workers", ".publications", "static", newKey));
    await writeFile(pointerPath, JSON.stringify({ ...pointer, generationKey: newKey }));
    await expect(
      readWorkerdSelectedActiveVersion(root, "static", {
        expectedWorkerResourceUid: publication.workerResourceUid,
        basisPoint: 0,
        includeStatic: true,
      }),
    ).rejects.toThrow("unusable worker active version snapshot");
  } finally {
    p.stop();
  }
});
