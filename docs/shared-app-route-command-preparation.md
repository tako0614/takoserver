# Prepared shared app route commands

The unmounted shared-name ledger can now prepare accepted route activate, advance and retire commands. This adds no HTTP route, gateway activation, curated export, vendor pin or numbered migration. The prepared effects require an owner-reviewed additive schema; tests use an isolated UNALLOCATED DDL fixture. Existing applied migrations and allocation remain unchanged. This source is default off because no actual runtime composition calls it.

## Trusted composition and one commit atom

`ledger.forTrustedOwner(owner)` is a trusted business composition port, never a public body or credential. The owner comes from actual authenticated Organization and reviewed product/Offering composition. Prepare input contains the exact held assignment, existing original v2 route-command reference, and actual accepted Endpoint UID/generation, Worker UID, Deployment UID/generation, source operation and provider/target/script pins. Principal must equal `org:<that Organization>` and Space must equal the Organization id. These strings are checked for consistency, but the ledger does not authenticate them or independently prove acceptance.

The original reference must be derived by the existing owning v2 route publication code from its accepted source operation and host key. A caller must not mint an alternative reference after a timeout, use client-selected script/Organization fields as authority, or replace pins with whatever is current after an await. All owner/input primitives and SQL predicate parameters are captured synchronously, before any await, and returned plans/parameter arrays are frozen.

The existing legacy `activate(pin,script)` and `release(pin)` remain source-compatible. Both commit their own standalone ledger batch. They have no accepted v2 command history or reciprocal v2 Endpoint/drain guard and must not be called beside a separate owner publication transaction. Normal v2 publication must use the pure prepared commands and the actual owner atom below. The legacy release race test proves the primary fence, not a qualified v2 release integration.

**Activation blocker: writer authority cutover is not implemented here.** The legacy ledger methods do not consult route-command history, and a caller holding a current v2-adopted assignment can still invoke standalone `activate` or `release`. That can change the global head without the actual accepted Endpoint/route atom. Their continued compatibility is not proof that mixed writers are safe. Final owner composition must prevent every old mutator from touching adopted names, while preserving explicitly legacy read/drain behavior.

The existing `worker-endpoint-origin-reservations.ts` wire has its own legacy `worker_endpoint_origin_reservations` storage, `tf_resources` guards, release/reclaim/expiry handling and endpoint assignment activate/deactivate/cleanup paths. It does not currently call this new global ledger. Routing only the new publication hook through prepared effects is insufficient: any adoption/adapter must fence those existing writers, automatic cleanup paths and obsolete installations/credentials from independently releasing or reallocating the adopted global name. The actual wire/acceptance/publication owner must review that complete cutover; no alternate legacy store is authoritative when the new schema is absent.

Unchanged legacy tests run against names/assignments tables only. New prepared commands on that old schema fail at their missing-table SQL and leave the old head unchanged; settlement reports indeterminate after unknown ACK. There is no automatic missing-table fallback to a legacy standalone mutation.

```ts
const owner = ledger.forTrustedOwner(actualTrustedOwner);
const effects = owner.prepareAdvance(actualAcceptedPins, {
  admission: actualResourceAndRouteAdmissionPredicate,
  publication: exactResultingOwnerRoutePredicate,
});
// This is the owner's existing ONE atomic D1 batch, not a second ledger commit.
await ownerSql.batch([
  ...effects.before,
  actualRouteMutationWithGuard(effects.publicationGuard),
  ...effects.after,
]);
const receipt = await owner.settleRoute(effects.original, "acknowledged");
```

`admission` and `publication` are trusted parameterized SQL predicates assembled by the owner from its existing Resource/Operation acceptance/publication guards. They are not request-supplied SQL or a substitute for those guards. AND `publicationGuard` into BOTH the insert and update/delete paths of the real route mutation. Preserve the actual accepted-graph, native readiness, collision, target and old-route CAS conditions. The final `publication` predicate must check the full resulting owner tuple, or exact absence for retirement, rather than only a matching hostname. Check the total bound parameters of each final owner-composed statement against D1's limit; this module rejects its own statements above90 parameters.

