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

## Stored-reference local predicate DATA

`createSharedAuthFinancialConsentLocalProofDataReader(connection)` exposes only
`readLocalProofOriginalData(input)`. Its closed input is the original
`consentProofRef` and the existing credential, distinct human and currentSession
metadata DATA. It does not accept pending, fullcommand or recordedAt echoes.
The actual same captured request query port loads the historical receipt-backed
original and strict stored29 pending. All original refs, bytes, family and the
receipt-validated recordedAt come from that custody. The existing81-bind local
predicate and exact original14 comparison are reused without a writer or Clock
read. Metadata is detached before the first await; no DTO, callback or value
shape proves its Root source or qualification.

Success returns `SharedAuthFinancialConsentLocalProofData`, state
`consent-proof-reference-local-data`, the unchanged ref and historical original.
Undefined is only a local SQL nonmatch after complete historical custody. A
byref-zero or incomplete/unknown/corrupt original remains unavailable. The
historical-only reader stays usable after expiry or retirement independently
of this local predicate. No caller metadata mismatch, unknown ACK or nonmatch
permits NEW, install, resend, resume or another key/family.

This DATA bridge is not a current consent verifier or current-admission port.
It neither observes/touches sessions nor supplies qualified Root credential,
separate human, policyClock, physical103, genuine RP issuance or Financial
original R1/action/terms and payer/CAS. Its structural metadata contract retains
those existing owner boundaries; genuine provenance cannot be inferred from a
matching local row. No public route, wire/recipe, schema or registration changes.

## Request-owning existing-consent branch

`createSharedAuthFinancialConsentRequestHandler(connection).readExisting(request,
{workspaceId, consentProofRef})` requires an already mounted, same-connection
Root Financial Auth consumer port and its original Sql/realm/epoch/context. The
literal owning request capture returns separate opaque RP credential and
authenticated user-binding originals. Their distinct Root readers validate the
credential/current session and Principal binding before the existing stored
historical/local-proof readers run. Addressing metadata is detached before awaits;
the same port, context, graph and methods are rechecked after them. Missing port,
wrong backend, unknown or drift is unavailable without falling back to retained
DATA alone. Ordinary RP observation can touch its own session; no consent or
Financial write is performed.

Before exposing original DATA or local nonmatch, canonical stored account and
exact OIDC identity/session/Principal/binding reference and selected Workspace/Org
are compared to that actual request observation. Original session Workspace,
registration/enrollment and final-touch versions are kept distinct. Consent issuer
registration is independent from the credential's RP registration; no alias is
added between their incarnations or digests. The local result must retain the
same original fullcommand/bytes
and mandatory receipt. Unknown/missing/corrupt/foreign input is unavailable,
not positive absence or NEW. Result is only the existing local-proof DATA type,
never approved/current=true, a permission, dispatch or a genuine consumer port.

This handler is an unmounted private source integration using the fixed Root
Financial Auth consumer source. Root must select and construct its native original
graph and mount the port before this branch can return local DATA. The private
source and negative fixtures do not establish that native prerequisite, public
adoption, a current permission or a positive genuine request. The historical
original/fullcommand reader remains separately usable after expiry or retirement.
Root owns literal construction with its actual original connection and route mount.
No public route/body/challenge10/proofRequest3/recipe is defined here, and the
old private confirmation/disclosure parser proposal is not silently mounted.

The same request-origin/scope acquisition also supports the Financial-owned
request R1 reader and RP's unmounted prepared GET path described below. Root
native registration/bindings/mount/current admission, RP affirmative issuance,
and Financial NEW/CAS remain separate work. The Root source-currentness SQL
predicate must join a final same-primary consumer batch; a JavaScript read
here is not current consent or NEW admission. No fake callback supplies a
positive fixture or mount. A future POST must preserve the original action,
terms and full-command custody through the actual29/16/14/mandatory-receipt
path. It must not rebuild action/terms or infer resend after unknown. This
readExisting handler does not change the historical original reader.

## Unmounted Root-native-currentness-bound consent DATA batch

