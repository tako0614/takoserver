import { expect, test } from "bun:test";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteralLike,
  type Node,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from "typescript";
import { createEphemeralSql } from "../src/compat.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { bytesDigest, canonicalDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createFormPackageStore, packageManifest } from "../src/takoform/form-packages.ts";
import { createTakoformHost } from "../src/takoform/host.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";

/**
 * W17 characterization: the current production Host is still assembled from
 * explicit static Form inputs. These tests name the seam a future admission
 * projection must replace; they do not make a released beta identity current.
 */

async function source(path: string): Promise<string> {
  return await Bun.file(new URL(`../${path}`, import.meta.url)).text();
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function importedSpecifiers(path: string, text: string): readonly string[] {
  const parsed = createSourceFile(path, text, ScriptTarget.Latest, true, ScriptKind.TS);
  const specifiers = new Set<string>();
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      node.arguments[0] &&
      isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    forEachChild(node, visit);
  };
  visit(parsed);
  return [...specifiers];
}

async function resolveLocalModule(
  importer: string,
  specifier: string,
): Promise<string | undefined> {
  if (!specifier.startsWith(".")) return undefined;
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = extname(unresolved)
    ? [unresolved]
    : [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, resolve(unresolved, "index.ts")];
  for (const candidate of candidates) {
    const fromRoot = relative(repositoryRoot, candidate);
    if (fromRoot.startsWith("..") || fromRoot.startsWith("/")) continue;
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

async function reachableModules(entrypoints: readonly string[]): Promise<ReadonlySet<string>> {
  const pending = entrypoints.map((path) => resolve(repositoryRoot, path));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const text = await Bun.file(current).text();
    for (const specifier of importedSpecifiers(current, text)) {
      const dependency = await resolveLocalModule(current, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return new Set([...visited].map((path) => relative(repositoryRoot, path)));
}

test("current executable and discovery Forms use source-pinned and retained catalogs", async () => {
  const [appSource, bunEntrySource, workerEntrySource, edge] = await Promise.all([
    source("src/app.ts"),
    source("src/entry-bun.ts"),
    source("src/entry-worker.ts"),
    buildEdgeForms(),
  ]);
  const stable = stableProductionTakoformCatalog();

  expect(appSource).toMatch(/readonly\s+forms\s*:\s*readonly\s+InstalledTakoformForm\[\]/u);
  expect(appSource).toMatch(/readonly\s+hostForms\s*:\s*readonly\s+InstalledTakoformForm\[\]/u);
  expect(appSource).toMatch(/forms\s*:\s*ports\.hostForms\b/u);
  expect(appSource).toMatch(/forms\s*:\s*ports\.forms\b/u);
  expect(bunEntrySource).toMatch(
    /const\s+currentHost\s*=\s*stableProductionTakoformCatalog\s*\(\s*\)/u,
  );
  expect(bunEntrySource).toMatch(/stableForms\s*:\s*currentHost\.forms\b/u);
  expect(bunEntrySource).toMatch(/forms\s*:\s*currentHost\.forms\b/u);
  expect(bunEntrySource).toMatch(/hostForms\s*:\s*currentHost\.forms\b/u);
  expect(workerEntrySource).toMatch(
    /const\s+currentHost\s*=\s*stableProductionTakoformCatalog\s*\(\s*\)/u,
  );
  expect(workerEntrySource).toMatch(/forms\s*:\s*currentHost\.forms\b/u);
  expect(workerEntrySource).toMatch(/retainedForms\s*:\s*edge\.forms\b/u);
  expect(workerEntrySource).toMatch(/hostForms\s*:\s*currentHost\.forms\b/u);

  // The vendored provider release is retained historical supply. Its beta
  // identity is observable there, but the current stable Host catalog is a
  // separate exact source-pinned set.
  expect(edge.forms.some((form) => form.identity.formRef.apiVersion.endsWith("/v1beta1"))).toBe(
    true,
  );
  expect(edge.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(true);
  expect(stable.forms.every((form) => form.requiresHostApi === "forms.takoform.com/v1")).toBe(true);
  expect(stable.forms.some((form) => form.identity.formRef.apiVersion.endsWith("/v1beta1"))).toBe(
    false,
  );
  expect(stable.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(false);
});

test("private admission and package stores remain outside public runtime graphs", async () => {
  const reachable = await reachableModules([
    "src/entry-bun.ts",
    "src/entry-worker.ts",
    "src/index.ts",
  ]);
  expect(reachable.has("src/takoform/admission-store.ts")).toBe(false);
  expect(reachable.has("src/takoform/form-packages.ts")).toBe(false);
});

test("writing a Form Package does not create executable support or activation", async () => {
  const formRef = {
    apiVersion: "example.forms.example.com",
    kind: "Example",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const bytes = new TextEncoder().encode('{"kind":"Example"}');
  const fileDigest = await bytesDigest(bytes);
  const manifest = packageManifest({
    formRef,
    files: [{ path: "definition.json", digest: fileDigest, size: bytes.byteLength }],
  });
  const packageDigest = await canonicalDigest(manifest);
  const objects = createMemoryObjectStore();
  const packages = createFormPackageStore(objects);

  const stored = await packages.put({
    packageDigest,
    formRef,
    files: [{ path: "definition.json", bytes }],
  });
  expect(stored.packageDigest).toBe(packageDigest);
  expect(await packages.read({ packageDigest, formRef })).not.toBeNull();

  const host = createTakoformHost({
    sql: createEphemeralSql(),
    objects,
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [],
    driver: new InMemoryTakoformResourceDriver(),
  });
  const headers = { authorization: "Bearer characterization" };
  const listed = await host.handle(
    new Request("https://host.invalid/apis/forms.takoform.com/v1/forms?space=main", { headers }),
  );
  expect(listed?.status).toBe(200);
  expect(await listed?.json()).toEqual({ forms: [] });

  const supported = await host.handle(
    new Request("https://host.invalid/apis/forms.takoform.com/v1/support/forms", { headers }),
  );
  expect(supported?.status).toBe(200);
  expect(await supported?.json()).toEqual({ profiles: [] });
});
