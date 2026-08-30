# Integration E2E credentials

Takoserver's single deploy owner exposes the integration-only JIT credential
authority as three explicit actions:

```sh
bun run deploy -- takoserver-integration-e2e-credentials --issue --environment=integration --commit=<live-40-hex-sha>
bun run deploy -- takoserver-integration-e2e-credentials --status --environment=integration --commit=<live-40-hex-sha>
bun run deploy -- takoserver-integration-e2e-credentials --revoke --environment=integration --commit=<live-40-hex-sha>
```

`scripts/integration-e2e-credentials.ts` is an internal delegate of that owner
surface, not a second operator entrypoint. The owner reads the immutable current
Cloudflare Worker Version and requires its annotation and exact binding closure
to prove the selected source commit, artifact digest, Version id, fixed
organization, and dedicated public authority key. It then writes a temporary
`0600` target snapshot and invokes the delegate once. Source, artifact, and
Version values are derived from that readback; the operator cannot supply or
override them.

The integration deploy target must contain this public-only profile:

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
target authority key fail closed. The owner also reads the exact active
runtime-grant signing public JWK from D1 and refuses reuse before an upload or
credential action, then rechecks that identity immediately before either
mutation. At Worker startup, the private runtime signing JWK must
cryptographically prove its embedded public half, which must also differ from
the JIT key. The matching JIT private JWK is never placed in the deploy target,
realized Worker configuration, Cloudflare binding, argv, or command output.

The owner reads these operator-private values:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Read access to the exhaustive live Worker deployment and immutable Version state. |
| `TAKOSERVER_DEPLOY_TARGET_INTEGRATION` | Owned `0600` integration deploy-target descriptor outside the repository. |
| `TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH` | Owned, link-free `0600` Ed25519 private JWK matching the dedicated target public key. |
| `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` | Existing absolute, link-free `0700` directory outside every Git repository. |
| `TAKOSERVER_INDEPENDENT_REVIEW` | Independent reviewer required by `--issue` and `--revoke`; status is read-only. |

`--issue` sends one proof bound to the exact method, path, body, fixed
organization, deployed source, artifact, and live Worker Version. It creates
exactly one `resources:write` API key for 900 seconds; writer authorization
includes the E2E read path, so there is no second reader credential. The secret
and nonsecret recovery metadata are published only as distinct `0600` files in
the selected custody directory. The route never signs in, creates an
organization, or exposes an ordinary owner/session authority.

`--status` validates the owned metadata and performs one freshly signed remote
readback for that deterministic operation. `--revoke` validates the same
metadata, sends one exact revoke, then performs a separately signed absence
readback before deleting the two owned local files. It never deletes the fixed
organization or unrelated keys.

Issue and revoke are never blindly retried. A nonzero mutation result is
indeterminate: run the same surface with `--status` and inspect the exact
operation before making a fresh decision. Secrets, private JWK bytes, proofs,
and bearers are redacted from success output and diagnostics.
