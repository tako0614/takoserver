# ADR 0007 — ObjectBucket joins the implementation catalog

**Status:** accepted, 2026-09-02

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

Two Hosts exist and they differ. The public Worker realizes the supply and
serves all five operations. A **self-host realizes none** — its composition
builds no ObjectBucket Offering at all, because the machine has no
`edge.objects` backend — so `scripts/selfhost-form-admission.ts` narrows the
capability set it records to the identity Forms that composition does offer.
The two Hosts therefore no longer share one capability digest.

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
  activated with an empty operation set, so nothing about it is executable
  there. The self-host provider's `denied` refusal at `apply` and `adopt`
  remains as defence in depth behind that, for a composition assembled by hand
  rather than by `createSelfhostComposition`. Its retained v1beta1 ObjectBucket
  drain capability is untouched and remains observe/delete only.
- The managed Worker backend refuses `bucketBindings` by name. The
  ordinary-workers backend is the only runtime that binds one.

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
So the internal `__TAKOSERVER_SQLITE_<i>` Durable Object namespace and, if the
bucket refusal above were ever lifted, the `__TAKOSERVER_OBJECTS_<i>` R2 handle
were one import away from tenant code, along with every `secret_text` value.
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

The DO instance name still leaves as the `databaseId` Output. Replacing it would
mean minting a second stable identifier with no source of truth and changing a
declared Form output, and it is no longer load-bearing: knowing the name buys
nothing now that every admin operation wants a proof and the runtime facade is
the only other way in.

**The release script name moved.** `compatibility_flags` is part of
`settingsIdentity`, which is part of the release descriptor digest, which is the
`tsr-<digest>` script name. So the same desired state now names a different
release than it did before this change, and `observe()` on a WorkerVersion
recorded under the old digest would return `conflict`. There are no such
records: no composition builds this backend, so no receipt exists in any
environment. The managed lane starts fresh, and no re-key path is provided
because there is nothing to re-key.
