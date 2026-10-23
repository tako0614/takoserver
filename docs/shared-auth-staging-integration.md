# Shared Accounts login: staged Takoserver consumer

Status: implemented staging-only protocol client, session/store and conditional
Worker request composition. An owning deployment must provide the selected
profile, schema and credentials; source availability does not establish an
active target or a successful login. Console integration is a separate consumer.
Task 0109 coordinates the remaining owner changes and their release evidence.

## Implemented protocol boundary

`src/shared-auth-oidc-client.ts` consumes the Accounts-owned first-party OIDC
HTTP contract. It does not import Accounts or another product's source, and it
does not use the existing `takos-id` Organization projection.

The client requires explicit `environment: "staging"`, the registered client
`takoserver-console-staging-v1`, the selected exact first-party staging issuer
and API/RP origins in `SHARED_AUTH_STAGING_PROFILE`, and a server-only client
secret. The session factory additionally requires that profile's exact Console
origin before constructing the client or accessing storage. An arbitrary HTTPS
origin, alias, subdomain, trailing dot, explicit port or swapped role is refused
before any credential-bearing transport. Credentials and registration remain
operator configuration outside this repository. The registered redirect must exactly equal
`<api-rp-origin>/auth/oidc/callback`. The separately hosted static Console is
only a fixed return/CORS origin. The API owns the callback and cookie: moving
the callback to the Console would not authenticate the API's host-only session.

The code flow uses S256, state, nonce, explicit consent and `offline_access`.
Token exchange, rotating refresh, introspection and revocation authenticate
with form-encoded HTTP Basic. All HTTP requests refuse redirects and bound
headers-plus-body handling to five seconds. Requests use `manual` redirect mode
and reject/cancel all non-success responses before consuming credentials or
parsing bodies; no credential is sent to a redirect target. JSON bodies are limited to 64 KiB
and reject duplicate members. JWKS are read from the issuer's `/oauth/jwks`.
The fixed endpoint paths are an explicit first-party contract rather than
dynamic discovery of unrelated destinations.

The ID token must have an ES256 signature against exactly one matching public
P-256 signing key, the exact issuer and single client audience, an initial
nonce, `sub`, `sid`, `auth_time`, `iat` and `exp`. Its lifetime is at most five
minutes. A refresh ID token must retain the subject, Accounts session and
authentication time. Refresh success without a new ID token retains the prior
identity; successful rotation must return a different refresh token. Activity
is checked with the Accounts owner's authenticated introspection endpoint.
`canonicalAccount` confirms the exact subject and audience with Bearer-authenticated
`/oauth/userinfo`, whose first-party contract resolves only a live canonical
account root under an enabled client and a current account/session fence.
Its response's `sub` and `aud` must match the grant; `scope` must be identity-only
and include `openid` and `offline_access`. The consumer returns only
`{ accountId }` and refuses product authority fields.

The registered shared-account profile gives both first-party clients the same
canonical Accounts account ID in `sub`. The client returns that opaque identity
without an email lookup or a role/membership projection. ID tokens carrying
Organizations, Workspace roles or other product authority are refused. Access
tokens obtained here are identity-only credentials for the issuer's own
endpoints, never Takoserver business API keys.

## Session runtime

`src/shared-auth-session.ts` supplies login, callback, logout and session
handlers, a server-only authenticated actor/context port, and current
Workspace/Organization resolution. Its required principal projection is an
owning Takoserver port that preserves proved local actor references; there is
no email matching or alternate account registry. Organization pins require a
separate owning port and never imply financial consent.

The API issues random `__Host-` Secure/HttpOnly/SameSite=Lax cookies. Only their
SHA-256 digests are indexed. Attempt state, nonce and verifier and upstream
grants are encrypted with AES-GCM under the operator-supplied 32-byte local
key, with associated data binding purpose, digest, issuer, client, API and
Console origins. The callback atomically consumes its attempt before exchange,
confirms the current canonical account, explicitly bootstraps its personal
Workspace and verifies current owner membership before creating an active
local session. Before principal resolution, that same verified grant must also
return an exact billing-organization tuple for the selected personal Workspace.
The callback checks its three fields and selected Workspace ID, then holds a
detached tuple only in its receiver-bound fresh original. A missing or changed
tuple refuses the fresh callback before principal resolution or session creation;
it does not infer an Organization from the account or session identity. It
redirects only to the configured Console root, and never
returns an upstream grant to the browser.

