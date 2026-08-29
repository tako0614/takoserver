# Takoform Form authority

Takoserver’s public Worker, router, and OpenAPI surface are read-only consumers
of durable Form admission state. They may reach `host-authority.ts` and the
package reader, but they must not import `admission-store.ts`, `admission.ts`,
`form-packages.ts`, or the operator modules. `bun run check:imports` and
`tests/takoform-static-authority-boundary.test.ts` enforce that graph.

Form mutation belongs to two separately named, route-less Cloudflare Workers:

- `takoserver-form-authority-worker` exposes only service-binding RPC methods
  `plan`, `apply`, and `readback`. Its production composition can plan and read
  the exact durable state, but `apply` fails closed because no released
  Takoform Core `EvaluateAdmission` adapter or signed trust-evidence adapter is
  available. Takoserver does not reimplement that evaluator in TypeScript, and
  persisted `AdmissionReport` JSON is never accepted as authority.
- `takoserver-integration-form-authority-worker` is an integration-only fixture
  bridge. It checks the exact environment before reading D1 or R2 bindings and
  permanently reports `admissionMode: integration-fixture` and
  `productionEligible: false`.

Neither authority Worker has a public route, `fetch` method, `workers.dev`
address, preview URL, customer handler, or secret binding. Both use the selected
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

Each request requires exact `application/json`, at most 2 MiB, and a bearer
assertion signed by the dedicated target-owned Ed25519 public key. The assertion
is valid for at most 120 seconds and binds its purpose, action, method, path,
canonical body digest, environment, Host id, public Worker artifact digest, and
public Worker Version. The private key never enters a Worker binding. The
gateway forwards the exact original assertion and request envelope to the
route-less authority, which independently verifies it against its own sealed
public JWK before reading capability, D1, R2, or public identity bindings. Both
Workers independently call the public Worker’s named
`PublicHostIdentityEntrypoint` before every plan/apply/readback and require the
same immutable Worker Version. Apply checks that identity again after
trust/Core preparation and current-head reread, then immediately before every
durable command. A later ordinary public Worker deploy therefore closes the
stale operator path immediately. Public Host readers also treat a support
profile sealed to another Worker Version as unsupported until the authority is
redeployed and the Forms are explicitly reconverged.

## Plan and apply

A canonical plan binds the environment, public Host identity, public Worker artifact,
capability and implementation digests, exact FormRef/schema/package digests,
publisher policy/root/checkpoint/bundle evidence, current durable heads,
Space-scoped activation, and ordered commands. Apply re-derives the plan from
the same code and current heads; a caller cannot widen operations by editing a
plan and recomputing its digest.

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

After the three integration Workers are current at the same exact commit, the
owner invokes the bridge through the repository entrypoint:

```sh
bun run deploy -- takoserver-integration-form-authority --status --environment=integration --commit=<40-hex-sha>
bun run deploy -- takoserver-integration-form-authority --apply --environment=integration --commit=<40-hex-sha>
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
apply decision.

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
not confer trust. The synthetic handle issuer accepts only those exact package
closures, stable-v1 empty revocation genesis, and matching namespace evidence.
Activation is always scoped to one exact tenant/Space audience. There is no
official, first-party, or privileged publisher branch.

Regenerate after the verified fixture changes:

```sh
bun scripts/generate-integration-form-packages.ts
```

The owner gate checks the generated bytes with
`bun run check:integration-form-packages`. Generation and local checks do not
authorize a deploy or a Form apply.
