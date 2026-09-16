# Running the Bun provisioner

Production Cloudflare execution and managed capacity are owned by the private
deployment composition; this public Bun provisioner does not host that runtime
or its provider credentials. The public API Worker exposes only its typed,
credential-free public contract. The Bun entry is a different composition: it
always executes current Provider3 Edge Forms on the local workerd-backed
provider.

The Bun process can expose that provider through one authenticated endpoint for
an explicitly composed external control-plane client. A provider call enters,
and a classified ticket leaves. No current official Takoserver Worker composes
that remote client. Generic Cloudflare credentials do not select a shared
artifact store. The Bun composition owns local SQLite and local exact-identity
artifact bytes together; its R2 HTTP adapter is retained only for read-only
provisioner/package use.

Most providers will not need this. One that reaches its backend by calling an
HTTP API with a credential fits a Worker exactly, and adding it means adding a
module rather than a machine.

## Ordinary stable mode

The normal `bun src/entry-bun.ts` process uses the stable self-host Provider3
pack. Relevant variables are:

| Variable | What it is |
|---|---|
| `TAKOSERVER_PROVISIONER_TOKEN` | Shared endpoint credential. Without it the provisioning path is not served. |
| `TAKOSERVER_DATA_ROOT` / `TAKOSERVER_DB` | Durable local state. |
| `TAKOSERVER_WORKERD_BINARY` | Absolute path to the exact closed-graph workerd artifact. Takoserver verifies it, snapshots those bytes under the private data root, and uses only that snapshot for inspection and serving. Without it, or when its digest or resolver probe disagrees, Worker execution is disabled while unrelated self-host capabilities remain available. |
| `TAKOSERVER_SELFHOST_TENANT_RUN_CREDENTIALS` | Set to exactly `1` to serve `POST /v1/selfhost/tenant-run-credentials`; otherwise that path is a 404. |
| `TAKOSERVER_SELFHOST_TENANT_RUN_CREDENTIAL_KEY_ID` | Optional dedicated runner-credential key identity (default `takoserver-selfhost-tenant-run`). It must differ from the ordinary runtime signing key id; each validated id owns a separate `0600` private-key file under the data root. |
| `TAKOSERVER_WORKER_ENDPOINT_SUFFIX` / `TAKOSERVER_SUFFIXES` | Addresses the local provider may issue. |
| `TAKOSERVER_WORKERD_TLS_CERT_FILE` / `TAKOSERVER_WORKERD_TLS_KEY_FILE` | PEM paths for the Worker socket. Both or neither. |
| `TAKOSERVER_WORKERD_TLS_CERT` / `TAKOSERVER_WORKERD_TLS_KEY` | The same two halves as PEM text. |
| `TAKOSERVER_WORKERD_PORT` / `TAKOSERVER_WORKER_ENDPOINT_PORT` | Where Workers are served, and the port a published `WorkerEndpoint` address carries. A `WorkerEndpoint` needs `https` on the default port, so this deployment mints one only with TLS on 443 in workerd or a 443 front end declared with `TAKOSERVER_WORKER_ENDPOINT_PORT=443`. Anything else runs Workers and storage and says at boot that it can publish no endpoint. |
| `TAKOSERVER_OPERATOR_PUBLIC_JWK` | Public half of the operator key. |
| `TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK` | Optional login-only operator key; never authorizes funding. |
| `PORT` | Where to listen. |
| `TAKOSERVER_DATA_PLANE_PORT` | Optional fixed port for the loopback KV/SQL data planes. Without it the kernel picks one and the process prints it. |

`CLOUDFLARE_ACCOUNT_ID` is provider control-plane input only in this mode. It is
not provider-selection authority. `TAKOSERVER_D1_DATABASE_ID` and
`TAKOSERVER_R2_BUCKET` are not supported by the Bun entry: they are rejected
before any local directory, database, or key is opened because request-time
control and artifact writes require capabilities their HTTP adapters do not
provide. `TAKOSERVER_ZONES` is rejected because DNS and
Worker-route authority belongs to the private deployment owner. The retired
implicit `TAKOSERVER_EDGE_FORMS` switch is rejected as well.

### Self-host runner credentials

The optional runner-credential endpoint is Host-specific authenticated HTTP on
the ordinary public listener. It is not route-less and it is not protected by
being on a private network. Only an organization API key with
`resources:write` may call it; a session, read-only key, existing tenant-run
credential, missing credential, or key from another organization is refused.
Its closed body has `spaceRef`, `runRef`, and an optional
`workerEndpointOriginReservationId`. The organization is derived from the API
key and `tenantRef` is the exact `spaceRef`; neither can be supplied separately.

When a reservation id is present, the endpoint reads it through the same
organization-scoped reservation authority used by provider apply. Missing,
foreign, released, and expired reservations are refused before signing, and
provider bind revalidates the reservation against the exact Ready Worker at
apply time. A successful response is `{ "token": "…", "expiresAt": "…" }`
with `Cache-Control: private, no-store`. Tokens are reusable only for their
fixed 300-second lifetime; no issuance ledger or idempotency receipt is added.

Self-host admission replaces, rather than falls back to, the Hosted
sponsorship-ledger admission port. It pins the dedicated key id and a lifetime
of at most 300 seconds after the ordinary JWT signature, issuer, audience,
active-key, time, and closed-claim checks. Revoking the dedicated key in
`runtime_grant_keys` takes effect within the verifier's existing key-cache
window (10 seconds by default), and every bearer already issued expires within
five minutes. At boot and before every issuance, self-host signs and verifies a
domain-separated challenge against the exact active registry row. A stale
private-key file, same-id public-key mismatch, missing row, or revoked row stops
issuance; it does not overwrite or revive registry authority. The Cloudflare
public Worker neither mounts this endpoint nor imports either private
tenant-run signer.

