import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as root from "@takoserver/core";
import * as providerExtension from "@takoserver/core/provider-extension";
import * as workflowRuntime from "@takoserver/core/workflow-runtime";
import { createPackageOnlyRuntime } from "./fixtures/workflow-runtime-package-consumer.ts";

const EXPECTED_RUNTIME_EXPORTS = [
  "SqlError",
  "WorkflowCallInputError",
  "WorkflowInstanceError",
  "WorkflowRuntimeError",
  "createWorkflowRuntime",
  "isWorkflowCallInputError",
  "isWorkflowCallInputTypeError",
  "isWorkflowRuntimeError",
  "isWorkflowStepError",
] as const;

const CONCRETE_ONLY_EXPORTS = [
  "createWorkflowRuntime",
  "WorkflowCallInputError",
  "WorkflowRuntimeError",
  "isWorkflowCallInputError",
  "isWorkflowCallInputTypeError",
  "isWorkflowRuntimeError",
  "isWorkflowStepError",
] as const;

test("workflow-runtime is a curated package surface", () => {
  expect(Object.keys(workflowRuntime).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
});

test("workflow-runtime stays out of the root and provider-extension surfaces", () => {
  for (const name of CONCRETE_ONLY_EXPORTS) {
    expect(name in root).toBe(false);
    expect(name in providerExtension).toBe(false);
  }
});

test("runtime and input-error guards retain genuine class identity", () => {
  const runtimeError = new workflowRuntime.WorkflowRuntimeError("host_unavailable");
  expect(workflowRuntime.isWorkflowRuntimeError(runtimeError)).toBe(true);
  expect(workflowRuntime.isWorkflowRuntimeError(new Error("host_unavailable"))).toBe(false);

  const inputError = new workflowRuntime.WorkflowCallInputError(new TypeError("invalid input"));
  expect(workflowRuntime.isWorkflowCallInputError(inputError)).toBe(true);
  expect(workflowRuntime.isWorkflowCallInputTypeError(inputError.error)).toBe(true);
  expect(workflowRuntime.isWorkflowCallInputTypeError(new TypeError("invalid input"))).toBe(false);

  const instanceError = new workflowRuntime.WorkflowInstanceError("unknown_instance");
  expect(instanceError).toBeInstanceOf(workflowRuntime.WorkflowInstanceError);
});

test("coordinator failures use the package runtime error identity", () => {
  let thrown: unknown;
  try {
    workflowRuntime.createWorkflowRuntime({} as never);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(workflowRuntime.WorkflowRuntimeError);
  expect(workflowRuntime.isWorkflowRuntimeError(thrown)).toBe(true);
});

test("a package-only consumer can implement the neutral Host ports", () => {
  const runtime = createPackageOnlyRuntime();
  expect(runtime).toHaveProperty("instances");
  expect(typeof runtime.runOne).toBe("function");
});

test("workflow-runtime browser closure has no Bun, node, or process dependency", async () => {
  const output = mkdtempSync(join(tmpdir(), "takoserver-workflow-runtime-test-"));
  try {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "fixtures/workflow-runtime-package-consumer.ts")],
      root: resolve(import.meta.dir, ".."),
      outdir: output,
      target: "browser",
      format: "esm",
      minify: true,
      splitting: false,
      sourcemap: "none",
    });
    if (!result.success) {
      throw new Error(result.logs.map((log) => String(log)).join("\n"));
    }
    expect(result.outputs.length).toBeGreaterThan(0);
    const source = (await Promise.all(result.outputs.map((entry) => entry.text()))).join("\n");
    expect(source).not.toMatch(/\b(?:Bun|process)\b|\bnode:/u);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
