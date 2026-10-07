import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyBuiltWorkerd } from "../scripts/build-workerd.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const MISMATCH_SHA256 = "506d105f39b23a84a7e9e77434c552c78dfaafa57aecab983c166a34f8c7d1d6";

test("a mismatched compiled binary is quarantined with build evidence and never replaces an accepted artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "workerd-mismatch-test-"));
  try {
    const built = join(root, "source", "bazel-bin", "src", "workerd", "server", "workerd");
    mkdirSync(resolve(built, ".."), { recursive: true });
    writeFileSync(built, "not the pinned workerd\n");
    const accepted = join(root, "artifacts", `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.sha256}`);
    mkdirSync(resolve(accepted, ".."), { recursive: true });
    writeFileSync(accepted, "untouched accepted artifact");

    await expect(
      verifyBuiltWorkerd({
        built,
        stateRoot: root,
        compilerVersion: WORKERD_CLOSED_GRAPH_ARTIFACT.clangVersion,
        jobs: 2,
        memoryMB: 8192,
      }),
    ).rejects.toThrow(
      `built workerd digest ${MISMATCH_SHA256}; expected ${WORKERD_CLOSED_GRAPH_ARTIFACT.sha256}`,
    );

    const quarantine = join(root, "quarantine", `workerd-digest-mismatch-${MISMATCH_SHA256}`);
    const candidate = join(quarantine, "candidate-workerd");
    expect(readFileSync(candidate, "utf8")).toBe("not the pinned workerd\n");
    expect(statSync(candidate).mode & 0o777).toBe(0o600);
    expect(statSync(quarantine).mode & 0o777).toBe(0o700);
    expect(readFileSync(accepted, "utf8")).toBe("untouched accepted artifact");
    const report = JSON.parse(readFileSync(join(quarantine, "evidence.json"), "utf8"));
    expect(report).toMatchObject({
      kind: "takoserver.workerd-unqualified-build-diagnostic",
      nativeQualification: "not-run",
      acceptedArtifact: false,
      expectedSha256: WORKERD_CLOSED_GRAPH_ARTIFACT.sha256,
      actualSha256: MISMATCH_SHA256,
      source: {
        upstreamCommit: WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamCommit,
        upstreamArchiveSha256: WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamArchiveSha256,
      },
      patch: { overlaySha256: WORKERD_CLOSED_GRAPH_ARTIFACT.overlayPatchSha256 },
      compiler: { version: WORKERD_CLOSED_GRAPH_ARTIFACT.clangVersion },
      buildPlan: {
        target: "//src/workerd/server:workerd",
        stateRoot: root,
        resources: { jobs: 2, memoryMB: 8192 },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mismatched candidate never creates the normal accepted artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "workerd-mismatch-empty-artifacts-"));
  try {
    const built = join(root, "built-workerd");
    writeFileSync(built, "not the pinned workerd\n");
    mkdirSync(join(root, "artifacts"));
    await expect(
      verifyBuiltWorkerd({
        built,
        stateRoot: root,
        compilerVersion: WORKERD_CLOSED_GRAPH_ARTIFACT.clangVersion,
        jobs: 2,
        memoryMB: 8192,
      }),
    ).rejects.toThrow("unqualified candidate retained");
    expect(readdirSync(join(root, "artifacts"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    /- name: Build the pinned artifact \(no native qualification\)([\s\S]*?)(?=\n {6}- name:)/u,
  )?.[1];

  expect(workflow).toContain("timeout-minutes: 150");
  expect(buildStep).toContain("timeout --signal=TERM --kill-after=30s 120m");
  expect(buildStep).toContain("--jobs 2");
  expect(buildStep).toContain("--memory-mb 8192");
  expect(workflow).toContain("if: success()");
  expect(workflow).toContain("if: failure()");
});

test("failure upload retains only unqualified mismatch evidence beside the runner report", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/workerd-closed-graph-build.yml"),
    "utf8",
  );
  const failureStep = workflow.match(
    /- name: Upload unqualified build diagnostics on failure([\s\S]*)$/u,
  )?.[1];
  expect(failureStep).toContain("if: failure()");
  expect(failureStep).toContain("workerd-build-runner-report.txt");
  expect(failureStep).toContain("workerd-closed-graph-state/quarantine/workerd-digest-mismatch-*/");
  expect(failureStep).not.toContain("steps.build.outputs.artifact");
  expect(failureStep).toContain("unqualified");
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
