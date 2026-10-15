# Hosted subscriptions and refunds

This is the implementation guide for the monthly invoice and refund handlers
specified in [unified-billing.md](unified-billing.md). It builds on #330's Organization wallet with integer USD micros and free →
subscription → purchased priority among eligible credit classes. The canonical
Hosted lane admits purchased credit only with explicit prepaid consent. Stripe cash and the authored price
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
a Stripe key matching the explicit deployment-wide `test` or `live` mode,
and the complete additive **0095–0098** source schema after the separately
qualified 0093 classification proofs and 0094 micros cutover. The immutable
[Stripe realm pin](stripe-mode-realm.md) must agree with the key and native
objects; connected-account events are refused. No default commercial price
is selected. D1 qualification/application and deployment remain separate work.
The feature does not activate on a self-host instance without hosted config.

Select the canonical TEST lane on either entry with
`TAKOSERVER_HOSTED_BILLING=canonical-test`; see the exact
[entry requirements](hosted-billing-api-spec.md#canonical-entry-selection).
This explicit selection does not additionally require the Worker's legacy
Checkout/webhook flags. Unselected entries retain their existing flag behavior.

The canonical Hosted extension additionally requires the additive **0099**
schema and an immutable database binding to the selected Stripe account, TEST
mode and billing authority. Its startup checks are read-only. An existing
database with financial history cannot be treated as a fresh database or
automatically rebound to the current key. The qualified composition uses one
authenticated Stripe client for account and configured Price verification,
customer custody, Checkout, subscriptions and settlement. Configured Prices
must be active, TEST-mode, USD and monthly, with the exact configured cash
amounts. Permission to read the global Stripe balance is not required.
This extension currently supports TEST payments; source configuration and
local fixtures do not establish staging activation or launch readiness.

`POST /payments/subscription` requires `payments:write` or an owner session and
accepts `{reference, planKey}`. It starts Checkout with a Host-bound customer
and frozen plan revision; it never grants credit. One outstanding Checkout is
allowed per Organization. Reuse the reference after a lost response. After
23 hours an unknown processor acknowledgement requires operator reconciliation
because Stripe may expire its idempotency key after 24 hours. An authoritative
expired Checkout or a completed, canceled subscription permits a new reference.

`PATCH /payments/subscription` accepts
`{reference, cancelAtPeriodEnd: true, expectedSubscriptionRef}` with the same
write authority. The opaque expected target comes from `GET`; a changed target
is refused before any processor effect. Cancellation is scheduled for Stripe's
verified period end without proration. The version 2 table has USD 10 and USD 50 subscription tiers. A plan/price
rollout is explicit configuration and processor work, never a caller-supplied
amount. Checkout selects the requested plan ID; invoices select their pinned
plan ID and grant only its immutable allowance. The $10 and $50 prices carry
$20 and $100 monthly included credit respectively; Free credit does not stack
during paid coverage. `GET` requires `wallet:read` and reports status and verified paid-through
coverage; an `active` status alone does not enable paid features.
Coverage is derived from committed grants and refunds on every read; a delayed
subscription projection cannot restore a fully refunded period. Refund debt
also disables paid features until an explicit operator resolution.

In the canonical extension, `PATCH /payments/subscription` also accepts
`{reference, planKey, expectedSubscriptionRef}`. This is a separate alternative
to cancellation; a request cannot contain both actions. A plan change starts
at the verified next period boundary without proration. A `202` response
contains a pending `planChange` receipt; a `200` response contains a verified
receipt and its `pendingChange`. Reuse the same reference and expected target
while the outcome is unknown. A verified schedule is not paid coverage and
does not grant credit. Before cancellation of a scheduled change, the adapter
verifies release of that schedule and then uses the original subscription
custody command. Historical invoices retain their original phase and period
terms after a later plan change.

## Canonical Hosted API extensions

Paths below are under `/v1/organizations/{organizationId}` except personal
Organization creation. The [OpenAPI artifact](../openapi/takoserver.openapi.json)
owns the exact request and response schemas.

| Operation | Request and result | Authority |
| --- | --- | --- |
| `POST /v1/organizations/personal` | Empty JSON object; `201` for the first atomic Organization/member/mapping, `200` for its replay | Local human session |
| `GET /wallet/usage-summary` | Organization-wide current usage and 80%/95% warning flags | `wallet:read` or owner session |
| `GET /wallet/usage-summary/workspaces` | Frozen paginated breakdown, Organization totals and an unattributed bucket | `wallet:read` or owner session |
| `GET /wallet/limit-policy` | Current policy and available modes | `wallet:read` or owner session |
| `PATCH /wallet/limit-policy` | `{reference,onLimit}` for stop/prepaid; idempotent consent change | `payments:write` or owner session |
| `POST /wallet/checkout` | `{reference,amountMinor}`; `201` with `{checkout:{url}}` | `payments:write` or owner session |
| `GET /wallet/checkout/{reference}` | `{reference,state,checkout}`; state is pending/ready/paid/expired and Checkout may be null | `wallet:read` or owner session |

In the qualified composition, `GET /payments/subscription` includes
`billingCapabilities` with `contractVersion: "hosted-billing-v1"` and booleans
for `topUps`, `subscriptionStart`, `subscriptionCancellation` and
`subscriptionPlanChange`. Consumers enable a command only when the matching
version and capability are present. Legacy responses omit this marker; a
missing marker, unavailable response or false capability cannot enable a
payment. This projection describes configured financial ports, without
claiming launch or staging acceptance.

New top-up amounts are USD cents, checked against the minimum and maximum in the
usage row of the existing subscription plan table. Exact replays keep the
accepted command amount even after those bounds change. They grant face value only
after verified payment. The durable command freezes Organization, reference,
amount, customer, financial realm, tariff, expiry policy and return URLs before
dispatch. Reusing a reference with different terms is a conflict. A lost
acknowledgement remains pending while authoritative readback is unavailable;
neither a missing HTTP response nor a `404` authorizes another reference.
An unknown command older than 23 hours requires reconciliation without another
Checkout POST. A known ready Checkout does not prevent a separate purchase.

Default `onLimit: stop` admits only eligible included credit. Explicit `prepaid`
consent allows purchased credit after included credit. The contract retains
`postpaid` and `on-demand`, but their capabilities are false and changes to
those modes fail as unavailable. There is no automatic card charge or implicit
credit line. New holds and pending usage retain their original admission
policy; changing consent does not reinterpret earlier usage. Existing funded
holds and completed receipts retain their original allocations.

Workspace references are opaque financial attribution aliases bound to one
Organization. They do not establish Control membership or payment authority.
New Hosted hold/usage commands require an alias; completed replays preserve
their original witness. Holds retain their original billing period and usage
capture inherits that attribution. Pagination reads one frozen snapshot,
expires after ten minutes and returns at most 100 Workspace rows per page.
Organization totals include unattributed historical usage and remain identical
across every page of that snapshot.

Personal Organization creation neither creates a card/customer nor grants a
paid allowance. Ambiguous historical ownership fails as unavailable rather
than adopting an arbitrary existing Organization. The local provider session
path is separate from the shared Accounts/Control enrollment integration;
common directory membership alone does not authorize financial commands.
Warning flags and durable threshold receipts are implemented. Actual warning
delivery requires a separately composed transport.

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
Canonical top-ups resolve the immutable command frozen before Checkout
dispatch, so a later tariff or customer change cannot replace the original
purchase terms. Legacy settlements require their original verified provenance.
The frozen purchase duration begins at first verified settlement, and the grant proof freezes
that expiry for retries; asynchronous payment cannot expire before funding.
Checkout return, webhook delivery and reconciliation all use the same grant
writer, so their races cannot credit the same purchase more than once.
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
re-fetched with the deployment's mode-matched key and revalidated against account/mode,
customer binding, purpose and pinned tariff. Unavailable or ambiguous original
objects remain unresolved. Logs/report expose
unresolved/truncated counts, which prevent declaring reconciliation complete.
Unresolved counts persist across pages and clear only after a complete clean
sweep. A failed stream is retried without preventing attempts on the other
streams. Deterministic source conflicts remain deferred for operator repair.
Object-level receipts survive event-row loss and repeated scans. Transient
processor failures retain retryable delivery state and lot fences.

**STAGING PENDING (0092 → qualified 0093/0094 → qualified 0095–0099 and financial realm).** This change has no
production/staging deployment, D1 application, configuration or credential
mutation. Local fixtures and the local D1 migration gate verify source only.
After the reviewed source is merged and the schema owner qualifies/applies the
preserving suffix, a staging run must exercise recurring paid periods, failed
renewal, plan change/cancellation, customer creation, top-up recovery,
duplicate/refund ordering, shared-Organization usage and used/held credit
revocation with real Stripe TEST objects before launch validation is done.
Stripe Test Clock advancement does not advance the application's wall clock;
future processor invoices alone do not prove an application monthly reset.

Rollback before money writes is a source revert with hosted pricing disabled.
After money writes, retain all additive receipts and projections and use forward
repair. Reverting to an older wallet projection that ignores refund accounting
would reopen revoked credit; that is not a valid serving rollback. Never reset
wallets or delete payment history to undo this feature.
