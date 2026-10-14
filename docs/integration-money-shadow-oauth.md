# Integration money shadow qualification

Task ledger: `takoserver` owns this integration-only authority and data change.
The order is source review and guard integration, clean source commit, protected
stage-origin and independent review evidence, fresh shadow creation, fourteen
reviewed synthetic import phases, then native readback of the terminal state.
No sibling repository is changed by this lane. Provider mutation begins only
with the separately reviewed `--apply` commands; this source change, green
checks and a Git commit do not grant that authority.

This lane creates a **new, disposable, synthetic-only** D1 under the positively
reviewed integration staging account, then runs the 0092 → 0093 → 0094 money
import rehearsal against that new D1. It never selects the billing/staging D1
for import. Its receipt qualifies the native import behavior observed on the
shadow; it does not authorize the real billing cutover. The existing
`takoserver-rehearsal-d1-create` and
`takoserver-d1-money-cutover-rehearsal` remain explicit API-token-only and
retain their `takoserver-r-…` target contract.

All paths below must be absolute, outside this repository, in operator-owned
0700 directories. Every declaration, review, origin receipt and custody file
must be owned 0600 regular data. Do not place credentials in a declaration.
`--status` reads the canonical integration Wrangler OAuth profile, obtains a
bearer only for in-process authenticated REST identity queries, and never
copies that bearer into `CLOUDFLARE_API_TOKEN`. Wrangler child commands use
their stored OAuth profile. An explicit `CLOUDFLARE_API_TOKEN` is refused in
this lane. The selected account must match the protected, reviewed 0092
staging-origin certificate; no production target descriptor or production
resource is consulted.

Create one declaration with a newly generated 32-lowercase-hex generation,
using `takoserver-ms-<generation>` for `name`:

```json
{
  "kind": "takoserver.integration-money-shadow-create@v1",
  "environment": "integration",
  "purpose": "synthetic-money-import-atomicity",
  "accountId": "<32-hex staging account>",
  "name": "takoserver-ms-<fresh 32-hex generation>",
  "stageOriginReceiptPath": "/protected/stage-0092-origin.json",
  "stageOriginReceiptDigest": "sha256:<digest of exact origin file bytes>",
  "reviewPath": "/protected/shadow-create-review.json",
  "custodyDirectory": "/protected/shadow-create-custody"
}
```

Set `TAKOSERVER_INTEGRATION_MONEY_SHADOW_CREATE_DECLARATION_PATH` to this
file. Run `bun run deploy -- takoserver-integration-money-shadow-create
--status --environment=integration --commit=<reviewed HEAD>`. Status returns
the exact `bindingDigest` and `readyForApply:false` before review. An
independent reviewer must inspect the origin receipt, source and native-name
absence, then write a separate owned 0600 evidence file and this exact review:

```json
{
  "kind": "takoserver.integration-money-shadow-create-review@v1",
  "bindingDigest": "sha256:<status bindingDigest>",
  "decision": "approved",
  "evidencePath": "/protected/shadow-create-review-evidence.txt",
  "evidenceDigest": "sha256:<exact evidence file digest>",
  "reviewer": "<independent reviewer>",
  "reviewedAt": "2026-10-14T00:00:00Z"
}
```

Run status again and inspect `readyForApply:true`. Apply requires a clean
commit reachable from a fresh remote ref, reads exact-name absence again,
writes `create.dispatched.json` without overwrite, sends one D1 create, then
GETs its UUID/name and checks that its non-platform schema-object count is
zero before writing `create.terminal.json`. A missing acknowledgement leaves
only dispatched custody. Inspect status; this surface never retries or adopts
the existing name, even if the D1 appeared.

For each synthetic phase (`seed`, `freeze`, `prepare`, `classify`,
`failure-probe`, `convert`, `resume-failure-probe`, `resume`,
`legacy-insert-probe`, `legacy-update-probe`, `legacy-delete-probe`,
`stale-epoch-probe`, `permit-failure-probe`, `permit-success`), create a
distinct declaration with the same
account/name/UUID and an owned 0700 phase custody directory:

```json
{
  "kind": "takoserver.integration-money-shadow-rehearsal@v1",
  "environment": "integration",
  "purpose": "synthetic-money-import-atomicity",
  "accountId": "<same 32-hex account>",
  "databaseName": "takoserver-ms-<same generation>",
  "databaseId": "<create.terminal.json UUID>",
  "stageOriginReceiptPath": "/protected/stage-0092-origin.json",
  "stageOriginReceiptDigest": "sha256:<same origin digest>",
  "createDeclarationPath": "/protected/shadow-create-declaration.json",
  "createDeclarationDigest": "sha256:<exact create declaration file digest>",
  "createReceiptPath": "/protected/shadow-create-custody/create.terminal.json",
  "createReceiptDigest": "sha256:<exact create terminal file digest>",
  "reviewPath": "/protected/<phase>-independent-review.json",
  "custodyDirectory": "/protected/shadow-phase-custody",
  "snapshotPath": "/protected/<phase>-before.sql",
  "phase": "seed"
}
```

`TAKOSERVER_INTEGRATION_MONEY_SHADOW_REHEARSAL_DECLARATION_PATH` selects that
file. Use the `takoserver-integration-money-shadow-rehearsal` surface with
`--status` and then `--apply`, `--environment=integration` and the same exact
`--commit`. The protected phase review uses the existing rehearsal review
shape (`takoserver.money-rehearsal-independent-review@v1`) and must bind the
returned `reviewBindingDigest` plus an independently written evidence file.
Each phase requires the previous terminal receipt and exact native schema,
complete application typed-byte digest, financial preimage/aggregate and
foreign-key checks. The phase SQL and Wrangler module digest are sealed in
the dispatch. Once dispatched, no phase is retried after an unknown ACK.

At each `*-probe --status`, a native `wrangler d1 export` produces the
protected normalized `snapshotPath`. It is restored locally and its exact
0093-fenced, 0094-fenced, or resumed 0094 schema and all application rows are
compared with native readback.
The snapshot digest enters the phase review binding. Following an
authenticated structured D1 import response with the exact late SQL fault,
another protected export is written to `<snapshotPath>.after.sql`; both
normalized export digests, native full application typed-byte digests, fences,
money conservation and foreign keys must match before a failure terminal is
written. Cloudflare-owned metadata is not a customer table. A failed export,
unknown import acknowledgement or unexpected native state retains dispatch
custody and quarantines the shadow for separate forward repair. The final
`convert` uses the exact reviewed SQL in a single pinned Wrangler `--file`
import and verifies the 0094-fenced state. `resume-failure-probe` first changes
the synthetic freeze-row source digest, then runs the **actual row-only resume
SQL**; its deliberately false precondition must return the exact native CHECK
fault and roll back the preceding change. `resume` then deletes only the exact
freeze row, retaining the permanent guards, authorized epoch and empty permit.
Three legacy Stripe probes each attempt one direct INSERT, UPDATE or DELETE
after resume and require the exact guard fault. The stale-epoch probe requires
the authorized-epoch trigger fault. The permit-failure probe mutates a
synthetic Stripe event under a correct permit, then faults late; native import
must roll back both the event and permit. The permit-success import exercises
one correct permit, a guarded UPDATE changing the pre-seeded Stripe event from
`ignored` to `deferred`, and permit deletion. Its exact full application and
financial typed-byte digests must change to the independently reviewed expected
values, while the amount preimage and aggregate digests stay unchanged and the
permit is empty. A skipped or matching-row no-op UPDATE fails the expected
readback. Each phase
has its own independently reviewed SQL digest, native structured fault or
success observation, protected dispatch and terminal receipt. No reset,
delete, replay or old-cents rollback is implemented here.

These D1 `/import` and Wrangler `d1 execute --file` observations qualify the
native SQL importer and database guards. The local `createMoneyCutoverSql`
regression exercises the Host's `Sql.batch` contract through a local SQLite
adapter. **Neither proves a native Worker D1 binding's `batch` behavior.**
That separate prerequisite needs an independently reviewed, source-built
integration-only diagnostic Worker publication on the same fresh shadow D1,
with an exact native D1 binding and source-pinned writer epoch. Its bounded
test route should submit a successful `env.STATE_DB.batch` containing permit
INSERT, guarded Stripe UPDATE and permit DELETE; a failed batch with a late
statement must leave the Stripe row and permit unchanged; a Worker pinned to
an older epoch must be rejected before mutation. The publication must have
native version/modules/bindings and post-condition receipts, no production
target inventory, and its own review/custody. This diagnostic Worker lane is
**not implemented here**; billing-D1 cutover must not treat the import receipt
as that missing Worker-batch proof.

The stage-origin certificate and protected review files are operator-owned
evidence, not cryptographic signatures from Cloudflare. The independent
review must verify their source/run history and the selected staging account
before any create or import. A local SQLite rollback test is useful source
evidence; only the resulting native shadow failure-probe terminal provides
provider-side atomicity evidence. No native shadow run is claimed by this
document.
