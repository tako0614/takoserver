# Workflow runtime implementation

## Current boundary

The instance store and execution coordinator are internal parts of a durable
workflow runtime. They are not an activated `DurableWorkflow` implementation. Discovery and
activation remain unsupported until the complete selected contract can run.
The self-host provider refuses nonempty WorkerVersion `workflowBindings`
instead of accepting a declaration it cannot project; see
[the provisioner](provisioner.md).

The selected `worker.workflow@1.0.0` Interface already defines instance
creation, status, durable event delivery, terminal retention and lifetime.
Its consumer Binding defines `create`, `get`, `status`, `sendEvent` and
`terminate`. These contracts do not require a vendor-native workflow service.
That published closure does not fully define the JavaScript step callback,
class environment, retry normalization or incomplete cross-kind replay. A
separate, unregistered forward candidate now supplies those clauses in
`takoform-forms`, at commit `59606f11d6d50e781383332f7c597de20a096e83`
(`docs/proposals/workflow-execution-contract.md`). It defines an ordinary
`new Export(env)` / `instance.run(event, step)` class surface without a vendor
base class. The candidate is authored and checked, not published, selected or
activated. This implementation does not fill the old contract's gaps by
convention or edit its published bytes.

The private coordinator records its normalized `retryDelaysSeconds` array on
first use and reuses that journaled array for every later attempt, including
replay under changed code. This is pre-activation conformance for the forward
candidate; it does not amend the published `worker.workflow@1.0.0` definition
or enable Workflow support.

An invalid or oversized `do` result consumes a failed attempt under that same
saved policy. The data-only encoder runs once before the result commit and
never invokes getters. A successful result is committed before a decoded copy
is returned. SQL failures stay infrastructure failures: they do not consume an
application retry or manufacture `step_failed`.

## One persistence module

[`src/workflow-instances.ts`](../src/workflow-instances.ts) owns instance
identity, status, event retention and expiry behind the existing atomic `Sql`
port. The self-host SQLite adapter and a managed provider's private SQL adapter
can use the same implementation. A separate database file per workflow would
add file lifecycle and migration ownership without strengthening the required
atomic state/event changes.

The caller supplies a trusted tenant/workflow-resource scope, a clock and an
ID generator. The store does not authorize a caller or check whether an active
deployment exports the requested class. A future runtime integration must
establish both before allowing creation; storing a queued row is not proof
that the workflow is executable.

The public instance ID is scoped to one tenant and DurableWorkflow resource
incarnation. It remains occupied while the instance is live or within terminal
retention. Mutations capture both a private execution ID and the creation
instant. Together they distinguish reuse of that public ID after retention,
even if an injected ID generator repeats a private ID. Cleanup rechecks the
parent's expiry inside the atomic write; a previously selected ID alone is
not authority to remove a replacement's events. Instances remain runtime data,
not planned Resources.

Events are committed before `sendEvent` resolves, including events arriving
before a wait exists. Terminal instances refuse new events. Terminalization
and event removal share an atomic database operation; an in-process mutex
cannot provide this guarantee across restarts or multiple processes.
Delivery also brings a matching pending wait's wake time forward in that same
atomic batch. Ending, expiring, sweeping or replacing an instance explicitly
removes its step journal, even through a SQL adapter that does not enable
foreign-key cascades.

The lifetime limit is 31,536,000 seconds and terminal retention is 2,592,000
seconds, as fixed by the selected Interface. Expiry is based on recorded
instants, not the time a process restarts or a sweeper happens to run. A held
instance expires into `errored` with `lifetime_exceeded`. After retention,
lookups report `unknown_instance` even before physical cleanup. Repeated
termination of an already-terminal instance preserves its existing outcome.

The data-only JSON encoder does not invoke getters or `toJSON`. It checks the
published UTF-8 byte and top-level property limits without adding a nesting
limit. Invalid inputs to this internal module are not a substitute for the
future consumer facade's complete error mapping.

## Execution isolation is a real prerequisite

The internal coordinator requires a host that can open a paused execution,
enforce its hard deadline, and acknowledge that an identified execution has
stopped. A database lease only fences state writes; it cannot stop application
code. Termination retains the run identity until the host acknowledges stop
or the hard deadline has elapsed. Seeing a terminal database status is not by
itself permission for the consumer's `terminate()` Promise to resolve.

