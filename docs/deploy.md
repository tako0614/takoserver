# Takoserver deploy surfaces

This repository owns one deploy entrypoint and twenty-four separate mutation surfaces.
The contract is read-only:

```sh
bun run deploy -- --contract
```

Every routine status or apply invocation has exactly this shape:

```sh
bun run deploy -- <surface> --status --environment=<integration|rehearsal|production> --commit=<40-hex-sha>
bun run deploy -- <surface> --apply --environment=<integration|rehearsal|production> --commit=<40-hex-sha>
```

The production-shaped D1 lane is deliberately narrower. Rehearsal and
production require exactly one approved next-wave selector:

```sh
bun run deploy -- takoserver-d1-schema --status --environment=<rehearsal|production> --commit=<40-hex-sha> --through-migration=<0028|0033|0036|0043|0044>
bun run deploy -- takoserver-d1-schema --apply --environment=<rehearsal|production> --commit=<40-hex-sha> --through-migration=<0028|0033|0036|0043|0044>
```

The fixed order is 0023–0028, 0029–0033, 0034–0036, 0037–0043, then 0044. A
selector is accepted only when its predecessor is the current lineage; an
incomplete wave can resume under the same selector, but cannot skip forward.
Integration retains only the no-selector fast path for disposable cadence and
rejects every protected selector. Its output is explicitly integration-only
and it cannot write evidence accepted by rehearsal or production. The separate
`takoserver-d1-schema-rehearsal-baseline` surface is rehearsal-only, accepts no
selector, and takes only an exact empty database through the fixed 0001–0022
prefix without emitting a production rehearsal receipt.

The integration JIT credential authority instead accepts exactly one of
`--issue`, `--status`, or `--revoke` through that same entrypoint, and the
durable organization API key surface accepts exactly one of `--mint`,
`--status`, or `--revoke`.

The canonical `takoserver-operator-identity` surface accepts `--status` or
`--apply` in integration, rehearsal, and production. Every invocation names
one exact `--organization=org_...` so status and owner proof are tied to the
same organization. The former `takoserver-integration-operator-identity`
spelling remains only as an integration compatibility alias; it is refused in
rehearsal and production.

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

No other surface needs it: `takoserver-worker` shares the public Worker's
closure and its declaration is `takoserver-worker-authority-cutover`;
`takoserver-console` and `takoserver-site` fence no binding closure at all; and
`takoserver-managed-worker-gateway` already reports an inexact predecessor as
drift and publishes past it rather than refusing.

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

**4a. Publish the released-Core authority Worker, if it has none.** The probe's
`FORM_AUTHORITY` binding names `formAuthority.workerName`, and
`takoserver-form-authority-worker`'s own apply post-condition reads
`GET <identityProbeOrigin>/v1/core-verifier-identity` — a route the probe serves
only through that same binding. Each surface therefore needed the other to have
gone first. The order is declared rather than deadlocked, and only where that
Worker has no Version at all:

```sh
bun run deploy -- takoserver-form-authority-identity-probe --status \
  --environment=integration --commit=<sha>

bun run deploy -- takoserver-form-authority-worker --status \
  --environment=integration --commit=<sha>

bun run deploy -- takoserver-form-authority-worker --apply \
  --environment=integration --commit=<sha> \
  --bootstrap-verifier-bridge \
  --bootstrap-probe-predecessor-version=<probe-version-id-from-the-first-status>
```

`--status` reports `versionId: null`, `coreVerifierRpcReady: false` and
`coreVerifierBridgeRemedy` naming the whole remaining sequence. The apply
does not guess that the probe can make the next transition. Before qualification
and again at the final mutation fence, it runs the probe surface's own strict
transition inspection. The exact pinned Version must still be current, have a
canonical commit and artifact identity, and differ from the target closure only
by the missing `FORM_AUTHORITY` binding. Extra closure, a different current
Version, or drift appearing after the owner gate refuses the authority apply
with zero uploads.

The successful apply publishes the first Version with the readback deferred and
returns `verifierBridgePending: true`, `verifierBridgeNextStep`, and the admitted
`bootstrapProbePredecessorVersionId`, `bootstrapProbePredecessorCommit`, and
`bootstrapProbeArtifactDigest`. It is a first upload, so there is no Version to
roll back to and no surface deletes a Worker: its `rollback` names the forward
repair — steps 4b and 4c — instead.

