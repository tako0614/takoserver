import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createTakoformHost } from "../src/takoform/host.ts";
import type { InstalledTakoformForm, TakoformResourceDriver } from "../src/takoform/types.ts";

const lane = "/apis/forms.takoform.com/v1";
const serviceApiVersion = "standards.takoform.com/v1";
const protocolPattern =
  "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$";

const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "StandardClient",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"f".repeat(64)}`,
    },
  },
  requiresHostApi: "forms.takoform.com/v1",
  role: "revision",
  desiredSchema: {
    type: "object",
    properties: {
      externalServices: {
        type: "array",
        "x-takoform-standard-services": serviceApiVersion,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$", maxLength: 64 },
            required: { type: "boolean", default: true },
            service: {
              type: "object",
              additionalProperties: false,
              properties: {
                apiVersion: { const: serviceApiVersion },
                protocol: { type: "string", pattern: protocolPattern, maxLength: 253 },
              },
              required: ["apiVersion", "protocol"],
            },
          },
          required: ["name", "service"],
        },
      },
    },
    required: ["externalServices"],
    additionalProperties: false,
  },
  operations: ["create", "read", "delete"],
};

describe("stable StandardServiceRef", () => {
  test("accepts unknown grammar-valid identifiers but support and required resolution fail closed", async () => {
    let mutations = 0;
    const host = stableHost({
      async apply() {
        mutations += 1;
        return {};
      },
      async observe() {
        return {};
      },
      async delete() {},
    });

    const support = await host.handle(
      request(`${lane}/support/standard-services/com.example.future-store`),
    );
    expect(support?.status).toBe(200);
    expect(await support?.json()).toEqual({
      apiVersion: "support.takoform.com/v1",
      kind: "StandardServiceSupport",
      serviceRef: {
        apiVersion: serviceApiVersion,
        protocol: "com.example.future-store",
      },
      satisfiable: false,
    });

    const refused = await host.handle(
      request(`${lane}/resources/prepare`, {
        method: "POST",
        body: JSON.stringify(resource("com.example.future-store")),
      }),
    );
    expect(refused?.status).toBe(422);
    expect(await refused?.json()).toMatchObject({ error: { code: "unsupported_capability" } });
    expect(mutations).toBe(0);
  });

  test("refuses a required exact service before mutation when no supply is configured", async () => {
    let mutations = 0;
    const host = stableHost(
      {
        async apply() {
          mutations += 1;
          return {};
        },
        async observe() {
          return {};
        },
        async delete() {},
      },
      false,
    );
    const refused = await host.handle(
      request(`${lane}/resources/prepare`, {
        method: "POST",
        body: JSON.stringify(resource("com.amazonaws.s3")),
      }),
    );
    expect(refused?.status).toBe(422);
    expect(await refused?.json()).toMatchObject({ error: { code: "unsupported_capability" } });
    expect(mutations).toBe(0);
  });

  test("defaults required to true, omits unsupported optional slots, and keeps material sealed", async () => {
    const projected: unknown[] = [];
    const host = stableHost({
      async apply(input) {
        projected.push(input.standardServices);
        return { outputs: { hostname: "worker.example.invalid" } };
      },
      async observe() {
        return {};
      },
      async delete() {},
    });

    const desired = resource("com.amazonaws.s3", undefined, [
      {
        name: "FUTURE_STORE",
        required: false,
        service: { apiVersion: serviceApiVersion, protocol: "com.example.future-store" },
      },
    ]);
    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, { method: "POST", body: JSON.stringify(desired) }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("prepare was not routed");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const applied = await host.handle(
      request(`${lane}/resources/example.forms.invalid/StandardClient/client`, {
        method: "PUT",
        headers: { "idempotency-key": "stable-standard-service-0001", "if-none-match": "*" },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(applied?.status).toBe(201);
    expect(projected).toEqual([
      [
        {
          name: "ARCHIVE",
          required: true,
          service: { apiVersion: serviceApiVersion, protocol: "com.amazonaws.s3" },
          endpoint: { endpoint: "sealed-endpoint:main" },
          credential: { token: "sealed-credential" },
        },
      ],
    ]);
    const portable = JSON.stringify(await applied?.json());
    expect(portable).not.toContain("sealed-endpoint");
    expect(portable).not.toContain("sealed-credential");
  });

  test("rejects portable endpoint, credential, FormRef, and Resource selector fields", async () => {
    const host = stableHost({
      async apply() {
        throw new Error("invalid portable state must not mutate");
      },
      async observe() {
        return {};
      },
      async delete() {},
    });
    for (const extra of [
      { endpoint: "https://objects.invalid" },
      { credential: "secret" },
      { formRef: { apiVersion: "edge.forms.takoform.com", kind: "ObjectBucket" } },
      { resource: { name: "bucket" } },
    ]) {
      const candidate = resource("com.amazonaws.s3");
      Object.assign(candidate.spec.externalServices[0] as object, extra);
      const response = await host.handle(
        request(`${lane}/resources/validate`, {
          method: "POST",
          body: JSON.stringify(candidate),
        }),
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({
        valid: false,
        diagnostics: [{ severity: "error", message: "unknown field" }],
      });
    }
  });
});

function stableHost(driver: TakoformResourceDriver, withResolver = true) {
  return createTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver,
    ...(withResolver
      ? {
          standardServiceResolver: {
            async satisfiable({ tenantId, space, serviceRef }) {
              return (
                tenantId === "tenant-a" &&
                (space === undefined || space === "main") &&
                serviceRef.protocol === "com.amazonaws.s3"
              );
            },
            async resolve({ tenantId, space, slot }) {
              if (
                tenantId !== "tenant-a" ||
                space !== "main" ||
                slot.service.protocol !== "com.amazonaws.s3"
              ) {
                return null;
              }
              return {
                endpoint: { endpoint: `sealed-endpoint:${space}` },
                credential: { token: "sealed-credential" },
              };
            },
          },
        }
      : {}),
  });
}

function resource(
  protocol: string,
  required?: boolean,
  tail: readonly Record<string, unknown>[] = [],
) {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name: "client", space: "main" },
    spec: {
      externalServices: [
        {
          name: "ARCHIVE",
          ...(required === undefined ? {} : { required }),
          service: { apiVersion: serviceApiVersion, protocol },
        },
        ...tail,
      ],
    },
  };
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer test");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://api.takoserver.com${path}`, { ...init, headers });
}
