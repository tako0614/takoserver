# Self-host operations: install, update, and recovery

This guide covers the Bun self-host path from a source checkout to a first
usable Takoform Host, then the operator's maintenance boundary. It documents
the current source entrypoints, not a packaged installer or a published
release channel. Select a reviewed source commit and retain its exact source
and artifact provenance; this guide does not identify a latest release or
claim GA status.

## First install and first use

1. From the selected, reviewed Takoserver checkout, configure the current v2
   entry before starting it. `TAKOSERVER_PUBLIC_ORIGIN` must be the canonical
   bare external HTTPS origin. `TAKOSERVER_TAKOFORM_V2_CONFIG` is strict JSON with
   HTTPS `documentation` and `authenticationDocumentation` URLs. Provide a
   persistent `TAKOSERVER_TAKOFORM_V2_CURSOR_KEY` containing at least 32 random
   bytes as canonical, unpadded base64url; keep it stable across restarts and
   outside source and logs. See [Takoform v2 operator setup](takoform-v2.md)
   for the exact config shape and optional Form backends. Keep
   `TAKOSERVER_DATA_ROOT` persistent (default `.takoserver`); if `TAKOSERVER_DB`
   is external, include that database in backup and restore.

   Install locked dependencies and start the Bun entrypoint:

   ```sh
   bun install --frozen-lockfile
   bun src/entry-bun.ts
   ```

   The first boot initializes SQLite under `TAKOSERVER_DATA_ROOT` (default
   `.takoserver`) and creates signing keys. When no identity provider is
   configured, it prints an operator sign-in assertion valid for ten minutes.
   If `TAKOSERVER_CONSOLE_ORIGIN` is set, open the exact external console origin
   named by the process and paste the assertion there. It is a separate console;
   the Bun Host does not serve a `/console` page. Treat the operator key under
   the data root and the printed assertion as credentials; keep them out of
   shell history, shared logs, and this repository. To create later assertions,
   use the printed command
   `bun scripts/operator-key.ts sign-in google operator operator@localhost Operator`
   with `TAKOSERVER_OPERATOR_KEY` set to that installation's key path.

   When `TAKOSERVER_CONSOLE_ORIGIN` is unset, the Host serves its landing page
   and API, not a console. The process prints the Host origin and its
   `/openapi.json` URL. For the default operator-assertion sign-in, a manual
   client can exchange the printed assertion for a session:

   ```http
   POST {host-origin}/v1/sessions
   Content-Type: application/json

   {"provider":"google","method":"operator-assertion","assertion":"<printed assertion>"}
   ```

   Use the returned `sessionToken` as `Authorization: Bearer <sessionToken>`
   for the manual API calls below. If an identity provider is configured,
   complete that provider's sign-in flow instead; the printed operator
   assertion is only available when the operator-assertion path is active.

2. Using the configured external console/client or the authenticated API, find
   the organization that will own Resources. A manual client can call
   `GET {host-origin}/v1/me` to see its organizations; if it needs to create
   one, call `POST {host-origin}/v1/organizations` with the session bearer and
   JSON body `{"name":"<organization name>"}`. Record the resulting
   organization ID. The v2 organization lane uses that exact ID as its Space.
   These `/v1` session, organization, and API-key routes are Takoserver product
   APIs, not the Takoform Host API. If the client needs an organization API key,
   create one with
   `POST {host-origin}/v1/organizations/{organizationId}/api-keys`, using the
   session bearer as an organization owner and a JSON object with exactly
   `name`, `scopes`, and `expiresInSeconds`. Use `resources:read` for read-only
   checks or `resources:write` for Resource operations; write includes read.
   The key secret is shown only once. Keep it out of logs and this repository,
   and store it with the installation's other credentials.

