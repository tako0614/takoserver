# Takoserver deploy surfaces

This repository owns one deploy entrypoint and twenty-two separate mutation surfaces.
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
`--issue`, `--status`, or `--revoke` through that same entrypoint, and the
durable organization API key surface accepts exactly one of `--mint`,
`--status`, or `--revoke`.

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

## The forward transition every Worker surface shares

Every surface that publishes a Cloudflare Worker fences its live Version
against the exact binding closure the selected commit and the operator-private
target derive. That fence is right, and it is also how a code advance strands a
Worker: when the advance itself changes a derived binding — a capability
manifest gains a Form kind, a service binding appears — the predecessor cannot
already carry the value the advance introduces, so no publication is admissible
and that Worker is stuck at the commit before the change. It is not incidental
to one commit; without a remedy, any future change to a derived closure
permanently strands whichever Workers are already live.

So there is one mechanism, not one profile per surface. These surfaces accept
it:

- `takoserver-worker-authority-cutover`
- `takoserver-form-authority-worker`
- `takoserver-integration-form-authority-worker`
- `takoserver-integration-form-authority-operator-worker`
- `takoserver-form-authority-identity-probe`

Each accepts `--closure-predecessor-version=<uuid>` together with an explicit
declaration built from the repeatable `--retire-var=NAME`, `--add-var=NAME`,
`--refresh-var=NAME`, `--add-binding=NAME`, `--add-secret=NAME` and
`--rotate-secret=NAME` flags. `--add-binding` names a binding that is not plain
text — a service, D1, R2 or Durable Object binding the current code derives and
the predecessor lacks. Code-derived values stay code-derived: the declaration
names the binding, and the value still comes from the selected commit and
target. Where nothing is declared, every surface stays exactly as strict as it
is today.

The declaration is
machine-checked: the profile admits the predecessor only when the authoritative
current Version is exactly that id, the declaration is non-empty, and it equals
the entire difference between the predecessor closure and the target closure.
Any undeclared difference refuses before mutation and names the binding.
Retired and refreshed values are the one thing left unconstrained, because the
declaration is what says the current target either no longer derives them or
derives them differently; every other binding name, type and plain-text value
and the routing closure stay as strict as the routine path.
The routine surfaces stay strict too and never accept such a predecessor.

Applying a transition still requires everything the surface required before it:
the same independent reviewer, the same source qualification, the same single
upload, and the same post-upload readback — which must show the successor at
the exact target closure with no declaration outstanding.

`--refresh-var=NAME` covers the difference that changes no binding name at all.
A corrected target descriptor often changes exactly one value, and without this
selector such a correction is unpublishable by any surface: the routine surface
refuses the predecessor for binding that value with unexpected text, and the
transition refuses the declaration for naming a var the target still derives. It
is admitted only when the predecessor declares `NAME` as plain text with a value
different from the one the target derives, and the rest of the closure still
matches the declaration; the upload then publishes the target's value. Declaring
a var whose value already matches is refused, because that is an ordinary
publication and the routine surface owns it. The routine surface's own
value-only refusal now names `--refresh-var` as the remedy.

The transition's secret inventory is the union of what the served Version
declares and what Cloudflare's script-level secret store holds. Secrets live on
the script, not on the immutable Version, so a `wrangler rollback` leaves the
store ahead: it still holds every secret a later Version installed while the
restored Version declares fewer. A secret in the store that the served Version
does not declare is carried — declared in the upload, never re-entered — and is
admitted whether or not the declaration names it under `--add-secret`. Naming it
only decides that its value is read from the secret-input directory and
re-entered, which is what a rotation is. A secret in that union that the current
target does not require at all is still refused as inventory drift.

### Exact integration commands

The integration Form-authority lane is behind the current `main` by the two
differences this mechanism exists for: the operator Space the 2026-08-30 scope
transition made authoritative, and the capability manifest that gained
`ObjectBucket`. Settle them in this order. `<sha>` is the exact reviewed commit
and must equal `HEAD`.

**1. Adopt the live operator Space into the steady descriptor.** The steady
descriptor still names the Space the transition retired, so read the difference
and write a candidate:

```sh
bun run deploy -- takoserver-integration-form-authority-worker --status \
  --environment=integration --commit=<sha> \
  --adopt-live=/root/dev/takos/.operator-private/TASK-0042-integration-cutover/takoserver-integration-target.candidate.json
```

`adoptableFromLive` names `/formAuthority/integrationOperatorScope/space`, and
`unadoptableFromLive` names the capability manifest with `--refresh-var` as its
remedy. Inspect the candidate, then move it over the steady descriptor
yourself; nothing writes it for you.

**2. Advance the route-less integration Form authority Worker.** Its live
Version `e2c68d9a-3ea3-4155-80e5-6d4da5648b7a` was published from `b10479d2`
and carries the twelve-kind manifest; `main` derives thirteen:

```sh
bun run deploy -- takoserver-integration-form-authority-worker --status \
  --environment=integration --commit=<sha> \
  --closure-predecessor-version=e2c68d9a-3ea3-4155-80e5-6d4da5648b7a \
  --refresh-var=TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST

bun run deploy -- takoserver-integration-form-authority-worker --apply \
  --environment=integration --commit=<sha> \
  --closure-predecessor-version=e2c68d9a-3ea3-4155-80e5-6d4da5648b7a \
  --refresh-var=TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST
```