Parking has the same ordering requirement: the step journal records private
intent, the host acknowledges stop, and only then does one exact-claim update
publish `sleeping`/`waiting` and clear ownership. A failed stop leaves the
instance running and owned. Events arriving while stop is pending remain in
the durable inbox and participate in that update's wake calculation. An expiry
or terminal transition that wins during stop cannot be overwritten by parking.

The selected Interface requires an absolute instance lifetime cutoff and
actual execution shutdown; it does not prescribe renewable short leases. The
current coordinator does use its short lease's expiry as proof that an old
execution is dead, so an adapter for this implementation must enforce that
deadline independently of the controller. A SQL lease or a timer in the same
application context is insufficient. Changing that private recovery strategy
would require separate implementation and qualification, not a new public
Workflow contract.

This is not yet a qualified self-host or WfP adapter. In particular, disposing
a Worker RPC handle is not such an acknowledgement: upstream workerd states
that RPC cancellation cannot cancel already-running JavaScript continuations.
The current Dynamic Worker limits describe CPU and subrequests, not a
renewable wall-clock deadline. This is an implementation feasibility gap, not
a reason to redefine the selected Interface. See the
[workerd RPC implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/worker-rpc.c%2B%2B)
and [Dynamic Worker limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/).
Those upstream observations are not a runtime qualification of the locally
pinned binary.

