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

Every advertised Form-authority environment also has one permanent minimal
`takoserver-form-authority-identity-probe` Worker. Its target-owned
`identityProbeWorkerName` and `identityProbeOrigin` name a workers.dev endpoint
with only `GET /v1/public-host-identity`. The probe has one service binding to
the public Worker's `PublicHostIdentityEntrypoint`, one expected Host-id
variable, and no D1, R2, secret, mutation RPC, route, preview, or custom domain.
Deploy status actively calls this endpoint and validates the RPC result against
the authoritative served public Version and artifact. An absent, thrown,
malformed, stale, or semantically inconsistent response makes readiness false.

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
reverse option. During an explicitly selected scope transition, deactivation
requires both live Workers to remain sealed to the descriptor predecessor and
signs only that predecessor scope with `desiredActive: false`. Normal
activation never accepts the transition selector. Both surfaces speak only the
v2 request, plan, apply, and readback protocol, so v1 envelopes are refused.

Each request requires exact `application/json`, at most 2 MiB, and a bearer
assertion signed by the dedicated target-owned Ed25519 public key. The assertion
is valid for at most 60 seconds and binds its purpose, action, method, path,
canonical body digest, environment, Host id, public Worker artifact digest and
Version, and implementation digest. The private key never enters a Worker
binding. The gateway forwards the exact original assertion and request envelope
to the route-less authority. Both Workers first call the public Worker’s named
`PublicHostIdentityEntrypoint`; its exact v2 result—Host id, served Worker
Version, outer artifact digest, implementation-payload digest, capability
digest, and semantic implementation digest—is request-time authority.
The route-less authority then independently verifies the assertion against its
own sealed public JWK before reading capability, D1, or R2. It rereads the live
identity while constructing the operation composition, and the endpoint checks
it again before the operation; apply also checks it immediately before every
durable command. Any change between proof creation, gateway verification,
route-less verification, policy/current-head read, and durable mutation
therefore fails closed. A later ordinary public Worker deploy closes an
assertion for the old identity immediately.

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

New support events use `takoserver.form-support@v2` and contain only the
semantic `implementationDigest`. A Worker Version change alone does not make
an installed Form unsupported. An unrelated route/UI change may rotate the
outer Worker artifact without rotating semantic identity. A sealed
handler/provider payload, capability manifest, exact Form package identity, or
admitted operation change derives a new implementation digest and requires
explicit reconvergence. Existing exact
`takoserver.form-support@v1` events remain readable as immutable history, but
their Version, artifact, and capability fields are shape-validated rather than
used as the support key.

Executable operations are the intersection of:

1. lifecycle operations in the exact Form package;
2. the code-owned public Host capability manifest; and
3. handlers present in the separately sealed public Form runtime payload.

The capability manifest has no target or environment selector. The deploy
target must realize the exact four provider supplies required by that manifest,
and `formAuthority.operatorOperations` is rejected as an unknown target key;
an operator therefore cannot select either payload `P` or semantic identity
`I`. Every D1 transition retains its existing guarded predecessor/uniqueness
fence. Package objects retain create-only, byte-exact existing-object
convergence in R2. Apply does not consider a D1 install head converged unless
the exact package index and every payload byte also verify from R2. It does not
retry a failed action or keep a second ledger: it returns receipts for completed
actions, performs authoritative readback, and returns the next plan.

The authority deploy surfaces read the served public Worker Version, prove its
commit, binding/secret/domain closure, and artifact digest, then rebuild that
public Worker from the same exact source commit and require byte identity. This
is a deploy-time provenance/race fence; the route-less and gateway Workers do
not store a public Worker Version or artifact pin. Their immutable service
binding to `PublicHostIdentityEntrypoint` supplies the live runtime identity.
The authority bundle digest is recorded separately. `formAuthority.hostId`
must equal the public Worker’s `publicOrigin`. The public integration Worker
embeds build-derived semantic identity rather than accepting a public capability
variable. The route-less authority receives the same canonical capability
manifest from the code-owned build helper and verifies it against all four
identity digests returned by the live RPC.

Public Worker construction is two-stage. Wrangler first builds and seals a
target-neutral handler/provider payload `P` from the real runtime seam shared by
production composition. Deploy then derives semantic identity `I` from `P`, the
adapter/capability manifest, and the exact admitted Form package/operation set.
`P`, the capability digest, and `I` are compile-time definitions embedded into
the outer Worker; only after that does deploy hash the final outer artifact `A`
and realize `A` as the public identity variable for integration, rehearsal, and
production. `P` and `I` have no target override, runtime source scan, or central
pin. Worker Version remains the request/mutation fence and is not an input to
`I`.

Gateway status additionally proves exact custom-domain ownership, the named
route-less authority service binding, the named public identity binding, the
dedicated public JWK, the exact operator tenant/Space bindings, and the absence
of D1/R2 and secret bindings. Gateway bootstrap is accepted only from the clean
state in which both its script and configured custom domain are absent. A
foreign domain owner, or either script/domain half existing without the other,
is refused; a successful upload is followed by the same exact exhaustive
readback used for later deployments.

