# Takoserver

An Open Source, Self-Hostable PaaS with a [Takoform](https://takoform.com) Host
for declarative infrastructure and ordinary data APIs for already-standardized
services. The public Host is the one literal `forms.takoform.com/v1` lane.
Production installs only exact package bytes generated from one canonical,
source-pinned Takoform commit. That downstream pin is Takoserver adoption
authority, not a Takoform release, Form promotion, or claim that the current
`0.x` FormRefs are no longer Experimental.

Current managed object storage is one exact portable chain: the versionless
`edge.forms.takoform.com/ObjectBucket` Resource provides `edge.objects`, and a
Worker Version consumes it only through the exact
`module-worker.object-bucket` Binding declared in `bucketBindings`. That Form is
supported and activated by the code-owned implementation catalog
([ADR 0007](docs/adr/0007-objectbucket-joins-the-implementation-catalog.md));
a Host may execute it only where its deploy target realizes an ObjectBucket
supply. Provider bucket names, regions, endpoints, credentials, and supply
documents remain inside the selected Provider Pack and Deployment; none is
Resource desired, observed, output, discovery, or Worker binding state.

Both Cloudflare Worker backends carry that Binding. The ordinary-workers
backend uploads the tenant's exact bundle bytes with no wrapper, so the
declared name carries Cloudflare's native R2 binding. The managed
Workers-for-Platforms backend keeps the customer module as a user Worker and
projects the same nine-method `edge.objects` facade from its provider-authored
wrapper. Its raw R2 binding and provider-owned receipt Durable Object namespace
are hidden capabilities, never projected into the tenant handler environment.
The namespace points across scripts to a dedicated route-less receipt-authority
Worker; the internet-routed dispatch gateway carries neither that namespace nor
the R2 S3 access key, secret key, or receipt proof secret. The Durable Object owns
multipart lifecycle state under an opaque identity derived from provider,
Resource UID, Deployment incarnation, and Resource generation. Its orchestration
is the only native multipart-create authority: a private bounded SigV4 adapter
persists the exact-key upload-id baseline, issues one durable create grant, and
adopts only one synchronous list delta. A private R2 marker separately reconciles
a lost completion acknowledgement. Seven-day active expiry and seven-day
terminal retention run in batches of 64; an ambiguous multi-delta create remains
permanently visible as `operatorReconciliationRequired` instead of being guessed
or garbage-collected. A destruction fence likewise reports `repairRequired`
until the original opaque delete handle proves provider absence and commits;
it never authorizes a second R2 `DELETE`. No bucket name, region, endpoint, credential, Durable
Object name, or receipt authority enters the Takoform contract. ADR 0007 records
the runtime-specific shapes and their divergence from
[ADR 0005](docs/adr/0005-object-storage-is-an-exact-objectbucket-binding.md).

Takoserver serves no public S3-credential or managed standard-service retail
route. Separate S3 retail is not composed by default, and provider credentials
alone never authorize it. Private R2 and S3 transports are implementation
adapters behind `edge.objects`, not alternate public contracts.

The released provider-v2.1.1 Edge Family remains immutable historical input so
Takoserver can observe and delete Deployments already recorded under it. Its
v1beta1 ObjectBucket identity is recovery-only and is never installed as a
current sale, authoring, or `/provision/v1` authority.

Run it on your own machine and it uses your disk and [workerd](https://github.com/cloudflare/workerd),
the runtime Cloudflare runs at the edge. A Bun process owns both local SQLite
control state and a local exact-identity artifact store; it rejects
`TAKOSERVER_R2_BUCKET` before opening local state. Production execution on
Cloudflare Workers belongs to the Worker entry, not to an ambient account
credential in the Bun entry.

```
bun install
bun src/entry-bun.ts
```

That is the whole first run. It creates its schema, generates the keys it signs
with, prints a sign-in you can paste into its console, and starts serving.
Ordinary Bun always keeps the stable self-host Provider3 execution pack.
`CLOUDFLARE_ACCOUNT_ID` may separately back an explicitly reviewed ObjectBucket
supply, but it is neither provider-selection nor resale authority and does not
switch stable Forms off. `TAKOSERVER_D1_DATABASE_ID` and
`TAKOSERVER_R2_BUCKET` are rejected by the Bun entry before it opens local
state; use the Worker entry for D1/R2-bound execution.

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
- **Bind** a current ObjectBucket through `bucketBindings`. The Host resolves
  the exact Resource relation and active Deployment, then the provider's
  two-stage materializer hands the ordinary-workers runtime one opaque
  capability, which becomes a native R2 binding under the declared name.
  Native bucket identity and credentials stay private to that adapter.
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
| `TAKOSERVER_WORKERD_TLS_CERT_FILE` / `TAKOSERVER_WORKERD_TLS_KEY_FILE` | PEM paths. With both, workerd terminates TLS on that port and Worker endpoints are published as `https://`. |
| `TAKOSERVER_WORKERD_TLS_CERT` / `TAKOSERVER_WORKERD_TLS_KEY` | The same two halves as PEM text, for a deployment that has no file to point at. |
| `TAKOSERVER_WORKER_ENDPOINT_PORT` | Port a published Worker address carries. The workerd port by default; set it when something else terminates in front of workerd. The scheme's own default (443, 80) publishes a portless address. |
| `TAKOSERVER_SUFFIXES` | Hostname suffixes this deployment will serve. Empty means any. |
| `TAKOSERVER_OPERATOR_PUBLIC_JWK` | Public half of the operator key. Generated under the data root if unset. |
| `TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK` | Optional identity-only operator key. It overrides the login key without granting wallet-funding authority. |
| `GOOGLE_CLIENT_ID` | Turns on Google sign-in. Its absence leaves the operator path. |
| `STRIPE_SECRET_KEY` | Turns on card payment. Its absence leaves operator-signed funding. |
| `TAKOSERVER_AI_BASE_URL` | HTTPS base path of an OpenAI-compatible upstream. |
| `TAKOSERVER_AI_MODELS` | JSON allowlist mapping public model IDs to upstream IDs, limits, and retail token prices. |
| `TAKOSERVER_AI_TOKEN_FILE` | Preferred rotatable upstream bearer secret file. |
| `TAKOSERVER_AI_TOKEN` | Direct upstream bearer secret when a file is not used. |

Without a certificate the Worker socket speaks plain HTTP and the origin this
Host hands a Worker is `http://`, truthfully — an `https://` address the runtime
does not serve is one nothing answers on. On the default `localhost` suffix that
is fine for the Worker's own identity. On any other suffix it is not: a Worker
that derives its public identity from the request URL establishes no origin over
plain HTTP on a name that is not loopback, so federation, signing, and
self-addressing cannot work there. The process says so at boot rather than
leaving it to be discovered.

### Publishing a `WorkerEndpoint` needs TLS on 443

A `WorkerEndpoint` is a published, portable address, and the released
`WorkerEndpoint` Form states what one may look like: `https://` plus a dotted
name plus `/`. There is no plaintext address and no port. So this deployment can
create a `WorkerEndpoint` only when the address it would publish is that shape,
which means terminating TLS on the default port in one of two ways:

- **In workerd.** Set `TAKOSERVER_WORKERD_TLS_CERT_FILE` and
  `TAKOSERVER_WORKERD_TLS_KEY_FILE` (or the two `_CERT` / `_KEY` PEM-text
  variables) and `TAKOSERVER_WORKERD_PORT=443`. Binding 443 needs the capability
  to do so.
- **Behind a front end.** Terminate TLS on 443 in front of this machine, leave
  workerd on whatever port it has, and say so with
  `TAKOSERVER_WORKER_ENDPOINT_PORT=443`. The port then normalizes away and the
  published address is the portless one the front end really answers on.

Any other configuration — plain HTTP, or a port that is not the scheme's
default — still runs Workers, KV, SQL, queues, cron and buckets, and still
serves them on its own socket. It simply cannot mint a `WorkerEndpoint`, and it
says which of the two remedies to apply: at boot, and again in the refusal a
`takoform_worker_endpoint` create answers with. The loopback development default
is included: `http://<script>.localhost` is exactly as unpublishable as any
other plain-HTTP address.

A restarted deployment brings its published Workers back by itself. The runtime
is started at boot for whatever this machine had already published, before the
API begins answering; a machine that has published nothing starts no runtime.

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

The Takoform Host of a fresh self-host serves no Form until the operator
records the publisher-set admission chain with
`bun scripts/selfhost-form-admission.ts <organizationId> <space> --apply`; see
[docs/form-authority.md](docs/form-authority.md#self-host-admission).

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

The public control-plane Worker never receives a Cloudflare parent credential.
Reviewed Cloudflare Edge or ObjectBucket supplies require one exact route-less
provider-executor topology; the public Worker holds only its typed service
binding and non-secret supply projection. The executor alone receives
`CLOUDFLARE_API_TOKEN` and the runtime-input sealing keyring from its canonical
operator-private secrets file. Apply, import/adoption, and their recovery paths
are bound to the exact active Host saga lease and executor-owned pre-effect
claim. Observation, artifact-consumption readback, and upstream usage meters
are bound to the exact tenant, Offering, provider installation, and recorded
Deployment before the executor uses its parent credential. Historical released
provider adapters may remain installed to observe and delete recorded
Deployments, but their beta Forms are not republished as a sale catalog.
`bun run deploy -- --contract` prints the
side-effect-free split deploy contract. Every operation then names one surface,
one `--status` or `--apply` action, an exact environment, and an exact 40-hex
commit; there is no mixed controller, plan, ledger, journal, or target override.
See [`docs/deploy.md`](docs/deploy.md) for the surface list, dependency order,
the clean-checkout integration target realization path, private inputs, and
failure rules. In particular, do not copy the retired
`.deploy/target.staging.json` shape into a current checkout: the current v2
target joins the Cloudflare supplies, executor, gateway, and receipt-authority
identities atomically. The landing-page details are in
[`docs/deploy-site.md`](docs/deploy-site.md).

Wasabi has no equivalent private executor. Every Wasabi supply or recovery
offering therefore fails target parsing/public composition closed; its access
key, secret key, provider, and parent-backed meter are never public Worker
bindings. Self-host storage remains independent of that hosted restriction.

The official operator-private deploy target may declare `aiModels`,
`objectBucketSupplies`, and whether hosted sponsorship is enabled.
Sponsorship adds only the product-owned bearer secret required by that API; it
does not add a service binding or an external entrypoint to the Takoserver
Worker.
`objectBucketSupplies` is a closed, non-secret operator composition tying one
exact current ObjectBucket Form to a Provider Installation, Supply Contract,
price plan, and `embedded-binding` delivery. It accepts only operator-internal
provider access; native-credential retail is not inferred from that document.
Realization writes it to `TAKOSERVER_OBJECT_BUCKET_SUPPLIES` and separately
requires the provider's provisioning secrets before publication. `aiModels` is
the exact public-model to upstream-model mapping, limits, and retail token
prices. Deploy realization and
immutable Worker Version readback require the exact D1, R2, and secret-name
closure and reject unexpected bindings.
The read-only surface-specific `--status` path proves the applicable exact D1,
R2, secret-name, domain-owner, deployment-history, and binding closure, so a
stale operator target or an incompletely wired live Version cannot masquerade
as healthy state.
Takoserver's public protocol and standalone path do not depend on Takosumi.
Stable Worker Forms with an omitted or empty `requiredSensitiveVars`
declaration provision normally. A configured Cloudflare provider can also
accept a non-empty declaration through Takoserver's RuntimeInputAuthority, up
to 64 names when `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` is configured. Before
the Resource graph exists, an organization key reserves the future canonical
HTTPS origin at
`/v1/worker-endpoint-origin-reservations/{reservationId}`. Takoserver selects
and records the same exact sold ModuleWorker Offering and provider placement as
ordinary Host mutation; an omitted Offering is accepted only when that
selection has exactly one eligible result. The reservation is value-free and
does not create a Takoform Resource or call the provider. A key that reserves
nothing still gets a `WorkerEndpoint`: where the selected installation derives
its own endpoint address — a self-host suffix, the ordinary-workers
`workers.dev` or zone suffix — the Host reserves that derived origin on the
caller's behalf, in an id namespace the public routes refuse every write to,
and lets go of an endpoint or a moved Worker revision under the same fences. An installation that sells its base
domain instead of deriving one mints nothing and still requires a supplied
reservation.

The sensitive half of a Worker Version travels separately, over
`PUT|GET /v1/takoform/worker-runtime-input-preparations/{operationKey}` speaking
`takoserver.worker-runtime-input-preparation@v2`. The operation key is the exact
`Idempotency-Key` the ordinary public apply will carry, so one key names both
halves of the same mutation. The private request states this Host's own
canonical public origin and commits to the exact public apply it authorizes —
method, path, `If-None-Match: *`, and body — and Takoserver recomputes that
commitment and echoes it back, so a caller can prove the Host bound the values
to the request it meant. Replaying the key with a different apply or different
values is a conflict, not an overwrite. The provider lease claims that exact
identity before any asset or Worker Version mutation, erases ciphertext in the
dispatch CAS, and settles only after provider readback. `GET` is the value-free
recovery read: it never returns a value and never asks the caller to send the
secrets a second time.

Activation later proves the released, Ready `WorkerEndpoint`, its exact worker
relation, provider placement, and canonical output. Deactivation retains the
endpoint UID as a deletion witness: the endpoint and its provider deployment
must be closed before the reservation can be released and its origin reused.
TTL expiry does not unlock an origin while that deletion witness is retained.
A self-hosted machine takes the same path when its operator configures
`TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` **and** serves the deployment at an
`https` bare `TAKOSERVER_PUBLIC_ORIGIN`, and only then: the capability is
derived from the lease port's presence, so a machine with nowhere to seal a
value advertises a ceiling of zero and admission refuses the declaration with
`unsupported_capability` before anything is provisioned. The canonical public
origin is HTTPS-only on both sides — the released Takoform provider refuses any
other scheme before it sends a value, and `openapi/takoserver.openapi.json`
documents the same — so the default `http://localhost:8787` development origin
carries no sensitive runtime inputs; the entry point says so on startup and
composes no preparation route. The retired-ObjectBucket drain mode composes no
lease port either, and therefore also serves no preparation route. Nothing is
auto-generated in its place — a key kept beside the ciphertext it protects is
not encryption at rest. workerd has no secret binding type, so a delivered value
is projected as an ordinary environment binding into a `0600` configuration
under a `0700` directory, recorded in a `0600` file beside — never inside — the
immutable version directory, and never written anywhere else.
The declaration's names remain in the Worker Version spec; values do not enter
portable state. Realization places the other non-secret values in Worker vars.
AI uses the native Workers AI binding, so it does not copy an account API token
into inference requests. `CLOUDFLARE_API_TOKEN` remains provider-executor
authority, not tenant runtime input. Managed R2 S3 credentials and the receipt
proof secret enter only the route-less receipt-authority Worker's atomic
`--secrets-file` publication; there is no public S3 credential issuer. Deploy
preflight refuses an enabled capability whose required secret is absent. With
no such target fields, `/v1/ai` and ObjectBucket retail stay absent rather than
using a demo backend.

See [docs/adr/0001-provision-from-the-worker.md](docs/adr/0001-provision-from-the-worker.md)
for the superseded public-credential decision and the current route-less
provider-executor boundary.
The reservation and RuntimeInputAuthority boundary is recorded in
[docs/adr/0004-runtime-input-authority.md](docs/adr/0004-runtime-input-authority.md),
and the runtime-input wire contract this Host now speaks in
[docs/adr/0006-runtime-input-wire-contract-v2.md](docs/adr/0006-runtime-input-wire-contract-v2.md).

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
author a name in the Takoform namespace. `bun run check:form-corpora` pins
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
