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
the author's site, install a package, or grant permission. Support and execution
must use the same configured map; an adapter is registered only when it fulfills
the Form's required operations. v1 admission, package signatures and HTTP
prepare calls are not part of this path.

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
Bindings, private inputs, assets and scheduled/queue delivery remain explicit
internal refusals, and this portable path is not native qualification.

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
existing custody but denies new source acquisition. The current owning deploy
contract applies at most 0066 to existing/integration D1 and 0069 to a fresh
production D1; 0075 and 0081 are only in the audited source inventory. Thus this Worker
path is source/local-test qualified, not currently publishable as a working
artifact Form through the owning deploy path. A separately authorized schema
wave must precede enabling any of the three Form blocks in a deployment.
This artifact-configured normal Worker startup guard checks required columns,
tables and trigger markers; it is not byte-for-byte DDL attestation or live
migration qualification.
Neither entry advertises WfP or Worker execution through this configuration.
These Forms are management and custody surfaces only; they do not serve assets
or execute Workers.
Discovery always declares offerings and previews unavailable. It declares
`privateInputs` only when `buildApp` receives an explicit operator-selected
`v2PrivateInputCustody` keyring; the default public entries omit it and still
declare the capability unavailable. Per-Form support additionally requires an
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
Cloudflare namespace-create path also cannot safely reconcile a lost create
acknowledgement. Neither path becomes compatible by wrapping its old request in
a new HTTP envelope.

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

## Worker runtime integration in progress

Worker Form input parsing and runtime integration are separate from support
registration. The current source parses ModuleWorker 0.3.0, WorkerVersion 0.5.0,
WorkerDeployment 0.4.0 and WorkerEndpoint 0.3.0, but does not register those Forms
in the normal application yet.

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
readback cannot be proved. This generic seam is not connected to public v2 Worker
Forms: those Forms are not registered in the normal application and do not call
it. It does not provide multi-process fencing or invocation retirement, and it
does not establish v2 Worker publication or traffic readiness.

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

The owner is not registered by the normal application. Its portable tests do
not qualify the pinned native workerd binary. Orderly closure can release its
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

Remaining work includes actual Worker Form backends and their normal-entry
composition, invocation retirement, and Endpoint routing. Neither the existing
generic publication seam nor these focused tests establish complete Worker Form
support, public HTTPS delivery, or Hosted qualification.

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
public Worker deletion. The primitive is not registered in the normal runtime.

## Code Version and scheduled delivery composition

The internal code WorkerVersion backend requires a semantic module inspector.
It validates held Bundle bytes and the exact declared/exported handler set,
without publishing a Deployment or granting event delivery. The software
extension exports the same `inspectV2WorkerCodeVersionEligibility` check and
`V2WorkerModuleInspector` port for private execution adapters. It does not ship
a native runtime or qualify an inspector supplied by the embedding Host.
Unsupported resource Bindings, secrets and queue delivery remain explicit
refusals in this code projection, not claims of complete WorkerVersion support.

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

The owner projects a private, incarnation-bound scheduled-event capability
before publication. Delivery checks the current serving graph and does not use
an HTTP response as proof that `waitUntil` work has retired. The integration
journey uses actual Host HTTP, persistent SQLite, SIGKILL and a new Host PID,
and executes the verified held JavaScript module in a Bun stand-in. It checks
same-match redelivery, a non-equivalent schedule update and delete/drain. That
evidence is not native workerd ABI, normal application Form registration,
Hosted scheduled delivery or production readiness.

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
