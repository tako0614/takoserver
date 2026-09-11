import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest, canonicalDigest } from "../src/json.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import {
  createSelfhostVersionMaterializer,
  type SelfhostVersionArtifactManifest,
} from "../src/providers/selfhost-version-materialization.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const EDGE_API = "edge.forms.takoform.com/v1beta1";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-version-materialization-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function artifactFixture(source = "export default {}") {
  const bytes = new TextEncoder().encode(source);
  const blobDigest = await bytesDigest(bytes);
  const manifest = {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle" as const,
    mainModule: "index.js",
    modules: [
      {
        name: "index.js",
        mediaType: "application/javascript+module",
        size: bytes.byteLength,
        digest: blobDigest,
      },
    ],
  } satisfies SelfhostVersionArtifactManifest;
  const manifestDigest = await canonicalDigest(manifest);
  let available = true;
  return {
    manifest,
    manifestDigest,
    setAvailable(value: boolean) {
      available = value;
    },
    artifacts: {
      async manifest(_tenantRef: string, digest: string) {
        return digest === manifestDigest ? manifest : null;
      },
      async blob(digest: string) {
        return available && digest === blobDigest ? bytes : null;
      },
    },
  };
}

async function materializerFixture(source?: string) {
  const fixture = await artifactFixture(source);
  const materializer = createSelfhostVersionMaterializer({
    root,
    artifacts: fixture.artifacts,
  });
  const input = {
    tenantRef: "tenant-a",
    script: "script-a",
    versionId: "version-a",
    manifestDigest: fixture.manifestDigest,
  } as const;
  return { fixture, materializer, input };
}

async function assetMaterializerFixture(
  paths: readonly string[],
  mediaTypes: Readonly<Record<string, string>> = {},
) {
  const workerBytes = new TextEncoder().encode("export default { fetch() {} }");
  const workerDigest = await bytesDigest(workerBytes);
  const workerManifest = {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle" as const,
    mainModule: "index.js",
    modules: [
      {
        name: "index.js",
        mediaType: "application/javascript+module",
        size: workerBytes.byteLength,
        digest: workerDigest,
      },
    ],
  } satisfies SelfhostVersionArtifactManifest;
  const workerManifestDigest = await canonicalDigest(workerManifest);
  const blobs = new Map<string, Uint8Array>([[workerDigest, workerBytes]]);
  const files = await Promise.all(
    paths.map(async (path) => {
      const bytes = new TextEncoder().encode(`asset:${path}`);
      const digest = await bytesDigest(bytes);
      blobs.set(digest, bytes);
      return {
        path,
        mediaType: mediaTypes[path] ?? (path.endsWith(".html") ? "text/html" : "text/css"),
        size: bytes.byteLength,
        digest,
      };
    }),
  );
  const assetManifest = {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "StaticAssetBundle" as const,
    files,
  } satisfies SelfhostVersionArtifactManifest;
  const assetManifestDigest = await canonicalDigest(assetManifest);
  const artifacts = {
    async manifest(_tenantRef: string, digest: string) {
      if (digest === workerManifestDigest) return workerManifest;
      if (digest === assetManifestDigest) return assetManifest;
      return null;
    },
    async blob(digest: string) {
      return blobs.get(digest) ?? null;
    },
  };
  const input = {
    tenantRef: "tenant-a",
    script: "script-a",
    versionId: "version-a",
    manifestDigest: workerManifestDigest,
  } as const;
  return {
    input,
    assetManifestDigest,
    materializer: createSelfhostVersionMaterializer({ root, artifacts }),
  };
}

