import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareState } from "../scripts/deploy/cloudflare-state.ts";
import { DeployError } from "../scripts/deploy/errors.ts";

const ACCOUNT = "a".repeat(32);

function envelope(
  result: readonly unknown[],
  page: number,
  totalPages: number,
  totalCount: number,
  perPage = 100,
): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: {
      page,
      per_page: perPage,
      count: result.length,
      total_count: totalCount,
      total_pages: totalPages,
    },
  });
}

describe("strict paginated Cloudflare state", () => {
  test("re-authenticates all-zone token authority for every topology scan", async () => {
    const directory = mkdtempSync(join(tmpdir(), "takoserver-topology-audit-"));
    const auditCredentialPath = join(directory, "credential.json");
    const auditToken = "audit-token-value";
    const deploymentToken = "deployment-token-value";
    const auditId = "b".repeat(32);
    const deploymentId = "c".repeat(32);
    const zoneRead = "d".repeat(32);
    const routesRead = "e".repeat(32);
    const routesWrite = "a".repeat(32);
    writeFileSync(
      auditCredentialPath,
      `${JSON.stringify({
        kind: "takoserver.cloudflare-topology-audit-credential@v1",
        deploymentTokenOwner: "user",
        token: auditToken,
      })}\n`,
      { mode: 0o600 },
    );
    let detailReads = 0;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: deploymentToken,
      topologyAuditCredentialPath: auditCredentialPath,
      fetcher: async (request) => {
        const url = new URL(request.url);
        const token = request.headers.get("authorization")?.slice("Bearer ".length);
        if (url.pathname.endsWith("/verify")) {
          return Response.json({
            success: true,
            result: { id: token === auditToken ? auditId : deploymentId, status: "active" },
          });
        }
        if (url.pathname.endsWith("/permission_groups")) {
          return Response.json({
            success: true,
            result: [
              { id: zoneRead, name: "Zone Read", scopes: ["com.cloudflare.api.account.zone"] },
              {
                id: routesRead,
                name: "Workers Routes Read",
                scopes: ["com.cloudflare.api.account.zone"],
              },
              {
                id: routesWrite,
                name: "Workers Routes Write",
                scopes: ["com.cloudflare.api.account.zone"],
              },
            ],
          });
        }
        if (url.pathname.endsWith(`/${deploymentId}`)) {
          detailReads += 1;
          return Response.json({
            success: true,
            result: {
              id: deploymentId,
              status: "active",
              policies: [
                {
                  effect: "allow",
                  resources:
                    detailReads === 1
                      ? {
                          [`com.cloudflare.api.account.${ACCOUNT}`]: {
                            "com.cloudflare.api.account.zone.*": "*",
                          },
                        }
                      : { [`com.cloudflare.api.account.zone.${"f".repeat(32)}`]: "*" },
                  permission_groups: [{ id: zoneRead }, { id: routesRead }],
                },
              ],
            },
          });
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
    });
    try {
      await expect(state.workerTopologyAudit()).resolves.toMatchObject({
        deploymentTokenIdSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      await expect(state.workerTopologyAudit()).rejects.toThrow(
        "token lacks exact all-zone visibility",
      );
      expect(detailReads).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds provider bodies before parsing authoritative topology state", async () => {
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array([0x7b]));
              controller.close();
            },
          }),
          {
            headers: { "content-length": String(32 * 1024 * 1024 + 1) },
          },
        ),
    });

    await expect(state.workerSubdomain("takoserver-sponsorship-authority")).rejects.toThrow(
      "response is too large",
    );
  });

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

  test("reads official Version module bytes only through include=modules", async () => {
    const requests: Request[] = [];
    const version = {
      id: "11111111-1111-4111-8111-111111111111",
      main_module: "worker.js",
      modules: [
        {
          name: "worker.js",
          content_type: "application/javascript+module",
          content_base64: "ZXhwb3J0IGRlZmF1bHQge307Cg==",
        },
      ],
    };
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        return Response.json({ success: true, errors: [], messages: [], result: version });
      },
    });

    expect(
      await state.workerVersionWithModules(
        "takoserver-dispatch",
        "11111111-1111-4111-8111-111111111111",
      ),
    ).toEqual(version);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/workers/takoserver-dispatch/versions/11111111-1111-4111-8111-111111111111`,
    );
    expect(url.search).toBe("?include=modules");
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

  test("reads the documented single-page Worker script inventory without pagination", async () => {
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
          result: [{ id: "worker-b" }, { id: "worker-a" }],
        });
      },
    });

    expect(await state.workerScripts()).toEqual(["worker-a", "worker-b"]);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe(`/client/v4/accounts/${ACCOUNT}/workers/scripts`);
    expect(url.search).toBe("");
  });

  test("rejects malformed or duplicate single-page Worker script inventories", async () => {
    for (const result of [
      { scripts: [] },
      [{ id: "worker-a" }, { id: "worker-a" }],
      [{ id: null }],
    ]) {
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "token",
        fetcher: async () => Response.json({ success: true, result }),
      });
      await expect(state.workerScripts()).rejects.toThrow();
    }
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

  test("reads disabled Worker subdomain state exactly", async () => {
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "token",
      fetcher: async () =>
        Response.json({
          success: true,
          result: { enabled: false, previews_enabled: false },
        }),
    });
    expect(await state.workerSubdomain("takoserver-form-authority")).toEqual({
      enabled: false,
      previewsEnabled: false,
    });
  });

  test("reads the authoritative account workers.dev subdomain exactly", async () => {
    const requests: Request[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "token",
      fetcher: async (request) => {
        requests.push(request);
        return Response.json({ success: true, result: { subdomain: "account-owner" } });
      },
    });
    expect(await state.workerAccountSubdomain()).toBe("account-owner");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/subdomain`,
    );
  });

  test("uses the Zones API limit and reads default plus internal zone routes exhaustively", async () => {
    const requests: Request[] = [];
    const defaultZones = Array.from({ length: 51 }, (_, index) => ({ id: `zone-${index}` }));
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "token",
      fetcher: async (request) => {
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/client/v4/zones") {
          if (url.searchParams.get("type") === "internal") {
            return envelope([{ id: "zone-internal" }], 1, 1, 1, 50);
          }
          const page = Number(url.searchParams.get("page"));
          return page === 1
            ? envelope(defaultZones.slice(0, 50), 1, 2, 51, 50)
            : envelope(defaultZones.slice(50), 2, 2, 51, 50);
        }
        const zoneId = /^\/client\/v4\/zones\/([^/]+)\/workers\/routes$/u.exec(url.pathname)?.[1];
        if (!zoneId) throw new Error(`unexpected request ${url}`);
        return Response.json({
          success: true,
          result:
            zoneId === "zone-50" || zoneId === "zone-internal"
              ? [
                  {
                    id: `route-${zoneId}`,
                    pattern: `${zoneId}.example.test/*`,
                    script: "takoserver-form-authority",
                  },
                ]
              : [],
        });
      },
    });

    expect(await state.workerRoutes()).toHaveLength(2);
    const zoneRequests = requests.filter(
      (request) => new URL(request.url).pathname === "/client/v4/zones",
    );
    expect(zoneRequests).toHaveLength(3);
    expect(
      zoneRequests.every((request) => new URL(request.url).searchParams.get("per_page") === "50"),
    ).toBe(true);
    expect(
      zoneRequests.some((request) => new URL(request.url).searchParams.get("type") === "internal"),
    ).toBe(true);
  });
});
