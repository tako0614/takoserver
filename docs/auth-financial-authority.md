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

The unregistered full Auth103 DDL base remains in
`src/auth-authority-schema-plan.ts`. Its explicit `additiveAuthFullRpDDL`
composition appends the Auth-owned, unregistered storage/lifecycle source in
`src/auth-rp-storage-schema-plan.ts`; it declares the attempts, sessions, and
revocations consumed by the real RP5 store and retires matching retained RP
classes on terminal session transition or deletion. It has no expiring-payload
foreign key, no Financial104 table dependency, and no authority to register or
apply a migration. Before-insert ignore guards are intended to keep the store's
`ON CONFLICT DO NOTHING` duplicate result while preventing replacement of an
extant row; retained-class history also reserves classified session digests
after cleanup. The source regression covers duplicate attempt insertion and
replacement/ignore behavior; session claim/one-shot completion and selected
touch; existing-session revocation queue idempotency/readback, replacement,
ignore, retry and completion; and safe-integer counter/version boundaries.
The test is authored but unexecuted. Its known CAS result does not simulate or
retry an unknown completion acknowledgement. There is no universal tombstone
for consumed attempts, cleaned unclassified sessions, or deleted outbox rows,
so the source does not claim permanent reservation for those values. Full
class-store component tests continue to use their
explicit synthetic RP prerequisite. The dedicated
`auth103-rp-schema-lifecycle.test.ts` source test instead targets the canonical
migration baseline plus this Auth-owned composition and the actual RP5 store;
it uses the canonical account path to retain a legacy Google Principal for
structural storage guard coverage, not a fresh fake shared Principal or genuine
proof. The composed DDL, including a valid class insert against the Auth-owned
RP table, still requires focused SQLite execution before this candidate can be
called usable. That source test remains unexecuted in the private preparation.

Local issuer tests use the separate `additiveAuthTokenDDL` candidate. Synthetic
local issuer fixtures remove the fixture-only RP payload table before setup and
assert it remains absent; canonical migration lineage asserts that it was never
present. The token-only candidate shares retained table names and lifecycle
rules, contains no RP payload-table reference, and explicitly aborts either RP
backend or class. The full RP and token-only candidates are alternative
unregistered component schemas: never install them together or swap one for the
other on a live target. A complete Auth103 candidate still requires the
gap-free real 101/102 predecessor, an additive Principal provider-preservation
transition, genuine RP producer closure, and later independent schema/native
qualification. The local RP-free token candidate does not provide any of those
full-lane qualifications. A metadata-only in-memory inspection of actual
migrations 1–100 found the existing Principal relation has six required text
columns (`id`, `provider`, `provider_subject`, `email`, `display_name`,
`created_at`), existing unique indexes, a provider check limited to `takos-id`,
`google`, and `github`, and an inbound
`personal_organizations.principal_id -> principals.id` NO ACTION foreign key.
The inspected baseline has no RP storage tables. The provider expansion must
preserve legacy Principal rows and every existing identity, unique constraint,
and referencing row while adding the genuine shared-account provider; it cannot
use a placeholder provider, FK-off/table-wipe shortcut, or destructive lineage
rewrite. The actual 101/102 prefix and a portable D1 preservation method remain
unqualified, so no claim is made that this transition is already present or
safe to apply. The candidate local anchor stores the
canonical tagged Unit P verifier-domain tuple as JSON text and its SHA-256
digest. `readAnchor` checks tuple shape, exact serialization and digest before
returning a frozen `fresh-local` anchor. Shared and proved-legacy anchors
require both domain columns to be NULL. The historical `origin_digest` is
separate from the stable domain digest, so a later assertion may have different
bytes under the same issuer/client or public-key configuration.

Local same-primary currentness binds the original Principal ID, provider,
subject, creation text and the captured domain pair. Direct session/key class
statement builders require that pair and a fresh-local anchor. Shared broker
and RP builders use only fresh-shared or proved-legacy anchors with NULL local
domain and current matching bindings. Candidate DDL independently fences this
class split and keeps both domain columns immutable across retirement. A
proved-legacy binding does not permit direct class issuance. An existing
unanchored Principal is not silently adopted as fresh-local.

The unmounted `createAccountsWithUnregisteredLocalIssuer` candidate connects the
actual `resolveIdentity` factory-private capture to a new-Principal sign-in.
It selects `identity` once from the constructor options' own data descriptor,
then keeps the same verifier receiver and its original own capture/inspection
methods. An options accessor, verifier method replacement or clone is rejected
without trusting a callback's result.
It spends single-use credentials first, then writes that Principal, its
`fresh-local` anchor with the exact selected verifier domain, its session token
and the mandatory `direct-owner-session` class in one `Sql.batch`. The final
class INSERT aborts that batch if the token or anchor is missing. The
candidate `target_ref` is unqualified storage metadata only. An existing
unanchored Principal keeps the legacy sign-in path under a final no-anchor SQL
guard; an anchored or unreadable Principal cannot mint an unclassified session
through this constructor. Reissuance for enrolled local Principals is still a
separate unit. Auth103 registration, physical-target enrollment, native D1
qualification and Financial permission remain separate owner work.

