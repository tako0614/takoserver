# Authenticated Hosted billing staging journey

`scripts/hosted-billing-business-e2e.ts` is an executable client for one original
personal Organization, one Workspace attributed closed usage record, one paid
subscription start, and one top-up. It uses the existing HTTP routes in
`src/control.ts`. It does not provision a target, create credentials, configure
Stripe, deploy, apply schema, send a webhook, or run operator reconciliation.
The live service owns all authentication and authorization decisions.

This source entry is **not** staging acceptance. `verify` reports public
readbacks and always reports `webhookProven: false`, including when optional
saved service receipt data matches. Checkout completion or a
`paid` top-up GET may be observed through Stripe reconciliation; neither alone
proves that the configured webhook received and processed an actual Stripe
TEST event. The owning operator must retain the exact TEST event/delivery
evidence and a matching service receipt before declaring webhook acceptance.
There is no public per-event webhook receipt on this API. Do not substitute a
synthetic signed webhook, a local server, or the operator reconcile POST.

## Explicit fresh TEST account-realm binding

The selected integration D1 must first have the exact ordinary Root 0105
migration installed through the owning schema surface. The separate
`takoserver-hosted-billing-realm` surface then calls the existing fresh-realm
binder. Select the same integration target descriptor used for that D1 and a
read-only production target descriptor so the two D1 IDs and names can be
compared with `TAKOSERVER_DEPLOY_TARGET_INTEGRATION` and
`TAKOSERVER_DEPLOY_TARGET_PRODUCTION`. The integration target must contain
`hostedBilling.selector` = `canonical-test`, `stripeMode` = `test`, its exact account ID and billing
authority, `billingConfig`, the exact `hostedPricing` authoring string, and
`consoleOrigin`. Set `STRIPE_SECRET_KEY` through the existing operator
environment; the client authenticates the account and reads every configured
monthly Price in TEST mode. The bind does not need the webhook secret.
The Financial module is implemented locally; these commands become available
only after the Root-owned deploy dispatch and contract are integrated. No
actual account-realm bind is recorded by this procedure.

```bash
bun run deploy -- takoserver-hosted-billing-realm --status --environment=integration --commit=<exact-source-HEAD>
TAKOSERVER_INDEPENDENT_REVIEW=<independent-reviewer> \
  bun run deploy -- takoserver-hosted-billing-realm --apply --environment=integration --commit=<exact-source-HEAD>
```

Both actions read the exact D1 migration ledger, canonical schema shape,
native D1 identity and target descriptor. `status` is read-only: an unbound
result is an observation, not permission to bind. `apply` performs at most one
guarded INSERT and reads back the exact immutable pin. Financial history, a
different pin, a live mode, wrong authenticated account or Price, schema or
target drift, and unknown readback stop the operation. A lost INSERT
acknowledgement is settled by the same exact pin read; do not blindly repeat
`apply`. The result is operator D1 and Stripe TEST data, not a serving Worker
proof. Worker startup separately requalifies the pin with its actual SQL and
Stripe client before this business journey can start.

## Required operator inputs

Use an existing, qualified `takoserver.deploy-target@v2` for `integration` or
`rehearsal` with `hostedBilling.selector=canonical-test`, `stripeMode=test`,
and the exact `hostedPricing` authoring string used by that target,
the final serving source/version, qualified financial realm/schema, matching
TEST account/Prices, and the exact public origin. The descriptor and local
Takoserver owner **session** are operator-private owned regular files with
mode 0600. A Hosted account token, API key, or selected target descriptor
does not establish this session. The command never authenticates through a
caller-selected Organization or principal ID. The `--input` file is also
private 0600 and contains the full exact original usage, subscription, and
top-up bodies; its `sourceHead` is the 40-character selected source HEAD and
`targetSha256` is `sha256:` plus the SHA-256 of the selected target file bytes.
The owning operator must qualify that HEAD against the serving artifact;
this CLI only checks the local checkout HEAD.

Input structure (replace every illustrative value with qualified original
values, including a closed metering body accepted by the target):

