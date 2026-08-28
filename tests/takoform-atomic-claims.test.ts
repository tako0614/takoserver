import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverReceipt,
  TakoformResourceDriver,
} from "../src/takoform/types.ts";
import {
  createConfiguredHistoricalTakoformHost,
  createStaticStableTestTakoformHost,
} from "./helpers/historical-takoform-host.ts";

const lane = "/apis/forms.takoform.com/v1beta4";
const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "ClaimedName",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"c".repeat(64)}`,
    },
  },
  constraints: [{ kind: "claim", property: "/claim" }],
  desiredSchema: {
    type: "object",
    properties: { claim: { type: "string" } },
    required: ["claim"],
    additionalProperties: false,
  },
  operations: ["create", "read", "delete", "import"],
};

test("a create reserves a Definition claim atomically across provider await and blocks a racing import", async () => {
  let releaseFirst = () => {};
  const blocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let enteredFirst = () => {};
  const entered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  let applyCalls = 0;
  let importCalls = 0;
  const receipt = (spec: JsonObject): TakoformDriverReceipt => ({ observed: spec });
  const driver: TakoformResourceDriver = {
    async apply(input) {
      applyCalls += 1;
      enteredFirst();
      await blocked;
      return receipt(input.spec);
    },
    async import(input) {
      importCalls += 1;
      return receipt(input.spec);
    },
    async observe(input) {
      return receipt(input.resource.spec);
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

  const desired = resource("create-holder");
  const prepared = await host.handle(jsonRequest(`${lane}/resources/prepare`, "POST", desired));
  if (!prepared?.ok) throw new Error("prepare failed");
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;
  const creating = host.handle(
    jsonRequest(
      `${lane}/resources/example.forms.invalid/ClaimedName/create-holder`,
      "PUT",
      { ...desired, review },
      { "idempotency-key": "claim-create-0001", "if-none-match": "*" },
    ),
  );
  await entered;

  const imported = await host.handle(
    jsonRequest(
      `${lane}/resources/example.forms.invalid/ClaimedName/import-holder/import`,
      "POST",
      { ...resource("import-holder"), nativeId: "native-import-holder" },
      { "idempotency-key": "claim-import-0001", "if-none-match": "*" },
    ),
  );
  expect(imported?.status).toBe(400);
  expect(await imported?.json()).toMatchObject({ error: { code: "invalid_argument" } });
  expect(applyCalls).toBe(1);
  expect(importCalls).toBe(0);

  releaseFirst();
  expect((await creating)?.status).toBe(201);

  const query = new URLSearchParams({
    space: "main",
    group: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    definitionVersion: form.identity.formRef.definitionVersion,
    schemaDigest: form.identity.formRef.schemaDigest,
  });
  const deleted = await host.handle(
    new Request(
      `https://candidate.invalid${lane}/resources/example.forms.invalid/ClaimedName/create-holder?${query}`,
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer primary",
          "idempotency-key": "claim-create-delete-0001",
          "takoform-expected-generation": "1",
        },
      },
    ),
  );
  expect(deleted?.status).toBe(204);

  const retried = await host.handle(
    jsonRequest(
      `${lane}/resources/example.forms.invalid/ClaimedName/import-holder/import`,
      "POST",
      { ...resource("import-holder"), nativeId: "native-import-holder" },
      { "idempotency-key": "claim-import-0002", "if-none-match": "*" },
    ),
  );
  expect(retried?.status).toBe(201);
  expect(importCalls).toBe(1);
});