3. Configure artifact-backed Forms only when this Host will use them. See
   [Takoform v2 operator setup](takoform-v2.md) for the supported blocks and
   exact held-artifact format. The Host does not upload or fetch artifacts;
   seed their exact bytes in the object store through operator-owned tooling and
   grant them to `org:<organizationId>` in that same organization's Space.
   `SQLiteMigrationSet`, `WorkerBundle`, and `StaticAssetBundle` retain
   validated artifacts; they do not execute SQL, run a Worker, or serve assets.

   The complete local Worker Forms and SQLite/KV/ObjectBucket/Queue Bindings
   are an optional native profile. It requires both bundles on the exact Worker
   target, the accepted native `workerd`, Actor and Workflow boot, all five
   private planes, and successful owner restoration. Endpoint support has a
   separate HTTPS listener gate. Use the linked setup guide for exact settings;
   a partial setup does not advertise a reduced Worker profile. Artifact-only
   Forms do not require this native profile. Restart with the protected config
   if its blocks or grants change.

4. Check the current v2 surface. Fetch unauthenticated
   `GET /.well-known/takoform/v2`, then use the organization API key to query
   `GET /apis/forms.takoform.com/v2/support?form={exact-form-url}` for each
   exact, versioned Form URL you intend to use. Proceed only when that exact URL
   reports `supported: true`; support reflects the Forms configured in this
   running Host. If a config change was needed after startup, restart it first.

5. Using that Form's published input contract, create a Resource with the
   organization API key and `resources:write` at
   `POST /apis/forms.takoform.com/v2/resources`. Set `space` to the exact
   organization ID and provide a unique `Idempotency-Key`. The Host accepts an
   asynchronous Operation; poll
   `GET /apis/forms.takoform.com/v2/operations/{operationId}` until terminal,
   then read the Resource back with the same credential at
   `GET /apis/forms.takoform.com/v2/resources/{resourceUid}`. Use the exact Form
   URL and request shape from that published contract; there is no generic body
   that applies to every Form.

The Bun self-host exposes two unauthenticated, no-store operational probes,
outside the Host API v1 and the shared OpenAPI route table:

- `GET /_takoserver/health/live` returns `200` while the Bun HTTP handler is
  responding. It does not query SQLite or the Worker runtime.
- `GET /_takoserver/health/ready` performs one read-only `SELECT 1` query with
  a one-second response deadline, then makes one bounded, read-only listener
  observation of the accepted legacy workerd child. It returns `200` only when
  SQLite answered and the legacy runtime's listener is currently reachable or
  that runtime is not required; otherwise it returns `503`. v2 Worker owners
  are reported separately (below) and, on their own, only mark the response
  `degraded`.

The readiness body contains only fixed state labels: `database` is `readable`
or `unavailable`; `workerRuntime` is `not-required`, `starting`, `serving`,
`recovering`, `restore-failed`, or `unavailable`; and `supervisor` is the
current child lifecycle state (`idle`, `starting`, `serving`, `recovering`, or
`unavailable`). If the accepted child is still alive but its listener probe
fails, `workerRuntime` is `unavailable` while `supervisor` remains `serving`;
the fields distinguish observed service availability from process lifecycle.
v2 Worker owners supervise their own workerd children outside that
supervisor, so when the Host has a v2 Worker composition the body also carries
`v2Workers: { owners, serving, unavailable }`: counts of opened owners, of
owners whose recorded active incarnation's child group is ready, and of owners
that recorded an active incarnation whose child is not ready (crashed or being
replaced). For v2, "serving" means the owner's supervised child holds its
listener port; the probe does not send an HTTP request to a tenant Worker, so
it is not the listener reachability check described above. An owner whose
Deployment is being deleted counts as neither serving nor unavailable.

Serving owners turn a would-be `not-required` into `serving`. One or more
unavailable owners add `degraded: true` but keep the response `200` when SQLite
answered: this probe shares its port with the control API, and one broken
tenant Worker must not make a load balancer withdraw the operator API. Read
`degraded` and the counts to alert on tenant Workers. The response is `503`
only when SQLite did not answer, the boot restore failed, the legacy runtime
is unavailable, or the v2 owner state could not be read within the deadline.
The counts carry no Worker UID or hostname. An empty successful boot restore with no published Workers is
`not-required`, not a failure. A failed boot restore remains `restore-failed`
for this process even if a later child passes its listener check: that check
does not prove the entire durable published graph was restored. A process
restart performs the authoritative boot restore again.

