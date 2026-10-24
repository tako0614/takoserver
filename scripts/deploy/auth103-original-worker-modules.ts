import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../../src/json.ts";
import { readAuth103HistoricalPublication } from "./auth103-historical-publication.ts";
import { type DeployPhase, preflightError, verificationError } from "./errors.ts";
import {
  inspectMoneyNativeBuildDependencyTree,
  inspectMoneyNativeBuildSourceTree,
} from "./money-native-build-closure.ts";
import { REPOSITORY } from "./process.ts";
import { type DeployTarget, loadTarget, targetPath } from "./target.ts";

const COMMIT = /^[0-9a-f]{40}$/u;
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

interface OriginalModuleBytes {
  readonly worker: Buffer;
  readonly sql: Buffer;
  readonly mode: "historical-two-module" | "future-single-module";
}

type DependencySnapshot = ReturnType<typeof inspectMoneyNativeBuildDependencyTree>;

export function assertOriginalDependencyReplayUnchanged(
  before: { readonly selected: DependencySnapshot; readonly current: DependencySnapshot },
  after: { readonly selected: DependencySnapshot; readonly current: DependencySnapshot },
): void {
  if (
    after.selected.contentDigest !== before.selected.contentDigest ||
    after.selected.identityDigest !== before.selected.identityDigest ||
    after.current.contentDigest !== before.current.contentDigest ||
    after.current.identityDigest !== before.current.identityDigest ||
    after.selected.contentDigest !== after.current.contentDigest
  ) {
    throw preflightError("Auth103 original build dependency closure changed during replay");
  }
}

export function originalAuth103ModuleMode(
  config: unknown,
): "historical-two-module" | "future-single-module" {
  if (typeof config !== "object" || config === null || Array.isArray(config))
    throw preflightError("Auth103 original release config is malformed");
  if (!Object.hasOwn(config, "find_additional_modules")) return "historical-two-module";
  if ((config as Record<string, unknown>).find_additional_modules !== false)
    throw preflightError("Auth103 original release module mode is unknown");
  return "future-single-module";
}

export interface Auth103OriginalWorkerModules {
  readonly opaqueAuth103OriginalWorkerModules: unique symbol;
}

const originals = new WeakMap<object, OriginalModuleBytes>();

function git(root: string, args: readonly string[]): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
    },
  });
  if (result.status !== 0 || result.signal !== null || !(result.stdout instanceof Buffer)) {
    throw preflightError("Auth103 original Git source is unavailable");
  }
  return result.stdout;
}

function exactOriginalSource(root: string, commit: string, commonDirectory: string): void {
  if (!isAbsolute(root) || realpathSync(root) !== root) {
    throw preflightError("Auth103 original checkout is not a physical worktree");
  }
  const actualCommon = git(root, ["rev-parse", "--git-common-dir"]).toString("utf8").trim();
  if (
    realpathSync(resolve(root, actualCommon)) !== commonDirectory ||
    git(root, ["rev-parse", "HEAD"]).toString("utf8").trim() !== commit ||
    git(root, ["status", "--porcelain", "--untracked-files=all"]).length !== 0
  ) {
    throw preflightError("Auth103 original checkout differs from its selected Git commit");
  }
  const entries = git(root, ["ls-tree", "-r", "-z", commit])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)$/u.exec(row);
      if (!match?.[1] || !match[2] || !match[3]) {
        throw preflightError("Auth103 original Git tree has unsupported entries");
      }
      return { path: match[3], blob: match[2], executable: match[1] === "100755" };
    });
  inspectMoneyNativeBuildSourceTree(root, entries);
}

