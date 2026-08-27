import { describe, expect, test } from "bun:test";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { HOSTED_EDGE_SUPPLIES_KIND } from "../src/hosted-edge-supplies.ts";
import { HOSTED_OBJECT_BUCKET_SUPPLIES_KIND } from "../src/hosted-object-bucket-supplies.ts";
import { PRODUCTION_STANDARD_SERVICE_SUPPLIES_KIND } from "../src/standard-service-production.ts";
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

const stableEdgeClasses = {
  ModuleWorker: {
    resourceClass: "compute.edge",
    meters: ["compute.worker.requests.million"],
  },
  EdgeKVNamespace: {
    resourceClass: "storage.kv",
    meters: ["storage.kv.operations.million", "storage.kv.gib-hour"],
  },
  SQLiteDatabase: {
    resourceClass: "database.sqlite",
    meters: [
      "database.sqlite.rows-read.million",
      "database.sqlite.rows-written.million",
      "database.sqlite.gib-hour",
    ],
  },
  AtLeastOnceQueue: {
    resourceClass: "messaging.queue",
    meters: ["messaging.queue.operations.million", "messaging.queue.transfer.gib"],
  },
} as const;

const stableEdgeSupplies = {
  kind: HOSTED_EDGE_SUPPLIES_KIND,
  providerInstallation: {
    ...installation,
    supplyContractRef: "cloudflare.stable-edge-contract",
  },
  supplyContract: {
    ...contract,
    id: "cloudflare.stable-edge-contract",
    permittedResourceClasses: Object.values(stableEdgeClasses).map((entry) => entry.resourceClass),
    deliveryModes: ["embedded-binding"],
    customerAccess: "operator-only",
  },
  offerings: Object.entries(stableEdgeClasses).map(([formKind, { resourceClass, meters }]) => ({
    formKind,
    offeringId: `${resourceClass}.cloudflare.stable-v1`,
    displayName: formKind,
    pricePlan: {
      id: `${resourceClass}.cloudflare.stable-v1.price-v1`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 0 },
      meters: meters.map((meter) => ({ meter, amountMinor: 1 })),
    },
    placement: {
      deliveryMode: "embedded-binding",
      supportPolicyRef: "support:hosted:standard",
      abusePolicyRef: "abuse:hosted:standard",
      portability,
      isolation: "dedicated-resource",
    },
  })),
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

const stableS3Supplies = (supplyNamespace = "host-primary") => ({
  kind: PRODUCTION_STANDARD_SERVICE_SUPPLIES_KIND,
  supplies: [
    {
      serviceRef: {
        apiVersion: "standards.takoform.com/v1",
        protocol: "com.amazonaws.s3",
      },
      backend: { kind: "cloudflare-r2", supplyNamespace },
    },
  ],
});

