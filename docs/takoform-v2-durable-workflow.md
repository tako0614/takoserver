# DurableWorkflow v2 implementation boundary

The exact contract is Takoform Edge `DurableWorkflow/0.3.0` and its
`WorkerVersion/0.5.0` `workflowBindings`, as authored in the Edge `spec/forms/`
tree. It is not the earlier v1 FormRef/package/Interface series. A v2 instance
is execution data under one accepted `tf_v2_resources` UID; it is never a
second managed Resource or Operation.

The source contains an unmounted v2 Form adapter and an opt-in Resource guard
for the shared instance/step engine. The Form validates the exact immutable
`worker`/`className` spec and UID reference. Its backend observes instance
counts and retires an explicitly deleted UID in bounded pages: v2 DELETE first
closes new instance/event/wake admission via Resource phase, then uses the
engine's physical-stop-aware termination before purging history. The existing
v1 Resource deletion contribution continues to refuse active instances; it is
not re-labelled as v2 authority. Runtime writes and new instance insertion
embed the v2 Resource predicate in the same SQL statement, so a racing DELETE
cannot leave an orphan execution. No new schema or management ledger is added.
An unswept instance past caller-visible retention is still retired by its
physical row: the v2-only engine path stops any retained owner before the
claimed purge, without reopening the expired instance to public callers.
Every DELETE purge statement checks the accepted Operation lease against the
database's current time inside that statement; a lease expiring while a batch
is held cannot authorize a late purge.

`createDurableWorkflowForm` requires a boot-selected class-admission port.
`createV2WorkflowClassAdmission` captures every active and pending weighted
Version from accepted SQL, verifies sealed reference sets and held module bytes,
inspects the named Workflow class in a disposable, pinned workerd, and returns
a same-statement graph predicate. A clean native class refusal is distinct
from unavailable inspection; an allocation changed after inspection is
retryable, not a definitive class error.

The normal self-host entry can now opt into a v2 Workflow boot with an explicit
`TAKOSERVER_V2_WORKER_RUNTIME_BOOT` selection, durable private storage, and
selected executable workerd and Workflow guard binaries. It passes that boot
to `createSelfhostV2WorkerComposition` before owner restoration. Only with
this boot does the internal Form factory mount `DurableWorkflow/0.3.0` and give
WorkerVersion its v2 Workflow Binding authority. The authority resolves the
accepted same-principal, same-Space Resource UID and current relation; native
publication projects only declared `env` names through an owner-incarnation-
pinned private broker. `createSelfhostV2WorkflowComposition` reuses the same
SQL-backed instance/step engine and guarded native runner. The normal entry
also starts a bounded due poll for queued and waking v2 instances when this
boot is selected; runtime execution retains the final SQL/native fences.
Without this explicit boot, Workflow Binding admission still refuses the
unavailable capability. This is an internal, opt-in Form map, not a public
FormSupport registry advertisement or a claim of full Form support.

The focused synthetic test exercises accepted v2 HTTP Resource/Operation CRUD,
step history replay after SQLite close/reopen, active-instance DELETE, and an
instance-create versus DELETE race. Two Workflow Resources may share one
Worker/class while retaining separate instance ID spaces. The test also covers
unswept expired rows and synthetic owner-stop acknowledgement. The class
admission tests exercise accepted active and pending weighted graph capture,
held Bundle bytes, same-statement drift, and accepted Ready observation. The
CRUD/step test still supplies a fake class-admission result and an in-process
execution host; SQLite close/reopen is not Host OS-process restart evidence.

Separately, `tests/takoform-v2-workflow-binding-native.test.ts` passed on the
pinned workerd (`sha256:c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52`)
and Workflow execution guard
(`sha256:5588505e384cd54105cb4e1a46bb4c33ce6d33f222270f49ed7b3f3e88da84dc`):
normal organization HTTP accepted a bound WorkerVersion and Deployment, the
selected Worker called `env.PARENT.create`, and its guarded parent class called
`env.CHILD.create/get/status` before native child completion. That is local
native composition evidence, not Workflow Binding recovery after killing and
restarting the Host in a new OS process. Public FormSupport, actual Hosted/live
operation, and full Form support remain unqualified by this test.
