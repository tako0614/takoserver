import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bytesDigest } from "../src/json.ts";
import {
  ASSET_ROUTER_SOURCE,
  ASSETS_SOURCE,
  createWorkerdRuntime,
  DEPLOYMENT_ROUTER_SOURCE,
  ROUTER_SOURCE,
  readWorkerdActiveDeployment,
  readWorkerdSelectedActiveVersion,
  type WorkerdBinding,
  type WorkerdDeploymentPublication,
} from "../src/workerd-runtime.ts";

/**
 * The generated configuration is assembled by concatenating strings, and the
 * values in it belong to a tenant. These tests are about the two properties
 * that follow from that: a value can never end the literal it is written into,
 * and the file it lands in is readable only by the operator.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-workerd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const MODULES = new Map([["index.js", new TextEncoder().encode("export default {}")]]);

const HOST_ENTRYPOINT = "__takoserver-host.js";

function weightedPublication(
  name: string,
  generation: string,
  weights: readonly [number, number] = [1, 9_999],
): WorkerdDeploymentPublication {
  const version = (suffix: "a" | "b", weight: number) => ({
    versionId: `${name}-v-${suffix}`,
    workerVersionUid: `uid-WorkerVersion-${name}-${suffix}`,
    weight,
    site: {
      directory: name,
      mainModule: "index.js",
      hostEntrypoint: HOST_ENTRYPOINT,
      hostnames: [],
      generation,
      workerResourceUid: `uid-ModuleWorker-${name}`,
      fetchHandler: true,
    },
    modules: new Map([
      [
        "index.js",
        new TextEncoder().encode(
          `export default { fetch() { return new Response(${JSON.stringify(`${name}-${suffix}`)}); } };`,
        ),
      ],
    ]),
    hostModules: new Map([
      [HOST_ENTRYPOINT, new TextEncoder().encode('export { default } from "./index.js";')],
    ]),
  });
  return {
    generation,
    workerResourceUid: `uid-ModuleWorker-${name}`,
    hostnames: [`${name}.localhost`],
    // Declaration order is intentionally not canonical. The durable manifest
    // and routing table must use the one shared WorkerVersion UID comparator.
    versions: [version("b", weights[1]), version("a", weights[0])],
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function configRoutes(config: string): Readonly<Record<string, string>> {
  const literal = /\(name = "ROUTES", text = ("(?:[^"\\]|\\.)*")\)/u.exec(config)?.[1];
  if (!literal) throw new Error("missing runtime route table");
  return JSON.parse(JSON.parse(literal)) as Record<string, string>;
}

function configTextRecord(config: string, binding: string): Readonly<Record<string, string>> {
  const literal = new RegExp(
    `\\(name = ${JSON.stringify(binding)}, text = ("(?:[^"\\\\]|\\\\.)*")\\)`,
    "u",
  ).exec(config)?.[1];
  if (!literal) throw new Error(`missing ${binding} binding`);
  return JSON.parse(JSON.parse(literal)) as Record<string, string>;
}

function withoutPrivateRuntimeTokens(config: string): string {
  return config.replace(
    /(name = "(?:CONFIG_PROBE_TOKEN|INTERNAL_READINESS_CAPABILITY)", text = ")[0-9a-f]{64}"/gu,
    '$1<private-runtime-token>"',
  );
}

interface GeneratedFetchWorker {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}

async function generatedFetchWorker(source: string, name: string): Promise<GeneratedFetchWorker> {
  const path = join(root, name);
  await writeFile(path, source, "utf8");
  const loaded = (await import(`${pathToFileURL(path).href}?test=${crypto.randomUUID()}`)) as {
    readonly default: GeneratedFetchWorker;
  };
  return loaded.default;
}

function rawRequest(url: string, method = "GET"): Request {
  return { method, url } as Request;
}

function createConfigProbe(): {
  readonly port: number;
  readonly onReload: (path: string) => Promise<void>;
  behavior: ((config: string, invocation: number) => void | Promise<void>) | undefined;
  stop(): void;
} {
  let serving: { readonly identity: string; readonly token: string } | null = null;
  let invocation = 0;
  const result = {
    port: 0,
    behavior: undefined as
      | ((config: string, invocation: number) => void | Promise<void>)
      | undefined,
    async onReload(path: string) {
      const config = await readFile(path, "utf8");
      const identity = /\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      const token = /\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
      if (!identity || !token) throw new Error("invalid config probe declaration");
      serving = { identity, token };
      invocation += 1;
      await result.behavior?.(config, invocation);
    },
    stop() {
      server.stop(true);
    },
  };
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
        request.headers.get("x-takoserver-selfhost-runtime-config") !== serving?.token
      ) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          "x-takoserver-selfhost-config-identity": serving.identity,
        },
      });
    },
  });
  if (server.port === undefined) throw new Error("config probe did not bind a port");
  result.port = server.port;
  return result;
}

for (const failure of ["activation-marker", "carrier-rename"] as const) {
  test(`restores the scalar publication when ${failure} persistence fails during retirement`, async () => {
    const probe = createConfigProbe();
    const script = "site";
    const directory = join(root, "workers", script);
    const markerPath = join(root, "workers", ".takoserver-active.json");
    try {
      const runtime = createWorkerdRuntime({
        root,
        port: probe.port,
        isReady: () => true,
        onReload: probe.onReload,
      });
      if (!runtime.publish) throw new Error("publication fixture is unavailable");
      const version = weightedPublication(script, "scalar-generation").versions[0];
      if (!version) throw new Error("scalar fixture is unavailable");
      await runtime.write(
        script,
        { ...version.site, hostnames: ["site.localhost"] },
        version.modules,
        undefined,
        version.hostModules,
      );
      await runtime.reload();
      const manifest = await readFile(join(directory, "takoserver-site.json"));
      const module = await readFile(join(directory, "application", "module-00000"));
      probe.behavior = async (_config, invocation) => {
        if (failure === "activation-marker") {
          if (invocation === 2) {
            rmSync(markerPath);
            await mkdir(markerPath);
          }
          if (invocation === 3) rmSync(markerPath, { recursive: true });
        } else if (invocation === 2) {
          const retainedRoot = join(root, "workers", ".retired");
          const [retained] = await readdir(retainedRoot);
          if (!retained) throw new Error("retirement fixture is unavailable");
          const destination = join(retainedRoot, retained, "publication");
          await mkdir(destination);
          await writeFile(join(destination, "occupied"), "refuse replacement");
        }
      };

      await expect(runtime.publish(script, null)).rejects.toThrow();
      expect(await readFile(join(directory, "takoserver-site.json"))).toEqual(manifest);
      expect(await readFile(join(directory, "application", "module-00000"))).toEqual(module);
      expect(await runtime.has(script, "scalar-generation")).toBe(true);
      const restarted = createWorkerdRuntime({ root, isReady: () => true });
      expect(await restarted.restore()).toEqual([script]);
      expect(await readdir(join(root, "workers", ".retired"))).toEqual([]);
    } finally {
      probe.stop();
    }
  });
}

test("renders separate application and Host-private identities even under the same name", async () => {
  const sharedName = "__takoserver-selfhost-entrypoint.js";
  const applicationSource = new TextEncoder().encode(
    `export const identity = "application"; export default { fetch() {} };`,
  );
  const hostSource = new TextEncoder().encode(
    `import application from "./${sharedName}"; export default application;`,
  );
  const runtime = createWorkerdRuntime({ root, isReady: () => true });

  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: sharedName,
      hostEntrypoint: sharedName,
      hostnames: ["site.localhost"],
      moduleMediaTypes: { [sharedName]: "application/javascript+module" },
    },
    new Map([[sharedName, applicationSource]]),
    undefined,
    new Map([[sharedName, hostSource]]),
  );
  await runtime.reload();

  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain(`modulePolicy = (applicationMain = "${sharedName}")`);
  expect(config).toContain(
    `(name = "${sharedName}", esModule = embed "site/host-private/module-00000", role = hostPrivate)`,
  );
  expect(config).toContain(
    `(name = "${sharedName}", esModule = embed "site/application/module-00000", role = application)`,
  );
  expect([
    ...(await readFile(join(root, "workers", "site", "application", "module-00000"))),
  ]).toEqual([...applicationSource]);
  expect([
    ...(await readFile(join(root, "workers", "site", "host-private", "module-00000"))),
  ]).toEqual([...hostSource]);
});

test("renders retained scalar readiness as one private Host capability route", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "index.js",
      hostEntrypoint: HOST_ENTRYPOINT,
      hostnames: ["site.localhost"],
      generation: "scalar-generation",
    },
    MODULES,
    undefined,
    new Map([[HOST_ENTRYPOINT, new TextEncoder().encode('export { default } from "./index.js";')]]),
  );
  await runtime.reload();

  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(configTextRecord(config, "INTERNAL_READINESS_ROUTES")).toEqual({
    "site.selfhost-internal.invalid": "site",
  });
  const entrypointCapability =
    /\(name = "__TAKOSERVER_SELFHOST_RUNTIME_READINESS", text = "([0-9a-f]{64})"\)/u.exec(
      config,
    )?.[1];
  const routerCapability =
    /\(name = "INTERNAL_READINESS_CAPABILITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
  expect(entrypointCapability).toBeDefined();
  expect(entrypointCapability).toBe(routerCapability);
});

test("module inspection uses the selected serving binary without a package fallback", async () => {
  const bytes = new TextEncoder().encode("export default { fetch() {} };");
  const runtime = createWorkerdRuntime({ root, binary: null });
  expect(
    await runtime.inspectModule({
      mainModule: "index.js",
      modules: [
        {
          name: "index.js",
          mediaType: "application/javascript+module",
          bytes,
          digest: await bytesDigest(bytes),
        },
      ],
      declaredHandlers: ["fetch"],
    }),
  ).toEqual({ outcome: "unavailable", retryable: true });
});

test("renders each declared module media type without inferring from its name", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "worker.txt",
      hostnames: ["site.localhost"],
      modules: ["plain.js", "binary.js", "payload.bin"],
      moduleMediaTypes: {
        "worker.txt": "application/javascript+module",
        "plain.js": "text/plain",
        "binary.js": "application/octet-stream",
        "payload.bin": "application/wasm",
      },
    },
    new Map([
      ["worker.txt", new TextEncoder().encode("export default {}")],
      ["plain.js", new TextEncoder().encode("plain")],
      ["binary.js", new Uint8Array([0, 1, 2, 255])],
      ["payload.bin", new Uint8Array([0, 97, 115, 109])],
    ]),
  );
  await runtime.reload();

  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain(
    '(name = "worker.txt", esModule = embed "site/application/module-00000", role = application)',
  );
  expect(config).toContain(
    '(name = "plain.js", text = embed "site/application/module-00001", role = application)',
  );
  expect(config).toContain(
    '(name = "binary.js", data = embed "site/application/module-00002", role = application)',
  );
  expect(config).toContain(
    '(name = "payload.bin", wasm = embed "site/application/module-00003", role = application)',
  );
  expect(config).not.toContain('(name = "plain.js", esModule =');
  expect(config).not.toContain('(name = "binary.js", esModule =');
  expect(config).not.toContain('(name = "payload.bin", esModule =');
});

test("rejects an invalid media map without damaging the active publication", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  const oldBytes = new TextEncoder().encode(
    "export default { fetch() { return new Response('old'); } }",
  );
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "index.js",
      hostnames: ["site.localhost"],
      modules: ["dependency.js"],
      moduleMediaTypes: {
        "index.js": "application/javascript+module",
        "dependency.js": "application/javascript+module",
      },
    },
    new Map([
      ["index.js", oldBytes],
      ["dependency.js", new TextEncoder().encode("export const value = 1")],
    ]),
  );
  await runtime.reload();
  const beforeConfig = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  const beforeBytes = await readFile(join(root, "workers", "site", "application", "module-00000"));

  const invalidMaps: readonly Record<string, unknown>[] = [
    { "index.js": "application/javascript+module" },
    {
      "index.js": "application/javascript+module",
      "dependency.js": "application/javascript+module",
      "unknown.js": "text/plain",
    },
    {
      "index.js": "application/javascript+module",
      "dependency.js": "image/png",
    },
  ];
  for (const moduleMediaTypes of invalidMaps) {
    await expect(
      runtime.write(
        "site",
        {
          directory: "site",
          mainModule: "index.js",
          hostnames: ["site.localhost"],
          modules: ["dependency.js"],
          moduleMediaTypes: moduleMediaTypes as never,
        },
        new Map([["index.js", new TextEncoder().encode("new bytes")]]),
      ),
    ).rejects.toThrow("unusable worker module media types");
    expect(await readFile(join(root, "workers", "workerd.capnp"), "utf8")).toBe(beforeConfig);
    expect(await readFile(join(root, "workers", "site", "application", "module-00000"))).toEqual(
      beforeBytes,
    );
  }
  await expect(
    runtime.write(
      "site",
      {
        directory: "site",
        mainModule: "index.js",
        hostnames: ["site.localhost"],
        modules: ["index.js"],
        moduleMediaTypes: { "index.js": "application/javascript+module" },
      },
      new Map([["index.js", new TextEncoder().encode("new bytes")]]),
    ),
  ).rejects.toThrow("unusable worker module");
  expect(await readFile(join(root, "workers", "workerd.capnp"), "utf8")).toBe(beforeConfig);
  expect(await readFile(join(root, "workers", "site", "application", "module-00000"))).toEqual(
    beforeBytes,
  );
});

test("requires exact application and Host-private byte maps before replacing a publication", async () => {
  const sharedName = "entry.js";
  const application = new Map([
    [sharedName, new TextEncoder().encode("export default { fetch() {} }")],
  ]);
  const hostPrivate = new Map([
    [
      sharedName,
      new TextEncoder().encode(`import app from "./${sharedName}"; export default app;`),
    ],
  ]);
  const site = {
    directory: "site",
    mainModule: sharedName,
    hostEntrypoint: sharedName,
    hostnames: ["site.localhost"],
  } as const;
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write("site", site, application, undefined, hostPrivate);
  await runtime.reload();

  const manifestPath = join(root, "workers", "site", "takoserver-site.json");
  const applicationPath = join(root, "workers", "site", "application", "module-00000");
  const hostPath = join(root, "workers", "site", "host-private", "module-00000");
  const beforeConfig = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  const beforeManifest = await readFile(manifestPath, "utf8");
  const beforeApplication = await readFile(applicationPath);
  const beforeHost = await readFile(hostPath);
  const attempts = [
    { application: new Map(), hostPrivate },
    {
      application: new Map([...application, ["undeclared.js", new Uint8Array()]]),
      hostPrivate,
    },
    { application, hostPrivate: new Map() },
    {
      application,
      hostPrivate: new Map([...hostPrivate, ["undeclared.js", new Uint8Array()]]),
    },
  ];

  for (const attempt of attempts) {
    await expect(
      runtime.write("site", site, attempt.application, undefined, attempt.hostPrivate),
    ).rejects.toThrow(/unusable (?:application|Host-private) worker module snapshot/u);
    expect(await readFile(join(root, "workers", "workerd.capnp"), "utf8")).toBe(beforeConfig);
    expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    expect(await readFile(applicationPath)).toEqual(beforeApplication);
    expect(await readFile(hostPath)).toEqual(beforeHost);
  }
});

test("persists module media metadata through reload and restart", async () => {
  const mediaTypes = {
    "worker.txt": "application/javascript+module",
    "plain.js": "text/plain",
    "binary.js": "application/octet-stream",
    "payload.bin": "application/wasm",
  } as const;
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "worker.txt",
      hostnames: ["site.localhost"],
      generation: "gen-1",
      modules: ["plain.js", "binary.js", "payload.bin"],
      moduleMediaTypes: mediaTypes,
    },
    new Map([
      ["worker.txt", new TextEncoder().encode("export default {}")],
      ["plain.js", new TextEncoder().encode("plain")],
      ["binary.js", new Uint8Array([0, 1, 2])],
      ["payload.bin", new Uint8Array([0, 97, 115, 109])],
    ]),
  );
  await runtime.reload();

  const manifest = JSON.parse(
    await readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8"),
  ) as { moduleMediaTypes?: Record<string, string> };
  expect(manifest.moduleMediaTypes).toEqual(mediaTypes);

  const restarted = createWorkerdRuntime({ root, isReady: () => true });
  expect(await restarted.restore()).toEqual(["site"]);
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain(
    '(name = "plain.js", text = embed "site/application/module-00001", role = application)',
  );
  expect(config).toContain(
    '(name = "binary.js", data = embed "site/application/module-00002", role = application)',
  );
  expect(config).toContain(
    '(name = "payload.bin", wasm = embed "site/application/module-00003", role = application)',
  );
  expect(await restarted.has("site", "gen-1")).toBe(true);
});

test("defaults application modules to esModule when media metadata is absent", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "worker.txt",
      hostnames: ["site.localhost"],
      modules: ["dependency.txt"],
    },
    new Map([
      ["worker.txt", new TextEncoder().encode("export default {}")],
      ["dependency.txt", new TextEncoder().encode("export const value = 1")],
    ]),
  );
  await runtime.reload();
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain(
    '(name = "worker.txt", esModule = embed "site/application/module-00000", role = application)',
  );
  expect(config).toContain(
    '(name = "dependency.txt", esModule = embed "site/application/module-00001", role = application)',
  );
});

test("persists private asset routing order through reload and restart", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  const mutableIndex = new TextEncoder().encode("original index");
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "index.js",
      hostnames: ["site.localhost"],
      generation: "gen-assets",
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: true,
        mediaTypes: {
          "index.html": "application/vnd.takos.shell+html",
          "nested/app.css": "application/vnd.takos.theme",
        },
      },
    },
    MODULES,
    new Map([
      ["index.html", mutableIndex],
      ["nested/app.css", new TextEncoder().encode("body{}")],
    ]),
  );
  mutableIndex.fill(0);
  await runtime.reload();

  const manifest = JSON.parse(
    await readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8"),
  ) as { assets?: unknown };
  expect(manifest.assets).toEqual({
    storageLayout: "flat-ordinal-v1",
    notFoundHandling: "single-page-application",
    runWorkerFirst: true,
    files: {
      "index.html": {
        key: "asset-00000",
        mediaType: "application/vnd.takos.shell+html",
        size: new TextEncoder().encode("original index").byteLength,
        digest: await bytesDigest(new TextEncoder().encode("original index")),
      },
      "nested/app.css": {
        key: "asset-00001",
        mediaType: "application/vnd.takos.theme",
        size: new TextEncoder().encode("body{}").byteLength,
        digest: await bytesDigest(new TextEncoder().encode("body{}")),
      },
    },
  });
  expect(await readFile(join(root, "assets", "site", "asset-00000"), "utf8")).toBe(
    "original index",
  );

  const restarted = createWorkerdRuntime({ root, isReady: () => true });
  expect(await restarted.restore()).toEqual(["site"]);
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain('(name = "RUN_WORKER_FIRST", text = "true")');
  expect(config).toContain('(name = "NOT_FOUND", text = "single-page-application")');
  expect(config).toContain('(name = "site-asset-router", service = "site-asset-router")');
  const tenant = config
    .split(/^ {2}\( name = /mu)
    .find((service) => service.startsWith('"site"')) as string;
  expect(tenant).not.toContain('(name = "ASSETS"');
  expect(await restarted.has("site", "gen-assets")).toBe(true);
});

test("materializes underscore-prefixed and internal-dot asset paths in flat storage", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  const paths = ["_env", "dir/_x", "_well-known/nodeinfo.v1.json", "a/_hidden/main.js"] as const;
  const mediaTypes = Object.fromEntries(paths.map((path) => [path, "text/plain"]));
  const bytes = new Map<string, Uint8Array>(
    paths.map((path) => [path, new TextEncoder().encode(`asset:${path}`)] as const),
  );

  await runtime.write(
    "valid-path-assets",
    {
      directory: "valid-path-assets",
      mainModule: "index.js",
      hostnames: ["valid-path-assets.localhost"],
      assets: {
        notFoundHandling: "none",
        runWorkerFirst: false,
        mediaTypes,
      },
    },
    MODULES,
    bytes,
  );

  const manifest = JSON.parse(
    await readFile(join(root, "workers", "valid-path-assets", "takoserver-site.json"), "utf8"),
  ) as {
    assets: {
      storageLayout: string;
      files: Record<string, { key: string; mediaType: string; size: number; digest: string }>;
    };
  };
  expect(manifest.assets.storageLayout).toBe("flat-ordinal-v1");
  expect(Object.keys(manifest.assets.files).sort()).toEqual([...paths].sort());
  const sortedPaths = [...paths].sort();
  for (const [index, path] of sortedPaths.entries()) {
    expect(manifest.assets.files[path]?.key).toBe(`asset-${index.toString().padStart(5, "0")}`);
  }
  const physical = await readdir(join(root, "assets", "valid-path-assets"), {
    withFileTypes: true,
  });
  expect(physical.map((entry) => entry.name).sort()).toEqual([
    "asset-00000",
    "asset-00001",
    "asset-00002",
    "asset-00003",
  ]);
  expect(physical.every((entry) => entry.isFile())).toBe(true);
  expect(await readFile(join(root, "assets", "valid-path-assets", "asset-00000"), "utf8")).toBe(
    "asset:_env",
  );
});

test("generated asset routing treats valid URL misses separately from malformed paths", async () => {
  const assets = await generatedFetchWorker(ASSETS_SOURCE, "generated-assets.mjs");
  const fileRequests: string[] = [];
  const assetFiles: Record<string, { readonly body: string; readonly mediaType: string }> = {
    // The disk service emits octet-stream for files, including .json; the
    // declared manifest media type is applied by the asset layer itself.
    "asset-00000": { body: '{"links":[]}', mediaType: "application/octet-stream" },
    "asset-00001": { body: "<html>shell</html>", mediaType: "application/octet-stream" },
  };
  const assetManifest = {
    "nodeinfo.json": {
      key: "asset-00000",
      mediaType: "application/json",
    },
    "index.html": {
      key: "asset-00001",
      mediaType: "text/html",
    },
  };
  const assetEnv = {
    ASSET_MANIFEST: assetManifest,
    FILES: {
      async fetch(request: Request | string) {
        const requestUrl = typeof request === "string" ? request : request.url;
        const key = new URL(requestUrl).pathname.slice("/".length);
        fileRequests.push(key);
        const file = assetFiles[key];
        return file
          ? new Response(file.body, { status: 200, headers: { "content-type": file.mediaType } })
          : new Response(null, { status: 404 });
      },
    },
    NOT_FOUND: "none",
  };
  const declaredPath = await assets.fetch(
    new Request("https://assets.test/nodeinfo.json"),
    assetEnv,
  );
  expect(declaredPath.status).toBe(200);
  expect(declaredPath.headers.get("content-type")).toBe("application/json");
  expect(await declaredPath.text()).toBe('{"links":[]}');
  expect(fileRequests).toEqual(["asset-00000"]);

  for (const path of [
    "/日本語",
    "/missing/",
    "/.well-known/nodeinfo",
    "/.env",
    "/directory",
    "/a//b",
    `/${"a".repeat(241)}`,
  ]) {
    const miss = await assets.fetch(new Request(`https://assets.test${path}`), assetEnv);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("x-takoserver-selfhost-asset-miss")).toBe("1");
  }
  expect(fileRequests).toEqual(["asset-00000"]);

  for (const path of ["/bad%2Fname", "/bad%5Cname", "/%2e/secret", "/%2e%2e/secret", "/%E0%A4%A"]) {
    const malformed = await assets.fetch(rawRequest(`https://assets.test${path}`), assetEnv);
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get("x-takoserver-selfhost-asset-miss")).toBeNull();
  }
  expect(fileRequests).toEqual(["asset-00000"]);

  const spa = await generatedFetchWorker(ASSETS_SOURCE, "generated-spa-assets.mjs");
  const spaResponse = await spa.fetch(new Request("https://assets.test/日本語/"), {
    ...assetEnv,
    NOT_FOUND: "single-page-application",
  });
  expect(spaResponse.status).toBe(200);
  expect(await spaResponse.text()).toBe("<html>shell</html>");
  const dotPathSpaResponse = await spa.fetch(new Request("https://assets.test/.env"), {
    ...assetEnv,
    NOT_FOUND: "single-page-application",
  });
  expect(dotPathSpaResponse.status).toBe(200);
  expect(await dotPathSpaResponse.text()).toBe("<html>shell</html>");
  expect(fileRequests).toEqual(["asset-00000", "asset-00001", "asset-00001"]);

  const router = await generatedFetchWorker(ASSET_ROUTER_SOURCE, "generated-asset-router.mjs");
  const routerAssetRequests: string[] = [];
  let workerStatus = 404;
  const workerRequests: string[] = [];
  const routedEnv = {
    RUN_WORKER_FIRST: "false",
    ASSETS: {
      async fetch(request: Request) {
        routerAssetRequests.push(new URL(request.url).pathname);
        return await assets.fetch(request, assetEnv);
      },
    },
    WORKER: {
      async fetch(request: Request) {
        workerRequests.push(new URL(request.url).pathname);
        return new Response(workerStatus === 404 ? "app-404" : "app-ok", {
          status: workerStatus,
          headers: { "x-app": "preserved" },
        });
      },
    },
  };
  const assetFirst = await router.fetch(
    new Request("https://assets.test/nodeinfo.json"),
    routedEnv,
  );
  expect(assetFirst.status).toBe(200);
  expect(await assetFirst.text()).toBe('{"links":[]}');
  expect(workerRequests).toHaveLength(0);
  expect(routerAssetRequests).toEqual(["/nodeinfo.json"]);

  const appFallback = await router.fetch(new Request("https://assets.test/missing/"), routedEnv);
  expect(appFallback.status).toBe(404);
  expect(await appFallback.text()).toBe("app-404");
  expect(appFallback.headers.get("x-app")).toBe("preserved");
  expect(workerRequests).toEqual(["/missing/"]);

  routedEnv.RUN_WORKER_FIRST = "true";
  const workerFirstAsset = await router.fetch(
    new Request("https://assets.test/nodeinfo.json"),
    routedEnv,
  );
  expect(workerFirstAsset.status).toBe(200);
  expect(await workerFirstAsset.text()).toBe('{"links":[]}');
  expect(workerRequests).toEqual(["/missing/", "/nodeinfo.json"]);

  workerStatus = 200;
  const workerWins = await router.fetch(new Request("https://assets.test/missing"), routedEnv);
  expect(workerWins.status).toBe(200);
  expect(await workerWins.text()).toBe("app-ok");
  expect(routerAssetRequests).toHaveLength(3);
});

test("rejects unusable asset routing before damaging the active publication", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "index.js",
      hostnames: ["site.localhost"],
      assets: {
        notFoundHandling: "none",
        runWorkerFirst: false,
        mediaTypes: { "index.html": "text/html" },
      },
    },
    MODULES,
    new Map([["index.html", new TextEncoder().encode("old index")]]),
  );
  await runtime.reload();
  const beforeConfig = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  const beforeManifest = await readFile(
    join(root, "workers", "site", "takoserver-site.json"),
    "utf8",
  );
  const beforeIndex = await readFile(join(root, "assets", "site", "asset-00000"));

  const invalid: readonly {
    assets: NonNullable<Parameters<typeof runtime.write>[1]["assets"]>;
    bytes?: ReadonlyMap<string, Uint8Array>;
  }[] = [
    {
      assets: {
        notFoundHandling: "none",
        runWorkerFirst: false,
        mediaTypes: { "index.html": "text/html" },
      },
    },
    {
      assets: {
        notFoundHandling: "none",
        runWorkerFirst: false,
        mediaTypes: { "index.html": "text/html" },
      },
      bytes: new Map(),
    },
    {
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: false,
        mediaTypes: { "app.css": "text/css" },
      },
      bytes: new Map([["app.css", new TextEncoder().encode("body{}")]]),
    },
    {
      assets: {
        notFoundHandling: "none",
        runWorkerFirst: undefined as never,
        mediaTypes: { "index.html": "text/html" },
      },
      bytes: new Map([["index.html", new TextEncoder().encode("new index")]]),
    },
    {
      assets: {
        notFoundHandling: "none",
        runWorkerFirst: false,
        mediaTypes: { "../index.html": "text/html" },
      },
      bytes: new Map([["../index.html", new TextEncoder().encode("new index")]]),
    },
    ...[".", "..", "dir/./x", "dir/../x"].map((path) => ({
      assets: {
        notFoundHandling: "none" as const,
        runWorkerFirst: false,
        mediaTypes: { [path]: "text/plain" },
      },
      bytes: new Map([[path, new TextEncoder().encode("invalid asset")]]),
    })),
  ];
  for (const candidate of invalid) {
    await expect(
      runtime.write(
        "site",
        {
          directory: "site",
          mainModule: "index.js",
          hostnames: ["site.localhost"],
          assets: candidate.assets,
        },
        MODULES,
        candidate.bytes,
      ),
    ).rejects.toThrow();
    expect(await readFile(join(root, "workers", "workerd.capnp"), "utf8")).toBe(beforeConfig);
    expect(await readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8")).toBe(
      beforeManifest,
    );
    expect(await readFile(join(root, "assets", "site", "asset-00000"))).toEqual(beforeIndex);
  }
});

test("does not guess routing order for a retained legacy runtime manifest", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "index.js",
      hostnames: ["site.localhost"],
      assets: {
        notFoundHandling: "none",
        runWorkerFirst: false,
        mediaTypes: { "index.html": "text/html" },
      },
    },
    MODULES,
    new Map([["index.html", new TextEncoder().encode("index")]]),
  );
  const manifestPath = join(root, "workers", "site", "takoserver-site.json");
  const legacy = JSON.parse(await readFile(manifestPath, "utf8")) as {
    assets: { runWorkerFirst?: boolean };
  };
  delete legacy.assets.runWorkerFirst;
  await Bun.write(manifestPath, JSON.stringify(legacy));

  const reloaded: string[] = [];
  const restarted = createWorkerdRuntime({
    root,
    isReady: () => true,
    onReload: async (path) => {
      reloaded.push(path);
    },
  });
  expect(await restarted.restore()).toEqual([]);
  expect(reloaded).toEqual([]);
});

test("restart refuses unknown layout or media, duplicate mapping, and substituted asset bytes", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  for (const name of ["layout", "media", "mapping", "bytes"]) {
    await runtime.write(
      name,
      {
        directory: name,
        mainModule: "index.js",
        hostnames: [`${name}.localhost`],
        assets: {
          notFoundHandling: "none",
          runWorkerFirst: false,
          mediaTypes: { "one.txt": "text/plain", "two.txt": "text/plain" },
        },
      },
      MODULES,
      new Map([
        ["one.txt", new TextEncoder().encode("ONE")],
        ["two.txt", new TextEncoder().encode("TWO")],
      ]),
    );
  }

  const layoutPath = join(root, "workers", "layout", "takoserver-site.json");
  const layout = JSON.parse(await readFile(layoutPath, "utf8")) as {
    assets: { storageLayout?: string };
  };
  delete layout.assets.storageLayout;
  await Bun.write(layoutPath, JSON.stringify(layout));

  const mediaPath = join(root, "workers", "media", "takoserver-site.json");
  const media = JSON.parse(await readFile(mediaPath, "utf8")) as {
    assets: { files: Record<string, { mediaType?: string }> };
  };
  delete media.assets.files["one.txt"]?.mediaType;
  await Bun.write(mediaPath, JSON.stringify(media));

  const mappingPath = join(root, "workers", "mapping", "takoserver-site.json");
  const mapping = JSON.parse(await readFile(mappingPath, "utf8")) as {
    assets: { files: Record<string, { key: string }> };
  };
  (mapping.assets.files["two.txt"] as { key: string }).key = "asset-00000";
  await Bun.write(mappingPath, JSON.stringify(mapping));

  await Bun.write(join(root, "assets", "bytes", "asset-00000"), "TWO");
  const restarted = createWorkerdRuntime({ root, isReady: () => true });
  expect(await restarted.restore()).toEqual([]);
});

test("restart serves only exact provenance module inventories and bytes", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  const site = (name: string) => ({
    directory: name,
    mainModule: "entry.js",
    hostEntrypoint: "entry.js",
    hostnames: [`${name}.localhost`],
  });
  const application = new Map([
    ["entry.js", new TextEncoder().encode("export default { fetch() {} }")],
  ]);
  const hostPrivate = new Map([
    ["entry.js", new TextEncoder().encode('import app from "./entry.js"; export default app;')],
  ]);
  for (const name of ["good", "legacy", "application-bytes", "host-bytes", "extra-file"]) {
    await runtime.write(name, site(name), application, undefined, hostPrivate);
  }

  const legacyPath = join(root, "workers", "legacy", "takoserver-site.json");
  const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as {
    moduleStorageLayout?: string;
  };
  delete legacy.moduleStorageLayout;
  await Bun.write(legacyPath, JSON.stringify(legacy));
  await Bun.write(
    join(root, "workers", "application-bytes", "application", "module-00000"),
    "substituted application",
  );
  await Bun.write(
    join(root, "workers", "host-bytes", "host-private", "module-00000"),
    "substituted Host module",
  );
  await Bun.write(
    join(root, "workers", "extra-file", "host-private", "module-99999"),
    "unexpected",
  );

  const restarted = createWorkerdRuntime({ root, isReady: () => true });
  expect(await restarted.restore()).toEqual(["good"]);
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain('name = "good"');
  for (const name of ["legacy", "application-bytes", "host-bytes", "extra-file"]) {
    expect(config).not.toContain(`name = "${name}"`);
  }
});

async function publish(vars?: readonly WorkerdBinding[]): Promise<string> {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "site",
    {
      directory: "site",
      mainModule: "index.js",
      hostnames: ["site.localhost"],
      generation: "gen-1",
      ...(vars ? { vars } : {}),
    },
    MODULES,
  );
  await runtime.reload();
  return await readFile(join(root, "workers", "workerd.capnp"), "utf8");
}

test("renders text and json bindings the module can read", async () => {
  const config = await publish([
    { name: "LANE", value: "takoform-v1", kind: "text" },
    { name: "LIMITS", value: '{"retries":3}', kind: "json" },
  ]);
  expect(config).toContain('(name = "LANE", text = "takoform-v1")');
  expect(config).toContain('(name = "LIMITS", json = "{\\"retries\\":3}")');
});

test("a script that declares no binding does not invent one", async () => {
  const without = await publish();
  const empty = await publish([]);
  expect(withoutPrivateRuntimeTokens(empty)).toBe(withoutPrivateRuntimeTokens(without));
  // The script's own service block, as distinct from the router's, still names
  // no bindings at all.
  expect(without).toContain(
    'role = application) ],\n      modulePolicy = (applicationMain = "index.js"),\n      compatibilityDate = "2026-01-01",',
  );
});

test("escapes every character that could end the literal or the line", async () => {
  const value = 'quote " backslash \\ newline\n tab\t bell\x07 unit\x1f delete\x7f é 😀';
  const config = await publish([{ name: "AWKWARD", value, kind: "text" }]);
  const rendered = /\(name = "AWKWARD", text = ("(?:[^"\\]|\\.)*")\)/u.exec(config)?.[1];
  expect(rendered).toBe(
    '"quote \\" backslash \\\\ newline\\n tab\\t bell\\x07 unit\\x1f delete\\x7f é 😀"',
  );
  // Nothing after the value leaked out of its literal: the script's binding
  // list still closes where it should, and the router's list is untouched.
  expect(config).toContain(`bindings = [ (name = "AWKWARD", text = ${rendered}) ],`);
});

test("refuses a binding name it would otherwise have to mangle", async () => {
  for (const name of ["", "1LEADING", "has space", "has$dollar", "a".repeat(129)]) {
    await expect(publish([{ name, value: "x", kind: "text" }])).rejects.toThrow(
      "unusable worker binding",
    );
  }
});

test("refuses a duplicate binding name rather than letting one win silently", async () => {
  await expect(
    publish([
      { name: "SAME", value: "first", kind: "text" },
      { name: "SAME", value: "second", kind: "text" },
    ]),
  ).rejects.toThrow("unusable worker binding");
});

test("refuses a value capnp text cannot carry", async () => {
  await expect(publish([{ name: "NUL", value: "a\u0000b", kind: "text" }])).rejects.toThrow(
    "unusable worker binding value",
  );
  await expect(publish([{ name: "LONE", value: "a\ud800", kind: "text" }])).rejects.toThrow(
    "unusable worker binding value",
  );
});

test("writes the configuration and the manifest so only the operator can read them", async () => {
  await publish([{ name: "SECRET_SHAPED", value: "value", kind: "text" }]);
  const config = await stat(join(root, "workers", "workerd.capnp"));
  const manifest = await stat(join(root, "workers", "site", "takoserver-site.json"));
  const directory = await stat(join(root, "workers", "site"));
  expect(config.mode & 0o777).toBe(0o600);
  expect(manifest.mode & 0o777).toBe(0o600);
  expect(directory.mode & 0o777).toBe(0o700);
});

test("skips a published script whose recorded bindings cannot be rendered", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "good",
    { directory: "good", mainModule: "index.js", hostnames: ["good.localhost"] },
    MODULES,
  );
  await runtime.write(
    "broken",
    { directory: "broken", mainModule: "index.js", hostnames: ["broken.localhost"] },
    MODULES,
  );
  await Bun.write(
    join(root, "workers", "broken", "takoserver-site.json"),
    JSON.stringify({
      mainModule: "index.js",
      hostnames: ["broken.localhost"],
      vars: [{ name: "not a name", value: "x", kind: "text" }],
    }),
  );
  await runtime.reload();
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain('name = "good"');
  expect(config).not.toContain('name = "broken"');
});

test("skips a published script whose recorded binding value cannot be rendered", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  await runtime.write(
    "good",
    { directory: "good", mainModule: "index.js", hostnames: ["good.localhost"] },
    MODULES,
  );
  await runtime.write(
    "broken",
    { directory: "broken", mainModule: "index.js", hostnames: ["broken.localhost"] },
    MODULES,
  );
  // The name is valid, so the earlier guard passes; only rendering the value
  // refuses. On disk this is a torn write or a tampered manifest, which the
  // write path itself can never produce.
  await Bun.write(
    join(root, "workers", "broken", "takoserver-site.json"),
    JSON.stringify({
      mainModule: "index.js",
      hostnames: ["broken.localhost"],
      vars: [{ name: "TORN", value: "a\u0000b", kind: "text" }],
    }),
  );
  await runtime.reload();
  const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(config).toContain('name = "good"');
  expect(config).not.toContain('name = "broken"');
});

test("tightens a scripts tree an older tree left group- or world-readable", async () => {
  // `mkdir(mode)` is a no-op on a directory that already exists, so an upgraded
  // deployment kept whatever `workers/` and its script directories were made
  // with. The rendered config and every manifest under them carry binding
  // values, so publishing repairs the mode rather than inheriting it.
  await mkdir(join(root, "workers", "site"), { recursive: true, mode: 0o755 });
  await chmod(join(root, "workers", "site"), 0o777);
  await chmod(join(root, "workers"), 0o755);

  await publish([{ name: "SECRET_SHAPED", value: "value", kind: "text" }]);

  expect((await stat(join(root, "workers"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, "workers", "site"))).mode & 0o777).toBe(0o700);
});

/**
 * A restarted self-host brings its own Workers back.
 *
 * `workerd` was started by a publication and by nothing else, so a machine that
 * restarted served nothing at all — while its control plane reported healthy
 * and `tofu plan` answered "No changes. Your infrastructure matches the
 * configuration". Every resource was observed Ready and no request could reach
 * any Worker; a read or a refresh did not revive it, only a fresh publication
 * did. So the boot asks the durable manifests what this machine had published
 * and renders the configuration again for them.
 */
