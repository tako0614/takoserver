import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewFile } from "../scripts/pricing/preview.ts";
import { computeMeterAmountMicros } from "../src/billing-config.ts";
import {
  compileSharedHostedPricing,
  parseSharedHostedPricing,
  SharedHostedPricingError,
} from "../src/shared-hosted-pricing.ts";

const source = JSON.parse(
  readFileSync(new URL("../config/shared-hosted-pricing.json", import.meta.url), "utf8"),
) as unknown;

function parsedSource(): ReturnType<typeof parseSharedHostedPricing> {
  return parseSharedHostedPricing(source);
}

function copySource(): Record<string, unknown> {
  return structuredClone(source) as Record<string, unknown>;
}

function entryAt(values: Array<Record<string, unknown>>, index: number): Record<string, unknown> {
  const value = values[index];
  if (!value) throw new Error(`missing test fixture entry ${index}`);
  return value;
}

describe("shared hosted pricing source", () => {
  test("parses the finalized USD-micros subscription and free allowances", () => {
    const pricing = parsedSource();
    expect(pricing).toMatchObject({
      schemaVersion: 2,
      products: ["takoserver", "takosumi-hosted"],
      currency: "USD",
      moneyUnit: "USD-micros",
      revision: "hosted-20261015-container-proposed-v1",
      freeIncludedMicros: "1500000",
      plans: [
        {
          planId: "hosted-10",
          monthlyPriceMicros: "10000000",
          includedMicros: "20000000",
          stripePriceId: null,
        },
        {
          planId: "hosted-50",
          monthlyPriceMicros: "50000000",
          includedMicros: "100000000",
          stripePriceId: null,
        },
      ],
      purchase: "face-value",
      markupMultiplier: 3,
      warningBasisPoints: [8000, 9500],
      defaultOnLimit: "stop",
      postpaid: "unsupported",
      freePaidStacking: false,
      shortWindowLimits: null,
    });
  });

  test("compiles every configured Cloudflare meter at exactly 3x into integer USD-micros", () => {
    const compiled = compileSharedHostedPricing(parsedSource());
    expect(compiled.activation).toBe("pending-stripe-price-ids");
    expect(compiled.unresolvedStripePricePlanIds).toEqual(["hosted-10", "hosted-50"]);
    expect(compiled.organizationAllowance).toEqual({
      freeIncludedMicros: "1500000",
      sourceRevision: "hosted-20261015-container-proposed-v1",
      stripePriceId: null,
    });
    expect(
      Object.entries(compiled.usageRates).map(([key, rate]) => [
        key,
        rate.unit,
        rate.cloudflareCostMicros,
        rate.quantity,
        rate.numeratorMicros,
        rate.denominator,
      ]),
    ).toEqual([
      ["wfp.requests", "request", "300000", "1000000", "900000", "1000000"],
      ["workers.requests", "request", "300000", "1000000", "900000", "1000000"],
      ["wfp.cpu-ms", "ms", "20000", "1000000", "60000", "1000000"],
      ["workers.cpu-ms", "ms", "20000", "1000000", "60000", "1000000"],
      ["d1.rows-read", "row", "1000", "1000000", "3000", "1000000"],
      ["d1.rows-written", "row", "1000000", "1000000", "3000000", "1000000"],
      ["d1.storage", "GB-month", "750000", "1", "2250000", "1"],
      ["r2.storage", "GB-month", "15000", "1", "45000", "1"],
      ["r2.class-a", "operation", "4500000", "1000000", "13500000", "1000000"],
      ["r2.class-b", "operation", "360000", "1000000", "1080000", "1000000"],
      ["kv.read", "key", "500000", "1000000", "1500000", "1000000"],
      ["kv.write", "key", "5000000", "1000000", "15000000", "1000000"],
      ["kv.delete", "key", "5000000", "1000000", "15000000", "1000000"],
      ["kv.list", "request", "5000000", "1000000", "15000000", "1000000"],
      ["kv.storage", "GB-month", "500000", "1", "1500000", "1"],
      ["egress", "byte", "0", "1", "0", "1"],
      ["container.cpu", "vCPU-second", "20", "1", "60", "1"],
      ["container.memory", "GiB-second", "2500", "1000", "7500", "1000"],
      ["container.egress", "GB", "50000", "1", "150000", "1"],
      ["container.image-storage", "GB-month", "15000", "1", "45000", "1"],
    ]);
  });

  test("ceilings exact Container memory consumption once per aggregate", () => {
    const memory = compileSharedHostedPricing(parsedSource()).usageRates["container.memory"];
    if (!memory) throw new Error("missing Container memory rate");
    expect(computeMeterAmountMicros(1n, memory)).toBe(8);
    expect(computeMeterAmountMicros(2n, memory)).toBe(15);
    expect(computeMeterAmountMicros(1000n, memory)).toBe(7500);
    expect(computeMeterAmountMicros(1n, memory, 100n)).toBe(1);
    expect(computeMeterAmountMicros(100n, memory, 100n)).toBe(8);
    expect(computeMeterAmountMicros(0n, memory)).toBe(0);
  });

  test("allows null Stripe identities in source and qualifies a resolved fixture only as preview", () => {
    const unresolved = compileSharedHostedPricing(parsedSource());
    expect(unresolved.activation).toBe("pending-stripe-price-ids");
    const fixture = copySource();
    const plans = fixture.plans as Array<Record<string, unknown>>;
    entryAt(plans, 0).stripePriceId = "price_hosted10";
    entryAt(plans, 1).stripePriceId = "price_hosted50";
    const resolved = compileSharedHostedPricing(parseSharedHostedPricing(fixture));
    expect(resolved.activation).toBe("preview-qualified");
    expect(resolved.unresolvedStripePricePlanIds).toEqual([]);
    expect(resolved.plans.map((plan) => plan.stripePriceId)).toEqual([
      "price_hosted10",
      "price_hosted50",
    ]);
  });

  test("rejects missing and unknown fields, duplicate plan IDs, and malformed integer strings", () => {
    const missing = copySource();
    delete missing.revision;
    expect(() => parseSharedHostedPricing(missing)).toThrow(SharedHostedPricingError);
    const unknown = copySource();
    unknown.unreviewed = true;
    expect(() => parseSharedHostedPricing(unknown)).toThrow(/unknown key/u);
    const duplicate = copySource();
    const plans = duplicate.plans as Array<Record<string, unknown>>;
    entryAt(plans, 1).planId = entryAt(plans, 0).planId;
    expect(() => parseSharedHostedPricing(duplicate)).toThrow(/must be unique/u);
    const malformed = copySource();
    const malformedPlans = malformed.plans as Array<Record<string, unknown>>;
    entryAt(malformedPlans, 0).monthlyPriceMicros = "01";
    expect(() => parseSharedHostedPricing(malformed)).toThrow(/canonical integer/u);
  });

  test("rejects unsupported currency, enabled postpaid, malformed Stripe IDs, and unsafe rates", () => {
    const currency = copySource();
    currency.currency = "JPY";
    expect(() => parseSharedHostedPricing(currency)).toThrow(/currency/u);
    const postpaid = copySource();
    postpaid.postpaid = "enabled";
    expect(() => parseSharedHostedPricing(postpaid)).toThrow(/postpaid/u);
    const stripe = copySource();
    const plans = stripe.plans as Array<Record<string, unknown>>;
    entryAt(plans, 0).stripePriceId = "price_bad-id";
    expect(() => parseSharedHostedPricing(stripe)).toThrow(/invalid string/u);
    const overflow = copySource();
    const meters = overflow.meters as Record<string, Record<string, unknown>>;
    const egress = meters.egress;
    if (!egress) throw new Error("missing egress test fixture");
    egress.cloudflareCostMicros = "3002399751580331";
    expect(() => parseSharedHostedPricing(overflow)).toThrow(
      /marked-up rate exceeds safe integer range/u,
    );
    egress.cloudflareCostMicros = "9007199254740992";
    expect(() => parseSharedHostedPricing(overflow)).toThrow(/safe integer range/u);
  });

  test("uses the configured multiplier without monetary defaults and rejects invalid factors", () => {
    const alternate = copySource();
    alternate.markupMultiplier = 2;
    expect(
      compileSharedHostedPricing(parseSharedHostedPricing(alternate)).usageRates["wfp.requests"],
    ).toMatchObject({ numeratorMicros: "600000", denominator: "1000000" });
    for (const value of [0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = copySource();
      invalid.markupMultiplier = value;
      expect(() => parseSharedHostedPricing(invalid)).toThrow(/markupMultiplier/u);
    }
  });

  test("previews both finalized USD plans through the existing bounded CLI path", async () => {
    const output = JSON.parse(
      await previewFile(new URL("../config/shared-hosted-pricing.json", import.meta.url).pathname),
    );
    expect(output.kind).toBe("takoserver.shared-hosted-pricing-preview@v2");
    expect(output.mode).toBe("preview");
    expect(output.plans.map((plan: { includedMicros: string }) => plan.includedMicros)).toEqual([
      "20000000",
      "100000000",
    ]);
    expect(output.activation).toBe("pending-stripe-price-ids");
    expect(output).not.toHaveProperty("environment");
    expect(output.revision).toBe("hosted-20261015-container-proposed-v1");
    expect(output.usageRates["wfp.requests"]).toMatchObject({
      numeratorMicros: "900000",
      denominator: "1000000",
    });
    expect(output.usageRates["container.cpu"]).toMatchObject({
      unit: "vCPU-second",
      numeratorMicros: "60",
      denominator: "1",
    });
    expect(output.usageRates["container.memory"]).toMatchObject({
      unit: "GiB-second",
      numeratorMicros: "7500",
      denominator: "1000",
    });
    expect(output.usageRates["container.egress"]).toMatchObject({
      unit: "GB",
      numeratorMicros: "150000",
      denominator: "1",
    });
    expect(output.usageRates["container.image-storage"]).toMatchObject({
      unit: "GB-month",
      numeratorMicros: "45000",
      denominator: "1",
    });
  });

  test("keeps the version 2 CLI diagnostics bounded and redacts untrusted source keys", async () => {
    const path = await mkdtemp(join(tmpdir(), "sp-"));
    try {
      const invalid = copySource();
      invalid.untrusted_value_must_not_be_echoed = "untrusted-value";
      const file = join(path, "source.json");
      await writeFile(file, JSON.stringify(invalid));
      await expect(previewFile(file)).rejects.toThrow(
        "Shared hosted pricing configuration is invalid",
      );
      await writeFile(file, '{"schemaVersion":2,"schemaVersion":2}');
      await expect(previewFile(file)).rejects.toThrow("without duplicate object members");
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
});
