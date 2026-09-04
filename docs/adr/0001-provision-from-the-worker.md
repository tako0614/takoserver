# ADR 0001 — Provision from the Worker

**Status:** superseded, 2026-09-04
**Supersedes:** the unwritten rule recorded in `scripts/check-imports.ts` that
`src/providers/cloudflare.ts` may never be reachable from the Workers entry.

> This ADR records the former public-credential decision. The current design
> keeps Cloudflare provisioning on Workers, but moves parent-account authority
> into the named route-less `CloudflareProviderExecutor` WorkerEntrypoint. The
> public API Worker holds only a typed service binding and credential-free
> Provider proxy. It cannot import the credential-bearing provider/backend or
> declare `CLOUDFLARE_API_TOKEN`. The executor validates exact Host saga/deployment
> authority and owns a pre-effect D1 CAS before any provider mutation.

## What changed at the time

The Workers entry may now reach the Cloudflare provider and hold an account
credential as a secret. The D1 and R2 HTTP transports stay banned from it.

## Historical rationale

The rule carried its reason in a comment:

> A Worker that could reach either would hand that reach to every Worker sharing
> its bundle, so provisioning runs on the self-hosted entry instead.

That reason does not hold. A customer's Worker is its own script built from its
own bundle; nothing shares the API Worker's bundle, so there is no one to hand
the reach to. The rule was real, the justification was not, and a rule whose
justification is wrong gets re-examined rather than inherited.

Two consequences followed from it, and both were bad:

- The deployed API could not provision at all. An apply against the public
  origin answered `backend_unavailable` — honest, and it meant the product was
  usable only by whoever happened to be running a provisioner on their own
  machine.
- The remedy the rule implied was a second long-lived process, on a host
  somebody maintains, reachable from the internet. That is a real operational
  burden accepted in exchange for a benefit that was not there.

## Historical cost

The accepted design increased blast radius. The API Worker is the most exposed
code in the system, and an account-wide credential then lived in the same
isolate. A bug that let somebody read the environment or drive an arbitrary
subrequest could yield the Cloudflare account: every customer's Worker,
database, and bucket. This is the cost the superseding split removes.

This is a real cost and it is worth naming plainly. Two things bound it:

- The credential is a **scoped** API token — Workers Scripts, R2, D1, and
  routes and DNS on the zones this deployment serves. Not an account-wide
  token, and not a session.
- The separation was never as strong as it looked. The half holding the
  credential has to be reachable from the half taking the requests, so an
  attacker with code execution in the API could always ask the provisioner to
  provision. Splitting narrowed the path; it did not close it.

## Boundary retained

The `Provider` port and the remote provisioner built against it stay.

The expectation is that most providers will not need them. A provider that
reaches its backend by calling an HTTP API with a credential — which is what
this deployment's own resources are expected to look like — fits a Worker
exactly, and adding one means adding a module, not a machine.

What the road is for is the residue: a provider that has to carry a large SDK,
hold a connection open, touch a filesystem, or run longer than an edge request
should. That is the argument the old rule should have made, and it is the one
that survives — but it is an argument for having the road available, not for
sending everything down it.

## What the gates check now

`scripts/check-imports.ts` proves the public Worker cannot reach the real
Cloudflare provider, its parent REST backends, or Wasabi credential paths. The
credential-bearing graph is rooted only at
`src/entry-cloudflare-provider-executor.ts`, whose named RPC surface is closed
to the implemented Provider operations and has no `fetch` entrypoint. That
surface includes import/adoption recovery, exact-Deployment artifact-consumption
readback, and bounded upstream meters, so none of those capabilities can force
a parent credential back into the public Worker.

`scripts/build-worker.ts` rejects Cloudflare parent-token/account identifiers,
Wasabi credential names, and parent REST origins in the public bundle. The
public immutable binding closure admits `CLOUDFLARE_PROVIDER_EXECUTOR`, not
`CLOUDFLARE_API_TOKEN`; every Cloudflare supply fails closed when the exact
target topology and qualified executor Version are absent. The executor's own
route-less build and deploy readback separately require its D1, R2, dispatch,
gateway, receipt-authority, plain-text, and two secret bindings, with
workers.dev/preview disabled and no route or custom domain.
