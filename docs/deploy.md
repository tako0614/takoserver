# Takoserver deploy surfaces

This repository owns one deploy entrypoint for the public Host and service
surfaces. Its live contract is the owner-classified source of current public
surfaces and is read-only:

```sh
bun run deploy -- --contract
```

Every routine status or apply invocation has exactly this shape:

```sh
bun run deploy -- <surface> --status --environment=<integration|rehearsal|production> --commit=<40-hex-sha>
bun run deploy -- <surface> --apply --environment=<integration|rehearsal|production> --commit=<40-hex-sha>
```

Catalog Offering IDs are durable references shared by the catalog, provision
tokens, and Deployments: they must be 3–255 characters and use the token
reference alphabet (`A–Z`, `a–z`, `0–9`, `.`, `_`, `:`, `/`, `-`). Hosted
supply parsers retain their existing lower-case grammar for Offerings; this
bound does not tighten price-plan or other hosted reference fields.

The production-shaped D1 lane is deliberately narrower. Rehearsal and
production require exactly one approved next-wave selector, while integration
may use the same selector for one bounded audited wave:

```sh
bun run deploy -- takoserver-d1-schema --status --environment=<integration|rehearsal|production> --commit=<40-hex-sha> --through-migration=<0022|0028|0033|0036|0043|0044|0045|0046|0047|0048|0049|0050|0051|0052|0053|0054|0055|0056|0057>
bun run deploy -- takoserver-d1-schema --apply --environment=<integration|rehearsal|production> --commit=<40-hex-sha> --through-migration=<0022|0028|0033|0036|0043|0044|0045|0046|0047|0048|0049|0050|0051|0052|0053|0054|0055|0056|0057>
```

The fixed order is the one-time legacy production catch-up 0017–0022, then
0023–0028, 0029–0033, 0034–0036, 0037–0043, 0044, 0045, 0046, 0047, 0048, 0049, 0050, 0051, 0052, 0053, 0054, 0055, 0056, and 0057. A
selector is accepted only when its predecessor is the current lineage; an
incomplete wave can resume under the same selector, but cannot skip forward.
The 0048 wave appends the value-free Resource execution-evidence ledger after
the complete 0047 sponsorship authority lineage; it never rewrites 0047.
The 0049 wave preserves every prior artifact-consumer receipt while admitting
only active zero-consumption receipts with no manifest digest. Apply 0049
before publishing the Worker that can emit that new receipt.
The 0050 wave adds dormant workflow instance and event tables only; it does not
enable workflow execution. Apply 0050 before publishing code that requires those
tables.
The 0051 wave adds internal workflow execution ownership and step state after
0050. It does not alter the 0050 instance identity or enable an executor by
itself; apply 0051 before publishing code that requires those columns/tables.
The 0052 wave adds a durable termination-intent bit after 0051. It fences new
claims and terminal writes until the exact execution context is stopped, but it
does not change public workflow declaration identity or imply Workflow/Actors
support; apply 0052 before publishing code that reads or writes that bit.
The 0053 wave extends the existing self-host message ledger with shared Queue
consumer-generation custody and lease policy snapshots. Retiring a Consumer
stops new claims while preserving producers and backlog, and each in-flight
lease remains tied to its exact generation and policy; it does not adopt
provider-native backlog or change the public Queue contract. Apply 0053 before
publishing code that reads or writes the custody columns.
The 0054 wave adds only the ordered
`(queue_id, lease_token, visible_at_ms)` lookup used by Queue custody readiness
and bounded maintenance. It changes no Queue identity or delivery contract and
does not activate managed Queue delivery by itself; apply 0054 before publishing
code that uses the bounded readiness, claim, retirement, or retention-sweep paths.
The 0055 wave adds durable value-free Queue custody dead-letter transfer notices
after 0054. Terminal transfer writes the DLQ row, coalesced source-generation
notice, and source removal in one exact guarded batch; notice acknowledgement is
an exact source-generation/target/token CAS marker for a private target wake. It
changes no payload, endpoint, or public Queue contract; apply 0055 before
publishing code that uses transfer notices.
The 0056 wave adds Host-owned bounded VectorIndex SQL storage: immutable index
configuration, per-Resource record quotas, exact binary32 cosine records, and
typed equality filter terms. It changes no published identity, binding, or
provider catalog; apply 0056 only after the preceding Queue custody wave.
The 0057 wave adds receipt-coupled, provider-private execution-material tables
for immutable managed Worker Versions. It stores only bounded execution
descriptors and sealed values after 0056; it changes no published identity or
provider catalog, and activates no custody path. It does not apply any schema
automatically; protected environments require the explicit 0057 wave selector.
Integration without a selector retains the disposable fast path. When an
integration invocation selects a boundary, it seals and applies only that
audited wave, reports `evidenceClass: integration-protected-wave`, and never
reads or writes the rehearsal receipt chain. Both integration modes are
explicitly non-production evidence; a selected wave cannot be consumed by
rehearsal or production. The separate
`takoserver-d1-schema-rehearsal-baseline` surface is rehearsal-only, accepts no
selector, and takes only an exact empty database through the fixed 0001–0022
prefix without emitting a production rehearsal receipt.
The 0022 selector is not a general prefix-adoption mechanism. It accepts only
the exact audited 0001–0016 lineage and canonical 0016 application-schema shape,
rehearses the exact 0017–0022 bytes against an independently populated
0016-compatible database, and binds critical data counts to its standalone
immutable receipt. Production must present that exact receipt and the same
pre-shape and data digest before the first migration can run.

