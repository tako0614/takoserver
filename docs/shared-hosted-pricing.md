# Shared hosted USD pricing

`config/shared-hosted-pricing.json` records the operator's 2026-10-14 pricing
decision for Takoserver and Takosumi Hosted. It uses integer USD-micros strings,
not a separate credit currency. The monthly Free allowance is USD 1.50. The
USD 10 and USD 50 subscriptions include USD 12 and USD 70 respectively. Free
is not added to a paid allowance, and additional prepaid funding grants its
face value.

The source records Cloudflare overage costs and their measurement quantities.
The pure compiler multiplies each cost by three, producing exact rational
USD-micros consumption rates. Free egress stays zero. The source also records
the default stop policy, 80% and 95% warning thresholds, unsupported postpaid,
and no short-window limits. Those fields describe the selected contract;
compiling the source does not implement or activate wallet policy or quotas.

The existing read-only preview entrypoint accepts this version 2 source:

```sh
bun --no-env-file scripts/pricing/preview.ts config/shared-hosted-pricing.json
```

The original version 1 operator tariff authoring input remains a separate
accepted input. Its immutable tariff snapshots and strict runtime Stripe
identity requirements are not rewritten by a version 2 price preview.

The version 2 source permits null Stripe Price IDs. The preview lists the
unresolved subscription plan IDs and reports `pending-stripe-price-ids`.
It emits no environment or deployment artifact. Supplying syntactically valid
Price IDs only makes the price preview qualified; it does not prove Stripe
prices exist, match the selected cash amount, or activate the subscriptions.
Runtime activation additionally needs the strict operator tariff, verified
TEST-mode Stripe bindings, and both-plan consumer support.

The source does not set Checkout purchase bounds, grant clocks, provider
credentials, or deployment targets. Those remain separately supplied operator
inputs. Provider measurement, paid-period eligibility, opt-in prepaid
allocation, usage summaries and staging validation remain separate integration
obligations; a successful compiler preview is not evidence of live billing.