describe("self-host Worker Version materialization", () => {
  test("a missing blob preserves an existing complete version", async () => {
    const { fixture, materializer, input } = await materializerFixture();
    await materializer.materialize(input);
    const finalPath = join(root, input.script, input.versionId);
    const before = await readFile(join(finalPath, "meta.json"));
    fixture.setAvailable(false);

    await expect(materializer.materialize(input)).rejects.toMatchObject({ code: "invalid_spec" });

    expect(await readFile(join(finalPath, "meta.json"))).toEqual(before);
    expect((await materializer.inspect(input)).state).toBe("present");
  });

  test("a crash before rename leaves the prior committed version untouched", async () => {
    const old = await materializerFixture("export default 'old'");
    await old.materializer.materialize({ ...old.input, versionId: "version-old" });
    const next = await materializerFixture("export default 'new'");
    const crashing = createSelfhostVersionMaterializer({
      root,
      artifacts: next.fixture.artifacts,
      beforeRename: () => {
        throw new Error("simulated crash before rename");
      },
    });

    await expect(
      crashing.materialize({ ...next.input, versionId: "version-new" }),
    ).rejects.toMatchObject({ code: "unavailable" });

    expect((await old.materializer.inspect({ ...old.input, versionId: "version-old" })).state).toBe(
      "present",
    );
    expect((await crashing.inspect({ ...next.input, versionId: "version-new" })).state).toBe(
      "absent",
    );
    const siblings = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(root, next.input.script)).catch(() => []),
    );
    expect(siblings.some((entry) => entry.startsWith("version-new.staging-"))).toBe(false);
  });

  test("an exact digest replay is idempotent and does not rewrite the final", async () => {
    const { materializer, input } = await materializerFixture();
    await materializer.materialize(input);
    const finalPath = join(root, input.script, input.versionId);
    const before = await lstat(finalPath);
    const metaBefore = await readFile(join(finalPath, "meta.json"));

    const replay = await materializer.materialize(input);
    const after = await lstat(finalPath);
    const inspected = await materializer.inspect(input);

    expect(inspected.state).toBe("present");
    if (inspected.state !== "present") throw new Error("replayed materialization is not present");
    expect(replay.materializationDigest).toBe(inspected.digest);
    expect(after.ino).toBe(before.ino);
    expect(await readFile(join(finalPath, "meta.json"))).toEqual(metaBefore);
  });

  test("a digest-mismatched or corrupt final refuses overwrite", async () => {
    const { fixture, materializer, input } = await materializerFixture();
    await materializer.materialize(input);
    const modulePath = join(root, input.script, input.versionId, "modules", "index.js");
    await writeFile(modulePath, "tampered", "utf8");

    await expect(materializer.materialize(input)).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(modulePath, "utf8")).toBe("tampered");
    expect((await materializer.inspect(input)).state).toBe("corrupt");

    // A valid final carrying a different source digest is also create-only:
    // the new request cannot replace the committed identity.
    const different = await materializerFixture("export default 'different'");
    const other = createSelfhostVersionMaterializer({
      root,
      artifacts: different.fixture.artifacts,
    });
    await rm(join(root, input.script, input.versionId), { recursive: true, force: true });
    await materializer.materialize(input);
    await expect(
      other.materialize({ ...input, manifestDigest: different.fixture.manifestDigest }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.manifestDigest).not.toBe(different.fixture.manifestDigest);
  });

  test("inspection is exactly absent, present, or corrupt", async () => {
    const { materializer, input } = await materializerFixture();
    expect(await materializer.inspect(input)).toEqual({ state: "absent" });
    await materializer.materialize(input);
    expect((await materializer.inspect(input)).state).toBe("present");
    await rm(join(root, input.script, input.versionId, "meta.json"));
    expect(await materializer.inspect(input)).toEqual({ state: "corrupt" });
  });

  test("routing order is immutable materialization identity and survives readback", async () => {
    const { materializer, input, assetManifestDigest } = await assetMaterializerFixture([
      "index.html",
      "styles/app.css",
    ]);
    const assetFirst = await materializer.prepare({
      ...input,
      assets: {
        manifestDigest: assetManifestDigest,
        notFoundHandling: "single-page-application",
        runWorkerFirst: false,
      },
    });
    const workerFirst = await materializer.prepare({
      ...input,
      assets: {
        manifestDigest: assetManifestDigest,
        notFoundHandling: "single-page-application",
        runWorkerFirst: true,
      },
    });
    expect(workerFirst.materializationDigest).not.toBe(assetFirst.materializationDigest);

    await materializer.materialize(
      {
        ...input,
        assets: {
          manifestDigest: assetManifestDigest,
          notFoundHandling: "single-page-application",
          runWorkerFirst: true,
        },
      },
      workerFirst,
    );
    const restarted = createSelfhostVersionMaterializer({
      root,
      artifacts: {
        async manifest() {
          throw new Error("readback must not consult artifact storage");
        },
        async blob() {
          throw new Error("readback must not consult artifact storage");
        },
      },
    });
    const retained = await restarted.readSnapshot(input);
    expect(retained.state).toBe("present");
    if (retained.state !== "present") throw new Error("asset materialization was not retained");
    expect(retained.prepared.meta.assets).toMatchObject({
      manifestDigest: assetManifestDigest,
      notFoundHandling: "single-page-application",
      runWorkerFirst: true,
      storageLayout: "flat-ordinal-v1",
    });
    expect([...(retained.prepared.assets as ReadonlyMap<string, Uint8Array>).keys()]).toEqual([
      "index.html",
      "styles/app.css",
    ]);
  });

  test("materializes prefix-colliding logical asset paths as distinct flat files", async () => {
    const { materializer, input, assetManifestDigest } = await assetMaterializerFixture([
      "foo",
      "foo/bar.txt",
    ]);
    await materializer.materialize({
      ...input,
      assets: {
        manifestDigest: assetManifestDigest,
        notFoundHandling: "none",
        runWorkerFirst: false,
      },
    });

    const retained = await materializer.readSnapshot(input);
    expect(retained.state).toBe("present");
    if (retained.state !== "present") throw new Error("asset materialization was not retained");
    expect(
      [...(retained.prepared.assets as ReadonlyMap<string, Uint8Array>)].map(([path, bytes]) => [
        path,
        new TextDecoder().decode(bytes),
      ]),
    ).toEqual([
      ["foo", "asset:foo"],
      ["foo/bar.txt", "asset:foo/bar.txt"],
    ]);
    const physical = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(root, input.script, input.versionId, "assets"), { withFileTypes: true }),
    );
    expect(physical).toHaveLength(2);
    expect(physical.every((entry) => entry.isFile())).toBe(true);
  });

  test("materializes explicit dot-prefixed asset paths in flat storage", async () => {
    const paths = [".env", "dir/.x", ".well-known/info", "a/.hidden/main.js"] as const;
    const { materializer, input, assetManifestDigest } = await assetMaterializerFixture(paths);
    await materializer.materialize({
      ...input,
      assets: {
        manifestDigest: assetManifestDigest,
        notFoundHandling: "none",
        runWorkerFirst: false,
      },
    });

    const retained = await materializer.readSnapshot(input);
    expect(retained.state).toBe("present");
    if (retained.state !== "present") throw new Error("dot-prefixed assets were not retained");
    expect([...(retained.prepared.assets as ReadonlyMap<string, Uint8Array>).keys()]).toEqual(
      paths,
    );
    const physical = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(root, input.script, input.versionId, "assets"), { withFileTypes: true }),
    );
    expect(physical.map((entry) => entry.name).sort()).toEqual([
      "asset-00000",
      "asset-00001",
      "asset-00002",
      "asset-00003",
    ]);
    expect(physical.every((entry) => entry.isFile())).toBe(true);
  });

  test.each([".", "..", "dir/./x", "dir/../x"])(
    "rejects traversal asset path %s before materialization",
    async (path) => {
      const { materializer, input, assetManifestDigest } = await assetMaterializerFixture([path]);
      await expect(
        materializer.materialize({
          ...input,
          assets: {
            manifestDigest: assetManifestDigest,
            notFoundHandling: "none",
            runWorkerFirst: false,
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_spec" });
      expect((await materializer.readSnapshot(input)).state).toBe("absent");
    },
  );

  test("asset media is immutable identity even when the bytes are unchanged", async () => {
    const css = await assetMaterializerFixture(["app.bin"], { "app.bin": "text/css" });
    const cssInput = {
      ...css.input,
      assets: {
        manifestDigest: css.assetManifestDigest,
        notFoundHandling: "none" as const,
        runWorkerFirst: false,
      },
    };
    const cssPrepared = await css.materializer.prepare(cssInput);
    await css.materializer.materialize(cssInput, cssPrepared);

    const vendor = await assetMaterializerFixture(["app.bin"], {
      "app.bin": "application/vnd.takos.theme",
    });
    const vendorInput = {
      ...vendor.input,
      assets: {
        manifestDigest: vendor.assetManifestDigest,
        notFoundHandling: "none" as const,
        runWorkerFirst: false,
      },
    };
    const vendorPrepared = await vendor.materializer.prepare(vendorInput);
    expect(vendorPrepared.materializationDigest).not.toBe(cssPrepared.materializationDigest);
    await expect(
      vendor.materializer.materialize(vendorInput, vendorPrepared),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("flat asset readback rejects missing and stale physical entries", async () => {
    const { materializer, input, assetManifestDigest } = await assetMaterializerFixture([
      "foo",
      "foo/bar.txt",
    ]);
    await materializer.materialize({
      ...input,
      assets: {
        manifestDigest: assetManifestDigest,
        notFoundHandling: "none",
        runWorkerFirst: false,
      },
    });
    const assetsRoot = join(root, input.script, input.versionId, "assets");
    await writeFile(join(assetsRoot, "asset-99999"), "stale");
    expect((await materializer.readSnapshot(input)).state).toBe("corrupt");
    await rm(join(assetsRoot, "asset-99999"));
    await rm(join(assetsRoot, "asset-00001"));
    expect((await materializer.readSnapshot(input)).state).toBe("corrupt");
  });

  test("retains a legacy asset record without inventing its missing routing order", async () => {
    const { materializer, input, assetManifestDigest } = await assetMaterializerFixture([
      "index.html",
    ]);
    await materializer.materialize({
      ...input,
      assets: {
        manifestDigest: assetManifestDigest,
        notFoundHandling: "none",
        runWorkerFirst: false,
      },
    });
    const metaPath = join(root, input.script, input.versionId, "meta.json");
    const legacy = JSON.parse(await readFile(metaPath, "utf8")) as {
      materializationDigest: string;
      assets: { runWorkerFirst?: boolean };
      [key: string]: unknown;
    };
    delete legacy.assets.runWorkerFirst;
    const { materializationDigest: _oldDigest, ...legacyPayload } = legacy;
    legacy.materializationDigest = await canonicalDigest(legacyPayload);
    await writeFile(metaPath, JSON.stringify(legacy), "utf8");

    const retained = await materializer.readSnapshot(input);
    expect(retained.state).toBe("present");
    if (retained.state !== "present") throw new Error("legacy asset record was not retained");
    expect(retained.prepared.meta.assets).toMatchObject({
      manifestDigest: assetManifestDigest,
      notFoundHandling: "none",
    });
    expect(retained.prepared.meta.assets?.runWorkerFirst).toBeUndefined();
  });

  test("retains legacy asset media and physical layout only as unknown evidence", async () => {
    const media = await assetMaterializerFixture(["index.html"]);
    const request = {
      ...media.input,
      assets: {
        manifestDigest: media.assetManifestDigest,
        notFoundHandling: "none" as const,
        runWorkerFirst: false,
      },
    };
    await media.materializer.materialize(request);
    const metaPath = join(root, media.input.script, media.input.versionId, "meta.json");
    const mediaLegacy = JSON.parse(await readFile(metaPath, "utf8")) as {
      materializationDigest: string;
      assets: { files: Array<{ mediaType?: string }> };
      [key: string]: unknown;
    };
    delete mediaLegacy.assets.files[0]?.mediaType;
    const { materializationDigest: _mediaDigest, ...mediaPayload } = mediaLegacy;
    mediaLegacy.materializationDigest = await canonicalDigest(mediaPayload);
    await writeFile(metaPath, JSON.stringify(mediaLegacy));
    const retainedMedia = await media.materializer.readSnapshot(media.input);
    expect(retainedMedia.state).toBe("present");
    if (retainedMedia.state !== "present") throw new Error("legacy media was not retained");
    expect(retainedMedia.prepared.meta.assets?.files[0]?.mediaType).toBeUndefined();

    await rm(root, { recursive: true, force: true });
    const layout = await assetMaterializerFixture(["index.html"]);
    const layoutRequest = {
      ...layout.input,
      assets: {
        manifestDigest: layout.assetManifestDigest,
        notFoundHandling: "none" as const,
        runWorkerFirst: false,
      },
    };
    await layout.materializer.materialize(layoutRequest);
    const layoutMetaPath = join(root, layout.input.script, layout.input.versionId, "meta.json");
    const layoutLegacy = JSON.parse(await readFile(layoutMetaPath, "utf8")) as {
      materializationDigest: string;
      assets: { storageLayout?: string };
      [key: string]: unknown;
    };
    const assetsRoot = join(root, layout.input.script, layout.input.versionId, "assets");
    await rename(join(assetsRoot, "asset-00000"), join(assetsRoot, "index.html"));
    delete layoutLegacy.assets.storageLayout;
    const { materializationDigest: _layoutDigest, ...layoutPayload } = layoutLegacy;
    layoutLegacy.materializationDigest = await canonicalDigest(layoutPayload);
    await writeFile(layoutMetaPath, JSON.stringify(layoutLegacy));
    const retainedLayout = await layout.materializer.readSnapshot(layout.input);
    expect(retainedLayout.state).toBe("present");
    if (retainedLayout.state !== "present") throw new Error("legacy layout was not retained");
    expect(retainedLayout.prepared.meta.assets?.storageLayout).toBeUndefined();
  });

  test("SPA admission and routing shape are refused before filesystem mutation", async () => {
    const { materializer, input, assetManifestDigest } = await assetMaterializerFixture([
      "styles/app.css",
    ]);
    const invalid = [
      {
        manifestDigest: assetManifestDigest,
        notFoundHandling: "single-page-application",
        runWorkerFirst: false,
      },
      {
        manifestDigest: assetManifestDigest,
        notFoundHandling: "none",
        runWorkerFirst: undefined,
      },
    ] as const;
    for (const assets of invalid) {
      await expect(
        materializer.materialize({ ...input, assets: assets as never }),
      ).rejects.toMatchObject({ code: "invalid_spec" });
      await expect(lstat(join(root, input.script))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

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

const runtime: WorkerdRuntime = {
  async inspectModule(input) {
    return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
  },
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return true;
  },
};

test("the provider maps missing/corrupt observation and recovers an exact apply", async () => {
  const fixture = await artifactFixture();
  const provider = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    artifacts: fixture.artifacts,
  });
  const input = {
    operationId: "op-version",
    offering: offering("WorkerVersion"),
    identity: { tenantRef: "tenant-a", space: "default", name: "version-a" },
    spec: { handlers: ["fetch"] },
    relations: [
      relation("/worker", "ModuleWorker", "worker-a"),
      relation("/bundle", "WorkerBundle", "bundle-a", { manifestDigest: fixture.manifestDigest }),
    ],
  } as const;
  const applied = await provider.apply(input);
  expect(applied.phase).toBe("succeeded");

  const missing = await provider.observe({
    ...input,
    nativeId: "missing",
    identity: { ...input.identity, name: "missing-version" },
  });
  expect(missing).toMatchObject({ phase: "failed", failure: { code: "not_found" } });

  if (applied.phase !== "succeeded") throw new Error("version apply failed");
  const modulePath = join(
    root,
    "selfhost",
    "versions",
    String(applied.result.outputs.scriptName),
    String(applied.result.outputs.versionId),
    "modules",
    "index.js",
  );
  await writeFile(modulePath, "corrupt", "utf8");
  const corrupt = await provider.observe({ ...input, nativeId: applied.result.nativeId });
  expect(corrupt).toMatchObject({ phase: "failed", failure: { code: "provider_error" } });

  // Restore a clean materialization through a fresh provider instance to
  // verify recovery's read-only exact-digest path.
  await rm(
    join(
      root,
      "selfhost",
      "versions",
      String(applied.result.outputs.scriptName),
      String(applied.result.outputs.versionId),
    ),
    { recursive: true, force: true },
  );
  const restored = await provider.apply({ ...input, operationId: "op-version-restore" });
  expect(restored.phase).toBe("succeeded");
  if (!provider.recoverApply) throw new Error("self-host provider missing apply recovery seam");
  const recovered = await provider.recoverApply({ ...input, operationMode: "recovery" });
  expect(recovered).toMatchObject({
    phase: "succeeded",
    result: { observed: { materialized: true } },
  });
});
