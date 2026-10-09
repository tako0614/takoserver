# Takoform Host API v2 adoption

Takoserver's target is one Takoform Host API: v2. The contract is the published
[Host API v2](https://takoform.com/spec/host-api/v2/), with each supported resource
identified by its author's exact, versioned Form URL. This document describes
the Takoserver implementation; it does not add requirements to that contract.

## Implementation boundary

```text
HTTP request → authentication → v2 engine → atomic SQL acceptance
                                    ↓
                         Resource + Operation + replay
                                    ↓
                         explicit background executor
                                    ↓
                         selected backend / reconciliation
```

`src/takoform-v2/routes.ts` handles the wire format. The engine owns authorization,
acceptance, generations and operation progress. Its store uses the existing
`Sql` port, whose batch commits all statements or none. Backend adapters own the
actual resources and report confirmed completion, known partial failure, known
absence of effect, or uncertainty. A timeout is not proof of absence.

The Form map is explicit code configuration. Registering a URL does not fetch
the author's site, install a package, or grant permission. Public support and
fresh acceptance use the same complete map; a Form is advertised only when its
adapter fulfills all required behavior. v1 admission, package signatures and HTTP
prepare calls are not part of this path.

The code-only `retainedForms` map is a separate internal selection for exact
adapters needed by already accepted Resources and Operations. It uses the same
Host engine, SQL ledger, owner checks and stored backend identity as complete
Forms, but never appears in public `/support` or accepts a fresh CREATE/UPDATE.
Existing exact-key replay, read, recovery and reference-safe DELETE remain
available. The normal Worker entry can select `{ forms, retainedForms }` in its
code composer; its previous bare map still means complete public Forms. Neither
map placement nor a private fixture by itself proves conformance to a Form's
whole required ABI. The normal Bun entry retains its complete-capability gate.

Read requests never execute an operation. The embedding application runs the
executor independently, including after a process restart. The accepted backend
identity, target and execution key survive that restart. If their outcome is
unknown, recovery reconciles those identities rather than issuing a new create
against another target. A worker that loses its claim cannot settle a newer
worker's operation.

A backend may return the internal `continue` result after a bounded step and
its durable checkpoint have finished. All writes must have been awaited and
fenced; an unacknowledged external effect remains `unknown`. A continuation
keeps the same Operation and dispatch history, clears its old lease, and becomes
eligible for reconciliation after one second. It neither claims readiness nor
publishes an execution error. Actual execution still depends on the embedding
scheduler. Due work is ordered by its last update, then creation and ID, so an
older multi-step operation does not continually take the next worker slot.
Unknown outcomes retain the existing reconciliation backoff.

SQL claims fence settlement, not arbitrary network sends. A backend reports
`no_effect` only when it can also exclude a delayed, previously authorized send;
otherwise it must report uncertainty. Safe replay inside reconciliation requires
that backend's own exact idempotency or fencing guarantee.

The HTTP constructor requires a stable, operator-provided cursor MAC key of at
least 32 random bytes. It authenticates pagination state, not Form documents or
resource authorization. Preserve it across restarts; rotating it invalidates old
cursors. Never put a production key in source or logs. Fixture keys in tests are
not usable deployment credentials.

## Organization ownership and credential permissions

The normal organization lane assigns one v2 Space to each organization: the
Space is exactly the organization ID. Its stable v2 principal is
`org:<organizationId>`. Authorized organization API keys and the organization's
owner session share this identity, so replacing a key does not strand its v2
Resources. They also share the idempotency-key namespace; clients must generate
distinct operation keys rather than using a counter local to one credential.

Authentication still checks each request's current credential. An API key is
bound to its stored organization; a request header cannot select another one.
`resources:read` permits reads, and `resources:write` permits reads and mutations.
The HTTP boundary checks the current write grant before accepting or replaying a
mutation. A session must explicitly select `takoform-organization` and pass the
existing organization-owner check. No reseller or sponsorship credential is
implicitly admitted to this lane.

This is a new v2 ownership policy, not a rewrite of v1's per-key service
principals. `Actor.hostPrincipalId` and existing keys/records retain their current
meaning. The generic engine still receives an explicit Space authorization
function; its stable owner identity alone is not proof of the current key's
write permission. Live adoption remains separate from source integration.

## Normal application and operator setup

`buildApp` mounts only Host API v2 at `/apis/forms.takoform.com/v2` and delegates
`/.well-known/takoform/v2` to that same Host. `tickTakoformV2()` executes at most
one accepted v2 Operation; `tick()` maintains the retained v1 repair ledger and
the independent control services. Runtime entries schedule these separately so
a slow v2 effect cannot starve legacy recovery. Bun checks for v2 work every
second and retains its existing 30-second maintenance interval. Both passes are
tracked by the same graceful-shutdown owner. The old Host's HTTP handler is not
mounted, and v2 requests are never translated into v1 requests. Login, console,
wallet and independent standard-service `/v1` APIs remain product APIs.

Both runtime entries require these explicit operator settings:

| Setting | Meaning |
| --- | --- |
| `TAKOSERVER_PUBLIC_ORIGIN` (Bun) / `PUBLIC_ORIGIN` (Worker) | Bare external HTTPS origin for this Host. |
| `TAKOSERVER_TAKOFORM_V2_CONFIG` | Strict JSON with `documentation`, `authenticationDocumentation`, and optional Form backend settings below. Both documentation URLs must be HTTPS. |
| `TAKOSERVER_TAKOFORM_V2_CURSOR_KEY` | At least 32 random bytes encoded as canonical, unpadded base64url. Keep this operator secret stable across restarts and outside source and logs. |

The Bun entry has additional, opt-in local runtime settings. `TAKOSERVER_WORKERD_BINARY`
selects its native Worker runtime. `TAKOSERVER_V2_WORKER_PRIVATE_PLANES` selects
the private SQLite, KV, ObjectBucket, Queue settlement, and Queue Producer
listeners; their exact key-file and port requirements are described below.
`TAKOSERVER_V2_WORKER_RUNTIME_BOOT` selects Actor and/or Workflow boot, and
Workflow also needs `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY`. Selecting
`TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS=1` additionally requires the existing
Worker TLS inputs and endpoint suffix. Bun constructs the selected local
listeners and runtime owners, but does not generate the required private-plane
key files, select or download the accepted native binaries, create TLS inputs,
or provision remote cloud resources. A configured subset does not enable a
narrower Worker profile.

For example, a Host with no Form backend enabled has this **non-secret** config:

```json
{
  "documentation": "https://host.example/docs/resources",
  "authenticationDocumentation": "https://host.example/docs/access"
}
```

Replace the example URLs with this deployment's actual documentation. The cursor
key is supplied separately, never in this JSON. Omitted, partial or malformed
required configuration prevents startup; it does not select v1 or generate a
new cursor key. This key protects pagination state, not Form publication or
user authentication.

## Bun self-host Form support

The ordinary Bun entry composes these artifact-only Forms when their respective
blocks are present in `TAKOSERVER_TAKOFORM_V2_CONFIG`:
`SQLiteMigrationSet 0.2.0`, `WorkerBundle 0.2.0`, and
`StaticAssetBundle 0.2.0`. The first stores verified SQL migration files but
does not execute them; the latter two store validated Worker or asset bytes but
do not, by themselves, execute a Worker or serve an asset. These settings do
not enable the conditional Worker lifecycle map below.

The normal Bun entry advertises its complete local Worker Forms only if all of
the following are true at startup: the selected `workerd` binary is available;
both `workerBundle` and `staticAssetBundle` target
`selfhost-v2-worker-primary`; Actor and Workflow boots are selected; all five
private planes (SQLite, KV, ObjectBucket, Queue settlement, and Queue Producer)
are configured; and existing Worker owners restore successfully. Then it
registers `ModuleWorker 0.3.0`, `WorkerVersion 0.5.0`,
`WorkerDeployment 0.4.0`, `WorkerCronTrigger 0.3.0`, `SQLiteDatabase 0.2.0`,
`EdgeKVNamespace 0.2.0`, and `ObjectBucket 0.2.0`, plus `ActorNamespace 0.3.0`,
`DurableWorkflow 0.3.0`, `AtLeastOnceQueue 0.2.0`, and `QueueConsumer 0.3.0`.
`SQLiteMigrationApplication 0.2.0` is added only when its separate
`sqliteMigrationSet` block is configured. Endpoint Form `0.3.0` is added only
when its HTTPS listener is selected and its hostname, TLS, and route-absence
ports are composed. If a prerequisite is missing, the Worker lifecycle map is
not registered; support is not inferred from internal components or tests.

WorkerVersion declarations can reference SQLite, KV, ObjectBucket, Queue
Producer, ModuleWorker Service, Actor, and Workflow Bindings. The referenced
Forms and execution brokers must be present in the same complete composition;
declaring a Binding does not enable its target independently. With this complete
composition and a valid `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING`, the entry also
accepts WorkerVersion `privateInputs`. Without the operator keyring, new private
inputs remain unavailable; existing configured ciphertext is never used to
generate replacement keys.

This is local source support, not Hosted D1 or Workers for Platforms support.
The support endpoint reports the Forms composed by that running instance.
Public certificates/DNS, a deployed or live Worker rollout, and external
delivery qualification are not established by portable tests or local native
evidence.

Both normal Bun and Cloudflare Worker entries can select `sqliteMigrationSet`,
`workerBundle`, and/or `staticAssetBundle`, each with a stable `targetKey` and
`heldArtifacts`.
Each entry contains `url`,
lowercase hex `sha256`, `objectKey`, and explicit `grants: [{ principal, space }]`.
For ordinary organization use those grants name `org:<organizationId>` and that
exact organization ID. Seed each exact manifest and payload byte sequence in the
Host's object store through operator-owned tooling before relying on those
grants. The API does not upload artifacts and never fetches their URLs. An
explicit empty list denies new acquisition while preserving the ability to
manage existing custody; omitting a Form block instead removes that
implementation. Do not remove an implementation with unresolved Resources or
Operations.

To explicitly compose the WorkerBundle Form while denying all new artifact
acquisition, include an empty `heldArtifacts` list (this does not create or
execute a Worker):

```json
{
  "documentation": "https://host.example/docs/resources",
  "authenticationDocumentation": "https://host.example/docs/access",
  "workerBundle": {
    "targetKey": "operator-worker-bundle-primary",
    "heldArtifacts": []
  }
}
```

To compose StaticAssetBundle while denying all new artifact acquisition, use
its own independent block (this does not serve or publish the asset bytes):

```json
{
  "documentation": "https://host.example/docs/resources",
  "authenticationDocumentation": "https://host.example/docs/access",
  "staticAssetBundle": {
    "targetKey": "operator-static-assets-primary",
    "heldArtifacts": []
  }
}
```

WorkerBundle (`https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/`)
validates a UTF-8 manifest of at most 1 MiB, with 1–512 files,
canonical relative POSIX paths of at most 1,024 UTF-8 bytes, and exact HTTPS
artifact identities. Each file is at most 16 MiB and the aggregate is at most
128 MiB. The Host records only the validated bundle projection and held bytes;
it does not execute the Worker or create a data-plane endpoint.

The internal `worker-code-runtime.ts` projection accepts already-authorized
held bundle bytes and a trusted semantic inspector, then projects module bytes,
media types, fetch-handler identity and JSON `vars` to the existing Workerd
version-graph compiler. The compiler adds the Host-owned readiness wrapper; the
shared Deployment publisher can stage the resulting code graph alongside
static-only Versions. It invokes inspection on the same owned snapshot. This is
an internal publication building block, not Worker Form registration or support.
Uncomposed capabilities remain explicit refusals. The internal factory connections
and their separate native evidence are described below; this portable projection
alone does not qualify them.

The published ModuleWorker 0.3 text describes auxiliary source maps but does
not name their MIME token, while WorkerBundle 0.2 defers its closed media-type
set to that ModuleWorker section. This implementation does not infer a token;
source-map media support needs an owning Form clarification or a later Form
version before it can enter bundle custody.

StaticAssetBundle (`https://edge.forms.takoform.com/forms/StaticAssetBundle/0.2.0/`)
accepts a manifest up to 1 MiB with 1–512 files, canonical relative POSIX paths
up to 1,024 UTF-8 bytes, exact HTTPS artifact identities, per-file bytes up to
16 MiB and aggregate bytes up to 128 MiB. It records the validated ordered
asset projection and held bytes, but does not serve those assets, attach them
to a Worker, or create a public endpoint. Its configured target and source
grants are explicit operator settings, independent of WorkerBundle.

The normal Worker entry has a D1/R2 composition path for these three configured
artifact-only Forms. It refuses startup before support or Operation acceptance
unless D1 has the complete 0075 artifact-progress closure and 0081 private-input
acceptance, comparison, transfer and transition closure. Core Operation inserts
name the 0081 presence column even when operator custody is absent. An omitted Form block remains
unsupported; an explicit empty `heldArtifacts` list permits management of
existing custody but denies new source acquisition. The owning deploy path
includes an explicit integration transition from canonical 0066 through 0088,
with retained-state checks and source/native maintenance qualification. The
default existing-D1 ceiling remains 0066 and fresh production remains 0069.
The existing fresh-production writer also accepts two explicit, fixed payloads:
`--fresh-lineage=v2-0088` and `--fresh-lineage=v2-0089`. The latter adds the
forward-only Cron match guard correction for D1's expression-depth limit;
selecting it does not widen the earlier payload or existing-database wave.
Each fresh attempt creates a new identity, preserves the incumbent database,
and validates the selected schema, lineage, canonical seed rows and FK integrity.
An unknown acknowledgement permits readback, not another import. A partial
prefix is retained for a separate repair decision. The schema
transition must complete before enabling Form blocks that require it. Source
and local D1 evidence do not establish a deployed migration.
This artifact-configured normal Worker startup guard checks required columns,
tables and trigger markers; it is not byte-for-byte DDL attestation or live
migration qualification.
Neither entry advertises WfP or Worker execution through this configuration.
These Forms are management and custody surfaces only; they do not serve assets
or execute Workers.
Discovery always declares offerings and previews unavailable. It declares
`privateInputs` only when `buildApp` receives explicit operator-selected
`v2PrivateInputCustody`. The complete Bun Worker composition supplies it from
the configured operator keyring. An operator extension using the Worker entry's
`composeV2Forms` callback can also supply a Form map with an explicit private-input
policy. With that map and a valid existing runtime-input keyring, the entry
imports the keys once, preserves the original AES authority and derives the
same transfer/comparison custody. The default Worker and a composer without
private-input policies do not enable it. This generic custody does not supply
the Form-specific configured-input sealer, native secret delivery or its probe;
the extension still owns those ports. Entries without custody declare the
capability unavailable. Per-Form support additionally requires an
exact Form private-input policy and complete backend. Common limits are a 1 MiB
request, 100 items per page and a 24-hour replay window.

The Bun API listener remains HTTP behind an operator-controlled HTTPS front end.
For v2 paths it checks the incoming URL and `Host` authority against the configured
public authority before representing that request with the external HTTPS origin.
`Forwarded` and `X-Forwarded-*` cannot select this authority. Keep the backend
listener on a protected network; normalization is not TLS, proxy authentication,
or evidence that a public certificate/route works. The frontend must preserve
the exact public Host header. Non-v2 routes keep their existing handling.

## First implementation slice

The initial slice covered the required common HTTP operations and durable
acceptance. Offerings and previews remain unavailable. The optional private-input
foundation now accepts a complete, non-coerced map only with both operator
custody and a Form declaration; absent and `{}` are distinct. Public Resource,
Operation, replay fingerprints, diagnostics and logs contain neither plaintext
nor a simple secret hash. The Host seals temporary transfer separately from a
retained keyed comparison, binds both to the accepted Operation/owner/UID/
generation, and commits them atomically with acceptance. The operator must keep
historical comparison keys through the promised replay window and while an
Operation remains unfinished; lost comparison material yields an authorized
`private_inputs_unverifiable` conflict, not a guessed match. Temporary transfer
keys can rotate separately.

Before any possible backend send, expired or unavailable transfer enters
`waiting_input`. The same authorized Operation accepts only a complete original
map for replenishment and then queues again; terminal Operations refuse it.
The dispatch marker erases transfer atomically. Once dispatch may have happened,
the backend must reconcile the accepted identity and cannot infer unsent from a
timeout or ask the Host to resend. A Form requiring preservation across UPDATE
must also seal configured values for the stable Resource UID in the CREATE
acceptance batch and validate an UPDATE against that exact retained row. The
per-Operation transfer does not serve as permanent configured-value storage.

Migration 0081 and these keys are source-only: no live D1 schema, operator key,
or deployment has changed. Tests prove public HTTP acceptance, lost responses,
replenishment and recovery after an actual Host process restart on SQLite;
they do not qualify a live D1 deployment, native provider custody or a specific
secret-bearing Form. A backend that requires private inputs must not be
advertised until its Form-specific policy and recovery path are complete.

Tests may configure a local fixture Form and a persistent test backend. Those
tests exercise the real HTTP and SQL implementation, but do not qualify an Edge
Form, a Cloudflare backend, or a public deployment. The shipped self-host and
Hosted composition must not claim a Form is supported merely because a fixture
can use the generic engine.

Resource implementation must be selected against the entire published contract.
The initial candidate,
[`EdgeKVNamespace 0.2.0`](https://edge.forms.takoform.com/forms/EdgeKVNamespace/0.2.0/),
cannot be qualified by a local SQL namespace alone: it defines replicated
eventual-consistency storage and a WorkerVersion JavaScript Binding. The existing
Cloudflare namespace-create path cannot safely adopt a namespace when its
acknowledgement loses the provider ID. Neither path becomes compatible by
wrapping its old request in a new HTTP envelope.

The canonical Form constructor now accepts either its existing local Store or
an operator-selected native `V2Backend`, never both. Both modes retain the same
Form validation and target identity. The native adapter receives the full
accepted execution and must return the exact Form observation with empty output;
a malformed completion or authority change remains unknown.

Migration `0085` adds Operation-owned native KV custody, not a second Resource
ledger. CREATE and DELETE each receive a durable one-shot send grant. A trusted
CREATE acknowledgement preserves the provider ID, original Operation and
generation; reconciliation reads that ID, never a matching title. Same-spec
UPDATE keeps the confirmed namespace. DELETE resolves the original identity
before its grant and requires exact-ID absence after its single send. Losing a
CREATE acknowledgement without its ID remains unknown and never authorizes a
second create. The source migration does not change the live apply ceilings.

The private Cloudflare adapter exercises accepted Core Host operations with
explicit organization principals and real SQLite, using a simulated external
API. The separate `buildApp.fetch` journey exercises stored organization API-key
authentication, the same UID across two writer keys, read-only mutation refusal
and cross-organization read refusal. It still uses a simulated identity provider
and Cloudflare API and does not prove complete Form support. Native
Worker Binding execution remains unqualified, as does the client's assumption
that an exact-ID GET HTTP 404 proves absence rather than an account or permission
failure. EdgeKVNamespace 0.2.0 gives bounds for TTL, list limit and prefix,
but does not name their out-of-range errors despite requiring named errors.
The implementation must not invent those names or revise the published Form in
place; the SDK gap requires an owning successor contract decision.

An artifact-only Form such as
[`SQLiteMigrationSet 0.2.0`](https://edge.forms.takoform.com/forms/SQLiteMigrationSet/0.2.0/)
can form a smaller first real-resource journey without requiring a Worker
runtime. Its implementation uses the Form's Host-held artifact acquisition
option: an operator explicitly maps an exact URL and digest to an existing
object and grants access to an exact principal/Space pair. A digest match alone
never grants access. The resolver does not fetch arbitrary URLs or reuse v1
artifact holds, and stops at finite time and actual-byte limits. Outbound public
HTTPS acquisition is not implemented by this resolver.

The migration-set backend verifies the manifest and files, then keeps its own
Resource-scoped bytes in SQL custody. The accepted Operation and current lease
fence each write in the same database as the Resource. This avoids a late object
upload recreating bytes after deletion. Updates verify the already-held bytes;
reads do not contact the source. Deletion releases only the Resource's custody,
not the operator's source objects, and a live inbound reference prevents delete
acceptance. None of these operations executes SQL from the migration files.

WorkerBundle uses the same byte-custody mechanism with its own manifest and
payload validation. New artifact Forms use the additive 0072 custody tables;
existing MigrationSet custody stays in its original 0071 tables without a bulk
copy. The two storage layouts are internal, fixed choices, not user-selected SQL
identifiers. They share the Resource/Operation ledger and lease rules, rather
than introducing a second resource authority.

The normal Bun composition connects each of these backends only when its exact
configuration block is present. This source fact is not Hosted D1, WfP, public
TLS or production qualification.
Source and custody authorization are distinct: a caller
may have write access to a Space but no grant to a particular source artifact.

## Worker runtime integration and normal-entry support

Worker Form input parsing, runtime integration and support registration are
separate steps. Normal-entry registration is conditional on the complete boot
requirements below; parsing a Form alone never makes it supported.

A Form can declare its complete outbound Resource reference set. Acceptance
checks the exact owner, Space, Form URL, current observation and required target
relationship, then reserves and seals that set in the same SQL transaction as
the Operation. An incoming reference blocks target deletion. A failed or uncertain
update retains both previous and pending targets; a confirmed replacement or
referrer deletion releases the obsolete edges. New referencing Forms must use
this declaration rather than adding edges afterward. This mechanism protects
application-managed reference sets, not arbitrary privileged SQL writers.

An accepted WorkerVersion operation can read its referenced WorkerBundle through
the shared custody reader. The reader verifies held bytes and the current lease,
without fetching or rewriting the original artifacts. The runtime adapter passes
owned copies to the existing module inspector and exposes the same module graph
inputs to the workerd compiler. Inspection is not publication or traffic readiness.

Separately, the self-host `WorkerdRuntime` now has a lazy, same-process fenced
publication seam with exact serving-identity readback. Focused source tests cover
successful readback, stale-fence refusal, and restoring the prior pointer when
readback cannot be proved. This generic seam alone does not provide
multi-process fencing or invocation retirement, and does not establish v2
Worker publication or traffic readiness. The UID owner and normal-entry
composition provide those separate proofs.

The internal material reader reuses the existing immutable Bundle and StaticAssetBundle
custody rather than create another Version byte ledger. A live Version's sealed
references retain those Resources and their verified bytes. The runtime's staged
immutable generation is its execution copy; Resource/Operation records remain
the desired-state authority. Version deletion must still wait for both ordinary
references and invocation retirement, then release only its execution copy.

An additive internal bounded reader can capture an accepted Version graph without
loading all artifact files. Its returned manifest, observation and file sizes are
explicitly **unverified metadata**, not ready-to-publish bytes. Each held read
returns at most sixteen 64 KiB chunks and rechecks the exact organization, Space,
Form, target generation, settled Operation, artifact owner and accepted graph
around SQL awaits. A per-file staging helper hashes the complete held file and
checks the graph again after awaited staging writes. A restarted consumer must
reopen its scope from the current accepted Operation; a cursor is not a bearer
grant. No source URL is read. The existing aggregate reader and its
`resolveVersion().ready` byte-verification semantics remain for current consumers.
The bounded reader alone does **not** qualify 128 MiB publication: static workerd
projection and private WfP upload still construct aggregate in-memory payloads.
Those consumers need bounded temporary staging, final fence and exact readback
before their maximum-size journey can be claimed.

Publication must read through its own live Operation and the exact selected,
settled Version. An Endpoint reaches a Version through the confirmed Deployment
in the SQL graph; its own Worker reference is not a grant to arbitrary Versions.
The reader must recheck the graph and artifact digests after asynchronous reads.
It must neither impersonate a completed Version Operation nor reacquire source
URLs when held bytes are missing. Missing or changed custody remains unresolved.
This held-byte connection does not yet register Worker Form backends or establish
module execution, Binding capability, or complete Worker Form support.

Static-only Versions have an explicit runtime representation rather than a
synthetic tenant module. The projection verifies and copies the held asset
manifest, observation and every file before handing them to the runtime. The
runtime stages these assets with the Host-owned asset router, can select them
alongside module-backed Versions in a weighted publication, and preserves their
identity and bytes in its on-disk readback. Static paths and media types follow
the v2 artifact contract; existing module-backed storage remains compatible.

Portable static-runtime checks exercise generated routers, simulated readiness,
and reconstruction from the same runtime files. They do not start the pinned
native workerd binary or terminate and restart its OS process. Actual static
serving, mixed-version dispatch, service Bindings and native restart recovery
still need that separate qualification. Static-only support is one implementation
path within WorkerVersion, not grounds to advertise the whole Form as supported.

The internal mixed publication port connects an accepted Deployment Operation
to this runtime: it resolves the sealed SQL graph, reads held Version assets,
projects currently supported fetch+JSON-vars code graphs, and publishes one
complete weighted selection under the existing activation lock. A new operation
can replace the same Worker's prior publication after
its incumbent Operation is checked in SQL. Read-only recovery compares the
complete serving identity and never republishes on missing or uncertain proof.

This port returns publication evidence, not a Form backend result. In particular,
`confirmed(null)` proves publication absence, not completed Deployment deletion.
The Form backend must also prove invocation cancellation, physical child retirement
and old-owner fencing before settling DELETE. The owner receipt is per complete
Deployment incarnation, not per Version; it does not prove one Version absent
across all active/draining generations. The port neither creates another lifecycle
ledger nor treats whole-group retirement as per-Version deletion proof.

The self-host `WorkerdWorkerRuntimeOwner` connects this publication port
to separate, immutable child incarnations for one Worker UID. Its local fetch
dispatcher switches to the confirmed incarnation while existing HTTP response
bodies retain their old owner. Static-only old children may retire when those
bodies finish; code-bearing old children are retained through the 15-minute
deadline because the current owner has no `waitUntil` settlement witness.
Deadline retirement cancels tracked HTTP requests and requires physical child
exit plus listener-vacancy receipt. This is scheduler-policy evidence only;
native `waitUntil` continuation/settlement is not tested here. A different
Worker UID has a different process owner and is not stopped by that transition.

The private internal readiness hostname preserves its legacy spelling for
DNS-safe script labels. For accepted script names that are too long or contain
non-DNS label characters, a full-SHA-256 two-label alias is used by both the
renderer and readiness compiler. This changes neither script/path identity nor
Worker UID or Endpoint hostname. It does not adopt a previously running child:
an owner restart still requires the existing exact retirement/recovery proof.

On DELETE, the owner durably closes its own admission path, cancels tracked
requests and response readers, and requires an exact retirement receipt for
every recorded incarnation before the final SQL claim check. State transitions
are serialized; an ambiguous durable write stops subsequent writes rather than
rebasing on stale memory. Retirement receipts bind actual configuration bytes,
child exit and listener vacancy. This result does not remove shared hostname
routes, settle the Form, or qualify non-HTTP execution contexts.

The owner is composed by the normal application under the complete boot
selection below. Its portable tests alone do not qualify the pinned native
workerd binary. Orderly closure can release its
local lock after retirement. After a Host-process crash, a successor may replay
the same DELETE only when the durable owner state proves deletion and every
recorded incarnation has an exact retirement receipt, every recorded listener
is vacant, and Linux boot/PID-start identity proves the prior lock owner exited
within the same boot and PID namespace recorded by the lock. An active
incarnation can also be reopened when the exact accepted SQL serving graph,
stored publication copies and pinned configuration agree, its old child is
stale, and its listener is vacant. Recovery re-renders the same graph with a
new process-private readiness token; it durably pins the replacement child and
configuration digest before admitting traffic. A draining predecessor is
retired from its exact receipt, including when the group receipt preceded the
owner-state checkpoint. A failed successor retains its fenced lock until its
own PID dies, so a later Host can retry without a no-lock adoption path.
An interrupted config write that does not match the group manifest remains
unknown and requires manual recovery. This private owner root is for one local
Host/PID namespace, not a shared-volume or reboot-recovery protocol.
The successor pins and rechecks the exact lock inode before claiming it; competing
successors cannot both acquire it. A legacy PID-only or malformed lock, an
unavailable process identity, a foreign listener, a missing/currently live
child, an unrecognized incarnation directory, or any other uncertain
incarnation remains an unknown manual-recovery case. The code never adopts a
live child or removes a lock using only a PID. This recovery is not native
workerd ABI qualification and remains distinct from successful same-process
operation retry.

Private execution adapters can import the existing v2 backend types, Worker
input/reference helpers and publication-state reader through
`@takoserver/core/takoform-v2`. This Worker-compatible software extension exports
the public implementation's contracts; it is not another Takoform API or a WfP
implementation. It does not expose the self-host workerd implementation or change
normal Form registration.

The same reader resolves an accepted WorkerVersion create or update before that
Version is ready. It verifies the current Operation claim, the owning Worker's
organization and Space, the complete sealed reference set, and verified held
Bundle and Asset bytes. The returned snapshot and `readMaterials()` are inputs
to native materialization, not a claim of Form readiness. `stillCurrent()`
rechecks the SQL vector and held-byte integrity after asynchronous work. Source
URLs are never a recovery fallback, and a Version does not need an existing
Deployment to read its own accepted materials.

Native adapters can use `createV2NativeEffectCustody` to persist one send grant
for an accepted Version Operation. The grant binds that Operation and its
current SQL claim to an opaque native identity and content digest. Reclaimed
leases and duplicate calls cannot issue a second grant. Native acknowledgements
and independently verified observations advance the same immutable record; they
do not settle the Form Operation. The additive `0074` table survives a database
reopen and has no automatic expiry or delete path.

A SQL grant is not cancellation at the provider. A request already sent may
still arrive after the local lease expires. Missing native state or an absent
receipt therefore cannot by itself prove that the operation had no effect.
Adapters must preserve uncertainty and use exact native readback; external
retirement and cancellation still need their own implementation. Recognizing
`0074` in source does not raise any live D1 migration or bootstrap ceiling.

Forms can also calculate initial public output in a pure callback. That output
is committed at acceptance, including before backend execution, and is not
reallocated on replay or update. This supports the Endpoint requirement to retain
an assigned address while its route is pending or failed. The Endpoint backend
must preserve that address in subsequent results; the callback must not create
external routes or perform other effects.

The later Form backends, owner-side invocation retirement, Endpoint routing and
conditional normal-entry composition supply additional proofs beyond this
generic seam. These focused seam tests alone do not establish complete Worker
Form support, public HTTPS delivery, or Hosted qualification.

An internal execution-group primitive now owns one immutable Worker UID,
configuration and child listener within a private incarnation directory. It
reuses one supervisor across readiness failures and process restarts. Retirement
closes admission, waits for the captured child to exit and the listener to become
vacant, then durably records the Worker UID and Operation ID. The same operation
can recover its receipt without starting or terminating another child. Failed
shutdown proof stays unconfirmed and can be checked again through the same owner.
A separate Worker group continues running during this retirement.

This receipt retires an execution-group incarnation, not the logical Worker
Resource forever. A future Deployment may use a new incarnation for the same UID.
An unretired directory is not adopted by a second handle after loss of ownership.
The owning v2 composition must resolve and authorize the Operation, connect graph
routing and settlement, and supply a private or authenticated ingress boundary.
The current local TCP ownership check is not atomic with connection establishment
against a hostile local binder. OS-child tests qualify the process lifecycle,
not native workerd ABI readiness, Host-process restart recovery, or a complete
public Worker deletion. This primitive alone is not normal-entry Form support.

## Code Version and scheduled delivery composition

The internal `createInternalV2WorkerVersionForm` uses one backend identity for
static-only, code-only and code-plus-assets Versions. It selects the existing
lifecycle manager from the accepted spec's Bundle presence without changing an
execution identity or maintaining another ledger. Each Version's normalized
spec remains immutable; updates cannot switch a UID between these cases. The
older static/code constructors retain their identities for existing internal
compositions, not separate public Form profiles.

The code lifecycle manager requires a semantic module inspector.
It validates held Bundle bytes and the exact declared/exported handler set,
without publishing a Deployment or granting event delivery. The software
extension exports the same `inspectV2WorkerCodeVersionEligibility` check and
`V2WorkerModuleInspector` port for private execution adapters. It does not ship
a native runtime or qualify an inspector supplied by the embedding Host.
An embedding operator may supply
`createV2WorkerVersionConfiguredInputSealer` through the software extension.
It requires an explicit nonextractable AES-256-GCM keyring; no key or secret
setting is inferred from the public configuration. The code Version Form seals
the complete private map for its exact UID, owner, Space and normalized spec in
the original CREATE acceptance batch. An omitted or equal-map UPDATE retains
that ciphertext; a different map is rejected before acceptance. A secret-free
Version accepts omission or an empty private map. Missing or unusable retained
ciphertext is not repaired by assigning new values to the same UID.

The runtime reader composes the existing Core UID-custody reader with exact
Resource/target/spec checks and a final publication-vector fence. Decrypted
values enter only the private Workerd `text` environment; the internal wrapper
descriptor calls those entries `secret_text` without adding a WfP binding or
disclosing their values in Resource, Operation, observation or output. Confirmed
deletion releases the UID's configured ciphertext through the same Core ledger.
Tests cover real SQLite acceptance and publication with a synthetic runtime,
including a lost runtime acknowledgement. They do not alone prove OS-process
restart, native workerd ABI, normal Form registration or live provider behavior.

The internal code path admits a SQLite Binding only when one boot-selected
SQLite store, a persistent Host-private signing key of at least 32 bytes, and
a fixed loopback port are composed together. The same captured Core binding
reader and signed-grant broker are passed to Version admission and the native
owner before it restores any Worker. Each call rechecks the current accepted
serving graph and native selected Version; neither a Form URL nor an in-memory
name grants SQL access. Without that complete boot capability the Version is
refused. The ordinary Bun entry supplies it when its private SQLite plane is
configured; registration additionally requires the other complete boot
prerequisites below. Uncomposed typed Bindings remain explicit refusals.

The same internal factory can compose a separately keyed ObjectBucket broker at
an operator-selected stable loopback port. Its grants bind the exact organization,
Space, selected Version Operation, Worker incarnation and settled Bucket reference.
The broker checks both the Core graph and native owner around each awaited call.
Native descriptors use a distinct internal service name; multiple Object service
descriptors retain separate callers rather than sharing whichever endpoint was
initialized first. A local organization-authenticated Host journey uses the pinned
workerd artifact for Bucket create, Worker put/get, Worker update, deletion and
orderly termination. That internal journey alone does not prove normal-entry
registration, public HTTPS delivery or Hosted qualification.

The internal factory also composes a separately keyed KV broker and private service.
Linear Base64 validation passes the full 25 MiB value limit through pinned workerd.
An organization-authenticated Host journey creates accepted KV, SQLite, Object and
Queue references and uses all four from one Worker. A separate process test
discards an accepted Queue create response, retries the same operation, SIGKILLs
the Host, and restores the same Worker, stored values and queued message under
new Host and native child PIDs. It replays the Queue create key without a second
Resource and sends another message through the restored native Producer Binding.
It checks update and deletion, then proves the child is gone while the recovered
Host is still alive. These tests manually register the Forms in an isolated Host;
they do not alone qualify normal-entry registration, public TLS, Hosted execution or
the KV Form's worldwide replicated eventual-consistency semantics.

Queue boot precedes Worker restoration. Its capability joins the current accepted
SQL graph and held bytes to the exact native owner and selected Version. A native
Host journey covers durable ACK, retry, Consumer update and deletion refusal.
External currentness preflight occurs outside the owner's serial lane; native
identity, SQL source and one-send authorization remain checked inside it.
The same internal composition also keeps an execution outstanding after durable
ACK while native `waitUntil` work remains. Closing the scheduler refuses new
ticks but does not release that execution; the native handler's later completion
permits retirement and reference-ordered deletion. This same-process test does
not prove owner suspension with pending work, retention beyond expiry, response
loss, or delivery settlement after an OS restart.

SQLite calls now use a separate private streaming transport rather than the
shared 40 MiB buffered companion path. The operator supplies a pre-existing
private staging directory. Calls above the 1 MiB inline threshold write through
an already-unlinked file descriptor. The transport validates statement and
parameter bounds before one atomic transaction; the output budget is checked
before commit. Native tests pass a
42-statement transaction with 1,000,000-byte parameters and verify all 42 rows.
The Node-only SQLite extension also has an opt-in custody mode for an external
Core proof source. It keeps the same UID file and original CREATE receipt for
Form lifecycle and Worker SQL, while a file-backed invocation lock encloses the
UID lock, SQL close, and terminal drain. The proof source has fixed claim,
original-CREATE, and invocation readback methods, not an arbitrary SQL bridge.
The legacy self-host composition still uses its local fixed SQL checks. This
internal seam alone does not activate or qualify a WfP SQLite Form or Binding;
the operator must select one durable lock/root realm and connect the Core arm,
terminal proof, and drain CAS before admitting SQL.
Malformed or interrupted input is rejected before execution; a later SQL failure
or excess output rolls back without retained named input files. The SQL wrapper
captures its input before sending and serializes it incrementally, with at most
4096 UTF-16 units in a fragment; it does not build a whole-call JSON string.
Input normalization and maximum legal aggregate input remain unqualified. KV and
Queue transports retain their existing limits.

The internal WorkerCronTrigger backend and scheduler use the published
WorkerCronTrigger 0.3.0 contract. Admission seals the exact Worker, target and
selected Deployment/Versions. Deployment changes must keep every selected
Version eligible for `scheduled` delivery while an attachment exists.
Migration `0080` stores matches before invocation and fences attachment changes
against concurrent Deployment acceptance; adding it to source does not permit
a live D1 migration.

Each scheduler call processes at most 128 attachment candidates for one target
and current UTC minute, then attempts a bounded batch of pending deliveries.
It persists the minute and keyset cursor, and returns `hasMore`/`scanComplete`.
The embedding scheduler must continue `hasMore` calls within that same minute
under its qualified capacity. A minute rollover skips unrecorded old-minute
matches; it does not catch up. Recorded matches retain their stable identity
across restart and unknown acknowledgements. Explicit handler rejection is
terminal for that match, while an unknown result may be delivered again.

The self-host Worker composition connects this existing match custody to its
restored UID-bound native owners. Its internal Form factory includes the Cron
Attachment, and the ordinary Bun entry drives `pollScheduledDue` as a separate
tracked one-second pass. A stalled delivery does not block management settlement,
Queue work, or Workflow polling. The pass is unavailable before restoration or
after closure. Shutdown freezes scheduled admission and joins the active scan
before suspending native owners or closing SQL; a native result arriving after
that freeze remains unknown and retryable. This connection alone does not
register Worker Forms in the public entry or claim exactly-once execution.

The owner projects a private, incarnation-bound scheduled-event capability
before publication. Delivery checks the current serving graph and does not use
an HTTP response as proof that `waitUntil` work has retired. The integration
journey uses actual Host HTTP, persistent SQLite, SIGKILL and a new Host PID,
and executes the verified held JavaScript module in a Bun stand-in. It checks
same-match redelivery, a non-equivalent schedule update and delete/drain. That
evidence alone is not native workerd ABI, normal application Form registration,
Hosted scheduled delivery or production readiness.

A separate pinned-workerd journey uses the same internal composition and
organization-authenticated Host API to create a scheduled Worker graph and Cron
Attachment, replay its create, deliver a match through `pollScheduledDue`, update
to a different expression, and delete in reference order. It also confirms that
closing an in-flight delivery keeps its late native result unknown in SQL.
Those native ABI tests run within one Host process; they do not replace the
stand-in process-restart test or qualify native delivery after an OS restart.

A separate pinned-workerd process journey persists the real organization,
API-key identity, accepted Worker graph, Cron Attachment and match in the same
SQLite database. It SIGKILLs an identity-checked Host, restores with different
Host and native child PIDs, resolves the same match through a second attempt,
then checks Cron update, retrieval and reference-ordered deletion. Normal
teardown requires the child fixture's post-owner-stop witness and zero exit;
unproven shutdown retains its workspace. Effects are observed inside the native
module, not in an external durable destination. This proves that local native
restart path, not exactly-once external effects, an independent response-loss
case, ordinary-entry composition by itself, or Hosted qualification.

The normal Bun entry now also constructs the v2 UID-owner composition against
its canonical SQL, object store, clock and selected workerd binary. Before its
public listener opens, it reopens only private owner directories explained by
the same SQL Worker inventory and refuses missing serving owners or unexplained
directories. The normal entry registers complete ModuleWorker,
WorkerVersion and WorkerDeployment Forms only when both held WorkerBundle and
StaticAssetBundle backends target its exact Worker target, the selected native
binary and Actor/Workflow boot are available, all five private
SQLite/KV/ObjectBucket/Queue planes are configured, and Worker owners have
restored. It also registers the SQLiteDatabase, EdgeKVNamespace and
ObjectBucket target lifecycle Forms from those same stores. This intentional
complete map also registers WorkerCronTrigger, ActorNamespace, DurableWorkflow,
AtLeastOnceQueue and QueueConsumer. Their scheduler, native owner, broker,
settlement and producer capabilities are required to create referenced event
and Binding targets on a clean Host. A missing
prerequisite leaves the whole Worker Form unsupported, not a narrower Binding
profile. Endpoint Form support separately requires the actual selected HTTPS
listener's hostname, TLS and route-absence ports; without it the other Worker
Forms do not invent Endpoint readiness. The
internal factory now accepts an already-created operator sealer and gives both
Version admission and the native owner the same SQL-backed Resource-owned
configured-input custody. A local test uses synthetic nonextractable keys and
the selected native workerd artifact to prove HTTP create, same-value/omitted
PUT, mismatch refusal, configured fetch, and Host-PID restart without putting
the secret in public Resource output. The ordinary Bun entry parses its existing
operator runtime-input keyring once under the HTTPS/non-drain gate. It retains
the original current and previous AES keys for configured-input recovery and
derives nonextractable v2 transfer AES-GCM and comparison HMAC-SHA-256 keys with
distinct HKDF domain labels. The complete factory uses the same configured
sealer for admission and the runtime owner, and supplies the transfer/comparison
custody to the v2 engine. No key is generated from ciphertext or public config.
Keep retained key IDs available while their Resource ciphertext or Operation
comparison material is still needed. An absent or unavailable key refuses
sensitive Versions without deleting ciphertext.

The ordinary-entry native test additionally covers empty and nonempty private
input maps, accepted retries, changed-value refusal, secret-bearing HTTPS
execution, Host SIGKILL/new-PID recovery with a rotated retained key, updates,
and dependency-ordered deletion. It checks public Resource/Operation responses
and persisted SQL/object files for plaintext disclosure. Its synthetic keys,
local certificate and isolated network namespace are not production key
rotation or public TLS qualification. Other Bun-child stand-in tests do not
become native workerd evidence through this connection.

The optional Bun setting `TAKOSERVER_V2_WORKER_PRIVATE_PLANES` selects private
SQLite, KV, ObjectBucket, Queue settlement and Queue Producer services. It is an
exact JSON object with optional `sqlite`, `kv`, `objectBucket`, `queue` and
`queueProducer` records. Each selected record requires a distinct fixed
`privatePort` and an absolute `signingKeyFile`; SQLite additionally requires a
pre-existing private `stagingRoot`. The data root must be an existing absolute
owner-private directory. Key files contain 32–4096 raw bytes, are owner-private
and non-symlink, and are never generated or logged by this boot path.

Producer and settlement services use the same SQL-backed Queue custody but
different listeners and signing keys. Private listeners bind to loopback before
UID-owner restoration, and native authorization is unavailable until restoration
finishes. The same Producer boot authority is used by Version admission and
execution. With both Queue services configured, the internal factory also
composes AtLeastOnceQueue. A pinned-workerd organization-HTTP journey covers
Queue creation, a declared Producer Binding, `send`/`sendBatch`, retention update
and dependency-ordered deletion without per-Form overrides. The ordinary entry
still does not advertise incomplete Worker Forms. Its empty-owner process test
proves orderly stop/reopen of these listeners; the separate mixed-binding Host
process journey proves active Worker and Producer recovery through the internal
factory, not the ordinary entry or delivery settlement after a crash.

Orderly Bun shutdown freezes new v2 owner admission and awaits pending owner opens.
An active serving owner is suspended with retained custody, rather than treated as
a deleted Worker. An exact completed ModuleWorker deletion, or SQL proof that no
current publication exists, permits retirement-only closure; closure still requires
each recorded incarnation to be retired. An uncertain proof stops shutdown before
the dependent data planes and SQL are closed. A failed suspend never falls back to
destructive closure. Native owner/entry tests cover this dependency order;
normal-entry advertisement separately requires the complete boot selection.

A separate normal-`buildApp` local journey composes the
existing SQLiteDatabase, held SQLiteMigrationSet/Application, and this private
SQLite binding. It accepts the exact UID reference over organization HTTP,
executes native Worker SQL writes and reads, SIGKILLs the Host, restores the
same accepted graph with a different Host/native PID, then reads the same rows
and continues after a same-spec Database PUT. All test keys are synthetic.
An admitted old invocation also keeps its signed exact-incarnation SQLite
Binding while a replacement Deployment is pending and while that incarnation
drains; each call still checks the live native owner and current settled
Version/Database references, and retirement ends that authority.
That restart evidence alone does not qualify maximum legal SQLite input,
public HTTPS/TLS, or complete WorkerVersion/SQLiteDatabase Form support.

The native owner also exposes a private Actor graph observation port. It checks
every weighted Version's verified graph, exact process incarnation and listener
ownership under the owner lane, then fences accepted SQL currentness before
returning the observation. The ActorNamespace parser uses the published singular
`className` and exact Worker UID reference. An empty-namespace proof is scoped to
the physical tenant and namespace identity; it is not a claim about future
activity. The internal Actor Namespace admission now checks every selected class
in active and earlier accepted pending Deployments, using held verified Bundle
bytes and an atomic SQL graph predicate. Proven ABI failures and existing
Worker/class duplicates are dependency conflicts; unavailable inspection or a
graph change before acceptance is retryable busy, without Resource/Operation
creation. A separate physical backend can confirm an empty namespace before any
Deployment and delete it with authoritative absence proof. Its empty-namespace
tests use a semantic-inspector stand-in. The internal boot also composes the
executable Actor Binding and accepted-operation warm/runtime-count paths with
the same physical owner. Separate pinned-workerd tests exercise fetch and
WebSocket upgrade, active same-spec update counts, and first active creation.
These internal paths alone do not register ActorNamespace Form support or
establish Hosted or ordinary-entry qualification.

An Actor Binding may target a Namespace whose class is provided by a different
Worker. Admission checks the caller's accepted Version and sealed reference
separately from the Namespace's provider Worker, within the same authorized
organization, Space and execution target. Host restoration first rebuilds every
retained owner and private broker without admitting Actor delivery. It then
rechecks the complete caller/provider graph and opens one shared delivery gate;
self references and static A-to-B/B-to-A graphs do not wait on that same gate.
Standalone owners complete their own post-restore proof before admission.

Physical Actor leases persist exact Linux Host and child process identities.
The child stops before executing workerd, resumes only after its ownership
record is durable, and is killed when its Host dies. Recovery reclaims only an
exact owned lease whose Host and recorded child are proved dead; a fixed
exclusive claim serializes competing recoveries. Legacy, foreign, incomplete
or uncertain ownership stays unavailable and retains its data. An interrupted
recovery claim still requires operator repair rather than guessed cleanup.
A pinned-workerd Host-process test covers cross-Worker and self Binding calls,
distinct Host/Worker/Actor PIDs after SIGKILL, the same Actor ID and persisted
value, updates and dependency-ordered deletion. Actor class environments now
compose their own Version's declared Actor Bindings through the same retained
private broker sockets. The class configuration checks exact token, channel,
scope and socket ownership; weighted Versions may share only the same exact
broker identity. A separate native Host-process journey covers Actor A calling
another Worker's Actor B, B calling a different ID in its own Namespace, and
both Actor children restarting with the same persisted values.

The published ActorNamespace contract permits socket acceptance only when the
original client's upgrade reaches that Actor directly; a reservation cannot be
forwarded into another invocation. Nested A-to-B upgrade is therefore a refused
operation, not a missing positive runtime capability. The native journey checks
that refusal without changing B's accepted-socket count, live socket count, or
owned lease. A direct original-client upgrade to B echoes and closes normally.
After Host SIGKILL, a distinct Host and native children restore the same Actor
data, and a new socket ID echoes and closes; ordered deletion removes both
Namespaces' owned leases. This does not prove public-CA WSS or delivery of a
terminal callback for a connection lost with its Host. Recursive calls to the
same Actor ID remain unqualified.

The normal Bun entry can now opt in to its existing private v2 Actor and
Workflow boot ports with `TAKOSERVER_V2_WORKER_RUNTIME_BOOT`, for example
`{"actor":true,"workflow":{"maximumRegistrations":4}}`. The exact JSON
selection requires the configured held WorkerBundle backend and selected
workerd executable; Workflow additionally requires the operator's absolute
`TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY`. Native roots stay under the
existing private data root. Boot restores the single SQL-backed Worker owner
before opening ingress, polls Workflow due work as a separate tracked pass, and
closes Workflow/Actor execution before suspending that owner. This selection
alone does not register incomplete Worker Forms.
`TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS=1` explicitly selects the
existing v2 Worker Endpoint HTTPS boot in the ordinary Bun entry. It reuses
`TAKOSERVER_WORKER_ENDPOINT_SUFFIX` and the existing Worker TLS certificate/key
inputs, binds the shared listener on TCP 443, and rejects conflicts with the
ordinary control, Workerd, data-plane, or legacy Container Endpoint HTTPS
listener. Leaving the selection unset preserves the existing boot path. The
selected listener is supplied to Endpoint Form admission and closed during
ordered shutdown, synchronous Form assembly failure, and if the ordinary Bun
listener cannot start. Its presence alone does not mark an Endpoint Ready:
that requires exact publication and TLS/route readback. Local certificate/SNI
and route checks are not public DNS, external CA trust, or reachability
qualification.

After owner restoration, `internalFormFactoryForEndpoint(boot.endpoint)` composes
the same internal Form map against the existing Endpoint boot. It captures the
three Endpoint ports and retains the exact SQL, object store and clock checks.
It refuses composition before restoration or after owner suspension; a closed
boot cannot supply a positive TLS witness. This resolves the composition cycle
without adding another frontend or Resource ledger.

## Existing installations

The additive v2 tables do not convert or delete existing v1 records. Preserving
those records during source development is not a commitment to serve both Host
API versions. The normal router removes the old Takoform HTTP entry rather than
introducing a v2-to-v1 translator. Independent login, Console and standard-service
APIs are separate and are not removed because their path contains `v1`.

Before an installation switches, its operator must account for existing
Resources, pending or uncertain Operations, provider state and old writers.
Their treatment and the recovery route must be explicit; an unknown operation
must not silently become a new create. No live migration, deployment or data
deletion follows from adding this source module.

Legacy control-plane helpers, provider implementations and their retained state
are not a second v2 authority. Their remaining retirement/adoption work is
separate from this public Host route change. In particular, the old `/v1/forms`
catalog is not the v2 support endpoint. Existing native process tests that use
the retired v1 Host entry do not qualify the new v2 entry; their provider/runtime
recovery evidence must be preserved in explicitly historical harnesses or ported
against the actual v2 contract, not relabeled by changing a path string.

## Acceptance evidence

The same candidate must demonstrate acceptance, execution, read, update,
failure recovery and delete. Concurrency and lost responses must preserve the
same operation and resource identities. A restart test must terminate an OS
process and reopen the same persistent state, not merely construct another
JavaScript handle.

The pinned-workerd asset journey uses `buildApp` organization sign-in and API-key
authentication with the internal Form factory. It accepts a module-less static
Version, serves it through local HTTPS/SNI, and checks assets-first, worker-first,
SPA, GET, HEAD and POST behavior. A later PUT to the same Deployment keeps the
Endpoint hostname and serves the updated Version. This exposed an incorrect
requirement for Endpoint-only accepted output on a Deployment publication; the
frontend now checks the selected Endpoint identity and optional accepted output
without dropping its SQL or native currentness fences. Removing an accepted
execution asset copy makes native observation unknown and HTTPS return 503;
restoring its exact bytes restores serving. These are local self-signed TLS and
native execution checks, not public CA/DNS, normal-entry registration by
themselves or an OS-process restart test.

The pinned-workerd Service Binding journey accepts caller and target resources
through the authenticated Host fixture, then kills that Host process and proves
both previous native children stale. A distinct Host and native PIDs reopen the
same SQLite, file object store and owner roots. Service calls retain the original
URL/Host and exclude private transport headers; a target-only Deployment change
is visible without republishing the caller, followed by dependency-ordered
deletion. This is loopback fixture evidence, not public TLS, normal Form
registration by itself or a long-stream interruption proof.

Within one accepted publication, candidate revalidation reuses the exact
Operation/Version/ordered-Binding token projection instead of opening an orphan
broker for each pass. A different incarnation receives fresh credentials.
Read-only publication observation rechecks the current graph and existing
native/socket proof without opening another broker. Unknown legacy socket
custody is not adopted or deleted by this repair.

The opt-in normal Bun entry test also exercises one interrupted artifact
create: it discards the HTTP response body and returned IDs, observes a
nonterminal 0075 checkpoint with a partial SQL chunk prefix through a bounded
read-only query, then sends SIGKILL to that Host process. A new process opens
the same SQLite and file store, and the identical idempotency key identifies
the same Operation and Resource. It finishes custody, updates and deletes from
the held bytes after the original source is removed, while an unrelated
organization's Resource and custody remain unchanged. This is local OS-process
recovery at a completed checkpoint; it does not prove recovery from a kill
during a single SQL write, public TLS ingress, Hosted D1/R2, or native Worker
execution.

Portable core tests, self-host resource use, Hosted resource use and downstream
Provider/application installation are separate evidence. The complete portable
gate is necessary before integration, but is not a live qualification or a
production activation receipt.
