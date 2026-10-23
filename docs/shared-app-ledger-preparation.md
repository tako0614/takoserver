# Shared app ledger source preparation

This is source preparation for the shared app-name authority. The explicit
`form-v2@1` App/Worker construction also selects the existing reservation carrier
described below. It does not allocate a migration number, apply durable DDL,
create a public wire or endpoint, select a deployed realm, or qualify a deployed
gateway. The existing name helper and allocator are reused.

`createSharedAppLedgerD1` composes a fresh `first-primary` session for each
operation and each read fence. `forTrustedOwner` binds the actual Organization
and product supplied by the authenticated business authority. Public requests
must not choose that binding or supply an accepted script pin. Only authoritative
resource/Provider acceptance may call activation. Reservation IDs are original
durable command references; names, owner and reference are pinned before awaits.
Unknown write acknowledgements never mint a replacement command or repeat a
write. Exact primary readback may settle an acknowledged-lost result; unresolved
results retain the original reference as indeterminate.

The proposed shape has separate literal staging/production name and assignment
tables, one globally unique normalized name per realm, monotonically advancing
name generations and retained original assignment/incarnation history. Release
retains its first timestamp and creates a permanent name tombstone. The name
never becomes eligible for another reservation, even for the original owner or
after any elapsed interval. Reserve checks both the global name head and all
retained assignment history in its one atomic batch; it never overwrites a
released head. An exact unreleased original reservation may replay normally.
Activation is immutable for a given script/incarnation: no arbitrary script
replacement or caller recovery bypass exists here.

Gateway integration must read current primary status even after a negative cache
hint, compare every selected tuple field immediately before dispatch, and call
the independent fresh post-dispatch fence before releasing a response. A stale
positive hint cannot select a retired script; a stale negative hint cannot hide
a current assignment. A failed read is a failure, never an absent-name result.
The ledger cannot itself cancel an already streaming response or running old
JavaScript. Gateway admission/drain and response handling remain owner work.

The selected browser-origin policy permanently prohibits released-name reuse
while preserving the fixed application origin and same-incarnation updates.
Incarnation cookies do not themselves isolate old documents, active JavaScript,
service workers, storage, Authorization or logical `document.cookie` behavior.
Existing origin inventory, old-writer fences and owner-qualified drain remain
required before activation. The prepared driver and cookie helper are not that
proof, and no browser data-clearing guarantee is introduced.

DDL in the native D1 test is an **unallocated test fixture**, not a real migration
or an adopted durable schema. Existing 0035 rows, current schema, default release
hooks, curated package exports and private vendor pin remain unchanged. Durable
adoption must compose name acceptance with reservation/resource acceptance in
the same guarded D1 batch, reserve an additive schema number, and rehearse legacy
adoption without deleting or rewriting original rows. NFKC aliases must refuse
ambiguous adoption; invalid historical labels need explicit read/drain handling.
Released rows retain their historical timestamps and can never become new
claims. Default legacy expiry/reclaim paths still require the same authority
cutover; they retain their behavior when the explicit typed construction is
absent. No staging label makes a durable database disposable.

## Staging physical adoption source candidate (reserved 0107, unregistered)

`src/shared-app-staging-adoption.ts` now holds a staging-only physical schema
candidate and a closed atomic adoption operation. Root has reserved the next
shared source slot as 0107 after the existing 0101–0106 recipes; this module is
not a numbered migration, deploy registration, installed schema, or runtime
selection. The original 0035/0081/0100 bytes and the 0101–0106 recipes remain
unchanged. Its tests apply the source DDL to isolated full-Core SQLite and a
minimal native D1 fixture; neither is an adoption of a real target.

Only one exact, unexpired `0035` v2 reservation in revision 1 and `prepared`
state, with no Worker/Endpoint binding, is eligible. The operation compares its
complete original row inside the batch, refuses retained same-name/Host history,
and refuses matching accepted v2 Resource or native Host route history. It
inserts a tagged reserved assignment, retained adoption reference and name head
with a terminal assertion; a zero-row phase rolls back all phases. The old
reservation metadata is untouched. A lost write acknowledgement is settled by
readback of that exact generated incarnation; unreadable readback retains it as
indeterminate, and repeating the call does not create another incarnation.
Invalid labels, NFKC aliases, foreign originals, released/expired rows and
ambiguous history are refusals, not choices of a winner. Bound/activated rows
remain legacy read/drain history until their accepted Resource, provider and
native relation can be proven by the owning transition; this candidate does
not infer that proof from a reservation row.

Physical triggers refuse old reservation INSERT/UPDATE/DELETE for a name held
by the global head and refuse a new head over unadopted 0035 history. The
selected carrier alone can insert its exact new metadata or cancel its own
never-published scalar original through a transient, tuple-bound witness in
the same atomic batch. Terminal assertions reject a missing metadata write or
an unconsumed witness. They also require a route-command batch witness for
assignment/name updates, so the old standalone scalar `activate`/`release`
cannot advance an adopted head. An adopted 0035 row remains frozen; the carrier
cancel path cannot release its tagged original. Actual accepted-route
publication, owner-qualified release, old installed Worker/credential drain,
and private gateway/consumer selection remain later owning steps. The DB
triggers do not undo a provider side effect already sent by an old Worker; that
is why the old-writer drain must precede serving activation. Unadopted legacy
read/drain behavior remains available.

## Existing reservation carrier in the selected typed construction