describe("Worker production composition", () => {
  test("publishes the stable Edge provider subset without current ObjectBucket authority", () => {
    const catalog = stableProductionTakoformCatalog();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(stableEdgeSupplies),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        TAKOSERVER_WORKER_ENDPOINT_SUFFIX: "hosted.workers.dev",
      },
      forms: catalog.forms,
      artifacts: { manifest: async () => null, blob: async () => null },
      now: new Date("2026-08-24T00:00:00.000Z"),
    });

    expect(composed.providers.map((provider) => provider.id)).toEqual(["cloudflare"]);
    expect(composed.offerings.map((offering) => offering.form.kind).sort()).toEqual([
      "AtLeastOnceQueue",
      "EdgeKVNamespace",
      "ModuleWorker",
      "SQLiteDatabase",
    ]);
    expect(composed.providerPacks).toHaveLength(1);
    expect(composed.providerPacks[0]?.descriptor.forms.map((form) => form.kind).sort()).toEqual([
      "AtLeastOnceQueue",
      "EdgeKVNamespace",
      "ModuleWorker",
      "QueueConsumer",
      "SQLiteDatabase",
      "WorkerCronTrigger",
      "WorkerCustomDomain",
      "WorkerDeployment",
      "WorkerEndpoint",
      "WorkerVersion",
    ]);
    expect(composed.providerPacks[0]?.attachmentFactories).toEqual([]);
    expect(JSON.stringify(composed)).not.toContain("ObjectBucket");
    expect(JSON.stringify(composed)).not.toContain("edge.objects");
  });

  test("keeps exact beta provider dispatch drain-only beside the adoption-candidate catalog", async () => {
    const stable = stableProductionTakoformCatalog();
    const retained = await buildEdgeForms();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(stableEdgeSupplies),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
      },
      forms: stable.forms,
      retainedForms: retained.forms,
      artifacts: { manifest: async () => null, blob: async () => null },
      now: new Date("2026-08-24T00:00:00.000Z"),
    });

    expect(composed.offerings.map((offering) => offering.form.apiVersion)).toEqual([
      "edge.forms.takoform.com",
      "edge.forms.takoform.com",
      "edge.forms.takoform.com",
      "edge.forms.takoform.com",
    ]);
    const retainedRefs = composed.providerPacks[0]?.descriptor.forms.filter(
      (form) => form.apiVersion === "edge.forms.takoform.com/v1beta1",
    );
    expect(retainedRefs?.map((form) => form.kind).sort()).toEqual([
      "AtLeastOnceQueue",
      "EdgeKVNamespace",
      "ModuleWorker",
      "ObjectBucket",
      "QueueConsumer",
      "SQLiteDatabase",
      "WorkerCronTrigger",
      "WorkerCustomDomain",
      "WorkerDeployment",
      "WorkerEndpoint",
      "WorkerVersion",
    ]);
    expect(composed.providerPacks[0]?.attachmentFactories).toEqual([]);
    expect(JSON.stringify(composed.offerings)).not.toContain("ObjectBucket");
    expect(JSON.stringify(composed.offerings)).not.toContain("edge.objects");
  });

  test("revalidates and shares a Host-owned R2 slot across revisions without current ObjectBucket Forms", async () => {
    const calls: Array<{ readonly method: string; readonly url: string; readonly body: string }> =
      [];
    const buckets = new Set<string>();
    const composed = createWorkerProductionComposition({
      env: {
        TAKOSERVER_STANDARD_SERVICE_SUPPLIES: JSON.stringify(stableS3Supplies()),
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
      },
      forms: [],
      artifacts: { manifest: async () => null, blob: async () => null },
      async fetch(request) {
        const body = await request.clone().text();
        calls.push({ method: request.method, url: request.url, body });
        if (request.method === "GET") {
          const name = new URL(request.url).pathname.split("/").at(-1) ?? "";
          if (buckets.has(name)) {
            return Response.json({ success: true, errors: [], result: { name } });
          }
          return Response.json(
            { success: false, errors: [{ code: 10006 }], result: null },
            { status: 404 },
          );
        }
        const bucket = (JSON.parse(body) as { name: string }).name;
        buckets.add(bucket);
        return Response.json({ success: true, errors: [], result: { name: bucket } });
      },
      now: new Date("2026-08-19T00:00:00.000Z"),
    });

    expect(composed.providers).toEqual([]);
    expect(composed.providerPacks).toEqual([]);
    expect(composed.offerings).toEqual([]);
    expect(composed.standardServiceResolver).toBeDefined();
    expect(
      await composed.standardServiceResolver?.satisfiable({
        tenantId: "tenant-a",
        space: "production",
        serviceRef: {
          apiVersion: "standards.takoform.com/v1",
          protocol: "com.amazonaws.s3",
        },
      }),
    ).toBe(true);
    expect(
      await composed.standardServiceResolver?.satisfiable({
        tenantId: "tenant-a",
        space: "production",
        serviceRef: {
          apiVersion: "standards.takoform.com/v1",
          protocol: "com.example.unknown",
        },
      }),
    ).toBe(false);

    const material = await composed.standardServiceResolver?.resolve({
      tenantId: "tenant-a",
      space: "production",
      form: {} as never,
      slot: {
        name: "MEDIA",
        required: true,
        service: {
          apiVersion: "standards.takoform.com/v1",
          protocol: "com.amazonaws.s3",
        },
      },
    });
    expect(material).toEqual({
      endpoint: {
        kind: "takoserver.cloudflare-r2-bucket@v1",
        bucketName: expect.stringMatching(/^tss3-[0-9a-f]{40}$/u),
      },
      credential: { kind: "takoserver.cloudflare-r2-binding@v1" },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[0]?.url).toContain(
      "https://api.cloudflare.com/client/v4/accounts/account-id/r2/buckets/tss3-",
    );
    expect(calls[1]?.body).not.toContain("tenant-a");
    expect(calls[1]?.body).not.toContain("production");
    expect(calls[1]?.body).not.toContain("MEDIA");
    expect(
      await composed.standardServiceResolver?.resolve({
        tenantId: "tenant-a",
        space: "production",
        // A later immutable WorkerVersion resolves the same Host-owned service.
        // Portable Resource deletion is deliberately not bucket cleanup authority.
        form: { revision: 2 } as never,
        slot: {
          name: "MEDIA",
          required: true,
          service: {
            apiVersion: "standards.takoform.com/v1",
            protocol: "com.amazonaws.s3",
          },
        },
      }),
    ).toEqual(material);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "GET"]);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    const otherSpace = await composed.standardServiceResolver?.resolve({
      tenantId: "tenant-a",
      space: "staging",
      form: {} as never,
      slot: {
        name: "MEDIA",
        required: true,
        service: {
          apiVersion: "standards.takoform.com/v1",
          protocol: "com.amazonaws.s3",
        },
      },
    });
    expect(otherSpace?.endpoint).not.toEqual(material?.endpoint);
    expect(calls).toHaveLength(5);
    expect(JSON.stringify(composed.offerings)).not.toContain("ObjectBucket");
    expect(JSON.stringify(composed.providerPacks)).not.toContain("edge.objects");
  });

  test("keeps stable standard services fail-closed without explicit operator supply", () => {
    const composed = createWorkerProductionComposition({
      env: {},
      forms: [],
      artifacts: { manifest: async () => null, blob: async () => null },
      now: new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(composed.standardServiceResolver).toBeUndefined();
  });

  test("namespaces deterministic R2 services by the operator-owned Host supply", async () => {
    const buckets: string[] = [];
    const compose = (supplyNamespace: string) =>
      createWorkerProductionComposition({
        env: {
          TAKOSERVER_STANDARD_SERVICE_SUPPLIES: JSON.stringify(stableS3Supplies(supplyNamespace)),
          CLOUDFLARE_ACCOUNT_ID: "shared-account",
          CLOUDFLARE_API_TOKEN: "cloudflare-token",
        },
        forms: [],
        artifacts: { manifest: async () => null, blob: async () => null },
        async fetch(request) {
          if (request.method === "GET") {
            return Response.json(
              { success: false, errors: [{ code: 10006 }], result: null },
              { status: 404 },
            );
          }
          const body = (await request.json()) as { readonly name: string };
          buckets.push(body.name);
          return Response.json({ success: true, errors: [], result: { name: body.name } });
        },
        now: new Date("2026-08-23T00:00:00.000Z"),
      });

    for (const namespace of ["host-east", "host-west"]) {
      await compose(namespace).standardServiceResolver?.resolve({
        tenantId: "same-tenant",
        space: "same-space",
        form: {} as never,
        slot: {
          name: "MEDIA",
          required: true,
          service: {
            apiVersion: "standards.takoform.com/v1",
            protocol: "com.amazonaws.s3",
          },
        },
      });
    }

    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatch(/^tss3-[0-9a-f]{40}$/u);
    expect(buckets[1]).toMatch(/^tss3-[0-9a-f]{40}$/u);
    expect(buckets[0]).not.toBe(buckets[1]);
  });

  test("refuses an absent or malformed Host supply namespace", () => {
    for (const backend of [
      { kind: "cloudflare-r2" },
      { kind: "cloudflare-r2", supplyNamespace: "" },
      { kind: "cloudflare-r2", supplyNamespace: "host/escape" },
    ]) {
      expect(() =>
        createWorkerProductionComposition({
          env: {
            TAKOSERVER_STANDARD_SERVICE_SUPPLIES: JSON.stringify({
              kind: PRODUCTION_STANDARD_SERVICE_SUPPLIES_KIND,
              supplies: [
                {
                  serviceRef: {
                    apiVersion: "standards.takoform.com/v1",
                    protocol: "com.amazonaws.s3",
                  },
                  backend,
                },
              ],
            }),
            CLOUDFLARE_ACCOUNT_ID: "account-id",
            CLOUDFLARE_API_TOKEN: "cloudflare-token",
          },
          forms: [],
          artifacts: { manifest: async () => null, blob: async () => null },
          now: new Date("2026-08-23T00:00:00.000Z"),
        }),
      ).toThrow("invalid production standard-service supplies");
    }
  });

  test("keeps configured released Edge and storage providers drain-only", async () => {
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
    expect(composed.offerings).toEqual([]);
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
    expect(JSON.stringify(composed.offerings)).not.toContain("ObjectBucket");
    expect(JSON.stringify(composed.offerings)).not.toContain("edge.objects");
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
