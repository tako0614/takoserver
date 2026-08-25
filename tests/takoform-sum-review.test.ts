import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createTakoformHost } from "../src/takoform/host.ts";
import type { InstalledTakoformForm, TakoformResourceDriver } from "../src/takoform/types.ts";
import { createConfiguredHistoricalTakoformHost } from "./helpers/historical-takoform-host.ts";

const lane = "/apis/forms.takoform.com/v1beta4";
const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "WeightedThing",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"9".repeat(64)}`,
    },
  },
  constraints: [{ kind: "sum", list: "/weights", member: "weight", total: 100 }],
  desiredSchema: {
    type: "object",
    properties: {
      weights: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: { weight: { type: "integer" } },
          required: ["weight"],
          additionalProperties: false,
        },
      },
    },
    required: ["weights"],
    additionalProperties: false,
  },
  operations: ["create", "read", "delete"],
};

test("validate and prepare reject a desired document that violates its declared sum", async () => {
  const driver: TakoformResourceDriver = {
    async apply() {
      throw new Error("review must fail before provider apply");
    },
    async observe() {
      throw new Error("review must not observe a resource");
    },
    async delete() {},
  };
  const host = createConfiguredHistoricalTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver,
    routes: {
      hostApiVersion: "forms.takoform.com/v1beta4",
      apiPath: lane,
      supportProfileApiVersion: "support.takoform.com/v1alpha2",
      reviewSpecDigest: true,
    },
  });
  const desired = {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name: "weighted", space: "main" },
    spec: { weights: [{ weight: 60 }, { weight: 30 }] },
  };

  const validated = await host.handle(request("validate", desired));
  expect(validated?.status).toBe(200);
  expect(await validated?.json()).toMatchObject({
    valid: false,
    diagnostics: [{ severity: "error", message: "invalid_argument" }],
  });

  const prepared = await host.handle(request("prepare", desired));
  expect(prepared?.status).toBe(400);
  expect(await prepared?.json()).toMatchObject({ error: { code: "invalid_argument" } });
});

test("stable v1 binds a schema-valid prepare and enforces the declared sum before mutation", async () => {
  let applyCalls = 0;
  const driver: TakoformResourceDriver = {
    async apply(input) {
      applyCalls += 1;
      return { observed: input.spec };
    },
    async observe(input) {
      return { observed: input.resource.spec };
    },
    async delete() {},
  };
  const host = createTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver,
  });
  const desired = {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name: "stable-weighted", space: "main" },
    spec: { weights: [{ weight: 60 }, { weight: 30 }] },
  };

  const prepared = await host.handle(
    new Request("https://candidate.invalid/apis/forms.takoform.com/v1/resources/prepare", {
      method: "POST",
      headers: { authorization: "Bearer primary", "content-type": "application/json" },
      body: JSON.stringify(desired),
    }),
  );
  expect(prepared?.status).toBe(200);
  if (!prepared) throw new Error("stable prepare did not return a response");
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;

  const applied = await host.handle(
    new Request(
      "https://candidate.invalid/apis/forms.takoform.com/v1/resources/example.forms.invalid/WeightedThing/stable-weighted",
      {
        method: "PUT",
        headers: {
          authorization: "Bearer primary",
          "content-type": "application/json",
          "idempotency-key": "stable-sum-apply-0001",
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...desired, review }),
      },
    ),
  );
  expect(applied?.status).toBe(400);
  expect(await applied?.json()).toMatchObject({ error: { code: "invalid_argument" } });
  expect(applyCalls).toBe(0);
});

function request(operation: "validate" | "prepare", body: unknown): Request {
  return new Request(`https://candidate.invalid${lane}/resources/${operation}`, {
    method: "POST",
    headers: { authorization: "Bearer primary", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
