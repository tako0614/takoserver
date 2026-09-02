# ADR 0009 — A self-host publishes the scheme its socket serves

**Status:** accepted, 2026-09-02

## Decision

The scheme of a `WorkerEndpoint` address is a fact about the runtime that
serves it, not a constant.

A self-hosted Takoserver terminates TLS **inside workerd**. When the operator
configures a certificate and a private key, the generated `workerd.capnp`
declares an `https` socket carrying that keypair in workerd's own `tlsOptions`,
and Worker endpoints are published as `https://<script>.<suffix>`. When no
certificate is configured, the socket stays plain HTTP and endpoints are
published as `http://<script>.<suffix>`.

The configuration is four environment variables, two of which are ever set:

| Variable | What it is |
|---|---|
| `TAKOSERVER_WORKERD_TLS_CERT_FILE` | Path to the leaf-first certificate chain, PEM. |
| `TAKOSERVER_WORKERD_TLS_KEY_FILE` | Path to the private key, PEM. |
| `TAKOSERVER_WORKERD_TLS_CERT` | The chain as PEM text, for a deployment with no file to point at. |
| `TAKOSERVER_WORKERD_TLS_KEY` | The key as PEM text. |

Both halves or neither. One half alone is a boot error rather than a silent
fall back to plain HTTP: an operator who believes they configured TLS must not
be handed `http://` addresses instead.

## Why

`canonicalWorkerEndpointOrigin` forced `https` while the generated
configuration ended `sockets = [ ( name = "http", address = "*:<port>",
http = (), service = "router" ) ]`. A self-host therefore advertised an
`https://` address its own runtime never served, and a real end-to-end run
recorded the consequence:

- `takoform_worker_endpoint.url` was
  `https://sw-….localhost/`, while the Worker's own
  `/.well-known/yurucommu` reported `http://sw-….localhost`. Every actor id,
  activity id, and collection the instance minted named the `http` origin.
- Nothing failed there only because `yurucommu-core` accepts plain HTTP across
  the whole `*.localhost` tree. On a suffix that is not loopback the same
  deployment would establish **no** public origin at all, and the Takoform
  module carries only `YURUCOMMU_RUNTIME_LANE` — there is no `APP_URL` for an
  operator to set.

Three repairs were possible: terminate TLS inside the runtime, let the endpoint
origin be `http` for loopback suffixes, or give `WorkerEndpoint` a way to
deliver its address to the Worker as a variable. The third changes the Binding
contract ([ADR 0005](0005-object-storage-is-an-exact-objectbucket-binding.md)
is not the only thing that would move) and the second leaves the non-loopback
case unfixed. This decision takes the first and keeps the second as the honest
answer where the first is not configured.

## Consequences

- The Host never advertises a scheme its runtime does not serve. A
  `WorkerEndpoint` create whose assigned origin uses the other scheme is
  refused before the provider mutates anything.
- `workerd` is the TLS terminator. There is no reverse proxy to add, and no
  second place a certificate has to be kept in step. The PEM text lives in the
  generated configuration, which was already written `0600` inside a `0700`
  directory because it carries every script's environment.
- This Host's own probes reach the socket by loopback address with certificate
  verification off. The certificate names the endpoint suffix, not `127.0.0.1`,
  so verifying it there would refuse every publication on a correctly
  configured machine; the connection never leaves the host, and a readiness
  answer is authenticated by the publication it names.
- A non-loopback suffix with no certificate is reported at boot, in a sentence
  that says what will not work: no origin can be established, so federated
  identity, signing, and self-addressing cannot work there.
- Nothing about the managed or ordinary-workers backends changes; they serve
  `https` and continue to say so.

## Non-goals

- Takoserver does not obtain, renew, or validate certificates. It serves the
  one it is given and says what it is serving.
- No SNI or per-hostname keypair selection. workerd's schema allows for one
  today, and a self-host serves one suffix.

## Amendment — 2026-09-02: the ledger that owns the address has to know both facts

The decision above changed the provider that *derives* a Worker endpoint
address and nothing that *accepts* one. `canonicalOrigin`,
`providerOutputOrigin` and `endpointOriginEquals` in
`src/worker-endpoint-origin-reservations.ts` each still required `https:`
independently, so a certificate-less self-host derived the `http://` address
its socket serves and its own reservation authority refused it: the mint
answered `unsupported_capability` 422 before anything was reserved, and the
default quickstart could create no `WorkerEndpoint` at all. The boot warning
said federated identity would not work there; the truth was that no request
ever reached the Worker to fail.

