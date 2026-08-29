# Takoserver deploy surfaces

This repository owns one deploy entrypoint and eleven separate mutation surfaces.
The contract is read-only:

```sh
bun run deploy -- --contract
```

Every routine status or apply invocation has exactly this shape:

```sh
bun run deploy -- <surface> --status --environment=<integration|rehearsal|production> --commit=<40-hex-sha>
bun run deploy -- <surface> --apply --environment=<integration|rehearsal|production> --commit=<40-hex-sha>
```

One bootstrap exception exists for an already deployed integration Worker whose
Version predates canonical artifact annotations. Only
`takoserver-worker-authority-cutover` with `--environment=integration` may add
`--legacy-predecessor-version=<uuid>`. The UUID must equal the authoritative
current Version immediately before upload, all binding/config/secret/domain and
migration closure remains strict, and an independent reviewer is required. A
missing or malformed annotation is reported as
`legacy-unattributed-predecessor` with `authorityScope` set to the entire Worker
artifact; no predecessor source diff is invented. Routine Worker, rehearsal,
and production invocations never accept this selector.

The environment selects only `.deploy/targets/<environment>.json` (or the
matching absolute `TAKOSERVER_DEPLOY_TARGET_<ENVIRONMENT>` path). There is no
target flag, mixed preflight/apply controller, plan, evidence ledger, journal,
capability, or implied deploy authority.

## Surfaces

The routine surfaces are:

- `takoserver-worker`: one Worker code upload. It refuses pending D1
  migrations, any config/secret/signing/topology drift, and any selected diff
  that changes authentication, authorization, or the deploy mechanism.
- `takoserver-site`: one Pages upload and byte-exact immutable URL readback;
  production also requires byte-exact `https://takoserver.com/` readback.
- `takoserver-console`: one Console Worker upload. Exhaustive domain state must
  already name `takoserver-console` as owner and must be unchanged afterward.

The separate authority and irreversible surfaces are:

- `takoserver-worker-authority-cutover`: reviewed publication of
  authority-sensitive Worker code only.
- `takoserver-d1-schema`: ordered, forward-only D1 migration apply and exact
  post-lineage/schema-shape readback.
- `takoserver-signing-key-register`: append-only public Ed25519 JWK registration
  with exact absence recheck and no overwrite.
- `takoserver-signing-repair`: the current, already registered key only; an
  owned `0600` private JWK proves the exact D1 public half before stdin-only
  secret repair.
- `takoserver-signing-rotation`: explicit different current and next ids; both
  must already be registered, neither row is overwritten, and the identical
  Worker code is uploaded with the next id and private secret together.
- `takoserver-hosted-token-cutover`: while Hosted topology is absent, puts only
  the Hosted bearer and proves the authenticated sponsorship route returns a
  credential signed by the current D1 key. Before topology cutover its reversal
  is explicit deletion of that newly added named secret.
- `takoserver-hosted-topology-cutover`: after that token proof, uploads identical
  Worker code with only the exact Hosted service and entrypoint binding added.
- `takoserver-integration-operator-identity`: integration only. It rebuilds the
  already served commit once, requires the exact served bundle digest, and
  uploads one immutable Worker Version that adds only the target's canonical
  public Ed25519 `OPERATOR_IDENTITY_PUBLIC_JWK` variable. Every other variable, binding,
  secret name/type, domain, D1/R2 identity, and Hosted topology must remain
  exact. It never writes a credential to D1 and never enables the separate
  wallet-funding authority retained by the legacy `OPERATOR_PUBLIC_JWK`.
  A live Worker carrying that legacy funding binding is refused as unrelated
  authority; replacing or removing it requires its own reviewed transition.

The intended forward order is schema, public-key registration, any required
authority-sensitive Worker code, signing repair or explicit rotation, Hosted
token, then Hosted topology. Status must show the required predecessor state
before each apply. Registration, topology, and schema are forward-repair only.

The operator-identity surface is deliberately outside that production order.
Its invocation parser accepts only `--environment=integration`; rehearsal and
production are refused before a target descriptor is opened. Its status path
is read-only and reports the desired public-JWK digest, whether that exact
variable is already configured, the served Version, and readiness without
reading the private key or requiring review evidence.

## Source, artifacts, and readback

The selected commit must equal HEAD. Routine integration and rehearsal may use
a dirty HEAD. A high-risk rehearsal that creates production proof, and every
production operation, require clean `main` equal to freshly fetched
`origin/main`, or clean HEAD proven reachable from an exact remote ref. Routine
uploads run one scoped owner gate, build once into a fresh link-free directory,
seal the artifact and realized config, upload once, and perform authoritative
provider readback plus the surface's bounded public readback. Worker version
identity is internal deployment history, not a consumer-pinned published
identity.

Paginated Cloudflare list state is consumed exhaustively and its pagination
coordinates are mandatory. Endpoint-specific closed shapes are used for the
non-paginated Worker deployment-history envelope and secret inventory. Child
commands receive a sanitized process substrate plus only the credential
explicitly supplied for that call; ambient deploy credentials are not
inherited.

## Operator-private inputs

All target descriptors, receipts, secrets, and realized state stay outside the
tracked repository. Depending on the surface, the operator supplies:

- `CLOUDFLARE_API_TOKEN`
- `TAKOSERVER_INDEPENDENT_REVIEW`
- `TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH`
- `TAKOSERVER_SIGNING_PUBLIC_JWK_PATH`
- `TAKOSERVER_SIGNING_PRIVATE_JWK_PATH`
- `TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH`
- `TAKOSERVER_HOSTED_TOKEN_PATH`
- `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH`

Secret inputs must be owned, link-free regular files with mode `0600`. They are
sent only through stdin or an ephemeral sealed Wrangler secrets file, never as
command arguments or output. A successful task, branch, check, or review does
not authorize a deploy.

`TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` is never sent to Cloudflare. Apply opens
the link-free `0600` file without following symlinks, accepts only the exact
Ed25519 private JWK shape, and proves it against the target's public half. It
then mints a 60-second operator assertion in memory, exchanges it at
`POST /v1/sessions`, and uses the returned bearer at `GET /v1/me`. Before
success it revokes that proof bearer through `DELETE /v1/session` and requires
replay at `GET /v1/me` to return `401`; a lost delete acknowledgement is settled
by that replay rather than a blind retry. Assertion and session bytes are
redacted from both success output and diagnostics. Every later session and API
key issued through the operator identity must be revoked before a separately
reviewed identity-removal transition.

## Failure handling

Preflight failure means no target was touched. A mutation acknowledgement
failure is indeterminate: the command does not retry and the operator must run
the same surface with `--status`. A failed post-condition means the mutation
was acknowledged but must be repaired or rolled back explicitly. Routine
Worker, Console, and Pages output the immediately previous provider-history
identity; irreversible surfaces state their forward-repair boundary.

For an integration legacy Worker cutover, repeat `--status` with the same
`--legacy-predecessor-version` after an indeterminate acknowledgement. The
readback distinguishes the legacy predecessor still being current, its direct
canonical successor matching the selected commit, and a direct successor from
a different commit. An unrelated history advance or malformed successor fails
closed. The status path never retries the upload.

For an operator-identity upload acknowledgement failure, do not retry apply.
Run the same surface with `--status`: an exact configured digest means the
single-variable Version is current, while absence means the selected
predecessor remains current. Any unrelated configuration or Version advance is
refused rather than attributed to the interrupted attempt.
