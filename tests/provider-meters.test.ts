import { describe, expect, test } from "bun:test";
import { createCloudflareEdgeMeterSources } from "../src/providers/cloudflare-edge-meter.ts";
import { createCloudflareR2MeterSource } from "../src/providers/cloudflare-r2-meter.ts";
import { createWasabiBucketMeterSource } from "../src/providers/wasabi-meter.ts";
import type { ResourceDeployment } from "../src/resource-deployments.ts";

const deployment = (provider: "cloudflare" | "wasabi"): ResourceDeployment => ({
  tenantId: "org_test",
  id: `dep_${provider}`,
  resourceUid: "res_bucket",
  offeringId: `storage.object.${provider}`,
  providerPackRef: provider,
  providerInstallationRef: `${provider}.production`,
  nativeId:
    provider === "cloudflare"
      ? "r2:ts-0123456789abcdef0123456789abcdef01234567"
      : "wasabi:eu-central-2:ts-0123456789abcdef0123456789abcdef01234567",
  state: "active",
  observed: {},
  outputs: {},
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const edgeDeployment = (nativeId: string): ResourceDeployment => ({
  tenantId: "org_test",
  id: `dep_${nativeId.split(":")[0]}`,
  resourceUid: `res_${nativeId.split(":")[0]}`,
  offeringId: "edge.usage-only",
  providerPackRef: "cloudflare",
  providerInstallationRef: "cloudflare.production",
  nativeId,
  state: "active",
  observed: {},
  outputs: {},
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

describe("production object storage meter sources", () => {
  test("reads bounded Cloudflare R2 GraphQL operations and storage", async () => {
    let request: Request | undefined;
    const source = createCloudflareR2MeterSource({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async (input) => {
        request = input;
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  r2OperationsAdaptiveGroups: [{ sum: { requests: 2_000_000 } }],
                  r2StorageAdaptiveGroups: [
                    {
                      max: { payloadSize: 1_073_741_824, metadataSize: 0 },
                      dimensions: { datetime: "2026-08-19T00:00:00.000Z" },
                    },
                    {
                      max: { payloadSize: 2_147_483_648, metadataSize: 0 },
                      dimensions: { datetime: "2026-08-19T01:00:00.000Z" },
                    },
                  ],
                },
              ],
            },
          },
        });
      },
    });

    expect(
      await source.read({
        tenantId: "org_test",
        deployment: deployment("cloudflare"),
        from: "2026-08-19T00:00:00.000Z",
        until: "2026-08-19T02:00:00.000Z",
      }),
    ).toEqual([
      { meter: "requests.million", quantity: 2 },
      { meter: "storage.gib-hour", quantity: 3 },
    ]);
    expect(request?.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(request?.headers.get("authorization")).toBe("Bearer provider-token");
    expect(await request?.clone().json()).toMatchObject({
      variables: {
        accountTag: "account-id",
        bucketName: "ts-0123456789abcdef0123456789abcdef01234567",
      },
    });
  });

  test("reads exact Wasabi per-bucket daily utilization", async () => {
    let request: Request | undefined;
    const source = createWasabiBucketMeterSource({
      region: "eu-central-2",
      accessKeyId: "wasabi-key",
      secretAccessKey: "wasabi-secret",
      fetch: async (input) => {
        request = input;
        return Response.json({
          PageInfo: { PageCount: 1, PageSize: 100 },
          Records: [
            {
              Bucket: "ts-0123456789abcdef0123456789abcdef01234567",
              Region: "eu-central-2",
              StartTime: "2026-08-17T00:00:00.000Z",
              RawStorageSizeBytes: 1_073_741_824,
              MetadataStorageSizeBytes: 0,
              DeletedStorageSizeBytes: 0,
              DownloadBytes: 1_073_741_824,
              NumAPICalls: 1_000_000,
            },
            {
              Bucket: "ts-0123456789abcdef0123456789abcdef01234567",
              Region: "eu-central-2",
              StartTime: "2026-08-18T00:00:00.000Z",
              RawStorageSizeBytes: 2_147_483_648,
              MetadataStorageSizeBytes: 0,
              DeletedStorageSizeBytes: 0,
              DownloadBytes: 2_147_483_648,
              NumAPICalls: 2_000_000,
            },
          ],
        });
      },
    });

    expect(
      await source.read({
        tenantId: "org_test",
        deployment: deployment("wasabi"),
        from: "2026-08-17T00:00:00.000Z",
        until: "2026-08-19T00:00:00.000Z",
      }),
    ).toEqual([
      { meter: "egress.gib", quantity: 3 },
      { meter: "requests.million", quantity: 3 },
      { meter: "storage.gib-hour", quantity: 72 },
    ]);
    expect(request?.url).toContain(
      "/v1/standalone/utilizations/bucket/ts-0123456789abcdef0123456789abcdef01234567",
    );
    expect(request?.headers.get("authorization")).toBe("wasabi-key:wasabi-secret");
  });

  test("reads exact Cloudflare Worker, KV, D1, and Queue usage meters", async () => {
    const bodies: Record<string, unknown>[] = [];
    const sources = createCloudflareEdgeMeterSources({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        const query = String(body.query);
        const account = query.includes("workersInvocationsAdaptive")
          ? { workersInvocationsAdaptive: [{ sum: { requests: 2_000_000 } }] }
          : query.includes("kvOperationsAdaptiveGroups")
            ? {
                kvOperationsAdaptiveGroups: [{ sum: { requests: 3_000_000 } }],
                kvStorageAdaptiveGroups: [
                  {
                    max: { byteCount: 1_073_741_824 },
                    dimensions: { date: "2026-08-18" },
                  },
                ],
              }
            : query.includes("d1AnalyticsAdaptiveGroups")
              ? {
                  d1AnalyticsAdaptiveGroups: [
                    { sum: { rowsRead: 4_000_000, rowsWritten: 5_000_000 } },
                  ],
                  d1StorageAdaptiveGroups: [
                    {
                      max: { databaseSizeBytes: 2_147_483_648 },
                      dimensions: { date: "2026-08-18" },
                    },
                  ],
                }
              : {
                  queueMessageOperationsAdaptiveGroups: [
                    { sum: { billableOperations: 6_000_000, bytes: 1_073_741_824 } },
                  ],
                };
        return Response.json({ data: { viewer: { accounts: [account] } } });
      },
    });

    expect(
      await sources[0]?.read({
        tenantId: "org_test",
        deployment: edgeDeployment("worker:checkout"),
        from: "2026-08-18T00:00:00.000Z",
        until: "2026-08-18T01:00:00.000Z",
      }),
    ).toEqual([{ meter: "compute.worker.requests.million", quantity: 2 }]);
    expect(
      await sources[1]?.read({
        tenantId: "org_test",
        deployment: edgeDeployment("kv:0123456789abcdef"),
        from: "2026-08-18T00:00:00.000Z",
        until: "2026-08-19T00:00:00.000Z",
      }),
    ).toEqual([
      { meter: "storage.kv.gib-hour", quantity: 24 },
      { meter: "storage.kv.operations.million", quantity: 3 },
    ]);
    expect(
      await sources[2]?.read({
        tenantId: "org_test",
        deployment: edgeDeployment("d1:01234567-89ab-cdef-0123-456789abcdef"),
        from: "2026-08-18T00:00:00.000Z",
        until: "2026-08-19T00:00:00.000Z",
      }),
    ).toEqual([
      { meter: "database.sqlite.gib-hour", quantity: 48 },
      { meter: "database.sqlite.rows-read.million", quantity: 4 },
      { meter: "database.sqlite.rows-written.million", quantity: 5 },
    ]);
    expect(
      await sources[3]?.read({
        tenantId: "org_test",
        deployment: edgeDeployment("queue:0123456789abcdef"),
        from: "2026-08-18T00:00:00.000Z",
        until: "2026-08-18T01:00:00.000Z",
      }),
    ).toEqual([
      { meter: "messaging.queue.operations.million", quantity: 6 },
      { meter: "messaging.queue.transfer.gib", quantity: 1 },
    ]);
    expect(bodies.map((body) => body.variables)).toEqual([
      {
        accountTag: "account-id",
        start: "2026-08-18T00:00:00.000Z",
        end: "2026-08-18T01:00:00.000Z",
        scriptName: "checkout",
      },
      {
        accountTag: "account-id",
        start: "2026-08-18",
        end: "2026-08-19",
        namespaceId: "0123456789abcdef",
      },
      {
        accountTag: "account-id",
        start: "2026-08-18",
        end: "2026-08-19",
        databaseId: "01234567-89ab-cdef-0123-456789abcdef",
      },
      {
        accountTag: "account-id",
        start: "2026-08-18T00:00:00.000Z",
        end: "2026-08-18T01:00:00.000Z",
        queueId: "0123456789abcdef",
      },
    ]);
  });

  test("fails closed on a partial day or the wrong native resource kind", async () => {
    const sources = createCloudflareEdgeMeterSources({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async () => Response.json({ data: { viewer: { accounts: [{}] } } }),
    });
    await expect(
      sources[1]?.read({
        tenantId: "org_test",
        deployment: edgeDeployment("kv:0123456789abcdef"),
        from: "2026-08-18T01:00:00.000Z",
        until: "2026-08-19T00:00:00.000Z",
      }),
    ).rejects.toThrow("window_invalid");
    await expect(
      sources[0]?.read({
        tenantId: "org_test",
        deployment: edgeDeployment("d1:01234567-89ab-cdef-0123-456789abcdef"),
        from: "2026-08-18T00:00:00.000Z",
        until: "2026-08-18T01:00:00.000Z",
      }),
    ).rejects.toThrow("upstream_invalid");
  });

  test("fails closed on an oversized window or upstream ambiguity", async () => {
    const source = createCloudflareR2MeterSource({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async () => Response.json({ data: { viewer: { accounts: [] } } }),
    });
    await expect(
      source.read({
        tenantId: "org_test",
        deployment: deployment("cloudflare"),
        from: "2026-01-01T00:00:00.000Z",
        until: "2026-08-19T00:00:00.000Z",
      }),
    ).rejects.toThrow("window_invalid");
    await expect(
      source.read({
        tenantId: "org_test",
        deployment: deployment("cloudflare"),
        from: "2026-08-19T00:00:00.000Z",
        until: "2026-08-19T01:00:00.000Z",
      }),
    ).rejects.toThrow("upstream_invalid");
  });
});