test("restores the runtime from what a previous process published", async () => {
  const probe = createConfigProbe();
  try {
    const published = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    await published.write(
      "site",
      {
        directory: "site",
        mainModule: "index.js",
        hostnames: ["site.localhost"],
        generation: "gen-1",
      },
      MODULES,
    );
    await published.reload();
    const before = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    // The next process: a new runtime over the same data directory, told nothing.
    const reloaded: string[] = [];
    const restarted = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: async (configPath) => {
        reloaded.push(configPath);
        await probe.onReload(configPath);
      },
    });
    expect(await restarted.restore()).toEqual(["site"]);
    // The runtime was actually started, against the configuration this build
    // renders rather than whichever one happened to be on disk.
    expect(reloaded).toEqual([join(root, "workers", "workerd.capnp")]);
    const after = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(withoutPrivateRuntimeTokens(after)).toBe(withoutPrivateRuntimeTokens(before));
    expect(await restarted.has("site", "gen-1")).toBe(true);
  } finally {
    probe.stop();
  }
});

test("starts nothing on a machine that has published no Worker", async () => {
  const reloaded: string[] = [];
  const runtime = createWorkerdRuntime({
    root,
    isReady: () => true,
    onReload: async (configPath) => {
      reloaded.push(configPath);
    },
  });
  expect(await runtime.restore()).toEqual([]);
  // No configuration, and above all no runtime: a machine that never runs a
  // Worker must not be given a workerd to run one in.
  expect(reloaded).toEqual([]);
  await expect(readFile(join(root, "workers", "workerd.capnp"), "utf8")).rejects.toThrow();
});

