import { describe, expect, test } from "bun:test";
import worker from "../src/entry-worker.ts";
import {
  EDGE_ONLY_RESOURCE_CLASSES,
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

const ORIGIN = "https://api.integration.example.test";

/** Enough of a binding surface to reach composition, and nothing more. */
function workerEnv(
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<typeof worker.fetch>[1] {
  return {
    PUBLIC_ORIGIN: ORIGIN,
    STATE_DB: { prepare: () => ({}), batch: () => [] },
    OBJECTS: {
      put: () => null,
      get: () => null,
      head: () => null,
      delete: () => null,
      list: () => null,
    },
    WORKER_VERSION: { id: "00000000-0000-4000-8000-0000000000a1" },
    ...overrides,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function envelope(response: Response) {
  return (await response.json()) as {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly details?: { readonly reason?: string };
    };
  };
}

describe("Worker startup diagnostics", () => {
  test("the pre-0043 compatibility mode blocks all traffic before storage composition", async () => {
    const env = {
      PUBLIC_ORIGIN: ORIGIN,
      TAKOSERVER_ARTIFACT_BLOB_IO_MODE: "pre-0043-quiesced",
    } as Parameters<typeof worker.fetch>[1];
    const digest = `sha256:${"a".repeat(64)}`;
    for (const [method, path] of [
      ["GET", "/healthz"],
      ["POST", "/apis/forms.takoform.com/v1/artifacts/uploads"],
      ["PUT", `/apis/forms.takoform.com/v1/artifacts/uploads/up_old/blobs/${digest}`],
      ["POST", "/apis/forms.takoform.com/v1/artifacts/uploads/up_old/commit"],
      ["DELETE", "/apis/forms.takoform.com/v1/artifacts/uploads/up_old"],
    ] as const) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method }), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("60");
      const body = await envelope(response);
      expect(body.error.code).toBe("backend_unavailable");
      expect(body.error.details?.reason).toBe("runtime-configuration");
      expect(body.error.message).toContain("artifact blob I/O is quiesced");
    }
  });

  test("the pre-0043 compatibility mode suppresses scheduled artifact collection before composition", async () => {
    await expect(
      worker.scheduled({}, {
        TAKOSERVER_ARTIFACT_BLOB_IO_MODE: "pre-0043-quiesced",
      } as Parameters<typeof worker.scheduled>[1]),
    ).resolves.toBeUndefined();
  });

  test("an unknown artifact blob I/O mode fails closed as runtime configuration", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/healthz`),
      workerEnv({ TAKOSERVER_ARTIFACT_BLOB_IO_MODE: "typo" }),
    );
    expect(response.status).toBe(503);
    expect((await envelope(response)).error.details?.reason).toBe("runtime-configuration");
  });

  test("answers a composition refusal with its reason class, not a bare exception", async () => {
    // The live incident: one Cloudflare SupplyContract declared twice, the edge
    // half without `storage.object`. Composition is lazy and per request, so
    // the Worker went live and then threw on every route.
    const env = workerEnv({
      CLOUDFLARE_PROVIDER_EXECUTOR: {},
      TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
      TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(edgeSuppliesFixture(EDGE_ONLY_RESOURCE_CLASSES)),
      TAKOSERVER_OBJECT_BUCKET_SUPPLIES: JSON.stringify(objectBucketSuppliesFixture()),
    });

    for (const path of ["/healthz", "/.well-known/takoserver"]) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await envelope(response);
      expect(body.error.code).toBe("backend_unavailable");
      expect(body.error.details?.reason).toBe("supply-composition");
      expect(body.error.message).toBe("Cloudflare supply contract is ambiguous");
    }
  });

  test("classifies a missing public origin without echoing the request host", async () => {
    const response = await worker.fetch(
      new Request("https://alias.takoserver.com/openapi.json"),
      {} as Parameters<typeof worker.fetch>[1],
    );

    expect(response.status).toBe(503);
    const body = await envelope(response);
    expect(body.error.details?.reason).toBe("public-origin");
    expect(body.error.message).toContain("PUBLIC_ORIGIN");
    expect(JSON.stringify(body)).not.toContain("alias.takoserver.com");
  });

  test("classifies a configuration refusal without publishing an unreadable failure", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/healthz`), {
      PUBLIC_ORIGIN: ORIGIN,
    } as Parameters<typeof worker.fetch>[1]);

    expect(response.status).toBe(503);
    const body = await envelope(response);
    expect(body.error.details?.reason).toBe("runtime-configuration");
    expect(body.error.message).toBe("a D1 database binding is required");
  });
});
