# ADR 0006 — The runtime-input wire contract is v2, keyed by the operation

**Status:** accepted, 2026-09-02. Supersedes the wire contract and the
composition consequence of
[ADR 0004](0004-runtime-input-authority.md); the reservation authority that ADR
describes is otherwise unchanged.

## Decision

Takoserver speaks exactly one runtime-input wire contract, and it is the one the
released Takoform provider speaks:

- format `takoserver.worker-runtime-input-preparation@v2`
- `PUT|GET|DELETE /v1/takoform/worker-runtime-input-preparations/{operationKey}`
- `Idempotency-Key: {operationKey}`, which must equal the path segment
- request `{format, canonicalPublicOrigin, publicApply: {method: "PUT", path,
  fences: {ifNoneMatch: "*"}, body}, bindings: {NAME: "value"}}`
- response `{format, status, operationKey, applyCommitment,
  canonicalPublicOrigin, bindingNames[], hostOperationId?}` with
  `status ∈ prepared | accepted | dispatched | consumed`

`applyCommitment` is the SHA-256 of `[label, method, path, ifNoneMatch, body]`
where each field is UTF-8 preceded by its unsigned 64-bit big-endian byte
length and the label is
`takoserver.worker-runtime-input-public-apply@v1`. The framing is
length-prefixed so that two different requests cannot hash the same by moving a
byte from the path into the body.

v1 is removed rather than kept beside it. There is no dual route, no
compatibility shim, and no negotiation.

## Why v1 could not stay

v1 asked the caller to compute an `rip1.<preparationId>.<digest>` preflight
reference over a nonce, the logical endpoint identity, the reservation id, the
canonical origin, and the exact sorted binding values, and it bound each
preparation to a live `WorkerEndpointOriginReservation`. The released provider
does none of that. It has no preflight reference, no material-set nonce, and no
reservation: it addresses the preparation by the operation key it already had to
choose for the public apply, and it commits to the apply itself.

No released provider ever spoke v1, so nothing consumes it and nothing has to be
migrated. Keeping both would mean maintaining a second sealed-record shape and a
second authority chain for a contract with zero clients. The Host follows the
provider.

The v2 design is also the stronger one for the property that matters. v1's
commitment was over the *values*, which meant it could not be recomputed once
the values had been erased, and it said nothing about which mutation was allowed
to spend them. v2's commitment is over the *exact request*, so a preparation
names one apply and the caller can verify that the Host bound it to the same
one — the Host's echo of the commitment is checkable against the caller's own
computation.

## What this removes

`canonicalPublicOrigin` changes meaning. In v1 it was the future Worker's public
origin, taken from a reservation and never accepted from the caller. In v2 it is
**this Host's own canonical public origin**, sent by the caller and refused
unless it matches exactly what this deployment is configured to be. It is an
anti-misdirection fence, not an allocation. The runtime-input authority
therefore takes `canonicalPublicOrigin` at construction and no longer takes an
origin-reservation port.

That deletes ADR 0004's "Composition consequence": the runtime authority no
longer consumes the reservation port, so the Worker entry composition has no
construction cycle between them. The single-assignment reservation handle
remains, because origin derivation still needs the selected provider; it is
simply no longer load-bearing for runtime inputs. The three `NOT EXISTS`
runtime-input clauses that fenced reservation expiry and release are gone with
the column they read.

The preparation record loses `material_set_id`, `material_set_nonce`,
`origin_reservation_id`, `origin_reservation_revision`, `endpoint_name`,
`worker_resource_revision`, and the provider-placement columns, and gains
`operation_key`, `apply_commitment`, and `host_operation_id`. Migration
`0037_worker_runtime_input_preparation_v2.sql` replaces the table forward-only:
every row it could hold is a sealed handoff that expires within the hour, and no
released provider ever wrote one.

## What this keeps, unchanged

- **At-rest sealing.** AES-256-GCM under the operator's key ring, with the AAD
  binding `{format, organizationId, operationKey, preparationId, keyId,
  canonicalPublicOrigin, applyCommitment, bindingNames}` — the same discipline
  as v1 against the new identity fields.
- **Erase before mutation.** `dispatch` clears the ciphertext under a CAS fence
  on `(preparationId, fence, claimOwner, resourceUid)` before the provider is
  called, and re-proves the exact ModuleWorker, its live deletion attestation,
  and an active deployment in the same statement.
- **One-shot.** `settle` consumes only against a digest of authoritative
  provider readback. Recovery reads value-free identity and can settle an
  acknowledgement loss; it can never redispatch and never returns a value.
- **Expiry.** One hour prepared, fifteen minutes claimed, swept by the same
  bounded maintenance tick.
