import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { HOSTED_EDGE_SUPPLIES_KIND } from "../src/hosted-edge-supplies.ts";
import { HOSTED_OBJECT_BUCKET_SUPPLIES_KIND } from "../src/hosted-object-bucket-supplies.ts";
import type { CloudflareProviderExecutorRpc } from "../src/providers/cloudflare-provider-executor-rpc.ts";
import { CloudflareProviderProxy } from "../src/providers/cloudflare-provider-proxy.ts";
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
  permittedResourceClasses: [
    "compute.edge",
    "storage.object",
    "storage.kv",
    "database.sqlite",
    "messaging.queue",
  ],
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
    {
      formKind: "EdgeKVNamespace",
      offeringId: "storage.kv.cloudflare.global",
      displayName: "Edge KV",
      pricePlan: {
        id: "storage.kv.cloudflare.global.price-v1",
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: [
          { meter: "storage.kv.operations.million", amountMinor: 30 },
          { meter: "storage.kv.gib-hour", amountMinor: 2 },
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
    {
      formKind: "SQLiteDatabase",
      offeringId: "database.sqlite.cloudflare.global",
      displayName: "SQLite Database",
      pricePlan: {
        id: "database.sqlite.cloudflare.global.price-v1",
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: [
          { meter: "database.sqlite.rows-read.million", amountMinor: 30 },
          { meter: "database.sqlite.rows-written.million", amountMinor: 30 },
          { meter: "database.sqlite.gib-hour", amountMinor: 2 },
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
    {
      formKind: "AtLeastOnceQueue",
      offeringId: "messaging.queue.cloudflare.global",
      displayName: "Queue",
      pricePlan: {
        id: "messaging.queue.cloudflare.global.price-v1",
        currency: "USD",
        provisioning: { meter: "resource.create", amountMinor: 0 },
        meters: [
          { meter: "messaging.queue.operations.million", amountMinor: 30 },
          { meter: "messaging.queue.transfer.gib", amountMinor: 2 },
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

const artifacts = { manifest: async () => null, blob: async () => null };
const now = new Date("2026-09-01T00:00:00.000Z");
const executorBinding = {} as CloudflareProviderExecutorRpc;
const executorEnv = {
  CLOUDFLARE_PROVIDER_EXECUTOR: executorBinding,
  TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
} as const;

describe("Worker production composition", () => {
  test("advertises zero current ObjectBucket offerings without a Worker to consume it", () => {
    const catalog = stableProductionTakoformCatalog();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectSupplies),
        ...executorEnv,
      },
      forms: catalog.forms,
      artifacts,
      now,
    });

    expect(composed.offerings).toEqual([]);
    expect(composed.providers).toHaveLength(1);
    expect(composed.providers[0]).toBeInstanceOf(CloudflareProviderProxy);
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
        ...executorEnv,
      },
      forms: current.forms,
      retainedForms: retained.forms,
      artifacts,
      now,
    });

    expect(composed.offerings).toEqual([]);
    expect(composed.providers[0]).toBeInstanceOf(CloudflareProviderProxy);
    expect(composed.providerPacks[0]?.descriptor.forms).toEqual([]);
    expect(composed.providers[0]?.offerings).toEqual([]);
    expect(
      composed.providers[0]?.recoveryOfferings
        ?.filter((offering) => offering.form.kind === "ObjectBucket")
        .map((offering) => offering.form.apiVersion),
    ).toEqual(["edge.forms.takoform.com/v1beta1"]);
  });

  test("composes every Cloudflare edge retail meter through credential-free executor proxies", () => {
    const catalog = stableProductionTakoformCatalog();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(edgeSupplies),
        ...executorEnv,
      },
      forms: catalog.forms,
      now,
    });
    expect(composed.offerings.map((offering) => offering.id).sort()).toEqual([
      "compute.edge.cloudflare.global",
      "database.sqlite.cloudflare.global",
      "messaging.queue.cloudflare.global",
      "storage.kv.cloudflare.global",
    ]);
    expect(composed.providerPacks[0]?.meterSources.map((source) => source.id).sort()).toEqual([
      "cloudflare-d1-analytics",
      "cloudflare-kv-analytics",
      "cloudflare-queue-analytics",
      "cloudflare-worker-analytics",
    ]);
  });

  test("keeps managed ObjectBucket and every edge Offering sellable without public credentials", () => {
    const catalog = stableProductionTakoformCatalog();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(edgeSupplies),
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectSupplies),
        ...executorEnv,
      },
      forms: catalog.forms,
      now,
    });
    expect(composed.offerings.map((offering) => offering.id).sort()).toEqual([
      "compute.edge.cloudflare.global",
      "database.sqlite.cloudflare.global",
      "messaging.queue.cloudflare.global",
      "storage.kv.cloudflare.global",
      "storage.object.cloudflare.global",
    ]);
    expect(composed.providerPacks[0]?.meterSources.map((source) => source.id).sort()).toEqual([
      "cloudflare-d1-analytics",
      "cloudflare-kv-analytics",
      "cloudflare-queue-analytics",
      "cloudflare-r2-analytics",
      "cloudflare-worker-analytics",
    ]);
    expect(composed.providers[0]).toBeInstanceOf(CloudflareProviderProxy);
  });

  test("refuses every Wasabi supply until a separate private executor exists", () => {
    const catalog = stableProductionTakoformCatalog();
    expect(() =>
      createWorkerProductionComposition({
        env: {
          TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(wasabiObjectSupplies),
        },
        forms: catalog.forms,
        artifacts,
        now,
      }),
    ).toThrow("Wasabi supplies require a separate route-less provider executor");
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
        env: executorEnv,
        forms: catalog.forms,
        artifacts,
        now,
      }),
    ).toThrow("Cloudflare provider executor requires reviewed Cloudflare supplies");
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
          ...executorEnv,
        },
        forms: catalog.forms,
        artifacts,
        now,
      }),
    ).toThrow("Cloudflare provider installation is ambiguous");
  });
});
