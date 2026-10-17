# Hosted Portable Sample Acceptance

`bun run staging:wfp-hosted-e2e` prepares and exercises a synthetic community
application through Host API v2. It creates 100 members, 20 rooms, 1,000 posts
and 20 attachments. It does not deploy Host, gateway or provider components.
The application uses portable `execute/query/transaction`, EdgeKV metadata and
TTL, ObjectBucket CRUD/range/conditional/multipart, and Service `fetch`.
It does not fall back to native D1 `prepare/batch` or native R2/KV interfaces.

## Preconditions

Use this only after the upload/Tail repair and the reviewed mixed staging
topology are published by their deployment owners. The target must expose the
exact 12 TIER 1 Form URLs selected by this source's exports, including hosted
SQLiteMigrationApplication. Unsupported support responses stop before writes.
The v2 package publication and client adoption belong to the Takoform owners;
this harness does not publish Forms or add v1 compatibility.

The operator must bind the Host/gateway/native namespace to the reviewed
staging commit and artifact receipts, and complete the deployment contract's
independent review and pre-mutation proof. Keep these receipts outside Git.
Select the existing fixed integration Host/executor profile and its qualified
native publication path, including the applied schema and M domain grant.
A recovery-only profile cannot create this fresh graph. Its owning deployment
must validate literal `integration-` or `staging-` prefixes on the actual Host,
executor, gateway, receipt, inspector and Tail scripts, dispatch namespace,
D1 database, R2 bucket, service bindings and exact route hosts. Any Container
or app dependency requires its own owner's qualified prefixed destination;
this sample does not create or qualify Containers or apps.

The control origin and logical Resource names do not prove those native
destinations. Form discovery is not proof of the selected server's native
profile, source, grant or storage bindings. Use the existing deployment
owner's destination validation; the harness adds no public profile selector
or authority claim. This harness targets the fixed typed shared-origin staging
profile. It first reserves an original through the authenticated business API,
then binds Endpoint readback to the accepted name, canonical Resource UID,
create Operation, organization Space and Worker reference. The expected
origin is derived locally as `https://<accepted-name>.app-staging.takos.jp`;
an arbitrary response URL or the older UID-only origin cannot select it.
The retained legacy UID helper is not a fallback for this journey.

The selected server must deliver the real carrier-to-shared-ledger bridge,
common physical primary/schema and existing native/source grants. A successful
legacy reservation projection alone does not prove that bridge. Local driver
mocks exercise only the HTTP protocol. The reservation's existing sold stable
ModuleWorker Offering must be eligible and its provider derive must return
this exact staging origin; a v2 backend ID is not an Offering. Supply an actual
eligible `--reservation-offering-id` if needed. Otherwise the existing selector
must find exactly one eligible Offering. Operators with `catalog:read` can
inspect the existing authenticated `/v1/catalog?organizationId=<actual-org>`;
the harness does not assume the writer has that scope or mint a grant.
No production, billing, control-schema migration, direct provider deployment,
Cloudflare ticket, or raw control D1 SQL is part of this harness. The SQL file
is an artifact applied to a fresh application database through MigrationSet
and MigrationApplication.

## Prepare Immutable Artifacts

```sh
bun run staging:wfp-hosted-e2e --emit-fixture \
  --artifact-base-url=https://artifacts.integration.takoserver.com/sample/RUN/ \
  --output-dir=/tmp/wfp-sample-RUN
bun run staging:wfp-hosted-e2e --check-fixture \
  --fixture=/tmp/wfp-sample-RUN/fixture.json
```

Publish the emitted `worker/`, `service/`, `sqlite/` and `assets/` directories
through the authorized staging artifact owner, preserving paths and exact
bytes. Manifests include file digests; the fixture records manifest digests.
Emission refuses existing files. The live harness rebuilds the fixture from
its pinned source and rejects a mismatched document before authentication.
All Form identities come from this repository's v2 contracts. An artifact
source URL does not select or authorize native write destinations.

## Run

The CLI requires a clean committed worktree matching `--source-commit`.
Supply fresh scoped organization writer/evidence API key files, not the
Cloudflare operator token. Pass paths only; never print their contents.
`--space` is required and must be the actual organization ID for both keys.
The existing v2 account adapter authorizes `org:<id>` only for Space `<id>`;
the harness reads `/resources?space=<id>&limit=1` with each key before any
reservation or graph mutation. An empty successful list still passes through
that authorization. Failure or an inconsistent list stops before mutation.
No token text is decoded and the session-only `/v1/me` is not used. The writer
needs existing `resources:write`; evidence uses its existing Resource read
scope. Native storage bindings remain separate from this logical Space.

```sh
bun run staging:wfp-hosted-e2e --run \
  --fixture=/tmp/wfp-sample-RUN/fixture.json \
  --origin=https://integration-api.takoserver.com \
  --writer-secret=/operator/secrets/writer.secret \
  --evidence-secret=/operator/secrets/evidence.secret \
  --source-commit=FULL_REVIEWED_COMMIT_SHA \
  --space=ACTUAL_ORGANIZATION_ID \
  --run-id=sample-unique-run \
  --journal=/operator/evidence/sample-unique-run.jsonl \
  --output=/operator/evidence/sample-unique-run.json
```