The existing authenticated
`PUT /v1/worker-endpoint-origin-reservations/:reservationId` now prepares a
permanent shared original when the operator selects `form-v2@1`. Organization
identity still comes from the real Organization API key with `resources:write`.
Product and realm are fixed by this composition to `takoserver` and `staging`;
the request cannot supply either. There is no additional product/realm grant
object or readiness approval. The existing stable ModuleWorker Offering selector,
Provider installation, captured Offering digest and nonmutating origin derivation
remain required. An explicit eligible `offeringId` may select the Offering;
omission requires exactly one eligible Offering. Catalog discovery remains the
separate existing `catalog:read` API permission.

The trusted owner has a pure, closed `prepareReserve({ reservationId, name })`
port. It accepts no SQL, callback, metadata or permission input. The ordinary
standalone `reserve()` and this port use the same allocator statements. The
prepared result contains a planned immutable original tuple, guarded statements
and real terminal CHECK assertions. The carrier joins those statements with the
actual existing reservation metadata INSERT in **one** `Sql.batch`. Metadata,
name, assignment and witnesses either commit together or roll back together.
The carrier does not call a second allocator or intercept an arbitrary batch.
Its statements are limited to 90 parameters and 100,000 UTF-8 SQL bytes, with
2,000,000-byte string and metadata-row bounds; the fixed predicates use no
variadic SQL function beyond the platform argument limit.

The existing seven-field response is unchanged: `format`, `reservationId`,
`requestedSubdomain`, `canonicalPublicOrigin`, `revision`, `expiresAt` and
`status`. Names follow the shared NFKC/lowercase 3–32-character policy in this
selected branch. The derived origin must exactly match the canonical staging
origin. The request's TTL remains 60–86,400 seconds and its Offering/TTL are
pinned for an exact replay. An existing legacy reservation is not silently
adopted into the global allocator. App rejects a substituted carrier facade or a
carrier constructed with another Sql/ledger.

Compatibility expiry makes GET return absent and refuses renewal through the
same original reference. It does **not** release, reclaim or mutate the permanent
global original. Direct trusted `reserve()` originals remain valid permanent
holds without any legacy metadata or TTL row; Form-v2 acceptance has no universal
legacy-row predicate. A missing carrier does not invalidate those originals.
Unknown commit acknowledgement triggers readback of the same exact metadata
and original incarnation, never another write. If readback is unavailable, the
internal error retains that original tuple and the public response remains the
existing generic refusal envelope.

A failed allocation becomes a known 409 only when one fresh query proves a
consistent competing name/assignment tuple, no different retained incarnation
for that name, and neither metadata nor assignment for the requested original.
The competing row must pass the existing strict route decoder with the selected
typed columns present. That decoded data is used only to classify refusal;
it is never adopted as an owner or dispatch grant. Ambiguous, malformed or
unreadable authority remains unavailable (503).

The selected carrier's DELETE can cancel an untouched, never-accepted original.
Its closed trusted `prepareReleaseUnpublished(fullPin)` port is pure: it captures
the staging original and first timestamp synchronously and returns SQL effects,
never a second transaction. It requires scalar generation 1, reserved state,
no script, no typed binding and no route-command history. The carrier joins
these effects with its full original metadata CAS in one batch. Real terminal
CHECK assertions reject a zero-row metadata update and roll back the whole atom.
Successful cancellation advances both assignment and name to generation 2,
retains the original incarnation and first timestamp, and retains the permanent
name tombstone. The name never becomes available to another reference or owner.

Cancellation also requires absence of retained Endpoint bindings, route commands,
the canonical direct-Org v2 Resource/Operation/native-effect relation and native
hostname routes across providers, including deleted Resources and active or
tombstoned routes. These predicates run inside the same batch as the metadata
mutation. An already accepted Endpoint, tagged or active/retired assignment,
ambiguous original or retained history refuses with 422. Missing/unreadable
authority refuses with 503. A failed batch is settled only by fresh original
readback; an unresolved ACK retains that original and first attempted timestamp.
Exact repeated cancellation is read-only, returns 204, and GET returns absent.
Compatibility TTL expiry alone still does not cancel or mutate a global hold.

Selected legacy bind, activate, host mint and Endpoint-assignment methods still
refuse with `unsupported_capability` (422). Their v1 Resource and Deployment
witnesses do not establish v2 publication or drain. Cancellation does not provide
postacceptance release, native drain, a browser-origin reset, old-writer cutover
or activation. Default legacy construction and its existing exclusions retain
their behavior. Actual v2 publication/native drain/retirement remain owning work.

The added fixtures prepare real account-authenticated HTTP reservations, use
real Core Engine/Store acceptance, inject an actual transactional metadata
failure, and distinguish lost commit ACK from unavailable readback. The Worker
fixture uses the existing supply parser/local Provider derivation and real local
D1; native Provider RPC is forbidden by its fixture. At this source checkpoint
the native D1 cancellation fixture composes real ledger effects with an
explicitly owner-like metadata constraint; actual carrier and accepted graph
behavior are exercised separately through HTTP and the real Engine/Store.
Fixture DDL remains unallocated, and
neither these fixtures nor the optional constructor prove private entry mounting,
real Offering eligibility, deployed authority, staging or production behavior.

Owner coordination remains TASK-0108/TASK-0110 and private issue 132. Actual
shared wildcard route, dispatch namespace, current schema/closure, cookie
transport and both-product staging/browser qualification remain outstanding.
Production configuration, credentials, migrations and routes are out of scope.
