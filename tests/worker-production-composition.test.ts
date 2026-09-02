import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { HOSTED_EDGE_SUPPLIES_KIND } from "../src/hosted-edge-supplies.ts";
import { HOSTED_OBJECT_BUCKET_SUPPLIES_KIND } from "../src/hosted-object-bucket-supplies.ts";
import { EDGE_OBJECTS_BINDING_REF } from "../src/providers/cloudflare-runtime-bindings.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import { createWorkerProductionComposition } from "../src/worker-production-composition.ts";

const installation = {
  id: "cloudflare.production",
  providerPackRef: "cloudflare",
  supplyContractRef: "cloudflare.production-contract",
  state: "active",
  regions: [{ id: "global", capacity: "available" }],
};

const contract = {
  id: "cloudflare.production-contract",
  providerType: "cloudflare",
  permittedResourceClasses: ["compute.edge", "storage.object"],
  deliveryModes: ["embedded-binding"],
  customerAccess: "operator-only",
  whiteLabelAllowed: true,
  endUserTermsRequired: true,
  regions: ["global"],
  validFrom: "2026-01-01T00:00:00.000Z",
  evidenceRef: "private:cloudflare:production-contract",
};

const portability = {
  api: "portable",
  exportFormats: [],
  importFormats: [],
  migrationModes: ["offline"],
};

const objectSupplies = {
  kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
  supplies: [
    {
      offeringId: "storage.object.cloudflare.global",
      displayName: "Object Storage",
      provider: { kind: "cloudflare" },
      providerInstallation: installation,
      supplyContract: contract,
      pricePlan: {
        id: "storage.object.cloudflare.global.price-v1",
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: [
          { meter: "storage.gib-hour", amountMinor: 2, quantity: 720 },
          { meter: "requests.million", amountMinor: 50 },
        ],
      },
      placement: {
        deliveryMode: "embedded-binding",
        supportPolicyRef: "support:hosted:standard",
        abusePolicyRef: "abuse:hosted:standard",
        portability,
        isolation: "dedicated-resource",
      },
    },
  ],
};

const wasabiObjectSupplies = {
  kind: HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
  supplies: [
    {
      offeringId: "storage.object.wasabi.eu-central-2",
      displayName: "Object Storage EU",
      provider: {
        kind: "wasabi",
        region: "eu-central-2",
        roleArn: "arn:aws:iam::1234567890:role/takoserver-bucket-access",
      },
      providerInstallation: {
        id: "wasabi.primary",
        providerPackRef: "wasabi",
        supplyContractRef: "wasabi.production-contract",
        state: "active",
        regions: [{ id: "eu-central-2", capacity: "available" }],
      },
      supplyContract: {
        id: "wasabi.production-contract",
        providerType: "wasabi",
        permittedResourceClasses: ["storage.object"],
        deliveryModes: ["embedded-binding"],
        customerAccess: "operator-only",
        whiteLabelAllowed: true,
        endUserTermsRequired: true,
        regions: ["eu-central-2"],
        validFrom: "2026-01-01T00:00:00.000Z",
        evidenceRef: "private:wasabi:production-contract",
      },
      pricePlan: {
        id: "storage.object.wasabi.eu-central-2.price-v1",
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: [
          { meter: "storage.gib-hour", amountMinor: 3, quantity: 720 },
          { meter: "requests.million", amountMinor: 60 },
          { meter: "egress.gib", amountMinor: 1 },
        ],
      },
      placement: {
        deliveryMode: "embedded-binding",
        supportPolicyRef: "support:hosted:standard",
        abusePolicyRef: "abuse:hosted:standard",
        portability,
        isolation: "dedicated-resource",
      },
    },
  ],
};

