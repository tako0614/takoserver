import { readFileSync } from "node:fs";
import { compilePricingAuthoring } from "../../src/hosted-pricing.ts";

export function finalizedHostedPlanTable() {
  const shared = JSON.parse(
    readFileSync(new URL("../../config/shared-hosted-pricing.json", import.meta.url), "utf8"),
  );
  shared.plans[0].stripePriceId = "price_final10";
  shared.plans[1].stripePriceId = "price_final50";
  const meters = Object.fromEntries(
    Object.entries(
      shared.meters as Record<
        string,
        { unit: string; cloudflareCostMicros: string; quantity: string }
      >,
    )
      .filter(([, meter]) => meter.cloudflareCostMicros !== "0")
      .map(([key, meter]) => [
        key,
        {
          unit: meter.unit,
          rate: {
            numeratorMicros: (BigInt(meter.cloudflareCostMicros) * 3n).toString(),
            denominator: meter.quantity,
          },
        },
      ]),
  );
  return compilePricingAuthoring({
    authoringVersion: 2,
    sharedPricing: shared,
    planIds: { free: "free", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: shared.revision,
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86400,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {
        "hosted-10": { includedMinor: 2000, stripePriceId: "price_final10" },
        "hosted-50": { includedMinor: 10000, stripePriceId: "price_final50" },
      },
      meters,
    },
    checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
  }).hostedPlanTable;
}
