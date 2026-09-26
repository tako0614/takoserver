import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const OVERLAY = join(REPOSITORY_ROOT, "workerd", "patches", "closed-module-graph.patch");
const WORKER_LOADER_CANDIDATE_OVERLAY = join(
  REPOSITORY_ROOT,
  "workerd",
  "patches",
  "worker-loader-closed-graph.candidate.patch",
);
const WORKER_LOADER_CANDIDATE_OVERLAY_SHA256 =
  "5a65dc6c02b1b444513e670b3b44eaf6cf4ea419a1590c73a39a72cbdc15b7d7";
const UPSTREAM_ARCHIVE = `https://github.com/cloudflare/workerd/archive/${WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamCommit}.tar.gz`;
const WORKERD_TARGET = "//src/workerd/server:workerd";

interface BuildArguments {
  readonly stateRoot: string;
  readonly archive?: string;
  readonly prepareOnly: boolean;
  readonly candidateWorkflowLoader: boolean;
  readonly jobs?: number;
  readonly memoryMiB?: number;
}

export interface WorkerdOverlay {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
}

export interface WorkflowLoaderCandidateProvenance {
  readonly kind: "takoserver.workerd-candidate@v1";
  readonly candidate: "worker-loader-closed-graph";
  readonly identity: `sha256:${string}`;
  readonly takoserverCommit: string;
  readonly buildScriptSha256: string;
  readonly upstreamCommit: string;
  readonly upstreamArchiveSha256: string;
  readonly toolchain: {
    readonly bazeliskSha256: string;
    readonly bazelSha256: string;
    readonly clangVersion: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly overlays: readonly { readonly name: string; readonly sha256: string }[];
  readonly nativeQualification: "not-run";
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  requireLinuxX64();
  await requireDigest(OVERLAY, WORKERD_CLOSED_GRAPH_ARTIFACT.overlayPatchSha256, "overlay patch");

  const candidateProvenance = input.candidateWorkflowLoader
    ? await createWorkflowLoaderCandidateProvenance({
        takoserverCommit: await output(
          ["/usr/bin/git", "-C", REPOSITORY_ROOT, "rev-parse", "HEAD"],
          {},
        ),
        buildScriptSha256: await fileSha256(import.meta.path),
      })
    : null;
  const candidateOverlays = input.candidateWorkflowLoader
    ? workflowLoaderCandidateOverlays()
    : null;
  if (candidateOverlays !== null) {
    await verifyOverlayDigests(candidateOverlays);
  }

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

  const sourceName =
    candidateProvenance === null
      ? `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamCommit}`
      : `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamCommit}-candidate-${candidateProvenance.identity.slice(7, 23)}`;
  const source = join(sourceParent, sourceName);
  if (await exists(source)) {
    throw new Error(`source path already exists; use a fresh state root: ${source}`);
  }
  const preparing = join(tmp, `source-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(preparing, { mode: 0o700 });
  await run(["tar", "-xzf", archive, "-C", preparing, "--strip-components=1"]);
  if (candidateOverlays === null) {
    await run(["git", "-C", preparing, "apply", "--check", OVERLAY]);
    await run(["git", "-C", preparing, "apply", OVERLAY]);
  } else {
    await applyWorkerdOverlays(preparing, candidateOverlays);
  }
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
    console.log(
      JSON.stringify(
        candidateProvenance === null
          ? { preparedSource: source, overlay: OVERLAY }
          : {
              preparedSource: source,
              provenance: candidateProvenance,
              qualification: "combined-overlays-applied; native-build-and-probe-not-run",
            },
      ),
    );
    return;
  }

  if (candidateProvenance !== null) {
    const status = await output(
      ["/usr/bin/git", "-C", REPOSITORY_ROOT, "status", "--porcelain"],
      {},
    );
    if (status !== "") {
      throw new Error("candidate build requires a clean Takoserver worktree for provenance");
    }
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
      ...(candidateProvenance === null
        ? []
        : workflowLoaderCandidateResourceArguments({
            jobs: input.jobs ?? 2,
            memoryMiB: input.memoryMiB ?? 8192,
          })),
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
  if (candidateProvenance === null) {
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
    return;
  }

  const candidate = await publishWorkflowLoaderCandidate({
    built,
    artifactsRoot: artifacts,
    provenance: candidateProvenance,
  });
  console.log(JSON.stringify(candidate));
}

export function workflowLoaderCandidateOverlays(): readonly WorkerdOverlay[] {
  return [
    {
      name: "closed-module-graph",
      path: OVERLAY,
      sha256: WORKERD_CLOSED_GRAPH_ARTIFACT.overlayPatchSha256,
    },
    {
      name: "worker-loader-closed-graph-candidate",
      path: WORKER_LOADER_CANDIDATE_OVERLAY,
      sha256: WORKER_LOADER_CANDIDATE_OVERLAY_SHA256,
    },
  ];
}

export function workflowLoaderCandidateResourceArguments(input: {
  readonly jobs: number;
  readonly memoryMiB: number;
}): readonly string[] {
  return [
    `--jobs=${input.jobs}`,
    `--local_resources=cpu=${input.jobs}`,
    `--local_resources=memory=${input.memoryMiB}`,
  ];
}

export async function createWorkflowLoaderCandidateProvenance(input: {
  readonly takoserverCommit: string;
  readonly buildScriptSha256: string;
}): Promise<WorkflowLoaderCandidateProvenance> {
  const takoserverCommit = input.takoserverCommit.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(takoserverCommit)) {
    throw new Error("candidate provenance requires a full Takoserver commit hash");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.buildScriptSha256)) {
    throw new Error("candidate provenance requires the build-script SHA-256");
  }
  const overlays = workflowLoaderCandidateOverlays();
  await verifyOverlayDigests(overlays);
  const identityMaterial = {
    kind: "takoserver.workerd-candidate@v1",
    candidate: "worker-loader-closed-graph",
    takoserverCommit,
    buildScriptSha256: input.buildScriptSha256,
    upstreamCommit: WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamCommit,
    upstreamArchiveSha256: WORKERD_CLOSED_GRAPH_ARTIFACT.upstreamArchiveSha256,
    toolchain: {
      bazeliskSha256: WORKERD_CLOSED_GRAPH_ARTIFACT.bazeliskSha256,
      bazelSha256: WORKERD_CLOSED_GRAPH_ARTIFACT.bazelSha256,
      clangVersion: WORKERD_CLOSED_GRAPH_ARTIFACT.clangVersion,
      platform: WORKERD_CLOSED_GRAPH_ARTIFACT.platform,
      arch: WORKERD_CLOSED_GRAPH_ARTIFACT.arch,
    },
    overlays: overlays.map(({ name, sha256 }) => ({ name, sha256 })),
  } as const;
  const hash = createHash("sha256").update(JSON.stringify(identityMaterial)).digest("hex");
  return {
    ...identityMaterial,
    identity: `sha256:${hash}`,
    nativeQualification: "not-run",
  };
}

export async function applyWorkerdOverlays(
  source: string,
  overlays: readonly WorkerdOverlay[],
  execute: typeof run = run,
): Promise<void> {
  await verifyOverlayDigests(overlays);
  for (const overlay of overlays) {
    await execute(["git", "-C", source, "apply", "--check", overlay.path]);
    await execute(["git", "-C", source, "apply", overlay.path]);
  }
}

async function verifyOverlayDigests(overlays: readonly WorkerdOverlay[]): Promise<void> {
  for (const overlay of overlays) {
    await requireDigest(overlay.path, overlay.sha256, `${overlay.name} overlay patch`);
  }
}

export async function publishWorkflowLoaderCandidate(input: {
  readonly built: string;
  readonly artifactsRoot: string;
  readonly provenance: WorkflowLoaderCandidateProvenance;
}): Promise<{
  readonly artifact: string;
  readonly sha256: string;
  readonly provenance: string;
  readonly qualification: "unqualified-native-tests-not-run";
}> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.provenance.identity)) {
    throw new Error("candidate identity must be a sha256 digest");
  }
  const candidatesRoot = join(input.artifactsRoot, "candidates");
  await mkdir(candidatesRoot, { recursive: true, mode: 0o700 });
  await chmod(candidatesRoot, 0o700);

  // The candidate namespace is intentionally disjoint from artifacts/workerd-<accepted sha>.
  // A repeated identity refuses instead of replacing an earlier candidate's bytes or record.
  const identityDirectory = join(candidatesRoot, input.provenance.identity.slice("sha256:".length));
  const stagingDirectory = await mkdtemp(join(candidatesRoot, ".candidate-install-"));
  try {
    const copiedBinary = join(stagingDirectory, "candidate-binary.tmp");
    await copyFile(input.built, copiedBinary, fsConstants.COPYFILE_EXCL);
    await chmod(copiedBinary, 0o755);
    const binarySha256 = await fileSha256(copiedBinary);
    const artifact = join(stagingDirectory, `workerd-${binarySha256}`);
    await rename(copiedBinary, artifact);
    if ((await fileSha256(artifact)) !== binarySha256) {
      throw new Error("candidate binary changed after its digest was calculated");
    }
    const publishedArtifact = join(identityDirectory, `workerd-${binarySha256}`);
    const provenance = join(stagingDirectory, "provenance.json");
    await writeFile(
      provenance,
      `${JSON.stringify(
        {
          ...input.provenance,
          binarySha256,
          binaryPath: publishedArtifact,
          qualification: "unqualified-native-tests-not-run",
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await rename(stagingDirectory, identityDirectory);
    return {
      artifact: publishedArtifact,
      sha256: binarySha256,
      provenance: join(identityDirectory, "provenance.json"),
      qualification: "unqualified-native-tests-not-run",
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseArguments(arguments_: readonly string[]): BuildArguments {
  let stateRoot: string | undefined;
  let archive: string | undefined;
  let prepareOnly = false;
  let candidateWorkflowLoader = false;
  let jobs: number | undefined;
  let memoryMiB: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--prepare-only") {
      prepareOnly = true;
      continue;
    }
    if (argument === "--candidate") {
      const value = arguments_[index + 1];
      if (value !== "workflow-loader") {
        throw new Error("--candidate supports only workflow-loader");
      }
      candidateWorkflowLoader = true;
      index += 1;
      continue;
    }
    if (
      argument === "--state-root" ||
      argument === "--archive" ||
      argument === "--jobs" ||
      argument === "--memory-mib"
    ) {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--jobs" || argument === "--memory-mib") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new Error(`${argument} requires a positive integer`);
        }
        if (argument === "--jobs") {
          if (parsed > 2) throw new Error("candidate builds are limited to 2 Bazel jobs");
          jobs = parsed;
        } else {
          if (parsed > 32768)
            throw new Error("candidate memory scheduling budget is limited to 32768 MiB");
          memoryMiB = parsed;
        }
        index += 1;
        continue;
      }
      if (!isAbsolute(value)) {
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
      "usage: bun run build:workerd -- --state-root /absolute/private/path [--archive /absolute/workerd.tar.gz] [--prepare-only] [--candidate workflow-loader [--jobs 2] [--memory-mib 8192]]",
    );
  }
  if (!candidateWorkflowLoader && (jobs !== undefined || memoryMiB !== undefined)) {
    throw new Error("--jobs and --memory-mib are candidate-only build controls");
  }
  return {
    stateRoot,
    ...(archive === undefined ? {} : { archive }),
    prepareOnly,
    candidateWorkflowLoader,
    ...(jobs === undefined ? {} : { jobs }),
    ...(memoryMiB === undefined ? {} : { memoryMiB }),
  };
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

if (Bun.main === import.meta.path) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "workerd build failed");
    process.exitCode = 1;
  });
}
