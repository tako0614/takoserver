# Workflow runtime implementation

## Current boundary

The instance store is the first internal part of a durable workflow runtime.
It is not an executable `DurableWorkflow` implementation. Discovery and
activation remain unsupported until the complete selected contract can run.
The self-host provider refuses nonempty WorkerVersion `workflowBindings`
instead of accepting a declaration it cannot project; see
[the provisioner](provisioner.md).

The selected `worker.workflow@1.0.0` Interface already defines instance
creation, status, durable event delivery, terminal retention and lifetime.
Its consumer Binding defines `create`, `get`, `status`, `sendEvent` and
`terminate`. These contracts do not require a vendor-native workflow service.
The JavaScript step callback projection and the workflow class's access to
declared environment bindings still need an explicit forward contract. This
implementation does not supply those missing clauses by convention or edit
published definitions.

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

## Schema and rollout

Migration `0050_workflow_instances.sql` adds only the instance and event
tables and their indexes. Existing migration bytes are unchanged. The generated
schema must come from the owning `schema:write` command. The owning deployment
inventory, exact migration hash, 0049-to-0050 wave and schema tests must move
with this migration; adding a file alone is not a deployable schema change.

No live database is changed by adding this implementation. Shared, unknown and
production databases remain protected. A managed rollout requires the owning
schema transition, its predecessor evidence and exact readback. Old deployment
evidence remains tied to its old source and cannot stand in for the new schema.
Self-host startup applies known forward migrations and refuses a database from
a newer build: after migration, downgrading to a binary that does not know
0050 is not a rollback plan. Preserve the data and repair forward.

## Remaining runtime integration

The store does not yet execute `run`, record completed steps, schedule retries,
sleep, consume events for waits, or load a class from the current weighted
deployment. Those are separate implementation steps within the same runtime,
not responsibilities of Takosumi or an application-specific adapter.

Self-host and managed implementations must ultimately project the same exact
consumer Binding, authorize each declared target, and connect it to this
storage and the executor. Until those paths and the complete execution
contract are qualified, neither a successful storage test nor a migrated
database enables Workflow support.
