# Integration E2E credential pairs

Takoserver's single deploy owner exposes the integration-only JIT credential
pair authority as three explicit actions:

```sh
bun run deploy -- takoserver-integration-e2e-credentials --issue --environment=integration --commit=<current-live-40-hex-sha>
bun run deploy -- takoserver-integration-e2e-credentials --status --environment=integration --commit=<current-live-40-hex-sha>
bun run deploy -- takoserver-integration-e2e-credentials --revoke --environment=integration --commit=<current-live-40-hex-sha>
```

`scripts/integration-e2e-credentials.ts` is an internal delegate of that owner
surface, not a second operator entrypoint. The owner reads the immutable current
Cloudflare Worker Version and requires its annotation and exact binding closure
to prove the selected source commit, artifact digest, Version id, fixed
organization, and dedicated public authority key. It then writes a temporary
`0600` target snapshot and invokes the delegate once. Source, artifact, and
Version values come only from that readback.

The integration deploy target contains only the public half of the authority:

```json
{
  "integrationE2eCredentialAuthority": {
    "organizationId": "org_takosumi_hosted_staging",
    "publicJwk": {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "<dedicated-public-x>"
    }
  }
}
```

The Worker authority cutover publishes exactly five all-or-none plain-text
bindings: `TAKOSERVER_ENVIRONMENT=integration`, the exact public JWK, the fixed
organization id, the selected source commit, and the built Worker artifact
digest. Partial profiles, non-integration targets, a different organization,
live source/artifact/Version drift, and reuse of a login, funding, Form, or other
target authority key fail closed. The owner also reads the active runtime-grant
signing public JWK from D1 and refuses reuse. The matching JIT private JWK is
never placed in the deploy target, realized Worker configuration, Cloudflare
binding, argv, or command output.

The owner reads these operator-private values. For Cloudflare access, an
explicit `CLOUDFLARE_API_TOKEN` always wins. Integration may resolve an absent
token from the exact `wrangler auth token --json` OAuth object; its bearer is
held only by in-process direct REST readers, never logged or serialized, and
is not passed to Wrangler children (which use their stored OAuth profile). The
extractor sets `WRANGLER_WRITE_LOGS=false` to prevent Wrangler's mode-0644
debug log from persisting the bearer and passes no competing API key, email,
token variant, or unrelated secret to the child.

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Explicit read access to exhaustive live Worker deployment and immutable Version state; optional in integration when the exact Wrangler OAuth resolver is available. Rehearsal and production require it. |
| `TAKOSERVER_DEPLOY_TARGET_INTEGRATION` | Owned `0600` integration deploy-target descriptor outside the repository. |
| `TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH` | Owned, link-free `0600` Ed25519 private JWK matching the dedicated target public key. |
| `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` | Existing absolute, link-free `0700` directory outside every Git repository. |
| `TAKOSERVER_INDEPENDENT_REVIEW` | Independent reviewer required by `--issue` and `--revoke`; status is read-only. |

## Pair contract and custody

Every product E2E run gets a fresh pair for exactly
`org_takosumi_hosted_staging`, with a fixed lifetime of 3600 seconds:

| Role | Name | Exact scope | Custodian |
| --- | --- | --- | --- |
| writer | `integration-e2e-writer` | `resources:write` | Provider/Takosumi run path; write implies ordinary read compatibility |
| evidence | `integration-e2e-evidence` | `resources:read` | External evaluator only; never Provider, Takosumi runner, or OpenTofu |

The role names, scopes, organization, operation id, and two distinct key ids are
part of one owner lifecycle. Equal role secrets are rejected. Fresh-per-product
is an operator custody and sequencing invariant, not cryptographic bearer
audience authorization: the API cannot prove which product receives a bearer,
so it does not add a decorative product claim. The downstream E2E orchestrator
must issue, use, independently evaluate, and revoke one pair around each run
before starting the next. Expiry makes a key unusable but does not prove
revocation or release the live-pair fence.

Before the first remote mutation, `--issue` durably publishes the deterministic
operation coordinates to
`task-0037-integration-credential-pair.json`. The server likewise records the
operation tombstone before it can insert either key. A successful issue then
publishes two separate files:

- `task-0037-integration-writer.secret`
- `task-0037-integration-evidence.secret`

All three paths are owned, link-free, no-replace `0600` files in the existing
owned, link-free `0700` output directory. Success output contains paths and
value-free metadata, never either secret. The evidence file must be handed only
to the external evaluator; it must not be injected into the Provider or runner
environment. Status treats every dangling symlink or wrong path type as a
custody failure rather than absence. Before signed exact remote absence is
proved, an indeterminate compensation preserves every local path entry and the
operation metadata. After signed status proves either that the operation never
registered or that its revoked tombstone is terminal, cleanup unlinks each exact
leaf entry without following it and verifies all three entries are absent.

## Recovery

The durable operation is monotonic: `prepared` / `issuing` / `active` /
`partial` / `revoking` / `revoked`, with an increasing fence. Pair insertion is
one atomic D1 batch. If only one role is ever durably visible, status reports
`partial` and revoke settles the exact present member; it never reports a
complete issue. A revoke that wins before a delayed issue fences that issue so
no late live key can survive.

`--status` validates the local metadata and returns signed, value-free remote
metadata for both roles: exact names, scopes, expiry, key ids, recorded/present/
usable flags, pair state, completeness, fence, terminal state, and issuance
provenance. A historical single-key row is never interpreted as a completed or
absent pair. Any unrevoked `integration-e2e-api-key` row in the fixed
organization blocks a new pair before either new key can be issued. The current
dedicated authority may status and exactly revoke an old operation even when a
different pair owns the live slot; that direct cleanup does not create a pair
operation, disturb the live pair, or fabricate issuance provenance, so the old
operation remains explicitly indeterminate with null provenance. Migration
`0030` deliberately performs no operation-row backfill.

Issue is never replayed after a lost acknowledgement. The helper reads signed
status and, if any durable operation or member may exist, revokes the exact pair
and proves terminal absence. Revoke is idempotent. A lost revoke acknowledgement
is followed by signed status; if that status proves the exact operation already
owns a `revoking` fence, the helper resumes the exact revoke settlement once and
reads signed status again. This bounded recovery never issues another secret.
The two secrets and metadata are deleted only after status proves either exact
unregistered/no-operation absence, or `revoked` with both exact role ids absent,
no legacy key present, and a terminal tombstone.

If the public Worker or dedicated authority key changes while a pair is live,
run `--status` or `--revoke` against the current live commit and current
dedicated authority. The current authority proof may inspect and revoke the
stored exact operation ids in the fixed organization; returned provenance stays
the issuance provenance. This avoids stranding revocation on an old Worker
Version without granting the new authority a generic key-management route.

Secrets, private JWK bytes, proofs, and bearers are redacted from success output
and diagnostics. A nonzero result remains indeterminate until signed status
settles the exact durable operation.
