import { describe, expect, test } from "bun:test";
import { probePublishedOrigin } from "../scripts/deploy/verify.ts";

const ORIGIN = "https://api.takoserver.test";

function fixture(
  options: {
    readonly openApiOrigin?: string;
    readonly discoveryApiOrigin?: string;
    readonly discoveryOpenApiOrigin?: string;
  } = {},
  seen: string[] = [],
) {
  const {
    openApiOrigin = ORIGIN,
    discoveryApiOrigin = ORIGIN,
    discoveryOpenApiOrigin = ORIGIN,
  } = options;
  return async (request: Request) => {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/.well-known/takoserver") {
      return Response.json({
        product: "takoserver",
        endpoints: {
          api: discoveryApiOrigin,
          openapi: `${discoveryOpenApiOrigin}/openapi.json`,
        },
      });
    }
    if (url.pathname === "/openapi.json") {
      return Response.json({
        servers: [{ url: openApiOrigin }],
        paths: { "/apis/forms.takoform.com/v1/forms": {} },
      });
    }
    if (url.pathname === "/.well-known/takoform/v1") {
      return Response.json({ api_versions: ["forms.takoform.com/v1"] });
    }
    if (
      /^\/(?:\.well-known\/takoform|apis\/forms\.takoform\.com)\/v1(?:alpha3|beta1|beta4)/u.test(
        url.pathname,
      )
    ) {
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
    if (url.pathname === "/v1/identity/providers") return Response.json({ providers: [] });
    if (
      url.pathname === "/v1/organizations/org_probe/wallet" ||
      url.pathname === "/v1/reseller/quotes" ||
      url.pathname === "/apis/forms.takoform.com/v1/support/forms"
    ) {
      return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };
}

describe("published stable Host postconditions", () => {
  test("requires stable discovery, retired Host methods at 404, and surviving product v1", async () => {
    const seen: string[] = [];
    const proven = await probePublishedOrigin(ORIGIN, fixture({}, seen));

    expect(proven).toContain("literal stable Takoform Host advertised");
    expect(proven).toContain("retired Takoform Host lanes refuse ordinary HTTP methods");
    expect(seen).toContain("GET /v1/identity/providers");
    for (const lane of ["v1alpha3", "v1beta1", "v1beta4"]) {
      expect(seen).toContain(`GET /.well-known/takoform/${lane}`);
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        expect(seen).toContain(`${method} /apis/forms.takoform.com/${lane}/forms`);
      }
      expect(seen).not.toContain(`OPTIONS /apis/forms.takoform.com/${lane}/forms`);
    }
  });

  test("rejects an OpenAPI server that drifts from the published origin", async () => {
    await expect(
      probePublishedOrigin(ORIGIN, fixture({ openApiOrigin: "https://api.takoserver.com" })),
    ).rejects.toThrow("OpenAPI server");
  });

  test("rejects discovery endpoints that drift from the published origin", async () => {
    for (const options of [
      { discoveryApiOrigin: "https://api.takoserver.com" },
      { discoveryOpenApiOrigin: "https://api.takoserver.com" },
    ]) {
      await expect(probePublishedOrigin(ORIGIN, fixture(options))).rejects.toThrow(
        "discovery endpoint",
      );
    }
  });
});