These probes are observational only: they do not call restore, spawn or ensure
workerd, stop the child, or run a product/provisioner route. The ready probe
checks the exact accepted listener around one loopback HTTP request (250 ms
request bound, 500 ms total observation bound); it does not schedule recovery.
The response contains no raw errors, paths, organization or Resource
identifiers, workload counts, or secrets. A `serving` result means this Host's
current workerd child passed the Host-owned listener readiness check; it is
not a claim that every Form,
provider, or tenant Worker application is ready. In particular,
Host/control-plane readiness and application-level health remain distinct.
`GET /healthz` on the Cloudflare Worker entry is a separate runtime surface;
these Bun-only diagnostics do not change that entry or the shared OpenAPI
contract.

### Container Endpoint HTTPS listener

The opt-in Bun self-host Container lane can own a dedicated HTTPS listener on
TCP 443 for Container Endpoint traffic. It is Container-only: it does not front
the Bun control listener, route Worker endpoints, or change the existing
Workerd-owned Worker TLS behavior described by [ADR 0009](../adr/0009-a-self-host-publishes-the-scheme-its-socket-serves.md).
Do not configure the Bun control listener or Workerd on port 443 at the same
time. When the Container Endpoint lane is explicitly enabled, the Host also
refuses a Worker endpoint port declaration of 443 because this dedicated
listener is not a shared Worker/control gateway.

Set `TAKOSERVER_SELFHOST_CONTAINER_ENDPOINT_SUFFIX` to one operator-selected
DNS suffix, and configure the existing
`TAKOSERVER_WORKERD_TLS_CERT_FILE` / `TAKOSERVER_WORKERD_TLS_KEY_FILE`
certificate material (or the existing inline PEM pair). Bun independently
checks that the certificate covers the one-label `ce-<40 hex>.<suffix>`
hostname shape, binds its own listener on 443, and performs a local SNI
handshake before it exposes a serving capability. The PEM pair is shared
configuration material; Workerd's listener and scheme continue to use their
existing rules.

The configured suffix is an operator input, not proof of DNS ownership. The
local certificate and socket checks do not prove public certificate trust,
external DNS resolution, firewall/NAT routing, or internet reachability. The
operator remains responsible for those external facts. There is no listener or
Container Endpoint Offering unless the exact supported Service and Endpoint
package pair and the opt-in Container runtime are both present. The released
default set of 17 Forms does not gain a Container Form through this setting;
local candidate fixtures and a successful local handshake do not publish or
admit a Form package.

For incidents, operators should still collect supervisor process state and
captured startup/runtime logs (including `workerd runtime child exited`,
restart scheduling, and recovery-success diagnostics), then perform an
authenticated functional readback. These probes and signals do not constitute
a monitoring or alerting service.

An explicit Worker publish/delete reload calls the serving supervisor's
`ensure` path. If an accepted child remains alive but has lost its listener,
that path may replace the child in this Host process. It first verifies the
listener is vacant, gives the existing bounded startup readiness probe a
chance to observe a watch-mode reload settling, then verifies ownership again.
A listener restored by that same child is not bounced. For a still-vacant
listener, the supervisor signals only the accepted child and waits for its actual
exit and a vacant port before starting a replacement from its retained desired
config path. A foreign listener, failed socket-ownership observation, or
unconfirmed child exit refuses replacement. A failed replacement startup or
stop also retains custody of its signalled child until exit and port vacancy
are proven; no health GET initiates recovery.

## Update and code rollback

Treat an update as selecting a new exact source commit, not as `git pull` on a
live checkout or as floating to a presumed latest release. Before changing
source, select and review the intended commit and the exact workerd artifact
the new checkout expects. Ensure that exact commit is already available in the
repository, then prepare a separate detached source checkout without moving the
currently active one:

```sh
git worktree add --detach <new-checkout> <reviewed-commit>
cd <new-checkout>
bun install --frozen-lockfile
```

