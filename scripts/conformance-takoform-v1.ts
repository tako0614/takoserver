import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bytesDigest, canonicalDigest, canonicalJson, isJsonObject } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";

/**
 * Runs the frozen stable-v1 suite and nested 125-check Host contract against
 * a disposable bundle. The frozen source remains external input: no Form,
 * Interface, or Binding bytes are vendored into Takoserver by this command.
 */

const repository = resolve(import.meta.dir, "..");
const takoform = resolve(
  process.env.TAKOFORM_PROVIDER_REPOSITORY_ROOT ??
    join(
      dirname(
        dirname(gitAt(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")),
      ),
      "terraform-provider-takoform",
    ),
);
const corpus = resolve(takoform, "conformance/takoform-v1/generic-host/portable-host");
if (
  process.env.TAKOFORM_CONFORMANCE_ROOT !== undefined &&
  resolve(process.env.TAKOFORM_CONFORMANCE_ROOT) !== corpus
) {
  throw new Error(`TASK-0032 evidence is pinned to ${corpus}`);
}

const EXPECTED_TAKOFORM_COMMIT = "c32332b550bbbc43049581d1e11766854e71fb4f";
const TAKOFORM_PATHS = [
  "go.mod",
  "go.sum",
  "cmd/portable-host-conformance",
  "formpackage",
  "internal/currentformmodel",
  "internal/currentformregistry",
  "internal/currentformselection",
  "internal/currentformsnapshot",
  "internal/portableconformancev3",
  "conformance/takoform-v1",
  "forms/candidates",
  "bindings/candidates",
  "interfaces/candidates",
] as const;
const EXECUTED_TAKOFORM_INPUT_PATHS = TAKOFORM_PATHS;
const PINNED_FILES = new Map([
  [
    "forms/candidates/current-family-index.json",
    "sha256:337a138c8d2561ade5b5ff44570c0d6a5543922f98d265c961874b06ef7ba703",
  ],
  [
    "conformance/takoform-v1/manifest.json",
    "sha256:1651e9bb4f302a8073881d3320f3c4afed54fce56ef8bacee976e166171f3aa5",
  ],
  [
    "conformance/takoform-v1/generic-host/portable-host/manifest.json",
    "sha256:5178c3aa03621694aaa6d4f51087efc2e693695e4e9b9a0dd3c788fcc0ef9944",
  ],
  [
    "conformance/takoform-v1/generic-host/portable-host/contract.json",
    "sha256:1c4281e54ea986ec9cfacc74ef5d384142b620a63fb19331b514eb1f2f31def7",
  ],
  [
    "forms/candidates/edge.forms.takoform.com/candidate-set.json",
    "sha256:8e8599ca3896946dc5ac4e609ce7652f21631bd5e38dddc026db7a3febadf2f8",
  ],
  [
    "bindings/candidates/v1alpha2/candidate-set.json",
    "sha256:e3b4aa31d5f9f7b7f31ff70f5f805a9354abf3ccd5555cc457e2e7c395224143",
  ],
] as const);

const port = Number(process.env.TAKOSERVER_CONFORMANCE_PORT ?? 18799);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("TAKOSERVER_CONFORMANCE_PORT must be a TCP port");
}

const executionRoot = mkdtempSync(join(tmpdir(), "takoserver-v1-evidence-"));
const cleanup = () => rmSync(executionRoot, { recursive: true, force: true });
process.once("exit", cleanup);
const dataRoot = join(executionRoot, "data");
const serverBundle = join(executionRoot, "takoserver-stable-host.mjs");
const runnerBinary = join(executionRoot, "portable-host-conformance");
const executedTakoformRoot = join(executionRoot, "takoform-input");
const executedCorpus = join(
  executedTakoformRoot,
  "conformance/takoform-v1/generic-host/portable-host",
);
let suiteReport: JsonObject | undefined;
let runnerReport: JsonObject | undefined;
let runError: unknown;

const takoserverBeforeBuild = await captureTakoserverState();
const takoformBeforeBuild = await captureTakoformState();
const executedInputFiles = copyTakoformExecutionInput(takoform, executedTakoformRoot);
const executedInputBefore = await captureFileInventory(executedTakoformRoot, executedInputFiles);
suiteReport = await runJson(
  [
    "go",
    "run",
    "./cmd/portable-host-conformance",
    "suite",
    "--manifest",
    "conformance/takoform-v1/manifest.json",
  ],
  executedTakoformRoot,
);
if (
  suiteReport.format !== "takoform.reference-host-suite-report@v1" ||
  suiteReport.status !== "passed" ||
  suiteReport.hostApiLane !== "forms.takoform.com/v1" ||
  !isJsonObject(suiteReport.suite) ||
  suiteReport.suite.path !== "conformance/takoform-v1/manifest.json" ||
  suiteReport.suite.sha256 !== pinnedDigest("conformance/takoform-v1/manifest.json").slice(7)
) {
  throw new Error("Takoform stable suite did not prove the pinned v1 manifest");
}
runChecked(
  ["bun", "build", "src/entry-conformance.ts", "--target=bun", "--outfile", serverBundle],
  repository,
);
runChecked(
  ["go", "build", "-trimpath", "-o", runnerBinary, "./cmd/portable-host-conformance"],
  executedTakoformRoot,
);
const execution = {
  takoserverBundleSha256: await bytesDigest(await Bun.file(serverBundle).arrayBuffer()),
  takoserverBundleBytes: Bun.file(serverBundle).size,
  takoformRunnerBinarySha256: await bytesDigest(await Bun.file(runnerBinary).arrayBuffer()),
  takoformRunnerBinaryBytes: Bun.file(runnerBinary).size,
};
const takoserverBeforeRun = await captureTakoserverState();
const takoformBeforeRun = await captureTakoformState();
assertUnchanged(
  "Takoserver changed while the stable Host bundle was built",
  takoserverBeforeBuild,
  takoserverBeforeRun,
);
assertUnchanged(
  "Takoform changed while the runner binary was built",
  takoformBeforeBuild,
  takoformBeforeRun,
);

const endpoint = `http://127.0.0.1:${port}`;
const primary = "takoserver-conformance-primary";
const alternate = "takoserver-conformance-alternate";
const alternateTenant = "takoserver-conformance-alternate-tenant";
const server = Bun.spawn(["bun", serverBundle], {
  cwd: repository,
  env: {
    ...process.env,
    TAKOSERVER_DISPOSABLE_CONFORMANCE: "1",
    TAKOFORM_REPOSITORY_ROOT: executedTakoformRoot,
    TAKOFORM_CONFORMANCE_ROOT: executedCorpus,
    TAKOSERVER_DATA_ROOT: dataRoot,
    TAKOSERVER_CONFORMANCE_TOKEN: primary,
    TAKOSERVER_CONFORMANCE_ALTERNATE_TOKEN: alternate,
    TAKOSERVER_CONFORMANCE_ALTERNATE_TENANT_TOKEN: alternateTenant,
    PORT: String(port),
  },
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
});
const serverOutput = new Response(server.stdout).text();

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error("stable Host stopped before readiness");
    const response = await fetch(`${endpoint}/.well-known/takoform/v1`).catch(() => null);
    if (response?.ok) {
      ready = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("stable Host did not become ready within 10 seconds");

  const runner = Bun.spawn(
    [
      runnerBinary,
      "run",
      "--contract",
      executedCorpus,
      "--endpoint",
      endpoint,
      "--token-env",
      "PRIMARY",
      "--alternate-token-env",
      "ALT",
      "--alternate-tenant-token-env",
      "ALT_TENANT",
    ],
    {
      cwd: executionRoot,
      env: { ...process.env, PRIMARY: primary, ALT: alternate, ALT_TENANT: alternateTenant },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const runnerOutput = await new Response(runner.stdout).text();
  if ((await runner.exited) !== 0) {
    process.stderr.write(runnerOutput);
    throw new Error("Takoform portable Host runner failed");
  }
  const parsed = JSON.parse(runnerOutput) as unknown;
  if (!isJsonObject(parsed)) throw new Error("Takoform runner did not emit a JSON report");
  const checks = parsed.checks;
  if (
    parsed.status !== "passed" ||
    parsed.classification !== "disposable-endpoint-conformance-run" ||
    parsed.publicationReady !== false ||
    !Array.isArray(checks) ||
    checks.length !== 125 ||
    !checks.every((check) => typeof check === "string")
  ) {
    throw new Error("Takoform runner report does not prove the pinned 125-check stable corpus");
  }
  runnerReport = parsed;
} catch (error) {
  runError = error;
} finally {
  server.kill();
  await server.exited;
  process.stderr.write(await serverOutput);
}

try {
  const executedInputAfter = await captureFileInventory(executedTakoformRoot, executedInputFiles);
  if (canonicalJson(executedInputBefore) !== canonicalJson(executedInputAfter)) {
    throw new Error("Copied Takoform frozen-suite bytes changed while conformance executed");
  }
  const takoserverAfterRun = await captureTakoserverState();
  const takoformAfterRun = await captureTakoformState();
  assertUnchanged(
    "Takoserver changed while conformance executed",
    takoserverBeforeRun,
    takoserverAfterRun,
  );
  assertUnchanged(
    "Takoform changed while conformance executed",
    takoformBeforeRun,
    takoformAfterRun,
  );
  if (runError) throw runError;
  if (!suiteReport) throw new Error("Takoform stable suite report missing");
  if (!runnerReport) throw new Error("Takoform runner report missing");
  console.log(
    canonicalJson(
      await evidenceReport(suiteReport, runnerReport, takoserverBeforeRun, takoformBeforeRun, {
        ...execution,
        takoformInput: executedInputBefore,
      }),
    ),
  );
} finally {
  cleanup();
  process.removeListener("exit", cleanup);
}

interface RepositoryState {
  readonly commit: string;
  readonly status: string;
  readonly trackedDiffSha256: `sha256:${string}`;
  readonly fileInventorySha256: `sha256:${string}`;
  readonly untracked: readonly { readonly path: string; readonly sha256: `sha256:${string}` }[];
}

interface FileInventory {
  readonly files: number;
  readonly bytes: number;
  readonly sha256: `sha256:${string}`;
}

async function captureTakoserverState(): Promise<RepositoryState> {
  return await repositoryState(repository);
}

/** Refuses to call a drifting frozen tuple the TASK-0032 evidence corpus. */
async function captureTakoformState(): Promise<RepositoryState> {
  const revision = gitAt(takoform, "rev-parse", "HEAD");
  if (revision !== EXPECTED_TAKOFORM_COMMIT) {
    throw new Error(
      `Takoform checkout is ${revision}; TASK-0032 evidence requires ${EXPECTED_TAKOFORM_COMMIT}`,
    );
  }
  for (const [path, expected] of PINNED_FILES) {
    const actual = await bytesDigest(await Bun.file(resolve(takoform, path)).arrayBuffer());
    if (actual !== expected) {
      throw new Error(`Pinned Takoform file changed: ${path} (${actual}, expected ${expected})`);
    }
  }
  return await repositoryState(takoform, TAKOFORM_PATHS);
}

async function repositoryState(root: string, paths?: readonly string[]): Promise<RepositoryState> {
  const pathArguments = paths ? ["--", ...paths] : [];
  const files = gitAt(
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    ...pathArguments,
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const existingFiles = files.filter((path) => existsSync(resolve(root, path)));
  const inventory = await Promise.all(
    existingFiles.map(async (path) => ({
      path,
      sha256: await bytesDigest(await Bun.file(resolve(root, path)).arrayBuffer()),
    })),
  );
  const untrackedNames = new Set(
    gitAt(root, "ls-files", "--others", "--exclude-standard", ...pathArguments)
      .split("\n")
      .filter(Boolean),
  );
  const untracked = inventory.filter((entry) => untrackedNames.has(entry.path));
  const diff = Bun.spawnSync(
    ["git", "diff", "--binary", "--no-ext-diff", "HEAD", ...pathArguments],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (diff.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(diff.stderr).trim() || "git diff failed");
  }
  return {
    commit: gitAt(root, "rev-parse", "HEAD"),
    status: gitAt(root, "status", "--porcelain=v1", "--untracked-files=all", ...pathArguments),
    trackedDiffSha256: await bytesDigest(diff.stdout),
    fileInventorySha256: await canonicalDigest(inventory),
    untracked,
  };
}

function assertUnchanged(message: string, before: RepositoryState, after: RepositoryState): void {
  if (canonicalJson(before) !== canonicalJson(after)) throw new Error(message);
}

function gitAt(cwd: string, ...arguments_: string[]): string {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || "git command failed");
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function runChecked(command: readonly string[], cwd: string): void {
  const result = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const stdout = new TextDecoder().decode(result.stdout).trim();
    throw new Error(stderr || stdout || `${command[0]} failed`);
  }
}

async function runJson(command: readonly string[], cwd: string): Promise<JsonObject> {
  const process = Bun.spawn([...command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `${command[0]} failed`);
  const parsed = JSON.parse(stdout) as unknown;
  if (!isJsonObject(parsed)) throw new Error(`${command[0]} did not emit a JSON report`);
  return parsed;
}

function copyTakoformExecutionInput(source: string, destination: string): readonly string[] {
  const files = gitAt(
    source,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...EXECUTED_TAKOFORM_INPUT_PATHS,
  )
    .split("\n")
    .filter(Boolean)
    .filter((path) => existsSync(resolve(source, path)))
    .sort();
  if (files.length === 0) throw new Error("Pinned Takoform execution input is empty");
  for (const path of files) {
    const target = resolve(destination, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    copyFileSync(resolve(source, path), target);
  }
  return files;
}

async function captureFileInventory(
  root: string,
  files: readonly string[],
): Promise<FileInventory> {
  let bytes = 0;
  const entries = await Promise.all(
    files.map(async (path) => {
      const file = Bun.file(resolve(root, path));
      bytes += file.size;
      return { path, bytes: file.size, sha256: await bytesDigest(await file.arrayBuffer()) };
    }),
  );
  return { files: entries.length, bytes, sha256: await canonicalDigest(entries) };
}

/** Canonical wrapper bound to preflight source states and the bytes actually executed. */
async function evidenceReport(
  suite: JsonObject,
  report: JsonObject,
  takoserverState: RepositoryState,
  takoformState: RepositoryState,
  execution: {
    readonly takoserverBundleSha256: `sha256:${string}`;
    readonly takoserverBundleBytes: number;
    readonly takoformRunnerBinarySha256: `sha256:${string}`;
    readonly takoformRunnerBinaryBytes: number;
    readonly takoformInput: FileInventory;
  },
): Promise<JsonObject> {
  return {
    format: "takoserver.takoform-v1-conformance-report@v1",
    classification: "disposable-independent-host-protocol-evidence",
    publicationReady: false,
    evidenceScope: {
      backend: false,
      providerLifecycle: false,
      runtimeAbi: false,
      production: false,
      productionConsumers: false,
    },
    provenance: {
      sourceStateCheckedBeforeBuild: true,
      sourceStateCheckedBeforeExecution: true,
      sourceStateCheckedAfterExecution: true,
      executedArtifacts: {
        takoserverBundleSha256: execution.takoserverBundleSha256,
        takoserverBundleBytes: execution.takoserverBundleBytes,
        takoformRunnerBinarySha256: execution.takoformRunnerBinarySha256,
        takoformRunnerBinaryBytes: execution.takoformRunnerBinaryBytes,
        takoformInput: {
          files: execution.takoformInput.files,
          bytes: execution.takoformInput.bytes,
          sha256: execution.takoformInput.sha256,
        },
      },
    },
    takoserver: {
      commit: takoserverState.commit,
      worktreeDirty: takoserverState.status !== "",
      trackedDiffSha256: takoserverState.trackedDiffSha256,
      fileInventorySha256: takoserverState.fileInventorySha256,
      untrackedFiles: takoserverState.untracked,
      worktreeStateDigest: await canonicalDigest(takoserverState),
    },
    takoform: {
      commit: takoformState.commit,
      relevantFileInventorySha256: takoformState.fileInventorySha256,
      relevantStateDigest: await canonicalDigest(takoformState),
      familyIndexSha256: pinnedDigest("forms/candidates/current-family-index.json"),
      edgeCandidateSetSha256: pinnedDigest(
        "forms/candidates/edge.forms.takoform.com/candidate-set.json",
      ),
      bindingCandidateSetSha256: pinnedDigest("bindings/candidates/v1alpha2/candidate-set.json"),
      contractSha256: pinnedDigest(
        "conformance/takoform-v1/generic-host/portable-host/contract.json",
      ),
      nestedManifestSha256: pinnedDigest(
        "conformance/takoform-v1/generic-host/portable-host/manifest.json",
      ),
      suiteManifestSha256: pinnedDigest("conformance/takoform-v1/manifest.json"),
    },
    coverage: {
      requiredChecks: 125,
      currentStableEdgeFormsInstalled: 16,
      currentObjectBucketInstalled: false,
      currentEdgeObjectsInterfaceInstalled: false,
      corpusOnlySyntheticFormsInstalled: 9,
      currentBindingsInstalled: 6,
    },
    referenceSuiteReport: suite,
    runnerChecksSha256: await canonicalDigest(report.checks ?? []),
    hostRunnerReport: report,
  };
}

function pinnedDigest(path: typeof PINNED_FILES extends ReadonlyMap<infer K, string> ? K : never) {
  const digest = PINNED_FILES.get(path);
  if (!digest) throw new Error(`missing pinned digest for ${path}`);
  return digest;
}
