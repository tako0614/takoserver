import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type { InstalledTakoformForm, TakoformResourceDriver } from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const LANE = "/apis/forms.takoform.com/v1";
const TOKEN = "Bearer bounded-deadline-test";
const CALLER_TIMEOUT_MS = 100;
const INLINE_BUDGET_MS = 150;
const LONG_CALLER_TIMEOUT_MS = 500;

const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "DeadlineThing",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    implementationDigest: `sha256:${"b".repeat(64)}`,
  },
  desiredSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  operations: ["create", "read", "update", "delete"],
};

test("a short public PUT caller can time out before the Host operation and recover by exact replay", async () => {
  expect(CALLER_TIMEOUT_MS * 15).toBe(INLINE_BUDGET_MS * 10);

  const database = new Database(":memory:");
  migrateSqlite(database);
  const memory = new InMemoryTakoformResourceDriver();
  const gates = [deferred<void>(), deferred<void>()];
  const entered = [deferred<void>(), deferred<void>()];
  let providerCalls = 0;
  const driver: TakoformResourceDriver = {
    ...memory,
    selectApply: (input) => memory.selectApply(input),
    apply: async (input) => {
      const call = providerCalls++;
      const gate = gates[call];
      const started = entered[call];
      if (!gate || !started) throw new Error("unexpected provider dispatch count");
      started.resolve();
      await gate.promise;
      return await memory.apply(input);
    },
    observe: (input) => memory.observe(input),
    delete: (input) => memory.delete(input),
  };
  const host = createStaticStableTestTakoformHost({
    sql: createSqliteSql(database),
    objects: createMemoryObjectStore(),
    authenticate: async (request) =>
      request.headers.get("authorization") === TOKEN
        ? { tenantId: "tenant-a", principalId: "principal-a" }
        : null,
    forms: [form],
    driver,
    deferredOperations: {
      shouldDefer: () => true,
      pollsBeforeCommit: 1,
      retryAfterSeconds: 0,
      executeOnAccept: true,
      inlineExecuteMilliseconds: INLINE_BUDGET_MS,
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => (await host.handle(request)) ?? new Response(null, { status: 404 }),
  });
  const origin = server.url.origin;

  const desiredFor = (name: string) => ({
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: { formRef: form.identity.formRef },
    metadata: { name, space: "main" },
    spec: { value: name },
  });
  const prepare = async (name: string) => {
    const response = await fetch(`${origin}${LANE}/resources/prepare`, {
      method: "POST",
      headers: { authorization: TOKEN, "content-type": "application/json" },
      body: JSON.stringify(desiredFor(name)),
      signal: AbortSignal.timeout(LONG_CALLER_TIMEOUT_MS),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { readonly review: Record<string, string> };
  };
  const resourcePath = (name: string) =>
    `${LANE}/resources/${form.identity.formRef.apiVersion}/${form.identity.formRef.kind}/${name}?${new URLSearchParams(
      {
        space: "main",
        definitionVersion: form.identity.formRef.definitionVersion,
        schemaDigest: form.identity.formRef.schemaDigest,
      },
    )}`;
  const put = (name: string, review: Record<string, string>, key: string, timeout: number) =>
    fetch(`${origin}${resourcePath(name)}`, {
      method: "PUT",
      headers: {
        authorization: TOKEN,
        "content-type": "application/json",
        "idempotency-key": key,
        "if-none-match": "*",
      },
      body: JSON.stringify({ ...desiredFor(name), review }),
      signal: AbortSignal.timeout(timeout),
    });

  try {
    const shortName = "short-client";
    const shortReview = await prepare(shortName);
    const shortBody = JSON.stringify({ ...desiredFor(shortName), review: shortReview.review });
    const shortPath = resourcePath(shortName);
    const shortHeaders = {
      authorization: TOKEN,
      "content-type": "application/json",
      "idempotency-key": "same-public-put-short-client-0001",
      "if-none-match": "*",
    };
    const shortRequest = fetch(`${origin}${shortPath}`, {
      method: "PUT",
      headers: shortHeaders,
      body: shortBody,
      signal: AbortSignal.timeout(CALLER_TIMEOUT_MS),
    });
    await entered[0]?.promise;
    const shortOutcome = await shortRequest.then(
      (response) => ({ kind: "response" as const, status: response.status }),
      (error: unknown) => ({
        kind:
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
            ? ("timeout" as const)
            : ("error" as const),
      }),
    );
    expect(shortOutcome).toEqual({ kind: "timeout" });

    const replayResponse = await fetch(`${origin}${shortPath}`, {
      method: "PUT",
      headers: shortHeaders,
      body: shortBody,
      signal: AbortSignal.timeout(LONG_CALLER_TIMEOUT_MS),
    });
    expect(replayResponse.status).toBe(202);
    const accepted = (await replayResponse.json()) as {
      readonly operation: { readonly id: string; readonly done: boolean };
    };
    expect(accepted.operation.done).toBe(false);
    expect(accepted.operation.id).toMatch(/^[a-z0-9_-]+$/u);

    gates[0]?.resolve();
    const operationPath = `${LANE}/operations/${encodeURIComponent(accepted.operation.id)}`;
    let operation: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${origin}${operationPath}`, {
        headers: { authorization: TOKEN },
        signal: AbortSignal.timeout(LONG_CALLER_TIMEOUT_MS),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      if (body.done === true) {
        operation = body;
        break;
      }
      await Bun.sleep(5);
    }
    expect(operation).toMatchObject({ id: accepted.operation.id, done: true });
    const result = operation?.result as { readonly resource?: Record<string, unknown> } | undefined;
    const originalResource = result?.resource;
    expect(originalResource?.metadata).toMatchObject({ name: shortName });

    const shortReadback = await fetch(`${origin}${shortPath}`, {
      headers: { authorization: TOKEN },
      signal: AbortSignal.timeout(LONG_CALLER_TIMEOUT_MS),
    });
    expect(shortReadback.status).toBe(200);
    const shortResource = (await shortReadback.json()) as Record<string, unknown>;
    const originalMetadata = originalResource?.metadata as Record<string, unknown> | undefined;
    if (!originalMetadata) throw new Error("completed operation resource metadata missing");
    expect(shortResource.metadata).toMatchObject({
      name: shortName,
      uid: originalMetadata.uid,
    });
    expect(providerCalls).toBe(1);

    const longName = "long-client";
    const longReview = await prepare(longName);
    const longResponsePromise = put(
      longName,
      longReview.review,
      "same-public-put-long-client-0001",
      LONG_CALLER_TIMEOUT_MS,
    );
    await entered[1]?.promise;
    gates[1]?.resolve();
    const longResponse = await longResponsePromise;
    expect(longResponse.status).toBe(201);
    expect((await longResponse.json()).metadata).toMatchObject({ name: longName });
    expect(providerCalls).toBe(2);
  } finally {
    gates.forEach((gate) => {
      gate.resolve();
    });
    server.stop();
    database.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
