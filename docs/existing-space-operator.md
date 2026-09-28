# Existing-Space operator transport

Status: source implementation, not evidence of an enabled ingress or live
reconciliation. Publishing or using this authority requires explicit operator
authorization for the selected environment. It is an internal operator tool,
not a new public Host API, Form, sponsorship operation, or customer endpoint.

## Boundary

The released-Core `FormAuthorityEntrypoint` remains route-less. A dedicated
operator Worker binds only `PUBLIC_HOST_IDENTITY` and that full named authority.
Its signed HTTPS interface exposes exactly two POST paths:

- `/v1/existing-spaces/reconcile` forwards only `{policyDigest, spaces}` to
  `reconcileExistingSpaces` once.
- `/v1/existing-spaces/readback` forwards the existing
  `takoserver.form-authority-plan-request@v2` to `readback` only. This shape is
  also used for readback by the existing coordinator; no plan is created.

There is no plan/apply proxy, database, object storage, provider credential,
customer handler, or credential issuance. The singleton integration fixture
gateway and the narrow tenant-admission caller are not extended.

The bridge uses the existing operator assertion verifier with a distinct closed
`existing-space-reconciliation` purpose, action, POST method, exact path and
canonical request digest. The signature also pins the HTTPS origin,
environment, policy digest, current public Host Version/artifact/capability/
implementation identity and current released authority Version. Assertions
carry those expected identities through the internal RPC boundary; the
authority checks its own Version and composed Host identity before any work.
An identity change after bridge authentication cannot authorize new-identity
admission writes. Assertions expire after at most 120 seconds; the owning client
issues 60-second assertions. Local signature/purpose/expiry verification precedes
all service RPCs, and expiry is checked again after potentially slow identity
observation, immediately before dispatch.
Cross-purpose, cross-environment, altered-body and post-identity-change replay
fail closed. An unchanged request can repeat within its validity window; this
is not a single-use token system. The RPC's positive-head compare-and-swap
contract preserves absent/inactive admission, without a second replay ledger.

## Explicit operator configuration

The private deploy target must contain both
`formAuthority.managedSpaceAdmissionPolicy` and:

```json
{
  "existingSpaceOperator": {
    "workerName": "operator-selected-worker",
    "origin": "https://operator-selected.example.invalid",
    "publicJwk": { "kty": "OKP", "crv": "Ed25519", "x": "<dedicated-public-key>" }
  }
}
```

This object belongs inside `formAuthority`. There are no domain, scope, policy,
or key defaults. The origin must be separate from public/console/probe/fixture
surfaces and aliases; workers.dev and preview ingress are forbidden. The key
must not reuse configured customer identity, fixture, sponsorship, or JIT keys.
The private half stays in an operator-owned 0600 file outside repositories.

The bridge's exact deployed closure is five text variables and two service
bindings. The deployment proves the current public Host, released-Core authority,
managed policy, dependency Version and custom-domain topology before upload and
again afterward. Source/artifact qualification uses the existing owner deploy
lifecycle. It does not create a new ledger or a generic provider transport.

## Owning commands

Publish the bridge only after separately authorizing its ingress and authority:

```sh
bun run deploy -- takoserver-existing-space-operator-worker --environment=integration --commit=<40-hex> --status
bun run deploy -- takoserver-existing-space-operator-worker --environment=integration --commit=<40-hex> --apply
```

For reconciliation, supply `TAKOSERVER_EXISTING_SPACE_REQUEST_PATH` as an
absolute owned 0600 JSON file containing exactly a selected policy digest and
1–100 unique explicit Space references:

```json
{ "policyDigest": "sha256:<64-hex>", "spaces": ["explicit-existing-space"] }
```

Also supply `TAKOSERVER_EXISTING_SPACE_OPERATOR_PRIVATE_JWK_PATH`.
`TAKOSERVER_INDEPENDENT_REVIEW` is required for apply only. Both actions verify
the exact current bridge/authority/Host/policy closure through the owning
publication status. The deploy target and provider readback credential follow
the existing environment-selected input contract.

```sh
bun run deploy -- takoserver-existing-space-reconciliation --environment=integration --commit=<40-hex> --status
bun run deploy -- takoserver-existing-space-reconciliation --environment=integration --commit=<40-hex> --apply
```

Status sends only signed POST readback requests, never reconciliation. POST is
used because Fetch does not permit a GET request body; scope/evidence is not
placed into URL query strings. Apply qualifies source and review, sends exactly
one reconciliation, then reads each selected Space. It compares returned
positive heads against exact fresh readback, without claiming application or
Space readiness. An empty refreshed set is a valid no-op, not a new grant.

## Failure and reversal

Any failure after entering the mutation transport is indeterminate, including
HTTP rejection and lost acknowledgement. The command never retries and directs
the operator to status. A successful mutation followed by mismatched or missing
readback is a verification failure. Earlier positive writes are retained;
there is no automatic rollback, deactivation, or absent/inactive Form grant.
Inspect readback and select forward repair explicitly. Code rollback requires a
compatible known provider Version and exact policy/authority closure; it does
not reverse durable admission history or authorize an ingress/key change.

Live acceptance still requires authorized publication, exact configuration and
identity readback, software-update reconciliation of selected already-positive
heads, preserved absent/inactive heads and unrelated Spaces, and normal
application lifecycle verification. Portable tests do not establish that live
acceptance.