Status must report `bindingTransitionProfile: declared-delta-predecessor` and
`ready: true` before the apply; the apply must read back
`bindingTransitionProfile: none`.

**3. Advance the operator gateway.** The gateway's closure carries no
capability manifest, so once step 1 has settled the Space it has no difference
left and the routine invocation publishes it:

```sh
bun run deploy -- takoserver-integration-form-authority-operator-worker --status \
  --environment=integration --commit=<sha>

bun run deploy -- takoserver-integration-form-authority-operator-worker --apply \
  --environment=integration --commit=<sha>
```

If `--status` still reports `unclassified`, read `descriptorDrift`: the gateway
surface also inspects the route-less authority it depends on, and that
dependency must already be at `exact-target` on the same commit. Should the
gateway itself ever need one, it accepts the same declaration as step 2.

**4. Give the identity probe its `FORM_AUTHORITY` binding.** Commit `5f02c65`
added a third binding to the probe's closure; live Version
`67679289-84f5-4082-b3d6-7500b59b542c` has two:

```sh
bun run deploy -- takoserver-form-authority-identity-probe --status \
  --environment=integration --commit=<sha> \
  --closure-predecessor-version=67679289-84f5-4082-b3d6-7500b59b542c \
  --add-binding=FORM_AUTHORITY

bun run deploy -- takoserver-form-authority-identity-probe --apply \
  --environment=integration --commit=<sha> \
  --closure-predecessor-version=67679289-84f5-4082-b3d6-7500b59b542c \
  --add-binding=FORM_AUTHORITY
```

That binding names `formAuthority.workerName`, which the probe does not own. If
that Worker does not exist on the account, `--status` reports
`formAuthorityWorkerPresent: false` with the remedy and `--apply` refuses
naming it: deploy `takoserver-form-authority-worker` in this environment first,
or correct `formAuthority.workerName` in the descriptor. The probe never
publishes a binding to a script that is not there.

**5. Mint the durable Hosted reservation key.** The Hosted staging release
needs a `resources:write` organization key that outlives its deploy:

```sh
bun run deploy -- takoserver-org-api-key --status \
  --environment=integration --commit=<sha> \
  --organization=org_takosumi_hosted_staging

bun run deploy -- takoserver-org-api-key --mint \
  --environment=integration --commit=<sha> \
  --organization=org_takosumi_hosted_staging \
  --key-name=takosumi-hosted-reservation \
  --scope=resources:write \
  --expires-in-days=90
```

The secret lands at
`$TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY/org_takosumi_hosted_staging.takosumi-hosted-reservation.secret`
and nowhere else; that path is what the Hosted release reads as
`TAKOSERVER_RESERVATION_API_KEY`. The result prints the exact `--revoke`
invocation that reverses it.

## Descriptor drift and adopting a live value

A steady target descriptor and the live Worker can legitimately disagree, and
the live side is sometimes the truth: a scope transition driven from a separate
descriptor leaves the steady one still naming the retired Space. Until that is
settled every Form-authority surface refuses, and the refusal used to name only
the profile that did not match.

`--status` on the Form-authority Worker surfaces and the identity probe now
reports `descriptorDrift`: one row per inspected Worker, naming its Version and
every difference between the closure the selected commit publishes and the
closure the live Version serves — missing, unexpected, wrong type, or a value
difference with both sides shown. A value longer than 200 bytes is reported as
a digest and a byte count rather than pasted, so a capability manifest stays a
comparison.

Each difference is then sorted into `adoptableFromLive` and
`unadoptableFromLive`. A value is adoptable only when a descriptor field owns
it: the Form authority Host id, the operator tenant and Space, the gateway
origin, and the Worker names the descriptor declares. Everything else is
refused by name with the remedy that fits it — a code-derived value says to
publish it with `--refresh-var`, a durable data identity says that repointing a
Host at another database is an explicit reviewed change, and a closure that
differs in shape rather than value says to declare it with `--add-binding`,
`--add-var` or `--retire-var`.

`--adopt-live=/absolute/candidate.json` (with `--status` only) writes a
candidate descriptor with exactly the adoptable values taken from live state.
It never edits the descriptor: it creates one new `0600` file at a path that
must not already exist and must stay outside every Git worktree, proves that
the result still loads as a deploy target, and prints the exact JSON-pointer
patch it applied. The operator inspects it and moves it into place. A
scope-transition invocation emits none of this and offers no adoption, because
that selector owes redaction of both scopes.

Every Worker publication, routine and cutover alike, also composes the selected
target with the Worker's own startup path before it uploads anything. A target
whose realized closure is exactly right can still fail to compose — two supply
halves that name one Cloudflare `SupplyContract` with different content are
legal plain text in their own bindings and ambiguous only when the runtime joins
them — and the Worker composes lazily on its first request, so the failure would
otherwise arrive after traffic had already moved. The refusal carries the
composition's exact words and no target is touched.

The environment selects only `.deploy/targets/<environment>.json` (or the
matching absolute `TAKOSERVER_DEPLOY_TARGET_<ENVIRONMENT>` path). There is no
target flag, mixed preflight/apply controller, deploy-plan flag, evidence
ledger, journal, capability token, or implied deploy authority.

## Environment inputs and action matrix

