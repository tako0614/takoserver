# Financial Customer consent CAS component

The request-bound Financial Customer entry point accepts an already verified RP
witness and an already captured R1 original. It compares the RP original action,
challenge, source, scope, terms, identity evidence, consent issuer, retained RP
credential/human/session, and native Customer command to the selected Financial
L1 or first-dispatch D command. The Financial grant's `consentRef` remains the
original Financial command input; its `consentProofRef` must equal the RP
consent's `consentRef`. The identity proof reference is separate. RP
`identityEvidence.kind = not-required` is outside this component's supported
Customer command shape.

The receipt compiler adds the RP local 81-bind predicate and Root's native
source-currentness predicate to the unconditional L1/D receipt write. RP's five
BLOBs remain typed binds; its other 76 binds are packed losslessly into one JSON
bind. Financial balances the 74 outer AND terms in RP's fixed local SELECT and
places Root currentness in its own materialized CTE, preserving the predicates
while fitting SQLite's expression depth of 100. The receipt also checks the
exact append-only issuer original and the
consent acceptance/expiry interval against SQLite time. A false late predicate
violates the receipt's existing CHECK, rolling back earlier writes in that same
batch. The L1 and D plans hold only their 7 and 6 Customer statements (D's physical CAS
result index is 1); Root's Money writer frames each batch with its permit. Recovery is GET-only and never mints a new consent observation.

The request composition gives ordinary consumers a Money public SQL wrapper.
That wrapper correctly refuses the existing Customer receipt observation SQL and
internal permit-bearing Customer batch. The Financial executor now passes only
its opaque operation to Root's closed request-origin receiver for the two fixed
tracker reads and the original 9/8 statement batch. Root reads the Financial
operation's private origin and uses the same captured native primary session.
The focused SQLite tests qualify the compiler and atomic rollback, and still
reproduce public-wrapper rejection with no mutation. An isolated local SQLite
test also passes a synthetically selected RP/R1/credential graph through the
actual Financial mint, Root receiver, fixed L1/D batches and GET-only recovery
after a committed batch loses its ACK. It does not qualify genuine RP/R1
authority or remote native D1 execution.
This component does not create a payer grant, issuer, live DB change, or new
request authority.

Financial now constructs an opaque, request-bound operation only inside this
entry point. Its private origin records the exact request Financial inputs,
connection, held RP/R1 checks, detached phase input, and either one of the two
literal tracker reads or the complete guarded L1/D compiler plan. The static
reader returns a copy only for that original operation and connection. The
operation is not a SQL or DTO-based permission, and callers cannot mint it from
a matching statement. Root's native receiver consumes it for both reads and
the batch. Local negative origin tests and the existing compiler tests do not
qualify a positive native request path.

The `readFinancialCurrentConsentCustomerOperationOriginal` reader requires the
original connection and opaque operation. It returns a detached
`completed-receipt-read`, `original-read`, or `phase-batch` original with the
same Financial request-input identity; Root selects the fixed read or complete
plan from that kind. A foreign connection or copied operation returns no
original. The fixed Root receiver consumes
`readFinancialCurrentConsentNativeOriginal(operation, "query" | "batch")`,
which reuses that same private-origin check and returns the original connection
and request inputs with the selected fixed read or complete plan. It accepts no
new SQL, registration, caller inputs, or assertion callback. The five RP BLOB
binds are copied as BLOBs on repeated reads.
The isolated synthetic-source test checks one selected-consent-proof mismatch
and verifies zero SQL effects before either read operation is minted. Other
tuple mismatches and the genuine authority path remain unqualified.

Before either historical tracker read, Financial checks the supplied phase
against the held RP consent, R1 selection, native Customer command recipe,
realm and writer epoch. Historical GET-only recovery does not require the
consent to be unexpired. The pending row and RP/Root currentness checks remain
write-only predicates in the mandatory receipt batch.

## Customer history coverage origin and Org identity (0104/0105)

Root's 0105 Org capture triggers append birth and change observations and never
move a Financial head. A Customer coverage origin is a post-seal birth whose Org
id was in no start roster of that primary, still matches the current Org row
(owner, created_at), and was never named by any change observation (as the old or
new id); 0105 also backfills one raw birth for every Org existing at install. So a
deleted, moved or re-created id that Financial ever observed never becomes an
origin. An Org id that already has any money row (ledger, wallet_credit_lots,
wallet_credit_allocations, stripe_billing_customers,
stripe_billing_customer_commands, stripe_billing_subscriptions or
stripe_billing_commands) never receives a post-seal birth; 0105's Org trigger
skips it and the 0104 birth guard refuses it, decided at birth time without any
timestamp. Residual limitation: an id created and deleted before 0105 with no
money row in those tables leaves no observation and is indistinguishable from a
new Org. A capture start requires Root's four 0105 Org triggers on orgs (pinned by
name until Root's official 0105 lands, then by exact SQL). Coverage is scoped per
Org (a change to another Org does not affect it); the seal keeps the global
no-change rule, where a framed close and restart is cheap. A spurious replace
observation from INSERT OR IGNORE or ON CONFLICT DO NOTHING with a different owner
only refuses that Org's coverage (a per-Org denial of service, never an admission).
