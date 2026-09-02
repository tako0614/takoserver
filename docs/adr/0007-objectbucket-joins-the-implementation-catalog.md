# ADR 0007 — ObjectBucket joins the implementation catalog

**Status:** accepted, 2026-09-02

> **Amended 2026-09-02 by this decision's own second rotation.** Where the body
> below says a self-host "realizes none" of the ObjectBucket supply and records
> the Form with an EMPTY operation set, that is no longer true: a self-host now
> holds object bodies under its data root and their metadata in its control
> database, and its Provider Pack owns both halves of the
> `module-worker.object-bucket` materialization. The rule is unchanged — an
> identity capability is admitted with the operations its Form declares exactly
> where the Host realizes the supply — but the self-host's answer to it moved,
> and its digests moved with it. See
> [Second rotation](#second-rotation-the-self-host-realizes-the-supply).

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

Exactly one Cloudflare Worker backend accepts `bucketBindings`.

- The **ordinary-workers backend** — the production path in an operator's own
  Cloudflare account — uploads the tenant's exact bundle bytes with no wrapper.
  It has no place to interpose a facade, so the declared name carries
  Cloudflare's native R2 binding, exactly as `sqliteBindings` already carries a
  native D1 binding and `kvBindings` a native KV namespace on that same
  backend.
- The **managed (Workers-for-Platforms) backend** refuses `bucketBindings`
  outright, by name and non-retryably, before it reads a bundle. Its wrapper
  can project the `edge.objects` facade over an internal `r2_bucket` binding,
  and does so correctly against a real R2 in test — but the facade keeps its
  multipart validation receipts in isolate memory, and an eviction between
  `createMultipartUpload` and `completeMultipartUpload` is ordinary rather than
  exceptional. Until the managed path owns a durable receipt backend it cannot
  claim a restart-safe ObjectBucket runtime, and a Provider Pack capability
  reaching it must be refused rather than left unreachable by configuration.

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

The consumer importer added to the Cloudflare runtime-binding materializer
reverses the note that "an ordinary Worker adapter must not consume this export
at all". That note existed because of the wrapper's in-isolate receipt ledger.
A native R2 binding has no such problem: its multipart state is the provider's,
and survives isolate eviction. The materializer is a Provider Pack capability,
so the route it publishes is the pack's; which runtime may consume it is the
backend's own answer, and the managed backend's answer is no.

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
empty bucket. `delete` refuses a bucket that still holds an object or an
unfinished multipart upload, as a named non-retryable failure proven by one
readback; the Form declares no field that could ask this Host to empty one, and
emptying a customer's storage is not a decision a lifecycle delete may take.
`import` is fenced to the exact incarnation this Host itself derives for the
Resource address being imported onto, so another tenant's bucket and a name
this Host never minted are both refused before anything is read.

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
- The managed Worker backend refuses `bucketBindings` by name. The
  ordinary-workers backend and the self-host wrapper backend are the two
  runtimes that bind one, and they bind it differently: Cloudflare's own R2
  binding there, the exact `edge.objects` facade here.
