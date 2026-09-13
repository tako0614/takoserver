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
The JavaScript step callback projection and the workflow class's access to
declared environment bindings still need an explicit forward contract. Retry
normalization also remains unspecified: `retryPolicy` is optional, most of its
fields have no defaults, and `exponential` defines no multiplier. This
implementation does not supply those missing clauses by convention or edit
published definitions. An unfinished step replayed under a different step kind
also needs an explicit outcome; a completed memo, by contrast, is already
defined to replay by name alone.

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

Cloudflare's [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)
provide a separate durable-execution integration. Their existence does not
establish conformance to the selected name, deployment-selection, lifecycle or
retention semantics, and does not qualify a generic WorkerLoader as a stop
port. A concrete adapter must prove these properties before activation.

## Schema and rollout

Migration `0050_workflow_instances.sql` adds the instance and event tables.
`0051_workflow_execution.sql` adds run ownership, wake state and the step
journal without replacing the existing tables. Earlier migration bytes are
unchanged. The generated schema must come from the owning `schema:write`
command. The owning deployment inventory, exact migration hash, 0050-to-0051
wave and schema tests move with this migration; adding a file alone is not a
deployable schema change.

No live database is changed by adding this implementation. Shared, unknown and
production databases remain protected. A managed rollout requires the owning
schema transition, its predecessor evidence and exact readback. Old deployment
evidence remains tied to its old source and cannot stand in for the new schema.
Self-host startup applies known forward migrations and refuses a database from
a newer build: after migration, downgrading to a binary that does not know
0051 is not a rollback plan. Preserve the data and repair forward.

## Remaining runtime integration

The internal `workflow-execution` coordinator now implements run ownership,
completed-name replay, explicitly normalized retries, sleep/wait parking and
atomic event consumption. Its private `runOne` entrypoint returns immediately
for a future wake or another live owner; it does not keep a request sleeping
until the workflow becomes due. A future due-row scheduler remains a thin
caller of this same authority.

One exact claim predicate protects step writes and a single terminalization
path owns outcomes, retention and cleanup. The consumer instance facade waits
for stop acknowledgement even when an earlier controller has already written
a terminal status. Application outcomes and host/storage failures are separate:
a failed SQL commit or lost host session does not become `run_threw`.
Only the coordinator decides step-count and lifetime failures. An adapter's
`step_failed` outcome must correlate to an exhausted-step error emitted by that
same execution; an error label alone is not evidence. An application outcome
with an outstanding step is stopped and left retryable, not saved as complete.
The returned terminal result reflects the atomic settlement, not a mutable
application object or a later clock reading after stop acknowledgement.
The shared data codec is in `workflow-data`; no second JSON implementation or
application-specific state authority is introduced.

The coordinator is not wired to production entrypoints or exported from the
package root. Its execution-host protocol is not a selected app-facing Binding.
It still needs a real isolated class loader with then-current weighted
deployment selection, a qualified stop/deadline adapter and the forward callee
contract described above. These are runtime responsibilities, not tasks for
Takosumi or an application-specific adapter.

Self-host and managed implementations must ultimately project the same exact
consumer Binding, authorize each declared target, and connect it to this
storage and the executor. Until those paths and the complete execution
contract are qualified, neither a successful storage test nor a migrated
database enables Workflow support.
