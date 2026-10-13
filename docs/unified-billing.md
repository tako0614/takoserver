# Unified Organization billing for Takoserver and Takosumi Hosted

Status: design decisions for implementation review, 2026-10-13. This document
does not publish endpoints, apply migrations, enable billing, or qualify a live
deployment. All money is **USD**; wallet amounts and Stripe charges use integer
USD cents (`amountMinor`).

Related work: [Takosumi Hosted PR #54](https://github.com/tako0614/takosumi-hosted/pull/54)
(reviewed head `ed44946e15037a74dfd532e9dada28616a8cda69`) and Takoserver's
[`feature/takoserver-stripe-reconcile`](https://github.com/tako0614/takoserver/tree/feature/takoserver-stripe-reconcile)
(reviewed implementation `04e96d2ebcdc46ba06d4625e54947625afa90234`). PR #54
has no review or discussion comments at the time of this design; its body lists
the open questions addressed below. The implementation baseline here is public
main `ae18b47b`, not a claim that either billing candidate has shipped.

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
to their originating lots. Existing `direct` credits retain their recorded
meaning. New automatic grants use the following policy:

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

Consume unexpired lots in ascending `expires_at`, with no-expiry lots last;
tie-break by `created_at`, then `ref`. This is the existing allocation order.
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
For an original hold `H`, accept only safe integer `0 <= C <= H`. Capture spends
`C` and releases `H - C` in that transaction, leaving no partial open hold.
Zero actual cost closes the hold as a full release; it does not require a
zero-value ledger capture row. At a terminal settlement,
`capturedMinor + releasedMinor = heldMinor`.

Reject a direct request with `C > H` as HTTP 409 `capture_exceeds_hold`, without
writing or expanding the hold. Reject a missing hold as 404 `hold_not_found`;
a released/expired hold as 409 `hold_closed`. A byte-equivalent semantic replay
returns the original receipt; a different amount, pricing version, or actual
measurement is 409 `reference_conflict`. Concurrent capture, release, and
expiry have one transaction winner. Reads before a write do not supply its fence.

Hosted retains PR #54's `min(actualMinor, heldMinor)` behavior. It durably records
the full actual amount and `uncollectedMinor = max(0, actualMinor - heldMinor)`
under the same opaque Run reference. Default policy absorbs that shortfall;
it cannot silently debit another lot, create a second Run charge, or turn the
wallet negative. An explicitly opted-in, capped postpaid policy may collect the
shortfall separately as described below. The request fingerprint includes the
uncapped actual measurement so two over-limit actual amounts are not mistaken
for the same settlement merely because both cap at `H`.

PR #54's claim that the current ledger has no capture/release guards is stale
against this baseline: `planHoldSettlement` checks remaining held funds and lot
allocation conservation. Missing pieces are the public hold state/receipt,
atomic capture-plus-remainder operation, closed-hold replay refusal, TTL, and
business error codes. Do not replace those existing guards with adapter-only
checks, or implement the atomic operation as two independent ledger calls.

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

### (c) Round once at the monetary boundary

`1 USD = 1,000,000 micros = 100 cents`; **1 cent = 10,000 micros**. Rates and
quantities are evaluated with integer/rational arithmetic, using `BigInt`
intermediates where multiplication might overflow. No binary floating point
or display string is a money input. Validate all wire cents as safe integers.

At the Hosted Seam B adapter, for estimate `E` in micros and configured headroom
`B` in basis points, compute the final hold directly:

```text
H = ceil(E * (10,000 + B) / (10,000 * 10,000)) cents
```

Do not round the estimate to cents and then round headroom again. The existing
PR #54 cents-only entrypoint may retain its cents calculation for already-priced
inputs; its new micros adapter must pass the computed final hold without adding
headroom a second time. A truly zero-cost operation needs no positive hold.

For actual cost, sum all priced samples for one Run, or one Workspace/meter
closed storage period, in micros; convert that total **once** to cents using
round-to-nearest, ties-to-even. Examples: 4,999 micros → 0 cents; 5,000 → 0;
5,001 → 1; 15,000 → 2; 25,000 → 2. Do not round each token, byte sample, or
provider subcall. The resulting integer cents are then capped by `H`.

Persist the exact micros, pricing version, rounding policy, and resulting cents
with the immutable billing receipt. Differences smaller than a cent belong to
that rounding decision and are not carried to another Run/period or retroactively
collected. Rounded-zero storage records still retain measurements and an
idempotency receipt, with no positive ledger debit. Stripe receives the frozen
cents without another conversion. Refunds of purchased credit use Stripe cents
directly; proportional entitlement revocation uses the cumulative rule below.

### (d) Publish an Organization-scoped wallet API

The following is the decided **future** OpenAPI surface. Existing routes retain
their implementation until corresponding code, schemas, SDK/CLI, and generated
[`openapi/takoserver.openapi.json`](../openapi/takoserver.openapi.json) ship
together. This documentation-only change does not add fictitious OpenAPI paths.

All paths below begin `/v1/organizations/{organizationId}`. Hold references are
URL-encoded as one path component, with bounded length and namespace validation.

| Method and suffix | Required Organization API-key scope | Contract |
| --- | --- | --- |
| `GET /wallet` | `wallet:read` (existing) | Current balance and recent ledger entries |
| `GET /wallet/lots` | `wallet:read` | Cursor-paged credits, expiry, remaining and held amounts |
| `POST /wallet/holds` | `wallet:write` (new) | `reference`, final `amountMinor`, pricing/measurement fingerprint; returns deadline and receipt |
| `GET /wallet/holds/{reference}` | `wallet:read` | Exact receipt independent of the wallet's last-100-entry window |
| `POST /wallet/holds/{reference}/capture` | `wallet:write` | Bounded capture and atomic remainder release; includes full actual/fingerprint |
| `POST /wallet/holds/{reference}/release` | `wallet:write` | Full release or cancellation tombstone |
| `POST /wallet/usage-records` | `usage:write` (new) | Closed-period metering facts, price version, expected cents; idempotent receipt |
| `GET /wallet/usage-records` | `usage:read` (existing) | Cursor-paged settled, unpaid, or shortfall records |
| `POST /wallet/checkout` | `payments:write` (new); owner session also allowed | Start a purchased-credit Checkout |
| `GET /payments/subscription` | `wallet:read` | Current plan and paid-through projection |
| `POST /payments/subscription` | `payments:write`; owner session also allowed | Start subscription Checkout with a configured plan key |
| `PATCH /payments/subscription` | `payments:write`; owner session also allowed | Schedule plan change or cancellation; no direct credit |

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

Extend the existing candidate's `STRIPE_EVENT_HANDLERS`, not a second webhook.
That candidate already verifies the raw signature, records `stripe_events` with
`event_id` as primary key, and credits one-time Checkout through the common
settlement function and `stripe:<sessionId>` ledger reference. It currently
records `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`,
`customer.subscription.deleted`, and `charge.refunded` as **deferred** and
returns 2xx without applying them. `received` is retryable; `credited`, `ignored`,
`deferred`, and `unsupported` are terminal. Do not claim those terminal deferred
events will automatically retry when a handler is added.

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
The single-Stripe-account-and-mode per deployment restriction from the candidate
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
period bounds, tariff version, and expected `amountMinor`; Takoserver recomputes
and rejects disagreement. `takosumi.storage.byte-hours` means the integral of
stored bytes over hours, measured from byte-milliseconds with exact rational
conversion before pricing. It is not a point-in-time bucket size multiplied by
a guessed period. Default storage periods are aligned UTC hours, identified by
`takosumi:storage:<workspaceRef>:<periodStartISO>`. Run references are opaque,
globally unique aliases in `takosumi:run:<runRef>`; use the literal Run id only
if it already satisfies that opaque boundary.

Prepaid is the default. Refuse a Run before execution when its hold cannot be
funded. Storage already consumed must retain an immutable usage record even
when prepaid settlement fails; mark it `unpaid` and suspend further billable
growth/admission without deleting stored data. Do not lose the meter, silently
write a negative wallet, or automatically send an invoice. After top-up, retry
settlement against the same record/reference exactly once. PR #54 currently
returns insufficient funds without retaining a wallet usage record; its
production adapter needs this durable measurement/unpaid path.

Postpaid overage is optional and disabled by default. The Organization owner
explicitly enables it with a USD cents cap per subscription billing period and
an effective consent revision. Reserve against that cap atomically before
admitting estimated uncovered work; include pending usage, Run shortfalls, and
invoice items in the cap. Require a billable Stripe customer and tariff snapshot.
At the cap, refuse further billable admission/growth. Unknown settlement and
unknown invoice-item acknowledgement retain their cap reservation.

For admitted measured overage, close the period and create an explicit standalone
**draft invoice** for that customer and period, then add positive **after-use
invoice items** bound to that invoice and the covered usage references. Pin
invoice creation and each item with Stripe idempotency keys and durable
outbox/readback receipts. Aggregate items by meter and tariff revision; split
deterministically into numbered draft invoices before Stripe's 250-item limit.
Finalize/collect only after every intended item is confirmed by readback. Never
add an item to a finalized/paid invoice or a subscription's implicit next invoice.
If a draft was finalized prematurely, reconcile its existing items and use a
separate numbered draft for only the uncovered remainder; do not bill confirmed
items again. An unknown invoice/item outcome blocks finalization pending readback.
The same cents
cannot be both a prepaid debit and a postpaid item. `invoice.paid` settles that
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

For purchased credit, refunded cents revoke the same number of original credit
cents. For subscription included credit, pin original credit amount `L` and
refundable service consideration `P` at grant. For cumulative successfully
refunded service cents `R`, the revocation target is `floor(L * R / P)`, capped
at `L`; full refund revokes exactly `L`. Apply only the delta from the prior
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
ordinary positive funding operation. The same migration must cover hold
closure/tombstones and adjustment-aware conservation where needed.

## Configuration and cutover

Prices are replaceable configuration, not source constants. Define a validated,
versioned JSON billing policy supplied through the proposed
`TAKOSERVER_BILLING_CONFIG` env value; Bun self-host may instead select an
operator-private JSON path using `TAKOSERVER_BILLING_CONFIG_PATH`. Accept exactly
one source. Private deploy composition supplies the same canonical JSON to
Workers. Include `currency: USD`, revision/effective time, plan keys, free and
included cents, meter units/rational rates, Stripe price-id mappings,
purchased-lot expiry, TTL, and consent/cap policy. These names are proposed
configuration, not currently parsed variables.

Validate unique mappings, nonnegative safe amounts, TTL bounds, month periods,
and Stripe price currency/recurrence before activation. Secrets stay in existing
secret bindings, never JSON or this repo. Actual commercial prices, Supply
Contracts, provider accounts, and realized targets remain operator-private.
Keep the candidate's existing Checkout limits and webhook/reconcile settings
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

## Task ledger and implementation order

Ledger key: `unified-billing-design-20261013`; status: design review. Current
changed repository: **takoserver**, documentation only. This design records
billing/authority decisions but changes no schema, live balance, credential,
price, or runtime behavior. PR #54 and the separate Stripe implementation
worktree are read-only inputs. No numbered cross-repository task is claimed;
the unregistered TASK-0100 handoff is implementation planning input only.

| Order | Owner repository | Deliverable / acceptance |
| --- | --- | --- |
| 1 | takoserver | This reviewed design, local `bun run check`, PR publication/merge; staging publication only through an identified owner target |
| 2 | takos-control | Register implementation ledger, amend wallet ownership policy, regenerate instructions; no shared identity grant |
| 3 | takoserver | Review/land the generic Stripe router; add forward schema, lot/refund conservation, atomic holds/TTL/tombstones, tariffs, and published OpenAPI/SDK/CLI contract tests |
| 4 | takosumi-hosted | Adapt PR #54 fake/port to the decided receipts, micros conversion, unpaid usage, real scoped HTTP client, durable local mapping, and reconciliation; retain draft isolation until wire exists |
| 5 | takosumi / takosumi-hosted | Bridge OSS Seam B through authenticated server RPC, discard `billingSubjectId`, use measured actual cost rather than OSS's current estimate-as-capture, wire cancellation/deadline checks; keep Run authority in OSS |
| 6 | takoserver-private / takosumi-hosted | Compose private tariffs/Stripe settings, snapshot and rehearse single-writer wallet cutover; staging test-mode journeys before any production decision |

Minimum implementation proof includes `C > H` with no writes; zero capture;
concurrent terminal writes; expiry at the exact boundary and after restart;
release-before-delayed-hold; exact versus conflicting replays; lot expiry while
held; many Workspaces sharing one allowance; half-cent ties/overflow and zero
usage; partial/full/pending refunds against available, held, expired, and used
credit; subscription/Checkout double-funding prevention; old deferred-event
replay; foreign Organization/missing scope; capped overage lost ACK and unpaid
storage recovery. These are acceptance requirements, not tests added by this PR.
