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
  test("reads every domain page before deciding the exact owner", async () => {
    const requests: Request[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        const page = new URL(request.url).searchParams.get("page");
        return page === "1"
          ? envelope([{ hostname: "elsewhere.example", service: "other" }], 1, 2, 2)
          : envelope([{ hostname: "console.example", service: "takoserver-console" }], 2, 2, 2);
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
