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
