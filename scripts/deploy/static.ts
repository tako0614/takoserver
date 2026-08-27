import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DeployError, mutationError, preflightError, verificationError } from "./errors.ts";
import { type CommandResult, runCommand, wranglerCommand } from "./process.ts";

/** The single repo-owned Pages project for the public Takoserver landing site. */
export const PAGES_PROJECT = "takoserver-website";
export const PRODUCTION_BRANCH = "main";
export const PRODUCTION_ORIGIN = "https://takoserver.com";
export const CONSOLE_ORIGIN = "https://console.takoserver.com";
export const API_ORIGIN = "https://api.takoserver.com";

export type StaticSiteEnvironment = "integration" | "production";

export interface StaticSiteResult {
  readonly kind: "takos.static-site-deploy@v1";
  readonly surface: "takoserver-site";
  readonly environment: StaticSiteEnvironment;
  readonly project: string;
  readonly branch: string;
  readonly commit: string;
  readonly commitDirty: boolean;
  readonly artifactDigest: string;
  readonly artifactBytes: number;
  readonly artifactFiles: number;
  readonly immutableUrl: string;
  readonly readback: Readonly<{
    readonly immutable: Readonly<PublicReadback>;
    readonly production?: Readonly<PublicReadback>;
  }>;
}

export interface PublicReadback {
  readonly url: string;
  readonly status: number;
  readonly digest: string;
  readonly bytes: number;
}

export interface StaticProcessOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

export type StaticProcess = (
  command: readonly string[],
  options?: StaticProcessOptions,
) => Promise<CommandResult>;

export interface StaticSiteOptions {
  /** Replace child-process execution in focused tests. */
  readonly run?: StaticProcess;
  /** Replace HTTP readback in focused tests. */
  readonly fetcher?: StaticFetcher;
  /** Use an existing output directory instead of creating a temporary one. */
  readonly outputDirectory?: string;
}

export type StaticFetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface SourceRevision {
  readonly branch: string;
  readonly commit: string;
  readonly commitDirty: boolean;
}

interface ArtifactIdentity {
  readonly digest: string;
  readonly bytes: number;
  readonly files: number;
}

/**
 * Deploy the landing page through one direct Pages upload.
 *
 * Integration is deliberately iteration-friendly: a dirty non-main worktree
 * is built exactly once and uploaded to the current branch preview. Production
 * is the narrow release lane: clean `main`, freshly fetched `origin/main`, one
 * scoped build, one upload, and one immutable plus custom-domain readback.
 */
export async function runStaticSite(
  args: readonly string[],
  options: StaticSiteOptions = {},
): Promise<StaticSiteResult> {
  const environment = parseEnvironment(args);
  const run = options.run ?? runCommand;
  const source = await resolveSource(environment, run);
  const temporary = options.outputDirectory === undefined;
  const outputDirectory =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-site-"));

  try {
    await checked(run, "preflight", "site build", [
      "bun",
      "scripts/build-site.ts",
      "--out",
      outputDirectory,
      "--console",
      CONSOLE_ORIGIN,
      "--api",
      API_ORIGIN,
    ]);
    const artifact = artifactIdentity(outputDirectory);
    const upload = await uploadPages(environment, source, outputDirectory, run);
    const immutableUrl = parseImmutableUrl(`${upload.stdout}\n${upload.stderr}`, source.branch);
    const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    const index = readFileSync(join(outputDirectory, "index.html"));
    const immutable = await readback(immutableUrl, index, fetcher);
    const production =
      environment === "production"
        ? await readback(`${PRODUCTION_ORIGIN}/`, index, fetcher)
        : undefined;
    const result: StaticSiteResult = {
      kind: "takos.static-site-deploy@v1",
      surface: "takoserver-site",
      environment,
      project: PAGES_PROJECT,
      branch: source.branch,
      commit: source.commit,
      commitDirty: source.commitDirty,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      immutableUrl,
      readback: {
        immutable,
        ...(production === undefined ? {} : { production }),
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (temporary) rmSync(outputDirectory, { recursive: true, force: true });
  }
}

/** Parse the one explicit environment flag accepted by the site entrypoint. */
export function parseEnvironment(args: readonly string[]): StaticSiteEnvironment {
  let environment: StaticSiteEnvironment | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) throw preflightError("site environment argument is missing");
    if (argument === "--environment") {
      const value = args[index + 1];
      if (value === undefined)
        throw preflightError("site requires --environment=integration|production");
      index += 1;
      if (environment !== undefined) throw preflightError("site environment was specified twice");
      environment = parseEnvironmentValue(value);
      continue;
    }
    if (argument.startsWith("--environment=")) {
      if (environment !== undefined) throw preflightError("site environment was specified twice");
      environment = parseEnvironmentValue(argument.slice("--environment=".length));
      continue;
    }
    throw preflightError(
      "site accepts only --environment=integration or --environment=production; no target, plan, or reviewer is used",
    );
  }
  if (environment === undefined) {
    throw preflightError("site requires --environment=integration|production");
  }
  return environment;
}

