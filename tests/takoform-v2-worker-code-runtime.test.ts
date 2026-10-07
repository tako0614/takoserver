import { expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import type {
  WorkerModuleInspectionInput,
  WorkerModuleInspectionResult,
} from "../src/providers/worker-module-semantic-inspection.ts";
import type { SqlArtifactCustodyRead } from "../src/takoform-v2/forms/artifact-custody.ts";
import {
  parseStaticAssetBundleManifest,
  type StaticAssetBundleManifest,
  validateStaticAssetBundlePayload,
} from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  parseWorkerBundleManifest,
  validateWorkerBundlePayload,
  type WorkerBundleManifest,
} from "../src/takoform-v2/forms/worker-bundle.ts";
import { projectV2WorkerCodeVersion } from "../src/takoform-v2/worker-code-runtime.ts";

const encoder = new TextEncoder();
const MANIFEST_URL = "https://artifacts.example.test/bundle/manifest.json";
const MODULE_URL = "https://artifacts.example.test/bundle/src/index.mjs";
const MESSAGE_URL = "https://artifacts.example.test/bundle/message.txt";
const WORKER_UID = "worker-uid-001";
const VERSION_UID = "version-uid-001";
const BUNDLE_UID = "bundle-uid-001";
const MODULE_PATH = "src/index.mjs";
const MESSAGE_PATH = "message.txt";
const MODULE_BYTES = encoder.encode(
  "export default { fetch(request, env) { return new Response(env.SETTINGS.label); } };\n",
);
const MESSAGE_BYTES = encoder.encode("verified bundle module dependency");
const ASSET_UID = "asset-uid-001";
const ASSET_BYTES = encoder.encode("<main>verified asset</main>");

async function digest(bytes: Uint8Array): Promise<string> {
  return (await bytesDigest(bytes)).slice("sha256:".length);
}

function versionSpec(overrides: Record<string, unknown> = {}) {
  return {
    worker: { resourceUid: WORKER_UID },
    bundle: { resourceUid: BUNDLE_UID },
    handlers: ["fetch"],
    vars: { SETTINGS: { label: "v2", enabled: true }, RETRIES: 3 },
    ...overrides,
  };
}

async function heldBundle(input?: { moduleBytes?: Uint8Array }) {
  const moduleBytes = input?.moduleBytes ?? MODULE_BYTES;
  const manifestBytes = encoder.encode(
    JSON.stringify({
      entrypoint: MODULE_PATH,
      files: [
        {
          path: MODULE_PATH,
          url: MODULE_URL,
          sha256: await digest(moduleBytes),
          mediaType: "application/javascript+module",
        },
        {
          path: MESSAGE_PATH,
          url: MESSAGE_URL,
          sha256: await digest(MESSAGE_BYTES),
          mediaType: "text/plain",
        },
      ],
    }),
  );
  const manifest = parseWorkerBundleManifest(manifestBytes);
  const artifactSha256 = await digest(manifestBytes);
  const verified = await validateWorkerBundlePayload({
    spec: { artifact: { url: MANIFEST_URL, sha256: artifactSha256 } },
    manifestBytes,
    fileBytes: [moduleBytes, MESSAGE_BYTES],
  });
  const read: SqlArtifactCustodyRead<WorkerBundleManifest> = {
    manifest,
    manifestBytes: new Uint8Array(manifestBytes),
    files: [new Uint8Array(moduleBytes), new Uint8Array(MESSAGE_BYTES)],
    observed: verified.observed as unknown as JsonObject,
  };
  return read;
}

async function heldAssets(): Promise<SqlArtifactCustodyRead<StaticAssetBundleManifest>> {
  const manifestBytes = encoder.encode(
    JSON.stringify({
      files: [
        {
          path: "index.html",
          url: "https://artifacts.example.test/assets/index.html",
          sha256: await digest(ASSET_BYTES),
          mediaType: "text/html",
        },
      ],
    }),
  );
  const manifest = parseStaticAssetBundleManifest(manifestBytes);
  const verified = await validateStaticAssetBundlePayload({
    spec: {
      artifact: {
        url: "https://artifacts.example.test/assets/manifest.json",
        sha256: await digest(manifestBytes),
      },
    },
    manifestBytes,
    fileBytes: [ASSET_BYTES],
  });
  return {
    manifest,
    manifestBytes,
    files: [new Uint8Array(ASSET_BYTES)],
    observed: verified.observed as unknown as JsonObject,
  };
}

function identity() {
  return {
    versionId: "v2-version-id-001",
    workerVersionUid: VERSION_UID,
    weight: 10_000,
    workerResourceUid: WORKER_UID,
    generation: "accepted-generation-007",
    directory: "/runtime/workers/worker-uid-001",
    hostnames: ["worker.example.test"],
    bundleResourceUid: BUNDLE_UID,
  };
}

const validInspection: WorkerModuleInspectionResult = {
  outcome: "valid",
  exportedHandlers: ["fetch"],
};

function inspector(
  result: WorkerModuleInspectionResult = validInspection,
  observe?: (input: WorkerModuleInspectionInput) => void,
) {
  return async (input: WorkerModuleInspectionInput) => {
    observe?.(input);
    return result;
  };
}

