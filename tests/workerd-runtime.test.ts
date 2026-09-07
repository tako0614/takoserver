import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { createWorkerdRuntime, type WorkerdBinding } from "../src/workerd-runtime.ts";

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
    ...[".env", "dir/.x"].map((path) => ({
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
  expect(empty).toBe(without);
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
  const published = createWorkerdRuntime({ root, isReady: () => true });
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
    isReady: () => true,
    onReload: async (configPath) => {
      reloaded.push(configPath);
    },
  });
  expect(await restarted.restore()).toEqual(["site"]);
  // The runtime was actually started, against the configuration this build
  // renders rather than whichever one happened to be on disk.
  expect(reloaded).toEqual([join(root, "workers", "workerd.capnp")]);
  expect(await readFile(join(root, "workers", "workerd.capnp"), "utf8")).toBe(before);
  expect(await restarted.has("site", "gen-1")).toBe(true);
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