Keep the previous source checkout available so a code-only return is possible
without changing the active source before the operator has selected it. Use
the same operator-controlled process supervisor and protected configuration
when selecting which checkout to run; this guide does not prescribe a service
manager or its unit-file layout.

For each update, first make the cold snapshot described below. Stop the Bun
Host and all child/workload writers, deploy the selected source checkout and
locked dependencies, then start that exact version under the existing
protected configuration. Startup can apply forward SQLite migrations and
resume queued work. Confirm startup diagnostics and the v2 discovery endpoint
`GET /.well-known/takoform/v2`. With an organization API key, check each
expected exact Form using
`GET /apis/forms.takoform.com/v2/support?form={exact-form-url}`, then read
back a known v2 Resource at
`GET /apis/forms.takoform.com/v2/resources/{resourceUid}`. The legacy
`GET /v1/forms` catalogue is not a v2 support check. Consider the update in
service only after these current-surface checks succeed. If any post-start
result is uncertain, stop further traffic/work through the existing supervisor
and retain logs and the current database for diagnosis.

Code rollback is not database rollback. To return to the previous code, stop
the Host and all writers, confirm that the retained previous checkout's
migration reader recognizes the database's complete recorded history and its
runtime is compatible with the current persisted state, then select that
checkout in the existing supervisor and restart it. Perform the same startup,
Forms, and authenticated Resource readback checks as for an update. Do not test
an unknown older binary by starting it against the primary database. Never
restore an older database over the current one merely to make an older binary
start. SQLite schema changes are forward-only; an unknown recorded migration
is a refusal, not permission to edit, reset, or replace the database. If
compatibility is not established, keep the current data intact and repair
forward with a source version that understands it. A cold backup restore is a
separate recovery operation with source fencing and identity ownership
requirements below, not a routine code rollback.

## Backup and restore preparation

This procedure prepares a cold copy of one Bun self-host installation. It is
not a tested disaster-recovery guarantee: the repository has no operator
snapshot/restore command, no restore mode that suppresses startup work, and no
full live-operator restore drill. The tests below cover local readers and an
optional isolated native Host restore; neither replaces an operator recovery
drill.

## What belongs to one installation

Back up the complete configured `TAKOSERVER_DATA_ROOT` as one unit (default:
`.takoserver`). Do not assemble a backup from a hand-picked list of files. The
root contains the local control database by default, object bytes and their
metadata, customer SQL databases, published Worker bundles and active
deployment data, self-host resource and event state, runtime probes, and
private signing keys. Paths such as `objects/`, `databases/`, `workers/`,
`selfhost/`, and `runtime-probes/` are implementation details; retaining the
whole root also retains paths added by later versions.

`TAKOSERVER_DB` can put `control.sqlite` outside the data root. If it is set,
that exact database is part of the backup set too. A backup is incomplete if
either the root or that database is missing.

The running configuration may also depend on material outside the root. Record
the exact service configuration and protect any configured external values or
files needed to recover the same identity and capabilities, including TLS
certificate/private-key files, `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING`,
operator-supplied signing keys, and configured provider, payment, identity, or
AI credentials. Do not put secret values in this repository or in a backup
manifest. `TAKOSERVER_WORKERD_BINARY` must still resolve to the exact accepted
artifact for Worker execution; the selected snapshot is retained under the
data root, but startup validates and selects from the configured input path.
Preserve that artifact and its path/configuration through the operator's
protected mechanism. Keep external configuration and secrets at least as
carefully as the data root; the database and files contain customer and
credential-bearing state.

## Cold snapshot

1. Choose a protected destination with enough free space for the whole root and
   any external `TAKOSERVER_DB`. Use a destination that is not served by the
   source host.
2. Stop the Takoserver service through its actual supervisor and wait until
   `entry-bun.ts`, its child `workerd`, and any other process configured to
   write this data has exited. A graceful stop is not enough until all writers
   are gone. The Bun entry starts queue delivery and cron timers and restores
   published Workers automatically at startup; there is no read-only boot
   switch for a copy.
