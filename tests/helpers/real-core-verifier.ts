import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "../../src/json.ts";
import type { FormPackageInput } from "../../src/takoform/form-packages.ts";
import type { PublisherSetClosure } from "../../src/takoform/publisher-set-closure.ts";

const CORE_VERIFIER_DIRECTORY = "services/takoform-core-verifier";
const CORE_VERIFIER_ENTRYPOINT = "./cmd/server";
const CORE_VERIFIER_PROTOCOL = "takoserver.takoform-core-verifier@v1";

export function buildRealCoreVerifier(outputDirectory: string): string {
  const repository = process.cwd();
  const output = resolve(outputDirectory, "takoform-core-verifier");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const cacheRoot = process.env.TAKOSERVER_NATIVE_GO_CACHE;
  const moduleRoot = process.env.TAKOSERVER_NATIVE_GO_MODULES;
  const environment = {
    PATH: process.env.PATH ?? "/usr/local/go/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    TMPDIR: process.env.TMPDIR ?? outputDirectory,
    CGO_ENABLED: "0",
    GOOS: "linux",
    GOARCH: "amd64",
    GOMAXPROCS: "2",
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOFLAGS: "-mod=readonly",
    ...(cacheRoot ? { GOCACHE: cacheRoot } : {}),
    ...(moduleRoot ? { GOMODCACHE: moduleRoot } : {}),
  };
  const result = Bun.spawnSync(
    ["go", "build", "-p=2", "-trimpath", "-ldflags=-s -w", "-o", output, CORE_VERIFIER_ENTRYPOINT],
    {
      cwd: join(repository, CORE_VERIFIER_DIRECTORY),
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
      killSignal: "SIGKILL",
    },
  );
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const failure = result.exitedDueToTimeout ? "timeout" : result.exitCode;
    throw new Error(`selfhost_real_core_verifier_build_failed_${failure}_${stderr}`);
  }
  return output;
}

export async function realCoreVerificationRequest(closure: PublisherSetClosure): Promise<Json> {
  const core = closure.evidence.core;
  if (!core || core.protocol !== CORE_VERIFIER_PROTOCOL) {
    throw new Error("selfhost_real_core_verifier_closure_missing");
  }
  return {
    protocol: core.protocol,
    expectedSourceCommit: core.expectedSourceCommit,
    publisherPolicy: base64(new TextEncoder().encode(core.publisherPolicy)),
    trustedRoot: base64(new TextEncoder().encode(core.trustedRoot)),
    checkpoint: base64(new TextEncoder().encode(core.checkpoint)),
    checkpointBundle: base64(new TextEncoder().encode(core.checkpointBundle)),
    packages: await Promise.all(
      closure.packageSet.map(async (identity) => {
        const pkg = await closure.packages.load(identity);
        const packageBundle = core.packageBundles.find(
          (entry) =>
            entry.packageDigest === pkg.packageDigest &&
            canonicalJson(entry.formRef) === canonicalJson(pkg.formRef),
        );
        if (!pkg.manifest || !packageBundle) {
          throw new Error("selfhost_real_core_verifier_package_closure_incomplete");
        }
        return {
          packageDigest: pkg.packageDigest,
          formRef: pkg.formRef,
          index: base64(new TextEncoder().encode(canonicalJson(pkg.manifest))),
          bundle: base64(new TextEncoder().encode(packageBundle.bundle)),
          files: pkg.files.map((file) => ({
            path: file.path,
            bytes: base64(boundedBytes(file.bytes)),
          })),
        };
      }),
    ),
  };
}

function boundedBytes(value: FormPackageInput["files"][number]["bytes"]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("selfhost_real_core_verifier_requires_bounded_package_closure");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

type Json = Record<string, unknown>;
