import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightError } from "./errors.ts";
import { REPOSITORY, runCommand, WRANGLER } from "./process.ts";
import { writeWorkerConfig } from "./realized-config.ts";
import { prepareWorkerArtifact, type WorkerArtifactProcess } from "./worker-artifact.ts";

// Reviewed complete source identity. A selector cannot choose the semantics of
// absence/default TEST, another entrypoint, or another build-time source module.
const REVIEWED_NORMAL_SOURCE = "c09c0a4a0f7958466af9a9294efc8a827d68defa";
const hash = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

interface TreeRow {
  readonly path: string;
  readonly type: "file" | "directory" | "link";
  readonly mode: number;
  readonly value: string;
  readonly identity: string;
  readonly blob?: string;
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  );
}

function regularBytes(path: string): { readonly bytes: Buffer; readonly identity: string } {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw preflightError("money native build requires regular input files");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before))
      throw preflightError("money native build input changed while opening");
    const bytes = readFileSync(fd);
    if (
      identity(fstatSync(fd, { bigint: true })) !== identity(before) ||
      identity(lstatSync(path, { bigint: true })) !== identity(before)
    )
      throw preflightError("money native build input changed while reading");
    return { bytes, identity: identity(before) };
  } finally {
    closeSync(fd);
  }
}

function readTree(root: string, source: boolean): readonly TreeRow[] {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root)
    throw preflightError("money native build root must be its own physical directory");
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw preflightError("money native build root must be its own physical directory");
  const rows: TreeRow[] = [
    {
      path: "",
      type: "directory",
      mode: Number(rootStat.mode & 0o777n),
      value: "",
      identity: identity(rootStat),
    },
  ];
  const visit = (path: string): void => {
    const before = lstatSync(path, { bigint: true });
    for (const name of readdirSync(path).sort()) {
      if (source && path === root && (name === ".git" || name === "node_modules")) continue;
      const child = join(path, name);
      const label = relative(root, child).split(sep).join("/");
      const stat = lstatSync(child, { bigint: true });
      if (stat.isSymbolicLink()) {
        if (source || isAbsolute(readlinkSync(child)))
          throw preflightError("money native build source or dependency link is not closed");
        const target = realpathSync(child);
        const local = relative(root, target);
        if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
          throw preflightError("money native build dependency link leaves its own closure");
        rows.push({
          path: label,
          type: "link",
          mode: Number(stat.mode & 0o777n),
          value: local.split(sep).join("/"),
          identity: identity(stat),
        });
      } else if (stat.isDirectory()) {
        rows.push({
          path: label,
          type: "directory",
          mode: Number(stat.mode & 0o777n),
          value: "",
          identity: identity(stat),
        });
        visit(child);
      } else {
        const file = regularBytes(child);
        const blob = createHash("sha1")
          .update(`blob ${file.bytes.length}\0`)
          .update(file.bytes)
          .digest("hex");
        rows.push({
          path: label,
          type: "file",
          mode: Number(stat.mode & 0o777n),
          value: hash(file.bytes),
          identity: file.identity,
          blob,
        });
      }
    }
    if (identity(lstatSync(path, { bigint: true })) !== identity(before))
      throw preflightError("money native build directory changed while reading");
  };
  visit(root);
  if (identity(lstatSync(root, { bigint: true })) !== identity(rootStat))
    throw preflightError("money native build root changed while reading");
  return rows;
}

/** Pure filesystem DATA, never a native owner or preparation registration. */
export function inspectMoneyNativeBuildDependencyTree(root: string): {
  readonly contentDigest: string;
  readonly identityDigest: string;
  readonly files: number;
} {
  const rows = readTree(root, false);
  return Object.freeze({
    contentDigest: hash(
      JSON.stringify(rows.map(({ path, type, mode, value }) => ({ path, type, mode, value }))),
    ),
    identityDigest: hash(JSON.stringify(rows)),
    files: rows.filter((row) => row.type === "file").length,
  });
}

export interface MoneyReviewedSourceEntry {
  readonly path: string;
  readonly blob: string;
  readonly executable: boolean;
}