test("keeps weighted readiness private from public and service-binding requests", async () => {
  const outer = await generatedFetchWorker(ROUTER_SOURCE, "generated-router.mjs");
  const deployment = await generatedFetchWorker(
    DEPLOYMENT_ROUTER_SOURCE,
    "generated-deployment-router.mjs",
  );
  const capabilityHeader = "x-takoserver-selfhost-runtime-readiness";
  const capability = "f".repeat(64);
  const tenantRequests: Request[] = [];
  const readinessRequests: Request[] = [];
  const tenant = (name: string) => ({
    async fetch(request: Request) {
      tenantRequests.push(request);
      return new Response(`${name}:${await request.text()}`);
    },
  });
  const ready = (publication: string) => ({
    async fetch(request: Request) {
      readinessRequests.push(request);
      return Response.json({
        schema: "takoserver.selfhost-worker-readiness-result@v1",
        publication,
      });
    },
  });
  const deploymentEnv = {
    INTERNAL_HOSTNAME: "site.selfhost-internal.invalid",
    INTERNAL_READINESS_CAPABILITY: capability,
    PUBLICATION: "logical-publication",
    VERSIONS: [
      {
        binding: "VERSION_00000",
        readinessBinding: "READINESS_00000",
        versionId: "version-a",
        weight: 1,
      },
      {
        binding: "VERSION_00001",
        readinessBinding: "READINESS_00001",
        versionId: "version-b",
        weight: 9_999,
      },
    ],
    VERSION_00000: tenant("a"),
    VERSION_00001: tenant("b"),
    READINESS_00000: ready("version-a"),
    READINESS_00001: ready("version-b"),
  };
  const logical = {
    fetch: (request: Request) => deployment.fetch(request, deploymentEnv),
  };
  const outerEnv = {
    CONFIG_IDENTITY: "identity",
    CONFIG_PROBE_TOKEN: "",
    INTERNAL_READINESS_CAPABILITY: capability,
    INTERNAL_READINESS_ROUTES: JSON.stringify({
      "site.selfhost-internal.invalid": "logical",
    }),
    ROUTES: JSON.stringify({
      "customer.test": "logical",
      "site.selfhost-internal.invalid": "logical",
    }),
    logical,
  };
  const magicHeaders = {
    "x-takoserver-selfhost-readiness": "takoserver.selfhost-worker-readiness@v1",
  };
  const path = "/.well-known/takoserver/selfhost-worker-readiness/v1";

  // A public endpoint request with the reserved method/path/header remains an
  // ordinary tenant fetch and samples exactly one Version.
  const publicAnswer = await outer.fetch(
    new Request(`https://customer.test${path}`, {
      method: "POST",
      headers: magicHeaders,
      body: "public",
    }),
    outerEnv,
  );
  expect(await publicAnswer.text()).toMatch(/^[ab]:public$/u);
  expect(tenantRequests).toHaveLength(1);
  expect(readinessRequests).toHaveLength(0);
  expect(tenantRequests[0]?.headers.get(capabilityHeader)).toBeNull();

  // A worker.service caller reaches the deployment router directly and can
  // spoof its URL and public headers, but not this Host's private capability.
  const serviceAnswer = await deployment.fetch(
    new Request(`https://site.selfhost-internal.invalid${path}`, {
      method: "POST",
      headers: magicHeaders,
      body: "service",
    }),
    deploymentEnv,
  );
  expect(await serviceAnswer.text()).toMatch(/^[ab]:service$/u);
  expect(tenantRequests).toHaveLength(2);
  expect(readinessRequests).toHaveLength(0);
  expect(tenantRequests[1]?.headers.get(capabilityHeader)).toBeNull();

  const guessedServiceAnswer = await deployment.fetch(
    new Request(`https://site.selfhost-internal.invalid${path}`, {
      method: "POST",
      headers: { ...magicHeaders, [capabilityHeader]: "not-the-capability" },
    }),
    deploymentEnv,
  );
  expect(guessedServiceAnswer.status).toBe(404);
  expect(tenantRequests).toHaveLength(2);
  expect(readinessRequests).toHaveLength(0);

  // Only the loopback runtime probe supplies the private marker on the exact
  // Host-owned route. That one question fans out across every Version.
  const internalAnswer = await outer.fetch(
    new Request(`https://site.selfhost-internal.invalid${path}`, {
      method: "POST",
      headers: { ...magicHeaders, [capabilityHeader]: capability },
      body: "internal",
    }),
    outerEnv,
  );
  expect(internalAnswer.status).toBe(200);
  expect(await internalAnswer.json()).toEqual({
    schema: "takoserver.selfhost-worker-readiness-result@v1",
    publication: "logical-publication",
  });
  expect(tenantRequests).toHaveLength(2);
  expect(readinessRequests).toHaveLength(2);
});

