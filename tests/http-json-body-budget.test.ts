import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

// Actual-route proof that a public, unauthenticated JSON route does not buffer
// the whole request body before refusing it. It drives the real buildApp
// dispatcher, so the real jsonObject reads the body. No credential is involved:
// the identity verifier is a counting stub and the body is inert filler.

const settlement: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "settlement_1", amountMinor: 1_000, currency: "USD" };
  },
};

function app() {
  let verifyCalls = 0;
  const identity: ExternalIdentityVerifier = {
    async verify() {
      verifyCalls += 1;
      return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
    },
  };
  const { fetch } = buildApp({
    v2: TEST_TAKOFORM_V2_CONFIG,
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: "https://api.takoserver.com",
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
  });
  return { fetch, verifyCalls: () => verifyCalls };
}

const CHUNK_BYTES = 4 * 1_024;
const TOTAL_CHUNKS = 1_024; // 4 MiB offered, 64x the 64 KiB JSON budget.

/**
 * A request body that records how much was actually pulled from it. The stream
 * itself asks for nothing ahead of a reader (highWaterMark 0), so pulls reflect
 * consumption; whatever the runtime's Request wrapper does on its own is taken
 * out by comparing against `settled()` rather than by assuming zero.
 */
function instrumentedStream(totalChunks: number) {
  const counters = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (counters.pulls >= totalChunks) {
          controller.close();
          return;
        }
        counters.pulls += 1;
        controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x20));
      },
      cancel() {
        counters.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, counters };
}

/** Pulls made before the app is involved at all, once the Request exists. */
async function settled(counters: { pulls: number }): Promise<number> {
  await Bun.sleep(0);
  return counters.pulls;
}

function sessionsRequest(body: BodyInit | null, contentType = "application/json"): Request {
  return new Request("https://api.takoserver.com/v1/sessions", {
    method: "POST",
    headers: { "content-type": contentType },
    ...(body === null ? {} : { body, duplex: "half" }),
  } as RequestInit);
}

/** The wire envelope is `{ error: { code, message, requestId, retryable } }`. */
async function expectInvalidArgument(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error?: { code?: unknown } };
  expect(body.error?.code).toBe("invalid_argument");
}

describe("unauthenticated JSON route body budget", () => {
  test("an over-budget stream is refused and cancelled without being drained", async () => {
    const { fetch, verifyCalls } = app();
    const { stream, counters } = instrumentedStream(TOTAL_CHUNKS);

    const response = await fetch(sessionsRequest(stream));

    await expectInvalidArgument(response);
    // The decisive pair: the route stopped reading, and said so to the source.
    expect(counters.cancelled).toBe(true);
    // Do not pin the incidental prefetch count; require it strictly bounded
    // against what was offered (a full drain would equal TOTAL_CHUNKS).
    expect(counters.pulls).toBeLessThan(TOTAL_CHUNKS / 4);
    expect(verifyCalls()).toBe(0);
  });

  test("an empty stream and an absent body keep the same refusal", async () => {
    const { fetch, verifyCalls } = app();

    await expectInvalidArgument(await fetch(sessionsRequest(instrumentedStream(0).stream)));
    await expectInvalidArgument(await fetch(sessionsRequest(null)));
    expect(verifyCalls()).toBe(0);
  });

  test("the content-type refusal still precedes any body read", async () => {
    const { fetch, verifyCalls } = app();
    const { stream, counters } = instrumentedStream(TOTAL_CHUNKS);
    const request = sessionsRequest(stream, "text/plain");
    const before = await settled(counters);

    await expectInvalidArgument(await fetch(request));

    // The app consumed nothing beyond what the Request already did by itself.
    expect(counters.pulls).toBe(before);
    expect(verifyCalls()).toBe(0);
  });

  test("a small JSON body is still parsed and reaches the identity verifier", async () => {
    const { fetch, verifyCalls } = app();

    const response = await fetch(
      sessionsRequest(JSON.stringify({ provider: "google", assertion: "inert-test-assertion" })),
    );

    // Read from source: this buildApp has no local issuer, so sign-in calls the
    // plain verifier and then issues a session. Only a fully read and parsed
    // body gets that far.
    expect(verifyCalls()).toBe(1);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionToken?: unknown };
    expect(typeof body.sessionToken).toBe("string");
  });

  test("a body that is not an object keeps its refusal", async () => {
    const { fetch, verifyCalls } = app();

    await expectInvalidArgument(await fetch(sessionsRequest("[]")));
    await expectInvalidArgument(await fetch(sessionsRequest("{")));
    expect(verifyCalls()).toBe(0);
  });
});
