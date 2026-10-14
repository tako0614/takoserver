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
All Form identities come from this repository's v2 contracts.

## Run

The CLI requires a clean committed worktree matching `--source-commit`.
Supply fresh scoped organization writer/evidence API key files, not the
Cloudflare operator token. Pass paths only; never print their contents.

```sh
bun run staging:wfp-hosted-e2e --run \
  --fixture=/tmp/wfp-sample-RUN/fixture.json \
  --origin=https://api.integration.takoserver.com \
  --writer-secret=/operator/secrets/writer.secret \
  --evidence-secret=/operator/secrets/evidence.secret \
  --source-commit=FULL_REVIEWED_COMMIT_SHA \
  --run-id=sample-unique-run \
  --journal=/operator/evidence/sample-unique-run.jsonl \
  --output=/operator/evidence/sample-unique-run.json
```

Only HTTPS staging/integration hostnames under `takoserver.com` or
`workers.dev` are accepted. Discovery must advertise `forms.takoform.com/v2`
on the exact same origin. Redirects are refused, response reads are bounded,
and requests time out. Journal and output files are created once with 0600
permissions; an existing path prevents live mutation. Use a new unique run ID.
Preflight refuses any existing fixture Resource name before the first CREATE.

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

## Evidence And Failure

Successful output says `HOSTED_STAGING_SCENARIOS_PASSED`, records source and
artifact digests, Resource/Operation IDs, automatic slots, rollback IDs and
delete readbacks. It does not assert complete launch qualification. Cross-org
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

Queue, Actor, Workflow and CustomDomain are outside TIER 1 here. Unqualified
types remain unsupported at the 11/04 decision point. Launch requires all
TIER 1 types to pass on hosted WfP, self-host Linux and Docker.
