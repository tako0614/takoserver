# Takoserver

An Open Source, Self-Hostable PaaS with a [Takoform](https://takoform.com) Host
for declarative infrastructure and ordinary data APIs for already-standardized
services. Today its shipped infrastructure catalog is the exact ObjectBucket
Form carried by the released Takoform provider. Object access and
OpenAI-compatible AI inference are data services, not locally invented Forms.

ObjectBucket lifecycle stays in Takoform, while the standard data path is `POST
/v1/organizations/{organizationId}/resources/{resourceUid}/s3-credentials`.
It returns a short-lived bucket-scoped access key, secret, and session token
that an ordinary AWS SDK, CLI, or other SigV4 S3 client uses against the
returned endpoint. That does not create another Form.

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
- **Attach** independent resources by exact Interface reference. An Attachment
  stores only resource/deployment identity and an opaque grant, endpoint,
  secret, or native-binding reference; it never embeds a provider credential.
- **Migrate** by selecting another Offering for the same exact Form. Takoserver
  provisions a candidate Deployment, transfers and verifies the data, then
  atomically switches the active Deployment and Attachment resolutions. The
  source stays retained for the bounded rollback window.
- **Infer** through `/v1/ai`. An organization API key with `ai:invoke` sees only
  operator-configured public model IDs. Takoserver holds the maximum prepaid
  charge before inference, captures reported token use, and releases the rest.
  Paid inference requires `Idempotency-Key`; a settled result is replayed from
  durable state without calling the upstream or charging again.

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
| `TAKOSERVER_AI_BASE_URL` | HTTPS base path of an OpenAI-compatible upstream. |
| `TAKOSERVER_AI_MODELS` | JSON allowlist mapping public model IDs to upstream IDs, limits, and retail token prices. |
| `TAKOSERVER_AI_TOKEN_FILE` | Preferred rotatable upstream bearer secret file. |
| `TAKOSERVER_AI_TOKEN` | Direct upstream bearer secret when a file is not used. |

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

A Worker that declares static assets gets them: the files are served ahead of
the script through an `ASSETS` binding, and `notFoundHandling` decides what an
unmatched path means, so a single-page application survives a reload here the
same way it does on Cloudflare.

## Running it on Cloudflare

Set `CLOUDFLARE_ACCOUNT_ID` and a scoped API token, and the same server
provisions R2 buckets, D1 databases, and Workers in that account instead. The
control plane itself can also run as a Worker; `bun run deploy -- --contract`
describes what publishing that involves and what it refuses to do.

The operator-private deploy target may also declare `aiModels` and
`r2ParentAccessKeyId`. The former is the exact public-model to upstream-model
mapping, limits, and retail token prices; the latter is only the public id of an
R2 parent token. Realization places those non-secret values in Worker vars. AI
uses the native Workers AI binding, so it does not copy an account API token
into inference requests. `CLOUDFLARE_API_TOKEN` remains the provisioning
secret, while `TAKOSERVER_R2_PARENT_TOKEN` is the separate S3 credential-issuer
secret. Deploy preflight refuses an enabled capability whose required secret is
absent. With no such target fields, `/v1/ai` and S3 credential issuance stay
absent rather than using a demo backend.

See [docs/adr/0001-provision-from-the-worker.md](docs/adr/0001-provision-from-the-worker.md)
for why the deployed Worker holds the account credential, and what that costs.

## Resource and supply model

Takoform owns the portable words: Form, Interface, Binding, Attachment, and
Migration semantics. Takoserver owns the supply decisions: Offerings, provider
installations, Deployments, commercial authority, placement, credentials,
metering, and cost.

One exact Form may have many Offerings. A logical Resource keeps one stable UID
while one or more provider-backed Deployments coexist during migration. Provider
IDs exist only on Deployments; provider names and prices never enter a Form.
Deleting either side of a live Attachment fails with `dependency_in_use` until
the Attachment is removed.

Migration planning accepts no caller-invented payment claim. The target
Offering must be backed by one active, exact-digest reservation of quantity one;
the reservation is unique to the Migration and is captured only after cutover.
Cancelling before cutover first deletes any authoritative candidate Deployment
and only then releases the hold. An acknowledgement gap is left open for
operator reconciliation rather than being reported as a successful cancellation.

## How it is built

Six ports, and everything above them is provider-neutral.

| Port | Implementations |
|---|---|
| `Sql` | SQLite, D1 binding, D1 over HTTP |
| `ObjectStore` | filesystem, R2 binding, R2 over HTTP, memory |
| `Provider Pack` | provisioning, Attachment, transfer, credential, meter, and cost capabilities |
| `ExternalIdentityVerifier` | Google ID tokens, operator signature |
| `FundingSettlementVerifier` | Stripe, operator signature |
| `AiGateway` | any OpenAI-compatible upstream; the Worker entry uses its native Workers AI binding |

`scripts/check-imports.ts` enforces the layering as a gate rather than a
convention: core, adapters, domain, routes, composition, entries — and a
per-entry ban, so the Workers entry cannot reach a filesystem it does not have.

Three properties are worth knowing before reading the code:

**Shipped Form definitions come from a release.** Takoserver cannot author a
name in the Takoform namespace. `bun run check:official-forms` pins the exact
Takoform provider tag, commit, identity ledger, definition, and package index,
then proves the shipped catalog is an exact subset. A new Form needs a released
provider definition and an implemented backend; AI and S3 protocol operations
do not become Forms just because Takoserver offers them.

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
