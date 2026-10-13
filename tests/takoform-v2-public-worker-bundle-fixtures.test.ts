import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

for (const [version, expectedBody, expectedSha256] of [
  [
    "v1",
    "public-worker-bundle-v1\n",
    "51119092dfdf5ce76cb28ad8db9fb3792bf043972b2661304efdac1ce2e5927f",
  ],
  [
    "v2",
    "public-worker-bundle-v2\n",
    "4426c5708f2d0430173e14844a10aed6b0a5782392a8284f331922186eae99bf",
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
}
