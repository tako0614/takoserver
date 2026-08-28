import { describe, expect, test } from "bun:test";
import { CloudflareState } from "../scripts/deploy/cloudflare-state.ts";
import { DeployError } from "../scripts/deploy/errors.ts";

const ACCOUNT = "a".repeat(32);

function envelope(
  result: readonly unknown[],
  page: number,
  totalPages: number,
  totalCount: number,
): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: {
      page,
      per_page: 100,
      count: result.length,
      total_count: totalCount,
      total_pages: totalPages,
    },
  });
}

describe("strict paginated Cloudflare state", () => {
  test("reads the closed Worker deployment-history envelope without pagination", async () => {
    const requests: Request[] = [];
    const deployments = [{ id: "deployment-1" }];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: { deployments },
        });
      },
    });

    expect(await state.workerDeployments("takoserver-api-staging")).toEqual(deployments);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/takoserver-api-staging/deployments`,
    );
    expect(url.search).toBe("");
  });

  test("rejects deployment-history responses that are not the exact closed envelope", async () => {
    for (const result of [
      [],
      { deployments: "not-a-list" },
      { deployments: [], result_info: {} },
    ]) {
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "token",
        fetcher: async () => Response.json({ success: true, result }),
      });

      await expect(state.workerDeployments("takoserver-api-staging")).rejects.toThrow(
        "invalid deployment history envelope",
      );
    }
  });

  test("reads the Worker secret inventory array without pagination", async () => {
    const requests: Request[] = [];
    const secrets = [
      { name: "TAKOSERVER_DATABASE_URL", type: "secret_text" },
      { name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" },
      { name: "TAKOSERVER_OIDC_SECRET", type: "secret_text" },
    ];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        return Response.json({ success: true, errors: [], messages: [], result: secrets });
      },
    });

    expect(await state.workerSecrets("takoserver-api-staging")).toEqual(secrets);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/takoserver-api-staging/secrets`,
    );
    expect(url.search).toBe("");
  });

  test("rejects non-array Worker secret inventory results", async () => {
    for (const result of [{ secrets: [] }, null]) {
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "token",
        fetcher: async () => Response.json({ success: true, result }),
      });

      await expect(state.workerSecrets("takoserver-api-staging")).rejects.toThrow(
        "invalid secret inventory result",
      );
    }
  });

  test("derives one pagination page when total_pages is omitted", async () => {
    const entries = Array.from({ length: 28 }, (_, index) => ({ id: `domain-${index}` }));
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async () =>
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: entries,
          result_info: {
            page: 1,
            per_page: 100,
            count: entries.length,
            total_count: entries.length,
          },
        }),
    });

    expect(await state.list("/workers/domains", "domain inventory")).toEqual(entries);
  });

  test("closes an empty paginated result when total_pages is omitted", async () => {
    const requests: Request[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [],
          result_info: { page: 1, per_page: 100, count: 0, total_count: 0 },
        });
      },
    });

    expect(await state.list("/workers/domains", "domain inventory")).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test("rejects a supplied total_pages that disagrees with the derived total", async () => {
    const requests: Request[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [{ id: "domain-1" }],
          result_info: {
            page: 1,
            per_page: 100,
            count: 1,
            total_count: 1,
            total_pages: 2,
          },
        });
      },
    });

    await expect(state.list("/workers/domains", "domain inventory")).rejects.toThrow(
      "invalid pagination metadata",
    );
    expect(requests).toHaveLength(1);
  });

  test("reads every domain page before deciding the exact owner", async () => {
    const requests: Request[] = [];
    const firstPage = [
      { hostname: "elsewhere.example", service: "other" },
      ...Array.from({ length: 99 }, (_, index) => ({
        hostname: `other-${index}.example`,
        service: "other",
      })),
    ];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        const page = new URL(request.url).searchParams.get("page");
        return page === "1"
          ? envelope(firstPage, 1, 2, 101)
          : envelope([{ hostname: "console.example", service: "takoserver-console" }], 2, 2, 101);
      },
    });
    expect(await state.workerDomainOwner("console.example")).toBe("takoserver-console");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => new URL(request.url).searchParams.get("per_page"))).toEqual([
      "100",
      "100",
    ]);
    expect(
      requests.every((request) => request.headers.get("authorization") === "Bearer operator-token"),
    ).toBe(true);
  });

  test("refuses missing pagination metadata and inconsistent totals", async () => {
    const missing = new CloudflareState({
      accountId: ACCOUNT,
      token: "token",
      fetcher: async () => Response.json({ success: true, result: [] }),
    });
    await expect(missing.list("/workers/domains", "domain inventory")).rejects.toThrow(
      "pagination",
    );

    const inconsistent = new CloudflareState({
      accountId: ACCOUNT,
      token: "token",
      fetcher: async () => envelope([], 1, 1, 2),
    });
    await expect(inconsistent.list("/workers/domains", "domain inventory")).rejects.toThrow(
      "total",
    );
  });

  test("refuses duplicate owners and malformed entries", async () => {
    for (const result of [
      [
        { hostname: "console.example", service: "one" },
        { hostname: "console.example", service: "two" },
      ],
      [{ hostname: "console.example", service: null }],
    ]) {
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "token",
        fetcher: async () => envelope(result, 1, 1, result.length),
      });
      const failure = await state.workerDomainOwner("console.example").catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
    }
  });

  test("requires a successful envelope for singular authoritative state", async () => {
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "token",
      fetcher: async () =>
        Response.json({ success: false, errors: [{ code: 10000, message: "authentication" }] }),
    });
    await expect(
      state.read("/workers/scripts/takoserver/settings", "Worker settings"),
    ).rejects.toThrow("failed");
  });
});
