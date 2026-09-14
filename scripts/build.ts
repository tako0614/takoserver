import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = mkdtempSync(join(tmpdir(), "takoserver-build-"));
try {
  const result = await Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: output,
    target: "bun",
    sourcemap: "external",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
  }

  const workflowRuntime = await Bun.build({
    entrypoints: ["src/workflow-runtime.ts"],
    outdir: output,
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
    sourcemap: "none",
  });
  if (!workflowRuntime.success) {
    for (const log of workflowRuntime.logs) console.error(log);
    process.exitCode = 1;
  } else {
    const source = (await Promise.all(workflowRuntime.outputs.map((entry) => entry.text()))).join(
      "\n",
    );
    if (workflowRuntime.outputs.length === 0) {
      throw new Error("workflow runtime browser bundle produced no output");
    }
    // The neutral package must be usable by a browser-target host.  A broad
    // token check is intentional here: minification removes comments, so any
    // remaining Bun/process/node reference is executable dependency surface.
    if (/\b(?:Bun|process)\b|\bnode:/u.test(source)) {
      throw new Error("workflow runtime browser bundle contains Bun/node/process dependency");
    }
  }

  const workflowRuntimeWorkerd = await Bun.build({
    entrypoints: ["src/workflow-runtime-workerd.ts"],
    outdir: output,
    target: "bun",
    format: "esm",
    splitting: false,
    sourcemap: "none",
  });
  if (!workflowRuntimeWorkerd.success) {
    for (const log of workflowRuntimeWorkerd.logs) console.error(log);
    process.exitCode = 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
