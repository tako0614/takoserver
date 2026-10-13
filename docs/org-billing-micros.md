# Organization billing: USD-micros implementation and cutover

Ledger key: `org-billing-micros-20261014`; status: source implementation and
local validation. The CTO instruction of 2026-10-14 03:34 JST is authoritative.
This is the separate API/ledger implementation required by the revision of
[unified billing](unified-billing.md), replacing the cents implementation in
[#318](https://github.com/tako0614/takoserver/pull/318).
Source review, schema qualification, and publication are separate acceptance
steps. This document does not establish staging deployment or billing GA.

| Sequence | Repository / owner | Work and acceptance |
| --- | --- | --- |
| 1 | takoserver | Revised design in #323; separate micros API/ledger PR, OpenAPI, migration and regression tests, independent review and complete local gate |
| 2 | takoserver / takoserver-private | #322 qualifies only the frozen 0088→0092 wave; adopt its exact reviewed source in private composition without extending that proof to 0093/0094 |
| 3 | takoserver-private / operator | Separately qualify 0093 classification preparation, protected original money/provenance snapshots and reviewed dispositions, then the stopped-writer 0094 unit cutover and matching artifact |
| 4 | terminal 4d7bccc3 / infrastructure | Recreate disposable staging D1 with canonical SQL comments, apply the qualified schema and deploy/test through the owning entrypoint; this session does not perform these mutations |
| 5 | takoserver / takosumi-hosted | Subscription invoice grants, subscription projection, refunds, capped postpaid, server-only scoped Hosted client and single-writer wallet cutover remain separate GA implementation waves |

No task number is reserved here. No production D1, production configuration,
live tariff, credential, or provider state is changed by this source work.
The price authoring, compiler, preview, example and tests owned by #319 are
unchanged. Its schema-1 allowance and commercial payment amounts remain cents;
the grant boundary converts them exactly to micros with checked multiplication.

## Public and internal money

The Organization wallet, lots, allocations, holds and usage debits use integer
USD micros. Public money fields are canonical decimal strings, including
`amountMicros`, `settledMicros`, `heldMicros` and `availableMicros`. Supported
internal values are bounded to JavaScript safe integers; a large measured
actual can remain exact evidence and is clipped to the hold before conversion
to that bounded internal amount. There is no cents rounding at capture or
usage settlement. `captureMicros = min(actualMicros, originalHoldMicros)`.

Whole priced measurements use exact BigInt ratios and quantize once to an
integer micro when closing the measurement. Data-plane metering retains each
request's exact rational price and quantizes the complete bounded fold once;
it does not round each request or each price line. Future invoice settlement will
sum payable micros and ceiling to cents once. The ceiling helper is arithmetic,
not an implemented Stripe invoice collector. Legacy `usage_events.amount_micros`
from migration 0018 represents **microcents**; it is retained with an explicit
`microcent-v1` unit, never silently reinterpreted as USD micros.

Allocation and pagination use free allowance, then subscription credit, then
purchased credit, with expiry and stable ties within a class. Kind and class
are separate: free and subscription grants are both `plan-included`. Postpaid
is not a wallet lot and remains disabled until its separately consented cap
reservation and invoice settlement are implemented.

A meter fold claims the exact selected pending rows and records its lot
allocation/debit in one atomic SQL batch. A partial concurrent claim or failed
allocation rolls the entire batch back. A lost acknowledgement leaves one
committed fold, so a later scan cannot create a second debit. Zero-priced folds
still carry the same exact-row and unused-reference guards.

The existing eight Organization wallet/usage routes retain their exact read
and write scopes, authentication-before-lookup, cancellation tombstones,
immutable tariff references, required hold TTL, expiry sweep and transactional
capture-plus-remainder-release fences. The public OpenAPI exposes the new
micros fields. Old cents request fields are refused; references cannot be
reused to reinterpret historical money. Enabled billing requires the durable
micros schema marker before tariff registration or any billing write.

AI commercial model prices remain cents per million tokens; one completion's
exact aggregate becomes USD micros once. New model terms and receipts expose
`usd-micros-v2`. Completed legacy AI receipts replay read-only after exact
Organization and request fingerprint checks, even if the original model is
retired. Legacy pending/staged receipts cannot enter the new writer epoch.
Stripe Checkout amounts, immutable reseller quotes and settlement receipts
retain their original cents contracts; checked adapters convert at ledger calls.

## Two forward migrations and the publication boundary

[0093](../migrations/0093_wallet_credit_classification_proofs.sql) creates only
the classification evidence table. It does not convert money or authorize
publication. After its separate qualification, the owner records reviewed
provenance/disposition for legacy `direct` and `plan-included` credits. A
reference prefix alone is not evidence of its class.

[0094](../migrations/0094_wallet_usd_micros.sql) requires stopped money writers,
protected preimages, exact classification evidence and independent review.
It refuses live/stranded holds, pending usage or settlement, unresolved Stripe
events and legacy AI work; checks predecessor conservation and safe row and
aggregate bounds; retains exact immutable preimages; converts cents to micros
by multiplication by 10,000; and freezes historical receipt fingerprints,
source kinds and legacy usage units. Claimed legacy meter groups must match
the original epoch's actual usage debit and allocations. A missing or
mismatched debit is an operator reconciliation requirement, not permission to
recharge or rewrite history. The conversion is one transaction.

Automatic Bun startup refuses any pre-cutover billing history **before its
first write**, repeating the check under the write lock. This includes a
prepared 0093 database with valid classification proofs. There is no bypass
flag. Fresh local databases and never-billed predecessors can initialize the
new schema; that path is not live migration qualification. A converted restart
does not take a write transaction. Self-host wallets are independent operator
wallets and are not enrolled in the shared Hosted plans or grants.

The deploy source inventory includes 0093/0094 so their bytes can be audited.
Existing applied boundaries and their fixed payloads remain unchanged. Normal
Worker publication and startup require the micros schema even without an
opted-in billing configuration: the existing wallet route also uses that schema.
The frozen pre-0094 bootstrap payloads therefore cannot publish this new normal
artifact. Explicit quiesced maintenance modes return before application assembly
and run no application maintenance work; they remain separate non-serving paths.
There is no enabled qualified 0093/0094 live wave in this PR. An existing cents target
must not receive the micros artifact before a separately reviewed matching
schema/cutover publication procedure. Monetary schema conversion is not
reversible by publishing the old cents binary; retain the protected preimage
and a reviewed forward repair plan. Never reset balances or fabricate an
unqualified schema checkpoint to make startup succeed.

## Validation and remaining GA work

Regression coverage includes class priority, safe amount bounds, sub-cent
capture, original-reference replay, TTL/expiry and concurrent terminal
operations, schema readiness, legacy receipt replay, migration preimage and
conservation checks, startup refusal and unchanged legacy money units.
Focused and complete gate results, exact commit/tree and log digest belong in
the implementation PR body. Local ephemeral SQL and loopback HTTP checks do
not count as staging, Stripe TEST-mode or real Hosted cutover tests.

`invoice.paid`, subscription state and `charge.refunded` must leave the generic
event router's deferred state only after their domain projection, provenance,
refund allocation/debt and idempotency are implemented and verified. Price
configuration exists; no production price or account is invented. Staging
Stripe tests require an existing TEST-mode `STRIPE_SECRET_KEY`, its matching
`STRIPE_WEBHOOK_SECRET`, reviewed price ids and scoped Organization test keys.
