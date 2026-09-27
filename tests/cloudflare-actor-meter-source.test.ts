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
              { dimensions: { namespaceId }, sum: { requests: 22 } },
            ],
            durableObjectsPeriodicGroups: [
              {
                dimensions: { namespaceId },
                sum: { duration: 2, rowsRead: 24, rowsWritten: 8 },
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
      finality: "unfinalized",
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
    expect(body.query).toContain("AdaptiveGroups(limit: 2");
    expect(body.query).not.toContain("durableObjectsStorageGroups");
  });

  test("returns explicitly unfinalized zero observations for empty windows", async () => {
    const reader = createCloudflareActorNamespaceMetricsReader({
      accountId: "account-id",
      apiToken: "provider-token",
      fetch: async () =>
        Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  durableObjectsInvocationsAdaptiveGroups: [],
                  durableObjectsPeriodicGroups: [],
                },
              ],
            },
          },
        }),
    });

    await expect(reader.read({ deployment, from, until })).resolves.toEqual({
      namespaceId,
      window: { from, until },
      finality: "unfinalized",
      requests: { value: 0, unit: "requests" },
      duration: { value: 0, unit: "GB*s" },
      rowsRead: { value: 0, unit: "rows" },
      rowsWritten: { value: 0, unit: "rows" },
    });
  });

  test("accepts GraphQL success envelopes with errors absent, null, or empty", async () => {
    for (const errors of [undefined, null, []]) {
      const reply = payload();
      if (errors !== undefined) Object.assign(reply, { errors });
      const reader = createCloudflareActorNamespaceMetricsReader({
        accountId: "account-id",
        apiToken: "provider-token",
        fetch: async () => Response.json(reply),
      });
      await expect(reader.read({ deployment, from, until })).resolves.toMatchObject({
        finality: "unfinalized",
        requests: { value: 22 },
      });
    }
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

  test("rejects partial, duplicate, malformed, and identity-mixed upstream data", async () => {
    const replies = [
      { ...payload(), errors: [{ message: "private upstream text must not escape" }] },
      { ...payload(), errors: { message: "malformed error envelope" } },
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
          { dimensions: { namespaceId }, sum: { requests: 1 } },
          { dimensions: { namespaceId }, sum: { requests: 2 } },
        ],
      }),
      payload({
        durableObjectsInvocationsAdaptiveGroups: [
          { dimensions: { namespaceId }, sum: { requests: "9007199254740992" } },
        ],
      }),
      payload({
        durableObjectsPeriodicGroups: [
          {
            dimensions: { namespaceId },
            sum: { duration: 1, rowsRead: Number.MAX_SAFE_INTEGER + 1, rowsWritten: 0 },
          },
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

  test("bounds oversized responses and sanitizes HTTP and network failures", async () => {
    const makeReader = (fetch: (request: Request) => Promise<Response>) =>
      createCloudflareActorNamespaceMetricsReader({
        accountId: "account-id",
        apiToken: "provider-token",
        fetch,
      });

    const oversized = makeReader(async () => new Response("x".repeat(262_145)));
    await expect(oversized.read({ deployment, from, until })).rejects.toMatchObject({
      code: "upstream_invalid",
      message: "upstream_invalid",
    });

    const httpFailure = makeReader(async () =>
      Response.json({ error: "sensitive provider response" }, { status: 503 }),
    );
    await expect(httpFailure.read({ deployment, from, until })).rejects.toMatchObject({
      code: "upstream_unavailable",
      message: "upstream_unavailable",
    });

    const networkFailure = makeReader(async () => {
      throw new Error("sensitive transport diagnostic");
    });
    await expect(networkFailure.read({ deployment, from, until })).rejects.toMatchObject({
      code: "upstream_unavailable",
      message: "upstream_unavailable",
    });
    await expect(networkFailure.read({ deployment, from, until })).rejects.not.toThrow(
      "sensitive transport diagnostic",
    );
  });

  test("bounds stalled fetches and bodies, aborts transport, and accepts caller cancellation", async () => {
    const watchdog = async (promise: Promise<unknown>) =>
      Promise.race([
        promise.then(
          () => null,
          (error) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve("stalled"), 100)),
      ]);
    let fetchCalls = 0;
    let fetchSignal: AbortSignal | undefined;
    const stalledFetch = createCloudflareActorNamespaceMetricsReader({
      accountId: "account-id",
      apiToken: "provider-token",
      timeoutMs: 5,
      fetch: async (request) => {
        fetchCalls += 1;
        fetchSignal = request.signal;
        return await new Promise<Response>(() => undefined);
      },
    });
    const fetchFailure = await watchdog(stalledFetch.read({ deployment, from, until }));
    expect(fetchFailure).toMatchObject({ code: "upstream_unavailable" });
    expect(fetchSignal?.aborted).toBe(true);
    expect(fetchCalls).toBe(1);

    let bodySignal: AbortSignal | undefined;
    let bodyCancelCalled = false;
    const stalledBody = createCloudflareActorNamespaceMetricsReader({
      accountId: "account-id",
      apiToken: "provider-token",
      timeoutMs: 5,
      fetch: async (request) => {
        bodySignal = request.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
            cancel: () => {
              bodyCancelCalled = true;
              return new Promise<void>(() => undefined);
            },
          }),
        );
      },
    });
    const bodyFailure = await watchdog(stalledBody.read({ deployment, from, until }));
    expect(bodyFailure).toMatchObject({ code: "upstream_unavailable" });
    expect(bodySignal?.aborted).toBe(true);
    expect(bodyCancelCalled).toBe(true);

    const caller = new AbortController();
    let callerSignal: AbortSignal | undefined;
    const callerCancelled = createCloudflareActorNamespaceMetricsReader({
      accountId: "account-id",
      apiToken: "provider-token",
      timeoutMs: 5_000,
      fetch: async (request) => {
        callerSignal = request.signal;
        return await new Promise<Response>(() => undefined);
      },
    });
    const callerRead = callerCancelled.read({ deployment, from, until, signal: caller.signal });
    caller.abort();
    const callerFailure = await watchdog(callerRead);
    expect(callerFailure).toMatchObject({ code: "upstream_unavailable" });
    expect(callerSignal?.aborted).toBe(true);
  });
});
