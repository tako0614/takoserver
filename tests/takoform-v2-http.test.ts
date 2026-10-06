import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { isV2FormUrl, parseV2BaseUrl } from "../src/takoform-v2/identity.ts";
import { createTakoformV2Routes } from "../src/takoform-v2/routes.ts";
import type { V2Backend, V2Form } from "../src/takoform-v2/types.ts";

const FIXTURE_FORM = "https://Forms.Example/fixture-only/key-value/1.0.0";
const BASE_URL = "https://host.example/custom/takoform-v2";
const ROOT = "/custom/takoform-v2";
const KEY_A = "create-key-0000001";
const KEY_B = "create-key-0000002";
const KEY_C = "update-key-0000001";
const KEY_D = "delete-key-0000001";
// Test-only stable key; production composition obtains its own private key.
const FIXTURE_CURSOR_KEY = new Uint8Array(32).fill(0x5a);

function fixtureBackend() {
  let firstExecution = true;
  const calls: string[] = [];
  const backend: V2Backend = {
    id: "fixture-only-backend",
    targetKey: "fixture-only-target",
    async execute(input) {
      calls.push(`execute:${input.action}`);
      if (firstExecution) {
        firstExecution = false;
        return {
          kind: "unknown",
          code: "fixture_response_lost",
          message: "fixture-only unknown result",
        };
      }
      return { kind: "complete", observed: { fixtureOnly: true }, output: {} };
    },
    async reconcile(input) {
      calls.push(`reconcile:${input.action}`);
      return { kind: "complete", observed: { fixtureOnly: true }, output: {} };
    },
  };
  return { backend, calls };
}

function setup() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const { backend, calls } = fixtureBackend();
  let fixtureNow = Date.now();
  const fixtureForm: V2Form = {
    validateCreate(spec) {
      if (typeof spec.value !== "string") throw new Error("fixture spec requires a string value");
    },
    validateUpdate(_previous, spec) {
      if (typeof spec.value !== "string") throw new Error("fixture spec requires a string value");
    },
    backend,
  };
  const engine = createTakoformV2Engine({
    sql: createSqliteSql(database),
    now: () => new Date(fixtureNow),
    replayWindowSeconds: 300,
    leaseMilliseconds: 1,
    authorize: async (principal, space, access) =>
      principal === "fixture-principal" &&
      space === "fixture-space" &&
      (access === "read" || access === "write"),
    forms: { [FIXTURE_FORM]: fixtureForm },
  });
  const router = createTakoformV2Routes(engine, {
    baseUrl: BASE_URL,
    documentation: "https://docs.example/takoform-v2",
    authenticationDocumentation: "https://docs.example/takoform-v2/authentication",
    authenticationSchemes: ["Bearer"],
    maxRequestBytes: 4_096,
    maxPageSize: 10,
    replayWindowSeconds: 300,
    cursorSigningKey: FIXTURE_CURSOR_KEY,
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-token"
        ? { principal: "fixture-principal", access: "write" }
        : request.headers.get("authorization") === "Bearer other-token"
          ? { principal: "other-principal", access: "write" }
          : request.headers.get("authorization") === "Bearer fixture-reader"
            ? { principal: "fixture-principal", access: "read" }
            : null,
  });
  return {
    database,
    engine,
    router,
    calls,
    advanceClock: () => {
      fixtureNow += 1_000;
    },
  };
}

