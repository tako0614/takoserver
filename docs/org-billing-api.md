# Organization billing API implementation

This file records the cents implementation merged in #318. The CTO revision
in [unified billing](unified-billing.md) supersedes its cents, ties-to-even and
global expiry-order decisions with a micros ledger, one invoice ceiling and
free/subscription/purchased priority. Those changes require the separate
API/ledger implementation PR and forward migration described there; this
documentation revision does not change the current runtime.

Ledger key: `org-billing-api-20261014`; status: implementation and local review.
This is the first implementation wave of [unified billing](unified-billing.md),
after [#313](https://github.com/tako0614/takoserver/pull/313) and
[#314](https://github.com/tako0614/takoserver/pull/314). It changes public
Takoserver billing, authorization, and persisted schema. A separate private
source-pin PR consumes #313/#314; no Hosted, control policy, credentials, live
price, or production D1 changes are part of this wave.

| Sequence | Repository | Work and acceptance |
| --- | --- | --- |
| 1 | takoserver | Additive 0092 lifecycle, immutable tariffs, scoped HTTP/OpenAPI, race/expiry/rounding tests, independent review, complete local gate, PR merge |
| 2 | takoserver-private | Adopt reviewed public source pin and exact audited source inventory; preserve live 0088/0089 lineage; gate/review/PR independently |
| 3 | takoserver / takoserver-private | Review and qualify an additive schema publication wave, pin the final public commit in complete-profile composition, publish to integration through the owning entrypoint, verify real scoped HTTP |
| 4 | takoserver | Subscription projection/invoice grants, refund allocation/debt and reconciliation, payment scopes and Stripe test-mode journeys remain GA-required next implementation waves |
| 5 | takosumi-hosted / takos-control | Scoped server HTTP client and immutable Workspace mapping; separately reviewed single-writer cutover and generated ownership policy |

No task number is reserved by this file. The `/tmp` TASK-0100 proposal remains
unregistered. The repository gate and independent review results belong in the
PR body with the exact tested commit/tree and log digest. This ledger grants no
production mutation authority.

## Wire contract

The [OpenAPI document](../openapi/takoserver.openapi.json) is generated from
[the route table](../src/route-table.ts) and [operation schemas](../src/openapi.ts).
The prefix is `/v1/organizations/{organizationId}`. Authentication and the exact
Organization/scope check precede lookup and body parsing. A write scope grants
neither read access nor funding, owner administration, or another write scope.

| Method and suffix | Required scope | Result |
| --- | --- | --- |
| `GET /wallet` | `wallet:read` | Current USD wallet; lazily expires public holds when billing is enabled |
| `GET /wallet/lots` | `wallet:read` | Cursor-paged lots in expiry consumption order with separate spent/remaining/held/available amounts |
| `POST /wallet/holds` | `wallet:write` | Durable admission receipt; final integer `amountMinor`, original tariff revision and measurement fingerprint |
| `GET /wallet/holds/{reference}` | `wallet:read` | Original amount, deadline and terminal receipt |
| `POST /wallet/holds/{reference}/capture` | `wallet:write` | Final cents, full `actualMicros` and immutable measurement fingerprint; capture and remainder release commit together |
| `POST /wallet/holds/{reference}/release` | `wallet:write` | Empty request body; terminal receipt or durable cancellation tombstone |
| `POST /wallet/usage-records` | `usage:write` | Closed measurement and its pinned price; `pending` if available prepaid credit cannot pay |
| `GET /wallet/usage-records` | `usage:read` | Stable descending cursor pages, at most 100 receipts per page |

References use one path component, 1–128 ASCII letters/digits and `._:-`, starting
with a letter/digit. A reference never becomes reusable after settlement.
All required request fields and only those fields are accepted. Hold creation
and usage submission return 201, including exact replay; terminal hold operations
return 200. Lookup never grants access through possession of a reference. Usage listing
returns `usageRecords` and a nullable opaque `cursor`; pass `limit` and `cursor`
on the next GET to traverse older receipts without duplicating equal timestamps.
Lot listing likewise returns `lots` and `cursor`, in expiry consumption order,
with `limit` from 1 to 100. Continuations are Organization-bound, retain tied
expiry/timestamp rows, and accept pre-existing opaque funding references. A
missing or replaced cursor position is refused with 400 instead of silently
skipping credit. Allocations are aggregated for only the bounded page of lots.
Migration 0092 assigns stable random handles to existing and future lots. These
handles expose neither internal row counters nor Organization identifiers;
pagination itself never updates them.

A capture must equal `min(round(actualMicros), originalHoldMinor)`. Rounded
actual above the hold is retained in the fingerprint and receipt without a
second debit or negative wallet. `capture > hold` is a 409 with no capture or
release write on a live hold. Zero capture closes as `released` and writes no
zero capture entry; its exact capture replay still returns the original receipt.
A release racing capture returns whichever terminal receipt committed. A changed
capture fingerprint returns 409 even if capped cents match the original request.

No admission row is created for insufficient funds (402), so the exact hold may
be retried after topup. An unknown release creates a zero cancellation tombstone,
preventing a delayed hold from being admitted. A hold with the same reference
and different amount, revision, or measurement fingerprint returns 409.

## Deadlines and ledger conservation

Migration [0092](../migrations/0092_org_wallet_lifecycle.sql) adds hold/usage
lifecycle and tariff snapshot tables without rewriting prior wallet history.
The existing 0017 lots and allocations stay authoritative. Internal ledger
references use separate `org-hold:` and `org-usage:` prefixes. Hold state, ledger
entries, and exact lot allocations commit in one guarded SQL batch. A lost
acknowledgement requires original-reference readback/replay, never a new reference.
Billing refusals use the shared error envelope and declared Host code/status pairs.
They keep `retryable: false`: callers inspect receipts and retry the exact original
request when appropriate, rather than automatically generating another debit.

The server assigns an immutable deadline from the accepted tariff, defaulting
to 24 hours; the validated range is 60 seconds to seven days. At `now >= expiresAt`
the hold releases, even without cron. There is no renewal endpoint. Expiring
credit remains pinned while held; closing its hold does not make expired credit
spendable again. Captures consume earlier-expiring lots first.

The normal application maintenance tick sweeps at most 64 expired holds. Closed
rows are the durable progress marker; a restarted sweep selects the next live
row from the expiry index. A request sweeps at most eight of its Organization's
expired holds. If a backlog remains it returns `billing_maintenance_pending`
(503), preserving committed cleanup and refusing new admission until catch-up.
It does not spend unlimited request time draining a long maintenance outage.
The sweep and its backlog check read one request instant, so a deadline that
passes later in the same request is not backlog. That hold is still never
captured or reported live: capture and release fence on the deadline inside
their SQL batch and close it as `expired`, and a read or exact replay closes it
first.

An unpaid, already-consumed usage record persists as `pending` without ledger
entries or an implicit invoice. It blocks additional billable hold admission;
its exact retry after topup pays at the pinned original rate once. Existing data
is not deleted. A zero-priced usage record closes as paid without a debit.

## Tariff configuration and exact units

The Bun and Worker entries parse `TAKOSERVER_BILLING_CONFIG`. The owner deploy
target supplies the same validated object as `billingConfig`; realized config
serializes it into that variable. Missing configuration disables the new API.
Malformed configuration fails startup. Prices remain operator configuration;
this repository contains no production tariff or Stripe price identifier.

The JSON shape has `schemaVersion: 1`, `revision`, canonical UTC `effectiveAt`,
`currency: "USD"`, optional `holdTtlSeconds`, `freeIncludedMinor`,
`purchaseCreditExpiry`, `plans`, `meters`, and optional `history`. Each plan has
`includedMinor` and a unique Stripe `stripePriceId`. Each meter has `unit` and
exact rational `rate: { numeratorMicros, denominator }`; a meter Stripe price id
is optional. Numerators/denominators are positive canonical integer strings.
Purchase expiry is `{ kind: "none" }` or `{ kind: "fixed-duration", seconds }`.
The parser rejects unknown/duplicate JSON keys, conflicting revision times,
duplicate Stripe prices within a revision, non-USD currency and unsafe cents.

`history` contains full prior revision objects without nested history. Startup
persists each tariff immutably, and retains retired revisions in SQL. Reusing a
revision with changed bytes or an already-used effective timestamp fails closed.
The initial reviewed bootstrap can import history atomically. Subsequent new
revisions must activate at or after registration time; backdating is refused so
already-consumed periods cannot be repriced. Schedule future price edits before
their activation and retain all previously registered snapshots.
A new hold uses the active admission tariff; its replay uses its original
snapshot. A delayed usage measurement selects the tariff effective at its
period start. A period spanning another tariff boundary is rejected and must be
measured in separate closed segments, rather than repriced using today's tariff.

The UTC month's tariff is frozen once across Organizations, selected from the
revision effective at the first instant of that month. Each Organization's
eligibility is recorded, including zero allowance. Positive free credits are
`plan-included`, reference `free:<org>:<YYYY-MM>`, with exclusive expiry at the
next UTC month. An initial tariff becoming effective mid-month starts its free
allowance next month; it does not backfill past entitlement. Free grants do not
change when an Organization first visits after a mid-month price edit.

Money arithmetic uses BigInt ratios. `1 cent = 10,000 micros`. Aggregate a whole
Run/closed meter period, then round final cents once using nearest, ties to even:
4999→0, 5000→0, 5001→1, 15000→2, 25000→2. The hold helper rounds up only once,
including basis-point headroom, and rejects unsafe final cents. There is no
fractional balance carried into another period.

For any `byte-hour` meter, including Hosted's `takosumi.storage.byte-hours`,
submit `quantityUnit: "byte-millisecond"` and an **integer integral of byte-milliseconds**.
The server divides by exactly 3,600,000 before applying the rational hourly rate
and rounding final cents. It never converts to a floating or truncated decimal
byte-hour quantity. Meters with other units accept their configured unit and
canonical nonnegative decimal quantity with at most 18 fractional digits and no trailing
fractional zero. Receipts retain original quantity, unit, period, revision,
configured rational rate, cents, and payment status.

## Publication and remaining GA work

An enabled Worker requires the complete 0092 tables at startup and the applied
0092 marker before publication. Auditing 0092 in the source inventory does not
advance the existing operator D1 apply ceiling or fresh 0088/0089 selection.
A target still on 0088 cannot enable this API through a routine worker upload.
A separately reviewed, additive schema wave and the private complete-profile
source/qualification closure are required. Do not bypass a schema/qualification
fence or run raw Wrangler D1 SQL to make a feature appear ready.

The price parser includes plan and Stripe price identities for the next GA waves.
This wave does not activate subscription/refund handlers, create a customer or
Stripe account, or replace Hosted's retail wallet. Invoice grant and refund
allocation/debt implementation, historical event/object reconciliation, real
payment scopes, and optional capped postpaid outbox still require their own
money-conservation tests and live acceptance. They remain mandatory before
billing GA; portable tests for this API do not establish Stripe or Hosted E2E.

Production D1/settings are outside this task. Integration publication must use
the existing owner deploy contract with a reviewed commit, artifact digests,
pre-mutation proof, reversal/forward-repair plan and independent review. If no
qualified source closure, additive schema wave, test-mode Stripe credentials or
scoped real-user credential exists, record the exact missing input and refusal
in the PR and handoff without changing the live target.
