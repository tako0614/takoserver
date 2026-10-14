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

Start with `phase: publish`. First publication status requires both `authPath`
and `custodyDirectory/auth.genesis.json` to be absent. After an authenticated
exact-name Worker absence GET and clean remote source qualification, it generates
32 random bytes encoded in lowercase hex in an owned `0600` file and writes a
no-overwrite `0600` genesis receipt binding the account, synthetic D1, derived
Worker name, source commit and remote ref, rehearsal origin, first absence, auth
path and auth digest. Subsequent status/apply requires both protected files and
their exact match; an existing bearer without that genesis is refused. The
genesis digest enters the publication and probe review bindings. Never reuse an
existing staging, production, account, actor, or JWK secret. Status verifies
terminal rehearsal custody and native row/schema
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
dispatched; status reconciles by native Version/binding GET and authenticated
Worker GET `/status` only, without re-upload or adoption. Provider error bodies
and malformed binding values are omitted from this surface's diagnostics.

Next select `phase: probe` with a new phase-specific `reviewPath`. Its status
binding includes the immutable publication terminal, exact native deployment,
and authenticated GET `/status`. After independent review, apply writes
`probe.dispatched.json` and sends exactly one authenticated **POST `/run` with
no body**. The Worker accepts no request-controlled SQL, amount, epoch,
target, or binding. It writes a one-use D1 journal before its fixed probes:
the pinned current epoch changes the seeded Stripe outcome through
`env.STATE_DB.batch`, a second-statement CHECK failure rolls back the batch,
raw legacy Stripe INSERT/UPDATE/DELETE fail, and a revoked epoch cannot write.
The permit must be empty. After the authenticated GET status confirms the
complete journal, the owner rereads the exact native Version, deployment,
module and binding closure before it writes `probe.terminal.json`. Unknown
POST ACK allows GET-only
reconciliation, never replay. Started, failed, foreign, or partial state is
quarantined for separately reviewed forward repair.

The final native readback and terminal file write have no provider CAS between
them. A concurrent foreign deployment in that interval remains a residual race;
later status rereads the native identity and refuses divergent custody.

The importer rehearsal and this Worker diagnostic test different native
transports. Local SQLite source tests are not native proof. Neither synthetic
receipt alone authorizes cutover of the existing billing D1. No native Worker
publish or probe result is claimed by this document.
