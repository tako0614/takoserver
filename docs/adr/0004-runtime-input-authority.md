# ADR 0004 — Host-owned one-shot runtime-input authority

**Status:** accepted, 2026-08-31

## The boundary

Takoserver owns `RuntimeInputAuthority` in its control plane. It is the
authenticated handoff for values named by a Worker Version's
`requiredSensitiveVars`; it is separate from the stable Takoform Host API and
Form fields. The declaration carries names only. The authority carries the
corresponding values out of band, and no provider identity, native identifier,
or credential is added to a Form or portable desired/observed state.

An owner session or an organization API key with `resources:write` may call
`PUT /v1/organizations/{organizationId}/worker-runtime-input-preparations/{operationId}`.
The closed request is sealed in the control database and the response is a
value-free projection containing a one-shot `rip1` reference. The caller must
reuse that reference as the existing Host `Idempotency-Key`; the reference is
not authentication or authorization.

The preparation commitment binds the organization, operation and preparation
identities, material set, full target (including the origin Resource),
canonical public origin, and sorted binding names. A replay with any of those
fields changed is a conflict.

The origin is not trusted from that request. Before sealing anything,
Takoserver resolves the named, live Resource from its own inventory. Only the
exact released `WorkerEndpoint` and `WorkerCustomDomain` Forms may supply an
origin. The resolver derives the HTTPS origin from their immutable output or
hostname and verifies their stored `/worker` relation against the exact
ModuleWorker UID. That UID is also part of the preparation target and
commitment. URL-like fields on any other Resource have no authority.

## Lifecycle

The provider-neutral `ProviderRuntimeInputLeasePort` is the only seam from the
Host to a provider adapter:

- A provider acquires an exact operation/Resource/target claim and receives
  values only in the in-memory lease.
- Claim and origin deletion are reciprocal D1 fences. Claim succeeds only
  while the origin incarnation tombstone is `live`; deletion can move it to
  `pending` only while no unexpired claim exists. Immediately before dispatch,
  the authority resolves the complete origin again. Its authorization CAS
  requires both `live` and the exact Resource revision returned by that read,
  so a status/output/relation race fails instead of authorizing a stale origin.
- Abort revokes an un-dispatched claim. Dispatch clears the durable ciphertext
  before the provider request carrying the values is sent.
- Settle consumes the one-shot handoff only with a digest of the provider's
  authoritative readback receipt. A dispatched handoff is retained for
  value-free recovery; recovery cannot redispatch or return values. Recovery
does not require an origin that may legitimately have been deleted after the
dispatch authorization point.

Prepared rows expire after one hour and claimed leases after fifteen minutes;
bounded maintenance clears ciphertext for those rows. Dispatched rows are not
claimed-TTL garbage: they remain for value-free recovery until consumed or
otherwise reconciled.
Corrupt or unavailable sealed material fails closed and does not issue a second
claim.

## Capability and recovery

Public capability discovery is conservative for each exact Form: it reports the
minimum runtime-input capacity across matching configured providers, and zero
when no matching provider can consume leases. Mutation admission then selects
the exact sold or inherited provider and checks that provider again before any
provider mutation or Offering claim. A capability advertised for one provider
does not authorize another.

The Cloudflare adapter advertises at most 64 bindings, and only when a
`RuntimeInputAuthority` is configured with the operator-private
`TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING`; without it, sensitive runtime inputs
are unavailable. Ordinary self-host composition has no such authority and
remains fail-closed. If an upload acknowledgement is lost, the exact provider
readback is used to settle the retained dispatched handoff without another
upload. Lease acquisition precedes asset-upload session creation, so an invalid
reference or origin causes zero Cloudflare mutations; an asset failure aborts
the still-undispatched lease.

The key ring's current AES-256-GCM key seals new preparations. Bounded previous
keys may decrypt existing prepared or claimed rows during rotation; operators
retain them until those rows can no longer be claimed, then retire them. Key
material is imported as non-extractable keys and is never returned by the
control or recovery projections.

## Non-goals

- This is not a new Takoform API or a new Form field; `requiredSensitiveVars`
  remains a declaration consumed by the Host's existing lifecycle.
- A `rip1` reference is not a bearer credential and never replaces Host
  authentication, authorization, or the Host's idempotency rules.
- Provider identity, provider-native IDs, and credentials do not become Form
  identity or portable state.