3. With the installation quiescent, make a filesystem copy of the complete
   data root to the protected destination, preserving file contents,
   directories, and restrictive permissions. If `TAKOSERVER_DB` is outside the
   root, copy its main file and any existing SQLite `-wal`, `-shm`, or rollback
   journal sidecars in the same stopped window. Do not copy a live SQLite file,
   copy only its main file while sidecars may be changing, or guess which
   sidecars can be omitted. This procedure intentionally requires a
   stopped-and-quiescent installation rather than promising a live snapshot.
4. Record outside the secret-bearing files which source instance and time the
   copy represents, the resolved data-root and database paths, the product
   commit, and the configured external dependency references needed to locate
   recovery material. Do not record credentials themselves.
5. Keep the source stopped until the copy has completed. Then restart only the
   original instance if it is still the active installation.

## Restore boundary

Restoring the files is not a safe way to validate a clone. Starting
`bun src/entry-bun.ts` on a restored copy is an active operation: it opens and
may migrate SQLite, restores published Worker routing, starts the public
listener, and starts queue/cron delivery. There is no supported mode that
guarantees an isolated clone cannot accept resource writes or replay pending
work. Do not start a restored copy while the source can still serve or deliver
events, and do not attach both copies to the same public origin, runtime
endpoint, external services, or tenant traffic.

For an actual recovery, first fence the source instance and all its writers and
confirm they cannot return. Restore the complete root and any external database
to the intended replacement, reinstate its protected configuration and
required secrets, and verify that only the replacement owns the installation's
network identity before starting it. Use a product build that understands the
database's recorded migration history: SQLite upgrades are forward-only, and a
build that does not know a recorded migration refuses the database rather than
downgrading it. A restart may deliver queued work; treat that as resuming the
installation, not as a no-write restore check. If source fencing, ownership of
the public identity, or the fate of pending operations is uncertain, leave the
restored copy stopped and resolve that uncertainty before activation.

After activation, perform the same current v2 discovery, authenticated exact
Form-support, and known v2 Resource-readback checks described for an update.
The legacy `/v1/forms` catalogue does not establish v2 support.

## Automated proof and its limits

The portable test `tests/self-host-backup-restore.test.ts` copies a disposable
fixture after closing its SQLite connection, then reopens the copied database,
object store, and published Worker files through their current readers. It does
not boot the entrypoint, prove a complete installation restore, exercise
external credentials or services, test a real filesystem snapshot, or replace
an operator recovery drill.

The optional native test `tests/selfhost-host-cold-restore-native.test.ts`
is skipped when the accepted workerd artifact is unavailable and starts the
real Bun entrypoint when it runs. It retains an earlier v1 admission stage
before a v2 transition; those v1 assertions are historical transition evidence,
not the current v2 support check. It creates
resources through the Host HTTP API, uploads and publishes a Worker, and checks
its Endpoint over certificate-validated HTTPS. It then kills only the exact
accepted workerd child and requires a distinct replacement under the same Bun
Host process. Within 15 seconds, that replacement must serve the same HTTPS
marker at the old URL without a Resource read, client republish, manual child
spawn, or Host restart. The test checks process identity throughout; TLS
validation failures, an unexpected HTTP status, or a different marker fail
immediately rather than being retried. After the Host and its workerd
descendants have exited and both listeners have closed, it copies the complete
data root, an external control database directory (including any sidecars), and
external TLS material in the same stopped window. A new Host starts from the
copy. The test checks the old HTTPS URL before reading the Resource graph, then
checks that UIDs, revisions, exposed outputs, and the Endpoint URL are retained.
The client does not republish resources during recovery.

