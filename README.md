# Takoserver

An Open Source, Self-Hostable PaaS with a [Takoform](https://takoform.com) Host
for declarative infrastructure and ordinary data APIs for already-standardized
services. This repository owns the generic Host foundation and the self-host
plugin. The managed Workers-for-Platforms implementation is a separately
supplied, non-public operator backend; it is not needed to build or run the OSS
self-host distribution. Where the control plane itself runs is an independent
deployment choice.

The normal application serves only `forms.takoform.com/v2`. A versioned HTTPS
Form URL identifies the contract; Host-side code implements it. The v2 path does
not install Form packages, require their signatures, or translate into v1.
Resources belong to an organization while each credential retains its own
read/write permissions. See [v2 architecture and operator setup](docs/takoform-v2.md).

The Bun entry can explicitly configure `SQLiteMigrationSet 0.2.0`,
`WorkerBundle 0.2.0`, and `StaticAssetBundle 0.2.0` against authorized
Host-held bytes. These Forms validate and retain artifacts; by themselves they do
not apply SQL, execute a Worker, serve assets, or create an endpoint. A separate,
opt-in local `workerd` composition advertises its Worker lifecycle Forms and
SQLite/KV/ObjectBucket/Queue Bindings only when the complete native runtime and
private data planes are configured and restored. Its exact gates, Form map, and
limits are in [v2 architecture and operator setup](docs/takoform-v2.md).
Hosted D1, Workers for Platforms, downstream Provider adoption, public TLS/live
qualification, and deployment qualification are separate; source and local
native evidence do not establish a deployed rollout.

Before starting, provide the canonical external HTTPS origin, the non-secret
`TAKOSERVER_TAKOFORM_V2_CONFIG`, and the persistent operator-secret
`TAKOSERVER_TAKOFORM_V2_CURSOR_KEY` described in that guide. Then run:

```sh
bun install --frozen-lockfile
bun src/entry-bun.ts
```

The public v2 discovery is `/.well-known/takoform/v2`; technical support for an
exact Form URL is queried at `/apis/forms.takoform.com/v2/support?form=...` with
authentication. Support reflects the Forms actually composed at startup; an
unavailable optional runtime is not advertised as a narrower substitute. The
Bun HTTP listener requires an operator-controlled HTTPS front end for public
use. Do not expose that backend listener directly.

## Legacy runtime and provider reference

The implementation notes below describe retained pre-v2 provider, data-plane and
recovery code. They are not the v2 support catalog or instructions for creating
v2 resources. Package admission and old native Host tests must not be used as
v2 readiness evidence. Existing v1 records are preserved and pending repair work
continues internally; the old public Takoform HTTP handler is not mounted.

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

Both Cloudflare Worker backends carry that Binding. When explicitly enabled for
development, the OSS ordinary-workers backend uploads the tenant's exact bundle
bytes with no wrapper, so the declared name carries Cloudflare's native R2
binding. The separately supplied managed backend exposes the same nine-method
`edge.objects` facade while
keeping provider-native capabilities out of the tenant environment. Its
operator owns multipart recovery, retention, and destruction reconciliation;
uncertain provider effects are not reported as success or retried blindly.
No bucket name, region, endpoint, credential, or provider authority enters the
Takoform contract. ADR 0007 records the original implementation decision and its divergence from
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

With the v2 configuration above, startup creates the local schema and starts
serving. When no identity provider is configured, it generates the operator key
and prints a 10-minute sign-in assertion. Use the exact external console origin
if `TAKOSERVER_CONSOLE_ORIGIN` is configured; otherwise the Host also prints its
origin, API documentation URL, and manual session/API onboarding instructions.
The Bun Host itself does not serve a `/console` page. If an identity provider is
configured, use that provider's sign-in flow. Create or select the organization
that will own resources; its exact ID is the v2 Space. Do not run old
publisher-set admission as v2 setup. [Self-host operations](docs/self-host-operations.md)
contains the historical runtime and repair procedures; the current v2 setup is
the separate guide linked above.

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
launcher installs the historical 13-Form union used by the Road to Me and
Yurucommu local graph fixtures. Its `StaticAssetBundle` path
uses the production Cloudflare Provider upload protocol and serves the realized
asset manifest through the disposable workerd runtime, including Worker-first
and single-page fallback behavior.

This diagnostic profile does not support `ObjectBucket` and accepts only Worker
Versions whose `requiredSensitiveVars` declaration is omitted or empty. It is
therefore insufficient for the current Yurucommu Provider 4 graph, which needs
both capabilities; a passing older fixture is not a full current-app E2E.
This command is not a deploy path. It binds `127.0.0.1`
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
  See [qualifying one public AI inference](docs/ai-live-qualification.md) for
  the explicit opt-in completion/replay check and its limits.

## Self-hosting

[Self-host operations](docs/self-host-operations.md#first-install-and-first-use)
is the install path, step by step, from a reviewed checkout to a Worker served
over HTTPS. This section summarises it and lists the settings.

The Bun entry (`src/entry-bun.ts`) runs one of two profiles, selected by
configuration:

- **Artifact profile.** The v2 Host API, operator sign-in, organizations, API
  keys, and the artifact Forms `SQLiteMigrationSet`, `WorkerBundle` and
  `StaticAssetBundle`, which validate and retain bytes without running them.
  It needs Bun and the three required settings below.
- **Complete local Worker profile.** Adds the Worker lifecycle Forms and their
  SQLite, KV, ObjectBucket and Queue Bindings, run on Linux x86-64 by the
  pinned closed-graph [workerd](workerd/README.md). The Host advertises them
  only when every setting in the second table is present and the existing
  Worker owners restore at startup; a partial setup advertises no reduced
  Worker profile. `WorkerEndpoint` also needs the HTTPS listener on TCP 443
  described below.

Neither profile needs publisher-set admission: the v2 Host serves the Forms
its configuration composes. `scripts/selfhost-form-admission.ts` and
[Self-host admission](docs/form-authority.md#self-host-admission) belong to the
retained v1 repair path and are not v2 setup.

### Settings

Three settings are required; startup stops without them:

| Variable | What it does |
|---|---|
| `TAKOSERVER_PUBLIC_ORIGIN` | Canonical bare `https://` origin of the control API, used for Host identity, operator audience, and the session cookie's Secure policy. The Bun listener speaks HTTP, so this is the origin of the TLS front end in front of it. |
| `TAKOSERVER_TAKOFORM_V2_CONFIG` | Strict, non-secret JSON with `documentation` and `authenticationDocumentation` URLs and the optional `sqliteMigrationSet`, `workerBundle` and `staticAssetBundle` blocks of held artifacts. See [v2 operator setup](docs/takoform-v2.md#normal-application-and-operator-setup). |
| `TAKOSERVER_TAKOFORM_V2_CURSOR_KEY` | At least 32 random bytes as canonical, unpadded base64url. An operator secret; keep it stable across restarts. |

The complete local Worker profile needs all of these, plus `workerBundle` and
`staticAssetBundle` blocks that both use `targetKey`
`selfhost-v2-worker-primary`:

| Variable | What it does |
|---|---|
| `TAKOSERVER_WORKERD_BINARY` | Absolute path to the exact pinned closed-graph artifact. An absent, substituted, or behaviorally incompatible binary disables Worker execution without silently selecting the npm workerd. |
| `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY` | Absolute path, free of symbolic links, to `services/workflow-execution-guard` built from this checkout. |
| `TAKOSERVER_V2_WORKER_RUNTIME_BOOT` | Actor and Workflow boot, for example `{"actor":true,"workflow":{"maximumRegistrations":64}}`. |
| `TAKOSERVER_V2_WORKER_PRIVATE_PLANES` | The five private planes (SQLite, KV, ObjectBucket, Queue settlement and Queue Producer), each with its own fixed port and an operator-generated signing key file. |
| `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING` | Optional. Enables WorkerVersion `privateInputs`. |

`WorkerEndpoint` additionally needs these:

| Variable | What it does |
|---|---|
| `TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS` | Exactly `1`. The Host itself listens for Worker Endpoints on `0.0.0.0:443`. |
| `TAKOSERVER_WORKER_ENDPOINT_SUFFIX` | DNS suffix (at least two labels, not `localhost` or an IP address). Each Endpoint gets a one-label hostname under it. |
| `TAKOSERVER_WORKERD_TLS_CERT_FILE` / `TAKOSERVER_WORKERD_TLS_KEY_FILE` | PEM certificate covering `*.<suffix>`, and its key. They also terminate TLS on the retained pre-v2 Worker socket. |
| `TAKOSERVER_WORKERD_TLS_CERT` / `TAKOSERVER_WORKERD_TLS_KEY` | The same two halves as PEM text, for a deployment that has no file to point at. |

Everything else is optional, and what is absent is absent rather than faked: a
deployment with no Stripe key does not serve the route that would begin a
payment, and its console offers the way it does take money instead.
`TAKOSERVER_DB` can put the control database outside the data root, and
configured service dependencies may use protected files outside it.

| Variable | What it does |
|---|---|
| `TAKOSERVER_DATA_ROOT` | Objects, databases, published Workers, and the signing key. `.takoserver` in the working directory by default. |
| `TAKOSERVER_DB` | Control database. A file under the data root by default. |
| `PORT` | Where the API and console API listen, over HTTP on every interface (default 8787). |
| `TAKOSERVER_SELFHOST_TENANT_RUN_CREDENTIALS` | Set to exactly `1` to mount the self-host runner-credential route. Absent or any other value leaves it at 404. |
| `TAKOSERVER_SELFHOST_TENANT_RUN_CREDENTIAL_KEY_ID` | Optional dedicated key identity for self-host runner credentials. Changing it creates a separate private key file under the data root; it must differ from `TAKOSERVER_SIGNING_KEY_ID`. |
| `TAKOSERVER_WORKERD_PORT` | Where the retained pre-v2 runtime serves published Workers (default 8788). |
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

When explicitly enabled, `POST /v1/selfhost/tenant-run-credentials` is a
Host-specific authenticated HTTP route, not a route-less service or a
private-network API. It accepts only a `resources:write` organization API key
(never a browser session or another tenant-run token) and the exact JSON body
`{"spaceRef":"…","runRef":"…","workerEndpointOriginReservationId":"…"}`;
the reservation member is optional. The organization is always taken from the
key, and a supplied reservation must still be live under that organization.
The returned bearer lasts exactly 300 seconds. Its dedicated Ed25519 key is
persisted as a `0600` file under `TAKOSERVER_DATA_ROOT`; revoking that key in
`runtime_grant_keys` takes effect after the existing verifier cache (10 seconds
by default), while expiry bounds every already-issued bearer to five minutes.
At boot and before each issuance, the Host proves that private key against the
exact active public half in the registry; a stale file, reused id, or revoked
row fails closed and is never overwritten or revived automatically.
The Cloudflare public Worker does not compose this route or import its signer.

### Held artifacts and Workers

The v2 artifact Forms never upload or fetch bytes. A create names an exact
HTTPS URL and SHA-256, and the Host serves it only from bytes already in its
object store, to the organizations its configuration grants. It reads those
grants at startup. `scripts/selfhost-artifact.ts` puts the bytes there while
the Host is stopped:

```sh
bun --no-env-file scripts/selfhost-artifact.ts seed worker-bundle ./dist \
  --base-url https://artifacts.example.com/hello/v1/ \
  --organization <organizationId> --entrypoint worker.js \
  --config /etc/takoserver/takoform-v2.json > hello-v1.json
```

It validates the files with the Form's own validator and stores them under
content addresses in the data root's object store. It prints the `artifact`
for the Resource spec and the exact config fragment that grants it, and with
`--config` merges that fragment into the config file. It refuses, before
writing, a data root another process has open, one that is not private to
this user, and an organization the control database does not know. Restart
the Host with the updated config, then create the `ModuleWorker`,
`WorkerBundle`, `WorkerVersion`, `WorkerDeployment` and `WorkerEndpoint`
Resources through `/apis/forms.takoform.com/v2/resources`. Steps 6 to 9 of the
[install path](docs/self-host-operations.md#first-install-and-first-use) give
the complete commands. `scripts/selfhost-artifact.ts verify` rechecks every
configured entry read-only, including while the Host runs.

### HTTPS and TCP 443

The Bun API listener speaks HTTP, including when a front end terminates TLS.
The configured public origin still owns operator sign-in and existing-owner
proof audiences, and HTTPS deployments still issue and clear `Secure` session
cookies. Backend URLs and `Forwarded` / `X-Forwarded-*` headers do not select
that authority. Cookie authentication continues to require the exact configured
console `Origin`; TLS termination does not relax that browser boundary.

Put the control API behind a TLS front end and do not expose the HTTP listener
directly. A `WorkerEndpoint 0.3.0` publication is served by the Host itself:
with `TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS=1` it binds TCP 443 on every IPv4
address, which needs root or `CAP_NET_BIND_SERVICE`, and DNS must resolve
`*.<suffix>` to the machine. A control API front end on the same machine
therefore uses another port, for example
`TAKOSERVER_PUBLIC_ORIGIN=https://api.example.com:8443`, or runs on another
machine. Startup refuses the selection without the certificate pair and
suffix, or when another self-host listener is already configured on 443.

### Retained pre-v2 Worker socket

The settings and rules in this subsection belong to the retained pre-v2
runtime (`TAKOSERVER_WORKERD_PORT`, `TAKOSERVER_WORKER_ENDPOINT_PORT` and its
`WorkerEndpoint@0.1.0` publication). They do not apply to `WorkerEndpoint
0.3.0`, which uses the listener above.

Without a certificate the Worker socket speaks plain HTTP and the origin this
Host hands a Worker is `http://`, truthfully — an `https://` address the runtime
does not serve is one nothing answers on. On the default `localhost` suffix that
is fine for the Worker's own identity. On any other suffix it is not: a Worker
that derives its public identity from the request URL establishes no origin over
plain HTTP on a name that is not loopback, so federation, signing, and
self-addressing cannot work there. The process says so at boot rather than
leaving it to be discovered.

#### Publishing a pre-v2 `WorkerEndpoint` needs TLS on 443

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

For **Caddy in front of the HTTPS workerd listener**, disable upstream
connection reuse. A Worker can reject a POST before reading its body; with
the current workerd runtime and Caddy's pooled HTTP/1.1 upstream, the following
request can fail with EOF / 502 before reaching the Worker. The compatible
transport keeps each request independent, without replaying mutations:

```caddyfile
reverse_proxy https://127.0.0.1:8788 {
  header_up Host {http.request.host}
  transport http {
    keepalive off
    tls_server_name runtime.apps.example.com
  }
}
```

The port and TLS server name are examples: use this deployment's actual
workerd listener and a name covered by its certificate. Keep certificate
verification enabled; configure the proxy's trust pool when using a private
CA. Preserve the original request Host so workerd can route the assigned
WorkerEndpoint, including on proxy versions that rewrite HTTPS upstream Host
headers by default. This changes only proxy-to-workerd pooling, not browser
keep-alive or the Bun API listener. Do not compensate with automatic POST
retries or by draining attacker-controlled bodies in application authorization.
See Caddy's [HTTP transport reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#the-http-transport).

Any other configuration — plain HTTP, or a port that is not the scheme's
default — still runs Workers, KV, SQL, queues, cron and buckets, and still
serves them on its own socket. It simply cannot mint a `WorkerEndpoint`, and it
says which of the two remedies to apply: at boot, and again in the refusal a
`takoform_worker_endpoint` create answers with. The loopback development default
is included: `http://<script>.localhost` is exactly as unpublishable as any
other plain-HTTP address.

For a self-host `QueueConsumer`, changing the source queue or receiving Worker
requires replacing the attachment, as its Form declares. In-place updates may
change delivery settings or the dead-letter destination, but must retain the
same native source queue and Worker. A target change is refused before any
attachment is written; it must not leave both the old and new consumers active.

A restarted deployment brings its published Workers back by itself. The runtime
is started at boot for whatever this machine had already published, before the
API begins answering; a machine that has published nothing starts no runtime.

### Operator sign-in and funding

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

A hosted Cloudflare deployment enables customer card funding only when its
private deploy target explicitly sets `"stripeCheckout": true` **and** the
Worker already has a `STRIPE_SECRET_KEY` secret. The target contains no secret
value: the owner preflight fails if the named capability has no secret, while a
lingering secret alone cannot expose Checkout when the target capability is
absent.

### Data root and backups

By default, durable state is rooted under `.takoserver`, but that directory is
not always the complete backup set. Stop Takoserver, its child `workerd`, and
every other configured writer before copying the complete root. Include an
external `TAKOSERVER_DB` and any existing SQLite `-wal`, `-shm`, or
rollback-journal sidecars from the same quiescent window. Preserve protected
external configuration and key material needed to restore the same identity
separately; do not store secrets in this repository. See the
[self-host backup and restore preparation](docs/self-host-operations.md) for
the procedure and its limits.

```
.takoserver/
  control.sqlite        organizations, keys, the ledger, resources
  signing-key.jwk       signs data-plane tokens
  operator-key.jwk      signs operator assertions
  objects/              customer objects, uploaded bundles under art/, seeded held artifacts under operator-held/
  databases/            customer SQL databases
  v2-sqlite-databases/  v2 SQLiteDatabase files
  v2-worker-owners/     v2 Worker runtime owners
  v2-runtime/           v2 Actor and Workflow runtime state
  s/                    per-start private sockets; not needed in a backup
  runtime-probes/       verified workerd snapshot and transient resolver probes
  workers/              published Workers and the workerd config
```

### The local Worker runtime

Published Workers are served by a workerd process Takoserver starts on the first
publish and leaves watching its configuration — a deploy rewrites the config,
and no other tenant's in-flight requests are dropped for it. A machine without
the exact artifact, digest, and executable closed-graph resolver capability
does not advertise or activate Worker serving, rather than recording a false
serving state; storage and databases remain independently available. At boot,
Takoserver copies the verified bytes into its private data root and executes
that snapshot for both inspection and serving. Replacing the configured input
path therefore cannot silently change the runtime identity of an already
running process.
On the supported Linux/x64 Worker path, `/usr/bin/setpriv`, `/bin/sh`, and
Linux `/proc` are also required: the child is bound to the Bun Host's lifetime
and its TCP listener must belong to that exact child. If these prerequisites
are missing, Worker serving fails closed; the Host's storage paths do not
require them.

A Worker that declares static assets gets them through Host-private asset
services; no native `ASSETS` binding is exposed to tenant code.
`runWorkerFirst` and `notFoundHandling` decide routing and fallback, so a
single-page application survives reload without adding an undeclared tenant
capability.

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
one action (`--status` or `--apply`, and on the credential surfaces their own
`--issue`, `--mint` and `--revoke`), an exact environment, and an exact 40-hex
commit; there is no mixed controller, plan, ledger, journal, or target override.
See [`docs/deploy.md`](docs/deploy.md) for the surface list, dependency order,
the clean-checkout integration target realization path, private inputs, and
failure rules. In particular, do not copy the retired
`.deploy/target.staging.json` shape into a current checkout: the current v2
target joins the Cloudflare supplies, executor, gateway, and receipt-authority
identities atomically. The landing-page details are in
[`docs/deploy-site.md`](docs/deploy-site.md).

The one-time public parent-credential handoff is owned by the private
composition's `takoserver-public-parent-token-retirement` surface, exported
through `@takoserver/core/deploy-extension`; it is deliberately absent from the
public contract above, so this checkout's `bun run deploy` refuses it. It
qualifies the exact route-less executor and public Worker closure, releases the
exact service binding if needed, then removes only the public
`CLOUDFLARE_API_TOKEN`; its value-free status is the sole
lost-acknowledgement/adoption path. It does not read or alter the executor's
owner-private credential file. Run integration first; rehearsal and production
remain separate target/source-qualified lanes.

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
nothing still gets a `WorkerEndpoint` where the selected installation derives
its own endpoint address. The managed Workers-for-Platforms provider derives
an opaque default label from the organization, Space and Worker name beneath
its configured managed base domain. Self-host and the ordinary-workers
adapter use their own endpoint suffixes. The Host reserves that derived origin
on the caller's behalf, in an id namespace the public routes refuse every
write to, and releases an old endpoint or advances a moved Worker revision
only under the existing ownership and absence fences.

A supplied chosen-name reservation still takes precedence; default-name
allocation never takes over a caller's live reservation. No extra Form field,
Host API header or provider configuration is needed to obtain a default URL.
Choosing a custom label is a separate control-plane flow: the current
Cloudflare public Host accepts that reservation through an admitted tenant-run
credential, not an ordinary organization key's Resource request. Preparing a
chosen-name reservation with an organization key alone does not attach it to
that key's subsequent WorkerEndpoint create.

The sensitive half of a Worker Version travels separately, over
`PUT|GET /v1/takoform/worker-runtime-input-preparations/{operationKey}` speaking
`takoserver.worker-runtime-input-preparation@v2`. The operation key is the exact
`Idempotency-Key` the ordinary public apply will carry, so one key names both
halves of the same mutation. The private request states this Host's own
canonical public origin and commits to the exact public apply it authorizes —
method, path, `If-None-Match: *`, and body — and Takoserver recomputes that
commitment and echoes it back, so a caller can prove the Host bound the values
to the request it meant. A `resources:write` organization API key retains the
organization-wide preparation surface. The self-host runner instead reuses its
already-admitted tenant-run credential for `PUT|GET`: Takoserver opens the exact
create-only WorkerVersion apply, pre-binds the handoff to its Space, and returns
`operation_not_found` for an unknown or different Space. `DELETE` remains an
organization-key operation. Replaying the key with a different apply or
different values is a conflict, not an overwrite. The provider lease claims
that exact identity before any asset or Worker Version mutation, erases
ciphertext in the dispatch CAS, and settles only after provider readback. `GET`
is the value-free recovery read: it never returns a value and never asks the
caller to send the secrets a second time.

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
All recorded decisions are indexed in [docs/adr/](docs/adr/README.md).

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

Provider embedders use the curated `@takoserver/core/provider-extension` source
export at their selected exact package/source pin. The shared Cloudflare adapter
does not construct the managed WfP implementation. Its managed `workerBackend`
selection supplies a synchronous `create(context)` factory, called once at
construction with the adapter's resolved identity, credential callback, artifact
reader and an independent cloned Offering snapshot. Namespace, gateway and
installation configuration stay in the operator's factory closure. A missing,
asynchronous, incomplete or wrong-kind backend is a startup error, never an
ordinary-Workers fallback; the deprecated ordinary endpoint suffix cannot be
combined with that factory.

Ordinary Cloudflare Worker writes are disabled by default. A development harness
must explicitly select `workerBackend: { kind: "ordinary-workers",
allowDevelopmentWorkerWrites: true }` to create or update Workers through this
adapter; a `workerEndpointSuffix` alone does not enable writes. Existing
WorkerVersion operations may still recover by readback without that opt-in, and
legacy Workers remain observable and deletable. Managed customer `ModuleWorker`
supply on Cloudflare requires the separately supplied Workers for Platforms
backend, not ordinary account Worker scripts or `workers.dev`. This boundary does
not itself qualify that managed backend or admit its Forms.

Mutation failure codes do not prove that nothing changed. A Provider may return
`failedWithoutProviderMutation(operationId, code, message)` from this extension
entry only when its exact initial call accepted no native mutation. The proof
is bound to that returned ticket object and operation id; cloning, serialization
and later polling do not carry it. Other failures retain the operation for
reconciliation, including non-retryable failures and exceptions after entry.
An earlier runtime-binding callback or SQLite migration also prevents a later
provider-only refusal from proving the whole attempt idle. When the attempt is
provably idle, its wallet hold and failed-operation cleanup commit together;
otherwise the hold stays with the recoverable operation.

An embedding that implements `TakoformResourceDriver` directly can use
`ProviderMutationDefinitiveRefusalError` from `@takoserver/core` for its own
initial pre-effect rejection. Provider Pack methods use the returned-ticket
helper instead; throwing that class from a Provider method is not proof.
Neither helper adds a field or version to the public Takoform API.

The separate `@takoserver/core/provider-extension/selfhost` entry exports the
experimental `createDockerHttpRevisionRuntime` and `createSelfhostContainerRuntime`.
Node/filesystem adapters stay out of the portable `provider-extension`, which
exports the runtime-neutral `createHttpRevisionServing` coordinator.
The Docker primitive reconciles an application-selected image
pinned by SHA-256 on an operator-selected Docker socket and isolated network,
with explicit memory, CPU and PID ceilings. Exact revision names and labels
allow recovery without creating a second container; old and new revisions may
coexist, and deletion addresses only the selected native revision. Its caller
must still own resource admission, desired revision, traffic cutover and
retirement. The opt-in self-host composition connects these responsibilities
to the existing Host lifecycle for a caller-selected, verified exact
`ContainerService@0.1.0` Form. The current released Form catalog contains no
ContainerService: configuring Docker alone does not publish, install, activate
or offer one. The local Form-only qualification fixture is unpublished and
does not provide a portable HTTP Interface or Binding. See
[local Container backend](docs/provisioner.md#local-container-backend-source-qualification)
for configuration and the remaining publication boundary.

This is an in-process composition seam, not another Host API or serialized
credential format. The public Worker imports only the credential-free executor
RPC port and pure wire validation; the execution authority stays behind the
operator's route-less executor. Concrete WfP runtime and its dedicated deploy
surfaces belong to the non-public implementation, not this package. The
`@takoserver/core/deploy-extension` export shares deploy primitives without
copying the Host's lifecycle code. The `@takoserver/core/testing` export supplies
shared composition fixtures to downstream conformance tests; neither export
defines another network API or Form version.

Existing shared D1 migration history remains here, with one schema owner. A
managed extension may bind that same operator-selected database, but it does
not copy the migration lineage or become a second schema writer. Source
separation alone is not proof of a deployed managed installation.

Workflow Host embedders have three separate source-library entries:
`@takoserver/core/workflow-runtime` exposes the platform-neutral coordinator and
ports; `@takoserver/core/workflow-runtime/transport` exposes an in-memory,
one-use frame journal, HTTP turn controller, and existing bundled trusted
bootstrap source/digest to Host adapters;
`@takoserver/core/workflow-runtime/workerd` exposes trusted Bun/Linux guarded
execution, resolved-Version graph compilation and selected-Version preparation.
None is a provider extension or an app-facing Binding.
See [Workflow runtime](docs/workflow-runtime.md#host-runtime-library-entrypoints)
for selection and lifecycle responsibilities. These entries do not ship a
managed companion image, enable Workflow support, or change any API/Form version.

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

### Self-host and OpenTofu interoperability

`bun run test:selfhost-opentofu` is a separate native integration journey. It
starts the real Bun Host, signs in with a fresh local operator key, creates an
organization API key, and admits the signed Form closure through the real Core
verifier. OpenTofu then creates an EdgeKVNamespace and SQLiteDatabase, checks a
no-change plan, compares exact Form identities and UIDs with the Host, and
destroys both resources. Success requires empty state and Host absence.

Prepare OpenTofu **1.12.5**, an unpacked filesystem mirror containing
`registry.terraform.io/tako0614/takoform` **4.0.0**, and a verifier binary built
from this checkout's `services/takoform-core-verifier`. Verify those artifacts
before use; the verifier's reported build-context digest is not a binary hash.
From a disposable Linux network namespace with only loopback enabled, run:

```sh
bun --no-env-file run test:selfhost-opentofu \
  --tofu /absolute/path/to/tofu \
  --provider-mirror /absolute/path/to/provider-mirror \
  --core-verifier /absolute/path/to/takoform-core-verifier
```

Ports 8787 and 8080 must be free in that namespace. The command refuses external
network interfaces, uses only fresh temporary state, and neither downloads
tools nor reads existing operator credentials. It prints phase names and a
sanitized result, stops its children and removes temporary state on exit.
Failed mutations are not retried.

To include actual Worker execution, supply both `--workerd` and `--openssl`:

```sh
bun --no-env-file run test:selfhost-opentofu \
  --tofu /absolute/path/to/tofu \
  --provider-mirror /absolute/path/to/provider-mirror \
  --core-verifier /absolute/path/to/takoform-core-verifier \
  --workerd /absolute/path/to/closed-graph-workerd \
  --openssl /absolute/path/to/openssl
```

Use the exact closed-graph workerd artifact accepted by this checkout, not the
npm development binary. This mode also needs port 443 and permission to bind it
inside the disposable namespace. It generates a temporary `*.app.localhost`
certificate, configures the real Host's Worker TLS socket, and creates ModuleWorker, WorkerBundle,
WorkerVersion, WorkerDeployment and WorkerEndpoint through the same Provider.
The bundle is uploaded by the Provider, not installed directly into the runtime.
SQLiteMigrationSet and SQLiteMigrationApplication create the application table
through their normal lifecycle before the Worker is activated; the command does
not seed the database directly or let runtime bindings execute schema DDL.
The HTTPS request checks actual KV and SQLite operations through the declared
bindings. The client trusts only the generated certificate and connects to
loopback with the Host-assigned hostname; it changes no machine trust or DNS.
Ready checks use the no-change plan's refreshed `prior_state` and a separate
Host read, not the potentially stale state saved before dependent resources existed.
All nine resources must then be removed through OpenTofu, with empty state and
Host absence. The former endpoint must no longer serve the application.

Without the two extra arguments, the command retains the storage-only journey.
Neither mode qualifies Cloudflare, Containers or a production deployment.

## Licence

[GNU Affero General Public License v3.0](LICENSE).

Run it, host it, change it, sell it. The one obligation is the one that matters
for something people reach over a network: if you offer a modified takoserver as
a service, its users are entitled to your modifications. Self-hosting for
yourself carries no such duty.
