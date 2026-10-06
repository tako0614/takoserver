import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const prerequisiteScript = resolve(repositoryRoot, "scripts/workerd-toolchain-prerequisites.sh");
const workflowPath = resolve(repositoryRoot, ".github/workflows/workerd-closed-graph-build.yml");

test("closed-graph workflow installs and verifies libc++ before Bazelisk or build", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const initializeReportStep = workflow.indexOf("Initialize workerd build report");
  const prerequisiteStep = workflow.indexOf("scripts/workerd-toolchain-prerequisites.sh");
  const compilerVerificationStep = workflow.indexOf("Verify exact compiler prerequisites");
  const bazeliskStep = workflow.indexOf("Download and verify pinned Bazelisk");
  const buildStep = workflow.indexOf("Build the pinned artifact (no native qualification)");

  expect(initializeReportStep).toBeGreaterThan(-1);
  expect(initializeReportStep).toBeLessThan(prerequisiteStep);
  expect(prerequisiteStep).toBeGreaterThan(-1);
  expect(prerequisiteStep).toBeLessThan(compilerVerificationStep);
  expect(compilerVerificationStep).toBeLessThan(bazeliskStep);
  expect(bazeliskStep).toBeLessThan(buildStep);
  expect(workflow).toContain('} | tee -a "${report}"');
});

test("missing pinned libc++ headers fail before the following Bazel command", async () => {
  const fixture = await createFixture();
  try {
    const result = await runPrerequisites(fixture, true);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("required pinned libc++ header missing");
    expect(await fileExists(fixture.bazelMarker)).toBe(false);
    const commands = await readFile(fixture.commandLog, "utf8");
    const updateIndex = commands.indexOf("apt-get update");
    const installIndex = commands.indexOf(
      "apt-get install --yes --no-install-recommends libc++-20-dev=1:20.1.8-2ubuntu8",
    );
    expect(updateIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(updateIndex);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pinned package installation failure is reported and stops before Bazel", async () => {
  const fixture = await createFixture();
  try {
    const result = await runPrerequisites(fixture, true, true);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("could not install pinned libc++-20-dev");
    expect(await fileExists(fixture.bazelMarker)).toBe(false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("wrong installed libc++ version is rejected before the following Bazel command", async () => {
  const fixture = await createFixture();
  try {
    const result = await runPrerequisites(fixture, true, false, "1:20.1.8-0ubuntu4");

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("expected libc++-20-dev 1:20.1.8-2ubuntu8");
    expect(await fileExists(fixture.bazelMarker)).toBe(false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact libc++ package and header readback allow the next command", async () => {
  const fixture = await createFixture();
  try {
    const includeDirectory = join(fixture.toolchainRoot, "usr/lib/llvm-20/include/c++/v1");
    await mkdir(includeDirectory, { recursive: true });
    await writeFile(join(includeDirectory, "__config"), "fixture header\n");

    const result = await runPrerequisites(fixture, true);

    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(join(fixture.root, "workerd-build-runner-report.txt"), "utf8")).toContain(
      "libcxx_prerequisites=verified",
    );
    expect(await fileExists(fixture.bazelMarker)).toBe(true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly root: string;
  readonly bin: string;
  readonly toolchainRoot: string;
  readonly commandLog: string;
  readonly bazelMarker: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "workerd-toolchain-prerequisites-"));
  const bin = join(root, "bin");
  const toolchainRoot = join(root, "toolchain");
  const commandLog = join(root, "commands.log");
  const bazelMarker = join(root, "bazel-started");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "sudo"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$WORKERD_PREREQUISITE_COMMAND_LOG"\nif [[ "${WORKERD_FAIL_APT_INSTALL:-false}" == true && "$*" == "apt-get install"* ]]; then exit 42; fi\n',
  );
  await writeFile(
    join(bin, "dpkg-query"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$WORKERD_PREREQUISITE_COMMAND_LOG"\nprintf "%s\\n" "${WORKERD_LIBCXX_PACKAGE_VERSION:-1:20.1.8-2ubuntu8}"\n',
  );
  await chmod(join(bin, "sudo"), 0o755);
  await chmod(join(bin, "dpkg-query"), 0o755);
  return { root, bin, toolchainRoot, commandLog, bazelMarker };
}

async function runPrerequisites(
  fixture: Fixture,
  createBazelMarker: boolean,
  failAptInstall = false,
  packageVersion = "1:20.1.8-2ubuntu8",
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const command = [
    "set -euo pipefail",
    `WORKERD_LLVM_ROOT=${shellQuote(fixture.toolchainRoot)} bash ${shellQuote(prerequisiteScript)}`,
    ...(createBazelMarker ? [`touch ${shellQuote(fixture.bazelMarker)}`] : []),
  ].join("\n");
  const child = spawn("bash", ["-c", command], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      RUNNER_TEMP: fixture.root,
      WORKERD_PREREQUISITE_COMMAND_LOG: fixture.commandLog,
      WORKERD_FAIL_APT_INSTALL: String(failAptInstall),
      WORKERD_LIBCXX_PACKAGE_VERSION: packageVersion,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