test("publishes one canonical immutable weighted graph and retains old generations", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  await runtime.publish("site", weightedPublication("site", "generation-1"));

  const pointerPath = join(root, "workers", "site", "takoserver-site.json");
  const firstPointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
    generation: string;
    generationKey: string;
  };
  const firstRoot = join(root, "workers", ".publications", "site", firstPointer.generationKey);
  const firstManifest = await readFile(join(firstRoot, "deployment.json"), "utf8");
  const parsed = JSON.parse(firstManifest) as {
    versions: Array<{ versionId: string; workerVersionUid: string; weight: number }>;
  };
  expect(parsed.versions.map(({ workerVersionUid }) => workerVersionUid)).toEqual([
    "uid-WorkerVersion-site-a",
    "uid-WorkerVersion-site-b",
  ]);
  expect(parsed.versions.map(({ versionId, weight }) => ({ versionId, weight }))).toEqual([
    { versionId: "site-v-a", weight: 1 },
    { versionId: "site-v-b", weight: 9_999 },
  ]);
  const firstModule = await readFile(
    join(firstRoot, "version-00000", "application", "module-00000"),
  );
  const firstConfig = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
  expect(configRoutes(firstConfig)).toMatchObject({
    "site.localhost": "site-selfhost-deployment",
  });
  expect(firstConfig).toContain('(name = "VERSIONS", json =');
  expect(configRoutes(firstConfig)["site.localhost"]).not.toStartWith("selfhost-version-");

  await runtime.publish("site", weightedPublication("site", "generation-2", [10_000 - 1, 1]));
  const secondPointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
    generation: string;
    generationKey: string;
  };
  expect(secondPointer.generation).toBe("generation-2");
  expect(secondPointer.generationKey).not.toBe(firstPointer.generationKey);
  expect(await readFile(join(firstRoot, "deployment.json"), "utf8")).toBe(firstManifest);
  expect(await readFile(join(firstRoot, "version-00000", "application", "module-00000"))).toEqual(
    firstModule,
  );

  const restarted = createWorkerdRuntime({ root, isReady: () => true });
  expect(await restarted.restore()).toEqual(["site"]);
  expect(await restarted.has("site", "generation-2")).toBe(true);
  await runtime.publish("site", null);
  await expect(readFile(pointerPath, "utf8")).rejects.toThrow();
  // Deactivation removes only the stable pointer. The immutable payload may
  // still back an in-flight request and has no safe eager-GC process boundary.
  expect(await readFile(join(firstRoot, "deployment.json"), "utf8")).toBe(firstManifest);
});

