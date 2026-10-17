# Docker and Compose self-host

This runs the Host's API, operator sign-in, organizations and API keys in one
container on `127.0.0.1:8787`, with its SQLite state in a Docker volume. It also
serves the artifact Forms that keep Worker code, static files and SQL
migrations. It runs no Workers: the image has no workerd or Workflow execution
guard. For those, follow
[First install and first use](self-host-operations.md#first-install-and-first-use);
a Docker installation does not later become one that runs Workers, and a native
install starts with its own data root.

You need git, Docker Engine with Compose 2.30 or later (`docker compose
version`; the Compose file uses raw env-file values), python3, curl and jq. Get
the source, check out a reviewed commit of `main` (the Docker files are newer
than the v2.0.0-rc.1 release, which has none), and run every command below from
that directory:

```sh
git clone https://github.com/tako0614/takoserver
cd takoserver
COMMIT=$(git rev-parse origin/main)   # the commit to review and run
git checkout --detach "$COMMIT"
```

## Configure and start

Build the image:

```sh
docker build -t takoserver-selfhost:local .
```

The base image pins Bun 1.4.0, matching `.bun-version`, by its registry digest,
and dependencies come from the frozen lockfile. Only the source, its committed
pricing configuration, the vendored Takoform v2.1.1 reference files, the
lockfile and package manifest, the license and the operator and artifact CLIs
enter the build context; local credentials and data stay out. The image runs as
UID/GID 1000 and keeps its data root at mode 0700.

Keep the three required settings in a private file outside the checkout. This
Python example creates a new file without overwriting an existing cursor key.
For a local look the example origin works as it is; for real use, replace it and
the documentation URLs with your own, and use your host in the `Host` headers
below:

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
printf 'TAKOSERVER_ENV_FILE=%s\n' "$TAKOSERVER_ENV_FILE" > .env
docker compose up -d --no-build
```

Every `docker compose` command reads `TAKOSERVER_ENV_FILE`. The `.env` file in
the checkout, which git and the image build both ignore, keeps it set for
`docker compose` in new shells; the shell variable itself is not, so the
commands below that need the path spell it out.

The image listens on `0.0.0.0:8787` inside the container. Compose publishes
only `127.0.0.1:8787` on the host; `TAKOSERVER_HTTP_PORT` changes that host port.
For real use, place an operator-controlled HTTPS proxy in front of it for the
configured public origin. In Docker nothing holds TCP 443 for Workers, so the
proxy may use it. With Caddy on this machine, for the example origin:

```caddyfile
api.example.com {
  @probes path /_takoserver/*
  respond @probes 404
  reverse_proxy 127.0.0.1:8787
}
```

The site address must match `TAKOSERVER_PUBLIC_ORIGIN`, port included: the Host
compares the whole host, so the native guide's `api.example.com:8443` in front
of this origin gets `421` on every v2 request. The matcher keeps the
operational probes off the public origin, as in
[control API ingress](self-host-operations.md#4-https-and-tcp-443). A proxy on the
same host can reach the loopback port. A proxy in another container needs an
explicit private network connecting it to this service. Do not publish the
plaintext backend on a public interface.

Compose keeps `/var/lib/takoserver` (SQLite, the operator and signing keys and
stored artifacts) in a volume named `<project>_takoserver-data`, where
`<project>` is the checkout directory's name: `takoserver_takoserver-data` for a
clone named `takoserver`. Run every `docker compose` command from that directory,
or pass the same `-p <project>`; from another directory Compose starts a new,
empty installation. Keep the env file and its cursor key stable across restarts
and updates. Do not set `TAKOSERVER_DB` or `TAKOSERVER_DATA_ROOT` outside that
mount. A bind mount is also possible if its short absolute path and ancestry
satisfy the operations guide, and its data directory is owned by UID/GID 1000
with mode 0700. Run only one Host per data volume.

To use Docker directly instead of Compose, choose a fresh dedicated name and
volume. The rest of this guide uses Compose; with `docker run`, use
`docker exec takoserver-selfhost` where it says `docker compose exec takoserver`,
and adapt the stop, volume and backup commands of the update steps the same way.

```sh
docker run -d --init --stop-timeout 30 --restart unless-stopped --name takoserver-selfhost \
  --env-file ~/.config/takoserver/docker.env \
  -p 127.0.0.1:8787:8787 \
  --mount type=volume,source=takoserver-selfhost-data,target=/var/lib/takoserver \
  takoserver-selfhost:local
```

## Health and first use

Wait until `docker compose ps` shows the service as `healthy` (the first start
can take up to 30 seconds), then check it:

```sh
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:8787/_takoserver/health/live
curl --fail --silent --show-error http://127.0.0.1:8787/_takoserver/health/ready
curl --fail --silent --show-error -H 'Host: api.example.com' \
  http://127.0.0.1:8787/.well-known/takoform/v2
```

The health check uses the read-only readiness probe; a healthy API does not
prove public HTTPS or application readiness. See
[Monitoring](self-host-operations.md#monitoring). Host API v2 requests must carry
the configured public origin's host in the `Host` header; on the loopback port
without it, v2 answers 421.

Then sign in, create an organization and a read-only API key, and ask the Host
which Forms it serves. The first boot created the operator key, so you can mint
a single-use sign-in assertion with it at once (the first boot also writes one
to the container logs, which you do not need). These requests use the loopback
port with the public origin's host as the `Host` header, as
`bun run test:selfhost-docker` does; for real use, send them through your HTTPS
origin.

```sh
B=http://127.0.0.1:8787
H='Host: api.example.com'   # the host of TAKOSERVER_PUBLIC_ORIGIN
ASSERTION=$(docker compose exec -T \
    -e TAKOSERVER_OPERATOR_KEY=/var/lib/takoserver/operator-key.jwk takoserver \
    bun --no-env-file scripts/operator-key.ts sign-in google operator operator@localhost Operator)
SESSION=$(jq -n --arg assertion "$ASSERTION" \
    '{provider: "google", method: "operator-assertion", $assertion}' |
  curl -sS --fail-with-body -H "$H" -H 'content-type: application/json' \
    --data @- "$B/v1/sessions" | jq -r .sessionToken)
ORG=$(curl -sS --fail-with-body -H "$H" -H "authorization: Bearer $SESSION" \
    -H 'content-type: application/json' --data '{"name":"My organization"}' \
    "$B/v1/organizations" | jq -r .organization.id)
KEY=$(curl -sS --fail-with-body -H "$H" -H "authorization: Bearer $SESSION" \
    -H 'content-type: application/json' \
    --data '{"name":"look around","scopes":["resources:read"],"expiresInSeconds":86400}' \
    "$B/v1/organizations/$ORG/api-keys" | jq -r .secret)
for form in WorkerBundle/0.2.0 ModuleWorker/0.3.0; do
  curl -sS --fail-with-body -G -H "$H" -H "authorization: Bearer $KEY" \
    --data-urlencode "form=https://edge.forms.takoform.com/forms/$form/" \
    "$B/apis/forms.takoform.com/v2/support" | jq -c '{form, supported}'
done
```

`WorkerBundle` reports `supported: true` and `ModuleWorker` `false`: this image
keeps artifacts and runs no Workers. Keep the assertion, session and key out of
shared logs and shell history, and treat the container logs as credentials. Do
not dump `docker inspect` or `docker compose config`: the container environment
holds the cursor key.

To keep an artifact, publish it over public HTTPS and create it by the URL and
SHA-256 of its manifest; the Host fetches it itself. The manifest's shape and
the URLs the Host fetches are in step 10's
[Publish them over public HTTPS](self-host-operations.md#10-ship-a-new-version).
A create needs a key with `resources:write`. In the same shell, with your own
manifest URL:

```sh
MANIFEST=https://artifacts.example.com/hello/v1/manifest.json
WKEY=$(curl -sS --fail-with-body -H "$H" -H "authorization: Bearer $SESSION" \
    -H 'content-type: application/json' \
    --data '{"name":"writer","scopes":["resources:write"],"expiresInSeconds":86400}' \
    "$B/v1/organizations/$ORG/api-keys" | jq -er .secret) &&
curl -sS --fail -o "$HOME/manifest.json" "$MANIFEST" &&
SHA=$(sha256sum < "$HOME/manifest.json" | cut -d' ' -f1) &&
OPERATION=$(jq -n --arg org "$ORG" --arg url "$MANIFEST" --arg sha "$SHA" \
    '{form: "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/", space: $org,
      name: "hello-bundle-v1", spec: {artifact: {$url, sha256: $sha}}}' |
  curl -sS --fail-with-body -H "$H" -H "authorization: Bearer $WKEY" \
    -H 'content-type: application/json' -H 'idempotency-key: takoserver-docker-hello-bundle-v1' \
    --data @- "$B/apis/forms.takoform.com/v2/resources" | jq -er .id) &&
curl -sS --fail-with-body -H "$H" -H "authorization: Bearer $WKEY" \
  "$B/apis/forms.takoform.com/v2/operations/$OPERATION" | jq -c '{status, error}'
```

The chain stops at the first step that fails, so a manifest that could not be
fetched is never sent with the digest of nothing; a create that was sent and
failed uses up its name. Ask for the Operation again until its `status` is
`succeeded` or `failed`.
Seeding held artifacts from local files
([step 6](self-host-operations.md#6-seed-held-artifacts)) needs the Host
stopped, and in this image the Host is the container's main process, so it is
not covered for Docker yet.

This image serves no console page. The console is static files built from the
checkout with Bun on this machine; see
[the console](self-host-operations.md#the-console-optional), which also needs
the API behind HTTPS on the same site. Its `TAKOSERVER_CONSOLE_ORIGIN` goes in
the env file, and a changed env file takes effect with
`docker compose up -d --no-build`; `docker compose restart` keeps the old
environment.

## Stop, update, and verify

`docker compose stop` sends the Host a graceful shutdown signal, with 30
seconds before Docker's deadline. It keeps the container and the data volume.
Never use `docker compose down -v` or Docker pruning on an installation you
keep.

To update, in the same checkout directory:

1. Stop the Host, copy the stopped volume and the env file into a private
   directory, and tag the image the Host was running so it stays available.
   Startup can apply forward SQLite migrations, so these copies are the way
   back:

   ```sh
   install -d -m 0700 ~/takoserver-backups
   STAMP=$(date -u +%Y%m%dT%H%M%SZ)
   docker compose stop
   ( umask 077
     docker compose run --rm --no-deps -T --entrypoint tar takoserver \
       -C /var/lib/takoserver -cpf - . > ~/takoserver-backups/takoserver-data-$STAMP.tar
     cp ~/.config/takoserver/docker.env ~/takoserver-backups/takoserver-env-$STAMP )
   docker tag "$(docker inspect -f '{{.Image}}' "$(docker compose ps -aq takoserver)")" \
     takoserver-selfhost:before-$STAMP
   ```

   `docker compose run` mounts this project's own volume, so the copy cannot
   come from the wrong one. The copies hold the operator and signing keys and
   the cursor key; keep them private. Without the tag, rebuilding moves
   `takoserver-selfhost:local` and Docker pruning may delete the old image.
2. Check out the new reviewed commit of `main`, rebuild and start it:

   ```sh
   git fetch origin
   COMMIT=$(git rev-parse origin/main)   # the commit to review and run
   git checkout --detach "$COMMIT"
   docker build -t takoserver-selfhost:local .
   docker compose up -d --no-build
   ```

   If an earlier rollback added a `TAKOSERVER_DOCKER_IMAGE` line to `.env`,
   delete that line before `up`, or it starts the old image again; keep
   `COMPOSE_PROJECT_NAME`.
3. Rerun the health, discovery and support checks above.

Going back means restoring the copy into a fresh volume and starting
`takoserver-selfhost:before-<stamp>` with it (`compose.yaml` takes its image from
`TAKOSERVER_DOCKER_IMAGE`), not reverting only the image. If the env file changed
after the copy, first put `~/takoserver-backups/takoserver-env-<stamp>` back in
its place. With this Host stopped, a new project name gives a fresh volume:

```sh
docker compose stop
STAMP=20261017T091500Z   # the stamp in the copy's file names
printf 'COMPOSE_PROJECT_NAME=takoserver-restore\nTAKOSERVER_DOCKER_IMAGE=takoserver-selfhost:before-%s\n' \
  "$STAMP" >> .env
docker compose run --rm --no-deps -T --entrypoint tar takoserver \
  -C /var/lib/takoserver -xpf - < ~/takoserver-backups/takoserver-data-$STAMP.tar
docker compose up -d --no-build
```

The two lines added to `.env` keep every later `docker compose` command, in any
shell, on the restored project and the old image. A command without them would
act on the original project instead, or, without the image line, start the
newer image on the restored volume, whose migrations would undo the rollback.
Remove them to return to the original project.

Maintainers, and anyone with Bun installed, can run the explicit local
regression check from the checkout:

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

## Related

The opt-in private Docker supply wiring and unpublished portable Container
qualification are documented in [Container Docker candidate](container-docker-candidate.md).
