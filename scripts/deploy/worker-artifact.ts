import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  derivePublicFormImplementationIdentity,
  type PublicFormImplementationIdentity,
  publicFormCapabilityManifest,
} from "../../src/public-worker-implementation.ts";
import { DeployError, preflightError } from "./errors.ts";
import { assertPublicFormCapabilityTarget } from "./form-authority-capability.ts";
import { type CommandResult, REPOSITORY, wranglerCommand } from "./process.ts";
import { type SealedArtifact, sealDirectory } from "./qualification.ts";
import { writeWorkerConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";

export type WorkerArtifactProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface WorkerArtifactConfigInput {
  readonly path: string;
  readonly main: string;
  readonly bundleDigestHex?: string;
  readonly formImplementationIdentity?: PublicFormImplementationIdentity;
}

export type WorkerArtifactConfigWriter = (input: WorkerArtifactConfigInput) => string;

export type WorkerDryRunCommand = "deploy" | "versions-upload";

export interface PreparedWorkerArtifact {
  readonly releaseDirectory: string;
  readonly bundlePath: string;
  readonly configPath: string;
  readonly bundleDigestHex: string;
  readonly formImplementationIdentity?: PublicFormImplementationIdentity;
  seal(additionalRequiredFiles?: readonly string[]): SealedArtifact;
}

/**
 * Builds one uploadable outer bundle and realizes its config beside it. A
 * Form-authority target first performs one separate, non-uploaded payload
 * build whose digest becomes semantic identity. Callers may add a 0600 secrets
 * file, then seal the outer release directory before their single upload.
 */
export async function prepareWorkerArtifact(input: {
  readonly root: string;
  readonly target: DeployTarget;
  readonly commit: string;
  readonly signingKeyId?: string;
  /** Absolute entrypoint used for the dry-run build. */
  readonly main?: string;
  /** Optional target-specific config writer; the default realizes a public Worker config. */
  readonly writeConfig?: WorkerArtifactConfigWriter;
  /** Use the version API for a non-mutating build when the caller will publish explicitly. */
  readonly dryRunCommand?: WorkerDryRunCommand;
  readonly run: WorkerArtifactProcess;
}): Promise<PreparedWorkerArtifact> {
  const build = join(input.root, "build");
  const release = join(input.root, "release");
  mkdirSync(build, { recursive: true, mode: 0o700 });
  mkdirSync(release, { recursive: true, mode: 0o700 });
  const main = input.main ?? resolve(REPOSITORY, "src/entry-cloudflare-worker.ts");
  const formImplementationIdentity =
    input.target.formAuthority !== undefined &&
    resolve(main) === resolve(REPOSITORY, "src/entry-cloudflare-worker.ts")
      ? await preparePublicFormImplementationPayload({
          root: join(input.root, "form-implementation-payload"),
          target: input.target,
          run: input.run,
        })
      : undefined;
  const writeConfig =
    input.writeConfig ??
    ((config: WorkerArtifactConfigInput) =>
      writeWorkerConfig(input.target, {
        path: config.path,
        main: config.main,
        commit: input.commit,
        ...(input.signingKeyId === undefined ? {} : { signingKeyId: input.signingKeyId }),
        ...(config.formImplementationIdentity === undefined
          ? {}
          : { formImplementationIdentity: config.formImplementationIdentity }),
        ...(config.bundleDigestHex === undefined
          ? {}
          : { workerArtifactDigest: `sha256:${config.bundleDigestHex}` as const }),
        ...(config.bundleDigestHex === undefined
          ? { authorityProfile: { kind: "historical-pre-jit" as const } }
          : {
              authorityProfile: {
                kind: "provenance-bound-jit" as const,
                provenance: {
                  sourceCommit: input.commit,
                  artifactDigest: `sha256:${config.bundleDigestHex}` as const,
                },
              },
            }),
      }));
  const buildConfig = writeConfig({
    path: join(input.root, "build-wrangler.jsonc"),
    main,
    ...(formImplementationIdentity === undefined ? {} : { formImplementationIdentity }),
  });
  const built = await input.run(
    wranglerCommand([
      ...(input.dryRunCommand === "versions-upload" ? ["versions", "upload"] : ["deploy"]),
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
  writeFileSync(bundlePath, canonicalizeWorkerBundleSource(readFileSync(source, "utf8"), source));
  const bundleDigestHex = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
  const configPath = writeConfig({
    path: join(release, "wrangler.jsonc"),
    main: "worker.js",
    bundleDigestHex,
    ...(formImplementationIdentity === undefined ? {} : { formImplementationIdentity }),
  });
  let sealed = false;
  return {
    releaseDirectory: release,
    bundlePath,
    configPath,
    bundleDigestHex,
    ...(formImplementationIdentity === undefined ? {} : { formImplementationIdentity }),
    seal(additionalRequiredFiles = []) {
      if (sealed) throw preflightError("Worker artifact may be sealed only once");
      sealed = true;
      return sealDirectory(release, ["worker.js", "wrangler.jsonc", ...additionalRequiredFiles]);
    },
  };
}

async function preparePublicFormImplementationPayload(input: {
  readonly root: string;
  readonly target: DeployTarget;
  readonly run: WorkerArtifactProcess;
}): Promise<PublicFormImplementationIdentity> {
  assertPublicFormCapabilityTarget(input.target);
  const build = join(input.root, "build");
  const release = join(input.root, "release");
  mkdirSync(build, { recursive: true, mode: 0o700 });
  mkdirSync(release, { recursive: true, mode: 0o700 });
  const configPath = join(input.root, "wrangler.jsonc");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        name: "takoserver-public-form-runtime-payload",
        main: resolve(REPOSITORY, "src/entry-public-form-runtime-payload.ts"),
        compatibility_date: "2026-08-17",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: false,
        preview_urls: false,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const built = await input.run(
    wranglerCommand(["deploy", "--dry-run", "--strict", "--config", configPath, "--outdir", build]),
  );
  if (built.exitCode !== 0) {
    throw new DeployError(
      "preflight",
      `public Form implementation payload build failed (exit ${built.exitCode})`,
      `${built.stdout}${built.stderr}`.trim(),
    );
  }
  const source = exactBundle(build);
  const payloadPath = join(release, "form-implementation.js");
  writeFileSync(payloadPath, canonicalizeWorkerBundleSource(readFileSync(source, "utf8"), source));
  const implementationPayloadDigest = `sha256:${createHash("sha256")
    .update(readFileSync(payloadPath))
    .digest("hex")}` as const;
  const artifact = sealDirectory(release, ["form-implementation.js"]);
  artifact.assertUnchanged();
  return await derivePublicFormImplementationIdentity({
    implementationPayloadDigest,
    capabilities: publicFormCapabilityManifest(),
  });
}

/**
 * Esbuild emits source-label comments relative to the temporary output path.
 * Preserve the labels while making repository-owned paths independent of the
 * caller's temp-directory depth, so one source commit has one artifact digest.
 */
export function canonicalizeWorkerBundleSource(source: string, sourcePath: string): string {
  const repositoryPrefix = `${REPOSITORY}${sep}`;
  const absoluteSourcePath = resolve(sourcePath);
  return source
    .split("\n")
    .map((line) => {
      if (!line.startsWith("// ")) return line;
      const label = line.slice(3);
      let base = dirname(absoluteSourcePath);
      while (true) {
        const candidate = resolve(base, label);
        if (candidate === REPOSITORY || candidate.startsWith(repositoryPrefix)) {
          return `// ${relative(REPOSITORY, candidate).split(sep).join("/")}`;
        }
        const parent = dirname(base);
        if (parent === base) break;
        base = parent;
      }
      return line;
    })
    .join("\n");
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