function originalCheckout(commit: string): {
  readonly root: string;
  readonly selectedDependencies: DependencySnapshot;
  readonly currentDependencies: DependencySnapshot;
} {
  if (!COMMIT.test(commit)) throw preflightError("Auth103 original source commit is malformed");
  // Never execute code from an unrelated local branch just because its
  // annotation and worktree agree with each other.
  git(REPOSITORY, ["merge-base", "--is-ancestor", commit, "HEAD"]);
  const currentCommon = git(REPOSITORY, ["rev-parse", "--git-common-dir"]).toString("utf8").trim();
  const commonDirectory = realpathSync(resolve(REPOSITORY, currentCommon));
  const listing = git(REPOSITORY, ["worktree", "list", "--porcelain", "-z"])
    .toString("utf8")
    .split("\0\0");
  const candidates = listing
    .map((record) => record.split("\0"))
    .filter((record) => record.includes(`HEAD ${commit}`))
    .map((record) => record.find((line) => line.startsWith("worktree "))?.slice(9))
    .filter((path): path is string => path !== undefined)
    .sort();
  const currentDependencies = inspectMoneyNativeBuildDependencyTree(
    join(REPOSITORY, "node_modules"),
  );
  for (const path of candidates) {
    try {
      exactOriginalSource(path, commit, commonDirectory);
      const selectedDependencies = inspectMoneyNativeBuildDependencyTree(
        join(path, "node_modules"),
      );
      if (selectedDependencies.contentDigest !== currentDependencies.contentDigest) continue;
      return { root: path, selectedDependencies, currentDependencies };
    } catch {
      // An ignored build directory or a changed candidate is not an original.
    }
  }
  throw preflightError("Auth103 original exact source worktree is unavailable");
}

function selectedTargetBytes(target: DeployTarget): {
  readonly path: string;
  readonly bytes: Buffer;
  readonly identity: string;
} {
  const path = targetPath("integration");
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (stat.mode & 0o777n) !== 0o600n
  ) {
    throw preflightError("Auth103 original target requires its private owned descriptor");
  }
  const bytes = readFileSync(path);
  if (canonicalJson(loadTarget(path, "integration")) !== canonicalJson(target)) {
    throw preflightError("Auth103 original target differs from the selected descriptor");
  }
  return { path, bytes, identity: targetFileIdentity(stat) };
}

function targetFileIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  );
}

/** Build a child environment with no inherited credential or Worker binding. */
export function isolatedAuth103OriginalBuildEnvironment(
  source: NodeJS.ProcessEnv,
  temporary: string,
): NodeJS.ProcessEnv {
  const child = { ...source };
  for (const key of Object.keys(child)) delete child[key];
  child.PATH = source.PATH ?? "/usr/bin:/bin";
  child.TMPDIR = temporary;
  child.HOME = temporary;
  child.CI = "1";
  child.NO_COLOR = "1";
  return child;
}

/** Replays only the original registered local builder from the exact Git
 * checkout selected by the immutable Version's commit. A caller supplies no
 * release path, SQL, digest or proof DTO. The selected private target is read
 * twice, and the original release is sealed before its bytes leave the child.
 */
