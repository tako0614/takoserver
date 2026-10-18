# RP observation to native consent DATA batch, private source preparation

`captureSharedAuthFinancialRequestClockObservation` captures the owning Root
credential original and distinct authenticated user-binding original from the
exact Request once. Its final RP observer can touch and advance the selected
session version. The new
`readSharedAuthFinancialRequestNativeObservationData(connection, request,
workspaceId, observation)` is a source-static reader of that held observation.
It requires the same connection, Request object and selected Workspace, and
reasserts the Root port/context, graph/Sql/realm/epoch, source Clock and opaque
credential/binding originals. It exposes only the selected scope, sampled time,
credential record, human binding and current retained session as internal DATA;
it exposes no port, context, raw Sql, token, callback, issuer or SQL predicate.

`persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData` is a
separate unmounted N-store executor. Its caller may supply the already captured
pending and full command DATA, but not `recordedAt`, authority metadata or a
predicate. It derives `recordedAt` from the source-held Clock sample, requires
the pending and command selected scope to match the observation, and applies
the existing fixed consent recipe and custody checks without rebuilding a key,
body, digest or command. It repeatedly re-reads the static source observation
and Root port/context around awaited work and the effect. It uses the existing
Root literal ten-parameter currentness expression in the existing required
three-statement captured Sql batch; the final statement remains 91-bound and
false final currentness must abort the prefix through the required row/NOT NULL
constraint. It never calls the RP final observer, touches or reloads the session,
or retries capture. An absent, foreign, drifted or unknown observation fails
closed; an unknown batch acknowledgement gives no resend permission. Historical
full-command GET stays on its old original key and remains query-only.

The old native writer and every existing GET, codec, leaf schema and external
wire remain unchanged. This source seam does not establish affirmative human
consent, acceptedAt authority, a current-consent verifier, a distinct consent
issuer, Financial's qualified original R1/action/terms or NEW/first-dispatch
CAS. The sampled time is DATA even when the native batch writes. No route,
mount, schema change, ledger or independent revocation head is introduced.
There is no genuine native-positive fixture for this unit. Its negative tests
prove only rejection before SQL effect for forged/foreign inputs and historical
GET separation; exact Request and Workspace revalidation with a real minted
observation and actual final-false rollback still require qualification.

The existing `createSharedAuthFinancialConsentRequestHandler(connection)` now
offers a separate unmounted `persistObservedData(request, workspaceId,
{pending, command})` method. It calls the Root-backed Clock observation once
and passes that exact opaque handle, connection and Request to the new native
batch executor. The old `readExisting` method and old native request writer are
unchanged. The handler does not read or rebuild the POST body and does not
accept a caller observation, time, SQL predicate or credential field.