### The Cloudflare token

Use a token created for the exact optional adapter, not a `wrangler login`
session. Grant only what the selected Bun inputs use:

- Account · Workers R2 Storage · Edit, only when the retired ObjectBucket drain
  is selected. A current `ObjectBucket` on this
  machine needs no Cloudflare permission at all: its bytes are local.

The ordinary Bun stable provider does not need Workers Scripts, Workers Routes,
or DNS permission. Production Cloudflare Worker execution and zone authority
belong to the private deployment owner; this public process does not select a
managed runtime or receive its credentials.

`TAKOSERVER_CF_TOKEN_FILE` may be used instead of `CLOUDFLARE_API_TOKEN`: the
file is read at the moment of each call, so a rotation does not need a restart.

### Provider desired-generation context

The Host computes the incoming desired Resource generation (`"1"` for create,
preserving canonical-equal desired specs and incrementing a changed decimal
string) and passes it through the internal driver and Provider extension as
optional `desiredGeneration`. It is separate from `identity.generation`, which
remains the incumbent on update; older direct driver callers may omit it. This
extension does not alter the Host wire, a Form, or the published catalog, and
does not by itself provide Container execution.

## Operator-composed external services

The programmatic self-host composition accepts `standardServiceIntegrations`:
an explicit list of exact `standards.takoform.com/v1` protocol identities and
serializers. A serializer receives Host-resolved execution material and returns
one JSON object. Its integration owns the object's keys; Takoserver does not
define a protocol-to-environment member table. Compose the matching Host
`standardServiceResolver` separately. No integration, protocol, AI service or
resolver is enabled by the ordinary Bun entry by default.

An initial WorkerVersion apply projects that object as one runtime JSON binding
under the slot's declared name. Required unsatisfied slots fail; optional ones
may project nothing. Provider selection must support the exact protocol before
receiving its material. Endpoints, credentials and serialized values never
become portable Resource state, Deployment output or discovery.

The self-host provider retains slot declarations and their materialized JSON
beside the immutable Version, separately from ordinary variables and one-shot
runtime inputs. Files retain the existing 0600/0700 permissions and salted
commitments. Versions with no external slots retain the existing sidecar format;
new records with slots use the internal v5 format. This is not a public schema
or Form version. Restart, recovery and observation read the retained record and
compare the exact declaration, including optional omissions; they never invoke
the resolver or serializer again. Missing or mismatched material does not
authorize recreation. Destroy removes this record with the Version.

This is a self-host integration mechanism, not a bundled standard-service
offering. Concrete protocol adapters and the private WfP transport remain
separate work; enabling a resolver alone is not complete runtime support.

## Worker storage on this machine

A Worker Version that declares `kvBindings`, `bucketBindings`,
`queueProducerBindings`, or `sqliteBindings` needs a backend, and a machine
standing on its own has to be one. Four small HTTP services provide it: KV
entries and queue messages live in the control database under migrations 0038
and 0040, each `SQLiteDatabase` is a file under `<data root>/databases`, and an
`ObjectBucket` is a directory under `<data root>/selfhost/objects` with its
metadata in the control database under migration 0041.

An explicit self-host `SQLiteDatabase` deletion is destructive: it closes the
cached connection, then removes that database's main file and SQLite sidecars
(`-wal`, `-shm`, `-journal`). Close or filesystem failures do not settle as a
successful delete; recovery observes the exact paths and can still report
present or unknown. Both relative and absolute data-root configurations work.
No startup scan or background sweep deletes files retained by an older release.
Back up data before explicitly deleting a database that must be retained.

New databases use the resource UID in their physical name, so recreating the
same logical name does not reuse an earlier incarnation's file. Existing
resources keep their exact recorded native identity and output path; they are
not renamed or migrated on upgrade. Deleting a SQLite migration attachment
does not delete the database to which it was attached.

They are served on their own listener, bound to `127.0.0.1`, never on `PORT`.
What authenticates there is a bearer token minted per Worker Version, and a
route on the public origin would make that token an internet-facing credential
for arbitrary SQL on this machine. `TAKOSERVER_DATA_PLANE_PORT` fixes the port
when an operator needs a stable one; otherwise the kernel chooses and the
process prints `self-host data planes listening on 127.0.0.1:<port>` at startup.

### Worker Version module verification

The control plane validates the Form's declared schema and relations. It does
not execute tenant code or infer exported handlers from JavaScript syntax.
Module-load verification belongs to provider execution, before a Worker Version
can succeed. Aliases, factories, computed properties and getters are accepted
when their runtime value satisfies the exact declared Worker ABI.

The self-host provider calls the mandatory `WorkerdRuntime.inspectModule` seam
before acquiring sensitive inputs. The ordinary Bun entry selects the same
workerd binary for inspection and serving. Inspection receives copied module
bytes and handler names only, in a fresh process with no environment variables,
bindings, listening sockets or outbound network capability. A hard wall timeout
and output cap bound the attempt. Runtime absence is retryable unavailability,
never successful verification. No application handler is invoked by this check.