Skip 4a where the Worker already exists. `--bootstrap-verifier-bridge` is
refused there by name, and it never accompanies `--closure-predecessor-version`,
`--form-authority-scope-transition` or `--adopt-live`: a first upload has no
authority predecessor to pin and no live value to adopt. It does require the
separate `--bootstrap-probe-predecessor-version`; that immutable probe Version
is the predecessor step 4b must use.

**4b. Give the identity probe its `FORM_AUTHORITY` binding.** Commit `5f02c65`
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
naming it: run step 4a first, or correct `formAuthority.workerName` in the
descriptor. The probe never publishes a binding to a script that is not there.

**4c. Prove the bridge live.** Nothing calls the lane converged until the
readback the bootstrap deferred actually answers:

```sh
bun run deploy -- takoserver-form-authority-worker --status \
  --environment=integration --commit=<sha>
```

It reports `coreVerifierRpcReady: true`, `coreVerifierAuthorityWorkerVersionId`
equal to the Version step 4a published, and `ready: true`. Every later apply of
this surface reads that same bridge as its own post-condition; the deferral
applies to the first upload alone.

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

Only the organization's owner principal may mint, so
`TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` must name that exact principal —
its `provider` and `subject`, not merely an assertion-capable pair.
`org_takosumi_hosted_staging`'s owner is a `github` principal, so its identity
file reads:

```json
{
  "kind": "takoserver.operator-sign-in-identity@v1",
  "provider": "github",
  "subject": "task0037-staging-operator",
  "email": "<the owner's address>",
  "displayName": "<the owner's name>"
}
```

The preflight names a mismatch rather than leaving one to be read out of a
status code:

- a `provider` no operator assertion can vouch for is refused before any
  request leaves, listing the providers that work (`google`, `github`);
- a Host that registers no operator-assertion verifier for the named provider
  is refused by that name — it answers `400 invalid`, never a 500, and the
  remedy is to advance the Host or name an owner it already verifies;
- an assertion-capable identity that is simply not the owner is told so, with
  the organization named, instead of arriving as a malformed readback.

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

For every Cloudflare-owned row below, an explicit `CLOUDFLARE_API_TOKEN` always
wins. In `integration`, an absent token may be resolved only from the exact
`wrangler auth token --json` object `{ "type": "oauth", "token": "..." }`.
That bearer is held in-process for direct REST readback only; it is never
logged or serialized, and Wrangler children receive no token environment and
use their stored OAuth profile. The OAuth extractor explicitly sets
`WRANGLER_WRITE_LOGS=false`, so Wrangler's mode-0644 debug log cannot persist
the bearer; its credential child-environment overlay contains no competing API
key, email, token variant, or unrelated secret. `rehearsal` and `production`
still require the explicit API token. The conservative `requiresEnv` union
remains unchanged.

