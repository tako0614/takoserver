# Unified Organization billing for Takoserver and Takosumi Hosted

Status: revised by the CTO decision supplied directly in the task on
2026-10-14 at 03:34 JST. That instruction is the decision record; there is no
separate decision PR. It supersedes the cents ledger, ties-to-even rounding,
and globally expiry-first consumption decisions in
[#314](https://github.com/tako0614/takoserver/pull/314) and
[#318](https://github.com/tako0614/takoserver/pull/318).
All money is **USD**. The canonical ledger uses integer **USD micros**;
`1 USD = 1,000,000 micros`, and `1 cent = 10,000 micros`. Convert payable
micros to Stripe cents once at invoicing, rounding every positive remainder up.

This document changes the target contract, not runtime money or a live target.
The [first Organization API](org-billing-api.md) in main still uses cents and
expiry-first allocation. A separate API/ledger implementation PR and guarded
forward migration must replace those behaviors before the revised lane is
enabled. The [0092 schema wave PR](https://github.com/tako0614/takoserver/pull/322)
stays separate from the subsequent micros cutover.

Related work: [Takosumi Hosted PR #54](https://github.com/tako0614/takosumi-hosted/pull/54)
(reviewed head `ed44946e15037a74dfd532e9dada28616a8cda69`), merged
[Stripe router/reconciliation #313](https://github.com/tako0614/takoserver/pull/313),
and merged [shared price authoring #319](https://github.com/tako0614/takoserver/pull/319).
The original PR #54 review found no review/discussion comments; its body lists
the four questions decided below. The implementation baseline for this revision
is main `b5f5a038`. Source merge does not establish staging or billing GA.

| Area | CTO target | Main baseline / next implementation |
| --- | --- | --- |
| Ledger and scoped money wire | Integer USD micros; explicit `*Micros` fields | #318 stores/accepts cents; a separate forward migration and API/ledger PR are required |
| Allocation | Free allowance → subscription credit → purchased credit → consented capped postpaid | #318 sorts all lots by expiry; replace allocation, settlement and pagination order together |
| Invoicing | Aggregate payable micros, then ceiling to cents once | Remove #318 capture/usage ties-to-even conversion; invoice settlement is a later Stripe wave |
| Holds and scopes | Immutable TTL, capture ≤ hold, automatic release; exact Organization/scopes | #318 supplies this lifecycle; preserve its transactional fences when changing units |
| Hosted plans | Three shared configurable tiers and one Organization wallet | #319 emits free/subscription/usage plan configuration; subscription/refund handlers and Hosted cutover remain GA-required |

## One wallet authority, separate product identities

Takoserver owns the Organization wallet, credit lots, holds, usage settlement,
subscription credit, Stripe receipts, and refund accounting. Hosted owns its
customer experience, Workspace membership, the local Workspace-to-Organization
map, measurement of its own services, and the server-side wallet client. Many
Workspaces may bill one Organization; each Workspace has one immutable billing
Organization while holds or unpaid usage remain. Changing that binding requires
an explicit, drained migration, not editing a live map entry.

The Organization is a Takoserver-issued billing subject, not a shared user
record. Hosted obtains an Organization owner's explicit delegation and stores
the Organization id with a random opaque `workspaceRef`. It sends only that
Organization id, opaque billing references, quantities, and settlement facts.
Takosumi user/account/session ids and literal Workspace ids stay in Hosted;
provider requests continue to use only their existing opaque tenant references
and provision tokens. There are no source imports or shared databases between
the products. Takosumi OSS continues to own Run/state/output/audit authority;
its default billing extension remains disabled.

The three tiers are shared by Takoserver and Takosumi Hosted, rather than one
subscription per product: free, subscription, and usage, with their stable plan
ids and prices supplied by configuration. This follows the authoring contract
in #319; its output remains owned by that pricing change. A product switch or
additional Workspace does not create another balance, subscription allowance,
or free grant. A usage tier may spend purchased prepaid credit; postpaid still
requires separate explicit consent and a cap. Self-hosted installations are
outside this shared Hosted balance, plan, free-grant and Stripe policy. An
independent self-host operator's own wallet is not enrolled into it.

This is an intentional replacement of the current **two retail wallet**
arrangement, not a description of today's production composition. Hosted's
[`stripe-retail.ts`](https://github.com/tako0614/takosumi-hosted/blob/main/src/stripe-retail.ts)
currently settles its own prepaid wallet separately from its Takoserver wholesale
wallet. The unified lane instead presents the Takoserver wallet and Checkout
through Hosted UX. Retire that lane's Hosted retail Checkout, credit writer,
wallet holds, and retail debits after cutover; keep only read-only historical
receipts. Do not dual-write, mirror balances, or charge the same service through
both wallets. Unrelated reseller contracts retain their distinct contractual
authority until their own migration; they cannot debit this unified purchase
again. A private service binding may transport the same authenticated public
contract, but does not replace per-Organization authorization.

The existing generated ownership statements still assign retail Stripe to
Hosted. Before production wiring, update the owning policy source and regenerate
the affected instructions in a separate governance change. This document does
not hand-edit generated `AGENTS.md` or silently change account ownership.

## Credit lots and expiry

Reuse [migration 0017](../migrations/0017_wallet_credit_lots.sql) and
[the ledger](../src/ledger.ts). `wallet_credit_lots` already distinguishes
`direct`, `plan-included`, and `purchased`; allocation rows bind holds and debits
to their originating lots. Preserve those source kinds and original funding
references while recording an explicit consumption class. Free and subscription
grants are both `plan-included`, but their classes are different. Legacy
`direct` credits require verified provenance/disposition before cutover; do not
guess that they were free, subscribed or purchased. New grants use this policy:

| Source | Kind | Unique reference | Expiry |
| --- | --- | --- | --- |
| Monthly free allowance | `plan-included` | `free:<org>:<YYYY-MM>` | First instant of the next UTC calendar month |
| Paid subscription period | `plan-included` | `stripe:invoice:<invoiceId>` | End of the paid recurring line's service period |
| Additional credit purchase | `purchased` | `stripe:<checkoutSessionId>` | None by default; any configured expiry is disclosed and pinned at purchase |

Grant the configured free amount once to each eligible Organization per UTC
month, including eligible paid Organizations. It is not per Workspace. A monthly
job and lazy admission backfill share that reference and the month's frozen
configuration; neither grants past, already-expired months. A zero allowance
records eligibility without calling the positive-amount funding operation.
Free and paid included amounts are separate explicit entitlements; there is no
implicit free allowance multiplied by Workspace count.

Consume **free allowance first, then subscription grants, then additional
purchased credit**. Only after eligible prepaid credit is exhausted may an
explicitly consented capped postpaid reservation cover the remainder. Postpaid
is a separate receivable/cap reservation, not a spendable credit lot. Within
each prepaid class, use ascending `expires_at`, no-expiry last, then `created_at`
and `ref` for deterministic ties. A purchased lot expiring sooner does not
jump ahead of free or subscription credit. Apply the same priority to new
holds, direct usage debits, partial capture of pinned allocations, and lot
pagination; changing only the displayed sort is insufficient.
Expiry is exclusive: a lot is unavailable at `now >= expires_at`, even when a
scheduled job has not run. No rollover or silent renewal occurs.

A hold made before a lot expires pins its allocation until the **hold's** own
expiry or settlement. Its capture can spend that pinned allocation after lot
expiry. Release returns it only if the lot is still valid; releasing an expired
lot never makes it spendable again. Wallet balances are lot/expiry projections,
not a naive sum of all historical funding entries. Preserve the append-only
money history and the nonnegative available/held conservation checks. Future
refund adjustments must participate in that same projection.

## Decisions closing PR #54

### (a) Capture is bounded by the hold

The public settlement operation validates the existing Organization/reference,
live hold state, request fingerprint, and allocations **inside one transaction**.
For an original hold `H`, accept only integer micros `0 <= C <= H`. Capture spends
`C` and releases `H - C` in that transaction, leaving no partial open hold.
Zero actual cost closes the hold as a full release; it does not require a
zero-value ledger capture row. At a terminal settlement,
`capturedMicros + releasedMicros = heldMicros`.

`H` always means the prepaid wallet hold. A future postpaid admission uses a
distinct reservation `P` against the consented cap, with its own durable receipt;
it does not increase `H` or wallet funds. For measured actual cost `A`, wallet
capture is `min(A, H)`, and separately recognized postpaid usage is at most
`min(max(0, A - H), P)`. Atomically close both reservations, release unused
prepaid/cap reservations, and preserve any remainder as an uncollected shortfall.
Bind their references, deadlines, consent revision and full actual measurement
to the same settlement fingerprint. Postpaid reservation expiry releases its
unused cap reservation and prevents late collection just as prepaid expiry
prevents late capture; neither receipt can reopen on replay. #318 has only the
prepaid lifecycle; this combined postpaid operation is a later GA implementation.

Reject a direct request with `C > H` as HTTP 409 `capture_exceeds_hold`, without
writing or expanding the hold. Reject a missing hold as 404 `hold_not_found`;
a released/expired hold as 409 `hold_closed`. A byte-equivalent semantic replay
returns the original receipt; a different amount, pricing version, or actual
measurement is 409 `reference_conflict`. Concurrent capture, release, and
expiry have one transaction winner. Reads before a write do not supply its fence.

Hosted adapts PR #54's capping behavior to `min(actualMicros, heldMicros)`;
it does not round the actual cost to cents before capture. It durably records
the full actual amount and `uncoveredMicros = max(0, actualMicros - heldMicros)`
under the same opaque Run reference. With a separately accepted reservation P,
record `postpaidMicros = min(uncoveredMicros, P)` and
`uncollectedMicros = uncoveredMicros - postpaidMicros`; default P = 0 leaves
the entire uncovered amount uncollected. Default policy absorbs that shortfall;
it cannot silently debit another lot, create a second Run charge, or turn the
wallet negative. An explicitly opted-in, capped postpaid policy may collect the
shortfall separately as described below. The request fingerprint includes the
uncapped actual measurement so two over-limit actual amounts are not mistaken
for the same settlement merely because both cap at `H`.

PR #54's original claim that the ledger has no capture/release guards is stale:
`planHoldSettlement` checks remaining held funds and allocations, and #318 adds
public receipts, atomic capture-plus-remainder, closed-reference replay refusal,
TTL and business errors. Preserve these guards through the unit migration;
adapter-only checks or two separate capture/release transactions are insufficient.

### (b) Holds expire and late requests cannot reopen them

Use a durable hold lifecycle row keyed by `(org_id, reference)` alongside the
existing ledger and allocations. Store original amount, request fingerprint,
`createdAt`, immutable `expiresAt`, and terminal state/receipt. Default TTL is
24 hours; validated operator configuration may select 60 seconds through
7 days. The server assigns `expiresAt` at first acceptance. Replay returns that
deadline and never extends it. This version has no renewal endpoint.

At `now >= expiresAt`, read and mutation paths transactionally close the hold
and release its entire remaining allocation. A bounded, durable cursor-based
sweeper runs at least every minute and resumes after restart, so abandoned
plans, cancellation, and lost responses do not hold funds forever. API checks
enforce expiry even if the sweeper is delayed. Exact deadline equality belongs
to expiry, and a late capture receives `hold_closed`, never a fresh debit.

`release` of an unknown reference creates a durable cancellation tombstone and
returns a terminal `released` receipt with zero held/captured/released amounts.
It is not a no-op: a delayed hold using that reference is refused. Terminal
references and tombstones are never reusable; retain their fingerprints even
if verbose audit payloads are archived. An insufficient-funds rejection does
not create a hold, so the same request can retry after top-up unless release
has already canceled it. Release of a captured reference returns its unchanged
receipt; it never reverses a completed charge.

Hosted must reread a live receipt before permitting Apply and stop admitting
billable work before its deadline. Long Runs require a suitably configured TTL
and a bounded execution policy; do not infer a Run stopped from wallet expiry.
OSS owns cancellation/effect recovery. If a Run finishes after expiry, preserve
its measured cost as an uncollected shortfall and block further billable work
until reconciliation; never recapture automatically under a new reference.

### (c) Keep micros in the ledger; ceiling to cents once at invoicing

`1 USD = 1,000,000 micros = 100 cents`; **1 cent = 10,000 micros**. Rates and
quantities are evaluated with integer/rational arithmetic, using `BigInt`
intermediates for multiplication, division and aggregation. No binary floating
point or formatted display string is a money input. Canonical public micros
fields are unsigned decimal integer strings, with signed strings for ledger
deltas. The in-process/SQL adapter must validate exact integer range before
conversion to a JavaScript number; values above `Number.MAX_SAFE_INTEGER`
micros fail closed rather than losing precision. Stripe cash and legacy price
authoring/quote amounts remain explicitly labelled cents at their boundaries.

At the Hosted Seam B adapter, for estimate `E` in micros and configured headroom
`B` in basis points, compute the final hold directly:

```text
H = ceil(E * (10,000 + B) / 10,000) USD micros
```

Add headroom once, in micros. Hosted's revised adapter submits that amount
directly; it does not add headroom again or send an old `amountMinor` request.
A truly zero-cost operation needs no positive hold.

For actual cost, sum all priced samples for one Run, or one Workspace/meter
closed storage period, with exact rational pricing. If that aggregate contains
a fraction of one USD micro, quantize upward once to the ledger's integer-micro
quantum at that whole Run/closed-period boundary and retain the exact quantity,
rate, rational result and quantization adjustment. Do not quantize each token,
byte sample or provider subcall. Capture is `min(actualMicros, H)` with no cents
conversion; a 1-micro cost is a 1-micro debit, not a zero or 1-cent debit.

At invoicing, sum all covered payable micros first, then compute
`invoiceCents = ceil(payableMicros / 10,000)` **once** for that invoice. Examples:
0 micros → 0 cents; 1 → 1; 4,999 → 1; 5,000 → 1; 10,000 → 1; 10,001 → 2;
25,000 → 3. Two covered 5,000-micro items total 10,000 micros and invoice 1 cent,
not 2. Round-half-even is abolished. Persist the covered references, original
payable micros, frozen cents and
`invoiceRoundingMicros = invoiceCents * 10,000 - payableMicros`. This adjustment
is cash invoice accounting, not a second wallet debit or another usage record.
Exact replays reuse that receipt and never recompute it under a new tariff.

Stripe purchases and cash refunds already use integer cents. Convert verified
cash funding/revocation to ledger micros by exact multiplication by 10,000;
this is a unit conversion, not a rounding opportunity. Zero-cost usage retains
its measured facts and idempotency receipt without a positive debit.

### (d) Publish an Organization-scoped wallet API

The following is the decided target OpenAPI surface. #318 implements the first
eight wallet/read/hold/usage operations in cents; the separate micros API/ledger
PR must ship the updated wire contract together with generated
[`openapi/takoserver.openapi.json`](../openapi/takoserver.openapi.json).
Checkout/payment scopes and subscription operations below remain
later GA implementation work. This documentation-only revision adds no routes.

All paths below begin `/v1/organizations/{organizationId}`. Hold references are
URL-encoded as one path component, with bounded length and namespace validation.

| Method and suffix | Required Organization API-key scope | Contract |
| --- | --- | --- |
| `GET /wallet` | `wallet:read` (existing) | Current balance and recent ledger entries |
| `GET /wallet/lots` | `wallet:read` | Cursor-paged credits, expiry, remaining and held amounts |
| `POST /wallet/holds` | `wallet:write` | `reference`, final decimal-string `amountMicros`, pricing/measurement fingerprint; returns deadline and receipt |
| `GET /wallet/holds/{reference}` | `wallet:read` | Exact receipt independent of the wallet's last-100-entry window |
| `POST /wallet/holds/{reference}/capture` | `wallet:write` | Bounded capture and atomic remainder release; includes full actual/fingerprint |
| `POST /wallet/holds/{reference}/release` | `wallet:write` | Full release or cancellation tombstone |
| `POST /wallet/usage-records` | `usage:write` | Closed-period metering facts, price version, decimal-string `expectedMicros`; idempotent receipt |
| `GET /wallet/usage-records` | `usage:read` (existing) | Cursor-paged settled, unpaid, or shortfall records |
| `POST /wallet/checkout` | `payments:write` (new); owner session also allowed | Start a purchased-credit Checkout |
| `GET /payments/subscription` | `wallet:read` | Current plan and paid-through projection |
| `POST /payments/subscription` | `payments:write`; owner session also allowed | Start subscription Checkout with a configured plan key |
| `PATCH /payments/subscription` | `payments:write`; owner session also allowed | Schedule plan change or cancellation; no direct credit |

Wallet/lot/hold/usage money and signed entry deltas use explicit `*Micros` fields;
capture supplies `amountMicros` plus full `actualMicros` and its fingerprint.
Old cents request fields are rejected instead of being reinterpreted. Publish
the new schemas and contract tests with the implementation and coordinate the
Hosted client cutover. Historical terminal receipts keep their original money
policy/fingerprint and are read as explicit history; new references cannot
reuse them or silently replace their original cents decision.

Hosted's routine Run/storage key needs only `wallet:read`, `wallet:write`,
`usage:read`, and `usage:write`. Use a separate delegated `payments:write` key
for explicit customer payment actions. Neither write scope implies a read or
other write scope. None authorizes funding, refunds, key minting, reseller
provisioning, or arbitrary postpaid policy changes. Existing owner-only
`POST /wallet/funding` remains a verified-proof path; never expose caller-chosen
credit as a scoped wallet write. The Stripe webhook
`POST /v1/payments/stripe/webhook` is documented separately with signature
authentication, no bearer scope, and bounded raw-body verification.

Organization owners issue expiring, named keys through Takoserver's existing
key-management authority, explicitly delegate them to Hosted, and may revoke
them there. Hosted keeps secrets in its server-side secret store, resolves a key
per Organization inside the client, and rotates by installing a new scoped key,
verifying it, then revoking the predecessor. Browser/OSS extension payloads and
logs never contain the key. Check scope and exact path Organization before
looking up a hold; a wrong-Organization request cannot observe or spend it.

OpenAPI specifies 400 for malformed units/deadlines, 401 for invalid credentials,
403 for wrong Organization/missing scope, 404 `hold_not_found`, 409 for lifecycle
or fingerprint conflicts, 402 `insufficient_funds` for a refused new hold, and
503 for unavailable/indeterminate settlement. An unknown write outcome requires
readback and exact-reference replay, not a new reference. Publish request,
receipt, expiry/tombstone, pagination, replay, and error schemas and contract
tests before Hosted implements HTTP; a private binding obeys the same checks.

## Subscriptions and the generic Stripe router

Extend the merged #313 router's `STRIPE_EVENT_HANDLERS`, not a second webhook.
That router verifies the raw signature, records `stripe_events` with
`event_id` as primary key, and credits one-time Checkout through the common
settlement function and `stripe:<sessionId>` ledger reference. It currently
records `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`,
`customer.subscription.deleted`, and `charge.refunded` as **deferred** and
returns 2xx without applying them. `received` is retryable; `credited` and
`ignored` are terminal. `deferred` and `unsupported` records can be reprocessed
on redelivery when a handler becomes available (#313). Historical objects still
need explicit backfill; installing a handler does not itself cause Stripe redelivery.

Activate each handler by removing its type from the deferred set. Re-fetch the
invoice/subscription/charge and necessary related objects using this deployment's
Stripe key and pinned API version; verify account/mode, Organization/customer
binding, USD, configured price identity, status, and purpose. The webhook body
supplies event/object identity, not monetary authority. Stripe documents both
duplicate delivery and unordered delivery; object settlement uniqueness must
therefore survive a missing event row or two event ids for one object.
[Stripe webhook delivery guidance](https://docs.stripe.com/webhooks#event-ordering).

For `invoice.paid`, grant the configured included-credit entitlement once using
`stripe:invoice:<id>`, expiring at the verified recurring line period end. Use
the invoice's pinned plan/price revision, not current catalog prices or invoice
total (which may include tax, discounts, or overage). Require one recognized
monthly credit-bearing subscription line and a verified paid invoice. A paid
invoice containing only overage grants no new included lot. A zero-dollar
invoice grants only an explicitly configured complimentary entitlement; it
does not impersonate a purchased payment. A late paid invoice retains its
original expiry, even if it has already passed.

For this version, subscriptions are monthly; changes take effect on the next
period boundary and mid-period proration does not mint an extra full allowance.
Unsupported multi-line/annual/proration entitlement shapes are quarantined for
operator resolution. `customer.subscription.updated` and `.deleted` re-fetch
and update plan status, pending plan, cancellation, and paid-through projection;
they never fund a wallet. Scheduled cancellation preserves the paid lot until
its original period end. Immediate cancellation disables paid-plan features;
already-paid credit keeps its expiry unless a confirmed refund revokes it.
`invoice.payment_failed` creates no credit and updates delinquency/notification.
Paid-plan access requires verified payment coverage and appropriate current
subscription status, not just a stale event payload or an `active` string.
[Stripe subscription webhook guidance](https://docs.stripe.com/billing/subscriptions/webhooks).

Do not credit subscription-mode Checkout both as purchased funding and as an
invoice lot. Checkout funding verification accepts only the one-time
wallet-credit purpose. An exact funding/lot fingerprint must match on replay.
The single-Stripe-account-and-mode per deployment restriction from #313
continues to apply.

Rollout requires a bounded, cursor-paged replay job for previously terminal
deferred events plus authoritative invoice/subscription/refund reconciliation.
It re-fetches objects and uses ledger/refund uniqueness, not deletion of
`stripe_events`. Existing Checkout reconciliation is only a limited lookback,
10-page payment pass; it is not subscription/refund coverage. Persist replay
progress and handler-version application receipts, keep transient failures
retryable, and alert on truncation or unresolved deferred objects before calling
the new lane complete.

## Meter pricing and optional capped overage

Takoserver validates a versioned tariff selected for the Organization and meter.
Hosted measures its own services and sends the immutable quantity, closed UTC
period bounds, tariff version, and expected `expectedMicros`; Takoserver recomputes
and rejects disagreement. `takosumi.storage.byte-hours` means the integral of
stored bytes over hours, measured from byte-milliseconds with exact rational
conversion before pricing. It is not a point-in-time bucket size multiplied by
a guessed period. Default storage periods are aligned UTC hours, identified by
`takosumi:storage:<workspaceRef>:<periodStartISO>`. Run references are opaque,
globally unique aliases in `takosumi:run:<runRef>`; use the literal Run id only
if it already satisfies that opaque boundary.

Prepaid is the default. Refuse a Run before execution when its hold cannot be
funded, unless the owner has explicitly enabled postpaid and the separate cap
reservation has already been accepted. Storage already consumed must retain an
immutable usage record even
when prepaid settlement fails; mark it `pending` (unpaid) and suspend further billable
growth/admission without deleting stored data. Do not lose the meter, silently
write a negative wallet, or automatically send an invoice. After top-up, retry
settlement against the same record/reference exactly once. PR #54 currently
returns insufficient funds without retaining a wallet usage record; its
production adapter needs this durable measurement/unpaid path.

Postpaid overage is optional and disabled by default. The Organization owner
explicitly enables it with a USD cents cash cap per subscription billing period
and an effective consent revision. Convert that authored cap exactly to checked
`capMicros`. Reserve against it atomically before admitting estimated uncovered
work. The admission fence requires
`priorInvoicedCents + ceil((uninvoicedConfirmedPayableMicros + pendingReservedMicros + newP) / 10,000) <= consentedCapCents`.
Confirmed/pending micros in this aggregate exclude references already covered
by those prior invoices, so no usage or cash amount is counted twice.
This reserves the aggregate's possible 0–9,999-micro
rounding remainder before work, rather than discovering it at collection.
Confirmed usage replaces its reservation instead of being counted twice;
releasing unused reservations recomputes the same aggregate cap projection.
Final cash invoices together cannot exceed the consented cents cap. Require a
billable Stripe customer and tariff snapshot.
At the cap, refuse further billable admission/growth. Unknown settlement and
unknown invoice-item acknowledgement retain their cap reservation.

For admitted measured overage, close the period and create an explicit standalone
**draft invoice** for that customer and period, then add positive **after-use
invoice items** bound to that invoice and the covered usage references. Pin
invoice creation and each item with Stripe idempotency keys and durable
outbox/readback receipts. Freeze the covered closed-period payable micros and
ceiling-converted cents once. Aggregate items by meter and tariff revision;
allocate the frozen cents total deterministically: floor each group's exact
cents, then distribute remaining cents by descending fractional remainder with
stable meter/revision/reference ties. Zero-cent groups retain their covered
receipts without a positive Stripe item. Split into numbered draft invoices
before Stripe's 250-item limit using the same frozen total and allocations;
never apply another ceiling to each group or shard.
Finalize/collect only after every intended item is confirmed by readback. Never
add an item to a finalized/paid invoice or a subscription's implicit next invoice.
If a draft was finalized prematurely, reconcile its existing items and use a
separate numbered draft for only the uncovered remainder; do not bill confirmed
items again. An unknown invoice/item outcome blocks finalization pending readback.
The same measured micros cannot be both a prepaid debit and a postpaid item.
`invoice.paid` settles that
receivable only and does not fund purchased credit. Collection failure keeps
the receivable and suspends new overage; no blind retry with a new item/key.
Work beyond the consent cap is reported as an operator-absorbed shortfall,
never an unauthorized invoice item. [Stripe invoice-item API](https://docs.stripe.com/api/invoiceitems/create).

## Refunds preserve lot provenance

`charge.refunded` triggers a re-fetch of the Charge and all paginated Refunds;
apply only confirmed successful refunds, keyed by refund id, not the cumulative
charge amount on every event. Resolve the exact Checkout/invoice and original
funded lots using the pinned Stripe API version and settlement receipts. A
single payment can span invoices; never assume a Charge has one legacy
`invoice` field. Keep pending/failed refund state and reconcile it (including
refund status events) instead of treating a pending request as confirmed money
movement. [Stripe refunds](https://docs.stripe.com/refunds) and
[invoice association guidance](https://docs.stripe.com/billing/subscriptions/webhooks#refund-events).

For purchased credit, refunded cash cents revoke exactly that amount multiplied
by 10,000 in original credit micros. For subscription included credit, pin
original credit micros `L` and refundable service cash cents `P` at grant.
For cumulative successfully refunded service cents `R`, the revocation target
is `floor(L * R / P)` micros, capped at `L`; full refund revokes exactly `L`.
This proportional entitlement calculation does not round a new cash charge.
Apply only the delta from the prior
target, with reference `stripe:refund:<refundId>:<lotRef>`. Tax and already-paid
overage refund allocations use their own invoice accounting, not included-lot
revocation. Zero-consideration complimentary lots cannot use division by zero
or a cash refund as revocation authority. Ambiguous allocations stop for
operator resolution without guessing.

Freeze the affected lot against new allocation while resolving the refund.
Serialize refund, capture, expiry, and release. Fence affected live holds,
release their unspent allocations, and close their receipts so they cannot
capture revoked credit later; Hosted reconciles the associated Run independently.
For unused, unexpired credit append a negative `refund_debit` adjustment bound
to the original lot and refund receipt. Do not mutate the original funding row
or revoke another purchased lot merely because it has available funds.

Credit already consumed becomes an explicit, non-spendable `refund_receivable`
for the Organization; credit already expired is recorded as revoked-after-expiry
and is neither spendable credit nor new debt. Thus no wallet balance becomes
negative and no past usage receipt is erased. An externally completed refund
must be recorded even if it creates that receivable. Block new billable
admission while it is unresolved; notify the owner and resolve it through an
explicit agreed repayment or an auditable operator write-off. Do not silently
seize unrelated credit, apply free grants to debt, or charge the saved card.
An operator-initiated refund is normally limited to unspent refundable credit;
an intentional used-credit refund must declare its receivable/write-off policy.

The existing ledger type CHECK and lot projection do not support these records.
They require a forward migration and guarded accounting implementation; never
rewrite migration 0017, reset funded wallets, or approximate refunds using an
ordinary positive funding operation. Integrate refund adjustments with #318's
existing hold closure/tombstones and adjustment-aware conservation where needed;
do not introduce a second competing hold lifecycle.

## Configuration and cutover

Prices are replaceable configuration, not source constants. #318 parses the
validated, versioned `TAKOSERVER_BILLING_CONFIG` JSON environment value; private
deploy composition supplies that same canonical JSON from an operator-private
file. Preserve this existing parser and source contract. Self-host operators
do not join the shared Hosted commercial policy.

Keep #319's schema-version-1 authoring/output and immutable historical policy
bytes compatible: `freeIncludedMinor` and plan `includedMinor` are authored
integer cents. At creation of a grant snapshot, convert those entitlements
exactly to checked USD micros by multiplying by 10,000. Its meter rate
`numeratorMicros` already means USD micros. Retain the original configuration
revision and explicit unit in the snapshot; do not relabel historical cents
values or add another price table. #319 owns configurable plan ids, Stripe
price mappings, and its free/subscription/usage output. This revision leaves
its authoring, compiler, preview, examples, and tests unchanged. Preserve the
existing validated `holdTtlSeconds` and `purchaseCreditExpiry` fields. Future
consent/cap configuration requires its own validated versioned extension rather
than guessed commercial defaults.

Validate unique mappings, nonnegative safe amounts, TTL bounds, month periods,
and Stripe price currency/recurrence before activation. Secrets stay in existing
secret bindings, never JSON or this repo. Actual commercial prices, Supply
Contracts, provider accounts, and realized targets remain operator-private.
Keep #313's existing Checkout limits and webhook/reconcile settings
in `src/payment-settings.ts`; do not invent a parallel parser for those fields.
Current AI and supply tariff configuration retain their own owners and must
join an explicit billing revision rather than a hidden default rate.

Pin the policy revision and relevant price/rate tuple on every grant, hold,
usage record, invoice item, and refund basis. New configuration affects future
admission and future service periods only. Replays, already-paid invoices, and
closed measurements use their original snapshot; Stripe price-id replacement
does not reinterpret old invoices. Validate overlapping effective revisions
and reject ambiguous periods.

Hosted cutover first fences its retail writes and in-flight Checkout/holds,
reconciles late payments, then records a protected snapshot and per-source
transfer/disposition proof. Preserve purchased versus included provenance and
expiry; do not copy an undifferentiated balance. Transfer only verified unused
credit once with an origin receipt, retire the predecessor writer, then enable
the unified Organization lane. Leave historical audit data readable. If old
credits cannot be classified, operator resolution is required rather than a
guessed lot kind. Old Stripe webhook deliveries remain routed to a fenced
reconciliation owner until drained; they cannot mint on both sides.

After unified spending begins, re-enabling the old wallet is not a rollback.
Freeze new admission, reconcile the sole ledger, and repair forward. Snapshot,
pre-mutation proof, independent review, and the owner deploy contract are
required for the future data/authority cutover. A design merge or green portable
check does not establish billing GA. Actual acceptance requires Stripe test-mode
and Hosted integration journeys, including refund, expiry, concurrency, and
lost-acknowledgement readback.

## Forward money-unit and allocation cutover

The micros API/ledger change is a separate implementation PR. Frozen migrations
0003, 0017, 0018, 0091 and 0092 retain their original bytes. Add a forward
migration after the independently reviewed, applied and qualified 0092 baseline;
do not mix that new migration into #322's exact 0001–0092 source inventory or
reuse its 92-row qualification for a different schema. A source implementation
or draft PR does not authorize applying that migration.

Before conversion, quiesce money writers and retain protected schema/source,
row identities, balances, lot allocations and receipt snapshots. Drain or
explicitly resolve open holds, pending usage, AI/reseller settlement intents,
and indeterminate payment outcomes; do not erase them or guess that an external
effect did not occur. Resolve legacy `direct` lot provenance explicitly before
assigning a consumption class. An unresolved prerequisite refuses the cutover.

Convert existing wallet cents by exact checked multiplication by 10,000,
atomically rename the canonical money columns/fields to `*micros`, and persist
a money-policy/unit marker. Check SQLite integer bounds, JavaScript safe-integer
bounds, and aggregate overflow before mutation. Preserve ids, references,
timestamps, source kinds, expiry, fingerprints and original terminal decisions.
Prove converted row and aggregate conservation against the protected preimage;
do not reset balances or represent conversion as new funding/refunds. Record
separate free/subscription consumption classes while keeping `plan-included`
as their source kind.

Stripe cash, #319 price authoring, and commercial quote/reservation receipts
remain explicitly cents at their respective boundaries. Use checked adapters
when those participants fund or consume the micros ledger; update Organization
APIs, Console display, and money participants together. Old terminal receipts
retain their original policy and fingerprint rather than being recomputed as
new micros requests.

Migration 0018's historical `usage_events.amount_micros` is **one millionth of
a cent**, not one millionth of a USD. A new USD micro is 100 of those historical
units. Drain old unrolled measurements and preserve their original unit/epoch;
new USD-micro writers and readers must distinguish it explicitly. Renaming a
TypeScript field or dividing both generations by the same constant is not a
valid migration. Preserve exact quantities and rational pricing evidence when
settling the final old epoch.

Required proof includes a 1-micro debit, checked conversion/range failures,
wallet/lot/allocation conservation, class priority despite earlier purchased
expiry, priority-consistent pagination, TTL/capture/replay/scopes, and generated
OpenAPI contracts, followed by `bun run check`. Live cutover additionally needs
protected pre/post-mutation proof and independent review. An old cents artifact
cannot safely serve a converted schema: freeze admission and repair forward
from the protected snapshot if required. The current task's staging D1 apply,
deploy and tests belong to terminal `4d7bccc3`; this documentation and source
work performs none of those effects and changes no production target.

## Task ledger and implementation order

Ledger key: `unified-billing-cto-revision-20261014`; status: design review. Current
changed repository: **takoserver**, documentation only. This design records
billing/authority decisions but changes no schema, live balance, credential,
price, or runtime behavior. The directly supplied CTO decision is authoritative;
PR #54 and merged #313/#318/#319 are read-only baseline inputs. The required
micros API/ledger corrections are an explicit, separate implementation PR.
No numbered cross-repository task is claimed;
the unregistered TASK-0100 handoff is implementation planning input only.

| Order | Owner repository | Deliverable / acceptance |
| --- | --- | --- |
| 1 | takoserver | This reviewed CTO revision, local `bun run check`, PR publication/merge; documentation publication changes no live money |
| 2 | takos-control | Register implementation ledger, amend wallet ownership policy, regenerate instructions; no shared identity grant |
| 3 | takoserver | Separate canonical-micros API/ledger PR, class-priority allocation, checked cash adapters, forward unit migration after qualified 0092, generated OpenAPI and contract/conservation tests; preserve #318 lifecycle fences |
| 4 | takoserver | GA-required subscription/refund handlers, deferred-event replay/reconciliation, payment scopes and consented capped postpaid; extend merged #313 and configured tariffs without editing #319's price-authoring files |
| 5 | takosumi-hosted | Adapt PR #54 fake/port to micros receipts, unpaid usage, real scoped HTTP client, durable local mapping, and single-writer retail retirement; retain draft isolation until wire exists |
| 6 | takosumi / takosumi-hosted | Bridge OSS Seam B through authenticated server RPC, discard `billingSubjectId`, use measured actual cost rather than OSS's current estimate-as-capture, wire cancellation/deadline checks; keep Run authority in OSS and self-host outside Hosted billing |
| 7 | takoserver-private / takosumi-hosted | Owner consumes reviewed schema/CPE prerequisites, composes private tariffs/Stripe settings, and snapshots/rehearses cutover; terminal `4d7bccc3` owns staging D1 apply/deploy/test, including test-mode journeys |

Minimum implementation proof includes `C > H` with no writes; zero capture;
concurrent terminal writes; expiry at the exact boundary and after restart;
release-before-delayed-hold; exact versus conflicting replays; lot expiry while
held; many Workspaces sharing one allowance; 1-micro spending and combined
fractional-cent items with one invoice ceiling; unit/range/aggregate overflow,
legacy micro-cent separation, free-before-subscription-before-purchased order,
zero usage and self-host exclusion; partial/full/pending refunds against
available, held, expired, and used
credit; subscription/Checkout double-funding prevention; old deferred-event
replay; foreign Organization/missing scope; capped overage lost ACK and unpaid
storage recovery. These are acceptance requirements, not tests added by this PR.
