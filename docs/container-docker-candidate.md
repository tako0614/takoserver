# Portable Container candidate on Docker/Linux

The unpublished portable vocabulary lives in `src/container-contract.ts`.
It selects the exact publisher candidate URL, Worker successor URL, binding,
fields, limits and payload-free errors. The legacy draft is not an alias.
No frozen Form definition is edited. This candidate remains `supported:false`
and is not added to the public application Form map.

`createContainerDockerForm` implements the v2 Resource adapter on the existing
Docker and durable serving coordinator. Its accepted UID and operator target
identify the private execution journal. Each accepted generation uses a
distinct native revision even when the author repeats a workload revision.
Validation rejects unknown keys, null, mutable images, invalid health paths,
reserved/non-POSIX env names, nonempty sensitive declarations, nonempty private
inputs and Internet egress before Docker effects. The v2 wire's existing strict
JSON parser refuses duplicate keys. Public observations are empty before
confirmation, then contain readiness, numeric serving generation and the
serving manifest digest. Output is empty.

The Docker adapter pulls the exact digest and checks the image descriptor,
single-manifest media type, Linux/amd64 platform and actual container image ID.
An image index or missing descriptor is refused. The Engine must implement the
existing v1.51 API and its descriptor readback. Health is GET with redirects
disabled and requires 2xx before cutover. An unhealthy successor retains its
incumbent. The coordinator cancels remaining incumbent I/O at its deadline,
then stops the pinned native ID immediately and verifies removal. Unknown
create/delete effects stay reconciling; a timeout is not absence.

The successor Worker parser leaves the frozen predecessor closed and adds UID
references through the existing v2 reference engine. It checks env collisions
and requires the exact target Form. Acceptance seals same-principal/Space
references and reserves them for pending as well as settled Versions; the
existing engine returns 409 while they protect a target from deletion.
`createContainerBindingAuthority` checks the accepted Version operation,
readiness, complete sealed reference set, current authorization, target Host
and active UID on every call. A broker socket is fixed to that claim. It cannot
resolve a request URL into another target or follow a deleted UID to a
replacement with the same name.

The Host-private workerd client presents only a frozen `fetch(Request)` object.
The generated qualification graph confines Host modules and denies implicit
outbound access. Its private Unix socket carries a streaming protocol that
preserves post-head error codes as stream failures. Application authorization,
status, redirects and separate Set-Cookie entries survive; transport and
Connection-nominated headers are removed. The native HTTP connection uses no
retry, redirect or decompression, and applies backpressure and cancellation.
The promise resolves at the response head. Limits apply to both body
directions, headers and path/query. The caller's URL authority is ignored.

## Operator network and packaging

Use one Docker Engine owned by this Host installation. Pre-create the network
with the installation identity expected by the standalone bootstrap:

```sh
docker network create --driver bridge --internal \
  --label takoserver.installation=local.primary takoserver-container-supply
```

The runtime verifies ownership, internal bridge isolation, non-ingress and
non-attachable state before pull/create/start. Workloads receive only this
network, no published ports, volumes, Docker socket or added capabilities.
Images retain their own entrypoint and CMD. Capacity and PID limits belong to
the Host profile. Internet egress remains disabled; `outboundInternet:true`
is rejected.

For the Dockerized Host, keep the existing private configuration/data volume
and explicitly add the socket capability and supply network:

```sh
export TAKOSERVER_CONTAINER_NETWORK=takoserver-container-supply
export TAKOSERVER_DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
docker compose -f compose.yaml -f compose.container.yaml up -d --no-build
```

The additional group grants the non-root Host access to the operator's socket.
The Host also joins its control network; workload containers join only the
internal supply network. A missing socket path is refused rather than created.
No socket or private target appears in tenant bindings. The artifact/control
image still does not contain workerd or the Workflow guard. Follow the complete
Worker installation in [self-host operations](self-host-operations.md) to
supply those reviewed native binaries; mounting a Docker socket alone does not
advertise the candidate.

Linux uses the same Bun Host and Docker Engine under the documented systemd
unit. Configure the two existing `TAKOSERVER_SELFHOST_CONTAINER_*` settings in
its private environment, grant the service account daemon access, and keep the
same durable data root and owned network. Recovery must start one Host owner
for that root. A daemon-free OCI runner is outside this backend.

## Local qualification

```sh
bun run test:container-docker
```

This builds the committed HTTP fixture as an OCI archive from a pinned Bun
Linux/amd64 manifest, serves a loopback-only read-only registry, and creates a
unique owned internal network. It exercises real pull/digest/platform checks,
health, authority-independent binding delivery, application authorization,
redirect/error preservation, denied egress, unhealthy update retention,
actual Bun process recovery, healthy cutover, 30s stream retirement,
Dockerized-Host bridge reachability and verified deletion. It removes only
its exact owned executions/network and prints no credentials or Host logs.
The immutable pulled fixture images remain in the daemon cache. Failures keep
private local evidence and report cleanup failures; there is no blind retry.

Supply `TAKOSERVER_WORKERD_BINARY` with the repository-pinned closed-graph
artifact to also execute `env.APP.fetch()` in real workerd through a private
broker socket. A configured wrong artifact fails rather than substituting npm
workerd. An absent binary is explicitly reported as unproven.

Full publisher conformance is still required before support: the production
WorkerVersion/Deployment successor composition and cross-version single-active
Deployment fence, full native stream/cancellation/error matrix, Linux service
restart/host reboot and multi-tenant isolation qualification, operator registry
authentication and retention policy. Sensitive delivery and enabled Internet
egress require a future contract and enforcement. The qualification graph is
an executable candidate seam, not a released Worker publication backend.
