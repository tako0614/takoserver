# Authorize metered usage before settlement

Takoserver exposes stable customer Meters rather than upstream invoice vocabulary.
Compute is priced by requests and CPU milliseconds; databases by operations and
capacity-time; object storage by capacity-time and operation classes; queues by
64 KiB operations; and AI by input and output tokens. Provider-specific counters
remain an operator concern and are normalized before they reach a Price Plan.

Takoserver uses a prepaid Wallet. A synchronous request reserves its bounded maximum,
captures the measured amount, and releases the remainder. An asynchronous Resource
uses a bounded Usage Allowance for one Usage Window and cannot open the next window
without sufficient funds. Usage events are append-only and idempotent. A settlement
attempt must never overdraw a Wallet, discard measured usage, or double-charge after
a retry.

The first rollout makes usage rollups recoverable and refuses unfunded debits. Until
the persisted Usage Allowance lifecycle and resource suspension transition ship,
production Price Plans must not remove their existing admission charge in favor of
unbounded asynchronous usage-only billing.
