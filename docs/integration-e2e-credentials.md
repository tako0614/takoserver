# Integration E2E credentials

`scripts/integration-e2e-credentials.ts` is the Takoserver-owned credential
fixture helper for TASK-0037. It talks to the deployed integration Worker over
the normal owner API and never opens D1. It is deliberately separate from the
deploy entrypoint and from production credentials.

The three actions are explicit:

```sh
bun run integration:e2e:credentials -- issue
bun run integration:e2e:credentials -- status
bun run integration:e2e:credentials -- revoke
```

The command reads these operator-private environment values:

| Variable | Meaning |
| --- | --- |
| `TAKOSERVER_DEPLOY_TARGET_INTEGRATION` | Integration deploy-target descriptor path. Its `publicOrigin` is the only origin used. |
| `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` | Owned, link-free Ed25519 private JWK (`0600`) matching `operatorIdentity.publicJwk`. |
| `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` | Existing absolute, link-free directory outside every Git repository. |

`issue` signs an in-memory, ten-minute operator assertion, signs in, checks
`/v1/me`, and creates the exact `TASK-0037 Integration E2E` organization only
when it is absent. It refuses duplicate fixture organizations or API keys. It
creates one `resources:write` key and one `resources:read` key with a 3,600
second expiry. Each secret is written once to a distinct `0600` file using a
temporary file, `fsync`, and atomic no-replace publication. The JSON metadata file contains
only nonsecret IDs, scopes, timestamps, and paths. After the fixture is
complete, the temporary session is revoked and replayed to prove a denial.

Any API or file failure compensates by revoking keys created by that invocation,
proving them absent through the owner API, revoking and replay-checking the
session, and removing files it published. If an unknown create response or a
cleanup read/revoke cannot be settled, the helper reports `credential
compensation is indeterminate` instead of claiming cleanup. Do not retry
`issue` in that state: inspect the fixture organization through the owner API
and revoke any exact fixture-named key first. Secrets, assertions, and bearers
are never command arguments, output, metadata, or error text.

`revoke` reads and validates only the exact metadata it created, signs in again,
revokes those exact keys through the owner API, verifies those owned key IDs are
absent (unrelated organization keys are retained), revokes and replays the
session, then removes the three owned files. It does not delete the durable
fixture organization.
