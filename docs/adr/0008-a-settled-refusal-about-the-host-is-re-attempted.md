# ADR 0008 — A settled refusal about the Host is re-attempted

**Status:** accepted, 2026-09-02

## Decision

A durable operation's stored terminal **failure** is replayed under the same
idempotency key only while the refusal is a statement about the request. A
refusal that describes this Host or its environment is retired when the same key
is presented again with the same fingerprint, and the request is attempted
afresh.

The closed set that is re-attempted is
`REATTEMPTED_SETTLED_FAILURE_CODES` in `src/takoform/operations.ts`:
`backend_unavailable`, `deadline_exceeded`, `dependency_in_use`,
`deletion_protected`, `form_identity_conflict`, `form_not_installed`,
`form_unavailable`, `form_unknown`, `insufficient_funds`, `internal_error`,
`migration_required`, `quota_exceeded`, `rate_limited`, `resource_busy`,
`unavailable`, `unsupported_capability`.

Everything else replays: `invalid_argument`, `artifact_invalid`,
`artifact_missing`, `generation_conflict`, `revision_conflict`, `uid_mismatch`,
`import_conflict`, `policy_denied`, `resource_not_found`, `space_mismatch`,
`offering_mismatch`. A cancelled operation is not a failure code at all and
stays terminal.

## Why the split is what the refusal is *about*

The released Takoform provider derives its `Idempotency-Key` from the plan —
ref, name, space, uid, generation — so the operator who repairs something and
re-runs `tofu apply` presents a byte-identical request under a byte-identical
key. That is exactly right for a success: the same key must not provision twice.
It is exactly wrong for a failure the operator has just cured.

`generation_conflict` says the desired state moved under the caller's fence;
`uid_mismatch` says they named an incarnation that is not there;
`invalid_argument` says the document is wrong. The fingerprint proves the
request has not changed, so the stored answer is still the answer, and replaying
it is the whole point of an idempotency key.

`unsupported_capability` is not like that. It says *this Host* does not do the
thing. Nothing in the configuration is wrong and nothing in it will change; what
changes is the Host. A real self-host run measured the consequence: after a Host
defect that refused every `WorkerEndpoint` was repaired, the same `tofu apply`
returned the identical 422 with no driver entry at all, and the only escapes
were renaming the resource or deleting rows from the Host's database. The same
shape holds for a Form that was not installed yet, a backend that was down, a
wallet that was empty, and a `dependency_in_use` that a teardown then cured.

## Why a retry is a second attempt and never a second mutation

The safety property is held by the store, not by the code list.

An operation whose provider mutation produced a **receipt**, or whose provider
**plan is still live**, is not settled at all: `execute` holds it for provider
repair and the maintenance drain resumes the same operation. So a settled
failure is one of exactly two things:

1. the provider was never invoked — the engine abandoned the planned saga on a
   path where `providerDispatched` is false; or
2. the provider answered definitively enough for the engine to terminalize the
   saga — a precondition failure, whose entire meaning is that the mutation did
   not happen ([ADR 0005's 2026-09-02 amendment](0005-object-storage-is-an-exact-objectbucket-binding.md)
   records the ObjectBucket case).

In both, re-presenting the key starts a second *attempt* at a mutation that did
not occur. This supersedes the narrower rule that only `dependency_in_use` was
re-attempted, which was adopted on the reasoning that a retry after a
precondition failure would be "a second provider call": it is, and that is what
a re-run of a refused apply is supposed to be.

## Non-goals

- This does not weaken replay for a *successful* operation. A committed
  mutation is still replayed under its key, and is retired only when the
  Resource it committed no longer exists.
- This is not a general retry policy. The Host re-attempts nothing on its own;
  it only stops standing in the way of a caller that asks again.
- A cancelled operation stays cancelled. Cancellation is an explicit terminal
  decision, not a refusal about anything.
