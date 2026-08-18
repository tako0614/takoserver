# Takoserver

A self-hostable platform for [Takoform](https://takoform.com). Customers
declare infrastructure — object buckets, SQL databases, Workers — and Takoserver
provisions it, serves it, and bills for it.

Run it on your own machine and it uses your disk and [workerd](https://github.com/cloudflare/workerd),
the runtime Cloudflare runs at the edge. Point it at a Cloudflare account and it
uses R2, D1, and Workers instead. Nothing above the provider knows which.

```
bun install
bun src/entry-bun.ts
```

That is the whole first run. It creates its schema, generates the keys it signs
with, prints a sign-in you can paste into its console, and starts serving.

## What it is

Takoform is an infrastructure protocol: a customer declares what they want, and
a Host accepts, prices, provisions, and reports on it. Takoserver is a Host —
the part that owns accounts, money, and the machines.

- **Declare** through the Takoform lanes. Every declaration names a Form by an
  exact reference: group, kind, definition version, and the digest of the
  schema itself. Two resources of the same kind are not necessarily the same
  thing, and the digest is what says so.
- **Pay** from a prepaid wallet. Work places a hold against the available
  balance and captures it when it succeeds; if it fails, the hold is released
  and nothing is charged. There is no balance column anywhere — available is
  settled minus held, computed from entries that are only ever appended.
- **Reach** what you provisioned. A bucket is not a name in a list: a
  short-lived token scoped to one resource opens its data plane.

## Self-hosting

Everything lives under one directory, `.takoserver` by default.

| Variable | What it does |
|---|---|
| `TAKOSERVER_DATA_ROOT` | Objects, databases, published Workers, and the signing key. |
| `TAKOSERVER_DB` | Control database. A file under the data root by default. |
| `PORT` | Where the API and console API listen. |
| `TAKOSERVER_WORKERD_PORT` | Where published Workers are served. |
| `TAKOSERVER_SUFFIXES` | Hostname suffixes this deployment will serve. Empty means any. |
| `TAKOSERVER_OPERATOR_PUBLIC_JWK` | Public half of the operator key. Generated under the data root if unset. |
| `GOOGLE_CLIENT_ID` | Turns on Google sign-in. Its absence leaves the operator path. |
| `STRIPE_SECRET_KEY` | Turns on card payment. Its absence leaves operator-signed funding. |

Nothing in that table is required to start. What is absent is absent rather than
faked: a deployment with no Stripe key does not serve the route that would begin
a payment, and its console offers the way it does take money instead.

Sign-in and money are the two facts a server cannot determine for itself. With
no identity provider configured, the operator answers the first by signature —
so a fresh machine mints an operator key, keeps it beside its database, and
prints an assertion good for ten minutes. Later ones:

```
TAKOSERVER_OPERATOR_KEY=.takoserver/operator-key.jwk \
  bun scripts/operator-key.ts sign-in google operator operator@localhost Operator
```

The same key credits the wallet (`operator-key.ts funding <org> <ref> <minor>`)
until Stripe is configured. It is the operator vouching in a form the server can
check and nobody else can forge — not an identity provider, and it stops being
the way in the moment a real one is configured.

Everything durable is under that one directory, so backing up a deployment is
copying it and moving one is moving it:

```
.takoserver/
  control.sqlite      organizations, keys, the ledger, resources
  signing-key.jwk     signs data-plane tokens
  operator-key.jwk    signs operator assertions
  objects/            customer objects, and uploaded bundles under art/
  databases/          customer SQL databases
  workers/            published Workers and the workerd config
```

Published Workers are served by a workerd process Takoserver starts on the first
publish and leaves watching its configuration — a deploy rewrites the config,
and no other tenant's in-flight requests are dropped for it. A machine with no
workerd binary says so once and keeps serving storage and databases.

## Running it on Cloudflare

Set `CLOUDFLARE_ACCOUNT_ID` and a scoped API token, and the same server
provisions R2 buckets, D1 databases, and Workers in that account instead. The
control plane itself can also run as a Worker; `bun run deploy -- --contract`
describes what publishing that involves and what it refuses to do.

See [docs/adr/0001-provision-from-the-worker.md](docs/adr/0001-provision-from-the-worker.md)
for why the deployed Worker holds the account credential, and what that costs.

## How it is built

Five ports, and everything above them is provider-neutral.

| Port | Implementations |
|---|---|
| `Sql` | SQLite, D1 binding, D1 over HTTP |
| `ObjectStore` | filesystem, R2 binding, R2 over HTTP, memory |
| `Provider` | local, workerd, Cloudflare, a remote provisioner |
| `ExternalIdentityVerifier` | Google ID tokens, operator signature |
| `FundingSettlementVerifier` | Stripe, operator signature |

`scripts/check-imports.ts` enforces the layering as a gate rather than a
convention: core, adapters, domain, routes, composition, entries — and a
per-entry ban, so the Workers entry cannot reach a filesystem it does not have.

Three properties are worth knowing before reading the code:

**Shipped Form definitions are frozen.** A Form's identity includes the digest
of its schema, so changing one mints a different Form and strands every resource
that named the old one — still running, still billing, no longer addressable.
The digests are pinned by a test. Adding a line to it is how a definition ships;
changing one is not.

**Guarded writes, not transactions.** The control database may be D1, which has
no interactive transaction, so invariants live in `WHERE` clauses and are
verified by counting the rows a write actually changed. A hold that cannot be
covered is not written at all.

**Failure is a value.** A provider returns a classified ticket rather than
throwing, so the engine, the ledger, and the operation record all see the same
outcome. A credential *we* misconfigured is never reported to a customer as
their permission problem.

## Working on it

```
bun run check     # format, lint, layering, types, tests, builds
bun run fmt       # the only thing that rewrites source
```

`bun run check` is the gate. It is read-only and it does not skip.

## Licence

[GNU Affero General Public License v3.0](LICENSE).

Run it, host it, change it, sell it. The one obligation is the one that matters
for something people reach over a network: if you offer a modified takoserver as
a service, its users are entitled to your modifications. Self-hosting for
yourself carries no such duty.
