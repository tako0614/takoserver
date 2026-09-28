import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkerdRuntime,
  readWorkerdActiveActorGraph,
  type WorkerdDeploymentPublication,
} from "../src/workerd-runtime.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-actor-graph-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function publication(generation: string): WorkerdDeploymentPublication {
  const version = (suffix: "a" | "b", weight: number) => ({
    versionId: `version-${suffix}`,
    workerVersionUid: `worker-version-${suffix}`,
    weight,
    site: {
      directory: "actor-worker",
      mainModule: "index.js",
      hostEntrypoint: "__host.js",
      hostnames: [],
      generation,
      workerResourceUid: "actor-worker-uid",
      fetchHandler: true,
    },
    modules: new Map([
      [
        "index.js",
        new TextEncoder().encode(
          `export const version = ${JSON.stringify(`${generation}-${suffix}`)};`,
        ),
      ],
    ]),
    hostModules: new Map([
      ["__host.js", new TextEncoder().encode('export { version } from "./index.js";')],
    ]),
  });
  return {
    generation,
    workerResourceUid: "actor-worker-uid",
    hostnames: [],
    versions: [version("b", 9_999), version("a", 1)],
  };
}

test("reads every weighted Actor Version as one verified active graph", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  await runtime.publish("actor-worker", publication("generation-1"));

  const graph = await readWorkerdActiveActorGraph(root, "actor-worker", "actor-worker-uid");
  expect(graph).not.toBeNull();
  expect(graph).toMatchObject({
    generation: "generation-1",
    workerResourceUid: "actor-worker-uid",
  });
  expect(
    graph?.versions.map(({ versionId, variantKey, weight }) => ({ versionId, variantKey, weight })),
  ).toEqual([
    { versionId: "version-a", variantKey: "worker-version-a", weight: 1 },
    { versionId: "version-b", variantKey: "worker-version-b", weight: 9_999 },
  ]);
  expect(new TextDecoder().decode(graph?.versions[0]?.modules.get("index.js"))).toContain(
    "generation-1-a",
  );
  expect(new TextDecoder().decode(graph?.versions[1]?.modules.get("index.js"))).toContain(
    "generation-1-b",
  );
});

test("rejects the whole active Actor graph when any Version bytes are tampered", async () => {
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  await runtime.publish("actor-worker", publication("generation-1"));
  const pointer = JSON.parse(
    await readFile(join(root, "workers", "actor-worker", "takoserver-site.json"), "utf8"),
  ) as { generationKey: string };
  const deploymentPath = join(
    root,
    "workers",
    ".publications",
    "actor-worker",
    pointer.generationKey,
    "deployment.json",
  );
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as {
    versions: readonly {
      storageKey: string;
      manifest: { moduleFiles: { application: readonly { key: string }[] } };
    }[];
  };
  const second = deployment.versions[1];
  if (!second) throw new Error("second Version is unavailable");
  const moduleKey = second.manifest.moduleFiles.application[0]?.key;
  if (!moduleKey) throw new Error("second Version module is unavailable");
  await writeFile(
    join(
      root,
      "workers",
      ".publications",
      "actor-worker",
      pointer.generationKey,
      second.storageKey,
      "application",
      moduleKey,
    ),
    "tampered",
  );

  await expect(
    readWorkerdActiveActorGraph(root, "actor-worker", "actor-worker-uid"),
  ).rejects.toThrow("unusable worker active Actor graph");
});
