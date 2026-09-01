import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesDigest, canonicalDigest, canonicalJson, isJsonObject } from "../src/json.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import {
  YURUCOMMU_FORM_VERSIONS,
  yurucommuFormCandidates,
} from "../src/takoform/implementation-catalog.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = resolve(ROOT, "src/generated/takoform-integration-form-packages.ts");
const check = process.argv.includes("--check");
const source = optionalFlag("--source");

interface Candidate {
  readonly kind: string;
  readonly path: string;
  readonly formRef: Record<string, unknown>;
  readonly packageDigest: string;
}

interface PackageFile {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly mediaType?: string;
}

interface EmbeddedPackageFile {
  readonly path: string;
  readonly digest: string;
  readonly mediaType?: string;
  readonly base64: string;
}

interface EmbeddedPackage {
  readonly packageDigest: string;
  readonly formRef: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
  readonly files: readonly EmbeddedPackageFile[];
}

const verifiedCandidates = yurucommuFormCandidates(currentTakoformCandidates().forms);
const generated = source
  ? await generateFromSource(resolve(source))
  : await readAndVerifyEmbeddedPackages();
const formatted = format(generated);

if (check) {
  if (readFileSync(OUTPUT, "utf8") !== formatted) {
    throw new Error("integration Form package corpus is stale");
  }
} else {
  if (!source) throw new Error("writing the integration Form package corpus requires --source");
  writeFileSync(OUTPUT, formatted);
}

async function generateFromSource(sourceRoot: string): Promise<readonly EmbeddedPackage[]> {
  const fixtureRoot = resolve(sourceRoot, "forms/candidates/edge.forms.takoform.com");
  const candidateSet = JSON.parse(
    readFileSync(resolve(fixtureRoot, "candidate-set.json"), "utf8"),
  ) as { readonly forms?: readonly Candidate[] };
  if (!Array.isArray(candidateSet.forms)) throw new Error("edge candidate set is malformed");

  const packages: EmbeddedPackage[] = [];
  for (const form of verifiedCandidates) {
    const kind = form.identity.formRef.kind;
    const definitionVersion = YURUCOMMU_FORM_VERSIONS[kind as keyof typeof YURUCOMMU_FORM_VERSIONS];
    const matches = candidateSet.forms.filter(
      (candidate) =>
        candidate.kind === kind &&
        candidate.formRef.definitionVersion === definitionVersion &&
        canonicalJson(candidate.formRef) === canonicalJson(form.identity.formRef) &&
        candidate.packageDigest === form.identity.packageDigest,
    );
    const candidate = matches[0];
    if (matches.length !== 1 || !candidate) {
      throw new Error(`exact generated package candidate is missing: ${kind}`);
    }
    const packageRoot = resolve(sourceRoot, candidate.path);
    if (!packageRoot.startsWith(`${fixtureRoot}/`)) {
      throw new Error(`package path escaped the verified source root: ${kind}`);
    }
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package-index.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      !isJsonObject(manifest) ||
      canonicalJson(manifest.formRef) !== canonicalJson(form.identity.formRef) ||
      (await canonicalDigest(manifest)) !== form.identity.packageDigest ||
      !Array.isArray(manifest.files)
    ) {
      throw new Error(`verified package manifest drifted: ${kind}`);
    }
    const files: EmbeddedPackageFile[] = [];
    for (const descriptor of manifest.files as unknown as readonly PackageFile[]) {
      assertPackageFile(descriptor, kind);
      const path = resolve(packageRoot, descriptor.path);
      if (!path.startsWith(`${packageRoot}/`)) {
        throw new Error(`package payload path escaped its root: ${kind}`);
      }
      const bytes = readFileSync(path);
      if (
        bytes.byteLength !== descriptor.size ||
        (await bytesDigest(bytes)) !== descriptor.digest
      ) {
        throw new Error(`verified package payload drifted: ${kind}/${descriptor.path}`);
      }
      files.push({
        path: descriptor.path,
        digest: descriptor.digest,
        ...(descriptor.mediaType === undefined ? {} : { mediaType: descriptor.mediaType }),
        base64: bytes.toString("base64"),
      });
    }
    packages.push({
      packageDigest: form.identity.packageDigest,
      formRef: structuredClone(form.identity.formRef) as unknown as Record<string, unknown>,
      manifest,
      files,
    });
  }
  await assertEmbeddedPackages(packages);
  return packages;
}

