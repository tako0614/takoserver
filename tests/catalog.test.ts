import { describe, expect, test } from "bun:test";
import {
  createCatalog,
  type Offering,
  priceMeteredUsage,
  priceProvisioning,
} from "../src/catalog.ts";
import type { TakoformInterfaceRef } from "../src/takoform/types.ts";

const FORM = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
} as const;

const OBJECTS: TakoformInterfaceRef = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "edge.objects",
  version: "1.0.0",
  schemaDigest: "sha256:fad47fa63409a05fb0b5886d23300e7ecd32fd64b11aaef5a200247872d19e00",
};

function offering(id: string, providerPackRef: string): Offering {
  return {
    id,
    providerPackRef,
    providerInstallationRef: `${providerPackRef}.primary`,
    supplyContractRef: `${providerPackRef}.resale-2026`,
    pricePlanRef: `${id}.price-v1`,
    resourceClass: "storage.s3",
    deliveryMode: "provider-subaccount",
    supportPolicyRef: "support:storage:oncall",
    abusePolicyRef: "abuse:storage:standard",
    kind: "object_bucket",
    displayName: id,
    form: FORM,
    providedInterfaces: [OBJECTS],
    bindingRefs: [],
    pricePlan: {
      id: `${id}.price-v1`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 500 },
      meters: [
        { meter: "storage.gib-hour", amountMinor: 1, quantity: 1 },
        { meter: "requests.million", amountMinor: 30, quantity: 1_000_000 },
      ],
    },
    regions: ["global"],
    portability: {
      api: "portable",
      exportFormats: ["s3.object-set.takoform.com/v1"],
      importFormats: ["s3.object-set.takoform.com/v1"],
      migrationModes: ["offline", "online"],
    },
    isolation: "provider-subaccount",
    available: true,
  };
}

describe("Offering catalog", () => {
  test("keeps several sellable deployments for one exact Form", () => {
    const wasabi = offering("storage.s3.wasabi.ap-northeast", "wasabi");
    const backblaze = offering("storage.s3.backblaze.us-west", "backblaze");
    const catalog = createCatalog([wasabi, backblaze]);

    expect(catalog.offeringsFor(FORM).map((entry) => entry.id)).toEqual([wasabi.id, backblaze.id]);
    expect(catalog.findOffering(backblaze.id)).toEqual(backblaze);
  });

  test("does not silently choose an Offering from the Form", () => {
    const catalog = createCatalog([
      offering("storage.s3.wasabi.ap-northeast", "wasabi"),
      offering("storage.s3.backblaze.us-west", "backblaze"),
    ]);

    expect("forForm" in catalog).toBe(false);
  });

  test("prices provisioning once and keeps aggregated usage below one cent precise", () => {
    const plan = offering("storage.s3.wasabi.ap-northeast", "wasabi").pricePlan;

    expect(priceProvisioning(plan, 2)).toBe(1_000);
    expect(
      priceMeteredUsage(plan, [
        { meter: "storage.gib-hour", quantity: 2 },
        { meter: "storage.gib-hour", quantity: 3 },
        { meter: "requests.million", quantity: 1_500_000 },
      ]),
    ).toEqual({
      amountMicros: 50_000_000,
      lines: [
        { meter: "requests.million", quantity: 1_500_000, amountMicros: 45_000_000 },
        { meter: "storage.gib-hour", quantity: 5, amountMicros: 5_000_000 },
      ],
    });
    expect(priceMeteredUsage(plan, [{ meter: "requests.million", quantity: 1 }])).toEqual({
      amountMicros: 30,
      lines: [{ meter: "requests.million", quantity: 1, amountMicros: 30 }],
    });
    expect(() => priceMeteredUsage(plan, [{ meter: "provider.invoice", quantity: 1 }])).toThrow(
      "unknown meter",
    );
  });
});
