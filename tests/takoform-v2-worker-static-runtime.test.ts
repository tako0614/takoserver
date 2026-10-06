import { expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import {
  parseStaticAssetBundleManifest,
  validateStaticAssetBundlePayload,
} from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { projectV2StaticWorkerVersion } from "../src/takoform-v2/worker-static-runtime.ts";

const encoder = new TextEncoder();
const MANIFEST_URL = "https://artifacts.example.test/assets/manifest.json";
const ASSET_URL = "https://artifacts.example.test/assets/index.html";
const WORKER_UID = "worker-uid-001";
const VERSION_UID = "version-uid-001";
const ASSET_UID = "assets-uid-001";
const INDEX_BYTES = encoder.encode("<main>static</main>");

async function digest(bytes: Uint8Array): Promise<string> {
  return (await bytesDigest(bytes)).slice("sha256:".length);
}

function versionSpec(input?: {
  notFoundHandling?: "none" | "single_page_application";
  path?: string;
}) {
  return {
    worker: { resourceUid: WORKER_UID },
    handlers: [],
    assets: {
      bundle: { resourceUid: ASSET_UID },
      runWorkerFirst: false,
      notFoundHandling: input?.notFoundHandling ?? "none",
    },
  };
}

async function materials(input?: {
  path?: string;
  notFoundHandling?: "none" | "single_page_application";
}) {
  const path = input?.path ?? "index.html";
  const manifestBytes = encoder.encode(
    JSON.stringify({
      files: [
        {
          path,
          url: ASSET_URL,
          sha256: await digest(INDEX_BYTES),
          mediaType: "text/html",
        },
      ],
    }),
  );
  const manifest = parseStaticAssetBundleManifest(manifestBytes);
  const artifactSha256 = await digest(manifestBytes);
  const verified = await validateStaticAssetBundlePayload({
    spec: { artifact: { url: MANIFEST_URL, sha256: artifactSha256 } },
    manifestBytes,
    fileBytes: [INDEX_BYTES],
  });
  return {
    manifest,
    manifestBytes,
    files: [new Uint8Array(INDEX_BYTES)],
    observed: verified.observed as unknown as JsonObject,
  };
}

function selection() {
  return {
    versionId: "version-id-001",
    workerVersionUid: VERSION_UID,
    weight: 10_000,
    workerResourceUid: WORKER_UID,
    generation: "publication-generation-007",
    directory: "/runtime/workers/worker-uid-001",
    hostnames: ["site.example.test"],
  };
}

test("projects a verified static-only Version to caller-owned runtime assets without a Worker module", async () => {
  const held = await materials();
  const projection = await projectV2StaticWorkerVersion({
    identity: selection(),
    spec: versionSpec(),
    materials: { bundle: null, assets: held },
  });

  expect(projection).toMatchObject({
    versionId: "version-id-001",
    workerVersionUid: VERSION_UID,
    weight: 10_000,
    site: {
      kind: "static",
      directory: "/runtime/workers/worker-uid-001",
      hostnames: ["site.example.test"],
      generation: "publication-generation-007",
      workerResourceUid: WORKER_UID,
      fetchHandler: false,
      assets: {
        notFoundHandling: "none",
        runWorkerFirst: false,
        mediaTypes: { "index.html": "text/html" },
      },
    },
  });
  expect(projection.modules.size).toBe(0);
  expect(Array.from(projection.assets.keys())).toEqual(["index.html"]);
  expect(projection.assets.get("index.html")).toEqual(INDEX_BYTES);
  expect(projection.site).not.toHaveProperty("mainModule");

  projection.assets.get("index.html")?.fill(0);
  expect(held.files[0]).toEqual(INDEX_BYTES);
});

test("hashes and publishes the same snapshot when held input mutates during async verification", async () => {
  const held = await materials();
  const originalBytes = held.files[0];
  if (!originalBytes) throw new Error("fixture asset missing");
  let mutationScheduled = false;
  const racingFiles = new Proxy([originalBytes], {
    get(target, property, receiver) {
      if (property === "0" && !mutationScheduled) {
        mutationScheduled = true;
        queueMicrotask(() => originalBytes.fill(0x7f));
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const projection = await projectV2StaticWorkerVersion({
    identity: selection(),
    spec: versionSpec(),
    materials: { bundle: null, assets: { ...held, files: racingFiles } },
  });
  expect(projection.assets.get("index.html")).toEqual(INDEX_BYTES);
});

test("preserves prototype-named asset paths as ordinary own media-type entries", async () => {
  for (const path of ["__proto__", "constructor", "toString"]) {
    const held = await materials({ path });
    const projection = await projectV2StaticWorkerVersion({
      identity: selection(),
      spec: versionSpec(),
      materials: { bundle: null, assets: held },
    });
    expect(projection.assets.get(path)).toEqual(INDEX_BYTES);
    expect(Object.keys(projection.site.assets.mediaTypes)).toEqual([path]);
    expect(projection.site.assets.mediaTypes[path]).toBe("text/html");
    expect(JSON.parse(JSON.stringify(projection.site.assets.mediaTypes))[path]).toBe("text/html");
  }
});

test("maps SPA policy and requires the exact root index.html asset", async () => {
  const held = await materials({ notFoundHandling: "single_page_application" });
  expect(
    (
      await projectV2StaticWorkerVersion({
        identity: selection(),
        spec: versionSpec({ notFoundHandling: "single_page_application" }),
        materials: { bundle: null, assets: held },
      })
    ).site.assets,
  ).toMatchObject({ notFoundHandling: "single-page-application" });

  const nestedOnly = await materials({ path: "public/index.html" });
  await expect(
    projectV2StaticWorkerVersion({
      identity: selection(),
      spec: versionSpec({ notFoundHandling: "single_page_application" }),
      materials: { bundle: null, assets: nestedOnly },
    }),
  ).rejects.toThrow();
});

test("rejects non-static Version shapes, mismatched worker identity, or unverified material projection", async () => {
  const held = await materials();
  const bundleVersionSpec = {
    worker: { resourceUid: WORKER_UID },
    bundle: { resourceUid: "worker-bundle-uid" },
    handlers: ["fetch"],
  };
  await expect(
    projectV2StaticWorkerVersion({
      identity: selection(),
      spec: bundleVersionSpec,
      materials: { bundle: null, assets: held },
    }),
  ).rejects.toThrow();
  await expect(
    projectV2StaticWorkerVersion({
      identity: { ...selection(), workerResourceUid: "another-worker-uid" },
      spec: versionSpec(),
      materials: { bundle: null, assets: held },
    }),
  ).rejects.toThrow();
  await expect(
    projectV2StaticWorkerVersion({
      identity: selection(),
      spec: versionSpec(),
      materials: {
        bundle: null,
        assets: { ...held, observed: { ...held.observed, totalBytes: 1 } },
      },
    }),
  ).rejects.toThrow();
  await expect(
    projectV2StaticWorkerVersion({ identity: selection(), spec: versionSpec(), materials: null }),
  ).rejects.toThrow();
});
