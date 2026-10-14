# Pricing authoring preview

Authoring version 2 binds the finalized shared USD-micros source to the Host
tariff. Its top-level fields are `authoringVersion: 2`, `sharedPricing` (a copy of
`config/shared-hosted-pricing.json`), `planIds` (`free` and `usage`),
`billingConfig`, and `checkout`. The committed shared source keeps null Stripe
Price IDs for preview. For a private runtime candidate, supply both real TEST
Price IDs in `sharedPricing.plans` and the same IDs in
`billingConfig.plans.hosted-10` and `.hosted-50`. The parser rejects null or
duplicate Price IDs, a plan or Free amount different from the shared source,
and any nonzero meter missing or priced differently from the source's exact 3x
Cloudflare rate. The zero-rated egress entry is omitted from the strict tariff
because its meter parser accepts positive rates only. Set the tariff revision
to the shared source revision; preserve historical tariff revisions intact.
The monthly amounts and included allowances are converted from USD-micros to
Stripe cents only when exactly representable. The resulting table contains Free,
both paid plans, and usage. The two monthly review rows remain a checklist;
Checkout and invoice processing retrieve the referenced Price from Stripe in
TEST mode and verify the USD monthly amount. The preview never calls Stripe or
proves an ID belongs to this operator.

The version 1 authoring format below remains available for historical tariff
snapshots and existing one-plan configurations.

Version 1 takes operator-selected plan identifiers and tariff values and produces one shared hosted plan table for Takosumi Hosted and Takoserver. The free, subscription, and usage plan IDs are mandatory authoring inputs. The tool has no plan-ID or price defaults and does not activate billing, write configuration, call Stripe, or change a ledger.

The version 1 strict JSON input has top-level `authoringVersion`, `planIds`, `billingConfig`, `checkout`, and `stripeMonthlyReview` fields. `planIds` requires three distinct, lowercase IDs: `free`, `subscription`, and `usage`. The Host `billingConfig.plans` object must contain exactly one key, equal to `planIds.subscription`; its monthly Stripe review row must use that same key. The free and usage rows come from the same authoring input: the free row carries `billingConfig.freeIncludedMinor`, and the usage row carries the configured meters and Checkout bounds. No product-specific price or plan override is accepted.

Use the intentionally non-compilable [`examples/pricing.placeholder.json`](../examples/pricing.placeholder.json) as a field checklist. Replace all null and `REPLACE_ME` values. Choose all three IDs, then change the example's `subscription-plan-key` object key under both `billingConfig.plans` and `stripeMonthlyReview` to exactly the chosen `planIds.subscription`. The CLI rejects duplicate JSON members, invalid or duplicate IDs, plan/review mismatches, unresolved placeholders, and unknown authoring fields. It validates the full `billingConfig` with the canonical `src/billing-config.ts` parser and uses `src/payment-settings.ts` for Checkout bounds. Billing parser errors are sanitized so arbitrary input keys and values are not printed.

For a first tariff revision, remove the illustrative `history` entry or use an empty array. For an existing Host, retain accepted historical snapshots unchanged and give the new tariff a new revision and effective time. Amounts use USD minor units; meter rates retain the exact micros ratios defined by the Host tariff contract. The authoring file's `billingConfig` JSON string is preserved in the preview output as supplied, including omitted optional fields that the runtime parser may normalize while validating it.

Run the read-only preview with one private input file:

```sh
bun --no-env-file scripts/pricing/preview.ts /private/path/pricing.json
```

The input file is limited to 1 MiB and read with a bounded stream. Keep it out of source control if it contains operator pricing or unreleased Stripe IDs. Version 1 stdout contains `activation: "pending-unified-billing-runtime-alignment"`; version 2 reports `stripe-test-price-verification-required`. Both include the canonical billing environment string, Checkout environment strings, a Stripe review manifest, and one `hostedPlanTable`. The table names both products and a shared Organization balance, and emits the fixed class order free, subscription, purchased, then postpaid. Under version 2, Free is eligible only for a Free organization and never stacks on a paid allowance. The class order is not configurable. Purchased credit remains the existing verified-payment 1:1 amount; the preview does not create purchased-credit packages or grant postpaid service.

The compiler also emits `TAKOSERVER_HOSTED_PRICING`. Its runtime parser in `src/hosted-pricing.ts` accepts the same authoring document, limited to 262,144 bytes. The runtime's `assertHostedPricingMatchesBilling` check requires the embedded billing configuration, shared plan table, meters, and prices to match the active `TAKOSERVER_BILLING_CONFIG`; mismatch fails startup with a fixed safe error. Explicit hosted configuration enables [test-mode subscriptions and refunds](subscriptions-refunds.md) only with a Stripe test key and complete 0095 schema after #326's 0093/0094 cutover. A configured console origin enables subscription Checkout. The CLI itself remains read-only and activates nothing.

The table's free row exposes `configuredMonthlyCreditMinor` as the existing tariff compatibility field and marks `edgeAllowance` as `pending-owner-runtime-policy`. That monetary field does not claim an implemented edge-resource quota. The table's usage row carries configured meters and Checkout bounds as data only; the preview does not change charge calculation or ledger cents/micros priority. The subscription runtime consumes the paid row and verifies its Price against Stripe. Edge-resource quota and postpaid service remain pending; the subscription/refund runtime uses #326's micros and class-priority wallet; the preview activation field refers to that complete policy alignment.

The Stripe monthly review manifest is an operator checklist, not a Stripe read or live validation. It joins the expected USD monthly amount to the subscription plan's configured Stripe price ID. Before activation, independently confirm in Stripe that the referenced Price is active, USD, recurring monthly with interval count 1, licensed, per-unit, has the exact unit amount, and has no tiers, transforms, or customer-entered amount. See Stripe's [Price object](https://docs.stripe.com/api/prices/object) and [Create a Price API](https://docs.stripe.com/api/prices/create) for the fields to verify.

The Console's displayed billing defaults remain hardcoded until a separate UI change makes them reflect validated configuration. This preview is not an activation command.
