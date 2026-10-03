# Self-host operations: install, admission, update, and recovery

This guide covers the Bun self-host path from a source checkout to a first
usable Takoform Host, then the operator's maintenance boundary. It documents
the current source entrypoints, not a packaged installer or a published
release channel. Select a reviewed source commit and retain its exact source
and artifact provenance; this guide does not identify a latest release or
claim GA status.

## First install and first use

1. From the selected, reviewed Takoserver checkout, install its locked
   dependencies and start the Bun entrypoint:

   ```sh
   bun install --frozen-lockfile
   bun src/entry-bun.ts
   ```

   The first boot initializes SQLite under `TAKOSERVER_DATA_ROOT` (default
   `.takoserver`), creates signing keys, and, when no identity provider is
   configured, prints a short-lived operator sign-in assertion valid for ten
   minutes. Open the exact `/console` URL printed by the process and paste the
   assertion. Treat the operator key under the data root and the printed
   assertion as credentials; keep them out of shell history, shared logs, and
   this repository. To create later assertions, use the printed command
   `bun scripts/operator-key.ts sign-in google operator operator@localhost Operator`
   with `TAKOSERVER_OPERATOR_KEY` set to that installation's key path.

2. In the console, create or select the organization that will own Resources
   and choose the exact stable Space identifier. Record the organization ID
   from the Host; the admission command does not create either one. A fresh
   Bun Host intentionally serves no Forms before this step's explicit
   admission. Confirm that the normal self-host Provider3 mode is selected;
   the retired Cloudflare ObjectBucket drain mode cannot be used for admission.

3. Prepare the released Takoform Core verifier from this same source checkout.
   Its Go module pins Core v1.1.0. Compute the artifact identity from the
   checkout's own deploy helper, build the verifier, and start it only on a
   host/network isolated from untrusted traffic. The verifier currently binds
   `:8080` on all interfaces and has no bind-address flag; do not expose that
   port publicly. Either restrict non-loopback access with the host's
   operator-managed firewall, or run the verifier in a dedicated network
   namespace. In the namespace case, the admission CLI must also run inside
   that same namespace to reach `127.0.0.1:8080`; loopback in a different
   namespace is a different interface:

   ```sh
   CORE_DIGEST="$(bun -e 'import { takoformCoreVerifierArtifactDigest } from "./scripts/deploy/form-authority.ts"; console.log(takoformCoreVerifierArtifactDigest())')"
   (cd services/takoform-core-verifier && go build -o /absolute/operator-managed/path/takoform-core-verifier ./cmd/server)
   TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST="$CORE_DIGEST" /absolute/operator-managed/path/takoform-core-verifier
   ```

   Keep that verifier process available at the address reachable from the
   admission CLI while planning and applying admission. Do not substitute a stock npm `workerd`
   binary for `TAKOSERVER_WORKERD_BINARY`: Worker execution requires the exact
   currently reviewed, accepted workerd artifact and source configuration.
   Without that artifact, worker-backed execution is unavailable rather than
   silently selecting npm's binary. This Linux/x64 Worker lane also requires
   `/usr/bin/setpriv`, `/bin/sh`, and mounted Linux `/proc`. The Host uses them
   to bind its workerd child to the Host process and verify that the configured
   Worker TCP port belongs to that child. Missing support disables Worker
   serving rather than falling back to an unbound child; SQLite and storage
   remain independent.

4. Stop the Bun Host through the supervisor actually used for this installation
   and wait for its child `workerd` and all other writers to exit. Then run the
   operator command from the selected source checkout. The first invocation is
   plan-only; inspect its output. Apply only the plan you intend, using the
   same checkout, verifier, data root, control database, Host origin,
   organization, and Space. The CLI takes the data root from `--data-root` (or
   `TAKOSERVER_DATA_ROOT`) but takes the database path only from
   `TAKOSERVER_DB`; it has no database-path flag. If the running Host uses an
   external `TAKOSERVER_DB`, pass that exact resolved path to both CLI
   invocations. The examples below require the Host's effective database path
   in either case: use the configured external path, or the resolved
   `<data-root>/control.sqlite` default when the Host has no `TAKOSERVER_DB`.
   If the Host's effective database path is unknown, do not run admission;
   otherwise the CLI could open a different or newly created `control.sqlite`
   instead of the Host's database.

   ```sh
   TAKOSERVER_DB=<resolved-control-database-path> \
   bun scripts/selfhost-form-admission.ts <organizationId> <space> \
     --data-root <resolved-data-root> --host-id <canonical-public-origin> \
     --core-verifier http://127.0.0.1:8080
   TAKOSERVER_DB=<resolved-control-database-path> \
   bun scripts/selfhost-form-admission.ts <organizationId> <space> \
     --data-root <resolved-data-root> --host-id <canonical-public-origin> \
     --core-verifier http://127.0.0.1:8080 --apply
   ```

   Replace angle-bracket values with this installation's exact values,
   including the absolute, resolved data-root and control-database paths the
   Host uses. Pass `--data-root` even when the Host uses the default
   `.takoserver`, resolved relative to the Host's working directory. Run both
   commands in the same network namespace as the verifier, or use the same
   explicitly secured bridge and matching reachable verifier URL. Do not put
   secrets in the command: this admission path does not require a Cloudflare
   token.
   The command verifies the checkout-pinned Core identity, imports and verifies
   all 17 embedded publisher packages, then installs the package set and
   activates only the implemented subset for the selected organization/Space.
   It does not promote all Forms as usable, or change the released Form
   definitions. Re-running it replans from durable admission state.