Publication compares the verified metadata and actual module and static-asset bytes with the
materialization it will publish, including retained pre-canonical metadata.
Observation and adoption compare the requested bundle/asset identities and
handler set with the retained Version before re-inspecting its bytes. An old
Version without its handler declaration requires authoritative reapply. Apply
recovery also compares the retained module/asset snapshot's actual bytes and recorded runtime
declarations before settling a sensitive-input receipt.

Serving registers every importable module once in the application provenance
namespace, with its declared JavaScript, UTF-8 text, ArrayBuffer or compiled
Wasm media type; filenames do not select the type. Source maps remain retained
evidence and are never registered for imports. The media map survives runtime
manifest readback and restart. The serving wrapper, like the inspector,
captures a callable own getter once and keeps that function for subsequent
invocations.

The generated prelude and entrypoint occupy a separate Host-private provenance
namespace. The prelude captures the Host's intrinsics before tenant evaluation;
the entrypoint then statically imports the exact application main, so ordinary
V8 startup evaluation remains available without giving an application
referrer Host privilege. A logical spelling may exist once in each namespace:
there is no tenant-reserved filename or built-in-looking prefix. Host-private
code may reach its own namespace and the one configured application main.
Application code — including static imports, re-exports, dynamic imports,
direct `eval`, `Function`, and async-function constructors — may resolve only
the declared application graph. Unknown generated-script provenance defaults
to application, never Host-private.

The self-host artifact and serving tests prove this closed resolver only for the
local workerd path. Managed customer execution is a separate private
capability with its own provider-owned resolver and live qualification; local
workerd evidence does not qualify a managed runtime.
Class-backed Actor/Workflow capabilities without an executable provider
implementation remain unsupported on both discovery and mutation paths.

The self-host provider does not project `actorBindings` or `workflowBindings`
into a Worker Version. A nonempty declaration is refused with a non-retryable provider
`denied` result before artifact materialization or sensitive-input dispatch,
including apply recovery. Observation and import also refuse it rather than
claiming that a retained Version satisfies the declaration. Omitted or empty
lists keep the existing behavior; a non-array value is `invalid_spec`. This
does not enable Actor/Workflow execution or change the published Form contract.
An apply-side refusal carries operation-bound no-mutation proof so the driver
can close an initial refusal. During recovery the same proof covers only the
current invocation, never an older operation's uncertain side effects.
The [Workflow implementation note](workflow-runtime.md) separates the internal
instance store from the execution and binding work still required for support.

The ordinary Cloudflare provider also refuses these WorkerVersion declarations
before upload or sensitive-input acquisition, including apply recovery and
convergence. Observation refuses them before native readback. Omitted or empty
arrays remain valid; malformed declarations are `invalid_spec`. Existing
exact-identity deletion and artifact-consumption evidence remain separate from
runtime support, so the refusal does not strand previous releases or erase
evidence that their bundles are still in use. Concrete managed WfP execution is
owned and qualified separately in the private provider implementation.

The self-host adapter executes a `WorkerDeployment` containing one to eight
exact Versions with positive integer weights totaling `10000`. It retains each
Version's immutable materialization, orders the set by Resource UID, and
preflights every Version's bindings and assets before publishing one complete
runtime generation. Each endpoint, domain or service fetch selects one Version;
a Queue batch and a scheduled invocation each make one selection for the whole
invocation. Selection uses the declared proportions, not declaration order,
the largest weight, caller headers or URL affinity. A selected Version's failure
does not trigger a retry against another Version.

Activation is serialized and requires authenticated readback of the exact
serving generation. Failed activation and rollback do not make the desired
generation the event-delivery authority: events use the proven serving
generation. These self-host checks do not qualify managed WfP execution or
unsupported Actor capabilities.

Removing a validated legacy scalar Worker first proves the replacement runtime
graph and persists its activation marker, then atomically moves the old module
directory out of the published Workers tree. A failed transition restores the
previous graph instead of reporting the Worker absent. The private
`workers/.retired` directory retains those modules; legacy static assets remain
at their original path for in-flight requests. Weighted immutable generations
are retained too. Unpublishing is not garbage collection: this path does not
erase retained code or assets, or recursively remove an unknown partial
publication. Empty weighted-publication directories are removed so absence
readback does not mistake them for malformed live Workers.

The self-host supervisor starts workerd in watch mode and accepts it only after
the serving readiness probe succeeds. A failed initial start rejects the
activation; it does not leave a background startup loop. Once accepted, an
unexpected child exit automatically retries the same configuration, with an
exponential delay from 100 milliseconds capped at five seconds. Each replacement
must pass readiness before serving is considered ready. An explicit supervisor
stop cancels recovery and invalidates late startup results; a later explicit
start remains possible. Normal configuration reloads do not restart a healthy
child. This recovers the workerd child while Takoserver is running, not the
Takoserver process itself or unsupported Actor capabilities.

### Explicit native DO capability check

The pinned runtime's native primitives can be checked independently of portable
Actor support:

```sh
TAKOSERVER_WORKERD_BINARY=/absolute/path/to/pinned/workerd bun test tests/workerd-native-do-capabilities.test.ts
```

This disposable, loopback-only smoke verifies the exact artifact through the
normal selector. It checks SQL and identity persistence, native KV isolation
from SQL reads/writes, an alarm delivered after a pre-deadline forced child
termination/restart, and hibernation/reconstruction on the same live WebSocket
with its attachment intact. The child inherits no operator environment and
cannot make outbound network connections. A supplied invalid binary fails; an
unset variable skips this optional native check rather than substituting the
package runtime.

