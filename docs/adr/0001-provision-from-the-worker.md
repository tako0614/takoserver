# ADR 0001 — Provision from the Worker

**Status:** accepted, 2026-08-17
**Supersedes:** the unwritten rule recorded in `scripts/check-imports.ts` that
`src/providers/cloudflare.ts` may never be reachable from the Workers entry.

## What changed

The Workers entry may now reach the Cloudflare provider and hold an account
credential as a secret. The D1 and R2 HTTP transports stay banned from it.

## Why the old rule went

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

## What we give up

Blast radius. The API Worker is the most exposed code in the system, and an
account-wide credential now lives in the same isolate. A bug that lets somebody
read the environment or drive an arbitrary subrequest yields the Cloudflare
account: every customer's Worker, database, and bucket.

This is a real cost and it is worth naming plainly. Two things bound it:

- The credential is a **scoped** API token — Workers Scripts, R2, D1, and
  routes and DNS on the zones this deployment serves. Not an account-wide
  token, and not a session.
- The separation was never as strong as it looked. The half holding the
  credential has to be reachable from the half taking the requests, so an
  attacker with code execution in the API could always ask the provisioner to
  provision. Splitting narrowed the path; it did not close it.

## What we keep

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

`scripts/check-imports.ts` still refuses `src/sql-d1-http.ts` and
`src/objects-r2-http.ts` in the Worker graph. The Worker has D1 and R2
bindings; a credential-bearing HTTP transport is not a capability it needs, and
a capability nothing needs is one worth refusing.

`scripts/build-worker.ts` still refuses long-lived S3 key names in the bundle
and still requires the `STATE_DB` and `OBJECTS` bindings to be used. It no
longer refuses the Cloudflare REST origin or the name of a secret: naming a
secret is how a Worker reads one, and a gate that forbids the name only teaches
people to spell it differently.