```json
{
  "kind": "takoserver.hosted-billing-business-e2e-input@v1",
  "sourceHead": "<40 hex characters>",
  "targetSha256": "sha256:<64 hex characters>",
  "usage": {
    "reference": "<unique original reference>",
    "meter": "<configured meter>",
    "quantityUnit": "<configured unit>",
    "quantity": "<canonical nonnegative decimal quantity>",
    "periodStart": "<canonical UTC instant>",
    "periodEnd": "<canonical UTC instant>",
    "pricingRevision": "<published revision>",
    "expectedMicros": "<nonnegative decimal integer>",
    "measurementFingerprint": "<qualified measurement fingerprint>",
    "workspaceRef": "<opaque Workspace reference>"
  },
  "subscription": {
    "reference": "<unique original reference>",
    "planKey": "<planId from the target plan table>"
  },
  "topup": {
    "reference": "<unique original reference>",
    "amountMinor": 500
  }
}
```

The journal directory must be outside the repository, owned by the current
user and mode 0700. `--journal` and `--handoff` are new absolute paths under
that directory. `start` creates the append-only 0600 journal; it fsyncs the
complete nonsecret command body and Organization binding before each POST.
It never logs bearer material or Checkout URLs. Checkout URLs are placed in
separate 0600 `--handoff.subscription.url` and `--handoff.topup.url` files,
without overwriting existing files. Treat these URLs as bearer capabilities;
open them only in the isolated TEST browser. The CLI prints only their paths.
HTTP refusals report only the request method and numeric status (for example,
`HTTP GET 401` or `HTTP GET 503`). Response bodies, status text, URLs, session
material and arbitrary error messages are never included in the CLI diagnostic.
Transport failures remain unknown; every failure retains the instruction to
inspect the original journal and never repeat `start`.

The 0600 session file contains the original local `auth_tokens` session secret,
sent as Bearer under the existing public API contract. The business request
itself must pass the Server's current Owner check. No Org API key replaces this
same-user session after an Owner preflight. This operator entry does not mint
a session or change any API body or authorization policy. Shared Server RP,
Hosted and issuer cookies are not a supported session input for this public
API journey; a shared-cookie journey requires its own serving-source Owner
HTTP connection and is not qualified by these operator tools.

```bash
./node_modules/.bin/biome check scripts/hosted-billing-business-e2e.ts
bun --no-env-file scripts/hosted-billing-business-e2e.ts \
  --phase start --environment integration \
  --target /absolute/private/target.v2.json \
  --input /absolute/private/original-input.json \
  --session-file /absolute/private/local-session-token \
  --journal /absolute/private/0700/billing-original.jsonl \
  --handoff /absolute/private/0700/billing-checkout
```

`start` first checks `/v1/me`, then invokes session-only
`POST /v1/organizations/personal`. A shared-auth Workspace ref (`wrk_` plus 32
hex digits) is different: its billing Organization is derived from the
target's `hostedBilling.billingAuthority` and was created at the owner's first
login, and personal Organizations exist only for google/github principals. For
such a ref, `start` requires that derived Organization among the session's
`/v1/me` Organizations, journals it as a selection, and creates nothing. It
then reads wallet, usage summary, Workspace
summary, and subscription plan table; compiles the selected target's
`hostedPricing` with the existing pricing parser and requires the entire public
`planTable` to match that compiled table before posting usage, starting a
subscription, or starting a top-up. This checks published plan values and
meter units and rational rates, including Container meters when the selected
pricing contains them. It uses no prices embedded in this client. A mismatch
leaves the original journal in place and refuses further `start` attempts;
inspect that journal and target through the owning operator workflow. It then
posts the supplied closed usage record and checks a same-Workspace,
same-period filtered Workspace usage snapshot after the usage acknowledgement.
It starts the selected subscription plan only when `usedMicros + pendingMicros`
is at least the positive original usage amount; held micros do not cover a
shortfall. A failed or incomparable snapshot leaves the original usage intent
and acknowledgement in the journal and stops before subscription or top-up. A
failure while publishing the optional Workspace observation also stops there:
the journal remains either the complete usage acknowledgement or that complete
acknowledgement plus the observation, so `verify` can inspect the original
usage through GET readback without reposting it. A
zero amount cannot establish numeric evidence. The top-up starts with its exact
reference and amount. The returned Checkout URLs, when present, are preserved
only in the handoff files. Complete the TEST Checkouts before running the
same command with `--phase verify` and every other argument unchanged.

