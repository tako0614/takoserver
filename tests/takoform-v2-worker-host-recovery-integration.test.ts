import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";

const API = "/apis/forms.takoform.com/v2";
const MANIFEST_URL = "https://artifacts.example.test/host-recovery/manifest.json";
const FILE_URL = "https://artifacts.example.test/host-recovery/index.html";
const MANIFEST_KEY = "host-recovery/manifest";
const FILE_KEY = "host-recovery/index.html";
type Json = Record<string, unknown>;
type FixtureEvent = { stage: string; port?: number; error?: string };

async function startHost(
  root: string,
  workerUid: string | null,
  binary: string,
  manifestSha256: string,
  fileSha256: string,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/takoform-v2-worker-host-recovery-server.ts"),
      root,
      binary,
      workerUid ?? "-",
      manifestSha256,
      fileSha256,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
  const events: FixtureEvent[] = [];
  const reader = child.stdout.getReader();
  let buffer = "";
  let readError: unknown;
  const reading = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        events.push(JSON.parse(buffer.slice(0, end)) as FixtureEvent);
        buffer = buffer.slice(end + 1);
      }
    }
  })().catch((error: unknown) => {
    readError = error;
  });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await errors;
    reader.releaseLock();
  }
  async function event(stage: string): Promise<FixtureEvent> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const found = events.find((value) => value.stage === stage);
      if (found) return found;
      const fixtureError = events.find((value) => value.stage === "startup_error");
      if (fixtureError) throw new Error(`fixture failed: ${fixtureError.error ?? "unknown error"}`);
      if (readError) throw new Error(`fixture output failed before ${stage}`);
      if (child.exitCode !== null)
        throw new Error(`fixture exited before ${stage}: ${await errors}`);
      await Bun.sleep(10);
    }
    throw new Error(`fixture did not emit ${stage}`);
  }
  try {
    const listening = await event("listening");
    if (!listening.port) throw new Error("fixture omitted port");
    return {
      child,
      close,
      event,
      origin: `http://127.0.0.1:${listening.port}`,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function request(
  origin: string,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  generation?: number,
) {
  return await fetch(`${origin}${API}${path}`, {
    method,
    headers: {
      authorization: "Bearer test-only",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
      ...(generation === undefined ? {} : { "takoform-expected-generation": String(generation) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function waitForOperation(origin: string, operationId: string) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const response = await request(origin, `/operations/${operationId}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as Json;
    if (operation.status === "succeeded" || operation.status === "failed") return operation;
    await Bun.sleep(10);
  }
  throw new Error("Host Operation did not settle");
}

async function createResource(
  origin: string,
  form: string,
  name: string,
  spec: Json,
  key = `create-${name}-host-recovery`,
) {
  const response = await request(
    origin,
    "/resources",
    "POST",
    { form, space: "production", name, spec },
    key,
  );
  if (response.status !== 202) {
    throw new Error(`Resource create failed with ${response.status}: ${await response.text()}`);
  }
  const operation = (await response.json()) as { id: string; resourceUid: string };
  expect(await waitForOperation(origin, operation.id)).toMatchObject({
    status: "succeeded",
    effect: "complete",
  });
  return operation;
}

async function resourceByName(origin: string, name: string) {
  const response = await request(
    origin,
    `/resources?space=production&name=${encodeURIComponent(name)}`,
  );
  expect(response.status).toBe(200);
  const page = (await response.json()) as { items: { uid: string; lastOperation: string }[] };
  return page.items[0] ?? null;
}

async function waitForResourceOperation(origin: string, name: string) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const resource = await resourceByName(origin, name);
    if (resource) {
      const operation = await waitForOperation(origin, resource.lastOperation);
      if (operation.status === "succeeded") return { resource, operation };
      if (operation.status === "failed") throw new Error("Host Resource operation failed");
    }
    await Bun.sleep(10);
  }
  throw new Error("Host Resource operation did not settle");
}

test("real Host restart restores SQL-proven Worker serving from custody and preserves exact replay", async () => {
  // The Bun child is a test-only workerd stand-in. This covers real Host HTTP,
  // SQL 0077 publication recovery, held-byte custody, and OS-process restart;
  // it does not qualify native workerd, TLS, DNS, or a deployed frontend.
  const root = await mkdtemp(join(tmpdir(), "v2-worker-host-recovery-"));
  const binary = join(root, "bun-workerd-stand-in.js");
  const fileBytes = new TextEncoder().encode("<main>held-across-host-restart</main>");
  const fileSha256 = (await bytesDigest(fileBytes)).slice("sha256:".length);
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      files: [
        {
          path: "index.html",
          url: FILE_URL,
          sha256: fileSha256,
          mediaType: "text/html",
        },
      ],
    }),
  );
  const manifestSha256 = (await bytesDigest(manifestBytes)).slice("sha256:".length);
  const assetSpec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
  const deploymentCreateKey = "host-recovery-deployment-create-exact-key";
  let deploymentSpec: Json = {};
  let first: Awaited<ReturnType<typeof startHost>> | undefined;
  let second: Awaited<ReturnType<typeof startHost>> | undefined;

  try {
    const childSource = `
import { readFileSync } from "node:fs";
const [verb, watch, configPath] = process.argv.slice(-3);
if (verb !== "serve" || watch !== "--watch" || !configPath) throw new Error("unexpected command");
function identity() {
  const config = readFileSync(configPath, "utf8");
  const port = /address = "\\*:(\\d+)"/u.exec(config)?.[1];
  const generation = /\\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  const token = /\\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\\)/u.exec(config)?.[1];
  if (!port || !generation || !token) throw new Error("invalid rendered config");
  return { port: Number(port), generation, token };
}
const server = Bun.serve({ hostname: "127.0.0.1", port: identity().port, fetch(request) {
  const current = identity();
  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("host") === "runtime.selfhost-config.invalid" &&
      url.pathname === "/.well-known/takoserver/selfhost-runtime-config/v1" &&
      request.headers.get("x-takoserver-selfhost-runtime-config") === current.token) {
    return new Response(null, { status: 204, headers: { "x-takoserver-selfhost-config-identity": current.generation } });
  }
  return new Response(JSON.stringify({ generation: current.generation, path: url.pathname, method: request.method }),
    { headers: { "content-type": "application/json" } });
} });
process.on("SIGTERM", () => server.stop(true));
`;
    await writeFile(binary, `#!${process.execPath}\n${childSource}`, { mode: 0o700 });
    await chmod(binary, 0o700);

    const objects = createFileObjectStore({ root: join(root, "objects") });
    await objects.put(MANIFEST_KEY, manifestBytes);
    await objects.put(FILE_KEY, fileBytes);

    first = await startHost(root, null, binary, manifestSha256, fileSha256);
    const worker = await createResource(
      first.origin,
      MODULE_WORKER_FORM_URL,
      "recovery-worker",
      {},
    );
    const assets = await createResource(
      first.origin,
      STATIC_ASSET_BUNDLE_FORM_URL,
      "recovery-assets",
      assetSpec,
    );
    const versionSpec: Json = {
      worker: { resourceUid: worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: assets.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    };
    const version = await createResource(
      first.origin,
      WORKER_VERSION_FORM_URL,
      "recovery-version",
      versionSpec,
    );
    deploymentSpec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    };

    // Simulate a lost acceptance response, then independently wait for the
    // public Resource/Operation read model to prove that this exact request
    // settled before killing the Host process.
    const droppedResponse = await request(
      first.origin,
      "/resources",
      "POST",
      {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "production",
        name: "recovery-deployment",
        spec: deploymentSpec,
      },
      deploymentCreateKey,
    );
    expect(droppedResponse.status).toBe(202);
    await droppedResponse.body?.cancel();
    const firstDeployment = await waitForResourceOperation(first.origin, "recovery-deployment");
    expect(firstDeployment.operation).toMatchObject({ status: "succeeded", effect: "complete" });
    expect(firstDeployment.resource.uid).toBeTruthy();
    const sourceOperationId = firstDeployment.resource.lastOperation;

    const firstServingResponse = await fetch(
      `${first.origin}/__fixture/serve/${worker.resourceUid}`,
    );
    expect(firstServingResponse.status).toBe(200);
    const firstServing = (await firstServingResponse.json()) as {
      body: string;
      sourceOperationId: string;
    };
    expect(firstServing.sourceOperationId).toBe(sourceOperationId);
    expect(JSON.parse(firstServing.body)).toMatchObject({ path: "/index.html" });
    const firstStatusResponse = await fetch(
      `${first.origin}/__fixture/status/${worker.resourceUid}`,
    );
    expect(firstStatusResponse.status).toBe(200);
    const firstStatus = (await firstStatusResponse.json()) as {
      childPids: number[];
      serving: { kind: string; sourceOperationId: string };
    };
    expect(firstStatus.serving).toMatchObject({
      kind: "serving",
      sourceOperationId,
    });
    expect(firstStatus.childPids).toHaveLength(1);
    const firstChildPid = firstStatus.childPids[0];

    const firstHostPid = first.child.pid;
    await first.close();
    first = undefined;
    expect(await objects.delete(MANIFEST_KEY)).toBe(true);
    expect(await objects.delete(FILE_KEY)).toBe(true);
    expect(await objects.get(MANIFEST_KEY)).toBeNull();
    expect(await objects.get(FILE_KEY)).toBeNull();

    second = await startHost(root, worker.resourceUid, binary, manifestSha256, fileSha256);
    expect(second.child.pid).not.toBe(firstHostPid);
    const recovered = await waitForResourceOperation(second.origin, "recovery-deployment");
    expect(recovered.resource.uid).toBe(firstDeployment.resource.uid);
    expect(recovered.resource.lastOperation).toBe(sourceOperationId);
    expect(recovered.operation).toMatchObject({ id: sourceOperationId, status: "succeeded" });

    const replay = await request(
      second.origin,
      "/resources",
      "POST",
      {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "production",
        name: "recovery-deployment",
        spec: deploymentSpec,
      },
      deploymentCreateKey,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: sourceOperationId,
      resourceUid: firstDeployment.resource.uid,
    });

    const deploymentGet = await request(
      second.origin,
      `/resources/${firstDeployment.resource.uid}`,
    );
    expect(deploymentGet.status).toBe(200);
    expect(await deploymentGet.json()).toMatchObject({
      uid: firstDeployment.resource.uid,
      observedGeneration: 1,
      phase: "idle",
    });
    const recoveredAssetsResponse = await request(
      second.origin,
      `/resources/${assets.resourceUid}`,
    );
    expect(recoveredAssetsResponse.status).toBe(200);
    expect(await recoveredAssetsResponse.json()).toMatchObject({
      uid: assets.resourceUid,
      observed: {
        manifestSha256,
        fileCount: 1,
        totalBytes: fileBytes.byteLength,
      },
    });

    const endpoint = await createResource(
      second.origin,
      WORKER_ENDPOINT_FORM_URL,
      "recovery-endpoint",
      {
        worker: { resourceUid: worker.resourceUid },
      },
    );
    await waitForOperation(second.origin, endpoint.id);
    const endpointResourceResponse = await request(
      second.origin,
      `/resources/${endpoint.resourceUid}`,
    );
    expect(endpointResourceResponse.status).toBe(200);
    const endpointResource = (await endpointResourceResponse.json()) as {
      output: { hostname: string; url: string };
      observed: Json;
    };
    expect(endpointResource.observed).toMatchObject({
      tlsReady: true,
      activeDeploymentRouteReady: true,
    });
    const servingAfterEndpoint = await fetch(
      `${second.origin}/__fixture/serve/${worker.resourceUid}`,
    );
    expect(servingAfterEndpoint.status).toBe(200);
    const beforeUpdate = (await servingAfterEndpoint.json()) as {
      body: string;
      sourceOperationId: string;
    };
    expect(JSON.parse(beforeUpdate.body)).toMatchObject({ path: "/index.html" });

    const deploymentUpdate = await request(
      second.origin,
      `/resources/${firstDeployment.resource.uid}`,
      "PUT",
      { spec: deploymentSpec },
      "host-recovery-deployment-update-key",
      1,
    );
    expect(deploymentUpdate.status).toBe(202);
    const updateOperation = (await deploymentUpdate.json()) as { id: string };
    expect(await waitForOperation(second.origin, updateOperation.id)).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    const servingAfterUpdate = await fetch(
      `${second.origin}/__fixture/serve/${worker.resourceUid}`,
    );
    const afterUpdate = (await servingAfterUpdate.json()) as {
      body: string;
      sourceOperationId: string;
    };
    expect(JSON.parse(afterUpdate.body)).toMatchObject({ path: "/index.html" });
    expect(afterUpdate.sourceOperationId).not.toBe(beforeUpdate.sourceOperationId);

    const endpointDelete = await request(
      second.origin,
      `/resources/${endpoint.resourceUid}`,
      "DELETE",
      undefined,
      "host-recovery-endpoint-delete-key",
      1,
    );
    expect(endpointDelete.status).toBe(202);
    const endpointDeleteOperation = (await endpointDelete.json()) as { id: string };
    expect(await waitForOperation(second.origin, endpointDeleteOperation.id)).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    const endpointReplay = await request(
      second.origin,
      `/resources/${endpoint.resourceUid}`,
      "DELETE",
      undefined,
      "host-recovery-endpoint-delete-key",
      1,
    );
    expect(endpointReplay.status).toBe(200);
    expect(await endpointReplay.json()).toMatchObject({ id: endpointDeleteOperation.id });
    expect((await request(second.origin, `/resources/${endpoint.resourceUid}`)).status).toBe(410);

    const status = await fetch(`${second.origin}/__fixture/status/${worker.resourceUid}`);
    expect(status.status).toBe(200);
    const recoveredServing = (await status.json()) as {
      pid: number;
      childPids: number[];
      serving: { kind: string; hostnames: string[]; sourceOperationId: string };
      routeAbsenceReads: {
        endpointUid: string;
        workerUid: string;
        hostname: string;
        url: string;
      }[];
    };
    expect(recoveredServing.pid).toBe(second.child.pid);
    expect(recoveredServing.childPids.length).toBe(1);
    expect(recoveredServing.childPids[0]).not.toBe(firstChildPid);
    expect(recoveredServing.serving).toMatchObject({
      kind: "serving",
      hostnames: [],
      sourceOperationId: endpointDeleteOperation.id,
    });
    expect(recoveredServing.routeAbsenceReads.at(-1)).toEqual({
      endpointUid: endpoint.resourceUid,
      workerUid: worker.resourceUid,
      hostname: endpointResource.output.hostname,
      url: endpointResource.output.url,
    });

    const deploymentDelete = await request(
      second.origin,
      `/resources/${firstDeployment.resource.uid}`,
      "DELETE",
      undefined,
      "host-recovery-deployment-delete-key",
      2,
    );
    expect(deploymentDelete.status).toBe(202);
    const deploymentDeleteOperation = (await deploymentDelete.json()) as { id: string };
    expect(await waitForOperation(second.origin, deploymentDeleteOperation.id)).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    const deploymentDeleteReplay = await request(
      second.origin,
      `/resources/${firstDeployment.resource.uid}`,
      "DELETE",
      undefined,
      "host-recovery-deployment-delete-key",
      2,
    );
    expect(deploymentDeleteReplay.status).toBe(200);
    expect(await deploymentDeleteReplay.json()).toMatchObject({
      id: deploymentDeleteOperation.id,
      resourceUid: firstDeployment.resource.uid,
    });
    expect(
      (await request(second.origin, `/resources/${firstDeployment.resource.uid}`)).status,
    ).toBe(410);

    const versionDelete = await request(
      second.origin,
      `/resources/${version.resourceUid}`,
      "DELETE",
      undefined,
      "host-recovery-version-delete-key",
      1,
    );
    expect(versionDelete.status).toBe(202);
    const versionDeleteOperation = (await versionDelete.json()) as { id: string };
    expect(await waitForOperation(second.origin, versionDeleteOperation.id)).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });

    const assetDelete = await request(
      second.origin,
      `/resources/${assets.resourceUid}`,
      "DELETE",
      undefined,
      "host-recovery-assets-delete-key",
      1,
    );
    expect(assetDelete.status).toBe(202);
    const assetDeleteOperation = (await assetDelete.json()) as { id: string };
    expect(await waitForOperation(second.origin, assetDeleteOperation.id)).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });

    const workerDelete = await request(
      second.origin,
      `/resources/${worker.resourceUid}`,
      "DELETE",
      undefined,
      "host-recovery-worker-delete-key",
      1,
    );
    expect(workerDelete.status).toBe(202);
    const workerDeleteOperation = (await workerDelete.json()) as { id: string };
    expect(await waitForOperation(second.origin, workerDeleteOperation.id)).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    expect((await request(second.origin, `/resources/${worker.resourceUid}`)).status).toBe(410);
  } finally {
    await first?.close();
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
});
