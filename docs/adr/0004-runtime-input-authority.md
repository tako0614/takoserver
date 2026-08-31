# ADR 0004 — Worker origin reservation and one-shot runtime-input authority

**Status:** accepted, 2026-08-31

## Decision

Takoserver owns two related control-plane authorities outside the stable Takoform
Host API:

- `WorkerEndpointOriginReservation` chooses and holds the canonical public
  origin of a future ModuleWorker before either the worker or endpoint Resource
  exists.
- `RuntimeInputAuthority` seals values named by a Worker Version's
  `requiredSensitiveVars` and hands them to the exact selected provider through
  a one-shot lease.

The earlier design derived the origin from an already Ready `WorkerEndpoint` or
`WorkerCustomDomain`. That created an unshippable dependency cycle: the provider
needed the runtime-input reference to create the worker, while the reference
could not be prepared until a downstream endpoint already existed. A
reservation is value-free and can safely precede the Resource graph.

These authorities do not change frozen Takoform Host v1 routes, Forms, desired
state, or outputs. Takoform continues to describe portable Resources. The
Takoserver control plane owns sold Offering selection, provider installation
placement, future native naming, leases, and secret transport.

## Public control contract

An organization API key with `resources:write` calls these closed routes. The
organization is taken only from the authenticated key, not from a request body.
Where the runtime-input route also carries `organizationId` in its path, that
value must exactly equal the key's organization; an owner session is not a
machine credential for these routes:

- `GET|PUT|DELETE /v1/worker-endpoint-origin-reservations/{reservationId}`
- `PUT|DELETE /v1/worker-endpoint-origin-reservations/{reservationId}/activation`
- `GET|PUT|DELETE /v1/organizations/{organizationId}/worker-runtime-input-preparations/{operationId}`

The reservation format is
`takoserver.worker-endpoint-origin-reservation.v1`. Its public projection
contains only the reservation ID, canonical origin, revision, expiry, logical
target (`space`, `workerName`, `endpointName`), status, and the exact worker or
endpoint UIDs once known. Provider placement is deliberately retained in the
ledger but not exposed as portable identity.

Reservation PUT may omit `offeringId` only when the same sold-placement
authority used by ordinary Host mutation finds exactly one eligible
ModuleWorker Offering. Zero or multiple eligible Offerings fail with 422. The
selected Offering digest, provider pack, and provider installation are always
stored and later drift-fenced. Provider adapters expose only a narrow,
non-mutating derivation capability. Cloudflare and self-host derivation use the
same worker-name and endpoint-suffix code as their real mutation path; preparing
a reservation creates no Takoform Resource and performs no provider mutation.

## Reservation lifecycle and deletion ordering

```text
prepared --bind exact Ready ModuleWorker--> bound
bound --activate exact Ready WorkerEndpoint--> activated
activated --deactivate exact endpoint UID--> bound (endpoint UID retained)
prepared|unactivated bound --expiry--> terminal
prepared|bound --release with absence fences--> terminal
```

There is one live reservation per organization, space, and logical worker, and
one global owner per canonical origin. A PUT replay succeeds only when its
target, TTL, selected placement, Offering digest, and derived origin are exact.

Binding records the exact Ready/current-generation ModuleWorker UID and
revision and its matching active provider deployment. Activation accepts an
actual released stable `WorkerEndpoint` only: its UID, logical address,
Ready/current generation, `/worker` relation, canonical output, and provider
placement must all match. Custom-domain activation is not currently supported.
After that proof, the stable Host contract makes a `WorkerEndpoint` UID's worker
relation and hostname/URL immutable; changing any of them requires replacement
with a new UID. Reservation reads therefore rely on the pinned endpoint UID
rather than inventing a second mutable endpoint authority.

Deactivation changes `activated` to `bound` but intentionally retains the
endpoint UID and revision as a deletion witness. This makes the projection of a
deactivated reservation unambiguous: `status: "bound"` plus
`endpointResourceUid` means activation has ended but that endpoint still owns
the origin. Release then requires all of the following in one SQL authorization
check:

1. no activation and no unexpired claimed runtime-input lease;
2. the retained endpoint Resource is absent;
3. its deletion attestation is closed; and
4. no provider deployment remains outside `deleted` or `failed`.

Therefore the safe destroy order is activation DELETE, endpoint Resource
DELETE and absence closure, then reservation DELETE. The origin cannot be
reallocated during the interval in which the old native endpoint may still
exist. Expiry also cannot bypass that ownership: an expired row with a retained
endpoint UID remains inside both uniqueness constraints until the same absence
fences allow explicit release. Release is idempotent once terminal.

## Plan-known reference and exact binding

Runtime-input PUT uses format
`takoserver.worker-runtime-input-preparation@v1`. It contains a non-secret
`materialSetNonce`, the caller-computed `runtimeInputReference`, logical target
including `originReservationId`, the actual ModuleWorker UID, and the secret
bindings. It does not accept a caller-supplied origin.

The caller and server compute the reference from the UTF-8 SHA-256 of canonical
JSON with this exact insertion order:

```json
{
  "format": "takoserver.worker-runtime-input-preflight.v1",
  "materialSetNonce": "...",
  "target": {
    "space": "...",
    "workerName": "...",
    "bundleName": "...",
    "endpointName": "...",
    "originReservationId": "...",
    "canonicalPublicOrigin": "..."
  },
  "bindings": {
    "LEXICALLY_SORTED_NAME": "exact value"
  }
}
```

For lowercase digest hex `H`, the identities are
`preparationId = "prep-" + H[0:32]` and
`runtimeInputReference = "rip1." + preparationId + "." + H`. The future
worker UID is excluded so the reference is plan-known; preparation separately
binds the actual UID, worker revision, material-set ID, reservation revision,
and provider placement in dedicated columns. The `preparation_commitment`
column means only this preflight SHA-256 commitment. It is never overloaded
with post-creation Resource identity.

Before sealing, Takoserver resolves and atomically binds the reservation to the
exact Ready ModuleWorker. It takes the endpoint name and canonical origin only
from the reservation, recomputes the reference from the exact binding values,
and rejects any mismatch. A replay must match both the preflight commitment and
all separately stored exact identities.

## Lease, dispatch, and recovery

The provider-neutral `ProviderRuntimeInputLeasePort` is the only value-bearing
seam from the Host to a provider adapter:

- Acquisition validates the reference and live bound/activated reservation
  before any provider call, then claims the exact operation, target, and worker.
- Dispatch revalidates the reservation, exact worker UID and revision,
  placement, Offering digest, and live deletion attestation. The same D1 CAS
  fences those identities and the reservation revision while clearing durable
  ciphertext before the provider request.
- ModuleWorker deletion cannot begin while an unexpired exact claim exists.
- Abort revokes a prepared or claimed but undispatched handoff. Settle consumes the handoff only with a
  digest of authoritative provider readback.
- A dispatched handoff retains only value-free recovery identity. Recovery can
  settle an acknowledgement loss but cannot redispatch, return values, or
  depend on a reservation or endpoint that may legitimately be deleted after
  dispatch authorization.

Prepared rows expire after one hour and claimed leases after fifteen minutes.
Corrupt or unavailable sealed material fails closed and never issues a second
claim. The current non-extractable AES-256-GCM key seals new rows; bounded
previous keys may decrypt existing prepared/claimed rows during rotation.

## Composition consequence

Origin derivation belongs to the same provider selected for ordinary Host
mutation, while that provider consumes runtime-input leases and the runtime
authority consumes the reservation port. The Worker entry composition therefore
has a genuine construction cycle. It is closed by a narrow single-assignment
reservation handle: calls fail closed before connection, connection is allowed
exactly once, and the handle exposes only `bind` and `inspectBound`. General
mutable composition state is not an authority.

## Non-goals

- A reservation is not a Takoform Resource, Form field, sale-catalog default,
  or a provider-native credential.
- A `rip1` reference is not a bearer credential and never replaces Host
  authentication, authorization, or idempotency.
- Secret values never enter a public projection, log, provider identity, or
  portable state.
- Activation does not infer authority from arbitrary URL-like outputs.
