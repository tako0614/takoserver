import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const POLICY = "src/takoform-v2/retained-execution.ts";
const ENTRY = "src/entry-worker.ts";
const SOURCES = [
  "scripts/check-imports.ts",
  POLICY,
  ENTRY,
  "src/takoform-v2/application.ts",
  "src/takoform-v2/engine.ts",
];
const originals = new Map(
  await Promise.all(
    SOURCES.map(async (path) => [path, await readFile(join(ROOT, path), "utf8")] as const),
  ),
);

async function probe(change?: (files: Map<string, string>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "retained-import-boundary-"));
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

test("actual retained execution callers pass the import checker without widening entry contracts", async () => {
  const result = await probe();
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
});

test("Worker entry still cannot import the general v2 contract directly", async () => {
  const result = await probe((files) => {
    files.set(
      ENTRY,
      `${files.get(ENTRY)}\nimport type { V2Action } from "./takoform-v2/types.ts";\n`,
    );
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    `${ENTRY} (entry) imports src/takoform-v2/types.ts (v2-contract)`,
  );
});

test("retained execution policy cannot acquire a native SQL adapter", async () => {
  const result = await probe((files) => {
    files.set(POLICY, `${files.get(POLICY)}\nimport { createD1Sql } from "../sql-d1.ts";\n`);
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    `${POLICY} (v2-retained-execution) imports src/sql-d1.ts (adapter)`,
  );
});

test("a Form cannot select its own retained execution policy", async () => {
  const path = "src/takoform-v2/forms/retained-selection.ts";
  const result = await probe((files) => {
    files.set(
      path,
      'import { captureV2RetainedExecutionActions } from "../retained-execution.ts";\n',
    );
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`${path} (v2-form) imports ${POLICY} (v2-retained-execution)`);
});

test("a neighboring retained execution module stays unclassified", async () => {
  const path = "src/takoform-v2/retained-execution-extra.ts";
  const result = await probe((files) => files.set(path, "export {};\n"));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`${path} matches no declared layer`);
});

test("another entry cannot acquire the Worker entry's retained policy edge", async () => {
  const path = "src/entry-other.ts";
  const result = await probe((files) => {
    files.set(
      path,
      'import { captureV2RetainedExecutionActions } from "./takoform-v2/retained-execution.ts";\n',
    );
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`${path} (entry) imports ${POLICY} (v2-retained-execution)`);
});