export function buildAuth103OriginalWorkerModules(
  target: DeployTarget,
  sourceCommit: string,
): Auth103OriginalWorkerModules {
  if (
    target.environment !== "integration" ||
    target.auth103NativeProfile !== "root-shared-auth-staging-v1" ||
    target.schemaMaintenanceMode !== "pre-auth103-quiesced" ||
    target.takoformV2?.storageLineage !== "v2-0100"
  ) {
    throw preflightError("Auth103 original module proof requires its selected quiesced target");
  }
  const selected = selectedTargetBytes(target);
  const original = originalCheckout(sourceCommit);
  const { root } = original;
  const temporary = mkdtempSync(join(tmpdir(), "a3-"));
  try {
    const childPath = join(temporary, "build.ts");
    const outputRoot = join(temporary, "artifact");
    const child = `
import { readFileSync, readdirSync } from "node:fs";
import { createAuth103NativeSourceInstallContribution } from ${JSON.stringify(join(root, "scripts/deploy/auth103-native-source.ts"))};
import { prepareWorkerArtifact } from ${JSON.stringify(join(root, "scripts/deploy/worker-artifact.ts"))};
import { runCommand } from ${JSON.stringify(join(root, "scripts/deploy/process.ts"))};
import { loadTarget } from ${JSON.stringify(join(root, "scripts/deploy/target.ts"))};
try {
  const target = loadTarget(${JSON.stringify(selected.path)}, "integration");
  const prepared = await prepareWorkerArtifact({
    root: ${JSON.stringify(outputRoot)}, target, commit: ${JSON.stringify(sourceCommit)},
    sourceRepositoryRoot: ${JSON.stringify(root)}, run: runCommand,
  });
  if (!prepared.auth103NativeSource || !prepared.auth103SourceInstallPath) throw new Error("unregistered");
  const seal = prepared.seal();
  seal.assertUnchanged();
  if (JSON.stringify(readdirSync(prepared.releaseDirectory).sort()) !==
    JSON.stringify(["auth103-source-install.sql", "worker.js", "wrangler.jsonc"])) throw new Error("inventory");
  const sql = readFileSync(prepared.auth103SourceInstallPath);
  const composed = createAuth103NativeSourceInstallContribution(prepared.auth103NativeSource, prepared.bundlePath);
  if (composed === null || !sql.equals(Buffer.from(composed))) throw new Error("composer");
  seal.assertUnchanged();
} catch { process.exitCode = 1; }
`;
    writeFileSync(childPath, child, { flag: "wx", mode: 0o600 });
    const built = spawnSync(process.execPath, [childPath], {
      cwd: root,
      env: isolatedAuth103OriginalBuildEnvironment(process.env, temporary),
      stdio: "ignore",
      timeout: 180_000,
    });
    if (built.status !== 0 || built.signal !== null) {
      throw preflightError("Auth103 original registered local builder did not qualify");
    }
    exactOriginalSource(
      root,
      sourceCommit,
      realpathSync(
        resolve(
          REPOSITORY,
          git(REPOSITORY, ["rev-parse", "--git-common-dir"]).toString("utf8").trim(),
        ),
      ),
    );
    const selectedDependenciesAfter = inspectMoneyNativeBuildDependencyTree(
      join(root, "node_modules"),
    );
    const currentDependenciesAfter = inspectMoneyNativeBuildDependencyTree(
      join(REPOSITORY, "node_modules"),
    );
    assertOriginalDependencyReplayUnchanged(
      { selected: original.selectedDependencies, current: original.currentDependencies },
      { selected: selectedDependenciesAfter, current: currentDependenciesAfter },
    );
    if (
      targetFileIdentity(lstatSync(selected.path, { bigint: true })) !== selected.identity ||
      !readFileSync(selected.path).equals(selected.bytes) ||
      canonicalJson(loadTarget(selected.path, "integration")) !== canonicalJson(target)
    ) {
      throw preflightError("Auth103 original target changed during its local build");
    }
    const release = join(outputRoot, "release");
    if (
      readdirSync(release).sort().join(",") !==
      "auth103-source-install.sql,worker.js,wrangler.jsonc"
    ) {
      throw preflightError("Auth103 original release inventory is not exact");
    }
    const read = (name: string): Buffer => {
      const path = join(release, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw preflightError("Auth103 original release has an unowned module");
      }
      return readFileSync(path);
    };
    const worker = read("worker.js");
    const sql = read("auth103-source-install.sql");
    let originalConfig: unknown;
    try {
      originalConfig = JSON.parse(read("wrangler.jsonc").toString("utf8"));
    } catch {
      throw preflightError("Auth103 original release config is malformed");
    }
    const mode = originalAuth103ModuleMode(originalConfig);
    if (worker.length === 0 || sql.length === 0) {
      throw preflightError("Auth103 original release module is empty");
    }
    const capture = Object.freeze({}) as Auth103OriginalWorkerModules;
    originals.set(capture, { worker, sql, mode });
    return capture;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function originalAuth103ModuleDigests(capture: Auth103OriginalWorkerModules): {
  readonly worker: string;
  readonly sql: string;
} {
  const bytes = originals.get(capture);
  if (bytes === undefined) throw preflightError("Auth103 original module proof is not captured");
  return { worker: digest(bytes.worker), sql: digest(bytes.sql) };
}

export function verifyAuth103OriginalModuleClosure(
  phase: Extract<DeployPhase, "preflight" | "verification">,
  versionValue: unknown,
  capture: Auth103OriginalWorkerModules,
  annotatedBundleDigestHex: string,
): string {
  const original = originals.get(capture);
  if (original === undefined) {
    throw phase === "preflight"
      ? preflightError("Auth103 original module proof is not captured")
      : verificationError("Auth103 original module proof is not captured");
  }
  return assertBuiltAuth103ModuleClosure(phase, versionValue, original, annotatedBundleDigestHex);
}

/** Pure comparison only. The runtime obtains its mode and bytes through the
 * opaque original-builder capture; observed provider module count has no say
 * in which source-era contract applies.
 */
export function assertBuiltAuth103ModuleClosure(
  phase: Extract<DeployPhase, "preflight" | "verification">,
  versionValue: unknown,
  original: {
    readonly worker: Uint8Array;
    readonly sql: Uint8Array;
    readonly mode: "historical-two-module" | "future-single-module";
  },
  annotatedBundleDigestHex: string,
): string {
  return original.mode === "historical-two-module"
    ? assertExactOriginalModuleBytes(phase, versionValue, original, annotatedBundleDigestHex)
    : assertExactSingleModuleBytes(phase, versionValue, original.worker, annotatedBundleDigestHex);
}

/** Pure byte comparison only; this does not acquire or authorize an original.
 * The owning readback path obtains its bytes exclusively through the opaque
 * original builder capture above.
 */
export function assertExactOriginalModuleBytes(
  phase: Extract<DeployPhase, "preflight" | "verification">,
  versionValue: unknown,
  original: { readonly worker: Uint8Array; readonly sql: Uint8Array },
  annotatedBundleDigestHex: string,
): string {
  const refuse = (message: string): never => {
    throw phase === "preflight" ? preflightError(message) : verificationError(message);
  };
  if (typeof versionValue !== "object" || versionValue === null || Array.isArray(versionValue))
    return refuse("Auth103 original Worker Version module closure is malformed");
  const version = versionValue as Record<string, unknown>;
  if (
    version.resources !== undefined ||
    version.main_module !== "worker.js" ||
    !Array.isArray(version.modules) ||
    version.modules.length !== 2
  )
    return refuse("Auth103 original Worker Version module inventory is not exact");
  const expected = new Map([
    ["worker.js", { contentType: "application/javascript+module", bytes: original.worker }],
    ["auth103-source-install.sql", { contentType: "text/plain", bytes: original.sql }],
  ]);
  for (const item of version.modules) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return refuse("Auth103 original Worker Version module is malformed");
    }
    const module = item as Record<string, unknown>;
    if (
      Object.keys(module).sort().join(",") !== "content_base64,content_type,name" ||
      typeof module.name !== "string" ||
      typeof module.content_base64 !== "string"
    )
      return refuse("Auth103 original Worker Version module is malformed");
    const originalModule = expected.get(module.name);
    if (originalModule === undefined || module.content_type !== originalModule.contentType) {
      return refuse("Auth103 original Worker Version module identity is foreign");
    }
    const bytes = Buffer.from(module.content_base64, "base64");
    if (bytes.toString("base64") !== module.content_base64 || !bytes.equals(originalModule.bytes))
      return refuse("Auth103 original Worker Version module bytes differ from its source");
    expected.delete(module.name);
  }
  if (expected.size !== 0)
    return refuse("Auth103 original Worker Version module inventory is incomplete");
  const bundleDigestHex = digest(original.worker);
  if (bundleDigestHex !== annotatedBundleDigestHex) {
    return refuse("Auth103 original Worker module differs from its bundle annotation");
  }
  return bundleDigestHex;
}