test("stable prepare rejects a claim already held by another live resource", async () => {
  const durable = createEphemeralSql();
  let inspectPrepareReads = false;
  let formResourceEnumerations = 0;
  const sql: Sql = {
    query: async (statement, params) => {
      const normalized = statement.replaceAll(/\s+/gu, " ").trim();
      if (
        inspectPrepareReads &&
        normalized.includes(
          "FROM tf_resources WHERE tenant_id = ? AND api_version = ? AND kind = ?",
        )
      ) {
        formResourceEnumerations += 1;
      }
      return durable.query(statement, params);
    },
    run: (statement, params) => durable.run(statement, params),
    batch: (statements) => durable.batch(statements),
  };
  const host = createStaticStableTestTakoformHost({
    sql,
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver: new InMemoryTakoformResourceDriver(),
  });
  const stableLane = "/apis/forms.takoform.com/v1";
  const holder = resource("stable-holder");
  const prepared = await host.handle(
    jsonRequest(`${stableLane}/resources/prepare`, "POST", holder),
  );
  expect(prepared?.status).toBe(200);
  if (!prepared) throw new Error("stable prepare did not return a response");
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;
  const created = await host.handle(
    jsonRequest(
      `${stableLane}/resources/example.forms.invalid/ClaimedName/stable-holder`,
      "PUT",
      { ...holder, review },
      { "idempotency-key": "stable-claim-create-0001", "if-none-match": "*" },
    ),
  );
  expect(created?.status).toBe(201);
  if (!created) throw new Error("stable holder create did not return a response");
  const generation = String(
    ((await created.json()) as { metadata?: { generation?: unknown } }).metadata?.generation,
  );

  const restated = await host.handle(
    jsonRequest(`${stableLane}/resources/prepare`, "POST", holder, {
      "takoform-expected-generation": generation,
    }),
  );
  expect(restated?.status).toBe(200);
  if (!restated) throw new Error("stable holder restatement did not return a response");
  const restatedReview = ((await restated.json()) as { review: Record<string, string> }).review;
  const noOp = await host.handle(
    jsonRequest(
      `${stableLane}/resources/example.forms.invalid/ClaimedName/stable-holder`,
      "PUT",
      { ...holder, review: restatedReview },
      {
        "idempotency-key": "stable-claim-no-op-0001",
        "takoform-expected-generation": generation,
      },
    ),
  );
  expect(noOp?.status).toBe(200);

  inspectPrepareReads = true;
  const collision = await host.handle(
    jsonRequest(`${stableLane}/resources/prepare`, "POST", resource("stable-contender")),
  );
  expect(collision?.status).toBe(400);
  expect(await collision?.json()).toMatchObject({
    error: { code: "invalid_argument", details: { holder: "stable-holder" } },
  });
  expect(formResourceEnumerations).toBe(0);
});

test("scoped credentials do not disclose a foreign claim holder", async () => {
  const scopedResourceName = "scoped-contender";
  const host = createStaticStableTestTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async (request) => {
      if (request.headers.get("authorization") === "Bearer scoped") {
        return {
          tenantId: "tenant-a",
          principalId: "scoped-principal",
          scope: {
            space: "main",
            formRef: form.identity.formRef,
            resourceName: scopedResourceName,
            mode: "manage" as const,
          },
        };
      }
      if (request.headers.get("authorization") === "Bearer tenant-run") {
        return {
          tenantId: "tenant-a",
          principalId: "tenant-run-principal",
          scope: { space: "main", mode: "tenant-run" as const },
        };
      }
      return { tenantId: "tenant-a", principalId: "organization-principal" };
    },
    forms: [form],
    driver: new InMemoryTakoformResourceDriver(),
  });
  const stableLane = "/apis/forms.takoform.com/v1";
  const foreignHolder = {
    ...resource("foreign-holder"),
    metadata: { name: "foreign-holder", space: "foreign" },
  };
  const prepared = await host.handle(
    jsonRequest(`${stableLane}/resources/prepare`, "POST", foreignHolder),
  );
  expect(prepared?.status).toBe(200);
  if (!prepared) throw new Error("foreign holder prepare did not return a response");
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;
  const created = await host.handle(
    jsonRequest(
      `${stableLane}/resources/example.forms.invalid/ClaimedName/foreign-holder`,
      "PUT",
      { ...foreignHolder, review },
      { "idempotency-key": "foreign-claim-create-0001", "if-none-match": "*" },
    ),
  );
  expect(created?.status).toBe(201);

  const collision = await host.handle(
    jsonRequest(`${stableLane}/resources/prepare`, "POST", resource(scopedResourceName), {
      authorization: "Bearer scoped",
    }),
  );
  expect(collision?.status).toBe(400);
  const body = (await collision?.json()) as {
    readonly error?: { readonly code?: unknown; readonly details?: unknown };
  };
  expect(body.error?.code).toBe("invalid_argument");
  expect(body.error?.details).toBeUndefined();

  const tenantRunCollision = await host.handle(
    jsonRequest(`${stableLane}/resources/prepare`, "POST", resource("tenant-run-contender"), {
      authorization: "Bearer tenant-run",
    }),
  );
  expect(tenantRunCollision?.status).toBe(400);
  const tenantRunBody = (await tenantRunCollision?.json()) as {
    readonly error?: { readonly code?: unknown; readonly details?: unknown };
  };
  expect(tenantRunBody.error?.code).toBe("invalid_argument");
  expect(tenantRunBody.error?.details).toBeUndefined();
});