| Surface | Supported action(s) | Environment | Required input condition |
| --- | --- | --- | --- |
| `takoserver-worker` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both actions: explicit `CLOUDFLARE_API_TOKEN` or integration-only Wrangler OAuth fallback; rehearsal and production require the explicit token. |
| `takoserver-worker-authority-cutover` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only; `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY` for `--apply` only, and only when the declared closure delta names an added or rotated secret. |
| `takoserver-form-authority-identity-probe` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-form-authority-worker` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority-worker` | `--status`, `--apply` | integration only | Resolved Cloudflare credential for both (explicit token, or the integration OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority-operator-worker` | `--status`, `--apply` | integration only | Resolved Cloudflare credential for both (explicit token, or the integration OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority` | `--status`, `--apply` | integration only | Resolved Cloudflare credential and `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` for both (OAuth fallback is integration-only); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority-deactivation` | `--status`, `--apply` | integration only | Resolved Cloudflare credential and `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` for both (OAuth fallback is integration-only); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-org-api-key` | `--mint`, `--status`, `--revoke` | integration, rehearsal, production | `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` and `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` for all three; `TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY` for `--mint` only; `TAKOSERVER_INDEPENDENT_REVIEW` for `--mint` and `--revoke` only. No Cloudflare credential is read. |
| `takoserver-integration-e2e-credentials` | `--issue`, `--status`, `--revoke` | integration only | Resolved Cloudflare credential, `TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH`, and `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` for all three; `TAKOSERVER_INDEPENDENT_REVIEW` for `--issue` and `--revoke` only. |
| `takoserver-site` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback). |
| `takoserver-console` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback). |
| `takoserver-d1-schema-rehearsal-baseline` | `--status`, `--apply` | rehearsal only | No selector is accepted. `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. The receipt-path input is never read. |
| `takoserver-d1-schema` | `--status`, `--apply` | integration, rehearsal, production | Rehearsal and production require `--through-migration=0028|0033|0036|0043|0044`; integration rejects every selector and accepts only its no-selector disposable path. Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only; one distinct `TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH` per wave for `--apply` in rehearsal or production only; every rehearsal wave after the first also requires the immediately preceding `TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH`. A pending 0043 additionally requires `TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH` and the staged compatibility protocol below. |
| `takoserver-signing-key-register` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_PUBLIC_JWK_PATH` for `--apply` only. |
| `takoserver-signing-repair` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_PRIVATE_JWK_PATH` for `--apply` only. |
| `takoserver-signing-rotation` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH` for `--apply` only. |
| `takoserver-hosted-token-cutover` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_HOSTED_TOKEN_PATH` for `--apply` only. |
| `takoserver-host-runtime-topology-retirement` | `--status`, `--apply` | integration, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-hosted-token-retirement` | `--status`, `--apply` | integration, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-worker-retirement-attribution-repair` | `--status`, `--apply` | integration, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback). |
| `takoserver-operator-identity` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW`, `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH`, and `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` for `--apply` only; every action requires `--organization=org_...`. |
| `takoserver-integration-operator-identity` | `--status`, `--apply` | integration only | Legacy spelling of the canonical surface; resolved Cloudflare credential (explicit token or integration OAuth fallback), same inputs and required `--organization=org_...`, refused in rehearsal and production. |

## Surfaces

The routine surfaces are:

- `takoserver-worker`: one Worker code publication. Before any live read or
  upload it composes the selected target with the Worker's own startup path and
  refuses with that composition's exact words, so a target that parses and yet
  cannot serve never reaches an upload. Every environment requires
  the resolved direct-REST credential path. In integration, an absent explicit
  token uses the exact Wrangler OAuth JSON resolver; its bearer is held only in
  process for the direct REST reader, while every Wrangler child gets no token
  environment and uses its stored OAuth profile. The resolver sets
  `WRANGLER_WRITE_LOGS=false` and passes no competing or unrelated credential
  variables to that child. Rehearsal and production require the explicit API
  token. Target URL/alias declarations are not live
  proof. When the selected public origin is under workers.dev, direct
  REST must prove both the script-specific enabled state and the account-owned
  workers.dev subdomain, then require the origin hostname to equal exactly
  `<worker-name>.<account-subdomain>.workers.dev`. An arbitrary workers.dev
  suffix is refused. The exhaustive custom-domain inventory is proved
  independently. The deploy tool never logs or serializes the resolved OAuth
  credential, and it never passes that bearer to a child process.
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

"Authority-sensitive Worker code" is not a hand-kept list of filenames.
`scripts/deploy/worker-authority-paths.ts` answers it from three sources: the
declared authority modules, each an exact path that must still exist; the
runtime import closure of the public Form P/I roots; and the runtime import
closure of the five authorities whose implementation *is* the authority — the
prepaid ledger and its Stripe settlement, the sealed runtime-input handoff and
its key ring, and the durable Takoform resource store. A new runtime dependency
of any of those classifies on its own. Only the lockfile, the manifest, the
Worker configuration and `scripts/deploy/**` stay path-shaped, because they have
no import graph to walk.

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
  RPC Worker upload. Its Core-verifier post-condition reads the identity probe's
  `FORM_AUTHORITY` bridge, which cannot exist before this Worker does, so a
  first upload is declared with `--apply --bootstrap-verifier-bridge` and an
  exact `--bootstrap-probe-predecessor-version`. The probe surface's strict
  transition classifier proves before qualification and at the final mutation
  fence that this Version is current and lacks only `FORM_AUTHORITY`; no probe
  drift can be crossed by the irreversible first upload. The deferred bridge is
  verified by the `--status` that follows the probe's binding transition. That
  deferral is admitted only where this Worker has no Version at all; every later
  apply reads the live bridge as its own post-condition. Exact D1/R2 and identity
  bindings are read back with no
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
  `POST /v1/organizations/{id}/api-keys` route. That identity must name the
  organization's own owner principal, and its provider must be one an operator
  assertion can vouch for — `google` or `github`; the preflight names either
  mismatch before anything is minted. The key is therefore recorded
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
  it requires the target to declare `operatorIdentity`, an environment-neutral
  authority used by integration, rehearsal, and production; the same exact
  owner proof applies in every environment.