### Fresh integration storage

A disposable staging rebuild uses a separate integration-only surface. It does
not reset an existing database or relax its migration requirements:

```sh
bun run deploy -- takoserver-integration-storage-generation --status --environment=integration --commit=<40-hex-sha> --generation=<32-lowercase-hex>
bun run deploy -- takoserver-integration-storage-generation --apply --environment=integration --commit=<40-hex-sha> --generation=<32-lowercase-hex>
```

Both new resource names are `takoserver-i-<generation>`. The selected private
target supplies the integration account; its existing database and bucket are
never changed. Apply creates one new D1, proves it empty, applies the fixed
audited 0001–0057 lineage and verifies its canonical schema, then creates the
new R2 bucket. Creating the bucket last means older object operations cannot
reach it while 0043 runs. The ordinary schema and rehearsal lanes stay strict.

Disposal is a separate, one-way operation for an exact target-selected pair:

```sh
bun run deploy -- takoserver-integration-storage-disposal --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-storage-disposal --apply --environment=integration --commit=<40-hex-sha>
```

The only accepted target pairs are `takoserver-runtime-staging` with
`takoserver-objects-staging`, or a matching D1/R2 name
`takoserver-i-<32-lowercase-hex>`. Status and apply inventory the D1 by both its
exact id and name and the R2 by its exact name. Disposal refuses while any
current regular Worker settings/current serving Version or any current
Workers for Platforms dispatch-script binding references either selected
resource. Namespace names and script counts must reconcile, and incomplete or
failed reads stop before mutation. This coverage does not include historical
Worker Versions or external API clients. Apply requires
`TAKOSERVER_INDEPENDENT_REVIEW`, re-reads identities and bindings immediately
before mutation, deletes only the exact R2 bucket first, then the exact D1 id,
and succeeds only after authoritative absence readback. Cloudflare must accept
the R2 delete (so a nonempty bucket halts before D1); the command never wipes
objects, retries an unknown acknowledgement, rebinds a target, deletes Workers,
or runs migrations. Use the separate generation surface to recreate storage;
there is no rollback or adoption of same-name D1 resources.

The fresh empty database uses one sealed `wrangler d1 execute --file` import,
not the remote `migrations apply` query path. The import retains every audited
SQL byte and adds only Wrangler's migration-ledger DDL and an ordered ledger
insert after each migration. Output records both the source-lineage digest and
the derived import-file digest. The exact empty-state fence and complete
canonical-schema readback remain mandatory.

