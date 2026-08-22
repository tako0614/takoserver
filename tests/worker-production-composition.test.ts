import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { HOSTED_EDGE_SUPPLIES_KIND } from "../src/hosted-edge-supplies.ts";
import { HOSTED_OBJECT_BUCKET_SUPPLIES_KIND } from "../src/hosted-object-bucket-supplies.ts";
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
  deliveryModes: ["embedded-binding", "native-credentials"],
  customerAccess: "scoped-native-access",
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
        deliveryMode: "native-credentials",
        supportPolicyRef: "support:hosted:standard",
        abusePolicyRef: "abuse:hosted:standard",
        portability: {
          ...portability,
          exportFormats: ["s3.object-set.takoform.com/v1"],
          importFormats: ["s3.object-set.takoform.com/v1"],
        },
        isolation: "dedicated-resource",
      },
    },
  ],
};

const s3CredentialIssuer = {
  limits: () => ({ minimumSeconds: 60, maximumSeconds: 3_600, defaultSeconds: 900 }),
  async issue(): Promise<never> {
    throw new Error("not used by composition");
  },
};

describe("Worker production composition", () => {
  test("joins edge and storage sales to one Cloudflare Provider installation", async () => {
    const edge = await buildEdgeForms();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(edgeSupplies),
        TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectSupplies),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        TAKOSERVER_WORKER_ENDPOINT_SUFFIX: "hosted.workers.dev",
      },
      forms: edge.forms,
      artifacts: { manifest: async () => null, blob: async () => null },
      s3CredentialIssuer,
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(composed.providers.map((provider) => provider.id)).toEqual(["cloudflare"]);
    expect(composed.offerings.map((offering) => offering.id).sort()).toEqual([
      "compute.edge.cloudflare.global",
      "storage.object.cloudflare.global",
    ]);
    expect(composed.providerPacks).toHaveLength(1);
    expect(composed.providerPacks[0]?.descriptor.forms.map((form) => form.kind).sort()).toEqual([
      "ModuleWorker",
      "ObjectBucket",
      "QueueConsumer",
      "WorkerCronTrigger",
      "WorkerCustomDomain",
      "WorkerDeployment",
      "WorkerEndpoint",
      "WorkerVersion",
    ]);
    expect(composed.providerPacks[0]?.attachmentFactories).toHaveLength(1);
  });

  test("rejects ambient provider reach and split Cloudflare authority", async () => {
    const edge = await buildEdgeForms();
    expect(() =>
      createWorkerProductionComposition({
        env: { CLOUDFLARE_ACCOUNT_ID: "account-id", CLOUDFLARE_API_TOKEN: "token" },
        forms: edge.forms,
        artifacts: { manifest: async () => null, blob: async () => null },
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow("provider credentials require reviewed hosted supplies");
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
        },
        forms: edge.forms,
        artifacts: { manifest: async () => null, blob: async () => null },
        s3CredentialIssuer,
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow("Cloudflare provider installation is ambiguous");
  });

  test("refuses invented or duplicate identity Form supplies", () => {
    expect(() =>
      createWorkerProductionComposition({
        env: {
          TAKOSERVER_EDGE_SUPPLIES: JSON.stringify({
            ...edgeSupplies,
            offerings: [{ ...edgeSupplies.offerings[0], formKind: "CloudflareWorker" }],
          }),
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          CLOUDFLARE_API_TOKEN: "token",
        },
        forms: [],
        artifacts: { manifest: async () => null, blob: async () => null },
        now: new Date("2026-08-19T00:00:00.000Z"),
      }),
    ).toThrow("invalid hosted edge supplies");
  });
});
