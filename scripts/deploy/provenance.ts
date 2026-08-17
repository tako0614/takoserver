import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { preflightError } from "./errors.ts";
import { REPOSITORY, runChecked, runCommand, wranglerCommand } from "./process.ts";

/**
 * Proves the worktree is exactly one clean commit that already exists on the
 * remote. Publication that cannot be pointed back at a fetchable commit has no
 * provenance, so this refuses rather than publishing an unreachable tree.
 */
export async function resolvePushedCommit(): Promise<{
  readonly commit: string;
  readonly branch: string;
  readonly remoteUrl: string;
}> {
  const dirty = (
    await runChecked("preflight", "git status", ["git", "status", "--porcelain"])
  ).trim();
  if (dirty.length > 0) {
    throw preflightError("the worktree is dirty; publish only a clean reviewed commit", dirty);
  }

  const commit = (
    await runChecked("preflight", "git rev-parse", ["git", "rev-parse", "HEAD"])
  ).trim();
  const branch = (
    await runChecked("preflight", "git branch", ["git", "rev-parse", "--abbrev-ref", "HEAD"])
  ).trim();

  const upstream = await runCommand([
    "git",
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (upstream.exitCode !== 0) {
    throw preflightError(`branch ${branch} has no upstream; push it before deploying`);
  }
  const tracking = upstream.stdout.trim();
  const remote = tracking.split("/")[0];
  if (remote === undefined || remote.length === 0) {
    throw preflightError(`cannot resolve the remote for ${tracking}`);
  }

  await runChecked("preflight", "git fetch", ["git", "fetch", "--quiet", remote]);
  const contained = await runCommand(["git", "merge-base", "--is-ancestor", commit, tracking]);
  if (contained.exitCode !== 0) {
    throw preflightError(
      `commit ${commit} is not contained in ${tracking}; push it before deploying`,
    );
  }
  const remoteUrl = (
    await runChecked("preflight", "git remote", ["git", "remote", "get-url", remote])
  ).trim();
  return { commit, branch, remoteUrl };
}

/**
 * Builds the exact bytes that will be uploaded and digests them. The same
 * strict dry-run also proves the realized configuration compiles and that no
 * Cloudflare REST or credential surface reached the bundle.
 */
export async function buildBundleDigest(configPath: string): Promise<{
  readonly digest: string;
  readonly bytes: number;
}> {
  const output = mkdtempSync(join(tmpdir(), "takoserver-deploy-bundle-"));
  try {
    await runChecked(
      "preflight",
      "wrangler strict dry-run",
      wranglerCommand([
        "deploy",
        "--dry-run",
        "--strict",
        "--config",
        configPath,
        "--outdir",
        output,
      ]),
    );
    const bundles = files(output)
      .filter((path) => path.endsWith(".js"))
      .sort();
    if (bundles.length === 0) throw preflightError("the strict dry-run produced no bundle");

    const hash = createHash("sha256");
    let bytes = 0;
    for (const path of bundles) {
      const contents = readFileSync(path);
      hash.update(path.slice(output.length));
      hash.update(contents);
      bytes += contents.byteLength;
    }
    return { digest: `sha256:${hash.digest("hex")}`, bytes };
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

/** Digests the migration bytes that define the durable schema lineage. */
export function migrationProvenance(): {
  readonly digest: string;
  readonly files: readonly string[];
} {
  const directory = resolve(REPOSITORY, "migrations");
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) throw preflightError("no migrations found");
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update(readFileSync(join(directory, name)));
  }
  return { digest: `sha256:${hash.digest("hex")}`, files: names };
}

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