const edgeSupplies = {
  kind: HOSTED_EDGE_SUPPLIES_KIND,
  providerInstallation: installation,
  supplyContract: contract,
  offerings: [
    {
      formKind: "ModuleWorker",
      offeringId: "compute.edge.cloudflare.global",
      displayName: "Edge Worker",
      pricePlan: {
        id: "compute.edge.cloudflare.global.price-v1",
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: [{ meter: "compute.worker.requests.million", amountMinor: 30 }],
      },
      placement: {
        deliveryMode: "embedded-binding",
        supportPolicyRef: "support:hosted:standard",
        abusePolicyRef: "abuse:hosted:standard",
        portability,
        isolation: "dedicated-resource",
      },
    },
  ],
};

const artifacts = { manifest: async () => null, blob: async () => null };
const now = new Date("2026-09-01T00:00:00.000Z");

describe("Worker production composition", () => {
  test("advertises zero current ObjectBucket offerings without a Worker to consume it", () => {
    const catalog = stableProductionTakoformCatalog();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectSupplies),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
      },
      forms: catalog.forms,
      artifacts,
      now,
    });

    expect(composed.offerings).toEqual([]);
    expect(composed.providers.flatMap((provider) => provider.offerings)).toEqual([]);
    const pack = composed.providerPacks[0];
    expect(pack?.descriptor.forms.some((form) => form.kind === "ObjectBucket")).toBe(false);
    expect(pack?.descriptor.providedInterfaces.some((item) => item.name === "edge.objects")).toBe(
      false,
    );
    // ADR 0007 gave the Cloudflare pack both halves of the route. The bucket
    // is still not sellable here, because no edge supply realizes a Worker to
    // consume the Binding, and an unconsumable capability is not an Offering.
    expect(pack?.runtimeBindingMaterializer?.exporter?.routes).toEqual([
      expect.objectContaining({ bindingRef: EDGE_OBJECTS_BINDING_REF }),
    ]);
    expect(pack?.runtimeBindingMaterializer?.importer?.routes).toEqual([
      expect.objectContaining({ bindingRef: EDGE_OBJECTS_BINDING_REF }),
    ]);
    expect(pack?.attachmentFactories).toEqual([]);
    expect(pack?.credentialIssuers).toEqual([]);
    expect(
      JSON.stringify({
        offerings: composed.offerings,
        descriptors: composed.providerPacks.map((item) => item.descriptor),
      }),
    ).not.toMatch(/endpoint|bucketName|accessKey|secretAccessKey/iu);
  });

  test("keeps the retained v1beta1 ObjectBucket recovery-only and non-authorable", async () => {
    const current = stableProductionTakoformCatalog();
    const retained = await buildEdgeForms();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectSupplies),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
      },
      forms: current.forms,
      retainedForms: retained.forms,
      artifacts,
      now,
    });

    expect(composed.offerings).toEqual([]);
    expect(composed.providerPacks[0]?.descriptor.forms).toEqual([]);
    expect(composed.providers[0]?.offerings).toEqual([]);
    expect(
      composed.providers[0]?.recoveryOfferings
        ?.filter((offering) => offering.form.kind === "ObjectBucket")
        .map((offering) => offering.form.apiVersion),
    ).toEqual(["edge.forms.takoform.com/v1beta1"]);
  });

  test("installs WorkerVersion 0.3 with the exact object-bucket Binding consumer", () => {
    const catalog = stableProductionTakoformCatalog();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(edgeSupplies),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        TAKOSERVER_WORKER_ENDPOINT_SUFFIX: "hosted.workers.dev",
      },
      forms: catalog.forms,
      artifacts,
      now,
    });

    const workerVersion = composed.providerPacks[0]?.descriptor.forms.find(
      (form) => form.kind === "WorkerVersion",
    );
    expect(workerVersion).toMatchObject({
      apiVersion: "edge.forms.takoform.com",
      definitionVersion: "0.3.0",
      schemaDigest: "sha256:65870343bfab512fe5e7ae6faea8b3dbc48f9c9de0d4d9349dcbfd819f06d365",
    });
    expect(composed.providerPacks[0]?.descriptor.bindingRefs).not.toContainEqual(
      EDGE_OBJECTS_BINDING_REF,
    );
    expect(JSON.stringify(composed.offerings)).not.toContain("ObjectBucket");
  });

  test("sells the current ObjectBucket beside the Worker once both supplies exist", () => {
    const catalog = stableProductionTakoformCatalog();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(edgeSupplies),
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectSupplies),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        TAKOSERVER_WORKER_ENDPOINT_SUFFIX: "hosted.workers.dev",
      },
      forms: catalog.forms,
      artifacts,
      now,
    });

    expect(composed.offerings.map((offering) => offering.form.kind).sort()).toEqual([
      "ModuleWorker",
      "ObjectBucket",
    ]);
    const bucket = composed.providers
      .flatMap((provider) => provider.offerings)
      .find((offering) => offering.form.kind === "ObjectBucket");
    expect(bucket?.form).toMatchObject({
      apiVersion: "edge.forms.takoform.com",
      definitionVersion: "0.1.0",
    });
    // The consumer pack may now advertise the Binding, because one exporter
    // route and one importer route agree on it and a bucket target exists.
    expect(composed.providerPacks[0]?.descriptor.bindingRefs).toContainEqual(
      EDGE_OBJECTS_BINDING_REF,
    );
    // The Offering still carries no provider address of any kind.
    expect(JSON.stringify(composed.offerings)).not.toMatch(
      /endpoint|bucketName|accessKey|secretAccessKey/iu,
    );
  });

  test("does not turn Wasabi private transport into an ObjectBucket catalog offering", () => {
    const catalog = stableProductionTakoformCatalog();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(wasabiObjectSupplies),
        TAKOSERVER_WASABI_ACCESS_KEY_ID: "wasabi-access-key",
        TAKOSERVER_WASABI_SECRET_ACCESS_KEY: "wasabi-secret-key",
      },
      forms: catalog.forms,
      artifacts,
      now,
    });

    expect(composed.offerings).toEqual([]);
    expect(composed.providers.flatMap((provider) => provider.offerings)).toEqual([]);
    expect(
      composed.providerPacks
        .flatMap((pack) => pack.descriptor.forms)
        .some((form) => form.kind === "ObjectBucket"),
    ).toBe(false);
    expect(
      JSON.stringify({
        offerings: composed.offerings,
        descriptors: composed.providerPacks.map((item) => item.descriptor),
      }),
    ).not.toMatch(/endpoint|accessKey|secretAccessKey/iu);
  });

  test("does not infer storage retail or provider reach from ambient configuration", () => {
    const catalog = stableProductionTakoformCatalog();
    const empty = createWorkerProductionComposition({
      env: {},
      forms: catalog.forms,
      artifacts,
      now,
    });
    expect(empty.offerings).toEqual([]);
    expect(empty.providers).toEqual([]);
    expect(empty.providerPacks).toEqual([]);

    expect(() =>
      createWorkerProductionComposition({
        env: { CLOUDFLARE_ACCOUNT_ID: "account-id", CLOUDFLARE_API_TOKEN: "token" },
        forms: catalog.forms,
        artifacts,
        now,
      }),
    ).toThrow("provider credentials require reviewed hosted supplies");
  });

  test("rejects split Cloudflare installation authority", () => {
    const catalog = stableProductionTakoformCatalog();
    expect(() =>
      createWorkerProductionComposition({
        env: {
          TAKOSERVER_EDGE_SUPPLIES: JSON.stringify({
            ...edgeSupplies,
            providerInstallation: { ...installation, id: "cloudflare.other" },
          }),
          TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectSupplies),
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          CLOUDFLARE_API_TOKEN: "token",
          TAKOSERVER_WORKER_ENDPOINT_SUFFIX: "hosted.workers.dev",
        },
        forms: catalog.forms,
        artifacts,
        now,
      }),
    ).toThrow("Cloudflare provider installation is ambiguous");
  });
});
