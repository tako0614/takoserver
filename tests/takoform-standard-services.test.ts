import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type {
  InstalledTakoformForm,
  TakoformResourceDriver,
  TakoformStandardServiceProjection,
} from "../src/takoform/types.ts";
import { createConfiguredHistoricalTakoformHost as createTakoformHost } from "./helpers/historical-takoform-host.ts";

const lane = "/apis/forms.takoform.com/v1beta4";
const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "StandardClient",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"f".repeat(64)}`,
    },
  },
  desiredSchema: {
    type: "object",
    properties: {
      vars: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      externalServices: {
        type: "array",
        "x-takoform-standard-services": "standards.takoform.com/v1alpha1",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            required: { type: "boolean" },
            service: {
              type: "object",
              additionalProperties: false,
              properties: {
                apiVersion: { const: "standards.takoform.com/v1alpha1" },
                protocol: { enum: ["s3-compatible"] },
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
  role: "revision",
  operations: ["create", "read", "delete"],
};

describe("Definition-declared standard service slots", () => {
  test("refuses a projected member collision before mutation", async () => {
    let resolutionAttempts = 0;
    const host = createTakoformHost({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal" }),
      forms: [form],
      driver: {
        async apply() {
          throw new Error("driver must not run");
        },
        async observe() {
          return { observed: {} };
        },
        async delete() {},
      },
      routes: {
        hostApiVersion: "forms.takoform.com/v1beta4",
        apiPath: lane,
        supportProfileApiVersion: "support.takoform.com/v1alpha2",
        reviewSpecDigest: true,
      },
      standardServiceResolver: {
        async satisfiable() {
          resolutionAttempts += 1;
          return true;
        },
        async resolve() {
          throw new Error("resolver must not project");
        },
      },
    });

    const collision = resource(true, { ARCHIVE_ENDPOINT: "portable-state-must-not-shadow" });
    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, "primary", {
        method: "POST",
        body: JSON.stringify(collision),
      }),
    );
    expect(prepared?.status).toBe(400);
    expect(await prepared?.json()).toMatchObject({ error: { code: "invalid_argument" } });
    expect(resolutionAttempts).toBe(0);
  });

  test("is tenant-specific, re-evaluated, and projects sealed material only to the driver", async () => {
    let available = true;
    const projections: TakoformStandardServiceProjection[][] = [];
    const driver: TakoformResourceDriver = {
      async apply(input) {
        projections.push([...(input.standardServices ?? [])]);
        return { observed: {} };
      },
      async observe() {
        return { observed: {} };
      },
      async delete() {},
    };
    const host = createTakoformHost({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      authenticate: async (request) => {
        const tenant =
          request.headers.get("authorization") === "Bearer unavailable" ? "tenant-b" : "tenant-a";
        return { tenantId: tenant, principalId: "principal" };
      },
      forms: [form],
      driver,
      routes: {
        hostApiVersion: "forms.takoform.com/v1beta4",
        apiPath: lane,
        supportProfileApiVersion: "support.takoform.com/v1alpha2",
        reviewSpecDigest: true,
        standardServices: {
          apiVersion: "standards.takoform.com/v1alpha1",
          protocols: ["s3-compatible"],
        },
      },
      standardServiceResolver: {
        async satisfiable(input) {
          return (
            input.tenantId === "tenant-a" &&
            input.serviceRef.protocol === "s3-compatible" &&
            available
          );
        },
        async resolve(input) {
          if (input.tenantId !== "tenant-a" || !available) return null;
          return {
            endpoint: { handle: `endpoint:${input.tenantId}:${input.slot.name}` },
            credential: { handle: `credential:${input.tenantId}:${input.slot.name}` },
          };
        },
      },
    });

    const unavailableSupport = await host.handle(
      request(`${lane}/support/standard-services/s3-compatible`, "unavailable"),
    );
    expect(await unavailableSupport?.json()).toMatchObject({ satisfiable: false });
    const desired = resource(true);
    const unavailablePrepare = await host.handle(
      request(`${lane}/resources/prepare`, "unavailable", {
        method: "POST",
        body: JSON.stringify(desired),
      }),
    );
    expect(unavailablePrepare?.status).toBe(422);
    expect(await unavailablePrepare?.json()).toMatchObject({
      error: { code: "unsupported_capability" },
    });

    const prepared = await host.handle(
      request(`${lane}/resources/prepare`, "primary", {
        method: "POST",
        body: JSON.stringify(desired),
      }),
    );
    expect(prepared?.status).toBe(200);
    if (!prepared) throw new Error("prepare returned no response");
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    available = false;
    const refusedApply = await host.handle(
      request(`${lane}/resources/example.forms.invalid/StandardClient/client`, "primary", {
        method: "PUT",
        headers: { "idempotency-key": "standard-client-create-0001", "if-none-match": "*" },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(refusedApply?.status).toBe(422);
    expect(projections).toHaveLength(0);

    available = true;
    const applied = await host.handle(
      request(`${lane}/resources/example.forms.invalid/StandardClient/client`, "primary", {
        method: "PUT",
        headers: { "idempotency-key": "standard-client-create-0002", "if-none-match": "*" },
        body: JSON.stringify({ ...desired, review }),
      }),
    );
    expect(applied?.status).toBe(201);
    expect(projections).toEqual([
      [
        {
          name: "ARCHIVE",
          required: true,
          service: {
            apiVersion: "standards.takoform.com/v1alpha1",
            protocol: "s3-compatible",
          },
          endpoint: { handle: "endpoint:tenant-a:ARCHIVE" },
          credential: { handle: "credential:tenant-a:ARCHIVE" },
        },
      ],
    ]);
    const portable = JSON.stringify(await applied?.json());
    expect(portable).not.toContain("endpoint:tenant-a");
    expect(portable).not.toContain("credential:tenant-a");
  });
});

function resource(required: boolean, vars: Record<string, string> = {}) {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name: "client", space: "main" },
    spec: {
      vars,
      externalServices: [
        {
          name: "ARCHIVE",
          required,
          service: {
            apiVersion: "standards.takoform.com/v1alpha1",
            protocol: "s3-compatible",
          },
        },
      ],
    },
  };
}

function request(path: string, token: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://candidate.invalid${path}`, { ...init, headers });
}