/** Shared status/forward readback. The old two-module shape is accepted only
 * with an original build in a selected ancestor checkout; future uploads must
 * carry the one exact JavaScript module.
 */
export function verifySelectedAuth103WorkerModules(
  phase: Extract<DeployPhase, "preflight" | "verification">,
  target: DeployTarget,
  sourceCommit: string,
  annotatedBundleDigestHex: string,
  versionValue: unknown,
  history: { readonly versionId: string; readonly deploymentId: string },
): void {
  const selected = selectedTargetBytes(target);
  const historical = readAuth103HistoricalPublication({
    phase,
    target,
    targetDigest: digest(selected.bytes),
    sourceCommit,
    versionId: history.versionId,
    deploymentId: history.deploymentId,
  });
  if (historical !== null) {
    const before = originalCheckout(sourceCommit);
    assertExactOriginalModuleBytes(phase, versionValue, historical, annotatedBundleDigestHex);
    const after = originalCheckout(sourceCommit);
    if (before.root !== after.root) {
      throw phase === "preflight"
        ? preflightError("Auth103 historical original source changed during read")
        : verificationError("Auth103 historical original source changed during read");
    }
    assertOriginalDependencyReplayUnchanged(
      { selected: before.selectedDependencies, current: before.currentDependencies },
      { selected: after.selectedDependencies, current: after.currentDependencies },
    );
    if (
      targetFileIdentity(lstatSync(selected.path, { bigint: true })) !== selected.identity ||
      !readFileSync(selected.path).equals(selected.bytes) ||
      canonicalJson(loadTarget(selected.path, "integration")) !== canonicalJson(target)
    ) {
      throw phase === "preflight"
        ? preflightError("Auth103 historical original target changed during read")
        : verificationError("Auth103 historical original target changed during read");
    }
    historical.assertUnchanged();
    return;
  }
  const capture = buildAuth103OriginalWorkerModules(target, sourceCommit);
  verifyAuth103OriginalModuleClosure(phase, versionValue, capture, annotatedBundleDigestHex);
}

