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
batch. The L1 and D statement counts and the D physical CAS result index stay
9, 8, and 2. Recovery is GET-only and never mints a new consent observation.

The request composition gives ordinary consumers a Money public SQL wrapper.
That wrapper correctly refuses the existing Customer receipt observation SQL and
internal permit-bearing Customer batch. The Financial executor now passes only
its opaque operation to Root's closed request-origin receiver for the two fixed
tracker reads and the original 9/8 statement batch. Root reads the Financial
operation's private origin and uses the same captured native primary session.
The focused SQLite tests qualify the compiler and atomic rollback, and still
reproduce public-wrapper rejection with no mutation. They do not yet qualify a
positive, fully selected request-origin execution through the new receiver.
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

The Root-facing `readFinancialCurrentConsentNativeOriginal` reader accepts an
opaque operation and the literal expected kind (`query` or `batch`). It returns
the original connection and Financial request-input identities with a copied
fixed statement or complete plan; a mismatched kind returns no original.
The isolated synthetic-source test checks one selected-consent-proof mismatch
and verifies zero SQL effects before either read operation is minted. Other
tuple mismatches still require a positive native request fixture to qualify.

Before either historical tracker read, Financial checks the supplied phase
against the held RP consent, R1 selection, native Customer command recipe,
realm and writer epoch. Historical GET-only recovery does not require the
consent to be unexpired. The pending row and RP/Root currentness checks remain
write-only predicates in the mandatory receipt batch.
