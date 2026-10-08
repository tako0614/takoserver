# Takoform v2 SQLite: external SQL drain before native retirement

Status: internal implementation handoff, **not** a Support or deployment claim. This
design is based on public Takoserver `0f89b209`, the reviewed private SQLite
stream candidate `df8494a9`, Host API v2 `ba0bf1c`, and the released
SQLiteDatabase 0.2.0 / WorkerVersion 0.5.0 Forms at `cfd376b`. It does not
change those contracts.

## One physical database, two existing authorities

Use one operator-selected, durable Node UID store for both the canonical
`createSQLiteDatabaseForm` lifecycle and the SQLite Worker Binding broker.
The current WfP Durable Object SQLite lifecycle and Node UID store are **two
different physical databases**; a DO creation receipt does not authorize or
prove ownership of a Node database. Do not mount both as one Resource. The
Node store's original generation-1 CREATE receipt, exact Resource UID, backend,
target, principal, and Space must match accepted Core state before opening its
file. Its existing UID file lock serializes SQL with physical create/delete.
The operator must supply a persistent single-writer Node store and a private,
authenticated route to it; separate roots or an unqualified second writer do
not satisfy this design.

D1 remains the sole Resource, Operation, sealed-reference, and invocation
authority. The Node service gets **fixed typed D1 proof callbacks**, not a
tenant-accessible or arbitrary-SQL D1 proxy. Core's accepted binding reader
proves the exact WorkerVersion→SQLiteDatabase UID edge and current settled
vector. The Node store checks a D1-derived current management claim for
create/update/delete and the D1-derived original CREATE identity against its
own on-disk receipt. A caller-supplied UID, title, boolean, or HMAC alone is
not that proof. Existing self-host local `Sql` construction may remain; WfP
uses the restricted proof option.

Core already rejects SQLiteDatabase DELETE atomically while a live
WorkerVersion or SQLiteMigrationApplication reference exists. Version native
DELETE rejects unresolved invocations, and the reference is released only
when the referrer's DELETE succeeds. These protect the Resource graph, but
they do **not** prove that a remote Node SQL effect stopped when its RPC
response was lost: the private producer hold is in memory, and provider Tail
can otherwise retire the invocation while Node is still executing SQL.

## Exact custody and lock contract

Add a monotone state to the **existing** `tf_v2_worker_invocations` row, not a
second Resource or SQL-effect ledger. Suggested fields are
`sqlite_drain_state` (`NULL`, `pending`, `drained`) and
`sqlite_drain_receipt_digest` (NULL until `drained`). `NULL` means no external
SQLite send was authorized; it is not evidence about a request already sent.
The following are trusted internal ports, not public Host endpoints:

```ts
armSQLiteExternalUse({ handle, expected }): Promise<boolean>
confirmSQLiteDrained({ handle, expected, receiptDigest }): Promise<boolean>
```

`handle` is the exact invocation ID and custody token. `expected` binds the
immutable admitted principal, Space, target, Worker/Version UID and
generation, selected source Operation, native incarnation, and provider
receipt. `armSQLiteExternalUse` is a D1 statement-time CAS on the exact
`send_authorized`, not-retired, not-`no_native_dispatch` row. It changes
`NULL → pending` **before the first external SQL send**. A same-row pending
readback makes lost CAS acknowledgement idempotent; a foreign/reclaimed row,
terminal row, or unknown CAS result grants no send. Subsequent calls from
that live invocation may reuse pending, but each still needs current binding
and native/graph proof. The grant sent to Node is invocation-scoped and binds
this handle and the selected Version plus database UID; it stays private to
the Host, never tenant environment or SQL parameters.

The Node broker takes a file-backed **invocation lock before the existing UID
lock**. Under both locks it verifies a D1-derived exact invocation still has
`sqlite_drain_state=pending`, `retired_at_ms IS NULL`, and the admitted native
identity; it then rechecks the sealed/current binding vector and original
CREATE ownership. The invocation lock remains held through SQL
commit/rollback and database close, not merely until HTTP headers or body
EOF. Every Node SQL entry and trusted drain path uses the same lock root and
order. An old grant or a delayed request must use a fresh authoritative D1
read *inside* that lock; a cached or lagging replica read cannot establish
that Tail has not already retired the invocation. If that read consistency
cannot be supplied, the SQLite profile remains unmounted. Pre-lock
validation and a post-commit vector check alone do not fence SQL.

