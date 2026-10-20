import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudflareGetResponseError,
  CloudflareGetTransportError,
  readCloudflareGetText,
} from "../scripts/deploy/cloudflare-get.ts";
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
  test("scoped Worker domain proof retains the service filter on every page", async () => {
    const requests: URL[] = [];
    const service = "takoserver-api-integration-money";
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      workerDomainServiceScope: service,
      fetcher: async (request) => {
        const url = new URL(request.url);
        requests.push(url);
        expect(url.pathname).toBe(`/client/v4/accounts/${ACCOUNT}/workers/domains`);
        expect(url.searchParams.get("service")).toBe(service);
        const page = Number(url.searchParams.get("page"));
        return envelope(
          Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
            hostname: `staging-${page}-${index}.example.test`,
            service,
          })),
          page,
          2,
          101,
        );
      },
    });
    expect(await state.workerDomains()).toHaveLength(101);
    expect(requests).toHaveLength(2);
  });

  test("a scoped domain reader rejects foreign services and unfiltered totals without a global retry", async () => {
    const service = "takoserver-api-integration-money";
    for (const inconsistentTotals of [false, true]) {
      const requests: URL[] = [];
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "operator-token",
        workerDomainServiceScope: service,
        fetcher: async (request) => {
          requests.push(new URL(request.url));
          return envelope(
            [
              {
                hostname: "staging.example.test",
                service: inconsistentTotals ? service : "other-service",
              },
            ],
            1,
            1,
            inconsistentTotals ? 2 : 1,
          );
        },
      });
      await expect(state.workerDomains()).rejects.toThrow(
        inconsistentTotals ? "pagination total" : "foreign service",
      );
      expect(requests).toHaveLength(1);
      expect(requests.every((url) => url.searchParams.get("service") === service)).toBe(true);
    }
  });

  test("retries one transient header transport failure with a fresh bounded GET", async () => {
    const requests: Request[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        if (requests.length === 1) throw new TypeError("operator-token must stay private");
        return Response.json({ success: true, result: { enabled: true } });
      },
    });
    expect(await state.read("/workers/subdomain", "subdomain read")).toEqual({ enabled: true });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(requests.every((request) => request.headers.get("connection") === "close")).toBe(true);
    expect(requests[0]?.signal).not.toBe(requests[1]?.signal);
  });

  test("retries body transport failures at most twice, never a fourth attempt", async () => {
    let calls = 0;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      getRetryDelaysMs: [0, 0],
      fetcher: async () => {
        calls += 1;
        if (calls < 4) {
          return new Response(
            new ReadableStream({
              pull() {
                throw new TypeError("operator-token must stay private");
              },
            }),
          );
        }
        return Response.json({ success: true, result: [] });
      },
    });
    let failure: unknown;
    try {
      await state.read("/workers/scripts", "script read");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CloudflareGetTransportError);
    expect((failure as CloudflareGetTransportError).status).toBe(200);
    expect(JSON.stringify(failure)).not.toContain("operator-token");
    expect((failure as DeployError).reason).toEqual({
      code: "http-transport",
      operation: "provider-read",
      attempts: 3,
    });
    expect(calls).toBe(3);
  });

  test("retries a body transport failure and accepts the second complete envelope", async () => {
    let calls = 0;
    let firstBody: ReadableStream<Uint8Array> | undefined;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async () => {
        calls += 1;
        if (calls === 1) {
          firstBody = new ReadableStream({
            pull: () => {
              throw new TypeError("broken stream");
            },
          });
          return new Response(firstBody);
        }
        return Response.json({ success: true, result: { ready: true } });
      },
    });
    expect(await state.read("/workers/scripts", "script read")).toEqual({ ready: true });
    expect(calls).toBe(2);
    expect(firstBody?.locked).toBe(false);
  });

  test("returns the first healthy GET without retry and does not retry arbitrary callback errors", async () => {
    let calls = 0;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async () => {
        calls += 1;
        return Response.json({ success: true, result: true });
      },
    });
    expect(await state.read("/workers/scripts", "script read")).toBe(true);
    expect(calls).toBe(1);
    await expect(
      readCloudflareGetText({
        fetcher: async () => {
          calls += 1;
          throw new Error("semantic callback failure");
        },
        request: (signal) =>
          new Request("https://api.cloudflare.com/client/v4/test", { redirect: "manual", signal }),
        maximumBytes: 1024,
        label: "direct GET",
      }),
    ).rejects.toThrow("direct GET transport failed");
    expect(calls).toBe(2);
  });

  test("redacts a forged DOMException name without retrying it", async () => {
    let calls = 0;
    let failure: unknown;
    try {
      await readCloudflareGetText({
        fetcher: async () => {
          calls += 1;
          throw new DOMException("failed", "forged-secret-bearing-name");
        },
        request: (signal) =>
          new Request("https://api.cloudflare.com/client/v4/test", { redirect: "manual", signal }),
        maximumBytes: 1024,
        label: "direct GET",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CloudflareGetTransportError);
    expect((failure as CloudflareGetTransportError).detail).toBe("TransportError");
    expect(JSON.stringify(failure)).not.toContain("forged-secret-bearing-name");
    expect(calls).toBe(1);
  });

  test("does not retry a locally locked response body", async () => {
    let calls = 0;
    const body = new ReadableStream<Uint8Array>();
    const response = new Response(body);
    const lock = body.getReader();
    try {
      await expect(
        readCloudflareGetText({
          fetcher: async () => {
            calls += 1;
            return response;
          },
          request: (signal) =>
            new Request("https://api.cloudflare.com/client/v4/test", {
              redirect: "manual",
              signal,
            }),
          maximumBytes: 1024,
          label: "direct GET",
        }),
      ).rejects.toBeInstanceOf(CloudflareGetResponseError);
      expect(calls).toBe(1);
    } finally {
      await lock.cancel();
      lock.releaseLock();
    }
  });

  test("cancels an over-limit body and does not retry it", async () => {
    let calls = 0;
    let cancelled = 0;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async () => {
        calls += 1;
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled += 1;
            },
          }),
        );
      },
    });
    await expect(state.read("/workers/scripts", "script read")).rejects.toThrow(
      "response is too large",
    );
    expect(calls).toBe(1);
    expect(cancelled).toBe(1);
  });

  test("preserves safe HTTP status on semantic body-cap failures", async () => {
    let failure: unknown;
    let calls = 0;
    try {
      await readCloudflareGetText({
        retryDelaysMs: [0, 0],
        fetcher: async () => {
          calls += 1;
          return new Response("", {
            status: 503,
            headers: { "content-length": "1025" },
          });
        },
        request: (signal) =>
          new Request("https://api.cloudflare.com/client/v4/test", {
            redirect: "manual",
            signal,
          }),
        maximumBytes: 1024,
        label: "direct GET",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CloudflareGetResponseError);
    expect((failure as CloudflareGetResponseError).status).toBe(503);
    // The 503 is read again within its bound; the last answer is judged.
    expect(calls).toBe(3);
  });

  test("a refusal whose body transport breaks is judged once", async () => {
    let calls = 0;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      getRetryDelaysMs: [0, 0],
      fetcher: async () => {
        calls += 1;
        return new Response(
          new ReadableStream({
            pull: () => {
              throw new TypeError("body failed");
            },
          }),
          { status: 403 },
        );
      },
    });
    await expect(state.read("/workers/scripts", "script read")).rejects.toBeInstanceOf(
      CloudflareGetTransportError,
    );
    expect(calls).toBe(1);
  });

  test("preserves a caller's explicit UTF-8 BOM decoding mode", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    const common = {
      fetcher: async () => new Response(bytes),
      request: (signal: AbortSignal) =>
        new Request("https://api.cloudflare.com/client/v4/test", {
          redirect: "manual",
          signal,
        }),
      maximumBytes: 1024,
      label: "direct GET",
    };
    expect((await readCloudflareGetText(common)).text).toBe("{}");
    expect((await readCloudflareGetText({ ...common, ignoreBOM: true })).text).toBe("\ufeff{}");
  });

  test("bounds a stalled body, releases it, and retries", async () => {
    let calls = 0;
    let cancelled = 0;
    const started = performance.now();
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      getRetryDelaysMs: [0, 0],
      fetcher: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            new ReadableStream({
              pull: () => new Promise<void>(() => undefined),
              cancel: () => {
                cancelled += 1;
              },
            }),
          );
        }
        return Response.json({ success: true, result: "recovered" });
      },
    });
    expect(await state.read("/workers/scripts", "script read")).toBe("recovered");
    expect(calls).toBe(2);
    expect(cancelled).toBe(1);
    expect(performance.now() - started).toBeLessThan(15_500);
  }, 20_000);

  test("does not retry a refusal, redirect, malformed JSON, invalid UTF-8 or oversized body", async () => {
    const responses = [
      Response.json({ success: false, errors: [] }, { status: 401 }),
      Response.json({ success: false, errors: [] }, { status: 403 }),
      Response.json({ success: false, errors: [] }, { status: 404 }),
      Response.redirect("https://example.invalid", 302),
      new Response("not-json"),
      new Response(new Uint8Array([0xff])),
      new Response("", { headers: { "content-length": String(32 * 1024 * 1024 + 1) } }),
    ];
    for (const response of responses) {
      let calls = 0;
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "operator-token",
        getRetryDelaysMs: [0, 0],
        fetcher: async () => {
          calls += 1;
          return response;
        },
      });
      await expect(state.read("/workers/scripts", "script read")).rejects.toBeInstanceOf(
        DeployError,
      );
      expect(calls).toBe(1);
    }
  });

  test("reads HTTP 429 and 5xx again at most twice, then judges the last answer", async () => {
    for (const status of [429, 500, 502, 503]) {
      let calls = 0;
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "operator-token",
        getRetryDelaysMs: [0, 0],
        fetcher: async () => {
          calls += 1;
          return Response.json(
            { success: false, errors: [] },
            { status, headers: { "retry-after": "0" } },
          );
        },
      });
      let failure: unknown;
      try {
        await state.read("/workers/scripts", "script read");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DeployError);
      expect((failure as DeployError).reason).toEqual({
        code: "http-status",
        operation: "provider-read",
        attempts: 3,
      });
      expect(calls).toBe(3);
    }
    let recovered = 0;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      getRetryDelaysMs: [0, 0],
      fetcher: async () => {
        recovered += 1;
        return recovered === 1
          ? new Response("<html>bad gateway</html>", { status: 502 })
          : Response.json({ success: true, result: "recovered" });
      },
    });
    expect(await state.read("/workers/scripts", "script read")).toBe("recovered");
    expect(recovered).toBe(2);
  });

  test("judges a failed HTTP response once its retries are spent, even if its body breaks", async () => {
    let calls = 0;
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      getRetryDelaysMs: [0, 0],
      fetcher: async () => {
        calls += 1;
        return new Response(
          new ReadableStream({
            pull: () => {
              throw new TypeError("body failed");
            },
          }),
          { status: 500 },
        );
      },
    });
    await expect(state.read("/workers/scripts", "script read")).rejects.toBeInstanceOf(
      CloudflareGetTransportError,
    );
    expect(calls).toBe(3);
  });
  test("uses Pages-compatible page size and reads the complete deployment history", async () => {
    const deployments = Array.from({ length: 22 }, (_, index) => ({ id: `deployment-${index}` }));
    const requests: URL[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        const url = new URL(request.url);
        requests.push(url);
        if (url.searchParams.get("per_page") !== "20") {
          return Response.json(
            {
              success: false,
              errors: [{ code: 8000024, message: "Invalid list options provided." }],
            },
            { status: 400 },
          );
        }
        const page = Number(url.searchParams.get("page"));
        return envelope(deployments.slice((page - 1) * 20, page * 20), page, 2, 22, 20);
      },
    });

    expect(await state.pagesDeployments("takoserver-website")).toEqual(deployments);
    expect(requests.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(requests.every((url) => url.searchParams.get("per_page") === "20")).toBe(true);
    expect(requests[0]?.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/pages/projects/takoserver-website/deployments`,
    );
  });

  test("reads Worker-local cron triggers without inventing pagination or Version metadata", async () => {
    const requests: Request[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        return Response.json({
          success: true,
          result: { schedules: [{ cron: "*/5 * * * *", created_on: "2026-09-12T00:00:00Z" }] },
        });
      },
    });
    expect(await state.workerSchedules("takoserver-api-integration")).toEqual(["*/5 * * * *"]);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/takoserver-api-integration/schedules`,
    );
    expect(url.search).toBe("");
  });

  test("schedule inventory distinguishes empty from malformed or duplicate results", async () => {
    const stateFor = (result: unknown) =>
      new CloudflareState({
        accountId: ACCOUNT,
        token: "operator-token",
        fetcher: async () => Response.json({ success: true, result }),
      });
    expect(await stateFor({ schedules: [] }).workerSchedules("host")).toEqual([]);
    for (const result of [
      {},
      { schedules: null },
      { schedules: [null] },
      { schedules: [{ cron: 1 }] },
      { schedules: [{ cron: "" }] },
      { schedules: [{ cron: " */5 * * * *" }] },
      { schedules: [{ cron: "*/5 * * * *" }, { cron: "*/5 * * * *" }] },
    ]) {
      await expect(stateFor(result).workerSchedules("host")).rejects.toBeInstanceOf(DeployError);
    }
  });

  test("Worker Versions unwrap result.items and retain exhaustive pagination checks", async () => {
    const versions = Array.from({ length: 101 }, (_, index) => ({ id: `version-${index}` }));
    const pages: number[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        const url = new URL(request.url);
        expect(url.pathname).toBe(
          `/client/v4/accounts/${ACCOUNT}/workers/scripts/executor/versions`,
        );
        expect(url.searchParams.has("deployable")).toBe(false);
        const page = Number(url.searchParams.get("page"));
        expect(url.searchParams.get("per_page")).toBe("100");
        pages.push(page);
        const items = versions.slice((page - 1) * 100, page * 100);
        return Response.json({
          success: true,
          result: { items },
          result_info: { page, per_page: 100, count: items.length, total_count: versions.length },
        });
      },
    });
    expect(await state.workerVersions("executor")).toEqual(versions);
    expect(pages).toEqual([1, 2]);
  });

  test("Worker Versions reject missing items, an array envelope and inconsistent totals", async () => {
    for (const [result, resultInfo] of [
      [{}, { page: 1, per_page: 100, count: 0, total_count: 0 }],
      [[], { page: 1, per_page: 100, count: 0, total_count: 0 }],
      [{ items: [] }, { page: 1, per_page: 100, count: 1, total_count: 1 }],
      [{ items: [{ id: "version-1" }] }, { page: 1, per_page: 100, count: 1, total_count: 2 }],
    ]) {
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "operator-token",
        fetcher: async () => Response.json({ success: true, result, result_info: resultInfo }),
      });
      await expect(state.workerVersions("executor")).rejects.toBeInstanceOf(DeployError);
    }
  });

  test("reads one dispatch namespace by exact name and recognizes only error 100119 as absent", async () => {
    const requests: Request[] = [];
    const metadata = {
      namespace_id: "f174e90a-fafe-4643-bbbc-4a0ed4fc8415",
      namespace_name: "takoserver-customers",
    };
    let response = Response.json({ success: true, result: metadata });
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "operator-token",
      fetcher: async (request) => {
        requests.push(request);
        return response;
      },
    });

    expect(await state.dispatchNamespace("takoserver-customers")).toEqual(metadata);
    response = Response.json(
      { success: false, result: null, errors: [{ code: 100119, message: "not found" }] },
      { status: 404 },
    );
    expect(await state.dispatchNamespace("takoserver-customers")).toBeNull();
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/takoserver-customers`,
    );
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.headers.get("connection") === "close")).toBe(true);
  });

  test("never converts auth, unknown, false-result or malformed namespace responses to absence", async () => {
    for (const response of [
      Response.json(
        { success: false, result: null, errors: [{ code: 100119, message: "forged" }] },
        { status: 403 },
      ),
      Response.json(
        { success: false, result: null, errors: [{ code: 100120, message: "unknown" }] },
        { status: 404 },
      ),
      Response.json({ success: true, result: false }),
      new Response("not-json", { status: 404 }),
    ]) {
      const state = new CloudflareState({
        accountId: ACCOUNT,
        token: "operator-token",
        fetcher: async () => response,
      });
      await expect(state.dispatchNamespace("takoserver-customers")).rejects.toBeInstanceOf(
        DeployError,
      );
    }
  });

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
    const auditRequests: Request[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: deploymentToken,
      topologyAuditCredentialPath: auditCredentialPath,
      fetcher: async (request) => {
        auditRequests.push(request);
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
      expect(auditRequests.length).toBeGreaterThan(0);
      expect(auditRequests.every((request) => request.headers.get("connection") === "close")).toBe(
        true,
      );
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

  test("treats only the exact missing-Worker deployment response as an empty history", async () => {
    const missing = Response.json(
      {
        success: false,
        result: null,
        errors: [{ code: 10007, message: "Worker not found" }],
        messages: [],
      },
      { status: 404 },
    );
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "token",
      fetcher: async () => missing,
    });
    await expect(state.workerDeployments("takoserver-api-staging")).resolves.toEqual([]);

    for (const response of [
      Response.json(
        {
          success: false,
          result: null,
          errors: [{ code: 10007 }],
          messages: [],
        },
        { status: 403 },
      ),
      Response.json(
        {
          success: false,
          result: null,
          errors: [{ code: 10008 }],
          messages: [],
        },
        { status: 404 },
      ),
      new Response("not-json", { status: 404 }),
      Response.json(
        {
          success: false,
          result: { deployments: [] },
          errors: [{ code: 10007 }],
          messages: [],
        },
        { status: 404 },
      ),
    ]) {
      const negative = new CloudflareState({
        accountId: ACCOUNT,
        token: "token",
        fetcher: async () => response,
      });
      await expect(negative.workerDeployments("takoserver-api-staging")).rejects.toBeInstanceOf(
        DeployError,
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

  test("reads independent healthy account state requests without pooled connections", async () => {
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
    expect(await state.workerAccountSubdomain()).toBe("account-owner");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.headers.get("connection") === "close")).toBe(true);
  });

  test("uses the Zones API limit and reads default plus internal zone routes exhaustively", async () => {
    const requests: Request[] = [];
    const defaultZones = Array.from({ length: 51 }, (_, index) => ({ id: `zone-${index}` }));
    let inFlightRoutes = 0;
    let maxInFlightRoutes = 0;
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
        inFlightRoutes += 1;
        maxInFlightRoutes = Math.max(maxInFlightRoutes, inFlightRoutes);
        await Bun.sleep(zoneId === "zone-internal" ? 1 : 2 + (Number(zoneId.slice(5)) % 3));
        inFlightRoutes -= 1;
        return Response.json({
          success: true,
          result: [
            {
              id: `route-${zoneId}`,
              pattern: `${zoneId}.example.test/*`,
              script: "takoserver-form-authority",
            },
          ],
        });
      },
    });

    expect(await state.workerRoutes()).toEqual(
      [...defaultZones.map(({ id }) => id), "zone-internal"].sort().map((zoneId) => ({
        zoneId,
        id: `route-${zoneId}`,
        pattern: `${zoneId}.example.test/*`,
        script: "takoserver-form-authority",
      })),
    );
    expect(maxInFlightRoutes).toBeLessThanOrEqual(4);
    expect(requests.every((request) => request.headers.get("connection") === "close")).toBe(true);
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

  test("fails the whole route inventory when one zone route read fails", async () => {
    const routeReads: string[] = [];
    const state = new CloudflareState({
      accountId: ACCOUNT,
      token: "token",
      getRetryDelaysMs: [0, 0],
      fetcher: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/client/v4/zones") {
          return envelope(
            url.searchParams.get("type") === "internal"
              ? [{ id: "zone-internal" }]
              : Array.from({ length: 4 }, (_, index) => ({ id: `zone-${index}` })),
            1,
            1,
            url.searchParams.get("type") === "internal" ? 1 : 4,
            50,
          );
        }
        const zoneId = /^\/client\/v4\/zones\/([^/]+)\/workers\/routes$/u.exec(url.pathname)?.[1];
        if (!zoneId) throw new Error(`unexpected request ${url}`);
        routeReads.push(zoneId);
        return zoneId === "zone-1"
          ? Response.json({ success: false, errors: [{ code: 1 }] }, { status: 503 })
          : Response.json({ success: true, result: [] });
      },
    });

    await expect(state.workerRoutes()).rejects.toBeInstanceOf(DeployError);
    // The 503 read is repeated within its bound, then the whole inventory fails.
    expect(routeReads.filter((zoneId) => zoneId === "zone-1")).toHaveLength(3);
  });
});
