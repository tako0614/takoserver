# Hosted subscriptions and refunds in Stripe test mode

This is the implementation guide for the monthly invoice and refund handlers
specified in [unified-billing.md](unified-billing.md). It builds on #330's Organization wallet with integer USD micros and free →
subscription → purchased class priority. Stripe cash and the authored price
configuration stay in cents; verified cash and configured grant amounts convert
exactly once by multiplying by 10,000 before entering wallet accounting. Public
wallet money is expressed as canonical decimal strings in `*Micros` fields.

## Configuration and activation

The [pricing authoring compiler](pricing-authoring.md) emits
`TAKOSERVER_HOSTED_PRICING` alongside `TAKOSERVER_BILLING_CONFIG` and Checkout
bounds. To enable it on the owned deployment, set the optional non-secret
`hostedPricing` string in the private `takoserver.deploy-target@v2` descriptor
to the exact JSON text emitted for `TAKOSERVER_HOSTED_PRICING`. Target loading
validates that bounded text against `billingConfig`, requires `stripeCheckout:
true`, and checks the authored minimum and maximum against `stripeSettings`
(including the runtime defaults when those settings are absent). Worker
realization passes the same string through as `TAKOSERVER_HOSTED_PRICING`; it
does not add another secret requirement. Omitting `hostedPricing` preserves the
existing behavior.

The hosted input is an operator-authored table. Version 1 has one paid plan;
version 2 binds Free, both finalized paid plans, and usage to the shared USD
source. Monthly Stripe Price IDs and expected prices, included allowances,
and usage tariffs are required in activated configuration. Both products receive the table
from `GET /v1/organizations/{organizationId}/payments/subscription`.

Hosted pricing is optional. Its presence requires a matching billing config,
a Stripe **test** key, and the complete additive **0095** schema after #330's
0093 classification proofs and 0094 micros cutover. Staging schema qualification and
application are owned by operator session `04360c33`.
Live keys, live objects and connected-account events are refused. No default
commercial price is selected. Source migrations and generated SQLite schema
ship here; D1 qualification/application and deployment remain separate work.
The feature does not activate on a self-host instance without hosted config.

`POST /payments/subscription` requires `payments:write` or an owner session and
accepts `{reference, planKey}`. It starts Checkout with a Host-bound customer
and frozen plan revision; it never grants credit. One outstanding Checkout is
allowed per Organization. Reuse the reference after a lost response. After
23 hours an unknown processor acknowledgement requires operator reconciliation
because Stripe may expire its idempotency key after 24 hours. An authoritative
expired Checkout or a completed, canceled subscription permits a new reference.

`PATCH /payments/subscription` accepts `{reference, cancelAtPeriodEnd}` with the
same write authority. It schedules/withdraws end-of-period cancellation without
proration. The version 2 table has USD 10 and USD 50 subscription tiers. A plan/price
rollout is explicit configuration and processor work, never a caller-supplied
amount. Checkout selects the requested plan ID; invoices select their pinned
plan ID and grant only its immutable allowance. `GET` requires `wallet:read` and reports status and verified paid-through
coverage; an `active` status alone does not enable paid features.
Coverage is derived from committed grants and refunds on every read; a delayed
subscription projection cannot restore a fully refunded period. Refund debt
also disables paid features until an explicit operator resolution.

## Processor settlement

The existing signed webhook endpoint handles subscription, paid/failed invoice,
Checkout and refund events. Amounts and identities are re-fetched from Stripe
using the pinned API version, not trusted from the delivery body. A single
monthly, non-proration subscription line grants its configured included credit
once per invoice and subscription period, with that line's original expiry.
The invoice's metadata pins the table revision. Late payments retain the
original expiry. Failed payments grant nothing; cancellation retains existing
credits until expiry/refund. Fully refunded periods no longer supply paid-through
coverage. No public key scope authorizes refunding or directly granting money.