async function readAndVerifyEmbeddedPackages(): Promise<readonly EmbeddedPackage[]> {
  if (!check) throw new Error("writing the integration Form package corpus requires --source");
  const imported = await import("../src/generated/takoform-integration-form-packages.ts");
  const packages = structuredClone(
    imported.INTEGRATION_FORM_PACKAGES,
  ) as unknown as EmbeddedPackage[];
  await assertEmbeddedPackages(packages);
  return packages;
}

async function assertEmbeddedPackages(packages: readonly EmbeddedPackage[]): Promise<void> {
  if (packages.length !== verifiedCandidates.length) {
    throw new Error("integration Form package corpus count drifted");
  }
  for (const form of verifiedCandidates) {
    const kind = form.identity.formRef.kind;
    const matches = packages.filter(
      (candidate) =>
        candidate.packageDigest === form.identity.packageDigest &&
        canonicalJson(candidate.formRef) === canonicalJson(form.identity.formRef),
    );
    const candidate = matches[0];
    if (matches.length !== 1 || !candidate) {
      throw new Error(`exact embedded package candidate is missing: ${kind}`);
    }
    if (
      !isJsonObject(candidate.manifest) ||
      canonicalJson(candidate.manifest.formRef) !== canonicalJson(form.identity.formRef) ||
      (await canonicalDigest(candidate.manifest)) !== form.identity.packageDigest ||
      !Array.isArray(candidate.manifest.files) ||
      candidate.files.length !== candidate.manifest.files.length
    ) {
      throw new Error(`embedded package manifest drifted: ${kind}`);
    }
    const seen = new Set<string>();
    for (const descriptor of candidate.manifest.files as unknown as readonly PackageFile[]) {
      assertPackageFile(descriptor, kind);
      const matches = candidate.files.filter((file) => file.path === descriptor.path);
      const file = matches[0];
      if (
        matches.length !== 1 ||
        !file ||
        seen.has(file.path) ||
        file.digest !== descriptor.digest ||
        file.mediaType !== descriptor.mediaType ||
        typeof file.base64 !== "string"
      ) {
        throw new Error(`embedded package payload descriptor drifted: ${kind}/${descriptor.path}`);
      }
      seen.add(file.path);
      const bytes = Buffer.from(file.base64, "base64");
      if (
        bytes.toString("base64") !== file.base64 ||
        bytes.byteLength !== descriptor.size ||
        (await bytesDigest(bytes)) !== descriptor.digest
      ) {
        throw new Error(`embedded package payload drifted: ${kind}/${descriptor.path}`);
      }
    }
  }
}

function assertPackageFile(value: unknown, kind: string): asserts value is PackageFile {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as PackageFile).path !== "string" ||
    typeof (value as PackageFile).digest !== "string" ||
    !Number.isSafeInteger((value as PackageFile).size) ||
    ((value as PackageFile).mediaType !== undefined &&
      typeof (value as PackageFile).mediaType !== "string")
  ) {
    throw new Error(`verified package file descriptor is malformed: ${kind}`);
  }
}

function format(packages: readonly EmbeddedPackage[]): string {
  const output = `${[
    "// Code generated by scripts/import-publisher-set.ts. DO NOT EDIT.",
    "// Package bytes are projected from an exact released-Core-verified publisher set.",
    "",
    `export const INTEGRATION_FORM_PACKAGES = ${JSON.stringify(packages, null, 2)} as const;`,
    "",
  ].join("\n")}`;
  return execFileSync(process.execPath, ["x", "biome", "format", "--stdin-file-path", OUTPUT], {
    cwd: ROOT,
    input: output,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function optionalFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}