`verify` makes no POST. It reads wallet and summaries, rechecks the full public
`planTable` against the selected target before reporting, paginates usage records,
reads the saved subscription start command, and reads the same-reference
top-up receipt. Before any HTTP readback it validates the closed journal
records, original Organization binding, and intent/acknowledgement sequence.
Malformed or crossed custody refuses readback and never permits another
`start`. Usage matching covers every original field exposed by the
public receipt; the measurement fingerprint is not exposed. The result reports
`workspaceUsageAggregateLowerBoundProven` with source
`saved-pre-checkout-observation` when the original journal contains the
pre-checkout aggregate observation and the matching original usage receipt is
found. The interval comes from the receipt's `attributionPeriodStart` and
`attributionPeriodEnd`; the input usage measurement interval must be contained
within it, while the filtered snapshot must match it exactly. This is an
aggregate lower bound for the Workspace and its exact attribution interval. It
does not isolate that record's contribution, establish
physical Container metering, native authority, or webhook delivery. Older
journals without the observation can use the current filtered snapshot only
when the original receipt is found and the snapshot still has the exact
receipt attribution interval. If the billing period has moved, the result is
`not-comparable`; it never substitutes current-period totals for the original
period. A zero original amount, missing receipt, or exhausted 100-page scan
never establishes numeric proof. A saved observation remains usable when the
receipt status changes from pending to paid, provided its original attribution
interval and creation time still match. The top-up GET
may perform the owning service's bounded Stripe readback and local
acknowledgement, but its receipt does not expose the original amount. A top-up
GET after a lost POST acknowledgement therefore reports
`topupAmountProven: false` and never hands off its URL, even when it says
`paid`. A saved subscription command GET may restore its URL after matching
Organization, reference, and plan. A top-up GET may restore its URL only when
the original POST acknowledgement was saved. No GET absence
or timeout permits `start` again: a lost POST acknowledgement is unknown, and
the original reference must remain fixed. If personal Organization creation
lost its acknowledgement, the journal records the original `{}` body but has
no safe public personal mapping readback; the CLI reports
`unresolved-personal-ack` and requires owner investigation.
When the table matches, `verify` includes `pricingTableMatched: true`. It also
includes `containerPricingMatched: true` only when the exact table contains all
four configured `container.cpu`, `container.memory`, `container.egress`, and
`container.image-storage` meter entries. This reports published pricing terms;
it does not establish physical Container measurement or usage.

### Optional saved service receipt comparison

`verify` accepts `--service-receipts /absolute/private/receipts.json` as an
additional owned 0600 file outside this repository. The flag is refused for
`start`. Omit it to keep the original verify output. With it, the CLI compares
saved Stripe TEST event objects and saved rows from the selected serving D1
against the original input, journal Organization, target digest, source HEAD,
origin, selected Worker/D1/Stripe account, and public command readbacks. The
JSON must have exactly these top-level fields:

```text
kind = "takoserver.hosted-billing-service-receipts@v1"
sourceHead, targetSha256, origin, organizationId
workerName, d1DatabaseId, stripeAccountId
subscriptionIntent, subscriptionAssociation, topUpCommand, topUp, invoice
```

The three custody objects are projections of **existing** D1 rows. Preserve
`subscriptionIntent` fields `id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,session_id,subscription_id`
from `stripe_subscription_checkout_intents`; `subscriptionAssociation` fields
`subscription_id,org_id,customer_id,livemode,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,session_id` from
`stripe_billing_associations`; and `topUpCommand` fields
`org_id,reference,command_json,state,session_id,session_url` from
`stripe_top_up_commands`. The original start reference is checked against the
custody `request_key_digest` algorithm; the associated session and subscription
IDs are checked through both rows and the original start command's public
`subscriptionRef`. No Stripe ID is inferred from a Checkout URL. The top-up
command JSON is the full frozen `TopUpCommand`, including the account, TEST
mode, customer, money units, realm, expiry, and purpose. Its Stripe Checkout
object must agree on customer, account metadata, original Organization and
reference, amount, realm, expiry, and command digest. The command's retained
return URLs are treated as data and are not used to infer a Stripe ID.

`topUp` and `invoice` each contain `stripeEvent` (selected fields from a Stripe
TEST event retrieval) and `serviceReceipt` (the D1 row projection with
`event_id,type,livemode,object_id,event_created_at,received_at,outcome,outcome_detail,settled_at`).
Read the row by the **same event ID** from the target descriptor's selected D1,
retaining the D1 ID, Worker identity, read method, and timestamp separately in
private operator evidence. A matching top-up needs `checkout.session.completed`
and terminal `credited/credited`; a matching invoice needs `invoice.paid` and
terminal `applied/invoice_credit_granted`. Both rows need `livemode=0`, the
same event/object IDs and types as their Stripe event, and non-null settled
times. The invoice subscription must link through the saved original checkout
intent and association. `received`, `deferred`, `ignored`, or a subscription
Checkout's `subscription_updated` alone refuses the comparison.

