import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";

const OPT_IN = process.env.TAKOSERVER_V2_ENTRY_NATIVE === "1";
const ORIGIN = "https://v2-service-entry.takoserver.test";
const HOST = "v2-service-entry.takoserver.test";
const SUFFIX = "workers.service-native.test";
const V2 = "/apis/forms.takoform.com/v2";
const TARGET = "selfhost-v2-worker-primary";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: string) => new TextEncoder().encode(value);
type Json = Record<string, unknown>;
type Child = ReturnType<typeof Bun.spawn>;

const callerCode = encode(`export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/identity") return new Response(null, { status: 404 });
    return env.TARGET.fetch("https://unrelated.invalid/identity", {
      headers: { "x-service-probe": "caller-owned" },
    });
  }
};`);
const targetCode = (version: string) =>
  encode(`const VERSION = ${JSON.stringify(version)};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/identity") return new Response(null, { status: 404 });
    return Response.json({
      version: VERSION,
      marker: env.MARKER,
      host: url.hostname,
      probe: request.headers.get("x-service-probe"),
      authorization: request.headers.get("authorization"),
      privateHeaders: [...request.headers.keys()].filter((name) =>
        name.startsWith("x-takoserver-") || name.startsWith("x-workerd-")),
    });
  }
};`);

async function unusedPort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = server.port;
    await server.stop(true);
    if (port !== undefined && !excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error("native entry port allocation unavailable");
}

async function requestAt(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
}

async function jsonAt(
  port: number,
  method: string,
  path: string,
  status: number,
  body?: Json,
  headers: Record<string, string> = {},
): Promise<Json> {
  const response = await requestAt(port, path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== status) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    throw new Error(
      `native entry Host request returned ${response.status}/${String(problem?.code ?? "unknown")}; expected ${status}`,
    );
  }
  return (await response.json()) as Json;
}

async function settled(port: number, token: string, operationId: string): Promise<Json> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const operation = await jsonAt(port, "GET", `${V2}/operations/${operationId}`, 200, undefined, {
      authorization: `Bearer ${token}`,
    });
    if (operation.status === "succeeded") return operation;
    if (operation.status === "failed") throw new Error("native entry Operation failed");
    await Bun.sleep(250);
  }
  throw new Error("native entry Operation settlement timed out");
}

async function stopHost(child: Child | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]))
    return;
  child.kill("SIGKILL");
  await child.exited;
  throw new Error("normal entry did not stop gracefully");
}

async function killHost(child: Child): Promise<void> {
  if (child.exitCode !== null) throw new Error("normal entry exited before SIGKILL");
  child.kill("SIGKILL");
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (!exited) throw new Error("normal entry survived SIGKILL");
}

async function startHost(
  root: string,
  port: number,
  config: string,
  extraEnv: Record<string, string> = {},
): Promise<Child> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      TMPDIR: root,
      CI: "1",
      NO_COLOR: "1",
      PORT: String(port),
      TAKOSERVER_DATA_ROOT: root,
      TAKOSERVER_DB: join(root, "control.sqlite"),
      TAKOSERVER_PUBLIC_ORIGIN: ORIGIN,
      TAKOSERVER_TAKOFORM_V2_CONFIG: config,
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: base64UrlEncode(new Uint8Array(32).fill(0x74)),
      ...extraEnv,
    },
  });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("normal entry exited during startup");
      try {
        const ready = await requestAt(port, "/_takoserver/health/ready");
        await ready.arrayBuffer();
        if (ready.status === 200) return child;
      } catch {
        // Listener not yet bound.
      }
      await Bun.sleep(100);
    }
    throw new Error("normal entry readiness timed out");
  } catch (error) {
    await stopHost(child);
    throw error;
  }
}

function nativeHttps(hostname: string): Promise<{ status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: hostname,
        path: "/identity",
        headers: { host: hostname },
        rejectUnauthorized: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.once("end", () => {
          try {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) as Json });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("native Service call timed out")));
    request.once("error", reject);
    request.end();
  });
}