/** Component DATA comparison; the native factory supplies its fixed Git tree. */
export function inspectMoneyNativeBuildSourceTree(
  root: string,
  expected: readonly MoneyReviewedSourceEntry[],
): {
  readonly contentDigest: string;
  readonly identityDigest: string;
  readonly files: number;
} {
  const entries = new Map(expected.map((entry) => [entry.path, entry]));
  const directories = new Set<string>();
  for (const entry of expected) {
    if (
      !/^[0-9a-f]{40}$/u.test(entry.blob) ||
      isAbsolute(entry.path) ||
      entry.path.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      throw preflightError("money reviewed source entry is invalid");
    for (let path = dirname(entry.path); path !== "."; path = dirname(path)) directories.add(path);
  }
  const rows = readTree(root, true);
  const files = rows.filter((row) => row.type === "file");
  if (
    expected.length === 0 ||
    entries.size !== expected.length ||
    files.length !== entries.size ||
    rows.some((row) => row.type === "directory" && row.path !== "" && !directories.has(row.path)) ||
    files.some((row) => {
      const selected = entries.get(row.path);
      return (
        !selected || row.blob !== selected.blob || Boolean(row.mode & 0o111) !== selected.executable
      );
    })
  )
    throw preflightError("money selected disk source differs from the reviewed complete Git tree");
  return Object.freeze({
    contentDigest: hash(JSON.stringify(expected)),
    identityDigest: hash(JSON.stringify(rows)),
    files: files.length,
  });
}

export interface MoneyNativeSourceBuild {
  readonly sourceCommit: string;
  readonly sourceTreeDigest: string;
  readonly dependencyClosureDigest: string;
  readonly toolClosureDigest: string;
  readonly wranglerPath: string;
  readonly run: WorkerArtifactProcess;
  assertCurrent(): void;
  sourceAt(
    path: "src/entry-worker.ts" | "src/entry-cloudflare-worker.ts" | "src/stripe-mode-realm.ts",
  ): Promise<string>;
}

export interface MoneyNativeBuildClosure {
  readonly sourceCommit: string;
  assertCurrent(): void;
  bindSource(
    sourceRoot: string,
    sourceCommit: string,
    outputRoot: string,
  ): Promise<MoneyNativeSourceBuild>;
}

/**
 * Called inside the default original owner factory before its first await.
 * Neither the selector nor dependency injection supplies this receiver/toolset.
 */
export function captureMoneyNativeBuildClosure(): MoneyNativeBuildClosure {
  const originalRun = runCommand;
  const originalBuild = prepareWorkerArtifact;
  const originalConfig = writeWorkerConfig;
  const originalSpawn = Bun.spawn;
  const gitPath = realpathSync(Bun.which("git") ?? "");
  const nodePath = realpathSync(Bun.which("node") ?? "");
  const wranglerPath = realpathSync(WRANGLER);
  const dependencyRoot = realpathSync(join(REPOSITORY, "node_modules"));
  if (!wranglerPath.startsWith(`${dependencyRoot}${sep}`))
    throw preflightError("money native Wrangler must belong to the original owner dependencies");
  const dependencies = inspectMoneyNativeBuildDependencyTree(dependencyRoot);
  const toolPaths = [
    gitPath,
    nodePath,
    realpathSync(process.execPath),
    wranglerPath,
    fileURLToPath(import.meta.url),
    join(REPOSITORY, "scripts/deploy/process.ts"),
    join(REPOSITORY, "scripts/deploy/worker-artifact.ts"),
    join(REPOSITORY, "scripts/deploy/realized-config.ts"),
  ];
  const readTools = () =>
    toolPaths.map((path) => ({
      path,
      ...(() => {
        const file = regularBytes(path);
        return { digest: hash(file.bytes), identity: file.identity };
      })(),
    }));
  const tools = JSON.stringify(readTools());
  const toolClosureDigest = hash(tools);
  const assertTools = (): void => {
    if (
      runCommand !== originalRun ||
      prepareWorkerArtifact !== originalBuild ||
      writeWorkerConfig !== originalConfig ||
      Bun.spawn !== originalSpawn ||
      realpathSync(WRANGLER) !== wranglerPath ||
      realpathSync(join(REPOSITORY, "node_modules")) !== dependencyRoot ||
      JSON.stringify(readTools()) !== tools
    )
      throw preflightError("money native owner build closure changed");
  };
  const assertCurrent = (): void => {
    assertTools();
    if (
      inspectMoneyNativeBuildDependencyTree(dependencyRoot).identityDigest !==
      dependencies.identityDigest
    )
      throw preflightError("money native owner dependency closure changed");
  };
  return Object.freeze({
    sourceCommit: REVIEWED_NORMAL_SOURCE,
    assertCurrent,
    async bindSource(
      sourceRoot: string,
      sourceCommit: string,
      outputRoot: string,
    ): Promise<MoneyNativeSourceBuild> {
      assertCurrent();
      if (sourceCommit !== REVIEWED_NORMAL_SOURCE)
        throw preflightError(
          "money normal Worker source is outside the reviewed complete source closure",
        );
      const privateEnvironment: Record<string, string> = {
        PATH: `${dirname(nodePath)}:${dirname(gitPath)}:/usr/bin:/bin`,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_COUNT: "0",
      };
      for (const [key, directory] of Object.entries({
        HOME: "home",
        TMPDIR: "tmp",
        XDG_CONFIG_HOME: "config",
        XDG_CACHE_HOME: "cache",
      })) {
        const path = join(outputRoot, directory);
        mkdirSync(path, { mode: 0o700 });
        privateEnvironment[key] = path;
      }
      const execute: WorkerArtifactProcess = async (command, options = {}) => {
        assertTools();
        let argv: readonly string[];
        if (command[0] === wranglerPath) argv = [nodePath, wranglerPath, ...command.slice(1)];
        else if (command[0] === "git")
          argv = [
            gitPath,
            "--no-replace-objects",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            ...command.slice(1),
          ];
        else throw preflightError("money native build refused a foreign executable");
        const result = await originalRun(argv, {
          ...options,
          env: { ...options.env, ...privateEnvironment },
        });
        assertTools();
        return result;
      };
      const tree = await execute([
        "git",
        "-C",
        REPOSITORY,
        "ls-tree",
        "-r",
        "-z",
        REVIEWED_NORMAL_SOURCE,
      ]);
      if (tree.exitCode !== 0)
        throw preflightError("money reviewed immutable source tree is unavailable");
      const expected = new Map<string, { readonly blob: string; readonly executable: boolean }>();
      for (const entry of tree.stdout.split("\0")) {
        if (entry === "") continue;
        const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)$/u.exec(entry);
        if (
          !match?.[1] ||
          !match[2] ||
          !match[3] ||
          match[3].split("/").some((part) => part === ".." || part === "." || part === "")
        )
          throw preflightError("money reviewed source tree has unsupported entries");
        expected.set(match[3], { blob: match[2], executable: match[1] === "100755" });
      }
      const expectedSource = [...expected].map(([path, entry]) => ({ path, ...entry }));
      const source = inspectMoneyNativeBuildSourceTree(sourceRoot, expectedSource);
      const selectedDependenciesRoot = join(sourceRoot, "node_modules");
      const selectedDependencies = inspectMoneyNativeBuildDependencyTree(selectedDependenciesRoot);
      if (selectedDependencies.contentDigest !== dependencies.contentDigest)
        throw preflightError(
          "money selected dependency bytes differ from the original owner closure",
        );
      for (let parent = dirname(sourceRoot); ; parent = dirname(parent)) {
        try {
          lstatSync(join(parent, "node_modules"));
          throw preflightError(
            "money selected source has an unbound ancestor dependency directory",
          );
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
        if (parent === dirname(parent)) break;
      }
      const assertSource = (): void => {
        assertCurrent();
        if (
          inspectMoneyNativeBuildSourceTree(sourceRoot, expectedSource).identityDigest !==
            source.identityDigest ||
          inspectMoneyNativeBuildDependencyTree(selectedDependenciesRoot).identityDigest !==
            selectedDependencies.identityDigest
        )
          throw preflightError("money selected source/dependency closure changed");
      };
      const run: WorkerArtifactProcess = async (command, options) => {
        // Rehash the complete dependency/source closure at actual build bounds,
        // not at unrelated native GETs or immutable Git-object reads.
        const building = command[0] === wranglerPath;
        if (building) assertSource();
        const result = await execute(command, options);
        if (building) assertSource();
        return result;
      };
      assertSource();
      return Object.freeze({
        sourceCommit: REVIEWED_NORMAL_SOURCE,
        sourceTreeDigest: source.contentDigest,
        dependencyClosureDigest: dependencies.contentDigest,
        toolClosureDigest,
        wranglerPath,
        run,
        assertCurrent: assertSource,
        async sourceAt(
          path:
            | "src/entry-worker.ts"
            | "src/entry-cloudflare-worker.ts"
            | "src/stripe-mode-realm.ts",
        ) {
          const result = await run([
            "git",
            "-C",
            REPOSITORY,
            "show",
            `${REVIEWED_NORMAL_SOURCE}:${path}`,
          ]);
          if (
            result.exitCode !== 0 ||
            result.stdout.length === 0 ||
            result.stdout.length > 1024 * 1024
          )
            throw preflightError("money reviewed immutable source module is unavailable");
          return result.stdout;
        },
      });
    },
  });
}