test("projects verified code and JSON vars without changing v2 Worker identities", async () => {
  const held = await heldBundle();
  const projection = await projectV2WorkerCodeVersion({
    identity: identity(),
    spec: versionSpec(),
    bundle: held,
    inspectModule: inspector(),
  });

  expect(projection).toMatchObject({
    versionId: "v2-version-id-001",
    workerVersionUid: VERSION_UID,
    weight: 10_000,
    site: {
      directory: "/runtime/workers/worker-uid-001",
      hostnames: ["worker.example.test"],
      generation: "accepted-generation-007",
      workerResourceUid: WORKER_UID,
      fetchHandler: true,
      mainModule: MODULE_PATH,
      modules: [MESSAGE_PATH],
      moduleMediaTypes: {
        [MODULE_PATH]: "application/javascript+module",
        [MESSAGE_PATH]: "text/plain",
      },
    },
  });
  const vars = new Map(projection.site.vars?.map((entry) => [entry.name, entry]));
  expect(JSON.parse(vars.get("SETTINGS")?.value ?? "null")).toEqual({
    label: "v2",
    enabled: true,
  });
  expect(JSON.parse(vars.get("RETRIES")?.value ?? "null")).toBe(3);
  expect([...projection.modules.keys()]).toEqual([MODULE_PATH, MESSAGE_PATH]);
  expect(projection.modules.get(MODULE_PATH)).not.toBe(held.files[0]);
  held.files[0]?.fill(0x20);
  expect(projection.modules.get(MODULE_PATH)).toEqual(MODULE_BYTES);
});

test("rejects bytes that no longer match the immutable bundle digest and observation", async () => {
  const held = await heldBundle();
  held.files[0]?.fill(0x20);

  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec: versionSpec(),
      bundle: held,
      inspectModule: inspector(),
    }),
  ).rejects.toMatchObject({ code: "worker_bundle_unavailable" });
});

test("rejects a changed manifest/entrypoint even if its parsed projection is supplied", async () => {
  const held = await heldBundle();
  const changed = { ...held, manifest: { ...held.manifest, entrypoint: MESSAGE_PATH } };

  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec: versionSpec(),
      bundle: changed,
      inspectModule: inspector(),
    }),
  ).rejects.toMatchObject({ code: "worker_bundle_unavailable" });
});

test("requires the bundle UID and inspection handler set to match the accepted Version", async () => {
  const held = await heldBundle();
  await expect(
    projectV2WorkerCodeVersion({
      identity: { ...identity(), bundleResourceUid: "other-bundle" },
      spec: versionSpec(),
      bundle: held,
      inspectModule: inspector(),
    }),
  ).rejects.toMatchObject({ code: "worker_bundle_unavailable" });

  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec: versionSpec(),
      bundle: held,
      inspectModule: inspector({ outcome: "valid", exportedHandlers: [] }),
    }),
  ).rejects.toMatchObject({ code: "worker_handler_mismatch" });
});

test("keeps valid fetch code separate from unsupported bindings, secrets, and events", async () => {
  const held = await heldBundle();
  for (const [spec, code] of [
    [
      versionSpec({ kvBindings: [{ name: "CACHE", resource: { resourceUid: "kv-1" } }] }),
      "worker_binding_unavailable",
    ],
    [versionSpec({ requiredSensitiveVars: ["TOKEN"] }), "worker_private_inputs_unavailable"],
    [versionSpec({ handlers: ["fetch", "queue"] }), "worker_event_delivery_unavailable"],
    [versionSpec({ handlers: ["fetch", "scheduled"] }), "worker_event_delivery_unavailable"],
  ] as const) {
    await expect(
      projectV2WorkerCodeVersion({
        identity: identity(),
        spec,
        bundle: held,
        inspectModule: inspector(),
      }),
    ).rejects.toMatchObject({ code });
  }
});

test("scheduled code requires an explicit private delivery capability and exact handler export", async () => {
  const spec = versionSpec({ handlers: ["fetch", "scheduled"] });
  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec,
      bundle: await heldBundle(),
      inspectModule: inspector({ outcome: "valid", exportedHandlers: ["fetch", "scheduled"] }),
    }),
  ).rejects.toMatchObject({ code: "worker_event_delivery_unavailable" });
  const projected = await projectV2WorkerCodeVersion({
    identity: identity(),
    spec,
    bundle: await heldBundle(),
    inspectModule: inspector({ outcome: "valid", exportedHandlers: ["fetch", "scheduled"] }),
    eventDelivery: { token: "a".repeat(64) },
  });
  expect(projected.site.fetchHandler).toBe(true);
  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec,
      bundle: await heldBundle(),
      inspectModule: inspector({ outcome: "valid", exportedHandlers: ["fetch"] }),
      eventDelivery: { token: "a".repeat(64) },
    }),
  ).rejects.toMatchObject({ code: "worker_handler_mismatch" });
});

