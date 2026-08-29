import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the standalone Bun entry uses the generated corpus only as current candidates", async () => {
  const source = await Bun.file(new URL("../src/entry-bun.ts", import.meta.url)).text();

  expect(source).toContain(
    'import { currentTakoformCandidates } from "./takoform/current-candidates.ts";',
  );
  expect(source).toContain("const currentCandidates = currentTakoformCandidates();");
  expect(source).not.toContain("stableProductionTakoformCatalog");
  expect(source).not.toContain("currentTakoformCatalog(edge)");
  expect(source).toContain('from "./standalone-provider-composition.ts";');
  expect(source).toContain("createStandaloneProviderComposition");
  expect(source).toContain("resolveStandaloneProviderMode");
  expect(source).toContain("const providerMode = resolveStandaloneProviderMode({");
  expect(source).toContain(
    "provisionerCredentialConfigured: Boolean(process.env.TAKOSERVER_PROVISIONER_TOKEN?.trim()),",
  );
  expect(source).toContain("const providerComposition = createStandaloneProviderComposition({");
  expect(source.indexOf("const providerMode = resolveStandaloneProviderMode({")).toBeLessThan(
    source.indexOf('if (databasePath !== ":memory:")'),
  );
  expect(source).not.toContain("if (process.env.CLOUDFLARE_ACCOUNT_ID) {");
  expect(source).not.toContain("edgeForms: process.env.TAKOSERVER_EDGE_FORMS");
  expect(source).not.toContain("JSON.parse(process.env.TAKOSERVER_ZONES");
  expect(source).toContain("stableForms: currentCandidates.forms,");
  expect(source).toContain("forms: currentCandidates.forms,");
  expect(source).toContain("bindings: currentCandidates.bindings,");
  expect(source).toContain("hostForms: currentCandidates.forms,");
  expect(source).toContain("hostBindings: currentCandidates.bindings,");
});

test("the Bun entry rejects shared D1 before opening local state", async () => {
  const dataRoot = join(tmpdir(), `takoserver-shared-d1-${crypto.randomUUID()}`);
  const child = Bun.spawn([process.execPath, "src/entry-bun.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TAKOSERVER_D1_DATABASE_ID: "shared-database",
      TAKOSERVER_DATA_ROOT: dataRoot,
      TAKOSERVER_DB: join(dataRoot, "control.sqlite"),
    },
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    expect(exitCode).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("TAKOSERVER_D1_DATABASE_ID");
    expect(existsSync(dataRoot)).toBe(false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("the Bun entry has no shared-D1 or dead signing-key branches", async () => {
  const source = await Bun.file(new URL("../src/entry-bun.ts", import.meta.url)).text();

  expect(source).not.toContain("createD1HttpSql");
  expect(source).not.toContain("loadSigningKey");
  expect(source).not.toContain("sharedDatabaseId");
  expect(source).toContain("TAKOSERVER_D1_DATABASE_ID");
  expect(source).toContain("return createSqliteSql(database);");
  expect(source.indexOf("TAKOSERVER_D1_DATABASE_ID")).toBeLessThan(
    source.indexOf("const dataRoot"),
  );
});
