import { describe, expect, test } from "bun:test";
import {
  type CatalogCandidate,
  compileCatalog,
  type PricePlan,
  type ProviderInstallation,
  type SupplyContract,
} from "../src/catalog-compiler.ts";
import type { ProviderPackDescriptor } from "../src/provider-pack.ts";

const FORM = {
  apiVersion: "edge.forms.takoform.com/v1beta1",
  kind: "ObjectBucket",
  definitionVersion: "0.1.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const OBJECTS = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "object.s3.takoform.com",
  version: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
} as const;

const PRICE: PricePlan = {
  id: "storage.s3.standard.price-v1",
  currency: "USD",
  recurring: { meter: "resource-month", amountMinor: 500 },
  meters: [
    { meter: "storage.gib-hour", amountMinor: 1, quantity: 1 },
    { meter: "egress.gib", amountMinor: 8, quantity: 1 },
    { meter: "requests.million", amountMinor: 30, quantity: 1_000_000 },
  ],
};

const PACK: ProviderPackDescriptor = {
  id: "wasabi",
  providerType: "wasabi",
  forms: [FORM],
  providedInterfaces: [OBJECTS],
  bindingRefs: [],
  meterSources: ["storage.gib-hour", "egress.gib", "requests.million"],
};

const CONTRACT: SupplyContract = {
  id: "wasabi.resale-2026",
  providerType: "wasabi",
  permittedResourceClasses: ["storage.s3"],
  deliveryModes: ["native-credentials", "provider-subaccount"],
  customerAccess: "scoped-native-access",
  whiteLabelAllowed: true,
  endUserTermsRequired: true,
  regions: ["ap-northeast"],
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
  evidenceRef: "contract:wasabi:2026",
};

const INSTALLATION: ProviderInstallation = {
  id: "wasabi.primary",
  providerPackRef: "wasabi",
  supplyContractRef: CONTRACT.id,
  state: "active",
  regions: [{ id: "ap-northeast", capacity: "available" }],
};

const CANDIDATE: CatalogCandidate = {
  id: "storage.s3.wasabi.ap-northeast",
  resourceClass: "storage.s3",
  providerPackRef: PACK.id,
  providerInstallationRef: INSTALLATION.id,
  supplyContractRef: CONTRACT.id,
  pricePlanRef: PRICE.id,
  supportPolicyRef: "support:storage:oncall",
  abusePolicyRef: "abuse:storage:standard",
  deliveryMode: "native-credentials",
  kind: "object_bucket",
  displayName: "S3 bucket (AP Northeast)",
  form: FORM,
  providedInterfaces: [OBJECTS],
  bindingRefs: [],
  regions: ["ap-northeast"],
  portability: {
    api: "portable",
    exportFormats: ["s3.object-set.takoform.com/v1"],
    importFormats: ["s3.object-set.takoform.com/v1"],
    migrationModes: ["offline", "online"],
  },
  isolation: "provider-subaccount",
};

function compile(
  overrides: {
    readonly contract?: SupplyContract;
    readonly installation?: ProviderInstallation;
    readonly pack?: ProviderPackDescriptor;
  } = {},
) {
  return compileCatalog({
    candidates: [CANDIDATE],
    providerPacks: [overrides.pack ?? PACK],
    providerInstallations: [overrides.installation ?? INSTALLATION],
    supplyContracts: [overrides.contract ?? CONTRACT],
    pricePlans: [PRICE],
    now: new Date("2026-08-18T00:00:00.000Z"),
  });
}

describe("commercial Catalog compiler", () => {
  test("publishes an Offering only when technology, supply, capacity, price, and operations agree", () => {
    const result = compile();

    expect(result.catalog.list()).toHaveLength(1);
    expect(result.catalog.list()[0]).toMatchObject({
      id: CANDIDATE.id,
      pricePlan: PRICE,
      providerPackRef: PACK.id,
      supplyContractRef: CONTRACT.id,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("does not publish an Offering outside its signed commercial authority", () => {
    const result = compile({
      contract: { ...CONTRACT, deliveryModes: ["provider-subaccount"] },
    });

    expect(result.catalog.list()).toEqual([]);
    expect(result.diagnostics).toEqual([
      { offeringId: CANDIDATE.id, code: "delivery_mode_not_permitted" },
    ]);
  });

  test("does not publish capacity it cannot meter or currently place", () => {
    const noMeter = compile({
      pack: { ...PACK, meterSources: ["storage.gib-hour", "egress.gib"] },
    });
    const noCapacity = compile({
      installation: {
        ...INSTALLATION,
        regions: [{ id: "ap-northeast", capacity: "unavailable" }],
      },
    });

    expect(noMeter.catalog.list()).toEqual([]);
    expect(noMeter.diagnostics).toEqual([
      { offeringId: CANDIDATE.id, code: "meter_source_missing" },
    ]);
    expect(noCapacity.catalog.list()).toEqual([]);
    expect(noCapacity.diagnostics).toEqual([
      { offeringId: CANDIDATE.id, code: "capacity_unavailable" },
    ]);
  });

  test("expires commercial authority without changing the portable Form", () => {
    const result = compile({
      contract: { ...CONTRACT, validUntil: "2026-08-17T23:59:59.999Z" },
    });

    expect(result.catalog.offeringsFor(FORM)).toEqual([]);
    expect(result.diagnostics).toEqual([
      { offeringId: CANDIDATE.id, code: "supply_contract_inactive" },
    ]);
  });
});
