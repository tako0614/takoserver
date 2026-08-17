# Running the provisioner

Takoserver is two halves.

The half on Workers answers the public API. It holds no cloud account
credential, and `scripts/check-imports.ts` proves it cannot acquire one: the
Cloudflare provider and both HTTP transports are unreachable from its import
graph. That is the whole reason the other half exists.

The other half provisions. It runs wherever you choose, holds the account
credential, and answers exactly one path — a provider call in, a classified
ticket out. Until it is running and reachable, an apply against the public API
answers `backend_unavailable`, which is honest: there is nothing to provision
with.

## What it needs

| Variable | What it is |
|---|---|
| `TAKOSERVER_PROVISIONER_TOKEN` | Shared credential. The same value goes on the Worker as a secret. Without it the provisioning path is not served at all. |
| `CLOUDFLARE_ACCOUNT_ID` | The account to provision in. |
| `CLOUDFLARE_API_TOKEN` | A **scoped API token** — see below. |
| `TAKOSERVER_D1_DATABASE_ID` | The control database, shared with the Worker. |
| `TAKOSERVER_R2_BUCKET` | The artifact store, shared with the Worker. |
| `TAKOSERVER_ZONES` | JSON array of the DNS zones this deployment may attach Workers to. |
| `TAKOSERVER_OPERATOR_PUBLIC_JWK` | Public half of the operator key. |
| `PORT` | Where to listen. |

### The Cloudflare token

Use a token created for this purpose, not a `wrangler login` session. A session
token expires roughly hourly, and every call fails at once when it does — with
an authorization error that says nothing about age. The permissions the
provisioner actually uses:

- Account · Workers Scripts · Edit
- Account · Workers R2 Storage · Edit
- Account · D1 · Edit
- Zone · Workers Routes · Edit (on the zones you serve)
- Zone · DNS · Edit (on the zones you serve — attaching a Worker to a hostname
  writes the record)

Nothing else. A token that can do more is a token that can do more when
something goes wrong.

`TAKOSERVER_CF_TOKEN_FILE` may be used instead of `CLOUDFLARE_API_TOKEN`: the
file is read at the moment of each call, so a rotation does not need a restart.

## Reachability

The Worker calls the provisioner over the public internet, so it needs an
address Cloudflare can resolve. A Cloudflare Tunnel from the host it runs on is
the least exposed way to do that — the provisioner never listens on a public
port, and the tunnel terminates at Cloudflare.

The provisioning path refuses anything without the shared credential and
answers `404` rather than `403` when no credential is configured, so a scanner
does not learn there is a provisioner behind the address. That is a second
line, not the first: put it behind a tunnel.

## systemd

```ini
[Unit]
Description=Takoserver provisioner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/takoserver
EnvironmentFile=/etc/takoserver/provisioner.env
ExecStart=/usr/local/bin/bun src/entry-bun.ts
Restart=always
RestartSec=5
# The credential lives in the environment file, which only root may read.
User=takoserver
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/takoserver/provisioner.env` holds the variables above, `chmod 600`.

Restarting is safe at any moment. Every mutation is driven by an operation
record with a stable id, so a call interrupted mid-flight is retried against the
same identity rather than duplicated.

## Telling the Worker where it is

The address is public and belongs in the deploy target beside the account:

```json
{ "provisionerOrigin": "https://provisioner.example.com" }
```

The credential is not, and is set separately:

```
wrangler secret put TAKOSERVER_PROVISIONER_TOKEN --config .wrangler-realized.jsonc
```

Then `bun run deploy -- --apply`. A configuration change publishes on its own —
the evidence ledger records the realized configuration as well as the bundle, so
turning this on does not report itself as already deployed.
