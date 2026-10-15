# Auth retained authority storage component

This component implements fixed local storage and currentness expressions for
Server Auth. It is not mounted by Auth/App/control, exported by a package barrel,
or registered as a migration. The portable candidate fixture is explicitly
synthetic. It does not install Auth0103, verify a person or proof, enroll a source,
issue a credential, grant payer authority, or enable a shared payment path.

Server Auth owns Principal/binding/class issuance and retained history.
Financial owns payer consent, source events/receipts, history adoption, L1 first
acceptance, L2 first dispatch and every new payment command against an existing
Customer. Accounts/RP owns actual identity/proof verification and registration.
The source order is Container0101, native-identity0102, Auth0103, Financial0104.
These reservations are not source registration or database application. Real
predecessor source and a reviewed preservation transition are still required.

## Fixed storage APIs

`createSharedPrincipalAuthorityStore({sql})` uses the actual atomic `Sql` port.
`createFresh` inserts a nullable-profile shared Principal, original incarnation
and first binding in one batch. `bindLegacy` retains an existing exact
provider/subject/created-at/ID and writes the proved origin plus binding; an email
match is never a linking predicate. The mandatory final binding INSERT has a
SQL-computed non-null condition. A skipped origin write cannot leave a
half-accepted binding; the actual statement fails and the batch rolls back.
A JavaScript exception after a committed batch does not provide rollback.

`retireBinding` closes only the exact active evidence through a guarded write.
`appendSuccessor` requires the complete retired predecessor/closure snapshot;
it preserves the original Principal and stable root subject while writing a
new controller binding. The owning candidate schema additionally requires the
retained root, same Principal/incarnation/issuer/subject/target/origin kind,
distinct controller/new verification evidence, and a single successor per
predecessor. An unlinked new root cannot reset a retained canonical identity.
Original bodies and terminal records cannot be replaced, deleted or reopened.
The store does not manufacture or verify the supplied proof references. Its
future caller must be the genuine Auth-owned verification/issuance operation.

`readAnchor`, `readBinding` and `findBinding` return frozen retained records.
Missing remains missing, not complete-history/clear. A retained row is not a
current authentication result or a payer grant.

`createCredentialAuthorityClassStore({sql})` provides separate fixed
`localSessionIssuanceStatement`, `directKeyIssuanceStatement`,
`sharedBrokerIssuanceStatement` and `sharedRpIssuanceStatement` builders. There
is no generic public JSON `register(class)` endpoint or caller-selected backend.
The genuine issuer must append the mandatory class INSERT after its actual
credential write in the **same** `Sql.batch`. SQL checks the exact actual
credential and original Principal incarnation, and the candidate constraints
preserve the closed backend shape. A zero-row credential INSERT or conflicting
class must abort that batch. The helper does not generate a secret or turn a
structural input into proof of enrollment. The real issuer/capture is a separate
Auth/RP source change; this storage component does not change ordinary issuance.

`readRetained` preserves exact credential digest/ID/incarnation, issuance
reference, class and terminal history. `retire` is a one-way CAS against the
exact original issuance. A reused administrative key ID needs a genuinely new
digest and class incarnation; an old digest cannot acquire a replacement class.
Actual token revoke/delete and enrolled Principal deletion close retained
records through candidate lifecycle guards. Payload cleanup cannot erase their
history. RP revocation/outbox/cleanup hooks remain with the actual RP owner;
the structural fixture is not an implementation of that producer.

## Existing token backend capture

`createAccounts` now also returns an internal `AuthTokenCaptureReader`; the
ordinary `Accounts` and `Actor` contracts stay unchanged. Both ordinary
authentication and `captureAuthenticatedToken` use the same private token
lookup on that factory's actual `Sql`, with the bearer digest, unrevoked row
and existing expiry predicate. No Auth103 table is queried or written. OAuth
providers, sign-in, key issuance, Organization projection and public wire
responses retain their existing behavior.

