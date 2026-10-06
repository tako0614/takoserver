import { expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import type { WorkerModuleInspectionResult } from "../src/providers/worker-module-semantic-inspection.ts";
import type { SqlArtifactCustodyRead } from "../src/takoform-v2/forms/artifact-custody.ts";
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
const SOURCE_MAP_URL = "https://artifacts.example.test/bundle/src/index.mjs.map";
const WORKER_UID = "worker-uid-001";
const VERSION_UID = "version-uid-001";
const BUNDLE_UID = "bundle-uid-001";
const MODULE_PATH = "src/index.mjs";
const MESSAGE_PATH = "message.txt";
const SOURCE_MAP_PATH = "src/index.mjs.map";
const MODULE_BYTES = encoder.encode(
  "export default { fetch(request, env) { return new Response(env.SETTINGS.label); } };\n",
);
const MESSAGE_BYTES = encoder.encode("verified bundle module dependency");
const SOURCE_MAP_BYTES = encoder.encode('{"version":3,"sources":["index.ts"],"mappings":""}');

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
          path: SOURCE_MAP_PATH,
          url: SOURCE_MAP_URL,
          sha256: await digest(SOURCE_MAP_BYTES),
          mediaType: "application/source-map+json",
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
    fileBytes: [moduleBytes, SOURCE_MAP_BYTES, MESSAGE_BYTES],
  });
  const read: SqlArtifactCustodyRead<WorkerBundleManifest> = {
    manifest,
    manifestBytes: new Uint8Array(manifestBytes),
    files: [
      new Uint8Array(moduleBytes),
      new Uint8Array(SOURCE_MAP_BYTES),
      new Uint8Array(MESSAGE_BYTES),
    ],
    observed: verified.observed as unknown as JsonObject,
  };
  return read;
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

function inspectionInput(
  held: SqlArtifactCustodyRead<WorkerBundleManifest>,
  declaredHandlers: readonly ("fetch" | "scheduled" | "queue")[] = ["fetch"],
) {
  return {
    mainModule: held.manifest.entrypoint,
    modules: held.manifest.files.flatMap((file, index) =>
      file.mediaType === "application/source-map+json"
        ? []
        : [
            {
              name: file.path,
              digest: `sha256:${file.sha256}` as const,
              mediaType: file.mediaType,
              bytes: new Uint8Array(held.files[index] ?? []),
            },
          ],
    ),
    declaredHandlers,
  };
}

const validInspection: WorkerModuleInspectionResult = {
  outcome: "valid",
  exportedHandlers: ["fetch"],
};

test("projects verified code and JSON vars without changing v2 Worker identities", async () => {
  const held = await heldBundle();
  const projection = await projectV2WorkerCodeVersion({
    identity: identity(),
    spec: versionSpec(),
    bundle: held,
    inspectionInput: inspectionInput(held),
    inspection: validInspection,
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
  expect(projection.modules.has(SOURCE_MAP_PATH)).toBe(false);
  expect(projection.modules.get(MODULE_PATH)).not.toBe(held.files[0]);
  held.files[0]?.fill(0x20);
  expect(projection.modules.get(MODULE_PATH)).toEqual(MODULE_BYTES);
});

test("accepts retained source-map bytes but rejects a corrupt source-map digest", async () => {
  const held = await heldBundle();
  const projection = await projectV2WorkerCodeVersion({
    identity: identity(),
    spec: versionSpec(),
    bundle: held,
    inspectionInput: inspectionInput(held),
    inspection: validInspection,
  });
  expect(projection.modules.has(SOURCE_MAP_PATH)).toBe(false);

  const corrupt = await heldBundle();
  corrupt.files[1]?.fill(0x20);
  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec: versionSpec(),
      bundle: corrupt,
      inspectionInput: inspectionInput(corrupt),
      inspection: validInspection,
    }),
  ).rejects.toMatchObject({ code: "worker_bundle_unavailable" });
});

test("rejects bytes that no longer match the immutable bundle digest and observation", async () => {
  const held = await heldBundle();
  held.files[0]?.fill(0x20);

  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec: versionSpec(),
      bundle: held,
      inspectionInput: inspectionInput(held),
      inspection: validInspection,
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
      inspectionInput: inspectionInput(held),
      inspection: validInspection,
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
      inspectionInput: inspectionInput(held),
      inspection: validInspection,
    }),
  ).rejects.toMatchObject({ code: "worker_bundle_unavailable" });

  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec: versionSpec(),
      bundle: held,
      inspectionInput: inspectionInput(held),
      inspection: { outcome: "valid", exportedHandlers: [] },
    }),
  ).rejects.toMatchObject({ code: "worker_handler_mismatch" });

  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec: versionSpec(),
      bundle: held,
      inspectionInput: inspectionInput(held, []),
      inspection: validInspection,
    }),
  ).rejects.toMatchObject({ code: "worker_module_inspection_unavailable" });
});

test("keeps valid fetch code separate from unsupported bindings, secrets, assets, and events", async () => {
  const held = await heldBundle();
  for (const [spec, code] of [
    [
      versionSpec({ kvBindings: [{ name: "CACHE", resource: { resourceUid: "kv-1" } }] }),
      "worker_binding_unavailable",
    ],
    [versionSpec({ requiredSensitiveVars: ["TOKEN"] }), "worker_private_inputs_unavailable"],
    [versionSpec({ handlers: ["fetch", "queue"] }), "worker_event_delivery_unavailable"],
    [versionSpec({ handlers: ["fetch", "scheduled"] }), "worker_event_delivery_unavailable"],
    [
      versionSpec({
        assets: {
          bundle: { resourceUid: "assets-1" },
          runWorkerFirst: false,
          notFoundHandling: "none",
        },
      }),
      "worker_assets_unavailable",
    ],
  ] as const) {
    await expect(
      projectV2WorkerCodeVersion({
        identity: identity(),
        spec,
        bundle: held,
        inspectionInput: inspectionInput(held),
        inspection: validInspection,
      }),
    ).rejects.toMatchObject({ code });
  }
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
        inspectionInput: inspectionInput(held),
        inspection,
      }),
    ).rejects.toMatchObject({ code: "worker_module_inspection_unavailable" });
  }
});

test("rejects an inspection result that is not tied to the exact held module snapshot", async () => {
  const held = await heldBundle();
  const mismatched = inspectionInput(held);
  mismatched.modules[0]?.bytes.fill(0x20);

  await expect(
    projectV2WorkerCodeVersion({
      identity: identity(),
      spec: versionSpec(),
      bundle: held,
      inspectionInput: mismatched,
      inspection: validInspection,
    }),
  ).rejects.toMatchObject({ code: "worker_module_inspection_unavailable" });
});
