# Canonical D1 acknowledgement validation

`createD1Sql(binding, {acknowledgement: "explicit-d1-result"})` selects a raw
result validation policy in trusted source code. The constructor captures the
literal once. An unsupported policy throws before preparing any statement.
The default constructor retains its existing normalization and `Sql` /
`SqlWrite` stay unchanged.

The selected policy requires each raw statement result to contain its own
`success: true`, an explicit dense array of row objects and a metadata object
with its own nonnegative safe-integer `changes`. Every raw batch member must
exist and validate, and the batch array must have exactly the prepared count
captured before submission, even if a caller's mutable alias changes later.
Missing, null, malformed, sparse or truncated acknowledgements are
`SqlError("unavailable")`. Explicit null is unknown even when it could be a
legitimate acknowledgement on another D1 statement/profile. It is never a
confirmed zero-row RETURNING outcome. SELECT rows and changes are independent;
this generic driver does not infer SQL classes or require equal row/counts.

The validation happens after one `.all()` / `.batch()` call. A write or entire
batch may already have committed when validation fails. The driver performs
no resend, reload, follow-up count query, rollback claim or new operation-key
allocation. Consumers retain their original custody and reconcile through
their owning protocol. Existing thrown constraint/outage classification is
preserved. The SQLite and D1 HTTP adapters are unchanged.

The policy applies to every statement on the selected canonical Sql, including
DDL, reads, non-RETURNING DML and Money permit INSERT/DELETE batch members. The
owner must select it at the actual original D1 constructor before the single
Money wrapper and all Realm/Auth/RP/Financial construction. The same final Sql
and original callables must reach those owners. A generic Sql plus a flag, a
matching database name or a separately constructed RP adapter cannot prove this
construction. No entry or RP mount is implemented by this driver unit.

This is not a primary, schema, identity, class, payer or Financial capability.
RP's bounded known-zero reload/re-touch requires its separate owner-approved
strict-connected observer and full original-row/currentness guards. Ordinary
RP behavior and the default driver remain compatible; legacy normalized zero
must never select the new retry behavior.

The focused unit tests inject malformed external packets and verify call counts
and legacy behavior. The native test file uses isolated local Miniflare D1 with
fresh first-primary sessions. It records actual raw return objects for DDL,
SELECT, RETURNING 0/1, plain DML, mixed batches and the real public Money wrapper's
permit classes on a synthetic minimal schema. It also damages only the returned
ACK after a real native commit, then independently reads the original effect
and verifies one transport call. These are local runtime/driver tests, not
production D1 or RP/Financial integration evidence. They do not register or
apply any financial/Auth migration.

Cloudflare describes `all()` / `run()` as equivalent and documents success,
metadata and results. The general return contract also permits null results;
this selected policy deliberately refuses that ambiguity without changing the
default. If a native canonical statement produces legitimate null, activation
must stop for the owning lossless-ABI decision rather than fabricate zero.
See the official [prepared-statement methods](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
and [return-object contract](https://developers.cloudflare.com/d1/worker-api/return-object/).