test.skipIf(!OPT_IN)(
  "normal Bun entry restores Service Binding across Host SIGKILL and follows target-only update",
  async () => {
    const binary = process.env.TAKOSERVER_WORKERD_BINARY;
    const guard = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;
    if (!binary || !guard) throw new Error("pinned Workerd and Workflow guard are required");
    const root = await mkdtemp(join(tmpdir(), "v2-service-entry-"));
    let bootstrap: Child | null = null;
    let serving: Child | null = null;
    let cleanupFailed = false;
    try {
      const ports = new Set<number>([443]);
      const port = await unusedPort(ports);
      const workerdPort = await unusedPort(ports);
      const dataPlanePort = await unusedPort(ports);
      const privatePorts = await Promise.all(Array.from({ length: 5 }, () => unusedPort(ports)));
      const keyRoot = join(root, "keys");
      await mkdir(keyRoot, { recursive: true, mode: 0o700 });
      await mkdir(join(root, "staging"), { recursive: true, mode: 0o700 });
      const keyPaths = Object.fromEntries(
        ["sqlite", "kv", "objectBucket", "queue", "queueProducer"].map((name) => [
          name,
          join(keyRoot, `${name}.key`),
        ]),
      );
      for (const [index, name] of [
        "sqlite",
        "kv",
        "objectBucket",
        "queue",
        "queueProducer",
      ].entries()) {
        const path = keyPaths[name];
        if (!path) throw new Error("private plane key path unavailable");
        await writeFile(path, new Uint8Array(32).fill(0x31 + index), { mode: 0o600 });
      }
      const certificateFile = join(root, "cert.pem");
      const privateKeyFile = join(root, "tls.key");
      const openssl = Bun.spawn(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          privateKeyFile,
          "-out",
          certificateFile,
          "-days",
          "2",
          `-subj=/CN=*.${SUFFIX}`,
          "-addext",
          `subjectAltName=DNS:*.${SUFFIX}`,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      if ((await openssl.exited) !== 0) throw new Error("native Endpoint certificate unavailable");
      const privateBoot = JSON.stringify({
        sqlite: {
          privatePort: privatePorts[0],
          signingKeyFile: keyPaths.sqlite,
          stagingRoot: join(root, "staging"),
        },
        kv: { privatePort: privatePorts[1], signingKeyFile: keyPaths.kv },
        objectBucket: { privatePort: privatePorts[2], signingKeyFile: keyPaths.objectBucket },
        queue: { privatePort: privatePorts[3], signingKeyFile: keyPaths.queue },
        queueProducer: { privatePort: privatePorts[4], signingKeyFile: keyPaths.queueProducer },
      });
      const fullBoot = {
        TAKOSERVER_WORKERD_BINARY: binary,
        TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY: guard,
        TAKOSERVER_WORKERD_PORT: String(workerdPort),
        TAKOSERVER_DATA_PLANE_PORT: String(dataPlanePort),
        TAKOSERVER_V2_WORKER_RUNTIME_BOOT: JSON.stringify({
          actor: true,
          workflow: { maximumRegistrations: 64 },
        }),
        TAKOSERVER_V2_WORKER_PRIVATE_PLANES: privateBoot,
        TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS: "1",
        TAKOSERVER_WORKER_ENDPOINT_SUFFIX: SUFFIX,
        TAKOSERVER_WORKERD_TLS_CERT_FILE: certificateFile,
        TAKOSERVER_WORKERD_TLS_KEY_FILE: privateKeyFile,
        TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: JSON.stringify({
          current: {
            id: "service-entry-fixture",
            key: base64UrlEncode(new Uint8Array(32).fill(0x6f)),
          },
        }),
      };
      bootstrap = await startHost(
        root,
        port,
        JSON.stringify({
          documentation: "https://docs.example.test/v2",
          authenticationDocumentation: "https://docs.example.test/v2/authentication",
        }),
      );
      const assertion = await signOperatorAssertion({
        privateJwk: await readFile(join(root, "operator-key.jwk"), "utf8"),
        claims: {
          purpose: "sign-in",
          aud: ORIGIN,
          provider: "google",
          subject: "service-entry-owner",
          email: "service-entry-owner@localhost",
          displayName: "Service Entry Owner",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
      const session = await jsonAt(port, "POST", "/v1/sessions", 200, {
        provider: "google",
        method: "operator-assertion",
        assertion,
        sessionTtlSeconds: 60,
      });
      const organization = await jsonAt(
        port,
        "POST",
        "/v1/organizations",
        201,
        { name: "Native Service entry owner" },
        { authorization: `Bearer ${String(session.sessionToken)}` },
      );
      const space = String((organization.organization as Json).id);
      const key = await jsonAt(
        port,
        "POST",
        `/v1/organizations/${space}/api-keys`,
        201,
        { name: "Service entry writer", scopes: ["resources:write"], expiresInSeconds: 3600 },
        { authorization: `Bearer ${String(session.sessionToken)}` },
      );
      const token = String(key.secret);
      const auth = { authorization: `Bearer ${token}` };
      await stopHost(bootstrap);
      bootstrap = null;

      const objects = createFileObjectStore({ root });
      const heldArtifacts: Json[] = [];
      const addBundle = async (name: string, bytes: Uint8Array) => {
        const manifestUrl = `https://artifacts.example.test/service-entry/${name}/manifest.json`;
        const moduleUrl = `https://artifacts.example.test/service-entry/${name}/index.mjs`;
        const manifest = encode(
          JSON.stringify({
            entrypoint: "index.mjs",
            files: [
              {
                path: "index.mjs",
                url: moduleUrl,
                sha256: digest(bytes),
                mediaType: "application/javascript+module",
              },
            ],
          }),
        );
        const manifestKey = `service-entry/${name}/manifest`;
        const moduleKey = `service-entry/${name}/module`;
        expect(
          await objects.create(manifestKey, manifest, { contentType: "application/json" }),
        ).not.toBeNull();
        expect(
          await objects.create(moduleKey, bytes, { contentType: "application/javascript+module" }),
        ).not.toBeNull();
        heldArtifacts.push(
          {
            url: manifestUrl,
            sha256: digest(manifest),
            objectKey: manifestKey,
            grants: [{ principal: `org:${space}`, space }],
          },
          {
            url: moduleUrl,
            sha256: digest(bytes),
            objectKey: moduleKey,
            grants: [{ principal: `org:${space}`, space }],
          },
        );
        return { artifact: { url: manifestUrl, sha256: digest(manifest) } };
      };
      const callerBundleSpec = await addBundle("caller", callerCode);
      const targetOneBundleSpec = await addBundle("target-one", targetCode("one"));
      const targetTwoBundleSpec = await addBundle("target-two", targetCode("two"));
      const config = JSON.stringify({
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: { targetKey: TARGET, heldArtifacts },
        staticAssetBundle: { targetKey: TARGET, heldArtifacts: [] },
      });
      serving = await startHost(root, port, config, fullBoot);
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(WORKER_VERSION_FORM_URL)}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({ supported: true });
      const create = async (form: string, name: string, spec: Json) => {
        const body = { form, name, space, spec };
        const accepted = await jsonAt(port, "POST", `${V2}/resources`, 202, body, {
          ...auth,
          "idempotency-key": `service-entry-create-${name}`,
        });
        expect(await settled(port, token, String(accepted.id))).toMatchObject({
          effect: "complete",
        });
        return { uid: String(accepted.resourceUid), id: String(accepted.id), body };
      };
      const remove = async (uid: string, generation: number, name: string) => {
        const accepted = await jsonAt(port, "DELETE", `${V2}/resources/${uid}`, 202, undefined, {
          ...auth,
          "idempotency-key": `service-entry-delete-${name}`,
          "takoform-expected-generation": String(generation),
        });
        expect(await settled(port, token, String(accepted.id))).toMatchObject({
          effect: "complete",
        });
      };
      const target = await create(MODULE_WORKER_FORM_URL, "target", {});
      const caller = await create(MODULE_WORKER_FORM_URL, "caller", {});
      const targetBundleOne = await create(
        WORKER_BUNDLE_FORM_URL,
        "target-bundle-one",
        targetOneBundleSpec,
      );
      const targetBundleTwo = await create(
        WORKER_BUNDLE_FORM_URL,
        "target-bundle-two",
        targetTwoBundleSpec,
      );
      const callerBundle = await create(WORKER_BUNDLE_FORM_URL, "caller-bundle", callerBundleSpec);
      const targetVersionOne = await create(WORKER_VERSION_FORM_URL, "target-version-one", {
        worker: { resourceUid: target.uid },
        bundle: { resourceUid: targetBundleOne.uid },
        handlers: ["fetch"],
        vars: { MARKER: "target-one-marker" },
      });
      const targetDeploymentSpec = (versionUid: string) => ({
        worker: { resourceUid: target.uid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const targetDeployment = await create(
        WORKER_DEPLOYMENT_FORM_URL,
        "target-deployment",
        targetDeploymentSpec(targetVersionOne.uid),
      );
      const callerVersion = await create(WORKER_VERSION_FORM_URL, "caller-version", {
        worker: { resourceUid: caller.uid },
        bundle: { resourceUid: callerBundle.uid },
        handlers: ["fetch"],
        serviceBindings: [{ name: "TARGET", resource: { resourceUid: target.uid } }],
      });
      const callerDeployment = await create(WORKER_DEPLOYMENT_FORM_URL, "caller-deployment", {
        worker: { resourceUid: caller.uid },
        versions: [{ workerVersion: { resourceUid: callerVersion.uid }, weight: 10_000 }],
      });
      const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "caller-endpoint", {
        worker: { resourceUid: caller.uid },
      });
      const endpointRead = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${endpoint.uid}`,
        200,
        undefined,
        auth,
      );
      const hostname = String((endpointRead.output as Json).hostname);
      const expected = (version: string) => ({
        version,
        marker: `target-${version}-marker`,
        host: "unrelated.invalid",
        probe: "caller-owned",
        authorization: null,
        privateHeaders: [],
      });
      expect(await nativeHttps(hostname)).toEqual({ status: 200, body: expected("one") });
      const callerBefore = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${callerDeployment.uid}`,
        200,
        undefined,
        auth,
      );

      const firstPid = serving.pid;
      await killHost(serving);
      serving = null;
      serving = await startHost(root, port, config, fullBoot);
      expect(serving.pid).not.toBe(firstPid);
      expect(await nativeHttps(hostname)).toEqual({ status: 200, body: expected("one") });
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${callerDeployment.uid}`, 200, undefined, auth),
      ).toEqual(callerBefore);
      const targetVersionTwo = await create(WORKER_VERSION_FORM_URL, "target-version-two", {
        worker: { resourceUid: target.uid },
        bundle: { resourceUid: targetBundleTwo.uid },
        handlers: ["fetch"],
        vars: { MARKER: "target-two-marker" },
      });
      const update = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${targetDeployment.uid}`,
        202,
        { spec: targetDeploymentSpec(targetVersionTwo.uid) },
        {
          ...auth,
          "idempotency-key": "service-entry-target-only-update",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, token, String(update.id))).toMatchObject({ effect: "complete" });
      expect(await nativeHttps(hostname)).toEqual({ status: 200, body: expected("two") });
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${callerDeployment.uid}`, 200, undefined, auth),
      ).toEqual(callerBefore);

      await remove(endpoint.uid, 1, "caller-endpoint");
      await remove(callerDeployment.uid, 1, "caller-deployment");
      await remove(callerVersion.uid, 1, "caller-version");
      await remove(targetDeployment.uid, 2, "target-deployment");
      await remove(targetVersionTwo.uid, 1, "target-version-two");
      await remove(targetVersionOne.uid, 1, "target-version-one");
      await remove(callerBundle.uid, 1, "caller-bundle");
      await remove(targetBundleTwo.uid, 1, "target-bundle-two");
      await remove(targetBundleOne.uid, 1, "target-bundle-one");
      await remove(caller.uid, 1, "caller");
      await remove(target.uid, 1, "target");
      const gone = await requestAt(port, `${V2}/resources/${endpoint.uid}`, { headers: auth });
      expect(gone.status).toBe(410);
      await gone.arrayBuffer();
    } finally {
      const stops = await Promise.allSettled([stopHost(serving), stopHost(bootstrap)]);
      cleanupFailed = stops.some((result) => result.status === "rejected");
      if (!cleanupFailed) await rm(root, { recursive: true, force: true });
    }
    if (cleanupFailed) throw new Error("native Service entry child cleanup failed");
  },
  240_000,
);
