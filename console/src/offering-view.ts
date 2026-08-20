import type { PricePlanCharge } from "../../src/catalog.ts";
import type { Offering } from "./api.ts";
import { tr } from "./i18n.ts";
import { money } from "./ui.ts";

export function offeringPriceLines(offering: Offering): readonly string[] {
  return [
    priceLine(offering.pricePlan.recurring, offering.pricePlan.currency),
    ...offering.pricePlan.meters.map((charge) => priceLine(charge, offering.pricePlan.currency)),
  ];
}

export function recurringPriceSentence(offering: Offering): string {
  const charge = offering.pricePlan.recurring;
  return tr(
    `${meterUnit(charge)}あたり${money(charge.amountMinor, offering.pricePlan.currency)}。適用時に確保し、成功時に請求します。`,
    `${money(charge.amountMinor, offering.pricePlan.currency)} per ${meterUnit(charge)} — held when you apply, charged when it succeeds.`,
  );
}

export function offeringInterfaceLabels(offering: Offering): readonly string[] {
  return offering.providedInterfaces.map((reference) => `${reference.name}@${reference.version}`);
}

function priceLine(charge: PricePlanCharge, currency: string): string {
  return `${money(charge.amountMinor, currency)} / ${meterUnit(charge)}`;
}

function meterUnit(charge: PricePlanCharge): string {
  const quantity = charge.quantity ?? 1;
  return quantity === 1 ? charge.meter : `${quantity.toLocaleString()} ${charge.meter}`;
}
