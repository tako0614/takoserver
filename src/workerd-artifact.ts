import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Immutable owner identity of the only workerd artifact this build accepts. */
export const WORKERD_CLOSED_GRAPH_ARTIFACT = {
  version: "2026-08-11",
  upstreamCommit: "0129b1e7aaf9afbc21cba79d215723d9839eb7a0",
  upstreamArchiveSha256: "1f725582898dbdea4d59a8a71fe65bd62f3aaa7f117dd7107eed5a0d11273919",
  reviewedSourceSha256: "c4417a4bf5e80b07c43fbd437251759dfd34313b44ccdbe27023f4b3666d11ed",
  overlayPatchSha256: "61b3ed73af00898cbd1032c2750aab9360b7c5508c548218890a2810bae45f45",
  v8PatchSha256: "3c9e787096cb68514c710cfa05966a025c10f771a472dc2babce0b5bd4a2371d",
  bazeliskSha256: "5a408715e932c0250d28bd84555f12edbf70117de42f9181691c736eacc4a992",
  bazelSha256: "7668a95db1250f12c40407251e4e203b4ec8bf39bc495d2f485b2d8c99048694",
  clangVersion: "Ubuntu clang version 20.1.8 (2ubuntu8)",
  sha256: "c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52",
  platform: "linux",
  arch: "x64",
} as const;

export interface ClosedGraphWorkerdSelection {
  readonly binary: string | null;
  readonly diagnostic: string | null;
}

const selections = new Map<string, Promise<ClosedGraphWorkerdSelection>>();

/**
 * Selects a serving artifact once per process, after immutable identity and an
 * executable resolver probe both agree. Nothing here searches node_modules:
 * an older package binary is an unsupported runtime, not a fallback.
 */
export async function selectClosedGraphWorkerd(input: {
  readonly binary: string | undefined;
  /** Private data-root child retaining the selected bytes and one-shot probe. */
  readonly privateRoot: string;
}): Promise<ClosedGraphWorkerdSelection> {
  const binary = input.binary;
  if (binary === undefined || binary.trim() === "") {
    return {
      binary: null,
      diagnostic: "TAKOSERVER_WORKERD_BINARY is not configured; Worker execution is disabled",
    };
  }
  if (!isAbsolute(binary)) {
    return {
      binary: null,
      diagnostic:
        "TAKOSERVER_WORKERD_BINARY must be an absolute path; Worker execution is disabled",
    };
  }
  if (
    process.platform !== WORKERD_CLOSED_GRAPH_ARTIFACT.platform ||
    process.arch !== WORKERD_CLOSED_GRAPH_ARTIFACT.arch
  ) {
    return {
      binary: null,
      diagnostic: `the pinned closed-graph workerd supports ${WORKERD_CLOSED_GRAPH_ARTIFACT.platform}/${WORKERD_CLOSED_GRAPH_ARTIFACT.arch}; Worker execution is disabled`,
    };
  }

  const privateRoot = resolve(input.privateRoot);
  // The selected path lives under privateRoot, so two compositions selecting
  // one configured source into different owner roots are different results.
  const cacheKey = `${binary}\0${privateRoot}`;
  const cached = selections.get(cacheKey);
  if (cached) return await cached;
  const selection = inspectArtifact({ binary, privateRoot });
  selections.set(cacheKey, selection);
  return await selection;
}

async function inspectArtifact(input: {
  readonly binary: string;
  readonly privateRoot: string;
}): Promise<ClosedGraphWorkerdSelection> {
  try {
    const metadata = await lstat(input.binary);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return refused("is not a regular, non-symlink file");
    }
    await access(input.binary, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return refused("is not readable and executable");
  }

  let digest: string;
  try {
    digest = await fileSha256(input.binary);
  } catch {
    return refused("could not be hashed");
  }
  if (digest !== WORKERD_CLOSED_GRAPH_ARTIFACT.sha256) {
    return refused(`has digest ${digest}; expected ${WORKERD_CLOSED_GRAPH_ARTIFACT.sha256}`);
  }

  let snapshot: string;
  try {
    snapshot = await materializeVerifiedSnapshot(input.binary, input.privateRoot);
  } catch {
    return refused("could not be snapshotted into private runtime storage");
  }

  if (!(await closedGraphCapability(snapshot, input.privateRoot))) {
    return refused("failed the closed application graph capability probe");
  }
  return { binary: snapshot, diagnostic: null };
}

