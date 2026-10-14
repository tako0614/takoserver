import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// An explicit integration command, never part of portable tests. It uses only
// new, uniquely named local Docker resources and keeps credentials out of output.
const root = resolve(import.meta.dir, "..");
const bunVersion = (await Bun.file(join(root, ".bun-version")).text()).trim();
const runId = `takoserver-docker-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const image = `${runId}:smoke`;
const container = `${runId}-run`;
const project = `${runId}-compose`;
const volume = `${runId}-data`;
const origin = "https://docker-smoke.example.test";
const v2 = "/apis/forms.takoform.com/v2";
const artifactForm = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";
const workerForm = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
const temp = await mkdtemp(join(tmpdir(), "takoserver-docker-smoke-"));
const envFile = join(temp, "host.env");
const composeEnv = {
  ...process.env,
  TAKOSERVER_ENV_FILE: envFile,
  TAKOSERVER_DOCKER_IMAGE: image,
  TAKOSERVER_HTTP_PORT: "0",
};
const ownedContainers: string[] = [];

async function command(args: string[], env = process.env): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Commands such as exec and Compose may return credentials. No raw output
  // or invocation arguments are attached to errors from those commands.
  if (code !== 0) {
    if (args[0] === "build") process.stderr.write(stderr);
    throw new Error(
      `Docker ${args[0]} failed (exit ${code}); inspect this run's resources privately`,
    );
  }
  return stdout.trim();
}

function compose(...args: string[]): Promise<string> {
  return command(["compose", "-p", project, "-f", "compose.yaml", ...args], composeEnv);
}

async function address(id: string): Promise<string> {
  const ports = JSON.parse(
    await command([
      "inspect",
      "--format",
      '{{json (index .NetworkSettings.Ports "8787/tcp")}}',
      id,
    ]),
  ) as { HostIp: string; HostPort: string }[] | null;
  assert.ok(ports, "the fresh Host must stay running and publish its backend port");
  assert.equal(ports.length, 1, "exactly one backend port must be published");
  assert.equal(ports[0]?.HostIp, "127.0.0.1", "the backend must bind host loopback");
  return `http://127.0.0.1:${ports[0]?.HostPort}`;
}

async function ready(base: string, id: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await command(["inspect", "--format", "{{.State.Status}}", id]);
    if (state !== "running")
      throw new Error(`Fresh Docker Host stopped before readiness (${state})`);
    try {
      const response = await fetch(`${base}/_takoserver/health/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch {
      // The listener may not be bound yet.
    }
    await Bun.sleep(200);
  }
  throw new Error("Fresh Docker Host did not become ready within 60 seconds");
}

async function json(
  base: string,
  path: string,
  expected: number,
  token?: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      host: new URL(origin).host,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, expected, `${path} HTTP status`);
  return (await response.json()) as Record<string, unknown>;
}

function secret(value: unknown): string {
  assert.equal(typeof value, "string", "a credential must be present");
  assert.ok(value, "a credential must be nonempty");
  return value as string;
}

async function probe(id: string, restart: () => Promise<unknown>): Promise<void> {
  let base = await address(id);
  await ready(base, id);
  assert.equal(await command(["exec", id, "id", "-u"]), "1000");
  assert.equal(await command(["exec", id, "bun", "--version"]), bunVersion);
  await command(["exec", id, "test", "!", "-w", "/opt/takoserver/src/entry-bun.ts"]);
  assert.equal(await command(["exec", id, "stat", "-c", "%a", "/var/lib/takoserver"]), "700");
  await json(base, "/_takoserver/health/live", 200);
  await json(base, "/.well-known/takoform/v2", 200);
  await json(base, `${v2}/resources`, 401);
  const assertion = await command([
    "exec",
    "-e",
    "TAKOSERVER_OPERATOR_KEY=/var/lib/takoserver/operator-key.jwk",
    id,
    "bun",
    "--no-env-file",
    "scripts/operator-key.ts",
    "sign-in",
    "google",
    "operator",
    "operator@localhost",
    "Operator",
  ]);
  const session = secret(
    (
      await json(base, "/v1/sessions", 200, undefined, {
        provider: "google",
        method: "operator-assertion",
        assertion,
      })
    ).sessionToken,
  );
  const organization = (
    await json(base, "/v1/organizations", 201, session, {
      name: "Docker smoke organization",
    })
  ).organization as { id: string };
  assert.equal(typeof organization.id, "string");
  const key = secret(
    (
      await json(base, `/v1/organizations/${organization.id}/api-keys`, 201, session, {
        name: "Docker smoke reader",
        scopes: ["resources:read"],
        expiresInSeconds: 3600,
      })
    ).secret,
  );
  assert.equal(
    (await json(base, `${v2}/support?form=${encodeURIComponent(artifactForm)}`, 200, key))
      .supported,
    true,
  );
  assert.equal(
    (await json(base, `${v2}/support?form=${encodeURIComponent(workerForm)}`, 200, key)).supported,
    false,
  );
  const list = `${v2}/resources?space=${encodeURIComponent(organization.id)}`;
  await json(base, list, 200, key);
  await restart();
  // Docker may reassign an ephemeral published port when the container restarts.
  base = await address(id);
  await ready(base, id);
  // Existing organization and API-key state must survive a real container restart.
  await json(base, "/v1/me", 200, session);
  await json(base, list, 200, key);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const health = await command(["inspect", "--format", "{{.State.Health.Status}}", id]);
    if (health === "healthy") {
      console.log(
        `PASS ${id}: non-root, private data, loopback, health, discovery, authentication, v2 reads, restart`,
      );
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error("Docker HEALTHCHECK did not become healthy");
}

try {
  const config = {
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/authentication",
    workerBundle: { targetKey: "docker-smoke-artifacts", heldArtifacts: [] },
  };
  const cursorKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  await writeFile(
    envFile,
    `${[
      `TAKOSERVER_PUBLIC_ORIGIN=${origin}`,
      `TAKOSERVER_TAKOFORM_V2_CONFIG=${JSON.stringify(config)}`,
      `TAKOSERVER_TAKOFORM_V2_CURSOR_KEY=${cursorKey}`,
    ].join("\n")}\n`,
    { mode: 0o600 },
  );
  console.log(`Building ${image}; credentials and container logs remain private`);
  await command(["build", "-t", image, "."]);
  await command([
    "run",
    "--detach",
    "--init",
    "--name",
    container,
    "--label",
    `takoserver.docker-smoke=${runId}`,
    "--env-file",
    envFile,
    "--publish",
    "127.0.0.1::8787",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/takoserver`,
    image,
  ]);
  ownedContainers.push(container);
  await probe(container, () => command(["restart", "--time", "30", container]));
  await compose("up", "--detach", "--no-build", "--pull", "never");
  const composeId = await compose("ps", "--quiet", "takoserver");
  assert.ok(composeId, "Compose must start the Host");
  ownedContainers.push(composeId);
  await probe(composeId, () => compose("restart", "takoserver"));
  console.log(
    `PASS Docker run and Compose; retained image=${image} volume=${volume} project=${project}`,
  );
} finally {
  // Preserve images, containers, and data for inspection. Never prune or down -v.
  try {
    // A failed run/up may have created a container before returning nonzero.
    for (const label of [
      `takoserver.docker-smoke=${runId}`,
      `com.docker.compose.project=${project}`,
    ]) {
      const ids = await command(["ps", "--all", "--quiet", "--filter", `label=${label}`]);
      if (ids) ownedContainers.push(...ids.split("\n"));
    }
    for (const id of new Set(ownedContainers)) await command(["stop", "--time", "30", id]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
