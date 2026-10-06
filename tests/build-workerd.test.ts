import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

test("build plan reports default bounded resources and the canonical artifact pin", async () => {
  const result = await runBuildScript(["--plan", "--state-root", "/tmp/workerd-build-plan-test"]);

  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    kind: "workerd-build-plan",
    target: "//src/workerd/server:workerd",
    artifactSha256: WORKERD_CLOSED_GRAPH_ARTIFACT.sha256,
    version: WORKERD_CLOSED_GRAPH_ARTIFACT.version,
    resources: { jobs: 2, memoryMB: 8192 },
    bazelResourceArgs: ["--jobs=2", "--local_resources=cpu=2", "--local_resources=memory=8192"],
    nativeQualification: "not-run",
  });
});

test("build plan carries caller-selected local resource budgets through to Bazel", async () => {
  const result = await runBuildScript([
    "--plan",
    "--state-root",
    "/tmp/workerd-build-plan-test",
    "--jobs",
    "3",
    "--memory-mb",
    "6144",
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    resources: { jobs: 3, memoryMB: 6144 },
    bazelResourceArgs: ["--jobs=3", "--local_resources=cpu=3", "--local_resources=memory=6144"],
  });
});

test.each([
  ["--jobs", "0"],
  ["--jobs", "1.5"],
  ["--memory-mb", "-1"],
  ["--memory-mb", "not-a-number"],
])("build plan rejects malformed resource value %s %s", async (option, value) => {
  const result = await runBuildScript([
    "--plan",
    "--state-root",
    "/tmp/workerd-build-plan-test",
    option,
    value,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`${option} requires a positive integer`);
});

test("build plan refuses to combine with source preparation", async () => {
  const result = await runBuildScript([
    "--plan",
    "--prepare-only",
    "--state-root",
    "/tmp/workerd-build-plan-test",
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--plan cannot be combined with --prepare-only");
});

test("native artifact workflow allows the pinned two-worker build to finish and report", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/workerd-closed-graph-build.yml"),
    "utf8",
  );
  const buildStep = workflow.match(
    /- name: Build the pinned artifact \(no native qualification\)([\s\S]*?)(?=\n      - name:)/u,
  )?.[1];

  expect(workflow).toContain("timeout-minutes: 150");
  expect(buildStep).toContain("timeout --signal=TERM --kill-after=30s 120m");
  expect(buildStep).toContain("--jobs 2");
  expect(buildStep).toContain("--memory-mb 8192");
  expect(workflow).toContain('if: success()');
  expect(workflow).toContain('if: failure()');
});

async function runBuildScript(arguments_: readonly string[]): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn("bun", ["scripts/build-workerd.ts", ...arguments_], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}
