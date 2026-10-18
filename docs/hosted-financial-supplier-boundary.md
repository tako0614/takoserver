# Financial inputs for the existing Hosted billing composition

This component exposes retained Financial command DATA for the existing Hosted
billing composition. It does not mount Hosted, issue credentials, authorize
payment, or qualify a supplier. Hosted owns its callback and default-entrypoint
composition; Financial owns the original action/R1 reader and all NEW command
acceptance and first-dispatch CAS.

## Existing owning exports and current limitations

| Hosted input | Actual Financial source / owning callsite | Current boundary |
| --- | --- | --- |
| OrganizationApiKeyStore.apiKeyFor(org) | src/auth.ts: createApiKeyAdministration.status / issue | status returns metadata, never a bearer. issue returns a secret only for a newly issued key; an existing id cannot recover it. No credential custody supplier is implemented by this packet. No key is issued or read. |
| assertBusinessAuthoritiesCurrent(request,session) | Financial currentness/CAS must consume Root qualified credential, distinct human, same-primary/realm/epoch/schema-target/Clock and current source | No genuine request-bound supplier is implemented. Root token/retained DATA, membership and a boolean do not provide these inputs. |
| Read/payer/action guards | src/shared-financial-admission.ts: createSharedFinancialAdmissionComponent; src/shared-financial-customer-dispatch.ts: compileCustomerPhase, plus existing private five-action/currentness source | These are owning Server components, not Hosted callbacks or remote atomic permission. All NEW existing-Customer acceptance and first-dispatch CAS remain Financial-owned. |
| Exact historical action, fingerprint, terms and full command | src/shared-financial-retained-r1.ts: createFinancialRetainedR1Store(options).readBusinessRetainedR1Data(exactSharedFinancialAction) -> readJoinedRetainedR1Data(challengeRef) -> readRetainedR1Original(fullCommand) | The source delta below exposes the actual original command and stored raw JSON after the existing complete C0/R1/receipt/registration join. Historical DATA only; not a qualified current consent reader. |
| Qualified R1 preparation/current RP reader | Same module: prepare / readRetainedActionConsentR1 | Both still explicitly unavailable until the actual issuer/registration/current-admission source is connected. This change does not weaken either refusal. |
| legacyCustody.resolve(clear/retained/blocked) | src/subscription-command-receipts.ts: createSubscriptionCommandReceipts(...).read({organizationId,kind,reference}) -> Promise<SubscriptionCommandReceipt|null> | No adapter from that owning custody to Hosted canonical-account/0005 alias custody is implemented here. A null business read cannot mean clear. No START, plan-change or cancellation is silently converted into another family. |
| Selected source/epoch/derivation | Actual owning source/realm/epoch and Hosted code-selected composition | Not derived from a Worker name, native version, held-convert DATA or a request DTO. No secret/configuration input is invented or modified. |

## New data carried by the actual existing reader

FinancialR1JoinedRead's found branch now contains:

```
fullCommand: FinancialR1WriteCommand
fullCommandJson: string
```

The command is parsed from the original stored command_json, validated through
the existing exact full-command R1 reader/mandatory receipt/registration and C0
join, and returned deeply frozen with the exact canonical raw string. The
existing business reader returns that same joined result after exact action
body and requestFingerprint comparison. It does not construct a command from
challenge10 or use current plan/display values. No SQL, bind, DDL, recipe, scope,
clock, provider call or write path changes.

FinancialR1WriteCommand.key is the original Financial
{challengeRef,preparationRef,r1Ref}; it is not a Hosted operationKey, claim key,
consentProofRef or receipt alias. fullCommandJson remains the original bounded
Financial representation, not a new public payment payload. An adapter must
retain Hosted's original operation/claim/reference separately and compare the
exact selected action against the returned actionIdentity. It must never
reconstruct or replace that Hosted custody from these Financial fields.

## Published Hosted original-command callback DATA

