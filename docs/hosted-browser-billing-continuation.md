# Hosted browser billing continuation

Status: agreed contract and source integration, not a deployed Hosted mount.
The optional `hosted-browser-v1` integration keeps the browser's Server session
on the Server origin and continues the original Hosted Workspace operation.
Missing native suppliers remain unavailable; configuration alone grants nothing.

## Browser journey

Hosted retains an unaccepted request under one random 64-lowercase-hex selector.
The browser opens the dedicated Console path
`/billing/hosted-continuations/{selector}`. The fixed path survives same-tab SSO;
it does not select a new Organization or purchase from the ordinary Console
billing page. The selector is only a locator, not a session or payment key.

The Console loads `GET /v1/billing/hosted-continuations/{selector}` using its
actual shared Server session and configured Console Origin. Before disclosing
the selected operation, the Server authenticates that request, checks the same
canonical account as Hosted's retained request, resolves the selected Workspace
and Organization through its actual RP, and calls `Accounts.requireOwner`.
An API key or another owner of the same Organization cannot substitute for the
retained canonical account. Hosted's historical command owner is a separate
field and does not identify the current requester.

The metadata response contains `continuation` with the contract version,
selector, `kind`, selected `workspaceId`, `workspaceRef`, and `organizationId`.
For `view`, `operation` and `phase` are null: viewing Free, balance or usage
does not create a payment command. For `payment`, `operation` contains the
selected action, existing HTTP method/path and exact existing body; `phase` is
`prepared`, `dispatch-started` or `outcome-recorded`. Internal Hosted source,
historical owner and physical command records are not UI permission fields.
Financial facts still come from the existing Organization wallet, subscription
and Workspace-usage reads under that Server user's current owner checks.

A command-free view may first collect an explicit action choice in the Console.
`POST /v1/billing/hosted-continuations/{selector}` accepts exactly one of:

| `kind` | Choice fields |
| --- | --- |
| `topup` | `amountMinor`, `checkoutConsent: "interactive-checkout"` |
| `start` | `planKey`, `consent: "subscription-checkout"`; optional original reconciliation consent |
| `cancel` | `consent: "cancel-subscription"` |
| `change-plan` | `planKey`, `consent: "change-subscription-plan"` |

The browser supplies no account, Workspace, Organization, current subscription
target, command reference or operation key. The Server rechecks the same real
shared-RP request and Owner, validates configured amount bounds/plans, and reads
the actual current subscription for CANCEL/PLAN. Hosted separately revalidates
its retained RP and family custody, then conditionally stores one immutable,
unaccepted payment proposal linked to the existing selector. The original view
witness is unchanged. This preparation neither accepts a financial command nor
starts a payment. It returns the same metadata DTO, now `payment/prepared`, only
after a positive preparation acknowledgement; an exact already prepared reply
is read-only. Unsupported legacy or successor custody remains unavailable.

A lost preparation acknowledgement permits only a GET using that same selector.
A later `view`, timeout or expired witness does not prove that no proposal was
written. The Console must not resend preparation, replace the selector, mint a
new key, or automatically turn an unavailable view into another purchase.
The prepared proposal still needs a separate real effect confirmation below.

This is the caller's recovery rule, not a claim that Server can recognize every
later manual POST after a lost response. Server has no durable attempt marker.
Hosted must retain one immutable proposal per selector: the same committed
original is read-only and another choice conflicts. If the first attempt never
committed, a later manual POST may create the first durable proposal. The first
ephemeral key is not claimed preserved. This does not permit automatic retry or
create payment permission; strict one-invocation enforcement remains
unqualified. Native tests must prove selector uniqueness and zero financial
effects under repeated POST. The final claim/effect unknown fence is unchanged.

After displaying the selected action, the Console submits its original body to
the existing endpoint with this header:

```http
Takoserver-Billing-Continuation: hosted-browser-v1.<64-lowercase-hex-selector>
```

| Action | Existing endpoint |
| --- | --- |
| Top-up | `POST /v1/organizations/{organizationId}/wallet/checkout` |
| Subscription START | `POST /v1/organizations/{organizationId}/payments/subscription` |
| Cancellation or plan change | `PATCH /v1/organizations/{organizationId}/payments/subscription` |

Existing request bodies, financial references and family receipt GETs remain
unchanged. The Server compares the selected Organization, method, body and full
Hosted original again for that actual effect request. Malformed, duplicated,
unknown-version or unsupported selectors are refused with 400. A selected
request never falls back to ordinary authentication or payment when the native
supplier is absent or unknown. Header absence preserves the independent Server
HTTP lane.

## Financial same-request owner reader

`src/financial-hosted-owner-read.ts:createFinancialHostedOwnerRead` captures the
actual Server `Request`, code-selected Shared RP/Accounts receivers and Console
Origin. It authenticates once and returns only `accountId` DATA plus
`assertCurrent(originalRequest, {canonicalAccountId, workspaceId, workspaceRef,
organizationId})`. The assertion observes the actual final
RP selection, compares the original account/Principal/issuer/session and exact
Workspace/Organization, then calls the real `Accounts.requireOwner`. It pins the
first account/Workspace/Organization tuple and rechecks captured callables and Request headers around its
awaits. A different Request, source substitution, owner loss or scope change
denies the read. No Actor or reusable user credential is returned.

