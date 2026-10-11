# Self-host security: trust boundaries and hardening

This page states what a Bun self-host protects, what it does not, and how an
operator should run it. It describes the current source entrypoint
(`src/entry-bun.ts`). Installation steps are in
[Self-host operations](self-host-operations.md).

## Who is trusted

- **The operator** owns the machine, the data root, the operator key and
  every credential in the Host's environment. The operator is fully trusted.
- **Organization API keys and sessions** act only on their own organization.
  The Host checks this on every request.
- **Tenant code**, meaning published Workers and their modules, is untrusted.
  It runs inside workerd children that the Host starts.
- **The network** is untrusted. Only the reverse proxy and the listeners
  described below should face it.

## What the workerd sandbox protects

Tenant Workers run in V8 isolates in a pinned workerd build. This build adds a
closed module graph ([workerd/README.md](../workerd/README.md)). Within that
sandbox:

- A tenant module can import only the modules of its own Worker. It cannot
  import the Host-private modules that the Host adds to the same process.
- A Worker reaches Host services only through the bindings its Version
  declared. The KV, SQL, object and queue planes check a token that names one
  Worker Version. A name that the Version did not declare is refused, so a
  Worker cannot reach another tenant's data by guessing an id.
- The data planes and the v2 private planes listen only on `127.0.0.1`, and
  the v2 private planes check signed requests. Actor, Workflow and broker
  sockets are Unix sockets in directories owned by the Host's user.
- The Actor and Workflow runtimes, the Host's owner Workers, the private
  plane services and the module inspector deny all outbound network access.
  Ordinary published Workers do not set an outbound service, so they use
  workerd's default `internet` service. It allows public addresses only, so
  `fetch()` cannot reach loopback or private ranges, but it can reach the
  public internet.

## What it does not protect

The sandbox is the only isolation layer between tenants and the Host. If it
fails, nothing else is in the way.

- **Every workerd child runs as the Host's user.** Takoserver does not switch
  users, create namespaces, apply seccomp filters or set cgroup limits for it.
  A V8 or workerd escape gets everything that user can reach:
  - the whole data root: the control database with every organization's
    records, customer databases and objects, the operator key, signing keys
    and TLS private keys;
  - the Host's environment, which most workerd children inherit, and any
    secret in it (for example `STRIPE_SECRET_KEY`, AI upstream tokens, a
    Cloudflare token);
  - every loopback service on the machine, and the Docker socket if the
    container runtime is configured. Access to the Docker socket is equivalent
    to root on the machine.
- **Tenants are separated by isolates only.** Two tenants on one Host share a
  user and a kernel, and ordinary published Workers share one workerd
  process. Do not host mutually hostile tenants on one machine and rely on
  that separation alone.
- **Takoserver sets no CPU, memory or disk quota per tenant** on these
  processes. A Worker can use resources that its neighbours need.
- **Egress is not restricted.** Tenant Workers can reach the public internet.
  If they must not, block egress for the Host's user with the firewall.

## Network exposure

| Listener | Bound to | Speaks | Who should reach it |
|---|---|---|---|
| API and console API (`PORT`, default 8787) | `TAKOSERVER_LISTEN_HOST`, default `127.0.0.1` | plain HTTP | the TLS reverse proxy only |
| Published Workers (`TAKOSERVER_WORKERD_PORT`, default 8788) | all interfaces | HTTP, or HTTPS with `TAKOSERVER_WORKERD_TLS_*` | the public, through TLS |
| v2 Worker endpoint / Container endpoint HTTPS (443, when enabled) | all interfaces | HTTPS | the public |
| Data planes and v2 private planes | `127.0.0.1` | HTTP with per-Version tokens | workerd children on this machine |
| Actor, Workflow and broker sockets | Unix sockets under the data root and `/tmp/tw-<hash>` | HTTP | the Host's own processes |

The API listener defaults to loopback on purpose. `TAKOSERVER_PUBLIC_ORIGIN`
must be HTTPS but the Bun listener speaks plain HTTP, so every real deployment
already has a TLS-terminating proxy in front. Listening on every interface
would only add a second, unencrypted way in that skips the proxy. Set
`TAKOSERVER_LISTEN_HOST` when the proxy runs on another machine or in another
network namespace, for example `0.0.0.0` or `::`, and then firewall the port so
that only the proxy can reach it. The value must be one canonical IP literal;
a hostname, a port or brackets are refused at startup. The startup line
`takoserver listening on … (address: …)` shows the address that was bound.
This default was chosen for the v2 line: before it, the listener bound every
interface.

## Sign-in and request limits

