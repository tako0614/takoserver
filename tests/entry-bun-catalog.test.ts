import { expect, test } from "bun:test";

test("the standalone Bun entry installs the exact staging adoption Form catalog", async () => {
  const source = await Bun.file(new URL("../src/entry-bun.ts", import.meta.url)).text();

  expect(source).toContain(
    'import { stableProductionTakoformCatalog } from "./takoform/stable-production-catalog.ts";',
  );
  expect(source).toContain("const currentHost = stableProductionTakoformCatalog();");
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
  expect(source).toContain("stableForms: currentHost.forms,");
  expect(source).toContain("forms: currentHost.forms,");
  expect(source).toContain("bindings: currentHost.bindings,");
  expect(source).toContain("hostForms: currentHost.forms,");
  expect(source).toContain("hostBindings: currentHost.bindings,");
});