This native case requires Linux `/proc`, Bun, OpenSSL, `unshare`, `ip`, an exact
accepted workerd artifact, and permission to create a network namespace and
bind port 443 there. Run it from the repository root in a separate loopback-only
network namespace; do not borrow the ports or data root of an existing Host.
The test also builds `services/takoform-core-verifier` from this checkout into
its mode-0700 temporary fixture using the locally installed Go toolchain and
pre-existing Go module/build caches. It disables module-network access; a
missing tool or cache fails the test instead of substituting a prebuilt binary.
The Go build is bounded to two concurrent package builds and two active Go
processors; this does not change the native Host or recovery time assertions.
The verifier reports the current checkout's source-derived artifact digest and
pins released Core v1.1.0. In the retained historical v1 admission stage, the
test submits the exact 17-package publisher closure over its real loopback HTTP
API, requires acceptance, then requires refusal of changed package bytes and a
valid-but-wrong publisher ref at that same verification endpoint. The legacy
self-host admission CLI then applies the unchanged closure through its existing
`--core-verifier` interface. This verifies that historical stage, not the
current v2 installation procedure. The native harness allows up to 120 seconds
for that local apply process and 240 seconds for the entire native test; these
are test budgets, not a production CLI or Host API deadline. The child-stop,
Host-readiness, Worker-recovery, and cleanup bounds are unchanged.

For example, provide Bun 1.4.0, Go, and the existing local Go caches in `PATH`
and the two cache variables; no module download or network fallback is used:

```sh
env -i PATH="$PATH" TMPDIR=/tmp \
  TAKOSERVER_NATIVE_GO_CACHE=/path/to/existing/go-build-cache \
  TAKOSERVER_NATIVE_GO_MODULES=/path/to/existing/go-module-cache \
  TAKOSERVER_WORKERD_BINARY=/absolute/path/to/accepted-workerd \
  unshare --net sh -c \
  'ip link set lo up && bun --no-env-file test --timeout 240000 tests/selfhost-host-cold-restore-native.test.ts'
```

An unset artifact explicitly skips this native case; a portable check therefore
does not prove native restore or Core publisher authenticity. A configured but
unaccepted workerd artifact fails rather than substituting a different binary.
The Go verifier and 17-package signatures exercise the retained historical v1
admission stage only; the operator assertion, operator key, and self-signed
endpoint TLS certificate remain disposable local fixture identities. This
test does not prove production deployment provenance, external credential or
service recovery, pending event delivery, monitoring, or an operator
disaster-recovery drill. Startup remains active as described above; there is
no read-only restore mode.

The serving supervisor writes bounded child-exit, automatic-restart attempt and
delay, and recovery-success diagnostics through its existing log callback (the
Bun entry forwards these to stdout). New recovery messages contain no config
path or arbitrary child error text; deliberate stops and stale children are
not reported as crashes. A failure to write these diagnostics does not stop
runtime recovery. Operators still need to collect logs and configure their own
alerts: these messages are not a health API, monitoring service, or proof of
operator recovery.

### Ordinary journey native test and known gaps

`tests/selfhost-v2-ordinary-journey-native.test.ts` follows this guide with
real `bun src/entry-bun.ts` processes and real workerd children. It requires
the same opt-in as the entry lifecycle test (`TAKOSERVER_V2_ENTRY_NATIVE=1`),
the accepted `TAKOSERVER_WORKERD_BINARY`, a `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY`
built from this checkout, Linux `/proc`, OpenSSL and a loopback network
namespace with TCP 443, as for the other native entry tests.

Its journey starts from an empty data root: the first boot prints the operator
assertion and the later-assertion command, the assertion is exchanged for a
session, and an organization and organization API key are created. The
operator then seeds held artifacts, starts the complete Worker profile and
checks support for each Form. It creates a Worker with `fetch` and `queue`
handlers, a SQLite Binding with an applied migration, a Queue Producer Binding,
a Deployment, an Endpoint and a Queue Consumer, and reads them back over
certificate-validated HTTPS. It then seeds a second bundle, restarts, deploys a
new Version and observes the new behaviour; SIGKILLs the Host while a 5 MiB
artifact Operation has durably staged only a prefix and Queue messages are in
flight; restarts, replays the same key and checks that the Operation settles
once, the Worker is still served without a client republish and every message
has exactly one terminal ack (a rejected attempt is retried in its own batch);
and finally deletes everything in reference order, with a refused premature
delete on the way, and checks the artifact tables, the SQLite directory, the
workerd children and TCP 443.