test("an expired reservation can be recovered but its stale provider winner cannot commit", async () => {
  let now = Date.parse("2026-08-23T00:00:00.000Z");
  let releaseFirst = () => {};
  const blocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let enteredFirst = () => {};
  const entered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  const receipt = (spec: JsonObject): TakoformDriverReceipt => ({ observed: spec });
  const driver: TakoformResourceDriver = {
    async apply(input) {
      enteredFirst();
      await blocked;
      return receipt(input.spec);
    },
    async import(input) {
      return receipt(input.spec);
    },
    async observe(input) {
      return receipt(input.resource.spec);
    },
    async delete() {},
  };
  const sql = createEphemeralSql();
  const host = createConfiguredHistoricalTakoformHost({
    sql,
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
    clock: () => new Date(now),
  });

  const desired = resource("stale-create-holder");
  const prepared = await host.handle(jsonRequest(`${lane}/resources/prepare`, "POST", desired));
  if (!prepared?.ok) throw new Error("prepare failed");
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;
  const creating = host.handle(
    jsonRequest(
      `${lane}/resources/example.forms.invalid/ClaimedName/stale-create-holder`,
      "PUT",
      { ...desired, review },
      { "idempotency-key": "stale-claim-create-0001", "if-none-match": "*" },
    ),
  );
  await entered;

  now += 5 * 60_000 + 1;
  const imported = await host.handle(
    jsonRequest(
      `${lane}/resources/example.forms.invalid/ClaimedName/recovered-import-holder/import`,
      "POST",
      { ...resource("recovered-import-holder"), nativeId: "native-recovered-import-holder" },
      { "idempotency-key": "recovered-claim-import-0001", "if-none-match": "*" },
    ),
  );
  expect(imported?.status).toBe(201);

  releaseFirst();
  const stale = await creating;
  expect(stale?.status).toBe(409);
  expect(await stale?.json()).toMatchObject({ error: { code: "resource_busy" } });
  expect(
    await sql.query(
      `SELECT name FROM tf_resources
       WHERE tenant_id = 'tenant-a' AND api_version = 'example.forms.invalid'
         AND kind = 'ClaimedName' ORDER BY name`,
    ),
  ).toEqual([{ name: "recovered-import-holder" }]);
});