`requiresEnv` in `takos.deploy-contract@v2` is the conservative union of the
environment variables needed by any action supported by that surface. It does
not mean that every listed variable is read by every action. Each surface's
obligation answer names the exact action condition; `--contract` itself reads
no operator input.

| Surface | Supported action(s) | Environment | Required input condition |
| --- | --- | --- | --- |
| `takoserver-worker` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both actions. Stored Wrangler OAuth is refused because it cannot prove workers.dev enabled state or exhaustive custom-domain inventory. |
| `takoserver-worker-authority-cutover` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only; `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY` for `--apply` only, and only when the declared closure delta names an added or rotated secret. |
| `takoserver-form-authority-identity-probe` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-form-authority-worker` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority-worker` | `--status`, `--apply` | integration only | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority-operator-worker` | `--status`, `--apply` | integration only | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority` | `--status`, `--apply` | integration only | `CLOUDFLARE_API_TOKEN` and `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority-deactivation` | `--status`, `--apply` | integration only | `CLOUDFLARE_API_TOKEN` and `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-org-api-key` | `--mint`, `--status`, `--revoke` | integration, rehearsal, production | `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` and `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` for all three; `TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY` for `--mint` only; `TAKOSERVER_INDEPENDENT_REVIEW` for `--mint` and `--revoke` only. No Cloudflare credential is read. |
| `takoserver-integration-e2e-credentials` | `--issue`, `--status`, `--revoke` | integration only | `CLOUDFLARE_API_TOKEN`, `TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH`, and `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` for all three; `TAKOSERVER_INDEPENDENT_REVIEW` for `--issue` and `--revoke` only. |
| `takoserver-site` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both actions. |
| `takoserver-console` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both actions. |
| `takoserver-d1-schema` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only; `TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH` for `--apply` in rehearsal or production only. |
| `takoserver-signing-key-register` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_PUBLIC_JWK_PATH` for `--apply` only. |
| `takoserver-signing-repair` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_PRIVATE_JWK_PATH` for `--apply` only. |
| `takoserver-signing-rotation` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH` for `--apply` only. |
| `takoserver-hosted-token-cutover` | `--status`, `--apply` | integration, rehearsal, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_HOSTED_TOKEN_PATH` for `--apply` only. |
| `takoserver-host-runtime-topology-retirement` | `--status`, `--apply` | integration, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-hosted-token-retirement` | `--status`, `--apply` | integration, production | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-worker-retirement-attribution-repair` | `--status`, `--apply` | integration, production | `CLOUDFLARE_API_TOKEN` for both actions. |
| `takoserver-integration-operator-identity` | `--status`, `--apply` | integration only | `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` for `--apply` only. |

## Surfaces

The routine surfaces are:

- `takoserver-worker`: one Worker code publication. Before any live read or
  upload it composes the selected target with the Worker's own startup path and
  refuses with that composition's exact words, so a target that parses and yet
  cannot serve never reaches an upload. Every environment requires
  the explicit API-token/direct-REST path. Stored Wrangler OAuth is disabled:
  its supported readers cannot prove whether workers.dev is enabled or list an
  exhaustive custom-domain inventory, and target URL/alias declarations are
  not live proof. When the selected public origin is under workers.dev, direct
  REST must prove both the script-specific enabled state and the account-owned
  workers.dev subdomain, then require the origin hostname to equal exactly
  `<worker-name>.<account-subdomain>.workers.dev`. An arbitrary workers.dev
  suffix is refused. The exhaustive custom-domain inventory is proved
  independently. The deploy tool never extracts an OAuth credential.
  Non-production routine publication builds with the version API, uploads one
  immutable Version, re-reads the exact active deployment/Version, binding,
  secret, routing, and migration closure, and only then explicitly deploys the
  uploaded Version to 100% traffic. The realized config is topology-neutral:
  routes, custom domains, workers.dev toggles, and triggers are not sent to
  either publication command. A target-scoped Linux kernel `flock` in the
  operator host's private temporary directory serializes this owning
  publication path on that host from the final pre-mutation closure read through
  post-mutation authoritative history and public smoke. Its atomic owner
  sidecar binds the host boot id, lock-holder PID start ticks, and lock-file
  device/inode. Status reports `active`, `stale-reclaimable`, `available`, or
  `unsafe` in the ordinary routine `--status` output. A crashed holder releases
  the kernel lock; the next apply replaces its complete stale sidecar only
  while holding that lock. An active lock is
  refused, while malformed or identity-inconsistent owner state stays `unsafe`
  and is never deleted on assumption. It is not a provider lock. Cloudflare's supported deployment
  POST and Wrangler command expose no predecessor/CAS condition, so a dashboard
  action, direct API call, another owning deploy surface, or invocation on
  another host can still race the final traffic mutation. A
  failed post-upload re-read means traffic is indeterminate: this invocation
  has not started its traffic deployment, but it does not claim the uploaded
  Version is inactive or that another actor left traffic unchanged. After a
  successful traffic mutation, authoritative history must identify the exact
  uploaded Version and deployment; its actual immediate predecessor, not the
  earlier observation, is printed as the rollback target. A concurrent
  deployment observed by that readback fails verification instead of triggering
  an automatic restore. An external advance after the point-in-time history
  read is not fenced by the host lease and may remain undetected when its public
  behavior also passes the smoke. Strict publication JSON, the exact
  discovery/OpenAPI public smoke, and that readback must all pass. It
  refuses pending D1 migrations, any config/secret/signing drift, and any
  selected diff that changes authentication, authorization, the deploy
  mechanism, or any executable dependency in the build-derived public Form
  payload/identity closure. The latter closure is derived from the real P/I
  build roots rather than maintained as a provider/handler filename regex.
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
  Its named closure-transition profile is the only way to bring a live Version
  forward after the operator-private target descriptor legitimately changes
  shape. Apply performs exactly one upload of the complete current closure: the
  target plain-text vars exactly as the routine surface produces them, every
  required secret, and the same authoritative readback, annotation, closure and
  public product probe the cutover already performs. Added and rotated secret
  values arrive only through the owned `0700`
  `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY`, are sent only as one ephemeral
  sealed Wrangler secrets file beside the sealed bundle, and never enter
  command arguments, the child environment, success output or diagnostics.
  Every other secret already on the live Version is carried, never re-entered.
  The result records the predecessor Version id and the exact declared delta.
  A raw `wrangler secret put` is not a substitute: it creates a `secret`-annotated
  successor whose non-canonical annotation inventory the ordinary inspectors
  then refuse.

  For the current integration Worker — retire
  `TAKOSERVER_STANDARD_SERVICE_SUPPLIES`, add
  `TAKOSERVER_OBJECT_BUCKET_SUPPLIES`, publish the corrected
  `TAKOSERVER_EDGE_SUPPLIES` value, add the
  `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` secret and replace the revoked
  `CLOUDFLARE_API_TOKEN` provisioner credential — the exact commands are:

  ```sh
  bun run deploy -- takoserver-worker-authority-cutover --status \
    --environment=integration --commit=<40-hex-sha> \
    --closure-predecessor-version=2bb7b9d3-7ac7-4df3-ad50-15bcaa67a5b6 \
    --retire-var=TAKOSERVER_STANDARD_SERVICE_SUPPLIES \
    --add-var=TAKOSERVER_OBJECT_BUCKET_SUPPLIES \
    --refresh-var=TAKOSERVER_EDGE_SUPPLIES \
    --add-secret=TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING \
    --rotate-secret=CLOUDFLARE_API_TOKEN

  bun run deploy -- takoserver-worker-authority-cutover --apply \
    --environment=integration --commit=<40-hex-sha> \
    --closure-predecessor-version=2bb7b9d3-7ac7-4df3-ad50-15bcaa67a5b6 \
    --retire-var=TAKOSERVER_STANDARD_SERVICE_SUPPLIES \
    --add-var=TAKOSERVER_OBJECT_BUCKET_SUPPLIES \
    --refresh-var=TAKOSERVER_EDGE_SUPPLIES \
    --add-secret=TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING \
    --rotate-secret=CLOUDFLARE_API_TOKEN
  ```

  That predecessor is the Version a `wrangler rollback` restored after the
  ambiguous-`SupplyContract` incident, so the run exercises all three rules at
  once: the corrected `TAKOSERVER_EDGE_SUPPLIES` value travels as a refresh, the
  seal keyring and the rotated provisioner token are already in the script-level
  store and are admitted from there, and the corrected descriptor is composed
  before anything is uploaded. Replace `<40-hex-sha>` with the exact reviewed
  commit; the predecessor UUID must still be the authoritative current Version.

  `--status` reports the delta it would apply and mutates nothing. `--apply`
  additionally requires `TAKOSERVER_INDEPENDENT_REVIEW` and reads
  `$TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY/TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING`
  and `$TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY/CLOUDFLARE_API_TOKEN`.
- `takoserver-form-authority-identity-probe`: one reviewed minimal read-only
  Worker upload in every Form-authority environment. Its permanent target-owned
  workers.dev endpoint exposes only `GET /v1/public-host-identity`, backed by a
  named service binding to the public Worker's identity RPC. It has no storage,
  secret, mutation RPC, custom domain, preview, or zone route. Status is ready
  only after actively calling that RPC bridge and matching Host id, served
  Version, outer artifact `A`, payload `P`, capability, and semantic `I`.
- `takoserver-form-authority-worker`: one reviewed route-less service-binding
  RPC Worker upload. Exact D1/R2 and identity bindings are read back with no
  secret or public-domain, zone-route, workers.dev, or preview ownership. The
  default export has a non-operational `fetch` handler that always returns
  `404` only to satisfy Cloudflare’s module registration requirement; the named
  RPC entrypoint remains pure RPC and has no public route. The
  served public Worker artifact is rebuilt from the same commit and must match
  byte-for-byte before upload. The immutable authority config carries no
  public Worker Version or artifact pins; its public identity service binding
  reads authoritative `PublicHostIdentity@v2` on every operation. Its Form
  `apply` remains fail-closed until
  released Form package verification exists. Released Core supplies verification
  facts only; Takoserver Host retains admission policy and private handle
  issuance. Deploying the shell does not grant Form mutation authority.
- `takoserver-integration-form-authority-worker`: integration only. It packages
  the exact generated 13-Form unsigned fixture corpus, hard-refuses any other
  environment before binding reads, and remains permanently non-production.
  Its default export has a non-operational `fetch` handler that always returns
  `404` only to satisfy Cloudflare’s module registration requirement; its named
  RPC entrypoint remains pure RPC and has no public route or privileged
  publisher branch. Form execution and partial convergence are described in
  [form-authority.md](form-authority.md). The public integration Worker embeds
  `P`/capability/`I` during its two-stage build; this route-less Worker receives
  the same code-derived capability manifest and verifies it against the
  live identity RPC.
  A one-time deploy migration accepts only a fully verified legacy exact public
  identity pin, regardless of its position in public deployment history, and
  removes both pins in one upload. Its optional scope-transition selector
  accepts only the exact configured scope predecessor, uploads the target scope
  once, and refuses stale identity proof, third-scope, absent/bootstrap,
  history-based roll-forward, and already-target apply.