test("handler-only scheduled code projects before a Cron attachment exists", async () => {
  const projection = await projectV2WorkerCodeVersion({
    identity: identity(),
    spec: versionSpec({ handlers: ["scheduled"] }),
    bundle: await heldBundle({
      moduleBytes: encoder.encode("export default { scheduled() {} };\n"),
    }),
    inspectModule: inspector({ outcome: "valid", exportedHandlers: ["scheduled"] }),
    eventDelivery: { token: "b".repeat(64) },
  });
  expect(projection.site.fetchHandler).toBe(false);
  expect(projection.modules.get(MODULE_PATH)).toEqual(
    encoder.encode("export default { scheduled() {} };\n"),
  );
});

test("projects verified code+assets into one copied Version with exact routing policy", async () => {
  const held = await heldAssets();
  const projection = await projectV2WorkerCodeVersion({
    identity: { ...identity(), assetResourceUid: ASSET_UID },
    spec: versionSpec({
      assets: {
        bundle: { resourceUid: ASSET_UID },
        runWorkerFirst: true,
        notFoundHandling: "single_page_application",
      },
    }),
    bundle: await heldBundle(),
    assets: held,
    inspectModule: inspector(),
  });
  expect(projection.site.assets).toEqual({
    notFoundHandling: "single-page-application",
    runWorkerFirst: true,
    strictPaths: true,
    mediaTypes: { "index.html": "text/html" },
  });
  expect(projection.assets?.get("index.html")).toEqual(ASSET_BYTES);
  held.files[0]?.fill(0);
  expect(projection.assets?.get("index.html")).toEqual(ASSET_BYTES);
});

test("bundle-backed assets permit no declared fetch without inventing a handler", async () => {
  const projection = await projectV2WorkerCodeVersion({
    identity: { ...identity(), assetResourceUid: ASSET_UID },
    spec: versionSpec({
      handlers: [],
      assets: {
        bundle: { resourceUid: ASSET_UID },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    }),
    bundle: await heldBundle({ moduleBytes: encoder.encode("export default {};\n") }),
    assets: await heldAssets(),
    inspectModule: inspector({ outcome: "valid", exportedHandlers: [] }),
  });
  expect(projection.site.fetchHandler).toBe(false);
  expect(projection.site.assets?.runWorkerFirst).toBe(false);
  expect(projection.assets?.get("index.html")).toEqual(ASSET_BYTES);
});

test("refuses missing, wrong-UID, or modified held assets before code inspection", async () => {
  const held = await heldAssets();
  const spec = versionSpec({
    assets: { bundle: { resourceUid: ASSET_UID }, runWorkerFirst: false, notFoundHandling: "none" },
  });
  let inspections = 0;
  const request = {
    identity: { ...identity(), assetResourceUid: ASSET_UID },
    spec,
    bundle: await heldBundle(),
    assets: held,
    inspectModule: inspector(validInspection, () => {
      inspections += 1;
    }),
  };
  await expect(projectV2WorkerCodeVersion({ ...request, assets: null })).rejects.toMatchObject({
    code: "worker_assets_unavailable",
  });
  await expect(
    projectV2WorkerCodeVersion({
      ...request,
      identity: { ...request.identity, assetResourceUid: "other" },
    }),
  ).rejects.toMatchObject({ code: "worker_assets_unavailable" });
  held.files[0]?.fill(0);
  await expect(projectV2WorkerCodeVersion(request)).rejects.toMatchObject({
    code: "worker_assets_unavailable",
  });
  expect(inspections).toBe(0);
});

test("rejects unavailable or invalid semantic inspection without publishing a graph", async () => {
  const held = await heldBundle();
  for (const inspection of [
    { outcome: "unavailable", retryable: true },
    { outcome: "invalid", error: "module_evaluation_failed" },
  ] as const) {
    await expect(
      projectV2WorkerCodeVersion({
        identity: identity(),
        spec: versionSpec(),
        bundle: held,
        inspectModule: inspector(inspection),
      }),
    ).rejects.toMatchObject({ code: "worker_module_inspection_unavailable" });
  }
});

test("invokes the trusted inspector on the exact verified bundle snapshot", async () => {
  const held = await heldBundle();
  let inspected: WorkerModuleInspectionInput | undefined;
  let substitutedInspectorCalled = false;
  const request = {
    identity: identity(),
    spec: versionSpec(),
    bundle: held,
    inspectModule: inspector(validInspection, (input) => {
      inspected = input;
    }),
  };
  const projectionPromise = projectV2WorkerCodeVersion(request);

  request.inspectModule = inspector({ outcome: "valid", exportedHandlers: [] }, () => {
    substitutedInspectorCalled = true;
  });
  held.files[0]?.fill(0x20);
  const projection = await projectionPromise;
  expect(substitutedInspectorCalled).toBe(false);
  expect(inspected?.mainModule).toBe(MODULE_PATH);
  expect(inspected?.declaredHandlers).toEqual(["fetch"]);
  expect(inspected?.modules.map((module) => module.name)).toEqual([MODULE_PATH, MESSAGE_PATH]);
  expect(inspected?.modules[0]?.bytes).toEqual(MODULE_BYTES);
  expect(projection.modules.get(MODULE_PATH)).toEqual(MODULE_BYTES);
});