This evidence does not advertise a Form or qualify a portable class ABI. It
does not prove managed WfP execution, cross-generation invocation exclusion,
code-update socket continuity, storage-format upgrades or machine power-loss
recovery. Actor/Workflow support remains unavailable until the relevant exact
contracts and provider execution are implemented and verified.

Two additional opt-in fixtures investigate code handoff, separately from that
capability check:

```sh
TAKOSERVER_WORKERD_BINARY=/absolute/path/to/pinned/workerd bun test tests/workerd-native-facets.test.ts tests/workerd-native-static-facets.test.ts
```

The first checks native per-ID scheduling, response-head completion and
tail-free facet replacement. The second uses static class bindings and the
existing closed application module graph, without WorkerLoader or a runtime
patch change. A plain Host-private class delegates to a fixture application;
declared imports work while builtin, Host-private and undeclared application
imports fail, including generated dynamic imports. Tail-free A→B→A replacement
preserves the facet ID and SQL data and invalidates old stubs.

The static fixture also holds an application callback at an explicit loopback
I/O gate, aborts its facet, and then releases the gate. It checks rejection of
the outstanding call and stale stub, absence of post-abort markers/reports,
continuity of an existing sibling and state retention in a replacement class.
This extended scenario passes against the exact pinned artifact; it is not
CPU-preemption, controller-loss deadline or stop-before-open qualification.
The loopback service is an explicit fixture binding, not global outbound access.

These are mechanism checks, not an implemented Actor adapter or a class ABI.
They do not prove in-flight version handoff, code-update WebSocket continuity,
weighted routing, or managed WfP behavior. The static fixture intentionally
passes a test marker across the Host/application boundary; it is not a proof
of production environment materialization. Outbound denial is configured, not
behaviorally tested by an attempted connection in that fixture.

### What workerd is given

Publishing a Version registers the application graph plus Host-private prelude
and entrypoint modules. Each active Version receives its own private service
graph below. A stable `<script>-selfhost-deployment` router selects among these
graphs using the committed deployment weights; Version variants have no
independent public hostname or service-target identity. Data bindings add the
private facade module and render three services for each Version:

| Service | What it runs | What it holds |
|---|---|---|
| `<script>` | The Host-private prelude and entrypoint plus the declared application graph, with the exact application main as the only provenance bridge | The Version's own `vars`, and a plain service binding to `<script>-selfhost-data` |
| `<script>-selfhost-data` | A Takoserver-owned facade module, no tenant code | The Version's plane token and a service binding to the origin below |
| `<script>-selfhost-data-origin` | Nothing; an `externalServer` | The loopback address of the planes |

A Worker with a Queue Consumer or a Cron Trigger attached gets one more:

| Service | What it runs | What it holds |
|---|---|---|
| `<script>-selfhost-events` | A Takoserver-owned gate module, no tenant code | The Version's event token, and a service binding naming the script's `takoserverSelfhostEvents` entrypoint |

A Version with a static-asset attachment adds three operator-private services:

| Service | What it does | What it holds |
|---|---|---|
| `<script>-assets-files` | Reads the script's operator-private flat asset directory | Exact immutable asset bytes under Host-generated ordinal keys |
| `<script>-assets` | Admits one runtime URL pathname and performs exact lookup or SPA fallback | A binding to the private files service, `notFoundHandling`, and the exact logical-path map with media type, size, and digest |
| `<script>-asset-router` | Composes the asset lookup with the tenant Worker | Private bindings to both services and the exact `runWorkerFirst` value |

A Version may also declare a `module-worker.service` binding (version `1.0.0`)
to another `ModuleWorker` on this Host. The projected
`worker.service@1.0.0` interface is a frozen object with only `fetch`. The
provider resolves the exact Resource relation and pins the target Resource UID
and its Host-derived script address in the caller's immutable Version record. It
does not use a public `WorkerEndpoint`, caller-supplied URL, request `Host`, DNS,
or a credential, and it does not expose the target's native environment or any
operator-private service name.

Each workerd reload resolves that pinned identity against the target's current
active `WorkerDeployment`. The caller therefore follows changes to the target's
active Version set without being republished. Disabled or zero-traffic state,
deletion, a recreated same-name Resource with a different UID, and any active
Version without `fetch`
all fail closed as `Error` named `backend_unavailable` rather than falling back
to a public route or a stale Version. Service calls use the target's stable
weighted router, then the selected Version's asset router when applicable, so
its published asset ordering and fallback remain part of its `fetch` behavior.
The request method, URL, query, headers, and body,
and the response status, headers, and body, cross the native service binding as
streams. An uncaught target `fetch` exception becomes the Host's terminated
`500` response; inability to dispatch rejects instead.

The private router and unavailability marker exist only in Host-generated
services. Their per-Version token is not projected into either tenant, and an
ordinary target response is returned unchanged even if it uses the same header
name. Distinct logical Workers may form cycles; workerd's existing invocation
bounds apply, and no separate RPC or network protocol is introduced.

A retained `@v1`-`@v3` binding record has no logical Worker UID. It continues to
serve an otherwise unchanged non-service Version, but the Host never guesses
that missing identity or makes it a service target. Publishing a newly named
Version records the identity needed for target selection.

The public hostname reaches the deployment router, then the selected Version's
asset router when applicable. The Host's internal readiness hostname bypasses
asset routing and checks every active Version. None of these bindings is
declared on the tenant service or projected by the generated entrypoint. In
particular, an asset attachment does not invent `env.ASSETS`; a Version may
independently declare an ordinary variable with that name and receives exactly
that value.

