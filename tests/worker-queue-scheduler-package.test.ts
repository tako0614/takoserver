import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { V2QueueSchedulerOptions as ExtensionV2QueueSchedulerOptions } from "@takoserver/core/provider-extension";
import * as providerExtension from "@takoserver/core/provider-extension";
import type { V2QueueSchedulerOptions } from "../src/takoform-v2/worker-queue-scheduler.ts";
import { createV2QueueScheduler as sourceCreateV2QueueScheduler } from "../src/takoform-v2/worker-queue-scheduler.ts";

test("provider-extension exposes only the existing Worker-safe Queue scheduler factory", () => {
  expect(providerExtension.createV2QueueScheduler).toBe(sourceCreateV2QueueScheduler);
  expect("createV2QueueScheduler" in providerExtension).toBe(true);
  const typeWitness = (options: ExtensionV2QueueSchedulerOptions): V2QueueSchedulerOptions =>
    options;
  expect(typeWitness).toBeDefined();
});

test("Queue scheduler module bundles for a Worker without Node or Bun runtime", async () => {
  const entrypoint = fileURLToPath(
    new URL("../src/takoform-v2/worker-queue-scheduler.ts", import.meta.url),
  );
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    plugins: [
      {
        name: "reject-host-only-imports",
        setup(build) {
          build.onResolve({ filter: /^(?:bun|node):|workerd-runtime/u }, (args) => {
            throw new Error(`Queue scheduler reaches Host-only import: ${args.path}`);
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  expect(result.outputs).toHaveLength(1);
  const artifact = result.outputs[0];
  if (!artifact) throw new Error("missing Worker scheduler artifact");
  const source = await artifact.text();
  expect(new Bun.Transpiler({ loader: "js" }).scanImports(source)).toEqual([]);
  expect(source).not.toMatch(
    /\bBun\b|(?<![\w.])process\s*(?:\?\.|\.|\?\[|\[)|typeof\s+(?:globalThis\.)?process\b|\b(?:globalThis|self|window)\.process\b|\bnode:/u,
  );
});
