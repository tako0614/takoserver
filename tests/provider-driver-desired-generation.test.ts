import { expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import { type Provider, type ProviderOffering, succeeded } from "../src/provider-port.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";

const formRef = {
  apiVersion: "example.forms.invalid",
  kind: "GenerationProbe",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const form: InstalledTakoformForm = {
  identity: { formRef },
  role: "deployment",
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "update", "delete"],
};

const technicalOffering: ProviderOffering = {
  id: "generation-probe",
  kind: "generation_probe",
  displayName: "Generation probe",
  form: formRef,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "observe"],
};

const soldOffering: Offering = {
  id: technicalOffering.id,
  providerPackRef: "generation-probe-provider",
  providerInstallationRef: "generation-probe-provider.primary",
  supplyContractRef: "generation-probe.supply",
  pricePlanRef: "generation-probe.price",
  resourceClass: "generation-probe",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "generation-probe.support",
  abusePolicyRef: "generation-probe.abuse",
  kind: technicalOffering.kind,
  displayName: technicalOffering.displayName,
  form: formRef,
  pricePlan: {
    id: "generation-probe.price",
    currency: "USD",
    provisioning: { meter: "generation-probe.create", amountMinor: 0 },
    meters: [],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: [],
  portability: {
    api: "portable",
    exportFormats: [],
    importFormats: [],
    migrationModes: [],
  },
  isolation: "dedicated-resource",
  available: true,
};

test("provider driver forwards desiredGeneration to apply and convergence, omitting it when absent", async () => {
  const sql = createEphemeralSql();
  const deployments = createResourceDeploymentStore(
    sql,
    () => new Date("2026-09-01T00:00:00.000Z"),
  );
  const calls: Array<{
    readonly method: "apply" | "convergeApply";
    readonly input: Parameters<Provider["apply"]>[0];
  }> = [];
  const result = (input: Parameters<Provider["apply"]>[0]) =>
    succeeded({ nativeId: `native:${input.identity.uid}`, observed: input.spec, outputs: {} });
  const provider: Provider = {
    id: soldOffering.providerPackRef,
    offerings: [technicalOffering],
    async apply(input) {
      calls.push({ method: "apply", input: structuredClone(input) });
      return result(input);
    },
    async convergeApply(input) {
      calls.push({ method: "convergeApply", input: structuredClone(input) });
      return result(input);
    },
    async observe(input) {
      return result({
        operationId: "observe",
        offering: input.offering,
        identity: input.identity,
        spec: input.spec,
      });
    },
    async delete(input) {
      return result({
        operationId: input.operationId,
        offering: input.offering,
        identity: input.identity,
        spec: input.spec ?? {},
      });
    },
  };
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog([soldOffering]),
    ledger: createLedger(sql, () => new Date("2026-09-01T00:00:00.000Z")),
    deployments,
  });
  const baseInput = {
    operationId: "generation-driver-0001",
    operationKey: "generation-driver-key-0001",
    operationMode: "initial" as const,
    tenantId: "tenant-a",
    resourceUid: "uid-generation-driver",
    executionAuthority: {
      tenantId: "tenant-a",
      resourceUid: "uid-generation-driver",
      leaseToken: "lease-generation-driver",
      fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    form,
    name: "probe",
    space: "main",
    spec: { value: "first" },
    relations: [],
  };

  await driver.apply({ ...baseInput, desiredGeneration: "9223372036854775807" });
  await driver.apply({
    ...baseInput,
    operationMode: "recovery",
    desiredGeneration: "9223372036854775807",
  });
  await driver.apply({
    ...baseInput,
    operationId: "generation-driver-0002",
    operationKey: "generation-driver-key-0002",
    resourceUid: "uid-generation-driver-2",
    executionAuthority: {
      ...baseInput.executionAuthority,
      resourceUid: "uid-generation-driver-2",
      leaseToken: "lease-generation-driver-2",
    },
  });

  expect(calls.map(({ method }) => method)).toEqual(["apply", "convergeApply", "apply"]);
  expect(calls[0]?.input.desiredGeneration).toBe("9223372036854775807");
  expect(calls[1]?.input.desiredGeneration).toBe("9223372036854775807");
  expect(calls[2]?.input.desiredGeneration).toBeUndefined();
  expect(Object.hasOwn(calls[1]?.input ?? {}, "desiredGeneration")).toBe(true);
  expect(Object.hasOwn(calls[2]?.input ?? {}, "desiredGeneration")).toBe(false);
});
