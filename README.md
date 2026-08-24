# Takoserver

An Open Source, Self-Hostable PaaS with a [Takoform](https://takoform.com) Host
for declarative infrastructure and ordinary data APIs for already-standardized
services. The public Host is the one literal `forms.takoform.com/v1` lane.
Production installs no unpublished Form package: exact stable definitions must
arrive from Takoform as released external input before they may enter the
production catalog.

The released provider-v2.1.1 Edge Family remains immutable historical input so
Takoserver can read and drain Deployments already recorded under it. It is not
a current `/v1` sale or `/provision/v1` authority, and its ObjectBucket /
`edge.objects` identities are not relabelled as stable. Current Worker object
storage is a portable external-service slot containing only `{name, service,
required}` with service `{apiVersion: "standards.takoform.com/v1", protocol:
"com.amazonaws.s3"}`. The Host resolves that slot out of band and gives the
runtime one sealed native binding; bucket name, endpoint, credential, FormRef,
and resource selector never enter portable desired or observed state.

The existing `/v1/organizations/{organizationId}/resources/{resourceUid}/s3-credentials`
shape is retained only for draining historical ObjectBucket records. It does
not create a current ObjectBucket or grant new lifecycle authority.

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
- **Reach** standard services through sealed runtime bindings. A stable Worker
  names the S3 protocol and its local slot; the Host owns supply selection and
  keeps native bucket identity and credentials outside portable state.
- **Run** the ordinary Takoform provider without handing a hosted runner the
  reseller's organization API key. A reseller reservation can mint a
  short-lived bearer pinned to one opaque tenant, exact Form, and exact
  Resource name. Before capture it can only validate, prepare, and create that
  paid address. After capture, a new bearer additionally pins the immutable
  Resource UID before it may read, observe, update, or delete that incarnation.
  The first create atomically marks the reservation consumed before provider
  side effects, so a release can never leave an unpaid Resource.
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

A hosted Cloudflare deployment enables customer card funding only when its
private deploy target explicitly sets `"stripeCheckout": true` **and** the
Worker already has a `STRIPE_SECRET_KEY` secret. The target contains no secret
value: the owner preflight fails if the named capability has no secret, while a
lingering secret alone cannot expose Checkout when the target capability is
absent.

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

Set `CLOUDFLARE_ACCOUNT_ID` and a scoped API token to make configured Host-owned
standard-service supplies available in that account. Historical released
provider adapters may remain installed to observe and delete recorded
Deployments, but their beta Forms are not republished as a sale catalog. The
control plane itself can also run as a Worker; `bun run deploy -- --contract`
describes what publishing that involves and what it refuses to do.

The operator-private deploy target may also declare `aiModels`,
`r2ParentAccessKeyId`, and a `hostRuntimeMaterializerService`. The former is the
exact public-model to upstream-model mapping, limits, and retail token prices;
the latter is only the public id of an R2 parent token. The materializer
descriptor contains only an exact Worker service name and named entrypoint;
realization binds it as `HOST_RUNTIME_MATERIALIZER`. The deploy writer reads the
immutable Worker Version back and requires that exact service and entrypoint;
it also rejects a stale materializer binding when the target declares none.
The read-only `bun run deploy -- --status` path proves the same exact D1, R2,
and materializer closure, so a stale operator target or an incompletely wired
live Version cannot masquerade as a healthy recovery state.
Runtime values cross that
RPC boundary only while Takoserver provisions one tenant Worker and never enter
the target, state, Output, receipt, or agent transcript. If the materializer
changed host-side authority while deriving those values, it may return an
opaque authenticated rollback receipt. Takoserver never interprets that
receipt: a failed immutable Worker Version upload sends it back only to the
same private materializer, and reports a provider error unless the exact
compare-and-swap rollback is confirmed. Realization places the other
non-secret values in Worker vars. AI
uses the native Workers AI binding, so it does not copy an account API token
into inference requests. `CLOUDFLARE_API_TOKEN` remains the provisioning
secret, while `TAKOSERVER_R2_PARENT_TOKEN` is the parent R2 secret access key.
The Worker uses that key only to sign short-lived bucket-scoped session
credentials locally; it never returns or forwards the parent key. Deploy
preflight refuses an enabled capability whose required secret is absent. With
no such target fields, `/v1/ai` and S3 credential issuance stay absent rather
than using a demo backend.

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
name in the Takoform namespace. `bun run check:official-forms` still pins the
immutable provider-v2.1.1 bytes used to manage historical records; those bytes
carry no present sale authority. A current Form needs a released stable
definition and an implemented backend. AI and S3 protocol operations do not
become Forms just because Takoserver offers them.

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