function parseEnvironmentValue(value: string): StaticSiteEnvironment {
  if (value === "integration" || value === "production") return value;
  throw preflightError(`unknown site environment ${JSON.stringify(value)}`);
}

async function resolveSource(
  environment: StaticSiteEnvironment,
  run: StaticProcess,
): Promise<SourceRevision> {
  const branch = (
    await checked(run, "preflight", "current git branch", ["git", "branch", "--show-current"])
  ).trim();
  if (branch.length === 0) {
    throw preflightError("site deployment requires a named git branch");
  }
  const commit = (
    await checked(run, "preflight", "current git commit", ["git", "rev-parse", "HEAD"])
  ).trim();
  if (commit.length === 0) throw preflightError("site deployment could not resolve HEAD");
  const dirtyOutput = await checked(run, "preflight", "git worktree status", [
    "git",
    "status",
    "--porcelain",
  ]);
  const commitDirty = dirtyOutput.trim().length > 0;

  if (environment === "integration") {
    if (branch === PRODUCTION_BRANCH) {
      throw preflightError("integration site deployment requires a non-main Pages branch");
    }
    return { branch, commit, commitDirty };
  }

  if (branch !== PRODUCTION_BRANCH) {
    throw preflightError("production site deployment requires the main branch");
  }
  if (commitDirty) {
    throw preflightError(
      "production site deployment requires a clean worktree",
      dirtyOutput.trim(),
    );
  }
  await checked(run, "preflight", "fresh origin/main", [
    "git",
    "fetch",
    "--quiet",
    "origin",
    "main",
  ]);
  const remoteCommit = (
    await checked(run, "preflight", "origin/main commit", ["git", "rev-parse", "origin/main"])
  ).trim();
  if (remoteCommit !== commit) {
    throw preflightError(
      `production HEAD ${commit} does not equal freshly fetched origin/main ${remoteCommit}`,
    );
  }
  return { branch, commit, commitDirty: false };
}

async function uploadPages(
  environment: StaticSiteEnvironment,
  source: SourceRevision,
  outputDirectory: string,
  run: StaticProcess,
): Promise<CommandResult> {
  const command = wranglerCommand([
    "pages",
    "deploy",
    outputDirectory,
    "--project-name",
    PAGES_PROJECT,
    "--branch",
    source.branch,
    "--commit-hash",
    source.commit,
    `--commit-dirty=${environment === "integration" ? "true" : "false"}`,
  ]);
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw mutationError(
      "Pages publication is indeterminate; do not retry before readback",
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result;
}

function parseImmutableUrl(output: string, branch: string): string {
  const urls = [...output.matchAll(/https:\/\/[^\s"'<>]+\.pages\.dev(?:\/)?/gu)].map(
    (match) => match[0],
  );
  const branchUrls = new Set(
    [branch, branch.replaceAll(/[^a-z0-9-]+/giu, "-")]
      .map((value) => value.replaceAll(/^-+|-+$/gu, "").toLowerCase())
      .filter((value) => value.length > 0)
      .map((value) => `${value}.${PAGES_PROJECT}.pages.dev`),
  );
  const projectUrl = `${PAGES_PROJECT}.pages.dev`;
  for (const candidate of urls) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "/" && url.pathname !== "") ||
      branchUrls.has(hostname) ||
      hostname === projectUrl ||
      !hostname.endsWith(`.${PAGES_PROJECT}.pages.dev`)
    ) {
      continue;
    }
    return `${url.origin}/`;
  }
  throw mutationError(
    "Pages publication returned no immutable deployment URL",
    "The upload may be live. Read the provider deployment history before retrying.",
  );
}

async function readback(
  url: string,
  expected: Uint8Array,
  fetcher: StaticFetcher,
): Promise<PublicReadback> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
      redirect: "follow",
    });
  } catch (error) {
    throw verificationError(
      `site readback failed for ${url}`,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (response.status !== 200) {
    throw verificationError(`site readback returned HTTP ${response.status} for ${url}`);
  }
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const expectedDigest = `sha256:${createHash("sha256").update(expected).digest("hex")}`;
  if (digest !== expectedDigest || body.byteLength !== expected.byteLength) {
    throw verificationError(
      `site readback bytes differ for ${url}`,
      `expected ${expectedDigest}/${expected.byteLength}, received ${digest}/${body.byteLength}`,
    );
  }
  return { url, status: response.status, digest, bytes: body.byteLength };
}

function artifactIdentity(directory: string): ArtifactIdentity {
  const paths = walk(directory).sort();
  if (paths.length === 0 || !paths.some((path) => relative(directory, path) === "index.html")) {
    throw preflightError("site build produced no index.html");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of paths) {
    const name = relative(directory, path).replaceAll("\\", "/");
    const contents = readFileSync(path);
    hash.update(name);
    hash.update("\0");
    hash.update(contents);
    bytes += contents.byteLength;
  }
  return { digest: `sha256:${hash.digest("hex")}`, bytes, files: paths.length };
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

async function checked(
  run: StaticProcess,
  phase: "preflight" | "mutation" | "verification",
  description: string,
  command: readonly string[],
): Promise<string> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw new DeployError(
      phase,
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}
