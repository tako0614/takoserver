# Running the Bun provisioner

Production Cloudflare execution is provisioned from the Worker itself; see
[ADR 0001](adr/0001-provision-from-the-worker.md). Set its zones on the reviewed
deploy target and keep its scoped token in the Worker secret. The Bun entry is
a different composition: it always executes current Provider3 Edge Forms on
the local workerd-backed provider.

The Bun process can expose that provider through one authenticated endpoint for
an explicitly composed external control-plane client. A provider call enters,
and a classified ticket leaves. No current official Takoserver Worker composes
that remote client. Generic Cloudflare credentials may let the process share
R2 or an explicitly configured standard-service supply; control state remains
local SQLite, and they never switch current Worker execution from workerd to
Cloudflare.

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

- Account · Workers R2 Storage · Edit, only when an R2 artifact store, stable S3
  supply, or the retired ObjectBucket drain is selected.

The ordinary Bun stable provider does not need Workers Scripts, Workers Routes,
or DNS permission. Production Cloudflare Worker execution and its zone
authority belong to `src/entry-worker.ts`.

`TAKOSERVER_CF_TOKEN_FILE` may be used instead of `CLOUDFLARE_API_TOKEN`: the
file is read at the moment of each call, so a rotation does not need a restart.

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
