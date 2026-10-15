# Shared app ledger source preparation

This is unmounted source preparation for the shared app-name authority. It does
not allocate a migration number, apply DDL, expose a public API, select a deployed
realm, or activate the existing reservation/resource/gateway paths. The existing
name helper is reused. No second allocator or migration writer is installed.

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
or an adopted durable schema. Existing 0035 rows, current schema, release hooks,
curated package exports and private vendor pin remain unchanged. The owner must
compose name acceptance with existing reservation/resource acceptance in the
same guarded D1 batch, reserve an additive schema number, and rehearse legacy
adoption without deleting or rewriting original rows. NFKC aliases must refuse
ambiguous adoption; invalid historical labels need explicit read/drain handling.
Released rows retain their historical timestamps and can never become new
claims. Legacy expiry/reclaim paths still require the same authority cutover;
this unmounted source does not change those writers. No staging label makes a
durable database disposable.

Owner coordination remains TASK-0108/TASK-0110 and private issue 132. Actual
shared wildcard route, dispatch namespace, current schema/closure, cookie
transport and both-product staging/browser qualification remain outstanding.
Production configuration, credentials, migrations and routes are out of scope.
