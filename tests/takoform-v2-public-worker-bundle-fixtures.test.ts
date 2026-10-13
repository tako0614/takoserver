import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  parseWorkerBundleManifest,
  validateWorkerBundlePayload,
} from "../src/takoform-v2/forms/worker-bundle.ts";

const MODULE_COMMIT = "c51bc2393d869d27e8ca8c2d735d7f39705cad8e";
const RAW_MODULE_ROOT = `https://raw.githubusercontent.com/tako0614/takoserver/${MODULE_COMMIT}/tests/fixtures/v2-public-worker-bundle`;

for (const [version, expectedBody, expectedSha256, expectedManifestSha256] of [
  [
    "v1",
    "public-worker-bundle-v1\n",
    "51119092dfdf5ce76cb28ad8db9fb3792bf043972b2661304efdac1ce2e5927f",
    "b5edfba17233833d2318d90d5f7831fe5981dc23822e5e79614721576d9c1d77",
  ],
  [
    "v2",
    "public-worker-bundle-v2\n",
    "4426c5708f2d0430173e14844a10aed6b0a5782392a8284f331922186eae99bf",
    "91c2b157b13d0e9efcbafc30a71f607643dfb35614471f8b3a6deab1669b6503",
  ],
] as const) {
  test(`public WorkerBundle ${version} module has its distinct fetch response`, async () => {
    const moduleUrl = new URL(`./fixtures/v2-public-worker-bundle/${version}.mjs`, import.meta.url);
    const bytes = await readFile(moduleUrl);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha256);
    const module = (await import(moduleUrl.href)) as {
      readonly default: { fetch(request: Request): Promise<Response> };
    };
    const response = await module.default.fetch(new Request("https://worker.example.test/"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(expectedBody);
  });

  test(`public WorkerBundle ${version} manifest validates exact module bytes`, async () => {
    const root = new URL("./fixtures/v2-public-worker-bundle/", import.meta.url);
    const manifestBytes = await readFile(new URL(`${version}.json`, root));
    const moduleBytes = await readFile(new URL(`${version}.mjs`, root));
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(expectedManifestSha256);
    expect(parseWorkerBundleManifest(manifestBytes)).toEqual({
      entrypoint: "src/main.mjs",
      files: [
        {
          path: "src/main.mjs",
          url: `${RAW_MODULE_ROOT}/${version}.mjs`,
          sha256: expectedSha256,
          mediaType: "application/javascript+module",
        },
      ],
    });
    // Spec URL is synthetic for local byte validation; the immutable manifest
    // URL is formed from the commit containing these JSON files after freeze.
    const spec = {
      artifact: {
        url: `https://artifacts.example.test/public-worker-bundle/${version}.json`,
        sha256: expectedManifestSha256,
      },
    };
    const observed = await validateWorkerBundlePayload({
      spec,
      manifestBytes,
      fileBytes: [moduleBytes],
    });
    expect(observed.observed).toMatchObject({
      manifestSha256: expectedManifestSha256,
      fileCount: 1,
      entrypoint: "src/main.mjs",
      files: [{ path: "src/main.mjs", sha256: expectedSha256 }],
    });

    const changedModule = Uint8Array.from(moduleBytes);
    changedModule[0] = changedModule[0] === 0 ? 1 : 0;
    await expect(
      validateWorkerBundlePayload({ spec, manifestBytes, fileBytes: [changedModule] }),
    ).rejects.toMatchObject({ code: "invalid_artifact" });
  });
}
