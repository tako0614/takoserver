import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkerdOverlays,
  createWorkflowLoaderCandidateProvenance,
  preflightWorkflowLoaderCandidateResources,
  publishWorkflowLoaderCandidate,
  WORKFLOW_LOADER_NATIVE_TEST_TARGETS,
  type WorkerdOverlay,
  workflowLoaderCandidateBazelArguments,
  workflowLoaderCandidateOverlays,
  workflowLoaderCandidateResourceArguments,
} from "../scripts/build-workerd.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workerd WorkerLoader candidate build inputs", () => {
  test("manual hosted workflow builds only an isolated, explicitly unqualified candidate", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/workerd-workflow-loader-candidate.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*$/mu);
    expect(workflow).not.toMatch(/^\s*(?:push|pull_request):/mu);
    expect(workflow).toContain("runs-on: ubuntu-26.04");
    expect(workflow).toContain("--no-upgrade --no-remove --no-install-recommends");
    for (const packageName of ["libc++-20-dev", "libc++abi-20-dev", "libunwind-20-dev"]) {
      expect(workflow).toContain(`${packageName}=\${expected_package_version}`);
    }
    expect(workflow).toContain(`\${package}_version=\${actual_dev_version}`);
    expect(workflow).toContain(`"\${actual_dev_version}" != "\${expected_package_version}"`);
    expect(workflow).toContain("timeout-minutes: 260");
    expect(workflow).toContain("timeout --signal=TERM --kill-after=30s 180m");
    expect(workflow).toContain("timeout --signal=TERM --kill-after=30s 60m");
    expect(workflow).toContain("cpu.max");
    expect(workflow).toContain("cpuset.cpus.effective");
    expect(workflow).toContain("--preflight-only");
    expect(workflow).toContain("--candidate workflow-loader");
    expect(workflow).toContain("--jobs 4");
    expect(workflow).toContain("--memory-mib 12288");
    expect(workflow).toContain(`pipeline_statuses=("\${PIPESTATUS[@]}")`);
    expect(workflow).toContain(`tee_status=\${pipeline_statuses[1]:-1}`);
    expect(workflow).toContain("capture_failure:");
    expect(workflow).toContain("native-tests-not-run");
    expect(workflow).toContain("--native-qualification-only");
    expect(workflow.indexOf("Upload unqualified candidate binary and provenance")).toBeLessThan(
      workflow.indexOf("Run native WorkerLoader candidate qualification targets"),
    );
    expect(workflow).toContain("Upload separate native qualification report");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).not.toMatch(/\b(?:bun test|bun run test|bazel test)\b/u);
    expect(workflow).not.toContain("TAKOSERVER_WORKERD_BINARY");
    expect(workflow).not.toMatch(/\b(?:wrangler deploy|bun run deploy)\b/u);
  });

  test("emits separate Bazel local-resource assignments", () => {
    expect(workflowLoaderCandidateResourceArguments({ jobs: 2, memoryMiB: 8192 })).toEqual([
      "--jobs=2",
      "--local_resources=cpu=2",
      "--local_resources=memory=8192",
    ]);
    expect(workflowLoaderCandidateResourceArguments({ jobs: 4, memoryMiB: 12288 })).toEqual([
      "--jobs=4",
      "--local_resources=cpu=4",
      "--local_resources=memory=12288",
    ]);
    expect(() => workflowLoaderCandidateResourceArguments({ jobs: 5, memoryMiB: 8192 })).toThrow(
      "limited to 4 Bazel jobs",
    );
    expect(() => workflowLoaderCandidateResourceArguments({ jobs: 2, memoryMiB: 12289 })).toThrow(
      "limited to 12288 MiB",
    );
  });

  test("preflight reports effective limits and refuses unsupported requested budgets", async () => {
    await expect(
      preflightWorkflowLoaderCandidateResources({
        jobs: 4,
        memoryMiB: 12288,
        cpuQuota: "400000 100000",
        cpuset: "0-3",
        memoryLimit: String(16 * 1024 * 1024 * 1024),
        physicalMemoryKiB: 16 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      requestedJobs: 4,
      requestedMemoryMiB: 12288,
      effectiveCpuCount: 4,
      effectiveMemoryMiB: 16384,
    });
    await expect(
      preflightWorkflowLoaderCandidateResources({
        jobs: 4,
        memoryMiB: 8192,
        cpuQuota: "200000 100000",
        cpuset: "0-3",
        memoryLimit: "max",
        physicalMemoryKiB: 16 * 1024 * 1024,
      }),
    ).rejects.toThrow("requested 4 Bazel jobs but runner exposes 2 CPU(s)");
    await expect(
      preflightWorkflowLoaderCandidateResources({
        jobs: 2,
        memoryMiB: 12288,
        cpuQuota: "400000 100000",
        cpuset: "0-3",
        memoryLimit: String(8 * 1024 * 1024 * 1024),
        physicalMemoryKiB: 16 * 1024 * 1024,
      }),
    ).rejects.toThrow("requested 12288 MiB Bazel memory but runner exposes 8192 MiB");
  });

  test("native build and test commands share the exact resource, cache, and toolchain flags", () => {
    const common = {
      stateRoot: "/tmp/workerd-candidate",
      llvm: "/usr/lib/llvm-20",
      tmp: "/tmp/workerd-candidate/tmp",
      libraryPath: "/usr/lib/x86_64-linux-gnu:/usr/lib/llvm-20/lib",
      jobs: 4,
      memoryMiB: 12288,
    };
    const build = workflowLoaderCandidateBazelArguments({
      ...common,
      command: "build",
      targets: ["//src/workerd/server:workerd"],
    });
    const tests = workflowLoaderCandidateBazelArguments({
      ...common,
      command: "test",
      targets: ["//src/workerd/api/tests:worker-loader-test"],
    });
    expect(build).toContain("--output_user_root=/tmp/workerd-candidate/bazel-output");
    expect(tests).toContain("--output_user_root=/tmp/workerd-candidate/bazel-output");
    expect(build).toContain("--repository_cache=/tmp/workerd-candidate/repository-cache");
    expect(tests).toContain("--repository_cache=/tmp/workerd-candidate/repository-cache");
    expect(build).toContain("--jobs=4");
    expect(tests).toContain("--jobs=4");
    expect(build).toContain("--local_resources=memory=12288");
    expect(tests).toContain("--local_resources=memory=12288");
    expect(tests).toContain("--strategy=CppCompile=local");
    expect(tests).toContain("--cxxopt=-isystem/usr/lib/llvm-20/include/c++/v1");
    const withoutAction = (args: readonly string[]) =>
      args.filter(
        (argument) => argument !== "build" && argument !== "test" && !argument.startsWith("//"),
      );
    expect(withoutAction(build)).toEqual(withoutAction(tests));
    expect(WORKFLOW_LOADER_NATIVE_TEST_TARGETS).toEqual([
      "//src/workerd/tests:closed-module-graph-test",
      "//src/workerd/tests:module-imports-test",
      "//src/workerd/api/tests:new-module-registry-test",
      "//src/workerd/api/tests:new-module-registry-startup-eval-test",
      "//src/workerd/jsg:modules-new-test",
      "//src/workerd/jsg:resource-test",
      "//src/workerd/api/tests:worker-loader-test",
    ]);
  });

  test("selects both patches in closed-graph then WorkerLoader candidate order", async () => {
    const overlays = workflowLoaderCandidateOverlays();
    const calls: string[] = [];
    const execute = async (command: readonly string[]) => {
      calls.push(command.slice(3).join(" "));
    };

    await applyWorkerdOverlays("/isolated/source", overlays, execute);

    expect(overlays.map((overlay) => overlay.name)).toEqual([
      "closed-module-graph",
      "worker-loader-closed-graph-candidate",
    ]);
    expect(calls).toEqual(
      overlays.flatMap(({ path }) => [`apply --check ${path}`, `apply ${path}`]),
    );
  });

  test("binds deterministic candidate provenance to commit, script, upstream, and both patch digests", async () => {
    const first = await createWorkflowLoaderCandidateProvenance({
      takoserverCommit: "1bf21189de367c33787216c4c3b6d5d9382d3366\n",
      buildScriptSha256: "a".repeat(64),
    });
    const repeat = await createWorkflowLoaderCandidateProvenance({
      takoserverCommit: "1bf21189de367c33787216c4c3b6d5d9382d3366",
      buildScriptSha256: "a".repeat(64),
    });
    const changedSource = await createWorkflowLoaderCandidateProvenance({
      takoserverCommit: "2bf21189de367c33787216c4c3b6d5d9382d3366",
      buildScriptSha256: "a".repeat(64),
    });

    expect(first).toEqual(repeat);
    expect(first.identity).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.identity).not.toContain(
      "c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52",
    );
    expect(first.overlays.map(({ name }) => name)).toEqual([
      "closed-module-graph",
      "worker-loader-closed-graph-candidate",
    ]);
    expect(first.toolchain).toMatchObject({
      bazeliskSha256: expect.any(String),
      bazelSha256: expect.any(String),
      clangVersion: expect.stringContaining("clang version 20.1.8"),
      platform: "linux",
      arch: "x64",
    });
    expect(first.nativeQualification).toBe("not-run");
    expect(changedSource.identity).not.toBe(first.identity);
  });

  test("refuses incomplete provenance inputs", async () => {
    await expect(
      createWorkflowLoaderCandidateProvenance({
        takoserverCommit: "1bf2118",
        buildScriptSha256: "a".repeat(64),
      }),
    ).rejects.toThrow("full Takoserver commit hash");
    await expect(
      createWorkflowLoaderCandidateProvenance({
        takoserverCommit: "1".repeat(41),
        buildScriptSha256: "a".repeat(64),
      }),
    ).rejects.toThrow("full Takoserver commit hash");
    await expect(
      createWorkflowLoaderCandidateProvenance({
        takoserverCommit: "1bf21189de367c33787216c4c3b6d5d9382d3366",
        buildScriptSha256: "not-a-digest",
      }),
    ).rejects.toThrow("build-script SHA-256");
  });

  test("refuses a changed candidate patch before invoking patch application", async () => {
    const overlays = workflowLoaderCandidateOverlays();
    const activeOverlay = overlays[0];
    const candidateOverlay = overlays[1];
    if (activeOverlay === undefined || candidateOverlay === undefined) {
      throw new Error("candidate overlays missing");
    }
    const changedCandidate: WorkerdOverlay = {
      ...candidateOverlay,
      sha256: "0".repeat(64),
    };
    const calls: string[] = [];

    await expect(
      applyWorkerdOverlays(
        "/isolated/source",
        [activeOverlay, changedCandidate],
        async (command) => {
          calls.push(command.join(" "));
        },
      ),
    ).rejects.toThrow(/worker-loader-closed-graph-candidate overlay patch digest/u);

    expect(calls).toEqual([]);
  });

  test("applies sequential patch contexts and refuses the candidate patch on an unpatched source", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "entry.txt"), "base\n", { encoding: "utf8" });
    const active = await fixtureOverlay(root, "active.patch", ["base", "active"]);
    const candidate = await fixtureOverlay(root, "candidate.patch", ["active", "candidate"]);

    await applyWorkerdOverlays(source, [active, candidate]);
    await expect(readFile(join(source, "entry.txt"), "utf8")).resolves.toBe("candidate\n");

    const cleanSource = join(root, "clean-source");
    await mkdir(cleanSource);
    await writeFile(join(cleanSource, "entry.txt"), "base\n", { encoding: "utf8" });
    await expect(applyWorkerdOverlays(cleanSource, [candidate, active])).rejects.toThrow();
    await expect(readFile(join(cleanSource, "entry.txt"), "utf8")).resolves.toBe("base\n");
  });

  test("publishes only in a distinct candidate namespace and refuses overwrite", async () => {
    const root = await temporaryDirectory();
    const artifactsRoot = join(root, "artifacts");
    await mkdir(artifactsRoot, { recursive: true });
    const acceptedArtifact = join(
      artifactsRoot,
      "workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52",
    );
    await writeFile(acceptedArtifact, "accepted artifact stays untouched", { encoding: "utf8" });
    const built = join(root, "built-workerd");
    await writeFile(built, "candidate native binary", { encoding: "utf8" });
    const provenance = await createWorkflowLoaderCandidateProvenance({
      takoserverCommit: "1bf21189de367c33787216c4c3b6d5d9382d3366",
      buildScriptSha256: "b".repeat(64),
    });

    const published = await publishWorkflowLoaderCandidate({ built, artifactsRoot, provenance });
    const binaryDigest = createHash("sha256").update("candidate native binary").digest("hex");
    const record = JSON.parse(await readFile(published.provenance, "utf8")) as {
      readonly binarySha256: string;
      readonly binaryPath: string;
      readonly qualification: string;
      readonly nativeQualification: string;
    };

    expect(published.artifact).toContain(
      `/candidates/${provenance.identity.slice("sha256:".length)}/`,
    );
    expect(published.artifact).not.toBe(acceptedArtifact);
    expect(published.sha256).toBe(binaryDigest);
    const copiedBytesDigest = createHash("sha256")
      .update(await readFile(published.artifact))
      .digest("hex");
    expect(published.sha256).toBe(copiedBytesDigest);
    expect(published.artifact).toEndWith(`/workerd-${copiedBytesDigest}`);
    expect(record).toMatchObject({
      binarySha256: binaryDigest,
      binaryPath: published.artifact,
      qualification: "unqualified-native-tests-not-run",
      nativeQualification: "not-run",
    });
    await expect(readFile(record.binaryPath, "utf8")).resolves.toBe(
      await readFile(published.artifact, "utf8"),
    );
    await expect(readFile(acceptedArtifact, "utf8")).resolves.toBe(
      "accepted artifact stays untouched",
    );
    await expect(
      publishWorkflowLoaderCandidate({ built, artifactsRoot, provenance }),
    ).rejects.toThrow();
    await expect(readFile(acceptedArtifact, "utf8")).resolves.toBe(
      "accepted artifact stays untouched",
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-candidate-test-"));
  temporaryRoots.push(root);
  return root;
}

async function fixtureOverlay(
  root: string,
  name: string,
  [before, after]: readonly [string, string],
): Promise<WorkerdOverlay> {
  const path = join(root, name);
  const patch = `diff --git a/entry.txt b/entry.txt\n--- a/entry.txt\n+++ b/entry.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
  await writeFile(path, patch, { encoding: "utf8" });
  return {
    name,
    path,
    sha256: createHash("sha256").update(patch).digest("hex"),
  };
}
