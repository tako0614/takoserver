# Hosted billing API specification

Status: specification and source implementation; staging acceptance pending.
The original proposal used baseline `376afb5caecaf9b25da0e49b296cdfb714748bb2`.
The implementation preserves #342's subsequent subscription custody contract.
Target: API specification review by 2026-10-17, staging APIs/webhooks by
2026-10-22, real Stripe test-mode acceptance by 2026-10-25, for the
2026-11-15 shared Hosted launch. These dates do not establish deployed readiness.

## Existing contract and change scope

Takoserver already owns an integer USD-micros Organization wallet, hold/usage
receipts, usage summary, subscription Checkout/cancellation, verified Stripe
invoice grants/refunds and bounded reconciliation. Extend that implementation.
The historical cents proposal is not the new settlement authority.

| Capability | Existing API | Extension in this proposal |
| --- | --- | --- |
| Usage summary | `GET /v1/organizations/{organizationId}/wallet/usage-summary` | Opaque Workspace attribution and a same-snapshot usage breakdown |
| Subscription | `GET`, `POST`, `PATCH /v1/organizations/{organizationId}/payments/subscription` | Next-period plan change, preserving existing start/cancellation shapes |
| Top-up | `POST /v1/organizations/{organizationId}/wallet/checkout` | Durable reference and payment scope; this existing route is the top-up API |
| Personal Organization | Generic `POST /v1/organizations` | Proposed session-only `POST /v1/organizations/personal`, unique per local principal |
| Limit policy | `GET`/`PATCH /v1/organizations/{organizationId}/wallet/limit-policy` | Explicit on-demand terms/card consent; postpaid remains disabled |
| Pricing publication | Existing authoring/compiler and immutable tariff registration | Reviewed publication/readback using the same revision authority |
| Webhooks | `POST /v1/payments/stripe/webhook` | Reuse invoice/subscription/Checkout/refund settlement and reconciliation |

Runtime, generated OpenAPI and opt-in entries contain the canonical extension;
operator activation, complete CI, implementation QA and staging acceptance remain
separate requirements. Routes and shapes are defined by the
[route table](../src/route-table.ts), [control boundary](../src/control.ts),
and [generated OpenAPI](../openapi/takoserver.openapi.json). The
[implementation guide](subscriptions-refunds.md) describes actual receipt and
availability behavior. Postpaid remains unavailable. On-demand is an explicit optional source
composition, with its public contract below; source availability does not qualify staging.

