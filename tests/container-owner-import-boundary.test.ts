import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CONTAINER = "src/takoform-v2/container-owner-schema.ts";
const SOURCES = [
  "scripts/check-imports.ts",
  CONTAINER,
  "src/takoform-v2/host-acceptance.ts",
  "src/worker-endpoint-origin-v2-acceptance.ts",
];
const originals = new Map(
  await Promise.all(
    SOURCES.map(async (path) => [path, await readFile(join(ROOT, path), "utf8")] as const),
  ),
);
const containerSource = originals.get(CONTAINER);
if (!containerSource) throw new Error("missing fixed Container source");
const namedBlock = containerSource.match(
  /^import\s*\{[^}]*\}\s*from\s*["']\.\/host-acceptance\.ts["'];/mu,
)?.[0];
if (!namedBlock) throw new Error("missing fixed Container acceptance import");
const mintName = namedBlock.match(/\{\s*(\w+)/u)?.[1];
if (!mintName) throw new Error("missing fixed compiler mint name");

function importNamed(names: string, specifier: string): string {
  return `import { ${names} } from ${JSON.stringify(specifier)};\n`;
}

async function probe(change?: (files: Map<string, string>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "container-import-boundary-"));
  try {
    const files = new Map(originals);
    change?.(files);
    await mkdir(join(directory, "tests"));
    await writeFile(join(directory, "package.json"), "{}\n");
    for (const [path, source] of files) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), source);
    }
    const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/check-imports.ts"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the fixed Container and Endpoint compilers pass the actual import checker", async () => {
  const result = await probe();
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
});

for (const path of ["src/auth.ts", "scripts/rogue-acceptance.ts", "tests/rogue-acceptance.ts"]) {
  test(`another mint caller remains forbidden in ${path}`, async () => {
    const result = await probe((files) => {
      const specifier = path.startsWith("src/")
        ? "./takoform-v2/host-acceptance.ts"
        : "../src/takoform-v2/host-acceptance.ts";
      files.set(path, importNamed(mintName, specifier));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${path}: prepared Host acceptance mint belongs only`);
  });
}

const alternateImports = {
  namespace: `import * as acceptance from ${JSON.stringify("./host-acceptance.ts")};`,
  dynamic: `const acceptance = await import(${JSON.stringify("./host-acceptance.ts")});`,
  reexport: namedBlock.replace(/^import/u, "export"),
  alias: namedBlock.replace(mintName, `${mintName} as otherMint`),
  additional: namedBlock.replace(
    `${mintName},`,
    `${mintName},\n  type V2HostAcceptance as ExtraAcceptance,`,
  ),
};
for (const [kind, replacement] of Object.entries(alternateImports)) {
  test(`Container cannot widen its fixed acceptance edge with ${kind}`, async () => {
    const result = await probe((files) => {
      files.set(CONTAINER, containerSource.replace(namedBlock, replacement));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `${CONTAINER} (v2-container-owner-schema) imports src/takoform-v2/host-acceptance.ts`,
    );
  });
}

test("a near-matching compiler path is still unclassified and cannot mint", async () => {
  const path = "src/takoform-v2/container-owner-schema-extra.ts";
  const result = await probe((files) => files.set(path, namedBlock));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`${path} matches no declared layer`);
  expect(result.stderr).toContain(`${path}: prepared Host acceptance mint belongs only`);
});

for (const specifier of ["../auth.ts", "../sql-d1.ts", "../workerd-linux-process.ts"]) {
  test(`Container cannot add the non-core dependency ${specifier}`, async () => {
    const result = await probe((files) => {
      files.set(CONTAINER, containerSource + importNamed("", specifier));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("v2-container-owner-schema may import only core");
  });
}