5. Restart the Host using its configured supervisor. Collect its stdout and
   stderr, including the `takoserver listening` line. Check the public,
   unauthenticated `GET /v1/forms` response and confirm it reports the expected
   Host answer for the admitted definitions. Then sign in, create/use a scoped
   organization API key as needed, perform one ordinary resource operation
   through the supported console/client, and read it back through
   `GET /v1/organizations/{organizationId}/resources/{resourceUid}`. A route
   accepting connections or a process log line alone is not functional
   readback.

The Bun self-host exposes two unauthenticated, no-store operational probes,
outside the Host API v1 and the shared OpenAPI route table:

- `GET /_takoserver/health/live` returns `200` while the Bun HTTP handler is
  responding. It does not query SQLite or the Worker runtime.
- `GET /_takoserver/health/ready` performs one read-only `SELECT 1` query with
  a one-second response deadline, then makes one bounded, read-only listener
  observation of the accepted workerd child. It returns `200` only when SQLite
  answered and the required runtime's listener is currently reachable or the
  runtime is not required; otherwise it returns `503`.

The readiness body contains only fixed state labels: `database` is `readable`
or `unavailable`; `workerRuntime` is `not-required`, `starting`, `serving`,
`recovering`, `restore-failed`, or `unavailable`; and `supervisor` is the
current child lifecycle state (`idle`, `starting`, `serving`, `recovering`, or
`unavailable`). If the accepted child is still alive but its listener probe
fails, `workerRuntime` is `unavailable` while `supervisor` remains `serving`;
the fields distinguish observed service availability from process lifecycle.
An empty successful boot restore with no published Workers is
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
resume queued work. Confirm startup diagnostics, the expected `GET /v1/forms`
answer, and an authenticated readback of a known Resource before considering
the update in service. If any post-start result is uncertain, stop further
traffic/work through the existing supervisor and retain logs and the current
database for diagnosis.

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

## Automated proof and its limits

The portable test `tests/self-host-backup-restore.test.ts` copies a disposable
fixture after closing its SQLite connection, then reopens the copied database,
object store, and published Worker files through their current readers. It does
not boot the entrypoint, prove a complete installation restore, exercise
external credentials or services, test a real filesystem snapshot, or replace
an operator recovery drill.

The optional native test `tests/selfhost-host-cold-restore-native.test.ts`
starts the real Bun entrypoint and the accepted workerd artifact. It creates
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
pins released Core v1.1.0. Before durable Form admission, the test submits the
exact current 17-package publisher closure over its real loopback HTTP API,
requires acceptance, then requires refusal of changed package bytes and a
valid-but-wrong publisher ref at that same verification endpoint. The actual
self-host admission CLI then applies the unchanged closure through its existing
`--core-verifier` interface. The native harness allows up to 120 seconds for
that local apply process and 240 seconds for the entire native test; these are
test budgets, not a production CLI or Host API deadline. The child-stop,
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
The Go verifier and 17-package signatures are real current-source/Core proof;
the operator assertion, operator key, and self-signed endpoint TLS certificate
remain disposable local fixture identities. This test does not prove production
deployment provenance, external credential or service recovery, pending event
delivery, monitoring, or an operator disaster-recovery drill. Startup remains
active as described above; there is no read-only restore mode.

The serving supervisor writes bounded child-exit, automatic-restart attempt and
delay, and recovery-success diagnostics through its existing log callback (the
Bun entry forwards these to stdout). New recovery messages contain no config
path or arbitrary child error text; deliberate stops and stale children are
not reported as crashes. A failure to write these diagnostics does not stop
runtime recovery. Operators still need to collect logs and configure their own
alerts: these messages are not a health API, monitoring service, or proof of
operator recovery.
