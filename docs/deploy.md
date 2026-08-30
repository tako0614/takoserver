# Takoserver deploy surfaces

This repository owns one deploy entrypoint and nineteen separate mutation surfaces.
The contract is read-only:

```sh
bun run deploy -- --contract
```

Every routine status or apply invocation has exactly this shape:

```sh
bun run deploy -- <surface> --status --environment=<integration|rehearsal|production> --commit=<40-hex-sha>
bun run deploy -- <surface> --apply --environment=<integration|rehearsal|production> --commit=<40-hex-sha>
```

The integration JIT credential authority instead accepts exactly one of
`--issue`, `--status`, or `--revoke` through that same entrypoint.

One bootstrap exception exists for the already deployed integration Worker whose
Version predates the `WORKER_VERSION`
metadata binding. Only
`takoserver-worker-authority-cutover` with `--environment=integration` may add
`--legacy-predecessor-version=<uuid>`. The UUID must equal the authoritative
current Version immediately before upload. The predecessor must match the exact
known pre-version-metadata closure: `WORKER_VERSION` is required to be absent,
while every other binding/config/secret/domain and migration check remains
strict. The direct successor must add the binding and match the full current
closure. A canonical predecessor commit and artifact digest remain attributed
and are rechecked immediately before upload; binding generation does not alter
artifact identity. An independent reviewer is required. A missing or malformed
annotation is reported as `legacy-unattributed-predecessor` with
`authorityScope` set to the entire Worker artifact; no predecessor source diff
is invented. Routine Worker, rehearsal, and production invocations never accept
this selector; the named Hosted-edge authority transition is the sole reviewed
exception and accepts it in integration or production only with an exact pinned
predecessor, clean/reachable commit and independent review.

Legacy Hosted-edge retirement is a separately reviewed L→C→T→R sequence. The
authority surface accepts `--legacy-host-runtime-predecessor-version=<uuid>` to
publish candidate code while preserving exactly the observed
`HOST_RUNTIME_MATERIALIZER` service binding and
`TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN`. Ordinary target realization never carries
either retired field. Retirement applies perform one provider mutation followed
by authoritative readback; an acknowledgement loss is settled by `--status`,
never by a blind retry. `--reverse` is accepted only by the authority and
topology retirement surfaces. Secret deletion can create an unannotated direct successor; that state
is never reported as complete and is repaired only through the dedicated
post-token attribution surface below.

The environment selects only `.deploy/targets/<environment>.json` (or the
matching absolute `TAKOSERVER_DEPLOY_TARGET_<ENVIRONMENT>` path). There is no
target flag, mixed preflight/apply controller, deploy-plan flag, evidence
ledger, journal, capability token, or implied deploy authority.

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
  authority-sensitive Worker code and exact owned configuration. Integration
  may add only the complete JIT credential-authority profile: environment,
  dedicated public JWK, fixed `org_takosumi_hosted_staging` organization,
  selected source commit, and built artifact digest. The profile is all or
  none, and the public key must differ from every login, funding, Form, and
  other target authority key as well as the authoritative active D1
  runtime-grant signing key. Its named legacy-edge transition
  profile is the only way to carry an observed Hosted service binding and
  secret into the candidate predecessor state.
- `takoserver-form-authority-worker`: one reviewed route-less service-binding
  RPC Worker upload. Exact D1/R2 and identity bindings are read back with no
  secret or public-domain, zone-route, workers.dev, or preview ownership. The
  default export has a non-operational `fetch` handler that always returns
  `404` only to satisfy Cloudflare’s module registration requirement; the named
  RPC entrypoint remains pure RPC and has no public route. The
  served public Worker artifact is rebuilt from the same commit and must match
  byte-for-byte before upload. Its Form `apply` remains fail-closed until
  released Form package verification exists. Released Core supplies verification
  facts only; Takoserver Host retains admission policy and private handle
  issuance. Deploying the shell does not grant Form mutation authority.
- `takoserver-integration-form-authority-worker`: integration only. It packages
  the exact generated 12-Form unsigned fixture corpus, hard-refuses any other
  environment before binding reads, and remains permanently non-production.
  Its default export has a non-operational `fetch` handler that always returns
  `404` only to satisfy Cloudflare’s module registration requirement; its named
  RPC entrypoint remains pure RPC and has no public route or privileged
  publisher branch. Form execution and partial convergence are described in
  [form-authority.md](form-authority.md).