test("rejects a bad later weighted variant before staging any publication", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  const publication = weightedPublication("site", "generation-bad");
  const broken: WorkerdDeploymentPublication = {
    ...publication,
    versions: publication.versions.map((version, index) =>
      index === 1 ? { ...version, modules: new Map() } : version,
    ),
  };
  await expect(runtime.publish("site", broken)).rejects.toThrow(
    "unusable application worker module snapshot",
  );
  await expect(
    readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8"),
  ).rejects.toThrow();
  await expect(
    readFile(join(root, "workers", ".publications", "site", "deployment.json"), "utf8"),
  ).rejects.toThrow();
  await expect(readFile(join(root, "workers", "workerd.capnp"), "utf8")).rejects.toThrow();
});

test("restores and proves the prior graph when a watcher loaded a failed activation", async () => {
  const probe = createConfigProbe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    await runtime.publish("site", weightedPublication("site", "generation-1"));
    const pointerPath = join(root, "workers", "site", "takoserver-site.json");
    const beforePointer = await readFile(pointerPath, "utf8");
    const beforeConfig = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    probe.behavior = (_config, invocation) => {
      // The emulator has already made the new graph live. A throwing hook is
      // therefore not evidence that workerd stayed on the old graph.
      if (invocation === 2) throw new Error("reload acknowledgement failed");
    };

    await expect(
      runtime.publish("site", weightedPublication("site", "generation-2", [9_999, 1])),
    ).rejects.toThrow("reload acknowledgement failed");
    expect(await readFile(pointerPath, "utf8")).toBe(beforePointer);
    // The private probe token is stable for this runtime, so exact graph
    // rollback restores byte-for-byte configuration as well as the pointer.
    expect(await readFile(join(root, "workers", "workerd.capnp"), "utf8")).toBe(beforeConfig);
    expect(await runtime.has("site", "generation-1")).toBe(true);
    expect(await runtime.has("site", "generation-2")).toBe(false);
  } finally {
    probe.stop();
  }
});