This is a local, loopback, single-host result with a self-signed certificate
and operator-seeded artifact bytes. It does not cover a `scheduled` handler,
Actor or Workflow use, public DNS or certificate trust, Hosted/WfP, a host
reboot or an operator disaster-recovery drill. Messages in flight at the
crash are redelivered at least once, and a batch reserved but not yet sent is
held for its 120 second reservation before redelivery.

What this test and its neighbours record:

- **A Host stopped during a Deployment or Endpoint Operation: which windows
  recover.** The runtime owner persists a candidate incarnation (and then its
  child process identity) before any native effect, and activates it with one
  atomic owner-state write that also demotes the incumbent. So at any stop the
  committed incumbent is the only thing that served, and a candidate that was
  not activated never served. Recovery relies only on that durable state, and
  only the owner's boot recovery may ask the current-serving fence for this
  tolerance (a dedicated reader method; every other reader is strict):
  - *Queued* (accepted, no dispatch recorded): boot adopts the incarnation that
    was serving; the Operation runs once afterwards (three real-Host tests).
  - *Dispatched, owner untouched* (`reconciling`, but the owner persisted
    nothing): the owner vouches that the Operation never served, boot adopts the
    serving incarnation, and the engine re-drives the Operation once through a
    fresh incarnation (a test simulates the two engine writes that precede the
    native send).
  - *Candidate persisted, not activated* (a real SIGKILL once the owner holds a
    candidate and its child): on a stale-owner takeover the owner proves the
    recorded child is dead and its listener vacant, records the retirement under
    the candidate's own Operation ID, writes the group's retirement receipt
    without starting a child, and finishes the normal retired-copy cleanup. The
    Operation ID is never given a second incarnation: when the engine re-drives
    the Operation, the owner answers with that proof and the backend settles it
    through the normal failure path as `failed` with effect `none`
    (`worker_incarnation_retired_before_activation`). This holds for a create,
    an update, and an Endpoint DELETE while a Deployment exists (that DELETE
    publishes the hostname-less graph through a candidate, like an update; the
    committed incarnation keeps its hostname and the user re-issues the
    DELETE). A Deployment DELETE never stages a candidate. Re-applying the
    change publishes once. The retry waits for the killed Host's claim lease to
    expire (about one minute), and while the Operation is pending the Worker's
    Endpoint answers 503, as during any pending update. A candidate with no
    recorded child identity, a live child or a foreign listener is still
    refused, as is a record that carries a publication identity or a pinned
    configuration (tests for each).
  - *Killed again before the re-apply.* A first publication abandoned this way
    leaves no active incarnation. A further SIGKILL or OOM before the user
    re-applies, including one during the abandoning boot's own retirement step,
    still boots: the stale-owner takeover recognises the never-activated
    residue instead of demanding a DELETE replay (a test with two consecutive
    real kills, and one that reproduces the durable state of a kill between
    the retirement intent and the receipt).
  - *Candidate failed inside a running Host.* The same proof is given without
    a restart, so the Operation settles `failed` with effect `none` on the
    engine's next retry (an owner and backend test). A Host killed while that
    candidate is still being retired boots and settles it the same way (a
    real-Host test).

  A Deployment or Endpoint Operation that ends `failed` with effect `none`
  never makes a non-committed graph serve. Until a later Operation of that
  Resource succeeds, each surface behaves as follows (the forward-only
  migrations whose guards decide this are not changed):
  - *The current-serving fence* (the owner, boot recovery, the HTTPS frontend's
    publication check) reads the attachment as of its last committed
    generation, rebuilt from immutable Operation history, never the failed
    spec. Measured at the fence for in-process failures of every attachment
    shape, and end to end on a real Host for the restart case above. It covers
    at most eight consecutive `failed`/`none` Operations of one Resource behind
    its committed generation; a ninth makes the fence refuse again, in the
    strict and the boot-recovery form, until a re-apply succeeds (measured for
    the source Endpoint). A failure with effect `partial`, or any unknown or
    non-contiguous history, is refused as before.
  - *HTTP on the Endpoint hostname* keeps serving the committed graph after a
    failed Deployment Operation (measured end to end). After a failed Endpoint
    update or DELETE the hostname answers 503 until a later Endpoint Operation
    succeeds: the frontend only routes an Endpoint Resource that is idle at its
    observed generation with a succeeded last Operation (a frontend test pins
    this). The owner still holds the committed incarnation.
  - *Queue delivery pauses* when the failed Operation belongs to the Resource
    that carries the serving source Operation (the Endpoint when an Endpoint
    Operation published last, otherwise the Deployment). The 0083 batch
    reservation and send-authorisation guards require that Resource idle at
    its observed generation with the source as its last Operation, so no new
    batch is reserved or sent; the same holds for Queue sends made from a
    Queue handler. A failure of the other attachment does not trip those
    guards. Code reading, not measured.
  - *QueueConsumer create and update for the Worker are refused* after any
    failed Deployment or Endpoint Operation (the admission predicate requires
    the Deployment idle with a succeeded last Operation and no Worker
    publication accepted after the serving source). Code reading.
  - *Cron pauses* after a failed Deployment Operation: the 0089 match guard
    requires the active Deployment idle at its observed generation with a
    succeeded last Operation, so no match is recorded (a scheduler test pins
    this). It does not read the Endpoint. Code reading for Cron invocation
    admission, which requires the same of the Deployment.
  - Queue sends made from an HTTP request are checked against the Queue, the
    sending Version and the owner's live incarnation, not against the
    attachments; whether they continue is not established here.

  Boot recovery also accepts a re-apply that is only queued (or dispatched
  but vouched never served) behind such failures, within the same eight
  Operation bound, including a re-apply after a failed first create. The
  queued cases are measured at the fence.

  Still refused with `ownership_uncertain` (data untouched, manual repair): an
  Operation the owner already activated but SQL never settled, a Deployment
  DELETE that closed admission, a candidate whose child identity was never
  recorded, a dispatched Operation the owner cannot vouch for, and more than
  eight consecutive failed Operations of one attachment (the fence refusal is
  measured; the resulting boot refusal is not). By reading the backends (not
  measured), a Deployment or Endpoint backend answers `unknown` for every
  refusal before it reaches the owner (an unresolved graph, a
  `publication_conflict`), so such an Operation stays `reconciling` and keeps
  retrying: boot is not blocked, because the owner vouches it never served,
  but the Worker's Endpoint is not served until the Operation is settled.

