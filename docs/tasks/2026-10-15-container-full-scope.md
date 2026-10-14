# Container full-scope launch

- Status: active.
- requiredFor: cross_repo, production_or_release, security_or_authority.
- grantsMutationAuthority: false.
- Repositories: `takoserver` owns portable Host policy evaluators and the public
  package; `takoserver-private` owns hosted execution, image registry adapters,
  secret custody, native egress enforcement, and integration deployment;
  `takoform-forms` owns portable Container, WorkerVersion, WorkerDeployment, and
  Binding definitions. Each repository keeps independent commits and version
  streams.
- Public branch: `feat/container-policy-fullscope-20261015`, based on
  `b7649192cb901fbcbd1b60c4192d294d33a84f84`. The consolidation coordinator owns
  integration, the final checks, PR disposition, merge, and staging execution.
- Outcome: make the Container path usable with sensitive inputs, controlled
  egress, and arbitrary digest-pinned images. Completion requires green local
  canonical gates, successful staging E2E, and a stop before production deployment
  to await operator approval.

The operator's full-scope instruction supersedes the earlier launch cut that
rejected sensitive variables, denied all egress, and required preapproved image
digests. Image admission now requires a digest pin and a size ceiling; no approval
list or approval record is required. The integration target is prepared through
the private repository's owning deployment entrypoint. Operator target/state
files and credentials stay outside Git. Production, production D1/config/secrets,
unrelated PRs #342/#347, and other operators' worktrees remain outside this task.

## Dependency order

1. Expose generic Host policy helpers in `takoserver`, with candidate corpora
   evaluated by production functions. In parallel, coordinate successor Form and
   Binding definitions with their `takoform-forms` publisher; do not edit frozen
   definitions or invent public fields, methods, aliases, or version identities.
2. In `takoserver-private`, consume the reviewed public helpers and the selected
   publisher definitions through the existing source/pin projection. Complete the
   image registry, sensitive-input, egress, Worker binding, and runtime seams.
   Parser acceptance and advertised support must follow those released contracts
   and actual backend qualification.
3. Run each owning repository's `bun run check`, then the applicable workspace
   verification. The coordinator reviews #359/#360 and either merges them or
   closes them with a concrete reason. Commit and push each repository separately;
   record exact source revisions and check results without calling focused checks
   a complete gate.
4. Through the private owning entrypoint, prepare the integration component and
   service target, then exercise the actual hosted staging path. Verify ordinary
   calls, streaming/cancel/error behavior, tenant and grant isolation, sensitive
   inputs, enforced egress, registry admission/retention, lifecycle recovery, and
   WorkerVersion/Deployment fencing. Preserve failed and unknown outcomes. Stop
   before production and request the operator's production decision.

## Public implementation boundary

`container-egress-policy` exports the pure Host policy/accounting evaluator and
its inputs/results. `container-image-admission` exports the pure evaluator,
metadata types, and default size ceiling. The curated package root exports the
same API. These helpers do not introduce Form fields, install or advertise Forms,
open network connections, store credentials, fetch image bytes, or publish native
images. Package/Core semver is independent of Form definition versions.

The egress fixture corpus originates from public #359 (114 candidate vectors).
The image fixtures originate from #360: 84 of its 85 vectors remain unchanged,
one expected result is corrected to refuse a noncanonical manifest digest, and
three regressions cover caller pin normalization, descriptor spelling, and exact
platform variant matching. Original candidate bytes and review evidence are
retained in the operator run outside Git; fixture tests record their provenance.
Public #359 was merged as a reusable corpus after independent review and its exact-head remote complete gate. Public #360 was closed with the canonical OCI descriptor correction as its stated reason. Final local complete gates and native qualification remain required for this implementation.

Portable policy success proves the decision seam. It does not prove native
enforcement, durable sensitive-input custody, registry byte verification and
retention, actual Worker publication, or staging E2E. Keep these acceptance claims
separate until their owning adapters and deployed path produce evidence. Progress
and exact verification results belong in the shared control task ledger and the
Container operator STATUS, maintained by the coordinator.
