# Shared Accounts login: staged Takoserver consumer

Status: prepared protocol client and unmounted session/store runtime. No login
route, schema migration, Console button, deployment configuration or traffic
cutover is enabled by this change.
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

## Prepared session runtime

`src/shared-auth-session.ts` supplies the unmounted login, callback, logout and
session handlers, a server-only authenticated actor/context port, and current
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
local session. It redirects only to the configured Console root, and never
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

The portable native D1 tests use explicitly unadopted test-only DDL. These
modules do not create tables or select a public migration number. Adopting the
forward schema, principal projection, maintenance entry, Console flow and
protected composition remains an owner-coordinated change. The current
factory cannot enable an authentication surface by itself.

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
