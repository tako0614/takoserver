# Takoserver deploy surfaces

This repository owns one deploy entrypoint and thirty separate mutation surfaces.
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
bun run deploy -- takoserver-d1-schema --status --environment=<rehearsal|production> --commit=<40-hex-sha> --through-migration=<0022|0028|0033|0036|0043|0044|0045|0046|0047|0048|0049>
bun run deploy -- takoserver-d1-schema --apply --environment=<rehearsal|production> --commit=<40-hex-sha> --through-migration=<0022|0028|0033|0036|0043|0044|0045|0046|0047|0048|0049>
```

The fixed order is the one-time legacy production catch-up 0017–0022, then
0023–0028, 0029–0033, 0034–0036, 0037–0043, 0044, 0045, 0046, 0047, 0048, and 0049. A
selector is accepted only when its predecessor is the current lineage; an
incomplete wave can resume under the same selector, but cannot skip forward.
The 0048 wave appends the value-free Resource execution-evidence ledger after
the complete 0047 sponsorship authority lineage; it never rewrites 0047.
The 0049 wave preserves every prior artifact-consumer receipt while admitting
only active zero-consumption receipts with no manifest digest. Apply 0049
before publishing the Worker that can emit that new receipt.
Integration retains only the no-selector fast path for disposable cadence and
rejects every protected selector. Its output is explicitly integration-only
and it cannot write evidence accepted by rehearsal or production. The separate
`takoserver-d1-schema-rehearsal-baseline` surface is rehearsal-only, accepts no
selector, and takes only an exact empty database through the fixed 0001–0022
prefix without emitting a production rehearsal receipt.
The 0022 selector is not a general prefix-adoption mechanism. It accepts only
the exact audited 0001–0016 lineage and canonical 0016 application-schema shape,
rehearses the exact 0017–0022 bytes against an independently populated
0016-compatible database, and binds critical data counts to its standalone
immutable receipt. Production must present that exact receipt and the same
pre-shape and data digest before the first migration can run.

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
the retired Hosted bearer secret. Ordinary target realization never carries
either retired field. Retirement applies perform one provider mutation followed
by authoritative readback; an acknowledgement loss is settled by `--status`,
never by a blind retry. `--reverse` is accepted only by the authority and
topology retirement surfaces. Secret deletion can create an unannotated direct successor; that state
is never reported as complete and is repaired only through the dedicated
post-token attribution surface below.

Public Cloudflare parent-token retirement has its own fixed owner surface. It
accepts no Worker, account, secret-name, cwd, predecessor, transition, or reverse
selector:

```sh
bun run deploy -- takoserver-public-parent-token-retirement --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-public-parent-token-retirement --apply --environment=integration --commit=<40-hex-sha>
```

Run integration first. Rehearsal and production use the same operation through
their own separately selected v2 targets and normal source-qualification rules;
an integration result is not evidence or authority for either lane. Status is
value-free and reports only exact deployment/source identities, whether the
executor binding exists, whether the public parent token exists, and the
route-less executor qualification. Apply first releases the selected public
Worker with its exact `CLOUDFLARE_PROVIDER_EXECUTOR` service binding when that
binding/source is not already exact. It re-reads both Workers and only then
deletes the public Worker's `CLOUDFLARE_API_TOKEN` once. The executor's
owner-private secret file and its own token/seal-key bindings are never read or
changed by this surface. Receipts keep the sealed release-tree
`artifactDigest` distinct from the deployed Worker `bundleDigest`; completed
status also exposes the value-free `scriptContentIdentity`. Integration and
rehearsal apply receipts include the exact `changedPaths` inventory returned by
source qualification (production is clean and therefore reports an empty
array).

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
the managed-worker gateway and managed-object receipt authority each own a
closed lifecycle boundary rather than entering this generic mechanism.

The internet-routed `takoserver-managed-worker-gateway` keeps its original
`TakoserverManagedWorkerSqlite` `v1` lineage and carries no receipt Durable
Object namespace or managed R2 S3/proof secret. The distinct
`takoserver-managed-object-receipt-authority` Worker is route-less and starts
its own `TakoserverManagedObjectReceipt` lineage at `v1`. Because that fresh
lineage creates durable state, rehearsal writes one external no-overwrite
`0600` receipt named by
`TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_REHEARSAL_RECEIPT_PATH`; production
consumes the same commit, module digest, null predecessor, class, lineage, and
empty target shape and re-reads both receipt and provider history immediately
before its one atomic code/lifecycle/secret deployment. Exact last-mutation
readback follows. An acknowledgement or local lease-release ambiguity is
forward-repair-only. Deploy and qualify this route-less authority before the
provider executor that binds it; the gateway has no receipt-authority binding
and can be qualified independently.

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

### Realizing the integration target from a clean checkout

A clean exact checkout intentionally contains no live target. Realize the
current integration descriptor as a new operator-private file at
`/root/dev/takos/.operator-private/takoserver/integration/target.v2.json`, mode
`0600`, then select it with:

```bash
export TAKOSERVER_DEPLOY_TARGET_INTEGRATION=/root/dev/takos/.operator-private/takoserver/integration/target.v2.json
```

Do not copy `.deploy/target.staging.json`: that is the retired target shape and
may carry `workerEndpointSuffix`, a direct parent-credential composition, or
other pre-executor topology. Author the new file from the current
`takoserver.deploy-target@v2` base values (account, public Worker, D1, R2,
origin, signing identity, and any other currently reviewed options), join a
fresh exact `takoserver.hosted-edge-supplies@v2` and/or
`takoserver.hosted-object-bucket-supplies@v2` object from the private commercial
owner, and add this topology in the same review:

```json
{
  "cloudflareProviderExecutor": {
    "workerName": "takoserver-cloudflare-provider-executor-integration",
    "dispatchNamespace": "takoserver-customers-integration",
    "dispatchNamespaceId": "<uuid read from the created namespace and explicitly pinned>",
    "gatewayWorkerName": "takoserver-managed-worker-gateway-integration",
    "managedBaseDomain": "<current managed base domain>",
    "providerInstallationId": "<current Cloudflare ProviderInstallation id>",
    "receiptAuthorityWorkerName": "takoserver-managed-object-receipt-authority-integration"
  }
}
```

The snippet is the topology member, not a complete target. Replace every
bracketed value with reviewed current evidence before placing it in the full
JSON object. The parser requires every Cloudflare supply's
`providerInstallation.id` to equal `providerInstallationId`, requires the
public, receipt-authority, gateway, and executor Worker names to be distinct.
Integration may omit `releaseReadbackQualification` because acknowledgement-
recovery qualification is not yet implemented or reviewed; when supplied, it
must retain the exact schema, namespace, and digest validation. Rehearsal and
production require the qualification object. The receipt authority reads both its Worker name and
`MANAGED_PROVIDER_ID` only from this tuple; no duplicate environment variable
may redirect it. Keep the executor two-secret file and the receipt three-secret
file separate from this non-secret target.

Create the dispatch namespace before assembling any optional runtime
qualification. The same environment-selected target path can initially contain only this namespace
surface's projection:

```json
{
  "kind": "takoserver.deploy-target@v2",
  "environment": "integration",
  "accountId": "<32 hex characters>",
  "cloudflareProviderExecutor": {
    "dispatchNamespace": "takoserver-customers-integration"
  }
}
```

```bash
bun run deploy -- takoserver-managed-worker-dispatch-namespace --status --environment=integration --commit=<40-hex-commit>
bun run deploy -- takoserver-managed-worker-dispatch-namespace --apply --environment=integration --commit=<40-hex-commit>
```

This projection is accepted only by the namespace surface. It does not satisfy
the complete Worker/executor deploy target, does not publish an Offering, and
does not need invented supply or rehearsal evidence. Creation makes one POST
after a fresh absence read, then independently reads the exact id/name, empty
script inventory and `trusted_workers=false`. It reports
`created-needs-target-pin`. Explicitly add the returned id as
`cloudflareProviderExecutor.dispatchNamespaceId`, then complete the target with
the private owner's actual supplies (and, for rehearsal or production, runtime
qualification) before deploying the gateway/executor. No separate namespace
environment override exists.

Cloudflare's optional `trusted_workers` response field uses its documented
untrusted default only when the JSON property is omitted. An explicit `true`
remains drift; `null` and other non-boolean values are malformed. A verification
failure after creation never warrants another POST: inspect status, resolve the
readback discrepancy, then explicitly pin the independently observed id.

Status reports `absent`, `pin-existing`, `ready`, or `drift`. An existing empty
unpinned namespace requires explicit pinning; a nonempty unpinned namespace is
not adopted. A missing pinned namespace is drift and is never recreated under
the same name. There is no deletion, rename or reverse action. A lost create
acknowledgement stops without retry; use fresh status to reconcile it.
Rehearsal creation writes an owned no-overwrite `0600` receipt outside Git under
an owned `0700` directory. Production creation consumes the successful
same-source-commit rehearsal receipt and re-reads it before creation through
`TAKOSERVER_MANAGED_WORKER_DISPATCH_NAMESPACE_REHEARSAL_RECEIPT_PATH`.
Integration and every status action do not read that receipt.

The one reviewed integration incident additionally requires this closed target
member. It is rejected outside integration and unless the current provider
executor, authenticated Form operator gateway, and fixed integration E2E tenant
are all present:

```json
{
  "exactArtifactRecovery": {
    "workerName": "takoserver-exact-artifact-recovery-integration",
    "retentionPolicy": {
      "kind": "takoserver.exact-failed-run-artifact-recovery-detail-retention@v1",
      "evidenceDigest": "sha256:<digest of the current owner retention policy>",
      "detailRetentionMilliseconds": 604800000
    }
  }
}
```

The retention duration is an owner decision, not a recovery default. A target
without a current explicit policy cannot run recovery or purge details. The
recovery Worker name must be distinct from every permanent Worker name.

While the integration Form-authority migration still has to recognize the
immutable public Worker generation from before the executor, the operator must
also copy that generation's exact endpoint suffix into this closed,
readback-only snapshot inside `formAuthority`:

```json
{
  "formAuthority": {
    "historicalPreExecutorPublicWorker": {
      "workerEndpointSuffix": "<exact suffix read from the pinned historical Version>"
    }
  }
}
```

This member is integration-only, is accepted only with the complete historical
Form-authority bridge, sponsorship, JIT authority, edge supplies, and executor
topology, and is never emitted by `deploymentVariables` or `writeWorkerConfig`.
It must not be inferred from `cloudflareProviderExecutor.managedBaseDomain`:
the two values may differ. A missing or mismatched snapshot refuses the legacy
Version rather than widening the readback profile. Delete the member after the
joint route-less authority and gateway status described in
[`docs/form-authority.md`](form-authority.md) proves the bridge complete.

A private composer pinned to an older public contract that still requires or
emits `workerEndpointSuffix` is not a realization source. Advance that pin and
review its current v2 output, or author the current v2 object directly; never
rename an older artifact and treat the filename as schema conversion.

From the clean checkout, first run the read-only owner paths with that selector:

```bash
export TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH=/root/dev/takos/.operator-private/takoserver/integration/cloudflare-provider-executor.secrets.json
bun run deploy -- takoserver-d1-schema --status --environment=integration --commit=<40-hex-commit>
bun run deploy -- takoserver-managed-object-receipt-authority --status --environment=integration --commit=<40-hex-commit>
bun run deploy -- cloudflare-provider-executor --status --environment=integration --commit=<40-hex-commit>
```

Each command must parse the same file. A missing, legacy, partial, or mismatched
descriptor fails before Cloudflare or D1 is touched. Status readiness does not
authorize apply; after migration 0045 is present, the reviewed release order is
receipt authority, gateway, executor, then public API. The schema and receipt
status calls also require the integration deploy credential described below;
the executor status reads its parent token only from the separate canonical
two-secret file named above.

## One-shot exact artifact recovery

The recovery owner is the normal product deploy entrypoint, not a permanent
HTTP API and not a raw D1/R2 operator script:

```bash
export TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_PATH=/absolute/owner-private/recovery-request.v2.json
export TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH=/absolute/owner-private/cloudflare-provider-executor.secrets.json
export TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH=/absolute/owner-private/form-authority-operator.private.jwk.json