The trusted Tail receiver may record the existing positive provider terminal
receipt. While `sqlite_drain_state=pending`, **every** Deployment/Version
retirement and native-delete/outstanding predicate must still count that row
as unresolved even if `retired_at_ms` is set. Native owner cleanup must not
treat provider Tail or an in-memory hold release as Node SQL drain. After Tail,
a trusted drain obtains the same invocation lock, thereby waiting for all
commits/closes or recovered rollback. It rechecks the exact terminal D1 row
and then calls `confirmSQLiteDrained` under the lock. That D1 CAS requires
the same handle/identity and terminal receipt, changes `pending → drained`,
and records an exact trusted Node drain digest. Only an identical digest can
replay success after lost acknowledgement. A timeout, RPC failure, `query`
result, body EOF, or elapsed lease never clears pending. No SQL call is
resent by the Host after an unknown effect; SQLiteDatabase §5 leaves
non-idempotent retry judgment to the application.

The linearization order is deliberate:

1. D1 `arm` wins before external send, or nothing is sent.
2. Node invocation lock → UID lock → D1 live proof → SQLite transaction
   commit/rollback and close. Concurrent calls for one invocation serialize.
3. Provider Tail records terminal. A late Node request now fails its in-lock
   D1 check; one that passed before Tail retains the lock until finished.
4. Drain takes that invocation lock, proves terminal and no executing SQL,
   then confirms D1 drained. Only then may retirement/delete predicates pass.

If the Node process dies, file-lock release alone is not a success receipt:
the restarted sole writer must recover SQLite journal state and establish
that no old process can still execute under another root. Until that check,
drain remains pending. If D1 is unavailable or a drain CAS acknowledgement is
lost, reread the same row; do not infer completion or remint an invocation.
Same-spec SQLiteDatabase PUT keeps the same UID/database. If its accepted
vector changes after an SQL commit, the Worker result may be unknown, but
physical DELETE still waits the UID lock and the live-reference/retirement
closure; a reported error is not proof of rollback.

## Old schema and mount boundary

Only the explicitly selected WfP SQLite profile requires these D1 columns,
triggers, and pending-aware readers at startup. Missing/partial schema, an
unavailable proof port, an unqualified Node root, or a pre-drain binary must
refuse **SQLite binding/Form activation and SQL grants**; column absence is
never interpreted as `NULL`. Unrelated Forms need not be disabled. A rollback
to code that ignores pending must not serve a target with outstanding
SQLite-capable invocations. No existing DO namespace is adopted, migrated, or
silently replaced. Old SQL effects are not replayed during cutover.

## Writer ownership and focused proof

| Owner | Narrow source responsibility |
| --- | --- |
| Public Core custody writer | `src/takoform-v2/worker-invocation-custody.ts`, native-delete/outstanding predicates, next additive migration and exact schema projections/tests: arm/replay/terminal/drain CAS; no change to old migration files or live apply ceilings. |
| Public Node-store writer | `src/providers/selfhost-v2-sqlite-store.ts` and broker plus focused tests: typed fixed D1 claim/original-CREATE/invocation proof option; shared invocation→UID lock order; exact in-lock recheck and close-before-release. Preserve local self-host path. |
| Private WfP composition writer | SQLite stream connection/host, trusted Tail retirement and retirement readback, and the one normal Form/Binding composition: D1 proof adapter, invocation-scoped private grant, arm before send, pending-aware drain, and the **same** Node UID store for Form lifecycle and SQL. Do not use `v2-sqlite-native-backend.ts` DO receipts as Node ownership. |

Red→green checks need: live Version/MigrationApplication reference blocks
Database DELETE; SQL started before Tail finishes before drain; Tail before
delayed SQL refuses the latter; DELETE/Version retirement stays pending after
lost response even when Tail arrived; Node crash/reopen recovers the UID file
before drain; same-invocation parallel SQL serializes; unrelated/foreign UID,
grant, owner receipt, backend/target, stale generation and old schema refuse;
D1 outage before arm sends nothing, and outage after commit leaves an unknown
effect without automatic retry. Real D1 plus the selected durable Node service
and normal WfP mount are separate qualification evidence. A local same-Sql
fixture, a DO-like SQL substitute, or a passing source gate is not that proof.
