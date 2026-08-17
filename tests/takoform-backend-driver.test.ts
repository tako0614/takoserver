import { describe, expect, test } from "bun:test";
import type { BackendOffering } from "../src/backends.ts";
import {
  BackendTakoformResourceDriver,
  createHttpHandler,
  createTakoformHost,
  createTakoserver,
  PortableFakeBackend,
  TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM,
  TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM,
} from "../src/index.ts";

const offering: BackendOffering = {
  id: "storage.object.standard",
  kind: "object_bucket",
  displayName: "Standard object storage",
  form: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_FORM,
  price: { currency: "USD", unit: "resource_month", unitPriceMinor: 300 },
  allowances: [{ protocol: "s3", mode: "direct", authority: "resource_scoped_grant" }],
};

describe("Takoform backend lifecycle", () => {
  test("drives create, observe, and delete through one exact backend offering", async () => {
    const backend = new PortableFakeBackend("portable-storage", [offering]);
    let randomSequence = 0;
    const host = createTakoformHost({
      authenticate: async (authorization) =>
        authorization === "Bearer provider-key"
          ? { tenantId: "organization-a", principalId: "provider-key" }
          : null,
      forms: [TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM],
      driver: new BackendTakoformResourceDriver([backend]),
      clock: () => new Date("2026-08-17T12:00:00.000Z"),
      randomId: () => `backend-lifecycle-${++randomSequence}`,
    });
    const handler = createHttpHandler({
      server: createTakoserver({
        identity: {
          async verify() {
            return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
          },
        },
        backends: [backend],
      }),
      publicOrigin: "https://api.takoserver.com",
      takoformHost: host,
    });
    const base = "/apis/forms.takoform.com/v1beta1";
    const formRef = TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM.identity.formRef;
    const resource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "backend-bucket", space: "provider-space" },
      spec: {},
    };
    const auth = { authorization: "Bearer provider-key" };

    const prepared = await jsonRequest(
      handler,
      "POST",
      `${base}/resources/prepare`,
      resource,
      auth,
    );
    expect(prepared.status).toBe(200);
    const review = recordValue(prepared.body.review);
    const prepareDigest = stringValue(review.prepareDigest);
    const resourcePath = `${base}/resources/edge.forms.takoform.com/v1beta1/ObjectBucket/backend-bucket`;
    const created = await jsonRequest(
      handler,
      "PUT",
      resourcePath,
      { ...resource, review: { prepareDigest } },
      { ...auth, "idempotency-key": "backend-create-001", "if-none-match": "*" },
    );
    expect(created.status).toBe(201);
    expect(backend.listResources()).toEqual([
      expect.objectContaining({
        nativeId: "portable-storage:organization-a/provider-space/backend-bucket",
      }),
    ]);

    const exactQuery = new URLSearchParams({
      space: "provider-space",
      group: formRef.apiVersion,
      kind: formRef.kind,
      definitionVersion: formRef.definitionVersion,
      schemaDigest: formRef.schemaDigest,
    });
    const observed = await jsonRequest(
      handler,
      "POST",
      `${resourcePath}/observe?${exactQuery}`,
      undefined,
      {
        ...auth,
        "idempotency-key": "backend-observe-001",
        "takoform-expected-generation": "1",
      },
    );
    expect(observed.status).toBe(200);
    expect(observed.body).toMatchObject({
      resource: { metadata: { generation: "1", revision: "1" } },
    });

    const deleted = await jsonRequest(
      handler,
      "DELETE",
      `${resourcePath}?${exactQuery}`,
      undefined,
      {
        ...auth,
        "idempotency-key": "backend-delete-001",
        "takoform-expected-generation": "1",
      },
    );
    expect(deleted.status).toBe(204);
    expect(backend.listResources()).toEqual([]);
  });

  test("rejects ambiguous backend ownership before provisioning", async () => {
    const first = new PortableFakeBackend("first", [offering]);
    const second = new PortableFakeBackend("second", [
      { ...offering, id: "storage.object.second" },
    ]);
    const driver = new BackendTakoformResourceDriver([first, second]);

    await expect(
      driver.apply({
        operationId: "ambiguous-operation",
        tenantId: "organization-a",
        form: TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM,
        name: "ambiguous-bucket",
        space: "provider-space",
        spec: {},
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(first.listResources()).toEqual([]);
    expect(second.listResources()).toEqual([]);
  });
});

async function jsonRequest(
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`https://api.takoserver.com${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    status: response.status,
    body: response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("record required");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("string required");
  return value;
}
