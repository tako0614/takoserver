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

/**
 * A person holding a session asking which Forms exist is asking a question
 * about the platform, not about their organization. Answering "you are not
 * authenticated" — which is what the exact-pin lanes must say, since they only
 * admit an organization key — logs them out for asking.
 */
describe("Form registry on the control plane", () => {
  test("is reachable without an organization credential", async () => {
    const { buildApp } = await import("../src/app.ts");
    const { buildEdgeForms } = await import("../src/edge-forms.ts");
    const { createEphemeralSql } = await import("../src/compat.ts");
    const { createMemoryObjectStore } = await import("../src/objects-mem.ts");
    const edge = await buildEdgeForms();

    const app = buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      forms: edge.forms,
      providers: [],
      offerings: [],
      publicOrigin: "https://api.example.test",
      identity: {
        verify: () => {
          throw new Error("not configured");
        },
      },
      settlement: {
        verify: () => {
          throw new Error("not configured");
        },
      },
    });

    const response = await app.fetch(new Request("https://api.example.test/v1/forms"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { profiles: readonly { formRef: unknown }[] };
    expect(body.profiles.length).toBe(edge.forms.length);
    expect(body.profiles[0]).toHaveProperty("formRef");
  });
});

/**
 * Discovery is what a client reads to find everything else, so a claim in it
 * has to be true. Before this, it named the API's own root as the console —
 * a page which is not one — and a client following that link found a
 * placeholder where it expected an application.
 */
describe("product discovery", () => {
  const read = async (options: { readonly consoleOrigin?: string }) => {
    const served = createRouter({
      control: async () => null,
      publicOrigin: "https://api.example.test",
      ...options,
    });
    const response = await served(new Request("https://api.example.test/.well-known/takoserver"));
    return (await response.json()) as { endpoints: Record<string, string> };
  };

  test("names the console only when there is one", async () => {
    expect((await read({})).endpoints).not.toHaveProperty("console");
    expect((await read({ consoleOrigin: "https://console.example.test" })).endpoints.console).toBe(
      "https://console.example.test",
    );
  });

  test("always names the API and its description", async () => {
    const { endpoints } = await read({});
    expect(endpoints.api).toBe("https://api.example.test");
    expect(endpoints.openapi).toBe("https://api.example.test/openapi.json");
  });
});
