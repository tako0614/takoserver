import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest, canonicalDigest } from "../src/json.ts";
import { createSelfhostVersionMaterializer } from "../src/providers/selfhost-version-materialization.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "takoserver-verification-fence-"));
  roots.push(root);
  const bytes = new TextEncoder().encode("export default { fetch() {} };");
  const digest = await bytesDigest(bytes);
  const manifest = {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle",
    mainModule: "index.js",
    modules: [
      { name: "index.js", mediaType: "application/javascript+module", size: bytes.length, digest },
    ],
  };
  let artifactReadsAllowed = true;
  const materializer = createSelfhostVersionMaterializer({
    root,
    artifacts: {
      async manifest() {
        if (!artifactReadsAllowed) throw new Error("artifact store offline");
        return manifest;
      },
      async blob() {
        if (!artifactReadsAllowed) throw new Error("artifact store offline");
        return bytes;
      },
    },
  });
  const request = {
    tenantRef: "tenant-a",
    script: "script-a",
    versionId: "version-a",
    manifestDigest: await canonicalDigest(manifest),
  };
  return {
    root,
    bytes,
    materializer,
    request,
    offline: () => {
      artifactReadsAllowed = false;
    },
  };
}

async function assetFixture() {
  const root = await mkdtemp(join(tmpdir(), "takoserver-asset-verification-fence-"));
  roots.push(root);
  const moduleBytes = new TextEncoder().encode("export default { fetch() {} };");
  const moduleDigest = await bytesDigest(moduleBytes);
  const moduleManifest = {
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle",
    mainModule: "index.js",
    modules: [
      {
        name: "index.js",
        mediaType: "application/javascript+module",
        size: moduleBytes.length,
        digest: moduleDigest,
      },
    ],
  };
  const assetBytes = new TextEncoder().encode("<html>ok</html>");
  const assetDigest = "sha256:legacy-asset";
  const assetManifestDigest = "sha256:legacy-assets";
  const assetManifest = {
    kind: "StaticAssetBundle",
    files: [
      {
        path: "index.html",
        mediaType: "text/html",
        size: assetBytes.length,
        digest: assetDigest,
      },
    ],
  };
  const moduleManifestDigest = await canonicalDigest(moduleManifest);
  let currentAssets = assetBytes;
  let artifactReadsAllowed = true;
  const materializer = createSelfhostVersionMaterializer({
    root,
    artifacts: {
      async manifest(_tenantRef, digest) {
        if (!artifactReadsAllowed) throw new Error("artifact store offline");
        if (digest === moduleManifestDigest) return moduleManifest;
        if (digest === assetManifestDigest) return assetManifest;
        return null;
      },
      async blob(digest) {
        if (!artifactReadsAllowed) throw new Error("artifact store offline");
        if (digest === moduleDigest) return moduleBytes;
        if (digest === assetDigest) return currentAssets;
        return null;
      },
    },
  });
  const request = {
    tenantRef: "tenant-a",
    script: "script-a",
    versionId: "version-a",
    manifestDigest: moduleManifestDigest,
    assets: {
      manifestDigest: assetManifestDigest,
      notFoundHandling: "none",
      runWorkerFirst: false,
    },
  } as const;
  return {
    root,
    moduleBytes,
    assetBytes,
    materializer,
    request,
    setAssets(bytes: Uint8Array) {
      currentAssets = new Uint8Array(bytes);
    },
    offline() {
      artifactReadsAllowed = false;
    },
  };
}

