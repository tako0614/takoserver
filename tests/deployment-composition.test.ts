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
import {
  buildEdgeForms,
  edgeProviderOffering,
  objectBucketProviderOffering,
} from "../src/edge-forms.ts";
import { compileObjectBucketDeployment } from "../src/object-bucket-deployment.ts";
import { EDGE_OBJECTS_BINDING_REF } from "../src/providers/cloudflare-runtime-bindings.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";

const COMPLETE_OBJECT_ROUTE = {
  id: "cloudflare-runtime-bindings",
  exporter: {
    routes: [
      {
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        materialKind: "test.object-capability@v1",
      },
    ],
    async exportTarget() {
      return { opaque: true };
    },
  },
  importer: {
    routes: [
      {
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        materialKind: "test.object-capability@v1",
      },
    ],
    async importBinding() {
      return { kind: "test.object-runtime" };
    },
  },
} as const;

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
  test("compiles an operator placement from the actual runtime Provider Pack", () => {
    const form = currentObjectBucket();
    const technical = objectBucketProviderOffering(form, {
      id: "storage.object.standard",
      displayName: "Object bucket",
      regions: ["global"],
    });
    const workerVersion = currentTakoformCandidates().forms.find(
      (candidate) => candidate.identity.formRef.kind === "WorkerVersion",
    );
    if (!workerVersion) throw new Error("current WorkerVersion fixture missing");
    const consumer = edgeProviderOffering(workerVersion, { id: "cloudflare.worker-version" });
    const provider = new FakeProvider({
      id: "cloudflare",
      offerings: [technical, consumer],
    });
    const composed = compileObjectBucketDeployment({
      form,
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
          exportFormats: [],
          importFormats: [],
          migrationModes: [],
        },
        isolation: "dedicated-resource",
      },
      capabilities: { runtimeBindingMaterializer: COMPLETE_OBJECT_ROUTE },
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
    expect(composed.providerPacks[0]?.descriptor.bindingRefs).toEqual([EDGE_OBJECTS_BINDING_REF]);
  });

  test("refuses an ObjectBucket catalog without a complete same-pack material route", () => {
    const form = currentObjectBucket();
    const technical = objectBucketProviderOffering(form, {
      id: "storage.object.standard",
      displayName: "Object bucket",
      regions: ["global"],
    });

    expect(() =>
      compileObjectBucketDeployment({
        form,
        provider: new FakeProvider({ id: "cloudflare", offerings: [technical] }),
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
            exportFormats: [],
            importFormats: [],
            migrationModes: [],
          },
          isolation: "dedicated-resource",
        },
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow(
      "deployment_catalog_invalid:storage.object.standard:runtime_binding_relation_incomplete",
    );
  });

  test("generic catalog admission rejects a hand-built ObjectBucket without an explicit consumer relation", () => {
    const form = currentObjectBucket();
    const technical = objectBucketProviderOffering(form, {
      id: "storage.object.hand-built",
      displayName: "Hand-built object bucket",
      regions: ["global"],
    });
    const pack = createProvisioningProviderPack({
      provider: new FakeProvider({ id: "cloudflare", offerings: [technical] }),
      providerType: "cloudflare",
      capabilities: { runtimeBindingMaterializer: COMPLETE_OBJECT_ROUTE },
    });
    const candidate = createCatalogCandidate(technical, {
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
        migrationModes: [],
      },
      isolation: "dedicated-resource",
    });

    expect(() =>
      compileDeploymentComposition({
        candidates: [candidate],
        providerPacks: [pack],
        providerInstallations: [INSTALLATION],
        supplyContracts: [CONTRACT],
        pricePlans: [PRICE],
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow(
      "deployment_catalog_invalid:storage.object.hand-built:runtime_binding_relation_missing",
    );
  });

  test("an explicit route cannot substitute for a consumer Offering that declares the Binding", () => {
    const form = currentObjectBucket();
    const technical = objectBucketProviderOffering(form, {
      id: "storage.object.no-consumer",
      displayName: "Object bucket without consumer",
      regions: ["global"],
    });
    const pack = createProvisioningProviderPack({
      provider: new FakeProvider({ id: "cloudflare", offerings: [technical] }),
      providerType: "cloudflare",
      capabilities: { runtimeBindingMaterializer: COMPLETE_OBJECT_ROUTE },
    });
    const candidate = createCatalogCandidate(technical, {
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
        migrationModes: [],
      },
      isolation: "dedicated-resource",
    });

    expect(() =>
      compileDeploymentComposition({
        candidates: [candidate],
        providerPacks: [pack],
        providerInstallations: [INSTALLATION],
        supplyContracts: [CONTRACT],
        pricePlans: [PRICE],
        runtimeBindingRelations: [
          {
            targetOfferingId: technical.id,
            consumerProviderPackRef: pack.id,
            bindingRef: EDGE_OBJECTS_BINDING_REF,
          },
        ],
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow(
      "deployment_catalog_invalid:storage.object.no-consumer:runtime_binding_relation_incomplete",
    );
  });

  test("fails the whole deployment instead of partially publishing invalid supply", () => {
    const form = currentObjectBucket();
    const technical = objectBucketProviderOffering(form, {
      id: "storage.object.standard",
      displayName: "Object bucket",
      regions: ["global"],
    });
    const workerVersion = currentTakoformCandidates().forms.find(
      (candidate) => candidate.identity.formRef.kind === "WorkerVersion",
    );
    if (!workerVersion) throw new Error("current WorkerVersion fixture missing");
    const consumer = edgeProviderOffering(workerVersion, { id: "cloudflare.worker-version" });
    const pack = createProvisioningProviderPack({
      provider: new FakeProvider({
        id: "cloudflare",
        offerings: [technical, consumer],
      }),
      providerType: "cloudflare",
      capabilities: { runtimeBindingMaterializer: COMPLETE_OBJECT_ROUTE },
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
        runtimeBindingRelations: [
          {
            targetOfferingId: technical.id,
            consumerProviderPackRef: pack.id,
            bindingRef: EDGE_OBJECTS_BINDING_REF,
          },
        ],
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow("deployment_catalog_invalid:storage.object.standard:capacity_unavailable");
  });

  test("refuses to author the retained v1beta1 ObjectBucket", async () => {
    const edge = await buildEdgeForms();
    expect(() =>
      compileObjectBucketDeployment({
        form: edge.objectBucket.form,
        provider: new FakeProvider({ id: "retained", offerings: [] }),
        providerType: "retained",
        offeringId: "storage.object.retained",
        displayName: "Retained object bucket",
        regions: ["global"],
        providerInstallation: INSTALLATION,
        supplyContract: {
          ...CONTRACT,
          providerType: "retained",
          permittedResourceClasses: ["storage.object"],
        },
        pricePlan: PRICE,
        placement: {
          deliveryMode: "embedded-binding",
          supportPolicyRef: "support:operator:standard",
          abusePolicyRef: "abuse:operator:standard",
          portability: {
            api: "portable",
            exportFormats: [],
            importFormats: [],
            migrationModes: [],
          },
          isolation: "dedicated-resource",
        },
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow("released_provider_object_bucket_required");
  });
});

function currentObjectBucket() {
  const form = currentTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
  );
  if (!form) throw new Error("current ObjectBucket fixture missing");
  return form;
}