- `takoserver-d1-schema-rehearsal-baseline`: rehearsal-only exact empty-to-0022
  bootstrap for the selected disposable D1. It seals only that fixed prefix,
  rechecks the empty lineage and canonical empty shape at the final fence, and
  cannot emit a receipt usable by production.
- `takoserver-d1-schema`: ordered, forward-only D1 migration waves. Status,
  post-qualification, and the final mutation fence report and require zero for
  0029 malformed FormRefs and duplicate live Resource UIDs, 0036 unmatched
  dispatched repair sagas, the nonempty 0037 v1 replacement predecessor, and
  0039 duplicate live native claims. A pending 0043 also reports the number of
  `deleting` blob candidates that overlap either an active direct root or a
  member of an active manifest root as
  `dataPreflights.artifactBlobIoFence.activeRootDeletingCandidateConflictCount`.
  A nonzero count is `legacy_data_repair_required`, and the exact query is run
  again after the 0037 transactional guard and immediately before the wave's
  first migration. The audited migration inventory has one
  fixed SHA-256 per file, including every already-applied file; a changed old
  migration therefore cannot be re-attested from the current checkout. Each
  rehearsal wave writes one no-overwrite canonical `0600` receipt binding the
  exact commit, predecessor, through boundary, selected bytes, and before/after
  shape. Every later receipt embeds its predecessor and binds those exact bytes
  by SHA-256, producing one chain rooted at the 0023–0028 rehearsal. Production
  consumes the matching wave receipt read-only. Immediately before 0037, one D1
  transaction installs an exact `BEFORE INSERT` guard on the v1 predecessor and
  asserts its row count is still zero. Because the published 0037 replacement
  drops that guarded table, no row inserted after the ordinary preflight can be
  silently discarded. This is a separate protocol around immutable 0037 SQL;
  production is blocked unless its trigger and zero assertion both read back.
  The pinned Wrangler sends the single guard command through D1's query API;
  Cloudflare documents that semicolon-joined statements execute as a
  [batch](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
  and that a failed D1 batch
  [rolls back the entire sequence](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
  D1 also documents that each individual database
  [processes queries one at a time](https://developers.cloudflare.com/d1/platform/limits/#how-much-work-can-a-d1-database-do),
  so an insert either precedes the transactional zero assertion or encounters
  the installed trigger.
  On a provider failure the lane immediately reads authoritative lineage and
  shape and reports `lastAppliedMigration` and `nextPendingMigration`; a rerun
  resumes only the same selected wave and the next selector remains refused
  until the current wave is complete. A target-D1 same-host kernel lease spans
  attempt creation, mutation, authoritative readback, and receipt/marker
  finalization. If D1 reached the selected boundary before the process lost its
  acknowledgement, the next lease owner verifies the original attempt and
  exact authoritative boundary, then finalizes evidence without applying the
  migrations a second time. The lease does not claim to fence another operator
  host or a direct Cloudflare/API mutation.

### 0043 artifact blob-I/O compatibility protocol

Migration 0043 changes the authority immediately around R2 `PUT` and `DELETE`.
An older invocation cannot see its lease table, and a D1 trigger cannot
intercept an object request that has already crossed into R2. Therefore 0043 is
not migration-first compatible. It remains blocked until this exact staged
protocol has removed every older object-I/O invocation:

1. Add `"artifactBlobIoMode": "pre-0043-quiesced"` to the operator-private
   deploy target. Publish the selected 0043 commit through
   `takoserver-worker-authority-cutover`, using the current Version as
   `--closure-predecessor-version` and
   `--add-var=TAKOSERVER_ARTIFACT_BLOB_IO_MODE`. This exceptional target is
   allowed only while the exact ordered 0037–0043 suffix is pending. It returns
   the owned `503 backend_unavailable` envelope on every request before D1/R2
   composition and makes scheduled execution a no-op. The realized Worker
   configuration explicitly sets `preview_urls: false`.
2. Publish the same selected commit and compatibility target a second time
   through `takoserver-worker-authority-cutover`, without a closure selector.
   The authoritative current Version and its immediate rollback Version must
   now both contain the exact quiescence binding and selected commit. Public
   Version and alias preview URLs must remain disabled: Cloudflare documents
   that an enabled [preview URL can publicly invoke a specific historical
   Version](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/).
   The `/healthz` smoke for these publications is the quiescence `503`, not the
   normal product-success probe.
3. Keep traffic blocked. Only the external traffic/Cloudflare operator can
   establish that every request and event invocation of every older Version
   completed or was cancelled. This repository has no exhaustive active-
   invocation API and does not manufacture that fact. A fixed waiting interval
   is not a substitute: Cloudflare documents no hard duration limit for an
   [HTTP Worker invocation while its client remains connected](https://developers.cloudflare.com/workers/platform/limits/#duration).
   Once completion or cancellation is established, the operator writes a
   private receipt with exactly this shape:

   ```json
   {
     "kind": "takoserver.artifact-blob-io-quiescence@v1",
     "environment": "production",
     "accountId": "<exact account id>",
     "workerName": "<exact Worker name>",
     "databaseId": "<exact D1 id>",
     "bucketName": "<exact R2 bucket name>",
     "currentCompatibilityDeploymentId": "<current compatibility deployment UUID>",
     "rollbackCompatibilityDeploymentId": "<immediate compatibility deployment UUID>",
     "currentCompatibilityVersionId": "<current compatibility Version UUID>",
     "rollbackCompatibilityVersionId": "<immediate compatibility rollback UUID>",
     "unsafePredecessorInvocations": "drained-or-cancelled",
     "observedAt": "<ISO timestamp>",
     "operator": "<operator identity>"
   }
   ```

   The receipt is an owned, link-free, exact-`0600` regular file of at most
   16 KiB under an owned exact-`0700` directory outside every Git worktree. Set
   `TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH` to its absolute path.
   If the operator cannot establish the assertion, do not create the receipt;
   0043 intentionally remains unavailable.
4. Run `takoserver-d1-schema --status --through-migration=0043`. Readiness now
   requires the two immutable compatibility Versions, disabled public preview
   URLs, unchanged deployment history, an exact receipt created after and bound
   to both deployment and Version identities, and zero
   active-root/deleting-candidate conflicts. Apply re-reads every item at
   qualification, at the final fence, and in mutation phase immediately before
   the first migration. A preview setting, history, receipt, target, or count
   change prevents the Wrangler apply; redeploying even the same two Versions
   invalidates the receipt and requires another drain proof.
5. After the exact 0043 lineage reads back, remove `artifactBlobIoMode` from the
   private target and publish through the authority cutover with the serving
   compatibility Version as `--closure-predecessor-version` and
   `--retire-var=TAKOSERVER_ARTIFACT_BLOB_IO_MODE`. The new code now admits a
   per-digest `write_admitted` owner before each PUT and advances a blob delete
   through `delete_claimed` then `delete_started` before its one external
   DELETE. Its immediate rollback remains the compatibility Worker, so rollback
   is service-denying but cannot run historical object I/O.

Before step 4, aborting the cutover may deliberately restore an older Version,
but doing so invalidates and requires deletion of any drain receipt. From the
first 0043 mutation onward, never select an older pre-compatibility Version,
including through the dashboard or a manually chosen Version rollback. The
owning deploy output names only the safe immediate predecessor. Subsequent
normal publications make lease-aware Versions each other's rollback; the
compatibility Version can then age out of the immediate rollback position.

Artifact maintenance status exposes `permanentlyFencedBlobDeletes`: external
DELETE owners still at `delete_started` after their lease deadline. Neither
object absence nor elapsed time proves that a thrown DELETE will not later
complete, so automatic reconciliation never releases or retries these rows;
they require explicit operator adjudication. `completedBlobIoResults` accounts
for immutable exact-operation results. Those results currently have no caller
acknowledgement/compaction protocol and are intentionally retained without a
time-based deletion policy; do not prune them merely to reduce the count.

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
- `takoserver-operator-identity`: environment-neutral operator identity
  authority. Every invocation names one exact `--organization=org_...`; it
  rebuilds the already served commit once, requires the exact served bundle
  digest, and uploads one immutable Worker Version that adds only the target's
  canonical public Ed25519 `OPERATOR_IDENTITY_PUBLIC_JWK` variable. Every other
  variable, binding, secret name/type, domain, D1/R2 identity, and Hosted
  topology must remain exact. Its owner proof uses the selected organization,
  revokes the short-lived session, and proves replay failure. Production status
  never treats provider-only configuration as owner-ready. The former
  `takoserver-integration-operator-identity` spelling remains an integration-
  only compatibility alias.
  It never writes a credential to D1 and never enables the separate wallet-
  funding authority retained by the legacy `OPERATOR_PUBLIC_JWK`. A live Worker
  carrying that legacy funding binding is refused as unrelated authority;
  replacing or removing it requires its own reviewed transition.

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

The canonical operator-identity surface is available in that production order
when an environment's operator authority needs to be configured. Its parser
requires one exact `--organization=org_...` and accepts integration, rehearsal,
or production. The legacy integration spelling is refused outside integration.
Its status path is read-only and reports the desired public-JWK digest, whether
that exact variable is already configured, the served Version, owner-proof
readiness, and a non-executable rollback evidence record. Status never reads
the private key or requires review evidence. Any recovery named by that record
requires a freshly qualified product-owned exact-target status/qualification
operation; no provider rollback command is emitted.

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
- `TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH`
- `TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH` (only while 0043 is pending)
- `TAKOSERVER_SIGNING_PUBLIC_JWK_PATH`
- `TAKOSERVER_SIGNING_PRIVATE_JWK_PATH`
- `TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH`
- `TAKOSERVER_HOSTED_TOKEN_PATH`
- `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH`
- `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` (operator identity owner proof)
- `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY`
- `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH`
- `--form-authority-scope-transition=/absolute/operator-private/transition.json`
- `TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH`
- `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY`
- `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH`
- `TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY`
- `--adopt-live=/absolute/operator-private/candidate.json`
- `--organization=org_...` (required by `takoserver-operator-identity` and its legacy integration alias)

For a D1 rehearsal apply, the lane creates a no-overwrite
`<TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH>.attempt` file after the final mutation
fence and before any mutation. If Wrangler partially applies a wave, that file
preserves the original predecessor shape and the exact predecessor-receipt
digest so the same wave can resume without fabricating new evidence. Use a
different receipt path for each of the four waves and, after the first, point
`TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH` at the immediately preceding
canonical receipt. It is embedded and SHA-256-linked into the new receipt.
The attempt is removed only after the final no-overwrite receipt is written.
Production similarly creates
`<TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH>.production-attempt` at its final fence,
binding the exact receipt bytes before any mutation. A partial production
lineage without that original marker is refused; a successful exact post-shape
readback removes it. Both marker lifecycles run under the target-D1 owned kernel
lease. If an exact selected boundary is already authoritative while its marker
remains, the lane reconciles the terminal readback and receipt/marker state
without invoking the provider apply again.

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

For a canonical operator-identity upload acknowledgement failure, do not retry
apply. Run the same surface with `--status --environment=<env>
--commit=<sha> --organization=<id>`: an exact configured digest means the
single-variable Version is current, while absence means the selected
predecessor remains current. Any unrelated configuration or Version advance is
refused rather than attributed to the interrupted attempt. In production,
status is never owner-ready without a fresh owner qualification. A rollback
record is evidence only (`executable=false`); recovery requires a freshly
qualified product-owned exact-target status/qualification operation, and no
provider rollback command is emitted. The legacy
`takoserver-integration-operator-identity` spelling may be used for this
readback only when `--environment=integration`.

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