Stripe event snapshots retain their creation-time API version, even when the
GET uses a different `Stripe-Version` header ([Stripe event reference](https://docs.stripe.com/api/events/list)).
The comparison keeps that version and supports the legacy invoice snapshot and
the `2026-05-27.dahlia` snapshot separately. The latter must carry its original
`parent.subscription_details`, paid status, zero remaining amount, and positive
paid timestamp; it is not rewritten into a legacy event. Its retained checkout
intent ID must also match the selected D1 intent. Unknown modern versions,
conflicting aliases, modern parents disguised as legacy snapshots, and
incomplete paid facts refuse the comparison.

Matching data adds `serviceReceiptEvidenceMatched: true` and
`serviceReceiptEvidenceScope: "saved-data-only; collection, delivery, and serving provenance unverified"`
to the usual `readback-incomplete` result; it **never** changes
`webhookProven: false`. The JSON and its tuples are untrusted data. This CLI
does not authenticate how Stripe events were collected, which webhook
destination delivered them, the delivery HTTP result, or whether the D1 rows
came from the selected live serving Worker. Those independent native/provider
records and the actual staging journey remain the owning operator's acceptance
evidence. `verify` remains HTTP GET-only on its public connection, although a
GET may perform the service's existing bounded Stripe reconciliation and local
acknowledgement.

To acquire the saved comparison data, use the separate read-only collector
after the original journal has all acknowledgements, including the top-up POST
acknowledgement. Supply the two original `evt_` IDs from independent operator
evidence; the collector does not discover delivery, infer IDs from URLs, or
retry financial commands. Set `CLOUDFLARE_API_TOKEN` and `STRIPE_SECRET_KEY`
through the operator's existing environment, without putting their values in
command arguments or files:

```bash
bun --no-env-file scripts/hosted-billing-service-receipts-collect.ts \
  --environment integration \
  --target /absolute/private/target.v2.json \
  --input /absolute/private/original-input.json \
  --journal /absolute/private/0700/billing-original.jsonl \
  --topup-event evt_ORIGINAL_TOPUP \
  --invoice-event evt_ORIGINAL_INVOICE \
  --output /absolute/private/0700/receipts.json
```

The collector accepts only `integration` or `rehearsal` and checks the same
selected target, original input/source HEAD, journal sequence and Organization
before any provider read. It creates a disposable, private `STATE_DB` Wrangler
configuration from that target's account, Worker and D1 identity. It issues
five finite remote D1 `SELECT` queries for the original subscription intent,
association, top-up command and the two exact event IDs. It checks the
authenticated TEST Stripe account with GET `/account` against the selected
target, then retrieves the two TEST events with GET. The JSON at
`--output` is the exact comparison input for `verify --service-receipts`; the
adjacent `.metadata.json` records the selected configuration identity, ordinary
observation time and the event-creation request IDs carried in the retrieved
event objects when available. Those IDs are not GET transport request IDs.
Both are new
0600 files under an owned 0700 directory; existing files are never
overwritten. Keep both outside the repository. No session or cookie is needed
for this collector.

The collector saves a projection of **parsed Stripe GET responses**, not the
original signed webhook body or delivery response. Its D1 reads are separate
queries, not one atomic serving snapshot. The sidecar's time is an operator
observation, not a native qualified clock. A matching comparison remains
saved-data consistency only; original webhook destination and delivery,
native serving identity, and the real staging journey still need independent
owning evidence. Stripe's event retrieval window can expire, so absent events
refuse collection rather than being recreated.

The client unit test uses an injected fetcher to verify transport and journal
custody. `tests/hosted-billing-business-e2e-control.test.ts` additionally sends
the client through the actual control router with an issued local session and
SQLite-backed personal Organization, wallet usage, Workspace summary, top-up,
subscription Checkout custody, and saved command GET. It removes the local
subscription URL handoff and verifies that GET restores it without another
POST. Its Stripe transport, top-up processor, and customer pin are local test
doubles; the subscription read is pre-settlement, and no signed event is
delivered. `TAKOSERVER_BILLING_E2E_TEST_TMPDIR` can place its temporary journal
on a selected local volume. Actual TEST Checkout, webhook delivery, paid
invoice/grant, cross-product binding, renewal/refund, and qualified live target
remain separate owner evidence. The [billing API specification](hosted-billing-api-spec.md#acceptance-and-unresolved-dependencies)
lists the wider acceptance scope.
