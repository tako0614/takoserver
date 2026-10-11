# Changelog

All notable changes to Takoserver are recorded here. Takoserver has its own
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) stream; it is not
released in lockstep with other Takos products. Numbers in parentheses are pull
requests in `tako0614/takoserver`. Each section is published verbatim as the
GitHub Release notes of its tag (see [docs/release.md](docs/release.md)).

## [2.0.0-rc.1] - Unreleased

The first release candidate of Takoserver 2.0.0, published as a GitHub
pre-release so that operators can try the v2 install path before 2.0.0 is
final. 1.0.0 stays the latest release and keeps its security support until
2.0.0 is released ([SECURITY.md](SECURITY.md)). Release candidates receive no
backported fixes; report problems against the candidate and expect them fixed
in the next candidate or in 2.0.0.

Takoserver 2.0.0 is a Takoform **Host API v2** Host. It is a breaking major
release: the Takoform lanes that 1.0.0 served are gone, a self-host that was
used under 1.0.0 is not upgraded in place, and the Bun self-host needs explicit
configuration before it starts. This candidate covers about 1,550 commits and
the pull requests merged since 1.0.0 (2026-08-20), from #13 onwards.

### Release assets

- `workerd-closed-graph-2026-08-11-linux-x64`: the pinned closed-graph
  workerd, the only binary the Host accepts as `TAKOSERVER_WORKERD_BINARY`.
  SHA-256 `c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`,
  273,943,488 bytes, `workerd --version` prints `workerd 2026-08-11`. Linux
  x86-64 with glibc 2.38 or newer. It is upstream `cloudflare/workerd` with
  Takoserver's closed-module-graph patches, distributed under
  AGPL-3.0-or-later; it is not an official Cloudflare build.
- `workerd-closed-graph-2026-08-11-notices.tar.gz`: the upstream Apache-2.0
  license, the modification notice, the AGPL-3.0 text, the patches, the
  Corresponding Source directions and the third-party notices for that binary.
- `SHA256SUMS` for both files.

The Workflow execution guard is not attached; build it from this tag with the
reproducible command in [docs/release-assets.md](docs/release-assets.md), which
gives SHA-256 `67709482e9d49b1df1af483f210a5038f1e0a2689f805adb33d5cfc76b2b0b20`
for this guard source. The attached workerd was built outside CI and has not
been reproduced in a second environment yet; verify it as described there
before use.

### Breaking changes