This transport distinction matters for the frozen 0047 trigger: D1's query
parser rejects an unparenthesized `CASE … END` inside a trigger body. A native
read-only `EXPLAIN` probe of that construct failed through the query path and
succeeded through import without changing schema or lineage; this matches
[Cloudflare workers-sdk #4727](https://github.com/cloudflare/workers-sdk/issues/4727).
Do not edit 0047, change its audited hash, or normalize away schema differences.
An existing database must use the explicit `--through-migration=0047` wave after
0046; that wave imports only the original 0047 SQL and its ledger insert, under
the existing selector, lease, receipt and readback rules. Later waves retain
their ordinary transport. The no-selector integration path spanning 0047 is
not covered by this workaround; use the explicit ordered waves instead.

Apply requires an independent reviewer and runs the migration gate once.
Status is read-only. Any existing name, even an empty resource, prevents apply.
A partial or unacknowledged creation is never retried, adopted or automatically
deleted: inspect that generation with status and keep the current target.
Successful output is only a candidate storage projection. It does not publish
a Host or WfP Worker, register signing keys, change a route or switch the
current target. Those steps retain their separate owning deploy surfaces.

### First integration Host publication

Once storage is ready, register the signing public key through
`takoserver-signing-key-register`. A genuinely absent public Host then uses:

```sh
bun run deploy -- takoserver-integration-worker-bootstrap --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-worker-bootstrap --apply --environment=integration --commit=<40-hex-sha>
```

Use a new Worker name and its exact account-owned workers.dev origin, with no
aliases. This is the public Takoserver API component; customer ModuleWorkers
still belong to WfP and use the managed app domain. Bootstrap never adopts a
zone route or custom domain. It uses the normal Host settings with workers.dev
enabled and preview URLs disabled so subsequent routine updates need no
special topology transition.

For apply, `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY` supplies exactly the
target-derived required secret files, including `TAKOSERVER_SIGNING_KEY`.
The private signing JWK must match the already registered active D1 key. The
temporary sealed JSON is passed once through `--secrets-file` and removed on
exit; no secret bytes reach the build or result. Apply also requires the
independent reviewer, complete schema, target composition and ready provider
dependencies. WfP targets use the private composition's wrapper to qualify its
executor; this public surface never implements that private backend.

Status does not read initial secrets. Apply refuses every existing or partial
Worker, including a previously successful bootstrap. After an uncertain
acknowledgement, inspect status instead of replaying creation. Success requires
the exact first Version, no predecessor, complete configuration/module
readback, the normal source-declared cron schedule and a successful public
product probe. Cleanup failures are reported explicitly; a failed cleanup must
not be treated as proof that temporary secret material was removed. Later updates and secret
changes use their existing lifecycle surfaces.

The integration JIT credential authority instead accepts exactly one of
`--issue`, `--status`, or `--revoke` through that same entrypoint, and the
durable organization API key surface accepts exactly one of `--mint`,
`--status`, or `--revoke`.

### Fixed integration organization bootstrap

Fresh integration storage can lack the fixed organization required by the JIT
credential lane. Once the operator has signed in normally, the existing Host
offers an integration-only bootstrap for that already-stored principal:

```sh
bun run deploy -- takoserver-integration-organization-bootstrap --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-organization-bootstrap --apply --environment=integration --commit=<40-hex-sha>
```

Both actions use the existing identity-only operator private key and exact
operator sign-in identity file, under the same custody as the organization-key
surface. Apply additionally requires independent review. The native current
Host Version must match the selected source, artifact and configured operator
key before the caller opens its private half. Each HTTPS request carries a
separate proof valid for at most sixty seconds; no session is created.

Status resolves the exact existing principal. Apply creates only
`org_takosumi_hosted_staging` named `Takosumi Hosted staging` and that principal's
owner membership, in one atomic batch. Exact existing state is a no-op. Partial
state, a different owner/name or identity mismatch are refused, not repaired.
There is no arbitrary organization selector, principal creation, schema change,
new key, Worker, or production/rehearsal mode. An acknowledged apply requires a
separately signed status readback. Never replay an uncertain apply: run status
first. The surface has no delete or automatic reversal; generation disposal is
a separate explicit operation. Ordinary organization creation and read-only
owner proof keep their existing semantics.

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

The private WfP composition owns its managed runtime, route-less authorities,
provider executor, and dedicated recovery/credential transitions. It may also
compose this public Worker lifecycle through its private qualifier, but public
Worker source and lifecycle authority remain here. Its operator commands and
secret inputs are documented in that repository's private deploy runbook; they
are not public Host surfaces.

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

No other public surface needs it: `takoserver-worker` shares the public
Worker's closure and its declaration is `takoserver-worker-authority-cutover`;
`takoserver-console` and `takoserver-site` fence no binding closure at all.
The closed managed-runtime lifecycle is owned by the private composition and
does not enter this public transition mechanism.

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

The public storage rebind is a separate, narrow delta available only in
`integration` on `takoserver-worker-authority-cutover`,
`takoserver-form-authority-worker` (the staging Form authority Worker), and
`takoserver-integration-form-authority-worker`. It requires the pinned closure
predecessor plus both flags:

```sh
--rebind-state-database-from=<predecessor-d1-uuid>
--rebind-object-bucket-from=<predecessor-r2-name>
```

These flags name only the predecessor's old `STATE_DB` UUID and `OBJECTS`
bucket name. Both must be strict lowercase identities and differ from the
successor. The successor is never a CLI operand: it comes only from the selected
target, whose D1 and R2 names must be the same exact
`takoserver-i-<32-lowercase-hex>` generation name. A read-only fence verifies the
D1 UUID-to-name mapping, R2 existence, exact audited 0001–0057 migration lineage,
and canonical migrated schema before preparation and immediately before upload.
Every other binding name, type, and field must still match the target exactly;
this does not alter migrations, runtime code, or the ordinary strict path.
Production and rehearsal reject the rebind before provider effects. The
operator gateway and storage-free identity probe do not accept it.
Only this integration storage-rebind apply uses the bounded publication gate:
the Host runs `bun run typecheck:worker`, then Bun tests matching
`storage rebind` in the Host closure-transition, Worker binding-state and
integration storage-generation test files; Form authority runs
`bun run typecheck:form-authority-worker`, then the equivalent filtered Form
transition, binding-state and storage-generation tests. Both gates finish
before Wrangler dry-run. Status is read-only, and every other Host/Form apply
retains its existing `bun run check` gate.

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
may carry `workerEndpointSuffix` or other pre-v2 topology. Author the new file
from the current `takoserver.deploy-target@v2` base values (account, public
Worker, D1, R2, origin, signing identity, and any other currently reviewed
public options). Commercial supply contracts and managed-runtime topology are
private composition inputs; they are not inferred or copied into this public
checkout. Replace every placeholder with reviewed evidence before selecting
the file, and keep all realized credentials and receipts outside Git.

The public parser validates the complete target and its Host-owned supplies.
It does not authorize a private provider account, customer credential, managed
dispatch namespace, or dedicated WfP Worker. Those values are composed and
qualified by the private deployment owner.

The private deployment owner creates and pins any managed dispatch namespace
before publishing a managed runtime. The public target only carries public
Host/provider identity and cannot be used to create, adopt, rename, or retire a
private namespace.

The public Form-authority lane reads the selected public Worker identity and
its own route/service closure at every mutation fence. Historical identity
adoption, managed-runtime topology, and incident recovery are private
composition concerns; the public target never infers them from a hostname or
from a stale descriptor. Use the public Form-authority procedure and its
read-only status output to settle any public descriptor drift before apply.

## Environment inputs and action matrix

`requiresEnv` in `takos.deploy-contract@v2` is the conservative union of the
environment variables needed by any action supported by that surface. It does
not mean that every listed variable is read by every action. Each surface's
obligation answer names the exact action condition; `--contract` itself reads
no operator input.

For every Cloudflare-owned public row below whose required condition says
“resolved Cloudflare credential”, an explicit `CLOUDFLARE_API_TOKEN` always
wins. In `integration`, an absent token may be resolved only from the exact
`wrangler auth token --json` object `{ "type": "oauth", "token": "..." }`.
That bearer is held in-process for direct REST readback only; it is never
logged or serialized, and Wrangler children receive no token environment and
use their stored OAuth profile. The OAuth extractor explicitly sets
`WRANGLER_WRITE_LOGS=false`, so Wrangler's mode-0644 debug log cannot persist
the bearer; its credential child-environment overlay contains no competing API
key, email, token variant, or unrelated secret. `rehearsal` and `production`
still require the explicit API token. Private WfP surfaces use a separate
contract and credential boundary; they are not rows in this public matrix.
The conservative `requiresEnv` union remains unchanged.

| Surface | Supported action(s) | Environment | Required input condition |
| --- | --- | --- | --- |
| `takoserver-worker` | `--status`, `--apply` | integration, rehearsal, production | Resolved operator deploy credential for both actions: explicit `CLOUDFLARE_API_TOKEN` or integration-only Wrangler OAuth fallback; rehearsal and production require the explicit token. This credential authorizes the deploy process and is never a public Worker binding. Managed-runtime supplies are private and are not accepted by this public surface. |
| `takoserver-worker-authority-cutover` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only; `TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY` for `--apply` only, and only when the declared closure delta names an added or rotated secret. Storage rebind flags are integration-only. |
| `takoserver-form-authority-identity-probe` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. `storageRebind` is refused because this Worker binds neither D1 nor R2. |
| `takoserver-form-authority-worker` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. Storage rebind flags are integration-only. |
| `takoserver-integration-form-authority-worker` | `--status`, `--apply` | integration only | Resolved Cloudflare credential for both (explicit token, or the integration OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority-operator-worker` | `--status`, `--apply` | integration only | Resolved Cloudflare credential for both (explicit token, or the integration OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority` | `--status`, `--apply` | integration only | Resolved Cloudflare credential and `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` for both (OAuth fallback is integration-only); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-integration-form-authority-deactivation` | `--status`, `--apply` | integration only | Resolved Cloudflare credential and `TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH` for both (OAuth fallback is integration-only); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. |
| `takoserver-org-api-key` | `--mint`, `--status`, `--revoke` | integration, rehearsal, production | `TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH` and `TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH` for all three; `TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY` for `--mint` only; `TAKOSERVER_INDEPENDENT_REVIEW` for `--mint` and `--revoke` only. No Cloudflare credential is read. |
| `takoserver-integration-e2e-credentials` | `--issue`, `--status`, `--revoke` | integration only | Resolved Cloudflare credential, `TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH`, and `TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY` for all three; `TAKOSERVER_INDEPENDENT_REVIEW` for `--issue` and `--revoke` only. |
| `takoserver-site` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback). |
| `takoserver-console` | `--status`, `--apply` | integration, rehearsal, production | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback). |
| `takoserver-integration-storage-disposal` | `--status`, `--apply` | integration only | Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. Exact target-selected storage names only; complete current regular + dispatch Worker binding inventory required. |
| `takoserver-d1-schema-rehearsal-baseline` | `--status`, `--apply` | rehearsal only | No selector is accepted. `CLOUDFLARE_API_TOKEN` for both; `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only. The receipt-path input is never read. |
| `takoserver-d1-schema` | `--status`, `--apply` | integration, rehearsal, production | Rehearsal and production require `--through-migration=0022|0028|0033|0036|0043|0044|0045|0046|0047|0048|0049|0050|0051|0052|0053|0054|0055|0056|0057`; integration may omit the selector for its disposable suffix or select one audited boundary, in which case it applies only that wave and reports `integration-protected-wave` evidence without entering the rehearsal receipt chain. Resolved Cloudflare credential for both (explicit token, or integration-only OAuth fallback); `TAKOSERVER_INDEPENDENT_REVIEW` for `--apply` only; one distinct `TAKOSERVER_D1_REHEARSAL_RECEIPT_PATH` per wave for `--apply` in rehearsal or production only. The one-time 0016→0022 receipt is standalone; ordinary chained rehearsal waves after 0028 require the immediately preceding `TAKOSERVER_D1_PREDECESSOR_REHEARSAL_RECEIPT_PATH`. A pending 0043 additionally requires `TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH` and the staged compatibility protocol below. |
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
  The Worker's `ready` result and discovery/OpenAPI HTTP 200 smoke establish
  runtime-ready Host state only; they do not establish that Form admission is
  ready or that an application is installed and serving HTTP. When live semantic
  implementation digest `I` differs from its predecessor, the existing owner
  admission workflow for that environment is the prerequisite for reconciling
  current support/activation heads; Host publication alone leaves those durable
  heads unchanged. See [Form authority plan and apply](form-authority.md#plan-and-apply)
  for the canonical workflow.
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

The private composition owns its managed runtime and dedicated lifecycle
surfaces. Their route-less authorities, dispatch namespace, provider executor,
credential retirement, and artifact-recovery procedures are not public
surfaces. A private composed Worker selector may qualify a public artifact
against that runtime, but it does not move public Worker implementation or
lifecycle authority out of this repository. The public Worker deploy below
remains the direct public Host/provider entrypoint and does not publish a
managed customer runtime.
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

  A public Worker never receives a private provider credential or managed
  runtime secret. Any private credential retirement is an explicit private
  authority mutation and is not smuggled through this public Worker deploy.
- `takoserver-form-authority-identity-probe`: one reviewed minimal read-only
  Worker upload in every Form-authority environment. Its permanent target-owned
  workers.dev endpoint exposes only `GET /v1/public-host-identity`, backed by a
  named service binding to the public Worker's identity RPC. It has no storage,
  secret, mutation RPC, custom domain, preview, or zone route. For an initial
  integration target with both native Workers absent, the existing surface
  internally selects `integration-host-only` and realizes only the Host id and
  public identity binding; it does not configure `FORM_AUTHORITY` or claim Core
  readiness. While Core remains absent, an existing exact Host-only probe may
  receive a profile-preserving code update under the normal source, predecessor
  and live-readback fences. Status recognizes that closure without requiring a
  Core deployment. Partial topology or binding drift is not an update path;
  the explicit `--add-binding=FORM_AUTHORITY` transition remains the sole
  Core-binding owner, including when Core has appeared since bootstrap.
  Status is ready only after actively calling that RPC bridge and matching Host
  id, served Version, outer artifact `A`, payload `P`, capability, and semantic
  `I`.
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
  the exact generated 17-Form unsigned fixture corpus, hard-refuses any other
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
  as a verification failure. Before this lane, when live semantic implementation
  digest `I` differs from its predecessor, reconcile the existing integration
  fixture Worker then operator gateway to the selected public commit:
  `takoserver-integration-form-authority-worker` →
  `takoserver-integration-form-authority-operator-worker`. Its signed status,
  one apply, and status/catalog readback are the existing sequence described in
  [the integration cutover order](form-authority.md#integration-cutover-order)
  and [plan and apply](form-authority.md#plan-and-apply). The existing Form
  admission prerequisites here include all 17 current package identities
  installed and implemented catalog entries supported with active activation
  heads matching `I`; unsupported identities may retain package/support heads
  but must have no active activation head. A successful/converged apply returns
  a zero-command next plan; these prerequisites do not by themselves prove
  application installation or HTTP serving. A dynamic host-only probe result with `publicIdentityRpcReady: true`
  can be reused in this sequence; probe code changes continue through its
  existing probe surface and checks.
- `takoserver-integration-form-authority-deactivation`: integration only and
  separately owned from normal activation. It always signs
  `activation.desiredActive: false`, emits only inactive activation successors,
  never loads Form packages or invokes package verification, and has no free
  mode, repair, or reverse flag. Status/apply/status proves all exact 17
  durable activation heads are absent or inactive; support and activation remain
  limited to the implemented catalog subset. It uses the same v2 signed
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
  refuses the pending 0049 migration.
  The 0050 successor adds only the dormant workflow instance and event tables;
  it does not enable workflow execution or change the 0049 receipt lineage.
  The 0051 successor adds internal workflow execution ownership and durable step
  state after 0050 without changing the public workflow declaration contract.
  The 0052 successor adds a durable termination-intent bit after 0051. It only
  fences exact execution claims and terminal writes; it does not imply Workflow/
  Actors support or change the public workflow declaration contract.
  The 0053 successor extends the existing self-host message ledger with Queue
  Consumer generations, retirement state and snapshotted retry/dead-letter
  lease policy. It preserves producer admission and backlog across Consumer
  retirement; it does not introduce provider-native queue authority or alter
  the public Queue contract. Routine Worker publication still refuses the
  pending 0053 migration.
  The 0054 successor adds only the ordered Queue custody readiness index needed
  for bounded scheduling and maintenance. It does not activate managed Queue
  delivery or adopt provider-native backlog. Routine Worker publication still
  refuses the pending 0054 migration.
  The 0055 successor adds durable value-free Queue custody dead-letter transfer
  notices. Terminal transfer coalesces an exact source-generation/target marker
  with the DLQ insert and source removal in one guarded batch; private callers
  wake the exact destination authority and acknowledge by source-generation,
  target, and notice token. Routine Worker publication still refuses the pending
  0055 migration.
  Routine Worker publication still refuses any pending schema migration.
  The exceptional 0022 selector is a
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

  Integration may select one of the same audited boundaries to exercise a
  bounded protected wave. The selector is checked against the immutable
  0001–0057 names and SHA-256 inventory, so a checkout with unreviewed 0058+
  migrations is refused before any provider command. The selected integration
  lane keeps every named data preflight, lease, compatibility fence, and
  mutation/readback check, but it applies only the selected through-prefix and
  emits no rehearsal receipt or predecessor link. Its
  `integration-protected-wave` result is never accepted by rehearsal or
  production; the no-selector integration lane remains the disposable suffix
  path described above.
  If the selected wave includes 0043, integration uses the staged compatibility
  protocol below. Keep its maintenance projection while the selected 0044–0057
  trail is pending; a Cloudflare provider executor (CPE) service is optional
  and may be introduced only after 0045 and its dependencies are settled. The
  normal Host closure retires the quiescence mode only after the selected schema
  lineage is settled, with no rehearsal receipt chain created for integration.

### 0043 artifact blob-I/O compatibility protocol

Migration 0043 changes the authority immediately around R2 `PUT` and `DELETE`.
An older invocation cannot see its lease table, and a D1 trigger cannot
intercept an object request that has already crossed into R2. Therefore 0043 is
not migration-first compatible. It remains blocked until this exact staged
protocol has removed every older object-I/O invocation:

1. Add `"artifactBlobIoMode": "pre-0043-quiesced"` to the operator-private
   deploy target. Publish the selected accepted commit through
   `takoserver-worker-authority-cutover`, using the current Version as
   `--closure-predecessor-version` and
   `--add-var=TAKOSERVER_ARTIFACT_BLOB_IO_MODE`. This exceptional target is
   allowed only while the exact ordered pending lineage through 0043 is present,
   followed only by an optional accepted contiguous 0044–0057 tail. It returns
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
     "environment": "<integration|rehearsal|production>",
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
4. Run `takoserver-d1-schema --status --environment=<integration|rehearsal|production> --through-migration=0043`. Readiness now requires the two immutable compatibility Versions, disabled public preview URLs, unchanged deployment history, an exact receipt created after and bound to both deployment and Version identities, and zero active-root/deleting-candidate conflicts. Apply re-reads every item at qualification, at the final fence, and in mutation phase immediately before the first migration. A preview setting, history, receipt, target, or count change prevents the Wrangler apply; redeploying even the same two Versions invalidates the receipt and requires another drain proof. When a later boundary 0044–0057 is selected, the sealed artifact retains the exact audited 0001–0043 prefix and adds only the ordered suffix through that boundary; a later selector cannot skip a still-pending boundary.
5. After the exact 0043 lineage reads back, keep `artifactBlobIoMode` and the maintenance projection while any selected 0044–0057 suffix remains pending. Run those accepted boundaries in order, retaining the exact through-0043 prefix and applying only the requested trailing wave. The new code admits a per-digest `write_admitted` owner before each PUT and advances a blob delete through `delete_claimed` then `delete_started` before its one external DELETE. Its immediate rollback remains the compatibility Worker, so rollback is service-denying but cannot run historical object I/O. The 0052 schema/quiescence compatibility tail does not itself provide Workflow or Actors support; 0053 adds Queue custody state, 0054 its bounded readiness index, 0055 its durable transfer notices, and 0057 adds provider-private execution material only, none of which alters this protocol.
6. A target that declares a Cloudflare provider executor (CPE) service may add that service only after migration 0045 and all of the CPE's declared dependencies have read back as settled. CPE is optional for a generic OSS Host and is not a prerequisite for settling the available accepted schema lineage.
7. Once the selected schema lineage is settled, publish the normal Host closure with the serving compatibility Version as `--closure-predecessor-version` and retire `TAKOSERVER_ARTIFACT_BLOB_IO_MODE`. If the target declares CPE, add its exact target-derived service binding in this same closure; a target without CPE retires the mode and exits without requiring WfP topology. Do not remove maintenance mode or add CPE before the applicable boundary and dependency proofs.

Before step 4, aborting the cutover may deliberately restore an older Version,
but doing so invalidates and requires deletion of any drain receipt. From the
first 0043 mutation onward, never select an older pre-compatibility Version,
including through the dashboard or a manually chosen Version rollback. The
owning deploy output names only the safe immediate predecessor. Subsequent
normal publications make lease-aware Versions each other's rollback; the
compatibility Version can then age out of the immediate rollback position.

#### Legacy composed Host secret custody

A pre-0043 composed Host may still have both `CLOUDFLARE_API_TOKEN` and
`TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN` in addition to its target-required secrets.
The compatibility publications may carry that exact pair unchanged. This is
not a new secret requirement for an OSS Host: its ordinary target-derived secret
inventory remains valid. Single legacy keys, unknown extra keys, mixed custody
between the two compatibility Versions or between the served Version and live
secret store, and key rotation are not accepted by this exceptional entry path.
Ordinary target-secret recovery may still carry a store-ahead secret after a
rollback; that does not permit a partial legacy pair.

For the retained pair, use the existing retirement owners to complete the exit:

1. Settle the selected schema lineage and qualify the declared CPE dependencies
   before removing maintenance mode.
2. With the normal target, `takoserver-public-parent-token-retirement` first
   publishes the normal Host with its CPE binding while carrying both legacy
   keys, then deletes only the Cloudflare key. It does not copy or rotate secret
   values.
3. If route and materializer removal already predate this schema transition,
   `takoserver-sponsorship-public-route-retirement` settles that current fact in
   D1 using a fresh cutover proof and repeated exact readback. Its predecessor
   and successor are the same serving Version; it does not upload a Worker or
   invent a historical receipt. Topology retirement is already complete in this
   narrow path and does not authorize another apply or reversal.
4. `takoserver-hosted-token-retirement` consumes that completed route operation
   and its current proof before deleting only the Hosted key. Lost-acknowledgement
   settlement still requires the exact recorded operation and successor.

The receipt-proved Hosted-key deletion completes the exit. A later canonical
metadata-attribution repair is optional, and must retain that same completed
deletion as its authority; attribution alone cannot substitute for its receipt.

These owners recognize only the bounded, ordered compatibility and retirement
history with matching source, script, closure and durable identities. An
arbitrary matching ancestor is not authority. Do not begin the maintenance entry
until the complete exit and the required operator proof inputs are available.

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
semantic identity. A Host code publication with unchanged `I` does not itself
require reconvergence; other existing drift still follows its owning workflow.
A digest change therefore follows the canonicalized actual
emitted Worker bundle/import closure and those derived inputs, not every
docs/test/deploy-only or otherwise unrelated source-commit diff.

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

- `CLOUDFLARE_API_TOKEN` (direct public deploy/readback surfaces only)
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
- `CLOUDFLARE_API_TOKEN` — operator-supplied to the public deploy/readback
  surface when its contract requires direct Cloudflare authority. It is never
  published into a public Worker binding.
- `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` — supplied only through the reviewed
  public Worker closure input when the selected public surface requires it.

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
deactivation surface with `--status` and require its exact 17-head
absent-or-inactive proof before any fresh decision. A Worker rollback cannot
reverse the append-only activation event; use the normal activation surface
for explicit reactivation. When a transition descriptor selected the
predecessor, repeat status with that same descriptor; it never converts a mixed
or already-advanced Worker topology into permission to sign another mutation.