- `takoserver-integration-form-authority-operator-worker`: integration only.
  It owns only the dedicated custom domain
  `https://form-authority.integration.takoserver.com`, with workers.dev and
  previews disabled. It has service bindings to the route-less integration
  authority and the public Host identity RPC, but no D1/R2 bindings and no
  customer routes. Each POST to `/v1/plan`, `/v1/apply`, or `/v1/readback`
  requires exact `application/json`, a bounded body, and a short-lived Ed25519
  proof bound to method, path, canonical body digest, environment, Host id,
  public Worker artifact digest, public Worker Version, and implementation
  digest. The public key is
  target-owned and dedicated to this purpose; its private half remains
  operator-private. The gateway forwards the original signed request envelope;
  the route-less authority independently verifies the same proof against its
  own sealed copy of that key before any D1/R2 read. The exact target-owned
  tenant and Space are also sealed independently into both Workers; each
  rejects every signed plan/apply/readback activation outside that scope before
  its RPC or storage boundary. Both Workers read the live v2 public Host
  identity; the route-less endpoint checks it again before each operation, and
  apply checks again after verification plus Host policy and immediately before
  every durable command. A clean first deployment is allowed only when
  both the gateway script and configured custom domain are absent. Foreign
  ownership and every script/domain partial topology are refused, and a
  successful upload must pass the normal exact post-upload readback. During a
  scope transition the route-less authority must be `exact-target` before the
  gateway may upload once from `exact-transition-predecessor` to
  `exact-target`.
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
  mode, repair, or reverse flag. Status/apply/status proves all exact 13
  durable activation heads are absent or inactive. It uses the same v2 signed
  request/plan/apply/readback protocol and the same no-retry/credential
  redaction rules. With the named transition descriptor it requires both live
  Workers to have a verified dynamic or legacy exact identity profile and
  `exact-transition-predecessor` scope, refuses mixed topology, and signs only
  the descriptor predecessor. Normal activation never accepts that selector.
- `takoserver-integration-e2e-credentials`: integration only. Its distinct
  `--issue`, `--status`, and `--revoke` actions exhaustively read the immutable
  current public Worker Version and exact JIT binding closure before the owner
  writes a temporary `0600` target snapshot and invokes its internal helper
  once. The downstream E2E orchestrator issues and revokes a fresh 3600-second
  pair around each product run for the fixed
  organization: a `resources:write` writer and a distinct `resources:read`
  external-evidence key. Status performs signed exact-operation readback;
  revoke settles both deterministic ids and requires a separately signed
  terminal-absence readback before deleting the two secret files and their
  metadata. The evidence secret never enters a Provider or runner. Neither
  private JWK nor API-key bytes enter Worker configuration, argv, owner output,
  or diagnostics.
- `takoserver-org-api-key`: the durable organization API key. It proves the
  owned `0600` operator Ed25519 private half against the target's declared
  `operatorIdentity.publicJwk`, signs one 60-second sign-in assertion for the
  identity named in the operator-private
  `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` descriptor, exchanges it for
  the same owner session the console uses, and calls the same
  `POST /v1/organizations/{id}/api-keys` route. The key is therefore recorded
  exactly where an interactive owner's key is recorded: the console lists it,
  the console can revoke it, and this surface's own `--status` and `--revoke`
  read and settle the same rows. Expiry is always declared through
  `--expires-in-days` and bounded to 730; an unbounded organization API key is
  refused. `--mint` refuses a second unrevoked key with the same name and an
  existing secret file for that name before any mutation, writes the one-time
  secret to a new `0600` file under the exact owned `0700`
  `TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY`, and then requires the exact minted
  id, name and expiry to be listed. Every action revokes its proof session and
  proves that revocation by replay. The surface accepts all three environments;
  it requires the target to declare `operatorIdentity`, which is an
  integration-only target field today, so rehearsal and production refuse on
  the descriptor's own rule until that operator authority is extended.
- `takoserver-d1-schema`: ordered, forward-only D1 migration apply and exact
  post-lineage/schema-shape readback.
- `takoserver-signing-key-register`: append-only public Ed25519 JWK registration
  with exact absence recheck and no overwrite.
- `takoserver-signing-repair`: the current, already registered key only; an
  owned `0600` private JWK proves the exact D1 public half before stdin-only
  secret repair.
- `takoserver-signing-rotation`: explicit different current and next ids; both
  must already be registered, neither row is overwritten, and the identical
  Worker code is uploaded with the next id and private secret together. A
  canonical sponsored current-key Version follows this ordinary strict path;
  secret presence does not select a bridge. Only integration may select the
  exact `workers/triggered_by=secret` H profile. Annotation classification is
  exhaustive: an exact canonical inventory uses the ordinary path, the exact H
  inventory uses the integration bridge, and every mixed or unknown inventory
  fails status/apply before build or upload. H status remains `ready: false` and
  `repairRequired: true`, while `rotationApplyReady` states whether the selected
  commit is qualified for the one H→S apply. All deployment-history entries must
  have valid shapes, UUID Version IDs, unique deployment IDs, and one 100 percent
  Version. Older rollback reuse of a Version is valid outside the inferred
  transition, while the C→H or C→H→S prefix itself must contain unique Versions.