Only HTTPS control hostnames beginning literally with `integration-` or
`staging-` under `takoserver.com` or `workers.dev` are accepted. An infix such
as `api.integration.takoserver.com` is refused. The example above does not
identify a deployed server; use the selected owner's exact qualified origin.
Discovery must advertise `forms.takoform.com/v2`
on the exact same origin. Redirects are refused, response reads are bounded,
and requests time out. Journal and output files are created once with 0600
permissions; an existing path prevents live mutation. Use a new unique run ID.
Preflight refuses any existing fixture Resource name before the first CREATE,
including old `wfp-<run-id>-` names in the selected Space. These read-only
checks never adopt or clean up the old Resource, or prove that an unknown
old acknowledgement is absent; recover that attempt from its original journal.
All existing 36 current/legacy name checks remain, with an additional check
for the actual bounded Endpoint name. Other Resource names and all graph
idempotency keys retain `integration-wfp-<run-id>-`. The Endpoint alone uses
`integration-<first-16-lowercase-SHA256-hex-of-run-id>-ep` (31 characters),
matching the typed allocator's at-most-32-character name bound even for a
64-character run ID. The run ID and name are captured once; a collision does
not choose another name. These labels and the authenticated Space do not name
the physical script, D1 database or R2 bucket. Never rewrite old journals,
keys or Resource IDs, or use the new prefix to adopt or clean up an old run.

Before graph CREATE the harness GETs the exact original reservation ID
`integration-wfp-<run-id>-origin` at the selected control origin. Any existing
reservation, permission failure or ambiguous absence stops; nothing is
adopted. It syncs the requested name, ID, 86,400-second carrier lease and
optional Offering ID before one PUT to the existing reservation route. A
201 projection and subsequent GET must match the prepared ID/name/revision,
future expiry and exact locally derived origin. An unknown PUT acknowledgement
halts without retry or speculative GET. The carrier lease may expire while
the permanent global original remains held; expiration is not reclaimability.

The journey creates the 12 Forms, checks the seeded scale and all attachment
bytes, exercises portable data bindings and a SQL-backed KV feed, and verifies
StaticAssetBundle GET/HEAD/range through WorkerVersion.assets. Service target
deployment updates must be visible without caller republishing. Caller and
target deployments then return to their original Versions, with SQL/object
data retained. Resource updates repeat the same spec; immutable artifact
replacement and bound data/Service deletion must be refused without changing
the Resource generation.

Cron acceptance requires two distinct slots during 130 seconds without Host
or app HTTP requests. The pinned handler records its actual invocation time
as well as scheduledTime. SQL, KV and ObjectBucket receipts must agree and
the invocation must fall inside that interval. A subsequent HTTP request
catching up an old schedule cannot count. The harness never manually invokes
scheduled. Duplicate delivery reuses the first SQL receipt's bytes.

Cleanup retires Cron first, deletes MigrationApplication and confirms its
deletion leaves application data intact, clears owned KV/object contents,
removes Endpoint and verifies route absence, then removes dependencies in
order. It records complete delete Operations and Host 404/410 readback.
Rollback changes selected deployment Versions; it is not a down migration.
After successful cleanup the synthetic data is intentionally deleted.
The original reservation and its global name hold are retained and recorded;
this harness never calls the legacy reservation DELETE, bind or activation
routes. This first selected carrier slice does not implement release, and a
legacy release cannot prove v2 drain or global-name reuse. Graph deletion and
route absence are not a claim that the global original has been released.

## Evidence And Failure

Successful output says `HOSTED_STAGING_SCENARIOS_PASSED`, records source and
artifact digests, Resource/Operation IDs, automatic slots, rollback IDs and
delete readbacks, accepted Endpoint name/UID/Operation and retained original
reservation. It does not assert complete launch qualification. Cross-org
boundaries, independent private native-owner absence, and the self-host Linux
and Docker runs are additional evidence. Record these separately in the
operator STATUS table; source, local tests, Miniflare and skipped native tests
must not be marked as staging PASS.

The journal is synced before each control mutation and immediately after
acceptance, so an unknown response retains the name, idempotency key and all
known IDs. An incomplete run exits nonzero and retains its graph/journal for
readback and forward repair. It does not retry CREATE/PUT/DELETE, force-delete
claims, change the control database or automatically clean up after failure.
Provider response bodies and credentials are not copied into diagnostics.
An acknowledgement timeout is not absence. Resume through the lifecycle owner
using recorded IDs and exact intent; do not rerun the mutation sequence with
a different journal path.

Queue, Actor, Workflow and CustomDomain journeys have separate owners and are
not exercised by this driver. This driver's PASS cannot replace their required
full-goal evidence, or hosted WfP, self-host Linux and Docker qualification.
