import type { PricePlanCharge } from "../../src/catalog.ts";
import type { Offering } from "./api.ts";
import { tr } from "./i18n.ts";
import { money } from "./ui.ts";

export function offeringPriceLines(offering: Offering): readonly string[] {
  return [
    ...(offering.pricePlan.provisioning.amountMinor > 0
      ? [
          tr(
            `${priceLine(offering.pricePlan.provisioning, offering.pricePlan.currency)}（作成時のみ）`,
            `${priceLine(offering.pricePlan.provisioning, offering.pricePlan.currency)} one-time`,
          ),
        ]
      : []),
    ...offering.pricePlan.meters.map((charge) => priceLine(charge, offering.pricePlan.currency)),
  ];
}

export function provisioningPriceSentence(offering: Offering): string {
  const charge = offering.pricePlan.provisioning;
  if (charge.amountMinor === 0 && offering.pricePlan.meters.length > 0) {
    return tr(
      "作成料金なし。実測した利用量だけを請求します。",
      "No setup charge. Pay only for measured usage.",
    );
  }
  if (charge.amountMinor === 0) {
    return tr("作成料金なし。", "No setup charge.");
  }
  return tr(
    `${meterUnit(charge)}あたり${money(charge.amountMinor, offering.pricePlan.currency)}の作成料金です。適用時に確保し、成功時に一度だけ請求します。`,
    `${money(charge.amountMinor, offering.pricePlan.currency)} per ${meterUnit(charge)} as a one-time setup charge — held when you apply and charged once when it succeeds.`,
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