Cloudflare documents [facet abort](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/#abort)
as shutting down a running facet and invalidating its stubs while preserving
storage. This is a candidate scoped stop primitive when application code runs
inside that facet, not evidence that disposing an ordinary RPC handle stops
code. The static closed-graph native fixture passed against the exact pinned
artifact on 2026-09-14: one test, 61 assertions. It verifies aborting a held-I/O
callback, rejection of stale and outstanding calls, an existing sibling's
unchanged generation, and replacement with retained state and no post-abort
marker or catch/finally report. The fixture retains its A-B-A replacement and
closed-import checks.

A separate native CPU-bound probe on the same pinned artifact subsequently
failed: after the synchronous application entry marker, its supervisor's
control/stop sequence could not finish within two seconds. The test process
then killed only its own fixture child. That cleanup is not a per-execution
stop acknowledgement. The existing same-process static-facet carrier therefore
does not qualify this coordinator's stop/deadline protocol. Held-I/O abort is
still proven; synchronous CPU preemption, controller-loss deadline enforcement,
stop-before-open ordering and managed WfP conformance are not. The opt-in probe
is `tests/workerd-native-workflow-facets.test.ts`; its failure must not be
silently converted into supported discovery or an expected-success test.

The Form publisher's forward callee candidate is now available for
pre-activation implementation. A host-private transport must follow that exact
contract rather than quietly choose constructor, environment, callback or error
semantics. The existing caller-only Binding is not a substitute. A
JavaScript-only facet supervisor in that same native process is insufficient
on the tested artifact. The next carrier needs a stop/deadline mechanism
outside application execution, such as native interruption or a separately
supervised execution process. Killing the existing shared workerd process is
not a per-run solution. Either replacement must prove isolated stop and
controller-loss recovery before being adopted. This native result does not
establish the behavior of Cloudflare's managed runtime.

Cloudflare's [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)
provide a separate durable-execution integration. Their existence does not
establish conformance to the selected name, deployment-selection, lifecycle or
retention semantics, and does not qualify a generic WorkerLoader as a stop
port. A concrete adapter must prove these properties before activation.

### Self-host process carrier

The first replacement carrier uses one small, Host-owned Go guard and one
dedicated workerd child per active execution. The ordinary shared HTTP workerd
is not its child and is never killed to terminate a Workflow. A new native
per-execution isolate with an externally routable interrupt was also considered:
it requires native allocation, interrupt lifetime and deployment ownership that
the currently pinned runtime does not provide. The separate-process boundary
is the smaller first implementation. Its cold-start and memory costs must be
measured and bounded by operator concurrency before activation; it is not a
claim that unlimited parallel workerd processes are economical.

[`services/workflow-execution-guard`](../services/workflow-execution-guard/)
owns the direct child, deadline and reap. The private
[`workerd-execution-guard` client](../src/workerd-execution-guard.ts) sends
bounded, ordered JSONL commands over inherited pipes. Registration arms a lease
without starting workerd. Start accepts only the prepared private configuration
for the already-selected workerd binary. No shell, PATH lookup, provider
credentials, inherited controller environment or app-facing process API is
introduced. The transport carries neither app input nor step results.

The guard enforces the absolute realtime lease and a monotonic upper bound.
A discontinuous system-clock change fails the run closed rather than granting
a longer lease. Renewal may not revive an expired lease or exceed the instance
lifetime. Linux's
[`timerfd` cancellation-on-clock-set](https://man7.org/linux/man-pages/man2/timerfd_create.2.html)
provides that clock-change notification. No test changes the machine clock.

Controller pipe EOF stops and reaps the child. Guard death has a separate
kernel-backed boundary: the child receives `Pdeathsig = SIGKILL`; the spawning
Go goroutine remains on its creating OS thread through `Wait`, because Go
documents [parent-death notification as thread-scoped](https://pkg.go.dev/syscall#SysProcAttr).
The guard controls the exact direct child, not arbitrary descendants, stale
PIDs or a shared process group. The selected workerd application sandbox has
no subprocess interface. Privileged process suspension, a suspended kernel or
a compromised operator are outside this user-process fault model.

A stopped ACK is sent only after child reap, or after stopping a registration
that never spawned. Client timeout, EOF and guard exit are infrastructure
failure, not stop proof. The adapter must still use the coordinator's existing
lease wait when local ownership cannot be proved. Stopped registrations cannot
be started or renewed. Replies match request IDs; registration must be
acknowledged first, but completed stop may overtake an in-flight start/renew
and cancels those unresolved requests. No execution is automatically restarted
by the guard.

This is a private process primitive, not by itself a complete
`WorkflowExecutionHost`. The class loader, verified module/env projection,
weighted deployment selection, step callback transport and genuine-error
provenance still have to be composed with it. In particular, starting a
prepared workerd process does not prove the selected class is ready or that a
Workflow step is durable. The client is not connected to serving entrypoints,
and no new binary search or implicit runtime fallback is enabled. WfP needs
its own qualified implementation of the same private host protocol; a local
Linux process guard is not a managed Cloudflare implementation.

The opt-in `tests/workerd-native-execution-guard.test.ts` targets only the
exact pinned workerd and an explicitly supplied guard binary. It exercises
paused registration, synchronous CPU execution, stop/reap, lease expiry,
controller EOF, guard loss and an independently running HTTP sibling. This
is distinct from the failed same-process facet probe, which remains unchanged.
Portable protocol tests do not substitute for this native qualification.

### Private stop/message barrier

The guard has an opt-in child-stderr journal profile. A host-private bridge
captures the original console logger and invocation primitive before tenant
module evaluation. Before each application-to-host frame, it emits a small
private-token/sequence marker synchronously. The bounded payload travels over
a separate private asynchronous channel. No application data or provider
credential is written to the journal pipe. Ordinary child logs are discarded;
only exact token-qualified markers enter the controller protocol.

For this profile, STOP acknowledgement additionally requires child-stderr EOF,
reader completion and ordered forwarding of all preceding markers. An invalid,
missing or unbounded marker stream fails closed. The controller's marker
observer performs synchronous bounded bookkeeping before a following ACK can
resolve. A callback Promise is not proof of completed bookkeeping.

`workflow-transport-journal` correlates these markers and payloads for one
execution. It is an ephemeral transport buffer, not another durable step
history. It dispatches only paired frames, in sequence, within a 64-frame
window. After physical stop and both ingress barriers, its irreversible seal
rejects an unmatched marker or payload and refuses later dispatch. A full
transport envelope is limited to 2 MiB; the separate published Workflow data
limits still apply to decoded application values. Dispatch only latches a
driver/control operation and must not wait for the result of a parked step.

The opt-in `tests/workerd-native-workflow-journal.test.ts` checks the exact
pinned runtime with a newly built guard. It replaces tenant-visible console
and Reflect operations, emits a marker and enters non-yielding JavaScript,
then observes exact child CPU progress without waiting for the marker before
STOP. A delivered asynchronous companion permits seal; a withheld companion
must reject seal and every late payload. This is a native primitive check,
not qualification of a complete class loader or application-facing transport.
An asynchronous-only transport cannot distinguish an absent frame from a
frame lost in the application's in-memory send queue at forced stop, so it is
not a fallback when this journal cannot be proved on a runtime.

### Private self-host lifecycle composition

`selfhost-workflow-execution-host` connects the coordinator's private port to
this guard. Registration reserves the complete claim identity before any
asynchronous work. It does not prepare or evaluate application code. `run`
asks a host-owned preparation port to select the then-current deployment and
snapshot verified modules/env, then starts only that registration's process.
The preparation port must never import tenant modules into the controller.

Stop is irreversible for a registered session. It aborts preparation and
requests guard stop without waiting for preparation, START acknowledgement or
an application result. After reap, the prepared transport must seal all prior
application frames before artifacts are removed and stop is acknowledged.
An unresolved parked step must not block that transport barrier. Failure to
prove reap or seal is an infrastructure failure, not successful termination;
the registry retains identity and artifacts for recovery. Cleanup and seal can
be retried without restarting the process. A never-started guard's observed
exit is enough to release a failed registration, but guard exit after START
is not child/message proof.

The coordinator calls `openPaused` once per exact current SQL claim. A valid
successor claim changes epoch/owner; the private port is not an authorization
endpoint for replaying arbitrary stale identities. The bounded registry keeps
stopped tombstones through the largest requested lease, including renewals
whose acknowledgement was lost. It never prunes an unproved stop merely
because the controller clock advanced. Capacity exhaustion refuses admission.

This composition is dormant and not a qualified serving host. Its focused
lifecycle tests use fake process and preparation ports. The separate native
HTTP fixture composes real guarded workerd, the canonical env projector and
the durable coordinator; it is not the production deployment selector. Raw
workerd is not a hardened multi-tenant sandbox;
this lifecycle code does not add or claim that security property. No WfP or
public Workflow activation is enabled by this module.

### Private HTTP class transport

`workflow-http-worker` is a host-private bootstrap: canonical data/class
helpers are statically initialized before a dynamic application import on
RUN. The generated self-host wrapper exposes its existing `projectEnv` under
a fixed private export, so the class receives the same declared environment
as ordinary handlers. The wrapper is imported before retrieving the tenant
namespace. Neither controller nor preparation evaluates tenant code. The
closed-graph module policy and `disallow_importable_env` remain required; the
companion binding and journal nonce are not application env.

`workflow-http-controller` implements one concrete request/response turn
protocol. A call first lets the durable driver request its name, then requests
pending arguments only when the driver needs them, and invokes an effect only
when instructed by that authority. Completed-name replay therefore skips
unused arguments and effects. Canonical application JSON is embedded as a raw
value in the private envelope rather than double-encoded. A transport failure
during a pending argument or effect is infrastructure failure; only an actual
application effect failure consumes an attempt. Error-origin tokens are
private and retained per failed step name, not per invocation.

`selfhost-workflow-http-transport` owns the bounded loopback companion ingress.
It reserves each response before recording its payload in the outer journal;
only marker/payload pairing dispatches a frame. After physical stop, it closes
ingress and joins body readers without waiting for parked driver results. The
outer lifecycle then seals the journal before disposal. A failed RUN response
or an already-recorded frame's response failure rejects the run, not that
physical stop proof; incomplete ingress still refuses the barrier. Its
configuration callback is abort-aware and owns cleanup of partial artifacts. It is not a
general RPC framework or a published Binding.

RUN and readiness use one per-execution Unix socket and a fixed private request
origin, with redirects refused and bounded response bodies. The companion
continues to own its listening loopback socket throughout preparation; neither
direction reserves and closes a TCP port for a later process to reopen.

The opt-in `tests/workerd-native-workflow-http.test.ts` exercises the pinned
runtime, dynamic class load, generated env, durable completed-name replay and
genuine/forged error paths. Captured native Response accessors are located
through the trusted prototype chain during bootstrap: workerd inherits its
`body` accessor from `Body`, rather than placing it on `Response.prototype`.
The captured logger is also called once before application evaluation, using
an empty ordinary log line that the guard discards. The pinned runtime lazily
initializes its native console formatter on first use; capturing the entry
function alone did not initialize that dependency. Subsequent private markers
must still pair with their payloads and pass the stop/seal barrier.

The selected runtime still has unresolved startup and in-run compatibility
gaps when an application replaces Promise methods. Separate raw dynamic-import
and raw private service-fetch probes reproduce the failures without any
Workflow helper imports. The native corpus retains both as expected
infrastructure refusals, with zero durable steps and physical stop, journal
seal, owner release and artifact disposal; these are **not** successful loader
qualification. A separate positive case replaces non-Promise intrinsics
inside `run`. Captured helper intrinsics do not make the native module
evaluator or native service-fetch machinery immune to application mutation.
The implementation does not restore tenant globals, exclude these cases from
the forward contract or claim full runtime qualification.

A callable `Object.prototype.then` exposes a related native Response-fulfillment
gap. A helper-free private fetch reproduces thenable assimilation before the
helper can box the native response. The memo-replay refusal case retains
exactly its first completed durable step, creates no further step, and requires
the same nonterminal result, owner release and stop/seal/disposal boundary.
Ordinary completed-name replay and the helper's own final Response protection
remain separate positive cases. These native gaps require a different qualified
transport/runtime boundary, not an observable rewrite of tenant prototypes.

### Capturing the active Worker Version

`readWorkerdSelectedActiveVersion` in `workerd-runtime` provides a Host-private
publication reader, outside the provider-facing `WorkerdRuntime` interface and
the package-root exports. It selects once from the authenticated, actually
activated weighted deployment using a caller-supplied basis point. It does not
reconstruct an environment from the provider's desired bindings: those may
describe a publication that failed to activate.

The reader requires the expected ModuleWorker resource UID and captures the
selected application modules, Host-private modules and optional assets in the
same reads that verify their sizes and digests. The logical site preserves the
committed environment and binding declarations, including the variant's empty
hostnames; deployment routes are not projected into an execution subprocess.
No physical paths or unselected Versions are returned. A final target
activation and exact-pointer reread refuses a crossing publication. A successful
read owns an in-memory snapshot; later publication or file changes cannot
change the context it captured.

This snapshot includes secrets in vars and private binding declarations. It is
short-lived execution input for the trusted config renderer, not a status DTO,
log payload, provider response or durable record. Release references after
child disposal; JavaScript strings do not provide a meaningful zeroization
guarantee. Missing/deactivated or crossing publications and a stale expected
Worker UID return no selection; malformed or tampered storage is an error.

### Preparing a private execution

`createSelfhostWorkflowPreparation` now connects that reader to the guarded
HTTP transport. Its trusted target resolver is called for each preparation,
not when an instance is created. The target must come from the exact accepted
Workflow Resource, immutable class name, worker relation and active self-host
realization in the same tenant. Instance parameters cannot select a script,
Worker UID or class. The durable target resolver and scheduler are not wired
yet; this seam does not bypass the existing class-runtime admission refusal.

The loader adds a tiny literal startup module and the tracked Host-only
bootstrap bundle to the selected closed graph. The generator bundles only
trusted helpers, independently of executions; ordinary check compares its
output without writing. Tenant code is never bundled by the controller.
Startup imports the helper statically, while wrapper/application imports happen
only on RUN. Generated module names avoid Host namespace collisions and the
application main name. The pinned resolver resolves an import of the exact
application main before a same-named Host module; only the configured startup
entry is exempt. A published wrapper whose name equals application main is
therefore refused here, not reinterpreted or silently replaced.

`writeWorkerdPrivateExecution` reuses the serving renderer's module provenance,
media type and private ordinal-file mapping. Each execution gets a fresh 0700
directory and 0600 code/config files, exact committed vars, no public hostname
routes and a denied global outbound service. A declared data-plane facade uses
the current Host listener supplied by composition, never its persisted
prior-process address. Its sensitive bindings remain on the facade only.
Versions declaring service bindings are explicitly refused until a private,
target-UID-fenced bridge exists. Asset/event ingress services are not class env
bindings and are not installed in the subprocess.

The native fixture publishes a weighted filesystem graph and uses this loader,
rather than assembling a second handwritten config or bundling per run. Its
fake publication readiness is fixture setup, not Form admission or live
serving evidence. Before RUN it checks native readiness even for a module that
throws at top level, proving that readiness does not evaluate that module.
Full binding/resource routing, durable target resolution, scheduler integration,
complete native failure qualification and the managed WfP backend remain
unfinished. No serving entrypoint selects this execution adapter; Workflow and
Actor support remain false.

## Schema and rollout

Migration `0050_workflow_instances.sql` adds the instance and event tables.
`0051_workflow_execution.sql` adds run ownership, wake state and the step
journal without replacing the existing tables. `0052_workflow_termination_intent.sql`
adds the private `termination_requested` bit, defaulting to zero, so controller
loss cannot lose a pending consumer termination. Earlier migration bytes are
unchanged. The generated schema must come from the owning `schema:write`
command. The owning deployment inventory, exact migration hashes, 0050-to-0051
and 0051-to-0052 waves and schema tests move with these migrations; adding a file alone is not a
deployable schema change.

No live database is changed by adding this implementation. Shared, unknown and
production databases remain protected. A managed rollout requires the owning
schema transition, its predecessor evidence and exact readback. Old deployment
evidence remains tied to its old source and cannot stand in for the new schema.
Self-host startup applies known forward migrations and refuses a database from
a newer build: after migration, downgrading to a binary that does not know
0052 is not a rollback plan. Preserve the data and repair forward.

## Remaining runtime integration

The internal `workflow-execution` coordinator now implements run ownership,
completed-name replay, explicitly normalized retries, sleep/wait parking and
atomic event consumption. Its private `runOne` entrypoint returns immediately
for a future wake or another live owner; it does not keep a request sleeping
until the workflow becomes due. A future due-row scheduler remains a thin
caller of this same authority.

One exact claim predicate protects step writes and a single terminalization
path owns outcomes, retention and cleanup. The consumer instance facade first
saves termination intent without changing the public status or dropping the
current owner. That intent prevents new claims, steps, heartbeats and ordinary
completion/park writes. After exact stop proof, one fenced transaction publishes
termination and removes the journal/events. `runOne` recovers saved intent
without evaluating application code. Failed stop preserves intent and ownership
for retry. A concurrent lifetime expiry or an existing exact terminal winner
remains authoritative; a delayed finalizer cannot terminate a replacement
incarnation. The raw instance store is not this runtime-owned consumer facade.
Application outcomes and host/storage failures are separate:
a failed SQL commit or lost host session does not become `run_threw`.
Only the coordinator decides step-count, lifetime and step-definition failures. An adapter's
`step_failed` outcome must correlate to an exhausted-step error emitted by that
same execution; an error label alone is not evidence. An application outcome
with an outstanding step, overlapping calls or pending cross-kind name reuse
causes the forward candidate's `step_definition_mismatch`. This is a Host
stop, not an exception that application catch/finally can intercept. For run
settlement, stop acknowledgement precedes terminal publication, including completion and bounds;
an elapsed lifetime while stopping cannot be published as timely completion.
The returned terminal result reflects the atomic settlement and a validated
output snapshot, not a mutable application object.
The shared data codec is in `workflow-data`; no second JSON implementation or
application-specific state authority is introduced.

`workflow-class-execution` now projects ordinary JavaScript constructor/run
semantics onto that private driver. It receives only the selected declared env
and an instance event; no vendor base class is required. The module is **not an
isolation boundary**: a loader must evaluate it and application modules inside
the qualified execution context, never import tenant modules into the Host
controller. It does not perform weighted selection or class-readiness checks.

The driver receives lazy name and pending-argument preparation separately.
This keeps serialization, finished-history lookup and first configuration in
one authority: completed names skip unused invalid arguments, while new or
pending same-kind calls validate before any write or effect. A separate facade
history cache or eager argument validation would produce different replay
behavior. Only checked JavaScript argument errors are projected as TypeError;
storage/control failures are not delivered to application catch/finally.
Retry policies become bounded private delay arrays, and the existing durable
journal keeps the first policy across fresh class invocations.

The class projection tracks its app-facing Promise settlement, not just the
controller's Driver call. Overlap or run settlement with an unresolved app
step invokes a private mismatch control; the coordinator still owns stop and
terminal writes. Genuine step Errors have immutable own names and per-context
WeakMap provenance. Exact rethrow retains the original controller error;
name copies and wrappers do not. The private HTTP transport correlates that
provenance without exposing correlation material to the application.

The complete private Host stop acknowledgement also needs a transport barrier:
app-to-Host driver/control messages emitted or enqueued before physical stop
must have been delivered and processed by the coordinator, or the session must
permanently fail. No earlier message may arrive after that acknowledgement.
Quietly dropping a delayed
mismatch message could let a park operation publish first. The process guard's
reap acknowledgement alone does not provide that message barrier. The future
Host composition owns both; a failed transport is not a successful park.

The additional stored mismatch reason is a source-type/parser extension for
this internal implementation. Published Interface schemas and selected support
are unchanged; no migration or new serving path is implied by that extension.

The coordinator and class projection are not wired to production entrypoints
or exported from the package root. Their execution-host protocol is not a
selected app-facing Binding. The private class/transport composition still
needs the real then-current weighted deployment selector, complete resource
bindings and native qualification. Publication and exact contract
selection remain separate from this private implementation. These are runtime
responsibilities, not tasks for Takosumi or an application-specific adapter.

Consumer-requested termination uses the durable intent and stop-before-publish
path described above. The raw instance store alone is not that runtime facade;
serving composition must use the facade rather than bypass its stop barrier.

Self-host and managed implementations must ultimately project the same exact
consumer Binding, authorize each declared target, and connect it to this
storage and the executor. Until those paths and the complete execution
contract are qualified, neither a successful storage test nor a migrated
database enables Workflow support.
