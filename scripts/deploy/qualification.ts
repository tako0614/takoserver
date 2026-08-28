import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { preflightError } from "./errors.ts";
import { type CommandResult, runCommand } from "./process.ts";

export type DeployEnvironment = "integration" | "rehearsal" | "production";

export type QualificationProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface SourceQualification {
  readonly commit: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly changedPaths: readonly string[];
  readonly remoteRef: string | null;
}

/**
 * Qualifies the one worktree the command will publish.
 *
 * Integration and rehearsal intentionally retain dirty iteration. Production
 * accepts either current origin/main or an explicit clean commit that a remote
 * ref already contains; the `--commit` selector never means "whatever HEAD is".
 */
export async function qualifySource(input: {
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly run?: QualificationProcess;
}): Promise<SourceQualification> {
  if (!/^[0-9a-f]{40}$/u.test(input.commit)) {
    throw preflightError("--commit must be one exact lowercase 40-hex commit");
  }
  const run = input.run ?? runCommand;
  const head = (await checked(run, "git rev-parse HEAD", ["git", "rev-parse", "HEAD"])).trim();
  if (head !== input.commit) {
    throw preflightError(`selected commit ${input.commit} does not equal worktree HEAD ${head}`);
  }
  const branch = (
    await checked(run, "git branch --show-current", ["git", "branch", "--show-current"])
  ).trim();
  const dirtyOutput = await checked(run, "git status", [
    "git",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const changedPaths = porcelainPaths(dirtyOutput);
  const dirty = changedPaths.length > 0;
  if (input.environment !== "production") {
    return { commit: head, branch, dirty, changedPaths, remoteRef: null };
  }
  if (dirty) {
    throw preflightError(
      "production publication requires a clean worktree",
      JSON.stringify(changedPaths),
    );
  }

  if (branch === "main") {
    await checked(run, "fresh origin/main", ["git", "fetch", "--quiet", "origin", "main"]);
    const remote = (
      await checked(run, "origin/main commit", ["git", "rev-parse", "origin/main"])
    ).trim();
    if (remote !== head) {
      throw preflightError(
        `production main ${head} does not equal freshly fetched origin/main ${remote}`,
      );
    }
    return { commit: head, branch, dirty: false, changedPaths: [], remoteRef: "origin/main" };
  }

  await checked(run, "fresh remote refs", ["git", "fetch", "--quiet", "--all", "--prune"]);
  const contains = await checked(run, "remote reachability", [
    "git",
    "branch",
    "-r",
    "--contains",
    head,
  ]);
  const remoteRefs = contains
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s*/u, ""))
    .filter((line) => line.length > 0 && !line.includes(" -> "))
    .sort();
  const remoteRef = remoteRefs[0];
  if (!remoteRef) {
    throw preflightError(`production commit ${head} is not reachable from an exact remote ref`);
  }
  return { commit: head, branch, dirty: false, changedPaths: [], remoteRef };
}

/** Exact path inventory from NUL-delimited porcelain v1, including both sides of renames. */
function porcelainPaths(output: string): readonly string[] {
  if (output.length === 0) return [];
  const entries = output.split("\0");
  if (entries.at(-1) !== "") {
    throw preflightError("git status did not return a complete NUL-delimited inventory");
  }
  entries.pop();
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4 || entry[2] !== " ") {
      throw preflightError("git status returned a malformed porcelain entry");
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length === 0) throw preflightError("git status returned an empty changed path");
    paths.push(path);
    if (status.includes("R") || status.includes("C")) {
      const original = entries[index + 1];
      if (!original) throw preflightError("git status returned an incomplete rename entry");
      paths.push(original);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

export interface SealedArtifact {
  readonly root: string;
  readonly digest: string;
  readonly bytes: number;
  readonly files: number;
  assertUnchanged(): void;
}

interface ArtifactIdentity {
  readonly digest: string;
  readonly bytes: number;
  readonly files: number;
}

/**
 * Seals one already-built artifact tree and returns the small requalification
 * interface every uploader uses. No symlink, hardlink, device, socket or path
 * outside the tree can become part of published bytes.
 */
export function sealDirectory(
  directory: string,
  requiredFiles: readonly string[] = [],
): SealedArtifact {
  const root = realpathSync(directory);
  const status = lstatSync(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw preflightError("artifact root must be a link-free directory");
  }
  const paths = linkFreeFiles(root);
  const names = new Set(paths.map((path) => portableRelative(root, path)));
  for (const required of requiredFiles) {
    if (!names.has(required)) throw preflightError(`sealed artifact is missing ${required}`);
  }
  for (const path of paths) chmodSync(path, 0o400);
  for (const path of directories(root).sort((left, right) => right.length - left.length)) {
    chmodSync(path, 0o500);
  }
  const sealed = identity(root);
  return {
    root,
    ...sealed,
    assertUnchanged() {
      const current = identity(root);
      if (
        current.digest !== sealed.digest ||
        current.bytes !== sealed.bytes ||
        current.files !== sealed.files
      ) {
        throw preflightError(
          "artifact changed after it was sealed",
          `expected ${sealed.digest}/${sealed.bytes}/${sealed.files}, ` +
            `received ${current.digest}/${current.bytes}/${current.files}`,
        );
      }
    },
  };
}

function identity(root: string): ArtifactIdentity {
  const paths = linkFreeFiles(root);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of paths) {
    const name = portableRelative(root, path);
    const body = readFileSync(path);
    hash.update(name);
    hash.update("\0");
    hash.update(String(body.byteLength));
    hash.update("\0");
    hash.update(body);
    bytes += body.byteLength;
  }
  return { digest: `sha256:${hash.digest("hex")}`, bytes, files: paths.length };
}

function linkFreeFiles(root: string): string[] {
  const canonicalRoot = realpathSync(root);
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) throw preflightError(`artifact is not link-free: ${path}`);
      const canonical = realpathSync(path);
      if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
        throw preflightError(`artifact path escapes its link-free root: ${path}`);
      }
      if (status.isDirectory()) {
        visit(path);
      } else if (status.isFile() && status.nlink === 1) {
        result.push(path);
      } else {
        throw preflightError(`artifact is not link-free: ${path}`);
      }
    }
  };
  visit(root);
  return result;
}

function directories(root: string): string[] {
  const result = [root];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    if (statSync(path).isDirectory()) result.push(...directories(path));
  }
  return result;
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

async function checked(
  run: QualificationProcess,
  description: string,
  command: readonly string[],
): Promise<string> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw preflightError(
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}