- `takoserver-hosted-token-cutover`: while Hosted topology is absent, puts only
  the Hosted bearer and proves the authenticated sponsorship route returns a
  credential signed by the current D1 key. Fresh C→H apply is temporary and
  integration-only. Rehearsal and production may inspect canonical pre-token C,
  but status reports `cutoverApplyReady: false` and `ready: false`; apply refuses
  immediately after the minimal Worker-state classification, before source,
  reviewer, token-file, D1-row, proof-tenant, secret mutation, or HTTP-proof work.
  Cloudflare may create an unannotated successor when the secret is added. The
  temporary integration transition accepts that H Version only when it is the
  exact direct successor of canonical C: C's exact annotation inventory
  (`workers/message` plus `workers/triggered_by=version_upload`) supplies the
  selected commit/digest, C's closure is exact without the named secret, H's
  annotation inventory is exactly `workers/triggered_by=secret`, C/H
  `resources.script.etag` values match, and the secret/domain inventory plus
  deployment history are exact and stable. The trigger marker alone is not
  provenance. Rehearsal and production reject H for both status and apply,
  including when the D1 row is canonical, without secret mutation or functional
  proof. A canonically annotated token-present Version remains on the ordinary
  strict status path; secret presence alone never selects the bridge. That
  standalone status remains conservative (`functionalProofPending: true`,
  `ready: false`) and reports `proofApplyReady` only when the selected commit
  equals the exact source-independent live commit.
  When that exact canonical token-present Version is current, `--apply` is a
  proof-only path in integration, rehearsal, and production. It performs no
  secret put/delete, build, dry-run, Worker upload, or provider configuration
  mutation, and it writes no D1 proof ledger. The path qualifies the exact
  local commit plus remote reachability; rehearsal and production use the
  production-strength clean/source qualification. It then requires the
  independent reviewer, reads the owned `0600` Hosted token, and validates the
  exact active current D1 signing row and one stable proof tenant.
  Immediately before the first secret put, apply re-reads exact C
  deployment/version/predecessor, commit, digest, script etag,
  binding/secret/domain closure, the byte-identical D1 row, and the stable proof
  tenant. Status reports H as unattributed and repair-required. Recovery first
  qualifies the exact local/remote source commit and independent reviewer, then
  proves sponsorship without another secret put. Both first apply and recovery
  finish by re-reading exact H closure/history/secret/domain inventory and the
  D1 row after proof.
  Immediately before canonical proof-only HTTP, apply re-reads the exact
  canonical Version/history, commit, digest, script etag,
  binding/secret/domain closure, the byte-identical D1 row, and the stable
  tenant. The one bounded sponsorship response must carry the exact current
  `kid`, claims and lifetime and verify under that row. Apply then re-reads the
  final canonical closure/history and exact D1 row and fails on any drift. Its
  sanitized receipt includes the version, commit, artifact digest, reviewer,
  key id, public-JWK digest, tenant reference, and lifetime, with
  `mutationApplied: false`, `functionalProofPending: false`,
  `repairRequired: false`, and `ready: true`.
  Before topology cutover its reversal is explicit deletion of that newly added
  named secret. Canonical proof-only apply has no mutation to reverse.
- `takoserver-host-runtime-topology-retirement`: C→T transition. It uploads a
  byte-identical candidate Worker exactly once, removes only the observed
  `HOST_RUNTIME_MATERIALIZER` binding, retains the Hosted secret, and proves the
  direct successor. `--reverse` redeploys that exact provider-history Version.
- `takoserver-hosted-token-retirement`: T→R transition. It deletes only
  `TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN` after topology retirement and verifies
  an exact direct-successor Worker Version with unchanged code identity. If the
  provider-created R has no exact canonical annotation inventory
  (`workers/message` plus `workers/triggered_by=version_upload`), status reports
  `token-retired-unattributed-successor` with `ready: false` and
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
For the temporary integration Hosted transition, signing rotation is the sole
attribution repair: it accepts the exact C→H bridge and performs one canonical
H→S `deploy --secrets-file` upload, with no classic secret put/delete or second
mutation, and proves C→H→S with the same script identity and byte-identical D1
rows. Rehearsal, production, and ordinary signing paths remain canonical-strict.
This is a temporary integration-only bridge, not a generalized compatibility
layer; remove it after the integration Worker has completed canonical cutover.
Status must show the required direct predecessor state before each apply. The
authority and topology retirement surfaces expose their documented reversals;
token retirement and attribution repair are forward-only and restoration
requires a separately reviewed dedicated surface. There is no automatic
fallback or raw Wrangler reversal.

