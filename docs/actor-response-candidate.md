# Forward Actor Response implementation candidate

## Explicit source adoption

`selectTakoformCandidates("actor-forward")` selects the separately generated,
unpublished source closure and retains displaced published Form and Binding
identities for exact historical management. With no argument it returns the
unchanged published selection. Neither choice changes Host admission or
activation. `scripts/generate-forward-form-catalog.ts` owns reproduction from
the pinned Forms source; the published catalog, package receipts and authority
closure are not overwritten.

The runtime catalog accepts the same explicit software candidate through
`deriveRuntimeImplementationCatalog`. An Actor capability declaration alone
does not enable support: the caller must supply its composed Actor Provider,
with the exact Offering, exact registered class contract and inspection and
lifecycle methods. Retained definitions are matched by complete FormRef and
package digest; their existing read/update/delete/observe operations cannot
inherit a forward class ABI. DurableWorkflow remains unimplemented in the
managed Provider and receives no handler entry.

This is a source qualification path, not a production toggle. The public
entrypoint defaults to the released Forms. Setting the exact
`TAKOSERVER_FORM_SOURCE_CANDIDATE=actor-forward` selects the unpublished Forms
and Bindings in that entrypoint, retains displaced identities for historical
Host management and provider recovery, and registers only the exact selected
Actor class ABI with its credential-free provider proxy. Unknown values refuse
startup. A Worker with
an embedded public Form implementation identity refuses the source candidate:
the released-Core admission closure cannot vouch for its newer package bytes.
The publication-verifying admission path remains unchanged and OFF for Actor.
The private managed source candidate consumes the exact selection through its
existing runtime configuration. The public Host composition now adds an exact
technical Actor `ProviderOffering` to its Cloudflare proxy only when this
`actor-forward` source is selected, the exact Form/package/class ABI is
registered, and the route-less executor exposes class inspection. The proxy
capability is not a sellable catalog entry: the hosted edge supply parser still
rejects Actor supply, and no price or meter is inferred. ActorNamespace is an
identity, not a relation that inherits a ModuleWorker price. This qualification
does not establish resale, pricing, metering, native lifecycle qualification,
publication, Host admission, or activation; normal identity create remains
unavailable without an independently composed sellable catalog Offering.

The generic identity/meter schema is owned by `hosted-edge-supplies.ts` and
`providers/cloudflare-edge-meter-contract.ts`; the operator's private composition
consumes that schema. A future additive Actor supply
extension needs its own truthful meter source and operator-owned terms and
price inputs. It must not reuse ModuleWorker billing by default.

The remaining public Host cutover is explicit: add an Actor identity class to
the common reviewed-supply parser, with a settled Actor `MeterSource` (the
current `cloudflare-actor-meter-source.ts` returns only `unfinalized`
observations); compose an exact operator-owned Supply Contract and price plan
through the existing Catalog Compiler; qualify the private executor's Actor
create/read/update/delete/import and class inspection against that exact
Offering; then publish and verify the newer Form/Binding closure and derive a
matching public Worker implementation identity before enabling admission.
Finally exercise the Host Resource and bound Actor call end to end. None of
these steps follows from selecting source bytes or receiving a provider RPC
verdict, and the current parser continues to reject Actor supply.

## Response implementation

This dormant source implements the application-facing Response portion of the
forward Actor proposal. It does not change released Form identities, the current
runtime contract, Host admission, or a serving native binary. Both backend
carriers still need exact native qualification and consumer integration.

The Host-private `actor-upgrade-handoff.ts` module owns the Response constructor
extension. `installActorResponseRuntime()` must execute once after Host intrinsic
captures and before evaluating application modules. The self-host forward Worker
bundle uses a dedicated entry module for that order; the Actor child installs it
before dynamically importing application code. The existing released wrapper
does not install it. Application modules must not be able to import Host modules.

`accept` returns `{ response, socket }`; Actor stub fetch and the ordinary Worker
handler remain Response-only. The upgrade is a native Response subclass with a
null body, logical status 101, `ok === false`, `Switching Protocols` status text
and mutable Headers. Workerd cannot construct a socket-free intrinsic 101, so
its internal native backing is a null-body 200. This is an explicit application
ABI extension, not a claim that the base native status getter returns 101. The
backing never owns a WebSocket; only the Host constructs the final native 101.

A private WeakMap preserves one reservation identity across `clone()` and
`new Response(response.body, response)`. It does not copy through structural
initializers, object spread, inheritance, serialization or borrowed native
clone methods. All aliases share the same request-bound one-shot settlement;
an alias is not another connection. Ordinary native fetch results and Response
static methods retain their native behavior and `instanceof Response` behavior.

The Actor child validates reserved handshake headers before transferring its
Response to the owner, and snapshots ordinary headers with the private decision.
The outer Worker validates again and snapshots headers before any asynchronous
commit work. Protocol, Upgrade, Connection, Accept, extensions, framing and
Host-private header changes cannot mint or redirect a transport. Ordinary header
changes and deletions survive into the client response. Broker commitment and
expiry remain Host-owned, and native head emission is not proven by a portable
unit test.

The Unix upgrade broker preserves each response `Set-Cookie` field value in
order rather than comma-joining or rejecting repeated cookies. Other duplicate
fields, including private credentials and reserved handshake headers, remain
refused. `tests/selfhost-actor-upgrade-broker.test.ts` drives the actual broker
over Unix sockets, including its commit control request; this is carrier-parser
evidence, not a native workerd WebSocket qualification.

The pinned Hono 4.12.31 test exercises its actual CORS/context reconstruction and
post-handler header mutation, without a Hono-specific branch. On baseline
`639112e`, the empty opaque object reconstructs into a status-200 Response and
loses its reservation; the test expecting 101 fails. This differs from the older
reported status-bearing opaque-object reproduction that produced 500. The
new test goes green with the Response extension and also verifies the emitted
native response headers.

Private managed consumption must update its pinned public source, install the
same constructor before application evaluation in both child and Worker realms,
consume `accept().response`, and carry `takeUpgrade(...).headers` through its
private signed decision and native transport response. A protocol-only header
copy or an uninstalled Worker constructor would still break this contract.
Build the private decision Headers with captured append and indexed snapshot
pairs (`createActorNativeUpgradeHeaders`), never `new Headers(upgrade.headers)`:
the latter re-enters application-modifiable iterable hooks after validation.
An accepted-upgrade regression poisons the Array iterator to inject a reserved
protocol, and verifies that the decision retains only the validated snapshot.

Focused checks: `bun test tests/actor-upgrade-handoff.test.ts
tests/actor-native-class-execution.test.ts tests/actor-class-execution.test.ts
tests/actor-namespace-facade.test.ts tests/actor-native-owner-worker.test.ts
tests/selfhost-actor-forward-worker-wrapper.test.ts`, TypeScript, and the four
Actor source-projection checks. These are not complete owner-gate, native
transport, production or publication evidence.