- **Never logged, never projected.** No value reaches a projection, an Output,
  a native id, the ledger, or a log line. The wire projection carries names and
  a commitment only.
- **Deletion fence.** A ModuleWorker cannot begin deletion while an unexpired
  exact claim names its uid.

## Consequences a reader should expect

- **Retry is possible; replay is not.** A handoff that never left this Host —
  aborted, expired, or indeterminate — may be prepared again under the same
  operation key, because a Terraform retry recomputes the same plan-derived key
  and refusing it would strand the resource. A handoff that was dispatched or
  consumed is never replaceable: its values already reached a provider.
- **Absence is the answer for a spent or revoked key.** `GET` reports only the
  four wire statuses; anything else reads as `operation_not_found`, which is
  both honest and what lets the retry above happen.
- **`hostOperationId` appears only once a Host operation claims the handoff.**
  A Host that answered the public apply synchronously has no operation to poll,
  and a caller recovering a lost acknowledgement will be told the mutation was
  accepted rather than being invited to send the secrets again.
- **The executing apply is fenced by the idempotency key, not by re-deriving the
  commitment inside the adapter.** The Host stores and echoes the commitment and
  refuses a replay that changes it; the ordinary mutation path already refuses a
  different body under the same `Idempotency-Key`; and the provider compares the
  echoed commitment with its own before it sends the public apply. The internal
  `ProviderRuntimeInputLeasePort` stays version-agnostic and carries no wire
  field.
- **The private route is the one control route measured in megabytes.** It
  carries the exact public apply body plus every value, so its outer refusal is
  4 MiB with the real per-field ceilings (8 KiB path, 1 MiB body, 64 bindings of
  32 KiB) enforced underneath.

## Non-goals

- v2 is not a second contract offered alongside v1.
- An operation key is not a bearer credential. It never replaces Host
  authentication, authorization, or idempotency; the organization is taken only
  from the authenticated API key.
- A secret value never becomes identity.

## Amendment — 2026-09-02: the lease port carries the executing apply

The "Consequences a reader should expect" section above claimed that the
executing apply is fenced by the idempotency key and that the internal
`ProviderRuntimeInputLeasePort` therefore needs no wire field. An adversarial
review of the implementation showed that this was not true, so the port now
carries one value-free field and the claim recomputes the commitment.

**What was actually enforced.** `claim` compared the organization, the operation
key, and the sorted binding-name set. `space`, `worker_name`,
`worker_resource_uid`, and `bundle_name` were *written from the executing apply*
rather than compared, and `apply_commitment` was stored and echoed but never
re-derived. The idempotency fence cited above is the Host's replay record, whose
key is `tenant \0 principal \0 space \0 operation \0 Idempotency-Key`. It only
exists after a first apply under that key commits, and it is per-principal and
per-space, while a preparation is per-organization. So the first apply under an
operation key was unfenced, and a second credential in the same organization —
including a scoped tenant-run token, which can spend a preparation it cannot
create or read — got a fresh replay key and no fence at all. Any principal that
could mutate resources in the organization and knew the plan-derived operation
key could have another principal's prepared values installed into a Worker
Version of its own choosing and then read them from inside that Worker.

**What changed.** `ProviderRuntimeInputAcquireInput` gains
`publicApply: {method, path, ifNoneMatch, body}`: the value-free identity of the
ordinary apply this Host is executing, carried from the engine through the
driver to the adapter. `claim` recomputes
`runtimeInputPublicApplyCommitment` over it and compares the result with
`apply_commitment` — before the CAS, and again as one more `AND` inside the same
CAS that records the target. A mismatch is its own failure, code
`apply_commitment_mismatch` (409): the preparation is not claimed, no target is
written, no ciphertext is erased, and the apply fails closed. A request shape
this contract cannot authorize at all is reported the same way, because it can
equal no stored commitment.

The body carried here is the ordinary portable Resource the caller would have
sent with no runtime inputs, so nothing sealed crosses the seam. The engine
states the apply only for a create (`If-None-Match: *`), which is the only
mutation a preparation can authorize; an adapter that needs a claim and has no
executing apply refuses before any provider mutation rather than claiming
unfenced. Recovery and abandonment take
`Omit<ProviderRuntimeInputAcquireInput, "publicApply">` — they never claim, and
their fences are the row's own claim owner, Resource UID, and logical target.

The port is therefore no longer strictly version-agnostic: it carries the
identity of the request v2's commitment is computed over. That is the price of
the property the contract already claimed. A commitment nothing recomputes is a
record, not a fence.

## Amendment — 2026-09-02: three smaller corrections from the same review