Three other gaps this test first recorded have since been fixed, each with its own
test:

- **Readiness observes v2 Worker owners** (see the `v2Workers` counts above).
- **A busy control database waits five seconds, then fails.** The control
  database sets a bounded `busy_timeout`, so a short external read (`sqlite3`,
  a backup tool, a poller) delays a Host write instead of failing it. It
  stays in rollback-journal mode on purpose: the documented cold backup copies
  a stopped data root, and the tenant SQLite stores are deliberately
  rollback-journal. A reader that holds the lock longer than five seconds still
  fails the write; a failing background pass now logs its name and a bounded
  cause, and a Queue reservation that was never sent is refunded with retries
  bounded to one second in total before it falls back to its 120 second expiry.
  A lock that outlasted the five second wait is not retried, because each
  attempt would block the Host for that long again. Do not read the live
  database anyway; stop the Host first.
- **The boot note for an unpublishable Worker endpoint is one coherent
  statement.** It says endpoints cannot be created in this profile, names the
  address they would have, and gives the remedy once.

## Historical reference: v1 signed package admission

The former self-host admission path built a Takoform Core v1.1.0 verifier from
the checkout, derived its artifact digest with the deploy helper, and used
`scripts/selfhost-form-admission.ts` to verify and admit an exact closure of 17
signed publisher packages. Its old catalogue check was `GET /v1/forms`. This
package-verification and durable-admission workflow belongs to the former v1
Host path; the current normal Bun entry does not require it. Current v2 support
comes from the exact versioned Form URLs composed by source and the optional
operator configuration described in [Takoform v2 operator setup](takoform-v2.md).

The optional native cold-restore test retains a v1 admission stage followed by
a v2 transition as historical compatibility evidence. Neither that fixture nor
the former package-admission procedure is the current v2 install path or a
current v2 support signal.