For the reviewed Form integration cutover, first deploy the public integration
Worker through the owning `bun run deploy` entrypoint so it exposes
the complete build-derived `PublicHostIdentity@v2`. Deploy and verify
`takoserver-form-authority-identity-probe` next. Migrate the
route-less authority from a verified legacy exact pin to `dynamic-public-rpc`,
then migrate the gateway after that dependency is dynamic; use status/apply/status
for each and do not sign a live request until the probe and both authority
surfaces are ready. Then capture the
old exact tenant/Space scope and write the strict operator-private transition descriptor.
The descriptor keeps that predecessor outside the steady target and binds the
exact Host plus the target's new scope. After the target names that new scope,
use the descriptor for deactivation status/apply/status while both Workers are
still predecessor, then advance the route-less authority once, then the gateway
once. Remove the selector for normal target-scope activation, cut over
consumers, and finally clean retained packages. Inactive activation leaves
retained delete/observe available through the Host projection; no raw D1 is
used. Rollback is an explicit normal reactivation append, never a
Worker-version rollback. The exact descriptor schema and command order are in
[form-authority.md](form-authority.md).

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
uploads run one scoped owner gate, build into a fresh link-free directory,
seal the artifact and realized config, upload once, and perform authoritative
provider readback plus the surface's bounded public readback. Worker version
identity is internal deployment history, not a consumer-pinned published
identity.

For a target that advertises Form authority, public Worker construction first
builds and seals a separate target-neutral handler/provider payload `P`. It
derives `I` from `P`, the adapter/capability manifest, and the exact admitted
Form package/operation set, embeds `P`/capability/`I` into the outer Worker, and
only then hashes final artifact `A`. Unrelated outer bytes may rotate `A`
without rotating `I`; handler/provider, capability, Form package, or admitted
operation changes rotate `I`. `P` and `I` have no operator override or runtime
source scan, and all three supported environments realize `A` plus the embedded
semantic identity.

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

A target that declares `formAuthority` must declare distinct
`identityProbeWorkerName` and its exact matching bare workers.dev
`identityProbeOrigin`. They select the owned read-only RPC bridge topology, not
payload or implementation digests; `P` and `I` remain build-derived.

- `CLOUDFLARE_API_TOKEN`
- `TAKOSERVER_INDEPENDENT_REVIEW`
- `TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH`
- `TAKOSERVER_SIGNING_PUBLIC_JWK_PATH`
- `TAKOSERVER_SIGNING_PRIVATE_JWK_PATH`
- `TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH`
- `TAKOSERVER_HOSTED_TOKEN_PATH`
- `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH`
- `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY`
- `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH`
- `--form-authority-scope-transition=/absolute/operator-private/transition.json`
- `TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH`
- `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY`
- `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH`
- `TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY`
- `--adopt-live=/absolute/operator-private/candidate.json`

The Form authority surfaces must read the exhaustive account Worker script,
domain, subdomain, secret, Version, zone, and Worker-route inventories before
claiming route-less closure. Their Cloudflare token therefore needs the
corresponding account Workers Scripts access plus Zone Read and Workers Routes
Read for every zone in the selected account; a narrower token fails closed.

Secret inputs must be owned, link-free regular files with mode `0600`. They are
sent only through stdin or an ephemeral sealed Wrangler secrets file, never as
command arguments or output. A successful task, branch, check, or review does
not authorize a deploy.

`TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY` is an owned, exact-`0700`,
link-free absolute directory holding one such `0600` file per declared secret,
named exactly as the binding. It is read only by a closure-transition `--apply`
whose declaration names an added or rotated secret, only for those names, and
its contents are written straight into the sealed secrets file beside the
bundle.

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

The Form-authority scope-transition descriptor is not a steady target field.
It is an owned, link-free exact-`0600` strict JSON file no larger than 16 KiB,
selected only by an absolute CLI path whose every ancestor is symlink-free. Its
immediate parent must be an owned exact-`0700` directory outside every Git
worktree; special mode bits are refused. Its exact v1 shape contains the
integration Host, predecessor scope, and exact target scope, with no optional
or secret fields. Success output contains only its canonical digest, binding
profile, and scope-redacted boolean/digest summaries; refusal details never
echo the predecessor, a foreign observed scope, or raw binding JSON. The path
is never emitted. The selector is accepted only by integration deactivation and
the two integration Form-authority Worker surfaces.

`TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` is an owned, link-free
exact-`0600` strict JSON file of at most 16 KiB holding exactly
`takoserver.operator-sign-in-identity@v1` with `provider`, `subject`, `email`
and `displayName`. It is deliberately not a target field: the descriptor
already pins which key may sign, and the person behind that key is
operator-private. `TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY` is an owned
exact-`0700` link-free absolute directory outside every Git worktree; `--mint`
creates exactly one `0600` `<organization>.<key-name>.secret` file inside it
and never overwrites one.

### Where each Worker credential comes from

A credential with no minting surface is a credential someone pastes out of a
browser, so each one says where it comes from.

- `TAKOSERVER_RESERVATION_API_KEY` (Hosted) — a Takoserver organization API key
  for the named organization, scoped `resources:write`. Minted durably by
  `takoserver-org-api-key --mint`. The integration JIT pair from
  `takoserver-integration-e2e-credentials` is a one-hour smoke credential and
  is never a Worker secret: a release installed with it starts returning `401`
  an hour later.
- `TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN` — **operator-supplied, not
  Takoserver-issued.** Nothing in this repository mints it and nothing should:
  it is the private bearer the operator chooses for the sponsorship owner API.
  `takoserver-hosted-token-cutover` is its install and proof surface — it reads
  the operator's own value from the owned `0600` `TAKOSERVER_HOSTED_TOKEN_PATH`
  and proves the authenticated sponsorship route answers with a credential
  signed by the current D1 key. `takoserver-hosted-token-retirement` removes
  it. Rotation is another `takoserver-hosted-token-cutover` apply with a new
  value in that file.