- **The canonical public origin is HTTPS-only, and composition proves it.** The
  Host previously blessed `http://localhost` and `http://127.0.0.1`, which
  disagreed with both `openapi/takoserver.openapi.json` and the released
  provider's client-side check — so on a loopback deployment every runtime-input
  apply failed before a request was sent. Loopback is gone. A deployment without
  a TLS public origin composes no runtime-input authority, advertises no
  capability, and refuses the declaration at admission. `RuntimeInputAuthority`
  also exposes `canonicalPublicOrigin`, and `buildApp` refuses a composition
  where it differs from the Host's own `publicOrigin`: an anti-misdirection
  fence configured against an origin the Host is not served at fences nothing.

- **Terminal rows are reclaimed after seven days.** `expireDue` swept only
  `prepared` and `claimed`, so every successful sensitive create left a row
  forever. `dispatched`, `consumed`, `revoked`, `expired`, and `indeterminate`
  rows hold NULL ciphertext and describe a handoff that expired within the hour;
  the same bounded maintenance tick now deletes them once they are older than
  seven days. The window is bookkeeping, not safety: what it buys is a readable
  answer to "was this operation key already spent" for a run from earlier in the
  week.

- **Removing the reservation coupling opened a release window.** "What this
  removes" notes that the three `NOT EXISTS` clauses fencing
  `WorkerEndpointOriginReservation` expiry and release are gone with the column
  they read. The consequence was not stated: during a sensitive WorkerVersion
  apply — reservation `bound`, endpoint Resource not yet created — nothing now
  stops that reservation from being released and its globally unique canonical
  origin reallocated to another logical Worker. It is an availability window
  only. No native endpoint exists yet, so the reservation's own release fences
  (absent endpoint Resource, closed deletion attestation, no live provider
  deployment) are all satisfied and no origin is taken from something serving;
  the apply that loses its reservation fails and is retried with a new one. In
  v2 a preparation has no reservation, so the old coupling is not restorable —
  the reservation authority would have to fence on the Host operation instead,
  which is a separate decision and is not made here.

## Amendment — 2026-09-02: "never projected" needed a flag to be true

"Never logged, never projected" says that no sealed value reaches a projection,
an Output, a native id, the ledger, or a log line. On the managed
(Workers-for-Platforms) backend that was not enough. A sensitive binding is
uploaded as a `secret_text` binding on the tenant's own Worker, and the runtime
hands every binding of a script to every module that script runs — so
`import { env } from "cloudflare:workers"` returned the value whatever the
wrapper chose to project. That is not a leak *across* tenants: the value belongs
to the Worker it was installed on, and the tenant's handler already receives it
under the declared name. It did mean the wrapper's projection was a convention
rather than a boundary, and that anything else on the raw environment — the
internal SQLite Durable Object namespace, an internal bucket handle — came with
it.

Managed tenant user Workers are now uploaded with `disallow_importable_env`, and
the release readback refuses a release whose settings do not carry it. See
[ADR 0007](0007-objectbucket-joins-the-implementation-catalog.md)'s managed-lane
amendment for what that closes and what remains. Nothing about this contract's
wire shape, sealing, erase-before-mutation, or one-shot settlement changes.

## Amendment — 2026-09-02: a spent handoff is spent on something, and outlives it

"A handoff that was dispatched or consumed is never replaceable: its values
already reached a provider" was written for the object those values configured.
Nothing said what happens once that object is *gone*, and the answer was that
`tofu destroy` followed by `tofu apply` silently built nothing.

The released provider derives its operation key from the plan, so the second
apply presents the same key. The preparation answered `consumed` with the
previous run's `hostOperationId`; the provider polled that settled operation,
OpenTofu printed `Creation complete` for a `WorkerVersion` this Host had not
made, and the next resource failed `resource_not_found` 404, with every later
refresh reporting the Version "has been deleted". The only escape was rotating a
`runtime_input_nonce` no operator was told was load-bearing, and a Yurucommu
instance could not be rebuilt in place after a teardown.

A spent handoff is bound to the incarnation it produced. When that incarnation
is provably gone — no `tf_resources` row and a deletion attestation that is
`closed`, which is written in the same commit that removes the row — the
handoff is retired and the operation key may be prepared again. `GET` reports
absence for it, which is what the contract already says about a key that carries
no live authority. This is
[ADR 0008](0008-a-settled-refusal-about-the-host-is-re-attempted.md)'s rule for
the operation ledger — a committed mutation is replayed under its key and
retired once the Resource it committed no longer exists — applied to the route
that bypassed it.

One-shot is unchanged. While the incarnation exists the key is still refused;
an incarnation still being created has neither proof, so nothing in flight is
ever retired; and the apply commitment stays fenced where it was, in the claim
CAS, because a retired handoff is replaced by a fresh preparation with a fresh
commitment that `claim` re-derives.