`persistCaptureAndConsumeSharedAuthFinancialConsentNativeRequestData(connection,
request, workspaceId, {pending, command, recordedAt})` is a separate RP-owned
source preparation. It acquires the existing same-connection Root consumer port
and context, statically asserts their origin, captures the actual request's
distinct opaque credential and user-binding originals, and derives the retained
credential/session and human binding through their Root readers. It then calls
`financialAuthConsumerSourceCurrentness(port, context)` and embeds that fixed
10-parameter expression in the required final consume statement. The three
pending/command/consume statements run in one captured same-Sql batch. The
final consume has 91 binds (the former 81 plus Root's 10); a false predicate
selects NULL for the required original key and aborts the batch prefix through
its existing constraint. Original14 and mandatory receipt stay in one row.

The submitted pending/command bytes and recordedAt remain unqualified RP DATA.
This function does not produce affirmative action consent, verify current consent,
or provide Financial's original R1/action/terms/current NEW/first-dispatch CAS.
It returns only historical original DATA and is not mounted. Missing native port,
foreign graph, drift or unknown batch is unavailable; no earlier Root-currentness
query, boolean, arbitrary SQL, caller predicate or fallback turns it into a
grant. The original fullcommand GET remains separate and uses the unchanged key,
bytes, digest and receipt after expiry/retirement; failure cannot authorize resend.
The old structural DATA builders remain unchanged. The synthetic fixture can
check negative branches only; there is no qualified native positive or public
activation from this source unit.

## RP consent issuer source and affirmative submission candidate

The unnumbered RP consent leaf now includes an independent immutable issuer
registration original. The RP module selects its canonical original in source;
`createSharedAuthFinancialConsentIssuerSource(connection)` binds registration and
current reads to the same actual Request, Root observation and Sql graph. It
accepts no caller issuer DTO, source SQL, predicate or Clock. Within one
request-owned connection, an attempted registration is fenced before the write;
an unknown acknowledgement permits an exact GET but no second INSERT, including
from a new factory on that connection. The fence is process-local: a new
connection or restart has no durable unknown marker. Registration is not called
from an ordinary POST and remains an explicit owner-once operation pending
durable custody qualification. The current reader requires the exact stored
original/digest. This leaf remains unregistered and unapplied; its row and v4
tuple alone do not qualify affirmative consent.
The Root auth RP registration and Financial action-source registration remain
distinct from this issuer.

The observed request DATA batch additionally compares the v4 original's issuer
triple to this source and adds the issuer's exact-row `EXISTS` condition to the
final same-Sql statement. Its final statement has 95 binds (81 structural, 10
Root Auth source currentness, 4 issuer original) and remains under D1's 100-bind
limit. A missing or changed issuer row aborts the whole required batch. The old
native DATA writer retains its 91-bind statement and historical GET is unchanged.
The new `parseSharedAuthFinancialConfirmationSubmissionCandidate` consumes the
original POST body once and validates the already specified `approve=yes` and
`confirmation_transaction` form fields; it returns submission DATA only.

The Financial request-owned R1 reader now supplies the exact original action,
terms, receipts and full command for its connection, Request and Workspace. Its
five-argument static custody reader returns the same Root captures held by the
successful R1 result; RP samples the source Clock from those captures and does
not call the Root observer a second time. `verifyCurrentActionConsent` checks
the stored consent original against this R1, the held local original, issuer,
source currentness and expiry, then rechecks R1 after awaits. Its result is a
local DATA witness, not affirmative POST consent, Financial NEW/CAS admission or
a mounted permission. Historical `readExisting` remains separate.

`prepareFinancialR1ConsentView` is an unmounted GET DATA path. It renders the
R1 action and original UTF-8 terms as escaped HTML with only the fixed
`approve=yes` and `confirmation_transaction` POST fields. The private
`disclosure_ref` commits to those exact HTML bytes; it does not prove delivery
or display. The internal `rpfc_` transaction address encodes the unchanged
capture-key digest bytes and is not a new external digest recipe. One held
Financial/Root observation and source Clock sample determine pending29
`created_at`; expiry is the minimum of challenge expiry, session absolute
expiry and five minutes after that sample. The same-Sql pending29 INSERT has a
strict postimage ACK and an original-key GET; repeat GET keeps the original
times and ref. GET creates no command16, acceptedAt, consent original or effect.

An unknown pending INSERT acknowledgement allows GET-only recovery for the
same connection in this process. Its deny map is not durable across another
connection or restart, so this source does not qualify an automatic GET retry
under those conditions. POST claim/consume, a qualified identity-evidence
selection, affirmative original production, native Root-positive execution and
Financial NEW/CAS remain unqualified. No consent head, revocation ledger,
route, numbered schema, migration or external wire change is added here.

`readPreparedFinancialR1SubmissionData` is an unmounted POST preflight. It
requires an exact `Origin` header matching the original Request URL origin;
missing, `null` and crossed origins fail without a Referer fallback. The
Financial request-owned R1 original supplies the expected transaction,
challenge and fingerprint to the existing one-read, two-field form parser. RP
then reuses that R1's Root captures for one Clock observation and reads the
original pending29 by transaction address without inserting it again. The
read rechecks Root credential and separate human currentness, native source,
issuer, original created/expiry interval, R1 action/challenge/terms bytes,
and the renderer's disclosure commitment; occupied command/original rows and
unknown SQL fail closed. After awaits it rechecks R1 and the held observation.
The return is submission plus pending DATA, not evidence of HTTP display,
acceptedAt, affirmative consent or permission. POST preflight writes no
pending29, command16, original14 or effect. A genuine identity-evidence
original or authoritative not-required decision for this R1 is still absent,
so command claim, consume and Financial NEW/CAS remain unavailable.

After `verifyCurrentActionConsent` completes its final retained-R1 reread and
held Root/source checks, the RP handler privately retains that exact local
receipted original with a detached byte baseline. The static
`readSharedAuthFinancialConsentCurrentOriginalData` requires the same handler,
connection, Request, selected Workspace and exact returned witness. It
reasserts the existing request graph and held native observation, compares the
retained original with its baseline, then returns another detached copy of the
existing original bytes, custody digests and mandatory receipt fields plus the
sampled Clock time. It does not perform another R1 GET, Root observation,
Clock sample, SQL query or write. An unknown final R1 reread registers no
origin. The witness shape remains unchanged, and this bounded original DATA
is not a Financial consumer envelope, current permission, revocation proof,
first-dispatch claim or NEW/CAS admission; those effects need their own guarded
same-primary checks.

`provePreparedFinancialR1Identity` is a separate, unmounted effect over the
exact prepared object that the POST preflight returned. It requires the same
handler, connection, Request, Workspace and challenge, rechecks the prepared
origin, held native observation, pending29 and retained R1 before and after,
and calls Root's fixed retained RP proof original once with the held opaque
credential capture. `readPreparedFinancialR1IdentityEvidence` then uses only
that prepared object's own existing proof attempt; it never proves on its own
and accepts no proofRef. Root's fixed load and current originals call the RP
session receiver's `loadFinalSessionFinancialIdentityProof` and
`verifyCurrentFinalSessionFinancialIdentityProof`, which read Accounts
`loadFinancialIdentityProof` / `verifyCurrentFinancialIdentityProof` for the
proof that receiver itself obtained, in that order, at most once each. Their
results are detached plain own-property DATA. Financial's
`readFinancialActionConsentR1IdentityEvidenceData` joins
`{v:1, proofRef, challengeRef}` and the found/current DATA to the same retained
R1 reader, original and Root RP original. Every step is installed before its
first await and an unknown, rejected or malformed result is never resent. The
returned `financial-proof` identity evidence is DATA only: it is not
affirmative consent, acceptedAt, a consent original, command claim or consume,
current permission or Financial NEW/CAS. Those remain the next guarded
same-primary effect.

`capturePreparedFinancialR1Consent` is the unmounted affirmative POST effect
for one prepared original whose own identity evidence has already joined. It
never proves or joins on its own. Every v4 consent field comes from the held
retained R1 (action, challenge, terms, source, path, realm), the held Root
observation (final session, credential origin, human binding, current
session), the issuer original and that `financial-proof` evidence. The single
held Clock sample is `acceptedAt`, `command.capturedAt` and `recordedAt`;
`expiresAt` is the minimum of pending29 expiry, session absolute expiry and
challenge expiry. `consentRef`, `commandRef` and `receiptRef` are derived from
the R1 transaction address (`rpcs_`/`rpcm_`/`rpcr_` plus the base64url SHA-256
of `["takoserver-rp-explicit-action-consent-refs-v1", role, transactionRef]`),
and command16 bytes are the canonical JSON of the version, family, key,
selected scope, `approve=yes` submission, original digest and capture time.
`captureAndConsumePreparedSharedAuthFinancialConsentObservedRequestData` then
runs one required batch over the existing pending29 row: command capture and
the 95-bind native/issuer-guarded consume into original14 with its receipt.
pending29 is matched in full and never inserted or replaced; a false guard
aborts both rows. Before any capture the producer also requires the joins the
verifiers check (final session account and Principal against the credential
and human binding), so it never consumes a transaction into a consent that
cannot verify. The attempt is installed before its first await and is never
resent. When the batch outcome is unknown, the same invocation performs only
the existing original-fullcommand GET of its exact held command: a committed
original is returned, an absent one stays unavailable. Once dispatched for a
transaction, the connection fences any further capture+consume batch for it,
so a re-POST after an unknown or rolled-back batch cannot re-mint command16
with a new Clock sample; like the GET pending fence this is process-local and
not durable across connections or restarts. A consumed transaction can no
longer be prepared for POST, and a committed row with other bytes is a custody
conflict. The identity proof is checked current when the evidence joins under
the same held observation whose sample is `acceptedAt` (Financial receiver
owner ruling); the write itself is bounded by pending29 expiry, not by a
second sample against the proof expiry. The receipted original is local DATA
for `verifyCurrentActionConsent` and the Financial consumer, not Financial
NEW/CAS admission or a mounted route.

`handleSharedAuthFinancialConsentRequest` is the RP consent page that Root
mounts on its observed request connection at `/auth/financial/consent` with
exactly one `workspace` and one `challenge`. GET renders the retained R1
action and terms with a same-URL form; if this R1 already has its stored
consent (read by the derived consentRef and matched to the R1), it shows the
recorded approval with no form. POST runs the prepared preflight, identity
proof, load/current evidence and affirmative capture in order and answers
`303 See Other` to `${consoleOrigin}/billing?consent=returned`, where the
console origin is the same validated value the app uses (exact origin, no
credentials, http or https only, as for the billing checkout return) and the
query is fixed, carrying no data or caller return URL. Without a valid console
origin the POST is refused with 503 before any effect, never redirected to a
relative path. The console re-issues its held payment reference there;
Financial derives the consent proof ref from its retained R1 with the exported
`sharedAuthFinancialConsentTransactionRef` and `sharedAuthFinancialConsentRefs`
recipes rather than trusting a client-supplied ref. An invalid selection is
400; an unknown or conflicting outcome is 503/409 saying the approval could
not be confirmed, with a link back to the GET page for recovery, never a
resubmission. Pages are no-store with a deny-all CSP.
