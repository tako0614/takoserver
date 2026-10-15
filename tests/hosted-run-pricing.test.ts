import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type BillingConfig, parseBillingConfig } from "../src/billing-config.ts";
import {
  createHostedRunPricing,
  type HostedRunClosedInput,
  type HostedRunClosedProof,
  type HostedRunMeasurement,
  type HostedRunQuoteProof,
  MAX_HOSTED_RUN_MEASUREMENTS,
} from "../src/hosted-run-pricing.ts";
import {
  compileSharedHostedPricing,
  parseSharedHostedPricing,
} from "../src/shared-hosted-pricing.ts";

const subject = {
  organizationId: "org_pricing",
  reference: "run:opaque",
  workspaceRef: "ws_opaque",
  product: "takosumi-hosted" as const,
};
const fingerprint = `sha256:${"a".repeat(64)}` as const;
const start = "2026-10-15T00:00:00.000Z";
const end = "2026-10-15T00:00:01.000Z";

function tariff(): BillingConfig {
  const shared = compileSharedHostedPricing(
    parseSharedHostedPricing(
      JSON.parse(
        readFileSync(new URL("../config/shared-hosted-pricing.json", import.meta.url), "utf8"),
      ),
    ),
  );
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: shared.revision,
      effectiveAt: start,
      currency: "USD",
      freeIncludedMinor: 150,
      plans: {},
      purchaseCreditExpiry: { kind: "none" },
      meters: Object.fromEntries(
        Object.entries(shared.usageRates)
          .filter(([, rate]) => rate.numeratorMicros !== "0")
          .map(([meter, rate]) => [
            meter,
            {
              unit: rate.unit,
              rate: { numeratorMicros: rate.numeratorMicros, denominator: rate.denominator },
            },
          ]),
      ),
    }),
  );
  if (!config) throw new Error("missing tariff fixture");
  return config;
}

function measurement(overrides: Partial<HostedRunMeasurement> = {}): HostedRunMeasurement {
  return {
    meter: "container.memory",
    quantityUnit: "GiB-second",
    quantity: "1",
    periodStart: start,
    periodEnd: end,
    ...overrides,
  };
}

function fixture(config = tariff(), samples = [measurement()]) {
  const quote: HostedRunQuoteProof = {
    ...subject,
    requestFingerprint: fingerprint,
    quotedAt: start,
    pricingVersion: config.revision,
    estimatedMeasurements: samples,
  };
  const closed: HostedRunClosedProof = {
    ...subject,
    requestFingerprint: fingerprint,
    applyReference: "apply:opaque",
    pricingVersion: config.revision,
    closedAt: "2026-10-15T00:00:02.000Z",
    closedMeasurements: samples,
  };
  const state = {
    quote: quote as HostedRunQuoteProof | null,
    closed: closed as HostedRunClosedProof | null,
  };
  const port = createHostedRunPricing({
    billingConfig: config,
    custody: {
      async readQuote() {
        return state.quote;
      },
      async readClosed() {
        return state.closed;
      },
    },
  });
  const request: HostedRunClosedInput = {
    organizationId: subject.organizationId,
    reference: subject.reference,
    workspaceRef: subject.workspaceRef,
    applyReference: closed.applyReference,
    closedMeasurements: samples,
    pricingVersion: config.revision,
  };
  return { port, state, quote, closed, request };
}

