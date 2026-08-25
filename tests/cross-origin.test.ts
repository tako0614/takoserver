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

describe("browser console session", () => {
  test("keeps the session in an HttpOnly cookie scoped to the exact console origin", async () => {
    const { buildApp } = await import("../src/app.ts");
    const { buildEdgeForms } = await import("../src/edge-forms.ts");
    const { createEphemeralSql } = await import("../src/compat.ts");
    const { createMemoryObjectStore } = await import("../src/objects-mem.ts");
    const edge = await buildEdgeForms();
    const app = buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      forms: edge.forms,
      hostForms: edge.forms,
      providers: [],
      offerings: [],
      publicOrigin: "https://api.example.test",
      consoleOrigin: "https://console.example.test",
      identity: {
        async verify() {
          return {
            providerSubject: "pairwise-subject",
            email: "person@example.test",
            displayName: "A Person",
          };
        },
      },
      settlement: {
        verify: () => {
          throw new Error("not configured");
        },
      },
    });

    const signedIn = await app.fetch(
      new Request("https://api.example.test/v1/sessions", {
        method: "POST",
        headers: {
          origin: "https://console.example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "google", assertion: "anything" }),
      }),
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("access-control-allow-origin")).toBe(
      "https://console.example.test",
    );
    expect(signedIn.headers.get("access-control-allow-credentials")).toBe("true");
    const cookie = signedIn.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("takoserver_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(await signedIn.json()).not.toHaveProperty("sessionToken");

    const me = await app.fetch(
      new Request("https://api.example.test/v1/me", {
        headers: { origin: "https://console.example.test", cookie },
      }),
    );
    expect(me.status).toBe(200);

    const csrf = await app.fetch(
      new Request("https://api.example.test/v1/me", {
        headers: { origin: "https://evil.example.test", cookie },
      }),
    );
    expect(csrf.status).toBe(401);
    expect(csrf.headers.get("access-control-allow-origin")).toBe("*");
    expect(csrf.headers.get("access-control-allow-credentials")).toBeNull();
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
      hostForms: edge.forms,
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

/**
 * A key issued before a scope existed must not lose access to its own work.
 * `resources:read` was added after keys were already in the field; without an
 * implication, every one of them stopped being able to list what it had
 * created — and requiring both separately buys nothing, because a writer can
 * always learn the state by writing.
 */
describe("scope implication", () => {
  test("a writer may read", async () => {
    const { grants } = await import("../src/auth.ts");
    expect(grants(["resources:write"], "resources:read")).toBe(true);
  });

  test("a reader may not write", async () => {
    const { grants } = await import("../src/auth.ts");
    expect(grants(["resources:read"], "resources:write")).toBe(false);
  });

  test("nothing else is implied", async () => {
    const { grants } = await import("../src/auth.ts");
    expect(grants(["resources:write"], "wallet:read")).toBe(false);
    expect(grants(["wallet:read"], "resources:read")).toBe(false);
    expect(grants(["catalog:read"], "reseller:write")).toBe(false);
  });
});

/**
 * A signed-in person may enter the exact-pin lane, and must say which
 * organization they are acting for.
 *
 * A key names one organization by existing. A session names a person, who may
 * own several — and guessing which of somebody's organizations to bill is not
 * a guess worth making, so an unnamed session is refused rather than resolved.
 */
describe("entering the lane with a session", () => {
  const build = async () => {
    const { buildApp } = await import("../src/app.ts");
    const { buildEdgeForms } = await import("../src/edge-forms.ts");
    const { createEphemeralSql } = await import("../src/compat.ts");
    const { createMemoryObjectStore } = await import("../src/objects-mem.ts");
    const edge = await buildEdgeForms();
    const app = buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      forms: edge.forms,
      hostForms: edge.forms,
      providers: [],
      // This fixture isolates session admission from concrete provider
      // composition. Production derives availability from its installed pack.
      availability: {
        async resolve() {
          return { executable: true, activated: true, availableToPrincipal: true };
        },
      },
      offerings: [],
      publicOrigin: "https://api.example.test",
      identity: {
        async verify() {
          return {
            providerSubject: "108000000000000000001",
            email: "person@example.com",
            displayName: "A Person",
          };
        },
      },
      settlement: {
        verify: () => {
          throw new Error("not configured");
        },
      },
    });

    const session = (await (
      await app.fetch(
        new Request("https://api.example.test/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "google", assertion: "anything" }),
        }),
      )
    ).json()) as { sessionToken: string };

    const organization = (await (
      await app.fetch(
        new Request("https://api.example.test/v1/organizations", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${session.sessionToken}`,
          },
          body: JSON.stringify({ name: "Acme" }),
        }),
      )
    ).json()) as { organization: { id: string } };

    return { app, token: session.sessionToken, organizationId: organization.organization.id };
  };

  const prepare = async (
    app: Awaited<ReturnType<typeof build>>["app"],
    token: string,
    headers: Record<string, string>,
  ) => {
    const { buildEdgeForms } = await import("../src/edge-forms.ts");
    const edge = await buildEdgeForms();
    const form = edge.objectBucket.form.identity.formRef;
    return await app.fetch(
      new Request("https://api.example.test/apis/forms.takoform.com/v1/resources/prepare", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify({
          apiVersion: form.apiVersion,
          kind: form.kind,
          form: { formRef: form },
          metadata: { name: "media", space: "default" },
          spec: {},
        }),
      }),
    );
  };

  test("accepts a session that names an organization it owns", async () => {
    const { app, token, organizationId } = await build();
    const response = await prepare(app, token, { "takoform-organization": organizationId });
    expect(response.status).toBe(200);
  });

  test("refuses a session that names nothing", async () => {
    const { app, token } = await build();
    expect((await prepare(app, token, {})).status).toBe(401);
  });

  test("refuses a session that names somebody else's organization", async () => {
    const { app, token } = await build();
    const response = await prepare(app, token, {
      "takoform-organization": "org_00000000000000000000000000000000",
    });
    expect(response.status).toBe(401);
  });
});
