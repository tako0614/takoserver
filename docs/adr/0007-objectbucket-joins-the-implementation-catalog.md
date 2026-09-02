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
capable only when the deploy target realizes an ObjectBucket supply: a Host
without one still serves an empty operation set for it.

The four other installed-but-unsupported packages — `ActorNamespace`,
`DurableWorkflow`, `StaticAssetBundle`, `WorkerCustomDomain` — are unchanged.
They stay installed, unsupported, and without an activation head.

## What each runtime hands the Worker

`bucketBindings` is validated identically on both Cloudflare Worker backends:
one runtime Binding per declaration in the same order, the exact
`module-worker.object-bucket@1.1.0` identity with its exact schema digest, a
relation at `/bucketBindings/<index>/resource` whose `targetUid` equals the
Binding's, a declaration `name` equal to the Binding's name, an active target
Deployment in the same provider installation, and a material naming a bucket
this provider derived. Any mismatch fails before a single Cloudflare call.

What lands in the Worker's `env` differs, and this ADR records that rather than
leaving it implied:

- The **managed Worker backend** wraps the tenant module and projects the
  `edge.objects` facade over an internal `r2_bucket` binding, which is what
  [ADR 0005](0005-object-storage-is-an-exact-objectbucket-binding.md)
  describes.
- The **ordinary-workers backend** — the production path in an operator's own
  Cloudflare account — uploads the tenant's exact bundle bytes with no wrapper.
  It has no place to interpose a facade, so the declared name carries
  Cloudflare's native R2 binding, exactly as `sqliteBindings` already carries a
  native D1 binding and `kvBindings` a native KV namespace on that same
  backend.

This is a deliberate, named divergence from ADR 0005's consequence that "Worker
code receives the exact Binding facade … not a provider-native R2 or S3
client". Interposing a facade on the ordinary-workers backend means rewriting
every Worker Version's `main_module`, which changes what the immutable
`WorkerBundle` means; that is a separate decision and is not taken here. Until
it is, the honest statement is: on the ordinary-workers backend the portable
Binding selects and materializes the bucket, and the runtime shape under the
declared name is Cloudflare's own. Nothing about bucket name, region,
endpoint, credential, or supply document reaches the Worker on either path.

The consumer importer added to the Cloudflare runtime-binding materializer
reverses the note that "an ordinary Worker adapter must not consume this export
at all". That note existed because the managed wrapper's facade keeps multipart
validation receipts in isolate memory and therefore cannot claim a
restart-safe ObjectBucket runtime. A native R2 binding has no such problem:
its multipart state is the provider's, and survives isolate eviction. The
materializer is a Provider Pack capability, so the route it publishes is the
pack's; the runtime that consumes it is whichever Worker backend the
composition selected.

## Authority and reconvergence

The change rotates both the capability digest and the semantic implementation
digest. Support and activation are append-only events keyed on the semantic
implementation digest, so every advertised environment must reconverge
explicitly. An in-place edit of a durable head is never the mechanism; a
Worker-version rollback alone never reverses an append-only activation event.

| identity | before | after |
| --- | --- | --- |
| `capabilityDigest` | `sha256:630899ce5e482e7e274c87dab17d74edd904620852a71c2b021aade236a1ea73` | `sha256:a5bc1508638fb1c47182d4ee68be5eedb7acc050394bd3507b532a78daacc024` |
| self-host `implementationPayloadDigest` | `sha256:1f57138d676492000ed44f1ee6c5af180bc13c932128c0286c4353ec7eac26a6` | `sha256:b7ea4f2da3f5dca05827442cb9a9f2419bf2063e3a9457cf6f97b7409da9f2c4` |
| self-host `implementationDigest` | `sha256:3788374901bbbb413a8be78d56d1220a3b82d352c12f03d2ce32b0a10454d756` | `sha256:8c9c862558356c41c487e8a18a020fedb0a5eb970046bfbac3664376420f1962` |

The public Worker's `implementationDigest` additionally binds the sealed
runtime payload `P`, so its value is fixed at deploy time by the exact source
commit and is not reproducible from this document. `capabilityDigest` above is
the one both Hosts share.

`tests/takoform-implementation-catalog.test.ts` pins the new pair and names
this ADR. Changing those literals again is an explicit reconvergence decision,
not a stale-expectation refresh.

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
a separate authority-surface decision. Once it exists, the sequence is the
existing one — public Worker, identity probe, route-less authority, gateway,
all at the same exact commit — followed by the append-only activation:

```sh
bun run deploy -- takoserver-form-authority-identity-probe --status --environment=production --commit=<40-hex-sha>
bun run deploy -- takoserver-form-authority --status --environment=production --commit=<40-hex-sha>
bun run deploy -- takoserver-form-authority --apply --environment=production --commit=<40-hex-sha>
```

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
  present active head with the new implementation digest, on every Host that
  has reconverged. A Host that has not is unchanged and keeps serving the
  predecessor identity until an operator applies.
- The integration fixture corpus grows from 12 to 13 packages, and every
  command count derived from it moves with it. `bun run check:form-corpora` and
  `bun run check:integration-form-packages` are the gates.
- The exact publisher-set import — its receipt, catalog projection, and
  authority closure — is untouched. All 17 packages were already installed;
  only the supported and activated subset moved.
- The self-host provider still refuses the current ObjectBucket at apply with
  `denied`, because it has no `EdgeObjects` backend. Admission is honest about
  the Form; execution is honest about the machine. Its retained v1beta1
  ObjectBucket drain capability is untouched and remains observe/delete only.
