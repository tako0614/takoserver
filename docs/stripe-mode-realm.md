# Stripe financial mode and durable realm

Status: source implementation only. No Stripe account, Price, credential, D1 target,
or production deployment is activated by this document or by migration 0098.

`TAKOSERVER_STRIPE_MODE` is an operator-only deployment value: exactly `test` or
`live`. Absence means `test`. It is never inferred from `STRIPE_SECRET_KEY`.
The selected mode must match an `sk_` or `rk_` key of that mode, all native Stripe
objects and authenticated events, and the immutable single-mode row in
`stripe_mode_realm`. The public Organization billing API has no mode selector.
The native Price and pricing revision remain the configured immutable identity;
this change does not author live Price IDs or payment amounts.

Migration 0098 adds only the realm row and immutability triggers. Bun validates
the selected mode before creating a data root or opening SQLite. On a fresh or
never-billed self-host SQLite predecessor, its sole migration writer checks
history, applies pending forward migrations, and claims the selected mode under
one `BEGIN IMMEDIATE` transaction; a refused or failed upgrade records none of
those changes. Same-mode restart is read-only and
idempotent; a mode switch is refused. An unpinned database with any older
wallet, money, Stripe event, billing, or custody rows is ambiguous: startup
preserves those rows and refuses to assign them a realm. It does not classify
legacy references by prefix, payment key, or a partial table scan. TEST
history is never promoted into LIVE.

The D1 Worker is read-only at this boundary. Normal serving requires a
pre-existing qualified 0098 schema and pin; it cannot claim a realm or extend
the frozen 0092 fresh payload. Applying 0098 and pinning any protected D1
requires a separate owning, independently reviewed transition with protected
history and old-writer quiescence. An empty-table observation alone cannot
prove that an old binary or one-off writer has stopped. The row only fences
new source; it does not constrain old binaries. A failed or ambiguous cutover
is repaired forward, without resetting balances, replacing references, or
rewriting old migration SQL.
Normal Worker publication checks the selected target D1's exact pin and
immutability triggers before signing/build/upload and again before upload;
`--status` cannot call a missing or mismatched pin ready. Those reads are not
an old-writer drain qualification.

The Worker checks the realm before normal app composition even when payment
credentials or hosted pricing are absent. This is a deliberate wallet-wide
startup dependency: the USD-micro ledger and Organization wallet continue to
exist without the optional payment surface, and an unqualified D1 cannot
serve those financial reads or writes.

Mode validation precedes Stripe event deduplication, so a validly signed
event from the other mode cannot occupy a global event ID. Checkout, invoice,
subscription, customer, Price, charge, and Event readbacks must match the
selected mode. Stripe Refund payloads may omit `livemode`; the associated
charge and original grant are checked instead. Refund accounting still
revokes only the originating lot and never credits a Checkout as a paid
subscription invoice. Unknown Checkout/cancellation outcomes retain their
GET-only recovery and one-POST custody rules.

Evidence in this source change is local SQLite, fake-provider, migration,
and focused type/test checks. It does not establish real Stripe TEST/LIVE,
operator qualification, production schema apply, deploy, or billing GA.
