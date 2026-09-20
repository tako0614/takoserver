import { expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import {
  type ApplyInput,
  type Provider,
  type ProviderOffering,
  succeeded,
} from "../src/provider-port.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import { applyWithSelection } from "./helpers/apply-with-selection.ts";

const service = {
  apiVersion: "standards.takoform.com/v1",
  protocol: "org.example.service",
} as const;
const slot = { name: "EXTERNAL", required: true, service };
const formRef = {
  apiVersion: "example.forms.invalid",
  kind: "HandoffProbe",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;
const form: InstalledTakoformForm = {
  identity: { formRef },
  role: "revision",
  operations: ["create", "delete"],
  desiredSchema: {
    type: "object",
    properties: {
      externalServices: {
        type: "array",
        "x-takoform-standard-services": service.apiVersion,
        items: {
          type: "object",
          properties: {
            service: {
              type: "object",
              properties: {
                apiVersion: { const: service.apiVersion },
                protocol: {
                  type: "string",
                  maxLength: 253,
                  pattern:
                    "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$",
                },
              },
            },
          },
        },
      },
    },
  },
};

function fixture(supported: boolean) {
  const technical: ProviderOffering = {
    id: "handoff",
    kind: "handoff",
    displayName: "Handoff",
    form: formRef,
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "delete", "observe"],
  };
  const sold: Offering = {
    ...technical,
    providerPackRef: "probe",
    providerInstallationRef: "probe.primary",
    supplyContractRef: "probe.supply",
    pricePlanRef: "probe.price",
    resourceClass: "probe",
    deliveryMode: "managed-endpoint",
    supportPolicyRef: "probe.support",
    abusePolicyRef: "probe.abuse",
    pricePlan: {
      id: "probe.price",
      currency: "USD",
      provisioning: { meter: "probe.create", amountMinor: 0 },
      meters: [],
    },
    regions: [],
    portability: { api: "portable", exportFormats: [], importFormats: [], migrationModes: [] },
    isolation: "dedicated-resource",
    available: true,
  };
  const calls: ApplyInput[] = [];
  const result = (input: ApplyInput) => {
    calls.push(input);
    return succeeded({ nativeId: "native:probe", observed: input.spec, outputs: {} });
  };
  const provider: Provider = {
    id: "probe",
    offerings: [technical],
    ...(supported ? { standardServiceProtocols: [service] } : {}),
    async apply(input) {
      return result(input);
    },
    async convergeApply(input) {
      return result(input);
    },
    async observe() {
      return succeeded({ nativeId: "native:probe", observed: {}, outputs: {} });
    },
    async delete() {
      return succeeded({ nativeId: "native:probe", observed: {}, outputs: {} });
    },
  };
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-09-11T00:00:00.000Z");
  const deployments = createResourceDeploymentStore(sql, clock);
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog([sold]),
    ledger: createLedger(sql, clock),
    deployments,
  });
  const input = {
    operationId: "handoff-op",
    operationKey: "handoff-key",
    operationMode: "initial" as const,
    tenantId: "tenant-a",
    resourceUid: "uid-handoff",
    executionAuthority: {
      tenantId: "tenant-a",
      resourceUid: "uid-handoff",
      leaseToken: "lease-handoff",
      fingerprint: `sha256:${"b".repeat(64)}`,
    },
    name: "probe",
    space: "main",
    form,
    spec: { externalServices: [slot] },
    relations: [],
    standardServices: [
      {
        ...slot,
        endpoint: { url: "https://service.invalid" },
        credential: { token: "fixture-only-secret" },
      },
    ],
  };
  return { driver, input, deployments, calls, provider };
}

test("standard service handoff reaches only initial provider input, never deployment state", async () => {
  const { driver, input, deployments, calls, provider } = fixture(true);
  await applyWithSelection(driver, input);
  expect(calls[0]?.standardServices).toEqual(input.standardServices);
  expect(calls[0]?.standardServices).not.toBe(input.standardServices);
  expect(JSON.stringify(await deployments.active(input.tenantId, input.resourceUid))).not.toContain(
    "fixture-only-secret",
  );
  // A removed integration cannot stop recovery of material retained by the provider.
  Object.assign(provider, { standardServiceProtocols: [] });
  const { standardServices: _material, ...recovery } = input;
  await applyWithSelection(driver, { ...recovery, operationMode: "recovery" });
  expect(calls[1]?.standardServices).toBeUndefined();
});

test("a provider without an exact integration cannot silently discard required material", async () => {
  const { driver, input, calls, deployments } = fixture(false);
  await expect(applyWithSelection(driver, input)).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  expect(calls).toHaveLength(0);
  expect(await deployments.active(input.tenantId, input.resourceUid)).toBeNull();
});

test("optional unsupported slots do not forward credential material", async () => {
  const { driver, input, calls } = fixture(false);
  const optional = { ...slot, required: false };
  await applyWithSelection(driver, {
    ...input,
    spec: { externalServices: [optional] },
    standardServices: [
      {
        ...optional,
        endpoint: { url: "https://service.invalid" },
        credential: { token: "fixture-only-secret" },
      },
    ],
  });
  expect(calls[0]?.standardServices).toBeUndefined();
});

test("untagged legacy calls cannot silently discard supplied standard services", async () => {
  const { driver, input, calls } = fixture(true);
  const { operationMode: _mode, ...untagged } = input;
  await expect(applyWithSelection(driver, untagged)).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  expect(calls).toHaveLength(0);
});