- `TAKOSERVER_SIGNING_KEY` — registered by `takoserver-signing-key-register`,
  repaired by `takoserver-signing-repair`, rotated by
  `takoserver-signing-rotation`.
- `CLOUDFLARE_API_TOKEN` and `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` (Worker
  bindings) — operator-supplied, installed and rotated through
  `takoserver-worker-authority-cutover`'s `--add-secret` / `--rotate-secret`
  declaration out of `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY`.

`TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH` is a third, dedicated
operator-private Ed25519 key. The target stores only its public half and the
fixed integration organization. It must not be the current runtime-grant
signing key: the owner proves that against the active canonical public JWK in
D1 before upload or credential mutation, and the Worker independently checks
the configured private signing key at startup. The credential surface proves
the JIT private half against its target, keeps it outside Cloudflare, and writes
the two issued secrets plus nonsecret pair-recovery metadata only to the existing
link-free `0700` `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` as three separate
`0600` files. See
[integration-e2e-credentials.md](integration-e2e-credentials.md).

## Failure handling

Preflight failure means no target was touched. Once traffic deployment is
acknowledged, every authoritative Cloudflare/closure inspection failure is
reported in the verification phase; it must never print the preflight-only
`No target was touched` aftermath. A mutation acknowledgement
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

For a closure-transition upload acknowledgement failure, do not retry apply.
Run the same surface with `--status` and the same
`--closure-predecessor-version` and declaration. The pinned predecessor still
being current means the upload never landed; its exact direct successor with
the strict target closure means the transition completed. Any other history
advance fails closed and is never attributed to the interrupted attempt.

After an explicit `wrangler rollback`, the restored Version is a usable
predecessor again. The script-level secret store is left ahead of it — it still
holds every secret the rolled-back Version installed — and the transition reads
the union of the two, so those secrets are carried rather than demanded. Name
one under `--add-secret` only when its value should be re-entered from the
secret-input directory. The status output reports both sets: `carriedSecrets` is
everything this upload does not re-enter, and `carriedStoreSecrets` is the part
of it the served Version does not itself declare.

A Worker that cannot start answers `503 backend_unavailable` on every route,
including `/healthz` and `/.well-known/takoserver`, with `details.reason` naming
the class — `public-origin`, `supply-composition`, `runtime-configuration` or
`unavailable` — and the product's own refusal sentence as the message. Startup
is lazy and only its success is cached, so a repaired target serves on the next
request without a redeploy. The routine and cutover surfaces compose the target
before uploading, so this state should be reachable only through a change made
outside them.

For an operator-identity upload acknowledgement failure, do not retry apply.
Run the same surface with `--status`: an exact configured digest means the
single-variable Version is current, while absence means the selected
predecessor remains current. Any unrelated configuration or Version advance is
refused rather than attributed to the interrupted attempt.

For an integration credential issue failure, never replay the secret-bearing
issue. Run the credential surface with `--status`; it validates the sealed pair
metadata and sends one signed readback for the exact deterministic operation and
both role ids. A signed `revoking` state may be settled by an exact idempotent
revoke followed by another signed status; this does not issue a new pair. Status
and revoke use the current dedicated authority even when issuance provenance
names an older Worker Version. Wrong organization, partial bindings, key reuse,
selected/live source or artifact mismatch, and active D1 runtime-signing
identity drift fail before the helper is invoked.

For a post-token attribution repair acknowledgement failure, do not retry apply.
Run the same repair surface with both pinned selectors and `--status`: only the
exact A direct successor of the selected R, with canonical commit/digest, exact
`resources.script.etag` equality to T, closure, and public probe, settles the
attempt. An R that remains current is still
`token-retired-unattributed-successor`; any unrelated history advance or
weak/missing script identity fails closed.

For a Worker forward-transition acknowledgement failure on any surface, do not
retry apply. Run the same surface with `--status` and the same
`--closure-predecessor-version` and declaration. The Form-authority surfaces
and the identity probe settle it the same way the public Worker does: the
pinned predecessor still being current means the upload never landed, and the
exact successor at the strict target closure means the transition completed.
A `--status` that reports `unclassified` with a `descriptorDrift` row is the
readback, not a failure: it names every difference the declaration would have
to account for.

For a durable organization API key mint or revoke acknowledgement failure, do
not retry. Run `takoserver-org-api-key --status --organization=<id>`: it lists
the organization's unrevoked keys. A key listed with the requested name and no
secret file on disk is a mint whose secret is unrecoverable; revoke it through
this surface with its exact `--key-id` and mint again. The surface refuses a
second unrevoked key with the same name and an existing secret file for that
name before any mutation, so this state cannot be entered twice by accident.
Its proof session is always revoked and its death proved by replay; a replay
that does not return `401` is a verification failure, never a retry.

For a Form deactivation acknowledgement failure, do not retry apply. Run the
deactivation surface with `--status` and require its exact 13-head
absent-or-inactive proof before any fresh decision. A Worker rollback cannot
reverse the append-only activation event; use the normal activation surface
for explicit reactivation. When a transition descriptor selected the
predecessor, repeat status with that same descriptor; it never converts a mixed
or already-advanced Worker topology into permission to sign another mutation.