describe("trusted Hosted Run pricing port", () => {
  test("quotes and rates only custodied measurements with one whole-Run ceiling", async () => {
    const samples = [
      measurement(),
      measurement({ periodStart: end, periodEnd: "2026-10-15T00:00:02.000Z" }),
    ];
    const h = fixture(tariff(), samples);
    expect(await h.port.quoteRun(subject)).toEqual({
      estimatedUsdMicros: "15",
      pricingVersion: h.quote.pricingVersion,
    });
    expect(await h.port.rateClosedRun(h.request)).toEqual({
      actualUsdMicros: "15",
      pricingVersion: h.quote.pricingVersion,
    });
    expect(await h.port.rateClosedRun(h.request)).toEqual(await h.port.rateClosedRun(h.request));
  });

  test("folds fractions across tariff meters before quantization", async () => {
    const h = fixture(tariff(), [
      measurement({ meter: "workers.requests", quantityUnit: "request" }),
      measurement({ meter: "container.cpu", quantityUnit: "vCPU-second", quantity: "0.001" }),
    ]);
    expect((await h.port.rateClosedRun(h.request)).actualUsdMicros).toBe("1");
  });

  test("has no fabricated estimate or zero actual when custody is unavailable", async () => {
    const h = fixture();
    const uncomposed = createHostedRunPricing({ billingConfig: tariff() });
    await expect(uncomposed.quoteRun(subject)).rejects.toThrow("custody_unavailable");
    await expect(uncomposed.rateClosedRun(h.request)).rejects.toThrow("custody_unavailable");
    h.state.closed = null;
    await expect(h.port.rateClosedRun(h.request)).rejects.toThrow("custody_unavailable");
    h.state.quote = null;
    await expect(h.port.quoteRun(subject)).rejects.toThrow("custody_unavailable");
  });

  test("rejects caller estimates, foreign attribution, apply changes and incomplete measurement sets", async () => {
    const h = fixture();
    await expect(
      h.port.quoteRun({ ...subject, estimatedUsdMicros: "1" } as typeof subject),
    ).rejects.toThrow("invalid_request");
    await expect(h.port.quoteRun({ ...subject, workspaceRef: "foreign" })).rejects.toThrow(
      "custody_mismatch",
    );
    await expect(h.port.rateClosedRun({ ...h.request, applyReference: "other" })).rejects.toThrow(
      "custody_mismatch",
    );
    await expect(h.port.rateClosedRun({ ...h.request, pricingVersion: "other" })).rejects.toThrow(
      "custody_mismatch",
    );
    await expect(h.port.rateClosedRun({ ...h.request, closedMeasurements: [] })).rejects.toThrow(
      "custody_mismatch",
    );
    await expect(
      h.port.rateClosedRun({ ...h.request, closedMeasurements: [measurement({ quantity: "2" })] }),
    ).rejects.toThrow("custody_mismatch");
  });

  test("binds closed proof to the original Run request and product", async () => {
    const h = fixture();
    h.state.closed = { ...h.closed, requestFingerprint: `sha256:${"b".repeat(64)}` };
    await expect(h.port.rateClosedRun(h.request)).rejects.toThrow("custody_mismatch");
    h.state.closed = { ...h.closed, product: "takoserver" };
    await expect(h.port.rateClosedRun(h.request)).rejects.toThrow("custody_mismatch");
    h.state.closed = { ...h.closed, closedAt: start };
    await expect(h.port.rateClosedRun(h.request)).rejects.toThrow("custody_mismatch");
  });

  test("refuses unknown meters, raw unit aliases, malformed decimals and duplicate segments", async () => {
    const inherited = fixture(tariff(), [measurement({ meter: "constructor" })]);
    await expect(inherited.port.rateClosedRun(inherited.request)).rejects.toThrow(
      "pricing_unavailable",
    );
    for (const overrides of [
      { meter: "runner.tf" },
      { quantityUnit: "byte-second" },
      { quantity: "01" },
      { quantity: "1.0" },
      { quantity: "0.0000000000000000001" },
      { periodEnd: start },
    ]) {
      const h = fixture(tariff(), [measurement(overrides)]);
      await expect(h.port.rateClosedRun(h.request)).rejects.toThrow();
    }
    const duplicated = fixture(tariff(), [measurement(), measurement()]);
    await expect(duplicated.port.rateClosedRun(duplicated.request)).rejects.toThrow(
      "invalid_measurement",
    );
  });

  test("bounds arrays and refuses amount overflow", async () => {
    const h = fixture();
    await expect(
      h.port.rateClosedRun({
        ...h.request,
        closedMeasurements: Array(MAX_HOSTED_RUN_MEASUREMENTS + 1).fill(measurement()),
      }),
    ).rejects.toThrow("invalid_measurement");
    const overflow = fixture(tariff(), [measurement({ quantity: "9007199254740991" })]);
    await expect(overflow.port.quoteRun(subject)).rejects.toThrow("amount_overflow");
  });

  test("rates preserved historical tuples and rejects a segment crossing tariff activation", async () => {
    const original = tariff();
    const revised = { ...original, revision: "future-r2", effectiveAt: end, history: [original] };
    const h = fixture(revised);
    h.state.quote = { ...h.quote, pricingVersion: original.revision };
    h.state.closed = { ...h.closed, pricingVersion: original.revision };
    const request = { ...h.request, pricingVersion: original.revision };
    expect((await h.port.rateClosedRun(request)).actualUsdMicros).toBe("8");
    const crossing = measurement({ periodEnd: "2026-10-15T00:00:02.000Z" });
    h.state.closed = {
      ...h.closed,
      pricingVersion: original.revision,
      closedMeasurements: [crossing],
    };
    await expect(
      h.port.rateClosedRun({ ...request, closedMeasurements: [crossing] }),
    ).rejects.toThrow("pricing_unavailable");
  });

  test("zero actual requires an explicit authoritative closed receipt", async () => {
    const h = fixture(tariff(), []);
    expect((await h.port.rateClosedRun(h.request)).actualUsdMicros).toBe("0");
  });
});
