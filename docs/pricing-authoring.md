# Pricing authoring preview

This first slice makes operator-selected price and included-credit values replaceable input. It does not activate billing, write configuration, call Stripe, or decide Takoserver's commercial prices. Shouta chooses the final amounts and Stripe products.

The input has top-level `authoringVersion`, `billingConfig`, `checkout`, and `stripeMonthlyReview` fields. `billingConfig.freeIncludedMinor` is the free monthly credit amount. `billingConfig.plans` is keyed by plan ID; each plan has safe integer `includedMinor` and its Stripe `stripePriceId`. It may be empty when only the free tier is configured. `checkout` requires explicit `minimumMinor` and `maximumMinor` bounds. The review object has exactly one row per plan, with `expectedAmountMinor`, `currency`, and `interval`.

Use the intentionally non-compilable [`examples/pricing.placeholder.json`](../examples/pricing.placeholder.json) as a field checklist. Replace every null and `REPLACE_ME` with reviewed values. The CLI rejects duplicate JSON members, unknown authoring/review/checkout fields, unresolved placeholders, non-safe amounts, invalid plan keys and Stripe price IDs, and any mismatch between plan keys and monthly review rows. It applies `src/payment-settings.ts`'s existing validator and environment names to Checkout bounds.

For a first tariff revision, remove the illustrative `history` entry or use an empty array. For an existing Host, retain the accepted historical snapshots unchanged and give the new tariff a new revision and effective time. Amounts use USD minor units; meter rates retain the exact micros ratios defined by the Host tariff contract. No price or entitlement amount defaults in this tool.

Run the read-only preview with one private input file:

```sh
bun --no-env-file scripts/pricing/preview.ts /private/path/pricing.json
```

The input file is limited to 1 MiB and is read with a bounded stream. Keep it out of source control if it contains operator pricing or unreleased Stripe IDs. On success, stdout contains a JSON preview with `mode: "preview"`, the canonical `TAKOSERVER_BILLING_CONFIG` JSON string, and Checkout environment-variable strings. Save or transfer that output only through the operator's approved private configuration path. The output is not an activation command.

The compiler deliberately treats `billingConfig` as opaque tariff policy except for projecting root `freeIncludedMinor`, each plan's `includedMinor`, and each plan's `stripePriceId`. It checks the plan projection shape and preserves all other fields, including meter definitions and history, without importing or copying the Host parser. The intended runtime tariff authority is the organization billing API's `TAKOSERVER_BILLING_CONFIG` validator; its consumer currently exists on the companion feature branch in `src/billing-config.ts` and is not merged into this branch. After that API is merged, its validator must accept the projected canonical config before anyone activates it.

`stripeMonthlyReview` is an operator checklist manifest, not a Stripe read or live validation. It joins each expected USD monthly amount to the plan's configured Stripe price ID; each configured monthly plan has a positive safe integer amount. Before activation, independently confirm in Stripe that each referenced Price is active, USD, recurring monthly with interval count 1, licensed, per-unit, has the exact unit amount, and has no tiers, transforms, or customer-entered amount. The preview cannot establish that the remote object has any of those properties. See Stripe's [Price object](https://docs.stripe.com/api/prices/object) and [Create a Price API](https://docs.stripe.com/api/prices/create) for the fields to verify.

This slice only compiles configuration. It does not add monthly checkout or invoice entitlement grants. Purchased credit remains on the existing free-form 1:1 path: the verified paid minor-unit amount is credited without package bonuses. The Console's displayed billing defaults remain hardcoded until a separate UI change makes them reflect the validated Host configuration.
