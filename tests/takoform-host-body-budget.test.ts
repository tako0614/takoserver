import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { MAXIMUM_REQUEST_BODY_BYTES } from "../src/takoform/limits.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type { ProvisionLanePorts } from "../src/takoform/routes.ts";
import type { TakoformHostPrincipal } from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";
import { instrumentedBodyStream } from "./helpers/instrumented-body-stream.ts";

// The Host advertises one request budget "before parsing". It must hold while
// the body is read, also for a chunked body that declares no length, and for
// the scope and provision probes that read a clone ahead of the engine. The
// principals and provision ports are test stubs as in the other Host route
// tests; no token is minted and every body is inert.

const CHUNK_BYTES = 4 * 1_024;
const TOTAL_CHUNKS = 1_024;
const ORIGIN = "https://host.invalid";
const LANE = `${ORIGIN}/apis/forms.takoform.com/v1`;
const PROVISION = `${ORIGIN}/provision/v1`;
const SPACE = "main";
const FORM_REF = {
  apiVersion: "function.forms.takoform.com",
  kind: "Function",
  definitionVersion: "0.1.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;
const RESOURCE = `/resources/${FORM_REF.apiVersion}/${FORM_REF.kind}/example`;
const direct: TakoformHostPrincipal = { tenantId: "tenant-a", principalId: "principal-a" };

function resourceBody(): Record<string, unknown> {
  return {
    apiVersion: FORM_REF.apiVersion,
    kind: FORM_REF.kind,
    form: { formRef: FORM_REF },
    metadata: { name: "example", space: SPACE },
    spec: {},
  };
}

function host(principal: TakoformHostPrincipal | null, provision?: ProvisionLanePorts) {
  return createStaticStableTestTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    authenticate: async () => principal,
    forms: [],
    driver: new InMemoryTakoformResourceDriver(),
    ...(provision ? { provision } : {}),
  });
}

/** Reading stops one chunk past the budget; a drain pulls every chunk. */
function expectStoppedAtBudget(pulls: number): void {
  expect(pulls * CHUNK_BYTES).toBeLessThanOrEqual(MAXIMUM_REQUEST_BODY_BYTES + 2 * CHUNK_BYTES);
}

async function expectBudgetRefusal(response: Response | null): Promise<void> {
  if (!response) throw new Error("the Host lane did not answer");
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error?: { code?: unknown } }).error?.code).toBe(
    "invalid_argument",
  );
}

async function refusedWithoutDrain(
  principal: TakoformHostPrincipal,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const { stream, counters, totalBytes } = instrumentedBodyStream({
    chunkBytes: CHUNK_BYTES,
    totalChunks: TOTAL_CHUNKS,
  });
  expect(totalBytes).toBeGreaterThan(2 * MAXIMUM_REQUEST_BODY_BYTES);
  const request = new Request(url, {
    method,
    headers: { authorization: "Bearer inert", "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  } as RequestInit);
  await Bun.sleep(0);
  const before = counters.pulls;

  await expectBudgetRefusal(await host(principal).handle(request));
  expectStoppedAtBudget(counters.pulls - before);
}

/** Exact bytes sent as fixed-size chunks with no declared length. */
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + CHUNK_BYTES));
      offset += CHUNK_BYTES;
    },
  });
}

function paddedJson(value: unknown, totalBytes: number): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(totalBytes).fill(0x20);
  bytes.set(json);
  return bytes;
}

test("prepare refuses an over-budget chunked body without draining it", async () => {
  await refusedWithoutDrain(direct, "POST", `${LANE}/resources/prepare`);
});

test("apply refuses an over-budget chunked body without draining it", async () => {
  await refusedWithoutDrain(direct, "PUT", `${LANE}${RESOURCE}?space=${SPACE}`, {
    "idempotency-key": "k".repeat(16),
    "if-none-match": "*",
  });
});

test("the tenant-run space probe refuses an over-budget body without draining it", async () => {
  await refusedWithoutDrain(
    { ...direct, scope: { mode: "tenant-run", space: SPACE } },
    "POST",
    `${LANE}/resources/prepare`,
  );
});

test("the exact-scope body probe refuses an over-budget body without draining it", async () => {
  await refusedWithoutDrain(
    {
      ...direct,
      scope: { mode: "manage", space: SPACE, formRef: FORM_REF, resourceName: "example" },
    },
    "PUT",
    `${LANE}${RESOURCE}`,
    { "idempotency-key": "k".repeat(16) },
  );
});

test("a matching over-budget provision body is refused before its token is spent", async () => {
  let consumed = 0;
  const claims = {
    organizationId: "org-a",
    tenantRef: SPACE,
    reservationId: "reservation-a",
    offeringId: "offering-a",
    offeringDigest: `sha256:${"d".repeat(64)}` as const,
    tokenId: "token-a",
  };
  const provision: ProvisionLanePorts = {
    tokens: {
      async verifyProvisionToken() {
        return claims;
      },
      async consumeProvisionToken() {
        consumed++;
        return claims;
      },
    },
    catalog: {
      findOffering: () => ({ form: FORM_REF }),
      digest: async () => claims.offeringDigest,
    },
  };
  // The body matches the paid Offering and space, so only its length is wrong.
  const { stream, counters } = instrumentedBodyStream({
    chunkBytes: CHUNK_BYTES,
    totalChunks: TOTAL_CHUNKS,
    leading: new TextEncoder().encode(JSON.stringify(resourceBody())),
  });
  // The provision lane keeps the four-segment resource path.
  const request = new Request(`${PROVISION}/resources/${FORM_REF.apiVersion}/v1/Function/example`, {
    method: "PUT",
    headers: {
      authorization: "Bearer inert",
      "content-type": "application/json",
      "if-none-match": "*",
      "idempotency-key": "k".repeat(16),
    },
    body: stream,
    duplex: "half",
  } as RequestInit);
  await Bun.sleep(0);
  const before = counters.pulls;

  await expectBudgetRefusal(await host(null, provision).handle(request));
  expectStoppedAtBudget(counters.pulls - before);
  expect(consumed).toBe(0);
});

test("a chunked body of exactly the budget is parsed and one byte more is refused", async () => {
  const send = async (totalBytes: number) =>
    await host(direct).handle(
      new Request(`${LANE}/resources/prepare`, {
        method: "POST",
        headers: { authorization: "Bearer inert", "content-type": "application/json" },
        body: chunked(paddedJson(resourceBody(), totalBytes)),
        duplex: "half",
      } as RequestInit),
    );

  const exact = await send(MAXIMUM_REQUEST_BODY_BYTES);
  if (!exact) throw new Error("the Host lane did not answer");
  // Parsed and validated: the only refusal left is that no Form is installed.
  expect(exact.status).toBe(404);
  expect(((await exact.json()) as { error?: { code?: unknown } }).error?.code).toBe("form_unknown");
  await expectBudgetRefusal(await send(MAXIMUM_REQUEST_BODY_BYTES + 1));
});
