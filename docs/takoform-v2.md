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
write permission. Ordinary application wiring and live adoption remain separate
from adding this composition module.

## First implementation slice

The initial slice covers the required common HTTP operations and durable
acceptance. Offerings, previews and private inputs are not yet enabled and must
be reported as unavailable. In particular, a backend that requires private
inputs cannot be advertised while that capability is absent.

Tests may configure a local fixture Form and a persistent test backend. Those
tests exercise the real HTTP and SQL implementation, but do not qualify an Edge
Form, a Cloudflare backend, or a public deployment. The shipped self-host and
Hosted composition must not claim v2 support merely because this module exists.

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

These modules are a source candidate for a self-host path, not a claim that the
normal shipped application, Hosted D1 or a WfP backend now serves the Form. Its
organization access, scheduler, source mappings and durable target must be
composed explicitly. Source and custody authorization are distinct: a caller
may have write access to a Space but no grant to a particular source artifact.

## Existing installations

The additive v2 tables do not convert or delete existing v1 records. Preserving
those records during source development is not a commitment to serve both Host
API versions. The end state removes the old Takoform HTTP entry rather than
introducing a v2-to-v1 translator. Independent login, Console and standard-service
APIs are separate and are not removed because their path contains `v1`.

Before an installation switches, its operator must account for existing
Resources, pending or uncertain Operations, provider state and old writers.
Their treatment and the recovery route must be explicit; an unknown operation
must not silently become a new create. No live migration, deployment or data
deletion follows from adding this source module.

## Acceptance evidence

The same candidate must demonstrate acceptance, execution, read, update,
failure recovery and delete. Concurrency and lost responses must preserve the
same operation and resource identities. A restart test must terminate an OS
process and reopen the same persistent state, not merely construct another
JavaScript handle.

Portable core tests, self-host resource use, Hosted resource use and downstream
Provider/application installation are separate evidence. The complete portable
gate is necessary before integration, but is not a live qualification or a
production activation receipt.