- **A used 1.0.0 self-host is not upgraded in place.** At startup the Bun Host
  reads an existing control database read-only, before any migration write,
  and refuses one that records wallet ledger history, a v1 Takoform Resource
  or a live v1 provider Deployment. It names the data root, says the database
  is unchanged, and exits with status 1. Install 2.0.0 alongside on a new data
  root and recreate Resources through the v2 API; no tool converts v1 records
  or copies ObjectBucket data. A 1.0.0 database that was only booted or signed
  in to still migrates in place, after which 1.0.0 refuses it, so take a cold
  copy first. Follow
  [Upgrading from v1.0.0](docs/self-host-operations.md#upgrading-from-v100).
  (#284)
- **Takoform Host API v2 only.** The normal application mounts only
  `/.well-known/takoform/v2` and `/apis/forms.takoform.com/v2`. The
  `v1alpha3` and `v1beta1` lanes that 1.0.0 served are removed, and so is the
  stable `v1` lane that unreleased builds served between the two releases.
  Requests are never translated between versions. v2 Resources are addressed
  by UID, owned by an Organization (its ID is the v2 Space), and errors use
  `application/problem+json`. The product APIs under `/v1` (sessions,
  organizations, API keys, wallet, reseller, AI) remain. (#31, #195, #197)
- **No released Takoform provider can manage a 2.0.0 Host.**
  `terraform-provider-takoform` 4.1.0 and earlier speak only Host API v1, so
  OpenTofu/Terraform configurations written for 1.0.0 do not work against
  2.0.0. Use the v2 HTTP API or the Console. (#282)
- **The S3 credential route is removed.**
  `POST /v1/organizations/{organizationId}/resources/{resourceUid}/s3-credentials`
  no longer exists. Object storage is reached by a Worker through the exact
  ObjectBucket Binding
  ([ADR 0005](docs/adr/0005-object-storage-is-an-exact-objectbucket-binding.md),
  [ADR 0007](docs/adr/0007-objectbucket-joins-the-implementation-catalog.md)).
- **The Bun entry needs three settings and an HTTPS origin.** Startup stops
  without `TAKOSERVER_PUBLIC_ORIGIN` (a canonical bare `https://` origin; 1.0.0
  defaulted to `http://localhost:8787`), `TAKOSERVER_TAKOFORM_V2_CONFIG` and
  `TAKOSERVER_TAKOFORM_V2_CURSOR_KEY` (at least 32 random bytes, unpadded
  base64url, kept stable). The Bun listener speaks plain HTTP, so a TLS front
  end is required for public use. (#197)
- **The Bun entry no longer uses a Cloudflare account as its provider.**
  `TAKOSERVER_D1_DATABASE_ID`, `TAKOSERVER_R2_BUCKET` and `TAKOSERVER_ZONES`
  are refused at startup; control state is local SQLite. The retired
  Cloudflare ObjectBucket provider runs only in the explicit
  `TAKOSERVER_RETIRED_PROVIDER_MODE=cloudflare-object-bucket-drain` mode, which
  observes and deletes recorded Deployments. Do not apply 2.0.0 migrations to a
  1.0.0 D1 database.
- **Worker execution needs the pinned closed-graph workerd.** 1.0.0 fell back
  to the npm `workerd` in `node_modules`. 2.0.0 runs Workers only with the
  exact patched binary (SHA-256
  `c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`) named by
  `TAKOSERVER_WORKERD_BINARY`, and Workflows also need
  `TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY`. Anything else disables Worker
  execution; it never falls back. The binary is attached to this release; see
  [docs/release-assets.md](docs/release-assets.md).
- **The API listener binds `127.0.0.1` by default.** 1.0.0 bound every
  interface. Set `TAKOSERVER_LISTEN_HOST` (one canonical IP literal) to change
  it; inside a container or Pod use `0.0.0.0` or `::` and restrict access with
  a network policy or firewall. The startup banner changes from
  `takoserver listening on :8787 as …` to
  `takoserver listening on 127.0.0.1:8787 as …`. (#286)
- **Operator sign-in assertions are single-use and printed only until the
  operator exists.** After an assertion opens a session, reusing it for
  `POST /v1/sessions` returns 401. Startup prints an assertion only until the
  first successful sign-in; afterwards mint one with
  `bun scripts/operator-key.ts sign-in google operator operator@localhost Operator`,
  or set `TAKOSERVER_PRINT_OPERATOR_ASSERTION=1`. (#286)
- **Invalid values stop startup.** `TAKOSERVER_LISTEN_HOST` accepts only IP
  literals and `TAKOSERVER_PRINT_OPERATOR_ASSERTION` only `1` or `0`; other
  values exit before any state opens. (#286)
- **`TAKOSERVER_DATA_ROOT` is resolved once, and its length is bounded.** The
  configured root (default `.takoserver` in the working directory) is resolved
  to an absolute, canonical path at startup and printed when it differs. A
  missing root is created with mode 0700. With Actor or Workflow enabled the
  resolved root may be at most 61 bytes and `TMPDIR` at most 73 bytes, because
  Unix socket paths are limited to about 100 bytes. An explicitly configured
  feature that does not fit stops startup with the variable, its length and
  the maximum; the implicit public Actor is disabled with a diagnostic. The
  root and its ancestors must not be writable by other users. (#281)
- **Toolchains: Bun 1.4.0 and Go 1.26.** `.bun-version` pins Bun 1.4.0. The Go
  modules (`provider`, `services/takoform-core-verifier`,
  `services/workflow-execution-guard`) select `toolchain go1.26.9`; building
  them needs Go 1.26.9 or `GOTOOLCHAIN=auto`, and the Go checks need Go 1.26.0
  or newer. The verifier image builds on `golang:1.26.9-alpine3.23`. (#84,
  #283, #288)
- **Readiness reports more as `degraded`.** `GET /_takoserver/health/ready` is
  new since 1.0.0 (#160). For operators who adopted it from a pre-release
  build: the body gains `v2Workers`, `backlog` (v2 Operations and Queue batches
  unsettled for more than 600 seconds of uptime) and `backgroundPasses`
  (failing and stalled counts). These set `degraded: true` and keep status
  200; the 503 conditions are unchanged. A probe that treats any `degraded`
  answer as down sees it more often. (#277, #285)

### Added

- **Takoform Host API v2.** Discovery, authenticated exact-Form support
  queries, Resource create/list/read/update/delete by UID, Operations, and
  private inputs, with durable acceptance, principal-scoped replay, generation
  fences and claim-fenced reconciliation. Organization API keys are scoped
  `resources:read` or `resources:write`. (#195, #196, #197, #215, #217)
- **Artifact Forms.** `SQLiteMigrationSet 0.2.0`, `WorkerBundle 0.2.0` and
  `StaticAssetBundle 0.2.0` validate and retain operator-held bytes, on both
  the Bun and Worker entries. (#196, #198, #200)
- **Complete local Worker profile on the Bun self-host.** When the pinned
  workerd, the Workflow guard, Actor and Workflow boot, and all five private
  planes are configured, the Host registers `ModuleWorker 0.3.0`,
  `WorkerVersion 0.5.0`, `WorkerDeployment 0.4.0`, `WorkerCronTrigger 0.3.0`,
  `SQLiteDatabase 0.2.0`, `EdgeKVNamespace 0.2.0`, `ObjectBucket 0.2.0`,
  `ActorNamespace 0.3.0`, `DurableWorkflow 0.3.0`, `AtLeastOnceQueue 0.2.0` and
  `QueueConsumer 0.3.0`, plus `SQLiteMigrationApplication 0.2.0` and
  `WorkerEndpoint 0.3.0` (HTTPS on TCP 443) when configured. A partial setup
  registers none of them. Worker Versions bind SQLite, KV, ObjectBucket, Queue
  Producer, Service, Actor and Workflow. (#199-#213, #216-#280)
- **Crash and restart recovery** for Deployments, Endpoints, Queues and Cron:
  the Host boots after a stop during an Operation, retires abandoned
  candidates, and settles them `failed` with effect `none`; Queue batches whose
  retirement failed are retried from their handler receipt. (#211, #222, #228,
  #276, #278, #279)
- **Operator artifact CLI.** `scripts/selfhost-artifact.ts seed|verify` seeds
  Worker bundles, static asset bundles and SQLite migration sets into a stopped
  data root and prints the matching config fragment. (#287)
- **Health probes.** `GET /_takoserver/health/live` and
  `GET /_takoserver/health/ready` on the API port. (#160, #277, #285)
- **Console on Takoform v2**, with paginated resource lists. (#119, #120,
  #214)
- **Takos ID sign-in** (`TAKOS_ID_ISSUER`, `TAKOS_ID_CLIENT_ID`), included and
  purchased credit lots, and Stripe Checkout that stays off unless explicitly
  enabled. (#18, #26)
- **Takoform v2 conformance.** Takoform's Host API v2 HTTP probe is vendored
  byte-exact and runs against a real Bun Host in `bun run check`; an opt-in
  native lane covers the Worker profile's reference-free Forms. (#282)
- **Generated contracts.** The OpenAPI document is projected from one route
  table and the error taxonomy is generated. (#71, #72)
- **Operator documentation:** [self-host operations](docs/self-host-operations.md)
  (install, update, upgrade from 1.0.0, monitoring, backup and restore),
  [self-host security](docs/self-host-security.md),
  [Takoform v2 operator setup](docs/takoform-v2.md),
  [release assets](docs/release-assets.md) and the
  [release runbook](docs/release.md).

### Changed

- **Managed (Cloudflare) deployment.** Parent Cloudflare credentials moved to
  a route-less provider executor and the public token was retired (#86, #87);
  sponsorship issuance is a separate authority (#89); production D1 migrations
  run as resumable waves (#77); fresh v2 storage lineages exist for production
  and integration (#126, #193, #289). Every surface is driven by
  `bun run deploy` ([docs/deploy.md](docs/deploy.md)).
- **Migrations 0016 to 0090** are new. They are forward-only; the Bun Host
  applies them at startup.
- **Workers AI** responses are normalized and request bodies are bounded at
  1 MiB. (#93, #95)

### Fixed

- A relative or symlinked data root crashed the private plane and left
  Deployments silently `reconciling` when socket paths overflowed; per-boot
  `/tmp/tw-*` directories no longer accumulate. (#281)
- A Host stopped during a Deployment or Endpoint Operation failed every later
  boot with `ownership_uncertain`. (#279)
- A finished Queue batch whose retirement failed kept its Consumer occupied
  until restart. (#278)
- `Takoform-Expected-Generation: 0` returned 400 instead of 409
  `generation_conflict`. (#282)
- A short external read of the control database failed Host writes; it now
  waits up to 5 seconds (`busy_timeout`). (#277)
- An external `TAKOSERVER_DB` reached through a symlink was not detected by the
  1.0.0 refusal. (#287)
- workerd child lifetime and listener ownership, and draining of requests and
  owned processes before exit. (#170, #188)
- Unfunded usage was marked billed. (#18)
- A Host that died between claiming a Queue batch and authorizing its send
  left the message leased: the expired-lease refund statement was missing a
  closing parenthesis and failed with `incomplete input`, so the Consumer
  stalled until message retention deleted the message. The refund works, the
  Host refuses unsent reservations left by an earlier process before it
  listens, and a failing batch selection is reported on stderr. (#291)
- Native test lanes: socket roots stay within the Unix path limit under a long
  `TMPDIR`, and native fixtures follow the Cron, render-guard and dispatch
  changes (tests only). (#292)
- A Host killed while it was writing its runtime owner state or an execution
  group's retirement receipt left the private temporary file behind, and every
  later boot refused the Worker with `ownership_uncertain` until an operator
  removed the file by hand. The successor now discards that interrupted write
  under the lock it took from a proven-dead owner, and only for an exactly
  named, owner-only, singly linked regular file; anything else is still
  refused. (#296)
- Module inspection ran `chmod 0700` on the system temporary directory. A
  dedicated service user (the documented install) got `EPERM`, so every
  WorkerVersion stayed `reconciling` and nothing was logged; as root it
  changed `/tmp` for every user on the machine. The system directory is now
  only the parent of a private directory. (#293)
- Boot printed a note advising `TAKOSERVER_WORKERD_PORT=443` next to the v2
  listener, where startup refuses that setting. (#293)
- A WorkerEndpoint requested before its Worker's Deployment deadlocked: the
  Endpoint stayed `reconciling`, a later Deployment waited behind it and
  DELETE of either returned `409 resource_busy`. It is now refused at
  acceptance with `409 dependency_conflict` whose `detail` names the missing
  Deployment, and nothing is stored. One that an earlier Host accepted settles
  `failed` (`worker_deployment_missing`) after the upgrade, and the Deployment
  behind it publishes. (#295)
- Legacy `edge.sql` facade calls from a self-host Worker were refused with
  `backend_unavailable`: the generated wrapper streams the SQL body, and the
  self-host data plane required `Content-Length`. The SQL route now also
  accepts exactly `Transfer-Encoding: chunked` under the same 40 MiB ceiling;
  KV and Queue still need a declared length that matches. (#294)

### Security

- Reachable Go advisories fixed: GO-2026-6443 and GO-2026-6348 (grpc v1.83.2),
  and GO-2026-6603, -6611, -6612 and -6617 (golang.org/x/net v0.60.0), in
  `provider` and `services/takoform-core-verifier`. CI now runs govulncheck on
  every Go module. GO-2026-5932 (x/crypto/openpgp) has no fix and is not
  reachable. (#283, #288)
- npm advisories: the runtime dependency drizzle-orm moved to 0.45.2 or
  later (#28). In the development toolchain, `undici` (GHSA-3wwx-pv8p-q78v,
  through miniflare) and `sharp` are overridden to patched versions. A
  separate dependency-audit workflow fails on findings. (#82, #122)
- Self-host defaults: loopback listener, single-use operator sign-in
  assertions, and a documented trust boundary
  ([docs/self-host-security.md](docs/self-host-security.md)). (#286)
- Tenant Workers run in a workerd build with a closed module graph: a tenant
  module cannot import the Host-private modules in the same process
  ([workerd/README.md](workerd/README.md)).
- Malformed billable AI results are rejected before billing. (#106)
- Deploy tooling rejects an API-key output directory that aliases into the Git
  worktree. (#194)
- [SECURITY.md](SECURITY.md): security fixes go to the latest release of the
  current major line; 1.0.0 support ends when 2.0.0 is released.

### Known limitations

- **Hosted / Workers for Platforms is not live-qualified.** The managed
  backend is composed in the private `takoserver-private` repository. The v2
  canonical Hosted path became runnable on a fresh integration environment in
  source (#289), but it has not been run live, and this release does not imply
  a production rollout.
- **The attached closed-graph workerd is not built by CI.** All five
  `workerd-closed-graph-build` workflow runs failed (toolchain prerequisites,
  time limits, and one completed build whose digest was not the pinned one).
  The attached bytes come from one build on the operator's development host
  that matches the pin; no second environment has reproduced them. Verify the
  SHA-256, or build it from source
  ([docs/release-assets.md](docs/release-assets.md)). It runs only on Linux
  x86-64 with glibc 2.38 or newer, and it is pinned to upstream workerd
  `2026-08-11`: upstream fixes after that date need a new pinned artifact.
- **The Workflow execution guard has no Host-side digest pin**; it is built
  from the release checkout.
- **Single host only.** A data root belongs to one machine; there is no
  clustering, failover or network-filesystem support.
- **Backups are cold copies of a stopped data root.** The measured restore is
  to the same path on the same machine. Restoring an external
  `TAKOSERVER_DB`, to another path or machine, with pending work, or as an
  operator disaster-recovery drill has not been measured.
- **The native journey does not cover** a `scheduled` handler, Actor or
  Workflow use, public DNS or certificate trust, a host reboot, or Hosted/WfP.
  Some Deployment/Endpoint states still stop boot with `ownership_uncertain`
  and need manual repair
  ([known gaps](docs/self-host-operations.md#ordinary-journey-native-test-and-known-gaps)).
- **Tenants are separated by V8 isolates only.** Every workerd child runs as
  the Host's user and inherits its environment; do not host mutually hostile
  tenants on one machine.
- **One native lane is a documented failure.** The
  `workerd-native-workflow-facets` qualification probe is expected to fail.
  A Queue batch that was already sent when its Host died still waits up to
  120 seconds for its message lease.
- **One Deployment per Worker.** A second WorkerDeployment for a Worker that
  already has one is still accepted, then stays `reconciling`
  (`publication_conflict`) and blocks that Worker's later publications, and
  DELETE of it is refused. Change a Worker by updating its Deployment. A
  second WorkerEndpoint that an earlier Host accepted has the same limit; new
  ones are refused at acceptance.
- **Actor rotation waits for the carrier to be idle.** A graph change that
  arrives while an Actor carrier is serving a request, a stream, an admitted
  alarm or an accepted socket is refused with a retryable answer, and a
  long-lived socket delays the rotation until it ends
  ([Takoform v2](docs/takoform-v2.md)).
- **Conformance is a baseline.** The vendored v2 probe comes from an untagged
  Takoform commit (`ba0bf1c`); a pass covers only its mandatory sequence, not
  restarts, faults, concurrency or cross-principal authorization.
- Container Forms are local, unpublished candidates and are not advertised.
  There is no metrics endpoint.

## [1.0.0] - 2026-08-20

The first generally available release: a provider-neutral Takoform Host
(`v1alpha3` and `v1beta1` lanes) with Offerings, Deployments, Attachments and
Migrations; prepaid wallet billing and metering; S3 credentials and an
OpenAI-compatible AI API as ordinary data APIs; Cloudflare R2, D1, KV, Queues
and Workers production adapters; the public API and Console; and a fail-closed
owning deploy surface.
