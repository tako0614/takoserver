# Managed Space admission

Status: implementation candidate, not an enabled deployment path. The policy,
coordinator, narrow Worker entrypoint and sponsorship issuance ordering are
implemented. Operator deployment and live multi-Space verification are not
complete.

## Ownership

Takoserver decides which exact Forms an operator permits in a Space. A consumer
does not select publisher evidence, change Host support, or activate arbitrary
Forms while asking for a run credential. This uses existing Takoform admission
semantics; it does not change a released Form or the public Host API.

The operator supplies `formAuthority.managedSpaceAdmissionPolicy` in the private
deployment target: `takoserver.space-form-admission-policy@v1` with one
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

The production Form authority Worker exports `TenantSpaceAdmissionEntrypoint`
separately from its full operator entrypoint. It obtains complete publisher
evidence locally and uses the released-Core composition. Its optional
`TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY` binding must contain the operator's
canonical policy JSON; without it, the narrow operation fails closed. This is
not the singleton integration fixture authority.

The released-Core Worker can run in either the integration or production
environment. The environment name does not select the fixture authority;
the deployment surface does. A managed policy is never injected into the
singleton fixture Worker or its operator gateway.

The sponsorship Worker uses only `TENANT_SPACE_ADMISSION`, bound to that named
entrypoint, together with `TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY_DIGEST`.
Either both bindings are present or both are absent. An incomplete binding pair
is rejected. Absence retains the existing unmanaged issuance behavior; it does
not claim that any Space has been admitted.

## Deployment and remaining live acceptance

Use the owning `bun run deploy` surfaces and an explicit environment. Adding
this policy is an authority change, not an ordinary code-only upload.

1. Publish the selected public Host source through its owning surface. The
   released-Core Form authority deployment requires the served public source
   commit and rebuilt artifact to match its selected source.
2. Deploy `takoserver-form-authority-worker` with the exact private policy.
   For an existing Worker without the policy, declare its exact predecessor
   Version and `--add-var=TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY`. Perform
   the normal exact configuration and Core-verifier readback before advancing.
3. Deploy `takoserver-sponsorship-authority-worker`. For an existing unmanaged
   issuer, declare its exact predecessor Version and exactly these additions:

   ```text
   --add-var=TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY_DIGEST
   --add-binding=TENANT_SPACE_ADMISSION
   ```

   A new issuer uses ordinary first creation. In either case, the deployment
   refuses an absent, drifted or differently configured Form authority and
   checks that its exact dependency Version remains unchanged through upload.
   The existing dedicated signing keys, topology visibility checks and
   route-less boundary remain required. The caller receives no full Form
   authority binding.
4. Wire the consumer through its own deployment surface and complete the live
   acceptance below. Deploying these Workers alone is not proof of a successful
   application install.

The shared transition selector is `--closure-predecessor-version=<uuid>`;
binding values are derived from the selected target, never supplied by the
transition flags. Routine status and post-publication checks still require
the exact final binding set. This initial enablement does not define a policy
replacement, tenant decommission or rollback that revokes existing admission.
Those require their own explicit lifecycle decisions.

Before enabling this path, the owning deployment must pin the policy and bind
its narrow named entrypoint, with exact configuration readback. Credential
issuance follows this sequence:

1. Claim the opaque tenant for the pinned organization under the existing
   wallet eligibility guard, rejecting a foreign owner.
2. Ensure admission and verify its exact ready result.
3. Recheck wallet and ownership when creating the existing issuance operation,
   then sign the credential and receipt.

Do not start a credential's lifetime before potentially slow admission. If
admission fails, no issuance operation or credential may be created. A retained
ownership claim can be retried. If credit changes after admission succeeds,
positive activation may remain but credential issuance must still fail closed.

Reconstructing an already-recorded, exactly matching issuance operation is not
a new grant: it retains the original token identity and issuance/expiry times,
without repeating admission or extending its lifetime. A changed request,
authority identity or managed policy digest conflicts with that retained
operation. Admission is therefore required before the first durable issuance
record, not before returning every copy of the same credential.

An application uninstall must not deactivate its Space: several applications
may share it. Tenant decommission is a separate lifecycle and is not implemented
by this foundation.

Live acceptance must demonstrate two independently derived tenants coexisting,
unchanged activation heads for the existing Space, repeated request convergence,
and normal install/update/destroy through the unchanged public provider path.
