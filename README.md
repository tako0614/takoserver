# Takoserver

An Open Source, Self-Hostable PaaS with a [Takoform](https://takoform.com) Host
for declarative infrastructure and ordinary data APIs for already-standardized
services. The public Host is the one literal `forms.takoform.com/v1` lane.
Production installs only exact package bytes generated from one canonical,
source-pinned Takoform commit. That downstream pin is Takoserver adoption
authority, not a Takoform release, Form promotion, or claim that the current
`0.x` FormRefs are no longer Experimental.

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
the runtime Cloudflare runs at the edge. A Bun process may share R2 with a
Cloudflare deployment, but its control state stays in local SQLite and its
current Worker execution remains on local workerd. Production execution on
Cloudflare Workers belongs to the Worker entry, not to an ambient account
credential in the Bun entry.

```
bun install
bun src/entry-bun.ts
```

That is the whole first run. It creates its schema, generates the keys it signs
with, prints a sign-in you can paste into its console, and starts serving.
Ordinary Bun always keeps the stable self-host Provider3 execution pack.
`CLOUDFLARE_ACCOUNT_ID` may separately back shared R2 or a configured
standard-service supply, but it is not provider-selection authority and does
not switch stable Forms off. `TAKOSERVER_D1_DATABASE_ID` is rejected by the Bun
entry before it opens local state; use the Worker entry for D1-bound execution.

The released Cloudflare ObjectBucket provider survives only as an explicit
recovery lane for observing and deleting its already-recorded beta
Deployments. An operator enters it with
`TAKOSERVER_RETIRED_PROVIDER_MODE=cloudflare-object-bucket-drain` plus the
Cloudflare account credential and `TAKOSERVER_PROVISIONER_TOKEN`. That lane
publishes zero current Offerings and cannot be mixed with self-host provider
settings. `TAKOSERVER_ZONES` is rejected because an ObjectBucket drain owns no
DNS or Worker-route authority; the old implicit `TAKOSERVER_EDGE_FORMS` switch
is rejected too. Recovery-mode credentials are validated before local state is
opened.

For a disposable Provider v3 integration run against the production
Cloudflare adapter and an in-process account, use the loopback-only stable Host
launcher:

```sh
TAKOFORM_STABLE_CATALOG_ROOT=/path/to/exact/takoform-v3.0.0 \
TAKOSERVER_STABLE_LOCAL_TOKEN=local-test-token-at-least-16-characters \
bun run debug:stable-local-cloudflare-host
```

The catalog loader verifies the frozen 31-Form input before listening. The
launcher installs the exact 13-Form union needed by the maintained Road to Me
(9 Forms) and Yurucommu (12 Forms) local graphs. Its `StaticAssetBundle` path
uses the production Cloudflare Provider upload protocol and serves the realized
asset manifest through the disposable workerd runtime, including Worker-first
and single-page fallback behavior.

The disposable Host accepts only Worker Versions whose
`requiredSensitiveVars` declaration is omitted or empty, matching the public
Host support profile. This command is not a deploy path. It binds `127.0.0.1`
on an ephemeral port by default and prints one sanitized ready JSON line
without the token. `TAKOSERVER_STABLE_LOCAL_SPACE` and
`TAKOSERVER_STABLE_LOCAL_PORT` may override the local Space and port.

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
- **Scope** organization API keys by resource intent. `resources:read` may call
  Host read routes (including validate and observe); `resources:write` retains
  that read access and additionally permits prepare, PUT/POST mutations, and
  DELETE. Missing scopes are refused before resource lookup, while wrong-tenant,
  revoked, and expired credentials remain non-enumerating failures.
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
| `TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK` | Optional identity-only operator key. It overrides the login key without granting wallet-funding authority. |
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

The legacy/generated key also credits the wallet
(`operator-key.ts funding <org> <ref> <minor>`) until Stripe is configured. An
explicit `TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK` is login-only: it takes
precedence for operator sign-in but cannot verify funding assertions. This is
the operator vouching in a form the server can check and nobody else can forge
— not an identity provider, and it stops being the way in the moment a real one
is configured.

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
and no other tenant's in-flight requests are dropped for it. A machine without
the workerd binary fails Worker serving activation, rather than recording a
false serving state; storage and databases remain independently available.

A Worker that declares static assets gets them: the files are served ahead of
the script through an `ASSETS` binding, and `notFoundHandling` decides what an
unmatched path means, so a single-page application survives a reload here the
same way it does on Cloudflare.

## Running it on Cloudflare

Set `CLOUDFLARE_ACCOUNT_ID` and a scoped API token to make configured Host-owned
standard-service supplies available in that account. Historical released
provider adapters may remain installed to observe and delete recorded
Deployments, but their beta Forms are not republished as a sale catalog. The
control plane itself can also run as a Worker. `bun run deploy -- --contract`
prints the side-effect-free split deploy contract. Every operation then names
one surface, one `--status` or `--apply` action, an exact environment, and an
exact 40-hex commit; there is no mixed controller, plan, ledger, journal, or
target override. See [`docs/deploy.md`](docs/deploy.md) for the surface list,
ordering, private inputs, and failure rules. The landing-page details are in
[`docs/deploy-site.md`](docs/deploy-site.md).

The official operator-private deploy target may declare `aiModels`,
`standardServiceSupplies`, and whether hosted sponsorship is enabled.
Sponsorship adds only the product-owned bearer secret required by that API; it
does not add a service binding or an external entrypoint to the Takoserver
Worker.
`standardServiceSupplies` is a closed, non-secret operator choice. The current
adapter accepts exactly
`standards.takoform.com/v1/com.amazonaws.s3 -> cloudflare-r2` plus an
operator-owned `supplyNamespace`; realization writes that exact document to
`TAKOSERVER_STANDARD_SERVICE_SUPPLIES` and requires the ordinary
`CLOUDFLARE_API_TOKEN` secret before publication. It does not create, sell, or
reference a current ObjectBucket Form. `aiModels` is the exact public-model to
upstream-model mapping, limits, and retail token prices. Deploy realization and
immutable Worker Version readback require the exact D1, R2, and secret-name
closure and reject unexpected bindings.
The read-only surface-specific `--status` path proves the applicable exact D1,
R2, secret-name, domain-owner, deployment-history, and binding closure, so a
stale operator target or an incompletely wired live Version cannot masquerade
as healthy state.
Takoserver's public protocol and standalone path do not depend on Takosumi.
Stable Worker Forms with an omitted or empty `requiredSensitiveVars`
declaration provision normally. A non-empty declaration is advertised as
unsupported and rejected by Host admission before any provider mutation or
Offering claim. Takoserver does not resolve or inject those values. Realization
places the other non-secret values in Worker vars. AI
uses the native Workers AI binding, so it does not copy an account API token
into inference requests. `CLOUDFLARE_API_TOKEN` remains the provisioning
secret. `r2ParentAccessKeyId` and `TAKOSERVER_R2_PARENT_TOKEN` belong only to
the retained historical ObjectBucket credential path and must be paired with
its historical supply record; they are not required by a stable S3 runtime
binding. Deploy
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

Six provider-neutral ports; the SQL port is shown at both capability levels
below, and everything above them remains provider-neutral.

| Port | Implementations |
|---|---|
| `Sql` | SQLite, D1 binding (including atomic batch) |
| `SqlAccess` | D1 over HTTP (query/run only; no atomic batch) |
| `ObjectStore` | filesystem, R2 binding, R2 over HTTP, memory |
| `Provider Pack` | provisioning, Attachment, transfer, credential, meter, and cost capabilities |
| `ExternalIdentityVerifier` | Google ID tokens, operator signature |
| `FundingSettlementVerifier` | Stripe, operator signature |
| `AiGateway` | any OpenAI-compatible upstream; the Worker entry uses its native Workers AI binding |

`scripts/check-imports.ts` enforces the layering as a gate rather than a
convention: core, adapters, domain, routes, composition, entries — and a
per-entry ban, so the Workers entry cannot reach a filesystem it does not have.

Three properties are worth knowing before reading the code:

**Shipped Form definitions come from exact Takoform bytes.** Takoserver cannot
author a name in the Takoform namespace. `bun run check:official-forms` pins
both the canonical source commit and the generated catalog bytes, while still
pinning immutable provider-v2.1.1 history used to drain old records. A current
sale additionally needs an implemented backend and explicit operator supply;
pinning it here does not mint or promote a Takoform release. AI and S3 protocol
operations do not become Forms just because Takoserver offers them.

**Guarded writes and atomic batches.** The control database has no interactive
transaction, so invariants live in `WHERE` clauses and are verified by counting
the rows a write actually changed. SQLite and the Worker D1 binding also expose
an all-or-none `Sql.batch` for multi-statement commits. The D1 HTTP maintenance
adapter intentionally exposes only `SqlAccess` (query/run); it cannot claim
that atomic capability. A hold that cannot be covered is not written at all.

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