`createCredentialAuthorityClassStore({sql})` provides separate fixed
`localSessionIssuanceStatement`, `directKeyIssuanceStatement`,
`sharedBrokerIssuanceStatement` and `sharedRpIssuanceStatement` builders. There
is no generic public JSON `register(class)` endpoint or caller-selected backend.
The genuine issuer must append the mandatory class INSERT after its actual
credential write in the **same** `Sql.batch`. SQL checks the exact actual
credential and original Principal incarnation, and the candidate constraints
preserve the closed backend shape. A zero-row credential INSERT or conflicting
class must abort that batch. The helper does not generate a secret or turn a
structural input into proof of enrollment. The unmounted local constructor
connects the genuine capture only for a new local Principal. Direct-key,
broker and RP issuance remain separate owner work; ordinary issuance is unchanged.

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
and existing expiry predicate. Ordinary `createAccounts` does not query or
write Auth103 tables. OAuth providers, key issuance and public wire responses
retain their existing behavior.

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

The source-only local candidate does not mount App/control/RP or issue shared
credentials. Those paths require the real registered predecessor/Auth schema
and owner-qualified target/composition port;
publicOrigin, tenant JSON and ready booleans cannot provide it. Existing tokens
are not bulk adopted. Actual RP final-row capture remains with its RP owner and
is not inferred from an Actor or synthesized as an auth_tokens row.

## Genuine local factory origins

`assertAuthTokenCaptureReader(reader, {sql})` checks the actual object created
by this module's `createAccounts`, its identical captured Sql and both original
capture/inspection methods. Copied methods, another wrapper around the same
database, inherited objects and an alleged reader's self-assertion do not
establish that origin. Both methods must remain own data properties; the check
does not invoke an inspection/capture method or an accessor. Two real Accounts
factories on the same Sql each have genuine origins, while their opaque token
handles remain private to their original factory. Ordinary Accounts behavior
and token parsing are unchanged.

`assertMoneyCutoverSqlOrigin(sql, {writerEpoch})` checks the actual object
returned by `createMoneyCutoverSql`, its captured primitive epoch and original
query/run/batch methods. It exposes no underlying Sql. Distinct real wrappers
around one backend remain distinct Sql identities. Neither assertion accepts
a caller's callback or branded DTO as a source of origin, and both refuse
accessor replacements without running their getters.

These checks perform no SQL and prove local construction only. They do not
freeze the returned ports or turn a previously checked method into reusable
permission. A real consumer must capture the original reader and receiver
after checking its origin. Existing final currentness/permit guards still
decide each command: a revoked token can have a retained observation, and a
wrapper whose epoch was later revoked or whose database was frozen retains
its construction origin while its next write fails.

These helpers are source-module APIs, with no new package-barrel export or
App/Financial mount. They do not implement `assertFinancialAuthConsumerPort`.
That separate consumer still requires the genuine qualified Realm/client,
writer origin, installed Auth schema/target, actual retained-class issuer and
separate verified human/RP producer. Missing class remains missing; neither an
ordinary token observation nor these origin assertions supplies a payer,
credential class, enrollment or Financial permission.

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


### Separate full103 Principal-preserving source alternative

`auth-principal-schema-plan.ts` is an unregistered fixed transition candidate for the exact historical100 plus actual101/102 owner-source graph. Its full103 assembly is `additiveAuthFull103DDL`, distinct from the unchanged base, token-only and RP-storage-only alternatives. It requires the existing migration owner's one transaction and never installs or registers itself. It copies every Principal field and rowid, retains the observed NO ACTION personal-organization references and other catalog objects, and extends the provider domain with `shared-account`. The candidate derives the exact canonical `personal_organizations_owner_insert` trigger from the immutable historical source through the owning statement framer, requires its full catalog definition, and preserves it across the same transaction with the other schema objects. Missing or modified canonical trigger definitions, unknown dependent triggers/views, unknown incoming references, custom indexes, source drift, collisions and failed conservation refuse the transition. `defer_foreign_keys=ON` is kept within the owning transaction; no premature OFF, foreign_keys OFF, schema rewriting or fake legacy provider is used.

The private regression source imports actual immutable100 migration history and both real101/102 candidate producers. It is not runtime evidence until executed and reviewed. The new provider label and structural row are not a genuine shared Principal, issuer, proof, capture or consumer port. Source registration, native D1/transaction/ACK qualification, real predecessor adoption, apply and shared activation remain separate unfinished responsibilities. An unknown import acknowledgement requires the existing owner's original readback protocol, not retrying this non-idempotent candidate or rolling back a committed migration.
