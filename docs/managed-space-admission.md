# Managed Space admission

Status: implementation foundation, not an enabled deployment path. The policy,
coordinator and narrow authority helper are implemented. Worker service-binding
composition, sponsorship issuance ordering, operator deployment and live
multi-Space verification remain to be connected.

## Ownership

Takoserver decides which exact Forms an operator permits in a Space. A consumer
does not select publisher evidence, change Host support, or activate arbitrary
Forms while asking for a run credential. This uses existing Takoform admission
semantics; it does not change a released Form or the public Host API.

The operator supplies `takoserver.space-form-admission-policy@v1` with one
`organizationId` and a nonempty list of exact `{ formRef, packageDigest }`
identities. No product, publisher or “official” catalog is selected by default.
Each identity must belong to both the full verified publisher closure and the
Host's realized implementation catalog. Policy normalization is deterministic;
duplicates, unknown identities and mismatched package digests are refused.

The policy limits **positive activation**, not publisher verification. The
coordinator still imports and verifies the complete package closure and
reconciles Host support. It activates only selected Forms for the requested
Space. It neither deactivates excluded Forms nor changes another Space's
activation history. The existing operator path without this policy retains its
existing behavior, including its separate explicit deactivation operation.

## Narrow caller boundary

`createTenantSpaceAdmissionAuthority` accepts only `{ tenantRef }` for each
invocation. Its composition deliberately uses the opaque tenant reference as
the Space reference and the pinned organization as the activation tenant.
This invariant is specific to managed admission; the general credential API
continues to have independent tenant and Space fields. Supporting a different
mapping here requires an explicit ownership contract, not caller-selected
Space input.

The helper checks an existing `sponsorship_tenants` ownership row before it
constructs Form authority, checks it again before apply, and checks it before
returning readiness. It constructs the normal positive plan from operator-owned
evidence, applies it once, and requires a fresh exact readback of all selected
Forms. Partial application, stale implementation identity and fixture-only
verification cannot produce a ready result. A subsequent invocation replans
from retained state; there is no hidden retry or rollback loop.

Only the narrow operation should be bound to a credential issuer. Binding the
full plan/apply Form authority to it would grant authority the caller does not
need. The public customer Worker remains a read-only consumer of admission
state.

## Remaining integration

Before enabling this path, the owning deployment must pin the policy and bind
its narrow named entrypoint, with exact configuration readback. Credential
issuance must:

1. Claim the opaque tenant for the pinned organization under the existing
   wallet eligibility guard, rejecting a foreign owner.
2. Ensure admission and verify its exact ready result.
3. Recheck wallet and ownership when creating the existing issuance operation,
   then sign the credential and receipt.

Do not start a credential's lifetime before potentially slow admission. If
admission fails, no issuance operation or credential may be created. A retained
ownership claim can be retried. If credit changes after admission succeeds,
positive activation may remain but credential issuance must still fail closed.

An application uninstall must not deactivate its Space: several applications
may share it. Tenant decommission is a separate lifecycle and is not implemented
by this foundation.

Live acceptance must demonstrate two independently derived tenants coexisting,
unchanged activation heads for the existing Space, repeated request convergence,
and normal install/update/destroy through the unchanged public provider path.
