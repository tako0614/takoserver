# Consumer WorkerVersion native-source candidate

This is an unregistered source candidate. Owning lineage registration and real
D1/native qualification remain pending.
No migration number, operator target or apply path is selected by this module.

## Source and compatibility

`createContainerConsumerWorkerNativeSourceRecipe` in
`src/takoform-v2/forward-worker-native-schema.ts` requires the exact physical 106
catalog, index, foreign-key enforcement and CHECK enforcement. Its owner must
execute all steps in one transaction and roll back every error. The candidate
changes only the Version native-effect insert and the three historical native
deletion stage/send/presend-absence guards from Version 0.5/0.7 to 0.5/0.7/0.8.
It preserves every other catalog member and all existing rows. Cron and Queue
Version/Deployment domains remain unchanged; this does not qualify 0.8 Cron/Queue.

The registered `createForwardWorkerNative106Recipe` SQL remains byte-identical,
with its existing owning digest. Runtime `forwardWorkerNativeSchemaReady` accepts
only exact 106 or the complete four-guard successor, with all other catalog/index
and physical predicates intact. Every partial mixture refuses old and new writes.
`containerConsumerWorkerNativeSchemaReady` requires the full new closure.
The internal `forwardWorkerNative106SchemaReady` is strict 106 only. Deploy
catalog checking uses it instead of runtime successor compatibility, while
retaining the separate complete original-shape predicate.
A compatible runtime can run on 106 before any separately authorized transition.
Older runtimes are not promised compatibility after that transition; the owner
must select its exact lineage, review the physical operation and repair forward.

## Portable evidence and remaining work

Fresh owned in-memory SQLite tests preserve populated 0.7 effect rows and exercise
the actual Core engine's 0.8 acceptance, lease/dispatch, effect confirmation,
update and historical cleanup. Duplicate grants, tenant/target/generation drift,
all 14 partial guard mixtures, unknown catalogs, failed-transition rollback,
foreign-key/CHECK disablement and temporary shadows remain refused.
Already confirmed upload receipts cannot be overwritten by source qualification.
The existing 106 refusal for 0.8 and retained 0.5/0.7 custody regressions are preserved.
The successor fixture also exercises accepted 0.5/0.7 create and cleanup under
the new guards, including already-granted responses and confirmed absence.

The consumer custody uses the compatible catalog seal. On exact 106 its
`inspect()` result `never_granted` means no matching grant is recorded; it does
not attest that this schema can grant 0.8. The exact 106 insert guard still
rejects the 0.8 grant. Callers must select the actual source schema separately
and must not interpret absence of a grant as native capability or readiness.

Those tests use controlled backend receipts, not a real provider, verified
Worker bundle/serving identity, bound parent admission, Container owner or
durable parent-I/O @2 journal/original. They do not qualify D1 execution or rollout.
The candidate curated barrel now exports the existing consumer effect/deletion
factories and the pure unregistered recipe. The effect implementation is
unchanged. Deletion custody removes a duplicate native catalog predicate while
retaining it inside every authority statement. Those exports do not
register/apply a lineage, select an installed pin or grant a native send.
Downstream owners must explicitly connect the selected 0.8 preparer, effect
custody and native publication/readback to accepted held bundle bytes. Controlled
transport receipts do not qualify a real provider or bound parent. Adoption
still requires owning lineage selection, normal private composition and actual
per-Form Native sources; the Core contract supplies none of those private owners.
Do not bypass those source obligations with positive rows, a ready DTO or casts.

## D1 statement budget

Actual accepted 0.8 create/update/delete SQL exposed a statement of 188,995 bytes even
though ordinary SQLite execution succeeded. Its duplicate native predicate was
removed without moving authority to a schema probe. Four races now remove a
native-only stage guard after precheck; invocation readiness stays true and the
native catalog predicate still refuses grant/inspect/absence/allAbsent.

Local D1 then refused invocation reads with `statement too long`. The complete
old/new catalog comparison is retained. Cohort counting now uses a source-checked
domain marker in the same conjunction as that exact comparison, avoiding a second embedded copy
of all four trigger bodies. Every partial mixture and SQL with forged markers
still refuses. The registered 106 recipe remains byte-identical.

The focused source suite covers actual accepted custody and historical cleanup.
Local D1 negative-parent invocation probes cover beginSend, read/readPresence,
refusal, no-dispatch/body observation and Cron admission; all refuse without a
parent and compile successfully. Both suites record their current maximum SQL
size and headroom and enforce the limits of 100,000 bytes and 100 bound parameters.
Limits are documented at
https://developers.cloudflare.com/d1/platform/limits/.
These are scoped local tests, not a complete invocation/Native/live-D1 proof.
