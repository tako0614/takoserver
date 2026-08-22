import { describe, expect, test } from "bun:test";
import type {
  CatalogCandidate,
  PricePlan,
  ProviderInstallation,
  SupplyContract,
} from "../src/catalog-compiler.ts";
import {
  compileDeploymentComposition,
  createCatalogCandidate,
  createProvisioningProviderPack,
} from "../src/deployment-composition.ts";
import { buildEdgeForms, objectBucketProviderOffering } from "../src/edge-forms.ts";
import {
  compileObjectBucketDeployment,
  compileObjectBucketDeployments,
} from "../src/object-bucket-deployment.ts";
import { FakeProvider } from "../src/providers/fake.ts";

const PRICE: PricePlan = {
  id: "storage.object.cloudflare.price-v1",
  currency: "USD",
  provisioning: { meter: "resource.create", amountMinor: 500 },
  meters: [],
};

const CONTRACT: SupplyContract = {
  id: "cloudflare.operator-contract",
  providerType: "cloudflare",
  permittedResourceClasses: ["storage.object"],
  deliveryModes: ["embedded-binding"],
  customerAccess: "operator-only",
  whiteLabelAllowed: false,
  endUserTermsRequired: false,
  regions: ["global"],
  validFrom: "2026-01-01T00:00:00.000Z",
  evidenceRef: "operator-contract:cloudflare",
};

const INSTALLATION: ProviderInstallation = {
  id: "cloudflare.primary",
  providerPackRef: "cloudflare",
  supplyContractRef: CONTRACT.id,
  state: "active",
  regions: [{ id: "global", capacity: "available" }],
};

describe("deployment composition", () => {
  test("compiles a sellable Offering from the actual runtime Provider Pack", async () => {
    const edge = await buildEdgeForms();
    const technical = objectBucketProviderOffering(edge.objectBucket.form, {
      id: "storage.object.standard",
      displayName: "Object bucket",
      regions: ["global"],
    });
    const provider = new FakeProvider({ id: "cloudflare", offerings: [technical] });
    const composed = compileObjectBucketDeployment({
      form: edge.objectBucket.form,
      provider,
      providerType: "cloudflare",
      offeringId: technical.id,
      displayName: technical.displayName,
      regions: ["global"],
      providerInstallation: INSTALLATION,
      supplyContract: CONTRACT,
      pricePlan: PRICE,
      placement: {
        deliveryMode: "embedded-binding",
        supportPolicyRef: "support:operator:standard",
        abusePolicyRef: "abuse:operator:standard",
        portability: {
          api: "portable",
          exportFormats: ["s3.object-set.takoform.com/v1"],
          importFormats: ["s3.object-set.takoform.com/v1"],
          migrationModes: ["offline", "online"],
        },
        isolation: "dedicated-resource",
      },
      now: new Date("2026-08-19T00:00:00.000Z"),
    });

    expect(composed.offerings).toHaveLength(1);
    expect(composed.offerings[0]).toMatchObject({
      id: technical.id,
      providerPackRef: "cloudflare",
      providerInstallationRef: "cloudflare.primary",
      available: true,
    });
    expect(composed.providerPacks[0]?.id).toBe("cloudflare");
  });

  test("fails the whole deployment instead of partially publishing invalid supply", async () => {
    const edge = await buildEdgeForms();
    const technical = objectBucketProviderOffering(edge.objectBucket.form, {
      id: "storage.object.standard",
      displayName: "Object bucket",
      regions: ["global"],
    });
    const pack = createProvisioningProviderPack({
      provider: new FakeProvider({ id: "cloudflare", offerings: [technical] }),
      providerType: "cloudflare",
    });
    const candidate: CatalogCandidate = createCatalogCandidate(technical, {
      providerPackRef: pack.id,
      providerInstallationRef: INSTALLATION.id,
      supplyContractRef: CONTRACT.id,
      pricePlanRef: PRICE.id,
      resourceClass: "storage.object",
      deliveryMode: "embedded-binding",
      supportPolicyRef: "support:operator:standard",
      abusePolicyRef: "abuse:operator:standard",
      portability: {
        api: "portable",
        exportFormats: [],
        importFormats: [],
        migrationModes: ["offline"],
      },
      isolation: "dedicated-resource",
    });

    expect(() =>
      compileDeploymentComposition({
        candidates: [candidate],
        providerPacks: [pack],
        providerInstallations: [
          {
            ...INSTALLATION,
            regions: [{ id: "global", capacity: "unavailable" }],
          },
        ],
        supplyContracts: [CONTRACT],
        pricePlans: [PRICE],
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow("deployment_catalog_invalid:storage.object.standard:capacity_unavailable");
  });

  test("publishes multiple Offerings for one exact Form with explicit providers", async () => {
    const edge = await buildEdgeForms();
    const make = (id: string, providerId: string, providerType: string) => {
      const technical = objectBucketProviderOffering(edge.objectBucket.form, {
        id,
        displayName: id,
        regions: ["global"],
      });
      return {
        form: edge.objectBucket.form,
        provider: new FakeProvider({ id: providerId, offerings: [technical] }),
        providerType,
        offeringId: id,
        displayName: id,
        regions: ["global"],
        providerInstallation: {
          id: `${providerId}.primary`,
          providerPackRef: providerId,
          supplyContractRef: `${providerId}.contract`,
          state: "active" as const,
          regions: [{ id: "global", capacity: "available" as const }],
        },
        supplyContract: {
          id: `${providerId}.contract`,
          providerType,
          permittedResourceClasses: ["storage.object"],
          deliveryModes: ["native-credentials" as const],
          customerAccess: "scoped-native-access" as const,
          whiteLabelAllowed: true,
          endUserTermsRequired: true,
          regions: ["global"],
          validFrom: "2026-01-01T00:00:00.000Z",
          evidenceRef: `private:${providerId}`,
        },
        pricePlan: {
          id: `${id}.price-v1`,
          currency: "USD" as const,
          provisioning: { meter: "resource.create", amountMinor: 500 },
          meters: [],
        },
        placement: {
          deliveryMode: "native-credentials" as const,
          supportPolicyRef: "support:hosted:standard",
          abusePolicyRef: "abuse:hosted:standard",
          portability: {
            api: "portable" as const,
            exportFormats: ["s3.object-set.takoform.com/v1"],
            importFormats: ["s3.object-set.takoform.com/v1"],
            migrationModes: ["offline" as const],
          },
          isolation: "dedicated-resource" as const,
        },
      };
    };
    const composed = compileObjectBucketDeployments({
      deployments: [
        make("storage.object.cloudflare", "cloudflare", "cloudflare"),
        make("storage.object.wasabi", "wasabi", "wasabi"),
      ],
      now: new Date("2026-08-19T00:00:00.000Z"),
    });

    expect(composed.offerings.map((offering) => offering.id).sort()).toEqual([
      "storage.object.cloudflare",
      "storage.object.wasabi",
    ]);
    expect(composed.providerPacks.map((pack) => pack.id).sort()).toEqual(["cloudflare", "wasabi"]);
  });
});
