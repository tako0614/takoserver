# Takoform Form authority

Takoserver’s public Worker, router, and OpenAPI surface are read-only consumers
of durable Form admission state. They may reach `host-authority.ts` and the
package reader, but they must not import `admission-store.ts`, `admission.ts`,
`form-packages.ts`, or the Host admission modules. `bun run check:imports` and
`tests/takoform-static-authority-boundary.test.ts` enforce that graph.

Form mutation belongs to two separately named, route-less Cloudflare Workers:

- `takoserver-form-authority-worker` exposes only service-binding RPC methods
  `plan`, `apply`, and `readback`. Its production composition can plan and read
  the exact durable state, but `apply` fails closed because no released Form
  package verifier is available. Released Core may supply signature,
  provenance, namespace, and revocation verification; Takoserver Host owns the
  admission policy decision and private in-process handle. Persisted
  verification evidence or `AdmissionReport` JSON is never authority.
- `takoserver-integration-form-authority-worker` is an integration-only fixture
  bridge. It checks the exact environment before reading D1 or R2 bindings and
  permanently reports `policyAuthority: takoserver-host`,
  `verificationMode: integration-fixture`, and `productionEligible: false`.

Neither authority Worker has a public route, `workers.dev` address, preview URL,
customer handler, or secret binding. Each default export has a non-operational
`fetch` handler that always returns `404`; it exists only because Cloudflare
requires an event handler to register the module. The named RPC entrypoints
remain pure RPC classes and are bound explicitly. Both use the selected
Takoserver target’s existing `STATE_DB` and `OBJECTS` bindings. The production
bundle does not contain the integration package corpus.

The only network ingress is a third, separately deployed integration Worker,
`takoserver-integration-form-authority-operator-worker`. It owns the dedicated
custom origin `https://form-authority.integration.takoserver.com` and binds the
integration authority by its named `IntegrationFormAuthorityEntrypoint`. It has
no D1/R2 binding, does not join the customer Worker graph, and has workers.dev
and preview URLs disabled. Its three authenticated POST endpoints are
`/v1/plan`, `/v1/apply`, and `/v1/readback`; there is no `/admin` route.

The repository-owned operational caller is the integration-only
`takoserver-integration-form-authority` deploy surface. It reads the exhaustive
gateway, authority, and public Worker status before opening its dedicated
private key, then sends signed HTTPS requests only through that custom origin.
It never binds or calls D1/R2 directly. The target fixes the activation tenant
and Space in `formAuthority.integrationOperatorScope`. Deploy seals those exact
values as immutable bindings in both the gateway and route-less authority
Workers. Each Worker independently rejects every signed plan, apply, or
readback body whose activation is not that exact `kind: space`, tenant, and
Space before reaching the RPC or storage boundary; caller input cannot widen
that audience.

The separate owner surface
`takoserver-integration-form-authority-deactivation` has the same sealed
tenant/Space and proof boundary, but always constructs
`activation.desiredActive: false`. The normal activation surface always
constructs `desiredActive: true`; there is no free mode flag, repair mode, or
reverse option. Both surfaces speak only the v2 request, plan, apply, and
readback protocol, so v1 envelopes are refused.

Each request requires exact `application/json`, at most 2 MiB, and a bearer
assertion signed by the dedicated target-owned Ed25519 public key. The assertion
is valid for at most 60 seconds and binds its purpose, action, method, path,
canonical body digest, environment, Host id, public Worker artifact digest, and
public Worker Version. The private key never enters a Worker binding. The
gateway forwards the exact original assertion and request envelope to the
route-less authority, which independently verifies it against its own sealed
public JWK before reading capability, D1, R2, or public identity bindings. Both
Workers independently call the public Worker’s named
`PublicHostIdentityEntrypoint` before every plan/apply/readback and require the
same immutable Worker Version. Apply checks that identity again after
verification and the Host policy decision plus current-head reread, then immediately before every
durable command. A later ordinary public Worker deploy therefore closes the
stale operator path immediately. Public Host readers also treat a support
profile sealed to another Worker Version as unsupported until the authority is
redeployed and the Forms are explicitly reconverged.

## Plan and apply

A canonical v2 plan binds the environment, public Host identity, public Worker artifact,
capability and implementation digests, exact FormRef/schema/package digests,
publisher policy/root/checkpoint/bundle evidence, current durable heads,
Space-scoped activation (including `desiredActive`), and ordered commands. Apply re-derives the plan from
the same code and current heads; a caller cannot widen operations by editing a
plan and recomputing its digest.

For `desiredActive: true`, the planner converges publisher, checkpoint,
package, install, support, and activation chains. Every `SetActivation`
command carries `active: true` and the code-derived implementation digest. For
`desiredActive: false`, the planner changes activation chains only. It does not
load package bytes from R2 or invoke a new verifier dependency, and it emits an
inactive successor only for a present active head, carrying that head's exact
durable implementation digest and predecessor. Missing or already-inactive
heads are no-op. Malformed, multiple, or drifted heads fail closed.

Executable operations are the intersection of:

1. lifecycle operations in the exact Form package;
2. the selected Host capability manifest; and
3. handlers present in the selected Worker artifact.

The operator-private deploy target may narrow this result per Form through
`formAuthority.operatorOperations`; the target parser and capability builder
reject every widening. The canonical narrowed manifest is an immutable Worker
binding and changes the capability/implementation identity. Every D1
transition retains its existing guarded predecessor/uniqueness fence. Package
objects retain create-only, byte-exact existing-object convergence in R2. Apply
does not consider a D1 install head converged unless the exact package index and
every payload byte also verify from R2. It does not retry a failed action or
keep a second ledger: it returns receipts for completed actions, performs
authoritative readback, and returns the next plan.