bun run deploy -- takoserver-exact-artifact-recovery --status --environment=integration --commit=<request-source-commit>
bun run deploy -- takoserver-exact-artifact-recovery --apply --environment=integration --commit=<request-source-commit>
```

The request file is canonical
`takoserver.exact-failed-run-artifact-recovery-request@v2`, owned by the current
user, mode `0600`, link-free, outside the repository, and contains the complete
exact incident closure. Its body and private evidence are never printed. The
same request digest, target, selected commit, R2 identity, explicit retention
policy, migration 0045 lineage, 4 owners, 5 uploads, 2 replay keys, 28 members,
and 29 holds are checked again on every step. Migration 0046 contains no
incident digest.

Each apply runs the complete owner gate and performs at most one transition;
run status again after every invocation. The ordered states are:

1. Publish one request-pinned Worker Version with no route, custom domain,
   workers.dev endpoint, preview URL, scheduled trigger, or secret.
2. Publish one temporary overlay of the existing authenticated Form operator
   gateway, adding only the recovery service binding plus the exact request and
   Worker Version pins.
3. Invoke one signed prepare/settle/complete transition through that gateway.
4. Keep the route-less Worker and its authenticated service-binding overlay
   installed through the target-declared retention deadline.
5. At that deadline, recheck the complete D1/R2/identity fence and invoke the
   signed purge through the gateway. The Worker performs all destructive detail
   changes with one real `D1Database.batch()` and requires a durable compact
   `purged` readback; a failed statement rolls the whole batch back and a lost
   acknowledgement is settled from that readback without repeating a committed
   purge.
6. Only after the durable `purged` readback, republish the gateway's ordinary
   closure and then delete the route-less recovery Worker.

A `delete_started` candidate is never retried. Status first plans
`retire_gateway_for_handoff`; only after the ordinary gateway Version is live
does it emit a deterministic `quiescenceEvidenceDigest`. A separate reviewed,
canonical owner-only `TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK_PATH` must
bind that digest, the exact predecessor Version, candidate ordinal, and either
confirmed HEAD absence or a new reviewed operation/fence for the observed
ETag. The next apply publishes a new immutable route-less Worker Version with
that handoff; only a later step reattaches the gateway. Present or changed
bytes never become an inferred retry. Publication or deletion acknowledgement
loss always returns to status and is never blindly repeated.

## Environment inputs and action matrix

`requiresEnv` in `takos.deploy-contract@v2` is the conservative union of the
environment variables needed by any action supported by that surface. It does
not mean that every listed variable is read by every action. Each surface's
obligation answer names the exact action condition; `--contract` itself reads
no operator input.

For every Cloudflare-owned row below whose required condition says “resolved
Cloudflare credential”, an explicit `CLOUDFLARE_API_TOKEN` always wins. In
`integration`, an absent token may be resolved only from the exact
`wrangler auth token --json` object `{ "type": "oauth", "token": "..." }`.
That bearer is held in-process for direct REST readback only; it is never
logged or serialized, and Wrangler children receive no token environment and
use their stored OAuth profile. The OAuth extractor explicitly sets
`WRANGLER_WRITE_LOGS=false`, so Wrangler's mode-0644 debug log cannot persist
the bearer; its credential child-environment overlay contains no competing API
key, email, token variant, or unrelated secret. `rehearsal` and `production`
still require the explicit API token. The route-less provider executor is the
deliberate exception: it accepts only its canonical external two-secret file,
never ambient token/OAuth resolution. The conservative `requiresEnv` union
remains unchanged.

| Surface | Supported action(s) | Environment | Required input condition |
| --- | --- | --- | --- |
| `takoserver-worker` | `--status`, `--apply` | integration, rehearsal, production | Resolved operator deploy credential for both actions: explicit `CLOUDFLARE_API_TOKEN` or integration-only Wrangler OAuth fallback; rehearsal and production require the explicit token. This credential authorizes the deploy process and is never a public Worker binding. A target with Cloudflare supplies additionally requires the exact selected-commit provider executor qualification outside integration; integration may omit the not-yet-produced acknowledgement-recovery marker. |
| `takoserver-worker-authority-cutover` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only; `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY` for `--apply` only, and only when the declared closure delta names an added or rotated secret. |
| `takoserver-public-parent-token-retirement` | `--status`, `--apply` | integration, rehearsal, production | Exact environment-selected v2 target and resolved Cloudflare credential for both actions; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. It accepts no additional selector and never reads `TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH`. |
| `takoserver-managed-object-receipt-authority` | `--status`, `--apply` | integration, rehearsal, production | The Worker name and provider installation come solely from `target.cloudflareProviderExecutor`; a resolved Cloudflare deploy credential is required for both actions. `--apply` additionally requires `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_MANAGED_OBJECT_RECEIPT_SECRETS_PATH`; only a fresh rehearsal/production `v1` apply reads `TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_REHEARSAL_RECEIPT_PATH`. Status never reads any of those three apply-only inputs. |
| `takoserver-managed-worker-dispatch-namespace` | `--status`, `--apply` | integration, rehearsal, production | Environment-selected account/name/optional-id target projection and resolved Cloudflare credential. Apply requires `TAKOSERVER_INDEPENDENT_REVIEW`; rehearsal/production creation additionally requires `TAKOSERVER_MANAGED_WORKER_DISPATCH_NAMESPACE_REHEARSAL_RECEIPT_PATH`. Status reads neither. No supply or runtime qualification is required to create the namespace. |
| `takoserver-managed-worker-gateway` | `--status`, `--apply` | integration, rehearsal, production | Exact route, gateway and legacy script, zone, provider, and gateway identities plus a resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback). Namespace name/id derive only from the complete selected target and must read back as the pinned untrusted incarnation; `TAKOSERVER_INDEPENDENT_REVIEW` is required for apply only. It reads no managed-object S3/proof secret or receipt-authority evidence. |
| `cloudflare-provider-executor` | `--status`, `--apply`; `--apply --reverse` | integration, rehearsal, production | `TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH` is required for every action and contains exactly the parent `CLOUDFLARE_API_TOKEN` and runtime-input seal keyring. Status uses the token only for authoritative readback; forward apply publishes both secret bindings atomically. Apply/reverse additionally require `TAKOSERVER_INDEPENDENT_REVIEW`. Receipt authority, gateway, migration 0045, and the selected target must already be exact. Integration may omit `releaseReadbackQualification`; status then reports `acknowledgementRecoveryQualified:false` and does not claim pending-ack recovery readiness. Rehearsal and production retain the required qualification object. |
| `takoserver-exact-artifact-recovery` | `--status`, `--apply` | integration only | `TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_PATH`, `TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH`, and `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` for both actions; `TAKOSERVER_INDEPENDENT_REVIEW` for apply. `TAKOSERVER_EXACT_ARTIFACT_RECOVERY_LOST_ACK_PATH` is read only after status has proved the predecessor quiesced and planned a successor. Every path names a canonical owner-only 0600 file outside the repository. |
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
| `takoserver-d1-schema` | `--status`, `--apply` | integration, rehearsal, production | Rehearsal and production require `--through-migration=0022|0028|0033|0036|0043|0044|0045|0046|0047|0048|0049`; integration rejects every selector and accepts only its no-selector disposable path. Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only; one distinct `TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH` per wave for `--apply` in rehearsal or production only. The one-time 0016→0022 receipt is standalone; ordinary chained rehearsal waves after 0028 require the immediately preceding `TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH`. A pending 0043 additionally requires `TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH` and the staged compatibility protocol below. |
| `takoserver-signing-key-register` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_PUBLIC_JWK_PATH` for `--apply` only. |
| `takoserver-signing-repair` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_PRIVATE_JWK_PATH` for `--apply` only. |
| `takoserver-signing-rotation` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` and `TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH` for `--apply` only. |
| `takoserver-sponsorship-authority-worker` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare deployment credential plus a distinct owned `0600` `TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL` for both; `TAKOSERVER_INDEPENDENT_REVIEW`, `TAKOSERVER_SPONSORSHIP_CREDENTIAL_PRIVATE_JWK_PATH`, and `TAKOSERVER_SPONSORSHIP_RECEIPT_PRIVATE_JWK_PATH` for `--apply` only. The deploy target pins the Worker name, organization, and distinct credential/receipt public keys; apply append-only registers and reads back the credential public half before upload. |
| `takoserver-sponsorship-public-route-retirement` | `--status`, `--apply`; `--reverse` on apply only | integration, production | Resolved Cloudflare deployment credential plus the distinct topology-audit credential; exact `--legacy-host-runtime-predecessor-version=<uuid>` for every action; `TAKOSERVER_INDEPENDENT_REVIEW` and current owner-private proof path/SHA-256 for forward `--apply`. The target-derived remote `STATE_DB` must carry migration `0047_sponsorship_cutover_consumption.sql` after reviewed `0046`; no operator-selectable local replay store exists. Keep proof inputs present for post-acknowledgement `--status` so it can settle the started operation exactly once. Reverse does not erase consumption. |
| `takoserver-host-runtime-topology-retirement` | `--status`, `--apply` | integration, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-hosted-token-retirement` | `--status`, `--apply` | integration, production | Resolved Cloudflare deployment credential plus the distinct topology-audit credential; exact `--legacy-host-runtime-predecessor-version=<uuid>` for every action; `TAKOSERVER_INDEPENDENT_REVIEW`, a current owner-private proof path/SHA-256, migration `0047` in the target-derived remote `STATE_DB`, and an exact completed route-removal operation receipt for `--apply`. Keep proof inputs present for post-acknowledgement `--status` settlement. |
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

- `takoserver-managed-object-receipt-authority`: the sole owner of the
  route-less receipt Durable Object Worker. Status exhaustively reads current
  deployment history, one exact module, the closed binding set, `v1` migration,
  workers.dev/preview settings, all account routes, and the complete account
  custom-domain inventory without reading a secret source or rehearsal receipt.
  No route or custom-domain service mapping may name the authority Worker. Apply
  builds one sealed artifact, copies the
  exact three-secret operator input into it, and invokes one supported Wrangler
  `deploy --secrets-file` operation. Code, the local Durable Object namespace,
  its `v1` migration, identity vars, and all three secret bindings therefore
  become one Worker publication; there is no post-deploy secret mutation. The
  copied file is removed in `finally` after success or failure, including when
  the caller retains the remaining release directory. A fresh `v1` lifecycle is
  irreversible: rehearsal emits no-overwrite external evidence only after exact
  readback, production consumes and re-reads it at the final mutation fence, and
  integration evidence can never authorize production. Existing exact
  route-less `v1` predecessors use the same atomic publication without changing
  lifecycle lineage. Any route, extra binding, different lineage, changed
  predecessor, or lost acknowledgement fails closed for status/forward repair.
- `takoserver-managed-worker-gateway`: the internet-routed dispatch and SQLite
  gateway. It retains its original `TakoserverManagedWorkerSqlite` `v1`
  lifecycle and contains no receipt namespace, S3 credential, or receipt proof
  secret. Its target-pinned dispatch namespace must already exist with the
  exact id/name and `trusted_workers=false`; the namespace is rechecked before
  mutation and during readback. Its existing staged-Version, exact deployment/readback, route-last,
  and provider-history rollback protocol is unchanged. It has no dependency on
  the receipt authority; the later route-less provider executor must qualify
  both Workers before it can publish tenant Versions.
- `cloudflare-provider-executor`: the sole Cloudflare parent-provider runtime.
  Its target-owned Worker name, provider installation, dispatch namespace,
  gateway, managed base domain, receipt authority, D1, R2, account, supplies,
  and, when present, release-readback qualification form one closed topology.
  Status reports whether acknowledgement recovery is qualified and never treats
  an integration omission as recovery readiness. Status validates
  migration 0045, the exact selected-commit receipt authority and gateway, one
  immutable executor module, the exhaustive D1/R2/dispatch/cross-script Durable
  Object/service/plain-text/secret binding set, compatibility settings,
  workers.dev/preview disablement, and exhaustive absence from routes and custom
  domains. It reads the parent token only from
  `TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH`; the public Worker
  receives neither that file nor either value. Forward apply builds with an
  empty secret environment, seals one module/config/canonical two-secret copy,
  re-fences topology, schema, dependencies, provider history, and bytes, then
  performs one Wrangler `deploy --secrets-file`. Reverse selects only the
  immediate provider-history predecessor, proves its immutable module and
  binding closure, re-fences the complete current route-less state before
  moving traffic, and verifies the restored deployment at 100 percent. The
  additive D1 migration remains. A lost acknowledgement is never replayed.
- `takoserver-public-parent-token-retirement`: the sole owner of the public
  parent-credential handoff. It requires the exact selected-commit executor to
  be fully ready and route-less — no route, custom domain, workers.dev endpoint,
  or preview URL — and fences the public Worker's deployment history, canonical
  source/artifact identity, complete binding/secret closure, routes, and custom
  domains. Exact executor and public-Worker same-host kernel leases span at most one exact
  binding/code release followed by one deletion of only
  `CLOUDFLARE_API_TOKEN`. The release preserves every existing public secret,
  including sponsorship, signing, and runtime-input seal keys; the final
  secret-created successor must retain the identical script identity and exact
  remaining closure. Token absence before the exact binding is a refusal.
  Status may adopt only an exact token-free canonical state or the exact direct
  secret-created successor. The surface is forward-only and never reads or
  mutates the executor's owner-private credential material. The two leases do
  not fence dashboard, direct-API, or other-host actors. Cloudflare offers no
  conditional secret-delete input, so the immediate pre-delete and final
  authoritative reads detect such a race but cannot roll the deletion back.
- `takoserver-worker` qualifies that exact executor Version before a public
  publication whenever the target contains a Cloudflare supply. It repeats the
  qualification at the mutation fence and after publication. The required
  release order is receipt authority, managed gateway, provider executor, then
  public API. A missing or changed executor stops publication; the public Worker
  cannot fall back to a credential-bearing ordinary Cloudflare provider.
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
  shape. A Cloudflare target uses the same selected-commit provider-executor
  qualification as the routine surface: status includes it in readiness, apply
  refuses an unready executor before public Worker readback or build, and apply
  re-fences the exact executor deployment both immediately before upload and
  after public readback. Apply performs exactly one upload of the complete current closure: the
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

  The former integration transition that placed `CLOUDFLARE_API_TOKEN` on the
  public Worker is retired. A public Version or script-level secret inventory
  that still contains that name is drift and cannot become ready. The parent
  token is supplied only to `cloudflare-provider-executor` through its closed
  secrets file. The public Worker may retain
  `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` for request-side runtime-input
  preparation, but executor-side leasing uses the executor's independently
  published copy. A live public secret retirement is an explicit authority
  mutation and must not be smuggled through a routine Worker deploy; no command
  in this document treats a successful executor deployment as authority to
  delete it.
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
  again after the 0037 monotonic insert guard and immediately before the wave's
  first migration. The audited migration inventory has one
  fixed SHA-256 per file, including every already-applied file; a changed old
  migration therefore cannot be re-attested from the current checkout. Each
  rehearsal wave writes one no-overwrite canonical `0600` receipt binding the
  exact commit, predecessor, through boundary, selected bytes, and before/after
  shape. Every later receipt embeds its predecessor and binds those exact bytes
  by SHA-256, producing one chain rooted at the 0023–0028 rehearsal. Production
  consumes the matching wave receipt read-only. The fixed 0044 wave adds durable
  artifact-consumer resolution receipts. Its distinct 0045 successor adds the
  private Cloudflare executor's pre-effect operation CAS and can start only from
  the exact 0044 boundary. The separate 0046 successor widens exact owner-closure
  receipts only for deterministic integration recovery writers and adds one
  durable singleton authorization; it can start only from the exact 0045
  boundary. The 0049 successor rebuilds the receipt table forward-only,
  preserves all 0044 receipt rows, constraints, indexes, and triggers, and adds
  only the active zero-consumption receipt shape. Routine Worker publication
  refuses the pending 0049 migration. The exceptional 0022 selector is a
  standalone catch-up receipt,
  not the root of this ordinary chain and not permission to adopt an arbitrary
  migration-name prefix. It can start only from the exact audited 0001–0016
  names and the frozen canonical 0016 application-schema digest. Rehearsal and
  production must have the same critical-data digest covering ledger,
  principal, organization, owner-membership projection, usage-event, resource
  deployment, active Resource UID conflict, and live native-identity conflict
  counts. Unsafe conflicts or a nonempty ledger stop before mutation. The
  receipt binds that pre-shape/data snapshot, exact 0017–0022 bytes, and the
  post-shape/data readback; production consumes it once under the usual
  no-overwrite attempt and forward-repair-only rules. Immediately
  before 0037, one single-statement
  `CREATE TRIGGER IF NOT EXISTS` durably installs the exact `BEFORE INSERT`
  guard on the v1 predecessor. The lane reads the canonical trigger SQL back,
  then separately proves the predecessor count is zero. It repeats the exact
  trigger-plus-count read immediately before starting the migration; the
  published 0037 replacement then drops the guarded table. A crash after
  trigger installation therefore leaves a safe monotonic forward-repair state:
  retry validates the same trigger and continues, while a different trigger is
  never replaced. D1 documents that each individual database
  [processes queries one at a time](https://developers.cloudflare.com/d1/platform/limits/#how-much-work-can-a-d1-database-do),
  so an insert before installation is observed by the zero-count proof, and an
  insert after installation encounters the guard. This protocol does not send
  multiple destructive REST statements and does not claim that the REST query
  endpoint provides `D1Database.batch()` rollback semantics.
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
  Worker code is uploaded with the next id and private secret together. Only an
  exact canonical public Worker Version and exact public binding/secret closure
  are accepted; provider-created secret successors and every mixed or unknown
  annotation inventory fail before build or upload.
- `takoserver-sponsorship-authority-worker`: publishes the dedicated
  route-less RPC authority. Its immutable closure is exactly one `STATE_DB`
  binding, deploy-pinned organization/issuer, dedicated sponsorship credential
  key id/public JWK/secret, distinct receipt key id/secret, and Worker version
  metadata. The credential public key is append-only registered in
  `runtime_grant_keys` and read back exactly; its owned private half enters only
  this route-less Worker. The public Worker retains its distinct ordinary
  run-token secret, exposes no tenant-run mint API, and accepts a tenant-run JWT
  only when migration `0047` contains the matching immutable admission row and
  credential key id. The authority has `workers_dev=false`,
  `preview_urls=false`, no routes or custom domains, no public `fetch`, and
  exposes only `issueTenantRunCredential`. Status and post-apply readback prove
  the active Version, script identity, exact binding/secret closure, and empty
  public topology. Before topology enumeration, an owner-private audit
  credential reads the exact deployment token's active policy and mechanically
  proves `Zone Read` plus `Workers Routes Read` over the exact nested all-zones
  resource for the selected account. `Workers Routes Write` is rejected because
  this credential performs no route mutation. Only token, policy, and resource digests
  enter evidence. They intentionally report `functionalProofPending: true`
  and `rolloutReady: false`: only the subsequently bound Hosted staging flow
  can supply authenticated issuance/readback proof.

  Migration `0047` also owns the append-only sponsorship issuance admission.
  One logical Hosted exchange has one stable operation id; its first D1 insert
  fixes the 300-second issue instant and token id while atomically binding the
  tenant through the same SQLite statement. An exact RPC retry reconstructs
  byte-identical Ed25519 bearer and receipt bytes. A changed request conflicts,
  and an unavailable wallet never reaches either signer. The row stores no raw
  bearer, Space, or Run value and cannot be updated or deleted.

  The one-time cutover order is fixed: (1) deploy and read back this authority,
  (2) release Hosted with its exact service binding and no bearer secret,
  (3) run the bounded authenticated staging E2E and verify the issued
  tenant/space/run credential and at-most-300-second lifetime, then (4) retire
  the old public-route topology and its bearer secret. Steps may not be reordered,
  and no compatibility route or bearer is retained afterward.
- `takoserver-sponsorship-public-route-retirement`: the only owner lane that
  may publish the public Worker bytes which remove the sponsorship handlers.
  Forward apply requires the fresh Hosted-produced staging proof, revalidates
  its exact observed public Worker predecessor/topology/generation, authority
  Worker Version/source/artifact/script/receipt key, Hosted
  Version/source/artifact/config/binding set, sole default-entrypoint service
  binding, zero Hosted public topology, the distinct signed authority issuance
  receipt, the matching append-only Hosted receipt, verified signed exact
  tenant/Space/Run claims, sole audience/scope, at-most-300-second credential,
  and authenticated Takoform readback. In the target-derived remote `STATE_DB`,
  it records an append-only phase start immediately before the one upload and a
  completion only after exact direct-successor readback. The start binds the
  predecessor, source commit, exact bundle/config, candidate identity, and
  operation id, so lost acknowledgement cannot bless an interleaved successor.
  That candidate retains the separately retired legacy Host-runtime
  binding and bearer; all former public sponsorship routes return the ordinary
  public 404 regardless of any bearer. `--reverse` restores only the pinned
  provider-history predecessor and consumes no proof; another forward apply
  requires a fresh proof.
- `takoserver-host-runtime-topology-retirement`: C→T transition. It uploads a
  byte-identical candidate Worker exactly once, removes only the observed
  `HOST_RUNTIME_MATERIALIZER` binding, retains the Hosted secret, and proves the
  direct successor. `--reverse` redeploys that exact provider-history Version.
- `takoserver-hosted-token-retirement`: T→R transition. It deletes only
  the retired Hosted bearer secret after topology retirement and verifies
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

The sponsorship cutover is deletion-first and the following owner order is the
executable contract. Every path shown below is absolute, outside Git, owned by
the operator, and mode `0600`. Replay and lost-acknowledgement authority is the
target-derived remote `STATE_DB` under migration `0047`, never a local path or
checkout.

1. Supply a distinct topology-audit credential through
   `TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL`. The JSON file has kind
   `takoserver.cloudflare-topology-audit-credential@v1`, the deployment-token
   owner (`user` or `account`), and the separate metadata-read token. That
   audit token needs the corresponding user `API Tokens Read` or account
   `Account API Tokens Read` authority; it never becomes a Worker binding.
   The deployment token itself must be active and carry both `Zone Read` and
   `Workers Routes Read` over the exact all-zones-in-selected-account resource.
   `Workers Routes Write`, partial-zone, or unverifiable policy fails before a
   topology claim.
2. After the exact reviewed `0046` Takoserver lineage is present, expose and
   apply `0047_sponsorship_cutover_consumption.sql` through the owning
   `takoserver-d1-schema` surface. This additive migration creates both the
   issuance-operation CAS needed by the authority RPC and the two cutover
   consumption receipts. Do not deploy the functional authority/Hosted pair or
   retire anything from a source tree whose audited schema inventory stops
   before `0047`.
3. Deploy `takoserver-sponsorship-authority-worker`, supplying separate owned
   sponsorship-credential and issuance-receipt private JWKs through
   `TAKOSERVER_SPONSORSHIP_CREDENTIAL_PRIVATE_JWK_PATH` and
   `TAKOSERVER_SPONSORSHIP_RECEIPT_PRIVATE_JWK_PATH`, then run its `--status`
   action and retain the exact status JSON. Authority status must report its
   exact active Version/source/artifact/script, topology-policy digests, and
   closed D1/two-key signing binding set, exact credential public-key registry
   readback, `functionalProofPending: true`, and
   `rolloutReady: false`. This authority deployment is independently allowed
   first and cannot remove a public route.
4. In `takosumi-hosted`, apply its additive `0003` issuance-receipt migration
   as part of the owning release and publish the exact Hosted Version with precisely one
   `TAKOSERVER_SPONSORSHIP_AUTHORITY` default-entrypoint service binding, no
   sponsorship bearer secret, and no workers.dev, preview URL, account-zone
   route, custom domain, or top-level subdomain setting. Its separate
   `TAKOSUMI_HOSTED_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL` must authenticate the
   exact deployment token's complete all-zone visibility. Retain the ready
   ordinary `worker-release-evidence@v3` or successful
   `worker-release-recovery-evidence@v2` file and the exact realized config.
5. Before removal, capture
   `takoserver-sponsorship-public-route-retirement --status` as an owned `0600`
   public-predecessor evidence file:

   ```sh
   umask 077
   bun run deploy -- takoserver-sponsorship-public-route-retirement --status \
     --environment=<integration-or-production> \
     --commit=<40-hex-candidate-commit> \
     --legacy-host-runtime-predecessor-version=<uuid> \
     > /absolute/operator-private/cutover/public-predecessor-status.json
   ```

   Then run the
   existing authenticated Takosumi staging apply E2E through the actual Hosted
   `exchangeProviderCredential` method. That path calls the service binding and
   then performs one append-only insert containing only credential/receipt
   hashes, the signed receipt, Hosted Version, and time in Hosted's dedicated
   `sponsorship_issuance_receipts`
   table. It stores no raw credential or tenant value. Capture the structural
   exchange input/result and the exact deterministic private RPC channel
   (logical operation id, Hosted Version, request digest, and nonce) in an
   owner-private `0600` transcript. Generic Hosted
   routes and the legacy Takoserver HTTP sponsorship route cannot append this
   row or sign the distinct authority receipt. Do not add runtime logging or a
   public proof endpoint.
6. With `CLOUDFLARE_API_TOKEN` available only to the owner process for the
   exact Hosted D1 read, use Hosted's deploy surface to require the append-only
   receipt row, verify both Ed25519 signatures, validate the exact issued
   audience/scope/tenant/Space/Run claims and at-most-300-second lifetime, and
   perform the bounded bearer-authenticated Takoform Form-list readback:

   ```sh
   bun run deploy -- takosumi-hosted-sponsorship-cutover-proof \
     --environment=staging \
     --authority-evidence=/absolute/operator-private/cutover/authority-status.json \
     --hosted-evidence=/absolute/operator-private/cutover/hosted-release-evidence.json \
     --public-predecessor-evidence=/absolute/operator-private/cutover/public-predecessor-status.json \
     --e2e-transcript=/absolute/operator-private/cutover/staging-e2e-transcript.json \
     --worker-config=/absolute/operator-private/cutover/hosted-realized-config.json \
     --out=/absolute/operator-private/cutover/sponsorship-cutover-proof.json
   ```

7. Confirm the exact raw proof-file digest printed by the create-only Hosted
   command, then export only its path and digest:

   ```sh
   export TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH=/absolute/operator-private/cutover/sponsorship-cutover-proof.json
   export TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256=sha256:<exact-raw-proof-digest>
   ```

8. Run status/apply/status on
   `takoserver-sponsorship-public-route-retirement`, always with the exact
   `--legacy-host-runtime-predecessor-version=<uuid>` and selected commit. The
   forward apply revalidates both currently serving proof-bound Workers twice,
   consumes `public-route-removal` immediately before its sole upload, and
   records the exact successor afterward. If upload acknowledgement is lost,
   run status with these same proof inputs; it may settle only that already
   started phase, even after the proof's ordinary freshness window, because the
   durable start fixed the proof digest, predecessor, candidate bundle/config,
   and start time before mutation. If authoritative readback still shows the
   unchanged predecessor, the start is explicitly indeterminate: status may
   report it but neither status nor another apply receives provider-mutation
   authority. Do not retry apply. Recovery would require a separately reviewed,
   quiesced rearm/forward-repair state that this cutover does not implement.
9. Run status/apply/status on
   `takoserver-host-runtime-topology-retirement` with the same legacy selector
   to remove the retained Host-runtime service binding without changing code
   bytes. This is cleanup of a separate historical edge, not a compatibility
   path.
10. While the proof is still current, run status/apply/status on
   `takoserver-hosted-token-retirement` with the same legacy selector. It
   requires the exact completed route-removal operation in remote `STATE_DB`,
   revalidates the current proof-bound authority and Hosted Workers, records
   `legacy-secret-retirement` immediately before its sole secret delete, and
   completes only after direct-successor readback. A lost acknowledgement is
   reconciled by status with the same proof inputs, including after expiry when
   the durable start predates expiry and exact successor readback still matches.
   If the two-hour proof expired before this stage was started, rerun the
   authenticated staging E2E and create a new proof bound to the current
   topology-only successor; the operation id on the route-removing Version and
   its remote completion remain the order witness. After any reversal, the
   earlier proof cannot borrow a later proof's replacement route operation to
   authorize secret retirement: use the proof that admitted that replacement
   operation, or a still newer proof bound to its exact topology-only successor.

The Hosted proof output is
`takosumi-hosted.sponsorship-authority-cutover-proof@v1` and has exactly a
two-hour `completedAt`/`expiresAt` interval. Its terminal stdout exposes only
kind, ready status, raw proof SHA-256, and self-confirmation. Route and secret
apply/status evidence include `sponsorshipCutoverProofSha256` only after the
corresponding proof phase completed or a started mutation was authoritatively
settled. A terminal route-removed or secret-retired status refuses to report
readiness without those current proof inputs and the exact remote receipt.
Missing/stale/mismatched proof, live Version/binding/topology drift,
missing order receipt, or replay fails closed before another mutation. Machine,
checkout, or proof-path changes cannot replace the remote replay authority.
Reverse does not erase a consumed proof; every later forward cutover needs a
fresh proof bound to the then-current public predecessor. Authority status proves static Cloudflare closure but never substitutes
for the Hosted-bound functional proof. The retirement and attribution surfaces
are one-time cleanup, not compatibility paths. There is no automatic fallback
or raw Wrangler reversal.

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

- `CLOUDFLARE_API_TOKEN` (direct deploy/readback surfaces only; the executor
  reads its parent token from the closed secrets file below)
- `TAKOSERVER_INDEPENDENT_REVIEW`
- `TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH`
- `TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH`
- `TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH` (only while 0043 is pending)
- `TAKOSERVER_SIGNING_PUBLIC_JWK_PATH`
- `TAKOSERVER_SIGNING_PRIVATE_JWK_PATH`
- `TAKOSERVER_SPONSORSHIP_CREDENTIAL_PRIVATE_JWK_PATH`
- `TAKOSERVER_SPONSORSHIP_RECEIPT_PRIVATE_JWK_PATH`
- `TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH`
- `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH`
- `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` (operator identity owner proof)
- `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY`
- `TAKOSERVER_MANAGED_WORKER_PROVIDER_ID` (gateway/SQLite provider-pack identity)
- `TAKOSERVER_MANAGED_OBJECT_RECEIPT_SECRETS_PATH`
- `TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_REHEARSAL_RECEIPT_PATH` (fresh route-less authority `v1` in rehearsal or production only)
- `TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH`
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
different receipt path for each selected wave and, after the first, point
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

The receipt authority writes
`target.cloudflareProviderExecutor.providerInstallationId` into its
`MANAGED_PROVIDER_ID` fence. Its Worker name comes from that same target object.
There is no duplicate script-name or provider-installation environment input
that can redirect it. The installation id is deliberately not the gateway's
`TAKOSERVER_MANAGED_WORKER_PROVIDER_ID`, which remains the `cloudflare`
provider-pack identity used by the SQLite/gateway state.

`TAKOSERVER_MANAGED_OBJECT_RECEIPT_SECRETS_PATH` names one absolute, canonical,
link-free, owner-held, single-link `0600` regular file outside this repository.
It is between 3 and 16 KiB and uses the exact canonical UTF-8 JSON bytes below,
including two-space indentation and one final newline:

```json
{
  "TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID": "operator-supplied-access-key-id",
  "TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY": "operator-supplied-secret-access-key",
  "TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET": "operator-supplied-proof-secret"
}
```

Those are the complete names: a missing or extra property is refused. Each
value is nonempty, at most 4 KiB as UTF-8, already trimmed, and contains no
control character. The deploy surface holds the opened inode while reading and
requires its device, inode, size, modification time, and change time to remain
stable. It then creates an exclusive `0600` copy inside an owned `0700`,
canonical, link-free release root outside the repository, seals that copy with
the artifact, and passes only its path to Wrangler's single
`deploy --secrets-file` command. The materialized copy is removed after every
success and failure; the operator's source file is never changed or removed.
Its path never enters a child command. Wrangler necessarily receives the sealed
copy's path as the `--secrets-file` operand, but neither path contains secret
bytes, and no secret value enters argv, result JSON, generated Worker config, or
diagnostics.

`TAKOSERVER_MANAGED_OBJECT_RECEIPT_AUTHORITY_REHEARSAL_RECEIPT_PATH` names the
external evidence file for only the fresh route-less authority `v1` lifecycle.
Its immediate parent is an owned exact-`0700` directory outside every Git
repository, and the receipt itself is a no-overwrite, owned, single-link
exact-`0600` canonical JSON file. Rehearsal creates it only after the exact
route-less Worker readback; production consumes the matching bytes read-only
and checks them again immediately before publication. Integration apply and all
status actions do not read it. Routine code/secret publication over an existing
exact `v1` authority does not read or replace it.

`TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH` names one absolute,
canonical, link-free, owner-held, single-link `0600` regular file outside this
repository, no larger than 32 KiB. It has exact canonical UTF-8 JSON bytes with
two-space indentation and one final newline:

```json
{
  "CLOUDFLARE_API_TOKEN": "operator-supplied-parent-token",
  "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING": "operator-supplied-keyring"
}
```

No other key is accepted. Each value is nonempty, trimmed, free of control
characters, and at most 16 KiB as UTF-8. Status and reverse validate the source
and use only the token for direct Cloudflare readback/publication authority;
they do not copy or publish the file. Forward apply creates an exclusive `0600`
copy inside the owned `0700` release, seals it to `0400` with the module and
configuration, passes it to Wrangler's single `deploy --secrets-file`, and
removes it after both success and failure. The build child receives neither
secret. The source path and bytes never enter result JSON or diagnostics, and
the public Worker receives neither binding.

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
- Hosted receives no sponsorship bearer. Its sole authority is the exact
  service binding to the route-less sponsorship authority Worker.
- `TAKOSERVER_SIGNING_KEY` — registered by `takoserver-signing-key-register`,
  repaired by `takoserver-signing-repair`, rotated by
  `takoserver-signing-rotation`.
- `CLOUDFLARE_API_TOKEN` (provider parent authority) — operator-supplied only to
  `cloudflare-provider-executor` through
  `TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH`. It is not a public API
  Worker binding. A separate token with only deploy/readback permissions may be
  used by public deployment tooling; that process credential is likewise never
  published into the public Worker.
- `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` — operator-supplied independently to
  the public request-side runtime-input preparer and the private executor-side
  lease resolver. The executor copy is published only through its closed secret
  file. A public copy, when the target requires it, uses the reviewed Worker
  closure secret input; the two placements do not transfer the parent token.

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

For public parent-token retirement, a binding-release acknowledgement failure
stops before secret deletion and a deletion acknowledgement failure stops
without another delete. Run
`takoserver-public-parent-token-retirement --status` with the same environment
and commit. `legacy-unbound-parent-token` means no qualified binding release is
visible, `bound-parent-token` means the exact binding/source exists and the
token remains, and an exact `retired-canonical` or
`retired-secret-successor` with `ready: true` proves completion. Any other
history, source, executor, topology, binding, or secret inventory is a refusal;
do not use raw Wrangler to guess which effect occurred.

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
