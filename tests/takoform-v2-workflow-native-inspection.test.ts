import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { WorkerModuleInspectionModule } from "../src/worker-module-inspection-contract.ts";
import {
  classifyWorkflowClassExecution,
  createWorkerdWorkerModuleInspector,
} from "../src/workerd-worker-module-inspector.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const workerd = nativeEvidenceBinary("workerd-artifact") ?? null;
const repositoryRoot = resolve(import.meta.dir, "..");
const encoder = new TextEncoder();

function module(source: string): WorkerModuleInspectionModule {
  const bytes = encoder.encode(source);
  return {
    name: "worker.mjs",
    mediaType: "application/javascript+module",
    bytes,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function inspect(source: string, binary: string | null = workerd) {
  return createWorkerdWorkerModuleInspector({ repositoryRoot, binary }).inspectWorkflowClass({
    mainModule: "worker.mjs",
    modules: [module(source)],
    className: "ReportWorkflow",
  });
}

test("Workflow class verdict requires a clean authenticated native child", () => {
  const nonce = "testnonce012345678901234567890123:";
  const execution = {
    childExited: true,
    exitCode: 0,
    timedOut: false,
    outputExceeded: false,
    stderr: "",
    stdout: `${nonce}start\n${nonce}invalid\n`,
  };
  expect(classifyWorkflowClassExecution(execution, nonce)).toEqual({
    outcome: "invalid",
    error: "workflow_class_invalid",
  });
  for (const altered of [
    { ...execution, exitCode: 1 },
    { ...execution, childExited: false },
    { ...execution, stdout: `${nonce}start\n` },
    { ...execution, stdout: `${nonce}start\n${nonce}valid\n${nonce}invalid\n` },
  ])
    expect(classifyWorkflowClassExecution(altered, nonce)).toEqual({
      outcome: "unavailable",
      retryable: true,
    });
});

test("Workflow inspector refuses absent native authority and invalid class input", async () => {
  expect(await inspect("export class ReportWorkflow { run() {} }", null)).toEqual({
    outcome: "unavailable",
    retryable: true,
  });
  expect(
    await createWorkerdWorkerModuleInspector({ repositoryRoot, binary: null }).inspectWorkflowClass(
      {
        mainModule: "worker.mjs",
        modules: [module("export class ReportWorkflow { run() {} }")],
        className: "1Bad",
      },
    ),
  ).toEqual({ outcome: "unavailable", retryable: true });
});

test.skipIf(workerd === null)(
  "pinned workerd inspects named constructible Workflow class without invoking constructor or run",
  async () => {
    expect(
      await inspect(`export class Base { run() { throw new Error("run invoked"); } }
export class ReportWorkflow extends Base {
  constructor() { super(); throw new Error("constructor invoked"); }
}`),
    ).toEqual({ outcome: "valid" });
  },
);

test.skipIf(workerd === null)(
  "pinned workerd accepts a callable run beyond 32 inherited prototypes",
  async () => {
    const intermediateBases = Array.from(
      { length: 40 },
      (_, index) => `class Base${index + 1} extends Base${index} {}`,
    ).join("\n");
    expect(
      await inspect(`class Base0 { run() {} }
${intermediateBases}
export class ReportWorkflow extends Base40 {}`),
    ).toEqual({ outcome: "valid" });
  },
);

test.skipIf(workerd === null)(
  "pinned workerd rejects missing, accessor and non-callable prototype run",
  async () => {
    for (const source of [
      "export class Other { run() {} }",
      "export class ReportWorkflow {}",
      "export class ReportWorkflow { get run() { throw new Error('getter invoked'); } }",
      "export class ReportWorkflow {} ReportWorkflow.prototype.run = 3;",
    ])
      expect(await inspect(source)).toEqual({
        outcome: "invalid",
        error: "workflow_class_invalid",
      });
  },
);

test.skipIf(workerd === null)(
  "tenant module cannot forge Workflow class inspection by replacing host intrinsics",
  async () => {
    expect(
      await inspect(`Object.getOwnPropertyDescriptor = () => ({ value: () => {} });
Reflect.construct = () => ({});
Reflect.apply = (_fn, _receiver, args) => console.log(String(args?.[0]).replace("invalid", "valid"));
export class ReportWorkflow {}`),
    ).toEqual({ outcome: "invalid", error: "workflow_class_invalid" });
  },
);