The `before` effects create a checked transient witness, insert immutable original command history and CAS both assignment and global name to the next generation. The owner route mutation runs next in the same batch. The `after` effects require exact history plus the current ledger AND actual owner route result. A false or missing witness causes a real CHECK constraint violation, rolling back the entire native D1 batch. A zero-row guarded update alone is never treated as rollback. Do not omit either group, run them in separate transactions, or replace the final assertion with a post-commit read.

## Stable tenant, changing route

| Command | Expected state | Result | Tenant incarnation |
| --- | --- | --- | --- |
| `prepareActivate` | reserved, script absent | active accepted script; generation+1 | unchanged |
| `prepareAdvance` | active exact old script/generation | active accepted successor; generation+1 | unchanged |
| `prepareRetire` | active exact old script/generation | reserved, script absent; generation+1 | unchanged |
| explicit name release | owner-qualified Endpoint/drain guard still required | permanent released tombstone; never reusable | retained forever; never replaced by another incarnation |

Routine app updates do not release the name. Retiring and republishing the same held tenant also keeps its incarnation and fixed origin, so the Cookie namespace remains stable. Explicit release is terminal: neither the same owner nor another Organization/product may reserve that name again after any interval. New tenants need names never previously assigned in that environment. Old generation/script selections fail both existing fresh-primary dispatch fences.

Route history is append-only, keyed by `(Organization,original command reference)` and unique by `(incarnation,next generation)`. It retains the original product, reservation, name/incarnation, prior state/generation/script and all accepted resource/provider/source-operation pins. Same reference with changed pins conflicts. An exact replay sets the witness to no-op: it never executes the owner route mutation, even after later commands have advanced the current route. The returned receipt describes the original historical outcome; it is not permission to dispatch that old script. Serving authority always comes from a fresh `readCurrent` plus pre/post primary fences.

## ACK loss and owner dependencies

After an unknown batch ACK, keep `effects.original` and call `settleRoute(original,"unknown")`. Settlement only reads fresh primary history. Exact committed history resolves the original result even if a newer route now exists. Missing/unreadable history throws `indeterminate` carrying all original pins. Changed history conflicts. Settlement never writes, creates another command reference, re-uploads a script, sends another native invocation or changes the current route.

Actual public reservation-wire/TTL adoption, selected name→v2 Endpoint binding and acceptance predicate, private publication batch mount, additive migration allocation, curated exports/vendor pin, qualified old-assignment drain/browser policy, and the real staging fixture bridge remain owner-controlled dependencies. No current Form gains an invented public reservation field. Test accepted/route tables model these boundaries but are not those actual owning tables or runtime integration. The legacy projection may remain after a release race; a null current ledger selection fences it, while its actual owner cleanup/drain still needs integration.

The selected browser-origin policy permanently prohibits released-name reuse. Cookie translation does not erase old DOM/JavaScript, service workers, storage, ambient Authorization, cached pages or streaming bodies. Existing legacy-name inventory, all old-writer fences and actual drain still need qualification; permanent tombstones do not prove that cutover is mounted. No staging or production activation follows from this module or its tests.

## Verification scope

Native Miniflare D1 tests exercise the actual ledger module and one owner-like batch against accepted graph/route fixtures. Their vectors cover stable activate/advance/retire/republish, constraint-failing whole-batch rollback when the route guard affects0rows or a phase is missing, exact historical replay/conflict, caller snapshot, actual accepted graph rejection, unknown/out-of-order ACKs, concurrent stale/current publication and release, foreign recovery refusal, permanent released-name refusal and original history retention. The focused Bun SQLite test uses the same ledger and explicit unallocated fixture tables. These tests do not claim actual owner Endpoint acceptance, gateway/browser integration, schema adoption or staging qualification.
