import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DeployError, preflightError } from "./errors.ts";
import { type CommandResult, REPOSITORY, wranglerCommand } from "./process.ts";
import { type SealedArtifact, sealDirectory } from "./qualification.ts";
import { writeWorkerConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";

export type WorkerArtifactProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface PreparedWorkerArtifact {
  readonly releaseDirectory: string;
  readonly bundlePath: string;
  readonly configPath: string;
  readonly bundleDigestHex: string;
  seal(additionalRequiredFiles?: readonly string[]): SealedArtifact;
}

/**
 * Builds exactly once, reduces Wrangler output to one link-free bundle, and
 * realizes the upload config beside it. Callers may add a 0600 secrets file,
 * then seal the whole directory immediately before their single upload.
 */
export async function prepareWorkerArtifact(input: {
  readonly root: string;
  readonly target: DeployTarget;
  readonly commit: string;
  readonly hostedTopology: "desired" | "absent";
  readonly signingKeyId?: string;
  readonly run: WorkerArtifactProcess;
}): Promise<PreparedWorkerArtifact> {
  const build = join(input.root, "build");
  const release = join(input.root, "release");
  mkdirSync(build, { recursive: true, mode: 0o700 });
  mkdirSync(release, { recursive: true, mode: 0o700 });
  const buildConfig = writeWorkerConfig(input.target, {
    path: join(input.root, "build-wrangler.jsonc"),
    main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
    commit: input.commit,
    hostedTopology: input.hostedTopology,
    ...(input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId }),
  });
  const built = await input.run(
    wranglerCommand([
      "deploy",
      "--dry-run",
      "--strict",
      "--config",
      buildConfig,
      "--outdir",
      build,
    ]),
  );
  if (built.exitCode !== 0) {
    throw new DeployError(
      "preflight",
      `exact Worker bundle build failed (exit ${built.exitCode})`,
      `${built.stdout}${built.stderr}`.trim(),
    );
  }
  const source = exactBundle(build);
  const bundlePath = join(release, "worker.js");
  copyFileSync(source, bundlePath);
  const bundleDigestHex = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
  const configPath = writeWorkerConfig(input.target, {
    path: join(release, "wrangler.jsonc"),
    main: "worker.js",
    commit: input.commit,
    hostedTopology: input.hostedTopology,
    ...(input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId }),
  });
  let sealed = false;
  return {
    releaseDirectory: release,
    bundlePath,
    configPath,
    bundleDigestHex,
    seal(additionalRequiredFiles = []) {
      if (sealed) throw preflightError("Worker artifact may be sealed only once");
      sealed = true;
      return sealDirectory(release, ["worker.js", "wrangler.jsonc", ...additionalRequiredFiles]);
    },
  };
}

function exactBundle(root: string): string {
  const files = regularFiles(root);
  const bundles = files.filter((path) => path.endsWith(".js"));
  if (bundles.length !== 1) {
    throw preflightError(
      "Worker dry-run must produce exactly one link-free JavaScript bundle",
      JSON.stringify(files.map((path) => path.slice(root.length + 1))),
    );
  }
  const bundle = bundles[0] as string;
  // Current Wrangler outdirs also contain the bundle's source map and a
  // generated README. They are qualified as link-free output, but neither is
  // part of the `--no-bundle` upload. Any other sibling is an unexpected build
  // product and fails closed instead of being silently dropped.
  const allowed = new Set([bundle, `${bundle}.map`, join(root, "README.md")]);
  const unexpected = files.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw preflightError(
      "Worker dry-run produced an unexpected ancillary file",
      JSON.stringify(unexpected.map((path) => path.slice(root.length + 1))),
    );
  }
  return bundle;
}

function regularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink() || (status.isFile() && status.nlink !== 1)) {
        throw preflightError(`Worker build output is not link-free: ${path}`);
      }
      if (status.isDirectory()) visit(path);
      else if (status.isFile()) files.push(path);
      else throw preflightError(`Worker build output is not a regular file: ${path}`);
    }
  };
  visit(root);
  return files;
}