The frozen directory contract uses the same RP Bearer grant at
`/api/v1/account/shared-workspaces`: the current menu with a selected Workspace,
explicit `POST /bootstrap {}`, and `GET /:id/billing-organization`. Every
authenticated request confirms the current canonical account, current
Workspace membership and qualified local principal. Token roles and retained
legacy memberships provide no shared-session authority. The Organization
context is checked again after its owning pin operation.

`src/shared-auth-session-store.ts` receives fresh primary-consistent SQL for
each request. It atomically burns attempts, serializes refresh with a version
claim, and keeps encrypted grants in a durable revocation outbox. A competing
request while refresh is in progress receives temporary unavailability; an
unknown refresh or completion acknowledgement is never replayed. Newly known
rotated grants are durably queued together with a local denial fence. The
issuer's same-client revocation of a retained spent refresh handle revokes the
current family when a rotation response was lost.

Sessions expire after twelve idle hours or seven absolute days. Grant health
is checked at most every four minutes and before imminent access expiry;
canonical account and Workspace checks remain live on each authenticated
operation. Logout immediately fences the local session and clears its cookie.
It leaves upstream cleanup in the durable outbox instead of delaying the
browser on an issuer outage. The owning maintenance entry must call
`retryRevocations` with at most two grants per pass; only revocation has a
retryable lease. A crashed refresh claimant stays denied until login/revoke,
and is never reclaimed for another refresh.

Only an acknowledged shared callback expires the legacy browser cookie. Shared
logout expires both cookie names, without revoking a legacy database session.
A request with only the named legacy cookie is rejected before either cookie
is expired or a shared session is revoked, so another tab's legacy login cannot
be cleared by a stale shared logout.

Callback failure diagnostics contain only a closed phase, error class and code.
Fresh OIDC exchange failures add the closed token/JWKS endpoint and reason;
Directory bootstrap and billing-organization failures add a closed reason and
bounded HTTP status or null. These records contain no exception text, token,
request body or Workspace/Organization identifier. Logging failure cannot alter
the response, cleanup or existing five-second request deadline. A missing record
does not establish that an issuer operation was not sent or committed.

The portable native D1 tests use explicitly unadopted test-only DDL. These
modules do not create tables or select a public migration number. Adopting the
forward schema, principal projection, maintenance entry, Console flow and
protected composition remains an owner-coordinated change. The current
factory cannot enable an authentication surface by itself.

### Private final-session observation

The store module provides the dedicated private
`createSharedAuthFinalSessionStore(sql): SharedAuthFinalSessionStore` factory.
It shares ordinary operations with `createSharedAuthSessionStore` and captures
that same supplied Sql; it creates no connection, money wrapper, extra query
or retry. The ordinary factory keeps its boolean touch and rejects zero-row
results from its own selected-row method.

The dedicated factory is accepted only in the owning strict-connected common
primary composition: the actual explicit-result native driver, the existing
money wrapper applied once, and the same final Sql/native client/realm used by
Auth, RP and Financial under a fresh first-primary request. A generic Sql
object, the factory name, or a configuration flag cannot supply that
qualification. The adopted driver source contract uses
`createD1Sql(database, { acknowledgement: "explicit-d1-result" })` and preserves
legacy/default behavior elsewhere. Its raw success, result array and change
metadata must survive explicit validation; unknown metadata cannot become a
known zero. Actual driver and common-factory native qualification remain
separate owner work.

`touchSessionAndSelect` performs one guarded primary `UPDATE ... RETURNING *`
and validates the actual count and returned image. A complete, genuinely
strict-connected `0/[]` acknowledgement returns null. Exactly one returned
row must conserve digest, account, local principal, stored Workspace,
encrypted payload, creation/expiry/health times, requested touch time and the
actual post-update version. An acknowledged first null permits one reload of
an active compatible row with the same grant/immutable facts, strictly newer
safe version and valid lifetime, followed by one guarded retouch. Only that
retouch's actual returned image can be selected. A second null, changed row,
unknown acknowledgement, exception or malformed result is unavailable with
no additional read, touch resend or refresh.

The service constructor captures an optional private
`finalStore: () => SharedAuthFinalSessionStore` callable and receiver once.
`observeFinalSession` and `observeFinalWorkspaceOrganization` require it;
absence is unavailable without invoking the ordinary store as a fallback.
Existing `authenticate`, `workspaceOrganization` and HTTP handlers retain the
ordinary RP's bounded compatible-touch behavior and register no final
selection. All paths share the same authentication, issuer, refresh,
Directory and Organization-resolution core; only the lexical final-touch
policy differs. The private observation consumer ABI is adopted as source
contract, while actual common-factory connection and activation remain
unqualified here.

