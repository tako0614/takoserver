# Docker and Compose self-host

The opt-in private Docker supply wiring and unpublished portable Container
qualification are documented in [Container Docker candidate](container-docker-candidate.md).

This target packages the Bun artifact/control API profile described in
[self-host operations](self-host-operations.md#first-install-and-first-use).
It starts the v2 Host API, operator sign-in, organizations, and API keys with
local SQLite state. Configured artifact Forms retain bytes. The image does not
include the pinned closed-graph workerd or the Workflow execution guard, so it
does not advertise Worker execution or Worker endpoints. Follow the complete
local Worker profile in that guide if you need those capabilities.

Use a reviewed source commit, Docker Engine, and Docker Compose 2.30 or later
(the Compose file uses raw env-file values). The base image pins Bun 1.4.0,
matching `.bun-version`, and its registry digest. Dependencies come from the
frozen lockfile. Only source, its committed pricing configuration and frozen
provider reference corpus, the lockfile/package manifest, the license, and
the operator/artifact CLIs enter the build context; local credentials and data
are excluded. The image runs as UID/GID 1000 and keeps its data root mode 0700.

## Configure and start

Build from the reviewed checkout:

```sh
docker build -t takoserver-selfhost:local .
```

Keep all three required settings in a private file outside the checkout. This
Python example creates a new file without overwriting an existing cursor key;
replace the example HTTPS origin and documentation URLs before running it:

```sh
export TAKOSERVER_ENV_FILE="$HOME/.config/takoserver/docker.env"
install -d -m 0700 "$(dirname "$TAKOSERVER_ENV_FILE")"
python3 - "$TAKOSERVER_ENV_FILE" <<'PY'
import json, os, secrets, sys
config = {
    "documentation": "https://docs.example.com/resources",
    "authenticationDocumentation": "https://docs.example.com/access",
    "sqliteMigrationSet": {"targetKey": "selfhost-artifacts", "heldArtifacts": []},
    "workerBundle": {"targetKey": "selfhost-artifacts", "heldArtifacts": []},
    "staticAssetBundle": {"targetKey": "selfhost-artifacts", "heldArtifacts": []},
}
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as out:
    out.write("TAKOSERVER_PUBLIC_ORIGIN=https://api.example.com\n")
    out.write("TAKOSERVER_TAKOFORM_V2_CONFIG=" + json.dumps(config, separators=(",", ":")) + "\n")
    out.write("TAKOSERVER_TAKOFORM_V2_CURSOR_KEY=" + secrets.token_urlsafe(32) + "\n")
PY
docker compose up -d --no-build
```

The image listens on `0.0.0.0:8787` inside the container. Compose publishes
only `127.0.0.1:8787` on the host; `TAKOSERVER_HTTP_PORT` changes that host port.
Place an operator-controlled HTTPS proxy in front of it using the configured
public origin, as described in
[control API ingress](self-host-operations.md#4-https-and-tcp-443). A proxy on the
same host can reach the loopback port. A proxy in another container needs an
explicit private network connecting it to this service. Do not publish the
plaintext backend on a public interface.

The named `takoserver-data` volume persists `/var/lib/takoserver`, including
SQLite, operator/signing keys, and stored artifacts. Keep the env file and its
cursor key stable across restarts and updates. Do not set `TAKOSERVER_DB` or
`TAKOSERVER_DATA_ROOT` outside that mount. A bind mount is also possible if its
short absolute path and ancestry satisfy the operations guide, and its data
directory is owned by UID/GID 1000 with mode 0700. Run only one Host per data
volume.

To use Docker directly instead of Compose, choose a fresh dedicated name and
volume:

```sh
docker run -d --init --name takoserver-selfhost \
  --env-file "$TAKOSERVER_ENV_FILE" \
  -p 127.0.0.1:8787:8787 \
  --mount type=volume,source=takoserver-selfhost-data,target=/var/lib/takoserver \
  takoserver-selfhost:local
```

## Health and first use

```sh
curl --fail --silent --show-error http://127.0.0.1:8787/_takoserver/health/live
curl --fail --silent --show-error http://127.0.0.1:8787/_takoserver/health/ready
curl --fail --silent --show-error -H 'Host: api.example.com' \
  http://127.0.0.1:8787/.well-known/takoform/v2
docker compose ps
```

The Docker health check uses the read-only readiness probe. A healthy control
API does not prove Worker execution, public HTTPS, or application readiness.
See [health and readiness](self-host-operations.md#9-verify).
Discovery and product API requests must carry the configured public-origin
Host header; a direct request using the loopback Host is refused with 421.

On first boot without an identity provider, the Host writes a single-use
operator assertion to container logs. Treat those logs as credentials and
inspect them only in a private operator session. Later, mint an assertion with
the bundled CLI and this installation's operator key:

```sh
docker compose exec -T \
  -e TAKOSERVER_OPERATOR_KEY=/var/lib/takoserver/operator-key.jwk \
  takoserver bun --no-env-file scripts/operator-key.ts \
  sign-in google operator operator@localhost Operator
```

This command prints a credential. Use it in the session exchange, organization,
and API-key steps of
[first boot and operator sign-in](self-host-operations.md#5-first-boot-and-operator-sign-in),
through your external HTTPS origin. Keep assertions and API keys out of shared
logs and shell history. Do not dump `docker inspect` or `docker compose config`:
the container environment contains the cursor key. There is no `/console` page
in this image; use a separately configured console or the documented API steps.

The artifact CLI is included too. Stop the service before seeding held bytes,
then run `bun --no-env-file scripts/selfhost-artifact.ts` in a one-off container
with the same volume and private configuration. Follow the operations guide's
stopped-Host proof and artifact/configuration procedure; the image's working
directory is `/opt/takoserver`.

## Stop, update, and verify

`docker compose stop` sends the Host a graceful shutdown signal, with 30
seconds before Docker's deadline. It preserves the container and data volume.
Before updating, follow the operations guide's cold backup procedure for the
whole stopped data volume and external env file. Retain the previous image ID
and record the new source commit and `docker image inspect --format '{{.Id}}'
result. Startup can apply forward SQLite migrations: reverting only the image
is not a safe rollback after a schema change. Restore the matching cold backup
and its configuration as described in
[update and recovery](self-host-operations.md#update-and-code-rollback). Never use `down -v` or
Docker pruning against an installation you intend to keep.

Run the explicit local regression check from the checkout with Bun installed:

```sh
bun run test:selfhost-docker
```

It builds a uniquely tagged image, starts Docker-run and Compose Hosts with
fresh named volumes and random local credentials, checks non-root execution,
mode 0700, loopback publication, health, discovery, rejection without a key,
operator sign-in, organization/API-key creation, Form support and authenticated
v2 reads, then restarts both Hosts and confirms identity/state persistence.
It prints no credentials or container logs. The check stops its own containers
and retains them, their volumes, and its image for inspection; it does not
remove or touch existing resources. The canonical quality workflow runs this
check separately from the portable `bun run check` gate.
