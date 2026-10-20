# Authenticated Hosted billing staging journey

`scripts/hosted-billing-business-e2e.ts` is an executable client for one original
personal Organization, one Workspace attributed closed usage record, one paid
subscription start, and one top-up. It uses the existing HTTP routes in
`src/control.ts`. It does not provision a target, create credentials, configure
Stripe, deploy, apply schema, send a webhook, or run operator reconciliation.
The live service owns all authentication and authorization decisions.

This source entry is **not** staging acceptance. `verify` reports public
readbacks and always reports `webhookProven: false`. Checkout completion or a
`paid` top-up GET may be observed through Stripe reconciliation; neither alone
proves that the configured webhook received and processed an actual Stripe
TEST event. The owning operator must retain the exact TEST event/delivery
evidence and a matching service receipt before declaring webhook acceptance.
There is no public per-event webhook receipt on this API. Do not substitute a
synthetic signed webhook, a local server, or the operator reconcile POST.

## Required operator inputs

Use an existing, qualified `takoserver.deploy-target@v2` for `integration` or
`rehearsal` with `hostedBilling.selector=canonical-test`, `stripeMode=test`,
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

The 0600 session file contains either the original local `auth_tokens` session
secret (sent as Bearer), or exactly
`__Host-takoserver_shared_session=<original-Server-RP-cookie-value>`. The latter
uses the Server's own cookie and the selected target's exact `consoleOrigin` on
every GET and POST; it requires the shared-session Owner HTTP connection in the
serving source. It is never sent as a Bearer token. Hosted and issuer cookies,
multiple cookies and an unselected console Origin are refused. No Org API key
replaces this same-user session after an Owner preflight. The business request
itself must pass the Server's current Owner check. This changes no API body or
consent-proof wire, and does not mint a session or grant authority to a caller
without the actual Server credential.

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
summary, and subscription plan table; posts the supplied closed usage record;
starts the selected subscription plan; and starts the top-up with its exact
reference and amount. The returned Checkout URLs, when present, are preserved
only in the handoff files. Complete the TEST Checkouts before running the
same command with `--phase verify` and every other argument unchanged.

`verify` makes no POST. It reads wallet and summaries, paginates usage records,
reads the saved subscription start command, and reads the same-reference
top-up receipt. Before any HTTP readback it validates the closed journal
records, original Organization binding, and intent/acknowledgement sequence.
Malformed or crossed custody refuses readback and never permits another
`start`. Usage matching covers every original field exposed by the
public receipt; the measurement fingerprint is not exposed. The top-up GET
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
