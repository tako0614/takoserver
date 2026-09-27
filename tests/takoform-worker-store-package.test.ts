import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as workerStore from "@takoserver/core/takoform-worker-store";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import { createTakoformStore } from "../src/takoform/store.ts";

test("Worker store subpath reuses the Host store and catalog without extra runtime exports", () => {
  expect(Object.keys(workerStore).sort()).toEqual([
    "createTakoformStore",
    "stableProductionTakoformCatalog",
  ]);
  expect(workerStore.createTakoformStore).toBe(createTakoformStore);
  expect(workerStore.stableProductionTakoformCatalog).toBe(stableProductionTakoformCatalog);
});

test("Worker store package bundles without host-only runtime dependencies", async () => {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(import.meta.resolve("@takoserver/core/takoform-worker-store"))],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    plugins: [
      {
        name: "reject-host-runtime-imports",
        setup(build) {
          build.onResolve({ filter: /^(?:bun|node):/u }, (args) => {
            throw new Error(`Worker store reaches host-only import: ${args.path}`);
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  expect(result.outputs).toHaveLength(1);
  const artifact = result.outputs[0];
  if (!artifact) throw new Error("missing Worker store artifact");
  const source = await artifact.text();
  expect(new Bun.Transpiler({ loader: "js" }).scanImports(source)).toEqual([]);
});
