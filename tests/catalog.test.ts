import { describe, expect, test } from "bun:test";
import {
  createCatalog,
  type Offering,
  priceMeteredUsage,
  priceProvisioning,
} from "../src/catalog.ts";
import type { TakoformInterfaceRef } from "../src/takoform/types.ts";

const FORM = {
  apiVersion: "example.forms.test",
  kind: "ExampleWorker",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"1".repeat(64)}`,
} as const;

const FETCH: TakoformInterfaceRef = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "example.fetch",
  version: "1.0.0",
  schemaDigest: `sha256:${"2".repeat(64)}`,
};

function offering(id: string, providerPackRef: string): Offering {
  return {
    id,
    providerPackRef,
    providerInstallationRef: `${providerPackRef}.primary`,
    supplyContractRef: `${providerPackRef}.operator-2026`,
    pricePlanRef: `${id}.price-v1`,
    resourceClass: "compute.edge",
    deliveryMode: "embedded-binding",
    supportPolicyRef: "support:compute:oncall",
    abusePolicyRef: "abuse:compute:standard",
    kind: "worker",
    displayName: id,
    form: FORM,
    providedInterfaces: [FETCH],
    bindingRefs: [],
    pricePlan: {
      id: `${id}.price-v1`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 500 },
      meters: [
        { meter: "compute.millisecond", amountMinor: 1, quantity: 1 },
        { meter: "compute.requests", amountMinor: 30, quantity: 1_000_000 },
      ],
    },
    regions: ["global"],
    portability: {
      api: "portable",
      exportFormats: ["example.worker-bundle/v1"],
      importFormats: ["example.worker-bundle/v1"],
      migrationModes: ["offline", "online"],
    },
    isolation: "dedicated-resource",
    available: true,
  };
}

describe("Offering catalog", () => {
  test("keeps several operator placements for one exact Form", () => {
    const alpha = offering("compute.edge.alpha.global", "alpha");
    const beta = offering("compute.edge.beta.global", "beta");
    const catalog = createCatalog([alpha, beta]);

    expect(catalog.offeringsFor(FORM).map((entry) => entry.id)).toEqual([alpha.id, beta.id]);
    expect(catalog.findOffering(beta.id)).toEqual(beta);
  });

  test("does not silently choose an Offering from the Form", () => {
    const catalog = createCatalog([
      offering("compute.edge.alpha.global", "alpha"),
      offering("compute.edge.beta.global", "beta"),
    ]);

    expect("forForm" in catalog).toBe(false);
  });

  test("prices provisioning once and keeps aggregated usage below one cent precise", () => {
    const plan = offering("compute.edge.alpha.global", "alpha").pricePlan;

    expect(priceProvisioning(plan, 2)).toBe(1_000);
    expect(
      priceMeteredUsage(plan, [
        { meter: "compute.millisecond", quantity: 2 },
        { meter: "compute.millisecond", quantity: 3 },
        { meter: "compute.requests", quantity: 1_500_000 },
      ]),
    ).toEqual({
      amountMicros: 50_000_000,
      lines: [
        { meter: "compute.millisecond", quantity: 5, amountMicros: 5_000_000 },
        { meter: "compute.requests", quantity: 1_500_000, amountMicros: 45_000_000 },
      ],
    });
    expect(priceMeteredUsage(plan, [{ meter: "compute.requests", quantity: 1 }])).toEqual({
      amountMicros: 30,
      lines: [{ meter: "compute.requests", quantity: 1, amountMicros: 30 }],
    });
    expect(() => priceMeteredUsage(plan, [{ meter: "provider.invoice", quantity: 1 }])).toThrow(
      "unknown meter",
    );
  });
});