function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request(`https://host.example${ROOT}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      authorization: "Bearer fixture-token",
      ...init.headers,
    },
  });
}

async function response(
  router: ReturnType<typeof createTakoformV2Routes>,
  request: Request,
): Promise<Response> {
  const result = await router.fetch(request);
  if (!result) throw new Error("expected the Takoform v2 router to handle this request");
  return result;
}

test("v2 discovery accepts a bare configured origin and declares optional capabilities false", async () => {
  const { engine, database } = setup();
  const router = createTakoformV2Routes(engine, {
    baseUrl: "https://HOST.example",
    documentation: "https://docs.example/takoform-v2",
    authenticationDocumentation: "https://docs.example/takoform-v2/authentication",
    authenticationSchemes: ["Bearer"],
    maxRequestBytes: 4_096,
    maxPageSize: 10,
    replayWindowSeconds: 300,
    cursorSigningKey: FIXTURE_CURSOR_KEY,
    authenticate: async () => null,
  });
  const result = await router.fetch(new Request("https://host.example/.well-known/takoform/v2"));
  expect(result?.status).toBe(200);
  expect(await result?.json()).toMatchObject({
    api: "forms.takoform.com/v2",
    baseUrl: "https://HOST.example",
    capabilities: { offerings: false, previews: false, privateInputs: false },
  });
  expect(isV2FormUrl(FIXTURE_FORM)).toBe(true);
  expect(isV2FormUrl("https://forms.example/fixture-only/key-value/1.0.0")).toBe(true);
  expect(isV2FormUrl("https://user@forms.example/fixture-only/key-value/1.0.0")).toBe(false);
  expect(isV2FormUrl("https://forms.example/fixture-only/key-value/1.0.0?")).toBe(false);
  expect(isV2FormUrl("https://forms.example/fixture-only/key-value/1.0.0#")).toBe(false);
  expect(() => parseV2BaseUrl("https://user@host.example/api")).toThrow();
  expect(() => parseV2BaseUrl("https://host.example/api?")).toThrow();
  expect(() => parseV2BaseUrl("https://host.example/api#")).toThrow();
  database.close();
});

test("public v2 routes drive the durable engine without GET-triggered execution", async () => {
  const { database, engine, router, calls, advanceClock } = setup();
  try {
    const support = await response(
      router,
      call(`/support?form=${encodeURIComponent(FIXTURE_FORM)}`, { method: "GET" }),
    );
    expect(support.status).toBe(200);
    expect(await support.json()).toEqual({
      form: FIXTURE_FORM,
      supported: true,
      operations: ["create", "read", "update", "delete"],
      privateInputs: false,
    });

    const unsupported = await response(
      router,
      call(
        `/support?form=${encodeURIComponent("https://forms.example/fixture-only/key-value/1.0.0")}`,
        { method: "GET" },
      ),
    );
    expect(await unsupported.json()).toMatchObject({
      supported: false,
      operations: [],
      privateInputs: false,
    });
    const unsupportedCapability = await response(router, call("/previews", { method: "POST" }));
    expect(unsupportedCapability.status).toBe(404);
    expect((await unsupportedCapability.json()).code).toBe("capability_unavailable");

    const created = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": KEY_A },
        body: JSON.stringify({
          form: FIXTURE_FORM,
          space: "fixture-space",
          name: "alpha",
          spec: { value: "one" },
        }),
      }),
    );
    expect(created.status).toBe(202);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(created.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/u);
    const accepted = (await created.json()) as { id: string; resourceUid: string; status: string };
    expect(accepted.status).toBe("queued");
    expect(created.headers.get("location")).toBe(`${BASE_URL}/operations/${accepted.id}`);
    expect(calls).toEqual([]);

    const resourceBeforeExecution = await response(
      router,
      call(`/resources/${accepted.resourceUid}`, { method: "GET" }),
    );
    expect(resourceBeforeExecution.status).toBe(200);
    expect((await resourceBeforeExecution.json()).phase).toBe("pending");
    const operationBeforeExecution = await response(
      router,
      call(`/operations/${accepted.id}`, { method: "GET" }),
    );
    expect((await operationBeforeExecution.json()).status).toBe("queued");
    expect(calls).toEqual([]);

    const unknown = await engine.runNext();
    expect(unknown?.status).toBe("reconciling");
    const reconcilingResponse = await response(
      router,
      call(`/operations/${accepted.id}`, { method: "GET" }),
    );
    expect((await reconcilingResponse.json()).status).toBe("reconciling");
    advanceClock();
    const complete = await engine.runNext();
    expect(complete?.status).toBe("succeeded");
    const completedResource = await response(
      router,
      call(`/resources/${accepted.resourceUid}`, { method: "GET" }),
    );
    expect(await completedResource.json()).toMatchObject({
      phase: "idle",
      generation: 1,
      observedGeneration: 1,
    });

    const second = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": KEY_B },
        body: JSON.stringify({
          form: FIXTURE_FORM,
          space: "fixture-space",
          name: "beta",
          spec: { value: "two" },
        }),
      }),
    );
    expect(second.status).toBe(202);
    const page = await response(
      router,
      call("/resources?space=fixture-space&limit=1", { method: "GET" }),
    );
    const firstPage = (await page.json()) as {
      items: Array<{ uid: string }>;
      nextCursor: string | null;
    };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = firstPage.nextCursor;
    if (cursor === null) throw new Error("fixture page should have a next cursor");
    const pageTwo = await response(
      router,
      call(`/resources?space=fixture-space&limit=1&cursor=${encodeURIComponent(cursor)}`, {
        method: "GET",
      }),
    );
    expect(
      ((await pageTwo.json()) as { items: unknown[]; nextCursor: unknown }).items,
    ).toHaveLength(1);
    const tamperedCursor = tamperCursor(cursor);
    const tampered = await response(
      router,
      call(`/resources?space=fixture-space&limit=1&cursor=${encodeURIComponent(tamperedCursor)}`, {
        method: "GET",
      }),
    );
    expect(tampered.status).toBe(400);
    const otherPrincipal = await response(
      router,
      call(`/resources?space=fixture-space&limit=1&cursor=${encodeURIComponent(cursor)}`, {
        method: "GET",
        headers: { authorization: "Bearer other-token" },
      }),
    );
    expect(otherPrincipal.status).toBe(400);
    const mismatchedCursor = await response(
      router,
      call(`/resources?name=alpha&cursor=${encodeURIComponent(cursor)}`, { method: "GET" }),
    );
    expect(mismatchedCursor.status).toBe(400);
    expect((await engine.runNext())?.action).toBe("create");

    const updated = await response(
      router,
      call(`/resources/${accepted.resourceUid}`, {
        method: "PUT",
        headers: { "idempotency-key": KEY_C, "takoform-expected-generation": "1" },
        body: JSON.stringify({ spec: { value: "updated" } }),
      }),
    );
    expect(updated.status).toBe(202);
    const updateOperation = (await updated.json()) as { id: string };
    expect((await engine.runNext())?.id).toBe(updateOperation.id);
    const stale = await response(
      router,
      call(`/resources/${accepted.resourceUid}`, {
        method: "PUT",
        headers: { "idempotency-key": "update-key-0000002", "takoform-expected-generation": "1" },
        body: JSON.stringify({ spec: { value: "stale" } }),
      }),
    );
    expect(stale.status).toBe(409);

    const deleted = await response(
      router,
      call(`/resources/${accepted.resourceUid}`, {
        method: "DELETE",
        headers: { "idempotency-key": KEY_D, "takoform-expected-generation": "2" },
      }),
    );
    expect(deleted.status).toBe(202);
    expect(
      (
        await engine.getOperation({
          principal: "fixture-principal",
          id: ((await deleted.json()) as { id: string }).id,
        })
      ).action,
    ).toBe("delete");
  } finally {
    database.close();
  }
});

test("v2 rejects ambiguous requests and keeps authentication and errors uncacheable", async () => {
  const { database, router } = setup();
  try {
    const unauthenticated = await response(
      router,
      call("/resources", { method: "GET", headers: { authorization: "" } }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");
    expect(unauthenticated.headers.get("cache-control")).toBe("no-store");

    const duplicateQuery = await response(
      router,
      call("/resources?limit=1&limit=2", { method: "GET" }),
    );
    expect(duplicateQuery.status).toBe(400);
    expect(duplicateQuery.headers.get("content-type")).toBe("application/problem+json");
    expect(duplicateQuery.headers.get("cache-control")).toBe("no-store");

    const duplicateJson = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": KEY_A },
        body: `{"form":"${FIXTURE_FORM}","form":"${FIXTURE_FORM}","space":"fixture-space","name":"bad","spec":{}}`,
      }),
    );
    expect(duplicateJson.status).toBe(400);
    expect((await duplicateJson.json()).code).toBe("invalid_request");

    const lossyInteger = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": "create-key-0000003" },
        body: `{"form":"${FIXTURE_FORM}","space":"fixture-space","name":"lossy","spec":{"value":"n","number":9007199254740993}}`,
      }),
    );
    expect(lossyInteger.status).toBe(400);

    const lossyFraction = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": "create-key-0000004" },
        body: `{"form":"${FIXTURE_FORM}","space":"fixture-space","name":"lossy-fraction","spec":{"value":"n","number":0.10000000000000001}}`,
      }),
    );
    expect(lossyFraction.status).toBe(400);

    const validNegativeFraction = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": "create-key-0000005" },
        body: `{"form":"${FIXTURE_FORM}","space":"fixture-space","name":"negative-fraction","spec":{"value":"n","number":-0.125}}`,
      }),
    );
    expect(validNegativeFraction.status).toBe(202);

    const equivalentNumber = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": "create-key-0000006" },
        body: `{"form":"${FIXTURE_FORM}","space":"fixture-space","name":"equivalent","spec":{"value":"n","number":1.0e0}}`,
      }),
    );
    expect(equivalentNumber.status).toBe(202);
    const equivalentOperation = (await equivalentNumber.json()) as { id: string };
    const equivalentReplay = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": "create-key-0000006" },
        body: JSON.stringify({
          form: FIXTURE_FORM,
          space: "fixture-space",
          name: "equivalent",
          spec: { value: "n", number: 1 },
        }),
      }),
    );
    expect(((await equivalentReplay.json()) as { id: string }).id).toBe(equivalentOperation.id);

    const longZeroEquivalent = `1${"0".repeat(2_000)}e-2000`;
    const longZeroValue = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": "create-key-0000007" },
        body: `{"form":"${FIXTURE_FORM}","space":"fixture-space","name":"long-zero-equivalent","spec":{"value":"n","number":${longZeroEquivalent}}}`,
      }),
    );
    expect(longZeroValue.status).toBe(202);

    const longInternalZeroLoss = `1${"0".repeat(2_000)}1e-2000`;
    const rejectedLongInternalZero = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": "create-key-0000008" },
        body: `{"form":"${FIXTURE_FORM}","space":"fixture-space","name":"long-internal-zero-loss","spec":{"value":"n","number":${longInternalZeroLoss}}}`,
      }),
    );
    expect(rejectedLongInternalZero.status).toBe(400);

    const privateInputs = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": KEY_A },
        body: JSON.stringify({
          form: FIXTURE_FORM,
          space: "fixture-space",
          name: "private",
          spec: {},
          privateInputs: {},
        }),
      }),
    );
    expect(privateInputs.status).toBe(422);
    expect((await privateInputs.json()).code).toBe("capability_required");

    const deleteBody = await response(
      router,
      call("/resources/not-a-real-uid", {
        method: "DELETE",
        headers: { "idempotency-key": KEY_D, "takoform-expected-generation": "1" },
        body: " ",
      }),
    );
    expect(deleteBody.status).toBe(400);

    expect(
      await router.fetch(new Request("https://host.example/custom/takoform-v2/v1/resources")),
    ).toBeNull();
  } finally {
    database.close();
  }
});

test("v2 checks each credential's write grant before mutation and replay, without sharing request authority", async () => {
  const { database, router } = setup();
  const input = {
    form: FIXTURE_FORM,
    space: "fixture-space",
    name: "scoped",
    spec: { value: "one" },
  };
  const reader = { authorization: "Bearer fixture-reader" };
  try {
    const created = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": KEY_A },
        body: JSON.stringify(input),
      }),
    );
    expect(created.status).toBe(202);
    const accepted = (await created.json()) as { id: string; resourceUid: string };
    for (const path of [
      `/support?form=${encodeURIComponent(FIXTURE_FORM)}`,
      `/resources/${accepted.resourceUid}`,
      `/operations/${accepted.id}`,
      "/resources",
    ]) {
      expect((await response(router, call(path, { headers: reader }))).status).toBe(200);
    }

    for (const request of [
      call("/resources", {
        method: "POST",
        headers: { ...reader, "idempotency-key": KEY_A },
        body: JSON.stringify(input),
      }),
      call(`/resources/${accepted.resourceUid}`, {
        method: "PUT",
        headers: {
          ...reader,
          "idempotency-key": KEY_C,
          "takoform-expected-generation": "1",
        },
        body: JSON.stringify({ spec: { value: "changed" } }),
      }),
      call(`/resources/${accepted.resourceUid}`, {
        method: "DELETE",
        headers: {
          ...reader,
          "idempotency-key": KEY_D,
          "takoform-expected-generation": "1",
        },
      }),
    ]) {
      const denied = await response(router, request);
      expect(denied.status).toBe(403);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      expect((await denied.json()).code).toBe("forbidden");
    }

    const concurrent = await Promise.all(
      [false, true].map((readOnly) =>
        response(
          router,
          call("/resources", {
            method: "POST",
            headers: {
              ...(readOnly ? reader : {}),
              "idempotency-key": readOnly ? "reader-create-00001" : KEY_B,
            },
            body: JSON.stringify({ ...input, name: readOnly ? "denied" : "allowed" }),
          }),
        ),
      ),
    );
    expect(concurrent.map((item) => item.status)).toEqual([202, 403]);
    const unchanged = await response(
      router,
      call(`/resources/${accepted.resourceUid}`, { headers: reader }),
    );
    expect(await unchanged.json()).toMatchObject({ generation: 1, spec: input.spec });
    const inventory = await response(router, call("/resources", { headers: reader }));
    expect(((await inventory.json()) as { items: unknown[] }).items).toHaveLength(2);
    const replay = await response(
      router,
      call("/resources", {
        method: "POST",
        headers: { "idempotency-key": KEY_A },
        body: JSON.stringify(input),
      }),
    );
    expect((await replay.json()).id).toBe(accepted.id);
  } finally {
    database.close();
  }
});

function tamperCursor(cursor: string): string {
  const [version, encodedPayload, signature] = cursor.split(".");
  if (version !== "v1" || !encodedPayload || !signature) throw new Error("invalid fixture cursor");
  const base64 = encodedPayload.replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const payloadBytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as { after: string };
  payload.after = "tampered-after";
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const changed = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${version}.${changed}.${signature}`;
}