The in-process `finalSessionSelection(context)` reader accepts only the exact
original context object produced by that factory instance. Its closure-local
WeakMap holds an immutable selection with the real session digest, actual
post-touch version, validated identity and observation times. The stored
session Workspace anchor and the request's selected current Workspace remain
separate. The final Organization result is registered after its post-pin
authentication, including the exact new returned context object. Request
URL/method/headers are captured before authentication awaits; this seam never
consumes or forwards the request body. Principal and pin callables and their
receivers are also captured once.

There is no HTTP/RPC endpoint, browser response field or persistence format
for this selection. Cloning a context or supplying the same fields does not
preserve provenance. The explicit HTTP handler projects its existing
response, and the Worker fixture mounts only its existing test handlers.
The observation linearizes at the acknowledged primary update; a later
touch or revoke can make it stale. The owning consumer must use its genuine
in-process factory/context/selection and independently fence the actual
selected row plus its own authority on the same primary at the effect
boundary. Row CAS versions supply no authority class, payer, consent, realm,
source epoch, enrollment receipt or Financial admission. Retained authority
history belongs to its separate owner and cannot be replaced by this
WeakMap.

The authored component tests target the adopted strict-driver option and
exercise actual native D1 one-zero/one-reload/one-retouch, real post-commit
acknowledgement loss, second misses and malformed images. Outer response-loss
injection is synthetic and labelled. They require the owning driver changes
before execution; source preparation or TypeScript casts do not qualify
native acknowledgement semantics, a fake store or a common-primary graph.
No driver, entry, schema or Financial source change is implemented in these
RP files.

## Workspace billing Organization

The Organization in the billing-organization tuple is derived, not created
by a call between the services. Contract
`takoserver.workspace-billing-organization@v1` in
`src/workspace-billing-organization.ts` defines it as `org_wb_` followed by
the first 32 lowercase hex digits of SHA-256 over the compact JSON array
`["takoserver.workspace-billing-organization@v1", billingAuthority,
workspaceRef]`. `billingAuthority` is the served financial realm's value, and
the Accounts setting `TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY` must equal
it. `workspaceRef` uses the wallet Workspace grammar of at most 128
characters.

Accounts computes the id when it ensures a Workspace's Organization. The same
Workspace and authority always give the same id, so a retry creates no second
Organization and needs no Takoserver credential. Takoserver never accepts a
tuple whose `organizationId` differs from the derivation for its own realm.

The Organization rows are written in the fresh principal issuance that mints
the Workspace owner, because `orgs` requires an owner principal. The
materialization statements first insert the Org, then its owner membership,
then the Workspace binding, so Root 0105's birth capture sees the Org before
any Org-keyed trace row. A later login by the same principal inserts nothing.
A different owner, a missing owner membership or a Workspace bound to another
Org aborts the issuing batch. The id locates product records and grants no
payment consent.

A later login by a subject whose only binding is its active, current root
binding reuses that same principal and binding: the callback issues a new
session and credential class on the existing binding and sends only the
Organization owner guard, which writes nothing and aborts unless the same
Workspace is bound to the same Org that principal owns. A subject enrolled
before its Org existed, or whose Workspace now names another Org, is refused
rather than given a new or transferred Org.

Operator note: enabling a billing realm on a deployment where subjects have
already enrolled without one leaves each of those subjects refused with
`session_unavailable` (503) on every later login. There is no automatic
recovery; materializing their Orgs is a separate, owner-coordinated repair. The batch re-proves the binding, its anchor, target, issuer and
subject through the credential class guard, so a binding retired or crossed
after resolution aborts the whole batch. A subject with no binding enrolls a
fresh principal; when two first logins race, the Auth103 binding trigger lets
one commit and the other fails closed as `session_unavailable` without retry.

