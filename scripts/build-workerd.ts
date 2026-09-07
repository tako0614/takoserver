import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const OVERLAY = join(REPOSITORY_ROOT, "workerd", "patches", "closed-module-graph.patch");
const UPSTREAM_ARCHIVE = `https://github.com/cloudflare/workerd/archive/${WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamCommit}.tar.gz`;
const WORKERD_TARGET = "//src/workerd/server:workerd";

interface BuildArguments {
  readonly stateRoot: string;
  readonly archive?: string;
  readonly prepareOnly: boolean;
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  requireLinuxX64();
  await requireDigest(OVERLAY, WORKERD_CLOSED_GRAPH_ARTIFACT.overlayPatchSha256, "overlay patch");

  const stateRoot = input.stateRoot;
  const downloads = join(stateRoot, "downloads");
  const sourceParent = join(stateRoot, "source");
  const tmp = join(stateRoot, "tmp");
  const tools = join(stateRoot, "tools");
  const artifacts = join(stateRoot, "artifacts");
  for (const directory of [stateRoot, downloads, sourceParent, tmp, tools, artifacts]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  const archive = join(downloads, `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamCommit}.tar.gz`);
  if (input.archive !== undefined) {
    await requireDigest(
      input.archive,
      WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamArchiveSha256,
      "provided upstream archive",
    );
    await copyFile(input.archive, archive);
    await chmod(archive, 0o600);
  } else {
    await downloadOnce(UPSTREAM_ARCHIVE, archive);
  }
  await requireDigest(
    archive,
    WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamArchiveSha256,
    "upstream archive",
  );

  const source = join(sourceParent, `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamCommit}`);
  if (await exists(source)) {
    throw new Error(`source path already exists; use a fresh state root: ${source}`);
  }
  const preparing = join(tmp, `source-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(preparing, { mode: 0o700 });
  await run(["tar", "-xzf", archive, "-C", preparing, "--strip-components=1"]);
  await run(["git", "-C", preparing, "apply", "--check", OVERLAY]);
  await run(["git", "-C", preparing, "apply", OVERLAY]);
  await requireDigest(
    join(
      preparing,
      "patches/v8/0039-Preserve-generated-script-host-options-for-dynamic-import.patch",
    ),
    WORKERD_CLOSED_GRAPH_ARTIFACT.v8PatchSha256,
    "V8 dependency patch",
  );
  await rename(preparing, source);

  if (input.prepareOnly) {
    console.log(JSON.stringify({ preparedSource: source, overlay: OVERLAY }));
    return;
  }

  const bazelisk = requiredAbsoluteEnvironmentPath("BAZELISK");
  await requireDigest(
    bazelisk,
    WORKERD_CLOSED_GRAPH_ARTIFACT.bazeliskSha256,
    "Bazelisk executable",
  );
  const llvmRoot = requiredAbsoluteEnvironmentPath("WORKERD_LLVM_ROOT");
  const clang = join(llvmRoot, "usr/bin/clang-20");
  const clangPlusPlus = join(llvmRoot, "usr/bin/clang++-20");
  const lld = join(llvmRoot, "usr/bin/ld.lld-20");
  const llvm = join(llvmRoot, "usr/lib/llvm-20");
  const platformLibraries = join(llvmRoot, "usr/lib/x86_64-linux-gnu");
  for (const executable of [clang, clangPlusPlus, lld]) await requireExecutable(executable);
  const libraryPath = `${platformLibraries}:${join(llvm, "lib")}`;
  const clangVersion = await output([clang, "--version"], { LD_LIBRARY_PATH: libraryPath });
  if (!clangVersion.startsWith(WORKERD_CLOSED_GRAPH_ARTIFACT.clangVersion)) {
    throw new Error(
      `unsupported compiler: expected ${WORKERD_CLOSED_GRAPH_ARTIFACT.clangVersion}, got ${clangVersion.split("\n")[0] ?? ""}`,
    );
  }

  const toolClang = join(tools, "clang");
  const toolClangPlusPlus = join(tools, "clang++");
  const toolLld = join(tools, "ld.lld");
  await symlink(clang, toolClang);
  await symlink(clangPlusPlus, toolClangPlusPlus);
  await symlink(lld, toolLld);

  const environment = {
    // Every cache and tool-created dotfile belongs to this one build root.
    // In particular, do not let Bazel repositories or compiler helpers fall
    // back to the operator account's global HOME/XDG locations.
    HOME: stateRoot,
    XDG_CACHE_HOME: join(stateRoot, "cache/xdg"),
    XDG_CONFIG_HOME: join(stateRoot, "config"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: `${tools}:/usr/bin:/bin`,
    BAZELISK_HOME: join(stateRoot, "cache/bazelisk"),
    BAZELISK_SKIP_WRAPPER: "true",
    BAZEL_COMPILER: "clang",
    CC: toolClang,
    CXX: toolClangPlusPlus,
    LD_LIBRARY_PATH: libraryPath,
    TMPDIR: tmp,
  };
  await run(
    [
      bazelisk,
      `--output_user_root=${join(stateRoot, "bazel-output")}`,
      "build",
      WORKERD_TARGET,
      `--repository_cache=${join(stateRoot, "repository-cache")}`,
      `--action_env=LD_LIBRARY_PATH=${libraryPath}`,
      `--host_action_env=LD_LIBRARY_PATH=${libraryPath}`,
      `--action_env=TMPDIR=${tmp}`,
      `--host_action_env=TMPDIR=${tmp}`,
      `--copt=-resource-dir=${join(llvm, "lib/clang/20")}`,
      `--host_copt=-resource-dir=${join(llvm, "lib/clang/20")}`,
      `--cxxopt=-isystem${join(llvm, "include/c++/v1")}`,
      `--host_cxxopt=-isystem${join(llvm, "include/c++/v1")}`,
      `--linkopt=-L${join(llvm, "lib")}`,
      `--host_linkopt=-L${join(llvm, "lib")}`,
      "--strategy=CppCompile=local",
    ],
    source,
    environment,
  );

  await requireDigest(
    join(
      environment.BAZELISK_HOME,
      "downloads/sha256",
      WORKERD_CLOSED_GRAPH_ARTIFACT.bazelSha256,
      "bin/bazel",
    ),
    WORKERD_CLOSED_GRAPH_ARTIFACT.bazelSha256,
    "Bazel executable selected by Bazelisk",
  );

  const built = join(source, "bazel-bin/src/workerd/server/workerd");
  await requireDigest(built, WORKERD_CLOSED_GRAPH_ARTIFACT.sha256, "built workerd");
  const artifact = join(artifacts, `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.sha256}`);
  await copyFile(built, artifact);
  await chmod(artifact, 0o755);
  console.log(
    JSON.stringify({
      artifact,
      sha256: WORKERD_CLOSED_GRAPH_ARTIFACT.sha256,
      version: WORKERD_CLOSED_GRAPH_ARTIFACT.version,
    }),
  );
}

function parseArguments(arguments_: readonly string[]): BuildArguments {
  let stateRoot: string | undefined;
  let archive: string | undefined;
  let prepareOnly = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--prepare-only") {
      prepareOnly = true;
      continue;
    }
    if (argument === "--state-root" || argument === "--archive") {
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new Error(`${argument} requires an absolute path`);
      }
      if (argument === "--state-root") stateRoot = value;
      else archive = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument ?? ""}`);
  }
  if (stateRoot === undefined) {
    throw new Error(
      "usage: bun run build:workerd -- --state-root /absolute/private/path [--archive /absolute/workerd.tar.gz] [--prepare-only]",
    );
  }
  return archive === undefined ? { stateRoot, prepareOnly } : { stateRoot, archive, prepareOnly };
}

function requireLinuxX64(): void {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("the pinned workerd artifact build supports linux/x64 only");
  }
}

function requiredAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name];
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

async function requireExecutable(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || (!metadata.isFile() && !metadata.isSymbolicLink())) {
    throw new Error(`required executable is missing: ${path}`);
  }
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

async function downloadOnce(url: string, path: string): Promise<void> {
  if (await exists(path)) return;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`upstream archive download failed: HTTP ${response.status}`);
  const temporary = `${path}.part-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
  await rename(temporary, path);
}

async function requireDigest(path: string, expected: string, subject: string): Promise<void> {
  const actual = await fileSha256(path).catch(() => "missing");
  if (actual !== expected) throw new Error(`${subject} digest ${actual}; expected ${expected}`);
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function output(
  command: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  const child = Bun.spawn({ cmd: [...command], env: { ...env }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command[0] ?? "command"} failed: ${stderr.trim()}`);
  return stdout;
}

async function run(
  command: readonly string[],
  cwd: string = REPOSITORY_ROOT,
  env: Readonly<Record<string, string>> = process.env as Readonly<Record<string, string>>,
): Promise<void> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env: { ...env },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command[0] ?? "command"} exited ${exitCode}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "workerd build failed");
  process.exitCode = 1;
});