Logical paths never become paths in the workerd filesystem. The Host assigns
each ordered inventory entry a flat private key, and keeps the logical
path-to-key map and layout discriminator in the operator-private runtime
manifest. Consequently `foo` and `foo/bar.txt` remain two distinct valid
assets. The physical asset tree is a sibling of the tenant module tree, so a
valid module named `__assets/asset-00000` cannot overlap or replace an asset.
Reload and restart validate that the private map and the exact file set, sizes,
digests, and bytes still agree before serving the script.

Every successful exact or SPA response uses the normalized media type declared
for that logical path in the Static Asset Bundle manifest. The runtime has no
filename-extension table and no fallback content type; a misleading filename
such as `app.bin` still serves as `text/css` when that is the artifact evidence.

With `runWorkerFirst=false`, an exact asset or a valid SPA fallback answers
before `fetch`; only a marked asset miss reaches the Worker. With
`runWorkerFirst=true`, a non-404 Worker response (including an error) is final;
only a Worker 404 reaches assets, and that exact Worker 404 is returned if the
asset stage also misses. A Version without assets goes straight to the Worker.

Asset lookup starts from the runtime URL `pathname`, ignores query and fragment,
strictly decodes percent escapes once, and strips exactly one leading slash.
The decoded logical path is at most 240 characters, and each nonempty segment
starts with an ASCII letter, digit, or underscore, as required by the frozen
artifact manifest grammar. The root pathname remains the canonical empty miss.
Encoded separators, repeated or empty segments, dot segments, backslashes,
controls, Unicode noncharacters, malformed escapes, and invalid UTF-8 fail
closed when asset lookup occurs and never enter SPA fallback. The declared
asset-first or Worker-first ordering still decides when that lookup occurs. SPA
publication is refused before materialization and before any sensitive-input
lease when the manifest has no exact `index.html`.

The immutable Version materialization persists `runWorkerFirst`, every declared
media type, and its flat physical-layout discriminator, and includes all of
them in the materialization digest. A retained asset Version written by an
older Host without any one of those facts remains readable only as legacy
evidence. Replay, recovery, observation, route/trigger/deployment adoption, and
publication return retryable unavailability instead of guessing. Create and
apply a newly named Worker Version with complete artifact evidence; the
create-only old materialization and read-only recovery path are never rewritten
in place.

The object route travels the same three services; only its framing differs, and
the facade streams it through rather than reading it.

The split is the isolation. A binding belongs to the service it is declared on,
and workerd hands every one of them to every module that service runs —
including through `import { env } from "cloudflare:workers"` — so a value left
out of a projected `env` was never hidden. The tenant's service therefore
declares no token and no address. The facade rewrites every request it is
handed into a fixed method, one of four fixed URLs, and a fixed header set, so a
service binding that leaked into tenant code reaches those four routes and
nothing else on this machine. Exactly one header crosses it unchanged — the
opaque object-operation document — and the plane behind parses that field by
field before it resolves a binding name. `disallow_importable_env` is set on the tenant's
service as well, which is the second lock rather than the first.

Publishing also asks the published services, over the workerd router, whether
every active Version exports its declared handlers. An exact failed answer
rejects publication; a responding runtime that does not confirm the expected
publication times out. The adapter skips this extra probe when no probe is
supplied or no runtime answers initially. This does not waive the built-in
supervisor's required serving-readiness check or make a staged activation count
as serving.

### What a Worker's SQL binding may say

The SQL plane parses each statement before preparing it and refuses:

- `ATTACH`, `DETACH`, `VACUUM`, `PRAGMA`, and `ANALYZE` anywhere in the text.
  `ATTACH` alone reaches every other tenant's database file and this Host's own
  `control.sqlite`, and the path may be a bound parameter.