test("a definitive wrong-native import does not block a same-native re-import", async () => {
  const sql = createEphemeralSql();
  const host = createConfiguredHistoricalTakoformHost({
    sql,
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver: new InMemoryTakoformResourceDriver(),
    routes: {
      hostApiVersion: "forms.takoform.com/v1beta4",
      apiPath: lane,
      supportProfileApiVersion: "support.takoform.com/v1alpha2",
      reviewSpecDigest: true,
    },
  });
  const name = "native-reimport";
  const desired = resource(name);
  const path = `${lane}/resources/example.forms.invalid/ClaimedName/${name}`;
  const prepared = await host.handle(jsonRequest(`${lane}/resources/prepare`, "POST", desired));
  if (!prepared?.ok) throw new Error("prepare failed");
  const review = ((await prepared.json()) as { review: Record<string, string> }).review;

  const created = await host.handle(
    jsonRequest(
      path,
      "PUT",
      { ...desired, review },
      { "idempotency-key": "native-reimport-create", "if-none-match": "*" },
    ),
  );
  if (!created) throw new Error("create route missing");
  expect(created.status).toBe(201);
  const createdGeneration = String(
    ((await created.json()) as { metadata?: { generation?: unknown } }).metadata?.generation,
  );
  const claimed = await host.handle(
    jsonRequest(
      `${path}/import`,
      "POST",
      { ...desired, nativeId: "native-one" },
      {
        "idempotency-key": "native-reimport-claim",
        "takoform-expected-generation": createdGeneration,
      },
    ),
  );
  if (!claimed) throw new Error("import route missing");
  expect(claimed.status).toBe(200);
  const claimedGeneration = String(
    ((await claimed.json()) as { metadata?: { generation?: unknown } }).metadata?.generation,
  );

  const conflict = await host.handle(
    jsonRequest(
      `${path}/import`,
      "POST",
      { ...desired, nativeId: "native-wrong" },
      {
        "idempotency-key": "native-reimport-conflict",
        "takoform-expected-generation": claimedGeneration,
      },
    ),
  );
  expect(conflict?.status).toBe(409);
  expect(await conflict?.json()).toMatchObject({ error: { code: "import_conflict" } });

  expect(
    (
      await host.handle(
        jsonRequest(
          `${path}/import`,
          "POST",
          { ...desired, nativeId: "native-one" },
          {
            "idempotency-key": "native-reimport-same",
            "takoform-expected-generation": claimedGeneration,
          },
        ),
      )
    )?.status,
  ).toBe(200);
  expect(
    Number((await sql.query("SELECT COUNT(*) AS n FROM tf_provider_mutation_sagas"))[0]?.n),
  ).toBe(0);
});

test("a failed same-claim update cannot release the live Resource's committed claim", async () => {
  const sql = createEphemeralSql();
  const store = createTakoformStore(sql, () => new Date("2026-08-23T00:00:00.000Z"));
  const key = `claim_sha256:${"f".repeat(64)}`;
  const holder = {
    key,
    tenantId: "tenant-a",
    holderSpace: "main",
    holderApiVersion: "example.forms.invalid",
    holderKind: "ClaimedName",
    holderName: "existing",
    holderUid: "uid_existing",
  } as const;

  await store.reserveResourceClaims(
    [{ ...holder, operationId: "op_initial" }],
    Date.parse("2026-08-23T00:05:00.000Z"),
  );
  await sql.run(
    `UPDATE tf_resource_claims
     SET state = 'committed', expires_at = NULL
     WHERE claim_key = ? AND owner_operation_id = ?`,
    [key, "op_initial"],
  );

  await store.reserveResourceClaims(
    [{ ...holder, operationId: "op_failed_update" }],
    Date.parse("2026-08-23T00:05:00.000Z"),
  );
  await store.releaseResourceClaims("op_failed_update");

  expect(
    await sql.query(
      `SELECT state, holder_uid FROM tf_resource_claims
       WHERE claim_key = ?`,
      [key],
    ),
  ).toEqual([{ state: "committed", holder_uid: "uid_existing" }]);
  await expect(
    store.reserveResourceClaims(
      [
        {
          ...holder,
          holderName: "rival",
          holderUid: "uid_rival",
          operationId: "op_rival",
        },
      ],
      Date.parse("2026-08-23T00:05:00.000Z"),
    ),
  ).rejects.toThrow();
});

function resource(name: string) {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name, space: "main" },
    spec: { claim: "one-global-claim" },
  };
}

function jsonRequest(
  path: string,
  method: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`https://candidate.invalid${path}`, {
    method,
    headers: {
      authorization: "Bearer primary",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}