The capture additionally validates the actual row's digest, current kind,
Org/session shape, raw scope JSON and expiry after the awaited lookup. It
retains the exact token ID, digest, kind, administrative Principal, Org, raw
scope JSON, parsed scopes, raw creation text and expiry in a frozen private
record. The returned frozen handle has no enumerable data and serializes to
an empty object. `inspectAuthenticatedTokenCapture` consults only that
`createAccounts` instance's private WeakMap: clones, serialized objects,
ordinary Actors and another factory's handles return null. No caller supplies
a verified/class/backend flag, proof, target, SQL or registration callback.

This is an observed token record, not a credential class, live payer grant or
reusable authorization. A previously captured record may remain inspectable
after revocation; final currentness belongs in the real owning same-primary
CAS. The key's Principal remains its administrative owner, not a shared human
payer. Missing class cannot become direct classification or permission for a
new Financial command. No Financial command path consumes this seam yet.

Class issuance and App/control/RP mounting are separate. They require the real
registered predecessor/Auth schema and owner-qualified target/composition port;
publicOrigin, tenant JSON and ready booleans cannot provide it. Existing tokens
are not bulk adopted. Actual RP final-row capture remains with its RP owner and
is not inferred from an Actor or synthesized as an auth_tokens row.

## Currentness belongs inside the final owning mutation

`sharedPrincipalCurrentness`, `sharedBrokerCredentialCurrentness` and
`sharedRpCredentialCurrentness` return fixed SQL expressions and frozen bound
constraints. They are intended to be embedded in the actual final same-primary
Financial guarded mutation and mandatory postcondition after all proof awaits.
They do not accept SQL text from a caller, do not return reusable permission,
and do not replace the Financial-owned source/payer/realm/action/history guard.
A standalone SELECT or remote boolean cannot authorize a later write.

The broker expression joins the actual token ID/digest/kind/Org/scopes/creation
and captured expiry, immutable class/issuance/incarnation and current Principal
origin. The key's Principal is its administrative owner, **not the shared human
payer**. The verified human binding is a separate constraint; Financial must
join it to its genuine source proof and explicit one-action owner consent.
No member/key/session/owner DTO can supply that grant.

The RP expression joins the actual active session digest/creation/current
version/account/Principal/Workspace/absolute and idle expiry, registered origin
class and current binding. It does not invent an `auth_tokens` row. Its final
version must come from the real RP after successful touch/verification; the
existing session Context/Actor alone omits that state. Actual RP identity
immutability, enrollment, proof loading/verification, lifecycle hooks, same
physical primary and source registrations remain required. Capturing an old
version or an unknown refresh acknowledgement must not authorize a new command.

The SQL execution clock checks local credential/session usability. Native D1
clock precision, SQL/bind limits and the full combined Financial predicates
still require qualification. No clock parameter, fixture success or presence of
these modules is a schema/enrollment capability.

## Compatibility and evidence limits

The existing public OAuth provider union and all Google/GitHub/Takos-ID methods,
Principal IDs, key digests/IDs, Org/wallet/Customer references and direct contracts
are unchanged. The new internal shared kind and nullable profile exist only in
the candidate fixture until the owner installs the real forward-compatible
schema and reader changes. Do not send it through the old Takos-ID Organization
projection, fabricate an email/name, or infer Principal equality from account ID.

The tests consume only repository-owned candidate fixture SQL and real `Sql`
through `createSqliteSql`. They cover stable successors, forged/active/forked
predecessors, proved legacy preservation, actual batch zero-row rollback,
credential ABA, unknown ACK readback, revocation/currentness and retained
history. Synthetic proof/target/registration data is labelled as such. These
component tests cannot qualify a real identity producer, payer, migration,
service binding, D1 deployment, L1/L2 integration or staging payment journey.

Before a production mount, integrate the genuine Auth/RP producer, the actual
0101→0102→0103→0104 prefix, exact current schema/constraints and common primary,
verified enrollment/proof and all owned Financial guards. Ordinary direct and
shared origins must stay distinct; missing shared evidence cannot fall back to
direct. Original accepted unknown operations remain Financial's retained
recovery responsibility, with their original key/fingerprint/source/realm.
