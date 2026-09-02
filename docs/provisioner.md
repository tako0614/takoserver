# Running the Bun provisioner

Production Cloudflare execution is provisioned from the Worker itself; see
[ADR 0001](adr/0001-provision-from-the-worker.md). Set its zones on the reviewed
deploy target and keep its scoped token in the Worker secret. The Bun entry is
a different composition: it always executes current Provider3 Edge Forms on
the local workerd-backed provider.

The Bun process can expose that provider through one authenticated endpoint for
an explicitly composed external control-plane client. A provider call enters,
and a classified ticket leaves. No current official Takoserver Worker composes
that remote client. Generic Cloudflare credentials may let the process share an
R2 artifact store; control state remains local SQLite, and they never switch
current Worker execution from workerd to Cloudflare or authorize a public
storage product.

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
| `TAKOSERVER_WORKERD_BINARY` | Optional explicit workerd binary. |
| `TAKOSERVER_WORKER_ENDPOINT_SUFFIX` / `TAKOSERVER_SUFFIXES` | Addresses the local provider may issue. |
| `TAKOSERVER_R2_BUCKET` | Optional artifact store shared with the Worker. Requires a Cloudflare account and token source. |
| `TAKOSERVER_OPERATOR_PUBLIC_JWK` | Public half of the operator key. |
| `TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK` | Optional login-only operator key; never authorizes funding. |
| `PORT` | Where to listen. |
| `TAKOSERVER_DATA_PLANE_PORT` | Optional fixed port for the loopback KV/SQL data planes. Without it the kernel picks one and the process prints it. |

`CLOUDFLARE_ACCOUNT_ID` is storage/control-plane input only in this mode. It is
not provider-selection authority. `TAKOSERVER_D1_DATABASE_ID` is not supported
by the Bun entry: it is rejected before any local directory, database, or key is
opened because the D1 HTTP API cannot provide the atomic batch capability the
control plane requires. `TAKOSERVER_ZONES` is rejected because DNS and
Worker-route authority belongs to the production Worker entry. The retired
implicit `TAKOSERVER_EDGE_FORMS` switch is rejected as well.

### The Cloudflare token

Use a token created for the exact optional adapter, not a `wrangler login`
session. Grant only what the selected Bun inputs use:

- Account · Workers R2 Storage · Edit, only when an R2 artifact store or the
  retired ObjectBucket drain is selected.

The ordinary Bun stable provider does not need Workers Scripts, Workers Routes,
or DNS permission. Production Cloudflare Worker execution and its zone
authority belong to `src/entry-worker.ts`.

`TAKOSERVER_CF_TOKEN_FILE` may be used instead of `CLOUDFLARE_API_TOKEN`: the
file is read at the moment of each call, so a rotation does not need a restart.

## Worker storage on this machine

A Worker Version that declares `kvBindings`, `queueProducerBindings`, or
`sqliteBindings` needs a backend, and a machine standing on its own has to be
one. Three small HTTP services provide it: KV entries and queue messages live in
the control database under migrations 0038 and 0039, and each `SQLiteDatabase`
is a file under `<data root>/databases`.

They are served on their own listener, bound to `127.0.0.1`, never on `PORT`.
What authenticates there is a bearer token minted per Worker Version, and a
route on the public origin would make that token an internet-facing credential
for arbitrary SQL on this machine. `TAKOSERVER_DATA_PLANE_PORT` fixes the port
when an operator needs a stable one; otherwise the kernel chooses and the
process prints `self-host data planes listening on 127.0.0.1:<port>` at startup.

### What workerd is given

Publishing a Version with data bindings generates two modules and renders three
services for one script:

| Service | What it runs | What it holds |
|---|---|---|
| `<script>` | The generated entrypoint plus the tenant's main module | The Version's own `vars`, and a plain service binding to `<script>-selfhost-data` |
| `<script>-selfhost-data` | A Takoserver-owned facade module, no tenant code | The Version's plane token and a service binding to the origin below |
| `<script>-selfhost-data-origin` | Nothing; an `externalServer` | The loopback address of the planes |

A Worker with a Queue Consumer or a Cron Trigger attached gets one more:

| Service | What it runs | What it holds |
|---|---|---|
| `<script>-selfhost-events` | A Takoserver-owned gate module, no tenant code | The Version's event token, and a service binding naming the script's `takoserverSelfhostEvents` entrypoint |

The split is the isolation. A binding belongs to the service it is declared on,
and workerd hands every one of them to every module that service runs —
including through `import { env } from "cloudflare:workers"` — so a value left
out of a projected `env` was never hidden. The tenant's service therefore
declares no token and no address. The facade rewrites every request it is
handed into a fixed method, one of two fixed URLs, and two fixed headers, so a
service binding that leaked into tenant code reaches those two routes and
nothing else on this machine. `disallow_importable_env` is set on the tenant's
service as well, which is the second lock rather than the first.

Publishing also asks the published services, over the workerd router, whether the
tenant's module exports every handler the Version declared. A module that does
not is refused there rather than accepted and drained of its first event. The
probe is best effort: when no runtime answers — a composition that serves
workerd elsewhere, or one that is still starting — the publication proceeds.

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

The event itself is the managed backend's envelope, unchanged:
`takoserver.managed-worker-event@v1`, posted to
`/.well-known/takoserver/managed-worker-events/v1` with the same content types.
A Worker's `queue` handler therefore receives the same portable batch here as on
Cloudflare — `acknowledge` / `retry` / `acknowledgeAll` / `retryAll`, bodies as
`{encoding: "base64", data}` — and `scheduled` the same `{cron, scheduledTime}`.
Two things differ and are named rather than hidden: `logicalWorkerId` and
`deploymentId` are the workerd script name and the exact Worker Version, which
are the only such identities this Host has; and where the managed wrapper trusts
`ctx.props` that only a dispatch namespace can set, this one trusts a gate.

That gate is the reason the delivery cannot be forged. workerd's router forwards
by `Host`, and anything that can reach the runtime's port can name a hostname —
so an event hostname that reached the script itself would let any such caller
invoke another tenant's `queue` handler. Instead `<script>.selfhost-events.invalid`
reaches `<script>-selfhost-events`, a Takoserver-owned service running one
constant module, which compares a per-Version token in constant time and rewrites
the request into a fixed method, URL, and header set before forwarding it to the
script's `takoserverSelfhostEvents` export. That export is a *named* entrypoint:
the router hands customer traffic to the default one, so a request to the event
path at the Worker's own hostname reaches `fetch`, which does not know what an
event is. The token is declared on the gate and nowhere else, exactly as the
plane token is declared on the data facade.

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
  again, so a handler may see a message twice. At-least-once is the contract.

### What a Cron Trigger's schedule means here

Five UTC fields, exactly the Form's grammar: minute, hour, day-of-month, month,
day-of-week, each a comma-separated list of `*`, a literal, `low-high`,
`*/step`, or `low-high/step`. Names and a step on a bare literal are refused, and
so is an expression this Host cannot read — at apply, rather than by recording a
trigger that would never fire.

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
refused rather than half-served; publishing a new Version is what changes that.

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
