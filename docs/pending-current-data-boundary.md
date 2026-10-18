# Pending and receipted original DATA boundaries

These APIs are unmounted and the consent schema leaf remains unnumbered and
unregistered. They accept the same request-origin guarded Sql and closed original
input as the existing capture/consume APIs. They do not expose a public route or
prove genuine credential, separate human binding, qualified Clock, coherent
Financial R1 selection or current admission.

`sharedAuthFinancialConsentPendingPersistenceStatement(input)` builds the one-row
pending CAS. `persistSharedAuthFinancialConsentRequestPendingData(connection,
input)` executes it through the captured Money-wrapped Sql.run and requires
actual changes1 plus one exact closed29 postimage. The original created/expiry
values, selected and retained scopes, Root predicates and byte digests remain
bound. A pending ACK contains only pending29 DATA: it does not retain the full
command, opaque consent/proof references or all selected-terms references.

`createSharedAuthFinancialConsentPendingRecovery(connection, originalPending)`
returns only `readOriginalPendingData()`. This reads the original29 after expiry
or retirement as historical custody. Complete positive absence is undefined
DATA; partial/orphan/corrupt schema or rows and unknown SQL outcomes fail closed.
An occupied different original remains a custody conflict. Neither absence nor
a pending row authorizes capture, consume, a new key, a resend or continuation.

`sharedAuthFinancialConsentPendingCaptureConsumeStatements(input)` builds three
required-row statements with the existing81/45/81 parameter vectors. Each has
one expected row and uses existing NOT NULL/unique constraints to make a false
or NULL guard a SQL error instead of silently committing a zero-row prefix.
`persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(connection,
input)` submits these statements through the same captured Money Sql.batch.
The existing adapter's same-primary all-or-none batch contract must be qualified;
a JavaScript result or a changes echo cannot establish rollback semantics.

All three statements are submitted together. There is no JavaScript ACK16
between the second and third statements: the third checks the exact stored
command tuple in SQL. The effect validates actual closed29/16/14 postimages,
whole original bytes, original fullcommand and same-row mandatory receipt after
batch return. A malformed/lost ACK can follow a commit and remains unknown,
not a claimed rollback. Recovery is only the existing original-fullcommand GET;
no automatic batch retry, fresh reference, family fallback or resume is added.
The existing sequential capture/consume API keeps its original behavior.

Successful historical DATA does not establish NEW/current consent, first-dispatch
admission, never-dispatched state, Financial payer/Customer CAS or authority.
These composition dependencies remain separate from storage and schema presence.