test("event readback is indeterminate while a weighted graph crosses its pointer", async () => {
  const probe = createConfigProbe();
  const loaded = deferred();
  const release = deferred();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    await runtime.publish("site", weightedPublication("site", "generation-1"));
    probe.behavior = async (_config, invocation) => {
      if (invocation !== 2) return;
      loaded.resolve();
      await release.promise;
    };

    const publishing = runtime.publish(
      "site",
      weightedPublication("site", "generation-2", [9_999, 1]),
    );
    await loaded.promise;
    expect(await readWorkerdActiveDeployment(root, "site")).toBeNull();
    release.resolve();
    await publishing;
    expect(await readWorkerdActiveDeployment(root, "site")).toMatchObject({
      generation: "generation-2",
      versions: [
        { workerVersionUid: "uid-WorkerVersion-site-a", weight: 9_999 },
        { workerVersionUid: "uid-WorkerVersion-site-b", weight: 1 },
      ],
    });
  } finally {
    release.resolve();
    probe.stop();
  }
});

test("clears activation truth when neither the forward nor rollback graph is proven", async () => {
  const probe = createConfigProbe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    await runtime.publish("site", weightedPublication("site", "generation-1"));
    probe.behavior = (_config, invocation) => {
      if (invocation >= 2) throw new Error("watcher state is unknown");
    };

    await expect(
      runtime.publish("site", weightedPublication("site", "generation-2", [9_999, 1])),
    ).rejects.toThrow("worker runtime activation state is unknown");
    expect(
      JSON.parse(await readFile(join(root, "workers", ".takoserver-active.json"), "utf8")),
    ).toEqual({});
    expect(await runtime.has("site", "generation-1")).toBe(false);
    expect(await runtime.has("site", "generation-2")).toBe(false);
  } finally {
    probe.stop();
  }
});

