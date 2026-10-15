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

Selected legacy bind, activate, host mint, Endpoint assignment and release
methods currently refuse with `unsupported_capability` (422). Their v1 Resource
and Deployment witnesses do not establish v2 publication or drain. Even after a
v2 Endpoint is accepted, legacy DELETE cannot report global release success.
Actual v2 publication, native drain and retirement/release remain owning work.

The added fixtures prepare real account-authenticated HTTP reservations, use
real Core Engine/Store acceptance, inject an actual transactional metadata
failure, and distinguish lost commit ACK from unavailable readback. The Worker
fixture uses the existing supply parser/local Provider derivation and real local
D1; native Provider RPC is forbidden by its fixture. At this source checkpoint
all new runtime/type checks are **UNRUN**. Fixture DDL remains unallocated, and
neither these fixtures nor the optional constructor prove private entry mounting,
real Offering eligibility, deployed authority, staging or production behavior.

Owner coordination remains TASK-0108/TASK-0110 and private issue 132. Actual
shared wildcard route, dispatch namespace, current schema/closure, cookie
transport and both-product staging/browser qualification remain outstanding.
Production configuration, credentials, migrations and routes are out of scope.