- `takoserver-integration-form-authority-operator-worker`: integration only.
  It owns only the dedicated custom domain
  `https://form-authority.integration.takoserver.com`, with workers.dev and
  previews disabled. It has service bindings to the route-less integration
  authority and the public Host identity RPC, but no D1/R2 bindings and no
  customer routes. Each POST to `/v1/plan`, `/v1/apply`, or `/v1/readback`
  requires exact `application/json`, a bounded body, and a short-lived Ed25519
  proof bound to method, path, canonical body digest, environment, Host id,
  public Worker artifact digest, and public Worker Version. The public key is
  target-owned and dedicated to this purpose; its private half remains
  operator-private. The gateway forwards the original signed request envelope;
  the route-less authority independently verifies the same proof against its
  own sealed copy of that key before any D1/R2 read. The exact target-owned
  tenant and Space are also sealed independently into both Workers; each
  rejects every signed plan/apply/readback activation outside that scope before
  its RPC or storage boundary. Both Workers recheck the live public Worker
  Version, and apply checks again after verification plus Host policy and immediately
  before every durable command. A clean first deployment is allowed only when
  both the gateway script and configured custom domain are absent. Foreign
  ownership and every script/domain partial topology are refused, and a
  successful upload must pass the normal exact post-upload readback.
- `takoserver-integration-form-authority`: integration only. This owner CLI
  verifies the exhaustive gateway, route-less authority, and public Worker
  identity closure before using the dedicated private key. Status sends one
  signed readback request. Apply qualifies the exact source and reviewer,
  obtains one signed canonical plan, submits that exact plan once, and then
  performs one independently signed readback. It never calls D1/R2 directly or
  retries an HTTP mutation; a lost apply acknowledgement is indeterminate. An
  acknowledged partial apply still performs the separate readback, preserves
  only sanitized action receipts and next-plan diagnostics, and exits nonzero
  as a verification failure.
- `takoserver-integration-form-authority-deactivation`: integration only and
  separately owned from normal activation. It always signs
  `activation.desiredActive: false`, emits only inactive activation successors,
  never loads Form packages or invokes package verification, and has no free
  mode, repair, or reverse flag. Status/apply/status proves all exact 12
  durable activation heads are absent or inactive. It uses the same v2 signed
  request/plan/apply/readback protocol and the same no-retry/credential
  redaction rules.
- `takoserver-integration-e2e-credentials`: integration only. Its distinct
  `--issue`, `--status`, and `--revoke` actions exhaustively read the immutable
  current public Worker Version and exact JIT binding closure before the owner
  writes a temporary `0600` target snapshot and invokes its internal helper
  once. Issue creates one 900-second `resources:write` key for the fixed
  organization; status performs signed exact-operation readback; revoke sends
  one exact revocation and requires a separately signed absence readback before
  deleting the two owned local files. Neither private JWK nor API-key bytes
  enter Worker configuration, argv, owner output, or diagnostics.
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
- `takoserver-host-runtime-topology-retirement`: C→T transition. It uploads a
  byte-identical candidate Worker exactly once, removes only the observed
  `HOST_RUNTIME_MATERIALIZER` binding, retains the Hosted secret, and proves the
  direct successor. `--reverse` redeploys that exact provider-history Version.
- `takoserver-hosted-token-retirement`: T→R transition. It deletes only
  `TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN` after topology retirement and verifies
  an exact direct-successor Worker Version with unchanged code identity. If the
  provider-created R has no canonical `workers/message` annotation, status
  reports `token-retired-unattributed-successor` with `ready: false` and
  `repairRequired: true` rather than claiming completion. This surface is
  forward-only; restoration requires a separately reviewed dedicated surface.
  It never re-puts the retired secret, and token bytes never enter argv or output.
