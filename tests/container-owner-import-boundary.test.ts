import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CONTAINER = "src/takoform-v2/container-owner-schema.ts";
const BARREL = "src/takoform-v2/index.ts";
const SOURCES = [
  "scripts/check-imports.ts",
  CONTAINER,
  BARREL,
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

for (const path of [
  "tests/takoform-v2-host-delete-acceptance.test.ts",
  "tests/v2-container-endpoint-app-composition.test.ts",
]) {
  test(`the exact white-box boundary test may construct a witness in ${path}`, async () => {
    const result = await probe((files) => {
      files.set(path, importNamed(mintName, "../src/takoform-v2/host-acceptance.ts"));
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
}

for (const path of [
  "tests/takoform-v2-host-delete-acceptance-copy.test.ts",
  "tests/v2-container-endpoint-app-composition-copy.test.ts",
]) {
  test(`a neighboring test does not inherit witness construction in ${path}`, async () => {
    const result = await probe((files) => {
      files.set(path, importNamed(mintName, "../src/takoform-v2/host-acceptance.ts"));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${path}: prepared Host acceptance mint belongs only`);
  });
}

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

const compositionImports = [
  {
    path: "src/app.ts",
    layer: "app",
    names:
      "V2HostAcceptance, V2HostAcceptanceContext, V2HostAcceptanceScope, V2HostDeleteAcceptanceContext",
  },
  { path: "src/entry-worker.ts", layer: "entry", names: "V2HostAcceptance" },
] as const;
const compositionSpecifier = "./takoform-v2/host-acceptance.ts";
function importTypes(names: string): string {
  return `import type { ${names} } from ${JSON.stringify(compositionSpecifier)};\n`;
}

for (const { path, layer, names } of compositionImports) {
  test(`${path} may carry only its exact Host acceptance type set`, async () => {
    const result = await probe((files) => files.set(path, importTypes(names)));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  const forbiddenCompositionImports = {
    runtime: importNamed(names, compositionSpecifier),
    extraType: importTypes(`${names}, V2PreparedHostAcceptance`),
    mint: importNamed(`${mintName}, ${names}`, compositionSpecifier),
    alias: importTypes(names.replace("V2HostAcceptance", "V2HostAcceptance as OtherAcceptance")),
    namespace: `import type * as acceptance from ${JSON.stringify(compositionSpecifier)};`,
    dynamic: `const acceptance = await import(${JSON.stringify(compositionSpecifier)});`,
    reexport: importTypes(names).replace(/^import/u, "export"),
    secondEdge: importTypes(names) + importTypes("V2HostAcceptance"),
  };
  for (const [kind, source] of Object.entries(forbiddenCompositionImports)) {
    test(`${path} cannot widen its Host acceptance type edge with ${kind}`, async () => {
      const result = await probe((files) => files.set(path, source));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `${path} (${layer}) imports src/takoform-v2/host-acceptance.ts`,
      );
    });
  }
}

for (const path of ["src/worker-request-composition.ts", "src/entry-cloudflare-worker.ts"]) {
  test(`another composition root ${path} gains no Host acceptance type edge`, async () => {
    const result = await probe((files) => files.set(path, importTypes("V2HostAcceptance")));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `imports src/takoform-v2/host-acceptance.ts (v2-host-acceptance-contract)`,
    );
  });
}

const compilerNames = `${mintName}, type V2HostAcceptance, type V2HostAcceptanceContext`;
for (const [label, names] of [
  ["original three symbols", compilerNames],
  ["one additional DELETE context type", `${compilerNames}, type V2HostDeleteAcceptanceContext`],
] as const) {
  test(`the fixed Container compiler permits ${label}`, async () => {
    const result = await probe((files) =>
      files.set(
        CONTAINER,
        containerSource.replace(namedBlock, importNamed(names, "./host-acceptance.ts")),
      ),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
}

for (const [label, added] of [
  ["runtime DELETE context", "V2HostDeleteAcceptanceContext"],
  ["aliased DELETE context", "type V2HostDeleteAcceptanceContext as OtherContext"],
  ["another context type", "type V2HostAcceptanceScope"],
] as const) {
  test(`the fixed Container compiler still rejects ${label}`, async () => {
    const result = await probe((files) =>
      files.set(
        CONTAINER,
        containerSource.replace(
          namedBlock,
          importNamed(`${compilerNames}, ${added}`, "./host-acceptance.ts"),
        ),
      ),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `${CONTAINER} (v2-container-owner-schema) imports src/takoform-v2/host-acceptance.ts`,
    );
  });
}

const containerFactoryExport =
  'export { createV2ContainerHostAcceptance } from "./container-owner-schema.ts";';
const barrelSource = originals.get(BARREL);
if (!barrelSource || barrelSource.split(containerFactoryExport).length !== 2)
  throw new Error("missing unique fixed Container factory barrel export");

test("the v2 barrel permits the exact direct named Container factory reexport", async () => {
  const result = await probe((files) => files.set(BARREL, `${containerFactoryExport}\n`));
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
});

const forbiddenContainerFactoryExports = {
  star: 'export * from "./container-owner-schema.ts";',
  namespace: 'export * as containerOwner from "./container-owner-schema.ts";',
  alias:
    'export { createV2ContainerHostAcceptance as otherFactory } from "./container-owner-schema.ts";',
  additionalRecipe:
    'export { createV2ContainerHostAcceptance, V2_CONTAINER_OWNER_RECIPE } from "./container-owner-schema.ts";',
  additionalReadiness:
    'export { createV2ContainerHostAcceptance, inspectV2ContainerOwnerSchema } from "./container-owner-schema.ts";',
  recipeOnly: 'export { V2_CONTAINER_OWNER_RECIPE } from "./container-owner-schema.ts";',
  readinessOnly: 'export { inspectV2ContainerOwnerSchema } from "./container-owner-schema.ts";',
  importThenExport:
    'import { createV2ContainerHostAcceptance } from "./container-owner-schema.ts";\nexport { createV2ContainerHostAcceptance };',
  runtimeImport: 'import { createV2ContainerHostAcceptance } from "./container-owner-schema.ts";',
  dynamic:
    'const owner = await import("./container-owner-schema.ts");\nexport const createV2ContainerHostAcceptance = owner.createV2ContainerHostAcceptance;',
  duplicate: `${containerFactoryExport}\n${containerFactoryExport}`,
  exportAndImport: `${containerFactoryExport}\nimport { createV2ContainerHostAcceptance } from "./container-owner-schema.ts";`,
  alternateSpecifier:
    'export { createV2ContainerHostAcceptance } from "././container-owner-schema.ts";',
};
for (const [kind, replacement] of Object.entries(forbiddenContainerFactoryExports)) {
  test(`the v2 barrel cannot widen the Container factory edge with ${kind}`, async () => {
    const result = await probe((files) => {
      files.set(BARREL, barrelSource.replace(containerFactoryExport, replacement));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${BARREL} (v2-extension) imports ${CONTAINER}`);
  });
}

for (const path of ["src/index.ts", "src/provider-extension.ts", "src/takoform-v2/host.ts"]) {
  test(`the Container factory publication edge does not authorize neighboring caller ${path}`, async () => {
    const specifier = path.startsWith("src/takoform-v2/")
      ? "./container-owner-schema.ts"
      : "./takoform-v2/container-owner-schema.ts";
    const result = await probe((files) => {
      files.set(
        path,
        `export { createV2ContainerHostAcceptance } from ${JSON.stringify(specifier)};\n`,
      );
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${path} (`);
    expect(result.stderr).toContain(`imports ${CONTAINER} (v2-container-owner-schema)`);
  });
}