- When no identity provider is configured, the operator signs in with an
  Ed25519 assertion. The Host prints one at startup only until the operator
  account exists, that is, until the first successful sign-in. Set
  `TAKOSERVER_PRINT_OPERATOR_ASSERTION=1` to print one on every boot. Mint
  later ones with `bun scripts/operator-key.ts sign-in google operator
  operator@localhost Operator`, with `TAKOSERVER_OPERATOR_KEY` and
  `TAKOSERVER_PUBLIC_ORIGIN` set for this installation.
- A sign-in assertion opens one session. The session exchange records it and
  refuses it if it is presented again before it expires (ten minutes for the
  printed one). An assertion that leaks through logs after it was used opens
  nothing. One that leaks before it was used is still a credential until it is
  used or expires, so keep startup output out of shared logs.
- The Host does not rate-limit requests. Guessing does not work against its
  credentials: sessions and API keys are random bearer secrets, and operator
  assertions need the operator's private key. Request floods and slow clients
  are the reverse proxy's job. Configure request limits there, at least for
  `POST /v1/sessions`, `POST /v1/operator-owner-proof` and uploads, and keep a
  request size limit that still allows site uploads. Per-client limits in the
  Host would see only the proxy's address, so they would be one global limit
  that anybody could use to lock the operator out.

## Recommended OS hardening

1. **Use a dedicated user** with no login shell, no sudo and no other
   services. That user should own the data root (mode 0700) and nothing else
   of value. Keep credentials of unrelated systems off the machine.
2. **Run it under systemd with hardening options.** The unit below is a
   starting point. The repository's tests do not run it, so check it against
   your own configuration before relying on it:

   ```ini
   [Service]
   User=takoserver
   Group=takoserver
   WorkingDirectory=/opt/takoserver
   ExecStart=/usr/local/bin/bun src/entry-bun.ts
   EnvironmentFile=/etc/takoserver/env
   UMask=0077
   NoNewPrivileges=yes
   PrivateTmp=yes
   PrivateDevices=yes
   ProtectSystem=strict
   ProtectHome=yes
   ReadWritePaths=/var/lib/takoserver
   ProtectKernelTunables=yes
   ProtectKernelModules=yes
   ProtectKernelLogs=yes
   ProtectControlGroups=yes
   ProtectClock=yes
   ProtectHostname=yes
   RestrictNamespaces=yes
   RestrictRealtime=yes
   RestrictSUIDSGID=yes
   LockPersonality=yes
   SystemCallArchitectures=native
   RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
   CapabilityBoundingSet=
   AmbientCapabilities=
   ```

   `PrivateTmp=yes` also keeps the v2 socket directories in `/tmp/tw-<hash>`
   away from other users, and removes them when the service stops. Do not add
   `MemoryDenyWriteExecute=yes`: V8 needs writable and executable memory for
   its JIT. To serve Workers on 443 without root, grant only
   `AmbientCapabilities=CAP_NET_BIND_SERVICE` and
   `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`. You can also keep the ports
   above 1024 and let the proxy listen on 443. If you configure the container
   runtime, the Docker socket must be reachable, and that undoes most of this
   isolation. Use it only on a machine whose operator accepts that.
3. **Set file permissions.** Keep the data root at mode 0700, owned by the
   Host's user. Every directory above it should be owned by root or that user
   and not be writable by others. With the v2 Actor or Workflow runtime
   enabled, the Host refuses to start otherwise (see
   [Self-host operations](self-host-operations.md)). Keep the environment file
   (`EnvironmentFile`) at mode 0600 and owned by root. Keep backups of the data
   root as private as the data root itself: they contain the operator key and
   the signing keys.
4. **Limit network exposure.** Expose only the reverse proxy and the Worker
   listeners. Firewall the API port if `TAKOSERVER_LISTEN_HOST` is not
   loopback. Do not expose the data-plane ports. Block egress for the Host's
   user if tenants must not reach the internet.
5. **Terminate TLS in a reverse proxy** for `TAKOSERVER_PUBLIC_ORIGIN`, for
   example Caddy or nginx proxying to `127.0.0.1:8787`. Set timeouts that
   allow long uploads (the Host's idle timeout is 120 seconds), and add the
   request limits described above. Worker endpoints either terminate TLS in
   workerd (`TAKOSERVER_WORKERD_TLS_*`) or sit behind the same proxy with
   `TAKOSERVER_WORKER_ENDPOINT_PORT` set to the published port; keep the
   original `Host` header for that traffic, because Workers are selected by
   hostname.
6. **Keep startup output private.** Before the first sign-in it contains a
   credential. Restrict who can read the service's journal or container logs.

## Reporting

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