The authority deploy surfaces read the served public Worker Version, prove its
commit, binding/secret/domain closure, and artifact digest, then rebuilds that
public Worker from the same exact source commit and requires byte identity. The
authority Worker binds that proven public artifact digest; its own bundle digest
is recorded separately. `formAuthority.hostId` must equal the public Worker’s
`publicOrigin`. Gateway status additionally proves exact custom-domain ownership,
the named route-less authority service binding, the named public identity
binding, the dedicated public JWK, the exact operator tenant/Space bindings,
and the absence of D1/R2 and secret bindings. Gateway bootstrap is accepted
only from the clean state in which both its script and configured custom domain
are absent. A foreign domain owner, or either script/domain half existing
without the other, is refused; a successful upload is followed by the same
exact exhaustive readback used for later deployments.

Status classifies an authority binding only as `exact-current-public` or the
exact `previousVersionId` profile `exact-direct-public-predecessor`; every
arbitrary, two-hop, malformed, or identity-mismatched predecessor is refused.
Roll-forward always updates the route-less authority first. Gateway apply is
blocked until that dependency is exact-current, after which the gateway may
advance once from its own exact direct-predecessor profile.

After the three integration Workers are current at the same exact commit, the
owner invokes the bridge through the repository entrypoint:

```sh
bun run deploy -- takoserver-integration-form-authority --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-form-authority --apply --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-form-authority-deactivation --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-form-authority-deactivation --apply --environment=integration --commit=<40-hex-sha>
```

The operator supplies an independent review and
`TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH`, which must name an owned,
link-free `0600` Ed25519 private JWK matching the target’s dedicated public
half. Status performs one signed readback. Apply obtains one fresh signed plan,
submits that exact canonical plan once, and performs one separately signed
readback. An acknowledged partial result preserves sanitized completed
per-command receipts, authoritative readback, and the next-plan digest, then
the deploy command exits nonzero as a verification failure. A lost apply
acknowledgement is indeterminate and is never retried or hidden behind an
automatic readback; the operator runs status before making an explicit fresh
apply decision. Plan and readback requests are bounded at 30 seconds. Apply is
bounded at 55 seconds, inside the assertion lifetime, so the exact 12-Form
fixture can finish without turning an ordinary full convergence into a false
lost acknowledgement.

Deactivation is an explicit status/apply/status sequence: inspect status,
apply once, then run status again. Its ready proof requires the exact generated
12 Forms to each have a durable activation head that is either absent or
inactive, plus a zero-command next plan. The v2 readback exposes each head as
`activationHead` with `present`, `active`, `implementationDigest`, and
`eventDigest`; it never hides a stale active head behind installed or effective
booleans. Normal activation readiness still requires installed, supported, and
a present active head whose implementation digest equals the current code
identity.

## Integration cutover order

The reviewed order is deliberately staged. First capture the old exact
tenant/Space scope with status and its operator snapshot. Perform the authority
code cutover, then deploy the route-less authority and gateway at the same
commit. Run deactivation status, apply, and status. Only after that proof is
complete may the target descriptor name the new Space. Deploy the route-less
authority and gateway again for that target, then run normal activation status
and apply. Finish the consumer cutover, and only then perform retained package
cleanup.

An inactive activation does not erase retention authority: existing retained
delete and observe operations continue through the Host projection and require
no raw D1 access. Rollback of a deactivation is an explicit normal activation
that appends a new active event with the current implementation identity. A
Worker-version rollback alone never reverses an append-only activation event.

## Integration fixture corpus

The fixture contains exactly these identities from the verified unsigned
publisher corpus:

- `AtLeastOnceQueue`, `EdgeKVNamespace`, `ModuleWorker`, `QueueConsumer`,
  `SQLiteDatabase`, `SQLiteMigrationApplication`, `SQLiteMigrationSet`,
  `WorkerBundle`, `WorkerCronTrigger`, `WorkerDeployment`, and `WorkerEndpoint`
  at definition version `0.1.0`;
- `WorkerVersion` at definition version `0.2.0`.

`ActorNamespace`, `DurableWorkflow`, `StaticAssetBundle`, and
`WorkerCustomDomain` are excluded. The generator derives package, schema, and
payload digests from `tests/fixtures/takoform-v1`; literals in the operator do
not confer trust. The integration verifier accepts only those exact package
closures, stable-v1 empty revocation genesis, and matching namespace evidence.
The Host then makes its own policy decision and issues the private handle shared
only with its admission store.
Activation is always scoped to one exact tenant/Space audience. There is no
official, first-party, or privileged publisher branch.

The integration publisher generation is derived from the pinned
`takoform-forms` repository and commit together with the exact policy, bundle,
trusted-root, namespace-grant, and group identities. It never depends on the
selected Takoserver deploy commit. A changed fixture corpus creates a new
immutable publisher key; the previous publisher/checkpoint chain remains
append-only history while packages move through explicit replacements. A later
public Worker Version does not rotate publisher, checkpoint, or install
provenance. It does require an explicit support-profile reseal for that Version;
an existing activation survives only while the implementation digest is
unchanged.

Regenerate after the verified fixture changes:

```sh
bun scripts/generate-integration-form-packages.ts
```

The owner gate checks the generated bytes with
`bun run check:integration-form-packages`. Generation and local checks do not
authorize a deploy or a Form apply.