The scheme is therefore stated by the installation and held to by the ledger.
`ProviderWorkerEndpointOriginReservationCapability` gains
`publishedScheme`; absent means `https`, so the managed and ordinary-workers
lanes are unchanged and an installation that has not said it serves plain HTTP
cannot hand this Host an `http` address. Downstream, both the provider's `url`
output and an endpoint's drift check compare against the origin the reservation
already holds, so they read either web scheme and let that exact comparison be
the fence — pinning `https` there would only have moved the refusal one step
later.

**The port is the same fact, one dimension over.** `canonicalWorkerEndpointOrigin`
refused any port and the socket's port was never part of the address, so a
self-host on `28988` published a portless origin while every request that
reached the Worker carried `:28988`: the identity the Worker pinned and the
identity its Host advertised disagreed, exactly as the scheme once did. The
published address now carries the port, and `URL` normalizes the scheme's own
default away — so a deployment behind an ordinary 443 front end publishes what
it always published. The Bun entry takes the port from the workerd socket and
lets an operator who terminates elsewhere say so with
`TAKOSERVER_WORKER_ENDPOINT_PORT`. The router still matches on the name alone,
because a `Host` header's port is not part of the route.

## Amendment — 2026-09-02: publishing a `WorkerEndpoint` also needs an address the Form can carry

The decision above, and the amendment before this one, are about the address an
installation **serves**. They are unchanged and they remain true: the scheme
follows the socket, the port follows the socket, the Worker pins exactly what
its Host advertised, and a request that reaches the runtime carries that same
authority. What neither said is what a **published** `WorkerEndpoint` may look
like, and that is not this Host's decision to make.

`WorkerEndpoint@0.1.0` is a released Form. Its `outputSchema.url` is
`^https://<dotted-name>/$`, and its prose says the same thing in words: *"The
scheme is https and the path root is `/`… there is no plaintext address and no
port."* An address is portable output, and the Form is the authority on what
that output may be.

So the two facts were in conflict and the Host lost twice over. A
certificate-less self-host derived the `http://` address its socket serves and
could publish none. A TLS self-host on `28988` derived the ported `https://…:28988`
address its socket serves — the very repair the previous amendment made — and
could publish none either. In both cases the refusal arrived from
`projectReceipt`, after the driver had created the endpoint, after the
reservation had been activated and after the deletion attestation had been
opened, while the wire told the operator *"the host mutated nothing"*. Both are
recorded in the fourth self-host end-to-end run.

**A `WorkerEndpoint` is published only when the installation's address is
`https` on the default port.** The rule is decided at the reservation, which is
before anything is minted, assigned or mutated: `planned` refuses a derived
origin the Form cannot carry with a stable, non-retryable `unsupported_capability`
422 whose message names the two ways to fix it —

- terminate TLS in workerd on 443 (`TAKOSERVER_WORKERD_TLS_CERT_FILE`,
  `TAKOSERVER_WORKERD_TLS_KEY_FILE`, `TAKOSERVER_WORKERD_PORT=443`), which needs
  the capability to bind 443; or
- put an ordinary 443 front end in front of workerd and declare it with
  `TAKOSERVER_WORKER_ENDPOINT_PORT=443`, which normalizes the port away.

A deployment that does neither is not broken. It runs Workers, KV, SQL, queues,
cron and buckets, and it serves them on its own socket at the origin it honestly
publishes to the Worker. It simply mints no `WorkerEndpoint`, and it says so at
boot — as a diagnostic, not a boot failure. The loopback development default is
not an exception: `http://<script>.localhost` is exactly as unpublishable as any
other plain-HTTP address, and the sentence an operator reads is the same one.

`ProviderWorkerEndpointOriginReservationCapability.publishedScheme` stays, and
so does the port in the installation's derived origin. They are the fence that
stops an installation handing this Host an address in a scheme it never said it
serves, and they are what keeps the Worker's pinned identity and its Host's
advertised identity the same string. Publication is a second, narrower question
asked of the same address.

Two consequences worth stating.

- **The refusal is re-attempted, not replayed.** `unsupported_capability` is in
  `REATTEMPTED_SETTLED_FAILURE_CODES` ([ADR 0008](0008-a-settled-refusal-about-the-host-is-re-attempted.md)),
  which is exactly right here: the refusal is a statement about this Host, and
  the operator who reconfigures it re-runs the identical `tofu apply` under the
  identical plan-derived key.
- **A conforming Host and a conforming Form now agree before the mutation.**
  Whichever way this had been resolved, the Host and the Form had to be changed
  together, and the Form was not consulted. It is now, at the only moment where
  consulting it is free.
