import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
  type InstalledTakoformForm,
} from "../src/index.ts";
import { createStaticStableInMemoryTakoformHost as createInMemoryTakoformHost } from "./helpers/historical-takoform-host.ts";

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

  test("enumerates stable Forms without a space and accepts each optional filter", async () => {
    const form: InstalledTakoformForm = {
      identity: {
        formRef: {
          apiVersion: "function.forms.takoform.com",
          kind: "Function",
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      desiredSchema: { type: "object", additionalProperties: false },
      operations: ["create", "read", "delete"] as const,
    };
    const host = createInMemoryTakoformHost({
      authenticate: async (authorization) =>
        authorization === "Bearer stable"
          ? { tenantId: "tenant-a", principalId: "principal-a" }
          : null,
      forms: [form],
    });
    const headers = { authorization: "Bearer stable" };
    const root = "https://api.takoserver.com/apis/forms.takoform.com/v1/forms";
    const filters = new URLSearchParams({
      group: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      definitionVersion: form.identity.formRef.definitionVersion,
      schemaDigest: form.identity.formRef.schemaDigest,
      space: "main",
    });

    const noSpace = await host.handle(new Request(root, { headers }));
    expect(noSpace?.status).toBe(200);
    expect(await noSpace?.json()).toMatchObject({
      forms: [{ identity: form.identity }],
    });

    for (const query of [
      `group=${encodeURIComponent(form.identity.formRef.apiVersion)}`,
      `kind=${form.identity.formRef.kind}`,
      `definitionVersion=${form.identity.formRef.definitionVersion}`,
      `schemaDigest=${encodeURIComponent(form.identity.formRef.schemaDigest)}`,
      filters.toString(),
    ]) {
      const response = await host.handle(new Request(`${root}?${query}`, { headers }));
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({
        forms: [{ identity: form.identity }],
      });
    }
  });

  test("rejects empty or malformed stable Form filters", async () => {
    const host = createInMemoryTakoformHost({
      authenticate: async () => ({
        tenantId: "tenant-a",
        principalId: "principal-a",
      }),
      forms: [],
    });
    const root = "https://api.takoserver.com/apis/forms.takoform.com/v1/forms";
    for (const query of [
      "space=",
      "group=not_a_dns_group",
      "kind=function",
      "definitionVersion=latest",
      "schemaDigest=sha256:short",
    ]) {
      const response = await host.handle(new Request(`${root}?${query}`));
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({
        error: { code: "invalid_argument" },
      });
    }
  });

  test("uses one versionless family path on stable definition, support, and resource routes", async () => {
    const form: InstalledTakoformForm = {
      identity: {
        formRef: {
          apiVersion: "function.forms.takoform.com",
          kind: "Function",
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"b".repeat(64)}`,
        },
      },
      desiredSchema: { type: "object", additionalProperties: false },
      operations: ["create", "read", "delete"] as const,
    };
    const host = createInMemoryTakoformHost({
      authenticate: async () => ({
        tenantId: "tenant-a",
        principalId: "principal-a",
      }),
      forms: [form],
    });
    const ref = form.identity.formRef;
    const query = new URLSearchParams({
      space: "main",
      definitionVersion: ref.definitionVersion,
      schemaDigest: ref.schemaDigest,
    });
    const definition = await host.handle(
      new Request(
        `https://api.takoserver.com/apis/forms.takoform.com/v1/form-definitions/${ref.apiVersion}/${ref.kind}?${query}`,
      ),
    );
    expect(definition?.status).toBe(200);
    const support = await host.handle(
      new Request(
        `https://api.takoserver.com/apis/forms.takoform.com/v1/support/forms/${ref.apiVersion}/${ref.kind}/${ref.definitionVersion}`,
      ),
    );
    expect(support?.status).toBe(200);
    const missing = await host.handle(
      new Request(
        `https://api.takoserver.com/apis/forms.takoform.com/v1/resources/${ref.apiVersion}/${ref.kind}/missing?${query}`,
      ),
    );
    expect(missing?.status).toBe(404);
    expect(await missing?.json()).toMatchObject({
      error: { code: "resource_not_found" },
    });

    const duplicatedPathIdentity = new URLSearchParams(query);
    duplicatedPathIdentity.set("group", ref.apiVersion);
    duplicatedPathIdentity.set("kind", ref.kind);
    for (const path of [
      `/form-definitions/${ref.apiVersion}/${ref.kind}`,
      `/resources/${ref.apiVersion}/${ref.kind}/missing`,
    ]) {
      const response = await host.handle(
        new Request(
          `https://api.takoserver.com/apis/forms.takoform.com/v1${path}?${duplicatedPathIdentity}`,
        ),
      );
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({
        error: { code: "invalid_argument" },
      });
    }

    const unknownQuery = new URLSearchParams(query);
    unknownQuery.set("definitionVersion", "9.9.9");
    const unknownForm = await host.handle(
      new Request(
        `https://api.takoserver.com/apis/forms.takoform.com/v1/resources/${ref.apiVersion}/${ref.kind}/missing?${unknownQuery}`,
      ),
    );
    expect(unknownForm?.status).toBe(404);
    expect(await unknownForm?.json()).toMatchObject({
      error: { code: "form_unknown" },
    });

    for (const path of [
      `/form-definitions/${ref.apiVersion}/v1beta1/${ref.kind}`,
      `/support/forms/${ref.apiVersion}/v1beta1/${ref.kind}/${ref.definitionVersion}`,
      `/resources/${ref.apiVersion}/v1beta1/${ref.kind}/missing`,
    ]) {
      const response = await host.handle(
        new Request(`https://api.takoserver.com/apis/forms.takoform.com/v1${path}?${query}`),
      );
      expect(response?.status).toBe(404);
      expect(await response?.json()).toMatchObject({
        error: { code: "invalid_argument" },
      });
    }

    const encodedSlash = await host.handle(
      new Request(
        `https://api.takoserver.com/apis/forms.takoform.com/v1/resources/${encodeURIComponent(`${ref.apiVersion}/v1beta1`)}/${ref.kind}/missing?${query}`,
      ),
    );
    expect(encodedSlash?.status).toBe(400);
    expect(await encodedSlash?.json()).toMatchObject({
      error: { code: "invalid_argument" },
    });
  });

  test("binds exact-principal definition reads to the authorized space", async () => {
    const form: InstalledTakoformForm = {
      identity: {
        formRef: {
          apiVersion: "function.forms.takoform.com",
          kind: "Function",
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"c".repeat(64)}`,
        },
      },
      desiredSchema: { type: "object", additionalProperties: false },
      operations: ["create", "read", "delete"] as const,
    };
    const ref = form.identity.formRef;
    const host = createInMemoryTakoformHost({
      authenticate: async () => ({
        tenantId: "tenant-a",
        principalId: "principal-a",
        scope: {
          space: "allowed-space",
          formRef: ref,
          resourceName: "function-a",
          mode: "manage" as const,
        },
      }),
      forms: [form],
    });
    const definition = `/apis/forms.takoform.com/v1/form-definitions/${ref.apiVersion}/${ref.kind}`;
    const query = new URLSearchParams({
      space: "allowed-space",
      definitionVersion: ref.definitionVersion,
      schemaDigest: ref.schemaDigest,
    });

    const allowed = await host.handle(new Request(`https://host.invalid${definition}?${query}`));
    expect(allowed?.status).toBe(200);

    query.set("space", "foreign-space");
    const foreign = await host.handle(new Request(`https://host.invalid${definition}?${query}`));
    expect(foreign?.status).toBe(404);
    expect(await foreign?.json()).toMatchObject({
      error: { code: "resource_not_found" },
    });
  });
});
