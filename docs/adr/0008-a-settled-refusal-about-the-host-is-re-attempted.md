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

The closed set answers every code that means one thing. Two of the codes above
mean two things, and for those the classification is carried by the refusal
rather than by its code — see the 2026-09-02 amendment
[*what the refusal is about is not always its code*](#amendment--2026-09-02-what-the-refusal-is-about-is-not-always-its-code).


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

## Amendment — 2026-09-02: a hold that can never settle is not a hold

The rule above turns on a settled failure, and it says the store rather than the
code list holds the safety property: an operation whose provider mutation
produced a receipt is not settled at all, because the mutation is real and the
exact Host command is the only thing that can reconcile it.

One failure escapes that reasoning. The engine holds every receipt to its Form
before it materializes a Resource — a driver may only report what its Form
declares — and when *that* is what refuses, the receipt is durable and the Form
is frozen. No repair makes the stored answer publishable. The command is held
anyway, it owns the caller's plan-derived replay key while it waits, and every
later apply of the same graph resumes it and reads back the identical refusal.
The fourth self-host run created one and the fifth proved it survives a reboot
into a repaired configuration: that Space could not create its endpoint on a
Host where every other Space succeeded on the first attempt.

**A receipt its Form can never carry settles the command as
`unsupported_capability`.** That is the honest code — this Host cannot record
that answer — and it is in the set above, so the operator who repairs the Host
and re-runs the identical apply gets a fresh attempt rather than the stored
refusal. The executed saga is dropped with the command, because a fresh attempt
on the same target would otherwise adopt it and project the same answer again.
A delete is untouched: its receipt is provider evidence of a removal and is
never projected onto a Form, so asking this of one would abandon a real repair.

**And a refusal that provably mutated nothing leaves nothing behind.** A create
reserves an incarnation before the provider is asked — a deletion attestation
opened `live`, a `planned` effect, and, once the saga is marked, a `dispatched`
one. A refusal after that marker commits no Resource, so the record described an
incarnation that never existed: no deletion could close the attestation and the
effect had no terminal event. The saga already knows the fact that settles it —
a precondition failure deletes the plan, so no recovery will resume it and the
refusal's whole meaning is that the provider did not act — and the apply and
import paths now terminalize their own effect and drop the reserved incarnation
under proof that it produced nothing: no Resource row, no provider deployment
outside `deleted`/`failed`, the attestation still `live`, and every effect on the
uid belonging to that one command with none of them `succeeded`. A refusal that
may have mutated something keeps its record, which is what a repair reads.

## Amendment — 2026-09-02: what the refusal is about is not always its code

The rule above is "request-shaped refusals replay, Host-shaped refusals
re-attempt", and it reads that shape off the wire code. That works only while
one code means one thing. One does not.

`invalid_argument` is the answer to a malformed desired document — weights that
do not sum to 10000, a duplicated binding name, a relation the document does not
declare — and every one of those is a fact about the request that the fingerprint
proves has not changed. It is *also* the answer to a `WorkerEndpoint` whose
ModuleWorker declares no `WorkerDeployment`, to a hostname another
`WorkerCustomDomain` already claims, to a second deployment on one Worker, to a
`claim` or `exclusive` or `uniquePair` constraint somebody else holds, and to a
relation whose target resource is not there yet. None of those is a fact about
the request. Each is a fact about a **neighbour**, and the operator cures it by
adding the deployment, releasing the hostname, deleting the other deployment, or
declaring the missing resource — without one byte of *this* resource's plan
moving. The provider's plan-derived key is therefore identical on the cured run,
so replaying the stored refusal hands back an answer the Host stopped believing
the moment the neighbour changed, and pins it for the operation TTL. Under this
ADR's own split that is a refusal about the Host.

**A refusal whose truth is held by another resource carries
`hostCode: cross_resource_precondition`, and a marked refusal is re-attempted
whatever its code.** `REATTEMPTED_SETTLED_FAILURE_CODES` is unchanged and still
answers every code that means one thing; the marker answers the code that does
not. Malformed input keeps replaying, because for malformed input the stored
answer really is still the answer.

### Why a marker and not a new code

A new code would have been the tidier list. It is not available. The portable
taxonomy is closed and released: `stableErrorHTTPStatusByCode` in the provider's
`internal/clientv3/errors.go` — mirrored here as `STABLE_ERROR_HTTP_STATUS` —
is the complete set `parseAPIError` will classify, and a code outside it is read
as an opaque rejection carrying no portable semantics at all. Minting
`precondition_unmet` would answer outside the taxonomy every released provider
speaks, to fix a defect that lives entirely on this side of the wire.

`hostCode` is the seam that contract already leaves for exactly this: a Host's
own finer name beside the portable code, declared by `host-api-wire-v1` and
`operation-v1` as a free-form non-empty string, decoded by both the envelope and
the terminal-operation paths, and acted on by neither. It is also the only
member this Host may add — both decoders use `DisallowUnknownFields`, so a field
of our own invention would make the whole envelope protocol-invalid.

### What does not change

The wire answer is the same refusal it was: the same portable code, the same
status, `retryable: false`, and provider 4.0.0's retry table
(`resource_busy | backend_unavailable | rate_limited | deadline_exceeded`) is
untouched, so nothing auto-retries. The operator gets a definitive refusal
*now*, naming the neighbour and what to do about it. Only the **next** identical
apply — after they have changed that neighbour — is attempted afresh instead of
being answered from the record.

And a re-attempt is still never a second mutation. The safety property is the
store's, as above: every marked refusal is a precondition failure raised before
the driver is entered, so the provider was not invoked and there is nothing to
attempt twice.
