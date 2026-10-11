# Self-host operations: install, update, and recovery

This guide covers the Bun self-host path from a source checkout to a first
usable Takoform Host, then the operator's maintenance boundary. It documents
the current source entrypoints, not a packaged installer or a published
release channel. Select a reviewed source commit and retain its exact source
and artifact provenance; this guide does not identify a latest release or
claim GA status.

## First install and first use

This is the install path for a Bun self-host, from a reviewed checkout to a
Worker served over HTTPS. [Takoform v2 operator setup](takoform-v2.md) defines
each setting in full; this section is the order in which to apply them. The
Host serves exactly the Forms its configuration composes. It needs no
publisher-set admission: the v1 admission command in the
[historical reference](#historical-reference-v1-signed-package-admission) is
not part of this path.

A self-host runs one of two profiles, selected by configuration:

- **Artifact profile.** The v2 Host API, operator sign-in, organizations, API
  keys, and the artifact Forms `SQLiteMigrationSet 0.2.0`, `WorkerBundle 0.2.0`
  and `StaticAssetBundle 0.2.0`. These Forms validate and retain bytes; they
  do not execute SQL, run a Worker, or serve assets. It needs Bun and the three
  required settings in step 3.
- **Complete local Worker profile.** Adds the Worker lifecycle Forms and their
  SQLite, KV, ObjectBucket and Queue Bindings, listed in
  [Bun self-host Form support](takoform-v2.md#bun-self-host-form-support), run
  by the pinned native `workerd`. The Host advertises them only when every
  prerequisite below is configured and the existing Worker owners restore at
  startup. A partial setup advertises no reduced Worker profile.
  `WorkerEndpoint 0.3.0`, which publishes a Worker at an HTTPS hostname, also
  needs the TCP 443 listener in step 4.

### 1. Prerequisites

- Linux x86-64 with `/proc`, `/bin/sh` and `/usr/bin/setpriv`. The Worker
  runtime supports only this platform. The artifact CLI in step 6 also reads
  `/proc` to prove that the Host is stopped.
- `git`, `curl`, `jq`, `unzip` (for the Bun installer) and `ca-certificates`.
  On Debian or Ubuntu, as root:
  `apt-get install --no-install-recommends git curl jq unzip ca-certificates`.
- A dedicated user, for example `takoserver`, that runs the Host and every
  operator command in this guide. The data root and private key directories
  must belong to that user. For example, as root:

  ```sh
  useradd --system --user-group --home-dir /var/lib/takoserver --no-create-home \
    --shell /usr/sbin/nologin takoserver
  ```

  With that login shell, run the commands this guide gives as the
  `takoserver` user in `runuser -u takoserver -- bash`.
- The reviewed source commit, checked out where root owns it and the
  `takoserver` user can only read it, for example as root:

  ```sh
  git clone https://github.com/tako0614/takoserver /opt/takoserver
  git -C /opt/takoserver checkout --detach <reviewed-commit>
  ```

- Bun at the version in `.bun-version` (currently 1.4.0), installed where the
  `takoserver` user can run it. The installer's default location is the
  installing user's home, which `takoserver` cannot read when root runs it. As
  root, this installs `/usr/local/bin/bun`, the path the wrapper script of
  step 3 runs:

  ```sh
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s bun-v1.4.0
  ```

- For the complete local Worker profile, two native binaries. Install both
  outside the checkout, where only an administrator can replace them, for
  example in `/usr/local/libexec/takoserver` (`install -d -m 0755
  /usr/local/libexec/takoserver` as root):
  - The pinned closed-graph `workerd` artifact. A release that attaches it
    (the file `workerd-closed-graph-2026-08-11-linux-x64` on the GitHub
    Release, with `SHA256SUMS` and the notices bundle) is the easiest source:
    download the files into an empty directory, run `sha256sum --check
    SHA256SUMS`, and follow
    [What an operator verifies](release-assets.md#what-an-operator-verifies).
    Otherwise build it with `bun run build:workerd` as described in
    [the closed-graph workerd artifact](../workerd/README.md); the build needs
    Bazel and a pinned clang and takes hours. The manual
    `workerd-closed-graph-build` workflow can build it on GitHub, but its
    artifact exists only for a run that succeeded for the reviewed commit,
    can be downloaded only by a signed-in GitHub user, and expires with the
    run's artifact retention. On 2026-10-11 no run of that workflow had
    succeeded, so no downloadable artifact existed. `sha256sum` must print
    `c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`.
    Set `TAKOSERVER_WORKERD_BINARY` to its absolute path. At startup the Host
    checks its digest and closed-graph capability and runs a copy under the
    data root. A missing or different binary disables Worker execution; the
    Host never falls back to the npm `workerd`.
  - The Workflow execution guard, built from the same checkout with the Go
    toolchain named on the `toolchain` line of
    `services/workflow-execution-guard/go.mod` (currently go1.26.9, from
    <https://go.dev/dl/>). Set `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY` to
    its absolute path. As root:

    ```sh
    cd /opt/takoserver/services/workflow-execution-guard
    go build -o /usr/local/libexec/takoserver/workflow-execution-guard ./cmd/workflow-execution-guard
    ```

Install the locked dependencies in the reviewed checkout, as root:

```sh
cd /opt/takoserver
bun install --frozen-lockfile
```

### 2. Data root

Choose a short data root, such as `/var/lib/takoserver`. At startup the Host
resolves `TAKOSERVER_DATA_ROOT` once to an absolute, canonical path: a
relative value, including the default, is relative to the working
directory, and symlinks in the existing part of the path are resolved. When
the result differs from the configured value, the process prints it.
SQLite databases created under an earlier relative or symlinked setting stay
bound to their Workers as long as `TAKOSERVER_DATA_ROOT` keeps the same
string; changing the string (for example from the default to an absolute
path, or restoring to a different path) is not supported for existing
SQLite databases. A data root belongs to one machine; do not share it over
a network filesystem. A data root that does not exist yet is created with
mode 0700, together with any missing parent directories. An existing
directory keeps its permissions. The v2 private planes require it to be mode
0700 and owned by the Host's user, and refuse otherwise with the path, mode,
and owner.

Actor and Workflow runtimes bind private Unix sockets in `<data root>/s`,
and a Unix socket path is limited to about 100 bytes. The resolved data root
therefore may be at most 61 bytes whenever Actors or Workflows run. Native
Actor processes, for both the v2 Actor runtime and the implied Actor
runtime, also bind sockets below `TMPDIR`, which may be at most 73 bytes.
`s/` must be mode 0700 and owned by the Host's user. The data root and every
directory above it must be owned by root or by the Host's user, and no
other user may be able to write to them, except a sticky root-owned one such
as `/tmp`. A group-writable ancestor (for example under umask 002, or a
Kubernetes `fsGroup` volume with mode 2775) is refused; tighten it with
`chmod g-w`.

If `TAKOSERVER_V2_WORKER_RUNTIME_BOOT` selects `actor` or `workflow` and one
of these requirements is not met, startup stops with a message that names
the variable or directory, its length or mode, and what is required. The
implied Actor runtime opens only when a workerd binary is selected and the
ActorNamespace Form is installed. If a requirement is not met in that case,
the Host prints that Actor admission is unavailable and why, and serves its
other Forms. The retained v1 Form admission CLI makes the same decision, so it never
admits Actor support that the Host withholds.

`s/` holds only listener directories that each start recreates. It does not
need to be backed up, and a stopped Host may delete it. At startup, the Host
removes the broker directories that a killed Host left behind. It removes
only directories it can prove abandoned: those holding only sockets that
refuse connections, or empty ones last written before the machine booted.
Anything else stays until a stopped Host deletes it, for example a Workflow
execution directory, which also holds configuration and modules. Builds
before this layout used `actor-forward-sockets/`, and the
`*-private-sockets/` and `workflow-temporary/` directories in
`v2-runtime/`, for the same purpose. A stopped Host may delete them too.

The v2 Worker runtime keeps each Worker incarnation's private Service
sockets in `/tmp/tw-<hash>`. This is always `/tmp`, not `TMPDIR`, because a
socket path must stay short. Each directory belongs to the Host's user and
is removed only when its incarnation retires. It is kept across a restart,
so that no other local user can create that name in a shared `/tmp` and
make the next start refuse it. Deleting a data root does not remove these
directories. Run the Host with its own private `/tmp`, for example with
systemd `PrivateTmp=yes`: other users cannot reach it, recovery recreates
any namespace that is missing, and the directories go away with the
service.

For example, as root before the first start:

```sh
install -d -m 0700 -o takoserver -g takoserver /var/lib/takoserver
```

### 3. Configuration

Every start needs three settings; without them startup stops before it opens
any state:

| Setting | Value |
| --- | --- |
| `TAKOSERVER_PUBLIC_ORIGIN` | The canonical bare `https://` origin clients use for the control API, such as `https://api.example.com:8443`. Step 4 explains the port. |
| `TAKOSERVER_TAKOFORM_V2_CONFIG` | Strict, non-secret JSON with HTTPS `documentation` and `authenticationDocumentation` URLs and the optional `sqliteMigrationSet`, `workerBundle` and `staticAssetBundle` blocks of held artifacts. Keep it in a file and pass its contents. |
| `TAKOSERVER_TAKOFORM_V2_CURSOR_KEY` | At least 32 random bytes as canonical, unpadded base64url. It is an operator secret: keep it stable across restarts and outside source and logs. |

`TAKOSERVER_DATA_ROOT` defaults to `.takoserver` in the working directory. If
`TAKOSERVER_DB` puts the control database elsewhere, that database is part of
every backup and restore. `PORT` (default 8787) is the control API listener.
The README lists the other optional settings.

The complete local Worker profile additionally needs all of these:

| Setting | Value |
| --- | --- |
| `TAKOSERVER_WORKERD_BINARY` | The absolute path of the pinned `workerd` artifact (step 1). |
| `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY` | The absolute path of the Workflow execution guard (step 1). |
| `TAKOSERVER_V2_WORKER_RUNTIME_BOOT` | Both Actor and Workflow boot, for example `{"actor":true,"workflow":{"maximumRegistrations":64}}`. |
| `TAKOSERVER_V2_WORKER_PRIVATE_PLANES` | All five private planes: `sqlite`, `kv`, `objectBucket`, `queue` and `queueProducer`. Each names a distinct fixed `privatePort` and its own `signingKeyFile`; `sqlite` also names an existing private `stagingRoot`. A key file holds 32 to 4,096 random bytes, is mode 0600 and lies in a directory private to the Host's user. The Host never generates these keys. |
| `workerBundle` and `staticAssetBundle` config blocks | Both with `targetKey` `selfhost-v2-worker-primary`. An empty `heldArtifacts` list composes the Form; step 6 fills it. An optional `sqliteMigrationSet` block, with any stable `targetKey`, adds `SQLiteMigrationApplication 0.2.0`. |

`TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` is optional: with it, WorkerVersion
accepts `privateInputs` (see the setup guide).

For example, prepare the private files once as the `takoserver` user. The last
command prints a cursor key:

```sh
umask 077
install -d -m 0700 /var/lib/takoserver/plane-keys /var/lib/takoserver/sqlite-staging
for plane in sqlite kv object-bucket queue queue-producer; do
  head -c 32 /dev/urandom > "/var/lib/takoserver/plane-keys/$plane.key"
done
bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))'
```

Keep the environment in a file owned by root, group `takoserver`, mode 0640,
like the TLS key. It holds the cursor key, so only that group may read it;
step 6 sources it as the `takoserver` user. The Host's user must not be able
to change it: the wrapper below reads it at every start, so a Host whose
tenant code escaped the sandbox could otherwise change the next start's
configuration or the commands that start runs. As root, create the file and
the TLS directory, then write the file with the cursor key printed above:

```sh
install -d -m 0755 /etc/takoserver
install -m 0640 -o root -g takoserver /dev/null /etc/takoserver/takoserver.env
install -d -m 0750 -o root -g takoserver /etc/takoserver/tls
# then: install -m 0640 -o root -g takoserver <certificate> <key> /etc/takoserver/tls/
```

Single quotes keep the JSON values intact when a shell sources the file:

```sh
# /etc/takoserver/takoserver.env (owner root, group takoserver, mode 0640)
TAKOSERVER_PUBLIC_ORIGIN=https://api.example.com:8443
TAKOSERVER_DATA_ROOT=/var/lib/takoserver
TAKOSERVER_TAKOFORM_V2_CURSOR_KEY=<the 43 characters printed above>
TAKOSERVER_WORKERD_BINARY=/usr/local/libexec/takoserver/workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52
TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY=/usr/local/libexec/takoserver/workflow-execution-guard
TAKOSERVER_V2_WORKER_RUNTIME_BOOT='{"actor":true,"workflow":{"maximumRegistrations":64}}'
TAKOSERVER_V2_WORKER_PRIVATE_PLANES='{"sqlite":{"privatePort":28101,"signingKeyFile":"/var/lib/takoserver/plane-keys/sqlite.key","stagingRoot":"/var/lib/takoserver/sqlite-staging"},"kv":{"privatePort":28102,"signingKeyFile":"/var/lib/takoserver/plane-keys/kv.key"},"objectBucket":{"privatePort":28103,"signingKeyFile":"/var/lib/takoserver/plane-keys/object-bucket.key"},"queue":{"privatePort":28104,"signingKeyFile":"/var/lib/takoserver/plane-keys/queue.key"},"queueProducer":{"privatePort":28105,"signingKeyFile":"/var/lib/takoserver/plane-keys/queue-producer.key"}}'
# WorkerEndpoint (step 4)
TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS=1
TAKOSERVER_WORKER_ENDPOINT_SUFFIX=apps.example.com
TAKOSERVER_WORKERD_TLS_CERT_FILE=/etc/takoserver/tls/apps.example.com.crt
TAKOSERVER_WORKERD_TLS_KEY_FILE=/etc/takoserver/tls/apps.example.com.key
```

Keep the v2 config on one line in a directory that belongs to the `takoserver`
user, because step 6 replaces the file through a temporary file in the same
directory and so needs to write the directory, not only the file. The config
is not secret. For example, as root:

```sh
install -d -m 0700 -o takoserver -g takoserver /etc/takoserver/v2
```

Then, as the `takoserver` user, create `/etc/takoserver/v2/takoform-v2.json`.
Replace the documentation URLs with this deployment's own:

```json
{"documentation":"https://docs.example.com/resources","authenticationDocumentation":"https://docs.example.com/access","workerBundle":{"targetKey":"selfhost-v2-worker-primary","heldArtifacts":[]},"staticAssetBundle":{"targetKey":"selfhost-v2-worker-primary","heldArtifacts":[]}}
```

The service manager starts the Host from the checkout with these lines, for
example through a small wrapper script that the
[systemd unit](self-host-security.md#recommended-os-hardening) runs as the
`takoserver` user. As root:

```sh
cat > /usr/local/bin/takoserver-run <<'EOF'
#!/bin/sh
cd /opt/takoserver || exit 1
set -a; . /etc/takoserver/takoserver.env; set +a
export TAKOSERVER_TAKOFORM_V2_CONFIG="$(cat /etc/takoserver/v2/takoform-v2.json)"
exec /usr/local/bin/bun --no-env-file src/entry-bun.ts
EOF
chown root:root /usr/local/bin/takoserver-run
chmod 0755 /usr/local/bin/takoserver-run
```

Linux passes at most 131,072 bytes in one environment variable, including its
name. Each held file adds about 370 bytes to the config, so a config holds
about 350 held files in all. The CLI in step 6 refuses to write a config that
would no longer fit, and warns when a printed fragment alone does not. The
Host reads a held entry only while a create stages its bytes: it copies the
manifest and every file into its control database, and never reads the source
again for a Resource whose create has succeeded. Once every Resource that names
an artifact has been created, its entries can be removed from the config. A
new Resource that names the same artifact then needs it seeded and granted
again.

An omitted or malformed required setting stops startup; it never selects v1
or generates a cursor key. A complete-profile setting that is given but cannot
be used also stops startup, with a message that names it: malformed JSON, a
key file that is unreadable, shared or not private, Actor or Workflow boot
without the native binaries (the guard path must be absolute and free of
symbolic links), a data root or `TMPDIR` too long for its sockets, or an
Endpoint selection without its certificate and suffix. A setting that is left
out only leaves the complete profile unregistered, and the Host serves the
artifact profile. It does not print which complete-profile setting is absent,
so compare the configuration with the table above when a Worker Form is not
supported.

### 4. HTTPS and TCP 443

Two listeners face clients.

**Control API.** The Bun listener serves plain HTTP on `PORT`, bound to
`TAKOSERVER_LISTEN_HOST`: `127.0.0.1` by default, so only a TLS front end on
the same machine reaches it. When the front end runs on another machine or in
another network namespace, set `TAKOSERVER_LISTEN_HOST` to one canonical IP
literal and firewall the port so that only the front end can reach it. In a
container or Pod, `127.0.0.1` is the container's own loopback, so set
`0.0.0.0` (or `::` for IPv4 and IPv6) and restrict access with a network
policy or firewall. The startup line `takoserver listening on
<address>:<port>` shows what was bound; [Self-host security](self-host-security.md#network-exposure)
covers the listeners in full. The front end terminates HTTPS for
`TAKOSERVER_PUBLIC_ORIGIN` and must pass the exact public `Host` header;
`Forwarded` and `X-Forwarded-*` headers never select the authority. With
Caddy on the same machine, for example (Caddy passes the incoming `Host`
through unchanged, and the matcher keeps the operational probes of step 9 off
the public origin, as [Monitoring](#monitoring) recommends):

```caddyfile
api.example.com:8443 {
  @probes path /_takoserver/*
  respond @probes 404
  reverse_proxy 127.0.0.1:8787
}
```

**Worker Endpoints.** `TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS=1` makes the Host
itself listen on TCP 443 on every IPv4 address (`0.0.0.0:443`) and terminate
TLS with `TAKOSERVER_WORKERD_TLS_CERT_FILE` and
`TAKOSERVER_WORKERD_TLS_KEY_FILE` (or the inline `TAKOSERVER_WORKERD_TLS_CERT`
and `TAKOSERVER_WORKERD_TLS_KEY` pair). Each Endpoint is assigned a one-label
hostname under `TAKOSERVER_WORKER_ENDPOINT_SUFFIX`, so the certificate must
cover `*.<suffix>` and DNS must resolve `*.<suffix>` to this machine. The
suffix must be a lowercase DNS name with at least two labels, not `localhost`
or an IP address. Binding 443 needs root or `CAP_NET_BIND_SERVICE` (for
example systemd `AmbientCapabilities=CAP_NET_BIND_SERVICE`). Startup refuses
the selection without the certificate pair and suffix, or when 443 is also
the control `PORT`, `TAKOSERVER_WORKERD_PORT`,
`TAKOSERVER_WORKER_ENDPOINT_PORT`, `TAKOSERVER_DATA_PLANE_PORT` or the
Container Endpoint listener.

Because this listener holds 443 on every IPv4 address, a control API front end
on the same machine needs another port, as in the example origin, or it runs
on another machine, with `TAKOSERVER_LISTEN_HOST` set to an address that
machine can reach and the port firewalled as described above. Without the
selection, `WorkerEndpoint` is not advertised; the other Worker Forms are
unaffected. The listener's local certificate and route checks do not prove
public DNS, CA trust or reachability. The retained
pre-v2 Worker socket settings (`TAKOSERVER_WORKERD_PORT`,
`TAKOSERVER_WORKER_ENDPOINT_PORT`) described in the README do not apply to
`WorkerEndpoint 0.3.0`.

### 5. First boot and operator sign-in

Start the Host. The first boot creates the control database and signing keys
under the data root and prints each applied migration. When no identity
provider is configured, it prints an operator sign-in assertion valid for ten
minutes. The assertion is single-use: the first session exchange spends it,
and afterwards both another exchange and an owner proof refuse it. A boot
prints a new one until the operator has signed in, or every time with
`TAKOSERVER_PRINT_OPERATOR_ASSERTION=1`; after the first sign-in a boot prints
only how to mint one. [Self-host security](self-host-security.md#sign-in-and-request-limits)
explains why. If `TAKOSERVER_CONSOLE_ORIGIN` is set, open the exact external console
origin named by the process and paste the assertion there. It is a separate
console; the Bun Host does not serve a `/console` page. Treat the operator key
under the data root and the printed assertion as credentials; keep them out of
shell history, shared logs, and this repository. To create later assertions,
run the printed command, which names the installation's key path and its
public origin. Without `TAKOSERVER_PUBLIC_ORIGIN` the assertion is signed for
`http://localhost:8787`, and the Host refuses it:

```sh
TAKOSERVER_OPERATOR_KEY=/var/lib/takoserver/operator-key.jwk \
TAKOSERVER_PUBLIC_ORIGIN=https://api.example.com:8443 \
  bun --no-env-file scripts/operator-key.ts sign-in google operator operator@localhost Operator
```

If an identity provider is configured, complete that provider's sign-in flow
instead; the operator assertion is only available when the operator-assertion
path is active.

Exchange the assertion for a session, create the organization that will own
Resources, and create an organization API key. The organization's ID is the v2
Space. Run this step and steps 6 to 11 in one shell as the `takoserver` user,
from the checkout, because they share the `ORG`, `KEY` and other shell
variables. Stop and start the service (step 6) from a separate administrator
shell, so that this one keeps them. Keep their working files in a directory outside the data root: the
`takoserver` user's home is often the data root itself. These
`/v1` session, organization and API-key routes are Takoserver product APIs, not
the Takoform Host API. Use `resources:read` for read-only checks or
`resources:write` for Resource operations; write includes read. The key secret
is shown only once; keep it with the installation's other credentials:

```sh
HOST=https://api.example.com:8443
V2=$HOST/apis/forms.takoform.com/v2
read -r ASSERTION   # paste the printed assertion; it stays out of shell history
SESSION=$(jq -n --arg assertion "$ASSERTION" \
    '{provider: "google", method: "operator-assertion", $assertion}' |
  curl -sS --fail-with-body "$HOST/v1/sessions" \
    -H 'content-type: application/json' --data @- | jq -r .sessionToken)
ORG=$(curl -sS --fail-with-body "$HOST/v1/organizations" \
    -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
    --data '{"name":"My organization"}' | jq -r .organization.id)
KEY=$(curl -sS --fail-with-body "$HOST/v1/organizations/$ORG/api-keys" \
    -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
    --data '{"name":"operator writer","scopes":["resources:write"],"expiresInSeconds":86400}' |
  jq -r .secret)
```

A client that already has an organization reads its ID from `GET /v1/me`
with its session token; that route refuses an organization API key.
Then check the unauthenticated v2 discovery and the Host's readiness:

```sh
curl -sS --fail-with-body "$HOST/.well-known/takoform/v2"
curl -sS http://127.0.0.1:8787/_takoserver/health/ready
```

The readiness probe goes to the listener directly; use the address in the
`takoserver listening on` line if `TAKOSERVER_LISTEN_HOST` names another.

### 6. Seed held artifacts

The artifact Forms never upload or fetch bytes. A create names an exact HTTPS
URL and SHA-256, and the Host serves it only from bytes already in its object
store, to the organizations that `TAKOSERVER_TAKOFORM_V2_CONFIG` grants it to.
The Host reads those grants only at startup, so each new bundle takes the same
three steps: stop the Host, seed the bundle, start the Host again.

`scripts/selfhost-artifact.ts seed` is that operator step. Stop the Host
through its supervisor first. Then run the command from the checkout as the
`takoserver` user with the Host's environment, because it resolves the data
root and `TAKOSERVER_DB` exactly as the Host does:

```sh
set -a; . /etc/takoserver/takoserver.env; set +a
WORK=/var/tmp/takoserver-first-use   # outside the data root
mkdir -p -m 0700 "$WORK/hello/v1"
cat > "$WORK/hello/v1/worker.js" <<'EOF'
export default { fetch() { return new Response("hello from takoserver\n"); } };
EOF
bun --no-env-file scripts/selfhost-artifact.ts seed worker-bundle "$WORK/hello/v1" \
  --base-url https://artifacts.example.com/hello/v1/ \
  --organization "$ORG" --entrypoint worker.js \
  --config /etc/takoserver/v2/takoform-v2.json > "$WORK/hello-v1.json"
```

The command reads every regular file below the directory, in byte order of
their relative paths, and builds the Form's manifest. It checks the manifest
and files with the Form's own validator, then stores the manifest and each
file once, under its content address `operator-held/sha256/<hex>` in the
object store. It reads every entry back through the Host's held-artifact
source and prints a JSON result. `artifact` is the value for the Resource
spec, `files` is the validated file list, and `configFragment` is the exact
`TAKOSERVER_TAKOFORM_V2_CONFIG` block that grants every entry to
`org:<organizationId>` in that organization's Space. On standard error it
lists every seeded file with its media type and size, and each granted
organization with its name, so check both before restarting. With `--config`,
it also merges the fragment into that file and never changes an existing
block's `targetKey`. It replaces the file only if the file still holds what
it read, so a concurrent update is never silently lost. Without `--config`,
merge `configFragment` into the config by hand. Repeat `--organization` to
grant several organizations. Seeding the same bytes again stores nothing new
and adds no duplicate entry. Granting entries that the config already holds to
another organization needs `--add-grants` as well.

To revoke an organization's access to an artifact, remove its `org:<id>` grant
(or the whole entry) from the config and restart the Host. That stops new
Resources from acquiring the artifact. A Resource already created keeps the
bytes it copied into the control database, so delete that organization's
Resources too if it must lose them.

Before it writes anything, the command refuses these states:

- a data root that does not exist (start and stop the Host once first);
- a data root that is not owned by this user with mode 0700, or that has an
  ancestor another user can write (the rule the private planes use);
- a missing control database;
- a control database that another process is writing. The command takes the
  database's write lock (`BEGIN IMMEDIATE`) before anything else and holds it
  until it has finished, so a Host started meanwhile cannot write its control
  database: its first write waits out the busy timeout and fails;
- any other process with a file under the data root, or the control database,
  open. A running Host always has its control database open. The command reads
  the descriptor table of every process in `/proc`. It refuses when `/proc`
  does not show its own table, and when a process of its own user hides its
  table, which a non-dumpable process does (for example a `bun` given
  `cap_net_bind_service` with `setcap`). Another user's process cannot open
  files in a root private to this user and is not read. Run the command as the
  Host's user, on the Host's machine and in the Host's PID namespace, because
  processes in other PID namespaces are not in this `/proc`: for a Host in a
  container, run it inside that container (for example with `docker exec`),
  not from the machine or from another container;
- an organization the control database does not know;
- a path with a component that starts with `.`, such as `.env` or
  `.git/config`, unless `--include-dotfiles` is given. A `StaticAssetBundle`
  publishes every file, including `.well-known/` ones;
- a config that `--config` would make larger than one environment variable can
  hold, or whose directory this user cannot write;
- input the Form would reject: a symbolic link or special file, an invalid
  path, a file over the Form's size limits, a media type it cannot infer, or a
  `WorkerBundle` whose entrypoint module is ambiguous or missing. Each file is
  opened without following symbolic links and must still be the file it
  listed.

The base URL is an identity, not a location: nothing is fetched from it, and
the manifest is `<base>manifest.json` and each file `<base>files/<path>`. A
`WorkerBundle` never changes its artifact, so give each set of bytes its own
versioned base URL and create a new Bundle Resource for it.

The other two Forms use the same command. `static-asset-bundle` infers common
web media types from file extensions and uses `application/octet-stream`
otherwise. `sqlite-migration-set` accepts only `.sql` files and applies them in
the byte order of their paths, so name them `0001_...`, `0002_...`. For any
file, `--media-type <path>=<type>` overrides the inferred type. When the
config file has no block for the Form yet, `seed --config` creates it with
`targetKey` `selfhost-v2-worker-primary` for the two bundle Forms and
`selfhost-v2-sqlite-migration-primary` for migrations, unless `--target-key`
names another. Keep a block's `targetKey` stable once Resources use it.

Then start the Host again with the updated config. `verify` is read-only and
safe while the Host runs. It reads every entry of every block in the config
through the same source, and lists each entry that is missing or whose bytes
no longer match its digest:

```sh
bun --no-env-file scripts/selfhost-artifact.ts verify --config /etc/takoserver/v2/takoform-v2.json
```

### 7. Check Form support

Query support for each exact Form URL you intend to use. Proceed only when it
reports `supported: true`. Support reflects the Forms composed by this running
Host. If the Worker Forms are unsupported, read the startup diagnostics
(`workerd`, Actor and socket messages) and compare the configuration with the
complete-profile table in step 3, then restart.

```sh
F=https://edge.forms.takoform.com/forms
for form in ModuleWorker/0.3.0 WorkerBundle/0.2.0 WorkerVersion/0.5.0 \
  WorkerDeployment/0.4.0 WorkerEndpoint/0.3.0; do
  curl -sS --fail-with-body -G "$V2/support" --data-urlencode "form=$F/$form/" \
    -H "authorization: Bearer $KEY" | jq -c --arg form "$form" '{$form, supported}'
done
```

### 8. Create and serve a Worker

Each create is asynchronous: `POST /apis/forms.takoform.com/v2/resources`
accepts an Operation, which is polled until it is terminal. Set `space` to the
organization ID and send an `Idempotency-Key` of 16 to 128 characters; sending
the same request with the same key again replays the same Operation instead of
creating a second Resource. Each Form's published contract defines its spec;
there is no generic body that applies to every Form. These helpers wait for an
Operation, printing its `error` when it does not succeed, and create one
Resource and print its UID:

```sh
wait_operation() { # wait_operation <operation-id> <label>
  for _ in $(seq 120); do
    operation=$(curl -sS --fail-with-body "$V2/operations/$1" \
      -H "authorization: Bearer $KEY") || { echo "$2: $operation" >&2; return 1; }
    case $(printf '%s' "$operation" | jq -r .status) in
      succeeded) return 0 ;;
      failed) echo "$2: Operation $1 failed: $(printf '%s' "$operation" | jq -c .error)" >&2
        return 1 ;;
    esac
    sleep 1
  done
  echo "$2: Operation $1 is still $(printf '%s' "$operation" | jq -c '{status, error}')" >&2
  return 1
}
create() { # create <form> <name> <spec-json>
  accepted=$(jq -n --arg form "$F/$1/" --arg space "$ORG" --arg name "$2" --argjson spec "$3" \
      '{$form, $space, $name, $spec}' |
    curl -sS --fail-with-body "$V2/resources" -H "authorization: Bearer $KEY" \
      -H 'content-type: application/json' -H "idempotency-key: takoserver-first-use-$2" \
      --data @-) || { echo "$2: $accepted" >&2; return 1; }
  wait_operation "$(printf '%s' "$accepted" | jq -r .id)" "$2" || return 1
  printf '%s' "$accepted" | jq -r .resourceUid
}
WORKER=$(create ModuleWorker/0.3.0 hello '{}') &&
BUNDLE=$(create WorkerBundle/0.2.0 hello-bundle-v1 "$(jq -c '{artifact}' "$WORK/hello-v1.json")") &&
spec=$(jq -nc --arg w "$WORKER" --arg b "$BUNDLE" \
  '{worker: {resourceUid: $w}, bundle: {resourceUid: $b}, handlers: ["fetch"]}') &&
VERSION=$(create WorkerVersion/0.5.0 hello-version-v1 "$spec") &&
spec=$(jq -nc --arg w "$WORKER" --arg v "$VERSION" \
  '{worker: {resourceUid: $w}, versions: [{workerVersion: {resourceUid: $v}, weight: 10000}]}') &&
DEPLOYMENT=$(create WorkerDeployment/0.4.0 hello-deployment "$spec") &&
spec=$(jq -nc --arg w "$WORKER" '{worker: {resourceUid: $w}}') &&
ENDPOINT=$(create WorkerEndpoint/0.3.0 hello-endpoint "$spec")
```

Each spec is built in `spec` before the create that uses it. Do the same in
your own commands: pasted into an interactive Bash 5.2 with history (the
default shell on Ubuntu 24.04), a command substitution that is nested in
another and continues onto the next line prints `unexpected EOF while looking
for matching` errors even though the command runs.

The `&&` chain stops at the first create that does not succeed, so no later
Resource is created with an empty reference. What to do next depends on where
it stopped:

- **The POST was refused** (the helper prints a `4xx` problem). Nothing was
  stored for that request. Fix the cause and run the chain again: the creates
  that already succeeded replay their Operations under the same idempotency
  keys and print the same UIDs.
- **An accepted Operation failed, or is still not `succeeded` after the
  helper's two minutes.** Running the chain again does not retry it. For 24
  hours the same key replays that same Operation, a changed request under the
  same key is refused with `409 idempotency_conflict`, and a Resource name is
  unique within the Space across all Forms. Because the helper derives each
  key from the name, fix the cause and create the whole chain again under new
  names, for example with `-2` appended to each name. Delete the old Resources
  with step 11 once nothing references them.

A WorkerVersion, Deployment or Endpoint Operation that cannot finish stays
`reconciling` and retries; it writes nothing to the Host's output, so the
`error` the helper prints is the only diagnostic.

Keep this order. An Endpoint requested before its Worker's Deployment has
succeeded is refused with `409 dependency_conflict` (its `detail` names the
missing Deployment) and nothing is stored, so run the chain again once the
Deployment succeeded. With OpenTofu, make the Endpoint `depends_on` its
Deployment so they are not created in parallel. An Endpoint that an earlier
Host accepted out of order settles `failed` (`worker_deployment_missing`)
after the upgrade; delete it or re-apply it.

Read any Resource back with
`GET /apis/forms.takoform.com/v2/resources/{resourceUid}` using the same key.

### 9. Verify

```sh
NAME=$(curl -sS --fail-with-body "$V2/resources/$ENDPOINT" \
  -H "authorization: Bearer $KEY" | jq -r .output.hostname)
curl -sS "https://$NAME/"
curl -sS http://127.0.0.1:8787/_takoserver/health/ready
```

The Endpoint answers with the Worker's response, and readiness reports
`workerRuntime: serving` with the v2 Worker counts described below and no
`degraded` flag; [Monitoring](#monitoring) explains its backlog and background
pass sections. A restart keeps serving published Workers without a client
republish.

To ship new code, seed the new bytes under a new base URL as in step 6: stop
the Host, put the new files in `$WORK/hello/v2`, seed them, and start it again:

```sh
bun --no-env-file scripts/selfhost-artifact.ts seed worker-bundle "$WORK/hello/v2" \
  --base-url https://artifacts.example.com/hello/v2/ \
  --organization "$ORG" --entrypoint worker.js \
  --config /etc/takoserver/v2/takoform-v2.json > "$WORK/hello-v2.json"
```

Then create a new `WorkerBundle` and `WorkerVersion` and replace the
Deployment's spec. A `PUT` names the Deployment's current `generation`, read
from `GET /resources/{resourceUid}`:

```sh
BUNDLE_V2=$(create WorkerBundle/0.2.0 hello-bundle-v2 "$(jq -c '{artifact}' "$WORK/hello-v2.json")") &&
spec=$(jq -nc --arg w "$WORKER" --arg b "$BUNDLE_V2" \
  '{worker: {resourceUid: $w}, bundle: {resourceUid: $b}, handlers: ["fetch"]}') &&
VERSION_V2=$(create WorkerVersion/0.5.0 hello-version-v2 "$spec") &&
GENERATION=$(curl -sS --fail-with-body "$V2/resources/$DEPLOYMENT" \
  -H "authorization: Bearer $KEY" | jq -r .generation) &&
updated=$(jq -nc --arg w "$WORKER" --arg v "$VERSION_V2" \
    '{spec: {worker: {resourceUid: $w}, versions: [{workerVersion: {resourceUid: $v}, weight: 10000}]}}' |
  curl -sS --fail-with-body -X PUT "$V2/resources/$DEPLOYMENT" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -H 'idempotency-key: takoserver-hello-deployment-v2' \
    -H "takoform-expected-generation: $GENERATION" --data @-) &&
wait_operation "$(printf '%s' "$updated" | jq -r .id)" hello-deployment-v2
```

`tests/selfhost-v2-ordinary-journey-native.test.ts`
runs this path with real Host and workerd processes and seeds through the same
command; [the ordinary journey native test](#ordinary-journey-native-test-and-known-gaps)
describes its scope and limits.

The Bun self-host exposes two unauthenticated, no-store operational probes,
outside the Host API v1 and the shared OpenAPI route table:

- `GET /_takoserver/health/live` returns `200` while the Bun HTTP handler is
  responding. It does not query SQLite or the Worker runtime.
- `GET /_takoserver/health/ready` performs one read-only `SELECT 1` query with
  a one-second response deadline, then makes one bounded, read-only listener
  observation of the accepted legacy workerd child and, when the Host has a v2
  Worker composition, one bounded read of the v2 owners' state. It runs no
  other SQL: the backlog counts it reports are the latest sample a background
  pass took (see [Monitoring](#monitoring)). It returns `200` only when SQLite
  answered and the legacy runtime's listener is currently reachable or that
  runtime is not required; otherwise it returns `503`. v2 Worker owners, the
  backlog and background passes are reported separately (below) and, on their
  own, only mark the response `degraded`.

The readiness body contains fixed state labels and Host-wide counts, never an
identifier: `database` is `readable` or `unavailable`; `workerRuntime` is
`not-required`, `starting`, `serving`, `recovering`, `restore-failed`, or
`unavailable`; and `supervisor` is the current child lifecycle state (`idle`,
`starting`, `serving`, `recovering`, or `unavailable`). If the accepted child is
still alive but its listener probe fails, `workerRuntime` is `unavailable` while
`supervisor` remains `serving`; the fields distinguish observed service
availability from process lifecycle. v2 Worker owners supervise their own
workerd children outside that supervisor, so when the Host has a v2 Worker
composition the body also carries `v2Workers: { owners, serving, unavailable }`:
counts of opened owners, of owners whose recorded active incarnation's child
group is ready, and of owners that recorded an active incarnation whose child is
not ready (crashed or being replaced). For v2, "serving" means the owner's
supervised child holds its listener port; the probe does not send an HTTP
request to a tenant Worker, so it is not the listener reachability check
described above. An owner whose Deployment is being deleted counts as neither
serving nor unavailable.

Serving owners turn a would-be `not-required` into `serving`. One or more
unavailable owners add `degraded: true` but keep the response `200` when SQLite
answered: this probe shares its port with the control API, and one broken tenant
Worker must not make a load balancer withdraw the operator API. The `backlog`
and `backgroundPasses` sections described in [Monitoring](#monitoring) set
`degraded` the same way. Read `degraded` and the counts to alert on tenant
Workers and stuck work. The response is `503` only when SQLite did not answer,
the boot restore failed, the legacy runtime is unavailable, or the v2 owner
state could not be read within the deadline. The counts carry no Worker UID or
hostname. An empty successful boot restore with no published Workers is
`not-required`, not a failure. A failed boot restore remains `restore-failed`
for this process even if a later child passes its listener check: that check
does not prove the entire durable published graph was restored. A process
restart performs the authoritative boot restore again.

These probes are observational only: they do not call restore, spawn or ensure
workerd, stop the child, or run a product/provisioner route. The ready probe
checks the exact accepted listener around one loopback HTTP request (250 ms
request bound, 500 ms total observation bound); it does not schedule recovery.
The response contains no raw errors, paths, organization, Resource, Operation or
Worker identifiers, background pass names, or secrets. It does carry Host-wide
counts (v2 owners, stalled work, failing passes); see [Monitoring](#monitoring)
before exposing `/_takoserver/` beyond the Host. A `serving` result means this
Host's current workerd child passed the Host-owned listener readiness check; it
is not a claim that every Form, provider, or tenant Worker application is ready.
In particular, Host/control-plane readiness and application-level health remain
distinct. `GET /healthz` on the Cloudflare Worker entry is a separate runtime
surface; these Bun-only diagnostics do not change that entry or the shared
OpenAPI contract.

### 10. Bind a SQLite database

A Worker reaches a database only through a `sqliteBindings` entry of its
WorkerVersion. The Binding offers `execute`, `query` and `transaction`; it
cannot change the schema. Schema changes come from a
`SQLiteMigrationApplication`, which applies a seeded `SQLiteMigrationSet` to
an `SQLiteDatabase`. The published Forms define each spec:
[WorkerVersion 0.5.0](https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/),
[SQLiteDatabase 0.2.0](https://edge.forms.takoform.com/forms/SQLiteDatabase/0.2.0/)
and [SQLiteMigrationApplication 0.2.0](https://edge.forms.takoform.com/forms/SQLiteMigrationApplication/0.2.0/).

`sqlite-migration-set` accepts only `.sql` files and applies them in the byte
order of their paths. The first `seed --config` of a migration set adds the
`sqliteMigrationSet` block, which composes `SQLiteMigrationApplication 0.2.0`.
Stop the Host, then seed the migrations and a bundle whose code uses the
Binding, here named `DB`:

```sh
mkdir -p -m 0700 "$WORK/migrations/v1" "$WORK/hello/v3"
cat > "$WORK/migrations/v1/0001_greeting.sql" <<'EOF'
CREATE TABLE greeting (value TEXT NOT NULL);
INSERT INTO greeting VALUES ('from sqlite');
EOF
cat > "$WORK/hello/v3/worker.js" <<'EOF'
export default {
  async fetch(request, env) {
    const result = await env.DB.query("SELECT value FROM greeting ORDER BY rowid");
    return new Response("hello " + result.rows.map((row) => row.value).join(",") + "\n");
  }
};
EOF
bun --no-env-file scripts/selfhost-artifact.ts seed sqlite-migration-set "$WORK/migrations/v1" \
  --base-url https://artifacts.example.com/migrations/v1/ \
  --organization "$ORG" --config /etc/takoserver/v2/takoform-v2.json > "$WORK/migrations-v1.json"
bun --no-env-file scripts/selfhost-artifact.ts seed worker-bundle "$WORK/hello/v3" \
  --base-url https://artifacts.example.com/hello/v3/ \
  --organization "$ORG" --entrypoint worker.js \
  --config /etc/takoserver/v2/takoform-v2.json > "$WORK/hello-v3.json"
```

Start the Host and check support for `SQLiteDatabase/0.2.0`,
`SQLiteMigrationSet/0.2.0` and `SQLiteMigrationApplication/0.2.0` as in step 7.
Then create the database, apply the migrations, and ship the bundle as in
step 9 with the Binding in the new Version's spec:

```sh
DATABASE=$(create SQLiteDatabase/0.2.0 hello-db '{}') &&
MIGRATIONS=$(create SQLiteMigrationSet/0.2.0 hello-migrations-v1 \
  "$(jq -c '{artifact}' "$WORK/migrations-v1.json")") &&
spec=$(jq -nc --arg d "$DATABASE" --arg m "$MIGRATIONS" \
  '{database: {resourceUid: $d}, migrationSet: {resourceUid: $m}}') &&
APPLICATION=$(create SQLiteMigrationApplication/0.2.0 hello-migration-application "$spec") &&
BUNDLE_V3=$(create WorkerBundle/0.2.0 hello-bundle-v3 "$(jq -c '{artifact}' "$WORK/hello-v3.json")") &&
spec=$(jq -nc --arg w "$WORKER" --arg b "$BUNDLE_V3" --arg d "$DATABASE" \
  '{worker: {resourceUid: $w}, bundle: {resourceUid: $b}, handlers: ["fetch"],
    sqliteBindings: [{name: "DB", resource: {resourceUid: $d}}]}') &&
VERSION_V3=$(create WorkerVersion/0.5.0 hello-version-v3 "$spec") &&
GENERATION=$(curl -sS --fail-with-body "$V2/resources/$DEPLOYMENT" \
  -H "authorization: Bearer $KEY" | jq -r .generation) &&
updated=$(jq -nc --arg w "$WORKER" --arg v "$VERSION_V3" \
    '{spec: {worker: {resourceUid: $w}, versions: [{workerVersion: {resourceUid: $v}, weight: 10000}]}}' |
  curl -sS --fail-with-body -X PUT "$V2/resources/$DEPLOYMENT" \
    -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
    -H 'idempotency-key: takoserver-hello-deployment-v3' \
    -H "takoform-expected-generation: $GENERATION" --data @-) &&
wait_operation "$(printf '%s' "$updated" | jq -r .id)" hello-deployment-v3 &&
curl -sS "https://$NAME/"
```

`GET /resources/$APPLICATION` shows `observed.ready: true` and the applied
entries, and the Endpoint answers `hello from sqlite`.

### 11. Delete Resources

DELETE needs an `Idempotency-Key` and the Resource's current generation, like
PUT. Without a valid key it is refused with `400`; with one but without
`takoform-expected-generation`, with `428` `expected_generation_required`. A
Resource that another Resource still names is refused with `409`
`dependency_conflict`, so delete in reference order. Leave out the Resources of
steps 9 and 10 that you did not create:

```sh
remove() { # remove <resourceUid> <label>
  generation=$(curl -sS --fail-with-body "$V2/resources/$1" \
    -H "authorization: Bearer $KEY" | jq -r .generation) || return 1
  removed=$(curl -sS --fail-with-body -X DELETE "$V2/resources/$1" \
      -H "authorization: Bearer $KEY" -H "idempotency-key: takoserver-first-use-delete-$2" \
      -H "takoform-expected-generation: $generation") || { echo "$2: $removed" >&2; return 1; }
  wait_operation "$(printf '%s' "$removed" | jq -r .id)" "$2"
}
remove "$ENDPOINT" endpoint &&
remove "$DEPLOYMENT" deployment &&
remove "$VERSION_V3" version-v3 && remove "$VERSION_V2" version-v2 && remove "$VERSION" version-v1 &&
remove "$BUNDLE_V3" bundle-v3 && remove "$BUNDLE_V2" bundle-v2 && remove "$BUNDLE" bundle-v1 &&
remove "$APPLICATION" migration-application && remove "$MIGRATIONS" migration-set &&
remove "$DATABASE" database &&
remove "$WORKER" worker
```

Once the Endpoint is deleted its hostname answers `503`, and a deleted
Resource reads back as `410`. Deleting the Deployment stops the Worker's
`workerd` children, and deleting the database removes its file under
`v2-sqlite-databases/`. The Worker's owner directory under
`v2-worker-owners/` stays after the Worker is deleted. Deleting a Resource does
not remove the held bytes seeded into the object store, or their entries in
the config.

### Container Endpoint HTTPS listener

The opt-in Bun self-host Container lane can own a dedicated HTTPS listener on
TCP 443 for Container Endpoint traffic. It is Container-only: it does not front
the Bun control listener, route Worker endpoints, or change the existing
Workerd-owned Worker TLS behavior described by [ADR 0009](adr/0009-a-self-host-publishes-the-scheme-its-socket-serves.md).
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

If an earlier build ran as root, check `/tmp` first, as described under
[`/tmp` left at mode 0700](#ordinary-journey-native-test-and-known-gaps). For
each update, first make the cold snapshot described below. Stop the Bun
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

## Upgrading from v1.0.0

The published v1.0.0 release (tag `v1.0.0`, the GitHub Release of
2026-08-20) is a Takoform Host API v1-generation Host: it serves the
`v1alpha3` and `v1beta1` lanes. This source is a Host API v2 Host.
Moving from v1.0.0 to it is a breaking major upgrade: a v1.0.0 installation
that has been used is not upgraded in place, and no tool converts its records.
Install the new version alongside it, on its own data root, and leave the
v1.0.0 data root as it is.

At startup the Bun Host reads an existing control database through a read-only
connection before it writes anything. It refuses a used v1.0.0 installation:
one whose database records wallet ledger history (any funding, hold or
capture), a v1 Takoform Resource, or a v1 provider Deployment that was not
deleted. Every v1.0.0 installation that created a Resource has ledger history,
because the release's only Offering, ObjectBucket (`storage.object.standard`,
500 minor units per bucket-month), holds and captures funds. The refusal names
the data root and control database, or only the database when `TAKOSERVER_DB`
names one outside the root. It says that the database is unchanged, links to
this section, and exits with status 1. It comes before the Host creates a
missing data root, keys, sockets or runtime probes, opens the database for
writing, or opens a listener. The check repeats under the first migration's
write lock. It still assumes that every writer is stopped (step 1): a v1.0.0
process that writes after that first migration commits is not caught.

One exception to "unchanged": if v1.0.0 stopped in the middle of a transaction
and left a hot rollback journal (`control.sqlite-journal`), the read-only
connection cannot read the file. SQLite then rolls the journal back when the
Host opens the database for writing, before the check, as v1.0.0 would on its
next start. That restores the last committed state; the refusal follows.

A v1.0.0 database that was only booted, or only signed in to with Organizations
and API keys, and was never funded or used for a Resource, keeps migrating in
place. The migration keeps its Organizations, owner memberships and API key
records. After it, v1.0.0 refuses the file, because it records migrations
v1.0.0 does not know. Take the cold copy of step 1 first if you may want to
return to v1.0.0.

A v1.0.0 Bun Host configured with `TAKOSERVER_D1_DATABASE_ID` kept its control
state in that Cloudflare D1 database, not in a local file. This version's Bun
entry rejects the variable before it opens local state, and this check does
not cover D1. Do not apply this source's migrations to that database: with
`wrangler d1 migrations apply`, a v1.0.0 history with a ledger row records 0016
and then stops at 0017's `CHECK constraint failed: valid = 1`, which leaves a
database v1.0.0 no longer accepts. Leave it as it is and start this version on
a new local data root.

To move to the new version:

1. Stop the v1.0.0 Host and every writer, then make the cold copy described in
   [Cold snapshot](#cold-snapshot) of the complete v1.0.0 data root. v1.0.0
   defaults to `.takoserver` relative to its working directory. Also copy
   `TAKOSERVER_DB` if it was set outside the root. Keep the copy until the
   v1.0.0 installation is retired.
2. Prepare the new version's source in its own checkout with the
   `git worktree add` and `bun install` steps of
   [Update and code rollback](#update-and-code-rollback). Use only those steps:
   the rest of that section starts the new version on the existing data root.
   Configure it as a [first install](#first-install-and-first-use). Give it a
   new, empty `TAKOSERVER_DATA_ROOT` and, if a separate database is used, a new
   `TAKOSERVER_DB`. Never point it at the v1.0.0 root or database. Set the root
   explicitly: both versions resolve the default `.takoserver` against the
   working directory, so a shared working directory selects the v1.0.0 root.
   To run both Hosts on one machine, give them distinct `PORT` and
   `TAKOSERVER_WORKERD_PORT` values; both versions default to 8787 and 8788.
3. Sign in to the new Host and create the Organizations that will own
   Resources. Each Organization ID is a v2 Space. Mint new API keys. v1.0.0
   sessions, API keys and wallet balances are not carried over.
4. Recreate each v1 Resource through the v2 API, using a Form that the new
   instance reports at
   `GET /apis/forms.takoform.com/v2/support?form={exact-form-url}`. v1
   Resources, Operations and provider Deployments are not converted, and the
   new version does not serve, change or delete them. A v1.0.0 ObjectBucket was
   reached with S3 credentials from
   `POST /v1/organizations/{organizationId}/resources/{resourceUid}/s3-credentials`.
   The v2 `ObjectBucket 0.2.0` is registered only in the complete local Worker
   composition and is used through Worker bindings (see
   [Bun self-host Form support](takoform-v2.md#bun-self-host-form-support)).
   No tool copies objects between them. Read any data you need through v1.0.0
   while it still runs on the old root.
5. When nothing depends on the v1.0.0 Host, delete its Resources through the
   v1.0.0 API so that it releases their provider state, then stop it. A v1.0.0
   Host that was configured with a Cloudflare account kept its ObjectBuckets in
   that account, and they stay there until they are deleted.

The old release can still run on the old root. Start the v1.0.0 source (tag
`v1.0.0`, with its own `bun install --frozen-lockfile`) with the same
`TAKOSERVER_DATA_ROOT` and configuration as before. A refused start of the new
version does not prevent this, because the refusal does not write.

Earlier v2 source builds, made before this check existed, did write. On a used
v1.0.0 root they recorded `0016_takos_id_organization_projection.sql` and then
stopped with `migration 0017_wallet_credit_lots.sql failed: SQLiteError: CHECK
constraint failed: valid = 1`. v1.0.0 then refuses that database with "this
database has migrations this build does not know:
0016_takos_id_organization_projection.sql". The new version still refuses it as
a used v1 installation, and its message says that v1.0.0 refuses the file too.
To run v1.0.0 again, restore the cold copy taken immediately before that
start, following the fencing in [Restore boundary](#restore-boundary). The
failed start stopped during migration, before the Host listened, and changed
nothing but `control.sqlite`, so that copy loses only what 0016 changed.
Without such a copy there is no supported way to make the file usable by
v1.0.0 again. Do not delete the record or the tables by hand.

Measured on 2026-10-11 with the v1.0.0 tag and this source, on the local
self-host provider:

- A v1.0.0 Host was driven over its HTTP API through operator sign-in, an
  Organization, operator-signed funding, an API key and one ObjectBucket. Its
  database recorded 0001 to 0015 and three ledger rows (funding, hold and
  capture). The new version refused it. Every file's bytes and every file and
  directory mode in the data root were unchanged, and nothing was added.
- v1.0.0 restarted on that same root and served its Organization, the
  ObjectBucket and the wallet balance.
- The new version started on a new, empty root while v1.0.0 ran on the old one,
  on distinct ports.
- A booted-only and a signed-in-only v1.0.0 database migrated to the current
  head.
- A source build from before this check (commit `4d0d0450`) changed only
  `control.sqlite` in the used root, recording 0016, and v1.0.0 then refused
  it.
- After a signed-in-only v1.0.0 database migrated in place, v1.0.0 refused it
  as recording migrations it does not know.
- On a scratch SQLite file left with a hot rollback journal, a read-only
  connection failed with "attempt to write a readonly database" and left the
  file unchanged; the next writable open rolled the journal back.
- `wrangler d1 migrations apply --local` (wrangler 4.123.0) on a D1 database
  holding the v1.0.0 migrations and one ledger row recorded 0016 and then
  failed at 0017.
- `tests/v1-installation-upgrade-boundary.test.ts` repeats, with the committed
  v1.0.0 fixtures, the refusal through a read-only connection, the unchanged
  files, an external `TAKOSERVER_DB` refused before a new data root is
  created, a ledger write that lands just before the first migration lock, and
  the in-place migration.

Not measured: a v1.0.0 Host that used a Cloudflare account, Stripe funding or a
remote D1 database; whether v1.0.0 sessions and API keys still authenticate
after an unused database migrates in place; and copying object data to a v2
ObjectBucket.

## Monitoring

Poll `GET /_takoserver/health/ready` on the Host's own port (`PORT`, default
`8787`) every 10 to 30 seconds, from the machine itself or another trusted
network position. Treat its two answers differently:

- `503`, or no answer within a few seconds, means the Host cannot serve: SQLite
  did not answer, the boot restore failed, the legacy runtime is unavailable,
  or the v2 owner state could not be read. `database` and `workerRuntime` say
  which.
- `200` with `degraded: true` means the control plane serves but something
  needs an operator. The probe never withdraws the shared API port for these.

The degraded causes are reported as counts only, with no Resource, Operation,
organization, Worker or batch identifier, no pass name and no error text:

- `v2Workers.unavailable`: v2 Worker owners whose active incarnation's child
  is not ready.
- `backlog.operations`: v2 Operations that are still `queued`, `running` or
  `reconciling` and have been pending for more than `backlog.olderThanSeconds`
  (600) of this Host process's uptime: accepted that long ago, with the
  process up at least that long. Work that waited out a stopped Host is
  therefore not counted the moment the Host returns, and nothing counts during
  the first ten minutes after a start. `waitingInput` counts Operations waiting
  for their client to resupply private inputs; it is shown but does not
  degrade the Host.
- `backlog.queueExecutions.sendAuthorized`: Queue batches sent to a Worker more
  than 600 seconds ago (by the same uptime rule) and still not retired; their
  Consumer stays occupied. A Consumer whose handler, or the work it hands to
  `waitUntil`, legitimately runs longer than ten minutes is counted too.
- `backlog: "unavailable"`: no fresh sample exists. This degrades; it is not a
  503.
- `backgroundPasses.failing`: background passes (settlement, Takoform v2,
  Queue delivery, Cron, the backlog sampler and others) whose most recent run
  failed. A pass stops counting once it completes again. `stalled` counts
  passes whose current run has lasted more than 600 seconds. Which pass failed,
  and why, is only in stderr:
  `self-host background pass failed: <name>: <bounded cause>`.

The backlog counts are not read per request. A background pass samples them
every 20 seconds (the first sample is taken before the listener opens), and the
probe returns the latest sample from memory with its age in
`backlog.sampledSecondsAgo`. A sample older than 60 seconds, which means the
sampling pass has failed or stopped, is reported as `unavailable`. Each sample
reads only the unsettled Operations (settled history is never read) and does
one index seek per Queue Consumer that ever ran a batch, with query plans that
stay on those indexes after `ANALYZE` or `PRAGMA optimize`.

For example, a cron job or timer can alert on any non-zero exit of:

```sh
curl -fsS --max-time 5 http://127.0.0.1:8787/_takoserver/health/ready \
  | jq -e '.status == "ready" and (.degraded | not)'
```

There is no metrics endpoint. The probe shares the public port and is
unauthenticated, and a loopback check is not a privacy boundary behind a local
reverse proxy, so a private metrics surface would need its own listener or
operator authentication. Derive metrics from the ready body with an existing
prober instead (for example a JSON exporter).

Block `/_takoserver/` at the reverse proxy by default and poll it on the Host's
own port; with the default `TAKOSERVER_LISTEN_HOST` (`127.0.0.1`) only a local
prober or a local reverse proxy reaches it. The probe carries no identifiers or
secrets, but its Host-wide counts show how much work the Host has and whether
it is keeping up; forward the path only to a load balancer or monitor that
needs it.

The serving supervisor writes bounded child-exit, automatic-restart attempt and
delay, and recovery-success diagnostics through its existing log callback (the
Bun entry forwards these to stdout). New recovery messages contain no config
path or arbitrary child error text; deliberate stops and stale children are
not reported as crashes. A failure to write these diagnostics does not stop
runtime recovery. Collect stdout and stderr and configure alerts on them as
well: these messages and the probe are not a monitoring service or proof of
operator recovery.

## Backup and restore preparation

This procedure prepares a cold copy of one Bun self-host installation. It is
not a tested disaster-recovery guarantee: the repository has no operator
snapshot/restore command, no restore mode that suppresses startup work, and no
full live-operator restore drill. The tests below cover local readers, and the
ordinary journey native test restores a cold snapshot of a v2 installation
(Worker, SQLite, Queue) to the same root; neither replaces an operator recovery
drill.

## What belongs to one installation

Back up the complete configured `TAKOSERVER_DATA_ROOT` as one unit (default:
`.takoserver`). Do not assemble a backup from a hand-picked list of files. The
root contains the local control database by default, object bytes and their
metadata (including the held artifact bytes an operator seeded for the v2
Forms), customer SQL databases, published Worker bundles and active deployment
data, the v2 Worker owners' incarnation state, the v2 SQLite, KV and
ObjectBucket custody, self-host resource and event state, runtime probes, and
the private keys the Host generated for itself (`operator-key.jwk`,
`signing-key.jwk`, and a tenant-run signing key when that feature is enabled).
Paths such as `objects/`, `databases/`, `workers/`, `selfhost/`,
`v2-worker-owners/`, `v2-sqlite-databases/`, `v2-kv-namespaces/`,
`v2-object-buckets/` and `runtime-probes/` are implementation details;
retaining the whole root also retains paths added by later versions.
`runtime-probes/` holds the verified copy of the `workerd` binary, so even an
almost empty installation's copy is about 270 MB.

`TAKOSERVER_DB` can put `control.sqlite` outside the data root. If it is set,
that exact database is part of the backup set too. A backup is incomplete if
either the root or that database is missing.

The running configuration also depends on material outside the root. Record
the exact service configuration and protect, through the operator's own
protected mechanism, every external value and file needed to recover the same
identity and capabilities. For the current v2 entry that includes:

- `TAKOSERVER_TAKOFORM_V2_CONFIG`, verbatim. It names no files, but its
  `heldArtifacts` entries name the object keys, digests and grants of bytes
  that were seeded into the object store under the data root: the root backup
  carries those bytes, and only this exact JSON makes the restored Host serve
  them. Removing a Form block or held entry that Resources or Operations still
  use is not a restore (see [Takoform v2 operator setup](takoform-v2.md)).
- `TAKOSERVER_TAKOFORM_V2_CURSOR_KEY`. The Host refuses to start without it. A
  different key loses no data, but every pagination cursor a client holds stops
  being accepted.
- `TAKOSERVER_V2_WORKER_PRIVATE_PLANES`, verbatim, and every file and
  directory it names. Each selected plane's `signingKeyFile` is raw key
  material the Host never generates and may live outside the root; restore it
  unchanged, owner-private, at the same absolute path. Published Worker
  incarnations carry binding grants signed with these keys, and a restore with
  different keys is not exercised. The SQLite plane's `stagingRoot` must exist
  as an owner-private directory before start, but it holds only transient
  per-call staging, so it needs no backup. The custody roots themselves are the
  `v2-*` directories under the data root.
- The other v2 selections (`TAKOSERVER_V2_WORKER_RUNTIME_BOOT`,
  `TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS`), ports, and suffixes, as recorded
  configuration.
- TLS certificate/private-key files, `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING`,
  operator-supplied signing keys, and configured provider, payment, identity,
  or AI credentials.
- The exact native binaries. `TAKOSERVER_WORKERD_BINARY` must still resolve to
  the exact accepted artifact for Worker execution; the selected snapshot is
  retained under the data root, but startup validates and selects from the
  configured input path. When Workflow boot is selected,
  `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY` is likewise outside the root.

Do not put secret values in this repository or in a backup manifest. Keep
external configuration and secrets at least as carefully as the data root; the
database and files contain customer and credential-bearing state.

Some paths exist only while a Host runs and are not part of the backup set:

- `/tmp/tw-*` (always `/tmp`, not `TMPDIR`): one private Unix-socket directory
  per v2 Worker incarnation, named by a hash of the owner directory's path, the
  Worker UID and the Operation ID. It holds only sockets. A suspended or killed
  incarnation keeps its directory until recovery reuses it, and recovery
  creates it again when it is missing. No native test exercises that; a
  clean-room install on 2026-10-11 restarted a restored root after moving its
  `/tmp/tw-*` directory away, as `PrivateTmp=yes` does at every stop, and the
  Host recreated it and served the Worker again. Do not copy or
  restore these directories. On a shared machine leave a live installation's
  ones in place: if another local user creates the same name, recovery refuses
  it with `ownership_uncertain`. Deleting a data root leaves its `/tmp/tw-*`
  directories behind.
- `<data root>/s/`: per-incarnation listener directories for the Actor and
  Workflow runtimes. A copy of the root may contain them; they carry no state,
  and boot removes the ones whose abandonment it proves.
- `$TMPDIR/tactor-*`: socket directories of native Actor namespace processes.

## Cold snapshot

1. Choose a protected destination with enough free space for the whole root and
   any external `TAKOSERVER_DB`. Use a destination that is not served by the
   source host.
2. Stop the Takoserver service through its actual supervisor and wait until
   `entry-bun.ts`, all of its `workerd` children (the legacy runtime and each v2
   Worker owner's), any Workflow execution guard, and any other process
   configured to write this data have exited. A graceful stop is not enough
   until all writers are gone. The Bun entry starts queue delivery and cron
   timers and restores published Workers automatically at startup; there is no
   read-only boot switch for a copy.
3. With the installation quiescent, make a filesystem copy of the complete
   data root to the protected destination, preserving file contents,
   directories, hard links, ownership, and restrictive permissions (for
   example with `cp -a`). If `TAKOSERVER_DB` is outside the
   root, copy its main file and any existing SQLite `-wal`, `-shm`, or rollback
   journal sidecars in the same stopped window. Do not copy a live SQLite file,
   copy only its main file while sidecars may be changing, or guess which
   sidecars can be omitted. Do not copy the runtime-only socket directories
   listed above. This procedure intentionally requires a stopped-and-quiescent
   installation rather than promising a live snapshot.
4. Record outside the secret-bearing files which source instance and time the
   copy represents, the resolved data-root and database paths, the product
   commit, and the configured external dependency references needed to locate
   recovery material, including the private-plane key-file paths and the
   `stagingRoot`. Do not record credentials themselves.
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
to the intended replacement, reinstate its protected configuration and required
secrets (including the exact v2 configuration, the cursor key, the private-plane
key files at their configured paths, and an existing private `stagingRoot`), and
verify that only the replacement owns the installation's network identity before
starting it. Keep the same `TAKOSERVER_DATA_ROOT` value: SQLite database records
carry the configured root, and the v2 owners' socket namespaces are derived from
the owner directory's path. Only a restore to the same path on the same machine
is exercised. Use a product build that understands the database's recorded
migration history: SQLite upgrades are forward-only, and a build that does not
know a recorded migration refuses the database rather than downgrading it. A
restart may deliver queued work; treat that as resuming the installation, not as
a no-write restore check. If source fencing, ownership of the public identity,
or the fate of pending operations is uncertain, leave the restored copy stopped
and resolve that uncertainty before activation.

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

An earlier optional native test drove a v1 Worker graph through a cold restore
on the retired v1 Host API. The current entry cannot start it, so it was
removed; the ordinary journey below is the native cold-restore evidence now.
Two things only that test measured are not measured on the current entry: a
restore that also copies an external `TAKOSERVER_DB` and external TLS files in
the same stopped window, and replacement of a killed Worker child without a
Host restart (it measured the legacy runtime supervisor; no native test here
kills a serving v2 Worker owner's child and waits for its replacement).

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
takes a cold snapshot as in steps 2-3 of the cold snapshot below (stop every
writer, copy the complete root with `cp -a`) while the Queue is drained and no
Operation is pending, deletes the original root entirely, restores the copy to
the same configured root and boots it, then checks that the Worker serves its
last Version without a client republish, its SQLite rows and the Deployment
readback are exactly as they were at the snapshot, and a new message is handled
once by the restored Version with nothing older redelivered; and finally
deletes everything in reference order,
with a refused premature delete on the way, and checks the artifact tables,
the SQLite directory, the workerd children and TCP 443.

This is a local, loopback, single-host result with a self-signed certificate
and operator-seeded artifact bytes. It runs as the invoking user with `HOME`
and `TMPDIR` inside the data root, talks to the control listener directly
rather than through a TLS front end, and so does not exercise a dedicated
service user or a shared `/tmp`. A clean-room install on 2026-10-11, in a
fresh Ubuntu 24.04 container as a dedicated user and following this guide,
found that every WorkerVersion stayed `reconciling` there because module
inspection tried to chmod `/tmp`; that is fixed. A second clean-room run on
the fixed source, with no `TMPDIR` set, settled every WorkerVersion at once and
left `/tmp` at mode 1777. The test's restore is to the same
path on the same machine. Its TLS files, signing and operator keys are inside the root and
are lost and restored with it; the environment (paths, port, keyring, v2
configuration) and the workerd and guard binaries outside the root are
unchanged. The runtime owner's private socket directory lives under `/tmp`,
outside the root, so it survived; a restore onto a machine without it is
handled by the code but not exercised here. It is not a restore with pending
work, to a different path or machine, of an external `TAKOSERVER_DB`, or an
operator disaster-recovery drill with source fencing. It does not cover a `scheduled`
handler, Actor or Workflow use, public DNS or certificate trust, Hosted/WfP or
a host reboot. Messages in flight at the
crash are redelivered at least once. A batch the killed Host reserved but never
sent is refused when the Host starts again, before it listens, and its messages
come back at once. That holds when the refusal succeeds: if it gives up (a lock
that outlasted the five second busy timeout, for example), that batch and any
not yet refused wait for their 120 second reservation as before. The refusal
needs no proof that the old process is gone: it is the pre-send cancel, which
can only win while the batch has not been authorized, and the owner sends only
after winning that authorization. A batch that was already sent is different.
It must first be retired, by its handler's completion receipt or by proof that
its Worker child is physically gone, and only then are its messages redelivered
once their lease (up to 120 seconds) runs out. After a Host restart the old
child is gone and that proof is normally available; a sent batch whose
retirement cannot be proven stays occupied, with no time limit.

**`/tmp` left at mode 0700 by an earlier build.** Before that fix, a build
that ran as root without `TMPDIR` set and without a private `/tmp` (systemd
`PrivateTmp=yes`) set the machine's `/tmp` to mode 0700 the first time it
inspected a Worker module, which locks every other user out of `/tmp`. On such
a machine, check it as root and restore the standard mode:

```sh
stat -c %a /tmp     # 1777 is the standard mode
chmod 1777 /tmp
```

A build run as a dedicated user could not change `/tmp`; there its
WorkerVersions stayed `reconciling` instead, and they settle on a later retry
once inspection can run.

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
  - *Killed inside a state write.* The owner state and each execution group's
    manifest and retirement receipt are written to a temporary and renamed
    into place, so a kill that lands inside such a write leaves the temporary
    behind (`runtime-owner.json.<uuid>.tmp`, or `.retirement-<uuid>` in a
    group directory). It never became state. A stale-owner takeover discards
    it before the namespace inventory; earlier releases refused that boot
    with `ownership_uncertain` on every later start. Only that exact name as a
    private, singly linked regular file is discarded; a symbolic link, a file
    other users can read or any other unknown entry is still refused (tests
    for each).

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
  measured), a Deployment or Endpoint backend answers `unknown` for a refusal
  before it reaches the owner that may still clear (an unresolved graph, a
  `publication_conflict`), so such an Operation stays `reconciling` and keeps
  retrying: boot is not blocked, because the owner vouches it never served,
  but the Worker's Endpoint is not served until the Operation is settled.
  Once it has been pending for ten minutes of Host uptime, readiness counts it
  under `backlog.operations.reconciling` and reports `degraded` (see
  [Monitoring](#monitoring)). A refusal of the Operation's own precondition
  settles instead, `failed` with effect `none` (engine tests with the real
  Deployment and Endpoint backends pin this). An Endpoint create or update
  whose Worker has no active Deployment fails with `worker_deployment_missing`.
  One whose weighted Versions declare neither `fetch` nor assets, or a
  Deployment change that would leave an attached Endpoint with such a Version,
  fails with `worker_fetch_handler_missing`. Later Operations for the Worker
  then no longer wait behind it, and the failed Resource can be deleted or
  re-applied.
  An Endpoint without such a Deployment is now refused at acceptance with
  `409 dependency_conflict` and a `detail` that names the missing Deployment
  (measured on the native Endpoint lane), so an Endpoint reaches this path
  only if an earlier Host accepted it.

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
  cause (including a Queue batch selection that threw), and a Queue
  reservation that was never sent is refunded with retries bounded to one
  second in total before it falls back to its 120 second expiry.
  A refund whose lock outlasted the five second wait is not retried, because
  each attempt would block the Host for that long again. A Queue batch whose
  handler finished but whose retirement failed this way is different: its
  Consumer would stay occupied until the next restart, so the same handler
  receipt is retried on later delivery passes, after 1, 2, 4 ... seconds and at
  most once a minute. Do not read the live database anyway; stop the Host
  first.
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

The former package-admission procedure is neither the current v2 install path
nor a current v2 support signal. The native tests that drove it against the
v1 Host API were removed once the current entry could no longer start them.