/** An uploaded but not yet deployed Version has no deployment identity and
 * cannot select retained historical publication bytes. */
export function verifyUnpublishedAuth103WorkerModules(
  phase: Extract<DeployPhase, "preflight" | "verification">,
  target: DeployTarget,
  sourceCommit: string,
  annotatedBundleDigestHex: string,
  versionValue: unknown,
): void {
  const capture = buildAuth103OriginalWorkerModules(target, sourceCommit);
  verifyAuth103OriginalModuleClosure(phase, versionValue, capture, annotatedBundleDigestHex);
}

function assertExactSingleModuleBytes(
  phase: Extract<DeployPhase, "preflight" | "verification">,
  versionValue: unknown,
  originalWorker: Uint8Array,
  annotatedBundleDigestHex: string,
): string {
  const moduleError = (message: string) =>
    phase === "preflight" ? preflightError(message) : verificationError(message);
  if (typeof versionValue !== "object" || versionValue === null || Array.isArray(versionValue))
    throw moduleError("Auth103 Worker Version module closure is malformed");
  const version = versionValue as Record<string, unknown>;
  if (
    version.resources !== undefined ||
    version.main_module !== "worker.js" ||
    !Array.isArray(version.modules)
  )
    throw moduleError("Auth103 Worker Version module closure is malformed");
  if (version.modules.length !== 1) {
    throw moduleError("Auth103 Worker Version module inventory is not exact");
  }
  const entry = version.modules[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw moduleError("Auth103 Worker Version module is malformed");
  }
  const module = entry as Record<string, unknown>;
  if (
    Object.keys(module).sort().join(",") !== "content_base64,content_type,name" ||
    module.name !== "worker.js" ||
    module.content_type !== "application/javascript+module" ||
    typeof module.content_base64 !== "string"
  )
    throw moduleError("Auth103 Worker Version module is malformed");
  const bytes = Buffer.from(module.content_base64, "base64");
  if (bytes.toString("base64") !== module.content_base64) {
    throw moduleError("Auth103 Worker Version module is not canonical base64");
  }
  if (!bytes.equals(originalWorker) || digest(bytes) !== annotatedBundleDigestHex) {
    throw moduleError("Auth103 Worker Version module bytes differ from its bundle annotation");
  }
  return annotatedBundleDigestHex;
}