test("derives rollback markers from the exact graph proved after a stale-marker restart", async () => {
  const probe = createConfigProbe();
  try {
    const published = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    if (!published.publish) throw new Error("weighted publication is unavailable");
    await published.publish("site", weightedPublication("site", "generation-1"));
    await published.publish("site", weightedPublication("site", "generation-2", [9_999, 1]));
    // Exact crash window: the stable pointer names generation 2, while the
    // marker still contains the last generation whose receipt was durable.
    await Bun.write(
      join(root, "workers", ".takoserver-active.json"),
      JSON.stringify({ site: "generation-1" }),
    );
    let failForward = true;
    probe.behavior = () => {
      if (failForward) {
        failForward = false;
        throw new Error("restore acknowledgement failed after load");
      }
    };

    const restarted = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    await expect(restarted.restore()).rejects.toThrow("restore acknowledgement failed after load");
    expect(
      JSON.parse(await readFile(join(root, "workers", ".takoserver-active.json"), "utf8")),
    ).toEqual({ site: "generation-2" });
    expect(await restarted.has("site", "generation-2")).toBe(true);
    expect(await restarted.has("site", "generation-1")).toBe(false);
  } finally {
    probe.stop();
  }
});

test("serializes shared config commit and rollback across two Worker publications", async () => {
  const probe = createConfigProbe();
  const betaLoaded = deferred();
  const letBetaCommit = deferred();
  let heldBeta = false;
  probe.behavior = async (config) => {
    const routes = configRoutes(config);
    const alpha = Object.hasOwn(routes, "alpha.localhost");
    const beta = Object.hasOwn(routes, "beta.localhost");
    if (beta && !alpha && !heldBeta) {
      heldBeta = true;
      betaLoaded.resolve();
      await letBetaCommit.promise;
    }
    if (alpha) throw new Error("alpha activation failed after load");
  };
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    const beta = runtime.publish("beta", weightedPublication("beta", "beta-generation"));
    await betaLoaded.promise;
    const alpha = runtime.publish("alpha", weightedPublication("alpha", "alpha-generation"));
    letBetaCommit.resolve();
    await beta;
    await expect(alpha).rejects.toThrow("alpha activation failed after load");

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(configRoutes(config)).toMatchObject({
      "beta.localhost": "beta-selfhost-deployment",
    });
    expect(configRoutes(config)).not.toHaveProperty("alpha.localhost");
    expect(await runtime.has("beta", "beta-generation")).toBe(true);
    expect(await runtime.has("alpha", "alpha-generation")).toBe(false);
    expect(
      JSON.parse(await readFile(join(root, "workers", ".takoserver-active.json"), "utf8")),
    ).toEqual({ beta: "beta-generation" });
    expect(await readFile(join(root, "workers", "beta", "takoserver-site.json"), "utf8")).toContain(
      "beta-generation",
    );
    await expect(
      readFile(join(root, "workers", "alpha", "takoserver-site.json"), "utf8"),
    ).rejects.toThrow();
  } finally {
    letBetaCommit.resolve();
    probe.stop();
  }
});

test("reads exactly one selected Version at weighted boundaries", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  await runtime.publish("site", weightedPublication("site", "generation-1"));

  const first = await readWorkerdSelectedActiveVersion(root, "site", {
    expectedWorkerResourceUid: "uid-ModuleWorker-site",
    basisPoint: 0,
  });
  const second = await readWorkerdSelectedActiveVersion(root, "site", {
    expectedWorkerResourceUid: "uid-ModuleWorker-site",
    basisPoint: 1,
  });
  if (!first || !second) throw new Error("active Version snapshot is unavailable");
  expect(first.versionId).toBe("site-v-a");
  expect(first.workerVersionUid).toBe("uid-WorkerVersion-site-a");
  expect(first.workerResourceUid).toBe("uid-ModuleWorker-site");
  expect(first.generation).toBe("generation-1");
  expect(first.generationKey).toMatch(/^[0-9a-f]{64}$/u);
  expect(second.versionId).toBe("site-v-b");
  expect([...first.modules.keys()]).toEqual(["index.js"]);
  expect([...first.hostModules.keys()]).toEqual([HOST_ENTRYPOINT]);
  expect(first.site).toMatchObject({
    directory: "site",
    mainModule: "index.js",
    hostEntrypoint: HOST_ENTRYPOINT,
    hostnames: [],
    generation: "generation-1",
    workerResourceUid: "uid-ModuleWorker-site",
    fetchHandler: true,
  });
});

test("reads the fresh active generation and never selects a legacy scalar", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  await runtime.publish("site", weightedPublication("site", "generation-1"));
  const first = await readWorkerdSelectedActiveVersion(root, "site", {
    expectedWorkerResourceUid: "uid-ModuleWorker-site",
    basisPoint: 5_000,
  });
  if (!first) throw new Error("first active Version snapshot is unavailable");

  await runtime.publish("site", weightedPublication("site", "generation-2", [9_999, 1]));
  const second = await readWorkerdSelectedActiveVersion(root, "site", {
    expectedWorkerResourceUid: "uid-ModuleWorker-site",
    basisPoint: 5_000,
  });
  if (!second) throw new Error("second active Version snapshot is unavailable");
  expect(first.generation).toBe("generation-1");
  expect(second.generation).toBe("generation-2");
  expect(second.generationKey).not.toBe(first.generationKey);
  expect(first.versionId).toBe("site-v-b");
  expect(second.versionId).toBe("site-v-a");

  const scalar = weightedPublication("site", "scalar-generation").versions[0];
  if (!scalar) throw new Error("scalar fixture is unavailable");
  await runtime.write(
    "scalar",
    {
      ...scalar.site,
      directory: "scalar",
      workerResourceUid: "uid-ModuleWorker-scalar",
      hostnames: ["scalar.localhost"],
    },
    scalar.modules,
    undefined,
    scalar.hostModules,
  );
  await runtime.reload();
  // The scalar carrier has no weighted publication pointer. The weighted-only
  // reader refuses it rather than selecting its one module implicitly.
  await expect(
    readWorkerdSelectedActiveVersion(root, "scalar", {
      expectedWorkerResourceUid: "uid-ModuleWorker-scalar",
      basisPoint: 0,
    }),
  ).rejects.toThrow("unusable worker active version snapshot");
});

test("returns null while a weighted activation is crossing", async () => {
  const probe = createConfigProbe();
  const loaded = deferred();
  const release = deferred();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    await runtime.publish("site", weightedPublication("site", "generation-1"));
    probe.behavior = async (_config, invocation) => {
      if (invocation !== 2) return;
      loaded.resolve();
      await release.promise;
    };
    const publishing = runtime.publish(
      "site",
      weightedPublication("site", "generation-2", [9_999, 1]),
    );
    await loaded.promise;
    expect(
      await readWorkerdSelectedActiveVersion(root, "site", {
        expectedWorkerResourceUid: "uid-ModuleWorker-site",
        basisPoint: 0,
      }),
    ).toBeNull();
    release.resolve();
    await publishing;
    expect(
      await readWorkerdSelectedActiveVersion(root, "site", {
        expectedWorkerResourceUid: "uid-ModuleWorker-site",
        basisPoint: 0,
      }),
    ).toMatchObject({ generation: "generation-2", versionId: "site-v-a" });
  } finally {
    release.resolve();
    probe.stop();
  }
});

test("keeps the prior selected Version after a failed activation rolls back", async () => {
  const probe = createConfigProbe();
  try {
    const runtime = createWorkerdRuntime({
      root,
      port: probe.port,
      isReady: () => true,
      onReload: probe.onReload,
    });
    if (!runtime.publish) throw new Error("weighted publication is unavailable");
    await runtime.publish("site", weightedPublication("site", "generation-1"));
    probe.behavior = (_config, invocation) => {
      if (invocation === 2) throw new Error("activation acknowledgement failed");
    };
    await expect(
      runtime.publish("site", weightedPublication("site", "generation-2", [9_999, 1])),
    ).rejects.toThrow("activation acknowledgement failed");
    expect(
      await readWorkerdSelectedActiveVersion(root, "site", {
        expectedWorkerResourceUid: "uid-ModuleWorker-site",
        basisPoint: 0,
      }),
    ).toMatchObject({ generation: "generation-1", versionId: "site-v-a" });
  } finally {
    probe.stop();
  }
});

