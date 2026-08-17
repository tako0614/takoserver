import { describe, expect, test } from "bun:test";
import { createRouter } from "../src/router.ts";

/**
 * The console is served from its own hostname, so every call it makes is
 * cross-origin. Without these headers the product has a console that cannot
 * reach its own API — which looks, from a browser, exactly like an outage.
 */
const router = createRouter({
  control: async () => null,
  publicOrigin: "https://api.example.test",
});

const from = (origin: string, init: RequestInit = {}) => {
  const { headers, ...rest } = init;
  return router(
    new Request("https://api.example.test/.well-known/takoserver", {
      ...rest,
      headers: { origin, ...((headers as Record<string, string>) ?? {}) },
    }),
  );
};

describe("cross-origin access", () => {
  test("answers a preflight without routing or authenticating it", async () => {
    const response = await from("https://console.example.test", {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization, idempotency-key",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    // Reflected, so a frozen protocol's own headers are never quietly dropped.
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, idempotency-key",
    );
  });

  test("never allows credentials, which is what makes a wildcard origin safe", async () => {
    for (const method of ["OPTIONS", "GET"] as const) {
      const response = await from("https://anywhere.test", {
        method,
        ...(method === "OPTIONS" ? { headers: { "access-control-request-method": "GET" } } : {}),
      });
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  test("exposes the fence a caller has to present back", async () => {
    const response = await from("https://console.example.test");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-expose-headers")).toContain("etag");
    // The body is untouched by any of this.
    expect(await response.json()).toMatchObject({ product: "takoserver" });
  });

  test("leaves a same-origin call exactly as it was", async () => {
    const response = await router(new Request("https://api.example.test/.well-known/takoserver"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
