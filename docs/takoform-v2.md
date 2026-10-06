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

The Bun entry can additionally select `sqliteMigrationSet` and/or `workerBundle`,
each with a stable `targetKey` and `heldArtifacts`. Each entry contains `url`,
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

WorkerBundle (`https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/`)
validates a UTF-8 manifest of at most 1 MiB, with 1–512 files,
canonical relative POSIX paths of at most 1,024 UTF-8 bytes, and exact HTTPS
artifact identities. Each file is at most 16 MiB and the aggregate is at most
128 MiB. The Host records only the validated bundle projection and held bytes;
it does not execute the Worker or create a data-plane endpoint.

The current Worker entry accepts an omitted/empty Form map but refuses either
configured artifact backend before accessing D1 or R2, until those Worker storage
paths are qualified. That is a current implementation limit, not a restriction
imposed by Takoform. Neither entry advertises WfP, Worker execution or other Edge
Forms through this configuration.
Discovery declares offerings, previews and privateInputs unavailable. Common
limits are a 1 MiB request, 100 items per page and a 24-hour replay window.

The Bun API listener remains HTTP behind an operator-controlled HTTPS front end.
For v2 paths it checks the incoming URL and `Host` authority against the configured
public authority before representing that request with the external HTTPS origin.
`Forwarded` and `X-Forwarded-*` cannot select this authority. Keep the backend
listener on a protected network; normalization is not TLS, proxy authentication,
or evidence that a public certificate/route works. The frontend must preserve
the exact public Host header. Non-v2 routes keep their existing handling.

## First implementation slice

The initial slice covers the required common HTTP operations and durable
acceptance. Offerings, previews and private inputs are not yet enabled and must
be reported as unavailable. In particular, a backend that requires private
inputs cannot be advertised while that capability is absent.

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

The normal Bun composition now connects this backend when explicitly configured.
This source fact is not Hosted D1, WfP, public TLS or production qualification.
Source and custody authorization are distinct: a caller
may have write access to a Space but no grant to a particular source artifact.

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

Portable core tests, self-host resource use, Hosted resource use and downstream
Provider/application installation are separate evidence. The complete portable
gate is necessary before integration, but is not a live qualification or a
production activation receipt.