- `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, and `RELEASE` as the
  statement. Transaction control belongs to the plane: `transaction` is
  all-or-none and a caller-supplied `COMMIT` would end it. The same words stay
  legal elsewhere, so `CASE … END` and `INSERT OR ROLLBACK` still work.
- More than one statement in one text, so `CREATE TRIGGER … BEGIN … END` is not
  available here. A trailing `;` is punctuation and is accepted.
- Any identifier or literal beginning with `_takoform_`. The Takoform SQLite
  migration ledger is a table in the same file on this backend, where on the
  managed backend it is Durable Object storage that `edge.sql` cannot see.

`query` runs inside a transaction that is always rolled back, exactly as the
managed backend does it, so a write smuggled through it never commits. bun's
SQLite bindings expose no `SQLITE_LIMIT_ATTACHED`, so the statement gate is the
control rather than a second one behind it.

### Administrative SQLite migrations

Schema changes belong to `SQLiteMigrationApplication`, not the Worker's
`edge.sql` binding. The Host resolves the immutable MigrationBundle, verifies
each file's bytes and digest, and binds the requested ordered history to the
exact database realization. Runtime SQL statement-count limits are not limits
on the number of migration files. Artifact admission limits remain owned by
`src/takoform/limits.ts`.

Before changing any database contents, the executor checks the complete input's
identity projection, unique paths, UTF-8, artifact bounds, and SQL authority.
Migration SQL may change the declared database, but may not attach another
database, load an extension, modify Host bookkeeping, or end the Host's
transaction. Allowed schema-inspection and constraint pragmas do not grant
access to storage paths or Host journal settings. Native statement capacity is
checked before execution on backends that impose that additional limit.
Allowing a pragma does not override native SQLite semantics. In particular,
`PRAGMA foreign_keys` cannot change enforcement inside a transaction. The Host
does not move an application's statements outside its file transaction or
rewrite them to `defer_foreign_keys`; application migrations must work under
the selected backend's transactional behavior.

One file and its ledger entry commit atomically. SQLite syntax and constraints
are checked by the native engine inside that transaction: if a later statement
fails, none of that file's writes or ledger entry commits. Earlier files stay
committed. Recovery reads the exact durable prefix and never replays a recorded
file; a lost acknowledgement is not permission to blindly retry the mutation.
An empty SQL file is a valid no-op with its own ledger entry; an empty migration
inventory is not a valid Migration Set.

Cloudflare executes exact, unnormalized statement slices within the same
file transaction because a file can exceed the native SQL-call limit while its
individual statements fit. The shared preparation module uses SQLite's pinned
completeness state machine, including quoted semicolons and trigger bodies; it
does not rewrite SQL or create new statement identities. The original file's
digest remains authoritative. Self-host execution may submit the whole file to
its native engine. A backend capacity refusal does not change the published
Form's meaning. No experimental runtime API is required.

### What a Worker's bucket binding may say

`env.MEDIA` is the exact `edge.objects@1.0.0` facade the managed Cloudflare
wrapper projects — the same nine methods, the same option names, the same closed
error names, and the same ceilings: 979-byte keys, 5 GiB objects, 300 MiB for a
single `put`, 10 000 parts, and a 5 MiB floor on every part but the last. What
differs is only what is behind it.

The object route is the one on this seam that does not speak JSON in both
directions. An object body is up to 5 GiB, and base64 inside an envelope would
mean holding a third of a gigabyte in an isolate to write a hundred megabytes,
so the bytes travel as the request or response body and the operation travels as
one header the facade copies verbatim and the plane validates field by field.
Nothing is buffered: a `put` is written to a file as it arrives, and a ranged
`get` is one `pread` streamed back.

A key never becomes a path. Bodies live at names this Host minted, under a
directory named by the bucket INCARNATION — tenant, Space, name, and Resource
UID — so a customer who destroys a bucket and declares one with the same name
gets an empty one rather than the old bytes. Directory permission bits are
requested as `0700`, tightened, and re-read; the store fails closed if any
group/other bit remains. New body files are opened `O_EXCL | O_NOFOLLOW` with
`0600`. This is deliberately a permission/symlink boundary, not a claim that
the process proves filesystem ownership or stable inode identity.

Multipart receipts are rows rather than isolate memory. In the self-host path
they live in the local control database; a managed provider stores them behind
its own private backend authority. The public provisioner does not expose that
authority's service binding, credentials, route, or operator orchestration.
Across both placements, a restart between `createMultipartUpload` and
`completeMultipartUpload` preserves the part sizes and etags used to validate
completion. The portable `edge.objects` contract remains the same, while
managed-provider qualification and recovery evidence are private operations.

**On self-host, destroying a bucket that still holds an object is refused.** The Form's
desired state is empty, so nothing in it could ask this Host to empty one, and
emptying a customer's storage is not a decision a lifecycle delete may take. The
refusal is named, non-retryable, and proven by one readback.

On self-host, an unfinished multipart upload is not one of those objects and does not refuse
the destroy. It is bytes a customer began writing and never finished, no
operation on the Binding lists one, and the upload id that could abort it lived
in the isolate that minted it — so a Worker evicted between
`createMultipartUpload` and `completeMultipartUpload` would otherwise have made
its own bucket permanently undeletable, and the refusal would have told the
customer to empty a bucket every operation they hold reports as empty. The
destroy takes those receipts and their part files with everything else.

**Uploads nobody finished expire after seven days**, measured from the create
rather than from the last part, exactly as R2 measures it. The maintenance tick
drops a bounded batch of them and removes their staged parts, beside the KV
expiry sweep. The same tick reconciles files against rows: a crash between
writing a body and writing the row that names it leaves bytes nothing can reach,
as does a crash inside a staged write, and both are removed once they are older
than an hour and no row names them. The pass looks at a bounded number of files
and resumes where the last one stopped, so a bucket holding a million objects
costs a batch per tick rather than the tick.

**There is no per-tenant or per-bucket quota here.** `edge.objects` bounds one
object at 5 GiB, one single `put` at 300 MiB, and one upload at 10 000 parts,
but nothing bounds how many objects a Worker Version writes or how many bytes
accumulate across open multipart uploads before a complete. What bounds them is
the operator's disk. A machine serving `bucketBindings` for tenants it does not
control needs a filesystem quota, a separate volume for `<data root>`, or both;
this Host reports a full disk as `backend_unavailable` and removes what it had
staged, but it never refuses a write on the customer's behalf.

### Ceilings

Row count, row bytes, and result bytes are bounded inside the plane as the
managed Durable Object bounds them (10,000 rows, 2 MB per row, 8 MiB per
result), and enforced while the rows are read rather than after the answer is
built. A request body must declare its length and stay under 40 MiB.

That last number is also the ceiling on a KV value in practice. `edge.kv`
permits 25 MiB, values cross this seam base64-encoded, and base64 is 4 bytes per
3: a full 25 MiB value is about 33.3 MiB of body against the 40 MiB request cap
and the same response cap, so the largest permitted value fits with room to
spare.

## Queues and cron on this machine

workerd has no queue trigger and no scheduler: its configuration has services,
sockets, and flags, and nothing that says "at this minute". So the Bun process
is both. A message a Worker sends through `env.QUEUE` becomes a row in the
control database, and a `WorkerCronTrigger` becomes a next-fire instant beside
it; two loops in the process — one every second for queues, one every five for
schedules — decide when either is due and invoke the Worker over HTTP.

The event envelope is the portable
`takoserver.managed-worker-event@v1` shape shared by the local and managed
implementations. A Worker's `queue` handler receives
`acknowledge` / `retry` / `acknowledgeAll` / `retryAll` with bodies as
`{encoding: "base64", data}`, and `scheduled` receives `{cron, scheduledTime}`.
`logicalWorkerId` and `deploymentId` are runtime identities (the local script
name and exact Worker Version); they are evidence, not provider selectors.

On self-host, delivery enters through the Host's authenticated internal gate and
then reaches the named `takoserverSelfhostEvents` entrypoint. The gate keeps
event delivery separate from ordinary customer `fetch` traffic and refuses
invalid or expired credentials. Managed dispatch routing and its private
service/receipt authorities are owned by the private deployment composition and
are not exposed by this public provisioner.

### What a Consumer's numbers mean here

- `maxBatchSize` and `maxBatchTimeoutSeconds`: a batch leaves as soon as it is
  full, or as soon as its oldest due message has waited the timeout.
- `maxConcurrency`: at most that many batches are in flight for one consumer at
  a time. It is a ceiling on this machine, not a promise of parallelism.
- `maxRetries` counts REDELIVERIES: a message is delivered at most
  `1 + maxRetries` times. One that exhausts them moves to `deadLetterQueue` as a
  NEW message there — new identity, new acceptance instant, its own count
  starting again — or is dropped when none is declared.
- `retryDelaySeconds` applies when the handler did not name a delay of its own.
- `deliveryDelaySeconds` and `messageRetentionSeconds` are applied when the
  message is accepted, as absolute instants, so a restart does not restart the
  clock with the process. They are read from the queue Resource the *publishing*
  Version pinned: raising a queue's retention reaches a Worker on its next
  published Version rather than immediately.
- A batch owns its messages under a lease. A process that dies between dispatch
  and settlement leaves rows whose lease expires and which the next pass takes
  again only within the retry budget, so a handler may see a message twice.
  An expired lease already at `1 + maxRetries` is settled to the DLQ or dropped
  without another invocation. Retention-expired rows are left to the sweep.
  Reservation rechecks the observed message incarnation, delivery count and
  visibility against the current claim time, including retention. Settlement
  checks the same lease token inside every write. DLQ insertion reads only the
  still-owned source row and commits with its removal: a late response cannot
  manufacture a copy after another holder has acknowledged or moved the source.
  A stale no-op is not counted as a settled message.

**A known live delivery failure is unspent; an unknown crash is not.** While the
pump is alive, a workerd that is restarting, a refused connection, a timeout, or
a reply outside this protocol releases the lease and restores the delivery
count. The consumer waits with doubling backoff up to a minute. The tenant's
decisions, or the wrapper's response to a thrown handler, spend a delivery.
If the pump itself dies before recording the outcome, its durable attempt stays
spent: it cannot distinguish a request that never left from a handler whose
answer was lost. Recovery never dispatches beyond the configured retry limit.
The recovery claim, conditional DLQ copy and source removal share one SQL
transaction, so a failed copy leaves the original message and lease unchanged.

**A batch is also bounded by bytes.** The event envelope has a 2 MiB ceiling,
so a pass takes messages until the next one would not fit and sends what it has;
the batch is then full in the same sense a `maxBatchSize` batch is, and does not
wait for `maxBatchTimeoutSeconds`. A `maxBatchSize` of 100 with large bodies
therefore arrives as several batches rather than one, which is the only reading
under which nothing is lost. A batch this Host could not send at all is split,
never settled: it costs no redelivery and reaches no dead-letter queue.

**Retention is swept, not merely promised.** Expired messages are reclaimed on
the thirty-second maintenance tick, in pages, until nothing expired is left or
the pass has reclaimed a hundred thousand rows. A queue accepting faster than one
page a tick does not accumulate rows for ever; a queue nobody drains still cannot
turn the sweep into the workload.

### What a Cron Trigger's schedule means here

Five UTC fields, exactly the Form's grammar: minute, hour, day-of-month, month,
day-of-week, each a comma-separated list of `*`, a literal, `low-high`,
`*/step`, or `low-high/step`. Names and a step on a bare literal are refused, and
so is an expression this Host cannot read — at apply, rather than by recording a
trigger that would never fire.

When day-of-month and day-of-week are both *restricted* a day matches if either
selects it; when only one is, only that one constrains the day. Restricted is
decided from the field's first character, which is the historical rule: `*/2` in
a day field restricts nothing, so `0 0 */2 * 1` is Mondays and `0 0 1 * */1` is
the 1st of each month.

**A missed run is not made up.** A match is fired only while the minute it
belongs to is still the current one; a machine that was down, or whose previous
invocation was still running, steps over the match and records the next future
one. A restart after an outage therefore produces one next fire and never a
backlog. Within that, delivery is at-least-once: a process that died after
dispatch and before releasing its lease leaves the fire recorded but
unacknowledged, so a `scheduled` handler must be idempotent.

A trigger seen for the first time is due at its next future match, never at a
past one: attaching `0 * * * *` at 12:30 asks for 13:00.

### When this deployment runs neither

The retired ObjectBucket drain mode composes no pump and no scheduler. A Queue
Consumer and a Cron Trigger applied there are still recorded and still
republished — the declaration is desired state either way — and the ticket says
`delivering: false` and `scheduled: false`, which is the truth on that machine.

A Worker Version published before this Host recorded event handlers has neither
a handler list nor an event token, so attaching a Consumer or a Trigger to it is
refused rather than half-served — before anything durable moves, so a refused
attachment leaves no attachment behind. Publishing a new Version is what changes
that.

### Managed runtime boundary

The managed implementation consumes the same portable event envelope and
queue/cron limits described above, but its dispatch, route, and receipt
authorities are private. This public provisioner does not expose provider-native
queue identifiers, managed gateway routes, or private service bindings. Consult
the private deployment runbook for operator qualification and recovery; the
portable Worker contract remains the authority for application behavior.

Queue message custody itself is public Host infrastructure rather than private
transport authority. Migration 0053 forward-extends the existing migration-0040
`selfhost_queue_messages` ledger and adds Consumer-generation state. Admission
does not depend on a Consumer, so a Consumer update or deletion leaves producers
and backlog in place. A claim snapshots the exact generation, retry budget and
dead-letter target beside its lease. Retirement first stops new claims, waits
until the bounded old-generation leases expire, then reaps each expired claim
under that snapshot before a replacement generation or tombstone can commit.
Dead-letter copy and source removal remain one SQL batch.

The self-host producer now uses this shared admission engine. Its existing pump
and settlement loop remain the legacy transport only: both candidate reads and
lease compare-and-swaps refuse every Queue that has a Consumer-custody row, and
initial custody activation refuses a Queue with an outstanding legacy lease.
The custody engine is therefore the sole state machine for an activated Queue,
not another pump stacked behind the old one. A private managed producer
entrypoint is its first external caller, but no current deployment selects that
binding or its managed pump. Existing provider-native messages are not adopted,
migrated or deleted by this source slice.

### Cloudflare Queue settings updates

For an existing Cloudflare-backed `AtLeastOnceQueue`, an update succeeds only
when native readback matches the requested retention and delivery delay. An
omitted `deliveryDelaySeconds` means zero. An unchanged Queue needs only a read;
an ordinary update reads the existing identity, sends one settings-only
[PATCH](https://developers.cloudflare.com/api/resources/queues/methods/edit/),
and reads the same Queue again. It does not rename or recreate the Queue.
Only an explicitly initial Host execution may write; an omitted execution mode
is recovery-only and cannot create a Queue or change its settings.
Recovery reads that existing identity without repeating the write. A lost
acknowledgement or mismatched readback is not successful completion, and this
read-only recovery does not authorize adoption after an uncertain create.
Ordinary observation also checks the requested settings; merely finding a Queue
with the same native identifier does not establish readiness after settings drift.

In a Workers for Platforms composition, delivery-delay-only updates are
supported, but retention changes remain unavailable. Managed dead-letter
transfer retains the source retention policy for its in-flight work; changing
the native Queue independently would invalidate that policy. Retention updates
need coordinated transfer lifecycle support before they can be enabled. This
is a Cloudflare implementation gap, not an immutable field or a change to the
published Form. The self-host acceptance-time behavior above is unchanged.

## Retired Cloudflare ObjectBucket drain

One closed recovery mode remains for Deployments already recorded under the
released beta ObjectBucket provider:

```sh
TAKOSERVER_RETIRED_PROVIDER_MODE=cloudflare-object-bucket-drain \
CLOUDFLARE_ACCOUNT_ID=<account> \
TAKOSERVER_CF_TOKEN_FILE=/run/secrets/takoserver-cloudflare-token \
TAKOSERVER_PROVISIONER_TOKEN=<shared-endpoint-credential> \
bun src/entry-bun.ts
```

This mode reconstructs only the historical Cloudflare technical Provider Pack
needed to observe and delete those records. It publishes zero current
Offerings and cannot create a current ObjectBucket or execute current stable
Edge identities. Both the Cloudflare account token source and the private
provisioner endpoint credential are mandatory. `TAKOSERVER_ZONES` and all
stable self-host provider settings are refused: an ObjectBucket drain owns no
DNS, Worker-route, or current Worker execution authority. Mode and
credential-shape validation happens before the process opens or migrates local
state.

## Reachability

When an explicitly composed external control-plane client calls the Bun
provisioner, it needs an address it can resolve. A Cloudflare Tunnel from the
host is one way to provide that without making the process listen on a public
interface.

The provisioning path refuses anything without the shared credential and
answers `404` rather than `403` when no credential is configured, so a scanner
does not learn there is a provisioner behind the address. That is a second
line, not the first: put it behind a tunnel.

## systemd

```ini
[Unit]
Description=Takoserver stable self-host provisioner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/takoserver
EnvironmentFile=/etc/takoserver/provisioner.env
ExecStart=/usr/local/bin/bun src/entry-bun.ts
Restart=always
RestartSec=5
User=takoserver
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/takoserver/provisioner.env` holds only the variables for the selected
mode and is mode `0600`. Do not place the retired recovery-mode variable in the
ordinary stable service. Restarting is safe: mutations use stable operation
identities rather than inventing a second resource after an interrupted call.

## Integrating an external caller

No current official production Worker consumes a `provisionerOrigin` target
field, and the public deploy target has no such field. A self-managed control
plane may explicitly compose the remote Provider client with this endpoint's
origin and shared credential; that caller owns its own reviewed configuration.
Do not add an unused `provisionerOrigin` property to the Takoserver deploy
target. The repository deploy contract describes the required preflight,
publication, readback, and reversal evidence; a provisioner process or
configuration file does not itself authorize a deploy.