test("publication refuses a materialization other than the semantically verified digest", async () => {
  const { materializer, request } = await fixture();
  const prepared = await materializer.prepare(request);
  await expect(
    materializer.materialize(request, {
      ...prepared,
      materializationDigest: `sha256:${"0".repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await materializer.inspect(request)).toEqual({ state: "absent" });
});

test("a retained version supplies a bounded module snapshot without the artifact store", async () => {
  const { materializer, request, bytes, offline } = await fixture();
  const prepared = await materializer.prepare(request);
  await materializer.materialize(request, prepared);
  offline();
  const snapshot = await materializer.readSnapshot(request);
  expect(snapshot.state).toBe("present");
  if (snapshot.state !== "present") throw new Error("missing snapshot");
  expect(snapshot.prepared.materializationDigest).toBe(prepared.materializationDigest);
  expect(snapshot.prepared.modules.get("index.js")).toEqual(bytes);
});

test("a corrupt retained module cannot obtain a verification snapshot", async () => {
  const { root, materializer, request } = await fixture();
  await materializer.materialize(request);
  await writeFile(join(root, request.script, request.versionId, "modules", "index.js"), "changed");
  expect(await materializer.readSnapshot(request)).toEqual({ state: "corrupt" });
});

test("legacy metadata cannot hide changed module bytes between verification and publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-legacy-verification-fence-"));
  roots.push(root);
  const valid = "export default { fetch() {} };";
  const invalid = "export default { fetch: true };".padEnd(valid.length);
  let bytes = new TextEncoder().encode(valid.padEnd(invalid.length));
  const materializer = createSelfhostVersionMaterializer({
    root,
    artifacts: {
      async manifest() {
        return {
          kind: "WorkerBundle",
          mainModule: "index.js",
          modules: [{ name: "index.js", digest: "sha256:legacy-module", size: bytes.length }],
        };
      },
      async blob() {
        return bytes;
      },
    },
  });
  const request = {
    tenantRef: "tenant-a",
    script: "script-a",
    versionId: "version-a",
    manifestDigest: "sha256:legacy-bundle",
  };
  const prepared = await materializer.prepare(request);
  bytes = new TextEncoder().encode(invalid);
  const verifiedBytes = prepared.modules.get("index.js");
  if (!verifiedBytes) throw new Error("verified module is missing");
  expect(bytes.length).toBe(verifiedBytes.length);
  await expect(materializer.materialize(request, prepared)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await materializer.inspect(request)).toEqual({ state: "absent" });
  bytes = new Uint8Array(verifiedBytes);
  await materializer.materialize(request, prepared);
  await writeFile(join(root, request.script, request.versionId, "modules", "index.js"), invalid);
  await expect(materializer.materialize(request, prepared)).rejects.toMatchObject({
    code: "conflict",
  });
});

test("legacy metadata cannot hide changed same-size asset bytes between verification and publication", async () => {
  const { materializer, request, assetBytes, setAssets } = await assetFixture();
  const prepared = await materializer.prepare(request);
  const changed = new Uint8Array(assetBytes);
  changed[0] = (changed[0] ?? 0) ^ 1;
  setAssets(changed);
  expect(changed.length).toBe(assetBytes.length);

  await expect(materializer.materialize(request, prepared)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await materializer.inspect(request)).toEqual({ state: "absent" });
});

test("an existing committed asset mutation cannot pass the verified replay fence", async () => {
  const { root, materializer, request, assetBytes } = await assetFixture();
  const prepared = await materializer.prepare(request);
  await materializer.materialize(request, prepared);

  const changed = new Uint8Array(assetBytes);
  changed[0] = (changed[0] ?? 0) ^ 1;
  expect(changed.length).toBe(assetBytes.length);
  await writeFile(join(root, request.script, request.versionId, "assets", "asset-00000"), changed);

  await expect(materializer.materialize(request, prepared)).rejects.toMatchObject({
    code: "conflict",
  });
});

test("readSnapshot includes exact retained assets without the artifact store", async () => {
  const { materializer, request, moduleBytes, assetBytes, offline } = await assetFixture();
  const prepared = await materializer.prepare(request);
  await materializer.materialize(request, prepared);
  offline();

  const snapshot = await materializer.readSnapshot(request);
  expect(snapshot.state).toBe("present");
  if (snapshot.state !== "present") throw new Error("missing snapshot");
  expect(snapshot.prepared.modules.get("index.js")).toEqual(moduleBytes);
  expect(snapshot.prepared.assets?.get("index.html")).toEqual(assetBytes);
});