There is no owner transfer and no re-enrollment. A subject whose binding is
retired, is a successor or proved-legacy binding, or names another native
target, is refused
before issuance; its Org stays owned by the previous principal and no second
Org is created. A successor binding is a separate authority action.
Workspace bindings are global and set once, and a hold or usage record
normally creates its Workspace's binding lazily. Accounts issues every
shared-auth Workspace reference as `wrk_` followed by 32 lowercase hex digits,
so that namespace is reserved. In the canonical Hosted billing composition,
which has a qualified financial realm and its `billingAuthority`, a hold or
usage record that would create the first binding for a reference matching
`^wrk_[0-9a-f]{32}$` is refused unless its Organization is the derived
`org_wb_` id for that reference and authority. Without the reservation, an Org
with `wallet:write` could bind another Workspace's reference before the
owner's first login, and that owner's issuance would then be refused with no
repair. The refusal is the billing service code `workspace_ref_reserved`
(409), sent on the wire as `conflict` like `workspace_ref_conflict`. It
writes no hold, usage, ledger or binding row: the reserved binding is never
in the admission batch, and the admission row requires it. An existing
binding behaves as before: the same Org is admitted and another Org gets
`workspace_ref_conflict`. Other references, such as operator-chosen opaque
references used by personal or created Organizations, keep lazy first
binding. Self-host and compositions without a realm do not reserve the
namespace. The rule is in `src/org-workspace-usage.ts`; the authority comes
only from a canonical composition (`hostedSharedWorkspaceAuthority` in
`src/hosted-billing-composition.ts`).

## Existing behavior that requires a separate owner change

The audit base is Takoserver commit
`b7649192cb901fbcbd1b60c4192d294d33a84f84`. `src/auth.ts` currently accepts
`google`, `github` and `takos-id`; migration 0016 permits those same providers.
The `takos-id` branch deletes/reprojects local Organization memberships from
token claims and rejects local Organization creation. That behavior is a
different contract and must not receive the shared-account profile.

Existing `/v1/sessions` accepts a provider assertion and can return a bearer
token to API clients. The new server code flow must not pass refresh tokens
through this route or the browser's existing `console/src/takos-id.ts` flow.
`resolveIdentity` currently makes legacy Takos ID and direct Google mutually
exclusive. This preparation does not change those self-host and operator
recovery paths.

## Required integration order

1. Accounts owner publishes the registered staging client, canonical account
   profile and the current-account/Workspace directory contract. Token
   introspection must reject a disabled or merged-away account and revoked
   session/family. Confirm the canonical subject with that owner's authenticated
   UserInfo/introspection contract; do not invent a parallel account registry.
2. Agree with Takoserver's protected-path owner on the source integration,
   schema and exact realized staging surfaces. Add the protocol module to the
   domain classification in `scripts/check-imports.ts` only after that owner
   agrees. The prepared hunk adds one exact module name, without exempting a
   directory or changing permitted dependency directions.
3. Adopt the prepared trusted server session adapter, with a durable
   single-use login attempt and a host-only `__Host-` HttpOnly Secure cookie.
   Validate exact request origin, duplicate callback parameters, state, optional
   response issuer and the attempt's nonce/verifier. Atomically consume the
   attempt before exchange. Never accept caller-supplied claims, an incoming
   identity header or the email as a login binding.
4. Adopt the prepared durable local session store and explicit account-to-principal
   binding. One canonical Accounts ID can bind at most one local actor; preserve
   existing local principal, Organization, API-key and billing references when
   adopting a proved legacy account. Newly provisioned product actors require
   an agreed new provider/projection contract, not a fake `google` or `takos-id`
   value. A migration that expands `principals.provider` and adds binding,
   attempt and session state must preserve prior rows and the migration
   lineage. Do not reserve or author a migration number here: the schema owner
   must allocate it after the billing and dispatch migrations.
5. Keep grants encrypted under an operator-managed local session key, with
   associated data binding the environment, issuer, client, API and Console origins.
   Cookie secrets are random; only their digests are indexed. Keep idle and
   absolute expiry, current grant activity and revocation local to the RP.
   Serialize refresh through durable version/compare-and-set ownership. Lost
   acknowledgement or a crashed refresh claimant requires login; never retry
   the old refresh token. Logout revokes the local session before upstream
   revocation. Confirm recovery and key rotation before enabling this adapter.
6. Wire `src/auth.ts`/`src/app.ts` and the protected `src/control.ts` and owning
   `src/entry-*` composition only after review of the above schema and ports.
   Advertise the route in the owning OpenAPI and Console contracts. The Console
   starts a server redirect and never receives client secrets, access tokens or
   refresh tokens. Its normal APIs use the product's local session. Preserve
   direct Google and operator sign-in until staging proves the new path.
7. Resolve Workspace membership live from the Accounts-owned directory for
   authenticated operations. Bind each canonical Workspace to its intended
   Takoserver Organization with a durable, immutable product-context pin.
   Do not authorize from token roles, email equality, a browser Workspace ID,
   or the old `takos-id` Organization projection. Revocation and cross-Workspace
   attempts must fail before business or billing access.
