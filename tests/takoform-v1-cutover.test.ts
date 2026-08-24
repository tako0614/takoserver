import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createInMemoryTakoformHost,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";

function handler() {
  return buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        return {
          providerSubject: "subject",
          email: "owner@example.com",
          displayName: "Owner",
        };
      },
    },
    settlement: {
      async verify() {
        return {
          fundingRef: "settlement",
          amountMinor: 1_000,
          currency: "USD",
        };
      },
    },
    publicOrigin: "https://api.takoserver.com",
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
  }).fetch;
}

describe("literal stable Takoform Host cutover", () => {
  test("serves only Host v1 while preserving Takoserver product and provision routes", async () => {
    const fetch = handler();

    const discovery = await fetch(
      new Request("https://api.takoserver.com/.well-known/takoform/v1"),
    );
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({
      api_versions: ["forms.takoform.com/v1"],
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
        api: "https://api.takoserver.com/apis/forms.takoform.com/v1",
      },
    });

    const productDiscovery = await fetch(
      new Request("https://api.takoserver.com/.well-known/takoserver"),
    );
    expect(productDiscovery.status).toBe(200);
    expect(await productDiscovery.json()).toMatchObject({
      endpoints: {
        takoform: "https://api.takoserver.com/apis/forms.takoform.com/v1",
      },
    });

    const mountedHostApi = await fetch(
      new Request("https://api.takoserver.com/apis/forms.takoform.com/v1/forms?space=main"),
    );
    expect(mountedHostApi.status).toBe(401);

    for (const lane of ["v1alpha3", "v1beta1", "v1beta4"]) {
      expect(
        (await fetch(new Request(`https://api.takoserver.com/.well-known/takoform/${lane}`)))
          .status,
      ).toBe(404);
      expect(
        (
          await fetch(
            new Request(
              `https://api.takoserver.com/apis/forms.takoform.com/${lane}/forms?space=main`,
            ),
          )
        ).status,
      ).toBe(404);
      for (const method of ["POST", "PUT", "DELETE"]) {
        expect(
          (
            await fetch(
              new Request(`https://api.takoserver.com/apis/forms.takoform.com/${lane}/forms`, {
                method,
              }),
            )
          ).status,
        ).toBe(404);
      }
    }

    // OPTIONS is a router-wide browser preflight response, not lane
    // discovery. It is deliberately excluded from the exact-404 claim.
    expect(
      (
        await fetch(
          new Request("https://api.takoserver.com/apis/forms.takoform.com/v1beta1/forms", {
            method: "OPTIONS",
            headers: { origin: "https://client.example" },
          }),
        )
      ).status,
    ).toBe(204);

    expect((await fetch(new Request("https://api.takoserver.com/v1/catalog"))).status).not.toBe(
      404,
    );
    expect(
      (
        await fetch(
          new Request("https://api.takoserver.com/provision/v1/resources/prepare", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).not.toBe(404);
  });

  test("ignores an attempted historical route override on the public constructor", async () => {
    const host = createInMemoryTakoformHost({
      authenticate: async () => null,
      forms: [],
      routes: {
        hostApiVersion: "forms.takoform.com/v1alpha3",
        apiPath: "/apis/forms.takoform.com/v1alpha3",
        aliases: ["/apis/forms.takoform.com/v1beta1"],
        supportProfileApiVersion: "support.takoform.com/v1alpha1",
      },
    } as never);

    expect(
      await host.handle(
        new Request("https://api.takoserver.com/apis/forms.takoform.com/v1alpha3/forms"),
      ),
    ).toBeNull();
    expect(
      (
        await host.handle(
          new Request("https://api.takoserver.com/apis/forms.takoform.com/v1/forms?space=main"),
        )
      )?.status,
    ).toBe(401);
  });
});