The steady-state `dynamic-public-rpc` binding profile contains no public Worker
Version or artifact variables. Status reports both bound legacy fields as
`null`, and readiness requires this dynamic profile. A one-time migration also
recognizes `legacy-exact-pinned`, but only after fetching the immutable public
Worker Version named by both legacy bindings and proving its canonical
annotation, exact target closure, exact bundle digest, and same source commit
as the authority Worker. The pinned Version may be outside current deployment
history; it is neither required nor assumed to be a direct predecessor. The
legacy pre-capability-manifest public closure and the exact current closure are
the only accepted source shapes. Partial pins, malformed ids/digests, foreign
closures, digest mismatch, or commit mismatch are refused.

Normal apply migrates a verified legacy closure by uploading one exact dynamic
direct successor: route-less authority first, then gateway after its dependency
is dynamic. It removes both legacy identity variables and verifies the exact
pin-free closure after upload. A lost acknowledgement is resolved with status;
the upload is never retried automatically.

The operator-private scope-transition selector uses a separate stricter state
machine. Its status accepts either the dynamic profile or one fully verified
legacy exact pin with `scopeBindingProfile: exact-target` or
`scopeBindingProfile: exact-transition-predecessor`. It does not use public
Worker history as a scope migration mechanism. A third scope, stale public
identity proof, missing Worker, bootstrap topology, or history-based
roll-forward is refused. Apply accepts only `exact-transition-predecessor`,
uploads one dynamic target closure, and must read back `exact-target`; applying
again at `exact-target` is a refused no-op. The gateway cannot advance until
the route-less authority is already dynamic and `exact-target`. A lost upload
acknowledgement is reconciled only by status; there is no retry.

After the public Worker, identity probe, route-less authority, and gateway are
current at the same exact commit, the
owner invokes the bridge through the repository entrypoint:

```sh
bun run deploy -- takoserver-form-authority-identity-probe --status --environment=integration --commit=<40-hex-sha>
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

Before the first invocation after this identity change, deploy the public
integration Worker through `bun run deploy` so it exposes the complete
build-derived `PublicHostIdentity@v2`. Deploy and verify
`takoserver-form-authority-identity-probe` next. Then run status/apply/status for
the route-less integration authority and, after it is dynamic, for the operator
gateway. This is the one-time migration from a verified legacy exact pin; no
live request is signed until the probe and both authority status results are
ready. Rehearsal and production use the same public Worker → identity probe →
route-less authority order. These steps do not authorize deployment by
themselves.

The reviewed order is deliberately staged. First capture the old exact
tenant/Space scope with status and its operator snapshot. Write an
operator-private descriptor with exactly these members:

```json
{
  "kind": "takoserver.integration-form-authority-scope-transition@v1",
  "environment": "integration",
  "hostId": "https://api.integration.example.test",
  "predecessorScope": {
    "tenantId": "tenant-before",
    "space": "space-before"
  },
  "targetScope": {
    "tenantId": "tenant-after",
    "space": "space-after"
  }
}
```

The file must be an owned, link-free exact-`0600` regular file no larger than
16 KiB and must be selected by an absolute path. The complete path is
symlink-free, its immediate parent is an owned exact-`0700` directory, and that
parent stays outside every Git worktree. Setuid, setgid, sticky, group, and
other permission bits are refused rather than masked away. Strict JSON
duplicate members and all extra fields, including secret-shaped fields, are
refused. `hostId` and `targetScope` must exactly match the selected integration
deploy target, while the two scopes must differ. The steady deploy target never
stores the predecessor.

After the target descriptor names `targetScope`, use the same transition file
for the following order:

1. Run deactivation status, apply, and status while both the route-less Worker
   and gateway report `exact-transition-predecessor` with a verified dynamic or
   legacy exact identity profile. Mixed predecessor/target topology is refused
   before signing.
2. Run the route-less authority status, apply, and status. It alone advances to
   `exact-target` with one upload.
3. Run the gateway status, apply, and status. It advances once only after the
   route-less authority is `exact-target`.
4. Remove the selector and run normal activation status and apply for the
   target scope. Finish the consumer cutover, and only then perform retained
   package cleanup.

The selector is exactly
`--form-authority-scope-transition=/absolute/operator-private/transition.json`
and is accepted only by the deactivation, route-less integration authority,
and integration operator gateway surfaces. Status and apply emit its canonical
digest plus the scope binding profile, never the path or private-key material.
Transition deactivation projects activation/readback as a scope-redacted
digest-and-boolean summary; neither success nor refusal output includes the
predecessor or a foreign observed scope. Reverse mode and duplicate or relative
selectors are refused.

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
provenance or require a support-profile reseal by itself. Explicit
reconvergence is required only when the semantic implementation digest changes;
an existing activation remains effective while that digest is unchanged.

Regenerate after the verified fixture changes:

```sh
bun scripts/generate-integration-form-packages.ts
```

The owner gate checks the generated bytes with
`bun run check:integration-form-packages`. Generation and local checks do not
authorize a deploy or a Form apply.
