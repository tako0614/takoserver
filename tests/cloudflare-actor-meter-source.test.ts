import { describe, expect, test } from "bun:test";
import type { ProviderMeterDeployment } from "../src/provider-meter-port.ts";
import { createCloudflareActorNamespaceMetricsReader } from "../src/providers/cloudflare-actor-meter-source.ts";

const namespaceId = "0123456789abcdef0123456789abcdef";
const deployment: ProviderMeterDeployment = {
  tenantId: "org_test",
  id: "dep_actor",
  resourceUid: "res_actor",
  offeringId: "compute.actor.test",
  providerPackRef: "cloudflare",
  providerInstallationRef: "cloudflare.test",
  nativeId: `actor:${namespaceId}`,
  createdAt: "2026-09-27T00:00:00.000Z",
};
const from = "2026-09-27T00:00:00.000Z";
const until = "2026-09-27T01:00:00.000Z";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            durableObjectsInvocationsAdaptiveGroups: [
              { dimensions: { namespaceId }, sum: { requests: 10 } },
              { dimensions: { namespaceId }, sum: { requests: "12" } },
            ],
            durableObjectsPeriodicGroups: [
              {
                dimensions: { namespaceId },
                sum: { duration: 1.25, rowsRead: 20, rowsWritten: "3" },
              },
              {
                dimensions: { namespaceId },
                sum: { duration: 0.75, rowsRead: "4", rowsWritten: 5 },
              },
            ],
            ...overrides,
          },
        ],
      },
    },
  };
}

describe("Cloudflare Actor namespace metric observation reader", () => {
  test("reads per-window namespace requests, duration, and SQLite row counts in upstream units", async () => {
    let request: Request | undefined;
    const reader = createCloudflareActorNamespaceMetricsReader({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async (input) => {
        request = input;
        return Response.json(payload());
      },
    });

    await expect(reader.read({ deployment, from, until })).resolves.toEqual({
      namespaceId,
      window: { from, until },
      requests: { value: 22, unit: "requests" },
      duration: { value: 2, unit: "GB*s" },
      rowsRead: { value: 24, unit: "rows" },
      rowsWritten: { value: 8, unit: "rows" },
    });
    expect(request?.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(request?.headers.get("authorization")).toBe("Bearer provider-token");
    const body = (await request?.clone().json()) as { query: string; variables: unknown };
    expect(body.variables).toEqual({
      accountTag: "account-id",
      namespaceId,
      start: from,
      end: until,
    });
    expect(body.query).toContain(
      "namespaceId: $namespaceId, datetime_geq: $start, datetime_lt: $end",
    );
    expect(body.query).toContain("sum { duration rowsRead rowsWritten }");
    expect(body.query).not.toContain("durableObjectsStorageGroups");
  });

  test("rejects wrong provider/native identity and unbounded or noncanonical windows", async () => {
    const reader = createCloudflareActorNamespaceMetricsReader({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async () => Response.json(payload()),
    });
    await expect(
      reader.read({
        deployment: { ...deployment, nativeId: `worker:${namespaceId}` },
        from,
        until,
      }),
    ).rejects.toThrow("upstream_invalid");
    await expect(
      reader.read({ deployment: { ...deployment, providerPackRef: "other" }, from, until }),
    ).rejects.toThrow("upstream_invalid");
    await expect(reader.read({ deployment, from: "2026-09-27T00:00:00Z", until })).rejects.toThrow(
      "window_invalid",
    );
    await expect(
      reader.read({
        deployment,
        from: "2026-08-01T00:00:00.000Z",
        until: "2026-09-27T00:00:00.000Z",
      }),
    ).rejects.toThrow("window_invalid");
  });

  test("rejects partial, malformed, truncated, and identity-mixed upstream data", async () => {
    const replies = [
      { ...payload(), errors: [{ message: "private upstream text must not escape" }] },
      payload({ durableObjectsPeriodicGroups: undefined }),
      payload({
        durableObjectsPeriodicGroups: [
          {
            dimensions: { namespaceId: "ffffffffffffffffffffffffffffffff" },
            sum: { duration: 1, rowsRead: 1, rowsWritten: 1 },
          },
        ],
      }),
      payload({
        durableObjectsInvocationsAdaptiveGroups: [
          { dimensions: { namespaceId }, sum: { requests: Number.MAX_SAFE_INTEGER + 1 } },
        ],
      }),
    ];
    for (const reply of replies) {
      const reader = createCloudflareActorNamespaceMetricsReader({
        accountId: "account-id",
        apiToken: "provider-token",
        fetch: async () => Response.json(reply),
      });
      await expect(reader.read({ deployment, from, until })).rejects.toThrow();
    }

    const erroredReader = createCloudflareActorNamespaceMetricsReader({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async () =>
        Response.json({
          ...payload(),
          errors: [{ message: "private upstream text must not escape" }],
        }),
    });
    await expect(erroredReader.read({ deployment, from, until })).rejects.toThrow(
      "upstream_unavailable",
    );

    const reader = createCloudflareActorNamespaceMetricsReader({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async () => new Response("not-json"),
    });
    await expect(reader.read({ deployment, from, until })).rejects.toThrow();
  });
});
