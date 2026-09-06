import { describe, expect, test } from "bun:test";
import { CloudflareWfpClient } from "../src/providers/cloudflare-wfp-client.ts";

const API = "https://api.cloudflare.test/client/v4";
const NAMESPACE = "customers-integration";
const SCRIPT = "tsr-release";
const PATH = `/accounts/account-id/workers/dispatch/namespaces/${NAMESPACE}/scripts/${SCRIPT}`;

function fixture(responses: readonly (Response | Error)[]) {
  const requests: Request[] = [];
  const client = new CloudflareWfpClient({
    accountId: "account-id",
    dispatchNamespace: NAMESPACE,
    apiOrigin: API,
    authorize: () => "Bearer fixture-token",
    async fetch(request) {
      requests.push(request);
      const response = responses[requests.length - 1];
      if (!response) throw new Error("unexpected provider request");
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { client, requests };
}

function envelope(result: unknown): Response {
  return Response.json({ success: true, result });
}

describe("Cloudflare WfP exact script absence", () => {
  test("accepts a direct metadata 404 without a second lookup", async () => {
    const { client, requests } = fixture([new Response(null, { status: 404 })]);

    expect(await client.scriptAbsent(SCRIPT)).toEqual({ ok: true, status: 404, value: true });
    expect(requests.map((request) => request.url)).toEqual([`${API}${PATH}`]);
  });

  test("reports an exact script with its etag as present without a second lookup", async () => {
    const { client, requests } = fixture([
      envelope({ dispatch_namespace: NAMESPACE, script: { id: SCRIPT, etag: "etag" } }),
    ]);

    expect(await client.scriptAbsent(SCRIPT)).toEqual({ ok: true, status: 200, value: false });
    expect(requests.map((request) => request.url)).toEqual([`${API}${PATH}`]);
  });

  test("accepts an exact present script when optional namespace metadata is omitted", async () => {
    const { client, requests } = fixture([envelope({ script: { id: SCRIPT, etag: "etag" } })]);

    expect(await client.scriptAbsent(SCRIPT)).toEqual({ ok: true, status: 200, value: false });
    expect(requests.map((request) => request.url)).toEqual([`${API}${PATH}`]);
  });

  test("confirms an explicit null script through the same script settings 404", async () => {
    // Observed provider wire shape: the parent returns the namespace metadata
    // with HTTP 200 and script:null even when no script exists under that name.
    const { client, requests } = fixture([
      envelope({ dispatch_namespace: NAMESPACE, script: null }),
      Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 }),
    ]);

    expect(await client.scriptAbsent(SCRIPT)).toEqual({ ok: true, status: 404, value: true });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `${API}${PATH}`],
      ["GET", `${API}${PATH}/settings`],
    ]);
  });

  test.each([
    ["wrong namespace", { dispatch_namespace: "other-customers", script: null }],
    [
      "wrong namespace for a present script",
      { dispatch_namespace: "other-customers", script: { id: SCRIPT, etag: "etag" } },
    ],
    ["null namespace", { dispatch_namespace: null, script: { id: SCRIPT, etag: "etag" } }],
    ["missing namespace", { script: null }],
    ["missing script", { dispatch_namespace: NAMESPACE }],
    ["wrong script type", { dispatch_namespace: NAMESPACE, script: false }],
    [
      "wrong script identity",
      { dispatch_namespace: NAMESPACE, script: { id: "other-script", etag: "etag" } },
    ],
    ["missing etag", { dispatch_namespace: NAMESPACE, script: { id: SCRIPT } }],
    ["null result", null],
  ])("does not infer presence or absence from %s", async (_label, result) => {
    const { client, requests } = fixture([envelope(result)]);

    expect(await client.scriptAbsent(SCRIPT)).toEqual({
      ok: false,
      status: 200,
      indeterminate: false,
      malformed: true,
    });
    expect(requests.map((request) => request.url)).toEqual([`${API}${PATH}`]);
  });

  test.each([401, 403, 429, 500, 503])(
    "preserves a settings %i as a failure, never absence",
    async (status) => {
      const { client, requests } = fixture([
        envelope({ dispatch_namespace: NAMESPACE, script: null }),
        new Response(null, { status }),
      ]);

      expect(await client.scriptAbsent(SCRIPT)).toEqual({
        ok: false,
        status,
        indeterminate: false,
      });
      expect(requests.map((request) => request.url)).toEqual([
        `${API}${PATH}`,
        `${API}${PATH}/settings`,
      ]);
    },
  );

  test("preserves a settings transport failure as a failure, never absence", async () => {
    const { client, requests } = fixture([
      envelope({ dispatch_namespace: NAMESPACE, script: null }),
      new Error("provider transport failed"),
    ]);

    expect(await client.scriptAbsent(SCRIPT)).toEqual({
      ok: false,
      status: 0,
      indeterminate: false,
    });
    expect(requests.map((request) => request.url)).toEqual([
      `${API}${PATH}`,
      `${API}${PATH}/settings`,
    ]);
  });

  test.each([
    ["settings exist", () => envelope({ bindings: [] })],
    ["settings result null", () => envelope(null)],
    ["malformed settings", () => new Response("not JSON")],
    ["empty settings", () => new Response(null, { status: 204 })],
  ])("does not resolve contradictory null script when %s", async (_label, response) => {
    const fallback = response();
    const { client, requests } = fixture([
      envelope({ dispatch_namespace: NAMESPACE, script: null }),
      fallback,
    ]);

    expect(await client.scriptAbsent(SCRIPT)).toEqual({
      ok: false,
      status: fallback.status,
      indeterminate: false,
      malformed: true,
    });
    expect(requests.map((request) => request.url)).toEqual([
      `${API}${PATH}`,
      `${API}${PATH}/settings`,
    ]);
  });
});
