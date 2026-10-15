import { formatMicrosCurrency, type HostedPlanTable } from "./api.ts";

/** Paid plan rows rendered as checkout choices; Free remains separate from paid allowance. */
export function subscriptionPlanOptions(table: HostedPlanTable, locale: "ja-JP" | "en-US") {
  const money = (minor: number) =>
    formatMicrosCurrency((BigInt(minor) * 10_000n).toString(), "USD", locale);
  return table.plans.flatMap((plan) =>
    plan.tier === "subscription"
      ? [
          {
            planId: plan.planId,
            monthlyAmountMinor: plan.monthlyAmountMinor,
            includedCreditMinor: plan.includedCreditMinor,
            monthlyAmount: money(plan.monthlyAmountMinor),
            monthlyAllowance: money(plan.includedCreditMinor),
          },
        ]
      : [],
  );
}
