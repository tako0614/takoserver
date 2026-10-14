# WorkerVersion launch binding preparation

The current Host implementation selects the exact `WorkerVersion/0.5.0/` URL.
Its declaration already includes Actor, Workflow, Service, SQLite, KV,
ObjectBucket and Queue Producer bindings. Each entry is
`{ name, resource: { resourceUid } }`. All binding names, nonsecret variable
names and sensitive variable names share one environment namespace. Core seals
the exact target UID and Form URL before a backend can run. A matching kind,
resource name or replacement UID does not grant the declared capability.

The portable mock in
[`tests/fixtures/worker-version-launch/host.ts`](../tests/fixtures/worker-version-launch/host.ts)
uses the real 0.5 parser, reference declaration and Core SQLite engine. It
provides mock backend effects and mock target Resources so runtime lanes can
exercise acceptance and retained custody without a hosted deployment. It does
not verify artifact bytes, run tenant code, implement the target service APIs,
qualify WebSocket hibernation or establish Form support on a real Host.

Run its focused checks from the product root:

```sh
bun test tests/worker-version-launch-binding-mock.test.ts
```

## The binding shape and its owner

| Declaration | Current exact target | Runtime contract |
| --- | --- | --- |
| `kvBindings` | EdgeKVNamespace 0.2.0 | KV methods defined by the owning Form |
| `sqliteBindings` | SQLiteDatabase 0.2.0 | SQL methods defined by the owning Form |
| `bucketBindings` | ObjectBucket 0.2.0 | Object and multipart methods defined by the owning Form |
| `queueProducerBindings` | AtLeastOnceQueue 0.2.0 | `send`, `sendBatch` |
| `serviceBindings` | ModuleWorker 0.3.0 | Service `fetch` |
| `actorBindings` | ActorNamespace 0.3.0 | Namespace caller methods and actor stub `fetch` |
| `workflowBindings` | DurableWorkflow 0.3.0 | Instance creation, lookup, status, event and termination |

`containerBindings` has a source proposal in
[Takoform Forms draft PR 17](https://github.com/tako0614/takoform-forms/pull/17).
The inspected proposal is commit
`55811b390dbae8bd0c67a65e471d68d3ffb72006`: WorkerVersion 0.6.0 references
Container 0.1.0 through the same `{ name, resource: { resourceUid } }` shape,
with a caller `fetch(Request): Promise<Response>`. These identities are pending
and excluded from publication there. The existing frozen 0.5 parser rejects
the added field. The Container implementation owner and portable Form owner
must settle the exact next contract before a runtime adapter accepts it.
This preparation does not change a published definition or introduce aliases.

CustomDomain is an independent `WorkerCustomDomain/0.3.0/` Attachment with
`{ hostname, worker: { resourceUid } }`; it is not a WorkerVersion binding.
Its reference targets the ModuleWorker, and its route follows the active
Deployment. The hosted launch uses app subdomains; self-host CustomDomain
support retains this separate ownership. Adding a `customDomain` field to the
current Version declaration is invalid.

The next Actor caller API and hibernation transport must be authored with their
owning Actor contract. The binding reference shape by itself does not grant a
native Durable Object namespace or a socket migration capability. The same
rule applies to Workflow execution and Container process management.

## One creation selection, with exact predecessor recovery

The launch policy selects 0.x only for staging and 1.0 for new production
creation. That changes which exact Form implementation the operator exposes
for new requests. It does not change the Form URL of an accepted Resource or
Operation. Each owning Form's definition version remains independent; a
WorkerVersion choice does not rename its binding targets automatically.

Core already provides this boundary through
[`V2OperatorFormSelectionFactory`](../src/takoform-v2/application.ts) and
[`V2EngineOptions.retainedForms`](../src/takoform-v2/types.ts). The supported
`forms` map contains the single selected creation contract. An exact
predecessor adapter goes in `retainedForms` only for accepted state. That map
is hidden from support and rejects fresh CREATE and UPDATE. It permits original
Idempotency-Key replay, Resource reads, accepted-operation reconciliation and
DELETE under the original backend ID and target key. Binding edges keep target
deletion fenced until the Version's own deletion settles. Removing a URL from
new support is not permission to delete its stored Resources or dependency
targets.

Before the creation selection moves, the owning adapter must prove:

- A supported new version uses the exact reviewed portable contract and its
  full backend implementation. A locally invented `1.0.0` URL is insufficient.
- The old exact URL, backend identity, target identity and sealed input context
  remain available for accepted-state recovery. A wildcard version match or
  a resolver for "latest" cannot replace them.
- Production composition rejects 0.x for fresh requests before side effects;
  staging can select its reviewed 0.x implementation. An accepted replay is
  distinguished from a fresh request.
- The durable guards admit the new identity without reinterpreting old state.
  For example, migrations 0074 and 0079 contain exact WorkerVersion 0.5.0
  native-effect/deletion guards. Replacing the TypeScript URL constant alone
  cannot qualify a 1.0 implementation against those guards.
- Retained invocation, dependency and private-input custody remain enforceable
  through recovery and deletion. An old binding target is not silently changed
  to a new Form version.

The mock proves the current predecessor boundary and exact-reference refusals.
It leaves the next Form publication, new-identity durable guard transition,
operator production selection, runtime behavior and real staging E2E for their
owning implementation and qualification work. It adds no multi-version registry,
migration writer or production mutation.
