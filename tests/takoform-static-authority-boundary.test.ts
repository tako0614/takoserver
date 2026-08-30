import { expect, mock, test } from "bun:test";
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
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { createFormPackageStore, packageManifest } from "../src/takoform/form-packages.ts";
import { createTakoformHost } from "../src/takoform/host.ts";
import { createTakoformHostAuthority } from "../src/takoform/host-authority.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";

// The entry modules target the Workers runtime's built-in module. Mock only
// that constructor so the default registration handlers can be exercised in
// Bun without changing their production bundle or RPC class shape.
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class WorkerEntrypoint {} }));

type RegistrationHandler = {
  readonly fetch: (request: Request) => Response | Promise<Response>;
};

type AuthorityModule = {
  readonly default: RegistrationHandler;
  readonly [exportName: string]: unknown;
};

async function loadAuthorityModule(specifier: string): Promise<AuthorityModule> {
  return (await import(specifier)) as unknown as AuthorityModule;
}

/**
 * W17 characterization: the current production Host is still assembled from
 * explicit static Form inputs. These tests name the seam a future admission
 * projection must replace; they do not make a released beta identity current.
 */

async function source(path: string): Promise<string> {
  return await Bun.file(new URL(`../${path}`, import.meta.url)).text();
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("Form authority source contains no fictional Core admission seam", async () => {
  const retired = [
    ["Evaluate", "Admission"].join(""),
    ["Core", "AdmissionAdapter"].join(""),
    ["released", "core", "unavailable"].join("-"),
  ];
  const retained: string[] = [];
  for (const pattern of ["src/**/*.ts", "scripts/**/*.ts", "docs/**/*.md"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: repositoryRoot })) {
      const text = await Bun.file(resolve(repositoryRoot, path)).text();
      for (const name of retired) {
        if (text.includes(name)) retained.push(`${path}: ${name}`);
      }
    }
  }
  for (const retiredPath of [
    "src/takoform/core-admission-adapter.ts",
    "src/takoform/operator-authority.ts",
    "src/takoform/operator-endpoint.ts",
  ]) {
    expect(await Bun.file(resolve(repositoryRoot, retiredPath)).exists()).toBe(false);
  }
  expect(retained).toEqual([]);
});

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

