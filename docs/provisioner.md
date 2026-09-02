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

A Worker Version that declares `kvBindings` or `sqliteBindings` needs a backend,
and a machine standing on its own has to be one. Two small HTTP services provide
it: KV entries live in the control database under migration 0038, and each
`SQLiteDatabase` is a file under `<data root>/databases`.

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

The split is the isolation. A binding belongs to the service it is declared on,
and workerd hands every one of them to every module that service runs —
including through `import { env } from "cloudflare:workers"` — so a value left
out of a projected `env` was never hidden. The tenant's service therefore
declares no token and no address. The facade rewrites every request it is
handed into a fixed method, one of two fixed URLs, and two fixed headers, so a
service binding that leaked into tenant code reaches those two routes and
nothing else on this machine. `disallow_importable_env` is set on the tenant's
service as well, which is the second lock rather than the first.

Publishing also asks the published pair, over the workerd router, whether the
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

### What is not here yet

`queue` and `scheduled` handlers a Version declares are re-exported by the
generated entrypoint, but this Host renders no queue producer, no consumer, and
no cron trigger — nothing invokes them. When something does, note that the
self-host wrapper would hand workerd's raw event to the tenant while the managed
wrapper projects a portable batch with `ack`/`retry`; closing that gap is part
of making the events real, not a separate fix.

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
