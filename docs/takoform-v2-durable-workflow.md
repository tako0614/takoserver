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

`createDurableWorkflowForm` requires a boot-selected class-admission port.
`createV2WorkflowClassAdmission` now captures every active and pending weighted
Version from accepted SQL, verifies sealed reference sets and held module bytes,
inspects the named Workflow class in a disposable, pinned workerd, and returns
a same-statement graph predicate. A clean native class refusal is distinct
from unavailable inspection; an allocation changed after inspection is
retryable, not a definitive class error. This component is not yet wired to
the normal Host. A v2 native Workflow Binding/runner composition is still
missing; it must bind the private broker scope to the same principal, Space, UID, current
Deployment and selected Version. Consequently the Form is not registered in
the normal factory and `workflowBindings` remains rejected in WorkerVersion
eligibility. Do not advertise v2 Workflow FormSupport from the synthetic
backend tests.

The focused synthetic test exercises accepted v2 HTTP Resource/Operation CRUD,
step history replay after SQLite close/reopen, active-instance DELETE, and an
instance-create versus DELETE race. Two Workflow Resources may share one
Worker/class while retaining separate instance ID spaces. The test also covers
unswept expired rows and synthetic owner-stop acknowledgement. The class
admission tests exercise accepted active and pending weighted graph capture,
held Bundle bytes, same-statement drift, and accepted Ready observation. Native
tests use the pinned workerd artifact for class ABI inspection and held-byte
graph qualification. The CRUD/step test still supplies a fake class-admission
result and an in-process execution host. That test alone does not qualify
physical workerd stop, broker delivery, OS process recovery, or public Support.