- `takoserver-worker-retirement-attribution-repair`: post-token R→A code
  attribution repair. It requires both exact
  `--legacy-host-runtime-predecessor-version=<uuid>` and
  `--unattributed-successor-version=<uuid>` selectors, proves the bounded
  L→C→T→R history and exact closure, and reads the Version detail
  `resources.script.etag` identity for T and R. It builds and seals the exact
  selected source once, requires the local bundle digest to equal T's canonical
  annotation (the provider etag is an opaque identity and is compared exactly,
  never treated as a local SHA-256), then performs one code upload with no
  retired service/token fields. The resulting A must be R's direct successor
  with the selected source commit and canonical digest, exactly the T script
  identity, and the existing public probe. This is a forward repair surface;
  it has no `--reverse` or secret mutation and an upload acknowledgement loss is
  settled only by status recognizing that exact A successor.
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
token cutover, authority candidate transition (L→C), topology retirement (C→T),
then token retirement (T→R). If token retirement leaves an unannotated R,
status must show that exact state before the dedicated attribution repair (R→A).
Status must show the required direct predecessor state before each apply. The
authority and topology retirement surfaces expose their documented reversals;
token retirement and attribution repair are forward-only and restoration
requires a separately reviewed dedicated surface. There is no automatic
fallback or raw Wrangler reversal.

For the reviewed Form integration cutover, first capture the old exact
tenant/Space scope with status and an operator snapshot. Apply the authority
code cutover, deploy the route-less authority and gateway at the same commit,
then run the distinct deactivation surface as status, apply, status. Only then
may the target name a new Space. Deploy route-less authority and gateway again
for that target, perform normal activation, cut over consumers, and finally
clean retained packages. Inactive activation leaves retained delete/observe
available through the Host projection; no raw D1 is used. Rollback is an
explicit normal reactivation append, never a Worker-version rollback.

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

Credential actions are pinned more tightly than routine status: the selected
commit must equal the current immutable Worker annotation, whose artifact
digest must equal the exact live source/artifact bindings. The live Version id
is owner-derived and sealed into each proof. A target snapshot, environment
value, or client payload cannot self-assert those provenance coordinates.

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
- `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH`
- `TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH`
- `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY`

The Form authority surfaces must read the exhaustive account Worker script,
domain, subdomain, secret, Version, zone, and Worker-route inventories before
claiming route-less closure. Their Cloudflare token therefore needs the
corresponding account Workers Scripts access plus Zone Read and Workers Routes
Read for every zone in the selected account; a narrower token fails closed.

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

`TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` is a separate,
operator-private Ed25519 key dedicated to the integration Form-authority
gateway. The signed invocation surface opens the link-free `0600` file, proves
its public half against the target-owned key, and keeps both the private JWK and
short-lived assertions out of output and diagnostics. The deploy target fixes
the exact integration tenant/Space activation audience; neither an environment
variable nor a request can widen that scope.

`TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH` is a third, dedicated
operator-private Ed25519 key. The target stores only its public half and the
fixed integration organization. It must not be the current runtime-grant
signing key: the owner proves that against the active canonical public JWK in
D1 before upload or credential mutation, and the Worker independently checks
the configured private signing key at startup. The credential surface proves
the JIT private half against its target, keeps it outside Cloudflare, and writes
the issued secret plus nonsecret recovery metadata only to the existing link-free `0700`
`TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` as separate `0600` files. See
[integration-e2e-credentials.md](integration-e2e-credentials.md).

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

For an integration credential issue or revoke failure, do not retry the
mutation. Run the credential surface with `--status`; it validates the sealed
metadata and sends one signed readback for the exact deterministic operation.
Wrong organization, partial bindings, key reuse, selected/live source or
artifact mismatch, active D1 runtime-signing identity drift, and a live Version
advance all fail before the helper is invoked.

For a post-token attribution repair acknowledgement failure, do not retry apply.
Run the same repair surface with both pinned selectors and `--status`: only the
exact A direct successor of the selected R, with canonical commit/digest, exact
`resources.script.etag` equality to T, closure, and public probe, settles the
attempt. An R that remains current is still
`token-retired-unattributed-successor`; any unrelated history advance or
weak/missing script identity fails closed.

For a Form deactivation acknowledgement failure, do not retry apply. Run the
deactivation surface with `--status` and require its exact 12-head
absent-or-inactive proof before any fresh decision. A Worker rollback cannot
reverse the append-only activation event; use the normal activation surface
for explicit reactivation.
