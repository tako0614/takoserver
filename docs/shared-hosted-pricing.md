# Shared hosted USD pricing

`config/shared-hosted-pricing.json` records the operator's 2026-10-14 pricing
decision and supplied 2026-10-15 Container revision for Takoserver and Takosumi
Hosted. It uses integer USD-micros strings,
not a separate credit currency. The monthly Free allowance is USD 1.50. The
USD 10 and USD 50 subscriptions include USD 20 and USD 100 respectively. Free
is not added to a paid allowance, and additional prepaid funding grants its
face value.

The source records Cloudflare overage costs and their measurement quantities.
The pure compiler multiplies each cost by three, producing exact rational
USD-micros consumption rates. Free egress stays zero. The source also records
the default stop policy, 80% and 95% warning thresholds, unsupported postpaid,
and no short-window limits. Those fields describe the selected contract;
compiling the source does not implement or activate wallet policy or quotas.

The revision `hosted-20261015-container-proposed-v2` records these supplied rates:

| Meter | Unit | Cloudflare cost micros / quantity | Customer rate micros / quantity |
| --- | --- | --- | --- |
| `container.cpu` | vCPU-second | 20 / 1 | 60 / 1 |
| `container.memory` | GiB-second | 2500 / 1000 | 7500 / 1000 |
| `container.egress` | GB | 25000 / 1 | 75000 / 1 |
| `container.image-storage` | GB-month | 15000 / 1 | 45000 / 1 |

The same customer rates apply to hosted and executor Containers, using the
supplied Cloudflare cost basis. CPU measures active CPU time; memory measures
provisioned capacity while running. The supplied 2026-10-15 owner correction
selects the Cloudflare NA/EU egress cost basis of USD 0.025 per GB, giving a
customer rate of USD 0.075 per GB at 3x. The other Container costs and units
come from [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).
Image storage uses [R2 Standard storage pricing](https://developers.cloudflare.com/r2/pricing/)
as its supplied cost basis; it is not a separate published Containers image
tariff. No Container disk meter is added. Included provider quantities do not
reduce these customer rates or duplicate an Organization allowance. The existing
zero-cost `egress` row remains distinct from paid Container egress.

Memory remains exactly 7.5 micros per GiB-second as a rational rate. Aggregate
the closed measurement before ceiling once to integer ledger micros: one
GiB-second is 8 micros, while two together are 15, not 16. The source revision
does not rewrite any prior tariff's immutable meter tuples or settlement receipts.

The published `hosted-20261015-container-proposed-v1` source remains unchanged
in the reviewed revision archive. Its original Container egress rate is
150000 micros per GB; persisted invoice and phase snapshots continue to resolve
those original terms. New authoring uses revision v2 and 75000 micros per GB.

Measurement integration must convert byte-seconds to GiB-seconds with
`1 GiB = 1073741824 bytes`, and egress bytes to GB with `1 GB = 1000000000 bytes`.
[Cloudflare billing metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)
expose allocated memory as byte-seconds and transmitted traffic as bytes;
forwarding those raw quantities as GiB-seconds or GB would overcharge. Image
storage attribution must declare its period and daily-peak measurement, and
avoid charging the same image bytes through both R2 and Container storage.
Exact quantity conversion, source receipts and Workspace attribution remain
separate integration obligations; a tariff preview does not prove instrumentation.

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
Runtime activation additionally needs the strict operator tariff and verified
TEST-mode Stripe bindings. An authoring version 2 document binds a copy of this
source, with both actual Price IDs filled in, to the tariff; a null Price ID
fails closed. Every other field must match this checked-in source, including
both monthly cash prices. The activated runtime resolves Checkout requests and pinned paid
invoices by plan ID, checks the remote TEST Price and amount, and grants the
matching included USD-micros. The committed source remains a preview with null
Price IDs; syntactic IDs in a private authoring file are not proof of Stripe
ownership or activation. A new source revision also requires matching reviewed
version 2 authoring and an active tariff; the runtime's source-binding guard
rejects a new artifact configured with the predecessor's source terms.

The source does not set Checkout purchase bounds, grant clocks, provider
credentials, or deployment targets. Those remain separately supplied operator
inputs. Provider measurement, paid-period eligibility, opt-in prepaid
allocation, usage summaries and staging validation remain separate integration
obligations; a successful compiler preview is not evidence of live billing.
