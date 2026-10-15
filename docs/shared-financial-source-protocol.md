# Shared Financial source protocol

Takoserver owns the durable Financial receiver. The frozen Accounts ABI
component-r1 source contract has been received; event and receipt wire versions
remain `v:1`. The earlier Financial-only argument and receipt-reference proposal
is superseded by this contract. Implementations consume the wire independently
without importing another product's source. Component review, release,
publication and qualification of the actual graph remain separate evidence.

This source preparation remains unmounted and disabled by default. Receiving an
ABI does not enroll a source, qualify a caller, create credentials, expose a
public HTTP route or authorize a Customer command.

## Closed records and external receiver ABI

```ts
type FinancialSourceDigest = `sha256:${string}`;

interface FinancialSourceEvent {
  readonly v: 1;
  readonly eventRef: string;
  readonly registrationRef: string;
  readonly incarnation: string;
  readonly sequence: number;
  readonly previousDigest: FinancialSourceDigest;
  readonly kind: "advance" | "close";
  readonly affectedRef: string;
  readonly evidenceRef: string;
}

interface FinancialSourceReceipt {
  readonly v: 1;
  readonly eventRef: string;
  readonly eventDigest: FinancialSourceDigest;
  readonly receiptRef: string;
  readonly incarnation: string;
  readonly sequence: number;
  readonly state: "admission-closed" | "advanced";
}

interface FinancialSourceApplyRequest {
  readonly v: 1;
  readonly event: FinancialSourceEvent;
  readonly eventDigest: FinancialSourceDigest;
}

interface FinancialSourceReadRequest {
  readonly v: 1;
  readonly registrationRef: string;
  readonly eventRef: string;
  readonly eventDigest: FinancialSourceDigest;
}

interface FinancialSourceReceiverAbi {
  applySourceEvent(input: FinancialSourceApplyRequest): Promise<FinancialSourceReceipt>;
  readSourceEventReceipt(input: FinancialSourceReadRequest): Promise<FinancialSourceReceipt | undefined>;
}
```

Records and envelopes reject missing and unknown fields. References match
`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`; digests match
`^sha256:[0-9a-f]{64}$`. A sequence is a positive safe integer. `close` requires
receipt state `admission-closed`; `advance` requires `advanced`. A receipt must
match the original eventRef, eventDigest, incarnation and sequence.

Apply recomputes the supplied eventDigest before any source CAS and returns the
exact original receipt only after actual commit and primary readback. Read is
scoped to the qualified source and exact original registrationRef/eventRef/digest.
Only `undefined` is absence. `null`, a malformed receipt, a different digest,
timeout or transport failure is never absence. The closed faults are
`invalid-request`, `unregistered-source`, `conflict` and `unavailable`.

An internal bare-event method or string/null reader may exist behind an adapter.
Those are not the external ABI. The stored core receipt itself must use the
external recipe below; an adapter must not rewrite or relabel an incompatible
receipt into a successful ACK. An unavailable or acknowledgement-unknown result
retains the same original event for exact readback, without a fabricated receipt.
An absent read cannot establish complete history or permit a new genesis.

Codec artifact revision 2 and ABI artifact revision 1 do not increment the event,
receipt or challenge payload version.

## Canonical digests and retained receipt identity

Canonical JSON preserves string content without Unicode normalization, rejects
invalid Unicode, cycles, unsupported values and unsafe integers, sorts object
keys, preserves array order and permits only dense arrays with own data entries
and no extra properties. Objects and arrays have at most 100 entries and nesting
is bounded to 16. The complete canonical hash input encoded as UTF-8 is at most
16,384 bytes. Digests use `sha256:` followed by lowercase SHA-256 hex64.

The event digest covers every field of the whole validated event:

```text
eventDigest = "sha256:" + hex64(SHA256(UTF8(canonicalJSON({
  domain: "takosumi.financial-source-event@v1",
  event: validatedEvent
}))))
```

The `event` member is exact. Generic value hashes instead use `{domain,value}`.
The receiver generates, persists and rereads this eight-field receipt identity:

```text
receiptRef = "fsr_" + hex64(SHA256(UTF8(canonicalJSON({
  domain: "takosumi.financial-source-receipt-ref@v1",
  value: {
    registrationRef, receiverRef, targetRef, eventRef, eventDigest,
    incarnation, sequence, state
  }
}))))

receiptRecordDigest = "sha256:" + hex64(SHA256(UTF8(canonicalJSON({
  domain: "takosumi.financial-source-receipt-record@v1",
  value: { registrationRef, receiverRef, targetRef, receipt }
}))))
```

Receiver and target come from the actual retained enrollment. The event's
registration and incarnation must match it; state follows kind. The record
contains the exact seven-field receipt, including its validated receiptRef.
The 68-character receiptRef obeys the reference grammar. Retain exact original
receipt bytes and recipe version; retries never regenerate from current
configuration, schema or clock. Computing either hash is neither a signature nor
proof of a committed write. Customer request/fingerprint/key domains and the
original event-digest recipe are unchanged.

