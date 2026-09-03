import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOMATICALLY_RETRYABLE_ERROR_CODES,
  classifyRefusal,
  errorEnvelopeResponse,
  HOST_ERROR_HTTP_STATUS,
  isStableErrorEnvelope,
  PORTABLE_STATUS_DIVERGENCES,
  STABLE_ERROR_HTTP_STATUS,
} from "../src/error-envelope.ts";

const REPOSITORY = join(import.meta.dir, "..");

/**
 * Everything that renders a refusal onto the wire with an explicit status.
 *
 * Each of these takes the code first and the HTTP status second, so one regular
 * expression finds every pair this Host can answer with. A new renderer has to
 * be named here — which is the point: the taxonomy is only closed if the set of
 * things that can open it is closed too.
 */
const WIRE_REFUSAL_SOURCES = [
  "failure",
  "controlError",
  "errorEnvelopeResponse",
  "ControlError",
  "TakoformHostError",
  "RuntimeInputPreparationError",
  "WorkerEndpointOriginReservationError",
  "ResellerError",
];

interface EmittedPair {
  readonly code: string;
  readonly status: number;
  readonly site: string;
}

function* sources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) yield path;
  }
}

function emittedPairs(): readonly EmittedPair[] {
  const pattern = new RegExp(
    `\\b(?:${WIRE_REFUSAL_SOURCES.join("|")})\\(\\s*"([a-z0-9_]+)"\\s*,\\s*(\\d{3})\\b`,
    "gu",
  );
  const found: EmittedPair[] = [];
  for (const path of sources(join(REPOSITORY, "src"))) {
    const text = readFileSync(path, "utf8");
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const [, code, status] = match;
      if (code !== undefined && status !== undefined) {
        found.push({ code, status: Number(status), site: path.slice(REPOSITORY.length + 1) });
      }
      match = pattern.exec(text);
    }
  }
  return found;
}

describe("error taxonomy", () => {
  test("the portable table is the frozen spec, not a copy of it", () => {
    // Read the vendored artifact directly rather than the generated module, so
    // this compares the shipped table to bytes nothing in this repository wrote.
    const spec = JSON.parse(
      readFileSync(join(REPOSITORY, "vendor/takoform/host-api-v1/operations-v1.json"), "utf8"),
    ) as {
      errorEnvelope: {
        codes: readonly string[];
        automaticallyRetryable: readonly string[];
        httpStatusByCode: Readonly<Record<string, number>>;
      };
    };
    expect(STABLE_ERROR_HTTP_STATUS).toEqual(spec.errorEnvelope.httpStatusByCode);
    expect(AUTOMATICALLY_RETRYABLE_ERROR_CODES).toEqual(spec.errorEnvelope.automaticallyRetryable);
    expect(Object.keys(STABLE_ERROR_HTTP_STATUS).sort()).toEqual(
      [...spec.errorEnvelope.codes].sort(),
    );
  });

  test("every refusal this Host can answer with is classified", () => {
    const unclassified = emittedPairs()
      .filter((pair) => classifyRefusal(pair.code, pair.status) === "unclassified")
      .map((pair) => `${pair.code} ${pair.status} (${pair.site})`);
    expect([...new Set(unclassified)].sort()).toEqual([]);
  });

  test("a Host code the surface no longer answers must leave the table", () => {
    const emitted = new Set(emittedPairs().map((pair) => `${pair.code} ${pair.status}`));
    const stale: string[] = [];
    for (const [code, statuses] of Object.entries(HOST_ERROR_HTTP_STATUS)) {
      for (const status of statuses) {
        if (!emitted.has(`${code} ${status}`)) stale.push(`${code} ${status}`);
      }
    }
    expect(stale.sort()).toEqual([]);
  });

  test("a divergence that has been fixed must leave the list", () => {
    // The list asserts these are *still* wrong, the way a declared capability
    // gap does. Fixing one fails this test until its entry is deleted, so a
    // closed defect cannot leave a permanent excuse behind.
    const emitted = new Set(emittedPairs().map((pair) => `${pair.code} ${pair.status}`));
    const fixed: string[] = [];
    for (const [code, statuses] of Object.entries(PORTABLE_STATUS_DIVERGENCES)) {
      for (const status of statuses) {
        expect(STABLE_ERROR_HTTP_STATUS[code]).toBeDefined();
        expect(STABLE_ERROR_HTTP_STATUS[code]).not.toBe(status);
        if (!emitted.has(`${code} ${status}`)) fixed.push(`${code} ${status}`);
      }
    }
    expect(fixed.sort()).toEqual([]);
  });

  test("a Host code never shadows a portable one", () => {
    for (const code of Object.keys(HOST_ERROR_HTTP_STATUS)) {
      expect(STABLE_ERROR_HTTP_STATUS[code]).toBeUndefined();
    }
  });

  test("only the codes the spec allows are answered retryable", () => {
    for (const code of AUTOMATICALLY_RETRYABLE_ERROR_CODES) {
      const status = STABLE_ERROR_HTTP_STATUS[code];
      expect(status).toBeDefined();
      expect(isStableErrorEnvelope(code, status as number, true)).toBe(true);
    }
    for (const code of Object.keys(STABLE_ERROR_HTTP_STATUS)) {
      if (AUTOMATICALLY_RETRYABLE_ERROR_CODES.includes(code)) continue;
      expect(isStableErrorEnvelope(code, STABLE_ERROR_HTTP_STATUS[code] as number, true)).toBe(
        false,
      );
    }
  });

  test("an unclassifiable refusal fails at authoring time, not at a customer", () => {
    expect(() => errorEnvelopeResponse("teapot_unavailable", 418)).toThrow(
      "unclassified refusal teapot_unavailable 418",
    );
    expect(errorEnvelopeResponse("not_found", 404).status).toBe(404);
    expect(errorEnvelopeResponse("resource_not_found", 404).status).toBe(404);
  });
});
