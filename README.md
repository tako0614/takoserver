# Takoserver

Takoserver is an independent prepaid resource platform. A customer signs in
directly with Google or GitHub, creates a Takoserver Organization and scoped API
keys, funds a USD wallet, reserves a catalog offering, and receives a
short-lived execution grant. It does not import or delegate identity, billing,
or runtime authority to another product.

Funding never accepts a caller-authored amount or settlement reference. Only
the Organization owner may submit an opaque proof, and an injected settlement
verifier supplies the immutable USD amount and provider reference.

The product concentrates behavior behind a small set of deep interfaces:

- `TakoserverModule.execute` owns accounts, authorization, catalog, the
  append-only wallet ledger, quotes, reservations, settlement, and usage.
- `ResourceRuntime.execute` consumes a single-use signed grant and dispatches
  the offering selected by that grant.
- `BackendAdapter` hides provider lifecycle details. Portable fake and
  Cloudflare R2 implementations prove that product authority is not tied to one
  cloud provider.
- `ObjectStorageModule` and `AiGatewayModule` expose resource-scoped data
  planes. Each request consumes a signed intent-bound grant before provider I/O;
  provider credentials and raw errors remain inside adapters.
- `TakoformHost` exposes the current versioned portable resource lifecycle as
  one integration surface. `BackendTakoformResourceDriver` resolves exactly one
  available offering for the exact FormRef and carries create, observe, import,
  and delete into the same provider-neutral backend lifecycle. It is not
  Takoserver's product boundary.
- `createHttpHandler` exposes the direct Console and the versioned HTTP
  contract.

No balance counter is authoritative. Wallet projections are recomputed from
ledger entries: funding changes settled value, reservation changes held value,
and capture atomically removes and debits the full reviewed quote. Grant
issuance never charges. The trusted provisioning committer records the exact
resource registration and captures only after provider success; its replay is
idempotent. Expired and explicitly released reservations return the hold once.

## Public surfaces

- Direct product discovery: `GET /.well-known/takoserver`
- Identity providers: `GET /v1/identity/providers`; session exchange:
  `POST /v1/sessions`
- Organizations, API keys, wallet, catalog, resource, reseller, and usage routes
  under `/v1`
- OpenAPI 3.1: [`openapi/takoserver.openapi.json`](openapi/takoserver.openapi.json)
- Resource-scoped object storage: `/v1/storage/object` and
  `/v1/storage/objects`
- OpenAI-shaped AI gateway: `/v1/ai/models` and
  `/v1/ai/chat/completions`
- Released provider discovery: `GET /.well-known/takoform/v1beta1`
- Released provider Host API: `/apis/forms.takoform.com/v1beta1`
- Current Takoform discovery: `GET /.well-known/takoform/v1alpha3`
- Current Takoform Host API: `/apis/forms.takoform.com/v1alpha3`

The two versioned mounts share one Host engine. HTTP lane versions are adapted;
exact FormRef values are not rewritten. This keeps provider `2.1.1` usable while
the independently versioned current Host contract remains available.

The Takoform Host owns exact Form availability/definitions, validate and
reviewed prepare, fenced create/update/read/import/observe/delete, synchronous
operation endpoints, tenant-held content-addressed artifacts, and support
profiles. The unversioned legacy discovery/API is deliberately absent.

Reseller requests identify the reseller's customer only by opaque `tenantRef`.
They never accept an upstream product's user or workspace identity. The signed
grant contains only the internal security domain, tenant reference,
reservation, exact offering snapshot digest, operation, issuer, audience,
lifetime, and replay identifier. The runtime checks that snapshot before any
provider I/O.

Catalog `s3` and `openai` allowances describe which direct data protocol an
offering may expose. They are not credentials or grants. Object bodies and AI
requests are bound into signed execution intents, isolated by opaque tenant and
resource references, bounded before provider access, and covered by portable
in-memory plus Cloudflare R2 or injected AI adapter tests.

Backend logical addresses include the opaque tenant reference before space and
name. The Cloudflare adapter derives its R2 bucket identity from that complete
address, so equal user-facing names in separate Organizations do not alias.
Provider credentials, native error bodies, and account identifiers never cross
the adapter receipt.

## Development

Requires Bun.

```bash
bun install
bun run check
```

Focused commands are `bun test`, `bun run typecheck`, `bun run fmt:check`, and
`bun run build`. `bun run openapi:write` is the explicit writer for the checked
OpenAPI artifact.

### Cloudflare Worker durability slice

[`wrangler.jsonc`](wrangler.jsonc) is a target-neutral Workers configuration
with generated `Env` bindings for D1 `STATE_DB` and R2 `OBJECTS`. It omits
account-specific resource IDs, production routes, secrets, and realized
configuration. Regenerate the checked type artifact after changing bindings:

```bash
bun run worker:types
```

The complete durable path in this slice is object storage. Each request loads
active Ed25519 public verification keys, verifies and consumes the grant replay
identifier in D1, then resolves the exact resource registration with the signed
security-domain ID plus the requested tenant/resource references. It checks the
registration's reservation, offering, `cloudflare-r2-binding` backend, and `s3`
allowance before using the R2 Worker binding directly. There is no Cloudflare
REST object path and object responses stay streamed. D1 statements bind at
most three parameters; expired replay cleanup is bounded to 64 rows.

[`migrations/0001_runtime_storage.sql`](migrations/0001_runtime_storage.sql)
creates only the runtime verification-key, replay, and resource-registry
tables. The registry row shape is `(organizationId, securityDomainId, tenantRef,
resourceRef, reservationId, offeringId, offeringDigest, backendId, nativeId,
allowances)`. This repository
does not yet expose a registry writer: the future durable resource-provisioning
owner must populate it through a separately reviewed authority-bearing path.

`bun run check` verifies generated bindings, both Bun and Workers type worlds,
the migration on a disposable local D1 database, a strict Wrangler dry-run,
bundle absence of Cloudflare REST/credential surfaces, and Worker startup
profiling in a disposable output directory. It never selects a Cloudflare
account or remote resource.

Inspect the deploy contract without side effects:

```bash
bun run deploy -- --contract
```

There is intentionally no live deploy path. Every deploy invocation except the
exact `--contract` probe refuses before Wrangler, credentials, or a target can
be accessed. A reviewed owning command still needs target preflight, migration
lineage/readback, immutable Worker provenance, key provisioning, reversal, and
end-to-end post-conditions before it may mutate Cloudflare.

## Current limits

The main product control plane (identity, Organizations, API keys, wallet,
ledger, quotes, reservations, settlement, and grant issuance), Takoform resource
state, and artifacts are still in-memory reference implementations. The Worker
therefore returns 503 for those control-plane routes and advertises only the
durable object-storage slice. D1 key/resource provisioning, full key rotation,
a concrete payment-provider settlement adapter, OAuth network adapters, the
complete official Takoform conformance runner, live-D1 verification, recovery
drills, and production operations remain required before release. No
production configuration, secret, provider ID, or deployment evidence belongs
here.
