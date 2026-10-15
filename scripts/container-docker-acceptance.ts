import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { createDockerHttpRevisionRuntime } from "../src/providers/docker-http-revision.ts";
import { createSelfhostContainerBindingBroker } from "../src/providers/selfhost-container-binding-broker.ts";
import { makeContainerBinding } from "../src/providers/selfhost-container-binding-client.ts";
import { openSelfhostContainerBindingSocket } from "../src/providers/selfhost-container-binding-socket.ts";
import {
  createSelfhostContainerRuntime,
  type SelfhostContainerRevision,
} from "../src/providers/selfhost-container-runtime.ts";
import { prepareContainerWorkerd } from "../src/providers/selfhost-container-workerd.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BUN_ENV: "test" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} exited ${code}\n${stderr}`);
  return stdout.trim();
}

async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  milliseconds = 15_000,
): Promise<T> {
  const deadline = Date.now() + milliseconds;
  do {
    const result = await read();
    if (ready(result)) return result;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error("local Container state exceeded acceptance deadline");
}

const token = `container-lane-a-${randomUUID().replaceAll("-", "")}`;
const root = await mkdtemp(join(tmpdir(), "container-lane-a-"));
await chmod(root, 0o700);
const archive = join(root, "fixture.tar");
const oci = join(root, "oci");
await mkdir(oci);
const installation = token;
const network = token;
const socketPath = process.env.TAKOSERVER_ACCEPTANCE_DOCKER_SOCKET ?? "/var/run/docker.sock";
if (!socketPath.startsWith("/")) throw new TypeError("local Docker Unix socket required");
let networkId: string | undefined;
let runtime: Awaited<ReturnType<typeof createSelfhostContainerRuntime>> | undefined;
let registry: ReturnType<typeof Bun.serve> | undefined;
let workerd: ReturnType<typeof Bun.spawn> | undefined;
let bindingSocket: Awaited<ReturnType<typeof openSelfhostContainerBindingSocket>> | undefined;
let backend: ReturnType<typeof createDockerHttpRevisionRuntime> | undefined;
const revisions: SelfhostContainerRevision[] = [];
let failed: unknown;
const cleanupErrors: unknown[] = [];
try {
  await command([
    "docker",
    "--host",
    `unix://${socketPath}`,
    "buildx",
    "build",
    "--platform=linux/amd64",
    "--provenance=false",
    "--output",
    `type=oci,dest=${archive}`,
    join(import.meta.dir, "../tests/fixtures/container-http-native"),
  ]);
  await command(["tar", "-xf", archive, "-C", oci]);
  const index = JSON.parse(await readFile(join(oci, "index.json"), "utf8"));
  const descriptor = index.manifests[0];
  assert.equal(descriptor.mediaType, "application/vnd.oci.image.manifest.v1+json");
  const manifest = await readFile(join(oci, "blobs/sha256", descriptor.digest.slice(7)));
  assert.equal(`sha256:${createHash("sha256").update(manifest).digest("hex")}`, descriptor.digest);
  registry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v2/" || path === "/v2") return Response.json({});
      const digest = /^\/v2\/candidate\/(?:manifests|blobs)\/sha256:([a-f0-9]{64})$/u.exec(
        path,
      )?.[1];
      if (!digest) return new Response(null, { status: 404 });
      return new Response(Bun.file(join(oci, "blobs/sha256", digest)), {
        headers: {
          "content-type": path.includes("/manifests/")
            ? descriptor.mediaType
            : "application/octet-stream",
          "docker-content-digest": `sha256:${digest}`,
        },
      });
    },
  });
  const image = `localhost:${registry.port}/candidate@${descriptor.digest}`;
  networkId = await command([
    "docker",
    "--host",
    `unix://${socketPath}`,
    "network",
    "create",
    "--driver=bridge",
    "--internal",
    `--label=takoserver.installation=${installation}`,
    `--label=takoserver.acceptance=${token}`,
    network,
  ]);
  backend = createDockerHttpRevisionRuntime({
    socketPath,
    installationId: installation,
    network,
    maxMemoryBytes: 268_435_456,
    maxNanoCpus: 500_000_000,
    pidsLimit: 128,
    timeoutMs: 5000,
  });
  const options = { root: join(root, "journal"), backend, drainTimeoutMs: C.limits.retirementMs };
  runtime = await createSelfhostContainerRuntime(options);
  const identity = { resourceUid: token, incarnationId: installation };
  const first: SelfhostContainerRevision = {
    ...identity,
    generation: 1,
    revision: "1-v1",
    image,
    port: 8080,
    healthPath: "/health",
    memoryBytes: 268_435_456,
    nanoCpus: 500_000_000,
    environment: { FIXTURE_REVISION: "A" },
  };
  revisions.push(first);
  await eventually(
    () => runtime!.reconcile(first),
    (value) => value.state === "ready",
  );
  const firstNative = await backend.observe(first);
  assert.equal(firstNative.state, "ready");
  const claim = {
    principal: "acceptance",
    space: "isolated",
    workerVersionUid: "fixture-version",
    operationId: "fixture-operation",
    bindingName: "APP",
    targetUid: identity.resourceUid,
  };
  const brokerOptions = { claim, resolve: async () => identity, runtime };
  const binding = makeContainerBinding({
    fetch: createSelfhostContainerBindingBroker(brokerOptions),
  });
  const request = new Request("https://authority-is-ignored.example/echo?q=1", {
    method: "POST",
    headers: { authorization: "application" },
    body: "streamed input",
  });
  assert.deepEqual(await (await binding.fetch(request)).json(), {
    revision: "A",
    path: "/echo?q=1",
    method: "POST",
    authorization: "application",
    body: "streamed input",
  });
  assert.equal((await binding.fetch(new Request("https://ignored/redirect"))).status, 302);
  const applicationError = await binding.fetch(new Request("https://ignored/error"));
  assert.equal(applicationError.status, 503);
  assert.equal(await applicationError.text(), "application");
  assert.equal(
    await (await binding.fetch(new Request("https://ignored/egress"))).text(),
    "blocked",
  );
  const held = await binding.fetch(new Request("https://ignored/stream"));
  const reader = held.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "A");
  const second = {
    ...first,
    generation: 2,
    revision: "2-v1",
    environment: { FIXTURE_REVISION: "B", FIXTURE_HEALTHY: "false" },
  };
  revisions.push(second);
  const unhealthy = await runtime.reconcile(second);
  assert.equal(unhealthy.servingGeneration, 1);
  assert.equal(
    (
      (await (await binding.fetch(new Request("https://ignored/echo"))).json()) as {
        revision: string;
      }
    ).revision,
    "A",
  );
  // A new OS process reads the exact durable intent and incumbent, then exits.
  await runtime.close();
  const recovery = await command([
    process.execPath,
    "--no-env-file",
    join(import.meta.dir, "../tests/fixtures/container-http-native/recover.ts"),
    JSON.stringify({ root: options.root, socketPath, installation, network, identity }),
  ]);
  assert.deepEqual(JSON.parse(recovery), { servingGeneration: 1, revision: "A" });
  runtime = await createSelfhostContainerRuntime(options);
  const currentBinding = makeContainerBinding({
    fetch: createSelfhostContainerBindingBroker({ ...brokerOptions, runtime }),
  });
  const oldHeld = await currentBinding.fetch(new Request("https://ignored/stream"));
  const oldReader = oldHeld.body!.getReader();
  assert.equal(new TextDecoder().decode((await oldReader.read()).value), "A");
  const oldCancelled = oldReader.read().then(
    () => {
      throw new Error("retired stream unexpectedly completed");
    },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, C.errors.responseAborted);
    },
  );
  const candidate = await backend.observe(second);
  assert.equal(candidate.state, "starting");
  // Candidate endpoint is Host-private; make it healthy without routing app calls there.
  const inspected = JSON.parse(
    await command([
      "docker",
      "--host",
      `unix://${socketPath}`,
      "inspect",
      "--format",
      `{{json .NetworkSettings.Networks}}`,
      candidate.nativeId,
    ]),
  );
  const healthy = await fetch(`http://${inspected[network].IPAddress}:8080/healthy`, {
    redirect: "manual",
  });
  await healthy.body?.cancel();
  assert.equal(healthy.status, 204);
  await eventually(
    () => runtime!.reconcile(second),
    (value) => value.state === "ready" && value.servingGeneration === 2,
  );
  assert.equal(
    (
      (await (await currentBinding.fetch(new Request("https://ignored/echo"))).json()) as {
        revision: string;
      }
    ).revision,
    "B",
  );
  await eventually(
    () => backend!.observe(first),
    (value) => value.state === "absent",
    C.limits.retirementMs + 10_000,
  );
  await oldCancelled;
  // The same Host runtime can reach its owned bridge from a Dockerized Bun Host.
  await runtime.close();
  const dockerized = await command([
    "docker",
    "--host",
    `unix://${socketPath}`,
    "run",
    "--rm",
    "--name",
    `${token}-host-probe`,
    "--network",
    network,
    "--mount",
    `type=bind,source=${root},target=${root}`,
    "--mount",
    `type=bind,source=${process.cwd()},target=/app,readonly`,
    "--mount",
    `type=bind,source=${socketPath},target=${socketPath}`,
    "--entrypoint",
    "bun",
    "oven/bun:1.4.0@sha256:18639686662e5cd8a963ffb967dd130034a2a2d076a52e65dfd4fe18f75cc038",
    "--no-env-file",
    "/app/tests/fixtures/container-http-native/recover.ts",
    JSON.stringify({ root: options.root, socketPath, installation, network, identity }),
  ]);
  assert.deepEqual(JSON.parse(dockerized), { servingGeneration: 2, revision: "B" });
  runtime = await createSelfhostContainerRuntime(options);
  let workerdProven = false;
  if (process.env.TAKOSERVER_WORKERD_BINARY) {
    const selection = await selectClosedGraphWorkerd({
      binary: process.env.TAKOSERVER_WORKERD_BINARY,
      privateRoot: join(root, "selected-workerd"),
    });
    if (!selection.binary) throw new Error(selection.diagnostic ?? "pinned workerd unavailable");
    const directory = join(root, "s");
    await mkdir(directory, { mode: 0o700 });
    bindingSocket = await openSelfhostContainerBindingSocket({
      ...brokerOptions,
      runtime,
      directory,
    });
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const projected = await prepareContainerWorkerd({
      root: join(root, "workerd"),
      port,
      bindings: [{ name: "APP", socket: bindingSocket }],
      applicationSource:
        'export default { fetch(request, env) { return env.APP.fetch(new Request("https://ignored/echo?q=workerd", {headers:{authorization:"application"}})); } };',
    });
    workerd = Bun.spawn([selection.binary, "serve", projected.configPath], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const value = await eventually(
      async () => {
        try {
          return (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as { revision: string };
        } catch {
          return null;
        }
      },
      (value) => value?.revision === "B",
    );
    assert.equal(value?.revision, "B");
    workerdProven = true;
    workerd.kill();
    await workerd.exited;
    workerd = undefined;
    await bindingSocket.close();
    bindingSocket = undefined;
  }
  const deleted = await runtime.remove(identity);
  assert.equal(deleted.state, "deleted");
  assert.equal((await backend.observe(second)).state, "absent");
  console.info(
    JSON.stringify({
      kind: "container-docker-candidate-acceptance",
      imageDigest: descriptor.digest,
      engine: await command([
        "docker",
        "--host",
        `unix://${socketPath}`,
        "version",
        "--format",
        "{{.Server.Version}}",
      ]),
      cases: [
        "digest/platform",
        "health",
        "binding/authority/path/authorization",
        "redirect/application-error",
        "egress-denied",
        "unhealthy-update-keeps-incumbent",
        "OS-process-recovery",
        "healthy-cutover",
        "30s-retirement/stream-abort",
        "Dockerized-Host-private-bridge",
        "delete/absence",
      ],
      workerdProven,
      supported: C.supported,
    }),
  );
} catch (error) {
  failed = error;
} finally {
  if (workerd) {
    workerd.kill();
    await workerd.exited;
  }
  await bindingSocket?.close().catch((error: unknown) => cleanupErrors.push(error));
  await runtime?.close().catch((error: unknown) => cleanupErrors.push(error));
  if (backend)
    for (const revision of revisions)
      await backend.remove(revision).catch((error: unknown) => cleanupErrors.push(error));
  if (networkId) {
    try {
      const label = await command([
        "docker",
        "--host",
        `unix://${socketPath}`,
        "network",
        "inspect",
        "--format",
        '{{index .Labels "takoserver.acceptance"}}',
        networkId,
      ]);
      assert.equal(label, token);
      await command(["docker", "--host", `unix://${socketPath}`, "network", "rm", networkId]);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  registry?.stop(true);
  if (!failed && cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
}
if (failed || cleanupErrors.length)
  throw new AggregateError(
    [...(failed ? [failed] : []), ...cleanupErrors],
    `acceptance failed; private evidence retained at ${root}`,
  );