The selected Control path uses this literal reader for its existing initial
authentication and current-owner checks. Those checks retain the existing
observer/Owner sequence; the separate final command authorization and effect
fence still decide payment dispatch. This reader does not grant consent or
acceptance permission. A continuation selector, billing source reference or
source epoch is not an additional requirement for this owner-read assertion;
Hosted retains its separate business/source guards.

The reader requires an actual **Server** Shared RP Request. A Hosted account ID,
its RP witness DATA, or an Organization read key cannot construct that Request
or its Actor. The published one-argument native read contract below does not
transport this owner-reader callable. A native Hosted composition must connect
the owning current-user source explicitly; this module does not mount it or
change the RPC contract. The existing Worker `wallet:read` transport and its
selected private key binding remain separate from human read authorization.

## Published native business contract

The optional operator-composed named Hosted entrypoint supplies:

- `prepareBrowserBillingContinuation(lookup, liveServerSelection)`
- `readBrowserBillingContinuation({continuationRef, canonicalAccountId})`
- `claimBrowserBillingContinuation(lookup, liveServerAuthorization)`
- `recordBrowserBillingContinuationOutcome({continuationRef, original, outcome})`

The request-local native selection target exposes a prototype
`readSelectionCurrent(scope)`. It returns only the captured explicit choice and,
where needed, the subscription target read from the Server owning service in
that same Request. It rechecks current Owner/scope and rejects a target change.
Hosted calls it around its own preparation guards and never retains the stub.
Its result is selection DATA, not payment authority; preparation is separate
from the final authorization target used by claim.

The read result is a closed `view | payment | refusal` union. A payment original
retains the entire scope and family request/claim, including explicit consent,
predecessor and START reconciliation selection where applicable. Its reference
is never derived again. Original proposals do not guess an accepted generation:
generation and previous lineage come from the actual family store output.
The `change-plan` command maps to the existing Server `plan-change` receipt.

A named binding is a service capability, not end-user authentication. The
operator must compose only the reviewed Server caller; neither product forwards
these methods from public HTTP or accepts a browser-provided authorization
object. Server source does not import Hosted internals or its session store.
No Cookie, raw grant, reusable user token or replacement billing key crosses
this contract.

## Currentness and one-way acceptance

The Server live `RpcTarget` exposes a prototype
`assertOriginalCurrent(original)` method only within the still-running browser
request. It binds that request, exact original, actual RP receiver and current
Accounts Owner. Hosted awaits it at its final family guard and keeps its own RP,
Directory, context, source and legacy checks. The Server callback supplies only
the Financial current-owner/confirmation part; it does not assert Hosted
currentness.

Hosted's own conditional RP witness is tied to the actual session row and
selected Workspace binding. Resume rereads that original inside the same RP
factory, without a synthetic Request, Cookie, refresh or saved permission
Boolean. Stale, revoked, checking, expired or unknown custody denies acceptance.

Hosted acceptance must consume the exact proposal, write the existing family
command/current pointer, mandatory acceptance receipt and dispatch fence in one
primary D1 batch. A zero-row or conflicting prefix, command, pointer or required
postcondition must fail a statement and roll the entire batch back. A JavaScript
exception after a committed batch is not rollback. Existing terminal,
continuation and context-witness guards remain in that owning path.

Only `fresh-dispatch`, returned after the new transition is positively
acknowledged, can reach one Server business dispatch. `accepted-history` carries
no new permission and the effect request returns conflict without another
effect; metadata and family receipt GETs provide readback. A lost claim ACK or
transport failure remains unavailable even if acceptance may have committed.
Absent receipt, expired witness or another login does not release that fence or
justify a new selector, key or automatic resend.

The Server keeps the handler alive through claim, its final current-owner check,
the actual existing business call and same-original receipt/outcome handling.
It does not move dispatch to background work. RPC argument disposal closes the
remote callback wrapper; the underlying Server authorization remains owned by
the HTTP handler until its `finally`, then becomes unusable. Disconnection and
unknown effect/outcome ACKs retain original custody for read-only reconciliation.
The callback follows the platform's [RPC lifetime and disposal rules](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/).
Outcomes come from the Server's durable original receipt, never a browser
redirect or caller-supplied paid flag. Hosted does not settle money.

## Qualification

Each owner implements and tests its own source. The actual App must pass its
code-selected RP and Accounts instances; interface shape alone is not that
provenance. Source types do not install the named binding, migration, RP witness,
family store, Console view or default mount. Focused source checks do not replace
the combined exact-source complete gate, native RPC/rollback/lifetime tests,
real browser flow, signed Stripe TEST delivery and same-event service receipt.
Production remains a separate operator decision.
