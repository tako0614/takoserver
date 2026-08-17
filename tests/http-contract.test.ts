import { describe, expect, test } from "bun:test";
import {
  createHttpHandler,
  createInMemoryTakoformHost,
  createTakoserver,
  type ExternalIdentityVerifier,
  openApiDocument,
  PortableFakeBackend,
} from "../src/index.ts";

const currentTakoformPaths = [
  "/apis/forms.takoform.com/v1alpha3/forms",
  "/apis/forms.takoform.com/v1alpha3/form-definitions/{formGroup}/{formVersion}/{kind}",
  "/apis/forms.takoform.com/v1alpha3/resources/validate",
  "/apis/forms.takoform.com/v1alpha3/resources/prepare",
  "/apis/forms.takoform.com/v1alpha3/resources/{formGroup}/{formVersion}/{kind}/{name}",
  "/apis/forms.takoform.com/v1alpha3/resources/{formGroup}/{formVersion}/{kind}/{name}/import",
  "/apis/forms.takoform.com/v1alpha3/resources/{formGroup}/{formVersion}/{kind}/{name}/observe",
  "/apis/forms.takoform.com/v1alpha3/operations/{operationId}",
  "/apis/forms.takoform.com/v1alpha3/operations/{operationId}/cancel",
  "/apis/forms.takoform.com/v1alpha3/artifacts/uploads",
  "/apis/forms.takoform.com/v1alpha3/artifacts/uploads/{uploadId}/blobs/{sha256}",
  "/apis/forms.takoform.com/v1alpha3/artifacts/uploads/{uploadId}/commit",
  "/apis/forms.takoform.com/v1alpha3/artifacts/uploads/{uploadId}",
  "/apis/forms.takoform.com/v1alpha3/artifacts/{manifestDigest}",
  "/apis/forms.takoform.com/v1alpha3/artifacts/blobs/{sha256}",
  "/apis/forms.takoform.com/v1alpha3/support/forms",
  "/apis/forms.takoform.com/v1alpha3/support/forms/{formGroup}/{formVersion}/{kind}/{definitionVersion}",
  "/apis/forms.takoform.com/v1alpha3/support/interfaces/{name}/{version}",
  "/apis/forms.takoform.com/v1alpha3/support/bindings/{name}/{version}",
] as const;

const expectedPaths = [
  "/",
  "/.well-known/takoserver",
  "/.well-known/takoform/v1beta1",
  "/.well-known/takoform/v1alpha3",
  "/openapi.json",
  "/v1/identity/providers",
  "/v1/sessions",
  "/v1/organizations",
  "/v1/organizations/{organizationId}/api-keys",
  "/v1/organizations/{organizationId}/api-keys/{apiKeyId}",
  "/v1/organizations/{organizationId}/wallet",
  "/v1/organizations/{organizationId}/wallet/funding",
  "/v1/catalog",
  "/v1/resources",
  "/v1/storage/object",
  "/v1/storage/objects",
  "/v1/ai/models",
  "/v1/ai/chat/completions",
  "/v1/reseller/quotes",
  "/v1/reseller/reservations",
  "/v1/reseller/reservations/{reservationId}/grants",
  "/v1/reseller/reservations/{reservationId}/capture",
  "/v1/reseller/reservations/{reservationId}/release",
  "/v1/reseller/reservations/{reservationId}/usage-statement",
  ...currentTakoformPaths,
  ...currentTakoformPaths.map((path) => path.replaceAll("v1alpha3", "v1beta1")),
] as const;

describe("Takoserver public HTTP contract", () => {
  test("allows only HTTPS or a loopback HTTP origin", () => {
    const server = createTakoserver({
      identity: {
        async verify() {
          return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
        },
      },
      backends: [new PortableFakeBackend("fake", [])],
    });
    expect(() =>
      createHttpHandler({ server, publicOrigin: "http://127.0.0.1:18473" }),
    ).not.toThrow();
    expect(() =>
      createHttpHandler({ server, publicOrigin: "http://localhost:18473" }),
    ).not.toThrow();
    expect(() => createHttpHandler({ server, publicOrigin: "http://api.takoserver.com" })).toThrow(
      "publicOrigin must be HTTPS unless it is loopback",
    );
  });

  test("publishes direct-product console, discovery, and a complete OpenAPI route inventory", async () => {
    const identity: ExternalIdentityVerifier = {
      async verify() {
        return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
      },
    };
    const handler = createHttpHandler({
      server: createTakoserver({
        identity,
        backends: [new PortableFakeBackend("fake", [])],
      }),
      publicOrigin: "https://api.takoserver.com",
      takoformHost: createInMemoryTakoformHost({
        authenticate: async () => null,
        forms: [],
      }),
    });

    const consoleResponse = await handler(new Request("https://api.takoserver.com/"));
    expect(consoleResponse.status).toBe(200);
    expect(consoleResponse.headers.get("content-type")).toContain("text/html");
    const consoleHtml = await consoleResponse.text();
    expect(consoleHtml).toContain("Takoserver");
    expect(consoleHtml).toContain("Google");
    expect(consoleHtml).toContain("GitHub");

    const takoform = await handler(
      new Request("https://api.takoserver.com/.well-known/takoform/v1alpha3"),
    );
    expect(await takoform.json()).toEqual({
      api_versions: ["forms.takoform.com/v1alpha3"],
      features: {
        service_forms: true,
        exact_form_ref: true,
        optimistic_concurrency: true,
        idempotent_lifecycle: true,
        operations: true,
        artifact_upload: true,
        support_profiles: true,
      },
      endpoints: {
        api: "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3",
        artifacts: "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/artifacts",
        operations: "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/operations",
        support: "https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/support",
      },
    });

    const releasedProviderTakoform = await handler(
      new Request("https://api.takoserver.com/.well-known/takoform/v1beta1"),
    );
    expect(await releasedProviderTakoform.json()).toEqual({
      api_versions: ["forms.takoform.com/v1beta1"],
      features: {
        service_forms: true,
        exact_form_ref: true,
        optimistic_concurrency: true,
        idempotent_lifecycle: true,
        operations: true,
        artifact_upload: true,
        support_profiles: true,
      },
      endpoints: {
        api: "https://api.takoserver.com/apis/forms.takoform.com/v1beta1",
        artifacts: "https://api.takoserver.com/apis/forms.takoform.com/v1beta1/artifacts",
        operations: "https://api.takoserver.com/apis/forms.takoform.com/v1beta1/operations",
        support: "https://api.takoserver.com/apis/forms.takoform.com/v1beta1/support",
      },
    });

    expect(Object.keys(openApiDocument.paths).sort()).toEqual([...expectedPaths].sort());
    expect(openApiDocument.servers).toEqual([{ url: "https://api.takoserver.com" }]);
    expect(JSON.stringify(openApiDocument)).not.toMatch(/takosumi/i);
    const resellerSchemas = Object.fromEntries(
      Object.entries(openApiDocument.components.schemas).filter(([name]) =>
        name.startsWith("Reseller"),
      ),
    );
    expect(JSON.stringify(resellerSchemas)).not.toMatch(/workspace|userId|principalId/i);
  });
});