Grant proofs, lots and funding entries commit atomically. Purchased top-ups
record exact Checkout/Charge provenance.
New top-ups resolve the historical billing revision at Checkout creation, so
delayed settlement cannot replace their original expiry with today's tariff.
Its duration begins at first verified settlement, and the grant proof freezes
that expiry for retries; asynchronous payment cannot expire before funding.
An old `direct` lot can acquire a verified source proof only when its Stripe
reference, amount, ledger funding and
unlimited expiry match exactly; original entries and lot fields remain intact.

Refund processing freezes identified original lots before remote refund scans.
It enumerates all refund pages and records successful Refund IDs independently
of event IDs. Existing refund receipt order is preserved when an older pending
refund succeeds later. For subscription consideration `P`, included credit `L`
and cumulative successful refunds `R`, all normalized to integer USD micros,
the cumulative target is
`min(L, floor(L * R / P))`; a full refund revokes exactly `L`.
The multiplication/division uses exact integer arithmetic before taking that
micro-level floor; no intermediate cent rounding occurs. Only the new delta is
applied to that original lot. Affected holds close with
`closureReason: refund`; late capture cannot spend their released allocations.
Unused unexpired credit becomes a refund debit, used credit becomes a
non-spendable receivable, and expired unused credit is recorded without debt.
No unrelated credit pays a refund and no wallet becomes negative.

The wallet exposes `frozenMicros` and `refundReceivableMicros`; lot reads expose
revocation and freeze state. Receivable blocks new billable admission. Its
repayment/write-off requires a separate explicit, auditable operator workflow;
this implementation does not seize credits or initiate another card charge.
These fields are the owning wallet's notice to Hosted/owner clients.

Ambiguous tax/overage/multiple-source charge allocation, complimentary zero-cash
invoices without an explicit entitlement, unsupported annual/proration/multi-line
invoices, or mismatched identities remain deferred for operator repair. An
identified lot remains frozen while refund observations disagree or fail.
Pending/requires-action refunds retain that freeze until terminal processor
status. They do not revoke credit before a successful refund.
The handler does not guess a cash-to-credit allocation.

## Reconciliation and rollout

Every reconcile pass advances at most 100 objects per stream for invoices,
subscriptions, refunds and acknowledged historical events. Durable cursors
continue older pages across passes and restart after a completed sweep. A
separate durable queue retries up to 100 failed objects per pass with fair
rotation. Safe object IDs and machine reasons identify operator repair, while
one failed object does not hold later pages behind it. A
handler-version receipt marks historical events only after settlement. Past
Stripe's event retention window, the stored authenticated object identity is
re-fetched with the deployment's test key and revalidated against account/mode,
customer binding, purpose and pinned tariff. Unavailable or ambiguous original
objects remain unresolved. Logs/report expose
unresolved/truncated counts, which prevent declaring reconciliation complete.
Unresolved counts persist across pages and clear only after a complete clean
sweep. A failed stream is retried without preventing attempts on the other
streams. Deterministic source conflicts remain deferred for operator repair.
Object-level receipts survive event-row loss and repeated scans. Transient
processor failures retain retryable delivery state and lot fences.

**STAGING PENDING (0092 → #330 0093/0094 → 0095, schema owner 04360c33).** This change has no
production/staging deployment, D1 application, configuration or credential
mutation. Local fixtures and the local D1 migration gate verify source only.
After merged #330 and infra qualifies/applies the schema, a staging run must exercise recurring paid
periods, failed renewal, cancellation, duplicate/refund ordering and used/held
credit revocation with real Stripe test objects before launch validation is done.

Rollback before money writes is a source revert with hosted pricing disabled.
After money writes, retain all additive receipts and projections and use forward
repair. Reverting to an older wallet projection that ignores refund accounting
would reopen revoked credit; that is not a valid serving rollback. Never reset
wallets or delete payment history to undo this feature.
