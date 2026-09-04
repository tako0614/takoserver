# ADR 0007 — ObjectBucket joins the implementation catalog

**Status:** accepted, 2026-09-02; amended 2026-09-03

> **Amended twice on 2026-09-02 and again on 2026-09-03; the body below is the first statement of
> each.** Where it says a self-host "realizes none" of the ObjectBucket supply
> and records the Form with an EMPTY operation set, that is no longer true: a
> self-host now holds object bodies under its data root and their metadata in
> its control database, and its Provider Pack owns both halves of the
> `module-worker.object-bucket` materialization. The rule is unchanged — an
> identity capability is admitted with the operations its Form declares exactly
> where the Host realizes the supply — but the self-host's answer to it moved,
> and its digests moved with it. See
> [Second rotation](#second-rotation-the-self-host-realizes-the-supply). What
> the managed Workers-for-Platforms lane turned out to need before anyone
> composes it is recorded separately, at the end.

## Decision

The exact current `edge.forms.takoform.com/ObjectBucket` package at definition
version `0.1.0` — schema digest
`sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557`,
package digest
`sha256:46cd435d838d89de641d38180680e99c8bc7be1a3ae9c123494440d3e6e202ec`,
from the imported publisher set `forms/sets/e7f8a39311dd011b8467e97e7f300cabb9a6b06c` —
enters `YURUCOMMU_FORM_VERSIONS` and `YURUCOMMU_IDENTITY_CAPABILITY_KINDS` in
`src/takoform/implementation-catalog.ts`. A Host may therefore support and
activate it. It was previously installed with empty executable operations,
never supported and never activated.

Nothing about the derivation rule changes. Executable operations remain the
intersection of the exact Form package's declared lifecycle, the code-owned
capability manifest, and the handlers present in the sealed runtime payload,
with operator input narrowing-only. The ObjectBucket package declares
`create`, `read`, `delete`, `import`, `observe` and no `update`, so `update` is
never admitted however wide the other two sets are. `ObjectBucket` is an
identity capability, so `yurucommuLifecycleCapabilityManifest` reports it as
capable only when the Host realizes an ObjectBucket supply: a Host without one
installs, supports, and activates the Form with an EMPTY operation set, which
is the honest statement that the Form is known here and none of it executes.

Two Hosts exist. At the time this decision was taken they differed: the public
Worker realized the supply and served all five operations, and a self-host
realized none — its composition built no ObjectBucket Offering at all, because
the machine had no `edge.objects` backend — so
`scripts/selfhost-form-admission.ts` narrowed the capability set it records to
the identity Forms that composition did offer. The
[second rotation](#second-rotation-the-self-host-realizes-the-supply) closed
that gap; the rule that produced both answers is the same one.

The four other installed-but-unsupported packages — `ActorNamespace`,
`DurableWorkflow`, `StaticAssetBundle`, `WorkerCustomDomain` — are unchanged.
They stay installed, unsupported, and without an activation head.

## What each runtime hands the Worker

Both Cloudflare Worker backends accept `bucketBindings`. The self-host runtime
accepts one too and hands over something different; it is described after the
two Cloudflare backends.

- The **ordinary-workers backend** — the production path in an operator's own
  Cloudflare account — uploads the tenant's exact bundle bytes with no wrapper.
  It has no place to interpose a facade, so the declared name carries
  Cloudflare's native R2 binding, exactly as `sqliteBindings` already carries a
  native D1 binding and `kvBindings` a native KV namespace on that same
  backend.
- The **managed (Workers-for-Platforms) backend** keeps the customer module as
  a user Worker and projects the exact `edge.objects` facade from the
  provider-authored wrapper. The raw `r2_bucket` binding and a cross-script
  receipt Durable Object namespace are hidden bindings protected from module
  imports by `disallow_importable_env`; only the facade enters handler `env`.
  The namespace points to a dedicated route-less authority Worker, not the
  internet-routed dispatch gateway. Its SQLite Durable Object owns create,
  part, complete, and abort receipts across isolate eviction; only that
  authority Worker holds the R2 S3 keys and proof secret. Its opaque instance
  identity derives from provider
  authority, ObjectBucket Resource UID, Deployment incarnation, and Resource
  generation, never from the bucket's display or native name.

On the accepting backend the validation is: one runtime Binding per declaration
in the same order, the exact `module-worker.object-bucket@1.1.0` identity with
its exact schema digest, a relation at `/bucketBindings/<index>/resource` whose
`targetUid` equals the Binding's, a declaration `name` equal to the Binding's
name, a JavaScript-identifier name shared with no other binding of any type on
the same Version, an active target Deployment in the same provider
installation, and a material naming a bucket this provider derived. Any
mismatch fails before a single Cloudflare call.

The ordinary-workers shape is a deliberate, named divergence from ADR 0005's
consequence that "Worker code receives the exact Binding facade … not a
provider-native R2 or S3 client", and ADR 0005 now carries an amendment marker
pointing here. Interposing a facade on the ordinary-workers backend means rewriting
every Worker Version's `main_module`, which changes what the immutable
`WorkerBundle` means; that is a separate decision and is not taken here. Until
it is, the honest statement is: on the ordinary-workers backend the portable
Binding selects and materializes the bucket, and the runtime shape under the
declared name is Cloudflare's own. Nothing about bucket name, region,
endpoint, credential, or supply document reaches the Worker either way.

The **self-host runtime** accepts one as well, and this is where the runtime
answers separate for a reason rather than by accident. It publishes every
Worker Version through a Takoserver-owned entrypoint, so it has the place to
interpose a facade that the ordinary-workers backend does not. Its multipart
receipts are rows in the control database; the managed backend instead owns
them in the route-less authority Worker's receipt Durable Object.
So `env.MEDIA` there is the exact `edge.objects` facade of ADR 0005, over an
object plane on the machine itself. The validation below is the same
validation; only the material differs. See
[Second rotation](#second-rotation-the-self-host-realizes-the-supply).

The consumer importer added to the Cloudflare runtime-binding materializer
reverses the note that "an ordinary Worker adapter must not consume this export
at all". A native R2 binding keeps multipart state at the provider, and the
managed facade now keeps the validation and retry ledger in a provider-owned
Durable Object. The materializer is a Provider Pack capability, so the route it
publishes is the pack's; each backend still validates its own runtime authority
before any Cloudflare mutation.

## Naming and import

The current ObjectBucket's native name is derived from the Resource
*incarnation* — tenant, Space, name, and Resource UID — not from the address
alone, for the reason the self-host KV store already follows: a customer who
destroys a bucket and declares one with the same name has asked for an empty
bucket, and recomputing the address alone would hand them the old bytes
whenever a destroy did not finish. A create refused at that derived name, and a
destroy R2 refuses while the bucket is still present, are each reported as a
named non-retryable failure proven by one readback rather than as a generic
classification a Host would keep retrying.

`import` is the one lifecycle whose native address comes from the caller, and
the Cloudflare adapter's account credential reaches every object in the
operator's account. Adoption is therefore fenced, for every Form this adapter
serves, to the exact native id this Host itself derives for the Resource address
being imported onto: the offering's Cloudflare kind must match, and the native
name must equal the derived one, before `observe` is called. That keeps the
ordinary import onto an address a configuration already manages — the case
migration 0019 records as worth supporting, and the documented repair after a
lost create acknowledgement — and refuses another tenant's object and the
control plane's own `takoserver-objects-production` alike, with no API call. A
kind whose native name Cloudflare assigns (a KV id, a D1 uuid, a queue id) or
that a relation supplies has no name to recompute, so its adoption fails closed.

Migration `0039` states the matching durable invariant: the live native claim is
unique per provider installation rather than per tenant, because one provider
installation is one account and one native object has one live claim in it. A
database that already carries a cross-tenant pair refuses the migration by name
instead of failing inside `CREATE UNIQUE INDEX`.

## Authority and reconvergence

The change rotates both the capability digest and the semantic implementation
digest. Support and activation are append-only events keyed on the semantic
implementation digest, so every advertised environment must reconverge
explicitly. An in-place edit of a durable head is never the mechanism; a
Worker-version rollback alone never reverses an append-only activation event.

Before this change both Hosts served the same four-kind capability manifest and
therefore one `capabilityDigest`. They no longer do: the public Worker realizes
an ObjectBucket supply and a self-host does not, so each Host's manifest names
its own supply set.

| identity | before | after |
| --- | --- | --- |
| public Worker `capabilityDigest` | `sha256:630899ce5e482e7e274c87dab17d74edd904620852a71c2b021aade236a1ea73` | `sha256:a5bc1508638fb1c47182d4ee68be5eedb7acc050394bd3507b532a78daacc024` |
| self-host `capabilityDigest` | `sha256:630899ce5e482e7e274c87dab17d74edd904620852a71c2b021aade236a1ea73` | `sha256:0d471b6ebe2bf43c60ba2b8a000cd8aa2293c0cc9b4b4a048b9abc1d75a13669` |
| self-host `implementationPayloadDigest` | `sha256:1f57138d676492000ed44f1ee6c5af180bc13c932128c0286c4353ec7eac26a6` | `sha256:da5ff6f98d0cd147cdb74c168e271ab9576c109c82313c14fa4ee0cd1c650ac4` |
| self-host `implementationDigest` | `sha256:3788374901bbbb413a8be78d56d1220a3b82d352c12f03d2ce32b0a10454d756` | `sha256:6e566932ddad3ef48360d8f3ee643c2ccdf2eb3a05307c483e225f6d6f622459` |

The self-host `capabilityDigest` rotates even though its supply set is
unchanged, because the manifest now carries `ObjectBucket` with an empty
operation set where before it carried no such key at all. The public Worker's
`implementationDigest` additionally binds the sealed runtime payload `P`, so
its value is fixed at deploy time by the exact source commit and is not
reproducible from this document.

`tests/takoform-implementation-catalog.test.ts` pins both Hosts' new values and
names this ADR. Changing those literals again is an explicit reconvergence
decision, not a stale-expectation refresh.

### Second rotation: the self-host realizes the supply

A self-host now has an `edge.objects` backend. Object bodies are files under
`<data root>/selfhost/objects/<bucket>/` and their metadata is rows under
migration `0041`; the object data plane serves the Binding beside the KV, SQL,
and queue planes; and `createSelfhostRuntimeBindingMaterializer` publishes both
the target export and the consumer import of `module-worker.object-bucket`, so
the route resolves and a `bucketBindings` declaration is materializable. The
self-host Worker backend is a wrapper, so what the declared name carries there
is the exact `edge.objects` facade of ADR 0005 rather than the native binding
the ordinary-workers backend carries.

Two things follow, and only these two. `SELFHOST_IDENTITY_CAPABILITY_KINDS`
names `ObjectBucket`, so a self-host admission records the Form with the five
operations it declares rather than an empty set — `update` is still never
admitted, because the Form does not declare it. And the self-host's capability
manifest is once again the same five-supply manifest the public Worker serves,
so the two Hosts share a `capabilityDigest` again while keeping distinct
implementation digests: a self-host binds the manifest through
`takoserver.selfhost-form-implementation@v1`, and the public Worker
additionally binds its sealed runtime payload.

| identity | after the first rotation | after this one |
| --- | --- | --- |
| self-host `capabilityDigest` | `sha256:0d471b6ebe2bf43c60ba2b8a000cd8aa2293c0cc9b4b4a048b9abc1d75a13669` | `sha256:a5bc1508638fb1c47182d4ee68be5eedb7acc050394bd3507b532a78daacc024` |
| self-host `implementationPayloadDigest` | `sha256:da5ff6f98d0cd147cdb74c168e271ab9576c109c82313c14fa4ee0cd1c650ac4` | `sha256:b7ea4f2da3f5dca05827442cb9a9f2419bf2063e3a9457cf6f97b7409da9f2c4` |
| self-host `implementationDigest` | `sha256:6e566932ddad3ef48360d8f3ee643c2ccdf2eb3a05307c483e225f6d6f622459` | `sha256:8c9c862558356c41c487e8a18a020fedb0a5eb970046bfbac3664376420f1962` |

The public Worker's identities are untouched: its supply set did not move, and
the exact publisher-set import, its receipt, catalog projection, and authority
closure are untouched here as they were there.

Reconvergence is the same append-only event chain, run the same way. A machine
already converged on the predecessor identity emits exactly the support and
activation successors the rotated implementation digest requires, plus the
ObjectBucket operation-set delta:

```sh
bun scripts/selfhost-form-admission.ts <organizationId> <space> \
  --data-root .takoserver --host-id https://takoserver.example \
  --core-verifier http://127.0.0.1:8080            # plan only
bun scripts/selfhost-form-admission.ts <organizationId> <space> ... --apply
```

**What a self-host provider does with the Form.** `create` derives the bucket
name from the Resource INCARNATION — tenant, Space, name, and Resource UID —
for the reason stated under [Naming and import](#naming-and-import): a customer
who destroys a bucket and declares one with the same name has asked for an
empty bucket. `delete` refuses a bucket that still holds an object, as a named
non-retryable failure proven by one readback; the Form declares no field that
could ask this Host to empty one, and emptying a customer's storage is not a
decision a lifecycle delete may take. `import` is fenced to the exact
incarnation this Host itself derives for the Resource address being imported
onto, so another tenant's bucket and a name this Host never minted are both
refused before anything is read.

An unfinished multipart upload is not one of those objects, and the delete drops
it rather than refusing on it. Durability is what lets this Host serve
`bucketBindings` across restart — and durability is also what would have turned
a lost upload id into a permanent lifecycle deadlock, because the id lives only
in the isolate that minted it and the Form's Binding declares no operation that
enumerates open uploads. A refusal there would tell a customer to empty a bucket
that every operation they hold reports as empty. So the destroy takes the
receipts and their part files with everything else, and the maintenance tick
expires uploads older than seven days on buckets nobody is destroying. The
absence readback still counts an upload as presence: a completed destroy leaves
neither, so both being zero is what proves the destroy ran, and that is a
different question from what the delete must refuse.

### Deploy-target obligation

`assertPublicFormCapabilityTarget` now proves two supplies: `edgeSupplies` must
carry exactly the four hosted edge identity kinds, and `objectBucketSupplies`
must carry at least one Cloudflare supply. Cloudflare is required by name
because it is the one Provider Pack whose materializer owns both the target
export and the consumer import of `module-worker.object-bucket`; a Wasabi-only
supply cannot materialize the Binding and is refused before deploy rather than
at apply.

### Production reconvergence

Production has no operator ingress: the route-less production Worker can be
deployed and read back, and its RPC apply is implemented, but no production
surface signs and forwards a plan or apply request. Adding that ingress remains
a separate authority-surface decision. No command sequence is printed here,
because none exists: the surfaces production does have deploy and read back
Workers, and deploying a Worker is not an append-only activation.

The integration environment, which does have an ingress, reconverges through
its own operator surface with the same append-only semantics:

```sh
bun run deploy -- takoserver-form-authority-identity-probe --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-form-authority --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-form-authority --apply --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-form-authority --status --environment=integration --commit=<40-hex-sha>
```

No production admission is performed by adopting this ADR. Deciding to deploy
remains the operator's, and a green gate is not that decision.

### Self-host reconvergence

A self-host records the chain itself. The command re-plans from the durable
heads, so a machine already converged on the predecessor identity emits exactly
the ObjectBucket install/support/activation delta plus the support and
activation successors the rotated implementation digest requires:

```sh
# 1. start the released Core verifier with the digest this checkout computes
cd services/takoform-core-verifier && go build -o /tmp/takoform-core-verifier ./cmd/server
TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST=<sha256:…> /tmp/takoform-core-verifier &

# 2. stop the Takoserver process (the file object store admits one writer), then
bun scripts/selfhost-form-admission.ts <organizationId> <space> \
  --data-root .takoserver --host-id https://takoserver.example \
  --core-verifier http://127.0.0.1:8080            # plan only
bun scripts/selfhost-form-admission.ts <organizationId> <space> ... --apply
```

## Consequences

- Readback reports ObjectBucket as `installed: true`, `supported: true`, and a
  present active head with that Host's new implementation digest, on every Host
  that has reconverged — with the five declared operations where the Host
  realizes an ObjectBucket supply and an empty operation set where it does not.
  A Host that has not reconverged is unchanged and keeps serving the
  predecessor identity until an operator applies.
- The integration fixture corpus grows from 12 to 13 packages, and every
  command count derived from it moves with it. `bun run check:form-corpora` and
  `bun run check:integration-form-packages` are the gates.
- The exact publisher-set import — its receipt, catalog projection, and
  authority closure — is untouched. All 17 packages were already installed;
  only the supported and activated subset moved.
- A self-host records the current ObjectBucket as installed, supported, and
  activated with the five operations its Form declares, and executes them. Its
  retained v1beta1 ObjectBucket drain capability is untouched and remains
  observe/delete only, under the address-derived `local-bucket:` names its
  already-recorded Deployments carry.
- All three runtimes bind `bucketBindings`: the ordinary-workers backend hands
  Cloudflare's native R2 binding to the declared name, while the managed and
  self-host wrappers hand it the exact `edge.objects` facade. Managed receipts
  live in the provider-owned route-less authority Worker; self-host receipts
  live in its control database.

## Amendment — 2026-09-02: the managed lane's pre-shipment defects

The section above says what each runtime hands the Worker. An adversarial
review of the managed (Workers-for-Platforms) backend found that the sentence
was not the whole truth, and that the lane could not have worked at all. No
production composition builds it — `src/providers/cloudflare.ts` defaults to
`ordinary-workers` and only tests construct `CloudflareWfpBackend` — so no
tenant was affected, and none of the below is a migration. It is what had to be
true before anyone composes it.

**The wrapper's projected `env` never hid anything.** A binding belongs to the
script it is declared on, and the runtime hands every one of them to every
module that script runs — `import { env } from "cloudflare:workers"` included.
So the internal `__TAKOSERVER_SQLITE_<i>` Durable Object namespace, the
`__TAKOSERVER_OBJECTS_<i>` R2 handle, and the managed receipt namespace would
be one import away from tenant code, along with every `secret_text` value.
`tests/cloudflare-managed-worker-wrapper.test.ts` runs the generated wrapper
under the pinned workerd and shows the raw bucket being written through that
route. Every managed tenant user Worker is therefore now uploaded with
`compatibility_flags: ["disallow_importable_env"]`, which empties the importable
environment while the handler's own `env` argument keeps its bindings; the
release readback accepts exactly `main_module`, `compatibility_date`,
`compatibility_flags`, and `bindings`, and refuses a release whose settings do
not carry the flag. The self-host backend has set the same flag for the same
reason, and calls it the second lock rather than the first.

**What remains, and why.** On this lane the flag is the only lock. The raw
handles stay declared on the tenant's own script: moving the data handles behind
a Takoserver-owned Worker reached over one service binding — with authority
derived from the dispatch-namespace caller identity rather than from anything
the tenant supplies — is the structural answer, and it is a larger change than
this one (a new sibling in the dispatch namespace, its own authority derivation,
and a second seam for every `edge.*` facade to cross). It is not taken here.
Until it is, a defect in `disallow_importable_env` itself, or a release uploaded
without it, is a tenant reading a raw namespace handle. The readback is what
makes the second of those visible.

**The Durable Object was unreachable.** `TakoserverManagedWorkerSqlite` did not
extend `DurableObject` from `cloudflare:workers`, so on a real stub it answered
only `fetch` and every RPC the provider and the wrapper make would have thrown.
It now extends it, in
`src/providers/cloudflare-managed-worker-sqlite-object.ts`, and delegates to
`ManagedWorkerSqliteCore`, which keeps the behaviour testable against a faithful
fake storage. Running it under the pinned workerd
(`tests/cloudflare-managed-worker-sqlite-object.test.ts`) found three more
defects no fake could: a projected row was a null-prototype object, which
Cloudflare's RPC serializer refuses, so no `SELECT` could ever have returned;
destroy enumerated `sqlite_schema` and tried to drop the runtime's own `_cf_KV`
table, which fails `SQLITE_AUTH` and took the whole destroy down with it; and
the `pragma_*` table-valued functions answered where the `PRAGMA` keyword is
denied.

**The admin plane trusted the caller.** Every field of a SQLite authority tuple
— provider id, Resource UID, generation, an operation id derived from the
descriptor digest, and that digest over the desired spec — is derivable by the
customer whose Resource it describes. So comparing the tuple authorized nothing:
anyone who could address the namespace could claim an unclaimed instance, replay
a migration suffix onto their own database behind the Host's back, or destroy
it. Each of the five admin RPCs now carries an HMAC over the label
`takoserver.managed-sqlite-admin-proof@v1`, the operation name, and the
length-prefixed tuple, under the gateway's own
`TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET` binding — a binding declared on the
gateway Worker, which a tenant's dispatched Worker never holds. A proof names
one operation, so an `inspect` proof is not a `destroy` proof.

An operator provisions that secret out of band, with the same value the provider
composition seals with. The deploy surface neither mints nor uploads it, because
a value that surface does not hold is not a value it can prove; its binding
closure recognises the secret without requiring it, and still refuses any other
binding. **Until it is provisioned the Durable Object executes no admin
operation at all** — which is the honest posture for a lane nothing composes,
and the thing to fix first for anyone who wants to.

The Durable Object instance name still leaves as the `databaseId` Output. The
SQLiteDatabase Form declares no outputs, so this is a Host invention and nothing
in the portable contract requires it — but the ordinary-workers backend emits
`databaseId` too, as the native D1 id its own binding closure reads, and the two
backends serving one Form should answer the same question the same way.
Replacing the managed one would mean minting a second stable identifier with no
source of truth, and the name is no longer load-bearing: knowing it buys nothing
now that every admin operation wants a proof and the runtime facade is the only
other way in.

**The release script name moved.** `compatibility_flags` is part of
`settingsIdentity`, which is part of the release descriptor digest, which is the
`tsr-<digest>` script name. So the same desired state now names a different
release than it did before this change, and `observe()` on a WorkerVersion
recorded under the old digest would return `conflict`. There are no such
records: no composition builds this backend, so no receipt exists in any
environment. The managed lane starts fresh, and no re-key path is provided
because there is nothing to re-key.

## Amendment — 2026-09-03: durable managed multipart authority

The managed Workers-for-Platforms backend now accepts the same exact
`module-worker.object-bucket@1.1.0` materialization as the other Cloudflare
backend. This does not add a Form, Binding, output, credential, service, or
tenant-visible method. The customer module remains a Workers-for-Platforms user
Worker and receives only the existing nine-method `edge.objects` facade.

Before upload, the managed provider closes the declaration, BindingRef,
relation pointer and pattern, target UID, exact ObjectBucket Form identity,
Space, positive generation, active Deployment tenant and provider installation,
Deployment native id and output, and the provider-private R2 material. It then
adds two hidden capabilities to that immutable user Worker Version: the raw R2
bucket and a cross-script namespace for `TakoserverManagedObjectReceipt` on the
dedicated route-less receipt-authority Worker. `disallow_importable_env` keeps
both unavailable to customer module imports; the wrapper's projected handler
environment contains only the facade. The internet-routed dispatch gateway
retains its original SQLite Durable Object and dispatch namespace only.

One SQLite Durable Object is selected by a SHA-256 name over a length-prefixed
tuple of provider id, ObjectBucket Resource UID, Deployment incarnation id, and
Resource generation. The bucket's desired name and native R2 name are absent
from that identity. Every runtime proof is an HMAC over that exact tuple and
bucket; inspect, prepare-destroy, and commit-destroy use a separate label and
operation-scoped proof. The Object validates its provider id, private S3
credentials, proof secret, request shape, and proof before schema or provider
mutation. These credentials exist only as bindings on that route-less authority
Worker and are never gateway/public-API bindings, tenant environment, result,
error, or stored receipt data. The first authorized call
claims the tuple and bucket in durable storage, so a misaddressed or colliding
capability cannot silently reuse another authority.

The receipt orchestration is the sole native multipart-create authority. The
tenant wrapper has no raw create call. A private bounded SigV4 R2 S3 adapter
lists multipart uploads for the exact object key; the Object persists that
upload-id baseline, installs a recovery alarm, and atomically consumes the one
native-create grant before it sends one create. One synchronous post-create
list delta is adopted. A zero delta moves to `create_reconciling` and retries
the list without recreating. Multiple deltas, an acknowledged-id disagreement,
or a native upload id already owned by another receipt move permanently to
`operator_reconciliation_required`. Alarm recovery never silently adopts a
late single delta: it aborts it and terminates the receipt. One unresolved
receipt fences its exact object key throughout this process.

Public upload ids are provider-minted receipt ids rather than R2 upload ids.
The durable states are `preparing`, `creating`, `create_reconciling`, `active`,
`completing`, `completion_reconciling`, `completed`, `aborting`, `aborted`,
`operator_reconciliation_required`, and `destroying`. Part attempts and
committed etags and sizes, completion selection, the exact baseline, attempts,
and created/updated/terminal/next-action timestamps are rows; duplicate parts
supersede older etags and stale, unordered, duplicate, undersized non-final, or
oversized completions are refused from those rows after restart exactly as
before eviction.

R2 does not document `R2MultipartUpload.complete()` as idempotent, so recovery
does not call it twice. The wrapper receives one durable `execute` grant and
moves the receipt to `completing` before the native call. Multipart creation
attaches a random provider-private marker as R2 custom metadata. Whether the
native call returns or loses its response, `head` must show that exact marker
and the durably computed size before the receipt commits; later retries only
reconcile that readback. The facade never projects custom metadata. A definitive
invalid part response may reopen the active receipt; an ambiguous response
without the marker remains unavailable rather than being retried as a second
completion.

There is one deliberate completion liveness stop. A process loss after the
durable execute grant but before the native call is indistinguishable, under the
documented R2 binding contract, from an in-flight completion whose response is
lost and whose marker is not yet observable. With an absent readback that
receipt remains `completing`; a mismatch or indeterminate readback moves it to
`completion_reconciling`. Both return `backend_unavailable`, and automatically
issuing another native completion is blocked. This does not weaken the
lost-response case into a guessed retry or an unsupported at-most-once claim.

Active receipts expire seven days after creation, independently of later part
activity. Completed and aborted receipts retain their result for seven days and
then GC in batches of at most 64; authority and bucket control rows are not
collected. The same bound applies to an alarm's due-receipt work. A permanent
operator fence has no next-action timestamp and is never GC'd. Provider-only
status returns its count as `operatorReconciliationRequired` and derives
`repairRequired`; this is not a tenant route or a tenth facade method.

Bucket destruction is a separate admin state machine. The exact-incarnation
prepare proof changes bucket control to `destroying`, refuses later creates,
and aborts bounded multipart pages with an alarm between pages. The provider
may issue the R2 bucket delete only after that drain reports prepared. It then
confirms authoritative bucket absence before an independently sealed
commit-destroy deletes the Object storage. Delete and commit acknowledgement
losses resume from readback and the opaque handle without replaying the R2
bucket delete. Provider-only status treats the durable `destroying` lifecycle as
`repairRequired` until that exact handle proves absence and commits; there is no
automatic clear/adopt operation for an abandoned or ambiguous delete fence.

The receipt class does not extend the gateway's established `v1` lineage. It is
the sole class of a distinct route-less Worker and starts at that Worker's own
outer migration `v1`. Its runtime configuration contains the account id and
exactly three secret bindings: R2 S3 access-key id, secret access key, and the
receipt proof secret. The gateway configuration contains none of them and keeps
only `TakoserverManagedWorkerSqlite` under its original `v1` migration.

Fresh authority publication must supply those three values with the code and DO
lifecycle atomically. The owning deploy surface therefore accepts one canonical,
link-free, single-link, owner-only `0600` JSON file outside the repository,
copies it into the sealed release, and invokes Wrangler once with
`deploy --secrets-file`. It never performs a code deploy followed by three
surprise secret mutations. The generated config and result expose names only,
and the copied secret file is removed on both success and failure even when the
operator retained the rest of the release directory.

The fresh `v1` DO lifecycle is a separate irreversible authority transition.
Rehearsal writes external no-overwrite `0600` evidence for the exact commit,
module digest, null predecessor, class, v1 lineage, and empty mutation targets;
production consumes and immediately re-reads the same evidence. Provider
history and the sealed artifact/secret copy are re-fenced immediately before
the one deployment. Exact Version, module-byte, closed binding, migration,
workers.dev/preview, deployment-history, and no-route readback follows. The
complete account custom-domain inventory must also contain no service mapping
to the authority Worker. An acknowledgement or cleanup ambiguity stops for
status/forward repair rather than replaying the publication.

The route-less provider executor holds only the authority Worker's narrow
service-binding RPC. It asks that RPC to mint a runtime instance/proof pair and
to inspect, prepare, or commit destruction; it never receives the proof secret
or an administrative DO namespace. Every RPC rejects a ProviderInstallation id
other than the authority Worker's exact configured id before addressing a DO.
The receipt Worker's `MANAGED_PROVIDER_ID` value comes solely from
`target.cloudflareProviderExecutor.providerInstallationId`, not a duplicate
operator environment selector and not the gateway/SQLite
`TAKOSERVER_MANAGED_WORKER_PROVIDER_ID` provider-pack identity.
Tenant Versions receive only the cross-script namespace plus their exact
runtime proof; tenant handlers still see only `edge.objects`.

Finally, the parent Cloudflare credential and WfP backend also belong in that
route-less provider executor, not in Takoserver's public API Worker. The public
Worker uses a narrow Provider RPC proxy plus non-secret catalog projection.
ObjectBucket import and readback-only import recovery cross that same typed RPC
under the exact Host saga lease, Deployment incarnation, and Resource
generation. Its retail meter and artifact-consumption reads are likewise bound
to the exact tenant, Offering, ProviderInstallation, native id, and recorded
Deployment; neither can fall back to a public parent-account adapter.
The executor deploy surface qualifies the exact selected-commit receipt
authority and managed gateway, migration 0045, immutable module and binding
closure, workers.dev/preview settings, and exhaustive absence of routes and
custom domains. The public deploy then pins that exact executor Version before
publication and rechecks it at the mutation fence. Until this chain is exact,
production composition refuses reviewed edge and legacy Cloudflare ObjectBucket
supplies instead of silently advertising an ordinary-Workers backend.