test("the generated 16-Form corpus is candidate input, never runtime admission", async () => {
  const [appSource, bunEntrySource, workerEntrySource, edge] = await Promise.all([
    source("src/app.ts"),
    source("src/entry-bun.ts"),
    source("src/entry-worker.ts"),
    buildEdgeForms(),
  ]);
  const candidates = currentTakoformCandidates();

  expect(appSource).toMatch(/readonly\s+forms\s*:\s*readonly\s+InstalledTakoformForm\[\]/u);
  expect(appSource).toMatch(/readonly\s+hostForms\s*:\s*readonly\s+InstalledTakoformForm\[\]/u);
  expect(appSource).toMatch(/forms\s*:\s*ports\.hostForms\b/u);
  expect(appSource).toMatch(/forms\s*:\s*ports\.forms\b/u);
  expect(appSource).toContain("createTakoformHostAuthority");
  expect(appSource).toMatch(/candidates\s*:\s*ports\.hostForms\b/u);
  expect(bunEntrySource).toMatch(
    /const\s+currentCandidates\s*=\s*currentTakoformCandidates\s*\(\s*\)/u,
  );
  expect(bunEntrySource).toMatch(/stableForms\s*:\s*currentCandidates\.forms\b/u);
  expect(bunEntrySource).toMatch(/forms\s*:\s*currentCandidates\.forms\b/u);
  expect(bunEntrySource).toMatch(/hostForms\s*:\s*currentCandidates\.forms\b/u);
  expect(workerEntrySource).toMatch(
    /const\s+currentCandidates\s*=\s*currentTakoformCandidates\s*\(\s*\)/u,
  );
  expect(workerEntrySource).toMatch(/forms\s*:\s*currentCandidates\.forms\b/u);
  expect(workerEntrySource).toMatch(/retainedForms\s*:\s*edge\.forms\b/u);
  expect(workerEntrySource).toMatch(/hostForms\s*:\s*currentCandidates\.forms\b/u);
  expect(bunEntrySource).not.toContain("stableProductionTakoformCatalog");
  expect(workerEntrySource).not.toContain("stableProductionTakoformCatalog");
  expect(appSource).not.toContain("stableProductionTakoformCatalog");

  // The vendored provider release is retained historical supply. Its beta
  // identity is observable there, but the current stable Host catalog is a
  // separate exact source-pinned set.
  expect(edge.forms.some((form) => form.identity.formRef.apiVersion.endsWith("/v1beta1"))).toBe(
    true,
  );
  expect(edge.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(true);
  expect(candidates.forms).toHaveLength(16);
  expect(new Set(candidates.forms.map((form) => form.identity.formRef.kind)).size).toBe(16);
  expect(candidates.forms.every((form) => form.requiresHostApi === "forms.takoform.com/v1")).toBe(
    true,
  );
  expect(
    candidates.forms.some((form) => form.identity.formRef.apiVersion.endsWith("/v1beta1")),
  ).toBe(false);
  expect(candidates.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(
    false,
  );
});

test("public Worker, router, and OpenAPI graphs reach readers but never Form authority", async () => {
  const reachable = await reachableModules([
    "src/entry-bun.ts",
    "src/entry-cloudflare-worker.ts",
    "src/entry-worker.ts",
    "src/router.ts",
    "src/openapi.ts",
  ]);
  expect(reachable.has("src/takoform/host-authority.ts")).toBe(true);
  expect(reachable.has("src/takoform/form-package-reader.ts")).toBe(true);
  expect(reachable.has("src/takoform/current-candidates.ts")).toBe(true);
  expect(reachable.has("src/takoform/admission-store.ts")).toBe(false);
  expect(reachable.has("src/takoform/admission.ts")).toBe(false);
  expect(reachable.has("src/takoform/form-packages.ts")).toBe(false);
  expect(reachable.has("src/takoform/host-admission-coordinator.ts")).toBe(false);
  expect(reachable.has("src/takoform/host-admission-endpoint.ts")).toBe(false);
  expect(reachable.has("src/takoform/integration-operator-endpoint.ts")).toBe(false);
  expect(reachable.has("src/form-authority-operator-proof.ts")).toBe(false);
  expect(reachable.has("src/takoform/stable-production-catalog.ts")).toBe(false);
});

test("route-less Form authority Workers own the writer graph and no public routes", async () => {
  const [production, integration] = await Promise.all([
    reachableModules(["src/entry-form-authority-worker.ts"]),
    reachableModules(["src/entry-integration-form-authority-worker.ts"]),
  ]);
  for (const reachable of [production, integration]) {
    expect(reachable.has("src/takoform/admission-store.ts")).toBe(true);
    expect(reachable.has("src/takoform/admission.ts")).toBe(true);
    expect(reachable.has("src/takoform/form-packages.ts")).toBe(true);
    expect(reachable.has("src/app.ts")).toBe(false);
    expect(reachable.has("src/router.ts")).toBe(false);
    expect(reachable.has("src/openapi.ts")).toBe(false);
  }
  expect(production.has("src/takoform/integration-operator-endpoint.ts")).toBe(false);
  expect(production.has("src/form-authority-operator-proof.ts")).toBe(false);
  expect(production.has("src/generated/takoform-integration-form-packages.ts")).toBe(false);
  expect(integration.has("src/form-authority-operator-proof.ts")).toBe(true);
  expect(integration.has("src/generated/takoform-integration-form-packages.ts")).toBe(true);
});

test("route-less Form authority defaults return empty 404 while named RPC stays pure", async () => {
  const [production, integration] = await Promise.all([
    loadAuthorityModule("../src/entry-form-authority-worker.ts"),
    loadAuthorityModule("../src/entry-integration-form-authority-worker.ts"),
  ]);
  for (const [authority, entrypointName] of [
    [production, "FormAuthorityEntrypoint"],
    [integration, "IntegrationFormAuthorityEntrypoint"],
  ] as const) {
    const response = await authority.default.fetch(new Request("https://authority.invalid/"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    const prototype = (authority[entrypointName] as { readonly prototype: object }).prototype;
    expect(Reflect.has(prototype, "fetch")).toBe(false);
  }
});

test("authenticated operator gateway is isolated from both storage writers and customer routes", async () => {
  const reachable = await reachableModules([
    "src/entry-integration-form-authority-operator-worker.ts",
  ]);
  expect(reachable.has("src/integration-form-authority-gateway.ts")).toBe(true);
  expect(reachable.has("src/form-authority-operator-proof.ts")).toBe(true);
  expect(reachable.has("src/takoform/host-admission-coordinator.ts")).toBe(false);
  expect(reachable.has("src/takoform/admission-store.ts")).toBe(false);
  expect(reachable.has("src/takoform/admission.ts")).toBe(false);
  expect(reachable.has("src/takoform/form-packages.ts")).toBe(false);
  expect(reachable.has("src/app.ts")).toBe(false);
  expect(reachable.has("src/router.ts")).toBe(false);
  expect(reachable.has("src/openapi.ts")).toBe(false);
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

  const candidates = currentTakoformCandidates();
  const sql = createEphemeralSql();
  const host = createTakoformHost({
    sql,
    objects,
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: candidates.forms,
    bindings: candidates.bindings,
    authority: createTakoformHostAuthority({
      sql,
      objects,
      hostId: "https://host.invalid",
      candidates: candidates.forms,
      bindings: candidates.bindings,
      technicalAvailability: {
        async resolve() {
          return { executable: true, activated: true, availableToPrincipal: true };
        },
      },
    }),
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