function refused(reason: string): ClosedGraphWorkerdSelection {
  return {
    binary: null,
    diagnostic: `TAKOSERVER_WORKERD_BINARY ${reason}; Worker execution is disabled`,
  };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Retains the verified bytes under Host-private authority.
 *
 * Hashing a configured pathname and later spawning that pathname are two
 * different observations: an ordinary artifact rotation can replace it in
 * between. The inspector and serving supervisor therefore receive this
 * digest-named snapshot, not the mutable operator input. A principal that can
 * rewrite the service's 0700 data root already owns all self-host runtime
 * state; protecting against that authority would require a separate process or
 * filesystem boundary rather than another pathname check here.
 */
async function materializeVerifiedSnapshot(binary: string, privateRoot: string): Promise<string> {
  await ensurePrivateDirectory(privateRoot);
  const snapshotRoot = join(privateRoot, "artifacts");
  await ensurePrivateDirectory(snapshotRoot);
  const snapshot = join(snapshotRoot, `workerd-${WORKERD_CLOSED_GRAPH_ARTIFACT.sha256}`);
  if (await isExactArtifact(snapshot)) return snapshot;

  const stagingRoot = await mkdtemp(join(snapshotRoot, ".install-"));
  const staging = join(stagingRoot, "workerd");
  try {
    // The configured path may be atomically replaced after its first hash.
    // Hashing the private copy is what binds the returned path to exact bytes.
    await copyFile(binary, staging, fsConstants.COPYFILE_EXCL);
    await chmod(staging, 0o500);
    if (!(await isExactArtifact(staging))) throw new Error("artifact changed while copied");
    await rename(staging, snapshot);
    if (!(await isExactArtifact(snapshot))) throw new Error("snapshot identity changed");
    return snapshot;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("private runtime path is not a directory");
  }
  await chmod(path, 0o700);
}

async function isExactArtifact(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    await access(path, fsConstants.R_OK | fsConstants.X_OK);
    return (await fileSha256(path)) === WORKERD_CLOSED_GRAPH_ARTIFACT.sha256;
  } catch {
    return false;
  }
}

async function closedGraphCapability(binary: string, privateRoot: string): Promise<boolean> {
  let root: string | undefined;
  try {
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    await chmod(privateRoot, 0o700);
    root = await mkdtemp(join(privateRoot, ".closed-graph-probe-"));
    await chmod(root, 0o700);
    await Promise.all([
      writeFile(
        join(root, "host.mjs"),
        `${moduleImport("application", "./entry.mjs")}
if (application.identity !== "application") throw new Error("wrong application bridge");
export default { test() {} };`,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(
        join(root, "application.mjs"),
        `${moduleImport("{ identity as declared }", "cloudflare:sockets")}
if (declared !== "application-declaration") throw new Error("builtin shadowed application");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
for (const attempt of [
  () => import("node:process"),
  () => eval('import("cloudflare:workers")'),
  () => Function('return import("workerd:unsafe")')(),
  () => AsyncFunction('return import("cloudflare:workers")')(),
]) {
  let refused = false;
  try { await attempt(); } catch (error) { refused = String(error).includes("No such module"); }
  if (!refused) throw new Error("undeclared runtime module resolved");
}
export default { identity: "application" };`,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(join(root, "declared.mjs"), `export const identity = "application-declaration";`, {
        encoding: "utf8",
        mode: 0o600,
      }),
      writeFile(join(root, "workerd.capnp"), capabilityConfig(), {
        encoding: "utf8",
        mode: 0o600,
      }),
    ]);

    const child = Bun.spawn({
      cmd: [binary, "test", "--no-verbose", join(root, "workerd.capnp"), "probe"],
      cwd: root,
      env: {},
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode, timedOut: false as const })),
      new Promise<{ readonly exitCode: null; readonly timedOut: true }>((done) => {
        timer = setTimeout(() => done({ exitCode: null, timedOut: true }), 5_000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result.timedOut) {
      child.kill(9);
      await Promise.race([
        child.exited.catch(() => -1),
        new Promise<number>((done) => setTimeout(() => done(-1), 1_000)),
      ]);
      return false;
    }
    return result.exitCode === 0;
  } catch {
    return false;
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Builds probe source without making generated imports part of this module's import graph. */
function moduleImport(bindings: string, specifier: string): string {
  return `import ${bindings} from ${JSON.stringify(specifier)};`;
}

function capabilityConfig(): string {
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(
    name = "probe",
    worker = (
      modules = [
        (name = "entry.mjs", esModule = embed "host.mjs", role = hostPrivate),
        (name = "entry.mjs", esModule = embed "application.mjs", role = application),
        (name = "cloudflare:sockets", esModule = embed "declared.mjs", role = application),
      ],
      modulePolicy = (applicationMain = "entry.mjs"),
      compatibilityDate = "2026-01-01",
    ),
  )],
  sockets = [],
);
`;
}
