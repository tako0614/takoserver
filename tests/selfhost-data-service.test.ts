import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SELFHOST_WORKER_DATA_PLANE_BINDING,
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
  selfhostDataServiceSource,
} from "../src/providers/selfhost-data-service.ts";
import {
  SELFHOST_DATA_PLANE_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_ORIGIN,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_VECTOR_PATH,
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
} from "../src/providers/selfhost-worker-wrapper.ts";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("the generated data service allowlists Vector and forwards its exact body length", async () => {
  root = await mkdtemp(join(tmpdir(), "takoserver-selfhost-data-service-"));
  await Bun.write(join(root, SELFHOST_WORKER_DATA_SERVICE_MODULE), selfhostDataServiceSource());
  const loaded = (await import(
    `${pathToFileURL(join(root, SELFHOST_WORKER_DATA_SERVICE_MODULE)).href}?test=${crypto.randomUUID()}`
  )) as {
    readonly default: {
      fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
    };
  };
  const payload = JSON.stringify({
    protocol: SELFHOST_DATA_PLANE_PROTOCOL,
    binding: "SEARCH",
    op: "get",
    input: { namespace: "docs", ids: ["one"] },
  });
  const bytes = new TextEncoder().encode(payload);
  let forwardedUrl: string | undefined;
  let forwardedInit: RequestInit | undefined;
  const env = {
    [SELFHOST_WORKER_DATA_TOKEN_BINDING]: "private-plane-token",
    [SELFHOST_WORKER_DATA_PLANE_BINDING]: {
      async fetch(url: string, init: RequestInit): Promise<Response> {
        forwardedUrl = url;
        forwardedInit = init;
        return new Response(JSON.stringify({ ok: true, value: { vectors: [] } }), {
          headers: { "content-type": "application/json", "x-plane-secret": "not-forwarded" },
        });
      },
    },
  };
  const request = new Request(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_VECTOR_PATH}`, {
    method: "POST",
    headers: {
      authorization: "Bearer tenant-chosen",
      "content-type": "text/plain",
      "content-length": String(bytes.byteLength),
      "x-tenant-header": "must-not-forward",
    },
    body: payload,
  });
  const response = await loaded.default.fetch(request, env);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("x-plane-secret")).toBeNull();
  expect(await response.json()).toEqual({ ok: true, value: { vectors: [] } });
  expect(forwardedUrl).toBe(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_VECTOR_PATH}`);
  if (!forwardedInit) throw new Error("Vector request was not forwarded");
  const headers = new Headers(forwardedInit.headers);
  expect([...headers.keys()].sort()).toEqual(["authorization", "content-length", "content-type"]);
  expect(headers.get("authorization")).toBe("Bearer private-plane-token");
  expect(headers.get("content-type")).toBe(SELFHOST_DATA_PLANE_CONTENT_TYPE);
  expect(headers.get("content-length")).toBe(String(bytes.byteLength));
  const forwardedBytes = await new Response(forwardedInit.body).arrayBuffer();
  expect(forwardedBytes.byteLength).toBe(bytes.byteLength);
  expect(new TextDecoder().decode(forwardedBytes)).toBe(payload);

  const unknown = await loaded.default.fetch(
    new Request(
      `${SELFHOST_DATA_PLANE_ORIGIN}/.well-known/takoserver/selfhost-data/v1/vector/other`,
      {
        method: "POST",
        body: payload,
      },
    ),
    env,
  );
  expect(unknown.status).toBe(404);
  expect(forwardedUrl).toBe(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_VECTOR_PATH}`);
});

test("the generated data service rejects an oversized Vector body before forwarding", async () => {
  root = await mkdtemp(join(tmpdir(), "takoserver-selfhost-data-service-"));
  await Bun.write(join(root, SELFHOST_WORKER_DATA_SERVICE_MODULE), selfhostDataServiceSource());
  const loaded = (await import(
    `${pathToFileURL(join(root, SELFHOST_WORKER_DATA_SERVICE_MODULE)).href}?test=${crypto.randomUUID()}`
  )) as {
    readonly default: {
      fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
    };
  };
  let forwarded = false;
  const env = {
    [SELFHOST_WORKER_DATA_TOKEN_BINDING]: "private-plane-token",
    [SELFHOST_WORKER_DATA_PLANE_BINDING]: {
      async fetch(): Promise<Response> {
        forwarded = true;
        return new Response('{"ok":true,"value":{}}', {
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
  const response = await loaded.default.fetch(
    new Request(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_VECTOR_PATH}`, {
      method: "POST",
      headers: {
        "content-length": String(8 * 1024 * 1024 + 1),
      },
      body: "{}",
    }),
    env,
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(forwarded).toBe(false);
});
