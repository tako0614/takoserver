import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as integrationHost from "@takoserver/core/takoform-integration-actor-host";
import { createAccounts, grants } from "../src/auth.ts";
import { createCatalog } from "../src/catalog.ts";
import { createProvisioningProviderPack } from "../src/deployment-composition.ts";
import { createLedger } from "../src/ledger.ts";
import { createProviderDriver, createProviderFormAvailability } from "../src/provider-driver.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { createTakoformHost } from "../src/takoform/host.ts";
import { createTakoformHostAuthority } from "../src/takoform/host-authority.ts";

test("integration Host subpath exposes only the selected composition constructors", () => {
  expect(Object.keys(integrationHost).sort()).toEqual([
    "createAccounts",
    "createCatalog",
    "createLedger",
    "createProviderDriver",
    "createProviderFormAvailability",
    "createProvisioningProviderPack",
    "createResourceDeploymentStore",
    "createTakoformHost",
    "createTakoformHostAuthority",
    "grants",
  ]);
  expect(integrationHost.createAccounts).toBe(createAccounts);
  expect(integrationHost.grants).toBe(grants);
  expect(integrationHost.createCatalog).toBe(createCatalog);
  expect(integrationHost.createLedger).toBe(createLedger);
  expect(integrationHost.createProviderDriver).toBe(createProviderDriver);
  expect(integrationHost.createProviderFormAvailability).toBe(createProviderFormAvailability);
  expect(integrationHost.createProvisioningProviderPack).toBe(createProvisioningProviderPack);
  expect(integrationHost.createResourceDeploymentStore).toBe(createResourceDeploymentStore);
  expect(integrationHost.createTakoformHost).toBe(createTakoformHost);
  expect(integrationHost.createTakoformHostAuthority).toBe(createTakoformHostAuthority);
});

test("integration Host subpath bundles for Workers without host runtime imports", async () => {
  const result = await Bun.build({
    entrypoints: [
      fileURLToPath(import.meta.resolve("@takoserver/core/takoform-integration-actor-host")),
    ],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    plugins: [
      {
        name: "reject-host-runtime-imports",
        setup(build) {
          build.onResolve({ filter: /^(?:bun|node):/u }, (args) => {
            throw new Error(`Integration Host reaches host-only import: ${args.path}`);
          });
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  expect(result.outputs).toHaveLength(1);
  const artifact = result.outputs[0];
  if (!artifact) throw new Error("missing integration Host artifact");
  const source = await artifact.text();
  expect(new Bun.Transpiler({ loader: "js" }).scanImports(source)).toEqual([]);
  expect(source).not.toMatch(/\bBun\./u);
});
