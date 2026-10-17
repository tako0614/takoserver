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

## Historical consent proof reference

`createSharedAuthFinancialConsentProofReferenceReader(connection)` exposes only
`readProofOriginalData(input)`. The input must be the original opaque string.
The consumer label `consentProofRef` is explicitly the existing canonical
`consentRef` unchanged. No canonical wire field, prefix, hash, digest domain or
new identifier is introduced. `identityEvidence.proofRef` remains the separate
identity-proof reference and is never the source of this mapping. The original
`receiptRef` is retained separately; it is not a Financial grant receipt.

The reader captures the actual request Sql/query receiver and original graph,
client and realm. It requires one closed16 command row by exact consent_ref,
copies native original BLOBs, and delegates fullcommand custody to the existing
strict original reader. That reader validates pending29, command16 and
original14, their exact scope/key/family, raw hashes and canonical original,
plus the mandatory same-row receipt and original timestamp relationships.
Original digest and raw original-byte custody hash remain distinct values.

The output is `SharedAuthFinancialConsentProofReferenceData` with state
`consent-proof-reference-original-data`, the original `consentProofRef` and the
existing `SharedAuthFinancialConsentOriginalData`. This is immutable historical
DATA loading, not a DTO/ref mint or current verifier. The lookup performs no
writes, session observation/touch, Clock, current-admission, install, capture,
consume or retry. Known references can be read again after retirement without
creating permission. Consumers must independently bind the returned issuer,
action/challenge/terms/scope and original bytes to their own qualified request.

A by-reference zero result is unavailable: pending29 has no consentRef column,
so this lookup cannot establish complete three-row absence or never-attempted
state. Partial/orphan/corrupt rows, missing receipt, SQL failures and borrowed
external error codes also fail closed. Internal fullcommand custody conflicts
retain their own typed error. Nothing permits new keys, family fallback, NEW,
resume or resend. The existing original-fullcommand GET recovery ABI is
unchanged and remains the unknown-operation recovery boundary.

This remains unmounted. Root retained credential DATA is not a qualified
credential assert, separate human, policy Clock/current admission or physical
Auth103 qualification. Direct-token DATA cannot be cast into RP fields.
Financial coherent original R1/action/terms readers and same-primary acceptance/
first-dispatch CAS remain separate owner responsibilities.