The independent vector uses eventRef `event:one`, registrationRef
`source:accounts`, incarnation `incarnation:one`, sequence 1, previousDigest
`sha256:` plus 64 `1` characters, kind `close`, affectedRef `grant:one`, evidenceRef
`evidence:one`, receiverRef `receiver:financial` and targetRef `target:qualified`.

| Value | Exact result |
| --- | --- |
| eventDigest | `sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93` |
| receiptRef | `fsr_df35120d968c92051da0398de4d68fd0efc718f3302e671af09c09663b74c192` |
| receiptRecordDigest | `sha256:2a3fc7ee808cff8bbbc8805a20a06faff28b045628ae63b65b743f48f97751d9` |

## Enrollment and component chains

Retained enrollment ties the actual source/caller identity and genesis digest to
its complete immutable set of 1–8 exact receiverRef/targetRef pairs, the source
schema/credential/clock-policy references and this receiver's primary, realm,
schema, writer guard and qualification provenance. Request fields cannot create
that enrollment, choose a receiver subset or substitute caller identity.

The full head key is `{registrationRef,incarnation,affectedRef}`. Its sequence-0
head must be explicitly enrolled with the qualified genesis before admission.
Sequence 1 requires that genesis as previousDigest; each later event requires
the next safe sequence and exact previous event digest for the **same affectedRef**.
This is not a registration-wide counter. A raw predecessor must name that same
component's immediately preceding event. A missing predecessor is not replaced
with a guessed digest.

Advance updates the component head; close makes it terminal. Reject gaps, forks,
changed immutable tuples, replaced incarnations, mismatched evidence and new
events after close. Exact original retries return their stored receipt even
after later progress or close. Reusing an eventRef for another event conflicts.
Historical reads and retries retain original enrollment and scoped recovery
custody rather than substituting a replacement current registration.

The received ABI declares `readRegisteredHead({v:1,head})`, returning the exact
`v:1`, head, genesisDigest, complete receivers, sourceSchemaRef,
sourceCredentialRef and clockPolicyRef or `undefined`. Actual pre-enrolled state
must back this reader. A registration-only lookup or request-time/default genesis is invalid.

## Atomic commit and qualification boundary

Head advance or closure, immutable event and immutable receipt commit on the
same actual Financial SQL primary under its captured realm/writer guard in one
atomic batch. Verify bounded owned immutable evidence for the exact event and
source/target. An unconditional SQL assertion must make a conditional zero-row
CAS roll back the entire batch; a JavaScript check after partial commit is
insufficient. Use acyclic row ordering. After unknown acknowledgement, recover
only the committed original receipt. Scoped receipt storage reads perform no
writes or remote operations; failure is never converted to an absent row.

A committed close with its receipt is the local admission-closed linearization
point. Each new shared admission must check that same source state in its own
Financial CAS. This ACK claims neither provider drain, complete Customer
history nor unknown-operation resolution. Accepted obligations retain original
source and trusted recovery custody.

The received source-key and clock interfaces describe required qualification:
`readCredentialContext` binds exact credential, receiver, target, receiver schema
and `event-apply` or `receipt-read` purpose to retained custody; the separately
captured `FinancialSourceClock` binds policyRef and current time. Missing state,
expiry, backward time or mismatched schema/receiver/target/policy denies. Opaque
custody references are not key bytes. These interfaces do not supply actual
qualified head/key readers, expiry policy, private graph or entrypoint mount.
The component core's injected clock records observation metadata only; it does
not qualify the source-key expiry clock or mint an authority epoch.

Auth0103 precedes the reserved Financial0104 schema; this allocation is not
source registration or database application. Genuine auth-class/Principal,
explicit current-owner payer consent/grant, challenge/history coverage and L1
acceptance/L2 dispatch remain separate owner implementation. Each new command
for an existing Customer also needs its own CAS for subscription, top-up or card
setup. Parsing records, consistent metadata or a callable port cannot create those
authorities. This receiver remains unmounted until actual composition is
qualified and grants no Customer authority by itself.

## Portable component tests

The isolated receiver tests apply the repository's public migrations, followed
by the explicitly selected local fixture
`tests/fixtures/shared-financial-source-component-schema.sql`. This is an
unregistered component schema, with synthetic enrollment and peer evidence.
The test uses the existing Sql/realm/client factories and the actual receiver
batch; it does not read operator-private schema paths or select a missing
capability as a passing skip. A missing component schema must return unavailable
without an acknowledgement or effects. The fixture is applied explicitly, so a
later overlapping registered migration fails until its owner deliberately
updates this test.

These tests and the portable repository gate qualify the unmounted component.
They do not register Financial0104, establish the actual0101–0104 lineage,
qualify a real peer or provide payer/Customer admission authority. The public
runtime and maintenance paths do not construct this receiver. Genuine private
composition, same-primary currentness and each new action's acceptance and
first-dispatch CAS remain separate implementation requirements. Existing
immutable operator packets retain their original test/schema pins.