8. Run local complete CI at the final candidate, obtain QA's exact-head
   approval, merge that exact head and publish only the coordinated staging
   surfaces. Staging E2E must use the actual issuer, local session store and
   live membership checks, including replay, wrong client, disabled/merged
   account, refresh race, logout, revoked membership and legacy recovery.
   Production deployment and login/route cutover remain awaiting approval.

The protocol tests use real generated ES256 signatures and actual Request and
Response bodies through an in-process HTTP transport. They verify cryptography
and client behavior; they are not evidence that the staged login routes, durable
stores or real issuer have been deployed.
The workerd tests execute the actual bundled client with a local synthetic
issuer for signed exchange, refresh, introspection, UserInfo and revocation.
They catch Request-constructor/runtime differences that a Bun transport alone
does not exercise and reject redirects for every authenticated operation.

Protocol references: [OpenID Connect Core ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation),
[OAuth client authentication](https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1),
and [OAuth security best current practice](https://www.rfc-editor.org/rfc/rfc9700.html).


## Explicit action-consent data modules

`shared-auth-financial-consent-contract.ts`,
`shared-auth-financial-consent-schema-plan.ts` and
`shared-auth-financial-consent-store.ts` provide unmounted consent data
interfaces. The schema leaf is unnumbered and unregistered: three append-only
tables and their preservation constraints do not install a migration or enable
a login, billing or consent route. These modules have no package-barrel or
HTTP export.

The contract parser binds the complete action, original challenge, selected
terms reference and digest, selected Organization/Workspace, RP session facts
and independent consent issuer. A consent reference is opaque. The consent
issuer's registration and incarnation are separate from challenge and identity
proof registrations. The consent digest covers its versioned core; custody of
the complete canonical original bytes has a separate digest. Neither identity
proof metadata nor matching digests establish explicit human consent or the
origin of selected terms. No identity-proof reference is reused as a consent
proof reference. The durable leaf applies its narrower text and byte limits
without truncating or converting a larger codec value.

The store exposes the following data operations:

- `createSharedAuthFinancialConsentOriginalReader(...).readOriginal(command)`
  loads exact immutable fullcommand and same-row mandatory receipt custody.
  Only positively complete absence returns `undefined`; pending-only,
  command-only, partial/corrupt rows and query failures cannot establish absence
  or permission to send again. Historical custody remains readable after expiry
  or retirement and does not imply current permission.
- `createSharedAuthFinancialConsentLocalCurrentnessReader(...)` checks local
  SQL predicates after loading that same historical original. A local nonmatch
  is data, not a grant to issue a new command.
- `captureSharedAuthFinancialConsentRequestCommandData(...)` connects an actual
  captured request Sql write to the exact command postimage check.
  `captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(...)` orders
  that write, its successful actual acknowledgement, the guarded original and
  mandatory-receipt INSERT, its exact postimage check and original fullcommand
  GET on the same captured request graph and Sql receiver.
- `createSharedAuthFinancialConsentRequestCommandRecovery(...)` retains the
  original fullcommand and exposes only `readOriginalData()`. Unknown outcomes
  never create another key, change family, retry a write or authorize a consume
  from an ambiguous command-only row.

The ordered effect detaches the full input before its first await, validates
the original recipe and both fixed statement builders before its first write,
and rechecks the actual graph and method identities around awaited operations.
Only that invocation's actual one-row command acknowledgement reaches consume.
The consume result must have the exact fourteen returned columns, matching
whole original bytes and mandatory receipt, and an actual affected count of
one. A caller-constructed matching postimage proves data equality only.
Capture and consume remain two separate Money permit transactions; the whole
sequence is not atomic. A crash or acknowledgement loss can leave command-only
custody that cannot be safely resumed. Repeating the low-level function is not
a first-attempt, never-dispatched or new-command authorization protocol.

An actual affirmative confirmation and pending producer, qualified retained
credential plus distinct human binding, qualified Clock/current admission,
coherent original Financial action and displayed R1 terms, and the genuine
current consent verifier remain separate integration work. Retained credential
Workspace and the selected financial Workspace remain distinct facts. Final
Financial payer/class/source checks and the same-primary command CAS still
belong in the actual owning mutation. No field, local origin assertion,
standalone SELECT, remote boolean or opaque proof DTO supplies those missing
authorities. In-memory synthetic fixtures exercise local mechanics; they do
not qualify actual D1, schema enrollment, a real issuer or a staged payment
journey.
