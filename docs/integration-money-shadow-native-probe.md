# Integration shadow native Worker batch qualification

This surface addresses only a fresh synthetic `takoserver-ms-<32 hex>` D1 after
all 14 integration shadow rehearsal phases, including `permit-success`, have
terminal native readback. The diagnostic Worker is named
`takoserver-ms-<same 32 hex>-probe`. It cannot select the existing billing D1,
production, a normal Host Worker, or an existing diagnostic Worker name.

Use the normal entrypoint with `TAKOSERVER_INTEGRATION_MONEY_SHADOW_NATIVE_PROBE_DECLARATION_PATH`
pointing to an owned link-free `0600` JSON file outside the repository:

```text
bun run deploy -- takoserver-integration-money-shadow-native-probe --status --environment=integration --commit=<reviewed-clean-remote-commit>
bun run deploy -- takoserver-integration-money-shadow-native-probe --apply  --environment=integration --commit=<same-commit>
```

The declaration has exactly `kind: takoserver.integration-money-shadow-native-probe@v1`,
`environment: integration`, `accountId`, `databaseName`, `databaseId`,
`rehearsalDeclarationPath`, `rehearsalDeclarationDigest`,
`rehearsalSourceCommit`, `authPath`, `reviewPath`, `custodyDirectory`, and
`phase: publish|probe`. The rehearsal declaration must be the protected final
`permit-success` declaration for the exact synthetic D1. The database name
must match `takoserver-ms-<32 lowercase hex>`. The custody directory and file
parents must already be owned `0700` directories outside the repository.

Start with `phase: publish`. Publication status generates `authPath` once as
32 random bytes encoded in lowercase hex in an owned `0600` file, then emits
only its digest. Never reuse an existing staging, production, account, actor,
or JWK secret. Status verifies terminal rehearsal custody and native row/schema
readback, uses an exact-name Worker GET for absence, qualifies a clean remotely
reachable source commit, builds a Wrangler dry-run bundle, seals it, and
returns the review binding. It does not publish. An independent reviewer must
write a protected `0600` file at `reviewPath` with exact kind
`takoserver.money-shadow-native-probe-review@v1`, `decision: approved`,
`bindingDigest`, `evidencePath`, `evidenceDigest`, `reviewer`, and ISO
`reviewedAt`. The protected evidence file must cover the selected source,
synthetic D1, final rehearsal, auth digest, bundle, and publication boundary.

Publication apply rechecks all of those facts, writes
`publish.dispatched.json`, then performs one source-annotated Wrangler first
deploy with a separate temporary secrets file. Native GET must show the one
first 100% deployment, exact module bytes, D1 UUID, vars, single secret name,
no cron, and expected Workers.dev routing. Authenticated Worker GET `/status`
must report an absent one-use journal, the bound epoch, and an empty permit.
Only then is `publish.terminal.json` written. Lost deploy ACK remains
dispatched; status reconciles by native GET only, without re-upload or adoption.

Next select `phase: probe` with a new phase-specific `reviewPath`. Its status
binding includes the immutable publication terminal, exact native deployment,
and authenticated GET `/status`. After independent review, apply writes
`probe.dispatched.json` and sends exactly one authenticated **POST `/run` with
no body**. The Worker accepts no request-controlled SQL, amount, epoch,
target, or binding. It writes a one-use D1 journal before its fixed probes:
the pinned current epoch changes the seeded Stripe outcome through
`env.STATE_DB.batch`, a second-statement CHECK failure rolls back the batch,
raw legacy Stripe INSERT/UPDATE/DELETE fail, and a revoked epoch cannot write.
The permit must be empty. A complete journal and exact authenticated GET
readback produce `probe.terminal.json`; unknown POST ACK allows GET-only
reconciliation, never replay. Started, failed, foreign, or partial state is
quarantined for separately reviewed forward repair.

The importer rehearsal and this Worker diagnostic test different native
transports. Local SQLite source tests are not native proof. Neither synthetic
receipt alone authorizes cutover of the existing billing D1. No native Worker
publish or probe result is claimed by this document.
