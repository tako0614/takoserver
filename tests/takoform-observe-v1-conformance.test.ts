import { expect, test } from "bun:test";
import { DEFAULT_TAKOFORM_ROUTES } from "../src/takoform/routes.ts";
import type { TakoformResourceDriver } from "../src/takoform/types.ts";
import { createHistoricalTakoformHost } from "./helpers/historical-takoform-host.ts";

const FORM_REF = {
  apiVersion: "example.forms.test",
  kind: "Widget",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};

const FORM = {
  identity: { formRef: FORM_REF },
  desiredSchema: { type: "object", additionalProperties: false },
  observedSchema: {
    type: "object",
    properties: { observation: { type: "integer" } },
    required: ["observation"],
    additionalProperties: false,
  },
  operations: ["create", "read", "update", "delete", "observe"] as const,
};

const AUTH = { authorization: "Bearer host-test" };
const LANE = "/apis/forms.takoform.com/v1";
const QUERY = new URLSearchParams({
  space: "main",
  definitionVersion: FORM_REF.definitionVersion,
  schemaDigest: FORM_REF.schemaDigest,
}).toString();
const RESOURCE = {
  apiVersion: FORM_REF.apiVersion,
  kind: FORM_REF.kind,
  form: { formRef: FORM_REF },
  metadata: { name: "widget", space: "main" },
  spec: {},
};
const RESOURCE_PATH = `${LANE}/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/widget`;

class ObservationDriver implements TakoformResourceDriver {
  observations = 0;

  async apply(): Promise<{ observed: { observation: number } }> {
    return { observed: { observation: 0 } };
  }

  async observe(): Promise<{ observed: { observation: number } }> {
    this.observations += 1;
    return { observed: { observation: this.observations } };
  }

  async delete(): Promise<void> {}
}

function createHost(driver: ObservationDriver) {
  return createHistoricalTakoformHost({
    routes: { ...DEFAULT_TAKOFORM_ROUTES, omitObservedStatus: false },
    authenticate: async (authorization) =>
      authorization === AUTH.authorization
        ? { tenantId: "tenant-a", principalId: "principal-a" }
        : null,
    forms: [FORM],
    driver,
  });
}

async function request(
  host: ReturnType<typeof createHost>,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly response: Response; readonly body: Record<string, unknown> }> {
  const response = await host.handle(
    new Request(`https://api.takoserver.test${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  if (!response) throw new Error(`Host did not handle ${method} ${path}`);
  return {
    response,
    body: response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>),
  };
}

async function createResource(host: ReturnType<typeof createHost>) {
  const prepared = await request(host, "POST", `${LANE}/resources/prepare`, RESOURCE, AUTH);
  expect(prepared.response.status).toBe(200);
  const review = prepared.body.review as { readonly prepareDigest?: unknown };
  if (typeof review.prepareDigest !== "string") throw new Error("prepare digest missing");
  const created = await request(
    host,
    "PUT",
    RESOURCE_PATH,
    { ...RESOURCE, review: { prepareDigest: review.prepareDigest } },
    { ...AUTH, "idempotency-key": "create-widget", "if-none-match": "*" },
  );
  expect(created.response.status).toBe(201);
}

test("stable v1 observe is fresh, generation-fenced, and independent of idempotency keys", async () => {
  const driver = new ObservationDriver();
  const host = createHost(driver);
  await createResource(host);

  const first = await request(host, "POST", `${RESOURCE_PATH}/observe?${QUERY}`, undefined, {
    ...AUTH,
    "takoform-expected-generation": "1",
  });
  expect(first.response.status).toBe(200);
  expect(first.body.resource).toMatchObject({ status: { observed: { observation: 1 } } });

  const repeated = await request(host, "POST", `${RESOURCE_PATH}/observe?${QUERY}`, undefined, {
    ...AUTH,
    "takoform-expected-generation": "1",
  });
  expect(repeated.response.status).toBe(200);
  expect(repeated.body.resource).toMatchObject({ status: { observed: { observation: 2 } } });

  const irrelevantHeader = await request(
    host,
    "POST",
    `${RESOURCE_PATH}/observe?${QUERY}`,
    undefined,
    {
      ...AUTH,
      "idempotency-key": "same-header-does-not-replay-observe",
      "takoform-expected-generation": "1",
    },
  );
  expect(irrelevantHeader.response.status).toBe(200);
  expect(irrelevantHeader.body.resource).toMatchObject({
    status: { observed: { observation: 3 } },
  });

  const repeatedIrrelevantHeader = await request(
    host,
    "POST",
    `${RESOURCE_PATH}/observe?${QUERY}`,
    undefined,
    {
      ...AUTH,
      "idempotency-key": "same-header-does-not-replay-observe",
      "takoform-expected-generation": "1",
    },
  );
  expect(repeatedIrrelevantHeader.response.status).toBe(200);
  expect(repeatedIrrelevantHeader.body.resource).toMatchObject({
    status: { observed: { observation: 4 } },
  });
  expect(driver.observations).toBe(4);
});

test("stable v1 observe still rejects a missing or stale generation fence", async () => {
  const driver = new ObservationDriver();
  const host = createHost(driver);
  await createResource(host);

  const missing = await request(host, "POST", `${RESOURCE_PATH}/observe?${QUERY}`, undefined, AUTH);
  expect(missing.response.status).toBe(400);
  expect(missing.body).toMatchObject({ error: { code: "invalid_argument" } });

  const stale = await request(host, "POST", `${RESOURCE_PATH}/observe?${QUERY}`, undefined, {
    ...AUTH,
    "takoform-expected-generation": "2",
  });
  expect(stale.response.status).toBe(412);
  expect(stale.body).toMatchObject({ error: { code: "generation_conflict" } });
  expect(driver.observations).toBe(0);
});

test("stable v1 mutating lifecycle operations still require idempotency keys", async () => {
  const driver = new ObservationDriver();
  const host = createHost(driver);
  const prepared = await request(host, "POST", `${LANE}/resources/prepare`, RESOURCE, AUTH);
  expect(prepared.response.status).toBe(200);
  const review = prepared.body.review as { readonly prepareDigest?: unknown };
  if (typeof review.prepareDigest !== "string") throw new Error("prepare digest missing");
  const applyBody = { ...RESOURCE, review: { prepareDigest: review.prepareDigest } };

  const missingApplyKey = await request(host, "PUT", RESOURCE_PATH, applyBody, {
    ...AUTH,
    "if-none-match": "*",
  });
  expect(missingApplyKey.response.status).toBe(400);
  expect(missingApplyKey.body).toMatchObject({ error: { code: "invalid_argument" } });

  const created = await request(host, "PUT", RESOURCE_PATH, applyBody, {
    ...AUTH,
    "idempotency-key": "create-widget",
    "if-none-match": "*",
  });
  expect(created.response.status).toBe(201);

  const missingDeleteKey = await request(host, "DELETE", `${RESOURCE_PATH}?${QUERY}`, undefined, {
    ...AUTH,
    "takoform-expected-generation": "1",
  });
  expect(missingDeleteKey.response.status).toBe(400);
  expect(missingDeleteKey.body).toMatchObject({ error: { code: "invalid_argument" } });
});