Hosted PR80 (main 5cc3e40f, tree 6df7d672) provides
WorkspaceSubscriptionAuthorizationRequest, WorkspaceSubscriptionAuthorizationContext,
and WorkspaceTopUpAuthorizationContext. Subscription authorizeCommand(input,context)
retains its first argument and receives context.request with the original
operationKey and optional expectedOperationKey. Its selection is unselected,
command (with original command and optional previousCommand), or legacy-custody.
Top-up authorizeTopUp(input,context) retains its first argument and receives the
original request keys and optional selected command. These are actual public
DATA carriers; this Financial component edits no Hosted callback or wire.

The early guard remains before original-reference selection. It cannot pretend
that a selected original already exists. After selection, the supplier must
preserve the original operationKey/reference/owner/Org/source/epoch and exact
plan/expectedSubscriptionRef/amount. A legacy-custody START can accompany an outer
cancel/change-plan request: the two actions remain distinct. Top-up's requested
amount and selected original amount also remain distinct. The presence of a
command is not a durable-phase marker or permission for first dispatch.

Financial action kinds remain topup, subscription-start, plan-change, cancel and
card-setup. The owning adapter must use the actual action recipe and exact
body/fingerprint/pathOrg; Hosted labels are not cast into Financial kinds.
plan-change/cancel keep expectedSubscriptionRef and are never folded into START.
PR80 adds no card-setup carrier or consentProofRef authority.

Callbacks repeat at early/local/capability-GET/effect/read points. They verify
current inputs without minting new consent/key/reference or consuming a witness
on every call. Current payer/class/human/source/consent and Financial same-primary
all NEW acceptance/first-dispatch CAS remain required. Historical not-found,
partial or unknown results grant no NEW, new key, family switch or clearance.
Serial historical reads do not provide a transaction or current consent check.

Existing explicit Hosted subscription/top-up retries may POST the SAME retained
original reference after availability checks, using unchanged replay/receipt
lookup. That behavior does not prove provider idempotency or authorize another
Financial shared-lane dispatch. Strict Financial G/M accepted-unknown recovery
uses ONLY the original full-command GET; undefined never permits reinstall,
rePOST, new key or fallback. R1 unknown-history recovery is separately query-only.
Hosted retry behavior does not relax those Financial original-reader rules.

## Budgets and proof namespaces

R1 terms remain at most32768 UTF8bytes and original command at most98304 UTF8bytes.
The RP parser8192 UTF16/leaf16384-byte limits and Hosted original internal limits
are separate. This packet does not raise any limit, truncate/re-encode terms,
invent disclosureRef, alias identity-proof to consent, or rebuild from a current
plan. consentProofRef mapping stays fc9-owned; original R1/C0 receipt refs,
consent same-row receipt, and Financial grant receipt remain distinct.

Hosted must still own actual MARKETPLACE_DB first-primary plus its qualified
Context13/395 and real RP, with the existing private owner inputs. Server's
createCanonicalHostedBillingComposition is not the Hosted dashboard factory or
its supplier. Root held/native TEST prep and 103/104 are not that Context proof.

## Qualification boundary

Validation of the affected module and retained-R1 regression file uses scoped
read-only formatting, TypeScript and one unfiltered affected-file test run.
For the original-command carrier source, the actual local Bun 1.4.0 run passed
59 tests with 0 failures and 487 expect() calls. Its strict TypeScript program
reported 240 files, including both changed module and test; both read-only
format checks passed. These results cover the exact checked component bytes
recorded with raw results and independent reviews in its handoff. They are
local SQLite historical-DATA evidence, not a complete product-gate result.

The five new cases cover all five action originals, deeply immutable/detached
custody, unknown GET followed by original recovery, complete historical absence
without permission, and partial C0/R1 refusal. Previous results do not qualify
different bytes.
The complete product gate, genuine supplier/current consent/default mount,
current same-primary CAS, native D1 and staging Stripe TEST remain separate.
Root/F and foreign jobs are unchanged. Production STOP, shared OFF, postpaid OFF
and control push HOLD remain. Missing genuine inputs are implementation work in
their owning modules; they do not create a recipient ACK or user approval queue.