test("rejects a stale expected Worker UID before reading a selected Version", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  await runtime.publish("site", weightedPublication("site", "generation-1"));
  expect(
    await readWorkerdSelectedActiveVersion(root, "site", {
      expectedWorkerResourceUid: "uid-ModuleWorker-other",
      basisPoint: 0,
    }),
  ).toBeNull();
});

test("captures and verifies selected application, Host-private, and asset bytes", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  const base = weightedPublication("site", "generation-assets");
  const publication: WorkerdDeploymentPublication = {
    ...base,
    versions: base.versions.map((version) => ({
      ...version,
      site: {
        ...version.site,
        vars: [{ name: "SECRET_VALUE", value: "durable-secret", kind: "text" }],
        assets: {
          notFoundHandling: "none",
          runWorkerFirst: false,
          mediaTypes: { "index.html": "text/html" },
        },
      },
      assets: new Map([["index.html", new TextEncoder().encode("<h1>site</h1>")]]),
    })),
  };
  await runtime.publish("site", publication);
  const pointer = JSON.parse(
    await readFile(join(root, "workers", "site", "takoserver-site.json"), "utf8"),
  ) as { generationKey: string };
  const versionRoot = join(
    root,
    "workers",
    ".publications",
    "site",
    pointer.generationKey,
    "version-00000",
  );
  const applicationPath = join(versionRoot, "application", "module-00000");
  const hostPath = join(versionRoot, "host-private", "module-00000");
  const assetPath = join(versionRoot, "assets", "asset-00000");
  const applicationBytes = await readFile(applicationPath);
  const hostBytes = await readFile(hostPath);
  const assetBytes = await readFile(assetPath);
  const snapshot = await readWorkerdSelectedActiveVersion(root, "site", {
    expectedWorkerResourceUid: "uid-ModuleWorker-site",
    basisPoint: 0,
  });
  if (!snapshot) throw new Error("asset Version snapshot is unavailable");
  expect(snapshot.site.vars).toEqual([
    { name: "SECRET_VALUE", value: "durable-secret", kind: "text" },
  ]);
  expect(snapshot.site.assets).toEqual({
    notFoundHandling: "none",
    runWorkerFirst: false,
    mediaTypes: { "index.html": "text/html" },
  });
  expect(new TextDecoder().decode(snapshot.modules.get("index.js"))).toContain("site-a");
  expect(new TextDecoder().decode(snapshot.hostModules.get(HOST_ENTRYPOINT))).toContain(
    "./index.js",
  );
  expect(new TextDecoder().decode(snapshot.assets?.get("index.html"))).toBe("<h1>site</h1>");
  const capturedApplication = new Uint8Array(snapshot.modules.get("index.js") as Uint8Array);
  const capturedHost = new Uint8Array(snapshot.hostModules.get(HOST_ENTRYPOINT) as Uint8Array);
  const capturedAsset = new Uint8Array(snapshot.assets?.get("index.html") as Uint8Array);

  await writeFile(applicationPath, new TextEncoder().encode("tampered application"));
  await expect(
    readWorkerdSelectedActiveVersion(root, "site", {
      expectedWorkerResourceUid: "uid-ModuleWorker-site",
      basisPoint: 0,
    }),
  ).rejects.toThrow("unusable worker active version snapshot");
  expect(snapshot.modules.get("index.js")).toEqual(capturedApplication);
  expect(snapshot.hostModules.get(HOST_ENTRYPOINT)).toEqual(capturedHost);
  expect(snapshot.assets?.get("index.html")).toEqual(capturedAsset);
  await writeFile(applicationPath, applicationBytes);

  await writeFile(hostPath, new TextEncoder().encode("tampered host"));
  await expect(
    readWorkerdSelectedActiveVersion(root, "site", {
      expectedWorkerResourceUid: "uid-ModuleWorker-site",
      basisPoint: 0,
    }),
  ).rejects.toThrow("unusable worker active version snapshot");
  expect(snapshot.modules.get("index.js")).toEqual(capturedApplication);
  expect(snapshot.hostModules.get(HOST_ENTRYPOINT)).toEqual(capturedHost);
  expect(snapshot.assets?.get("index.html")).toEqual(capturedAsset);
  await writeFile(hostPath, hostBytes);

  await writeFile(assetPath, new TextEncoder().encode("tampered asset"));
  await expect(
    readWorkerdSelectedActiveVersion(root, "site", {
      expectedWorkerResourceUid: "uid-ModuleWorker-site",
      basisPoint: 0,
    }),
  ).rejects.toThrow("unusable worker active version snapshot");
  expect(snapshot.modules.get("index.js")).toEqual(capturedApplication);
  expect(snapshot.hostModules.get(HOST_ENTRYPOINT)).toEqual(capturedHost);
  expect(snapshot.assets?.get("index.html")).toEqual(capturedAsset);
  await writeFile(assetPath, assetBytes);
});

test("returns an owned logical graph with frozen bytes, vars, and namespaces", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  const sharedName = "shared-entry.js";
  const applicationSource = new TextEncoder().encode("export const owner = 'application';");
  const hostSource = new TextEncoder().encode("export const owner = 'host-private';");
  const base = weightedPublication("site", "generation-owned");
  const publication: WorkerdDeploymentPublication = {
    ...base,
    versions: base.versions.map((version) => ({
      ...version,
      site: {
        ...version.site,
        mainModule: sharedName,
        hostEntrypoint: sharedName,
        vars: [{ name: "SECRET_VALUE", value: "owned-value", kind: "text" }],
      },
      modules: new Map([[sharedName, applicationSource]]),
      hostModules: new Map([[sharedName, hostSource]]),
    })),
  };
  await runtime.publish("site", publication);
  const snapshot = await readWorkerdSelectedActiveVersion(root, "site", {
    expectedWorkerResourceUid: "uid-ModuleWorker-site",
    basisPoint: 0,
  });
  if (!snapshot) throw new Error("owned Version snapshot is unavailable");
  const expectedApplication = new Uint8Array(applicationSource);
  const expectedHost = new Uint8Array(hostSource);
  expect(snapshot.modules.get(sharedName)).toEqual(expectedApplication);
  expect(snapshot.hostModules.get(sharedName)).toEqual(expectedHost);
  expect(snapshot.site.vars).toEqual([
    { name: "SECRET_VALUE", value: "owned-value", kind: "text" },
  ]);
  expect([...snapshot.modules.keys()]).toEqual([sharedName]);
  expect([...snapshot.hostModules.keys()]).toEqual([sharedName]);
  expect(JSON.stringify(snapshot.site)).not.toContain("module-00000");
  expect(JSON.stringify(snapshot.site)).not.toContain(".publications");
  expect(JSON.stringify(snapshot.site)).not.toContain("storageKey");

  const mutableApplication = snapshot.modules.get(sharedName);
  if (!mutableApplication) throw new Error("application bytes are unavailable");
  mutableApplication.fill(0);
  (snapshot.site.vars as Array<{ name: string; value: string; kind: "text" | "json" }>)[0]!.value =
    "caller-mutated";
  const sameGeneration = await readWorkerdSelectedActiveVersion(root, "site", {
    expectedWorkerResourceUid: "uid-ModuleWorker-site",
    basisPoint: 0,
  });
  if (!sameGeneration) throw new Error("same-generation snapshot is unavailable");
  expect(sameGeneration.modules.get(sharedName)).toEqual(expectedApplication);
  expect(sameGeneration.hostModules.get(sharedName)).toEqual(expectedHost);
  expect(sameGeneration.site.vars).toEqual([
    { name: "SECRET_VALUE", value: "owned-value", kind: "text" },
  ]);

  await runtime.publish("site", weightedPublication("site", "generation-owned-next"));
  expect(sameGeneration.modules.get(sharedName)).toEqual(expectedApplication);
  expect(sameGeneration.hostModules.get(sharedName)).toEqual(expectedHost);
  expect(sameGeneration.site.vars).toEqual([
    { name: "SECRET_VALUE", value: "owned-value", kind: "text" },
  ]);

  const fresh = await readWorkerdSelectedActiveVersion(root, "site", {
    expectedWorkerResourceUid: "uid-ModuleWorker-site",
    basisPoint: 0,
  });
  if (!fresh) throw new Error("fresh Version snapshot is unavailable");
  expect(fresh.modules.get("index.js")).toBeDefined();
  expect(fresh.site.vars).toBeUndefined();
});