[#343](https://github.com/tako0614/takoserver/pull/343), head
`8c0ff298a1ab560f2a66c93a341e2d7fb8c6b67a`, owns the subscription table's
three/four-row OpenAPI correction and regression. The genuine #342 dependency
already contains the legacy three-row/current four-row bounds. Preserve that
contract and coordinate #343 without duplicating its patch or introducing a
second subscription API.
The runtime v2 table has Free, two monthly choices and usage; legacy v1 has
three rows. Four rows still represent three commercial roles.

## Canonical entry selection

Bun and Worker select the canonical TEST composition only when
`TAKOSERVER_HOSTED_BILLING=canonical-test`. An absent or empty selection keeps
the existing independent lane; any other value refuses startup. Selecting this
lane requires all of the following operator inputs and existing qualifications:

| Input | Requirement |
| --- | --- |
| `TAKOSERVER_STRIPE_MODE` | Literal `test`; LIVE cannot be selected |
| `TAKOSERVER_BILLING_CONFIG` and `TAKOSERVER_HOSTED_PRICING` | Matching published tariff, Checkout bounds and complete paid Price set |
| `TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID` | Explicit expected account, verified through the captured native client |
| `TAKOSERVER_HOSTED_BILLING_AUTHORITY` | Explicit stable authority matching the existing database financial realm |
| `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` | Isolated TEST credentials for the same account and signed webhook path |
| `TAKOSERVER_CONSOLE_ORIGIN` | Canonical configured return origin |
| Database | Qualified mode/financial-realm pins and complete canonical billing schema |

The explicit canonical selection enables the complete qualified TEST payment
lane on both entries. The Worker's legacy
`TAKOSERVER_STRIPE_CHECKOUT_ENABLED` and `TAKOSERVER_STRIPE_WEBHOOK_ENABLED`
flags do not additionally gate this selection. They retain their existing
behavior when the canonical lane is unselected. Missing or mismatched credentials,
account, Prices, schema or pins refuse startup; the resolver does not create or
replace a financial realm or invent a Price. Bun retains its normal SQLite
migration lifecycle; this source option does not authorize a live schema apply.

Worker qualification failures retain the original diagnostic cause while
returning the generic startup refusal. Bun's existing owned payment-reconcile
timer and Worker's scheduled pass use the selected canonical app; the entry does
not install a second grant writer. Postpaid remains off as described below.
Entry source availability does not establish a configured staging target,
qualified measurement or warning delivery, or successful Stripe TEST E2E.

## Ownership and authentication

Takoserver owns Organization identity, billing authorization, the sole balance,
pricing receipts and Stripe settlement. Accounts owns common identity; Control
owns Workspaces, membership and the set-once billing binding. Takosumi Hosted
owns its product access and a projection of that binding with a random opaque
`workspaceRef`. It calls the authenticated API server-side.
Neither a client-supplied billing subject nor an email proves Organization
ownership. Shared login design does not grant cross-product authorization.

One Organization balance, allowance and subscription cover both products and
all its Workspaces. A Workspace does not create another balance or free grant.
Hosted sessions and raw grants stay in the owning RP. The optional
[browser billing continuation](hosted-browser-billing-continuation.md) carries
the selected canonical account and Workspace/Organization original through a
published business contract; its locator and DATA do not grant payment authority.
Existing generated policy still assigns separate retail Stripe authority to
Hosted: canonical governance adoption and retirement of the predecessor
retail writer are separate prerequisites for unified live composition.
Self-host retains its independent account/wallet and does not acquire these
Hosted commercial defaults merely by running Takoserver OSS.

| Operation | Authority |
| --- | --- |
| Wallet, summary, breakdown, limit-policy and subscription reads | `wallet:read` for the exact Organization, or the existing permitted owner session |
| Holds/capture/release | `wallet:write` |
| Closed usage submission/listing | `usage:write` / `usage:read` |
| Subscription and top-up commands | `payments:write`, or the existing permitted owner session |
| Limit-policy changes and card registration | `payments:write`, or permitted owner session; wallet writers cannot authorize card charges |
| Personal Organization creation | Authenticated local Takoserver principal's session only |
| Webhook | Signature over exact raw bytes, followed by realm/custody verification |

Authenticate and check the exact Organization/scope before looking up billing
objects or parsing the command body. Scopes do not imply other scopes.
Legacy top-up is owner-session-only; the canonical reference-based extension
also accepts `payments:write`. Personal creation does not accept an arbitrary principal ID, API
key impersonation, Hosted session or caller-selected owner. A future delegated
account bootstrap requires its own reviewed account contract.

### Original Customer custody observations

The internal `createStripeCustomerCustody().inspect(organizationId)` reads the
Organization, original Customer command and sole Customer binding in one SQL
snapshot. It returns `{organizationId, command, binding}`. The nullable command
contains only `state`, `fingerprint`, `createdAt`, `dispatchedAt`, `verifiedAt`
and `customerId`; the nullable binding contains `customerId` and its stored
`createdAt`. That historical binding timestamp is SQL text, not proof of command
chronology. Command timestamps preserve wall-clock readings; their numerical order
does not determine command state. Returned observations are frozen. Reading does
not consult the clock, call Stripe, create a command or expose processor keys,
requests or realm data.

The same closed decoder runs on the actual `ensure` path before effects and
after recovery. A pending original cannot be abandoned for another Customer
binding. Customer preparation precedes subscription/top-up intent creation, so
an absent purchase intent does not establish absent Customer history. Null
observations describe these local tables only; they do not certify complete
legacy history or authorize a clear. This source API adds no public HTTP route,
shared Financial Principal projection or current-payer admission. First-command
admission against a genuine current payer remains a separate integration contract.

### Metering and on-demand admission

The provider-window metering receiver accepts the valid on-demand admission
witness produced by the canonical limit policy. It preserves that witness and
settles eligible existing included/purchased credit under the ledger's existing
allocation rules. Insufficient credit leaves the original measurement pending;
this receiver does not issue a fresh cash command. Complete Run/storage evidence,
its trusted sender and the same-Organization/Workspace binding must still be
supplied by their owning integration. Postpaid remains disabled.

## Money, plans and monthly entitlements

Currency is USD. Public amount fields are canonical nonnegative decimal integer
strings in `*Micros`; ledger deltas (`settledDeltaMicros`, `heldDeltaMicros`)
permit canonical signed integers without negative zero. One USD is 1,000,000
micros and one cent is 10,000 micros.
Use checked integer/BigInt arithmetic; reject unsafe values and aggregate
overflow. Historical `microcent-v1` receipts retain their unit and original
fingerprint. Commercial cash fields such as `amountMinor` retain integer cents.

| Offer | Monthly cash | Included consumption |
| --- | --- | --- |
| Free | No charge and no card | `1500000` micros (USD 1.50) |
| USD 10 plan | 1,000 cents | `20000000` micros (USD 20) |
| USD 50 plan | 5,000 cents | `100000000` micros (USD 100) |
| Top-up | User-selected bounded cents | Exactly `amountMinor * 10000` micros |

These amounts come from the reviewed [shared pricing source](shared-hosted-pricing.md).
Plan identifiers and TEST Price bindings remain configured values. Clients
select a configured plan, never supply a subscription price or included grant.
Free grants are once per Organization per frozen UTC calendar month. Paid
allowance follows the verified monthly invoice line's service period and
expires at its end. Top-ups do not reset monthly; retain their pinned purchase
expiry policy. `nextResetAt` means the current grant ends, not that another
invoice has already paid or a new allowance is guaranteed.

During verified paid coverage, Free does not stack with paid included credit
and is excluded from new allocation. Previously pinned Free holds and history
survive. A partial refund leaves remaining paid coverage; a full settled refund
or coverage end restores eligibility only under the existing refund/fence rules.
No `active` subscription status alone funds a lot or establishes paid features.
Included credit becomes available at the verified invoice period's start.
A paid future-period invoice remains deferred until that boundary; replay or
reconciliation then grants its original period once. Historical future-funded
lots retain their original rows and amount, but cannot fund a new allocation
before their period starts. Existing reserved captures and releases retain
their original allocation. Advancing a Stripe TEST clock does not advance the
application clock or authorize an early allowance.

Consumption uses eligible Free, then subscription, then explicitly eligible
purchased credit. Within each class use earliest expiry, then stable creation
and reference ties. Do not silently substitute global FIFO. Unknown historical
direct-credit provenance remains separately reported and cannot be guessed.

Usage prices are exactly three times the configured Cloudflare overage price.
Store exact rational quantities/rates; ceiling the complete closed measurement
once to integer micros (including a sub-micro measurement such as 0.9 micros
becoming 1 micro). Aggregate payable micros over the closed billing period
and ceiling to cents once: `payableMinor = (payableMicros + 9999) / 10000` with
integer division. Two payable items of 4,001 micros yield 1 cent together,
not 2 cents. Zero payable micros yield zero cents. Paid prepaid consumption
already debited from lots is not billed again. Invoice collection and its
cash-versus-micros rounding difference need one durable period receipt.

## Usage summary and Workspace attribution

Existing response remains `{usageSummary: {...}}`. Its required fields are
`organizationId`, `currency: "USD"`, `unit: "USD-micros"`, `periodKind:
"free" | "paid"`, `periodStart`, `periodEnd`, `nextResetAt`,
`originalIncludedMicros`, `effectiveIncludedMicros`, `usedMicros`, `heldMicros`,
`availableMicros`, `revokedMicros`, `utilizationBasisPoints`,
`reached80Percent`, `reached95Percent`, `limitReached`,
`purchasedAvailableMicros`, and `directAvailableMicros`. Money is strings;
utilization is an integer, warning/limit flags are booleans, times are canonical
UTC ISO timestamps. Preserve its current one-SQL-snapshot entitlement read.

Utilization is `(used + held) / effective included allowance`, capped at
10,000 basis points. Purchased/direct availability does not enlarge that
denominator. Zero allowance reports zero utilization, false warning flags and
`limitReached: true`. Alerts occur at 8,000 and 9,500 basis points. Read flags
already exist; warning delivery is a separate durable outbox with uniqueness
on Organization, period and threshold. Repeated reads, retries and restarts
do not send duplicates. Release can lower utilization without erasing an
already-delivered warning. Configure notification transport before claiming
warnings were delivered.

Usage settlement and internal Ledger holds, debits, captures and releases must
retain crossed thresholds in the same atomic money batch. The warning reads
the post-mutation entitlement using the settlement's instant; a failed warning
write rolls back the entire batch. Opening a usage-summary page is not required.
Retries retain the original Organization/period/threshold row and delivery key.

The normal maintenance tick dispatches through the configured transport after
legacy repair and before later money work. Warnings created by that tick's
metering pass are available to the following tick. An unavailable transport
leaves pending rows untouched. A delivery failure remains observable while
other maintenance proceeds; if later work also fails, retain both causes.
An unacknowledged delivery keeps its original claim and key for recovery after
the claim expires. Transport qualification remains an operator responsibility.

Proposed additional route:
`GET /v1/organizations/{organizationId}/wallet/usage-summary/workspaces`.
Query accepts `limit` (1-100, default 50) and an opaque `cursor`; a first-page
optional `workspaceRef` filter returns only that authenticated Org's attribution.
Foreign references/cursors do not reveal data. Response:

```json
{
  "organizationId": "org_example",
  "snapshotAt": "2026-10-15T00:00:00.000Z",
  "periodStart": "2026-10-01T00:00:00.000Z",
  "periodEnd": "2026-11-01T00:00:00.000Z",
  "unit": "USD-micros",
  "totals": {"usedMicros":"12000","heldMicros":"8000","pendingMicros":"1000"},
  "workspaces": [{"workspaceRef":"ws_opaque","usedMicros":"10000","heldMicros":"8000","pendingMicros":"1000"}],
  "unattributed": {"usedMicros":"2000","heldMicros":"0","pendingMicros":"0"},
  "cursor": null
}
```

The breakdown reports all consumption classes, not just included usage; its
`usedMicros` therefore need not equal included-summary `usedMicros`.
`pendingMicros` is consumed-but-unpaid usage, not available balance or another
debit. `totals` are complete Org totals for the snapshot, never a page subtotal.
`unattributed` is one explicit historical bucket. Filtered reads still label
`totals` as Org totals. A single Workspace has usage/holds, not spendable balance
or allowance. UI must not sum repeated totals across cursor pages. For an
unfiltered snapshot, complete Workspace rows plus `unattributed` equal `totals`;
filtered rows are a subset and cannot prove that equality by themselves.

The selected period is the same current entitlement interval returned by the
included summary, frozen at snapshot creation. Persist a hold's attribution
interval from that interval at admission; all later capture consumption belongs
to that original interval even after reset. `heldMicros` includes only live,
unexpired outstanding holds assigned to the selected interval at snapshot time.
Older-period live holds remain visible through the Org wallet/hold APIs and do
not become current-period usage. Direct closed usage is assigned by measured
`periodStart`, with historical entitlement boundaries resolved from immutable
period proofs; split a measurement crossing those boundaries before submission.
Pending usage becomes paid by changing its counted state once, never by adding
a second measured cost or counting its payment timestamp as another period.
Release/refund changes held or revoked accounting without creating usage.
Historical entries without structured attribution use their immutable original
hold-admission or closed-usage period when provable, otherwise their original
ledger settlement timestamp, within `unattributed`; never backfill a Workspace.
This attribution convention must be tested separately from grant-source totals.

Persist `workspaceRef` as a nullable, explicit attribution column on holds and
closed usage, receipts and exact request fingerprints. Hosted new writes
require an Org-bound random reference; independent/self-host and historical
writes may remain unattributed. A reference has the existing opaque-reference
grammar and is unique within an Org. Binding is immutable while live holds or
unpaid usage remain. References matching `^wrk_[0-9a-f]{32}$` are reserved
for shared-auth Workspaces: in the canonical composition, only the Workspace's
derived billing Organization may create their first binding, and any other
Org is refused with `409 conflict` (service code `workspace_ref_reserved`)
and no write. See `docs/shared-auth-staging-integration.md`. Capture inherits the hold's reference and cannot switch
Workspace. Release/refund/expiry keep the same attribution. Do not derive it
from arbitrary hold reference text. Late usage belongs to its measured period,
not delivery time; prepaid allocations do not become new usage rows.

Pagination requires a bounded durable snapshot for mutable held/pending state;
a timestamp-only cursor cannot reproduce a historical hold projection. Pin
snapshot identity, Org, period, filter and stable Workspace ordering in every
continuation. Preserve rows and complete totals across pages. Use a declared
10-minute snapshot TTL; an expired snapshot returns a nonretryable 409 requiring
a fresh first page. Implement/readback this schema before advertising the
route. Concurrent settlement tests must prove pages sum to the frozen totals.

The Console billing page shows this route read-only as **Workspace usage**:
opaque `workspaceRef` rows with used/held/pending micros, the `unattributed`
row and the snapshot's Organization total, labelled with the period and
snapshot time. "Load more" follows `cursor` within the same snapshot, and the
section refreshes together with the wallet. The Console rejects a page whose
identity, exact keys, micros strings or row order are malformed, never sums
`totals` across pages, and never merges pages whose snapshot time, period,
totals or unattributed bucket differ. An expired continuation (`409`) discards
the loaded rows and restarts from page one. A Host without the route
(`not_found`) shows no section; any other failure is shown with a retry.

## Subscription start, change and cancellation

GET preserves `{subscription: <projection or null>, planTable: <existing table>}`.
Existing projection fields are `organizationId`, `subscriptionId`, `planKey`,
`pricingRevision`, `status`, `cancelAtPeriodEnd`, `periodStart`, `periodEnd`,
`paidThrough`, `paidFeatures`, `updatedAt` and the opaque `subscriptionRef`. Return provider fields only
where the existing public contract already admits them; never expose secrets.

POST accepts `{reference, planKey}` with #342's durable `checkout` receipt:
`201` for an open Checkout, `202` for an unknown pending outcome and `200` for
an associated or expired original Checkout. An open receipt includes its
`state`, `id` and `url`; an associated receipt carries `subscriptionRef`.
Begin a monthly subscription Checkout using the bound customer and frozen revision.
There is at most one unresolved subscription start per Org. All processor commands below use a durable per-step receipt, immutable
parameters and a stable processor idempotency key: customer creation,
subscription start, schedule create/update/release, cancellation and on-demand
charges. The original selected tariff/boundary never changes on retry.
Apply the 23-hour unknown-ACK cutoff and authoritative readback to every step;
never mark a multi-step command complete after only its first effect. Local
receipts survive key pruning. No grant comes
from Checkout creation/return or a subscription-mode Checkout event; only the
verified paid invoice funds included credit. Free requires no Stripe customer
or card. A paid plan needs a valid payment method through Checkout.

PATCH accepts `{reference, cancelAtPeriodEnd: true, expectedSubscriptionRef}`
or the exclusive variant `{reference, planKey, expectedSubscriptionRef}`.
The opaque target comes from the verified subscription read; a changed target
is refused before a processor effect. `false` cancellation, combined actions
and unknown keys are rejected with 400. A plan change schedules the configured price at the next recurring period
boundary, without proration, immediate cash charge or another current-period
grant. Use a processor subscription schedule or equivalent proven next-period
mechanism; an immediate update with no proration is insufficient proof of
next-period price activation. Return `202 {planChange: <pending receipt>}` or
`200 {planChange: <verified receipt>}`. The verified receipt contains
`subscriptionRef` and `pendingChange`; its exact fields are owned by OpenAPI.
Cancellation returns its separate pending/verified `cancellation` receipt.
GET includes `pendingChange` when the phase adapter is composed. Qualified
Hosted GET also includes `billingCapabilities` with
`contractVersion: "hosted-billing-v1"` and booleans for `topUps`,
`subscriptionStart`, `subscriptionCancellation` and `subscriptionPlanChange`.
Missing/false capabilities do not authorize a command. The existing usage
plan row supplies the authoritative Checkout minimum and maximum.

Freeze the selected future revision/Price and effective boundary in the durable
command. The future processor phase must set `planKey` and `pricingRevision`
metadata alongside its Price so the existing invoice pin verification sees the
same immutable tuple. Confirm the renewal invoice carries that phase's tuple;
updating only the Price would leave grants deferred under current validation.
Preserve all current phase settings and the billing anchor, disable proration
on both schedule update and phase transition, and read back the exact future
Price/metadata tuple and boundary before recording acknowledged scheduling. Reject an unavailable/unqualified revision or a subscription with
unresolved settlement. Only one pending plan change may exist. Cancellation
and plan change are exclusive pending intents: cancellation releases the processor
schedule while preserving the subscription, then sets period-end cancellation
after authoritative readback. Never cancel the schedule to remove a pending
change: that can immediately cancel the underlying subscription. Persist and
recover each step of the release/cancel saga; a plan change while cancellation
is scheduled returns 409. Reversing cancellation is not implemented. Serialize
commands per Org and return the committed original command result on replay.
At renewal verify the actual invoice/Price and grant that period's selected
included credit exactly once. Failed renewal grants no new allowance.
Cancellation preserves paid lots until their original expiry/refund.

### Original subscription command receipts

The qualified Hosted lane supplies
`GET .../payments/subscription/commands/{kind}/{reference}` with `wallet:read`
for the exact Organization. `kind` is `start`, `cancel` or `plan-change`;
references follow the existing 1–128 character command syntax. Query parameters
are rejected. The response is `{receipt: ...}` with
`contractVersion: "hosted-subscription-command-v1"`. This separate receipt
version does not add fields to `hosted-billing-v1` capabilities.

The closed receipt contains `organizationId`, `reference`, `kind`, `state`,
`subscriptionRef`, `planKey`, `pricingRevision`, `checkout`, `effectiveAt`,
`pendingChange` and `lifecycle`. It retains the original opaque target and
selected terms even after another subscription becomes current. Processor
object IDs, customer IDs and internal custody keys are omitted. Nullable fields
are explicit; OpenAPI defines the allowed combinations.

| Kind | State | Lifecycle and retained result |
| --- | --- | --- |
| `start` | `pending`, `open`, `associated`, `expired`, `invalidated` | Lifecycle equals state; open has its recorded Checkout URL, associated retains its original opaque target |
| `cancel` | `pending`, `verified` | `pending` or `scheduled`; a verified result records the original cancellation boundary and never asserts termination |
| `plan-change` | `pending`, `verified` | `pending`, `scheduled`, `activated`, `revoked`; verified retains its original `pendingChange` tuple in every lifecycle |

This GET reads local retained custody and immutable workflow evidence. It does
not call Stripe, register pricing, advance commands, reconcile, consult the
current management gate or write SQL. Pending includes an accepted processor
effect whose acknowledgement was lost. Activation and revocation require the
original command's immutable verified workflow and term evidence; elapsed time,
the current projection or a missing pending slot cannot establish either.
For example, a late cancellation that lacks a recorded activation step can
leave the original plan receipt `scheduled` even after its boundary passes.

Missing receipts and unavailable/legacy lanes return 404; corrupt or unreadable
proof returns `503 billing_unavailable`. Neither is proof that no effect occurred
or permission to invent another reference. Persist the original qualified
source binding, reference, requested plan and opaque target across retries.
Do not derive a legacy command's missing reference or source epoch from current
configuration. A reviewed legacy adoption resolver remains a separate consumer
activation requirement.

An original `associated` start receipt plus an authenticated subscription
projection for the same source, Organization and `subscriptionRef` with status
`canceled` or `incomplete_expired` supports archiving that target before an
explicit new purchase intent is submitted to the current server admission gate.
The projection is a retained writer observation. This does not clear other
unknown commands. Associated alone, a scheduled cancellation, its timestamp,
`pendingChange: null`, or an absent projection does not establish termination.

## Idempotent top-up

Top-up extends the existing `POST .../wallet/checkout`; there is no parallel
funding endpoint or payment writer. Hosted request becomes:
`{reference, amountMinor}`. `amountMinor` is safe integer USD cents within
configured Checkout bounds. Preserve `{checkout: {url}}` and 201 on an exact
replay. Existing self-host `{amountMinor}` compatibility is retained only in
its legacy lane; Hosted callers must supply a reference. Wallet write authority
alone cannot create Checkout or fund money. A top-up requires payment through
Checkout and grants its verified cash face value, without paid-plan bonuses.

Before the remote request, atomically persist an Org-scoped command receipt
and fingerprint covering cash, USD, purchase purpose, canonical request,
processor realm and frozen tariff/expiry policy. Use its stable processor
idempotency key. Exact retries return the same URL and accepted cash amount
even after current purchase bounds change; changed payload returns 409 without
a second effect. New references must satisfy the current bounds. A definitive expired Checkout closes that command;
a new purchase needs a new reference. Lost acknowledgement remains pending and
requires readback/reconciliation, never a fresh reference to guess success.

Retain local command receipts beyond Stripe's key retention. An unknown outcome
older than the existing 23-hour safety cutoff requires operator reconciliation;
never blindly retry an effect after the remote idempotency guarantee expires.
A pending/result lookup through
`GET .../wallet/checkout/{reference}` (`wallet:read`) returns
`{reference, state: "pending" | "ready" | "paid" | "expired", checkout: {url} | null}`.
This read is not permission to settle funds. Definitively invalid arguments
make no command; uncertain remote responses keep the existing receipt.

The existing signed webhook and settlement verifier perform actual funding
once per Checkout/object identity. Verify paid state, USD, amount, customer,
purpose, test realm and pinned revision. Late payment uses original purchase
policy; expiry starts at first verified funding and is frozen for replays.
Separate test-mode receipts from live or connected-account objects.

## Idempotent personal Organization

`POST /v1/organizations/personal` is session-only and accepts an empty
JSON object. Derive owner identity and initial display name server-side from the
local principal; reject unknown keys. First creation returns 201
`{organization: <existing Organization>, created: true}`; later/concurrent calls
return 200 with the same Organization and `created: false`. The uniqueness key
is the authenticated Takoserver principal, not the caller's reference or email.

An additive unique principal-to-personal-Org mapping, Org and owner membership
commit atomically. Concurrent transactions elect one mapping; losers read it.
Lost-response retries return the same mapping. No card, Stripe customer or paid
subscription is created. The existing once-per-Org monthly grant applies when
billing is enabled; creation does not mint another free lot.

Generic Organizations keep their existing identities and balances. Do not
select a principal's first generic Org or merge funded Orgs automatically.
Existing automatically created Org adoption requires an unambiguous protected
mapping proof; otherwise leave adoption pending operator resolution and refuse
a second personal grant. Mapping cannot point to a deleted or foreign-owned
Org. Account-link/merge, ownership transfer and personal-Org deletion are
separate reviewed lifecycle changes; principal replacement cannot reset credits.

## Limit modes, consent and admission

The desired policy vocabulary is exactly
`"stop" | "prepaid" | "postpaid" | "on-demand"`; default is `"stop"`.
The canonical Hosted extension persists the Organization policy and advertises
postpaid as unsupported. An enum declaration is not execution capability.

| Mode | Required behavior |
| --- | --- |
| `stop` | Admit from eligible included credit; stop new billable work when it cannot cover the hold; preserve reads/data and existing terminal settlement |
| `prepaid` | Explicit owner consent enables purchased credit after included credit; no card is required to spend already-paid credit; insufficient eligible credit stops |
| `on-demand` | Explicit off-session consent, verified saved card and user-selected monthly cash cap; successful charge creates purchased credit before admission |
| `postpaid` | Explicit consent/cap, atomic period exposure reservations, a closed-period invoice and unpaid-collection recovery; unsupported until separately implemented and qualified |

Saved card alone is never consent. Failure, SCA, timeout or unknown payment
outcome blocks fresh billable admission while preserving data and pinned holds.
The on-demand cash cap uses a UTC calendar month, distinct from the paid
invoice allowance period. Pin `capPeriodStart`/`capPeriodEnd` and the original
consent/cap revision on every cash command. Month rollover creates the next
cap bucket without replenishing or discarding historical paid/reserved exposure.
Unresolved previous-month effects retain their original reservation and block
fresh charging until authoritative readback; renewal does not move them to a
new cap month. On-demand reserves cap atomically before a charge; paid cash still counts toward
the cap even if the following hold races/fails. Recover by reading the original
charge intent; never bill once as prepaid and again in the period invoice.
On-demand off-session funding additionally needs a qualified immutable
PaymentIntent/Charge source identity and one atomic purchased-lot/ledger/grant
proof, with paid-cash consideration and original cap reservation. Duplicate
charge events/readback cannot credit again. Reuse original-source refund fences
and unused/held/used/expired revocation behavior. Current migration 0095's
source types support Checkout/invoice only; extend through a reviewed forward
schema rather than relabeling a PaymentIntent as Checkout or reusing its ID.
Until funding, recovery and refund lookup all qualify, capability remains false.
Specify the top-up quantum/minimum through validated operator configuration
and disclose it before consent. Do not choose a silent default cash cap.

GET returns `{onLimit, capabilities, consentRevision, cashCapMinor,
periodStart, periodEnd}` with unavailable modes marked false. For on-demand,
these policy periods are the UTC cap month; prepaid/stop expose that same month
for configuration consistency, independently of usage-summary grant periods.
Future postpaid capability must separately declare its invoice period in its
reviewed consent terms. PATCH accepts `{reference, onLimit}` for stop/prepaid.
On-demand requires `reference`, `onLimit`, `cashCapMinor`, `consentRevision`,
`termsRevision`, `paymentMethodId` and optional `setupIntentId`; postpaid retains
its unavailable four-field shape with cash cap and consent revision.
`cashCapMinor` is positive safe integer USD cents within the published bounds.
Reject extra fields; replay/conflict rules match other payment commands. An
exact original policy replay precedes current terms/card revalidation. Changed
original payload or payment principal conflicts. Revisions identify the exact
displayed terms; a saved card or successful registration is never cash consent.
Authorize and record the owner or delegated payment principal. An unavailable
mode cannot persist an active policy or charge money. Changing cap/mode does
not cancel remote effects. A stop transition atomically abandons never-dispatched
commands and releases their reservations; dispatched unknown effects retain
original exposure. Other changes serialize outstanding exposure and never lower
a cap below paid/reserved exposure.

The older settled pricing proposal rejects invoice-style postpaid at launch;
this task retains the four-value vocabulary. The launch decision remains with
Shouta. The operator-only `postpaidEnabled` composition flag defaults to `false`;
omitting it keeps postpaid off. It is not an Organization policy field and is
never inferred from a saved card, a paid plan, API scopes or environment mode.
Both Hosted startup factories and the policy factory reject `true` with
`503 postpaid_not_qualified` before accessing SQL, the clock or Stripe: postpaid
execution and settlement have not been implemented and qualified. Invalid flag
types are also rejected. Setting the flag alone cannot establish that capability
or customer consent. Future activation requires Shouta's launch decision and
separately reviewed execution, exposure and collection behavior; until then
`capabilities.postpaid` remains `false` and postpaid commands are rejected,
including an original command replay. Staging acceptance must cover each
advertised available mode; unsupported modes must be visibly rejected.

## On-demand terms, card registration and funding

The canonical composition accepts an optional explicit on-demand configuration.
Without it, on-demand capability stays false. It supplies immutable terms,
validity, USD funding quantum/minimum/maximum, user-selected cap bounds,
purchased-credit expiry, card-setup return URLs and a disclosure revision.
There are no default economic values, cap, consent, card or production authority.
The mode requires the genuine TEST realm and the shared funding store.

All paths below are under `/v1/organizations/{organizationId}/wallet/on-demand`
and return `Cache-Control: private, no-store` on success and failure.

| Method/path | Scope | Result |
| --- | --- | --- |
| `GET /terms` | `wallet:read` | `{terms, setupDisclosureRevision}` with the explicit terms |
| `POST /card-setup` | `payments:write` | `{receipt, checkout, selection}` for `{reference, setupDisclosureRevision}` |
| `GET /card-setup/{reference}` | `wallet:read` | `{cardSetup: receipt}` from SQL only |

The setup receipt contains only `reference`, `state`, `setupDisclosureRevision`,
`sessionExpired` and nullable `observedAt`. The POST may return a transient
Checkout `{url}`. Repeating that same POST after verified success may return
`selection: {paymentMethodId, setupIntentId}` for a later, separate policy PATCH.
The GET returns neither an action URL nor a payment selector, and makes no
processor request. No API returns full card objects or processor client secrets.
Both scopes are bound to the exact Organization before parsing or lookup.

A cardless Free Organization may register without buying a plan or top-up.
Setup uses the original independent customer custody and `mode=setup`; it grants
no wallet credit and creates no charge consent. A new reference must acknowledge
the current disclosure. An exact original replay retains its original actor and
disclosure even after publication changes. Session expiry alone does not prove
SetupIntent cancellation or authorize another remote effect.

Fresh holds or new closed usage first try eligible local credit. Only a genuine
eligible-credit deficit may prepare one immutable original cash command and
reserve its UTC cash cap atomically. The disclosed rule is
`max(minimumChargeMinor, ceil(deficitMicros / (fundingQuantumMinor * 10000)) * fundingQuantumMinor)`;
an amount above the explicit maximum is refused. First dispatch recalculates the
quote from current deficit and the saved terms. If another funding source changes
the quantum result, retain the prepared command/reservation and refuse dispatch;
do not resize it, rotate the cash reference or issue a replacement charge. Zero
deficit or accepted original admission uses the existing atomic abandonment path.

First dispatch rechecks accepted receipts, capacity, debt, consent, terms, card,
policy and original month before committing its unique dispatch marker. Only
that winner sends one off-session card PaymentIntent request. Dispatched unknown
outcomes, expired remote idempotency windows, SCA and processor failures block
new charging; recovery reads the exact original through GET only. Already-paid
credit remains usable without reauthorizing a new card charge. Capture, release,
sweeps, metering folds and replay of accepted admission never initiate funding.

Verified successful funding atomically records one purchased lot, ledger/grant
proof, terminal and paid exposure through the existing store. Expiry starts at
its first durable funding instant and is preserved on replay. Original refunds
share the old/new source projection; native refund observations are monotonic,
fenced with their receipt, and cannot be discarded by grant/refund replay.
Refund debt or an unresolved fence blocks new billable admission. An immutable
past terminal is not rewritten by a newer observation.

## Holds and accounting invariants

Reuse the existing hold state machine and ledger. Every accepted hold has an
immutable TTL: currently default 24 hours, validated range 60 seconds to seven
days. Capture is at most the hold, in micros, with release of the remainder
in the same atomic batch. Exact replay returns the original receipt; conflicts
return 409. Unknown release persists the existing cancellation tombstone.
At `now >= expiresAt`, the hold releases; restarted sweeps and receipt access
cannot reopen it. Held lot allocations remain pinned across lot expiry and
paid-Free transitions; releasing expired credit does not make it spendable.

Refund, capture, release and expiry serialize against original source lots.
Keep unused revocation, used-credit receivable and expired-credit revocation
separate. Receivables/fences block new billable work; no unrelated credits or
saved-card charge silently clear debt. Retain immutable terminal/history rows.

## Stripe delivery and reconciliation

Reuse [subscriptions/refunds](subscriptions-refunds.md), `stripe-events`,
`stripe-billing` and their store/client; no second invoice-credit writer.
Listen for existing Checkout events, `invoice.paid`, `invoice.payment_failed`,
`customer.subscription.created/updated/deleted`, and existing refund events.
Verify the exact raw signature before parsing/trusting object claims. Re-fetch
objects using the pinned Stripe API version and the isolated TEST client.
The processor realm is the authenticated Stripe account identity,
`livemode: false` and the deployment's billing authority. Persist a single
immutable realm binding for a billing database before processing unqualified
0095 object/source IDs. Startup refuses an existing database whose account or
mode binding disagrees; key rotation in the same verified account is permitted.
If a database must support multiple realms, first migrate every existing
custody/grant/command/event source to reviewed realm-qualified provenance;
changing a secret alone cannot reinterpret old receipts.
Refuse live mode, connected accounts, wrong customer/purpose/currency, unknown
historical revision and ambiguous/prorated/multiple-line grants.

Deduplicate both event IDs and authoritative invoice/Checkout/refund identities.
Distinct event deliveries for one object cannot duplicate money. Grant, lot,
ledger and period/source proof commit atomically. Stale subscription deliveries
cannot replace verified paid coverage or undo refunds. Authenticate delivery and
persist durable deferred work before acknowledging an unresolved effect;
transient failures retain retryable state. Bounded reconciliation must survive
restart, scan all streams fairly and expose unresolved/truncated work.
A webhook ACK alone is not evidence of a grant or complete reconciliation.

Stripe's [webhook guidance](https://docs.stripe.com/webhooks) requires raw-body
verification and handling duplicate/unordered delivery. Its
[idempotency contract](https://docs.stripe.com/api/idempotent_requests) permits
pruning after at least 24 hours. [Subscription schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules)
provide future-phase changes. Removing a schedule uses
[release](https://docs.stripe.com/api/subscription_schedules/release), whereas
[cancelling a schedule](https://docs.stripe.com/api/subscription_schedules/cancel)
cancels its subscription. [Test clocks](https://docs.stripe.com/billing/testing/test-clocks)
cover recurring-period simulation. These provider constraints explain the
local durable receipts, reconciliation and proposed scheduling tests; the
application's period/grant decisions remain this product's contract.

## Pricing revision publication and Container hook

Retain one shared USD-micros source and the existing versioned authoring/compiler.
Publication validates canonical bytes/digest, unique stable plan IDs, USD,
nonnegative rational rate numerators and positive denominators (zero-priced
egress remains valid), grant/expiry/TTL rules, actual TEST Price currency,
monthly recurrence, configured cash and account binding. An inactive preview
may contain unresolved IDs; an active subscription revision may not.

Persist immutable revision bytes and effective time through the existing
tariff registration boundary. Reject changed bytes for an existing ID,
ambiguous effective times and backdating. Pin revision/rate on grant, hold,
usage, subscription command, invoice and refund basis. Delayed usage selects
its historical period-start revision and splits measurements across rate
boundaries. New revisions never reprice existing holds or paid periods.

The reviewed Container source includes CPU, memory, image storage and egress
rates described in [shared Hosted pricing](shared-hosted-pricing.md). The owner
selected a USD0.025/GB Cloudflare NA/EU egress cost basis; the new source revision
charges USD0.075/GB at three times that basis. Retain the preceding immutable
revision and its original rates for past grants, holds, usage and invoices.
Source registration does not activate a tariff or qualify measurement. Any
future supplied revision must still declare effective time, units, exact rational
overage basis, customer rate and compatibility impact. Missing measurement or
revision input remains unsupported pricing and never becomes zero-price usage.

Use the owning repository's publication entrypoint with an exact reviewed
candidate and private target. Read back the active revision and actual public
subscription table from both product integrations. A preview, synthetic Price
ID or docs merge is not activation. This proposal adds no secret/config writer
and changes no Container implementation.

## Schema, errors and implementation sequence

All existing migration bytes and the micros epoch remain immutable. 0096-0098
are reserved for #342. Verify the next free number after 0098 before adding
personal mappings, command receipts, Workspace attribution/snapshots, limit
exposure/consent or notification outbox. Add compatibility columns/tables;
never reconstruct historical money, wipe balances or modify the separately
owned 0093/0094 cutover or #350. Shared staging data is protected unless its
exact owner explicitly establishes disposal authority.

Use the existing error envelope/status taxonomy. 400 is invalid shape/range,
401/403 authentication/authority, 402 insufficient eligible prepaid credit,
409 conflicting replay/pending command/expired snapshot,
and 503 unavailable schema/revision/maintenance or transient processor failure.
Unavailable policy modes use `503 billing_unavailable`. Extension refusals
use the registered owning error taxonomy; native adapter reason strings do
not become unregistered public error codes.
Money refusals do not encourage automatic retries with a new reference.

1. Review the current implementation and preserve the genuine subscription
   custody/table contract while coordinating #343.
2. Coordinate protected OpenAPI/classification files before public changes.
   Extend existing modules and use separate focused tests; do not modify
   unrelated Container/actor/workerd/WfP/deployment implementations.
3. Add independently reviewed forward schema and command/admission/attribution
   behavior; verify legacy/self-host compatibility and protected-data proof.
4. Run the complete local owner gate on the final committed head. Record full
   SHA/results/log digest in each PR; QA's exact-head Approve precedes merge.
5. Publish only isolated staging code/config/schema through owning surfaces,
   with required schema/authority review and authoritative readback.
6. Exercise actual Stripe TEST objects and both product consumers before
   claiming the 2026-10-25 milestone. Production is outside this task.

Before money writes, source changes can be reverted independently. After money
writes preserve receipts/proofs and repair forward; never serve an older
artifact that ignores revoked credit, re-enable a predecessor wallet writer,
or delete history to make a rollback appear safe.

## Acceptance and unresolved dependencies

| Area | Required evidence |
| --- | --- |
| Wire/auth | Existing shapes/scopes, #343 three/four rows, foreign Org/Workspace refusal, payment scope separation, no personal principal injection |
| Personal Org | Concurrent and lost-ACK creation returns one Org/membership/mapping; no duplicate free grant; ambiguous existing mapping refuses |
| Subscription | Real TEST start and paid invoice, next-period tier change, renewal failure, schedule release followed by cancellation, unsupported cancellation reversal refusal and duplicate/unordered event replay; no proration/double grant |
| Top-up | Same-ref URL/readback, changed-ref payload conflict, lost remote ACK, key-age refusal, paid face-value funding and late settlement policy |
| Accounting | 1-micro debit, overflow/unit protection, many Workspaces/one allowance, one invoice ceiling, no repeat prepaid invoice charge |
| Holds/refunds | Exact TTL boundary/restart, capture bound/remainder, tombstone, concurrency, source expiry and held/used/expired partial/full refunds |
| Workspace summary | Explicit attribution, historical bucket, late periods, snapshot totals across pages/concurrent settlement, expired snapshot refusal |
| Limits/warnings | Default stop, consented prepaid, rejected unavailable on-demand/postpaid, durable 80/95 warning uniqueness and separately qualified delivery |
| Price publication | Immutable/historical rates, TEST Price readback, effective-time segmentation, missing Container hook fails closed |
| Staging consumers | Scoped server HTTP from both products, source/revision readback, real-user free journey without card, no second retail writer |

Blocking inputs remain coordinated changes to the protected contract paths,
QA exact-head approval, qualified staging schema, TEST Price/webhook/client
bindings and actual product integration evidence. Container activation awaits
its owner-supplied measurement/attribution closure; the supplied four tariff
rows are now in the source revision. Postpaid activation and on-demand consent/cap/quantum
configuration require explicit owner qualification; unsupported modes stay
unavailable. Warning transport and staging snapshot readback remain unqualified.
These dependencies are not implied by a passing local source gate.

Further owning references: [micros ledger/cutover](org-billing-micros.md),
[unified billing](unified-billing.md), [shared USD pricing](shared-hosted-pricing.md)
and [pricing authoring](pricing-authoring.md).
